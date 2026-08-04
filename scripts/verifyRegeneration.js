#!/usr/bin/env node
/**
 * Offline harness for regeneration identity and preset routing.
 * No DB, no network, no API key.
 *
 * Two production failures on 2026-08-01, both silent:
 *
 *   R1  A second Generate on a campaign produced NOTHING. The static
 *       identityDigest did not include the run, so every candidate collided
 *       with the first run's ads on the per-campaign unique index. Owner rule:
 *       "there should be no limitation on creating new ads that may be
 *       duplicates since generative ads always have new seeds."
 *   R2  Static runs also queued Veo videos. `kinds` defaulted to 'both', and
 *       resolveKinds returned BOTH kinds when asked for one the surface did
 *       not support. The product has two separate presets.
 *
 * The money invariant these must not break (CLAUDE.md §2): a generation POST
 * is billable, so the digest still has to be STABLE WITHIN ONE RUN. Scoping to
 * the run id — not a random nonce — is what keeps a replayed handler, retried
 * batch or reaper requeue deduping exactly as before.
 *
 * Run: node scripts/verifyRegeneration.js
 */
const gen = require('../services/campaignAdsGenerationService');
const pf = require('../services/platformFormats');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const BASE = {
  campaignId: '6a6a52cdcb097b4db3f8084d',
  productId: '6a6a4d58054561c15f3ff8a2',
  mediaId: '6a6a4d58054561c15f3ff8ff',
  template: 'ai_promotional',
  aspectRatio: '1:1',
  variantKind: 'product_image',
  paletteSource: 'media',
  ctaText: 'Shop Now',
  ctaUrl: 'https://example.com',
  ctaUrlParams: '',
  rafflePrizeMediaId: null
};
const d = (over) => gen.computeIdentityDigest({ ...BASE, ...over });

// ── R1: a new run must produce new ads ──────────────────────────────────
const runA = 'run_1785617697150_4002661b';
const runB = 'run_1785617812345_9f3ca771';

check('R1 same run + same inputs -> SAME digest (idempotent within a run)',
  d({ kind: 'image', generationRunId: runA }) === d({ kind: 'image', generationRunId: runA }));

check('R1 different run -> DIFFERENT digest (regeneration is allowed)',
  d({ kind: 'image', generationRunId: runA }) !== d({ kind: 'image', generationRunId: runB }));

// The whole money argument: the run id is not a random nonce. Two calls inside
// one run — a replayed handler, a retried batch — must still collide.
const replay = [];
for (let i = 0; i < 5; i++) replay.push(d({ kind: 'image', generationRunId: runA }));
check('R1 five replays within one run all collide (no double-billing)',
  new Set(replay).size === 1, `got ${new Set(replay).size} distinct digests`);

// Backwards compatibility: a caller that passes nothing must hash EXACTLY as
// before, or every pre-existing ad's digest silently changes meaning.
check('R1 omitting the run id is byte-identical to passing undefined',
  d({ kind: 'image' }) === d({ kind: 'image', generationRunId: null }));
check('R1 omitting the run id differs from any run-scoped digest',
  d({ kind: 'image' }) !== d({ kind: 'image', generationRunId: runA }));

// ── R1b: video stays deterministic ──────────────────────────────────────
// Owner: "veo should only generate a video once for each product unless it is
// revised or another custom video is selected." The run id must NOT reach the
// video digest, or every Generate re-bills a Veo master.
check('R1b video digest ignores the run id (Veo once per product)',
  d({ kind: 'video', generationRunId: runA }) === d({ kind: 'video', generationRunId: runB }),
  'a new run would re-bill a Veo generation');
check('R1b image and video digests still differ from each other',
  d({ kind: 'image', generationRunId: runA }) !== d({ kind: 'video', generationRunId: runA }));

// Every other identity field must still separate ads within one run.
for (const [field, value] of [
  ['aspectRatio', '4:5'], ['template', 'ai_social_proof_led'], ['mediaId', 'ffffffffffffffffffffffff'],
  ['productId', 'ffffffffffffffffffffffff'], ['ctaText', 'Buy Now'], ['variantKind', 'lifestyle']
]) {
  check(`R1 ${field} still separates ads inside one run`,
    d({ kind: 'image', generationRunId: runA }) !== d({ kind: 'image', generationRunId: runA, [field]: value }));
}

// ── R1c: the LIVE path. This is the one that mattered. ──────────────────
// AI_CONCEPT_DRIVEN=true in config/defaults.env and on Render, so static ads
// are built by runConceptDrivenExpansion and keyed by computeV2IdentityDigest.
// The first version of this harness only exercised the legacy V1 digest and so
// passed 22/22 while the live path was completely unfixed — an adversarial
// review caught it, not these tests. Do not delete these.
const V2 = {
  campaignId: '6a6a52cdcb097b4db3f8084d',
  productId: '6a6a4d58054561c15f3ff8a2',
  platformFormat: 'meta_feed_1_1',
  ctaText: 'Shop Now', ctaUrl: 'https://example.com', ctaUrlParams: ''
};
const v2 = (over) => gen.computeV2IdentityDigest({ ...V2, ...over });

