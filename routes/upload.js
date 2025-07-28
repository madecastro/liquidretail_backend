// /routes/upload.js
const express = require('express');
const multer = require('multer');
const router = express.Router();

const { uploadBufferToCloudinary } = require('../services/cloudinaryService');
const { detectMultipleProducts } = require('../services/yoloService');
const { describeImage } = require('../services/openai');
const { fallbackAmazonSearch } = require('../services/amazonService');
const Product = require('../models/Product');

const upload = multer();

router.post('/', upload.single('photo'), async (req, res) => {
  try {
    const { buffer } = req.file;
    const { truck_number, price, delivery_date, delivery_time, delivery_location } = req.body;

    // Step 1: Detect product crops
    const detections = await detectMultipleProducts(buffer); // [{ cropBuffer, confidence }]

    const results = [];

    for (const { cropBuffer } of detections) {
      // Step 2: Upload crop to Cloudinary
      const { secure_url: image_url } = await uploadBufferToCloudinary(cropBuffer);

      // Step 3: Use OpenAI to describe the image
      let productData = await describeImage(image_url);

      // Step 4: Fallback if confidence is low
      if (productData.confidence < 0.6) {
        console.log(`🟡 Low confidence (${productData.confidence}), using fallback for:`, productData.description);
        const fallback = await fallbackAmazonSearch(productData.description);
        productData = {
          ...productData,
          ...fallback,
          fallback_used: true
        };
      }

      // Step 5: Save to MongoDB
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
        createdAt: new Date(),
        shopify_status: 'pending'
      });

      const saved = await newProduct.save();
      results.push(saved);
    }

    res.status(200).json(results);
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed', message: err.message });
  }
});

module.exports = router;
