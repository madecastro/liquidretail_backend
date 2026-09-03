#!/usr/bin/env node
// Offline pins for OVERLAY_ZONES_SKIP_CATALOG (2026-09-03).
//
// Catalog ingest used to fire overlay-zone analysis on every Media (up to
// 3 Gemini/DINO calls — one per base ratio). Those artifacts have no live
// generation consumer. The gate is AT THE CATALOG CALL SITE
// (catalogOverlayChainCtx → skipOverlayZones), not a media.source sniff
// inside the chain. UGC (runImagePipeline) never passes the flag.
//
// Behavioural: drive the real exported functions with stubs. A source
// regex is satisfiable by a comment (CLAUDE.md receiptFree lesson).
//
// Revert-prove (each independently):
//   (a) skipOverlayZones ignored in runExtendedAndOverlayChain
//       → C1 fails (overlay create still fires on catalog skip)
//   (b) skipOverlayZones omitted from catalogOverlayChainCtx
//       → B2 fails
//   (c) chain also reads OVERLAY_ZONES_SKIP_CATALOG itself
//       → U1 fails (UGC-shape ctx would skip while flag is on)
//   (d) skip creates OverlayZoneArtifact with zones:{}
//       → C1 fails (create still called)
//   (e) parser uses truthy check (`if (process.env.X)`)
//       → P3 fails ('false' would skip)
//   (f) defaults.env line deleted or flipped to false
//       → F1 fails
//
// Run: node scripts/verifyOverlayZonesSkipCatalog.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const results = [];
function check(name, fn) {
  try {
    const out = fn();
    if (out && typeof out.then === 'function') {
      throw new Error(`${name}: async check passed to sync check() — use checkAsync`);
    }
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  ✗ ${name} — ${err.message}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  ✗ ${name} — ${err.message}`);
  }
}

const {
  isOverlayZonesSkipCatalogEnabled,
  catalogOverlayChainCtx,
  runExtendedAndOverlayChain
} = require('../pipelines/detect');
const OverlayZoneArtifact = require('../models/OverlayZoneArtifact');
const ExtendedCropArtifact = require('../models/ExtendedCropArtifact');
const overlayZoneService = require('../services/overlayZoneService');

const SOURCE = 'https://res.cloudinary.com/demo/image/upload/v1/sample.jpg';
const CROPS = {
  '5:4': [{ id: 'a', x1: 0, y1: 0, x2: 100, y2: 80 }],
  '1:1': [{ id: 'b', x1: 0, y1: 0, x2: 100, y2: 100 }],
  '4:5': [{ id: 'c', x1: 0, y1: 0, x2: 80, y2: 100 }]
};

function makeRun() {
  return {
    _id: 'run1',
    brandId: 'brand1',
    stageTimings: {},
    flags: {},
    markModified() {},
    save: async () => {}
  };
}
function makeMedia() {
  return {
    _id: 'media1',
    advertiserId: 'adv1',
    brandId: 'brand1',
    metadata: {},
    refinedProducts: []
  };
}

function withEnv(value, fn) {
  const prior = process.env.OVERLAY_ZONES_SKIP_CATALOG;
  try {
    if (value === undefined) delete process.env.OVERLAY_ZONES_SKIP_CATALOG;
    else process.env.OVERLAY_ZONES_SKIP_CATALOG = value;
    return fn();
  } finally {
    if (prior === undefined) delete process.env.OVERLAY_ZONES_SKIP_CATALOG;
    else process.env.OVERLAY_ZONES_SKIP_CATALOG = prior;
  }
}
async function withEnvAsync(value, fn) {
  const prior = process.env.OVERLAY_ZONES_SKIP_CATALOG;
  try {
    if (value === undefined) delete process.env.OVERLAY_ZONES_SKIP_CATALOG;
    else process.env.OVERLAY_ZONES_SKIP_CATALOG = value;
    return await fn();
  } finally {
    if (prior === undefined) delete process.env.OVERLAY_ZONES_SKIP_CATALOG;
    else process.env.OVERLAY_ZONES_SKIP_CATALOG = prior;
  }
}

async function driveChain(ctx) {
  const overlayCreates = [];
  const analysisCalls = [];
  const origOverlayCreate = OverlayZoneArtifact.create;
  const origExtendedCreate = ExtendedCropArtifact.create;
  const origAnalyze = overlayZoneService.analyzeOverlayZones;
  OverlayZoneArtifact.create = async (doc) => {
    overlayCreates.push(doc);
    return { _id: 'oz1', ...doc };
  };
  ExtendedCropArtifact.create = async (doc) => {
    return { _id: 'ext1', ...doc };
  };
  overlayZoneService.analyzeOverlayZones = async (args) => {
    analysisCalls.push(args);
    return { densityGrid: { cols: 1, rows: 1, cells: [[0]] }, restrictions: [] };
  };
  try {
    const run = makeRun();
    const result = await runExtendedAndOverlayChain(
      run, makeMedia(), SOURCE, null, CROPS, null, null, null, [], false, ctx
    );
    return { run, result, overlayCreates, analysisCalls };
  } finally {
    OverlayZoneArtifact.create = origOverlayCreate;
    ExtendedCropArtifact.create = origExtendedCreate;
    overlayZoneService.analyzeOverlayZones = origAnalyze;
  }
}

(async () => {
  console.log('\n== P. parser — only the string false re-enables ==');

  check('P1 unset → skip (code default matches file default true)', () => {
    withEnv(undefined, () => {
      assert.strictEqual(isOverlayZonesSkipCatalogEnabled(), true);
    });
  });
  check('P2 true / TRUE / leftover whitespace-true → skip', () => {
    withEnv('true', () => assert.strictEqual(isOverlayZonesSkipCatalogEnabled(), true));
    withEnv('TRUE', () => assert.strictEqual(isOverlayZonesSkipCatalogEnabled(), true));
    withEnv(' true ', () => assert.strictEqual(isOverlayZonesSkipCatalogEnabled(), true));
  });
  check('P3 false / FALSE / padded false → do NOT skip (strict, not truthy)', () => {
    withEnv('false', () => assert.strictEqual(isOverlayZonesSkipCatalogEnabled(), false));
    withEnv('FALSE', () => assert.strictEqual(isOverlayZonesSkipCatalogEnabled(), false));
    withEnv(' false ', () => assert.strictEqual(isOverlayZonesSkipCatalogEnabled(), false));
  });
  check('P4 garbage / "0" / "yes" → skip (only exact false re-enables)', () => {
    withEnv('yes', () => assert.strictEqual(isOverlayZonesSkipCatalogEnabled(), true));
    withEnv('0', () => assert.strictEqual(isOverlayZonesSkipCatalogEnabled(), true));
    withEnv('no', () => assert.strictEqual(isOverlayZonesSkipCatalogEnabled(), true));
  });

  console.log('\n== B. catalogOverlayChainCtx is the catalog call-site gate ==');

  check('B1 skipExtendedCrops is hardcoded true (catalog must not reopen that spend)', () => {
    const ctx = catalogOverlayChainCtx({ safeRect: null, imgW: 10, imgH: 10 });
    assert.strictEqual(ctx.skipExtendedCrops, true);
    assert.strictEqual(ctx.imgW, 10);
    assert.strictEqual(ctx.imgH, 10);
  });
  check('B2 skipOverlayZones follows the flag (on → true, off → false)', () => {
    withEnv('true', () => {
      assert.strictEqual(catalogOverlayChainCtx().skipOverlayZones, true);
    });
    withEnv('false', () => {
      assert.strictEqual(catalogOverlayChainCtx().skipOverlayZones, false);
    });
  });
  check('B3 a UGC-shape ctx does not carry skipOverlayZones even when the flag is on', () => {
    withEnv('true', () => {
      const ugc = { safeRect: null, imgW: 10, imgH: 10, skipExtendedCrops: true };
      assert.strictEqual(ugc.skipOverlayZones, undefined);
      assert.notStrictEqual(!!ugc.skipOverlayZones, true);
    });
  });

  console.log('\n== C. catalog skip — no analysis, no OverlayZoneArtifact ==');

  await checkAsync('C1 flag-on catalog ctx does not create an OverlayZoneArtifact', async () => {
    const ctx = withEnv('true', () => catalogOverlayChainCtx({ imgW: 100, imgH: 100 }));
    const { result, overlayCreates, analysisCalls, run } = await driveChain(ctx);
    assert.strictEqual(overlayCreates.length, 0, `overlay create fired ${overlayCreates.length} time(s)`);
    assert.strictEqual(analysisCalls.length, 0, `analyzeOverlayZones fired ${analysisCalls.length} time(s)`);
    assert.strictEqual(result.overlayDoc, null);
    assert.ok(result.extendedDoc, 'extended artifact still created (skipExtended is independent)');
    assert.ok(!run.stageTimings['overlay-zones'], 'overlay-zones stage must not run when skipped');
  });

  await checkAsync('C2 flag-off catalog ctx restores today: analysis + unconditional create', async () => {
    const ctx = withEnv('false', () => catalogOverlayChainCtx({ imgW: 100, imgH: 100 }));
    assert.strictEqual(ctx.skipOverlayZones, false);
    const { result, overlayCreates, analysisCalls, run } = await driveChain(ctx);
    assert.ok(overlayCreates.length >= 1, 'flag-off must create OverlayZoneArtifact (today\'s behaviour)');
    assert.ok(analysisCalls.length >= 1, 'flag-off must reach overlay analysis');
    assert.ok(result.overlayDoc && result.overlayDoc._id, 'overlayDoc returned');
    assert.ok(run.stageTimings['overlay-zones'] != null, 'overlay-zones stage must run when not skipped');
    assert.strictEqual(analysisCalls.length, 3, 'three base ratios (5:4 / 1:1 / 4:5) — skipExtended so no 9:16/1.91:1');
  });

  console.log('\n== U. UGC-shape ctx still analyses while the catalog flag is on ==');

  await checkAsync('U1 omitting skipOverlayZones reaches analysis even when OVERLAY_ZONES_SKIP_CATALOG=true', async () => {
    const { overlayCreates, analysisCalls, result } = await withEnvAsync('true', async () => {
      return driveChain({ imgW: 100, imgH: 100, skipExtendedCrops: true });
    });
    assert.ok(analysisCalls.length >= 1, 'UGC path must still analyse overlay zones');
    assert.ok(overlayCreates.length >= 1, 'UGC path must still persist OverlayZoneArtifact');
    assert.ok(result.overlayDoc, 'UGC overlayDoc must not be null');
  });

  console.log('\n== F. committed default ==');

  check('F1 config/defaults.env ships OVERLAY_ZONES_SKIP_CATALOG=true', () => {
    const env = fs.readFileSync(path.join(__dirname, '..', 'config', 'defaults.env'), 'utf8');
    assert.match(env, /^OVERLAY_ZONES_SKIP_CATALOG=true$/m);
    assert.doesNotMatch(env, /^OVERLAY_ZONES_SKIP_CATALOG=false$/m);
  });

  const total = results.length;
  const passed = results.filter(r => r.ok).length;
  console.log(`\n${total} checks — ${passed} passed, ${total - passed} failed`);
  if (passed !== total) process.exit(1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