// concept_id is a SHORT SLUG the Director is told to make "unique within this
// round" — so the same slug recurs across rounds by design. That reuse is what
// made a second Generate produce nothing.
const SLUG = 'cd_quote_lead';

check('R1c V2: same run + same concept slug -> SAME digest',
  v2({ conceptId: SLUG, kind: 'image', generationRunId: runA }) ===
  v2({ conceptId: SLUG, kind: 'image', generationRunId: runA }));

check('R1c V2: a REUSED concept slug in a NEW run -> DIFFERENT digest',
  v2({ conceptId: SLUG, kind: 'image', generationRunId: runA }) !==
  v2({ conceptId: SLUG, kind: 'image', generationRunId: runB }),
  'this is the exact production failure: the Director reuses slugs, so without run scope the second Generate collides and yields zero ads');

check('R1c V2: video ignores the run id (Veo once per product)',
  v2({ conceptId: SLUG, kind: 'video', generationRunId: runA }) ===
  v2({ conceptId: SLUG, kind: 'video', generationRunId: runB }));

check('R1c V2: omitting the run id is byte-identical to legacy',
  v2({ conceptId: SLUG, kind: 'image' }) === v2({ conceptId: SLUG, kind: 'image', generationRunId: null }));

// The three static sizes of ONE concept in ONE run must stay distinct, or the
// fan-out silently collapses to a single ad.
const fanout = ['meta_feed_1_1', 'meta_feed_4_5', 'meta_stories_9_16']
  .map((fmt) => v2({ conceptId: SLUG, kind: 'image', platformFormat: fmt, generationRunId: runA }));
check('R1c V2: the three static formats of one concept stay distinct in one run',
  new Set(fanout).size === 3, `got ${new Set(fanout).size} distinct digests`);

check('R1c V2: different concepts in one run stay distinct',
  v2({ conceptId: 'cd_a', kind: 'image', generationRunId: runA }) !==
  v2({ conceptId: 'cd_b', kind: 'image', generationRunId: runA }));

check('R1c V2: image and video of one concept stay distinct',
  v2({ conceptId: SLUG, kind: 'image', generationRunId: runA }) !==
  v2({ conceptId: SLUG, kind: 'video', generationRunId: runA }));

// ── R2: presets do not bleed into each other ────────────────────────────
const KINDS = [
  ['meta_feed_1_1', 'image', ['image']],
  ['meta_feed_1_1', 'video', ['video']],
  ['meta_feed_4_5', 'image', ['image']],
  ['meta_stories_9_16', 'image', ['image']],
  // pmax is frozen (coming_soon) — any request yields nothing (never generatable).
  ['pmax_16_9', 'image', []],
  ['pmax_16_9', 'both', []],
  // The inversion that billed a video to someone who picked static.
  ['meta_reels_9_16', 'image', []],
  ['meta_reels_9_16', 'video', ['video']],
  // Explicit 'both' is still honoured — it is a real caller (deterministic video expansion).
  ['meta_feed_1_1', 'both', ['image', 'video']]
];
for (const [fmt, requested, expected] of KINDS) {
  const got = pf.resolveKinds(fmt, requested);
  check(`R2 ${fmt} + ${requested} -> ${JSON.stringify(expected)}`,
    JSON.stringify(got) === JSON.stringify(expected), `got ${JSON.stringify(got)}`);
}
check('R2 a static request never yields a billable video kind',
  ['meta_feed_1_1', 'meta_feed_4_5', 'meta_stories_9_16', 'pmax_16_9', 'meta_reels_9_16']  // pmax included on purpose: frozen must still never yield video
    .every((f) => !pf.resolveKinds(f, 'image').includes('video')));

// ── R3: catalog-first reseed on STATIC regenerate ───────────────────────
// Regenerate used to REPLAY the stored Ad.mediaIds stack, so an ad queued while
// DIRECTOR_UNIVERSE_TOP_N was 10 still sent 3+ references on every regen — for
// ever. It now RE-DERIVES the seed. It must NOT be a trim to mediaIds[0]: those
// stacks were shotType-ranked LIFESTYLE-FIRST (services/shotTypeRank.js) over a
// pool merging catalog media with product_match UGC, so [0] is frequently a UGC
// post and trimming would lock a social image in as the seed permanently.
//
// Everything below is the PURE decision + PURE tier selection — no DB, no
// network, no API key. The money shape is untouched: this changes WHICH image
// seeds the ad, never how many billable submits happen (still exactly one
// gpt-image-2/edit per regenerate, and reference count does not move the price).
const regen = require('../services/adRegenerateService');

const PRODUCT = '6a6a4d58054561c15f3ff8a2';
const BRAND   = '6a6a4d58054561c15f3ff800';
const AD = (over) => ({
  kind: 'image',
  variantKind: 'product_image',
  referenceMediaIds: [],
  productId: PRODUCT,
  brandId: BRAND,
  mediaIds: ['aaaaaaaaaaaaaaaaaaaaaaa1', 'aaaaaaaaaaaaaaaaaaaaaaa2', 'aaaaaaaaaaaaaaaaaaaaaaa3'],
  ...over
});
const decide = (over, flagEnabled = true) =>
  regen.reseedDecision({ ad: AD(over), flagEnabled });

