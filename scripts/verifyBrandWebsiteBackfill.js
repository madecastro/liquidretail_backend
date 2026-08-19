#!/usr/bin/env node
'use strict';
//
// verifyBrandWebsiteBackfill — pins the fix for "brand enrichment silently
// no-ops when Brand.websiteUrl is missing, and records no failure" (the
// Marine Layer / GymShark bug, 2026-08-18/19).
//
// Two things this pins, both money/correctness-adjacent (a bad host here
// poisons enrichment/logo/font scraping for a brand indefinitely, and a
// silent skip is exactly the invisible-failure class this file exists to
// close):
//
//   1. services/brandWebsiteBackfill.js — safeWebsiteOrigin()'s host
//      denylist (myshopify.com effective-backend hosts, CDN/thumbnail
//      hosts) and backfillBrandWebsiteUrl()'s write guard (never overwrite
//      an existing websiteUrl, never touch a curated brand).
//   2. services/brandEnrichmentService.js — enrichBrandFromUrl() now
//      RECORDS why it declined (Brand.enrichmentSkipReason /
//      enrichmentSkippedAt) instead of silently discarding the reason,
//      and clears that record once it actually proceeds.
//
// Offline: no DB, no network, no key. Mongoose model statics
// (Brand.findOneAndUpdate / Brand.findById / Brand.updateOne) are stubbed
// with an in-memory fake for the duration of each check, then restored —
// same technique as scripts/testAdRunSelection.js. Every behavioral check
// calls the REAL exported function, never a re-implemented copy — a
// source-text regex cannot see a host denylist that got emptied, or a
// $set payload that got dropped.
//
// Revert-proven 2026-08-19 against three mutations (see the commit this
// harness landed with): removing 'myshopify.com' from BLOCKED_HOST_SUFFIXES
// → group A fails; deleting the markEnrichmentSkipped call at the
// `!brand.websiteUrl` early return → group C fails; dropping the
// `source: {$ne:'curated'}` clause from backfillBrandWebsiteUrl's filter
// → group B fails.
//
// Usage: node scripts/verifyBrandWebsiteBackfill.js

const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Brand = require('../models/Brand');
const { safeWebsiteOrigin, backfillBrandWebsiteUrl, isPrivateOrLoopbackHost, BLOCKED_HOST_SUFFIXES } = require('../services/brandWebsiteBackfill');

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

const asyncChecks = [];
function checkAsync(name, fn) {
  asyncChecks.push(async () => {
    try {
      await fn();
      passed += 1;
      console.log(`✓ ${name}`);
    } catch (err) {
      failed += 1;
      console.log(`✗ ${name}: ${err && err.message ? err.message : String(err)}`);
    }
  });
}

// ── Group A — safeWebsiteOrigin() host safety (pure, no stubbing) ────

