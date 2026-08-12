'use strict';
/**
 * INTENT SPECS v2 — say what the ad must ACHIEVE, hand composition to the model.
 *
 * v1 failed for a specific reason worth writing down: the owner's brief gave an
 * information HIERARCHY ("social proof highest priority"), and I translated that
 * into fixed POSITIONS ("rating upper third, quote on a lower-third panel").
 * When a product had no quote, the element vanished but the position line stayed
 * — an empty slot plus "make the proof loudest", so the model wrote its own
 * testimonial. Positions I invented caused a fabricated customer review.
 *
 * v2 therefore carries only:
 *   GOAL         — what a scrolling stranger must take away
 *   EMPHASIS     — priority order, never coordinates
 *   TEXT         — verbatim strings, each rendered exactly once
 *   LATITUDE     — an explicit hand-off of composition and typography
 *   ABSENT       — what does not exist, stated so it cannot be invented
 *   GEOMETRY     — computed safe box (see computeSurface / geometryBlock)
 *
 * Note the asymmetry: latitude is broad, but the verbatim strings and the
 * absences are absolute. The model gets to art-direct; it does not get to write
 * copy or invent proof.
 *
 * Spec text is hand-written; the safe-box arithmetic is computed from the real
 * services/platformFormats.js table, never from prose.
 *
 * ── SAFE ZONES (merged from safezones prototype) ──────────────────────────
 *
 * There are THREE independent things that eat the frame, and hand-written
 * per-surface paragraphs conflated them:
 *
 *   1. CROP LOSS (hard geometry). gpt-image-2/edit only generates 1024x1024,
 *      1024x1536 or 1536x1024. Every other delivery aspect is produced by
 *      cropping one of those, so part of the GENERATED frame is destroyed
 *      before anyone sees it. Deterministic arithmetic.
 *
 *   2. PLATFORM UI RESERVE (hard fact, from services/platformFormats.js).
 *      Reels reserves 204/1778 top and bottom; Stories 250/1778. Expressed
 *      against the DELIVERED canvas, so it must be mapped back into generated
 *      coordinates before it means anything to the image model.
 *
 *   3. EDGE MARGIN (convention, ours). Not a platform fact. Kept separate and
 *      labelled so it is never mistaken for one.
 *
 * Output is the text-safe box in GENERATED-frame percentages, because that is
 * the only coordinate space the image model can act on.
 *
 * KNOWN DATA GAP: platformFormats.safeArea has only {top,bottom} — there is no
 * left/right field, so a horizontal platform reserve cannot be expressed today.
 * For 9:16 the horizontal loss below comes from crop arithmetic alone. If Meta
 * reserves side regions (or YouTube overlays the lower band on pmax), that fact
 * has nowhere to live in the current schema.
 */

const pf = require('./platformFormats');

// ── generation sizes + surface geometry ─────────────────────────────────
// gpt-image-2/edit size contract: the SCHEMA is operative (the model README is
// stale and still lists only three sizes). The schema enum has fourteen WxH
// values, and for gpt-image-2 the description further allows arbitrary
// WIDTHxHEIGHT strings where both dims are divisible by 16, aspect is between
// 1:3 and 3:1, and max is 3840x2160.
//
// That arbitrary-size clause is spliced from OpenAI's own docs and carries an
// unpublished "must also satisfy the model's current pixel and edge limits", so
// it was NOT taken on trust — the failure mode we feared was a silent coercion
// to the 1024x1024 default, which would hand a SQUARE frame to a 4:5 surface and
// then centre-crop it. It was PROBED instead, one billable submit, 2026-08-03:
// size=1088x1360 returned exactly 1088x1360 (aspect 0.800000), prediction
// 65d1931505bc4620bcf0d7efcdd7aff9. So the gateway does honour arbitrary
// div-16 sizes on this model.
//
// RULE ANYWAY: a size goes in this table only if it is an enum member OR has
// been probed live, and scripts/verifyStaticSafeBox.js S4 enforces exactly that
// with the probe evidence recorded alongside. Do not add a size on the strength
// of the schema prose alone.
//
// We keep a SMALL curated table rather than the whole enum: every extra entry
// can change least-crop selection for some aspect, and every call is billable.
// Adding a size is a cost and geometry decision, not free.
//
// PREVIOUS WRONG TABLE: only the three legacy sizes, above the comment "The
// only sizes the edit endpoint accepts. Verified live, not assumed." — false for
// this model. It forced every 9:16 surface onto 1024x1536 and then centre-cropped
// 80px off EACH SIDE, straight through the typeset CTA and edge copy the model
// had just painted. platformFormats.js:394-403 already explains why
// META_STATIC_FANOUT cannot crop one master into three aspects (copy is baked
// into the pixels by the model); the identical hazard was still happening INSIDE
// each individual generation. 1152x2048 is on the schema enum, is exactly 9:16,
// and is proven live on this account (a real submit returned exactly 1152x2048).
//
// ORDER IS LOAD-BEARING. chooseGenSize keeps the first entry on a loss tie
// (`loss < best.loss`, strict — not `<=`), so the legacy sizes stay ahead of any
// later equal-loss entry. Do not reorder casually.
//
// 2048x1152 is the schema-enum exact 16:9 (see scripts/verifyStaticSafeBox.js).
// Placed after the three legacy sizes and beside its 9:16 twin so no equal-loss
// tie flips an existing surface: 1:1 / 4:5 / 9:16 still win on strict lower loss
// at their exact sizes. Only true landscape targets (pmax_16_9, pmax_landscape_*)
// switch from 1536x1024 (3:2, 15.6% crop) to zero-crop 16:9 — intended.
const GEN_SIZES = [
  { w: 1024, h: 1024 },
  { w: 1024, h: 1536 },
  { w: 1536, h: 1024 },
  { w: 1152, h: 2048 }, // enum member, exact 9:16; absent before → 15.6% side crop
  { w: 2048, h: 1152 }, // enum member, exact 16:9; absent before → 15.6% T/B crop on landscape
  { w: 1088, h: 1360 }  // PROBED non-enum, exact 4:5; absent before → 16.7% top/bottom crop
];

const EDGE_MARGIN_PCT = 6; // convention, ours — not a platform reserve

// Per-surface edge-margin override (percent of kept short side). Absent key →
// EDGE_MARGIN_PCT. Only the three Phase A PMax statics use 10%; every other
// surface (incl. frozen pmax_16_9) stays at 6 so existing geometry is
// byte-identical.
const SURFACE_EDGE_MARGIN_PCT = {
  pmax_landscape_1_91_1: 10,
  pmax_square_1_1:       10,
  pmax_portrait_4_5:     10
};

/** Pick the generation size needing the least crop to reach a target aspect. */
function chooseGenSize(targetAspect) {
  let best = null;
  for (const s of GEN_SIZES) {
    const genAspect = s.w / s.h;
    // crop height if generated is taller (aspect too small), else crop width
    let cropW = 0, cropH = 0;
    if (genAspect < targetAspect) {
      const keepH = Math.round(s.w / targetAspect);
      cropH = s.h - keepH;
    } else if (genAspect > targetAspect) {
      const keepW = Math.round(s.h * targetAspect);
      cropW = s.w - keepW;
    }
    const loss = (cropW * s.h + cropH * s.w) / (s.w * s.h);
    if (!best || loss < best.loss) best = { ...s, cropW, cropH, loss, genAspect };
  }
  return best;
}

function aspectOf(key) {
  const a = pf.aspectRatioForPlatformFormat(key); // e.g. "9:16"
  const [w, h] = String(a).split(':').map(Number);
  return { str: a, value: w / h };
}

/**
 * Percent of `total`, rounded INWARD toward the frame centre — ceil for a
 * low edge (left/top), floor for a high edge (right/bottom).
 *
 * The previous `+((v / total) * 100).toFixed(1)` rounded HALF-UP in both
 * directions, and because `right` is structurally `100 - left` the pair always
 * rounded the SAME way — so it was coupled, not coincidental. On a crop
 * boundary it rounded OUTWARD, into the band the geometry prose had just told
 * the model would be destroyed: 8.3% of 1536 is 127.488px against a cut line at
 * exactly 128, and 7.8% of 1024 is 79.872px against a cut at 80. Sub-pixel, but
 * it meant the emitted box was provably not inside the region it described.
 *
 * Works in tenths-of-a-percent integers so the guard is exact. The 1e-9 nudge
 * absorbs pure float dust on values that are mathematically whole tenths —
 * 69.12/1152 is exactly 6%, yet in IEEE754 it lands at 60.000000000000014
 * tenths, and a naive ceil would report 6.1% and quietly tighten the box.
 */
function pctInward(v, total, side) {
  const tenths = (v / total) * 1000;
  return side === 'lo'
    ? Math.ceil(tenths - 1e-9) / 10
    : Math.floor(tenths + 1e-9) / 10;
}