// (b) THE OWNER GATE, verbatim: "UGC ads shouldn't be affected by this change,
// we haven't optimized that path yet." A variantKind:'ugc' ad is SUPPOSED to
// seed from a social image.
check('R3 variantKind ugc is NEVER re-seeded (owner: UGC path is unoptimized)',
  decide({ variantKind: 'ugc' }).reseed === false,
  'a ugc ad would be re-derived to a catalog photo, breaking it by design');
check('R3 variantKind ugc skip reason names variantKind',
  decide({ variantKind: 'ugc' }).reason === regen.RESEED_SKIP.NOT_PRODUCT_IMAGE);
check('R3 a missing variantKind is NOT treated as product_image',
  decide({ variantKind: undefined }).reseed === false);

// The whole point of the change.
check('R3 product_image with empty referenceMediaIds IS re-seeded',
  decide({}).reseed === true, 'the stale 3-ref Director stack would replay for ever');
check('R3 re-seeding returns no skip reason',
  decide({}).reason === null);

// (c) owner: "unless the user overrides it".
check('R3 non-empty referenceMediaIds is NEVER re-seeded (operator pick wins)',
  decide({ referenceMediaIds: ['bbbbbbbbbbbbbbbbbbbbbbb1'] }).reseed === false);
check('R3 operator-override skip reason names referenceMediaIds',
  decide({ referenceMediaIds: ['bbbbbbbbbbbbbbbbbbbbbbb1'] }).reason === regen.RESEED_SKIP.OPERATOR_REFS);

// (d) nothing to derive from.
check('R3 no productId is NEVER re-seeded',
  decide({ productId: null }).reseed === false);
check('R3 no-productId skip reason names productId',
  decide({ productId: null }).reason === regen.RESEED_SKIP.NO_PRODUCT);

// (a) static only.
check('R3 a video regenerate is NEVER re-seeded',
  decide({ kind: 'video' }).reseed === false,
  'video reference assembly is a different pipeline and is out of scope');
check('R3 video skip reason names video',
  decide({ kind: 'video' }).reason === regen.RESEED_SKIP.VIDEO);

// Kill switch.
check('R3 flag off -> NEVER re-seeded',
  decide({}, false).reseed === false);
check('R3 flag-off skip reason names REGEN_RESEED_CATALOG_FIRST',
  decide({}, false).reason === regen.RESEED_SKIP.FLAG_OFF);

const savedFlag = process.env.REGEN_RESEED_CATALOG_FIRST;
try {
  delete process.env.REGEN_RESEED_CATALOG_FIRST;
  check('R3 flag UNSET means ON (the owner asked for this behaviour)',
    regen.isRegenReseedCatalogFirstEnabled() === true);
  process.env.REGEN_RESEED_CATALOG_FIRST = '';
  check('R3 flag EMPTY means ON',
    regen.isRegenReseedCatalogFirstEnabled() === true);
  for (const off of ['false', 'FALSE', '0', 'no', 'off', ' off ']) {
    process.env.REGEN_RESEED_CATALOG_FIRST = off;
    check(`R3 flag ${JSON.stringify(off)} means OFF`,
      regen.isRegenReseedCatalogFirstEnabled() === false);
  }
  for (const on of ['true', '1', 'yes', 'on']) {
    process.env.REGEN_RESEED_CATALOG_FIRST = on;
    check(`R3 flag ${JSON.stringify(on)} means ON`,
      regen.isRegenReseedCatalogFirstEnabled() === true);
  }
  // End-to-end through the gate with the real env read, flag unset.
  delete process.env.REGEN_RESEED_CATALOG_FIRST;
  check('R3 flag unset + product_image + no operator refs -> re-seeded (default ON)',
    regen.shouldReseedFromCatalog({
      ad: AD({}), flagEnabled: regen.isRegenReseedCatalogFirstEnabled()
    }) === true);
  process.env.REGEN_RESEED_CATALOG_FIRST = 'false';
  check('R3 flag false + product_image + no operator refs -> NOT re-seeded',
    regen.shouldReseedFromCatalog({
      ad: AD({}), flagEnabled: regen.isRegenReseedCatalogFirstEnabled()
    }) === false);
} finally {
  if (savedFlag === undefined) delete process.env.REGEN_RESEED_CATALOG_FIRST;
  else process.env.REGEN_RESEED_CATALOG_FIRST = savedFlag;
}

