#!/usr/bin/env node
'use strict';
/**
 * PORTED from liquidretail_backend/scripts/verifyFaceKeepOut.js into
 * liquidretail_adgen. Path adjustment (services/ -> src/services/, remotion/
 * -> src/remotion/) plus a Module._load stub so a bare adgen worktree can
 * require the live files without node_modules. plateHints.js is ESM
 * (src/remotion is "type":"module") so C-group imports it via dynamic import
 * rather than require — still the live file, not a reimplementation.
 * Every backend assertion is preserved.
 *
 * verifyFaceKeepOut — offline suite for title face keep-out + ink-vote tie-break.
 *
 * Pins:
 *   A. band/face intersection → avoid mapping (pure applyFaceKeepOut)
 *      including SOURCE-fraction → plate-fraction conversion via cropRect
 *   B. TITLE_FACE_KEEPOUT=false → ensureFaceDetectionForKeepOut is a no-op
 *      (no detection call; behavioural stub counting calls)
 *   C. ink-vote tie-break: tie+light global, tie+dark global, non-tie unchanged
 *
 * No DB, no network, no API key. Safe in CI.
 *
 *   node scripts/verifyFaceKeepOut.js
 */

process.env.ADGEN_ROLE = process.env.ADGEN_ROLE || 'api';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://offline-harness/unused';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');

function seed(rel, exports) {
  const abs = require.resolve(path.join(ROOT, rel));
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports };
  return abs;
}

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'axios') {
    return { get: async () => ({ data: Buffer.alloc(0), headers: {} }), post: async () => ({}) };
  }
  if (request === 'sharp') {
    const chain = {
      metadata: async () => ({ width: 1080, height: 1920 }),
      greyscale() { return this; },
      resize() { return this; },
    };
    return () => chain;
  }
  if (request === 'ffmpeg-static') return '/bin/false';
  return origLoad.apply(this, arguments);
};

seed('src/models/Ad.js', { updateOne: async () => ({}) });
seed('src/services/atlasLlmService.js', {
  chatCompletion: async () => { throw new Error('atlasLlmService.chatCompletion must not run in this harness'); },
});
seed('src/services/adStage.js', { noteRenderIssue() {}, adStage() {} });

const {
  applyFaceKeepOut,
  bandFaceOverlapFrac,
  mapSourceFaceToPlate,
  unionFaceBoxes,
  BANDS,
  FACE_BAND_OVERLAP_THRESHOLD,
} = require('../src/services/plateIntelService');
const basePlateCrop = require('../src/services/basePlateCropService');

let pass = 0;
const failures = [];
function check(label, fn) {
  try { fn(); pass++; }
  catch (err) { failures.push(`${label}: ${err.message}`); }
}

console.log('\nverifyFaceKeepOut\n');

// ── helpers ─────────────────────────────────────────────────────────────────
function emptyHints(atSecs = [0.5, 2.0, 4.0, 6.0]) {
  return {
    samples: atSecs.map((atSec) => ({
      atSec,
      bands: {
        top: { lum: 0.7, busy: 0.1, avoid: false },
        middle: { lum: 0.4, busy: 0.2, avoid: false },
        bottom: { lum: 0.5, busy: 0.1, avoid: false },
      },
    })),
  };
}

// Face covering most of the top text band [0.14, 0.28] → >20% of band.
const FACE_ON_TOP = { left: 0.2, top: 0.10, right: 0.8, bottom: 0.30 };
// Face entirely in lower half — no top-band overlap.
const FACE_LOWER = { left: 0.3, top: 0.70, right: 0.7, bottom: 0.95 };
// Tiny face whose intersection with top band is well under 20%.
const FACE_TINY_TOP_EDGE = { left: 0.4, top: 0.26, right: 0.5, bottom: 0.29 };

// ── A. overlap pure math ────────────────────────────────────────────────────
check('A1 FACE_BAND_OVERLAP_THRESHOLD is 0.20', () => {
  assert.strictEqual(FACE_BAND_OVERLAP_THRESHOLD, 0.20);
});