function computeSurface(key) {
  const aspect = aspectOf(key);
  const canvas = pf.canvasForPlatformFormat(key);
  const safe = pf.safeAreaForPlatformFormat(key) || {};
  const gen = chooseGenSize(aspect.value);

  // Delivered region inside the generated frame, after crop.
  const keptW = gen.w - gen.cropW;
  const keptH = gen.h - gen.cropH;
  const cropLeftPx = gen.cropW / 2;
  const cropTopPx = gen.cropH / 2;

  // Platform reserve is declared against the delivered canvas height.
  // Map it into generated pixels via the kept region.
  const topReserveFrac = (safe.top || 0) / canvas.height;
  const botReserveFrac = (safe.bottom || 0) / canvas.height;
  const topReservePx = topReserveFrac * keptH;
  const botReservePx = botReserveFrac * keptH;

  // Text-safe box in generated pixels.
  //
  // PREVIOUS WRONG VERSION — the margin was applied as
  //   x0 = Math.max(cropLeftPx, marginPx)
  //   y0 = Math.max(cropTopPx + topReservePx, marginPx)
  // measured from the GENERATED origin. That treats the crop band and our edge
  // margin as ALTERNATIVES when they are ADDITIVE. marginPx was 61.44px on every
  // live surface and the crop band was always larger — 128px on 4:5, 80px on the
  // old 9:16 — so `Math.max` discarded the margin entirely and the safe box
  // edges BECAME the crop lines. The live path emitted, verbatim: "The top and
  // bottom 128px of what you generate WILL BE CUT AWAY and never seen. EVERY
  // element ... must sit inside the box from 6% to 94% of width and 8.3% to
  // 91.7% of height" — and 8.3% of 1536 is 127.5px. The model was told text may
  // sit flush against pixels the same paragraph called destroyed. Only 1:1
  // escaped, because its crop is zero.
  //
  // The proof this was real in DELIVERED pixels needs no model compliance and no
  // billable call: the logomark is composited by us from this same box
  // (directImageRenderService.logoPlacementFor). Measured before the fix, the
  // clamped box's right edge equalled the frame width on Stories and its bottom
  // edge equalled the frame height on 4:5, so the brand's logomark shipped FLUSH
  // to the delivered edge — 0px gap, for any logo size. That is the same defect
  // class the logo-placement docstring in directImageRenderService claims to
  // have fixed, arrived at by different arithmetic.
  //
  // A quieter twin of the same conflation, also fixed here: marginPx was based
  // on Math.min(gen.w, gen.h) — the GENERATED short side, which includes pixels
  // that are about to be destroyed and never seen. It is now based on the KEPT
  // short side, i.e. the canvas that actually exists by the time anyone looks at
  // the ad. Note the second-order effect: on a heavily cropped landscape frame
  // this makes the absolute margin SMALLER (pmax 16:9 goes 61.44 → 51.84) even
  // as its vertical margin goes from zero to real. That is correct under the
  // "margin against the canvas that will be seen" rule, not a free tightening.
  //
  // With 1152x2048 and 1088x1360 in the table, EVERY live static surface now
  // generates at its exact delivery aspect, so cropPx is all-zero and this
  // arithmetic reduces to reserve + margin. The crop terms are kept rather than
  // deleted because they are still load-bearing for the frozen 16:9 surface, and
  // because extractFor remains the defence against a model that returns an
  // off-size frame. A future surface with an awkward aspect will crop again.
  const hasOverride = Object.prototype.hasOwnProperty.call(SURFACE_EDGE_MARGIN_PCT, key);
  const marginPct = hasOverride ? SURFACE_EDGE_MARGIN_PCT[key] : EDGE_MARGIN_PCT;

  // Short-side margin gives a visually uniform border, which is the right
  // typographic default and is what every Meta surface has always used. It is
  // the WRONG rule for Google, whose requirement is stated per axis: keep
  // everything inside the central 80% of EACH dimension, because responsive
  // placements crop the outer band of either edge independently.
  //
  // On a wide canvas the two rules diverge badly. At 1200x628, a 10% short-side
  // margin is 62.8px — 10% of the height but only 5.2% of the width, so the box
  // came out x 5..95 and the model (correctly obeying it) typeset the quote and
  // CTA into the band Google is most likely to crop. Measured on a real render:
  // ink began at x=60px against a box edge of 62.8px. The model was right; the
  // box was wrong. 4:5 had the mirror-image problem on its vertical axis (y 8..92).
  //
  // So: per-axis for the surfaces that carry an explicit override (the PMax
  // statics), short-side for everyone else. Meta keeps byte-identical geometry —
  // no Meta surface has an override, so it cannot reach this branch.
  const marginX = hasOverride ? (marginPct / 100) * keptW : (marginPct / 100) * Math.min(keptW, keptH);
  const marginY = hasOverride ? (marginPct / 100) * keptH : (marginPct / 100) * Math.min(keptW, keptH);

  let x0 = cropLeftPx + marginX;
  let x1 = cropLeftPx + keptW - marginX;
  let y0 = cropTopPx + topReservePx + marginY;
  let y1 = cropTopPx + keptH - botReservePx - marginY;

  // Degenerate guard. A tiny kept region, or a platform reserve larger than the
  // kept band, can invert the box once the margin is applied. Drop the margin
  // rather than emit left > right: a zero-margin box is still geometrically
  // honest, an inverted one is nonsense the model would have to guess at. Do not
  // "fix" this by collapsing to the midpoint — that pins every element onto a
  // single pixel row.
  if (x0 >= x1) {
    x0 = cropLeftPx;
    x1 = cropLeftPx + keptW;
  }
  if (y0 >= y1) {
    y0 = cropTopPx + topReservePx;
    y1 = cropTopPx + keptH - botReservePx;
    // The reserve alone can still invert it (a reserve taller than the kept
    // band). Fall all the way back to the full kept band.
    if (y0 >= y1) {
      y0 = cropTopPx;
      y1 = cropTopPx + keptH;
    }
  }

  // Safety net — never emit a coordinate outside the generated frame.
  x0 = Math.max(0, Math.min(x0, gen.w));
  x1 = Math.max(0, Math.min(x1, gen.w));
  y0 = Math.max(0, Math.min(y0, gen.h));
  y1 = Math.max(0, Math.min(y1, gen.h));

  // The clamp itself can collapse a NON-inverted pair: if x0 and x1 both sit on
  // the same side of [0, gen.w] — both negative, or both past the edge — they map
  // to the same boundary and the box becomes zero-width. The guards above only
  // catch x0 >= x1 BEFORE clamping, so they cannot see this. Unreachable from
  // today's centred-crop arithmetic (every coordinate is already in range), but
  // "the guards above prevent a degenerate box" would otherwise be a claim the
  // code does not actually make. A zero-width box tells the model to put every
  // element on one pixel column, which is worse than no constraint at all.
  if (x0 >= x1) { x0 = 0; x1 = gen.w; }
  if (y0 >= y1) { y0 = 0; y1 = gen.h; }

  return {
    key,
    label: pf.PLATFORM_FORMATS[key].label,
    aspect: aspect.str,
    generate: `${gen.w}x${gen.h}`,
    deliver: `${pf.PLATFORM_FORMATS[key].deliveryDims.width}x${pf.PLATFORM_FORMATS[key].deliveryDims.height}`,
    cropPx: { left: cropLeftPx, right: cropLeftPx, top: cropTopPx, bottom: cropTopPx },
    platformReservePx: { top: Math.round(topReservePx), bottom: Math.round(botReservePx) },
    platformReserveDeclared: { top: safe.top || 0, bottom: safe.bottom || 0, left: safe.left ?? null, right: safe.right ?? null },
    box: {
      left:   pctInward(x0, gen.w, 'lo'),
      right:  pctInward(x1, gen.w, 'hi'),
      top:    pctInward(y0, gen.h, 'lo'),
      bottom: pctInward(y1, gen.h, 'hi')
    },
    lossPct: +(gen.loss * 100).toFixed(1)
  };
}

/**
 * The geometry block handed to the image model. States the destroyed regions and
 * the reserve as ONE box, and says nothing about which element goes where.
 */
function geometryBlock(s) {
  const lines = [];
  lines.push(`FORMAT: ${s.aspect} (${s.label}). Generate at ${s.generate}; delivered at ${s.deliver}.`);
  if (s.cropPx.top || s.cropPx.left) {
    const parts = [];
    if (s.cropPx.top) parts.push(`the top and bottom ${Math.round(s.cropPx.top)}px`);
    if (s.cropPx.left) parts.push(`the left and right ${Math.round(s.cropPx.left)}px`);
    const s0 = parts.join(' and ');
    lines.push(`${s0.charAt(0).toUpperCase()}${s0.slice(1)} of what you generate WILL BE CUT AWAY and never seen.`);
  }
  if (s.platformReservePx.top || s.platformReservePx.bottom) {
    // "then … the surviving image" only parses when a cut sentence preceded it.
    // Now that every live static surface generates at its exact aspect there is
    // no cut, and the old wording left the model reading a sequel to a sentence
    // that was never emitted — and implying a crop that is not happening.
    const cut = s.cropPx.top || s.cropPx.left;
    lines.push(cut
      ? `The platform then covers the top ${s.platformReservePx.top}px and bottom ${s.platformReservePx.bottom}px of the surviving image with its own interface.`
      : `The platform covers the top ${s.platformReservePx.top}px and bottom ${s.platformReservePx.bottom}px of the frame with its own interface.`);
  }
  // Element-agnostic on purpose. Naming "the CTA" here asserted a CTA exists,
  // which contradicted the absence list on any surface that strips it (PMax
  // non-conversion today; Stories historically) — the same empty-slot defect
  // that produced a fabricated quote in v1.
  lines.push(`EVERY element you render other than the photograph itself must sit inside the box from ${s.box.left}% to ${s.box.right}% of width and ${s.box.top}% to ${s.box.bottom}% of height. The photograph should still fill the whole frame edge to edge.`);
  return lines.join(' ');
}

/**
 * Per-surface inspection rows (replaces the safezones CLI demo table).
 * Returns one object per PLATFORM_FORMAT_KEYS entry for offline inspection.
 */
function describeSurfaces() {
  return pf.PLATFORM_FORMAT_KEYS.map((k) => {
    const s = computeSurface(k);
    return {
      surface: k,
      aspect: s.aspect,
      generate: s.generate,
      deliver: s.deliver,
      cropLeftRight: Math.round(s.cropPx.left),
      cropTopBottom: Math.round(s.cropPx.top),
      platformReserveTop: s.platformReservePx.top,
      platformReserveBottom: s.platformReservePx.bottom,
      platformReserveDeclared: s.platformReserveDeclared,
      box: s.box,
      lossPct: s.lossPct,
      geometry: geometryBlock(s)
    };
  });
}

