#!/usr/bin/env node
'use strict';
/**
 * verifySeedClass — fences resolveSeedClass / isStudioSceneLabel /
 * isSeedClassSceneBased (services/imageShotHeuristicService). Fully
 * offline: no DB, no network, no API key, no sharp.
 *
 * WHY THIS EXISTS
 * resolveSeedStyle maps LLM shotType {lifestyle, on_model} → 'lifestyle'.
 * That broad mapping treated studio on-figure catalog shots as lifestyle
 * scenes and caused the video regression that PR #152 then scoped to
 * ugc-only. Owner: lifestyle means A REAL ENVIRONMENT. resolveSeedClass
 * splits the bucket using Media.background.sceneType (anchored studio
 * vocabulary + equipment regex) or background.setting (closed enum) via
 * sceneVerdict → 'plain'|'scene'|'absent'.
 *
 * POST-REVIEW CONTRACT (do not regress):
 *   - STUDIO_SCENE_RE is ANCHORED whole-label (optional photography
 *     prefix, optional survey suffix). Substring "studio"/"backdrop"
 *     is a false-positive factory (Yoga Studio, mountain backdrop).
 *   - setting is a CLOSED ENUM, not free text. product-shot-on-solid
 *     is plain; other/unknown → absent (per-shotType fallback).
 *   - seedClassForVideo is REMOVED (dual-meaning token trap). Call
 *     sites gate: isSeedClassSceneBased() && resolveSeedClass(media)
 *     === 'lifestyle_scene'. Flag does not change resolveSeedClass.
 *
 * Fences:
 *   A*  packshot family (rule 1) — all four shotTypes, scene ignored
 *   B*  studio fixtures (survey + equipment) → plain / on_figure_plain
 *   C*  real environments + FALSE-POSITIVE labels → lifestyle_scene
 *   D*  scene-absent fallbacks (lifestyle → lifestyle_scene,
 *       on_model → on_figure_plain)
 *   E*  setting closed enum (all 7 values) + sceneType precedence
 *   F*  no usable shotType → heuristic (rule 3); ambiguous → unknown
 *   G*  casing + whitespace on scene strings and setting enum
 *   H*  Mixed-field weirdness — never throws; fixtures exercise scene
 *       parsing, not just shotType fallback
 *   I*  background missing entirely
 *   J*  flag does not change resolveSeedClass; caller-gate stub
 *   K*  resolveSeedStyle behaviour unchanged (zero regression pin)
 *   L*  no existing call site wired (zero behaviour change)
 *   R*  revert-prove — four mutations applied to a temp copy
 *
 *   node scripts/verifySeedClass.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SVC_REL = path.join('services', 'imageShotHeuristicService.js');
const SVC_PATH = path.join(__dirname, '..', SVC_REL);
const SRC = fs.readFileSync(SVC_PATH, 'utf8');

const heuristic = require('../services/imageShotHeuristicService');
const {
  resolveSeedClass,
  resolveSeedStyle,
  isSeedClassSceneBased,
  isStudioSceneLabel,
  STUDIO_SCENE_RE
} = heuristic;

let pass = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) { pass++; return true; }
  failures.push(detail ? `${label}: ${detail}` : label);
  return false;
}
function checkFn(label, fn) {
  try { fn(); pass++; return true; }
  catch (err) { failures.push(`${label}: ${err.message}`); return false; }
}

function media(shotType, extra) {
  const m = {};
  if (shotType !== undefined) m.classification = { shotType };
  return Object.assign(m, extra || {});
}

// The only supported call-site pattern. seedClassForVideo is gone — a
// helper that returned 'lifestyle_scene' for every on_model seed while
// the flag was off made the same token mean the opposite thing.
function gatedLifestyleScene(m) {
  return isSeedClassSceneBased() && resolveSeedClass(m) === 'lifestyle_scene';
}

// ── Fixtures ───────────────────────────────────────────────────────────────
// Survey photography-studio vocabulary. Must hit the ANCHORED pattern.
const STUDIO_SURVEY = [
  'Studio',
  'Fashion Studio',
  'Studio Portrait',
  'Apparel Studio',
  'Studio Still Life',
  'Studio Close-Up',
  'Studio Comparison',
  'Studio Minimal',
  'Studio Beauty',
  // Beauty Studio: first reading of "prefix rule" looks like → scene.
  // The anchored pattern's prefix set IS (fashion|apparel|beauty|photo(graphy)?),
  // so 'beauty studio' matches and is PLAIN. Pin what the regex actually does.
  'Beauty Studio',
  'Studio Interior',
  'Studio Floral'
];
// Equipment: STUDIO_EQUIPMENT_RE, not STUDIO_SCENE_RE.
const STUDIO_EQUIPMENT = [
  'Seamless backdrop',
  'Cyclorama',
  'Backdrop',
  'studio backdrop'
];
// Adversarial false positives — substring "studio"/"backdrop" must NOT
// classify these as photography studios. They are real venues / scenery.
const FALSE_POSITIVE = [
  'Yoga Studio',
  'Pilates Studio',
  'Dance Studio',
  'Recording Studio interior',
  'Art Studio loft',
  'Studio Apartment',
  'mountain backdrop',
  'city backdrop',
  'non-studio kitchen',
  'Fitness Studio'
];
const REAL_SURVEY = [
  'Urban Street',
  'Open Ocean',
  'Beach',
  'Living Room',
  'Outdoor Patio',
  'Boat Deck',
  'Desert Dunes',
  'Gym Interior',
  'Mediterranean Interior',
  'Minimalist Indoor',
  'Home Interior'
];
// background.setting closed enum from subjectTextService.
// plain={studio, product-shot-on-solid, abstract}
// scene={outdoor, lifestyle, indoor}
// other / unknown → absent (per-shotType fallback)
const SETTING_ENUM = [
  ['studio', 'plain'],
  ['product-shot-on-solid', 'plain'],
  ['abstract', 'plain'],
  ['outdoor', 'scene'],
  ['lifestyle', 'scene'],
  ['indoor', 'scene'],
  ['other', 'absent']
];
const PACKSHOT_TYPES = ['product_only', 'flat_lay', 'detail', 'packaging'];
const CLASSES = new Set(['lifestyle_scene', 'on_figure_plain', 'packshot', 'unknown']);

function classForVerdict(shotType, verdict) {
  if (verdict === 'plain') return 'on_figure_plain';
  if (verdict === 'scene') return 'lifestyle_scene';
  return shotType === 'lifestyle' ? 'lifestyle_scene' : 'on_figure_plain';
}

const ORIG_FLAG = process.env.SEED_CLASS_SCENE_BASED;
function setFlag(val) {
  if (val === undefined) delete process.env.SEED_CLASS_SCENE_BASED;
  else process.env.SEED_CLASS_SCENE_BASED = val;
}
function restoreFlag() {
  if (ORIG_FLAG === undefined) delete process.env.SEED_CLASS_SCENE_BASED;
  else process.env.SEED_CLASS_SCENE_BASED = ORIG_FLAG;
}

console.log('\nverifySeedClass — scene-based lifestyle classifier (post-review)\n');

// ── A. packshot family (rule 1) ────────────────────────────────────────────
console.log('A. packshot family (rule 1)');
for (const st of PACKSHOT_TYPES) {
  checkFn(`A1 ${st} → packshot`, () => {
    assert.strictEqual(resolveSeedClass(media(st)), 'packshot');
  });
  checkFn(`A2 ${st} + Beach scene still packshot (scene ignored)`, () => {
    assert.strictEqual(resolveSeedClass(media(st, {
      background: { sceneType: 'Beach' }
    })), 'packshot');
  });
  checkFn(`A3 ${st} + Studio scene still packshot`, () => {
    assert.strictEqual(resolveSeedClass(media(st, {
      background: { sceneType: 'Studio' }
    })), 'packshot');
  });
}

// ── B. studio fixtures (anchored survey + equipment) ───────────────────────
console.log('B. studio fixtures (anchored regex + equipment)');
check('B0 STUDIO_SCENE_RE is an anchored, case-insensitive RegExp',
  STUDIO_SCENE_RE instanceof RegExp
  && STUDIO_SCENE_RE.ignoreCase
  && STUDIO_SCENE_RE.source.startsWith('^')
  && STUDIO_SCENE_RE.source.endsWith('$'));
check('B0b STUDIO_SCENE_RE matches Studio and rejects Yoga Studio',
  STUDIO_SCENE_RE.test('Studio')
  && STUDIO_SCENE_RE.test('Fashion Studio')
  && STUDIO_SCENE_RE.test('Beauty Studio')
  && !STUDIO_SCENE_RE.test('Yoga Studio')
  && !STUDIO_SCENE_RE.test('Studio Apartment')
  && !STUDIO_SCENE_RE.test('mountain backdrop'));
check('B0c ≥8 studio survey values enumerated', STUDIO_SURVEY.length >= 8);
check('B0d isStudioSceneLabel is exported; seedClassForVideo is not',
  typeof isStudioSceneLabel === 'function'
  && heuristic.seedClassForVideo === undefined);
check('B0e empty / null / whitespace labels are not studio',
  isStudioSceneLabel('') === false
  && isStudioSceneLabel(null) === false
  && isStudioSceneLabel(undefined) === false
  && isStudioSceneLabel('   ') === false);
// Equipment is a separate regex — STUDIO_SCENE_RE must not claim them.
check('B0f equipment labels match isStudioSceneLabel, not STUDIO_SCENE_RE',
  STUDIO_EQUIPMENT.every((s) => !STUDIO_SCENE_RE.test(s) && isStudioSceneLabel(s)));
check('B0g Beauty Studio is PLAIN — beauty is an allowed prefix, not an environment',
  isStudioSceneLabel('Beauty Studio') === true
  && isStudioSceneLabel('Studio Beauty') === true);

for (const scene of STUDIO_SURVEY) {
  check(`B1 isStudioSceneLabel('${scene}')`, isStudioSceneLabel(scene) === true);
  checkFn(`B1 on_model|${scene} → on_figure_plain`, () => {
    assert.strictEqual(resolveSeedClass(media('on_model', {
      background: { sceneType: scene }
    })), 'on_figure_plain');
  });
  checkFn(`B2 lifestyle|${scene} → on_figure_plain (label sits on studio too)`, () => {
    assert.strictEqual(resolveSeedClass(media('lifestyle', {
      background: { sceneType: scene }
    })), 'on_figure_plain');
  });
}
for (const scene of STUDIO_EQUIPMENT) {
  check(`B3 isStudioSceneLabel('${scene}')`, isStudioSceneLabel(scene) === true);
  checkFn(`B3 on_model|${scene} → on_figure_plain`, () => {
    assert.strictEqual(resolveSeedClass(media('on_model', {
      background: { sceneType: scene }
    })), 'on_figure_plain');
  });
  checkFn(`B3 lifestyle|${scene} → on_figure_plain`, () => {
    assert.strictEqual(resolveSeedClass(media('lifestyle', {
      background: { sceneType: scene }
    })), 'on_figure_plain');
  });
}
// Prefix / suffix arms that the survey list does not name.
for (const scene of ['Photo Studio', 'Photography Studio', 'Studio Shot', 'Studio Scene', 'Studio Set']) {
  checkFn(`B4 prefix/suffix arm '${scene}' → on_figure_plain`, () => {
    assert.ok(isStudioSceneLabel(scene), `isStudioSceneLabel('${scene}')`);
    assert.strictEqual(resolveSeedClass(media('on_model', {
      background: { sceneType: scene }
    })), 'on_figure_plain');
  });
}

// ── C. real environments + false-positive labels (rule 2) ──────────────────
console.log('C. real-environment + false-positive labels');
for (const scene of REAL_SURVEY) {
  checkFn(`C1 on_model|${scene} → lifestyle_scene`, () => {
    assert.strictEqual(resolveSeedClass(media('on_model', {
      background: { sceneType: scene }
    })), 'lifestyle_scene');
  });
  checkFn(`C2 lifestyle|${scene} → lifestyle_scene`, () => {
    assert.strictEqual(resolveSeedClass(media('lifestyle', {
      background: { sceneType: scene }
    })), 'lifestyle_scene');
  });
}
for (const scene of FALSE_POSITIVE) {
  check(`C3 isStudioSceneLabel('${scene}') is false`, isStudioSceneLabel(scene) === false);
  checkFn(`C3 on_model|${scene} → lifestyle_scene (substring must not match)`, () => {
    assert.strictEqual(resolveSeedClass(media('on_model', {
      background: { sceneType: scene }
    })), 'lifestyle_scene');
  });
  checkFn(`C4 lifestyle|${scene} → lifestyle_scene`, () => {
    assert.strictEqual(resolveSeedClass(media('lifestyle', {
      background: { sceneType: scene }
    })), 'lifestyle_scene');
  });
}
// Equipment regex is not a bare "backdrop" substring.
checkFn("C5 paper backdrop is scenery, not equipment", () => {
  assert.strictEqual(isStudioSceneLabel('paper backdrop'), false);
  assert.strictEqual(resolveSeedClass(media('on_model', {
    background: { sceneType: 'paper backdrop' }
  })), 'lifestyle_scene');
});

// ── D. scene-absent fallbacks (rule 2) ─────────────────────────────────────
console.log('D. scene-absent fallbacks');
checkFn('D1 lifestyle + no background → lifestyle_scene', () => {
  assert.strictEqual(resolveSeedClass(media('lifestyle')), 'lifestyle_scene');
});
checkFn('D2 on_model + no background → on_figure_plain', () => {
  assert.strictEqual(resolveSeedClass(media('on_model')), 'on_figure_plain');
});
checkFn('D3 lifestyle + empty background {} → lifestyle_scene', () => {
  assert.strictEqual(resolveSeedClass(media('lifestyle', {
    background: {}
  })), 'lifestyle_scene');
});
checkFn('D4 on_model + empty background {} → on_figure_plain', () => {
  assert.strictEqual(resolveSeedClass(media('on_model', {
    background: {}
  })), 'on_figure_plain');
});
checkFn('D5 lifestyle + whitespace-only sceneType → lifestyle_scene', () => {
  assert.strictEqual(resolveSeedClass(media('lifestyle', {
    background: { sceneType: '   ' }
  })), 'lifestyle_scene');
});
checkFn('D6 on_model + whitespace-only sceneType/setting → on_figure_plain', () => {
  assert.strictEqual(resolveSeedClass(media('on_model', {
    background: { sceneType: '\t', setting: '  ' }
  })), 'on_figure_plain');
});

// ── E. setting closed enum + sceneType precedence ──────────────────────────
console.log('E. setting closed enum vs sceneType');
for (const [value, verdict] of SETTING_ENUM) {
  const onModel = classForVerdict('on_model', verdict);
  const life = classForVerdict('lifestyle', verdict);
  checkFn(`E1 on_model + setting ${value} (${verdict}) → ${onModel}`, () => {
    assert.strictEqual(resolveSeedClass(media('on_model', {
      background: { setting: value }
    })), onModel);
  });
  checkFn(`E1 lifestyle + setting ${value} (${verdict}) → ${life}`, () => {
    assert.strictEqual(resolveSeedClass(media('lifestyle', {
      background: { setting: value }
    })), life);
  });
}
// The load-bearing closed-enum pins called out in review.
checkFn('E2 lifestyle + product-shot-on-solid → on_figure_plain (not a scene string)', () => {
  assert.strictEqual(resolveSeedClass(media('lifestyle', {
    background: { setting: 'product-shot-on-solid' }
  })), 'on_figure_plain');
});
checkFn('E3 lifestyle + indoor → lifestyle_scene', () => {
  assert.strictEqual(resolveSeedClass(media('lifestyle', {
    background: { setting: 'indoor' }
  })), 'lifestyle_scene');
});
checkFn('E4 lifestyle + other → lifestyle_scene (absent → lifestyle fallback)', () => {
  assert.strictEqual(resolveSeedClass(media('lifestyle', {
    background: { setting: 'other' }
  })), 'lifestyle_scene');
});
checkFn('E5 on_model + other → on_figure_plain (absent → on_model fallback)', () => {
  assert.strictEqual(resolveSeedClass(media('on_model', {
    background: { setting: 'other' }
  })), 'on_figure_plain');
});
checkFn('E6 unknown setting Urban Street + on_model → on_figure_plain (absent, not scene)', () => {
  assert.strictEqual(resolveSeedClass(media('on_model', {
    background: { setting: 'Urban Street' }
  })), 'on_figure_plain');
});
checkFn('E7 unknown setting Urban Street + lifestyle → lifestyle_scene (absent, not plain)', () => {
  assert.strictEqual(resolveSeedClass(media('lifestyle', {
    background: { setting: 'Urban Street' }
  })), 'lifestyle_scene');
});
checkFn('E8 sceneType Beach wins over setting studio', () => {
  assert.strictEqual(resolveSeedClass(media('on_model', {
    background: { sceneType: 'Beach', setting: 'studio' }
  })), 'lifestyle_scene');
});
checkFn('E9 sceneType Studio wins over setting outdoor', () => {
  assert.strictEqual(resolveSeedClass(media('lifestyle', {
    background: { sceneType: 'Studio', setting: 'outdoor' }
  })), 'on_figure_plain');
});
checkFn('E10 empty sceneType falls through to setting indoor', () => {
  assert.strictEqual(resolveSeedClass(media('on_model', {
    background: { sceneType: '', setting: 'indoor' }
  })), 'lifestyle_scene');
});
checkFn('E11 empty sceneType falls through to setting product-shot-on-solid', () => {
  assert.strictEqual(resolveSeedClass(media('lifestyle', {
    background: { sceneType: '', setting: 'product-shot-on-solid' }
  })), 'on_figure_plain');
});

// ── F. heuristic fallback (rule 3) ─────────────────────────────────────────
console.log('F. no usable shotType → heuristic');
checkFn('F1 no shotType + shotStyle lifestyle → lifestyle_scene', () => {
  assert.strictEqual(resolveSeedClass({
    technicalInsights: { shotStyle: 'lifestyle' }
  }), 'lifestyle_scene');
});
checkFn('F2 no shotType + shotStyle packshot → packshot', () => {
  assert.strictEqual(resolveSeedClass({
    technicalInsights: { shotStyle: 'packshot' }
  }), 'packshot');
});
checkFn('F3 no shotType + shotStyle ambiguous → unknown', () => {
  assert.strictEqual(resolveSeedClass({
    technicalInsights: { shotStyle: 'ambiguous' }
  }), 'unknown');
});
checkFn('F4 shotType unknown + shotStyle lifestyle → lifestyle_scene', () => {
  assert.strictEqual(resolveSeedClass(media('unknown', {
    technicalInsights: { shotStyle: 'lifestyle' }
  })), 'lifestyle_scene');
});
checkFn('F5 unrecognised shotType + shotStyle packshot → packshot', () => {
  assert.strictEqual(resolveSeedClass(media('collage', {
    technicalInsights: { shotStyle: 'packshot' }
  })), 'packshot');
});
checkFn('F6 neither present → unknown', () => {
  assert.strictEqual(resolveSeedClass({}), 'unknown');
  assert.strictEqual(resolveSeedClass(null), 'unknown');
  assert.strictEqual(resolveSeedClass(undefined), 'unknown');
});
checkFn('F7 LLM packshot wins over heuristic lifestyle', () => {
  assert.strictEqual(resolveSeedClass(media('detail', {
    technicalInsights: { shotStyle: 'lifestyle' }
  })), 'packshot');
});
checkFn('F8 LLM lifestyle + scene wins over heuristic packshot', () => {
  assert.strictEqual(resolveSeedClass(media('lifestyle', {
    background: { sceneType: 'Beach' },
    technicalInsights: { shotStyle: 'packshot' }
  })), 'lifestyle_scene');
});
checkFn('F9 ambiguous heuristic + Studio sceneType still unknown (no scene parse without LLM family)', () => {
  assert.strictEqual(resolveSeedClass({
    technicalInsights: { shotStyle: 'ambiguous' },
    background: { sceneType: 'Studio' }
  }), 'unknown');
});

// ── G. casing ──────────────────────────────────────────────────────────────
console.log('G. casing');
for (const scene of ['STUDIO', 'Studio', 'studio', 'FaShIoN sTuDiO', 'BEAUTY STUDIO']) {
  checkFn(`G1 on_model|${scene} → on_figure_plain (regex /i)`, () => {
    assert.strictEqual(resolveSeedClass(media('on_model', {
      background: { sceneType: scene }
    })), 'on_figure_plain');
  });
}
checkFn('G2 padded "  Studio  " trims → on_figure_plain', () => {
  assert.strictEqual(resolveSeedClass(media('on_model', {
    background: { sceneType: '  Studio  ' }
  })), 'on_figure_plain');
});
checkFn('G3 padded setting "  outdoor  " → lifestyle_scene (enum, not free text)', () => {
  assert.strictEqual(resolveSeedClass(media('on_model', {
    background: { setting: '  outdoor  ' }
  })), 'lifestyle_scene');
});
checkFn('G4 setting enum is case-insensitive (PRODUCT-SHOT-ON-SOLID)', () => {
  assert.strictEqual(resolveSeedClass(media('lifestyle', {
    background: { setting: '  PRODUCT-SHOT-ON-SOLID  ' }
  })), 'on_figure_plain');
});
checkFn('G5 setting Indoor (case) → lifestyle_scene', () => {
  assert.strictEqual(resolveSeedClass(media('on_model', {
    background: { setting: 'Indoor' }
  })), 'lifestyle_scene');
});
checkFn('G6 padded Yoga Studio still a scene (trim + anchor)', () => {
  assert.strictEqual(resolveSeedClass(media('on_model', {
    background: { sceneType: '  Yoga Studio  ' }
  })), 'lifestyle_scene');
});

// ── H. Mixed-field weirdness — never throw; exercise scene parsing ─────────
console.log('H. Mixed-field guards (never throw; non-vacuous scene parse)');
// Vacuous-proof: expected class ≠ what a naive parse of the malformed
// field would produce, AND ≠ (or in addition to) a pair of fixtures
// where setting/sceneType is actually consulted.
const WEIRD = [
  // lifestyle fallback = lifestyle_scene. A wrong parse of 'Studio' → on_figure_plain.
  ['H1 background is a string Studio', media('lifestyle', { background: 'Studio' }), 'lifestyle_scene'],
  ['H2 background is a number', media('lifestyle', { background: 12 }), 'lifestyle_scene'],
  ['H3 background is an array [Studio]', media('lifestyle', { background: ['Studio'] }), 'lifestyle_scene'],
  ['H4 background is null', media('lifestyle', { background: null }), 'lifestyle_scene'],
  // sceneType unusable → absent → lifestyle fallback. Digging into .name → plain.
  ['H5 sceneType is a number', media('lifestyle', { background: { sceneType: 99 } }), 'lifestyle_scene'],
  ['H6 sceneType is an object {name:Studio}', media('lifestyle', { background: { sceneType: { name: 'Studio' } } }), 'lifestyle_scene'],
  // on_model fallback = on_figure_plain. Taking [0] of ['Beach'] → lifestyle_scene.
  ['H7 sceneType is an array [Beach]', media('on_model', { background: { sceneType: ['Beach'] } }), 'on_figure_plain'],
  ['H8 setting is a boolean', media('lifestyle', { background: { setting: true } }), 'lifestyle_scene'],
  ['H9 classification is a string', { classification: 'lifestyle', background: { sceneType: 'Studio' } }, 'unknown'],
  ['H10 media is a string', 'not-media', 'unknown'],
  ['H11 media is a number', 5, 'unknown'],
  ['H12 media is an array', [{ classification: { shotType: 'lifestyle' } }], 'unknown'],
  ['H13 technicalInsights is a string', { technicalInsights: 'lifestyle' }, 'unknown'],
  // Scene parsing MUST still run through setting when sceneType is unusable.
  ['H14 sceneType object + setting studio (setting consulted)', media('lifestyle', {
    background: { sceneType: { name: 'ignored' }, setting: 'studio' }
  }), 'on_figure_plain'],
  ['H15 sceneType array + setting outdoor (setting consulted)', media('on_model', {
    background: { sceneType: ['Beach'], setting: 'outdoor' }
  }), 'lifestyle_scene'],
  ['H16 sceneType number + setting product-shot-on-solid', media('lifestyle', {
    background: { sceneType: 99, setting: 'product-shot-on-solid' }
  }), 'on_figure_plain'],
  // Heuristic ambiguous never becomes a scene class, even with a studio label.
  ['H17 ambiguous heuristic + Studio sceneType → unknown', {
    technicalInsights: { shotStyle: 'ambiguous' },
    background: { sceneType: 'Studio' }
  }, 'unknown'],
  ['H18 ambiguous heuristic + setting outdoor → unknown', {
    technicalInsights: { shotStyle: 'ambiguous' },
    background: { setting: 'outdoor' }
  }, 'unknown']
];
for (const [label, input, expected] of WEIRD) {
  let threw = false;
  let got = 'sentinel';
  try { got = resolveSeedClass(input); }
  catch (err) { threw = true; got = err.message; }
  check(`${label} never throws`, !threw, threw ? `threw: ${got}` : '');
  check(`${label} → ${expected}`, got === expected, `got ${got}`);
}

// ── I. background missing entirely ─────────────────────────────────────────
console.log('I. background missing entirely');
checkFn('I1 lifestyle, no background key → lifestyle_scene', () => {
  assert.strictEqual(resolveSeedClass({
    classification: { shotType: 'lifestyle' }
  }), 'lifestyle_scene');
});
checkFn('I2 on_model, no background key → on_figure_plain', () => {
  assert.strictEqual(resolveSeedClass({
    classification: { shotType: 'on_model' }
  }), 'on_figure_plain');
});
checkFn('I3 return value is always one of the four classes', () => {
  const samples = [
    null, undefined, {}, media('lifestyle'), media('on_model'),
    media('product_only'), media('unknown'),
    media('lifestyle', { background: { sceneType: 'Beach' } }),
    media('on_model', { background: { sceneType: 'Studio' } }),
    media('on_model', { background: { sceneType: 'Yoga Studio' } }),
    media('lifestyle', { background: { setting: 'product-shot-on-solid' } }),
    media('on_model', { background: { setting: 'other' } }),
    { technicalInsights: { shotStyle: 'ambiguous' } }
  ];
  for (const s of samples) {
    const got = resolveSeedClass(s);
    assert.ok(CLASSES.has(got), `unexpected class ${got}`);
  }
});

// ── J. flag does not change resolveSeedClass; caller gates ─────────────────
console.log('J. SEED_CLASS_SCENE_BASED caller-gate contract');
const studioOnModel = media('on_model', { background: { sceneType: 'Studio' } });
const beachOnModel = media('on_model', { background: { sceneType: 'Urban Street' } });
const yogaOnModel = media('on_model', { background: { sceneType: 'Yoga Studio' } });
const pack = media('flat_lay');

try {
  setFlag(undefined);
  check('J1 default (unset) isSeedClassSceneBased === false',
    isSeedClassSceneBased() === false);
  checkFn('J2 flag off: resolveSeedClass(on_model+Studio) STILL on_figure_plain', () => {
    assert.strictEqual(resolveSeedClass(studioOnModel), 'on_figure_plain');
  });
  checkFn('J3 flag off: resolveSeedClass(on_model+Street) STILL lifestyle_scene', () => {
    assert.strictEqual(resolveSeedClass(beachOnModel), 'lifestyle_scene');
  });
  checkFn('J4 flag off: resolveSeedClass(Yoga Studio) STILL lifestyle_scene', () => {
    assert.strictEqual(resolveSeedClass(yogaOnModel), 'lifestyle_scene');
  });
  checkFn('J5 flag off: resolveSeedClass(flat_lay) STILL packshot', () => {
    assert.strictEqual(resolveSeedClass(pack), 'packshot');
  });
  check('J6 flag off: caller stub is false even for a real lifestyle_scene',
    gatedLifestyleScene(beachOnModel) === false);
  check('J7 flag off: caller stub is false for studio (class is on_figure_plain anyway)',
    gatedLifestyleScene(studioOnModel) === false);

  setFlag('false');
  check('J8 string "false" stays off', isSeedClassSceneBased() === false);
  checkFn('J9 "false": resolveSeedClass still scene-based (flag is not a classifier input)', () => {
    assert.strictEqual(resolveSeedClass(studioOnModel), 'on_figure_plain');
    assert.strictEqual(resolveSeedClass(beachOnModel), 'lifestyle_scene');
  });
  check('J10 "false": caller stub stays false',
    gatedLifestyleScene(beachOnModel) === false);

  setFlag('FALSE');
  check('J11 "FALSE" stays off (case)', isSeedClassSceneBased() === false);

  setFlag('true');
  check('J12 "true" enables', isSeedClassSceneBased() === true);
  checkFn('J13 flag on: resolveSeedClass UNCHANGED (studio still on_figure_plain)', () => {
    assert.strictEqual(resolveSeedClass(studioOnModel), 'on_figure_plain');
  });
  checkFn('J14 flag on: resolveSeedClass UNCHANGED (street still lifestyle_scene)', () => {
    assert.strictEqual(resolveSeedClass(beachOnModel), 'lifestyle_scene');
  });
  check('J15 flag on: caller stub is true only for lifestyle_scene',
    gatedLifestyleScene(beachOnModel) === true
    && gatedLifestyleScene(yogaOnModel) === true
    && gatedLifestyleScene(studioOnModel) === false
    && gatedLifestyleScene(pack) === false);

  setFlag('TRUE');
  check('J16 "TRUE" enables (case)', isSeedClassSceneBased() === true);
  check('J17 "TRUE": caller stub matches resolveSeedClass === lifestyle_scene',
    gatedLifestyleScene(beachOnModel) === true
    && gatedLifestyleScene(studioOnModel) === false);

  setFlag('yes');
  check('J18 truthy-but-not-true "yes" stays off', isSeedClassSceneBased() === false);

  check('J19 source has no function seedClassForVideo',
    !/function\s+seedClassForVideo\s*\(/.test(SRC));
  check('J20 source documents the caller-gate contract',
    /isSeedClassSceneBased\(\)\s*&&\s*resolveSeedClass\(media\)\s*===\s*'lifestyle_scene'/.test(SRC));
} finally {
  restoreFlag();
}

// ── K. resolveSeedStyle unchanged ──────────────────────────────────────────
console.log('K. resolveSeedStyle zero-change pin');
checkFn('K1 LLM lifestyle still → lifestyle', () => {
  assert.strictEqual(resolveSeedStyle({
    classification: { shotType: 'lifestyle' },
    background: { sceneType: 'Studio' },
    technicalInsights: { shotStyle: 'packshot' }
  }), 'lifestyle');
});
checkFn('K2 LLM on_model still → lifestyle (BROAD — this is the bug we did NOT "fix" here)', () => {
  assert.strictEqual(resolveSeedStyle({
    classification: { shotType: 'on_model' },
    background: { sceneType: 'Studio' }
  }), 'lifestyle');
});
checkFn('K3 LLM product_only still → packshot', () => {
  assert.strictEqual(resolveSeedStyle(media('product_only', {
    technicalInsights: { shotStyle: 'lifestyle' }
  })), 'packshot');
});
checkFn('K4 heuristic still used when shotType absent', () => {
  assert.strictEqual(resolveSeedStyle({
    technicalInsights: { shotStyle: 'packshot' }
  }), 'packshot');
});
checkFn('K5 ambiguous still returned (resolveSeedClass would say unknown)', () => {
  assert.strictEqual(resolveSeedStyle({
    technicalInsights: { shotStyle: 'ambiguous' }
  }), 'ambiguous');
});
check('K6 resolveSeedStyle body still maps LLM_LIFESTYLE → lifestyle',
  /if \(LLM_LIFESTYLE\.has\(shotType\)\) return 'lifestyle';/.test(SRC));
check('K7 resolveSeedClass is additive — resolveSeedStyle fn is still exported first-class',
  /function resolveSeedStyle\(arg, maybeUrl\)/.test(SRC)
  && /resolveSeedStyle,/.test(SRC));

// ── L. no existing call site wired ─────────────────────────────────────────
console.log('L. zero call-site change');
const SCAN_ROOTS = [
  path.join(__dirname, '..', 'services'),
  path.join(__dirname, '..', 'routes'),
  path.join(__dirname, '..', 'pipelines')
];
const wired = [];
const leakedVideoHelper = [];
function walkJs(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (_) { return; }
  for (const e of entries) {
    // Skip dotfiles/dotdirs — same convention as verifyMetaApiVersion.js's
    // fix (real, reproduced revertprove-race in CI: a sibling harness
    // briefly writes a `.__revertprove_*.js` transient into services/ or
    // routes/, both scanned here).
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walkJs(p); continue; }
    if (!e.name.endsWith('.js')) continue;
    if (path.resolve(p) === path.resolve(SVC_PATH)) continue;
    const txt = fs.readFileSync(p, 'utf8');
    if (/\bresolveSeedClass\b|\bSTUDIO_SCENE_RE\b|\bisSeedClassSceneBased\b|\bisStudioSceneLabel\b/.test(txt)) {
      wired.push(path.relative(path.join(__dirname, '..'), p));
    }
    if (/\bseedClassForVideo\b/.test(txt)) {
      leakedVideoHelper.push(path.relative(path.join(__dirname, '..'), p));
    }
  }
}
for (const root of SCAN_ROOTS) walkJs(root);
check('L1 no service/route/pipeline call site uses the new symbols yet',
  wired.length === 0,
  wired.length ? `wired: ${wired.join(', ')}` : '');
check('L1b seedClassForVideo is not referenced outside the service',
  leakedVideoHelper.length === 0,
  leakedVideoHelper.length ? `leaked: ${leakedVideoHelper.join(', ')}` : '');
{
  const v = fs.readFileSync(path.join(__dirname, '..', 'services', 'atlasVideoService.js'), 'utf8');
  check('L2 atlasVideoService still calls resolveSeedStyle(media)',
    /resolveSeedStyle\(media\)/.test(v)
    && !/\bresolveSeedClass\b/.test(v)
    && !/\bseedClassForVideo\b/.test(v));
}
{
  const v = fs.readFileSync(path.join(__dirname, '..', 'services', 'directImageRenderService.js'), 'utf8');
  // renderDirectImage (the production resolveSeedStyle caller) is gone from
  // this backend; adgen owns mint-time static. Pin that the leftover module
  // still does not sneak-wire resolveSeedClass / seedClassForVideo.
  check('L3 backend directImageRenderService no longer calls resolveSeedStyle (renderDirectImage gone)',
    !/resolveSeedStyle\(media\)/.test(v)
    && !/\bresolveSeedClass\b/.test(v)
    && !/\bseedClassForVideo\b/.test(v));
}

// Source-text pins that make the revert-prove mutations fail even without
// a temp-copy run (defence in depth).
check('L4 STUDIO_SCENE_RE is an anchored new RegExp, not a substring literal',
  /const STUDIO_SCENE_RE = new RegExp\(/.test(SRC)
  && /ANCHORED on purpose/.test(SRC)
  && /fashion\|apparel\|beauty\|photo/.test(SRC)
  && !/const STUDIO_SCENE_RE = \/studio\|backdrop\|seamless\|cyclorama\/i;/.test(SRC));
check('L5 source fallback is lifestyle → lifestyle_scene, else on_figure_plain',
  /return shotType === 'lifestyle' \? 'lifestyle_scene' : 'on_figure_plain';/.test(SRC));
check('L6 source packshot arm uses LLM_PACKSHOT.has',
  /if \(LLM_PACKSHOT\.has\(shotType\)\) return 'packshot';/.test(SRC));
check('L7 setting is a closed enum (toLowerCase + SETTING_PLAIN/SCENE)',
  /const SETTING_PLAIN = new Set\(\['studio', 'product-shot-on-solid', 'abstract'\]\);/.test(SRC)
  && /const SETTING_SCENE = new Set\(\['outdoor', 'lifestyle', 'indoor'\]\);/.test(SRC)
  && /bg\.setting\.trim\(\)\.toLowerCase\(\)/.test(SRC)
  && /SETTING_PLAIN\.has\(setting\)/.test(SRC)
  && /SETTING_SCENE\.has\(setting\)/.test(SRC));
check('L8 sceneVerdict + isStudioSceneLabel + equipment regex are in source',
  /function sceneVerdict\(media\)/.test(SRC)
  && /function isStudioSceneLabel\(label\)/.test(SRC)
  && /const STUDIO_EQUIPMENT_RE/.test(SRC)
  && /isStudioSceneLabel/.test(SRC));
check('L9 module.exports lists isStudioSceneLabel and not seedClassForVideo',
  /isStudioSceneLabel,/.test(SRC)
  && !/^\s*seedClassForVideo,?$/m.test(SRC));

// ── R. revert-prove — mutate a temp copy, confirm named checks fail ────────
console.log('R. revert-prove (live mutations on a temp copy)');

function loadMutated(label, mutator) {
  const mutated = mutator(SRC);
  if (mutated === SRC) throw new Error(`mutation ${label} was a no-op — pattern missed`);
  const tmp = path.join(os.tmpdir(), `verifySeedClass-${label}-${process.pid}-${Date.now()}.js`);
  fs.writeFileSync(tmp, mutated);
  // Fresh require each time.
  delete require.cache[tmp];
  const mod = require(tmp);
  try { fs.unlinkSync(tmp); } catch (_) { /* leave for OS */ }
  return mod;
}

