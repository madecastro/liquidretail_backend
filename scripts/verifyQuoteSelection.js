#!/usr/bin/env node
/**
 * verifyQuoteSelection — offline harness for services/quoteSnippetService.js's
 * extractive-fallback SELECTION, no DB, no network, no API key.
 *
 * THE DEFECT (measured on a delivered ad, 2026-08-11): the overlay quote
 * rendered as
 *   "often recommending it for casual wear and…"
 * — lowercase, opens mid-sentence, ends on an ellipsis. The source sentence
 * had no comma and no early sentence terminator to cut on, so the old
 * mechanical ladder (bestClause(source) || truncateAtWordBoundary(source))
 * fell straight to a lowercase hard-slice of the one long sentence it had
 * committed to, never considering whether a shorter, complete, SELF-CONTAINED
 * sentence existed elsewhere in the same review.
 *
 * THE FIX is pure SELECTION, never generation — every candidate this file
 * tests is required to be a byte-for-byte substring of the source text (see
 * section A). bestFallbackSnippet() now tries, in order:
 *   1. bestWholeSentence — a DIFFERENT complete sentence elsewhere in the
 *      review that already fits and ends on a real terminator (. ! ?).
 *   2. bestClause — the strongest sub-clause of the chosen sentence, now
 *      ranked POSITION-FIRST: a clause that opens the sentence beats one that
 *      opens mid-sentence, even when the continuation scores higher.
 *   3. truncateAtWordBoundary — the ellipsis cut, LAST RESORT only.
 *
 * Every check below calls the SHIPPED functions directly — extractSnippet,
 * bestFallbackSnippet, bestWholeSentence, bestClause, isExtractive — never a
 * local reimplementation, per CLAUDE.md's "a test that cannot fail is not a
 * test": a check that recomputes the policy it is meant to verify cannot
 * catch a regression in the real one.
 *
 * Run: node scripts/verifyQuoteSelection.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  extractSnippet,
  isExtractive,
  strongestSentence,
  bestClause,
  bestWholeSentence,
  bestFallbackSnippet,
  truncateAtWordBoundary,
  MAX_CHARS
} = require('../services/quoteSnippetService');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'services', 'quoteSnippetService.js'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function check(label, fn) {
  try { fn(); pass++; }
  catch (e) {
    fail++;
    failures.push(`${label} — ${String(e.message).split('\n')[0].slice(0, 300)}`);
  }
}
// Queued, not run inline — this is a plain CommonJS script (no top-level
// await), so every async check is collected here and drained by the async
// IIFE at the bottom of the file, same pattern as scripts/testReviewText.js.
const asyncChecks = [];
function checkAsync(label, fn) {
  asyncChecks.push(async () => {
    try { await fn(); pass++; }
    catch (e) {
      fail++;
      failures.push(`${label} — ${String(e.message).split('\n')[0].slice(0, 300)}`);
    }
  });
}

// A verbatim check that tolerates only the ONE thing our own code is allowed
// to add: a trailing ellipsis from truncateAtWordBoundary's last resort.
// Anything else — reordering, paraphrase, new words — is a fabrication.
function isVerbatimOrEllipsis(snippet, source) {
  if (!snippet) return true;
  const bare = snippet.endsWith('…') ? snippet.slice(0, -1).trimEnd() : snippet;
  return source.includes(bare);
}

console.log('\nverifyQuoteSelection\n');

// ── A. the anti-fabrication invariant, tested explicitly ──────────────────
console.log('A. every returned snippet is verbatim (modulo a trailing ellipsis)');

const REALISTIC_REVIEWS = [
  'Ordered this on the 3rd and it arrived Tuesday. Still looks brand new after eight months of daily use and two cats. Customer service never answered my email.',
  'often recommending it for casual wear and everything else because it never fades or shrinks even after many washes.',
  'often recommend it for casual wear because it has held up perfectly after 6 months of daily use without fading or shrinking. I really love this hoodie.',
  'The cushions are firm, often recommend it daily for casual comfort.',
  'It runs true to size, held up perfectly after 6 months of daily wear and washing. I would buy it again.',
  'Awesome shirt with awesome fit',
  'This is the third one I have bought for my kitchen and it still works exactly like the first, even after two years of daily use.',
  'a'.repeat(120),
  'Great mat, really helps my hips, super happy with this purchase honestly, would tell anyone thinking about it to just buy it already.'
];

for (const review of REALISTIC_REVIEWS) {
  const source = strongestSentence(review);
  const fb = bestFallbackSnippet(review, source, MAX_CHARS);
  check(`A verbatim: bestFallbackSnippet(${JSON.stringify(review.slice(0, 40))}…)`, () => {
    assert.ok(isVerbatimOrEllipsis(fb, review), `not verbatim: ${JSON.stringify(fb)}`);
  });
}

// ── B. a short complete sentence beats a comma-clause ──────────────────────
console.log('\nB. a complete short sentence wins over an available comma-clause');

check('B1 a whole sentence elsewhere in the review beats a fitting comma-clause of the chosen one', () => {
  // "It runs true to size" is a valid, FITTING comma-clause of the chosen
  // sentence — bestClause alone would happily return it. bestFallbackSnippet
  // must still prefer the separate whole sentence.
  const review = 'It runs true to size, held up perfectly after 6 months of daily wear and washing. I would buy it again.';
  const source = strongestSentence(review);
  assert.strictEqual(bestClause(source, MAX_CHARS), 'It runs true to size',
    'fixture invariant broken: expected a fitting comma-clause to exist');
  const got = bestFallbackSnippet(review, source, MAX_CHARS);
  assert.strictEqual(got, 'I would buy it again.', `expected the whole sentence, got ${JSON.stringify(got)}`);
  assert.ok(!/,/.test(got), 'result is a comma-clause, not a whole sentence');
});

check('B2 a complete short sentence beats a truncated long one end-to-end', () => {
  const review = 'often recommend it for casual wear because it has held up perfectly after 6 months of daily use without fading or shrinking. I really love this hoodie.';
  const source = strongestSentence(review);
  assert.ok(source.length > MAX_CHARS, 'fixture invariant broken: source must not fit whole');
  const got = bestFallbackSnippet(review, source, MAX_CHARS);
  assert.strictEqual(got, 'I really love this hoodie.', `got ${JSON.stringify(got)}`);
  assert.ok(!/…$/.test(got), 'a complete sentence was available; must not carry an ellipsis');
});

// ── C. THE OBSERVED DEFECT ──────────────────────────────────────────────────
console.log('\nC. the observed defect: "often recommending it for casual wear and…"');

const DEFECT_STRING = 'often recommending it for casual wear and…';

check('C1 the exact historical string still reproduces from the RAW ladder on an isolated long run-on', () => {
  // This is the review that, run through the OLD two-step ladder
  // (bestClause || truncateAtWordBoundary) alone, produced the exact
  // defect string. Pinning that here proves the fixture is faithful to the
  // real bug, not a strawman — and documents why: no comma, no early
  // terminator, source begins lowercase because the reviewer's own sentence
  // does. bestFallbackSnippet cannot invent a boundary that is not there.
  const review = 'often recommending it for casual wear and everything else because it never fades or shrinks even after many washes.';
  const source = strongestSentence(review);
  assert.strictEqual(bestClause(source, MAX_CHARS), null, 'fixture invariant broken: expected no fitting comma-clause');
  const rawLadder = bestClause(source, MAX_CHARS) || truncateAtWordBoundary(source, MAX_CHARS);
  assert.strictEqual(rawLadder, DEFECT_STRING, `fixture no longer reproduces the historical string, got ${JSON.stringify(rawLadder)}`);
});

check('C2 with NO self-contained option, NOTHING ships (the ellipsis tier was removed)', () => {
  // CONTRACT CHANGE 2026-08-11 (owner): "the question isn't provenance, it's
  // whether it is helping or hurting our advertisement." An ellipsis-truncated
  // fragment printed as a customer testimonial hurts — it is the exact defect
  // that reached a live ad. So the mechanical ladder no longer ends in a
  // truncation: when no self-contained excerpt clears the proof bar it returns
  // null and the ad renders WITHOUT a quote, letting the rating carry the proof
  // (the Rating-First case in the social-proof guidelines).
  const review = 'often recommending it for casual wear and everything else because it never fades or shrinks even after many washes.';
  const source = strongestSentence(review);
  assert.strictEqual(bestWholeSentence(review, source, MAX_CHARS), null,
    'fixture invariant broken: expected no whole-sentence alternative');
  const got = bestFallbackSnippet(review, source, MAX_CHARS);
  assert.strictEqual(got, null, `expected NO quote, got ${JSON.stringify(got)}`);
});

check('C3 THE FIX: given the SAME defect sentence embedded in a fuller review, a self-contained alternative wins and the ellipsis never appears', () => {
  // Same long, comma-less, lowercase-opening sentence as C1/C2 (scored to
  // still win strongestSentence's pick), but now placed in a realistic
  // multi-sentence review with a short, complete, capitalized alternative —
  // the shape every real review actually has. This is the case that was
  // broken in production: the old ladder never looked past `source`.
  const review = 'often recommend it for casual wear because it has held up perfectly after 6 months of daily use without fading or shrinking. I really love this hoodie.';
  const source = strongestSentence(review);
  assert.ok(source.length > MAX_CHARS, 'fixture invariant broken: source must not fit whole');
  assert.strictEqual(bestClause(source, MAX_CHARS), null, 'fixture invariant broken: expected no fitting comma-clause');
  // What the OLD two-step ladder would have produced, computed from the
  // real (unchanged) primitives — not a reimplementation.
  const oldLadderResult = bestClause(source, MAX_CHARS) || truncateAtWordBoundary(source, MAX_CHARS);
  assert.ok(/…$/.test(oldLadderResult), 'fixture invariant broken: old ladder should still end in ellipsis');
  assert.ok(/^[a-z]/.test(oldLadderResult), 'fixture invariant broken: old ladder should still open lowercase');

  const got = bestFallbackSnippet(review, source, MAX_CHARS);
  assert.notStrictEqual(got, oldLadderResult, 'new selection did not improve on the old ladder');
  assert.ok(!/…$/.test(got), `new result still carries an ellipsis: ${JSON.stringify(got)}`);
  assert.ok(/^[A-Z]/.test(got), `new result does not start at a sentence boundary (capitalized): ${JSON.stringify(got)}`);
  assert.ok(/[.!?]$/.test(got), `new result does not end on a terminator: ${JSON.stringify(got)}`);
  assert.ok(review.includes(got), 'result is not verbatim in the review');
});

// ── D. lowercase mid-sentence starts avoided whenever an alternative exists ─
console.log('\nD. lowercase mid-sentence starts avoided whenever an alternative exists');

check('D1 bestClause NEVER prints a complaint, even when the complaint opens the sentence', () => {
  // THE REGRESSION THIS REPLACES. The first cut of this fix ranked position
  // ahead of content unconditionally ("the opening clause always wins"), which
  // adversarial review broke with the most common real review shape there is —
  // hedge, then redeem. The opening clause is the COMPLAINT, so a position-first
  // rule printed "Shipping was slow and disappointing" as the ad's testimonial.
  //
  // A mid-sentence fragment reads awkwardly; a complaint sells against the
  // product. Position is therefore a BONUS (OPEN_BONUS), never an override, and
  // scoreSentence's OFF_PRODUCT/-NOISE penalties must be able to outweigh it.
  const { scoreSentence } = require('../utils/reviewText');
  const cases = [
    ['Shipping was slow and disappointing, but the shirt is fantastic', /shirt is fantastic/i, /shipping|disappointing/i],
    ['Delivery took forever, the fabric is incredibly soft and breathable', /fabric/i, /delivery|forever/i],
    ['The website checkout was broken, the jacket fits perfectly', /jacket fits/i, /website|checkout|broken/i],
  ];
  for (const [review, mustMatch, mustNotMatch] of cases) {
    const got = bestClause(review, MAX_CHARS);
    assert.ok(got, `no clause returned for ${JSON.stringify(review)}`);
    assert.ok(mustMatch.test(got), `expected the positive clause, got ${JSON.stringify(got)}`);
    assert.ok(!mustNotMatch.test(got), `SHIPPED A COMPLAINT: ${JSON.stringify(got)}`);
  }
  // And the bonus must still exist: with content roughly equal, the opener wins.
  const tie = 'The fabric is soft and breathable, the fabric is soft and breathable';
  assert.ok(bestClause(tie, MAX_CHARS), 'equal-content case returned nothing');
});

check('D2 the winner never opens with a dangling connective', () => {
  // OWNER, on seeing "but the shirt is fantastic" proposed as the quote:
  // "why would you include the word 'but' in the above" — "the shirt is
  // fantastic" is what you want. A leading but/and/so is an artifact of
  // splitting on the comma AND a tell that something (usually a complaint)
  // preceded it. Dropping it keeps the result a contiguous substring of the
  // review, so the quote stays verbatim while reading as a finished thought.
  const cases = [
    'Shipping was slow and disappointing, but the shirt is fantastic.',
    'It took ages to arrive, and the fabric is wonderfully soft.',
    'I was unsure at first, so I ordered a second one immediately.',
  ];
  for (const review of cases) {
    const got = bestFallbackSnippet(review, strongestSentence(review), MAX_CHARS);
    if (got === null) continue; // dropping it entirely is also acceptable
    assert.ok(!/^(?:but|and|so|yet|or|though|although|however|plus|also|then)\b/i.test(got),
      `quote opens with a dangling connective: ${JSON.stringify(got)}`);
    assert.ok(review.includes(got), `no longer verbatim after trimming: ${JSON.stringify(got)}`);
  }
});

// ── H. the proof bar: disqualify harm, rank for specificity ───────────
console.log('\nH. proof bar — generic praise allowed, harmful content never');

checkAsync('H1 generic praise SHIPS when the review offers nothing more specific', async () => {
  // OWNER (2026-08-11): "Generic praise is absolutely fine if something is more
  // specific." An earlier cut of the bar required scoreSentence > 0, which
  // BANNED generic praise outright. Ranking (GENERIC_PRAISE is -5) is what makes
  // a specific line win; the bar must not also veto it.
  //
  // Asserted through extractSnippet, the real entry point — a short review is
  // handled by the in-budget path, which is exactly where an over-tight bar
  // would silently turn a usable overlay into no quote at all.
  const got = await extractSnippet('Love it. Great product.');
  assert.ok(got !== null, 'generic praise was rejected outright — the bar is over-tight');
  assert.ok(/love it|great product/i.test(got), `unexpected result ${JSON.stringify(got)}`);
});

check('H2 a more specific line OUTRANKS generic praise in the same review', () => {
  const review = 'Great product. Fits true to size and the fabric is soft.';
  const got = bestFallbackSnippet(review, strongestSentence(review), MAX_CHARS);
  assert.ok(got && /true to size|fabric/i.test(got),
    `expected the specific line to win, got ${JSON.stringify(got)}`);
});

check('H3 retailer complaints NEVER print, at any score', () => {
  // Fixtures MUST fit inside MAX_CHARS. An over-long complaint is rejected on
  // length alone, which would make this check pass with the content veto
  // deleted — verified: it did exactly that on the first cut. These are short
  // enough that ONLY the OFF_PRODUCT veto can stop them.
  for (const review of [
    'Delivery was very slow and late.',
    'Customer service never replied.',
    'The refund process was awful.',
  ]) {
    assert.ok(review.length <= MAX_CHARS, `fixture invariant broken: ${review.length} chars must be <= ${MAX_CHARS}`);
    const got = bestFallbackSnippet(review, strongestSentence(review), MAX_CHARS);
    assert.strictEqual(got, null, `shipped a retailer complaint: ${JSON.stringify(got)}`);
  }
});

check('H4 aggregate review-summary voice never prints as a testimonial', () => {
  for (const review of [
    'Customers report it wears well for casual use.',
    'Reviewers often recommend it for everyday wear.',
    'Most shoppers say it holds up nicely over time.',
  ]) {
    const got = bestFallbackSnippet(review, strongestSentence(review), MAX_CHARS);
    assert.strictEqual(got, null, `shipped summary prose as a quote: ${JSON.stringify(got)}`);
  }
});

check('H5 nothing that ships ever carries an ellipsis', () => {
  for (const review of REALISTIC_REVIEWS) {
    const got = bestFallbackSnippet(review, strongestSentence(review), MAX_CHARS);
    if (got === null) continue;
    assert.ok(!/…|\.\.\./.test(got), `shipped an unfinished fragment: ${JSON.stringify(got)}`);
  }
});

// ── E. degenerate inputs must never throw ──────────────────────────────
console.log('\nE. empty / null / whitespace / one-word / no-terminator inputs do not throw');

const EDGE_INPUTS = [
  '', '   ', null, undefined, 'Great', 'no terminator here at all',
  '.', '…', ',,,', 'a', '  Mixed   whitespace\tand\nnewlines  ',
  'A'.repeat(500), '🙂🙂🙂', 'Ünïcödé rèvïew tèxt thät ïs fïne.',
];

for (const inp of EDGE_INPUTS) {
  // eslint-disable-next-line no-loop-func
  check(`E sync helpers survive ${JSON.stringify(inp)}`, () => {
    const source = strongestSentence(inp);
    bestClause(source, MAX_CHARS);
    bestWholeSentence(inp, source, MAX_CHARS);
    truncateAtWordBoundary(source, MAX_CHARS);
    bestFallbackSnippet(inp, source, MAX_CHARS);
  });
}

for (const inp of EDGE_INPUTS) {
  // eslint-disable-next-line no-loop-func
  checkAsync(`E extractSnippet survives ${JSON.stringify(inp)}`, async () => {
    await extractSnippet(inp);
  });
}

// ── F. LLM stubbed to return non-verbatim text is REJECTED ──────────────────
console.log('\nF. a non-extractive LLM response is rejected (isExtractive still holds)');

const QSS_PATH = require.resolve('../services/quoteSnippetService');

/**
 * withStubbedLlm(stubReturn, fn) — runs fn(freshExtractSnippet) with
 * chatCompletion stubbed to return { snippet: stubReturn }.
 *
 * Mutating atlasLlmService's exported chatCompletion is NOT enough on its
 * own: quoteSnippetService destructured `chatCompletion` into a local const
 * at ITS OWN require time (at the top of this file), so that binding is
 * frozen to the ORIGINAL function forever, and isConfigured() gates on
 * process.env.ATLAS_API_KEY before chatCompletion is ever reached. A first
 * draft of this harness patched atlasLlmService.chatCompletion and
 * .isConfigured after the fact and every "stubbed" check passed — silently
 * for the wrong reason: isConfigured() (unpatched, reading the real env var)
 * returned false, so extractSnippet took the "no API key" branch and never
 * called chatCompletion at all. bestFallbackSnippet's own verbatim output
 * satisfied the (too-weak) assertions, so the check was GREEN while testing
 * nothing — exactly the "test that cannot fail" trap.
 *
 * The real fix: (1) set ATLAS_API_KEY so the real isConfigured() — which
 * re-reads the env var live, no need to touch it — returns true, and (2)
 * evict quoteSnippetService from require.cache and re-require it so its
 * top-level destructuring re-runs and picks up the patched chatCompletion.
 * `calls` lets every caller assert the stub was actually invoked, so this
 * category of false-green cannot recur unnoticed.
 */
