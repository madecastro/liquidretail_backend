#!/usr/bin/env node
/**
 * verifyQuoteRotation — offline harness for LANE Q2:
 *   1. PRODUCT_REVIEWS_MAX_QUOTES default 10 → 30 (storage cap only)
 *   2. QUOTE_ROTATION_MEMORY (default false) skips last-N fingerprints
 *   3. VIDEO_QUOTE_ROTATION (default false) ports the SAME helper to video
 *   4. Same-run latch is STRUCTURAL: siblings replay lastQuoteFingerprint
 *      (never re-hash a different-length pool)
 *   5. Persist is atomic (first-writer-wins + $push/$slice) and cannot
 *      fail a billed render
 *
 * No DB, no network, no API key. Never edits quote text. No LLM.
 *
 * THE DEFECT: hash(campaignRunId) % pool.length collides ~1/N on consecutive
 * runs. Two calls with the same seed pick the same quote while unseen
 * candidates exist. Memory skip is what closes that hole.
 *
 * THE LATCH DEFECT (fix-round): skipping recentKeys only when !sameRun
 * made the first size hash the unseen slice and a sibling hash the full
 * pool. Empirically 139/200 run-ids disagreed once any prior memory
 * existed. Replay of lastQuoteFingerprint cannot diverge.
 *
 * REVERT-PROVEN — each mutation confirmed to FAIL, then restored:
 *   - restore || 10 as the storage-cap fallback     → A1 / H1
 *   - drop memory skip (hash-only even when flag on) → C2 / H2
 *   - wrap that reprints the previous run's quote    → C3 / H3
 *   - inverted latch (re-hash full pool on same-run) → C4 / C4b / H7
 *   - default VIDEO_QUOTE_ROTATION on (=== !== false)→ E0 / H4
 *   - drop recentQuoteKeys from the schema           → G1 / H5
 *   - snapshot $set persist (no run-id filter)       → G2 / H8
 *   - drop secondary_quotes artifact cap             → A7 / H9
 *
 * Run: node scripts/verifyQuoteRotation.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC_SCRAPE = path.join(ROOT, 'services/productReviewsScrapeService.js');
const SRC_ROT    = path.join(ROOT, 'services/quoteRotationService.js');
const SRC_STATIC = path.join(ROOT, 'services/directImageRenderService.js');
const SRC_VIDEO  = path.join(ROOT, 'services/brandScriptExecutor.js');
const SRC_CAT    = path.join(ROOT, 'models/CatalogProduct.js');
const SRC_HELP   = path.join(ROOT, 'services/reviewAdapters/helpers.js');
const SRC_ADAPT  = path.join(ROOT, 'services/reviewAdapters/index.js');
const SRC_LAYOUT = path.join(ROOT, 'services/layoutInputService.js');

let pass = 0, fail = 0;
const failures = [];
function check(label, fn) {
  try { fn(); pass++; }
  catch (e) {
    fail++;
    failures.push(`${label} — ${String(e.message).split('\n')[0].slice(0, 280)}`);
    console.log(`   • ${label} — ${String(e.message).split('\n')[0].slice(0, 220)}`);
  }
}

function read(p) { return fs.readFileSync(p, 'utf8'); }

function withEnv(pairs, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(pairs)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return fn(); }
  finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function withTempMutation(filePath, find, replace, runCheck) {
  const original = fs.readFileSync(filePath, 'utf8');
  assert.ok(original.includes(find), `mutate target not found: ${find.slice(0, 80)}`);
  const mutated = original.replace(find, replace);
  // Mutate a PRIVATE temp copy, never the real shared repo file. This helper
  // is called against services/productReviewsScrapeService.js,
  // services/quoteRotationService.js, models/CatalogProduct.js, and
  // services/layoutInputService.js — all required elsewhere in this suite
  // (models/CatalogProduct.js by a large fraction of it) — and a SIGTERM/
  // SIGKILL mid-mutation (runner timeout, CI abort, Ctrl-C) skips any
  // pending `finally`, which would otherwise leave one of those real files
  // corrupted on disk. See verifyVideoCostReconcile.js's withTempMutation
  // for the full rationale; same pattern as verifyRatingPairAtomic.js /
  // verifySeedClass.js.
  const tmp = path.join(
    os.tmpdir(),
    `verifyQuoteRotation-${path.basename(filePath)}-${process.pid}-${Date.now()}.js`
  );
  fs.writeFileSync(tmp, mutated);
  try {
    runCheck(fs.readFileSync(tmp, 'utf8'));
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* leave for OS tmp cleanup */ }
  }
  assert.strictEqual(
    fs.readFileSync(filePath, 'utf8'),
    original,
    'real file was modified — mutation must target the temp copy only'
  );
}

function freshScrapeModule() {
  const id = require.resolve('../services/productReviewsScrapeService');
  delete require.cache[id];
  return require('../services/productReviewsScrapeService');
}

const rot = require('../services/quoteRotationService');
const helpers = require('../services/reviewAdapters/helpers');
const { selectRotatedQuote, rotationHash } = require('../services/directImageRenderService');
const { gateLayoutInputQuotes } = require('../services/brandScriptExecutor');

const rq = (text, tier) => ({
  text, tier: tier || 'product', origin: 'scraped', verbatim: true,
  snippet: text
});
const ROT_PROOF = {
  primary_quote: rq('I bought these in March and have worn them weekly since — still soft, still hold their shape.'),
  secondary_quotes: [
    rq('I absolutely love these joggers, the fabric is buttery soft and they survived six months of washes.'),
    rq('The quality is amazing and the pair I have feel like second skin.'),
    rq('These held up after a year of daily wear and still look new.'),
    rq('Washed them twenty times and the color has not faded at all.'),
    rq('Love it, great product.'),                                // generic praise — quality-floor reject
    rq('These are so comfortable I wear them to work.', 'brand'), // wrong tier
  ],
};

function layoutFor(proof) {
  return { input: { social_proof: proof, product: { name: 'Test Jogger' } } };
}

// Rotation + gate are chatty across the 200-run loops. Keep harness output readable.
const _log = console.log;
const _warn = console.warn;
console.log = (...args) => {
  const s = typeof args[0] === 'string' ? args[0] : '';
  if (s.includes('quote rotation:') || s.includes('quote withheld') || s.includes('templateRegistry')) return;
  _log(...args);
};
console.warn = (...args) => {
  const s = typeof args[0] === 'string' ? args[0] : '';
  if (s.includes('quote gate') || s.includes('quote rotation memory persist')) return;
  _warn(...args);
};

