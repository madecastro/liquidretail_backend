const axios = require('axios');
const FormData = require('form-data');

// Env-driven so prod + staging can each target their own YOLO Docker
// service. Fallback matches the pre-2026-08-10-split hard-coded URL
// so an env that never sets YOLO_SERVICE_URL (local dev, one-service
// legacy) still works.
const YOLO_URL = process.env.YOLO_SERVICE_URL || 'https://yolo-microservice.onrender.com';

async function detectMultipleProducts(imageBuffer, opts = {}) {
  const form = new FormData();
  form.append('image', imageBuffer, { filename: 'upload.jpg' });
  // Optional prompt — when provided AND the microservice has
  // YOLO_OPEN_VOCAB_ENABLED, /detect routes through Grounding DINO
  // instead of the YOLOv8x-COCO+rects+OAI pipeline. Period-separated
  // class-string format ("shoe. sneaker. espadrille.") is what
  // Grounding DINO expects. Backend builds this from CatalogProduct
  // category+title in services/mediaYoloRefine.buildOpenVocabPrompt.
  if (opts.prompt && typeof opts.prompt === 'string' && opts.prompt.trim()) {
    form.append('prompt', opts.prompt.trim());
  }
  return _callYolo(`${YOLO_URL}/detect`, form);
}

async function detectFromVideo(videoBuffer, filename) {
  const form = new FormData();
  form.append('video', videoBuffer, { filename: filename || 'upload.mp4' });
  return _callYolo(`${YOLO_URL}/detect-video`, form);
}

// Batch detection — posts N images (all as multipart field `image`) and
// their N optional prompts (JSON `prompts` array parallel to images) to
// yolo_microservice /detect-batch. Amortizes HTTP + Flask + Python
// invocation over N images per request (measured ~30% wall reduction per
// image). Empty prompt on a slot routes that slot through the legacy
// COCO+rects+OAI pipeline; non-empty prompt routes through Grounding DINO.
// Response shape: parallel array in the same order as `items`, each entry
// { width, height, detections:[...] } matching detectMultipleProducts.
//
// Caller-side batching lives in catalogYoloDetectionService (one HTTP call
// per PRODUCT — hero + top-N alts). Batch cap belongs there, not here.
async function detectBatch(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return { results: [] };
  const form = new FormData();
  const prompts = [];
  for (let i = 0; i < list.length; i++) {
    const it = list[i] || {};
    if (!it.buffer) throw new Error(`detectBatch: item[${i}] missing buffer`);
    form.append('image', it.buffer, { filename: `upload-${i}.jpg` });
    prompts.push(it.prompt && typeof it.prompt === 'string' ? it.prompt.trim() : '');
  }
  // Always send prompts (JSON array parallel to images). Empty strings on
  // non-catalog slots route those to the COCO path server-side.
  form.append('prompts', JSON.stringify(prompts));

  const url = `${YOLO_URL}/detect-batch`;
  let lastErr = null;
  for (let attempt = 0; attempt <= YOLO_RETRY_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      console.log(`🔁 YOLO batch retry ${attempt}/${YOLO_RETRY_ATTEMPTS} after ${YOLO_RETRY_DELAY_MS}ms`);
      await new Promise(r => setTimeout(r, YOLO_RETRY_DELAY_MS));
    }
    try {
      console.log(`➡️  Sending BATCH to YOLO (n=${list.length})${attempt > 0 ? ` (retry ${attempt})` : ''}: ${url}`);
      const res = await axios.post(url, form, {
        headers: form.getHeaders(),
        responseType: 'json',
        // Batch is heavier than /detect — scale timeout with size so a
        // 6-image batch on a cold Grounding DINO instance still finishes.
        timeout: Math.max(YOLO_TIMEOUT_MS, YOLO_TIMEOUT_MS * Math.ceil(list.length / 2)),
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      });
      const results = Array.isArray(res.data?.results) ? res.data.results : [];
      console.log(`✅ YOLO batch responded: ${res.status} — ${results.length} result(s)`);
      // Normalize each slot into the same shape detectMultipleProducts
      // returns, so callers don't need a second decoder. base64 may be
      // empty on open-vocab slots (server-side skip); cropBuffer is then
      // an empty Buffer — synthesizer only needs bbox+conf, not crop.
      return {
        results: results.map((r) => {
          const dets = Array.isArray(r?.detections) ? r.detections : [];
          return {
            width:  r?.width  || 0,
            height: r?.height || 0,
            error:  r?.error || null,
            detections: dets.map((det, i) => ({
              id: `p${i + 1}`,
              cropBuffer: det.base64 ? Buffer.from(det.base64, 'base64') : Buffer.alloc(0),
              confidence: det.confidence,
              x1: det.x1, y1: det.y1, x2: det.x2, y2: det.y2,
              className: det.class_name,
              imgWidth: det.img_width,
              imgHeight: det.img_height
            }))
          };
        })
      };
    } catch (err) {
      lastErr = err;
      if (!isTransientYoloError(err)) {
        const kind = classifyYoloError(err);
        console.error(`❌ YOLO batch failed (non-transient, ${kind}):`, err.response?.data || err.message);
        const e = new Error(`yolo-batch:${kind}: ${err.message || 'call failed'}`);
        e.yoloKind = kind;
        throw e;
      }
      console.warn(`⚠️  YOLO batch transient failure (attempt ${attempt + 1}): ${err.code || err.message}`);
    }
  }
  const kind = classifyYoloError(lastErr);
  const e = new Error(`yolo-batch:${kind}: ${lastErr?.message || 'retries exhausted'}`);
  e.yoloKind = kind;
  throw e;
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

module.exports = { detectMultipleProducts, detectFromVideo, detectBatch };
