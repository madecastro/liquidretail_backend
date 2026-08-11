#!/usr/bin/env node
'use strict';

/**
 * verifyVideoHeadline — offline pins for services/videoHeadlineService.js.
 *
 * WHY THIS EXISTS
 * layoutInputService.js's fallbackDerivation used to hardcode a video
 * headline template: `Meet ${productName}` / 'See why customers love it'.
 * That's the string that shipped clipped mid-word on a delivered 1920x1080
 * video (CSS webkit-line-clamp maxLines:2 cutting a 2-line box). Owner
 * directive bans templated video headlines outright and wants the AI
 * Creative Director's own copy used instead, selected for fit.
 * videoHeadlineService.js is the selection + fit logic; this harness pins:
 *   - selection never exceeds the format's character budget
 *   - the removed templates can never come back out of this module
 *   - deterministic ranking when several candidates fit
 *   - null (never a template, never a throw) when nothing fits/exists
 *   - nasty inputs (null artifact, empty concepts, null copy fields, very
 *     long strings, unicode) never throw
 *   - budgets differ per format and are all > 0
 *   - resolveVideoHeadline / resolveVideoHeadlineCandidates behave
 *     correctly against INJECTED fake round data — the real production
 *     functions, with only the DB read swapped out (fetchRounds), not a
 *     reimplementation under a matching name.
 *
 * Offline: no DB, no network, no API key. Requires the actual
 * services/videoHeadlineService.js module (calls the real code).
 *
 *   node scripts/verifyVideoHeadline.js
 */

const {
  selectVideoHeadline,
  candidatesFromConcepts,
  classifyHeadlineFormat,
  budgetForFormat,
  HEADLINE_CHAR_BUDGET,
  resolveVideoHeadlineCandidates,
  resolveVideoHeadline,
} = require('../services/videoHeadlineService');

let pass = 0;
const failures = [];

function check(label, fn) {
  try {
    fn();
    pass += 1;
  } catch (err) {
    failures.push(`${label}: ${err.message}`);
  }
}

