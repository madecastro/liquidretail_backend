// Catalog-product → DetectRun trigger.
//
// Per the product-path design (Option C): hero gets the full
// trimmed pipeline (subjects+text → crops → judge → palette);
// alts get a stripped pass (crops + palette only). One wrapper
// Media doc per image so existing artifact collections (keyed by
// mediaId) fan out cleanly.
//
// Idempotency: if CatalogProduct.imageMediaId already exists and
// the wrapper Media's fileUrl matches the current hero, the trigger
// no-ops. To force a re-detect (e.g. brand re-uploaded the image at
// the same URL), an operator clears imageMediaId on the doc.
//
// Cost gate: alts are capped at MAX_ALT_IMAGES so a chatty catalog
// (e.g. Shopify's 10+ angle shots per SKU) doesn't blow up the bill.

const Media = require('../models/Media');
const DetectRun = require('../models/DetectRun');
const CatalogProduct = require('../models/CatalogProduct');
const { uploadUrlToCloudinary } = require('./cloudinaryService');
const { normalizeBrandName } = require('../models/Brand');

const MAX_ALT_IMAGES = 12;

// ── Public API ───────────────────────────────────────────────────────

// Enqueue the product-path detect pipeline for one CatalogProduct.
// Returns { enqueued: { hero, alts }, skipped: bool, reason? }.
async function enqueueProductDetect(product) {
  if (!product.imageUrl) {
    console.log(`   · catalog-product detect skip[${product._id}]: no hero imageUrl`);
    return { skipped: true, reason: 'product has no hero imageUrl' };
  }

  // Skip-if-already-attached. Re-runs are an explicit operator
  // action (clear imageMediaId on the CatalogProduct doc).
  if (product.imageMediaId) {
    return { skipped: true, reason: 'already detected (imageMediaId set)' };
  }

  console.log(
    `   · catalog-product detect enqueue[${product._id}]: ` +
    `"${(product.title || '').slice(0, 40)}" hero=1 alts=${(product.additionalImages || []).length}`
  );

  const enqueued = { hero: null, alts: [] };

  // Hero — full path.
  try {
    const heroMedia = await materializeImage({
      sourceUrl:    product.imageUrl,
      product,
      imageRole:    'hero'
    });
    if (heroMedia) {
      const run = await createDetectRunIfAbsent(heroMedia, product);
      if (run) enqueued.hero = { mediaId: String(heroMedia._id), runId: String(run._id) };
    }
  } catch (err) {
    console.warn(`⚠️  catalog-product[${product._id}] hero detect enqueue failed: ${err.message}`);
  }

  // Alts — stripped path. Capped + de-duped against hero URL.
  const altUrls = (product.additionalImages || [])
    .filter(u => u && u !== product.imageUrl)
    .slice(0, MAX_ALT_IMAGES);

  for (const altUrl of altUrls) {
    try {
      const altMedia = await materializeImage({
        sourceUrl:    altUrl,
        product,
        imageRole:    'alt'
      });
      if (altMedia) {
        const run = await createDetectRunIfAbsent(altMedia, product);
        if (run) enqueued.alts.push({ mediaId: String(altMedia._id), runId: String(run._id) });
      }
    } catch (err) {
      console.warn(`⚠️  catalog-product[${product._id}] alt detect enqueue failed: ${err.message}`);
    }
  }

  // Stamp the wrapper ids onto the CatalogProduct so future re-syncs
  // skip and so visualCatalogMatchService can fan out across all
  // image variants when matching UGC against this product.
  await CatalogProduct.updateOne(
    { _id: product._id },
    {
      imageMediaId:            enqueued.hero?.mediaId || null,
      additionalImageMediaIds: enqueued.alts.map(a => a.mediaId)
    }
  );

  return { enqueued };
}

