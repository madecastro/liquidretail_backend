require('dotenv').config();
const mongoose = require('mongoose');
const Job = require('./models/Job');
const Product = require('./models/Product');
const crypto = require('crypto'); // at the top of file

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
    let job = null;

    try {
      job = await Job.findOneAndUpdate(
        { status: 'queued' },
        { status: 'processing' },
        { new: true }
      );

      if (!job) {
        await sleep(3000);
        continue;
      }

      console.log(`🧩 Processing job ${job._id}`);

      const detections = await detectMultipleProducts(job.fileBuffer);
      console.log(`🔍 YOLO detected ${detections.length} product(s)`);

      const hash = crypto.createHash('md5').update(cropBuffer).digest('hex');
      console.log(`📦 Crop size: ${cropBuffer.length} bytes | hash: ${hash}`);

      if (!Array.isArray(detections) || detections.length === 0) {
        throw new Error('No products detected in image');
      }

      const products = [];

      for (const { cropBuffer } of detections) {
        try {
          const { secure_url: image_url } = await uploadBufferToCloudinary(cropBuffer);
          console.log('📸 Uploaded to Cloudinary:', image_url);

          let productData = await processImage(image_url);
          console.log('🧠 OpenAI returned:', productData.product_title || productData.name);

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
          products.push(product._id);
          console.log(`✅ Saved product ${product._id}`);

        } catch (err) {
          console.error('❌ Error processing crop:', err.message || err);
        }
      }

      if (products.length === 0) {
        throw new Error('No products saved. All crops failed or were rejected.');
      }

      job.status = 'completed';
      job.completedAt = new Date();
      job.products = products;
      await job.save();
      console.log(`🎉 Job ${job._id} completed with ${products.length} products`);

    } catch (err) {
      console.error('❌ Job failed:', err.message || err);
      if (job) {
        job.status = 'failed';
        job.error = err.message || 'Unknown error';
        await job.save();
      }
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
