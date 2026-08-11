#!/usr/bin/env node
'use strict';
//
// verifyGenerationGate — the concurrency + duplicate gate on POST
// /api/ads/generate (and its counterpart, POST /api/ads/runs).
//
// MONEY-CRITICAL, same as before the 2026-08-10 rewrite, for the same
// underlying reason: every /generate expansion mints its OWN ads
// (identityDigest is scoped to generationRunId), so nothing downstream of
// this gate can tell a legitimate second run from an accidental one — both
// claim exactly what they just created and both bill. This gate is the ONLY
// double-click protection that exists.
//
// ── WHAT CHANGED, AND WHY THE HARNESS CHANGED WITH IT ───────────────────
//
// The gate used to key on PRODUCT OVERLAP: any new run whose productIds
// intersected an in-flight run's was refused outright. Owner directive
// 2026-08-10: don't block concurrent ads on product alone — block on the
// ACTUAL REQUEST. So the key is now the REQUEST FINGERPRINT
// (computeRequestFingerprint in services/generationGate.js): a hash over
// exactly the fields that determine what gets generated. Two runs over the
// same product with genuinely different requests now run in parallel and
// BOTH bill — that is allowed, on purpose. Only a byte-identical request is
// refused, and even that is overridable on explicit confirmation.
//
// This is a RE-AIM of the money guard, not a loosening of it, and the
// justification lives in the digest functions this gate does not own:
//
//   * VIDEO cannot double-bill across runs AT ALL. Both video identity
//     digests are RUN-INDEPENDENT — computeV2IdentityDigest omits
//     generationRunId when kind==='video', and computeDeterministicVideoDigest
//     never includes it (campaignAdsGenerationService.js). Two concurrent
//     runs that would mint the same video ad collide on the
//     (campaignId, identityDigest) UNIQUE INDEX, and the second insert is a
//     silent no-op. The unique index is what protects video spend; this gate
//     never was, and still isn't.
//
//   * STATIC duplicates are DELIBERATE, by owner design. The static
//     identityDigest IS scoped to generationRunId specifically so a repeat
//     Generate produces fresh creative — owner, verbatim: "there should be no
//     limitation on creating new ads that may be duplicates since generative
//     ads always have new seeds." A second static set for the same product is
//     new creative that was asked for, not a double charge for one asset.
//
// That is WHY blocking is now limited to identical requests: video is already
// protected elsewhere (the unique index), and static repeats are a feature,
// not a bug. The only thing left worth stopping is the ACCIDENT — the
// double-click, which is by definition a repeat of the SAME request. You
// cannot double-click your way into a different preset or a different media
// pick. So fingerprint identity is a strictly more accurate detector of the
// thing worth blocking than product overlap ever was.
//
// This harness therefore verifies a different (and larger) surface than the
// pre-rewrite version: the fingerprint function itself (determinism, and
// sensitivity to every field that changes cost or creative — miss one and a
// real double-click can hash "different" and sail through; include one the
// route never reads and a legitimate second request gets falsely blocked —
// see ── 3, THE ANTI-TRAP), the decision function's outcomes (allowed /
// notice-only / duplicate-in-flight / duplicate-of-previous), the
// confirmation flow AND its anti-replay containment (a stale
// acknowledgedRunId must not excuse a SECOND double-click — see ── 8, THE
// OVERRIDE MUST NOT BECOME A HOLE), the render-claim escape hatch, rollout
// compat with pre-rewrite rows, and the mint-then-verify race resolution.
//
// Drives the REAL exported functions — require the module, call it. No
// mocking of the logic, no source-scanning to infer behaviour. Source
// scanning is used ONLY in ── 14, for wiring facts a pure unit test cannot
// see (does the route actually compute and forward the fingerprint? does it
// select it back out of Mongo on both queries? does it stamp it at mint
// time? does the confirm loop actually reach both call sites?).
//
// Pure + offline: no DB, no network, no API key.
//   node scripts/verifyGenerationGate.js

const fs = require('fs');
const path = require('path');
const {
  generationGateDecision,
  normalizeProductIdList,
  computeRequestFingerprint,
  renderClaimFingerprint,
  buildOverlapNotice,
  isSameRequest,
  sameProductSet,
  pickSupersedingRun,
  compareRunOrder,
  FINGERPRINT_VERSION
} = require('../services/generationGate');

let pass = 0;
const failures = [];

