'use strict';
/**
 * faceSafeCrop — PURE crop geometry for ad creative where the product sits BELOW the face.
 *
 * PORTED from reach-social-llm-expander src/lib/media.ts (the block under its
 * "PORTABLE SUBSYSTEM" banner, lines ~603-790). Names, signatures and rule ORDER are kept
 * identical on purpose so the two repos stay diffable — if you change a rule here, change it
 * there. Divergences from the expander are marked `DIVERGENCE:` and each one is deliberate.
 *
 * WHY THIS EXISTS HERE
 * A base video is rendered at the Omni family native aspect (9:16 for any portrait target) and
 * then has to reach a 4:5 or 1:1 canvas. Today that reduction happens in Remotion's
 * `BasePlate.jsx` via `objectFit: 'cover'` — a subject-blind CENTRE crop. 9:16 -> 4:5 discards
 * ~30% of the height and 9:16 -> 1:1 discards ~44%, so a head high in the frame gets cut. This
 * module computes where the window should actually go.
 *
 * WHAT THIS FILE IS NOT
 * No I/O. No ffmpeg, no Cloudinary, no vision calls, no Mongo. Every function is pure and
 * synchronous so scripts/verifyFaceSafeCrop.js can exercise it offline. Callers convert the
 * returned rect into whatever transform they need.
 *
 * @typedef {{ left: number, top: number, right: number, bottom: number }} SubjectBox
 *   Normalized fractions 0..1 of frame width/height. left/right horizontal, top/bottom vertical.
 * @typedef {'center'|'subject-fit'|'face-safe'|'face-crop'|'face-center'} CropAnchorY
 * @typedef {{ cx: number, cy: number, cw: number, ch: number, anchorY: CropAnchorY }} CropRect
 *   Pixel rect in the SOURCE frame's coordinate space. cx/cy are the top-left corner.
 */

/** Clamp `v` into [lo, hi]. */
const clampTo = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/**
 * A box we are willing to do arithmetic with, else null. Defensive because these boxes arrive
 * from a vision model, and every exported function here must be safe for ANY caller.
 */
function usableBox(b) {
  if (!b) return null;
  if (![b.left, b.top, b.right, b.bottom].every(Number.isFinite)) return null;
  if (b.right <= b.left || b.bottom <= b.top) return null;
  return b;
}

/**
 * How much clear space the HEAD must keep from the crop window's edges, as a fraction of the
 * window's own width/height. A head pressed against (or bleeding off) an edge reads as a mistake
 * even when technically "in frame".
 */
const FACE_MARGIN_FRAC = 0.06;

/**
 * DIVERGENCE from the expander: a SEPARATE, SMALLER top margin.
 *
 * Owner requirement — when a model is wearing the product (a shirt, a jacket), the garment is the
 * thing being sold and it sits BELOW the head, so the head should ride slightly higher than the
 * symmetric 6% would put it. Every pixel of headroom given back is a pixel of garment gained.
 *
 * Effect at a 1080-tall window: headroom 65px -> 38px, about 27px more garment. Deliberately
 * modest — the head still must not touch the edge. Env-tunable so it can be dialled against real
 * stills rather than argued about; values outside (0, FACE_MARGIN_FRAC] are ignored, because a
 * TOP margin larger than the all-edge margin would defeat the point, and <= 0 would let the head
 * touch or leave the frame.
 */
const FACE_TOP_MARGIN_FRAC = (() => {
  const n = Number(process.env.FACE_TOP_MARGIN_FRAC);
  return Number.isFinite(n) && n > 0 && n <= FACE_MARGIN_FRAC ? n : 0.035;
})();

/**
 * DIVERGENCE from the expander — product-first crown sacrifice (owner decision 2026-07-29):
 * "we are open to allowing the top of someone's head (forehead still visible) to be cropped, if
 * needed in order to best fit products."
 *
 * How much of the HEAD BOX's height may be cropped off its top, as a fraction of the box. The box
 * includes hair and headwear, so 0.3 sacrifices crown/hat territory while the brow line — roughly
 * the top third boundary of a real head box — stays in frame. 0 disables the behaviour entirely;
 * capped at 0.5 because past the box's midline the EYES go, and "forehead still visible" stops
 * being true.
 *
 * ONLY consulted when placeWithMargin's normal placement (marginTopY headroom + full marginY chin
 * clearance) FAILS — i.e. rule 4, head-plus-both-margins taller than the window. The normal
 * success path already places the window as low as the small top margin allows (maximum product
 * visible within a safe headroom); there is nothing for this allowance to improve there. It exists
 * only to give rule 4's fallback a better option than centring, which crops crown AND chin —
 * sacrificing crown only, up to this fraction, keeps the chin/torso (where the product is) intact.
 */
