// Dense, early-weighted frame sampling + a cheap LOCAL perceptual
// pre-filter for VIDEO post-render vision QC (services/adVisionQcService.js
// "VIDEO CONTRACT" — runVideoPostRenderQc / judgeVideoRender).
//
// WHY THIS EXISTS
// ----------------
// runVideoPostRenderQc's vision call is BILLABLE (~$0.02/check today, one
// LLM call over the seed photo + N frames). Frame EXTRACTION is not — it is
// a Cloudinary `so_<sec>` edge transform plus ordinary bandwidth
// (services/videoFrameService.js). The pre-existing sampling
// (videoFrameService.planTimestamps: 25/50/75% of duration) sends exactly
// 3 frames to the vision model and is structurally blind to a defect that
// appears and disappears INSIDE one quartile window.
//
// PROVEN 2026-08-20: a hallucinated storefront-UI overlay (nav bar,
// shopping-bag icon, garbled header/footer text) was baked into a video
// plate. Visible at t=0.1s AND t=0.5s. Completely gone by t=2.5s. On a
// ~10s clip, quartile sampling hits 2.5s / 5.0s / 7.5s — it would see
// NOTHING. (Separate, unchanged finding: the 2026-08-19 Vuori colourway
// defect WAS visible at all three quartiles, because it was a PERSISTENT
// hallucination baked in for the whole clip — that is still the reason 3
// evidence points is enough for a persistent defect. It says nothing about
// a transient one, which is the gap this module closes.)
//
// THE COST TENSION, AND HOW THIS RESOLVES IT
// -------------------------------------------
// Just sampling more frames and sending ALL of them to the vision model
// scales the billable cost with N directly — a 4x frame count is roughly a
// 4x vision bill for every ad, including the ~95%+ that have no transient
// defect at all. Instead:
//   1. Pull a DENSE, EARLY-WEIGHTED set of TINY frames (width ~160px —
//      videoFrameService.planDenseTimestamps), concentrated in the first
//      ~2s where this class of artifact empirically clusters, but spanning
//      the whole clip. This step is cheap: no vision call, small images,
//      Cloudinary edge transform.
//   2. Score each dense frame against the CLIP'S OWN steady state — a
//      per-pixel median across all the dense frames' tiny grayscale
//      signatures — using sharp (already a dependency; see
//      basePlateCropService.js). A transient artifact is, almost by
//      definition, a minority-frame outlier relative to the rest of the
//      clip; a robust median+MAD threshold flags it without needing to
//      know in advance where in the clip it will land.
//   3. Send the vision model the SAME 3-frame quartile baseline as before,
//      PLUS up to MAX_EXTRA_FRAMES frames that actually scored as outliers
//      (capped at MAX_TOTAL_FRAMES overall).
//
// COST CONSEQUENCE: a clean clip — the common case — flags zero outliers
// and ships the exact same 3-frame vision call as today. Only a clip whose
// dense probe already looks suspicious pays for the extra 1-2 frames of
// evidence. Measured against the current ~$0.02/check baseline (4 images:
// seed + 3 frames), the worst case (all 5 frames used: seed + 3 baseline +
// 2 flagged) is ~6 images vs. ~4 — roughly a 1.5x per-check cost on the
// (rare) flagged subset, 1x on everything else. See session.d/ for the
// dated write-up with the actual measured delta.
//
// FAIL-SAFE: any failure in this module (network, decode, too few frames
// downloaded) degrades to returning the ORIGINAL quartile baseline — i.e.
// exactly today's behavior. A bug here can only ever leave QC as blind as
// it already was; it can never block or break a render.
//
// KILL SWITCH: VIDEO_QC_DENSE_SAMPLING, default true. Set to "false" to
// restore the byte-identical pre-existing quartile-only frame set with no
// deploy of this file.

'use strict';

const videoFrameService = require('./videoFrameService');

