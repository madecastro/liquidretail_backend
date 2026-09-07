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

const { noteRenderIssue } = require('./adStage');

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

// Fetch a reference/logo image as a raw buffer — used by finishPlate's
// optional logo composite. No sharp normalization here (unlike the deleted
// normalizeReference, which prepped model-bound references) — finishPlate
// hands the buffer straight to sharp itself, which reads whatever format
// Cloudinary/Shopify actually served.
async function fetchBuffer(url) {
  const response = await axios.get(url, { responseType: 'arraybuffer', timeout: REFERENCE_TIMEOUT_MS });
  return Buffer.from(response.data);
}

async function optionalImage(url) {
  if (!url) return null;
  try { return await fetchBuffer(url); } catch (err) { console.warn(`   ⚠️  direct-image: reference fetch failed (${err.message})`); return null; }
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
 * ⚠️ ONE IMPLEMENTATION. This used to have a second caller — the mint-time
 * render path's own renderDirectImage — before that path was deleted (the
 * dormant in-process render/titling fallback removal; adgen owns rendering
 * unconditionally now). services/imageRecoveryService.js is the only caller
 * left. Do NOT copy this function's logic elsewhere: the failure mode is
 * silent — a mis-cropped ad still looks plausible while cutting through
 * typeset copy, which is exactly the failure the genSize mismatch warning
 * below exists to catch.
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

module.exports = {
  // finishPlate: the recovery path is a SECOND legitimate caller (see its
  // header) — it finishes an already-paid Atlas output into a real ad.
  // renderDirectImage, the mint-time render path's own entry point, is
  // deleted (dormant in-process render/titling fallback removal — see
  // session.d/); finishPlate is the only entry point left in this file.
  finishPlate,
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
  monochromeInkFor,
  monochromeLogoBuffer,
  alphaChannelDiscriminates,
  estimateOpaqueLogoBackground,
  coverageFromBackgroundDistance,
  logoIsPolychrome,
  prepareLogoForComposite
};