function countFails(pairs, fn) {
  let n = 0;
  const failed = [];
  for (const [input, expected, name] of pairs) {
    const got = fn(input);
    if (got !== expected) {
      n++;
      failed.push(name || `${JSON.stringify(expected)} vs ${got}`);
    }
  }
  return { n, failed };
}

const YOGA = media('on_model', { background: { sceneType: 'Yoga Studio' } });
const FALLBACK_PAIRS = [
  [media('lifestyle'), 'lifestyle_scene', 'D1 lifestyle no-scene'],
  [media('on_model'), 'on_figure_plain', 'D2 on_model no-scene']
];
const PACK_PAIRS = PACKSHOT_TYPES.map((st) => ([
  media(st), 'packshot', st
]));
const SOLID_PAIR = [
  media('lifestyle', { background: { setting: 'product-shot-on-solid' } }),
  'on_figure_plain',
  'E2 lifestyle + product-shot-on-solid'
];

const REVERT_RESULTS = [];

// R1 — anchor removed (substring regress). Yoga Studio must fail.
{
  const mod = loadMutated('unanchor-studio-re', (s) => s.replace(
    'const STUDIO_SCENE_RE = new RegExp(',
    'const STUDIO_SCENE_RE = /studio/i; const _REMOVED_ANCHOR = new RegExp('
  ));
  const yogaGot = mod.resolveSeedClass(YOGA);
  check('R1 unanchored STUDIO_SCENE_RE classifies Yoga Studio as plain (substring regress)',
    yogaGot === 'on_figure_plain',
    `got ${yogaGot}`);
  // Named C3 check fails under this mutation.
  const fpFails = FALSE_POSITIVE.filter((scene) =>
    /studio/i.test(scene)
    && mod.resolveSeedClass(media('on_model', { background: { sceneType: scene } })) !== 'lifestyle_scene');
  check('R1b substring regress fails every false-positive that contains "studio"',
    fpFails.includes('Yoga Studio') && fpFails.length >= 6,
    `failed: ${fpFails.join(', ')}`);
  // Surgical: real studio labels and non-studio scenery stay correct.
  check('R1c Studio still on_figure_plain after unanchor',
    mod.resolveSeedClass(media('on_model', { background: { sceneType: 'Studio' } })) === 'on_figure_plain');
  check('R1d Beach still lifestyle_scene after unanchor',
    mod.resolveSeedClass(media('on_model', { background: { sceneType: 'Beach' } })) === 'lifestyle_scene');
  check('R1e mountain backdrop still lifestyle_scene (equipment regex still anchored)',
    mod.resolveSeedClass(media('on_model', { background: { sceneType: 'mountain backdrop' } })) === 'lifestyle_scene');
  REVERT_RESULTS.push({
    mutation: 'STUDIO_SCENE_RE unanchored (substring /studio/i)',
    fails: [
      "C3 on_model|Yoga Studio → lifestyle_scene",
      'other * Studio false-positives (Pilates/Dance/Fitness/Apartment/…)'
    ],
    observedFails: fpFails.length
  });
}

