#!/usr/bin/env node
'use strict';

/**
 * verifyPmaxSplitPromptDirectives — PMax 16:9 split-stage camera prompt.
 *
 * WHY THIS EXISTS. The stock PMax landscape prompt assumes a CENTERED
 * subject in three places that all fight a split layout (subject anchored
 * in a vertical band on one side; opposite side deliberately calm for
 * brand-script chrome composited downstream):
 *
 *   1. Timeline Scene 1: "Slow horizontal pan left→right across the product"
 *      — a lateral pan drags the subject through the copy panel.
 *   2. Frame (16:9): "Hold the product in the central band" + "prefer
 *      horizontal camera travel" — both contradict an anchored subject.
 *   3. Centre-safe inject (lifestyle + PMax only): "away from … the outer
 *      side margins" — directly forbids side-anchoring. Nearly missed in
 *      review because it only fires on lifestyle+PMax.
 *
 * Plus packshot PMAX_DIRECTIVES.cameraStyle embeds the same centre-safe
 * clause, so a packshot split would still self-contradict without a
 * gated replacement.
 *
 * Contract (same class as REFRAME_PROMPT_HARDENING / CLAUDE.md flag-off):
 *   • subjectSide / panelTreatment absent OR null → byte-identical to
 *     today's output (proven by asserting today's strings present and
 *     split language absent — both 16:9 and 9:16).
 *   • Split active ONLY when subjectSide is 'east'|'west' AND aspect is
 *     16:9. 9:16 + side args must change nothing.
 *   • noText directive must survive every variant — split language must
 *     never invite the model to render letterforms (no "leave room for
 *     text/copy/caption").
 *   • Scene boundary timestamps (t1/t2) identical split vs non-split so
 *     Remotion brand-script beats still line up via specTimeScale.
 *
 * BEHAVIOURAL: calls the real buildVeoPrompt. No DB, no network, no key.
 *
 * Run: node scripts/verifyPmaxSplitPromptDirectives.js
 *
 * REVERT-PROOF: force isSplit to also fire on 9:16 → checks that assert
 * "9:16 + subjectSide changes nothing" go RED; restore → GREEN.
 */

const assert = require('assert');
const { buildVeoPrompt, OMNI_DIRECTIVES, PMAX_DIRECTIVES, LIFESTYLE_DIRECTIVES } =
  require('../services/veoPromptBuilder');

let checks = 0;
const ok = (label, fn) => {
  fn();
  checks += 1;
  console.log(`  ✓ ${label}`);
};

console.log('verifyPmaxSplitPromptDirectives\n');

// ── Fixtures ──────────────────────────────────────────────────────────

const CAPS = { promptByteCap: 20000, paramShape: 'gemini-omni' };
const PRODUCT = { title: 'Wool Runner' };

const basePmax = (extra = {}) => ({
  product: PRODUCT,
  durationSec: 10,
  hasProductReference: true,
  seedHasText: false,
  caps: CAPS,
  platformFormat: 'pmax_video_16_9',
  aspectRatio: '16:9',
  ...extra
});

// Today-strings that must survive when split is OFF (byte-identity proxy —
// we cannot call the pre-change builder, so we pin the verbatim clauses
// the change is required not to touch).
const TODAY_PAN =
  'Slow horizontal pan left→right across the product, ~10–15% movement. No zoom, rotation, or perspective shift.';
const TODAY_FRAME =
  'Frame (16:9 landscape): use wider establishing framing; prefer horizontal camera travel rather than vertical. ' +
  'Hold the product in the central band of the wide frame with generous headroom above and below the product.';
const TODAY_CENTRE_SAFE =
  'away from the top and bottom bands and the outer side margins, where the platform overlays UI.';
const TODAY_SCENE2_CENTERED =
  'slow zoom toward the logo or most distinctive product detail (~8–10%), centered.';

// Split language markers — must be ABSENT when inert, PRESENT when active.
const SPLIT_MARKERS = [
  'split-stage',
  'Split-stage',
  'vertical band on the right',
  'vertical band on the left',
  'subject-anchored in the right band',
  'subject-anchored in the left band',
  'plain uniform brand-colour backdrop',
  'continues the existing scene as a calm extension'
];