// ── per-surface policy ──────────────────────────────────────────────────
/**
 * Two things vary by surface and neither belongs in an intent:
 *
 *  1. WHETHER A STATIC AD EXISTS AT ALL. platformFormats declares
 *     meta_reels_9_16 as kinds:["video"] — Reels takes no static image here.
 *     v1 shipped a Reels block inside every static intent, which was wrong.
 *
 *  2. WHO SUPPLIES THE CTA. PMax (flag on) suppresses a burned-in button for
 *     non-conversion intents because Google draws its own. Meta Stories used
 *     to do the same (link sticker / reply bar). That is now a measured
 *     defect: run_1786555875841_2ddf9739 delivered Stories with no CTA
 *     while 1:1 and 1.91:1 both painted "Shop the Cruiser". Diagnosis was
 *     (a) never requested — SURFACE_POLICY.drawCta was false, so buildPrompt
 *     stripped CTA BUTTON and absences forbade a button. The 9:16 safe box
 *     is not the squeeze (usable height ~1334px vs 1:1's ~901px). drawCta
 *     is therefore true on every live Meta static, including Stories. The
 *     platform reserve still keeps copy out of the reply bar; it does not
 *     replace the in-image button.
 *
 * CONFIDENCE, stated so it can be corrected rather than inherited:
 *   - reels video-only ....... from platformFormats.kinds (authoritative here)
 *   - stories in-image CTA ... owner-observed defect 2026-08-12; see above
 *   - pmax platform CTA ...... the platform draws its own CTA on most
 *     placements; the SURFACE_POLICY.drawCta:true values below are the
 *     Phase A / flag-off baseline. With PMAX_STATIC_PLATFORM_NOTES on,
 *     resolveDrawCta rewrites pmax_* to intent-dependent (true only for
 *     objection_resolved / conversion). Meta is never rewritten.
 *   - feed draws its own ..... INFERRED. Meta renders a CTA button beneath the
 *     image, so an in-image button is arguably duplicative, but the repo brief
 *     says "CTA should land within the first frame". Left as draws-own-CTA
 *     because that matches the brief; flag for the owner rather than silently
 *     dropping the CTA from the highest-volume surface.
 *
 * maxTextElements encodes the owner's density rule — "it should really be more
 * about the image" — and is enforced by sacrificing the lowest-value element,
 * never by truncating arbitrarily.
 */
const SURFACE_POLICY = {
  meta_feed_1_1:     { static: true,  drawCta: true,  maxTextElements: 4 },
  meta_feed_4_5:     { static: true,  drawCta: true,  maxTextElements: 4 },
  meta_reels_9_16:   { static: false, skipReason: 'kinds:["video"] — Reels takes no static image' },
  meta_stories_9_16: { static: true,  drawCta: true,  maxTextElements: 3 },
  pmax_16_9:         { static: true,  drawCta: true,  maxTextElements: 4 },
  // Phase A live PMax statics. drawCta:true is the SURFACE default and the
  // flag-off baseline; with PMAX_STATIC_PLATFORM_NOTES on, resolveDrawCta
  // rewrites it intent-by-intent (true only for objection_resolved).
  // maxTextElements 3 on the small 1.91:1 canvas — dense text hurts there.
  pmax_landscape_1_91_1: { static: true, drawCta: true, maxTextElements: 3 },
  pmax_square_1_1:       { static: true, drawCta: true, maxTextElements: 4 },
  pmax_portrait_4_5:     { static: true, drawCta: true, maxTextElements: 4 }
};

/**
 * Destination family for a surface key. `pmax_*` → 'pmax'; everything else
 * (including Meta live + frozen surfaces) → 'meta'. Used to gate PLATFORM_NOTES
 * and the PMax intent-aware CTA — Meta must never take either path.
 */
function destinationForSurface(surfaceKey) {
  return String(surfaceKey || '').startsWith('pmax_') ? 'pmax' : 'meta';
}

/**
 * PLATFORM_NOTES — per-destination delivery context injected into buildPrompt
 * AFTER the FORMAT/geometry block (the geometry block already establishes the
 * safe box these notes refer to). Model-facing text never names the platform
 * brand; existing prompts say "the platform" and these keep that convention.
 *
 * Only 'pmax' has a block today. Meta has none — an empty/missing entry is what
 * keeps Meta prompts byte-identical when the flag is on.
 *
 * SCENE-BUILD arm (default / preserve OFF) keeps the original recompose-friendly
 * centre-crop language. Under SCENE_PRESERVE the same delivery facts still
 * matter (crop risk, no accompanying text, thumbnail), but the notes must NOT
 * invite restaging the photograph — pmax_square_1_1 and pmax_portrait_4_5 can
 * carry preserve-ON + these notes together (only 16:9 landscape is
 * not-supported). resolvePlatformNotes(surface, {preserve}) selects the arm.
 */
const PLATFORM_NOTES_PMAX_SCENE_BUILD = [
  // ⚠️ Do NOT put the product back in the "must fit inside the box" list.
  // geometryBlock() says, two lines earlier: "EVERY element you render other
  // than the photograph itself must sit inside the box … The photograph
  // should still fill the whole frame edge to edge." Naming the product here
  // revokes that exemption and tells the model to shrink the subject into the
  // text box — wasting the frame on the exact surface where a small,
  // thumbnail-legible subject matters most. The box governs RENDERED
  // elements; the product only needs to survive a centre crop.
  'PLATFORM CONTEXT. The platform may crop the outer edges of this image on some placements. Every element you render — logo, and any text — must sit inside the safe box already specified above; nothing rendered in the outer margin. The photograph itself still fills the frame edge to edge, but compose it so the product reads as complete and uncut when the frame is cropped toward its centre: keep the product away from the extreme edges and never let a crop slice through it.',
  'This image may be shown WITHOUT any accompanying text. It has to communicate the product and the brand on its own.',
  'It may also be shown small, in a feed of unrelated content: one dominant subject, strong figure/ground contrast, no fine detail that dies at thumbnail size, no clutter.',
  'Keep the whole composition legible when the frame is cropped toward its centre.'
].join(' ');

/** Preserve-aware PMax notes — same delivery facts, no recompose of the plate. */
const PLATFORM_NOTES_PMAX_PRESERVE = [
  'PLATFORM CONTEXT. The platform may crop the outer edges of this image on some placements. Every element you render — logo, and any text — must sit inside the safe box already specified above; nothing rendered in the outer margin. The photograph itself still fills the frame edge to edge. Do not recompose, restage, or move the product to survive a centre crop — typeset chrome so it remains inside the safe box after that crop; the plate itself stays as the reference shows it.',
  'This image may be shown WITHOUT any accompanying text. It has to communicate the product and the brand on its own.',
  'It may also be shown small, in a feed of unrelated content: rely on the figure/ground contrast already present in the photograph; no fine type detail that dies at thumbnail size; no clutter in the chrome.',
  'Keep rendered chrome legible when the frame is cropped toward its centre; do not move or restage the product to achieve this.'
].join(' ');

const PLATFORM_NOTES = {
  // Default export = scene-build arm (flag-on non-preserve + harness pin).
  pmax: PLATFORM_NOTES_PMAX_SCENE_BUILD
};

/**
 * PMax STATIC PLATFORM NOTES + intent-aware CTA — kill switch, default ON.
 *
 * Same pattern as STATIC_PROMPT_FIDELITY_HARDENING / STATIC_BRAND_LED_COPY:
 * `false` restores a **byte-identical** pre-Phase-B prompt for every surface
 * (no notes block; pmax drawCta stays the per-surface SURFACE_POLICY boolean).
 * With the flag on, Meta surfaces remain byte-identical — only `pmax_*` is
 * allowed to diverge.
 */
const PMAX_STATIC_PLATFORM_NOTES = process.env.PMAX_STATIC_PLATFORM_NOTES !== 'false';

/**
 * Resolve platform notes for a surface. Preserve-ON on pmax square/portrait
 * uses the preserve-aware arm so recompose clauses never co-exist with
 * SCENE_PRESERVE. Preserve-OFF (incl. 16:9 not-supported fallthrough) keeps
 * the original scene-build string byte-identical.
 */
function resolvePlatformNotes(surfaceKey, { preserve = false } = {}) {
  if (!PMAX_STATIC_PLATFORM_NOTES) return null;
  if (destinationForSurface(surfaceKey) !== 'pmax') return null;
  return preserve ? PLATFORM_NOTES_PMAX_PRESERVE : PLATFORM_NOTES.pmax;
}

/**
 * Effective drawCta for a surface + resolved intent.
 *
 * Meta keeps SURFACE_POLICY.drawCta exactly — every live Meta static
 * (including Stories) stamps true. Do not rewrite Meta.
 *
 * PMax, flag ON only: the platform supplies the CTA affordance on most
 * placements, so a burned-in button is usually redundant — same *mechanism*
 * Stories used to use (strip before applyDensity + absence line). Stories
 * itself now draws the button (2026-08-12 delivered-ad defect). Exception:
 * conversion-flavoured creatives (objection_resolved, what ai_promotional
 * maps to) still want the in-image CTA. Flag OFF restores the Phase A
 * per-surface boolean (all pmax_* true).
 */
function resolveDrawCta({ surfaceKey, policy, intentKey }) {
  if (!policy) return true;
  // Flag off → every surface uses the raw SURFACE_POLICY boolean (byte-identity).
  if (!PMAX_STATIC_PLATFORM_NOTES) return policy.drawCta;
  // Meta (and any non-pmax) → never rewrite.
  if (destinationForSurface(surfaceKey) !== 'pmax') return policy.drawCta;
  // PMax + flag on: intent-dependent. TRUE only for the conversion intent.
  return intentKey === 'objection_resolved';
}

/**
 * Which element goes first when over the density budget. Earlier = sacrificed
 * sooner. A role in an intent's `core` is never sacrificed — losing it would
 * defeat the intent, in which case the intent should not have run.
 *
 * SUBHEAD sits immediately before TRUST MARK: it is supporting copy, so it is
 * sacrificed before the trust mark the owner chose to keep. Additive-safe —
 * no pre-existing intent emits a SUBHEAD role, so applyDensity's findIndex
 * returns -1 and every existing prompt is unchanged.
 */
const SACRIFICE_ORDER = ['BADGE', 'ATTRIBUTION', 'SUBHEAD', 'TRUST MARK', 'CUSTOMER QUOTE', 'RATING', 'BRAND LINE'];

// ── absence, stated ─────────────────────────────────────────────────────
/**
 * Flags describe what the INTENT renders, not merely what the data holds — an
 * intent that never shows a quote must say so even when a quote exists, or the
 * model borrows it from context.
 */
