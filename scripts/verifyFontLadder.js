#!/usr/bin/env node
'use strict';
/**
 * verifyFontLadder — offline guard for per-role font TIER ORDER.
 *
 * WHY THIS EXISTS
 * Resolution used to collapse the whole cascade to ONE pre-picked family and
 * then fall straight to the role default if that family could not be served —
 * so a tier could win the cascade and render nothing it named. Pelagic's real
 * face is "Oswald", which Google serves exactly, but the curated styleTheme
 * alias ("Montserrat") sat above it and won outright. Owner, on the 17-ad
 * sample: "for pelagic, the before looked better in terms of font style." The
 * before was Oswald.
 *
 * The fix is NOT "scanned first" — that breaks the opposite case. AllBirds'
 * real face is "Self Modern"; with no servable file, the curated "DM Sans" is
 * the right answer. So the scraped family is EXACT-ONLY: it wins only when it
 * resolves to a real file (ingested face or real Google family), never when it
 * merely reaches a tone-based library substitution.
 *
 * REVERT MAP (which checks fail if each part is undone):
 *   (1) scannedPromoted tier removed / moved below the theme
 *       → P1/P2 (Pelagic loses Oswald)
 *   (2) theme-pairing guard dropped (unconditional promotion)
 *       → C1/C2 (Camelback collapses a sans/serif pairing to one serif)
 *   (3) requireExact honoured nowhere (exact-only tier accepts substitutions)
 *       → A1/A2 (AllBirds renders a library guess over real DM Sans)
 *   (4) curated-fontFamily tier promoted above the theme
 *       → X1 (an unservable operator family locks a lookalike)
 *   (5) quote ladder given the brand face
 *       → Q1/Q2 (a sans brand face replaces a curated serif quote voice)
 *   (6) ladder walk stops at the first tier instead of continuing
 *       → W1-W5 (walk semantics)
 *
 * No DB, no network, no API key. Safe in CI.
 *   node scripts/verifyFontLadder.js
 */

const assert = require('assert');

let pass = 0;
const failures = [];
const pending = [];
// Async checks are collected and awaited before the summary — a fire-and-forget
// assertion that resolves after the exit code is computed is not a test.
function check(label, fn) {
  let r;
  try { r = fn(); }
  catch (err) { failures.push(`${label}: ${err.message}`); return; }
  if (r && typeof r.then === 'function') {
    pending.push(r.then(() => { pass++; }, (err) => { failures.push(`${label}: ${err.message}`); }));
    return;
  }
  pass++;
}

const { buildFontLadders, resolveLadder } = require('../services/fontResolverService');

console.log('\nverifyFontLadder — per-role tier order + ladder walk semantics\n');

/** Live (family, requireExact) pairs for a role, in ladder order. */
function tiers(brand, role, opts) {
  return buildFontLadders(brand, opts).ladders[role].filter(([f]) => f);
}
/** Index of the first tier naming `family`, or -1. */
function idxOf(list, family) {
  return list.findIndex(([f]) => String(f).toLowerCase() === family.toLowerCase());
}

// ── P. PELAGIC — the reported regression. Scanned face outranks theme alias ──
// Fails if (1) is reverted.
const PELAGIC = {
  name: 'Pelagic',
  fontFamily: 'Oswald',
  curatedFields: ['styleTheme'],
  styleTheme: { sansFontFamily: 'Montserrat' },
};
check('P1 Pelagic heading: Oswald ranks ABOVE theme Montserrat', () => {
  const t = tiers(PELAGIC, 'heading');
  const oswald = idxOf(t, 'Oswald');
  const mont = idxOf(t, 'Montserrat');
  assert.ok(oswald >= 0, 'Oswald must appear in the heading ladder');
  assert.ok(mont >= 0, 'theme Montserrat must appear in the heading ladder');
  assert.ok(oswald < mont, `Oswald (${oswald}) must precede Montserrat (${mont})`);
});
check('P2 Pelagic scanned tier is EXACT-ONLY (a substitution cannot win it)', () => {
  const t = tiers(PELAGIC, 'heading');
  const entry = t[idxOf(t, 'Oswald')];
  assert.strictEqual(entry[1], true, 'scanned-promoted tier must carry requireExact=true');
});
check('P3 Pelagic body follows the same order', () => {
  const t = tiers(PELAGIC, 'body');
  assert.ok(idxOf(t, 'Oswald') < idxOf(t, 'Montserrat'), 'body ladder must promote Oswald too');
});

