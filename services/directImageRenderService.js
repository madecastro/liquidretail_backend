// THE production static-ad path. There is no other one for a brand that is not
// explicitly on the legacy HTML fallback.
//
// Director-approved concept + product reference -> ONE gpt-image-2 edit call that
// returns the FINISHED advertisement, copy typeset by the model -> Sharp crops to
// delivery size and composites the real logo.
//
// Rewritten 2026-07-31. It previously asked the model for a deliberately
// text-free "plate" and composited every string locally as SVG ("direct image +
// exact overlay"). That mode is retired at owner instruction — never used, and
// nobody liked the output. The prompts driving the new path are NOT new work:
// they are the owner-reviewed intent specs proven over ~55 real renders
// (services/staticAdIntents.js), whose measured text fidelity on the corrected
// comparator was 139/140 strings across 20 renders, 19 of 20 perfect.
//
// THE ONE EXCEPTION to "the model renders everything" is the LOGO, and it is
// owner-specified: the logomark must never be fed to the image model, because a
// redrawn wordmark reads as a counterfeit rather than a stylisation. The prompt
// reserves a corner and forbids drawing any logo; the real asset is composited
// into that reserved space here.

'use strict';

const axios = require('axios');
const sharp = require('sharp');

const atlasImage = require('./atlasImageService');
const LayoutInputArtifact = require('../models/LayoutInputArtifact');
const CreativeDirectionArtifact = require('../models/CreativeDirectionArtifact');
const Brand = require('../models/Brand');
const CatalogProduct = require('../models/CatalogProduct');
const Media = require('../models/Media');
const intents = require('./staticAdIntents');
const { isHtmlPipeline, DIRECT_IMAGE } = require('./staticPipeline');
// Defence in depth. layoutInputService already withholds these at pool
// assembly, so this gate should never fire — it exists because an artifact
// cached before the producer-side filter landed can still carry one.
const { isPrintableCustomerQuote } = require('./quoteProvenance');

const PLATE_EDIT_MODEL = process.env.AI_DIRECT_IMAGE_EDIT_MODEL || 'openai/gpt-image-2/edit';
// No AI_DIRECT_IMAGE_MODEL / text-to-image constant. Owner instruction: "there
// should never be a text to image fallback period" / "if there is no image
// there is no generation" — the taggedError thrown below when refs.length is 0
// is the only handling a missing reference gets.
// MEASURED, not assumed — and the reason changed on 2026-07-31, so the old
// justification is recorded here to stop someone "restoring" high.
//
// The previous comment said medium was fine because "Sharp performs the final
// crop, typography, logo, and export". That reasoning died with the overlay
// renderer: the model now typesets the copy itself, so text fidelity is the
// whole game and quality is no longer cosmetic.
//
// medium is still correct, now for a stronger reason — it measured BOTH faster
// AND more accurate than high: ~95s for 7-of-7 strings rendered correctly,
// against 242s for 6-of-7 at high. Raising this costs 2.5x the wall time and
// measurably loses a string. Re-measure before changing it.
const PLATE_QUALITY = process.env.AI_DIRECT_IMAGE_QUALITY || 'medium';
// MEASURED, 2026-07-31: a real openai/gpt-image-2/edit call with exactly the
// payload this service sends (1 reference, 1024x1024, quality medium) took
// **69.7s** end to end — status 'processing' at every poll through t=62.7s,
// 'completed' at t=69.7s.
//
// The previous 60s bound therefore sat BELOW the model's typical latency. It
// did not merely fail slow renders; it failed most of them, and intermittently
// — an identical batch rendered fine earlier the same day, because latency
// straddles the boundary. Worse, Atlas bills on submit and a poll timeout is
// marked `charged`, so every one of those paid for an image that finished a
// few seconds after we stopped listening, then threw it away.
//
// 600s. Deliberately generous, because waiting is now nearly free: the poller
// reads Atlas's error envelope ({code,msg} + HTTP status) and fails the moment
// the provider actually rejects something, so a long ceiling is only ever
// spent on a request that is genuinely still processing. Before that fix a
// large timeout would have meant sitting on a dead request for the full
// duration, which is why a tight bound looked reasonable.
//
// NOT unbounded, and the ceiling is not arbitrary: worker.js reaps ads stale
// in 'rendering' at REAP_STALE_MIN (default 15 min / 900s), after which an ad
// can be reclaimed and re-selected into another run — a second billable
// submit for one ad. 600s keeps a 5-minute margin under that, so a slow
// render can never be reaped out from under itself.
//
// Tune with AI_DIRECT_IMAGE_TIMEOUT_MS. Keep it below REAP_STALE_MIN, and
// re-measure before lowering it toward the ~70s floor.
const PLATE_TIMEOUT_MS = Number(process.env.AI_DIRECT_IMAGE_TIMEOUT_MS || 600_000);
const REFERENCE_TIMEOUT_MS = Number(process.env.AI_DIRECT_REFERENCE_TIMEOUT_MS || 15_000);
const UPLOAD_TIMEOUT_MS = Number(process.env.AI_DIRECT_UPLOAD_TIMEOUT_MS || 20_000);