const FACE_TOP_CROP_ALLOWANCE_FRAC = (() => {
  const n = Number(process.env.FACE_TOP_CROP_ALLOWANCE_FRAC);
  return Number.isFinite(n) && n >= 0 && n <= 0.5 ? n : 0.3;
})();

/**
 * Place a window of length `win` along one axis so `[lo,hi]` (the head, in px) keeps `marginLo`
 * clear of the leading edge and `marginHi` clear of the trailing edge, staying as close to
 * `desired` as possible and inside `[0, span-win]`.
 *
 * Returns null when the head + its margins simply cannot fit — the caller then centres on the head.
 *
 * DIVERGENCE from the expander: margins are ASYMMETRIC (it took one `margin`). That is what lets
 * the vertical axis hold a small top margin and a full bottom margin at the same time. Passing the
 * same value twice reproduces the expander's behaviour exactly.
 */
function placeWithMargin(desired, win, span, lo, hi, marginLo, marginHi) {
  // Window start must be <= (lo - marginLo) to clear the leading edge, and >= (hi + marginHi - win)
  // to clear the trailing edge. An empty interval means the head cannot be held off both edges at
  // this window size.
  const maxStart = lo - marginLo;
  const minStart = hi + marginHi - win;
  if (minStart > maxStart) return null;
  // Round LAST: lo/hi are fractional (box fraction x pixel span), so clamping to them reintroduces
  // fractions even when `desired` was already an integer — and a fractional crop offset is not a
  // valid crop argument for ffmpeg OR Cloudinary.
  return Math.round(clampTo(clampTo(desired, minStart, maxStart), 0, span - win));
}

/**
 * A head box may not cover more than this fraction of the subject box's area.
 *
 * NOTE ON HEADWEAR: the detection prompt asks for the whole head INCLUDING hair, chin and any
 * hat/cap/hood, because the geometry uses the box's TOP edge as the thing to hold off the frame
 * edge — a hat outside the box gets cropped off. That makes the box bigger, so the obvious worry is
 * that a hat trips this guard, which would fall back to `centerOnBox` and DISCARD the top bias.
 *
 * MEASURED, so the guard could stay tight (kept at the expander's 0.6 rather than loosened):
 *   full-body model, bare head    0.091
 *   full-body model, wide hat     0.209
 *   head+torso, wide hat          0.363
 *   head+shoulders, wide hat      0.528   <- the most head-dominant realistic case
 *   mis-parse (head == subject)   1.000   <- what this guard exists to reject
 * Even the worst realistic hatted framing sits well clear of 0.6, so headwear does not justify
 * weakening the guard. Asserted by scripts/verifyFaceSafeCrop.js section H.
 */
const FACE_MAX_SUBJECT_AREA_FRAC = 0.6;

/**
 * The head box we are willing to do GEOMETRY with, else null (caller treats the frame as headless).
 *
 * The head's coordinates drive the anchor, so a mis-parsed box can mis-frame the crop. These three
 * cheap checks reject the mis-parses that would actually move the window:
 *   1. not a usable box (non-finite / inverted) — nothing to trust;
 *   2. the head's CENTRE falls outside the subject box — the two detections contradict each other,
 *      so at least one is wrong; the subject box is the one the crop cannot do without, so the head
 *      loses;
 *   3. the head covers more than FACE_MAX_SUBJECT_AREA_FRAC of the subject's area — a head that
 *      nearly IS the whole "all important content" box is a mis-parse, and trusting it would drag
 *      the window to the subject's top: the exact beheading this rule set exists to prevent.
 *
 * Deliberately conservative: rejection costs only the face-safe bias (we fall back to centre of
 * gravity, safe for any content), while a false ACCEPT can cut a head off.
 */
