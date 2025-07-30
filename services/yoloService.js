// /services/yoloService.js
const axios = require('axios');
const FormData = require('form-data');

async function detectMultipleProducts(imageBuffer) {
  try {
    const form = new FormData();
    form.append('image', imageBuffer, { filename: 'upload.jpg' });

    console.log('➡️ Sending image to YOLO...');
    const res = await axios.post(
      'https://yolo-microservice.onrender.com/detect',
      form,
      {
        headers: form.getHeaders(),
        responseType: 'json',
        timeout: 60000
      }
    );

    console.log('✅ YOLO responded:', res.status, res.statusText);

    if (!Array.isArray(res.data) || res.data.length === 0) {
      console.warn('⚠️ YOLO returned no detections');
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

module.exports = { detectMultipleProducts };
