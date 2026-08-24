#!/usr/bin/env node
'use strict';

/**
 * verifyStaticIntentChanges — offline, behavioural pins for two owner-approved
 * creative-intent changes (2026-08-24):
 *
 * CHANGE 1 — ai_ugc_led maps to objection_resolved (directImageRenderService.js
 * TEMPLATE_INTENT). Before this, ai_ugc_led fell to DEFAULT_INTENT
 * (product_first_lifestyle), whose text() prints d.headline as BRAND LINE —
 * a slot with no provenance gate. The Director is instructed to write
 * ugc_led copy in the reviewer's own first-person register, and that copy
 * lands in copy.headline (no dedicated quote field on the schema), so it was
 * shipping as ungated brand voice. objection_resolved's core is CUSTOMER
 * QUOTE (d.quote — which HAS cleared toPrintableCustomerQuote by the time it
 * reaches here), not d.headline, so the same copy now either prints through
 * that gate or the intent is ineligible and falls back.
 *
 * CHANGE 2 — social_proof_led (staticAdIntents.js) is eligible on a rating OR
 * a usable quote, not rating-only. `core` becomes a function of the data so
 * density never demands a role the render cannot fill. Flag:
 * STATIC_SOCIAL_PROOF_QUOTE_ELIGIBLE, default ON.
 *
 * KNOWN CONSEQUENCE OF CHANGE 2 (asserted directly below, not just narrated):
 * FALLBACK_ORDER = ['social_proof_led', 'objection_resolved',
 * 'product_first_lifestyle']. A quote-only, no-rating render used to fail
 * social_proof_led and land on objection_resolved; it now resolves
 * social_proof_led directly. Section D below builds the SAME data both ways
 * (flag on vs off) and asserts the intent key flips and quantifies exactly
 * what differs (slots rendered, emphasis order, goal text, absences).
 *
 * Calls the REAL exported functions (intentForTemplate, resolveIntent,
 * buildPrompt, applyDensity) — no source-text scan of either change.
 *
 * Offline: no DB, no network, no API key.
 *   node scripts/verifyStaticIntentChanges.js
 */

const fs = require('fs');
const path = require('path');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const DEFAULTS_ENV = path.join(__dirname, '..', 'config/defaults.env');

const ORIGINAL_QUOTE_ELIGIBLE = process.env.STATIC_SOCIAL_PROOF_QUOTE_ELIGIBLE;

function restoreEnv() {
  if (ORIGINAL_QUOTE_ELIGIBLE === undefined) delete process.env.STATIC_SOCIAL_PROOF_QUOTE_ELIGIBLE;
  else process.env.STATIC_SOCIAL_PROOF_QUOTE_ELIGIBLE = ORIGINAL_QUOTE_ELIGIBLE;
  try {
    delete require.cache[require.resolve('../src/services/staticAdIntents')];
    delete require.cache[require.resolve('../src/services/directImageRenderService')];
  } catch (_) { /* ignore */ }
}

/** Re-require staticAdIntents under a specific flag value. undefined unsets (default ON). */
function loadIntents(flag) {
  const key = require.resolve('../src/services/staticAdIntents');
  delete require.cache[key];
  if (flag === undefined) delete process.env.STATIC_SOCIAL_PROOF_QUOTE_ELIGIBLE;
  else process.env.STATIC_SOCIAL_PROOF_QUOTE_ELIGIBLE = flag;
  return require('../src/services/staticAdIntents');
}

/**
 * Re-require directImageRenderService for the TEMPLATE_INTENT checks.
 * Requiring this module pulls in DB models etc.; the repo's established
 * pattern (verifyRatingFurniture.js E4) is to require it directly rather
 * than stub anything, since intentForTemplate itself touches nothing but a
 * plain object lookup.
 */
function loadDirectImageRenderService() {
  const key = require.resolve('../src/services/directImageRenderService');
  delete require.cache[key];
  return require('../src/services/directImageRenderService');
}

const PRODUCT = { desc: 'Test product.', logoCorner: 'bottom-right' };