function assertNoSplitLanguage(prompt, label) {
  for (const m of SPLIT_MARKERS) {
    assert.ok(
      !prompt.includes(m),
      `${label}: unexpected split language ${JSON.stringify(m)}`
    );
  }
}

function sceneBounds(prompt) {
  // Timeline (10.0s): Scene 1 (0.0–3.33s): ... Scene 2 (3.33–6.40s): ... Scene 3 (6.40–10.0s):
  const m = prompt.match(
    /Timeline \(([\d.]+)s\): Scene 1 \(0\.0–([\d.]+)s\):[\s\S]*?Scene 2 \(([\d.]+)–([\d.]+)s\):[\s\S]*?Scene 3 \(([\d.]+)–([\d.]+)s\):/
  );
  assert.ok(m, 'could not parse Timeline scene bounds from prompt');
  return { dur: m[1], t1: m[2], t2a: m[3], t2b: m[4], t3a: m[5], t3b: m[6] };
}

const NO_TEXT_SNIPPET =
  'Do NOT render any text, typography, logos, badges, watermarks, or captions';

// ── 1. BYTE-IDENTITY (params absent / null) ───────────────────────────

console.log('== 1. BYTE-IDENTITY (params absent / null) ==');

ok('16:9 PMax, params absent: today pan + frame present, no split language', () => {
  const p = buildVeoPrompt(basePmax());
  assert.ok(p.includes(TODAY_PAN), 'missing today pan sentence');
  assert.ok(p.includes(TODAY_FRAME), 'missing today Frame central-band sentence');
  assert.ok(p.includes(TODAY_SCENE2_CENTERED), 'missing today Scene 2 centered');
  assertNoSplitLanguage(p, 'absent params 16:9');
});

ok('16:9 PMax, params explicitly null: identical to absent + today strings', () => {
  const a = buildVeoPrompt(basePmax());
  const b = buildVeoPrompt(basePmax({ subjectSide: null, panelTreatment: null }));
  assert.strictEqual(b, a, 'null params must be byte-identical to absent params');
  assert.ok(b.includes(TODAY_PAN));
  assert.ok(b.includes(TODAY_FRAME));
  assertNoSplitLanguage(b, 'null params 16:9');
});

ok('9:16 PMax, params absent: vertical push-in present, no split language', () => {
  const p = buildVeoPrompt(basePmax({
    aspectRatio: '9:16',
    platformFormat: 'pmax_video_9_16'
  }));
  assert.ok(
    p.includes('Very slow push-in toward the product, ~8–12% movement, product held on the vertical centre line'),
    'missing today 9:16 push-in'
  );
  assert.ok(!p.includes(TODAY_PAN), '9:16 must not use landscape pan');
  assert.ok(!p.includes(TODAY_FRAME), '9:16 must not use 16:9 Frame line');
  assertNoSplitLanguage(p, 'absent params 9:16');
});

ok('9:16 PMax, params null: identical to absent', () => {
  const a = buildVeoPrompt(basePmax({
    aspectRatio: '9:16',
    platformFormat: 'pmax_video_9_16'
  }));
  const b = buildVeoPrompt(basePmax({
    aspectRatio: '9:16',
    platformFormat: 'pmax_video_9_16',
    subjectSide: null,
    panelTreatment: null
  }));
  assert.strictEqual(b, a);
  assertNoSplitLanguage(b, 'null params 9:16');
});

// ── 2. Split active: east on 16:9 ─────────────────────────────────────

console.log('\n== 2. Split active (16:9 + subjectSide east) ==');

