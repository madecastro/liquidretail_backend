#!/usr/bin/env node
'use strict';

// Verifies the moderation-rejection fix added 2026-08-19 (see
// services/moderationSeedFallback.js's header for the incident):
//
//   A. services/atlasErrorPolicy.js — every policy carries a stable IMAGE_*
//      classification code, and moderationBlocked specifically classifies to
//      IMAGE_MODERATION_BLOCKED.
//   B. services/moderationSeedFallback.js — the PURE candidate-selection
//      logic (ordering, exclusion, capping) that decides which catalog image
//      to try next, plus its best-effort Mongo read/write coordination
//      helpers, mocked through require.cache (this repo's established
//      pattern — see scripts/verifyDirectorFallbackChain.js) rather than a
//      real DB connection.
//   C. routes/ads.js — buildErrorEntry/buildModerationRollup, called for
//      real (not regexed), populate the new code/action/rollup fields.
//   D. services/renderService.js — failed() threads a classified error's
//      code/retryable through instead of the old "retryable unless stage is
//      'validate'" guess, which was a lie for a give-up (moderation) failure.
//
// Fully offline: no network, no live DB, no keys. Mongoose model calls are
// stubbed through require.cache before the modules under test load them.

const assert = require('assert');
const path = require('path');

let pass = 0;
const failures = [];
function check(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (err) { failures.push(name); console.log(`  ✗ ${name}\n      ${err.message}`); }
}
async function checkAsync(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (err) { failures.push(name); console.log(`  ✗ ${name}\n      ${err.message}`); }
}

console.log('\nA. services/atlasErrorPolicy.js — every policy has a stable IMAGE_* code');

const atlasErrorPolicy = require('../services/atlasErrorPolicy');
const { classify, POLICIES, FALLBACK, IMAGE_ERROR_CODES } = atlasErrorPolicy;

check('A1 IMAGE_ERROR_CODES keys equal values (same convention the sibling LLM taxonomy uses)', () => {
  const codes = Object.keys(IMAGE_ERROR_CODES);
  assert.ok(codes.length >= 13, `expected at least 13 codes, saw ${codes.length}`);
  for (const c of codes) {
    assert.strictEqual(IMAGE_ERROR_CODES[c], c, `${c}: key must equal value`);
  }
});

check('A2 every named POLICY carries a code drawn from IMAGE_ERROR_CODES', () => {
  const valid = new Set(Object.values(IMAGE_ERROR_CODES));
  for (const [name, p] of Object.entries(POLICIES)) {
    assert.ok(p.code, `policy '${name}' has no code`);
    assert.ok(valid.has(p.code), `policy '${name}'.code (${p.code}) is not in IMAGE_ERROR_CODES`);
  }
  assert.ok(FALLBACK.code && valid.has(FALLBACK.code), 'FALLBACK has no valid code');
});

check('A3 moderationBlocked classifies to IMAGE_MODERATION_BLOCKED — the incident this fix exists for', () => {
  // Shape of the real production failure (run_1787136860887_654ed621):
  // safety_violations=[sexual] text, various HTTP/envelope codes including
  // the 3-of-18 "HTTP 200 but status:failed" case.
  const verdict200 = classify({
    http: 200, code: 200, predictionStatus: 'failed',
    msg: 'Your request was rejected by the safety system. safety_violations=[sexual].'
  });
  assert.strictEqual(verdict200.code, IMAGE_ERROR_CODES.IMAGE_MODERATION_BLOCKED);
  assert.strictEqual(verdict200.retryable, false, 'a moderation rejection must never read as retryable');
  assert.strictEqual(verdict200.terminal, true);

  const verdict500 = classify({
    http: 500, code: 500,
    msg: 'recv from gpt image edit api failed. code:moderation_blocked, type:image_generation_user_error'
  });
  assert.strictEqual(verdict500.code, IMAGE_ERROR_CODES.IMAGE_MODERATION_BLOCKED);

  const verdict400 = classify({ http: 400, code: 400, msg: 'Input Prompt violates policy' });
  assert.strictEqual(verdict400.code, IMAGE_ERROR_CODES.IMAGE_MODERATION_BLOCKED);
});

check('A4 a genuinely unclassifiable failure still gets a code (IMAGE_UNCLASSIFIED), never undefined', () => {
  const verdict = classify({});
  assert.strictEqual(verdict.code, IMAGE_ERROR_CODES.IMAGE_UNCLASSIFIED);
});

check('A5 a 429 classifies to IMAGE_RATE_LIMITED, not moderation (precedence must not blur these)', () => {
  const verdict = classify({ http: 429, msg: 'rate limit exceeded' });
  assert.strictEqual(verdict.code, IMAGE_ERROR_CODES.IMAGE_RATE_LIMITED);
  assert.strictEqual(verdict.retryable, true);
});

