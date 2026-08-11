#!/usr/bin/env node
/**
 * Offline harness for the ad-usable quote retrieval directive (2026-08-10).
 * No DB, no network, no API key.
 *
 * WHY THIS EXISTS. All three grounded quote lookups asked neutral reputation-research
 * questions ("what real customers say", "how reviewers feel") with no positivity bar,
 * no exclusions, and a 4-6 quote ask capped at 6 in code. Measured on Vuori: of 6
 * stored brand quotes, 2 were openly negative ("returned everything", "very thin
 * material and very cheap... scams companies"), 3 were about a different product
 * category (pants/joggers, on a shirt-jacket ad), and the one that printed carried
 * "They go on flash sale and/or 20% off" — a promotional claim nobody chose to make.
 * The ad path effectively had ONE usable quote and printed it on every creative.
 *
 * Owner directive: *"The goal is to find positive statements that help us achieve our
 * goals at different stages of the funnel as well as retention and conquest. Negative
 * statements are not wanted, nor are neutral statements."* / *"statements should be
 * complimentary and complementary to the brand in every sense of the word."*
 *
 * THE RISK THIS HARNESS GUARDS MOST. Asking a model for only-flattering quotes creates
 * direct pressure to embellish or invent a reviewer, and these quotes are stamped
 * origin:'llm-web' and can be typeset verbatim into a PAID ad. So the "RETURN FEWER /
 * never invent" counterweight and the untouched render-side gates are pinned here as
 * hard requirements, not style preferences. If a future edit strengthens the
 * positivity ask and drops that counterweight, this suite must fail.
 *
 * Run: node scripts/verifyQuoteRetrievalDirective.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// The REAL exported directive, not a copy of its wording.
const { AD_USABLE_QUOTE_DIRECTIVE, LLM_QUOTE_CAP } = require('../services/providers/geminiSearchProvider');

const SRC_PROV = path.join(__dirname, '..', 'services', 'providers', 'geminiSearchProvider.js');
const SRC_CAT  = path.join(__dirname, '..', 'services', 'categoryReviewsService.js');
const SRC_LI   = path.join(__dirname, '..', 'services', 'layoutInputService.js');
const provSrc = fs.readFileSync(SRC_PROV, 'utf8');
const catSrc  = fs.readFileSync(SRC_CAT, 'utf8');
const liSrc   = fs.readFileSync(SRC_LI, 'utf8');

let pass = 0, fail = 0;
const check = (label, fn) => {
  try { fn(); pass++; }
  catch (e) { fail++; console.log(`   • ${label} — ${String(e.message).split('\n')[0].slice(0, 220)}`); }
};
const D = String(AD_USABLE_QUOTE_DIRECTIVE || '');

console.log('\nD. The directive says what the owner asked for');

check('D1 positive-only: negative AND neutral are both rejected', () => {
  assert.ok(/COMPLIMENTARY/i.test(D), 'must require complimentary statements');
  assert.ok(/NEUTRAL/i.test(D), 'must explicitly reject neutral statements, not just negative ones');
  assert.ok(/negative/i.test(D), 'must explicitly reject negative statements');
});
check('D2 complementary to the brand (the second sense of the word)', () => {
  assert.ok(/COMPLEMENTARY/i.test(D), 'must require the quote to reinforce brand positioning');
});
check('D3 excludes the claim classes that caused this (price/promo first)', () => {
  for (const term of ['price', 'discount', 'sale', 'coupon', 'promo']) {
    assert.ok(new RegExp(term, 'i').test(D), `exclusion list missing "${term}" — the Vuori quote carried a 20% off claim`);
  }
  for (const term of ['shipping', 'return', 'customer service', 'runs small', 'competitor']) {
    assert.ok(new RegExp(term, 'i').test(D), `exclusion list missing "${term}"`);
  }
});
check('D4 all five stages incl. retention AND conquest', () => {
  for (const stage of ['awareness', 'consideration', 'conversion', 'retention', 'conquest']) {
    assert.ok(new RegExp(stage, 'i').test(D), `stage "${stage}" missing from the directive`);
  }
});
check('D5 conquest rejects disparagement of the replaced product, named OR not', () => {
  // Stronger than the original "WITHOUT naming the other brand": both adversarial
  // passes showed name-omission is insufficient, because "finally something that
  // doesn't fall apart" is still a comparative attack on an unnamed rival.
  assert.ok(/even unnamed/i.test(D), 'must reject implicit knocks at an unnamed rival');
  assert.ok(/Describe only what THIS product does well/i.test(D),
    'conquest must be framed positively about this product');
});
check('D6 THE FABRICATION COUNTERWEIGHT — return fewer, never invent', () => {
  assert.ok(/VERBATIM, OR NOTHING/i.test(D), 'the verbatim rule must be stated as an absolute');
  assert.ok(/outranks every other rule/i.test(D),
    'the verbatim rule must explicitly outrank the positivity and coverage asks');
  assert.ok(/never invent/i.test(D), 'must forbid inventing a reviewer');
  assert.ok(/RETURN FEWER/i.test(D),
    'the positivity ask MUST be paired with permission to return fewer — otherwise it is pressure to fabricate');
  assert.ok(/empty list/i.test(D), 'an empty result must be explicitly correct');
  assert.ok(/paraphrase/i.test(D), 'must forbid paraphrasing');
});
check('D7 each quote must stand alone (it is typeset with no context)', () => {
  assert.ok(/READ AS COMPLETE on its own/i.test(D),
    'fragments needing context produce the "feel like second skin" defect');
});

console.log('P. All three retrieval prompts use the ONE directive');

check('P1 brand, product and category all reference the shared constant', () => {
  const uses = (provSrc.match(/\$\{AD_USABLE_QUOTE_DIRECTIVE\}/g) || []).length;
  assert.strictEqual(uses, 2, `brand+product should interpolate the directive twice, found ${uses}`);
  assert.ok(/\$\{AD_USABLE_QUOTE_DIRECTIVE\}/.test(catSrc), 'category prompt does not use the shared directive');
});
check('P2 category IMPORTS it rather than restating (and the import resolves)', () => {
  assert.ok(/require\('\.\/providers\/geminiSearchProvider'\)/.test(catSrc),
    'category must import the directive — a fourth copy would drift');
  // Proven at runtime by this file loading the module above, but assert the
  // symbols are actually destructured, not just the module required.
  assert.ok(/AD_USABLE_QUOTE_DIRECTIVE/.test(catSrc) && /LLM_QUOTE_CAP/.test(catSrc),
    'category must destructure both shared symbols');
});
check('P3 the old neutral framing is gone from every prompt', () => {
  assert.ok(!/what real customers say about the BRAND/.test(provSrc) || /AD_USABLE_QUOTE_DIRECTIVE/.test(provSrc),
    'brand prompt still purely neutral');
  assert.ok(!/summary of how reviewers feel\s*`/.test(provSrc),
    'a prompt still asks only "how reviewers feel" with no ad-usability bar');
});
check('P4 rating + summary stay HONEST (internal signal, never ad copy)', () => {
  const honest = (provSrc.match(/must stay HONEST/g) || []).length;
  assert.ok(honest >= 2, `brand+product must both keep an honest-summary carve-out, found ${honest}`);
  assert.ok(/must stay HONEST/.test(catSrc), 'category must keep the honest-summary carve-out');
  assert.ok(/INCLUDING any recurring complaints/.test(provSrc),
    'the summary must still surface complaints — it is how we decide whether a claim is safe at all');
});

console.log('C. The pool is actually wider (the cap was the real ceiling)');

check('C1 NO path still hardcodes 6 — provider AND category', () => {
  // Was provider-only, and both adversarial passes caught the same false green:
  // categoryReviewsService still had .slice(0, 6) after importing LLM_QUOTE_CAP,
  // so the "shared cap" story was untrue on that path while the suite passed.
  assert.ok(!/rows\.slice\(0,\s*6\)/.test(provSrc),
    'stampLlmQuotes still truncates to 6 — asking for more quotes would silently discard them');
  assert.ok(/rows\.slice\(0,\s*LLM_QUOTE_CAP\)/.test(provSrc), 'cap must be the shared constant');
  assert.ok(!/\.slice\(0,\s*6\)/.test(catSrc),
    'categoryReviewsService still caps at 6 — the cap raise is a no-op there');
  assert.ok(/\.slice\(0,\s*LLM_QUOTE_CAP\)/.test(catSrc), 'category must use the shared cap');
});
check('C2 cap is >= 8 and env-tunable, rejecting junk', () => {
  assert.ok(LLM_QUOTE_CAP >= 8, `cap is ${LLM_QUOTE_CAP} — too small to give stage selection a choice`);
  assert.ok(/process\.env\.LLM_QUOTE_CAP/.test(provSrc), 'cap should be env-tunable');
  // Stronger than >0: 0.1 made slice(0, 0.1) return [] forever and Infinity
  // removed the bound entirely. Must be a positive INTEGER in a sane band.
  assert.ok(/Number\.isInteger\(n\)/.test(provSrc), 'cap must require an integer');
  assert.ok(/n <= 40/.test(provSrc), 'cap must have an upper bound');
});
check('C3 the stage tag survives pass 2 (both schemas carry it)', () => {
  const schemaHits = (provSrc.match(/stage:\s*\{\s*type:\s*'string',\s*nullable:\s*true\s*\}/g) || []).length;
  assert.strictEqual(schemaHits, 2, `both brand+product JSON schemas must carry stage, found ${schemaHits}`);
  const hintHits = (provSrc.match(/"stage":\s*"awareness\|consideration\|conversion\|retention\|conquest/g) || []).length;
  assert.strictEqual(hintHits, 2, `both prompt shape hints must ask for stage, found ${hintHits}`);
  // Category pass 2 dropped stage entirely, so its labels never persisted.
  assert.ok(/"stage":/.test(catSrc), 'category pass-2 shape must carry stage or the label is discarded');
});
check('C4 extra quote fields are preserved through stamping', () => {
  assert.ok(/Object\.assign\(\{\},\s*q,/.test(provSrc),
    'stampLlmQuotes must spread the source row so stage/author/source survive');
});

console.log('F. Fabrication is blocked in CODE, not just in the prompt');

check('F1 every path drops quotes not verbatim in the grounded narrative', () => {
  assert.ok(/function keepVerbatimQuotes/.test(provSrc),
    'the shared substring validator is missing');
  const wired = (provSrc.match(/keepVerbatimQuotes\(parsed\.quotes/g) || []).length;
  assert.strictEqual(wired, 2,
    `brand AND product must both run the validator, found ${wired} — this was open on both paths ` +
    'while only category had the check');
  assert.ok(/narrNorm\.includes\(qNorm\)/.test(provSrc) || /narrNorm\.includes\(qNorm\)/.test(catSrc),
    'substring enforcement missing');
});
check('F2 pass 2 restates the substring rule (it is a separate generation)', () => {
  const restated = (provSrc.match(/verbatim substring of the narrative/g) || []).length;
  assert.ok(restated >= 2, `brand+product pass 2 must restate the rule, found ${restated}`);
  assert.ok(!/Use direct quotes verbatim from the narrative; do NOT paraphrase or invent/.test(provSrc),
    'the weaker pre-change pass-2 wording is still present');
});
check('F3 RULE 0 outranks stage coverage (no quota-driven invention)', () => {
  assert.ok(/RULE 0/.test(D), 'the verbatim rule should be stated first and named');
  assert.ok(/stage coverage.{0,40}NEVER/is.test(D) || /never.{0,80}stage coverage/is.test(D),
    'stage coverage must be explicitly subordinate to the verbatim rule');
  assert.ok(/labelling task, never a quota/i.test(D),
    'stage labelling must be framed as labelling, not a quota to fill');
});
check('F4 completeness is a SELECTION test, not licence to repair a fragment', () => {
  assert.ok(/SELECTION test/i.test(D),
    'the stand-alone requirement must not read as permission to complete a fragment');
  assert.ok(/had to repair is a quote you must discard/i.test(D), 'the discard-not-fix rule is missing');
});

console.log('B. Brand-safety claim classes');

check('B1 regulated claim classes are excluded', () => {
  for (const t of ['HEALTH', 'SUPERLATIVE', 'ABSOLUTE', 'GUARANTEE', 'SAFETY', 'SUSTAINABILITY']) {
    assert.ok(new RegExp(t, 'i').test(D), `claim class "${t}" missing — it becomes an unsubstantiated ad claim once typeset`);
  }
  for (const t of ['doctor', 'lasts forever', 'non-toxic', 'lifetime guarantee', 'best on the market']) {
    assert.ok(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(D), `example "${t}" missing from the exclusion list`);
  }
  assert.ok(/CHILD/i.test(D), 'child-related quotes must be excluded');
});
check('B2 conquest rejects implicit knocks, not just named rivals', () => {
  assert.ok(/even unnamed/i.test(D),
    'a switch quote disparaging an UNNAMED rival is still comparative advertising');
  assert.ok(/doesn't fall apart|falls apart|pills/i.test(D), 'the concrete implicit-knock examples are missing');
});
check('B3 category prompt no longer few-shots the banned patterns', () => {
  // COMMENTS STRIPPED FIRST. The rationale for removing these examples necessarily
  // NAMES them, and it lives in a code comment right beside the prompt — so a raw
  // source-region check fails on its own explanation. Only the prompt STRING matters
  // here: what the model actually reads. (CLAUDE.md §0.29998: source pins must strip
  // comments and assert proximity.)
  const i = catSrc.indexOf('const searchPrompt =');
  const j = catSrc.indexOf('let searchRes', i);
  assert.ok(i !== -1 && j > i, 'category searchPrompt region not found');
  const promptOnly = catSrc.slice(i, j)
    .split('\n')
    .filter(l => !l.trim().startsWith('//'))
    .join('\n');
  assert.ok(!/fishing shirt I've owned/.test(promptOnly),
    'the superlative example still seeds the prompt string');
  assert.ok(!/last forever/.test(promptOnly),
    'the absolute-durability example still seeds the prompt string — few-shot beats a rule list');
  // And the rationale must survive somewhere, so nobody re-adds them.
  assert.ok(/NO EXAMPLE PHRASINGS HERE/.test(catSrc),
    'keep the comment explaining why examples are absent');
});

console.log('G. Render-side gates are UNTOUCHED (defence in depth)');

check('G1 negative/limiter disqualifiers still exist downstream', () => {
  assert.ok(/NEGATIVE_SENTIMENT/.test(liSrc), 'the negative-sentiment disqualifier must remain');
  assert.ok(/HARD_LIMITER/.test(liSrc), 'the hard-limiter disqualifier must remain');
  assert.ok(/function hasPositiveSignal/.test(liSrc), 'hasPositiveSignal must remain');
});
check('G2 the directive does NOT claim to replace those gates', () => {
  // Guards against a future edit that relaxes render-side checks on the grounds
  // that "retrieval already filters" — retrieval is an LLM, the gates are code.
  assert.ok(/defence in depth/i.test(provSrc),
    'the module should record that retrieval improves the pool but does not replace the render gates');
});

const total = pass + fail;
if (fail === 0) {
  console.log(`\n✅ verifyQuoteRetrievalDirective: ${pass}/${total} checks passed\n`);
  process.exit(0);
}
console.log(`\n❌ verifyQuoteRetrievalDirective: ${fail} FAILED, ${pass} passed\n`);
process.exit(1);