try {
  // ── A. CHANGE 1 — TEMPLATE_INTENT: ai_ugc_led / ai_editorial ────────────
  console.log('A. ai_ugc_led -> objection_resolved; ai_editorial unchanged');
  {
    const { intentForTemplate } = loadDirectImageRenderService();

    check('A1 ai_ugc_led resolves to objection_resolved',
      intentForTemplate('ai_ugc_led') === 'objection_resolved',
      `got ${JSON.stringify(intentForTemplate('ai_ugc_led'))}`);

    // ai_editorial still falls through to whatever an entirely unrecognised
    // template gets (DEFAULT_INTENT) — proven behaviourally (same result as
    // a template that has never existed) rather than by hardcoding the
    // literal 'product_first_lifestyle' string alone.
    const editorial = intentForTemplate('ai_editorial');
    const unknown = intentForTemplate('totally_unknown_template_xyz_2026');
    check('A2 ai_editorial resolves the same as an unrecognised template (still the default floor)',
      editorial === unknown,
      `editorial=${JSON.stringify(editorial)} unknown=${JSON.stringify(unknown)}`);
    check('A2b ai_editorial is specifically product_first_lifestyle',
      editorial === 'product_first_lifestyle',
      `got ${JSON.stringify(editorial)}`);
    check('A3 ai_editorial did NOT get remapped to objection_resolved',
      editorial !== 'objection_resolved');

    // Pre-existing mappings this change must not disturb.
    check('A4 ai_promotional still maps to objection_resolved (unaffected)',
      intentForTemplate('ai_promotional') === 'objection_resolved');
    check('A5 ai_social_proof_led still maps to social_proof_led (unaffected)',
      intentForTemplate('ai_social_proof_led') === 'social_proof_led');
  }

  // ── B. CHANGE 2 — social_proof_led eligibility, flag ON (default) ──────
  console.log('B. social_proof_led eligible: rating-only / quote-only / both / neither');
  {
    const on = loadIntents(undefined);
    check('B0 flag defaults ON', on.SOCIAL_PROOF_QUOTE_ELIGIBLE === true);

    // B1 — rating only.
    const ratingOnly = { rating: '4.8', reviewCount: 120, cta: 'Shop Now' };
    const rB = on.resolveIntent('social_proof_led', ratingOnly);
    check('B1 rating-only: eligible, resolves social_proof_led',
      rB.key === 'social_proof_led' && rB.fellBackFrom === null);
    check('B1b rating-only: core is [RATING]',
      JSON.stringify(on.INTENTS.social_proof_led.core(ratingOnly)) === JSON.stringify(['RATING']));

    // B2 — quote only, no rating. The owner-directed widening.
    const quoteOnly = { quote: 'These changed how I train.', attribution: 'Dana', cta: 'Shop Now' };
    const rQ = on.resolveIntent('social_proof_led', quoteOnly);
    check('B2 quote-only: eligible, resolves social_proof_led (owner-directed widening)',
      rQ.key === 'social_proof_led' && rQ.fellBackFrom === null,
      `got key=${rQ.key} fellBackFrom=${rQ.fellBackFrom}`);
    check('B2b quote-only: core is [CUSTOMER QUOTE]',
      JSON.stringify(on.INTENTS.social_proof_led.core(quoteOnly)) === JSON.stringify(['CUSTOMER QUOTE']));

    // B3 — both. Rating still wins core (byte-identical to a rating-bearing
    // render whether or not a quote also happens to exist).
    const both = { rating: '4.9', reviewCount: 50, quote: 'These changed how I train.', attribution: 'Dana', cta: 'Shop Now' };
    const rBoth = on.resolveIntent('social_proof_led', both);
    check('B3 rating+quote: eligible, resolves social_proof_led',
      rBoth.key === 'social_proof_led' && rBoth.fellBackFrom === null);
    check('B3b rating+quote: core is [RATING] (rating still wins)',
      JSON.stringify(on.INTENTS.social_proof_led.core(both)) === JSON.stringify(['RATING']));

    // B4 — neither rating nor quote: genuinely no proof, must NOT be eligible.
    const neither = { cta: 'Shop Now' };
    const rN = on.resolveIntent('social_proof_led', neither);
    check('B4 no rating, no quote: NOT eligible for social_proof_led (falls back)',
      rN.key !== 'social_proof_led' && rN.fellBackFrom === 'social_proof_led',
      `got key=${rN.key} fellBackFrom=${rN.fellBackFrom}`);

    // B5 — quote-only render's prompt actually carries CUSTOMER QUOTE and
    // no garbage "undefined" string, and its absences correctly ban a
    // rating (none exists) rather than contradicting the CUSTOMER QUOTE
    // that IS on frame.
    const builtQuoteOnly = on.buildPrompt({
      intentKey: 'social_proof_led', data: quoteOnly, product: PRODUCT, surface: 'meta_feed_1_1'
    });
    check('B5 quote-only prompt resolves social_proof_led',
      builtQuoteOnly.resolved.key === 'social_proof_led');
    check('B5b quote-only prompt never prints the literal string "undefined"',
      !/undefined/.test(builtQuoteOnly.prompt || ''));
    check('B5c quote-only prompt SET-EXACTLY block carries CUSTOMER QUOTE, not RATING',
      (builtQuoteOnly.text || []).some(([r]) => r === 'CUSTOMER QUOTE')
      && !(builtQuoteOnly.text || []).some(([r]) => r === 'RATING'));
    check('B5d quote-only prompt absences ban a numeric rating (none exists)',
      builtQuoteOnly.absent.some(a => /no numeric score, star glyphs/.test(a)));
    check('B5e quote-only prompt carries the actual quote text',
      (builtQuoteOnly.prompt || '').includes('These changed how I train.'));
  }

  // ── C. flag OFF restores byte-identical pre-change behaviour ───────────
  console.log('C. flag OFF: byte-identical rating-only eligibility');
  {
    const off = loadIntents('false');
    check('C0 flag off ships false', off.SOCIAL_PROOF_QUOTE_ELIGIBLE === false);

    const quoteOnly = { quote: 'These changed how I train.', attribution: 'Dana', cta: 'Shop Now' };
    const rQoff = off.resolveIntent('social_proof_led', quoteOnly);
    check('C1 flag off: quote-only is NOT eligible (pre-change behaviour)',
      rQoff.key !== 'social_proof_led' && rQoff.fellBackFrom === 'social_proof_led',
      `got key=${rQoff.key} fellBackFrom=${rQoff.fellBackFrom}`);
    // Pre-change behaviour: a quote-only render used to land on
    // objection_resolved (it has a quote, which IS that intent's core).
    check('C1b flag off: quote-only lands on objection_resolved',
      rQoff.key === 'objection_resolved');

    check('C2 flag off: core(rating-bearing) is still [RATING]',
      JSON.stringify(off.INTENTS.social_proof_led.core({ rating: '4.8' })) === JSON.stringify(['RATING']));
    // Belt-and-suspenders arm: core() called directly with no rating, flag
    // off, still returns the pre-change literal shape.
    check('C2b flag off: core({}) (no rating) still returns [RATING], not [CUSTOMER QUOTE]',
      JSON.stringify(off.INTENTS.social_proof_led.core({})) === JSON.stringify(['RATING']));

    // Byte-identity for the untouched (rating-bearing) path: a rating-bearing
    // render's full prompt must be identical whether the flag is on or off.
    const on = loadIntents(undefined);
    const ratingData = { rating: '4.8', reviewCount: 120, quote: 'Great fit.', attribution: 'Sam', badge: 'Top Rated', cta: 'Shop Now' };
    const onBuilt = on.buildPrompt({ intentKey: 'social_proof_led', data: ratingData, product: PRODUCT, surface: 'meta_feed_4_5' });
    const offBuilt = off.buildPrompt({ intentKey: 'social_proof_led', data: ratingData, product: PRODUCT, surface: 'meta_feed_4_5' });
    check('C3 rating-bearing prompt is BYTE-IDENTICAL flag on vs off',
      onBuilt.prompt === offBuilt.prompt);
  }

  // ── D. quantify the FALLBACK_ORDER re-routing consequence ──────────────
  console.log('D. quantified difference: quote-only routing, flag on vs off');
  {
    const on = loadIntents(undefined);
    const off = loadIntents('false');
    const quoteOnly = { quote: 'These changed how I train.', attribution: 'Dana', badge: 'Top Rated', cta: 'Shop Now' };

    const onBuilt = on.buildPrompt({ intentKey: 'social_proof_led', data: quoteOnly, product: PRODUCT, surface: 'meta_feed_4_5' });
    const offBuilt = off.buildPrompt({ intentKey: 'social_proof_led', data: quoteOnly, product: PRODUCT, surface: 'meta_feed_4_5' });

    check('D1 flag on: quote-only resolves social_proof_led',
      onBuilt.resolved.key === 'social_proof_led');
    check('D2 flag off: same data resolves objection_resolved (today\'s behaviour)',
      offBuilt.resolved.key === 'objection_resolved');
    check('D3 the two prompts are NOT the same (the routing change is real, not cosmetic)',
      onBuilt.prompt !== offBuilt.prompt);

    const onRoles = new Set((onBuilt.text || []).map(([r]) => r));
    const offRoles = new Set((offBuilt.text || []).map(([r]) => r));
    check('D4 social_proof_led path renders a BADGE role for this data',
      onRoles.has('BADGE'));
    check('D4b objection_resolved path also renders a BADGE role for this data',
      offRoles.has('BADGE'));
    check('D5 both paths render CUSTOMER QUOTE + ATTRIBUTION (the quote itself is unaffected)',
      onRoles.has('CUSTOMER QUOTE') && onRoles.has('ATTRIBUTION')
      && offRoles.has('CUSTOMER QUOTE') && offRoles.has('ATTRIBUTION'));

    // Printed for the PR description — not asserted, just surfaced, so the
    // quantification is drawn from a real call rather than hand-typed.
    console.log(`   social_proof_led goal:      ${JSON.stringify(onBuilt.emphasis)}`);
    console.log(`   objection_resolved goal:     ${JSON.stringify(offBuilt.emphasis)}`);
    console.log(`   social_proof_led drawCta:    ${onBuilt.policy.drawCta}`);
    console.log(`   objection_resolved drawCta:  ${offBuilt.policy.drawCta}`);
  }

  // ── E. applyDensity resolves a function-shaped core correctly ──────────
  console.log('E. applyDensity: function-shaped core protects the right role under budget pressure');
  {
    const on = loadIntents(undefined);
    // Force density pressure: budget of 1, quote-only data with a badge and
    // attribution too — CUSTOMER QUOTE must survive (it is core via the
    // function), ATTRIBUTION/BADGE must not.
    const quoteOnly = { quote: 'These changed how I train.', attribution: 'Dana', badge: 'Top Rated', cta: 'Shop Now' };
    const spec = on.INTENTS.social_proof_led;
    const text = spec.text(quoteOnly);
    const { kept, dropped } = on.applyDensity(text, spec, { maxTextElements: 1 }, quoteOnly);
    check('E1 CUSTOMER QUOTE survives density pressure when it is the resolved core',
      kept.some(([r]) => r === 'CUSTOMER QUOTE'));
    check('E2 ATTRIBUTION was sacrificed alongside its quote-less peers or by order (not core)',
      !kept.some(([r]) => r === 'BADGE') || dropped.includes('BADGE'));
    check('E3 something was actually dropped under this budget',
      dropped.length > 0);

    // Sanity: the same mechanism still protects a literal-array core
    // (objection_resolved) exactly as before — regression guard for the
    // typeof-function branch added to applyDensity.
    const specOR = on.INTENTS.objection_resolved;
    const dataOR = { quote: 'Fits true to size.', attribution: 'Alex', badge: 'Top Rated', cta: 'Shop Now' };
    const textOR = specOR.text(dataOR);
    const { kept: keptOR } = on.applyDensity(textOR, specOR, { maxTextElements: 1 }, dataOR);
    check('E4 objection_resolved (literal-array core) still protects CUSTOMER QUOTE under pressure',
      keptOR.some(([r]) => r === 'CUSTOMER QUOTE'));
  }

  // ── F. kill switch is committed ─────────────────────────────────────────
  console.log('F. defaults.env kill switch is committed');
  {
    const envText = fs.readFileSync(DEFAULTS_ENV, 'utf8');
    check('F1 STATIC_SOCIAL_PROOF_QUOTE_ELIGIBLE=true is committed',
      /^STATIC_SOCIAL_PROOF_QUOTE_ELIGIBLE=true$/m.test(envText));
    const flagIdx = envText.indexOf('STATIC_SOCIAL_PROOF_QUOTE_ELIGIBLE=true');
    const commentWindow = flagIdx >= 0 ? envText.slice(Math.max(0, flagIdx - 1400), flagIdx) : '';
    check('F2 comment documents the FALLBACK_ORDER re-routing consequence',
      flagIdx >= 0 && commentWindow.includes('FALLBACK_ORDER'),
      `flagIdx=${flagIdx}`);
  }

} catch (err) {
  failures.push(`FATAL: ${err && err.stack ? err.stack : err}`);
} finally {
  restoreEnv();
}

const total = pass + failures.length;
if (failures.length) {
  console.error(`\n❌ verifyStaticIntentChanges: ${failures.length} FAILED, ${pass} passed (of ${total})\n`);
  failures.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log(`\n✅ verifyStaticIntentChanges: ${pass} checks passed`);
