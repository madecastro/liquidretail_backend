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
const { BRAND_LED_COPY } = intents;
const { isHtmlPipeline, DIRECT_IMAGE } = require('./staticPipeline');
// Defence in depth. layoutInputService already withholds these at pool
// assembly, so this gate should never fire — it exists because an artifact
// cached before the producer-side filter landed can still carry one.
const { toPrintableCustomerQuote } = require('./quoteProvenance');
const { formatDisplayRating, resolveCoherentSocialProof, brandAttributionLabel } = require('./ratingDisplay');
// THE sanctioned concept reader. Direct reads of concept.rationale on this
// path are how private Director reasoning became art direction on 2026-08-01.
const { renderableCopy, artDirectionLook, conceptForRender } = require('./conceptProjection');
const { adStage, noteRenderIssue } = require('./adStage');

/**
 * REVERTED to the plain variant, owner decision 2026-08-03 — same day the switch
 * was made, on measured reliability. The `-developer` variant is half price and
 * schema-identical, but it fails hard far too often:
 *
 *     variant      submits   hard `prediction failed`   rate
 *     -developer     76               13                17.1%
 *     plain          38                0                 0%
 *
 * Three independent runs on the developer model (38 / 20 / 18 submits) failed at
 * 15.8% / 15.0% / 22.2% — consistent, not a bad afternoon. Each failure is a
 * BILLED submit that returns `outputs: null` with no error message, which reaches
 * the operator as a failed ad and bills a failure. Cost per SUCCESSFUL render
 * still favoured developer ($0.0426 vs $0.0757), so this is deliberately NOT a
 * cost decision — the owner chose delivered ads over unit price.
 *
 * The switch and its reasoning are kept below because the comparison is worth
 * having on record, and because the developer variant is a legitimate lever if
 * Atlas ever fixes its reliability. Re-measure before reaching for it again.
 *
 * VERIFIED live before switching, because a model id is never taken from memory
 * (CLAUDE.md §2). Both entries resolve to the same POST
 * `/api/v1/model/generateImage`; their request schemas are **field-for-field
 * identical** — same `required` (`model`, `images`, `prompt`), same 14-value `size`
 * enum, same `quality` low|medium|high, same `moderation` / `output_format` /
 * `enable_sync_mode` / `enable_base64_output`, and neither exposes
 * `input_fidelity`. They even share one `readme` URL. So this is a drop-in swap:
 * nothing in buildParams or the payload below changes.
 *
 * Price, MEASURED not read off the catalog (see the pricing note in
 * atlasImageService — `base_price` is a base and under-reports ~7x):
 *   openai/gpt-image-2/edit            base 0.010  ->  charged $0.07173
 *   openai/gpt-image-2-developer/edit  base 0.005  ->  charged $0.03586
 * Exactly half, dead-consistent across every priced prediction. A 3-surface
 * meta_static fanout goes ~$0.215 -> ~$0.108 per product.
 *
 * NOT VERIFIED: output quality between the two variants. The A/B that prompted this
 * ran both arms on the developer model, so it compares prompts, not models. The
 * schemas and readme are identical and 20 developer renders looked clean, but if
 * output degrades, this is the first thing to put back.
 *
 * ⚠️ OPEN — MEASURED RELIABILITY GAP, 38 submits per model on 2026-08-03:
 *     non-dev    36/38 ok, 0 hard failures (2 poll timeouts, likely completed late)
 *     developer  32/38 ok, **6 hard `prediction failed`** (15.8%), outputs null,
 *                no error message, has_nsfw_contents null
 * Cost per SUCCESSFUL render still favours developer — $0.0426 vs $0.0757, ~44%
 * cheaper even after paying for the failures — so the money case survives. But a
 * ~16% hard-failure rate is a PRODUCT problem, not just a cost one: each one is a
 * charged submit with no asset, which surfaces to the operator as a failed ad and
 * bills a failure. NOT a controlled comparison (n=38 each, one session, and the two
 * runs used different prompt text), so treat it as a signal to re-measure, not a
 * verdict. If static failure rates rise after this ships, revert via
 * AI_DIRECT_IMAGE_EDIT_MODEL before investigating anything else.
 */
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
/**
 * Which ink a composited logomark should use, given the mean luminance (0..1)
 * of the artwork directly behind it. Light plate → black mark, dark plate →
 * white mark. Pure black/white on purpose: owner asked for "clean and minimal",
 * and a brand-tinted mark on arbitrary generated backgrounds is what produced
 * unreadable marks before.
 *
 * Exported so scripts/verifyProofBeat.js can pin the threshold.
 */
function monochromeInkFor(meanLum) {
  const n = Number(meanLum);
  if (!Number.isFinite(n)) return null;      // unknown → caller keeps the original asset
  return n > 0.5 ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
}

/**
 * Re-render a logo as a single-ink silhouette.
 *
 * WHY: the asset is composited verbatim, so a logo delivered on an OPAQUE white
 * canvas paints a white rectangle onto the ad. Owner, on a delivered AllBirds
 * ad: *"I noticed the allbirds logo is put on a block of white, the logo should
 * just be rendered in black or white depending on the color of the background.
 * It should be clean and minimal."*
 *
 * Coverage (what becomes the mark) is taken from:
 *   - the ALPHA channel when the asset has one — the normal, correct case; or
 *   - LUMINANCE when it does not, in whichever polarity matches the asset's own
 *     background. Border pixels decide that polarity, so dark-artwork-on-white
 *     and white-artwork-on-black both resolve correctly instead of one of them
 *     inverting into a solid block.
 */
