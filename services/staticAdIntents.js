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
const GEN_SIZES = [
  { w: 1024, h: 1024 },
  { w: 1024, h: 1536 },
  { w: 1536, h: 1024 },
  { w: 1152, h: 2048 }, // enum member, exact 9:16; absent before → 15.6% side crop
  { w: 1088, h: 1360 }  // PROBED non-enum, exact 4:5; absent before → 16.7% top/bottom crop
];

const EDGE_MARGIN_PCT = 6; // convention, ours — not a platform reserve

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
  const marginPx = (EDGE_MARGIN_PCT / 100) * Math.min(keptW, keptH);

  let x0 = cropLeftPx + marginPx;
  let x1 = cropLeftPx + keptW - marginPx;
  let y0 = cropTopPx + topReservePx + marginPx;
  let y1 = cropTopPx + keptH - botReservePx - marginPx;

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
  // which on Stories (platform supplies it) contradicted the absence list — the
  // same empty-slot defect that produced a fabricated quote in v1.
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
 *  2. WHO SUPPLIES THE CTA. Where the ad unit provides its own link affordance,
 *     drawing a button into the pixels duplicates it and burns the reserved band.
 *
 * CONFIDENCE, stated so it can be corrected rather than inherited:
 *   - reels video-only ....... from platformFormats.kinds (authoritative here)
 *   - stories link sticker ... owner-stated; bottom 250px is the reply bar
 *   - pmax draws its own ..... from this repo's brief: "prominent CTA"
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
  meta_stories_9_16: { static: true,  drawCta: false, maxTextElements: 3,
                       ctaNote: 'the platform supplies the link affordance' },
  pmax_16_9:         { static: true,  drawCta: true,  maxTextElements: 4 }
};

/**
 * Which element goes first when over the density budget. Earlier = sacrificed
 * sooner. A role in an intent's `core` is never sacrificed — losing it would
 * defeat the intent, in which case the intent should not have run.
 */
const SACRIFICE_ORDER = ['BADGE', 'ATTRIBUTION', 'TRUST MARK', 'CUSTOMER QUOTE', 'RATING', 'BRAND LINE'];

// ── absence, stated ─────────────────────────────────────────────────────
/**
 * Flags describe what the INTENT renders, not merely what the data holds — an
 * intent that never shows a quote must say so even when a quote exists, or the
 * model borrows it from context.
 */
