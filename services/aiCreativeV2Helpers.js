// Phase 2 helpers for V2 (Director-driven Generator) path.
//   - pickConceptForCell    deterministic concept rotation per Ad cell
//   - compressVisionUrl     Cloudinary-aware low-res transform for vision attachments

const crypto = require('crypto');

// Deterministic concept picker. Given the Director artifact's concepts[]
// and a cell identity (any string — mediaId + paletteSource works), pick
// one concept by index using a stable hash. Different cells of the same
// (brand × product) get different concepts, so the batch spreads across
// the Director's emissions instead of every Ad getting concept[0].
function pickConceptForCell({ concepts, cellKey }) {
  if (!Array.isArray(concepts) || !concepts.length) return null;
  if (concepts.length === 1) return concepts[0];
  const hash = crypto.createHash('sha256').update(String(cellKey || '')).digest();
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
// Skips:
//   - non-Cloudinary URLs (no '/upload/' segment) — passed through as-is
//   - URLs that already have a low-cap transform chained — would double up
//
// The injection follows the same pattern the existing pipeline uses
// (buildCloudinaryCropUrl in layoutInputService): insert transforms
// right before the `v<version>/` segment, or right after `/upload/`.
function compressVisionUrl(url, maxDim = 512) {
  if (!url || typeof url !== 'string') return url;
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
