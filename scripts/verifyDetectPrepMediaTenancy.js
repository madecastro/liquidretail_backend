#!/usr/bin/env node
'use strict';
//
// verifyDetectPrepMediaTenancy — pins the brandId-scoping fix on the
// on-demand catalog-detect prep inside expandWizardJob, found by an
// adversarial review of PR #245 (see session.d for that review's write-up).
//
// THE BUG. #245 closed the cross-brand leak on POST /generate's `productIds`
// (ownership-checked via resolveOwnedProductIds before reaching the
// generation pipeline) and on buildSeededUniverse's product-mode catalog
// query (brandId clause). It did NOT touch the *other* place a request body
// feeds a catalog lookup: expandWizardJob's on-demand detect-prep block
// (services/campaignAdsGenerationService.js, inside the `if (!dryRun)` guard)
// resolves the raw, unfiltered `mediaIds` via `Media.find({ _id: { $in:
// mediaIds } } )` with no brandId clause, unions each hit's
// `matchedProducts[].catalogProductId` into a Set, and hands that Set to
// `ensureDetectForProducts(ids, { advertiserId, brandId })`
// (services/catalogProductDetectService.js). That function ACCEPTS a
// brandId option but — before this fix — only used it to stamp an
// OperationRun label; its own two CatalogProduct.find calls (the
// ownership-collapse lookup and the primaryProductId/imageUrl resolution)
// were unscoped. Net effect: a foreign brand's mediaId in a /generate
// request body could still reach `enqueueProductDetect` — a billed Gemini
// vision call — against another brand's CatalogProduct, even on the
// deployed #245 fix.
//
// THE FIX, two parts:
//   1. campaignAdsGenerationService.js — the detect-prep Media.find gained
//      a `brandId` clause (the campaign's own brandId, already in scope).
//   2. catalogProductDetectService.js — ensureDetectForProducts's two
//      CatalogProduct.find calls gained a brandId clause. THE SECOND query
//      (the primaryOids/imageUrl lookup that actually produces `products`,
//      the array everything downstream operates on) is the one that is
//      independently security-load-bearing — primaryProductId could in
//      theory point cross-brand on bad data, and this is the query that
//      would let that through. The FIRST query's clause is real but is a
//      strict subset of what the second query already re-checks (see
//      section B/M2 below, which proves this rather than asserting it): its
//      value is narrowing the candidate set for a caller-supplied `oids`
//      list, not closing an independently-exploitable hole. Both are kept
//      because the first is harmless and arguably good practice, but only
//      the second is pinned as a security-critical revert-prove (M3).
//
//   UPDATE 2026-08-19 (adversarial review of PR #257 found a blocking
//   defect in the above): this used to be a CONDITIONAL clause
//   (`const scope = brandId ? { brandId } : {}`) — fail-OPEN when brandId
//   was falsy. The justifying comment claimed
//   services/productMatchService.js's post-scale detect pre-warm call
//   (`brandId: ctx.brandId || null`, line ~898) NEEDED that fail-open path
//   or a hard filter would "silently break" it. **That claim was checked
//   against the actual code and is FALSE.** Every path in
//   productMatchService.js that can set `match.catalogProductId` — the
//   catalog-first winner in `buildCatalogWinnerMatchRecord`, the legacy
//   scene-level `catalogMatch`, and `ensureCatalogProductForMatch` inside
//   `enrichOneMatchInPlace` — is ITSELF gated on `brandId` being truthy
//   (`findPerProductMatches` only runs catalog-first `if (refinedProducts.
//   length && brandId)`; `findProductMatches` only computes the legacy
//   `catalogMatch` `if (brandId)`; `enrichOneMatchInPlace` only calls
//   `ensureCatalogProductForMatch` `... && ctx.brandId && ...`). So by the
//   time that caller's `match.catalogProductId` is truthy and it reaches
//   `ensureDetectForProducts`, `ctx.brandId` is ALREADY always truthy too —
//   the `|| null` fallback on that call site is dead code that never
//   actually fires in practice. **This function now FAILS CLOSED**:
//   `if (!brandId) return { ensured:0, ready:0, timedOut:0, total:0 }`
//   before either query runs. `scope` is now unconditionally `{ brandId }`.
//   Not currently exploitable (both production callers always supply a
//   truthy brandId when catalogProductId is non-null) but this is tenant
//   isolation on a path that bills Gemini vision, and a landmine with a
//   false justifying comment is worse than no comment. Section B below
//   (B2) now asserts the fail-CLOSED behaviour instead of the old fail-open
//   one — a prior version of this harness required brandId:null to still
//   reach both products, which would have failed a correct fail-closed fix.
//
// TECHNIQUE.
//   A. Hunk 1 (the inline Media.find in expandWizardJob, which is NOT its
//      own function — can't require() + monkeypatch it in isolation without
//      dragging in the whole giant function's dependencies) is verified by
//      a STRUCTURAL source anchor: slice the `if (mediaIds.length) { ... }`
//      block by brace balance (unique anchor — grepped, appears exactly
//      once in the file), then slice the object literal passed to
//      `Media.find(` inside it by brace balance, strip line comments, and
//      parse its top-level keys. This is a same-boundary-as-the-syntax
//      slice (not a magic char-count window), so it can't silently drift
//      stale as the surrounding code changes.
//   B. Hunk 2 (ensureDetectForProducts, already an independently exported
//      function) is verified BEHAVIORALLY: the real exported function is
//      called against a faithful CatalogProduct.find stub (monkey-patched
//      on the real model, applying the _id/$in AND brandId clauses it
//      actually receives — same convention as
//      scripts/verifyGenerateProductTenancy.js's installCatalogProductFindStub)
//      plus a permissive DetectRun.find stub (reports every candidate
//      already-detected, so the function short-circuits via `wait:false`
//      before ever touching materializeImage/enqueueProductDetect — those
//      are covered by scripts/verifyCatalogHeroMaterialize.js and are out of
//      scope for a brandId-scoping test).
//
// REVERT-PROVE (mutations on temp sibling copies of the real files, deleted
// after each check):
//   M1 — drop `brandId` from the campaignAdsGenerationService.js Media.find
//        → section A's structural check goes red.
//   M3 — drop `...scope` from the SECOND CatalogProduct.find (the
//        primaryOids/imageUrl query) → section B's cross-brand-
//        primaryProductId scenario (a same-brand variant whose
//        primaryProductId happens to point at a foreign-brand product) now
//        reports the foreign primary as reachable instead of filtered.
//
// M2 (NOT a revert-prove — a documented structural finding). Dropping
// `...scope` from ONLY the FIRST CatalogProduct.find (the oids/ownership-
// collapse query) does NOT reopen the leak in the current code, and section
// B's M2 check asserts that non-effect rather than pretending it does: the
// SECOND query is a strict superset gate — every id that reaches `products`
// must independently pass ITS OWN brandId clause, so whatever the first
// query lets through as a primaryOids candidate is filtered again before it
// can be returned. The first query's scope is real but its job is narrowing
// the candidate set / avoiding needless work on a large foreign `oids` list
// (a caller-supplied volume concern), not an independently-exploitable
// tenancy hole — that would be a false claim, and asserting it "flips red"
// would have made this harness assert something untrue about the code, the
// exact class of mistake CLAUDE.md §5 warns a revert-prove exists to catch.
//
// Needs a real MongoDB? NO. Offline, no network. Every model static method
// touched is monkey-patched on the real mongoose model object for the
// duration of this script and restored after.
//
//   node scripts/verifyDetectPrepMediaTenancy.js
//
// This worktree's committed node_modules subset can be missing
// https-proxy-agent (CLAUDE.md §4) — same fallback stub as the sibling
// harness so this doesn't hard-fail in an unfixed worktree.

