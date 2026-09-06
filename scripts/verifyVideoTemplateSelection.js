#!/usr/bin/env node
'use strict';
/**
 * verifyVideoTemplateSelection — deterministic video Ad.template picker.
 *
 * Offline (default): fixture CatalogProduct-shaped objects, no DB, no
 * network, no API key. Pins that expandDeterministicVideo no longer
 * hardcodes ai_brand_led, that the selector picks social_proof_led for a
 * rated product / a quoted-but-unrated product and editorial for neither,
 * and that it never returns the silent brand_led default.
 *
 * Optional `--live`: read-only CatalogProduct find+project (same write-
 * safety shape as liquidretail_adgen's scripts/inspectAd.js — find only,
 * no caller-supplied filter, explicit projection). Reports what the REAL
 * catalog distribution would look like. Missing URI or a connect failure
 * is an INFO skip, not a fail — `npm test` does not pass `--live`.
 *
 *   node scripts/verifyVideoTemplateSelection.js
 *   node scripts/verifyVideoTemplateSelection.js --live
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

function ensureHttpsProxyAgent() {
  try {
    require.resolve('https-proxy-agent');
    return 'present';
  } catch { /* fall through */ }
  const orig = Module._load;
  Module._load = function loadStub(request, parent, isMain) {
    if (request === 'https-proxy-agent') {
      return function HttpsProxyAgent() { return {}; };
    }
    return orig.apply(this, arguments);
  };
  return 'stub';
}
ensureHttpsProxyAgent();

const ROOT = path.join(__dirname, '..');
const SRC_SEL = path.join(ROOT, 'services', 'videoTemplateSelection.js');
const SRC_CAG = path.join(ROOT, 'services', 'campaignAdsGenerationService.js');

const {
  selectVideoTemplate,
  hasUsableVideoRating,
  hasUsableVideoQuote,
  TEMPLATE_SOCIAL_PROOF,
  TEMPLATE_FLOOR,
  MIN_STORE_REVIEW_COUNT,
} = require('../services/videoTemplateSelection');
// This repo has no templateIntent.js (that module is adgen render-time).
// The same mapping lives on the static path and is what lifestyle video
// prompt guidance already mirrors (atlasVideoService.lifestyleIntentFromTemplate).
const { intentForTemplate } = require('../services/directImageRenderService');
const DEFAULT_INTENT = 'product_first_lifestyle';

let passed = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) { passed += 1; return; }
  failures.push(detail ? `${label} — ${detail}` : label);
}

const KEEP_QUOTE = 'The quality is amazing and they fit true to size.';

function scrapedReviews({ rating, reviewCount, quotes }) {
  return {
    quotesOrigin: 'scraped',
    source: 'productReviewsScrape',
    rating,
    reviewCount,
    quotes: quotes || []
  };
}

function quote(text, extra) {
  return {
    text,
    origin: 'scraped',
    verbatim: true,
    rating: 5,
    author_name: 'Jamie L.',
    ...(extra || {})
  };
}

// ── A. Behaviour: rated / quoted / neither ─────────────────────────────

{
  const product = {
    title: 'Performance Tee',
    rating: 4.8,
    productReviews: scrapedReviews({ rating: 4.8, reviewCount: 200 })
  };
  check('A rated+counted product → ai_social_proof_led',
    selectVideoTemplate({ product }) === TEMPLATE_SOCIAL_PROOF,
    `got ${selectVideoTemplate({ product })}`);
  check('A rated arm is the reason (no quotes)',
    hasUsableVideoRating(product) === true && hasUsableVideoQuote(product) === false);
}

{
  const product = {
    title: 'Performance Tee',
    productReviews: scrapedReviews({
      rating: null,
      reviewCount: null,
      quotes: [quote(KEEP_QUOTE)]
    })
  };
  check('A quoted-but-unrated → ai_social_proof_led',
    selectVideoTemplate({ product }) === TEMPLATE_SOCIAL_PROOF,
    `got ${selectVideoTemplate({ product })}`);
  check('A quote arm is the reason (no printable rating pair)',
    hasUsableVideoRating(product) === false && hasUsableVideoQuote(product) === true);
}

{
  const product = { title: 'Performance Tee' };
  check('A neither rating nor quote → ai_editorial',
    selectVideoTemplate({ product }) === TEMPLATE_FLOOR,
    `got ${selectVideoTemplate({ product })}`);
}