function absences(d, { rendersQuote, rendersRating, rendersBadge, rendersSubhead }, dropped = [], policy = {}) {
  const out = [];
  const lost = (role) => dropped.includes(role);
  if (!rendersQuote || !d.quote || lost('CUSTOMER QUOTE')) out.push(
    'no customer quote, testimonial, review sentence, quotation marks, star-glyph row or attribution — and never re-dress a tagline, badge or headline as something a customer said');
  else if (!d.attribution || lost('ATTRIBUTION')) out.push(
    'no name, initial, city, date, handle, avatar or verification tick — the quote stands alone');
  if (!rendersRating || !d.rating || lost('RATING') || lost('TRUST MARK')) out.push(
    'no numeric score, star glyphs or trust mark of any kind');
  else {
    /**
     * Fires even though a rating IS shown. Two of five test renders drew a
     * five-star glyph row beside the supplied "4.8 ★" string — and both drew
     * FOUR AND A HALF stars, contradicting the real 4.8. Showing one rating
     * invites the model to complete the familiar review-widget pattern, so the
     * permitted mark has to be fenced explicitly.
     */
    out.push('no star row, five-star graphic, half-star, rating bar, meter, percentage score, review-site widget, verified tick, customer avatar, screenshot of a review, publication masthead or award laurel — the single rating string above is the ONLY rating mark permitted anywhere in the frame');
    if (!d.reviewCount) out.push('no review count, and not the words review, reviews, ratings or customers');
  }
  if (!rendersBadge || !d.badge || lost('BADGE')) out.push(
    'no badge, pill, ribbon, seal or corner flag — never Best Seller, Top Rated, Customer Favorite, #1 or As Seen On');
  // CRITICAL: condition MUST lead with rendersSubhead, NOT !rendersSubhead.
  // Only brand_led declares rendersSubhead, so every existing intent stays
  // undefined → falsy → this line is never emitted for them → their prompts
  // stay byte-identical. Getting this backwards adds a new absence line to
  // every existing intent and breaks the flag-off baseline.
  if (rendersSubhead && (!d.subhead || lost('SUBHEAD'))) out.push(
    'no subheading, supporting line, descriptive sentence or secondary copy beneath the brand line');
  if (policy.drawCta === false) out.push(
    `no CTA button, no "shop now", "learn more", "swipe up", "link in bio", arrow or tap affordance of any kind — ${policy.ctaNote || 'the platform supplies it'}`);
  out.push('no price, currency symbol, discount, saving, offer or countdown');
  // "no brand wordmark" fought "reproduce any branding printed on the product".
  // Separate the two: the product's own mark is product identity, not ad chrome.
  // "garment" was apparel-specific wording on a multi-category catalog, and the
  // carve-out has to name the product generically or a bottle's own label reads
  // as ad chrome to be removed. Gated with the rest of the hardening so the
  // flag-off arm is the exact prompt that was measured — see FIDELITY_HARDENING.
  if (FIDELITY_HARDENING) {
    out.push('no product name, website, hashtag or small print added anywhere in the scene — wording already printed on the product itself is not an addition and stays exactly as the reference shows it');
    out.push('no added brand logo, wordmark or lockup anywhere in the scene — any logo, wordmark or label already printed on the product itself stays exactly as it is, reproduced from the reference rather than redrawn, but nothing new is drawn');
    /**
     * Owner-supplied catch-all, 2026-08-03. Deliberately phrased as "invent"
     * and "not given to you", NOT as a flat ban on the nouns: several of these
     * ARE supplied on some intents (a rating, a badge), and the conditional
     * rules above already permit exactly those and fence the rest. A blanket
     * "no ratings" line here would contradict the supplied rating string and
     * undo the tuned star-row rule above it.
     */
    out.push('no award, laurel, ribbon, seal, guarantee, warranty or money-back claim, QR code, barcode, legal or regulatory small print, or promotional claim of any kind — and nothing else you were not given: if a word, numeral or mark is not in the text above, it does not belong in the image');
  } else {
    out.push('no product name, website, hashtag or small print');
    out.push('no added brand logo, wordmark or lockup anywhere in the scene — any logo already printed on the garment itself stays exactly as it is, but nothing new is drawn');
  }
  return out;
}

// ── the three intents ───────────────────────────────────────────────────
const INTENTS = {
  social_proof_led: {
    priority: 1,
    ownerBrief: 'Product image dominates; prominently show average star rating, review count, and a short authentic quote if available. Clean modern design, generous white space, strong hierarchy. Badge if available. Logo subtle. Clear Shop Now CTA. Premium, trustworthy, native to Instagram/Facebook — not a banner ad.',
    goal: 'A stranger scrolling past should understand, before reading a word of body copy, that many real people already bought this and rate it highly.',
    renders: { rendersQuote: true, rendersRating: true, rendersBadge: true },
    core: ['RATING'],
    /** Eligibility, from the owner brief: this intent IS the rating. */
    eligible: (d) => d.rating ? null : 'no rating — this intent is the rating',
    // Third arg `ctx` optional so flag-off / non-preserve callers stay
    // byte-identical. Preserve-aware emphasis ranks type/chrome over the
    // existing plate — never re-composition of the photograph.
    emphasis: (d, kept, ctx = {}) => [
      ctx.preserve
        ? 'the product as the photograph already presents it — desirable as shown'
        : 'the product itself, shown large and desirable',
      d.reviewCount ? 'the rating and how many people gave it' : 'the rating',
      kept('CUSTOMER QUOTE') ? "the customer's own words" : null,
      kept('BADGE') ? 'the badge, quietly' : null,
      kept('CTA BUTTON') ? 'the CTA, unmissable but not shouting' : null
    ].filter(Boolean),
    text: (d) => [
      // Prefer the SCOPED string from the coherence chokepoint —
      // "523 reviews" for product tier, "41000 brand reviews" for brand tier —
      // over re-deriving an unscoped one from the bare number. A brand
      // aggregate can win this slot (BRAND_PROOF_ON_PRODUCT_ADS,
      // directImageRenderService), and printing its count unscoped would read
      // as that SKU's own review volume. Falls back to the pre-change unscoped
      // template only when reviewsText is absent (flag off, or a caller that
      // never ran the coherence gate) so behaviour there is unchanged.
      ['RATING', d.reviewsText ? `${d.rating} ★ (${d.reviewsText})`
        : d.reviewCount ? `${d.rating} ★ (${d.reviewCount} reviews)` : `${d.rating} ★`],
      d.quote ? ['CUSTOMER QUOTE', `"${d.quote}"`] : null,
      d.quote && d.attribution ? ['ATTRIBUTION', `— ${d.attribution}`] : null,
      d.badge ? ['BADGE', d.badge] : null,
      ['CTA BUTTON', d.cta]
    ].filter(Boolean)
  },

  product_first_lifestyle: {
    priority: 2,
    ownerBrief: 'Product image dominates; brand slogan, logo, rating, CTA. Aspirational lifestyle framing.',
    /**
     * Goal is a function of what survives: the v1 wording ended "...nothing but
     * the product and a line", which on a zero-text render promised a line the
     * text block forbade. Never describe an element the prompt may not carry.
     */
    goal: (kept) => 'A stranger scrolling past should want the life the product implies, and should recognise the brand while wanting it. This intent carries no proof burden — '
      + (kept('BRAND LINE')
        ? 'it works with nothing but the product and a line.'
        : 'here it works on the strength of the photograph alone.'),
    renders: { rendersQuote: false, rendersRating: true, rendersBadge: false },
    core: [],
    eligible: () => null, // always runs; it is the floor of the hierarchy
    // Third arg `ctx` is optional so flag-off / non-preserve callers that only
    // pass (d, kept) stay byte-identical. Preserve-aware emphasis points at the
    // existing photograph; scene-build arm keeps the pre-change wording.
    // text() is deliberately NOT preserve-aware — copy roles/order are owned
    // by the Director intent (owner requirement).
    emphasis: (d, kept, ctx = {}) => [
      ctx.preserve
        ? 'the product already in this photograph — the life the plate already implies'
        : 'the product in a scene someone wants to be in',
      kept('BRAND LINE') ? "the brand's line" : null,
      kept('TRUST MARK') ? 'a quiet trust mark, secondary to everything above' : null,
      kept('CTA BUTTON') ? 'the CTA' : null
    ].filter(Boolean),
    text: (d) => [
      d.headline ? ['BRAND LINE', d.headline] : null,
      // Same scoped-disclosure preference as the RATING slot in social_proof_led
      // (see there for the full rationale): a brand aggregate reaching this slot
      // via BRAND_PROOF_ON_PRODUCT_ADS must never render as a bare, unscoped
      // '4.8 ★' — this is the FLOOR intent (always eligible), so it is the most
      // frequent place that widening would otherwise surface unscoped.
      d.rating ? ['TRUST MARK', d.reviewsText ? `${d.rating} ★ (${d.reviewsText})` : `${d.rating} ★`] : null,
      ['CTA BUTTON', d.cta]
    ].filter(Boolean)
  },

  objection_resolved: {
    priority: 3,
    ownerBrief: 'Replaces the original price-led intent at owner direction — pricing is switched off system-wide.',
    goal: "A stranger scrolling past should have the specific worry that stops people buying this category answered by someone who already bought it. The customer's sentence is the whole ad.",
    renders: { rendersQuote: true, rendersRating: false, rendersBadge: true },
    core: ['CUSTOMER QUOTE'],
    /** A generic compliment defeats the intent; it needs a real risk-reversal line. */
    eligible: (d) => d.quote ? null : 'no risk-reversal quote — a generic line defeats the intent',
    // Preserve-aware: "loudest thing in the frame" reads as re-composition;
    // under preserve it is type hierarchy over the existing plate.
    emphasis: (d, kept, ctx = {}) => [
      ctx.preserve
        ? "the customer's sentence, as the loudest type treatment in the hierarchy"
        : "the customer's sentence, as the loudest thing in the frame",
      ctx.preserve
        ? 'the product as the photograph already presents it — clearly the thing being talked about'
        : 'the product, clearly the thing being talked about',
      kept('ATTRIBUTION') ? 'who said it' : null,
      kept('BADGE') ? 'the badge, quietly' : null,
      kept('CTA BUTTON') ? 'the CTA' : null
    ].filter(Boolean),
    text: (d) => [
      ['CUSTOMER QUOTE', `"${d.quote}"`],
      d.attribution ? ['ATTRIBUTION', `— ${d.attribution}`] : null,
      d.badge ? ['BADGE', d.badge] : null,
      ['CTA BUTTON', d.cta]
    ].filter(Boolean)
  },

  /**
   * Brand visual identity as hero (aiCanvasSpecService CREATIVE_STYLES.brand_led):
   * brand colours dominate, logo prominent, short punchy headline carries the
   * brand voice, product supporting. de_emphasized there is quote_card /
   * proof_bar / badge_row — social proof here is the rating trust mark only,
   * no quote. Not in FALLBACK_ORDER: reachable only as an explicitly requested
   * intent (TEMPLATE_INTENT.ai_brand_led when BRAND_LED_COPY is on), which is
   * what makes the kill switch total.
   *
   * Density already fits the maximum case: max 4 elements (BRAND LINE + SUBHEAD
   * + TRUST MARK + CTA); feed 1:1 / 4:5 and pmax budget 4 → fits; stories
   * budget 3 sacrifices SUBHEAD (supporting copy, in SACRIFICE_ORDER) and
   * keeps CTA — 3 → fits. CTA is not in SACRIFICE_ORDER, so a Stories surface
   * cannot drop the button to make room for a subhead.
   */
  brand_led: {
    priority: 3.5,
    ownerBrief: 'Brand visual identity is the hero. Brand colours dominate. Logo prominent. A short punchy headline carries the brand voice; product appears in a supporting position (small card or inset). Hero media covers most of the frame. De-emphasised: quote card, proof bar, badge row. Rating trust mark only if available — no customer quote.',
    /**
     * Goal is a function of what survives: never promise an element the text
     * block may not carry (see product_first_lifestyle).
     * Third arg `ctx` optional so flag-off / non-preserve callers stay
     * byte-identical. Preserve arm drops "product supporting rather than
     * leading" (re-composition) — brand recognition comes from type/chrome
     * treatment over the existing plate.
     */
    goal: (kept, ctx = {}) => (ctx.preserve
      ? 'A stranger scrolling past should recognise the brand first — its colours, its voice, its mark — from brand treatment and type hierarchy over the existing photograph. '
      : 'A stranger scrolling past should recognise the brand first — its colours, its voice, its mark — with the product supporting rather than leading. ')
      + (kept('BRAND LINE')
        ? 'The brand line carries the voice.'
        : 'Here the brand identity has to do the work without a line.'),
    renders: { rendersQuote: false, rendersRating: true, rendersBadge: false, rendersSubhead: true },
    core: ['BRAND LINE'],
    /** Eligibility: without a line at all it degrades through FALLBACK_ORDER to product_first_lifestyle rather than shipping a hollow brand-led ad. */
    eligible: (d) => d.headline ? null : 'no brand line — brand_led is the brand line',
    // Preserve-aware: "dominating the frame" / supporting product position are
    // re-composition cues under SCENE_PRESERVE. Under preserve, rank type and
    // chrome hierarchy over the existing photograph (this is the live default
    // via TEMPLATE_INTENT → ai_brand_led for unmapped Director styles).
    emphasis: (d, kept, ctx = {}) => [
      ctx.preserve
        ? 'the brand treatment — colours, mark, visual identity dominating the type hierarchy over the existing photograph'
        : 'the brand itself — colours, mark, visual identity dominating the frame',
      kept('BRAND LINE') ? "the brand's line, punchy and unmistakable" : null,
      kept('SUBHEAD') ? 'a supporting line beneath the brand line' : null,
      ctx.preserve
        ? 'the product as the photograph already presents it, supporting the brand treatment'
        : 'the product, clearly present but supporting',
      kept('TRUST MARK') ? 'a quiet trust mark, secondary to the brand' : null,
      kept('CTA BUTTON') ? 'the CTA' : null
    ].filter(Boolean),
    text: (d) => [
      d.headline ? ['BRAND LINE', d.headline] : null,
      d.subhead  ? ['SUBHEAD', d.subhead]     : null,
      // Same scoped-disclosure preference as social_proof_led's RATING slot and
      // product_first_lifestyle's TRUST MARK above — a brand aggregate reaching
      // this slot via BRAND_PROOF_ON_PRODUCT_ADS must never render as a bare,
      // unscoped '4.8 ★'.
      d.rating   ? ['TRUST MARK', d.reviewsText ? `${d.rating} ★ (${d.reviewsText})` : `${d.rating} ★`] : null,
      ['CTA BUTTON', d.cta]
    ].filter(Boolean)
  }
};

