// Inventory pipeline — the original /api/upload flow.
// Takes a photo/video of a truck bed, runs YOLO to crop products, identifies
// each crop with GPT-4.1, (optionally) falls back to an Amazon catalog search
// for low-confidence hits, and saves a Product document per detection.
//
// The resulting Products can later be pushed to Shopify via the API route
// in routes/upload.js (handler: processLegacyUploadJob).

const crypto = require('crypto');
const Product = require('../models/Product');

const { detectMultipleProducts, detectFromVideo } = require('../services/yoloService');
const { uploadBufferToCloudinary } = require('../services/cloudinaryService');
const { processImage } = require('../services/openaiService');
const { fallbackAmazonSearch } = require('../services/amazonService');

// ──────────────────────────────────────────────────────────────
//  Main handler — image or video → products
// ──────────────────────────────────────────────────────────────
async function processLegacyUploadJob(job) {
  const isVideo = job.fileType === 'video';
  const yolo = isVideo
    ? await detectFromVideo(job.fileBuffer, 'upload.mp4')
    : await detectMultipleProducts(job.fileBuffer);

  const detections = yolo.detections || [];
  console.log(`🔍 YOLO detected ${detections.length} unique product(s)`);
  if (detections.length === 0) throw new Error('No products detected in image');

  const products = [];
  for (const { cropBuffer } of detections) {
    try {
      const product = await identifyAndSaveProduct(cropBuffer, job);
      if (product) products.push(product._id);
    } catch (err) {
      console.error('❌ Error processing crop:', err.message || err);
    }
  }
  if (products.length === 0) throw new Error('No products saved. All crops failed or were rejected.');

  job.status = 'completed';
  job.completedAt = new Date();
  job.products = products;
  await job.save();
  console.log(`🎉 Inventory job ${job._id} completed with ${products.length} products`);
}

// ──────────────────────────────────────────────────────────────
//  Shared: upload one crop, identify with GPT, save a Product
//  Also used by the pre-cropped bridge in pipelines/bridge.js.
// ──────────────────────────────────────────────────────────────
async function identifyAndSaveProduct(cropBuffer, job) {
  const hash = crypto.createHash('md5').update(cropBuffer).digest('hex');
  console.log(`📦 Crop size: ${cropBuffer.length} bytes | hash: ${hash}`);

  const { secure_url: image_url } = await uploadBufferToCloudinary(cropBuffer);
  console.log('📸 Uploaded crop:', image_url);

  let productData = await processImage(image_url);
  console.log('🧠 OpenAI identified:', productData.product_title || productData.product_name);

  if (productData.confidence < 0.6) {
    console.log(`🟡 Low confidence (${productData.confidence}), using fallback...`);
    const fallback = await fallbackAmazonSearch(productData.description);
    productData = { ...productData, ...fallback, fallback_used: true };
  }

  const product = new Product({
    product_name: productData.product_name || 'Unnamed',
    product_title: productData.product_title || 'Untitled Product',
    description: productData.description,
    price_estimate: productData.price_estimate || job.metadata?.price || 0,
    condition: productData.condition,
    image_url,
    truck_number: job.metadata?.truck_number,
    delivery_location: job.metadata?.delivery_location,
    delivery_date: job.metadata?.delivery_date,
    delivery_time: job.metadata?.delivery_time,
    marketing_images: productData.marketing_images || [],
    confidence: productData.confidence,
    fallback_used: productData.fallback_used || false,
    shopify_status: 'pending',
    createdAt: new Date()
  });
  await product.save();
  console.log(`✅ Saved product ${product._id}`);
  return product;
}

module.exports = { processLegacyUploadJob, identifyAndSaveProduct };