ok('east: pan sentence GONE, central-band Frame GONE, split language present, RIGHT side', () => {
  const p = buildVeoPrompt(basePmax({ subjectSide: 'east' }));
  assert.ok(!p.includes(TODAY_PAN), 'left→right pan must be gone under split');
  assert.ok(!p.includes(TODAY_FRAME), 'central-band Frame must be gone under split');
  assert.ok(!p.includes(TODAY_SCENE2_CENTERED), 'Scene 2 "centered" must be reworded under split');
  assert.ok(
    p.includes('Frame (16:9 landscape, split-stage): anchor the product in a vertical band on the right side'),
    'split Frame must anchor on the right (east)'
  );
  assert.ok(
    p.includes('Product anchored in the right vertical band of the wide frame for the entire clip'),
    'timeline must anchor product on the right'
  );
  assert.ok(
    p.includes('subject-anchored in the right band'),
    'Scene 2 must be subject-anchored on the right'
  );
  assert.ok(
    p.includes('Keep the left side visually calm, uncluttered'),
    'opposite (left) side must stay calm'
  );
  // Must not accidentally use west wording as the subject side.
  assert.ok(
    !p.includes('anchor the product in a vertical band on the left side'),
    'east must not claim left as the subject band'
  );
});

// ── 3. West is the mirror ─────────────────────────────────────────────

console.log('\n== 3. subjectSide west is mirrored ==');

ok('west: left subject band, NOT east/right wording', () => {
  const p = buildVeoPrompt(basePmax({ subjectSide: 'west' }));
  assert.ok(!p.includes(TODAY_PAN));
  assert.ok(
    p.includes('Frame (16:9 landscape, split-stage): anchor the product in a vertical band on the left side'),
    'west Frame must anchor on the left'
  );
  assert.ok(
    p.includes('Product anchored in the left vertical band of the wide frame for the entire clip'),
    'timeline must anchor product on the left'
  );
  assert.ok(
    p.includes('subject-anchored in the left band'),
    'Scene 2 must be subject-anchored on the left'
  );
  assert.ok(
    p.includes('Keep the right side visually calm, uncluttered'),
    'opposite (right) side must stay calm'
  );
  assert.ok(
    !p.includes('anchor the product in a vertical band on the right side'),
    'west must not claim right as the subject band'
  );
  assert.ok(
    !p.includes('Product anchored in the right vertical band'),
    'west must not use east timeline wording'
  );
});

// ── 4. 9:16 gate — split params change nothing ────────────────────────

console.log('\n== 4. 16:9-only gate (9:16 + subjectSide inert) ==');

ok('9:16 + subjectSide east: byte-identical to 9:16 without params', () => {
  const base = buildVeoPrompt(basePmax({
    aspectRatio: '9:16',
    platformFormat: 'pmax_video_9_16'
  }));
  const withSide = buildVeoPrompt(basePmax({
    aspectRatio: '9:16',
    platformFormat: 'pmax_video_9_16',
    subjectSide: 'east',
    panelTreatment: 'scene_extend'
  }));
  assert.strictEqual(withSide, base, '9:16 + subjectSide must not change the prompt');
  assertNoSplitLanguage(withSide, '9:16 + east');
});

ok('9:16 + subjectSide west + brand_panel: still inert', () => {
  const base = buildVeoPrompt(basePmax({
    aspectRatio: '9:16',
    platformFormat: 'pmax_video_9_16'
  }));
  const withSide = buildVeoPrompt(basePmax({
    aspectRatio: '9:16',
    platformFormat: 'pmax_video_9_16',
    subjectSide: 'west',
    panelTreatment: 'brand_panel'
  }));
  assert.strictEqual(withSide, base);
});

// ── 5. lifestyle + PMax + split: centre-safe outer-margins GONE ────────

console.log('\n== 5. lifestyle + PMax + split: centre-safe outer-margins gone ==');

