const axios = require('axios');
const FormData = require('form-data');

/**
 * Sends an image buffer to a YOLOv8-based detection microservice and
 * expects multiple cropped regions in return (as base64 or URLs).
 * @param {Buffer} imageBuffer - Original uploaded image buffer
 * @returns {Promise<Array<{ cropBuffer: Buffer, confidence: number }>>}
 */
async function detectMultipleProducts(imageBuffer) {
  try {
    const form = new FormData();
    form.append('image', imageBuffer, { filename: 'upload.jpg' });

    console.log('➡️ Sending image to YOLO microservice...');

    const start = Date.now();
    const res = await axios.post(
      'https://yolo-microservice.onrender.com/detect',
      form,
      {
        headers: form.getHeaders(),
        timeout: 20000, // 20 seconds
        responseType: 'json'
      }
    );

    const duration = Date.now() - start;
    console.log(`✅ YOLO responded in ${duration}ms`);
    console.log(`📦 Received ${res.data.length} detections`);

    return res.data.map(det => ({
      cropBuffer: Buffer.from(det.base64, 'base64'),
      confidence: det.confidence
    }));
  } catch (err) {
    console.error('❌ YOLO detection failed:', err.response?.data || err.message || err);
    throw new Error('Object detection failed');
  }
}

module.exports = { detectMultipleProducts };