function absences(d, { rendersQuote, rendersRating, rendersBadge }, dropped = [], policy = {}) {
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
    emphasis: (d, kept) => [
      'the product itself, shown large and desirable',
      d.reviewCount ? 'the rating and how many people gave it' : 'the rating',
      kept('CUSTOMER QUOTE') ? "the customer's own words" : null,
      kept('BADGE') ? 'the badge, quietly' : null,
      kept('CTA BUTTON') ? 'the CTA, unmissable but not shouting' : null
    ].filter(Boolean),
    text: (d) => [
      ['RATING', d.reviewCount ? `${d.rating} ★ (${d.reviewCount} reviews)` : `${d.rating} ★`],
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
    emphasis: (d, kept) => [
      'the product in a scene someone wants to be in',
      kept('BRAND LINE') ? "the brand's line" : null,
      kept('TRUST MARK') ? 'a quiet trust mark, secondary to everything above' : null,
      kept('CTA BUTTON') ? 'the CTA' : null
    ].filter(Boolean),
    text: (d) => [
      d.headline ? ['BRAND LINE', d.headline] : null,
      d.rating ? ['TRUST MARK', `${d.rating} ★`] : null,
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
    emphasis: (d, kept) => [
      "the customer's sentence, as the loudest thing in the frame",
      'the product, clearly the thing being talked about',
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
const PRODUCT_FIDELITY = `PRODUCT FIDELITY — HIGHEST PRIORITY. Wherever product accuracy conflicts with a creative or styling instruction below, product accuracy wins. This does not relax the text instructions below, which are absolute in their own right, and it does not override the reserved-corner rule below.
The supplied reference photograph is the single source of truth for the product; where several are supplied, the first is the primary product reference and the rest are further views of the same item. It is a PRODUCT REFERENCE ONLY — not a composition to copy. Treat every visible characteristic of the item as immutable. This advertisement must feature the exact same physical item that reference shows, as though that same item had been carried into a new photoshoot and photographed again — not recreated from memory. Do not redesign, reinterpret, simplify, modernise, improve, repair, stylise, approximate or substitute any part of it.
Do not infer the product from its category, and do not infer it from anything you know about the brand. If the reference disagrees with what products of this type usually look like, or with your prior knowledge of this brand, the reference is correct and your prior is wrong.

PRESERVE EXACTLY, as the reference shows it:
  — Form: shape, proportions, dimensions, silhouette, geometry, profile, contours, edges and curvature. Fit and cut are part of the form and may not be altered, though the item may of course be posed, worn or placed differently.
  — Construction: seams, stitching, panel layout, assembly, joints, fasteners, hardware, hinges, closures, buttons, buckles, snaps, zips, clasps, laces, straps.
  — Surface: material, fabric, leather, knit, wood grain, metal and plastic finish, gloss, matte, texture, weave, grain, embossing, engraving, reflectivity, transparency, opacity.
  — Colour: the item's own colours exactly. Do not shift hue, recolour, bleach, tint, darken, brighten, or invent an alternate colourway. New lighting may fall across those colours; it may not change them.
  — Graphics already on the item: logos, branding, icons, artwork, patterns, prints, typography, embroidery, embossing, debossing, decals, labels and tags — same wording, same lettering, same placement, same scale. Reproduce them from the reference; never redraw them from imagination, and never add, remove or modify any branding. This preserves marks that are ALREADY on the item; it is never licence to place a brand mark anywhere else in the frame.
  — Details, including but not limited to: pockets, collars, sleeves, cuffs, necklines, hems, soles, heels, eyelets, handles, bezels, screens, lenses, caps, applicators, gemstones, chain links, watch faces, grips, blades, wheels, buttons, ports, vents and sensors. Every feature visible in the reference must appear unchanged; no feature absent from the reference may be added.
  — Condition: wrinkles, folds, creases, wear, polish, finish, and the shadows the item casts on itself. Do not “improve” the item, smooth its surfaces, or clean away its natural characteristics.

NEVER: substitute a similar-looking version; invent a feature that is absent; remove a visible feature; redesign any component; merge this item with another design; produce a newer, cleaner, alternative or special edition of it; produce a different size, fit or variation; simplify it; stylise it; or hallucinate any detail that is not visible in the reference.
If part of the item is not visible in the reference, do not invent or redesign the hidden portion. Infer only the minimum geometry a believable photograph needs, fully consistent with the parts you can see — and infer geometry only, never a graphic, a label or a marking.

WHAT MAY CHANGE — everything that is not the item itself, and you should change it: the model or models, pose, hands, how and where the item is worn or placed, environment, background, set, props, styling, lighting, mood, composition, crop, camera, perspective, focal length, depth of field, the colour grading of the scene, and the typographic treatment of the copy specified below. Build an entirely new scene around the item; do not reuse the reference's background, crop or lighting.

BEFORE YOU FINISH, check two things. The product: a customer would recognise it as the identical item, your image could pass as another photograph of that same physical item, and no feature of the item has been added, removed, modified, recoloured or reshaped — judged on the item itself, not on where it sits in the new frame. The copy: every string you were given below appears exactly once, spelled exactly as given, and no other text appears anywhere. If either check fails, correct it before finishing the advertisement.`;

function buildPrompt({ intentKey, data, product, surface }) {
  const policy = SURFACE_POLICY[surface];
  if (!policy) return { error: `unknown surface ${surface}` };
  if (!policy.static) return { skipped: policy.skipReason, surfaceKey: surface };

  const resolved = resolveIntent(intentKey, data);
  if (!resolved.key) return { error: resolved.why };
  const spec = resolved.spec;

  let text = spec.text({ ...data, cta: data.cta });
  if (!policy.drawCta) text = text.filter(([r]) => r !== 'CTA BUTTON');
  const { kept, dropped } = applyDensity(text, spec, policy);

  const keptRoles = new Set(kept.map(([r]) => r));
  const kept_ = (role) => keptRoles.has(role);
  const emphasis = spec.emphasis(data, kept_);
  const absent = absences(data, spec.renders, dropped, policy);
  const s = computeSurface(surface);

  /**
   * Zero surviving text is legitimate — Stories with no proof data and a
   * platform-supplied link is just a product image. But emitting the "SET
   * EXACTLY THIS TEXT" heading above an empty list recreates the v1 defect
   * exactly: an instruction pointing at a slot with nothing in it. State the
   * absence of text as a positive instruction instead.
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

  const prompt = `Produce a finished, ready-to-publish direct-response advertisement for ${s.label}.

${FIDELITY_HARDENING ? PRODUCT_FIDELITY : LEGACY_PRODUCT_FIDELITY}

PRODUCT: ${product.desc}

WHAT THIS AD HAS TO DO: ${typeof spec.goal === 'function' ? spec.goal(kept_) : spec.goal}

WHAT SHOULD WIN ATTENTION, in this order:
${emphasis.map((e, i) => `  ${i + 1}. ${e}`).join('\n')}
That is an order of importance, not a layout, and not a checklist. Express it however reads fastest.

${textBlock}

YOU DECIDE EVERYTHING ELSE: composition and crop, camera angle and distance, whether a person appears, lighting and mood${kept.length ? ', typeface and weight, the scale and colour of every text element, whether copy sits on a panel or in clear space, and where each element goes' : ''}. ${product.look ? `The brand's world is: ${product.look}. Work within it, and beyond that use your own judgement — ` : 'Use your own judgement — '}make it look like a campaign a good agency shipped, not a template that was filled in. Inventiveness belongs in the photography, the light and the typography — never in the claims.

THIS PRODUCT HAS NONE OF THE FOLLOWING, so none of it may appear:
${absent.map(a => `  — ${a}`).join('\n')}
If an element is not listed in the text above, it does not exist, and its absence is the accurate brief rather than a gap to fill. Leave the space empty rather than filling it — empty space is a legitimate design choice and inventing proof is not.

Keep the ${product.logoCorner || 'bottom-right'} corner clear of text and graphics — the corner of the SAFE BOX described below, not of the frame you are generating. The real logo is composited into that space afterwards, inside the safe box, because anything outside it is either cut away by the delivery crop or covered by the platform's own interface.

${geometryBlock(s)}`;

  return { prompt, resolved, absent, emphasis, text: kept, dropped, surface: s, policy };
}

module.exports = {
  INTENTS,
  SURFACE_POLICY,
  SACRIFICE_ORDER,
  FALLBACK_ORDER,
  buildPrompt,
  PRODUCT_FIDELITY,
  resolveIntent,
  absences,
  applyDensity,
  computeSurface,
  geometryBlock,
  EDGE_MARGIN_PCT,
  describeSurfaces
};
