// Operator-driven UGC-ads attachments (Phase 1, 2026-08-10). See
// server/docs/UGC_ADS_DESIGN.md and the schema comments on
// Media.matchedProducts / matchedCategories / brandingAssignment /
// promotionalAssignment.
//
// Contract: every attach() writes an entry with source='operator' so
// the detect write path (which $pull's on source:'detect') leaves it
// alone. Every detach() targets source:'operator' rows so an operator
// action never removes a detect-derived match — the operator must
// explicitly retag or the detect result stands.
//
// TENANCY: caller passes req.advertiserId; service verifies the
// target (product / category) belongs to the caller's advertiser
// before writing. Cross-tenant attach is impossible.

'use strict';

const mongoose = require('mongoose');
const Media          = require('../models/Media');
const CatalogProduct = require('../models/CatalogProduct');
const Category       = require('../models/Category');

async function assertMediaOwned(mediaId, advertiserId) {
  const media = await Media.findOne({ _id: mediaId, advertiserId })
    .select('_id brandId').lean();
  if (!media) return null;
  return media;
}

async function assertProductOwned(productId, advertiserId) {
  const product = await CatalogProduct.findOne({ _id: productId, advertiserId })
    .select('_id brandId title').lean();
  if (!product) return null;
  return product;
}

async function assertCategoryOwned(categoryId, advertiserId) {
  const category = await Category.findOne({ _id: categoryId, advertiserId })
    .select('_id brandId name breadcrumbKey').lean();
  if (!category) return null;
  return category;
}

// ─────────────────────────────────────────────────────────────────
// ATTACH — one Media to one target
// ─────────────────────────────────────────────────────────────────

async function attachProduct({ mediaId, productId, advertiserId, assignedBy }) {
  const media   = await assertMediaOwned(mediaId, advertiserId);
  if (!media) return { ok: false, error: `media ${mediaId} not found`, code: 'MEDIA_NOT_FOUND' };
  const product = await assertProductOwned(productId, advertiserId);
  if (!product) return { ok: false, error: `product ${productId} not found`, code: 'PRODUCT_NOT_FOUND' };

  const now = new Date();
  const entry = {
    catalogProductId:        product._id,
    matchKind:               'catalog',
    outcome:                 'product_match',
    confidence:              1.0,   // operator asserted — top confidence
    source:                  'operator',
    assignedAt:              now,
    assignedBy:              assignedBy || null,
    refinedProductId:        null,
    matchEvidenceArtifactId: null
  };

  // Remove any prior operator entry for this same product on this
  // media, then push. Idempotent — re-attach = refresh assignedAt.
  await Media.updateOne(
    { _id: media._id },
    { $pull: { matchedProducts: { catalogProductId: product._id, source: 'operator' } } }
  );
  await Media.updateOne(
    { _id: media._id },
    { $push: { matchedProducts: entry } }
  );

  // Bidirectional mirror — CatalogProduct.matchedMedia gets the
  // operator entry too so downstream product-page consumers see the
  // UGC. Same idempotent pattern.
  const invEntry = {
    mediaId:                 media._id,
    matchTier:               'product_match',
    confidence:              1.0,
    refinedProductId:        null,
    matchEvidenceArtifactId: null,
    matchedAt:               now,
    source:                  'operator',
    assignedAt:              now,
    assignedBy:              assignedBy || null
  };
  await CatalogProduct.updateOne(
    { _id: product._id },
    { $pull: { matchedMedia: { mediaId: media._id, source: 'operator' } } }
  );
  await CatalogProduct.updateOne(
    { _id: product._id },
    { $push: { matchedMedia: invEntry } }
  );

  return {
    ok: true,
    mediaId: String(media._id),
    productId: String(product._id),
    productTitle: product.title,
    assignedAt: now
  };
}

async function attachCategory({ mediaId, categoryId, advertiserId, assignedBy }) {
  const media = await assertMediaOwned(mediaId, advertiserId);
  if (!media) return { ok: false, error: `media ${mediaId} not found`, code: 'MEDIA_NOT_FOUND' };
  const category = await assertCategoryOwned(categoryId, advertiserId);
  if (!category) return { ok: false, error: `category ${categoryId} not found`, code: 'CATEGORY_NOT_FOUND' };

  const now = new Date();
  const entry = {
    categoryId:              category._id,
    refinedProductId:        null,
    confidence:              1.0,
    matchEvidenceArtifactId: null,
    source:                  'operator',
    assignedAt:              now,
    assignedBy:              assignedBy || null
  };

  await Media.updateOne(
    { _id: media._id },
    { $pull: { matchedCategories: { categoryId: category._id, source: 'operator' } } }
  );
  await Media.updateOne(
    { _id: media._id },
    { $push: { matchedCategories: entry } }
  );

  return {
    ok: true,
    mediaId: String(media._id),
    categoryId: String(category._id),
    categoryName: category.name,
    breadcrumbKey: category.breadcrumbKey || null,
    assignedAt: now
  };
}