check('A2 full cover of top band → overlap ~1', () => {
  const band = { left: 0.08, top: 0.14, right: 0.92, bottom: 0.28 };
  const face = { left: 0.0, top: 0.0, right: 1.0, bottom: 1.0 };
  assert.ok(bandFaceOverlapFrac(band, face) > 0.99);
});

check('A3 disjoint rects → overlap 0', () => {
  const band = { left: 0.08, top: 0.14, right: 0.92, bottom: 0.28 };
  assert.strictEqual(bandFaceOverlapFrac(band, FACE_LOWER), 0);
});

check('A4 tiny edge face → overlap < 0.20', () => {
  const band = { left: 0.08, top: 0.14, right: 0.92, bottom: 0.28 };
  const o = bandFaceOverlapFrac(band, FACE_TINY_TOP_EDGE);
  assert.ok(o < 0.20, `expected <0.20 got ${o}`);
});

check('A5 face on top band → overlap > 0.20', () => {
  const band = { left: 0.08, top: 0.14, right: 0.92, bottom: 0.28 };
  const o = bandFaceOverlapFrac(band, FACE_ON_TOP);
  assert.ok(o > 0.20, `expected >0.20 got ${o}`);
});

// ── A. applyFaceKeepOut mapping ─────────────────────────────────────────────
check('A6 face on top → top avoid; middle/bottom clear', () => {
  const hints = applyFaceKeepOut(emptyHints(), [{ atSec: 2.0, face: FACE_ON_TOP }]);
  // Nearest sample to 2.0 among [0.5,2,4,6] is 2.0
  const s = hints.samples.find((x) => x.atSec === 2.0);
  assert.strictEqual(s.bands.top.avoid, true);
  assert.strictEqual(s.bands.middle.avoid, false);
  assert.strictEqual(s.bands.bottom.avoid, false);
});

check('A7 <20% overlap does NOT flag avoid', () => {
  const hints = applyFaceKeepOut(emptyHints(), [{ atSec: 2.0, face: FACE_TINY_TOP_EDGE }]);
  const s = hints.samples.find((x) => x.atSec === 2.0);
  assert.strictEqual(s.bands.top.avoid, false);
});

check('A8 >20% overlap DOES flag avoid', () => {
  // Synthetic band-sized face that covers just over 20% of top band.
  // Top band area = 0.84 * 0.14 = 0.1176. 20% = 0.02352.
  // Face width 0.84, height h → area 0.84*h; need 0.84*h / 0.1176 > 0.20 → h > 0.028.
  // Place face fully inside top band with h=0.04 → overlap ≈ 0.286.
  const face = { left: 0.08, top: 0.15, right: 0.92, bottom: 0.19 };
  const hints = applyFaceKeepOut(emptyHints(), [{ atSec: 2.0, face }]);
  assert.strictEqual(hints.samples.find((x) => x.atSec === 2.0).bands.top.avoid, true);
});

