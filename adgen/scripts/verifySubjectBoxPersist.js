#!/usr/bin/env node
'use strict';
/**
 * verifySubjectBoxPersist — Step 0 of titling-placement: persist the per-frame
 * subject box that detectClipBoxes already computes, through Ad.basePlate and
 * onto the existing faceKeepOut object. No placement behaviour changes.
 *
 * Pins:
 *   1. detectClipBoxes faceSamples carry the FULL subject box (LTRB), not
 *      vertical extent only.
 *   2. detectionExtras / keep-out persist / cache round-trip keep that box.
 *   3. TITLE_FACE_KEEPOUT=false is identity (null, zero detect calls).
 *   4. applyFaceKeepOut output is unchanged when samples gain a `subject` key.
 *   5. malformed / missing subject → null and never throws.
 *   6. Q2: 9:16→9:16 does NOT run detectClipBoxes on the crop path; keep-out
 *      (flag default on) is the existing paid call. No new spend.
 *
 * DETECT_SYSTEM_PROMPT is intentionally NOT extended with logo/text keys:
 * that prompt is load-bearing for crop + keep-out; extra JSON keys risk
 * splitting "subject" (which already includes products/text) and burning
 * the 400-token budget. Left for a change with its own before/after check.
 *
 * No DB, no network, no API key. Safe in CI. Bare-worktree Module._load stubs
 * match verifyFaceKeepOut / verifyBasePlateCrop.
 *
 *   node scripts/verifySubjectBoxPersist.js
 */

process.env.ADGEN_ROLE = process.env.ADGEN_ROLE || 'api';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://offline-harness/unused';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');

const persistWrites = [];

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

seed('src/models/Ad.js', {
  updateOne: async (filter, update) => {
    persistWrites.push({ filter, update });
    return {};
  },
});
seed('src/services/atlasLlmService.js', {
  chatCompletion: async () => { throw new Error('atlasLlmService.chatCompletion must not run in this harness'); },
});
seed('src/services/adStage.js', { noteRenderIssue() {}, adStage() {} });

const {
  ensureFaceDetectionForKeepOut,
  cropCouldBeNeeded,
  decideBasePlateCrop,
  resolveBasePlateVideoUrl,
  FACE_KEEPOUT_ENABLED,
  DETECT_SYSTEM_PROMPT,
  subjectBoxFromSample,
} = require('../src/services/basePlateCropService');
const basePlateCrop = require('../src/services/basePlateCropService');
const { applyFaceKeepOut } = require('../src/services/plateIntelService');

let pass = 0;
const failures = [];
function check(label, fn) {
  try { fn(); pass++; }
  catch (err) { failures.push(`${label}: ${err.message}`); }
}

const SRC = 'https://res.cloudinary.com/x/video/upload/v1/clip.mp4';
const SUBJ_A = { left: 0.20, top: 0.10, right: 0.80, bottom: 0.92 };
const SUBJ_B = { left: 0.18, top: 0.12, right: 0.78, bottom: 0.90 };
const FACE_A = { left: 0.36, top: 0.08, right: 0.64, bottom: 0.26 };

const INITIAL_FRAMES = [
  { timestampSec: 2.0, url: `${SRC.replace('/upload/', '/upload/so_2.0,w_640,c_limit,f_jpg/')}` },
  { timestampSec: 4.0, url: `${SRC.replace('/upload/', '/upload/so_4.0,w_640,c_limit,f_jpg/')}` },
  { timestampSec: 6.0, url: `${SRC.replace('/upload/', '/upload/so_6.0,w_640,c_limit,f_jpg/')}` },
];

