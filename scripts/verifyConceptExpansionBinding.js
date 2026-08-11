// Offline verifier: runConceptDrivenExpansion's options object must actually
// EVALUATE, and must thread preferUgcMediaId through to buildSeededUniverse.
//
// WHY THIS EXISTS
// ---------------
// UGC-ads Phase 3 (c83be8e9) added a bare `preferUgcMediaId` to the
// buildSeededUniverse options literal inside runConceptDrivenExpansion, but
// never added it to that function's own parameter list. Every concept-driven
// expansion threw `ReferenceError: preferUgcMediaId is not defined` before it
// reached any UGC-specific branch — so the AI-Director path produced zero ads
// for EVERY product, not just UGC ones. 9 production crashes across 8 products
// before it was caught.
//
// It shipped green because scripts/verifyUgcFirstSeeding.js — like every other
// harness here — asserts over SOURCE TEXT, and a regex cannot see an unbound
// identifier. `node --check` cannot either: a ReferenceError is a runtime
// error, not a syntax error. So this harness CALLS the function instead of
// reading it. That is the whole point; do not "simplify" it into a grep.
//
// WHAT THIS DOES NOT COVER
// ------------------------
// The caller-side half (expandWizardJob forwarding preferUgcMediaId into
// runConceptDrivenExpansion) is not exercised here — driving expandWizardJob
// needs the full mongoose model surface. The repo-wide `no-undef` lint
// (eslint.config.js, `npm run lint`) is what catches the unbound-identifier
// class generally; this harness pins the specific money-adjacent path.
//
// Usage: node scripts/verifyConceptExpansionBinding.js
// Exit 0 = clean, exit 1 = failure.

'use strict';

// Offline: without this, the first model call after the stub halts the
// per-product loop would sit in mongoose's buffer for 10s before rejecting.
// We only care about what happened BEFORE that point.
require('mongoose').set('bufferCommands', false);

let passed = 0;
let failed = 0;
const ok   = (l) => { console.log(`  ✓ ${l}`); passed++; };
const fail = (l, d) => { console.error(`  ✗ ${l}${d ? ' — ' + d : ''}`); failed++; };
const assert = (cond, l, d) => (cond ? ok(l) : fail(l, d));

// Sentinel thrown by the stub to halt execution the instant the options
// literal has been evaluated. Anything past that point needs a real DB.
const HALT = Symbol('halt-after-seeded-universe');

// Records the opts object runConceptDrivenExpansion built for buildSeededUniverse.
let captured = null;

function installSeededUniverseStub() {
  const target = require.resolve('../services/seededUniverseService');
  require.cache[target] = {
    id: target,
    filename: target,
    loaded: true,
    exports: {
      buildSeededUniverse: async (_brandId, _productId, opts) => {
        captured = opts;
        const e = new Error('halt');
        e.__halt = HALT;
        throw e;
      }
    }
  };
}

// HOW AN UNBOUND IDENTIFIER SHOWS UP HERE
// ---------------------------------------
// Not as a visible ReferenceError. runConceptDrivenExpansion catches
// per-product errors into PER_PRODUCT_REASON.ERROR rows, and the summarize
// step that follows needs a DB we do not have — so the function rejects for an
// unrelated reason and those rows are never returned. Asserting "no
// ReferenceError was thrown" therefore passes even when the bug IS present.
// (Checked: an earlier draft of this harness did exactly that and reported
// green against the reverted fix.)
//
// The reliable signal is the STUB. If the options literal cannot be evaluated,
// buildSeededUniverse is never called and `captured` stays null. So every
// assertion below is phrased against what the stub actually received.
async function runAndCapture(args) {
  captured = null;
  try {
    await svcRef.runConceptDrivenExpansion(args);
  } catch {
    // Expected: execution past the stub needs a real DB. Irrelevant here.
  }
  return captured;
}

let svcRef = null;

(async () => {
  installSeededUniverseStub();
  svcRef = require('../services/campaignAdsGenerationService');

  console.log('\n[1] The options literal evaluates (no unbound identifier)');
  assert(
    typeof svcRef.runConceptDrivenExpansion === 'function',
    'runConceptDrivenExpansion is exported'
  );

  // Real 24-hex ObjectIds: the post-error summarize step casts these, so
  // placeholder strings would fail for a reason unrelated to what we assert.
  const baseArgs = {
    campaignId: '6a6624b95f5af85a46562ded',
    brandId:    '6a6624b95f5af85a46562dee',
    campaignKind: 'product',
    productIds: ['6a74cd62935d0a8e818fa0ce'],
    kinds:      ['image'],
    platformFormat: 'meta_feed',
    includeCategoryMatched: false,
    includeBrandMatched:    false,
    excludePairings: [],
    creativeIntent:  null
  };

  // (a) Called WITHOUT preferUgcMediaId — the default must bind it.
  const a = await runAndCapture({ ...baseArgs });
  assert(
    a !== null,
    'buildSeededUniverse was reached — the options literal evaluated',
    'stub never called: an identifier in the literal is unbound'
  );
  assert(
    a && Object.prototype.hasOwnProperty.call(a, 'preferUgcMediaId'),
    'preferUgcMediaId is present in the buildSeededUniverse options'
  );
  assert(
    a && a.preferUgcMediaId === null,
    'omitted preferUgcMediaId defaults to null (pre-Phase-3 behaviour)',
    a ? `got ${JSON.stringify(a.preferUgcMediaId)}` : 'no capture'
  );

  console.log('\n[2] An explicit preferUgcMediaId reaches buildSeededUniverse');
  const MEDIA_ID = '6a7b4e239623ac4e8560bfb9';
  const b = await runAndCapture({ ...baseArgs, preferUgcMediaId: MEDIA_ID });
  assert(
    b && String(b.preferUgcMediaId) === MEDIA_ID,
    'the caller-supplied media id is threaded through unchanged',
    b ? `got ${JSON.stringify(b.preferUgcMediaId)}` : 'no capture'
  );

  console.log('\n[3] Brand-only runs (productIds empty) bind it too');
  const c = await runAndCapture({ ...baseArgs, productIds: [], preferUgcMediaId: MEDIA_ID });
  assert(
    c && String(c.preferUgcMediaId) === MEDIA_ID,
    'brand-only expansion threads the media id through',
    c ? `got ${JSON.stringify(c.preferUgcMediaId)}` : 'no capture'
  );

  console.log(`\n${passed + failed} checks — ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\n  ✗ harness crashed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
