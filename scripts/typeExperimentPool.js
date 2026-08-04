#!/usr/bin/env node
//
// typeExperimentPool.js — pick the master set for the TYPE EXPERIMENT and
// capture the baseline, in one re-runnable step.
//
// WHY THIS IS A SCRIPT AND NOT AN SSH ONE-LINER: the Render SSH gateway
// truncates any command over ~1KB, and every ad-hoc inline query hit that wall.
// It also has to be re-runnable — the owner asked for the whole workstream as a
// pipeline, not hand-stitched steps.
//
// $0. READ-ONLY against Mongo. It resolves fonts and brand tokens (local, cached
// font downloads) and fetches a 16px thumbnail per candidate seed image to
// measure lightness. It never submits a generation and never writes a document.
//
// The manifest it prints is the input to the arm sweeps, and its baseline
// renderUrls are the BEFORE column — capture them BEFORE re-titling, because a
// re-title overwrites Ad.renderUrl in place.
//
//   node scripts/typeExperimentPool.js --count=30 --out=/tmp/pool.json
//   node scripts/typeExperimentPool.js --count=30 --print
//   node scripts/typeExperimentPool.js --brands="AllBirds,Pelagic Gear" --count=6
//   node scripts/typeExperimentPool.js --allow-fontless   # opt out of the font gate
//
// SELECTION RULES
//  1. The ad must be re-titleable at $0: renderRoute 'veo', a renderUrl to use
//     as the baseline, and a veoVideoUrl master to re-title over.
//  2. THE BRAND MUST HAVE A REAL FONT (owner, 2026-08-04: "make sure that the
//     brands you choose have actual fonts in their records"). Enforced by
//     RESOLVING the brand's fonts through the live resolver and requiring the
//     heading face to come from an ingested file or a real Google family — not
//     the role default and not a tone-based library substitution. That is a
//     stronger test than "brand.fontFamily is non-null", which passes for
//     unrenderable strings like "ui-serif".
//  3. Variety is spread deliberately, not sampled: round-robin over brands, and
//     within a brand prefer an unseen aspect ratio, then an unseen composition
//     bucket (primarySubjectAreaFraction), then an unseen lightness bucket
//     (measured mean luminance of the seed image).

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'config', 'defaults.env') });
const mongoose = require('mongoose');
const fs = require('fs');
const axios = require('axios');
const sharp = require('sharp');

const Ad = require('../models/Ad');
const Brand = require('../models/Brand');
const Media = require('../models/Media');
const { buildBrandTokens } = require('../services/titleSpecService');

const args = process.argv.slice(2);
const flag = (name, def = null) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const has = (name) => args.includes(`--${name}`);