function emptyHints(atSecs = [2.0, 4.0, 6.0]) {
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

function assertFullBox(box, expected, label) {
  assert.ok(box, `${label}: expected a box, got ${box}`);
  assert.strictEqual(typeof box.left, 'number', `${label}: left missing`);
  assert.strictEqual(typeof box.top, 'number', `${label}: top missing`);
  assert.strictEqual(typeof box.right, 'number', `${label}: right missing`);
  assert.strictEqual(typeof box.bottom, 'number', `${label}: bottom missing`);
  assert.strictEqual(box.left, expected.left, `${label}: left`);
  assert.strictEqual(box.top, expected.top, `${label}: top`);
  assert.strictEqual(box.right, expected.right, `${label}: right`);
  assert.strictEqual(box.bottom, expected.bottom, `${label}: bottom`);
}

async function withDetectStubs({ frames, extraFrames, detectFn }, fn) {
  const orig = {
    buildFrameUrls: basePlateCrop._internal.buildFrameUrls,
    buildAdditionalFrameUrls: basePlateCrop._internal.buildAdditionalFrameUrls,
    detectFrameBoxes: basePlateCrop._internal.detectFrameBoxes,
  };
  const calls = { detect: 0 };
  basePlateCrop._internal.buildFrameUrls = () => frames;
  basePlateCrop._internal.buildAdditionalFrameUrls = () => extraFrames || [];
  basePlateCrop._internal.detectFrameBoxes = async (url) => {
    calls.detect += 1;
    return detectFn(url, calls.detect);
  };
  try {
    const det = await basePlateCrop._internal.detectClipBoxes(SRC, 8);
    await fn(det, calls);
  } finally {
    Object.assign(basePlateCrop._internal, orig);
  }
}

console.log('\nverifySubjectBoxPersist\n');

// ── Q2: when does detectClipBoxes fire? ─────────────────────────────────────
check('Q2a 9:16→9:16 cropCouldBeNeeded is false (full-frame, zero crop vision)', () => {
  const needed = cropCouldBeNeeded({
    format: 'vertical',
    platformFormat: 'meta_reels_9_16',
    sourceUrl: SRC,
    sourceW: 1080,
    sourceH: 1920,
  });
  assert.strictEqual(needed, false);
  const d = decideBasePlateCrop({
    format: 'vertical',
    platformFormat: 'meta_reels_9_16',
    sourceUrl: SRC,
    sourceW: 1080,
    sourceH: 1920,
    subject: null,
    head: null,
  });
  assert.strictEqual(d.action, 'skip');
  assert.strictEqual(d.reason, 'full-frame');
});

check('Q2b TITLE_FACE_KEEPOUT defaults ON — keep-out is the 9:16 paid path', () => {
  const saved = process.env.TITLE_FACE_KEEPOUT;
  try {
    delete process.env.TITLE_FACE_KEEPOUT;
    assert.strictEqual(FACE_KEEPOUT_ENABLED(), true);
  } finally {
    if (saved === undefined) delete process.env.TITLE_FACE_KEEPOUT;
    else process.env.TITLE_FACE_KEEPOUT = saved;
  }
  const env = fs.readFileSync(path.join(ROOT, 'config/defaults.env'), 'utf8');
  assert.ok(/^TITLE_FACE_KEEPOUT=true$/m.test(env));
});

check('Q2c CURRENT_VERSION stays 1 (must not invalidate cached crops / re-bill)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/services/basePlateCropService.js'), 'utf8');
  assert.ok(/const CURRENT_VERSION = 1;/.test(src));
});

check('Q2d DETECT_SYSTEM_PROMPT still subject+face only (logo/text not added)', () => {
  const jsonLine = DETECT_SYSTEM_PROMPT.split('\n')[1];
  assert.ok(jsonLine.startsWith('{"subject":'), 'existing keys must stay FIRST');
  assert.ok(jsonLine.includes('"face":'), 'face key must remain');
  assert.ok(!/"logo"/.test(DETECT_SYSTEM_PROMPT), 'do not add logo to the crop prompt');
  assert.ok(!/"text":/.test(DETECT_SYSTEM_PROMPT), 'do not add text to the crop prompt');
});

check('W1 brandScriptExecutor still spreads faceKeepOut (subject rides, no parallel path)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/services/brandScriptExecutor.js'), 'utf8');
  const fn = src.split('async function renderWithRemotionAndSave')[1].split('\nasync function')[0];
  assert.ok(fn.includes('ensureFaceDetectionForKeepOut'));
  assert.ok(/\.\.\.faceKeepOut/.test(fn), 'faceKeepOut must be spread into renderTitles');
  assert.ok(!/subjectKeepOut/.test(fn), 'no parallel keep-out object');
});