// ── R3b: the tier cascade. Mirrors campaignAdsGenerationService.js:2085. ──
const SCOPE = { productId: PRODUCT, brandId: BRAND };
// fileUrl is part of the fixture because it is part of the CONTRACT: a derived id
// is only usable if it resolves to an image the renderer can fetch. Omitting it
// (as this fixture originally did) made four checks pass for the wrong reason once
// the fileUrl guard landed. `over.fileUrl === null` builds the unusable case on
// purpose; pass fileUrl:'' for the empty-string variant.
const cat = (id, over = {}) => ({
  _id: id,
  source: 'catalog-product',
  brandId: BRAND,
  fileType: over.fileType || 'image',
  fileUrl: 'fileUrl' in over ? over.fileUrl : `https://cdn.example/${id}.jpg`,
  createdAt: over.createdAt || '2026-01-01T00:00:00Z',
  metadata: { catalogProductId: PRODUCT, ...(over.metadata || {}) }
});
const pick = (list) => regen.pickFirstCatalogMediaId(list, SCOPE);

// ── R3c: a derived id must be USABLE, not merely well-scoped. ─────────────
// Found by adversarial review of the finished diff, agreed independently by two
// reviewers. The derivation returns only an id; renderDirectImage then loads it
// and, on finding ZERO resolvable references, silently falls back to
// media.fileUrl — the ad's ORIGINAL seed, which on exactly the historical rows
// this feature exists to fix is frequently the UGC/lifestyle image. Combined with
// the "catalog reseed — stack N → 1" log already emitted, that produced a false
// success over a silent UGC seed AND a real billable submit. So an unusable doc
// must be rejected here and become an honest tier-3 skip.
{
  const noUrl    = cat('no_url',    { fileUrl: null, metadata: { imageRole: 'hero' } });
  const blankUrl = cat('blank_url', { fileUrl: '   ', metadata: { imageRole: 'hero' } });
  const good     = cat('good_alt',  { createdAt: '2026-09-01T00:00:00Z' });

  check('R3c a hero doc with a NULL fileUrl is not selectable',
    pick([noUrl]) === null);
  check('R3c a hero doc with a whitespace-only fileUrl is not selectable',
    pick([blankUrl]) === null);
  check('R3c an unusable hero does not shadow a usable catalog image — tier 2 still wins',
    pick([noUrl, good])?.mediaId === 'good_alt');
  check('R3c a catalog VIDEO is never selectable as the first catalog IMAGE',
    pick([cat('vid', { fileType: 'video', metadata: { imageRole: 'video' } })]) === null);
  check('R3c the imageRole video stamp alone also disqualifies',
    pick([cat('vid2', { metadata: { imageRole: 'video' } })]) === null);
  check('R3c a video does not shadow a usable image',
    pick([cat('vid3', { fileType: 'video', createdAt: '2020-01-01T00:00:00Z' }), good])?.mediaId === 'good_alt');
}

// TIER 1 beats TIER 2 even when the hero doc is the NEWEST in the list — that
// ordering is the whole difference between "hero stamp" and "earliest".
const heroLate  = cat('hero_late',  { createdAt: '2026-06-01T00:00:00Z', metadata: { imageRole: 'hero' } });
const altEarly  = cat('alt_early',  { createdAt: '2026-01-01T00:00:00Z', metadata: { imageRole: 'alt' } });
check('R3b tier 1 (imageRole hero) beats tier 2 even when it is the newest doc',
  pick([altEarly, heroLate])?.mediaId === 'hero_late');
check('R3b tier 1 reports tier "hero"',
  pick([altEarly, heroLate])?.tier === 'hero');

// TIER 2 — no hero stamp anywhere: earliest createdAt wins, regardless of the
// order the docs arrive in.
const a2 = cat('alt_2026_03', { createdAt: '2026-03-01T00:00:00Z', metadata: { imageRole: 'alt' } });
const a1 = cat('alt_2026_01', { createdAt: '2026-01-15T00:00:00Z', metadata: { imageRole: 'alt' } });
const a3 = cat('alt_2026_09', { createdAt: '2026-09-01T00:00:00Z', metadata: { imageRole: 'alt' } });
check('R3b tier 2 is used when no doc carries the hero stamp',
  pick([a2, a1, a3])?.mediaId === 'alt_2026_01');
check('R3b tier 2 is order-independent (reversed input, same winner)',
  pick([a3, a2, a1])?.mediaId === 'alt_2026_01');
check('R3b tier 2 reports tier "earliest-createdAt"',
  pick([a2, a1, a3])?.tier === 'earliest-createdAt');

// TIER 3 — no catalog media at all: derive NOTHING so the ad's existing
// behaviour is left completely untouched.
check('R3b tier 3: an empty candidate list derives NOTHING',
  pick([]) === null);
check('R3b tier 3: a list with no catalog media derives NOTHING',
  pick([{ _id: 'ugc_1', source: 'instagram', brandId: BRAND, metadata: { catalogProductId: PRODUCT } }]) === null);

// THE CENTRAL SAFETY PROPERTY. A UGC doc must be unselectable no matter what
// metadata it carries — including the hero stamp, which is exactly the trap that
// querying imageRole alone would fall into. This is the case that makes the
// cascade structurally incapable of seeding an ad from a social post.
const ugcHero = {
  _id: 'ugc_hero', source: 'instagram', brandId: BRAND,
  createdAt: '2020-01-01T00:00:00Z',                       // earliest of everything
  metadata: { catalogProductId: PRODUCT, imageRole: 'hero' } // and stamped hero
};
check('R3b a UGC doc stamped imageRole:hero can NEVER be selected',
  pick([ugcHero, a2])?.mediaId === 'alt_2026_03',
  'querying imageRole without pinning source:catalog-product would pick the social post');