const FALLBACK_ORDER = ['social_proof_led', 'objection_resolved', 'product_first_lifestyle'];

/**
 * Resolve which intent actually runs. Walks DOWN the hierarchy exactly as the
 * owner asked: if the requested intent is not eligible, try the next lower
 * priority, ending at product_first_lifestyle which needs no proof.
 */
function resolveIntent(requested, d) {
  const chain = [requested, ...FALLBACK_ORDER.filter(k => k !== requested)];
  for (const key of chain) {
    const reason = INTENTS[key].eligible(d);
    if (!reason) return { key, spec: INTENTS[key], fellBackFrom: key === requested ? null : requested, why: reason };
  }
  return { key: null, spec: null, why: 'no intent eligible' };
}

/** Enforce the density budget by sacrificing the least valuable element first. */
function applyDensity(text, spec, policy) {
  const kept = text.slice();
  const dropped = [];
  const budget = policy.maxTextElements ?? Infinity;
  for (const role of SACRIFICE_ORDER) {
    if (kept.length <= budget) break;
    if (spec.core.includes(role)) continue;
    const i = kept.findIndex(([r]) => r === role);
    if (i === -1) continue;
    dropped.push(...kept.splice(i, 1).map(([r]) => r));
    // an attribution without its quote is meaningless
    if (role === 'CUSTOMER QUOTE') {
      const a = kept.findIndex(([r]) => r === 'ATTRIBUTION');
      if (a !== -1) dropped.push(...kept.splice(a, 1).map(([r]) => r));
    }
  }
  return { kept, dropped };
}

/**
 * PRODUCT-FIDELITY HARDENING — kill switch, default ON.
 *
 * `false` restores a **byte-identical** pre-hardening prompt: the one-sentence
 * `LEGACY_PRODUCT_FIDELITY` paragraph, and the product-own-print carve-outs in
 * `absences` and `textBlock` reverted too. That completeness is the point — a
 * flag that reverts "most of" the change gives an A/B whose control arm is not
 * the arm that was measured, so the comparison proves nothing.
 *
 * It exists because of the precedent in CLAUDE.md §00: PR #61 hardened the
 * VIDEO prompt the same way and the owner rolled all three parts back —
 * *"This is creating additional hallucinations and the previous output was
 * better."* Prompt hardening is not self-evidently an improvement on this
 * stack, and this path has a measured baseline worth being able to return to
 * without a deploy (see `PRODUCT_FIDELITY` below).
 */
const FIDELITY_HARDENING = process.env.STATIC_PROMPT_FIDELITY_HARDENING !== 'false';

/**
 * LIFESTYLE / UGC SCENE PRESERVE — kill switch, default OFF.
 *
 * When on, lifestyle seeds (`resolveSeedStyle === 'lifestyle'`) and
 * `variantKind === 'ugc'` swap the scene-building fidelity opening for
 * SCENE_PRESERVE. Intent selection, copy roles, and copy order are untouched
 * — only scene treatment changes. Flag-off ⇒ every existing prompt is
 * **byte-identical** (no preserve branch runs). Exact string `'true'` enables;
 * unset/empty/false stay off.
 */
const LIFESTYLE_PRESERVE = process.env.STATIC_LIFESTYLE_PRESERVE === 'true';

/**
 * BRAND-LED COPY — kill switch, default ON.
 *
 * `false` restores a **byte-identical** pre-change prompt because the
 * `TEMPLATE_INTENT` entry, both copy cascades in `buildIntentData`, and the
 * SUBHEAD role all revert **together**. A flag that reverts only part of it
 * gives an A/B whose control arm is not the arm that was measured, so the
 * comparison proves nothing.
 *
 * Single source of truth — `directImageRenderService` imports this rather
 * than re-reading the env var.
 */
const BRAND_LED_COPY = process.env.STATIC_BRAND_LED_COPY !== 'false';

/** The exact pre-2026-08-03 wording. Do not edit — it is the A/B control arm. */
const LEGACY_PRODUCT_FIDELITY = `The supplied photograph is a PRODUCT REFERENCE ONLY. Reproduce this exact item faithfully — its colour, material, construction and any branding printed on the product itself — then build an entirely new scene around it. Do not reuse the reference's background, crop or lighting.`;

/**
 * PRODUCT FIDELITY — the anti-drift block. Owner-directed, 2026-08-03.
 *
 * Replaces the single hedged sentence above, which was losing to the creative
 * instructions below it: renders came back with hallucinated logos, shifted
 * colours, altered fit and "improved" construction. The wording is absolute and
 * front-loaded because the failure mode was not the model missing the
 * instruction — it was the model resolving a conflict between accuracy and
 * styling in favour of styling, so the block has to state its own precedence.
 *
 * READ THIS BEFORE CITING THE ~1-IN-3 COMPETITOR-MARK DEFECT AS ITS
 * JUSTIFICATION. CLAUDE.md §2 "Known open" records that defect and says the fix
 * is **measure-and-reject, not prompt tuning** — `adVisionQcService` is that
 * fix and it remains the real one. This block is owner-directed hardening on
 * top, not a replacement for it, and it must not be described as closing that
 * known-open. If the next render sample still shows competitor marks, that is
 * the expected outcome, not evidence this block was written wrong.
 *
 * Five things in here are load-bearing and must not be trimmed as redundant:
 *   1. the "do not infer from category or brand prior" clause — the tree emblem
 *      that read as Timberland on an Allbirds shoe is the model rendering what
 *      the CATEGORY usually looks like, not what the reference shows;
 *   2. the carve-out that the product's OWN printing is product identity, which
 *      has to be stated positively or the no-added-text rules erase the label
 *      (matching carve-outs live in `absences` and in `textBlock` below);
 *   3. the WHAT MAY CHANGE list, which keeps this from being read as a ban on
 *      creative staging — without it the model returns a catalogue shot, and the
 *      whole point of this path is a new scene around the same item;
 *   4. the sentence naming the reserved logo corner. The block claims to outrank
 *      what follows it, and the "never draw the logomark, the real asset is
 *      composited afterwards" rule is *below* it — so without this the highest
 *      priority section reads as blanket authority over brand marks. See the
 *      logo note in `directImageRenderService`'s header;
 *   5. the closing check covering BOTH product and copy. Product-only would have
 *      hung a closing gate on the new objective and none on the old one.
 *
 * WHAT THE PRECEDENCE SENTENCE DELIBERATELY DOES NOT SAY: it scopes itself to
 * creative and styling instructions and explicitly exempts the text contract.
 * An unqualified "outranks everything that follows" put a ~4k-char wall between
 * the opening line and SET EXACTLY THESE STRINGS *and* told the model the wall
 * mattered more — and text fidelity is the whole game on this path (see the
 * PLATE_QUALITY note in `directImageRenderService`: quality `high` measured
 * WORSE than `medium` precisely because it lost a string). The prompt more than
 * doubled, ~3.5-4.1k chars to ~7.8-8.4k; the measured baseline it is spending
 * against is 139/140 strings across 20 renders. That is the trade this flag is
 * here to let the owner unwind.
 *
 * This is prose for a model, not a spec for a human: it is deliberately
 * repetitive, and the enumerations are open ("including but not limited to")
 * because the catalog spans apparel, footwear, bottles, devices and jewellery.
 */
