// Single-product lifestyle-image generator. The unit the Tier 4
// catalog.generateLifestyleImages workflow fans out over.
//
// One call:
//   1. Load the product's hero image URL.
//   2. Fetch it as a buffer.
//   3. Send to gpt-image-2/edit via atlasImage.editImage with a
//      lifestyle-scene prompt.
//   4. Upload the result to Cloudinary.
//   5. Write the URL back to CatalogProduct.lifestyle_image.
//
// Cost: ~$0.04 per image at quality='low' (measured baseline;
// gpt-image-2/edit at 1024×1024). The workflow's spendGuard consults
// this constant to project batch cost.

'use strict';

const axios = require('axios');
const CatalogProduct = require('../models/CatalogProduct');
const Brand = require('../models/Brand');
const atlasImage = require('./atlasImageService');
const { uploadBufferToCloudinary } = require('./cloudinaryService');

// Measured baseline per gpt-image-2/edit call at quality='low' on the
// 1024×1024 output. The workflow uses this as the per-unit multiplier
// for its aggregate estimateUsd.
const PER_UNIT_ESTIMATE_USD = 0.04;

const EDIT_MODEL = process.env.AGENT_LIFESTYLE_IMAGE_MODEL || 'openai/gpt-image-2/edit';
const QUALITY = process.env.AGENT_LIFESTYLE_IMAGE_QUALITY || 'low';
const SIZE = '1024x1024';
const REFERENCE_TIMEOUT_MS = 15_000;

// Lifestyle-scene prompt template. Deliberately generic and product-
// agnostic in MVP — a per-brand style-anchor extension is a follow-up.
// "faithfully as shown" and "no text/logos" are load-bearing; the model
// will invent brand text on its own otherwise.
function buildPrompt({ product, brand }) {
  const productName = product?.title || product?.name || 'this product';
  const category = product?.category ? ` (${product.category})` : '';
  const brandName = brand?.name || 'the brand';
  const tone = Array.isArray(brand?.tone) && brand.tone.length
    ? ` The brand voice is: ${brand.tone.slice(0, 4).join(', ')}.`
    : '';
  return [
    `Create a photorealistic lifestyle photograph of ${productName}${category} being used in a natural, aspirational everyday scene.`,
    `The product must appear FAITHFULLY AS SHOWN in the reference — same colours, materials, proportions, silhouette.`,
    `Composition: mid-shot, product clearly visible as the subject, warm natural lighting, soft depth of field, minimal styling.`,
    `Setting should feel appropriate for ${brandName}${tone}`,
    `Square framing, high-quality photography aesthetic.`,
    `ABSENCES: no text, no logos, no watermarks, no brand names, no signage — the product itself is the entire message.`
  ].join(' ');
}

async function fetchAsBuffer(url) {
  const r = await axios.get(url, { responseType: 'arraybuffer', timeout: REFERENCE_TIMEOUT_MS });
  return Buffer.from(r.data);
}

/**
 * Generate one lifestyle image. Non-throwing — every failure surfaces
 * as a structured result the workflow can aggregate.
 */
async function generateOne({ productId }) {
  const product = await CatalogProduct.findById(productId)
    .select('_id title category imageUrl productImages brandId lifestyle_image').lean();
  if (!product) {
    return { ok: false, productId: String(productId), reason: 'not-found', error: `product ${productId} not found` };
  }

  // Idempotency — a product that already HAS a lifestyle image skips
  // rather than paying for a re-generation. Operator wanting a fresh
  // one clears the field first.
  if (product.lifestyle_image) {
    return {
      ok: false, productId: String(product._id), productName: product.title,
      reason: 'already-has-lifestyle',
      error: `product already has lifestyle_image (clear the field to regenerate)`
    };
  }

  const heroUrl = product.imageUrl
    || (Array.isArray(product.productImages) && product.productImages[0]?.url)
    || null;
  if (!heroUrl) {
    return {
      ok: false, productId: String(product._id), productName: product.title,
      reason: 'no-hero-image',
      error: 'product has no hero imageUrl — cannot ground the generation'
    };
  }

  const brand = product.brandId
    ? await Brand.findById(product.brandId).select('name tone').lean()
    : null;

  let refBuffer;
  try {
    refBuffer = await fetchAsBuffer(heroUrl);
  } catch (err) {
    return {
      ok: false, productId: String(product._id), productName: product.title,
      reason: 'hero-fetch-failed',
      error: `hero image fetch failed: ${err.message}`
    };
  }

  const prompt = buildPrompt({ product, brand });

  let editResult;
  try {
    editResult = await atlasImage.editImage({
      model:   EDIT_MODEL,
      images:  [refBuffer],
      imageMeta: [{ sourceUrl: heroUrl, role: 'product-hero' }],
      prompt,
      size:    SIZE,
      quality: QUALITY,
      meta: {
        stage:      'lifestyle-image-gen',
        service:    'catalogProductLifestyleImageService',
        purposeTag: 'lifestyle',
        brandId:    product.brandId || null,
        productId:  product._id
      }
    });
  } catch (err) {
    return {
      ok: false, productId: String(product._id), productName: product.title,
      reason: 'image-gen-error',
      error: `image gen failed: ${err.message}`,
      charged: err.charged === true,
      predictionId: err.predictionId || null
    };
  }

  const b64 = editResult?.data?.[0]?.b64_json;
  if (!b64) {
    return {
      ok: false, productId: String(product._id), productName: product.title,
      reason: 'no-image-returned',
      error: 'gpt-image-2/edit returned no image data'
    };
  }

  const buffer = Buffer.from(b64, 'base64');
  let upload;
  try {
    upload = await uploadBufferToCloudinary(buffer, {
      folder: `lifestyle/${String(product.brandId || 'orphan')}`,
      publicId: `${String(product._id)}`,
      resourceType: 'image',
      contentType:  'image/png'
    });
  } catch (err) {
    return {
      ok: false, productId: String(product._id), productName: product.title,
      reason: 'upload-failed',
      error: `cloudinary upload failed: ${err.message}`
    };
  }

  const lifestyleUrl = upload?.secureUrl || upload?.secure_url || upload?.url;
  if (!lifestyleUrl) {
    return {
      ok: false, productId: String(product._id), productName: product.title,
      reason: 'upload-no-url',
      error: 'cloudinary upload returned no URL'
    };
  }

  await CatalogProduct.updateOne({ _id: product._id }, {
    $set: {
      lifestyle_image: lifestyleUrl,
      updatedAt: new Date()
    }
  });

  return {
    ok: true,
    productId:   String(product._id),
    productName: product.title,
    lifestyleUrl,
    model:       EDIT_MODEL,
    quality:     QUALITY,
    estimateUsd: PER_UNIT_ESTIMATE_USD
  };
}

module.exports = { generateOne, PER_UNIT_ESTIMATE_USD };