async function monochromeLogoBuffer(logoPng, ink) {
  const meta = await sharp(logoPng).metadata();
  const w = meta.width, h = meta.height;
  if (!(w > 0 && h > 0)) return null;

  let coverage;
  if (meta.hasAlpha) {
    coverage = await sharp(logoPng).ensureAlpha().extractChannel(3).raw().toBuffer();
  } else {
    // Sample the outer border to learn the asset's own background polarity.
    const grey = sharp(logoPng).removeAlpha().greyscale();
    const edge = Math.max(1, Math.round(Math.min(w, h) * 0.04));
    const strip = await grey.clone()
      .extract({ left: 0, top: 0, width: w, height: edge })
      .stats();
    const bgIsLight = (strip.channels[0].mean / 255) > 0.5;
    // bgIsLight → the mark is the DARK pixels, so invert to make them opaque.
    coverage = bgIsLight
      ? await grey.clone().negate().raw().toBuffer()
      : await grey.clone().raw().toBuffer();
  }

  const solid = await sharp({
    create: { width: w, height: h, channels: 3, background: ink },
  }).raw().toBuffer();

  return sharp(solid, { raw: { width: w, height: h, channels: 3 } })
    .joinChannel(coverage, { raw: { width: w, height: h, channels: 1 } })
    .png()
    .toBuffer();
}

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

/**
 * The brand's visual world, handed to the model instead of a font family.
 *
 * WAS (2026-08-01 live defect): fell through art_direction || rationale, then
 * concatenated emotional_hook and layoutInput.brand.visual_style. art_direction
 * was never emitted by any Director schema, so rationale — private honesty-rule
 * notes, objection analysis — became the art brief 100% of the time. visual_style
 * is never assembled by layoutInputService either. emotional_hook names a purchase
 * objection, not a mood.
 *
 * NOW: art_direction only, via conceptProjection. Null when the Director gave
 * none; the prompt sentence is then omitted. No Brand.tone fallback — voice
 * words are not a visual world (absent means absent).
 */
