#!/usr/bin/env node
'use strict';
/**
 * verifyPmaxSplitSide — Stage 1 of the PMax 16:9 split-stage video unit
 * (product anchored to one side of frame, the OTHER side generatively
 * extended to carry copy). Stage 1 ships only the PURE side-choice decision
 * layer (services/pmaxSplitStrategy.js) and a Director field
 * (services/aiCreativeDirectorService.js routing.panelTreatment) — no I/O,
 * no spend, everything behind PMAX_SPLIT_VIDEO (default false).
 *
 * THE DEFECT THIS PREVENTS: chooseSubjectSide decides which HALF of the
 * frame gets painted over by a generative model. Get `side`/`panelSide`
 * backwards and the "empty side" extension lands ON TOP of the product
 * instead of beside it — a silent, expensive rendering bug that would only
 * show up by eyeballing finished video, one billable Atlas call at a time.
 * Get the dead-zone or width-cap boundaries wrong and a near-centered or
 * too-wide subject either flips sides on ordinary YOLO jitter between runs
 * of the SAME photo, or gets a copy panel painted straight through it. And
 * because routing.panelTreatment rides OpenAI-strict-shaped JSON (every
 * declared property must also be `required`, nullability is how "optional"
 * is expressed), a property added without its `required` entry is a defect
 * that is INVISIBLE to every behavioural check here — the model would still
 * emit valid-looking JSON — and only breaks the day this schema is ever
 * transported with strict enforcement on. Section G asserts that shape
 * directly, since nothing else in this file would ever catch its absence.
 *
 * Runs zero DB / zero network — pure fixtures + the real exported
 * functions, no source regexing except where explicitly noted.
 *   node scripts/verifyPmaxSplitSide.js
 *
 * Revert-prove (see bottom of file for the exact command): temporarily make
 * chooseSubjectSide ignore the dead zone (e.g. drop the dead-zone `return`)
 * and section B goes red. Restore it and the suite goes green again.
 */

const assert = require('assert');
const path = require('path');

// Load defaults.env so PMAX_SPLIT_VIDEO (and everything else) resolves the
// same way here as it does in prod. Individual checks below still override
// process.env.PMAX_SPLIT_VIDEO directly where the flag state matters.
require('dotenv').config({ path: path.join(__dirname, '..', 'config', 'defaults.env') });

const {
  chooseSubjectSide,
  DEAD_ZONE_WIDTH,
  MAX_SUBJECT_WIDTH_FRACTION
} = require('../services/pmaxSplitStrategy');

const {
  buildResponseSchemaRound,
  panelTreatmentFromConcept,
  PANEL_TREATMENT_VALUES
} = require('../services/aiCreativeDirectorService');

let checks = 0;
const ok = (label, fn) => { fn(); checks += 1; void label; };

console.log('verifyPmaxSplitSide\n');

// ── A. subject on the right → east / west ────────────────────────────

ok('subject clearly right of center → side=east, panelSide=west', () => {
  const r = chooseSubjectSide({
    media: { width: 1920, height: 1080, refinedProducts: [{ x1: 1300, y1: 100, x2: 1700, y2: 900 }] }
  });
  assert.strictEqual(r.side, 'east');
  assert.strictEqual(r.panelSide, 'west');
  assert.ok(r.centroidX > 0.55, `expected centroidX > 0.55, got ${r.centroidX}`);
});

ok('subject at the extreme right edge → east/west', () => {
  const r = chooseSubjectSide({
    media: { width: 1920, height: 1080, refinedProducts: [{ x1: 1700, y1: 0, x2: 1920, y2: 1080 }] }
  });
  assert.strictEqual(r.side, 'east');
  assert.strictEqual(r.panelSide, 'west');
});

// ── B. subject on the left → west / east ─────────────────────────────

ok('subject clearly left of center → side=west, panelSide=east', () => {
  const r = chooseSubjectSide({
    media: { width: 1920, height: 1080, refinedProducts: [{ x1: 200, y1: 100, x2: 600, y2: 900 }] }
  });
  assert.strictEqual(r.side, 'west');
  assert.strictEqual(r.panelSide, 'east');
  assert.ok(r.centroidX < 0.45, `expected centroidX < 0.45, got ${r.centroidX}`);
});

ok('subject at the extreme left edge → west/east', () => {
  const r = chooseSubjectSide({
    media: { width: 1920, height: 1080, refinedProducts: [{ x1: 0, y1: 0, x2: 220, y2: 1080 }] }
  });
  assert.strictEqual(r.side, 'west');
  assert.strictEqual(r.panelSide, 'east');
});

