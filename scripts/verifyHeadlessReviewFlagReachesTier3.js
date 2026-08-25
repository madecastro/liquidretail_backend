#!/usr/bin/env node
'use strict';
//
// verifyHeadlessReviewFlagReachesTier3 — `?headless=1` must actually run tier 3.
//
// ── THE DEFECT THIS PINS ────────────────────────────────────────────────
// `POST /api/sales-demos/brands/:id/sync-reviews?headless=1` is documented
// (routes/salesDemos.js, and docs/PIPELINES.md:293 — "Opt-in
// (REVIEW_HEADLESS_ENABLED=true OR ?headless=1)") as a per-call way to turn on
// the headless review tier for a store whose review widget renders client-side.
//
// It did nothing. Two independent gates guard tier 3 and only one of them was
// being satisfied:
//
//   1. productReviewsScrapeService decides WHETHER TO CALL captureReviews, from
//      the per-call `useHeadless` (which `?headless=1` sets).
//   2. reviewHeadlessCapture.captureReviews itself bails on its first lines
//      unless `REVIEW_HEADLESS_ENABLED === 'true'` OR `force` is passed —
//      and ENABLED is read at MODULE LOAD, so it cannot be set per call.
//
// The caller passed (1) and not (2), so every per-call request was silently
// discarded by the env default it existed to override.
//
// MEASURED, not theorised (2026-08-25): a Gymshark sync issued with
// `?force=1&headless=1` reported "0 captured · 0 with quotes · 0 with ratings ·
// 0 reviews read · 1600 skipped" and completed 1,600 products in ~7 minutes.
// The tier is documented at ~10-25s per product; 1,600 of those cannot fit in 7
// minutes. Every call had returned null instantly. That run was read as evidence
// that Gymshark exposes no reachable reviews. It was evidence of nothing.
//
// This harness is BEHAVIOURAL. It does not scan source text for `force: true` —
// a rename or a reimplementation that kept the string would pass such a check.
// It drives the real `fetchProductReviews` and the real `captureReviews`, and
// observes whether execution actually crosses each gate.
//
// Offline: no network (httpScrapeClient is stubbed), no Chrome (getBrowser is
// stubbed to throw a sentinel, which is itself the proof the gate was passed).
//
// Revert-prove:
//   node scripts/verifyHeadlessReviewFlagReachesTier3.js        → pass
//   delete `force: true` from the tier-3 call in
//     services/productReviewsScrapeService.js                   → check 4 FAILS
//   change it to `force: false`                                 → check 4 FAILS
//   make captureReviews ignore `force`                          → check 3 FAILS
//   revert catalogProductReviewRefreshService's option key back to
//     `allowHeadless: useHeadless`                               → check 6 FAILS
//
// ── SECOND INSTANCE, SAME DEFECT CLASS ──────────────────────────────────
// catalogProductReviewRefreshService computed `useHeadless` correctly (honouring
// an explicit allowHeadless override from its caller) and then passed it to
// fetchProductReviews under the key `allowHeadless` — which that function has
// never destructured. The value was dropped and useHeadless fell back to false,
// so tier 3 was unreachable through that service too. It backs the agent
// capabilities catalogRefreshReviewsForProduct / ForBrand and the onboarding
// review refresh, so all three could never use the headless tier either.
//
const assert = require('assert');
const path = require('path');

const failures = [];
const infos = [];
let checks = 0;

async function check(label, fn) {
  checks += 1;
  try { await fn(); } catch (err) { failures.push(`${label}: ${err.message}`); }
}
const info = (s) => infos.push(s);

const SVC_DIR = path.join(__dirname, '..', 'services');
const P_HEADLESS = path.join(SVC_DIR, 'reviewHeadlessCapture.js');
const P_SCRAPE   = path.join(SVC_DIR, 'headlessScrapeService.js');
const P_HTTP     = path.join(SVC_DIR, 'httpScrapeClient.js');
const P_REVIEWS  = path.join(SVC_DIR, 'productReviewsScrapeService.js');

