const express = require('express');
const multer = require('multer');
const router = express.Router();

const { uploadBufferToCloudinary } = require('../services/cloudinaryService');
const { detectMultipleProducts } = require('../services/yoloService');
const { processImage } = require('../services/openaiService');
const { fallbackAmazonSearch } = require('../services/amazonService');
const Product = require('../models/Product');

const upload = multer();

router.post('/', upload.single('photo'), async (req, res) => {
  try {
    const { buffer } = req.file;
    const { truck_number, price, delivery_date, delivery_time, delivery_location } = req.body;

    console.log('🚀 Upload received. Running detection...');

    // Step 1: Detect product crops
    const detections = await detectMultipleProducts(buffer);
    if (!Array.isArray(detections) || detections.length === 0) {
      console.warn('⚠️ No products detected in image');
      return res.status(400).json({ error: 'No products detected' });
    }

    console.log(`🔍 YOLO returned ${detections.length} products. Processing...`);

    const results = [];

    for (const { cropBuffer, confidence } of detections) {
      console.log('🖼️ Uploading crop to Cloudinary...');
      const { secure_url: image_url } = await uploadBufferToCloudinary(cropBuffer);

      console.log('🧠 Describing product with OpenAI...');
      console.time('🧠 OpenAI');
      let productData = await processImage(image_url);
      console.timeEnd('🧠 OpenAI');

      if (productData.confidence < 0.6) {
        console.log(`🟡 Low confidence (${productData.confidence}). Using Amazon fallback...`);
        const fallback = await fallbackAmazonSearch(productData.description);
        productData = { ...productData, ...fallback, fallback_used: true };
      }

      const newProduct = new Product({
        product_name: productData.product_name || productData.name || 'Unnamed',
        product_title: productData.product_title || productData.name || 'Untitled Product',
        description: productData.description,
        price_estimate: productData.price_estimate || price || 0,
        condition: productData.condition || 'used',
        image_url,
        truck_number,
        delivery_location,
        delivery_date,
        delivery_time,
        marketing_images: productData.marketing_images || [],
        confidence: productData.confidence,
        fallback_used: productData.fallback_used || false,
        createdAt: new Date(),
        shopify_status: 'pending'
      });

      const saved = await newProduct.save();
      console.log(`✅ Saved product ${saved._id}`);
      results.push(saved);
    }
    console.log('✅ All products saved. Sending response...');
    res.status(200).json(results);
  } catch (err) {
    console.error('Upload error:', err.message || err);
    res.status(500).json({ error: 'Upload failed', message: err.message });
  }
});

module.exports = router;