check('A1: bare domain gets normalized to an https origin', () => {
  assert.equal(safeWebsiteOrigin('marinelayer.com'), 'https://marinelayer.com');
});
check('A2: full URL with path/query collapses to origin only', () => {
  assert.equal(safeWebsiteOrigin('https://www.gymshark.com/products/foo?x=1'), 'https://www.gymshark.com');
});
check('A3: myshopify.com effective-backend host is REJECTED', () => {
  // GymShark's real productUrl rows are minted against this exact host
  // (headless-store discovery) while apifyDemo.shopifyUrl correctly holds
  // www.gymshark.com — this is the concrete bug a naive rule would hit.
  assert.equal(safeWebsiteOrigin('https://gymsharkusa.myshopify.com/products/x'), null);
});
check('A4: bare "myshopify.com" host (no subdomain) is REJECTED', () => {
  assert.equal(safeWebsiteOrigin('https://myshopify.com'), null);
});
check('A5: cdn.shopify.com is REJECTED', () => {
  assert.equal(safeWebsiteOrigin('https://cdn.shopify.com/s/files/1/0001/products/x.jpg'), null);
});
check('A6: gstatic.com thumbnail hosts are REJECTED', () => {
  assert.equal(safeWebsiteOrigin('https://encrypted-tbn0.gstatic.com/images?q=x'), null);
});
check('A7: cloudinary.com (our own media mirror) is REJECTED', () => {
  assert.equal(safeWebsiteOrigin('https://res.cloudinary.com/reach-social-prod/image/upload/x.png'), null);
});
check('A8: googleusercontent.com is REJECTED', () => {
  assert.equal(safeWebsiteOrigin('https://lh3.googleusercontent.com/x'), null);
});
check('A9: garbage / unparseable input returns null, never throws', () => {
  assert.equal(safeWebsiteOrigin('not a url at all :: ///'), null);
  assert.equal(safeWebsiteOrigin(''), null);
  assert.equal(safeWebsiteOrigin(null), null);
  assert.equal(safeWebsiteOrigin(undefined), null);
  assert.equal(safeWebsiteOrigin(12345), null);
});
check('A10: a legitimate storefront host is NOT collateral damage from the denylist', () => {
  // Sanity check that the denylist is host-suffix-scoped, not a substring
  // ban that would false-positive on an unrelated brand.
  assert.equal(safeWebsiteOrigin('https://www.marinelayer.com'), 'https://www.marinelayer.com');
  assert.equal(safeWebsiteOrigin('https://shopify.com'), 'https://shopify.com'); // NOT cdn.shopify.com
});
// SSRF hardening (added 2026-08-19, coordinator review of PR #221) — a
// candidate can come from SCRAPED CatalogProduct.productUrl data (content
// this app does not control), and websiteUrl is then axios.get'd verbatim,
// repeatedly, by three services. A11-A20 pin the private/loopback/link-
// local denylist and the non-http(s)-scheme rejection.

