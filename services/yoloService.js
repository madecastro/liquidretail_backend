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
      timeout: 300000  // 5 min — video processing takes longer
    });

    console.log(`✅ YOLO responded: ${res.status} — ${res.data.length} detection(s)`);

    if (!Array.isArray(res.data) || res.data.length === 0) {
      throw new Error('No objects detected');
    }

    return res.data.map(det => ({
      cropBuffer: Buffer.from(det.base64, 'base64'),
      confidence: det.confidence
    }));
  } catch (err) {
    console.error('❌ YOLO detection failed:', err.response?.data || err.message);
    throw new Error('Object detection failed');
  }
}

module.exports = { detectMultipleProducts, detectFromVideo };