check('A9 multiple boxes UNION: two partial faces together flag; either alone may not', () => {
  // Two faces each covering ~12% of the top band (under threshold alone),
  // but their union covers ~24% (over threshold).
  // Band area = 0.84 * 0.14 = 0.1176; 12% ≈ 0.0141 → height ≈ 0.0168 over full width.
  const leftHalf = { left: 0.08, top: 0.14, right: 0.50, bottom: 0.20 }; // w=0.42 h=0.06 area=0.0252 / 0.1176 ≈ 0.214 — hmm over
  // Need each alone <20%, union >20%.
  // left: w=0.42, h=0.04 → area 0.0168 / 0.1176 ≈ 0.143
  // right: same on the right
  // union: w=0.84, h=0.04 → area 0.0336 / 0.1176 ≈ 0.286
  const a = { left: 0.08, top: 0.16, right: 0.50, bottom: 0.20 };
  const b = { left: 0.50, top: 0.16, right: 0.92, bottom: 0.20 };
  const band = { left: 0.08, top: 0.14, right: 0.92, bottom: 0.28 };
  assert.ok(bandFaceOverlapFrac(band, a) < 0.20, `left alone ${bandFaceOverlapFrac(band, a)}`);
  assert.ok(bandFaceOverlapFrac(band, b) < 0.20, `right alone ${bandFaceOverlapFrac(band, b)}`);
  const u = unionFaceBoxes([a, b]);
  assert.ok(bandFaceOverlapFrac(band, u) > 0.20, `union ${bandFaceOverlapFrac(band, u)}`);

  const aloneA = applyFaceKeepOut(emptyHints([2.0]), [{ atSec: 2.0, face: a }]);
  assert.strictEqual(aloneA.samples[0].bands.top.avoid, false);
  const aloneB = applyFaceKeepOut(emptyHints([2.0]), [{ atSec: 2.0, face: b }]);
  assert.strictEqual(aloneB.samples[0].bands.top.avoid, false);
  const both = applyFaceKeepOut(emptyHints([2.0]), [
    { atSec: 2.0, face: a },
    { atSec: 2.0, face: b },
  ]);
  assert.strictEqual(both.samples[0].bands.top.avoid, true);
});

check('A10 atSec null (envelope) applies to ALL plate samples', () => {
  const hints = applyFaceKeepOut(emptyHints(), [{ atSec: null, face: FACE_ON_TOP }]);
  for (const s of hints.samples) {
    assert.strictEqual(s.bands.top.avoid, true, `sample@${s.atSec} top not avoided`);
  }
});

check('A11 timed sample maps to nearest plateHints time only', () => {
  const hints = applyFaceKeepOut(emptyHints([0.5, 2.0, 4.0, 6.0]), [
    { atSec: 1.9, face: FACE_ON_TOP },
  ]);
  assert.strictEqual(hints.samples.find((x) => x.atSec === 2.0).bands.top.avoid, true);
  assert.strictEqual(hints.samples.find((x) => x.atSec === 0.5).bands.top.avoid, false);
  assert.strictEqual(hints.samples.find((x) => x.atSec === 4.0).bands.top.avoid, false);
});

// ── A. coordinate conversion (source fractions → plate via crop rect) ───────
check('A12 uncropped map is identity', () => {
  const m = mapSourceFaceToPlate(FACE_ON_TOP, {});
  assert.deepStrictEqual(m, FACE_ON_TOP);
});

check('A13 crop rect maps source fractions into plate fractions', () => {
  // Source 1080x1920; crop window cy=270, ch=1350 (typical 4:5 of 9:16).
  // A face at source top=0.08 → y_px=153.6; plateY = (153.6-270)/1350 = -0.086
  // A face at source top=0.20 → y_px=384; plateY = (384-270)/1350 = 0.0844
  const rect = { cx: 0, cy: 270, cw: 1080, ch: 1350, anchorY: 'face-safe' };
  const face = { left: 0.3, top: 0.20, right: 0.7, bottom: 0.40 };
  const m = mapSourceFaceToPlate(face, { cropRect: rect, sourceW: 1080, sourceH: 1920 });
  assert.ok(Math.abs(m.top - (0.20 * 1920 - 270) / 1350) < 1e-9);
  assert.ok(Math.abs(m.bottom - (0.40 * 1920 - 270) / 1350) < 1e-9);
  assert.ok(Math.abs(m.left - 0.3) < 1e-9); // full-width crop, x identity
});