check('A11: cloud-metadata / link-local (169.254.0.0/16) is REJECTED', () => {
  assert.equal(safeWebsiteOrigin('http://169.254.169.254/latest/meta-data/'), null);
  assert.equal(safeWebsiteOrigin('169.254.169.254'), null);
});
check('A12: loopback (127.0.0.0/8, incl. short form) is REJECTED', () => {
  assert.equal(safeWebsiteOrigin('http://127.0.0.1/'), null);
  assert.equal(safeWebsiteOrigin('http://127.1/'), null); // short-form loopback
});
check('A13: RFC1918 private ranges are REJECTED, and the /12 boundary is exact', () => {
  assert.equal(safeWebsiteOrigin('http://10.0.0.5/'), null);
  assert.equal(safeWebsiteOrigin('http://192.168.1.1/'), null);
  assert.equal(safeWebsiteOrigin('http://172.16.0.1/'), null);
  assert.equal(safeWebsiteOrigin('http://172.31.255.255/'), null);
  // 172.32.0.0 is OUTSIDE 172.16.0.0/12 — must NOT be collateral damage.
  assert.equal(safeWebsiteOrigin('http://172.32.0.1/'), 'http://172.32.0.1');
});
check('A14: 0.0.0.0 is REJECTED', () => {
  assert.equal(safeWebsiteOrigin('http://0.0.0.0/'), null);
});
check('A15: numeric/hex/octal IPv4 obfuscation is REJECTED (Node canonicalizes to dotted-quad before this code inspects it)', () => {
  assert.equal(safeWebsiteOrigin('http://2130706433/'), null);   // decimal 127.0.0.1
  assert.equal(safeWebsiteOrigin('http://0x7f000001/'), null);   // hex 127.0.0.1
  assert.equal(safeWebsiteOrigin('http://017700000001/'), null); // octal 127.0.0.1
});
check('A16: IPv6 loopback / link-local / unique-local / IPv4-mapped forms are REJECTED', () => {
  assert.equal(safeWebsiteOrigin('http://[::1]/'), null);
  assert.equal(safeWebsiteOrigin('http://[fe80::1]/'), null);   // fe80::/10
  assert.equal(safeWebsiteOrigin('http://[fc00::1]/'), null);   // fc00::/7
  assert.equal(safeWebsiteOrigin('http://[::ffff:127.0.0.1]/'), null); // dotted form
  // Node canonicalizes ::ffff:169.254.169.254 to the hex-group form
  // (::ffff:a9fe:a9fe) — isPrivateOrLoopbackHost must decode that, not
  // just match a dotted-quad string.
  assert.equal(safeWebsiteOrigin('http://[::ffff:169.254.169.254]/'), null);
});
check('A17: userinfo / fragment host-confusion tricks resolve to the REAL host, which still gets checked', () => {
  // new URL() already separates userinfo/fragment from the actual host —
  // this pins that safeWebsiteOrigin does not get fooled by trusting the
  // pre-parse string instead of `url.hostname`.
  assert.equal(safeWebsiteOrigin('evil.com@169.254.169.254'), null);
  assert.equal(safeWebsiteOrigin('https://evil.com@169.254.169.254/'), null);
  assert.equal(safeWebsiteOrigin('https://169.254.169.254#evil.com'), null);
});
check('A18: non-http(s) schemes are REJECTED outright, not silently reinterpreted as a hostname', () => {
  assert.equal(safeWebsiteOrigin('file:///etc/passwd'), null);
  assert.equal(safeWebsiteOrigin('javascript:alert(1)'), null);
  assert.equal(safeWebsiteOrigin('data:text/html,x'), null);
  assert.equal(safeWebsiteOrigin('gopher://evil.com'), null);
  assert.equal(safeWebsiteOrigin('ftp://evil.com/x'), null);
});
check('A19: protocol-relative ("//host/path") needs no special case — it degrades through the https-prepend fallback and still hits every hostname-safety check below', () => {
  // Revert-prove note: an explicit "reject //... outright" branch was
  // tried here first and REMOVED after this exact test proved it dead —
  // prepending "https:" in front of "//host/path" yields "https:////host/path",
  // which the WHATWG parser still resolves to the real host, so the
  // private-IP and CDN denylist checks already cover it. A safe host must
  // still resolve normally (not become collateral damage of a blanket ban).
  assert.equal(safeWebsiteOrigin('//169.254.169.254/latest'), null);
  assert.equal(safeWebsiteOrigin('//cdn.shopify.com/x.jpg'), null);
  assert.equal(safeWebsiteOrigin('//example.com/path'), 'https://example.com');
});
check('A20: localhost / .internal / .local hostname conventions are REJECTED', () => {
  assert.equal(safeWebsiteOrigin('http://localhost:3000/'), null);
  assert.equal(safeWebsiteOrigin('foo.internal'), null);
  assert.equal(safeWebsiteOrigin('foo.local'), null);
  assert.equal(safeWebsiteOrigin('foo.localhost'), null);
});
check('isPrivateOrLoopbackHost: a public DNS name that merely starts with digits is NOT an IP literal', () => {
  // Regression guard for a substring-matching implementation — "10.0.0.5"
  // is private, but a real hostname must never be judged by a text prefix.
  assert.equal(isPrivateOrLoopbackHost('10.example.com'), false);
  assert.equal(isPrivateOrLoopbackHost('169.254.example.com'), false);
});

check('BLOCKED_HOST_SUFFIXES is exported and non-empty (so a future caller can extend it)', () => {
  assert.ok(Array.isArray(BLOCKED_HOST_SUFFIXES) && BLOCKED_HOST_SUFFIXES.length >= 4);
});

// ── Group B — backfillBrandWebsiteUrl() write guard (behavioral) ─────

function installBrandStub({ findOneAndUpdateReturns = null } = {}) {
  const realFindOneAndUpdate = Brand.findOneAndUpdate;
  const calls = [];
  Brand.findOneAndUpdate = async (filter, update, opts) => {
    calls.push({ filter, update, opts });
    return typeof findOneAndUpdateReturns === 'function' ? findOneAndUpdateReturns(filter, update) : findOneAndUpdateReturns;
  };
  return { calls, restore: () => { Brand.findOneAndUpdate = realFindOneAndUpdate; } };
}

// Stub the lazily-required brandEnrichmentService module so
// backfillBrandWebsiteUrl's post-write enrichment trigger is observable
// without pulling in the real (network/LLM-calling) service.
function installEnrichStub() {
  const modPath = require.resolve('../services/brandEnrichmentService');
  const real = require.cache[modPath];
  let called = 0;
  require.cache[modPath] = {
    id: modPath, filename: modPath, loaded: true,
    exports: { enrichBrandFromUrl: async (id) => { called++; return { ok: true }; } }
  };
  return {
    callCount: () => called,
    restore: () => { require.cache[modPath] = real; }
  };
}