check('W2 persist is still a single $set of basePlate (no second write)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/services/basePlateCropService.js'), 'utf8');
  const sets = src.match(/\$set:\s*\{\s*basePlate:/g) || [];
  // persistSkip, persistFaceExtrasOnly, crop success, keep-out fresh — each
  // already one $set. Adding subject must not add a new updateOne.
  assert.strictEqual(sets.length, 4, `expected 4 basePlate $set sites, got ${sets.length}`);
  assert.ok(!/\$set:\s*\{\s*['"]basePlate\.faceSamples/.test(src), 'no dotted-path second write');
});

// ── pure sanitizer ──────────────────────────────────────────────────────────
check('S1 subjectBoxFromSample returns the full LTRB box', () => {
  const box = subjectBoxFromSample({ atSec: 2, face: FACE_A, subject: SUBJ_A });
  assertFullBox(box, SUBJ_A, 'S1');
});

check('S2 missing subject → null, never throws', () => {
  assert.strictEqual(subjectBoxFromSample(undefined), null);
  assert.strictEqual(subjectBoxFromSample(null), null);
  assert.strictEqual(subjectBoxFromSample({}), null);
  assert.strictEqual(subjectBoxFromSample({ atSec: 1, face: FACE_A }), null);
  assert.strictEqual(subjectBoxFromSample({ subject: null }), null);
});

check('S3 malformed subject → null (inverted, non-finite, non-object, array)', () => {
  assert.strictEqual(subjectBoxFromSample({ subject: { left: 0.9, top: 0.1, right: 0.2, bottom: 0.8 } }), null);
  assert.strictEqual(subjectBoxFromSample({ subject: { left: 0, top: 0, right: 1, bottom: NaN } }), null);
  assert.strictEqual(subjectBoxFromSample({ subject: 'nope' }), null);
  assert.strictEqual(subjectBoxFromSample({ subject: [0, 0, 1, 1] }), null);
  assert.strictEqual(subjectBoxFromSample({ subject: { left: 0, top: 0 } }), null);
});

check('S4 attachSubjectBoxes sanitizes in place without dropping face', () => {
  const out = basePlateCrop._internal.attachSubjectBoxes([
    { atSec: 2, face: FACE_A, subject: SUBJ_A },
    { atSec: 4, face: FACE_A, subject: { left: 1, top: 0, right: 0, bottom: 1 } },
    { atSec: 6, face: FACE_A },
  ]);
  assert.strictEqual(out.length, 3);
  assertFullBox(out[0].subject, SUBJ_A, 'S4.0');
  assert.deepStrictEqual(out[0].face, FACE_A);
  assert.strictEqual(out[1].subject, null);
  assert.deepStrictEqual(out[1].face, FACE_A);
  assert.strictEqual(out[2].subject, null);
  assert.deepStrictEqual(out[2].face, FACE_A);
});

check('S5 attachSubjectBoxes never throws on garbage input', () => {
  const out = basePlateCrop._internal.attachSubjectBoxes([null, 7, 'x', { subject: { toString() { throw new Error('boom'); } } }]);
  assert.strictEqual(out.length, 4);
  for (const s of out) assert.strictEqual(s.subject, null);
});

check('S6 detectionExtras copies sanitized subject through the persist payload', () => {
  const extras = basePlateCrop._internal.detectionExtras({
    frames: 2,
    faceHits: 1,
    envelope: FACE_A,
    faceSamples: [
      { atSec: 2, face: FACE_A, subject: SUBJ_A },
      { atSec: 4, face: null, subject: { left: 'x', top: 0, right: 1, bottom: 1 } },
    ],
  }, { sourceW: 1080, sourceH: 1920 });
  assert.strictEqual(extras.facesComputed, true);
  assertFullBox(extras.faceSamples[0].subject, SUBJ_A, 'S6.0');
  assert.strictEqual(extras.faceSamples[1].subject, null);
  assert.deepStrictEqual(extras.faceSamples[0].face, FACE_A);
});

check('I1 applyFaceKeepOut is identity when samples gain a subject key', () => {
  const FACE_ON_TOP = { left: 0.2, top: 0.10, right: 0.8, bottom: 0.30 };
  const facesOnly = [{ atSec: 2.0, face: FACE_ON_TOP }];
  const withSubject = [{ atSec: 2.0, face: FACE_ON_TOP, subject: SUBJ_A }];
  const a = applyFaceKeepOut(emptyHints(), facesOnly);
  const b = applyFaceKeepOut(emptyHints(), withSubject);
  assert.deepStrictEqual(b, a);
});

const asyncChecks = [];

asyncChecks.push(async () => {
  const label = 'D1 detectClipBoxes keeps full per-frame subject (not vertical-only, not union-only)';
  try {
    await withDetectStubs({
      frames: INITIAL_FRAMES,
      extraFrames: [],
      detectFn: (url) => {
        if (url.includes('so_2.0')) return { subject: SUBJ_A, face: FACE_A };
        if (url.includes('so_4.0')) return { subject: SUBJ_B, face: FACE_A };
        return { subject: SUBJ_A, face: null };
      },
    }, async (det) => {
      assert.strictEqual(det.faceSamples.length, 3);
      assertFullBox(det.faceSamples[0].subject, SUBJ_A, 'D1.0');
      assertFullBox(det.faceSamples[1].subject, SUBJ_B, 'D1.1');
      assertFullBox(det.faceSamples[2].subject, SUBJ_A, 'D1.2');
      // Distinct per-frame boxes must survive (union would collapse them).
      assert.notStrictEqual(det.faceSamples[0].subject.left, det.faceSamples[1].subject.left);
      assert.notStrictEqual(det.faceSamples[0].subject.right, det.faceSamples[1].subject.right);
      // Face path unchanged.
      assert.deepStrictEqual(det.faceSamples[0].face, FACE_A);
      assert.strictEqual(det.faceSamples[2].face, null);
    });
    pass++;
  } catch (err) {
    failures.push(`${label}: ${err.message}`);
  }
});

asyncChecks.push(async () => {
  const label = 'D2 detectClipBoxes nulls a missing/malformed per-frame subject without throwing';
  try {
    await withDetectStubs({
      frames: INITIAL_FRAMES.slice(0, 2),
      extraFrames: [],
      detectFn: (url) => {
        if (url.includes('so_2.0')) return { subject: SUBJ_A, face: FACE_A };
        return null; // frame failed entirely
      },
    }, async (det) => {
      assert.strictEqual(det.faceSamples[0].subject.left, SUBJ_A.left);
      assert.strictEqual(det.faceSamples[1].subject, null);
      assert.strictEqual(det.faceSamples[1].face, null);
    });
    pass++;
  } catch (err) {
    failures.push(`${label}: ${err.message}`);
  }
});

asyncChecks.push(async () => {
  const label = 'Q2e resolveBasePlateVideoUrl 9:16 full-frame does NOT call detectClipBoxes';
  try {
    persistWrites.length = 0;
    let detectCalls = 0;
    const origDetect = basePlateCrop._internal.detectClipBoxes;
    const origDims = basePlateCrop._internal.measureDeliveryDims;
    basePlateCrop._internal.detectClipBoxes = async () => {
      detectCalls += 1;
      return { subject: SUBJ_A, head: FACE_A, frames: 3, faceHits: 2, envelope: FACE_A, faceSamples: [] };
    };
    basePlateCrop._internal.measureDeliveryDims = async () => ({ sourceW: 1080, sourceH: 1920 });
    try {
      const result = await resolveBasePlateVideoUrl({
        ad: {
          _id: 'reels-ad',
          veoVideoUrl: SRC,
          platformFormat: 'meta_reels_9_16',
          basePlate: null,
        },
        format: 'vertical',
      });
      assert.strictEqual(result.cropped, false);
      assert.strictEqual(result.reason, 'full-frame');
      assert.strictEqual(detectCalls, 0, `crop path paid detectClipBoxes ${detectCalls} times on 9:16`);
    } finally {
      basePlateCrop._internal.detectClipBoxes = origDetect;
      basePlateCrop._internal.measureDeliveryDims = origDims;
    }
    pass++;
  } catch (err) {
    failures.push(`${label}: ${err.message}`);
  }
});

asyncChecks.push(async () => {
  const label = 'B1 TITLE_FACE_KEEPOUT=false → null, zero detect calls (flag-off identity)';
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
      const result = await ensureFaceDetectionForKeepOut({
        ad: { _id: 'test', veoVideoUrl: SRC, basePlate: null },
        format: 'vertical',
      });
      assert.strictEqual(result, null);
      assert.strictEqual(calls, 0);
    } finally {
      basePlateCrop._internal.detectClipBoxes = orig;
    }
    pass++;
  } catch (err) {
    failures.push(`${label}: ${err.message}`);
  } finally {
    if (saved === undefined) delete process.env.TITLE_FACE_KEEPOUT;
    else process.env.TITLE_FACE_KEEPOUT = saved;
  }
});

