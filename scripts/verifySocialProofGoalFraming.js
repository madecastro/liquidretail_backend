#!/usr/bin/env node
'use strict';

/**
 * verifySocialProofGoalFraming — offline, behavioural pins for the
 * social_proof_led goal / emphasis rating-less arm.
 *
 * THE DEFECT
 * ----------
 * `INTENTS.social_proof_led` used to be eligible only when `d.rating` existed,
 * so its `goal` and `emphasis` could assert a rating unconditionally and never
 * be wrong. STATIC_SOCIAL_PROOF_QUOTE_ELIGIBLE (a separate PR) widens
 * `eligible` to rating-OR-a-usable-quote and makes `core` / `text()`
 * rating-aware — but deliberately left `goal` and `emphasis` byte-for-byte
 * alone. Measured with buildPrompt on quote-only data, no rating, that
 * produces a prompt that argues with itself:
 *
 *   WHAT THIS AD HAS TO DO: "…should see the rating widget — star glyphs, the
 *     numeral, the count — before they read a word of body copy."
 *   WHAT SHOULD WIN ATTENTION: "  2. the rating"
 *   THIS PRODUCT HAS NONE OF THE FOLLOWING: "no numeric score, star glyphs or
 *     trust mark of any kind"
 *
 * The absences line is correct — `absences()` reads `d.rating`. The goal and
 * the emphasis ranking were the two places that did not. This is the same
 * self-contradictory-prompt class the file already fixed twice (the
 * RATING_FURNITURE catch-all carve-out, and product_first_lifestyle's goal
 * promising "nothing but the product and a line" on a zero-text render).
 *
 * THE FIX (staticAdIntents.js, INTENTS.social_proof_led)
 * -----------------------------------------------------
 * `goal` and `emphasis` branch on `kept('RATING')`. For this intent that is
 * equivalent to `d.rating` — `text()` emits a RATING tuple only when
 * `d.rating` is present, and `core` names RATING so `applyDensity` can never
 * sacrifice it — and it is the SAME predicate `buildPrompt` already uses to
 * compute `furnitureRating`, which selects the absence line the goal was
 * contradicting. Keying both off `kept()` is what makes the contradiction
 * unrepresentable rather than merely fixed once.
 *
 * WHAT THIS SCRIPT ASSERTS
 * ------------------------
 *   A. Every rating-bearing render's goal + emphasis is BYTE-FOR-BYTE the
 *      pre-fix text, on all 7 static surfaces × STATIC_RATING_FURNITURE
 *      unset/true/false × 4 rating-bearing data shapes × preserve off/on.
 *      Goldens below were captured by running master @ ea709a3 BEFORE the fix.
 *   B. A quote-only render's goal + emphasis mention neither "rating" nor
 *      "widget", and centre the customer's sentence instead.
 *   C. STATIC_RATING_FURNITURE=false is untouched — the pre-change
 *      "many real people … rate it highly" goal, byte-for-byte, and the same
 *      emphasis list as flag-on.
 *   D. Revert-proof: the pre-fix `goal` / `emphasis` implementations are
 *      restored onto the live spec and section B is re-run against them; each
 *      B check is asserted to FAIL. A green B that cannot go red proves
 *      nothing.
 *   E. Self-consistency: on the quote-only prompt the absences section bans
 *      every rating mark AND the goal/emphasis sections demand none — the
 *      exact contradiction, asserted as a property of one prompt string.
 *   F. Blast radius: objection_resolved / product_first_lifestyle / brand_led
 *      goal + emphasis are unchanged for the same data.
 *
 * REACHING THE QUOTE-ONLY BRANCH (sections B / D / E)
 * --------------------------------------------------
 * On master, `resolveIntent` enforces `eligible`, which is rating-only — a
 * quote-only request falls back to objection_resolved, so the branch is
 * unreachable BY CONSTRUCTION and no data shape can reach it. This script
 * therefore PROBES the live spec and, only if the widening has not landed
 * yet, installs a minimal shim replicating exactly the three guards
 * STATIC_SOCIAL_PROOF_QUOTE_ELIGIBLE ships (`eligible`, `core`, `text`),
 * derived from the real `text()` rather than reimplemented. Everything else
 * — resolveIntent, applyDensity, absences, goal, emphasis, prompt assembly —
 * is the real, unmodified code path. When that PR lands, the probe sees the
 * real widened gate, the shim goes dormant, and these same assertions run
 * against production code with nothing patched. The script prints which arm
 * ran; it never silently degrades.
 *
 * Offline: no DB, no network, no API key.
 *   node scripts/verifySocialProofGoalFraming.js
 */

