require('dotenv').config();
const mongoose = require('mongoose');
const crypto = require('crypto');
const axios = require('axios');
const Job = require('./models/Job');
const Product = require('./models/Product');

const { detectMultipleProducts, detectFromVideo } = require('./services/yoloService');
const { uploadBufferToCloudinary } = require('./services/cloudinaryService');
const { processImage } = require('./services/openaiService');
const { fallbackAmazonSearch } = require('./services/amazonService');
const { detectSubjectsAndText } = require('./services/subjectTextService');
const { generateSmartCrops, computeSafeRect } = require('./services/smartCropService');
const { judgeDetections } = require('./services/judgeService');
const { transcribeAudio } = require('./services/whisperService');
const { extractEntities } = require('./services/nerService');

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

      if (!job) { await sleep(3000); continue; }

      console.log(`🧩 Processing job ${job._id} (${job.fileType || 'image'})`);

      if (job.fileType === 'detect-image' || job.fileType === 'detect-video') {
        await processDetectJob(job);
      } else if (job.fileType === 'pre-cropped') {
        await processPreCroppedJob(job);
      } else {
        await processLegacyUploadJob(job);
      }

    } catch (err) {
      console.error('❌ Job failed:', err.message || err);
      if (job) {
        job.status = 'failed';
        job.error = err.message || 'Unknown error';
        job.errorStage = err.stage || 'unknown';
        await job.save();
      }
    }
  }
}

// ──────────────────────────────────────────────────────────────
//  Detection-only pipeline (new async flow)
//  Output shape matches what detect.html expects
// ──────────────────────────────────────────────────────────────
async function processDetectJob(job) {
  const isVideo = job.fileType === 'detect-video';
  const fileBuffer = await downloadBuffer(job.fileUrl, 'file-download');

  const result = isVideo
    ? await runDetectVideoPipeline(job, fileBuffer)
    : await runDetectImagePipeline(job, fileBuffer);

  job.status = 'completed';
  job.detectionStage = 'done';
  job.detectionResult = result;
  job.completedAt = new Date();
  await job.save();
  console.log(`🎉 Detect job ${job._id} completed`);
}

async function runDetectImagePipeline(job, buffer) {
  await setStage(job, 'yolo');
  let products = [];
  try {
    const yolo = await detectMultipleProducts(buffer);
    products = yolo.detections;
    console.log(`🔍 YOLO: ${products.length} product(s)`);
  } catch (err) { console.warn('⚠️  YOLO:', err.message); }

  await setStage(job, 'subjects-text');
  let subjects = [], text = [];
  try {
    const st = await detectSubjectsAndText(job.fileUrl);
    subjects = st.subjects; text = st.text;
  } catch (err) { console.warn('⚠️  Subject/text:', err.message); }

  const imgW = products[0]?.imgWidth  || 1024;
  const imgH = products[0]?.imgHeight || 768;

  await setStage(job, 'smart-crops');
  const safeRect = computeSafeRect(products, subjects, imgW, imgH);
  if (safeRect) console.log(`🛟  Safe envelope: (${safeRect.x1.toFixed(0)}, ${safeRect.y1.toFixed(0)}) → (${safeRect.x2.toFixed(0)}, ${safeRect.y2.toFixed(0)})`);
  const crops = generateSmartCrops(imgW, imgH, subjects, text, safeRect);

  await setStage(job, 'judge');
  let judge = null;
  try {
    judge = await judgeDetections({ imageUrl: job.fileUrl, products, subjects, text, crops, safeRect });
  } catch (err) { console.warn('⚠️  Judge:', err.message); }

  return {
    type: 'image',
    imageUrl: job.fileUrl,
    width: imgW, height: imgH,
    products: products.map(({ cropBuffer, ...p }) => p),
    subjects, text, crops, judge, safeRect
  };
}

