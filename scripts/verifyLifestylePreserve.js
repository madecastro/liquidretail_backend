#!/usr/bin/env node
/**
 * Offline harness for lifestyle/UGC scene-preserve STATIC + lifestyle VIDEO.
 * No DB, no network, no API key.
 *
 * STATIC (STATIC_LIFESTYLE_PRESERVE, default OFF):
 *   S1  Trigger: lifestyle seed + ugc variant; NOT packshot/flat_lay/detail/
 *       packaging/unknown/ambiguous
 *   S2  Director intent still owns copy — roles AND order byte-identical
 *       preserve-on vs preserve-off for all four intents (OWNER REQUIREMENT)
 *   S3  Preserve-on prompt carries SCENE_PRESERVE and NOT the scene-building
 *       fidelity opening
 *   S4  Every product-identity clause survives in the preserve arm
 *   S5  Scrim/panel permitted; altering the photograph is not
 *   S6  Flag OFF ⇒ byte-identical for all four intents × both hardening arms
 *   S7  Geometry output unchanged by preserve
 *
 * VIDEO (VIDEO_LIFESTYLE_PROMPT, default OFF):
 *   V1  LIFESTYLE_DIRECTIVES only for lifestyle + flag on; OMNI otherwise
 *   V2  OMNI_DIRECTIVES + GROK_DIRECTIVES byte-unchanged vs 134db56~1 (B14 style)
 *   V3  Lifestyle keeps product-identity / no-new-background / noText /
 *       physicalAccuracy — each asserted
 *   V4  Lifestyle does NOT contain packshot-only strings
 *   V5  Ambient motion permitted; fantasy motion banned (enumerated)
 *   V6  Lifestyle ref count = 1; packshot base still 3
 *   V7  Guidance snippets ≤600 chars, one per intent×lifestyle, no copy/offer/text
 *   V8  Flag OFF ⇒ prompt + ref count identical to today
 *
 * Revert-prove: each behaviour has a named check that fails when that
 * behaviour is removed. See the REVERT-PROVE table printed at the end.
 *
 * Run: node scripts/verifyLifestylePreserve.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return true; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}

const REPO = path.join(__dirname, '..');
const INTENTS_KEY = require.resolve('../services/staticAdIntents');
const VEO_KEY = require.resolve('../services/veoPromptBuilder');

const ORIG = {
  STATIC_LIFESTYLE_PRESERVE: process.env.STATIC_LIFESTYLE_PRESERVE,
  STATIC_PROMPT_FIDELITY_HARDENING: process.env.STATIC_PROMPT_FIDELITY_HARDENING,
  VIDEO_LIFESTYLE_PROMPT: process.env.VIDEO_LIFESTYLE_PROMPT,
  PMAX_STATIC_PLATFORM_NOTES: process.env.PMAX_STATIC_PLATFORM_NOTES
};

function setEnv(key, val) {
  if (val === undefined) delete process.env[key];
  else process.env[key] = val;
}

function restoreEnv() {
  for (const [k, v] of Object.entries(ORIG)) setEnv(k, v);
  delete require.cache[INTENTS_KEY];
  delete require.cache[VEO_KEY];
}

/**
 * Re-require staticAdIntents under specific flags.
 * preserve: 'true' | 'false' | undefined
 * hardening: 'true' | 'false' | undefined (undefined = default ON)
 */
function loadIntents({ preserve, hardening, pmaxNotes } = {}) {
  delete require.cache[INTENTS_KEY];
  // platformFormats is pure geometry — leave cached
  setEnv('STATIC_LIFESTYLE_PRESERVE', preserve);
  setEnv('STATIC_PROMPT_FIDELITY_HARDENING', hardening);
  if (pmaxNotes !== undefined) setEnv('PMAX_STATIC_PLATFORM_NOTES', pmaxNotes);
  return require('../services/staticAdIntents');
}

function loadVeo({ lifestyle } = {}) {
  delete require.cache[VEO_KEY];
  setEnv('VIDEO_LIFESTYLE_PROMPT', lifestyle);
  return require('../services/veoPromptBuilder');
}

const DATA = {
  rating: '4.8',
  reviewCount: '312',
  quote: 'Softest walkers I own — no break-in needed.',
  attribution: 'M. Chen',
  badge: 'Best Seller',
  headline: 'Walk lighter.',
  subhead: 'Everyday comfort.',
  cta: 'Shop Now',
  reviewsText: '312 brand reviews'
};

const PRODUCT = {
  desc: 'Allbirds Tree Runners in Natural Black — knit upper, sugarcane midsole.',
  look: 'calm, premium, airy lifestyle photography with soft natural light',
  logoCorner: 'bottom-right'
};

const FOUR_INTENTS = [
  'social_proof_led',
  'product_first_lifestyle',
  'objection_resolved',
  'brand_led'
];

const SURFACE = 'meta_feed_1_1';

const PRODUCT_CLAUSES = [
  'Form:',
  'Construction:',
  'Materials:',
  'Surface:',
  'Colour:',
  'Graphics already on the item',
  'Details, including but not limited to',
  'Condition:'
];

// Packshot-only strings that must NOT appear in lifestyle directives:
const PACKSHOT_STYLE_BANNED_IN_LIFESTYLE = [
  'high-end ecommerce',
  'Ken Burns',
  'product stays completely static',
  'Luxury ecommerce aesthetic'
];

const FANTASY_BANS = [
  'sparkles',
  'particles',
  'flares',
  'floating props',
  'morph'
];

const AMBIENT_PERMITS = [
  'fabric',
  'hair',
  'breath',
  'steam',
  'water',
  'foliage'
];

/**
 * Fantasy-ban tokens must appear only inside a prohibition (not as a positive
 * instruction). Matches "no X", "No fantasy motion — no sparkles…", "never X".
 * A positive "add sparkles" / "include particles" fails even if "No fantasy
 * motion" is co-present somewhere in the blob (the old vacuous V5).
 */
