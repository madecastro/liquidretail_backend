// /services/yoloService.js
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

    const res = await axios.post('https://yolo-microservice.onrender.com', form, {
      headers: form.getHeaders(),
      responseType: 'json'
    });

    // Expected response: [{ base64: '...', confidence: 0.85 }, ...]
    const detections = res.data;

    return detections.map(det => ({
      cropBuffer: Buffer.from(det.base64, 'base64'),
      confidence: det.confidence
    }));
  } catch (err) {
    console.error('YOLO detection failed:', err.message);
    throw new Error('Object detection failed');
  }
}

module.exports = { detectMultipleProducts };
