// Executor for capability catalog.bulkCreateProducts (Tier 1,
// brand scope).
//
// Bulk single-brand insert. Each row in `products[]` follows the
// catalog.createProduct shape:
//   { title, imageUrl, price?, currency?, productUrl?, gtin?, mpn?,
//     category?, description? }
// Idempotent on (brandId, externalId) where externalId =
// "manual:<slug(title)>" — a row whose title matches an existing
// slug becomes an update, not a duplicate. Matches
// catalog.createProduct.
//
// Cap: MAX_BULK_PRODUCTS (500). A larger array is REJECTED, not
// silently truncated — the operator should chunk explicitly.
//
// mirrorImages:true (default) mirrors each imageUrl into Cloudinary
// via uploadUrlToCloudinary. false accepts the raw URL as-is — fast
// but the row's imageUrl expires if the source does. The trade-off
// is money + time vs asset stability; the default sides with
// stability.
//
// Per-row failure is NON-fatal by design. The response reports
// { succeeded, failed, errors[] } so the operator can retry the
// failed rows without re-inserting the succeeded ones (idempotency
// via the (brandId, externalId) key covers that).

'use strict';

const mongoose = require('mongoose');
const Brand = require('../../models/Brand');
const CatalogProduct = require('../../models/CatalogProduct');
const { uploadUrlToCloudinary } = require('../cloudinaryService');
const { stampFeedTruthCategoryRef, applyFeedTruthStamp } = require('../categoryClassifier');
const { MAX_BULK_PRODUCTS } = require('../catalogBulkOps');

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

