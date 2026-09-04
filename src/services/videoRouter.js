// Video provider router — chooses between Vertex AI Veo (direct) and
// Atlas Cloud (Gemini Omni by default; Grok/Veo via overrides) based
// on VIDEO_PROVIDER.
//
// Callers import this instead of importing aiVideoReferenceService
// directly. The returned shape is uniform across providers:
//
//   { videoUrl, cloudinaryPublicId, operationName, aspectRatio, track,
//     prompt, storyboard, elapsedMs, model, costUsd? }
//
// Every provider emits a motion-only video. Text overlays are
// composited downstream by the canonical brand-script overlay
// (brandScriptExecutor) reading ad.copy + LayoutInputArtifact +
// Brand.styleTheme.
//
// Provider selection is env-driven; WITHIN the atlas provider, the
// model is additionally resolvable per brand / per product / per canvas
// (atlasVideoService.resolveVideoModel via Brand.videoSettings /
// CatalogProduct.videoSettings). A per-brand PROVIDER override
// (videoSettings.provider, vertex-vs-atlas) is the natural future
// extension of that same settings block.
//   VIDEO_PROVIDER=atlas   → atlasVideoService (default — Atlas migration)
//   VIDEO_PROVIDER=gemini  → geminiVideoService (direct Gemini Developer API)
//   VIDEO_PROVIDER=vertex  → aiVideoReferenceService (deprecated direct-Veo; now
//                            reachable ONLY by naming it, never as a fall-through)
//   anything else          → THROWS. See the else arm in generateForAd.
//
// ⚠️ VIDEO_PROVIDER=gemini IS NOT YET SWITCHABLE IN PRODUCTION. geminiVideoService
// has no reference-image assembly: it takes `images` as a parameter, and both
// callers pass storyboard?.images, which is ALWAYS [] on the gemini path because
// prepareStoryboard returns {storyboard:null} for every non-atlas provider. So a
// flip today submits ZERO references — text-to-video, not reference-to-video —
// and bills ~$1 per useless master. The missing piece is the loading that
// atlasVideoService.generateForAd does before buildReferenceImages (media,
// product, catalogMedias, caps, brand); that wants extracting into something
// both providers call, not duplicating.

const aiVideoReferenceService = require('./aiVideoReferenceService');
const atlasVideoService       = require('./atlasVideoService');
const geminiVideoService      = require('./geminiVideoService');

function activeProvider() {
  return String(process.env.VIDEO_PROVIDER || 'atlas').toLowerCase();
}

// Pre-flight context hook. On Atlas this resolves the per-ad model +
// aspect and warms the layoutInput cache; the returned storyboard is
// always null there (the GPT storyboard stage is retired — the Ken
// Burns prompt fully directs motion). Only the Atlas provider exposes
// this hook; on Vertex the caller should pass null and accept
// sequential execution.
//
// NON-ATLAS BRANCH — the direct-Gemini path (VIDEO_PROVIDER=gemini) and
// any future non-Atlas provider still needs layoutInput warming. Before
// this branch called warmLayoutInputForVideoAd, the non-Atlas short-
// circuit skipped Atlas's prepareStoryboard entirely — and with it,
// refreshStaleLayoutInput → buildLayoutInput → LayoutInputArtifact
// creation. Diagnosed 2026-09-04: every video ad since the direct-Gemini
// cutover shipped with the titler's "no layoutInput ... — degrading to
// ad.copy" fallback, silently throwing away the funnel-stage-aware quote
// pick, provenance-stamped primary_quote, palette-bound style resolution,
// and copy cascade the titler was designed to consume. Model + aspect
// resolution stays skipped here — that's Atlas-consumer-only.
async function prepareStoryboard({ ad, operatorPrompt = null, modelOverride = null }) {
  if (activeProvider() !== 'atlas') {
    // warmLayoutInputForVideoAd is fail-safe (logs + returns null on any
    // load / derivation error). We do NOT await-then-throw — a bad warm
    // still lets the render proceed with the ad.copy fallback the titler
    // already handles gracefully.
    await atlasVideoService.warmLayoutInputForVideoAd({ ad });
    return { storyboard: null };
  }
  return atlasVideoService.prepareStoryboard({ ad, operatorPrompt, modelOverride });
}

