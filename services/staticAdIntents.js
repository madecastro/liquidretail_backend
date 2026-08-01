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
// The only sizes the edit endpoint accepts. Verified live, not assumed.
const GEN_SIZES = [
  { w: 1024, h: 1024 },
  { w: 1024, h: 1536 },
  { w: 1536, h: 1024 }
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

  // Text-safe box in generated pixels, before the margin convention.
  let x0 = cropLeftPx;
  let x1 = cropLeftPx + keptW;
  let y0 = cropTopPx + topReservePx;
  let y1 = cropTopPx + keptH - botReservePx;

  // Edge margin, applied against the generated frame's short side.
  const marginPx = (EDGE_MARGIN_PCT / 100) * Math.min(gen.w, gen.h);
  x0 = Math.max(x0, marginPx);
  x1 = Math.min(x1, gen.w - marginPx);
  y0 = Math.max(y0, marginPx);
  y1 = Math.min(y1, gen.h - marginPx);

  const pct = (v, total) => +( (v / total) * 100 ).toFixed(1);

  return {
    key,
    label: pf.PLATFORM_FORMATS[key].label,
    aspect: aspect.str,
    generate: `${gen.w}x${gen.h}`,
    deliver: `${pf.PLATFORM_FORMATS[key].deliveryDims.width}x${pf.PLATFORM_FORMATS[key].deliveryDims.height}`,
    cropPx: { left: cropLeftPx, right: cropLeftPx, top: cropTopPx, bottom: cropTopPx },
    platformReservePx: { top: Math.round(topReservePx), bottom: Math.round(botReservePx) },
    platformReserveDeclared: { top: safe.top || 0, bottom: safe.bottom || 0, left: safe.left ?? null, right: safe.right ?? null },
    box: { left: pct(x0, gen.w), right: pct(x1, gen.w), top: pct(y0, gen.h), bottom: pct(y1, gen.h) },
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
    lines.push(`The platform then covers the top ${s.platformReservePx.top}px and bottom ${s.platformReservePx.bottom}px of the surviving image with its own interface.`);
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
  // Separate the two: the garment's own mark is product identity, not ad chrome.
  out.push('no product name, website, hashtag or small print');
  out.push('no added brand logo, wordmark or lockup anywhere in the scene — any logo already printed on the garment itself stays exactly as it is, but nothing new is drawn');
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
  const textBlock = kept.length
    ? `SET EXACTLY THESE STRINGS, verbatim, each appearing exactly once. Spelling is critical; a misspelling makes this unusable.
The words to the LEFT of each arrow name the element for your reference and must NEVER appear in the image. Render ONLY the text to the right of the arrow:
${kept.map(([role, str]) => `  ${role.toLowerCase()} -> ${str}`).join('\n')}
Set no other words, numerals or letterforms anywhere in the image — including on signage, packaging, screens or clothing within the scene.`
    : `THIS AD CARRIES NO TEXT AT ALL. Render a pure product image: no words, numerals, letterforms, logos or graphic marks of any kind, anywhere in the frame — including on signage, packaging, screens or clothing within the scene. The photograph alone has to do the work.`;

  const prompt = `Produce a finished, ready-to-publish direct-response advertisement for ${s.label}.

The supplied photograph is a PRODUCT REFERENCE ONLY. Reproduce this exact item faithfully — its colour, material, construction and any branding printed on the product itself — then build an entirely new scene around it. Do not reuse the reference's background, crop or lighting.

PRODUCT: ${product.desc}

WHAT THIS AD HAS TO DO: ${typeof spec.goal === 'function' ? spec.goal(kept_) : spec.goal}

WHAT SHOULD WIN ATTENTION, in this order:
${emphasis.map((e, i) => `  ${i + 1}. ${e}`).join('\n')}
That is an order of importance, not a layout. Express it however reads fastest.

${textBlock}

YOU DECIDE EVERYTHING ELSE: composition and crop, camera angle and distance, whether a person appears, lighting and mood${kept.length ? ', typeface and weight, the scale and colour of every text element, whether copy sits on a panel or in clear space, and where each element goes' : ''}. ${product.look ? `The brand's world is: ${product.look}. Work within it, and beyond that use your own judgement — ` : 'Use your own judgement — '}make it look like a campaign a good agency shipped, not a template that was filled in. Inventiveness belongs in the photography, the light and the typography — never in the claims.

THIS PRODUCT HAS NONE OF THE FOLLOWING, so none of it may appear:
${absent.map(a => `  — ${a}`).join('\n')}
If an element is not listed in the text above, it does not exist. Leave the space empty rather than filling it — empty space is a legitimate design choice and inventing proof is not.

Keep the ${product.logoCorner || 'bottom-right'} corner OF THE SAFE BOX described below clear of text and graphics — not the corner of the frame you are generating. The real logo is composited into that space afterwards, and it is placed inside the safe box because anything outside it is either cut away by the delivery crop or covered by the platform's own interface.

${geometryBlock(s)}`;

  return { prompt, resolved, absent, emphasis, text: kept, dropped, surface: s, policy };
}

module.exports = {
  INTENTS,
  SURFACE_POLICY,
  SACRIFICE_ORDER,
  FALLBACK_ORDER,
  buildPrompt,
  resolveIntent,
  absences,
  applyDensity,
  computeSurface,
  geometryBlock,
  EDGE_MARGIN_PCT,
  describeSurfaces
};
