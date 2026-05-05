// Brand + Media cascade-delete services. Both delete:
//   - DB rows (brand-keyed or media-keyed children)
//   - Cloudinary assets (image/video bytes)
// and return per-collection counts so the UI can confirm what was nuked.
//
// Cloudinary deletion is fire-and-forget — we collect URLs before
// deleting DB rows (so the URL list survives), then kick off Cloudinary
// destroy in the background. The DB delete is the source of truth; if
// Cloudinary deletion fails, those orphan bytes can be cleaned up by a
// future janitor job. Conversely, completing DB delete before
// Cloudinary means there's no window where rows exist but their assets
// are gone.

const Brand                 = require('../models/Brand');
const Media                 = require('../models/Media');
const DetectRun             = require('../models/DetectRun');
const DetectionArtifact     = require('../models/DetectionArtifact');
const CropArtifact          = require('../models/CropArtifact');
const ExtendedCropArtifact  = require('../models/ExtendedCropArtifact');
const ProductMatchArtifact  = require('../models/ProductMatchArtifact');
const OverlayZoneArtifact   = require('../models/OverlayZoneArtifact');
const LayoutInputArtifact   = require('../models/LayoutInputArtifact');
const CatalogProduct        = require('../models/CatalogProduct');
const IntegrationCredential = require('../models/IntegrationCredential');
const Campaign              = require('../models/Campaign');
const Collection            = require('../models/Collection');
const { deleteManyFromCloudinary } = require('./cloudinaryService');

// ── Brand cascade ─────────────────────────────────────────────────────
//
// Order:
//   1. Collect Cloudinary URLs (Media files + CatalogProduct images +
//      Brand logo + Media metadata thumbnails) — must happen BEFORE
//      DB deletes so the URLs survive.
//   2. Delete media-keyed artifacts (parallel — they only depend on
//      mediaId, brand-direct deletes can race them).
//   3. Delete brand-direct collections (Media, CatalogProduct,
//      IntegrationCredential, Campaign) in parallel.
//   4. Delete the Brand itself.
//   5. Fire-and-forget Cloudinary cleanup with the collected URLs.

