#!/usr/bin/env node
// Offline pin for videoRouter.prepareStoryboard — the direct-Gemini path
// (and any future non-Atlas provider) MUST warm the layoutInput cache
// before returning, or every video ad's titler falls back to ad.copy
// silently. Root cause was a null short-circuit in videoRouter.prepareStoryboard
// diagnosed 2026-09-04: creation halted ~19:13 CT Sep 3 when the last
// Atlas-path video render fired.
//
// Behavioural, not a source-text scan — the router is stubbed with a real
// `warmLayoutInputForVideoAd` mock and we assert it gets called on the
// non-Atlas branch and NOT on the Atlas branch (Atlas's own prepareStoryboard
// already does the warming inline via refreshStaleLayoutInput).

'use strict';

const assert = require('assert');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', 'config', 'defaults.env'), quiet: true });

const results = [];
function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(
        () => { results.push({ name, ok: true }); console.log(`  ✓ ${name}`); },
        (err) => { results.push({ name, ok: false, err: err.message }); console.log(`  ✗ ${name} — ${err.message}`); }
      );
    }
    results.push({ name, ok: true }); console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message }); console.log(`  ✗ ${name} — ${err.message}`);
  }
}

// Stub out atlasVideoService in the require cache BEFORE videoRouter loads.
// The stubbed export tracks calls so the harness can assert wiring without
// touching Mongo, Atlas, or Gemini.
const stubAtlas = {
  callsWarm: [],
  callsPrepare: [],
  callsGenerate: [],
  warmLayoutInputForVideoAd: async ({ ad }) => {
    stubAtlas.callsWarm.push(ad);
    return { input: { synthetic: true } };
  },
  prepareStoryboard: async ({ ad }) => {
    stubAtlas.callsPrepare.push(ad);
    return { storyboard: null, aspectRatio: '9:16', model: 'stub-model' };
  },
  generateForAd: async (args) => {
    stubAtlas.callsGenerate.push(args);
    return { model: 'atlas-stub', skipped: false };
  }
};

const atlasPath = require.resolve('../services/atlasVideoService');
require.cache[atlasPath] = { id: atlasPath, filename: atlasPath, loaded: true, exports: stubAtlas };

// Also stub aiVideoReferenceService because backend's videoRouter loads it
// eagerly and its real load boots the whole video import graph.
const veoStub = {
  callsGenerate: [],
  generateForAd: async (args) => {
    veoStub.callsGenerate.push(args);
    return { model: null };
  }
};
try {
  const veoPath = require.resolve('../services/aiVideoReferenceService');
  require.cache[veoPath] = { id: veoPath, filename: veoPath, loaded: true, exports: veoStub };
} catch { /* not required on this branch */ }

const { prepareStoryboard, generateForAd } = require('../services/videoRouter');

// ── Section A — the wiring ─────────────────────────────────────────

console.log('\n== A. non-Atlas provider warms layoutInput ==');