check('A14 face outside crop window does not flag plate bands', () => {
  // Face entirely above the 4:5 crop window → plateY all negative → no band overlap.
  const rect = { cx: 0, cy: 400, cw: 1080, ch: 1350, anchorY: 'face-safe' };
  const faceAbove = { left: 0.3, top: 0.02, right: 0.7, bottom: 0.12 }; // max y_px=230.4 < 400
  const hints = applyFaceKeepOut(emptyHints([2.0]), [{ atSec: 2.0, face: faceAbove }], {
    cropRect: rect, sourceW: 1080, sourceH: 1920,
  });
  assert.strictEqual(hints.samples[0].bands.top.avoid, false);
  assert.strictEqual(hints.samples[0].bands.middle.avoid, false);
});

check('A15 face inside crop maps into top band and flags avoid', () => {
  // Crop cy=0 (top-aligned window) so source top band ≈ plate top band.
  const rect = { cx: 0, cy: 0, cw: 1080, ch: 1350, anchorY: 'face-safe' };
  const hints = applyFaceKeepOut(emptyHints([2.0]), [{ atSec: 2.0, face: FACE_ON_TOP }], {
    cropRect: rect, sourceW: 1080, sourceH: 1920,
  });
  // source top 0.10 → plate 0.10*1920/1350 = 0.142; bottom 0.30 → 0.427
  // Still intersects plate top band [0.14, 0.28] substantially.
  assert.strictEqual(hints.samples[0].bands.top.avoid, true);
});

check('A16 null plateHints / empty faces is a no-op', () => {
  assert.strictEqual(applyFaceKeepOut(null, [{ atSec: 1, face: FACE_ON_TOP }]), null);
  const h = emptyHints([1]);
  const out = applyFaceKeepOut(h, []);
  assert.strictEqual(out.samples[0].bands.top.avoid, false);
});

check('A17 does not mutate input plateHints', () => {
  const h = emptyHints([2.0]);
  applyFaceKeepOut(h, [{ atSec: 2.0, face: FACE_ON_TOP }]);
  assert.strictEqual(h.samples[0].bands.top.avoid, false);
});

// ── B. flag off → no detection call ─────────────────────────────────────────
check('B1 FACE_KEEPOUT_ENABLED respects TITLE_FACE_KEEPOUT=false', () => {
  const saved = process.env.TITLE_FACE_KEEPOUT;
  try {
    process.env.TITLE_FACE_KEEPOUT = 'false';
    assert.strictEqual(basePlateCrop.FACE_KEEPOUT_ENABLED(), false);
    process.env.TITLE_FACE_KEEPOUT = 'true';
    assert.strictEqual(basePlateCrop.FACE_KEEPOUT_ENABLED(), true);
    delete process.env.TITLE_FACE_KEEPOUT;
    assert.strictEqual(basePlateCrop.FACE_KEEPOUT_ENABLED(), true); // default on
  } finally {
    if (saved === undefined) delete process.env.TITLE_FACE_KEEPOUT;
    else process.env.TITLE_FACE_KEEPOUT = saved;
  }
});

const asyncChecks = [];

asyncChecks.push(async () => {
  const label = 'B2 ensureFaceDetectionForKeepOut flag-off → null, zero detect calls';
  const saved = process.env.TITLE_FACE_KEEPOUT;
  process.env.TITLE_FACE_KEEPOUT = 'false';
  try {
    let calls = 0;
    const orig = basePlateCrop._internal.detectClipBoxes;
    basePlateCrop._internal.detectClipBoxes = async () => {
      calls += 1;
      return { faceSamples: [], envelope: null, frames: 0, faceHits: 0 };
    };
    try {
      const result = await basePlateCrop.ensureFaceDetectionForKeepOut({
        ad: {
          _id: 'test',
          veoVideoUrl: 'https://res.cloudinary.com/x/video/upload/v1/clip.mp4',
          basePlate: null,
        },
        format: 'vertical',
      });
      assert.strictEqual(result, null, 'expected null when flag off');
      assert.strictEqual(calls, 0, `detectClipBoxes called ${calls} times`);
      pass++;
    } finally {
      basePlateCrop._internal.detectClipBoxes = orig;
    }
  } catch (err) {
    failures.push(`${label}: ${err.message}`);
  } finally {
    if (saved === undefined) delete process.env.TITLE_FACE_KEEPOUT;
    else process.env.TITLE_FACE_KEEPOUT = saved;
  }
});