asyncChecks.push(async () => {
  const label = 'P1 keep-out persist $set includes per-frame subject (one write)';
  const saved = process.env.TITLE_FACE_KEEPOUT;
  process.env.TITLE_FACE_KEEPOUT = 'true';
  persistWrites.length = 0;
  try {
    const origDetect = basePlateCrop._internal.detectClipBoxes;
    const origDims = basePlateCrop._internal.measureDeliveryDims;
    basePlateCrop._internal.measureDeliveryDims = async () => ({ sourceW: 1080, sourceH: 1920 });
    basePlateCrop._internal.detectClipBoxes = async () => ({
      subject: SUBJ_A,
      head: FACE_A,
      frames: 2,
      faceHits: 1,
      envelope: FACE_A,
      faceSamples: [
        { atSec: 2, face: FACE_A, subject: SUBJ_A },
        { atSec: 6, face: null, subject: SUBJ_B },
      ],
    });
    try {
      const ad = { _id: 'persist-ad', veoVideoUrl: SRC, basePlate: null };
      const result = await ensureFaceDetectionForKeepOut({ ad, format: 'vertical' });
      assert.ok(result, 'expected keep-out payload');
      assert.strictEqual(result.fromCache, false);
      assertFullBox(result.faceSamples[0].subject, SUBJ_A, 'P1 result.0');
      assertFullBox(result.faceSamples[1].subject, SUBJ_B, 'P1 result.1');
      assert.strictEqual(persistWrites.length, 1, `expected one $set, got ${persistWrites.length}`);
      const set = persistWrites[0].update.$set;
      assert.ok(set.basePlate, 'missing basePlate in $set');
      assert.strictEqual(set.basePlate.facesComputed, true);
      assertFullBox(set.basePlate.faceSamples[0].subject, SUBJ_A, 'P1 persist.0');
      assertFullBox(set.basePlate.faceSamples[1].subject, SUBJ_B, 'P1 persist.1');
      assert.deepStrictEqual(set.basePlate.faceSamples[0].face, FACE_A);
    } finally {
      basePlateCrop._internal.detectClipBoxes = origDetect;
      basePlateCrop._internal.measureDeliveryDims = origDims;
    }
    pass++;
  } catch (err) {
    failures.push(`${label}: ${err.message}`);
  } finally {
    if (saved === undefined) delete process.env.TITLE_FACE_KEEPOUT;
    else process.env.TITLE_FACE_KEEPOUT = saved;
  }
});

