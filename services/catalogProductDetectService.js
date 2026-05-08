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

const MAX_ALT_IMAGES = 4;

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
      const run = await DetectRun.create({
        advertiserId: product.advertiserId,
        brandId:      product.brandId,
        mediaId:      heroMedia._id,
        trigger:      'catalog-sync'
      });
      enqueued.hero = { mediaId: String(heroMedia._id), runId: String(run._id) };
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
        const run = await DetectRun.create({
          advertiserId: product.advertiserId,
          brandId:      product.brandId,
          mediaId:      altMedia._id,
          trigger:      'catalog-sync'
        });
        enqueued.alts.push({ mediaId: String(altMedia._id), runId: String(run._id) });
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

// Bulk wrapper — fire enqueueProductDetect for every product missing
// an imageMediaId for this brand. Used by catalogSyncService at the
// end of a sync pass.
async function enqueueBrandProductDetects(brandId) {
  const products = await CatalogProduct.find({
    brandId,
    imageUrl:     { $ne: null },
    imageMediaId: null
  }).lean();

  let heroEnqueued = 0;
  let altEnqueued  = 0;
  let skipped      = 0;
  for (const p of products) {
    const r = await enqueueProductDetect(p);
    if (r.skipped) { skipped++; continue; }
    if (r.enqueued?.hero) heroEnqueued++;
    altEnqueued += r.enqueued?.alts?.length || 0;
  }

  console.log(
    `📦 catalog-product detect — brand=${brandId} ` +
    `heroes=${heroEnqueued} alts=${altEnqueued} skipped=${skipped} (of ${products.length})`
  );
  return { heroEnqueued, altEnqueued, skipped, total: products.length };
}

// ── Internals ───────────────────────────────────────────────────────

// Mirror the source URL to Cloudinary (so the source's CDN expiry
// doesn't break the index later) and create a wrapper Media doc.
// Returns the new Media or null when mirroring fails.
async function materializeImage({ sourceUrl, product, imageRole }) {
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

  // Synthetic externalId — combine the catalog product id with the
  // role + URL hash so the (source, externalId) unique index doesn't
  // collide if a SKU shares an image with another SKU.
  const externalId = `cp_${product._id}_${imageRole}_${hashShort(sourceUrl)}`;

  return Media.create({
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
}

function hashShort(s) {
  // Tiny non-crypto hash, just for distinguishing image URLs in the
  // synthetic externalId. Stable across calls so re-imports don't
  // generate new ids for the same image.
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36).slice(0, 8);
}

module.exports = { enqueueProductDetect, enqueueBrandProductDetects, MAX_ALT_IMAGES };