// ── C. dead zone — centroid 0.50 and both edges defer ────────────────

ok('centroid exactly 0.50 defers', () => {
  const width = 2000;
  const r = chooseSubjectSide({
    media: { width, height: 1000, refinedProducts: [{ x1: 900, y1: 0, x2: 1100, y2: 500 }] }
  });
  assert.strictEqual(r.side, null);
  assert.strictEqual(r.panelSide, null);
  assert.match(r.reason, /dead zone/);
});

ok('centroid exactly at the LOW dead-zone edge (0.45) defers', () => {
  const width = 2000;
  const lo = 0.5 - DEAD_ZONE_WIDTH / 2;
  const centerPx = lo * width;
  const r = chooseSubjectSide({
    media: { width, height: 1000, refinedProducts: [{ x1: centerPx - 50, y1: 0, x2: centerPx + 50, y2: 500 }] }
  });
  assert.strictEqual(r.side, null, `expected defer at lo edge, got ${JSON.stringify(r)}`);
  assert.match(r.reason, /dead zone/);
});

ok('centroid exactly at the HIGH dead-zone edge (0.55) defers', () => {
  const width = 2000;
  const hi = 0.5 + DEAD_ZONE_WIDTH / 2;
  const centerPx = hi * width;
  const r = chooseSubjectSide({
    media: { width, height: 1000, refinedProducts: [{ x1: centerPx - 50, y1: 0, x2: centerPx + 50, y2: 500 }] }
  });
  assert.strictEqual(r.side, null, `expected defer at hi edge, got ${JSON.stringify(r)}`);
  assert.match(r.reason, /dead zone/);
});

ok('DEAD_ZONE_WIDTH default really is 0.10 (0.45..0.55)', () => {
  assert.strictEqual(DEAD_ZONE_WIDTH, 0.10);
});

ok('just outside the dead zone (0.44) resolves a side, does not defer', () => {
  const width = 2000;
  const centerPx = 0.44 * width;
  const r = chooseSubjectSide({
    media: { width, height: 1000, refinedProducts: [{ x1: centerPx - 10, y1: 0, x2: centerPx + 10, y2: 500 }] }
  });
  assert.strictEqual(r.side, 'west');
  assert.strictEqual(r.panelSide, 'east');
});

// ── D. subject too wide for a panel defers ───────────────────────────

ok('subject wider than MAX_SUBJECT_WIDTH_FRACTION defers', () => {
  const width = 1000;
  const r = chooseSubjectSide({
    // spans 60% of source width, off-center so it is NOT also a dead-zone
    // hit — isolates the width-cap rule from the dead-zone rule.
    media: { width, height: 1000, refinedProducts: [{ x1: 0, y1: 0, x2: 600, y2: 1000 }] }
  });
  assert.strictEqual(r.side, null);
  assert.strictEqual(r.panelSide, null);
  assert.match(r.reason, /no usable empty half/);
});

ok('MAX_SUBJECT_WIDTH_FRACTION default really is 0.55', () => {
  assert.strictEqual(MAX_SUBJECT_WIDTH_FRACTION, 0.55);
});

ok('subject just under the width cap, off-center, resolves a side', () => {
  const width = 1000;
  // 500px wide (50%, under the 55% cap), positioned hard right so its
  // centroid clears the dead zone too.
  const r = chooseSubjectSide({
    media: { width, height: 1000, refinedProducts: [{ x1: 480, y1: 0, x2: 980, y2: 1000 }] }
  });
  assert.strictEqual(r.side, 'east');
});

// ── E. missing bbox / zero dims / garbage input never throws ────────

ok('missing bbox (empty refinedProducts) defers, no throw', () => {
  const r = chooseSubjectSide({ media: { width: 1000, height: 1000, refinedProducts: [] } });
  assert.strictEqual(r.side, null);
  assert.match(r.reason, /no YOLO subject bbox/);
});

ok('zero width defers, no throw', () => {
  const r = chooseSubjectSide({
    media: { width: 0, height: 1000, refinedProducts: [{ x1: 0, y1: 0, x2: 10, y2: 10 }] }
  });
  assert.strictEqual(r.side, null);
  assert.match(r.reason, /dims unknown or zero/);
});

ok('zero height defers, no throw', () => {
  const r = chooseSubjectSide({
    media: { width: 1000, height: 0, refinedProducts: [{ x1: 0, y1: 0, x2: 10, y2: 10 }] }
  });
  assert.strictEqual(r.side, null);
  assert.match(r.reason, /dims unknown or zero/);
});