check('R3b a UGC doc is not selected even when it is the ONLY candidate',
  pick([ugcHero]) === null);
check('R3b every non-catalog source is rejected',
  ['instagram', 'tiktok', 'upload', 'brand-site', 'competitor', null, undefined]
    .every((src) => pick([{ ...ugcHero, source: src }]) === null));
check('R3b the guard rejects any non-catalog source directly',
  !regen.isCatalogMediaForProduct(ugcHero, SCOPE));

// Cross-product and cross-tenant leaks. Either one would put another product's
// (or another advertiser's) photograph into this ad.
check('R3b a catalog doc for a DIFFERENT product is rejected',
  pick([cat('other_product', { metadata: { catalogProductId: 'ffffffffffffffffffffffff', imageRole: 'hero' } })]) === null);
check('R3b a catalog doc for a DIFFERENT brand is rejected (cross-tenant)',
  pick([{ ...cat('other_brand', { metadata: { imageRole: 'hero' } }), brandId: 'ffffffffffffffffffffffff' }]) === null);
check('R3b a catalog doc with no catalogProductId is rejected',
  pick([cat('no_product', { metadata: { catalogProductId: null, imageRole: 'hero' } })]) === null);
check('R3b a catalog doc with no brandId is rejected',
  pick([{ ...cat('no_brand', { metadata: { imageRole: 'hero' } }), brandId: null }]) === null);
check('R3b ids compare by string, so ObjectId-vs-string never causes a miss',
  regen.isCatalogMediaForProduct(cat('str_ok'), { productId: { toString: () => PRODUCT }, brandId: { toString: () => BRAND } }));

// A missing createdAt must never beat a stamped doc. Built literally, NOT via
// cat(), because cat()'s `||` default would coerce a null createdAt back to a
// real date and silently defeat the assertion.
const noTs = {
  _id: 'no_ts', source: 'catalog-product', brandId: BRAND,
  // fileType/fileUrl carried explicitly: this fixture is built as a literal
  // rather than via cat(), so it does not inherit the helper's defaults. It is
  // testing the MISSING-createdAt path, not the unusable-media path — leaving
  // fileUrl off would have made it fail the usability guard for the wrong reason.
  fileType: 'image', fileUrl: 'https://cdn.example/no_ts.jpg',
  createdAt: null, metadata: { catalogProductId: PRODUCT, imageRole: 'alt' }
};
check('R3b a doc with no createdAt loses tier 2 to a stamped doc',
  pick([noTs, a3])?.mediaId === 'alt_2026_09');
check('R3b a doc with no createdAt is still selectable when it is the only one',
  pick([noTs])?.mediaId === 'no_ts');

// ── R4: video regenerate camera-prompt overrides ────────────────────────
// The gap this pins (owner 2026-08-03): runVideoFull took NO prompt override,
// so a video re-roll could not replace the canonical camera prompt. The UI
// also required a non-empty refinement textarea even though the API already
// allowed empty prompt + promptOverride for images — every video re-roll
// therefore carried an OPERATOR REFINEMENT line. R4 pins:
//   - empty regenerate still 400s (no intent)
//   - videoPromptRaw alone is enough intent
//   - videoPromptRaw REPLACES via the existing enforceRawByteCap path
//   - videoPromptGuidance / refinement PREPEND via buildVeoPrompt
//   - length caps match the wizard (1000 / 4000)
// Offline: pure helpers + the real veoPromptBuilder exports. No DB/network/key.
// MONEY: these helpers only choose the prompt string — they do not touch
// submit counts (still one Omni submit per runVideoFull).

const {
  buildVeoPrompt,
  enforceRawByteCap
} = require('../services/veoPromptBuilder');

const OMNI_CAPS = { promptByteCap: 20000, paramShape: 'gemini-omni', family: 'gemini-omni' };

// Minimal product/media fixtures — buildVeoPrompt only needs product title
// and seedHasText; brand/media/layoutInput are signature-stable optionals.
const PROMPT_FIXTURE = {
  brand: { name: 'Acme' },
  product: { title: 'Test Bottle 500ml' },
  media: { text: [] },
  layoutInput: null,
  sourceMedia: null,
  aspectRatio: '9:16',
  seedHasText: false,
  hasProductReference: true,
  storyboard: null,
  caps: OMNI_CAPS,
  durationSec: 8
};

// Mirror generateForAd's three prompt branches (atlasVideoService.js) using
// the SAME exported builder functions production uses. Do not reimplement
// the replace/prepend semantics — call buildVeoPrompt / enforceRawByteCap.
function buildLikeGenerateForAd({ ad, operatorPrompt }) {
  const opTrim = typeof operatorPrompt === 'string' ? operatorPrompt.trim() : null;
  if (opTrim) {
    return buildVeoPrompt({ ...PROMPT_FIXTURE, operatorPrompt: opTrim });
  }
  if (typeof ad?.videoPromptRaw === 'string' && ad.videoPromptRaw.trim()) {
    return enforceRawByteCap(ad.videoPromptRaw, OMNI_CAPS);
  }
  const guidance = (typeof ad?.videoPromptGuidance === 'string' && ad.videoPromptGuidance.trim())
    ? ad.videoPromptGuidance.trim()
    : null;
  return buildVeoPrompt({ ...PROMPT_FIXTURE, operatorPrompt: guidance });
}