// A product page with NO structured reviews — exactly the shape that makes the
// cheap tiers come up empty and hands control to tier 3.
const BARE_HTML = '<html><head><title>A Product</title></head><body><h1>A Product</h1></body></html>';

function freshRequire(p) { delete require.cache[require.resolve(p)]; return require(p); }

async function main() {
  // Precondition: the env var must be unset. With it set, checks 2 and 3 would
  // FAIL rather than pass vacuously (a browser would be reached without force) —
  // but the useful signal is gone, because `force` is then redundant.
  await check('env: REVIEW_HEADLESS_ENABLED is unset for this run', () => {
    assert.notStrictEqual(
      String(process.env.REVIEW_HEADLESS_ENABLED || '').toLowerCase(), 'true',
      'REVIEW_HEADLESS_ENABLED is true in this environment — unset it; otherwise this harness cannot distinguish the fix from the env default'
    );
  });

  // ── gate 2, negative: without force, captureReviews must not even reach a browser
  await check('captureReviews without force: bails BEFORE attempting a browser', async () => {
    delete require.cache[require.resolve(P_SCRAPE)];
    let reachedBrowser = false;
    require.cache[require.resolve(P_SCRAPE)] = {
      id: P_SCRAPE, filename: P_SCRAPE, loaded: true, exports: {
        getBrowser: async () => { reachedBrowser = true; throw new Error('SENTINEL'); }
      }
    };
    const headless = freshRequire(P_HEADLESS);
    assert.strictEqual(headless.ENABLED, false, 'ENABLED should be false with the env unset');
    const out = await headless.captureReviews('https://example.com/products/x');
    assert.strictEqual(out, null, 'expected null without force');
    assert.strictEqual(reachedBrowser, false,
      'captureReviews attempted a browser without force — the env gate is gone, which would make the tier run on every sync');
    info('gate 2 negative: env-off + no force → returns null without touching a browser');
  });

  // ── gate 2, positive: force must carry execution PAST the env gate
  await check('captureReviews with force: crosses the env gate', async () => {
    delete require.cache[require.resolve(P_SCRAPE)];
    let reachedBrowser = false;
    require.cache[require.resolve(P_SCRAPE)] = {
      id: P_SCRAPE, filename: P_SCRAPE, loaded: true, exports: {
        getBrowser: async () => { reachedBrowser = true; throw new Error('SENTINEL'); }
      }
    };
    const headless = freshRequire(P_HEADLESS);
    const out = await headless.captureReviews('https://example.com/products/x', { force: true });
    assert.strictEqual(reachedBrowser, true,
      'force:true did NOT reach the browser step — captureReviews is ignoring force, so no caller can enable tier 3 per call');
    assert.strictEqual(out, null, 'a failed getBrowser should degrade to null, not throw');
    info('gate 2 positive: env-off + force:true → execution reaches the browser step');
  });

  // ── gate 1 → gate 2: the REAL caller must pass force when useHeadless is asked for
  await check('fetchProductReviews({useHeadless:true}) passes force to tier 3', async () => {
    delete require.cache[require.resolve(P_HTTP)];
    require.cache[require.resolve(P_HTTP)] = {
      id: P_HTTP, filename: P_HTTP, loaded: true, exports: {
        isAllowedByRobots: async () => true,
        respectsRobots: () => true,
        fetchText: async () => ({ ok: true, status: 200, text: BARE_HTML, cfChallenged: false, rateLimited: false })
      }
    };
    let seenOpts = null;
    delete require.cache[require.resolve(P_HEADLESS)];
    require.cache[require.resolve(P_HEADLESS)] = {
      id: P_HEADLESS, filename: P_HEADLESS, loaded: true, exports: {
        ENABLED: false,
        captureReviews: async (_url, opts) => { seenOpts = opts || {}; return null; }
      }
    };
    const svc = freshRequire(P_REVIEWS);
    await svc.fetchProductReviews('https://example.com/products/x', {
      useHeadless: true, useAdapters: false
    });
    assert.ok(seenOpts, 'tier 3 was never invoked at all despite useHeadless:true — gate 1 is broken');
    assert.strictEqual(seenOpts.force, true,
      'tier 3 was invoked WITHOUT force:true — with REVIEW_HEADLESS_ENABLED unset it will return null instantly, and ?headless=1 is a silent no-op');
    info('gate 1→2: useHeadless:true reaches tier 3 carrying force:true');
  });

  // ── and the converse: not asking for headless must not silently turn it on
  await check('fetchProductReviews without useHeadless does not invoke tier 3', async () => {
    delete require.cache[require.resolve(P_HTTP)];
    require.cache[require.resolve(P_HTTP)] = {
      id: P_HTTP, filename: P_HTTP, loaded: true, exports: {
        isAllowedByRobots: async () => true,
        respectsRobots: () => true,
        fetchText: async () => ({ ok: true, status: 200, text: BARE_HTML, cfChallenged: false, rateLimited: false })
      }
    };
    let invoked = false;
    delete require.cache[require.resolve(P_HEADLESS)];
    require.cache[require.resolve(P_HEADLESS)] = {
      id: P_HEADLESS, filename: P_HEADLESS, loaded: true, exports: {
        ENABLED: false,
        captureReviews: async () => { invoked = true; return null; }
      }
    };
    const svc = freshRequire(P_REVIEWS);
    await svc.fetchProductReviews('https://example.com/products/x', { useAdapters: false });
    assert.strictEqual(invoked, false,
      'tier 3 ran without being asked — a browser per product is orders of magnitude more expensive than an HTTP GET');
    info('converse: no useHeadless → tier 3 not invoked (cost guard intact)');
  });

  // ── sibling path: catalogProductReviewRefreshService must pass the option
  //    under the key fetchProductReviews actually reads.
  await check('catalogProductReviewRefreshService forwards headless under the key fetchProductReviews reads', async () => {
    const P_REFRESH = path.join(SVC_DIR, 'catalogProductReviewRefreshService.js');
    const P_MODEL   = path.join(__dirname, '..', 'models', 'CatalogProduct.js');
    let seenOpts = null;
    delete require.cache[require.resolve(P_REVIEWS)];
    require.cache[require.resolve(P_REVIEWS)] = {
      id: P_REVIEWS, filename: P_REVIEWS, loaded: true, exports: {
        fetchProductReviews: async (_url, opts) => { seenOpts = opts || {}; return { ok: false, reason: 'stubbed' }; },
        buildProductReviews: () => null
      }
    };
    delete require.cache[require.resolve(P_MODEL)];
    require.cache[require.resolve(P_MODEL)] = {
      id: P_MODEL, filename: P_MODEL, loaded: true, exports: {
        findById: () => ({ select: () => ({ lean: async () => ({
          _id: 'p1', title: 'A Product', productUrl: 'https://example.com/products/x', brandId: 'b1'
        }) }) })
      }
    };
    const refresh = freshRequire(P_REFRESH);
    await refresh.refreshOne({ productId: 'p1', allowHeadless: true });
    assert.ok(seenOpts, 'fetchProductReviews was never called');
    assert.strictEqual(seenOpts.useHeadless, true,
      `refreshOne({allowHeadless:true}) forwarded ${JSON.stringify(seenOpts)} — fetchProductReviews destructures useHeadless and ignores anything else, so the override is silently dropped and tier 3 can never run through this service`);
    info('sibling: refreshOne({allowHeadless:true}) → fetchProductReviews({useHeadless:true})');
    delete require.cache[require.resolve(P_REFRESH)];
    delete require.cache[require.resolve(P_MODEL)];
  });

  // ── COST CONVERSE. These are the checks that must go red if anyone ever makes
  //    Chrome the default. A browser per product across a 1,600-SKU catalog is
  //    hours of Chrome on the web dyno; the auto-ingest paths must never opt in.
  const P_MODEL = path.join(__dirname, '..', 'models', 'CatalogProduct.js');
  const stubModel = () => {
    delete require.cache[require.resolve(P_MODEL)];
    require.cache[require.resolve(P_MODEL)] = {
      id: P_MODEL, filename: P_MODEL, loaded: true, exports: {
        findById: () => ({ select: () => ({ lean: async () => ({
          _id: 'p1', title: 'A Product', productUrl: 'https://example.com/products/x', brandId: 'b1'
        }) }) }),
        updateOne: async () => ({}),
        find: () => ({ select: () => ({ lean: async () => [] }) })
      }
    };
  };

  await check('AUTO-INGEST: captureForProduct(row) with no options never invokes tier 3', async () => {
    delete require.cache[require.resolve(P_HTTP)];
    require.cache[require.resolve(P_HTTP)] = {
      id: P_HTTP, filename: P_HTTP, loaded: true, exports: {
        isAllowedByRobots: async () => true, respectsRobots: () => true,
        fetchText: async () => ({ ok: true, status: 200, text: BARE_HTML, cfChallenged: false, rateLimited: false })
      }
    };
    let invoked = false;
    delete require.cache[require.resolve(P_HEADLESS)];
    require.cache[require.resolve(P_HEADLESS)] = {
      id: P_HEADLESS, filename: P_HEADLESS, loaded: true,
      exports: { ENABLED: false, captureReviews: async () => { invoked = true; return null; } }
    };
    stubModel();
    const svc = freshRequire(P_REVIEWS);
    await svc.captureForProduct(
      { _id: 'p1', title: 'A Product', productUrl: 'https://example.com/products/x' },
      { force: true, useAdapters: false }
    );
    assert.strictEqual(invoked, false,
      'captureForProduct with no useHeadless invoked tier 3 — this is the automatic enrichment path (catalogProductEnrichmentService:111) and would spend a browser on every product of every ingest');
    info('cost converse: captureForProduct(row) → tier 3 NOT invoked');
    delete require.cache[require.resolve(P_MODEL)];
  });

  await check('AUTO-INGEST: refreshOne({productId}) does not ask for headless', async () => {
    const P_REFRESH = path.join(SVC_DIR, 'catalogProductReviewRefreshService.js');
    let seenOpts = null;
    delete require.cache[require.resolve(P_REVIEWS)];
    require.cache[require.resolve(P_REVIEWS)] = {
      id: P_REVIEWS, filename: P_REVIEWS, loaded: true, exports: {
        fetchProductReviews: async (_u, o) => { seenOpts = o || {}; return { ok: false, reason: 'stubbed' }; },
        buildProductReviews: () => null
      }
    };
    stubModel();
    const refresh = freshRequire(P_REFRESH);
    await refresh.refreshOne({ productId: 'p1' });
    assert.ok(seenOpts, 'fetchProductReviews was never called');
    assert.notStrictEqual(seenOpts.useHeadless, true,
      'refreshOne with no allowHeadless asked for tier 3 — this backs catalogRefreshReviewsForBrand and the onboarding review refresh, neither of which is a human asking for Chrome');

    seenOpts = null;
    await refresh.refreshOne({ productId: 'p1', allowHeadless: false });
    assert.notStrictEqual(seenOpts.useHeadless, true,
      'refreshOne({allowHeadless:false}) still asked for tier 3 — an explicit refusal must be honoured');
    info('cost converse: refreshOne() and refreshOne({allowHeadless:false}) → useHeadless not true');
    delete require.cache[require.resolve(P_REFRESH)];
    delete require.cache[require.resolve(P_MODEL)];
  });

  for (const p of [P_HEADLESS, P_SCRAPE, P_HTTP, P_REVIEWS]) delete require.cache[require.resolve(p)];

  console.log(`verifyHeadlessReviewFlagReachesTier3: ${checks} check(s) against the real tier-3 call path.`);
  for (const i of infos) console.log(`  info: ${i}`);
  if (failures.length) {
    console.log(`\n❌ verifyHeadlessReviewFlagReachesTier3: ${failures.length} of ${checks} check(s) FAILED`);
    for (const f of failures) console.log(`   • ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n✅ verifyHeadlessReviewFlagReachesTier3: ${checks}/${checks} checks passed`);
}

main().catch((err) => { console.error(`verifyHeadlessReviewFlagReachesTier3 crashed: ${err.stack}`); process.exit(1); });
