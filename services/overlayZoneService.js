// Overlay zone analysis — given a finished crop image, ask Gemini Vision to
// identify safe regions where an ad-layout generator can place logos, copy,
// CTAs, and social-proof elements. Output is a structured JSON artifact that
// downstream layout services consume by job_id.
//
// Per-image output shape (the unit of analysis):
//   {
//     densityGrid: { cols, rows, cells: number[][] },   // 0 = empty, 1 = busy
//     zones:           [{ id, role, rectPct, contrastBg, score, reason }],
//     forbiddenRects:  [{ rectPct, reason }]
//   }
//
// rectPct uses fractional (0..1) coordinates so the artifact is
// resolution-independent — the layout generator places overlays on any output
// size by multiplying by the final canvas dimensions.

const axios = require('axios');

const MODEL = process.env.GEMINI_VISION_MODEL || 'gemini-2.5-pro';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

// Roles a zone can be assigned. Stable contract — adding/removing values is a
// breaking change for any downstream layout generator.
const ZONE_ROLES = ['logo', 'headline', 'product_detail', 'comments', 'social_stats', 'cta'];

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
    zones: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          role: { type: 'string', enum: ZONE_ROLES },
          rectPct: rectPctSchema(),
          contrastBg: { type: 'string', enum: ['dark', 'light', 'mixed'] },
          score: { type: 'number' },
          reason: { type: 'string' }
        },
        required: ['role', 'rectPct', 'contrastBg', 'score', 'reason']
      }
    },
    forbiddenRects: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          rectPct: rectPctSchema(),
          reason: { type: 'string' }
        },
        required: ['rectPct', 'reason']
      }
    }
  },
  required: ['densityGrid', 'zones', 'forbiddenRects']
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
  try {
    const imgRes = await axios.get(fetchUrl, { responseType: 'arraybuffer', timeout: 20000 });
    imageBase64 = Buffer.from(imgRes.data).toString('base64');
    mimeType = imgRes.headers['content-type'] || 'image/jpeg';
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
          maxOutputTokens: 2500,
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA
        }
      },
      { timeout: 45000 }
    );

    const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      console.warn(`   ⚠️  overlay-zones[${label}]: empty response`);
      return null;
    }

    let parsed;
    try { parsed = JSON.parse(text); }
    catch (err) {
      console.warn(`   ⚠️  overlay-zones[${label}]: JSON parse failed: ${err.message}`);
      return null;
    }

    // Stamp ids on zones so the UI can React-key them and the layout generator
    // can reference specific zones across runs.
    const stamped = {
      densityGrid:    sanitizeGrid(parsed.densityGrid),
      zones:          (parsed.zones || []).map((z, i) => ({ id: `z${i + 1}`, ...z })),
      forbiddenRects: parsed.forbiddenRects || []
    };

    console.log(`   ✓ overlay-zones[${label}]: ${stamped.zones.length} zone(s), ${stamped.forbiddenRects.length} forbidden in ${Date.now() - t0}ms`);
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
    `Identify regions where an ad-layout generator could safely place overlay elements WITHOUT covering the product, label/logo on the product, or human face/eyes.\n\n` +

    `Return:\n` +
    `1) densityGrid — a visual-busyness heatmap. cols × rows grid (use 12×9 for landscape, 9×12 for portrait, 9×16 for very tall). Each cell is a number 0–1: 0 = empty/uniform background, 1 = visually busy / contains subject / detailed texture.\n\n` +

    `2) zones — 4 to 8 candidate overlay rectangles. Each zone:\n` +
    `   - role: one of ${JSON.stringify(ZONE_ROLES)}\n` +
    `       • logo            — small (5–15% of frame), corner-preferred, very calm bg\n` +
    `       • headline        — wide horizontal band, ≤25% of frame height, top or bottom third\n` +
    `       • product_detail  — short label-style text near (but NOT overlapping) the product\n` +
    `       • comments        — TikTok/Reels-style stack, narrow vertical column, side-of-frame\n` +
    `       • social_stats    — small horizontal pill (likes/views/etc), corner or near comments\n` +
    `       • cta             — prominent button, 15–35% of frame width, bottom third typically\n` +
    `   - rectPct: { x1, y1, x2, y2 } as fractions of the image dimensions, where (0,0) is top-left and (1,1) is bottom-right. x2 > x1 and y2 > y1.\n` +
    `   - contrastBg: "dark" (overlay text should be light), "light" (overlay text dark), or "mixed" (needs a backdrop chip).\n` +
    `   - score: 0–1, your confidence this zone is genuinely safe and visually pleasant.\n` +
    `   - reason: one short sentence (≤20 words) explaining WHY this region is safe.\n\n` +

    `3) forbiddenRects — regions overlays must NEVER cover. Always include the primary subject's bounding rect and any visible logo or label on the product. Each entry has rectPct and a one-sentence reason.\n\n` +

    `Rules:\n` +
    `- Zones SHOULD NOT overlap forbiddenRects. Zones MAY overlap each other (the layout generator picks one of several candidates per role).\n` +
    `- Prefer the rule of thirds. Avoid placing zones dead-center unless the subject is off-center.\n` +
    `- Skip a role entirely rather than emit a low-quality zone for it. Better to return 4 strong zones than 8 mediocre ones.\n` +
    `- Coordinates strictly within [0, 1].`
  );
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

module.exports = { analyzeOverlayZones, isEnabled, ZONE_ROLES };