// ── R4a: request intent gate ────────────────────────────────────────────
check('R4a neither prompt nor any override has NO intent (must 400)',
  regen.regenerateHasIntent({}) === false);
check('R4a empty strings have NO intent',
  regen.regenerateHasIntent({
    prompt: '   ',
    videoPromptRaw: '',
    videoPromptGuidance: '  '
  }) === false);
check('R4a refinement prompt alone has intent',
  regen.regenerateHasIntent({ prompt: 'slow push-in' }) === true);
check('R4a videoPromptRaw alone has intent (no refinement needed)',
  regen.regenerateHasIntent({ videoPromptRaw: 'FULL RAW CAMERA PROMPT' }) === true);
check('R4a videoPromptGuidance alone has intent',
  regen.regenerateHasIntent({ videoPromptGuidance: 'soft morning light' }) === true);
check('R4a promptOverride alone has intent (image path, unchanged)',
  regen.regenerateHasIntent({ promptOverride: { system: 's', user: 'u' } }) === true);

// ── R4b: length caps (wizard parity: guidance ≤1000, raw ≤4000) ─────────
check('R4b VIDEO_PROMPT_GUIDANCE_MAX is 1000 (wizard parsePhase3WizardFields)',
  regen.VIDEO_PROMPT_GUIDANCE_MAX === 1000);
check('R4b VIDEO_PROMPT_RAW_MAX is 4000 (wizard parsePhase3WizardFields)',
  regen.VIDEO_PROMPT_RAW_MAX === 4000);

const overGuidance = 'g'.repeat(1001);
const atGuidance   = 'g'.repeat(1000);
const overRaw      = 'r'.repeat(4001);
const atRaw        = 'r'.repeat(4000);

{
  const badG = regen.parseRegenVideoPromptFields({ videoPromptGuidance: overGuidance });
  check('R4b guidance over 1000 is rejected',
    badG.ok === false && /1000/.test(badG.error || ''),
    badG.error);
  const okG = regen.parseRegenVideoPromptFields({ videoPromptGuidance: atGuidance });
  check('R4b guidance at 1000 is accepted',
    okG.ok === true && okG.videoPromptGuidance === atGuidance);

  const badR = regen.parseRegenVideoPromptFields({ videoPromptRaw: overRaw });
  check('R4b raw over 4000 is rejected',
    badR.ok === false && /4000/.test(badR.error || ''),
    badR.error);
  const okR = regen.parseRegenVideoPromptFields({ videoPromptRaw: atRaw });
  check('R4b raw at 4000 is accepted',
    okR.ok === true && okR.videoPromptRaw === atRaw);

  // Whitespace-only must collapse to null so a blank Advanced textarea
  // does not count as intent and does not stamp an empty raw onto the clone.
  const blank = regen.parseRegenVideoPromptFields({
    videoPromptRaw: '   ',
    videoPromptGuidance: '\n\t'
  });
  check('R4b whitespace-only raw/guidance collapse to null',
    blank.ok === true && blank.videoPromptRaw === null && blank.videoPromptGuidance === null);
}