function conceptLook(concept /*, layoutInput — retained arg position unused */) {
  return artDirectionLook(concept);
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
// Rating floor lives in ratingDisplay.js (shared with video chrome) so the
// "stars over 4.5" rule cannot drift between surfaces.

// With BRAND_LED_COPY off, ai_brand_led is absent from the map so
// intentForTemplate returns DEFAULT_INTENT and INTENTS.brand_led is unreachable
// (it is not in FALLBACK_ORDER, so it can only be selected as an explicitly
// requested intent). ai_ugc_led / ai_editorial stay on the default intent —
// out of scope.
const TEMPLATE_INTENT = {
  ai_social_proof_led: 'social_proof_led',
  ai_promotional: 'objection_resolved',
  ...(BRAND_LED_COPY ? { ai_brand_led: 'brand_led' } : {})
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
function buildIntentData({ concept, layoutInput, brand, product = null, cta }) {
  // Dual-read v3 copy / v2 copy_picks. Never invent a headline from product name.
  const copy = renderableCopy(concept);
  const proof = layoutInput?.social_proof || {};
  // ALLOWLIST via toPrintableCustomerQuote — returns a sanitized copy or null.
  // Using the return value (not a boolean + original object) is load-bearing:
  // llm-web quotes arrive with author/source fields that must never print, and
  // the gate strips them structurally so this path cannot re-surface a byline
  // by forgetting to clear author_name.
  const quote = toPrintableCustomerQuote(proof.primary_quote);
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

  // Headline / subhead. Flag-off: exact pre-change expression (Director
  // headline only; subhead undefined). Flag-on: cascade through layoutInput
  // then brand.tagline so ai_brand_led still has a brand line when Director
  // nulls the headline. Do NOT cascade product name/title or description —
  // resolvedProduct is .select('title imageUrl rating productReviews') so description is not loaded,
  // and the product name is forbidden as ad copy by owner directive and
  // fenced in absences.
  //
  // Trim every tier; empty string is absent (matches renderableCopy's one()).
  let headline;
  let subhead;
  if (BRAND_LED_COPY) {
    const one = (v) => {
      if (v == null) return undefined;
      const s = String(v).trim();
      return s || undefined;
    };
    const directorHeadline = one(copy.headline);
    const layoutHeadline = one(layoutInput?.copy?.headline);
    const tagline = one(brand?.tagline || layoutInput?.brand?.tagline);
    let headlineTier = 'none';
    if (directorHeadline) {
      headline = directorHeadline;
      headlineTier = 'director';
    } else if (layoutHeadline) {
      headline = layoutHeadline;
      headlineTier = 'layout';
    } else if (tagline) {
      headline = tagline;
      headlineTier = 'tagline';
    }

    const directorSub = one(copy.subheadline);
    const layoutSub = one(layoutInput?.copy?.subheadline);
    let subheadTier = 'none';
    if (directorSub) {
      subhead = directorSub;
      subheadTier = 'director';
    } else if (layoutSub) {
      subhead = layoutSub;
      subheadTier = 'layout';
    }

    // DEDUPE — required. layoutInput.copy.subheadline itself falls back to
    // brand.tagline, so the same string can legitimately resolve into BOTH
    // slots. The prompt contract is "each appearing exactly once"
    // (staticAdIntents textBlock), so a duplicate is a contract violation that
    // renders as visibly broken. Headline wins because it is core.
    let deduped = false;
    if (subhead && headline && subhead.toLowerCase() === headline.toLowerCase()) {
      subhead = undefined;
      // keep subheadTier as the cascade that produced the duplicate; the
      // marker below is how a later session sees the drop without a DB query
      deduped = true;
    }

    // Says "static copy", not "brand-led": buildIntentData is intent-agnostic and
    // runs for every static render, so labelling this brand-led would mislabel an
    // ai_social_proof_led or ai_promotional render in the logs.
    console.log(
      `🔒 direct-image: static copy headline=${headlineTier} subhead=${subheadTier}` +
      (deduped ? ' (subhead deduped — matched headline)' : '')
    );
  } else {
    headline = copy.headline ? String(copy.headline).trim() : undefined;
    // subhead stays undefined — pre-change shape
  }

  // ── ONE tier-coherence chokepoint, now shared with the video path ────────
  // The video path has always routed its numbers through
  // resolveCoherentSocialProof; STATIC never called it, so a PRODUCT rating
  // could print beside a BRAND-tier quote on the same ad — precisely the
  // pairing that function exists to forbid. Its own docstring anticipates this
  // caller ("the static path feeds verbatim strings to the image model, with no
  // cascade and no bind list — there it is a statement of fact"), so this is
  // the wiring it was written for.
  //
  // SCOPE: it governs the NUMBERS only. emptyCoherentProof deliberately keeps
  // the quote and nulls rating/reviewCount, so a quote that cleared provenance
  // still prints; it just loses stars it cannot vouch for. The quote's own
  // gate (toPrintableCustomerQuote, above) is untouched.
  //
  // renderedQuoteText is the actual string handed to the image model. Static has
  // no cascade or bind list between meta and pixels, so passing it is a fact,
  // not ceremony — the video path must resolve its bind chain first instead.
  const STATIC_PROOF_COHERENCE =
    String(process.env.STATIC_PROOF_COHERENCE ?? 'true').toLowerCase() !== 'false';
  let coherent = null;
  if (STATIC_PROOF_COHERENCE) {
    // Same productReviews-first precedence as brandScriptExecutor: it is the
    // only container either review writer fills, carries both numbers written
    // together, and is fresher than the top-level `rating` mirror (which cannot
    // carry a count at all — no such schema path).
    // THREE tiers, and the third is load-bearing: layoutInput.social_proof is
    // the artifact's OWN derived pair, and for many ads it is the only pair that
    // exists (no CatalogProduct row loaded, or one with no review data). An
    // earlier draft of this block used only the two document sources and so
    // printed NO rating wherever they were absent — a proof REGRESSION, caught
    // by verifyQuoteProvenance P3. Trust of that third tier follows the same
    // rule as the video path: only when `rating_source` names the tier, because
    // an unstamped artifact (~722/738 in production) may hold a mixed pair.
    const pr = product && typeof product.productReviews === 'object' ? product.productReviews : null;
    const liIsProduct = proof.rating_source === 'product';
    const liIsBrand   = proof.rating_source === 'brand';
    const liPair = (typeof proof.rating_value === 'number' || typeof proof.review_count === 'number')
      ? { rating: proof.rating_value ?? null, reviewCount: proof.review_count ?? null }
      : null;
    // productReviews must carry a USABLE RATING to win, not merely a count.
    // Winning on count alone would set `{rating: null, reviewCount: 500}` and
    // thereby ERASE a perfectly good top-level `rating` — a proof regression, and
    // the opposite of the point of this change. Requiring the rating also keeps
    // the pair atomic: both numbers then come from the same document, which is
    // the R2 rule. A productReviews holding only a count loses nothing, because a
    // count never renders without a rating beside it (staticAdIntents.js:460).
    const prHasRating = !!pr && typeof pr.rating === 'number';
    const productPair = prHasRating
        ? { rating: pr.rating, reviewCount: pr.reviewCount ?? null }
      : (typeof product?.rating === 'number')
        ? { rating: product.rating, reviewCount: null }
      : (liIsProduct ? liPair : null);

    // BRAND NUMBERS ON A PRODUCT AD, NOW WITH SCOPED COPY.
    //
    // A prior version of this sourced `brandPair` from `Brand.brandReviews` and
    // an adversarial pass caught it as a blocker: the resolver returns
    // brand-scoped STRINGS for a brand-tier win (`reviewsText: "41000 brand
    // reviews"`), but the RATING/TRUST MARK templates only consumed the bare
    // scalars, so a brand's 41,000 reviews would have printed on a product ad
    // reading as 41,000 reviews of THAT SKU. This is the second half of that
    // fix, not a reopening of the hole — see `d.reviewsText` below, which is now
    // what the templates actually render. `staticAdIntents.js` no longer builds
    // its own unscoped `(${d.reviewCount} reviews)` string; it renders whatever
    // this function hands it, which is scoped at the source.
    //
    // `deriveSocialProofNumbers` only falls back to brand numbers for the no-SKU
    // 'branding' outcome (layoutInputService.js:3430), so a product-scoped ad
    // reading brand aggregates via THIS path (rather than that pre-existing one)
    // is new reach — deliberately: that is the point of this change, and it is
    // safe now because the copy names its own scope.
    const BRAND_PROOF_ON_PRODUCT_ADS =
      String(process.env.BRAND_PROOF_ON_PRODUCT_ADS ?? 'true').toLowerCase() !== 'false';
    const brandDocPair = (BRAND_PROOF_ON_PRODUCT_ADS
        && brand?.brandReviews && typeof brand.brandReviews === 'object'
        && (typeof brand.brandReviews.rating === 'number' || typeof brand.brandReviews.reviewCount === 'number'))
      ? { rating: brand.brandReviews.rating ?? null, reviewCount: brand.brandReviews.reviewCount ?? null }
      : null;
    const brandPair = brandDocPair || (liIsBrand ? liPair : null);
    // An UNSTAMPED artifact pair still has to reach the ad, or this change would
    // withhold proof from every pre-`rating_source` artifact. There is no tier
    // claim to cohere in that case, so it is only used when no quote prints —
    // exactly the "rating-only social proof is legitimate" branch inside
    // resolveCoherentSocialProof. With a quote on frame, an unstamped pair stays
    // withheld, which is the pre-existing fail-closed rule, not a new one.
    const unstampedFallback = (!proof.rating_source && liPair && !quoteText) ? liPair : null;
    coherent = resolveCoherentSocialProof({
      quote: quote || null,
      product: productPair || unstampedFallback,
      brand: brandPair,
      brandAttribution: brandAttributionLabel(brand),
      renderedQuoteText: quoteText || null,
    });
    console.log(
      `🔒 direct-image proof: source=${coherent.source || 'none'} rating=${coherent.rating || 'none'} ` +
      `count=${coherent.reviewCount ?? 'none'} quoteTier=${coherent.quoteTier || 'none'}` +
      `${coherent.reviewsTextShort ? ` slug="${coherent.reviewsTextShort}"` : ''}`
    );
  }

  return {
    // Owner rule: "we only use stars over 4.5". Gated on the DISPLAYED
    // (one-decimal) value via formatDisplayRating — a raw >4.5 gate let
    // 4.51 print as "4.5". See services/ratingDisplay.js.
    // Flag-off keeps the exact pre-change expressions below.
    // `?? undefined` is not cosmetic: resolveCoherentSocialProof returns null
    // for "withheld", while every downstream absence check on this object tests
    // for undefined (`!d.rating` in staticAdIntents is fine, but the harness
    // contract and the JSON handed to the prompt distinguish the two).
    rating: coherent ? (coherent.rating ?? undefined) : formatDisplayRating(proof.rating_value),
    reviewCount: coherent
      ? (typeof coherent.reviewCount === 'number' && coherent.reviewCount > 0
        ? coherent.reviewCount : undefined)
      : (typeof proof.review_count === 'number' && proof.review_count > 0
        ? proof.review_count : undefined),
    // SCOPED count text — "523 reviews" for product tier, "41000 brand reviews"
    // for brand tier. This is what closes the misattribution gap: a bare
    // reviewCount has no scope of its own, so staticAdIntents must render THIS
    // string, not re-derive an unscoped one from the number. undefined (not
    // null) when coherence is off or the tier carries no count, so the
    // `d.reviewsText ? … : …` fallback in staticAdIntents behaves identically to
    // today whenever there is nothing to disclose.
    reviewsText: coherent && coherent.reviewsText ? coherent.reviewsText : undefined,
    quote: quoteText || undefined,
    // The reviewer's OWN name or no byline at all. normalizeQuote no longer
    // manufactures one: it used to fall back to the quote's `source` — a site,
    // which is how "vertexaisearch.cloud.google.com" became the customer who
    // said the words on 80 live artifacts — and then to "Verified buyer" or
    // "Anonymous Customer", which assert things about a person we cannot name.
    // An unattributed real quote is honest. An attributed fake is not.
    attribution: quoteText && quote?.author_name ? String(quote.author_name).trim() : undefined,
    // The Director's line (or cascade when BRAND_LED_COPY). Not the product
    // name — that is dropped entirely by owner instruction and is separately
    // forbidden in the absence block.
    headline,
    subhead,
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
  const raw = artifact.concepts?.find((c) => c.concept_id === adConceptId) || null;
  // Project before any prompt builder can see the Mongo Mixed subdoc. Reasoning
  // (rationale) is stripped here so the live image path cannot re-introduce the
  // 2026-08-01 leak by reading concept.rationale directly.
  return conceptForRender(raw);
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

/**
 * Fold a vision-QC corrective note INTO a full-replacement override.
 *
 * MONEY. The QC retry re-enters renderDirectImage with `operatorPrompt:
 * correctiveNote` AND the original `rawPromptOverride` still set. Because the
 * override wins below, the branch that appends the note is never reached — so
 * without this the single allowed regeneration re-submits a BYTE-IDENTICAL
 * prompt, earns the identical verdict, and burns a second billable
 * gpt-image-2/edit submit for nothing.
 *
 * Deliberately NOT applied on the normal path: an operator who sends both a
 * refinement and an override still gets "override wins, note dropped", which
 * is the documented contract the route and the harness pin. This only rescues
 * the machine-generated retry, where dropping the note is never intentional.
 */
function composeCorrectiveOverride(overrideText, correctiveNote) {
  const base = String(overrideText || '');
  const note = String(correctiveNote || '').trim();
  if (!base || !note) return overrideText;
  return `${base}\n\nQC CORRECTION (previous attempt failed review — fix this):\n${note}`;
}

/**
 * THE POST-MODEL HALF of a static render: delivery crop -> logo composite.
 *
 * EXTRACTED 2026-08-05, and the reason is money. Atlas retains a prediction for
 * 30 days, so a paid generation is never actually lost — only its pointer is. But
 * a static ad's Atlas output is NOT a deliverable ad: it still needs the centred
 * extract to the delivery aspect and the logomark that the prompt reserved a
 * corner for. Until this was callable on its own, a recovered image could only be
 * located and alerted, never finished, so the only way to "recover" a stranded
 * render was to buy it again. Measured 2026-08-05: nine gpt-image-2/edit
 * predictions killed mid-poll by a deploy, all nine still COMPLETED at Atlas,
 * $0.5663 already billed.
 *
 * ⚠️ ONE IMPLEMENTATION, TWO CALLERS. renderDirectImage calls this; so does the
 * recovery path. Do NOT copy it. Two copies of the delivery crop would drift, and
 * the failure is silent — a mis-cropped ad still looks plausible while cutting
 * through typeset copy, which is exactly the failure the genSize mismatch warning
 * below exists to catch. Keeping one implementation makes byte-identity between
 * a normal render and a recovered one structural rather than something anyone has
 * to keep re-proving.
 *
 * Takes a BUFFER, not base64, so a recovered image (fetched from the prediction's
 * output URL) and a fresh render (decoded from the submit response) are the same
 * input to this function.
 *
 * @param {Buffer} rawFrame  exactly what the model returned, undecoded further
 * @param {object} built     the resolved intent/surface (built.surface is used)
 * @param {object} dims      delivery { width, height }
 * @param {string} genSize   requested generation size, for the coercion alarm
 * @param {string} surface   platformFormat key, for operator-facing messages
 * @param {string} adId      for noteRenderIssue; may be null for non-ad callers
 * @param {string|null} logoUrl  brand logomark; absent/failed is a soft skip
 * @returns {Promise<{buffer: Buffer, logoComposited: boolean}>}
 */
async function finishPlate({ rawFrame, built, dims, genSize, surface, adId, logoUrl }) {
  const frame = await sharp(rawFrame).metadata();
  const box = extractFor(built.surface, frame.width, frame.height);
  const [reqW, reqH] = String(genSize).split(/[x*]/).map(Number);
  if (frame.width !== reqW || frame.height !== reqH) {
    const msg =
      `model returned ${frame.width}x${frame.height} for a ${genSize} request — ` +
      `cropping the ${built.surface.aspect} centre of what arrived`;
    console.warn(`   ⚠️  direct-image: ${msg}`);
    // Surfaced per-ad, not just in logs, because this is the alarm for the one
    // operational risk the exact-aspect size table takes on: 4:5 generates at
    // 1088x1360, which is NOT a member of the schema's size enum and is in use on
    // the strength of a single live probe. If the gateway ever starts coercing an
    // arbitrary size to its 1024x1024 default, the symptom is precisely this
    // mismatch — and because extractFor then centre-crops to the surface aspect,
    // the ad would still LOOK plausible while cropping through typeset copy
    // exactly as the old stale table did. A console warning on a worker nobody is
    // tailing is not an alarm; a renderIssue on the Ad is.
    noteRenderIssue(adId, { message: msg, stage: 'generation-size' });
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
  const logo = await optionalImage(logoUrl);
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
      if (place) {
        // Monochrome the mark against whatever the model actually rendered in
        // that corner, so it never ships as a white block (owner, 2026-08-03).
        // Any failure falls back to the original asset — a correctly-placed
        // logo with an ugly backing beats no logo at all.
        let toPlace = logoPng;
        try {
          const region = await sharp(rendered)
            .extract({
              left: Math.max(0, Math.min(place.left, dims.width - 1)),
              top: Math.max(0, Math.min(place.top, dims.height - 1)),
              width: Math.max(1, Math.min(lm.width, dims.width - place.left)),
              height: Math.max(1, Math.min(lm.height, dims.height - place.top)),
            })
            .greyscale()
            .stats();
          const ink = monochromeInkFor(region.channels[0].mean / 255);
          if (ink) {
            const mono = await monochromeLogoBuffer(logoPng, ink);
            if (mono) {
              toPlace = mono;
              console.log(
                `   🖼️  direct-image: logomark inked ${ink.r ? 'white' : 'black'} ` +
                `(behind lum=${(region.channels[0].mean / 255).toFixed(2)})`
              );
            }
          }
        } catch (err) {
          console.warn(`   ⚠️  direct-image: logo monochrome skipped (${err.message}) — using original asset`);
        }
        layers.push({ input: toPlace, top: place.top, left: place.left });
      } else {
        const msg = `no room for the logo inside ${surface}'s content rect — ad ships without logo`;
        console.warn(`   ⚠️  direct-image: ${msg}`);
        noteRenderIssue(adId, { message: msg, stage: 'logo' });
      }
    } catch (err) {
      const msg = `logo compose failed (${err.message}) — ad ships without logo`;
      console.warn(`   ⚠️  direct-image: ${msg}`);
      noteRenderIssue(adId, { message: msg, stage: 'logo' });
    }
  } else if (logoUrl) {
    // URL was present but fetch failed (optionalImage swallowed it).
    noteRenderIssue(adId, {
      message: 'logo fetch failed — ad ships without logo',
      stage: 'logo'
    });
  }
  return {
    buffer: layers.length
      ? await sharp(rendered).composite(layers).png().toBuffer()
      : rendered,
    logoComposited: layers.length > 0
  };
}

/**
 * Map the regenerate API's promptOverride into the single flat prompt the
 * image model accepts.
 *
 * Image/edit endpoints have NO system channel (CLAUDE.md §3). The route and
 * Generation Details modal still speak `{ system, user }` because that was the
 * HTML-layout LLM's shape. Dropping either half would silently discard the
 * operator's edit; concatenating is the honest single-channel mapping.
 * A bare string is also accepted for callers that already hold the flat prompt
 * (e.g. Ad.imageGeneration.prompt from a prior direct_image render).
 */
function resolveImagePromptOverride(rawPromptOverride) {
  if (rawPromptOverride == null) return null;
  if (typeof rawPromptOverride === 'string') {
    const s = rawPromptOverride.trim();
    return s || null;
  }
  if (typeof rawPromptOverride !== 'object') return null;
  const system = String(rawPromptOverride.system || '').trim();
  const user   = String(rawPromptOverride.user   || '').trim();
  if (system && user) return `${system}\n\n${user}`;
  return user || system || null;
}

async function renderDirectImage({
  layoutInputArtifactId, aspectRatio, mediaId, productId, brandId,
  adId = null,
  adConceptArtifactId, adConceptId, template, referenceMediaIds = [],
  // Where referenceMediaIds came from, purely so the per-reference role labels
  // and the inspector tell the truth. 'operator' = an explicit wizard stack;
  // 'director' = the concept's own media_picks. Defaults to 'operator' because
  // that was the only source when this argument was introduced.
  referenceSource = 'operator',
  // The surface drives the safe box and the generation size. renderStage already
  // threads platformFormat through ...args and defaults it to meta_feed_1_1, so
  // this is a rename at the boundary, not a new requirement on callers.
  platformFormat = 'meta_feed_1_1',
  // Regenerate hooks (adRegenerateService.runImage). Neither is charged until
  // the single editImage submit below — they only rewrite the prompt string.
  //   operatorPrompt     — refinement note appended to the auto-built prompt
  //   rawPromptOverride  — verbatim replacement ({system,user} or string)
  operatorPrompt = null,
  rawPromptOverride = null,
  // Post-render vision QC re-entry guard. The single allowed regeneration
  // calls renderDirectImage again with skipVisionQc:true so the QC loop
  // cannot nest (money: would otherwise allow unbounded regenerations).
  skipVisionQc = false
}) {
  const surface = platformFormat || 'meta_feed_1_1';
  // Credentials are checked further down, AFTER brand routing: a brand
  // deliberately on the HTML pipeline renders through gpt-4.1 + Puppeteer and
  // needs no image-model key, so failing it here for a missing Atlas key would
  // break a path that does not use Atlas.

  adStage(adId, `deriving layout (${surface})`);
  const [layout, concept, brand, product, media] = await Promise.all([
    LayoutInputArtifact.findById(layoutInputArtifactId).select('input brandId productId').lean(),
    resolveConcept({ adConceptArtifactId, adConceptId, expectedProductId: productId }),
    brandId ? Brand.findById(brandId).lean() : null,
    productId ? CatalogProduct.findById(productId).select('title imageUrl rating productReviews').lean() : null,
    mediaId ? Media.findById(mediaId).select('fileUrl').lean() : null
  ]);
  // A missing layout artifact is recoverable: everything it supplies has a
  // source of its own. brand/product come from the explicit args, and themeFor
  // already falls back to the Brand document when there is no layoutInput
  // brand block. Render a generic layout rather than losing the ad.
  if (!layout) {
    console.warn(`   ⚠️  direct-image: layout input ${layoutInputArtifactId} missing — rendering with a generic layout`);
    noteRenderIssue(adId, {
      message: `layout input ${layoutInputArtifactId || 'none'} missing — rendering with a generic layout`,
      stage: 'derive'
    });
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
  const resolvedProduct = product || (effectiveLayout.productId ? await CatalogProduct.findById(effectiveLayout.productId).select('title imageUrl rating productReviews').lean() : null);
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
      // Derive the label from the source instead of a two-way ternary. The old
      // `=== 'director' ? … : 'operator-pick'` collapsed EVERY non-director
      // source onto "operator-pick", so a system-derived seed (regenerate's
      // catalog-first reseed, referenceSource 'catalog-first') was reported to
      // the operator as their own pick — exactly the misattribution the comment
      // above warns about, just in the other direction. Unknown sources now
      // label themselves rather than borrowing someone else's name.
      const prefix = referenceSource === 'director' ? 'director-pick'
        : referenceSource === 'operator' ? 'operator-pick'
        : `${referenceSource}-pick`;
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
  adStage(adId, `fetching references (${surface})`);
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
  // concept is above. buildPrompt's opening section (`PRODUCT_FIDELITY`, and the
  // one-sentence legacy paragraph before it) unconditionally calls the supplied
  // reference photograph "the single source of truth for the product" and
  // forbids inferring the product from its category or from brand priors —
  // true and necessary when refs.length > 0, but if this fired
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
  adStage(adId, `building prompt + geometry (${surface})`);
  const intentKey = intentForTemplate(template);
  const intentData = buildIntentData({
    concept,
    layoutInput: effectiveLayout.input || {},
    brand: resolvedBrand,
    product: resolvedProduct,
    cta: effectiveLayout.input?.cta?.text
  });
  const built = intents.buildPrompt({
    intentKey,
    data: intentData,
    product: {
      desc: describeProductForPrompt({ concept, product: resolvedProduct, layoutInput: effectiveLayout.input || {} }),
      look: conceptLook(concept),
      logoCorner: 'bottom-right'
    },
    surface
  });
  // A surface that takes no static image is a routing fact, not a failure —
  // meta_reels_9_16 is declared kinds:['video'] in platformFormats.
  if (built.skipped) {
    return { skipped: true, routedToHtml: false, reason: `surface ${surface} takes no static image: ${built.skipped}` };
  }
  // Geometry (gen size + delivery crop) always comes from the intent surface,
  // even when the operator replaces the prompt text — Sharp still needs the
  // same crop band the model was told about, and a free surface lookup must
  // not become a second billable submit.
  if (built.error || !built.surface) {
    throw taggedError(
      `intent prompt could not be built for ${intentKey}/${surface}: ${built.error || 'no surface returned'}`,
      { alertLevel: 'error', alertKey: 'direct-image:intent-prompt-failed' }
    );
  }
  const overrideText = resolveImagePromptOverride(rawPromptOverride);
  let prompt;
  if (overrideText) {
    // Verbatim replacement — operator edited the exact prompt in Generation
    // Details (or sent {system,user} from the legacy modal shape). One channel.
    prompt = overrideText;
  } else if (built.prompt) {
    prompt = built.prompt;
    // Refinement-note path: append, do not replace. Matches the HTML path's
    // operatorPrompt threading without a second submit.
    const note = String(operatorPrompt || '').trim();
    if (note) {
      prompt = `${prompt}\n\nOPERATOR REFINEMENT (honour this):\n${note}`;
    }
  } else {
    throw taggedError(
      `intent prompt could not be built for ${intentKey}/${surface}: no prompt returned`,
      { alertLevel: 'error', alertKey: 'direct-image:intent-prompt-failed' }
    );
  }
  // The size the geometry block just promised the model. `built.surface.generate`
  // is "WxH" chosen by least-crop arithmetic against this surface's aspect, so it
  // and the prompt can never disagree when the auto-prompt is used; when the
  // operator overrides text they still get this surface's crop/size.
  const genSize = built.surface.generate;
  // BEFORE the billable submit, deliberately. Everything this validates is known
  // from the surface alone, and an image model call is charged on submit — so a
  // surface we would refuse to deliver must be refused while it is still free.
  const dims = deliveryGeometryFor(built.surface);
  // adId + platformFormat ride on meta so atlasImageService can piggyback
  // poll-tick stage writes without requiring the route module.
  const meta = {
    stage: 'direct_image', service: 'directImageRenderService', purposeTag: template || 'untagged',
    brandId: resolvedBrand?._id || brandId || null,
    productId: resolvedProduct?._id || productId || null,
    mediaId: mediaId || null,
    adId: adId || null,
    platformFormat: surface
  };
  // When Atlas is configured, the established renderer is the recovery path.
  // Starting a second provider request after a submitted Atlas prediction both
  // extends the user's wait and can double-charge the same ad.
  const allowProviderFallback = !atlasImage.isConfigured();
  // ALWAYS an edit call. There is no text-to-image fallback, by owner
  // instruction ("if there is no image there is no generation") — the throw
  // above already refuses to reach here with zero references, so this is never
  // asked to invent a product from words alone.
  adStage(adId, `plate submit (${surface})`);
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
  adStage(adId, `crop + logo composite (${surface})`);
  //
  // Two steps, and the order matters. First a CENTRED extract to the delivery
  // aspect, taking exactly the pixels the prompt told the model would be cut
  // away. Then a pure scale to the delivery box: because the extract already has
  // the delivery aspect (asserted pre-submit), fit:'fill' cannot crop or stretch
  // — it is a resample and nothing else. The old single `fit:'cover',
  // position:'attention'` call did both jobs at once and got both wrong.
  const rawFrame = Buffer.from(b64, 'base64');
  // Delivery crop + logomark. Extracted so the recovery path can finish an
  // already-paid Atlas output into a real ad instead of re-buying it — see
  // finishPlate's header for why there must only ever be one implementation.
  const plate = await finishPlate({
    rawFrame, built, dims, genSize, surface, adId,
    logoUrl: resolvedBrand?.logoUrl || effectiveLayout.input?.brand?.logo
  });
  const buffer = plate.buffer;
  console.log(
    `   🖼️  direct-image ready — ${template}/${aspectRatio} surface=${surface} intent=${built.resolved.key}` +
    `${built.resolved.fellBackFrom ? `(fell back from ${built.resolved.fellBackFrom})` : ''} ` +
    `concept=${adConceptId} refs=${refs.length} logo=${plate.logoComposited ? 'composited' : 'none'} ` +
    `text=${built.text.length}${built.dropped.length ? ` dropped=${built.dropped.join('+')}` : ''} ` +
    `model=${PLATE_EDIT_MODEL}`
  );
  const firstOutput = {
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
      logoComposited: plate.logoComposited
    },
    visionQc: null
  };

  // ── Post-render vision QC ──────────────────────────────────────────
  // skipVisionQc: re-entry from the single allowed regeneration must not
  // nest another QC loop (that would break the one-retry money bound).
  if (skipVisionQc) return firstOutput;

  const adVisionQc = require('./adVisionQcService');
  if (!adVisionQc.isEnabled()) {
    return firstOutput;
  }

  // ORIGINAL product photo — the first reference we actually sent. A check
  // that only sees the render cannot tell an invented Timberland emblem from
  // a real brand mark (owner requirement: both images in one vision call).
  const originalProductUrl = imageMeta[0]?.sourceUrl || null;
  if (!originalProductUrl) {
    console.warn('   ⚠️  direct-image: vision QC enabled but no original product URL — shipping without QC');
    return firstOutput;
  }

  const safeBox = safeBoxInDeliveredPx(built.surface, dims);
  const expectedText = built.text.map(([, str]) => str);

  adStage(adId, `vision QC (${surface})`);
  const qcResult = await adVisionQc.runPostRenderQc({
    enabled: true,
    originalProductUrl,
    brandName: resolvedBrand?.name || null,
    safeBox,
    deliveryDims: dims,
    expectedText,
    brandId: resolvedBrand?._id || brandId || null,
    productId: resolvedProduct?._id || productId || null,
    adId: adId || null,
    // MONEY: generate() attempt 1 returns the already-paid firstOutput.
    // attempt 2 (at most once) re-enters renderDirectImage with a corrective
    // operatorPrompt and skipVisionQc:true — one more billable editImage.
    generate: async ({ attempt, correctiveNote }) => {
      if (attempt === 1) return firstOutput;
      adStage(adId, `vision QC regen (${surface})`);
      return renderDirectImage({
        layoutInputArtifactId,
        aspectRatio,
        mediaId,
        productId,
        brandId,
        adId,
        adConceptArtifactId,
        adConceptId,
        template,
        referenceMediaIds,
        referenceSource,
        platformFormat,
        // When the operator replaced the prompt, the corrective note has to
        // ride INSIDE the override or it is discarded and this paid retry is a
        // guaranteed repeat of the failure. See composeCorrectiveOverride.
        operatorPrompt: overrideText ? null : correctiveNote,
        rawPromptOverride: overrideText
          ? composeCorrectiveOverride(overrideText, correctiveNote)
          : rawPromptOverride,
        skipVisionQc: true
      });
    },
    // Keep discarded (paid) renders durable — owner requirement.
    uploadAttempt: async ({ buffer: buf, attempt }) => {
      try {
        const { uploadBufferToCloudinary } = require('./cloudinaryService');
        const up = await uploadBufferToCloudinary(buf, {
          folder: `ads/qc-discarded/${brandId || 'unknown'}`,
          publicId: `${adId || 'ad'}-qc-a${attempt}-${Date.now()}`,
          resourceType: 'image',
          overwrite: false
        });
        return up.secure_url || up.url || null;
      } catch (err) {
        console.warn(`   ⚠️  direct-image: QC discard upload failed: ${err.message}`);
        return null;
      }
    }
  });

  if (!qcResult.ok) {
    adVisionQc.alertQcFailure({
      adId,
      brandId: resolvedBrand?._id || brandId,
      productId: resolvedProduct?._id || productId,
      brandName: resolvedBrand?.name,
      visionQc: qcResult.visionQc
    });
    const lastSummary = (qcResult.visionQc?.attempts || []).slice(-1)[0]?.summary || 'fail';
    const err = taggedError(
      `vision QC failed after ${qcResult.regenerationCount} regeneration(s): ${lastSummary}`,
      { alertLevel: 'error', alertKey: 'vision-qc:failed-after-retry' }
    );
    // MONEY: at least one image submit was charged; surface that + the verdict
    // (with discarded URLs) so the failure path can persist them.
    err.charged = true;
    err.visionQc = qcResult.visionQc;
    throw err;
  }

  console.log(
    `   ✅ direct-image vision QC pass — attempt=${qcResult.visionQc.finalAttempt} ` +
    `regens=${qcResult.regenerationCount}`
  );
  // Slack "accepted" notice. The real flag-off short-circuit already
  // happened above (`if (!adVisionQc.isEnabled()) return firstOutput`,
  // before runPostRenderQc is even called) — this call site always passes
  // `enabled: true`, so qcResult.skipped can never be true here today. The
  // `!qcResult.skipped` guard is still kept as defense-in-depth: it is the
  // thing that would stop a future refactor of this call site (e.g. one
  // that calls runPostRenderQc unconditionally and lets it decide) from
  // alerting on a verdict that was never produced.
  if (!qcResult.skipped) {
    adVisionQc.alertQcAccepted({
      adId,
      brandId: resolvedBrand?._id || brandId,
      productId: resolvedProduct?._id || productId,
      brandName: resolvedBrand?.name,
      visionQc: qcResult.visionQc
    });
  }
  return {
    ...qcResult.output,
    visionQc: qcResult.visionQc
  };
}

module.exports = {
  // Exported for the offline harness. renderDirectImage is the only entry point
  // the render path uses.
  // finishPlate is the exception: the recovery path is a SECOND legitimate caller
  // (see its header) — it finishes an already-paid Atlas output into a real ad.
  finishPlate,
  deliveryGeometryFor,
  safeBoxInDeliveredPx,
  extractFor,
  logoPlacementFor,
  monochromeInkFor,
  monochromeLogoBuffer,
  intentForTemplate,
  buildIntentData,
  describeProductForPrompt,
  conceptLook,
  normalizeReference,
  resolveImagePromptOverride,
  // MONEY: pinned by scripts/verifyRegeneration.js (R5) — without it the one
  // allowed vision-QC retry re-submits an identical prompt for a second charge.
  composeCorrectiveOverride,
  renderDirectImage
};