const PREFILTER_WIDTH = 160;          // tiny — this download never reaches a vision model
const SIGNATURE_SIZE = 16;            // 16x16 grayscale grid per frame (256 values)
// Documentation only, NOT what baselineTimestamps() computes — see the
// comment on that function for why a literal fractions formula here would
// be a bug, not just a simplification. Describes the common 8-10s ad case.
const BASELINE_FRACTIONS = Object.freeze([0.25, 0.5, 0.75]);
const MAX_EXTRA_FRAMES = 2;           // cap on OUTLIER-triggered extra vision frames
const MAX_TOTAL_FRAMES = 5;           // hard cap: baseline (3) + extras (<=2)
const OUTLIER_MIN_SCORE = 0.04;       // floor so near-static footage can't "flag" from decode noise
const OUTLIER_MAD_MULTIPLIER = 3;     // robust median + k*MAD threshold
const MIN_DENSE_FRAMES_TO_SCORE = 3;  // below this, there isn't enough evidence to score outliers

function envFlag(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return def;
  return String(raw).toLowerCase() === 'true';
}

/** Kill switch. Default ON. */
function isDenseSamplingEnabled() {
  return envFlag('VIDEO_QC_DENSE_SAMPLING', true);
}

/**
 * The pre-existing frame plan — the floor this module never drops below,
 * and (with the kill switch off) the WHOLE answer.
 *
 * MUST delegate to the real videoFrameService.planTimestamps rather than
 * reimplementing a fractions formula: planTimestamps has THREE duration
 * buckets, not one — a tiny clip (<=4s, a real value: Omni's duration enum
 * is [4,6,8,10]) gets exactly ONE mid-frame, not three quartiles, and a
 * long clip (>20s) gets a stride-based plan capped at 5, not three
 * quartiles either. A literal `[0.25,0.5,0.75].map(f => d*f)` formula here
 * matches planTimestamps ONLY inside the 4-20s bucket and silently
 * diverges outside it — caught by an adversarial review probing exactly
 * this (durationSec=4: planTimestamps returns [2], a fractions formula
 * returns [1,2,3]). That divergence would make the "kill switch off
 * restores byte-identical old behavior" claim false for any ad whose
 * duration falls outside 4-20s, which is the entire point of the switch.
 */
function baselineTimestamps(durationSec) {
  return videoFrameService.planTimestamps(durationSec);
}

/**
 * Downsample a JPEG buffer to a small grayscale pixel grid via sharp.
 * Returns a plain Array<number> of length SIGNATURE_SIZE*SIGNATURE_SIZE,
 * each value normalized to [0,1]. `deps.sharp` is injectable so a unit
 * test can stub image decode; the behavioral harness deliberately does
 * NOT stub it — it decodes real (tiny, synthetically generated) JPEGs to
 * prove the scoring catches a real visual outlier end to end.
 */