asyncChecks.push(async () => {
  const label = 'B3 cache hit with facesComputed reuses without detectClipBoxes';
  const saved = process.env.TITLE_FACE_KEEPOUT;
  process.env.TITLE_FACE_KEEPOUT = 'true';
  try {
    let calls = 0;
    const orig = basePlateCrop._internal.detectClipBoxes;
    basePlateCrop._internal.detectClipBoxes = async () => {
      calls += 1;
      return { faceSamples: [], envelope: null, frames: 0, faceHits: 0 };
    };
    try {
      const envelope = { left: 0.3, top: 0.1, right: 0.7, bottom: 0.3 };
      const result = await basePlateCrop.ensureFaceDetectionForKeepOut({
        ad: {
          _id: 'test',
          veoVideoUrl: 'https://res.cloudinary.com/x/video/upload/v1/clip.mp4',
          basePlate: {
            version: 1,
            format: 'vertical',
            sourceUrl: 'https://res.cloudinary.com/x/video/upload/v1/clip.mp4',
            facesComputed: true,
            envelope,
            faceSamples: [{ atSec: 2, face: envelope }],
            sourceW: 1080,
            sourceH: 1920,
            videoUrl: null,
          },
        },
        format: 'vertical',
      });
      assert.ok(result, 'expected cache hit payload');
      assert.strictEqual(result.fromCache, true);
      assert.strictEqual(result.faceSamples.length, 1);
      assert.strictEqual(calls, 0, `detectClipBoxes called ${calls} times on cache hit`);
      pass++;
    } finally {
      basePlateCrop._internal.detectClipBoxes = orig;
    }
  } catch (err) {
    failures.push(`${label}: ${err.message}`);
  } finally {
    if (saved === undefined) delete process.env.TITLE_FACE_KEEPOUT;
    else process.env.TITLE_FACE_KEEPOUT = saved;
  }
});

// ── C. ink-vote tie-break (runs after ESM import of plateHints.js) ─────────
// decideInkOnLight / medianBandLuma are assigned in the async IIFE below.

check('W1 brandScriptExecutor wires ensureFaceDetectionForKeepOut into renderTitles', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/services/brandScriptExecutor.js'), 'utf8');
  const fn = src.split('async function renderWithRemotionAndSave')[1].split('\nasync function')[0];
  assert.ok(fn.includes('ensureFaceDetectionForKeepOut'), 'ensureFaceDetection not called');
  assert.ok(/faceKeepOut/.test(fn), 'faceKeepOut not passed to renderTitles');
});

check('W2 remotionRenderService applies applyFaceKeepOut after analyzePlate', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/services/remotionRenderService.js'), 'utf8');
  assert.ok(src.includes('applyFaceKeepOut'), 'applyFaceKeepOut not imported/used');
  assert.ok(src.includes('faceKeepOut'), 'faceKeepOut param missing');
});

check('W3 Canonical uses decideInkOnLight for the global ink vote', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/remotion/compositions/Canonical.jsx'), 'utf8');
  assert.ok(src.includes('decideInkOnLight'), 'decideInkOnLight not used');
  assert.ok(/tie -> globalLum/.test(src), 'tie-break log line missing');
});

check('W4 defaults.env ships TITLE_FACE_KEEPOUT=true', () => {
  const env = fs.readFileSync(path.join(ROOT, 'config/defaults.env'), 'utf8');
  assert.ok(/^TITLE_FACE_KEEPOUT=true$/m.test(env));
});

check('W5 detectClipBoxes returns faceSamples (source-text)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/services/basePlateCropService.js'), 'utf8');
  assert.ok(/faceSamples/.test(src));
  assert.ok(/timestampSec/.test(src));
});