check('A null product → floor',
  selectVideoTemplate({ product: null }) === TEMPLATE_FLOOR);
check('A empty call → floor',
  selectVideoTemplate() === TEMPLATE_FLOOR);

// ── B. Honesty: lone 5.0, withheld llm-web count, immersive-only ──────

{
  const product = {
    title: 'Performance Tee',
    productReviews: scrapedReviews({ rating: 5.0, reviewCount: 1 })
  };
  check('B lone 5.0 from one review → editorial (not social_proof)',
    selectVideoTemplate({ product }) === TEMPLATE_FLOOR,
    `got ${selectVideoTemplate({ product })}`);
  check('B MIN_STORE_REVIEW_COUNT is 2', MIN_STORE_REVIEW_COUNT === 2);
}

{
  const product = {
    title: 'Performance Tee',
    productReviews: scrapedReviews({ rating: 4.8, reviewCount: 12 })
  };
  check('B 4.8 from 12 scraped reviews → social_proof (above lone-review floor)',
    selectVideoTemplate({ product }) === TEMPLATE_SOCIAL_PROOF,
    `got ${selectVideoTemplate({ product })}`);
}

{
  // llm-web count is another site's total — pickAtomicProductRatingPair
  // withholds it. Rating-only must not make the number the hero.
  const product = {
    title: 'Performance Tee',
    productReviews: {
      quotesOrigin: 'llm-web',
      ratingSource: 'gemini',
      rating: 5.0,
      reviewCount: 3,
      quotes: []
    }
  };
  check('B llm-web 5.0 from 3 (count withheld) → editorial',
    selectVideoTemplate({ product }) === TEMPLATE_FLOOR,
    `got ${selectVideoTemplate({ product })}`);
}

{
  const product = { title: 'Performance Tee', rating: 4.8 };
  check('B immersive rating with no store count → editorial',
    selectVideoTemplate({ product }) === TEMPLATE_FLOOR,
    `got ${selectVideoTemplate({ product })}`);
}

{
  // reviews.length is a capped Immersive sample — must not become a total.
  const product = {
    title: 'Performance Tee',
    rating: 5.0,
    reviews: [{ text: 'Great', rating: 5 }]
  };
  check('B reviews.length is not a store total → editorial',
    selectVideoTemplate({ product }) === TEMPLATE_FLOOR,
    `got ${selectVideoTemplate({ product })}`);
}

// ── C. Same print bar as ratingDisplay (stars that will not print) ─────

{
  const product = {
    title: 'Performance Tee',
    productReviews: scrapedReviews({ rating: 3.3, reviewCount: 41000 })
  };
  check('C 3.3 / 41000 fails the star floor → editorial',
    selectVideoTemplate({ product }) === TEMPLATE_FLOOR,
    `got ${selectVideoTemplate({ product })}`);
}

{
  const product = {
    title: 'Performance Tee',
    productReviews: scrapedReviews({ rating: 4.3, reviewCount: 17001 })
  };
  check('C 4.3 / 17001 clears the volume exception → social_proof',
    selectVideoTemplate({ product }) === TEMPLATE_SOCIAL_PROOF,
    `got ${selectVideoTemplate({ product })}`);
}

{
  const product = {
    title: 'Performance Tee',
    productReviews: scrapedReviews({ rating: 4.4, reviewCount: 80 })
  };
  check('C displayed 4.4 is the owner print floor → social_proof',
    selectVideoTemplate({ product }) === TEMPLATE_SOCIAL_PROOF,
    `got ${selectVideoTemplate({ product })}`);
}

// ── D. Never the silent default; floor maps to the always-eligible intent

const FIXTURES = [
  null,
  {},
  { title: 'X' },
  { title: 'X', rating: 5, reviews: [{ text: 'a' }] },
  { title: 'X', productReviews: scrapedReviews({ rating: 5, reviewCount: 1 }) },
  { title: 'X', productReviews: scrapedReviews({ rating: 4.8, reviewCount: 200 }) },
  { title: 'X', productReviews: scrapedReviews({ rating: null, reviewCount: null, quotes: [quote(KEEP_QUOTE)] }) },
];
for (const product of FIXTURES) {
  const got = selectVideoTemplate({ product });
  check(`D never ai_brand_led (${JSON.stringify(product && product.productReviews ? product.productReviews.reviewCount : product && product.rating)})`,
    got !== 'ai_brand_led' && got !== 'ai_ugc_led' && got !== 'ai_promotional',
    `got ${got}`);
}