// Pipeline resolution deliberately does NOT live here any more. It moved to
// services/staticPipeline.js so the route that writes the field, the model that
// stores it and this renderer all consult one implementation — re-deriving the
// `value || default` coercion per caller is how a pipeline flag drifts.


// Delivery geometry, derived from the one surface object the prompt was built
// from. The GENERATION size comes from the intent module's surface computation,
// because the prompt's geometry block tells the model in as many words which
// pixels will survive the crop ("the top and bottom 128px of what you generate
// WILL BE CUT AWAY"). If anything here chose a size independently, that sentence
// could contradict the request we actually send, and the model would protect the
// wrong region.
//
// That warning used to sit directly above a function that did exactly what it
// warned against. `dimsFor(aspectRatio)` was a hand-written switch whose
// `default` returned 1000x1000, so every aspect it did not name — '16:9' among
// them — was silently squared, and a pmax landscape ad has been squashed into a
// square since static fan-out started emitting pmax_16_9. The three sizes it did
// name were the `canvas` fields of platformFormats.js (a 1000px reference width
// belonging to the retired HTML/Puppeteer path), not the `deliveryDims` fields,
// so the geometry block promised the model "delivered at 1080x1080" while Sharp
// wrote 1000x1000. The comment above it was false about all four cases, the
// 256px it quoted included: geometryBlock speaks the PER-EDGE half, so 4:5 reads
// "128px".
//
// Split in two along the billable line. A submit to the image model is charged
// on submit (CLAUDE.md §2), so every check that CAN run before it MUST run
// before it — validating geometry after the pixels come back means paying for a
// render we then refuse.

/**
 * Pre-submit. Frame-independent, so it runs before anything is charged.
 *
 * Validates that the surface can be delivered at all, and — the part worth
 * having — asserts that its kept region scales UNIFORMLY to its delivery box.
 * The caller resizes with fit:'fill', which is a pure scale only while those two
 * share an aspect. A deliveryDims that drifted from its own aspectRatio would
 * otherwise stretch every ad on that surface by a few percent, which is exactly
 * the kind of wrongness that ships unnoticed for months.
 */
function deliveryGeometryFor(s) {
  const [aw, ah] = String(s?.aspect || '').split(':').map(Number);
  const [deliverW, deliverH] = String(s?.deliver || '').split('x').map(Number);
  const [genW, genH] = String(s?.generate || '').split(/[x*]/).map(Number);
  if (!(aw > 0 && ah > 0 && deliverW > 0 && deliverH > 0 && genW > 0 && genH > 0)) {
    throw taggedError(
      `surface ${s?.key || 'unknown'} has no usable delivery geometry ` +
      `(aspect=${s?.aspect} generate=${s?.generate} deliver=${s?.deliver})`,
      { alertLevel: 'error', alertKey: 'direct-image:surface-geometry' }
    );
  }
  // The kept region the geometry block promised the model, in generated pixels.
  const c = s.cropPx || {};
  const keepW = genW - (c.left || 0) - (c.right || 0);
  const keepH = genH - (c.top || 0) - (c.bottom || 0);
  if (!(keepW > 0 && keepH > 0)) {
    throw taggedError(
      `surface ${s.key}: crop ${JSON.stringify(c)} leaves a degenerate ${keepW}x${keepH} region of ${genW}x${genH}`,
      { alertLevel: 'error', alertKey: 'direct-image:surface-geometry' }
    );
  }
  const sx = deliverW / keepW;
  const sy = deliverH / keepH;
  if (Math.abs(sx - sy) / Math.max(sx, sy) > 0.005) {
    throw taggedError(
      `surface ${s.key}: kept region ${keepW}x${keepH} does not scale uniformly to ` +
      `${deliverW}x${deliverH} (${sx.toFixed(4)} vs ${sy.toFixed(4)}) — refusing to stretch the creative`,
      { alertLevel: 'error', alertKey: 'direct-image:surface-geometry' }
    );
  }
  return { width: deliverW, height: deliverH };
}

/**
 * Post-submit. The CENTRED extract, computed from the frame we actually got
 * back rather than the frame we asked for — a model that returns an off-size
 * image still gets cropped to the right aspect instead of being stretched.
 *
 * Centred is not a stylistic choice: geometryBlock tells the model a specific
 * symmetric band "WILL BE CUT AWAY and never seen", so these are the pixels it
 * was instructed to treat as already gone. The previous implementation ran
 * `fit:'cover', position:'attention'`, a saliency crop that removes whichever
 * edges Sharp's heuristic prefers — so the model protected one region and we
 * discarded a different one, on every non-1:1 surface.
 */