// The inverted latch the review proved: skip recent only when !sameRun,
// then always hash. Lives here so C4b / H7 can show it still disagrees.
function invertedLatchPick(proof, runId, opts) {
  const pool = rot.eligiblePool(proof);
  const recent = rot.normalizeRecentKeys(opts.recentKeys);
  const sameRun = opts.lastRunId && String(opts.lastRunId) === String(runId);
  let working = pool;
  if (recent.length && !sameRun) {
    const unseen = pool.filter((q) => !recent.includes(rot.quoteFingerprint(q)));
    working = unseen.length ? unseen : pool;
  }
  return working[rot.rotationHash(runId) % working.length].text;
}

console.log('\nverifyQuoteRotation\n');

// ── A. storage cap 10 → 30 ──────────────────────────────────────────────
console.log('A. PRODUCT_REVIEWS_MAX_QUOTES default is 30; rank-before-truncate stays');

check('A1 source fallback is || 30, not || 10', () => {
  const src = read(SRC_SCRAPE);
  const block = src.slice(src.indexOf('const MAX_QUOTES'), src.indexOf('const MIN_POSITIVE_STARS'));
  assert.ok(/\|\|\s*30\b/.test(block), 'expected || 30 fallback');
  assert.ok(!/\|\|\s*10\b/.test(block), 'stale || 10 fallback still present');
});

check('A2 runtime default is 30 when env is unset', () => {
  const prev = process.env.PRODUCT_REVIEWS_MAX_QUOTES;
  delete process.env.PRODUCT_REVIEWS_MAX_QUOTES;
  try {
    const { MAX_QUOTES } = freshScrapeModule();
    assert.strictEqual(MAX_QUOTES, 30, `got ${MAX_QUOTES}`);
  } finally {
    if (prev === undefined) delete process.env.PRODUCT_REVIEWS_MAX_QUOTES;
    else process.env.PRODUCT_REVIEWS_MAX_QUOTES = prev;
    freshScrapeModule(); // restore whatever the process env says
  }
});

check('A3 env override still wins (cap=7)', () => {
  const prev = process.env.PRODUCT_REVIEWS_MAX_QUOTES;
  process.env.PRODUCT_REVIEWS_MAX_QUOTES = '7';
  try {
    const { MAX_QUOTES } = freshScrapeModule();
    assert.strictEqual(MAX_QUOTES, 7);
  } finally {
    if (prev === undefined) delete process.env.PRODUCT_REVIEWS_MAX_QUOTES;
    else process.env.PRODUCT_REVIEWS_MAX_QUOTES = prev;
    freshScrapeModule();
  }
});

check('A4 rank-before-truncate is unchanged (rankQuotes then slice(0, maxQuotes))', () => {
  const src = read(SRC_SCRAPE);
  const i = src.indexOf('merged.quotes = rankQuotes');
  assert.ok(i !== -1, 'rankQuotes assignment missing');
  const line = src.slice(i, src.indexOf('\n', i));
  assert.ok(/rankQuotes\s*\(\s*merged\.quotes\s*\)\s*\.slice\s*\(\s*0\s*,\s*maxQuotes\s*\)/.test(line),
    `expected rank-then-slice, got: ${line}`);
});

check('A5 adapter fetch cap is still 100 — we did not change page/review limits', () => {
  const src = read(SRC_ADAPT);
  assert.ok(/REVIEW_ADAPTER_MAX_REVIEWS[\s\S]{0,80}\|\|\s*100/.test(src),
    'REVIEW_ADAPTER_MAX_REVIEWS default drifted — this lane must not touch fetch limits');
  assert.ok(/REVIEW_ADAPTER_MAX_PAGES[\s\S]{0,80}\|\|\s*5/.test(src));
});

check('A6 no downstream code assumes a 10-quote productReviews pool', () => {
  // PRODUCT_REVIEWS_MAX_QUOTES appears only as the env reader + this cap.
  // slice(0, 10) hits elsewhere are comments / Immersive rows / error samples,
  // not the stored product-reviews rotation pool.
  const hits = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      // Skip node_modules AND any dotfile/dotdir — same convention as
      // verifyMetaApiVersion.js's fix (real, reproduced revertprove-race in
      // CI: a sibling harness briefly writes a `.__revertprove_*.js`
      // transient into services/ or routes/, both scanned here).
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(p); continue; }
      if (!ent.name.endsWith('.js')) continue;
      const src = fs.readFileSync(p, 'utf8');
      if (/PRODUCT_REVIEWS_MAX_QUOTES/.test(src) && p !== SRC_SCRAPE
          && !p.endsWith('verifyQuoteRotation.js')) {
        hits.push(`${path.relative(ROOT, p)} references PRODUCT_REVIEWS_MAX_QUOTES`);
      }
    }
  };
  walk(path.join(ROOT, 'services'));
  walk(path.join(ROOT, 'routes'));
  walk(path.join(ROOT, 'scripts'));
  assert.strictEqual(hits.length, 0, hits.join('; '));
});

check('A7 LayoutInputArtifact secondary_quotes is capped (10→30 must not 3× the artifact)', () => {
  const src = read(SRC_LAYOUT);
  assert.ok(/MAX_LAYOUT_SECONDARY_QUOTES\s*=\s*16/.test(src),
    'artifact cap constant missing or drifted');
  assert.ok(/\.slice\s*\(\s*0\s*,\s*MAX_LAYOUT_SECONDARY_QUOTES\s*\)/.test(src),
    'secondary_quotes assignment is still uncapped — A6-class miss');
  // Director prompt is independently bounded — pin so a later "use the
  // artifact quotes in the Director brief" cannot silently 3× tokens.
  const dir = read(path.join(ROOT, 'services/aiCreativeDirectorService.js'));
  assert.ok(/MAX_QUOTES_PER_TIER\s*=\s*4/.test(dir),
    'Director MAX_QUOTES_PER_TIER drifted — 10→30 must not inflate the brief');
});

