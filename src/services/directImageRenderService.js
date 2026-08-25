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
const { toPrintableCustomerQuote, applyStrictQuoteScope, usableAttribution } = require('./quoteProvenance');
const { applyQuoteColourway } = require('./quoteColourway');
const { formatDisplayRating, resolveCoherentSocialProof, brandAttributionLabel } = require('./ratingDisplay');
// THE sanctioned concept reader. Direct reads of concept.rationale on this
// path are how private Director reasoning became art direction on 2026-08-01.
const { renderableCopy, artDirectionLook, conceptForRender } = require('./conceptProjection');
const { adStage, noteRenderIssue } = require('./adStage');
// Moderation-rejection seed fallback (2026-08-19) — see its header for the
// incident, the cost bound, and why a seed swap (not a bare retry) is safe.
const moderationSeedFallback = require('./moderationSeedFallback');

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
 * Mean luminance (0..1, greyscale) of `refBuffer` inside `box` — a
 * percentage rect {left,right,top,bottom} of the GENERATED frame, i.e.
 * `computeSurface(surface).box`, the exact region the prompt tells the
 * model text must live inside. Applied to the SEED reference photo (the
 * only pixels that exist before the billable submit), not a whole-frame
 * average — a whole-image average is exactly the wrong measurement here:
 * this product's own seed is a bone/cream tee against a mid-grey wall, so
 * a WHOLE-FRAME mean sits in the ambiguous middle while the actual text
 * region (upper-left, mostly wall) reads clearly light. Returns null when
 * the region cannot be read (missing/undersized reference, decode
 * failure) — callers must then leave ink choice to the model's own
 * judgement rather than assert a measurement that was never taken.
 *
 * APPROXIMATION, stated plainly: the seed photo and the model's generated
 * frame are not always pixel-registered — under SCENE_PRESERVE they are
 * (the photograph is the finished plate), but the "scene build" arm lets
 * the model recompose. Even there this is the best pre-submission signal
 * available; it is a measured reading of the actual product photo, not
 * the "you decide" default it replaces.
 */
async function sampleSafeBoxLuminance(refBuffer, box) {
  if (!refBuffer || !box) return null;
  try {
    const meta = await sharp(refBuffer).metadata();
    const w = meta.width, h = meta.height;
    if (!(w > 0 && h > 0)) return null;
    const left = Math.max(0, Math.min(w - 1, Math.round((box.left / 100) * w)));
    const right = Math.max(left + 1, Math.min(w, Math.round((box.right / 100) * w)));
    const top = Math.max(0, Math.min(h - 1, Math.round((box.top / 100) * h)));
    const bottom = Math.max(top + 1, Math.min(h, Math.round((box.bottom / 100) * h)));
    // ⚠️ Deliberately NOT `.extract(region).stats()` chained in one pipeline.
    // MEASURED on sharp 0.33.5: `.extract(rect).stats()` called without an
    // intervening re-encode returns stats for the WHOLE image, silently
    // ignoring the extract — reproduced on both a synthetic composite and a
    // real downloaded PNG (a 40x40 corner of the real Vuori logo read back
    // the same mean as the full 1108x179 file). Read the whole greyscale
    // frame as raw bytes once and average the region in JS instead, which
    // cannot hit this pipeline-ordering gap.
    const { data, info } = await sharp(refBuffer).greyscale().raw()
      .toBuffer({ resolveWithObject: true });
    let sum = 0, count = 0;
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        sum += data[(y * info.width + x) * info.channels];
        count++;
      }
    }
    if (!count) return null;
    return (sum / count) / 255;
  } catch {
    return null;
  }
}

/**
 * A measured, non-negotiable ink-polarity instruction for the model — the
 * D1 fix. Static ad headlines otherwise carry NO contrast guidance at all
 * (staticAdIntents.js's LATITUDE clause hands typography colour to "you
 * decide" along with typeface and weight), and that is provably
 * insufficient: the SAME headline text, same brand, same seed photo family,
 * rendered white-on-pale-grey (illegible) on one format and dark-on-pale
 * (correct) on another sibling format in the same run — the model guesses
 * per independent generation call with nothing to anchor it. This mirrors
 * the already-working pattern for the composited LOGO's ink
 * (monochromeInkFor, immediately below) but must run BEFORE generation,
 * against the seed photo, because headline text is typeset by the model
 * itself rather than composited afterwards.
 *
 * Returns null when no measurement was taken (sampleSafeBoxLuminance
 * failed) — the prompt then falls back to its pre-existing "you decide"
 * wording rather than asserting an unmeasured claim.
 */
function textInkDirective(meanLum) {
  // STRICT typeof, not `Number(meanLum)` first: `Number(null) === 0`,
  // `Number('') === 0`, and `Number(undefined) === NaN` — so any coercion
  // path lets a "no measurement taken" signal read as a false, CONFIDENT
  // luminance-0.0 (pure black) claim, which is the worse failure mode for
  // an instruction that opens "MEASURED, NOT A STYLE CHOICE". Same trap
  // class as `Number('') === 0`, documented repo-wide (see
  // remotion/lib/priceFormat.js). Only a genuine finite `number` primitive
  // is accepted; every other type (including numeric strings) is treated
  // as "not measured".
  if (typeof meanLum !== 'number') return null;
  const n = meanLum;
  if (!Number.isFinite(n)) return null;
  const backdropIsLight = n > 0.5;
  const ink = backdropIsLight ? 'dark, near-black' : 'light, near-white';
  const backdrop = backdropIsLight ? 'LIGHT' : 'DARK';
  return `TEXT INK — MEASURED FROM THE REFERENCE PHOTO, NOT A STYLE CHOICE. The reference photograph's own safe-box region — the area this brief already told you the headline/subheadline/eyebrow copy must sit inside — reads as ${backdrop} (mean luminance ${n.toFixed(2)} of 1.0, sampled from that exact region of the supplied photo, not a whole-frame average). Render the headline, subheadline and eyebrow text in ${ink} ink so it reads clearly against that backdrop. This is a legibility measurement, not a design preference — do not choose the opposite polarity for stylistic reasons. If your own final composition places that text over a region whose actual lightness differs from this reading, prioritise contrast against what you actually painted there over this instruction.`;
}

/**
 * D4 fix — CTA casing determinism. Measured live: the SAME derived CTA
 * string ("Shop the tee", verified byte-identical in every LayoutInputArtifact
 * for one Vuori run) rendered as three different casings across sibling
 * ads ("Shop the tee" / "Shop The Tee" / "Shop the Tee") — the generic
 * "SET EXACTLY THESE STRINGS, verbatim... spelling is critical" instruction
 * evidently is not read as covering LETTER CASE specifically (title-casing
 * a button label is a common enough stylistic default that the model
 * reverts to it under ambiguity). This calls out casing by name, once, for
 * the one role where it was observed to drift.
 */
function ctaCasingDirective(ctaText) {
  const s = String(ctaText || '').trim();
  if (!s) return null;
  return `CTA BUTTON CASING — reproduce "${s}" with EXACTLY this capitalisation, character for character. Do not title-case it, do not capitalise every word, do not change the case of "the"/"a"/"and" or any other word. The casing shown here IS the brand's copy, not a placeholder to restyle.`;
}

/**
 * Render-time CTA casing canonicalize. The prompt-side ctaCasingDirective
 * pins whatever string arrived; it cannot stop two sibling ads asking for
 * "Shop now" and "Shop Now" when those are the source strings.
 *
 * ONLY the generic phrases we ourselves emit (layoutInput default "Shop now",
 * mergeCta's "Shop the Brand"/"Shop the Collection", the former 'SHOP NOW'
 * fallback) are rewritten, case-insensitively. Product-specific copy
 * ("Shop the Mai Tai") is left byte-identical — that is content variety,
 * not casing drift.
 *
 * Applied in buildIntentData so cached LayoutInputArtifacts pick it up
 * without a re-derive.
 */
const GENERIC_CTA_CASING = Object.freeze({
  'shop now': 'Shop now',
  'shop the brand': 'Shop the brand',
  'shop the collection': 'Shop the collection',
});

function normalizeCtaCasing(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return GENERIC_CTA_CASING[s.toLowerCase()] || s;
}

/**
 * D4 fix — CTA pill fill/ink determinism, mirroring
 * services/titleSpecService.js buildBrandTokens' WCAG contrast pick
 * (readableOn) in miniature. NOT imported from that module: it also
 * resolves brand FONT FILES as part of building its token set, and this
 * pipeline deliberately never resolves fonts for static ads (see
 * conceptLook's header, a few lines up) — pulling in the whole token
 * builder to borrow one colour formula would reopen that boundary. Only
 * the colour cascade + contrast maths are duplicated.
 *
 * Cascade: brand.styleTheme.ctaBgColor (curated colour docs, canvas-engine
 * vocabulary) -> brand.accentColor -> brand.primaryColor -> a fixed
 * near-black fallback. Text ink picks whichever of pure black or pure
 * white has the HIGHER contrast ratio against that fill — computing both
 * and taking the winner, never a single luminance threshold (a mid-tone
 * fill like #5B8C5A has luminance ~0.49; a `>0.55 ? dark : white` cutoff
 * would choose white there at 1.93:1 contrast while black measures 9.3:1
 * on the same fill — see titleSpecService.js's own note on this).
 */