asyncChecks.push(async () => {
  const label = 'P2 cache hit round-trips subject without a second detectClipBoxes';
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
      const result = await ensureFaceDetectionForKeepOut({
        ad: {
          _id: 'cached-ad',
          veoVideoUrl: SRC,
          basePlate: {
            version: 1,
            format: 'vertical',
            sourceUrl: SRC,
            facesComputed: true,
            envelope: FACE_A,
            faceSamples: [
              { atSec: 2, face: FACE_A, subject: SUBJ_A },
              { atSec: 6, face: null, subject: SUBJ_B },
            ],
            sourceW: 1080,
            sourceH: 1920,
            videoUrl: null,
          },
        },
        format: 'vertical',
      });
      assert.ok(result);
      assert.strictEqual(result.fromCache, true);
      assert.strictEqual(calls, 0, `cache hit paid detectClipBoxes ${calls} times`);
      assertFullBox(result.faceSamples[0].subject, SUBJ_A, 'P2.0');
      assertFullBox(result.faceSamples[1].subject, SUBJ_B, 'P2.1');
      assert.deepStrictEqual(result.faceSamples[0].face, FACE_A);
    } finally {
      basePlateCrop._internal.detectClipBoxes = orig;
    }
    pass++;
  } catch (err) {
    failures.push(`${label}: ${err.message}`);
  } finally {
    if (saved === undefined) delete process.env.TITLE_FACE_KEEPOUT;
    else process.env.TITLE_FACE_KEEPOUT = saved;
  }
});

