// Overlay zone analysis — given a finished crop image, ask Gemini Vision to
// identify REGIONS THAT SHOULD NOT RECEIVE OVERLAYS, each with a strictness
// score. The downstream ad-layout generator (and the review UI) computes the
// safe overlay region as "the whole frame minus active restrictions", where
// a conservation slider controls which restrictions are active.
//
// Design change from v1: v1 produced per-role zones (logo, headline, CTA, …)
// pre-sized and pre-located by the model. That pushed layout decisions into
// analysis and made a single image reusable only if the downstream product
// had the same role taxonomy. v2 returns ONLY the negative space — the
// layout generator decides where each overlay goes inside the computed safe
// region.
//
// Per-image output shape:
//   {
//     densityGrid:  { cols, rows, cells: number[][] },   // 0 = empty, 1 = busy
//     restrictions: [{ id, rectPct, classification, strictness, reason }]
//   }
//
// Strictness is 0.0–1.0. A UI / layout consumer picks a conservation level S
// (0..1) and treats any restriction where `strictness >= 1 − S` as active.
// Hard rules:
//   - The primary product / subject is ALWAYS at strictness 1.0.
//   - Any visible face gets at least 0.9.
//   - Secondary subjects (other products, other people, prominent props)
//     land in 0.6–0.8.
//   - Preserve-worthy text / signage lands in 0.4–0.6.
//   - Incidental objects land in 0.2–0.3.
//
// rectPct uses fractional (0..1) coordinates so the artifact is
// resolution-independent — the layout generator places overlays on any output
// size by multiplying by the final canvas dimensions.

const axios = require('axios');
const sharp = require('sharp');
// Atlas gateway (Gemini served OpenAI-compatible; Google's OpenAI-compat
// endpoint as the direct fallback inside the transport). The transport
// owns retries — the local postWithRetry helper is gone.
const { chatCompletion, isConfigured } = require('./atlasLlmService');

const MODEL = process.env.GEMINI_VISION_MODEL || 'gemini-2.5-pro';

// Artifact schema version. Consumers should read this and refuse (or warn)
// on unknown majors. 3.0 added brightnessGrid and broke the top-level
// per-ratio shape (variants are now an array rather than provider-keyed
// object — see pipelines/detect.js::runOverlayZoneAnalysis).
const SCHEMA_VERSION = '3.0';

// Restriction classification taxonomy. Stable contract — adding values is
// backward-compatible, renaming/removing them is not.
const RESTRICTION_CLASSES = ['product', 'face', 'secondary_subject', 'text', 'object', 'other'];

function isEnabled() { return isConfigured() || !!process.env.GEMINI_API_KEY; }

// JSON schema enforced via Gemini's responseSchema feature so we get
// deterministic parsing instead of hoping the model honors a textual contract.
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    densityGrid: {
      type: 'object',
      properties: {
        cols:  { type: 'integer' },
        rows:  { type: 'integer' },
        cells: { type: 'array', items: { type: 'array', items: { type: 'number' } } }
      },
      required: ['cols', 'rows', 'cells'],
      additionalProperties: false
    },
    restrictions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          rectPct:        rectPctSchema(),
          classification: { type: 'string', enum: RESTRICTION_CLASSES },
          strictness:     { type: 'number' },
          reason:         { type: 'string' }
        },
        required: ['rectPct', 'classification', 'strictness', 'reason'],
        additionalProperties: false
      }
    }
  },
  required: ['densityGrid', 'restrictions'],
  additionalProperties: false
};

function rectPctSchema() {
  return {
    type: 'object',
    properties: {
      x1: { type: 'number' }, y1: { type: 'number' },
      x2: { type: 'number' }, y2: { type: 'number' }
    },
    required: ['x1', 'y1', 'x2', 'y2'],
    additionalProperties: false
  };
}

