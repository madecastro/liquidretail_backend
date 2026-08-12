#!/usr/bin/env node
'use strict';
//
// verifyBasePlateCropOrder — do not pay vision to learn "no crop needed".
//
// THE MEASURED WASTE (2026-08-12). On one real run, base_plate_crop ran 48
// times, 153.6s of model time, $0.169, inside a 926s window that was 83% idle.
// resolveBasePlateVideoUrl called detectClipBoxes UNCONDITIONALLY and only
// afterwards asked decideBasePlateCrop whether a crop was needed. A 9:16
// target on a 9:16 master paid ~3 serial vision calls to be told "full-frame".
//
// THE FIX is a REORDERING, not a redesign. cropCouldBeNeeded is the cheap
// predicate decideBasePlateCrop already applied (target window vs master
// dims, plus the other no-vision skips). The orchestrator now evaluates it
// AFTER measuring dims and BEFORE detectClipBoxes. The crop-needed path is
// unchanged: detect, then decideBasePlateCrop with the real boxes.
//
// Keep-out is preserved. ensureFaceDetectionForKeepOut still needs faces
// even when no crop is needed. The crop path no longer writes face extras
// on a cheap skip, so keep-out pays at most ONCE — never twice.
//
// These checks CALL the predicate and SPY the vision function. A source-text
// assertion cannot tell a call that happens from one that merely still
// contains the right words.
//
// Revert-prove (this file mutates, asserts red, restores):
//   force cropCouldBeNeeded to always return true → C1-equivalent spy goes
//   red (detectClipBoxes is called on a 9:16→9:16 ad). That is also the
//   proof the spy is wired through _internal: a broken stub would stay at 0.
//
// Offline only: no DB, no network, no API key.
//   node scripts/verifyBasePlateCropOrder.js

const assert = require('node:assert');

const svc = require('../services/basePlateCropService');
const Ad = require('../models/Ad');
const {
  cropCouldBeNeeded, decideBasePlateCrop, resolveBasePlateVideoUrl,
  ensureFaceDetectionForKeepOut,
} = svc;

let checks = 0;
const ok = (label, fn) => {
  try { fn(); checks += 1; }
  catch (err) {
    console.error(`  ❌ ${label}\n     ${err.message}`);
    process.exitCode = 1;
  }
};
const okAsync = async (label, fn) => {
  try { await fn(); checks += 1; }
  catch (err) {
    console.error(`  ❌ ${label}\n     ${err.message}`);
    process.exitCode = 1;
  }
};

console.log('verifyBasePlateCropOrder\n');

const SRC = 'https://res.cloudinary.com/reach-social-prod/video/upload/v1/liquidretail/atlas_renders/clip.mp4';
const SUBJ = { left: 0.05, top: 0.02, right: 0.95, bottom: 0.98 };
const HEAD = { left: 0.36, top: 0.08, right: 0.64, bottom: 0.26 };
const FAKE_DET = {
  subject: SUBJ,
  head: HEAD,
  frames: 3,
  faceHits: 3,
  envelope: HEAD,
  faceSamples: [{ atSec: 0, face: HEAD }],
};

const base = (o) => ({
  format: 'feed', platformFormat: 'meta_feed_4_5', sourceUrl: SRC,
  sourceW: 1080, sourceH: 1920, ...o,
});

function makeAd({ platformFormat, basePlate } = {}) {
  return {
    _id: 'ad-crop-order',
    veoVideoUrl: SRC,
    platformFormat,
    videoDurationSec: 8,
    basePlate: basePlate || null,
    brandId: 'b', campaignId: 'c', mediaId: 'm',
  };
}

// ── A. the pure predicate against real aspect combinations ──────────────────

ok('A1 9:16 master → 9:16 target (Stories/Reels) = no crop', () => {
  assert.strictEqual(cropCouldBeNeeded(base({
    format: 'vertical', platformFormat: 'meta_reels_9_16',
  })), false);
  assert.strictEqual(cropCouldBeNeeded(base({
    format: 'vertical', platformFormat: 'meta_stories_9_16',
  })), false);
});