// storyboard (optional) — when supplied by the orchestrator (parallel
// execution path), it's passed through so the provider uses it instead
// of generating a new one. Lets chrome and the video model share the
// same script.
// modelOverride (optional) — per-run model slug from the operator's
// regenerate dropdown; Atlas provider only (Vertex has a single model).
async function generateForAd({
  ad, operatorPrompt = null, storyboard = null, modelOverride = null, campaignRunId = null,
  // Threaded through to atlasVideoService.generateForAd — see that
  // function's shouldResumeAttempt doc comment. Default true matches the
  // normal render path; adRegenerateService passes false explicitly.
  allowResume = true
}) {
  const provider = activeProvider();
  const t0 = Date.now();

  let result;
  if (provider === 'atlas') {
    result = await atlasVideoService.generateForAd({ ad, operatorPrompt, storyboard, modelOverride, campaignRunId, allowResume });
  } else if (provider === 'gemini') {
    // ── ADDED 2026-09-03 WITH THE DIRECT-GEMINI CUTOVER ──────────────────
    //
    // THIS BRANCH IS WHY THE CUTOVER COULD NOT JUST BE AN ENV FLIP.
    //
    // renderer.js dispatches providers at its own seam and never calls this
    // function — but REGENERATE does: adRegenerateService.js:43 requires this
    // module aliased as `veoService` and calls veoService.generateForAd at
    // :1636. That alias is why a grep for "videoRouter.generateForAd" finds
    // nothing and the call site looks absent.
    //
    // So before this branch existed, VIDEO_PROVIDER=gemini sent every
    // regenerate into the `else` below — the deprecated Vertex Veo path,
    // whose prompt composer interpolates the catalog TITLE. That is the exact
    // mechanism behind the Vaportek incident (a product named "Vaportek" made
    // Omni fabricate a VAPORTEK chest lockup over the real PELAGIC fish-mark,
    // and vision-QC terminal-rejected the paid master). It is documented as
    // dormant-but-one-env-var-from-live in scripts/shared-invariants.json.
    //
    // Flipping the provider without this branch would have activated it on a
    // real user action, on a different provider, billing differently.
    // NO `prompt` ARGUMENT. This is deliberate and it is load-bearing.
    //
    // It used to pass `prompt: storyboard?.prompt || ad.veoPrompt`, which is
    // the SAME always-wrong-caller bug twice over:
    //
    //   * `storyboard?.prompt` — prepareStoryboard returns {storyboard:null}
    //     for every non-atlas provider, so this half is ALWAYS undefined.
    //   * `ad.veoPrompt` — stamped as part of the RECEIPT, i.e. AFTER a
    //     submit. So on a FIRST render it is null (empty prompt), and on a
    //     REGENERATE it is the PREVIOUS generation's prompt.
    //
    // The regenerate case was the expensive one, and it failed silently.
    // adRegenerateService calls this router (aliased as `veoService`) with
    // allowResume:false — a guaranteed new billable submit — so an operator
    // who typed "make the lighting warmer and slow the push-in", paid ~$1.03,
    // and got a byte-identical regeneration of the previous prompt. Measured:
    // the operator's text was absent from the submitted prompt, and the
    // submitted prompt was === the previous run's, with no error and no log.
    //
    // The provider now owns prompt construction outright: it builds from the
    // single buildVeoPrompt (CORE) and consults ad.veoPrompt ONLY when it is
    // actually resuming an existing receipt. A caller cannot supply state it
    // does not have, so the fix is to stop asking it to.
    result = await geminiVideoService.generateForAd({
      ad,
      operatorPrompt,
      // modelOverride is threaded so the call shape matches Atlas, but
      // Gemini does not speak Atlas slugs. The operator dropdown values
      // (e.g. `xai/grok-imagine-video-v1.5/reference-to-video`) are NOT
      // Gemini model ids; naive pass-through would 400 the submit.
      // geminiVideoService.resolveGeminiModel honors only ids that already
      // look like `gemini-…` and otherwise uses the configured default
      // (GEMINI_VIDEO_MODEL / gemini-omni-1.1-flash). There is no
      // Atlas-slug → Gemini mapping — Gemini currently has one production
      // model, and inventing an equivalent of Grok Imagine vs Omni Flash
      // would silently send a paid job to the wrong model. Do not claim
      // this "wires the operator's model choice"; for Atlas slugs it
      // does not.
      modelOverride,
      aspectRatio: ad.aspectRatio || '9:16',
      durationSec: ad.videoDurationSec || 10,
      allowResume,
      campaignRunId
    });
  } else if (provider === 'vertex') {
    // Vertex is now reachable ONLY by naming it explicitly. It used to be the
    // fall-through, which meant every typo and every new provider name landed
    // on a deprecated paid path by default.
    result = await aiVideoReferenceService.generateForAd({ ad, operatorPrompt });
    if (result && result.model == null) result.model = 'google/veo-3.1';
  } else {
    // FAIL CLOSED. Previously this was the Vertex arm, so VIDEO_PROVIDER=gemeni
    // (or any future value) silently generated on a third provider while the
    // operator believed they had cut over. Refusing to render costs nothing;
    // generating on the wrong provider costs a master and produces an asset
    // nobody asked for. Mirrors the same guard at renderer.js's seam.
    throw new Error(
      `VIDEO_PROVIDER=${JSON.stringify(provider)} is not a recognised video provider ` +
      `(expected 'atlas', 'gemini' or 'vertex'). Refusing to submit — an unknown ` +
      `provider must never fall through to a billable default.`
    );
  }

  if (result && !result.skipped) {
    const elapsedMs = Date.now() - t0;
    console.log(
      `🎬 videoRouter[ad=${ad._id}]: provider=${provider} model=${result.model} ` +
      `took=${Math.round(elapsedMs / 1000)}s`
    );
  }
  return result;
}

module.exports = {
  generateForAd,
  prepareStoryboard,
  activeProvider
};