const path = require('path');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const ORIGINAL_FURNITURE = process.env.STATIC_RATING_FURNITURE;
const ORIGINAL_PRESERVE = process.env.STATIC_LIFESTYLE_PRESERVE;

const INTENTS_MOD = '../src/services/staticAdIntents';
const GUARDS_MOD = '../src/services/adCopyGuards';

function restoreEnv() {
  if (ORIGINAL_FURNITURE === undefined) delete process.env.STATIC_RATING_FURNITURE;
  else process.env.STATIC_RATING_FURNITURE = ORIGINAL_FURNITURE;
  if (ORIGINAL_PRESERVE === undefined) delete process.env.STATIC_LIFESTYLE_PRESERVE;
  else process.env.STATIC_LIFESTYLE_PRESERVE = ORIGINAL_PRESERVE;
}

/**
 * Re-require staticAdIntents under a specific furniture-flag value. Both
 * RATING_FURNITURE (staticAdIntents) and ratingFurnitureEnabled (adCopyGuards)
 * are read at module load, so both caches have to go. `undefined` unsets the
 * env var, which is the default-ON path — the arm production actually runs.
 */
function loadIntents(furnitureFlag, preserveFlag = 'false') {
  delete require.cache[require.resolve(INTENTS_MOD)];
  delete require.cache[require.resolve(GUARDS_MOD)];
  if (furnitureFlag === undefined) delete process.env.STATIC_RATING_FURNITURE;
  else process.env.STATIC_RATING_FURNITURE = furnitureFlag;
  process.env.STATIC_LIFESTYLE_PRESERVE = preserveFlag;
  return require(INTENTS_MOD);
}

// ── structural section extraction ───────────────────────────────────────
// Sliced at the prompt template's own syntactic boundaries, never at a
// character count: a magic offset drifts stale the first time an adjacent
// block is edited, and then silently checks the wrong window.
const GOAL_OPEN = '\nWHAT THIS AD HAS TO DO: ';
const EMPH_OPEN = '\n\nWHAT SHOULD WIN ATTENTION, in this order:\n';
const EMPH_CLOSE = '\nThat is an order of importance';
const ABSENCE_OPEN = '\nTHIS PRODUCT HAS NONE OF THE FOLLOWING, so none of it may appear:\n';
const ABSENCE_CLOSE = '\nIf an element is not listed in the text above';

function sliceBetween(prompt, open, close) {
  const a = prompt.indexOf(open);
  if (a < 0) return null;
  const b = prompt.indexOf(close, a + open.length);
  if (b < 0) return null;
  return prompt.slice(a + open.length, b);
}

/** { goal, emphasis, absences } or null if any boundary is missing. */
function sections(prompt) {
  if (typeof prompt !== 'string') return null;
  const goal = sliceBetween(prompt, GOAL_OPEN, EMPH_OPEN);
  const emphasis = sliceBetween(prompt, EMPH_OPEN, EMPH_CLOSE);
  const absent = sliceBetween(prompt, ABSENCE_OPEN, ABSENCE_CLOSE);
  if (goal === null || emphasis === null || absent === null) return null;
  return { goal, emphasis, absences: absent };
}

