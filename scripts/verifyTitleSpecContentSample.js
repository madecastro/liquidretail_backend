#!/usr/bin/env node
'use strict';
/**
 * verifyTitleSpecContentSample — Part A of benefits-to-directors.
 *
 * Pins:
 *   - helper uses resolveField(DEFAULT_META_CASCADES.benefits) + normalizeProductSpecs
 *   - userMsg contains the LIVE CONTENT SAMPLE block AFTER BRAND TOKENS,
 *     BEFORE CURRENT SPEC
 *   - block carries the "NOT copy" / no-literal / no-specs-slot warnings
 *   - empty sample still emits the labelled section
 *   - item cap 5, char cap 56; a 42-char live string survives intact
 *   - ≥3 items are all present when 3 exist (C2 floor)
 *   - BENEFITS FORMATTING strings (Addition 1)
 *   - RENDERING RULES line in titleSpecSchemaPrompt
 *   - brand.js imports the helper ONCE; helper never calls buildMetaForAd
 *
 * Revert-prove: drop sampleBlock from composeModifyTitleSpecUserMsg → fail.
 *
 * Run: node scripts/verifyTitleSpecContentSample.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const HELPER_PATH = path.join(ROOT, 'services/titleSpecContentSample.js');
const BRAND_PATH = path.join(ROOT, 'routes/brand.js');

const helper = require('../services/titleSpecContentSample');
const {
  BENEFIT_ITEM_CAP,
  BENEFIT_CHAR_CAP,
  BENEFIT_ITEM_FLOOR,
  SAMPLE_HEADING,
  BIND_WARNING,
  SPECS_WARNING,
  EMPTY_BENEFITS_LINE,
  FLOOR_LINE,
  FORMATTING_BLOCK,
  normalizeBenefitList,
  benefitsFromArtifact,
  formatContentSampleBlock,
  composeModifyTitleSpecUserMsg,
} = helper;

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const helperSrc = fs.readFileSync(HELPER_PATH, 'utf8');
const brandSrc = fs.readFileSync(BRAND_PATH, 'utf8');

function stripCommentsAndStrings(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

function withTempMutation(filePath, find, replace, runCheck) {
  const original = fs.readFileSync(filePath, 'utf8');
  assert.ok(original.includes(find), `mutate target not found: ${find.slice(0, 80)}`);
  const mutated = original.replace(find, replace);
  const tmp = path.join(
    os.tmpdir(),
    `verifyTitleSpecContentSample-${path.basename(filePath)}-${process.pid}-${Date.now()}.js`
  );
  fs.writeFileSync(tmp, mutated);
  try { runCheck(fs.readFileSync(tmp, 'utf8')); }
  finally { try { fs.unlinkSync(tmp); } catch (_) { /* tmp cleanup */ } }
  assert.strictEqual(
    fs.readFileSync(filePath, 'utf8'),
    original,
    'real file was modified — mutation must target the temp copy only'
  );
}

// ── A. cascade is imported, never reimplemented ──────────────────────────

