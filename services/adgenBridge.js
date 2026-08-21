'use strict';
// Bridge to the ad-gen microservice (liquidretail_adgen).
//
// Phase 1a — handshake only. Backend still owns expansion, mint, and
// claim (routes/ads.js:runRenderLoop is the single hand-off point).
// When ADGEN_RENDERER_ENABLED is true, runRenderLoop returns early
// and adgen's renderer picks up the claimed ads.
//
// Read at call time (not at boot) so a dashboard env flip takes effect
// without a redeploy — matches how AI_CONCEPT_DRIVEN and every other
// env-gated behavior in this file is toggled.

function isAdgenRendererEnabled() {
  return String(process.env.ADGEN_RENDERER_ENABLED || '').toLowerCase() === 'true';
}

module.exports = { isAdgenRendererEnabled };