ok('A2 9:16 master → 1:1 target (feed square / pmax 1:1) = crop', () => {
  assert.strictEqual(cropCouldBeNeeded(base({
    format: 'square', platformFormat: 'meta_feed_1_1',
  })), true);
  assert.strictEqual(cropCouldBeNeeded(base({
    format: 'square', platformFormat: 'pmax_video_1_1',
  })), true);
});

ok('A3 9:16 master → 4:5 target (feed) = crop', () => {
  assert.strictEqual(cropCouldBeNeeded(base({
    format: 'feed', platformFormat: 'meta_feed_4_5',
  })), true);
});

ok('A4 16:9 master → 16:9 target (PMax landscape) = no crop', () => {
  assert.strictEqual(cropCouldBeNeeded(base({
    format: 'landscape', platformFormat: 'pmax_video_16_9',
    sourceW: 1920, sourceH: 1080,
  })), false);
});

ok('A5 16:9 master → 9:16 target = crop', () => {
  assert.strictEqual(cropCouldBeNeeded(base({
    format: 'vertical', platformFormat: 'meta_reels_9_16',
    sourceW: 1920, sourceH: 1080,
  })), true);
});

ok('A6 16:9 master → 1:1 target = crop', () => {
  assert.strictEqual(cropCouldBeNeeded(base({
    format: 'square', platformFormat: 'meta_feed_1_1',
    sourceW: 1920, sourceH: 1080,
  })), true);
});

ok('A7 9:16 master → 16:9 target = crop', () => {
  assert.strictEqual(cropCouldBeNeeded(base({
    format: 'landscape', platformFormat: 'pmax_video_16_9',
  })), true);
});

ok('A8 already-cropped URL is a cheap skip (no vision)', () => {
  assert.strictEqual(cropCouldBeNeeded(base({
    sourceUrl: SRC.replace('/video/upload/', '/video/upload/c_fill,ar_4:5/'),
  })), false);
});

ok('A9 bad / over-cap dims are a cheap skip (no vision)', () => {
  assert.strictEqual(cropCouldBeNeeded(base({ sourceW: 0, sourceH: 1920 })), false);
  assert.strictEqual(cropCouldBeNeeded(base({ sourceW: 2268, sourceH: 4032 })), false);
});

// ── B. crop-needed path still produces the SAME decision as before ──────────
// decideBasePlateCrop is untouched. These fixtures are the live ones from
// verifyBasePlateCrop (G3b / F3 / N1 / N2): if the reorder silently changed
// what a needed crop DOES, these go red.

ok('B1 9:16→1:1 still crops a 1080x1080 window (G3b identity)', () => {
  const d = decideBasePlateCrop(base({
    format: 'square', platformFormat: 'pmax_video_1_1',
    sourceW: 1080, sourceH: 1920, subject: SUBJ, head: HEAD,
  }));
  assert.strictEqual(d.action, 'crop', `got ${d.action}: ${d.reason}`);
  assert.ok(d.rect && d.rect.cw === 1080 && d.rect.ch === 1080,
    `expected 1080x1080, got ${JSON.stringify(d.rect)}`);
});

ok('B2 9:16→4:5 still crops with a face anchor (F3 identity)', () => {
  const d = decideBasePlateCrop(base({ subject: SUBJ, head: HEAD }));
  assert.strictEqual(d.action, 'crop');
  assert.notStrictEqual(d.rect.anchorY, 'center');
});

ok('B3 9:16→9:16 is still full-frame (N1 identity)', () => {
  const d = decideBasePlateCrop(base({
    format: 'vertical', platformFormat: 'meta_reels_9_16', subject: SUBJ, head: HEAD,
  }));
  assert.deepStrictEqual({ action: d.action, reason: d.reason },
    { action: 'skip', reason: 'full-frame' });
});

ok('B4 16:9→16:9 is still full-frame (N2 identity)', () => {
  const d = decideBasePlateCrop(base({
    format: 'landscape', platformFormat: 'pmax_video_16_9',
    sourceW: 1920, sourceH: 1080, subject: SUBJ, head: HEAD,
  }));
  assert.deepStrictEqual({ action: d.action, reason: d.reason },
    { action: 'skip', reason: 'full-frame' });
});

