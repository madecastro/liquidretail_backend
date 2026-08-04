#!/usr/bin/env node
/**
 * Offline harness for brand-led copy cascades + STATIC_BRAND_LED_COPY kill switch.
 * No DB, no network, no API key.
 *
 * Requires both `services/staticAdIntents` and `services/directImageRenderService`
 * under a cleared require cache so both arms of the kill switch can be exercised
 * in one process. CRITICAL: invalidate BOTH modules — `BRAND_LED_COPY` is defined
 * in staticAdIntents and destructured by directImageRenderService at module load.
 * Invalidating only one leaves the stale arm in place and the test silently
 * passes against the wrong build.
 *
 * Flag semantics (mirrors STATIC_PROMPT_FIDELITY_HARDENING):
 *   unset / anything other than exact 'false' → ON (cascades + ai_brand_led map)
 *   'false' → OFF (Director-only headline; subhead always undefined; ai_brand_led
 *             unmapped → DEFAULT_INTENT product_first_lifestyle)
 *
 * Why this harness exists:
 *
 *   B1  Flag-on maps ai_brand_led → brand_led; ai_ugc_led stays out of scope.
 *   B2  Headline cascade: director → layoutInput.copy.headline → brand.tagline.
 *   B3  Subhead cascade: director → layoutInput.copy.subheadline.
 *   B4  Whitespace-only tiers are ABSENT; product name is never a cascade source.
 *   B5  Dedupe (case-insensitive, trimmed): matching subhead is dropped; headline wins.
 *   B6  Flag-off is a COMPLETE revert of map + cascades + subhead (not partial).
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
 * Re-require directImageRenderService (+ staticAdIntents) under a specific
 * kill-switch value. `undefined` unsets the env var (default-ON path).
 * Invalidates BOTH module cache entries — see header.
 */
function loadServices(flag) {
  const intentsKey = require.resolve('../services/staticAdIntents');
  const dirKey = require.resolve('../services/directImageRenderService');
  delete require.cache[intentsKey];
  delete require.cache[dirKey];
  if (flag === undefined) delete process.env.STATIC_BRAND_LED_COPY;
  else process.env.STATIC_BRAND_LED_COPY = flag;
  // Require direct first so it re-requires a fresh staticAdIntents and
  // destructures the live BRAND_LED_COPY into TEMPLATE_INTENT / buildIntentData.
  const dir = require('../services/directImageRenderService');
  const intents = require('../services/staticAdIntents');
  return {
    intentForTemplate: dir.intentForTemplate,
    buildIntentData: dir.buildIntentData,
    BRAND_LED_COPY: intents.BRAND_LED_COPY
  };
}

function restoreEnv() {
  if (ORIGINAL_FLAG === undefined) delete process.env.STATIC_BRAND_LED_COPY;
  else process.env.STATIC_BRAND_LED_COPY = ORIGINAL_FLAG;
  // Drop cached modules so a subsequent require in the same process sees
  // the restored env (not required for exit, but keeps the harness tidy).
  try {
    delete require.cache[require.resolve('../services/staticAdIntents')];
    delete require.cache[require.resolve('../services/directImageRenderService')];
  } catch (_) { /* ignore */ }
}

// ── Sanity: loadServices actually flips the const ───────────────────────
{
  let on, off;
  try {
    on = loadServices(undefined);
    off = loadServices('false');
  } catch (err) {
    console.error('FATAL: require(directImageRenderService) failed — not stubbing.');
    console.error(err && err.stack ? err.stack : err);
    restoreEnv();
    process.exit(2);
  }
  check('loadServices: unset ships BRAND_LED_COPY true', on.BRAND_LED_COPY === true);
  check('loadServices: "false" ships BRAND_LED_COPY false', off.BRAND_LED_COPY === false);
  check('loadServices: on and off BRAND_LED_COPY differ', on.BRAND_LED_COPY !== off.BRAND_LED_COPY);
}

