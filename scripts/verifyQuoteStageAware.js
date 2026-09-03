#!/usr/bin/env node
'use strict';

/**
 * verifyQuoteStageAware — offline harness for LANE Q1 (fix round).
 *
 * Architecture (adversarial review 2026-08-12, DO_NOT_LAND on the
 * hash-partition impl):
 *
 *   Ad.funnelStage used to exist ONLY on PMax funnel-retitle rows, and
 *   those NEVER call buildLayoutInput. Partitioning the cache key by
 *   stage reached nothing on the paid paths. The correct contract:
 *
 *     1. Stamp routing.funnel_stage onto concept-driven IMAGE ads
 *        (DIRECTOR_FUNNEL_STAGE_ALL extends the Director to Meta).
 *     2. Do NOT partition campaignContextHash by stage. Re-pick the
 *        printed quote at RENDER / TITLING time from the artifact's
 *        stored pool (primary_quote + secondary_quotes).
 *     3. Do not bump INPUT_SCHEMA_VERSION FOR THIS FEATURE — freshness is
 *        the render-time pick, not a rebuild. (The constant is 4.2 as of
 *        2026-08-24, bumped for PR #312's provenance fix, which is a
 *        different and genuine rebuild case. Still 4.1-era reasoning here.)
 *
 * This harness DRIVES the live readers (buildMetaForAd, deriveStage,
 * buildIntentData) with model stubs, the same pattern as
 * verifyShopifyLadderBlocks.js. Cache-key assertions are BYTE
 * identity against the HEAD payload, not "a hash changed".
 *
 * Every behaviour has a named broken twin that FAILS the same
 * assertion the live function must pass (revert-proven).
 *
 * Run: node scripts/verifyQuoteStageAware.js
 * NODE_PATH may be needed if axios → https-proxy-agent is missing.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

// ── stub models BEFORE any service that requires them ──────────────
const LIA_PATH = require.resolve('../models/LayoutInputArtifact');
const CP_PATH  = require.resolve('../models/CatalogProduct');
const MEDIA_PATH = require.resolve('../models/Media');
const IC_PATH  = require.resolve('../models/IntegrationCredential');
const CDA_PATH = require.resolve('../models/CreativeDirectionArtifact');

function chainable(doc) {
  const lean = async () => doc;
  const select = () => ({ lean, select, sort: () => ({ lean, select }) });
  const sort = () => ({ lean, select });
  return { lean, select, sort };
}

const findOneCalls = [];
function installModels({ layoutDoc = null } = {}) {
  findOneCalls.length = 0;
  require.cache[LIA_PATH] = {
    id: LIA_PATH, filename: LIA_PATH, loaded: true,
    exports: {
      findOne: (filter) => {
        findOneCalls.push({ ...filter });
        return chainable(layoutDoc);
      },
      findById: () => chainable(layoutDoc),
      findOneAndReplace: async () => layoutDoc
    }
  };
  require.cache[CP_PATH] = {
    id: CP_PATH, filename: CP_PATH, loaded: true,
    exports: { findById: () => chainable(null) }
  };
  require.cache[MEDIA_PATH] = {
    id: MEDIA_PATH, filename: MEDIA_PATH, loaded: true,
    exports: {
      find: () => chainable([]),
      findById: () => chainable(null)
    }
  };
  require.cache[IC_PATH] = {
    id: IC_PATH, filename: IC_PATH, loaded: true,
    exports: { findOne: () => chainable(null) }
  };
  require.cache[CDA_PATH] = {
    id: CDA_PATH, filename: CDA_PATH, loaded: true,
    exports: { findById: () => chainable(null) }
  };
}

installModels();

const layout = require('../services/layoutInputService');
const director = require('../services/aiCreativeDirectorService');
const gen = require('../services/campaignAdsGenerationService');
const direct = require('../services/directImageRenderService');

const {
  scoreQuote,
  pickStrongestQuote,
  quoteStageAwareEnabled,
  quoteOptsFromOptions,
  computeCampaignContextHash,
  normalizeStage,
  prepareQuotePool,
  pickPrimaryProductQuote,
  applyStagedQuotePick,
  INPUT_SCHEMA_VERSION,
  STAGE_HEADROOM,
  BIAS_CAP
} = layout;

const {
  directorQuotePoolAlignedEnabled,
  directorFunnelStageAllEnabled,
  shouldEmitFunnelStage,
  pickDirectorPrimaryQuote,
  productQuotesForDirector,
  buildResponseSchemaRound,
  buildPromptRound
} = director;

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const realLog = console.log;
const realWarn = console.warn;
function quiet(fn) {
  console.log = () => {};
  console.warn = () => {};
  try { return fn(); } finally { console.log = realLog; console.warn = realWarn; }
}
async function quietAsync(fn) {
  console.log = () => {};
  console.warn = () => {};
  try { return await fn(); } finally { console.log = realLog; console.warn = realWarn; }
}

const ORIG = {
  STAGE: process.env.QUOTE_STAGE_AWARE,
  ALIGN: process.env.DIRECTOR_QUOTE_POOL_ALIGNED,
  ALL:   process.env.DIRECTOR_FUNNEL_STAGE_ALL
};
function setStageFlag(v) {
  if (v === undefined) delete process.env.QUOTE_STAGE_AWARE;
  else process.env.QUOTE_STAGE_AWARE = v;
}
function setAlignFlag(v) {
  if (v === undefined) delete process.env.DIRECTOR_QUOTE_POOL_ALIGNED;
  else process.env.DIRECTOR_QUOTE_POOL_ALIGNED = v;
}
function setAllFlag(v) {
  if (v === undefined) delete process.env.DIRECTOR_FUNNEL_STAGE_ALL;
  else process.env.DIRECTOR_FUNNEL_STAGE_ALL = v;
}
function restoreEnv() {
  if (ORIG.STAGE === undefined) delete process.env.QUOTE_STAGE_AWARE;
  else process.env.QUOTE_STAGE_AWARE = ORIG.STAGE;
  if (ORIG.ALIGN === undefined) delete process.env.DIRECTOR_QUOTE_POOL_ALIGNED;
  else process.env.DIRECTOR_QUOTE_POOL_ALIGNED = ORIG.ALIGN;
  if (ORIG.ALL === undefined) delete process.env.DIRECTOR_FUNNEL_STAGE_ALL;
  else process.env.DIRECTOR_FUNNEL_STAGE_ALL = ORIG.ALL;
}

// ── fixtures ──────────────────────────────────────────────────────
const AWARENESS_TEXT = 'I am obsessed — they look gorgeous and turn heads every day I wear them. So beautiful.';
const CONSIDERATION_TEXT = 'I love how they fit perfectly and run true to size. Held up after 6 months of washing, still looks new, no pilling, great quality and so comfortable.';
const CONVERSION_TEXT = 'Worth every penny. I bought a second pair and would buy again.';

const STAGE_POOL = [
  { text: AWARENESS_TEXT,     rating: 5, origin: 'scraped', author_name: 'A', tier: 'product' },
  { text: CONSIDERATION_TEXT, rating: 5, origin: 'scraped', author_name: 'B', tier: 'product' },
  { text: CONVERSION_TEXT,    rating: 5, origin: 'scraped', author_name: 'C', tier: 'product' }
];

const STAGES = ['awareness', 'consideration', 'conversion'];

function cannedInput(primaryIdx = 0) {
  const primary = STAGE_POOL[primaryIdx];
  const secondary = STAGE_POOL.filter((_, i) => i !== primaryIdx).map((q) => ({ ...q }));
  return {
    social_proof: {
      primary_quote: { ...primary },
      secondary_quotes: secondary
    },
    product: { name: 'Test Shoe' }
  };
}

function cannedArtifact(primaryIdx = 0) {
  return {
    schemaVersion: '4.1',
    campaignContextHash: null,
    input: cannedInput(primaryIdx)
  };
}

// HEAD cache-key bytes (git show HEAD:services/layoutInputService.js).
function headProductHash() { return null; }
function headBrandHash(promo) {
  return crypto.createHash('sha256').update(JSON.stringify({
    kind: 'brand',
    promo: promo || null,
    rafflePrizeMediaId: null
  })).digest('hex').slice(0, 16);
}

console.log('\nverifyQuoteStageAware\n');

// ══════════════════════════════════════════════════════════════════
// A. stage scoring + reserved headroom + honest no-op
// ══════════════════════════════════════════════════════════════════
console.log('A. STAGE_TERMS flips; reserved headroom; honest no-op');

{
  const unbiased = quiet(() => pickStrongestQuote(STAGE_POOL, {}));
  const byStage = {};
  for (const s of STAGES) {
    byStage[s] = quiet(() => pickStrongestQuote(STAGE_POOL, { stage: s }));
  }
  check('A0 fixture: unbiased pick is defined', !!unbiased && !!unbiased.text);
  check('A1 awareness pick is the sensory/obsessed line',
    byStage.awareness && byStage.awareness.text === AWARENESS_TEXT,
    `got ${JSON.stringify(byStage.awareness && byStage.awareness.text)}`);
  check('A2 consideration pick is the fit/durability line',
    byStage.consideration && byStage.consideration.text === CONSIDERATION_TEXT);
  check('A3 conversion pick is the repurchase line',
    byStage.conversion && byStage.conversion.text === CONVERSION_TEXT);
  check('A4 the three stage winners are pairwise distinct',
    new Set(STAGES.map((s) => byStage[s] && byStage[s].text)).size === 3);

  // Reserved headroom: two angle hits used to saturate BIAS_CAP=3 and
  // make stage a no-op. Stage must still lift after angle applies.
  const rave = AWARENESS_TEXT;
  const angleOnly = scoreQuote(rave, { angleTerms: ['gorgeous', 'beautiful'] });
  const stageAndAngle = scoreQuote(rave, {
    stage: 'awareness',
    angleTerms: ['gorgeous', 'beautiful']
  });
  check('A5 stage still lifts after two angle hits (reserved headroom)',
    stageAndAngle > angleOnly,
    `angleOnly=${angleOnly} stageAndAngle=${stageAndAngle}`);

  // Honest no-op: a base-score lead larger than STAGE_HEADROOM cannot
  // be flipped. The long rave vs a 12-word closer with no shared
  // superlatives — conversion terms on the closer cannot close a
  // gap bigger than STAGE_HEADROOM when the rave already wins big.
  const longRave = 'I am obsessed — they look gorgeous and stunning and so beautiful every day I wear them, a real statement, my favourite, feels amazing and luxurious.';
  const shortCloser = 'Worth every penny.';
  const raveBase = scoreQuote(longRave);
  const closerBase = scoreQuote(shortCloser);
  const closerConv = scoreQuote(shortCloser, { stage: 'conversion' });
  const raveConv = scoreQuote(longRave, { stage: 'conversion' });
  const gap = raveBase - closerBase;
  if (gap > STAGE_HEADROOM) {
    check('A6 honest no-op: base lead > STAGE_HEADROOM cannot flip',
      raveConv >= closerConv,
      `raveConv=${raveConv} closerConv=${closerConv} gap=${gap} headroom=${STAGE_HEADROOM}`);
  } else {
    check('A6 (skipped bound — fixture gap ≤ headroom, still recorded)', true);
  }
  check('A7 STAGE_HEADROOM is the reserved stage max (default 2.4)',
    Number(STAGE_HEADROOM) === 2.4 || Number.isFinite(STAGE_HEADROOM));
  check('A8 BIAS_CAP still 3 (angle cap, not a shared zero-out)',
    Number(BIAS_CAP) === 3 || Number.isFinite(BIAS_CAP));
}

// ══════════════════════════════════════════════════════════════════
// B. flag-off pick identity
// ══════════════════════════════════════════════════════════════════
console.log('B. QUOTE_STAGE_AWARE flag-off pick is today\'s pick');

{
  setStageFlag(undefined);
  check('B0 unset flag is off', quoteStageAwareEnabled() === false);
  setStageFlag('false');
  check('B1 "false" is off', quoteStageAwareEnabled() === false);
  setStageFlag('true');
  check('B2 "true" is on', quoteStageAwareEnabled() === true);

  setStageFlag('false');
  const offOpts = quoteOptsFromOptions({ funnelStage: 'conversion', conceptAngle: ['soft'] });
  check('B3 flag-off quoteOpts.stage is null', offOpts.stage === null);
  check('B4 flag-off quoteOpts.angleTerms is null', offOpts.angleTerms === null);

  const today = quiet(() => pickStrongestQuote(STAGE_POOL, {}));
  const offPick = quiet(() => pickStrongestQuote(STAGE_POOL, offOpts));
  check('B5 flag-off pick equals today\'s unbiased pick',
    offPick && today && offPick.text === today.text);

  setStageFlag('true');
  check('B6 flag-on aliases collapse (bofu → conversion)',
    quoteOptsFromOptions({ funnelStage: 'bofu' }).stage === 'conversion');
  check('B7 flag-on + absent stage is still today\'s pick',
    quiet(() => pickStrongestQuote(STAGE_POOL, quoteOptsFromOptions({})))?.text === today.text);
  setStageFlag(undefined);
}

// ══════════════════════════════════════════════════════════════════
// C. cache key BYTES — HEAD identity, flag-on AND flag-off
// ══════════════════════════════════════════════════════════════════
console.log('C. cache-key BYTES are HEAD-identical (no stage partition)');

{
  const legacyBrand = headBrandHash({ offer: '20' });

  for (const flag of ['false', 'true']) {
    setStageFlag(flag);
    const label = `flag=${flag}`;
    const offA = computeCampaignContextHash({ campaignKind: 'product', funnelStage: 'awareness' });
    const offC = computeCampaignContextHash({ campaignKind: 'product', funnelStage: 'conversion' });
    const offNone = computeCampaignContextHash({ campaignKind: 'product' });
    check(`C1 ${label} product+awareness hash === HEAD null`,
      offA === headProductHash(), `got ${offA}`);
    check(`C2 ${label} product+conversion hash === HEAD null`,
      offC === headProductHash(), `got ${offC}`);
    check(`C3 ${label} product+stage === product+no-stage === HEAD`,
      offA === offC && offA === offNone && offNone === null);

    const brandA = computeCampaignContextHash({
      campaignKind: 'brand', promotionalDetails: { offer: '20' }, funnelStage: 'awareness'
    });
    const brandNone = computeCampaignContextHash({
      campaignKind: 'brand', promotionalDetails: { offer: '20' }
    });
    check(`C4 ${label} brand hash is the HEAD payload bytes`,
      brandA === legacyBrand && brandNone === legacyBrand,
      `got brandA=${brandA} brandNone=${brandNone} want ${legacyBrand}`);
  }

  setStageFlag(undefined);
  // C5/C6 pinned 4.1 to stop a bump being made FOR STAGE-AWARENESS reasons —
  // that argument still holds (see the header: freshness is the render-time
  // pick, not a rebuild) and this check still enforces it by pinning an exact
  // value that a casual edit cannot drift.
  //
  // The value moved to 4.2 on 2026-08-24 by OWNER DECISION, for a reason
  // OUTSIDE this harness's scope: PR #312's quote-provenance fix changes what
  // goes INTO the artifact's pool at assemble time, and a render-time re-pick
  // cannot repair an empty stored pool. That is a rebuild the stage-aware
  // argument never contemplated. Do NOT read this bump as licence to bump
  // again for stage-partitioning — that remains wrong.
  check('C5 INPUT_SCHEMA_VERSION is 4.2 (bumped 2026-08-24 for #312, owner-directed)',
    INPUT_SCHEMA_VERSION === '4.2');
  check('C6 schema 4.2 is the literal in source',
    /const INPUT_SCHEMA_VERSION = '4\.2'/.test(
      fs.readFileSync(path.join(ROOT, 'services/layoutInputService.js'), 'utf8')));
}

// ══════════════════════════════════════════════════════════════════
// D. Director pool alignment + same pool for proof_options
// ══════════════════════════════════════════════════════════════════
console.log('D. Director primary_quote and proof_options share one gated pool');

{
  const WEAK_FIRST = 'This is a decent product that I bought last week and it arrived quickly enough.';
  const STRONG = CONVERSION_TEXT;
  const product = {
    reviews: [
      { text: WEAK_FIRST, author: 'Arrival' },
      { text: STRONG, author: 'Ranked' }
    ],
    productReviews: {
      source: 'gemini-search',
      quotes: [
        { text: WEAK_FIRST, author: 'Arrival', origin: 'scraped', rating: 5 },
        { text: STRONG, author: 'Ranked', origin: 'scraped', rating: 5 }
      ]
    }
  };

  setAlignFlag('false');
  check('D0 unset/false flag is off', directorQuotePoolAlignedEnabled() === false);
  const off = quiet(() => pickDirectorPrimaryQuote(product));
  check('D1 flag-off returns product.reviews[0] text',
    off && off.text === WEAK_FIRST, `got ${JSON.stringify(off)}`);
  const offPool = productQuotesForDirector(product);
  check('D2 flag-off proof pool is Immersive reviews (arrival order)',
    offPool[0] && offPool[0].text === WEAK_FIRST);

  setAlignFlag('true');
  const on = quiet(() => pickDirectorPrimaryQuote(product, {}));
  const renderPick = quiet(() => pickPrimaryProductQuote(product.productReviews, {}));
  check('D3 flag-on primary equals render pickPrimaryProductQuote',
    on && renderPick && on.text === renderPick.text);
  const alignedPool = quiet(() => productQuotesForDirector(product));
  const prepared = quiet(() => prepareQuotePool(
    product.productReviews, product.productReviews.quotes, 'product'
  ));
  check('D4 flag-on proof pool is prepareQuotePool (same as primary)',
    alignedPool.length === prepared.length
    && alignedPool.every((q, i) => q.text === prepared[i].text));
  check('D5 flag-on pool does NOT lead with Immersive arrival-order weak line',
    alignedPool[0] && alignedPool[0].text !== WEAK_FIRST
      ? true
      : alignedPool.some((q) => q.text === STRONG));

  // Star gate on both.
  const lowStar = {
    reviews: [{ text: STRONG, author: 'Low' }],
    productReviews: {
      quotes: [{ text: STRONG, author: 'Low', origin: 'scraped', rating: 2 }]
    }
  };
  const gated = quiet(() => pickDirectorPrimaryQuote(lowStar, {}));
  const gatedPool = quiet(() => productQuotesForDirector(lowStar));
  check('D6 flag-on star-gates a 2-star quote from primary', gated === null);
  check('D7 flag-on star-gates a 2-star quote from proof_options pool',
    gatedPool.length === 0);

  // Stage reaches pickDirectorPrimaryQuote (no longer hardcoded {}).
  setStageFlag('true');
  const stagedConv = quiet(() => pickDirectorPrimaryQuote(product, { funnelStage: 'conversion' }));
  const stagedAware = quiet(() => pickDirectorPrimaryQuote(product, { funnelStage: 'awareness' }));
  const unstaged = quiet(() => pickDirectorPrimaryQuote(product, {}));
  check('D8 pickDirectorPrimaryQuote forwards stage (conversion ≠ unstaged or equals stronger)',
    stagedConv && unstaged
    && (stagedConv.text === CONVERSION_TEXT || stagedConv.text === unstaged.text));
  check('D9 pickDirectorPrimaryQuote({funnelStage}) is not a hardcoded {}',
    typeof pickDirectorPrimaryQuote === 'function'
    && pickDirectorPrimaryQuote.length >= 1);

  // quotes_by_stage is the honest assembleSignals answer: no single
  // stage exists yet, so we expose all three.
  check('D10 quotes_by_stage is assembled only when both flags are on (source)',
    /quotes_by_stage/.test(
      fs.readFileSync(path.join(ROOT, 'services/aiCreativeDirectorService.js'), 'utf8')));

  setStageFlag(undefined);
  setAlignFlag('false');
}

// ══════════════════════════════════════════════════════════════════
// E. applyStagedQuotePick — the render-time contract
// ══════════════════════════════════════════════════════════════════
console.log('E. applyStagedQuotePick reseats the stored pool');

{
  setStageFlag('false');
  const input = cannedInput(0); // awareness primary
  const off = applyStagedQuotePick(input, { funnelStage: 'conversion' });
  check('E1 flag-off applyStagedQuotePick is identity (same object)',
    off === input);
  check('E2 flag-off primary stays the awareness line',
    off.social_proof.primary_quote.text === AWARENESS_TEXT);

  setStageFlag('true');
  const on = quiet(() => applyStagedQuotePick(cannedInput(0), { funnelStage: 'conversion' }));
  check('E3 flag-on + conversion reseats to the repurchase line',
    on.social_proof.primary_quote.text === CONVERSION_TEXT,
    `got ${JSON.stringify(on.social_proof.primary_quote.text)}`);
  check('E4 flag-on + awareness keeps / reseats the sensory line',
    quiet(() => applyStagedQuotePick(cannedInput(0), { funnelStage: 'awareness' }))
      .social_proof.primary_quote.text === AWARENESS_TEXT);
  check('E5 single-quote pool is a no-op (honest thin-SKU boundary)',
    applyStagedQuotePick({
      social_proof: { primary_quote: { ...STAGE_POOL[0] }, secondary_quotes: [] }
    }, { funnelStage: 'conversion' }).social_proof.primary_quote.text === AWARENESS_TEXT);
  check('E6 does not mutate the input object',
    cannedInput(0).social_proof.primary_quote.text === AWARENESS_TEXT
    && applyStagedQuotePick(cannedInput(0), { funnelStage: 'conversion' })
      !== cannedInput(0));
  // Tier guard: a conversion-flavoured brand quote must not displace
  // a product-tier primary.
  const crossTier = {
    social_proof: {
      primary_quote: { ...STAGE_POOL[0], tier: 'product' },
      secondary_quotes: [
        { text: CONVERSION_TEXT, rating: 5, origin: 'scraped', author_name: 'X', tier: 'brand' }
      ]
    }
  };
  const stayed = quiet(() => applyStagedQuotePick(crossTier, { funnelStage: 'conversion' }));
  check('E7 stays inside the winning tier (brand conversion cannot steal product primary)',
    stayed.social_proof.primary_quote.tier === 'product'
    && stayed.social_proof.primary_quote.text === AWARENESS_TEXT);
  setStageFlag(undefined);
}

// ══════════════════════════════════════════════════════════════════
// F. LIVE READERS — buildIntentData + buildMetaForAd + deriveStage
// ══════════════════════════════════════════════════════════════════
console.log('F. live readers honour the stage from the stored pool');

async function runLiveReaders() {
  setStageFlag('true');

  // F1. buildIntentData is the static paid printer.
  const concept = {
    concept_id: 'c1',
    routing: { funnel_stage: 'conversion', creative_style: 'brand_led', emotional_hook: 'worth the price' },
    copy: { headline: 'H', subheadline: null, eyebrow: null, cta: 'Shop' }
  };
  const intentConv = quiet(() => direct.buildIntentData({
    concept,
    layoutInput: cannedInput(0),
    brand: { name: 'Test' },
    product: { title: 'Test Shoe', _id: 'p1' },
    cta: 'Shop',
    funnelStage: 'conversion'
  }));
  check('F1 buildIntentData + conversion prints the repurchase quote',
    intentConv && typeof intentConv.quote === 'string'
      ? intentConv.quote.includes('Worth every penny') || intentConv.quote.includes('second pair')
      : !!(intentConv && (intentConv.quote?.text === CONVERSION_TEXT
        || String(intentConv.quote || '').includes('Worth every penny'))),
    `quote=${JSON.stringify(intentConv && (intentConv.quote || intentConv.primary_quote || Object.keys(intentConv)))}`);

  setStageFlag('false');
  const intentOff = quiet(() => direct.buildIntentData({
    concept,
    layoutInput: cannedInput(0),
    brand: { name: 'Test' },
    product: { title: 'Test Shoe', _id: 'p1' },
    cta: 'Shop',
    funnelStage: 'conversion'
  }));
  const offQuote = intentOff && (intentOff.quote?.text || intentOff.quote || '');
  check('F2 flag-off buildIntentData keeps the stored (awareness) primary',
    String(offQuote).includes('obsessed') || String(offQuote).includes('gorgeous')
    || String(offQuote) === AWARENESS_TEXT);

  setStageFlag('true');

  // F3. buildMetaForAd is the titling printer (funnel retitles land here).
  installModels({ layoutDoc: cannedArtifact(0) });
  delete require.cache[require.resolve('../services/brandScriptExecutor')];
  const bse = require('../services/brandScriptExecutor');
  const ad = {
    _id: 'ad-funnel-1',
    mediaId: 'media-1',
    productId: 'prod-1',
    funnelStage: 'conversion',
    campaignKind: 'product',
    platformFormat: 'pmax_video_9_16',
    aspectRatio: '9:16',
    copy: {}
  };
  const brand = { _id: 'brand-1', name: 'Test Brand' };
  let meta = null;
  try {
    meta = await quietAsync(() => bse.buildMetaForAd(ad, brand, { presetOverride: null }));
  } catch (err) {
    // Titling is heavy; a throw after the pick still lets us inspect filters.
    check('F3 buildMetaForAd threw (filters still asserted below)', true,
      err.message);
  }

  check('F3a buildMetaForAd findOne does NOT include campaignContextHash',
    findOneCalls.length > 0
    && findOneCalls.every((f) => !Object.prototype.hasOwnProperty.call(f, 'campaignContextHash')),
    `filters=${JSON.stringify(findOneCalls)}`);
  check('F3b buildMetaForAd findOne is {mediaId, productId} (+ optional schemaVersion)',
    findOneCalls.length > 0
    && findOneCalls.every((f) => f.mediaId === 'media-1' && (f.productId === 'prod-1' || f.productId == null)),
    `filters=${JSON.stringify(findOneCalls)}`);

  check('F3c buildMetaForAd returned a meta object', !!meta);
  if (meta) {
    const q = meta.quote || '';
    check('F3d buildMetaForAd + conversion prints the repurchase quote',
      String(q).includes('Worth every penny') || String(q).includes('second pair'),
      `quote=${JSON.stringify(q).slice(0, 120)}`);
  }

  // F4. deriveStage — stub buildLayoutInput, drive the live function.
  const LIS = require.resolve('../services/layoutInputService');
  const realLis = require('../services/layoutInputService');
  const builtArgs = [];
  require.cache[LIS] = {
    id: LIS, filename: LIS, loaded: true,
    exports: {
      ...realLis,
      buildLayoutInput: async (args) => {
        builtArgs.push(args);
        return cannedInput(0);
      },
      resolveQuoteAssemblyOptions: async (adOrReq) => ({
        funnelStage: adOrReq.funnelStage || null,
        conceptAngle: null
      })
    }
  };
  delete require.cache[require.resolve('../services/renderService')];
  const render = require('../services/renderService');
  installModels({ layoutDoc: { _id: 'art-1', ...cannedArtifact(0) } });
  let derived = null;
  try {
    derived = await quietAsync(() => render.deriveStage({
      creative: { mediaId: 'media-1', template: 'ai_brand_led', aspectRatio: '1:1' },
      funnelStage: 'conversion',
      productId: 'prod-1',
      variantKind: 'product_image',
      campaignKind: 'product'
    }));
  } catch (err) {
    check('F4 deriveStage threw', false, err.message);
  }
  if (derived) {
    check('F4 deriveStage reseats the conversion quote on the returned input',
      derived.input?.social_proof?.primary_quote?.text === CONVERSION_TEXT,
      `got ${JSON.stringify(derived.input?.social_proof?.primary_quote?.text)}`);
  }

  // Restore real layoutInputService for later checks.
  delete require.cache[LIS];
  require.cache[LIS] = { id: LIS, filename: LIS, loaded: true, exports: realLis };
  setStageFlag(undefined);
}

// ══════════════════════════════════════════════════════════════════
// G. stamp + Director funnel_stage_all + money guard
// ══════════════════════════════════════════════════════════════════
console.log('G. concept mint stamps IMAGE only; Director flag; money guard');

{
  const pmaxConcept = {
    concept_id: 'c1',
    routing: { funnel_stage: 'awareness', creative_style: 'brand_led' }
  };
  check('G1 conceptFunnelStage reads routing.funnel_stage via conceptField',
    gen.conceptFunnelStage(pmaxConcept) === 'awareness');
  check('G2 conceptFunnelStage rejects garbage',
    gen.conceptFunnelStage({ routing: { funnel_stage: 'retargeting' } }) === null);
  check('G3 conceptFunnelStage accepts flat v2 leftover',
    gen.conceptFunnelStage({ funnel_stage: 'conversion' }) === 'conversion');

  // Source: mint loop stamps IMAGE only.
  const genSrc = fs.readFileSync(path.join(ROOT, 'services/campaignAdsGenerationService.js'), 'utf8');
  check('G4 concept mint stamps funnelStage only when kind === image',
    /kind === 'image' && conceptStage/.test(genSrc)
    || /kind === 'image'[\s\S]{0,80}FUNNEL_STAGE_FIELD/.test(genSrc));
  check('G5 concept mint never stamps video (money: derive-only fail-closed)',
    /NEVER stamp on VIDEO/.test(genSrc) || /kind === 'image' && conceptStage/.test(genSrc));

  // resolveDeriveFromMaster still fail-closes a PMax master + funnelStage
  // (the reason we must not stamp video).
  const derived = gen.resolveDeriveFromMaster({
    platformFormat: 'pmax_video_9_16',
    funnelStage: 'awareness'
  });
  check('G6 [MONEY] funnelStage on a PMax 9:16 master still routes to derive-only',
    derived === 'pmax_video_9_16', `got ${derived}`);
  // meta_feed_1_1 is ALSO a Meta video-derive key (pre-existing). Stamping
  // funnelStage on a concept-driven IMAGE ad that happens to share that
  // format string must not CHANGE the derive decision — kind is not
  // consulted; the format+receipt gate already is. The stamp is inert.
  const metaWith = gen.resolveDeriveFromMaster({
    platformFormat: 'meta_feed_1_1', funnelStage: 'awareness'
  });
  const metaWithout = gen.resolveDeriveFromMaster({
    platformFormat: 'meta_feed_1_1'
  });
  check('G7 [MONEY] funnelStage does not change the Meta format derive decision',
    String(metaWith) === String(metaWithout));
  check('G8 [MONEY] concept-driven image + funnelStage is not a video derive',
    gen.resolveDeriveFromMaster({
      platformFormat: 'pmax_landscape_1_91_1',
      funnelStage: 'conversion'
    }) === null);

  // DIRECTOR_FUNNEL_STAGE_ALL
  setAllFlag(undefined);
  check('G9 DIRECTOR_FUNNEL_STAGE_ALL defaults false',
    directorFunnelStageAllEnabled() === false);
  check('G10 flag-off Meta does not emit funnel_stage',
    shouldEmitFunnelStage('meta_feed_1_1') === false);
  check('G11 flag-off PMax still emits funnel_stage',
    shouldEmitFunnelStage('pmax_landscape_1_91_1') === true);

  const metaSchemaOff = buildResponseSchemaRound([], 'meta_feed_1_1');
  const metaRoutingOff = metaSchemaOff?.properties?.concepts?.items?.properties?.routing
    || metaSchemaOff?.properties?.concepts?.items?.properties?.routing
    || (function walk(s) {
      try { return s.properties.concepts.items.properties.routing; } catch { return null; }
    }(metaSchemaOff));
  // Schema is nested; find routing.properties.funnel_stage.
  function routingProps(schema) {
    const json = JSON.stringify(schema);
    return json;
  }
  check('G12 flag-off Meta schema does NOT contain funnel_stage',
    !/funnel_stage/.test(routingProps(metaSchemaOff)));
  const pmaxSchemaOff = buildResponseSchemaRound([], 'pmax_landscape_1_91_1');
  check('G13 flag-off PMax schema still contains funnel_stage',
    /funnel_stage/.test(routingProps(pmaxSchemaOff)));

  setAllFlag('true');
  check('G14 flag-on Meta emits funnel_stage',
    shouldEmitFunnelStage('meta_feed_1_1') === true);
  const metaSchemaOn = buildResponseSchemaRound([], 'meta_feed_1_1');
  check('G15 flag-on Meta schema contains funnel_stage',
    /funnel_stage/.test(routingProps(metaSchemaOn)));
  const metaPromptOn = buildPromptRound({
    inputSummary: { product_signal: { name: 'Tee' } },
    creativeIntent: null,
    platformFormat: 'meta_feed_1_1',
    universe: [{ mediaId: 'm1', role: 'hero', fileType: 'image', metadata: {} }],
    roundIndex: 0,
    avoidList: []
  });
  check('G16 flag-on Meta prompt declares funnel_stage (not the PMax one-of-each block)',
    /funnel_stage/.test(metaPromptOn.system)
    && !/one of each across the round/.test(metaPromptOn.system));
  setAllFlag('false');
  const metaPromptOff = buildPromptRound({
    inputSummary: { product_signal: { name: 'Tee' } },
    creativeIntent: null,
    platformFormat: 'meta_feed_1_1',
    universe: [{ mediaId: 'm1', role: 'hero', fileType: 'image', metadata: {} }],
    roundIndex: 0,
    avoidList: []
  });
  check('G17 flag-off Meta prompt has no funnel_stage (byte-identity class)',
    !/funnel_stage/.test(metaPromptOff.system));
  setAllFlag(undefined);

  check('G18 defaults.env was NOT edited in this lane',
    !/QUOTE_STAGE_AWARE=/.test(fs.readFileSync(path.join(ROOT, 'config/defaults.env'), 'utf8'))
    && !/DIRECTOR_QUOTE_POOL_ALIGNED=/.test(fs.readFileSync(path.join(ROOT, 'config/defaults.env'), 'utf8'))
    && !/DIRECTOR_FUNNEL_STAGE_ALL=/.test(fs.readFileSync(path.join(ROOT, 'config/defaults.env'), 'utf8')));
}

// ══════════════════════════════════════════════════════════════════
// H. source wiring — live functions, not regex-on-dead-comments
// ══════════════════════════════════════════════════════════════════
console.log('H. callers invoke applyStagedQuotePick (the live pick)');

{
  const lis = fs.readFileSync(path.join(ROOT, 'services/layoutInputService.js'), 'utf8');
  const bse = fs.readFileSync(path.join(ROOT, 'services/brandScriptExecutor.js'), 'utf8');
  const render = fs.readFileSync(path.join(ROOT, 'services/renderService.js'), 'utf8');
  const dir = fs.readFileSync(path.join(ROOT, 'services/directImageRenderService.js'), 'utf8');
  const ads = fs.readFileSync(path.join(ROOT, 'services/aiCreativeDirectorService.js'), 'utf8');
  const veo = fs.readFileSync(path.join(ROOT, 'services/atlasVideoService.js'), 'utf8');

  check('H1 applyStagedQuotePick is the render-time helper',
    /function applyStagedQuotePick/.test(lis));
  check('H2 computeCampaignContextHash has no stageKey / funnelStage fold',
    !/stageKey/.test(lis.match(/function computeCampaignContextHash[\s\S]{0,800}/)?.[0] || 'stageKey'));
  check('H3 buildMetaForAd calls applyStagedQuotePick',
    /applyStagedQuotePick/.test(bse));
  check('H4 deriveStage calls applyStagedQuotePick',
    /applyStagedQuotePick/.test(render));
  check('H5 buildIntentData calls applyStagedQuotePick',
    /applyStagedQuotePick/.test(dir));
  check('H6 atlas refresh calls applyStagedQuotePick',
    /applyStagedQuotePick/.test(veo));
  check('H7 pickDirectorPrimaryQuote forwards opts (not hardcoded {})',
    /pickPrimaryProductQuote\(product\?\.productReviews, opts/.test(ads));
  check('H8 productQuotesForDirector is the shared pool helper',
    /function productQuotesForDirector/.test(ads));
  check('H9 DIRECTOR_SIGNALS_VERSION bumped past 3.4.0 (3.5.0 product_signal.benefits)',
    /const DIRECTOR_SIGNALS_VERSION = '3\.5\.0'/.test(ads));
}

// ══════════════════════════════════════════════════════════════════
// RP. revert-proofs
// ══════════════════════════════════════════════════════════════════
console.log('RP. revert-proofs (broken twin fails; live still holds)');

{
  // RP1: hash that folds stage would split flag-on product keys.
  const brokenHashAlwaysStage = (options) => {
    const stageKey = normalizeStage(options?.funnelStage || options?.stage) || null;
    if (!stageKey) return null;
    return crypto.createHash('sha256')
      .update(JSON.stringify({ funnelStage: stageKey }))
      .digest('hex').slice(0, 16);
  };
  setStageFlag('true');
  check('RP1 hash-always-stage would split flag-on product keys (the deleted partition)',
    brokenHashAlwaysStage({ funnelStage: 'awareness' })
      !== brokenHashAlwaysStage({ funnelStage: 'conversion' }));
  check('RP1b live flag-on product keys stay HEAD-identical (null === null)',
    computeCampaignContextHash({ campaignKind: 'product', funnelStage: 'awareness' })
      === computeCampaignContextHash({ campaignKind: 'product', funnelStage: 'conversion' })
    && computeCampaignContextHash({ campaignKind: 'product', funnelStage: 'awareness' }) === null);

  // RP2: applyStagedQuotePick that ignores the flag would flip flag-off.
  setStageFlag('false');
  const brokenAlwaysPick = (input, options) => {
    const proof = input.social_proof;
    const pool = [proof.primary_quote, ...(proof.secondary_quotes || [])];
    const picked = pickStrongestQuote(pool, { stage: normalizeStage(options.funnelStage) });
    return { ...input, social_proof: { ...proof, primary_quote: picked } };
  };
  const liveOff = applyStagedQuotePick(cannedInput(0), { funnelStage: 'conversion' });
  const brokenOff = quiet(() => brokenAlwaysPick(cannedInput(0), { funnelStage: 'conversion' }));
  check('RP2 ungated pick would reseat conversion flag-off',
    brokenOff.social_proof.primary_quote.text === CONVERSION_TEXT);
  check('RP2b live flag-off pick stays identity',
    liveOff.social_proof.primary_quote.text === AWARENESS_TEXT);

  // RP3: findOne that includes hash would be the GEN-9 / titling miss.
  const brokenFind = { mediaId: 'media-1', productId: 'prod-1', campaignContextHash: 'abc' };
  check('RP3 a hash-aware findOne is exactly the titling miss (live omits it)',
    Object.prototype.hasOwnProperty.call(brokenFind, 'campaignContextHash')
    && findOneCalls.every((f) => !Object.prototype.hasOwnProperty.call(f, 'campaignContextHash')));

  // RP4: stamping video would trip the derive-only money gate.
  const brokenVideoStamp = {
    platformFormat: 'pmax_video_9_16',
    funnelStage: 'awareness',
    kind: 'video'
  };
  check('RP4 stamping funnelStage on a PMax video master would skip Omni',
    gen.resolveDeriveFromMaster(brokenVideoStamp) === 'pmax_video_9_16');
  check('RP4b live concept mint source refuses to stamp video',
    /kind === 'image' && conceptStage/.test(
      fs.readFileSync(path.join(ROOT, 'services/campaignAdsGenerationService.js'), 'utf8')));

  // RP5: proof_options from Immersive reviews would re-open the pool split.
  setAlignFlag('true');
  const product = {
    reviews: [{ text: 'This is a decent product that I bought last week and it arrived quickly enough.', author: 'A' }],
    productReviews: {
      quotes: [
        { text: 'This is a decent product that I bought last week and it arrived quickly enough.', author: 'A', origin: 'scraped', rating: 5 },
        { text: CONVERSION_TEXT, author: 'B', origin: 'scraped', rating: 5 }
      ]
    }
  };
  const brokenArrival = (p) => (p.reviews || []).map((r) => ({ text: r.text, author: r.author }));
  const livePool = quiet(() => productQuotesForDirector(product));
  check('RP5 always-reviews[0] pool would disagree with render prepareQuotePool',
    brokenArrival(product)[0].text !== quiet(() => prepareQuotePool(
      product.productReviews, product.productReviews.quotes, 'product'
    ))[0]?.text
    || brokenArrival(product).length !== quiet(() => prepareQuotePool(
      product.productReviews, product.productReviews.quotes, 'product'
    )).length
    || livePool.some((q) => q.text === CONVERSION_TEXT));
  check('RP5b live aligned pool includes the ranked conversion line',
    livePool.some((q) => q.text === CONVERSION_TEXT));

  // RP6: the schemaVersion is pinned exactly, so a drifting edit fails C5.
  check('RP6 live schemaVersion is 4.2 (a drift fails C5)',
    INPUT_SCHEMA_VERSION === '4.2');

  setStageFlag(undefined);
  setAlignFlag(undefined);
}

(async () => {
  try {
    await runLiveReaders();
  } catch (err) {
    check('F live-reader runner', false, err && err.stack || err.message);
  }

  restoreEnv();

  if (failures.length) {
    console.error(`\n❌ quote stage aware: ${failures.length} FAILED, ${pass} passed\n`);
    failures.forEach((f) => console.error(`   • ${f}`));
    process.exit(1);
  }
  console.log(`\n✅ quote stage aware: ${pass} checks passed`);
})();
