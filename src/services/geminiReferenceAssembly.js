'use strict';
//
// geminiReferenceAssembly — turn an Ad into the reference bytes Gemini needs.
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
// geminiVideoService.generateForAd took `images` as a parameter and BOTH of
// its callers passed `storyboard?.images`, which is ALWAYS `[]` on the gemini
// path because videoRouter.prepareStoryboard returns `{storyboard:null}` for
// every non-atlas provider. So the provider as merged would have submitted
// ZERO references — text-to-video, not reference-to-video — and billed ~$1
// per useless master. This closes that.
//
// ── WHY IT IS NOT A COPY OF THE ATLAS LOADING ────────────────────────────
// Owner directive: Gemini direct with RAW images, period. No reframe ladder.
// That makes this much smaller than atlasVideoService's equivalent, and the
// difference is not laziness — it is the whole point:
//
//   * NO pad / crop / outpaint. atlasVideoService runs every assembled ref
//     through reframeReferenceForAspect, which on an over-tolerance subject
//     calls Atlas Cloud's BILLABLE `google/nano-banana-2/edit-developer`
//     image model (~$0.08/ref) and fabricates pixels. Measured on Pelagic:
//     21 of 36 chooseStrategy decisions took that path. Raw references skip
//     it entirely, which is both cheaper and higher fidelity.
//   * NO Atlas caps object. buildReferenceImages reads exactly ONE field off
//     `caps` — `caps.maxReferenceImages` (two read sites). Verified by grep,
//     not assumed. So we pass a narrow `{ maxReferenceImages }` and stay
//     completely decoupled from MODEL_CAPS / paramShape / Atlas model slugs.
//   * NO storyboard. Retired on every provider; the prompt directs motion.
//
// ── WHAT IT DELIBERATELY REUSES ──────────────────────────────────────────
// `buildReferenceImages` and `sortCatalogMediasForReferenceStack` are
// IMPORTED from atlasVideoService, never reimplemented. They carry the
// packshot-protected ranking, the feed-order base, the operator-pick
// override, the distinctness cap and the primary-reference repeat. This repo
// has a long, documented history of vendored duplication drifting; a second
// copy of reference ordering would drift the moment either side is tuned.
// The file is named for Gemini but the ORDERING is provider-agnostic.
//
// ── THE ONE THING ATLAS NEVER NEEDED ─────────────────────────────────────
// Atlas video endpoints take reference URLs. Gemini's `/interactions` takes
// base64 BYTES. buildReferenceImages returns URL STRINGS at both of its
// return points, and nothing in the Atlas path fetches reference bytes —
// `downloadToBuffer` exists there for the OUTPUT mirror and is not exported.
// So fetching is genuinely new work, and it is where the size ceiling and the
// fail-closed behaviour below live.
//
const Ad = require('../models/Ad');
const Brand = require('../models/Brand');
const Media = require('../models/Media');
const CatalogProduct = require('../models/CatalogProduct');
const {
  buildReferenceImages,
  sortCatalogMediasForReferenceStack
} = require('./atlasVideoService');
const referenceDefaultsService = require('./referenceDefaultsService');

// Gemini's reference_to_video max image count is NOT PUBLISHED. Measured 3-4;
// an internal skill uses 6. Atlas's 7/5 must NOT be carried over — different
// provider, different undocumented ceiling. 3 is the production default
// (VIDEO_DEFAULT_REFERENCE_COUNT=3) and is what every measurement tonight
// used, so it is what we ship.
const MAX_REFERENCE_IMAGES = (() => {
  const raw = Number(process.env.GEMINI_VIDEO_MAX_REFERENCES);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 3;
})();

