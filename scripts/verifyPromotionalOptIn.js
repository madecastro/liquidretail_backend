#!/usr/bin/env node
/**
 * verifyPromotionalOptIn — routing.creative_style="promotional" is OPT-IN.
 *
 * Owner directive 2026-08-12: "strip promotional campaigns being generated at
 * all unless specifically requested."
 *
 * WHY THIS EXISTS AS A HARNESS AND NOT JUST A CODE COMMENT
 * -------------------------------------------------------
 * The style was reachable on every run, and choosing it was a trap: the copy it
 * asks for (an offer, a price, an urgency number) is precisely what
 * validateDirectorPayload rejects UNCONDITIONALLY via its pricing scan. A round
 * that picked it spent a second billable Director call learning a rule the
 * prompt never stated — measured at 19.1s on run_1786555875841_2ddf9739.
 *
 * The narrowing therefore has TWO halves and both are load-bearing:
 *   - buildPromptRound withholds it from the MENU
 *   - buildResponseSchemaRound withholds it from the response-schema ENUM
 * Withholding from only the schema leaves the prompt advertising a style the
 * transport will reject. Withholding from only the prompt leaves a
 * non-compliant model free to emit it. Either half alone RE-CREATES the
 * self-contradictory prompt this change exists to remove — which is the same
 * class of defect as the PR #61 video-prompt rollback in CLAUDE.md 00.
 *
 * Group D is the one that matters most: it asserts the two halves AGREE. A
 * future edit that narrows one and forgets the other fails here rather than in
 * production, one paid round at a time.
 *
 * Offline: no DB, no network, no API key.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'config', 'defaults.env') });

const fs = require('fs');

let failures = 0;
let passed   = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; return; }
  failures++;
  console.log(`  FAIL ${label}`);
  console.log(`      expected: ${JSON.stringify(expected)}`);
  console.log(`      actual:   ${JSON.stringify(actual)}`);
}

const director = require('../services/aiCreativeDirectorService');
const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'aiCreativeDirectorService.js'), 'utf8'
);

// A universe entry shaped enough for buildResponseSchemaRound to build.
const UNIVERSE = [{ mediaId: 'm1', url: 'https://x/1.jpg', fileType: 'image', role: 'catalog', metadata: {} }];

const styleEnumFor = (campaignKind) => {
  const schema = director.buildResponseSchemaRound(UNIVERSE, 'meta_feed_1_1', campaignKind);
  // Walk to routing.creative_style rather than assuming a fixed depth, so a
  // schema reshuffle surfaces as a missing-enum failure instead of a crash.
  const json = JSON.stringify(schema);
  const m = json.match(/"creative_style":\{"type":"string","enum":(\[[^\]]*\])/);
  return m ? JSON.parse(m[1]) : null;
};

// ── A. The helper itself ────────────────────────────────────────────
{
  const ALL = [...director.CREATIVE_STYLES_ENUM];
  check('A1 full enum still contains promotional (the value is not deleted)',
    ALL.includes('promotional'), true);
  check('A2 default (campaignKind null) withholds promotional',
    director.creativeStylesFor(null).includes('promotional'), false);
  check('A3 campaignKind "product" withholds promotional',
    director.creativeStylesFor('product').includes('promotional'), false);
  check('A4 campaignKind "brand" withholds promotional',
    director.creativeStylesFor('brand').includes('promotional'), false);
  check('A5 campaignKind "collection" withholds promotional',
    director.creativeStylesFor('collection').includes('promotional'), false);
  check('A6 [OPT-IN] campaignKind "promotional" ALLOWS promotional',
    director.creativeStylesFor('promotional').includes('promotional'), true);
  // The four non-promotional styles must survive untouched — a narrowing that
  // also drops brand_led would silently collapse every ad onto one template.
  check('A7 narrowing removes EXACTLY one style, nothing else',
    director.creativeStylesFor(null), ALL.filter((s) => s !== 'promotional'));
  check('A8 opt-in path returns the full enum unchanged',
    director.creativeStylesFor('promotional'), ALL);
}

// ── B. Response-schema enum (the transport half) ────────────────────
{
  check('B1 schema enum omits promotional by default',
    (styleEnumFor(null) || []).includes('promotional'), false);
  check('B2 [OPT-IN] schema enum includes promotional for a promotional campaign',
    (styleEnumFor('promotional') || []).includes('promotional'), true);
  check('B3 schema enum still carries the other four styles',
    styleEnumFor(null), ['brand_led', 'ugc_led', 'social_proof_led', 'editorial']);
  check('B4 schema enum is non-empty for every campaign kind',
    ['product', 'brand', 'collection', 'promotional', null]
      .every((k) => (styleEnumFor(k) || []).length >= 4), true);
}

// ── C. Kill switch ──────────────────────────────────────────────────
{
  const prev = process.env.DIRECTOR_PROMOTIONAL_STYLE;
  process.env.DIRECTOR_PROMOTIONAL_STYLE = 'always';
  check('C1 DIRECTOR_PROMOTIONAL_STYLE=always restores promotional on a normal run',
    director.creativeStylesFor('product').includes('promotional'), true);
  check('C2 ...and restores it in the schema enum too',
    (styleEnumFor('product') || []).includes('promotional'), true);
  // A truthy-but-not-"always" value must NOT enable it. Guarding on truthiness
  // would let the literal string "false" from a mis-set dashboard var re-open
  // the exact behaviour this change removes.
  process.env.DIRECTOR_PROMOTIONAL_STYLE = 'false';
  check('C3 [TRAP] the string "false" does NOT enable promotional',
    director.creativeStylesFor('product').includes('promotional'), false);
  process.env.DIRECTOR_PROMOTIONAL_STYLE = 'true';
  check('C4 [TRAP] the string "true" does NOT enable it either (only "always")',
    director.creativeStylesFor('product').includes('promotional'), false);
  process.env.DIRECTOR_PROMOTIONAL_STYLE = '';
  check('C5 blank keeps opt-in',
    director.creativeStylesFor('product').includes('promotional'), false);
  if (prev === undefined) delete process.env.DIRECTOR_PROMOTIONAL_STYLE;
  else process.env.DIRECTOR_PROMOTIONAL_STYLE = prev;
}

// ── D. THE TWO HALVES MUST AGREE ────────────────────────────────────
// The whole point. Source-level, because buildPromptRound needs a full
// inputSummary to execute and a regex is enough to prove the menu lines are
// gated on the same predicate the schema uses.
{
  check('D1 buildPromptRound accepts campaignKind',
    /function buildPromptRound\(\{[^}]*campaignKind/.test(SRC), true);
  check('D2 buildResponseSchemaRound accepts campaignKind',
    /function buildResponseSchemaRound\(\s*seededUniverse\s*,\s*platformFormat[^,]*,\s*campaignKind/.test(SRC), true);
  check('D3 both builders derive their list from creativeStylesFor',
    (SRC.match(/creativeStylesFor\(campaignKind\)/g) || []).length >= 2, true);
  check('D4 the schema enum is built from allowedStyles, NOT the frozen full enum',
    /creative_style:\s*\{ type: 'string', enum: \[\.\.\.allowedStyles\] \}/.test(SRC), true);
  check('D5 [MONEY] no schema site still spreads CREATIVE_STYLES_ENUM directly',
    /enum: \[\.\.\.CREATIVE_STYLES_ENUM\]/.test(SRC), false);
  // Every prompt line naming the promotional style must sit behind the gate.
  // Checked positionally — the guard is a conditional spread on the PRECEDING
  // line, so a regex over the promotional line alone cannot tell a gated line
  // from an ungated one. Assert the guard is actually above each of them.
  const LINES = SRC.split('\n');
  const promoMenuIdx = LINES
    .map((l, i) => (/^\s*`\s*promotional\s*(—|→)/.test(l) ? i : -1))
    .filter((i) => i >= 0);
  check('D6a the promotional prompt lines are still present (opt-in, not deleted)',
    promoMenuIdx.length, 2);
  const ungated = promoMenuIdx.filter((i) => {
    let j = i - 1;
    while (j >= 0 && !LINES[j].trim()) j--;
    return j < 0 || !/allowedStyles\.includes\(PROMOTIONAL_STYLE\)/.test(LINES[j]);
  });
  check('D6b [MONEY] every promotional prompt line is immediately behind the guard',
    ungated.length, 0);
  check('D7 ...and they are emitted via a conditional spread instead',
    (SRC.match(/allowedStyles\.includes\(PROMOTIONAL_STYLE\)\s*\?\s*\[/g) || []).length, 2);
  check('D8 directConceptsRound passes campaignKind to BOTH builders',
    /buildResponseSchemaRound\(seededUniverse, platformFormat, campaignKind\)/.test(SRC), true);
}

// ── E. The pricing ban the style used to contradict ─────────────────
{
  check('E1 the pricing rejection still exists and is unconditional',
    /reasons\.push\(`concepts\[\$\{i\}\]\.copy contains pricing or discount language/.test(SRC), true);
  check('E2 the prompt now STATES the pricing ban',
    /NO PRICING OR DISCOUNT LANGUAGE/.test(SRC), true);
  // Scan PROMPT LINES only, not the whole file. The phrases below are quoted in
  // the explanatory comments on purpose (they are the historical defect being
  // recorded), so a whole-file regex fails on correct code — and "fixing" that
  // by deleting the comment would erase why this harness exists.
  const promptLines = SRC.split('\n').filter((l) => /^\s*`/.test(l.trim()) || /^\s*\?\s*`/.test(l));
  const inPrompt = (re) => promptLines.some((l) => re.test(l));
  check('E3 [REGRESSION] no prompt line still demands "numbers visible"',
    inPrompt(/numbers visible/), false);
  check('E4 [REGRESSION] no prompt line still asks promotional for a price',
    inPrompt(/the offer plus one hard fact: price/), false);
  check('E5 the historical defect is still documented in a comment',
    /numbers visible/.test(SRC), true);
}

if (failures) {
  console.log(`\n❌ verifyPromotionalOptIn: ${failures} FAILED, ${passed} passed`);
  process.exit(1);
}
console.log(`✅ verifyPromotionalOptIn: ${passed} checks passed`);