async function cascadeDeleteBrand(brandId) {
  const t0 = Date.now();
  // Tenant guard responsibility lives in the route. This service
  // assumes the brandId is already authorized.

  const brand = await Brand.findById(brandId).lean();
  if (!brand) return { ok: false, reason: 'brand not found' };

  // Step 1 — gather Cloudinary URLs.
  const cloudUrls = await collectBrandCloudUrls(brandId, brand);

  // Step 2 — delete media-keyed artifacts. We use brandId on the
  // artifact rows (added in the schema-hardening change) so we don't
  // have to first collect mediaIds. Backfill script seeds brandId on
  // pre-existing rows; new artifacts always carry it.
  const artifactCounts = {};
  await Promise.all([
    DetectRun.deleteMany({ brandId }).then(r              => artifactCounts.detectRuns         = r.deletedCount || 0),
    DetectionArtifact.deleteMany({ brandId }).then(r      => artifactCounts.detectionArtifacts = r.deletedCount || 0),
    CropArtifact.deleteMany({ brandId }).then(r           => artifactCounts.cropArtifacts      = r.deletedCount || 0),
    ExtendedCropArtifact.deleteMany({ brandId }).then(r   => artifactCounts.extendedCrops      = r.deletedCount || 0),
    ProductMatchArtifact.deleteMany({ brandId }).then(r   => artifactCounts.productMatches     = r.deletedCount || 0),
    OverlayZoneArtifact.deleteMany({ brandId }).then(r    => artifactCounts.overlayZones       = r.deletedCount || 0),
    LayoutInputArtifact.deleteMany({ brandId }).then(r    => artifactCounts.layoutInputs       = r.deletedCount || 0)
  ]);

  // Belt-and-suspenders for any pre-backfill rows that don't have
  // brandId yet — find Media for this brand and clean artifacts by
  // mediaId. Cheap second pass; usually a no-op once backfill ran.
  const mediaIds = await Media.find({ brandId }, { _id: 1 }).lean();
  const mediaIdList = mediaIds.map(m => m._id);
  if (mediaIdList.length) {
    const fallback = await Promise.all([
      DetectRun.deleteMany({ mediaId: { $in: mediaIdList } }),
      DetectionArtifact.deleteMany({ mediaId: { $in: mediaIdList } }),
      CropArtifact.deleteMany({ mediaId: { $in: mediaIdList } }),
      ExtendedCropArtifact.deleteMany({ mediaId: { $in: mediaIdList } }),
      ProductMatchArtifact.deleteMany({ mediaId: { $in: mediaIdList } }),
      OverlayZoneArtifact.deleteMany({ mediaId: { $in: mediaIdList } }),
      LayoutInputArtifact.deleteMany({ mediaId: { $in: mediaIdList } })
    ]);
    const fallbackTotal = fallback.reduce((s, r) => s + (r.deletedCount || 0), 0);
    if (fallbackTotal > 0) {
      console.log(`   · brand-cascade fallback (mediaId-keyed) cleaned ${fallbackTotal} legacy artifacts`);
    }
  }

  // Step 3 — brand-direct collections in parallel.
  const directCounts = {};
  await Promise.all([
    Media.deleteMany({ brandId }).then(r                 => directCounts.media                = r.deletedCount || 0),
    CatalogProduct.deleteMany({ brandId }).then(r        => directCounts.catalogProducts      = r.deletedCount || 0),
    IntegrationCredential.deleteMany({ brandId }).then(r => directCounts.integrationCreds     = r.deletedCount || 0),
    Campaign.deleteMany({ brandId }).then(r              => directCounts.campaigns            = r.deletedCount || 0),
    Collection.deleteMany({ brandId }).then(r            => directCounts.collections          = r.deletedCount || 0)
  ]);

  // Step 4 — Brand itself.
  const brandResult = await Brand.deleteOne({ _id: brandId });

  // Step 5 — fire-and-forget Cloudinary cleanup.
  const cloudUrlCount = cloudUrls.length;
  if (cloudUrlCount > 0) {
    deleteManyFromCloudinary(cloudUrls)
      .then(results => {
        const ok = results.filter(r => r.result === 'ok').length;
        const skipped = results.filter(r => r.result === 'skipped').length;
        const err = results.filter(r => r.result === 'error' || (r.result && r.result !== 'ok' && r.result !== 'skipped')).length;
        console.log(`   · brand-cascade cloudinary cleanup: ok=${ok} skipped=${skipped} err=${err} total=${cloudUrlCount}`);
      })
      .catch(err => console.warn(`   ⚠️  brand-cascade cloudinary cleanup failed: ${err.message}`));
  }

  console.log(`🗑️  brand-cascade done: brand=${brandId} (${brand.name}) media=${directCounts.media} cps=${directCounts.catalogProducts} creds=${directCounts.integrationCreds} campaigns=${directCounts.campaigns} artifacts=${Object.values(artifactCounts).reduce((s, n) => s + n, 0)} cloudUrls=${cloudUrlCount} in ${Date.now() - t0}ms`);

  return {
    ok: true,
    brandId,
    brandName:    brand.name,
    artifactCounts,
    directCounts,
    brandDeleted: brandResult.deletedCount === 1,
    cloudinaryQueued: cloudUrlCount,
    durationMs: Date.now() - t0
  };
}

// ── Media cascade ─────────────────────────────────────────────────────
//
// Order:
//   1. Load Media for URL collection (file + thumbnail) and to
//      verify it exists.
//   2. Delete media-keyed artifacts in parallel.
//   3. Delete Media itself.
//   4. Fire-and-forget Cloudinary cleanup.