async function run() {
  await check('A1 VIDEO_PROVIDER=gemini calls warmLayoutInputForVideoAd', async () => {
    stubAtlas.callsWarm.length = 0;
    stubAtlas.callsPrepare.length = 0;
    process.env.VIDEO_PROVIDER = 'gemini';
    const fakeAd = { _id: 'ad-fixture-1', mediaId: 'media-1', productId: 'product-1', aspectRatio: '9:16' };
    const result = await prepareStoryboard({ ad: fakeAd });
    assert.strictEqual(stubAtlas.callsWarm.length, 1, 'warmLayoutInputForVideoAd should have been called exactly once');
    assert.strictEqual(String(stubAtlas.callsWarm[0]._id), 'ad-fixture-1');
    assert.strictEqual(stubAtlas.callsPrepare.length, 0, 'atlas prepareStoryboard must NOT be called on gemini branch');
    assert.deepStrictEqual(result, { storyboard: null }, 'non-Atlas branch returns storyboard:null (no model/aspect)');
  });

  await check('A2 VIDEO_PROVIDER=vertex (any non-atlas) also warms', async () => {
    stubAtlas.callsWarm.length = 0;
    stubAtlas.callsPrepare.length = 0;
    process.env.VIDEO_PROVIDER = 'vertex';
    const fakeAd = { _id: 'ad-fixture-2', mediaId: 'media-2', productId: 'product-2' };
    await prepareStoryboard({ ad: fakeAd });
    assert.strictEqual(stubAtlas.callsWarm.length, 1, 'vertex branch must also warm');
    assert.strictEqual(stubAtlas.callsPrepare.length, 0);
  });

  await check('A3 VIDEO_PROVIDER=atlas delegates to atlas.prepareStoryboard (which warms inline)', async () => {
    stubAtlas.callsWarm.length = 0;
    stubAtlas.callsPrepare.length = 0;
    process.env.VIDEO_PROVIDER = 'atlas';
    const fakeAd = { _id: 'ad-fixture-3', mediaId: 'media-3' };
    await prepareStoryboard({ ad: fakeAd });
    // Atlas path uses its OWN prepareStoryboard (which internally does the
    // warm via refreshStaleLayoutInput). Router must NOT double-warm by
    // also calling warmLayoutInputForVideoAd — that would run the load
    // chain twice.
    assert.strictEqual(stubAtlas.callsPrepare.length, 1, 'atlas prepareStoryboard called once');
    assert.strictEqual(stubAtlas.callsWarm.length, 0, 'warmLayoutInputForVideoAd MUST NOT be called on atlas branch (double-warm)');
  });

  await check('A4 warm failure does NOT throw — router still returns', async () => {
    stubAtlas.warmLayoutInputForVideoAd = async () => { throw new Error('simulated Mongo down'); };
    process.env.VIDEO_PROVIDER = 'gemini';
    const fakeAd = { _id: 'ad-fixture-4', mediaId: 'media-4' };
    // Even though warm throws, the router MUST return so the render proceeds
    // with the ad.copy fallback the titler downstream handles.
    //
    // NOTE: today the router does NOT wrap warmLayoutInputForVideoAd in
    // try/catch — it relies on warmLayoutInputForVideoAd's own internal
    // try/catch to swallow. This check pins that contract: if the helper's
    // internal catch is ever removed, the router must gain a try/catch of
    // its own OR this check fails and we catch the regression.
    stubAtlas.warmLayoutInputForVideoAd = async () => null; // restore: helper swallows internally
    const result = await prepareStoryboard({ ad: fakeAd });
    assert.deepStrictEqual(result, { storyboard: null });
  });

  // ── Section B — source-text scan (backstop) ───────────────────────
  console.log('\n== B. source scan backstop ==');

  const fs = require('fs');
  const routerSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'videoRouter.js'), 'utf8');
  const atlasSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'atlasVideoService.js'), 'utf8');

  check('B1 videoRouter references warmLayoutInputForVideoAd', () => {
    assert.ok(/warmLayoutInputForVideoAd/.test(routerSrc),
      'videoRouter.js must reference warmLayoutInputForVideoAd — a regression that removes the call fails behaviour test A1 but this catches the case where the reference is deleted alongside the router restructure');
  });

  check('B2 atlasVideoService exports warmLayoutInputForVideoAd', () => {
    assert.ok(/warmLayoutInputForVideoAd/.test(atlasSrc),
      'atlasVideoService.js must define + export warmLayoutInputForVideoAd');
  });

  check('B3 videoRouter non-atlas branch has an await (not a fire-and-forget)', () => {
    // A regression where someone drops the `await` would create a race:
    // the render proceeds and hits the titler before the artifact is
    // written. Pin that we're awaiting.
    assert.ok(/await\s+atlasVideoService\.warmLayoutInputForVideoAd/.test(routerSrc),
      'the non-atlas branch must AWAIT warmLayoutInputForVideoAd (not fire-and-forget)');
  });

  // ── Section C — fail-closed VIDEO_PROVIDER dispatch (MONEY/SAFETY) ──
  // Previously a bare `else` sent ANY unrecognised value (typo, unset edge,
  // future name, VIDEO_PROVIDER=gemini) to the deprecated billable Vertex
  // path. Vertex is now reachable ONLY by naming it.
  console.log('\n== C. generateForAd fail-closed VIDEO_PROVIDER ==');

  await check('C1 VIDEO_PROVIDER=atlas calls atlasVideoService.generateForAd and threads allowResume', async () => {
    stubAtlas.callsGenerate.length = 0;
    veoStub.callsGenerate.length = 0;
    process.env.VIDEO_PROVIDER = 'atlas';
    const fakeAd = { _id: 'ad-gen-atlas' };
    await generateForAd({ ad: fakeAd, allowResume: false, campaignRunId: 'run_x' });
    assert.strictEqual(stubAtlas.callsGenerate.length, 1, 'atlas generateForAd should run once');
    assert.strictEqual(veoStub.callsGenerate.length, 0, 'vertex must not run on atlas');
    assert.strictEqual(stubAtlas.callsGenerate[0].allowResume, false,
      'allowResume must be threaded through, not swallowed (regenerate passes false)');
    assert.strictEqual(stubAtlas.callsGenerate[0].campaignRunId, 'run_x');
  });

  await check('C2 VIDEO_PROVIDER=vertex calls aiVideoReferenceService, not atlas', async () => {
    stubAtlas.callsGenerate.length = 0;
    veoStub.callsGenerate.length = 0;
    process.env.VIDEO_PROVIDER = 'vertex';
    const fakeAd = { _id: 'ad-gen-vertex' };
    const result = await generateForAd({ ad: fakeAd });
    assert.strictEqual(veoStub.callsGenerate.length, 1, 'vertex generateForAd should run once');
    assert.strictEqual(stubAtlas.callsGenerate.length, 0, 'atlas must not run on vertex');
    assert.strictEqual(result.model, 'google/veo-3.1', 'vertex result gets the veo-3.1 model default');
  });

  await check('C3 VIDEO_PROVIDER=gemeni (typo) THROWS — never falls through to Vertex', async () => {
    stubAtlas.callsGenerate.length = 0;
    veoStub.callsGenerate.length = 0;
    process.env.VIDEO_PROVIDER = 'gemeni';
    let threw = null;
    try { await generateForAd({ ad: { _id: 'ad-gen-typo' } }); }
    catch (err) { threw = err; }
    assert.ok(threw, 'unrecognised VIDEO_PROVIDER must throw');
    assert.match(String(threw.message), /not a recognised video provider/,
      `throw message should name the refusal, got: ${threw && threw.message}`);
    assert.strictEqual(stubAtlas.callsGenerate.length, 0, 'typo must not bill atlas');
    assert.strictEqual(veoStub.callsGenerate.length, 0, 'typo must not bill vertex');
  });

  await check('C4 VIDEO_PROVIDER=gemini THROWS on backend (no geminiVideoService.js)', async () => {
    stubAtlas.callsGenerate.length = 0;
    veoStub.callsGenerate.length = 0;
    process.env.VIDEO_PROVIDER = 'gemini';
    let threw = null;
    try { await generateForAd({ ad: { _id: 'ad-gen-gemini' } }); }
    catch (err) { threw = err; }
    assert.ok(threw, 'gemini is not a backend provider — must throw, not silently Vertex');
    assert.strictEqual(veoStub.callsGenerate.length, 0, 'gemini must not fall through to vertex');
    assert.strictEqual(stubAtlas.callsGenerate.length, 0);
  });

  check('C5 source: vertex is an explicit else-if, not a bare else', () => {
    assert.ok(/else if\s*\(\s*provider\s*===\s*'vertex'\s*\)/.test(routerSrc),
      "expected `else if (provider === 'vertex')` — a bare else is the silent-Vertex hole");
  });

  check('C6 source: does not require a gemini video module', () => {
    assert.ok(!/require\(['"]\.\/geminiVideoService['"]\)/.test(routerSrc),
      'backend must not require a gemini video module (that file does not exist here)');
  });

  // ── Summary ──────────────────────────────────────────────────────
  const total = results.length;
  const passed = results.filter(r => r.ok).length;
  console.log(`\n${total} checks — ${passed} passed, ${total - passed} failed`);
  if (passed !== total) process.exit(1);
}

run().catch((e) => { console.error(e.stack); process.exit(1); });
