// Phase 2 helpers for V2 (Director-driven Generator) path.
//   - pickConceptForCell    deterministic concept rotation per Ad cell
//   - compressVisionUrl     Cloudinary-aware low-res transform for vision attachments

const crypto = require('crypto');

// Deterministic concept picker. Given the Director artifact's concepts[]
// and a cell identity (any string — mediaId + paletteSource works), pick
// one concept by index using a stable hash. Different cells of the same
// (brand × product) get different concepts, so the batch spreads across
// the Director's emissions instead of every Ad getting concept[0].
//
// Phase 6.5 — optional runId is mixed into the hash so the SAME cell
// shape rotates concepts batch-over-batch. Within a single CampaignRun
// the cell stays cache-stable (same runId throughout → same concept
// pick → same AiCanvasArtifact cache key). Across runs, the pick
// rotates so an operator running the same campaign twice gets a
// genuinely different look the second time, not just a re-render of
// the first. Backward-compatible — when runId is omitted, behaves
// exactly like the pre-6.5 deterministic-by-cellKey picker.
function pickConceptForCell({ concepts, cellKey, runId = null }) {
  if (!Array.isArray(concepts) || !concepts.length) return null;
  if (concepts.length === 1) return concepts[0];
  const seed = runId ? `${cellKey || ''}|${runId}` : String(cellKey || '');
  const hash = crypto.createHash('sha256').update(seed).digest();
  // Use first 4 bytes as an unsigned int → modulo concept count.
  const idx = hash.readUInt32BE(0) % concepts.length;
  return concepts[idx];
}

// Apply Cloudinary transform chain that hard-caps the delivered image to
// `maxDim` px on the longest side, downgrades quality to `q_auto:eco`,
// and lets the format auto-negotiate (WebP / AVIF where supported).
// For LLM vision, 512px is plenty — the model judges composition not
// pixel sharpness, and small images cost a fraction of full-res tiles.
//
// Video URLs are rewritten to a still JPEG (so_2 — 2 seconds in,
// past typical intro flashes) with the same size cap. OpenAI's
// multimodal endpoint 400s on .mp4 URLs; the still keeps the vision
// signal usable when the seededUniverse includes UGC video.
//
// Skips:
//   - non-Cloudinary URLs (no '/upload/' segment) — passed through as-is
//   - URLs that already have a low-cap transform chained — would double up
//
// The injection follows the same pattern the existing pipeline uses
// (buildCloudinaryCropUrl in layoutInputService): insert transforms
// right before the `v<version>/` segment, or right after `/upload/`.
function compressVisionUrl(url, maxDim = 512) {
  if (!url || typeof url !== 'string') return url;

  // Video → still JPEG. Uses so_2 (2 seconds in) to avoid typical
  // intro flashes / title cards, matching the extraction convention
  // used across atlasVideoService, aiCanvasHtmlGeneratorService, and
  // layoutInputService. f_jpg forces JPEG so OpenAI accepts it.
  if (url.includes('/video/upload/')) {
    const t = `so_2,c_limit,w_${maxDim},h_${maxDim},q_auto:eco,f_jpg`;
    return url
      .replace('/video/upload/', `/video/upload/${t}/`)
      .replace(/\.(mp4|mov|webm|m4v)(\?.*)?$/i, '.jpg$2');
  }

  if (!url.includes('/upload/')) return url;
  // Avoid double-wrapping when caller already compressed.
  if (/\/c_limit,w_\d+,h_\d+/.test(url) || /\/q_auto:(?:low|eco)\b/.test(url)) return url;
  const t = `c_limit,w_${maxDim},h_${maxDim},q_auto:eco,f_auto`;
  if (/\/v\d+\//.test(url)) {
    return url.replace(/\/(v\d+\/)/, `/${t}/$1`);
  }
  return url.replace('/upload/', `/upload/${t}/`);
}

// Apply the compressor across an array of {url, ...} attachments. Each
// gets a `url` field rewritten in place; other fields preserved.
function compressVisionAttachments(attachments, maxDim = 512) {
  if (!Array.isArray(attachments)) return attachments;
  return attachments.map(att => ({
    ...att,
    url: compressVisionUrl(att.url, maxDim)
  }));
}

module.exports = {
  pickConceptForCell,
  compressVisionUrl,
  compressVisionAttachments
};