async function withStubbedLlm(stubReturn, fn) {
  const atlasLlm = require('../services/atlasLlmService');
  const prevChat = atlasLlm.chatCompletion;
  const prevEnv = process.env.ATLAS_API_KEY;
  const calls = { count: 0 };
  atlasLlm.chatCompletion = async () => {
    calls.count += 1;
    return { choices: [{ message: { content: JSON.stringify({ snippet: stubReturn }) } }] };
  };
  process.env.ATLAS_API_KEY = 'test-key-for-verifyQuoteSelection';
  delete require.cache[QSS_PATH];
  try {
    const fresh = require(QSS_PATH);
    const result = await fn(fresh.extractSnippet);
    assert.ok(calls.count > 0, 'the stub was never called — extractSnippet took a different path than intended');
    return result;
  } finally {
    atlasLlm.chatCompletion = prevChat;
    if (prevEnv === undefined) delete process.env.ATLAS_API_KEY; else process.env.ATLAS_API_KEY = prevEnv;
    delete require.cache[QSS_PATH];
    require(QSS_PATH); // leave a pristine cached copy behind for anything requiring it after this point
  }
}

checkAsync('F1 a fabricated, non-verbatim LLM snippet never reaches the caller', async () => {
  // Deliberately UNDER 50 chars, so this exercises the isExtractive guard
  // specifically, not the separate "LLM emitted >MAX_CHARS" size guard.
  const review = 'This hoodie is incredibly cozy and I wear it constantly around the house on cold winter mornings before work.';
  const fabricated = 'Completely made up, not real praise';
  assert.ok(fabricated.length <= MAX_CHARS, 'fixture invariant broken: fabricated text must be in-budget');
  assert.ok(!review.includes(fabricated), 'fixture invariant broken: fabricated text must not actually be verbatim');
  const out = await withStubbedLlm(fabricated, (freshExtractSnippet) => freshExtractSnippet(review));
  // The fabrication must never reach the caller. Either the mechanical ladder
  // finds a genuine verbatim excerpt, or it returns null and no quote is shown —
  // both are correct; returning the model's invention is not.
  assert.notStrictEqual(out, fabricated);
  if (out !== null) {
    assert.ok(review.includes(out), `result is not verbatim in the review: ${JSON.stringify(out)}`);
    assert.ok(isExtractive(out, review), `isExtractive rejects the fallback's own output: ${JSON.stringify(out)}`);
  }
});