asyncChecks.push(async () => {
  const label = 'P3 cached malformed subject becomes null and does not throw into keep-out';
  const saved = process.env.TITLE_FACE_KEEPOUT;
  process.env.TITLE_FACE_KEEPOUT = 'true';
  try {
    const result = await ensureFaceDetectionForKeepOut({
      ad: {
        _id: 'bad-cache',
        veoVideoUrl: SRC,
        basePlate: {
          version: 1,
          format: 'vertical',
          sourceUrl: SRC,
          facesComputed: true,
          envelope: FACE_A,
          faceSamples: [
            { atSec: 2, face: FACE_A, subject: { left: 0.9, top: 0.1, right: 0.1, bottom: 0.2 } },
            { atSec: 4, face: FACE_A, subject: 'garbage' },
            { atSec: 6, face: FACE_A },
          ],
          sourceW: 1080,
          sourceH: 1920,
        },
      },
      format: 'vertical',
    });
    assert.ok(result);
    assert.strictEqual(result.fromCache, true);
    assert.strictEqual(result.faceSamples[0].subject, null);
    assert.strictEqual(result.faceSamples[1].subject, null);
    assert.strictEqual(result.faceSamples[2].subject, null);
    assert.deepStrictEqual(result.faceSamples[0].face, FACE_A);
    pass++;
  } catch (err) {
    failures.push(`${label}: ${err.message}`);
  } finally {
    if (saved === undefined) delete process.env.TITLE_FACE_KEEPOUT;
    else process.env.TITLE_FACE_KEEPOUT = saved;
  }
});

asyncChecks.push(async () => {
  const label = 'P4 pre-subject cache (face only) still returns faces; subject is null';
  const saved = process.env.TITLE_FACE_KEEPOUT;
  process.env.TITLE_FACE_KEEPOUT = 'true';
  try {
    const result = await ensureFaceDetectionForKeepOut({
      ad: {
        _id: 'old-cache',
        veoVideoUrl: SRC,
        basePlate: {
          version: 1,
          format: 'vertical',
          sourceUrl: SRC,
          facesComputed: true,
          envelope: FACE_A,
          faceSamples: [{ atSec: 2, face: FACE_A }],
          sourceW: 1080,
          sourceH: 1920,
        },
      },
      format: 'vertical',
    });
    assert.ok(result);
    assert.strictEqual(result.fromCache, true);
    assert.deepStrictEqual(result.faceSamples[0].face, FACE_A);
    assert.strictEqual(result.faceSamples[0].subject, null);
    pass++;
  } catch (err) {
    failures.push(`${label}: ${err.message}`);
  } finally {
    if (saved === undefined) delete process.env.TITLE_FACE_KEEPOUT;
    else process.env.TITLE_FACE_KEEPOUT = saved;
  }
});

(async () => {
  for (const fn of asyncChecks) await fn();

  if (failures.length) {
    console.error(`❌ verifySubjectBoxPersist: ${failures.length} FAILED, ${pass} passed\n`);
    for (const f of failures) console.error(`   • ${f}`);
    process.exit(1);
  }
  console.log(`✅ verifySubjectBoxPersist: ${pass}/${pass} checks passed`);
})().catch((err) => {
  console.error(`❌ verifySubjectBoxPersist: fatal ${err.message}`);
  process.exit(1);
});