// Analyze a single image. Returns the parsed analysis or null on any failure
// (caller treats null as a non-fatal degradation — the layout generator can
// still work for the other images on the same job).
async function analyzeOverlayZones({ imageUrl, label, ratio, forbiddenRectsPct }) {
  if (!isEnabled()) return null;
  if (!imageUrl) return null;

  const t0 = Date.now();

  // Downsample via Cloudinary transform to keep the inline-data payload sane
  // (Gemini accepts image bytes inline, no URL fetching). 1024px wide is plenty
  // for spatial-zone reasoning — we don't need full resolution here.
  const fetchUrl = downsampledCloudinaryUrl(imageUrl, 1024);
  let imageBase64, mimeType;
  // Kept in scope so we can also derive the brightness grid from the same
  // bytes later — avoids a second download.
  let imgBuf = null;
  // Analyzed-image dimensions — attached to the artifact so a layout generator
  // can compute absolute pixel rects without a second lookup (rectPct stays
  // fractional; these are informational / for pixel-exact overlap math).
  let imageWidth = null, imageHeight = null;
  try {
    const imgRes = await axios.get(fetchUrl, { responseType: 'arraybuffer', timeout: 20000 });
    imgBuf = Buffer.from(imgRes.data);
    imageBase64 = imgBuf.toString('base64');
    mimeType = imgRes.headers['content-type'] || 'image/jpeg';
    try {
      const meta = await sharp(imgBuf).metadata();
      imageWidth  = meta.width  || null;
      imageHeight = meta.height || null;
    } catch (_) { /* probe is best-effort; dimensions stay null on failure */ }
  } catch (err) {
    console.warn(`   ⚠️  overlay-zones[${label}]: image fetch failed: ${err.message}`);
    return null;
  }

  const prompt = buildPrompt(ratio, forbiddenRectsPct);

  try {
    // 2.5 Pro's hidden reasoning spends from max_tokens (no thinkingBudget
    // knob on the OpenAI-compat path) — 8192 plus the transport's reserve
    // keeps headroom for the JSON body. responseSchema converts to strict
    // json_schema (probed working on Atlas's gemini routes).
    const res = await chatCompletion(
      { stage: 'overlay_zones', service: 'overlayZoneService', visionImages: 1 },
      {
        model: MODEL,
        messages: [{ role: 'user', content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } }
        ] }],
        temperature: 0.2,
        max_tokens: 8192,
        response_format: { type: 'json_schema', json_schema: { name: 'overlay_zones', strict: true, schema: RESPONSE_SCHEMA } }
      }
    );

    const choice = res.choices?.[0];
    const text = choice?.message?.content;
    if (!text) {
      const finishReason = choice?.finish_reason || 'unknown';
      const usage = res.usage || {};
      console.warn(`   ⚠️  overlay-zones[${label}]: empty response (finishReason=${finishReason}, tokens in=${usage.prompt_tokens || '?'} out=${usage.completion_tokens || 0} reasoning=${usage.completion_tokens_details?.reasoning_tokens || 0})`);
      return null;
    }

    let parsed;
    try { parsed = JSON.parse(text); }
    catch (err) {
      console.warn(`   ⚠️  overlay-zones[${label}]: JSON parse failed: ${err.message}`);
      return null;
    }

    // Stamp ids + clamp strictness so the UI can React-key each restriction
    // and the layout generator can trust the numeric range.
    const restrictions = (parsed.restrictions || []).map((r, i) => ({
      id:             `r${i + 1}`,
      rectPct:        r.rectPct,
      classification: RESTRICTION_CLASSES.includes(r.classification) ? r.classification : 'other',
      strictness:     Math.max(0, Math.min(1, Number(r.strictness) || 0)),
      reason:         typeof r.reason === 'string' ? r.reason : ''
    }));

    const densityGrid = sanitizeGrid(parsed.densityGrid);

    // Brightness grid — same dimensions as densityGrid so consumers can
    // correlate "busy-ness" with "is this area dark or bright" for the same
    // cell. Used by layout generators to pick text color (white on dark
    // regions, black on light). Computed server-side via sharp so it's
    // deterministic, not model-inferred.
    const gridCols = densityGrid.cols || 6;
    const gridRows = densityGrid.rows || 6;
    let brightnessGrid = { cols: gridCols, rows: gridRows, cells: [] };
    if (imgBuf) {
      try { brightnessGrid = await computeBrightnessGrid(imgBuf, gridCols, gridRows); }
      catch (err) { console.warn(`   ⚠️  overlay-zones[${label}]: brightness grid failed: ${err.message}`); }
    }

    const stamped = {
      schemaVersion:         SCHEMA_VERSION,
      imageWidth,
      imageHeight,
      densityGrid,
      brightnessGrid,
      restrictions,
      // Explicit hot-path lookup: the hard-rule product rect. Derivable from
      // restrictions[] but emitting it top-level saves every consumer from
      // writing the same filter.
      primarySubjectRectPct: derivePrimarySubjectRectPct(restrictions)
    };

    const hard = restrictions.filter(r => r.strictness >= 0.9).length;
    console.log(`   ✓ overlay-zones[${label}]: ${restrictions.length} restriction(s) (${hard} hard) ${imageWidth}x${imageHeight} brightness-grid ${gridCols}x${gridRows} in ${Date.now() - t0}ms`);
    return stamped;
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    console.warn(`   ⚠️  overlay-zones[${label}] failed in ${Date.now() - t0}ms: ${detail}`);
    return null;
  }
}