async function computeFrameSignature(buffer, deps = {}) {
  const sharp = deps.sharp || require('sharp');
  const raw = await sharp(buffer)
    .resize(SIGNATURE_SIZE, SIGNATURE_SIZE, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer();
  const out = new Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw[i] / 255;
  return out;
}

function meanAbsDiff(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Per-pixel median across all signatures — the clip's own "steady state". */
function medianSignature(signatures) {
  const n = signatures[0].length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = median(signatures.map((s) => s[i]));
  }
  return out;
}

/**
 * Score each signature by its distance from the clip's own steady state,
 * then flag outliers via a robust median + k*MAD threshold (robust to a
 * MINORITY of outlier frames, which is exactly the transient-defect shape
 * this exists to catch). Pure function, no I/O — exported directly so the
 * scoring math has a fast, decode-free unit test independent of sharp.
 */
function scoreOutliers(signatures, opts = {}) {
  const {
    minScore = OUTLIER_MIN_SCORE,
    madMultiplier = OUTLIER_MAD_MULTIPLIER
  } = opts;
  if (!Array.isArray(signatures) || signatures.length < MIN_DENSE_FRAMES_TO_SCORE) {
    return signatures.map(() => ({ score: 0, outlier: false }));
  }
  const steady = medianSignature(signatures);
  const scores = signatures.map((sig) => meanAbsDiff(sig, steady));
  const med = median(scores);
  const mad = median(scores.map((s) => Math.abs(s - med))) || 0;
  const threshold = Math.max(minScore, med + madMultiplier * mad);
  return scores.map((score) => ({ score, outlier: score > threshold }));
}

/**
 * Full orchestration: dense probe (cheap) -> score -> a bounded final
 * timestamp list (baseline quartiles + flagged outliers, capped at
 * MAX_TOTAL_FRAMES). NEVER throws — any failure degrades to the baseline
 * quartile set, i.e. exactly the pre-existing behavior.
 *
 * Returns { timestamps, denseCount, flaggedCount, degraded }.
 * `deps.fetchDenseFrames` / `deps.computeFrameSignature` injectable for tests.
 */
async function selectQcFrameTimestamps({ deliveredUrl, durationSec } = {}, deps = {}) {
  const baseline = baselineTimestamps(durationSec);

  if (!isDenseSamplingEnabled()) {
    return { timestamps: baseline, denseCount: 0, flaggedCount: 0, degraded: false };
  }

  const dense = videoFrameService.planDenseTimestamps(durationSec);
  if (!dense.length) {
    return { timestamps: baseline, denseCount: 0, flaggedCount: 0, degraded: false };
  }

  try {
    const fetchDense = deps.fetchDenseFrames
      || ((url, stamps) => videoFrameService.fetchFrameBuffersAtTimestamps(url, stamps, { width: PREFILTER_WIDTH }));
    const frames = await fetchDense(deliveredUrl, dense);

    if (!frames || frames.length < MIN_DENSE_FRAMES_TO_SCORE) {
      // Not enough evidence to score outliers meaningfully — ship baseline.
      return {
        timestamps: baseline,
        denseCount: frames ? frames.length : 0,
        flaggedCount: 0,
        degraded: true
      };
    }

    const sig = deps.computeFrameSignature || computeFrameSignature;
    const signatures = await Promise.all(frames.map((f) => sig(f.buffer)));
    const scored = scoreOutliers(signatures);

    const flagged = frames
      .map((f, i) => ({ timestampSec: f.timestampSec, ...scored[i] }))
      .filter((f) => f.outlier)
      // Skip anything already effectively covered by a baseline quartile —
      // no point paying for a near-duplicate frame.
      .filter((f) => !baseline.some((b) => Math.abs(b - f.timestampSec) < 0.4))
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_EXTRA_FRAMES)
      .map((f) => f.timestampSec);

    const merged = [...new Set([...baseline, ...flagged])].sort((a, b) => a - b);

    return {
      timestamps: merged.slice(0, MAX_TOTAL_FRAMES),
      denseCount: frames.length,
      flaggedCount: flagged.length,
      degraded: false
    };
  } catch (err) {
    const msg = (err && err.message) ? err.message : String(err || 'unknown');
    console.warn(`   ⚠️  videoQcFrameSelection: dense pre-filter failed, shipping baseline quartiles: ${msg}`);
    return { timestamps: baseline, denseCount: 0, flaggedCount: 0, degraded: true };
  }
}

module.exports = {
  PREFILTER_WIDTH,
  SIGNATURE_SIZE,
  BASELINE_FRACTIONS,
  MAX_EXTRA_FRAMES,
  MAX_TOTAL_FRAMES,
  OUTLIER_MIN_SCORE,
  OUTLIER_MAD_MULTIPLIER,
  isDenseSamplingEnabled,
  baselineTimestamps,
  computeFrameSignature,
  scoreOutliers,
  selectQcFrameTimestamps
};
