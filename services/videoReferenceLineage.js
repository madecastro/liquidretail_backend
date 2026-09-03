'use strict';

/**
 * videoReferenceLineage — recover the catalog original behind a video
 * reference URL that was pad/crop/reframed before submit.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * The generation-inspector modal (`GenerationInspectorModal.SeedCompareModal`)
 * renders "No original catalog media could be traced for this reference.
 * Showing the image that was sent." whenever `originalUrl` is falsy. Position
 * 0 (the seed) has a frontend fallback to `data.seed.url`; every other
 * reference depends entirely on the backend supplying `originalUrl`.
 *
 * `Ad.veoReferenceImages` is `{ type: [String] }` — it stores only the FINAL
 * submitted URL. `buildReferenceImages` runs every identity through
 * `reframeReferenceForAspect`, which almost never returns the literal
 * `Media.fileUrl`:
 *   • cache hit  → `Media.metadata.reframes.<aspectKey>.url`
 *   • fresh reframe / pad-upload → a new Cloudinary asset, cached the same way
 *   • exact-fit skip / $0 crop / $0 pad → `cropImageUrlForAspect` /
 *     `cloudinaryPadUrl` insert a Cloudinary transform segment
 *
 * The inspector used to `Media.find({ fileUrl: { $in: submittedUrls } })`,
 * an exact-string match that misses all three cases. Static image generation
 * already carries `sourceUrl` = the catalog URL independently of what was
 * uploaded (`atlasImageService.buildSubmissionRecord`); this module is the
 * video-path equivalent, resolved at READ time so already-generated ads
 * light up without a schema change or a re-mint.
 *
 * ── WHAT THIS IS NOT ───────────────────────────────────────────────────────
 * Not a submit-time record. A Media row deleted or re-uploaded since the
 * render still resolves to null and is labelled "not resolvable". The URL
 * LIST on the ad remains the verbatim persisted stack.
 */

// Transforms this pipeline inserts immediately after `/image/upload/` or
// `/video/upload/`. Tight on purpose: stripping ANY first Cloudinary
// segment would also peel a transform that was already on Media.fileUrl
// (e.g. `c_limit,w_2000`) and the rematch would miss.
//
//   cropImageUrlForAspect image  — b_rgb:HEX,c_fill,w_N,h_N,g_auto,f_jpg,q_auto:good
//   cropImageUrlForAspect video  — so_2,c_fill,w_N,h_N,f_jpg,q_auto:good
//                                  (so_N so a future offset still inverts)
//   cloudinaryPadUrl             — b_rgb:HEX,c_pad,...  OR  b_auto:predominant_gradient,c_pad,...
//   reframeStrategyChooser crop  — c_crop,w_N,h_N,x_N,y_N,f_jpg,q_auto:good
const KNOWN_SEGMENT = [
  'b_rgb:[0-9A-Fa-f]{3,8},c_fill,w_\\d+,h_\\d+,g_auto,f_jpg,q_auto:good',
  'b_rgb:[0-9A-Fa-f]{3,8},c_pad,w_\\d+,h_\\d+,f_jpg,q_auto:good',
  'b_auto:predominant_gradient,c_pad,w_\\d+,h_\\d+,f_jpg,q_auto:good',
  'so_\\d+,c_fill,w_\\d+,h_\\d+,f_jpg,q_auto:good',
  'c_crop,w_\\d+,h_\\d+,x_-?\\d+,y_-?\\d+,f_jpg,q_auto:good'
].join('|');

const STRIP_RE = new RegExp(`(/(?:image|video)/upload/)(?:${KNOWN_SEGMENT})/`);

const VIDEO_EXTS = ['mp4', 'mov', 'webm', 'm4v'];

function stripKnownCloudinaryTransform(url) {
  if (typeof url !== 'string' || !url) return null;
  const stripped = url.replace(STRIP_RE, '$1');
  return stripped === url ? null : stripped;
}

function inferMethodFromSubmittedUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  const m = url.match(/\/(?:image|video)\/upload\/([^/]+)\//);
  if (!m) return null;
  const seg = m[1];
  if (/,c_fill,/.test(seg) && /,g_auto,/.test(seg)) return 'crop';
  if (/,c_pad,/.test(seg)) return 'pad';
  if (/^c_crop,/.test(seg)) return 'crop';
  if (/^so_\d+,/.test(seg) && /,c_fill,/.test(seg)) return 'crop';
  return null;
}