function plausibleFace(faceIn, subjectIn) {
  const face = usableBox(faceIn);
  if (!face) return null;
  const subject = usableBox(subjectIn);
  if (!subject) return face; // nothing to cross-check against — the head is all the geometry has
  const fcx = (face.left + face.right) / 2;
  const fcy = (face.top + face.bottom) / 2;
  if (fcx < subject.left || fcx > subject.right || fcy < subject.top || fcy > subject.bottom) return null;
  const faceArea = (face.right - face.left) * (face.bottom - face.top);
  const subjectArea = (subject.right - subject.left) * (subject.bottom - subject.top);
  if (faceArea > FACE_MAX_SUBJECT_AREA_FRAC * subjectArea) return null;
  return face;
}

/**
 * Largest integer multiple of (wr:hr) that fits inside sw x sh, as { cw, ch }, or null.
 *
 * The even-k adjustment keeps output dimensions even. Cloudinary tolerates odd dimensions, but the
 * cropped video is re-encoded downstream by Remotion to H.264 yuv420p, which requires even width
 * and height — so this stays even even though the immediate consumer would not care. Kept
 * byte-identical to the expander for diffability.
 */
function windowFor(sw, sh, wr, hr) {
  let k = Math.min(Math.floor(sw / wr), Math.floor(sh / hr));
  if ((wr % 2 || hr % 2) && k % 2) k -= 1;
  if (k < 1) return null;
  return { cw: k * wr, ch: k * hr };
}

/**
 * Centre the wr:hr window on `box`'s centre of gravity (or the frame centre when there is no usable
 * box), clamped to source bounds.
 *
 * This is what the face path uses when NO head was detected: with no head at stake there is no
 * reason to bias toward the top, and top-anchoring a headless product (a pair of shorts, a hanging
 * coat) just lops off its bottom. Centring splits any overflow evenly instead, keeping the middle
 * of the product.
 *
 * Owner decision, 2026-07-27: "if you can't find a face it's unlikely to be important, let's just
 * go from the centre of gravity in that case." Measured in the expander: top-anchoring a tall
 * hanging coat cut 603px off its bottom; centring splits the loss 285/286px.
 */
function centerOnBox(sw, sh, wr, hr, boxIn) {
  // Reject a degenerate frame/ratio HERE, not downstream: NaN/0 would otherwise propagate into
  // every field and reach a crop transform as NaN.
  if (![sw, sh, wr, hr].every(Number.isFinite) || sw < 1 || sh < 1 || wr < 1 || hr < 1) return null;
  const win = windowFor(sw, sh, wr, hr);
  if (!win) return null;
  const { cw, ch } = win;
  const box = usableBox(boxIn);
  const scx = box ? ((box.left + box.right) / 2) * sw : sw / 2;
  const scy = box ? ((box.top + box.bottom) / 2) * sh : sh / 2;
  return {
    cx: clampTo(Math.round(scx - cw / 2), 0, sw - cw),
    cy: clampTo(Math.round(scy - ch / 2), 0, sh - ch),
    cw,
    ch,
    anchorY: 'center',
  };
}

/**
 * The ONE rect function every crop path calls.
 *
 * `subject` is the box around ALL important content (people, products AND TEXT). That is why the
 * head must be passed as a BOX, not a presence boolean: a headline, a logo or a raised arm above
 * the head pushes `subject.top` to the frame top, and anchoring the window to the SUBJECT top then
 * cuts the face off entirely (1080x1920 -> 1:1, subject spanning the frame, head at y1152-1440: a
 * subject-top anchor delivers y0-1080 and loses the whole head). Only the head's own coordinates
 * can keep it in frame.
 *
 * Rules, in order:
 *   1. No usable/plausible head -> `centerOnBox`: centre of gravity. Nothing here may re-introduce
 *      a top-anchor for headless products.
 *   2. The whole subject fits the window vertically -> centre on the SUBJECT ('subject-fit'):
 *      nothing is being lost, so nothing should be moved.
 *   3. Otherwise -> head high in the window, its top one TOP margin down, so the window runs
 *      DOWNWARD over the torso, which is where the garment being advertised is ('face-safe').
 *   4. Head + margins taller than the window -> centre on the HEAD ('face-center'), accepting the
 *      tight fit.
 *
 * In every head case the head is forced to keep its margins clear of all four window edges wherever
 * that is geometrically possible (`placeWithMargin`) — FACE_TOP_MARGIN_FRAC above,
 * FACE_MARGIN_FRAC on the other three.
 *
 * @param {number} sw source frame width in px
 * @param {number} sh source frame height in px
 * @param {number} wr target aspect width term (e.g. 4 for 4:5)
 * @param {number} hr target aspect height term (e.g. 5 for 4:5)
 * @param {SubjectBox|null} subjectIn all-important-content box, normalized
 * @param {SubjectBox|null} faceIn head box (incl. headwear), normalized
 * @returns {CropRect|null} null when the frame/ratio is degenerate
 */