check('D social_proof template maps to social_proof_led intent',
  intentForTemplate(TEMPLATE_SOCIAL_PROOF) === 'social_proof_led');
check('D editorial floor maps to DEFAULT_INTENT (product_first_lifestyle)',
  intentForTemplate(TEMPLATE_FLOOR) === DEFAULT_INTENT);

check('D selector is synchronous (no Promise)',
  !(selectVideoTemplate({ product: { title: 'X' } }) && typeof selectVideoTemplate({ product: { title: 'X' } }).then === 'function'));

// ── E. Wiring: mint site no longer hardcodes; digest ignores template ─

const selSrc = fs.readFileSync(SRC_SEL, 'utf8');
const cagSrc = fs.readFileSync(SRC_CAG, 'utf8');

check('E selector module does not call Atlas / LLM / generateForAd',
  !/\b(generateForAd|chatCompletion|submitGeneration|generateImage|generateVideo)\b/.test(selSrc));

check('E expandDeterministicVideo payload calls selectVideoTemplate',
  /template:\s*selectVideoTemplate\(\{\s*product:/.test(cagSrc));

{
  const detFn = cagSrc.match(/async function expandDeterministicVideo\([\s\S]*?\n  console\.log\(\n    `📦 expandDeterministicVideo:/);
  check('E expandDeterministicVideo function extracted', !!detFn);
  if (detFn) {
    check('E expandDeterministicVideo has no template: \'ai_brand_led\' literal',
      !/template:\s*'ai_brand_led'/.test(detFn[0]));
  }
}

// SCOPE FENCE. This feature changes the DETERMINISTIC-VIDEO mint only.
// An earlier draft also repointed the CONCEPT-DRIVEN (static) fallback for an
// unrecognised creative_style from 'ai_brand_led' to 'ai_editorial'. That was
// reverted deliberately: CLAUDE.md documents ai_brand_led as the Director's
// "default of last resort", and the owner-approved remedy for brand_led
// over-representation was per-style prompt guidance (buildPromptRound), NOT
// changing this fallback. ai_editorial is also unmapped in TEMPLATE_INTENT and
// silently descends to product_first_lifestyle, so the swap would have changed
// static intent selection as a side effect of a video-only change.
// These two checks keep that fence standing.
check('E concept-driven (static) fallback still ai_brand_led — video change must not touch it',
  /CREATIVE_STYLE_TO_TEMPLATE\[creativeStyle\] \|\| 'ai_brand_led'/.test(cagSrc));
check('E no CONCEPT_TEMPLATE_FALLBACK indirection reintroduced',
  !/CONCEPT_TEMPLATE_FALLBACK/.test(cagSrc));

{
  const digestFn = cagSrc.match(/function computeDeterministicVideoDigest\([\s\S]*?return crypto\.createHash/);
  check('E computeDeterministicVideoDigest extracted', !!digestFn);
  if (digestFn) {
    check('E video identity digest does not include template (re-Generate must not re-bill)',
      !/\btemplate\b/.test(digestFn[0]));
  }
}

check('E mint site batch-loads CatalogProduct with an _id $in (not a collection scan)',
  /CatalogProduct\.find\(\{\s*_id:\s*\{\s*\$in:\s*oids\s*\}\s*\}\)/.test(cagSrc));
check('E mint site projection is title/rating/productReviews only',
  /\.select\('_id title rating productReviews'\)/.test(cagSrc));

{
  const kindVideo = [...cagSrc.matchAll(/kind:\s*'video'/g)];
  // expandDeterministicVideo stamps kind: 'video' once; concept-driven
  // stamps `kind` from resolvedKinds (variable), not the literal.
  // adRegenerateService's kind:'video' is a sibling-find filter, not this file.
  check('E campaignAdsGenerationService has exactly one kind: \'video\' literal (the det payload)',
    kindVideo.length === 1,
    `got ${kindVideo.length}`);
}

// ── Optional live simulation ───────────────────────────────────────────

async function runLiveSimulation() {
  const wantLive = process.argv.includes('--live');
  if (!wantLive) {
    console.log('LIVE  skipped (pass --live to sample CatalogProduct; npm test does not)');
    return;
  }

  try {
    require('dotenv').config();
  } catch { /* optional */ }

  function resolveUri() {
    if (process.env.MONGODB_URI) return process.env.MONGODB_URI.trim();
    const fromFileEnv = process.env.ADGEN_MONGODB_URI_FILE;
    const candidates = [
      fromFileEnv,
      path.join(os.homedir(), 'Documents', 'API Keys', 'mongodb-URI-RS.txt'),
    ].filter(Boolean);
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) {
          const raw = fs.readFileSync(p, 'utf8').trim();
          if (raw) return raw.split(/\r?\n/)[0].trim();
        }
      } catch { /* next */ }
    }
    return null;
  }

  const uri = resolveUri();
  if (!uri) {
    console.log('LIVE  skipped — no MongoDB URI (MONGODB_URI / ADGEN_MONGODB_URI_FILE / ~/Documents/API Keys/mongodb-URI-RS.txt)');
    return;
  }

  let mongoose;
  try {
    mongoose = require('mongoose');
  } catch (err) {
    console.log(`LIVE  skipped — mongoose not loadable (${err.message})`);
    return;
  }

  const CatalogProduct = require('../models/CatalogProduct');
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  } catch (err) {
    const redacted = String(err.message || err).replace(/mongodb(\+srv)?:\/\/[^\s"']+/gi, 'mongodb://<redacted>');
    console.log(`LIVE  skipped — connect failed (${redacted})`);
    return;
  }

  try {
    // WRITE-SAFETY: find + select only. Committed filter, not caller-supplied.
    // Bound by limit + maxTimeMS. No update / insert / delete / aggregate-$out.
    const docs = await CatalogProduct.find({ draft: { $ne: true }, isPrimaryVariant: { $ne: false } })
      .select('_id title rating productReviews')
      .limit(2000)
      .maxTimeMS(15000)
      .lean();

    const counts = { ai_social_proof_led: 0, ai_editorial: 0, other: 0 };
    let ratingArm = 0;
    let quoteArm = 0;
    let both = 0;
    const origLog = console.log;
    const origWarn = console.warn;
    console.log = () => {};
    console.warn = () => {};
    try {
      for (const product of docs) {
        const t = selectVideoTemplate({ product });
        if (t === TEMPLATE_SOCIAL_PROOF) counts.ai_social_proof_led += 1;
        else if (t === TEMPLATE_FLOOR) counts.ai_editorial += 1;
        else counts.other += 1;
        const r = hasUsableVideoRating(product);
        const q = hasUsableVideoQuote(product);
        if (r) ratingArm += 1;
        if (q) quoteArm += 1;
        if (r && q) both += 1;
      }
    } finally {
      console.log = origLog;
      console.warn = origWarn;
    }
    const n = docs.length;
    const pct = (x) => n ? `${((x / n) * 100).toFixed(1)}%` : 'n/a';
    console.log(`LIVE  n=${n} CatalogProduct (draft≠true, primary, cap 2000)`);
    console.log(`LIVE  ai_social_proof_led ${counts.ai_social_proof_led} (${pct(counts.ai_social_proof_led)})`);
    console.log(`LIVE  ai_editorial        ${counts.ai_editorial} (${pct(counts.ai_editorial)})`);
    console.log(`LIVE  other               ${counts.other} (${pct(counts.other)})`);
    console.log(`LIVE  rating-arm ${ratingArm}  quote-arm ${quoteArm}  both ${both}`);
    check('LIVE never produced ai_brand_led / ugc / promotional',
      counts.other === 0,
      `other=${counts.other}`);
    check('LIVE produced more than one template (variety)',
      counts.ai_social_proof_led > 0 && counts.ai_editorial > 0,
      `social=${counts.ai_social_proof_led} editorial=${counts.ai_editorial}`);
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
}

(async () => {
  try {
    await runLiveSimulation();
  } catch (err) {
    failures.push(`LIVE threw — ${err && err.stack ? err.stack : err}`);
  }

  if (failures.length) {
    console.log(`FAIL  ${failures.length}  pass ${passed}`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`OK    ${passed} checks`);
  process.exit(0);
})();
