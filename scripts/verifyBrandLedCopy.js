#!/usr/bin/env node
/**
 * Offline harness for brand-led copy + STATIC_BRAND_LED_COPY kill switch.
 * No DB, no network, no API key.
 *
 * Why this harness exists:
 *
 *   B1  Flag-on ships BRAND_LED_COPY true; exact 'false' ships false.
 *   B2  INTENTS.brand_led is the live intent: BRAND LINE core, quote off,
 *       subhead on, rating as a scoped TRUST MARK — reachable only as an
 *       explicit request (not in FALLBACK_ORDER).
 *   B3  buildPrompt consumes already-cascaded headline/subhead as BRAND LINE
 *       / SUBHEAD roles. Product name is never a copy source on this intent.
 *   B4  Flag-off still leaves INTENTS.brand_led itself intact (the flag
 *       only gated the deleted TEMPLATE_INTENT map + copy cascade).
 *
 * REMOVED (dormant render fallback deletion): every check that drove
 * `intentForTemplate` / `buildIntentData` on
 * `services/directImageRenderService.js` — the mint-time static-ad render
 * entry point's template map (`ai_brand_led` → `brand_led`) and the
 * director → layoutInput.copy → brand.tagline headline/subhead cascade.
 * Those functions were deleted with `renderDirectImage`; adgen owns static
 * rendering unconditionally now. Surviving coverage is the live
 * `services/staticAdIntents.js` surface (flag, INTENTS.brand_led, buildPrompt).
 *
 * Run: node scripts/verifyBrandLedCopy.js
 */
'use strict';

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const ORIGINAL_FLAG = process.env.STATIC_BRAND_LED_COPY;

/**
 * Re-require staticAdIntents under a specific kill-switch value.
 * `undefined` unsets the env var (default-ON path).
 */
function loadIntents(flag) {
  const intentsKey = require.resolve('../services/staticAdIntents');
  delete require.cache[intentsKey];
  if (flag === undefined) delete process.env.STATIC_BRAND_LED_COPY;
  else process.env.STATIC_BRAND_LED_COPY = flag;
  return require('../services/staticAdIntents');
}

function restoreEnv() {
  if (ORIGINAL_FLAG === undefined) delete process.env.STATIC_BRAND_LED_COPY;
  else process.env.STATIC_BRAND_LED_COPY = ORIGINAL_FLAG;
  try {
    delete require.cache[require.resolve('../services/staticAdIntents')];
  } catch (_) { /* ignore */ }
}

const PRODUCT = {
  desc: 'organic cotton tee',
  look: null,
  logoCorner: 'bottom-right'
};

// ── Sanity: loadIntents actually flips the const ────────────────────────
{
  let on, off;
  try {
    on = loadIntents(undefined);
    off = loadIntents('false');
  } catch (err) {
    console.error('FATAL: require(staticAdIntents) failed — not stubbing.');
    console.error(err && err.stack ? err.stack : err);
    restoreEnv();
    process.exit(2);
  }
  check('loadIntents: unset ships BRAND_LED_COPY true', on.BRAND_LED_COPY === true);
  check('loadIntents: "false" ships BRAND_LED_COPY false', off.BRAND_LED_COPY === false);
  check('loadIntents: on and off BRAND_LED_COPY differ', on.BRAND_LED_COPY !== off.BRAND_LED_COPY);
}

