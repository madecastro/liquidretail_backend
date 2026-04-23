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

const MODEL = process.env.GEMINI_VISION_MODEL || 'gemini-2.5-pro';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

// Artifact schema version. Consumers should read this and refuse (or warn)
// on unknown majors. Bump when a field is removed/renamed; additive changes
// (new optional fields) don't require a bump.
const SCHEMA_VERSION = '2.1';

// Restriction classification taxonomy. Stable contract — adding values is
// backward-compatible, renaming/removing them is not.
const RESTRICTION_CLASSES = ['product', 'face', 'secondary_subject', 'text', 'object', 'other'];

function isEnabled() { return !!process.env.GEMINI_API_KEY; }

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
      required: ['cols', 'rows', 'cells']
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
        required: ['rectPct', 'classification', 'strictness', 'reason']
      }
    }
  },
  required: ['densityGrid', 'restrictions']
};

function rectPctSchema() {
  return {
    type: 'object',
    properties: {
      x1: { type: 'number' }, y1: { type: 'number' },
      x2: { type: 'number' }, y2: { type: 'number' }
    },
    required: ['x1', 'y1', 'x2', 'y2']
  };
}

// Analyze a single image. Returns the parsed analysis or null on any failure
// (caller treats null as a non-fatal degradation — the layout generator can
// still work for the other images on the same job).
async function analyzeOverlayZones({ imageUrl, label, ratio }) {
  if (!isEnabled()) return null;
  if (!imageUrl) return null;

  const t0 = Date.now();

  // Downsample via Cloudinary transform to keep the inline-data payload sane
  // (Gemini accepts image bytes inline, no URL fetching). 1024px wide is plenty
  // for spatial-zone reasoning — we don't need full resolution here.
  const fetchUrl = downsampledCloudinaryUrl(imageUrl, 1024);
  let imageBase64, mimeType;
  // Analyzed-image dimensions — attached to the artifact so a layout generator
  // can compute absolute pixel rects without a second lookup (rectPct stays
  // fractional; these are informational / for pixel-exact overlap math).
  let imageWidth = null, imageHeight = null;
  try {
    const imgRes = await axios.get(fetchUrl, { responseType: 'arraybuffer', timeout: 20000 });
    const buf = Buffer.from(imgRes.data);
    imageBase64 = buf.toString('base64');
    mimeType = imgRes.headers['content-type'] || 'image/jpeg';
    try {
      const meta = await sharp(buf).metadata();
      imageWidth  = meta.width  || null;
      imageHeight = meta.height || null;
    } catch (_) { /* probe is best-effort; dimensions stay null on failure */ }
  } catch (err) {
    console.warn(`   ⚠️  overlay-zones[${label}]: image fetch failed: ${err.message}`);
    return null;
  }

  const prompt = buildPrompt(ratio);

  try {
    const res = await axios.post(
      `${ENDPOINT}?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,
      {
        contents: [{
          role: 'user',
          parts: [
            { text: prompt },
            { inlineData: { mimeType, data: imageBase64 } }
          ]
        }],
        generationConfig: {
          temperature: 0.2,
          // 2.5 Pro's thinking tokens count against this same budget. 2500 was
          // being consumed almost entirely by thinking, leaving the structured
          // output truncated or empty.
          maxOutputTokens: 8192,
          // Cap thinking so we reliably have headroom for the JSON body.
          thinkingConfig: { thinkingBudget: 2048 },
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA
        }
      },
      { timeout: 60000 }
    );

    const candidate = res.data?.candidates?.[0];
    const text = candidate?.content?.parts?.[0]?.text;
    if (!text) {
      const finishReason = candidate?.finishReason || 'unknown';
      const usage = res.data?.usageMetadata || {};
      const blockReason = res.data?.promptFeedback?.blockReason;
      console.warn(`   ⚠️  overlay-zones[${label}]: empty response (finishReason=${finishReason}${blockReason ? ` blockReason=${blockReason}` : ''}, tokens in=${usage.promptTokenCount || '?'} out=${usage.candidatesTokenCount || 0} thought=${usage.thoughtsTokenCount || 0} total=${usage.totalTokenCount || '?'})`);
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

    const stamped = {
      schemaVersion:         SCHEMA_VERSION,
      imageWidth,
      imageHeight,
      densityGrid:           sanitizeGrid(parsed.densityGrid),
      restrictions,
      // Explicit hot-path lookup: the hard-rule product rect. Derivable from
      // restrictions[] but emitting it top-level saves every consumer from
      // writing the same filter.
      primarySubjectRectPct: derivePrimarySubjectRectPct(restrictions)
    };

    const hard = restrictions.filter(r => r.strictness >= 0.9).length;
    console.log(`   ✓ overlay-zones[${label}]: ${restrictions.length} restriction(s) (${hard} hard) ${imageWidth}x${imageHeight} in ${Date.now() - t0}ms`);
    return stamped;
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    console.warn(`   ⚠️  overlay-zones[${label}] failed in ${Date.now() - t0}ms: ${detail}`);
    return null;
  }
}

function buildPrompt(ratio) {
  return (
    `You are analyzing a finished marketing-creative image at aspect ratio ${ratio || 'unspecified'}. ` +
    `A downstream ad-layout generator needs to know which regions of the frame it MUST NOT cover with overlays (logo, headline, comments, CTAs, etc.). Your job is to identify those regions and rate each with a strictness score. The layout generator separately controls a "conservation level" slider that decides which strictness threshold to enforce.\n\n` +

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