console.log('\nB. services/moderationSeedFallback.js — pure candidate-selection logic');

const seedFallback = require('../services/moderationSeedFallback');

check('B1 orderedCatalogMediaIds: primary first, then additionalImageMediaIds in stored order', () => {
  const product = { imageMediaId: 'hero', additionalImageMediaIds: ['alt1', 'alt2', 'alt3'] };
  assert.deepStrictEqual(seedFallback.orderedCatalogMediaIds(product), ['hero', 'alt1', 'alt2', 'alt3']);
});

check('B2 orderedCatalogMediaIds: missing primary or empty extras degrades gracefully', () => {
  assert.deepStrictEqual(seedFallback.orderedCatalogMediaIds({}), []);
  assert.deepStrictEqual(seedFallback.orderedCatalogMediaIds({ imageMediaId: 'hero' }), ['hero']);
  assert.deepStrictEqual(
    seedFallback.orderedCatalogMediaIds({ additionalImageMediaIds: ['a', null, 'b'] }),
    ['a', 'b'],
    'a falsy entry in additionalImageMediaIds must be skipped, not stringified to "null"'
  );
});

check('B3 nextCandidateIds: excludes given ids and respects the cap, preserving feed order', () => {
  const product = { imageMediaId: 'hero', additionalImageMediaIds: ['alt1', 'alt2', 'alt3', 'alt4'] };
  const out = seedFallback.nextCandidateIds(product, { excludeMediaIds: ['hero', 'alt2'], limit: 2 });
  assert.deepStrictEqual(out, ['alt1', 'alt3'], 'must skip excluded ids and stop at the cap, in feed order');
});

check('B4 nextCandidateIds: an empty candidate pool (everything excluded) returns []', () => {
  const product = { imageMediaId: 'hero', additionalImageMediaIds: ['alt1'] };
  const out = seedFallback.nextCandidateIds(product, { excludeMediaIds: ['hero', 'alt1'], limit: 5 });
  assert.deepStrictEqual(out, []);
});

check('B5 isEnabled() defaults true and respects the STATIC_MODERATION_SEED_FALLBACK=false kill switch', () => {
  const prev = process.env.STATIC_MODERATION_SEED_FALLBACK;
  try {
    delete process.env.STATIC_MODERATION_SEED_FALLBACK;
    assert.strictEqual(seedFallback.isEnabled(), true, 'must default ON');
    process.env.STATIC_MODERATION_SEED_FALLBACK = 'false';
    assert.strictEqual(seedFallback.isEnabled(), false, 'the kill switch must actually disable it');
  } finally {
    if (prev === undefined) delete process.env.STATIC_MODERATION_SEED_FALLBACK;
    else process.env.STATIC_MODERATION_SEED_FALLBACK = prev;
  }
});

check('B6 maxFallbackCandidates() defaults to 2 and is env-overridable, never negative', () => {
  const prev = process.env.STATIC_MODERATION_SEED_FALLBACK_MAX_CANDIDATES;
  try {
    delete process.env.STATIC_MODERATION_SEED_FALLBACK_MAX_CANDIDATES;
    assert.strictEqual(seedFallback.maxFallbackCandidates(), 2);
    process.env.STATIC_MODERATION_SEED_FALLBACK_MAX_CANDIDATES = '5';
    assert.strictEqual(seedFallback.maxFallbackCandidates(), 5);
    process.env.STATIC_MODERATION_SEED_FALLBACK_MAX_CANDIDATES = '-3';
    assert.strictEqual(seedFallback.maxFallbackCandidates(), 2, 'a nonsense negative override must fall back to the default, not go negative');
  } finally {
    if (prev === undefined) delete process.env.STATIC_MODERATION_SEED_FALLBACK_MAX_CANDIDATES;
    else process.env.STATIC_MODERATION_SEED_FALLBACK_MAX_CANDIDATES = prev;
  }
});

console.log('\nB (continued). Coordination read/write, against a STUBBED CampaignRun model');

// Stub models/CampaignRun BEFORE re-requiring moderationSeedFallback, so the
// module under test talks to an in-memory fake instead of needing a live
// Mongo connection — same require.cache technique
// scripts/verifyDirectorFallbackChain.js uses for costTracker.
const campaignRunPath = require.resolve('../models/CampaignRun');
const fakeRuns = new Map(); // runId -> { seedFallbacks: [...] }