ok('B5 predicate agrees with decideBasePlateCrop on every A-case', () => {
  // cropCouldBeNeeded is decideBasePlateCrop(head=null).reason === no-face-quorum.
  // A cheap skip stays a cheap skip even with a verified dummy face; a
  // crop-needed plate with a verified face is still a crop.
  const cases = [
    base({ format: 'vertical', platformFormat: 'meta_reels_9_16' }),
    base({ format: 'square', platformFormat: 'meta_feed_1_1' }),
    base({ format: 'feed', platformFormat: 'meta_feed_4_5' }),
    base({ format: 'landscape', platformFormat: 'pmax_video_16_9', sourceW: 1920, sourceH: 1080 }),
    base({ format: 'vertical', platformFormat: 'meta_reels_9_16', sourceW: 1920, sourceH: 1080 }),
    base({ format: 'landscape', platformFormat: 'pmax_video_16_9' }),
  ];
  for (const c of cases) {
    const needed = cropCouldBeNeeded(c);
    const withFace = decideBasePlateCrop({ ...c, subject: SUBJ, head: HEAD });
    const without = decideBasePlateCrop({ ...c, subject: null, head: null });
    if (needed) {
      assert.strictEqual(without.reason, 'no-face-quorum', JSON.stringify(c));
      assert.ok(withFace.action === 'crop' || withFace.reason === 'face-rejected-by-plausibility'
        || withFace.reason === 'no-rect',
        `crop-needed plate must still reach the face half, got ${withFace.action}:${withFace.reason}`);
    } else {
      assert.notStrictEqual(without.reason, 'no-face-quorum');
      assert.strictEqual(withFace.action, 'skip');
      assert.strictEqual(withFace.reason, without.reason,
        'dummy face must not change a cheap skip — that would mean the face half ran');
    }
  }
});

// ── C. spy: detectClipBoxes is SKIPPED on no-crop, CALLED on crop ───────────

const origUpdateOne = Ad.updateOne;
Ad.updateOne = async () => ({ acknowledged: true });

async function withResolveStubs({ sourceW, sourceH }, fn) {
  const internals = svc._internal;
  const origDetect = internals.detectClipBoxes;
  const origMeasure = internals.measureDeliveryDims;
  const origProbe = internals.probeUrlLive;
  let detectCalls = 0;
  internals.measureDeliveryDims = async () => ({ sourceW, sourceH });
  internals.probeUrlLive = async () => true;
  internals.detectClipBoxes = async () => {
    detectCalls += 1;
    return FAKE_DET;
  };
  try {
    return await fn({ getDetectCalls: () => detectCalls });
  } finally {
    internals.detectClipBoxes = origDetect;
    internals.measureDeliveryDims = origMeasure;
    internals.probeUrlLive = origProbe;
  }
}