const PRODUCT_FIDELITY = `PRODUCT FIDELITY — HIGHEST PRIORITY. Wherever product accuracy conflicts with a creative or styling instruction below, product accuracy wins. This does not relax the text instructions below, which are absolute in their own right, and it does not override the reserved-corner rule or the FORMAT block below.
The supplied reference photograph is the single source of truth for the product; where several are supplied, the first is the primary product reference and the rest are further views of the same item. It is a PRODUCT REFERENCE ONLY — not a composition to copy. Treat every visible characteristic of the item as immutable. This advertisement must feature the exact same physical item that reference shows, as though that same item had been carried into a new professional photoshoot and photographed again — not recreated from memory. Do not redesign, reinterpret, simplify, modernise, improve, repair, stylise, approximate or substitute any part of it.
Do not infer the product from its category, and do not infer it from anything you know about the brand. If the reference disagrees with what products of this type usually look like, or with your prior knowledge of this brand, the reference is correct and your prior is wrong. This holds for every category — apparel, footwear, jewellery, bags, accessories, cosmetics, skincare, electronics, furniture, sporting goods, home goods, toys, tools, and packaged or food goods alike.

PRESERVE EXACTLY, as the reference shows it:
  — Form: shape, proportions, overall dimensions, silhouette, geometry, profile, contours, edges, thickness, volume and curvature. Fit and cut are part of the form and may not be altered, though the item may of course be posed, worn or placed differently.
  — Construction: seams, stitching, panel layout, assembly, joints, fasteners, hardware, hinges, closures, buttons, buckles, snaps, zips, clasps, laces, eyelets, straps, handles.
  — Materials: fabric, knit, mesh, leather, suede, rubber, plastic, metal, wood, glass, ceramic, gemstone, carbon fibre, foam, paper and packaging material — each rendered as the same material the reference shows, never swapped for a richer or cheaper-looking one.
  — Surface: texture, weave, grain, gloss, matte, satin, brushed and polished finishes, transparency, opacity, reflectivity.
  — Colour: the item's own colours exactly. Do not shift hue, recolour, bleach, tint, darken, brighten, saturate, desaturate, or invent an alternate colourway. New lighting may fall across those colours; it may not change them.
  — Graphics already on the item: logos, branding, icons, artwork, patterns, prints, typography, embroidery, embossing, debossing, engraving, decals, labels and tags — same wording, same lettering, same placement, same scale. Reproduce them from the reference; never redraw them from imagination, and never add, remove or modify any branding. This preserves marks that are ALREADY on the item; it is never licence to place a brand mark anywhere else in the frame.
  — Details, including but not limited to: pockets, collars, sleeves, cuffs, necklines, hems, soles, heels, eyelets, handles, bezels, displays, screens, lenses, caps, applicators, chains, gemstones, watch faces, grips, blades, wheels, buttons, ports, vents and sensors. Every feature visible in the reference must appear unchanged; no feature absent from the reference may be added.
  — Condition: wrinkles, folds, creases, wear, polish, finish, surface imperfections, and the shadows the item casts on itself. Do not “improve” the item, smooth its surfaces, or clean away its natural characteristics.

NEVER: substitute a similar-looking version; invent a feature that is absent; remove a visible feature; redesign any component; merge this item with another design; produce a newer, cleaner, alternative or special edition of it; produce a different size, fit or variation; simplify it; stylise it; or hallucinate any detail that is not visible in the reference.
If part of the item is not visible in the reference, do not invent or redesign the hidden portion. Infer only the minimum physically plausible geometry a believable photograph needs, fully consistent with the parts you can see — and infer geometry only, never a graphic, a label or a marking.

PRODUCT SCALE AND FRAMING. The reference photograph also defines how the product is framed, and that carries over. Give the item approximately the same visual prominence and approximately the same share of the frame as the reference does — within about a tenth either way — from approximately the same camera distance and a similar perspective. Do not zoom in dramatically, zoom out dramatically, or crop substantially tighter or wider than the reference. Compose the advertisement around the item at that size: fit the environment to the product, never the product to the environment, and never rescale the item just to make a layout easier. This governs how large the item sits inside the frame; it does not govern the frame itself — the output's dimensions and aspect are fixed by the FORMAT block at the end, and the safe box and reserved corner still apply.

WHO WEARS OR HOLDS IT. If the reference photograph shows the item worn, held or carried by a person, then a person wears or holds it in your image too, the same way, on the same part of the body. Keep the same person — do not replace them with someone else. Their pose, their hands and how they are framed are yours to direct, but you may NOT remove them and show the item lying on its own, and you may not move a worn garment onto a hanger, a mannequin, a surface or a flat lay. If the reference shows the item by itself, you may introduce a person or leave it unpeopled, whichever makes the better advertisement.

WHAT MAY CHANGE — everything that is not the item itself, and you should change it: who the model is, their pose and hands, environment, background, set, props, styling, lighting, shadows, mood, atmosphere, camera angle, focal length, depth of field, the colour grading of the scene, and the typographic treatment of the copy specified below. Build an entirely new scene around the item; do not reuse the reference's background or lighting. Note what is deliberately NOT on that list: the product's size in frame and the camera's distance from it, which the paragraph above holds close to the reference — and whether the item is worn, which the paragraph above ties to the reference.

ADVERTISING QUALITY. This has to read as work a premium creative agency shipped, not a stock photograph and not a template that was filled in. Make the lighting feel intentional and the typography feel art-directed. Use whitespace deliberately. Keep the product the primary focal point and give it the greatest visual emphasis in the frame. Aim for premium, modern and editorial — and put the inventiveness in the photography, the light and the typography, never in the product and never in the claims.

BEFORE YOU FINISH, check three things. The product: a customer would recognise it as the identical physical item; nothing has been redesigned, added, removed, recoloured or reshaped; and colour, branding, materials and construction all match the reference. The framing: the item occupies roughly the same share of the frame as it does in the reference, and the whole image could pass as another photograph of that same item taken in a new commercial shoot. The copy: every string you were given below appears exactly once, spelled exactly as given, and no other text appears anywhere. If any check fails, correct it before finishing the advertisement.`;

/**
 * SCENE PRESERVE — lifestyle / UGC static modifier (flag-gated).
 *
 * Replaces PRODUCT_FIDELITY / LEGACY when the seed is a lifestyle photograph or
 * the ad is UGC. Those blocks open on "build an entirely new scene" — stacking
 * preserve language on top would contradict them. This block carries every
 * product-identity clause (form, construction, materials, surface, colour,
 * on-item graphics, details, condition) while locking the photograph's subject
 * and scene. Intent still owns all copy roles and their order.
 *
 * Owner 2026-08 (Lane O): edge extension to fit the surface aspect IS permitted
 * when resolveAspectTreatment returns 'extend' — a lifestyle photo is rarely
 * already the ad's aspect, so "don't change the scene" and geometryBlock's
 * "fill the frame edge to edge" could not both hold without it. Everything
 * else (subject, pose, crop of the subject, light, grade, wardrobe, props,
 * environment) stays locked. Treatment 'native' omits the extension sentence.
 * Treatment 'not-supported' (16:9 / PMax landscape) never reaches this block.
 *
 * Geometry (computeSurface / geometryBlock) is unchanged: the existing
 * "photograph should still fill the whole frame edge to edge" language is
 * now consistent with edge extension and is NOT reworded here.
 */

/** Edge-extension sentence — only when treatment === 'extend'. */
const SCENE_PRESERVE_EDGE_EXTEND =
  `EDGE EXTENSION: Edge extension to fit the surface aspect IS permitted — continuing the existing scene outward at the frame edges only. ` +
  `Extension must be a plausible continuation of the same scene — never new subjects, new objects, new props, or a different place. ` +
  `If you cannot extend the scene plausibly, letterbox rather than invent content. ` +
  `This is the only permitted change to the photograph's canvas; it does not license restyling, restaging, inventing a second location, or changing the subject.`;

/**
 * Build the SCENE_PRESERVE block for a resolved treatment ('extend' | 'native').
 * 'not-supported' never calls this — preserve falls through to scene-build.
 */
