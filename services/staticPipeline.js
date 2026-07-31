'use strict';
/**
 * Canonical resolver for Brand.staticImagePipeline — the ONE place the
 * "which static renderer runs" question is answered.
 *
 * It exists as its own module for two reasons:
 *
 *  1. The old coercion lived inside directImageRenderService as
 *     `String(value || DIRECT_OVERLAY_PIPELINE).toLowerCase() === ...`, which
 *     meant every other caller that needed the same answer had to re-derive it.
 *     Re-deriving a default is how a pipeline flag drifts between the route that
 *     writes it, the model that stores it, and the renderer that reads it.
 *  2. routes/brand.js needs the answer too, and must not have to require the
 *     renderer (which pulls in sharp, axios and three models) just to validate a
 *     PATCH body.
 *
 * DESIGN: only the exact string 'html' selects the legacy path. Everything else
 * — including the RETIRED 'direct_overlay' still stored on existing brands, an
 * empty string, null, undefined, or any future typo — resolves to the direct
 * image path. That asymmetry is deliberate and is the reason no backfill is
 * needed (house rule: forward-only, no legacy rows):
 *
 *   - It is fail-safe in the direction the owner wants. The legacy HTML path is
 *     an emergency fallback that "should in practicality never be used"; a
 *     garbled value must never silently route a brand back onto it.
 *   - Retired and unknown values converge on the supported renderer instead of
 *     throwing at render time, so a brand row written months ago still renders.
 */

const DIRECT_IMAGE = 'direct_image';
const HTML = 'html';

/** Canonical values a client may WRITE. */
const STATIC_PIPELINES = [DIRECT_IMAGE, HTML];

/**
 * Accepted on write but normalised away. 'direct_overlay' was the plate + local
 * SVG overlay renderer, retired 2026-07-31. It is still accepted so a frontend
 * build that predates the rename keeps working instead of 400-ing; it is stored
 * as 'direct_image'. Remove from this map once the brand page ships the new
 * label — at which point an incoming 'direct_overlay' becomes a real client bug
 * worth surfacing rather than absorbing.
 */
const DEPRECATED_INPUTS = { direct_overlay: DIRECT_IMAGE };

/** Normalise a client-supplied value, or return null if it is not acceptable. */
function normalizeStaticPipelineInput(value) {
  const v = String(value == null ? '' : value).trim().toLowerCase();
  if (STATIC_PIPELINES.includes(v)) return v;
  if (Object.prototype.hasOwnProperty.call(DEPRECATED_INPUTS, v)) return DEPRECATED_INPUTS[v];
  return null;
}

/**
 * Resolve a STORED value to the pipeline that will actually run. Never throws,
 * never returns anything but one of STATIC_PIPELINES.
 */
function resolveStaticPipeline(value) {
  return String(value == null ? '' : value).trim().toLowerCase() === HTML ? HTML : DIRECT_IMAGE;
}

function isHtmlPipeline(value) {
  return resolveStaticPipeline(value) === HTML;
}

function isDirectImagePipeline(value) {
  return resolveStaticPipeline(value) === DIRECT_IMAGE;
}

module.exports = {
  DIRECT_IMAGE,
  HTML,
  STATIC_PIPELINES,
  DEPRECATED_INPUTS,
  normalizeStaticPipelineInput,
  resolveStaticPipeline,
  isHtmlPipeline,
  isDirectImagePipeline
};
