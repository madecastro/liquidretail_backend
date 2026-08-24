#!/usr/bin/env node
'use strict';

/**
 * verifyProofReservationGate — offline, behavioural pins for the Director-side
 * RESERVED PROOF-LED SLOT gate (`hasUsableProof`, aiCreativeDirectorService.js).
 *
 * WHAT THE GATE IS
 * ----------------
 * buildPromptRound emits a `- PROOF-LED COVERAGE:` line that COMPELS at least
 * one of the round's concepts to be `creative_style="social_proof_led"`. It is
 * gated on a RATING being reachable — `signalHasRating || optionHasRating`,
 * never a quote or a comment alone. Introduced owner-authored in the sibling
 * backend as 9305e90d (2026-08-10, PR #110), ported here verbatim by 881dabd8.
 *
 * WHY THIS HARNESS EXISTS
 * -----------------------
 * That gate shipped with TWO justifications on record:
 *
 *   (i)  STRUCTURAL — the gate's condition must be a SUBSET of "the HONESTY
 *        RULE does not fire", so the prompt can never demand a proof-led
 *        concept while simultaneously forbidding proof (the PR #61
 *        self-contradictory-prompt class that cost a full video rollback).
 *
 *   (ii) RENDER-TIME COLLAPSE — `INTENTS.social_proof_led.eligible` was
 *        rating-only, so reserving on a quote alone would mint
 *        ai_social_proof_led and then fall straight back to objection_resolved
 *        at render, amplifying the very bug 9305e90d fixed.
 *
 * Justification (ii) is CONTINGENT on eligibility staying rating-only, and the
 * original comment did not say so. When a later change widened
 * `social_proof_led.eligible` to accept a quote alone, (ii) silently became a
 * description of a problem that had been fixed elsewhere — a stale comment
 * still being read as a live reason. THAT is the failure this file guards.
 * Justification (i) never went stale and is pinned by section B.
 *
 * WHAT SECTION C MEASURES — AND WHAT IT DOES NOT DECIDE
 * -----------------------------------------------------
 * The gate is rating-only TODAY. Section C measures, by calling the real
 * functions, what a rating-less `social_proof_led` render currently produces:
 * a `goal` demanding a rating widget its own `absences` forbid, an `emphasis`
 * ranking a non-existent rating above the quote that does exist, and on PMax
 * the loss of the in-image CTA button.
 *
 * That is a MEASUREMENT, not a policy ruling. Whether the Director should
 * COMPEL a proof-led concept for a quote-only product is the owner's call, and
 * an owner directive (2026-08-24) has already widened the separate RENDER-time
 * eligibility in that direction. This harness deliberately takes no position on
 * the gate itself — it pins what is true now, and trips when the preconditions
 * change, so the decision gets made deliberately instead of by drift.
 *
 * D2/D3 ARE DELIBERATE TRIPWIRES, NOT ORDINARY ASSERTIONS
 * -------------------------------------------------------
 * They pin the two residuals that keep the gate rating-only. If either is
 * CLOSED — goal/emphasis made conditional on `d.rating`, or social_proof_led
 * added to resolveDrawCta's PMax allowlist — the corresponding check goes RED
 * ON PURPOSE. A red D2/D3 is not a bug in this harness and not a regression in
 * the fix that closed the residual: it is the signal that the reservation gate
 * and its comment are now due a deliberate revisit (widening may finally be
 * correct). Read correction 1 in aiCreativeDirectorService.js, make the call,
 * then update this pin in the same commit.
 *
 * Calls the REAL buildPromptRound / INTENTS / absences / resolveDrawCta. No
 * source-text scan of anything that can be asserted by calling — the only text
 * reads are D1/D4, which are deliberately ABOUT the comment.
 *
 * Offline: no DB, no network, no API key.
 *   node scripts/verifyProofReservationGate.js
 *
 * Section A needs `json5` (a real dependency of aiCreativeDirectorService.js);
 * B/C/D need nothing outside this repo. In a bare worktree with no node_modules
 * section A SKIPS loudly rather than passing vacuously. Do NOT reach for
 * NODE_PATH to fix that — see the note above loadDirector().
 */