async function runDetectVideoPipeline(job, buffer) {
  await setStage(job, 'yolo-video');
  let products = [];
  let heroImageUrl = null;
  let imgW = 1024, imgH = 768;

  try {
    const yolo = await detectFromVideo(buffer, job.fileName);
    products = yolo.detections;
    imgW = yolo.width || imgW;
    imgH = yolo.height || imgH;
    if (yolo.heroFrameBase64) {
      const heroBuf = Buffer.from(yolo.heroFrameBase64, 'base64');
      const up = await uploadBufferToCloudinary(heroBuf, { resourceType: 'image' });
      heroImageUrl = up.secure_url;
      console.log(`🖼️  Hero frame uploaded: ${heroImageUrl}`);
    }
  } catch (err) { console.warn('⚠️  YOLO video:', err.message); }

  await setStage(job, 'transcribe');
  let transcript = null, entities = [];
  try {
    transcript = await transcribeAudio(buffer, job.fileName);
    if (transcript) {
      console.log(`🎙️  Transcript: ${transcript.segments.length} segments, ${transcript.duration.toFixed(1)}s`);
      await setStage(job, 'ner');
      entities = await extractEntities(transcript);
      console.log(`🏷️  NER: ${entities.length} entities`);
    }
  } catch (err) { console.warn('⚠️  Transcription/NER:', err.message); }

  let subjects = [], text = [];
  if (heroImageUrl) {
    await setStage(job, 'subjects-text');
    try {
      const st = await detectSubjectsAndText(heroImageUrl);
      subjects = st.subjects; text = st.text;
    } catch (err) { console.warn('⚠️  Subject/text:', err.message); }
  }

  await setStage(job, 'smart-crops');
  // Safe envelope = union of all deduped YOLO detections (each captured from
  // the frame where it first appeared) + primary GPT subjects on the hero frame.
  // This approximates where the subject-of-interest lives across the whole clip.
  const safeRect = computeSafeRect(products, subjects, imgW, imgH);
  if (safeRect) console.log(`🛟  Safe envelope: (${safeRect.x1.toFixed(0)}, ${safeRect.y1.toFixed(0)}) → (${safeRect.x2.toFixed(0)}, ${safeRect.y2.toFixed(0)})`);
  const crops = generateSmartCrops(imgW, imgH, subjects, text, safeRect);

  // Attach a Cloudinary video-transform URL to each crop candidate so the UI
  // can preview the fully cropped clip (every frame re-framed to the ratio).
  for (const ratio of Object.keys(crops)) {
    for (const c of crops[ratio]) {
      c.videoUrl = buildCloudinaryCropUrl(job.fileUrl, c);
    }
  }

  let judge = null;
  if (heroImageUrl) {
    await setStage(job, 'judge');
    try {
      judge = await judgeDetections({ imageUrl: heroImageUrl, products, subjects, text, crops, safeRect });
    } catch (err) { console.warn('⚠️  Judge:', err.message); }
  }

  return {
    type: 'video',
    videoUrl: job.fileUrl,
    imageUrl: heroImageUrl,
    width: imgW, height: imgH,
    products: products.map(({ cropBuffer, ...p }) => p),
    subjects, text, crops, judge, safeRect,
    transcript: transcript ? {
      text: transcript.text,
      duration: transcript.duration,
      segments: transcript.segments,
      entities
    } : null
  };
}

// Build a Cloudinary video transform URL that crops every frame to the given rect.
// Source URL shape: https://res.cloudinary.com/<cloud>/video/upload/v123.../path.mp4
// We insert a transform between "/upload/" and the rest.
function buildCloudinaryCropUrl(videoUrl, crop) {
  if (!videoUrl || !videoUrl.includes('/upload/')) return null;
  const w = Math.max(1, crop.x2 - crop.x1);
  const h = Math.max(1, crop.y2 - crop.y1);
  const transform = `c_crop,w_${w},h_${h},x_${crop.x1},y_${crop.y1}`;
  return videoUrl.replace('/upload/', `/upload/${transform}/`);
}

// ──────────────────────────────────────────────────────────────
//  Pre-cropped jobs: re-use YOLO microservice as a cropping utility
//  (it returns per-detection crop buffers; we could alternatively add
//  a dedicated /crop endpoint later if we want arbitrary boxes)
// ──────────────────────────────────────────────────────────────
async function processPreCroppedJob(job) {
  const { imageUrl, approvedBoxes } = job.detectionData || {};
  if (!imageUrl || !approvedBoxes?.length) {
    throw new Error('Pre-cropped job missing imageUrl or approvedBoxes');
  }

  // Re-run YOLO on the source image to get crops aligned with detection boxes.
  // We then match by IoU to the approved boxes and forward matching crops through GPT.
  const sourceBuffer = await downloadBuffer(imageUrl, 'source-image');
  const yolo = await detectMultipleProducts(sourceBuffer);
  const detections = yolo.detections || [];

  const products = [];
  for (const approvedBox of approvedBoxes) {
    const match = findBestIouMatch(approvedBox, detections);
    if (!match) { console.warn(`⚠️  No YOLO crop matched approved box ${approvedBox.id}`); continue; }
    try {
      const product = await identifyAndSaveProduct(match.cropBuffer, job);
      if (product) products.push(product._id);
    } catch (err) {
      console.error('❌ Error on approved crop:', err.message || err);
    }
  }

  if (products.length === 0) throw new Error('No products saved from approved crops');

  job.status = 'completed';
  job.completedAt = new Date();
  job.products = products;
  await job.save();
  console.log(`🎉 Pre-cropped job ${job._id} completed with ${products.length} products`);
}

function findBestIouMatch(approvedBox, detections) {
  let best = null, bestIou = 0;
  for (const d of detections) {
    const iou = boxIou(approvedBox, d);
    if (iou > bestIou) { bestIou = iou; best = d; }
  }
  return bestIou > 0.3 ? best : null;
}

function boxIou(a, b) {
  const xi1 = Math.max(a.x1, b.x1), yi1 = Math.max(a.y1, b.y1);
  const xi2 = Math.min(a.x2, b.x2), yi2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, xi2 - xi1) * Math.max(0, yi2 - yi1);
  const areaA = Math.max(0, a.x2 - a.x1) * Math.max(0, a.y2 - a.y1);
  const areaB = Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}

// ──────────────────────────────────────────────────────────────
//  Legacy /api/upload flow (image/video → full pipeline)
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
  console.log(`🎉 Job ${job._id} completed with ${products.length} products`);
}

// ──────────────────────────────────────────────────────────────
//  Shared: upload crop, identify via GPT, save to DB
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

// ──────────────────────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────────────────────
async function downloadBuffer(url, label) {
  try {
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 120000 });
    return Buffer.from(res.data);
  } catch (err) {
    const e = new Error(`Failed to download ${label}: ${err.message}`);
    e.stage = label;
    throw e;
  }
}

async function setStage(job, stage) {
  job.detectionStage = stage;
  await job.save();
  console.log(`   → ${stage}`);
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
