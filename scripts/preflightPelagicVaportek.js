// Phase-1 pre-flight for the "Vaportek Hooded Fishing Shirt" ad run.
// Zero cost — DB reads + local reframeStrategyChooser evaluation only.
//
// Answers:
//   1. Which specific Vaportek product should we target?
//   2. What's the Media state (hero + alts, source, dims, refinedProducts)?
//   3. Would reframeStrategyChooser return 'skip' / 'crop' / 'defer' for each
//      reference × Meta target aspect (9:16, 1:1, 4:5)?
//   4. Expected paid vs free reframes → predicted $ spend PER MASTER before
//      Omni/gpt-image-2 costs.

'use strict';
require('dotenv').config();
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'config', 'defaults.env') });

// reframeStrategyChooser is kill-switched off by default (REFRAME_STRATEGY=
// outpaint-only). Turn it on for this preview so chooseStrategy actually
// makes a decision instead of returning defer immediately.
process.env.REFRAME_STRATEGY = process.env.REFRAME_STRATEGY || 'crop-first';

const mongoose = require('mongoose');
const Brand = require('../models/Brand');
const Media = require('../models/Media');
const CatalogProduct = require('../models/CatalogProduct');
const { chooseStrategy } = require('../services/reframeStrategyChooser');

const META_ASPECTS = [
  { ratio: '9:16', surface: 'meta_stories_9_16 (MASTER)' },
  { ratio: '1:1',  surface: 'meta_feed_1_1 (derive from 9:16)' },
  { ratio: '4:5',  surface: 'meta_feed_4_5 (derive from 9:16)' }
];

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);

  const brand = await Brand.findOne({ name: 'Pelagic Gear 4 Demos' }).lean();
  if (!brand) throw new Error('Brand not found');

  // Find Vaportek Hooded Fishing Shirt candidates.
  const candidates = await CatalogProduct.find({
    brandId: brand._id,
    title: { $regex: /vaportek/i },
    productUrl: { $nin: [null, ''] }
  })
    .select('_id title imageMediaId additionalImageMediaIds category imageUrl')
    .lean();

  console.log(`\n── Vaportek candidates: ${candidates.length} ──`);
  const scored = [];
  for (const p of candidates) {
    const altCount = (p.additionalImageMediaIds || []).length;
    const heroOK = !!p.imageMediaId;
    const looksLikeHoodedShirt = /hood/i.test(p.title) || /shirt/i.test(p.title);
    scored.push({ p, altCount, heroOK, looksLikeHoodedShirt });
    console.log(`  ${p.title.padEnd(50)}  hero=${heroOK ? 'Y' : 'N'} alts=${altCount} hooded?=${looksLikeHoodedShirt}`);
  }

  // Score each candidate by (a) hero materialized, (b) looks like a hooded
  // fishing shirt, (c) alts, AND critically (d) whether its Media were
  // refined by the NEW Grounding DINO path (source='synthesized') vs the
  // OLD cropRefineService fallback (source=undefined). We want to test the
  // full new pipeline so a synthesized product is strongly preferred.
  for (const s of scored) {
    const mids = [s.p.imageMediaId, ...(s.p.additionalImageMediaIds || [])].filter(Boolean);
    const sample = await Media.find({ _id: { $in: mids } })
      .select('refinedProducts yoloDetectedAt').limit(3).lean();
    s.synthesizedShare = 0;
    let checked = 0;
    for (const m of sample) {
      const r = Array.isArray(m.refinedProducts) ? m.refinedProducts[0] : null;
      if (r) {
        checked++;
        if (r.source === 'synthesized') s.synthesizedShare++;
      }
    }
    s.synthesizedShare = checked ? s.synthesizedShare / checked : 0;
    s.yoloStamped = sample.every((m) => m.yoloDetectedAt);
  }
  scored.sort((a, b) => {
    if (b.heroOK !== a.heroOK) return b.heroOK - a.heroOK;
    if (b.yoloStamped !== a.yoloStamped) return b.yoloStamped - a.yoloStamped;
    if (b.synthesizedShare !== a.synthesizedShare) return b.synthesizedShare - a.synthesizedShare;
    if (b.looksLikeHoodedShirt !== a.looksLikeHoodedShirt) return b.looksLikeHoodedShirt - a.looksLikeHoodedShirt;
    return b.altCount - a.altCount;
  });

  console.log('\n── Ranked (synthesized share × alts × hooded-like) ──');
  for (const s of scored.slice(0, 8)) {
    console.log(`  ${s.p.title.padEnd(45)}  hero=${s.heroOK ? 'Y' : 'N'} alts=${s.altCount} synthesized=${(s.synthesizedShare * 100).toFixed(0)}% yoloStamped=${s.yoloStamped}`);
  }
  const pick = scored[0];
  if (!pick) throw new Error('No Vaportek candidate found');

  console.log(`\n── Selected product: "${pick.p.title}" (${pick.p._id}) ──`);
  console.log(`  category:  ${pick.p.category || 'n/a'}`);
  console.log(`  imageUrl:  ${pick.p.imageUrl}`);
  console.log(`  hero + alts: ${1 + pick.altCount} Media`);

  // Pull hero + all alts.
  const mediaIds = [pick.p.imageMediaId, ...(pick.p.additionalImageMediaIds || [])].filter(Boolean);
  const medias = await Media.find({ _id: { $in: mediaIds } })
    .select('_id fileUrl width height source refinedProducts yoloDetectedAt yoloFailReason metadata.imageRole metadata.feedIndex')
    .lean();
  const byId = new Map(medias.map(m => [String(m._id), m]));

  // Per-Media summary + reframe prediction against each Meta aspect.
  const outcomes = [];
  for (const id of mediaIds) {
    const m = byId.get(String(id));
    if (!m) { console.log(`\n  ⚠️  Media ${id}: NOT FOUND`); continue; }
    const refined = Array.isArray(m.refinedProducts) ? m.refinedProducts : [];
    const source = refined.length ? (refined[0].source || 'MISSING') : '-';
    const label = refined.length ? (refined[0].label || refined[0].className || '-') : '-';
    console.log(`\n  ${m.metadata?.imageRole || '?'} feedIndex=${m.metadata?.feedIndex ?? '?'} — ${m._id}`);
    console.log(`    dims: ${m.width}×${m.height} (aspect=${(m.width / m.height).toFixed(3)})`);
    console.log(`    fileUrl (Cloudinary): ${m.fileUrl?.slice(0, 100)}...`);
    console.log(`    refinedProducts: ${refined.length}  source=${source}  label="${label}"`);
    console.log(`    yoloDetectedAt: ${m.yoloDetectedAt || 'null'}`);
    if (refined.length) {
      const b = refined[0];
      console.log(`    refined[0] bbox: (${b.x1},${b.y1})→(${b.x2},${b.y2})  ${b.x2 - b.x1}×${b.y2 - b.y1}`);
    }
    // Now run reframeStrategyChooser against each Meta aspect.
    for (const a of META_ASPECTS) {
      const decision = chooseStrategy({ media: m, aspectRatio: a.ratio, sourceUrl: m.fileUrl });
      const marker = decision.action === 'skip' ? '✓ SKIP (aspect match, $0)'
                   : decision.action === 'crop' ? '✓ CROP ($0)'
                   : `✗ DEFER → paid outpaint (~$0.08)`;
      console.log(`    ${a.ratio.padEnd(4)} (${a.surface.padEnd(35)}): ${marker}  — ${decision.reason || ''}`);
      outcomes.push({ mediaId: id, mediaRole: m.metadata?.imageRole, aspect: a.ratio, action: decision.action, reason: decision.reason });
    }
  }

  // Aggregate: what would the paid Meta run look like?
  console.log(`\n── Aggregate reframe prediction ──`);
  const byActionAndAspect = new Map();
  for (const o of outcomes) {
    const k = `${o.aspect}:${o.action}`;
    byActionAndAspect.set(k, (byActionAndAspect.get(k) || 0) + 1);
  }
  for (const a of META_ASPECTS) {
    const skip = byActionAndAspect.get(`${a.ratio}:skip`) || 0;
    const crop = byActionAndAspect.get(`${a.ratio}:crop`) || 0;
    const defer = byActionAndAspect.get(`${a.ratio}:defer`) || 0;
    const paidCost = defer * 0.08;
    console.log(`  ${a.ratio.padEnd(4)}  skip=${skip}  crop=${crop}  DEFER (paid)=${defer}   → $${paidCost.toFixed(2)} reframe`);
  }
  const totalDefers = outcomes.filter(o => o.action === 'defer').length;
  const totalCosts = totalDefers * 0.08;

  console.log(`\n── Full Meta run cost estimate ──`);
  console.log(`  Reframe outpaint (${totalDefers} defers × $0.08):     $${totalCosts.toFixed(2)}`);
  console.log(`  Meta static fanout (3 sizes × ~$0.07):     $0.21`);
  console.log(`  Meta video master (1 Omni × ~$0.90):       $0.90`);
  console.log(`  Director LLM (~$0.05-0.10 per product):    $0.10`);
  console.log(`                                             ──────`);
  console.log(`  TOTAL PROJECTED:                           $${(1.21 + totalCosts).toFixed(2)}`);

  console.log(`\nProduct ID for the paid Phase 2 run: ${pick.p._id}`);

  await mongoose.disconnect();
})().catch((err) => { console.error(err); process.exit(1); });