function candidateOriginalUrls(submittedUrl) {
  const out = [];
  const seen = new Set();
  const add = (u) => {
    if (typeof u === 'string' && u && !seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  };
  add(submittedUrl);
  const stripped = stripKnownCloudinaryTransform(submittedUrl);
  if (stripped) {
    add(stripped);
    // cropImageUrlForAspect rewrites video extensions to .jpg after inserting
    // the still-extract transform. Recover the likely original fileUrl.
    if (/\/video\/upload\//.test(stripped)) {
      const m = stripped.match(/^(.*)\.jpg(\?.*)?$/i);
      if (m) {
        for (const ext of VIDEO_EXTS) add(`${m[1]}.${ext}${m[2] || ''}`);
      }
    }
  }
  return out;
}

function submittedUrlOf(entry) {
  if (typeof entry === 'string') return entry || null;
  if (entry && typeof entry === 'object') {
    if (typeof entry.url === 'string' && entry.url) return entry.url;
    if (typeof entry.submittedUrl === 'string' && entry.submittedUrl) return entry.submittedUrl;
  }
  return null;
}

function preloadedOriginalOf(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.originalUrl === 'string' && entry.originalUrl) return entry.originalUrl;
  if (typeof entry.sourceUrl === 'string' && entry.sourceUrl) return entry.sourceUrl;
  return null;
}

function reframeEntriesOf(media) {
  const reframes = media && media.metadata && media.metadata.reframes;
  if (!reframes || typeof reframes !== 'object' || Array.isArray(reframes)) return [];
  const out = [];
  for (const key of Object.keys(reframes)) {
    const entry = reframes[key];
    if (entry && typeof entry.url === 'string' && entry.url) {
      out.push({ key, url: entry.url, method: entry.method || null });
    }
  }
  return out;
}

function resolveOneReference(submittedUrl, medias) {
  const list = Array.isArray(medias) ? medias : [];
  if (typeof submittedUrl !== 'string' || !submittedUrl) {
    return { media: null, originalUrl: null, resolvedVia: null, method: null };
  }

  const byFileUrl = new Map();
  for (const m of list) {
    if (m && typeof m.fileUrl === 'string' && m.fileUrl && !byFileUrl.has(m.fileUrl)) {
      byFileUrl.set(m.fileUrl, m);
    }
  }

  const exact = byFileUrl.get(submittedUrl);
  if (exact) {
    return { media: exact, originalUrl: exact.fileUrl, resolvedVia: 'fileUrl', method: null };
  }

  const candidates = candidateOriginalUrls(submittedUrl);
  for (const c of candidates) {
    if (c === submittedUrl) continue;
    const hit = byFileUrl.get(c);
    if (hit) {
      return {
        media: hit,
        originalUrl: hit.fileUrl,
        resolvedVia: 'stripped-transform',
        method: inferMethodFromSubmittedUrl(submittedUrl)
      };
    }
  }

  for (const m of list) {
    for (const entry of reframeEntriesOf(m)) {
      if (entry.url === submittedUrl) {
        return {
          media: m,
          originalUrl: m.fileUrl || null,
          resolvedVia: 'reframe-cache',
          method: entry.method
        };
      }
    }
  }

  return { media: null, originalUrl: null, resolvedVia: null, method: null };
}

function describeReference(media, position) {
  if (position === 0) return 'seed — the frame the model animated';
  if (!media) return 'not resolvable — no Media row matches this URL now';
  const imageRole = media.metadata && media.metadata.imageRole ? media.metadata.imageRole : null;
  const feedIndex = Number.isInteger(media.metadata && media.metadata.feedIndex)
    ? media.metadata.feedIndex
    : null;
  if (feedIndex === 0) return 'catalog primary (merchant feed image 0)';
  if (feedIndex != null) return `catalog alt (merchant feed image ${feedIndex})`;
  if (imageRole) return `catalog ${imageRole}`;
  return `${media.source || 'unknown'} media`;
}