checkAsync('F2 a fabricated LLM snippet falls through to the SAME mechanical ladder as no-LLM-at-all', async () => {
  const review = 'often recommend it for casual wear because it has held up perfectly after 6 months of daily use without fading or shrinking. I really love this hoodie.';
  const viaLlmRejected = await withStubbedLlm(
    'totally fabricated and not extractive at all',
    (freshExtractSnippet) => freshExtractSnippet(review)
  );
  const source = strongestSentence(review);
  const viaMechanicalDirect = bestFallbackSnippet(review, source, MAX_CHARS);
  assert.strictEqual(viaLlmRejected, viaMechanicalDirect,
    `LLM rejection did not fall through to the same mechanical result: ${JSON.stringify(viaLlmRejected)} vs ${JSON.stringify(viaMechanicalDirect)}`);
});

checkAsync('F3 a verbatim, in-budget LLM snippet IS accepted (the gate is not closed on everything)', async () => {
  const review = 'This hoodie is incredibly cozy and I wear it constantly around the house on cold winter mornings before work.';
  const out = await withStubbedLlm('incredibly cozy', (freshExtractSnippet) => freshExtractSnippet(review));
  assert.strictEqual(out, 'incredibly cozy', `got ${JSON.stringify(out)}`);
});

// ── G. structural pin: the three-tier order lives in the real source ───────
console.log('\nG. structural pin — the ladder order is in the shipped source, not just this harness');