// ── fixtures ────────────────────────────────────────────────────────────
const PRODUCT = {
  desc: 'Soludos Classic Lace-Up Espadrille in Natural — canvas upper, jute midsole.',
  look: 'sunlit coastal, natural canvas, easy summer',
  logoCorner: 'bottom-right'
};

const SHAPES = {
  // rating + count + quote + attribution + badge — the maximum case
  full:    { rating: '4.8', reviewCount: 523, reviewsText: '523 reviews', quote: 'The most comfortable shoe I own.', attribution: 'Dana', badge: 'Best Seller', cta: 'Shop Now' },
  // rating, NO reviewCount — selects the short 'the rating' emphasis wording
  noCount: { rating: '4.8', quote: 'The most comfortable shoe I own.', attribution: 'Dana', cta: 'Shop Now' },
  // rating + count, no quote
  noQuote: { rating: '4.8', reviewCount: 523, reviewsText: '523 reviews', cta: 'Shop Now' },
  // rating only
  minimal: { rating: '4.8', cta: 'Shop Now' }
};

// The case this whole change exists for: real customer proof, no numeric score.
const QUOTE_ONLY = {
  quote: 'The most comfortable shoe I own.', attribution: 'Dana', cta: 'Shop Now'
};

const SURFACES = [
  'meta_feed_1_1', 'meta_feed_4_5', 'meta_stories_9_16',
  'pmax_16_9', 'pmax_landscape_1_91_1', 'pmax_square_1_1', 'pmax_portrait_4_5'
];

// ── GOLDENS ─────────────────────────────────────────────────────────────
// Captured by running buildPrompt on master @ ea709a3 BEFORE the goal /
// emphasis change. These strings are the byte-identity contract: a
// rating-bearing render must produce them exactly, forever, on every arm.
const GOAL_FURNITURE_ON =
  'A stranger scrolling past should see the rating widget — star glyphs, the numeral, the count — before they read a word of body copy. The rating is those marks, not a sentence about them.';
const GOAL_FURNITURE_OFF =
  'A stranger scrolling past should understand, before reading a word of body copy, that many real people already bought this and rate it highly.';

const PRODUCT_1_SCENE = 'the product itself, shown large and desirable';
const PRODUCT_1_PRESERVE = 'the product as the photograph already presents it — desirable as shown';
const RATING_WITH_COUNT = 'the rating and how many people gave it';
const RATING_BARE = 'the rating';
const QUOTE_WITH_RATING = "the customer's own words";
const BADGE_LINE = 'the badge, quietly';
const CTA_LINE = 'the CTA, unmissable but not shouting';

/** Render an ordered list the way buildPrompt's template does. */
function numbered(items) {
  return items.map((e, i) => `  ${i + 1}. ${e}`).join('\n');
}

/**
 * Expected emphasis for a RATING-BEARING render, stated from the golden
 * fragments above plus what buildPrompt is known to drop for that surface.
 * `dropped` and `drawCta` come from the REAL buildPrompt result, so this
 * never re-implements density — it only re-assembles the pinned strings.
 */
function expectedRatingEmphasis(shape, { dropped, drawCta, preserve }) {
  const d = SHAPES[shape];
  const lost = (r) => dropped.includes(r);
  return numbered([
    preserve ? PRODUCT_1_PRESERVE : PRODUCT_1_SCENE,
    d.reviewCount ? RATING_WITH_COUNT : RATING_BARE,
    d.quote && !lost('CUSTOMER QUOTE') ? QUOTE_WITH_RATING : null,
    d.badge && !lost('BADGE') ? BADGE_LINE : null,
    drawCta ? CTA_LINE : null
  ].filter(Boolean));
}

// ── PR-#34 shim (sections B / D / E only) ───────────────────────────────
/**
 * Probe the LIVE spec: has STATIC_SOCIAL_PROOF_QUOTE_ELIGIBLE landed? This is
 * a behavioural probe — call the real predicate with quote-only data — not a
 * version sniff, so it stays true regardless of how the widening is spelled.
 */
