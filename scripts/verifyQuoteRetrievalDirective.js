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
const {
  AD_USABLE_QUOTE_DIRECTIVE,
  LLM_QUOTE_CAP,
  // The SHIPPED functions, executed below. Sections H/I are behavioural on
  // purpose: the same mirror-seam lesson as PR #120 — a harness that reimplements
  // the logic it is testing passes against a reimplementation and proves nothing.
  keepVerbatimQuotes,
  completeSentencesOnly,
  GROUNDED_PASS1_CONFIG,
  GROUNDED_PASS2_MAX_TOKENS,
  GROUNDED_CALL_TIMEOUT_MS,
  warnIfTruncated,
  screenAdUsableSentiment,
  loadSentimentJudge,
  pickBestRating,
  RATING_MIN_CREDIBLE_REVIEWS
} = require('../services/providers/geminiSearchProvider');
const { preserveBrandReviewNumbers } = require('../services/brandEnrichmentService');

const SRC_PROV = path.join(__dirname, '..', 'services', 'providers', 'geminiSearchProvider.js');
const SRC_CAT  = path.join(__dirname, '..', 'services', 'categoryReviewsService.js');
const SRC_LI   = path.join(__dirname, '..', 'services', 'layoutInputService.js');
const SRC_BE   = path.join(__dirname, '..', 'services', 'brandEnrichmentService.js');
const provSrc = fs.readFileSync(SRC_PROV, 'utf8');
const catSrc  = fs.readFileSync(SRC_CAT, 'utf8');
const liSrc   = fs.readFileSync(SRC_LI, 'utf8');
const beSrc   = fs.readFileSync(SRC_BE, 'utf8');
const SRC_PM  = path.join(__dirname, '..', 'services', 'productMatchService.js');
const pmSrc   = fs.readFileSync(SRC_PM, 'utf8');
const { completeSentencePrefix, endsOnSentenceStop } = require('../utils/htmlEntities');
// Comments stripped once, reused by the source pins below. A pin that matches its
// own explanatory comment cannot fail (CLAUDE.md §0.29998).
const stripComments = (src) => src.split('\n')
  .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
  .join('\n');
const beCode  = stripComments(beSrc);
const pmCode  = stripComments(pmSrc);

