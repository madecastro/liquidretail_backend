const axios = require('axios');
const FormData = require('form-data');

// Env-driven so prod + staging can each target their own YOLO Docker
// service. Fallback matches the pre-2026-08-10-split hard-coded URL
// so an env that never sets YOLO_SERVICE_URL (local dev, one-service
// legacy) still works.
const YOLO_URL = process.env.YOLO_SERVICE_URL || 'https://yolo-microservice.onrender.com';

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

// Connection-reset retry knob — one retry by default. YOLO autoscaling
// instance churn (scale-down + new-instance routing) and Render's edge
// timeout can produce transient ECONNRESET / ECONNABORTED errors that
// usually succeed on a fresh connection.
const YOLO_RETRY_ATTEMPTS = Math.max(0, parseInt(process.env.YOLO_RETRY_ATTEMPTS, 10) || 1);
const YOLO_RETRY_DELAY_MS = Math.max(0, parseInt(process.env.YOLO_RETRY_DELAY_MS, 10) || 1000);
// 2-min timeout — Render's edge kills the upstream connection at 100s,
// so anything past that is a dead connection. 120s gives 20s buffer
// for normal scaling delay without waiting forever.
const YOLO_TIMEOUT_MS = Math.max(1000, parseInt(process.env.YOLO_TIMEOUT_MS, 10) || 120000);

function isTransientYoloError(err) {
  const code = err?.code;
  if (code === 'ECONNRESET' || code === 'ECONNABORTED' || code === 'ETIMEDOUT') return true;
  // axios timeout returns ECONNABORTED OR err.message includes 'timeout'
  if (typeof err?.message === 'string' && /timeout|reset/i.test(err.message)) return true;
  return false;
}

// Classify an axios failure into a short kind so run.flags.yoloError
// carries enough detail to distinguish "microservice OOM'd" from
// "client-side timeout while microservice kept working" post-hoc.
// Previously every failure collapsed to the literal string
// "Object detection failed", which made 23% of runs indistinguishable
// from each other in the DetectRun flags.
function classifyYoloError(err) {
  const code = err?.code;
  const status = err?.response?.status;
  if (code === 'ECONNABORTED') return 'client-timeout';
  if (code === 'ECONNRESET')   return 'conn-reset';
  if (code === 'ETIMEDOUT')    return 'conn-timeout';
  if (typeof status === 'number') {
    if (status >= 500) return `http-${status}`;
    if (status >= 400) return `http-${status}`;
  }
  if (typeof err?.message === 'string' && /timeout/i.test(err.message)) return 'client-timeout';
  return code ? String(code).toLowerCase() : 'unknown';
}

async function _callYolo(url, form) {
  let lastErr = null;
  for (let attempt = 0; attempt <= YOLO_RETRY_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      console.log(`🔁 YOLO retry ${attempt}/${YOLO_RETRY_ATTEMPTS} after ${YOLO_RETRY_DELAY_MS}ms: ${url}`);
      await new Promise(r => setTimeout(r, YOLO_RETRY_DELAY_MS));
    }
    try {
      console.log(`➡️  Sending to YOLO${attempt > 0 ? ` (retry ${attempt})` : ''}: ${url}`);
      const res = await axios.post(url, form, {
        headers: form.getHeaders(),
        responseType: 'json',
        timeout: YOLO_TIMEOUT_MS
      });

      const { width, height, detections, hero_frame, hero_frame_sec, hero_reason, video_duration_sec } = res.data;
      const list = Array.isArray(detections) ? detections : [];
      console.log(`✅ YOLO responded: ${res.status} — ${list.length} detection(s)`);

      return {
        width,
        height,
        heroFrameBase64: hero_frame || null,
        heroFrameSec: hero_frame_sec ?? null,
        heroReason: hero_reason || null,
        videoDurationSec: video_duration_sec ?? null,
        detections: list.map((det, i) => ({
          id: `p${i + 1}`,
          cropBuffer: Buffer.from(det.base64, 'base64'),
          confidence: det.confidence,
          x1: det.x1, y1: det.y1, x2: det.x2, y2: det.y2,
          className: det.class_name,
          imgWidth: det.img_width,
          imgHeight: det.img_height,
          firstSeenSec: det.first_seen_sec ?? null
        }))
      };
    } catch (err) {
      lastErr = err;
      const detail = err.response?.data || err.message;
      // Non-transient failures (4xx, parse errors, etc.) → fail fast
      if (!isTransientYoloError(err)) {
        const kind = classifyYoloError(err);
        console.error(`❌ YOLO detection failed (non-transient, ${kind}):`, detail);
        const e = new Error(`yolo:${kind}: ${err.message || 'call failed'}`);
        e.yoloKind = kind;
        throw e;
      }
      console.warn(`⚠️  YOLO transient failure (attempt ${attempt + 1}): ${err.code || err.message}`);
      // Loop to retry; if attempts exhausted, fall through to throw below.
    }
  }
  const kind = classifyYoloError(lastErr);
  console.error(`❌ YOLO detection failed after retries (${kind}):`, lastErr?.code || lastErr?.message);
  const e = new Error(`yolo:${kind}: ${lastErr?.message || 'retries exhausted'}`);
  e.yoloKind = kind;
  throw e;
}

module.exports = { detectMultipleProducts, detectFromVideo };