function uniqueStrings(arr) {
  const out = [];
  const seen = new Set();
  for (const v of arr) {
    if (typeof v !== 'string' || !v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function objectIdStrings(arr) {
  const out = [];
  const seen = new Set();
  for (const v of arr) {
    if (v == null || v === '') continue;
    const s = String(v);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(v);
  }
  return out;
}

/**
 * PURE Mongo filter for the inspector's reference-image lookup.
 * `fileUrl $in` is the identity match (same as the pre-fix query, but the
 * list is expanded with stripped-transform candidates). The `_id` and
 * `metadata.catalogProductId` branches exist so we can scan
 * `metadata.reframes.*.url` on the media that actually produced this ad,
 * without walking the whole brand.
 *
 * brandId is applied only to the catalog-product branch: a URL is its own
 * identity (the historical query had no brandId), and `_id`s come from THIS
 * already-tenant-checked Ad.
 */
function buildVideoReferenceMediaFilter({ brandId, productId, knownMediaIds, lookupUrls }) {
  const urls = uniqueStrings(Array.isArray(lookupUrls) ? lookupUrls : []);
  const ids = objectIdStrings(Array.isArray(knownMediaIds) ? knownMediaIds : []);
  const or = [];
  if (urls.length) or.push({ fileUrl: { $in: urls } });
  if (ids.length) or.push({ _id: { $in: ids } });
  if (productId && brandId) {
    or.push({ brandId, 'metadata.catalogProductId': productId });
  }
  if (!or.length) return null;
  return { $or: or };
}

function lookupUrlsFor(referenceUrls) {
  const urls = [];
  for (const u of (Array.isArray(referenceUrls) ? referenceUrls : [])) {
    for (const c of candidateOriginalUrls(u)) urls.push(c);
  }
  return uniqueStrings(urls);
}

function knownMediaIdsFor(ad) {
  if (!ad) return [];
  return objectIdStrings([
    ad.mediaId,
    ...(Array.isArray(ad.mediaIds) ? ad.mediaIds : []),
    ...(Array.isArray(ad.referenceMediaIds) ? ad.referenceMediaIds : [])
  ]);
}

function shapeReferenceEntry({ url, position, media, originalUrl, resolvedVia, method }) {
  const imageRole = media && media.metadata && media.metadata.imageRole
    ? media.metadata.imageRole
    : null;
  const feedIndex = Number.isInteger(media && media.metadata && media.metadata.feedIndex)
    ? media.metadata.feedIndex
    : null;
  return {
    url,
    // Catalog original. Frontend SeedCompareModal keys on this; static
    // inspector reads `originalUrl || sourceUrl` — set both so the two
    // paths stay on the same convention.
    originalUrl: originalUrl || null,
    sourceUrl: originalUrl || null,
    position,
    describes: describeReference(media, position),
    mediaId: media && media._id != null ? String(media._id) : null,
    mediaSource: (media && media.source) || null,
    imageRole,
    feedIndex,
    primarySubjectDesc: (media && media.primarySubjectDesc) || null,
    method: method || null,
    processed: !!(originalUrl && originalUrl !== url),
    resolvedVia: resolvedVia || null,
    // Honesty flag: descriptive fields (and originalUrl) come from a LOOKUP
    // performed when the inspector was opened, not from the submit-time
    // record. Always true on this shape — same meaning as the pre-fix payload.
    resolvedFromUrl: true
  };
}

/**
 * Build the inspector's `video.referenceImages` array from the persisted
 * submitted-URL stack plus the Media docs fetched for this ad.
 *
 * Submit-time lineage on an object entry (`originalUrl` / `sourceUrl`) wins
 * over the lookup, so a future persist of per-ref originals does not fight
 * this resolver.
 */
function buildReferenceImageEntries(rawEntries, medias) {
  const list = Array.isArray(rawEntries) ? rawEntries : [];
  return list.map((entry, i) => {
    const url = submittedUrlOf(entry);
    if (!url) {
      return shapeReferenceEntry({
        url: '',
        position: i,
        media: null,
        originalUrl: preloadedOriginalOf(entry),
        resolvedVia: null,
        method: null
      });
    }
    const found = resolveOneReference(url, medias);
    const originalUrl = preloadedOriginalOf(entry) || found.originalUrl;
    const resolvedVia = preloadedOriginalOf(entry)
      ? (found.resolvedVia || 'submit-record')
      : found.resolvedVia;
    return shapeReferenceEntry({
      url,
      position: i,
      media: found.media,
      originalUrl,
      resolvedVia,
      method: found.method
    });
  });
}

module.exports = {
  stripKnownCloudinaryTransform,
  candidateOriginalUrls,
  lookupUrlsFor,
  knownMediaIdsFor,
  buildVideoReferenceMediaFilter,
  resolveOneReference,
  describeReference,
  submittedUrlOf,
  buildReferenceImageEntries,
  inferMethodFromSubmittedUrl
};