const COUNT = parseInt(flag('count', '30'), 10);
const OUT = flag('out', null);
const POOL_LIMIT = parseInt(flag('pool', '400'), 10);
const BRAND_FILTER = (flag('brands', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const ALLOW_FONTLESS = has('allow-fontless');
const PRINT = has('print');
// Test and scratch brand rows are real rows with real masters, so nothing else
// filters them — but "a mix of clients" (owner) does not mean two variants of the
// same client plus a row literally called Test. Overridable, and reported.
const DEFAULT_EXCLUDE = /(^|\s)test(\s|$|\d)|^ub\d+$/i;
const EXCLUDE = flag('exclude', null) ? new RegExp(flag('exclude'), 'i') : DEFAULT_EXCLUDE;
const NO_EXCLUDE = has('no-exclude');

// ── measurement ────────────────────────────────────────────────────────

/**
 * Mean luminance + a crude colourfulness score for an image, from a 16x16
 * thumbnail. Cheap enough to run over the whole candidate pool, and it is the
 * only honest way to spread the sample across light and dark footage — the
 * plate scan runs at titling time and is not persisted anywhere queryable.
 */
async function measureImage(url) {
  if (!url) return null;
  try {
    const res = await axios.get(url, {
      responseType: 'arraybuffer', timeout: 20000, maxRedirects: 3,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const { data, info } = await sharp(Buffer.from(res.data))
      .resize(16, 16, { fit: 'cover' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let lum = 0, satSum = 0;
    const px = info.width * info.height;
    for (let i = 0; i < data.length; i += info.channels) {
      const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
      lum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      satSum += mx === 0 ? 0 : (mx - mn) / mx;
    }
    return { lum: +(lum / px).toFixed(3), sat: +(satSum / px).toFixed(3) };
  } catch (err) {
    return { lum: null, sat: null, error: String(err.message || err).slice(0, 60) };
  }
}

const bucket3 = (v, lo, hi) => (v == null ? 'unknown' : v < lo ? 'low' : v < hi ? 'mid' : 'high');

// ── main ───────────────────────────────────────────────────────────────

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);

  const brands = await Brand.find({}).lean();
  const byId = new Map(brands.map((b) => [String(b._id), b]));

  // Resolve each brand's real type + ink ONCE. This is also the annotation the
  // comparison artifact needs: a font difference is only attributable if the
  // inputs are printed next to the render.
  const brandType = new Map();
  for (const b of brands) {
    if (BRAND_FILTER.length && !BRAND_FILTER.includes(b.name)) continue;
    try {
      const { colors, fonts } = await buildBrandTokens(b);
      brandType.set(String(b._id), {
        name: b.name,
        scanned: b.fontFamily || null,
        customFonts: (b.customFonts || []).length,
        fonts: {
          heading: { family: fonts.heading.family, source: fonts.heading.source, exact: fonts.heading.exact },
          body: { family: fonts.body.family, source: fonts.body.source, exact: fonts.body.exact },
          quote: { family: fonts.quote.family, source: fonts.quote.source, exact: fonts.quote.exact },
        },
        inks: {
          textPrimary: colors.textPrimary, textSecondary: colors.textSecondary,
          textOnLight: colors.textOnLight, primary: colors.primary, accent: colors.accent,
        },
        rating: b.brandReviews ? { r: b.brandReviews.rating ?? null, c: b.brandReviews.count ?? null } : null,
        // Reported because a brand-specific preset REPLACES the canonical type
        // decisions this experiment is testing. Two of the six art-directed
        // presets put a brand colour on letterforms (babyboo price digits =
        // accent #BA3357), which the canonical family never does — so a brand
        // pinned to one is not a valid row in an arm A/B comparison.
        titleStylePreset: b.titleStylePreset || null,
      });
    } catch (err) {
      console.warn(`⚠️  ${b.name}: token build failed — ${err.message}`);
    }
  }

  // A brand "has a real font" when its HEADING face is an ingested file or a
  // real Google family. 'library-match' means we substituted a lookalike and
  // 'default' means it has nothing at all — neither is the brand's own type.
  // The four source values fontResolverService can emit: 'custom' (an ingested
  // brand file), 'google' (a real Google family), 'library-match' (a lookalike
  // we substituted) and 'default' (the brand has nothing).
  const REAL_FONT_SOURCES = new Set(['custom', 'google']);
  const hasRealFont = (t) => !!t && REAL_FONT_SOURCES.has(t.fonts.heading.source) && t.fonts.heading.exact !== false;

  const ads = await Ad.find({
    renderRoute: 'veo',
    renderUrl: { $ne: null },
    veoVideoUrl: { $ne: null },
  }).select('brandId productId mediaId aspectRatio renderUrl veoVideoUrl status createdAt copy.headline')
    .sort({ createdAt: -1 }).limit(POOL_LIMIT).lean();

  const mediaIds = [...new Set(ads.map((a) => String(a.mediaId)).filter(Boolean))];
  const medias = await Media.find({ _id: { $in: mediaIds } })
    .select('fileUrl adSuitability.metrics.primarySubjectAreaFraction').lean();
  const byMedia = new Map(medias.map((m) => [String(m._id), m]));

  const candidates = [];
  const rejected = { noBrand: 0, noFont: 0, brandFilter: 0, excluded: 0 };
  const excludedBrands = new Set();
  for (const a of ads) {
    const t = brandType.get(String(a.brandId));
    if (!t) { rejected[BRAND_FILTER.length ? 'brandFilter' : 'noBrand']++; continue; }
    if (!NO_EXCLUDE && !BRAND_FILTER.length && EXCLUDE.test(t.name)) {
      rejected.excluded++; excludedBrands.add(t.name); continue;
    }
    if (!ALLOW_FONTLESS && !hasRealFont(t)) { rejected.noFont++; continue; }
    const m = byMedia.get(String(a.mediaId));
    candidates.push({
      adId: String(a._id),
      brand: t.name,
      brandId: String(a.brandId),
      mediaId: String(a.mediaId || ''),
      aspectRatio: a.aspectRatio,
      status: a.status,
      headline: (a.copy?.headline || '').slice(0, 60),
      baselineRenderUrl: a.renderUrl,
      masterUrl: a.veoVideoUrl,
      seedUrl: m?.fileUrl || null,
      subjectFraction: m?.adSuitability?.metrics?.primarySubjectAreaFraction ?? null,
      createdAt: a.createdAt,
    });
  }

  console.log(`📊 pool: ${ads.length} re-titleable ads → ${candidates.length} on brands with real type ` +
    `(rejected: ${rejected.noFont} fontless, ${rejected.noBrand} unresolvable brand, ` +
    `${rejected.brandFilter} filtered, ${rejected.excluded} test/scratch brands` +
    `${excludedBrands.size ? ` [${[...excludedBrands].join(', ')}]` : ''})`);
  const perBrand = {};
  for (const c of candidates) perBrand[c.brand] = (perBrand[c.brand] || 0) + 1;
  console.log('📊 candidates per brand:', JSON.stringify(perBrand));

  // Measure lightness on a first-pass shortlist rather than the whole pool:
  // round-robin over brands so the shortlist is already brand-diverse, then
  // measure, then use lightness as the final tiebreak.
  const byBrand = new Map();
  for (const c of candidates) {
    if (!byBrand.has(c.brand)) byBrand.set(c.brand, []);
    byBrand.get(c.brand).push(c);
  }
  const shortlist = [];
  const shortlistTarget = Math.min(candidates.length, COUNT * 3);
  let round = 0;
  while (shortlist.length < shortlistTarget) {
    let added = 0;
    for (const [, list] of byBrand) {
      if (list[round]) { shortlist.push(list[round]); added++; }
      if (shortlist.length >= shortlistTarget) break;
    }
    if (!added) break;
    round++;
  }

  process.stdout.write(`🔍 measuring ${shortlist.length} seed images`);
  for (const c of shortlist) {
    const meas = await measureImage(c.seedUrl);
    c.seedLum = meas?.lum ?? null;
    c.seedSat = meas?.sat ?? null;
    process.stdout.write('.');
  }
  process.stdout.write('\n');

  // Final pick. Greedy over a novelty score: an unseen brand beats an unseen
  // aspect ratio beats an unseen composition bucket beats an unseen lightness
  // bucket. Deterministic — no randomness, so a re-run reproduces the set.
  const seen = { brand: new Set(), ar: new Set(), comp: new Set(), lum: new Set(), pair: new Set(), media: new Set() };
  const picked = [];
  const remaining = [...shortlist];
  while (picked.length < COUNT && remaining.length) {
    let best = null, bestScore = -1;
    for (const c of remaining) {
      const comp = bucket3(c.subjectFraction, 0.25, 0.5);
      const lum = bucket3(c.seedLum, 0.35, 0.6);
      let score = 0;
      if (!seen.brand.has(c.brand)) score += 1000;
      if (!seen.ar.has(c.aspectRatio)) score += 300;
      // DIFFERENT FOOTAGE, not just a different row. The first run picked three
      // ads off one media (identical lum 0.843) and called it variety — they are
      // the same picture at three crops, which tests nothing about colour or
      // composition.
      if (c.mediaId && !seen.media.has(c.mediaId)) score += 250;
      if (!seen.pair.has(`${c.brand}|${c.aspectRatio}`)) score += 120;
      if (!seen.comp.has(comp)) score += 60;
      if (!seen.lum.has(lum)) score += 60;
      if (!seen.comp.has(`${c.brand}|${comp}`)) score += 20;
      if (!seen.lum.has(`${c.brand}|${lum}`)) score += 20;
      // An unmeasured seed carries no variety information, so it must not beat a
      // measured one for the same slot.
      if (c.seedLum == null) score -= 200;
      if (c.subjectFraction == null) score -= 50;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    const comp = bucket3(best.subjectFraction, 0.25, 0.5);
    const lum = bucket3(best.seedLum, 0.35, 0.6);
    seen.brand.add(best.brand); seen.ar.add(best.aspectRatio);
    if (best.mediaId) seen.media.add(best.mediaId);
    seen.pair.add(`${best.brand}|${best.aspectRatio}`);
    seen.comp.add(comp); seen.comp.add(`${best.brand}|${comp}`);
    seen.lum.add(lum); seen.lum.add(`${best.brand}|${lum}`);
    best.compBucket = comp; best.lumBucket = lum;
    picked.push(best);
    remaining.splice(remaining.indexOf(best), 1);
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    count: picked.length,
    requestedCount: COUNT,
    fontGate: !ALLOW_FONTLESS,
    brands: Object.fromEntries([...new Set(picked.map((p) => p.brandId))]
      .map((id) => [brandType.get(id).name, brandType.get(id)])),
    coverage: {
      brands: [...new Set(picked.map((p) => p.brand))],
      aspectRatios: [...new Set(picked.map((p) => p.aspectRatio))],
      compBuckets: countBy(picked, 'compBucket'),
      lumBuckets: countBy(picked, 'lumBucket'),
    },
    ads: picked,
  };

  if (OUT) { fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2)); console.log(`📝 wrote ${OUT}`); }
  if (PRINT || !OUT) {
    console.log('\n== SELECTED ==');
    for (const p of picked) {
      const t = brandType.get(p.brandId);
      console.log([p.adId, p.brand, p.aspectRatio, `subj=${p.subjectFraction ?? '?'}/${p.compBucket}`,
        `lum=${p.seedLum ?? '?'}/${p.lumBucket}`, `sat=${p.seedSat ?? '?'}`,
        `font=${t.fonts.heading.family}(${t.fonts.heading.source})`].join('\t'));
    }
    console.log('\n== COVERAGE ==');
    console.log(JSON.stringify(manifest.coverage, null, 2));
    console.log('\n== IDS ==');
    console.log(picked.map((p) => p.adId).join(','));
  }
  if (!OUT) console.log('\n(no --out given; manifest not persisted)');

  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => { console.error('💥', err); process.exit(1); });

function countBy(list, key) {
  const out = {};
  for (const x of list) out[x[key]] = (out[x[key]] || 0) + 1;
  return out;
}