ok('a battery of malformed inputs all defer without throwing (total function)', () => {
  const malformed = [
    null,
    undefined,
    {},
    { media: null },
    { media: undefined },
    { media: 'not-an-object' },
    { media: 42 },
    { media: [] },
    { media: { width: 'nope', height: 'nope', refinedProducts: [{ x1: 0, y1: 0, x2: 10, y2: 10 }] } },
    { media: { width: 1000, height: 1000, refinedProducts: 'not-an-array' } },
    { media: { width: 1000, height: 1000, refinedProducts: [{ x1: NaN, y1: 0, x2: 10, y2: 10 }] } },
    { media: { width: -100, height: 1000, refinedProducts: [{ x1: 0, y1: 0, x2: 10, y2: 10 }] } },
    'a bare string',
    0,
    []
  ];
  for (const bad of malformed) {
    let r;
    assert.doesNotThrow(() => { r = chooseSubjectSide(bad); }, `threw on ${JSON.stringify(bad)}`);
    assert.strictEqual(r.side, null, `expected defer for ${JSON.stringify(bad)}, got ${JSON.stringify(r)}`);
    assert.strictEqual(r.panelSide, null, `expected panelSide null for ${JSON.stringify(bad)}`);
    assert.strictEqual(typeof r.reason, 'string', `expected a reason string for ${JSON.stringify(bad)}`);
  }
});

// ── F. panelSide is ALWAYS the opposite of side (sweep) ──────────────

ok('panelSide is always the opposite of side across a centroid sweep, never equal', () => {
  const width = 1000;
  let sawEast = false, sawWest = false, sawDefer = false;
  // Sweep a single, narrow (40px — well under the width cap) subject box
  // across the full width. Every non-deferred result must have
  // side !== panelSide, and specifically the opposite of one another.
  for (let cx = 20; cx <= width - 20; cx += 10) {
    const r = chooseSubjectSide({
      media: { width, height: 1000, refinedProducts: [{ x1: cx - 20, y1: 0, x2: cx + 20, y2: 1000 }] }
    });
    if (r.side === null) { sawDefer = true; continue; }
    assert.notStrictEqual(r.side, r.panelSide, `side === panelSide at cx=${cx}: ${JSON.stringify(r)}`);
    if (r.side === 'east') { sawEast = true; assert.strictEqual(r.panelSide, 'west'); }
    if (r.side === 'west') { sawWest = true; assert.strictEqual(r.panelSide, 'east'); }
  }
  assert.ok(sawEast, 'sweep never produced side=east');
  assert.ok(sawWest, 'sweep never produced side=west');
  assert.ok(sawDefer, 'sweep never hit the dead zone — sweep step/range is wrong');
});

// ── G. panelTreatmentFromConcept — dual-read + legacy degrade ────────

ok('panelTreatmentFromConcept reads nested routing.panelTreatment = scene_extend', () => {
  assert.strictEqual(
    panelTreatmentFromConcept({ routing: { panelTreatment: 'scene_extend' } }),
    'scene_extend'
  );
});

ok('panelTreatmentFromConcept reads nested routing.panelTreatment = brand_panel', () => {
  assert.strictEqual(
    panelTreatmentFromConcept({ routing: { panelTreatment: 'brand_panel' } }),
    'brand_panel'
  );
});

ok('panelTreatmentFromConcept returns null for a legacy concept recorded before this field existed', () => {
  // A round persisted before Stage 1 shipped has a routing object with no
  // panelTreatment key at all — not even null. Must degrade gracefully,
  // not throw and not return undefined.
  const legacyConcept = {
    concept_id: 'legacy_concept',
    routing: {
      archetype: 'typographic_dominant',
      layout_family: 'centered',
      media_picks: [{ media_id: 'm1', role: 'hero', notes: null }]
    },
    copy: { headline: 'OLD', subheadline: null, eyebrow: null, cta: 'SHOP' }
  };
  assert.strictEqual(panelTreatmentFromConcept(legacyConcept), null);
});

ok('panelTreatmentFromConcept returns null for a flat (pre-v3) concept', () => {
  assert.strictEqual(panelTreatmentFromConcept({ archetype: 'x' }), null);
});

ok('panelTreatmentFromConcept returns null for null/undefined concepts', () => {
  assert.strictEqual(panelTreatmentFromConcept(null), null);
  assert.strictEqual(panelTreatmentFromConcept(undefined), null);
});

ok('panelTreatmentFromConcept rejects a value outside the enum rather than passing it through', () => {
  assert.strictEqual(
    panelTreatmentFromConcept({ routing: { panelTreatment: 'literally anything else' } }),
    null
  );
});