let pass = 0, fail = 0;
const check = (label, fn) => {
  try { fn(); pass++; }
  catch (e) { fail++; console.log(`   • ${label} — ${String(e.message).split('\n')[0].slice(0, 220)}`); }
};
// The shipped functions log their decisions; silence that so a green run is readable.
const quiet = (fn) => {
  const w = console.warn, l = console.log;
  console.warn = () => {}; console.log = () => {};
  try { return fn(); } finally { console.warn = w; console.log = l; }
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


console.log('H. A quote can never be typeset mid-sentence (BEHAVIOURAL, live defect 2026-08-11)');

// The exact string the first post-deploy Pelagic enrichment returned. It is a genuine
// verbatim substring of the grounded narrative — keepVerbatimQuotes cannot catch it —
// and it ends on a preposition. This is the "feel like second skin" defect again.
const PELAGIC_RAW = "Love these new T's. These new T's Pelagic has are so freaking soft. "
  + "Here in San Diego, we've had screaming high temps the last few weeks and these have "
  + "been keeping me cool in my";
const PELAGIC_WANT = "Love these new T's. These new T's Pelagic has are so freaking soft.";

check('H1 the live Pelagic quote is trimmed back to its last complete sentence', () => {
  const out = quiet(() => completeSentencesOnly({ text: PELAGIC_RAW }, 'h1'));
  assert.ok(out, 'must keep the quote, not drop it — it has two good sentences');
  assert.strictEqual(out.text, PELAGIC_WANT, `got: ${out && out.text}`);
});
check('H2 trimming is SELECTION, not repair — the result is still verbatim', () => {
  const out = quiet(() => completeSentencesOnly({ text: PELAGIC_RAW }, 'h2'));
  assert.ok(PELAGIC_RAW.includes(out.text),
    'the kept text must be a literal substring of the source — no word may be added or reordered');
  assert.ok(endsOnSentenceStop(out.text), 'the kept text must satisfy the production end-of-sentence test');
});
check('H3 an already-complete quote is returned untouched (same object)', () => {
  const q = { text: 'The quality and fit are amazing!', rating: 5 };
  const out = quiet(() => completeSentencesOnly(q, 'h3'));
  assert.strictEqual(out, q, 'no-op case must not clone or rewrite');
});
check('H4 a quote that never completes a sentence is DROPPED, not padded', () => {
  const out = quiet(() => completeSentencesOnly({ text: 'so soft and comfortable and' }, 'h4'));
  assert.strictEqual(out, null, 'nothing honest can be trimmed out of it');
});
check('H5 a trailing closing quote/bracket still counts as an ending', () => {
  for (const t of ['"These are incredible."', 'Best purchase of the year!)', 'Love them…']) {
    const out = quiet(() => completeSentencesOnly({ text: t }, 'h5'));
    assert.ok(out && out.text === t, `should be untouched: ${t}`);
  }
});
check('H6 other quote fields survive the trim', () => {
  const out = quiet(() => completeSentencesOnly(
    { text: PELAGIC_RAW, source: 'reddit.com', stage: 'consideration', scope: 'brand' }, 'h6'));
  assert.strictEqual(out.source, 'reddit.com');
  assert.strictEqual(out.stage, 'consideration');
  assert.strictEqual(out.scope, 'brand');
});
check('H7 the guard is WIRED into keepVerbatimQuotes, not just defined', () => {
  // End-to-end through the shipped filter: a narrative containing the raw fragment
  // must still yield only the completed sentences.
  const narrative = `Reviewers on Reddit wrote: "${PELAGIC_RAW}" and the hat gets praise too.`;
  const out = quiet(() => keepVerbatimQuotes([{ text: PELAGIC_RAW }], narrative, 'h7'));
  assert.strictEqual(out.length, 1, 'the quote should be kept, trimmed');
  assert.strictEqual(out[0].text, PELAGIC_WANT, `got: ${out[0] && out[0].text}`);
});
check('H8 the anti-fabrication check still runs FIRST and independently', () => {
  // Completeness must not become a way in for invented text: a well-formed sentence
  // that is absent from the narrative is still dropped.
  const out = quiet(() => keepVerbatimQuotes(
    [{ text: 'This is a perfectly complete sentence nobody ever wrote.' }],
    'A narrative about something else entirely.', 'h8'));
  assert.strictEqual(out.length, 0, 'fabrication must still be rejected');
});

check('H9 a trim must not INVERT the sentiment (END-TO-END through the pipeline)', () => {
  // The nastiest failure this fix could have introduced: each of these trims to a
  // complete, VERBATIM sentence that is a fabricated NEGATIVE endorsement. Asserted
  // through keepVerbatimQuotes rather than the sub-function, because sentiment is
  // judged by one unconditional screen at the end of the pipeline — testing the stage
  // in isolation would assert the wrong contract.
  for (const t of [
    'I hated the old ones. These are great and soft',
    'Not for everyone. I love them and wear',
    'The first pair was terrible. This one is perfect and I',
  ]) {
    const out = quiet(() => keepVerbatimQuotes([{ text: t }], `narrative: ${t}`, 'h9'));
    assert.strictEqual(out.length, 0, `must not reach an ad: ${JSON.stringify(t)}`);
  }
});
check('H11 an abbreviation is not a sentence end', () => {
  // "Absolutely love Dr." is the ad this guard exists to prevent.
  for (const t of [
    'Absolutely love Dr. Bronners products and the scent is',
    'Dr. Jones and Mrs. Smith love these shoes and',
    'Great for 5 a.m. runs and these work well',
    'Ships fast from the U.S. and fit perfectly but',
  ]) {
    const out = quiet(() => completeSentencesOnly({ text: t }, 'h11'));
    assert.strictEqual(out, null, `must not trim at the abbreviation: ${JSON.stringify(t)}`);
  }
});
check('H12 a short-but-whole opening sentence is KEPT, not floored away', () => {
  // The pool was just widened on purpose; a 15-char floor applied AFTER the trim
  // threw away usable praise the pre-trim floor had already cleared.
  const a = quiet(() => completeSentencesOnly({ text: 'Love it! Softest fabric I have ever worn and' }, 'h12'));
  assert.ok(a && a.text === 'Love it!', `got ${a && a.text}`);
  const b = quiet(() => completeSentencesOnly({ text: 'Perfect fit. Comfortable all day and the' }, 'h12'));
  assert.ok(b && b.text === 'Perfect fit.', `got ${b && b.text}`);
});
check('H13 one-word scraps are still refused', () => {
  for (const t of ['It. and then some more trailing words here', 'Wow']) {
    assert.strictEqual(quiet(() => completeSentencesOnly({ text: t }, 'h13')), null,
      `must not print a scrap: ${JSON.stringify(t)}`);
  }
});
check('H14 the shared helper returns a literal prefix and nothing else (fuzz)', () => {
  // The whole safety argument rests on this property, so assert it over many shapes
  // rather than the one live example.
  const bits = ['These are amazing.', ' I love them!', ' Bought two more…', ' Soft and warm', ' Dr. Smith agrees.', ' 5 a.m. runs'];
  for (let i = 0; i < 200; i++) {
    let t = '';
    for (let k = 0; k <= i % 6; k++) t += bits[(i + k) % bits.length];
    const out = completeSentencePrefix(t);
    // The contract is a literal prefix of the TRIMMED source — that is what makes
    // "selection, not repair" checkable rather than a claim in a comment.
    assert.ok(out === '' || t.trim().startsWith(out), `not a prefix of the source: ${JSON.stringify(out)}`);
    if (out) assert.ok(endsOnSentenceStop(out), `kept text does not end a sentence: ${JSON.stringify(out)}`);
  }
});
check('H15 the shared helper is linear on adversarial input (no ReDoS)', () => {
  // This runs on LLM output on a request path.
  const blob = `${'a.b.c.'.repeat(4000)}!`.slice(0, 24000);
  const t0 = process.hrtime.bigint();
  completeSentencePrefix(blob, 140);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 250, `took ${ms.toFixed(1)}ms on 24k chars — check for backtracking`);
});
check('H16 the CATEGORY path gets the same guard, not its own copy', () => {
  // It carried a private substring check and therefore no completeness protection —
  // the same mid-clause quote could ship from category-scoped retrieval.
  assert.ok(/keepVerbatimQuotes/.test(catSrc),
    'categoryReviewsService must route through the shared verbatim+completeness filter');
  const cat = stripComments(catSrc);
  assert.ok(!/narrNorm\.includes\(qNorm\)/.test(cat),
    'the private substring copy is still live — two implementations will drift');
});

console.log('I. A refresh may replace quotes but must never erase the numbers (BEHAVIOURAL)');

