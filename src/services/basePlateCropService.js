'use strict';
/**
 * basePlateCropService — face-safe crop of the BASE video before Remotion titling.
 *
 * WHY: since 713c2e5 every portrait target renders at Omni's family native (9:16, 1080x1920 at
 * ATLAS_VIDEO_RESOLUTION=1080p) and reaches its 4:5 canvas via Remotion BasePlate.jsx:18
 * `objectFit:'cover'` — a subject-blind centre crop. Measured on a head at y154-499 of a 1080x1920
 * master: the centre crop cuts 131px of head at 4:5 and 266px at 1:1. This service computes a
 * face-safe rect (services/faceSafeCrop.js), turns it into a synchronous Cloudinary c_crop URL
 * (services/videoCropUrl.js), verifies the URL is actually deliverable, persists it on the Ad, and
 * hands it to titling in place of ad.veoVideoUrl — so objectFit:'cover' becomes a no-op.
 *
 * DEGRADATION CONTRACT — the load-bearing property:
 * every failure, gate miss, or doubt returns null, and the caller uses ad.veoVideoUrl unchanged,
 * i.e. byte-for-byte today's behaviour. The ONE exception this must never allow: substituting a URL
 * that fails at delivery time. remotionRenderService downloads the plate with axios's default
 * validateStatus, renderTitles' failure is swallowed non-fatally at routes/ads.js (brand-script
 * chrome is best-effort), and the ad then ships renderUrl = the RAW UNTITLED 9:16 master — strictly
 * worse than today's titled-but-beheaded output. Hence the liveness probe below, and the
 * retry-with-raw in brandScriptExecutor.
 *
 * Gates, in order (each with a logged reason):
 *   kill switch            BASE_PLATE_CROP_ENABLED !== 'false'   (on by default; env off-switch)
 *   format target          TARGET_BY_FORMAT[format] — keyed on classifyFormat's output ONLY.
 *                          Never ad.aspectRatio, never platformFormat: classifyFormat also reads
 *                          aspectRatio, so deriving the target from anything else can disagree with
 *                          the composition Remotion will actually use — and then the crop parks the
 *                          head FACE_TOP_MARGIN_FRAC from an edge a second blind crop removes.
 *   catchall guard         aspectRatioForPlatformFormat(ad.platformFormat) must EQUAL the target.
 *                          'feed' is classifyFormat's catch-all, so a 1.91:1 or 5:4 ad lands there;
 *                          without this check it would be silently cropped to 4:5.
 *   URL shape              transformable /video/upload/, no existing crop transform (double-crop).
 *   source dims            measured from a DELIVERY-space still (sharp on an so_0 full-size frame),
 *                          never from upload metadata — upload space is the v1 black-bar bug. Must
 *                          be integers and within the delivery cap.
 *   full-frame no-op       a 9:16 target on a 9:16 master needs no crop: return null, zero cost.
 *                          The orchestrator evaluates this via cropCouldBeNeeded AFTER measuring
 *                          dims and BEFORE detectClipBoxes — vision is not spent to learn it.
 *   face quorum            heads must be found in >= FACE_MIN_FRAMES sampled frames
 *                          (consensusFaceBox). No quorum -> null.
 *   face anchor            the rect's anchorY must be a face anchor. anchorY 'center' is NOT
 *                          "today's output" — centerOnBox centres on the SUBJECT's centre of
 *                          gravity, and a skewed subject box can cut MORE head than the blind
 *                          centre crop. Only a face-verified rect may replace the plate.
 *   liveness               range-GET on the derived URL must return 200/206 before it is trusted.
 *
 * COST: 3-4 vision calls per ad that ACTUALLY NEEDS a crop (~$0.02, ledgered automatically via
 * chatCompletion -> trackLlmCall). planTimestamps({isReel:true}) yields 1 still (tiny ≤4s), 3
 * (typical 8s reel; the default durationSec), or at most 4 (long reel). Boundary-miss retry
 * (head===null AND faceHits===1, measured ~9% of crop-eligible ads): +FACE_QUORUM_RETRY_FRAMES
 * (2) extra vision calls, ONCE, on new timestamps — worst case 4+2=6 calls (~$0.03). 0-hit ads
 * and already-quorum ads do not pay the retry. $0 for cached re-titles (Ad.basePlate). $0 for
 * every gated-out ad. $0 on the crop path when cropCouldBeNeeded is false (full-frame 9:16→9:16
 * / 16:9→16:9). Title keep-out may still pay detectClipBoxes ONCE if facesComputed is not
 * already on the ad — that answers "where are the heads", not "do we need a crop", and is not a
 * second crop-decision submit. No ffmpeg, no video download — frames are Cloudinary so_<sec>
 * stills at the CDN edge.
 */

const axios = require('axios');
const sharp = require('sharp');
const Ad = require('../models/Ad');
const { chatCompletion } = require('./atlasLlmService');
const { buildFrameUrls, buildAdditionalFrameUrls } = require('./videoFrameService');
const { aspectRatioForPlatformFormat } = require('./platformFormats');
const {
  computeGravityCropRect, parseAspect, windowFor, unionBoxes, consensusFaceBox,
  FACE_QUORUM_RETRY_FRAMES,
} = require('./faceSafeCrop');
const {
  buildVideoCropUrl, isTransformableVideoUrl, hasExistingCropTransform,
} = require('./videoCropUrl');
const { noteRenderIssue } = require('./adStage');

const ENABLED = () => String(process.env.BASE_PLATE_CROP_ENABLED ?? 'true').toLowerCase() !== 'false';
// Face keep-out for titling (plateHints band avoid flags). Off → behaviour
// identical to pre-keep-out: no detection call from the keep-out path.
const FACE_KEEPOUT_ENABLED = () =>
  String(process.env.TITLE_FACE_KEEPOUT ?? 'true').toLowerCase() !== 'false';

// Cloudinary's video pipeline delivers at a capped resolution (account-dependent; the v1 bbox bug
// was crop coords beyond that cap being silently clipped then black-padded). Dims here are measured
// in DELIVERY space, so anything above the cap means the measurement itself is suspect — refuse.
const DELIVERY_CAP = () => {
  const n = Number(process.env.CLOUDINARY_VIDEO_DELIVERY_CAP);
  return Number.isFinite(n) && n >= 480 ? n : 1080;
};