// Gemini occasionally returns 429/503 with "model is currently experiencing
// high demand" during overlay-zone fan-out (5 ratios in parallel hits the
// rate limiter). Treat these as transient and retry with exponential
// backoff + jitter. Hard errors (auth, malformed request) fail through
// immediately — only retry on overload-class signals.
async function postWithRetry({ url, body, timeout, label, maxAttempts = 3 }) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await axios.post(url, body, { timeout });
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      const msg = err.response?.data?.error?.message || err.message || '';
      const transient = status === 429 || status === 500 || status === 502 || status === 503 || status === 504
                     || /high demand|overloaded|rate limit|temporarily/i.test(msg);
      if (!transient || attempt === maxAttempts) throw err;
      const baseMs = 1000 * Math.pow(2, attempt - 1);     // 1s, 2s, 4s
      const jitterMs = Math.floor(Math.random() * 500);
      const waitMs = baseMs + jitterMs;
      console.warn(`   · overlay-zones[${label}]: transient (${status || 'net'}) — retry ${attempt}/${maxAttempts - 1} in ${waitMs}ms`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

function buildPrompt(ratio, forbiddenRectsPct) {
  // Caller-supplied forbidden rects (cross-frame safeRect for video,
  // platform UI bands for Reels). Injected as hard rules at the top
  // of the prompt so Gemini treats them as floor restrictions even
  // when the still doesn't visibly contain the subject — the still is
  // one frame and the rect represents motion across the whole clip.
  const forbiddenBlock = formatForbiddenRectsBlock(forbiddenRectsPct);

  return (
    `You are analyzing a finished marketing-creative image at aspect ratio ${ratio || 'unspecified'}. ` +
    `A downstream ad-layout generator needs to know which regions of the frame it MUST NOT cover with overlays (logo, headline, comments, CTAs, etc.). Your job is to identify those regions and rate each with a strictness score. The layout generator separately controls a "conservation level" slider that decides which strictness threshold to enforce.\n\n` +
    forbiddenBlock +

    `Return:\n` +
    `1) densityGrid — a visual-busyness heatmap. Use a SMALL grid to keep output compact: 8×6 for landscape, 6×8 for portrait, 6×10 for very tall (9:16). Each cell is a number 0–1 rounded to 1 decimal (e.g. 0.0, 0.3, 1.0): 0 = empty/uniform background, 1 = visually busy / contains subject / detailed texture.\n\n` +

    `2) restrictions — an array of regions where overlays should be avoided. Each entry:\n` +
    `   - rectPct: { x1, y1, x2, y2 } as fractions of the image dimensions, (0,0) top-left, (1,1) bottom-right. x2 > x1 and y2 > y1.\n` +
    `   - classification: one of ${JSON.stringify(RESTRICTION_CLASSES)}\n` +
    `   - strictness: 0.0–1.0. Higher = more important to preserve. Scoring guidance:\n` +
    `       • product             → 1.0   (the primary product or primary subject — ALWAYS 1.0, hard rule, never overlay)\n` +
    `       • face                → 0.9   (any human face or eyes)\n` +
    `       • secondary_subject   → 0.6 to 0.8   (another person, another product, a prominent prop)\n` +
    `       • text                → 0.4 to 0.6   (brand text, labels, signage that's preserve-worthy)\n` +
    `       • object              → 0.2 to 0.3   (incidental objects, non-critical props)\n` +
    `       • other               → your judgement within 0.1 to 0.5\n` +
    `   - reason: one short sentence (≤20 words) identifying what's in the rect.\n\n` +

    `HARD RULES:\n` +
    `- Include ONE restriction with classification="product" and strictness=1.0 covering the primary product / subject. This is non-negotiable.\n` +
    `- If any face is visible, include it at strictness ≥ 0.9.\n` +
    `- Err on the side of MORE restrictions with LOWER strictness rather than fewer — the slider lets the user dial in conservation level; missing a region entirely means it can never be protected.\n` +
    `- Coordinates strictly within [0, 1]. Rects should tightly bound their subject, not include generous padding.\n` +
    `- Do NOT suggest where overlays SHOULD go — only where they must NOT. The safe area is computed as "the whole frame minus active restrictions".`
  );
}

// Format caller-supplied forbidden rects (already in 0..1 fractions)
// as a hard-rule block at the top of the overlay-zone prompt. Each
// rect carries a `reason` so Gemini knows whether it's protecting a
// moving subject (cross-frame safeRect) or a platform UI band (Reels
// caption / actions strip).
function formatForbiddenRectsBlock(rects) {
  if (!Array.isArray(rects) || rects.length === 0) return '';
  const lines = rects.map(r => {
    const x1 = clamp01(Number(r.x1)).toFixed(3);
    const y1 = clamp01(Number(r.y1)).toFixed(3);
    const x2 = clamp01(Number(r.x2)).toFixed(3);
    const y2 = clamp01(Number(r.y2)).toFixed(3);
    const reason = r.reason ? ` — ${r.reason}` : '';
    return `   • x1=${x1} y1=${y1} x2=${x2} y2=${y2}${reason}`;
  });
  return (
    `CALLER-SUPPLIED FORBIDDEN REGIONS (hard rules, strictness=1.0):\n` +
    `These rects were computed from cross-frame motion analysis and/or platform UI placements that aren't visible in this single still. INCLUDE each as a restriction with strictness=1.0 IN ADDITION to the regions you identify visually. Coordinates are 0..1 fractions of the image.\n` +
    lines.join('\n') + '\n\n'
  );
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

// Average luminance per cell at the same dimensions as Gemini's densityGrid.
// Each cell is a number 0..1 where 0=black, 1=white. Layout consumers can
// sample the cell that overlaps their intended overlay placement to pick
// text color — dark text on bright cells, light text on dark cells.
async function computeBrightnessGrid(buf, cols, rows) {
  if (!cols || !rows) return { cols: 0, rows: 0, cells: [] };
  const raw = await sharp(buf)
    .greyscale()
    .resize(cols, rows, { fit: 'fill' })
    .raw()
    .toBuffer();
  const cells = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      // 2-decimal rounding keeps the artifact compact.
      row.push(Math.round((raw[r * cols + c] / 255) * 100) / 100);
    }
    cells.push(row);
  }
  return { cols, rows, cells };
}