// Bulk wrapper — fire enqueueProductDetect for the primary variant of
// each product group. Used by catalogSyncService at the end of a sync
// pass.
//
// Variant collapse: Shopify-via-Meta returns each size/color variant
// as a distinct catalog row (e.g. 8 sizes of "HCO Original" = 8 rows
// sharing the same hero image). Without dedup we'd pay for detect on
// every variant. We group by itemGroupId when Meta provides it, and
// fall back to nameNormalized when it doesn't. Within each group we
// pick a primary (most images, tiebreak lowest externalId) and only
// the primary runs detect. The rest get isPrimaryVariant=false and
// stay query-visible for commerce; downstream matchers should filter
// to primaries to avoid scoring the same image across variants.
async function enqueueBrandProductDetects(brandId) {
  const products = await CatalogProduct.find({
    brandId,
    imageUrl: { $ne: null }
  }).lean();

  // Group → primary selection. We also track which primary each non-
  // primary belongs to so we can stamp primaryProductId atomically
  // (needed for matchedMedia inheritance + catalog browser matchCount
  // $lookup on non-primary cards).
  const groups = groupProductsForDetect(products);
  const primaries        = [];
  const variantsByPrimary = new Map();   // primary._id (string) → [variant._id, ...]
  for (const group of groups.values()) {
    const primary = pickPrimary(group);
    primaries.push(primary);
    const variantIds = [];
    for (const p of group) {
      if (String(p._id) !== String(primary._id)) variantIds.push(p._id);
    }
    if (variantIds.length) variantsByPrimary.set(String(primary._id), variantIds);
  }

  // Stamp the variant role so the match service + UI can join on it.
  // Done before enqueue so a partial-failure run still leaves the flag
  // set consistently. Primaries also get primaryProductId cleared (in
  // case a row previously belonged to a different family — e.g. after
  // a title rename).
  if (primaries.length) {
    await CatalogProduct.updateMany(
      { _id: { $in: primaries.map(p => p._id) } },
      { $set: { isPrimaryVariant: true, primaryProductId: null } }
    );
  }
  // Per-family bulkWrite so each non-primary points at the right primary.
  if (variantsByPrimary.size) {
    const bulkOps = [];
    for (const [primaryId, variantIds] of variantsByPrimary.entries()) {
      bulkOps.push({
        updateMany: {
          filter: { _id: { $in: variantIds } },
          update: { $set: { isPrimaryVariant: false, primaryProductId: primaryId } }
        }
      });
    }
    await CatalogProduct.bulkWrite(bulkOps, { ordered: false });
  }

  // Only primaries that haven't been detected yet need an enqueue
  // call. Already-detected primaries no-op via the imageMediaId check
  // inside enqueueProductDetect.
  let heroEnqueued = 0;
  let altEnqueued  = 0;
  let skipped      = 0;
  for (const p of primaries) {
    if (p.imageMediaId) { skipped++; continue; }
    const r = await enqueueProductDetect(p);
    if (r.skipped) { skipped++; continue; }
    if (r.enqueued?.hero) heroEnqueued++;
    altEnqueued += r.enqueued?.alts?.length || 0;
  }

  console.log(
    `📦 catalog-product detect — brand=${brandId} ` +
    `groups=${groups.size} primaries=${primaries.length} variants=${nonPrimaries.length} ` +
    `heroes=${heroEnqueued} alts=${altEnqueued} skipped=${skipped} (rows ${products.length})`
  );
  return {
    heroEnqueued, altEnqueued, skipped,
    groups:    groups.size,
    primaries: primaries.length,
    variants:  nonPrimaries.length,
    total:     products.length
  };
}

