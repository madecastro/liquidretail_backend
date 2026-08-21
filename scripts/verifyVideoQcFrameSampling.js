#!/usr/bin/env node
'use strict';
/**
 * verifyVideoQcFrameSampling — offline guard for the video vision-QC
 * DENSE FRAME PRE-FILTER (services/videoQcFrameSelectionService.js) and its
 * wiring into services/brandScriptExecutor.js's runVideoVisionQcForAd.
 *
 * WHY THIS EXISTS: the pre-existing sampling (videoFrameService quartiles,
 * 25/50/75% of duration) sends exactly 3 frames to the paid vision model
 * and is structurally blind to a defect that appears and disappears inside
 * one quartile window. PROVEN 2026-08-20: a hallucinated storefront-UI
 * overlay was visible at t=0.1s/0.5s and completely gone by t=2.5s on a
 * ~10s clip — quartile sampling (2.5/5.0/7.5s) would see NOTHING. Section F
 * below reproduces that exact defect shape with REAL synthetically-
 * generated JPEGs (sharp-encoded in-memory, no external asset, no network)
 * and proves the new selector catches it while the old baseline alone does
 * not — a real behavioral pin, not a shape assertion.
 *
 * No DB, no network, no API key. Every "fetch" in this file is a mocked
 * `deps.fetchDenseFrames` — real image DECODE (sharp) still runs for real
 * in section C/F/G, only the network hop is stubbed, matching the existing
 * convention in this suite (services/adVisionQcService.js is exercised the
 * same way — real code, mocked transport).
 *
 * All checks run SEQUENTIALLY (not fired-and-gathered) because several
 * mutate process.env.VIDEO_QC_DENSE_SAMPLING for the duration of one check
 * (see withEnv) — running them concurrently would let one check's
 * temporary env flip leak into another's assertion window.
 *
 *   node scripts/verifyVideoQcFrameSampling.js
 *
 * REVERT-PROOF, stated precisely per revert MECHANISM (an earlier version
 * of this comment implied F5 alone covered all of these — an adversarial
 * review correctly called that an overclaim; each is a DIFFERENT check):
 *   - Flag flipped off (VIDEO_QC_DENSE_SAMPLING=false, real env or
 *     config/defaults.env): F5 — the SAME real-incident frames go
 *     uncaught, and the dense probe is never even attempted. H1 pins the
 *     shipped config/defaults.env value itself (checks above it delete
 *     the env var and would not notice that file regressing).
 *   - selectQcFrameTimestamps's dense planner swapped back to the old
 *     quartile-only plan: F0 (source-level) plus the stamps-equality
 *     assertions inside E1/E2/E6/E7/F2/F3 (behavioral) — confirmed by
 *     hand, same session, by literally making that swap and watching F0
 *     and F2/F3 fail.
 *   - services/brandScriptExecutor.js's wiring reverted to the bare
 *     `videoFrameService.buildFrameUrls(deliveredUrl, durationSec)` call:
 *     G1/G2 — confirmed by hand, same session, by making that revert and
 *     watching both fail.
 *   - services/videoQcFrameSelectionService.js deleted entirely: every
 *     check in this file fails with MODULE_NOT_FOUND — confirmed by hand,
 *     same session.
 * No single check proves all of these; the set of checks together does.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

delete process.env.VIDEO_QC_DENSE_SAMPLING;

const sel = require('../services/videoQcFrameSelectionService');
const videoFrameService = require('../services/videoFrameService');

let pass = 0;
const failures = [];
async function checkAsync(label, fn) {
  try { await fn(); pass++; }
  catch (err) { failures.push(`${label}: ${err.message}`); }
}
function check(label, fn) {
  try { fn(); pass++; }
  catch (err) { failures.push(`${label}: ${err.message}`); }
}

async function withEnv(name, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try { return await fn(); }
  finally {
    if (had) process.env[name] = prev; else delete process.env[name];
  }
}

function bufFor(marker) { return Buffer.from(String(marker)); }

const CLOUDINARY_URL = 'https://res.cloudinary.com/x/video/upload/v1/a.mp4';

console.log('\nverifyVideoQcFrameSampling — dense frame pre-filter for video vision QC\n');

(async () => {
  // ── A. planDenseTimestamps: shape + early-weighting proof (pure) ────
  check('A1 planDenseTimestamps(10) returns a dense, unique, ascending set', () => {
    const ts = videoFrameService.planDenseTimestamps(10);
    assert.ok(ts.length >= 10, `expected a dense set (>=10), got ${ts.length}`);
    const sorted = [...ts].sort((a, b) => a - b);
    assert.deepStrictEqual(ts, sorted, 'must be ascending');
    assert.strictEqual(new Set(ts).size, ts.length, 'must be unique');
  });

  check('A2 at least half of the dense set sits inside the first 2 seconds (early-weighted)', () => {
    const ts = videoFrameService.planDenseTimestamps(10);
    const early = ts.filter((t) => t <= 2);
    assert.ok(
      early.length * 2 >= ts.length,
      `expected >=50% of samples <=2s, got ${early.length}/${ts.length}`
    );
  });

  check('A3 the dense set still covers the tail of the clip (not early-only)', () => {
    const ts = videoFrameService.planDenseTimestamps(10);
    const max = Math.max(...ts);
    assert.ok(max >= 9, `expected a sample within ~1s of the end, max was ${max}`);
  });

  check('A4 the exact incident timestamps (0.1s, 0.5s) are inside the dense set for a 10s clip', () => {
    // Anchors the real 2026-08-20 defect (visible at t=0.1s/0.5s, gone by
    // t=2.5s) directly against the planner, independent of the scoring
    // math exercised in section F below.
    const ts = videoFrameService.planDenseTimestamps(10);
    assert.ok(ts.includes(0.1), '0.1s must be probed');
    assert.ok(ts.includes(0.5), '0.5s must be probed');
  });

  check('A5 degenerate durations do not throw and return a sane (possibly empty) list', () => {
    assert.deepStrictEqual(videoFrameService.planDenseTimestamps(0), []);
    assert.deepStrictEqual(videoFrameService.planDenseTimestamps(-5), []);
    assert.deepStrictEqual(videoFrameService.planDenseTimestamps(NaN), []);
    const tiny = videoFrameService.planDenseTimestamps(0.3);
    assert.ok(Array.isArray(tiny) && tiny.every((t) => t > 0 && t < 0.3));
  });

  check('A6 baselineTimestamps matches the PRE-EXISTING quartile plan exactly for a typical 8-10s ad', () => {
    assert.deepStrictEqual(sel.baselineTimestamps(10), [2.5, 5, 7.5]);
    assert.deepStrictEqual(sel.BASELINE_FRACTIONS, [0.25, 0.5, 0.75]);
  });

  check('A7 REGRESSION (found by adversarial review): baselineTimestamps must equal planTimestamps in EVERY duration bucket, not just 4-20s', () => {
    // A literal `[0.25,0.5,0.75].map(f => durationSec*f)` formula matches
    // planTimestamps ONLY inside the 4-20s quartile bucket. It silently
    // diverges for a tiny clip (<=4s -- ONE mid-frame, not three) and a
    // long one (>20s -- stride-based, capped at 5, not three quartiles).
    // durationSec=4 is not hypothetical: Omni's duration enum is
    // [4,6,8,10] (see CLAUDE.md), so a real ad can hit this bucket.
    // Without this, "kill switch off restores byte-identical old
    // behavior" would be FALSE for any ad outside 4-20s.
    for (const d of [1, 2, 3, 4, 5, 6, 8, 10, 20, 21, 25, 40]) {
      assert.deepStrictEqual(
        sel.baselineTimestamps(d),
        videoFrameService.planTimestamps(d),
        `baselineTimestamps(${d}) must equal planTimestamps(${d})`
      );
    }
  });

  await checkAsync('A8 REGRESSION, behavioral: with the kill switch OFF, a 4s ad gets the OLD single-frame plan, not three quartiles', async () => {
    await withEnv('VIDEO_QC_DENSE_SAMPLING', 'false', async () => {
      const result = await sel.selectQcFrameTimestamps(
        { deliveredUrl: CLOUDINARY_URL, durationSec: 4 },
        { fetchDenseFrames: async () => { throw new Error('must not be called'); } }
      );
      assert.deepStrictEqual(result.timestamps, [2], 'must match videoFrameService.planTimestamps(4) exactly, not a 3-fraction guess');
    });
  });

  // ── B. Additive URL/fetch helpers do not disturb the existing contract ─
  check('B1 buildFrameUrlsAtTimestamps: sorted, labelled, null-filtered for non-Cloudinary', () => {
    const frames = videoFrameService.buildFrameUrlsAtTimestamps(CLOUDINARY_URL, [5, 0.1, 2.5]);
    assert.deepStrictEqual(frames.map((f) => f.timestampSec), [0.1, 2.5, 5]);
    assert.ok(frames.every((f) => typeof f.url === 'string' && f.url.includes('so_')));

    const none = videoFrameService.buildFrameUrlsAtTimestamps('https://example.com/not-cloudinary.mp4', [1, 2]);
    assert.strictEqual(none.length, 0);
  });

  check('B2 buildFrameUrls (pre-existing) is UNCHANGED for a 10s clip — quartiles only, byte-for-byte', () => {
    // Redundant guard, scoped to this file, against regressing
    // scripts/verifyAdVisionQc.js O13 while this file's neighbors change.
    const frames = videoFrameService.buildFrameUrls(CLOUDINARY_URL, 10);
    assert.deepStrictEqual(frames.map((f) => f.timestampSec), [2.5, 5, 7.5]);
  });

  await checkAsync('B3 fetchFrameBuffersAtTimestamps resolves instantly with zero frames for a non-Cloudinary source (no network attempted)', async () => {
    const out = await videoFrameService.fetchFrameBuffersAtTimestamps('https://example.com/x.mp4', [1, 2, 3]);
    assert.deepStrictEqual(out, []);
  });

  await checkAsync('B4 fetchFrameBuffersAtTimestamps resolves instantly for an empty timestamp list', async () => {
    const out = await videoFrameService.fetchFrameBuffersAtTimestamps(CLOUDINARY_URL, []);
    assert.deepStrictEqual(out, []);
  });

  // ── C. computeFrameSignature — real sharp decode, single-frame checks ─
  async function makeSolidJpeg(rgb, { width = 16, height = 16 } = {}) {
    const sharp = require('sharp');
    const channels = 3;
    const buf = Buffer.alloc(width * height * channels);
    for (let i = 0; i < buf.length; i += 3) {
      buf[i] = rgb[0]; buf[i + 1] = rgb[1]; buf[i + 2] = rgb[2];
    }
    return sharp(buf, { raw: { width, height, channels } }).jpeg({ quality: 90 }).toBuffer();
  }

  await checkAsync('C1 computeFrameSignature returns a normalized-[0,1] grid of the right size', async () => {
    const jpeg = await makeSolidJpeg([128, 128, 128]);
    const sig = await sel.computeFrameSignature(jpeg);
    assert.strictEqual(sig.length, sel.SIGNATURE_SIZE * sel.SIGNATURE_SIZE);
    assert.ok(sig.every((v) => v >= 0 && v <= 1));
  });

  await checkAsync('C2 two visually identical frames produce near-identical signatures; black vs white produce a large one', async () => {
    const grayA = await makeSolidJpeg([128, 128, 128]);
    const grayB = await makeSolidJpeg([128, 128, 128]);
    const black = await makeSolidJpeg([0, 0, 0]);
    const white = await makeSolidJpeg([255, 255, 255]);
    const [sigA, sigB, sigBlack, sigWhite] = await Promise.all(
      [grayA, grayB, black, white].map((b) => sel.computeFrameSignature(b))
    );
    const diffAB = Math.abs(sigA[0] - sigB[0]);
    assert.ok(diffAB < 0.05, `identical solid frames should read ~equal, diff=${diffAB}`);
    const diffBW = Math.abs(sigBlack[0] - sigWhite[0]);
    assert.ok(diffBW > 0.8, `black vs white should read as very different, diff=${diffBW}`);
  });

  // ── D. scoreOutliers — pure array math, no I/O ─────────────────────
  check('D1 a uniform signature set flags nothing', () => {
    const sigs = Array.from({ length: 12 }, () => [0.5, 0.5, 0.5, 0.5]);
    const scored = sel.scoreOutliers(sigs);
    assert.ok(scored.every((s) => !s.outlier));
  });

  check('D2 two outliers among twelve are flagged; the rest are not', () => {
    const sigs = Array.from({ length: 12 }, (_, i) =>
      (i === 0 || i === 3) ? [1, 1, 1, 1] : [0, 0, 0, 0]
    );
    const scored = sel.scoreOutliers(sigs);
    const flaggedIdx = scored.map((s, i) => (s.outlier ? i : -1)).filter((i) => i >= 0);
    assert.deepStrictEqual(flaggedIdx.sort((a, b) => a - b), [0, 3]);
  });

  check('D3 fewer than MIN_DENSE_FRAMES_TO_SCORE signatures never flags and never throws', () => {
    const scored = sel.scoreOutliers([[1, 1], [0, 0]]);
    assert.ok(scored.every((s) => !s.outlier && s.score === 0));
  });

  check('D4 a perfectly uniform set (zero variance) cannot false-flag from float noise (minScore floor)', () => {
    const sigs = Array.from({ length: 8 }, () => [0.33, 0.33]);
    const scored = sel.scoreOutliers(sigs);
    assert.ok(scored.every((s) => !s.outlier));
  });

  check('D5 REGRESSION (Grok finding 1): WITHOUT a reference subset, an EVEN 6/6 split flags nothing — the exact blind spot this fix closes', () => {
    // The naive whole-set-median design breaks down here: median+MAD have
    // a ~50% breakdown point, and an even split makes the "steady state"
    // a blend of both halves, so nothing clears the threshold. This is
    // the failure mode a defect spanning planDenseTimestamps' entire
    // early cluster would hit under the OLD scoring. Documents the
    // fallback behavior scoreOutliers still has with no referenceIndices
    // (or too few) — see D6 for the fix that avoids this in production.
    const sigs = Array.from({ length: 12 }, (_, i) => (i < 6 ? [1, 1] : [0, 0]));
    const scored = sel.scoreOutliers(sigs);
    assert.ok(scored.every((s) => !s.outlier), 'an even split is mathematically invisible to a whole-set median — documented, not a surprise');
  });

  check('D6 THE FIX: with referenceIndices pointing at the clean half, the SAME even 6/6 split is fully caught', () => {
    const sigs = Array.from({ length: 12 }, (_, i) => (i < 6 ? [1, 1] : [0, 0]));
    const referenceIndices = [6, 7, 8, 9, 10, 11]; // the clean half only
    const scored = sel.scoreOutliers(sigs, { referenceIndices });
    const flaggedIdx = scored.map((s, i) => (s.outlier ? i : -1)).filter((i) => i >= 0);
    assert.deepStrictEqual(flaggedIdx, [0, 1, 2, 3, 4, 5], 'every defect frame must be flagged once the reference is uncontaminated');
  });

  check('D7 a reference subset shorter than MIN_REFERENCE_FRAMES falls back to whole-set scoring (degrades to D5, not a crash)', () => {
    const sigs = Array.from({ length: 12 }, (_, i) => (i < 6 ? [1, 1] : [0, 0]));
    const scored = sel.scoreOutliers(sigs, { referenceIndices: [6, 7] }); // only 2 — below MIN_REFERENCE_FRAMES
    assert.ok(scored.every((s) => !s.outlier), 'too-small a reference subset must fall back, not divide by near-zero spread');
  });

  // ── E. selectQcFrameTimestamps orchestration (mocked transport only) ─
  //
  // ADVERSARIAL-REVIEW FIX (2026-08-20, Grok): every mock in this section
  // used to IGNORE the `stamps` argument selectQcFrameTimestamps actually
  // passes to fetchDenseFrames — they built their response from a
  // pre-captured `denseSet` closure variable instead. That made the whole
  // section (and F2/F3 below) vacuous with respect to the ONE THING that
  // matters most: whether the real videoFrameService.planDenseTimestamps
  // output is what actually drives frame selection. Swapping
  // planDenseTimestamps(durationSec) out for the OLD quartile-only
  // planTimestamps(durationSec) inside selectQcFrameTimestamps — i.e.
  // reintroducing the exact blindness this PR fixes — would still have
  // passed every check below, because the mocks never looked at what was
  // actually requested.
  //
  // Fixed by making every mock build its response FROM the received
  // `stamps` argument (not from the closure), AND asserting that argument
  // equals the real planDenseTimestamps output wherever the check's point
  // is "does the real planner drive this".
  const denseSet = videoFrameService.planDenseTimestamps(10);

  await checkAsync('E1 no outliers -> exactly the baseline, flaggedCount 0 (and the REAL dense planner was consulted)', async () => {
    const result = await sel.selectQcFrameTimestamps(
      { deliveredUrl: CLOUDINARY_URL, durationSec: 10 },
      {
        fetchDenseFrames: async (url, stamps) => {
          assert.deepStrictEqual(stamps, denseSet, 'must probe the REAL planDenseTimestamps(10) output');
          return stamps.map((t) => ({ timestampSec: t, buffer: bufFor('clean') }));
        },
        computeFrameSignature: async () => [0.5, 0.5, 0.5, 0.5]
      }
    );
    assert.deepStrictEqual(result.timestamps, [2.5, 5, 7.5]);
    assert.strictEqual(result.flaggedCount, 0);
    assert.strictEqual(result.degraded, false);
  });

  await checkAsync('E2 two flagged outliers merge into the baseline, sorted (frames built from the REAL requested stamps)', async () => {
    const result = await sel.selectQcFrameTimestamps(
      { deliveredUrl: CLOUDINARY_URL, durationSec: 10 },
      {
        fetchDenseFrames: async (url, stamps) => {
          assert.deepStrictEqual(stamps, denseSet, 'must probe the REAL planDenseTimestamps(10) output');
          return stamps.map((t) => ({ timestampSec: t, buffer: bufFor(t) }));
        },
        computeFrameSignature: async (buf) => {
          const t = Number(buf.toString());
          return (t === 0.1 || t === 0.5) ? [1, 1, 1, 1] : [0, 0, 0, 0];
        }
      }
    );
    assert.deepStrictEqual(result.timestamps, [0.1, 0.5, 2.5, 5, 7.5]);
    assert.strictEqual(result.flaggedCount, 2);
    assert.ok(result.timestamps.length <= sel.MAX_TOTAL_FRAMES);
  });

  await checkAsync('E3 kill switch OFF: baseline only, AND the network probe is never invoked (real cost avoidance)', async () => {
    await withEnv('VIDEO_QC_DENSE_SAMPLING', 'false', async () => {
      let fetchCalled = false;
      const result = await sel.selectQcFrameTimestamps(
        { deliveredUrl: CLOUDINARY_URL, durationSec: 10 },
        { fetchDenseFrames: async () => { fetchCalled = true; return []; } }
      );
      assert.deepStrictEqual(result.timestamps, [2.5, 5, 7.5]);
      assert.strictEqual(fetchCalled, false, 'flag-off must skip the dense probe entirely, not just discard it');
    });
  });

  await checkAsync('E4 a transport failure degrades to baseline and never throws', async () => {
    const result = await sel.selectQcFrameTimestamps(
      { deliveredUrl: CLOUDINARY_URL, durationSec: 10 },
      { fetchDenseFrames: async () => { throw new Error('network down'); } }
    );
    assert.deepStrictEqual(result.timestamps, [2.5, 5, 7.5]);
    assert.strictEqual(result.degraded, true);
  });

  await checkAsync('E5 too few dense frames downloaded degrades to baseline', async () => {
    const result = await sel.selectQcFrameTimestamps(
      { deliveredUrl: CLOUDINARY_URL, durationSec: 10 },
      { fetchDenseFrames: async () => [{ timestampSec: 0.1, buffer: bufFor('x') }] }
    );
    assert.deepStrictEqual(result.timestamps, [2.5, 5, 7.5]);
    assert.strictEqual(result.degraded, true);
  });

  await checkAsync('E6 more outliers than the cap: only the top MAX_EXTRA_FRAMES by score survive', async () => {
    // 8 majority "clean" frames at [0,0]; 4 minority frames, each a clear
    // outlier but with DISTINCT scores, at REAL dense-set timestamps far
    // from every baseline quartile so none gets redundancy-filtered.
    const scoreByTimestamp = { 1.6: 1.0, 3.1: 0.9, 5.8: 0.8, 8.5: 0.7 };
    const result = await sel.selectQcFrameTimestamps(
      { deliveredUrl: CLOUDINARY_URL, durationSec: 10 },
      {
        fetchDenseFrames: async (url, stamps) => {
          assert.deepStrictEqual(stamps, denseSet, 'must probe the REAL planDenseTimestamps(10) output');
          return stamps.map((t) => ({ timestampSec: t, buffer: bufFor(t) }));
        },
        computeFrameSignature: async (buf) => {
          const t = Number(buf.toString());
          const v = scoreByTimestamp[t] || 0;
          return [v, v, v, v];
        }
      }
    );
    assert.strictEqual(result.flaggedCount, sel.MAX_EXTRA_FRAMES);
    assert.ok(result.timestamps.length <= sel.MAX_TOTAL_FRAMES);
    // The two HIGHEST-scoring outliers (1.6, 3.1) must be the ones kept,
    // not an arbitrary pair among the four that cleared the threshold.
    assert.ok(result.timestamps.includes(1.6) && result.timestamps.includes(3.1));
    assert.ok(!result.timestamps.includes(5.8) && !result.timestamps.includes(8.5));
  });

  await checkAsync('E7 REGRESSION (Grok finding 2): a real outlier close in TIME to a baseline quartile is KEPT, not dropped as a false "redundancy"', async () => {
    // The first version of this file dropped any flagged outlier within
    // 0.4s of a baseline quartile, reasoning it was "probably the same
    // moment" as a frame already covered. An adversarial review showed
    // that reasoning is backwards for exactly the frames this module
    // flags: a defect visible ONLY at a REAL dense timestamp (7.2s) and
    // gone by the very next baseline quartile (7.5s, 0.3s later) would
    // have been silently dropped, handing the vision model the clean
    // 7.5s frame and calling it covered — reintroducing the "quartile
    // sampling missed it" failure this whole feature exists to fix, just
    // at a 0.4s radius instead of a multi-second one. Proximity-based
    // redundancy filtering is REMOVED (see file header); this pins that
    // removal behaviorally.
    const result = await sel.selectQcFrameTimestamps(
      { deliveredUrl: CLOUDINARY_URL, durationSec: 10 },
      {
        fetchDenseFrames: async (url, stamps) => {
          assert.deepStrictEqual(stamps, denseSet, 'must probe the REAL planDenseTimestamps(10) output');
          return stamps.map((t) => ({ timestampSec: t, buffer: bufFor(t) }));
        },
        computeFrameSignature: async (buf) => (Number(buf.toString()) === 7.2 ? [1, 1] : [0, 0])
      }
    );
    assert.strictEqual(result.degraded, false);
    assert.ok(result.timestamps.includes(7.2),
      'a real outlier 0.3s from the 7.5s baseline must survive — it is NOT redundant just because it is nearby in time');
    assert.strictEqual(result.flaggedCount, 1);
  });

  await checkAsync('E8 REGRESSION (Grok finding 1, THE confirmed bug): a defect spanning the ENTIRE early cluster (even 6/6 split) is still caught end-to-end', async () => {
    // Direct behavioral analogue of D5/D6 through the real orchestration
    // function: planDenseTimestamps(10) puts exactly 6 of its 12 samples
    // in the early (<=2s) cluster. A defect visible across ALL of them
    // (not a 1-2 frame flash, but ~2 continuous seconds of it — the same
    // "gone by the 2.5s quartile" shape as the real incident, just
    // lasting the whole early window) is an even 6/6 split, which is
    // mathematically invisible to a whole-set median (see D5). Proves
    // the fix: scoring every frame against a LATE-cluster-only reference
    // (selectQcFrameTimestamps's real wiring, not a stub) still flags it.
    const EARLY = videoFrameService.DEFAULT_EARLY_WINDOW_SEC;
    const result = await sel.selectQcFrameTimestamps(
      { deliveredUrl: CLOUDINARY_URL, durationSec: 10 },
      {
        fetchDenseFrames: async (url, stamps) => {
          assert.deepStrictEqual(stamps, denseSet, 'must probe the REAL planDenseTimestamps(10) output');
          return stamps.map((t) => ({ timestampSec: t, buffer: bufFor(t) }));
        },
        computeFrameSignature: async (buf) => {
          const t = Number(buf.toString());
          return t <= EARLY ? [1, 1] : [0, 0];
        }
      }
    );
    const extras = result.timestamps.filter((t) => !sel.baselineTimestamps(10).includes(t));
    assert.ok(extras.length > 0, 'the entire-early-cluster defect must produce at least one flagged frame, not zero');
    assert.ok(extras.every((t) => t <= EARLY), 'every flagged extra must come from the defective early cluster, not the clean late one');
    assert.strictEqual(result.flaggedCount, Math.min(sel.MAX_EXTRA_FRAMES, 6));
  });

  // ── F. THE REAL BEHAVIORAL PROOF: real JPEGs, the actual 2026-08-20 defect ─
  async function makeIncidentFrame({ defect = false, width = 64, height = 64 } = {}) {
    const sharp = require('sharp');
    const channels = 3;
    const buf = Buffer.alloc(width * height * channels);
    // Background: mid-gray. "Product": a blue block in the center third —
    // a stand-in for the product-on-plain-background shot every one of
    // these ads actually is.
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * channels;
        const inProduct = x > width / 3 && x < (2 * width) / 3 && y > height / 3 && y < (2 * height) / 3;
        if (inProduct) { buf[idx] = 40; buf[idx + 1] = 80; buf[idx + 2] = 200; }
        else { buf[idx] = 120; buf[idx + 1] = 120; buf[idx + 2] = 120; }
      }
    }
    if (defect) {
      // The real incident: a hallucinated storefront nav bar across the
      // top + a small dark "bag icon" block in the corner — chrome that
      // has no business being IN the generated plate at all.
      for (let y = 0; y < Math.floor(height * 0.22); y++) {
        for (let x = 0; x < width; x++) {
          const idx = (y * width + x) * channels;
          buf[idx] = 245; buf[idx + 1] = 245; buf[idx + 2] = 245;
        }
      }
      for (let y = 2; y < 10; y++) {
        for (let x = width - 12; x < width - 2; x++) {
          const idx = (y * width + x) * channels;
          buf[idx] = 20; buf[idx + 1] = 20; buf[idx + 2] = 20;
        }
      }
    }
    return sharp(buf, { raw: { width, height, channels } }).jpeg({ quality: 85 }).toBuffer();
  }

  const DEFECT_TIMESTAMPS = new Set([0.1, 0.5]);
  const incidentDense = videoFrameService.planDenseTimestamps(10);
  const incidentFrames = await Promise.all(incidentDense.map(async (t) => ({
    timestampSec: t,
    buffer: await makeIncidentFrame({ defect: DEFECT_TIMESTAMPS.has(t) })
  })));

  check('F0 SOURCE-LEVEL PIN: selectQcFrameTimestamps calls the REAL planDenseTimestamps, not the old quartile-only planTimestamps, to build its probe list', () => {
    // Static companion to the runtime stamps-assertions in E/F below —
    // added after adversarial review showed those mocks could previously
    // be fooled if this were swapped for the old planner (which is
    // exactly the pre-existing blindness this PR fixes).
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'videoQcFrameSelectionService.js'), 'utf8');
    const m = src.match(/async function selectQcFrameTimestamps\([\s\S]*?\n\}\n/);
    assert.ok(m, 'selectQcFrameTimestamps not found');
    const body = m[0];
    assert.ok(/\.planDenseTimestamps\(/.test(body), 'must call planDenseTimestamps to build the dense probe list');
    assert.ok(!/videoFrameService\.planTimestamps\(/.test(body),
      'must NOT call the bare quartile-only planTimestamps directly — that is exactly the pre-existing blindness');
  });

  await checkAsync('F1 sanity: the synthetic defect frames really do decode differently from clean ones', async () => {
    const sigs = await Promise.all(incidentFrames.map((f) => sel.computeFrameSignature(f.buffer)));
    const scored = sel.scoreOutliers(sigs);
    const flaggedTs = incidentFrames.filter((_, i) => scored[i].outlier).map((f) => f.timestampSec);
    assert.deepStrictEqual(flaggedTs.sort((a, b) => a - b), [0.1, 0.5]);
  });

  // ADVERSARIAL-REVIEW FIX (Grok): the mock used to be
  // `fetchDenseFrames: async () => incidentFrames`, ignoring the `stamps`
  // argument entirely. That made this check vacuous with respect to
  // planDenseTimestamps: if selectQcFrameTimestamps were changed to probe
  // the OLD quartile-only planTimestamps instead (durationSec=10 ->
  // [2.5,5,7.5], which never overlaps 0.1/0.5), this mock would still hand
  // back the same defect frames regardless, and F2/F3 would still
  // (wrongly) pass. Fixed by asserting `stamps` equals the REAL
  // planDenseTimestamps(10) output before returning anything, and by
  // building the response FROM `stamps` (lookup) rather than from the
  // closure — so a swapped planner fails loudly here, not silently.
  const incidentFrameByTimestamp = new Map(incidentFrames.map((f) => [f.timestampSec, f]));
  await checkAsync('F2/F3 selectQcFrameTimestamps (real sharp decode, mocked network only) CATCHES the real incident at its real timestamps — AND really asked the real dense planner for them', async () => {
    const result = await sel.selectQcFrameTimestamps(
      { deliveredUrl: CLOUDINARY_URL, durationSec: 10 },
      {
        fetchDenseFrames: async (url, stamps) => {
          assert.deepStrictEqual(stamps, incidentDense, 'must request the REAL planDenseTimestamps(10) output, not something else');
          return stamps.map((t) => incidentFrameByTimestamp.get(t)).filter(Boolean);
        }
      }
    );
    assert.ok(result.timestamps.includes(0.1), 'must catch the t=0.1s frame of the real incident');
    assert.ok(result.timestamps.includes(0.5), 'must catch the t=0.5s frame of the real incident');
  });

  await checkAsync('F2b if the dense planner were swapped for the OLD quartile-only plan, the SAME real incident frames would go uncaught', async () => {
    // Directly demonstrates why F2/F3 asserting the real stamps matters:
    // quartile timestamps for a 10s clip (2.5/5/7.5) never intersect the
    // incident's dense set, so a lookup against them finds nothing —
    // exactly the pre-existing blindness this PR fixes.
    const quartileOnly = videoFrameService.planTimestamps(10);
    const wouldFetch = quartileOnly.map((t) => incidentFrameByTimestamp.get(t)).filter(Boolean);
    assert.strictEqual(wouldFetch.length, 0, 'quartile timestamps must not overlap the incident dense set at all');
  });

  await checkAsync('F4 the PRE-EXISTING quartile-only baseline would have caught NEITHER defect frame (the documented blindness)', () => {
    const baseline = sel.baselineTimestamps(10);
    assert.deepStrictEqual(baseline, [2.5, 5, 7.5]);
    assert.ok(!baseline.includes(0.1) && !baseline.includes(0.5));
  });

  await checkAsync('F5 the kill-switch-OFF branch specifically: flipping VIDEO_QC_DENSE_SAMPLING off on the SAME incident reproduces the old blindness', async () => {
    // SCOPE, stated precisely after an adversarial review flagged the
    // original wording as overclaiming: F5 pins ONLY the flag's own
    // contract — "off means baseline, and the dense probe is never
    // attempted at all" — which is the early-return branch at the top of
    // selectQcFrameTimestamps, BEFORE any fetch/decode/scoring runs. It
    // does NOT exercise scoring and it does NOT prove "this whole file
    // fails if the feature is reverted any other way". Those are covered
    // separately: G1/G2 fail if the brandScriptExecutor.js wiring is
    // reverted; a bare require() throws MODULE_NOT_FOUND if
    // videoQcFrameSelectionService.js is deleted; F2/F3 (with the F2b
    // control above) fail if planDenseTimestamps is swapped out; H1 pins
    // the shipped config/defaults.env value. Each was independently
    // confirmed by hand this session (see session.d/ and the PR
    // description) — no single check here proves all of them at once.
    await withEnv('VIDEO_QC_DENSE_SAMPLING', 'false', async () => {
      let fetchCalled = false;
      const result = await sel.selectQcFrameTimestamps(
        { deliveredUrl: CLOUDINARY_URL, durationSec: 10 },
        { fetchDenseFrames: async () => { fetchCalled = true; return incidentFrames; } }
      );
      assert.deepStrictEqual(result.timestamps, [2.5, 5, 7.5]);
      assert.ok(!result.timestamps.includes(0.1) && !result.timestamps.includes(0.5),
        'with the flag off, the exact same real incident frames must go uncaught');
      assert.strictEqual(fetchCalled, false);
    });
  });

  // ── H. config/defaults.env agrees with the code default (shipped prod value) ─
  // ADVERSARIAL-REVIEW FIX (Grok): every check above deletes
  // process.env.VIDEO_QC_DENSE_SAMPLING up front and relies on the CODE
  // default, so none of them would notice if the COMMITTED
  // config/defaults.env value were flipped to false — that file, not the
  // code default, is what actually ships to production (dotenv-loaded at
  // boot, see CLAUDE.md §4a). Same pattern as verifyPostPilotBatch.js C14.
  check('H1 config/defaults.env sets VIDEO_QC_DENSE_SAMPLING=true (the real shipped prod default)', () => {
    const envSrc = fs.readFileSync(path.join(__dirname, '..', 'config', 'defaults.env'), 'utf8');
    assert.ok(/^VIDEO_QC_DENSE_SAMPLING=true\s*$/m.test(envSrc),
      'config/defaults.env must set VIDEO_QC_DENSE_SAMPLING=true — this is what actually ships, not the code default');
    assert.ok(!/^VIDEO_QC_DENSE_SAMPLING=false\s*$/m.test(envSrc),
      'must not ALSO carry a false line (e.g. from a bad merge) that would win or confuse precedence');
  });

  // ── G. Integration wiring into brandScriptExecutor.js ────────────────
  check('G1 runVideoVisionQcForAd requires and calls videoQcFrameSelectionService, and no longer calls the bare unselected quartile buildFrameUrls', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'brandScriptExecutor.js'), 'utf8');
    const m = src.match(/async function runVideoVisionQcForAd\([\s\S]*?\n\}\n/);
    assert.ok(m, 'runVideoVisionQcForAd not found');
    const body = m[0];
    assert.ok(/require\(['"]\.\/videoQcFrameSelectionService['"]\)/.test(body),
      'must require videoQcFrameSelectionService');
    assert.ok(/\.selectQcFrameTimestamps\(/.test(body),
      'must call selectQcFrameTimestamps');
    assert.ok(!/buildFrameUrls\(deliveredUrl,\s*durationSec\)/.test(body),
      'the old bare quartile-only call must be gone, not left dead beside the new one');
    assert.ok(/buildFrameUrlsAtTimestamps\(/.test(body),
      'must build the final frame URLs from the selector output');
  });

  await checkAsync('G2 runVideoVisionQcForAd threads the selector output into the vision call for real (mocked deps, real control flow)', async () => {
    const brandScriptExecutor = require('../services/brandScriptExecutor');
    const frameSelectionService = require('../services/videoQcFrameSelectionService');
    const adVisionQc = require('../services/adVisionQcService');

    const originalSelect = frameSelectionService.selectQcFrameTimestamps;
    const originalIsEnabled = adVisionQc.isEnabled;
    const originalRunVideoQc = adVisionQc.runVideoPostRenderQc;

    const MARKER_TIMESTAMPS = [0.3, 0.9, 6.6]; // distinctive — not the real baseline
    let capturedFrames = null;

    frameSelectionService.selectQcFrameTimestamps = async () => ({
      timestamps: MARKER_TIMESTAMPS, denseCount: 12, flaggedCount: 2, degraded: false
    });
    adVisionQc.isEnabled = () => true;
    adVisionQc.runVideoPostRenderQc = async (args) => {
      capturedFrames = args.frames;
      return {
        ok: true, skipped: false, passed: true,
        visionQc: { passed: true, skipped: false, attempts: [], finalAttempt: 1 }
      };
    };

    try {
      const ad = {
        _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
        veoReferenceImages: ['https://cdn.example/seed.jpg'],
        videoDurationSec: 10,
        brandId: null,
        productId: null,
        campaignId: null,
        campaignRunIds: []
      };
      await brandScriptExecutor.runVideoVisionQcForAd({
        ad, deliveredUrl: CLOUDINARY_URL, brandName: 'Test Brand'
      });
    } finally {
      frameSelectionService.selectQcFrameTimestamps = originalSelect;
      adVisionQc.isEnabled = originalIsEnabled;
      adVisionQc.runVideoPostRenderQc = originalRunVideoQc;
    }

    assert.ok(Array.isArray(capturedFrames), 'runVideoPostRenderQc must have been called with a frames array');
    assert.deepStrictEqual(
      capturedFrames.map((f) => f.timestampSec),
      videoFrameService.buildFrameUrlsAtTimestamps(CLOUDINARY_URL, MARKER_TIMESTAMPS).map((f) => f.timestampSec),
      'the vision call must receive frames built from the selector output, not the old fixed quartiles'
    );
  });

  // ── report ───────────────────────────────────────────────────────────
  if (failures.length) {
    console.error(`❌ verifyVideoQcFrameSampling: ${failures.length} FAILED, ${pass} passed\n`);
    for (const f of failures) console.error(`   • ${f}`);
    process.exit(1);
  }
  console.log(`✅ verifyVideoQcFrameSampling: ${pass}/${pass} checks passed`);
})().catch((err) => {
  console.error('verifyVideoQcFrameSampling crashed:', err);
  process.exit(1);
});