function makeFakeCampaignRun() {
  return {
    findOne(filter) {
      const runId = filter.runId;
      const doc = fakeRuns.get(runId);
      const productIdFilter = filter['seedFallbacks.productId'];
      const matchesProduct = !doc ? false
        : (productIdFilter === undefined || (doc.seedFallbacks || []).some((e) => e.productId === productIdFilter));
      return {
        select() { return this; },
        lean: async () => (doc && matchesProduct ? JSON.parse(JSON.stringify(doc)) : (doc && productIdFilter === undefined ? JSON.parse(JSON.stringify(doc)) : null))
      };
    },
    async updateOne(filter, update) {
      const runId = filter.runId;
      if (!fakeRuns.has(runId)) fakeRuns.set(runId, { seedFallbacks: [] });
      const doc = fakeRuns.get(runId);
      const pid = filter['seedFallbacks.productId'];
      if (pid !== undefined) {
        const entry = doc.seedFallbacks.find((e) => e.productId === pid);
        if (!entry) return { matchedCount: 0 };
        if (update.$set) {
          for (const [k, v] of Object.entries(update.$set)) {
            if (k === 'seedFallbacks.$.resolvedMediaId') entry.resolvedMediaId = v;
          }
        }
        if (update.$addToSet) {
          for (const [k, v] of Object.entries(update.$addToSet)) {
            if (k === 'seedFallbacks.$.blocked') {
              entry.blocked = entry.blocked || [];
              if (!entry.blocked.includes(v)) entry.blocked.push(v);
            }
          }
        }
        return { matchedCount: 1 };
      }
      if (update.$push?.seedFallbacks) {
        doc.seedFallbacks.push(update.$push.seedFallbacks);
        return { matchedCount: 1 };
      }
      return { matchedCount: 0 };
    }
  };
}

require.cache[campaignRunPath] = {
  id: campaignRunPath, filename: campaignRunPath, loaded: true, children: [], paths: [],
  exports: makeFakeCampaignRun()
};
// Force a fresh require of the module under test against the stub above —
// it may already have been cached (and bound to the real model) by an
// earlier require in this same process (e.g. routes/ads.js, loaded below).
delete require.cache[require.resolve('../services/moderationSeedFallback')];
const seedFallbackStubbed = require('../services/moderationSeedFallback');

