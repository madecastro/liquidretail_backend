#!/usr/bin/env node
'use strict';
//
// verifyRemotionTitlingPayloadIds — regression harness for the 2026-08-24
// production outage: 0/12 video ads succeeded in run_1787609351198_e2511b16,
// every one dying in the titling stage ~61-66s after reaching it with
//
//   remotion child IPC forbids buffers (key=buffer); pass a path
//
// ROOT CAUSE. PR #43 ("thread brand/product/ad/run attribution through the
// live render path") added `brandId: ad.brandId || null` and
// `productId: ad.productId || null` to the renderTitles() call in
// brandScriptExecutor.js and to payloadForChild's allow-list in
// remotionRenderService.js — RAW, unlike the adjacent `adId: String(ad._id)`
// on the very same object literal, which already did this correctly.
//
// `Ad.brandId` / `Ad.productId` are `mongoose.Schema.Types.ObjectId`
// (models/Ad.js) — `ad.brandId` is required, so this is 100% of video
// titling attempts, not a corner case. On this repo's mongoose 8.x / bson
// >=6, `mongoose.Types.ObjectId` stores its 12 raw bytes on an OWN,
// ENUMERABLE instance property literally named `buffer`
// (bson/src/objectid.ts: `private buffer!: Uint8Array;` — TS `private` is
// erased at compile time, so this is a plain enumerable JS property), and
// in a Node process that value is a REAL Node Buffer, not a plain
// Uint8Array (bson/src/utils/node_byte_utils.ts's `toLocalBufferType`:
// every branch returns `Buffer.from(...)` / `Buffer.alloc(...)`).
// `remotionChildSupervisor.assertNoBuffers` walks `Object.keys()` BEFORE
// JSON.stringify ever runs (so a Buffer can't hide behind its own
// `toJSON()`), finds that `buffer` key, and throws — correctly. This repo's
// backend sibling (`liquidretail_backend`) runs the identical call site
// with mongoose 7.x / bson 5.x, whose ObjectId hides the same bytes behind
// a Symbol key (`Symbol('id')`) that `Object.keys()` can never see, AND
// backend has no child-process IPC boundary at all (it calls the render
// function in-process) — so the identical raw-ObjectId payload was always
// legal there. Confirmed live in this session with the real installed
// bson 6.10.4 (adgen's own node_modules): `Object.keys(new
// mongoose.Types.ObjectId())` === `['buffer']`,
// `Buffer.isBuffer(oid.buffer)` === true, and piping that object through
// the REAL `serializePayload` throws the REAL production error text
// verbatim.
//
// THE GUARD IS CORRECT — do not relax it. It exists precisely to catch a
// raw Mongo type crossing the IPC boundary (the file's own comment already
// reduces `brand` to one field for the same reason). The bug is entirely on
// the SENDER side: two ids were threaded through without the same
// `String(...)` discipline `adId` already used on the same object literal.
//
// THE FIX (this commit): `payloadForChild` (remotionRenderService.js) now
// coerces brandId/productId/campaignRunId through a shared `toPlainId()`
// helper (typeof-string passthrough, else String(value)) — one choke point,
// so no future caller can reintroduce a raw id. brandScriptExecutor.js's two
// call sites were ALSO fixed to stringify at the source, matching the
// existing adId convention, as defense in depth.
//
// WHAT THIS PINS
//   A. A bare object shaped exactly like a bson >=6 ObjectId (an own,
//      enumerable `buffer` property holding a real Node Buffer — the exact
//      shape measured live above) reproduces the production crash when
//      piped through the REAL, unmodified remotionChildSupervisor guard.
//      This is the reproduction, not a mock of the defect.
//   B. payloadForChild (the actual parent-side IPC allow-list function that
//      shipped the bug) now emits PLAIN STRINGS for brandId/productId/
//      campaignRunId given that same fake-ObjectId input, and the resulting
//      payload survives the real serializePayload with no throw.
//   C. campaignRunId passes through a plain string unchanged (Ad.campaignRunIds
//      is schema-typed `[String]`, never ObjectId — this field was never part
//      of the defect; pinned so nobody "fixes" it into a redundant ObjectId
//      cast that would silently swallow a real, valid string id).
//   D. Structural: both renderTitles() call sites in brandScriptExecutor.js
//      stringify ad.brandId / ad.productId, matching the adId convention on
//      the same object literal (source-level pin, independent of B).
//
// REVERT-PROOF: reverting payloadForChild's brandId/productId/campaignRunId
// lines to `args.brandId || null` / `args.productId || null` (the exact
// pre-fix code) turns B red — see the harness's own mutation self-test in
// `main()`, which applies that mutation to a private copy of the source,
// `eval`s it, and asserts the check fails, then discards it. This is not a
// hand-wave: the harness demonstrably distinguishes fixed from unfixed code
// on unmodified src/services/remotionRenderService.js — see session report
// for the actual before/after run transcript.
//
// Pure + offline: Node builtins + src/services/remotionChildSupervisor.js
// (builtins only, per its own header) + src/services/remotionRenderService.js
// (payloadForChild is a pure function; nothing in this harness calls any
// function that touches Chrome, Mongo, the network, or an API key). Does
// NOT require mongoose/bson to be installed — the fake ObjectId is a plain
// object literal reproducing the exact `Object.keys()`/`Buffer.isBuffer()`
// shape measured live against the real package, so this stays green in a
// bare worktree exactly like its sibling verifyRemotionChildIsolation.js.
//
// Run: node scripts/verifyRemotionTitlingPayloadIds.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