function extractFor(s, frameW, frameH) {
  const [aw, ah] = String(s?.aspect || '').split(':').map(Number);
  if (!(frameW > 0 && frameH > 0)) {
    throw new Error(`cannot crop a ${frameW}x${frameH} frame for surface ${s?.key}`);
  }
  const target = aw / ah;
  let keepW = frameW;
  let keepH = frameH;
  if (frameW / frameH > target) keepW = Math.round(frameH * target);
  else if (frameW / frameH < target) keepH = Math.round(frameW / target);
  return {
    left: Math.floor((frameW - keepW) / 2),
    top: Math.floor((frameH - keepH) / 2),
    width: keepW,
    height: keepH
  };
}

/**
 * The prompt's safe box, in DELIVERED pixels.
 *
 * computeSurface expresses the box as percentages of the GENERATED frame,
 * because that is the frame the model is drawing into. Anything composited
 * afterwards lives in the delivered frame, so it has to cross two transforms to
 * land in the same place the model was told to keep clear: subtract the crop,
 * then scale the kept region up to the delivery box.
 */
function safeBoxInDeliveredPx(s, dims) {
  const [genW, genH] = String(s.generate).split(/[x*]/).map(Number);
  const c = s.cropPx || {};
  const keepW = genW - (c.left || 0) - (c.right || 0);
  const keepH = genH - (c.top || 0) - (c.bottom || 0);
  const sx = dims.width / keepW;
  const sy = dims.height / keepH;
  const b = s.box || {};
  return {
    left:   Math.round(((b.left   / 100) * genW - (c.left || 0)) * sx),
    right:  Math.round(((b.right  / 100) * genW - (c.left || 0)) * sx),
    top:    Math.round(((b.top    / 100) * genH - (c.top  || 0)) * sy),
    bottom: Math.round(((b.bottom / 100) * genH - (c.top  || 0)) * sy)
  };
}

/**
 * Where the composited logomark goes.
 *
 * Derived from the SAME safe box the prompt just described to the model, not
 * from a margin chosen here. That distinction is the entire bug: the previous
 * placement was a flat `top: height - 100`, which on Stories put the brand's
 * logomark 150px inside the 250px reply-bar reserve — invisible in feed, on the
 * one element the owner specified must be composited rather than drawn. Picking
 * a fresh margin here instead would have reintroduced the same class of drift:
 * measured against the real surfaces, a 4%-of-short-edge margin lands the mark
 * outside the promised box on three of the four.
 *
 * Returns null when the box cannot fit the mark, so the caller skips the
 * composite rather than placing it somewhere the model did not reserve.
 */
function logoPlacementFor({ surface, dims, logoW, logoH }) {
  const box = safeBoxInDeliveredPx(surface, dims);
  // Clamp the BOX into the delivered frame before placing anything in it, rather
  // than clamping the result afterwards. Clamping afterwards can shove the mark
  // back across the very edge the box exists to enforce — and the percentage
  // round-trip does put an edge a pixel outside on 4:5 (top computes to -1), so
  // this is not hypothetical arithmetic.
  const left = Math.max(0, box.left);
  const right = Math.min(dims.width, box.right);
  const top = Math.max(0, box.top);
  const bottom = Math.min(dims.height, box.bottom);
  if (!(logoW > 0 && logoH > 0)) return null;
  if (right - left < logoW || bottom - top < logoH) return null;
  // Bottom-right of the clamped box. Inside it by construction, so there is no
  // second adjustment that could invalidate the guarantee above.
  return { top: bottom - logoH, left: right - logoW, width: logoW, height: logoH };
}

/**
 * Normalise a reference before it goes to the image model.
 *
 * The old path uploaded raw bytes from axios under the filename
 * `reference-N.png` with mime `image/png` — but Shopify and Cloudinary serve
 * JPEG and WebP, so the declared type was frequently a lie. The sibling service
 * already learned this the hard way and left a note: "gpt-image-1 accepts PNG
 * most reliably, so normalize via sharp before sending", with a retry path for
 * edit rejections caused by "MIME sniffing mismatch".
 *
 * The proven prototype resized to 1024 on the long edge (fit: 'inside') and
 * re-encoded as PNG before every one of its successful renders, so that is what
 * is done here. It also cuts upload bytes, which is pure latency on a call whose
 * median is ~97s.
 */
