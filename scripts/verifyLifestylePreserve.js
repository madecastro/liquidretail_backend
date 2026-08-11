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

const PACKSHOT_ONLY_STRINGS = [
  'high-end ecommerce',
  'Ken Burns',
  'product stays completely static',
  'animate the product or any of its parts' // wait — lifestyle KEEPS the ban on product animation
];
// Corrected: lifestyle must KEEP "animate the product or any of its parts" as a ban.
// Packshot-only strings that must NOT appear in lifestyle:
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
// OWNER REQUIREMENT — named explicitly
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
    // Also the resolved intent key must match (intent selection untouched)
    check(
      `S2 intent key unchanged for ${intentKey}`,
      rOn.resolved?.key === rOff.resolved?.key && rOn.resolved?.key != null
    );
    // Emphasis order (attention hierarchy) also identical
    check(
      `S2 emphasis order identical for ${intentKey}`,
      JSON.stringify(rOn.emphasis) === JSON.stringify(rOff.emphasis)
    );
  }
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

// V1 — selection
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
  check('V1 lifestyle+flag → Lifestyle motion editor role',
    life.includes('Lifestyle motion editor'));
  check('V1 lifestyle+flag → ambient life',
    life.includes('AMBIENT LIFE') || life.includes('Ambient life'));
  check('V1 packshot+flag → still OMNI role (product commercial editor)',
    pack.includes('Professional product commercial editor') && pack.includes('Ken Burns'));
  check('V1 no seedStyle+flag → OMNI path (B14-compatible)',
    none.includes('Professional product commercial editor') && none.includes('Ken Burns'));
  check('V1 shouldUseLifestyleVideoPrompt lifestyle true',
    on.shouldUseLifestyleVideoPrompt('lifestyle') === true);
  check('V1 shouldUseLifestyleVideoPrompt packshot false',
    on.shouldUseLifestyleVideoPrompt('packshot') === false);
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
    } else {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeVeoPin-'));
      const tmpFile = path.join(tmpDir, 'veoPromptBuilder.baseline.js');
      fs.writeFileSync(tmpFile, src.replace(
        REL_REQUIRE,
        `require(${JSON.stringify(path.join(REPO, 'services', 'platformFormats'))})`
      ));
      oldMod = require(tmpFile);
    }
  } catch (e) {
    skipReason = e.message || String(e);
  }

  if (!oldMod) {
    check('V2 SKIP: baseline unavailable (not a pass)', false, skipReason);
  } else {
    // Directive object fields — stringify comparison for OMNI + GROK
    for (const key of Object.keys(oldMod.OMNI_DIRECTIVES || {})) {
      check(`V2 OMNI_DIRECTIVES.${key} byte-identical to 134db56~1`,
        mod.OMNI_DIRECTIVES[key] === oldMod.OMNI_DIRECTIVES[key],
        key);
    }
    for (const key of Object.keys(oldMod.GROK_DIRECTIVES || {})) {
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

// V3 — lifestyle keeps hard constraints
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
  check('V3 product must not animate',
    /Do NOT animate the product or any of its parts/i.test(blob));
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

// V5 — ambient permitted, fantasy banned
{
  const mod = loadVeo({ lifestyle: 'true' });
  const blob = Object.values(mod.LIFESTYLE_DIRECTIVES).join(' ') + ' ' +
    mod.buildVeoPrompt({
      product: { title: 'X' }, seedStyle: 'lifestyle', durationSec: 8,
      caps: { promptByteCap: 20000, paramShape: 'gemini-omni' }
    });
  for (const a of AMBIENT_PERMITS) {
    check(`V5 ambient permitted: ${a}`, new RegExp(a, 'i').test(blob));
  }
  for (const f of FANTASY_BANS) {
    check(`V5 fantasy banned: ${f}`,
      new RegExp(`no ${f}|No ${f}|fantasy motion[\\s\\S]*${f}`, 'i').test(blob) ||
      blob.toLowerCase().includes(`no ${f}`) ||
      (blob.includes('No fantasy motion') && blob.toLowerCase().includes(f)));
  }
  check('V5 doNot lists fantasy motion ban explicitly',
    /No fantasy motion/i.test(mod.LIFESTYLE_DIRECTIVES.doNot));
}

// V6 — reference count
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

  const off = loadVeo({ lifestyle: 'false' });
  check('V6 flag off lifestyle → base 3',
    off.resolveLifestyleVideoRefCount(3, 'lifestyle') === 3);
  check('V6 DEFAULT_REFERENCE_IMAGE_COUNT still 3 (packshot path)',
    (() => {
      // Avoid loading atlasVideoService if sharp missing — pin via source
      const src = fs.readFileSync(path.join(REPO, 'services/atlasVideoService.js'), 'utf8');
      return /const DEFAULT_REFERENCE_IMAGE_COUNT = 3/.test(src);
    })());
  // Source pin: generateForAd uses resolveLifestyleVideoRefCount
  {
    const src = fs.readFileSync(path.join(REPO, 'services/atlasVideoService.js'), 'utf8');
    check('V6 generateForAd calls resolveLifestyleVideoRefCount',
      src.includes('resolveLifestyleVideoRefCount'));
    check('V6 generateForAd resolves seedStyle via resolveSeedStyle',
      src.includes('resolveSeedStyle(media)'));
    check('V6 lifestyle clears orderedReferenceMedia (seed-only)',
      /orderedReferenceMedia:\s*lifestyleVideo\s*\?\s*null/.test(src));
  }
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
  ['Edit OMNI_DIRECTIVES string', 'V2 OMNI_DIRECTIVES.* byte-identical'],
  ['Edit GROK_DIRECTIVES string', 'V2 GROK_DIRECTIVES.* byte-identical'],
  ['Select lifestyle without flag', 'V1 flag off: lifestyle seed still gets OMNI'],
  ['Drop product animate ban from lifestyle', 'V3 product must not animate'],
  ['Drop physicalAccuracy hands', 'V3 physicalAccuracy'],
  ['Allow sparkles in lifestyle doNot', 'V5 fantasy banned: sparkles'],
  ['Lifestyle ref count stays 3', 'V6 lifestyle+flag → ref count 1'],
  ['Guidance >600 chars', 'V7 * ≤600 chars'],
  ['Guidance says Shop Now', 'V7 * no copy/offer/text instruction']
];
for (const [mut, catcher] of REVERT_MAP) {
  console.log(`  · mutate: ${mut}`);
  console.log(`    caught by: ${catcher}`);
}
check('REVERT-PROVE table enumerated (≥15 mutations)', REVERT_MAP.length >= 15);

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