// Group products by (itemGroupId || nameNormalized(title)). Returns a
// Map<groupKey, products[]>. nameNormalized is the fallback when Meta
// doesn't expose item_group_id (some merchants don't model variants
// as groups in the catalog).
function groupProductsForDetect(products) {
  const groups = new Map();
  for (const p of products) {
    const key = p.itemGroupId
      ? `group:${p.itemGroupId}`
      : `title:${normalizeBrandName(p.title || '')}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  return groups;
}

// Primary = the variant most useful to run detect on. Most images
// first (richer hero candidates, more alts), tiebreak by lowest
// externalId for determinism across re-syncs.
function pickPrimary(group) {
  return [...group].sort((a, b) => {
    const ai = (a.additionalImages || []).length;
    const bi = (b.additionalImages || []).length;
    if (bi !== ai) return bi - ai;
    return String(a.externalId).localeCompare(String(b.externalId));
  })[0];
}

// Create a DetectRun for this Media only if one isn't already in-flight.
// The DetectRun model's partial unique index on (mediaId, status in
// queued/processing) makes concurrent .create() calls hit E11000;
// we swallow that and return the existing in-flight run instead.
// Net effect: at most one in-flight DetectRun per Media, regardless of
// how many sync paths race to enqueue it.
async function createDetectRunIfAbsent(media, product) {
  try {
    return await DetectRun.create({
      advertiserId: product.advertiserId,
      brandId:      product.brandId,
      mediaId:      media._id,
      trigger:      'catalog-sync'
    });
  } catch (err) {
    if (err.code === 11000) {
      // Concurrent enqueue beat us to it. Return the existing in-flight run.
      const existing = await DetectRun.findOne({
        mediaId: media._id,
        status:  { $in: ['queued', 'processing'] }
      }).lean();
      if (existing) {
        console.log(`   · catalog-product[${product._id}] detect already enqueued for ${media._id} — skipping duplicate`);
        return existing;
      }
      return null;
    }
    throw err;
  }
}

// ── Internals ───────────────────────────────────────────────────────

// Mirror the source URL to Cloudinary (so the source's CDN expiry
// doesn't break the index later) and create a wrapper Media doc.
// Idempotent: when a Media with the synthetic externalId already
// exists (re-sync, concurrent enqueue, scheduler-overlap), return
// the existing doc instead of E11000-ing on the
// (brandId, source, externalId) unique index. Brand-scoped so a
// different brand's catalog with a coincidentally-matching synthetic
// id can't collide.
async function materializeImage({ sourceUrl, product, imageRole }) {
  const externalId = `cp_${product._id}_${imageRole}_${hashShort(sourceUrl)}`;

  // Fast path — if the Media doc already exists, skip the Cloudinary
  // mirror (expensive) and return it. The mirror is best-effort
  // anyway; a prior successful pass already paid for it.
  const existing = await Media.findOne({ brandId: product.brandId, source: 'catalog-product', externalId });
  if (existing) return existing;

  let mirroredUrl;
  try {
    const result = await uploadUrlToCloudinary(sourceUrl, {
      folder: `catalog-product/${product.brandId}`
    });
    mirroredUrl = result.secure_url || result.url;
  } catch (err) {
    // Mirroring is best-effort — fall back to the source URL if
    // Cloudinary's free tier is exhausted or the upload errored.
    // Detect can still run against the source URL.
    console.warn(`   ⚠️  Cloudinary mirror failed (${product._id} ${imageRole}): ${err.message}`);
    mirroredUrl = sourceUrl;
  }

  try {
    return await Media.create({
      advertiserId: product.advertiserId,
      brandId:      product.brandId,
      source:       'catalog-product',
      externalId,
      fileType:     'image',
      fileUrl:      mirroredUrl,
      metadata: {
        catalogProductId: product._id,
        imageRole,                              // 'hero' | 'alt'
        brand:            product.brand || null,
        category:         product.category || null,
        productTitle:     product.title || null
      }
    });
  } catch (err) {
    // Lost the race to a concurrent caller — the Media doc was
    // inserted between our findOne and create. Re-fetch and return.
    if (err.code === 11000) {
      return await Media.findOne({ brandId: product.brandId, source: 'catalog-product', externalId });
    }
    throw err;
  }
}

// Fill in the gaps in additionalImageMediaIds for an existing product.
// Materializes a catalog-product Media doc for every additionalImages[i]
// that doesn't yet have a corresponding entry, in parallel. Used by the
// catalog detail endpoint as a lazy backfill so the picker tile is
// always clickable (independent selection requires imageMediaId). Safe
// to call repeatedly — materializeImage is idempotent via the
// (brandId, source, externalId) unique index. No-op when nothing's
// missing. Returns the final additionalImageMediaIds array.
async function materializeMissingAlts(product) {
  const urls = Array.isArray(product.additionalImages) ? product.additionalImages : [];
  const ids  = Array.isArray(product.additionalImageMediaIds) ? product.additionalImageMediaIds : [];
  if (!urls.length) return ids;
  // Cap the lazy backfill at MAX_ALT_IMAGES so a catalog row with 50
  // alts doesn't trigger 50 Cloudinary round-trips on one detail fetch.
  const cappedUrls = urls.slice(0, MAX_ALT_IMAGES);
  // Index-aligned: keep existing ids in place, only materialize where
  // the slot is empty/missing.
  const indicesNeedingFill = [];
  for (let i = 0; i < cappedUrls.length; i++) {
    if (!cappedUrls[i]) continue;
    if (cappedUrls[i] === product.imageUrl) continue;       // dedupe against hero
    if (ids[i]) continue;
    indicesNeedingFill.push(i);
  }
  if (!indicesNeedingFill.length) return ids;

  const results = await Promise.allSettled(
    indicesNeedingFill.map(i =>
      materializeImage({ sourceUrl: cappedUrls[i], product, imageRole: 'alt' })
        .then(m => ({ i, mediaId: m?._id ? String(m._id) : null }))
        .catch(err => {
          console.warn(`   ⚠️  materializeMissingAlts[${product._id}][${i}]: ${err.message}`);
          return { i, mediaId: null };
        })
    )
  );
  const newIds = [...ids];
  for (const r of results) {
    if (r.status !== 'fulfilled' || !r.value?.mediaId) continue;
    newIds[r.value.i] = r.value.mediaId;
  }
  // Persist the filled-in array. updateOne so we don't fight Mongoose
  // versioning on a lean doc.
  await CatalogProduct.updateOne(
    { _id: product._id },
    { $set: { additionalImageMediaIds: newIds } }
  );
  return newIds;
}

function hashShort(s) {
  // Tiny non-crypto hash, just for distinguishing image URLs in the
  // synthetic externalId. Stable across calls so re-imports don't
  // generate new ids for the same image.
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36).slice(0, 8);
}

module.exports = { enqueueProductDetect, enqueueBrandProductDetects, materializeMissingAlts, MAX_ALT_IMAGES };