async function cascadeDeleteMedia(mediaId) {
  const t0 = Date.now();

  const media = await Media.findById(mediaId).lean();
  if (!media) return { ok: false, reason: 'media not found' };

  const cloudUrls = collectMediaCloudUrls(media);

  const artifactCounts = {};
  await Promise.all([
    DetectRun.deleteMany({ mediaId }).then(r              => artifactCounts.detectRuns         = r.deletedCount || 0),
    DetectionArtifact.deleteMany({ mediaId }).then(r      => artifactCounts.detectionArtifacts = r.deletedCount || 0),
    CropArtifact.deleteMany({ mediaId }).then(r           => artifactCounts.cropArtifacts      = r.deletedCount || 0),
    ExtendedCropArtifact.deleteMany({ mediaId }).then(r   => artifactCounts.extendedCrops      = r.deletedCount || 0),
    ProductMatchArtifact.deleteMany({ mediaId }).then(r   => artifactCounts.productMatches     = r.deletedCount || 0),
    OverlayZoneArtifact.deleteMany({ mediaId }).then(r    => artifactCounts.overlayZones       = r.deletedCount || 0),
    LayoutInputArtifact.deleteMany({ mediaId }).then(r    => artifactCounts.layoutInputs       = r.deletedCount || 0)
  ]);

  // Phase A-3 — pull this mediaId out of any Collection that references
  // it. Bulk $pull is fast even with many collections; doc rewrite on
  // each match is unavoidable but the working set is small.
  const collectionPullRes = await Collection.updateMany(
    { mediaIds: mediaId },
    { $pull: { mediaIds: mediaId } }
  );

  const mediaResult = await Media.deleteOne({ _id: mediaId });

  if (cloudUrls.length > 0) {
    deleteManyFromCloudinary(cloudUrls)
      .then(results => {
        const ok = results.filter(r => r.result === 'ok').length;
        console.log(`   · media-cascade cloudinary cleanup: ok=${ok}/${cloudUrls.length}`);
      })
      .catch(err => console.warn(`   ⚠️  media-cascade cloudinary cleanup failed: ${err.message}`));
  }

  console.log(`🗑️  media-cascade done: media=${mediaId} artifacts=${Object.values(artifactCounts).reduce((s, n) => s + n, 0)} cloudUrls=${cloudUrls.length} collections=${collectionPullRes.modifiedCount || 0} in ${Date.now() - t0}ms`);

  return {
    ok: true,
    mediaId,
    artifactCounts,
    collectionsPulled: collectionPullRes.modifiedCount || 0,
    mediaDeleted: mediaResult.deletedCount === 1,
    cloudinaryQueued: cloudUrls.length,
    durationMs: Date.now() - t0
  };
}

// ── URL collection helpers ────────────────────────────────────────────

async function collectBrandCloudUrls(brandId, brand) {
  const urls = new Set();

  // Brand-level — logo + any other Cloudinary-hosted brand asset
  if (brand?.logoUrl) urls.add(brand.logoUrl);

  // Media files (and their thumbnails if stored)
  const media = await Media.find({ brandId }, { fileUrl: 1, 'metadata.thumbnailUrl': 1 }).lean();
  for (const m of media) {
    if (m.fileUrl) urls.add(m.fileUrl);
    const thumb = m.metadata?.thumbnailUrl;
    if (thumb && thumb !== m.fileUrl) urls.add(thumb);
  }

  // CatalogProduct images (manual-upload + detect-identified — only
  // these were uploaded to OUR Cloudinary; ig-catalog images live on
  // Meta's CDN and shouldn't be touched).
  const catalogProducts = await CatalogProduct.find(
    { brandId, source: { $in: ['manual-upload', 'detect-identified'] } },
    { imageUrl: 1, additionalImages: 1 }
  ).lean();
  for (const cp of catalogProducts) {
    if (cp.imageUrl && /res\.cloudinary\.com/.test(cp.imageUrl)) urls.add(cp.imageUrl);
    for (const img of (cp.additionalImages || [])) {
      if (img && /res\.cloudinary\.com/.test(img)) urls.add(img);
    }
  }

  return [...urls];
}

function collectMediaCloudUrls(media) {
  const urls = [];
  if (media.fileUrl) urls.push(media.fileUrl);
  const thumb = media.metadata?.thumbnailUrl;
  if (thumb && thumb !== media.fileUrl) urls.push(thumb);
  return urls;
}

module.exports = { cascadeDeleteBrand, cascadeDeleteMedia };