const fs = require('fs');
const path = require('path');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const ORIGINAL_MENU = process.env.DIRECTOR_PROOF_MENU_ENABLED;
const ORIGINAL_PMAX_NOTES = process.env.PMAX_STATIC_PLATFORM_NOTES;
function restoreEnv() {
  if (ORIGINAL_MENU === undefined) delete process.env.DIRECTOR_PROOF_MENU_ENABLED;
  else process.env.DIRECTOR_PROOF_MENU_ENABLED = ORIGINAL_MENU;
  if (ORIGINAL_PMAX_NOTES === undefined) delete process.env.PMAX_STATIC_PLATFORM_NOTES;
  else process.env.PMAX_STATIC_PLATFORM_NOTES = ORIGINAL_PMAX_NOTES;
}

const SERVICE_REL = 'src/services/aiCreativeDirectorService.js';
const SERVICE_ABS = path.join(__dirname, '..', SERVICE_REL);

const COVERAGE_MARKER = 'PROOF-LED COVERAGE';

// Section A needs aiCreativeDirectorService, whose require graph pulls a real
// npm dependency (json5). Sections B/C/D need only staticAdIntents, which
// requires nothing outside this repo. In a bare worktree with no node_modules
// the Director cannot load — and the fix is NOT to export NODE_PATH: pointing it
// at adgen's node_modules makes the SIBLING BACKEND's model files resolve a
// second, unpatched `mongoose` instance and turns verifyModelParity into ~33
// fake "never called mongoose.model" failures (see CLAUDE.md).
//
// So section A degrades to an explicit, loud SKIP that is counted separately and
// can never be mistaken for a pass. CI runs `npm ci` before `npm test`, so A
// always executes there — which is the gate that matters.
//
// A missing RELATIVE require ('./x', '../x') is real breakage in this repo and
// is never tolerated; only a missing bare package name is treated as an
// environment gap.
const skipped = [];
function loadDirector() {
  try {
    return { mod: require('../src/services/aiCreativeDirectorService') };
  } catch (err) {
    const missing = err && err.code === 'MODULE_NOT_FOUND'
      ? (String(err.message).match(/Cannot find module '([^']+)'/) || [])[1]
      : null;
    const isBarePackage = missing && !missing.startsWith('.') && !missing.startsWith('/');
    if (!isBarePackage) throw err;
    return { unavailable: missing };
  }
}