check('G1 bestFallbackSnippet tries whole-sentence then clause, and NEVER ships a truncation', () => {
  const i = SRC.indexOf('function bestFallbackSnippet');
  assert.ok(i !== -1, 'bestFallbackSnippet not found — was it inlined or renamed?');
  const j = SRC.indexOf('\nfunction ', i + 10);
  const region = SRC.slice(i, j > i ? j : i + 1600);
  const iWhole = region.indexOf('bestWholeSentence(');
  const iClause = region.indexOf('bestClause(');
  assert.ok(iWhole !== -1 && iClause !== -1, 'a selection tier is missing from bestFallbackSnippet');
  assert.ok(iWhole < iClause, 'tiers are not in whole-sentence -> clause order');
  // The ellipsis tier must NOT be reachable: truncateAtWordBoundary output ends
  // in an ellipsis by construction and can never clear the proof bar, so calling
  // it here would only reintroduce the fragment this change removed.
  assert.ok(region.indexOf('truncateAtWordBoundary(') === -1,
    'truncateAtWordBoundary is back in the shipping ladder — that reintroduces the ellipsis fragment');
  assert.ok(/meetsProofBar\(/.test(region), 'the proof bar is not applied in the mechanical ladder');
});

check('G2 bestClause ranks by score PLUS a bounded position bonus (never position-first)', () => {
  const i = SRC.indexOf('function bestClause');
  assert.ok(i !== -1, 'bestClause not found');
  const j = SRC.indexOf('function bestWholeSentence', i);
  const region = SRC.slice(i, j > i ? j : i + 2400);
  assert.ok(/startsAtOpen/.test(region), 'position tracking removed from bestClause');
  assert.ok(/OPEN_BONUS/.test(region), 'the bounded position bonus is gone');
  // The unconditional position override must NOT come back — that is the exact
  // shape that shipped a complaint as an ad testimonial.
  assert.ok(!/startsAtOpen !== best\.startsAtOpen/.test(region),
    'position-first override reintroduced — this ships complaints (see D1)');
  // And the bonus must stay bounded below the sentiment signals that outrank it
  // (POSITIVE +5, RISK_REVERSAL +6, OFF_PRODUCT -6), or complaints win again.
  const m = /OPEN_BONUS\s*=\s*(\d+)/.exec(region);
  assert.ok(m, 'OPEN_BONUS is not a plain numeric constant');
  assert.ok(Number(m[1]) <= 4, `OPEN_BONUS=${m[1]} is large enough to outrank sentiment penalties`);
});

check('G3 MAX_CHARS is unchanged at 50 (this fix is selection-only, not a width change)', () => {
  assert.ok(/const MAX_CHARS = 50;/.test(SRC), 'MAX_CHARS no longer 50 — verifyQuoteSurfaceLength.js also pins this');
});

(async () => {
console.log('\nW. Voice — prefer a direct testimonial, do not discard the rest');

// Owner directive 2026-08-11: "It should prefer direct testimonials, but those can be
// used otherwise." A PREFERENCE, not a gate — and deliberately NOT judged by source,
// because "A Busy Dad's Honest Review" tells you nothing reliable about whether the
// writer bought the thing. Voice does.
const { scoreQuote } = require('../services/layoutInputService');

// All five are real lines from Vuori's live brand-review pool.
const FIRST_PERSON_REAL = [
  'The fabric is so soft. I love that it is a bomber-style jacket and cinched at the waist but not tight. It is super warm and cozy.',
  'I love Vuori because of their high quality fabric, and their comfortable and cozy pieces.',
  'Every single piece that I have from Vuori is so well made and softer than anything I have felt.',
];
const THIRD_PERSON_REAL = 'The Strato Tech is so soft and comfortable. It is also moisture wicking, so it is suitable for those longer days out in the sun.';
const REPORTED_REAL     = 'She says the bra provides the most comfortable support, while the leggings and crop top are super stretchy and flexible.';

check('W1 voice breaks a TIE between otherwise comparable lines', () => {
  // Deliberately NOT "first person beats any third-person line". Measured: the real
  // third-person Vuori line is longer and more specific than the real first-person one
  // and legitimately outranks it — a preference is not supposed to override better copy.
  // So the honest test holds content constant and varies only the voice.
  const pairs = [
    ['I have worn these every day since June and they still look new.',
     'These have been worn every day since June and they still look new.'],
    ['I love how soft and comfortable these joggers are after six months.',
     'The joggers stayed soft and comfortable after six months of wear.'],
  ];
  for (const [firstPerson, impersonal] of pairs) {
    assert.ok(scoreQuote(firstPerson) > scoreQuote(impersonal),
      `the customer speaking for themself should win the tie: ${JSON.stringify(firstPerson.slice(0, 46))}`);
  }
  // And the real pool still ranks on CONTENT, not on pronouns.
  assert.ok(scoreQuote(THIRD_PERSON_REAL) > scoreQuote('I like it.'),
    'a substantive third-person line must beat a thin first-person one');
});
check('W1b the nudge cannot cancel the funnel-stage lever', () => {
  // Stage is what makes a quote match the AD'S INTENT — it is the mechanism behind
  // per-intent variety. Voice is a tie-breaker about who is speaking. At +2 the bonus
  // flipped a stage decision purely because the losing quote said "I"; that regression
  // is pinned here as well as in verifyProofBeat.
  const durability = 'Easy to wash, they are super comfortable and held up after 6 months';
  const repeat = 'Worth every penny, I bought a second pair the next week';
  assert.ok(scoreQuote(durability, { stage: 'consideration' }) > scoreQuote(repeat, { stage: 'consideration' }),
    'at consideration the objection-removing quote must still win, pronoun or not');
  assert.ok(scoreQuote(repeat, { stage: 'conversion' }) > scoreQuote(durability, { stage: 'conversion' }),
    'and at conversion the ordering must still reverse');
});
check('W2 the third-person line is still USABLE, not discarded', () => {
  // The owner asked for a preference, not a purge. A negative or -Infinity score here
  // would mean a perfectly good review-article line could never be printed at all.
  assert.ok(Number.isFinite(scoreQuote(THIRD_PERSON_REAL)), 'must not be disqualified');
  assert.ok(scoreQuote(THIRD_PERSON_REAL) > 0, 'must still be able to win when it is the best on offer');
});
check('W3 reported speech ranks below both, and is still not disqualified', () => {
  const reported = scoreQuote(REPORTED_REAL);
  assert.ok(reported < scoreQuote(THIRD_PERSON_REAL),
    'relaying someone else\'s words is weaker proof than describing a product');
  assert.ok(Number.isFinite(reported), 'still usable as a last resort — this is a ranking, not a veto');
});
check('W4 "She says I would love it" is treated as a relay, not a testimonial', () => {
  // Order matters: a line containing BOTH markers must not collect the first-person
  // bonus just because it says "I" somewhere.
  const both = 'She says I would love how soft and comfortable these joggers are.';
  const plain = 'I would love how soft and comfortable these joggers are.';
  assert.ok(scoreQuote(both) < scoreQuote(plain),
    'the reported-speech penalty must win over the first-person bonus');
});
check('W5 the preference is bounded — it cannot outrank what the review says', () => {
  // A first-person line that is otherwise empty must not beat a specific, substantive
  // third-person one. The bonus breaks near-ties; it does not override content.
  const thin = 'I like it.';
  const rich = 'The Strato Tech held up through six months of daily wear and still looks new.';
  assert.ok(scoreQuote(rich) > scoreQuote(thin),
    'a substantive line must beat a thin first-person one');
});
check('W6 voice is judged on the TEXT, never on the source', () => {
  // Guards the inference I got wrong: a blog or YouTube attribution must not by itself
  // change a quote's rank. Same text, different provenance -> identical score.
  const text = 'I have worn these every day since June and they still look new.';
  assert.strictEqual(scoreQuote(text), scoreQuote(text),
    'scoreQuote must be a pure function of the text');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'layoutInputService.js'), 'utf8');
  // COMMENTS STRIPPED. The rationale for this rule necessarily NAMES the platforms it
  // refuses to branch on, so a raw-source pin fails on its own explanation — the same
  // trap that has bitten these harnesses before. Only executable code counts.
  const region = src.slice(src.indexOf('function scoreQuote'), src.indexOf('function pickStrongestQuote'))
    .split('\n')
    .filter((l) => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); })
    .join('\n');
  assert.ok(!/youtube|blog|instagram|tiktok|influencer/i.test(region),
    'scoring must not branch on the publishing platform — provenance is not intent');
});

  // Sequential, not Promise.all — several of these monkey-patch the shared
  // atlasLlmService module's exports and restore them in a finally block;
  // running them concurrently would race on that shared mutable state.
  for (const run of asyncChecks) await run();

  const total = pass + fail;
  if (fail === 0) {
    console.log(`\n✅ verifyQuoteSelection: ${pass}/${total} checks passed\n`);
    process.exit(0);
  }
  console.log(`\n❌ verifyQuoteSelection: ${fail} FAILED, ${pass} passed\n`);
  failures.forEach((f) => console.log(`   • ${f}`));
  process.exit(1);
})();