/**
 * Crop target per TITLING FORMAT — the output of brandScriptExecutor.classifyFormat, which is also
 * what picks the Remotion composition. Frozen and asserted by scripts/verifyBasePlateCrop.js to
 * match both remotion/Root.jsx composition dims and platformFormats deliveryDims, so target and
 * composition cannot drift apart.
 */
const TARGET_BY_FORMAT = Object.freeze({
  vertical:  '9:16',
  feed:      '4:5',
  square:    '1:1',
  landscape: '16:9',
});

const CURRENT_VERSION = 1;

// ── pure decision half (offline-testable; scripts/verifyBasePlateCrop.js) ──────────────────────

/**
 * Decide whether/where to crop. Pure — no I/O. Returns
 *   { action: 'crop', target, rect }        — safe to build the URL
 *   { action: 'skip', reason }              — leave the plate alone
 *
 * @param {object} a
 * @param {string} a.format          classifyFormat(ad) output
 * @param {string} a.platformFormat  ad.platformFormat
 * @param {string} a.sourceUrl       ad.veoVideoUrl
 * @param {number} a.sourceW         measured DELIVERY-space width
 * @param {number} a.sourceH         measured DELIVERY-space height
 * @param {object|null} a.subject    union subject box (normalized), or null
 * @param {object|null} a.head       consensus head box (normalized), or null when no quorum
 */
/**
 * The cheap gates that need NO measurement and NO detection — evaluable before any network I/O.
 * decideBasePlateCrop re-runs them (it must stay correct standalone); the orchestrator calls this
 * first so a gated-out ad costs zero vision calls.
 */
function preGateBasePlateCrop({ format, platformFormat, sourceUrl }) {
  const target = TARGET_BY_FORMAT[format];
  if (!target) return { action: 'skip', reason: `unknown-format:${format}` };

  // Catch-all guard. 'feed' swallows every aspect that matches nothing else, so require the
  // platform format to agree with the format-derived target before cropping to it.
  const pfAspect = aspectRatioForPlatformFormat(platformFormat);
  if (pfAspect !== target) return { action: 'skip', reason: `aspect-mismatch:pf=${pfAspect ?? 'null'},target=${target}` };

  if (!isTransformableVideoUrl(sourceUrl)) return { action: 'skip', reason: 'not-transformable-url' };
  if (hasExistingCropTransform(sourceUrl)) return { action: 'skip', reason: 'already-cropped-url' };

  return { action: 'proceed', target };
}

function decideBasePlateCrop({ format, platformFormat, sourceUrl, sourceW, sourceH, subject, head }) {
  const pre = preGateBasePlateCrop({ format, platformFormat, sourceUrl });
  if (pre.action === 'skip') return pre;
  const target = pre.target;

  if (![sourceW, sourceH].every(Number.isInteger) || sourceW < 1 || sourceH < 1) {
    return { action: 'skip', reason: 'bad-dims' };
  }
  // Cap the SMALLER dimension, matching how videoCompositeService bounds srcMin: a 1080x1920
  // portrait and a 1920x1080 landscape master are both "1080-class" deliveries and both fine.
  // (First draft compared sourceW alone, which rejected every legitimate landscape master —
  // caught by verifyBasePlateCrop N2 on its first run.) Dims are measured from a delivery-space
  // still, so exceeding the cap means the measurement is suspect, not just the asset large.
  if (Math.min(sourceW, sourceH) > DELIVERY_CAP()) {
    return { action: 'skip', reason: `dims-exceed-delivery-cap:${sourceW}x${sourceH}` };
  }

  const aspect = parseAspect(target);
  if (!aspect) return { action: 'skip', reason: `bad-target:${target}` };

  // Full-frame no-op: nothing to crop (9:16 on a 9:16 master, 16:9 on a 16:9 master).
  const win = windowFor(sourceW, sourceH, aspect.wr, aspect.hr);
  if (!win) return { action: 'skip', reason: 'degenerate-window' };
  if (win.cw === sourceW && win.ch === sourceH) return { action: 'skip', reason: 'full-frame' };

  // No face quorum -> no crop. NOT a fall-through to centerOnBox: an anchorY 'center' rect centres
  // on the subject's centre of gravity, which a skewed subject box can push to cut MORE head than
  // the blind centre crop we would be replacing. The blind crop is the devil we know.
  if (!head) return { action: 'skip', reason: 'no-face-quorum' };

  const rect = computeGravityCropRect(sourceW, sourceH, aspect.wr, aspect.hr, subject, head);
  if (!rect) return { action: 'skip', reason: 'no-rect' };
  if (rect.anchorY === 'center') return { action: 'skip', reason: 'face-rejected-by-plausibility' };

  return { action: 'crop', target, rect };
}

/**
 * Cheap predicate: could a crop possibly be needed? Pure — no I/O, no vision.
 *
 * Reuses decideBasePlateCrop with head=null so the cheap gates (preGate, dims,
 * full-frame window) fire first and the face check is never consulted. The only
 * skip that means "we still need vision to decide" is `no-face-quorum` — we got
 * past full-frame. Any other skip is a crop that is provably unnecessary.
 *
 * Evaluable as soon as delivery dims are known. Target aspect comes from
 * TARGET_BY_FORMAT[format]; master aspect comes from the measured sourceW/H
 * via windowFor — the same comparison decideBasePlateCrop uses, so this cannot
 * disagree with it.
 */
function cropCouldBeNeeded({ format, platformFormat, sourceUrl, sourceW, sourceH }) {
  const d = decideBasePlateCrop({
    format, platformFormat, sourceUrl, sourceW, sourceH,
    subject: null, head: null,
  });
  return d.reason === 'no-face-quorum';
}

