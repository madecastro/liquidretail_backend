#!/usr/bin/env node
'use strict';
//
// verifyIngestBackgroundWorkSurvives — pins the "background work survives a
// short-lived caller's disconnect" invariant across ALL FIVE catalog ingest
// entry points, plus two visibility fixes.
//
// Groups A/B came from investigating a (later debunked) Marine Layer ingest
// "hang" report, 2026-08-19. The ingest itself was never stuck — it finished
// in 42.9 minutes after being rate-limited by marinelayer.com — but two real
// bugs surfaced along the way:
//
//   1. shopifyPublicIngestService.js's end-of-run trio (on-site review
//      scrape + catalog enrichment, category inference) used to fire via
//      setImmediate(). setImmediate() defers ONE tick — it does not keep
//      the caller's process (or its Mongoose connection) alive for that
//      tick. A short-lived caller that connects → syncs → disconnects can
//      tear the connection down first, and both triggers then throw
//      "Client must be connected before running operations" with nothing
//      but a console.warn to show it — measured live on a real re-ingest.
//      Same bug, same fix, in apifyIngestService.js's IG-side brand
//      enrichment trigger. Fix: call directly (no setImmediate — an async
//      function already yields at its first await) and expose the
//      resulting promises on the return value (`backgroundWork`) so a
//      caller that owns its own connection lifecycle can await them
//      first. Every existing HTTP/executor caller ignores the new field
//      and is unaffected — they stay connected for the process lifetime
//      anyway, which is why this was invisible before.
//
//   2. A mid-stage rate-limit break only pushed one line into `errors[]`,
//      which apifyIngestService.js's summary collapses to a bare COUNT.
//      An operator watching a completed run with videos=0/reviews=0 had
//      no way to tell "the store rate-limited us" from "there was nothing
//      to find". Fix: `run.note(...)` at the moment of the break (the
//      EXISTING progressService status channel, not a new one) plus
//      `mediaRateLimited` / `reviewsRateLimited` flags threaded through to
//      the caller's result object.
//
// Offline: source-text assertions only (no DB / network / key) — same
// style as verifyBrandWebsiteBackfill.js's E-group, for the same reason:
// a full behavioral test would need to mock Mongoose's live-connection
// state, which is exactly the thing under test. Each check targets a
// SPECIFIC line shape, not a loose substring, so a cosmetic reformat is
// unlikely to false-negative and a real regression is unlikely to
// false-positive.
//
// Groups C/D/E/F (phase 2, same day) close the SAME bug in the three ingest
// paths PR #233 did not touch — see the block above Group C. Group F is the
// cross-cutting sweep: all five entry points, one assertion.
//
// Revert-proven: restoring ANY of the five setImmediate() call sites, or
// dropping `backgroundWork` from any return value, or dropping either
// `run.note()` rate-limit call, or dropping either of the two out.shopify
// forwardings, fails the corresponding check below.
//
// Usage: node scripts/verifyIngestBackgroundWorkSurvives.js

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`✗ ${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

const shopifySrc = fs.readFileSync(path.join(__dirname, '../services/shopifyPublicIngestService.js'), 'utf8');
const apifySrc = fs.readFileSync(path.join(__dirname, '../services/apifyIngestService.js'), 'utf8');

// ── Group A: end-of-run trio no longer uses setImmediate ────────────────

check('A1: shopifyPublicIngestService.js end-of-run trio contains no setImmediate', () => {
  // Scope the assertion to the CODE region (starting after the explanatory
  // comment, which legitimately narrates the old setImmediate() bug in
  // prose) so an unrelated future setImmediate elsewhere in the file
  // cannot make this check meaningless, and so the comment's own history
  // does not trip it.
  const codeStart = shopifySrc.indexOf('const cancelled = await abortCheck(brand._id, run);\n  const backgroundWork = [];');
  assert.ok(codeStart > -1, 'end-of-run trio code start not found — file changed shape?');
  const trioRegion = shopifySrc.slice(codeStart, codeStart + 2500);
  assert.ok(!trioRegion.includes('setImmediate(() =>'), 'the end-of-run trio CODE must not defer via setImmediate — see ROBUSTNESS comment');
  assert.ok(trioRegion.includes('backgroundWork.push('), 'the trio must collect its background promises for the caller to await');
});

check('A2: syncBrandShopifyDirect returns backgroundWork on its result object', () => {
  assert.ok(/const out = \{[^}]*backgroundWork/s.test(shopifySrc), 'returned `out` must carry backgroundWork');
});

check('A3: apifyIngestService.js forwards shopifyPublicIngestService\'s backgroundWork onto out.shopify', () => {
  const shopBlockStart = apifySrc.indexOf("} else if (method === 'shopify-direct') {");
  assert.ok(shopBlockStart > -1, 'shopify-direct branch not found — file changed shape?');
  const shopBlock = apifySrc.slice(shopBlockStart, shopBlockStart + 1400);
  assert.ok(shopBlock.includes('r.backgroundWork'), 'out.shopify must forward r.backgroundWork from the shopify-direct result');
  assert.ok(shopBlock.includes('backgroundWork: r.backgroundWork'), 'must be keyed as backgroundWork on out.shopify');
});

check('A4: apifyIngestService.js\'s IG-side brand-enrichment trigger no longer uses setImmediate', () => {
  const igStart = apifySrc.indexOf('async function syncBrandInstagram');
  assert.ok(igStart > -1, 'syncBrandInstagram not found — file changed shape?');
  const igEnd = apifySrc.indexOf('async function ingestIgPost');
  assert.ok(igEnd > igStart, 'ingestIgPost not found after syncBrandInstagram — file changed shape?');
  const igRegion = apifySrc.slice(igStart, igEnd);
  assert.ok(!igRegion.includes('setImmediate(() =>'), 'the IG-side enrichment trigger CODE must not defer via setImmediate (comment prose narrating the old bug is fine)');
  assert.ok(
    igRegion.includes("summary.backgroundWork = [") && igRegion.includes("require('./brandEnrichmentService')"),
    'summary must expose the enrichment promise as backgroundWork'
  );
});

// ── Group B: rate-limit visibility ───────────────────────────────────────

check('B1: media-stage rate-limit break notes the run AND sets a flag', () => {
  const idx = shopifySrc.indexOf('media stage rate-limited at handle');
  assert.ok(idx > -1);
  const region = shopifySrc.slice(idx - 200, idx + 400);
  assert.ok(region.includes('mediaRateLimited = true'), 'the flag must be set at the break site');
  assert.ok(region.includes("run?.note?.("), 'the break must push a note through the existing progressService status channel');
});

check('B2: reviews-stage rate-limit break notes the run AND sets a flag', () => {
  const idx = shopifySrc.indexOf('reviews stage rate-limited at handle');
  assert.ok(idx > -1);
  const region = shopifySrc.slice(idx - 200, idx + 400);
  assert.ok(region.includes('reviewsRateLimited = true'), 'the flag must be set at the break site');
  assert.ok(region.includes("run?.note?.("), 'the break must push a note through the existing progressService status channel');
});

check('B3: both flags survive onto the returned result, not just the internal errors[] count', () => {
  assert.ok(/if \(mediaRateLimited\) out\.mediaRateLimited = true;/.test(shopifySrc));
  assert.ok(/if \(reviewsRateLimited\) out\.reviewsRateLimited = true;/.test(shopifySrc));
});

check('B4: apifyIngestService.js forwards both rate-limit flags onto out.shopify', () => {
  const shopBlockStart = apifySrc.indexOf("} else if (method === 'shopify-direct') {");
  assert.ok(shopBlockStart > -1, 'shopify-direct branch not found — file changed shape?');
  const shopBlock = apifySrc.slice(shopBlockStart, shopBlockStart + 1400);
  assert.ok(shopBlock.includes('mediaRateLimited: true'), 'must forward mediaRateLimited');
  assert.ok(shopBlock.includes('reviewsRateLimited: true'), 'must forward reviewsRateLimited');
});

// ── Phase 2 (2026-08-19): the SAME setImmediate pattern, three more sites ─
//
// PR #233 fixed shopifyPublicIngestService's end-of-run trio and
// apifyIngestService's IG-side enrichment trigger (Groups A/B above). The
// identical bug survived, unfixed, in the other three catalog ingest paths.
// All three are now converted to the same shape and pinned here:
//
//   C. catalogSyncService.js#syncCatalogForCred — the Meta / IG-Commerce
//      OAuth path. THREE triggers (enrichment + materialize/YOLO-detect
//      chain + category inference).
//   D. genericCatalogIngestService.js#syncBrandGenericCatalog — the
//      XML-sitemap + JSON-LD path for non-Shopify stores. THREE triggers
//      (same three as C).
//   E. apifyIngestService.js#syncBrandShopify — the LEGACY `apify` method
//      path (distinct from the shopify-direct and IG paths already fixed).
//      TWO triggers (enrichment + materialize/YOLO-detect chain — this
//      legacy path has no category-inference trigger).
//
//   The materialize/YOLO-detect chain (catalogMediaMaterializeService +
//   catalogYoloDetectionService, both idempotent — see their own headers)
//   was added to ALL FOUR sync paths (catalog-sync, shopify-public, apify,
//   generic) by a later commit — bb91303c "feat(catalog): ingest-time
//   YOLO detection + materialize peer to enrichment" — landed AFTER this
//   harness's Group C/D/E were written against PR #235's two/two/one
//   trigger counts. It is a genuine new, non-duplicate background task —
//   it populates Media.refinedProducts[] for reframe / videoProductAnchor
//   / pmaxSplitStrategy / quoteProvenance so ad-gen can skip the paid
//   nano-banana outpaint, something neither the enrichment nor the
//   category-inference trigger touches — chained after the existing
//   enrichment push in each path, per that commit's own message.
//   shopifyPublicIngestService.js (Groups A/F) was never pinned to an
//   EXACT trigger count, so it did not go red when the new chain landed;
//   C/D/E were pinned to exact counts and did. The counts below (3/3/2)
//   are corrected to match the current, intentional shape.
//
// "No setImmediate" is asserted against COMMENT-STRIPPED source, because
// every one of these call sites now carries a ROBUSTNESS comment that
// legitimately narrates the old setImmediate() bug in prose. Stripping is
// deliberately conservative — only whole-line `//` comments and `/* */`
// blocks are removed, never a trailing `// …` after code, so the stripper
// can never delete real code and hide a regression.

