require('dotenv').config();
const mongoose = require('mongoose');
const Job = require('./models/Job');
const Product = require('./models/Product');

const { detectMultipleProducts } = require('./services/yoloService');
const { uploadBufferToCloudinary } = require('./services/cloudinaryService');
const { processImage } = require('./services/openaiService');
const { fallbackAmazonSearch } = require('./services/amazonService');

// ✅ Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => {
  console.log('🔌 Connected to MongoDB');
  processJobsLoop();
}).catch(err => console.error('MongoDB error:', err));

async function processJobsLoop() {
  while (true) {
    try {
      const job = await Job.findOneAndUpdate(
        { status: 'queued' },
        { status: 'processing' },
        { new: true }
      );

      if (!job) {
        await sleep(3000); // Wait before checking again
        continue;
      }

      console.log(`🧩 Processing job ${job._id}`);
      const detections = await detectMultipleProducts(job.fileBuffer);
      if (!Array.isArray(detections) || detections.length === 0) {
        throw new Error('No products detected in image');
      }

      const products = [];

      for (const { cropBuffer } of detections) {
        const { secure_url: image_url } = await uploadBufferToCloudinary(cropBuffer);
        let productData = await processImage(image_url);

        if (productData.confidence < 0.6) {
          const fallback = await fallbackAmazonSearch(productData.description);
          productData = { ...productData, ...fallback, fallback_used: true };
        }

        const product = new Product({
          product_name: productData.product_name || 'Unnamed',
          product_title: productData.product_title || 'Untitled Product',
          description: productData.description,
          price_estimate: productData.price_estimate || job.metadata?.price || 0,
          condition: productData.condition || 'used',
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
        products.push(product._id);
        console.log(`✅ Saved product ${product._id}`);
      }

      job.status = 'completed';
      job.completedAt = new Date();
      job.products = products;
      await job.save();
      console.log(`🎉 Job ${job._id} completed with ${products.length} products`);

    } catch (err) {
      console.error('❌ Job failed:', err.message);
      if (job) {
        job.status = 'failed';
        job.error = err.message;
        await job.save();
      }
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
