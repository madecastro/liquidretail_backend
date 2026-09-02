#!/usr/bin/env node
// Offline pins for the three P0 ingest fixes from the 2026-09-02 review:
//
//   B — draft-collapse fires from productMatchService.ensureCatalogProductForMatch
//        (was dead code on the automatic detect path — cc95cb5 shipped
//         the collapse but nothing called it)
//   A — extended-crop generation during ingest is gated behind
//        INGEST_EXTENDED_CROPS_ENABLED (default false — nano-banana-2/edit
//        rejects the 9:16 / 1.91:1 aspect_ratio values 75% of the time)
//   D3 — catalogFirstMatchOneRefined skips visual scoring when the leader
//        text score is ≥ SKU_TEXT_EARLY_EXIT_THRESHOLD (default 0.85)
//
// All three are structural + env-parser pins — no DB, no network.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', 'config', 'defaults.env'), quiet: true });

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  ✗ ${name} — ${err.message}`);
  }
}

const productMatchSrc = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'productMatchService.js'), 'utf8'
);
const detectSrc = fs.readFileSync(
  path.join(__dirname, '..', 'pipelines', 'detect.js'), 'utf8'
);
const defaultsEnv = fs.readFileSync(
  path.join(__dirname, '..', 'config', 'defaults.env'), 'utf8'
);

// ── SECTION B — draft collapse in ensureCatalogProductForMatch ─────────

console.log('\n== B. Draft collapse wired into productMatchService.ensureCatalogProductForMatch ==');

check('B1 productMatchService requires catalogProductDraftService', () => {
  assert.match(
    productMatchSrc,
    /require\(['"]\.\/catalogProductDraftService['"]\)/,
    'expected productMatchService to require catalogProductDraftService'
  );
});

check('B2 productMatchService uses findCatalogSubsetMatch (the shared subset check)', () => {
  assert.match(
    productMatchSrc,
    /findCatalogSubsetMatch\s*\(/,
    'expected productMatchService to call findCatalogSubsetMatch'
  );
});

check('B3 productMatchService uses draftCollapseStopwords (fit-modifier-preserving stops)', () => {
  // Structural pin — a future refactor that inlined the UNIVERSAL_STOP_TOKENS
  // union directly would reintroduce the fit-modifier bug the shared helper
  // exists to prevent (ws/mens/womens/youth/kids stripped, collapsing men's
  // and women's SKUs into one).
  assert.match(
    productMatchSrc,
    /draftCollapseStopwords\s*\(/,
    'expected productMatchService to call draftCollapseStopwords rather than assembling stops inline'
  );
});

check('B4 productMatchService gates the collapse on isCollapseToCatalogEnabled()', () => {
  // Shares the same DRAFT_COLLAPSE_TO_CATALOG env with the tryCreate call
  // site — ops flip one flag to opt out of both.
  assert.match(
    productMatchSrc,
    /isCollapseToCatalogEnabled\s*\(\s*\)/,
    'expected productMatchService to gate on isCollapseToCatalogEnabled()'
  );
});

check('B5 collapse fires INSIDE ensureCatalogProductForMatch, BEFORE CatalogProduct.create', () => {
  // Extract the ensureCatalogProductForMatch function body and confirm the
  // collapse call precedes the create call — otherwise the fix mints the
  // draft first and only checks the subset after (worst of both worlds).
  const fnStart = productMatchSrc.indexOf('async function ensureCatalogProductForMatch');
  assert.ok(fnStart >= 0, 'ensureCatalogProductForMatch not found');
  // Find the closing brace of the function by walking braces.
  let depth = 0, i = fnStart, seenOpen = false;
  while (i < productMatchSrc.length) {
    const ch = productMatchSrc[i];
    if (ch === '{') { depth++; seenOpen = true; }
    else if (ch === '}') { depth--; if (seenOpen && depth === 0) { i++; break; } }
    i++;
  }
  const fnBody = productMatchSrc.slice(fnStart, i);
  const collapseIdx = fnBody.indexOf('findCatalogSubsetMatch(');
  const createIdx = fnBody.indexOf('CatalogProduct.create(');
  assert.ok(collapseIdx >= 0, 'expected findCatalogSubsetMatch call inside ensureCatalogProductForMatch');
  assert.ok(createIdx >= 0, 'expected CatalogProduct.create call inside ensureCatalogProductForMatch');
  assert.ok(collapseIdx < createIdx, `collapse (idx=${collapseIdx}) must precede create (idx=${createIdx}) inside ensureCatalogProductForMatch`);
});

// ── SECTION A — extended crops gated behind env, default off ───────────

console.log('\n== A. Extended-crop ingest gated behind INGEST_EXTENDED_CROPS_ENABLED ==');

check('A1 detect.js reads INGEST_EXTENDED_CROPS_ENABLED env', () => {
  assert.match(detectSrc, /INGEST_EXTENDED_CROPS_ENABLED/);
});

check('A2 detect.js uses lowercase-trim string comparison (not truthy coercion)', () => {
  // Guard against a future refactor writing `process.env.INGEST_EXTENDED_CROPS_ENABLED === true`
  // (boolean, always false because env values are strings) — subtle
  // regression that would silently keep the flag OFF forever regardless of
  // dashboard value. Explicit lowercase-trim ≡ 'true' is the safe shape.
  assert.match(
    detectSrc,
    /INGEST_EXTENDED_CROPS_ENABLED[\s\S]{0,200}toLowerCase\(\)[\s\S]{0,100}['"]true['"]/,
    'expected explicit toLowerCase()==="true" comparison for INGEST_EXTENDED_CROPS_ENABLED'
  );
});

check('A3 flag threads into skipExtendedCrops on the UGC path (line ~342)', () => {
  // The first runExtendedAndOverlayChain call site (the UGC path — line
  // 676's catalog-product path is already hardcoded to skipExtendedCrops:
  // true). Structural: the flag inverts to become skipExtendedCrops so a
  // false env → true skip.
  assert.match(
    detectSrc,
    /skipExtendedCrops:\s*!extendedCropsIngestEnabled/,
    'expected skipExtendedCrops to be derived by negation from the flag'
  );
});

check('A4 defaults.env commits INGEST_EXTENDED_CROPS_ENABLED=false', () => {
  assert.match(defaultsEnv, /^INGEST_EXTENDED_CROPS_ENABLED=false$/m);
});

check('A5 catalog-product path (line ~676) still hardcodes skipExtendedCrops:true', () => {
  // Regression guard: the catalog path predates this fix and its comment
  // explains why (studio shots don't benefit). A future refactor that
  // consolidated both paths into the shared env should NOT drop the
  // stronger catalog-side skip — a brand that flipped the env to true
  // shouldn't get catalog Media speculatively extending too.
  assert.match(
    detectSrc,
    /skipExtendedCrops:\s*true/,
    'expected the catalog-product call site to still hardcode skipExtendedCrops:true'
  );
});

// ── SECTION D3 — text early exit ───────────────────────────────────────

console.log('\n== D3. catalogFirstMatchOneRefined text early exit ==');

check('D3-1 productMatchService reads SKU_TEXT_EARLY_EXIT_THRESHOLD env', () => {
  assert.match(productMatchSrc, /SKU_TEXT_EARLY_EXIT_THRESHOLD/);
});

check('D3-2 threshold clamped to [0,1] and NaN → default', () => {
  // Explicit clamp so a runaway "2.5" or "foo" doesn't disable the gate
  // silently (>1 would never trigger; NaN would always trigger against
  // the < comparison in a JS gotcha). Structural pin.
  const match = productMatchSrc.match(
    /SKU_TEXT_EARLY_EXIT_THRESHOLD[\s\S]{0,500}v < 0[\s\S]{0,50}v > 1[\s\S]{0,50}return 0\.85/
  );
  assert.ok(match, 'expected explicit [0,1] clamp with 0.85 default in the parser');
});

check('D3-3 threshold=0 disables the gate (kill switch)', () => {
  // The gate check is `if (SKU_TEXT_EARLY_EXIT_THRESHOLD > 0 && leaderText...)`
  // so setting the env to 0 falls through to visual scoring on every hit,
  // preserving pre-D3 behaviour byte-for-byte.
  assert.match(
    productMatchSrc,
    /SKU_TEXT_EARLY_EXIT_THRESHOLD\s*>\s*0\s*&&\s*leaderText/
  );
});

check('D3-4 early exit fires BEFORE the visual scoring Promise.all', () => {
  // The gate must sit above the `Promise.all(textCandidates.map(...))`
  // that fires vision comparisons — otherwise the visual calls already
  // billed by the time we early-exit, defeating the purpose.
  const gateIdx = productMatchSrc.indexOf('SKU_TEXT_EARLY_EXIT_THRESHOLD');
  const visualPromiseAllIdx = productMatchSrc.indexOf('Promise.all(textCandidates.map');
  assert.ok(gateIdx > 0);
  assert.ok(visualPromiseAllIdx > 0);
  assert.ok(gateIdx < visualPromiseAllIdx, 'early-exit gate must precede the vision-scoring Promise.all');
});

check('D3-5 early exit returns the leader with combinedScore=textScore', () => {
  // Regression guard: a future refactor that returned combinedScore=0 on
  // early exit would cascade to a "no match" verdict downstream, worse
  // than shipping the visual pass. The gate MUST propagate the text
  // score as the combined score.
  const gateStart = productMatchSrc.indexOf('SKU_TEXT_EARLY_EXIT_THRESHOLD');
  const gateEnd = productMatchSrc.indexOf('const visualResults = await Promise.all(textCandidates.map', gateStart);
  const gateBlock = productMatchSrc.slice(gateStart, gateEnd);
  assert.match(gateBlock, /combinedScore:\s*leaderText\.textScore/);
});

check('D3-6 defaults.env commits SKU_TEXT_EARLY_EXIT_THRESHOLD=0.85', () => {
  assert.match(defaultsEnv, /^SKU_TEXT_EARLY_EXIT_THRESHOLD=0\.85$/m);
});

// ── SECTION D1 — visual match batching ─────────────────────────────────

console.log('\n== D1. visualCatalogMatchService batch API + productMatchService caller ==');

const visualMatchSrc = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'visualCatalogMatchService.js'), 'utf8'
);

check('D1-1 visualCatalogMatchService exports compareCropToCandidatesBatch', () => {
  const svc = require('../services/visualCatalogMatchService');
  assert.strictEqual(typeof svc.compareCropToCandidatesBatch, 'function');
});

check('D1-2 visualCatalogMatchService exports isBatchEnabled with correct default', () => {
  const svc = require('../services/visualCatalogMatchService');
  assert.strictEqual(typeof svc.isBatchEnabled, 'function');
  const prior = process.env.SKU_VISUAL_MATCH_BATCH_ENABLED;
  try {
    delete process.env.SKU_VISUAL_MATCH_BATCH_ENABLED;
    assert.strictEqual(svc.isBatchEnabled(), true, 'default (unset) → true');
    process.env.SKU_VISUAL_MATCH_BATCH_ENABLED = 'false';
    assert.strictEqual(svc.isBatchEnabled(), false, '"false" → false');
    process.env.SKU_VISUAL_MATCH_BATCH_ENABLED = '0';
    assert.strictEqual(svc.isBatchEnabled(), false, '"0" → false');
    process.env.SKU_VISUAL_MATCH_BATCH_ENABLED = 'off';
    assert.strictEqual(svc.isBatchEnabled(), false, '"off" → false');
    process.env.SKU_VISUAL_MATCH_BATCH_ENABLED = 'garbage';
    assert.strictEqual(svc.isBatchEnabled(), true, 'garbage → true (defaults on)');
  } finally {
    if (prior === undefined) delete process.env.SKU_VISUAL_MATCH_BATCH_ENABLED;
    else process.env.SKU_VISUAL_MATCH_BATCH_ENABLED = prior;
  }
});

check('D1-3 batch response schema has stable 1-indexed candidate field', () => {
  // A regression to 0-indexed would silently shift every result by one
  // (candidate N would map to the wrong target's imageUrl in the caller).
  // Pinning the schema shape prevents that class of bug.
  assert.match(
    visualMatchSrc,
    /candidate:\s*\{\s*type:\s*['"]integer['"]/,
    'expected `candidate` field on the batch response schema (1-indexed)'
  );
});

check('D1-4 batch result rehydrates ORIGINAL-INDEX null slots for dropped candidates', () => {
  // Structural: a candidate whose image download failed must return null at
  // its input index, not shift subsequent candidates up. The caller's best-
  // score loop tolerates null but relies on stable positional indexing.
  const fnStart = visualMatchSrc.indexOf('async function compareCropToCandidatesBatch');
  const fnEnd = visualMatchSrc.indexOf('module.exports', fnStart);
  const fn = visualMatchSrc.slice(fnStart, fnEnd);
  assert.match(fn, /new Array\(candidates\.length\)\.fill\(null\)/,
    'expected output array sized to input length filled with null');
  assert.match(fn, /out\[scored\[i\]\.inputIdx\]\s*=/,
    'expected results to be placed at inputIdx (original candidate position)');
});

check('D1-5 productMatchService prefers batch, falls through to serial on failure', () => {
  // The caller MUST retain the serial Promise.all path as a fallback —
  // batch failure should not permanently lose the visual signal for a
  // product. Structural pin: `compareCropToCandidatesBatch` call exists
  // AND the serial `Promise.all(targets.map(async (url) => ...))` also
  // exists AND the batch call precedes the serial map.
  const batchIdx = productMatchSrc.indexOf('compareCropToCandidatesBatch(');
  const serialMapIdx = productMatchSrc.indexOf('const results = await Promise.all(targets.map(async (url) =>');
  assert.ok(batchIdx > 0, 'expected compareCropToCandidatesBatch call');
  assert.ok(serialMapIdx > 0, 'expected serial fallback Promise.all to remain');
  assert.ok(batchIdx < serialMapIdx, 'batch must be tried BEFORE the serial fallback');
});

check('D1-6 batch gated on isBatchEnabled() at the caller (kill switch honored)', () => {
  // Structural: the batch call site checks isBatchEnabled() so
  // SKU_VISUAL_MATCH_BATCH_ENABLED=false actually skips the batch attempt
  // and goes straight to serial. Missing this gate would waste one batch
  // call per product even when ops flipped the switch off.
  const batchIdx = productMatchSrc.indexOf('compareCropToCandidatesBatch(');
  const upstream = productMatchSrc.slice(Math.max(0, batchIdx - 500), batchIdx);
  assert.match(upstream, /isBatchEnabled/,
    'expected isBatchEnabled() check upstream of compareCropToCandidatesBatch call');
});

check('D1-7 defaults.env commits SKU_VISUAL_MATCH_BATCH_ENABLED=true', () => {
  assert.match(defaultsEnv, /^SKU_VISUAL_MATCH_BATCH_ENABLED=true$/m);
});

// ── Summary ─────────────────────────────────────────────────────────────

const total = results.length;
const passed = results.filter(r => r.ok).length;
console.log(`\n${total} checks — ${passed} passed, ${total - passed} failed`);
if (passed !== total) process.exit(1);
