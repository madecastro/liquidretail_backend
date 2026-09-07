'use strict';
// MONEY-CRITICAL: Cloudinary hygiene for Ad docs.
//
// Destroy is gated on a GENERIC "is this exact URL still present as
// renderUrl OR veoVideoUrl on any OTHER Ad" check — not on platform or
// format names. That is what makes Meta derive-children and mixed-run
// shared-portrait plates as safe as PMax 1:1 was (and PMax was the only
// family the previous DELETE route actually protected).
//
// Hand-synced with adgen/src/services/adCloudinaryCleanup.js — do not
// import across the two repos; keep the copies byte-identical.

const CLOUDINARY_HOST_RE = /res\.cloudinary\.com/;

function isCloudinaryHosted(url) {
  return typeof url === 'string' && url.length > 0 && CLOUDINARY_HOST_RE.test(url);
}

// Strip Cloudinary transform segments and version so two URLs that name
// the SAME stored asset (a raw video vs its so_2,f_jpg poster transform)
// compare equal. Transform segments contain a comma (`so_2,f_jpg,q_auto:good`)
// or a known action prefix; `v123` is the version folder.
function cloudinaryAssetKey(url) {
  if (!isCloudinaryHosted(url)) return null;
  const m = url.match(/res\.cloudinary\.com\/[^/]+\/(?:image|video)\/upload\/(.+?)(?:\?|$)/i);
  if (!m) return null;
  const parts = m[1].split('/').filter(Boolean);
  let i = 0;
  while (i < parts.length) {
    const p = parts[i];
    if (/^v\d+$/.test(p)) { i += 1; continue; }
    if (p.includes(',') || /^(?:so|f|q|w|h|c|g|ar|fl|e|dpr|bo|r|b|t|l|u|o|a|d|pg|dn|cs|du|dl)_/.test(p)) {
      i += 1;
      continue;
    }
    break;
  }
  const rest = parts.slice(i).join('/');
  if (!rest) return null;
  return rest.replace(/\.[a-z0-9]+$/i, '');
}

function isDerivedVideoPoster(posterUrl, sourceUrl) {
  if (!isCloudinaryHosted(posterUrl) || !sourceUrl) return false;
  const a = cloudinaryAssetKey(posterUrl);
  const b = cloudinaryAssetKey(sourceUrl);
  return !!(a && b && a === b);
}

function collectAdCloudinaryUrls(ad) {
  const urls = [];
  const seen = new Set();
  function add(u) {
    if (!isCloudinaryHosted(u) || seen.has(u)) return;
    seen.add(u);
    urls.push(u);
  }
  if (!ad) return urls;
  add(ad.renderUrl);
  add(ad.veoVideoUrl);
  const attempts = ad.visionQc && Array.isArray(ad.visionQc.attempts)
    ? ad.visionQc.attempts
    : [];
  for (const a of attempts) {
    if (!a || typeof a !== 'object') continue;
    add(a.renderUrl);
    add(a.discardedRenderUrl);
  }
  // posterUrl is USUALLY a Cloudinary *transform* of renderUrl/veoVideoUrl
  // (so_2,f_jpg,q_auto:good inserted after /video/upload/ — fallbackPosterUrl,
  // uploadRenderAndStamp, ads.js preview). Destroying the source with
  // invalidate:true covers those. aiVideoPosterService, however, uploads a
  // genuine separate PNG (`liquidretail/ai_video_poster/...`). Historical
  // rows can still hold that independent asset; collect it when it is NOT
  // a transform of this ad's own video URLs.
  if (isCloudinaryHosted(ad.posterUrl)
      && !isDerivedVideoPoster(ad.posterUrl, ad.renderUrl)
      && !isDerivedVideoPoster(ad.posterUrl, ad.veoVideoUrl)) {
    add(ad.posterUrl);
  }
  return urls;
}

function snapshotAdCloudinaryState(ad) {
  if (!ad) return null;
  return {
    _id: ad._id,
    campaignId: ad.campaignId,
    brandId: ad.brandId,
    kind: ad.kind,
    renderUrl: ad.renderUrl,
    veoVideoUrl: ad.veoVideoUrl,
    posterUrl: ad.posterUrl,
    cloudinaryPublicId: ad.cloudinaryPublicId,
    visionQc: ad.visionQc
      ? JSON.parse(JSON.stringify(ad.visionQc))
      : null
  };
}

function buildSharedUrlFilter(url, { excludeAdId, campaignId, brandId } = {}) {
  const filter = {
    _id: { $ne: excludeAdId },
    $or: [{ renderUrl: url }, { veoVideoUrl: url }]
  };
  if (campaignId) filter.campaignId = campaignId;
  if (brandId) filter.brandId = brandId;
  return filter;
}

function fallbackPublicIdFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(/\/upload\/(?:v\d+\/)?(.+)\.[a-z0-9]+(?:\?.*)?$/i);
  return m ? m[1] : null;
}

