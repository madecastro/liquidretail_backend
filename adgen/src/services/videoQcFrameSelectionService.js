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
// 4x vision bill for every ad, including the large majority that have no
// transient defect at all. Instead:
//   1. Pull a DENSE, EARLY-WEIGHTED set of TINY frames (width ~160px —
//      videoFrameService.planDenseTimestamps), concentrated in the first
//      ~2s where this class of artifact empirically clusters, but spanning
//      the whole clip. This step is cheap: no vision call, small images,
//      Cloudinary edge transform.
//   2. Score each dense frame's tiny grayscale signature (sharp — already
//      a dependency; see basePlateCropService.js) against a "steady state"
//      reference via a robust median+MAD threshold — see SCORING DESIGN
//      below for exactly what the reference is and why.
//   3. Send the vision model the SAME 3-frame quartile baseline as before,
//      PLUS up to MAX_EXTRA_FRAMES frames that actually scored as outliers
//      (capped at MAX_TOTAL_FRAMES overall).
//
// SCORING DESIGN — WHY THE REFERENCE IS THE LATE CLUSTER, NOT THE WHOLE SET
// ---------------------------------------------------------------------------
// FIXED 2026-08-20 (adversarial review, second pass): the first version
// scored every dense frame against the median of ALL dense frames. Median
// (and MAD) have a ~50% breakdown point — a robust median can only ignore
// a MINORITY of outliers. planDenseTimestamps splits its ~12 samples
// roughly 50/50 between the early cluster (<=DEFAULT_EARLY_WINDOW_SEC) and
// the rest of the clip. A defect that persists across the WHOLE early
// cluster (not just 1-2 flash frames, but ~2 continuous seconds of it —
// plausible; the proven incident's chrome was visible at both sampled
// points inside that same window) is then exactly an even split: the
// per-pixel median becomes a blend of "defect" and "clean" signatures,
// every frame sits roughly the SAME distance from that blend, MAD is
// small, and NOTHING gets flagged — the exact defect shape this file
// exists to catch, mathematically invisible to the naive version.
//
// Fixed by making the reference asymmetric: compute the steady-state
// signature (and the MAD threshold) from the LATE cluster ONLY (frames
// after videoFrameService.DEFAULT_EARLY_WINDOW_SEC), then score EVERY
// frame — early and late — against that reference. Consequences:
//   - A defect confined to ANY portion of the early cluster, up to and
//     including ALL of it, cannot contaminate a reference that is derived
//     entirely from the late cluster. It is always visible as a deviation.
//   - A defect confined to a MINORITY of the late cluster is still caught
//     the old way (median+MAD within that subset).
//   - A defect spanning the WHOLE clip (early AND late) makes the late
//     reference itself "wrong" in the same way as the early frames, so
//     nothing gets flagged by this pre-filter — but that is precisely the
//     PERSISTENT, whole-clip defect class the pre-existing 3-quartile
//     baseline already catches (see the Vuori case above). Deferring that
//     class to the existing mechanism is a deliberate division of labor,
//     not a gap: this file's whole reason to exist is the class the
//     baseline CANNOT see.
// If the late cluster is too small to be a robust reference (very short
// clips), scoreOutliers falls back to using every frame as its own
// reference — the original, less-robust-but-still-useful behavior — so a
// short clip degrades gracefully rather than skipping scoring outright.
//
// REDUNDANCY FILTERING WAS REMOVED, ON PURPOSE (adversarial review): the
// first version dropped any flagged outlier within 0.4s of a baseline
// quartile, reasoning that it was "probably the same moment" as a frame
// already being sent. That reasoning is backwards for exactly the frames
// this module flags: an outlier is, BY DEFINITION, a frame whose content
// looks meaningfully different from the reference — including from a
// same-second baseline neighbor. Proven concretely: a defect visible only
// at t=7.2s and gone by the adjacent t=7.5s baseline quartile (0.3s apart)
// would have been silently dropped by that filter, handing the vision
// model the CLEAN 7.5s frame and calling it covered. Exact-duplicate
// timestamps (same rounded value) are still deduplicated via a Set — that
// is genuine redundancy; proximity is not.
//
// KNOWN, ACCEPTED COST CHARACTERISTIC — TITLING ENTRANCE (documented, not
// disproven): runVideoVisionQcForAd inspects the TITLED upload
// (`uploaded.secure_url`), and a title/caption/logo overlay animates IN
// during roughly the same early window this pre-filter watches most
// closely (e.g. an `enterAtSec: 0.15` preset, not fully composited until
// ~2s). That is a REAL, EXPECTED visual change in the early cluster on
// EVERY normally-titled ad, not a defect — so some ordinarily-clean ads
// may occasionally earn an extra flagged frame purely from title entrance,
// not from anything wrong with the render. This is a COST characteristic,
// not a correctness one: (a) it is bounded by the same MAX_EXTRA_FRAMES /
// MAX_TOTAL_FRAMES caps as any other flag, so the worst case is unchanged;
// (b) the vision prompt this hands the extra frame to already explicitly
// treats a brand's own composited chrome/caption overlay as expected, not
// a defect (buildVideoVisionUserContent's competitor_marks and
// layout_safe_box categories), so it should not manufacture a false FAIL —
// only, at most, a slightly higher hit rate on the cheap pre-filter than
// the "clean clip costs nothing extra" framing above assumes in the ideal
// case. Not fixed here: doing better would need real pixel data from a
// titled ad with no defect, which this offline harness cannot fabricate
// honestly, and no billable generation was authorized to go get it. Flag
// for live monitoring once this ships.
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
// 32x32 (1024 values), not 16x16: bumped after adversarial review flagged
// that a thin real chrome bar (a few percent of frame height) could
// average away under a coarser grid, especially across only a handful of
// rows. Still trivially cheap for sharp; no vision-cost impact either way.
const SIGNATURE_SIZE = 32;
// Documentation only, NOT what baselineTimestamps() computes — see the
// comment on that function for why a literal fractions formula here would
// be a bug, not just a simplification. Describes the common 8-10s ad case.
const BASELINE_FRACTIONS = Object.freeze([0.25, 0.5, 0.75]);
const MAX_EXTRA_FRAMES = 2;           // cap on OUTLIER-triggered extra vision frames
const MAX_TOTAL_FRAMES = 5;           // hard cap: baseline (3) + extras (<=2)
const OUTLIER_MIN_SCORE = 0.04;       // floor so near-static footage can't "flag" from decode noise
const OUTLIER_MAD_MULTIPLIER = 3;     // robust median + k*MAD threshold
const MIN_DENSE_FRAMES_TO_SCORE = 3;  // below this, there isn't enough evidence to score outliers
// Below this many LATE-cluster frames, an asymmetric reference isn't
// robust either — scoreOutliers falls back to using every frame as its
// own reference rather than refusing to score at all.
const MIN_REFERENCE_FRAMES = 3;

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