function buildScenePreserveBlock(treatment) {
  const edgeBlock = treatment === 'extend'
    ? `\n\n${SCENE_PRESERVE_EDGE_EXTEND}`
    : '';
  // native: no extension sentence (seed already matches surface aspect).
  const mayChangeExtra = treatment === 'extend'
    ? ' Edge extension of the existing scene to fit the surface aspect (frame edges only).'
    : '';
  const finishExtra = treatment === 'extend'
    ? ' Edge extension to fit the frame, if any, continues the same scene at the edges only.'
    : '';
  return `SCENE PRESERVE — HIGHEST PRIORITY. The supplied photograph is the finished plate. Subject identity, pose, crop of the subject, lighting, shadows, colour grade, depth of field, camera angle, wardrobe, props and environment stay EXACTLY as the reference shows. Do not rebuild, restyle, re-light, recolour, blur or replace the background. Do not change wardrobe, props or environment. Do not restage the product. Do not invent a second location. Do not recompose, re-pose, or re-shoot the subject. Wherever scene preservation conflicts with a creative or styling instruction below, scene preservation wins. This does not relax the text instructions below, which are absolute in their own right, and it does not override the reserved-corner rule or the FORMAT block below.${edgeBlock}

PRODUCT IDENTITY — ABSOLUTE. The item in the photograph is immutable. Reproduce this exact physical product; never redesign, reinterpret, simplify, modernise, improve, repair, stylise, approximate or substitute any part of it. Do not infer the product from its category or from brand priors — if the reference disagrees with what products of this type usually look like, the reference is correct.
PRESERVE EXACTLY, as the reference shows the product:
  — Form: shape, proportions, overall dimensions, silhouette, geometry, profile, contours, edges, thickness, volume and curvature.
  — Construction: seams, stitching, panel layout, assembly, joints, fasteners, hardware, hinges, closures, buttons, buckles, snaps, zips, clasps, laces, eyelets, straps, handles.
  — Materials: fabric, knit, mesh, leather, suede, rubber, plastic, metal, wood, glass, ceramic, gemstone, carbon fibre, foam, paper and packaging material — each the same material the reference shows.
  — Surface: texture, weave, grain, gloss, matte, satin, brushed and polished finishes, transparency, opacity, reflectivity.
  — Colour: the item's own colours exactly. Do not shift hue, recolour, bleach, tint, darken, brighten, saturate or desaturate the product.
  — Graphics already on the item: logos, branding, icons, artwork, patterns, prints, typography, embroidery, embossing, debossing, engraving, decals, labels and tags — same wording, same lettering, same placement, same scale. Reproduce from the reference; never redraw from imagination; never add, remove or modify branding.
  — Details, including but not limited to: pockets, collars, sleeves, cuffs, necklines, hems, soles, heels, eyelets, handles, bezels, displays, screens, lenses, caps, applicators, chains, gemstones, watch faces, grips, blades, wheels, buttons, ports, vents and sensors. Every feature visible in the reference must appear unchanged; no feature absent from the reference may be added.
  — Condition: wrinkles, folds, creases, wear, polish, finish, surface imperfections, and the shadows the item casts on itself. Do not "improve" the item.

COMPOSITING ONLY. Your job is to typeset the exact strings listed below into the safe box as advertisement chrome (type and optional soft scrim or panel behind type where legibility over a busy photograph demands it). A soft scrim or panel behind type IS permitted — that is chrome, not a change to the photograph. Inventiveness lives in typography and chrome treatment only, never in inventing a new scene. Do not invent a new photoshoot of a similar scene.

WHAT MAY CHANGE: letterforms and any non-photo chrome required to set those strings (including a soft legibility scrim/panel).${mayChangeExtra} Nothing else about the photograph's pixels may change.

BEFORE YOU FINISH: a side-by-side with the reference should read as the same photograph with copy overlaid — not a new photoshoot of a similar scene.${finishExtra} Product identity, subject, pose, light and crop of the subject all match the reference; every supplied string appears exactly once; no other text appears.`;
}

/** Default export: extend treatment (the common Meta path). */
const SCENE_PRESERVE = buildScenePreserveBlock('extend');

/**
 * Wide landscape surfaces where "edge extension" would invent 55–68% of the
 * frame (portrait lifestyle → 16:9 / ~1.91:1). Preserve is NOT supported there.
 *
 * 16:9 PMax composition under preserve is deliberately deferred, not missing —
 * do not "fix" by enabling 'extend' here. Owner will choose a different
 * composition for those surfaces later.
 */
function isWideLandscapeSurface(surfaceKey) {
  if (!surfaceKey) return false;
  const key = String(surfaceKey);
  // Named keys first (no dependency on aspect table being loaded).
  if (key === 'pmax_16_9' || key === 'pmax_landscape_1_91_1') return true;
  try {
    const a = aspectOf(key);
    // ≥ ~3:2 landscape — Meta statics are 1:1 / 4:5 / 9:16 only, so this
    // only hits true landscape PMax / future wide surfaces.
    if (a && a.value >= 1.5) return true;
  } catch (_) { /* unknown surface — not wide */ }
  return false;
}

/**
 * Parse a seed aspect (number ratio, "4:5", "1080x1350", etc.) to a value.
 * Returns null when unknown — caller then cannot claim 'native'.
 */
function parseAspectValue(seedAspect) {
  if (seedAspect == null || seedAspect === '') return null;
  if (typeof seedAspect === 'number' && Number.isFinite(seedAspect) && seedAspect > 0) {
    return seedAspect;
  }
  const s = String(seedAspect).trim();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*[:xX/]\s*(\d+(?:\.\d+)?)$/);
  if (m) {
    const w = Number(m[1]);
    const h = Number(m[2]);
    if (w > 0 && h > 0) return w / h;
  }
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Derive seedAspect from Media.width / Media.height for resolveAspectTreatment.
 * Production MUST load both fields on the Media query and call this — without
 * it the 'native' arm is dead (every preserve submit falls to 'extend').
 *
 * Missing / zero / unparseable / non-finite dims → null (degrades to 'extend',
 * never throws). Same contract as parseAspectValue on bad input.
 */
function seedAspectFromDims(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return `${w}x${h}`;
}

/**
 * Named resolver seam: aspect treatment for lifestyle/UGC preserve, per
 * (surface × seed kind). Owner 2026-08:
 *
 *   'extend'        — Meta 1:1 / 4:5 / 9:16 (and PMax square/portrait):
 *                     edge extension permitted (~20–44% invented area is honest)
 *   'native'        — seed already matches surface aspect; no extension sentence
 *   'not-supported' — 16:9 / PMax landscape: preserve does NOT apply; fall
 *                     through to today's scene-build for that surface
 *   null            — subject is not lifestyle/ugc; preserve never applies
 *
 * UGC is its OWN branch even though it currently returns the same values as
 * lifestyle. Owner expects to diverge later — change the UGC block alone.
 * Do NOT collapse `variantKind === 'ugc'` and `seedStyle === 'lifestyle'` into
 * a single boolean anywhere downstream of this resolver.
 *
 * 16:9 PMax composition is deliberately deferred, not missing.
 */
function resolveAspectTreatment({ surfaceKey = null, seedStyle = null, variantKind = null, seedAspect = null } = {}) {
  const wide = isWideLandscapeSurface(surfaceKey);

  function nativeOrExtend() {
    if (wide) return 'not-supported';
    const seedVal = parseAspectValue(seedAspect);
    if (seedVal != null && surfaceKey) {
      try {
        const surf = aspectOf(surfaceKey);
        if (surf && Math.abs(seedVal - surf.value) < 0.02) return 'native';
      } catch (_) { /* fall through to extend */ }
    }
    return 'extend';
  }

  // ── UGC branch (own arm — currently mirrors lifestyle; diverge here) ──
  // Changing ONLY this block must change only UGC output (harness pins the seam).
  if (variantKind === 'ugc') {
    // UGC → Meta 1:1/4:5/9:16 + PMax square/portrait → extend (or native).
    // UGC → 16:9 / PMax landscape → not-supported (deferred composition).
    return nativeOrExtend();
  }

  // ── lifestyle branch (independent of UGC) ──
  if (seedStyle === 'lifestyle') {
    // lifestyle → Meta 1:1/4:5/9:16 + PMax square/portrait → extend (or native).
    // lifestyle → 16:9 / PMax landscape → not-supported (deferred composition).
    return nativeOrExtend();
  }

  // packshot / flat_lay / detail / packaging / unknown — preserve never applies
  return null;
}

/**
 * Pure gate for the lifestyle/UGC scene-preserve subject trigger.
 * Flag must be on; then lifestyle seed style OR ugc variantKind.
 * Never packshot / flat_lay / detail / packaging / unknown / ambiguous.
 *
 * Surface treatment is a SEPARATE gate (resolveAspectTreatment) — this only
 * answers "is this the kind of seed preserve can talk about?".
 */
function shouldPreserveScene({ seedStyle = null, variantKind = null } = {}) {
  if (!LIFESTYLE_PRESERVE) return false;
  if (variantKind === 'ugc') return true;
  if (seedStyle === 'lifestyle') return true;
  return false;
}