// ── R4c: resolve path — raw replaces, guidance/refinement prepend ───────
{
  const baseAd = {
    _id: 'ad1',
    kind: 'video',
    videoPromptRaw: null,
    videoPromptGuidance: null
  };

  // Raw alone → path raw, operatorPrompt null, ad clone carries the raw.
  const rawOnly = regen.resolveVideoRegenCall({
    prompt: null,
    videoPromptRaw: 'CUSTOM RAW CAMERA PROMPT FOR A/B',
    videoPromptGuidance: null,
    ad: baseAd
  });
  check('R4c videoPromptRaw alone resolves path=raw',
    rawOnly.path === 'raw');
  check('R4c raw path sets operatorPrompt null (force generateForAd raw branch)',
    rawOnly.operatorPrompt === null);
  check('R4c raw path stamps videoPromptRaw onto the in-memory ad clone',
    rawOnly.adForGen.videoPromptRaw === 'CUSTOM RAW CAMERA PROMPT FOR A/B');
  // Built prompt must be the raw text (byte-capped), NOT the canonical builder
  // and NOT the OPERATOR REFINEMENT header.
  const builtRaw = buildLikeGenerateForAd({
    ad: rawOnly.adForGen,
    operatorPrompt: rawOnly.operatorPrompt
  });
  check('R4c raw path built prompt equals enforceRawByteCap of the override',
    builtRaw === enforceRawByteCap('CUSTOM RAW CAMERA PROMPT FOR A/B', OMNI_CAPS));
  check('R4c raw path built prompt does NOT carry OPERATOR REFINEMENT header',
    !builtRaw.includes('OPERATOR REFINEMENT'));
  check('R4c raw path does NOT include the canonical product title line',
    // Canonical buildVeoPrompt always mentions the product title; a pure raw
    // override of unrelated text must not reintroduce it.
    !builtRaw.includes('Test Bottle 500ml'),
    'raw must fully replace the canonical prompt');

  // Guidance alone → prepend path; real builder emits OPERATOR REFINEMENT.
  const gOnly = regen.resolveVideoRegenCall({
    prompt: null,
    videoPromptRaw: null,
    videoPromptGuidance: 'soft morning light, hand-held bottle',
    ad: baseAd
  });
  check('R4c videoPromptGuidance alone resolves path=prepend',
    gOnly.path === 'prepend');
  check('R4c guidance becomes operatorPrompt',
    gOnly.operatorPrompt === 'soft morning light, hand-held bottle');
  const builtG = buildLikeGenerateForAd({
    ad: gOnly.adForGen,
    operatorPrompt: gOnly.operatorPrompt
  });
  check('R4c guidance path built prompt starts with OPERATOR REFINEMENT',
    builtG.startsWith('OPERATOR REFINEMENT (HIGHEST PRIORITY'));
  check('R4c guidance path includes the operator text',
    builtG.includes('soft morning light, hand-held bottle'));
  check('R4c guidance path still includes product-fidelity (canonical kept)',
    /product|fidelity|Do NOT/i.test(builtG),
    'prepend must keep the canonical safeguards; only raw drops them');

  // Refinement prompt alone (the existing regenerate textarea) → prepend.
  const refOnly = regen.resolveVideoRegenCall({
    prompt: 'slow dolly in on the label',
    videoPromptRaw: null,
    videoPromptGuidance: null,
    ad: baseAd
  });
  check('R4c refinement prompt alone resolves path=prepend',
    refOnly.path === 'prepend' && refOnly.operatorPrompt === 'slow dolly in on the label');

  // When raw is set, refinement + guidance are ignored (wizard parity).
  const rawWins = regen.resolveVideoRegenCall({
    prompt: 'this refinement must be ignored',
    videoPromptRaw: 'RAW WINS',
    videoPromptGuidance: 'this guidance must be ignored',
    ad: baseAd
  });
  check('R4c raw wins over refinement + guidance (wizard parity)',
    rawWins.path === 'raw' &&
    rawWins.operatorPrompt === null &&
    rawWins.adForGen.videoPromptRaw === 'RAW WINS');

  // Refinement wins over guidance when both are present (same mechanism).
  const refWins = regen.resolveVideoRegenCall({
    prompt: 'refinement wins',
    videoPromptRaw: null,
    videoPromptGuidance: 'guidance loses',
    ad: baseAd
  });
  check('R4c refinement prompt wins over videoPromptGuidance when both set',
    refWins.operatorPrompt === 'refinement wins');

  // Nothing supplied → cascade (generateForAd falls through to ad fields).
  const cascade = regen.resolveVideoRegenCall({
    prompt: null,
    videoPromptRaw: null,
    videoPromptGuidance: null,
    ad: { ...baseAd, videoPromptRaw: 'wizard-stamped raw' }
  });
  check('R4c no per-call override resolves path=cascade',
    cascade.path === 'cascade' && cascade.operatorPrompt === null);
  // Pass-through: the clone still carries the wizard stamp so generateForAd
  // can use it — but we never WRITE a per-call override back to the DB.
  check('R4c cascade preserves ad.videoPromptRaw on the clone (wizard stamp)',
    cascade.adForGen.videoPromptRaw === 'wizard-stamped raw');

  // PASS-THROUGH: resolve must not mutate the original ad object.
  const frozen = { ...baseAd, videoPromptRaw: null };
  regen.resolveVideoRegenCall({
    prompt: null,
    videoPromptRaw: 'must not land on original',
    videoPromptGuidance: null,
    ad: frozen
  });
  check('R4c resolve does not mutate the original ad (pass-through only)',
    frozen.videoPromptRaw === null);
}