const fs = require('fs');
const path = require('path');
const Module = require('module');

function ensureHttpsProxyAgent() {
  try {
    require.resolve('https-proxy-agent');
    return 'present';
  } catch { /* fall through to a stub */ }
  const orig = Module._load;
  Module._load = function loadStub(request, parent, isMain) {
    if (request === 'https-proxy-agent') {
      return { HttpsProxyAgent: function HttpsProxyAgent() { return {}; } };
    }
    return orig.apply(this, arguments);
  };
  return 'stub';
}
const PROXY_MODE = ensureHttpsProxyAgent();

let pass = 0;
const failures = [];
function check(label, fn) {
  try {
    fn();
    pass += 1;
  } catch (err) {
    failures.push(`${label}: ${(err && err.message || String(err)).split('\n')[0].slice(0, 260)}`);
  }
}
async function checkAsync(label, fn) {
  try {
    await fn();
    pass += 1;
  } catch (err) {
    failures.push(`${label}: ${(err && err.message || String(err)).split('\n')[0].slice(0, 260)}`);
  }
}
function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'assertEqual'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ── source helpers ──────────────────────────────────────────────────────
const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

// Slice from a literal anchor to its enclosing block's close, by brace
// balance starting at the first `{` at/after the anchor.
function braceBlockFrom(src, anchorLiteral) {
  const anchorIdx = src.indexOf(anchorLiteral);
  if (anchorIdx < 0) return '';
  const open = src.indexOf('{', anchorIdx);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return '';
}