function loadCloudinary(opts = {}) {
  let mod = null;
  if (!opts.deleteFromCloudinary || !opts.publicIdFromUrl) {
    try { mod = require('./cloudinaryService'); } catch (_) { mod = null; }
  }
  return {
    deleteFromCloudinary: opts.deleteFromCloudinary
      || (mod && mod.deleteFromCloudinary)
      || null,
    publicIdFromUrl: opts.publicIdFromUrl
      || (mod && mod.publicIdFromUrl)
      || fallbackPublicIdFromUrl,
    deletePublicIdFromCloudinary: opts.deletePublicIdFromCloudinary
      || (mod && mod.deletePublicIdFromCloudinary)
      || null
  };
}

function publicIdsHeldByAd(ad, publicIdFromUrl) {
  const ids = new Set();
  if (!ad) return ids;
  if (typeof ad.cloudinaryPublicId === 'string' && ad.cloudinaryPublicId) {
    ids.add(ad.cloudinaryPublicId);
  }
  for (const url of collectAdCloudinaryUrls(ad)) {
    const pid = publicIdFromUrl(url);
    if (pid) ids.add(pid);
  }
  return ids;
}

function resourceTypeFor(url, ad) {
  if (/\.(mp4|mov|webm|m4v|mkv)(\?|$)/i.test(url || '')) return 'video';
  if (ad && ad.kind === 'video') return 'video';
  return 'image';
}

// Video: Ad.cloudinaryPublicId is the RAW MASTER (renderer $setMaster).
// Static: it is the render public_id. Never attribute it to a different
// field — a titled renderUrl that happens to contain the master id as a
// substring must not destroy the master.
function pidFallbackForUrl(url, ad) {
  if (!ad || typeof ad.cloudinaryPublicId !== 'string' || !ad.cloudinaryPublicId) return null;
  if (!url || typeof url !== 'string' || !url.includes(ad.cloudinaryPublicId)) return null;
  if (ad.kind === 'video') {
    return url === ad.veoVideoUrl ? ad.cloudinaryPublicId : null;
  }
  return url === ad.renderUrl ? ad.cloudinaryPublicId : null;
}

// MONEY-CRITICAL (regenerate): runVideoFull stamps renderUrl = veoVideoUrl
// (the NEW raw master) BEFORE titling so a chrome failure still leaves a
// viewable fallback. That catch is non-fatal, so cleanup would otherwise
// see previous.renderUrl (the OLD titled asset) as unreferenced and
// destroy it — the last-known-good titled video — while the ad now
// delivers the untitled master. Same shape as "master rendered; titling
// failed". adTitlingTruth.isVideoTitlingSettled treats a declared
// `renderStage: "no titling (...)"` as settled; on regenerate that is
// NOT licence to delete a previously-titled delivery. The load-bearing
// signal is the delivery field itself: raw master is still what plays.
function previousTitledDeliveryToKeep(previousAd, currentAd) {
  if (!previousAd || !currentAd) return null;
  const kind = currentAd.kind || previousAd.kind;
  if (kind !== 'video') return null;
  if (!currentAd.renderUrl || !currentAd.veoVideoUrl) return null;
  if (currentAd.renderUrl !== currentAd.veoVideoUrl) return null;
  const prev = previousAd.renderUrl;
  if (!prev || typeof prev !== 'string') return null;
  if (previousAd.veoVideoUrl && prev === previousAd.veoVideoUrl) return null;
  if (prev === currentAd.renderUrl) return null;
  return prev;
}

// MONEY-CRITICAL: fail closed. A throw here means we cannot prove the
// asset is unused, so callers MUST keep it.
async function urlStillReferencedByOtherAd(url, opts = {}) {
  const Ad = opts.Ad || require('../models/Ad');
  try {
    const hit = await Ad.findOne(buildSharedUrlFilter(url, opts)).select('_id').lean();
    return !!hit;
  } catch (err) {
    if (typeof opts.onLookupError === 'function') opts.onLookupError(err);
    else {
      console.warn(
        `adCloudinaryCleanup: shared-ref lookup failed (${err.message}) — keeping ${url}`
      );
    }
    return true;
  }
}

