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
  completeSentencesOnly
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

check('H9 a trim must not INVERT the sentiment (adversarial review, pre-ship)', () => {
  // The nastiest failure this fix could have introduced: both of these trim to a
  // complete, verbatim sentence that is a fabricated NEGATIVE endorsement.
  for (const t of [
    'I hated the old ones. These are great and soft',
    'Not for everyone. I love them and wear',
    'The first pair was terrible. This one is perfect and I',
  ]) {
    const out = quiet(() => completeSentencesOnly({ text: t }, 'h9'));
    assert.strictEqual(out, null, `must be dropped, not trimmed: ${JSON.stringify(t)}`);
  }
});
check('H10 the re-judge reuses the render gate rather than a private word list', () => {
  // If a future edit swaps hasPositiveSignal for a local regex, the two drift and
  // this fix silently stops matching what the render path will accept.
  const region = provSrc.slice(
    provSrc.indexOf('function completeSentencesOnly'),
    provSrc.indexOf('function stampLlmQuotes'));
  // The CALL, not just the import: a mutation that dropped the call while leaving
  // the destructure in place slipped past the looser version of this pin.
  assert.ok(/hasPositiveSignal\(trimmed\)/.test(region),
    'the trimmed span itself must be passed to the render gate');
  assert.ok(/require\('\.\.\/layoutInputService'\)/.test(region),
    'the judgement must come from the render path, not a copy');
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

const total = pass + fail;
if (fail === 0) {
  console.log(`\n✅ verifyQuoteRetrievalDirective: ${pass}/${total} checks passed\n`);
  process.exit(0);
}
console.log(`\n❌ verifyQuoteRetrievalDirective: ${fail} FAILED, ${pass} passed\n`);
process.exit(1);