// ── FLAG ON ─────────────────────────────────────────────────────────────
{
  let mod;
  try {
    mod = loadServices(undefined);
  } catch (err) {
    console.error('FATAL: require(directImageRenderService) failed on flag-on arm.');
    console.error(err && err.stack ? err.stack : err);
    restoreEnv();
    process.exit(2);
  }

  check('ON: BRAND_LED_COPY is true', mod.BRAND_LED_COPY === true);
  check("ON: intentForTemplate('ai_brand_led') === 'brand_led'",
    mod.intentForTemplate('ai_brand_led') === 'brand_led');
  check("ON: intentForTemplate('ai_ugc_led') === 'product_first_lifestyle' (out of scope)",
    mod.intentForTemplate('ai_ugc_led') === 'product_first_lifestyle');

  // Headline cascade
  {
    const d = mod.buildIntentData({
      concept: { copy: { headline: 'Director line' } },
      layoutInput: { copy: { headline: 'Layout line' } },
      brand: { tagline: 'Tagline here' },
      cta: 'SHOP NOW'
    });
    check('ON headline tier 1: director wins', d.headline === 'Director line',
      `got ${JSON.stringify(d.headline)}`);
  }
  {
    const d = mod.buildIntentData({
      concept: { copy: { headline: null } },
      layoutInput: { copy: { headline: 'Layout line' } },
      brand: { tagline: 'Tagline here' },
      cta: 'SHOP NOW'
    });
    check('ON headline tier 2: layout when director null', d.headline === 'Layout line',
      `got ${JSON.stringify(d.headline)}`);
  }
  {
    const d = mod.buildIntentData({
      concept: { copy: { headline: null } },
      layoutInput: { copy: { headline: null } },
      brand: { tagline: 'Tagline here' },
      cta: 'SHOP NOW'
    });
    check('ON headline tier 3: brand.tagline', d.headline === 'Tagline here',
      `got ${JSON.stringify(d.headline)}`);
  }
  {
    const d = mod.buildIntentData({
      concept: { copy: {} },
      layoutInput: { copy: {} },
      brand: {},
      cta: 'SHOP NOW'
    });
    check('ON headline: no source → undefined', d.headline === undefined,
      `got ${JSON.stringify(d.headline)}`);
  }

  // Subhead cascade
  {
    const d = mod.buildIntentData({
      concept: { copy: { headline: 'H', subheadline: 'Director sub' } },
      layoutInput: { copy: { subheadline: 'Layout sub' } },
      brand: {},
      cta: 'SHOP NOW'
    });
    check('ON subhead tier 1: concept.subheadline', d.subhead === 'Director sub',
      `got ${JSON.stringify(d.subhead)}`);
  }
  {
    const d = mod.buildIntentData({
      concept: { copy: { headline: 'H' } },
      layoutInput: { copy: { subheadline: 'Layout sub' } },
      brand: {},
      cta: 'SHOP NOW'
    });
    check('ON subhead tier 2: layoutInput.copy.subheadline', d.subhead === 'Layout sub',
      `got ${JSON.stringify(d.subhead)}`);
  }

  // Whitespace-only headline is ABSENT (falls to next tier)
  {
    const d = mod.buildIntentData({
      concept: { copy: { headline: '   ' } },
      layoutInput: { copy: { headline: 'Layout line' } },
      brand: { tagline: 'Tagline here' },
      cta: 'SHOP NOW'
    });
    check('ON whitespace-only director headline treated as absent → layout',
      d.headline === 'Layout line', `got ${JSON.stringify(d.headline)}`);
  }

  // Dedupe: headline wins; matching subhead dropped (case/whitespace insensitive)
  {
    const d = mod.buildIntentData({
      concept: { copy: {} },
      layoutInput: { copy: { subheadline: 'Tagline here' } },
      brand: { tagline: 'Tagline here' },
      cta: 'SHOP NOW'
    });
    check('ON dedupe: matching subhead dropped', d.subhead === undefined,
      `got subhead=${JSON.stringify(d.subhead)} headline=${JSON.stringify(d.headline)}`);
    check('ON dedupe: headline from tagline survives', d.headline === 'Tagline here',
      `got ${JSON.stringify(d.headline)}`);
  }
  {
    const d = mod.buildIntentData({
      concept: { copy: {} },
      layoutInput: { copy: { subheadline: '  TAGLINE HERE ' } },
      brand: { tagline: 'Tagline here' },
      cta: 'SHOP NOW'
    });
    check('ON dedupe: case/whitespace-insensitive match drops subhead',
      d.subhead === undefined,
      `got subhead=${JSON.stringify(d.subhead)} headline=${JSON.stringify(d.headline)}`);
    check('ON dedupe case: headline still Tagline here', d.headline === 'Tagline here',
      `got ${JSON.stringify(d.headline)}`);
  }
  {
    const d = mod.buildIntentData({
      concept: { copy: { headline: 'Brand line' } },
      layoutInput: { copy: { subheadline: 'Supporting line' } },
      brand: {},
      cta: 'SHOP NOW'
    });
    check('ON not deduped when genuinely different — headline',
      d.headline === 'Brand line', `got ${JSON.stringify(d.headline)}`);
    check('ON not deduped when genuinely different — subhead',
      d.subhead === 'Supporting line', `got ${JSON.stringify(d.subhead)}`);
  }

  // Product name is never a cascade source
  {
    const d = mod.buildIntentData({
      concept: { copy: {} },
      layoutInput: {
        copy: {},
        product: { name: 'Some Product' }
      },
      brand: {},
      cta: 'SHOP NOW'
    });
    check('ON product name never becomes headline', d.headline === undefined,
      `got ${JSON.stringify(d.headline)}`);
    check('ON product name never becomes subhead', d.subhead === undefined,
      `got ${JSON.stringify(d.subhead)}`);
  }
}