// ── C. CAMELBACK — theme already names the scanned face → it is a PAIRING ────
// Fails if (2) is reverted: unconditional promotion resolved heading, body AND
// quote to Lora and collapsed a deliberate sans/serif pairing into one serif.
const CAMELBACK = {
  name: 'Camelback',
  fontFamily: 'Lora',
  curatedFields: ['styleTheme'],
  styleTheme: { sansFontFamily: 'DM Sans', serifFontFamily: 'Lora' },
};
check('C1 Camelback heading keeps the curated sans (no Lora promotion)', () => {
  const t = tiers(CAMELBACK, 'heading');
  const dm = idxOf(t, 'DM Sans');
  const lora = idxOf(t, 'Lora');
  assert.ok(dm >= 0, 'DM Sans must be in the heading ladder');
  assert.ok(lora === -1 || dm < lora, `DM Sans (${dm}) must not be outranked by Lora (${lora})`);
});
check('C2 Camelback heading has NO exact-only promotion tier at all', () => {
  const t = tiers(CAMELBACK, 'heading');
  const promoted = t.filter(([, requireExact]) => requireExact === true);
  assert.strictEqual(promoted.length, 0,
    `theme already names the scanned face — expected no promotion, got ${JSON.stringify(promoted)}`);
});
check('C3 Camelback quote still reaches the curated serif', () => {
  const t = tiers(CAMELBACK, 'quote');
  assert.ok(idxOf(t, 'Lora') >= 0, 'quote ladder must offer the curated serif');
});

// ── A. ALLBIRDS — real face is licence-held, so the theme must win ───────────
// Fails if (3) is reverted. "Self Modern" is not a Google family and is not an
// ingested usable face here, so its exact-only tier must yield to DM Sans.
const ALLBIRDS = {
  name: 'AllBirds',
  fontFamily: 'Self Modern',
  curatedFields: ['styleTheme'],
  styleTheme: { sansFontFamily: 'DM Sans' },
  customFonts: [
    // Present but HELD: mergeFontEntries' human-hold shape (url + needsLicense).
    { family: 'Self Modern', weight: 400, style: 'normal', format: 'woff2',
      url: 'https://res.cloudinary.com/x/self-modern.woff2', license: 'commercial', needsLicense: true },
  ],
};
check('A1 AllBirds: held face is not treated as an owned (usable) face', () => {
  const t = tiers(ALLBIRDS, 'heading');
  // ownFace comes from matchCustomFont, which rejects needsLicense holds. The
  // family may still appear as the scanned-promoted tier, but exact-only.
  for (const [family, requireExact] of t) {
    if (String(family).toLowerCase() === 'self modern') {
      assert.strictEqual(requireExact, true, 'a held face must never enter as a substitutable tier');
    }
  }
});
check('A2 AllBirds: an unservable exact-only tier yields to the curated theme', async () => {
  const ladder = buildFontLadders(ALLBIRDS).ladders.heading;
  // Fake resolver: only DM Sans is servable exactly; Self Modern reaches a
  // library substitution (Playfair, per the Didone classification).
  const resolveOne = async (family) => {
    if (/^dm sans$/i.test(family)) return { family: 'DM Sans', source: 'google', exact: true };
    return { family: 'Playfair Display', source: 'library-match', exact: false };
  };
  const { entry } = await resolveLadder(ladder, resolveOne);
  assert.strictEqual(entry.family, 'DM Sans',
    `expected the servable curated theme to win, got ${entry.family} (${entry.source})`);
  assert.strictEqual(entry.exact, true);
});

// ── X. Curated fontFamily stays BELOW the theme ─────────────────────────────
// Fails if (4) is reverted. Shape that proved it: an operator-confirmed family
// we cannot serve must not lock a lookalike over a theme family we CAN serve.
check('X1 curated-but-unservable fontFamily does not outrank the curated theme', async () => {
  const brand = {
    name: 'CuratedUnservable',
    fontFamily: 'Self Modern',
    curatedFields: ['fontFamily', 'styleTheme'],
    styleTheme: { sansFontFamily: 'DM Sans' },
  };
  const ladder = buildFontLadders(brand).ladders.heading;
  const resolveOne = async (family) => {
    if (/^dm sans$/i.test(family)) return { family: 'DM Sans', source: 'google', exact: true };
    return { family: 'Playfair Display', source: 'library-match', exact: false };
  };
  const { entry } = await resolveLadder(ladder, resolveOne);
  assert.strictEqual(entry.family, 'DM Sans',
    `real DM Sans must beat a library lookalike, got ${entry.family}`);
});

// ── Q. Quote ladder is untouched by the brand-face promotion ────────────────
// Fails if (5) is reverted.
check('Q1 quote ladder carries no exact-only promotion tier', () => {
  for (const brand of [PELAGIC, CAMELBACK, ALLBIRDS]) {
    const t = tiers(brand, 'quote');
    const promoted = t.filter(([, requireExact]) => requireExact === true);
    assert.strictEqual(promoted.length, 0,
      `${brand.name} quote ladder must not promote a brand face: ${JSON.stringify(promoted)}`);
  }
});
check('Q2 Pelagic quote prefers the theme/shared voice over the scanned sans', () => {
  const t = tiers(PELAGIC, 'quote');
  assert.ok(t.length > 0, 'quote ladder must not be empty');
  assert.notStrictEqual(String(t[0][0]).toLowerCase(), 'oswald',
    'the scanned face must not lead the quote ladder');
});

// ── W. Ladder WALK semantics (pure, injected resolver) ──────────────────────
// Fails if (6) or (3) is reverted.
const EXACT = (family) => ({ family, source: 'google', exact: true });
const SUB = (family) => ({ family, source: 'library-match', exact: false });