// R2 — fallback arms flipped
{
  const mod = loadMutated('flip-fallback', (s) => s.replace(
    "return shotType === 'lifestyle' ? 'lifestyle_scene' : 'on_figure_plain';",
    "return shotType === 'lifestyle' ? 'on_figure_plain' : 'lifestyle_scene';"
  ));
  const { n, failed } = countFails(FALLBACK_PAIRS, (m) => mod.resolveSeedClass(m));
  check(`R2 fallback flipped fails both D1/D2 (got ${n})`,
    n === 2, n !== 2 ? `failed: ${failed.join(', ')}` : '');
  // Scene-present arms must stay green.
  check('R2b on_model|Studio still on_figure_plain after fallback flip',
    mod.resolveSeedClass(media('on_model', { background: { sceneType: 'Studio' } })) === 'on_figure_plain');
  check('R2c lifestyle|Beach still lifestyle_scene after fallback flip',
    mod.resolveSeedClass(media('lifestyle', { background: { sceneType: 'Beach' } })) === 'lifestyle_scene');
  check('R2d setting other still uses (flipped) fallback — lifestyle → on_figure_plain',
    mod.resolveSeedClass(media('lifestyle', { background: { setting: 'other' } })) === 'on_figure_plain');
  REVERT_RESULTS.push({
    mutation: 'fallback arms flipped (lifestyle ↔ on_model)',
    fails: [
      'D1 lifestyle + no background → lifestyle_scene',
      'D2 on_model + no background → on_figure_plain'
    ],
    observedFails: n
  });
}

