const axios = require('axios');
const FormData = require('form-data');

const YOLO_URL = 'https://yolo-microservice.onrender.com';

async function detectMultipleProducts(imageBuffer) {
  const form = new FormData();
  form.append('image', imageBuffer, { filename: 'upload.jpg' });
  return _callYolo(`${YOLO_URL}/detect`, form);
}

async function detectFromVideo(videoBuffer, filename) {
  const form = new FormData();
  form.append('video', videoBuffer, { filename: filename || 'upload.mp4' });
  return _callYolo(`${YOLO_URL}/detect-video`, form);
}

async function _callYolo(url, form) {
  try {
    console.log(`➡️  Sending to YOLO: ${url}`);
    const res = await axios.post(url, form, {
      headers: form.getHeaders(),
      responseType: 'json',
      timeout: 300000
    });

    const { width, height, detections, hero_frame } = res.data;
    console.log(`✅ YOLO responded: ${res.status} — ${detections?.length ?? 0} detection(s)`);

    if (!Array.isArray(detections) || detections.length === 0) {
      throw new Error('No objects detected');
    }

    return {
      width,
      height,
      heroFrameBase64: hero_frame || null,
      detections: detections.map((det, i) => ({
        id: `p${i + 1}`,
        cropBuffer: Buffer.from(det.base64, 'base64'),
        confidence: det.confidence,
        x1: det.x1,
        y1: det.y1,
        x2: det.x2,
        y2: det.y2,
        className: det.class_name,
        imgWidth: det.img_width,
        imgHeight: det.img_height,
        firstSeenSec: det.first_seen_sec ?? null
      }))
    };
  } catch (err) {
    console.error('❌ YOLO detection failed:', err.response?.data || err.message);
    throw new Error('Object detection failed');
  }
}

module.exports = { detectMultipleProducts, detectFromVideo };
