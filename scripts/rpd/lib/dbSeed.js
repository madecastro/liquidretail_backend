// scripts/rpd/lib/dbSeed.js — resolve a still seed + 2 catalog refs from Mongo.
//
// Feed-order cascade (pointer first, then feedIndex:0) is copied INLINE from
// firstCatalogMediaForProduct — do not require campaignAdsGenerationService
// (heavy graph) and NEVER enqueue detect/materialize. A miss is an honest
// throw. Mixed metadata.catalogProductId needs an ObjectId cast.

const mongoose = require('mongoose');
const CatalogProduct = require('../../../models/CatalogProduct');
const Brand = require('../../../models/Brand');
const Media = require('../../../models/Media');
const { sortCatalogMediasForReferenceStack } = require('../../../services/atlasVideoService');
const { websiteBackgroundHex } = require('../../../utils/websiteBackground');

// Union of the live seed + reference-stack projections.
const MEDIA_SELECT = '_id fileUrl fileType metadata createdAt source brandId';

function productOidFrom(productId) {
  try {
    return new mongoose.Types.ObjectId(String(productId));
  } catch (err) {
    throw new Error(`rpd: productId is not a valid ObjectId: ${productId}`);
  }
}

// Both video rejects from isCatalogMediaForProduct, plus empty fileUrl.
// firstCatalogMediaForProduct only filters fileType $ne video — harness
// applies the imageRole + URL checks the live helper leaves to callers.
function isUsableStill(doc) {
  if (!doc) return false;
  if (doc.fileType === 'video') return false;
  if (doc.metadata && doc.metadata.imageRole === 'video') return false;
  if (typeof doc.fileUrl !== 'string' || !doc.fileUrl.trim()) return false;
  return true;
}

// INLINE copy of campaignAdsGenerationService.firstCatalogMediaForProduct
// flag-ON arm. Tier 1 (imageMediaId) before the stamp is load-bearing:
// metadata.feedIndex is never cleared when a merchant replaces the primary.
// No third fallback.
async function firstCatalogMediaForProduct(productOid, imageMediaId) {
  if (imageMediaId) {
    const primary = await Media.findOne({
      _id: imageMediaId,
      source: 'catalog-product',
      'metadata.catalogProductId': productOid,
      fileType: { $ne: 'video' }
    }).select(MEDIA_SELECT).lean();
    if (primary) return primary;
  }
  return Media.findOne({
    source: 'catalog-product',
    'metadata.catalogProductId': productOid,
    'metadata.feedIndex': 0,
    fileType: { $ne: 'video' }
  }).sort({ createdAt: 1 }).select(MEDIA_SELECT).lean();
}

async function resolveSeedFromDb(productId) {
  if (!process.env.MONGODB_URI) {
    throw new Error('rpd: process.env.MONGODB_URI is required for DB seed mode');
  }
  if (productId == null || !String(productId).trim()) {
    throw new Error('rpd: productId is required');
  }
  const productOid = productOidFrom(productId);
  // The CLI disables command buffering so offline ledger writes fail fast
  // instead of holding the process open. This path DOES connect, so restore the
  // default — a query issued while the connection is still opening must queue,
  // not throw.
  mongoose.set('bufferCommands', true);
  await mongoose.connect(process.env.MONGODB_URI);
  try {
    const product = await CatalogProduct.findById(productOid)
      .select('title brandId imageMediaId imageUrl additionalImages')
      .lean();
    if (!product) {
      throw new Error(`rpd: CatalogProduct ${productId} not found`);
    }

    const brand = product.brandId
      ? await Brand.findById(product.brandId)
        .select('name websiteBackground primaryColor')
        .lean()
      : null;

    const seedDoc = await firstCatalogMediaForProduct(productOid, product.imageMediaId);
    if (!isUsableStill(seedDoc)) {
      throw new Error(
        `rpd: no usable still seed for product ${productId} ` +
        '(pointer + feedIndex:0 both missed or rejected as video/empty-url). ' +
        'The harness does not materialize catalog media.'
      );
    }

    const catalogMedias = await Media.find({
      source: 'catalog-product',
      'metadata.catalogProductId': productOid
    }).select(MEDIA_SELECT).lean();

    const seedId = String(seedDoc._id);
    const seedUrl = seedDoc.fileUrl.trim();
    // Dedupe by _id AND by URL: production's buildReferenceImages skips both
    // (two Media rows can mirror the same asset), and a duplicate would burn a
    // reference slot on an image the model already has.
    const seenUrls = new Set([seedUrl]);
    const refs = [];
    for (const doc of sortCatalogMediasForReferenceStack(catalogMedias)) {
      if (String(doc._id) === seedId) continue;
      if (!isUsableStill(doc)) continue;
      const url = doc.fileUrl.trim();
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      refs.push(url);
      if (refs.length === 2) break;
    }

    return {
      url: seedUrl,
      refs,
      productTitle: product.title || '',
      brandName: (brand && brand.name) || '',
      brandHex: websiteBackgroundHex(brand)
    };
  } finally {
    await mongoose.disconnect();
  }
}

module.exports = { resolveSeedFromDb };