// Slice the parenthesized-object-literal argument of `<callLiteral>(` by
// brace balance (from the first `{` after the call's opening paren to its
// matching close).
function objectArgOf(src, callLiteral) {
  const callIdx = src.indexOf(callLiteral);
  if (callIdx < 0) return '';
  const open = src.indexOf('{', callIdx);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return '';
}

// Strip `//`-to-end-of-line comments, then collect bare/`key:` top-level
// identifiers that look like object-literal keys (good enough for this
// narrow, controlled slice — not a general JS parser).
function objectLiteralKeys(objSrc) {
  const noComments = objSrc.replace(/\/\/[^\n]*/g, '');
  const keys = new Set();
  const keyRe = /(?:^|[{,])\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::|[,}])/g;
  let m;
  while ((m = keyRe.exec(noComments))) keys.add(m[1]);
  return keys;
}

function checkHunk1SourceAnchor(genSrc, label) {
  check(label, () => {
    const mediaBlock = braceBlockFrom(genSrc, 'if (mediaIds.length) {');
    if (!mediaBlock) throw new Error('anchor `if (mediaIds.length) {` not found — has the detect-prep block moved/been renamed?');
    const findArg = objectArgOf(mediaBlock, 'Media.find(');
    if (!findArg) throw new Error('Media.find( call not found inside the mediaIds.length block');
    const keys = objectLiteralKeys(findArg);
    if (!keys.has('brandId')) {
      throw new Error(`Media.find object literal has no brandId key (keys seen: ${[...keys].join(', ')})`);
    }
  });
}

// A1's key-presence check only proves the LITERAL NAME `brandId` appears in
// the object — it would pass equally well on `brandId: campaign.advertiserId`
// (wrong field, right key name) or on a shorthand `brandId` bound to some
// other value entirely. This traces what VALUE actually feeds that key: for
// an explicit `brandId: <expr>` it reads `<expr>` directly; for the ES6
// shorthand `brandId,` (the real code today) it finds the nearest preceding
// `const/let brandId = <expr>` in the same file and reads THAT expression
// instead. Either way it demands the RHS actually mention `campaign.brandId`
// — not just any `campaign.*` field — so the exact landmine named above
// (right key, wrong or unrelated source field) fails this check even though
// it would still pass A1.
function checkHunk1BrandIdValue(genSrc, label) {
  check(label, () => {
    const mediaBlock = braceBlockFrom(genSrc, 'if (mediaIds.length) {');
    if (!mediaBlock) throw new Error('anchor `if (mediaIds.length) {` not found');
    const findArg = objectArgOf(mediaBlock, 'Media.find(');
    if (!findArg) throw new Error('Media.find( call not found inside the mediaIds.length block');
    const noComments = findArg.replace(/\/\/[^\n]*/g, '');

    // Explicit `brandId: <expr>` — capture up to the next top-level comma
    // or the closing brace.
    const explicit = noComments.match(/\bbrandId\s*:\s*([^,}]+)[,}]/);
    if (explicit) {
      const valueExpr = explicit[1].trim();
      if (!/campaign\.brandId\b/.test(valueExpr)) {
        throw new Error(`Media.find's brandId key has an explicit value "${valueExpr}" that does not reference campaign.brandId — right key name, wrong source field`);
      }
      return;
    }

    // Shorthand `brandId` (no colon) — must be a bare identifier reference;
    // trace it to its declaration in the enclosing file.
    if (!/(?:^|[{,])\s*brandId\s*[,}]/.test(noComments)) {
      throw new Error('brandId key found by objectLiteralKeys but neither an explicit `brandId: <expr>` nor a bare shorthand `brandId` pattern matched it — investigate the actual source shape');
    }
    const declRe = /(?:const|let)\s+brandId\s*=\s*([^;]+);/g;
    let decl;
    let sawAny = false;
    let sawCorrect = false;
    while ((decl = declRe.exec(genSrc))) {
      sawAny = true;
      if (/campaign\.brandId\b/.test(decl[1])) sawCorrect = true;
    }
    if (!sawAny) {
      throw new Error('shorthand `brandId` used in Media.find but no `const/let brandId = …` declaration found anywhere in the file to trace it to');
    }
    if (!sawCorrect) {
      throw new Error('every `const/let brandId = …` declaration found traces to something other than campaign.brandId — the shorthand key resolves to the wrong source field');
    }
  });
}

