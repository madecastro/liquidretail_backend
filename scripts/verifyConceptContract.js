#!/usr/bin/env node
'use strict';
//
// verifyConceptContract — pins Director producer and expansion consumer to
// the SAME dual-read contract for nested v3 / flat v2 concepts.
//
// WHY THIS EXISTS (2026-08-02 production outage):
//   Director schema v3 nests media_picks under concept.routing. The
//   producer's validator dual-read both shapes (warnings=0). The expansion
//   consumer only read concept.media_picks (flat). Every concept was
//   discarded after a paid ~61s Director round:
//     ⛔ concept …: no media_picks — skipping
//     📦 conceptDriven: … concepts=3 payloads=0
//
// This harness is pure + offline: no DB, no network, no API key.
//   node scripts/verifyConceptContract.js
//
// Revert-prove (the exact production bug):
//   In campaignAdsGenerationService concept mapping, replace
//     const mp = conceptMediaPicks(concept);
//   with
//     const mp = Array.isArray(concept.media_picks) ? concept.media_picks : [];
//   AND make conceptMediaPicks temporarily flat-only (or skip the source
//   check). The "C1 v3 nested media_picks resolves" / source-check
//   "consumer uses conceptMediaPicks" assertions fail. Restoring the
//   dual-read makes them pass. Report the failing output verbatim when
//   proving.
//
// Covered:
//   C*  conceptField / conceptMediaPicks dual-read (v3 / v2 / neither)
//       + non-array nested fallthrough to flat (the pure-refactor trap)
//   R*  every ROUTING_NESTED_FIELDS entry dual-reads
//       + falsy nested ('' / 0 / false) wins under != null (not ||)
//   P*  conceptForRender projects both shapes
//   J*  compressConceptForJudge dual-reads (Judge was also flat-only)
//       + media_utilization N/A when universe size ≤ 1
//   U*  feed output_shape menu narrows when universe size < 2
//   S*  source contract: consumer + default TOP_N + alert + reasons
//   K*  skip reason distinguishes no_concepts vs concepts_no_usable_media
//   E*  exhaustive scan: services/ + routes/ must not flat-read
//       ROUTING_NESTED_FIELDS off concept-shaped objects without the helper
//
// Revert-prove non-array fallthrough (item 1):
//   Temporarily restore the pure-refactor body:
//     function conceptMediaPicks(concept) {
//       const mp = conceptField(concept, 'media_picks');
//       return Array.isArray(mp) ? mp : [];
//     }
//   Then "C7 non-array nested falls through to flat" fails. Restoring
//   Array.isArray order makes it pass. Report failing output when proving.

const fs   = require('fs');
const path = require('path');

const projection = require('../services/conceptProjection');
const {
  conceptField,
  conceptMediaPicks,
  conceptForRender,
  ROUTING_NESTED_FIELDS
} = projection;
const {
  compressConceptForJudge,
  buildConceptRoundPrompt,
  CONCEPT_AXES
} = require('../services/aiJudgeService');
const {
  feedOutputShapesForUniverse,
  FEED_OUTPUT_SHAPES,
  MULTI_PICK_FEED_SHAPES,
  buildResponseSchemaRound,
  buildPromptRound
} = require('../services/aiCreativeDirectorService');
const {
  REASON,
  HUMAN_FULL,
  normalizePerProductEntry,
  summarizeEmptyExpansion
} = require('../services/perProductReasons');

let pass = 0;
const failures = [];

function check(label, actual, expected) {
  const ok = Object.is(actual, expected) ||
    (actual && expected && typeof actual === 'object' &&
      JSON.stringify(actual) === JSON.stringify(expected));
  // Prefer strict equality for primitives; deep-equal for objects above
  // is only used when both are objects. Simpler: for non-objects use ===.
  const isObj = actual !== null && typeof actual === 'object';
  const match = isObj
    ? JSON.stringify(actual) === JSON.stringify(expected)
    : actual === expected;
  if (match) { pass++; return; }
  failures.push(
    `${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`
  );
}

function checkTrue(label, cond) {
  if (cond) { pass++; return; }
  failures.push(`${label}\n      expected: truthy\n      actual:   ${cond}`);
}

// ── fixtures ─────────────────────────────────────────────────────────

