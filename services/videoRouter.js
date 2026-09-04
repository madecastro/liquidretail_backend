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
//   VIDEO_PROVIDER=vertex  → aiVideoReferenceService (deprecated direct-Veo path, kept as fallback)

const aiVideoReferenceService = require('./aiVideoReferenceService');
const atlasVideoService       = require('./atlasVideoService');

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
async function generateForAd({ ad, operatorPrompt = null, storyboard = null, modelOverride = null, campaignRunId = null }) {
  const provider = activeProvider();
  const t0 = Date.now();

  let result;
  if (provider === 'atlas') {
    result = await atlasVideoService.generateForAd({ ad, operatorPrompt, storyboard, modelOverride, campaignRunId });
  } else {
    // Default: Vertex Veo direct. Backward compatible — no behavioral
    // change for deployments that haven't set VIDEO_PROVIDER.
    result = await aiVideoReferenceService.generateForAd({ ad, operatorPrompt });
    if (result && result.model == null) result.model = 'google/veo-3.1';
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
