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

if (failures.length) {
  console.error(`\n❌ regeneration: ${failures.length} FAILED, ${pass} passed\n`);
  failures.forEach((f) => console.error(`   • ${f}`));
  process.exit(1);
}
console.log(`✅ regeneration: ${pass} checks passed`);