(async () => {
  await checkAsync('B7 readRunSeedState on an unknown run degrades to "nothing learned"', async () => {
    const state = await seedFallbackStubbed.readRunSeedState('run-does-not-exist', 'prod1');
    assert.deepStrictEqual(state, { resolvedMediaId: null, blockedMediaIds: [] });
  });

  await checkAsync('B8 recordSeedOutcome(resolved) then readRunSeedState round-trips the discovered seed', async () => {
    await seedFallbackStubbed.recordSeedOutcome('run-B8', 'prodA', { originalMediaId: 'hero', resolvedMediaId: 'alt2' });
    const state = await seedFallbackStubbed.readRunSeedState('run-B8', 'prodA');
    assert.strictEqual(state.resolvedMediaId, 'alt2');
  });

  await checkAsync('B9 recordSeedOutcome(blocked) accumulates, deduped on read, across repeated candidates', async () => {
    await seedFallbackStubbed.recordSeedOutcome('run-B9', 'prodB', { originalMediaId: 'hero', blockedMediaId: 'alt1' });
    await seedFallbackStubbed.recordSeedOutcome('run-B9', 'prodB', { originalMediaId: 'hero', blockedMediaId: 'alt2' });
    await seedFallbackStubbed.recordSeedOutcome('run-B9', 'prodB', { originalMediaId: 'hero', blockedMediaId: 'alt1' }); // repeat
    const state = await seedFallbackStubbed.readRunSeedState('run-B9', 'prodB');
    assert.deepStrictEqual([...state.blockedMediaIds].sort(), ['alt1', 'alt2']);
  });

  await checkAsync('B10 two products on the same run do not see each other\'s state', async () => {
    await seedFallbackStubbed.recordSeedOutcome('run-B10', 'prodX', { originalMediaId: 'hx', resolvedMediaId: 'ax' });
    await seedFallbackStubbed.recordSeedOutcome('run-B10', 'prodY', { originalMediaId: 'hy', blockedMediaId: 'by' });
    const stateX = await seedFallbackStubbed.readRunSeedState('run-B10', 'prodX');
    const stateY = await seedFallbackStubbed.readRunSeedState('run-B10', 'prodY');
    assert.strictEqual(stateX.resolvedMediaId, 'ax');
    assert.deepStrictEqual(stateX.blockedMediaIds, []);
    assert.strictEqual(stateY.resolvedMediaId, null);
    assert.deepStrictEqual(stateY.blockedMediaIds, ['by']);
  });

  await checkAsync('B11 a read/write failure degrades to "nothing learned" rather than throwing (never breaks a render)', async () => {
    const throwingPath = require.resolve('../models/CampaignRun');
    const prevExports = require.cache[throwingPath].exports;
    require.cache[throwingPath].exports = {
      findOne() { throw new Error('simulated Mongo outage'); },
      async updateOne() { throw new Error('simulated Mongo outage'); }
    };
    delete require.cache[require.resolve('../services/moderationSeedFallback')];
    const seedFallbackBroken = require('../services/moderationSeedFallback');
    try {
      const state = await seedFallbackBroken.readRunSeedState('run-B11', 'prodZ');
      assert.deepStrictEqual(state, { resolvedMediaId: null, blockedMediaIds: [] });
      // Must not throw, must not hang:
      await seedFallbackBroken.recordSeedOutcome('run-B11', 'prodZ', { originalMediaId: 'h', resolvedMediaId: 'a' });
    } finally {
      require.cache[throwingPath].exports = prevExports;
      delete require.cache[require.resolve('../services/moderationSeedFallback')];
    }
  });

  console.log('\nC. routes/ads.js — buildErrorEntry / buildModerationRollup (called, not regexed)');

  // routes/ads.js pulls in a lot (CampaignRun among it) — requiring it here,
  // AFTER the stub above, exercises the same stubbed model rather than
  // needing a live Mongo connection for anything the require graph touches
  // at load time.
  const adsRoute = require('../routes/ads.js');

  check('C1 buildErrorEntry carries the classified code/action through onto the errors[] row', () => {
    const entry = adsRoute.buildErrorEntry(
      { template: 'ai_editorial', aspectRatio: '1:1', mediaId: 'm1', productId: 'p1' },
      3, 'render',
      { message: 'direct-image render failed: Model Moderation Error (...)', code: 'IMAGE_MODERATION_BLOCKED', retryable: false }
    );
    assert.strictEqual(entry.code, 'IMAGE_MODERATION_BLOCKED');
    assert.strictEqual(entry.action, 'GAVE_UP_NO_RETRY');
    assert.strictEqual(entry.index, 3);
  });

  check('C2 buildErrorEntry: a retryable classified failure gets FAILED_RETRYABLE, not GAVE_UP', () => {
    const entry = adsRoute.buildErrorEntry(
      { template: 't', aspectRatio: '1:1' }, 0, 'render',
      { message: 'rate limited', code: 'IMAGE_RATE_LIMITED', retryable: true }
    );
    assert.strictEqual(entry.action, 'FAILED_RETRYABLE');
  });

  check('C3 buildErrorEntry: an unclassified plain-string failure still gets a row, code/action null (never throws)', () => {
    const entry = adsRoute.buildErrorEntry({ template: 't', aspectRatio: '1:1' }, 1, 'crash', 'boom');
    assert.strictEqual(entry.message, 'boom');
    assert.strictEqual(entry.code, null);
    assert.strictEqual(entry.action, null);
  });

  check('C4 buildModerationRollup: no matching errors -> null, not a zero-count object', () => {
    assert.strictEqual(adsRoute.buildModerationRollup([]), null);
    assert.strictEqual(adsRoute.buildModerationRollup([{ code: 'IMAGE_RATE_LIMITED', productId: 'p1' }]), null);
  });

  check('C5 buildModerationRollup: reproduces the actual incident shape — 18/18 statics, one product', () => {
    const errors = Array.from({ length: 18 }, (_, i) => ({
      index: i, code: 'IMAGE_MODERATION_BLOCKED', productId: '6a8572e6b31cf7b22149ca01', message: 'x'
    }));
    const rollup = adsRoute.buildModerationRollup(errors);
    assert.ok(rollup, 'expected a non-null rollup for 18 moderation-coded errors');
    assert.strictEqual(rollup.count, 18);
    assert.deepStrictEqual(rollup.productIds, ['6a8572e6b31cf7b22149ca01']);
    assert.ok(/not a bug/.test(rollup.message));
  });

  console.log('\nD. services/renderService.js — failed() threads code/retryable, does not guess for a give-up');

  const { failed } = require('../services/renderService.js');

  check('D1 failed(): a classified moderation error carries its code and retryable:false through', () => {
    const out = failed('job1', 'render', { message: 'x', code: 'IMAGE_MODERATION_BLOCKED', retryable: false });
    assert.strictEqual(out.error.code, 'IMAGE_MODERATION_BLOCKED');
    assert.strictEqual(out.error.retryable, false, 'the OLD code said retryable:true here (stage!=="validate") — that was the bug this fixes');
  });

  check('D2 failed(): an unclassified error falls back to the old stage-based guess, unchanged', () => {
    const outRender = failed('job2', 'render', { message: 'x' });
    assert.strictEqual(outRender.error.code, null);
    assert.strictEqual(outRender.error.retryable, true, 'pre-existing behaviour for a non-validate stage must be unchanged');

    const outValidate = failed('job3', 'validate', { message: 'x' });
    assert.strictEqual(outValidate.error.retryable, false, 'pre-existing validate-stage behaviour must be unchanged');
  });

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('Failed:', failures.join(', '));
    process.exit(1);
  }
})();