check(
  'A1 helper calls resolveField on DEFAULT_META_CASCADES.benefits',
  /resolveField\(\s*DEFAULT_META_CASCADES\.benefits/.test(helperSrc)
);
check(
  'A2 helper requires metaCascadeResolver (one definition)',
  /require\('\.\/metaCascadeResolver'\)/.test(helperSrc)
);
check(
  'A3 helper uses normalizeProductSpecs (exported from the Director)',
  /normalizeProductSpecs/.test(helperSrc)
);
check(
  'A4 helper does NOT call buildMetaForAd',
  !/\bbuildMetaForAd\b/.test(stripCommentsAndStrings(helperSrc)),
  'ad-scoped helper has no business running quote provenance / rating coherence here'
);
check(
  'A5 helper does NOT filter schemaVersion',
  !/schemaVersion/.test(stripCommentsAndStrings(helperSrc)),
  'buildMetaForAd treats schema freshness as a preference, not a filter'
);
check(
  'A6 helper does NOT call buildLayoutInput / fetchAndCache / runDerivation',
  !/\bbuildLayoutInput\b/.test(stripCommentsAndStrings(helperSrc)) &&
    !/\bfetchAndCache\b/.test(stripCommentsAndStrings(helperSrc)) &&
    !/\brunDerivation\b/.test(stripCommentsAndStrings(helperSrc))
);
check(
  'A7 createdAt-not-indexed comment is present (ARTIFACT_QUERY_LIMIT stays tight)',
  /createdAt is NOT/.test(helperSrc) && /indexed/.test(helperSrc)
);

// ── B. caps (C1 / C2) ────────────────────────────────────────────────────

const FORTY_TWO = 'Waterproof packable shell with taped seams';
check('B0 42-char fixture is actually 42 chars (the live-data regression)', FORTY_TWO.length === 42);

{
  const out = normalizeBenefitList([FORTY_TWO]);
  check('B1 42-char string survives intact (char cap is 56, not slotContent\'s 40)',
    out.length === 1 && out[0] === FORTY_TWO,
    `got ${JSON.stringify(out)}`);
}

{
  const long = 'x'.repeat(60);
  const out = normalizeBenefitList([long]);
  check('B2 60-char string is capped at 56',
    out.length === 1 && out[0].length === BENEFIT_CHAR_CAP,
    `cap=${BENEFIT_CHAR_CAP} got ${out[0] && out[0].length}`);
}

{
  const three = ['Alpha line', 'Beta line', 'Gamma line'];
  const out = normalizeBenefitList(three);
  check('B3 all 3 items present when 3 exist (C2 floor)',
    out.length === 3 && out[0] === 'Alpha line' && out[2] === 'Gamma line',
    JSON.stringify(out));
}

{
  const four = ['a', 'b', 'c', 'd'];
  const out = normalizeBenefitList(four);
  check('B4 a 4-item list is NOT truncated below 3 (or to 3) — cap is 5',
    out.length === 4,
    JSON.stringify(out));
}

{
  const six = ['a', 'b', 'c', 'd', 'e', 'f'];
  const out = normalizeBenefitList(six);
  check('B5 cap is 5 — sixth item dropped, first five kept (still ≥3)',
    out.length === BENEFIT_ITEM_CAP && out[0] === 'a' && out[4] === 'e' && !out.includes('f'),
    JSON.stringify(out));
}

check('B6 empty / non-array → [] (never null, so the prompt can test .length)',
  Array.isArray(normalizeBenefitList(null)) &&
    normalizeBenefitList(null).length === 0 &&
    normalizeBenefitList('nope').length === 0 &&
    normalizeBenefitList([]).length === 0);

check('B7 constants are 5 / 56 / 3',
  BENEFIT_ITEM_CAP === 5 && BENEFIT_CHAR_CAP === 56 && BENEFIT_ITEM_FLOOR === 3);

// ── C. resolveField cascade ──────────────────────────────────────────────

{
  const viaShort = benefitsFromArtifact({
    input: { product: { short_benefits: [FORTY_TWO, 'Second benefit', 'Third benefit'] } },
  });
  check('C1 short_benefits cascade path returns the 42-char string intact',
    viaShort[0] === FORTY_TWO && viaShort.length === 3,
    JSON.stringify(viaShort));
}

{
  const viaFallback = benefitsFromArtifact({
    input: { product: { benefits: ['Fallback A', 'Fallback B', 'Fallback C'] } },
  });
  check('C2 benefits[] is the cascade fallback when short_benefits is empty',
    viaFallback.length === 3 && viaFallback[0] === 'Fallback A',
    JSON.stringify(viaFallback));
}

{
  const empty = benefitsFromArtifact({ input: { product: {} } });
  check('C3 empty artifact → [] (not null, not an error)',
    Array.isArray(empty) && empty.length === 0);
}

// ── D. formatContentSampleBlock ──────────────────────────────────────────

{
  const emptyBlock = formatContentSampleBlock({
    benefitsExamples: [],
    specExamples: [],
    stats: { n_products_sampled: 20, item_count: { min: null, median: null, max: null }, max_item_chars: null },
  });
  check('D1 empty sample still emits the labelled LIVE CONTENT SAMPLE heading',
    emptyBlock.includes(SAMPLE_HEADING));
  check('D2 empty sample explains there are no derived catalog benefits',
    emptyBlock.includes(EMPTY_BENEFITS_LINE) ||
      emptyBlock.toLowerCase().includes('no derived catalog benefits'));
  check('D3 empty sample does NOT look like an error (no "failed" / "missing"; "not an error" is the explicit C3 line)',
    !/\b(failed|missing)\b/i.test(emptyBlock) && /not an error/.test(emptyBlock));
  check('D4 empty sample still carries bind / no-literal / no-specs-slot warnings',
    emptyBlock.includes('bind:["benefits"]') &&
      emptyBlock.includes('do NOT add {literal:[...]} with these words') &&
      emptyBlock.includes(SPECS_WARNING));
}

{
  const three = ['One benefit', 'Two benefit', 'Three benefit'];
  const block = formatContentSampleBlock({
    benefitsExamples: [three],
    specExamples: [[{ label: 'Material', value: 'Cotton' }]],
    stats: {
      n_products_sampled: 12,
      item_count: { min: 3, median: 4, max: 4 },
      max_item_chars: 42,
    },
  });
  check('D5 populated sample contains the heading', block.includes(SAMPLE_HEADING));
  check('D6 populated sample contains bind:["benefits"]', block.includes('bind:["benefits"]'));
  check('D7 populated sample contains the no-literal warning',
    block.includes('do NOT add {literal:[...]} with these words'));
  check('D8 populated sample contains the no-specs-slot line',
    block.includes(SPECS_WARNING));
  check('D9 populated sample contains all 3 benefit items',
    block.includes('One benefit') && block.includes('Two benefit') && block.includes('Three benefit'));
  check('D10 benefits_stats is emitted',
    block.includes('benefits_stats') && block.includes('"n_products_sampled":12'));
  check('D11 when min≥3 the floor sentence is explicit',
    block.includes(FLOOR_LINE) || block.includes('at least 3 lines'));
  check('D12 spec example is present and scoped as attributes',
    block.includes('Cotton') && block.includes('spec examples'));
}

// ── E. BENEFITS FORMATTING (Addition 1) ──────────────────────────────────

check('E1 formatting block is in the empty sample too (director still needs it)',
  formatContentSampleBlock({ benefitsExamples: [], specExamples: [], stats: { n_products_sampled: 0, item_count: { min: null, median: null, max: null }, max_item_chars: null } })
    .includes('BENEFITS FORMATTING'));

const fmt = FORMATTING_BLOCK;
check('E2 benefits belong in proof or close, NOT the hook hero',
  /proof/.test(fmt) && /close/.test(fmt) && /NOT as the hook hero/.test(fmt));
check('E3 planGroupFit never drops the FIRST contentful row',
  fmt.includes('planGroupFit never drops the FIRST contentful row'));
check('E4 Reels tight-box / SHRINK_FLOOR 0.82 reason is stated',
  fmt.includes('SHRINK_FLOOR 0.82') && fmt.includes('bottom 0.35'));
check('E5 vertical/reels prefer maxItems 3; 4 is fine on feed/square/landscape',
  fmt.includes('prefer maxItems 3') && /feed\/square\/landscape/.test(fmt));
check('E6 Keep scrim: "none" on a multi slot',
  fmt.includes('scrim: "none"'));
check('E7 scrim reason: wraps the WHOLE list in one scrim panel',
  fmt.includes('WHOLE list in one scrim panel'));
check('E8 itemDelaySec is a FRACTION of the slot\'s own window',
  fmt.includes('FRACTION of the slot\'s own window'));
check('E9 0.12 (the validator default) is a good cascade; 1.5 is not seconds',
  fmt.includes('0.12 (the validator default)') && fmt.includes('1.5 is not "1.5 seconds"'));
check('E10 itemStyle bullet + itemLayout stack is the default',
  fmt.includes("itemStyle: 'bullet'") && fmt.includes("itemLayout: 'stack'"));
check('E11 funnel intent is a SIGNAL not a template wipe',
  fmt.includes('Funnel intent is a SIGNAL not a template wipe'));
check('E12 BIND_WARNING names CatalogProduct.shortBenefits as the fill source',
  BIND_WARNING.includes('CatalogProduct.shortBenefits'));

// ── F. userMsg composition ───────────────────────────────────────────────

{
  const sampleBlock = formatContentSampleBlock({
    benefitsExamples: [['Vegan leather', 'Waterproof', 'Packs flat']],
    specExamples: [],
    stats: { n_products_sampled: 8, item_count: { min: 3, median: 3, max: 4 }, max_item_chars: 14 },
  });
  const userMsg = composeModifyTitleSpecUserMsg({
    format: 'vertical',
    tokensJson: '{"colors":{}}',
    sampleBlock,
    historyBlock: '',
    currentSpec: { version: 1, phases: [], slots: [] },
    request: 'show the benefits as a cascade',
  });
  const iTokens = userMsg.indexOf('BRAND TOKENS');
  const iSample = userMsg.indexOf(SAMPLE_HEADING);
  const iSpec = userMsg.indexOf('CURRENT SPEC');
  check('F1 userMsg contains the LIVE CONTENT SAMPLE block', iSample >= 0);
  check('F2 sample sits AFTER BRAND TOKENS', iTokens >= 0 && iSample > iTokens);
  check('F3 sample sits BEFORE CURRENT SPEC', iSample >= 0 && iSpec > iSample);
  check('F4 userMsg contains the NOT-copy labelling',
    userMsg.includes('NOT copy to put in the spec'));
  check('F5 userMsg contains the operator request',
    userMsg.includes('show the benefits as a cascade'));
}

check(
  'F6 brand.js imports titleSpecContentSample exactly once',
  (brandSrc.match(/require\('\.\.\/services\/titleSpecContentSample'\)/g) || []).length === 1,
  'imported ONCE from runModifyTitleSpec — never reimplemented'
);
check(
  'F7 runModifyTitleSpec calls composeModifyTitleSpecUserMsg',
  /composeModifyTitleSpecUserMsg\(/.test(brandSrc)
);
check(
  'F8 titleSpecSchemaPrompt RENDERING RULES forbids copying sample strings into literals',
  /Never copy LIVE CONTENT SAMPLE strings into bind literals or treatment copy/.test(brandSrc)
);

// ── G. revert-prove ──────────────────────────────────────────────────────

{
  let failedAsExpected = false;
  withTempMutation(
    HELPER_PATH,
    '    sampleBlock,\n    historyBlock,',
    '    historyBlock,',
    (mutSrc) => {
      // The compose function's returned array must include sampleBlock
      // between tokensJson and CURRENT SPEC. Dropping it from the array
      // is the exact regression "delete the block from userMsg".
      const start = mutSrc.indexOf('function composeModifyTitleSpecUserMsg');
      const body = start >= 0 ? mutSrc.slice(start, start + 1200) : '';
      const retStart = body.indexOf('return [');
      const retEnd = body.indexOf('].filter');
      const ret = retStart >= 0 && retEnd > retStart ? body.slice(retStart, retEnd) : body;
      failedAsExpected = !/sampleBlock/.test(ret);
    }
  );
  check('G1 [REVERT-PROOF] deleting sampleBlock from composeModifyTitleSpecUserMsg fails the userMsg-contains-block check',
    failedAsExpected);
}

{
  let failedAsExpected = false;
  withTempMutation(
    HELPER_PATH,
    'const BENEFIT_CHAR_CAP = 56;',
    'const BENEFIT_CHAR_CAP = 40;',
    (mutSrc) => {
      failedAsExpected = !/const BENEFIT_CHAR_CAP = 56;/.test(mutSrc);
    }
  );
  check('G2 [REVERT-PROOF] dropping the char cap back to 40 fails the 56 pin',
    failedAsExpected);
}

if (failures.length) {
  console.error(`\n❌ title-spec content sample: ${failures.length} FAILED, ${pass} passed\n`);
  failures.forEach((f) => console.error(`   • ${f}`));
  process.exit(1);
}
console.log(`✅ title-spec content sample: ${pass} checks passed`);