// ── fixtures (24-hex, ObjectId-shaped) ──────────────────────────────────
const oid = (ch, n) => `68f0${String(ch).repeat(19)}${n}`;
const BRAND_A = oid('a', '1');
const BRAND_B = oid('b', '2');
const P_OWNED           = oid('c', '3'); // brandId A, own primary
const P_UNOWNED         = oid('d', '4'); // brandId B, own primary
const P_VARIANT         = oid('e', '5'); // brandId A, but primaryProductId → P_UNOWNED_PRIMARY
const P_UNOWNED_PRIMARY = oid('f', '6'); // brandId B — the "bad data" cross-brand primary
const M_OWNED   = oid('1', '7');
const M_UNOWNED = oid('2', '8');
const M_FOREIGN_PRIMARY = oid('3', '9');

const CATALOG_ROWS = {
  [P_OWNED]:           { _id: P_OWNED,   brandId: BRAND_A, primaryProductId: null, imageUrl: 'https://x/1.jpg', imageMediaId: M_OWNED },
  [P_UNOWNED]:         { _id: P_UNOWNED, brandId: BRAND_B, primaryProductId: null, imageUrl: 'https://x/2.jpg', imageMediaId: M_UNOWNED },
  [P_VARIANT]:         { _id: P_VARIANT, brandId: BRAND_A, primaryProductId: P_UNOWNED_PRIMARY, imageUrl: null, imageMediaId: null },
  [P_UNOWNED_PRIMARY]: { _id: P_UNOWNED_PRIMARY, brandId: BRAND_B, primaryProductId: null, imageUrl: 'https://x/4.jpg', imageMediaId: M_FOREIGN_PRIMARY }
};

// A faithful CatalogProduct.find stub — same load-bearing property as
// scripts/verifyGenerateProductTenancy.js's installCatalogProductFindStub:
// it actually APPLIES the _id/$in, brandId, and imageUrl:$ne:null clauses
// from the filter object it receives, against the fixture table above. A
// stub that ignored brandId would report P_UNOWNED "reachable" regardless
// of what the code under test asked for, defeating the whole point.
function installCatalogProductFindStub(CatalogProductModel) {
  const original = CatalogProductModel.find;
  CatalogProductModel.find = (filter) => {
    const wantedIds = new Set((filter?._id?.$in || []).map(String));
    const hasBrandKey = filter != null && Object.prototype.hasOwnProperty.call(filter, 'brandId');
    const wantBrand = hasBrandKey ? String(filter.brandId) : null;
    const wantsImageUrlNotNull = !!(filter && filter.imageUrl && filter.imageUrl.$ne === null);
    const rows = Object.values(CATALOG_ROWS).filter((row) => {
      if (!wantedIds.has(String(row._id))) return false;
      if (hasBrandKey && String(row.brandId) !== wantBrand) return false;
      if (wantsImageUrlNotNull && !row.imageUrl) return false;
      return true;
    });
    return {
      select() { return this; },
      lean() { return Promise.resolve(rows.map((r) => ({ ...r }))); }
    };
  };
  return () => { CatalogProductModel.find = original; };
}

// Permissive DetectRun.find stub — reports EVERY requested mediaId as
// already having a run, so ensureDetectForProducts short-circuits (every
// product hits the `continue` in its materialize loop) before touching
// materializeImage / enqueueProductDetect / ensureDetectRunsForExistingMedia,
// which are a different harness's concern
// (scripts/verifyCatalogHeroMaterialize.js). This keeps the present test
// narrowly about brandId scoping.
function installDetectRunFindStub(DetectRunModel) {
  const original = DetectRunModel.find;
  DetectRunModel.find = (filter) => {
    const ids = (filter?.mediaId?.$in || []).map(String);
    return {
      select() { return this; },
      lean() { return Promise.resolve(ids.map((mediaId) => ({ mediaId }))); }
    };
  };
  return () => { DetectRunModel.find = original; };
}