ok('lifestyle+PMax non-split still emits outer-side-margins centre-safe', () => {
  // Prove the inject exists so the next check is not a vacuous pass.
  // Lifestyle path: VIDEO_LIFESTYLE_PROMPT default + variantKind ugc.
  const prev = process.env.VIDEO_LIFESTYLE_PROMPT;
  process.env.VIDEO_LIFESTYLE_PROMPT = 'true';
  try {
    const p = buildVeoPrompt(basePmax({
      seedStyle: 'lifestyle',
      variantKind: 'ugc'
    }));
    assert.ok(
      p.includes(TODAY_CENTRE_SAFE),
      'lifestyle+PMax non-split must still carry the centre-safe outer-margins clause'
    );
    assert.ok(
      p.includes('Centre-safe composition (PMax destination)'),
      'lifestyle+PMax non-split must label the centre-safe inject'
    );
  } finally {
    if (prev === undefined) delete process.env.VIDEO_LIFESTYLE_PROMPT;
    else process.env.VIDEO_LIFESTYLE_PROMPT = prev;
  }
});

ok('lifestyle+PMax+split: outer-side-margins centre-safe MUST NOT appear', () => {
  const prev = process.env.VIDEO_LIFESTYLE_PROMPT;
  process.env.VIDEO_LIFESTYLE_PROMPT = 'true';
  try {
    const p = buildVeoPrompt(basePmax({
      seedStyle: 'lifestyle',
      variantKind: 'ugc',
      subjectSide: 'east'
    }));
    assert.ok(
      !p.includes(TODAY_CENTRE_SAFE),
      'split must suppress the outer-side-margins centre-safe sentence'
    );
    assert.ok(
      !p.includes('Centre-safe composition (PMax destination)'),
      'split must not emit the centre-safe inject label'
    );
    assert.ok(
      p.includes('Split-stage composition (PMax destination)'),
      'split must emit the side-anchored composition instead'
    );
    assert.ok(
      p.includes('right vertical band of the wide frame'),
      'lifestyle split timeline/composition must name the right band'
    );
  } finally {
    if (prev === undefined) delete process.env.VIDEO_LIFESTYLE_PROMPT;
    else process.env.VIDEO_LIFESTYLE_PROMPT = prev;
  }
});

ok('packshot+split: PMAX cameraStyle centre-safe outer-margins also gone', () => {
  // The packshot twin of check 5 — centre-safe lives inside PMAX_DIRECTIVES
  // cameraStyle, not only the lifestyle inject.
  const p = buildVeoPrompt(basePmax({ subjectSide: 'east' }));
  assert.ok(
    !p.includes(TODAY_CENTRE_SAFE),
    'packshot split must not keep cameraStyle outer-side-margins clause'
  );
  assert.ok(
    p.includes('Split-stage composition: hold the product in the right vertical band'),
    'packshot split must emit split-safe camera style'
  );
});

// ── 6. noText survives every variant ──────────────────────────────────

console.log('\n== 6. noText present in every variant ==');

const VARIANTS = [
  ['16:9 no params', basePmax()],
  ['16:9 null params', basePmax({ subjectSide: null, panelTreatment: null })],
  ['16:9 east scene_extend', basePmax({ subjectSide: 'east', panelTreatment: 'scene_extend' })],
  ['16:9 east brand_panel', basePmax({ subjectSide: 'east', panelTreatment: 'brand_panel' })],
  ['16:9 west', basePmax({ subjectSide: 'west' })],
  ['9:16 east (inert)', basePmax({
    aspectRatio: '9:16',
    platformFormat: 'pmax_video_9_16',
    subjectSide: 'east'
  })]
];

for (const [label, args] of VARIANTS) {
  ok(`noText present: ${label}`, () => {
    const p = buildVeoPrompt(args);
    assert.ok(p.includes(NO_TEXT_SNIPPET), `missing noText in ${label}`);
    // Split language must not invite the model to draw letterforms.
    assert.ok(!/\bleave room for (text|copy|caption)/i.test(p),
      `${label}: must not say "leave room for text/copy/caption"`);
    assert.ok(!/\bspace for (text|copy|caption)/i.test(p),
      `${label}: must not say "space for text/copy/caption"`);
  });
}

ok('brand_panel emits plain backdrop language without inviting text', () => {
  const p = buildVeoPrompt(basePmax({
    subjectSide: 'east',
    panelTreatment: 'brand_panel'
  }));
  assert.ok(
    p.includes('plain uniform brand-colour backdrop'),
    'brand_panel treatment missing'
  );
  assert.ok(
    !p.includes('continues the existing scene as a calm extension'),
    'brand_panel must not also claim scene_extend'
  );
});