function normalizeRow(raw) {
  const title = String(raw?.title || '').trim();
  if (!title) return { ok: false, error: 'title required' };
  if (title.length > 500) return { ok: false, error: `title too long (${title.length} > 500)` };
  const imageUrl = String(raw?.imageUrl || '').trim();
  if (!imageUrl) return { ok: false, error: 'imageUrl required' };
  if (!/^https?:\/\//i.test(imageUrl)) return { ok: false, error: 'imageUrl must be http/https' };

  let price = null;
  if (raw?.price != null && raw.price !== '') {
    const p = Number(raw.price);
    if (!Number.isFinite(p) || p < 0) return { ok: false, error: 'price must be non-negative number' };
    price = p;
  }
  const currencyRaw = String(raw?.currency || '').toUpperCase().trim();
  if (currencyRaw && !/^[A-Z]{3}$/.test(currencyRaw)) {
    return { ok: false, error: 'currency must be 3-letter ISO code' };
  }
  const productUrl = raw?.productUrl != null ? String(raw.productUrl).trim() : null;
  if (productUrl && !/^https?:\/\//i.test(productUrl)) {
    return { ok: false, error: 'productUrl must be http/https' };
  }
  return {
    ok: true,
    row: {
      title,
      imageUrl,
      price,
      currency:    currencyRaw || null,
      productUrl,
      gtin:        normalizeGtin(raw?.gtin),
      mpn:         raw?.mpn         != null ? String(raw.mpn).trim()         : null,
      category:    raw?.category    != null ? String(raw.category).trim()    : null,
      description: raw?.description != null ? String(raw.description).trim() : null
    }
  };
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
  const products = Array.isArray(args?.products) ? args.products : null;
  if (!products || products.length === 0) {
    return { ok: false, error: 'products[] required (non-empty)' };
  }
  if (products.length > MAX_BULK_PRODUCTS) {
    return {
      ok: false,
      error: `products[] too large (${products.length} > ${MAX_BULK_PRODUCTS}). Chunk into smaller batches.`
    };
  }
  const mirrorImages = args?.mirrorImages !== false;   // default true

  const brand = await Brand.findOne({ _id: rawBrandId, advertiserId: req.advertiserId })
    .select('_id name advertiserId').lean();
  if (!brand) return { ok: false, error: `brand ${rawBrandId} not found` };

  let succeeded = 0;
  let failed    = 0;
  let created   = 0;
  let updated   = 0;
  const errors  = [];
  const results = [];   // per-row summaries in input order
  const pendingBenefits = [];

  for (let i = 0; i < products.length; i++) {
    const raw = products[i];
    const norm = normalizeRow(raw);
    if (!norm.ok) {
      failed++;
      errors.push({ index: i, title: String(raw?.title || '').slice(0, 80), error: norm.error });
      continue;
    }
    const row = norm.row;
    const slug = slugify(row.title);
    if (!slug) {
      failed++;
      errors.push({ index: i, title: row.title.slice(0, 80), error: 'title produces empty slug' });
      continue;
    }
    const externalId = `manual:${slug}`;
    const draft = !(row.price != null && row.productUrl);

    let mirroredImageUrl = row.imageUrl;
    if (mirrorImages) {
      try {
        const uploaded = await uploadUrlToCloudinary(row.imageUrl, {
          resourceType: 'image',
          folder:       'brand_products'
        });
        mirroredImageUrl = uploaded.secure_url;
      } catch (err) {
        failed++;
        errors.push({ index: i, title: row.title.slice(0, 80), error: `image mirror failed: ${err.message}` });
        continue;
      }
    }

    const benefits = require('../productBenefitsService');
    const prevDoc = await benefits.loadPrevForBenefits(brand._id, externalId);
    const { changed: benefitsStale } = benefits.markBenefitsStaleIfTextChanged(
      prevDoc,
      { title: row.title, description: row.description }
    );

    let result;
    try {
      const upsertUpdate = {
        $set: {
          title:       row.title,
          description: row.description,
          category:    row.category,
          brand:       brand.name || null,
          price:       row.price,
          currency:    row.currency,
          availability: row.price != null ? 'in stock' : null,
          imageUrl:    mirroredImageUrl,
          productUrl:  row.productUrl,
          gtin:        row.gtin,
          mpn:         row.mpn,
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
      };
      benefits.applyBenefitsStaleToUpdate(upsertUpdate, benefitsStale);
      result = await CatalogProduct.findOneAndUpdate(
        { brandId: brand._id, externalId },
        upsertUpdate,
        { upsert: true, new: true, includeResultMetadata: true }
      );
    } catch (err) {
      failed++;
      errors.push({ index: i, title: row.title.slice(0, 80), error: `upsert failed: ${err.message}` });
      continue;
    }
    const product = result.value;
    const isNew   = !result.lastErrorObject?.updatedExisting;
    succeeded++;
    if (isNew) created++; else updated++;
    if (isNew && product) pendingBenefits.push(product);
    else if (benefitsStale && product) pendingBenefits.push(benefits.redriveView(product));

    // Category stamp — applyFeedTruthStamp handles insert / noop /
    // rename uniformly. Never fatal.
    if (product) {
      try {
        const stamp = await stampFeedTruthCategoryRef({
          brandId:      brand._id,
          advertiserId: req.advertiserId,
          feedCategory: row.category,
          title:        row.title
        });
        await applyFeedTruthStamp(product, stamp);
      } catch (err) {
        console.warn(`   ⚠️  bulkCreateProducts: category stamp failed for row ${i}: ${err.message}`);
      }
    }

    results.push({
      index:      i,
      productId:  String(product._id),
      externalId: product.externalId,
      title:      product.title,
      created:    isNew,
      draft:      !!product.draft
    });
  }

  require('../productBenefitsService').enqueueFromPending({
    pending: pendingBenefits, brand
  });

  return {
    ok: true,
    kind: 'productBulkCreate',
    data: {
      brandId:   String(brand._id),
      brandName: brand.name,
      total:     products.length,
      succeeded,
      failed,
      created,
      updated,
      mirrorImages,
      results,
      errors:    errors.slice(0, 25),   // cap — long lists get noisy
      errorsTruncated: errors.length > 25 ? errors.length - 25 : 0
    }
  };
}

module.exports = { run };