function quoteOnlyIsEligible(M) {
  return M.INTENTS.social_proof_led.eligible(QUOTE_ONLY) === null;
}

/**
 * Run `fn` with social_proof_led able to run on a quote alone. If the widening
 * has already landed, nothing is patched at all. Otherwise install the three
 * guards that PR verbatim ships — and NOTHING else; goal, emphasis, renders,
 * absences, applyDensity, resolveIntent and prompt assembly stay real.
 * Restored in `finally`, including on a throw.
 */
function withQuoteOnlyEligible(M, fn) {
  const spec = M.INTENTS.social_proof_led;
  if (quoteOnlyIsEligible(M)) return fn({ shimmed: false });

  const orig = { eligible: spec.eligible, core: spec.core, text: spec.text };
  spec.eligible = (d) => (d.rating || d.quote)
    ? null
    : 'no rating or usable quote — this intent is the proof';
  // `core` is a literal array on master (applyDensity does spec.core.includes)
  // and a function of the data once the widening lands. The shim only ever
  // runs with quote-only data, so the quote is what density must protect.
  spec.core = ['CUSTOMER QUOTE'];
  // Derived from the REAL text(), not reimplemented: drop only the RATING
  // tuple, and only when there is no rating to print.
  spec.text = (d) => orig.text(d).filter(([role]) => role !== 'RATING' || d.rating);
  try {
    return fn({ shimmed: true });
  } finally {
    spec.eligible = orig.eligible;
    spec.core = orig.core;
    spec.text = orig.text;
  }
}

/** The B-section assertions, as data, so section D can re-run and invert them. */
/**
 * Whether section B ran through the documented eligibility shim (this tree)
 * or against the real widened gate. Declared at module scope: the success
 * summary at the bottom reports it, and `try {}` is a block.
 */
let shimUsed = null;