// ── split-panel drift (PMax 16:9 split-stage; PMAX_SPLIT_VIDEO) ─────────────────────────────────
//
// decideBasePlateCrop (above) answers "crop a master TO an aspect" — a different question from
// what follows. The PMax 16:9 split unit renders a 1920x1080 master that is ALREADY 16:9: the
// product is seeded into a vertical band on ONE side and the video model generatively extends the
// rest. Nothing needs cropping; what needs checking is whether the FINISHED render kept the
// subject out of the OTHER side, which is about to carry composited ad copy. That is containment
// inside an already-correct frame, not a crop decision, so it gets its own pure function rather
// than a new parameter bolted onto decideBasePlateCrop (which would make that function answer two
// unrelated questions depending on which caller invoked it).
//
// COST: zero NEW vision calls WHEN a crop was already needed — detectClipBoxes is billed on that
// path (~$0.02) and the per-frame subject boxes are sitting in that already-paid output. A
// full-frame ad (16:9→16:9 split master, 9:16→9:16) no longer runs detectClipBoxes in
// resolveBasePlateVideoUrl; a future split-drift caller cannot assume boxes are already paid for
// on that path (keep-out may have paid, via ensureFaceDetectionForKeepOut, or nothing has).
// Its per-frame subject boxes carry the FULL box (left/top/right/bottom), but every consumer today
// — decideBasePlateCrop, computeGravityCropRect, the face keep-out path — reduces them to their
// VERTICAL extent only (head/subject top-bottom) because every existing target is a portrait or
// square crop, where the horizontal extent never mattered. The horizontal signal has been sitting
// in already-paid-for detection output, unused. This function is the first consumer of it.

/**
 * Valid values for `panelSide`. Exported so the harness enumerates the real vocabulary instead of
 * re-typing the string literals, and so a future caller cannot silently pass a third value that
 * both this function's `switch`-free lookup AND a hand-rolled caller check would need to agree on.
 */
const SPLIT_PANEL_SIDES = Object.freeze(['west', 'east']);

/**
 * Panel side -> the horizontal interval (normalized 0..1) the copy panel OCCUPIES.
 *
 * THE INVERSION TRAP THIS TABLE EXISTS TO AVOID: 'west' reads as "the panel is on the west/left",
 * which is correct, but the SUBJECT's safe region is the opposite side (east/right) — a hand-rolled
 * `if (panelSide === 'west') return box.left > threshold` is one `<`/`>` typo away from checking the
 * wrong side, and that typo would silently pass every "obviously safe" fixture where the subject
 * sits in the middle of its own half (only a near-boundary case would ever expose it). Encoding
 * the panel's own OCCUPIED interval as data — not the subject's derived safe side — means the
 * overlap math below is one formula for both sides (the subject is safe wherever it does NOT
 * overlap the panel's interval), and there is nothing left to invert once this table is right.
 * scripts/verifyPmaxSplitDrift.js's mirror-sweep check (same geometry, flipped panelSide, opposite
 * verdict) is the regression guard for this table specifically.
 */
const PANEL_INTERVAL_BY_SIDE = Object.freeze({
  west: (panelWidthFrac) => ({ start: 0, end: panelWidthFrac }),
  east: (panelWidthFrac) => ({ start: 1 - panelWidthFrac, end: 1 }),
});

/**
 * Drift tolerance, as a FRACTION OF THE PANEL'S OWN WIDTH (not of the frame). Exported so the
 * harness pins fixtures against the real constant instead of duplicating the literal.
 *
 * FRACTION OF PANEL WIDTH, NOT FRAME WIDTH: panelWidthFrac itself will vary by layout, and an
 * absolute (frame-relative) grace band would give a narrow copy column a disproportionately large
 * allowance relative to its own size. Scaling by the panel's own width keeps "a graze" meaning the
 * same relative intrusion regardless of how wide the split happens to be.
 *
 * WHY 0.06: the subject box comes from the same vision detection as faceSafeCrop's head box, whose
 * FACE_MARGIN_FRAC (services/faceSafeCrop.js) uses the identical value for the identical reason —
 * a detected box edge is the model's best guess at a boundary, not a hard pixel line, and a real
 * product's cast shadow, reflection or motion-blurred edge routinely grazes a few percent past the
 * "true" silhouette without the product actually having moved into the panel. 6% of the panel's own
 * width absorbs that noise. It does not need to be large to also catch genuine drift: a subject
 * actually pushed INTO the panel (as opposed to grazing its inner edge) overlaps by a large fraction
 * of the panel's width, not a single-digit-percent sliver — see the 'grazing' vs 'squarely inside'
 * fixtures in scripts/verifyPmaxSplitDrift.js, which pin the boundary on both sides of this constant.
 */
const DEFAULT_DRIFT_TOLERANCE_FRAC = 0.06;

/**
 * A frame's subject box we are willing to do arithmetic with, else null. Same defensive shape as
 * faceSafeCrop's usableBox / this file's parseBox — boxes arrive from a vision model by way of
 * detectClipBoxes' per-frame `results`, so every field must be re-validated here independently of
 * whatever validation ran upstream (a stale/replayed frame array is untrusted input to THIS
 * function, not just to whatever produced it).
 */
function usableSplitFrameBox(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
  const { left, top, right, bottom } = b;
  if (![left, top, right, bottom].every(Number.isFinite)) return null;
  if (right <= left || bottom <= top) return null; // inverted/degenerate box ("x2 < x1") — garbage
  return b;
}