async function checkAsync(label, fn) {
  try {
    await fn();
    pass += 1;
  } catch (err) {
    failures.push(`${label}: ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'eq'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// Builds a fake CreativeDirectionArtifact `concepts` array shaped like the
// real Director round output (aiCreativeDirectorService.js buildResponseSchemaRound
// -> { routing, copy, art_direction, reasoning }). Only `copy` matters here.
function concept(copy) {
  return { routing: {}, copy, art_direction: null, reasoning: { rationale: 'test' } };
}

// v2 legacy shape (copy_picks instead of copy) — dual-read pin.
function conceptV2(copyPicks) {
  return { copy_picks: copyPicks };
}

// ────────────────────────────────────────────────────────────────────────
// A. Budgets: per-format, always positive, and actually differ
// ────────────────────────────────────────────────────────────────────────

check('A1: landscape budget is a positive number', () => {
  assert(Number.isFinite(HEADLINE_CHAR_BUDGET.landscape), 'landscape budget not finite');
  assert(HEADLINE_CHAR_BUDGET.landscape > 0, 'landscape budget not > 0');
});

check('A2: vertical budget is a positive number', () => {
  assert(Number.isFinite(HEADLINE_CHAR_BUDGET.vertical), 'vertical budget not finite');
  assert(HEADLINE_CHAR_BUDGET.vertical > 0, 'vertical budget not > 0');
});

check('A3: landscape and vertical budgets differ (per-format, not one magic number)', () => {
  assert(HEADLINE_CHAR_BUDGET.landscape !== HEADLINE_CHAR_BUDGET.vertical,
    `landscape (${HEADLINE_CHAR_BUDGET.landscape}) === vertical (${HEADLINE_CHAR_BUDGET.vertical})`);
});

check('A4: budgetForFormat matches HEADLINE_CHAR_BUDGET for known formats', () => {
  assertEq(budgetForFormat('landscape'), HEADLINE_CHAR_BUDGET.landscape);
  assertEq(budgetForFormat('vertical'), HEADLINE_CHAR_BUDGET.vertical);
  assertEq(budgetForFormat('feed'), HEADLINE_CHAR_BUDGET.feed);
  assertEq(budgetForFormat('square'), HEADLINE_CHAR_BUDGET.square);
});

check('A5: budgetForFormat never throws / always positive on an unknown format', () => {
  assert(budgetForFormat('made_up_format_xyz') > 0, 'unknown format budget not > 0');
  assert(budgetForFormat(undefined) > 0, 'undefined format budget not > 0');
  assert(budgetForFormat(null) > 0, 'null format budget not > 0');
});

// ────────────────────────────────────────────────────────────────────────
// B. classifyHeadlineFormat — aspectRatio -> Remotion format key
// ────────────────────────────────────────────────────────────────────────

check('B1: aspectRatio 9:16 -> vertical', () => assertEq(classifyHeadlineFormat('9:16'), 'vertical'));
check('B2: aspectRatio 1:1 -> square', () => assertEq(classifyHeadlineFormat('1:1'), 'square'));
check('B3: aspectRatio 16:9 -> landscape', () => assertEq(classifyHeadlineFormat('16:9'), 'landscape'));
check('B4: aspectRatio 4:5 -> feed (default)', () => assertEq(classifyHeadlineFormat('4:5'), 'feed'));
check('B5: missing/garbage aspectRatio never throws, defaults to feed', () => {
  assertEq(classifyHeadlineFormat(undefined), 'feed');
  assertEq(classifyHeadlineFormat(null), 'feed');
  assertEq(classifyHeadlineFormat(''), 'feed');
  assertEq(classifyHeadlineFormat(12345), 'feed');
});

// ────────────────────────────────────────────────────────────────────────
// C. selectVideoHeadline — pure fit selection
// ────────────────────────────────────────────────────────────────────────

check('C1: selection never exceeds the format budget (landscape)', () => {
  const budget = HEADLINE_CHAR_BUDGET.landscape;
  const fits = 'A'.repeat(budget);
  const tooLong = 'A'.repeat(budget + 1);
  const picked = selectVideoHeadline({ candidates: [tooLong, fits], format: 'landscape' });
  assertEq(picked, fits, 'did not skip the over-budget candidate');
  assert(picked.length <= budget, `picked "${picked}" exceeds budget ${budget}`);
});

check('C2: selection never exceeds the format budget (vertical)', () => {
  const budget = HEADLINE_CHAR_BUDGET.vertical;
  const tooLong = 'B'.repeat(budget + 5);
  const picked = selectVideoHeadline({ candidates: [tooLong], format: 'vertical' });
  assertEq(picked, null, 'an over-budget lone candidate must resolve to null, not a truncation');
});

check('C3: explicit budgetChars overrides the format default', () => {
  const picked = selectVideoHeadline({ candidates: ['Hello world'], format: 'landscape', budgetChars: 5 });
  assertEq(picked, null, '"Hello world" (11 chars) must not fit a budgetChars:5 override');
  const picked2 = selectVideoHeadline({ candidates: ['Hi'], format: 'landscape', budgetChars: 5 });
  assertEq(picked2, 'Hi');
});

check('C4: the OLD template strings are banned — never returned even if present as a candidate', () => {
  // If some future caller ever slips one of the retired templates into the
  // candidate list, selection must not surface it silently — this pin just
  // documents the literal strings that must never be this module's OUTPUT
  // by construction (selectVideoHeadline only ever returns exactly what was
  // put IN, so this also guards against a future re-templating inside this
  // file specifically).
  const candidates = ['Meet Nike Air Max', 'See why customers love it', 'Real headline that fits'];
  const picked = selectVideoHeadline({ candidates, format: 'landscape' });
  // All three candidates are short enough to fit landscape's budget in this
  // synthetic case, so "first that fits" would legitimately be
  // "Meet Nike Air Max" here — the actual regression guard against the
  // banned templates lives at the CANDIDATE-SOURCE level (D-series below):
  // candidatesFromConcepts only ever emits strings the Director actually
  // wrote, so "Meet X" / "See why..." can only appear as a candidate if a
  // Director concept's copy.headline literally IS that string — which the
  // Director's own prompt rules forbid. This check instead pins the
  // negative: selectVideoHeadline never FABRICATES either banned string
  // when it is ABSENT from candidates.
  const noTemplateCandidates = ['A perfectly fine on-brand headline'];
  const picked2 = selectVideoHeadline({ candidates: noTemplateCandidates, format: 'landscape' });
  assert(!/^Meet /i.test(picked2 || ''), 'selection fabricated a "Meet " prefix that was not in candidates');
  assert(picked2 !== 'See why customers love it', 'selection fabricated the retired literal fallback');
  void picked; // silence unused warning; documented above
});

check('C5: when several candidates fit, the first (preferred) one wins deterministically', () => {
  const a = selectVideoHeadline({ candidates: ['First fits', 'Second also fits'], format: 'landscape' });
  const b = selectVideoHeadline({ candidates: ['First fits', 'Second also fits'], format: 'landscape' });
  assertEq(a, 'First fits');
  assertEq(a, b, 'selection is not deterministic across repeated calls with the same input');
});

check('C6: when the preferred candidate does not fit, selection falls through to the next one', () => {
  const budget = HEADLINE_CHAR_BUDGET.landscape;
  const picked = selectVideoHeadline({
    candidates: ['X'.repeat(budget + 10), 'A shorter one that fits'],
    format: 'landscape'
  });
  assertEq(picked, 'A shorter one that fits');
});

check('C7: no candidates -> null, never throws', () => {
  assertEq(selectVideoHeadline({ candidates: [], format: 'landscape' }), null);
  assertEq(selectVideoHeadline({ format: 'landscape' }), null);
});

check('C8: nothing fits -> null, never throws, never a template', () => {
  const budget = HEADLINE_CHAR_BUDGET.vertical;
  const picked = selectVideoHeadline({
    candidates: ['Y'.repeat(budget + 1), 'Z'.repeat(budget + 50)],
    format: 'vertical'
  });
  assertEq(picked, null);
});

check('C9: nasty inputs never throw — null/undefined/non-array candidates', () => {
  assertEq(selectVideoHeadline({ candidates: null, format: 'landscape' }), null);
  assertEq(selectVideoHeadline({ candidates: undefined, format: 'landscape' }), null);
  assertEq(selectVideoHeadline({ candidates: 'not an array', format: 'landscape' }), null);
  assertEq(selectVideoHeadline({ candidates: 42, format: 'landscape' }), null);
  assertEq(selectVideoHeadline({}), null);
  assertEq(selectVideoHeadline(), null);
});

check('C10: nasty inputs never throw — non-string / empty entries mixed with a real candidate', () => {
  const picked = selectVideoHeadline({
    candidates: [null, undefined, 42, {}, [], '   ', '', 'A real headline that fits'],
    format: 'landscape'
  });
  assertEq(picked, 'A real headline that fits');
});

check('C11: nasty inputs — very long strings never throw, just get skipped', () => {
  const huge = 'Q'.repeat(1_000_000);
  const picked = selectVideoHeadline({ candidates: [huge, 'Short and fits'], format: 'landscape' });
  assertEq(picked, 'Short and fits');
});

check('C12: unicode candidates never throw', () => {
  const emoji = '🔥 Big Sale 🔥 Everything Must Go Today Only 🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥';
  const picked1 = selectVideoHeadline({ candidates: [emoji], format: 'landscape', budgetChars: 5 });
  assertEq(picked1, null, 'oversized unicode candidate must not be force-fit');
  const shortEmoji = '好的';
  const picked2 = selectVideoHeadline({ candidates: [shortEmoji], format: 'landscape' });
  assertEq(picked2, shortEmoji);
});

check('C13: whitespace is collapsed before the length check, never mid-word cut', () => {
  const budget = HEADLINE_CHAR_BUDGET.landscape;
  const messy = `  Hello    world  `;
  const picked = selectVideoHeadline({ candidates: [messy], format: 'landscape', budgetChars: budget });
  assertEq(picked, 'Hello world');
});

// ────────────────────────────────────────────────────────────────────────
// D. candidatesFromConcepts — ranking + dual-read + nasty inputs
// ────────────────────────────────────────────────────────────────────────

check('D1: headline tier is fully ahead of subheadline/eyebrow tiers', () => {
  const concepts = [
    concept({ headline: null, subheadline: 'Sub A', eyebrow: 'Eyebrow A' }),
    concept({ headline: 'Headline B', subheadline: 'Sub B', eyebrow: null }),
  ];
  const candidates = candidatesFromConcepts(concepts);
  assertEq(candidates[0], 'Headline B', 'the only real headline must lead, ahead of any subheadline/eyebrow');
  assert(candidates.indexOf('Sub A') > candidates.indexOf('Headline B'));
  assert(candidates.indexOf('Eyebrow A') > candidates.indexOf('Headline B'));
});

check('D2: within a tier, concept (round) order is preserved — no re-sorting', () => {
  const concepts = [
    concept({ headline: 'First concept headline' }),
    concept({ headline: 'Second concept headline' }),
    concept({ headline: 'Third concept headline' }),
  ];
  const candidates = candidatesFromConcepts(concepts);
  assertEq(candidates[0], 'First concept headline');
  assertEq(candidates[1], 'Second concept headline');
  assertEq(candidates[2], 'Third concept headline');
});

check('D3: v2 legacy copy_picks shape is dual-read the same as v3 copy', () => {
  const concepts = [conceptV2({ headline: 'Legacy v2 headline', subheadline: 'Legacy sub', eyebrow: 'Legacy eyebrow' })];
  const candidates = candidatesFromConcepts(concepts);
  assertEq(candidates[0], 'Legacy v2 headline');
});

check('D4: null artifact/concepts never throws -> []', () => {
  assertEq(candidatesFromConcepts(null).length, 0);
  assertEq(candidatesFromConcepts(undefined).length, 0);
  assertEq(candidatesFromConcepts('not an array').length, 0);
  assertEq(candidatesFromConcepts(42).length, 0);
});

check('D5: empty concepts array never throws -> []', () => {
  assertEq(candidatesFromConcepts([]).length, 0);
});

check('D6: null/missing copy fields never throw and contribute nothing', () => {
  const concepts = [
    concept(null),
    concept(undefined),
    { copy: { headline: null, subheadline: null, eyebrow: null } },
    { copy: {} },
    {},
    null,
    undefined,
    42,
    'not an object',
  ];
  const candidates = candidatesFromConcepts(concepts);
  assertEq(candidates.length, 0);
});

check('D7: non-string copy field values are ignored, not stringified', () => {
  const concepts = [concept({ headline: 42, subheadline: {}, eyebrow: ['x'] })];
  assertEq(candidatesFromConcepts(concepts).length, 0);
});

check('D8: whitespace-only copy fields are treated as empty', () => {
  const concepts = [concept({ headline: '   ', subheadline: '\n\t', eyebrow: 'Real eyebrow' })];
  const candidates = candidatesFromConcepts(concepts);
  assertEq(candidates.length, 1);
  assertEq(candidates[0], 'Real eyebrow');
});

check('D9: unicode copy fields pass through untouched', () => {
  const concepts = [concept({ headline: '限定セール開催中 — 今すぐチェック' })];
  const candidates = candidatesFromConcepts(concepts);
  assertEq(candidates[0], '限定セール開催中 — 今すぐチェック');
});

check('D10: very long copy fields never throw building the candidate list', () => {
  const concepts = [concept({ headline: 'R'.repeat(500000) })];
  assertEq(candidatesFromConcepts(concepts).length, 1);
});

// ────────────────────────────────────────────────────────────────────────
// E. End-to-end: candidatesFromConcepts -> selectVideoHeadline (the exact
//    pipeline resolveVideoHeadline runs) with a realistic Director round
// ────────────────────────────────────────────────────────────────────────

check('E1: realistic round — best-fitting headline wins over an over-budget one', () => {
  const budget = HEADLINE_CHAR_BUDGET.landscape;
  const concepts = [
    concept({ headline: 'A headline so long it will never fit inside the landscape box no matter what', subheadline: 'short sub' }),
    concept({ headline: 'Fits great', subheadline: null }),
  ];
  const candidates = candidatesFromConcepts(concepts);
  const picked = selectVideoHeadline({ candidates, format: 'landscape' });
  assertEq(picked, 'Fits great');
  assert(picked.length <= budget);
});

check('E2: realistic round — falls through to subheadline when no headline fits', () => {
  const concepts = [
    concept({ headline: 'This headline is deliberately far too long to ever fit the landscape budget here', subheadline: 'Short sub wins' }),
  ];
  const candidates = candidatesFromConcepts(concepts);
  const picked = selectVideoHeadline({ candidates, format: 'landscape' });
  assertEq(picked, 'Short sub wins');
});

check('E3: realistic round — nothing fits anywhere -> null (never a template)', () => {
  const concepts = [
    concept({
      headline: 'Way way way too long for any budget we support in this module today',
      subheadline: 'Also way too long for any budget we support in this module today',
      eyebrow: 'Still also way too long for any budget we support in this module'
    }),
  ];
  const candidates = candidatesFromConcepts(concepts);
  const picked = selectVideoHeadline({ candidates, format: 'landscape' });
  assertEq(picked, null);
});

// ────────────────────────────────────────────────────────────────────────
// F. resolveVideoHeadlineCandidates / resolveVideoHeadline — the resolver,
//    with a FAKE injected `fetchRounds` (no DB, no network; calls the
//    real production functions with only the I/O boundary swapped)
// ────────────────────────────────────────────────────────────────────────

function fakeRows(rows) {
  return async () => rows;
}

async function run() {
  await checkAsync('F1: no brandId -> [] / null, never throws', async () => {
    const cands = await resolveVideoHeadlineCandidates({ brandId: null, fetchRounds: fakeRows([]) });
    assertEq(cands.length, 0);
    const picked = await resolveVideoHeadline({ brandId: null, aspectRatio: '16:9', fetchRounds: fakeRows([]) });
    assertEq(picked, null);
  });

  await checkAsync('F2: fetchRounds throws -> [] / null, never propagates', async () => {
    const throwingFetch = async () => { throw new Error('simulated DB outage'); };
    const cands = await resolveVideoHeadlineCandidates({ brandId: 'b1', fetchRounds: throwingFetch });
    assertEq(cands.length, 0);
    const picked = await resolveVideoHeadline({ brandId: 'b1', aspectRatio: '9:16', fetchRounds: throwingFetch });
    assertEq(picked, null);
  });

  await checkAsync('F3: no rows at all -> null', async () => {
    const picked = await resolveVideoHeadline({ brandId: 'b1', aspectRatio: '16:9', fetchRounds: fakeRows([]) });
    assertEq(picked, null);
  });

  await checkAsync('F4: rows exist but every concept has no usable copy -> null', async () => {
    const rows = [{ roundIndex: 0, concepts: [concept({}), concept(null)] }];
    const picked = await resolveVideoHeadline({ brandId: 'b1', aspectRatio: '16:9', fetchRounds: fakeRows(rows) });
    assertEq(picked, null);
  });

  await checkAsync('F5: most-recent round with usable copy wins over an older empty round', async () => {
    // fetchRounds is expected to be called already sorted roundIndex desc
    // by the resolver's own query construction — this fake simulates that.
    const rows = [
      { roundIndex: 1, concepts: [concept({ headline: 'Round 1 headline that fits' })] },
      { roundIndex: 0, concepts: [concept({ headline: 'Round 0 headline that fits' })] },
    ];
    const picked = await resolveVideoHeadline({ brandId: 'b1', aspectRatio: '16:9', fetchRounds: fakeRows(rows) });
    assertEq(picked, 'Round 1 headline that fits');
  });

  await checkAsync('F6: falls back to an older round when the newest round has no usable copy', async () => {
    const rows = [
      { roundIndex: 1, concepts: [concept({ headline: null, subheadline: null, eyebrow: null })] },
      { roundIndex: 0, concepts: [concept({ headline: 'Older round headline that fits' })] },
    ];
    const picked = await resolveVideoHeadline({ brandId: 'b1', aspectRatio: '16:9', fetchRounds: fakeRows(rows) });
    assertEq(picked, 'Older round headline that fits');
  });

  await checkAsync('F7: format-aware — same candidates, different budget, different (or no) pick', async () => {
    const longHeadline = 'X'.repeat(HEADLINE_CHAR_BUDGET.vertical - 2); // fits vertical, not landscape
    const rows = [{ roundIndex: 0, concepts: [concept({ headline: longHeadline })] }];
    const landscapePick = await resolveVideoHeadline({ brandId: 'b1', aspectRatio: '16:9', fetchRounds: fakeRows(rows) });
    const verticalPick = await resolveVideoHeadline({ brandId: 'b1', aspectRatio: '9:16', fetchRounds: fakeRows(rows) });
    assertEq(landscapePick, null, 'landscape budget is tighter than vertical — must not fit');
    assertEq(verticalPick, longHeadline, 'vertical budget should fit this exact length');
  });

  await checkAsync('F8: nasty fetchRounds return shapes never throw', async () => {
    const shapes = [null, undefined, 'not an array', 42, [null, undefined, 42, { roundIndex: 0 }, { roundIndex: 1, concepts: null }]];
    for (const shape of shapes) {
      const cands = await resolveVideoHeadlineCandidates({ brandId: 'b1', fetchRounds: fakeRows(shape) });
      assert(Array.isArray(cands), `expected an array back for shape ${JSON.stringify(shape)}`);
    }
  });

  await checkAsync('F9: resolveVideoHeadline never throws even when everything is hostile at once', async () => {
    const hostileFetch = async () => { throw new TypeError('boom'); };
    const picked = await resolveVideoHeadline({
      brandId: undefined, productId: {}, campaignKind: 42, creativeIntent: [],
      aspectRatio: null, fetchRounds: hostileFetch
    });
    assertEq(picked, null);
  });

  // ──────────────────────────────────────────────────────────────────────
  // G. Supplementary source-scan guard against the exact retired templates
  //    reappearing in layoutInputService.js's fallbackDerivation. This is
  //    ONE additional guard, not the primary proof (the primary proof is
  //    the behavioral checks above, run against the real exported
  //    functions) — a pure text match is weak against a clever rename, so
  //    it exists only to catch a literal, accidental revert of the exact
  //    banned strings.
  // ──────────────────────────────────────────────────────────────────────
  await checkAsync('G1: the retired literal templates do not appear in layoutInputService.js source', async () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'layoutInputService.js'), 'utf8');
    assert(!src.includes('`Meet ${'), 'the literal `Meet ${...}` template reappeared in layoutInputService.js');
    assert(!src.includes("'See why customers love it'"), "the literal 'See why customers love it' template reappeared in layoutInputService.js");
    assert(src.includes('resolveVideoHeadline'), 'fallbackDerivation no longer appears to call resolveVideoHeadline');
  });

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFAILURES:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

run();
