#!/usr/bin/env node
'use strict';
/**
 * verifyIngestShotClassify — fences ingest-time packshot/lifestyle
 * classification (services/ingestShotClassifyService) and its hand-forward
 * onto Media at materialize / detect-fallback skip.
 *
 * WHY THIS EXISTS
 * The free sharp classifier used to run only inside a billable DetectRun.
 * Ingest is the right place, but a sync can be thousands of products × ≤13
 * images — unbounded HTTP GETs would extend already-long scans. This harness
 * pins: URL-keyed storage, idempotency, concurrency cap, wall-clock budget
 * with logged skips, failure degradation, flag-off, materialize copy without
 * re-sharp, resolveSeedStyle precedence, detect recompute skip, and the
 * ingest-local SSRF guard (post-DNS private-range block + connection pin +
 * redirect policy).
 *
 * Offline: no DB, no network, no API keys, no real DNS. Fetcher + DNS
 * lookup are stubbed; images are synthesized with sharp. The hung-DNS
 * test exercises real safeFetchBuffer + AbortSignal deadline.
 *
 *   node scripts/verifyIngestShotClassify.js
 *
 * Revert-prove (each independently — harness runs several via loadMutatedIngest):
 *   (a) mergeStyleEntries / storedStyleForUrl becomes index-based → A* fails
 *   (b) idempotency skip removed → B* fails
 *   (b1) seed-session-cache loop in classifyPendingProducts deleted → B5 fails
 *        (B1 alone stays green — it only exercises classifyUrls+existingEntries)
 *   (c) concurrency left unbounded → C* fails
 *   (d) budget skip silent / not counted → D* fails
 *   (d1) budget starts at createSession again → D_REGRESSION (Blocker 1) fails
 *   (e) fetch failure throws out of classifyUrls → E* fails
 *   (f) technicalInsightsFromStored removed from materializeImage → F* fails
 *   (f1) technicalInsightsFromStored drops numeric signals → F2b fails
 *   (g) resolveSeedStyle product form ignores LLM on media → G* fails
 *   (h) detect always recomputes → H* fails
 *   (i) post-DNS private-address check replaced with hostname string match
 *       → S_RESOLVES_PRIVATE fails (the check a naive implementation misses)
 *   (j) hung DNS with no timeout → K1 fails
 *   (k) connection not pinned (hostname re-resolve) → S_PIN fails
 *   (l) abandonPending removed → L* fails (Blocker 2)
 *   (m) cpu guard removed → M* fails (Blocker 3)
 *   (n) per-URL timer re-armed each redirect hop → J4 fails
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const http = require('http');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');

let pass = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(detail ? `${label}: ${detail}` : label);
}
function checkFn(label, fn) {
  try { fn(); pass++; }
  catch (err) { failures.push(`${label}: ${err.message}`); }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

async function solidPng(bg = { r: 255, g: 255, b: 255 }, size = 64) {
  return sharp({
    create: { width: size, height: size, channels: 3, background: bg }
  }).png().toBuffer();
}

// ── Load service under test ────────────────────────────────────────────────
const ingest = require('../services/ingestShotClassifyService');
const {
  resolveSeedStyle,
  classifyShotStyle
} = require('../services/imageShotHeuristicService');

// Offline DNS stub: every non-overridden hostname resolves to a public IP
// that is NOT in the block list. Harness never performs real DNS / network
// for the happy path. 8.8.8.8 is fine here — we never connect; only the
// address-class check runs (except the pin socket test which uses a local
// server + custom lookup returning 127.0.0.1 via the pin path after we
// bypass the block list for that one unit).
function publicLookupOk(_hostname) {
  return Promise.resolve([{ address: '8.8.8.8', family: 4 }]);
}

function lookupMap(map) {
  return async (hostname) => {
    if (Object.prototype.hasOwnProperty.call(map, hostname)) {
      const v = map[hostname];
      if (v instanceof Error) throw v;
      if (typeof v === 'string') return [{ address: v, family: v.includes(':') ? 6 : 4 }];
      return v;
    }
    return publicLookupOk(hostname);
  };
}

/**
 * Load a mutated COPY of ingestShotClassifyService from a temp path.
 * NEVER writes to the live service file (S10 regression).
 */
