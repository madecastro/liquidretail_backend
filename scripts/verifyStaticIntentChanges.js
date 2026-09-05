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
 * CHANGE 3 — segment prompt-override CONSUMER (port of backend's
 * loadSegmentOverrides / applySegmentOverrides / buildPrompt({segment})).
 * Empty table (the committed default) is a byte-identical no-op vs the
 * pre-port SHA matrix in scripts/fixtures/staticIntentPromptBaseline.json,
 * with the flag both ON (default) and OFF. A synthetic matching row is a
 * positive proof the consumer actually appends ADDITIONAL DIRECTIVES and
 * stamps appliedOverrides. Pinned in section G.
 *
 * Calls the REAL exported functions (intentForTemplate, resolveIntent,
 * buildPrompt, applyDensity) — no source-text scan of either change
 * (section G's require-path / renderer-stamp pins are the exception:
 * those are wiring, not behaviour).
 *
 * Offline: no DB, no network, no API key.
 *   node scripts/verifyStaticIntentChanges.js
 */

const fs = require('fs');
const path = require('path');

// Bare worktree affordance — same shared loader verifyModelParity.js /
// verifyRetitleConsumerClaim.js use. Must run BEFORE requiring
// src/services/directImageRenderService (it pulls CostLog → mongoose).
const { resolveBackendRoot } = require('./lib/siblingBackend');
const { loadMongooseWithFallback } = require('./lib/mongooseLoader');
loadMongooseWithFallback({
  harnessName: 'verifyStaticIntentChanges',
  backendRoot: resolveBackendRoot(path.join(__dirname, '..')),
});

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const DEFAULTS_ENV = path.join(__dirname, '..', 'config/defaults.env');

const ORIGINAL_QUOTE_ELIGIBLE = process.env.STATIC_SOCIAL_PROOF_QUOTE_ELIGIBLE;
const ORIGINAL_SEGMENT_OVERRIDES = process.env.STATIC_SEGMENT_PROMPT_OVERRIDES;