const V3_NESTED = {
  concept_id: 'allday_travel_comfort',
  name: 'All-day travel comfort',
  routing: {
    archetype: 'hero_quote_overlay',
    layout_family: 'overlay',
    emotional_hook: 'all-day comfort',
    social_proof_type: 'rating',
    product_priority: 'high',
    ugc_priority: 'low',
    comment_priority: 'low',
    stat_priority: 'medium',
    cta_emphasis: 'medium',
    creative_style: 'editorial',
    recommended_components: { headline: true },
    media_picks: [
      { media_id: 'media_hero_1', role: 'hero', notes: null }
    ],
    output_shape: { format: 'static_single', tile_count: 1 },
    // 0 deliberately — proves the falsy-nested-still-wins rule (R comment
    // above: "+ falsy nested ('' / 0 / false) wins under != null") extends to
    // this field too. A real proof_pick of 0 (the FIRST menu option) must
    // never be treated as absent.
    proof_pick: 0
  },
  copy: {
    headline: 'WALK ALL DAY',
    subheadline: 'Tree Runner NZ',
    eyebrow: null,
    cta: 'SHOP NOW'
  },
  art_direction: null,
  reasoning: { rationale: 'private — must not leak' }
};

const V2_FLAT = {
  concept_id: 'flat_legacy',
  name: 'Flat legacy concept',
  archetype: 'full_bleed_hero_bottom_panel',
  layout_family: 'bottom_panel',
  emotional_hook: 'speed',
  social_proof_type: 'none',
  product_priority: 'high',
  ugc_priority: 'low',
  comment_priority: 'low',
  stat_priority: 'low',
  cta_emphasis: 'high',
  creative_style: 'bold_direct',
  recommended_components: { cta: true },
  media_picks: [
    { media_id: 'media_flat_9', role: 'hero', notes: 'legacy' }
  ],
  output_shape: { format: 'static_single', tile_count: 1 },
  // Distinct from V3_NESTED's 0 so a bug that reads the wrong tier can't
  // coincidentally pass both R checks with the same value.
  proof_pick: 1,
  copy_picks: {
    headline: 'FLAT HEADLINE',
    subheadline: null,
    eyebrow: null,
    cta: 'BUY'
  },
  rationale: 'legacy rationale'
};

const NEITHER = {
  concept_id: 'empty_picks',
  name: 'No picks anywhere',
  routing: {
    archetype: 'typographic_dominant',
    creative_style: 'minimal',
    // deliberately no media_picks
    output_shape: { format: 'static_single', tile_count: 1 }
  },
  copy: { headline: 'EMPTY', subheadline: null, eyebrow: null, cta: null }
};

// ── C: core dual-read for media_picks (the production bug) ───────────

{
  const picks = conceptMediaPicks(V3_NESTED);
  checkTrue('C1 v3 nested media_picks resolves (len=1)', picks.length === 1);
  check('C1 v3 nested media_id', picks[0] && picks[0].media_id, 'media_hero_1');
  checkTrue(
    'C1 flat-only read would MISS v3 (the production bug)',
    !(Array.isArray(V3_NESTED.media_picks) && V3_NESTED.media_picks.length)
  );
}

{
  const picks = conceptMediaPicks(V2_FLAT);
  checkTrue('C2 v2 flat media_picks still resolves (len=1)', picks.length === 1);
  check('C2 v2 flat media_id', picks[0] && picks[0].media_id, 'media_flat_9');
}

{
  const picks = conceptMediaPicks(NEITHER);
  checkTrue('C3 neither shape → empty array', picks.length === 0);
  checkTrue('C3 conceptField media_picks is undefined/null', conceptField(NEITHER, 'media_picks') == null);
}

{
  // Prefer routing when both present (v3 wins over stale flat sibling).
  const both = {
    media_picks: [{ media_id: 'stale_flat', role: 'x' }],
    routing: { media_picks: [{ media_id: 'live_nested', role: 'hero' }] }
  };
  check('C4 routing wins over flat sibling', conceptMediaPicks(both)[0].media_id, 'live_nested');
}

{
  checkTrue('C5 null concept → empty', conceptMediaPicks(null).length === 0);
  checkTrue('C6 undefined concept → empty', conceptMediaPicks(undefined).length === 0);
}

// C7: non-array nested must fall through to a valid flat sibling.
// The pure-refactor trap (conceptField then coerce non-array → []) drops
// the concept as no_media_picks. Old producer: Array.isArray(nested) ?
// nested : (Array.isArray(flat) ? flat : []).
{
  const FLAT_PICK = [{ media_id: 'from_flat_sibling', role: 'hero' }];
  for (const bad of [{}, 'bad', false, 0, '']) {
    const concept = {
      media_picks: FLAT_PICK,
      routing: { media_picks: bad }
    };
    const picks = conceptMediaPicks(concept);
    checkTrue(
      `C7 non-array nested (${JSON.stringify(bad)}) falls through to flat`,
      Array.isArray(picks) && picks.length === 1 && picks[0].media_id === 'from_flat_sibling'
    );
    // Consumer simulation must accept, not skip as no_media_picks.
    const resolved = (() => {
      const mp = conceptMediaPicks(concept);
      return mp.length ? { ok: true } : { ok: false, reason: 'no_media_picks' };
    })();
    checkTrue(
      `C7 consumer accepts concept when nested=${JSON.stringify(bad)}`,
      resolved.ok === true
    );
  }
}