check('I1 rating/count/summary are carried when the fresh fetch has none', () => {
  const fresh = { quotes: [{ text: 'fresh one' }], rating: null, reviewCount: null, summary: null };
  quiet(() => preserveBrandReviewNumbers(fresh, { rating: 3.2, reviewCount: 22, summary: 'stored' }));
  assert.strictEqual(fresh.rating, 3.2, 'the live Pelagic loss: 3.2★ must survive');
  assert.strictEqual(fresh.reviewCount, 22);
  assert.strictEqual(fresh.summary, 'stored');
});
check('I2 a fresh number always wins — including a LOWER one', () => {
  const fresh = { rating: 2.1, reviewCount: 5, summary: 'new summary' };
  quiet(() => preserveBrandReviewNumbers(fresh, { rating: 4.8, reviewCount: 900, summary: 'old' }));
  assert.strictEqual(fresh.rating, 2.1, 'this preserves data, it must not flatter it');
  assert.strictEqual(fresh.reviewCount, 5);
  assert.strictEqual(fresh.summary, 'new summary');
});
check('I3 quotes are still replaced WHOLESALE (the retrieval fix must take effect)', () => {
  const fresh = { quotes: [{ text: 'newly filtered' }], rating: null };
  quiet(() => preserveBrandReviewNumbers(fresh, { quotes: [{ text: 'old negative one' }], rating: 4.0 }));
  assert.strictEqual(fresh.quotes.length, 1);
  assert.strictEqual(fresh.quotes[0].text, 'newly filtered',
    'stale quotes must NOT be carried forward — that would defeat the positivity directive');
});
check('I4 an empty-string summary counts as absent, a 0 count does not', () => {
  const a = { summary: '', rating: null, reviewCount: 0 };
  quiet(() => preserveBrandReviewNumbers(a, { summary: 'stored', rating: 4.4, reviewCount: 10 }));
  assert.strictEqual(a.summary, 'stored', "'' is not a summary");
  assert.strictEqual(a.reviewCount, 0, '0 is a real measurement and must not be overwritten');
});
check('I5 no prior / non-object prior is a safe no-op', () => {
  for (const prior of [null, undefined, 'nope', 7]) {
    const fresh = { rating: null, reviewCount: null };
    quiet(() => preserveBrandReviewNumbers(fresh, prior));
    assert.strictEqual(fresh.rating, null);
  }
  assert.strictEqual(quiet(() => preserveBrandReviewNumbers(null, { rating: 5 })), null);
});
check('I6 the merge is WIRED at the persist site, before the assignment', () => {
  // Source pin, comments stripped: the extracted function must actually be called on
  // the path that writes brand.brandReviews, and called BEFORE the wholesale replace.
  const code = beSrc.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  const call = code.indexOf('preserveBrandReviewNumbers(brandReviewsResult');
  const write = code.indexOf('brand.brandReviews = brandReviewsResult');
  assert.ok(call !== -1, 'the persist site must call preserveBrandReviewNumbers');
  assert.ok(write !== -1 && call < write, 'it must run BEFORE brand.brandReviews is replaced');
});
check('I7 the numbers-only persist predicate is still in place', () => {
  // The sibling half of this fix (already shipped): a result with numbers but no
  // quotes must still save, or there is nothing for I1 to preserve next time.
  assert.ok(/hasQuotes \|\| hasNumbers/.test(beCode),
    'the widened persist predicate must remain — numbers-only results have to be stored');
});