try {
  const S = require('../src/services/staticAdIntents');
  const SP = S.INTENTS.social_proof_led;
  const loaded = loadDirector();
  const Director = loaded.mod || null;

  // ── helpers ──────────────────────────────────────────────────────────
  // `kept` is the predicate buildPrompt passes as kept_ (role => bool).
  const keptAll = () => true;

  function round(socialProofSignal, { platformFormat = 'meta_feed_4_5' } = {}) {
    return Director.buildPromptRound({
      inputSummary: {
        product_signal: { name: 'Trailrunner 2' },
        brand_signal: { tone: 'calm, understated' },
        social_proof_signal: socialProofSignal
      },
      creativeIntent: null,
      platformFormat,
      universe: [{ mediaId: 'm1', role: 'hero', fileType: 'image' }],
      roundIndex: 0,
      avoidList: []
    });
  }
  // The reserved slot is spliced into the SYSTEM array (verified: buildPromptRound
  // returns { system, user, visionImages }). Scan both so a future move of the
  // block between the two halves cannot make this harness silently pass.
  const coverageFired = (r) =>
    String(r.system).includes(COVERAGE_MARKER) || String(r.user).includes(COVERAGE_MARKER);

  const QUOTE = 'These are the only shoes I can wear all day without my feet aching.';

  // Fixture matrix. `menu` selects DIRECTOR_PROOF_MENU_ENABLED for that fixture
  // (the getter reads env at CALL time, so no module-cache busting is needed).
  const FIXTURES = [
    { id: 'A1', label: 'signal rating 4.6',            menu: false, expect: true,
      sps: { rating: { value: 4.6 }, primary_quote: null, top_comments: [], proof_options: [] } },
    { id: 'A2', label: 'primary_quote only, no rating', menu: false, expect: false,
      sps: { rating: null, primary_quote: QUOTE, top_comments: [], proof_options: [] } },
    { id: 'A3', label: 'top_comments only, no rating',  menu: false, expect: false,
      sps: { rating: null, primary_quote: null, top_comments: [{ text: 'these are so comfy' }], proof_options: [] } },
    { id: 'A4', label: 'no proof at all',               menu: false, expect: false,
      sps: { rating: null, primary_quote: null, top_comments: [], proof_options: [] } },
    { id: 'A5', label: 'proof_options carrying a rating', menu: true, expect: true,
      sps: { rating: null, primary_quote: null, top_comments: [],
             proof_options: [{ tier: 'brand', rating: 4.8, reviews_text: '41000 brand reviews' }] } },
    { id: 'A6', label: 'proof_options, quotes but NO rating', menu: true, expect: false,
      sps: { rating: null, primary_quote: null, top_comments: [],
             proof_options: [{ tier: 'product', quote: QUOTE, rating: null }] } }
  ];

  // ── A. GATE BEHAVIOUR — what this PR must NOT change ─────────────────
  const fired = {};
  if (!Director) {
    skipped.push(`A1-A6 (gate behaviour) + B (containment) — cannot require ` +
      `aiCreativeDirectorService: missing dependency '${loaded.unavailable}'. ` +
      `Run in a checkout with node_modules installed (CI does). NOT a pass.`);
  } else {
    for (const f of FIXTURES) {
      process.env.DIRECTOR_PROOF_MENU_ENABLED = f.menu ? 'true' : 'false';
      const got = coverageFired(round(f.sps));
      fired[f.id] = got;
      check(`${f.id} ${f.label} → coverage line ${f.expect ? 'PRESENT' : 'ABSENT'}`,
        got === f.expect, `got ${got ? 'PRESENT' : 'ABSENT'}`);
    }
  }
  restoreEnv();

  // ── B. CONTAINMENT — the justification that did NOT go stale ─────────
  // Required invariant: the gate's condition is a SUBSET of "honesty rule does
  // not fire". Equivalently: the coverage line must NEVER fire on data for
  // which the honesty rule would demand social_proof_type="none". Asserted per
  // fixture rather than argued, so a future widening of EITHER side that breaks
  // containment fails here.
  for (const f of (Director ? FIXTURES : [])) {
    const sps = f.sps;
    const menuOn = f.menu;
    const honestyFires =
      !sps.primary_quote &&
      (!Array.isArray(sps.top_comments) || sps.top_comments.length === 0) &&
      !sps.rating &&
      (menuOn ? (!Array.isArray(sps.proof_options) || sps.proof_options.length === 0) : true);
    check(`B1${f.id.slice(1)} containment holds for ${f.label} (honestyFires=${honestyFires})`,
      !(fired[f.id] && honestyFires),
      'the reserved slot fired on data the HONESTY RULE would silence — PR #61 class');
  }
  // A4 is the only fixture where the honesty rule fires; if it ever stops being
  // so, the matrix above has lost its negative case and B proves nothing.
  check('B2 the matrix still contains a fixture where the honesty rule fires (A4)',
    !FIXTURES[3].sps.primary_quote && FIXTURES[3].sps.top_comments.length === 0 &&
    !FIXTURES[3].sps.rating && FIXTURES[3].sps.proof_options.length === 0);

  // ── C. THE MEASURED REASON the gate stays rating-only ────────────────
  const d = {
    quote: QUOTE, attribution: 'Dana R.', cta: 'Shop Now',
    rating: null, reviewCount: null, reviewsText: null, badge: null
  };

  const goalText = SP.goal(keptAll, {});
  check('C1 social_proof_led goal demands the rating widget',
    goalText.includes('star glyphs') && goalText.includes('the numeral') && goalText.includes('the count'),
    JSON.stringify(goalText).slice(0, 140));

  // buildPrompt calls spec.goal(kept_, { preserve }) — the DATA is never passed,
  // so `goal` structurally cannot be conditional on d.rating. Declared arity is
  // 1 because `ctx = {}` is a defaulted param (excluded from Function.length).
  const goalWithRatingCtx = SP.goal(keptAll, { rating: 4.6, preserve: false });
  check('C2 goal ignores any rating handed to it (cannot be rating-conditional)',
    goalWithRatingCtx === goalText,
    'goal returned a different string when ctx carried a rating');

  const em = SP.emphasis(d, keptAll, {});
  check('C3 emphasis ranks "the rating" SECOND on rating-less data',
    em[1] === 'the rating', `emphasis[1]=${JSON.stringify(em[1])}`);
  check('C4 emphasis demotes the customer\'s words to THIRD',
    em[2] === "the customer's own words", `emphasis[2]=${JSON.stringify(em[2])}`);

  const absent = S.absences(d, SP.renders, [], {}, {});
  const NUMERIC_BAN = 'no numeric score, star glyphs or trust mark of any kind';
  check('C5 absences forbids any numeric score / star glyph for the same data',
    absent.includes(NUMERIC_BAN), JSON.stringify(absent).slice(0, 200));

  // The contradiction itself, asserted in one place rather than left to a reader
  // to assemble from C1 and C5.
  check('C6 THE CONTRADICTION: goal demands star glyphs while absences forbid them',
    (goalText.includes('star glyphs') && absent.includes(NUMERIC_BAN)),
    'if this ever goes false the self-contradiction is gone — see D2');

  const orEm = S.INTENTS.objection_resolved.emphasis(d, keptAll, {});
  check('C7 objection_resolved leads with the customer\'s sentence (the coherent alternative)',
    orEm[0] === "the customer's sentence, as the loudest thing in the frame",
    `emphasis[0]=${JSON.stringify(orEm[0])}`);

  // PMax in-image CTA. resolveDrawCta rewrites pmax_* only when
  // PMAX_STATIC_PLATFORM_NOTES is on (default on: `!== 'false'`). Assert the
  // shipped default explicitly rather than inheriting an ambient value.
  delete process.env.PMAX_STATIC_PLATFORM_NOTES;
  const drawCta = (surfaceKey, intentKey) =>
    S.resolveDrawCta({ surfaceKey, policy: S.SURFACE_POLICY[surfaceKey], intentKey });
  check('C8 PMax grants NO in-image CTA to social_proof_led',
    drawCta('pmax_square_1_1', 'social_proof_led') === false);
  check('C9 PMax grants the in-image CTA to objection_resolved',
    drawCta('pmax_square_1_1', 'objection_resolved') === true);
  check('C10 Meta is unaffected — both intents keep their CTA',
    drawCta('meta_feed_4_5', 'social_proof_led') === true &&
    drawCta('meta_feed_4_5', 'objection_resolved') === true);
  restoreEnv();

  // ── D. STALENESS TRIPWIRES ───────────────────────────────────────────
  const eligibleVerdict = SP.eligible({ quote: QUOTE });
  const eligibilityWidened = eligibleVerdict === null;
  console.log(`  ℹ eligibility world: social_proof_led.eligible({quote}) → ${JSON.stringify(eligibleVerdict)}`);
  console.log(`    ${eligibilityWidened
    ? 'WIDENED — a quote-only product no longer falls back at render, so justification (ii) is retired.'
    : 'RATING-ONLY — a quote-only product still falls back to objection_resolved at render.'}`);

  const serviceSrc = fs.readFileSync(SERVICE_ABS, 'utf8');
  check('D1 the gate comment documents that justification (ii) is CONTINGENT',
    serviceSrc.includes('THAT ARGUMENT IS CONTINGENT'),
    `${SERVICE_REL} no longer flags the contingency — the exact omission that made this comment go stale`);

  // Residual 1 can be closed from EITHER end, so both are watched.
  //   D2a — `goal`, which today is handed no data at all.
  //   D2b — `emphasis`, which already receives `d` and is therefore the cheaper
  //         place to fix it (`d.rating ? 'the rating' : null`). A tripwire that
  //         only watched `goal` would sleep through the likelier fix; that gap
  //         was found by mutation-testing this harness, not by reading it.
  const RESIDUAL_1_ACTION =
    'NOT A BUG IN THIS HARNESS — READ THIS. Residual 1 (social_proof_led goal/emphasis not ' +
    'conditional on d.rating) appears CLOSED, likely by fix/social-proof-goal-emphasis-conditional. ' +
    'That was one of the TWO preconditions for widening the Director reservation gate to fire on a ' +
    'quote alone. Re-read correction 1 in src/services/aiCreativeDirectorService.js, decide the ' +
    'gate question with the owner (it is an owner call, see that comment), then update this pin in ' +
    'the SAME commit as the decision.';
  // The arity pin catches a shape the identical-string check cannot: if `goal`
  // grows a third DATA parameter, both calls below still pass it `undefined`,
  // so they agree with each other and D2a's string comparison sleeps. Declared
  // arity is 1 today (Function.length counts only params before the first
  // default, and `ctx = {}` is defaulted), so a `(kept, ctx, data)` signature
  // reads as 3 and trips here.
  check('D2a TRIPWIRE residual 1 still OPEN (goal is not rating-conditional)',
    goalWithRatingCtx === goalText && SP.goal.length === 1,
    `${RESIDUAL_1_ACTION} [goal.length=${SP.goal.length}, expected 1]`);
  check('D2b TRIPWIRE residual 1 still OPEN (emphasis still ranks a rating that does not exist)',
    em.includes('the rating') || em.includes('the rating and how many people gave it'),
    RESIDUAL_1_ACTION);

  check('D3 TRIPWIRE residual 2 still OPEN (PMax CTA allowlist excludes social_proof_led)',
    drawCta('pmax_square_1_1', 'social_proof_led') === false,
    'NOT A BUG IN THIS HARNESS — READ THIS. Residual 2 (resolveDrawCta grants the PMax ' +
    'in-image CTA only to objection_resolved) appears CLOSED, likely by ' +
    'fix/pmax-drawcta-social-proof. That was the other precondition for widening the Director ' +
    'reservation gate to fire on a quote alone. Re-read correction 1 in ' +
    'src/services/aiCreativeDirectorService.js, decide the gate question with the owner, then ' +
    'update this pin in the SAME commit as the decision.');

  // Each marker anchors one half of the reasoning the comment must keep: the
  // original recorded mechanism, the contingency that was missing the first time,
  // the owner-owned open question, and the two preconditions for revisiting.
  for (const marker of [
    'ORIGINAL mechanism (9305e90d',
    'THAT ARGUMENT IS CONTINGENT',
    'THE OPEN QUESTION',
    'PRECONDITIONS for widening'
  ]) {
    check(`D4 comment integrity: retains "${marker}"`,
      serviceSrc.includes(marker),
      'half the recorded reasoning has been dropped — restore it or replace it deliberately');
  }

} catch (err) {
  failures.push(`FATAL: ${err && err.stack ? err.stack : err}`);
} finally {
  restoreEnv();
}

const total = pass + failures.length;
if (skipped.length) {
  console.error(`\n⚠ verifyProofReservationGate: ${skipped.length} SECTION(S) SKIPPED — not verified:`);
  skipped.forEach((sk) => console.error('  ~ ' + sk));
}
if (failures.length) {
  console.error(`\n❌ verifyProofReservationGate: ${failures.length} FAILED, ${pass} passed (of ${total})\n`);
  failures.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log(`\n✅ verifyProofReservationGate: ${pass} checks passed` +
  (skipped.length ? ` (${skipped.length} section(s) SKIPPED — see above)` : ''));