/** Per-pixel median across the given signatures — a "steady state". */
function medianSignature(signatures) {
  const n = signatures[0].length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = median(signatures.map((s) => s[i]));
  }
  return out;
}

/**
 * Score each signature by its distance from a "steady state" reference,
 * then flag outliers via a robust median + k*MAD threshold.
 *
 * `opts.referenceIndices`, when given and long enough
 * (>= MIN_REFERENCE_FRAMES), restricts BOTH the reference signature and
 * the MAD threshold to that subset of `signatures` — see this file's
 * header "SCORING DESIGN" section for why: it is what lets a defect
 * spanning an entire early cluster (up to a full 50/50 split against the
 * rest of the dense set) still register as a deviation, instead of
 * silently blending into the median the naive whole-set version computed.
 * Falls back to using every signature as its own reference when no valid
 * subset is given, which is also what a plain unit test gets by default.
 *
 * Pure function, no I/O — exported directly so the scoring math has a
 * fast, decode-free unit test independent of sharp.
 */
function scoreOutliers(signatures, opts = {}) {
  const {
    minScore = OUTLIER_MIN_SCORE,
    madMultiplier = OUTLIER_MAD_MULTIPLIER,
    referenceIndices = null
  } = opts;
  if (!Array.isArray(signatures) || signatures.length < MIN_DENSE_FRAMES_TO_SCORE) {
    return signatures.map(() => ({ score: 0, outlier: false }));
  }

  const refIdx = (Array.isArray(referenceIndices) && referenceIndices.length >= MIN_REFERENCE_FRAMES)
    ? referenceIndices
    : signatures.map((_, i) => i);

  const steady = medianSignature(refIdx.map((i) => signatures[i]));
  const scores = signatures.map((sig) => meanAbsDiff(sig, steady));
  const refScores = refIdx.map((i) => scores[i]);
  const med = median(refScores);
  const mad = median(refScores.map((s) => Math.abs(s - med))) || 0;
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

    // Reference = the LATE cluster only (see file header "SCORING
    // DESIGN") — frames strictly after the same early-window boundary
    // planDenseTimestamps itself uses, so the two can never disagree.
    const referenceIndices = frames
      .map((f, i) => (f.timestampSec > videoFrameService.DEFAULT_EARLY_WINDOW_SEC ? i : -1))
      .filter((i) => i >= 0);

    const scored = scoreOutliers(signatures, { referenceIndices });

    const flagged = frames
      .map((f, i) => ({ timestampSec: f.timestampSec, ...scored[i] }))
      .filter((f) => f.outlier)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_EXTRA_FRAMES)
      .map((f) => f.timestampSec);

    // Set dedup handles a genuine exact-timestamp collision between the
    // dense probe and the baseline plan; there is deliberately no
    // proximity-based redundancy filter beyond that — see file header.
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
  MIN_REFERENCE_FRAMES,
  isDenseSamplingEnabled,
  baselineTimestamps,
  computeFrameSignature,
  scoreOutliers,
  selectQcFrameTimestamps
};
