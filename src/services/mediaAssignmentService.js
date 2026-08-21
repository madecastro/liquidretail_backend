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
// TENANCY (corrected 2026-08-20 — this comment used to claim
// "cross-tenant attach is impossible", which was true only for
// ADVERTISER tenancy and false for BRAND tenancy: one advertiser can
// own many brands, see models/Brand.js's {advertiserId, nameNormalized}
// unique index, and CatalogProduct/Category both require a brandId).
// req.advertiserId is the ONLY tenant scope Express attaches to a
// request in this codebase — there is no req.brandId anywhere, so no
// route or agent call can hand this service a pre-validated brand.
// assertMediaOwned loads the Media row by {_id, advertiserId} only;
// that row's OWN brandId is then the brand source of truth for the
// rest of the call. assertProductOwned / assertCategoryOwned take that
// brandId as a required argument and FAIL CLOSED — a falsy brandId
// returns null with NO query run at all, never an advertiser-only
// fallback. attachProduct / attachCategory / attachPromotional refuse
// with code MEDIA_BRAND_UNDETERMINABLE (a 400, never the 404
// MEDIA_NOT_FOUND gets) when the Media row itself has no brandId
// (legacy media predates brand tagging — see models/Media.js). Net
// effect: attach is scoped to {_id, advertiserId, brandId}, so a
// same-advertiser different-brand product/category is now rejected
// exactly like a different-advertiser one always was.
// Media-only ops (attachBranding, detachBranding, detachCategory,
// detachPromotional) have no second brand-owned resource to check and
// are unaffected. Forward-only: this does not remediate any
// pre-existing cross-brand row.

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

async function assertProductOwned(productId, advertiserId, brandId) {
  // FAIL CLOSED (same idiom as catalogProductDetectService.ensureDetectForProducts
  // — PR #257). A brandId-less query would admit any same-advertiser
  // CatalogProduct, including a different brand — exactly the shape
  // PR #245 / PR #257 exist to prevent elsewhere. Callers must resolve a
  // real brandId (from the Media row) before calling this; a null here
  // is deliberately indistinguishable from not-found (no existence leak).
  if (!brandId) return null;
  const product = await CatalogProduct.findOne({ _id: productId, advertiserId, brandId })
    .select('_id brandId title').lean();
  if (!product) return null;
  return product;
}

async function assertCategoryOwned(categoryId, advertiserId, brandId) {
  // FAIL CLOSED — see assertProductOwned. Never run an advertiser-only
  // Category query: one advertiser can own multiple brands.
  if (!brandId) return null;
  const category = await Category.findOne({ _id: categoryId, advertiserId, brandId })
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
  // FAIL CLOSED. Do not fall through to an advertiser-only product
  // check — that is the leak (a same-advertiser, different-brand
  // CatalogProduct written onto this Media). Distinct code so
  // routes/media.js does not 404 this (only MEDIA_NOT_FOUND is 404).
  if (!media.brandId) {
    return {
      ok: false,
      error: `media ${mediaId} has no brandId; cannot attach without a brand scope`,
      code: 'MEDIA_BRAND_UNDETERMINABLE'
    };
  }
  const product = await assertProductOwned(productId, advertiserId, media.brandId);
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
  // Filter repeats the ownership proof (advertiser + this Media's
  // brand, already established above) so a TOCTOU between the assert
  // and this write cannot retarget a different-brand product.
  await CatalogProduct.updateOne(
    { _id: product._id, advertiserId, brandId: media.brandId },
    { $pull: { matchedMedia: { mediaId: media._id, source: 'operator' } } }
  );
  await CatalogProduct.updateOne(
    { _id: product._id, advertiserId, brandId: media.brandId },
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
  // FAIL CLOSED — see attachProduct's identical guard.
  if (!media.brandId) {
    return {
      ok: false,
      error: `media ${mediaId} has no brandId; cannot attach without a brand scope`,
      code: 'MEDIA_BRAND_UNDETERMINABLE'
    };
  }
  const category = await assertCategoryOwned(categoryId, advertiserId, media.brandId);
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
  // FAIL CLOSED on the whole call — do not skip the brand check just
  // because productIds is empty, and do not silently drop a foreign
  // product from a non-empty array instead of refusing outright.
  if (!media.brandId) {
    return {
      ok: false,
      error: `media ${mediaId} has no brandId; cannot attach without a brand scope`,
      code: 'MEDIA_BRAND_UNDETERMINABLE'
    };
  }

  // Verify every optional product callout belongs to the caller's
  // advertiser AND this Media's brand. A foreign productId in the
  // array is rejected outright rather than silently dropped — the
  // operator needs to know.
  const productOids = [];
  for (const pid of (productIds || [])) {
    if (!mongoose.isValidObjectId(pid)) {
      return { ok: false, error: `productIds contains invalid ObjectId "${pid}"`, code: 'BAD_PRODUCT_ID' };
    }
    const product = await assertProductOwned(pid, advertiserId, media.brandId);
    if (!product) return { ok: false, error: `productIds includes ${pid} which is not under this advertiser's brand`, code: 'PRODUCT_NOT_FOUND' };
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
  // Inverse detach — operator entry in CatalogProduct.matchedMedia.
  // Previously this write carried NO advertiserId/brandId filter at
  // all (any well-formed ObjectId was written against, unlike every
  // other write in this file). advertiserId is now always applied;
  // brandId is applied too when this Media row has one (legacy
  // brandId-less Media must not turn into a `{ brandId: null }` clause
  // — CatalogProduct.brandId is required:true, so that would just
  // match nothing and silently no-op the cleanup). This can only ever
  // narrow which document the $pull targets, never widen it — _id is
  // already unique.
  const productFilter = { _id: oid, advertiserId };
  if (media.brandId) productFilter.brandId = media.brandId;
  const productRes = await CatalogProduct.updateOne(
    productFilter,
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

  // Defense in depth / display hygiene: a pre-existing cross-brand
  // attachment (legacy, or anything the write-side fix above does not
  // retroactively touch — this file is forward-only) should not have
  // its title/price hydrated here. Mirrors the brandId clause
  // GET /:mediaId/related-products already applies in this same
  // routes/media.js file. Only applied when media.brandId is truthy —
  // legacy brandless Media (models/Media.js) keeps hydrating exactly
  // as before.
  const productQuery  = { _id: { $in: productIds },  advertiserId };
  const categoryQuery = { _id: { $in: categoryIds }, advertiserId };
  if (media.brandId) {
    productQuery.brandId  = media.brandId;
    categoryQuery.brandId = media.brandId;
  }

  const [products, categories] = await Promise.all([
    productIds.length
      ? CatalogProduct.find(productQuery)
          .select('_id title imageUrl price currency').lean()
      : [],
    categoryIds.length
      ? Category.find(categoryQuery)
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