async function destroyUnsharedAdAssets(ad, opts = {}) {
  const { deleteFromCloudinary, publicIdFromUrl, deletePublicIdFromCloudinary } = loadCloudinary(opts);
  const urls = Array.isArray(opts.urls) ? opts.urls.filter(isCloudinaryHosted) : collectAdCloudinaryUrls(ad);
  const excludeAdId = opts.excludeAdId !== undefined ? opts.excludeAdId : (ad && ad._id);
  const campaignId = opts.campaignId !== undefined ? opts.campaignId : (ad && ad.campaignId);
  const brandId = opts.brandId !== undefined ? opts.brandId : (ad && ad.brandId);
  const keepPublicIds = opts.keepPublicIds instanceof Set ? opts.keepPublicIds : new Set();
  const keepUrls = opts.keepUrls instanceof Set ? opts.keepUrls : new Set();

  const classified = [];
  const protectedPids = new Set(keepPublicIds);

  for (const url of urls) {
    const parsed = publicIdFromUrl(url);
    const pidFromStored = parsed ? null : pidFallbackForUrl(url, ad);
    const pid = parsed || pidFromStored;

    if (keepUrls.has(url) || (pid && keepPublicIds.has(pid))) {
      classified.push({ url, pid, action: 'skip', reason: 'still-current-public-id' });
      if (pid) protectedPids.add(pid);
      continue;
    }

    // MONEY-CRITICAL shared-asset check runs for EVERY url BEFORE any
    // destroy, and BEFORE pid-dedup. Two URLs on this ad can share a
    // public_id while only one exact string is still referenced on a
    // sibling (versioned Cloudinary URLs). Checking after a first destroy
    // would let the unshared variant kill a pid the shared variant still
    // needs.
    const shared = await urlStillReferencedByOtherAd(url, {
      excludeAdId,
      campaignId,
      brandId,
      Ad: opts.Ad,
      onLookupError: opts.onLookupError
    });
    if (shared) {
      classified.push({ url, pid, action: 'skip', reason: 'still-referenced' });
      if (pid) protectedPids.add(pid);
      continue;
    }
    classified.push({ url, pid, parsed, pidFromStored, action: 'maybe-destroy' });
  }

  const gonePids = new Set();
  const results = [];
  for (const item of classified) {
    if (item.action === 'skip') {
      results.push({ url: item.url, result: 'skipped', reason: item.reason });
      continue;
    }
    if (item.pid && protectedPids.has(item.pid)) {
      results.push({ url: item.url, result: 'skipped', reason: 'same-public-id-still-referenced' });
      continue;
    }
    if (item.pid && gonePids.has(item.pid)) {
      results.push({ url: item.url, result: 'skipped', reason: 'duplicate-public-id' });
      continue;
    }

    if (typeof deleteFromCloudinary !== 'function' && typeof deletePublicIdFromCloudinary !== 'function') {
      results.push({ url: item.url, result: 'skipped', reason: 'no-destroy-fn' });
      continue;
    }

    let out;
    if (item.parsed && typeof deleteFromCloudinary === 'function') {
      out = await deleteFromCloudinary(item.url);
    } else if (item.pidFromStored && typeof deletePublicIdFromCloudinary === 'function') {
      out = await deletePublicIdFromCloudinary(item.pidFromStored, {
        resourceType: resourceTypeFor(item.url, ad)
      });
    } else {
      out = { result: 'skipped', reason: 'unparseable url', url: item.url };
    }
    if (item.pid && out && (out.result === 'ok' || out.result === 'not found')) {
      gonePids.add(item.pid);
    }
    results.push({ url: item.url, ...out });
  }
  return results;
}

async function destroyReplacedAdAssets({ previousAd, currentAd, ...opts } = {}) {
  const { publicIdFromUrl } = loadCloudinary(opts);
  const keepPublicIds = publicIdsHeldByAd(currentAd, publicIdFromUrl);
  const keepUrls = new Set();
  const titledKeep = previousTitledDeliveryToKeep(previousAd, currentAd);
  if (titledKeep) {
    keepUrls.add(titledKeep);
    const pid = publicIdFromUrl(titledKeep);
    if (pid) keepPublicIds.add(pid);
  }
  return destroyUnsharedAdAssets(previousAd, {
    ...opts,
    excludeAdId: (currentAd && currentAd._id) || (previousAd && previousAd._id),
    campaignId: opts.campaignId !== undefined
      ? opts.campaignId
      : ((currentAd && currentAd.campaignId) || (previousAd && previousAd.campaignId)),
    brandId: opts.brandId !== undefined
      ? opts.brandId
      : ((currentAd && currentAd.brandId) || (previousAd && previousAd.brandId)),
    keepPublicIds,
    keepUrls
  });
}

function summarizeCloudinaryCleanup(results) {
  const skippedShared = [];
  const destroyed = [];
  const notFound = [];
  const skipped = [];
  const errors = [];
  for (const r of results || []) {
    if (r.reason === 'still-referenced' || r.reason === 'same-public-id-still-referenced') {
      skippedShared.push(r.url);
    } else if (r.result === 'error') errors.push(r);
    else if (r.result === 'not found') notFound.push(r.url);
    else if (r.result === 'ok') destroyed.push(r.url);
    else if (r.result === 'skipped') skipped.push(r);
    else skipped.push(r);
  }
  return { results: results || [], skippedShared, destroyed, notFound, skipped, errors };
}

module.exports = {
  isCloudinaryHosted,
  cloudinaryAssetKey,
  isDerivedVideoPoster,
  collectAdCloudinaryUrls,
  snapshotAdCloudinaryState,
  buildSharedUrlFilter,
  urlStillReferencedByOtherAd,
  publicIdsHeldByAd,
  previousTitledDeliveryToKeep,
  destroyUnsharedAdAssets,
  destroyReplacedAdAssets,
  summarizeCloudinaryCleanup
};