ok('scene_extend (default) emits calm extension, not brand panel', () => {
  const p = buildVeoPrompt(basePmax({ subjectSide: 'east' }));
  assert.ok(p.includes('continues the existing scene as a calm extension'));
  assert.ok(!p.includes('plain uniform brand-colour backdrop'));
});

// ── 7. Scene boundary timestamps identical ────────────────────────────

console.log('\n== 7. Scene boundary timestamps (t1/t2) identical ==');

ok('10s packshot: split and non-split share the same beat grid', () => {
  const plain = buildVeoPrompt(basePmax({ durationSec: 10 }));
  const split = buildVeoPrompt(basePmax({ durationSec: 10, subjectSide: 'east' }));
  const a = sceneBounds(plain);
  const b = sceneBounds(split);
  assert.deepStrictEqual(b, a, `beat grid drifted: plain=${JSON.stringify(a)} split=${JSON.stringify(b)}`);
  // Sanity: 10s → t1=3.33, t2=6.40
  assert.strictEqual(a.dur, '10.0');
  assert.strictEqual(a.t1, '3.33');
  assert.strictEqual(a.t2b, '6.40');
});

ok('8s packshot: split and non-split share the same beat grid', () => {
  const plain = buildVeoPrompt(basePmax({ durationSec: 8 }));
  const split = buildVeoPrompt(basePmax({ durationSec: 8, subjectSide: 'west' }));
  assert.deepStrictEqual(sceneBounds(split), sceneBounds(plain));
});

// ── Floor: product fidelity preserved under split ─────────────────────

console.log('\n== floor: product fidelity + directive references ==');

ok('PRODUCT FIDELITY still present under split', () => {
  const p = buildVeoPrompt(basePmax({ subjectSide: 'east', hasProductReference: true }));
  assert.ok(p.includes('PRODUCT FIDELITY: All supplied images show the exact catalog SKU'));
});

ok('OMNI noText is what PMax packshot still references (non-split)', () => {
  // Drift guard: PMAX_DIRECTIVES.noText must remain a reference to OMNI.
  assert.strictEqual(PMAX_DIRECTIVES.noText, OMNI_DIRECTIVES.noText);
  assert.ok(LIFESTYLE_DIRECTIVES.noText.includes(NO_TEXT_SNIPPET));
});

ok('split camera style is DERIVED from the canonical directive, not a rewrite', () => {
  // An earlier draft hardcoded a replacement camera style. It drifted from
  // PMAX_DIRECTIVES.cameraStyle and — worse — permitted "parallax" while still
  // asserting "The product stays completely static", i.e. a self-contradicting
  // instruction on a billable submit. Deriving keeps the shared prohibition
  // list intact; these assertions are what stop a rewrite creeping back.
  const split = buildVeoPrompt(basePmax({ subjectSide: 'east' }));

  // The prohibition list survives verbatim, parallax included.
  assert.ok(
    split.includes('No shake, handheld, parallax, simulated 3D, orbit, or object movement.'),
    'split dropped part of the canonical camera prohibition list'
  );
  // ...and the split never simultaneously permits what that list forbids.
  assert.ok(
    !/parallax on the product/i.test(split),
    'split permits parallax while the prohibition list still forbids it'
  );
  // The centre-safe sentence it replaces is gone (it forbids side-anchoring).
  assert.ok(
    !split.includes('away from the top and bottom bands and the outer side margins'),
    'centre-safe clause survived into a split prompt and forbids the anchoring'
  );
  // Non-split keeps the canonical directive exactly.
  assert.ok(
    buildVeoPrompt(basePmax()).includes(PMAX_DIRECTIVES.cameraStyle),
    'non-split no longer emits the canonical camera style verbatim'
  );
});

// ── Summary ───────────────────────────────────────────────────────────

console.log(`\n✅ verifyPmaxSplitPromptDirectives: ${checks}/${checks} checks passed`);