// ── R5: static regenerate raw IMAGE prompt (imagePromptRaw) ─────────────
// The gap this pins: static regenerate offered ONLY a ≤1000-char refinement
// note appended to the auto-composed prompt. The full-replace channel existed
// in the renderer (rawPromptOverride, which already accepted a bare string)
// but was unreachable from the regenerate API — the route's only door was
// promptOverride {system,user}, which 400s unless BOTH halves are non-empty.
// R5 pins:
//   - the cap is 40000, NOT the video 4000 (the prompt it replaces is ~8k)
//   - imagePromptRaw alone is enough intent
//   - whitespace-only collapses to null (a blank textarea is not intent)
//   - a raw string reaches the model VERBATIM — no {system,user} wrapping and
//     no OPERATOR REFINEMENT header
//   - MONEY: the vision-QC retry carries its corrective note INSIDE the
//     override, so the single allowed regeneration cannot re-submit a
//     byte-identical prompt for a second charge
// Offline: pure helpers + the real directImageRenderService exports.
{
  const directImage = require('../services/directImageRenderService');

  // ── R5a: cap ──────────────────────────────────────────────────────────
  // Deliberately asserted as a VALUE, not just ">= video". Harmonising this
  // down to 4000 for symmetry would truncate every loaded prompt.
  check('R5a IMAGE_PROMPT_RAW_MAX is 40000 (static prompt is ~8k — 4000 would truncate)',
    regen.IMAGE_PROMPT_RAW_MAX === 40000);
  check('R5a image cap is well above the video cap (different prompt sizes)',
    regen.IMAGE_PROMPT_RAW_MAX > regen.VIDEO_PROMPT_RAW_MAX);

  const overCap = 'x'.repeat(regen.IMAGE_PROMPT_RAW_MAX + 1);
  const atCap   = 'y'.repeat(regen.IMAGE_PROMPT_RAW_MAX);
  const badI = regen.parseRegenImagePromptField({ imagePromptRaw: overCap });
  check('R5a imagePromptRaw over the cap is rejected',
    badI.ok === false && /40000/.test(badI.error || ''));
  const okI = regen.parseRegenImagePromptField({ imagePromptRaw: atCap });
  check('R5a imagePromptRaw exactly at the cap is accepted',
    okI.ok === true && okI.imagePromptRaw === atCap);
  // A canonical-length static prompt must sail through — this is the case the
  // feature exists for, and the one a 4000 cap would have broken.
  const realistic = 'P'.repeat(8400);
  const okReal = regen.parseRegenImagePromptField({ imagePromptRaw: realistic });
  check('R5a a realistic ~8.4k static prompt is accepted',
    okReal.ok === true && okReal.imagePromptRaw === realistic);
  check('R5a non-string imagePromptRaw is rejected',
    regen.parseRegenImagePromptField({ imagePromptRaw: { user: 'x' } }).ok === false);
  const blankI = regen.parseRegenImagePromptField({ imagePromptRaw: '   ' });
  check('R5a whitespace-only imagePromptRaw collapses to null (not intent)',
    blankI.ok === true && blankI.imagePromptRaw === null);
  check('R5a absent imagePromptRaw is null, not an error',
    (() => { const r = regen.parseRegenImagePromptField({}); return r.ok === true && r.imagePromptRaw === null; })());

  // ── R5b: intent gate ──────────────────────────────────────────────────
  check('R5b imagePromptRaw alone has intent (no refinement needed)',
    regen.regenerateHasIntent({ imagePromptRaw: 'FULL RAW IMAGE PROMPT' }) === true);
  check('R5b whitespace-only imagePromptRaw has NO intent',
    regen.regenerateHasIntent({ imagePromptRaw: '   ' }) === false);

  // ── R5c: verbatim delivery to the image model ─────────────────────────
  // resolveImagePromptOverride is the production mapper. A bare string must
  // survive untouched: no system/user concatenation, no refinement header.
  const RAW = 'EDITORIAL STILL LIFE. Product centred. No added text.';
  check('R5c a bare raw string resolves verbatim',
    directImage.resolveImagePromptOverride(RAW) === RAW);
  check('R5c raw resolution adds no OPERATOR REFINEMENT header',
    !/OPERATOR REFINEMENT/.test(directImage.resolveImagePromptOverride(RAW)));
  check('R5c whitespace-only override resolves to null (falls back to auto prompt)',
    directImage.resolveImagePromptOverride('   ') === null);
  // The {system,user} shape must keep working — the legacy Generation Details
  // modal still speaks it and shares this one slot.
  check('R5c {system,user} still concatenates (legacy modal unbroken)',
    directImage.resolveImagePromptOverride({ system: 'S', user: 'U' }) === 'S\n\nU');

  // ── R5d: MONEY — the vision-QC retry must not repeat itself ───────────
  // Without composeCorrectiveOverride the QC retry re-enters renderDirectImage
  // with operatorPrompt=correctiveNote AND the override still set; the override
  // wins, the note-appending branch is never reached, and the one allowed
  // regeneration pays for a byte-identical prompt and an identical verdict.
  const NOTE = 'Remove the competitor emblem from the midfoot panel.';
  const composed = directImage.composeCorrectiveOverride(RAW, NOTE);
  check('R5d QC retry keeps the operator override text',
    composed.includes(RAW));
  check('R5d QC retry actually carries the corrective note',
    composed.includes(NOTE));
  check('R5d QC retry prompt DIFFERS from the first attempt (no identical re-submit)',
    composed !== RAW);
  check('R5d no note is a no-op (non-QC renders are untouched)',
    directImage.composeCorrectiveOverride(RAW, null) === RAW
    && directImage.composeCorrectiveOverride(RAW, '   ') === RAW);
  check('R5d no override is a no-op (auto-prompt path keeps its own note handling)',
    directImage.composeCorrectiveOverride(null, NOTE) === null);
}

if (failures.length) {
  console.error(`\n❌ regeneration: ${failures.length} FAILED, ${pass} passed\n`);
  failures.forEach((f) => console.error(`   • ${f}`));
  process.exit(1);
}
console.log(`✅ regeneration: ${pass} checks passed`);