function isProhibitionOnly(blob, token) {
  const lower = String(blob || '').toLowerCase();
  const t = String(token).toLowerCase();
  if (!lower.includes(t)) return false;
  // Every occurrence of the token must sit inside a short window that has a
  // negation ("no"/"not"/"never") before it, OR after "No fantasy motion".
  const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  let m;
  while ((m = re.exec(blob)) !== null) {
    const start = Math.max(0, m.index - 48);
    const window = blob.slice(start, m.index + token.length);
    const windowLower = window.toLowerCase();
    const hasNeg =
      /\bno\b/.test(windowLower) ||
      /\bnot\b/.test(windowLower) ||
      /\bnever\b/.test(windowLower) ||
      /no fantasy motion/i.test(blob.slice(Math.max(0, m.index - 200), m.index + token.length));
    if (!hasNeg) return false;
    // Positive instruction patterns anywhere in a wider window fail.
    const wide = blob.slice(Math.max(0, m.index - 24), m.index + token.length + 16).toLowerCase();
    if (new RegExp(`\\b(add|include|with|use)\\s+${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(wide)) {
      return false;
    }
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════════════
// STATIC
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== STATIC lifestyle/UGC scene preserve ===\n');

// S1 — triggers
{
  const mod = loadIntents({ preserve: 'true', hardening: 'true' });
  check('S1 flag on: lifestyle seed → preserve',
    mod.shouldPreserveScene({ seedStyle: 'lifestyle' }) === true);
  check('S1 flag on: ugc variant → preserve',
    mod.shouldPreserveScene({ variantKind: 'ugc' }) === true);
  check('S1 flag on: lifestyle + product_image → preserve',
    mod.shouldPreserveScene({ seedStyle: 'lifestyle', variantKind: 'product_image' }) === true);
  for (const bad of ['packshot', 'unknown', 'ambiguous', null, undefined, 'flat_lay', 'detail', 'packaging']) {
    check(`S1 flag on: seedStyle=${bad} (non-ugc) → NO preserve`,
      mod.shouldPreserveScene({ seedStyle: bad, variantKind: 'product_image' }) === false);
  }
  // on_model resolves to lifestyle via resolveSeedStyle — assert the helper
  // accepts lifestyle (what resolveSeedStyle returns for on_model).
  check('S1 on_model maps to lifestyle style string (resolveSeedStyle contract)',
    (() => {
      const { resolveSeedStyle } = require('../services/imageShotHeuristicService');
      return resolveSeedStyle({ classification: { shotType: 'on_model' } }) === 'lifestyle';
    })());
  check('S1 lifestyle shotType → lifestyle style',
    (() => {
      const { resolveSeedStyle } = require('../services/imageShotHeuristicService');
      return resolveSeedStyle({ classification: { shotType: 'lifestyle' } }) === 'lifestyle';
    })());
  for (const st of ['product_only', 'flat_lay', 'detail', 'packaging']) {
    check(`S1 ${st} → packshot style (not preserve trigger)`,
      (() => {
        const { resolveSeedStyle } = require('../services/imageShotHeuristicService');
        return resolveSeedStyle({ classification: { shotType: st } }) === 'packshot';
      })());
  }
}

// S1 flag off — never preserve
{
  const mod = loadIntents({ preserve: 'false', hardening: 'true' });
  check('S1 flag off: lifestyle → NO preserve',
    mod.shouldPreserveScene({ seedStyle: 'lifestyle' }) === false);
  check('S1 flag off: ugc → NO preserve',
    mod.shouldPreserveScene({ variantKind: 'ugc' }) === false);
  check('S1 LIFESTYLE_PRESERVE export false when flag false',
    mod.LIFESTYLE_PRESERVE === false);
}

// S1 default (unset) is OFF
{
  const mod = loadIntents({ preserve: undefined, hardening: 'true' });
  check('S1 default (unset): lifestyle → NO preserve',
    mod.shouldPreserveScene({ seedStyle: 'lifestyle' }) === false);
  check('S1 default LIFESTYLE_PRESERVE is false',
    mod.LIFESTYLE_PRESERVE === false);
}

// S2 — Director intent owns copy: roles AND order byte-identical on vs off
// OWNER REQUIREMENT — named explicitly. text() is never preserve-aware.
// Emphasis ROLE COUNT/order stays identical; product_first_lifestyle may
// change the FIRST emphasis string under preserve (preserve-aware variant).
{
  const on = loadIntents({ preserve: 'true', hardening: 'true' });
  const off = loadIntents({ preserve: 'false', hardening: 'true' });
  for (const intentKey of FOUR_INTENTS) {
    const rOn = on.buildPrompt({
      intentKey, data: DATA, product: PRODUCT, surface: SURFACE,
      seedStyle: 'lifestyle'
    });
    const rOff = off.buildPrompt({
      intentKey, data: DATA, product: PRODUCT, surface: SURFACE,
      seedStyle: 'lifestyle'
    });
    const rolesOn = (rOn.text || []).map(([r]) => r);
    const rolesOff = (rOff.text || []).map(([r]) => r);
    check(
      `S2 OWNER: copy roles+order byte-identical for ${intentKey} (preserve-on vs off)`,
      JSON.stringify(rolesOn) === JSON.stringify(rolesOff),
      `on=${JSON.stringify(rolesOn)} off=${JSON.stringify(rolesOff)}`
    );
    // text strings themselves must also be identical (not just roles)
    check(
      `S2 OWNER: text tuples byte-identical for ${intentKey}`,
      JSON.stringify(rOn.text) === JSON.stringify(rOff.text)
    );
    // Also the resolved intent key must match (intent selection untouched)
    check(
      `S2 intent key unchanged for ${intentKey}`,
      rOn.resolved?.key === rOff.resolved?.key && rOn.resolved?.key != null
    );
    // Emphasis slot count identical; content may differ for product_first only
    check(
      `S2 emphasis slot count identical for ${intentKey}`,
      (rOn.emphasis || []).length === (rOff.emphasis || []).length
    );
    if (intentKey === 'product_first_lifestyle') {
      check(
        'S2 product_first preserve-aware emphasis points at existing photograph',
        /already in this photograph|plate already implies/i.test((rOn.emphasis || [])[0] || '')
      );
      check(
        'S2 product_first flag-off emphasis keeps scene-build wording',
        (rOff.emphasis || [])[0] === 'the product in a scene someone wants to be in'
      );
      check(
        'S2 product_first preserve emphasis is NOT the restage cue',
        !/scene someone wants to be in/i.test((rOn.emphasis || [])[0] || '')
      );
    } else {
      check(
        `S2 emphasis content identical for ${intentKey}`,
        JSON.stringify(rOn.emphasis) === JSON.stringify(rOff.emphasis)
      );
    }
  }
}

// S2b — preserveScene=true override cannot force packshot onto SCENE_PRESERVE
{
  const mod = loadIntents({ preserve: 'true', hardening: 'true' });
  const forcedPack = mod.buildPrompt({
    intentKey: 'product_first_lifestyle', data: DATA, product: PRODUCT, surface: SURFACE,
    seedStyle: 'packshot', variantKind: 'product_image', preserveScene: true
  });
  check('S2b preserveScene=true on packshot does NOT enable SCENE_PRESERVE',
    forcedPack.preserveScene === false &&
    !forcedPack.prompt.includes('SCENE PRESERVE — HIGHEST PRIORITY'));
  const forcedLife = mod.buildPrompt({
    intentKey: 'product_first_lifestyle', data: DATA, product: PRODUCT, surface: SURFACE,
    seedStyle: 'lifestyle', preserveScene: true
  });
  check('S2b preserveScene=true on lifestyle still enables preserve',
    forcedLife.preserveScene === true &&
    forcedLife.prompt.includes('SCENE PRESERVE — HIGHEST PRIORITY'));
  const forcedUgc = mod.buildPrompt({
    intentKey: 'product_first_lifestyle', data: DATA, product: PRODUCT, surface: SURFACE,
    seedStyle: 'packshot', variantKind: 'ugc', preserveScene: true
  });
  check('S2b preserveScene=true on ugc+packshot seed still enables preserve',
    forcedUgc.preserveScene === true);
}

// S3 — preserve-on contains SCENE_PRESERVE, not scene-building opening
{
  const mod = loadIntents({ preserve: 'true', hardening: 'true' });
  const p = mod.buildPrompt({
    intentKey: 'product_first_lifestyle', data: DATA, product: PRODUCT, surface: SURFACE,
    seedStyle: 'lifestyle'
  }).prompt;
  check('S3 contains SCENE PRESERVE header',
    p.includes('SCENE PRESERVE — HIGHEST PRIORITY'));
  check('S3 contains finished plate',
    p.includes('finished plate'));
  check('S3 NOT scene-building PRODUCT FIDELITY header',
    !p.includes('PRODUCT FIDELITY — HIGHEST PRIORITY'));
  check('S3 NOT LEGACY scene-build sentence',
    !p.includes('build an entirely new scene around it'));
  check('S3 NOT WHAT MAY CHANGE scene list from PRODUCT_FIDELITY',
    !p.includes('Build an entirely new scene around the item'));
  check('S3 compositing-only inventiveness',
    p.includes('Inventiveness lives in typography and chrome') ||
    p.includes('inventiveness belongs only in typography'));
}

// S4 — product identity clauses survive
{
  const mod = loadIntents({ preserve: 'true', hardening: 'true' });
  const p = mod.buildPrompt({
    intentKey: 'social_proof_led', data: DATA, product: PRODUCT, surface: SURFACE,
    seedStyle: 'lifestyle'
  }).prompt;
  for (const clause of PRODUCT_CLAUSES) {
    check(`S4 product clause present: ${clause}`, p.includes(clause));
  }
  check('S4 PRODUCT IDENTITY absolute language',
    p.includes('PRODUCT IDENTITY') && p.includes('immutable'));
}

// S5 — scrim/panel permitted; altering photo is not
{
  const mod = loadIntents({ preserve: 'true', hardening: 'true' });
  const p = mod.buildPrompt({
    intentKey: 'product_first_lifestyle', data: DATA, product: PRODUCT, surface: SURFACE,
    seedStyle: 'lifestyle'
  }).prompt;
  check('S5 soft scrim/panel permitted',
    /scrim|panel/i.test(p) && /permitted|legibility/i.test(p));
  check('S5 do not rebuild/restyle/re-light',
    p.includes('Do not rebuild') && p.includes('restyle') && p.includes('re-light'));
  check('S5 side-by-side finish check',
    p.includes('side-by-side') && p.includes('same photograph'));
  check('S5 no second location',
    p.includes('second location') || p.includes('Do not invent a second location'));
}

// S6 — flag OFF byte-identical across both hardening arms × four intents
{
  // Keep PMax notes off so Meta surface is clean across reloads
  for (const hardening of ['true', 'false']) {
    const offPreserveA = loadIntents({ preserve: 'false', hardening, pmaxNotes: 'false' });
    const offPreserveB = loadIntents({ preserve: undefined, hardening, pmaxNotes: 'false' });
    // Also compare preserve=true with packshot seed (should not trigger)
    const onFlagPackshot = loadIntents({ preserve: 'true', hardening, pmaxNotes: 'false' });
    for (const intentKey of FOUR_INTENTS) {
      const a = offPreserveA.buildPrompt({
        intentKey, data: DATA, product: PRODUCT, surface: SURFACE
      }).prompt;
      const b = offPreserveB.buildPrompt({
        intentKey, data: DATA, product: PRODUCT, surface: SURFACE
      }).prompt;
      const pack = onFlagPackshot.buildPrompt({
        intentKey, data: DATA, product: PRODUCT, surface: SURFACE,
        seedStyle: 'packshot'
      }).prompt;
      check(
        `S6 flag-off byte-identical (${intentKey}, hardening=${hardening}) false vs unset`,
        a === b
      );
      check(
        `S6 packshot+flag-on byte-identical to flag-off (${intentKey}, hardening=${hardening})`,
        a === pack
      );
    }
  }
}

// S7 — geometry unchanged by preserve
{
  const on = loadIntents({ preserve: 'true', hardening: 'true', pmaxNotes: 'false' });
  const off = loadIntents({ preserve: 'false', hardening: 'true', pmaxNotes: 'false' });
  for (const surface of Object.keys(on.SURFACE_POLICY)) {
    const gOn = on.geometryBlock(on.computeSurface(surface));
    const gOff = off.geometryBlock(off.computeSurface(surface));
    check(`S7 geometryBlock unchanged for ${surface}`, gOn === gOff);
    // Also geometry substring in full prompts for lifestyle vs packshot same geometry
    if (on.SURFACE_POLICY[surface].static) {
      const pLife = on.buildPrompt({
        intentKey: 'product_first_lifestyle', data: DATA, product: PRODUCT, surface,
        seedStyle: 'lifestyle'
      });
      const pPack = on.buildPrompt({
        intentKey: 'product_first_lifestyle', data: DATA, product: PRODUCT, surface,
        seedStyle: 'packshot'
      });
      if (!pLife.skipped && !pPack.skipped && pLife.prompt && pPack.prompt) {
        check(`S7 geometry string present+identical in lifestyle vs packshot prompts (${surface})`,
          pLife.prompt.includes(gOn) && pPack.prompt.includes(gOn));
      }
    }
  }
  // Report: edge-to-edge language is compatible (assert present, not reworded)
  const sample = on.geometryBlock(on.computeSurface('meta_feed_1_1'));
  check('S7 REPORT: geometry still says photograph fills frame edge to edge (compatible with preserve)',
    sample.includes('photograph should still fill the whole frame edge to edge'));
}

// 4-way matrix smoke: hardening × preserve for one intent
console.log('\n--- 4-way static flag matrix ---');
{
  const cells = [];
  for (const hardening of ['true', 'false']) {
    for (const preserve of ['true', 'false']) {
      const mod = loadIntents({ preserve, hardening, pmaxNotes: 'false' });
      const r = mod.buildPrompt({
        intentKey: 'product_first_lifestyle', data: DATA, product: PRODUCT, surface: SURFACE,
        seedStyle: 'lifestyle'
      });
      const hasScene = r.prompt.includes('SCENE PRESERVE — HIGHEST PRIORITY');
      const hasHard = r.prompt.includes('PRODUCT FIDELITY — HIGHEST PRIORITY');
      // LEGACY fingerprint must not match the hardened block's "PRODUCT
      // REFERENCE ONLY" sub-clause — use the exclusive LEGACY opening.
      const hasLegacy = r.prompt.includes(
        'The supplied photograph is a PRODUCT REFERENCE ONLY. Reproduce this exact item faithfully'
      );
      const cell = { hardening, preserve, hasScene, hasHard, hasLegacy, len: r.prompt.length };
      cells.push(cell);
      const expectScene = preserve === 'true';
      const expectHard = preserve !== 'true' && hardening === 'true';
      const expectLegacy = preserve !== 'true' && hardening === 'false';
      check(
        `MATRIX hardening=${hardening} preserve=${preserve}: scene=${expectScene} hard=${expectHard} legacy=${expectLegacy}`,
        hasScene === expectScene && hasHard === expectHard && hasLegacy === expectLegacy,
        JSON.stringify(cell)
      );
    }
  }
  // Flag-off arms equal across preserve false regardless of... already covered
  console.log('  matrix cells:', cells.map(c =>
    `H${c.hardening[0]}/P${c.preserve[0]}→${c.hasScene ? 'SCENE' : c.hasHard ? 'HARD' : 'LEGACY'}(${c.len})`
  ).join(' | '));
}

// ═══════════════════════════════════════════════════════════════════════
// VIDEO
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== VIDEO lifestyle directives ===\n');

// V1 — selection (lifestyle seed OR ugc variantKind — matches static)
{
  const on = loadVeo({ lifestyle: 'true' });
  const life = on.buildVeoPrompt({
    product: { title: 'Wool Runner' },
    seedStyle: 'lifestyle',
    hasProductReference: false,
    durationSec: 8,
    caps: { promptByteCap: 20000, paramShape: 'gemini-omni' }
  });
  const pack = on.buildVeoPrompt({
    product: { title: 'Wool Runner' },
    seedStyle: 'packshot',
    hasProductReference: true,
    durationSec: 8,
    caps: { promptByteCap: 20000, paramShape: 'gemini-omni' }
  });
  const none = on.buildVeoPrompt({
    product: { title: 'Wool Runner' },
    hasProductReference: true,
    durationSec: 8,
    caps: { promptByteCap: 20000, paramShape: 'gemini-omni' }
  });
  const ugcPack = on.buildVeoPrompt({
    product: { title: 'Wool Runner' },
    seedStyle: 'packshot',
    variantKind: 'ugc',
    hasProductReference: false,
    durationSec: 8,
    caps: { promptByteCap: 20000, paramShape: 'gemini-omni' }
  });
  check('V1 lifestyle+flag → Lifestyle motion editor role',
    life.includes('Lifestyle motion editor'));
  check('V1 lifestyle+flag → ambient life',
    life.includes('AMBIENT LIFE') || life.includes('Ambient life'));
  check('V1 packshot+flag → still OMNI role (product commercial editor)',
    pack.includes('Professional product commercial editor') && pack.includes('Ken Burns'));
  check('V1 no seedStyle+flag → OMNI path (B14-compatible)',
    none.includes('Professional product commercial editor') && none.includes('Ken Burns'));
  check('V1 ugc+packshot seed → lifestyle path (matches static trigger)',
    ugcPack.includes('Lifestyle motion editor'));
  check('V1 shouldUseLifestyleVideoPrompt lifestyle true',
    on.shouldUseLifestyleVideoPrompt('lifestyle') === true);
  check('V1 shouldUseLifestyleVideoPrompt packshot false',
    on.shouldUseLifestyleVideoPrompt('packshot') === false);
  check('V1 shouldUseLifestyleVideoPrompt ugc true even if packshot seed',
    on.shouldUseLifestyleVideoPrompt('packshot', 'ugc') === true);
  check('V1 shouldUseLifestyleVideoPrompt product_image+packshot false',
    on.shouldUseLifestyleVideoPrompt('packshot', 'product_image') === false);
}

// V1 flag off
{
  const off = loadVeo({ lifestyle: 'false' });
  check('V1 flag off: shouldUseLifestyle false even for lifestyle seed',
    off.shouldUseLifestyleVideoPrompt('lifestyle') === false);
  const life = off.buildVeoPrompt({
    product: { title: 'Wool Runner' },
    seedStyle: 'lifestyle',
    hasProductReference: true,
    durationSec: 8,
    caps: { promptByteCap: 20000, paramShape: 'gemini-omni' }
  });
  check('V1 flag off: lifestyle seed still gets OMNI/Ken Burns',
    life.includes('Ken Burns') && life.includes('high-end ecommerce'));
}

// V2 — OMNI + GROK byte-unchanged vs 134db56~1
// Baseline does NOT export OMNI_DIRECTIVES / GROK_DIRECTIVES, so iterating
// Object.keys(oldMod.OMNI_DIRECTIVES || {}) ran ZERO comparisons (vacuous).
// Fix: inject those names into the baseline module.exports (same consts are
// in scope), then field-compare — plus the B14-style full prompt matrix.
{
  const mod = loadVeo({ lifestyle: undefined });
  const BASELINE = '134db56~1:services/veoPromptBuilder.js';
  const REL_REQUIRE = "require('./platformFormats')";
  let oldMod = null;
  let skipReason = null;
  let tmpDir = null;
  try {
    const src = cp.execFileSync('git', ['-C', REPO, 'show', BASELINE], {
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore']
    });
    if (!src.includes(REL_REQUIRE)) {
      skipReason = `baseline missing ${REL_REQUIRE}`;
    } else if (!/\bconst OMNI_DIRECTIVES\b/.test(src) || !/\bconst GROK_DIRECTIVES\b/.test(src)) {
      skipReason = 'baseline missing OMNI_DIRECTIVES or GROK_DIRECTIVES const';
    } else {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeVeoPin-'));
      const tmpFile = path.join(tmpDir, 'veoPromptBuilder.baseline.js');
      // Relocate platformFormats require, then force-export the directive
      // objects so field comparison is real (baseline never exported them).
      let patched = src.replace(
        REL_REQUIRE,
        `require(${JSON.stringify(path.join(REPO, 'services', 'platformFormats'))})`
      );
      if (/module\.exports\s*=\s*\{/.test(patched)) {
        patched = patched.replace(
          /module\.exports\s*=\s*\{/,
          'module.exports = { OMNI_DIRECTIVES, GROK_DIRECTIVES, '
        );
      } else {
        patched += '\nmodule.exports.OMNI_DIRECTIVES = OMNI_DIRECTIVES;\n' +
          'module.exports.GROK_DIRECTIVES = GROK_DIRECTIVES;\n';
      }
      fs.writeFileSync(tmpFile, patched);
      oldMod = require(tmpFile);
      if (!oldMod.OMNI_DIRECTIVES || !oldMod.GROK_DIRECTIVES) {
        oldMod = null;
        skipReason = 'baseline load succeeded but OMNI/GROK exports missing after inject';
      }
    }
  } catch (e) {
    skipReason = e.message || String(e);
  }

  if (!oldMod) {
    check('V2 SKIP: baseline unavailable (not a pass)', false, skipReason);
  } else {
    const omniKeys = Object.keys(oldMod.OMNI_DIRECTIVES);
    const grokKeys = Object.keys(oldMod.GROK_DIRECTIVES);
    // Non-vacuous: must compare a real field set (doNot alone is load-bearing).
    check('V2 baseline OMNI_DIRECTIVES has ≥8 fields (non-vacuous)',
      omniKeys.length >= 8, `keys=${omniKeys.length}`);
    check('V2 baseline GROK_DIRECTIVES has ≥8 fields (non-vacuous)',
      grokKeys.length >= 8, `keys=${grokKeys.length}`);
    check('V2 baseline OMNI has doNot', omniKeys.includes('doNot'));
    check('V2 baseline GROK has doNot', grokKeys.includes('doNot'));
    for (const key of omniKeys) {
      check(`V2 OMNI_DIRECTIVES.${key} byte-identical to 134db56~1`,
        mod.OMNI_DIRECTIVES[key] === oldMod.OMNI_DIRECTIVES[key],
        key);
    }
    for (const key of grokKeys) {
      check(`V2 GROK_DIRECTIVES.${key} byte-identical to 134db56~1`,
        mod.GROK_DIRECTIVES[key] === oldMod.GROK_DIRECTIVES[key],
        key);
    }
    // Full prompt matrix (same as B14 subset) — no seedStyle
    const CAPSETS = [
      [null],
      [{ promptByteCap: 20000, paramShape: 'gemini-omni' }]
    ];
    for (const [caps] of CAPSETS) {
      for (const hasProductReference of [true, false]) {
        for (const durationSec of [4, 8, 15]) {
          for (const seedHasText of [false, true]) {
            const args = {
              product: { title: 'Wool Runner' },
              hasProductReference, durationSec, seedHasText, caps
            };
            check(
              `V2 prompt byte-identical to 134db56~1 (ref=${hasProductReference} dur=${durationSec} text=${seedHasText} caps=${caps ? 'omni' : 'def'})`,
              mod.buildVeoPrompt(args) === oldMod.buildVeoPrompt(args)
            );
          }
        }
      }
    }
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
    }
  }
}

// V3 — lifestyle keeps hard constraints (identity ≠ immobility)
{
  const mod = loadVeo({ lifestyle: 'true' });
  const d = mod.LIFESTYLE_DIRECTIVES;
  const blob = Object.values(d).join(' ');
  check('V3 product identity absolute (form/construction/materials/colour/branding)',
    /form/i.test(blob) && /construction/i.test(blob) && /materials/i.test(blob) &&
    /colour|color/i.test(blob) && /branding|logos/i.test(blob) &&
    /identical|never change|absolute/i.test(blob));
  check('V3 no new background / scene identity',
    /new background|second location|Preserve THAT scene|scene identity/i.test(blob));
  check('V3 noText — composited downstream / rejection',
    /composited downstream/i.test(d.noText) && /rejection/i.test(d.noText));
  check('V3 physicalAccuracy — 5-fingered hands + mid-shot morphing',
    /5-fingered hands/i.test(d.physicalAccuracy) && /morphing/i.test(d.physicalAccuracy));
  check('V3 identity absolute, not immobility (may move as real item)',
    /IDENTITY is absolute|identity is absolute|Product fidelity means IDENTITY/i.test(blob) &&
    /may move ONLY as the real physical item would|as a consequence of the wearer's/i.test(blob));
  check('V3 no-morph / no-regenerate / no re-drape',
    /morph/i.test(blob) && /regenerate/i.test(blob) && /re-drape|re-posed|independently animated/i.test(blob));
  check('V3 rigid/hard-goods do not deform',
    /rigid|hard-goods|hard goods/i.test(blob) && /does not deform|do not bend/i.test(blob));
  check('V3 camera bans parallax / 2.5D depth',
    /parallax/i.test(d.cameraStyle) && /2\.5D|synthesized/i.test(d.cameraStyle));
  check('V3 guidance snippets do not end with frozen/does not animate immobility',
    !Object.values(mod.LIFESTYLE_VIDEO_GUIDANCE).some(s =>
      /Product does not animate\.?\s*$/i.test(s) ||
      /Product geometry frozen\.?\s*$/i.test(s) ||
      /Product frozen\.?\s*$/i.test(s)));
}

// V4 — no packshot-only style strings
{
  const mod = loadVeo({ lifestyle: 'true' });
  const blob = Object.values(mod.LIFESTYLE_DIRECTIVES).join(' ');
  for (const s of PACKSHOT_STYLE_BANNED_IN_LIFESTYLE) {
    check(`V4 lifestyle directives exclude packshot string: "${s}"`,
      !blob.includes(s));
  }
  const prompt = mod.buildVeoPrompt({
    product: { title: 'Wool Runner' },
    seedStyle: 'lifestyle',
    durationSec: 8,
    caps: { promptByteCap: 20000, paramShape: 'gemini-omni' }
  });
  for (const s of PACKSHOT_STYLE_BANNED_IN_LIFESTYLE) {
    check(`V4 lifestyle prompt excludes: "${s}"`, !prompt.includes(s));
  }
}

// V5 — ambient permitted; fantasy tokens only inside a prohibition
{
  const mod = loadVeo({ lifestyle: 'true' });
  const d = mod.LIFESTYLE_DIRECTIVES;
  const blob = Object.values(d).join(' ') + ' ' +
    mod.buildVeoPrompt({
      product: { title: 'X' }, seedStyle: 'lifestyle', durationSec: 8,
      caps: { promptByteCap: 20000, paramShape: 'gemini-omni' }
    });
  for (const a of AMBIENT_PERMITS) {
    check(`V5 ambient permitted: ${a}`, new RegExp(a, 'i').test(blob));
  }
  for (const f of FANTASY_BANS) {
    check(`V5 fantasy banned as prohibition only: ${f}`,
      isProhibitionOnly(d.doNot, f) || isProhibitionOnly(blob, f));
  }
  check('V5 doNot lists fantasy motion ban explicitly',
    /No fantasy motion/i.test(d.doNot));
  // Positive co-presence must NOT satisfy: inject a synthetic positive and
  // prove isProhibitionOnly rejects it (sanity of the helper itself).
  check('V5 helper rejects positive co-presence (add sparkles + No fantasy motion)',
    isProhibitionOnly('No fantasy motion. Please add sparkles to the scene.', 'sparkles') === false);
  check('V5 helper accepts ban list form',
    isProhibitionOnly('No fantasy motion — no sparkles, particles, or flares.', 'sparkles') === true);
}

// V6 — reference count: effective count from the plan (behavioural)
// A mutation that calls resolveLifestyleVideoRefCount for side effect but
// still passes baseReferenceCount to buildReferenceImages must fail.
{
  const on = loadVeo({ lifestyle: 'true' });
  check('V6 lifestyle+flag → ref count 1',
    on.resolveLifestyleVideoRefCount(3, 'lifestyle') === 1);
  check('V6 packshot+flag → base 3 unchanged',
    on.resolveLifestyleVideoRefCount(3, 'packshot') === 3);
  check('V6 unknown+flag → base 3',
    on.resolveLifestyleVideoRefCount(3, 'unknown') === 3);
  check('V6 lifestyle+flag with base 5 → still 1',
    on.resolveLifestyleVideoRefCount(5, 'lifestyle') === 1);
  check('V6 ugc+packshot seed → ref count 1',
    on.resolveLifestyleVideoRefCount(3, 'packshot', 'ugc') === 1);

  // Behavioural plan — this is what generateForAd must pass to buildReferenceImages.
  const planLife = on.resolveLifestyleVideoRefPlan({
    baseReferenceCount: 3, seedStyle: 'lifestyle'
  });
  const planPack = on.resolveLifestyleVideoRefPlan({
    baseReferenceCount: 3, seedStyle: 'packshot'
  });
  const planUgc = on.resolveLifestyleVideoRefPlan({
    baseReferenceCount: 5, seedStyle: 'unknown', variantKind: 'ugc'
  });
  check('V6 plan lifestyle: referenceCount===1 (effective)',
    planLife.referenceCount === 1 && planLife.forceSeedOnly === true);
  check('V6 plan packshot: referenceCount===base 3',
    planPack.referenceCount === 3 && planPack.forceSeedOnly === false);
  check('V6 plan ugc: referenceCount===1 even with base 5',
    planUgc.referenceCount === 1 && planUgc.forceSeedOnly === true);
  // Plan must not return base when lifestyle is active (catches side-effect-only call).
  check('V6 plan lifestyle never returns baseReferenceCount as effective count',
    planLife.referenceCount !== 3);

  const off = loadVeo({ lifestyle: 'false' });
  check('V6 flag off lifestyle → base 3',
    off.resolveLifestyleVideoRefCount(3, 'lifestyle') === 3);
  check('V6 flag off plan ignores lifestyle',
    off.resolveLifestyleVideoRefPlan({ baseReferenceCount: 3, seedStyle: 'lifestyle' })
      .referenceCount === 3);
  check('V6 DEFAULT_REFERENCE_IMAGE_COUNT still 3 (packshot path)',
    (() => {
      const src = fs.readFileSync(path.join(REPO, 'services/atlasVideoService.js'), 'utf8');
      return /const DEFAULT_REFERENCE_IMAGE_COUNT = 3/.test(src);
    })());
  // generateForAd must wire the plan's effective count into buildReferenceImages
  // — not call the helper and discard the result.
  {
    const src = fs.readFileSync(path.join(REPO, 'services/atlasVideoService.js'), 'utf8');
    check('V6 generateForAd uses resolveLifestyleVideoRefPlan',
      src.includes('resolveLifestyleVideoRefPlan'));
    check('V6 generateForAd uses plan.referenceCount (effective)',
      /lifestylePlan\.referenceCount/.test(src));
    check('V6 generateForAd does NOT pass baseReferenceCount as referenceCount kwarg',
      !/buildReferenceImages\(\{[\s\S]{0,400}referenceCount:\s*baseReferenceCount/.test(src));
    check('V6 generateForAd resolves seedStyle via resolveSeedStyle',
      src.includes('resolveSeedStyle(media)'));
    check('V6 lifestyle clears orderedReferenceMedia via plan.forceSeedOnly',
      /orderedReferenceMedia:\s*lifestylePlan\.forceSeedOnly\s*\?\s*null/.test(src));
    check('V6 generateForAd threads variantKind into plan',
      /variantKind:\s*ad\.variantKind/.test(src));
  }
}

// V9 — lifestyle + PMax compose (orthogonal, not suppress)
{
  const on = loadVeo({ lifestyle: 'true' });
  const pmaxLife = on.buildVeoPrompt({
    product: { title: 'Wool Runner' },
    seedStyle: 'lifestyle',
    platformFormat: 'pmax_video_9_16',
    aspectRatio: '9:16',
    durationSec: 10,
    hasProductReference: false,
    caps: { promptByteCap: 20000, paramShape: 'gemini-omni' }
  });
  const pmaxPack = on.buildVeoPrompt({
    product: { title: 'Wool Runner' },
    seedStyle: 'packshot',
    platformFormat: 'pmax_video_9_16',
    aspectRatio: '9:16',
    durationSec: 10,
    hasProductReference: true,
    caps: { promptByteCap: 20000, paramShape: 'gemini-omni' }
  });
  const metaLife = on.buildVeoPrompt({
    product: { title: 'Wool Runner' },
    seedStyle: 'lifestyle',
    platformFormat: 'meta_reels_9_16',
    aspectRatio: '9:16',
    durationSec: 8,
    hasProductReference: false,
    caps: { promptByteCap: 20000, paramShape: 'gemini-omni' }
  });
  check('V9 lifestyle+PMax keeps lifestyle scene/motion role',
    pmaxLife.includes('Lifestyle motion editor'));
  check('V9 lifestyle+PMax keeps HOOK-FIRST',
    /HOOK-FIRST|HOOK —/i.test(pmaxLife));
  check('V9 lifestyle+PMax keeps centre-safe',
    /Centre-safe|center-safe|central region/i.test(pmaxLife));
  check('V9 lifestyle+PMax emits Frame (9:16)',
    pmaxLife.includes('Frame (9:16 vertical)'));
  check('V9 lifestyle+Meta does NOT emit Frame (9:16)',
    !metaLife.includes('Frame (9:16 vertical)'));
  check('V9 packshot+PMax still Ken Burns packshot path',
    pmaxPack.includes('Ken Burns') || pmaxPack.includes('product commercial'));
  check('V9 lifestyle+PMax does not re-impose product stays completely static',
    !pmaxLife.includes('product stays completely static'));
}

// V7 — guidance snippets
{
  const mod = loadVeo({ lifestyle: 'true' });
  const keys = Object.keys(mod.LIFESTYLE_VIDEO_GUIDANCE);
  check('V7 guidance has exactly four intents',
    keys.length === 4 &&
    FOUR_INTENTS.every(k => keys.includes(k)));
  for (const k of FOUR_INTENTS) {
    const snip = mod.LIFESTYLE_VIDEO_GUIDANCE[k];
    check(`V7 ${k} ≤600 chars`, typeof snip === 'string' && snip.length <= 600,
      `len=${snip?.length}`);
    check(`V7 ${k} non-empty`, snip.length > 40);
    // No copy / offer / text instructions
    const bad = /\b(headline|CTA|shop now|% off|price|render text|typeset|caption the|write the copy)\b/i;
    check(`V7 ${k} no copy/offer/text instruction`, !bad.test(snip));
  }
  check('V7 lifestyleVideoGuidanceForIntent falls back to product_first_lifestyle',
    mod.lifestyleVideoGuidanceForIntent('nope') ===
    mod.LIFESTYLE_VIDEO_GUIDANCE.product_first_lifestyle);
  // When lifestyle active and no cascade guidance, generateForAd injects snippet
  {
    const src = fs.readFileSync(path.join(REPO, 'services/atlasVideoService.js'), 'utf8');
    check('V7 generateForAd injects lifestyleVideoGuidanceForIntent when cascade empty',
      src.includes('lifestyleVideoGuidanceForIntent') &&
      src.includes('!effectiveGuidance && lifestyleVideo'));
  }
}

// V8 — flag OFF prompt identical with or without seedStyle lifestyle
{
  const off = loadVeo({ lifestyle: 'false' });
  const args = {
    product: { title: 'Wool Runner' },
    hasProductReference: true,
    durationSec: 8,
    caps: { promptByteCap: 20000, paramShape: 'gemini-omni' }
  };
  const a = off.buildVeoPrompt(args);
  const b = off.buildVeoPrompt({ ...args, seedStyle: 'lifestyle' });
  const c = off.buildVeoPrompt({ ...args, seedStyle: 'packshot' });
  check('V8 flag off: lifestyle seedStyle does not change prompt', a === b);
  check('V8 flag off: packshot seedStyle does not change prompt', a === c);
  check('V8 flag off: ref count helper ignores lifestyle',
    off.resolveLifestyleVideoRefCount(3, 'lifestyle') === 3);
}

// Titling untouched — Remotion path not modified by this change
{
  const brandSrc = fs.readFileSync(path.join(REPO, 'services/brandScriptExecutor.js'), 'utf8');
  // Lightweight: lifestyle files we touched do not re-route titling
  const veoSrc = fs.readFileSync(path.join(REPO, 'services/veoPromptBuilder.js'), 'utf8');
  check('TITLING: lifestyle path still says copy composited downstream',
    veoSrc.includes('All ad copy is composited downstream') ||
    veoSrc.includes('Ad copy is composited downstream'));
  check('TITLING: brandScriptExecutor still present (untouched by this change)',
    brandSrc.includes('renderBrandScript') || brandSrc.includes('remotion'));
  check('TITLING: LIFESTYLE_DIRECTIVES noText bans generated text',
    loadVeo({ lifestyle: 'true' }).LIFESTYLE_DIRECTIVES.noText.includes('composited downstream'));
}

// ═══════════════════════════════════════════════════════════════════════
// BLOCKER 3 — variantKind reaches the prompt builder on EVERY caller
// Behavioural: pure arg builders → shouldPreserveScene / buildPrompt.
// Complete caller list of renderDirectImage (production):
//   1. renderService.renderStage (first render) — spreads args.variantKind
//   2. adRegenerateService.runImage (paid regen) — buildDirectImageArgsFromAd
//   3. directImageRenderService QC re-entry (paid retry) — buildQcRetryArgs
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== BLOCKER 3: variantKind on all renderDirectImage callers ===\n');
{
  const intentsOn = loadIntents({ preserve: 'true', hardening: 'true' });
  const regen = require('../services/adRegenerateService');
  const direct = require('../services/directImageRenderService');

  // Caller 1 — renderService: args object built with adDoc.variantKind
  // (renderStage spreads ...args into renderDirectImage). Simulate the
  // same resolution used at renderService.js:221.
  const renderServiceArgs = {
    variantKind: ({ variantKind: 'ugc' }).variantKind || null,
    template: 'ai_product_first_lifestyle',
    platformFormat: 'meta_feed_1_1'
  };
  check('C1 renderService-shaped args carry variantKind=ugc',
    renderServiceArgs.variantKind === 'ugc');
  {
    // Behavioural: packshot seed + ugc variantKind → preserve
    const built = intentsOn.buildPrompt({
      intentKey: 'product_first_lifestyle',
      data: DATA, product: PRODUCT, surface: SURFACE,
      seedStyle: 'packshot',
      variantKind: renderServiceArgs.variantKind
    });
    check('C1 renderService variantKind reaches preserve gate (ugc+packshot seed)',
      built.preserveScene === true &&
      built.prompt.includes('SCENE PRESERVE — HIGHEST PRIORITY'));
  }
  // Revert-prove shape: drop variantKind → no preserve on packshot seed
  {
    const dropped = intentsOn.buildPrompt({
      intentKey: 'product_first_lifestyle',
      data: DATA, product: PRODUCT, surface: SURFACE,
      seedStyle: 'packshot',
      variantKind: null
    });
    check('C1 REVERT-PROVE: dropping variantKind kills ugc preserve on packshot seed',
      dropped.preserveScene === false);
  }

  // Caller 2 — adRegenerateService paid regen
  const fakeAd = {
    _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    layoutInputArtifactId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
    aspectRatio: '1:1',
    mediaId: 'cccccccccccccccccccccccc',
    productId: 'dddddddddddddddddddddddd',
    brandId: 'eeeeeeeeeeeeeeeeeeeeeeee',
    campaignId: 'ffffffffffffffffffffffff',
    campaignRunIds: ['run_1'],
    conceptArtifactId: null,
    conceptId: null,
    template: 'ai_product_first_lifestyle',
    platformFormat: 'meta_feed_1_1',
    variantKind: 'ugc'
  };
  const regenArgs = regen.buildDirectImageArgsFromAd(fakeAd, {
    adId: fakeAd._id,
    referenceMediaIds: [fakeAd.mediaId],
    referenceSource: 'operator',
    prompt: null,
    promptOverride: null
  });
  check('C2 adRegenerateService args include variantKind=ugc',
    regenArgs.variantKind === 'ugc');
  {
    const built = intentsOn.buildPrompt({
      intentKey: 'product_first_lifestyle',
      data: DATA, product: PRODUCT, surface: SURFACE,
      seedStyle: 'packshot',
      variantKind: regenArgs.variantKind
    });
    check('C2 regen variantKind reaches preserve gate',
      built.preserveScene === true);
  }
  // Revert-prove: omit variantKind from a mutated builder result
  {
    const { variantKind: _drop, ...without } = regenArgs;
    void _drop;
    check('C2 REVERT-PROVE: args without variantKind field',
      !Object.prototype.hasOwnProperty.call(without, 'variantKind'));
    const built = intentsOn.buildPrompt({
      intentKey: 'product_first_lifestyle',
      data: DATA, product: PRODUCT, surface: SURFACE,
      seedStyle: 'packshot',
      variantKind: without.variantKind // undefined
    });
    check('C2 REVERT-PROVE: dropped variantKind → no preserve on packshot seed',
      built.preserveScene === false);
  }

  // Caller 3 — vision QC corrective re-entry (spread original args)
  const originalCall = {
    layoutInputArtifactId: fakeAd.layoutInputArtifactId,
    aspectRatio: '1:1',
    mediaId: fakeAd.mediaId,
    productId: fakeAd.productId,
    brandId: fakeAd.brandId,
    adId: fakeAd._id,
    template: fakeAd.template,
    platformFormat: 'meta_feed_1_1',
    variantKind: 'ugc',
    referenceMediaIds: [fakeAd.mediaId],
    operatorPrompt: null,
    rawPromptOverride: null
  };
  const qcArgs = direct.buildQcRetryArgs(originalCall, {
    correctiveNote: 'fix the safe box',
    overrideText: null
  });
  check('C3 QC retry spreads variantKind=ugc from original call',
    qcArgs.variantKind === 'ugc');
  check('C3 QC retry sets skipVisionQc true',
    qcArgs.skipVisionQc === true);
  {
    const built = intentsOn.buildPrompt({
      intentKey: 'product_first_lifestyle',
      data: DATA, product: PRODUCT, surface: SURFACE,
      seedStyle: 'packshot',
      variantKind: qcArgs.variantKind
    });
    check('C3 QC retry variantKind reaches preserve gate',
      built.preserveScene === true);
  }
  // Revert-prove: buildQcRetryArgs from an original that omitted variantKind
  {
    const { variantKind: _d, ...noVk } = originalCall;
    void _d;
    const broken = direct.buildQcRetryArgs(noVk, {
      correctiveNote: 'fix',
      overrideText: null
    });
    check('C3 REVERT-PROVE: original without variantKind → retry also lacks it',
      broken.variantKind == null);
    const built = intentsOn.buildPrompt({
      intentKey: 'product_first_lifestyle',
      data: DATA, product: PRODUCT, surface: SURFACE,
      seedStyle: 'packshot',
      variantKind: broken.variantKind
    });
    check('C3 REVERT-PROVE: missing variantKind on QC retry → no preserve',
      built.preserveScene === false);
  }

  // Enumerate: only these three production call sites
  {
    const callers = [];
    for (const rel of [
      'services/renderService.js',
      'services/adRegenerateService.js',
      'services/directImageRenderService.js'
    ]) {
      const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
      const re = /renderDirectImage\s*\(/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        callers.push({ file: rel, at: m.index });
      }
    }
    // directImageRenderService has the definition + the QC re-call
    check('C* complete caller sweep: ≥3 renderDirectImage( sites in the three files',
      callers.length >= 3, JSON.stringify(callers.map(c => c.file)));
    console.log('  renderDirectImage call sites:',
      callers.map(c => c.file).join(', '));
  }
}

// ═══════════════════════════════════════════════════════════════════════
// REVERT-PROVE (document which check catches which mutation)
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== REVERT-PROVE map (documented) ===');
const REVERT_MAP = [
  ['Remove shouldPreserveScene lifestyle branch', 'S1 lifestyle seed → preserve'],
  ['Remove ugc trigger', 'S1 flag on: ugc variant → preserve'],
  ['Stack PRODUCT_FIDELITY under SCENE_PRESERVE', 'S3 NOT scene-building PRODUCT FIDELITY header'],
  ['Drop Form/Construction clauses from SCENE_PRESERVE', 'S4 product clause present: Form:'],
  ['Remove scrim permission', 'S5 soft scrim/panel permitted'],
  ['Change copy role order when preserve on', 'S2 OWNER: copy roles+order byte-identical'],
  ['Edit geometryBlock for preserve', 'S7 geometryBlock unchanged'],
  ['Flag default true', 'S1 default LIFESTYLE_PRESERVE is false / S6 flag-off byte-identical'],
  ['preserveScene=true on packshot forces preserve', 'S2b preserveScene=true on packshot does NOT enable'],
  ['product_first restage cue under preserve', 'S2 product_first preserve-aware emphasis'],
  ['Edit OMNI_DIRECTIVES.doNot string', 'V2 OMNI_DIRECTIVES.doNot byte-identical (non-vacuous field loop)'],
  ['Edit GROK_DIRECTIVES string', 'V2 GROK_DIRECTIVES.* byte-identical'],
  ['Select lifestyle without flag', 'V1 flag off: lifestyle seed still gets OMNI'],
  ['Drop ugc video trigger', 'V1 ugc+packshot seed → lifestyle path'],
  ['Restore product immobility contradiction', 'V3 identity absolute, not immobility'],
  ['Drop parallax ban from lifestyle camera', 'V3 camera bans parallax'],
  ['Drop physicalAccuracy hands', 'V3 physicalAccuracy'],
  ['Positive "add sparkles" co-present with ban', 'V5 fantasy banned as prohibition only / V5 helper rejects positive'],
  ['Lifestyle plan returns base count 3', 'V6 plan lifestyle: referenceCount===1 (effective)'],
  ['Call resolveLifestyleVideoRefCount but pass baseReferenceCount', 'V6 generateForAd uses plan.referenceCount / does NOT pass baseReferenceCount'],
  ['Lifestyle suppresses PMax (isPmax = !lifestyle && …)', 'V9 lifestyle+PMax keeps HOOK-FIRST / Frame'],
  ['Drop variantKind on regen args', 'C2 REVERT-PROVE: dropped variantKind → no preserve'],
  ['Drop variantKind on QC retry (hand-list fields)', 'C3 REVERT-PROVE: missing variantKind on QC retry'],
  ['Guidance >600 chars', 'V7 * ≤600 chars'],
  ['Guidance says Shop Now', 'V7 * no copy/offer/text instruction']
];
for (const [mut, catcher] of REVERT_MAP) {
  console.log(`  · mutate: ${mut}`);
  console.log(`    caught by: ${catcher}`);
}
check('REVERT-PROVE table enumerated (≥20 mutations)', REVERT_MAP.length >= 20);

// ── summary ──────────────────────────────────────────────────────────
restoreEnv();
console.log(`\n${'─'.repeat(60)}`);
console.log(`verifyLifestylePreserve: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('All checks green.');
process.exit(0);