function check(label, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

// ObjectId-hex-shaped test ids, built by construction (not hand-counted) so
// they are guaranteed to satisfy OBJECT_ID_HEX (24 hex chars) every time.
const oid = (ch, n) => `68e9${ch.repeat(19)}${n}`;
const P1 = oid('a', '1');
const P2 = oid('a', '2');
const M1 = oid('b', '1');
const M2 = oid('b', '2');

// ── 0. MODULE SURFACE — the require actually works and exports the shape ──
//      this whole harness depends on. A silent rename would make every
//      destructured name below `undefined`, and calling `undefined(...)`
//      throws immediately — this exists so that failure names its cause
//      instead of section 1 reporting a wall of cryptic TypeErrors.
// ─────────────────────────────────────────────────────────────────────────
for (const [name, value] of Object.entries({
  generationGateDecision, normalizeProductIdList, computeRequestFingerprint,
  renderClaimFingerprint, buildOverlapNotice, isSameRequest, sameProductSet,
  pickSupersedingRun, compareRunOrder
})) {
  check(`0.${name} is exported as a function`, typeof value === 'function');
}
check('0.FINGERPRINT_VERSION is exported as a non-empty string',
  typeof FINGERPRINT_VERSION === 'string' && FINGERPRINT_VERSION.length > 0);

// ── 1. FINGERPRINT — determinism, and sensitivity to every money-affecting
//       field. This is the whole ballgame: the gate's identity check is only
//       as good as this hash. Leave a field OUT and two requests that produce
//       DIFFERENT creative (different cost) hash the SAME, so a real
//       double-click can sail through hashing "different" from itself is not
//       the risk — the risk is the reverse: two DIFFERENT requests colliding
//       and the second one either being wrongly nagged as a duplicate (safe
//       direction) or, if the identical-looking pair is actually a
//       double-click, unmasked as "different" so it is never caught at all.
// ─────────────────────────────────────────────────────────────────────────
const BASE = { campaignId: 'C1', productIds: [P1], templateIds: ['ai_brand_led'], preset: 'single' };
const fp = (overrides) => computeRequestFingerprint({ ...BASE, ...overrides });

check('1.0a fingerprint is deterministic — same input twice → same hash', fp({}) === fp({}));
check('1.0b fingerprint is a sha256 hex string', /^[0-9a-f]{64}$/.test(fp({})));

// One check per generation-affecting field. Data-driven so a field the route
// starts reading tomorrow is a one-line addition here, not a new hand-written
// block. `kinds` IS in this table (as a scalar — the real route shape); see
// the extra checks just below the table for why that specific shape mattered.
// `refresh` and `expandVideoFormats` are deliberately NOT in this table — they
// must NOT change the fingerprint, and are pinned as anti-trap cases in ── 3.
const SENSITIVE_FIELDS = [
  ['productIds',             { productIds: [P1, P2] }],
  ['mediaIds',               { mediaIds: [M1] }],
  ['templateIds',            { templateIds: ['ai_promotional'] }],
  ['preset',                 { preset: 'meta_all' }],
  ['platformFormat',         { platformFormat: 'meta_feed_1_1' }],
  ['expandStaticFormats',    { expandStaticFormats: true }],
  ['includeCategoryMatched', { includeCategoryMatched: true }],
  ['includeBrandMatched',    { includeBrandMatched: true }],
  ['excludePairings',        { excludePairings: [{ productId: P1, mediaId: M1 }] }],
  ['cta.text',               { cta: { text: 'SHOP NOW' } }],
  ['cta.url',                { cta: { url: 'https://example.com/x' } }],
  ['urlParams',              { urlParams: 'utm_source=ig' }],
  ['videoDurationSec',       { videoDurationSec: 8 }],
  ['directorVariants',       { directorVariants: true }],
  ['seedPicks',              { seedPicks: [{ productId: P1, mediaId: M1 }] }],
  ['seedMediaIds',           { seedMediaIds: [M1] }],
  ['videoPromptGuidance',    { videoPromptGuidance: 'moody lighting, handheld' }],
  ['videoPromptRaw',         { videoPromptRaw: 'full replacement camera prompt' }],
  // Scalar shape, exactly as routes/ads.js sends it. Was a real defect — every
  // scalar value collapsed to '' so static-only and video-only hashed the same.
  ['kinds (scalar)',         { kinds: 'video' }],
  // Operator multi-select surfaces (preset 'explicit'). The route reads both and
  // forwards them into resolvePreset, so both must reach the hash.
  ['staticFormats',          { staticFormats: ['meta_feed_1_1'] }],
  ['videoFormats',           { videoFormats: ['meta_stories_9_16'] }]
];
for (const [name, override] of SENSITIVE_FIELDS) {
  check(`1.${name} changes the fingerprint`, fp(override) !== fp({}),
    `'${name}' had NO effect on the hash — a real request difference would be invisible to the gate`);
}

// Bonus, not in the required list: campaignId is part of the hash too
// (defense in depth — the DB query is already scoped to campaignId, but two
// campaigns making the identical request must not be able to collide if that
// scoping is ever loosened elsewhere).
check('1.campaignId changes the fingerprint',
  computeRequestFingerprint({ ...BASE, campaignId: 'C2' }) !== fp({}));

// `kinds` — this WAS a real defect, found while building this harness and now
// FIXED in services/generationGate.js (canonicalScalarOrList). routes/ads.js
// destructures `kinds` as a bare SCALAR ('image'|'video'|'both'|null), and the
// original canonicalIdList returned [] for any non-array, so every scalar value
// contributed the same '' to the hash: image-only, video-only, "both" and null
// all fingerprinted IDENTICALLY. Two requests with wildly different bills
// (static generation vs video generation) collided, and the second was refused
// as a duplicate — a false block on the single most likely real sequence, which
// is "generate the statics, then generate the video". Fail-safe in direction (a
// confirm click, not a double charge) but squarely the "omitted field that does
// affect output" trap this module warns about.
//
// Pinned below in BOTH shapes so the fix cannot silently regress: the scalar
// shape is the one the route actually sends, and the array shape must keep
// agreeing with it.
check('1.kinds scalar values are all DISTINCT from each other (the real route shape)',
  fp({ kinds: 'video' }) !== fp({ kinds: 'image' }) &&
  fp({ kinds: 'both' })  !== fp({ kinds: 'video' }) &&
  fp({ kinds: 'both' })  !== fp({ kinds: 'image' }),
  'a scalar kinds must reach the hash — collapsing it to "" makes a static run and a video run identical');
check('1.kinds scalar differs from absent/null',
  fp({ kinds: 'video' }) !== fp({}) && fp({ kinds: null }) === fp({}));
check('1.kinds array shape still works', fp({ kinds: ['video'] }) !== fp({ kinds: ['image'] }));
check('1.kinds scalar and single-item array agree (one canonical form, not two)',
  fp({ kinds: 'video' }) === fp({ kinds: ['video'] }),
  'the two shapes must normalize to the same hash or the same request from two callers looks different');

// staticFormats / videoFormats — the wizard's multi-select sizes (preset
// 'explicit'). These are the SAME trap class as `kinds` above and the stakes are
// higher, because the field maps directly onto how many billable image
// generations the run produces: one per ticked static surface, per concept.
// Leaving them out of the hash would make "1:1 only" (1x image spend) and
// "1:1 + 4:5 + Stories" (3x) fingerprint IDENTICALLY, so an operator who
// generated one size and then came back for all three would be refused as a
// duplicate — a false block on an obviously-different request.
const M3 = ['meta_feed_1_1', 'meta_feed_4_5', 'meta_stories_9_16'];
check('1.staticFormats size COUNT changes the hash (1 size vs 3 = 1x vs 3x image spend)',
  fp({ preset: 'explicit', staticFormats: ['meta_feed_1_1'] }) !==
  fp({ preset: 'explicit', staticFormats: M3 }),
  'a 1-size and a 3-size request must not collide — the second would be refused as a duplicate');
check('1.staticFormats WHICH sizes changes the hash (same count, different surfaces)',
  fp({ preset: 'explicit', staticFormats: ['meta_feed_1_1'] }) !==
  fp({ preset: 'explicit', staticFormats: ['meta_feed_4_5'] }));
check('1.staticFormats is ORDER-INSENSITIVE (a set of surfaces, each expanded independently)',
  fp({ preset: 'explicit', staticFormats: M3 }) ===
  fp({ preset: 'explicit', staticFormats: [...M3].reverse() }),
  'tick order cannot change what is generated, so it must not change the hash — same rule as productIds');
check('1.staticFormats DEDUPES (a repeated tick is the same request)',
  fp({ preset: 'explicit', staticFormats: ['meta_feed_1_1', 'meta_feed_1_1'] }) ===
  fp({ preset: 'explicit', staticFormats: ['meta_feed_1_1'] }));
check('1.videoFormats is ORDER-INSENSITIVE',
  fp({ preset: 'explicit', videoFormats: ['meta_feed_1_1', 'meta_stories_9_16'] }) ===
  fp({ preset: 'explicit', videoFormats: ['meta_stories_9_16', 'meta_feed_1_1'] }));
check('1.staticFormats and videoFormats are DISTINCT slots (same key, different side)',
  fp({ preset: 'explicit', staticFormats: ['meta_feed_1_1'] }) !==
  fp({ preset: 'explicit', videoFormats: ['meta_feed_1_1'] }),
  'ticking a surface for static must not hash the same as ticking it for video — different spend entirely');
check('1.absent format lists equal empty lists (old callers keep one canonical hash)',
  fp({ staticFormats: [] }) === fp({}) && fp({ videoFormats: [] }) === fp({}));
check('1.static-only and static+video differ (adding a video master is added spend)',
  fp({ preset: 'explicit', staticFormats: M3 }) !==
  fp({ preset: 'explicit', staticFormats: M3, videoFormats: ['meta_stories_9_16'] }));

// ── 1b. THE FALSE-ALLOW FIX — hash the RESOLVED billable set, not the body ──
//
// Found by adversarial review. The gate's job is to recognise a REPEAT of the
// same request, and "same request" has to mean the same BILLABLE SURFACE SET,
// not the same JSON. The route therefore normalises the multi-select lists
// through resolveExplicitFormats (the same function the expansion uses) and
// hashes THAT, zeroing the fields 'explicit' ignores.
//
// Without this, several pairs of bodies that generate byte-identical creative
// hashed DIFFERENTLY — so a genuine double-click was not recognised and the
// second click billed a second full set of static generations. Static is the
// unprotected half: its identityDigest is scoped to generationRunId, so no
// unique index catches the duplicate the way it does for video.
//
// These checks model the ROUTE's normalisation (resolve → hash) and assert the
// collapse behaviourally, rather than trusting the route's source text.
{
  const pfmt = require('../services/platformFormats');
  // Mirror of what routes/ads.js now builds for the fingerprint.
  const routeFp = (body) => {
    const isExplicit = body.preset === 'explicit';
    const r = isExplicit
      ? pfmt.resolveExplicitFormats({ staticFormats: body.staticFormats, videoFormats: body.videoFormats })
      : { staticFormats: [], videoFormats: [] };
    return computeRequestFingerprint({
      ...BASE, ...body,
      kinds:               isExplicit ? null  : body.kinds,
      expandStaticFormats: isExplicit ? false : body.expandStaticFormats,
      staticFormats: r.staticFormats,
      videoFormats:  r.videoFormats
    });
  };

  check('1b.a video-ONLY key sent in staticFormats collapses (Reels carries no static image)',
    routeFp({ preset: 'explicit', staticFormats: ['meta_feed_1_1', 'meta_reels_9_16'] }) ===
    routeFp({ preset: 'explicit', staticFormats: ['meta_feed_1_1'] }),
    'both bodies generate exactly one 1:1 image — hashing them differently lets a double-click bill twice');
  check('1b.a duplicate tick collapses',
    routeFp({ preset: 'explicit', staticFormats: ['meta_feed_1_1', 'meta_feed_1_1'] }) ===
    routeFp({ preset: 'explicit', staticFormats: ['meta_feed_1_1'] }));
  check('1b.a coming_soon tick collapses (it is dropped before generation)',
    routeFp({ preset: 'explicit', staticFormats: ['meta_feed_1_1', 'pmax_16_9'] }) ===
    routeFp({ preset: 'explicit', staticFormats: ['meta_feed_1_1'] }));
  check('1b.an unknown key collapses',
    routeFp({ preset: 'explicit', staticFormats: ['meta_feed_1_1', 'nope_not_real'] }) ===
    routeFp({ preset: 'explicit', staticFormats: ['meta_feed_1_1'] }));
  check("1b.'kinds' is ignored under explicit, so it cannot change the hash",
    routeFp({ preset: 'explicit', staticFormats: M3, kinds: 'video' }) ===
    routeFp({ preset: 'explicit', staticFormats: M3 }),
    'explicit derives kinds from the lists; hashing a field the resolver ignores hides real double-clicks');
  check("1b.'expandStaticFormats' is ignored under explicit, so it cannot change the hash",
    routeFp({ preset: 'explicit', staticFormats: M3, expandStaticFormats: true }) ===
    routeFp({ preset: 'explicit', staticFormats: M3 }));
  check('1b.leftover lists on a NAMED preset cannot change the hash (named presets ignore them)',
    routeFp({ preset: 'meta_static', staticFormats: ['meta_feed_1_1'], videoFormats: M3 }) ===
    routeFp({ preset: 'meta_static' }),
    'stale checkbox state left on a named preset would otherwise unmask a genuine double-click');
  check('1b.two video tick ORDERS that clamp to the same plate hash the same',
    routeFp({ preset: 'explicit', videoFormats: ['meta_feed_1_1', 'meta_feed_4_5'] }) ===
    routeFp({ preset: 'explicit', videoFormats: ['meta_feed_4_5', 'meta_feed_1_1'] }));

  // And the inverse must still hold — genuinely different spend must still differ.
  check('1b.STILL DISTINGUISHES 1 size from 3 sizes (1x vs 3x image spend)',
    routeFp({ preset: 'explicit', staticFormats: ['meta_feed_1_1'] }) !==
    routeFp({ preset: 'explicit', staticFormats: M3 }));
  check('1b.STILL DISTINGUISHES which size',
    routeFp({ preset: 'explicit', staticFormats: ['meta_feed_1_1'] }) !==
    routeFp({ preset: 'explicit', staticFormats: ['meta_feed_4_5'] }));
  check('1b.STILL DISTINGUISHES static-only from static+video',
    routeFp({ preset: 'explicit', staticFormats: M3 }) !==
    routeFp({ preset: 'explicit', staticFormats: M3, videoFormats: ['meta_stories_9_16'] }));
  check('1b.STILL DISTINGUISHES explicit from the named preset covering the same sizes',
    routeFp({ preset: 'explicit', staticFormats: M3 }) !== routeFp({ preset: 'meta_static' }),
    'preset is hashed independently; these are different requests even where output matches');
  check('1b.a caller sending NEITHER list is unaffected by all of this',
    routeFp({ preset: 'single', kinds: 'image' }) ===
    computeRequestFingerprint({ ...BASE, preset: 'single', kinds: 'image' }));
}

// ── 2. FINGERPRINT ORDER RULES — order-insensitive vs order-sensitive lists,
//       dedupe, blank/null handling, non-array tolerance. Getting this
//       backwards in either direction is a money bug: sorting an
//       order-sensitive list (mediaIds/seedMediaIds/seedPicks) makes a
//       genuinely different reference-order request look identical to an
//       earlier one and wrongly blocks it; failing to sort an
//       order-insensitive list (productIds/templateIds) makes picking the
//       same set in a different order look like a NEW request and lets a
//       real double-click through unblocked.
// ─────────────────────────────────────────────────────────────────────────
check('2a productIds is order-INSENSITIVE (sorted) — each expands independently, pick order cannot change the output set',
  fp({ productIds: [P1, P2] }) === fp({ productIds: [P2, P1] }));
check('2b templateIds is order-INSENSITIVE (sorted)',
  fp({ templateIds: ['ai_brand_led', 'ai_promotional'] }) === fp({ templateIds: ['ai_promotional', 'ai_brand_led'] }));
check('2c mediaIds is order-SENSITIVE — reference order is load-bearing ("a different pick order is a different ad")',
  fp({ mediaIds: [M1, M2] }) !== fp({ mediaIds: [M2, M1] }));
check('2d seedMediaIds is order-SENSITIVE',
  fp({ seedMediaIds: [M1, M2] }) !== fp({ seedMediaIds: [M2, M1] }));
check('2e seedPicks is order-SENSITIVE (pick order can change the video reference stack)',
  fp({ seedPicks: [{ productId: P1, mediaId: M1 }, { productId: P2, mediaId: M2 }] }) !==
  fp({ seedPicks: [{ productId: P2, mediaId: M2 }, { productId: P1, mediaId: M1 }] }));

check('2f productIds dedupes', fp({ productIds: [P1, P1, P2] }) === fp({ productIds: [P1, P2] }));
check('2g mediaIds dedupes (first occurrence order preserved)',
  fp({ mediaIds: [M1, M1, M2] }) === fp({ mediaIds: [M1, M2] }));
check('2h templateIds dedupes',
  fp({ templateIds: ['ai_brand_led', 'ai_brand_led'] }) === fp({ templateIds: ['ai_brand_led'] }));
check('2i seedPicks dedupes identical (productId, mediaId) pairs',
  fp({ seedPicks: [{ productId: P1, mediaId: M1 }, { productId: P1, mediaId: M1 }] }) ===
  fp({ seedPicks: [{ productId: P1, mediaId: M1 }] }));

check('2j blank/null entries are dropped from productIds, not treated as real ids',
  fp({ productIds: [P1, null, '', '   ', P2] }) === fp({ productIds: [P1, P2] }));
check('2k blank/null entries are dropped from mediaIds',
  fp({ mediaIds: [M1, null, '', M2] }) === fp({ mediaIds: [M1, M2] }));

check('2l non-array productIds is tolerated (treated as [], never throws)',
  fp({ productIds: 'not-an-array' }) === fp({ productIds: [] }));
check('2m non-array excludePairings is tolerated',
  fp({ excludePairings: 'not-an-array' }) === fp({ excludePairings: [] }));
check('2n non-array seedPicks is tolerated',
  fp({ seedPicks: 'not-an-array' }) === fp({ seedPicks: [] }));
check('2o non-array mediaIds is tolerated',
  fp({ mediaIds: { not: 'an-array' } }) === fp({ mediaIds: [] }));

// ── 3. THE ANTI-TRAP — a field the route does NOT read must NOT affect the
//       fingerprint. This is the direction that actually costs money: a
//       field with no effect on what gets generated but that DOES change the
//       hash would make a byte-for-byte identical generation request hash
//       DIFFERENTLY depending on some cosmetic/irrelevant value — and a real
//       double-click would sail straight through unblocked. TWO live examples
//       today, and they fail in different ways: `expandVideoFormats` — the
//       wizard's Step4Generate.tsx sends it, but routes/ads.js never
//       destructures it at all — and `refresh` — routes/ads.js DOES
//       destructure it (`refresh = false`), but never forwards it to
//       expandWizardJob on either /preview or /generate, so it is a dead
//       field for generation purposes even though it exists on req.body.
//       Both are confirmed absent from the source pin in ── 14 that checks
//       only the fields actually forwarded. Before adding ANY field to
//       computeRequestFingerprint, confirm the /generate handler actually
//       reads it AND actually forwards it into the expansion — this check
//       exists so that mistake is caught here, not discovered later as a
//       double-billing support ticket.
// ─────────────────────────────────────────────────────────────────────────
check('3a expandVideoFormats (sent by the wizard, never read by the route) does not affect the fingerprint',
  fp({ expandVideoFormats: true }) === fp({}) && fp({ expandVideoFormats: false }) === fp({ expandVideoFormats: true }),
  'if this fails, someone wired expandVideoFormats into computeRequestFingerprint without the route reading it first');
check('3a2 refresh (destructured by the route, but never forwarded to expandWizardJob on /preview or /generate) does not affect the fingerprint',
  fp({ refresh: true }) === fp({}) && fp({ refresh: false }) === fp({ refresh: true }),
  'refresh is a dead field for generation purposes — hashing it would be the same money bug as hashing expandVideoFormats: ' +
  'two requests that produce IDENTICAL creative would hash differently and a real double-click would sail through as "not a duplicate"');
check('3b an arbitrary unknown field does not affect the fingerprint',
  fp({ thisFieldDoesNotExist: 'anything' }) === fp({}));
check('3c near-miss field names (wrong case / singular) are silently ignored, not partially read',
  fp({ productId: P2, mediaID: M1, Preset: 'meta_all' }) === fp({}));
check('3d extra unrelated top-level junk alongside the real fields still hashes only the real fields',
  fp({ extra: 1, nested: { a: 1 }, arr: [1, 2, 3] }) === fp({}));

// ── 4. THE REGRESSION THIS CHANGE FIXES — media-library generation must be a
//       first-class, fingerprintable, ALLOWED request even while a totally
//       unrelated product-catalog run is in flight, in BOTH directions. The
//       old product-overlap gate normalized productIds:[] to "unknown scope"
//       and failed CLOSED on it, so a media-library run (which legitimately
//       has no productIds — it seeds from media, not a SKU) was refused
//       whenever ANY sibling run existed, and while it was itself in flight
//       it blocked every product run too. This is the bug that started the
//       rewrite; it must never come back.
// ─────────────────────────────────────────────────────────────────────────
const activeProductRun = [{ runId: 'runProd1', createdAt: new Date('2026-08-10T10:00:00Z'),
  requestedProductIds: [P1], requestFingerprint: fp({}) }];
const mediaFp = fp({ productIds: [], mediaIds: [M1] });

{
  const d = generationGateDecision({ activeRuns: activeProductRun, fingerprint: mediaFp, requestedProductIds: [] });
  check('4a media-only request is allowed alongside an unrelated active PRODUCT run', d.blocked === false, JSON.stringify(d));
  check('4b media-only request produces no product-overlap notice (it has no products to overlap)',
    d.notice === null, JSON.stringify(d.notice));
}
{
  const activeMediaRun = [{ runId: 'runMedia1', createdAt: new Date('2026-08-10T10:00:00Z'),
    requestedProductIds: [], requestFingerprint: mediaFp }];
  const d = generationGateDecision({ activeRuns: activeMediaRun, fingerprint: fp({}), requestedProductIds: [P1] });
  check('4c a product request is allowed alongside an unrelated active MEDIA-ONLY run', d.blocked === false, JSON.stringify(d));
}
{
  // Two active runs, one product one media — a THIRD, media-only request must
  // still be allowed; surviving a single sibling is not enough.
  const mixed = [
    { runId: 'runProd2', createdAt: new Date(), requestedProductIds: [P1], requestFingerprint: fp({}) },
    { runId: 'runMedia2', createdAt: new Date(), requestedProductIds: [], requestFingerprint: fp({ productIds: [], mediaIds: [M2] }) }
  ];
  const d = generationGateDecision({ activeRuns: mixed, fingerprint: fp({ productIds: [], mediaIds: [M1] }), requestedProductIds: [] });
  check('4d media-only request allowed alongside BOTH a product run and a DIFFERENT media run', d.blocked === false, JSON.stringify(d));
}
check('4e a media-only fingerprint is a real, distinct, well-formed hash — not empty or degenerate',
  typeof mediaFp === 'string' && mediaFp.length === 64 && mediaFp !== fp({}));

// ── 5. IDENTICAL REQUEST ALREADY IN FLIGHT → the double-click, still refused
//       by default, confirmably.
// ─────────────────────────────────────────────────────────────────────────
{
  const d = generationGateDecision({ activeRuns: activeProductRun, fingerprint: fp({}), requestedProductIds: [P1] });
  check('5a identical in-flight request is blocked', d.blocked === true && d.reason === 'duplicate-in-flight', JSON.stringify(d));
  check('5b blocked decision is confirmable', d.confirmable === true);
  check('5c acknowledgeRunId names the actual conflicting run', d.acknowledgeRunId === 'runProd1');
  check('5d conflictRunId also names the conflicting run', d.conflictRunId === 'runProd1');
  check('5e a blocked decision carries no notice (the reason is the verdict; notice is for allowed requests)', d.notice === null);
}
{
  // Two identical in-flight runs, neither acknowledged: must name the
  // EARLIEST one (createdAt, then runId) — the one the user would actually
  // have been shown first.
  const two = [
    { runId: 'runEarly', createdAt: new Date('2026-08-10T10:00:00Z'), requestFingerprint: fp({}) },
    { runId: 'runLate', createdAt: new Date('2026-08-10T10:00:05Z'), requestFingerprint: fp({}) }
  ];
  const d = generationGateDecision({ activeRuns: two, fingerprint: fp({}), requestedProductIds: [P1] });
  check('5f with multiple identical in-flight runs, names the EARLIEST as the conflict',
    d.acknowledgeRunId === 'runEarly', d.acknowledgeRunId);
}

// ── 6. SAME PRODUCT, DIFFERENT REQUEST → allowed, with a non-blocking
//       notice. Owner's "note but allow on confirm" language applies to
//       IDENTICAL requests; a merely-overlapping DIFFERENT request was never
//       something the owner asked to block — it is reported so the cost
//       stays visible, and nothing more.
// ─────────────────────────────────────────────────────────────────────────
{
  const d = generationGateDecision({ activeRuns: activeProductRun, fingerprint: fp({ preset: 'meta_all' }), requestedProductIds: [P1] });
  check('6a same product, different request → allowed', d.blocked === false, JSON.stringify(d));
  check('6b overlap surfaces as a notice, not a verdict', !!d.notice && d.notice.code === 'concurrent-run-shares-products');
  check('6c notice lists exactly the shared productIds',
    !!d.notice && Array.isArray(d.notice.productIds) && d.notice.productIds.length === 1 && d.notice.productIds[0] === P1);
  check('6d notice names the conflicting run', !!d.notice && d.notice.runId === 'runProd1');
}
{
  const d = generationGateDecision({ activeRuns: activeProductRun, fingerprint: fp({ productIds: [P2], preset: 'meta_all' }), requestedProductIds: [P2] });
  check('6e disjoint products, different request → no notice at all', d.blocked === false && d.notice === null, JSON.stringify(d));
}
{
  // The notice must skip a non-overlapping run sitting ahead of the real
  // conflict. These three share a createdAt, so the (createdAt, runId) order
  // resolves on runId — 'firstOverlap' < 'secondOverlap'.
  const runs = [
    { runId: 'noOverlap', createdAt: new Date(), requestedProductIds: [P2], requestFingerprint: fp({ productIds: [P2] }) },
    { runId: 'firstOverlap', createdAt: new Date(), requestedProductIds: [P1], requestFingerprint: fp({ preset: 'meta_all' }) },
    { runId: 'secondOverlap', createdAt: new Date(), requestedProductIds: [P1], requestFingerprint: fp({ preset: 'meta_static' }) }
  ];
  const d = generationGateDecision({ activeRuns: runs, fingerprint: fp({ preset: 'meta_video' }), requestedProductIds: [P1] });
  check('6f notice skips the non-overlapping run ahead of the real conflict',
    !!d.notice && d.notice.runId === 'firstOverlap', JSON.stringify(d.notice));
  check('6g notice unions overlapping productIds across ALL overlapping runs, not just the first',
    !!d.notice && d.notice.productIds.length === 1 && d.notice.productIds[0] === P1);
}
{
  // ORDER STABILITY. The notice puts a runId in front of the operator, and
  // Mongo's find() applies no sort here — so picking "whichever overlapping run
  // came back first" would name an arbitrary run, and the same situation could
  // surface a different id on each attempt. It must name the EARLIEST by the
  // same (createdAt, runId) total order the blocking path uses, regardless of
  // the order the rows arrive in. Distinct timestamps, so this tests createdAt
  // rather than resolving on the runId tie-break.
  const early = { runId: 'zzz_early', createdAt: new Date('2026-08-10T10:00:00Z'), requestedProductIds: [P1], requestFingerprint: fp({ preset: 'meta_all' }) };
  const late  = { runId: 'aaa_late',  createdAt: new Date('2026-08-10T10:05:00Z'), requestedProductIds: [P1], requestFingerprint: fp({ preset: 'meta_static' }) };
  const asGiven   = buildOverlapNotice({ activeRuns: [late, early], requestedProductIds: [P1] });
  const reversed  = buildOverlapNotice({ activeRuns: [early, late], requestedProductIds: [P1] });
  check('6h notice names the EARLIEST overlapping run by createdAt, not list position',
    !!asGiven && asGiven.runId === 'zzz_early', JSON.stringify(asGiven));
  check('6i notice is order-STABLE — same answer whichever order the rows arrive in',
    !!asGiven && !!reversed && asGiven.runId === reversed.runId,
    'an unsorted pick would name a different run depending on Mongo natural order');
  check('6j 6h really tested createdAt, not the runId tie-break (alphabetically the LATE run wins)',
    'aaa_late'.localeCompare('zzz_early') < 0);
}

// ── 7. CONFIRMATION FLOW — acknowledging the named conflict allows the run.
// ─────────────────────────────────────────────────────────────────────────
{
  const d = generationGateDecision({ activeRuns: activeProductRun, fingerprint: fp({}), requestedProductIds: [P1], acknowledgedRunId: 'runProd1' });
  check('7a confirming the exact conflicting run allows the duplicate through', d.blocked === false, JSON.stringify(d));
}
{
  // Acknowledging the WRONG run (not the actual conflict) must not help.
  const d = generationGateDecision({ activeRuns: activeProductRun, fingerprint: fp({}), requestedProductIds: [P1], acknowledgedRunId: 'someOtherRunId' });
  check('7b confirming a run that is NOT the conflict still blocks, and still names the real conflict',
    d.blocked === true && d.acknowledgeRunId === 'runProd1', JSON.stringify(d));
}
{
  // acknowledgedRunId is compared as a string — a numeric-looking id must
  // still match textually; type differences must not silently defeat it.
  const numericRun = [{ runId: '12345', createdAt: new Date(), requestFingerprint: fp({}) }];
  const d = generationGateDecision({ activeRuns: numericRun, fingerprint: fp({}), requestedProductIds: [P1], acknowledgedRunId: 12345 });
  check('7c acknowledgedRunId compares by string value even when the caller passes a number', d.blocked === false, JSON.stringify(d));
}

// ── 8. THE OVERRIDE MUST NOT BECOME A HOLE — a stray SECOND confirm carrying
//       the SAME stale acknowledgedRunId must be refused again, against the
//       run its own first confirm just minted — not silently allowed.
//       Without this, confirming once would permanently disarm the gate for
//       that fingerprint, and every later double-click on "Generate anyway"
//       would sail through and double-bill. Tested hard, several ways.
// ─────────────────────────────────────────────────────────────────────────
{
  // The first confirm mints run runProd2 (identical fingerprint). A second,
  // stray confirm still carrying the OLD acknowledgedRunId ('runProd1') must
  // be blocked again — and must hand back runProd2, the run it now collides
  // with, not the run that was already excused.
  const twoRuns = [...activeProductRun,
    { runId: 'runProd2', createdAt: new Date('2026-08-10T10:00:05Z'), requestedProductIds: [P1], requestFingerprint: fp({}) }];
  const d = generationGateDecision({ activeRuns: twoRuns, fingerprint: fp({}), requestedProductIds: [P1], acknowledgedRunId: 'runProd1' });
  check('8a stray second confirm (stale ack) is BLOCKED again', d.blocked === true && d.reason === 'duplicate-in-flight', JSON.stringify(d));
  check('8b stray second confirm is pointed at the NEW run, not the already-excused one', d.acknowledgeRunId === 'runProd2', d.acknowledgeRunId);
}
{
  // Three racers: runProd1 already confirmed; runProd2 and runProd3 both
  // minted identical requests afterward. A stale ack of runProd1 must still
  // block, and must name the EARLIEST still-unacknowledged run (runProd2),
  // not runProd3 and not the already-excused runProd1.
  const threeRuns = [
    { runId: 'runProd1', createdAt: new Date('2026-08-10T10:00:00Z'), requestFingerprint: fp({}) },
    { runId: 'runProd2', createdAt: new Date('2026-08-10T10:00:05Z'), requestFingerprint: fp({}) },
    { runId: 'runProd3', createdAt: new Date('2026-08-10T10:00:10Z'), requestFingerprint: fp({}) }
  ];
  const d = generationGateDecision({ activeRuns: threeRuns, fingerprint: fp({}), requestedProductIds: [P1], acknowledgedRunId: 'runProd1' });
  check('8c three racers, stale ack of the first: still blocked', d.blocked === true, JSON.stringify(d));
  check('8d three racers, stale ack of the first: hands back the EARLIEST unacknowledged run', d.acknowledgeRunId === 'runProd2', d.acknowledgeRunId);
}
{
  // Acknowledging the MIDDLE run of three must not somehow clear the other two.
  const threeRuns = [
    { runId: 'runProd1', createdAt: new Date('2026-08-10T10:00:00Z'), requestFingerprint: fp({}) },
    { runId: 'runProd2', createdAt: new Date('2026-08-10T10:00:05Z'), requestFingerprint: fp({}) },
    { runId: 'runProd3', createdAt: new Date('2026-08-10T10:00:10Z'), requestFingerprint: fp({}) }
  ];
  const d = generationGateDecision({ activeRuns: threeRuns, fingerprint: fp({}), requestedProductIds: [P1], acknowledgedRunId: 'runProd2' });
  check('8e acknowledging the MIDDLE of three identical runs still blocks (the other two remain unacknowledged)', d.blocked === true);
  check('8f ...and names the earliest of the REMAINING unacknowledged runs', d.acknowledgeRunId === 'runProd1', d.acknowledgeRunId);
}
{
  // Acking a run that is no longer active (e.g. it already finished and
  // rolled off activeRuns) with nothing else in flight must allow through
  // cleanly — there is genuinely nothing left unacknowledged.
  const d = generationGateDecision({ activeRuns: [], fingerprint: fp({}), requestedProductIds: [P1], acknowledgedRunId: 'longGoneRunId' });
  check('8g acking a run that is no longer active, with nothing else in flight, allows through', d.blocked === false, JSON.stringify(d));
}

// ── 9. DUPLICATE-OF-PREVIOUS — identical to a run that already FINISHED.
//       Noted once (not a hard refusal-forever), confirmable, allowed once
//       acknowledged. A finished run with a DIFFERENT fingerprint must not be
//       reported at all — "previous" only means anything when it really is
//       the same request.
// ─────────────────────────────────────────────────────────────────────────
const priorDone = { runId: 'runPrior1', createdAt: new Date('2026-08-09T10:00:00Z'), status: 'done', requestFingerprint: fp({}) };
{
  const d = generationGateDecision({ activeRuns: [], priorRun: priorDone, fingerprint: fp({}), requestedProductIds: [P1] });
  check('9a identical prior finished run is reported', d.blocked === true && d.reason === 'duplicate-of-previous', JSON.stringify(d));
  check('9b reported as confirmable, naming the prior run', d.confirmable === true && d.acknowledgeRunId === 'runPrior1');
}
{
  const d = generationGateDecision({ activeRuns: [], priorRun: priorDone, fingerprint: fp({}), requestedProductIds: [P1], acknowledgedRunId: 'runPrior1' });
  check('9c allowed through once the prior run is acknowledged', d.blocked === false, JSON.stringify(d));
}
{
  const priorFailed = { ...priorDone, runId: 'runPrior2', status: 'failed' };
  const d = generationGateDecision({ activeRuns: [], priorRun: priorFailed, fingerprint: fp({}), requestedProductIds: [P1] });
  check('9d a FAILED prior run with an identical fingerprint is reported too — identity is the criterion, not status',
    d.blocked === true && d.reason === 'duplicate-of-previous');
}
{
  const differentPrior = { ...priorDone, requestFingerprint: fp({ preset: 'meta_all' }) };
  const d = generationGateDecision({ activeRuns: [], priorRun: differentPrior, fingerprint: fp({}), requestedProductIds: [P1] });
  check('9e a finished run with a DIFFERENT fingerprint is not reported at all', d.blocked === false && d.reason === undefined, JSON.stringify(d));
}
check('9f no prior run at all → nothing to report',
  generationGateDecision({ activeRuns: [], priorRun: null, fingerprint: fp({}), requestedProductIds: [P1] }).blocked === false);
{
  // Rollout compat applies to priorRun too: an old, fingerprint-less finished
  // run is compared by product set — identical set is reported...
  const legacyPriorIdentical = { runId: 'runLegacyPrior1', createdAt: new Date('2026-08-01'), status: 'done', requestedProductIds: [P1] };
  let d = generationGateDecision({ activeRuns: [], priorRun: legacyPriorIdentical, fingerprint: fp({}), requestedProductIds: [P1] });
  check('9g legacy fingerprint-less prior run with an IDENTICAL product set is reported',
    d.blocked === true && d.reason === 'duplicate-of-previous');
  // ...but a merely overlapping (not identical) product set is not.
  const legacyPriorOverlap = { runId: 'runLegacyPrior2', createdAt: new Date('2026-08-01'), status: 'done', requestedProductIds: [P1, P2] };
  d = generationGateDecision({ activeRuns: [], priorRun: legacyPriorOverlap, fingerprint: fp({}), requestedProductIds: [P1] });
  check('9h legacy fingerprint-less prior run with only an OVERLAPPING product set is NOT reported', d.blocked === false);
}

// ── 10. renderClaimFingerprint — a /api/ads/runs render claim must never
//        block, or be blocked as, a generate. It mints no ads and bills no
//        expansion, so it can never be "the same request" as anything.
// ─────────────────────────────────────────────────────────────────────────
check('10a renderClaimFingerprint has the expected namespaced shape', renderClaimFingerprint('rc1') === 'claim:rc1');
check('10b renderClaimFingerprint is unique per runId — two different runs never collide',
  renderClaimFingerprint('rc1') !== renderClaimFingerprint('rc2'));
check('10c a claim fingerprint can never equal a real sha256 request fingerprint (different alphabet/shape)',
  renderClaimFingerprint('rc1') !== fp({}) && !/^[0-9a-f]{64}$/.test(renderClaimFingerprint('rc1')));
{
  const claimRun = [{ runId: 'rc1', createdAt: new Date('2026-08-10T10:00:00Z'),
    requestedProductIds: [P1], requestFingerprint: renderClaimFingerprint('rc1') }];
  const d = generationGateDecision({ activeRuns: claimRun, fingerprint: fp({}), requestedProductIds: [P1] });
  check('10d an active render claim never blocks a generate, even over the identical product set', d.blocked === false, JSON.stringify(d));
}
{
  // A FINISHED render claim must not surface as duplicate-of-previous either.
  const claimPrior = { runId: 'rc2', createdAt: new Date('2026-08-09'), status: 'done', requestFingerprint: renderClaimFingerprint('rc2') };
  const d = generationGateDecision({ activeRuns: [], priorRun: claimPrior, fingerprint: fp({}), requestedProductIds: [P1] });
  check('10e a finished render claim is not reported as duplicate-of-previous', d.blocked === false, JSON.stringify(d));
}
{
  // And a render claim can never supersede a generate in the mint-then-verify race either.
  const self = { runId: 'genRun1', createdAt: new Date('2026-08-10T10:00:05Z') };
  const claimRun = [{ runId: 'rc3', createdAt: new Date('2026-08-10T10:00:00Z'), requestFingerprint: renderClaimFingerprint('rc3') }];
  const winner = pickSupersedingRun({ selfRun: self, activeRuns: claimRun, fingerprint: fp({}), requestedProductIds: [P1] });
  check('10f a render claim never supersedes a generate in the mint-then-verify race', winner === null);
}

// ── 11. ROLLOUT COMPAT — a fingerprint-less run (minted before this change,
//        or before a rolling deploy finishes) falls back to comparing
//        PRODUCT SETS, and blocks ONLY on an IDENTICAL set — never mere
//        overlap (that IS the bug being fixed) and never a media-only
//        request (empty sets never compare equal to anything, by design).
// ─────────────────────────────────────────────────────────────────────────
const legacyRun = [{ runId: 'runLegacy1', createdAt: new Date('2026-08-10T10:00:00Z'), requestedProductIds: [P1] }];
check('11a legacy run with an IDENTICAL product set blocks',
  generationGateDecision({ activeRuns: legacyRun, fingerprint: fp({}), requestedProductIds: [P1] }).blocked === true);
check('11b legacy run with a merely OVERLAPPING (not identical) product set does NOT block',
  generationGateDecision({ activeRuns: legacyRun, fingerprint: fp({ productIds: [P1, P2] }), requestedProductIds: [P1, P2] }).blocked === false);
check('11c legacy run never blocks a media-only request',
  generationGateDecision({ activeRuns: legacyRun, fingerprint: mediaFp, requestedProductIds: [] }).blocked === false);
{
  const legacyMediaRun = [{ runId: 'runLegacyMedia', createdAt: new Date(), requestedProductIds: [] }];
  const d = generationGateDecision({ activeRuns: legacyMediaRun, fingerprint: fp({}), requestedProductIds: [P1] });
  check('11d a legacy run that ITSELF has an empty product set never blocks a product request either', d.blocked === false, JSON.stringify(d));
}
{
  // Mixed: a legacy identical run AND a legacy overlapping run in the same
  // activeRuns array — only the identical one may cause a block.
  const mixed = [
    { runId: 'runLegacyOverlap', createdAt: new Date(), requestedProductIds: [P1, P2] },
    { runId: 'runLegacyIdentical', createdAt: new Date(), requestedProductIds: [P1] }
  ];
  const d = generationGateDecision({ activeRuns: mixed, fingerprint: fp({}), requestedProductIds: [P1] });
  check('11e mixed legacy runs: blocked, and names the IDENTICAL one, not the merely-overlapping one',
    d.blocked === true && d.acknowledgeRunId === 'runLegacyIdentical', JSON.stringify(d));
}

// ── 12. pickSupersedingRun — MINT-THEN-VERIFY. Closes the read-then-write
//        race: two clicks can both read activeRuns before either has
//        inserted its own CampaignRun, both see nothing in flight, and both
//        would proceed. After each mints its own run it re-reads and asks
//        "did an earlier run already make this exact request?" — both
//        racers compute the SAME winner via (createdAt, runId), so exactly
//        one aborts, and it aborts BEFORE expanding, so a false abort costs a
//        409 and nothing else.
// ─────────────────────────────────────────────────────────────────────────
{
  const self = { runId: 'rB', createdAt: new Date('2026-08-10T10:00:05Z') };
  const earlierSame = { runId: 'rA', createdAt: new Date('2026-08-10T10:00:00Z'), requestFingerprint: fp({}) };
  check('12a an earlier identical in-flight run supersedes us',
    pickSupersedingRun({ selfRun: self, activeRuns: [earlierSame, self], fingerprint: fp({}), requestedProductIds: [P1] })?.runId === 'rA');
  check('12b an earlier DIFFERENT request does not supersede us',
    pickSupersedingRun({ selfRun: self, activeRuns: [{ ...earlierSame, requestFingerprint: fp({ preset: 'meta_all' }) }],
      fingerprint: fp({}), requestedProductIds: [P1] }) === null);
  check('12c a run never supersedes itself',
    pickSupersedingRun({ selfRun: self, activeRuns: [{ ...self, requestFingerprint: fp({}) }], fingerprint: fp({}), requestedProductIds: [P1] }) === null);
  check('12d an acknowledged run does not supersede the confirmed duplicate',
    pickSupersedingRun({ selfRun: self, activeRuns: [earlierSame], fingerprint: fp({}), requestedProductIds: [P1], acknowledgedRunId: 'rA' }) === null);
  check('12e a DIFFERENT earlier identical run still supersedes, even with an unrelated ack in play',
    pickSupersedingRun({
      selfRun: self,
      activeRuns: [earlierSame, { runId: 'rX', createdAt: new Date('2026-08-10T10:00:01Z'), requestFingerprint: fp({}) }],
      fingerprint: fp({}), requestedProductIds: [P1], acknowledgedRunId: 'rA'
    })?.runId === 'rX');
}
{
  // Same-millisecond tie: must STILL break deterministically on runId, or a
  // same-millisecond double-click has both sides continue and bills twice.
  const tieA = { runId: 'run_1_aaa', createdAt: new Date(5000), requestFingerprint: fp({}) };
  const tieB = { runId: 'run_1_bbb', createdAt: new Date(5000), requestFingerprint: fp({}) };
  const vA = pickSupersedingRun({ selfRun: tieA, activeRuns: [tieA, tieB], fingerprint: fp({}), requestedProductIds: [P1] });
  const vB = pickSupersedingRun({ selfRun: tieB, activeRuns: [tieA, tieB], fingerprint: fp({}), requestedProductIds: [P1] });
  check('12f same-millisecond tie: exactly one of the two racers aborts',
    (vA ? 1 : 0) + (vB ? 1 : 0) === 1, `vA=${JSON.stringify(vA)} vB=${JSON.stringify(vB)}`);
  check('12g same-millisecond tie breaks on runId (lexicographically lower survives)',
    vA === null && !!vB && vB.runId === tieA.runId);
}
{
  // Disjoint racers (different fingerprints) must BOTH proceed — the whole
  // point of the rewrite.
  const dj1 = { runId: 'run_1', createdAt: new Date(1000), requestFingerprint: fp({}) };
  const dj2 = { runId: 'run_2', createdAt: new Date(2000), requestFingerprint: fp({ preset: 'meta_all' }) };
  check('12h disjoint (different-fingerprint) racers: earlier proceeds',
    pickSupersedingRun({ selfRun: dj1, activeRuns: [dj1, dj2], fingerprint: fp({}), requestedProductIds: [P1] }) === null);
  check('12i disjoint racers: later ALSO proceeds',
    pickSupersedingRun({ selfRun: dj2, activeRuns: [dj1, dj2], fingerprint: fp({ preset: 'meta_all' }), requestedProductIds: [P1] }) === null);
}
{
  // Our own re-read row can carry a slightly different createdAt than what we
  // passed in (clock/serialization skew). The runId identity check is what
  // saves us — without it, any negative skew makes every request supersede
  // itself, 409 on its own run, and NOTHING ever generates: a total outage
  // that looks exactly like a working guard.
  const early = { runId: 'run_100_aaa', createdAt: new Date(1000) };
  check('12j own row with a skewed EARLIER createdAt still does not supersede self',
    pickSupersedingRun({
      selfRun: { runId: early.runId, createdAt: new Date(1000) },
      activeRuns: [{ runId: early.runId, createdAt: new Date(999), requestFingerprint: fp({}) }],
      fingerprint: fp({}), requestedProductIds: [P1]
    }) === null);
}
{
  // Rollout compat inside the race too: a legacy (fingerprint-less) earlier
  // run supersedes ONLY on an identical product set — the fail-OPEN flip of
  // the old fail-CLOSED behaviour (an unscoped run used to always win by
  // default; now it wins only if it is PROVABLY the same request).
  const self = { runId: 'rB', createdAt: new Date('2026-08-10T10:00:05Z') };
  const legacyIdentical = { runId: 'legacyA', createdAt: new Date('2026-08-10T10:00:00Z'), requestedProductIds: [P1] };
  check('12k a legacy earlier run with an IDENTICAL product set supersedes (rollout compat)',
    pickSupersedingRun({ selfRun: self, activeRuns: [legacyIdentical], requestedProductIds: [P1] })?.runId === 'legacyA');
  const legacyOverlap = { runId: 'legacyB', createdAt: new Date('2026-08-10T10:00:00Z'), requestedProductIds: [P1, P2] };
  check('12l a legacy earlier run with only an OVERLAPPING product set does NOT supersede — this is the fix',
    pickSupersedingRun({ selfRun: self, activeRuns: [legacyOverlap], requestedProductIds: [P1] }) === null);
}
check('12m no active runs → nothing supersedes',
  pickSupersedingRun({ selfRun: { runId: 'x', createdAt: new Date() }, activeRuns: [], fingerprint: fp({}), requestedProductIds: [P1] }) === null);
check('12n missing selfRun → null, never abort on a malformed call',
  pickSupersedingRun({ activeRuns: [{ runId: 'a', createdAt: new Date(), requestFingerprint: fp({}) }], fingerprint: fp({}), requestedProductIds: [P1] }) === null);

// ── 13. DEFENSIVE INPUT HANDLING — malformed/missing arguments across every
//        export must degrade safely (never throw, never crash the request
//        handler) and must resolve toward "allow" only when identity is
//        genuinely unprovable, per the module's fail-open design.
// ─────────────────────────────────────────────────────────────────────────
check('13a generationGateDecision() with no args at all does not throw, and allows',
  generationGateDecision().blocked === false);
check('13b generationGateDecision({}) allows', generationGateDecision({}).blocked === false);
check('13c non-array activeRuns is tolerated, not thrown',
  generationGateDecision({ activeRuns: 'nope', fingerprint: fp({}), requestedProductIds: [P1] }).blocked === false);
{
  const d = generationGateDecision({
    activeRuns: [null, undefined, { runId: 'real', createdAt: new Date(), requestFingerprint: fp({}) }],
    fingerprint: fp({}), requestedProductIds: [P1]
  });
  check('13d null/undefined entries inside activeRuns are filtered, not thrown',
    d.blocked === true && d.acknowledgeRunId === 'real', JSON.stringify(d));
}
{
  const d = generationGateDecision({ activeRuns: [{ requestFingerprint: fp({}) }], fingerprint: fp({}), requestedProductIds: [P1] });
  check('13e an active run missing BOTH runId and createdAt does not throw, and still blocks on identity',
    d.blocked === true && d.conflictRunId === null && d.acknowledgeRunId === null, JSON.stringify(d));
}
check('13f empty requestedProductIds with no fingerprint at all does not throw',
  (() => { generationGateDecision({ activeRuns: [], requestedProductIds: [] }); return true; })());
check('13g pickSupersedingRun with a missing selfRun returns null, no throw',
  pickSupersedingRun({ activeRuns: [{ runId: 'a', createdAt: new Date() }], requestedProductIds: [P1] }) === null);
check('13h pickSupersedingRun with non-array activeRuns is tolerated',
  pickSupersedingRun({ selfRun: { runId: 'x', createdAt: new Date() }, activeRuns: 'nope', requestedProductIds: [P1] }) === null);
check('13i pickSupersedingRun with null/undefined entries inside activeRuns is tolerated',
  pickSupersedingRun({ selfRun: { runId: 'x', createdAt: new Date() }, activeRuns: [null, undefined], requestedProductIds: [P1] }) === null);
check('13j pickSupersedingRun() with no args at all returns null', pickSupersedingRun() === null);
check('13k buildOverlapNotice() with no args returns null', buildOverlapNotice() === null);
{
  const n = buildOverlapNotice({ activeRuns: [null, { runId: 'r', requestedProductIds: [P1] }], requestedProductIds: [P1] });
  check('13l buildOverlapNotice with null entries inside activeRuns is tolerated', !!n && n.runId === 'r', JSON.stringify(n));
}
check('13m normalizeProductIdList(undefined) → []', normalizeProductIdList(undefined).length === 0);
check('13n normalizeProductIdList(null) → []', normalizeProductIdList(null).length === 0);
check('13o computeRequestFingerprint(undefined) does not throw and returns a valid hash',
  /^[0-9a-f]{64}$/.test(computeRequestFingerprint(undefined)));
check('13p computeRequestFingerprint(null) does not throw and returns a valid hash',
  /^[0-9a-f]{64}$/.test(computeRequestFingerprint(null)));
check('13q computeRequestFingerprint({}) === computeRequestFingerprint() — both mean "nothing"',
  computeRequestFingerprint({}) === computeRequestFingerprint());
check('13r isSameRequest(null, ...) is false, not a throw', isSameRequest(null, fp({}), [P1]) === false);
check('13s isSameRequest(undefined, ...) is false, not a throw', isSameRequest(undefined, fp({}), [P1]) === false);
check('13t sameProductSet(undefined, undefined) is false — unknown scope on both sides proves nothing',
  sameProductSet(undefined, undefined) === false);
check('13u compareRunOrder(undefined, undefined) does not throw and is stably 0', compareRunOrder(undefined, undefined) === 0);
check('13v compareRunOrder(null, null) does not throw', (() => { compareRunOrder(null, null); return true; })());
check('13w a run whose createdAt is an unparsable string does not throw',
  (() => { generationGateDecision({ activeRuns: [{ runId: 'bad', createdAt: 'not-a-date', requestFingerprint: fp({}) }], fingerprint: fp({}), requestedProductIds: [P1] }); return true; })());

// ── 14. SOURCE PINS — wiring facts a pure unit test of the module cannot
//        see. The gate is only as good as the route actually asking it the
//        right question with the right data; these pins catch the class of
//        bug where the pure logic above is correct but the call site drifts.
// ─────────────────────────────────────────────────────────────────────────
const adsSrc = fs.readFileSync(path.join(__dirname, '..', 'routes/ads.js'), 'utf8');
const runModelSrc = fs.readFileSync(path.join(__dirname, '..', 'models/CampaignRun.js'), 'utf8');
const hasKey = (block, key) => new RegExp(`\\b${key}\\b`).test(block);

// Stricter than hasKey: the name must appear as an actual OBJECT KEY at the
// start of a line (shorthand `foo,` or explicit `foo: bar`), not merely as a word
// somewhere in the block. Required for any INVERSE assertion ("this key must not
// be forwarded") — the source comments explain why a field is excluded and
// therefore mention its name, so a bare \bword\b test reads the explanation as
// the thing it forbids and fails against correct code.
const hasObjectKey = (block, key) => new RegExp(`^\\s*${key}\\s*[:,]`, 'm').test(block);

// 14.1 — the route imports the gate's real exports.
{
  const importIdx = adsSrc.indexOf("require('../services/generationGate')");
  check('14.1a route imports services/generationGate', importIdx > 0);
  const importBlockStart = importIdx > 0 ? adsSrc.lastIndexOf('const {', importIdx) : -1;
  const importBlock = importIdx > 0 ? adsSrc.slice(importBlockStart, importIdx) : '';
  for (const symbol of ['generationGateDecision', 'normalizeProductIdList', 'pickSupersedingRun',
    'computeRequestFingerprint', 'renderClaimFingerprint']) {
    check(`14.1b import destructures '${symbol}'`, hasKey(importBlock, symbol));
  }
}

// 14.2 — /generate computes the fingerprint and threads it into the gate,
// forwarding every field the pure function actually reads.
check('14.2a route computes the request fingerprint via computeRequestFingerprint',
  /const requestFingerprint = computeRequestFingerprint\(\{/.test(adsSrc));
check('14.2b that fingerprint is passed into generationGateDecision',
  /generationGateDecision\(\{[\s\S]{0,200}fingerprint:\s*requestFingerprint/.test(adsSrc));
{
  const fpCallIdx = adsSrc.indexOf('const requestFingerprint = computeRequestFingerprint({');
  const fpCallEnd = fpCallIdx > 0 ? adsSrc.indexOf('});', fpCallIdx) : -1;
  const fpCallBlock = fpCallIdx > 0 ? adsSrc.slice(fpCallIdx, fpCallEnd) : '';
  const forwardedPlain = ['campaignId', 'productIds', 'mediaIds', 'templateIds', 'preset',
    'platformFormat', 'kinds', 'expandStaticFormats', 'includeCategoryMatched',
    'includeBrandMatched', 'excludePairings', 'cta', 'urlParams',
    // Multi-select surfaces — read by the handler and forwarded into
    // expandWizardJob, so they must be hashed too.
    'staticFormats', 'videoFormats'];
  for (const key of forwardedPlain) {
    check(`14.2c route's fingerprint call forwards '${key}'`, hasObjectKey(fpCallBlock, key));
  }
  // And the inverse pin: `refresh` must NOT be forwarded. It is destructured at
  // the top of the handler but never reaches expandWizardJob on either path, so
  // it cannot change the output — hashing it would make two requests that
  // produce identical creative hash differently and let a real double-click
  // through as "not a duplicate". Same class as expandVideoFormats.
  // If anyone re-wires refresh so it DOES reach the expansion, this pin fails
  // and forces them to add it to the fingerprint in the same commit.
  check("14.2c-inv route's fingerprint call does NOT forward 'refresh' (dead field — see gate module)",
    !hasObjectKey(fpCallBlock, 'refresh'),
    'refresh never reaches expandWizardJob; hashing a dead field hides real double-clicks');
  check("14.2c-inv2 route's fingerprint call does NOT forward 'expandVideoFormats' (never destructured)",
    !hasObjectKey(fpCallBlock, 'expandVideoFormats'),
    'the wizard sends it but routes/ads.js never reads it; hashing it would hide real double-clicks');
  check("14.2c-inv3 route's fingerprint call does NOT forward per-run values",
    !hasObjectKey(fpCallBlock, 'generationRunId') && !hasObjectKey(fpCallBlock, 'requestedBy'),
    'generationRunId is unique per run (would make the gate a no-op); requestedBy is omitted so ' +
    'the gate catches cross-user duplicates too');
  check("14.2d route's fingerprint call uses the PARSED video duration, not the raw body value",
    /videoDurationSec:\s*parsedVideoDurationSec/.test(fpCallBlock));

  // The false-allow fix, pinned at the route. Behavioural proof is section 1b;
  // these assert the route really routes through it, since 1b models the route
  // rather than calling it.
  check('14.2f route resolves the multi-select lists BEFORE fingerprinting',
    /resolveExplicitFormats\(\{\s*staticFormats,\s*videoFormats\s*\}\)/.test(adsSrc),
    'the gate must hash the resolved billable set, not the raw body arrays');
  check("14.2g route's fingerprint call hashes the RESOLVED lists, not the raw ones",
    /staticFormats:\s*resolvedExplicit\.staticFormats/.test(fpCallBlock) &&
    /videoFormats:\s*resolvedExplicit\.videoFormats/.test(fpCallBlock));
  check("14.2h route ZEROES the fields 'explicit' ignores before hashing",
    /kinds:\s*isExplicitPreset \? null\s*:\s*kinds/.test(fpCallBlock) &&
    /expandStaticFormats:\s*isExplicitPreset \? false\s*:\s*expandStaticFormats/.test(fpCallBlock),
    "hashing kinds/expandStaticFormats under explicit — which the resolver ignores — hides real double-clicks");
  check('14.2i route forwards the SAME resolved lists to expandWizardJob (hash and generation cannot drift)',
    /staticFormats:\s*isExplicitPreset \? resolvedExplicit\.staticFormats\s*:\s*staticFormats/.test(adsSrc) &&
    /videoFormats:\s*isExplicitPreset \? resolvedExplicit\.videoFormats\s*:\s*videoFormats/.test(adsSrc));
  check('14.2j route REFUSES an explicit selection that resolves to nothing (no phantom done run)',
    /NO_GENERATABLE_FORMAT/.test(adsSrc) &&
    /isExplicitPreset[\s\S]{0,200}!resolvedExplicit\.staticFormats\.length[\s\S]{0,80}!resolvedExplicit\.videoFormats\.length/.test(adsSrc),
    'otherwise it 202s, expands to zero and settles as terminal `done` — a successful-looking no-op run');
  check('14.2e route forwards all five phase3 (video/director) fields into the fingerprint',
    /directorVariants:\s*phase3\.fields\.directorVariants/.test(fpCallBlock) &&
    /seedPicks:\s*phase3\.fields\.seedPicks/.test(fpCallBlock) &&
    /seedMediaIds:\s*phase3\.fields\.seedMediaIds/.test(fpCallBlock) &&
    /videoPromptGuidance:\s*phase3\.fields\.videoPromptGuidance/.test(fpCallBlock) &&
    /videoPromptRaw:\s*phase3\.fields\.videoPromptRaw/.test(fpCallBlock));
}

// 14.3 — BOTH activeRuns queries select requestFingerprint (pre-check, and
// the mint-then-verify re-read). Missing it on either one silently disables
// duplicate detection for exactly that path.
{
  const selectLiteral = ".select('runId status createdAt requestedProductIds requestFingerprint').lean()";
  const occurrences = adsSrc.split(selectLiteral).length - 1;
  check('14.3a both activeRuns queries select requestFingerprint', occurrences >= 2, `found ${occurrences} occurrence(s)`);

  const gateCallIdx = adsSrc.indexOf('const gate = generationGateDecision({');
  const preCheckSelectIdx = adsSrc.indexOf(selectLiteral);
  check('14.3b the pre-check query (with that select) precedes the gate decision',
    preCheckSelectIdx > 0 && gateCallIdx > preCheckSelectIdx, `select@${preCheckSelectIdx} gate@${gateCallIdx}`);

  const supersedingCallIdx = adsSrc.indexOf('const superseding = pickSupersedingRun({');
  const supersedingEnd = supersedingCallIdx > 0 ? adsSrc.indexOf('});', supersedingCallIdx) : -1;
  const secondSelectIdx = supersedingCallIdx > 0 ? adsSrc.indexOf(selectLiteral, supersedingCallIdx) : -1;
  check('14.3c the mint-then-verify re-read (with that select) is inside the pickSupersedingRun call',
    supersedingCallIdx > 0 && secondSelectIdx > supersedingCallIdx && secondSelectIdx < supersedingEnd,
    `call@${supersedingCallIdx} select@${secondSelectIdx} end@${supersedingEnd}`);
}

// 14.4 — acknowledgedRunId is threaded into BOTH the gate and
// pickSupersedingRun. Wiring it into only one half re-opens exactly the
// double-confirm hole ── 8 exists to keep shut: the pre-check would honour a
// confirm that the race check then ignores (or vice versa).
check('14.4a acknowledgedRunId is passed into generationGateDecision',
  /generationGateDecision\(\{[\s\S]{0,200}acknowledgedRunId:\s*ackRunId/.test(adsSrc));
check('14.4b acknowledgedRunId is passed into pickSupersedingRun',
  /pickSupersedingRun\(\{[\s\S]{0,600}acknowledgedRunId:\s*ackRunId/.test(adsSrc));

// 14.5 / 14.6 — the TWO CampaignRun.create call sites (/generate then /runs,
// in that file order) stamp the right fingerprint each.
{
  const genCreateIdx = adsSrc.indexOf('const run = await CampaignRun.create({');
  const genCreateEnd = genCreateIdx > 0 ? adsSrc.indexOf('});', genCreateIdx) : -1;
  const genCreateBlock = genCreateIdx > 0 ? adsSrc.slice(genCreateIdx, genCreateEnd) : '';
  check('14.5a /generate CampaignRun.create stamps requestedProductIds via normalizeProductIdList',
    /requestedProductIds:\s*normalizeProductIdList\(productIds\)/.test(genCreateBlock));
  check('14.5b /generate CampaignRun.create stamps requestFingerprint as a bare shorthand var (not a sub-key of something else)',
    /requestFingerprint(?!\s*:)/.test(genCreateBlock));

  const runsCreateIdx = genCreateEnd > 0 ? adsSrc.indexOf('const run = await CampaignRun.create({', genCreateEnd) : -1;
  const runsCreateEnd = runsCreateIdx > 0 ? adsSrc.indexOf('});', runsCreateIdx) : -1;
  const runsCreateBlock = runsCreateIdx > 0 ? adsSrc.slice(runsCreateIdx, runsCreateEnd) : '';
  check('14.6a a second, distinct CampaignRun.create call exists for /runs', runsCreateIdx > 0 && runsCreateIdx > genCreateEnd);
  check('14.6b /runs CampaignRun.create stamps requestedProductIds from claimedProductIds',
    /requestedProductIds:\s*claimedProductIds/.test(runsCreateBlock));
  check('14.6c /runs CampaignRun.create stamps requestFingerprint via renderClaimFingerprint(runId) — never a real request fingerprint',
    /requestFingerprint:\s*renderClaimFingerprint\(runId\)/.test(runsCreateBlock));
}

// 14.7 — /runs derives claimedProductIds from the ads it actually claimed,
// fails closed to [] if any claimed ad lacks a productId, and does the scope
// read before its CampaignRun.create.
check('14.7a /runs derives claimedProductIds from the claimed ads, [] if any lacks a productId',
  /claimedProductIds = claimedAds\.some\(a => !a\.productId\)[\s\S]{0,20}\?\s*\[\][\s\S]{0,30}:\s*normalizeProductIdList\(claimedAds\.map\(a => a\.productId\)\)/.test(adsSrc));
check('14.7b /runs scope read happens before its CampaignRun.create', (() => {
  const scopeIdx = adsSrc.indexOf('let claimedProductIds = []');
  const createIdx = adsSrc.indexOf('requestedProductIds: claimedProductIds');
  return scopeIdx > 0 && createIdx > scopeIdx;
})());

// 14.8 — CampaignRun schema: the new field, its index, and the still-needed
// rollout/gate-shape indexes.
check('14.8a CampaignRun declares requestFingerprint (String, default null, indexed)',
  /requestFingerprint:\s*\{\s*type:\s*String,\s*default:\s*null,\s*index:\s*true\s*\}/.test(runModelSrc));
check('14.8b CampaignRun still declares requestedProductIds as [String]',
  /requestedProductIds:\s*\{\s*type:\s*\[String\]/.test(runModelSrc));
check('14.8c CampaignRun indexes {campaignId, requestFingerprint, createdAt} — the duplicate-lookback query shape',
  /index\(\{\s*campaignId:\s*1,\s*requestFingerprint:\s*1,\s*createdAt:\s*-1\s*\}\)/.test(runModelSrc));
check('14.8d CampaignRun still indexes {campaignId, status, createdAt} — the activeRuns query shape (runs TWICE per generate)',
  /index\(\{\s*campaignId:\s*1,\s*status:\s*1,\s*createdAt:\s*-1\s*\}\)/.test(runModelSrc));

// 14.9 — the superseded loser (mint-then-verify's aborter) is still marked
// failed with a deleteOne fallback, still aborts BEFORE the expansion spends
// anything, and its 409 is explicitly not confirmable. Ported from the
// pre-rewrite harness — ownership of this invariant did not move when the key
// changed from product-overlap to fingerprint.
check('14.9a superseded run aborts BEFORE the expansion (no spend)', (() => {
  const supIdx = adsSrc.indexOf('if (superseding) {');
  const expandIdx = adsSrc.indexOf('generationRunId: run.runId');
  return supIdx > 0 && expandIdx > supIdx;
})());
check('14.9b superseded run is marked failed, not left in preparing (would zombie-lock its products for the stale window)',
  /if \(superseding\)[\s\S]{0,1400}status: 'failed'/.test(adsSrc));
check('14.9c superseded loser deletes its row if the failed-status write itself fails',
  /could not mark superseded run failed[\s\S]{0,300}CampaignRun\.deleteOne/.test(adsSrc));
check('14.9d superseded response uses reason raced-concurrent-run',
  /reason:\s*'raced-concurrent-run'/.test(adsSrc));
check('14.9e superseded response is explicitly NOT confirmable (re-offering the override on a photo-finish race would invite the double-spend it stops)',
  /reason:\s*'raced-concurrent-run'[\s\S]{0,400}confirmable:\s*false/.test(adsSrc));

// 14.10 — the self-status re-check before expandWizardJob still exists and
// still runs before any spend. A run wedged in 'preparing' past
// REAP_STALE_MIN stops holding its products (the gate only looks at runs
// younger than that), so a sibling Generate is allowed; if the wedged run
// later wakes up and expands anyway, both bill.
check('14.10a background expand re-checks its own run status first',
  /select\('status'\)\.lean\(\)[\s\S]{0,400}stillOurs\.status !== 'preparing'/.test(adsSrc));
check("14.10b self-status check precedes /generate's expandWizardJob call", (() => {
  const checkIdx = adsSrc.indexOf("stillOurs.status !== 'preparing'");
  if (checkIdx <= 0) return false;
  const expandAfter = adsSrc.indexOf('const job = await expandWizardJob(', checkIdx);
  const generationRunIdIdx = adsSrc.indexOf('generationRunId: run.runId', checkIdx);
  return expandAfter > checkIdx && generationRunIdIdx > checkIdx;
})());

// 14.11 — the blocked-gate 409 actually echoes confirmable/acknowledgeRunId
// back to the client, and the override requires BOTH confirmDuplicate and
// acknowledgedRunId — without this, sections 7/8's override path is
// unreachable from the real API no matter how correct the pure functions are.
check('14.11a the blocked-gate 409 echoes confirmable/acknowledgeRunId back to the client',
  /confirmable:\s*gate\.confirmable === true/.test(adsSrc) &&
  /acknowledgeRunId:\s*gate\.acknowledgeRunId \|\| null/.test(adsSrc));
check('14.11b the client-supplied override requires BOTH confirmDuplicate and acknowledgedRunId',
  /confirmDuplicate && acknowledgedRunId \? String\(acknowledgedRunId\) : null/.test(adsSrc));

// ── report ──────────────────────────────────────────────────────────
const total = pass + failures.length;
if (failures.length) {
  console.error(`\nverifyGenerationGate: ${failures.length} FAIL(s), ${pass} pass\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`verifyGenerationGate: ${pass}/${total} checks passed`);
process.exit(0);
