#!/usr/bin/env node
/**
 * Offline harness: Director private reasoning must never reach image/HTML models.
 * No DB, no network, no API key.
 *
 * THE DEFECT THIS EXISTS TO CATCH (2026-08-01, live on gpt-image-2):
 *
 *   conceptLook() fell through `concept.art_direction || concept.rationale`,
 *   but art_direction was NEVER emitted by any Director schema. The arm was
 *   taken 100% of the time. A real render told the image model:
 *
 *     "The brand's world is: No proof signal exists (no rating, no quote), so
 *      per the honesty rule this concept leans on bold brand-voice typography
 *      rather than fabricated testimonial energy"
 *
 *   The Director had correctly REFUSED to fabricate a testimonial; its
 *   refusal text became the art brief. emotional_hook (purchase objection)
 *   and permanently-null visual_style were concatenated in too.
 *
 * WHAT IS COVERED:
 *   Q1  artDirectionLook returns null for rationale-only /
 *       emotional_hook-only concepts (the exact live shape).
 *   Q2  A v3 concept with real art_direction.look DOES surface it.
 *   Q3  renderableCopy dual-reads v2 copy_picks and v3 copy.
 *   Q4  conceptForRender has no reasoning/rationale at any depth.
 *   Q5  The 2026-08-01 string cannot appear in a staticAdIntents prompt
 *       built from a concept whose rationale carries it.
 *   Q6  Source scan of image/HTML prompt builders fails if they reference
 *       rationale/reasoning (allowlist: aiJudgeService, Director itself,
 *       conceptProjection comments that cite the defect).
 *
 * REVERT-PROVABLE: restoring a rationale fallthrough in artDirectionLook
 * must fail Q1 and Q5. Verified under /tmp during the land of this harness.
 *
 * REMOVED (dormant render fallback deletion): every check that drove
 * `conceptLook` / `buildIntentData` on
 * `services/directImageRenderService.js`. Those functions were deleted
 * with `renderDirectImage`; adgen owns static rendering unconditionally
 * now. Q1/Q2/Q5 keep the live half via `conceptProjection.artDirectionLook`
 * and `staticAdIntents.buildPrompt` with a hand-built data fixture.
 *
 * Run: node scripts/verifyDirectorQuarantine.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const projection = require('../services/conceptProjection');
const intents = require('../services/staticAdIntents');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

// The exact live shape: Director correctly refused proof fabrication; only
// private reasoning fields are set. No art_direction.
const LIVE_RATIONALE =
  'No proof signal exists (no rating, no quote), so per the honesty rule ' +
  'this concept leans on bold brand-voice typography rather than fabricated ' +
  'testimonial energy';

const LIVE_CONCEPT = {
  concept_id: 'live-2026-08-01',
  name: 'Honesty-led type',
  archetype: 'typographic_dominant',
  emotional_hook: 'fit certainty',
  social_proof_type: 'none',
  copy_picks: {
    headline: 'Built for the long season',
    subheadline: null,
    eyebrow: null,
    cta: 'SHOP NOW'
  },
  rationale: LIVE_RATIONALE
  // no art_direction — the permanent pre-fix state of every concept
};

// ── Q1: reasoning-only concepts yield null look ─────────────────────────
{
  const lookLive = projection.artDirectionLook(LIVE_CONCEPT);
  check(
    'Q1 artDirectionLook returns null for live rationale+emotional_hook shape',
    lookLive === null,
    `got ${JSON.stringify(lookLive)}`
  );

  const lookRationaleOnly = projection.artDirectionLook({ rationale: LIVE_RATIONALE });
  check(
    'Q1 artDirectionLook returns null for rationale-only concept',
    lookRationaleOnly === null,
    `got ${JSON.stringify(lookRationaleOnly)}`
  );

  const lookHookOnly = projection.artDirectionLook({ emotional_hook: 'worth the price' });
  check(
    'Q1 artDirectionLook returns null for emotional_hook-only concept',
    lookHookOnly === null,
    `got ${JSON.stringify(lookHookOnly)}`
  );
}

// ── Q2: real art_direction surfaces ─────────────────────────────────────
{
  const nested = {
    art_direction: {
      look: 'high-contrast athletic editorial, cool concrete grey',
      palette_hint: 'charcoal + acid volt-green accent',
      typography_hint: 'bold condensed sans'
    }
  };
  const lookNested = projection.artDirectionLook(nested);
  check(
    'Q2 v3 nested art_direction.look is returned',
    typeof lookNested === 'string' && lookNested.includes('athletic editorial'),
    `got ${JSON.stringify(lookNested)}`
  );
  check(
    'Q2 nested look also carries palette/typography hints',
    lookNested.includes('charcoal') && lookNested.includes('condensed'),
    `got ${JSON.stringify(lookNested)}`
  );

  const bare = { art_direction: 'raw gym light, sweat on concrete' };
  const lookBare = projection.artDirectionLook(bare);
  check(
    'Q2 bare legacy art_direction string is returned',
    lookBare === 'raw gym light, sweat on concrete',
    `got ${JSON.stringify(lookBare)}`
  );

  const nullArt = { art_direction: null, rationale: LIVE_RATIONALE };
  check(
    'Q2 explicit null art_direction stays null even with rationale present',
    projection.artDirectionLook(nullArt) === null
  );
}

// ── Q3: renderableCopy dual-reads v2 and v3 ──────────────────────────────
{
  const v2 = {
    copy_picks: {
      headline: 'V2 HEADLINE',
      subheadline: 'V2 sub',
      eyebrow: 'NEW',
      cta: 'SHOP'
    }
  };
  const fromV2 = projection.renderableCopy(v2);
  check('Q3 v2 copy_picks.headline', fromV2.headline === 'V2 HEADLINE');
  check('Q3 v2 copy_picks.subheadline', fromV2.subheadline === 'V2 sub');
  check('Q3 v2 copy_picks.eyebrow', fromV2.eyebrow === 'NEW');
  check('Q3 v2 copy_picks.cta', fromV2.cta === 'SHOP');

  const v3 = {
    copy: {
      headline: 'V3 HEADLINE',
      subheadline: 'V3 sub',
      eyebrow: null,
      cta: 'BUY'
    }
  };
  const fromV3 = projection.renderableCopy(v3);
  check('Q3 v3 copy.headline', fromV3.headline === 'V3 HEADLINE');
  check('Q3 v3 copy.subheadline', fromV3.subheadline === 'V3 sub');
  check('Q3 v3 copy.eyebrow null stays null', fromV3.eyebrow === null);
  check('Q3 v3 copy.cta', fromV3.cta === 'BUY');

  // v3 wins when both present (new shape is authoritative).
  const both = {
    copy: { headline: 'V3', subheadline: null, eyebrow: null, cta: null },
    copy_picks: { headline: 'V2', subheadline: null, eyebrow: null, cta: null }
  };
  check(
    'Q3 when both present, copy (v3) wins',
    projection.renderableCopy(both).headline === 'V3',
    `got ${JSON.stringify(projection.renderableCopy(both))}`
  );
  // The former "buildIntentData dual-reads via renderableCopy" pin was
  // removed with `renderDirectImage`/`buildIntentData` (dormant render
  // fallback deletion, 2026-09-07). renderableCopy itself (above) is the
  // remaining dual-read coverage.
}

// ── Q4: conceptForRender never exposes reasoning ─────────────────────────
{
  const raw = {
    concept_id: 'x',
    name: 'X',
    archetype: 'full_bleed_hero_bottom_panel',
    emotional_hook: 'fit certainty',
    rationale: LIVE_RATIONALE,
    reasoning: { rationale: LIVE_RATIONALE },
    copy_picks: { headline: 'H', subheadline: null, eyebrow: null, cta: 'GO' },
    art_direction: { look: 'soft daylight', palette_hint: null, typography_hint: null }
  };
  const projected = projection.conceptForRender(raw);

  function hasReasoningKey(obj, path = '') {
    if (!obj || typeof obj !== 'object') return null;
    for (const [k, v] of Object.entries(obj)) {
      const p = path ? `${path}.${k}` : k;
      if (k === 'rationale' || k === 'reasoning') return p;
      if (v && typeof v === 'object') {
        const hit = hasReasoningKey(v, p);
        if (hit) return hit;
      }
    }
    return null;
  }

  const hit = hasReasoningKey(projected);
  check(
    'Q4 conceptForRender has no rationale/reasoning at any depth',
    hit === null,
    `found at ${hit}`
  );

  // Serialized form must not contain the leak string either.
  const serialized = JSON.stringify(projected);
  check(
    'Q4 projected JSON does not contain the live rationale string',
    !serialized.includes('No proof signal exists'),
    'rationale leaked into projected serialization'
  );

  check(
    'Q4 projected still carries strategy fields needed by render',
    projected.archetype === 'full_bleed_hero_bottom_panel' &&
      projected.emotional_hook === 'fit certainty' &&
      projected.copy_picks.headline === 'H',
    `got ${JSON.stringify(projected)}`
  );

  check(
    'Q4 projected art_direction is look-only safe form',
    projected.art_direction && projected.art_direction.look === 'soft daylight',
    `got ${JSON.stringify(projected.art_direction)}`
  );

  // Nested v3 routing dual-reads.
  const v3raw = {
    concept_id: 'v3',
    name: 'Nested',
    routing: {
      archetype: 'magazine_editorial',
      emotional_hook: 'worth the price',
      creative_style: 'editorial',
      media_picks: [{ media_id: 'm1', role: 'hero', notes: null }],
      output_shape: { format: 'static_single', tile_count: 1 }
    },
    copy: { headline: 'NESTED', subheadline: null, eyebrow: null, cta: null },
    art_direction: null,
    reasoning: { rationale: LIVE_RATIONALE }
  };
  const v3proj = projection.conceptForRender(v3raw);
  check('Q4 v3 routing.archetype flattens', v3proj.archetype === 'magazine_editorial');
  check('Q4 v3 copy dual-reads', v3proj.copy.headline === 'NESTED' && v3proj.copy_picks.headline === 'NESTED');
  check('Q4 v3 reasoning stripped', hasReasoningKey(v3proj) === null);
  check('Q4 v3 null art_direction stays null', v3proj.art_direction === null);
}

// ── Q5: live string never appears in a built image prompt ────────────────
{
  const look = projection.artDirectionLook(LIVE_CONCEPT);
  check('Q5 look is null for live concept (precondition for prompt omit)', look === null);

  const intentData = {
    headline: LIVE_CONCEPT.copy_picks.headline,
    cta: LIVE_CONCEPT.copy_picks.cta
  };
  const built = intents.buildPrompt({
    intentKey: 'product_first_lifestyle',
    data: intentData,
    product: {
      desc: 'seamless training top in heather grey-blue',
      look, // null — the sentence must be omitted
      logoCorner: 'bottom-right'
    },
    surface: 'meta_feed_1_1'
  });

  check('Q5 prompt built successfully', !!(built && built.prompt), built && built.error);
  if (built && built.prompt) {
    check(
      'Q5 prompt does not contain "No proof signal exists"',
      !built.prompt.includes('No proof signal exists'),
      'live leak string present in prompt'
    );
    check(
      'Q5 prompt does not contain "honesty rule"',
      !built.prompt.includes('honesty rule'),
      'honesty-rule note present in prompt'
    );
    check(
      'Q5 prompt does not contain "The brand\'s world is"',
      !built.prompt.includes("The brand's world is"),
      'brand-world sentence present despite null look'
    );
    check(
      'Q5 prompt still carries the real headline',
      built.prompt.includes('Built for the long season'),
      'headline missing — dual-read may have broken'
    );
  }

  // Also: if someone DID pass rationale as look, the harness of the
  // projection layer is what must stop it — not staticAdIntents. Confirm
  // the omit-when-null path is what we rely on, not a string filter.
  const withForcedLook = intents.buildPrompt({
    intentKey: 'product_first_lifestyle',
    data: intentData,
    product: {
      desc: 'seamless training top',
      look: LIVE_RATIONALE, // forced — proves the omit gate is look-null, not content filter
      logoCorner: 'bottom-right'
    },
    surface: 'meta_feed_1_1'
  });
  check(
    'Q5 (control) when look is forced to rationale, prompt WOULD contain it — so Q5 depends on artDirectionLook null',
    !!(withForcedLook.prompt && withForcedLook.prompt.includes('No proof signal exists')),
    'control failed — cannot prove quarantine is at the look source'
  );
}

// ── Q6: source scan of image/HTML prompt builders ────────────────────────
//
// Fail if these files reference concept.rationale / reasoning.rationale in
// CODE that could feed a prompt. Comments that cite the defect are fine
// after strip; allowlist the Judge (intended reader) and the Director
// (emitter) and conceptProjection (which documents the ban).
{
  const ROOT = path.join(__dirname, '..');
  const SCAN = [
    'services/directImageRenderService.js',
    'services/aiImageReferenceService.js',
    'services/aiCanvasHtmlGeneratorService.js',
    'services/aiCanvasSpecService.js',
    'services/conceptProjection.js',
    'services/staticAdIntents.js'
  ];
  // Patterns that mean "this path is feeding rationale into a prompt".
  // Deliberately narrow: a comment saying "never rationale" is not a leak.
  // After stripping comments/strings, these identifiers in code are the risk.
  const LEAK_RE = [
    /concept\s*\?\.\s*rationale/,
    /concept\s*\.\s*rationale/,
    /directionConcept\s*\.\s*rationale/,
    /directionConcept\s*\?\.\s*rationale/,
    /\|\|\s*concept\s*\?\.\s*rationale/,
    /\|\|\s*concept\s*\.\s*rationale/,
    /reasoning\s*\.\s*rationale/,
    /Rationale:\s*\$\{/,
    /rationale:\s*concept\./,
    /rationale:\s*directionConcept\./
  ];

  function stripCommentsAndStrings(src) {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
      .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')
      .replace(/'(?:\\.|[^'\\])*'/g, "''")
      .replace(/"(?:\\.|[^"\\])*"/g, '""');
  }

  for (const rel of SCAN) {
    const full = path.join(ROOT, rel);
    const src = fs.readFileSync(full, 'utf8');
    const code = stripCommentsAndStrings(src);
    for (const re of LEAK_RE) {
      const m = code.match(re);
      // conceptProjection may mention the ban in code only as a no-op; it
      // must not READ concept.rationale into a return value. The patterns
      // above would fire if it did `concept?.rationale` in code.
      check(
        `Q6 ${rel} has no prompt-bound rationale read (${re})`,
        !m,
        m ? `matched ${m[0]}` : ''
      );
    }
  }

  // conceptLook was deleted with renderDirectImage (dormant render fallback
  // deletion, 2026-09-07). Pin the absence so a reintroduction of the
  // 2026-08-01 fallthrough cannot hide as a new helper in this file.
  const directSrc = fs.readFileSync(
    path.join(ROOT, 'services/directImageRenderService.js'),
    'utf8'
  );
  check('Q6 conceptLook is absent from directImageRenderService (deleted with renderDirectImage)',
    directSrc.indexOf('function conceptLook') < 0);

  // Allowlist sanity: Judge and Director DO reference rationale — if they
  // stopped, something else is wrong, but we do not fail the quarantine.
  const judgeSrc = fs.readFileSync(
    path.join(ROOT, 'services/aiJudgeService.js'),
    'utf8'
  );
  check(
    'Q6 (allowlist) aiJudgeService still reads rationale (intended reader)',
    /rationale/.test(judgeSrc)
  );
  const directorSrc = fs.readFileSync(
    path.join(ROOT, 'services/aiCreativeDirectorService.js'),
    'utf8'
  );
  check(
    'Q6 (allowlist) Director still emits reasoning.rationale',
    /reasoning/.test(directorSrc) && /rationale/.test(directorSrc)
  );
}

// ── Q7: Director prompt carries structural quarantine rules ─────────────
{
  const director = require('../services/aiCreativeDirectorService');
  const result = director.buildPromptRound({
    inputSummary: { product_signal: { name: 'Test Tee' } },
    creativeIntent: null,
    platformFormat: 'meta_feed_1_1',
    universe: [{ mediaId: 'm1', role: 'hero', fileType: 'image', metadata: {} }],
    roundIndex: 0,
    avoidList: []
  });
  check(
    'Q7 Director system names copy as the only letterforms',
    /ONLY strings that may appear as letterforms/i.test(result.system),
    'STRUCTURAL RULE missing'
  );
  check(
    'Q7 Director system says art_direction MUST be null when no visual brief',
    /art_direction[\s\S]{0,80}MUST be null/i.test(result.system) ||
      /MUST be null when you have no visual brief/i.test(result.system),
    'null-when-absent rule missing'
  );
  check(
    'Q7 Director system says reasoning.rationale is PRIVATE',
    /reasoning\.rationale is PRIVATE/i.test(result.system)
  );
  check(
    'Q7 Director system forbids honesty notes in art_direction',
    /never put honesty-rule notes/i.test(result.system) ||
      /NEVER put honesty-rule notes/i.test(result.system)
  );

  const schema = director.buildResponseSchemaRound(
    [{ mediaId: 'm1' }],
    'meta_feed_1_1'
  );
  const itemProps = schema.schema.properties.concepts.items.properties;
  check('Q7 schema has nested routing', !!(itemProps.routing && itemProps.routing.properties));
  check('Q7 schema has nested copy', !!(itemProps.copy && itemProps.copy.properties));
  check('Q7 schema has art_direction', 'art_direction' in itemProps);
  check('Q7 schema has reasoning', !!(itemProps.reasoning && itemProps.reasoning.properties.rationale));
  check('Q7 schema does NOT have flat copy_picks on concept', !('copy_picks' in itemProps));
  check('Q7 schema does NOT have flat rationale on concept', !('rationale' in itemProps));
}

if (failures.length) {
  console.error(`\n❌ director quarantine: ${failures.length} FAILED, ${pass} passed\n`);
  failures.forEach((f) => console.error(`   • ${f}`));
  process.exit(1);
}
console.log(`✅ director quarantine: ${pass} checks passed`);
console.log('   scope: artDirectionLook null-on-reasoning, dual-read copy, conceptForRender strip, prompt omit, source scan, Director v3 schema');