function hexOrNull(v) {
  const s = String(v || '').trim();
  const m6 = /^#?([0-9a-fA-F]{6})$/.exec(s);
  if (m6) return `#${m6[1].toUpperCase()}`;
  const m3 = /^#?([0-9a-fA-F]{3})$/.exec(s);
  if (m3) return `#${m3[1].split('').map((c) => c + c).join('').toUpperCase()}`;
  return null;
}
function ctaRelLuminance(hex) {
  const s = String(hex || '').replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  const chan = (v) => {
    const c = parseInt(v, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan(s.slice(0, 2)) + 0.7152 * chan(s.slice(2, 4)) + 0.0722 * chan(s.slice(4, 6));
}
function ctaContrastRatio(l1, l2) {
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}
const CTA_INK_DARK = '#16181D';
const CTA_INK_LIGHT = '#FFFFFF';
const CTA_FALLBACK_BG = '#16181D';
function deriveCtaColors(brand) {
  const bg = hexOrNull(brand?.styleTheme?.ctaBgColor) || hexOrNull(brand?.styleTheme?.ctaBg)
    || hexOrNull(brand?.accentColor) || hexOrNull(brand?.primaryColor) || CTA_FALLBACK_BG;
  const bgLum = ctaRelLuminance(bg);
  const explicitText = hexOrNull(brand?.styleTheme?.ctaTextColor) || hexOrNull(brand?.styleTheme?.ctaText);
  const text = explicitText || (bgLum == null
    ? CTA_INK_LIGHT
    : (ctaContrastRatio(ctaRelLuminance(CTA_INK_DARK), bgLum) >= ctaContrastRatio(ctaRelLuminance(CTA_INK_LIGHT), bgLum)
      ? CTA_INK_DARK : CTA_INK_LIGHT));
  return { bg, text };
}
function ctaColorDirective(colors) {
  if (!colors || !hexOrNull(colors.bg)) return null;
  const labelDesc = colors.text === CTA_INK_LIGHT ? 'white' : 'near-black';
  return `CTA BUTTON COLOUR — FIXED, NOT A STYLE CHOICE. Render the CTA button/pill fill as exactly ${colors.bg}, with ${labelDesc} (${colors.text}) label text. Use this exact fill colour for the CTA regardless of the surrounding scene's palette — it is the brand's own colour, not an art-direction pick for this composition.`;
}

// Serif/sans classification. This was previously a regex "duplicated by hand
// from services/fontResolverService.js's SERIF_HINTS" — the hand-copy is now
// gone, replaced by services/fontClassification.js, a PURE module (no I/O, no
// network, no DB) that both pipelines require.
//
// That does NOT breach the boundary the old comment was protecting: what must
// never be required from here is the font RESOLVER, because it fetches brand
// font FILES over the network and "Brand fonts are no longer resolved for
// static ads at all" (see the note a few lines above conceptLook's header).
// Agreeing on what the word "serif" MEANS is a pure string question and was
// only ever duplicated for want of a shared home.
const {
  classifyTypeface, storedGenericForFamily, isIconFontFamily,
  SERIF_HINTS: FONT_SERIF_HINTS,
} = require('./fontClassification');

function humanizeFontFamily(slug) {
  const s = String(slug || '').trim();
  if (!s) return '';
  return s.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * D1 fix — headline TYPEFACE determinism, one choice per BRAND, not per
 * concept or surface.
 *
 * Static headlines otherwise carry ZERO typography guidance:
 * staticAdIntents.js's LATITUDE clause hands typeface and weight to "you
 * decide" on every single generation call, and each of a run's six
 * surfaces is an INDEPENDENT gpt-image-2 submit with no shared state — the
 * model cannot "remember" what a sibling surface chose. Measured live
 * (run_1787119100250_eef4d871, Vuori tee): the SAME brand, SAME run, SAME
 * rendered headline text rendered SERIF on four surfaces and SANS on two,
 * plus three different headline-colour choices — a font-role identity that
 * changes by aspect ratio, not by any creative reason. This mirrors the
 * already-shipped fix for CTA colour/casing and headline ink: derive one
 * deterministic answer from data that does not vary per call, then assert
 * it identically into every prompt.
 *
 * BRAND-LEVEL is deliberate, not concept-level: `Brand.customFonts` /
 * `websiteFontUsage.heading` describe the brand's own identity and cannot
 * legitimately differ by which of a round's concepts a given surface
 * happens to draw, so pinning at the brand keeps every surface of one
 * product's run coherent regardless of concept spread. When the brand has
 * an ingested font (brandFontIngestService — Vuori's own "aktiv-grotesk",
 * mirrored on Cloudinary, 3 weights all HTTP 200 / valid wOF2) that family
 * is named explicitly, classified serif/sans by the same heuristic
 * `fontResolverService.fallbackFor` uses for the video path (so the two
 * pipelines agree on Aktiv Grotesk's own classification even though they
 * cannot share code — this only reads `family`, a plain string; it never
 * fetches `customFonts[].url`/`sourceUrl`, so the "sourceUrl needs a
 * Typekit Referer" trap that bites the FILE-fetching path cannot bite this
 * one). With no ingested or detected font at all, every such brand still
 * gets ONE consistent answer — sans-serif, the more common modern DTC ad
 * convention — rather than each surface improvising its own.
 */
function typefaceDirectiveForBrand(brand) {
  const headingRaw = brand?.websiteFontUsage?.heading || null;
  // Icon fonts are dingbats, not typefaces. Soludos GS stored
  // `button: 'oke-widget-icons'` from a ::before rule; if that family had
  // won `heading` (or been customFonts[0]) it would be named to gpt-image-2
  // as the brand's own face. Skip them here so a stored icon-font role is
  // a no-op on the prompt, not a second classification bug.
  const heading = headingRaw && !isIconFontFamily(headingRaw) ? headingRaw : null;
  const fonts = (Array.isArray(brand?.customFonts) ? brand.customFonts : [])
    .filter((f) => f?.family && !isIconFontFamily(f.family));
  const ingested = (heading && fonts.find((f) => f?.family === heading)) || fonts[0] || null;
  const family = ingested?.family || heading || null;

  if (family) {
    const readable = humanizeFontFamily(family);
    // The brand's OWN stylesheet fills the gap the family-name keyword list
    // cannot: Marine Layer's real ingested face "Seriously Nostalgic" is a
    // Didone display SERIF matching no serif keyword, so the name heuristic
    // alone instructed gpt-image-2 to set a "clean, modern sans-serif" while
    // the VIDEO path — which loads the real file and never has to guess —
    // rendered the same brand as a serif. Their CSS says `font-family:
    // Seriously Nostalgic, serif`; that generic is captured at ingest
    // (brandFontIngestService) and read back here.
    //
    // NOTE the generic does NOT outrank a positive keyword match — read
    // fontClassification.js's PRECEDENCE section before changing this. A
    // recognised serif type name wins, because a real-world sloppy
    // `font-family: Playfair Display, sans-serif` would otherwise flip a brand
    // the keyword list already gets right. Brands with no captured generic
    // classify exactly as they did before.
    //
    // Soludos GS (2026-08-24): heading was null because ingest missed a
    // cross-sheet `var(--FONT-STACK-HEADING)` whose value is `Newsreader,
    // serif`. The classifier here is unchanged; ingest now captures that
    // generic. Do not add "Newsreader" to SERIF_HINTS.
    const isSerif = classifyTypeface({
      family,
      generic: storedGenericForFamily(brand, family),
    }) === 'serif';
    const styleWord = isSerif ? 'serif' : 'sans-serif';
    const characterClause = isSerif
      ? 'refined editorial serif proportions'
      : 'clean grotesque/humanist proportions';
    return `HEADLINE TYPEFACE — FIXED, NOT A STYLE CHOICE. This brand's own typeface is ${readable}, a ${styleWord}. Set the headline, subheadline and eyebrow copy in a ${styleWord} with ${characterClause}, in the spirit of ${readable}. Do not switch to the opposite family (serif vs sans) for stylistic reasons — every surface of this brand's campaign must render the SAME typeface family; only the composition should vary.`;
  }
  // No ingested or detected brand font — still pin ONE family so a run's
  // independent per-surface generation calls cannot each improvise a
  // different answer. The specific choice (sans) matters far less than
  // that it is the SAME choice on every call.
  return `HEADLINE TYPEFACE — FIXED, NOT A STYLE CHOICE. Set the headline, subheadline and eyebrow copy in a clean, modern sans-serif with grotesque/humanist proportions. Do not switch to a serif face for stylistic reasons — every surface of this brand's campaign must render the SAME typeface family; only the composition should vary.`;
}

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
  // Strict typeof before any coercion: `Number(null) === 0` and
  // `Number('') === 0` would otherwise read as a confident "pure black
  // backdrop" instead of "no measurement" — see textInkDirective's header
  // for the general form of this trap.
  if (typeof meanLum !== 'number') return null;
  const n = meanLum;
  if (!Number.isFinite(n)) return null;      // unknown → caller keeps the original asset
  return n > 0.5 ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
}

/**
 * Rec.709-weighted luminance of an sRGB triple, 0..1, NO per-channel
 * gamma linearization.
 *
 * Used only on LOW-chroma (near-grey) pixels, where Rec.709, Rec.601 and
 * sharp greyscale agree. `behindLuminance` is production
 * `sharp().greyscale()` mean / 255 (finishPlate) — measured on sharp
 * 0.33.5 that is NEITHER Rec.601 nor Rec.709-no-gamma on chromatic
 * primaries (red 124 vs 76 vs 54). Do not "align" the two formulas:
 * this helper must stay in the same encoded 0..1 space as the plate
 * number. Linearization of that encoded grey happens in
 * inkContrastRatio, not here.
 */
function logoPixelLuminance(r, g, b) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * sRGB-encoded 0..1 channel → linear (IEC 61966-2-1 / WCAG 2.x relative
 * luminance). Threshold is the sRGB breakpoint 0.04045, not the 0.03928
 * WCAG 2.0 transcription. Applied to already-greyscale 0..1 values
 * (behindLuminance, logoPixelLuminance) — not per RGB channel.
 *
 * Load-bearing as a PAIR with the 4.5 floor. Linearize
 * alone (floor 3) classifies the failing 0.56 plate as ~3.24:1 and
 * SKIPS the re-ink. Floor 4.5 alone (no linearize) classifies the
 * good 0.27 plate as 3.28:1 and RE-INKS Mai Tai to black. Pinned by
 * scripts/verifyLogoColorPreservation.js L6 matrix.
 */
function srgbEncodedToLinear(c) {
  if (typeof c !== 'number' || !Number.isFinite(c)) return 0;
  const x = c < 0 ? 0 : c > 1 ? 1 : c;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

/**
 * Contrast ratio between two sRGB-encoded 0..1 luminances. True WCAG 2.x
 * relative-luminance: linearize each value, then (hi+0.05)/(lo+0.05).
 *
 * Exported so the harness pins the measured Pelagic plates against the
 * shipped function, not a copy. contrastingInkFor uses this same helper
 * so the picker and the re-ink gate cannot disagree on the metric.
 */
function inkContrastRatio(L1, L2) {
  if (typeof L1 !== 'number' || typeof L2 !== 'number') return 0;
  if (!Number.isFinite(L1) || !Number.isFinite(L2)) return 0;
  const a = srgbEncodedToLinear(L1);
  const b = srgbEncodedToLinear(L2);
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

// WCAG 2.x AA normal-text floor, applied AFTER sRGB linearization.
// Measured on the Pelagic batch that exhibited the defect:
//   white vs Ws Aquatek 0.56 → 3.24  (wordmark invisible; 28% below 4.5)
//   white vs Mai Tai     0.27 → 9.61  (wordmark present;  114% above 4.5)
// BOTH the linearization and this floor are required. The white-ink
// cliff (ratio === 4.5) is plate L ≈ 0.465, so Mai Tai has 0.195 of
// headroom — the previous non-linear floor-3 cliff was 0.300, leaving
// only 0.03, inside ordinary shot-to-shot variance of behindLuminance
// (a mean over the plate region, not a controlled constant).
const LOGO_MIN_INK_CONTRAST = 4.5;

const INK_BLACK = { r: 0, g: 0, b: 0 };
const INK_WHITE = { r: 255, g: 255, b: 255 };

/**
 * Pick black or white ink, whichever has higher contrast against the plate.
 * Uses inkContrastRatio, so it is linearized on the SAME basis as the
 * re-ink gate. Independent of monochromeInkFor's 0.5 split.
 *
 * Linearized black/white crossover is plate L ≈ 0.460 (both inks 4.58:1).
 * The non-linear picker crossed at ≈ 0.179 and chose BLACK from 0.20
 * upward — including Mai Tai 0.27, where black's true WCAG ratio is
 * only 2.19 (fails 4.5) and white is 9.61. Using that picker with the
 * linearized gate would re-ink a failing dark wordmark to still-failing
 * black ink.
 *
 * Disagrees with monochromeInkFor only in the 0.460–0.500 band (this
 * picker BLACK, 0.5-split WHITE). 0.49 is the remaining pin. Using
 * monochromeInkFor here would re-ink a white wordmark to white on any
 * plate ≤ 0.5 — still invisible on 0.49.
 */
function contrastingInkFor(behindLuminance) {
  if (typeof behindLuminance !== 'number' || !Number.isFinite(behindLuminance)) {
    return null;
  }
  const blackC = inkContrastRatio(0, behindLuminance);
  const whiteC = inkContrastRatio(1, behindLuminance);
  return whiteC >= blackC ? INK_WHITE : INK_BLACK;
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
/**
 * Does this asset's alpha channel actually encode the mark's coverage?
 *
 * True only when a meaningful share of pixels is essentially fully transparent
 * — the signature of a real cut-out. An asset whose alpha is uniformly (or
 * nearly uniformly) opaque carries no shape information there, and using it as
 * coverage fills the whole logo box with ink.
 *
 * Threshold rationale: 2% of pixels below alpha 16. A cut-out logo is mostly
 * empty space (the measured Vuori asset yields 58% transparent once read via
 * luminance), so a real one clears this by an order of magnitude, while the
 * broken case measured 0%. Deliberately generous — a false "discriminates"
 * merely keeps today's behaviour, whereas a false negative would send a
 * correctly-cut-out logo down the luminance path.
 *
 * Exported for scripts/verifyLogoSilhouette.js.
 */
async function alphaChannelDiscriminates(logoPng) {
  try {
    const alpha = await sharp(logoPng).ensureAlpha().extractChannel(3).raw().toBuffer();
    if (!alpha || !alpha.length) return false;
    let transparent = 0;
    for (let i = 0; i < alpha.length; i++) if (alpha[i] <= 16) transparent++;
    return (transparent / alpha.length) >= 0.02;
  } catch {
    // Unreadable alpha → fall back to luminance, which needs no alpha at all.
    return false;
  }
}

async function monochromeLogoBuffer(logoPng, ink) {
  const meta = await sharp(logoPng).metadata();
  const w = meta.width, h = meta.height;
  if (!(w > 0 && h > 0)) return null;

  let coverage;
  // ⚠️ `hasAlpha` is NOT the same question as "does the alpha channel encode the
  // mark". MEASURED on a live brand logo (Vuori, 1108x179 RGBA): the asset has
  // an alpha channel in which **100% of pixels sit in the 204-254 band** — its
  // "transparent" background is ~80-100% opaque. Trusting `hasAlpha` therefore
  // took the alpha branch, produced coverage that was opaque EVERYWHERE, and
  // painted a SOLID INK RECTANGLE over the artwork — reproduced exactly against
  // the real asset, and visible on delivered ads as a black bar on light plates
  // and a white bar on dark ones.
  //
  // So require the channel to actually DISCRIMINATE before believing it: a real
  // cut-out logo has a substantial fully-transparent region around the mark. A
  // solid-shape logo on a genuine transparent background still passes, because
  // the area OUTSIDE the shape is alpha 0. When it does not discriminate the
  // asset is effectively opaque, and luminance — the branch below, which renders
  // this same logo's wordmark correctly — is the right reader.
  const alphaDiscriminates = meta.hasAlpha
    ? await alphaChannelDiscriminates(logoPng)
    : false;
  if (alphaDiscriminates) {
    coverage = await sharp(logoPng).ensureAlpha().extractChannel(3).raw().toBuffer();
  } else {
    // Sample the outer border to learn the asset's own background polarity.
    // ⚠️ NOT `.extract(strip).stats()` chained directly — MEASURED on sharp
    // 0.33.5, that returns the WHOLE image's stats, silently ignoring the
    // extract (reproduced on a real downloaded logo PNG, not merely a
    // synthetic fixture; see sampleSafeBoxLuminance's comment for the
    // measurement). Read the raw greyscale buffer once and average the
    // border strip's own rows in JS instead.
    const grey = sharp(logoPng).removeAlpha().greyscale();
    const edge = Math.max(1, Math.round(Math.min(w, h) * 0.04));
    const { data: greyRaw, info: greyInfo } = await grey.clone().raw()
      .toBuffer({ resolveWithObject: true });
    let stripSum = 0, stripCount = 0;
    for (let y = 0; y < edge; y++) {
      for (let x = 0; x < w; x++) {
        stripSum += greyRaw[(y * greyInfo.width + x) * greyInfo.channels];
        stripCount++;
      }
    }
    const bgIsLight = stripCount > 0 && (stripSum / stripCount) / 255 > 0.5;
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

/**
 * Robust background-colour estimate for an opaque logo canvas: the
 * component-wise MEDIAN of four corner patches' mean colour, not the single
 * top-edge strip `monochromeLogoBuffer` samples.
 *
 * Exists because a single-edge sample breaks exactly when the artwork's own
 * graphic starts flush against that edge — the measured Vuori asset's
 * orange->blue gradient block begins at row 0, so a top-strip sample reads
 * the MARK ITSELF as if it were the canvas. Four independent corners need
 * three of four to be fooled the same way, not one.
 */
async function estimateOpaqueLogoBackground(logoPng, w, h) {
  const edge = Math.max(1, Math.round(Math.min(w, h) * 0.04));
  const corners = [
    { left: 0, top: 0 },
    { left: Math.max(0, w - edge), top: 0 },
    { left: 0, top: Math.max(0, h - edge) },
    { left: Math.max(0, w - edge), top: Math.max(0, h - edge) },
  ];
  // ⚠️ ONE raw decode, corners averaged in JS — deliberately not
  // `.extract(corner).stats()` per corner. MEASURED on sharp 0.33.5:
  // `.extract(rect).stats()` chained without an intervening re-encode
  // silently returns stats for the WHOLE image, ignoring the extract
  // (reproduced on a real downloaded PNG, not just a synthetic fixture —
  // see sampleSafeBoxLuminance's comment for the measurement). That would
  // have made every one of these four corners report the SAME whole-image
  // mean, defeating the entire point of sampling four independent corners.
  let raw, info;
  try {
    ({ data: raw, info } = await sharp(logoPng).removeAlpha().raw()
      .toBuffer({ resolveWithObject: true }));
  } catch {
    return null;
  }
  const means = [];
  for (const c of corners) {
    const cw = Math.min(edge, w - c.left);
    const ch = Math.min(edge, h - c.top);
    if (cw <= 0 || ch <= 0) continue;
    const sums = [0, 0, 0];
    let count = 0;
    for (let y = c.top; y < c.top + ch; y++) {
      for (let x = c.left; x < c.left + cw; x++) {
        const idx = (y * info.width + x) * info.channels;
        sums[0] += raw[idx]; sums[1] += raw[idx + 1]; sums[2] += raw[idx + 2];
        count++;
      }
    }
    if (count > 0) means.push(sums.map((s) => s / count));
  }
  if (!means.length) return null;
  const medianOf = (vals) => {
    const s = [...vals].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  return [0, 1, 2].map((ch) => medianOf(means.map((m) => m[ch])));
}

/**
 * Binary "does this pixel belong to the mark" coverage mask (0 or 255 per
 * pixel), from per-pixel RGB distance to the estimated background colour.
 *
 * Replaces greyscale LUMINANCE as a coverage proxy for this one purpose.
 * Luminance-as-coverage is exactly wrong for artwork with real internal
 * luminance variation — a colour gradient — because it renders a
 * TRANSLUCENT BLEND with whatever the logo sits on instead of an opaque
 * shape: measured on the delivered Vuori render, the orange->blue block came
 * out as a grey gradient fading into the ad's own background, not a solid
 * rectangle. A binary distance threshold has no such gradient artifact.
 */
async function coverageFromBackgroundDistance(logoPng, bg, w, h, { threshold = 32 } = {}) {
  const raw = await sharp(logoPng).removeAlpha().raw().toBuffer();
  const coverage = Buffer.alloc(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = raw[i * 3], g = raw[i * 3 + 1], b = raw[i * 3 + 2];
    const dr = r - bg[0], dg = g - bg[1], db = b - bg[2];
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);
    coverage[i] = dist > threshold ? 255 : 0;
  }
  return coverage;
}

/**
 * Is the artwork under `coverage` (the mark itself, not the canvas around
 * it) genuinely multi-hue, or effectively monochrome ink?
 *
 * Mean per-pixel CHROMA (max channel - min channel, 0..255) over covered
 * pixels only. A flat-colour wordmark — black, navy, any single brand tint —
 * reads near zero regardless of how dark or light it is. A colour gradient
 * (Vuori's orange fading to blue) reads high. Scored only over the mark's
 * own pixels so the surrounding canvas colour cannot influence the verdict.
 *
 * Exported so scripts/verifyLogoColorPreservation.js calls this instead of a
 * mirror of it.
 */
const LOGO_CHROMA_THRESHOLD = 24;

async function logoIsPolychrome(logoPng, coverage, w, h, { chromaThreshold = LOGO_CHROMA_THRESHOLD, minCoveredFrac = 0.01 } = {}) {
  const raw = await sharp(logoPng).removeAlpha().raw().toBuffer();
  let covered = 0;
  let chromaSum = 0;
  for (let i = 0; i < w * h; i++) {
    if (!coverage[i]) continue;
    covered++;
    const r = raw[i * 3], g = raw[i * 3 + 1], b = raw[i * 3 + 2];
    chromaSum += Math.max(r, g, b) - Math.min(r, g, b);
  }
  if (covered < w * h * minCoveredFrac) return false; // too little marked area to judge
  return (chromaSum / covered) > chromaThreshold;
}

/**
 * THE ENTRY POINT for logo compositing — decides colour treatment before
 * `monochromeLogoBuffer` (unchanged, still used for the monochrome branch)
 * ever runs.
 *
 * Owner's monochrome-ink rule (see monochromeLogoBuffer's header) was
 * written against a wordmark-on-opaque-canvas defect (AllBirds) and is
 * right for that shape: a single-ink mark should pick clean black-or-white
 * ink off whatever it sits on. It is WRONG for a mark whose colour IS the
 * brand asset — measured live: Vuori's real logomark (1108x179 RGBA) is an
 * orange-to-blue gradient block plus a wordmark, and forcing it through
 * monochrome ink discards the brand's only colour asset, "the first
 * client's logo" per the owner review that found this.
 *
 * So: derive a coverage mask (alpha channel if it genuinely discriminates,
 * else the corner-background-distance mask above — never raw greyscale
 * luminance, for the translucent-gradient reason documented on
 * coverageFromBackgroundDistance), then ask whether the MARKED pixels are
 * polychrome. Polychrome → composite the artwork's OWN colours under that
 * mask, then re-ink LOW-chroma covered pixels whose contrast against the
 * plate is below LOGO_MIN_INK_CONTRAST (bidirectional: light ink on a dark
 * plate, dark ink on a light plate). High-chroma pixels are never
 * re-inked — brand-colour preservation wins over legibility there, because
 * a contrast rule on those pixels would flatten Pelagic's #0055b8 / #c10230
 * tiles on BOTH measured plates (they fail 4.5:1 against 0.27 and 0.56).
 * Otherwise → fall through to the existing, unchanged monochromeLogoBuffer
 * path (every other brand's simple wordmark keeps today's behaviour exactly).
 *
 * @returns {Promise<{buffer: Buffer, treatment: 'colour-preserved'|'monochrome'|'original', ink?: object}>}
 */
async function prepareLogoForComposite(logoPng, { behindLuminance } = {}) {
  const meta = await sharp(logoPng).metadata();
  const w = meta.width, h = meta.height;
  if (!(w > 0 && h > 0)) return { buffer: logoPng, treatment: 'original' };

  const alphaDiscriminates = meta.hasAlpha ? await alphaChannelDiscriminates(logoPng) : false;

  let coverage = null;
  try {
    if (alphaDiscriminates) {
      coverage = await sharp(logoPng).ensureAlpha().extractChannel(3).raw().toBuffer();
    } else {
      const bg = await estimateOpaqueLogoBackground(logoPng, w, h);
      if (bg) coverage = await coverageFromBackgroundDistance(logoPng, bg, w, h);
    }
  } catch {
    coverage = null; // fall through to the existing monochrome path below
  }

  if (coverage) {
    let polychrome = false;
    try {
      polychrome = await logoIsPolychrome(logoPng, coverage, w, h);
    } catch { polychrome = false; }
    if (polychrome) {
      // removeAlpha DROPS the channel and keeps source RGB — it does not
      // composite onto black. A 50% white AA fringe stays (255,255,255)
      // and follows the same contrast rule as solid white. (Measured on
      // sharp 0.33.5: flatten({background:black}) is the premultiply path.)
      // White vs Mai Tai 0.27 is 9.61:1 linearized, so a white fringe is
      // NOT re-inked to a black outline on that plate.
      const rgb = await sharp(logoPng).removeAlpha().raw().toBuffer();
      // Mixed lockup (colour tiles / gradient + a low-chroma wordmark).
      // Colour-preserving the whole mark is right for the tiles and wrong
      // for a wordmark whose contrast against the GENERATED plate is too
      // low: the letterforms vanish, the tiles stay, and the same SVG
      // reads as two lockups across one batch.
      //
      // THE PELAGIC CASE, measured not argued:
      //   SVG fills: #ffffff (wordmark) / #0055b8 / #c10230 (tiles). There
      //   is no dark wordmark. Ws Aquatek plate behind the logo = 0.56
      //   (white wordmark invisible). Mai Tai plate = 0.27 (white wordmark
      //   clearly present). A dark-plate-only re-ink to LIGHT ink is the
      //   inverted fix: 0.56 never fires, and light ink is what vanished.
      //
      // Re-ink only LOW-chroma covered pixels, and only when their contrast
      // against the plate is below LOGO_MIN_INK_CONTRAST (true WCAG
      // relative luminance, floor 4.5 — both, as a pair). Ink is whichever
      // of black/white maximises contrast on that same metric — NOT
      // monochromeInkFor's 0.5 split. High-chroma pixels stay untouched
      // on purpose (see header).
      const ink = contrastingInkFor(behindLuminance);
      if (ink) {
        for (let i = 0; i < w * h; i++) {
          if (!coverage[i]) continue;
          const o = i * 3;
          const r = rgb[o], g = rgb[o + 1], b = rgb[o + 2];
          if (Math.max(r, g, b) - Math.min(r, g, b) > LOGO_CHROMA_THRESHOLD) continue;
          const pixelL = logoPixelLuminance(r, g, b);
          if (inkContrastRatio(pixelL, behindLuminance) < LOGO_MIN_INK_CONTRAST) {
            rgb[o] = ink.r; rgb[o + 1] = ink.g; rgb[o + 2] = ink.b;
          }
        }
      }
      const buffer = await sharp(rgb, { raw: { width: w, height: h, channels: 3 } })
        .joinChannel(coverage, { raw: { width: w, height: h, channels: 1 } })
        .png()
        .toBuffer();
      return { buffer, treatment: 'colour-preserved' };
    }
  }

  const ink = monochromeInkFor(behindLuminance);
  if (!ink) return { buffer: logoPng, treatment: 'original' };
  const mono = await monochromeLogoBuffer(logoPng, ink);
  return mono ? { buffer: mono, treatment: 'monochrome', ink } : { buffer: logoPng, treatment: 'original' };
}

/**
 * The exact string, if any, that `builtText` (an intent's post-density-budget
 * [role, string] pairs — `staticAdIntents.buildPrompt(...).text`) asked the
 * model to typeset for `role`. Returns null when the role was never in the
 * prompt at all (a role this intent doesn't define, or one the density
 * budget sacrificed) — the ONLY correct reading for a copy snapshot, because
 * a role absent from the prompt was never drawn. Exported so
 * scripts/verifyCopySnapshot.js calls this instead of a mirror of it.
 */
function renderedTextForRole(builtText, role) {
  const hit = (Array.isArray(builtText) ? builtText : []).find(([r]) => r === role);
  return hit ? hit[1] : null;
}

/**
 * Logo-only safe-margin FLOOR, mirroring remotion/lib/safeZones.js's
 * SAFE_ZONES table (stories / feed / square / landscape entries) — that
 * file is an ES module inside the video titling engine, this is the
 * CommonJS static-image path, and the two do not share a module graph, so
 * the fractions are duplicated by hand rather than imported. Keep both in
 * sync if either changes.
 *
 * WHY A SEPARATE TABLE FROM computeSurface's text box: that box is sized
 * for where the MODEL may typeset copy, tuned per surface for its own
 * reasons (PMax's per-axis crop margin, Meta's short-side margin — see
 * staticAdIntents.js). It is not the platform's own safe-area guarantee.
 * Measured live on meta_stories_9_16: the text box's right edge lands at
 * ~94% of the generated frame (≈1015px of 1080 delivered) — inside the
 * canvas, but outside the platform's own 7.5% (≈999px) safe margin, and on
 * a wider logo asset than measured here the composited mark can reach the
 * delivered edge outright. This table is applied as a FLOOR intersected
 * with the text box below — it can only tighten the logo's placement box,
 * never loosen it past what the text box already promised the model.
 */
const LOGO_SAFE_MARGIN_PCT = {
  meta_stories_9_16:     { top: 0.14, bottom: 0.14, left: 0.075, right: 0.075 }, // safeZones.stories
  meta_feed_1_1:         { top: 0.06, bottom: 0.06, left: 0.065, right: 0.06 },  // safeZones.feed
  meta_feed_4_5:         { top: 0.06, bottom: 0.06, left: 0.065, right: 0.06 },  // safeZones.feed
  pmax_landscape_1_91_1: { top: 0.10, bottom: 0.10, left: 0.075, right: 0.075 }, // safeZones.landscape
  pmax_square_1_1:       { top: 0.06, bottom: 0.06, left: 0.065, right: 0.06 },  // safeZones.square
  pmax_portrait_4_5:     { top: 0.06, bottom: 0.06, left: 0.065, right: 0.06 },  // safeZones.feed (4:5 shares feed's padding)
  pmax_16_9:             { top: 0.10, bottom: 0.10, left: 0.075, right: 0.075 }  // safeZones.landscape
};

function logoPlacementFor({ surface, dims, logoW, logoH }) {
  const box = safeBoxInDeliveredPx(surface, dims);
  // Clamp the BOX into the delivered frame before placing anything in it, rather
  // than clamping the result afterwards. Clamping afterwards can shove the mark
  // back across the very edge the box exists to enforce — and the percentage
  // round-trip does put an edge a pixel outside on 4:5 (top computes to -1), so
  // this is not hypothetical arithmetic.
  let left = Math.max(0, box.left);
  let right = Math.min(dims.width, box.right);
  let top = Math.max(0, box.top);
  let bottom = Math.min(dims.height, box.bottom);
  // Bind the platform safe-area floor — see LOGO_SAFE_MARGIN_PCT above.
  // Math.max/min against the box already computed: whichever margin is
  // TIGHTER for a given edge wins.
  const floor = LOGO_SAFE_MARGIN_PCT[surface?.key];
  if (floor && dims?.width > 0 && dims?.height > 0) {
    left = Math.max(left, Math.round(floor.left * dims.width));
    right = Math.min(right, dims.width - Math.round(floor.right * dims.width));
    top = Math.max(top, Math.round(floor.top * dims.height));
    bottom = Math.min(bottom, dims.height - Math.round(floor.bottom * dims.height));
  }
  // Strict interior of the QC-declared box. Aligning flush (`right - logoW`
  // against the un-inset edge) is what the 2026-08-24 layout_safe_box
  // failures measured: vision QC is handed the same safeBoxInDeliveredPx
  // numbers and treats a mark sitting ON those coordinates as a breach.
  // The frame-gap harness stayed green because the box is already inset
  // from the frame. See LOGO_INSET_FRAC.
  const inset = logoInsetPx(dims);
  left += inset;
  right -= inset;
  top += inset;
  bottom -= inset;
  if (!(logoW > 0 && logoH > 0)) return null;
  if (right - left < logoW || bottom - top < logoH) return null;
  // Bottom-right of the inset box. Strictly inside the QC box and the
  // platform floor by construction (inset ≥ 1px on every live canvas).
  return { top: bottom - logoH, left: right - logoW, width: logoW, height: logoH };
}

/**
 * Extra inset on top of the text-box ∩ platform-floor intersection, so the
 * composited mark cannot sit ON the box edge the vision-QC inspector is
 * given. 2% of the delivered short edge (~22px on 1080, ~13px on 628) —
 * one third of Meta's 6% text margin. Large enough for a vision inspector
 * to see, small enough that the mark stays in the reserved corner. Floor
 * 8px so a tiny canvas still has a visible gap.
 *
 * This does NOT shrink the square resize box (that was the stacked-lockup
 * legibility fix). It only moves the already-sized mark up and left.
 */
const LOGO_INSET_FRAC = 0.02;
const LOGO_INSET_PX_FLOOR = 8;

function logoInsetPx(dims) {
  const short = Math.min(dims && dims.width, dims && dims.height);
  if (!(short > 0)) return LOGO_INSET_PX_FLOOR;
  return Math.max(LOGO_INSET_PX_FLOOR, Math.round(LOGO_INSET_FRAC * short));
}

/**
 * Max box the composited logomark is scaled into (`fit:'inside'`).
 *
 * Side is 16% of the delivered short edge so the mark is the same physical
 * size on every surface. The box is SQUARE. A WIDE wordmark still binds on
 * width (Vuori 1108×179 → height ≈ 0.16 of width, unchanged). A STACKED
 * lockup (wordmark above a two-tile mark, ~1:1) used to be crushed into
 * height = 0.35 × width (~60px on 1080), which made the wordmark
 * illegible and, after coverage-at-that-size, dropped it.
 */
const LOGO_BOX_FRAC = 0.16;

function logoResizeBox(dims) {
  const w = dims && dims.width, h = dims && dims.height;
  if (!(w > 0 && h > 0)) return { width: 0, height: 0 };
  const side = Math.round(LOGO_BOX_FRAC * Math.min(w, h));
  return { width: side, height: side };
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

/**
 * STATIC quote-length policy. Exported so the harness can execute the SHIPPED
 * logic rather than a mirror of it (both adversarial passes flagged that seam).
 *
 * Default 140, not 200: measured static text fidelity is 139/140 strings across
 * 20 renders, so that is the band this surface is known to typeset reliably.
 *
 * VALIDATED, not bare-coerced. `Number(env || 140)` turns "abc" into NaN, and
 * `len <= NaN` is false, so a single dashboard typo would silently send every ad
 * back to the 50-char video snippet — the exact defect this change exists to fix,
 * wearing a config disguise and raising no error. "0"/"-5" fail the same way, and
 * "Infinity" fails the opposite way (no cap at all). Anything that is not a
 * finite positive number falls back to the default and says so.
 * @returns {number}
 */
function resolveStaticQuoteCap(rawEnv) {
  const parsed = Number(rawEnv);
  const supplied = rawEnv != null && rawEnv !== '';
  if (supplied && Number.isFinite(parsed) && parsed > 0) return parsed;
  if (supplied) {
    console.warn(`   ⚠️  STATIC_QUOTE_MAX_CHARS="${rawEnv}" is not a positive number — using ${STATIC_QUOTE_DEFAULT_CAP}`);
  }
  return STATIC_QUOTE_DEFAULT_CAP;
}

/**
 * 100, down from 140 (owner, 2026-08-11: *"quotes have suddenly become much longer,
 * maybe too long… I liked the length we were at before"*).
 *
 * The 140 was chosen when the alternative was a ≤50-char curated snippet, and the
 * complaint then was that the snippet was a subjectless fragment. Both bars are real:
 * the quote must FINISH ITS THOUGHT, and it must not turn into a paragraph on a feed
 * card. 100 is the widest that reliably holds one complete sentence, which is the shape
 * that satisfies both — the video overlay keeps its own 50 and is untouched.
 */
const STATIC_QUOTE_DEFAULT_CAP = Number(process.env.STATIC_QUOTE_DEFAULT_CAP || 100);

/**
 * Pick the quote string a STATIC ad typesets.
 *
 * `quote.snippet` is a <=50-char extraction whose own service header states its
 * purpose outright: "suitable for a 3-second video overlay" (quoteSnippetService,
 * MAX_CHARS = 50, prompt asks for "4-8 words"). That video-shaped cap was applied
 * to static too, and at 50 chars the extractor drops the subject: "The quality is
 * amazing and the pair I have feel like second skin" became "feel like second
 * skin" — a subjectless fragment with a stranded plural verb, which is what the
 * owner flagged on a delivered Vuori ad ("sounds idiomatically incorrect").
 *
 * A static feed ad has far more room than a 3s overlay, so prefer the FULL
 * sentence when it fits. The original concern is preserved rather than discarded:
 * a 200-character quote at testimonial size IS unreadable at feed scale, and the
 * cap is what enforces that. What was wrong for this surface was the 50, not the
 * existence of a cap.
 *
 * OVERFLOW IS BOUNDED. An earlier draft fell back to `snippet || full`, which
 * meant a 500-char review with no snippet (snippet job failed, legacy artifact)
 * shipped in full — the cap silently not applying on the one path that needed it
 * most. An adversarial pass caught it, and worse, the harness had pinned that
 * behaviour as required. Now: snippet if present, else a word-boundary truncation
 * to the cap, reusing quoteSnippetService.truncateAtWordBoundary rather than a
 * second slicing implementation that could drift from it.
 *
 * @param {null|{text?:string,snippet?:string}} quote
 * @param {{fullQuoteEnabled?:boolean, cap?:number}} [opts]
 * @returns {string}
 */
function selectStaticQuoteText(quote, { fullQuoteEnabled = true, cap = STATIC_QUOTE_DEFAULT_CAP } = {}) {
  // Flag-off restores the exact pre-change expression, byte for byte.
  if (!fullQuoteEnabled) {
    return quote ? String(quote.snippet || quote.text || '').trim() : '';
  }
  const full = quote ? String(quote.text || '').trim() : '';
  const snippet = quote ? String(quote.snippet || '').trim() : '';
  if (!full && !snippet) return '';

  const { completeSentencePrefix, finishesThought } = require('../utils/htmlEntities');
  // The longest run of WHOLE SENTENCES that fits. A literal prefix of `full`, so this
  // is selection, never repair.
  const whole = full ? completeSentencePrefix(full, cap) : '';

  // THE STRING WE TYPESET IS NOT THE STRING THAT WAS JUDGED.
  //
  // Owner directive 2026-08-11: *"at no time should mediocre or negative sentiment
  // pass any gate from initial screening to selection for use in an ad."* An audit of
  // every hop found this one: `pickStrongestQuote` judges the FULL quote text at
  // artifact build, and then the overflow path here typesets a ≤50-char curated
  // snippet that was never judged on its own. Measured: "feel like second skin",
  // "true to size", "awesome fit" all FAIL the render path's own bar while their
  // parent quote passes it. That is how a subjectless fragment became the testimonial.
  //
  // So every candidate form is judged before it can be returned, in preference order,
  // and if none of them clears the bar we print NO quote and let intent fallback do
  // its job. A missing testimonial costs one ad format; a mediocre one costs the client.
  const judge = loadAdCopyJudge();
  const usable = (text) => {
    if (!text) return false;
    if (text.length > cap) return false;
    // THE UNABRIDGED TEXT IS TRUSTED; EVERY STRING WE MANUFACTURE IS NOT.
    //
    // `full` was already judged upstream — twice now: screenAdUsableSentiment at
    // retrieval, and pickStrongestQuote when layoutInputService chose it as the primary
    // (layoutInputService.js `return hasPositiveSignal(best.text) ? best : null`).
    // Re-judging it here adds no safety and costs real quotes, because
    // hasPositiveSignal is a LEXEME allowlist: "The fabric held up through a whole
    // season of training." is specific, credible, durability proof — and contains no
    // flattery word, so a veto here would refuse it. The gap the audit actually found
    // is narrower than that: strings this function INVENTS (a curated snippet, a
    // clause-prefix, a truncation) were judged NOWHERE. Those are what get judged.
    // A TYPESET QUOTE MUST FINISH ITS THOUGHT. Owner, 2026-08-11: quotes were coming
    // out "cut off right after a word and a comma" — "I love this shirt, so great
    // with…". That was the last-resort truncation below reaching a frame: it is a
    // word-boundary cut with an ellipsis glued on, which reads as corrupted text rather
    // than as something a customer said. #135 encoded the same rule for the video
    // overlay ("never rely on an ellipsis to imply the rest"); static never applied it.
    //
    // Checked BEFORE the full-text exemption, because a stored quote can itself have
    // been captured mid-sentence — that is the Pelagic defect, and this is the last
    // place to catch it. NOT "must end in a period": a curated extract is a finished
    // thought without one, and requiring terminal punctuation deleted the whole snippet
    // path when I first tried it. See finishesThought.
    if (!finishesThought(text)) return false;
    if (text === full) return true;
    // NO JUDGE → allow only complete-sentence forms of that already-judged text.
    // Fails SAFE rather than closed: refusing every quote on every ad because a require
    // failed would be a worse outcome than trusting the two upstream gates.
    if (!judge) return text === whole;
    return judge(text);
  };

  const candidates = [
    full.length <= cap ? full : '',                            // the whole thing, best case
    (whole && whole.length >= snippet.length) ? whole : '',     // complete, and says at least as much
    snippet,                                                    // curated but unjudged — now judged
    whole                                                       // complete, even if shorter than the snippet
    // NO TRUNCATION CANDIDATE. shortenToCap's output ends in an ellipsis by
    // construction, so it can never finish a thought — it is retained below only for
    // callers that want a bounded string, and is deliberately not offered here. When
    // nothing complete fits, the ad prints NO quote and intent fallback takes over: a
    // missing testimonial costs one format, a mangled one costs the client.
  ];
  for (const c of candidates) if (usable(c)) return c;
  return '';
}

/**
 * The bar for a SHORTENED form of an already-approved quote: it must still read as
 * praise, and it must not argue against the purchase.
 *
 * DELIBERATELY NOT `pickStrongestQuote` — that is the intake/selection bar, and it
 * folds in a length/specificity score floor whose job is to rank candidates against
 * each other. Measured: applying it here rejected "absolutely love these, so
 * comfortable" purely for being short, which would empty the quote slot on most ads
 * whose full text exceeds the cap. Shortening cannot ADD merit, so the question here
 * is only whether the shortened string INTRODUCES a problem the parent did not have —
 * a lost subject ("feel like second skin"), a lost negation, a surviving limiter.
 *
 * Lazily required so this module carries no load-order coupling to layoutInputService;
 * the require cache makes per-call resolution free.
 */
function loadAdCopyJudge() {
  try {
    const { hasPositiveSignal, hasHardLimiter } = require('./layoutInputService');
    if (typeof hasPositiveSignal !== 'function' || typeof hasHardLimiter !== 'function') return null;
    return (text) => {
      // SUBSTANCE, not just sentiment. Sensory adjectives now open the positivity gate
      // (owner decision 2026-08-11), which is right for "the softest sweatpants I've
      // ever put on" and would be wrong for a bare "Soft." reaching a frame as the
      // testimonial. A curated snippet is deliberately short, so the floor is words,
      // not characters — four is enough for a clause that says something.
      const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
      if (words < 4) return false;
      return hasPositiveSignal(text) && !hasHardLimiter(text);
    };
  } catch (err) {
    console.warn(`   ⚠️  static quote: ad-copy judge unavailable (${err.message}) — restricting to whole-sentence forms`);
    return null;
  }
}

/**
 * Bounded, extractive shortening — unchanged behaviour, lifted out so the candidate
 * list above stays readable.
 *
 * truncateAtWordBoundary is reused (one shortening implementation, not two that can
 * drift), but its contract is NOT ours and the difference is load-bearing: for a single
 * unbroken token longer than the budget it returns the token WHOLE by design —
 * "oversized beats unreadable" — which is right for a 3s video overlay and wrong here,
 * where the cap is the whole point. Measured: a 400-char spaceless token came back 401
 * chars. Real prose always has spaces so this is a pathological input (a long URL, a
 * pasted blob), but "bounded" has to actually be bounded, so clamp after truncating.
 */
function shortenToCap(full, cap) {
  if (!full) return '';
  const { truncateAtWordBoundary } = require('./quoteSnippetService');
  const shortened = truncateAtWordBoundary(full, cap) || '';
  if (shortened && shortened.length <= cap) return shortened;
  return `${full.slice(0, Math.max(1, cap - 1)).trimEnd()}…`;
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
// requested intent). ai_editorial stays on the default intent — out of scope
// (it needs its own authored intent; separate work).
//
// ai_ugc_led -> objection_resolved, owner-approved 2026-08-24. The Director is
// explicitly instructed for creative_style='ugc_led' to write copy "in the
// reviewer's/creator's own register — first person, casual, unpolished. Not
// marketing voice" (aiCreativeDirectorService.js), but the ugc_led schema has
// no dedicated quote field for that — it lands in copy.headline like any
// other style's copy. Left on DEFAULT_INTENT (product_first_lifestyle), that
// headline prints unconditionally as BRAND LINE, a slot with NO provenance
// gate — unlike CUSTOMER QUOTE, which every d.quote on this path has already
// passed through toPrintableCustomerQuote / applyStrictQuoteScope /
// applyQuoteColourway (buildIntentData below). So a first-person "I tried
// this and love it" line was shipping as brand voice, unverified, 100% of the
// time for this template. objection_resolved's core IS CUSTOMER QUOTE
// (d.quote, never d.headline) and is eligible only when a REAL, gated
// customer quote exists, so ugc_led copy now either prints through that same
// gate or the intent is ineligible and the render falls back through
// FALLBACK_ORDER instead of printing untraced.
//
// Known residual, not closed by this one-line map: when a ugc_led render has
// NEITHER a gated quote NOR a rating, resolveIntent's chain
// ['objection_resolved', 'social_proof_led', 'product_first_lifestyle']
// bottoms out at product_first_lifestyle, which still prints d.headline as
// BRAND LINE ungated — same exposure as today, just narrowed to that one
// case instead of every ai_ugc_led render. Closing that residual needs
// buildIntentData to stop feeding the Director's ugc_led headline into
// `headline` at all (or a dedicated ugc_led intent, like ai_editorial) —
// out of scope here.
const TEMPLATE_INTENT = {
  ai_social_proof_led: 'social_proof_led',
  ai_promotional: 'objection_resolved',
  ai_ugc_led: 'objection_resolved',
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
/**
 * QUOTE ROTATION — the same testimonial on every SIZE, a different one on every RUN.
 *
 * Owner, 2026-08-11: *"I don't need diversity between sizes, but I do want more
 * diversity on generate… I want to make sure all the sizes are the same, however I want
 * to try to get more diversity on subsequent generations."*
 *
 * Before this, quote selection was intent-blind AND run-blind: pickStrongestQuote
 * returns THE top-scoring quote, the layout artifact is cached, and every ad built from
 * it read the same stored primary_quote. A brand with nine good quotes printed one of
 * them, for ever.
 *
 * `campaignRunId` is exactly the identity needed — it is constant across every size in
 * one generation and changes on the next — so the index is derived from it and nothing
 * else. No counter to persist, no extra query, no cache-key change: the pool already
 * rides in the artifact as `secondary_quotes`.
 *
 * TWO GUARDS, both load-bearing:
 *
 *  1. NEVER CROSSES A TIER. `secondary_quotes` is assembled from ALL tiers
 *     (layoutInputService: product + category + brand + comment), and the tier cascade
 *     is a strict precedence — on a product ad a brand-tier quote is the last resort, so
 *     rotating onto one would quietly demote the proof. Rotation is confined to the tier
 *     the primary already won.
 *  2. NEVER ROTATES DOWNHILL. Candidates must clear the PREFERRED quality floor on their
 *     own merits (clearsQualityFloor, not pickStrongestQuote — the latter now answers
 *     "is anything printable", which includes generic praise as a floor case). Variety
 *     is worth having; it is not worth printing a weaker quote to get it.
 *
 * Ordered by score before indexing, so index 0 is exactly today's behaviour and a
 * single-candidate pool is unchanged. The index is a hash, not a counter, which means
 * consecutive runs can land on the same quote with probability 1/N — with a 9-quote pool
 * that is ~11%. QUOTE_ROTATION_MEMORY (default false) closes that hole by skipping
 * last-N fingerprints on CatalogProduct.recentQuoteKeys; flag-off is the hash-only
 * path, byte-identical. Implementation lives in quoteRotationService — this file
 * keeps the wrappers so verifyQuoteSurfaceLength's source-region pins still resolve.
 */
function rotationEnabled() {
  return require('./quoteRotationService').staticRotationEnabled();
}

/** Stable non-negative 32-bit hash. Deterministic across processes — Math.random and
 *  Date are deliberately absent so the same run always resolves the same quote, which
 *  is what keeps the sizes in agreement. */
function rotationHash(key) {
  return require('./quoteRotationService').rotationHash(key);
}

function selectRotatedQuote(proof, campaignRunId, opts = {}) {
  const rot = require('./quoteRotationService');
  const enabled = opts.enabled != null ? !!opts.enabled : rotationEnabled();
  return rot.selectRotatedQuote(proof, campaignRunId, {
    enabled,
    recentKeys: opts.recentKeys,
    lastRunId: opts.lastRunId,
    lastFingerprint: opts.lastFingerprint,
    memoryEnabled: opts.memoryEnabled,
    memoryN: opts.memoryN,
    scope: opts.scope,
    stage: opts.stage,
    angleTerms: opts.angleTerms
  });
}

function buildIntentData({ concept, layoutInput, brand, product = null, cta, campaignRunId = null, media = null, funnelStage = null }) {
  // Dual-read v3 copy / v2 copy_picks. Never invent a headline from product name.
  const copy = renderableCopy(concept);
  let proof = layoutInput?.social_proof || {};
  // QUOTE_STAGE_AWARE: re-pick from the stored pool using this Ad's
  // stage. Flag-off / no stage is an identity, so rotation below still
  // runs as today. When a stage is live, stage wins — rotation among
  // same-tier quotes would undo the funnel pick.
  let stageLive = false;
  try {
    const { quoteStageAwareEnabled, applyStagedQuotePick, conceptAngleTerms, normalizeStage } = require('./layoutInputService');
    stageLive = quoteStageAwareEnabled() && !!normalizeStage(funnelStage);
    if (quoteStageAwareEnabled() && (funnelStage || concept)) {
      const staged = applyStagedQuotePick(
        { social_proof: proof },
        { funnelStage, conceptAngle: conceptAngleTerms(concept) }
      );
      if (staged?.social_proof) proof = staged.social_proof;
    }
  } catch { /* pick is an enhancement; keep stored primary */ }
  // ALLOWLIST via toPrintableCustomerQuote — returns a sanitized copy or null.
  // Using the return value (not a boolean + original object) is load-bearing:
  // llm-web quotes arrive with author/source fields that must never print, and
  // the gate strips them structurally so this path cannot re-surface a byline
  // by forgetting to clear author_name.
  // Rotate BEFORE the provenance gate so the gate still has the final word on
  // whatever rotation chose — a rotated quote is not exempt from anything the
  // primary faced. Shared helper (quoteRotationService); video uses the same
  // one. The call MUST stay named selectRotatedQuote: verifyQuoteSurfaceLength
  // R7 pins that token before toPrintableCustomerQuote in this function.
  // Scope is built BEFORE rotation so the shared helper can refuse a
  // line STRICT / toPrintable will later drop. Rotating first and
  // gating second is how flag-on lost a testimonial flag-off printed.
  const strictScope = {
    productAttached: !!(product && (product._id || product.title)),
    productTitle: product?.title || layoutInput?.product?.name || null,
    media,
    extraText: layoutInput?.product?.name || null
  };
  // QUOTE_STAGE_AWARE (#196) vs VIDEO_QUOTE_ROTATION (#195): a LIVE funnel
  // stage skips rotation outright — the stage pick IS the quote. Rotation
  // exists to stop siblings repeating one line; a stage-matched line is a
  // deliberate choice, not a repeat, so it must not be rotated away.
  const rotated = stageLive
    ? (proof.primary_quote || null)
    : selectRotatedQuote(proof, campaignRunId, {
      recentKeys: product?.recentQuoteKeys,
      lastRunId: product?.lastQuoteRunId,
      lastFingerprint: product?.lastQuoteFingerprint,
      scope: strictScope
    });
  // Memory persist is fire-and-forget: a missed write repeats a quote, it
  // does not fail a billed render. Flag-off is a no-op inside persistQuoteChoice.
  // Skip when lockedSameRun — this size is agreeing with a sibling that already wrote.
  //
  // SKIPPED ENTIRELY WHEN stageLive, and that is load-bearing: the block below
  // re-runs rotateQuote to obtain the fingerprint, but under a live stage that
  // rotation choice is NOT what we printed. Persisting it would record a quote
  // this render never used, so rotation memory would steer future runs away
  // from a line nobody has seen. Accepted consequence: staged renders do not
  // contribute to rotation memory (follow-up: persist the staged quote's own key).
  if (!stageLive && product && (product._id || product.id) && campaignRunId) {
    const rot = require('./quoteRotationService');
    if (rot.memoryEnabled()) {
      const rotation = rot.rotateQuote(proof, campaignRunId, {
        enabled: rotationEnabled(),
        recentKeys: product.recentQuoteKeys,
        lastRunId: product.lastQuoteRunId,
        lastFingerprint: product.lastQuoteFingerprint,
        scope: strictScope
      });
      if (rotation.poolSize >= 2 && rotation.fingerprint && !rotation.lockedSameRun) {
        rot.persistQuoteChoice(product._id || product.id, {
          fingerprint: rotation.fingerprint,
          campaignRunId,
          wrapped: rotation.wrapped
        });
      }
    }
  }
  let quote = toPrintableCustomerQuote(rotated);
  if (rotated && !quote) {
    console.log(
      `🔒 direct-image: quote withheld (tier=${rotated.tier || 'unstamped'} ` +
      `origin=${rotated.origin || 'unstamped'}) — rendering this ad with no testimonial`
    );
  }
  // QUOTE_PROVENANCE_STRICT — selection only, flag-off is identity.
  // Cached artifacts can still carry a brand-pool jacket quote over a
  // pants seed; drop it here and try the next same-tier printable.
  if (quote) {
    const scoped = applyStrictQuoteScope(quote, strictScope);
    if (!scoped) {
      const tier = quote.tier || null;
      const rest = [rotated, ...(Array.isArray(proof.secondary_quotes) ? proof.secondary_quotes : [])]
        .filter((q) => q && q !== rotated && String(q.text || '').trim())
        .filter((q) => (q.tier || null) === tier);
      let rescued = null;
      for (const cand of rest) {
        const printable = toPrintableCustomerQuote(cand);
        const next = applyStrictQuoteScope(printable, strictScope);
        if (next) { rescued = next; break; }
      }
      if (rescued) {
        console.log(
          `🔒 direct-image: brand-pool quote failed product-scope — using next allowed candidate`
        );
        quote = rescued;
      } else {
        console.log(
          `🔒 direct-image: quote withheld (QUOTE_PROVENANCE_STRICT ` +
          `tier=${tier || 'unstamped'}) — rendering this ad with no testimonial`
        );
        quote = null;
      }
    } else {
      quote = scoped;
    }
  }
  // Colourway — sibling of noun-scope, same rescue shape. A quote that
  // names a colour we cannot verify against this product's title is
  // dropped; a colour-free quote is a no-op. productAttached === false
  // is a no-op (brand / media ads) even when productTitle is set for
  // noun-scope; product-attached + unknown colourway fails closed.
  if (quote) {
    const colourOk = applyQuoteColourway(quote, strictScope);
    if (!colourOk) {
      const tier = quote.tier || null;
      const rest = [rotated, ...(Array.isArray(proof.secondary_quotes) ? proof.secondary_quotes : [])]
        .filter((q) => q && q !== rotated && String(q.text || '').trim())
        .filter((q) => (q.tier || null) === tier);
      let rescued = null;
      for (const cand of rest) {
        const printable = toPrintableCustomerQuote(cand);
        const scoped = applyStrictQuoteScope(printable, strictScope);
        const next = applyQuoteColourway(scoped, strictScope);
        if (next) { rescued = next; break; }
      }
      if (rescued) {
        console.log(
          `🔒 direct-image: quote failed colourway — using next allowed candidate`
        );
        quote = rescued;
      } else {
        console.log(
          `🔒 direct-image: quote withheld (colourway mismatch) — rendering this ad with no testimonial`
        );
        quote = null;
      }
    }
  }

  // QUOTE LENGTH IS PER-SURFACE (owner, 2026-08-10).
  //
  // `snippet` is a <=50-char extraction whose own service header states its
  // purpose outright: "suitable for a 3-second video overlay"
  // (quoteSnippetService, MAX_CHARS = 50, prompt asks for "4–8 words"). That
  // video-shaped cap was being applied to STATIC as well, and at 50 chars the
  // extractor drops the subject: "The quality is amazing and the pair I have
  // feel like second skin" became "feel like second skin" — a subjectless
  // fragment with a stranded plural verb. Owner flagged exactly that on a
  // delivered Vuori ad ("sounds idiomatically incorrect").
  //
  // A static feed ad has far more room than a 3s overlay, so prefer the FULL
  // sentence when it fits, and fall back to the snippet only when the full text
  // is genuinely too long to typeset. The original concern below is preserved,
  // not discarded: a 200-character quote at testimonial size IS unreadable at
  // feed scale, and STATIC_QUOTE_MAX_CHARS is what enforces that. What was
  // wrong for this surface was the 50, not the existence of a cap.
  //
  // Ordering note: when the full text overflows we keep `snippet || full`, which
  // is the pre-change precedence, so a long quote with no snippet still prints
  // rather than vanishing.
  // The selection itself lives in selectStaticQuoteText / resolveStaticQuoteCap
  // at module scope, EXPORTED so scripts/verifyQuoteSurfaceLength.js exercises
  // the shipped function instead of a copy of it. Two independent adversarial
  // passes flagged that seam: the harness's behavioural checks were running a
  // local mirror, so a mutation to the real expression could leave the suite
  // green. Same failure class as CLAUDE.md's "revert-prove behaviourally" note.
  const quoteText = selectStaticQuoteText(quote, {
    fullQuoteEnabled: String(process.env.STATIC_FULL_QUOTE ?? 'true').toLowerCase() !== 'false',
    cap: resolveStaticQuoteCap(process.env.STATIC_QUOTE_MAX_CHARS),
  });

  // Headline / subhead. Flag-off: exact pre-change expression (Director
  // headline only; subhead undefined). Flag-on: cascade through layoutInput
  // then brand.tagline so ai_brand_led still has a brand line when Director
  // nulls the headline. Do NOT cascade product name/title or description —
  // resolvedProduct is .select('title imageUrl imageMediaId additionalImageMediaIds rating productReviews recentQuoteKeys lastQuoteRunId lastQuoteFingerprint') so description is not loaded,
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
    // STATIC ONLY — owner directive 2026-08-07. Lets a comment/product-tier quote
    // keep printing AND still show scope-labelled brand stars ("4.6 ★ · 15000
    // brand reviews") instead of the quote hard-nulling the numbers and dropping
    // social_proof_led to objection_resolved (7 of 18 renders did exactly that).
    // Passed ONLY here: resolveCoherentSocialProof defaults it false, so the
    // video path through buildMetaForAd is unchanged by construction.
    // Kill switch, no deploy needed to revert.
    const STATIC_BRAND_STARS_WITH_QUOTE =
      String(process.env.STATIC_BRAND_STARS_WITH_QUOTE ?? 'true').toLowerCase() !== 'false';
    coherent = resolveCoherentSocialProof({
      quote: quote || null,
      product: productPair || unstampedFallback,
      brand: brandPair,
      brandAttribution: brandAttributionLabel(brand),
      renderedQuoteText: quoteText || null,
      allowLabeledBrandNumbers: STATIC_BRAND_STARS_WITH_QUOTE,
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
    // usableAttribution drops a bare initial so "D" cannot render as "— D".
    attribution: quoteText ? (usableAttribution(quote?.author_name) ?? undefined) : undefined,
    // The Director's line (or cascade when BRAND_LED_COPY). Not the product
    // name — that is dropped entirely by owner instruction and is separately
    // forbidden in the absence block.
    headline,
    subhead,
    badge: undefined,
    cta: normalizeCtaCasing(cta) || 'Shop now'
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
  // The box is square — see logoResizeBox. Wide wordmarks still bind on width.
  const layers = [];
  // The exact composited logo rectangle, in delivered pixels — set only when
  // a logo is actually placed. Returned below so the vision-QC call site can
  // hand the JUDGE this code-computed fact instead of asking it to estimate
  // the logo's position by eye (2026-08-24 false-positive fix — see
  // adVisionQcService.computeLogoGeometry).
  let composedLogoRect = null;
  const logo = await optionalImage(logoUrl);
  if (logo) {
    try {
      const boxWH = logoResizeBox(dims);
      const logoPng = await sharp(logo)
        .resize({ width: boxWH.width, height: boxWH.height, fit: 'inside', withoutEnlargement: true })
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
        // that corner, so it never ships as a white block (owner, 2026-08-03)
        // — UNLESS the mark's own artwork is genuinely polychrome (a colour
        // gradient, a multi-colour graphic), in which case forcing black-or-
        // white ink discards the brand's defining colour asset instead of
        // fixing a legibility problem. prepareLogoForComposite makes that
        // call; monochromeLogoBuffer (called from inside it) is unchanged for
        // every simple-wordmark brand. Any failure falls back to the original
        // asset — a correctly-placed logo with an ugly backing beats no logo
        // at all.
        let toPlace = logoPng;
        try {
          // ⚠️ [FOUND WHILE FIXING D1/D3, PRE-EXISTING BUG — likely affects
          // every brand's logo ink, not only Vuori's] NOT
          // `.extract(region).stats()` chained directly. MEASURED on sharp
          // 0.33.5: that pattern silently returns stats for the WHOLE
          // image, ignoring the extract (reproduced on a real logo PNG, not
          // just a synthetic fixture). So "the luminance behind the logo"
          // has actually always been "the mean luminance of the entire
          // rendered ad" — which happens to correlate with the true corner
          // luminance often enough to look plausible, but is not what this
          // code has ever claimed to measure. Read the region via a raw
          // decode instead, which cannot hit this pipeline-ordering gap.
          const rx = Math.max(0, Math.min(place.left, dims.width - 1));
          const ry = Math.max(0, Math.min(place.top, dims.height - 1));
          const rw = Math.max(1, Math.min(lm.width, dims.width - place.left));
          const rh = Math.max(1, Math.min(lm.height, dims.height - place.top));
          const { data: renderedGrey, info: renderedInfo } = await sharp(rendered)
            .greyscale().raw().toBuffer({ resolveWithObject: true });
          let regionSum = 0, regionCount = 0;
          for (let y = ry; y < ry + rh; y++) {
            for (let x = rx; x < rx + rw; x++) {
              regionSum += renderedGrey[(y * renderedInfo.width + x) * renderedInfo.channels];
              regionCount++;
            }
          }
          const behindLuminance = regionCount > 0 ? (regionSum / regionCount) / 255 : null;
          const prepared = await prepareLogoForComposite(logoPng, { behindLuminance });
          if (prepared && prepared.buffer) {
            toPlace = prepared.buffer;
            console.log(
              `   🖼️  direct-image: logomark ${prepared.treatment}` +
              `${typeof behindLuminance === 'number' ? ` (behind lum=${behindLuminance.toFixed(3)})` : ''}` +
              `${prepared.treatment === 'monochrome' ? ` (${prepared.ink?.r ? 'white' : 'black'})` : ''}`
            );
          }
        } catch (err) {
          console.warn(`   ⚠️  direct-image: logo colour/monochrome resolution skipped (${err.message}) — using original asset`);
        }
        layers.push({ input: toPlace, top: place.top, left: place.left });
        composedLogoRect = { top: place.top, left: place.left, width: place.width, height: place.height };
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
    logoComposited: layers.length > 0,
    // Null whenever no logo was composited (fetch failed, no room in the
    // content rect, or no logoUrl at all) — never fabricated.
    logoRect: composedLogoRect
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

/**
 * Pure: args for the vision-QC corrective re-entry into renderDirectImage.
 * Spreads the original call object so a future field (variantKind, seedStyle,
 * …) cannot be silently dropped the way BLOCKER 3 was. Exported for the
 * offline harness.
 */
function buildQcRetryArgs(originalCallArgs, { correctiveNote, overrideText } = {}) {
  const base = originalCallArgs && typeof originalCallArgs === 'object'
    ? { ...originalCallArgs }
    : {};
  return {
    ...base,
    // When the operator replaced the prompt, the corrective note has to
    // ride INSIDE the override or it is discarded and this paid retry is a
    // guaranteed repeat of the failure. See composeCorrectiveOverride.
    operatorPrompt: overrideText ? null : correctiveNote,
    rawPromptOverride: overrideText
      ? composeCorrectiveOverride(overrideText, correctiveNote)
      : base.rawPromptOverride,
    skipVisionQc: true
  };
}

/**
 * Submit the edit call; on a moderation-blocked rejection of the SINGLE
 * default catalog seed (never the operator/director's explicit multi-image
 * stack — that is an ordered pick the operator asked for, and silently
 * swapping one entry would be exactly the "silent quality downgrade" this
 * feature must not do), try the product's next unblocked catalog image
 * before giving up. See services/moderationSeedFallback.js's header for the
 * incident, the live-verified evidence, and the cost bound.
 *
 * Coordinates across a run's creatives via CampaignRun.seedFallbacks so
 * creative #2..N for the same product do not each pay to rediscover the same
 * doomed primary seed — best-effort only: a coordination read/write failure
 * just costs one more wasted primary attempt, i.e. exactly today's
 * behaviour, never a broken render.
 *
 * A NON-moderation failure (network, credentials, a genuine prediction
 * timeout, ...) is not seed-dependent and is rethrown immediately without
 * touching the fallback budget — a different image cannot fix those, and
 * trying more candidates would just spend money finding that out.
 *
 * @returns {Promise<{result: object, seedFallback: null|object}>}
 *   `seedFallback` is non-null only when a NON-primary seed produced the
 *   successful render — the shape callers persist onto
 *   Ad.imageGeneration.seedFallback so a fallback is always visible, never
 *   silent.
 */
async function submitEditImageWithSeedFallback({
  refs, imageMeta, prompt, genSize, meta, model, quality, timeoutMs,
  uploadTimeoutMs, allowProviderFallback, singleSeedEligible, mediaId,
  resolvedProduct, campaignRunId, productId
}) {
  const submit = (r, im) => atlasImage.editImage({
    model, images: r, imageMeta: im, prompt, size: genSize, quality, meta,
    timeoutMs, uploadTimeoutMs, allowFallback: allowProviderFallback
  });

  if (!singleSeedEligible || !moderationSeedFallback.isEnabled() || !resolvedProduct?._id) {
    return { result: await submit(refs, imageMeta), seedFallback: null };
  }

  const primaryMediaId = mediaId ? String(mediaId) : null;
  const { resolvedMediaId, blockedMediaIds } =
    await moderationSeedFallback.readRunSeedState(campaignRunId, productId);
  const knownBlocked = new Set(blockedMediaIds.map(String));

  // Ordered candidates for THIS call, bounded at 1 + maxFallbackCandidates()
  // TOTAL, matching moderationSeedFallback.js's documented cost bound.
  //
  // The starting slot is EXACTLY ONE id, not "resolved AND primary" — a
  // prior FIX here pushed both whenever neither was individually blocked,
  // which both defeated the coordination (the whole point of a resolved
  // override is to skip the doomed primary, not submit it anyway) and blew
  // the stated cap to 1(resolved)+1(primary)+cascade. Prefer a
  // previously-discovered good seed; only fall back to the primary itself
  // when there is no known-good override (or it turned out to also be
  // blocked, per the race note below).
  const candidateIds = [];
  if (resolvedMediaId && !knownBlocked.has(resolvedMediaId)) {
    candidateIds.push(resolvedMediaId);
  } else if (primaryMediaId && !knownBlocked.has(primaryMediaId)) {
    candidateIds.push(primaryMediaId);
  }
  const exclude = new Set([primaryMediaId, resolvedMediaId, ...knownBlocked, ...candidateIds].filter(Boolean));
  candidateIds.push(...moderationSeedFallback.nextCandidateIds(resolvedProduct, { excludeMediaIds: [...exclude] }));

  if (!candidateIds.length) {
    // Every catalog image this run knows about is already blocked for this
    // product — nothing left to try. Submit the primary anyway so the
    // failure (and its now-familiar IMAGE_MODERATION_BLOCKED code) surfaces
    // exactly as it would with the fallback disabled.
    return { result: await submit(refs, imageMeta), seedFallback: null };
  }

  let lastErr = null;
  for (let i = 0; i < candidateIds.length; i++) {
    const candidateId = candidateIds[i];
    const isPrimary = candidateId === primaryMediaId;
    let candidateRefs = refs;
    let candidateMeta = imageMeta;
    if (!isPrimary) {
      // eslint-disable-next-line no-await-in-loop
      const doc = await Media.findById(candidateId).select('fileUrl').lean();
      if (!doc?.fileUrl) { lastErr = lastErr || taggedError(`moderation fallback candidate ${candidateId} has no usable file — skipped`, { alertLevel: 'warn', alertKey: 'direct-image:fallback-candidate-unusable' }); continue; } // unusable candidate — try the next one for free
      // eslint-disable-next-line no-await-in-loop
      const raw = await optionalImage(doc.fileUrl);
      // eslint-disable-next-line no-await-in-loop
      const normalized = raw ? await normalizeReference(raw) : null;
      if (!normalized) { lastErr = lastErr || taggedError(`moderation fallback candidate ${candidateId} could not be normalised — skipped`, { alertLevel: 'warn', alertKey: 'direct-image:fallback-candidate-unusable' }); continue; }
      candidateRefs = [normalized];
      candidateMeta = [{ sourceUrl: doc.fileUrl, role: 'moderation-fallback-seed' }];
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await submit(candidateRefs, candidateMeta);
      if (!isPrimary) {
        // Fire-and-forget: this is the optimisation, not the correctness —
        // the render already succeeded regardless of whether this write does.
        moderationSeedFallback.recordSeedOutcome(campaignRunId, productId, {
          originalMediaId: primaryMediaId, resolvedMediaId: candidateId
        }).catch(() => {});
      }
      return {
        result,
        seedFallback: isPrimary ? null : {
          used: true,
          originalMediaId: primaryMediaId,
          resolvedMediaId: candidateId,
          reason: 'moderation_blocked',
          attemptsBeforeSuccess: i + 1
        }
      };
    } catch (err) {
      lastErr = err;
      const isModeration = err?.policy?.name === 'moderationBlocked';
      if (!isModeration) throw err; // not a seed-shaped problem — do not burn more submits
      // Record a blocked PRIMARY too, not only blocked fallback candidates —
      // a prior version guarded this on `!isPrimary`, which meant the exact
      // seed the incident was about never entered `blocked[]`. Every other
      // creative for this product then re-submitted (and re-paid to
      // discover) the same doomed primary before reaching an alternate.
      moderationSeedFallback.recordSeedOutcome(campaignRunId, productId, {
        originalMediaId: primaryMediaId, blockedMediaId: candidateId
      }).catch(() => {});
      // fall through to the next candidate, if any
    }
  }
  // Every candidate was tried (or skipped as unusable) with nothing to show
  // for it. `lastErr` is only unset if `candidateIds` was non-empty but every
  // single one was skipped as unusable above — extremely unlikely (it would
  // need a deleted Media doc for every remaining catalog image) but a bare
  // `throw null`/`throw undefined` would be far worse than a real Error.
  throw lastErr || taggedError(
    'moderation fallback exhausted every candidate without a usable reference',
    { alertLevel: 'error', alertKey: 'direct-image:fallback-exhausted' }
  );
}

async function renderDirectImage(callArgs = {}) {
  // Accept a single object so QC re-entry can spread the original args
  // (buildQcRetryArgs) and never re-list fields by hand.
  const {
    layoutInputArtifactId, aspectRatio, mediaId, productId, brandId,
    adId = null,
    // Campaign run + campaign ids for run-feed QC notices and app deep links.
    // Prefer a real parameter from renderService over reading Ad.campaignRunIds.
    campaignRunId = null,
    campaignId = null,
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
    // Lifestyle/UGC scene-preserve gate (STATIC_LIFESTYLE_PRESERVE). Threaded
    // from Ad.variantKind; seed style is resolved from the media doc below.
    variantKind = null,
    // Regenerate hooks (adRegenerateService.runImage). Neither is charged until
    // the single editImage submit below — they only rewrite the prompt string.
    //   operatorPrompt     — refinement note appended to the auto-built prompt
    //   rawPromptOverride  — verbatim replacement ({system,user} or string)
    operatorPrompt = null,
    rawPromptOverride = null,
    // Post-render vision QC re-entry guard. The single allowed regeneration
    // calls renderDirectImage again with skipVisionQc:true so the QC loop
    // cannot nest (money: would otherwise allow unbounded regenerations).
    skipVisionQc = false,
    // QUOTE_STAGE_AWARE: Ad.funnelStage from renderCreative. Flag-off
    // buildIntentData ignores it.
    funnelStage = null
  } = callArgs;
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
    productId ? CatalogProduct.findById(productId).select('title imageUrl imageMediaId additionalImageMediaIds rating productReviews recentQuoteKeys lastQuoteRunId lastQuoteFingerprint').lean() : null,
    // classification + technicalInsights feed resolveSeedStyle for the
    // lifestyle scene-preserve branch (STATIC_LIFESTYLE_PRESERVE).
    // width + height feed seedAspectFromDims → resolveAspectTreatment's
    // 'native' arm (without them every preserve submit falls to 'extend').
    mediaId ? Media.findById(mediaId).select('fileUrl classification technicalInsights width height subjects refinedProducts primarySubjectLabel primarySubjectDesc').lean() : null
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
  const resolvedProduct = product || (effectiveLayout.productId ? await CatalogProduct.findById(effectiveLayout.productId).select('title imageUrl imageMediaId additionalImageMediaIds rating productReviews recentQuoteKeys lastQuoteRunId lastQuoteFingerprint').lean() : null);
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
    cta: effectiveLayout.input?.cta?.text,
    // Same quote on every size of this run, a different one next run.
    campaignRunId,
    media,
    funnelStage
  });
  // Lifestyle/UGC scene preserve — intent still owns copy; only the scene
  // fidelity opening swaps when the flag is on (staticAdIntents).
  const { resolveSeedStyle } = require('./imageShotHeuristicService');
  const seedStyle = resolveSeedStyle(media);
  // Seed aspect from Media.width/height — the ONLY production path into
  // resolveAspectTreatment's 'native' arm. Missing/zero dims → null →
  // 'extend' (today's behaviour). First render, regen, and QC re-entry all
  // funnel through this single buildPrompt call, so one thread covers all
  // three (same cause-fix class as variantKind: never hand-list fields
  // per caller when one chokepoint can compute them).
  const seedAspect = intents.seedAspectFromDims(media?.width, media?.height);
  const built = intents.buildPrompt({
    intentKey,
    data: intentData,
    product: {
      desc: describeProductForPrompt({ concept, product: resolvedProduct, layoutInput: effectiveLayout.input || {} }),
      look: conceptLook(concept),
      logoCorner: 'bottom-right',
      // Category threaded through so staticAdIntents.buildPrompt can
      // detect apparel and adjust the role preamble (see the
      // APPAREL EXTENSION comment there). Reads from the resolvedProduct
      // FIRST (CatalogProduct.category — the merchant feed's own
      // category string), falls back to layoutInput. Optional field on
      // the prompt-input contract; absent = non-apparel = no-op.
      category:  resolvedProduct?.category
                 || effectiveLayout?.input?.product?.category
                 || null
    },
    surface,
    seedStyle,
    variantKind,
    seedAspect
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
    // D1 CONTRAST FIX — append a MEASURED ink directive, never asserted
    // without a real sample. See textInkDirective's header: static
    // headlines otherwise carry no contrast guidance at all, and the same
    // headline over the same brand's seed photo family measurably rendered
    // legible on some format siblings and illegible (white-on-pale-grey)
    // on others in one run. Sampled from refs[0] — the primary reference
    // photo, the only pixels that exist pre-submission — inside this
    // surface's own safe box, not a whole-frame average (see
    // sampleSafeBoxLuminance's header for why a whole-frame mean is the
    // wrong measurement for a light-garment-on-mid-tone-wall seed).
    // Skipped silently (no directive appended) when no reference is
    // available to sample or the sample cannot be read — never asserts an
    // unmeasured claim; the prompt then falls back to buildPrompt's
    // pre-existing "you decide" wording exactly as before this fix.
    try {
      const backdropLum = await sampleSafeBoxLuminance(refs[0], built.surface?.box);
      const inkDirective = textInkDirective(backdropLum);
      if (inkDirective) prompt = `${prompt}\n\n${inkDirective}`;
    } catch { /* measurement is a best-effort addition, never a submit blocker */ }
    // TYPEFACE FIX — headline typeface determinism (font-role selection was
    // format-dependent: same brand/run/headline rendered serif on some
    // surfaces and sans on others, with no shared state between the six
    // independent per-surface submits to keep them agreeing). See
    // typefaceDirectiveForBrand's header. Brand-level, so it does not need
    // (and must not use) any per-surface or per-concept input — computed
    // fresh on every call from the same brand doc, so it is identical every
    // time without needing to persist or share state across the six calls.
    {
      const typefaceLine = typefaceDirectiveForBrand(resolvedBrand);
      if (typefaceLine) prompt = `${prompt}\n\n${typefaceLine}`;
    }
    // D4 FIX — CTA determinism, casing + fill colour. Only when this
    // surface/intent actually draws a CTA (built.text carries the role) —
    // appending a "render the CTA fill as X" instruction on a surface that
    // was just told to draw NO CTA at all (Stories, most PMax surfaces —
    // see resolveDrawCta in staticAdIntents.js) would contradict that
    // absence instruction instead of reinforcing it.
    {
      const ctaHit = built.text.find(([role]) => role === 'CTA BUTTON');
      if (ctaHit) {
        const ctaCasing = ctaCasingDirective(ctaHit[1]);
        if (ctaCasing) prompt = `${prompt}\n\n${ctaCasing}`;
        const ctaColors = deriveCtaColors(resolvedBrand);
        const ctaColor = ctaColorDirective(ctaColors);
        if (ctaColor) prompt = `${prompt}\n\n${ctaColor}`;
      }
    }
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
    // campaignId/campaignRunId were both already parameters of this function
    // (renderDirectImage) — threaded for run-feed notices and app deep links —
    // but never made it into the CostLog meta, so every static-image CostLog
    // row was attributable to a brand/product/ad but not to the run that
    // caused the spend. Fixed 2026-08-19 alongside the video path.
    campaignId: campaignId || null,
    campaignRunId: campaignRunId || null,
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
  // Eligible for seed fallback whenever there is AT MOST ONE reference in
  // play — never a genuine multi-image stack (orderedIds.length >= 2), which
  // is a deliberate, ordered pick (operator or Director) whose composition
  // this feature must not silently rewrite.
  //
  // BUG FIXED 2026-08-19 (caught in adversarial review, confirmed against the
  // real incident data): this used to be `!orderedIds.length`, which is only
  // true when `referenceMediaIds` arrives EMPTY. But renderService.js's own
  // fallback (`referenceMediaIds: adDoc.referenceMediaIds.length ? ... :
  // adDoc.mediaIds`) means the concept-driven static path — the exact path
  // the incident happened on — ALWAYS forwards `Ad.mediaIds`, and
  // DIRECTOR_UNIVERSE_TOP_N=1 makes that array exactly ONE element long, not
  // zero. Verified live against run_1787136860887_654ed621's own Ad
  // documents: `mediaIds.length === 1`, `referenceMediaIds.length === 0` on
  // the Ad, which renderService.js turns into a 1-element `orderedIds` here.
  // Under the old `!orderedIds.length` check that is `false` — the fallback
  // never engaged on the ONE path it was built for. `<= 1` treats "the
  // Director's single pick, surfaced through this plumbing" the same as
  // "no explicit pick at all" (both fall back to the SAME single seed
  // either way), while still excluding any real 2+ stack.
  const singleSeedEligible = moderationSeedFallback.isSingleSeedEligible(orderedIds);
  const { result, seedFallback: seedFallbackInfo } = await submitEditImageWithSeedFallback({
    refs, imageMeta, prompt, genSize, meta,
    model: PLATE_EDIT_MODEL, quality: PLATE_QUALITY, timeoutMs: PLATE_TIMEOUT_MS,
    uploadTimeoutMs: UPLOAD_TIMEOUT_MS, allowProviderFallback,
    singleSeedEligible, mediaId, resolvedProduct, campaignRunId, productId
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
    // The exact composited logo rect (or null) — carried through so
    // adVisionQcService can hand the vision judge a code-verified fact for
    // layout_safe_box instead of asking it to estimate the logo's position.
    logoRect: plate.logoRect || null,
    // Verbatim audit of the image-model request, built at submit time inside
    // atlasImageService. Persisted onto the Ad so the inspector never has to
    // re-derive what "should" have been sent.
    imageGeneration: result?.submission
      ? {
          ...result.submission, pipeline: DIRECT_IMAGE, stage: 'finished_ad',
          // Visible, never silent, per requirement: a fallback away from the
          // product's chosen seed is a real quality decision (a different
          // catalog photo shipped), not an implementation detail — present
          // only when submitEditImageWithSeedFallback actually swapped seeds.
          ...(seedFallbackInfo ? { seedFallback: seedFallbackInfo } : {})
        }
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
    // TRUTHFUL COPY SNAPSHOT — what this specific render actually asked the
    // model to typeset, read back from built.text (the post-density-budget
    // [role, string] list), never from the pre-render LayoutInputArtifact /
    // Director marketing copy. Those are DIFFERENT stages of the pipeline —
    // see persistStage/extractCopySnapshot in renderService.js, which used to
    // snapshot only the earlier stage. Measured live: a Vuori tee ad stored
    // copy.headline "Lived-in comfort from day one." while the delivered PNG
    // showed "220 GSM organic cotton." (a copyDerivationService candidate
    // resolved onto the concept AFTER the LayoutInputArtifact was cached).
    // Role names come from the intent's own text() builders — 'BRAND LINE'
    // is product_first_lifestyle's (and therefore ai_editorial's, its
    // default intent) headline-shaped slot; other intents (social_proof_led,
    // objection_resolved) carry no headline role at all, so headline is
    // correctly null there rather than a fabricated line. Quote marks the
    // prompt wraps CUSTOMER QUOTE in are stripped so the snapshot matches the
    // rendered words, not the prompt's punctuation. A role absent from
    // built.text (sacrificed by the density budget, or never drawn — e.g.
    // CTA on Stories/PMax surfaces that suppress it) snapshots as null:
    // absent-in-the-pixels must not become a phantom string in the list view.
    renderedCopy: {
      headline: renderedTextForRole(built.text, 'BRAND LINE'),
      cta_text: renderedTextForRole(built.text, 'CTA BUTTON'),
      quote: (() => {
        const q = renderedTextForRole(built.text, 'CUSTOMER QUOTE');
        return q ? q.replace(/^"|"$/g, '') : null;
      })()
    },
    visionQc: null
  };

  // ── Post-render vision QC ──────────────────────────────────────────
  // skipVisionQc: re-entry from the single allowed regeneration must not
  // nest another QC loop (that would break the one-retry money bound).
  if (skipVisionQc) return firstOutput;

  const adVisionQc = require('./adVisionQcService');
  // AWAIT the real gate — do NOT use the synchronous isEnabled() peek here.
  // isEnabled() answers from a 5s-TTL cache and fires only a fire-and-forget
  // refresh on a miss/expiry, so a call landing just after the TTL elapses
  // (which is the NORMAL case — real renders are spaced far more than 5s
  // apart) reads the cache as empty and falls through to the env default,
  // even though SystemConfig.adVisionQcEnabled is genuinely true. This
  // function is already async and already awaits runPostRenderQc below, so
  // there is no reason to take the racy sync path — resolveStaticEnabled()
  // does a real (TTL-cached, but AWAITED) SystemConfig read and can never
  // observe "cache miss" as "off". See services/adVisionQcService.js
  // resolveStaticEnabled vs isEnabled doc comments for the full precedence
  // + fail-safe writeup. This is the STATIC pipeline — resolveStaticEnabled()
  // reads SystemConfig.staticVisionQcEnabled (2026-08-21 split; was the
  // single resolveEnabled() gate before then).
  const qcEnabledNow = await adVisionQc.resolveStaticEnabled();
  if (!qcEnabledNow) {
    // Real gate, not a swallowed error — but until this stamp, a flag-off
    // ad shipped with Ad.visionQc left at its schema default `null`, reading
    // identically to "inspected and passed" everywhere (summarizeVisionQc,
    // GET /runs/:runId shippedWithoutQc, imageRecoveryService's qcFailed
    // guard, which already special-cases `.disabled` but this branch never
    // gave it the chance to). Build the SAME shape runPostRenderQc's own
    // "Flag off" branch below constructs — cheap, no network/DB — so
    // "never inspected" is a real, queryable fact instead of an absence.
    adVisionQc.warnQcDisabledOnce('static ad');
    return {
      ...firstOutput,
      visionQc: adVisionQc.buildPersistedVerdict({
        passed: false, skipped: true, disabled: true,
        reason: 'AD_VISION_QC_ENABLED=false', finalAttempt: null, attempts: []
      })
    };
  }

  const qcBrandId = resolvedBrand?._id || brandId || null;
  const qcProductId = resolvedProduct?._id || productId || null;
  const qcBrandName = resolvedBrand?.name || null;
  const appUrl = adVisionQc.buildAppPreviewUrl({
    campaignRunId,
    campaignId,
    brandId: qcBrandId
  });

  // ORIGINAL product photo — the first reference we actually sent. A check
  // that only sees the render cannot tell an invented Timberland emblem from
  // a real brand mark (owner requirement: both images in one vision call).
  const originalProductUrl = imageMeta[0]?.sourceUrl || null;
  if (!originalProductUrl) {
    // SHIPS WITHOUT QC — but never silently. With the flag ON, an operator is
    // entitled to assume every delivered static ad was inspected; a bare
    // console.warn on a worker nobody is tailing does not earn that assumption
    // (same reasoning as the generation-size renderIssue above). So: stamp the
    // ad, raise it, and make the gap visible in the inspector.
    //
    // Deliberately NOT a hard failure: the render is already PAID FOR, and
    // throwing here would discard billed pixels over a missing reference URL —
    // strictly worse than shipping an uninspected ad and saying so loudly.
    const reason = 'no original product URL on the reference stack';
    const msg = 'vision QC enabled but no original product URL — shipped WITHOUT QC';
    console.warn(`   ⚠️  direct-image: ${msg}`);
    noteRenderIssue(adId, { message: msg, stage: 'vision-qc' });
    adVisionQc.alertQcSkipped({
      adId,
      brandId: qcBrandId,
      productId: qcProductId,
      brandName: qcBrandName,
      reason
    });
    return {
      ...firstOutput,
      // Truthful stamp: QC did not run. Anything reading Ad.visionQc can now
      // distinguish "inspected and passed" from "never inspected", which a
      // bare absent field could not.
      visionQc: adVisionQc.buildSkippedVerdict('no original product URL')
    };
  }

  const safeBox = safeBoxInDeliveredPx(built.surface, dims);
  const expectedText = built.text.map(([, str]) => str);

  adStage(adId, `vision QC (${surface})`);
  const qcResult = await adVisionQc.runPostRenderQc({
    enabled: true,
    originalProductUrl,
    brandName: qcBrandName,
    safeBox,
    deliveryDims: dims,
    expectedText,
    brandId: qcBrandId,
    productId: qcProductId,
    adId: adId || null,
    campaignRunId: campaignRunId || null,
    // MONEY: generate() attempt 1 returns the already-paid firstOutput.
    // attempt 2 (at most once) re-enters renderDirectImage with a corrective
    // operatorPrompt and skipVisionQc:true — one more billable editImage.
    generate: async ({ attempt, correctiveNote }) => {
      if (attempt === 1) return firstOutput;
      adStage(adId, `vision QC regen (${surface})`);
      // Spread original callArgs via buildQcRetryArgs so variantKind / any
      // future field cannot be silently dropped on this paid re-submit.
      return renderDirectImage(buildQcRetryArgs(callArgs, {
        correctiveNote,
        overrideText
      }));
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

  // Vision infrastructure failure (judge threw) or similar: ship paid plate
  // with a skipped stamp. Caller alerts — do NOT treat as image-QC failure.
  if (qcResult.skipped || qcResult.uninspected) {
    const reason = qcResult.visionQc?.reason || 'vision QC did not inspect this render';
    console.warn(`   ⚠️  direct-image: vision QC skipped — ${reason}`);
    noteRenderIssue(adId, { message: `vision QC skipped: ${reason}`, stage: 'vision-qc' });
    adVisionQc.alertQcSkipped({
      adId,
      brandId: qcBrandId,
      productId: qcProductId,
      brandName: qcBrandName,
      reason
    });
    return {
      ...qcResult.output,
      visionQc: qcResult.visionQc
    };
  }

  if (!qcResult.ok) {
    // Fail path: low-volume actionable alert channel AND run-feed thread line.
    // alertQcFailure returns the EXACT text it just sent to Slack — stamp it
    // onto the SAME qcResult.visionQc object that ends up on Ad.visionQc
    // (via err.visionQc below → renderService.js → routes/ads.js), so the
    // detail screen and Slack are provably reading one string, not two
    // independent derivations. See alertQcFailure's docstring.
    const failureDetail = adVisionQc.alertQcFailure({
      adId,
      brandId: qcBrandId,
      productId: qcProductId,
      brandName: qcBrandName,
      visionQc: qcResult.visionQc,
      appUrl
    });
    if (failureDetail) qcResult.visionQc.failureDetail = failureDetail;
    adVisionQc.noteQcFailToRunFeed({
      campaignRunId,
      adId,
      template,
      aspectRatio,
      platformFormat: surface,
      visionQc: qcResult.visionQc,
      previewUrl: (qcResult.visionQc?.attempts || []).slice(-1)[0]?.renderUrl || null,
      appUrl
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
  // PASS path → run feed only (NOT alertService). At real scale, per-ad
  // accept alerts would exhaust the process-global rate limiter and silently
  // drop genuine error/fatal alerts. Silence is correct when runFeed is
  // unconfigured or there is no runId — never fall back to the alert channel.
  // alertQcAccepted remains exported for harness / manual use.
  adVisionQc.noteQcPassToRunFeed({
    campaignRunId,
    adId,
    template,
    aspectRatio,
    platformFormat: surface,
    visionQc: qcResult.visionQc,
    previewUrl: (qcResult.visionQc?.attempts || []).slice(-1)[0]?.renderUrl
      || qcResult.output?.renderUrl
      || null,
    appUrl
  });
  return {
    ...qcResult.output,
    visionQc: qcResult.visionQc
  };
}

module.exports = {
  selectRotatedQuote,
  rotationHash,
  // Exported for the offline harness. renderDirectImage is the only entry point
  // the render path uses.
  // finishPlate is the exception: the recovery path is a SECOND legitimate caller
  // (see its header) — it finishes an already-paid Atlas output into a real ad.
  finishPlate,
  // Exported so scripts/verifyQuoteSurfaceLength.js executes the SHIPPED quote
  // selection instead of a local copy — two adversarial passes flagged that the
  // harness's behavioural checks were running a mirror, which is a check that
  // cannot fail for the mutation it was written to catch.
  selectStaticQuoteText,
  resolveStaticQuoteCap,
  deliveryGeometryFor,
  safeBoxInDeliveredPx,
  extractFor,
  logoPlacementFor,
  logoResizeBox,
  logoInsetPx,
  LOGO_BOX_FRAC,
  LOGO_INSET_FRAC,
  LOGO_INSET_PX_FLOOR,
  LOGO_CHROMA_THRESHOLD,
  LOGO_MIN_INK_CONTRAST,
  LOGO_SAFE_MARGIN_PCT,
  logoPixelLuminance,
  inkContrastRatio,
  contrastingInkFor,
  sampleSafeBoxLuminance,
  textInkDirective,
  ctaCasingDirective,
  normalizeCtaCasing,
  GENERIC_CTA_CASING,
  deriveCtaColors,
  ctaColorDirective,
  typefaceDirectiveForBrand,
  humanizeFontFamily,
  FONT_SERIF_HINTS,
  monochromeInkFor,
  monochromeLogoBuffer,
  alphaChannelDiscriminates,
  estimateOpaqueLogoBackground,
  coverageFromBackgroundDistance,
  logoIsPolychrome,
  prepareLogoForComposite,
  renderedTextForRole,
  intentForTemplate,
  buildIntentData,
  describeProductForPrompt,
  conceptLook,
  normalizeReference,
  resolveImagePromptOverride,
  // MONEY: pinned by scripts/verifyRegeneration.js (R5) — without it the one
  // allowed vision-QC retry re-submits an identical prompt for a second charge.
  composeCorrectiveOverride,
  // QC re-entry arg assembly — verifyLifestylePreserve asserts variantKind
  // survives the spread (BLOCKER 3).
  buildQcRetryArgs,
  renderDirectImage,
  // MODERATION SEED FALLBACK (2026-08-19) — exported for behavioural pinning
  // by scripts/verifyModerationSeedFallback.js. A source-text check alone
  // would pass against a reimplementation that kept the name, so the harness
  // calls this real function (with axios stubbed, per the repo's established
  // require.cache pattern — see scripts/verifyDirectorFallbackChain.js).
  submitEditImageWithSeedFallback
};
