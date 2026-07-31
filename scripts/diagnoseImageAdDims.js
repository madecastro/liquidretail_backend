// diagnoseImageAdDims — sample recent HTML-rendered ad candidates and
// report the body dimensions the LLM actually authored vs. what the
// renderer clips to. If authored height exceeds the render clip, the
// bottom of the ad is cut off in the delivered PNG.
//
// Motivation: bug report — image ads at 9:16 and 1:1 have their bottoms
// clipped, but 4:5 is fine. Hypothesis: LLM authors body at delivery
// dims (e.g. 1080x1920) while renderer clips at normalized canvas
// (1000x1778). Author > clip → bottom cut.
//
// Usage:
//   node scripts/diagnoseImageAdDims.js
//   node scripts/diagnoseImageAdDims.js --limit 40
//   node scripts/diagnoseImageAdDims.js --ratio 9:16
//   node scripts/diagnoseImageAdDims.js --brand <brandId>

require('dotenv').config();
const mongoose = require('mongoose');
const AiCanvasArtifact = require('../models/AiCanvasArtifact');

const args = process.argv.slice(2);
function pickArg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

const LIMIT = Number(pickArg('--limit') || 30);
const RATIO_FILTER = pickArg('--ratio') || null;
const BRAND = pickArg('--brand') || null;

// Expected canvas dims — mirrors renderService.CANVAS_DIMS.
const EXPECTED_DIMS = {
  '1:1':    { w: 1000, h: 1000 },
  '4:5':    { w: 1000, h: 1250 },
  '9:16':   { w: 1000, h: 1778 },
  '16:9':   { w: 1000, h: 563  },
  '1.91:1': { w: 1000, h: 524  }
};

// Regex-scan the outputHtml for the body's declared width/height.
// LLM patterns vary: inline style, <style>body{...}</style>, or both.
function scanBodyDims(html) {
  if (!html || typeof html !== 'string') return null;

  // 1. Inline <body style="...width:...px;height:...px;...">.
  const inline = html.match(/<body[^>]*style\s*=\s*["']([^"']*)["']/i);
  if (inline) {
    const style = inline[1];
    const w = (style.match(/(?:^|;|\s)width\s*:\s*(\d+)\s*px/i) || [])[1];
    const h = (style.match(/(?:^|;|\s)height\s*:\s*(\d+)\s*px/i) || [])[1];
    if (w && h) return { source: 'inline', w: Number(w), h: Number(h) };
  }

  // 2. <style>...body{...width:...px;height:...px;...}...</style>.
  const styleTag = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  if (styleTag) {
    const css = styleTag[1];
    // Find body {...} block.
    const bodyBlock = css.match(/body\s*\{([^}]*)\}/i);
    if (bodyBlock) {
      const inner = bodyBlock[1];
      const w = (inner.match(/width\s*:\s*(\d+)\s*px/i) || [])[1];
      const h = (inner.match(/height\s*:\s*(\d+)\s*px/i) || [])[1];
      if (w && h) return { source: 'stylesheet', w: Number(w), h: Number(h) };
      if (h) return { source: 'stylesheet-h-only', w: null, h: Number(h) };
    }
  }

  // 3. html {...} block — sometimes html sets height.
  const styleTag2 = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  if (styleTag2) {
    const css = styleTag2[1];
    const htmlBlock = css.match(/html\s*\{([^}]*)\}/i);
    if (htmlBlock) {
      const inner = htmlBlock[1];
      const w = (inner.match(/width\s*:\s*(\d+)\s*px/i) || [])[1];
      const h = (inner.match(/height\s*:\s*(\d+)\s*px/i) || [])[1];
      if (w && h) return { source: 'html-block', w: Number(w), h: Number(h) };
    }
  }

  return { source: 'unmatched', w: null, h: null };
}

function verdict(expected, authored) {
  if (!expected || !authored) return '—';
  if (authored.w == null || authored.h == null) return 'PARTIAL';
  const wDelta = authored.w - expected.w;
  const hDelta = authored.h - expected.h;
  if (wDelta === 0 && hDelta === 0) return 'MATCH';
  if (hDelta > 0) return `BOTTOM CUT ${hDelta}px`;
  if (hDelta < 0) return `SHORT ${-hDelta}px`;
  return `WIDTH DELTA ${wDelta}`;
}

async function main() {
  const url = process.env.MONGO_URL || process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!url) { console.error('No MONGO URL in env.'); process.exit(1); }
  await mongoose.connect(url);

  const filter = { outputHtml: { $ne: null } };
  if (BRAND) filter.brandId = new mongoose.Types.ObjectId(BRAND);
  if (RATIO_FILTER) filter.aspectRatio = RATIO_FILTER;

  const rows = await AiCanvasArtifact.find(filter)
    .sort({ createdAt: -1 })
    .limit(LIMIT)
    .select('_id aspectRatio platformFormat outputHtml createdAt brandId')
    .lean();

  console.log('─'.repeat(120));
  console.log(`Sampled ${rows.length} recent HTML canvas artifacts`);
  if (RATIO_FILTER) console.log(`  ratio filter: ${RATIO_FILTER}`);
  if (BRAND) console.log(`  brand: ${BRAND}`);
  console.log('─'.repeat(120));
  console.log(
    'artifact'.padEnd(26) +
    'ratio'.padEnd(9) +
    'format'.padEnd(20) +
    'expected'.padEnd(14) +
    'authored'.padEnd(14) +
    'source'.padEnd(14) +
    'verdict'
  );
  console.log('─'.repeat(120));

  const counts = { MATCH: 0, PARTIAL: 0, 'BOTTOM CUT': 0, SHORT: 0, WIDTH_DELTA: 0, UNMATCHED: 0 };
  const perRatio = {};

  for (const r of rows) {
    const authored = scanBodyDims(r.outputHtml);
    const expected = EXPECTED_DIMS[r.aspectRatio];
    const v = verdict(expected, authored);
    const bucket = v.startsWith('BOTTOM CUT') ? 'BOTTOM CUT'
                : v.startsWith('SHORT') ? 'SHORT'
                : v.startsWith('WIDTH DELTA') ? 'WIDTH_DELTA'
                : v;
    counts[bucket] = (counts[bucket] || 0) + 1;
    perRatio[r.aspectRatio] = perRatio[r.aspectRatio] || {};
    perRatio[r.aspectRatio][bucket] = (perRatio[r.aspectRatio][bucket] || 0) + 1;

    const expStr = expected ? `${expected.w}×${expected.h}` : '?';
    const authStr = authored ? `${authored.w ?? '?'}×${authored.h ?? '?'}` : '?';
    console.log(
      String(r._id).padEnd(26) +
      String(r.aspectRatio || '?').padEnd(9) +
      String(r.platformFormat || '—').padEnd(20) +
      expStr.padEnd(14) +
      authStr.padEnd(14) +
      String(authored?.source || '—').padEnd(14) +
      v
    );
  }

  console.log('─'.repeat(120));
  console.log('Aggregate:');
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`);
  console.log('By aspect ratio:');
  for (const [ratio, buckets] of Object.entries(perRatio)) {
    const s = Object.entries(buckets).map(([k, v]) => `${k}=${v}`).join(', ');
    console.log(`  ${ratio}: ${s}`);
  }

  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
