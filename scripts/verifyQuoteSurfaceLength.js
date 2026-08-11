#!/usr/bin/env node
/**
 * Offline harness for the 2026-08-10 per-surface quote-length change and the
 * unscoped-review-count fix. No DB, no network, no API key.
 *
 * WHAT THIS EXISTS TO CATCH (both observed on delivered Vuori creative):
 *
 *  1. A VIDEO-shaped 50-char cap was applied to STATIC. quoteSnippetService's
 *     own header says its output is "suitable for a 3-second video overlay"
 *     (MAX_CHARS = 50, prompt asks 4-8 words), and directImageRenderService
 *     preferred that snippet unconditionally. Result on a real ad:
 *       "The quality is amazing and the pair I have feel like second skin."
 *     rendered as
 *       "feel like second skin"
 *     — subject dropped, plural verb stranded. Owner: "sounds idiomatically
 *     incorrect ... we need to be including the entire quote".
 *
 *  2. remotion/lib/slotContent.js fabricated an UNSCOPED count:
 *       meta?.reviewsText || (meta?.reviewCount ? `${reviewCount} reviews` : '')
 *     A bare "15545 reviews" beside one product asserts a catalog-wide total as
 *     that SKU's own volume — the exact misattribution BRAND_SCOPE_LABEL exists
 *     to prevent, and which ratingDisplay's docstring claims is impossible
 *     ("There is no such hole now"). The hole was in the renderer.
 *
 * REVERT-PROVEN — each mutation confirmed to FAIL, then restored:
 *   - prefer snippet unconditionally again            -> S1/S2
 *   - drop the STATIC_QUOTE_MAX_CHARS overflow guard   -> S3
 *   - break flag-off byte-identity                     -> S5
 *   - restore the unscoped `${reviewCount} reviews`     -> R1/R2
 *
 * Run: node scripts/verifyQuoteSurfaceLength.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// THE SHIPPED IMPLEMENTATION, not a copy. Both adversarial passes flagged that
// behavioural checks running a local mirror cannot fail for the mutation they
// exist to catch — so the selector and cap resolver are required from the real
// module and exercised directly.
const { selectStaticQuoteText, resolveStaticQuoteCap } = require('../services/directImageRenderService');

const SRC_STATIC = path.join(__dirname, '..', 'services', 'directImageRenderService.js');
const SRC_SLOT   = path.join(__dirname, '..', 'remotion', 'lib', 'slotContent.js');
const SRC_SNIP   = path.join(__dirname, '..', 'services', 'quoteSnippetService.js');

let pass = 0, fail = 0;
const check = (label, fn) => {
  try { fn(); pass++; }
  catch (e) { fail++; console.log(`   • ${label} — ${String(e.message).split('\n')[0].slice(0, 220)}`); }
};

const staticSrc = fs.readFileSync(SRC_STATIC, 'utf8');
const slotSrc   = fs.readFileSync(SRC_SLOT, 'utf8');
const snipSrc   = fs.readFileSync(SRC_SNIP, 'utf8');

// The real Vuori quote that triggered this work, and its real snippet.
const FULL    = 'The quality is amazing and the pair I have feel like second skin. They go on flash sale and/or 20% off. Worth it in my opinion.';
const SNIPPET = 'feel like second skin';

// Thin adapter over the SHIPPED selector — no reimplementation of the policy.
function pickQuoteText({ text, snippet }, { fullQuoteEnabled = true, cap = 140 } = {}) {
  const quote = (text || snippet) ? { text, snippet } : null;
  return selectStaticQuoteText(quote, { fullQuoteEnabled, cap });
}

console.log('\nS. Static prefers the whole sentence');

check('S1 the real Vuori quote now prints in FULL, not the fragment', () => {
  const got = pickQuoteText({ text: FULL, snippet: SNIPPET });
  assert.strictEqual(got, FULL, `expected the full sentence, got ${JSON.stringify(got)}`);
  assert.notStrictEqual(got, SNIPPET, 'still rendering the subjectless fragment');
});
check('S2 source no longer prefers snippet unconditionally', () => {
  assert.ok(!/const quoteText = quote \? String\(quote\.snippet \|\| quote\.text \|\| ''\)\.trim\(\) : '';/.test(staticSrc),
    'the unconditional snippet-first expression is still the live one');
  assert.ok(/STATIC_FULL_QUOTE/.test(staticSrc), 'flag missing');
});
check('S3 an over-cap quote uses the snippet ONLY IF the snippet is ad-usable', () => {
  // POLICY CHANGED 2026-08-11 (owner: mediocre/negative must not pass any gate). This
  // check used to assert the snippet is taken unconditionally on overflow. That is what
  // typeset "feel like second skin" — a subjectless fragment that FAILS the render
  // path's own positivity bar while its parent quote passes it. Both halves are pinned
  // below so the cap is still proven to apply.
  const long = 'x'.repeat(260);
  assert.strictEqual(pickQuoteText({ text: long, snippet: SNIPPET }), '',
    'a fragment snippet must NOT be typeset just because the parent was long');
  const good = 'absolutely love these, so comfortable';
  assert.strictEqual(pickQuoteText({ text: long, snippet: good }), good,
    'an ad-usable snippet is still the right fallback — this is a gate, not a wall');
  assert.ok(good.length <= 140, 'and it still respects the cap');
});
check('S4 over-cap with NO snippet is SHORTENED, never shipped unbounded', () => {
  // This check previously asserted the OPPOSITE — that the full 260-char text
  // shipped — which pinned the hole an adversarial pass then found: the cap
  // silently did not apply on the one path with no snippet to fall back to.
  // Fixture must read like praise a customer wrote: the typeset string is now judged,
  // and lexically neutral filler is refused by design. The check's purpose is unchanged
  // — prove the cap applies and the result stays extractive.
  const long = `I absolutely love this and wear it constantly. ${'it is wonderful and soft '.repeat(20)}`;
  const got = pickQuoteText({ text: long, snippet: '' });
  assert.ok(got.length > 0, 'must still print something, not blank');
  assert.ok(got.length <= 140, `expected <=140 chars, got ${got.length}`);
  assert.ok(long.startsWith(got.replace(/…$/, '').trimEnd()),
    'shortening must stay extractive — a prefix of the reviewer\'s own words');
});
check('S4b pathological unbroken token is still clamped to the cap', () => {
  // truncateAtWordBoundary deliberately returns a single over-long token WHOLE
  // ("oversized beats unreadable" — correct for a 3s video overlay, wrong here).
  // Measured 401 chars for a 400-char spaceless input before the clamp.
  const blob = `I love it. ${'w'.repeat(400)}`;
  const got = pickQuoteText({ text: blob, snippet: '' });
  assert.ok(got.length <= 140, `unbroken token not clamped: ${got.length} chars`);
});
check('S5 flag-off is byte-identical to the pre-change expression', () => {
  // Behavioural: flag-off must reproduce snippet-first exactly.
  assert.strictEqual(pickQuoteText({ text: FULL, snippet: SNIPPET }, { fullQuoteEnabled: false }), SNIPPET);
  assert.strictEqual(pickQuoteText({ text: FULL, snippet: '' }, { fullQuoteEnabled: false }), FULL);
  // Structural: both arms must still be present in the real source, so this
  // harness cannot pass against a reimplementation that dropped one.
  assert.ok(/String\(quote\.snippet \|\| quote\.text \|\| ''\)\.trim\(\)/.test(staticSrc),
    'flag-off arm no longer reproduces the original expression');
  assert.ok(/STATIC_QUOTE_MAX_CHARS/.test(staticSrc), 'cap constant missing from source');
});
// Real resolver, not a mirror.
const resolveCap = (raw) => resolveStaticQuoteCap(raw);

check('S6 cap default is 140, env-tunable, and MALFORMED values are rejected', () => {
  // contract, not syntax
  assert.strictEqual(resolveCap(undefined), 140, 'unset must default to 140');
  assert.strictEqual(resolveCap(''), 140, 'empty must default to 140');
  assert.strictEqual(resolveCap('200'), 200, 'a valid override must be honoured');
  for (const bad of ['abc', '0', '-5', 'NaN', 'Infinity', '1e999']) {
    assert.strictEqual(resolveCap(bad), 140, `${JSON.stringify(bad)} must fall back to 140, not disable the cap`);
  }
  // SOURCE PINS, SCOPED BY PROXIMITY. A bare file-wide /Number\.isFinite\(/ pin
  // passed while the guard was mutated away, because that string occurs
  // elsewhere in this 3k-line file — the same too-loose-pin failure CLAUDE.md
  // §0.29998 records ("source pins must strip comments and assert PROXIMITY").
  // So slice out just the cap-resolution region and assert inside it.
  const capRegion = (() => {
    const i = staticSrc.indexOf('function resolveStaticQuoteCap');
    const j = staticSrc.indexOf('function selectStaticQuoteText');
    assert.ok(i !== -1 && j !== -1 && j > i,
      'resolveStaticQuoteCap not found — was it inlined or renamed? the pin must follow it');
    return staticSrc.slice(i, j);
  })();
  // The env value is read at the CALL SITE and passed into the validating
  // resolver, so pin both halves — reading env without validating it is exactly
  // the hole this check exists for.
  assert.ok(/resolveStaticQuoteCap\(process\.env\.STATIC_QUOTE_MAX_CHARS\)/.test(staticSrc),
    'the call site must pass the env value through the validating resolver');
  assert.ok(/Number\.isFinite\(/.test(capRegion),
    'cap must be VALIDATED inside its own resolution block, not bare-coerced');
  assert.ok(/>\s*0/.test(capRegion), 'cap must reject zero/negative values');
  assert.ok(/140/.test(capRegion), '140 default missing from the cap resolution');
});
check('S8 the OVERFLOW COMPARISON exists in the real source, not just the mirror', () => {
  // Added after revert-proofing caught this exact hole: mutating the real
  // source to always use the full text (guard deleted) left S3 GREEN, because
  // S3 exercises pickQuoteText above — a mirror, not the shipped expression.
  // S5's presence-check was too weak: the mutated source still DECLARED
  // STATIC_QUOTE_MAX_CHARS while no longer comparing against it. So pin the
  // comparison itself, and require the constant to be USED rather than merely
  // present. This is the CLAUDE.md §5 trap ("a test that cannot fail is not a
  // test") in its subtler form: a test that cannot fail for the mutation it was
  // written to catch.
  const selRegion = (() => {
    const i = staticSrc.indexOf('function selectStaticQuoteText');
    assert.ok(i !== -1, 'selectStaticQuoteText not found — was it inlined or renamed?');
    const j = staticSrc.indexOf('/** The product sentence', i);
    assert.ok(j > i, 'could not bound selectStaticQuoteText');
    return staticSrc.slice(i, j);
  })();
  assert.ok(/full\.length\s*<=\s*cap/.test(selRegion),
    'the length-vs-cap comparison is gone — an over-long quote would print in full');
  assert.ok(/text\.length > cap/.test(selRegion),
    'every candidate must be length-checked, not just the full text');
  assert.ok(/snippet,/.test(selRegion),
    'the snippet must still be a candidate — it is gated now, not removed');
  assert.ok(/shortenToCap\(full, cap\)/.test(selRegion),
    'the bounded last-resort shortening is gone');
  const shortener = staticSrc.slice(staticSrc.indexOf('function shortenToCap'));
  assert.ok(/truncateAtWordBoundary/.test(shortener),
    'overflow must reuse the shared shortener rather than ship unbounded text');
  assert.ok(/shortened\.length\s*<=\s*cap/.test(shortener),
    'the post-truncation clamp is gone — a single over-long token would exceed the cap');
});
check('S7 exactly-at-cap prints full; one over falls back', () => {
  // The UNABRIDGED text is trusted (already judged upstream by pickStrongestQuote), so
  // the boundary can be probed with any real quote padded to length.
  const base = 'I absolutely love these and they are wonderfully soft. ';
  const at   = base + 'z'.repeat(140 - base.length);
  const over = base + 'z'.repeat(141 - base.length);
  assert.strictEqual(at.length, 140);
  assert.strictEqual(pickQuoteText({ text: at, snippet: SNIPPET }), at, 'boundary is inclusive');
  assert.notStrictEqual(pickQuoteText({ text: over, snippet: SNIPPET }), over,
    'one char over must not print in full');
});

check('S9 over-cap WITH sentences prints whole sentences, not the fragment snippet', () => {
  // The owner's actual complaint, one layer down from retrieval: a long quote used
  // to fall straight through to the ≤50-char curated snippet, which is optimised to
  // be punchy and is therefore often subjectless ("feel like second skin").
  const long = 'I absolutely love these shorts and wear them constantly. '
    + 'I have now bought four more pairs in different colours because they hold up wash '
    + 'after wash and still look brand new after a year.';
  assert.ok(long.length > 140, 'fixture must be over the cap');
  const got = pickQuoteText({ text: long, snippet: SNIPPET });
  assert.notStrictEqual(got, SNIPPET, 'still preferring the subjectless fragment');
  assert.strictEqual(got, 'I absolutely love these shorts and wear them constantly.',
    `expected the first whole sentence, got ${JSON.stringify(got)}`);
  assert.ok(got.length <= 140, 'must still respect the cap');
  assert.ok(long.startsWith(got), 'must be a literal prefix of the reviewer\'s words — selection, not repair');
  assert.ok(/[.!?…]$/.test(got), 'must end on a sentence stop');
});
check('S10 a scrap of a first sentence does NOT beat a longer curated snippet', () => {
  // Guards the other direction: "Nice." is a complete sentence and terrible copy.
  const snippet = 'love the comfortable fit';     // ad-usable, so it can win
  const got = pickQuoteText({ text: `Nice. ${'x'.repeat(200)}`, snippet });
  assert.strictEqual(got, snippet,
    'a 5-char sentence must not win over a longer curated snippet');
});
check('S11 flag-off still reproduces snippet-first on a multi-sentence over-cap quote', () => {
  const long = 'These are wonderful and I wear them daily. '
    + 'Bought four more pairs because they hold up wash after wash and still look brand new after a full year.';
  assert.ok(long.length > 140);
  assert.strictEqual(pickQuoteText({ text: long, snippet: SNIPPET }, { fullQuoteEnabled: false }), SNIPPET,
    'the kill switch must restore the prior expression exactly');
});
check('S12 the sentence preference is in the SHIPPED selector, ahead of the snippet', () => {
  // Source pin with ordering, comments stripped (CLAUDE.md §0.29998): a preference
  // that runs AFTER the snippet fallback can never fire.
  const selRegion = (() => {
    const i = staticSrc.indexOf('function selectStaticQuoteText');
    const j = staticSrc.indexOf('/** The product sentence', i);
    assert.ok(i !== -1 && j > i, 'could not bound selectStaticQuoteText');
    return staticSrc.slice(i, j).split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  })();
  // The candidate list IS the preference order, so pin the order of its entries.
  const wholeFirst = selRegion.indexOf('whole.length >= snippet.length');
  const snip = selRegion.indexOf('snippet,');
  assert.ok(wholeFirst !== -1, 'selectStaticQuoteText no longer prefers whole sentences');
  assert.ok(snip !== -1 && wholeFirst < snip,
    'the whole-sentence preference must be ranked ABOVE the curated snippet');
  assert.ok(/completeSentencePrefix\(full, cap\)/.test(selRegion),
    'the sentence prefix must be bounded by the cap');
  // And the judge must actually be consulted, or the gate is decoration.
  assert.ok(/loadAdCopyJudge\(\)/.test(selRegion) && /judge\(text\)/.test(selRegion),
    'every manufactured candidate must be judged before it can be typeset');
});

check('S13 a hard limiter can never be typeset, even as a curated snippet', () => {
  // hasPositiveSignal is a word list and "best suited for lighter activities" contains
  // "best", so the limiter check is the only thing standing between that phrase and an
  // ad. It is a SEPARATE predicate from the positivity one, so it needs its own case:
  // a mutation making hasHardLimiter always-false is invisible otherwise.
  const limiter = 'love it, best suited for lighter activities';
  assert.ok(limiter.length <= 140);
  assert.strictEqual(pickQuoteText({ text: 'q'.repeat(200), snippet: limiter }), '',
    'a snippet that argues against the purchase must not be typeset');
});
check('S14 a neutral-but-real full quote is NOT refused (the gate is targeted)', () => {
  // The opposite failure to S13, and just as damaging. hasPositiveSignal is a LEXEME
  // allowlist: this is specific, credible durability proof with no flattery word in it.
  // The unabridged text is trusted because it was already judged upstream — twice — so
  // over-applying the typeset gate to it would silently delete good testimonials.
  const real = 'The fabric held up through a whole season of training.';
  assert.ok(real.length <= 140);
  assert.strictEqual(pickQuoteText({ text: real, snippet: 'held up' }), real,
    'the unabridged, already-judged text must still print');
});

console.log('V. The video snippet cap is untouched');

check('V1 quoteSnippetService still caps at 50 for the 3s overlay', () => {
  assert.ok(/const MAX_CHARS = 50;/.test(snipSrc),
    'the video overlay cap must stay 50 — this change is static-only');
  assert.ok(/3-second video overlay/.test(snipSrc), 'the video rationale should remain documented');
});

console.log('R. No unscoped review count can reach a frame');

check('R1 the unscoped fabrication is gone from slotContent', () => {
  assert.ok(!/\$\{meta\.reviewCount\}\s*reviews/.test(slotSrc),
    'slotContent still fabricates a bare "<n> reviews" with no tier qualifier');
  assert.ok(!/meta\?\.reviewCount\s*\?\s*`/.test(slotSrc),
    'the reviewCount-based fallback template is still present');
});
check('R2 reviewsText is taken only from the scoped upstream value', () => {
  assert.ok(/const reviewsText = meta\?\.reviewsText \|\| '';/.test(slotSrc),
    'reviewsText must come solely from ratingDisplay, which attaches the qualifier');
});
check('R3 the slot still shows on rating-only (GymShark-style suppression intact)', () => {
  // rating present + no reviewsText must NOT hide the slot; the guard is
  // "neither rating nor reviewsText". Structural check on the surviving guard.
  assert.ok(/if \(!hasRating && !reviewsText\) return null;/.test(slotSrc),
    'the both-absent guard must remain — removing it would blank legitimate rating-only lockups');
});
check('R5 the SIBLING fabricator in ReviewCountSlot is closed too', () => {
  // Adversarial review: closing the rating composite in slotContent.js left
  // ReviewCountSlot formatting a BARE NUMBER into "15,545 reviews" — unscoped,
  // and it dropped the word "brand" that made the upstream string honest. R1
  // only greps slotContent.js, so it never saw this. Reachable via an
  // operator/LLM titleStyleSpec enabling the reviewCount slot; no shipped
  // preset does today, which is why it was latent rather than live.
  const rs = fs.readFileSync(path.join(__dirname, '..', 'remotion', 'components', 'slotRenderers.jsx'), 'utf8');
  const i = rs.indexOf('export const ReviewCountSlot');
  assert.ok(i !== -1, 'ReviewCountSlot not found');
  const region = rs.slice(i, i + 2400);
  assert.ok(!/\$\{asNum\.toLocaleString\('en-US'\)\}\s*review/.test(region),
    'ReviewCountSlot still fabricates an unscoped "<n> reviews" from a raw number');
  assert.ok(/isPrewrapped/.test(region),
    'a prewrapped scoped string must still pass through untouched');
});
check('R4 scoped strings still flow (ratingDisplay is the only author)', () => {
  const rd = fs.readFileSync(path.join(__dirname, '..', 'services', 'ratingDisplay.js'), 'utf8');
  assert.ok(/BRAND_SCOPE_LABEL = 'brand reviews'/.test(rd), 'brand scope label changed');
  assert.ok(/function formatBrandReviewsText/.test(rd), 'brand reviewsText formatter missing');
});

const total = pass + fail;
if (fail === 0) {
  console.log(`\n✅ verifyQuoteSurfaceLength: ${pass}/${total} checks passed\n`);
  process.exit(0);
}
console.log(`\n❌ verifyQuoteSurfaceLength: ${fail} FAILED, ${pass} passed\n`);
process.exit(1);