checkAsync('B1: an unsafe candidate URL never reaches the database at all', async () => {
  const stub = installBrandStub();
  try {
    const result = await backfillBrandWebsiteUrl({ _id: 'brand1' }, 'https://foo.myshopify.com', { ingestSource: 'test' });
    assert.deepEqual(result, { updated: false, websiteUrl: null });
    assert.equal(stub.calls.length, 0, 'findOneAndUpdate must not be called for an unsafe candidate — the guard fires before any write attempt');
  } finally { stub.restore(); }
});

checkAsync('B2: a guard-rejected write (already has websiteUrl / curated) reports updated:false and does not enrich', async () => {
  const stub = installBrandStub({ findOneAndUpdateReturns: null }); // simulates "filter matched nothing"
  const enrichStub = installEnrichStub();
  try {
    const result = await backfillBrandWebsiteUrl({ _id: 'brand1' }, 'https://example.com', { ingestSource: 'test' });
    assert.deepEqual(result, { updated: false, websiteUrl: null });
    assert.equal(enrichStub.callCount(), 0, 'no write happened — enrichment must not fire');
  } finally { stub.restore(); enrichStub.restore(); }
});

checkAsync('B3: the write filter requires an empty websiteUrl AND excludes curated brands', async () => {
  const stub = installBrandStub({ findOneAndUpdateReturns: { _id: 'brand1', name: 'Test Brand' } });
  const enrichStub = installEnrichStub();
  try {
    await backfillBrandWebsiteUrl({ _id: 'brand1' }, 'https://example.com', { ingestSource: 'test' });
    assert.equal(stub.calls.length, 1);
    const { filter, update } = stub.calls[0];
    const clauses = filter.$and || [];
    const hasEmptyWebsiteUrlClause = clauses.some(c => c.$or && JSON.stringify(c.$or).includes('websiteUrl'));
    const hasNotCuratedClause = clauses.some(c => c.source && c.source.$ne === 'curated');
    const hasNotCuratedFieldClause = clauses.some(c => c.curatedFields && c.curatedFields.$ne === 'websiteUrl');
    assert.ok(hasEmptyWebsiteUrlClause, 'filter must require websiteUrl to be empty/absent');
    assert.ok(hasNotCuratedClause, 'filter must exclude source===curated — same guard as brandCatalogService.js:57');
    assert.ok(hasNotCuratedFieldClause, "filter must exclude a brand with 'websiteUrl' in curatedFields");
    assert.equal(update.$set.websiteUrl, 'https://example.com');
  } finally { stub.restore(); enrichStub.restore(); }
});

checkAsync('B4: a successful write fires enrichment by default', async () => {
  const stub = installBrandStub({ findOneAndUpdateReturns: { _id: 'brand1', name: 'Test Brand' } });
  const enrichStub = installEnrichStub();
  try {
    const result = await backfillBrandWebsiteUrl({ _id: 'brand1' }, 'https://example.com', { ingestSource: 'test' });
    assert.equal(result.updated, true);
    assert.equal(result.websiteUrl, 'https://example.com');
    // Enrichment is fired via .catch() fire-and-forget — give the microtask
    // queue a tick to observe the call.
    await new Promise((r) => setImmediate(r));
    assert.equal(enrichStub.callCount(), 1, 'a successful backfill must trigger enrichment — otherwise the write alone still leaves the brand starved');
  } finally { stub.restore(); enrichStub.restore(); }
});

checkAsync('B5: triggerEnrichment:false suppresses the enrichment side effect (one-off scripts need this)', async () => {
  const stub = installBrandStub({ findOneAndUpdateReturns: { _id: 'brand1', name: 'Test Brand' } });
  const enrichStub = installEnrichStub();
  try {
    await backfillBrandWebsiteUrl({ _id: 'brand1' }, 'https://example.com', { ingestSource: 'test', triggerEnrichment: false });
    await new Promise((r) => setImmediate(r));
    assert.equal(enrichStub.callCount(), 0, 'a short-lived script would otherwise race process.exit() against a fire-and-forget enrichment call');
  } finally { stub.restore(); enrichStub.restore(); }
});