function computeGravityCropRect(sw, sh, wr, hr, subjectIn, faceIn) {
  // Reject a degenerate frame/ratio before any arithmetic — (1080,1920,0,0) would otherwise return
  // an all-NaN rect that reaches a crop transform.
  if (![sw, sh, wr, hr].every(Number.isFinite) || sw < 1 || sh < 1 || wr < 1 || hr < 1) return null;

  const face = plausibleFace(faceIn, subjectIn);
  // Rule 1 — no head we can trust -> centre of gravity, never a top-anchor (see centerOnBox).
  if (!face) return centerOnBox(sw, sh, wr, hr, subjectIn);

  const win = windowFor(sw, sh, wr, hr);
  if (!win) return null;
  const { cw, ch } = win;

  const subject = usableBox(subjectIn);
  const marginX    = Math.round(FACE_MARGIN_FRAC * cw);
  const marginY    = Math.round(FACE_MARGIN_FRAC * ch);
  const marginTopY = Math.round(FACE_TOP_MARGIN_FRAC * ch);
  const faceL = face.left * sw;
  const faceR = face.right * sw;
  const faceT = face.top * sh;
  const faceB = face.bottom * sh;

  // Rule 2 vs 3: does the whole subject fit vertically? (No subject => treat as "doesn't fit" and
  // lead with the head, which is the safer assumption for a person-led ad.)
  const subjectFits = !!subject && (subject.bottom - subject.top) * sh <= ch;
  let anchorY;
  let desiredY;
  if (subjectFits && subject) {
    desiredY = ((subject.top + subject.bottom) / 2) * sh - ch / 2;
    anchorY = 'subject-fit';
  } else {
    // Head high in frame -> maximum product visible beneath it. Uses the SMALL top margin.
    desiredY = faceT - marginTopY;
    anchorY = 'face-safe';
  }

  // Vertical: small clearance above the head, full clearance below it. This already places the
  // window as far down (as much product visible) as the small top margin allows — there is
  // nothing to "improve" on the success path; the allowance below exists ONLY for when this fails.
  let cy = placeWithMargin(Math.round(desiredY), ch, sh, faceT, faceB, marginTopY, marginY);

  if (cy === null) {
    // Rule 4 — head + BOTH margins is taller than the window. The plain fallback centres on the
    // head, which crops crown AND chin. Owner decision 2026-07-29: sacrifice the CROWN ONLY, and
    // only by the MINIMUM pixels needed to fit the full chin margin (never the full allowance just
    // because rule 4 fired) — up to FACE_TOP_CROP_ALLOWANCE_FRAC of the head's height ("forehead
    // still visible"). Chin/torso carries the product context, so it keeps its full margin as long
    // as the deficit fits within the allowance; only a deficit bigger than the allowance falls back
    // to centring.
    const headHeight = faceB - faceT;
    const required = Math.max(0, headHeight + marginY - ch);
    const allowPx = FACE_TOP_CROP_ALLOWANCE_FRAC * headHeight;
    if (required <= allowPx) {
      const lo = faceT + required;
      cy = placeWithMargin(Math.round(lo), ch, sh, lo, faceB, 0, marginY);
      if (cy !== null) anchorY = required > 0 ? 'face-crop' : 'face-safe';
    }
    if (cy === null) {
      cy = clampTo(Math.round((faceT + faceB) / 2 - ch / 2), 0, sh - ch);
      anchorY = 'face-center';
    }
  }

  // Horizontal: prefer the subject's centre (keeps the composition), but never at the cost of the
  // head's side margins. No horizontal equivalent of the head-high rule — there is no product
  // "beside". Symmetric margins here.
  const desiredX = subject
    ? ((subject.left + subject.right) / 2) * sw - cw / 2
    : (faceL + faceR) / 2 - cw / 2;
  const cx =
    placeWithMargin(Math.round(desiredX), cw, sw, faceL, faceR, marginX, marginX) ??
    clampTo(Math.round((faceL + faceR) / 2 - cw / 2), 0, sw - cw);

  return { cx, cy, cw, ch, anchorY };
}