async function attachBranding({ mediaId, advertiserId, assignedBy }) {
  const media = await assertMediaOwned(mediaId, advertiserId);
  if (!media) return { ok: false, error: `media ${mediaId} not found`, code: 'MEDIA_NOT_FOUND' };

  const now = new Date();
  await Media.updateOne(
    { _id: media._id },
    { $set: {
        'brandingAssignment.assignedAt': now,
        'brandingAssignment.assignedBy': assignedBy || null
    } }
  );

  return { ok: true, mediaId: String(media._id), assignedAt: now };
}

async function attachPromotional({ mediaId, productIds = [], advertiserId, assignedBy }) {
  const media = await assertMediaOwned(mediaId, advertiserId);
  if (!media) return { ok: false, error: `media ${mediaId} not found`, code: 'MEDIA_NOT_FOUND' };

  // Verify every optional product callout belongs to the caller's
  // advertiser. A foreign productId in the array is rejected outright
  // rather than silently dropped — the operator needs to know.
  const productOids = [];
  for (const pid of (productIds || [])) {
    if (!mongoose.isValidObjectId(pid)) {
      return { ok: false, error: `productIds contains invalid ObjectId "${pid}"`, code: 'BAD_PRODUCT_ID' };
    }
    const product = await assertProductOwned(pid, advertiserId);
    if (!product) return { ok: false, error: `productIds includes ${pid} which is not under this advertiser`, code: 'PRODUCT_NOT_FOUND' };
    productOids.push(product._id);
  }

  const now = new Date();
  await Media.updateOne(
    { _id: media._id },
    { $set: {
        'promotionalAssignment.assignedAt': now,
        'promotionalAssignment.assignedBy': assignedBy || null,
        'promotionalAssignment.productIds': productOids
    } }
  );

  return { ok: true, mediaId: String(media._id), assignedAt: now, productIds: productOids.map(String) };
}

// ─────────────────────────────────────────────────────────────────
// DETACH — remove an operator attachment
// ─────────────────────────────────────────────────────────────────

async function detachProduct({ mediaId, productId, advertiserId }) {
  const media = await assertMediaOwned(mediaId, advertiserId);
  if (!media) return { ok: false, error: `media ${mediaId} not found`, code: 'MEDIA_NOT_FOUND' };
  if (!mongoose.isValidObjectId(productId)) {
    return { ok: false, error: `invalid productId`, code: 'BAD_PRODUCT_ID' };
  }
  const oid = new mongoose.Types.ObjectId(productId);

  const mediaRes = await Media.updateOne(
    { _id: media._id },
    { $pull: { matchedProducts: { catalogProductId: oid, source: 'operator' } } }
  );
  // Inverse detach — operator entry in CatalogProduct.matchedMedia
  const productRes = await CatalogProduct.updateOne(
    { _id: oid },
    { $pull: { matchedMedia: { mediaId: media._id, source: 'operator' } } }
  );

  return {
    ok: true,
    mediaId: String(media._id),
    productId,
    mediaModified: mediaRes.modifiedCount > 0,
    productModified: productRes.modifiedCount > 0
  };
}

async function detachCategory({ mediaId, categoryId, advertiserId }) {
  const media = await assertMediaOwned(mediaId, advertiserId);
  if (!media) return { ok: false, error: `media ${mediaId} not found`, code: 'MEDIA_NOT_FOUND' };
  if (!mongoose.isValidObjectId(categoryId)) {
    return { ok: false, error: `invalid categoryId`, code: 'BAD_CATEGORY_ID' };
  }
  const oid = new mongoose.Types.ObjectId(categoryId);

  const res = await Media.updateOne(
    { _id: media._id },
    { $pull: { matchedCategories: { categoryId: oid, source: 'operator' } } }
  );
  return {
    ok: true,
    mediaId: String(media._id),
    categoryId,
    modified: res.modifiedCount > 0
  };
}

async function detachBranding({ mediaId, advertiserId }) {
  const media = await assertMediaOwned(mediaId, advertiserId);
  if (!media) return { ok: false, error: `media ${mediaId} not found`, code: 'MEDIA_NOT_FOUND' };

  const res = await Media.updateOne(
    { _id: media._id },
    { $unset: { brandingAssignment: '' } }
  );
  return { ok: true, mediaId: String(media._id), modified: res.modifiedCount > 0 };
}