/**
 * Did the rendered subject drift into the copy panel on a PMax 16:9 split-stage master? Pure — no
 * I/O, mirrors decideBasePlateCrop's shape and place in this file.
 *
 * @param {object} a
 * @param {Array<object|null>} a.frameBoxes  per-frame SUBJECT boxes (normalized left/top/right/
 *   bottom), same array detectClipBoxes already builds internally before reducing it to a union —
 *   one entry per sampled frame, null where that frame's detection failed.
 * @param {'west'|'east'} a.panelSide  which side the COPY PANEL occupies (see PANEL_INTERVAL_BY_SIDE
 *   — read its comment before touching this parameter's handling).
 * @param {number} a.panelWidthFrac  panel width as a fraction (0,1) of the 1920x1080 frame width.
 * @param {number} [a.tolerance]  overlap tolerance, fraction of panelWidthFrac. Defaults to
 *   DEFAULT_DRIFT_TOLERANCE_FRAC when omitted or not a finite number >= 0 — an invalid tolerance is
 *   a caller bug, not a reason to refuse a verdict altogether, so unlike panelSide/panelWidthFrac it
 *   degrades to the documented default rather than making the whole call undecidable.
 *
 * @returns {{drifted: false} | {drifted: true, reason: string, worstOverlapFrac: number, atFrame: number}
 *          | {drifted: null, reason: string}}
 *   drifted:false  — every usable frame's subject box stayed clear of the panel (within tolerance).
 *   drifted:true   — reason is `subject-in-${panelSide}-panel`; worstOverlapFrac/atFrame identify
 *                    the WORST sampled frame (see below), not the first one that tripped.
 *   drifted:null   — undecidable: bad panelSide/panelWidthFrac, or every frame was missing/garbage.
 *
 * WHY THE WORST FRAME, NOT THE FIRST: the seed-time gate upstream (the composed seed places the
 * subject on its side BEFORE generation) can only ever see frame zero's intent, not what the video
 * model does with it. Drift is a mid-clip failure mode — the model wanders as the clip progresses —
 * so a verdict based on only the first (or an average of all) sampled frame(s) would systematically
 * miss the exact case this function exists to catch. Every usable frame is evaluated and the worst
 * (maximum overlap) wins, full stop; scripts/verifyPmaxSplitDrift.js pins this against a fixture
 * where only a LATE frame drifts.
 *
 * WHY UNDECIDABLE (null) RATHER THAN A DEFAULT true/false WHEN EVIDENCE IS MISSING: the two wrong
 * answers are not equally bad. A false "safe" ships copy composited on top of the product on an
 * already-billed render — the exact defect this stage exists to prevent. A false "drifted" only
 * costs a less-adventurous centred layout for one ad. That asymmetry means "no usable evidence"
 * must never silently collapse to "no problem" (drifted:false) OR quietly default to a hardcoded
 * fallback verdict inside this function — it is reported honestly as null, and the CALLER decides.
 * Documented default for callers: treat drifted:null the SAME as drifted:true (fall back to the
 * centred layout) — same reasoning as decideBasePlateCrop's `no-face-quorum` skip a few lines up in
 * this file: the safe/cheap wrong answer is preferred over the billable/expensive wrong answer.
 * This function does not enforce that default itself because a caller may have another signal
 * (e.g. a second detection pass, an operator override) that legitimately breaks the tie differently.
 *
 * Total function: every branch returns a plain object: never throws, never returns a bare boolean.
 */
function decideSplitPanelDrift({ frameBoxes, panelSide, panelWidthFrac, tolerance } = {}) {
  try {
    // Cheap, I/O-free gates first — same ordering principle as preGateBasePlateCrop: fail on the
    // config that's wrong regardless of what the frames say, before spending any per-frame work.
    const interval = SPLIT_PANEL_SIDES.includes(panelSide) ? PANEL_INTERVAL_BY_SIDE[panelSide] : null;
    if (!interval) return { drifted: null, reason: `bad-panel-side:${panelSide}` };
    if (!Number.isFinite(panelWidthFrac) || panelWidthFrac <= 0 || panelWidthFrac >= 1) {
      return { drifted: null, reason: `bad-panel-width-frac:${panelWidthFrac}` };
    }
    if (!Array.isArray(frameBoxes)) return { drifted: null, reason: 'frame-boxes-not-array' };

    const tol = Number.isFinite(tolerance) && tolerance >= 0 ? tolerance : DEFAULT_DRIFT_TOLERANCE_FRAC;
    const { start, end } = interval(panelWidthFrac);

    let worstOverlapFrac = -Infinity;
    let atFrame = -1;
    let usableFrames = 0;

    for (let i = 0; i < frameBoxes.length; i++) {
      const box = usableSplitFrameBox(frameBoxes[i]);
      if (!box) continue; // missing/garbage frame — contributes no evidence either way, not a "safe" vote
      usableFrames++;
      // Overlap of the subject box with the panel's OWN interval [start,end] — the same formula
      // for both sides because `interval` already encodes which side that is (see the table above).
      const overlapWidth = Math.max(0, Math.min(box.right, end) - Math.max(box.left, start));
      const overlapFrac = overlapWidth / panelWidthFrac;
      if (overlapFrac > worstOverlapFrac) {
        worstOverlapFrac = overlapFrac;
        atFrame = i;
      }
    }

    if (usableFrames === 0) return { drifted: null, reason: 'no-usable-frames' };

    if (worstOverlapFrac > tol) {
      return { drifted: true, reason: `subject-in-${panelSide}-panel`, worstOverlapFrac, atFrame };
    }
    return { drifted: false };
  } catch (err) {
    // Total function contract — an unexpected shape must degrade to undecidable, never throw into
    // an orchestrator that (per the docs above) is expected to treat null as "assume drifted".
    return { drifted: null, reason: `internal-error:${err?.message?.slice(0, 80)}` };
  }
}

// ── detection half (I/O) ───────────────────────────────────────────────────────────────────────

/**
 * Vision prompt — the expander's verbatim smart-crop prompt (media.ts detectBoxes) plus one
 * DIVERGENCE: the head box must include HEADWEAR. The geometry holds the box's TOP edge off the
 * frame edge, so a hat outside the box gets cropped off — the exact miss the owner called out.
 */
const DETECT_SYSTEM_PROMPT =
  'You locate content in an ad video frame for smart-cropping. Return STRICT JSON only, no prose:\n' +
  '{"subject":{"left":..,"top":..,"right":..,"bottom":..},"face":{"left":..,"top":..,"right":..,"bottom":..}|null}\n' +
  'All values are fractions 0.0-1.0 of image width/height. left/right are horizontal (0=left edge, 1=right edge); ' +
  'top/bottom are vertical (0=top, 1=bottom). "subject" is the tight box around ALL important content ' +
  '(people, products, text). "face" is the tight box around the PRIMARY person\'s whole head — null if no ' +
  'human head is clearly visible. The head box must contain the entire head including hair and chin, AND any ' +
  'headwear worn (hat, cap, hood, helmet, headscarf) — the box\'s top edge is used to keep the head clear of ' +
  'the crop edge, so headwear outside the box gets cut off. Include nothing below the chin.';