/** Smallest box containing every non-null box, or null when there are none. */
function unionBoxes(boxes) {
  const hit = (boxes || []).filter((b) => usableBox(b) !== null);
  if (!hit.length) return null;
  return {
    left:   Math.min(...hit.map((b) => b.left)),
    top:    Math.min(...hit.map((b) => b.top)),
    right:  Math.max(...hit.map((b) => b.right)),
    bottom: Math.max(...hit.map((b) => b.bottom)),
  };
}

/** How many sampled frames must independently report a head before its box is trusted. */
const FACE_MIN_FRAMES = 2;

/**
 * Union of the per-frame head boxes — but only once ENOUGH frames agree a head is there.
 *
 * WHY A QUORUM: a single hallucinated head box flips a headless product into face mode, and face
 * mode MOVES the window. Measured in the expander on a hanging-coat clip at 1:1, one spurious head
 * cost 796px off the bottom of the garment. Vision noise is essentially uncorrelated across frames
 * while a real person is not, so requiring the head in >= FACE_MIN_FRAMES sampled frames removes
 * the one-frame hallucination without weakening a genuine person clip (a head missed in 2 of 5
 * frames still passes).
 *
 * EXCEPTION: when only ONE frame produced any detection at all, there is no second frame that
 * COULD confirm — demanding two would mean "never a head" for those clips, which is worse. One is
 * enough there.
 *
 * Only frames that actually found a head contribute to the union (a null frame must not drag the
 * box), matching how unionBoxes treats the subject.
 */
function consensusFaceBox(frameBoxes, frameFaces) {
  const faces = frameFaces || [];
  const boxes = frameBoxes || [];
  const faceHits = faces.filter((f) => f != null).length;
  if (faceHits === 0) return null;
  // A frame "produced a detection" if it yielded either box. `?? null` so a shorter frameFaces
  // array can never read `undefined` as "a head was found here".
  const detectedFrames = boxes.filter((b, i) => b != null || (faces[i] ?? null) != null).length;
  if (faceHits < FACE_MIN_FRAMES && detectedFrames > 1) return null;
  return unionBoxes(faces);
}

/**
 * Evenly-spaced sample count for a clip: ~1 frame per 2s, clamped 3-8.
 * Shared by frame sampling and head detection so both see the same coverage.
 */
function filmstripFrameCount(durationSec) {
  const dur = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 4;
  return Math.min(8, Math.max(3, Math.round(dur / 2)));
}

/**
 * Parse an aspect string ("4:5", "9:16", "1:1") into { wr, hr }, or null.
 * Rejects zero/negative/non-finite terms so a bad platformFormat cannot reach the geometry.
 */
function parseAspect(aspect) {
  const m = /^\s*([\d.]+)\s*:\s*([\d.]+)\s*$/.exec(String(aspect || ''));
  if (!m) return null;
  const wr = Number(m[1]);
  const hr = Number(m[2]);
  if (![wr, hr].every(Number.isFinite) || wr <= 0 || hr <= 0) return null;
  return { wr, hr };
}

module.exports = {
  // geometry
  computeGravityCropRect,
  centerOnBox,
  windowFor,
  parseAspect,
  // multi-frame reconciliation
  unionBoxes,
  consensusFaceBox,
  filmstripFrameCount,
  // exported for the harness — not for callers. Reaching past computeGravityCropRect
  // bypasses the face-safe rules, which is the whole point of the module.
  _internal: { usableBox, clampTo, placeWithMargin, plausibleFace },
  // constants
  FACE_MARGIN_FRAC,
  FACE_TOP_MARGIN_FRAC,
  FACE_TOP_CROP_ALLOWANCE_FRAC,
  FACE_MAX_SUBJECT_AREA_FRAC,
  FACE_MIN_FRAMES,
};