check('W1 first exact candidate wins and stops the walk', async () => {
  const seen = [];
  const { entry } = await resolveLadder(
    [['A', false], ['B', false]],
    async (f) => { seen.push(f); return EXACT(f); }
  );
  assert.strictEqual(entry.family, 'A');
  assert.deepStrictEqual(seen, ['A'], 'must not resolve tiers after a winner');
});
check('W2 requireExact tier producing a substitution is SKIPPED', async () => {
  const { entry } = await resolveLadder(
    [['A', true], ['B', false]],
    async (f) => (f === 'A' ? SUB('Sub') : EXACT('B'))
  );
  assert.strictEqual(entry.family, 'B', `expected B to win, got ${entry.family}`);
});
check('W3 a substitutable tier ACCEPTS a substitution', async () => {
  const { entry } = await resolveLadder(
    [['A', false], ['B', false]],
    async (f) => (f === 'A' ? SUB('Sub') : EXACT('B'))
  );
  assert.strictEqual(entry.family, 'Sub', 'a non-exact tier must accept its substitution');
});
check('W4 nothing exact anywhere → the first remembered substitution', async () => {
  const { entry, firstInexact } = await resolveLadder(
    [['A', true], ['B', true]],
    async (f) => SUB(`Sub-${f}`)
  );
  assert.strictEqual(entry.family, 'Sub-A', `expected the first substitution, got ${entry.family}`);
  assert.strictEqual(firstInexact.family, 'Sub-A');
});
check('W5 unresolvable tiers are skipped; null when the whole ladder fails', async () => {
  const { entry } = await resolveLadder(
    [['A', false], ['B', false]],
    async () => null
  );
  assert.strictEqual(entry, null, 'a fully unresolvable ladder must yield null');
});
check('W6 a family named by two tiers costs ONE resolve (tried memo)', async () => {
  let calls = 0;
  const { entry } = await resolveLadder(
    [['Dup', true], ['Other', true], ['Dup', false]],
    async (f) => { calls++; return SUB(`Sub-${f}`); }
  );
  assert.strictEqual(calls, 2, `expected 2 resolves for 3 tiers (Dup memoised), got ${calls}`);
  // The repeated family is allowed to substitute at its lower tier.
  assert.strictEqual(entry.family, 'Sub-Dup');
});
check('W7 empty / non-family tiers never reach the resolver', async () => {
  const seen = [];
  await resolveLadder(
    [[null, false], [undefined, false], ['var(--font-sans)', false], ['inherit', false], ['Real', false]],
    async (f) => { seen.push(f); return EXACT(f); }
  );
  assert.deepStrictEqual(seen, ['Real'],
    `CSS plumbing must be filtered before resolution, saw ${JSON.stringify(seen)}`);
});

// ── D. Determinism — same brand in, same ladder out ─────────────────────────
check('D1 buildFontLadders is deterministic across 100 calls', () => {
  const first = JSON.stringify(buildFontLadders(PELAGIC).ladders);
  for (let i = 0; i < 100; i++) {
    assert.strictEqual(JSON.stringify(buildFontLadders(PELAGIC).ladders), first,
      `ladder changed on call ${i}`);
  }
});
check('D2 buildFontLadders does not mutate the brand', () => {
  const brand = JSON.parse(JSON.stringify(PELAGIC));
  const snapshot = JSON.stringify(brand);
  buildFontLadders(brand);
  assert.strictEqual(JSON.stringify(brand), snapshot, 'brand doc must not be mutated');
});

// ── O. Overrides still lead every ladder ───────────────────────────────────
check('O1 explicit overrides lead each role and are substitutable', () => {
  const opts = { overrides: { heading: { family: 'Anton' }, body: { family: 'Nunito' }, quote: { family: 'Prata' } } };
  for (const [role, family] of [['heading', 'Anton'], ['body', 'Nunito'], ['quote', 'Prata']]) {
    const t = tiers(PELAGIC, role, opts);
    assert.strictEqual(String(t[0][0]).toLowerCase(), family.toLowerCase(),
      `${role} ladder must lead with the override, got ${t[0][0]}`);
    assert.strictEqual(t[0][1], false, 'an explicit override must be allowed to substitute');
  }
});

// ── S. Source-level pin: the quiet flag exists on the rejected path ─────────
// A requireExact tier that gets rejected must not log "using closest library
// face X" for a font that never reached the render.
check('S1 resolveFamily accepts a `quiet` option and gates the substitution warn', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'fontResolverService.js'), 'utf8');
  assert.ok(/async function resolveFamily\([^)]*quiet\s*=\s*false/s.test(src),
    'resolveFamily must accept quiet');
  assert.ok(/if \(!quiet\) \{\s*console\.warn\(/.test(src),
    'the library-substitution warn must be gated behind !quiet');
  assert.ok(/quiet:\s*requireExact/.test(src),
    'resolveBrandFonts must pass quiet=requireExact so rejected tiers stay silent');
});

(async () => {
  await Promise.all(pending);
  console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
  if (failures.length) {
    for (const f of failures) console.error(`  ❌ ${f}`);
    process.exit(1);
  }
  console.log('  ✅ verifyFontLadder green\n');
})();