// C8: empty nested array WINS and does NOT fall through (nested-present).
{
  const emptyNested = {
    media_picks: [{ media_id: 'from_flat', role: 'hero' }],
    routing: { media_picks: [] }
  };
  checkTrue(
    'C8 empty nested array wins (no fallthrough to flat)',
    conceptMediaPicks(emptyNested).length === 0
  );
}

// ── R: every nested routing field dual-reads ─────────────────────────

{
  checkTrue('R0 ROUTING_NESTED_FIELDS is non-empty', ROUTING_NESTED_FIELDS.length >= 10);
  for (const name of ROUTING_NESTED_FIELDS) {
    const nestedVal = conceptField(V3_NESTED, name);
    const flatVal   = conceptField(V2_FLAT, name);
    checkTrue(`R v3 field "${name}" resolves from routing`, nestedVal != null);
    // media_picks / recommended_components are objects — just non-null is enough
    if (name === 'media_picks') {
      checkTrue('R v2 media_picks resolves flat', Array.isArray(flatVal) && flatVal.length === 1);
    } else if (name === 'output_shape') {
      check('R v2 output_shape.format', flatVal && flatVal.format, 'static_single');
      check('R v3 output_shape.format', nestedVal && nestedVal.format, 'static_single');
    } else if (name === 'recommended_components') {
      checkTrue(`R v2 ${name} resolves`, flatVal != null);
    } else {
      checkTrue(`R v2 field "${name}" resolves flat`, flatVal != null && flatVal !== '');
    }
  }
}

// Prefer routing nullish fallthrough to flat
{
  const partial = {
    archetype: 'from_flat',
    routing: { creative_style: 'from_nested' }
  };
  check('R fallthrough archetype from flat', conceptField(partial, 'archetype'), 'from_flat');
  check('R nested creative_style', conceptField(partial, 'creative_style'), 'from_nested');
}

// Falsy-but-present nested values must WIN under != null (not ||).
// A `??` → `||` flip (or truthy check) would fall through to flat and
// silently rewrite the Director's intentional empty/zero/false.
{
  check(
    "R falsy nested '' wins (not || fallthrough)",
    conceptField({ routing: { emotional_hook: '' }, emotional_hook: 'from_flat' }, 'emotional_hook'),
    ''
  );
  check(
    'R falsy nested 0 wins (not || fallthrough)',
    conceptField({ routing: { product_priority: 0 }, product_priority: 'high' }, 'product_priority'),
    0
  );
  check(
    'R falsy nested false wins (not || fallthrough)',
    conceptField({ routing: { cta_emphasis: false }, cta_emphasis: 'primary' }, 'cta_emphasis'),
    false
  );
  // Nullish still falls through.
  check(
    'R null nested falls through to flat',
    conceptField({ routing: { archetype: null }, archetype: 'from_flat' }, 'archetype'),
    'from_flat'
  );
  check(
    'R undefined nested key falls through to flat',
    conceptField({ routing: {}, archetype: 'from_flat' }, 'archetype'),
    'from_flat'
  );
}

// ── P: conceptForRender projects both shapes ─────────────────────────

{
  const p = conceptForRender(V3_NESTED);
  check('P1 v3 archetype', p.archetype, 'hero_quote_overlay');
  check('P1 v3 creative_style', p.creative_style, 'editorial');
  checkTrue('P1 v3 media_picks', Array.isArray(p.media_picks) && p.media_picks[0] && p.media_picks[0].media_id === 'media_hero_1');
  check('P1 v3 output_shape.format', p.output_shape.format, 'static_single');
  check('P1 v3 copy.headline', p.copy.headline, 'WALK ALL DAY');
  checkTrue('P1 v3 no rationale key', !('rationale' in p) && !('reasoning' in p));
}

{
  const p = conceptForRender(V2_FLAT);
  check('P2 v2 archetype', p.archetype, 'full_bleed_hero_bottom_panel');
  checkTrue('P2 v2 media_picks', Array.isArray(p.media_picks) && p.media_picks[0] && p.media_picks[0].media_id === 'media_flat_9');
  check('P2 v2 copy dual-read', p.copy.headline, 'FLAT HEADLINE');
}

// ── J: Judge compressor dual-reads ───────────────────────────────────