// ── FLAG OFF ────────────────────────────────────────────────────────────
{
  let mod;
  try {
    mod = loadServices('false');
  } catch (err) {
    console.error('FATAL: require(directImageRenderService) failed on flag-off arm.');
    console.error(err && err.stack ? err.stack : err);
    restoreEnv();
    process.exit(2);
  }

  check('OFF: BRAND_LED_COPY is false', mod.BRAND_LED_COPY === false);
  check("OFF: intentForTemplate('ai_brand_led') === 'product_first_lifestyle'",
    mod.intentForTemplate('ai_brand_led') === 'product_first_lifestyle',
    `got ${JSON.stringify(mod.intentForTemplate('ai_brand_led'))}`);

  // Headline is Director-only — tier-2 / tier-3 yield undefined
  {
    const d = mod.buildIntentData({
      concept: { copy: { headline: null } },
      layoutInput: { copy: { headline: 'Layout line' } },
      brand: { tagline: 'Tagline here' },
      cta: 'SHOP NOW'
    });
    check('OFF headline tier-2 inputs → undefined (no layout cascade)',
      d.headline === undefined, `got ${JSON.stringify(d.headline)}`);
  }
  {
    const d = mod.buildIntentData({
      concept: { copy: {} },
      layoutInput: { copy: {} },
      brand: { tagline: 'Tagline here' },
      cta: 'SHOP NOW'
    });
    check('OFF headline tier-3 inputs → undefined (no tagline cascade)',
      d.headline === undefined, `got ${JSON.stringify(d.headline)}`);
  }
  {
    // Director-only still works when present
    const d = mod.buildIntentData({
      concept: { copy: { headline: 'Director only' } },
      layoutInput: { copy: { headline: 'Layout line' } },
      brand: { tagline: 'Tagline here' },
      cta: 'SHOP NOW'
    });
    check('OFF director headline still used when present',
      d.headline === 'Director only', `got ${JSON.stringify(d.headline)}`);
  }

  // subhead ALWAYS undefined, including when concept.copy.subheadline is set
  {
    const d = mod.buildIntentData({
      concept: { copy: { headline: 'H', subheadline: 'Director sub' } },
      layoutInput: { copy: { subheadline: 'Layout sub' } },
      brand: {},
      cta: 'SHOP NOW'
    });
    check('OFF subhead always undefined even when concept.subheadline set',
      d.subhead === undefined, `got ${JSON.stringify(d.subhead)}`);
  }

  // Dedupe case under flag-off: no cascade → both undefined
  {
    const d = mod.buildIntentData({
      concept: { copy: {} },
      layoutInput: { copy: { subheadline: 'Tagline here' } },
      brand: { tagline: 'Tagline here' },
      cta: 'SHOP NOW'
    });
    check('OFF dedupe case: headline undefined', d.headline === undefined,
      `got ${JSON.stringify(d.headline)}`);
    check('OFF dedupe case: subhead undefined', d.subhead === undefined,
      `got ${JSON.stringify(d.subhead)}`);
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