function buildPrompt({ intentKey, data, product, surface, seedStyle = null, variantKind = null, preserveScene = null, seedAspect = null }) {
  // Explicit preserveScene=true is harness/test only and STILL requires a
  // lifestyle-or-ugc subject — a packshot must never land on SCENE_PRESERVE
  // even when a caller forces the override. preserveScene=false always wins
  // (explicit opt-out). Otherwise derive from seedStyle + variantKind.
  // Surface treatment may still veto (16:9 / PMax landscape → not-supported).
  const subjectOk = seedStyle === 'lifestyle' || variantKind === 'ugc';
  let preserve = preserveScene === true
    ? (LIFESTYLE_PRESERVE && subjectOk)
    : preserveScene === false
      ? false
      : shouldPreserveScene({ seedStyle, variantKind });

  // Per-(surface × seed kind) treatment. 'not-supported' falls through to
  // today's exact scene-build behaviour (byte-identical to preserve-OFF).
  let aspectTreatment = null;
  if (preserve) {
    aspectTreatment = resolveAspectTreatment({
      surfaceKey: surface,
      seedStyle,
      variantKind,
      seedAspect
    });
    if (aspectTreatment === 'not-supported' || aspectTreatment == null) {
      if (aspectTreatment === 'not-supported') {
        // Clear, once-per-call: preserve skipped for this surface and why.
        console.log(
          `⚠️  SCENE_PRESERVE skipped: surface=${surface} treatment=not-supported ` +
          `(16:9/PMax landscape — invented-frame area too large for honest preserve; ` +
          `composition under preserve is deliberately deferred, not missing)`
        );
      }
      preserve = false;
      aspectTreatment = null;
    } else {
      // Positive trace for the LIVE path. Without this the only observable
      // signal was the skip case above, so a paid render that preserved the
      // scene left no evidence it had done so — and "did preserve fire?" is
      // the first question anyone debugging a lifestyle ad will ask.
      // Logs the trigger (lifestyle seed vs ugc variant) because they are
      // deliberately independent branches, and the seed aspect because a
      // null one silently means 'extend'.
      console.log(
        `🖼️  SCENE_PRESERVE applied: surface=${surface} treatment=${aspectTreatment} ` +
        `trigger=${variantKind === 'ugc' ? 'ugc-variant' : 'lifestyle-seed'} ` +
        `seedStyle=${seedStyle || 'null'} seedAspect=${seedAspect || 'null (→extend)'}`
      );
    }
  }

  const policy = SURFACE_POLICY[surface];
  if (!policy) return { error: `unknown surface ${surface}` };
  if (!policy.static) return { skipped: policy.skipReason, surfaceKey: surface };

  const resolved = resolveIntent(intentKey, data);
  if (!resolved.key) return { error: resolved.why };
  const spec = resolved.spec;

  // Intent-aware CTA for pmax only (flag on). Meta and flag-off keep the
  // SURFACE_POLICY object as-is so absences / density / returned policy stay
  // byte-identical to today. When suppressed, reuse the Stories path:
  // strip CTA before applyDensity + absence line with ctaNote.
  const drawCta = resolveDrawCta({ surfaceKey: surface, policy, intentKey: resolved.key });
  const effectivePolicy = drawCta === policy.drawCta
    ? policy
    : {
        ...policy,
        drawCta,
        // Same note Stories uses — the platform supplies the CTA affordance.
        ctaNote: policy.ctaNote || 'the platform supplies the link affordance'
      };

  let text = spec.text({ ...data, cta: data.cta });
  if (!effectivePolicy.drawCta) text = text.filter(([r]) => r !== 'CTA BUTTON');
  const { kept, dropped } = applyDensity(text, spec, effectivePolicy);

  const keptRoles = new Set(kept.map(([r]) => r));
  const kept_ = (role) => keptRoles.has(role);
  // Pass preserve into emphasis + goal so intents can use preserve-aware
  // scene language without touching text() copy roles/order. ownerBrief is
  // documentation-only and never reaches the prompt.
  const goalCtx = { preserve };
  const goalText = typeof spec.goal === 'function' ? spec.goal(kept_, goalCtx) : spec.goal;
  const emphasis = spec.emphasis(data, kept_, { preserve });
  const absent = absences(data, spec.renders, dropped, effectivePolicy);
  const s = computeSurface(surface);

  /**
   * Zero surviving text is legitimate — a surface that strips CTA (PMax
   * non-conversion) with no proof data is just a product image. But emitting
   * the "SET EXACTLY THIS TEXT" heading above an empty list recreates the v1
   * defect exactly: an instruction pointing at a slot with nothing in it.
   * State the absence of text as a positive instruction instead.
   */
  /**
   * The role name goes BEFORE an arrow and is declared non-printing, because
   * "RATING: 4.8 ★" was rendered literally — label and all — in 4 of 5 test
   * renders. Lowercase descriptions read as instructions; uppercase field names
   * read as type to set.
   */
  /**
   * The product-own-print carve-outs. Both no-added-text rules ban letterforms
   * and marks "anywhere in the frame … including on packaging or clothing within
   * the scene" — and on this catalog the product frequently IS the packaging or
   * the clothing, so read literally they order the model to strip a real label.
   * That conflict predates the fidelity hardening; it is fixed alongside it
   * because a block demanding the label be preserved makes it live.
   *
   * Both are anchored to "visible … in the reference photograph", never to "on
   * the product". The looser phrasing is a justification handle: a model that
   * knows the brand's usual neck label or size stamp can invent one and call it
   * something the product already has. The anchor has to be the pixels.
   */
  const carveOutWithCopy = FIDELITY_HARDENING
    ? ' The single exception is lettering already visible on the product itself in the reference photograph: that lettering is part of the product, so it stays exactly as the reference shows it, reproduced and not restyled, and it does not count as text you set.'
    : '';
  const carveOutNoCopy = FIDELITY_HARDENING
    ? ' Lettering, labels and logos already visible on the product itself in the reference photograph are the one exception: they are part of the product and stay exactly as the reference shows them. Reproduce only what is visible there — nothing may be added, and no marking may be inferred from what products of this kind usually carry.'
    : '';
  const textBlock = kept.length
    ? `SET EXACTLY THESE STRINGS, verbatim, each appearing exactly once — and set NOTHING ELSE. This is the complete and only text for this ad. It is not a template to fill in and nothing is missing from it. Spelling is critical; a misspelling makes this unusable.
The words to the LEFT of each arrow name the element for your reference and must NEVER appear in the image. Render ONLY the text to the right of the arrow:
${kept.map(([role, str]) => `  ${role.toLowerCase()} -> ${str}`).join('\n')}
Set no other words, numerals or letterforms anywhere in the image — including on signage, packaging, screens or clothing within the scene.${carveOutWithCopy}`
    : `THIS AD CARRIES NO TEXT AT ALL. Render a pure product image: no words, numerals, letterforms, logos or graphic marks of any kind, anywhere in the frame — including on signage, packaging, screens or clothing within the scene.${carveOutNoCopy} The photograph alone has to do the work.`;

  /**
   * Role framing. Owner-supplied 2026-08-03. Gated with the rest of the hardening
   * so the flag-off arm stays byte-identical to the measured baseline.
   */
  const rolePreamble = FIDELITY_HARDENING
    ? 'You are an expert advertising creative director, commercial product photographer and graphic designer.\n\n'
    : '';

  /**
   * "whether a person appears" — REMOVED from the creative-freedom list when the
   * hardening is on. Owner instruction 2026-08-03, after live renders: a
   * PELAGIC jacket seeded from an ON-MODEL photograph came back as the jacket
   * lying on a deck with nobody in it, in 3 of 6 LEGACY renders and 2 of 6
   * hardened ones. It was not drift — this clause explicitly handed the model
   * the choice, and it took it.
   *
   * Two reasons that is wrong for apparel: an unworn garment is a weaker ad, and
   * it discards the fit and drape information PRODUCT_FIDELITY spends a whole
   * paragraph protecting. It also fights PRODUCT SCALE AND FRAMING, which asks
   * for the same share of frame as the reference — a person competes for that
   * area, so dropping them is the cheapest way to comply.
   *
   * The replacement rule is ASYMMETRIC and lives in PRODUCT_FIDELITY: if the
   * reference shows the item worn or held, a person must stay; if it does not,
   * adding one is discretionary. No new plumbing is needed for that conditional —
   * `buildPrompt` never learns whether the seed contains a person, but the MODEL
   * can see the reference and evaluates the condition itself.
   *
   * Gated so the flag-off arm stays byte-identical to the measured baseline.
   */
  const personClause = FIDELITY_HARDENING ? '' : 'whether a person appears, ';

  /**
   * Platform delivery context — AFTER geometry, because the notes refer to the
   * safe box the geometry block just established. Flag off → empty for every
   * surface (byte-identity). Flag on → pmax only; Meta has no PLATFORM_NOTES
   * entry so its prompt stays byte-identical. Preserve-ON uses the
   * recompose-free arm (resolvePlatformNotes) so PMax square/portrait notes
   * never contradict SCENE_PRESERVE.
   */
  let platformNotesBlock = '';
  {
    const notes = resolvePlatformNotes(surface, { preserve });
    if (notes) platformNotesBlock = `\n\n${notes}`;
  }

  // Fidelity / scene block. Preserve replaces the whole scene-building
  // opening (PRODUCT_FIDELITY or LEGACY) — they cannot be stacked.
  // Flag-off leaves this branch unreachable → byte-identical prompts.
  // aspectTreatment is 'extend' | 'native' when preserve is true.
  const fidelityBlock = preserve
    ? buildScenePreserveBlock(aspectTreatment)
    : (FIDELITY_HARDENING ? PRODUCT_FIDELITY : LEGACY_PRODUCT_FIDELITY);

  // Creative-freedom paragraph. Preserve locks photography; inventiveness
  // is typography/chrome only. Scene-build arm is the pre-existing text
  // (byte-identical when preserve is false).
  const decideBlock = preserve
    ? (kept.length
      ? `COMPOSITING ONLY — you decide typeface and weight, the scale and colour of every text element, whether copy sits on a soft scrim or panel for legibility or in clear space, and where each element goes inside the safe box. The photograph is finished: inventiveness belongs only in typography and chrome, never in the pixels of the scene.`
      : `COMPOSITING ONLY — the photograph is finished and this ad carries no text. Inventiveness is not invited; leave the plate as the reference shows it.`)
    : `YOU DECIDE EVERYTHING ELSE: composition and crop, camera angle and distance, ${personClause}lighting and mood${kept.length ? ', typeface and weight, the scale and colour of every text element, whether copy sits on a panel or in clear space, and where each element goes' : ''}. ${product.look ? `The brand's world is: ${product.look}. Work within it, and beyond that use your own judgement — ` : 'Use your own judgement — '}make it look like a campaign a good agency shipped, not a template that was filled in. Inventiveness belongs in the photography, the light and the typography — never in the claims.`;

  const prompt = `${rolePreamble}Produce a finished, ready-to-publish direct-response advertisement for ${s.label}.

${fidelityBlock}

PRODUCT: ${product.desc}

WHAT THIS AD HAS TO DO: ${goalText}

WHAT SHOULD WIN ATTENTION, in this order:
${emphasis.map((e, i) => `  ${i + 1}. ${e}`).join('\n')}
That is an order of importance, not a layout, and not a checklist. Express it however reads fastest.

${textBlock}

${decideBlock}

THIS PRODUCT HAS NONE OF THE FOLLOWING, so none of it may appear:
${absent.map(a => `  — ${a}`).join('\n')}
If an element is not listed in the text above, it does not exist, and its absence is the accurate brief rather than a gap to fill. Leave the space empty rather than filling it — empty space is a legitimate design choice and inventing proof is not.

Keep the ${product.logoCorner || 'bottom-right'} corner clear of text and graphics — the corner of the SAFE BOX described below, not of the frame you are generating. The real logo is composited into that space afterwards, inside the safe box, because anything outside it is either cut away by the delivery crop or covered by the platform's own interface.

${geometryBlock(s)}${platformNotesBlock}`;

  return {
    prompt,
    resolved,
    absent,
    emphasis,
    text: kept,
    dropped,
    surface: s,
    policy: effectivePolicy,
    preserveScene: preserve,
    aspectTreatment: preserve ? aspectTreatment : null
  };
}

module.exports = {
  INTENTS,
  SURFACE_POLICY,
  SACRIFICE_ORDER,
  FALLBACK_ORDER,
  buildPrompt,
  PRODUCT_FIDELITY,
  SCENE_PRESERVE,
  SCENE_PRESERVE_EDGE_EXTEND,
  buildScenePreserveBlock,
  LIFESTYLE_PRESERVE,
  shouldPreserveScene,
  resolveAspectTreatment,
  isWideLandscapeSurface,
  resolveIntent,
  absences,
  applyDensity,
  computeSurface,
  geometryBlock,
  EDGE_MARGIN_PCT,
  SURFACE_EDGE_MARGIN_PCT,
  describeSurfaces,
  BRAND_LED_COPY,
  // Phase B PMax static overlay — harnesses call these directly.
  PMAX_STATIC_PLATFORM_NOTES,
  PLATFORM_NOTES,
  PLATFORM_NOTES_PMAX_PRESERVE,
  PLATFORM_NOTES_PMAX_SCENE_BUILD,
  resolvePlatformNotes,
  destinationForSurface,
  resolveDrawCta,
  // Seed aspect from Media.width/height — production path for 'native' arm.
  seedAspectFromDims,
  parseAspectValue
};