async function run() {
  console.log(`verifyDetectPrepMediaTenancy — https-proxy-agent: ${PROXY_MODE}\n`);

  // ── Section A — hunk 1, structural source anchor ─────────────────────
  console.log('A. campaignAdsGenerationService.js detect-prep Media.find carries brandId');
  const genSrc = read('services', 'campaignAdsGenerationService.js');
  checkHunk1SourceAnchor(genSrc, 'A1. Media.find({...}) inside `if (mediaIds.length)` includes a brandId key');
  checkHunk1BrandIdValue(genSrc, 'A1b. that brandId key\'s VALUE traces to campaign.brandId, not just its NAME (guards a `brandId: campaign.advertiserId`-shaped false pass)');
  check('A2. module still exports expandWizardJob', () => {
    const svc = require('../services/campaignAdsGenerationService');
    if (typeof svc.expandWizardJob !== 'function') throw new Error('expandWizardJob not exported / not a function');
  });

  // ── Section B — hunk 2, behavioral, faithful stubs ────────────────────
  console.log('\nB. ensureDetectForProducts scopes both CatalogProduct.find calls by brandId');
  const CatalogProduct = require('../models/CatalogProduct');
  const DetectRun = require('../models/DetectRun');
  const detectSvc = require('../services/catalogProductDetectService');
  if (typeof detectSvc.ensureDetectForProducts !== 'function') {
    failures.push('B0. module surface: ensureDetectForProducts not exported / not a function');
  } else {
    const restoreCatalog = installCatalogProductFindStub(CatalogProduct);
    const restoreDetectRun = installDetectRunFindStub(DetectRun);
    try {
      await checkAsync('B1. owned+foreign ids, brandId=BRAND_A → only the owned product is reachable', async () => {
        const result = await detectSvc.ensureDetectForProducts([P_OWNED, P_UNOWNED], { brandId: BRAND_A, wait: false });
        assertEqual(result.total, 1, 'total reachable products');
      });
      await checkAsync('B2. [FAIL-CLOSED] brandId=null → NOTHING is reachable, not even the owned product', async () => {
        const result = await detectSvc.ensureDetectForProducts([P_OWNED, P_UNOWNED], { brandId: null, wait: false });
        assertEqual(result.total, 0, 'total reachable products with no brandId supplied (fail-closed: no brandId means no lookup, full stop)');
      });
      await checkAsync('B3. same-brand variant whose primaryProductId points cross-brand → filtered by the SECOND query', async () => {
        const result = await detectSvc.ensureDetectForProducts([P_VARIANT], { brandId: BRAND_A, wait: false });
        assertEqual(result.total, 0, 'cross-brand primaryProductId must not resolve');
      });
    } finally {
      restoreCatalog();
      restoreDetectRun();
    }
  }

  // ── Section C — revert-prove ──────────────────────────────────────────
  console.log('\nC. Revert-prove: each mutation flips its target check red');
  const genPath = path.join(ROOT, 'services', 'campaignAdsGenerationService.js');
  const detectPath = path.join(ROOT, 'services', 'catalogProductDetectService.js');
  const genTmpPath = path.join(ROOT, 'services', '__tmp_revert_gen.js');
  const detectTmpPath = path.join(ROOT, 'services', '__tmp_revert_detect.js');

  try {
    // M1 — drop brandId from the campaignAdsGenerationService.js Media.find.
    {
      const original = fs.readFileSync(genPath, 'utf8');
      const mutated = original.replace(
        /(_id:\s*\{\s*\$in:\s*mediaIds\.map\(toObjectId\)\.filter\(Boolean\)\s*\},\s*\n\s*)brandId(\s*\/\/[^\n]*(?:\n\s*\/\/[^\n]*)*)?/,
        '$1/* brandId removed by M1 */'
      );
      if (mutated === original) throw new Error('M1 mutation did not match — hunk 1 text has drifted, update the regex');
      check('M1 (revert-prove): removing brandId from campaignAdsGenerationService.js flips A1 red', () => {
        checkHunk1SourceAnchorExpectFailure(mutated);
      });
    }

    // M2 — drop `...scope` from ensureDetectForProducts' FIRST CatalogProduct
    // .find. NOT a revert-prove: asserts the documented non-effect (see the
    // file header) rather than an expected failure, so this check would
    // itself go red if a future refactor ever made the first query's scope
    // load-bearing without the second query's scope also changing — i.e. if
    // that ever happens, this is the tripwire that says "re-examine the
    // M2 rationale above, it may no longer hold."
    {
      const original = fs.readFileSync(detectPath, 'utf8');
      const target = "const requested = await CatalogProduct.find({ _id: { $in: oids }, ...scope })";
      if (!original.includes(target)) throw new Error('M2 anchor not found — hunk 2 first query text has drifted');
      const mutated = original.replace(target, "const requested = await CatalogProduct.find({ _id: { $in: oids } })");
      fs.writeFileSync(detectTmpPath, mutated);
      delete require.cache[require.resolve(detectTmpPath)];
      const mutatedSvc = require(detectTmpPath);
      const restoreCatalog = installCatalogProductFindStub(CatalogProduct);
      const restoreDetectRun = installDetectRunFindStub(DetectRun);
      try {
        await checkAsync('M2 (structural finding, not revert-prove): dropping scope from the FIRST query alone has NO effect — the SECOND query is the real gate', async () => {
          const result = await mutatedSvc.ensureDetectForProducts([P_OWNED, P_UNOWNED], { brandId: BRAND_A, wait: false });
          if (result.total !== 1) throw new Error(`expected total=1 (second query still gates it) even with the first query unscoped, got ${result.total} — the gating assumption behind this note no longer holds, re-derive it`);
        });
      } finally {
        restoreCatalog();
        restoreDetectRun();
        fs.unlinkSync(detectTmpPath);
        delete require.cache[require.resolve(detectTmpPath)];
      }
    }

    // M3 — drop `...scope` from the SECOND CatalogProduct.find.
    {
      const original = fs.readFileSync(detectPath, 'utf8');
      const target = "const products = await CatalogProduct.find({ _id: { $in: primaryOids }, imageUrl: { $ne: null }, ...scope }).lean();";
      if (!original.includes(target)) throw new Error('M3 anchor not found — hunk 2 second query text has drifted');
      const mutated = original.replace(target, "const products = await CatalogProduct.find({ _id: { $in: primaryOids }, imageUrl: { $ne: null } }).lean();");
      fs.writeFileSync(detectTmpPath, mutated);
      delete require.cache[require.resolve(detectTmpPath)];
      const mutatedSvc = require(detectTmpPath);
      const restoreCatalog = installCatalogProductFindStub(CatalogProduct);
      const restoreDetectRun = installDetectRunFindStub(DetectRun);
      try {
        await checkAsync('M3 (revert-prove): dropping scope from the SECOND query flips B3 red (foreign primary now reachable)', async () => {
          const result = await mutatedSvc.ensureDetectForProducts([P_VARIANT], { brandId: BRAND_A, wait: false });
          if (result.total === 0) throw new Error('expected the mutation to leak the foreign primary in (total=1), still got 0 — mutation had no effect');
        });
      } finally {
        restoreCatalog();
        restoreDetectRun();
        fs.unlinkSync(detectTmpPath);
        delete require.cache[require.resolve(detectTmpPath)];
      }
    }
  } finally {
    for (const p of [genTmpPath, detectTmpPath]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  }

  // ── summary ────────────────────────────────────────────────────────
  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFAILURES:');
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exitCode = 1;
  }
}

// M1's revert-prove needs the SAME structural check run against mutated
// source text, expecting it to now fail (no brandId key). Reuses
// checkHunk1SourceAnchor's logic directly (not the `check()`-wrapped
// version) so a thrown error here is the PASS condition for M1.
function checkHunk1SourceAnchorExpectFailure(mutatedSrc) {
  const mediaBlock = braceBlockFrom(mutatedSrc, 'if (mediaIds.length) {');
  if (!mediaBlock) throw new Error('M1 test setup broken: anchor missing entirely after mutation');
  const findArg = objectArgOf(mediaBlock, 'Media.find(');
  const keys = objectLiteralKeys(findArg);
  if (keys.has('brandId')) {
    throw new Error('M1 mutation left a brandId key behind — mutation regex did not actually remove it');
  }
  // Correct: no brandId key found post-mutation. This IS what M1 should prove.
}

run().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