function loadMutatedIngest(mutateFn) {
  const svcPath = path.join(ROOT, 'services/ingestShotClassifyService.js');
  let src = fs.readFileSync(svcPath, 'utf8');
  // Rewrite relative requires so the temp module resolves the real deps.
  src = src
    .replace(
      "require('./concurrency')",
      `require(${JSON.stringify(path.join(ROOT, 'services/concurrency'))})`
    )
    .replace(
      "require('./imageShotHeuristicService')",
      `require(${JSON.stringify(path.join(ROOT, 'services/imageShotHeuristicService'))})`
    );
  src = mutateFn(src);
  const tmp = path.join(
    os.tmpdir(),
    `ingestShotClassify-harness-${process.pid}-${Date.now()}.js`
  );
  fs.writeFileSync(tmp, src);
  try {
    // Fresh load from temp — not the live services/ path.
    delete require.cache[require.resolve(tmp)];
    return { mod: require(tmp), tmp };
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

function unloadTmp(tmp) {
  try { delete require.cache[require.resolve(tmp)]; } catch { /* ignore */ }
  try { fs.unlinkSync(tmp); } catch { /* ignore */ }
}

async function main() {
  console.log('\nverifyIngestShotClassify\n');

  const whiteBuf = await solidPng({ r: 255, g: 255, b: 255 });
  // Sanity: real classify works on synthetic buffer (not under test here but
  // proves the double is optional).
  const realClass = await classifyShotStyle(whiteBuf);
  check('0 real classifyShotStyle returns shape on solid white',
    !!realClass && ['packshot', 'lifestyle', 'ambiguous'].includes(realClass.style));

  // ── A. URL-keyed storage / reorder safety ────────────────────────────────
  checkFn('A1 mergeStyleEntries is URL-keyed (reorder-safe)', () => {
    const existing = [
      { url: 'https://cdn.example/a.jpg', style: 'packshot', confidence: 0.9, at: new Date('2026-01-01') },
      { url: 'https://cdn.example/b.jpg', style: 'lifestyle', confidence: 0.8, at: new Date('2026-01-01') }
    ];
    // Simulate re-sync that reorders additionalImages: b first, a second,
    // plus a new c. Prior labels for a/b must survive by URL.
    const reorderedUrls = [
      'https://cdn.example/b.jpg',
      'https://cdn.example/a.jpg',
      'https://cdn.example/c.jpg'
    ];
    const fresh = [
      { url: 'https://cdn.example/c.jpg', style: 'ambiguous', confidence: 0.4, at: new Date() }
    ];
    const merged = ingest.mergeStyleEntries(existing, fresh, reorderedUrls);
    const byUrl = Object.fromEntries(merged.map((e) => [e.url, e.style]));
    assert.strictEqual(byUrl['https://cdn.example/a.jpg'], 'packshot');
    assert.strictEqual(byUrl['https://cdn.example/b.jpg'], 'lifestyle');
    assert.strictEqual(byUrl['https://cdn.example/c.jpg'], 'ambiguous');
    // Index 0 after reorder is b — if we keyed by index, a would be wrong.
    assert.strictEqual(
      ingest.storedStyleForUrl(merged, reorderedUrls[0]).style,
      'lifestyle'
    );
    assert.strictEqual(
      ingest.storedStyleForUrl(merged, reorderedUrls[1]).style,
      'packshot'
    );
  });

  checkFn('A1b mergeStyleEntries prunes URLs that left the product', () => {
    const existing = [
      { url: 'https://cdn.example/a.jpg', style: 'packshot', confidence: 0.9 },
      { url: 'https://cdn.example/old.jpg', style: 'lifestyle', confidence: 0.8 }
    ];
    const current = ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg'];
    const fresh = [
      { url: 'https://cdn.example/b.jpg', style: 'ambiguous', confidence: 0.4 }
    ];
    const merged = ingest.mergeStyleEntries(existing, fresh, current);
    assert.strictEqual(merged.length, 2);
    assert.ok(merged.every((e) => e.url !== 'https://cdn.example/old.jpg'));
    assert.strictEqual(
      ingest.storedStyleForUrl(merged, 'https://cdn.example/a.jpg').style,
      'packshot'
    );
  });

  checkFn('A2 CatalogProduct schema declares imageShotStyles with url field', () => {
    const src = read('models/CatalogProduct.js');
    assert.ok(/imageShotStyles\s*:/.test(src), 'imageShotStyles missing');
    assert.ok(/url\s*:\s*\{\s*type:\s*String/.test(src), 'url field missing');
    assert.ok(/packshot/.test(src) && /lifestyle/.test(src) && /ambiguous/.test(src));
  });

  // ── B. Idempotency — already-classified URL not re-fetched ───────────────
  {
    let fetchCalls = 0;
    const session = ingest.createSession({
      lookup: publicLookupOk,
      fetchBuffer: async () => {
        fetchCalls++;
        return { ok: true, buffer: whiteBuf, tooLarge: false };
      },
      classifyShotStyle: async () => ({ style: 'packshot', confidence: 0.95, metrics: {} }),
      concurrency: 2,
      budgetMs: 60_000
    });
    const existing = [
      { url: 'https://cdn.example/known.jpg', style: 'lifestyle', confidence: 0.7, at: new Date() }
    ];
    const r = await session.classifyUrls(
      ['https://cdn.example/known.jpg', 'https://cdn.example/new.jpg'],
      existing
    );
    check('B1 already-classified URL not re-fetched',
      fetchCalls === 1,
      `fetchCalls=${fetchCalls} expected 1 (only new.jpg)`);
    check('B2 skippedExisting counted',
      r.stats.skippedExisting === 1 && session.getTotals().skippedExisting === 1);
    check('B3 known style preserved in merged entries',
      ingest.storedStyleForUrl(r.entries, 'https://cdn.example/known.jpg')?.style === 'lifestyle');
    check('B4 new URL classified',
      ingest.storedStyleForUrl(r.entries, 'https://cdn.example/new.jpg')?.style === 'packshot');
    session.dispose();
  }

  // ── B5. BATCH entry point idempotency (classifyPendingProducts seed loop) ─
  // Production re-sync uses classifyPendingProducts → classifyUrls(allUrls, [])
  // and depends on the existingStyles → sessionUrlCache seed loop. B1 only
  // exercises classifyUrls WITH existingEntries, so deleting the seed loop
  // keeps B1 green while every re-sync re-downloads every image.
  {
    let fetchCalls = 0;
    const mkSession = () => ingest.createSession({
      lookup: publicLookupOk,
      fetchBuffer: async () => {
        fetchCalls++;
        return { ok: true, buffer: whiteBuf, tooLarge: false };
      },
      classifyShotStyle: async () => ({
        style: 'packshot',
        confidence: 0.9,
        metrics: { borderStdev: 2.1, packshotScore: 0.88 }
      }),
      concurrency: 2,
      budgetMs: 60_000
    });

    const products = [
      {
        productId: 'p1',
        imageUrl: 'https://cdn.example/resync-a.jpg',
        additionalImages: ['https://cdn.example/resync-b.jpg'],
        existingStyles: []
      },
      {
        productId: 'p2',
        imageUrl: 'https://cdn.example/resync-c.jpg',
        additionalImages: [],
        existingStyles: []
      }
    ];

    // Pass 1 — cold: every URL must be fetched.
    const s1 = mkSession();
    s1.beginClassifyPhase();
    const pass1 = await s1.classifyPendingProducts(products);
    const pass1Fetches = fetchCalls;
    check('B5a cold classifyPendingProducts fetches each unique URL',
      pass1Fetches === 3 && pass1.results.length === 2,
      `fetchCalls=${pass1Fetches}`);
    // Collect what a real writer would persist (imageShotStyles).
    const storedByProduct = pass1.results.map((r) => ({
      productId: r.item.productId,
      imageUrl: r.item.imageUrl,
      additionalImages: r.item.additionalImages,
      existingStyles: r.entries
    }));
    s1.dispose();

    // Pass 2 — re-sync: NEW session, same products with stored styles.
    // Seed loop must populate session cache so classifyUrls(allUrls, [])
    // performs ZERO fetches.
    fetchCalls = 0;
    const s2 = mkSession();
    s2.beginClassifyPhase();
    const pass2 = await s2.classifyPendingProducts(storedByProduct);
    const pass2Fetches = fetchCalls;
    const pass2Totals = s2.getTotals();
    check('B5b re-sync classifyPendingProducts performs ZERO fetches',
      pass2Fetches === 0,
      `fetchCalls=${pass2Fetches} totals=${JSON.stringify(pass2Totals)}`);
    check('B5c re-sync preserves styles via session-cache seed (not existingEntries)',
      pass2.results.every((r) =>
        (r.entries || []).length >= 1 &&
        r.entries.every((e) => e && e.style === 'packshot')
      ),
      JSON.stringify(pass2.results.map((r) => r.entries)));
    s2.dispose();

    // REVERT-PROVE: delete the seed loop → B5b must fail (re-downloads).
    {
      let tmpPath = null;
      try {
        const seedNeedle =
          'for (const item of list) {\n' +
          '      const existing = Array.isArray(item.existingStyles) ? item.existingStyles : [];\n' +
          '      for (const e of existing) {\n' +
          '        if (e && e.url && e.style && !sessionUrlCache.has(e.url)) {\n' +
          '          sessionUrlCache.set(e.url, e);\n' +
          '        }\n' +
          '      }\n' +
          '    }';
        const { mod: mutated, tmp } = loadMutatedIngest((src) => {
          assert.ok(src.includes(seedNeedle), 'seed loop needle missing');
          return src.replace(seedNeedle, '/* REVERTED: seed loop removed */');
        });
        tmpPath = tmp;
        let mFetch = 0;
        const ms = mutated.createSession({
          lookup: publicLookupOk,
          fetchBuffer: async () => {
            mFetch++;
            return { ok: true, buffer: whiteBuf, tooLarge: false };
          },
          classifyShotStyle: async () => ({ style: 'packshot', confidence: 0.9, metrics: {} }),
          concurrency: 2,
          budgetMs: 60_000
        });
        ms.beginClassifyPhase();
        await ms.classifyPendingProducts(storedByProduct);
        ms.dispose();
        check('B5d REVERT-PROVE: without seed loop, re-sync re-fetches (B5b would fail)',
          mFetch > 0,
          `mutatedFetchCalls=${mFetch} (expected >0 when seed loop deleted)`);
      } catch (e) {
        check('B5d REVERT-PROVE: without seed loop, re-sync re-fetches (B5b would fail)',
          false, e.message);
      } finally {
        if (tmpPath) unloadTmp(tmpPath);
      }
    }
  }

  // ── C. Concurrency cap ───────────────────────────────────────────────────
  {
    let inFlight = 0;
    let maxInFlight = 0;
    const CAP = 3;
    const session = ingest.createSession({
      lookup: publicLookupOk,
      concurrency: CAP,
      budgetMs: 60_000,
      fetchBuffer: async () => {
        inFlight++;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        await new Promise((r) => setTimeout(r, 40));
        inFlight--;
        return { ok: true, buffer: whiteBuf, tooLarge: false };
      },
      classifyShotStyle: async () => ({ style: 'packshot', confidence: 1, metrics: {} })
    });
    const urls = Array.from({ length: 12 }, (_, i) => `https://cdn.example/c${i}.jpg`);
    await session.classifyUrls(urls, []);
    check('C1 max in-flight ≤ concurrency cap',
      maxInFlight <= CAP && session.getTotals().maxInFlight <= CAP,
      `maxInFlight=${maxInFlight} totals.max=${session.getTotals().maxInFlight} cap=${CAP}`);
    check('C2 all URLs classified under cap',
      session.getTotals().classified === 12,
      `classified=${session.getTotals().classified}`);
    session.dispose();
  }

  // ── D. Wall-clock budget stops work AND reports skip count ───────────────
  {
    let t = 0;
    const session = ingest.createSession({
      lookup: publicLookupOk,
      concurrency: 2,
      budgetMs: 100,
      now: () => t,
      fetchBuffer: async () => {
        t += 60; // each fetch burns 60ms of budget
        return { ok: true, buffer: whiteBuf, tooLarge: false };
      },
      classifyShotStyle: async () => ({ style: 'packshot', confidence: 1, metrics: {} })
    });
    // Explicit phase start (writers do this before the post-loop pass).
    session.beginClassifyPhase();
    const urls = Array.from({ length: 20 }, (_, i) => `https://cdn.example/d${i}.jpg`);
    const r = await session.classifyUrls(urls, []);
    const totals = session.getTotals();
    check('D1 budget exhaustion stops some work',
      totals.skippedBudget > 0 && totals.classified < 20,
      `classified=${totals.classified} skippedBudget=${totals.skippedBudget}`);
    check('D2 skip count is explicit on call stats',
      r.stats.skippedBudget === totals.skippedBudget && totals.skippedBudget > 0);
    check('D3 budgetExhausted flag set on session',
      totals.budgetExhausted === true);
    // logSummary must mention the skip (no silent caps)
    const logs = [];
    const orig = console.log;
    console.log = (...a) => logs.push(a.join(' '));
    try { session.logSummary('test-budget'); }
    finally { console.log = orig; }
    check('D4 logSummary reports skipBudget count',
      logs.some((l) => /skipBudget=\d+/.test(l) && !/skipBudget=0/.test(l)),
      `logs=${JSON.stringify(logs)}`);
    check('D5 logSummary names deferred fallback',
      logs.some((l) => /deferred to detect-time|BUDGET_EXHAUSTED/.test(l)));
    session.dispose();
  }

  // ── D_REGRESSION (Blocker 1) — MOST IMPORTANT TEST ───────────────────────
  // Graph/upsert work burns wall clock BETWEEN createSession and the
  // classify pass. Budget must start at beginClassifyPhase, not createSession.
  // If the clock is moved back to createSession, this test FAILS (classified=0).
  {
    let t = 0;
    const session = ingest.createSession({
      lookup: publicLookupOk,
      concurrency: 2,
      budgetMs: 1_000,
      now: () => t,
      fetchBuffer: async () => {
        t += 10;
        return { ok: true, buffer: whiteBuf, tooLarge: false };
      },
      classifyShotStyle: async () => ({ style: 'packshot', confidence: 1, metrics: {} })
    });
    // Simulate minutes of Meta Graph pagination + upsert BEFORE classify.
    t = 5 * 60 * 1000; // 5 minutes of pre-classify work
    check('D_REGRESSION_0 phase not started at createSession',
      session.hasClassifyPhaseStarted() === false);
    // Start budget NOW — the real writers' contract.
    session.beginClassifyPhase();
    check('D_REGRESSION_1 beginClassifyPhase arms the clock',
      session.hasClassifyPhaseStarted() === true);
    const urls = Array.from({ length: 8 }, (_, i) => `https://cdn.example/dreg${i}.jpg`);
    const r = await session.classifyUrls(urls, []);
    const totals = session.getTotals();
    check('D_REGRESSION_2 pre-phase clock burn does NOT exhaust budget',
      totals.classified === 8 && totals.skippedBudget === 0,
      `classified=${totals.classified} skippedBudget=${totals.skippedBudget} ` +
      `budgetExhausted=${totals.budgetExhausted} considered=${totals.considered}`);
    check('D_REGRESSION_3 all URLs present in entries',
      r.entries.length === 8);
    session.dispose();
  }

  // ── L. Abandoned pending (Blocker 2) ─────────────────────────────────────
  {
    const session = ingest.createSession({
      lookup: publicLookupOk,
      budgetMs: 60_000,
      fetchBuffer: async () => ({ ok: true, buffer: whiteBuf, tooLarge: false }),
      classifyShotStyle: async () => ({ style: 'packshot', confidence: 1, metrics: {} })
    });
    const pending = [
      {
        productId: 'p1',
        imageUrl: 'https://cdn.example/a.jpg',
        additionalImages: ['https://cdn.example/b.jpg'],
        existingStyles: []
      },
      {
        productId: 'p2',
        imageUrl: 'https://cdn.example/c.jpg',
        additionalImages: [],
        // c already classified — should NOT count as abandoned attempt
        existingStyles: [
          { url: 'https://cdn.example/c.jpg', style: 'lifestyle', confidence: 0.5 }
        ]
      }
    ];
    // Phase never started (fatal early-return / cancel path).
    const n = session.abandonPending(pending, 'meta_fatal');
    const t = session.getTotals();
    check('L1 abandonPending counts outstanding image URLs',
      n === 2 && t.skippedAbandoned === 2,
      `n=${n} abandoned=${t.skippedAbandoned}`);
    check('L2 already-stored URL not counted as abandoned',
      t.skippedAbandoned === 2); // c excluded
    check('L3 abandonReason recorded',
      t.abandonReason === 'meta_fatal');
    check('L4 considered stays 0 (never attempted ≠ nothing to do)',
      t.considered === 0 && t.classified === 0);
    const logs = [];
    const orig = console.log;
    console.log = (...a) => logs.push(a.join(' '));
    try { session.logSummary('test-abandon'); }
    finally { console.log = orig; }
    check('L5 logSummary reports abandoned count and reason',
      logs.some((l) => /abandoned=2/.test(l) && /meta_fatal/.test(l)),
      `logs=${JSON.stringify(logs)}`);
    check('L6 logSummary distinguishes never-attempted',
      logs.some((l) => /never attempted|classify phase skipped/i.test(l)));
    // After phase starts, abandonPending still counts REMAINING items
    // (mid-phase cancel). Already-counted abandoned is additive.
    session.beginClassifyPhase();
    const remaining = [
      {
        productId: 'p3',
        imageUrl: 'https://cdn.example/new1.jpg',
        additionalImages: ['https://cdn.example/new2.jpg'],
        existingStyles: []
      }
    ];
    const n2 = session.abandonPending(remaining, 'cancelled');
    check('L7 abandonPending mid-phase counts remaining (cancel path)',
      n2 === 2 && session.getTotals().skippedAbandoned === 4 &&
      session.getTotals().abandonReason === 'cancelled',
      `n2=${n2} abandoned=${session.getTotals().skippedAbandoned} reason=${session.getTotals().abandonReason}`);
    session.dispose();
  }

  // ── M. CPU / decode wall-clock guard (Blocker 3) ─────────────────────────
  {
    const session = ingest.createSession({
      lookup: publicLookupOk,
      concurrency: 1,
      budgetMs: 60_000,
      cpuMs: 50,
      // Skip metadata precheck path so we exercise the race only.
      maxDecodePixels: 0,
      maxAnimatedPages: 0,
      fetchBuffer: async () => ({ ok: true, buffer: whiteBuf, tooLarge: false }),
      classifyShotStyle: async () => {
        // Hang longer than cpuMs — Promise.race must free the slot.
        await new Promise((r) => setTimeout(r, 500));
        return { style: 'packshot', confidence: 1, metrics: {} };
      }
    });
    session.beginClassifyPhase();
    const t0 = Date.now();
    let threw = false;
    let r;
    try {
      r = await session.classifyUrls(['https://cdn.example/slow.jpg'], []);
    } catch (e) {
      threw = true;
    }
    const elapsed = Date.now() - t0;
    const t = session.getTotals();
    check('M1 hung classifyShotStyle does not throw', !threw);
    check('M2 CPU guard frees slot well under hang duration',
      elapsed < 300,
      `elapsed=${elapsed}ms`);
    check('M3 CPU timeout counted; URL unclassified',
      t.cpuTimedOut >= 1 &&
      !ingest.storedStyleForUrl(r.entries, 'https://cdn.example/slow.jpg'),
      JSON.stringify({ cpuTimedOut: t.cpuTimedOut, entries: r && r.entries }));
    check('M3b cpuTimedOut does NOT also increment failed (no double-count)',
      t.cpuTimedOut >= 1 && t.failed === 0,
      JSON.stringify({ cpuTimedOut: t.cpuTimedOut, failed: t.failed }));
    check('M4 logSummary reports cpuTimeout', (() => {
      const logs = [];
      const orig = console.log;
      console.log = (...a) => logs.push(a.join(' '));
      try { session.logSummary('test-cpu'); }
      finally { console.log = orig; }
      return logs.some((l) => /cpuTimeout=\d+/.test(l) && !/cpuTimeout=0/.test(l));
    })());
    session.dispose();
  }
  // Optional metadata pre-check rejects huge/animated without full classify.
  {
    let classifyCalls = 0;
    const session = ingest.createSession({
      lookup: publicLookupOk,
      budgetMs: 60_000,
      cpuMs: 5_000,
      maxDecodePixels: 1_000, // tiny
      maxAnimatedPages: 2,
      metadataFn: async () => ({ width: 4000, height: 4000, pages: 1 }),
      fetchBuffer: async () => ({ ok: true, buffer: whiteBuf, tooLarge: false }),
      classifyShotStyle: async () => {
        classifyCalls++;
        return { style: 'packshot', confidence: 1, metrics: {} };
      }
    });
    session.beginClassifyPhase();
    await session.classifyUrls(['https://cdn.example/huge.jpg'], []);
    check('M5 metadata pre-check rejects oversize without classifyShotStyle',
      classifyCalls === 0 && session.getTotals().classified === 0);
    session.dispose();
  }
  // M6: hung metadata() is inside the CPU guard (was unbounded).
  {
    const session = ingest.createSession({
      lookup: publicLookupOk,
      concurrency: 1,
      budgetMs: 60_000,
      cpuMs: 50,
      maxDecodePixels: 1_000_000,
      maxAnimatedPages: 24,
      metadataFn: async () => {
        await new Promise((r) => setTimeout(r, 500));
        return { width: 100, height: 100, pages: 1 };
      },
      fetchBuffer: async () => ({ ok: true, buffer: whiteBuf, tooLarge: false }),
      classifyShotStyle: async () => ({ style: 'packshot', confidence: 1, metrics: {} })
    });
    session.beginClassifyPhase();
    const t0 = Date.now();
    await session.classifyUrls(['https://cdn.example/meta-hang.jpg'], []);
    const elapsed = Date.now() - t0;
    const t = session.getTotals();
    check('M6 hung metadata() freed by CPU guard (not unbounded)',
      elapsed < 300 && t.cpuTimedOut >= 1,
      `elapsed=${elapsed} cpuTimedOut=${t.cpuTimedOut}`);
    session.dispose();
  }

  // ── E. Failure degradation — never throws, never blocks ──────────────────
  {
    const session = ingest.createSession({
      lookup: publicLookupOk,
      concurrency: 2,
      budgetMs: 60_000,
      fetchBuffer: async (url) => {
        if (url.includes('fail')) throw new Error('network down');
        if (url.includes('timeout')) {
          const err = new Error('The operation was aborted due to timeout');
          throw err;
        }
        if (url.includes('huge')) return { ok: false, buffer: null, tooLarge: true };
        if (url.includes('empty')) return { ok: false, buffer: null, tooLarge: false };
        return { ok: true, buffer: whiteBuf, tooLarge: false };
      },
      classifyShotStyle: async (buf) => {
        if (!buf) throw new Error('should not reach');
        return { style: 'packshot', confidence: 1, metrics: {} };
      }
    });
    let threw = false;
    let r;
    try {
      r = await session.classifyUrls([
        'https://cdn.example/fail.jpg',
        'https://cdn.example/timeout.jpg',
        'https://cdn.example/huge.jpg',
        'https://cdn.example/empty.jpg',
        'https://cdn.example/ok.jpg'
      ], []);
    } catch (e) {
      threw = true;
    }
    check('E1 fetch/classify failures do not throw from classifyUrls', !threw);
    check('E2 ok URL still classified',
      r && ingest.storedStyleForUrl(r.entries, 'https://cdn.example/ok.jpg')?.style === 'packshot');
    const t = session.getTotals();
    check('E3 fetchFailed / timedOut / tooLarge tallied',
      t.fetchFailed >= 1 && t.timedOut >= 1 && t.tooLarge >= 1,
      JSON.stringify({ fetchFailed: t.fetchFailed, timedOut: t.timedOut, tooLarge: t.tooLarge }));
    check('E4 failures leave entries without those URLs (unclassified)',
      !ingest.storedStyleForUrl(r.entries, 'https://cdn.example/fail.jpg') &&
      !ingest.storedStyleForUrl(r.entries, 'https://cdn.example/huge.jpg'));
    session.dispose();
  }

  // ── E5. Flag off → no fetches ────────────────────────────────────────────
  {
    const prev = process.env.CATALOG_INGEST_SHOT_CLASSIFY_ENABLED;
    process.env.CATALOG_INGEST_SHOT_CLASSIFY_ENABLED = 'false';
    let fetchCalls = 0;
    try {
      const session = ingest.createSession({
        lookup: publicLookupOk,
        fetchBuffer: async () => { fetchCalls++; return { ok: true, buffer: whiteBuf }; },
        classifyShotStyle: async () => ({ style: 'packshot', confidence: 1, metrics: {} })
      });
      const r = await session.classifyUrls(['https://cdn.example/x.jpg'], []);
      check('E5 flag off → zero fetches', fetchCalls === 0);
      check('E6 flag off → unchanged entries / not changed',
        r.changed === false && r.entries.length === 0);
      check('E7 isEnabled() false on explicit "false"',
        ingest.isEnabled() === false);
      session.dispose();
    } finally {
      if (prev === undefined) delete process.env.CATALOG_INGEST_SHOT_CLASSIFY_ENABLED;
      else process.env.CATALOG_INGEST_SHOT_CLASSIFY_ENABLED = prev;
    }
  }

  // ── F. materializeImage hand-forward — EXECUTE real function (stub Mongo) ─
  {
    // Pure helper — real execution (legacy entry without metrics still works)
    const entry = { url: 'https://cdn.example/h.jpg', style: 'lifestyle', confidence: 0.77, at: new Date('2026-08-01') };
    const ti = ingest.technicalInsightsFromStored(entry);
    check('F1 technicalInsightsFromStored maps style+confidence',
      ti && ti.shotStyle === 'lifestyle' && ti.shotStyleConfidence === 0.77);
    check('F2 metrics.source is ingest + provenance at',
      ti.shotStyleMetrics &&
      ti.shotStyleMetrics.source === 'ingest' &&
      typeof ti.shotStyleMetrics.at === 'string');

    // F2b: when the CatalogProduct entry carries classifyShotStyle signals,
    // they must land on Media.technicalInsights.shotStyleMetrics (calibration
    // data). Provenance-only lean markers starve calibrateShotHeuristic.
    {
      const rich = {
        url: 'https://cdn.example/h.jpg',
        style: 'packshot',
        confidence: 0.91,
        at: new Date('2026-08-01T00:00:00.000Z'),
        metrics: {
          borderMean: 240.5,
          borderStdev: 3.2,
          packshotScore: 0.87,
          entropyAvailable: true,
          // Buffer must be stripped (bounded payload).
          _buf: Buffer.from('nope')
        }
      };
      const tiRich = ingest.technicalInsightsFromStored(rich);
      check('F2b stored metrics contain numeric signals + source (not provenance-only)',
        !!tiRich &&
        tiRich.shotStyleMetrics &&
        tiRich.shotStyleMetrics.source === 'ingest' &&
        tiRich.shotStyleMetrics.borderStdev === 3.2 &&
        tiRich.shotStyleMetrics.packshotScore === 0.87 &&
        tiRich.shotStyleMetrics.borderMean === 240.5 &&
        tiRich.shotStyleMetrics.entropyAvailable === true &&
        tiRich.shotStyleMetrics._buf === undefined,
        JSON.stringify(tiRich && tiRich.shotStyleMetrics));
    }

    // F2c: classifyOne (via session) persists metrics on the entry, and the
    // hand-forward carries them — end-to-end success path, no second sharp.
    {
      let fetchCalls = 0;
      const session = ingest.createSession({
        lookup: publicLookupOk,
        fetchBuffer: async () => {
          fetchCalls++;
          return { ok: true, buffer: whiteBuf, tooLarge: false };
        },
        // Real-shaped metrics (what classifyShotStyle returns).
        classifyShotStyle: async () => ({
          style: 'packshot',
          confidence: 0.93,
          metrics: {
            borderMean: 250,
            borderStdev: 1.5,
            centreMean: 80,
            centreStdev: 40,
            centreBorderRatio: 26.6,
            entropy: 4.2,
            entropyAvailable: true,
            borderUniform: 0.95,
            entropyPack: 0.8,
            ratioPack: 1,
            packshotScore: 0.92,
            brightBoostApplied: true,
            workWidth: 64,
            workHeight: 64,
            borderPx: 3,
            borderSampleCount: 100,
            centreSampleCount: 200
          }
        }),
        concurrency: 1,
        budgetMs: 60_000
      });
      session.beginClassifyPhase();
      const r = await session.classifyUrls(['https://cdn.example/metrics.jpg'], []);
      const stored = ingest.storedStyleForUrl(r.entries, 'https://cdn.example/metrics.jpg');
      check('F2c classifyUrls entry carries lean numeric metrics',
        !!stored &&
        stored.metrics &&
        stored.metrics.packshotScore === 0.92 &&
        stored.metrics.borderStdev === 1.5 &&
        !Buffer.isBuffer(stored.metrics),
        JSON.stringify(stored));
      const tiFromEntry = ingest.technicalInsightsFromStored(stored);
      check('F2d technicalInsightsFromStored preserves signals for Media',
        !!tiFromEntry &&
        tiFromEntry.shotStyleMetrics.packshotScore === 0.92 &&
        tiFromEntry.shotStyleMetrics.source === 'ingest' &&
        typeof tiFromEntry.shotStyleMetrics.at === 'string',
        JSON.stringify(tiFromEntry && tiFromEntry.shotStyleMetrics));
      session.dispose();
    }

    // Schema declares metrics on imageShotStyles (silent-drop trap).
    {
      const cpSrc = read('models/CatalogProduct.js');
      const block = cpSrc.match(/imageShotStyles:\s*\[\{([\s\S]*?)\}\]/);
      check('F2e CatalogProduct.imageShotStyles declares metrics field',
        !!block && /metrics\s*:/.test(block[1]));
    }

    const detectSrc = read('services/catalogProductDetectService.js');
    check('F3b materializeImage imports storedStyleForUrl + technicalInsightsFromStored',
      /storedStyleForUrl/.test(detectSrc) && /technicalInsightsFromStored/.test(detectSrc));
    check('F5b catalogProductDetectService source does not reference classifyShotStyle',
      !/classifyShotStyle/.test(detectSrc));

    // Media schema paths declared
    const mediaSrc = read('models/Media.js');
    const tiBlock = mediaSrc.match(/technicalInsights:\s*\{([\s\S]*?)\n\s*\},/);
    check('F6 Media.technicalInsights declares shotStyle fields',
      tiBlock && /shotStyle\s*:/.test(tiBlock[1]) && /shotStyleConfidence\s*:/.test(tiBlock[1]));

    // EXECUTE materializeImage with stubbed Mongo + Cloudinary. Deleting
    // `if (storedShot) doc.technicalInsights = storedShot` must fail F3/F5.
    const Media = require('../models/Media');
    const cloudinaryService = require('../services/cloudinaryService');
    const heuristic = require('../services/imageShotHeuristicService');
    const detectSvc = require('../services/catalogProductDetectService');

    const origFindOne = Media.findOne;
    const origCreate = Media.create;
    const origUpdateOne = Media.updateOne;
    const origUpload = cloudinaryService.uploadUrlToCloudinary;
    const origClassify = heuristic.classifyShotStyle;

    let classifyCalls = 0;
    let createdDoc = null;
    Media.findOne = async () => null; // force create path
    Media.create = async (doc) => {
      createdDoc = {
        _id: '00000000000000000000f001',
        ...doc,
        technicalInsights: doc.technicalInsights
          ? { ...doc.technicalInsights }
          : undefined
      };
      return createdDoc;
    };
    Media.updateOne = async () => ({ acknowledged: true });
    cloudinaryService.uploadUrlToCloudinary = async () => ({
      secure_url: 'https://res.cloudinary.com/demo/image/upload/x.jpg',
      width: 100,
      height: 100
    });
    heuristic.classifyShotStyle = async (...args) => {
      classifyCalls++;
      return origClassify.apply(heuristic, args);
    };

    try {
      const product = {
        _id: '00000000000000000000p001',
        brandId: '00000000000000000000b001',
        advertiserId: '00000000000000000000a001',
        brand: 'TestBrand',
        category: null,
        title: 'Test Shoe',
        imageShotStyles: [
          {
            url: 'https://cdn.example/h.jpg',
            style: 'lifestyle',
            confidence: 0.77,
            at: new Date('2026-08-01T00:00:00.000Z')
          }
        ]
      };
      const media = await detectSvc.materializeImage({
        sourceUrl: 'https://cdn.example/h.jpg',
        product,
        imageRole: 'hero',
        feedIndex: 0
      });
      // F3: real create-path doc must carry shotStyle from product.
      // Soft-read technicalInsights so a missing hand-forward fails these
      // checks (not an uncaught TypeError that aborts the harness).
      const tiOut = media && media.technicalInsights;
      check('F3 materializeImage create path stamps technicalInsights.shotStyle',
        !!media && !!tiOut && tiOut.shotStyle === 'lifestyle',
        JSON.stringify(tiOut));
      check('F4 materializeImage create path stamps confidence',
        !!tiOut && tiOut.shotStyleConfidence === 0.77,
        JSON.stringify(tiOut));
      check('F5 materializeImage create path source=ingest marker',
        !!tiOut && tiOut.shotStyleMetrics && tiOut.shotStyleMetrics.source === 'ingest',
        JSON.stringify(tiOut));
      // F7: spy is WIRED into imageShotHeuristicService — must stay 0.
      // (Previously a tautology: void spyClassify never invoked anything.)
      check('F7 hand-forward does not invoke classifyShotStyle',
        classifyCalls === 0 && !!tiOut && tiOut.shotStyle === 'lifestyle',
        `classifyCalls=${classifyCalls} ti=${JSON.stringify(tiOut)}`);

      // F8 E11000 race path — EXECUTE (not regex). Create throws 11000,
      // re-find returns doc without shotStyle, backfill must apply.
      {
        let findCalls = 0;
        const racedDoc = {
          _id: '00000000000000000000f008',
          brandId: product.brandId,
          source: 'catalog-product',
          externalId: 'cp_race',
          technicalInsights: {},
          metadata: {}
        };
        Media.findOne = async () => {
          findCalls++;
          // First call: no existing → take create path. After E11000: return raced.
          return findCalls === 1 ? null : racedDoc;
        };
        Media.create = async () => {
          const err = new Error('E11000 duplicate key');
          err.code = 11000;
          throw err;
        };
        let racePatched = null;
        Media.updateOne = async (_q, upd) => {
          racePatched = upd.$set;
          Object.assign(racedDoc.technicalInsights, {
            shotStyle: upd.$set['technicalInsights.shotStyle'],
            shotStyleConfidence: upd.$set['technicalInsights.shotStyleConfidence'],
            shotStyleMetrics: upd.$set['technicalInsights.shotStyleMetrics'],
            updatedAt: upd.$set['technicalInsights.updatedAt']
          });
          return { acknowledged: true };
        };
        const raced = await detectSvc.materializeImage({
          sourceUrl: 'https://cdn.example/h.jpg',
          product,
          imageRole: 'hero',
          feedIndex: 0
        });
        check('F8 E11000 race path EXECUTES storedShot backfill',
          !!raced &&
          racePatched &&
          racePatched['technicalInsights.shotStyle'] === 'lifestyle' &&
          raced.technicalInsights.shotStyle === 'lifestyle',
          JSON.stringify({ racePatched, ti: raced && raced.technicalInsights, findCalls }));
      }

      // Existing-doc first-write backfill (no shotStyle yet → apply)
      const bareDoc = {
        _id: '00000000000000000000f002',
        brandId: product.brandId,
        source: 'catalog-product',
        externalId: 'x',
        technicalInsights: {},
        metadata: {}
      };
      Media.findOne = async () => bareDoc;
      let patched = null;
      Media.updateOne = async (_q, upd) => {
        patched = upd.$set;
        return { acknowledged: true };
      };
      Media.create = origCreate;
      const refreshed = await detectSvc.materializeImage({
        sourceUrl: 'https://cdn.example/h.jpg',
        product,
        imageRole: 'hero',
        feedIndex: 0
      });
      check('F9 existing Media without shotStyle gets first-write backfill',
        patched &&
        patched['technicalInsights.shotStyle'] === 'lifestyle' &&
        refreshed.technicalInsights.shotStyle === 'lifestyle',
        JSON.stringify(patched));

      // Media that already has shotStyle must NOT thrash (first-write only).
      bareDoc.technicalInsights = ingest.technicalInsightsFromStored({
        url: 'https://cdn.example/h.jpg',
        style: 'packshot',
        confidence: 0.9,
        at: new Date('2026-01-01T00:00:00.000Z')
      });
      patched = null;
      await detectSvc.materializeImage({
        sourceUrl: 'https://cdn.example/h.jpg',
        product,
        imageRole: 'hero',
        feedIndex: 0
      });
      check('F10 existing Media shotStyle is not overwritten (first-write only)',
        patched == null || patched['technicalInsights.shotStyle'] == null,
        JSON.stringify(patched));

      // shouldApplyStoredShot pure contract — first-write only (retune deleted)
      checkFn('F11 shouldApplyStoredShot first-write only (no dead retune branch)', () => {
        assert.strictEqual(
          ingest.shouldApplyStoredShot(null, ti),
          true
        );
        assert.strictEqual(
          ingest.shouldApplyStoredShot({}, ti),
          true
        );
        assert.strictEqual(
          ingest.shouldApplyStoredShot({ shotStyle: 'packshot' }, ti),
          false
        );
        const older = ingest.technicalInsightsFromStored({
          url: 'u', style: 'packshot', confidence: 0.5, at: new Date('2020-01-01')
        });
        const newer = ingest.technicalInsightsFromStored({
          url: 'u', style: 'lifestyle', confidence: 0.9, at: new Date('2026-08-01')
        });
        // Even when product stamp is newer, do not thrash Media.
        assert.strictEqual(ingest.shouldApplyStoredShot(older, newer), false);
      });
    } finally {
      Media.findOne = origFindOne;
      Media.create = origCreate;
      Media.updateOne = origUpdateOne;
      cloudinaryService.uploadUrlToCloudinary = origUpload;
      heuristic.classifyShotStyle = origClassify;
    }
  }

  // ── G. resolveSeedStyle precedence (Media + CatalogProduct forms) ────────
  checkFn('G1 Media: LLM lifestyle wins over heuristic packshot', () => {
    assert.strictEqual(resolveSeedStyle({
      classification: { shotType: 'lifestyle' },
      technicalInsights: { shotStyle: 'packshot' }
    }), 'lifestyle');
  });
  checkFn('G2 Media: heuristic used when shotType unknown', () => {
    assert.strictEqual(resolveSeedStyle({
      classification: { shotType: 'unknown' },
      technicalInsights: { shotStyle: 'packshot' }
    }), 'packshot');
  });
  checkFn('G3 Product+URL form returns stored style', () => {
    assert.strictEqual(resolveSeedStyle({
      imageShotStyles: [
        { url: 'https://cdn.example/p.jpg', style: 'lifestyle', confidence: 0.6 }
      ]
    }, 'https://cdn.example/p.jpg'), 'lifestyle');
  });
  checkFn('G4 Named form: LLM on media wins over product style', () => {
    assert.strictEqual(resolveSeedStyle({
      media: {
        classification: { shotType: 'product_only' },
        technicalInsights: { shotStyle: 'lifestyle' }
      },
      product: {
        imageShotStyles: [
          { url: 'https://cdn.example/p.jpg', style: 'lifestyle', confidence: 0.9 }
        ]
      },
      url: 'https://cdn.example/p.jpg'
    }), 'packshot'); // product_only → packshot
  });
  checkFn('G5 Named form: product style when media unknown', () => {
    assert.strictEqual(resolveSeedStyle({
      media: { classification: { shotType: 'unknown' }, technicalInsights: {} },
      product: {
        imageShotStyles: [
          { url: 'https://cdn.example/p.jpg', style: 'ambiguous', confidence: 0.3 }
        ]
      },
      url: 'https://cdn.example/p.jpg'
    }), 'ambiguous');
  });
  checkFn('G6 unknown when neither present', () => {
    assert.strictEqual(resolveSeedStyle({}), 'unknown');
    assert.strictEqual(resolveSeedStyle({ imageShotStyles: [] }, 'https://x'), 'unknown');
  });

  // ── H. Detect pipeline skips recompute when style carried ────────────────
  // Call the REAL applyMediaLibraryDerivations — do not re-implement the branch.
  // detect.js transitively constructs an OpenAI client at load time; feed a
  // dummy key so offline harnesses do not need real credentials. Stub
  // Media.updateOne so we stay offline (no Mongo buffer timeout).
  {
    if (!process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = 'harness-offline-not-used';
    if (!process.env.GEMINI_API_KEY) process.env.GEMINI_API_KEY = 'harness-offline-not-used';
    const Media = require('../models/Media');
    const origUpdateOne = Media.updateOne;
    Media.updateOne = async () => ({ acknowledged: true, modifiedCount: 1 });
    try {
      const { applyMediaLibraryDerivations } = require('../pipelines/detect');

      // H1/H2: real execution with carried style → no recompute needed.
      // We observe media.technicalInsights which is assigned before the write.
      const mediaCarried = {
        _id: '000000000000000000000001',
        technicalInsights: {
          shotStyle: 'packshot',
          shotStyleConfidence: 0.91,
          shotStyleMetrics: { source: 'ingest' }
        },
        classification: {},
        text: [],
        refinedProducts: []
      };
      // If recompute ran, sharp would process whiteBuf — pass null buffer so a
      // buggy "always recompute" path cannot invent a style from bytes either;
      // carried must be what lands.
      await applyMediaLibraryDerivations(mediaCarried, null, null, null);
      check('H1 carried packshot preserved by real applyMediaLibraryDerivations',
        mediaCarried.technicalInsights?.shotStyle === 'packshot');
      check('H2 carried confidence preserved',
        mediaCarried.technicalInsights?.shotStyleConfidence === 0.91);

      // H3: missing style + buffer → real classifyShotStyle path runs.
      const mediaMissing = {
        _id: '000000000000000000000002',
        technicalInsights: {},
        classification: {},
        text: [],
        refinedProducts: []
      };
      await applyMediaLibraryDerivations(mediaMissing, whiteBuf, null, null);
      check('H3 missing style recomputes via real classifyShotStyle',
        mediaMissing.technicalInsights &&
        ['packshot', 'lifestyle', 'ambiguous'].includes(mediaMissing.technicalInsights.shotStyle),
        JSON.stringify(mediaMissing.technicalInsights));

      // H4: empty technicalInsights without buffer stays null/unclassified
      const mediaEmpty = {
        _id: '000000000000000000000003',
        technicalInsights: {},
        classification: {},
        text: [],
        refinedProducts: []
      };
      await applyMediaLibraryDerivations(mediaEmpty, null, null, null);
      check('H4 no buffer + no carried → shotStyle null (no throw)',
        mediaEmpty.technicalInsights == null ||
        mediaEmpty.technicalInsights.shotStyle == null ||
        mediaEmpty.technicalInsights.shotStyle === null);
    } finally {
      Media.updateOne = origUpdateOne;
    }
  }

  // ── I. Writers: REAL exported functions (Mongo/network stubbed) ─────────
  // Source-regex order checks shipped a writer ordering bug in round 3.
  // Drive each real writer and assert: (a) every product is upserted BEFORE
  // any classify fetch; (b) beginClassifyPhase fires only after the upsert
  // loop. Session-level batch/cancel/cache checks stay below.
  {
    const CatalogProduct = require('../models/CatalogProduct');
    const Category = require('../models/Category');
    const Brand = require('../models/Brand');
    const IntegrationCredential = require('../models/IntegrationCredential');
    const cryptoSvc = require('../services/integrationCryptoService');
    const axios = require('axios');
    const genericResolver = require('../services/genericCatalogResolver');
    const shopifyAccess = require('../services/shopifyAccessResolver');
    const apifyPull = require('../services/apifyPullService');
    const detectSvc = require('../services/catalogProductDetectService');
    const catClassify = require('../services/categoryClassifier');
    // Writers that destructure deps at module load (generic, apify) must be
    // re-required AFTER the dep is patched, or they keep the original binding.
    function reloadModule(relPath) {
      const abs = require.resolve(relPath);
      delete require.cache[abs];
      return require(abs);
    }

    const brandId = '00000000000000000000b0a1';
    const advertiserId = '00000000000000000000a0a1';

    async function withWriterStubs(runFn) {
      const upsertOrder = [];
      const beginOrder = [];
      const fetchOrder = [];
      let upsertSeq = 0;
      let eventSeq = 0;

      const orig = {
        createSession: ingest.createSession,
        findOneAndUpdate: CatalogProduct.findOneAndUpdate,
        updateOne: CatalogProduct.updateOne,
        countDocuments: CatalogProduct.countDocuments,
        find: CatalogProduct.find,
        findOne: CatalogProduct.findOne,
        catFindOrCreate: Category.findOrCreateCategoryTree,
        brandFindById: Brand.findById,
        brandFindOne: Brand.findOne,
        resolveGeneric: genericResolver.resolveGenericCatalog,
        resolveShopify: shopifyAccess.resolveShopifyAccess,
        pullShopify: apifyPull.pullShopifyProducts,
        credFind: IntegrationCredential.find,
        decrypt: cryptoSvc.decrypt,
        axiosGet: axios.get,
        enqueueDetect: detectSvc.enqueueBrandProductDetects,
        inferCoarse: catClassify.inferCoarseEnum,
        resolveCoarse: catClassify.resolveCoarseCategoryRef
      };

      // Inject offline session: counting fetch + instrumented beginClassifyPhase.
      ingest.createSession = (opts = {}) => {
        const session = orig.createSession({
          ...opts,
          lookup: publicLookupOk,
          fetchBuffer: async () => {
            fetchOrder.push({ seq: ++eventSeq, upsertsSoFar: upsertOrder.length });
            // Small delay so an in-loop await would reorder against upserts.
            await new Promise((r) => setTimeout(r, 15));
            return { ok: true, buffer: whiteBuf, tooLarge: false };
          },
          classifyShotStyle: async () => ({
            style: 'packshot',
            confidence: 0.9,
            metrics: { packshotScore: 0.9, borderStdev: 2 }
          }),
          concurrency: 2,
          budgetMs: 60_000,
          timeoutMs: 2_000
        });
        const realBegin = session.beginClassifyPhase.bind(session);
        session.beginClassifyPhase = () => {
          beginOrder.push({ seq: ++eventSeq, upsertsSoFar: upsertOrder.length });
          return realBegin();
        };
        return session;
      };

      CatalogProduct.findOneAndUpdate = async (filter, update) => {
        const set = (update && update.$set) || {};
        const externalId = set.externalId || (filter && filter.externalId) || `x-${++upsertSeq}`;
        const doc = {
          _id: `0000000000000000000u${String(++upsertSeq).padStart(3, '0')}`,
          brandId: (filter && filter.brandId) || brandId,
          externalId: String(externalId),
          imageUrl: set.imageUrl || null,
          additionalImages: Array.isArray(set.additionalImages) ? set.additionalImages : [],
          imageShotStyles: [],
          categoryRef: null,
          ...set
        };
        upsertOrder.push({
          seq: ++eventSeq,
          externalId: String(externalId),
          fetchesSoFar: fetchOrder.length,
          beginsSoFar: beginOrder.length
        });
        // Meta writer uses rawResult:true and reads result.value / lastErrorObject.
        return {
          value: doc,
          lastErrorObject: { updatedExisting: false },
          // Also act as the doc for writers that expect the doc directly.
          ...doc,
          _id: doc._id
        };
      };
      CatalogProduct.updateOne = async () => ({ acknowledged: true, modifiedCount: 1 });
      CatalogProduct.countDocuments = async () => upsertOrder.length;
      // Chainable query stubs (find/findOne used by post-sync stages).
      const emptyQuery = () => {
        const q = {
          select: () => q,
          sort: () => q,
          lean: async () => null,
          then: (resolve) => resolve(null)
        };
        return q;
      };
      CatalogProduct.find = () => {
        const q = {
          select: () => q,
          sort: () => q,
          lean: async () => [],
          then: (resolve) => resolve([])
        };
        return q;
      };
      CatalogProduct.findOne = () => emptyQuery();
      Category.findOrCreateCategoryTree = async () => '00000000000000000000c001';
      // apify isBrandAborted → Brand.findById().select().lean() — must not hit Mongo.
      const brandNotAborted = () => {
        const q = {
          select: () => q,
          lean: async () => ({ apifyDemo: { aborted: false } }),
          then: (resolve) => resolve({ apifyDemo: { aborted: false } })
        };
        return q;
      };
      Brand.findById = () => brandNotAborted();
      Brand.findOne = () => brandNotAborted();
      catClassify.inferCoarseEnum = () => null;
      catClassify.resolveCoarseCategoryRef = async () => null;
      detectSvc.enqueueBrandProductDetects = async () => ({ enqueued: 0 });

      // Enrichment / category-inference are fire-and-forget via setImmediate.
      // Stub them and DRAIN the queue before restoring real methods, or a
      // later harness pays 10s Mongo buffering timeouts per pending tick.
      let enrichMod = null;
      let inferenceMod = null;
      try {
        enrichMod = require('../services/catalogProductEnrichmentService');
      } catch (_) { /* optional */ }
      try {
        inferenceMod = require('../services/productCategoryInferenceService');
      } catch (_) { /* optional */ }
      const origEnrich = enrichMod && enrichMod.enqueueBrandProductEnrichment;
      const origInferBatch = inferenceMod && inferenceMod.inferBatch;
      if (enrichMod) {
        enrichMod.enqueueBrandProductEnrichment = async () => ({ ok: true });
      }
      if (inferenceMod) {
        inferenceMod.inferBatch = async () => ({ ok: 0, skipped: 0, failed: 0 });
      }

      try {
        await runFn({
          upsertOrder,
          beginOrder,
          fetchOrder,
          brandId,
          advertiserId,
          orig,
          reloadModule
        });
        // Drain setImmediate post-sync work while stubs still apply.
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
      } finally {
        ingest.createSession = orig.createSession;
        CatalogProduct.findOneAndUpdate = orig.findOneAndUpdate;
        CatalogProduct.updateOne = orig.updateOne;
        CatalogProduct.countDocuments = orig.countDocuments;
        CatalogProduct.find = orig.find;
        CatalogProduct.findOne = orig.findOne;
        Category.findOrCreateCategoryTree = orig.catFindOrCreate;
        Brand.findById = orig.brandFindById;
        Brand.findOne = orig.brandFindOne;
        genericResolver.resolveGenericCatalog = orig.resolveGeneric;
        shopifyAccess.resolveShopifyAccess = orig.resolveShopify;
        apifyPull.pullShopifyProducts = orig.pullShopify;
        IntegrationCredential.find = orig.credFind;
        cryptoSvc.decrypt = orig.decrypt;
        axios.get = orig.axiosGet;
        detectSvc.enqueueBrandProductDetects = orig.enqueueDetect;
        catClassify.inferCoarseEnum = orig.inferCoarse;
        catClassify.resolveCoarseCategoryRef = orig.resolveCoarse;
        if (enrichMod && origEnrich) {
          enrichMod.enqueueBrandProductEnrichment = origEnrich;
        }
        if (inferenceMod && origInferBatch) {
          inferenceMod.inferBatch = origInferBatch;
        }
        // Drop reloaded writer modules so later tests don't keep stub bindings.
        try {
          delete require.cache[require.resolve('../services/genericCatalogIngestService')];
        } catch (_) { /* ignore */ }
        try {
          delete require.cache[require.resolve('../services/apifyIngestService')];
        } catch (_) { /* ignore */ }
      }
    }

    function assertWriterOrdering(name, { upsertOrder, beginOrder, fetchOrder }, expectedUpserts) {
      check(`I1 ${name} real writer upserted all products`,
        upsertOrder.length === expectedUpserts,
        `upserts=${upsertOrder.length} expected=${expectedUpserts}`);
      // (a) every upsert completed with zero classify fetches so far
      const upsertsBeforeAnyFetch = upsertOrder.every((u) => u.fetchesSoFar === 0);
      check(`I2 ${name} all upserts before any classify fetch`,
        upsertsBeforeAnyFetch && (fetchOrder.length === 0 || fetchOrder[0].upsertsSoFar >= expectedUpserts),
        JSON.stringify({
          upsertFetches: upsertOrder.map((u) => u.fetchesSoFar),
          firstFetchUpserts: fetchOrder[0] && fetchOrder[0].upsertsSoFar
        }));
      // (b) beginClassifyPhase after upsert loop
      check(`I3 ${name} beginClassifyPhase after every upsert`,
        beginOrder.length >= 1 &&
        beginOrder.every((b) => b.upsertsSoFar >= expectedUpserts) &&
        upsertOrder.every((u) => u.beginsSoFar === 0),
        JSON.stringify({ beginOrder, upsertBegins: upsertOrder.map((u) => u.beginsSoFar) }));
      // Classify did run (not skipped)
      check(`I3b ${name} classify phase performed fetches`,
        fetchOrder.length >= 1,
        `fetchOrder=${fetchOrder.length}`);
    }

    // ── generic: syncBrandGenericCatalog ────────────────────────────────
    // Dep is destructured at module load — patch then reload the writer.
    await withWriterStubs(async (ctx) => {
      genericResolver.resolveGenericCatalog = async () => ({
        ok: true,
        mode: 'sitemap-jsonld',
        origin: 'https://store.example',
        products: [
          {
            externalId: 'g1',
            title: 'Generic One',
            imageUrl: 'https://cdn.example/g1.jpg',
            additionalImages: [],
            productUrl: 'https://store.example/p/g1'
          },
          {
            externalId: 'g2',
            title: 'Generic Two',
            imageUrl: 'https://cdn.example/g2.jpg',
            additionalImages: ['https://cdn.example/g2b.jpg'],
            productUrl: 'https://store.example/p/g2'
          },
          {
            externalId: 'g3',
            title: 'Generic Three',
            imageUrl: 'https://cdn.example/g3.jpg',
            additionalImages: [],
            productUrl: 'https://store.example/p/g3'
          }
        ],
        stats: {},
        cancelled: false
      });
      const genericWriter = ctx.reloadModule('../services/genericCatalogIngestService');
      const brand = {
        _id: brandId,
        advertiserId,
        name: 'TestBrand',
        websiteUrl: 'https://store.example',
        apifyDemo: { shopifyUrl: 'https://store.example' }
      };
      await genericWriter.syncBrandGenericCatalog(brand, null, {
        isBrandAborted: async () => false
      });
      assertWriterOrdering('generic', ctx, 3);
    });

    // ── shopify-direct: syncBrandShopifyDirect ──────────────────────────
    // resolveShopifyAccess is required INSIDE the function → module patch works.
    // Omit `handle` so the post-classify media stage skips real HTTP.
    await withWriterStubs(async (ctx) => {
      shopifyAccess.resolveShopifyAccess = async () => ({
        ok: true,
        mode: 'products.json',
        origin: 'https://shop.example',
        products: [
          {
            id: 101,
            title: 'Shoe',
            // no handle → media/video stage continues without network
            body_html: '<p>hi</p>',
            vendor: 'Brand',
            product_type: 'Shoes',
            variants: [{ price: '10.00', available: true, barcode: null, sku: 'S1' }],
            images: [{ src: 'https://cdn.example/s1.jpg' }, { src: 'https://cdn.example/s1b.jpg' }]
          },
          {
            id: 102,
            title: 'Hat',
            body_html: '',
            vendor: 'Brand',
            product_type: 'Hats',
            variants: [{ price: '5.00', available: true, barcode: null, sku: 'H1' }],
            images: [{ src: 'https://cdn.example/s2.jpg' }]
          }
        ]
      });
      const shopifyWriter = require('../services/shopifyPublicIngestService');
      const brand = {
        _id: brandId,
        advertiserId,
        name: 'ShopifyBrand',
        apifyDemo: { shopifyUrl: 'https://shop.example' }
      };
      await shopifyWriter.syncBrandShopifyDirect(brand, null, {
        isBrandAborted: async () => false
      });
      assertWriterOrdering('shopify', ctx, 2);
    });

    // ── apify-shopify: syncBrandShopify ─────────────────────────────────
    // pullShopifyProducts is destructured at load — patch then reload.
    await withWriterStubs(async (ctx) => {
      apifyPull.pullShopifyProducts = async () => ([
        {
          externalId: 'ap1',
          title: 'Apify One',
          imageUrl: 'https://cdn.example/ap1.jpg',
          additionalImageUrls: [],
          price: 12,
          currency: 'USD',
          availability: 'in stock',
          productUrl: 'https://shop.example/products/ap1'
        },
        {
          externalId: 'ap2',
          title: 'Apify Two',
          imageUrl: 'https://cdn.example/ap2.jpg',
          additionalImageUrls: ['https://cdn.example/ap2b.jpg'],
          price: 20,
          currency: 'USD',
          availability: 'in stock',
          productUrl: 'https://shop.example/products/ap2'
        }
      ]);
      const apifyWriter = ctx.reloadModule('../services/apifyIngestService');
      const brand = {
        _id: brandId,
        advertiserId,
        name: 'ApifyBrand',
        apifyDemo: { shopifyUrl: 'https://shop.example' }
      };
      await apifyWriter.syncBrandShopify(brand, null);
      assertWriterOrdering('apify', ctx, 2);
    });

    // ── meta: syncCatalog (exported) → syncCatalogForCred ───────────────
    await withWriterStubs(async (ctx) => {
      IntegrationCredential.find = async () => ([
        {
          _id: '00000000000000000000c001',
          brandId,
          advertiserId,
          type: 'instagram',
          status: 'active',
          catalogId: 'cat_1',
          accessTokenEnc: 'enc',
          igUsername: 'test',
          lastUsedAt: null,
          lastCatalogSyncAt: null,
          save: async function save() { return this; }
        }
      ]);
      cryptoSvc.decrypt = () => 'fake-token';
      axios.get = async (url) => {
        // Single page of Meta catalog products; no paging.next.
        if (String(url).includes('/products') || String(url).includes('graph.facebook.com')) {
          return {
            data: {
              data: [
                {
                  id: 'm1',
                  name: 'Meta One',
                  image_url: 'https://cdn.example/m1.jpg',
                  additional_image_urls: [],
                  price: '10.00 USD',
                  availability: 'in stock',
                  url: 'https://shop.example/m1'
                },
                {
                  id: 'm2',
                  name: 'Meta Two',
                  image_url: 'https://cdn.example/m2.jpg',
                  additional_image_urls: ['https://cdn.example/m2b.jpg'],
                  price: '12.00 USD',
                  availability: 'in stock',
                  url: 'https://shop.example/m2'
                }
              ],
              paging: {}
            }
          };
        }
        return { data: {} };
      };
      // Supply our own run handle so startRun (Mongo) is never called.
      const run = {
        stage: () => {},
        tick: () => {},
        checkpoint: async () => true,
        succeed: async () => {},
        fail: async () => {}
      };
      const metaWriter = require('../services/catalogSyncService');
      await metaWriter.syncCatalog(brandId, { run, credentialId: '00000000000000000000c001' });
      assertWriterOrdering('meta', ctx, 2);
    });

    // Keep session-level behavioural pins (not writer-specific).
    {
      let t = 0;
      const upserted = [];
      const pending = [];
      const products = [
        { id: '1', imageUrl: 'https://cdn.example/1.jpg' },
        { id: '2', imageUrl: 'https://cdn.example/2.jpg' },
        { id: '3', imageUrl: 'https://cdn.example/3.jpg' }
      ];

      const session = ingest.createSession({
        lookup: publicLookupOk,
        fetchBuffer: async () => {
          t += 5;
          return { ok: true, buffer: whiteBuf, tooLarge: false };
        },
        classifyShotStyle: async () => ({ style: 'packshot', confidence: 1, metrics: {} }),
        concurrency: 2,
        budgetMs: 1_000,
        now: () => t
      });
      check('I6 session created before upsert; phase not started',
        session.hasClassifyPhaseStarted() === false);

      for (const p of products) {
        upserted.push(p.id);
        pending.push({
          productId: p.id,
          imageUrl: p.imageUrl,
          additionalImages: [],
          existingStyles: []
        });
        t += 500;
      }
      check('I7 upsert loop completed with clock past budgetMs',
        upserted.length === 3 && t > 1_000,
        `t=${t}`);

      session.beginClassifyPhase();
      await session.classifyPendingProducts(pending);
      const totals = session.getTotals();
      check('I8 post-loop batch classify still classifies after pre-phase burn',
        totals.classified === 3 && totals.skippedBudget === 0,
        JSON.stringify(totals));
      session.dispose();
    }

    // I9: batch uses concurrency across 1-image products (not serialised).
    {
      let inFlight = 0;
      let maxInFlight = 0;
      const pending = Array.from({ length: 6 }, (_, i) => ({
        productId: `p${i}`,
        imageUrl: `https://cdn.example/batch${i}.jpg`,
        additionalImages: [],
        existingStyles: []
      }));
      const session = ingest.createSession({
        lookup: publicLookupOk,
        concurrency: 4,
        budgetMs: 60_000,
        fetchBuffer: async () => {
          inFlight++;
          if (inFlight > maxInFlight) maxInFlight = inFlight;
          await new Promise((r) => setTimeout(r, 40));
          inFlight--;
          return { ok: true, buffer: whiteBuf, tooLarge: false };
        },
        classifyShotStyle: async () => ({ style: 'packshot', confidence: 1, metrics: {} })
      });
      session.beginClassifyPhase();
      await session.classifyPendingProducts(pending);
      check('I9 batch classify reaches concurrency >1 across 1-image products',
        maxInFlight >= 2 && session.getTotals().classified === 6,
        `maxInFlight=${maxInFlight} classified=${session.getTotals().classified}`);
      session.dispose();
    }

    // I10: session URL cache — shared CDN URL classified once.
    {
      let fetchCalls = 0;
      const shared = 'https://cdn.example/shared-variant.jpg';
      const pending = [
        { productId: 'a', imageUrl: shared, additionalImages: [], existingStyles: [] },
        { productId: 'b', imageUrl: shared, additionalImages: [], existingStyles: [] },
        { productId: 'c', imageUrl: shared, additionalImages: [], existingStyles: [] }
      ];
      const session = ingest.createSession({
        lookup: publicLookupOk,
        concurrency: 3,
        budgetMs: 60_000,
        fetchBuffer: async () => {
          fetchCalls++;
          return { ok: true, buffer: whiteBuf, tooLarge: false };
        },
        classifyShotStyle: async () => ({ style: 'lifestyle', confidence: 0.8, metrics: {} })
      });
      session.beginClassifyPhase();
      const { results } = await session.classifyPendingProducts(pending);
      check('I10 session URL cache: shared URL fetched once across products',
        fetchCalls === 1 && results.every((r) =>
          ingest.storedStyleForUrl(r.entries, shared)?.style === 'lifestyle'
        ),
        `fetchCalls=${fetchCalls} results=${results.length}`);
      session.dispose();
    }

    // I11: failed URL remembered for session — not retried per product.
    {
      let fetchCalls = 0;
      const broken = 'https://cdn.example/broken.jpg';
      const pending = [
        { productId: 'a', imageUrl: broken, additionalImages: [], existingStyles: [] },
        { productId: 'b', imageUrl: broken, additionalImages: [], existingStyles: [] },
        { productId: 'c', imageUrl: broken, additionalImages: [], existingStyles: [] }
      ];
      const session = ingest.createSession({
        lookup: publicLookupOk,
        concurrency: 3,
        budgetMs: 60_000,
        fetchBuffer: async () => {
          fetchCalls++;
          return { ok: false, buffer: null, error: '404' };
        },
        classifyShotStyle: async () => ({ style: 'packshot', confidence: 1, metrics: {} })
      });
      session.beginClassifyPhase();
      await session.classifyPendingProducts(pending);
      check('I11 failed URL fetched at most once per session (not per product)',
        fetchCalls === 1,
        `fetchCalls=${fetchCalls}`);
      session.dispose();
    }

    // I12: mid-phase cancel → remaining abandoned with reason.
    {
      const pending = Array.from({ length: 4 }, (_, i) => ({
        productId: `p${i}`,
        imageUrl: `https://cdn.example/c${i}.jpg`,
        additionalImages: [],
        existingStyles: []
      }));
      const session = ingest.createSession({
        lookup: publicLookupOk,
        concurrency: 1,
        budgetMs: 60_000,
        fetchBuffer: async () => {
          return { ok: true, buffer: whiteBuf, tooLarge: false };
        },
        classifyShotStyle: async () => ({ style: 'packshot', confidence: 1, metrics: {} })
      });
      session.beginClassifyPhase();
      const cancelAfter = 1;
      const { cancelled } = await session.classifyPendingProducts(pending, {
        isCancelled: async () => {
          return session.getTotals().classified + session.getTotals().failed +
            session.getTotals().fetchFailed + session.getTotals().cpuTimedOut >= cancelAfter ||
            session.getTotals().classified >= cancelAfter;
        }
      });
      const t = session.getTotals();
      check('I12 mid-phase cancel stops and records abandoned',
        cancelled === true && t.skippedAbandoned >= 1 &&
        (t.abandonReason === 'cancelled' || t.classified < 4),
        JSON.stringify(t));
      session.dispose();
    }
  }

  // ── J. Flag / concurrency defaults ───────────────────────────────────────
  checkFn('J1 isEnabled default true', () => {
    const prev = process.env.CATALOG_INGEST_SHOT_CLASSIFY_ENABLED;
    delete process.env.CATALOG_INGEST_SHOT_CLASSIFY_ENABLED;
    try { assert.strictEqual(ingest.isEnabled(), true); }
    finally {
      if (prev === undefined) delete process.env.CATALOG_INGEST_SHOT_CLASSIFY_ENABLED;
      else process.env.CATALOG_INGEST_SHOT_CLASSIFY_ENABLED = prev;
    }
  });
  check('J2 concurrency knob in concurrency.js SPEC',
    /CATALOG_INGEST_SHOT_CLASSIFY_CONCURRENCY/.test(read('services/concurrency.js')));
  {
    const src = read('services/ingestShotClassifyService.js');
    check('J3 local safeFetchBuffer (not httpScrapeClient.fetchBuffer)',
      /safeFetchBuffer/.test(src) &&
      (/redirect:\s*['"]manual['"]/.test(src) || /nodePinnedRequest/.test(src)) &&
      !/require\(['"]\.\/httpScrapeClient['"]\)/.test(src));
    check('J3b notes httpScrapeClient SSRF gap as separate follow-up',
      /httpScrapeClient/.test(src) && /follow-up|separate/i.test(src));
    check('J5 connection pin via custom lookup / makePinnedLookup',
      /makePinnedLookup/.test(src) && /lookup:\s*pinnedLookup/.test(src));
  }

  // ── J4. BEHAVIOURAL: single per-URL deadline across redirect hops ───────
  // Replaces the comment-prose regex. Each hop burns part of the timeout;
  // total wall clock must be one timeoutMs, not hops × timeoutMs.
  //
  // MARGIN (widened 2026-08-19): this races safeFetchBuffer's real
  // AbortController setTimeout(timeoutMs) against real per-hop setTimeout
  // delays -- the same shape as the verifyDirectorFallbackChain.js C4 flake
  // (a real timer raced against a real deadline under CPU oversubscription),
  // just with a wider margin (2.5x vs C4's ~1.5x) that didn't reproduce a
  // failure in stress testing at concurrency=16. safeFetchBuffer's abort
  // timer isn't behind an injectable clock the way atlasLlmService's
  // Date.now() budget check was, so faking it deterministically would mean
  // changing production fetch/abort code rather than just this test --
  // out of scope here. Scaling TIMEOUT_MS/HOP_MS up 5x (same ratios, same
  // assertions) instead shrinks scheduler jitter to a much smaller fraction
  // of every window, cutting residual flake risk without touching
  // safeFetchBuffer itself.
  {
    const { safeFetchBuffer } = ingest;
    const TIMEOUT_MS = 1000;
    const HOP_MS = 400;
    const HOPS_BEFORE_BODY = 3; // 3 redirects + final body = 4 sleeps if no abort

    async function multiHopFetch(fetchImplFactory) {
      let hop = 0;
      const fetchImpl = fetchImplFactory(() => hop, (n) => { hop = n; });
      const t0 = Date.now();
      const r = await safeFetchBuffer('https://cdn.example/start.jpg', {
        lookup: publicLookupOk,
        fetchImpl,
        timeoutMs: TIMEOUT_MS,
        maxRedirects: 6
      });
      return { r, hop, elapsed: Date.now() - t0 };
    }

    function defaultHopImpl(getHop, setHop) {
      return async (url, init) => {
        const n = getHop() + 1;
        setHop(n);
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, HOP_MS);
          if (init && init.signal) {
            if (init.signal.aborted) {
              clearTimeout(t);
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
              return;
            }
            init.signal.addEventListener('abort', () => {
              clearTimeout(t);
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            }, { once: true });
          }
        });
        // Keep redirecting — single deadline must abort before final 200.
        return {
          status: 302,
          headers: {
            get: (h) => (String(h).toLowerCase() === 'location'
              ? `https://cdn.example/h${n}.jpg`
              : null)
          },
          body: { cancel: async () => {} }
        };
      };
    }

    const live = await multiHopFetch(defaultHopImpl);
    check('J4a multi-hop chain aborts under ONE timeoutMs (not hops×timeoutMs)',
      live.r.ok === false && /timeout/i.test(live.r.error || ''),
      JSON.stringify({ ok: live.r.ok, err: live.r.error, hop: live.hop, elapsed: live.elapsed }));
    // With TIMEOUT=200 and HOP=80, hop×timeout would be ≥600ms+; single deadline ~200ms.
    check('J4b elapsed tracks one deadline, not hops×deadline',
      live.elapsed < TIMEOUT_MS * 2.5 && live.elapsed < HOPS_BEFORE_BODY * TIMEOUT_MS,
      `elapsed=${live.elapsed} timeoutMs=${TIMEOUT_MS} hopsSeen=${live.hop}`);

    // REVERT-PROVE: re-arm the timer per hop → chain can outlive one timeoutMs.
    {
      let tmpPath = null;
      try {
        const { mod: mutated, tmp } = loadMutatedIngest((src) => {
          // Make the per-URL timer re-armable and reset it on every hop.
          let m = src.replace(
            'const ac = new AbortController();\n' +
            '  const timer = setTimeout(() => {\n' +
            '    try { ac.abort(); } catch { /* ignore */ }\n' +
            '  }, timeoutMs);',
            'const ac = new AbortController();\n' +
            '  let timer = setTimeout(() => {\n' +
            '    try { ac.abort(); } catch { /* ignore */ }\n' +
            '  }, timeoutMs);\n' +
            '  const __rearmDeadline = () => {\n' +
            '    clearTimeout(timer);\n' +
            '    timer = setTimeout(() => {\n' +
            '      try { ac.abort(); } catch { /* ignore */ }\n' +
            '    }, timeoutMs);\n' +
            '  };'
          );
          assert.notStrictEqual(m, src, 'timer mutation must change source');
          // Re-arm at the top of each hop iteration.
          m = m.replace(
            'for (let hop = 0; hop <= maxRedirects; hop++) {\n' +
            '      // Resolve + validate ONCE per hop; reuse addresses for the pin.',
            'for (let hop = 0; hop <= maxRedirects; hop++) {\n' +
            '      if (hop > 0 && typeof __rearmDeadline === \'function\') __rearmDeadline();\n' +
            '      // Resolve + validate ONCE per hop; reuse addresses for the pin.'
          );
          assert.ok(m.includes('__rearmDeadline'), 're-arm hook not injected');
          return m;
        });
        tmpPath = tmp;

        let hop = 0;
        const t0 = Date.now();
        const r = await mutated.safeFetchBuffer('https://cdn.example/start.jpg', {
          lookup: publicLookupOk,
          timeoutMs: TIMEOUT_MS,
          maxRedirects: 6,
          fetchImpl: async (url, init) => {
            hop++;
            await new Promise((resolve, reject) => {
              const t = setTimeout(resolve, HOP_MS);
              if (init && init.signal) {
                if (init.signal.aborted) {
                  clearTimeout(t);
                  reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                  return;
                }
                init.signal.addEventListener('abort', () => {
                  clearTimeout(t);
                  reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                }, { once: true });
              }
            });
            if (hop < 4) {
              return {
                status: 302,
                headers: {
                  get: (h) => (String(h).toLowerCase() === 'location'
                    ? `https://cdn.example/rh${hop}.jpg`
                    : null)
                },
                body: { cancel: async () => {} }
              };
            }
            return {
              status: 200,
              headers: { get: () => null },
              arrayBuffer: async () => whiteBuf.buffer.slice(
                whiteBuf.byteOffset,
                whiteBuf.byteOffset + whiteBuf.byteLength
              )
            };
          }
        });
        const elapsed = Date.now() - t0;
        // Per-hop re-arm lets 4×80ms complete under a 200ms "deadline".
        check('J4c REVERT-PROVE: re-arming timer per hop lets chain exceed one timeoutMs',
          r.ok === true && elapsed > TIMEOUT_MS,
          JSON.stringify({ ok: r.ok, err: r.error, hop, elapsed, TIMEOUT_MS }));
      } catch (e) {
        check('J4c REVERT-PROVE: re-arming timer per hop lets chain exceed one timeoutMs',
          false, e.message);
      } finally {
        if (tmpPath) unloadTmp(tmpPath);
      }
    }
  }

  // ── K. BLOCKER 1 regression: hung DNS must not stall past deadline ───────
  // Most important test in the file. Real safeFetchBuffer path (no fetchBuffer
  // inject), stubbed DNS that never resolves, assert per-URL deadline fires
  // and a simulated upsert loop is unaffected.
  {
    const products = Array.from({ length: 5 }, (_, i) => ({
      id: `sku-${i}`,
      imageUrl: `https://hang.example/p${i}.jpg`
    }));
    const upsertedIds = [];
    // Writer architecture: upsert ALL first
    for (const p of products) {
      upsertedIds.push(p.id);
    }
    check('K0 upsert loop finished all 5 before classify starts',
      upsertedIds.length === 5);

    let lookupCalls = 0;
    const hungLookup = () => {
      lookupCalls++;
      // Never resolves — blackholed resolver.
      return new Promise(() => {});
    };

    const session = ingest.createSession({
      lookup: hungLookup,
      // No fetchBuffer inject → real safeFetchBuffer → assertUrlSafeForFetch
      // races DNS against the per-URL AbortController.
      timeoutMs: 150,
      budgetMs: 10_000,
      concurrency: 2,
      classifyShotStyle: async () => ({ style: 'packshot', confidence: 1, metrics: {} })
    });

    const t0 = Date.now();
    let threw = false;
    let r;
    try {
      r = await session.classifyUrls(
        products.map((p) => p.imageUrl),
        []
      );
    } catch (e) {
      threw = true;
    }
    const elapsed = Date.now() - t0;

    check('K1 hung DNS does not throw out of classifyUrls', !threw);
    check('K2 hung DNS times out within ~2s (deadline fires)',
      elapsed < 2500,
      `elapsed=${elapsed}ms`);
    check('K3 hung DNS leaves URLs unclassified',
      r && r.entries.length === 0);
    check('K4 hung DNS tallies timedOut or fetchFailed',
      session.getTotals().timedOut + session.getTotals().fetchFailed +
      session.getTotals().failed + session.getTotals().ssrfRejected >= 1,
      JSON.stringify(session.getTotals()));
    check('K5 upsert set still complete (classify cannot un-save products)',
      upsertedIds.length === 5 &&
      upsertedIds.join(',') === 'sku-0,sku-1,sku-2,sku-3,sku-4');
    check('K6 DNS was attempted (lookup invoked)',
      lookupCalls >= 1,
      `lookupCalls=${lookupCalls}`);
    session.dispose();
  }

  // ── S. SSRF guard (offline — stubbed DNS, no real network) ───────────────
  {
    const { isBlockedIp, assertUrlSafeForFetch, safeFetchBuffer, makePinnedLookup } = ingest;

    // S1 — every blocked range rejected at the IP helper
    const blockedIps = [
      ['127.0.0.1', 'ipv4_loopback'],
      ['127.0.0.2', 'ipv4_loopback_range'],
      ['10.0.0.1', 'ipv4_10'],
      ['10.255.255.255', 'ipv4_10_hi'],
      ['172.16.0.1', 'ipv4_172_16'],
      ['172.31.255.1', 'ipv4_172_31'],
      ['192.168.1.1', 'ipv4_192_168'],
      ['169.254.169.254', 'ipv4_link_local_metadata'],
      ['169.254.0.1', 'ipv4_link_local'],
      ['0.0.0.0', 'ipv4_this_network'],
      ['100.64.0.1', 'ipv4_cgnat'],
      ['::1', 'ipv6_loopback'],
      ['::', 'ipv6_unspecified'],
      ['fc00::1', 'ipv6_ula_fc'],
      ['fd12:3456:789a::1', 'ipv6_ula_fd'],
      ['fe80::1', 'ipv6_link_local'],
      // IPv4-mapped (already covered previously)
      ['::ffff:127.0.0.1', 'ipv4_mapped_loopback'],
      ['::ffff:10.0.0.1', 'ipv4_mapped_private'],
      ['::ffff:169.254.169.254', 'ipv4_mapped_metadata'],
      // IPv4-compatible — VERIFIED BYPASS table (Round 4). Exact strings.
      ['::7f00:1', 'ipv4_compat_loopback_hex'],
      ['::a9fe:a9fe', 'ipv4_compat_metadata_hex'],
      ['::169.254.169.254', 'ipv4_compat_metadata_dotted'],
      ['::127.0.0.1', 'ipv4_compat_loopback_dotted'],
      ['::0a00:1', 'ipv4_compat_rfc1918_10'],
      // Sibling translation prefixes
      ['64:ff9b::7f00:1', 'nat64_loopback'],
      ['64:ff9b::a9fe:a9fe', 'nat64_metadata'],
      ['64:ff9b::0a00:1', 'nat64_rfc1918_10'],
      ['2002:7f00:1::1', '6to4_loopback'],
      ['2002:a9fe:a9fe::1', '6to4_metadata'],
      ['2002:0a00:1::', '6to4_rfc1918_10']
    ];
    for (const [ip, name] of blockedIps) {
      check(`S1 blocked IP ${name} (${ip})`, isBlockedIp(ip) === true);
    }
    check('S1b public IPv4 allowed by isBlockedIp', isBlockedIp('8.8.8.8') === false);
    check('S1c public IPv6 allowed by isBlockedIp', isBlockedIp('2001:4860:4860::8888') === false);
    check('S1d 6to4 with public embedded IPv4 allowed',
      isBlockedIp('2002:808:808::1') === false); // 8.8.8.8
    check('S1e NAT64 with public embedded IPv4 allowed',
      isBlockedIp('64:ff9b::808:808') === false);

    // S2 — scheme allowlist
    for (const [scheme, url] of [
      ['file', 'file:///etc/passwd'],
      ['gopher', 'gopher://evil.test/1'],
      ['ftp', 'ftp://cdn.example/x.jpg'],
      ['data', 'data:image/png;base64,aaa']
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await assertUrlSafeForFetch(url, { lookup: publicLookupOk });
      check(`S2 scheme rejected: ${scheme}`, r.ok === false && /scheme_not_allowed/.test(r.reason),
        JSON.stringify(r));
    }

    // S3 — credentials in URL
    {
      const r = await assertUrlSafeForFetch('https://user:pass@cdn.example/x.jpg', {
        lookup: publicLookupOk
      });
      check('S3 credentials-in-URL rejected',
        r.ok === false && r.reason === 'credentials_in_url', JSON.stringify(r));
    }

    // S4 — literal private IPs rejected (no DNS needed)
    for (const url of [
      'http://127.0.0.1/secret',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/img.jpg',
      'http://192.168.0.2/img.jpg',
      'http://[::1]/img.jpg',
      'http://[fe80::1]/img.jpg',
      'http://[::ffff:127.0.0.1]/img.jpg',
      // IPv4-compatible forms that previously BYPASSED (Round 4)
      'http://[::7f00:1]/img.jpg',
      'http://[::a9fe:a9fe]/img.jpg',
      'http://[::169.254.169.254]/img.jpg',
      'http://[::127.0.0.1]/img.jpg',
      'http://[::0a00:1]/img.jpg',
      'http://[64:ff9b::a9fe:a9fe]/img.jpg',
      'http://[2002:a9fe:a9fe::1]/img.jpg'
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await assertUrlSafeForFetch(url, { lookup: publicLookupOk });
      check(`S4 literal blocked destination rejected: ${url}`,
        r.ok === false && /blocked_address/.test(r.reason), JSON.stringify(r));
    }

    // S5 — THE post-DNS check a string-match implementation fails
    {
      const r = await assertUrlSafeForFetch(
        'https://evil-looks-public.example/product.jpg',
        {
          lookup: lookupMap({
            'evil-looks-public.example': '169.254.169.254'
          })
        }
      );
      check('S_RESOLVES_PRIVATE hostname resolving to private address is rejected',
        r.ok === false && /blocked_address:169\.254\.169\.254/.test(r.reason),
        JSON.stringify(r));
    }
    {
      const r = await assertUrlSafeForFetch(
        'https://loopback-via-dns.example/x.jpg',
        { lookup: lookupMap({ 'loopback-via-dns.example': '127.0.0.1' }) }
      );
      check('S5b hostname resolving to 127.0.0.1 rejected',
        r.ok === false && /blocked_address:127\.0\.0\.1/.test(r.reason),
        JSON.stringify(r));
    }
    {
      const r = await assertUrlSafeForFetch(
        'https://mixed-records.example/x.jpg',
        {
          lookup: async () => [
            { address: '8.8.8.8', family: 4 },
            { address: '10.0.0.9', family: 4 }
          ]
        }
      );
      check('S5c multi-A with one private address rejected',
        r.ok === false && /blocked_address:10\.0\.0\.9/.test(r.reason),
        JSON.stringify(r));
    }

    // S6 — ordinary public CDN hosts ALLOWED
    for (const host of [
      'cdn.shopify.com',
      'images.ctfassets.net',
      'd111111abcdef8.cloudfront.net',
      'cdn.example'
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await assertUrlSafeForFetch(`https://${host}/products/a.jpg`, {
        lookup: publicLookupOk
      });
      check(`S6 public CDN host allowed: ${host}`,
        r.ok === true && Array.isArray(r.addresses) && r.addresses.length > 0,
        JSON.stringify(r));
    }

    // S7 — rejection degrades to unclassified, counted separately, no throw
    {
      let fetchCalls = 0;
      const warns = [];
      const origWarn = console.warn;
      console.warn = (...a) => warns.push(a.join(' '));
      let threw = false;
      let r;
      try {
        const session = ingest.createSession({
          lookup: lookupMap({
            'evil-meta.example': '169.254.169.254',
            'cdn.example': '8.8.8.8'
          }),
          fetchBuffer: async (url) => {
            fetchCalls++;
            return { ok: true, buffer: whiteBuf, tooLarge: false };
          },
          classifyShotStyle: async () => ({ style: 'packshot', confidence: 1, metrics: {} }),
          concurrency: 2,
          budgetMs: 60_000
        });
        r = await session.classifyUrls([
          'https://evil-meta.example/meta.jpg',
          'http://127.0.0.1/local.jpg',
          'file:///etc/passwd',
          'https://user:pass@cdn.example/creds.jpg',
          'https://cdn.example/ok.jpg'
        ], []);
        const t = session.getTotals();
        check('S7a SSRF rejections do not throw', !threw && !!r);
        check('S7b ssrfRejected counted separately from fetchFailed',
          t.ssrfRejected >= 4 && t.fetchFailed === 0,
          JSON.stringify({ ssrfRejected: t.ssrfRejected, fetchFailed: t.fetchFailed }));
        check('S7c call stats carry ssrfRejected',
          r.stats.ssrfRejected >= 4);
        check('S7d rejected URLs remain unclassified (no entries)',
          !ingest.storedStyleForUrl(r.entries, 'https://evil-meta.example/meta.jpg') &&
          !ingest.storedStyleForUrl(r.entries, 'http://127.0.0.1/local.jpg') &&
          !ingest.storedStyleForUrl(r.entries, 'file:///etc/passwd'));
        check('S7e public URL still classified alongside rejections',
          ingest.storedStyleForUrl(r.entries, 'https://cdn.example/ok.jpg')?.style === 'packshot');
        check('S7f inner fetchBuffer not invoked for rejected URLs',
          fetchCalls === 1, `fetchCalls=${fetchCalls}`);
        check('S7g warn log emitted with reason',
          warns.some((w) => /SSRF rejected/i.test(w)),
          JSON.stringify(warns));
        session.dispose();
      } catch (e) {
        threw = true;
        check('S7a SSRF rejections do not throw', false, e.message);
      } finally {
        console.warn = origWarn;
      }
    }

    // S8 — redirect handling: re-validate each Location
    {
      const hops = [];
      const fetchImpl = async (url, init) => {
        hops.push({ url, redirect: init && init.redirect, pinned: init && init.pinnedAddresses });
        if (url === 'https://cdn.example/start.jpg') {
          return {
            status: 302,
            headers: { get: (n) => (n.toLowerCase() === 'location' ? 'http://169.254.169.254/meta' : null) },
            body: { cancel: async () => {} }
          };
        }
        return {
          status: 200,
          headers: { get: () => null },
          arrayBuffer: async () => whiteBuf.buffer.slice(
            whiteBuf.byteOffset,
            whiteBuf.byteOffset + whiteBuf.byteLength
          )
        };
      };
      const r = await safeFetchBuffer('https://cdn.example/start.jpg', {
        lookup: publicLookupOk,
        fetchImpl,
        maxRedirects: 5
      });
      check('S8a redirect mode is manual (not follow)',
        hops.length >= 1 && hops.every((h) => h.redirect === 'manual'),
        JSON.stringify(hops));
      check('S8b public→private redirect hop rejected as SSRF',
        r.ok === false && r.ssrfRejected === true &&
        /blocked_address:169\.254\.169\.254/.test(r.ssrfReason || r.error || ''),
        JSON.stringify(r));
      check('S8c private redirect hop never fetched',
        !hops.some((h) => /169\.254\.169\.254/.test(h.url)),
        JSON.stringify(hops));
      check('S8a2 first hop received pinnedAddresses from validated DNS',
        hops[0] && Array.isArray(hops[0].pinned) && hops[0].pinned.includes('8.8.8.8'),
        JSON.stringify(hops[0]));
    }
    // Benign public→public redirect still succeeds.
    {
      const hops = [];
      const fetchImpl = async (url, init) => {
        hops.push(url);
        if (url === 'https://cdn.example/start.jpg') {
          return {
            status: 302,
            headers: { get: (n) => (n.toLowerCase() === 'location' ? 'https://cdn.example/final.jpg' : null) },
            body: { cancel: async () => {} }
          };
        }
        return {
          status: 200,
          headers: { get: () => null },
          arrayBuffer: async () => whiteBuf.buffer.slice(
            whiteBuf.byteOffset,
            whiteBuf.byteOffset + whiteBuf.byteLength
          )
        };
      };
      const r = await safeFetchBuffer('https://cdn.example/start.jpg', {
        lookup: publicLookupOk,
        fetchImpl,
        maxRedirects: 5
      });
      check('S8d public→public redirect allowed after re-validation',
        r.ok === true && r.buffer && r.buffer.length > 0,
        JSON.stringify({ ok: r.ok, err: r.error, hops }));
      check('S8e both hops fetched under manual redirect policy',
        hops.length === 2 && hops[1] === 'https://cdn.example/final.jpg',
        JSON.stringify(hops));
    }

    // S_PIN — connection pin: makePinnedLookup returns ONLY validated addrs;
    // a real socket using that lookup connects to the pin, not a rebind.
    {
      checkFn('S_PIN_a makePinnedLookup returns only validated address', () => {
        const pinned = makePinnedLookup(['203.0.113.10']);
        let got = null;
        pinned('evil.example', { all: true }, (err, list) => {
          if (err) throw err;
          got = list;
        });
        assert.ok(Array.isArray(got) && got.length === 1);
        assert.strictEqual(got[0].address, '203.0.113.10');
      });

      // Live pin: local HTTP server. We pass addresses that include the
      // real listen IP AFTER validation is stubbed via fetchImpl path is not
      // used — instead exercise node path by temporarily using a non-blocked
      // test address... 203.0.113.0/24 is TEST-NET and blocked.
      // So: use http server on 127.0.0.1 but invoke makePinnedLookup +
      // http.request directly to prove the pin mechanism (not assertUrlSafe).
      await new Promise((resolve) => {
        const srv = http.createServer((req, res) => {
          res.end(`host=${req.headers.host}`);
        });
        srv.listen(0, '127.0.0.1', async () => {
          const port = srv.address().port;
          const pinned = makePinnedLookup(['127.0.0.1']);
          let body = '';
          try {
            body = await new Promise((res, rej) => {
              const req = http.request({
                hostname: 'rebind-looks-public.example',
                port,
                path: '/',
                method: 'GET',
                headers: { Host: 'rebind-looks-public.example' },
                lookup: pinned
              }, (r) => {
                let d = '';
                r.on('data', (c) => { d += c; });
                r.on('end', () => res(d));
              });
              req.on('error', rej);
              req.end();
            });
            check('S_PIN_b pinned lookup connects to validated IP not hostname re-resolve',
              body === 'host=rebind-looks-public.example',
              `body=${body}`);
          } catch (e) {
            check('S_PIN_b pinned lookup connects to validated IP not hostname re-resolve',
              false, e.message);
          } finally {
            srv.close();
            resolve();
          }
        });
      });
    }

    // S9 — source-level structure of the pin + post-DNS check
    {
      const src = read('services/ingestShotClassifyService.js');
      check('S9a assertUrlSafeForFetch exported and uses lookup',
        /async function assertUrlSafeForFetch/.test(src) &&
        /lookup\(/.test(src));
      check('S9b isBlockedIp applied to resolved addresses',
        /isBlockedIp\(addr\)/.test(src) || /isBlockedIp\(/.test(src));
      check('S9c no host allowlist of CDN domains',
        !/cdn\.shopify\.com/.test(src) && !/ALLOWED_HOSTS|hostAllowlist/.test(src));
      check('S9d httpScrapeClient.js was NOT modified (still no private-IP guard)',
        !/isBlockedIp|assertUrlSafe|ssrf|169\.254/.test(read('services/httpScrapeClient.js')));
      check('S9e live service file is not mutated by this harness (S10 safety)',
        !/NAIVE \(revert-prove\)/.test(src));
    }

    // S10 — REVERT-PROVE on a TEMP COPY only. Never write the live service.
    {
      const needle = /for \(const addr of addresses\) \{\s*if \(isBlockedIp\(addr\)\) \{\s*return \{\s*ok: false,\s*reason: `blocked_address:\$\{addr\}`,\s*addresses\s*\};\s*\}\s*\}/;
      const liveSrc = read('services/ingestShotClassifyService.js');
      check('S10a post-DNS address loop present for revert-prove',
        needle.test(liveSrc));

      if (needle.test(liveSrc)) {
        const naive = `
  // NAIVE (revert-prove TEMP COPY ONLY): hostname string match — NOT production.
  const hostLower = host.toLowerCase();
  const naiveBlocked =
    hostLower === 'localhost' ||
    hostLower.endsWith('.localhost') ||
    hostLower === 'metadata.google.internal' ||
    /^(127\\.|10\\.|192\\.168\\.|169\\.254\\.|172\\.(1[6-9]|2[0-9]|3[0-1])\\.)/.test(hostLower);
  if (naiveBlocked) {
    return { ok: false, reason: 'blocked_hostname:' + hostLower, addresses };
  }
`;
        let tmpPath = null;
        try {
          const { mod: mutatedIngest, tmp } = loadMutatedIngest((src) => {
            const m = src.replace(needle, naive);
            assert.notStrictEqual(m, src, 'mutation must change source');
            return m;
          });
          tmpPath = tmp;
          // Live file must still be intact
          check('S10b live service file unchanged after temp mutation',
            fs.readFileSync(path.join(ROOT, 'services/ingestShotClassifyService.js'), 'utf8') === liveSrc);

          const r = await mutatedIngest.assertUrlSafeForFetch(
            'https://evil-looks-public.example/product.jpg',
            {
              lookup: async () => [{ address: '169.254.169.254', family: 4 }]
            }
          );
          check('S10c REVERT-PROVE: naive hostname match ALLOWS resolves-to-private (demonstrates hole)',
            r.ok === true,
            `expected ok:true under naive match, got ${JSON.stringify(r)}`);
        } catch (e) {
          check('S10c REVERT-PROVE: naive hostname match ALLOWS resolves-to-private (demonstrates hole)',
            false, e.message);
        } finally {
          if (tmpPath) unloadTmp(tmpPath);
        }

        // Live module still rejects
        const r2 = await assertUrlSafeForFetch(
          'https://evil-looks-public.example/product.jpg',
          {
            lookup: async () => [{ address: '169.254.169.254', family: 4 }]
          }
        );
        check('S10d live post-DNS check still rejects resolves-to-private',
          r2.ok === false && /blocked_address:169\.254\.169\.254/.test(r2.reason),
          JSON.stringify(r2));
      }
    }

    // S10e — REVERT-PROVE IPv4-compatible branch specifically.
    // Strip the ::/96 re-check; the Round-4 bypass table must FAIL.
    {
      const liveSrc = read('services/ingestShotClassifyService.js');
      // The compatible-form block (first 96 bits zero, re-check embedded v4).
      const compatNeedle =
        /\/\/ ::\/96 IPv4-compatible[\s\S]*?return isBlockedIpv4\(hextetsToV4\(h\[6\], h\[7\]\)\);\s*\}/;
      check('S10e_pre IPv4-compatible ::/96 branch present for revert-prove',
        compatNeedle.test(liveSrc));

      if (compatNeedle.test(liveSrc)) {
        let tmpPath = null;
        try {
          const { mod: mutatedIngest, tmp } = loadMutatedIngest((src) => {
            const m = src.replace(compatNeedle, `
  // REVERTED (temp): IPv4-compatible ::/96 branch removed — demonstrates hole.
`);
            assert.notStrictEqual(m, src, 'compat mutation must change source');
            return m;
          });
          tmpPath = tmp;
          // Exact bypass strings from the verified table — must now ALLOW.
          const bypasses = [
            '::7f00:1',
            '::a9fe:a9fe',
            '::169.254.169.254',
            '::127.0.0.1',
            '::0a00:1'
          ];
          let anyAllowed = false;
          const results = {};
          for (const ip of bypasses) {
            const blocked = mutatedIngest.isBlockedIp(ip);
            results[ip] = blocked ? 'blocked' : 'ALLOW';
            if (!blocked) anyAllowed = true;
          }
          check('S10e REVERT-PROVE: without ::/96 branch, IPv4-compatible BYPASSES (table allows)',
            anyAllowed === true &&
            mutatedIngest.isBlockedIp('::7f00:1') === false &&
            mutatedIngest.isBlockedIp('::a9fe:a9fe') === false,
            JSON.stringify(results));
          // Mapped form must still be blocked (different branch)
          check('S10e2 REVERT-PROVE: IPv4-mapped still blocked after ::/96 removal',
            mutatedIngest.isBlockedIp('::ffff:127.0.0.1') === true &&
            mutatedIngest.isBlockedIp('::ffff:169.254.169.254') === true);
          // :: and ::1 must still be blocked (explicit early returns)
          check('S10e3 REVERT-PROVE: :: and ::1 still blocked after ::/96 removal',
            mutatedIngest.isBlockedIp('::') === true &&
            mutatedIngest.isBlockedIp('::1') === true);
        } catch (e) {
          check('S10e REVERT-PROVE: without ::/96 branch, IPv4-compatible BYPASSES (table allows)',
            false, e.message);
        } finally {
          if (tmpPath) unloadTmp(tmpPath);
        }
        // Live still blocks every table entry
        for (const ip of [
          '::7f00:1', '::a9fe:a9fe', '::169.254.169.254', '::127.0.0.1', '::0a00:1'
        ]) {
          check(`S10e_live live still blocks ${ip}`, isBlockedIp(ip) === true);
        }
      }
    }

    // S11 — single deadline across redirect hops (no per-hop timer reset)
    {
      let hop = 0;
      const fetchImpl = async (url, init) => {
        hop++;
        // Each hop sleeps 80ms; with 4 hops and a 200ms total deadline the
        // whole chain must abort (would succeed if timeout reset per hop).
        await new Promise((r, j) => {
          const t = setTimeout(r, 80);
          if (init && init.signal) {
            if (init.signal.aborted) {
              clearTimeout(t);
              j(Object.assign(new Error('aborted'), { name: 'AbortError' }));
              return;
            }
            init.signal.addEventListener('abort', () => {
              clearTimeout(t);
              j(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            }, { once: true });
          }
        });
        if (hop < 4) {
          return {
            status: 302,
            headers: { get: (n) => (n.toLowerCase() === 'location' ? `https://cdn.example/h${hop}.jpg` : null) },
            body: { cancel: async () => {} }
          };
        }
        return {
          status: 200,
          headers: { get: () => null },
          arrayBuffer: async () => whiteBuf.buffer.slice(
            whiteBuf.byteOffset,
            whiteBuf.byteOffset + whiteBuf.byteLength
          )
        };
      };
      const t0 = Date.now();
      const r = await safeFetchBuffer('https://cdn.example/start.jpg', {
        lookup: publicLookupOk,
        fetchImpl,
        timeoutMs: 200,
        maxRedirects: 5
      });
      const elapsed = Date.now() - t0;
      check('S11a multi-hop fetch aborts under single deadline (not per-hop stack)',
        r.ok === false && /timeout/i.test(r.error || ''),
        JSON.stringify({ ok: r.ok, err: r.error, hops: hop, elapsed }));
      check('S11b elapsed roughly matches deadline not hop×deadline',
        elapsed < 800,
        `elapsed=${elapsed}`);
    }
  }

  // ── summary ──────────────────────────────────────────────────────────────
  if (failures.length) {
    console.error(`❌ verifyIngestShotClassify: ${failures.length} FAILED, ${pass} passed\n`);
    for (const f of failures) console.error(`   • ${f}`);
    process.exit(1);
  }
  console.log(`✅ verifyIngestShotClassify: ${pass}/${pass} checks passed`);
}

main().catch((err) => {
  console.error('verifyIngestShotClassify crashed:', err);
  process.exit(1);
});