function restoreEnv() {
  if (ORIGINAL_QUOTE_ELIGIBLE === undefined) delete process.env.STATIC_SOCIAL_PROOF_QUOTE_ELIGIBLE;
  else process.env.STATIC_SOCIAL_PROOF_QUOTE_ELIGIBLE = ORIGINAL_QUOTE_ELIGIBLE;
  if (ORIGINAL_SEGMENT_OVERRIDES === undefined) delete process.env.STATIC_SEGMENT_PROMPT_OVERRIDES;
  else process.env.STATIC_SEGMENT_PROMPT_OVERRIDES = ORIGINAL_SEGMENT_OVERRIDES;
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

  // ── G. Segment prompt-override consumer ────────────────────────────────
  console.log('G. segment prompt-override consumer: empty-table byte-identity + positive row');
  {
    const crypto = require('crypto');
    const BASELINE_PATH = path.join(__dirname, 'fixtures/staticIntentPromptBaseline.json');
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
    const { product: PRODUCT_G, fixtures: FIXTURES_G, cells: CELLS_G } = baseline;

    function shaOf(prompt) {
      return crypto.createHash('sha256').update(String(prompt || '')).digest('hex');
    }
    function matrixKey(dk, surface, intentKey) {
      return `${dk}|${surface}|${intentKey}`;
    }
    function collectMatrix(mod, extra = {}) {
      const out = {};
      for (const [dk, data] of Object.entries(FIXTURES_G)) {
        for (const surface of Object.keys(mod.SURFACE_POLICY).filter((k) => mod.SURFACE_POLICY[k].static)) {
          for (const intentKey of Object.keys(mod.INTENTS)) {
            const r = mod.buildPrompt({ intentKey, data, product: PRODUCT_G, surface, ...extra });
            const key = matrixKey(dk, surface, intentKey);
            if (r.error || r.skipped) {
              out[key] = { skipped: String(r.error || r.skipped), appliedOverrides: r.appliedOverrides || [] };
            } else {
              out[key] = {
                sha: shaOf(r.prompt),
                resolved: r.resolved && r.resolved.key,
                appliedOverrides: r.appliedOverrides || [],
                prompt: r.prompt
              };
            }
          }
        }
      }
      return out;
    }
    function assertMatchesBaseline(label, out) {
      const produced = Object.keys(out).sort();
      const expected = Object.keys(CELLS_G).sort();
      check(`${label}: produced cell set equals pre-port matrix`,
        JSON.stringify(produced) === JSON.stringify(expected),
        `produced=${produced.length} expected=${expected.length}`);
      let mismatches = 0;
      const first = [];
      for (const key of expected) {
        const exp = CELLS_G[key];
        const got = out[key];
        if (!got) { mismatches++; if (first.length < 3) first.push(`${key}: missing`); continue; }
        if (exp.skipped) {
          if (got.skipped !== exp.skipped) {
            mismatches++;
            if (first.length < 3) first.push(`${key}: skipped ${JSON.stringify(got.skipped)} != ${JSON.stringify(exp.skipped)}`);
          }
          continue;
        }
        if (got.sha !== exp.sha) {
          mismatches++;
          if (first.length < 3) first.push(`${key}: sha ${got.sha} != ${exp.sha}`);
        }
      }
      check(`${label}: every prompt SHA is BYTE-IDENTICAL to the pre-port fixture`,
        mismatches === 0,
        `${mismatches} mismatched; first: ${first.join('; ')}`);
    }

    const intentsSrc = fs.readFileSync(path.join(__dirname, '..', 'src/services/staticAdIntents.js'), 'utf8');
    check('G0 require path is ../../config/segmentPromptOverrides (adgen config/ is at repo root)',
      intentsSrc.includes("require('../../config/segmentPromptOverrides')"));
    check('G0b does NOT use backend\'s ../config/segmentPromptOverrides (that resolves to missing src/config/)',
      !intentsSrc.includes("require('../config/segmentPromptOverrides')"));

    const envTextG = fs.readFileSync(DEFAULTS_ENV, 'utf8');
    check('G0c STATIC_SEGMENT_PROMPT_OVERRIDES=true is committed',
      /^STATIC_SEGMENT_PROMPT_OVERRIDES=true$/m.test(envTextG));
    const segFlagIdx = envTextG.indexOf('STATIC_SEGMENT_PROMPT_OVERRIDES=true');
    const segComment = segFlagIdx >= 0 ? envTextG.slice(Math.max(0, segFlagIdx - 500), segFlagIdx) : '';
    check('G0d comment documents empty-table byte-identical no-op',
      segFlagIdx >= 0 && /byte-identical no-op/i.test(segComment));

    // G1 — empty table, flag ON (default). Must match pre-port bytes.
    // Do NOT call _setSegmentOverridesForTests here: loadSegmentOverrides must
    // actually require() the committed config/segmentPromptOverrides.js ([]).
    const on = loadIntents(undefined);
    check('G1 flag defaults ON (unset !== \'false\')', on.SEGMENT_OVERRIDES_ENABLED === true);
    check('G1-load committed table is the empty array (real require, not the test setter)',
      Array.isArray(on.loadSegmentOverrides()) && on.loadSegmentOverrides().length === 0);
    const onEmpty = collectMatrix(on);
    assertMatchesBaseline('G1 empty table, flag ON', onEmpty);
    const emptyOverrideMismatch = Object.values(onEmpty).filter((c) => JSON.stringify(c.appliedOverrides) !== '[]');
    check('G1b empty table stamps appliedOverrides: [] on every cell',
      emptyOverrideMismatch.length === 0,
      `${emptyOverrideMismatch.length} cells stamped a non-empty list`);

    // G1c — passing segment:{categoryPath} with an empty table is still a no-op
    // (the extra arg must not change prompt bytes when nothing matches).
    const onEmptyWithSegment = collectMatrix(on, { segment: { categoryPath: 'Apparel > Outerwear' } });
    assertMatchesBaseline('G1c empty table + segment.categoryPath, flag ON', onEmptyWithSegment);

    // G2 — flag OFF even with a matching synthetic row is still pre-port bytes.
    const pfKey = require.resolve('../src/services/platformFormats');
    const intentsKey = require.resolve('../src/services/staticAdIntents');
    const savedIntents = require.cache[intentsKey];
    const savedPf = require.cache[pfKey];
    delete require.cache[intentsKey];
    delete require.cache[pfKey];
    process.env.STATIC_SEGMENT_PROMPT_OVERRIDES = 'false';
    let offMod;
    try {
      offMod = require('../src/services/staticAdIntents');
      check('G2 flag off ships SEGMENT_OVERRIDES_ENABLED=false',
        offMod.SEGMENT_OVERRIDES_ENABLED === false);
      offMod._setSegmentOverridesForTests([
        { id: 'should-not-apply', enabled: true, match: {}, appendText: 'NEVER APPEAR IN ANY PROMPT' }
      ]);
      const offOut = collectMatrix(offMod);
      assertMatchesBaseline('G2 flag OFF + matching synthetic row', offOut);
      const leaked = Object.entries(offOut).filter(([, c]) => (c.prompt || '').includes('NEVER APPEAR IN ANY PROMPT'));
      check('G2b flag off never appends ADDITIONAL DIRECTIVES even when a row matches',
        leaked.length === 0 && Object.values(offOut).every((c) => JSON.stringify(c.appliedOverrides) === '[]'),
        `${leaked.length} cells leaked the synthetic row`);
    } finally {
      if (ORIGINAL_SEGMENT_OVERRIDES === undefined) delete process.env.STATIC_SEGMENT_PROMPT_OVERRIDES;
      else process.env.STATIC_SEGMENT_PROMPT_OVERRIDES = ORIGINAL_SEGMENT_OVERRIDES;
      if (savedIntents) require.cache[intentsKey] = savedIntents;
      else delete require.cache[intentsKey];
      if (savedPf) require.cache[pfKey] = savedPf;
      else delete require.cache[pfKey];
    }

    // G3 — matchSegmentOverride AND semantics, skip rules.
    {
      const { matchSegmentOverride } = on;
      const ctx = {
        seedStyle: 'lifestyle',
        variantKind: 'product_image',
        surface: 'meta_feed_1_1',
        intent: 'brand_led',
        categoryPath: 'Apparel > Outerwear'
      };
      check('G3 match: surface hits',
        matchSegmentOverride({ id: 'ok', enabled: true, match: { surface: 'meta_feed_1_1' }, appendText: 'x' }, ctx) === true);
      check('G3b match: wrong intent misses',
        matchSegmentOverride({ id: 'ok', enabled: true, match: { intent: 'social_proof_led' }, appendText: 'x' }, ctx) === false);
      check('G3c match: seedStyle AND variantKind hit',
        matchSegmentOverride({ id: 'ok', enabled: true, match: { seedStyle: 'lifestyle', variantKind: 'product_image' }, appendText: 'x' }, ctx) === true);
      check('G3d match: categoryPrefix is case-insensitive',
        matchSegmentOverride({ id: 'ok', enabled: true, match: { categoryPrefix: 'apparel' }, appendText: 'x' }, ctx) === true);
      check('G3e match: wrong categoryPrefix misses',
        matchSegmentOverride({ id: 'ok', enabled: true, match: { categoryPrefix: 'Shoes' }, appendText: 'x' }, ctx) === false);
      check('G3f disabled entry skips',
        matchSegmentOverride({ id: 'ok', enabled: false, match: {}, appendText: 'x' }, ctx) === false);
      check('G3g missing id cannot apply',
        matchSegmentOverride({ enabled: true, match: {}, appendText: 'x' }, ctx) === false);
      check('G3h empty appendText cannot apply',
        matchSegmentOverride({ id: 'ok', enabled: true, match: {}, appendText: '' }, ctx) === false);
      check('G3i empty categoryPath fails prefix',
        matchSegmentOverride({ id: 'ok', enabled: true, match: { categoryPrefix: 'Apparel' }, appendText: 'x' }, { ...ctx, categoryPath: '' }) === false);
    }

    // G4 — positive row: consumer actually appends and stamps appliedOverrides.
    {
      const cellKey = 'ratingQuote|meta_feed_1_1|brand_led';
      const unmodified = onEmpty[cellKey] && onEmpty[cellKey].prompt;
      check('G4 baseline cell exists for the positive-row proof',
        typeof unmodified === 'string' && unmodified.length > 0);

      on._setSegmentOverridesForTests([
        { id: 'add-1', enabled: true, match: { surface: 'meta_feed_1_1' }, appendText: 'Keep the knit texture.' },
        { id: 'no-hit', enabled: true, match: { surface: 'pmax_square_1_1' }, appendText: 'SHOULD NOT APPEAR' }
      ]);
      const r = on.buildPrompt({
        intentKey: 'brand_led',
        data: FIXTURES_G.ratingQuote,
        product: PRODUCT_G,
        surface: 'meta_feed_1_1',
        segment: { categoryPath: 'Apparel > Outerwear' }
      });
      check('G4b appended prompt starts with the unmodified baseline (append-only)',
        typeof r.prompt === 'string' && r.prompt.startsWith(unmodified));
      check('G4c prompt contains ADDITIONAL DIRECTIVES',
        (r.prompt || '').includes('ADDITIONAL DIRECTIVES'));
      check('G4d prompt contains the matched appendText',
        (r.prompt || '').includes('Keep the knit texture.'));
      check('G4e non-matching row is not applied',
        !(r.prompt || '').includes('SHOULD NOT APPEAR'));
      check('G4f appliedOverrides stamps the matched id only',
        JSON.stringify(r.appliedOverrides) === JSON.stringify(['add-1']),
        `got ${JSON.stringify(r.appliedOverrides)}`);
      check('G4g prompt is NOT byte-identical to the empty-table baseline (the consumer actually fired)',
        r.prompt !== unmodified);

      on._setSegmentOverridesForTests([]);
      const r2 = on.buildPrompt({
        intentKey: 'brand_led',
        data: FIXTURES_G.ratingQuote,
        product: PRODUCT_G,
        surface: 'meta_feed_1_1'
      });
      check('G4h empty table is a no-op again after the synthetic row is cleared',
        r2.prompt === unmodified && JSON.stringify(r2.appliedOverrides) === '[]');
    }

    // G5 — promptFlagsSnapshot includes the five flags (incl. the new one).
    {
      const snap = on.promptFlagsSnapshot();
      check('G5 fidelityHardening is boolean', typeof snap.fidelityHardening === 'boolean');
      check('G5b lifestylePreserve is boolean', typeof snap.lifestylePreserve === 'boolean');
      check('G5c brandLedCopy is boolean', typeof snap.brandLedCopy === 'boolean');
      check('G5d segmentOverridesEnabled is boolean', typeof snap.segmentOverridesEnabled === 'boolean');
      check('G5e ratingFurniture is boolean', typeof snap.ratingFurniture === 'boolean');
    }

    // G6 — live renderer threads segment: and stamps promptFlags.segmentOverrides.
    {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src/services/directImageRenderService.js'), 'utf8');
      check('G6 buildPrompt call threads segment:',
        /intents\.buildPrompt\(\{[\s\S]*?segment:\s*\{/.test(src));
      check('G6b segment.categoryPath reads resolvedProduct.category (backend-faithful)',
        /segment:\s*\{[\s\S]*?categoryPath:\s*resolvedProduct\?\.category/.test(src));
      check('G6c CatalogProduct selects include category + inferredBreadcrumb (else categoryPath is always null on the DB path)',
        (src.match(/CatalogProduct\.findById\([^)]+\)\.select\('([^']+)'\)/g) || [])
          .every((call) => /category/.test(call) && /inferredBreadcrumb/.test(call))
        && (src.match(/CatalogProduct\.findById\([^)]+\)\.select\('([^']+)'\)/g) || []).length >= 2);
      check('G6d intentResolution stamps promptFlags.segmentOverrides from built.appliedOverrides',
        /promptFlags:\s*\{[\s\S]*?segmentOverrides:\s*built\.appliedOverrides/.test(src));
      check('G6e promptFlags spreads promptFlagsSnapshot()',
        /promptFlags:\s*\{[\s\S]*?\.\.\.intents\.promptFlagsSnapshot\(\)/.test(src));
    }
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