// ── H. Director schema — panelTreatment gated correctly ──────────────

{
  const prior = process.env.PMAX_SPLIT_VIDEO;
  try {
    ok('flag OFF (default): pmax_video_16_9 schema does not offer panelTreatment at all', () => {
      delete process.env.PMAX_SPLIT_VIDEO;
      const schema = buildResponseSchemaRound([{ mediaId: 'm1' }], 'pmax_video_16_9');
      const routing = schema.schema.properties.concepts.items.properties.routing;
      assert.ok(!('panelTreatment' in routing.properties), 'flag-off schema must not mention panelTreatment');
      assert.ok(!routing.required.includes('panelTreatment'), 'flag-off schema must not require panelTreatment');
    });

    ok('flag ON + PMax VIDEO destination: schema offers panelTreatment, nullable, enum matches PANEL_TREATMENT_VALUES', () => {
      process.env.PMAX_SPLIT_VIDEO = 'true';
      const schema = buildResponseSchemaRound([{ mediaId: 'm1' }], 'pmax_video_16_9');
      const routing = schema.schema.properties.concepts.items.properties.routing;
      const prop = routing.properties.panelTreatment;
      assert.ok(prop, 'panelTreatment property missing with flag on for a PMax video format');
      assert.deepStrictEqual(prop.type, ['string', 'null']);
      assert.deepStrictEqual(prop.enum, [...PANEL_TREATMENT_VALUES, null]);
    });

    // Section G's namesake structural assertion: OpenAI strict-shaped JSON
    // schema requires EVERY declared property to also be listed in
    // `required` (nullability, not omission, is how "optional" is
    // expressed). This is not observable via any behavioural check above —
    // the Director would still emit well-formed JSON either way — so it is
    // asserted directly against the schema object the real function builds.
    ok('STRUCTURAL: flag ON + PMax video — panelTreatment is listed in routing.required', () => {
      process.env.PMAX_SPLIT_VIDEO = 'true';
      const schema = buildResponseSchemaRound([{ mediaId: 'm1' }], 'pmax_video_16_9');
      const routing = schema.schema.properties.concepts.items.properties.routing;
      assert.ok(
        routing.required.includes('panelTreatment'),
        `routing.required is missing "panelTreatment": ${JSON.stringify(routing.required)}`
      );
    });

    ok('flag ON but a PMax VIDEO sibling format (9:16) also offers it', () => {
      process.env.PMAX_SPLIT_VIDEO = 'true';
      const schema = buildResponseSchemaRound([{ mediaId: 'm1' }], 'pmax_video_9_16');
      const routing = schema.schema.properties.concepts.items.properties.routing;
      assert.ok('panelTreatment' in routing.properties);
      assert.ok(routing.required.includes('panelTreatment'));
    });

    ok('flag ON but a PMax IMAGE format never offers panelTreatment (video-only field)', () => {
      process.env.PMAX_SPLIT_VIDEO = 'true';
      const schema = buildResponseSchemaRound([{ mediaId: 'm1' }], 'pmax_square_1_1');
      const routing = schema.schema.properties.concepts.items.properties.routing;
      assert.ok(!('panelTreatment' in routing.properties), 'PMax IMAGE schema must not offer panelTreatment');
      assert.ok(!routing.required.includes('panelTreatment'));
    });

    ok('flag ON but a Meta format never offers panelTreatment (PMax-only field)', () => {
      process.env.PMAX_SPLIT_VIDEO = 'true';
      const schema = buildResponseSchemaRound([{ mediaId: 'm1' }], 'meta_feed_1_1');
      const routing = schema.schema.properties.concepts.items.properties.routing;
      assert.ok(!('panelTreatment' in routing.properties), 'Meta schema must not offer panelTreatment');
    });
  } finally {
    process.env.PMAX_SPLIT_VIDEO = prior;
  }
}

// ── report ────────────────────────────────────────────────────────────

console.log(`\n✅ verifyPmaxSplitSide: ${checks}/${checks} checks passed`);

/*
 * REVERT-PROVE (run manually, do not leave applied):
 *   In services/pmaxSplitStrategy.js, comment out the dead-zone `return`
 *   block inside chooseSubjectSide (the block starting
 *   `if (centroidX >= deadZoneLo && centroidX <= deadZoneHi) {`).
 *   Re-run: node scripts/verifyPmaxSplitSide.js
 *   Section C fails (centroid 0.50 / 0.45 / 0.55 all resolve a side instead
 *   of deferring). Restore the block and the suite goes green again.
 */