checkAsync('B6: a brand object with no _id is a no-op, never reaches the database', async () => {
  const stub = installBrandStub();
  try {
    const result = await backfillBrandWebsiteUrl(null, 'https://example.com');
    assert.deepEqual(result, { updated: false, websiteUrl: null });
    assert.equal(stub.calls.length, 0);
  } finally { stub.restore(); }
});

// ── Group C — enrichBrandFromUrl() records WHY it declined (behavioral) ─

function installFindByIdStub(brandDoc) {
  const real = Brand.findById;
  Brand.findById = async () => brandDoc;
  return { restore: () => { Brand.findById = real; } };
}
function installUpdateOneStub() {
  const real = Brand.updateOne;
  const calls = [];
  Brand.updateOne = async (filter, update) => { calls.push({ filter, update }); return { acknowledged: true }; };
  return { calls, restore: () => { Brand.updateOne = real; } };
}

checkAsync('C1: brand not found — no skip is recorded (nothing to record it ON)', async () => {
  const { enrichBrandFromUrl } = require('../services/brandEnrichmentService');
  const findStub = installFindByIdStub(null);
  const updateStub = installUpdateOneStub();
  try {
    const result = await enrichBrandFromUrl('nonexistent');
    assert.deepEqual(result, { ok: false, reason: 'brand not found' });
    assert.equal(updateStub.calls.length, 0);
  } finally { findStub.restore(); updateStub.restore(); }
});

checkAsync('C2: missing websiteUrl — enrichBrandFromUrl RECORDS the skip reason on the brand doc', async () => {
  // This is the load-bearing fix: before it, {ok:false, reason:'no
  // websiteUrl'} was returned to a fire-and-forget caller that discards
  // it — nothing was ever written anywhere, which is exactly how Marine
  // Layer (2446 products) sat starved with zero diagnostic trail.
  const { enrichBrandFromUrl } = require('../services/brandEnrichmentService');
  const findStub = installFindByIdStub({ _id: 'brand1', websiteUrl: null });
  const updateStub = installUpdateOneStub();
  try {
    const result = await enrichBrandFromUrl('brand1');
    assert.deepEqual(result, { ok: false, reason: 'no websiteUrl' });
    assert.equal(updateStub.calls.length, 1, 'the skip must be persisted, not just returned');
    const { filter, update } = updateStub.calls[0];
    assert.equal(String(filter._id), 'brand1');
    assert.equal(update.$set.enrichmentSkipReason, 'no websiteUrl');
    assert.ok(update.$set.enrichmentSkippedAt instanceof Date);
  } finally { findStub.restore(); updateStub.restore(); }
});

checkAsync('C3: markEnrichmentSkipped / clearEnrichmentSkipped write the exact expected $set shape', async () => {
  // Direct unit check of the two exported helpers (real code, not the
  // full enrichBrandFromUrl control flow) — this is what lets a stale
  // skip reason get cleared the moment a brand's websiteUrl is
  // back-filled and enrichment actually proceeds.
  const { markEnrichmentSkipped, clearEnrichmentSkipped } = require('../services/brandEnrichmentService');
  const updateStub = installUpdateOneStub();
  try {
    await markEnrichmentSkipped('brand1', 'no websiteUrl');
    assert.equal(updateStub.calls.length, 1);
    assert.equal(updateStub.calls[0].update.$set.enrichmentSkipReason, 'no websiteUrl');
    assert.ok(updateStub.calls[0].update.$set.enrichmentSkippedAt instanceof Date);

    await clearEnrichmentSkipped('brand1');
    assert.equal(updateStub.calls.length, 2);
    assert.equal(updateStub.calls[1].update.$set.enrichmentSkipReason, null);
    assert.equal(updateStub.calls[1].update.$set.enrichmentSkippedAt, null);
  } finally { updateStub.restore(); }
});