// R3 — packshot family broken (only product_only)
{
  const mod = loadMutated('pack-broken', (s) => s.replace(
    // Target resolveSeedClass only — resolveFromMedia has the same line
    // earlier and replace() would otherwise no-op the classifier.
    "      if (LLM_PACKSHOT.has(shotType)) return 'packshot';\n      if (LLM_LIFESTYLE.has(shotType)) {",
    "      if (shotType === 'product_only') return 'packshot';\n      if (LLM_LIFESTYLE.has(shotType)) {"
  ));
  const { n, failed } = countFails(PACK_PAIRS, (m) => mod.resolveSeedClass(m));
  // product_only still passes; the other three fail.
  check(`R3 packshot family broken fails the 3 non-product_only types (got ${n})`,
    n === 3, n !== 3 ? `failed: ${failed.join(', ')}` : '');
  check('R3b product_only still packshot under this mutation',
    mod.resolveSeedClass(media('product_only')) === 'packshot');
  REVERT_RESULTS.push({
    mutation: 'packshot family broken (only product_only maps)',
    fails: ['A1 flat_lay → packshot', 'A1 detail → packshot', 'A1 packaging → packshot'],
    observedFails: n
  });
}

// R4 — setting map dropped (free-text / isStudioSceneLabel on setting)
{
  const mod = loadMutated('no-setting-map', (s) => s.replace(
    "  if (SETTING_PLAIN.has(setting)) return 'plain';\n" +
    "  if (SETTING_SCENE.has(setting)) return 'scene';\n" +
    "  return 'absent';",
    "  if (setting) return isStudioSceneLabel(setting) ? 'plain' : 'scene';\n" +
    "  return 'absent';"
  ));
  const solidGot = mod.resolveSeedClass(SOLID_PAIR[0]);
  check('R4 setting map dropped classifies product-shot-on-solid as a scene',
    solidGot === 'lifestyle_scene',
    `got ${solidGot}`);
  const { n, failed } = countFails([SOLID_PAIR], (m) => mod.resolveSeedClass(m));
  check('R4b product-shot-on-solid check fails under dropped map',
    n === 1, n !== 1 ? `failed: ${failed.join(', ')}` : '');
  // Surgical: sceneType path and a real studio setting stay green.
  check('R4c sceneType Beach still lifestyle_scene when setting map is dropped',
    mod.resolveSeedClass(media('on_model', { background: { sceneType: 'Beach' } })) === 'lifestyle_scene');
  check('R4d setting studio still on_figure_plain (label helper still matches)',
    mod.resolveSeedClass(media('lifestyle', { background: { setting: 'studio' } })) === 'on_figure_plain');
  REVERT_RESULTS.push({
    mutation: 'setting enum map dropped (free-text via isStudioSceneLabel)',
    fails: ['E2 lifestyle + setting product-shot-on-solid → on_figure_plain'],
    observedFails: n
  });
}

check('R5 four mutations executed', REVERT_RESULTS.length === 4);

// ── REVERT-PROVE table ─────────────────────────────────────────────────────
console.log('\n=== REVERT-PROVE table ===');
console.log('mutation'.padEnd(52) + 'checks that fail');
console.log('-'.repeat(88));
for (const row of REVERT_RESULTS) {
  console.log(`  ${row.mutation}`);
  for (const f of row.fails) console.log(`      → ${f}`);
  console.log(`      (observed failing assertions: ${row.observedFails})`);
}

// ── summary ────────────────────────────────────────────────────────────────
restoreFlag();
console.log(`\n${'─'.repeat(60)}`);
console.log(`verifySeedClass: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('All checks green.');
process.exit(0);
