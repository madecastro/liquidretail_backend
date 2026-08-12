// Executor for capability catalog.createProduct (Tier 1, brand scope).
//
// URL-based single-product create. Mirrors POST /api/upload/product but
// takes a remote imageUrl instead of a multipart file — Cloudinary
// mirrors the URL via uploadUrlToCloudinary, so the resulting
// CatalogProduct row still owns a stable CDN asset. draft=true unless
// BOTH price AND productUrl are supplied (matches the route\'s rule).
//
// Idempotent on (brandId, externalId) where externalId = "manual:<slug>":
// re-running with the same title updates the existing row rather than
// duplicating.

'use strict';

const mongoose = require('mongoose');
const Brand = require('../../models/Brand');
const CatalogProduct = require('../../models/CatalogProduct');
const { uploadUrlToCloudinary } = require('../cloudinaryService');
const { stampFeedTruthCategoryRef, applyFeedTruthStamp } = require('../categoryClassifier');

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function normalizeGtin(raw) {
  if (raw == null) return null;
  const cleaned = String(raw).trim().replace(/[^\d]/g, '');
  if (![8, 12, 13, 14].includes(cleaned.length)) return null;
  return cleaned;
}

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawBrandId = args?.brandId;
  if (!rawBrandId) return { ok: false, error: 'brandId required' };
  if (!mongoose.isValidObjectId(rawBrandId)) {
    return { ok: false, error: `brandId "${rawBrandId}" is not a valid ObjectId` };
  }
  const title = String(args?.title || '').trim();
  if (!title) return { ok: false, error: 'title required' };
  if (title.length > 500) return { ok: false, error: `title too long (${title.length} > 500 chars)` };
  const imageUrl = String(args?.imageUrl || '').trim();
  if (!imageUrl) return { ok: false, error: 'imageUrl required' };
  if (!/^https?:\/\//i.test(imageUrl)) {
    return { ok: false, error: 'imageUrl must be a http:// or https:// URL' };
  }

  let price = null;
  if (args?.price != null && args.price !== '') {
    const p = Number(args.price);
    if (!Number.isFinite(p) || p < 0) {
      return { ok: false, error: 'price must be a non-negative number' };
    }
    price = p;
  }
  const currencyRaw = String(args?.currency || '').toUpperCase().trim();
  if (currencyRaw && !/^[A-Z]{3}$/.test(currencyRaw)) {
    return { ok: false, error: 'currency must be 3-letter ISO code (USD, EUR, ...)' };
  }
  const currency = currencyRaw || null;
  const productUrl = args?.productUrl != null ? String(args.productUrl).trim() : null;
  if (productUrl && !/^https?:\/\//i.test(productUrl)) {
    return { ok: false, error: 'productUrl must be http or https' };
  }
  const gtin = normalizeGtin(args?.gtin);
  const mpn         = args?.mpn         != null ? String(args.mpn).trim()         : null;
  const category    = args?.category    != null ? String(args.category).trim()    : null;
  const description = args?.description != null ? String(args.description).trim() : null;

  const brand = await Brand.findOne({ _id: rawBrandId, advertiserId: req.advertiserId })
    .select('_id name').lean();
  if (!brand) return { ok: false, error: `brand ${rawBrandId} not found` };

  const slug = slugify(title);
  if (!slug) return { ok: false, error: 'title produces empty slug — include some alphanumerics' };
  const externalId = `manual:${slug}`;

  // Mirror the remote image into Cloudinary so the product row owns a
  // stable CDN asset even if the source URL expires (Meta CDN, IG etc.
  // both expire within hours).
  let uploaded;
  try {
    uploaded = await uploadUrlToCloudinary(imageUrl, {
      resourceType: 'image',
      folder:       'brand_products'
    });
  } catch (err) {
    return { ok: false, error: `image mirror failed: ${err.message}` };
  }

  const draft = !(price != null && productUrl);

  let result;
  try {
    result = await CatalogProduct.findOneAndUpdate(
      { brandId: brand._id, externalId },
      {
        $set: {
          title, description, category,
          brand:        brand.name || null,
          price, currency,
          availability: price != null ? 'in stock' : null,
          imageUrl:     uploaded.secure_url,
          productUrl,
          gtin, mpn,
          draft,
          lastSyncedAt: new Date()
        },
        $setOnInsert: {
          advertiserId: req.advertiserId,
          brandId:      brand._id,
          source:       'manual-upload',
          externalId,
          firstSeenAt:  new Date()
        }
      },
      { upsert: true, new: true, rawResult: true }
    );
  } catch (err) {
    return { ok: false, error: `CatalogProduct upsert failed: ${err.message}` };
  }

  const product = result.value;
  const isNew = !result.lastErrorObject?.updatedExisting;

  // Stamp / restamp categoryRef via applyFeedTruthStamp — same
  // pattern the ingest paths use. Handles insert (fresh row), noop
  // (ref matches), and rename (operator changed the category arg).
  if (product) {
    try {
      const stamp = await stampFeedTruthCategoryRef({
        brandId:      brand._id,
        advertiserId: req.advertiserId,
        feedCategory: category,
        title:        title
      });
      await applyFeedTruthStamp(product, stamp);
    } catch (err) {
      // Non-fatal — the row is already saved; missing categoryRef
      // just leaves the row uncategorized until a later stamp / match.
      console.warn(`   ⚠️  catalog.createProduct category stamp failed: ${err.message}`);
    }
  }

  return {
    ok: true,
    kind: 'productUpdate',
    data: {
      _id:        String(product._id),
      externalId: product.externalId,
      title:      product.title,
      brandId:    String(brand._id),
      brandName:  brand.name,
      imageUrl:   product.imageUrl,
      price:      product.price ?? null,
      currency:   product.currency || null,
      productUrl: product.productUrl || null,
      draft:      !!product.draft,
      created:    isNew,
      note: draft
        ? 'Row created as DRAFT — supply price AND productUrl (or update later) to make it usable for ad generation.'
        : 'Row created + ready for ad generation.'
    }
  };
}

module.exports = { run };