/** Parse one normalized box from vision JSON; null on any doubt (mirrors the expander's parseBox). */
function parseBox(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const clamp01 = (n) => Math.min(1, Math.max(0, n));
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
  const box = {
    left: clamp01(num(raw.left)), top: clamp01(num(raw.top)),
    right: clamp01(num(raw.right)), bottom: clamp01(num(raw.bottom)),
  };
  if ([box.left, box.top, box.right, box.bottom].some(Number.isNaN)) return null;
  if (box.right <= box.left || box.bottom <= box.top) return null;
  return box;
}

/** One frame -> { subject, face } | null. Failures return null (a frame that couldn't vote). */
async function detectFrameBoxes(frameUrl, { campaignRunId = null, brandId = null, productId = null, adId = null, ...meta } = {}) {
  try {
    const response = await chatCompletion(
      { stage: 'base_plate_crop', service: 'basePlateCropService', campaignRunId, brandId, productId, adId, ...meta },
      {
        model: 'gpt-4.1', // legacy id -> atlasModelMap -> openai/gpt-5.6-terra on the Atlas transport
        messages: [
          { role: 'system', content: DETECT_SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Locate the subject and the head.' },
              { type: 'image_url', image_url: { url: frameUrl } },
            ],
          },
        ],
        max_tokens: 400,
        temperature: 0,
      },
    );
    const text = String(response?.choices?.[0]?.message?.content ?? '').replace(/```(?:json)?/gi, '');
    const m = /\{[\s\S]*\}/.exec(text);
    if (!m) return null;
    const o = JSON.parse(m[0]);
    const subject = parseBox(o.subject);
    if (!subject) return null;
    return { subject, face: parseBox(o.face) };
  } catch (err) {
    console.warn(`   ⚠️  basePlateCrop: frame detection failed (${err.message})`);
    return null;
  }
}

/**
 * Sample the clip and reconcile per-frame boxes.
 * Returns { subject, head, frames, faceHits, envelope, faceSamples } —
 * head is null without a quorum.
 *
 * `frames` and `faceHits` count the COMBINED sample: the initial
 * planTimestamps batch plus, when the boundary-miss retry fired,
 * FACE_QUORUM_RETRY_FRAMES extra timestamps. This is what Ad.basePlate.frames
 * / .faceHits persist, so production diagnostics see the actual vision-call
 * count (not first-pass-only). faceSamples is the same combined set.
 *
 * faceSamples: [{ atSec, face }] per sampled still (face may be null).
 * Coordinate space: face boxes are NORMALIZED FRACTIONS 0..1 of the
 * SOURCE frame (see DETECT_SYSTEM_PROMPT) — not pixel rects. Stills are
 * 640-wide for bandwidth; the model still returns fractions of the full
 * frame, so no pixel conversion is needed for keep-out mapping.
 */
async function detectClipBoxes(sourceUrl, durationSec, { campaignRunId = null, brandId = null, productId = null, adId = null, ...meta } = {}) {
  const frameOpts = { width: 640, isReel: true };
  const detectMeta = { campaignRunId, brandId, productId, adId, ...meta };
  const initialFrames = internals.buildFrameUrls(sourceUrl, durationSec, frameOpts);
  if (!initialFrames.length) {
    return { subject: null, head: null, frames: 0, faceHits: 0, envelope: null, faceSamples: [] };
  }

  const results = [];
  // Serial, deliberately: 3-4 frames, and vision RPS buckets are shared with the rest of the
  // pipeline. Latency (~2-6s total) is fine — this runs post-generation, pre-titling, not in any
  // interactive request path.
  for (const f of initialFrames) {
    results.push(await internals.detectFrameBoxes(f.url, detectMeta));
  }

  let frames = initialFrames;
  let frameBoxes = results.map((r) => r?.subject ?? null);
  let frameFaces = results.map((r) => r?.face ?? null);
  let head = consensusFaceBox(frameBoxes, frameFaces);
  const initialHits = frameFaces.filter(Boolean).length;

  // Boundary miss: exactly one sampled frame found a head, but quorum still
  // failed (detectedFrames > 1, so consensusFaceBox's single-detection
  // exception did not fire). Sample FACE_QUORUM_RETRY_FRAMES new timestamps
  // ONCE — no loop, no recursive retry. 0-hit (true headless) and already-
  // quorum (>=2) ads must not pay these extra vision calls.
  if (head === null && initialHits === 1) {
    const extra = internals.buildAdditionalFrameUrls(
      sourceUrl,
      durationSec,
      initialFrames.map((f) => f.timestampSec),
      { ...frameOpts, count: FACE_QUORUM_RETRY_FRAMES },
    );
    for (const f of extra) {
      results.push(await internals.detectFrameBoxes(f.url, detectMeta));
    }
    frames = initialFrames.concat(extra);
    frameBoxes = results.map((r) => r?.subject ?? null);
    frameFaces = results.map((r) => r?.face ?? null);
    head = consensusFaceBox(frameBoxes, frameFaces);
  }

  const subject = unionBoxes(frameBoxes);
  const envelope = unionBoxes(frameFaces);
  const faceSamples = frames.map((f, i) => ({
    atSec: f.timestampSec,
    face: frameFaces[i] || null,
  }));
  return {
    subject,
    head,
    frames: frames.length,
    faceHits: frameFaces.filter(Boolean).length,
    envelope,
    faceSamples,
  };
}

/** Measure DELIVERY-space dims: sharp.metadata() on a full-size first-frame still. */
async function measureDeliveryDims(sourceUrl) {
  try {
    const stillUrl = sourceUrl
      .replace(/\.(mp4|mov|webm|m4v|mkv)(\?|$)/i, '.jpg$2')
      .replace(/\/(video\/upload)\//, '/$1/so_0,f_jpg/');
    const res = await axios.get(stillUrl, { responseType: 'arraybuffer', timeout: 20_000, maxRedirects: 0 });
    const m = await sharp(Buffer.from(res.data)).metadata();
    if (!m.width || !m.height) return null;
    return { sourceW: m.width, sourceH: m.height };
  } catch (err) {
    console.warn(`   ⚠️  basePlateCrop: dims measurement failed (${err.message})`);
    return null;
  }
}

/**
 * The derived URL must be provably deliverable BEFORE it replaces the plate. A range-GET is the
 * honest probe: a HEAD can be answered from asset metadata without generating the derivative.
 * Anything but 200/206 (a 423 pending job, a 400 on the transform, a 404) -> not trusted.
 */
async function probeUrlLive(url) {
  try {
    const res = await axios.get(url, {
      headers: { Range: 'bytes=0-0' },
      timeout: 30_000,
      maxRedirects: 0,
      validateStatus: (s) => s === 200 || s === 206,
      responseType: 'arraybuffer',
    });
    return !!res;
  } catch {
    return false;
  }
}

// Mutable slot so harnesses can spy detectClipBoxes / cropCouldBeNeeded without
// proxyquire. resolveBasePlateVideoUrl and ensureFaceDetectionForKeepOut MUST
// call through this object (not the local bindings) or a stub of _internal is
// a no-op — verifyFaceKeepOut B2/B3 already stub this way.
const internals = {
  detectClipBoxes,
  detectFrameBoxes,
  measureDeliveryDims,
  probeUrlLive,
  cropCouldBeNeeded,
  buildFrameUrls,
  buildAdditionalFrameUrls,
};

// ── orchestrator ───────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the video URL titling should consume for this ad.
 * Returns { videoUrl, cropped, rect?, reason? } — videoUrl is ALWAYS safe to hand to Remotion:
 * either the probed cropped derivative or ad.veoVideoUrl unchanged.
 */
async function resolveBasePlateVideoUrl({ ad, format }) {
  const raw = { videoUrl: ad?.veoVideoUrl || null, cropped: false };
  try {
    if (!ENABLED()) return { ...raw, reason: 'disabled' };
    if (!ad?.veoVideoUrl) return { ...raw, reason: 'no-source' };

    // Cache: bound to the exact source video. A regenerated base MUST invalidate — a stale crop
    // ships footage the operator never approved.
    const cached = ad.basePlate;
    if (cached && cached.version === CURRENT_VERSION && cached.sourceUrl === ad.veoVideoUrl && cached.format === format) {
      if (cached.videoUrl) return { videoUrl: cached.videoUrl, cropped: true, rect: cached.rect };
      return { ...raw, reason: `cached-skip:${cached.reason}` };
    }

    // Cheap pure gates before any network I/O — a gated-out ad costs zero vision calls.
    const preGate = preGateBasePlateCrop({
      format, platformFormat: ad.platformFormat, sourceUrl: ad.veoVideoUrl,
    });
    if (preGate.action === 'skip') {
      await persistSkip(ad, format, preGate.reason);
      return { ...raw, reason: preGate.reason };
    }

    const dims = await internals.measureDeliveryDims(ad.veoVideoUrl);
    if (!dims) { await persistSkip(ad, format, 'dims-unmeasurable'); return { ...raw, reason: 'dims-unmeasurable' }; }

    // Full-frame / cheap skip: we already know no crop is possible (target
    // aspect equals the measured master, or another decideBasePlateCrop cheap
    // gate). Do NOT call detectClipBoxes here — that was the measured waste
    // (48 billed vision calls answering "no crop needed").
    //
    // Keep-out still needs faces. ensureFaceDetectionForKeepOut (same request,
    // brandScriptExecutor.js after this returns) will:
    //   - reuse Ad.basePlate.facesComputed if a sibling/master already paid
    //     (inherited plate, or a prior crop-needed pass on this source);
    //   - otherwise run detectClipBoxes ONCE and persist.
    // persistSkip below writes no face extras, so we cannot double-bill:
    // this function does not pay, keep-out pays at most once.
    if (!internals.cropCouldBeNeeded({
      format, platformFormat: ad.platformFormat, sourceUrl: ad.veoVideoUrl,
      sourceW: dims.sourceW, sourceH: dims.sourceH,
    })) {
      const cheap = decideBasePlateCrop({
        format, platformFormat: ad.platformFormat, sourceUrl: ad.veoVideoUrl,
        sourceW: dims.sourceW, sourceH: dims.sourceH,
        subject: null, head: null,
      });
      // Fail-open: cropCouldBeNeeded is decideBasePlateCrop(head=null).reason
      // === 'no-face-quorum'. If the two ever disagree (stub, future edit),
      // do NOT persist a face-dependent skip and drop through to vision.
      if (cheap.reason !== 'no-face-quorum') {
        await persistSkip(ad, format, cheap.reason);
        return { ...raw, reason: cheap.reason };
      }
    }

    const durationSec = Number(ad.videoDurationSec) > 0 ? Number(ad.videoDurationSec) : 8;
    const det = await internals.detectClipBoxes(ad.veoVideoUrl, durationSec, {
      brandId: ad.brandId, campaignId: ad.campaignId, adId: ad._id, mediaId: ad.mediaId,
      productId: ad.productId || null,
      campaignRunId: Array.isArray(ad.campaignRunIds) && ad.campaignRunIds.length
        ? ad.campaignRunIds[ad.campaignRunIds.length - 1]
        : null,
    });

    const decision = decideBasePlateCrop({
      format,
      platformFormat: ad.platformFormat,
      sourceUrl: ad.veoVideoUrl,
      sourceW: dims.sourceW, sourceH: dims.sourceH,
      subject: det.subject, head: det.head,
    });

    // Envelope diagnostic — measured, not guessed: a WIDE face envelope means one static crop
    // cannot be face-safe for this clip (multi-vignette), and centre is the safe fallback. Logged
    // per ad so "how often does this happen?" becomes a grep, not a debate.
    const env = det.envelope
      ? `${Math.round((det.envelope.right - det.envelope.left) * 100)}x${Math.round((det.envelope.bottom - det.envelope.top) * 100)}%`
      : 'none';
    console.log(
      `   🎯 basePlateCrop[ad=${ad._id}] format=${format} dims=${dims.sourceW}x${dims.sourceH} ` +
      `frames=${det.frames} faceHits=${det.faceHits} envelope=${env} -> ` +
      (decision.action === 'crop' ? `crop ${JSON.stringify(decision.rect)}` : `skip:${decision.reason}`)
    );

    // Detection already paid — always stash faceSamples/envelope so titling
    // keep-out can reuse them free of charge, even when the crop itself skips
    // (no-face-quorum, face-rejected, …). Full-frame never reaches here:
    // cropCouldBeNeeded short-circuited before this call.
    const faceExtras = detectionExtras(det, dims);

    if (decision.action !== 'crop') {
      await persistSkip(ad, format, decision.reason, faceExtras);
      return { ...raw, reason: decision.reason };
    }

    const url = buildVideoCropUrl({
      sourceUrl: ad.veoVideoUrl, rect: decision.rect, sourceW: dims.sourceW, sourceH: dims.sourceH,
    });
    if (!url) {
      await persistSkip(ad, format, 'url-build-refused', faceExtras);
      return { ...raw, reason: 'url-build-refused' };
    }
    if (url === ad.veoVideoUrl) {
      await persistSkip(ad, format, 'full-frame', faceExtras);
      return { ...raw, reason: 'full-frame' };
    }

    if (!(await internals.probeUrlLive(url))) {
      // Not persisted as a permanent skip: a cold-cache 423-ish failure may succeed on the next
      // render. Fall back for THIS render only. Face extras ride on a faces-only write so
      // keep-out can reuse them without locking the crop decision to "skip".
      await persistFaceExtrasOnly(ad, format, faceExtras);
      console.warn(`   ⚠️  basePlateCrop[ad=${ad._id}]: derived URL failed liveness probe — using raw plate this render`);
      return { ...raw, reason: 'probe-failed' };
    }

    const next = {
      version: CURRENT_VERSION,
      format,
      sourceUrl: ad.veoVideoUrl,
      videoUrl: url,
      rect: decision.rect,
      sourceW: dims.sourceW, sourceH: dims.sourceH,
      frames: det.frames, faceHits: det.faceHits, envelope: det.envelope,
      faceSamples: det.faceSamples || [],
      facesComputed: true,
      computedAt: new Date(),
    };
    await Ad.updateOne({ _id: ad._id }, {
      $set: { basePlate: next, updatedAt: new Date() },
    }).catch((err) => console.warn(`   ⚠️  basePlateCrop: persist failed (${err.message}) — crop still used this render`));
    ad.basePlate = next;

    return { videoUrl: url, cropped: true, rect: decision.rect };
  } catch (err) {
    console.warn(`   ⚠️  basePlateCrop[ad=${ad?._id}]: ${err.message} — using raw plate`);
    return { ...raw, reason: `error:${err.message?.slice(0, 80)}` };
  }
}

/** Fields stashed on Ad.basePlate so titling keep-out never re-pays vision. */
function detectionExtras(det, dims) {
  if (!det) return {};
  return {
    frames: det.frames,
    faceHits: det.faceHits,
    envelope: det.envelope || null,
    faceSamples: Array.isArray(det.faceSamples) ? det.faceSamples : [],
    facesComputed: true,
    sourceW: dims?.sourceW || null,
    sourceH: dims?.sourceH || null,
  };
}

/** Persist a skip so re-titles of the same base don't re-pay detection. */
async function persistSkip(ad, format, reason, extras = {}) {
  const next = {
    version: CURRENT_VERSION, format, sourceUrl: ad.veoVideoUrl,
    videoUrl: null, reason, computedAt: new Date(),
    ...extras,
  };
  await Ad.updateOne({ _id: ad._id }, {
    $set: { basePlate: next, updatedAt: new Date() },
  }).catch(() => {});
  // Keep the in-memory ad consistent so ensureFaceDetectionForKeepOut (same
  // request) reuses faceSamples without a second vision round-trip.
  if (ad) ad.basePlate = next;
  // Also surface on renderError so GET /api/ads/render-activity shows the
  // reason without a route change. Soft note — status is not flipped.
  noteRenderIssue(ad?._id, {
    message: `face-safe crop skipped: ${reason}`,
    stage: 'face-safe-crop'
  });
}

/**
 * Write face detection onto basePlate without forcing a crop skip.
 * Used when detection paid but the crop URL failed liveness — next render
 * must still be free to retry the crop.
 */
async function persistFaceExtrasOnly(ad, format, extras = {}) {
  if (!ad?._id || !extras.facesComputed) return;
  const prev = (ad.basePlate && ad.basePlate.sourceUrl === ad.veoVideoUrl) ? ad.basePlate : {};
  const next = {
    version: CURRENT_VERSION,
    format: prev.format || format,
    sourceUrl: ad.veoVideoUrl,
    videoUrl: prev.videoUrl ?? null,
    rect: prev.rect ?? null,
    reason: prev.reason,
    computedAt: new Date(),
    ...extras,
    sourceW: extras.sourceW || prev.sourceW || null,
    sourceH: extras.sourceH || prev.sourceH || null,
  };
  await Ad.updateOne({ _id: ad._id }, {
    $set: { basePlate: next, updatedAt: new Date() },
  }).catch(() => {});
  ad.basePlate = next;
}

/**
 * Face boxes for titling keep-out (plateHints band `avoid` flags).
 *
 * WHICH VISION CALLS REMAIN, AND WHY (2026-08-12 crop-order):
 *   resolveBasePlateVideoUrl no longer calls detectClipBoxes when
 *   cropCouldBeNeeded is false (full-frame 9:16→9:16, 16:9→16:9, …).
 *   That skip is the money fix. THIS function is the remaining caller:
 *   keep-out still needs face boxes even when no crop is needed, so a
 *   full-frame ad with no cached facesComputed still pays detectClipBoxes
 *   here — once. It is not paid twice: the crop path wrote no extras.
 *
 *   Crop-needed path: resolve pays detectClipBoxes, persist stamps
 *   facesComputed, and the cache branch below returns fromCache without
 *   a second submit.
 *
 * Cache key: veoVideoUrl + format + version (same binding as base-plate crop).
 * Reuses Ad.basePlate faceSamples/envelope when present for this source;
 * otherwise runs detectClipBoxes ONCE and persists (ledgered via chatCompletion).
 *
 * Returns null when disabled / no source / detection impossible — caller
 * leaves plateHints unchanged (pre-keep-out behaviour).
 *
 * @returns {Promise<null|{ faceSamples: Array, envelope, sourceW, sourceH, cropRect, fromCache: boolean }>}
 */
async function ensureFaceDetectionForKeepOut({ ad, format }) {
  if (!FACE_KEEPOUT_ENABLED()) return null;
  if (!ad?.veoVideoUrl) return null;

  const cached = ad.basePlate;
  // Reuse detection bound to this source video. Face boxes are in SOURCE
  // fraction space — independent of titling format — so any same-source
  // facesComputed entry is usable. cropRect only applies when THIS format's
  // crop is the plate Remotion will composite onto.
  if (
    cached
    && cached.version === CURRENT_VERSION
    && cached.sourceUrl === ad.veoVideoUrl
    && cached.facesComputed
  ) {
    return {
      faceSamples: faceSamplesFromCache(cached),
      envelope: cached.envelope || null,
      sourceW: cached.sourceW || null,
      sourceH: cached.sourceH || null,
      cropRect: (cached.format === format && cached.videoUrl && cached.rect) ? cached.rect : null,
      fromCache: true,
    };
  }

  // Older crop caches stored envelope without facesComputed / faceSamples —
  // still free to reuse (envelope covers all sample times, conservative).
  if (
    cached
    && cached.version === CURRENT_VERSION
    && cached.sourceUrl === ad.veoVideoUrl
    && cached.envelope
  ) {
    return {
      faceSamples: faceSamplesFromCache(cached),
      envelope: cached.envelope,
      sourceW: cached.sourceW || null,
      sourceH: cached.sourceH || null,
      cropRect: (cached.format === format && cached.videoUrl && cached.rect) ? cached.rect : null,
      fromCache: true,
    };
  }

  // Need a fresh detection. Frame stills require a Cloudinary /upload/ URL.
  if (!isTransformableVideoUrl(ad.veoVideoUrl)) {
    console.warn(`   ⚠️  faceKeepOut[ad=${ad._id}]: source not transformable — keep-out skipped`);
    return null;
  }

  try {
    const durationSec = Number(ad.videoDurationSec) > 0 ? Number(ad.videoDurationSec) : 8;
    const dims = await internals.measureDeliveryDims(ad.veoVideoUrl);
    const det = await internals.detectClipBoxes(ad.veoVideoUrl, durationSec, {
      brandId: ad.brandId, campaignId: ad.campaignId, adId: ad._id, mediaId: ad.mediaId,
      productId: ad.productId || null,
      campaignRunId: Array.isArray(ad.campaignRunIds) && ad.campaignRunIds.length
        ? ad.campaignRunIds[ad.campaignRunIds.length - 1]
        : null,
    });
    const extras = detectionExtras(det, dims);
    // Merge into existing basePlate when present (preserve crop videoUrl/rect/reason).
    const prev = (cached && cached.sourceUrl === ad.veoVideoUrl) ? cached : {};
    const next = {
      version: CURRENT_VERSION,
      format: prev.format || format,
      sourceUrl: ad.veoVideoUrl,
      videoUrl: prev.videoUrl ?? null,
      rect: prev.rect ?? null,
      reason: prev.reason ?? (prev.videoUrl ? undefined : 'faces-only'),
      computedAt: new Date(),
      ...extras,
      // Prefer measured dims; fall back to prior cache.
      sourceW: extras.sourceW || prev.sourceW || null,
      sourceH: extras.sourceH || prev.sourceH || null,
    };
    await Ad.updateOne({ _id: ad._id }, {
      $set: { basePlate: next, updatedAt: new Date() },
    }).catch((err) => console.warn(`   ⚠️  faceKeepOut: persist failed (${err.message})`));
    // Keep the in-memory ad object consistent for the rest of this render.
    if (ad.basePlate !== undefined) ad.basePlate = next;

    console.log(
      `   🎯 faceKeepOut[ad=${ad._id}] format=${format} frames=${det.frames} ` +
      `faceHits=${det.faceHits} (fresh detection)`
    );

    return {
      faceSamples: det.faceSamples || [],
      envelope: det.envelope || null,
      sourceW: next.sourceW,
      sourceH: next.sourceH,
      cropRect: (next.format === format && next.videoUrl && next.rect) ? next.rect : null,
      fromCache: false,
    };
  } catch (err) {
    console.warn(`   ⚠️  faceKeepOut[ad=${ad?._id}]: ${err.message} — keep-out skipped`);
    return null;
  }
}

/** Prefer per-frame faceSamples; fall back to a single envelope sample (atSec null → all times). */
function faceSamplesFromCache(cached) {
  if (Array.isArray(cached.faceSamples) && cached.faceSamples.length) return cached.faceSamples;
  if (cached.envelope) return [{ atSec: null, face: cached.envelope }];
  return [];
}

module.exports = {
  resolveBasePlateVideoUrl,
  ensureFaceDetectionForKeepOut,
  decideBasePlateCrop,       // pure — for the harness
  preGateBasePlateCrop,      // pure — for the harness
  cropCouldBeNeeded,         // pure — cheap skip before vision
  decideSplitPanelDrift,     // pure — PMax 16:9 split-stage post-render containment check
  SPLIT_PANEL_SIDES,         // for the harness
  DEFAULT_DRIFT_TOLERANCE_FRAC, // for the harness
  TARGET_BY_FORMAT,
  DETECT_SYSTEM_PROMPT,      // for the harness (headwear sentence asserted)
  FACE_KEEPOUT_ENABLED,      // for the harness
  _internal: Object.assign(internals, { parseBox, faceSamplesFromCache, detectionExtras }),
};