// Total base64 ceiling for one request.
//
// MEASURED on real Pelagic stacks: 3 raw catalog refs are 0.73-2.11 MB on
// disk, 0.97-2.81 MB once base64'd. Gemini's documented guidance is to switch
// to the Files API above ~100 MB of total request; 20 MB is far under that and
// still ~7x the largest measured stack, so it bounds a pathological catalog
// image (a 40 MP TIFF) without ever tripping on a normal one.
//
// This is a REFUSAL, not a truncation. Silently dropping a reference to fit
// would change what the model sees on a billable generation while reporting
// success — the reference stack is the whole fidelity argument.
const MAX_TOTAL_B64_BYTES = (() => {
  const raw = Number(process.env.GEMINI_VIDEO_MAX_PAYLOAD_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 20 * 1024 * 1024;
})();

const FETCH_TIMEOUT_MS = 30_000;

function b64Len(byteLen) {
  return Math.ceil(byteLen / 3) * 4;
}

/**
 * Fetch one reference URL to bytes.
 *
 * Content-type is VALIDATED. A Cloudinary transform that 404s, or a catalog
 * URL that has rotted into an HTML error page, returns 200 with `text/html`
 * — base64-ing that and calling it an image produces a garbage reference on
 * a paid generation. Atlas never had to care because it passed URLs through
 * and let the provider fetch.
 */
async function fetchReferenceBytes(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'follow' });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const ct = String(res.headers.get('content-type') || '').toLowerCase();
    if (!ct.startsWith('image/')) {
      return { ok: false, reason: `content-type ${ct || 'missing'} is not an image` };
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.length) return { ok: false, reason: 'empty body' };
    return { ok: true, buffer, mimeType: ct.split(';')[0].trim() };
  } catch (err) {
    return { ok: false, reason: err.name === 'AbortError' ? `timeout after ${FETCH_TIMEOUT_MS}ms` : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Assemble the reference stack for one ad, as bytes.
 *
 * Returns `{ images, urls, aspectRatio }` where each image is
 * `{ buffer, mimeType, sourceUrl }` — the shape geminiVideoService's
 * buildRequestBody already expects.
 *
 * THROWS rather than returning a short stack. Every failure here is a reason
 * NOT to spend ~$1, and a caller that receives fewer references than intended
 * has no way to tell a deliberate 1-ref lifestyle stack from a silently
 * degraded 3-ref one.
 */
async function assembleReferences({ ad, aspectRatioOverride = null }) {
  if (!ad?.mediaId) {
    const err = new Error('gemini refs: ad has no mediaId — nothing to seed from');
    err.code = 'GEMINI_REFS_NO_SEED';
    throw err;
  }

  const media = await Media.findById(ad.mediaId).lean();
  if (!media?.fileUrl) {
    const err = new Error(`gemini refs: seed media ${ad.mediaId} missing or has no fileUrl`);
    err.code = 'GEMINI_REFS_SEED_UNUSABLE';
    throw err;
  }

  // Same three loads Atlas does, minus everything only Atlas needs (no
  // LayoutInputArtifact refresh, no Campaign.kind, no duration resolution,
  // no category chain — none of them reach buildReferenceImages).
  //
  // The catalogMedias projection is copied DELIBERATELY, including
  // `refinedProducts`: it is unused on the raw path, but Atlas's own comment
  // records that dropping it silently forces every alt through the paid
  // outpaint, and this projection is documented as needing to stay in sync
  // with videoRefPrewarmService's sister copy. Keeping them identical is
  // cheaper than a future reader having to work out why they differ.
  const [brand, product, catalogMedias] = await Promise.all([
    media.brandId ? Brand.findById(media.brandId).lean() : null,
    ad.productId ? CatalogProduct.findById(ad.productId).lean() : null,
    ad.productId
      ? Media.find({
          source: 'catalog-product',
          'metadata.catalogProductId': ad.productId
        })
          .select('_id fileUrl classification adSuitability metadata width height refinedProducts createdAt')
          .lean()
          .then(sortCatalogMediasForReferenceStack)
      : []
  ]);

  const aspectRatio = aspectRatioOverride || ad.aspectRatio || '9:16';
  const referenceCount = referenceDefaultsService.videoReferenceDefaults?.().count
    || MAX_REFERENCE_IMAGES;

  // Operator picks win outright, exactly as on the Atlas path.
  const orderedReferenceMedia = Array.isArray(ad.referenceMediaIds) && ad.referenceMediaIds.length
    ? await Media.find({ _id: { $in: ad.referenceMediaIds } })
        .select('_id fileUrl classification metadata width height refinedProducts createdAt')
        .lean()
        .then((docs) => {
          // Preserve the operator's ORDER — a $in query does not.
          const byId = new Map(docs.map((d) => [String(d._id), d]));
          return ad.referenceMediaIds.map((id) => byId.get(String(id))).filter(Boolean);
        })
    : null;

  const urls = await buildReferenceImages({
    media,
    product,
    catalogMedias,
    aspectRatio,
    // NARROWED ON PURPOSE. buildReferenceImages reads exactly one field off
    // `caps` — maxReferenceImages — so passing an Atlas MODEL_CAPS entry here
    // would couple this provider to Atlas's registry for no benefit.
    caps: { maxReferenceImages: MAX_REFERENCE_IMAGES },
    referenceCount: Math.min(referenceCount, MAX_REFERENCE_IMAGES),
    brand,
    orderedReferenceMedia,
    brandId: media.brandId || null,
    productId: ad.productId || null,
    adId: ad._id,
    campaignRunId: null
  });

  if (!Array.isArray(urls) || urls.length === 0) {
    const err = new Error('gemini refs: buildReferenceImages returned no references');
    err.code = 'GEMINI_REFS_EMPTY';
    throw err;
  }

  // ── FETCH. Fail closed on any bad reference. ───────────────────────────
  const images = [];
  let totalB64 = 0;
  for (const url of urls) {
    const got = await fetchReferenceBytes(url);
    if (!got.ok) {
      const err = new Error(`gemini refs: reference unusable (${got.reason}): ${String(url).slice(0, 120)}`);
      err.code = 'GEMINI_REFS_FETCH_FAILED';
      throw err;
    }
    totalB64 += b64Len(got.buffer.length);
    if (totalB64 > MAX_TOTAL_B64_BYTES) {
      const err = new Error(
        `gemini refs: base64 payload ${(totalB64 / 1048576).toFixed(2)} MB exceeds the ` +
        `${(MAX_TOTAL_B64_BYTES / 1048576).toFixed(0)} MB ceiling — refusing to submit ` +
        `rather than silently dropping a reference`
      );
      err.code = 'GEMINI_REFS_TOO_LARGE';
      throw err;
    }
    images.push({ buffer: got.buffer, mimeType: got.mimeType, sourceUrl: url });
  }

  // A transform on the raw path means the reframe ladder leaked back in.
  // Cheap to assert, and it is the whole owner directive in one line.
  const transformed = images
    .map((i) => i.sourceUrl)
    .filter((u) => /\/c_(pad|crop|fill|limit)[,/]|\/liquidretail\/reframes\//.test(String(u)));
  if (transformed.length) {
    console.warn(
      `⚠️  gemini refs[ad=${ad._id}]: ${transformed.length} reference(s) carry a Cloudinary ` +
      `transform or a /reframes/ path — VIDEO_RAW_CATALOG_REFERENCES may be off. ` +
      `Raw catalog images are the directive; this generation will use reshaped inputs.`
    );
  }

  return { images, urls, aspectRatio };
}

module.exports = {
  assembleReferences,
  fetchReferenceBytes,
  b64Len,
  MAX_REFERENCE_IMAGES,
  MAX_TOTAL_B64_BYTES
};