// ── FLAG ON ─────────────────────────────────────────────────────────────
{
  let mod;
  try {
    mod = loadIntents(undefined);
  } catch (err) {
    console.error('FATAL: require(staticAdIntents) failed on flag-on arm.');
    console.error(err && err.stack ? err.stack : err);
    restoreEnv();
    process.exit(2);
  }

  check('ON: BRAND_LED_COPY is true', mod.BRAND_LED_COPY === true);
  check('ON: INTENTS.brand_led exists', !!(mod.INTENTS && mod.INTENTS.brand_led));
  check('ON: brand_led.core is [BRAND LINE]',
    JSON.stringify(mod.INTENTS.brand_led.core) === JSON.stringify(['BRAND LINE']));
  check('ON: brand_led rendersQuote is false (rating trust mark only)',
    mod.INTENTS.brand_led.renders.rendersQuote === false);
  check('ON: brand_led rendersSubhead is true',
    mod.INTENTS.brand_led.renders.rendersSubhead === true);
  check('ON: brand_led rendersRating is true',
    mod.INTENTS.brand_led.renders.rendersRating === true);
  check('ON: brand_led is NOT in FALLBACK_ORDER (explicit request only)',
    !mod.FALLBACK_ORDER.includes('brand_led'));
  check('ON: brand_led.eligible refuses a missing headline',
    typeof mod.INTENTS.brand_led.eligible({ cta: 'SHOP NOW' }) === 'string');
  check('ON: brand_led.eligible accepts a headline',
    mod.INTENTS.brand_led.eligible({ headline: 'Brand line', cta: 'SHOP NOW' }) === null);

  {
    const built = mod.buildPrompt({
      intentKey: 'brand_led',
      data: { headline: 'Director line', subhead: 'Director sub', cta: 'SHOP NOW' },
      product: PRODUCT,
      surface: 'meta_feed_1_1'
    });
    check('ON buildPrompt: brand_led resolves without fallback',
      built.resolved && built.resolved.key === 'brand_led',
      `got ${JSON.stringify(built.resolved && built.resolved.key)}`);
    const roles = (built.text || []).map((row) => row[0]);
    const byRole = Object.fromEntries(built.text || []);
    check('ON buildPrompt: BRAND LINE is the headline',
      byRole['BRAND LINE'] === 'Director line',
      `got ${JSON.stringify(byRole['BRAND LINE'])}`);
    check('ON buildPrompt: SUBHEAD is the subhead',
      byRole.SUBHEAD === 'Director sub',
      `got ${JSON.stringify(byRole.SUBHEAD)}`);
    check('ON buildPrompt: no CUSTOMER QUOTE role (rendersQuote false)',
      !roles.includes('CUSTOMER QUOTE'));
    check('ON buildPrompt: prompt still carries the brand line',
      !!(built.prompt && built.prompt.includes('Director line')));
  }

  {
    const built = mod.buildPrompt({
      intentKey: 'brand_led',
      data: { headline: 'Brand line', cta: 'SHOP NOW' },
      product: PRODUCT,
      surface: 'meta_feed_1_1'
    });
    const roles = (built.text || []).map((row) => row[0]);
    check('ON buildPrompt: absent subhead does not mint a SUBHEAD role',
      !roles.includes('SUBHEAD'));
  }

  {
    const resolved = mod.resolveIntent('brand_led', { cta: 'SHOP NOW' });
    check('ON no headline: brand_led is not delivered (eligible fails closed)',
      resolved.key !== 'brand_led',
      `got ${JSON.stringify(resolved.key)}`);
  }

  {
    const built = mod.buildPrompt({
      intentKey: 'brand_led',
      data: { headline: 'Brand line', cta: 'SHOP NOW' },
      product: { ...PRODUCT, name: 'Some Product' },
      surface: 'meta_feed_1_1'
    });
    const values = (built.text || []).map((row) => row[1]);
    check('ON product name never becomes a copy role',
      !values.includes('Some Product'),
      `got ${JSON.stringify(values)}`);
  }
}

// ── FLAG OFF ────────────────────────────────────────────────────────────
{
  let mod;
  try {
    mod = loadIntents('false');
  } catch (err) {
    console.error('FATAL: require(staticAdIntents) failed on flag-off arm.');
    console.error(err && err.stack ? err.stack : err);
    restoreEnv();
    process.exit(2);
  }

  check('OFF: BRAND_LED_COPY is false', mod.BRAND_LED_COPY === false);
  // The deleted TEMPLATE_INTENT map is what the flag used to revert; the
  // intent spec itself stays so an explicit brand_led request still works.
  check('OFF: INTENTS.brand_led still exists (flag does not delete the intent)',
    !!(mod.INTENTS && mod.INTENTS.brand_led));
  check('OFF: brand_led.core is still [BRAND LINE]',
    JSON.stringify(mod.INTENTS.brand_led.core) === JSON.stringify(['BRAND LINE']));
  {
    const built = mod.buildPrompt({
      intentKey: 'brand_led',
      data: { headline: 'Director only', subhead: 'Director sub', cta: 'SHOP NOW' },
      product: PRODUCT,
      surface: 'meta_feed_1_1'
    });
    check('OFF director headline still used when present',
      built.resolved && built.resolved.key === 'brand_led'
      && Object.fromEntries(built.text || [])['BRAND LINE'] === 'Director only',
      `got ${JSON.stringify(built.resolved && built.resolved.key)}`);
  }
}

restoreEnv();

const total = pass + failures.length;
const fail = failures.length;
console.log(`\n${fail === 0 ? '✅' : '❌'} verifyBrandLedCopy: ${pass}/${total} checks passed\n`);
if (fail) {
  console.log('FAILURES:');
  failures.forEach((f) => console.log('  ✗ ' + f));
}
process.exit(fail === 0 ? 0 : 1);
