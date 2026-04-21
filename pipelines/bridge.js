// Bridge — pre-cropped jobs flow approved crops from the Detect pipeline into
// the Inventory pipeline. The user reviews detections on detect.html, clicks
// Approve on the ones they want to sell, and those boxes get queued as a
// `pre-cropped` job. This handler re-runs YOLO on the source image, matches
// each approved box by IoU to a real YOLO crop, then delegates to the shared
// inventory identify/save helper — producing Products that can be pushed to
// Shopify just like any other inventory item.

const { detectMultipleProducts } = require('../services/yoloService');
const { downloadBuffer } = require('./shared');
const { identifyAndSaveProduct } = require('./inventory');

async function processPreCroppedJob(job) {
  const { imageUrl, approvedBoxes } = job.detectionData || {};
  if (!imageUrl || !approvedBoxes?.length) {
    throw new Error('Pre-cropped job missing imageUrl or approvedBoxes');
  }

  // Re-run YOLO to produce real crop buffers aligned with detection boxes.
  // We then match each user-approved box by IoU and forward the matching crop.
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

module.exports = { processPreCroppedJob };