async function detachPromotional({ mediaId, advertiserId }) {
  const media = await assertMediaOwned(mediaId, advertiserId);
  if (!media) return { ok: false, error: `media ${mediaId} not found`, code: 'MEDIA_NOT_FOUND' };

  const res = await Media.updateOne(
    { _id: media._id },
    { $unset: { promotionalAssignment: '' } }
  );
  return { ok: true, mediaId: String(media._id), modified: res.modifiedCount > 0 };
}

// ─────────────────────────────────────────────────────────────────
// LIST — enumerate every attachment on a Media (both provenances)
// ─────────────────────────────────────────────────────────────────

async function listAssignments({ mediaId, advertiserId }) {
  const media = await Media.findOne({ _id: mediaId, advertiserId })
    .select('_id brandId matchedProducts matchedCategories brandingAssignment promotionalAssignment classification.socialPostType source fileType fileUrl externalId')
    .lean();
  if (!media) return { ok: false, error: `media ${mediaId} not found`, code: 'MEDIA_NOT_FOUND' };

  const productIds = [...new Set(
    (media.matchedProducts || [])
      .map((mp) => mp.catalogProductId)
      .filter(Boolean)
      .map(String)
  )];
  const categoryIds = [...new Set(
    (media.matchedCategories || [])
      .map((mc) => mc.categoryId)
      .filter(Boolean)
      .map(String)
  )];

  const [products, categories] = await Promise.all([
    productIds.length
      ? CatalogProduct.find({ _id: { $in: productIds }, advertiserId })
          .select('_id title imageUrl price currency').lean()
      : [],
    categoryIds.length
      ? Category.find({ _id: { $in: categoryIds }, advertiserId })
          .select('_id name breadcrumbKey').lean()
      : []
  ]);
  const productById  = new Map(products.map((p) => [String(p._id), p]));
  const categoryById = new Map(categories.map((c) => [String(c._id), c]));

  const productAttachments = (media.matchedProducts || []).map((mp) => {
    const p = productById.get(String(mp.catalogProductId || ''));
    return {
      catalogProductId: mp.catalogProductId ? String(mp.catalogProductId) : null,
      title:            p?.title || null,
      imageUrl:         p?.imageUrl || null,
      price:            p?.price ?? null,
      currency:         p?.currency || null,
      source:           mp.source || 'detect',
      confidence:       mp.confidence,
      outcome:          mp.outcome,
      assignedAt:       mp.assignedAt || null,
      assignedBy:       mp.assignedBy || null
    };
  });
  const categoryAttachments = (media.matchedCategories || []).map((mc) => {
    const c = categoryById.get(String(mc.categoryId || ''));
    return {
      categoryId:    mc.categoryId ? String(mc.categoryId) : null,
      name:          c?.name || null,
      breadcrumbKey: c?.breadcrumbKey || null,
      source:        mc.source || 'detect',
      confidence:    mc.confidence,
      assignedAt:    mc.assignedAt || null,
      assignedBy:    mc.assignedBy || null
    };
  });

  return {
    ok: true,
    media: {
      _id:            String(media._id),
      brandId:        media.brandId ? String(media.brandId) : null,
      source:         media.source,
      fileType:       media.fileType,
      fileUrl:        media.fileUrl,
      externalId:     media.externalId,
      socialPostType: media.classification?.socialPostType || null
    },
    products:   productAttachments,
    categories: categoryAttachments,
    branding: media.brandingAssignment?.assignedAt
      ? { assignedAt: media.brandingAssignment.assignedAt, assignedBy: media.brandingAssignment.assignedBy || null }
      : null,
    promotional: media.promotionalAssignment?.assignedAt
      ? {
          assignedAt: media.promotionalAssignment.assignedAt,
          assignedBy: media.promotionalAssignment.assignedBy || null,
          productIds: (media.promotionalAssignment.productIds || []).map(String)
        }
      : null,
    counts: {
      operatorProducts:   productAttachments.filter((p) => p.source === 'operator').length,
      detectProducts:     productAttachments.filter((p) => p.source === 'detect').length,
      operatorCategories: categoryAttachments.filter((c) => c.source === 'operator').length,
      detectCategories:   categoryAttachments.filter((c) => c.source === 'detect').length,
      branding:           media.brandingAssignment?.assignedAt ? 1 : 0,
      promotional:        media.promotionalAssignment?.assignedAt ? 1 : 0
    }
  };
}

module.exports = {
  attachProduct,
  attachCategory,
  attachBranding,
  attachPromotional,
  detachProduct,
  detachCategory,
  detachBranding,
  detachPromotional,
  listAssignments
};