// remotionChildSupervisor.js is builtins-only (its own header says so) —
// safe to require directly in a bare worktree with no node_modules, exactly
// like its sibling verifyRemotionChildIsolation.js already does.
const { serializePayload } = require('../src/services/remotionChildSupervisor');

const ROOT = path.join(__dirname, '..');
const EXECUTOR_SRC = fs.readFileSync(path.join(ROOT, 'src', 'services', 'brandScriptExecutor.js'), 'utf8');
const RENDER_SERVICE_PATH = path.join(ROOT, 'src', 'services', 'remotionRenderService.js');
const RENDER_SERVICE_SRC = fs.readFileSync(RENDER_SERVICE_PATH, 'utf8');

// remotionRenderService.js requires axios + @remotion/renderer + friends at
// module scope — those are NOT installed in a bare worktree (adgen does not
// vendor node_modules, unlike the backend sibling), so `require()`-ing the
// whole module here would MODULE_NOT_FOUND before a single assertion runs.
// payloadForChild itself is pure (string/object shuffling only, no I/O), so
// extract it — and the two pure helpers it calls — straight from the actual
// file on disk and evaluate them standalone. This still tests the REAL
// shipped source text, not a reimplementation; it just avoids loading the
// heavy modules payloadForChild's SIBLING functions in the same file need.
function extractFn(src, name) {
  const re = new RegExp(`function ${name}\\([\\s\\S]*?\\n}\\n`);
  const m = src.match(re);
  assert.ok(m, `could not extract function ${name}() from source — harness is stale vs the real file`);
  return m[0];
}