async function main() {
await okAsync('C1 [THE BUG] 9:16→9:16 does not call detectClipBoxes', async () => {
  await withResolveStubs({ sourceW: 1080, sourceH: 1920 }, async ({ getDetectCalls }) => {
    const result = await resolveBasePlateVideoUrl({
      ad: makeAd({ platformFormat: 'meta_reels_9_16' }),
      format: 'vertical',
    });
    assert.strictEqual(getDetectCalls(), 0,
      `vision ran ${getDetectCalls()} times on a full-frame plate`);
    assert.strictEqual(result.cropped, false);
    assert.strictEqual(result.reason, 'full-frame');
    assert.strictEqual(result.videoUrl, SRC);
  });
});

await okAsync('C2 16:9→16:9 does not call detectClipBoxes', async () => {
  await withResolveStubs({ sourceW: 1920, sourceH: 1080 }, async ({ getDetectCalls }) => {
    const result = await resolveBasePlateVideoUrl({
      ad: makeAd({ platformFormat: 'pmax_video_16_9' }),
      format: 'landscape',
    });
    assert.strictEqual(getDetectCalls(), 0,
      `vision ran ${getDetectCalls()} times on a 16:9 full-frame plate`);
    assert.strictEqual(result.reason, 'full-frame');
  });
});

await okAsync('C3 9:16→1:1 DOES call detectClipBoxes (crop path still pays)', async () => {
  await withResolveStubs({ sourceW: 1080, sourceH: 1920 }, async ({ getDetectCalls }) => {
    const result = await resolveBasePlateVideoUrl({
      ad: makeAd({ platformFormat: 'meta_feed_1_1' }),
      format: 'square',
    });
    assert.ok(getDetectCalls() > 0,
      'crop-needed path never reached detectClipBoxes');
    assert.strictEqual(result.cropped, true, `expected crop, got ${result.reason}`);
  });
});

await okAsync('C4 9:16→4:5 DOES call detectClipBoxes', async () => {
  await withResolveStubs({ sourceW: 1080, sourceH: 1920 }, async ({ getDetectCalls }) => {
    const result = await resolveBasePlateVideoUrl({
      ad: makeAd({ platformFormat: 'meta_feed_4_5' }),
      format: 'feed',
    });
    assert.ok(getDetectCalls() > 0);
    assert.strictEqual(result.cropped, true, `expected crop, got ${result.reason}`);
  });
});

await okAsync('C5 measured call-count: full-frame 0, crop-needed 1 (per resolve)', async () => {
  // One resolve = one detectClipBoxes invoke (the 3 serial frames live inside
  // that function). Before: 1 on both paths. After: 0 / 1.
  const counts = { fullFrame: null, crop: null };
  await withResolveStubs({ sourceW: 1080, sourceH: 1920 }, async ({ getDetectCalls }) => {
    await resolveBasePlateVideoUrl({
      ad: makeAd({ platformFormat: 'meta_stories_9_16' }),
      format: 'vertical',
    });
    counts.fullFrame = getDetectCalls();
  });
  await withResolveStubs({ sourceW: 1080, sourceH: 1920 }, async ({ getDetectCalls }) => {
    await resolveBasePlateVideoUrl({
      ad: makeAd({ platformFormat: 'meta_feed_1_1' }),
      format: 'square',
    });
    counts.crop = getDetectCalls();
  });
  assert.deepStrictEqual(counts, { fullFrame: 0, crop: 1 },
    `before/after signature drifted: ${JSON.stringify(counts)}`);
});

// ── D. keep-out is not skipped, and is not paid twice ───────────────────────

await okAsync('D1 full-frame skip writes no facesComputed (keep-out still owes a call)', async () => {
  await withResolveStubs({ sourceW: 1080, sourceH: 1920 }, async () => {
    const ad = makeAd({ platformFormat: 'meta_reels_9_16' });
    await resolveBasePlateVideoUrl({ ad, format: 'vertical' });
    assert.ok(ad.basePlate, 'persistSkip must stamp in-memory basePlate');
    assert.notStrictEqual(ad.basePlate.facesComputed, true,
      'full-frame skip must NOT pretend faces were computed — that would skip keep-out');
    assert.strictEqual(ad.basePlate.reason, 'full-frame');
  });
});

await okAsync('D2 keep-out on a full-frame skip still calls detectClipBoxes once', async () => {
  const saved = process.env.TITLE_FACE_KEEPOUT;
  process.env.TITLE_FACE_KEEPOUT = 'true';
  try {
    await withResolveStubs({ sourceW: 1080, sourceH: 1920 }, async ({ getDetectCalls }) => {
      const ad = makeAd({ platformFormat: 'meta_reels_9_16' });
      await resolveBasePlateVideoUrl({ ad, format: 'vertical' });
      assert.strictEqual(getDetectCalls(), 0, 'crop path paid — D2 is testing the wrong thing');
      const keep = await ensureFaceDetectionForKeepOut({ ad, format: 'vertical' });
      assert.ok(keep, 'keep-out must still run on a full-frame plate');
      assert.strictEqual(keep.fromCache, false);
      assert.strictEqual(getDetectCalls(), 1,
        `keep-out should pay exactly once, paid ${getDetectCalls()}`);
    });
  } finally {
    if (saved === undefined) delete process.env.TITLE_FACE_KEEPOUT;
    else process.env.TITLE_FACE_KEEPOUT = saved;
  }
});

await okAsync('D3 crop-needed path stamps facesComputed; keep-out does not pay again', async () => {
  const saved = process.env.TITLE_FACE_KEEPOUT;
  process.env.TITLE_FACE_KEEPOUT = 'true';
  try {
    await withResolveStubs({ sourceW: 1080, sourceH: 1920 }, async ({ getDetectCalls }) => {
      const ad = makeAd({ platformFormat: 'meta_feed_1_1' });
      const result = await resolveBasePlateVideoUrl({ ad, format: 'square' });
      assert.strictEqual(result.cropped, true);
      assert.strictEqual(getDetectCalls(), 1);
      assert.strictEqual(ad.basePlate.facesComputed, true);
      const keep = await ensureFaceDetectionForKeepOut({ ad, format: 'square' });
      assert.strictEqual(keep.fromCache, true);
      assert.strictEqual(getDetectCalls(), 1,
        `keep-out re-paid vision on a crop path (${getDetectCalls()} total)`);
    });
  } finally {
    if (saved === undefined) delete process.env.TITLE_FACE_KEEPOUT;
    else process.env.TITLE_FACE_KEEPOUT = saved;
  }
});

// ── E. revert-prove: remove the short-circuit, spy goes red, restore ────────

await okAsync('E1 [REVERT-PROVE] forcing cropCouldBeNeeded=true makes C1 go red', async () => {
  const orig = svc._internal.cropCouldBeNeeded;
  svc._internal.cropCouldBeNeeded = () => true;
  try {
    await withResolveStubs({ sourceW: 1080, sourceH: 1920 }, async ({ getDetectCalls }) => {
      await resolveBasePlateVideoUrl({
        ad: makeAd({ platformFormat: 'meta_reels_9_16' }),
        format: 'vertical',
      });
      assert.ok(getDetectCalls() > 0,
        'spy stayed at 0 with the short-circuit disabled — it is not wired through _internal, ' +
        'so C1 would be a false pass');
    });
  } finally {
    svc._internal.cropCouldBeNeeded = orig;
  }
});

await okAsync('E3 [FAIL-OPEN] a lying predicate cannot skip a needed crop', async () => {
  // If cropCouldBeNeeded is stubbed false on a 9:16→1:1 plate, decide with
  // head=null returns no-face-quorum. Without the guard that would persist
  // as a cheap skip and drop a real crop. The guard must fall through.
  const orig = svc._internal.cropCouldBeNeeded;
  svc._internal.cropCouldBeNeeded = () => false;
  try {
    await withResolveStubs({ sourceW: 1080, sourceH: 1920 }, async ({ getDetectCalls }) => {
      const result = await resolveBasePlateVideoUrl({
        ad: makeAd({ platformFormat: 'meta_feed_1_1' }),
        format: 'square',
      });
      assert.ok(getDetectCalls() > 0,
        'a lying predicate skipped vision on a crop-needed plate');
      assert.strictEqual(result.cropped, true, `got ${result.reason}`);
    });
  } finally {
    svc._internal.cropCouldBeNeeded = orig;
  }
});

await okAsync('E2 live short-circuit still holds after E1 restore', async () => {
  await withResolveStubs({ sourceW: 1080, sourceH: 1920 }, async ({ getDetectCalls }) => {
    await resolveBasePlateVideoUrl({
      ad: makeAd({ platformFormat: 'meta_reels_9_16' }),
      format: 'vertical',
    });
    assert.strictEqual(getDetectCalls(), 0, 'E1 did not restore the predicate');
  });
});

Ad.updateOne = origUpdateOne;

if (process.exitCode) {
  console.log(`\n❌ verifyBasePlateCropOrder: failures above (${checks} passed)`);
} else {
  console.log(`\n✅ verifyBasePlateCropOrder: ${checks}/${checks} checks passed`);
}
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