asyncChecks.push(async () => {
  const label = 'C-setup import src/remotion/lib/plateHints.js';
  try {
    const mod = await import(pathToFileURL(path.join(ROOT, 'src/remotion/lib/plateHints.js')).href);
    const { decideInkOnLight, medianBandLuma } = mod;

    const c = (name, fn) => {
      try { fn(); pass++; }
      catch (err) { failures.push(`${name}: ${err.message}`); }
    };

    c('C1 non-tie light majority → on-light, no globalLum', () => {
      const d = decideInkOnLight(3, 1, {
        samples: [{ atSec: 1, bands: { top: { lum: 0.2 }, middle: { lum: 0.2 }, bottom: { lum: 0.2 } } }],
      });
      assert.strictEqual(d.onLight, true);
      assert.strictEqual(d.tied, false);
      assert.strictEqual(d.globalLum, null);
    });

    c('C2 non-tie dark majority → brand-default, unchanged', () => {
      const d = decideInkOnLight(1, 3, {
        samples: [{ atSec: 1, bands: { top: { lum: 0.9 }, middle: { lum: 0.9 }, bottom: { lum: 0.9 } } }],
      });
      assert.strictEqual(d.onLight, false);
      assert.strictEqual(d.tied, false);
    });

    c('C3 tie + light global (median > 0.55) → on-light', () => {
      const plateHints = {
        samples: [
          { atSec: 1, bands: { top: { lum: 0.71 }, middle: { lum: 0.71 }, bottom: { lum: 0.71 } } },
          { atSec: 2, bands: { top: { lum: 0.71 }, middle: { lum: 0.71 }, bottom: { lum: 0.71 } } },
        ],
      };
      const d = decideInkOnLight(3, 3, plateHints);
      assert.strictEqual(d.tied, true);
      assert.ok(Math.abs(d.globalLum - 0.71) < 1e-9, `globalLum=${d.globalLum}`);
      assert.strictEqual(d.onLight, true);
    });

    c('C4 tie + dark global (median ≤ 0.55) → brand-default', () => {
      const plateHints = {
        samples: [
          { atSec: 1, bands: { top: { lum: 0.40 }, middle: { lum: 0.45 }, bottom: { lum: 0.50 } } },
        ],
      };
      const d = decideInkOnLight(2, 2, plateHints);
      assert.strictEqual(d.tied, true);
      assert.ok(d.globalLum <= 0.55);
      assert.strictEqual(d.onLight, false);
    });

    c('C5 tie at exact 0.55 threshold → brand-default (not > 0.55)', () => {
      const plateHints = {
        samples: [{ atSec: 1, bands: { top: { lum: 0.55 }, middle: { lum: 0.55 }, bottom: { lum: 0.55 } } }],
      };
      const d = decideInkOnLight(1, 1, plateHints);
      assert.strictEqual(d.onLight, false);
    });

    c('C6 medianBandLuma matches decideInkOnLight globalLum on tie', () => {
      const plateHints = {
        samples: [
          { atSec: 1, bands: { top: { lum: 0.2 }, middle: { lum: 0.8 }, bottom: { lum: 0.9 } } },
        ],
      };
      assert.strictEqual(medianBandLuma(plateHints), 0.8);
      const d = decideInkOnLight(0, 0, plateHints);
      assert.strictEqual(d.globalLum, 0.8);
      assert.strictEqual(d.onLight, true);
    });
  } catch (err) {
    failures.push(`${label}: ${err.message}`);
  }
});

(async () => {
  for (const fn of asyncChecks) await fn();

  if (failures.length) {
    console.error(`❌ verifyFaceKeepOut: ${failures.length} FAILED, ${pass} passed\n`);
    for (const f of failures) console.error(`   • ${f}`);
    process.exit(1);
  }
  console.log(`✅ verifyFaceKeepOut: ${pass}/${pass} checks passed`);
})().catch((err) => {
  console.error(`❌ verifyFaceKeepOut: fatal ${err.message}`);
  process.exit(1);
});