checkAsync('C4: a DB write failure while recording a skip never throws (fire-and-forget callers must survive it)', async () => {
  const { markEnrichmentSkipped } = require('../services/brandEnrichmentService');
  const real = Brand.updateOne;
  Brand.updateOne = async () => { throw new Error('simulated Mongo blip'); };
  try {
    await assert.doesNotReject(() => markEnrichmentSkipped('brand1', 'no websiteUrl'));
  } finally { Brand.updateOne = real; }
});

// ── Group D — schema declares the new fields (Mongoose-strict trap) ──

check('D1: Brand schema declares enrichmentSkipReason / enrichmentSkippedAt', () => {
  // This repo has lost writes to undeclared paths before (renderError.
  // predictionId) — a strict schema silently drops an unknown $set key.
  const paths = Brand.schema.paths;
  assert.ok(paths.enrichmentSkipReason, 'enrichmentSkipReason must be a declared schema path');
  assert.ok(paths.enrichmentSkippedAt, 'enrichmentSkippedAt must be a declared schema path');
});

// ── Group E — ingest-writer wiring (structural — the network-heavy
//     syncBrandShopifyDirect / syncBrandGenericCatalog / syncBrandShopify
//     control flow is not feasible to fully mock offline; this asserts
//     the specific shape that matters: the call happens with the ORIGIN
//     captured BEFORE any myshopify-backend override, gated on a non-
//     empty product result, using the shared helper rather than a
//     re-implemented cascade) ──────────────────────────────────────────

const fs = require('fs');
const path = require('path');

check('E1: shopifyPublicIngestService calls the shared backfill BEFORE the myshopify-backend origin override', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/shopifyPublicIngestService.js'), 'utf8');
  const backfillIdx = src.indexOf('backfillBrandWebsiteUrl(brand, origin');
  const overrideIdx = src.indexOf("if (access.origin) origin = access.origin");
  assert.ok(backfillIdx > -1, 'backfillBrandWebsiteUrl call not found');
  assert.ok(overrideIdx > -1, 'myshopify-backend override line not found (file changed shape?)');
  assert.ok(backfillIdx < overrideIdx, 'the backfill must read `origin` BEFORE it is overwritten with the myshopify effective backend — otherwise a headless store back-fills websiteUrl with the wrong host');
  assert.ok(src.includes("require('./brandWebsiteBackfill')"), 'must import the shared helper, not re-implement the cascade');
  assert.ok(/if \(products\.length > 0\) \{\s*\n\s*backfillBrandWebsiteUrl/.test(src), 'the backfill must be gated on a non-empty product result, not merely a configured URL');
});

check('E2: genericCatalogIngestService calls the shared backfill, gated on products.length', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/genericCatalogIngestService.js'), 'utf8');
  assert.ok(src.includes("require('./brandWebsiteBackfill')"));
  assert.ok(/if \(products\.length > 0\) \{\s*\n\s*backfillBrandWebsiteUrl/.test(src));
});

check('E3: apifyIngestService (legacy apify-shopify path) calls the shared backfill, gated on products.length', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/apifyIngestService.js'), 'utf8');
  assert.ok(src.includes("brandWebsiteBackfill').backfillBrandWebsiteUrl"));
  assert.ok(/if \(products\.length > 0\) \{\s*\n\s*require\('\.\/brandWebsiteBackfill'\)\.backfillBrandWebsiteUrl/.test(src));
});

check('E4: the Apify Instagram enrichment trigger is unconditional (no longer silently skips on missing websiteUrl)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/apifyIngestService.js'), 'utf8');
  assert.ok(!/if \(brand\.websiteUrl\) \{\s*\n\s*setImmediate\(\(\) => \{\s*\n\s*require\('\.\/brandEnrichmentService'\)/.test(src),
    'the old websiteUrl-gated guard around the enrichment trigger must be gone — enrichBrandFromUrl now records its own skip reason');
});

// ── summary ─────────────────────────────────────────────────────────

(async () => {
  for (const run of asyncChecks) await run();
  const total = passed + failed;
  console.log(`${passed}/${total} checks passed`);
  process.exit(failed ? 1 : 0);
})();