async function normalizeReference(buf) {
  try {
    return await sharp(buf).resize(1024, 1024, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  } catch (err) {
    // A reference we cannot decode is worse than no reference: it would be
    // uploaded as a mislabelled blob and rejected by the provider mid-render.
    console.warn(`   ⚠️  direct-image: reference normalise failed (${err.message}) — dropping this reference`);
    return null;
  }
}

/** The product sentence the prompt opens with. */
function describeProductForPrompt({ concept, product, layoutInput }) {
  // Prefer the Director's own description of what it composed around; it is
  // written for this concept. Fall back to catalog title, then the layout
  // input's product block. Never the product NAME alone as ad copy — the name is
  // dropped by owner instruction and separately forbidden in the absence block;
  // this string is briefing text for the model, not text to render.
  const fromConcept = concept?.product_description || concept?.subject || null;
  return String(
    fromConcept
    || product?.title
    || layoutInput?.product?.name
    || 'the product shown in the supplied photograph'
  ).slice(0, 400).trim();
}

/** The brand's visual world, handed to the model instead of a font family. */
function conceptLook(concept, layoutInput) {
  const parts = [
    concept?.art_direction || concept?.rationale || null,
    concept?.emotional_hook || null,
    layoutInput?.brand?.visual_style || null
  ].filter(Boolean).map(v => String(v).trim());
  if (!parts.length) return null;
  return parts.join(' ').slice(0, 600);
}

// ── The SVG overlay renderer was DELETED here on 2026-07-31 ───────────────
//
// Owner instruction: "kill the direct image with overlay path, it was never used
// and nobody liked it." Removed with it: escapeXml, safeColor, wrap, linesSvg,
// themeFor, buildOverlay, buildGraphicOverlay, pangoMarkup, textComposite,
// resolveDirectFonts and buildTextLayers — roughly 175 lines whose only job was
// to composite headline / subheadline / eyebrow / CTA / brand chrome as SVG over
// a deliberately text-free plate.
//
// The image model now typesets that copy itself, from the proven intent prompts
// in services/staticAdIntents.js. Deleted rather than left dormant on purpose:
// this repo's single most expensive habit is retiring a path by kill-switch and
// leaving the code (and its docs) in place, so the next reader cannot tell what
// actually runs. Nothing outside this file imported any of them.
//
// Brand fonts are no longer resolved for static ads at all. That is not a
// regression to fix by re-adding a font pass: the model chooses typography, and
// the prompt hands it the brand's visual world instead of a font family. Video
// titling still uses fontResolverService and is untouched.

async function fetchBuffer(url) {
  const response = await axios.get(url, { responseType: 'arraybuffer', timeout: REFERENCE_TIMEOUT_MS });
  return Buffer.from(response.data);
}

async function optionalImage(url) {
  if (!url) return null;
  try { return await fetchBuffer(url); } catch (err) { console.warn(`   ⚠️  direct-image: reference fetch failed (${err.message})`); return null; }
}

/**
 * Which intent a template asks for. The intent module walks DOWN its own
 * hierarchy when the data cannot support the request, so this only has to state
 * the preference — it can never render a hollow ad by picking wrong.
 *
 * ai_promotional maps to objection_resolved on purpose: the promotional template
 * was price-led, pricing is switched off system-wide, and the owner replaced that
 * intent with objection-resolution. Everything unrecognised falls to
 * product_first_lifestyle, which is the floor of the hierarchy and always
 * eligible — an unknown template degrades to "a good product photograph", never
 * to a broken render.
 */
const TEMPLATE_INTENT = {
  ai_social_proof_led: 'social_proof_led',
  ai_promotional: 'objection_resolved'
};
const DEFAULT_INTENT = 'product_first_lifestyle';

function intentForTemplate(template) {
  return TEMPLATE_INTENT[String(template || '')] || DEFAULT_INTENT;
}

/**
 * Map the real pipeline data onto the intent module's `data` shape.
 *
 * Every field here is READ, never derived, and never defaulted to something
 * plausible. That is the whole point: the intent module states absent fields as
 * explicit prohibitions ("this ad has NO rating"), and it can only do that
 * correctly if a missing value arrives as undefined rather than as a stand-in.
 * A fabricated rating or a borrowed testimonial is the exact failure the owner
 * ruled out, and v1 of this prompt work produced one by filling an empty slot.
 *
 * Note what is deliberately NOT passed:
 *   - defaults.fallback_quote / fallback_headline — a fallback quote is not a
 *     customer's words. Passing it would launder invented proof through a field
 *     named "quote".
 *   - trusted_by_text — a derived claim ("Trusted by 5k+ customers"), not a
 *     verbatim rating, and the absence block already fences trust marks.
 *   - proof_badges — derived from the rating (badges:['top rated'] when >=4.5),
 *     so rendering it alongside the rating states the same fact twice and the
 *     owner's density rule sacrifices it first anyway.
 */
function buildIntentData({ concept, layoutInput, brand, cta }) {
  const copy = concept?.copy_picks || {};
  const proof = layoutInput?.social_proof || {};
  // ALLOWLIST. A quote reaches the pixels only if something positively vouched
  // for it — never merely because nothing flagged it.
  const quote = isPrintableCustomerQuote(proof.primary_quote) ? proof.primary_quote : null;
  if (proof.primary_quote && !quote) {
    console.log(
      `🔒 direct-image: quote withheld (tier=${proof.primary_quote.tier || 'unstamped'} ` +
      `origin=${proof.primary_quote.origin || 'unstamped'}) — rendering this ad with no testimonial`
    );
  }

  // `snippet` is the <=50-char word-safe shortening of the SAME sentence. It is
  // preferred because the model has to typeset this, and a 200-character quote
  // set at testimonial size is unreadable at feed scale.
  const quoteText = quote ? String(quote.snippet || quote.text || '').trim() : '';

  return {
    // `> 0` on BOTH, and an upper bound. typeof 0 === 'number', so the old test
    // printed a rating of zero as the string "0" — a zero-star rating typeset on
    // an advertisement. review_count already had this guard; rating did not, and
    // the asymmetry sat on adjacent lines. The 0-5 bound catches a vendor that
    // reports a 0-100 scale, which would otherwise render as "87 stars".
    rating: typeof proof.rating_value === 'number' && proof.rating_value > 0 && proof.rating_value <= 5
      ? String(Number(proof.rating_value.toFixed(1)))
      : undefined,
    reviewCount: typeof proof.review_count === 'number' && proof.review_count > 0
      ? proof.review_count
      : undefined,
    quote: quoteText || undefined,
    // The reviewer's OWN name or no byline at all. normalizeQuote no longer
    // manufactures one: it used to fall back to the quote's `source` — a site,
    // which is how "vertexaisearch.cloud.google.com" became the customer who
    // said the words on 80 live artifacts — and then to "Verified buyer" or
    // "Anonymous Customer", which assert things about a person we cannot name.
    // An unattributed real quote is honest. An attributed fake is not.
    attribution: quoteText && quote?.author_name ? String(quote.author_name).trim() : undefined,
    // The Director's line. Not the product name — that is dropped entirely by
    // owner instruction and is separately forbidden in the absence block.
    headline: copy.headline ? String(copy.headline).trim() : undefined,
    badge: undefined,
    cta: cta || 'SHOP NOW'
  };
}

async function resolveConcept({ adConceptArtifactId, adConceptId, expectedProductId }) {
  if (!adConceptArtifactId || !adConceptId) return null;
  const artifact = await CreativeDirectionArtifact.findById(adConceptArtifactId).select('concepts productId').lean();
  if (!artifact) return null;

  // A CreativeDirectionArtifact is scoped to ONE product. An Ad pointing at a
  // different product's round renders that product's copy under this
  // product's photo, and nothing downstream can catch it: the Ad has the
  // right productId, the right images, and copy that reads perfectly — for
  // the wrong item. That is how a Campus Crest T-Shirt ad shipped the
  // headline "Strength, in pink." over the subheadline "Training Straight Leg
  // Leggings". Refuse to render rather than misdescribe the product.
  if (expectedProductId && artifact.productId && String(artifact.productId) !== String(expectedProductId)) {
    throw taggedError(
      `concept artifact ${adConceptArtifactId} belongs to product ${artifact.productId}, not ${expectedProductId} — refusing to render another product's creative direction`,
      { alertLevel: 'error', alertKey: 'direct-image:concept-product-mismatch' }
    );
  }
  return artifact.concepts?.find((c) => c.concept_id === adConceptId) || null;
}

// Tag an error with how loudly it should be reported. renderService raises
// exactly one alert per failed render using these, so the classification lives
// with the code that knows what went wrong, not with the caller.
function taggedError(message, { alertLevel = 'error', alertKey }) {
  const err = new Error(message);
  err.alertLevel = alertLevel;
  err.alertKey = alertKey;
  return err;
}

async function renderDirectImage({
  layoutInputArtifactId, aspectRatio, mediaId, productId, brandId,
  adConceptArtifactId, adConceptId, template, referenceMediaIds = [],
  // Where referenceMediaIds came from, purely so the per-reference role labels
  // and the inspector tell the truth. 'operator' = an explicit wizard stack;
  // 'director' = the concept's own media_picks. Defaults to 'operator' because
  // that was the only source when this argument was introduced.
  referenceSource = 'operator',
  // The surface drives the safe box and the generation size. renderStage already
  // threads platformFormat through ...args and defaults it to meta_feed_1_1, so
  // this is a rename at the boundary, not a new requirement on callers.
  platformFormat = 'meta_feed_1_1'
}) {
  const surface = platformFormat || 'meta_feed_1_1';
  // Credentials are checked further down, AFTER brand routing: a brand
  // deliberately on the HTML pipeline renders through gpt-4.1 + Puppeteer and
  // needs no image-model key, so failing it here for a missing Atlas key would
  // break a path that does not use Atlas.

  const [layout, concept, brand, product, media] = await Promise.all([
    LayoutInputArtifact.findById(layoutInputArtifactId).select('input brandId productId').lean(),
    resolveConcept({ adConceptArtifactId, adConceptId, expectedProductId: productId }),
    brandId ? Brand.findById(brandId).lean() : null,
    productId ? CatalogProduct.findById(productId).select('title imageUrl').lean() : null,
    mediaId ? Media.findById(mediaId).select('fileUrl').lean() : null
  ]);
  // A missing layout artifact is recoverable: everything it supplies has a
  // source of its own. brand/product come from the explicit args, and themeFor
  // already falls back to the Brand document when there is no layoutInput
  // brand block. Render a generic layout rather than losing the ad.
  if (!layout) {
    console.warn(`   ⚠️  direct-image: layout input ${layoutInputArtifactId} missing — rendering with a generic layout`);
  }
  const effectiveLayout = layout || { input: {}, brandId: brandId || null, productId: productId || null };

  // A concept is not recoverable — it carries the copy the ad is built from.
  // Its absence means the Director round did not produce (or did not attach)
  // the concept this Ad row points at, which is a pipeline fault worth
  // surfacing, not a creative to improvise.
  if (!concept) {
    throw taggedError(
      `no Director concept resolved for ad (conceptArtifact=${adConceptArtifactId || 'none'} conceptId=${adConceptId || 'none'}) — the concept is missing from the artifact or the artifact is gone`,
      { alertLevel: 'error', alertKey: 'direct-image:no-concept' }
    );
  }

  const resolvedBrand = brand || (effectiveLayout.brandId ? await Brand.findById(effectiveLayout.brandId).lean() : null);
  if (isHtmlPipeline(resolvedBrand?.staticImagePipeline)) {
    // The ONLY legitimate reason to leave this pipeline: an operator put this
    // brand on the legacy HTML path deliberately. `routedToHtml` marks it as a
    // routing decision so the caller can honour it, while every other exit
    // above is breakage and must not be quietly rerouted into a different
    // renderer.
    //
    // Note the inversion: this now tests for html rather than for "not direct".
    // The old form treated any unrecognised value as not-direct and fell through
    // to HTML, so a typo or a retired enum value silently resurrected the legacy
    // renderer. Only the exact string 'html' can do that now.
    return { skipped: true, routedToHtml: true, reason: `brand staticImagePipeline is ${resolvedBrand?.staticImagePipeline || 'html'}` };
  }

  // Only reached for brands actually on this pipeline. No image provider at
  // all means nothing here can succeed and every ad in every run fails the
  // same way, so it gets the loudest level we have — it is an outage, not a
  // bad ad. Deliberately after the concept check, which is universal, and
  // after brand routing, which does not need an image key.
  if (!atlasImage.isConfigured() && !process.env.OPENAI_API_KEY) {
    throw taggedError(
      'no image credentials: neither ATLAS_API_KEY nor OPENAI_API_KEY is configured — no static ad can render until one is set',
      { alertLevel: 'fatal', alertKey: 'direct-image:no-credentials' }
    );
  }
  const resolvedProduct = product || (effectiveLayout.productId ? await CatalogProduct.findById(effectiveLayout.productId).select('title imageUrl').lean() : null);
  // Delivery dims are NOT derived here any more: they come from the surface the
  // prompt is built from, a few lines below, so the size Sharp writes and the
  // size the geometry block promised the model cannot disagree.
  // ONE reference by default: the media this ad was actually built from.
  //
  // This used to send the selected media AND the product's hero image on every
  // render. The model faithfully composed both, so an operator who picked a
  // single shot got a second view of the product they never asked for — and
  // when the two happen to be the same photo (merchant original vs Cloudinary
  // mirror), URL dedup can't see it and the same image is paid for twice.
  //
  // Extra references are opt-in: `referenceMediaIds` carries the operator's
  // explicit ordered picks, the same field the video path reads.
  const refCandidates = [];
  const orderedIds = (Array.isArray(referenceMediaIds) ? referenceMediaIds : []).map(String);
  if (orderedIds.length) {
    const picked = await Media.find({ _id: { $in: orderedIds } }).select('fileUrl').lean();
    const byId = new Map(picked.map((m) => [String(m._id), m]));
    orderedIds.forEach((id, i) => {
      const doc = byId.get(id);
      // Label by ACTUAL source. These strings land in Ad.imageGeneration.images
      // and are what an operator reads in the inspector when asking "why is this
      // photo in my ad" — calling a Director pick an "operator-pick" sends that
      // question to the wrong place entirely.
      const prefix = referenceSource === 'director' ? 'director-pick' : 'operator-pick';
      if (doc?.fileUrl) refCandidates.push({ sourceUrl: doc.fileUrl, role: i === 0 ? prefix : `${prefix}-${i}` });
    });
    if (refCandidates.length < orderedIds.length) {
      console.warn(`   ⚠️  direct-image: ${orderedIds.length - refCandidates.length} ${referenceSource}-selected media missing — sending the ${refCandidates.length} that resolved`);
    }
  }
  if (!refCandidates.length) {
    const fallback = media?.fileUrl
      ? { sourceUrl: media.fileUrl, role: 'seed-media' }
      : (resolvedProduct?.imageUrl ? { sourceUrl: resolvedProduct.imageUrl, role: 'product-hero' } : null);
    if (fallback) refCandidates.push(fallback);
  }
  // Carry each buffer's origin alongside it: the uploaded Atlas handles are
  // ephemeral, so only this makes the submission legible in the inspector.
  const fetchedRefs = await Promise.all(refCandidates.map(async (c) => {
    const raw = await optionalImage(c.sourceUrl);
    return raw ? await normalizeReference(raw) : null;
  }));
  const refs = [];
  const imageMeta = [];
  refCandidates.forEach((candidate, i) => {
    if (fetchedRefs[i]) { refs.push(fetchedRefs[i]); imageMeta.push(candidate); }
  });
  // A total absence of any product reference is not a degraded input to
  // improvise past — it is unrecoverable, the same way a missing Director
  // concept is above. buildPrompt's opening paragraph unconditionally instructs
  // the model to "reproduce this exact item faithfully" from "the supplied
  // photograph" — true and necessary when refs.length > 0, but if this fired
  // with zero references the model would be told a photograph exists when none
  // does, and would have nothing to ground the product's actual appearance in.
  // For a system whose whole purpose is faithfully depicting a real product,
  // that is an invented product, not a stylised one, and it would still cost a
  // full billable submit to find out. Fail loudly before spending anything,
  // exactly like the concept check above.
  if (!refs.length) {
    throw taggedError(
      `no product reference available (media=${mediaId || 'none'} product=${productId || 'none'}) — ` +
      'refusing to generate a product ad with nothing to ground the product\'s real appearance in',
      { alertLevel: 'error', alertKey: 'direct-image:no-reference' }
    );
  }
  // The finished-ad prompt. The model typesets the copy; only the logo is
  // composited afterwards. Surface (platformFormat) rather than bare aspect
  // ratio, because the safe box depends on the platform's own UI reserve and on
  // how much of the generated frame the delivery crop destroys — neither is
  // derivable from "1:1".
  const intentKey = intentForTemplate(template);
  const intentData = buildIntentData({
    concept,
    layoutInput: effectiveLayout.input || {},
    brand: resolvedBrand,
    cta: effectiveLayout.input?.cta?.text
  });
  const built = intents.buildPrompt({
    intentKey,
    data: intentData,
    product: {
      desc: describeProductForPrompt({ concept, product: resolvedProduct, layoutInput: effectiveLayout.input || {} }),
      look: conceptLook(concept, effectiveLayout.input || {}),
      logoCorner: 'bottom-right'
    },
    surface
  });
  // A surface that takes no static image is a routing fact, not a failure —
  // meta_reels_9_16 is declared kinds:['video'] in platformFormats.
  if (built.skipped) {
    return { skipped: true, routedToHtml: false, reason: `surface ${surface} takes no static image: ${built.skipped}` };
  }
  if (built.error || !built.prompt) {
    throw taggedError(
      `intent prompt could not be built for ${intentKey}/${surface}: ${built.error || 'no prompt returned'}`,
      { alertLevel: 'error', alertKey: 'direct-image:intent-prompt-failed' }
    );
  }
  const prompt = built.prompt;
  // The size the geometry block just promised the model. `built.surface.generate`
  // is "WxH" chosen by least-crop arithmetic against this surface's aspect, so it
  // and the prompt can never disagree.
  const genSize = built.surface.generate;
  // BEFORE the billable submit, deliberately. Everything this validates is known
  // from the surface alone, and an image model call is charged on submit — so a
  // surface we would refuse to deliver must be refused while it is still free.
  const dims = deliveryGeometryFor(built.surface);
  const meta = { stage: 'direct_image', service: 'directImageRenderService', purposeTag: template || 'untagged', brandId: resolvedBrand?._id || brandId || null, productId: resolvedProduct?._id || productId || null, mediaId: mediaId || null };
  // When Atlas is configured, the established renderer is the recovery path.
  // Starting a second provider request after a submitted Atlas prediction both
  // extends the user's wait and can double-charge the same ad.
  const allowProviderFallback = !atlasImage.isConfigured();
  // ALWAYS an edit call. There is no text-to-image fallback, by owner
  // instruction ("if there is no image there is no generation") — the throw
  // above already refuses to reach here with zero references, so this is never
  // asked to invent a product from words alone.
  const result = await atlasImage.editImage({
    model: PLATE_EDIT_MODEL, images: refs, imageMeta, prompt, size: genSize,
    quality: PLATE_QUALITY, meta, timeoutMs: PLATE_TIMEOUT_MS,
    uploadTimeoutMs: UPLOAD_TIMEOUT_MS, allowFallback: allowProviderFallback
  });
  const b64 = result?.data?.[0]?.b64_json;
  if (!b64) throw new Error('direct-image generation returned no image data');

  // The model's output IS the ad. Sharp's only remaining jobs are the delivery
  // crop and the logo — every text layer this used to composite is gone with the
  // overlay renderer.
  //
  // Two steps, and the order matters. First a CENTRED extract to the delivery
  // aspect, taking exactly the pixels the prompt told the model would be cut
  // away. Then a pure scale to the delivery box: because the extract already has
  // the delivery aspect (asserted pre-submit), fit:'fill' cannot crop or stretch
  // — it is a resample and nothing else. The old single `fit:'cover',
  // position:'attention'` call did both jobs at once and got both wrong.
  const rawFrame = Buffer.from(b64, 'base64');
  const frame = await sharp(rawFrame).metadata();
  const box = extractFor(built.surface, frame.width, frame.height);
  const [reqW, reqH] = String(genSize).split(/[x*]/).map(Number);
  if (frame.width !== reqW || frame.height !== reqH) {
    console.warn(
      `   ⚠️  direct-image: model returned ${frame.width}x${frame.height} for a ${genSize} request — ` +
      `cropping the ${built.surface.aspect} centre of what arrived`
    );
  }
  const rendered = await sharp(rawFrame)
    .extract(box)
    .resize(dims.width, dims.height, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .png()
    .toBuffer();

  // LOGO — the one deliberate exception to "the model renders everything", and
  // owner-specified: the logomark is the single thing that must NOT be fed to the
  // image model. Image models redraw wordmarks approximately, which on a logo
  // reads as a counterfeit rather than a stylisation. So the prompt reserves the
  // corner (see product.logoCorner above, and the absence line forbidding any
  // drawn logo) and the real asset is composited into that reserved space here.
  //
  // Sized against the SHORTER edge so the mark is the same physical size on every
  // surface, and placed inside the content rect rather than at a flat offset from
  // the bottom. The flat offset put it 150px inside Stories' 250px reply-bar
  // reserve — the brand's logomark, on the one surface where it was invisible.
  const layers = [];
  const logo = await optionalImage(resolvedBrand?.logoUrl || effectiveLayout.input?.brand?.logo);
  if (logo) {
    try {
      const boxW = Math.round(0.16 * Math.min(dims.width, dims.height));
      const logoPng = await sharp(logo)
        .resize({ width: boxW, height: Math.round(boxW * 0.35), fit: 'inside', withoutEnlargement: true })
        .png()
        .toBuffer();
      // Measure what came out: fit:'inside' preserves aspect, so a tall or a wide
      // mark occupies less than the box and placing by the box would leave it
      // floating off the corner it was promised.
      const lm = await sharp(logoPng).metadata();
      const place = logoPlacementFor({
        surface: built.surface,
        dims,
        logoW: lm.width,
        logoH: lm.height
      });
      if (place) layers.push({ input: logoPng, top: place.top, left: place.left });
      else console.warn(`   ⚠️  direct-image: no room for the logo inside ${surface}'s content rect — skipping it rather than covering it with platform UI`);
    } catch (err) { console.warn(`   ⚠️  direct-image: logo compose failed (${err.message})`); }
  }
  const buffer = layers.length
    ? await sharp(rendered).composite(layers).png().toBuffer()
    : rendered;
  console.log(
    `   🖼️  direct-image ready — ${template}/${aspectRatio} surface=${surface} intent=${built.resolved.key}` +
    `${built.resolved.fellBackFrom ? `(fell back from ${built.resolved.fellBackFrom})` : ''} ` +
    `concept=${adConceptId} refs=${refs.length} logo=${layers.length ? 'composited' : 'none'} ` +
    `text=${built.text.length}${built.dropped.length ? ` dropped=${built.dropped.join('+')}` : ''} ` +
    `model=${PLATE_EDIT_MODEL}`
  );
  return {
    buffer, contentType: 'image/png', width: dims.width, height: dims.height,
    bytes: buffer.length, kind: 'image', directImage: true,
    // Verbatim audit of the image-model request, built at submit time inside
    // atlasImageService. Persisted onto the Ad so the inspector never has to
    // re-derive what "should" have been sent.
    imageGeneration: result?.submission
      ? { ...result.submission, pipeline: DIRECT_IMAGE, stage: 'finished_ad' }
      : null,
    // Provenance for the inspector. Recorded because the whole reason this
    // pipeline was hard to diagnose is that nothing said which intent ran, what
    // the data supported, or what got sacrificed to the density budget. Small
    // and non-reconstructed: every field here is what actually happened, and
    // absent stays absent rather than defaulting to something plausible.
    intentResolution: {
      surface,
      requested: intentKey,
      delivered: built.resolved.key,
      fellBackFrom: built.resolved.fellBackFrom || null,
      renderedRoles: built.text.map(([role]) => role),
      droppedRoles: built.dropped,
      generateSize: genSize,
      logoComposited: layers.length > 0
    }
  };
}

module.exports = {
  // Exported for the offline harness. renderDirectImage is the only entry point
  // the render path uses.
  deliveryGeometryFor,
  safeBoxInDeliveredPx,
  extractFor,
  logoPlacementFor,
  intentForTemplate,
  buildIntentData,
  describeProductForPrompt,
  conceptLook,
  normalizeReference,
  renderDirectImage
};