// Remove whole-line // comments and /* */ blocks. Conservative by design:
// a trailing comment after code is LEFT IN PLACE, so this can only ever
// produce a false FAILURE (loud, immediately noticed), never a false pass.
function stripComments(src) {
  const noBlocks = src.replace(/\/\*[\s\S]*?\*\//g, '');
  return noBlocks
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n');
}

// Slice [startAnchor, endAnchor) out of src, asserting both anchors exist
// and are ordered. Anchors are precise multi-line code shapes, not loose
// substrings, so a real regression fails but a cosmetic reflow does not.
function region(src, startAnchor, endAnchor, label) {
  const a = src.indexOf(startAnchor);
  assert.ok(a > -1, `${label}: start anchor not found — file changed shape? (${startAnchor.split('\n')[0]})`);
  const b = src.indexOf(endAnchor, a);
  assert.ok(b > a, `${label}: end anchor not found after start — file changed shape? (${endAnchor.split('\n')[0]})`);
  return src.slice(a, b);
}

// Two acceptable shapes for the materialize+YOLO-detect chain
// (C2 / D1 / E1):
//   (old) direct in-line require of catalogMediaMaterializeService +
//         catalogYoloDetectionService — landed bb91303c
//   (new) delegates to catalogPostSyncOrchestrator.runPostSyncChain
//         — commit 31469b82 "fix(catalog-post-sync): resilient
//         orchestrator + reconcile tick"
// The orchestrator itself is separately pinned by
// scripts/verifyPostSyncOrchestrator.js — that harness owns the
// "orchestrator actually calls both underlying services" assertion,
// so we can accept the delegation here without duplicating the check.
function hasMaterializeYoloChain(r) {
  const inline = r.includes("require('./catalogMediaMaterializeService')") &&
    r.includes("require('./catalogYoloDetectionService')");
  const viaOrchestrator = r.includes("require('./catalogPostSyncOrchestrator')") &&
    /runPostSyncChain\(/.test(r);
  return inline || viaOrchestrator;
}

const catalogSyncSrc = fs.readFileSync(path.join(__dirname, '../services/catalogSyncService.js'), 'utf8');
const genericSrc = fs.readFileSync(path.join(__dirname, '../services/genericCatalogIngestService.js'), 'utf8');
const integrationsSrc = fs.readFileSync(path.join(__dirname, '../routes/integrations.js'), 'utf8');

// ── Group C: catalogSyncService.js (Meta / IG-Commerce OAuth path) ──────

check('C1: syncCatalogForCred\'s end-of-run triggers contain no setImmediate CODE', () => {
  const r = region(
    catalogSyncSrc,
    '  const backgroundWork = [];\n\n  // Eager review + commerce enrichment',
    '  return {\n    ok: true,',
    'C1'
  );
  assert.ok(!stripComments(r).includes('setImmediate('), 'the end-of-run triggers must not defer via setImmediate — see the ROBUSTNESS comment');
  assert.ok(r.includes('backgroundWork.push('), 'the triggers must collect their promises for the caller to await');
});

check('C2: ALL THREE catalogSyncService triggers are collected (enrichment, materialize+YOLO-detect chain, category inference)', () => {
  const r = region(
    catalogSyncSrc,
    '  const backgroundWork = [];\n\n  // Eager review + commerce enrichment',
    '  return {\n    ok: true,',
    'C2'
  );
  assert.ok(r.includes("require('./catalogProductEnrichmentService')"), 'enrichment trigger missing from the collected region');
  assert.ok(
    hasMaterializeYoloChain(r),
    'materialize+YOLO-detect chain missing from the collected region — expected either the inline catalogMediaMaterializeService + catalogYoloDetectionService requires (bb91303c) or catalogPostSyncOrchestrator.runPostSyncChain (31469b82)'
  );
  assert.ok(r.includes("require('./productCategoryInferenceService')"), 'category-inference trigger missing from the collected region');
  // Exactly three pushes: enrichment, the materialize+YOLO-detect chain
  // (one push wrapping two chained awaits), and category inference. A
  // fourth would mean an uncollected trigger crept in or one was
  // duplicated.
  assert.equal((r.match(/backgroundWork\.push\(/g) || []).length, 3, 'expected exactly 3 collected triggers in syncCatalogForCred');
});

check('C3: syncCatalogForCred returns backgroundWork on its result object', () => {
  assert.ok(
    /durationMs: Date\.now\(\) - t0,[\s\S]{0,500}?\n {4}backgroundWork\n {2}\};/.test(catalogSyncSrc),
    'the returned literal must carry backgroundWork'
  );
});

check('C4: syncCatalog aggregates backgroundWork ACROSS credentials, not last-wins', () => {
  assert.ok(/const aggregated = \{[^}]*backgroundWork: \[\]/.test(catalogSyncSrc), 'aggregated must initialise backgroundWork: []');
  assert.ok(
    catalogSyncSrc.includes('if (Array.isArray(credBackgroundWork)) aggregated.backgroundWork.push(...credBackgroundWork);'),
    'each credential\'s promises must be appended to the aggregate'
  );
  // perCredential rows are pure data (they get serialized) — the promises
  // must be destructured OUT of the spread, not carried along twice.
  assert.ok(
    catalogSyncSrc.includes('const { backgroundWork: credBackgroundWork, ...credSummary } = r;'),
    'perCredential rows must exclude backgroundWork (they are serialized into HTTP/agent payloads)'
  );
  assert.ok(
    !/perCredential\.push\(\{ credentialId: String\(c\._id\), igUsername: c\.igUsername, \.\.\.r \}\)/.test(catalogSyncSrc),
    'perCredential must not spread the raw result (that would re-introduce the promises)'
  );
});

check('C5: the sync-catalog HTTP route strips backgroundWork before res.json', () => {
  const idx = integrationsSrc.indexOf('const result = await syncCatalog(brandId, credentialId ? { credentialId } : {});');
  assert.ok(idx > -1, 'sync-catalog route call site not found — file changed shape?');
  const r = integrationsSrc.slice(idx, idx + 900);
  assert.ok(r.includes('const { backgroundWork: _backgroundWork, ...body } = result;'), 'the route must strip backgroundWork (a Promise serializes to a useless {})');
  assert.ok(r.includes('res.json(body);') && !r.includes('res.json(result);'), 'the route must send the stripped body, not the raw result');
});

// ── Group D: genericCatalogIngestService.js (sitemap + JSON-LD path) ─────

check('D1: syncBrandGenericCatalog\'s end-of-run triggers contain no setImmediate CODE', () => {
  const r = region(
    genericSrc,
    '  const backgroundWork = [];\n  if (!cancelled) {',
    '  const durationMs = Date.now() - t0;',
    'D1'
  );
  assert.ok(!stripComments(r).includes('setImmediate('), 'the end-of-run triggers must not defer via setImmediate — see the ROBUSTNESS comment');
  assert.equal(
    (r.match(/backgroundWork\.push\(/g) || []).length, 3,
    'expected exactly 3 collected triggers (enrichment + materialize/YOLO-detect chain + category inference)'
  );
  assert.ok(r.includes("require('./catalogProductEnrichmentService')"), 'enrichment trigger missing from the collected region');
  assert.ok(
    hasMaterializeYoloChain(r),
    'materialize+YOLO-detect chain missing from the collected region — expected either the inline catalogMediaMaterializeService + catalogYoloDetectionService requires (bb91303c) or catalogPostSyncOrchestrator.runPostSyncChain (31469b82)'
  );
  assert.ok(r.includes("require('./productCategoryInferenceService')"), 'category-inference trigger missing from the collected region');
});

check('D2: backgroundWork is declared OUTSIDE the !cancelled guard so `out` always carries an array', () => {
  const declIdx = genericSrc.indexOf('  const backgroundWork = [];\n  if (!cancelled) {');
  assert.ok(declIdx > -1, 'declaration must sit immediately before the `if (!cancelled)` guard, not inside it');
});

check('D3: syncBrandGenericCatalog returns backgroundWork on `out`', () => {
  assert.ok(
    /const out = \{[\s\S]{0,600}?\n {4}backgroundWork\n {2}\};/.test(genericSrc),
    'returned `out` must carry backgroundWork'
  );
});

check('D4: apifyIngestService forwards genericCatalogIngestService\'s backgroundWork onto out.shopify', () => {
  const genBlockStart = apifySrc.indexOf("if (method === 'generic-sitemap') {");
  assert.ok(genBlockStart > -1, 'generic-sitemap branch not found — file changed shape?');
  const genBlock = apifySrc.slice(genBlockStart, genBlockStart + 1800);
  assert.ok(genBlock.includes('backgroundWork: r.backgroundWork'), 'out.shopify must forward r.backgroundWork on the generic-sitemap branch');
});

// ── Group E: apifyIngestService.js legacy syncBrandShopify (`apify`) ─────

check('E1: legacy syncBrandShopify\'s background triggers contain no setImmediate CODE', () => {
  const r = region(
    apifySrc,
    '  const backgroundWork = [];\n  if (!summary.aborted',
    '  summary.durationMs = Date.now() - t0;',
    'E1'
  );
  assert.ok(!stripComments(r).includes('setImmediate('), 'the legacy path\'s background triggers must not defer via setImmediate — see the ROBUSTNESS comment');
  assert.equal(
    (r.match(/backgroundWork\.push\(/g) || []).length, 2,
    'expected exactly 2 collected triggers (catalog enrichment + materialize/YOLO-detect chain)'
  );
  assert.ok(r.includes("require('./catalogProductEnrichmentService')"), 'enrichment trigger missing from the collected region');
  assert.ok(
    hasMaterializeYoloChain(r),
    'materialize+YOLO-detect chain missing from the collected region — expected either the inline catalogMediaMaterializeService + catalogYoloDetectionService requires (bb91303c) or catalogPostSyncOrchestrator.runPostSyncChain (31469b82) — this legacy path has no category-inference trigger'
  );
});

check('E2: legacy syncBrandShopify exposes backgroundWork on its summary', () => {
  assert.ok(apifySrc.includes('summary.backgroundWork = backgroundWork;'), 'summary must expose the collected promises');
  // Declared outside the abort guard so the field is always an array.
  const declIdx = apifySrc.indexOf('  const backgroundWork = [];\n  if (!summary.aborted');
  assert.ok(declIdx > -1, 'declaration must sit immediately before the abort guard, not inside it');
});

check('E3: syncBrandApify forwards the legacy summary (and thus backgroundWork) onto out.shopify', () => {
  // The legacy branch assigns the WHOLE summary, so backgroundWork rides
  // along with no explicit forwarding needed. Pin that shape — a future
  // refactor to a field-by-field literal would silently drop it, exactly
  // like the generic-sitemap branch would have (see D4).
  assert.ok(
    /\} else \{\n\s*out\.shopify = await syncBrandShopify\(brand, run(?:,\s*[^;]+)?\);\n\s*\}/.test(apifySrc),
    'the legacy branch must assign the whole summary to out.shopify (field-by-field would drop backgroundWork)'
  );
});

// ── Group F: cross-cutting — every fixed ingest path, no setImmediate ────

check('F1: none of the five fixed ingest entry points retain setImmediate in CODE', () => {
  const regions = [
    ['shopifyPublicIngestService end-of-run trio', region(shopifySrc, '  const cancelled = await abortCheck(brand._id, run);\n  const backgroundWork = [];', '  const durationMs = Date.now() - t0;', 'F1a')],
    ['apifyIngestService syncBrandInstagram', region(apifySrc, 'async function syncBrandInstagram', 'async function ingestIgPost', 'F1b')],
    ['apifyIngestService syncBrandShopify', region(apifySrc, '  const backgroundWork = [];\n  if (!summary.aborted', '  summary.durationMs = Date.now() - t0;', 'F1c')],
    ['catalogSyncService syncCatalogForCred', region(catalogSyncSrc, '  const backgroundWork = [];\n\n  // Eager review + commerce enrichment', '  return {\n    ok: true,', 'F1d')],
    ['genericCatalogIngestService trio', region(genericSrc, '  const backgroundWork = [];\n  if (!cancelled) {', '  const durationMs = Date.now() - t0;', 'F1e')]
  ];
  for (const [label, r] of regions) {
    assert.ok(!stripComments(r).includes('setImmediate('), `${label} still defers a background trigger via setImmediate`);
  }
});

// ── summary ─────────────────────────────────────────────────────────

const total = passed + failed;
console.log(`${passed}/${total} checks passed`);
process.exit(failed ? 1 : 0);