check('I8 a PARTIAL fresh snapshot is never completed from the stored one', () => {
  // The blocker an adversarial pass found. brandStarFloorForCount drops the star
  // floor from 4.39 to 4.19 once the count clears 5000, so a stale rating paired
  // with a fresh high count can print stars the real snapshot never earned.
  const a = { rating: null, reviewCount: 6000 };
  quiet(() => preserveBrandReviewNumbers(a, { rating: 4.3, reviewCount: 22 }));
  assert.strictEqual(a.rating, null, 'a 22-review rating must NOT be paired with a 6000 count');
  assert.strictEqual(a.reviewCount, 6000);
  const b = { rating: 4.5, reviewCount: null };
  quiet(() => preserveBrandReviewNumbers(b, { rating: 3.2, reviewCount: 22 }));
  assert.strictEqual(b.reviewCount, null, 'a fresh rating must not borrow a stale count');
  assert.strictEqual(b.rating, 4.5);
});
check('I9 the pair is carried TOGETHER when the fetch supplies neither', () => {
  const a = { quotes: [{ text: 'x' }], rating: null, reviewCount: null };
  quiet(() => preserveBrandReviewNumbers(a, { rating: 4.6, reviewCount: 15545 }));
  assert.strictEqual(a.rating, 4.6);
  assert.strictEqual(a.reviewCount, 15545, 'both halves come from the same snapshot or neither does');
});
check('I10 NaN is not data — it must not win over a stored number', () => {
  // typeof NaN === 'number', so a naive check stores NaN and every star floor
  // comparison then silently returns false.
  const a = { rating: NaN, reviewCount: NaN };
  quiet(() => preserveBrandReviewNumbers(a, { rating: 4.6, reviewCount: 15545 }));
  assert.strictEqual(a.rating, 4.6, 'NaN must be treated as absent');
  assert.strictEqual(a.reviewCount, 15545);
});
check('I11 carried numbers record their own age, not the quote fetch time', () => {
  const priorAt = new Date('2026-06-01T00:00:00Z');
  const a = { rating: null, reviewCount: null, fetchedAt: new Date('2026-08-11T00:00:00Z') };
  quiet(() => preserveBrandReviewNumbers(a, { rating: 4.6, reviewCount: 999, fetchedAt: priorAt }));
  assert.ok(a.numbersFetchedAt, 'a carried aggregate must not look freshly measured');
  assert.strictEqual(new Date(a.numbersFetchedAt).getTime(), priorAt.getTime(),
    'numbersFetchedAt must be when the NUMBERS were measured');
});
check('I12 the wiring pin covers the REAL prior object, not any second argument', () => {
  // Mutation this replaces: `preserveBrandReviewNumbers(brandReviewsResult, null)`
  // left the old pin green while restoring the bug in full.
  assert.ok(/preserveBrandReviewNumbers\(brandReviewsResult,\s*brand\.brandReviews\)/.test(beCode),
    'the enrichment persist site must pass the STORED reviews as the prior');
});
check('I13 the SECOND write path is wired too (productMatchService)', () => {
  // Found by adversarial review: this path also replaced brandReviews wholesale, so
  // fixing only enrichment left the identical data loss reachable from every match.
  assert.ok(/preserveBrandReviewNumbers/.test(pmCode),
    'productMatchService still replaces brandReviews wholesale');
  const call  = pmCode.indexOf('preserveBrandReviewNumbers(merged, brandDoc.brandReviews)');
  const write = pmCode.indexOf('brandDoc.brandReviews = merged');
  assert.ok(call !== -1, 'the cache write must merge against the stored reviews');
  assert.ok(write !== -1 && call < write, 'the merge must run BEFORE the assignment');
  assert.ok(!/brandDoc\.brandReviews = Object\.assign\(\{\}, fresh/.test(pmCode),
    'the wholesale replace is still the live expression');
});


console.log('T. Pass 1 must not truncate away the numbers (LIVE REGRESSION 2026-08-11)');

// WHAT HAPPENED. Both pass-1 grounded calls were ending with finishReason=MAX_TOKENS.
// The rating/summary request sat at the END of each prompt, so the model spent its
// whole budget enumerating up to 12 quotes (with source + author + stage each) and
// never wrote the numbers. Pass 2 then honestly reported rating:null, the persist
// site replaced the stored aggregates, and Vuori went from 4.6★/15,545 to null —
// which makes social_proof_led ineligible outright. Measured on Vuori at the SAME
// 3000-token budget: quotes-last + thinking on gave MAX_TOKENS / 941 chars / 4 quotes
// / no rating; numbers-first + thinking off gave STOP / 3026 chars / 12 quotes /
// rating AND count. Verified end to end through lookupBrandReviews against the live
// API: "11 quote(s) · 4.6★ · 15,000 reviews".

const pass1Region = (src, startNeedle, endNeedle) => {
  const i = src.indexOf(startNeedle);
  const j = src.indexOf(endNeedle, i);
  assert.ok(i !== -1 && j > i, `could not bound the pass-1 prompt (${startNeedle})`);
  const code = src.slice(i, j).split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  // FLATTEN the template-literal concatenation before matching phrases. These prompts are
  // built as `...` + `...` across many lines, so a phrase the MODEL reads as one sentence
  // ("Do NOT pick one for me") is split by "` +\n    `" in the source. A pin that matches
  // raw source therefore fails on correct code — which is exactly what it did here. What
  // matters is the assembled prompt, so reconstruct an approximation of it.
  return code.replace(/`\s*\+\s*\n\s*`/g, '').replace(/\s+/g, ' ');
};

check('T1 all three pass-1 prompts ask for the NUMBERS BEFORE the quotes', () => {
  // Ordering, not presence: anything a prompt asks for last is the first thing a
  // truncation eats, and presence alone was true throughout the regression.
  const regions = [
    ['brand',    pass1Region(provSrc, 'async function lookupBrandReviews',   'let searchData')],
    ['product',  pass1Region(provSrc, 'async function lookupProductReviews', 'let searchData')],
    ['category', pass1Region(catSrc,  'const searchPrompt =',                'let searchRes')],
  ];
  for (const [name, region] of regions) {
    const numbers = region.search(/star rating/i);
    const quotes  = region.search(/DIRECT customer quotes/i);
    assert.ok(numbers !== -1, `${name}: the rating ask is gone entirely`);
    assert.ok(quotes !== -1, `${name}: the quote ask is gone entirely`);
    assert.ok(numbers < quotes,
      `${name}: the rating is still requested AFTER the quotes — a MAX_TOKENS cut will eat it`);
    assert.ok(/BEFORE any quotes/i.test(region),
      `${name}: the prompt should state the order explicitly, not just imply it`);
  }
});
check('T2 pass 1 spends no budget on hidden thinking', () => {
  assert.strictEqual(GROUNDED_PASS1_CONFIG.thinkingConfig.thinkingBudget, 0,
    'gemini-2.5-flash bills thoughts against maxOutputTokens; pass 1 does not reason');
  assert.ok(GROUNDED_PASS1_CONFIG.maxOutputTokens >= 3000, 'pass 1 needs room for the wider pool');
});
check('T3 every pass-1 call site uses the ONE shared config', () => {
  // Three inline copies is how the pass-2 calls got thinkingBudget:0 while the pass-1
  // calls silently did not for months.
  const uses = (provSrc.match(/generationConfig: GROUNDED_PASS1_CONFIG/g) || []).length
             + (catSrc.match(/generationConfig: GROUNDED_PASS1_CONFIG/g) || []).length;
  assert.strictEqual(uses, 3, `expected 3 pass-1 call sites on the shared config, found ${uses}`);
  assert.ok(!/generationConfig: \{ temperature: 0\.2, maxOutputTokens: (3000|1500) \}/.test(provSrc + catSrc),
    'an inline pass-1 config is back — it will drift from the shared one');
});
check('T4 truncation is detected, not silent (BEHAVIOURAL)', () => {
  assert.strictEqual(quiet(() => warnIfTruncated({ finishReason: 'MAX_TOKENS' }, 't4')), true,
    'a truncated narrative must be reported');
  assert.strictEqual(quiet(() => warnIfTruncated({ finishReason: 'STOP' }, 't4')), false);
  assert.strictEqual(quiet(() => warnIfTruncated({}, 't4')), false, 'no finishReason must not warn');
  assert.strictEqual(quiet(() => warnIfTruncated(null, 't4')), false);
  assert.strictEqual(quiet(() => warnIfTruncated({ finishReason: 'SAFETY' }, 't4')), true,
    'any non-STOP reason means the narrative is incomplete');
});
check('T5 the truncation check is WIRED at all three pass-1 sites', () => {
  const wired = (provSrc.match(/warnIfTruncated\(searchCand,/g) || []).length
              + (catSrc.match(/warnIfTruncated\(cand,/g) || []).length;
  assert.strictEqual(wired, 3, `expected 3 wired truncation checks, found ${wired}`);
});
check('T6 the measurement is recorded where the next session will read it', () => {
  assert.ok(/NARRATIVE_ORDER_NOTE/.test(provSrc), 'keep the note explaining WHY the order matters');
  assert.ok(/MAX_TOKENS/.test(provSrc), 'the note must name the failure mode it prevents');
});


console.log('S. Mediocre and negative stop at intake (OWNER DIRECTIVE 2026-08-11)');

// *"at no time should mediocre or negative sentiment pass any gate from initial
// screening to selection for use in an ad."*
//
// Before this there was an ungated middle: positivity was PROMPT TEXT at retrieval and
// hasPositiveSignal at render, so a complete, verbatim, thoroughly mediocre quote was
// stored as ad-usable, counted toward the pool, and shown in the brand UI. All four
// strings below are REAL retrieved quotes that passed retrieval.
const MEDIOCRE_REAL = [
  // RECLASSIFIED 2026-08-11 — "All clothes, including the workout shorts, have a slim,
  // tailored fit." was in this list and the owner corrected it: *"'slim tailored fit'
  // is a positive not neutral."* In apparel that sentence IS the compliment. It moved
  // to CLEAR_PRAISE below; the lexicon gained the fit-craft words to match.
  'The fit around the leg is just loose and casual enough to not feel oversized and baggy but not skin tight like a legging.',
  'They go on flash sale and/or 20% off.',
  'Ripstop Climber pants have a bold, stylish taper.',
  // NOTE: short generic praise ("Super comfortable and durable fabrics.", "Great fit,
  // and lightweight.") used to sit in this list and is deliberately NOT here any more.
  // Owner 2026-08-11: generic praise beats an empty slot. It is now STORED and simply
  // ranked last — see X6, which pins that it can never beat a specific quote.
  // Contains "best", passes hasPositiveSignal, and argues against the sale. Caught by
  // HARD_LIMITER inside scoreQuote — unreachable if the screen used the word list alone.
  'This is a low-support option best suited for lighter activities.',
];
const CLEAR_PRAISE = [
  // Owner-corrected: fit CRAFT is praise, not description.
  'All clothes, including the workout shorts, have a slim, tailored fit.',
  'Awesome High Quality Hat! Recently purchased a couple of Offshore caps. The quality and fit are amazing!',
  'These are literally my favorite pants ever. They are so soft and so lightweight it feels like wearing no pants.',
  'The quality is amazing and the pair I have feel like second skin.',
];

check('S1 real mediocre quotes are dropped at intake (BEHAVIOURAL, shipped pipeline)', () => {
  for (const t of MEDIOCRE_REAL) {
    const out = quiet(() => keepVerbatimQuotes([{ text: t }], `narrative: ${t}`, 's1'));
    assert.strictEqual(out.length, 0, `mediocre quote survived intake: ${JSON.stringify(t)}`);
  }
});
check('S2 clear praise still gets through (the screen is not a wall)', () => {
  for (const t of CLEAR_PRAISE) {
    const out = quiet(() => keepVerbatimQuotes([{ text: t }], `narrative: ${t}`, 's2'));
    assert.strictEqual(out.length, 1, `clear praise was wrongly dropped: ${JSON.stringify(t)}`);
  }
});
check('S3 the screen is UNCONDITIONAL — no flag, no branch, every quote', () => {
  const region = provSrc.slice(provSrc.indexOf('function keepVerbatimQuotes'),
                              provSrc.indexOf('function loadSentimentJudge'));
  const code = region.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.ok(/\.filter\(\(q\) => screenAdUsableSentiment\(q, judge, label\)\)/.test(code),
    'the sentiment screen must be applied to every quote the chokepoint returns');
  assert.ok(!/process\.env\.[A-Z_]*SENTIMENT|if \(.*enabled.*\) *\{[^}]*screenAdUsable/i.test(code),
    'the screen must not be behind a kill switch — the owner directive is absolute');
});
check('S4 the screen runs AFTER the trim, on the text that will be typeset', () => {
  // Order is the whole point: a positive quote can trim to a neutral span, and a
  // negative-then-positive quote trims to the negative half.
  const region = provSrc.slice(provSrc.indexOf('function keepVerbatimQuotes'),
                              provSrc.indexOf('function loadSentimentJudge'));
  const trim = region.indexOf('completeSentencesOnly');
  const screen = region.indexOf('screenAdUsableSentiment');
  assert.ok(trim !== -1 && screen !== -1 && trim < screen,
    'sentiment must be judged on the final string, not the original');
});
check('S5 it FAILS CLOSED — no judge means no quotes, never unjudged quotes', () => {
  assert.strictEqual(screenAdUsableSentiment({ text: 'Absolutely wonderful and amazing!' }, null, 's5'), false,
    'an unjudged quote must never proceed');
  assert.strictEqual(quiet(() => screenAdUsableSentiment({ text: '' }, () => true, 's5')), false);
  assert.strictEqual(quiet(() => screenAdUsableSentiment(null, () => true, 's5')), false);
});
check('S6 the bar IS the render path selector, reused not reimplemented', () => {
  const judge = loadSentimentJudge('s6');
  assert.strictEqual(typeof judge, 'function', 'the judge must resolve');
  // INTAKE IS NOT THE SELECTOR, deliberately. Intake decides what to STORE; selection
  // decides what to PRINT. Equating them meant generic praise was never stored, leaving
  // brands with an empty pool. What must hold is that intake reuses the render path's
  // OWN definitions — never a private copy — so the two cannot disagree about what is
  // positive or what is disqualified.
  const { hasPositiveSignal, scoreQuote } = require('../services/layoutInputService');
  for (const t of MEDIOCRE_REAL.concat(CLEAR_PRAISE)) {
    assert.strictEqual(judge(t), hasPositiveSignal(t) && Number.isFinite(scoreQuote(t)),
      `intake must equal "praise AND not disqualified" on: ${JSON.stringify(t.slice(0, 50))}`);
  }
  const region = provSrc.slice(provSrc.indexOf('function loadSentimentJudge'),
                               provSrc.indexOf('function screenAdUsableSentiment'));
  assert.ok(/hasPositiveSignal/.test(region) && /scoreQuote/.test(region),
    'the judge must come from the render path, not a private notion of positive');
  assert.ok(!/\/[^\n]*(love|great|amazing|soft)[^\n]*\/[gimsuy]*\.test/i.test(region),
    'a local sentiment regex must not shadow the shared selector');
});
check('S7 grounded budgets are PADDED, not sized to the measured need', () => {
  // Owner directive: "increase the token budget as needed, give it lots of padding".
  // A ceiling near the measured need is a silent data-loss bug the moment a brand has
  // more to say — which is precisely how the rating vanished.
  assert.ok(GROUNDED_PASS1_CONFIG.maxOutputTokens >= 12000,
    `pass 1 budget too tight for comfort: ${GROUNDED_PASS1_CONFIG.maxOutputTokens}`);
  assert.ok(GROUNDED_PASS2_MAX_TOKENS >= 8000, `pass 2 budget too tight: ${GROUNDED_PASS2_MAX_TOKENS}`);
  assert.ok(GROUNDED_CALL_TIMEOUT_MS >= 90000,
    `timeout must not throw away a call already paid for: ${GROUNDED_CALL_TIMEOUT_MS}`);
  // Every grounded call in these two modules must be on a padded constant. The
  // product-MATCH search is included on purpose (same silent-truncation class) even
  // though it is a different feature; only the tiny non-grounded classifier is exempt.
  const budgets = (provSrc + catSrc).match(/maxOutputTokens: [^,\n]+/g) || [];
  const unpadded = budgets.filter(b => /\b(1200|1500|2400|3000)\b/.test(b));
  assert.deepStrictEqual(unpadded, [], `un-padded grounded budgets: ${unpadded.join(', ')}`);
  assert.ok(!/timeout: (30000|45000)\b/.test(provSrc + catSrc),
    'a grounded call still has a short timeout — it would throw away a paid call');
});


console.log('N. ONE rating is chosen from ALL aggregates, by rule (owner decision 2026-08-11)');

// A brand's public aggregates disagree violently. Three consecutive live Vuori
// refreshes in one afternoon stored 4.58★/15,626 (own site), 3.8★/28, and 2.5★/126
// (Trustpilot) — pass 2 emitted whichever the narrative mentioned first, with no ranking
// and no record of the source, so whether a brand printed stars was luck of the draw and
// a re-enrichment could silently remove an ad format.
const VUORI_REAL = [
  { source: 'vuoriclothing.com', rating: 4.58, reviewCount: 15626 },
  { source: 'trustpilot.com',    rating: 2.5,  reviewCount: 126 },
  { source: 'sitejabber.com',    rating: 3.8,  reviewCount: 28 },
];

check('N1 the owner rule holds on the real measured set', () => {
  // *"prefer the highest number of stars with the most reviews, in this case 4.58 with
  // 15K reviews should absolutely win"*
  const r = quiet(() => pickBestRating(VUORI_REAL));
  assert.strictEqual(r.rating, 4.58, `got ${r.rating}`);
  assert.strictEqual(r.reviewCount, 15626);
  assert.strictEqual(r.ratingSource, 'vuoriclothing.com', 'the winning source must be recorded');
});
check('N2 order of the input cannot change the outcome', () => {
  // The whole defect was order-dependence. Every permutation must agree.
  const perms = [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]];
  for (const idx of perms) {
    const r = quiet(() => pickBestRating(idx.map(i => VUORI_REAL[i])));
    assert.strictEqual(r.rating, 4.58, `permutation ${idx.join('')} picked ${r.rating}`);
  }
});
check('N3 a thin high rating cannot beat a big one (the literal-rule trap)', () => {
  // Read literally, "highest stars" would hand the ad to 5.0★ from 3 reviews. The sample
  // floor is what stops that, and it is the reason this is not a one-line sort.
  const r = quiet(() => pickBestRating([
    { source: 'tiny.com', rating: 5.0, reviewCount: 3 },
    { source: 'vuoriclothing.com', rating: 4.58, reviewCount: 15626 },
  ]));
  assert.strictEqual(r.rating, 4.58, `a 3-review 5.0 must not win, got ${r.rating}`);
  assert.ok(RATING_MIN_CREDIBLE_REVIEWS >= 25, 'the sample floor must be meaningful');
});
check('N3b a thin 5.0 must not beat a big LOW rating either (what the floor is for)', () => {
  // The case the previous version of N3 missed, and a mutation removing the sample floor
  // slipped straight through it: when the thin candidate is the ONLY one above the star
  // floor, count-descending cannot save us — without the sample floor, "5.0 stars" from
  // three reviews becomes the printed rating for the whole brand.
  const r = quiet(() => pickBestRating([
    { source: 'tiny.com', rating: 5.0, reviewCount: 3 },
    { source: 'big.com',  rating: 3.0, reviewCount: 20000 },
  ]));
  assert.strictEqual(r.rating, 3.0, `a 3-review 5.0 must not become the brand rating, got ${r.rating}`);
  assert.strictEqual(r.reviewCount, 20000);
});
check('N5b the winner keeps ITS OWN count even when another source has more', () => {
  // Atomicity, in the one shape that can actually catch a borrowed count: the chosen
  // rating is NOT the largest sample. A mutation taking max(reviewCount) across all
  // candidates was invisible to every fixture where the winner also had the most reviews.
  const r = quiet(() => pickBestRating([
    { source: 'good.com', rating: 4.6, reviewCount: 900 },
    { source: 'huge.com', rating: 2.0, reviewCount: 50000 },
  ]));
  assert.strictEqual(r.rating, 4.6, 'the printable candidate must win');
  assert.strictEqual(r.reviewCount, 900,
    'the count must come from the 4.6 source, not be borrowed from the 50,000-review one');
  assert.strictEqual(r.ratingSource, 'good.com');
});
check('N4 when nothing can print, the largest sample is still returned', () => {
  // Not cosmetic: the Director reads the rating and summary as internal signal even when
  // no stars are typeset, so returning null here would lose real information.
  const r = quiet(() => pickBestRating(VUORI_REAL.slice(1)));
  assert.strictEqual(r.rating, 2.5);
  assert.strictEqual(r.reviewCount, 126, 'the biggest honest sample, not the flattering one');
});
check('N5 the pair stays atomic — rating and count from the SAME source', () => {
  // The mirror of the preserveBrandReviewNumbers rule. Mixing a rating from one site
  // with a count from another is the cross-snapshot bug in a new costume.
  for (const set of [VUORI_REAL, VUORI_REAL.slice(1), [{ source: 'a', rating: 4.9, reviewCount: 80 }]]) {
    const r = quiet(() => pickBestRating(set));
    const match = set.find(c => c.rating === r.rating);
    assert.ok(match, 'the chosen rating must come from a real candidate');
    assert.strictEqual(r.reviewCount, match.reviewCount, 'count must come from that same candidate');
    assert.strictEqual(r.ratingSource, match.source ?? null);
  }
});
check('N6 malformed candidates are refused, not coerced', () => {
  const r = quiet(() => pickBestRating([{ rating: 'x' }, { rating: 9 }, { rating: -1 }, { rating: NaN }, null, undefined]));
  assert.strictEqual(r.rating, null, 'a 9-star rating is not data');
  assert.strictEqual(r.reviewCount, null);
  assert.deepStrictEqual(quiet(() => pickBestRating(null)).ratingCandidates, []);
});
check('N7 the full candidate set is kept for audit', () => {
  const r = quiet(() => pickBestRating(VUORI_REAL));
  assert.strictEqual(r.ratingCandidates.length, 3,
    'every aggregate found must be stored — the choice has to be auditable, not invisible');
  assert.ok(r.ratingCandidates.every(c => 'source' in c && 'rating' in c && 'reviewCount' in c));
});
check('N8 the picker is WIRED into both lookups, and nothing takes the raw value', () => {
  const code = stripComments(provSrc);
  assert.strictEqual((code.match(/\.\.\.pickBestRating\(/g) || []).length, 2,
    'brand and product results must both come from the picker');
  assert.ok(!/rating:\s+typeof parsed\.rating === 'number' \? parsed\.rating : null/.test(code),
    'the un-ranked single value is back — order-dependence returns with it');
});
check('N10 the ratings array is REQUIRED in the pass-2 schema, on both lookups', () => {
  // THE BUG THIS PINS, measured live. Declared merely optional, Gemini structured
  // output silently DID NOT EMIT `ratings` — pass 1 wrote all four aggregates
  // ("Vuoriclothing.com: 4.58 from 15,626", "Trustpilot: 2.3 from 126", …), pass 2 read
  // them, and the schema dropped every one. The brand came back with NO rating and the
  // picker had nothing to rank, which looked exactly like "the web didn't say".
  // Verified both ways against the live API: optional → none, required → all four.
  const code = stripComments(provSrc);
  const required = code.match(/required: \['quotes', 'ratings'\]/g) || [];
  assert.strictEqual(required.length, 2,
    'both the brand and product pass-2 schemas must REQUIRE ratings, or the model omits it');
  // Optional-and-nullable is the exact shape that failed; make its return visible.
  const blocks = code.match(/ratings: \{[\s\S]*?\n              \},/g) || [];
  assert.strictEqual(blocks.length, 2, 'expected a ratings schema block in each lookup');
  for (const b of blocks) {
    assert.ok(!/nullable: true/.test(b.split('items:')[0]),
      'the ratings ARRAY must not be nullable — an empty array is how "none found" is said');
    assert.ok(/required: \['rating'\]/.test(b),
      'each entry must require a numeric rating, so a non-numeric grade is omitted rather than emitted as null');
    // REQUIRED and NON-NULLABLE are different guarantees, and only asserting the first
    // let a mutation adding `nullable: true` here pass: the model would then satisfy
    // the schema with {source:'BBB', rating:null}, which is not an aggregate at all and
    // which the picker has to filter out downstream. Say it at the schema instead.
    assert.ok(/rating:\s*\{ type: 'number' \}/.test(b),
      "the entry's rating must be a plain non-nullable number");
  }
});
check('N9 pass 1 asks for EVERY aggregate and forbids pre-picking', () => {
  for (const [name, region] of [
    ['brand',   pass1Region(provSrc, 'async function lookupBrandReviews',   'let searchData')],
    ['product', pass1Region(provSrc, 'async function lookupProductReviews', 'let searchData')],
  ]) {
    assert.ok(/EVERY (?:public review aggregate|place)/i.test(region), `${name}: must ask for every aggregate`);
    assert.ok(/ONE PER LINE/.test(region), `${name}: must ask for them separately`);
    assert.ok(/do NOT pick one for me/i.test(region), `${name}: the model must not choose`);
    assert.ok(/do NOT average/i.test(region), `${name}: averaging hides the disagreement`);
  }
});

console.log('X. Sensory praise counts as praise (owner decision 2026-08-11)');

check('X1 the quote the owner named now survives intake', () => {
  const t = "These might be the softest sweatpants I've ever put on.";
  const out = quiet(() => keepVerbatimQuotes([{ text: t }], `narrative: ${t}`, 'x1'));
  assert.strictEqual(out.length, 1, 'real, specific apparel praise must not be thrown away');
});
check('X2 bare FIT DESCRIPTORS still do not count as praise', () => {
  // The protection the earlier adversarial review put in place, deliberately kept: these
  // state a fact about sizing, they do not express praise.
  const { hasPositiveSignal } = require('../services/layoutInputService');
  for (const t of ['True to size', 'Holds its shape', 'true to size and holds its shape']) {
    assert.strictEqual(hasPositiveSignal(t), false, `must not be an endorsement: ${t}`);
  }
});
check('X3 a bare sensory word cannot become a testimonial', () => {
  // "soft" now opens the positivity gate, so the substance floor is what stops a
  // one-word fragment reaching a frame.
  const direct = require('../services/directImageRenderService');
  for (const snip of ['Soft.', 'so soft', 'very soft']) {
    assert.strictEqual(
      direct.selectStaticQuoteText({ text: 'q'.repeat(200), snippet: snip }, { cap: 140 }), '',
      `a bare fragment must not be typeset: ${snip}`);
  }
});
check('X4 mediocre and limiter cases are UNAFFECTED by the wider lexicon', () => {
  for (const t of MEDIOCRE_REAL) {
    const out = quiet(() => keepVerbatimQuotes([{ text: t }], `narrative: ${t}`, 'x4'));
    assert.strictEqual(out.length, 0, `widening the lexicon must not open this: ${JSON.stringify(t.slice(0,48))}`);
  }
});


check('X5 fit CRAFT counts as praise, bare fit FACTS still do not', () => {
  const { hasPositiveSignal } = require('../services/layoutInputService');
  // The owner's correction: how a garment is CUT is a compliment.
  for (const t of ['a slim, tailored fit', 'beautifully tailored and well fitting', 'streamlined cut']) {
    assert.strictEqual(hasPositiveSignal(t), true, `fit craft should read as praise: ${t}`);
  }
  // But the words that describe SIZING rather than craft stay out — "runs slim" and
  // "too fitted" are complaints, and HARD_LIMITER already owns "runs small|narrow|tight".
  for (const t of ['True to size', 'Holds its shape', 'the shorts run slim']) {
    assert.strictEqual(hasPositiveSignal(t), false, `a sizing fact is not praise: ${t}`);
  }
});
check('X6 generic praise is a LAST RESORT, never a first choice', () => {
  // Owner: "in the absence of any other social proof, generic praise is better than
  // nothing, but hopefully we have many many more choices than that."
  const { pickStrongestQuote } = require('../services/layoutInputService');
  const generic  = { text: 'Love it, great product.' };
  const specific = { text: 'I bought these in March and have worn them weekly since — still soft.' };
  // Alone, it prints rather than leaving the slot empty.
  assert.ok(quiet(() => pickStrongestQuote([generic])), 'generic praise must beat an empty slot');
  // Beside anything specific, it loses.
  assert.strictEqual(quiet(() => pickStrongestQuote([generic, specific])).text, specific.text,
    'a specific quote must always outrank generic praise');
});
check('X7 the last resort never admits negative or limiter content', () => {
  // The floor was relaxed for UNSPECIFIC praise only. Everything scoreQuote disqualifies
  // outright stays at -Infinity and must remain unreachable.
  const { pickStrongestQuote } = require('../services/layoutInputService');
  const bad = [
    { text: 'The fabric pilled after two washes and I returned it.' },
    { text: 'This is a low-support option best suited for lighter activities.' },
    { text: 'Not as soft as I had hoped for the price.' },
  ];
  assert.strictEqual(quiet(() => pickStrongestQuote(bad)), null,
    'relaxing the floor must not reopen the disqualifiers');
});

const total = pass + fail;
if (fail === 0) {
  console.log(`\n✅ verifyQuoteRetrievalDirective: ${pass}/${total} checks passed\n`);
  process.exit(0);
}
console.log(`\n❌ verifyQuoteRetrievalDirective: ${fail} FAILED, ${pass} passed\n`);
process.exit(1);