function loadPayloadForChild(src) {
  const body = [
    extractFn(src, 'stripHeavyMeta'),
    extractFn(src, 'toPlainId'),
    extractFn(src, 'payloadForChild'),
    'return payloadForChild;',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(body)();
}

const payloadForChild = loadPayloadForChild(RENDER_SERVICE_SRC);

let pass = 0;
const failures = [];
function check(label, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}\n     ${err.message}`);
    console.log(`  ✗ ${label}`);
  }
}

// A bson >=6 ObjectId's OWN enumerable shape, measured live 2026-08-24
// against the real installed package (adgen node_modules, mongoose
// 8.24.3 / bson 6.10.4): Object.keys(new mongoose.Types.ObjectId())
// === ['buffer'], and that value is a real Node Buffer. This object is a
// faithful stand-in for that measurement, not a guess — it carries no other
// behaviour verifyAssertNoBuffers could be fooled by (no toJSON override,
// no Buffer-JSON shape), and a real toString()/toHexString() so the fix's
// String(value) coercion produces the same hex string a real ObjectId would.
function fakeBsonObjectId(hex) {
  return {
    buffer: Buffer.from(hex, 'hex'),
    toString() { return hex; },
    toHexString() { return hex; },
  };
}

const FAKE_BRAND_ID = fakeBsonObjectId('64b7f1a2c3d4e5f6a7b8c9d0');
const FAKE_PRODUCT_ID = fakeBsonObjectId('64b7f1a2c3d4e5f6a7b8c9d1');

const baseArgs = {
  videoUrl: 'https://example.cloudinary.com/plate.mp4',
  meta: { headline: 'Sample' },
  spec: { id: 'canonical' },
  tokens: { fonts: {} },
  format: 'vertical',
  brandName: 'Acme',
  adId: '64b7f1a2c3d4e5f6a7b8c9d2',
  placementMode: null,
  brand: null,
  faceKeepOut: null,
  platformFormat: null,
  safeZoneKey: null,
};

console.log('── A. Reproduction: a real-shaped ObjectId trips the REAL, unmodified guard ──');
check('A1 Buffer.isBuffer sees the fake ObjectId\'s own buffer property (shape sanity)', () => {
  assert.strictEqual(Object.keys(FAKE_BRAND_ID).includes('buffer'), true);
  assert.strictEqual(Buffer.isBuffer(FAKE_BRAND_ID.buffer), true);
});
check('A2 serializePayload (the real guard) throws the exact production message on a raw ObjectId-shaped value', () => {
  assert.throws(
    () => serializePayload({ brandId: FAKE_BRAND_ID }),
    /remotion child IPC forbids buffers \(key=buffer\); pass a path/
  );
});
check('A3 the pre-fix payload shape (args.brandId passed straight through) would have reproduced the outage', () => {
  // This does not call payloadForChild — it proves the INPUT shape the bug
  // depended on is exactly what serializePayload rejects, independent of
  // whether payloadForChild has since been fixed.
  const preFixPayload = { videoUrl: baseArgs.videoUrl, brandId: FAKE_BRAND_ID || null };
  assert.throws(() => serializePayload(preFixPayload), /forbids buffers/);
});

console.log('\n── B. Fix: payloadForChild coerces ids to plain strings before the IPC boundary ──');
check('B1 payloadForChild emits a STRING brandId/productId for an ObjectId-shaped input', () => {
  const out = payloadForChild({ ...baseArgs, brandId: FAKE_BRAND_ID, productId: FAKE_PRODUCT_ID });
  assert.strictEqual(typeof out.brandId, 'string');
  assert.strictEqual(out.brandId, '64b7f1a2c3d4e5f6a7b8c9d0');
  assert.strictEqual(typeof out.productId, 'string');
  assert.strictEqual(out.productId, '64b7f1a2c3d4e5f6a7b8c9d1');
});
check('B2 that payload survives the REAL serializePayload with no throw (the actual fix, end to end)', () => {
  const out = payloadForChild({ ...baseArgs, brandId: FAKE_BRAND_ID, productId: FAKE_PRODUCT_ID });
  const body = serializePayload(out);
  const parsed = JSON.parse(body);
  assert.strictEqual(parsed.brandId, '64b7f1a2c3d4e5f6a7b8c9d0');
  assert.strictEqual(parsed.productId, '64b7f1a2c3d4e5f6a7b8c9d1');
});
check('B3 null brandId/productId/campaignRunId stay null (no accidental "null" string)', () => {
  const out = payloadForChild({ ...baseArgs, brandId: null, productId: null, campaignRunId: null });
  assert.strictEqual(out.brandId, null);
  assert.strictEqual(out.productId, null);
  assert.strictEqual(out.campaignRunId, null);
});

console.log('\n── C. campaignRunId is schema-typed String already — must pass through unchanged ──');
check('C1 a plain string campaignRunId is preserved verbatim (never re-derived/altered)', () => {
  const out = payloadForChild({ ...baseArgs, campaignRunId: 'run_1787609351198_e2511b16' });
  assert.strictEqual(out.campaignRunId, 'run_1787609351198_e2511b16');
});

console.log('\n── D. Structural: both renderTitles() call sites stringify brandId/productId ──');
function renderTitlesCallBlocks(src) {
  const blocks = [];
  const re = /renderTitles\(\{/g;
  let m;
  while ((m = re.exec(src))) {
    // Grab a generous window forward — enough to cover both call sites'
    // faceKeepOut tail (plus the explanatory comment ahead of brandId/
    // productId on the primary call site), never so much it bleeds into
    // the next function.
    blocks.push(src.slice(m.index, m.index + 1400));
  }
  return blocks;
}
check('D1 exactly two renderTitles() call sites exist (primary + cropped-plate retry)', () => {
  const blocks = renderTitlesCallBlocks(EXECUTOR_SRC);
  assert.strictEqual(blocks.length, 2, `expected 2 renderTitles() call sites, found ${blocks.length}`);
});
check('D2 every renderTitles() call site stringifies brandId (matches the adId convention)', () => {
  const blocks = renderTitlesCallBlocks(EXECUTOR_SRC);
  for (const b of blocks) {
    assert.match(b, /brandId:\s*ad\.brandId\s*\?\s*String\(ad\.brandId\)\s*:\s*null/,
      'a renderTitles() call site is passing ad.brandId without String(...) — the exact regression');
  }
});
check('D3 every renderTitles() call site stringifies productId (matches the adId convention)', () => {
  const blocks = renderTitlesCallBlocks(EXECUTOR_SRC);
  for (const b of blocks) {
    assert.match(b, /productId:\s*ad\.productId\s*\?\s*String\(ad\.productId\)\s*:\s*null/,
      'a renderTitles() call site is passing ad.productId without String(...) — the exact regression');
  }
});
check('D4 payloadForChild source itself coerces through a shared helper (defense in depth, not just the call site)', () => {
  assert.match(RENDER_SERVICE_SRC, /function toPlainId\(/, 'toPlainId helper missing');
  assert.match(RENDER_SERVICE_SRC, /brandId:\s*toPlainId\(args\.brandId\)/);
  assert.match(RENDER_SERVICE_SRC, /productId:\s*toPlainId\(args\.productId\)/);
  assert.match(RENDER_SERVICE_SRC, /campaignRunId:\s*toPlainId\(args\.campaignRunId\)/);
});

// ═════════════════════════════════════════════════════════════════════════
// Mutation self-test — proves B1/B2 actually exercise the fix, not a tautology.
// Re-derives payloadForChild from the ACTUAL FILE ON DISK with ONLY the fix
// lines reverted to the exact pre-fix code, evaluates it in an isolated
// function scope, and asserts B1/B2's assertions FAIL against that reverted
// version. This is the harness's own revert-prove, run every time (not a
// one-off manual step) — if this section stops failing when it should, the
// whole file is a false green.
// ═════════════════════════════════════════════════════════════════════════
function loadMutatedPayloadForChild() {
  const mutated = RENDER_SERVICE_SRC
    .replace(
      /brandId:\s*toPlainId\(args\.brandId\)/,
      'brandId: args.brandId || null'
    )
    .replace(
      /productId:\s*toPlainId\(args\.productId\)/,
      'productId: args.productId || null'
    );
  assert.notStrictEqual(mutated, RENDER_SERVICE_SRC, 'mutation regex found nothing to replace — harness is stale vs the real source');
  // Reuse the SAME extraction path the real test above uses (loadPayloadForChild),
  // just against a mutated copy of the source string — not a second, divergent
  // implementation of "extract and eval".
  return loadPayloadForChild(mutated);
}

function runMutationSelfTest() {
  const mutatedPayloadForChild = loadMutatedPayloadForChild();
  const out = mutatedPayloadForChild({ ...baseArgs, brandId: FAKE_BRAND_ID, productId: FAKE_PRODUCT_ID });
  // B1's assertion, against the reverted function:
  assert.notStrictEqual(typeof out.brandId, 'string', 'expected the MUTATED (pre-fix) payloadForChild to hand back a raw object, not a string');
  // B2's assertion, against the reverted function:
  assert.throws(() => serializePayload(out), /forbids buffers/, 'expected the MUTATED (pre-fix) payload to trip the real guard');
}

function main() {
  console.log('');
  if (failures.length) {
    console.log(`❌ verifyRemotionTitlingPayloadIds: ${failures.length} of ${pass + failures.length} checks FAILED`);
    for (const f of failures) console.log(`  • ${f}`);
    process.exit(1);
  }

  console.log('── Mutation self-test (revert-prove: B1/B2 must fail against pre-fix code) ──');
  try {
    runMutationSelfTest();
    console.log('  ✓ reverting payloadForChild reproduces the crash (B1/B2 correctly go red against pre-fix code)');
  } catch (err) {
    console.log('  ✗ mutation self-test did not behave as expected:', err.message);
    console.log(`❌ verifyRemotionTitlingPayloadIds: mutation self-test FAILED — B1/B2 may be tautological`);
    process.exit(1);
  }

  console.log(`✅ verifyRemotionTitlingPayloadIds: ${pass}/${pass} checks passed (+ mutation self-test)`);
}

main();