function quoteOnlyChecks(sec) {
  return [
    ['B1 goal names no rating', !/rating/i.test(sec.goal)],
    ['B2 goal names no widget', !/widget/i.test(sec.goal)],
    ['B3 emphasis names no rating', !/rating/i.test(sec.emphasis)],
    ['B4 emphasis names no widget', !/widget/i.test(sec.emphasis)],
    ['B5 goal names no star glyphs / numeral / count', !/star glyph|numeral|the count/i.test(sec.goal)],
    ['B6 goal centres the customer sentence', /customer/i.test(sec.goal) && /sentence/i.test(sec.goal)],
    ['B7 emphasis still ranks the customer words', /the customer's own words/.test(sec.emphasis)],
    ['B8 emphasis names them as the proof', /the proof this ad rests on/.test(sec.emphasis)],
    ['B9 product still leads (this intent is not objection_resolved)',
      sec.emphasis.startsWith(`  1. ${PRODUCT_1_SCENE}`)]
  ];
}

try {
  // ── sanity: the flag loader actually flips the const ──────────────────
  {
    const on = loadIntents(undefined);
    const off = loadIntents('false');
    const on2 = loadIntents('true');
    check('S1 unset ships RATING_FURNITURE true', on.RATING_FURNITURE === true);
    check('S1 "false" ships RATING_FURNITURE false', off.RATING_FURNITURE === false);
    check('S1 "true" ships RATING_FURNITURE true', on2.RATING_FURNITURE === true);
  }

  // ── A / C. byte-identity for every rating-bearing render ──────────────
  console.log('A. rating-bearing goal + emphasis are byte-for-byte the pre-fix text');
  console.log('C. STATIC_RATING_FURNITURE=false arm untouched');
  {
    let cells = 0;
    for (const furniture of [undefined, 'true', 'false']) {
      for (const preserveFlag of ['false', 'true']) {
        const M = loadIntents(furniture, preserveFlag);
        const arm = furniture === undefined ? 'unset' : furniture;
        const expectedGoal = M.RATING_FURNITURE ? GOAL_FURNITURE_ON : GOAL_FURNITURE_OFF;

        for (const shape of Object.keys(SHAPES)) {
          for (const surface of SURFACES) {
            // seedStyle drives shouldPreserveScene; with STATIC_LIFESTYLE_PRESERVE
            // off it is inert, which is exactly the byte-identity claim.
            const r = M.buildPrompt({
              intentKey: 'social_proof_led',
              data: SHAPES[shape],
              product: PRODUCT,
              surface,
              seedStyle: preserveFlag === 'true' ? 'lifestyle' : null
            });
            const tag = `${shape}/${surface}/furniture=${arm}/preserve=${preserveFlag}`;

            check(`A0 ${tag}: built and stayed social_proof_led`,
              !r.error && !r.skipped && r.resolved && r.resolved.key === 'social_proof_led',
              r.error || r.skipped || (r.resolved && r.resolved.key));
            const sec = sections(r.prompt);
            check(`A0 ${tag}: both sections located structurally`, sec !== null);
            if (!sec) continue;
            cells++;

            const label = furniture === 'false' ? 'C1' : 'A1';
            check(`${label} ${tag}: goal byte-identical`,
              sec.goal === expectedGoal,
              sec.goal === expectedGoal ? '' : `got ${JSON.stringify(sec.goal)}`);

            const wantEmph = expectedRatingEmphasis(shape, {
              dropped: r.dropped || [],
              drawCta: r.policy.drawCta !== false,
              preserve: r.preserveScene === true
            });
            check(`${label} ${tag}: emphasis byte-identical`,
              sec.emphasis === wantEmph,
              sec.emphasis === wantEmph
                ? ''
                : `\n      got:  ${JSON.stringify(sec.emphasis)}\n      want: ${JSON.stringify(wantEmph)}`);
          }
        }
      }
    }
    check('A2 the matrix actually ran', cells === 3 * 2 * 4 * SURFACES.length,
      `cells=${cells} expected=${3 * 2 * 4 * SURFACES.length}`);
  }

  // ── C2. flag-off goal is the pre-change sentence, and ON is not ────────
  {
    const off = loadIntents('false');
    const on = loadIntents(undefined);
    const offP = off.buildPrompt({
      intentKey: 'social_proof_led', data: SHAPES.full, product: PRODUCT, surface: 'meta_feed_4_5'
    }).prompt;
    const onP = on.buildPrompt({
      intentKey: 'social_proof_led', data: SHAPES.full, product: PRODUCT, surface: 'meta_feed_4_5'
    }).prompt;
    check('C2 OFF carries the original "many real people" goal',
      offP.includes(GOAL_FURNITURE_OFF));
    check('C2 OFF does NOT carry the widget goal', !offP.includes(GOAL_FURNITURE_ON));
    check('C2 ON carries the widget goal', onP.includes(GOAL_FURNITURE_ON));
    check('C2 ON does NOT carry the original goal', !onP.includes(GOAL_FURNITURE_OFF));
    check('C2 the two arms still differ (the flag does work)', onP !== offP);
  }

  // ── B / E. quote-only render ──────────────────────────────────────────
  console.log('B. quote-only goal + emphasis demand no rating');
  console.log('E. the quote-only prompt does not argue with itself');
  {
    const M = loadIntents(undefined);
    withQuoteOnlyEligible(M, ({ shimmed }) => {
      shimUsed = shimmed;
      console.log(shimmed
        ? '   … STATIC_SOCIAL_PROOF_QUOTE_ELIGIBLE not present in this tree; eligible/core/text shimmed to it. goal/emphasis/absences/density are the real code.'
        : '   … STATIC_SOCIAL_PROOF_QUOTE_ELIGIBLE is live; nothing patched, asserting against production code.');

      for (const surface of SURFACES) {
        const r = M.buildPrompt({
          intentKey: 'social_proof_led', data: QUOTE_ONLY, product: PRODUCT, surface
        });
        check(`B0 ${surface}: quote-only resolves social_proof_led`,
          !r.error && !r.skipped && r.resolved && r.resolved.key === 'social_proof_led',
          r.error || r.skipped || (r.resolved && r.resolved.key));
        const sec = sections(r.prompt);
        check(`B0 ${surface}: sections located`, sec !== null);
        if (!sec) continue;

        for (const [name, cond] of quoteOnlyChecks(sec)) {
          check(`${name} [${surface}]`, cond,
            cond ? '' : `goal=${JSON.stringify(sec.goal)} emphasis=${JSON.stringify(sec.emphasis)}`);
        }

        // E — the contradiction, asserted on one prompt string. The absence
        // line is what the goal used to fight; both halves are checked here so
        // a future edit cannot fix one and re-break the other.
        check(`E1 ${surface}: absences ban every rating mark`,
          sec.absences.includes('no numeric score, star glyphs or trust mark of any kind'),
          `absences=${JSON.stringify(sec.absences)}`);
        check(`E2 ${surface}: nothing in goal or emphasis demands one`,
          !/rating|widget|star glyph/i.test(`${sec.goal}\n${sec.emphasis}`));
        check(`E3 ${surface}: the quote itself still reaches SET EXACTLY`,
          r.prompt.includes('customer quote -> "The most comfortable shoe I own."'));
        check(`E4 ${surface}: no "undefined ★" leaked into the text block`,
          !r.prompt.includes('undefined'));
      }
    });
    check('B10 the quote-only arm was exercised', shimUsed !== null);
  }

  // ── D. revert-proof ───────────────────────────────────────────────────
  console.log('D. revert-proof — the pre-fix goal/emphasis FAIL section B');
  {
    const M = loadIntents(undefined);
    const spec = M.INTENTS.social_proof_led;
    const RATING_FURNITURE = M.RATING_FURNITURE;
    const realGoal = spec.goal;
    const realEmphasis = spec.emphasis;

    // Verbatim pre-fix implementations (master @ ea709a3).
    spec.goal = (kept, ctx = {}) => RATING_FURNITURE ? GOAL_FURNITURE_ON : GOAL_FURNITURE_OFF;
    spec.emphasis = (d, kept, ctx = {}) => [
      ctx.preserve ? PRODUCT_1_PRESERVE : PRODUCT_1_SCENE,
      d.reviewCount ? RATING_WITH_COUNT : RATING_BARE,
      kept('CUSTOMER QUOTE') ? QUOTE_WITH_RATING : null,
      kept('BADGE') ? BADGE_LINE : null,
      kept('CTA BUTTON') ? CTA_LINE : null
    ].filter(Boolean);

    try {
      withQuoteOnlyEligible(M, () => {
        const r = M.buildPrompt({
          intentKey: 'social_proof_led', data: QUOTE_ONLY, product: PRODUCT, surface: 'meta_feed_4_5'
        });
        const sec = sections(r.prompt);
        check('D0 reverted build still produced a prompt', sec !== null);
        if (!sec) return;
        const results = quoteOnlyChecks(sec);
        // Every check that the fix makes pass must go red on the pre-fix code.
        // Three are NOT discriminating and are excluded BY NAME — never by
        // assuming a count — with the reason each one is green either way:
        //   B4  the pre-fix emphasis said "the rating", never "widget", so
        //       "emphasis names no widget" passes on both sides. It stays in
        //       section B as a forward guard against a future edit importing
        //       the goal's widget language into the ranking; it just cannot
        //       serve as proof that section B can fail.
        //   B7  the quote line ("the customer's own words") predates this
        //       change — the pre-fix emphasis already emitted it.
        //   B9  product-at-#1 predates this change too; keeping it is the
        //       point (this intent is not objection_resolved), so it is
        //       green on both sides by design.
        const MUST_FAIL = ['B1', 'B2', 'B3', 'B5', 'B6', 'B8'];
        for (const [name, cond] of results) {
          const code = name.split(' ')[0];
          if (!MUST_FAIL.includes(code)) continue;
          check(`D1 pre-fix code FAILS ${name}`, cond === false,
            cond === false ? '' : 'check passed against the reverted code — it cannot detect the defect');
        }
        check('D2 pre-fix goal is verbatim the widget demand',
          sec.goal === GOAL_FURNITURE_ON, `got ${JSON.stringify(sec.goal)}`);
        check('D3 pre-fix emphasis ranks the rating #2 with no rating on frame',
          sec.emphasis.includes(`  2. ${RATING_BARE}`), `got ${JSON.stringify(sec.emphasis)}`);
        check('D4 pre-fix prompt DOES contradict its own absences section',
          sec.absences.includes('no numeric score, star glyphs or trust mark of any kind')
          && /rating widget/.test(sec.goal));
      });
    } finally {
      spec.goal = realGoal;
      spec.emphasis = realEmphasis;
    }

    // D5 — the restore worked; the live spec is the fixed one again.
    const after = M.buildPrompt({
      intentKey: 'social_proof_led', data: SHAPES.full, product: PRODUCT, surface: 'meta_feed_4_5'
    });
    check('D5 spec restored after the revert experiment',
      sections(after.prompt).goal === GOAL_FURNITURE_ON);
  }

  // ── F. blast radius ───────────────────────────────────────────────────
  console.log('F. other intents unchanged');
  {
    const M = loadIntents(undefined);
    const OTHER = {
      objection_resolved: {
        goal: "A stranger scrolling past should have the specific worry that stops people buying this category answered by someone who already bought it. The customer's sentence is the whole ad.",
        emphasisHead: "  1. the customer's sentence, as the loudest thing in the frame\n  2. the product, clearly the thing being talked about"
      },
      product_first_lifestyle: { emphasisHead: '  1. the product in a scene someone wants to be in' },
      brand_led: {}
    };
    const data = { ...SHAPES.full, headline: 'Walk lighter.', subhead: 'Every day.' };
    for (const intentKey of Object.keys(OTHER)) {
      for (const surface of SURFACES) {
        const r = M.buildPrompt({ intentKey, data, product: PRODUCT, surface });
        const sec = sections(r.prompt);
        check(`F0 ${intentKey}/${surface}: built`, sec !== null && !r.error);
        if (!sec) continue;
        check(`F1 ${intentKey}/${surface}: goal has no social_proof_led text`,
          sec.goal !== GOAL_FURNITURE_ON && sec.goal !== GOAL_FURNITURE_OFF);
        const exp = OTHER[intentKey];
        if (exp.goal) {
          check(`F2 ${intentKey}/${surface}: goal byte-identical`,
            sec.goal === exp.goal, `got ${JSON.stringify(sec.goal)}`);
        }
        if (exp.emphasisHead) {
          check(`F3 ${intentKey}/${surface}: emphasis head byte-identical`,
            sec.emphasis.startsWith(exp.emphasisHead),
            `got ${JSON.stringify(sec.emphasis)}`);
        }
      }
    }
  }

} catch (err) {
  failures.push(`FATAL: ${err && err.stack ? err.stack : err}`);
} finally {
  restoreEnv();
}

const total = pass + failures.length;
if (failures.length) {
  console.error(`\n❌ verifySocialProofGoalFraming: ${failures.length} FAILED, ${pass} passed (of ${total})\n`);
  failures.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log(`\n✅ verifySocialProofGoalFraming: ${pass} checks passed${shimUsed ? ' (quote-only arm via documented eligibility shim)' : ''}`);