{
  const j = compressConceptForJudge(V3_NESTED, 0);
  check('J1 v3 archetype', j.archetype, 'hero_quote_overlay');
  check('J1 v3 creative_style', j.creative_style, 'editorial');
  checkTrue('J1 v3 media_picks len', Array.isArray(j.media_picks) && j.media_picks.length === 1);
  check('J1 v3 media_id', j.media_picks && j.media_picks[0] && j.media_picks[0].media_id, 'media_hero_1');
  check('J1 v3 output_shape.format', j.output_shape && j.output_shape.format, 'static_single');
  check('J1 v3 copy headline', j.copy_picks.headline, 'WALK ALL DAY');
}

{
  const j = compressConceptForJudge(V2_FLAT, 1);
  checkTrue('J2 v2 media_picks still work', j.media_picks.length === 1);
  check('J2 v2 archetype', j.archetype, 'full_bleed_hero_bottom_panel');
}

{
  const j = compressConceptForJudge(NEITHER, 2);
  checkTrue('J3 neither → empty media_picks for judge', j.media_picks.length === 0);
}

// ── Consumer simulation: resolve picks the way expansion does ────────

/**
 * Mirrors campaignAdsGenerationService concept→payload gate for media_picks.
 * Returns { ok, reason } so the harness can assert skip reasons without
 * spinning up mongoose / the full expansion path.
 */
function consumerResolvePicks(concept, universeIds) {
  const mp = conceptMediaPicks(concept);
  if (!mp.length) {
    return { ok: false, reason: 'no_media_picks', conceptId: concept.concept_id };
  }
  const primaryId = String(mp[0].media_id);
  if (!universeIds.has(primaryId)) {
    return {
      ok: false,
      reason: 'media_outside_universe',
      conceptId: concept.concept_id,
      mediaId: primaryId
    };
  }
  return { ok: true, conceptId: concept.concept_id, primaryId, picks: mp };
}

{
  const universe = new Set(['media_hero_1', 'media_flat_9']);
  const r3 = consumerResolvePicks(V3_NESTED, universe);
  checkTrue('X1 v3 concept accepted by consumer', r3.ok === true);
  check('X1 v3 primaryId', r3.primaryId, 'media_hero_1');

  const r2 = consumerResolvePicks(V2_FLAT, universe);
  checkTrue('X2 v2 concept accepted by consumer', r2.ok === true);

  const r0 = consumerResolvePicks(NEITHER, universe);
  checkTrue('X3 neither skipped', r0.ok === false);
  check('X3 skip reason', r0.reason, 'no_media_picks');
}

// Simulate the pathological case: 3 v3 concepts, flat-only would yield 0
{
  const concepts = [V3_NESTED, { ...V3_NESTED, concept_id: 'ten_years_craft_grid' }, { ...V3_NESTED, concept_id: 'rated_comfort_stat' }];
  const universe = new Set(['media_hero_1']);
  const dualOk = concepts.map(c => consumerResolvePicks(c, universe)).filter(r => r.ok).length;
  const flatOk = concepts.map(c => {
    const mp = Array.isArray(c.media_picks) ? c.media_picks : [];
    return mp.length > 0 && universe.has(String(mp[0].media_id));
  }).filter(Boolean).length;
  check('X4 dual-read accepts all 3 v3 concepts', dualOk, 3);
  check('X4 flat-only accepts 0 (the outage)', flatOk, 0);
}

// ── K: per-product reasons distinguish the two empty cases ───────────

{
  checkTrue('K1 NO_CONCEPTS code exists', REASON.NO_CONCEPTS === 'no_concepts');
  checkTrue(
    'K2 CONCEPTS_NO_USABLE_MEDIA code exists',
    REASON.CONCEPTS_NO_USABLE_MEDIA === 'concepts_no_usable_media'
  );
  checkTrue(
    'K3 human messages differ',
    HUMAN_FULL[REASON.NO_CONCEPTS] !== HUMAN_FULL[REASON.CONCEPTS_NO_USABLE_MEDIA]
  );

  const noConcepts = normalizePerProductEntry({
    productId: 'p1',
    payloads: [],
    skipped: REASON.NO_CONCEPTS
  });
  check('K4 no_concepts reason', noConcepts.reason, REASON.NO_CONCEPTS);
  checkTrue('K4 message names Director/concepts',
    /Director returned no concepts/i.test(noConcepts.message));

  const noMedia = normalizePerProductEntry({
    productId: 'p2',
    payloads: [],
    skipped: REASON.CONCEPTS_NO_USABLE_MEDIA,
    conceptCount: 3,
    conceptSkips: [
      { conceptId: 'allday_travel_comfort', reason: 'no_media_picks' },
      { conceptId: 'ten_years_craft_grid', reason: 'no_media_picks' },
      { conceptId: 'rated_comfort_stat', reason: 'no_media_picks' }
    ]
  });
  check('K5 concepts_no_usable_media reason', noMedia.reason, REASON.CONCEPTS_NO_USABLE_MEDIA);
  checkTrue('K5 message names concepts/media',
    /concepts/i.test(noMedia.message) && /media/i.test(noMedia.message));
  check('K5 conceptCount', noMedia.conceptCount, 3);
  check('K5 conceptSkips length', noMedia.conceptSkips.length, 3);
  check('K5 conceptSkip reason', noMedia.conceptSkips[0].reason, 'no_media_picks');

  const summary = summarizeEmptyExpansion({ perProduct: [noMedia] });
  checkTrue('K6 empty summary mentions usable media picks',
    /usable media picks|no usable media/i.test(summary));
  const summaryNoConcepts = summarizeEmptyExpansion({
    perProduct: [noConcepts]
  });
  checkTrue('K6 no_concepts summary distinct',
    /no concepts/i.test(summaryNoConcepts) && summaryNoConcepts !== summary);
}

