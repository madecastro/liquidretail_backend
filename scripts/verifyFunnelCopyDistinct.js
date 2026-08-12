'use strict';
/**
 * verifyFunnelCopyDistinct — the three PMax funnel variants must not print the
 * same headline.
 *
 * THE DEFECT (owner, 2026-08-12): "all 3 intent profiles should have
 * distinctive creative at a minimum in copy."
 *
 * They did not. The three free retitles — awareness / consideration /
 * conversion — are derive-only Ads sharing one master plate, and
 * buildMetaForAd resolves their copy from a LayoutInputArtifact scoped by
 * {mediaId, productId} with NO stage dimension. Downstream,
 * selectVideoHeadline picks the best FITTING candidate from a pool that
 * candidatesFromConcepts had flattened across every concept — a
 * deterministic function of the pool, so all three variants got the identical
 * string. The only difference that shipped was preset styling.
 *
 * That is exactly what the Director is instructed to avoid, in its own words:
 * "the three stages must each appear exactly once so Google has distinct
 * approaches to test — not cosmetic variations of one ad."
 *
 * The distinct copy was always there. Nothing asked for it by stage.
 *
 * These checks call the real exported selection logic against a round shaped
 * like a live PMax round, so a regression in either the stage ordering or the
 * fallback shows up here rather than in a delivered ad.
 */
const assert = require('assert');

const {
  candidatesFromConcepts,
  conceptFunnelStage,
  selectVideoHeadline
} = require('../services/videoHeadlineService');

let checks = 0;
const ok = (label, fn) => { fn(); checks += 1; void label; };

console.log('verifyFunnelCopyDistinct\n');

// A round shaped like a real PMax one: three concepts, one per stage, each
// with its own copy block.
const ROUND = [
  { concept_id: 'c1', routing: { funnel_stage: 'awareness' },
    copy: { headline: 'Built for the long run', subheadline: 'A1', eyebrow: 'E1' } },
  { concept_id: 'c2', routing: { funnel_stage: 'consideration' },
    copy: { headline: 'Rated 4.8 by 2,000 runners', subheadline: 'A2', eyebrow: 'E2' } },
  { concept_id: 'c3', routing: { funnel_stage: 'conversion' },
    copy: { headline: 'Get 20% off today', subheadline: 'A3', eyebrow: 'E3' } }
];

// ── A. stage detection ────────────────────────────────────────────────────

ok('reads routing.funnel_stage, and a flat funnel_stage, case/space tolerant', () => {
  assert.strictEqual(conceptFunnelStage(ROUND[0]), 'awareness');
  assert.strictEqual(conceptFunnelStage({ funnel_stage: ' Conversion ' }), 'conversion');
  assert.strictEqual(conceptFunnelStage({}), null);
  assert.strictEqual(conceptFunnelStage(null), null);
});

// ── B. the fix: each stage leads with ITS OWN copy ────────────────────────

ok('each stage puts its own concept first', () => {
  for (const [stage, want] of [
    ['awareness',     'Built for the long run'],
    ['consideration', 'Rated 4.8 by 2,000 runners'],
    ['conversion',    'Get 20% off today']
  ]) {
    const first = candidatesFromConcepts(ROUND, stage)[0];
    assert.strictEqual(first, want, `${stage} did not lead with its own headline`);
  }
});

ok('THE REGRESSION: the three stages do not all select the same headline', () => {
  // The delivered defect, pinned end-to-end through the real selector.
  const picked = ['awareness', 'consideration', 'conversion'].map(stage =>
    selectVideoHeadline({
      candidates: candidatesFromConcepts(ROUND, stage),
      format: 'landscape'
    })
  );
  assert.strictEqual(new Set(picked).size, 3,
    `all three funnel stages selected overlapping copy: ${JSON.stringify(picked)}`);
});

ok('no stage argument reproduces the OLD flattened pool exactly', () => {
  // Inertness: every non-funnel caller must be unaffected.
  const before = candidatesFromConcepts(ROUND);
  assert.deepStrictEqual(before, candidatesFromConcepts(ROUND, null));
  assert.strictEqual(before[0], 'Built for the long run');
});

// ── C. ordering, not filtering ────────────────────────────────────────────

ok('a stage whose concept has no usable copy still falls back to the round', () => {
  const thin = [
    { routing: { funnel_stage: 'awareness' }, copy: { headline: '   ' } },
    { routing: { funnel_stage: 'conversion' }, copy: { headline: 'Get 20% off today' } }
  ];
  const out = candidatesFromConcepts(thin, 'awareness');
  assert.ok(out.length > 0, 'went empty instead of falling back — a thin headline beats none');
  assert.strictEqual(out[0], 'Get 20% off today');
});

ok('an unknown stage falls back rather than returning nothing', () => {
  const out = candidatesFromConcepts(ROUND, 'retention');
  assert.deepStrictEqual(out, candidatesFromConcepts(ROUND, null));
});

ok('every candidate from the matching stage precedes the other stages', () => {
  const out = candidatesFromConcepts(ROUND, 'conversion');
  const ownIdx = ['Get 20% off today', 'A3', 'E3'].map(s => out.indexOf(s));
  const otherIdx = ['Built for the long run', 'Rated 4.8 by 2,000 runners'].map(s => out.indexOf(s));
  assert.ok(Math.max(...ownIdx) < Math.min(...otherIdx),
    'a foreign-stage candidate outranked the stage\'s own copy');
});

// ── D. malformed input ────────────────────────────────────────────────────

ok('malformed input never throws and never invents copy', () => {
  for (const bad of [null, undefined, 'x', 42, {}, [null, undefined, 5]]) {
    assert.deepStrictEqual(candidatesFromConcepts(bad, 'awareness'), []);
    assert.deepStrictEqual(candidatesFromConcepts(bad), []);
  }
  assert.deepStrictEqual(candidatesFromConcepts([{ routing: null, copy: null }], 'awareness'), []);
});

console.log(`\n✅ verifyFunnelCopyDistinct: ${checks}/${checks} checks passed`);