check('A8 assemble stamps .tier on every surviving quote (not just primary)', () => {
  // BEHAVIOURAL, deliberately. The previous form asserted the helper's
  // DECLARATION SHAPE (/const stampTier\s*=/) plus a raw call count >= 4.
  // Hoisting the closures to module scope so the stage-aware pick ranks the
  // same pool the renderer prints from broke that regex with behaviour
  // unchanged — a name scan cannot distinguish a refactor from a regression,
  // and one that fires on the wrong thing gets "fixed" by contorting the code.
  const { stampTier } = require(path.join(ROOT, 'services/layoutInputService.js'));

  // Stamps an unstamped quote with the tier it was given...
  const out = stampTier([{ text: 'unstamped' }, { text: 'already', tier: 'product' }], 'brand');
  assert.equal(out.length, 2, 'stampTier dropped a quote');
  assert.equal(out[0].tier, 'brand', 'stampTier did not stamp an unstamped quote');
  // ...and never overwrites one already set (product must survive a brand pass).
  assert.equal(out[1].tier, 'product', 'stampTier overwrote an existing tier');
  assert.deepEqual(stampTier(null, 'brand'), [], 'stampTier must tolerate null');

  // Every one of the four tiers must still be produced by a stamping helper.
  // Structural, but tolerant of WHICH helper and of its declaration form.
  const src = read(SRC_LAYOUT);
  for (const [name, tier] of [
    ['tierProduct', 'product'], ['tierCategory', 'category'],
    ['tierBrand', 'brand'], ['tierComment', 'comment']
  ]) {
    const m = src.match(new RegExp(`const ${name}\\s*=[\\s\\S]{0,500}?;`));
    assert.ok(m, `${name} assignment not found`);
    assert.ok(/stampTier\(|prepareQuotePool\(/.test(m[0]),
      `${name} is not routed through a tier-stamping helper`);
    assert.ok(m[0].includes(`'${tier}'`), `${name} does not carry the '${tier}' tier name`);
  }
});

// ── B. fingerprint reuse ────────────────────────────────────────────────
console.log('\nB. fingerprint is the existing reviewKey convention');

check('B1 quoteRotationService reuses helpers.reviewKey — does not invent one', () => {
  assert.strictEqual(rot.reviewKey, helpers.reviewKey, 'must be the same function object');
  const sample = '  Hello   WORLD  ';
  const expected = String(sample).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 160);
  assert.strictEqual(helpers.reviewKey(sample), expected);
  assert.strictEqual(rot.quoteFingerprint(sample), expected);
  assert.strictEqual(rot.quoteFingerprint({ text: sample }), expected);
});

check('B2 long reviews fingerprint on the first 160 lowercased chars', () => {
  const long = `A ${'very '.repeat(80)}long review`;
  assert.strictEqual(rot.quoteFingerprint(long).length, 160);
  assert.strictEqual(rot.quoteFingerprint(long), helpers.reviewKey(long));
});

check('B3 MEMORY_N defaults to 8', () => {
  assert.strictEqual(rot.MEMORY_N, 8);
});

// ── C. rotation memory ──────────────────────────────────────────────────
console.log('\nC. rotation memory skips seen keys and wraps when exhausted');

check('C1 memory OFF: same seed always picks the same quote (hash-only, the old behaviour)', () => {
  withEnv({ QUOTE_ROTATION_MEMORY: undefined, STATIC_QUOTE_ROTATION: undefined }, () => {
    const a = rot.rotateQuote(ROT_PROOF, 'run_seed', { enabled: true, memoryEnabled: false });
    const b = rot.rotateQuote(ROT_PROOF, 'run_seed', { enabled: true, memoryEnabled: false });
    assert.strictEqual(a.quote.text, b.quote.text, 'hash-only must be deterministic');
  });
});

check('C2 memory ON: same seed cannot pick the same quote while unseen exist (THE DEFECT)', () => {
  const first = rot.rotateQuote(ROT_PROOF, 'run_seed', {
    enabled: true, memoryEnabled: true, recentKeys: []
  });
  assert.ok(first.quote && first.quote.text, 'first pick missing');
  const second = rot.rotateQuote(ROT_PROOF, 'run_seed', {
    enabled: true, memoryEnabled: true, recentKeys: first.nextRecentKeys, lastRunId: 'other-run'
  });
  assert.notStrictEqual(second.quote.text, first.quote.text,
    'same seed re-picked the same quote while unseen candidates existed');
  assert.ok(first.nextRecentKeys.includes(first.fingerprint));
  assert.ok(!second.nextRecentKeys.includes(first.fingerprint)
    || second.nextRecentKeys.indexOf(first.fingerprint) < second.nextRecentKeys.length - 1
    || second.quote.text !== first.quote.text);
});

check('C3 wrap: exhausted pool still excludes the previous run\'s quote', () => {
  const eligible = rot.eligiblePool(ROT_PROOF);
  assert.ok(eligible.length >= 2, `need a real pool, got ${eligible.length}`);
  const allKeys = eligible.map((q) => rot.quoteFingerprint(q));
  const lastUsed = allKeys[allKeys.length - 1];
  const lastText = eligible[eligible.length - 1].text;
  const wrapped = rot.rotateQuote(ROT_PROOF, 'run_wrap', {
    enabled: true, memoryEnabled: true, recentKeys: allKeys, lastRunId: 'prior'
  });
  assert.strictEqual(wrapped.wrapped, true, 'expected wrap when pool exhausted');
  assert.ok(eligible.some((q) => q.text === wrapped.quote.text), 'wrap pick not in full pool');
  assert.notStrictEqual(wrapped.quote.text, lastText,
    'wrap reintroduced the consecutive-run collision (reprinted last-used)');
  assert.notStrictEqual(wrapped.fingerprint, lastUsed);
  assert.deepStrictEqual(wrapped.nextRecentKeys, [wrapped.fingerprint],
    'wrap must clear then record only the new pick');
});

check('C4 same-run latch: sibling with NON-EMPTY prior memory replays the first pick', () => {
  // C4 used to start from recentKeys: [] — the latch was a no-op because
  // the first size already hashed the full pool. The real hole is the
  // second Generate onward.
  const prior = rot.rotateQuote(ROT_PROOF, 'run_prior', {
    enabled: true, memoryEnabled: true, recentKeys: []
  });
  const first = rot.rotateQuote(ROT_PROOF, 'run_same', {
    enabled: true, memoryEnabled: true,
    recentKeys: prior.nextRecentKeys,
    lastRunId: 'run_prior',
    lastFingerprint: prior.fingerprint
  });
  const sibling = rot.rotateQuote(ROT_PROOF, 'run_same', {
    enabled: true, memoryEnabled: true,
    recentKeys: first.nextRecentKeys,
    lastRunId: 'run_same',
    lastFingerprint: first.fingerprint
  });
  assert.strictEqual(sibling.quote.text, first.quote.text,
    'a sibling size of the same run must replay the fingerprint, not re-hash');
  assert.strictEqual(sibling.lockedSameRun, true);
  assert.notStrictEqual(first.quote.text, prior.quote.text,
    'fixture: second run must have moved off the prior pick');
});

check('C4b same-run equality holds over 200 run-ids × pre-existing memory', () => {
  const prior = rot.rotateQuote(ROT_PROOF, 'run_memory_seed', {
    enabled: true, memoryEnabled: true, recentKeys: []
  });
  // Two keys of prior memory so unseen.length < pool.length — the
  // modulo-base change the inverted latch introduced.
  const secondPrior = rot.rotateQuote(ROT_PROOF, 'run_memory_seed_2', {
    enabled: true, memoryEnabled: true,
    recentKeys: prior.nextRecentKeys, lastRunId: 'run_memory_seed'
  });
  const priorKeys = secondPrior.nextRecentKeys;
  assert.ok(priorKeys.length >= 2, `need pre-existing memory, got ${priorKeys.length}`);
  let shippedDisagree = 0;
  let invertedDisagree = 0;
  const N = 200;
  for (let i = 0; i < N; i++) {
    const runId = `run_race_${i}`;
    const first = rot.rotateQuote(ROT_PROOF, runId, {
      enabled: true, memoryEnabled: true,
      recentKeys: priorKeys,
      lastRunId: 'older-run',
      lastFingerprint: priorKeys[priorKeys.length - 1]
    });
    const sibling = rot.rotateQuote(ROT_PROOF, runId, {
      enabled: true, memoryEnabled: true,
      recentKeys: first.nextRecentKeys,
      lastRunId: runId,
      lastFingerprint: first.fingerprint
    });
    if (sibling.quote.text !== first.quote.text) shippedDisagree++;
    const invFirst = invertedLatchPick(ROT_PROOF, runId, {
      recentKeys: priorKeys, lastRunId: 'older-run'
    });
    const invSibling = invertedLatchPick(ROT_PROOF, runId, {
      recentKeys: first.nextRecentKeys, lastRunId: runId
    });
    if (invFirst !== invSibling) invertedDisagree++;
  }
  assert.strictEqual(shippedDisagree, 0,
    `shipped same-run disagreed on ${shippedDisagree}/${N} run-ids`);
  assert.ok(invertedDisagree >= 50,
    `fixture: inverted latch should disagree often, got ${invertedDisagree}/${N}`);
});

check('C5 memory still honours same-tier + quality-floor guards', () => {
  const brand = 'These are so comfortable I wear them to work.';
  const generic = 'Love it, great product.';
  for (let i = 0; i < 40; i++) {
    const r = rot.rotateQuote(ROT_PROOF, `run_${i}`, {
      enabled: true, memoryEnabled: true, recentKeys: [], lastRunId: null
    });
    assert.notStrictEqual(r.quote.text, brand, 'memory must not cross the tier cascade');
    assert.notStrictEqual(r.quote.text, generic, 'memory must not rotate downhill');
  }
});

check('C6 nextRecentKeys caps at N and drops the oldest', () => {
  const prev = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const next = rot.nextRecentKeys(prev, 'i', { max: 8 });
  assert.deepStrictEqual(next, ['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
  assert.strictEqual(next.length, 8);
});

check('C7 flag-off: recentKeys are ignored (byte-identity with hash-only)', () => {
  const seen = rot.quoteFingerprint(ROT_PROOF.primary_quote);
  // Pick a seed that hash-only lands on the primary (or any quote).
  const off = rot.rotateQuote(ROT_PROOF, 'run_seed', {
    enabled: true, memoryEnabled: false, recentKeys: [seen]
  });
  const baseline = rot.rotateQuote(ROT_PROOF, 'run_seed', {
    enabled: true, memoryEnabled: false, recentKeys: []
  });
  assert.strictEqual(off.quote.text, baseline.quote.text,
    'memory-off must ignore recentKeys');
});

check('C8 wrap over 200 seeds never reprints the last-used quote', () => {
  const eligible = rot.eligiblePool(ROT_PROOF);
  const allKeys = eligible.map((q) => rot.quoteFingerprint(q));
  const lastText = eligible[eligible.length - 1].text;
  let reprints = 0;
  for (let i = 0; i < 200; i++) {
    const w = rot.rotateQuote(ROT_PROOF, `run_wrap_${i}`, {
      enabled: true, memoryEnabled: true, recentKeys: allKeys, lastRunId: 'prior'
    });
    if (w.quote.text === lastText) reprints++;
  }
  assert.strictEqual(reprints, 0, `wrap reprinted last-used on ${reprints}/200 seeds`);
});

// ── D. static wrapper still serves verifyQuoteSurfaceLength ──────────────
console.log('\nD. static path still exports the shipped helper');

check('D1 selectRotatedQuote from directImageRenderService matches the shared helper', () => {
  withEnv({ STATIC_QUOTE_ROTATION: undefined, QUOTE_ROTATION_MEMORY: undefined }, () => {
    const viaStatic = selectRotatedQuote(ROT_PROOF, 'run_A');
    const viaShared = rot.selectRotatedQuote(ROT_PROOF, 'run_A', { enabled: true, memoryEnabled: false });
    assert.strictEqual(viaStatic.text, viaShared.text);
  });
});

check('D2 STATIC_QUOTE_ROTATION=false still returns the primary (existing kill switch)', () => {
  withEnv({ STATIC_QUOTE_ROTATION: 'false' }, () => {
    const picked = selectRotatedQuote(ROT_PROOF, 'run_A');
    assert.strictEqual(picked.text, ROT_PROOF.primary_quote.text);
  });
});

check('D3 rotationHash is the shared FNV-1a (no Date, no Math.random)', () => {
  assert.strictEqual(rotationHash('run_A'), rot.rotationHash('run_A'));
  const src = read(SRC_ROT);
  const region = src.slice(src.indexOf('function rotationHash'), src.indexOf('function quoteFingerprint'));
  assert.ok(!/Math\.random|Date\.now|new Date/.test(region));
});

check('D4 static render selects recentQuoteKeys + lastQuoteRunId + lastQuoteFingerprint', () => {
  const src = read(SRC_STATIC);
  const selects = [...src.matchAll(/CatalogProduct\.findById\([^)]+\)\.select\('([^']+)'\)/g)]
    .map((m) => m[1]);
  assert.ok(selects.length >= 1, 'no CatalogProduct.select in static renderer');
  for (const sel of selects) {
    assert.ok(/\brecentQuoteKeys\b/.test(sel), `missing recentQuoteKeys: ${sel}`);
    assert.ok(/\blastQuoteRunId\b/.test(sel), `missing lastQuoteRunId: ${sel}`);
    assert.ok(/\blastQuoteFingerprint\b/.test(sel), `missing lastQuoteFingerprint: ${sel}`);
  }
});

check('D5 static persist is fire-and-forget (no await persistQuoteChoice)', () => {
  const src = read(SRC_STATIC);
  assert.ok(/persistQuoteChoice/.test(src), 'static path never persists memory');
  assert.ok(!/await\s+rot\.persistQuoteChoice/.test(src)
    && !/await\s+.*persistQuoteChoice/.test(src),
    'awaiting persist would stall a billed render on a memory write');
});

check('D6 static persist swallows errors (catch → warn, never throw)', () => {
  const src = read(SRC_ROT);
  const fn = src.slice(src.indexOf('function persistQuoteChoice'), src.indexOf('module.exports'));
  assert.ok(/\.catch\s*\(/.test(fn), 'persist must catch Mongo errors');
  assert.ok(/console\.warn/.test(fn), 'persist must log the blip');
  assert.ok(/return false/.test(fn));
});

check('D7 static rotateQuote is passed scope so STRICT cannot be undone', () => {
  const src = read(SRC_STATIC);
  const region = src.slice(src.indexOf('function buildIntentData'), src.indexOf('async function resolveConcept'))
    .split('\n')
    .filter((l) => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); })
    .join('\n');
  assert.ok(/scope:\s*strictScope/.test(region),
    'static rotation must receive the same STRICT scope the gate uses');
  const iScope = region.indexOf('const strictScope');
  const iRot = region.indexOf('selectRotatedQuote');
  assert.ok(iScope !== -1 && iRot !== -1 && iScope < iRot,
    'scope must be built BEFORE rotation');
});

// ── E. video rotation ───────────────────────────────────────────────────
console.log('\nE. video rotation — same helper, default-off');

check('E0 VIDEO_QUOTE_ROTATION defaults FALSE (opt-in, not !== false)', () => {
  const src = read(SRC_ROT);
  const fn = src.slice(src.indexOf('function videoRotationEnabled'), src.indexOf('function memoryEnabled'));
  assert.ok(/VIDEO_QUOTE_ROTATION\s*===\s*'true'/.test(fn),
    'video flag must default off — `!== \'false\'` would silently change every video');
  withEnv({ VIDEO_QUOTE_ROTATION: undefined }, () => {
    assert.strictEqual(rot.videoRotationEnabled(), false);
  });
});

check('E1 flag-off: rotateLayoutInputQuote returns the SAME object (byte-identity)', () => {
  withEnv({ VIDEO_QUOTE_ROTATION: undefined }, () => {
    const input = layoutFor(ROT_PROOF);
    const out = rot.rotateLayoutInputQuote(input, 'run_A');
    assert.strictEqual(out, input, 'flag-off must not clone the layoutInput');
    assert.strictEqual(out.input.social_proof.primary_quote.text, ROT_PROOF.primary_quote.text);
  });
});

check('E2 flag-off: two runs return identical snippets', () => {
  withEnv({ VIDEO_QUOTE_ROTATION: undefined }, () => {
    const a = rot.rotateLayoutInputQuote(layoutFor(ROT_PROOF), 'run_A');
    const b = rot.rotateLayoutInputQuote(layoutFor(ROT_PROOF), 'run_B');
    assert.strictEqual(a.input.social_proof.primary_quote.snippet, b.input.social_proof.primary_quote.snippet);
    assert.strictEqual(a.input.social_proof.primary_quote.text, ROT_PROOF.primary_quote.text);
  });
});

check('E3 flag-on: two runs return different snippets', () => {
  withEnv({ VIDEO_QUOTE_ROTATION: 'true', QUOTE_ROTATION_MEMORY: undefined }, () => {
    const snippets = ['run_A', 'run_B', 'run_C', 'run_D', 'run_E', 'run_F']
      .map((id) => rot.rotateLayoutInputQuote(layoutFor(ROT_PROOF), id)
        .input.social_proof.primary_quote.snippet);
    assert.ok(new Set(snippets).size >= 2, `video rotation did not vary: ${JSON.stringify(snippets)}`);
  });
});

check('E4 video path calls the shared helper before the provenance gate', () => {
  const src = read(SRC_VIDEO);
  const iRot = src.indexOf('rotateLayoutInputQuote');
  const iGate = src.indexOf('layoutInput = gateLayoutInputQuotes');
  assert.ok(iRot !== -1 && iGate !== -1 && iRot < iGate,
    'video must rotate BEFORE gateLayoutInputQuotes so the gate still has the final word');
});

check('E5 video selects recentQuoteKeys + lastQuoteRunId + lastQuoteFingerprint on CatalogProduct', () => {
  const src = read(SRC_VIDEO);
  const m = src.match(/CatalogProduct\.findById\([^)]+\)\.select\('([^']+)'\)/);
  assert.ok(m, 'CatalogProduct.select missing on video path');
  assert.ok(/\brecentQuoteKeys\b/.test(m[1]), m[1]);
  assert.ok(/\blastQuoteRunId\b/.test(m[1]), m[1]);
  assert.ok(/\blastQuoteFingerprint\b/.test(m[1]), m[1]);
});

check('E6 campaignRunIdFromAd reads the last campaignRunIds entry', () => {
  assert.strictEqual(rot.campaignRunIdFromAd({ campaignRunIds: ['old', 'new'] }), 'new');
  assert.strictEqual(rot.campaignRunIdFromAd({ campaignRunId: 'solo' }), 'solo');
  assert.strictEqual(rot.campaignRunIdFromAd({}), null);
});

check('E7 video never edits quote text (no .text = in the rotation helper)', () => {
  const src = read(SRC_ROT);
  assert.ok(!/\.text\s*=/.test(src), 'rotation must pick an existing quote object, never rewrite .text');
});

check('E8 rotation cannot drop a quote the video gate would have kept', () => {
  const bomber = rq('This bomber jacket is the only layer I reach for all season.', 'brand');
  const genericA = rq('The quality is amazing and the pair I have feel like second skin.', 'brand');
  const genericB = rq('I bought these in March and have worn them weekly since — still soft.', 'brand');
  const genericC = rq('These held up after a year of daily wear and still look new.', 'brand');
  const proof = {
    primary_quote: genericA,
    secondary_quotes: [bomber, genericB, genericC]
  };
  const pantsScope = {
    productAttached: false,
    media: {
      primarySubjectLabel: 'Track pants',
      refinedProducts: [{ label: 'sneakers' }]
    }
  };
  withEnv({ VIDEO_QUOTE_ROTATION: 'true', QUOTE_PROVENANCE_STRICT: 'true' }, () => {
    const pool = rot.eligiblePool(proof, { scope: pantsScope });
    assert.ok(pool.every((q) => !/jacket/i.test(q.text)),
      'STRICT-failing jacket quote must not enter the rotation pool');
    assert.ok(pool.length >= 2, `expected generics to remain, got ${pool.length}`);
    for (let i = 0; i < 40; i++) {
      const input = layoutFor(proof);
      const rotated = rot.rotateLayoutInputQuote(input, `run_gate_${i}`, { scope: pantsScope });
      const gated = gateLayoutInputQuotes(rotated, pantsScope);
      const kept = gated?.input?.social_proof?.primary_quote;
      assert.ok(kept && String(kept.text || '').trim(),
        `flag-on lost the testimonial flag-off would print (run_gate_${i})`);
      assert.ok(!/jacket/i.test(kept.text), 'gated quote must not be the jacket line');
    }
    // Flag-off still prints the original primary.
    const off = rot.rotateLayoutInputQuote(layoutFor(proof), 'run_off', { enabled: false });
    const gatedOff = gateLayoutInputQuotes(off, pantsScope);
    assert.strictEqual(gatedOff.input.social_proof.primary_quote.text, genericA.text);
  });
});

check('E9 rotateLayoutInputQuote keeps the original primary in secondaries', () => {
  withEnv({ VIDEO_QUOTE_ROTATION: 'true' }, () => {
    const input = layoutFor(ROT_PROOF);
    const original = ROT_PROOF.primary_quote.text;
    // Find a run that actually reseats.
    let reseated = null;
    for (const id of ['run_A', 'run_B', 'run_C', 'run_D', 'run_E', 'run_F', 'run_G', 'run_H']) {
      const out = rot.rotateLayoutInputQuote(input, id);
      if (out.input.social_proof.primary_quote.text !== original) {
        reseated = out;
        break;
      }
    }
    assert.ok(reseated, 'fixture: could not find a run that reseats the primary');
    const seconds = reseated.input.social_proof.secondary_quotes || [];
    assert.ok(seconds.some((q) => q && q.text === original),
      'original primary must remain rescue-able after rotation');
  });
});

check('E10 video caller forwards scope into rotateLayoutInputQuote', () => {
  const src = read(SRC_VIDEO);
  const region = src.slice(
    src.indexOf('VIDEO_QUOTE_ROTATION (default false)'),
    src.indexOf('layoutInput = gateLayoutInputQuotes')
  );
  assert.ok(/const rotateScope\s*=/.test(region), 'rotateScope must be built for the video path');
  assert.ok(/scope:\s*rotateScope/.test(region),
    'video rotation must receive STRICT scope or it can reseat a failing brand-pool line');
});

// ── F. flag-off byte-identity, both paths ───────────────────────────────
console.log('\nF. flag-off byte-identity for static + video');

check('F1 STATIC_QUOTE_ROTATION=false + memory on still returns the primary', () => {
  withEnv({ STATIC_QUOTE_ROTATION: 'false', QUOTE_ROTATION_MEMORY: 'true' }, () => {
    const picked = selectRotatedQuote(ROT_PROOF, 'run_A', {
      recentKeys: ['anything'], memoryEnabled: true
    });
    assert.strictEqual(picked.text, ROT_PROOF.primary_quote.text);
  });
});

check('F2 QUOTE_ROTATION_MEMORY defaults false', () => {
  withEnv({ QUOTE_ROTATION_MEMORY: undefined }, () => {
    assert.strictEqual(rot.memoryEnabled(), false);
  });
  const src = read(SRC_ROT);
  const fn = src.slice(src.indexOf('function memoryEnabled'), src.indexOf('function rotationHash'));
  assert.ok(/QUOTE_ROTATION_MEMORY\s*===\s*'true'/.test(fn),
    'memory must default off — a truthy check would opt in on the string "false"');
});

check('F3 persistQuoteChoice is a no-op when memory is off (does not require CatalogProduct)', () => {
  withEnv({ QUOTE_ROTATION_MEMORY: undefined }, () => {
    const src = read(SRC_ROT);
    const fn = src.slice(src.indexOf('function persistQuoteChoice'), src.indexOf('module.exports'));
    assert.ok(/if\s*\(\s*!memoryEnabled\(\)\s*\)\s*return/.test(fn),
      'persist must bail before touching CatalogProduct when the flag is off');
    const p = rot.persistQuoteChoice('ffffffffffffffffffffffff', {
      fingerprint: 'abc', campaignRunId: 'run_A'
    });
    assert.ok(p && typeof p.then === 'function', 'persist returns a Promise');
  });
});

// ── G. schema declaration ───────────────────────────────────────────────
console.log('\nG. CatalogProduct declares latch fields (mongoose-strict trap)');

check('G1 recentQuoteKeys, lastQuoteRunId, lastQuoteFingerprint are declared', () => {
  const src = read(SRC_CAT);
  assert.ok(/recentQuoteKeys\s*:/.test(src), 'recentQuoteKeys missing — $set will be silently dropped');
  assert.ok(/lastQuoteRunId\s*:/.test(src), 'lastQuoteRunId missing — same-run latch will not persist');
  assert.ok(/lastQuoteFingerprint\s*:/.test(src),
    'lastQuoteFingerprint missing — siblings cannot replay the run\'s pick');
});

check('G2 persist is atomic (run-id filter + $push/$slice), not a snapshot $set', () => {
  const src = read(SRC_ROT);
  const fn = src.slice(src.indexOf('function persistOp'), src.indexOf('function persistQuoteChoice'));
  assert.ok(/lastQuoteRunId:\s*\{\s*\$ne:/.test(fn),
    'persist filter must be first-writer-wins on lastQuoteRunId');
  assert.ok(/lastQuoteFingerprint:/.test(fn));
  assert.ok(/\$push:/.test(fn) && /\$slice:/.test(fn),
    'non-wrap persist must $push+$slice so overlapping runs cannot wipe the skip list');
  // The old hole: $set the whole array from a stale read, unconditioned.
  assert.ok(!/nextRecentKeys/.test(fn),
    'persistOp must not write a caller-computed snapshot array');
});

// ── H. automated revert-proof ───────────────────────────────────────────
console.log('\nH. automated revert-proof (mutate → fail → restore)');

check('H1 [REVERT] restoring || 10 as the cap fallback fails A1', () => {
  let failedAsExpected = false;
  withTempMutation(SRC_SCRAPE, '|| 30', '|| 10', (mut) => {
    const block = mut.slice(mut.indexOf('const MAX_QUOTES'), mut.indexOf('const MIN_POSITIVE_STARS'));
    if (/\|\|\s*10\b/.test(block) && !/\|\|\s*30\b/.test(block)) failedAsExpected = true;
  });
  assert.ok(failedAsExpected, '|| 10 mutation did not trip the cap pin');
});

check('H2 [REVERT] dropping the unseen-filter fails the same-seed defect check', () => {
  // Behavioural twin of C2: a hash-only picker (the pre-memory code) MUST
  // collide on the same seed. If this assertion ever fails, the fixture is
  // broken — not the shipping code.
  const hashOnly = (proof, seed) => rot.rotateQuote(proof, seed, {
    enabled: true, memoryEnabled: false
  }).quote.text;
  assert.strictEqual(hashOnly(ROT_PROOF, 'run_seed'), hashOnly(ROT_PROOF, 'run_seed'),
    'fixture: hash-only same seed must collide (this is the defect)');
  const first = rot.rotateQuote(ROT_PROOF, 'run_seed', {
    enabled: true, memoryEnabled: true, recentKeys: []
  });
  const second = rot.rotateQuote(ROT_PROOF, 'run_seed', {
    enabled: true, memoryEnabled: true, recentKeys: first.nextRecentKeys, lastRunId: 'prior'
  });
  assert.notStrictEqual(second.quote.text, first.quote.text);
});

check('H3 [REVERT] a wrap that keeps the last-used quote would fail C3', () => {
  const eligible = rot.eligiblePool(ROT_PROOF);
  const allKeys = eligible.map((q) => rot.quoteFingerprint(q));
  const lastText = eligible[eligible.length - 1].text;
  // Broken wrap: restore the FULL pool including last-used, then hash.
  let brokenReprints = 0;
  for (let i = 0; i < 80; i++) {
    const working = eligible; // full pool — the bug
    const pick = working[rot.rotationHash(`run_wrap_${i}`) % working.length];
    if (pick.text === lastText) brokenReprints++;
  }
  assert.ok(brokenReprints >= 5, `fixture: broken wrap should reprint, got ${brokenReprints}/80`);
  const shipped = rot.rotateQuote(ROT_PROOF, 'run_wrap', {
    enabled: true, memoryEnabled: true, recentKeys: allKeys, lastRunId: 'prior'
  });
  assert.strictEqual(shipped.wrapped, true);
  assert.notStrictEqual(shipped.quote.text, lastText);
});

check('H4 [REVERT] video flag as !== false would fail E0 (silent video change)', () => {
  let failedAsExpected = false;
  withTempMutation(
    SRC_ROT,
    "return process.env.VIDEO_QUOTE_ROTATION === 'true';",
    "return process.env.VIDEO_QUOTE_ROTATION !== 'false';",
    (mut) => {
      const fn = mut.slice(mut.indexOf('function videoRotationEnabled'), mut.indexOf('function memoryEnabled'));
      if (/!==\s*'false'/.test(fn) && !(/===\s*'true'/.test(fn))) failedAsExpected = true;
    }
  );
  assert.ok(failedAsExpected, 'default-on mutation did not trip E0');
});

check('H5 [REVERT] deleting recentQuoteKeys from the schema fails G1', () => {
  let failedAsExpected = false;
  withTempMutation(SRC_CAT, 'recentQuoteKeys: { type: [String], default: undefined },', '', (mut) => {
    if (!/recentQuoteKeys\s*:/.test(mut)) failedAsExpected = true;
  });
  assert.ok(failedAsExpected, 'schema-field deletion did not trip G1');
});

check('H6 [REVERT] static wrapper no longer calling the shared helper would desync video', () => {
  const src = read(SRC_STATIC);
  const region = src.slice(src.indexOf('function selectRotatedQuote'), src.indexOf('function buildIntentData'));
  assert.ok(/quoteRotationService/.test(region),
    'static selectRotatedQuote must delegate to the shared helper');
  const video = read(SRC_VIDEO);
  assert.ok(/quoteRotationService/.test(video) && /rotateLayoutInputQuote/.test(video),
    'video path must call the shared helper');
});

check('H7 [REVERT] inverted latch (re-hash full pool) disagrees once memory exists', () => {
  const prior = rot.rotateQuote(ROT_PROOF, 'h7_prior', {
    enabled: true, memoryEnabled: true, recentKeys: []
  });
  const prior2 = rot.rotateQuote(ROT_PROOF, 'h7_prior2', {
    enabled: true, memoryEnabled: true,
    recentKeys: prior.nextRecentKeys, lastRunId: 'h7_prior'
  });
  const keys = prior2.nextRecentKeys;
  let inverted = 0;
  let shipped = 0;
  for (let i = 0; i < 200; i++) {
    const runId = `h7_${i}`;
    const first = rot.rotateQuote(ROT_PROOF, runId, {
      enabled: true, memoryEnabled: true,
      recentKeys: keys, lastRunId: 'older', lastFingerprint: keys[keys.length - 1]
    });
    const sib = rot.rotateQuote(ROT_PROOF, runId, {
      enabled: true, memoryEnabled: true,
      recentKeys: first.nextRecentKeys, lastRunId: runId, lastFingerprint: first.fingerprint
    });
    if (sib.quote.text !== first.quote.text) shipped++;
    const a = invertedLatchPick(ROT_PROOF, runId, { recentKeys: keys, lastRunId: 'older' });
    const b = invertedLatchPick(ROT_PROOF, runId, {
      recentKeys: first.nextRecentKeys, lastRunId: runId
    });
    if (a !== b) inverted++;
  }
  assert.strictEqual(shipped, 0);
  assert.ok(inverted >= 50, `inverted latch fixture too weak: ${inverted}/200`);
});

check('H8 [REVERT] snapshot $set persist (no $ne filter) would fail G2', () => {
  let failedAsExpected = false;
  withTempMutation(
    SRC_ROT,
    'const filter = { lastQuoteRunId: { $ne: runId } };',
    'const filter = {};',
    (mut) => {
      const fn = mut.slice(mut.indexOf('function persistOp'), mut.indexOf('function persistQuoteChoice'));
      if (!/lastQuoteRunId:\s*\{\s*\$ne:/.test(fn)) failedAsExpected = true;
    }
  );
  assert.ok(failedAsExpected, 'dropping the run-id filter did not trip G2');
});

check('H9 [REVERT] dropping the secondary_quotes slice fails A7', () => {
  let failedAsExpected = false;
  withTempMutation(
    SRC_LAYOUT,
    '.slice(0, MAX_LAYOUT_SECONDARY_QUOTES)',
    '',
    (mut) => {
      if (!/\.slice\s*\(\s*0\s*,\s*MAX_LAYOUT_SECONDARY_QUOTES\s*\)/.test(mut)) {
        failedAsExpected = true;
      }
    }
  );
  assert.ok(failedAsExpected, 'uncapped secondary_quotes mutation did not trip A7');
});

check('H10 [REVERT] deleting lastQuoteFingerprint from the schema fails G1', () => {
  let failedAsExpected = false;
  withTempMutation(
    SRC_CAT,
    'lastQuoteFingerprint: { type: String, default: undefined },',
    '',
    (mut) => {
      if (!/lastQuoteFingerprint\s*:/.test(mut)) failedAsExpected = true;
    }
  );
  assert.ok(failedAsExpected, 'fingerprint field deletion did not trip G1');
});

// ── I. no LLM, no quote rewrite ─────────────────────────────────────────
console.log('\nI. no LLM calls, no quote-text edits');

check('I1 quoteRotationService has no atlas/openai/llm require and no .text assignment', () => {
  const src = read(SRC_ROT);
  assert.ok(!/atlasLlm|openai|anthropic|chatCompletion/i.test(src));
  assert.ok(!/\.text\s*=/.test(src));
});

// ── J. concurrency invariant ────────────────────────────────────────────
console.log('\nJ. concurrency: interleaved siblings on a shared mutable doc');

function siblingOpts(shared, extras = {}) {
  return {
    enabled: true,
    memoryEnabled: true,
    recentKeys: shared.recentQuoteKeys,
    lastRunId: shared.lastQuoteRunId,
    lastFingerprint: shared.lastQuoteFingerprint,
    ...extras
  };
}

check('J1 staggered siblings (first persist, then 1:1 / 4:5 / 9:16 read) agree', () => {
  const prior = rot.rotateQuote(ROT_PROOF, 'j1_prior', {
    enabled: true, memoryEnabled: true, recentKeys: []
  });
  const shared = {
    recentQuoteKeys: prior.nextRecentKeys,
    lastQuoteRunId: 'j1_prior',
    lastQuoteFingerprint: prior.fingerprint
  };
  const texts = [];
  for (let i = 0; i < 3; i++) {
    const r = rot.rotateQuote(ROT_PROOF, 'j1_run', siblingOpts(shared));
    texts.push(r.quote.text);
    const committed = rot.commitQuoteChoice(shared, {
      fingerprint: r.fingerprint,
      campaignRunId: 'j1_run',
      wrapped: r.wrapped
    });
    Object.assign(shared, committed.doc);
  }
  assert.strictEqual(new Set(texts).size, 1, `staggered siblings disagreed: ${JSON.stringify(texts)}`);
  assert.strictEqual(shared.lastQuoteRunId, 'j1_run');
  assert.strictEqual(shared.lastQuoteFingerprint, rot.quoteFingerprint(texts[0]));
});

check('J2 all-read-then-persist (same snapshot) agrees and first-writer-wins', () => {
  const prior = rot.rotateQuote(ROT_PROOF, 'j2_prior', {
    enabled: true, memoryEnabled: true, recentKeys: []
  });
  const snapshot = {
    recentQuoteKeys: prior.nextRecentKeys.slice(),
    lastQuoteRunId: 'j2_prior',
    lastQuoteFingerprint: prior.fingerprint
  };
  const picks = [0, 1, 2].map(() => rot.rotateQuote(ROT_PROOF, 'j2_run', siblingOpts(snapshot)));
  const texts = picks.map((p) => p.quote.text);
  assert.strictEqual(new Set(texts).size, 1, `same-snapshot picks disagreed: ${JSON.stringify(texts)}`);
  let doc = {
    recentQuoteKeys: snapshot.recentQuoteKeys.slice(),
    lastQuoteRunId: snapshot.lastQuoteRunId,
    lastQuoteFingerprint: snapshot.lastQuoteFingerprint
  };
  const applied = [];
  for (const p of picks) {
    const committed = rot.commitQuoteChoice(doc, {
      fingerprint: p.fingerprint,
      campaignRunId: 'j2_run',
      wrapped: p.wrapped
    });
    applied.push(committed.applied);
    doc = committed.doc;
  }
  assert.deepStrictEqual(applied, [true, false, false],
    `first-writer-wins broken: ${JSON.stringify(applied)}`);
  assert.strictEqual(doc.lastQuoteFingerprint, picks[0].fingerprint);
});

check('J3 200 run-ids × 3 staggered siblings never diverge (pre-existing memory)', () => {
  const seed = rot.rotateQuote(ROT_PROOF, 'j3_seed', {
    enabled: true, memoryEnabled: true, recentKeys: []
  });
  const seed2 = rot.rotateQuote(ROT_PROOF, 'j3_seed2', {
    enabled: true, memoryEnabled: true,
    recentKeys: seed.nextRecentKeys, lastRunId: 'j3_seed'
  });
  let disagree = 0;
  for (let i = 0; i < 200; i++) {
    const runId = `j3_${i}`;
    const shared = {
      recentQuoteKeys: seed2.nextRecentKeys.slice(),
      lastQuoteRunId: 'j3_seed2',
      lastQuoteFingerprint: seed2.fingerprint
    };
    const texts = [];
    for (let s = 0; s < 3; s++) {
      const r = rot.rotateQuote(ROT_PROOF, runId, siblingOpts(shared));
      texts.push(r.quote.text);
      const committed = rot.commitQuoteChoice(shared, {
        fingerprint: r.fingerprint,
        campaignRunId: runId,
        wrapped: r.wrapped
      });
      Object.assign(shared, committed.doc);
    }
    if (new Set(texts).size !== 1) disagree++;
  }
  assert.strictEqual(disagree, 0, `concurrency disagreed on ${disagree}/200 runs`);
});

check('J4 overlapping different runs: $push keeps both fingerprints (no lost-update of the skip list)', () => {
  const a = rot.rotateQuote(ROT_PROOF, 'run_A', {
    enabled: true, memoryEnabled: true, recentKeys: []
  });
  let doc = { recentQuoteKeys: [], lastQuoteRunId: null, lastQuoteFingerprint: null };
  const ca = rot.commitQuoteChoice(doc, { fingerprint: a.fingerprint, campaignRunId: 'run_A' });
  doc = ca.doc;
  const b = rot.rotateQuote(ROT_PROOF, 'run_B', {
    enabled: true, memoryEnabled: true,
    recentKeys: doc.recentQuoteKeys, lastRunId: doc.lastQuoteRunId,
    lastFingerprint: doc.lastQuoteFingerprint
  });
  const cb = rot.commitQuoteChoice(doc, { fingerprint: b.fingerprint, campaignRunId: 'run_B' });
  doc = cb.doc;
  assert.ok(doc.recentQuoteKeys.includes(a.fingerprint),
    'run B must not wipe run A\'s fingerprint (the snapshot-$set hole)');
  assert.ok(doc.recentQuoteKeys.includes(b.fingerprint));
  assert.strictEqual(doc.lastQuoteRunId, 'run_B');
  assert.strictEqual(doc.lastQuoteFingerprint, b.fingerprint);
});

check('J5 persistOp filter + update match commitQuoteChoice semantics', () => {
  const op = rot.persistOp({ fingerprint: 'hello world', campaignRunId: 'run_X' });
  assert.deepStrictEqual(op.filter, { lastQuoteRunId: { $ne: 'run_X' } });
  assert.strictEqual(op.update.$set.lastQuoteRunId, 'run_X');
  assert.ok(op.update.$set.lastQuoteFingerprint);
  assert.ok(op.update.$push.recentQuoteKeys.$each);
  assert.ok(Number.isInteger(op.update.$push.recentQuoteKeys.$slice));
  const wrap = rot.persistOp({ fingerprint: 'hello world', campaignRunId: 'run_X', wrapped: true });
  assert.deepStrictEqual(wrap.update.$set.recentQuoteKeys, [rot.reviewKey('hello world')]);
});

console.log(`\nverifyQuoteRotation: ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail ? 1 : 0);