// ── J+: media_utilization N/A when universe size ≤ 1 ─────────────────

{
  checkTrue('J4 media_utilization is a CONCEPT_AXIS', CONCEPT_AXES.includes('media_utilization'));

  // Universe size reaches the judge via seededUniverse → universeIds in
  // buildConceptRoundPrompt. When size ≤ 1 the axis must be marked N/A.
  const promptU1 = buildConceptRoundPrompt({
    summaries: [{ index: 0, concept_id: 'x' }],
    inputSummary: null,
    brandSignal: null,
    universeIds: ['only_hero']
  });
  checkTrue(
    'J5 universe=1 prompt marks media_utilization NOT APPLICABLE',
    /media_utilization\s+—\s+NOT APPLICABLE/i.test(promptU1.system)
  );
  checkTrue(
    'J5 universe=1 prompt does not instruct always-just-hero penalty as primary',
    !/Penalize:\s*always-just-hero/.test(promptU1.system) ||
      /NOT APPLICABLE[\s\S]*always-just-hero/.test(promptU1.system)
  );
  checkTrue(
    'J5 universe=1 system carries universe size',
    /SEEDED UNIVERSE media_ids \(size=1/.test(promptU1.system)
  );

  const promptU3 = buildConceptRoundPrompt({
    summaries: [{ index: 0, concept_id: 'x' }],
    inputSummary: null,
    brandSignal: null,
    universeIds: ['a', 'b', 'c']
  });
  checkTrue(
    'J6 universe=3 prompt keeps always-just-hero penalty',
    /Penalize:\s*always-just-hero/.test(promptU3.system) &&
      !/media_utilization\s+—\s+NOT APPLICABLE/i.test(promptU3.system)
  );

  // Score path: when universe ≤ 1, media_utilization is excluded from the
  // average (source contract — judgeConceptsRound uses scoreAxes filter).
  const judgePath = path.join(__dirname, '..', 'services', 'aiJudgeService.js');
  const judgeSrc = fs.readFileSync(judgePath, 'utf8');
  checkTrue(
    'J7 score path excludes media_utilization when universeSize ≤ 1',
    /universeSize\s*<=\s*1/.test(judgeSrc) &&
      /filter\(\s*\(?\s*ax\s*\)?\s*=>\s*ax\s*!==\s*['"]media_utilization['"]\s*\)/.test(judgeSrc)
  );
}

// ── U: feed shape menu narrows by universe size ──────────────────────

{
  check(
    'U1 universe=1 → static_single only',
    feedOutputShapesForUniverse(1),
    ['static_single']
  );
  check(
    'U1 universe=[] → static_single only',
    feedOutputShapesForUniverse([]),
    ['static_single']
  );
  check(
    'U2 universe=2 → full FEED_OUTPUT_SHAPES',
    feedOutputShapesForUniverse(2),
    [...FEED_OUTPUT_SHAPES]
  );
  checkTrue(
    'U2 multi-pick shapes exist for larger universes',
    MULTI_PICK_FEED_SHAPES.every((s) => FEED_OUTPUT_SHAPES.includes(s))
  );

  // Schema enum agrees with the helper.
  const schema1 = buildResponseSchemaRound(
    [{ mediaId: 'm1' }],
    'meta_feed_1_1'
  );
  // Walk to output_shape.format.enum inside the nested schema.
  const shapeEnum1 = (() => {
    try {
      const props = schema1?.schema?.properties?.concepts?.items?.properties
        || schema1?.properties?.concepts?.items?.properties
        || null;
      // buildResponseSchemaRound returns { name, schema } or raw — probe both.
      const root = schema1.schema || schema1;
      // routing is under concepts.items.properties.routing in the full schema;
      // for the helper we only need the format enum from the built shape.
      // Easier: re-derive via feedOutputShapesForUniverse and assert source wiring.
      return null;
    } catch (_) { return null; }
  })();
  void shapeEnum1;

  const dirPath = path.join(__dirname, '..', 'services', 'aiCreativeDirectorService.js');
  const dirSrc = fs.readFileSync(dirPath, 'utf8');
  checkTrue(
    'U3 prompt uses feedOutputShapesForUniverse(universe)',
    /feedOutputShapesForUniverse\(\s*universe\s*\)/.test(dirSrc)
  );
  checkTrue(
    'U3 schema uses feedOutputShapesForUniverse(seededUniverse)',
    /feedOutputShapesForUniverse\(\s*seededUniverse\s*\)/.test(dirSrc)
  );
  checkTrue(
    'U3 multi-pick shapes gated on n < 2',
    /if\s*\(\s*n\s*<\s*2\s*\)\s*return\s*\[\s*['"]static_single['"]\s*\]/.test(dirSrc)
  );

  // Prompt text for universe=1 must not offer collage/grid.
  const { system: promptSystem } = buildPromptRound({
    inputSummary: { product_signal: { name: 'Test' } },
    creativeIntent: null,
    platformFormat: 'meta_feed_1_1',
    universe: [{ mediaId: 'hero_only', role: 'hero', fileType: 'image' }],
    roundIndex: 0,
    avoidList: []
  });
  checkTrue(
    'U4 universe=1 prompt offers static_single',
    /output_shape\.format ∈ static_single\b/.test(promptSystem)
  );
  checkTrue(
    'U4 universe=1 prompt does not offer static_collage/static_grid',
    !/static_collage/.test(promptSystem) && !/static_grid/.test(promptSystem)
  );

  const { system: promptSystem3 } = buildPromptRound({
    inputSummary: { product_signal: { name: 'Test' } },
    creativeIntent: null,
    platformFormat: 'meta_feed_1_1',
    universe: [
      { mediaId: 'a', role: 'hero', fileType: 'image' },
      { mediaId: 'b', role: 'alt', fileType: 'image' },
      { mediaId: 'c', role: 'alt', fileType: 'image' }
    ],
    roundIndex: 0,
    avoidList: []
  });
  checkTrue(
    'U5 universe=3 prompt offers collage and grid',
    /static_collage/.test(promptSystem3) && /static_grid/.test(promptSystem3)
  );
}

// ── S: source contract — consumer dual-reads, default=1, alert fires ─

{
  const genPath = path.join(__dirname, '..', 'services', 'campaignAdsGenerationService.js');
  const genSrc = fs.readFileSync(genPath, 'utf8');

  checkTrue(
    'S1 consumer requires conceptMediaPicks / conceptField',
    /conceptMediaPicks/.test(genSrc) && /conceptField/.test(genSrc)
  );
  checkTrue(
    'S1 consumer uses conceptMediaPicks(concept) for picks',
    /const mp = conceptMediaPicks\(concept\)/.test(genSrc)
  );
  // The flat-only pattern that caused the outage must not remain as the
  // active read in the concept→payload loop. (Comments may still mention it.)
  checkTrue(
    'S1 no flat-only media_picks read as the active assignment',
    !/const mp = Array\.isArray\(concept\.media_picks\)\s*\?\s*concept\.media_picks/.test(genSrc)
  );

  checkTrue(
    'S2 creative_style dual-read via conceptField',
    /conceptField\(concept,\s*['"]creative_style['"]\)/.test(genSrc)
  );

  // Default TOP_N is 1 (hero only). Env override still works.
  checkTrue(
    'S3 DIRECTOR_UNIVERSE_TOP_N default is 1',
    /DIRECTOR_UNIVERSE_TOP_N[^\n]*=\s*Math\.max\(1,\s*parseInt\([^)]+\)\s*\|\|\s*1\)/.test(genSrc)
  );
  checkTrue(
    'S3 operator multi-select still widens via Math.max(mediaIds.length, …)',
    /Math\.max\(\s*mediaIds\.length\s*,\s*DIRECTOR_UNIVERSE_TOP_N\s*\)/.test(genSrc)
  );

  checkTrue(
    'S4 alert on concepts>0 && payloads===0',
    /alertService\.error/.test(genSrc) &&
    /Director concepts discarded/.test(genSrc) &&
    /CONCEPTS_NO_USABLE_MEDIA/.test(genSrc)
  );

  const defaultsPath = path.join(__dirname, '..', 'config', 'defaults.env');
  const defaultsSrc = fs.readFileSync(defaultsPath, 'utf8');
  checkTrue(
    'S5 defaults.env sets DIRECTOR_UNIVERSE_TOP_N=1',
    /^DIRECTOR_UNIVERSE_TOP_N=1\s*$/m.test(defaultsSrc)
  );

  // Producer + consumer share the helper.
  const dirPath = path.join(__dirname, '..', 'services', 'aiCreativeDirectorService.js');
  const dirSrc = fs.readFileSync(dirPath, 'utf8');
  checkTrue(
    'S6 producer uses conceptMediaPicks / conceptField',
    /conceptMediaPicks/.test(dirSrc) && /conceptField/.test(dirSrc)
  );
  // V1 validateConcepts must dual-read (not flat-only c.archetype etc.).
  checkTrue(
    'S6 validateConcepts uses conceptField for archetype/hook/proof',
    /conceptField\(\s*c\s*,\s*['"]archetype['"]\s*\)/.test(dirSrc) &&
      /conceptField\(\s*c\s*,\s*['"]emotional_hook['"]\s*\)/.test(dirSrc) &&
      /conceptField\(\s*c\s*,\s*['"]social_proof_type['"]\s*\)/.test(dirSrc) &&
      /conceptField\(\s*c\s*,\s*['"]recommended_components['"]\s*\)/.test(dirSrc)
  );

  const judgePath = path.join(__dirname, '..', 'services', 'aiJudgeService.js');
  const judgeSrc = fs.readFileSync(judgePath, 'utf8');
  checkTrue(
    'S7 judge compress uses conceptMediaPicks',
    /conceptMediaPicks\(concept\)/.test(judgeSrc)
  );

  // conceptMediaPicks must use Array.isArray order, not conceptField+coerce.
  const projPath = path.join(__dirname, '..', 'services', 'conceptProjection.js');
  const projSrc = fs.readFileSync(projPath, 'utf8');
  checkTrue(
    'S8 conceptMediaPicks uses Array.isArray on nested then flat',
    /Array\.isArray\(\s*r\.media_picks\s*\)/.test(projSrc) &&
      /Array\.isArray\(\s*concept\.media_picks\s*\)/.test(projSrc)
  );
  checkTrue(
    'S8 conceptMediaPicks does NOT route through conceptField then coerce',
    !/function conceptMediaPicks[\s\S]{0,200}conceptField\(\s*concept\s*,\s*['"]media_picks['"]\s*\)/.test(projSrc)
  );
}

// ── E: exhaustive dual-read scan (services/ + routes/) ───────────────
//
// Fail if any file reads a ROUTING_NESTED_FIELDS name directly off a
// concept-shaped object without going through conceptField /
// conceptMediaPicks / conceptForRender. Allowlist documents itself.

{
  const ROOT = path.join(__dirname, '..');
  const SCAN_DIRS = ['services', 'routes'];

  // Allowlisted files — each entry MUST document why it is exempt.
  // scripts/ is not scanned (offline harnesses only).
  const ALLOW_FILES = {
    // The dual-read helper itself defines the fields and the readers.
    'services/conceptProjection.js': 'the dual-read helper (defines ROUTING_NESTED_FIELDS + conceptField/conceptMediaPicks/conceptForRender)'
  };

  // Per-line allow patterns (self-documenting). A line matching any of
  // these is not a flat-only consumer of a raw Director concept.
  const ALLOW_LINE = [
    // Already going through the helper on this line.
    { re: /conceptField\s*\(/, why: 'uses conceptField' },
    { re: /conceptMediaPicks\s*\(/, why: 'uses conceptMediaPicks' },
    { re: /conceptForRender\s*\(/, why: 'uses conceptForRender' },
    // Layout-artifact hierarchy_spec.strategy.* is NOT a Director concept.
    { re: /hierarchy_spec/, why: 'layout-artifact hierarchy_spec (not Director concept)' },
    { re: /\bhs\.strategy\b/, why: 'layout-artifact hs.strategy (not Director concept)' },
    { re: /\bstrategy\?\.(?:social_proof_type|cta_emphasis|emotional_hook|product_priority|ugc_priority|comment_priority|stat_priority|recommended_components|archetype|layout_family|creative_style|media_picks|output_shape)\b/, why: 'layout-artifact strategy.* (not Director concept)' },
    { re: /\.strategy\?\.(?:social_proof_type|cta_emphasis|emotional_hook|product_priority|ugc_priority|comment_priority|stat_priority)\b/, why: 'layout-artifact .strategy?*' },
    // Comment-only lines.
    { re: /^\s*\/\//, why: 'line comment' },
    { re: /^\s*\*/, why: 'block-comment continuation' },
    // Projection output variables (already dual-read by conceptForRender).
    { re: /\bprojected(?:Dir)?\./, why: 'reads conceptForRender projection' },
    // JSON-schema / prompt construction talking about field names, not reading a concept.
    { re: /type:\s*['"]string['"]/, why: 'JSON-schema property definition' },
    { re: /enum:\s*\[/, why: 'JSON-schema enum' }
  ];

  // Bases that historically hold a raw Director concept (pre-projection).
  // Reading FIELD off these without the helper is the latent flat-only bug.
  const CONCEPT_BASES = [
    'concept',
    'dirConcept',
    'directionConcept',
    'rawConcept',
    'c' // Director validators iterate concepts as `c`
  ];

  const fieldAlt = ROUTING_NESTED_FIELDS.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const baseAlt = CONCEPT_BASES.join('|');
  // Match base.field or base.routing.field
  const readRe = new RegExp(
    String.raw`\b(${baseAlt})\.(?:routing\.)?(${fieldAlt})\b`,
    'g'
  );

  function listJsFiles(dirRel) {
    const abs = path.join(ROOT, dirRel);
    if (!fs.existsSync(abs)) return [];
    const out = [];
    const walk = (d, rel) => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
        const r = path.join(rel, ent.name);
        if (ent.isDirectory()) walk(path.join(d, ent.name), r);
        else if (ent.isFile() && ent.name.endsWith('.js')) out.push(r);
      }
    };
    walk(abs, dirRel);
    return out;
  }

  // Strip // and /* */ comments so allowlist comment matches still work
  // on residual code, and so string-ish comment examples do not fire.
  function stripBlockComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  }

  const hits = [];
  for (const dir of SCAN_DIRS) {
    for (const rel of listJsFiles(dir)) {
      if (ALLOW_FILES[rel]) continue;
      const src = stripBlockComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
      const lines = src.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Whole-line comment
        if (/^\s*\/\//.test(line)) continue;
        // Skip pure string-template documentation lines that only mention
        // routing.field inside a quoted prompt fragment (common in Director
        // prompts). Detect: line is mostly a string and has no assignment
        // from a concept base outside quotes — if the match is only inside
        // quotes, skip.
        let m;
        readRe.lastIndex = 0;
        while ((m = readRe.exec(line)) !== null) {
          const base = m[1];
          const field = m[2];
          // If this occurrence sits inside a single- or double-quoted
          // string or a template-literal chunk with no ${}, allow it
          // (prompt text / comments about the field).
          const before = line.slice(0, m.index);
          const single = (before.match(/'/g) || []).length % 2 === 1;
          const doubl = (before.match(/"/g) || []).length % 2 === 1;
          // Crude template: odd number of unescaped backticks before match.
          const ticks = (before.match(/`/g) || []).length % 2 === 1;
          if (single || doubl || ticks) continue;

          // Allowlisted line patterns.
          if (ALLOW_LINE.some((a) => a.re.test(line))) continue;

          // aiImageReferenceService / aiCanvasSpecService: after
          // `const c = conceptForRender(concept) || concept` the read of
          // c.field is on the projection. Detect a prior conceptForRender
          // assignment to this base within a short lookback window.
          if (base === 'c' || base === 'dc' || base === 'projected' || base === 'projectedDir') {
            const lookback = lines.slice(Math.max(0, i - 15), i + 1).join('\n');
            if (new RegExp(String.raw`\b(?:const|let|var)\s+${base}\s*=\s*conceptForRender\s*\(`).test(lookback)) {
              continue;
            }
          }

          hits.push(`${rel}:${i + 1}  ${base}.${field}  :: ${line.trim().slice(0, 120)}`);
        }
      }
    }
  }

  checkTrue(
    `E1 no flat-only ROUTING_NESTED_FIELDS reads in services/routes (hits=${hits.length})`,
    hits.length === 0
  );
  if (hits.length) {
    for (const h of hits.slice(0, 20)) {
      failures.push(`E1 hit: ${h}`);
    }
  }

  // Allowlist is non-empty and self-documented (so a future empty allowlist
  // does not silently mean "nothing was thought about").
  checkTrue(
    'E2 allowlist documents the helper itself',
    typeof ALLOW_FILES['services/conceptProjection.js'] === 'string' &&
      /helper/i.test(ALLOW_FILES['services/conceptProjection.js'])
  );
  checkTrue(
    'E3 allowlist covers hierarchy_spec strategy reads',
    ALLOW_LINE.some((a) => /hierarchy_spec/.test(String(a.re)))
  );
}

// ── report ───────────────────────────────────────────────────────────

const total = pass + failures.length;
if (failures.length) {
  console.error(`verifyConceptContract: ${pass}/${total} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error('  FAIL', f);
  process.exit(1);
}
console.log(`verifyConceptContract: ${pass}/${total} passed`);
process.exit(0);