// Pick the hard-rule product rect from the restrictions list. The prompt
// contract guarantees exactly one restriction with classification='product'
// and strictness=1.0, but we fall back to the highest-strictness product
// candidate if the model emits variations.
function derivePrimarySubjectRectPct(restrictions) {
  const products = (restrictions || [])
    .filter(r => r.classification === 'product')
    .sort((a, b) => (b.strictness || 0) - (a.strictness || 0));
  return products[0]?.rectPct || null;
}

function sanitizeGrid(grid) {
  if (!grid || !Array.isArray(grid.cells)) return { cols: 0, rows: 0, cells: [] };
  const rows = grid.cells.length;
  const cols = grid.cells[0]?.length || 0;
  return {
    cols: Number(grid.cols) || cols,
    rows: Number(grid.rows) || rows,
    cells: grid.cells.map(row => row.map(v => Math.max(0, Math.min(1, Number(v) || 0))))
  };
}

// Insert a w_<N> transform before the version segment so we download a
// downsampled copy. Cloudinary preserves aspect ratio when only width is set.
// If the URL already has a w_ transform we leave it alone to avoid stomping
// caller intent.
function downsampledCloudinaryUrl(url, maxWidth) {
  if (!url || !url.includes('/upload/')) return url;
  if (/\/w_\d+/.test(url)) return url;
  const transform = `w_${maxWidth},c_limit`;
  if (/\/v\d+\//.test(url)) {
    return url.replace(/\/(v\d+\/)/, `/${transform}/$1`);
  }
  return url.replace('/upload/', `/upload/${transform}/`);
}

module.exports = { analyzeOverlayZones, isEnabled, RESTRICTION_CLASSES, SCHEMA_VERSION };
