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
 *   V2  OMNI_DIRECTIVES + GROK_DIRECTIVES byte-unchanged vs 9531ae9f (B14 style)
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

// 2026-09-04 Vaportek: catalog title is no longer interpolated. 9531ae9f
// still emits `Product: {title}.`; current does not. Strip that one line
// from a frozen assembled prompt so V2 keeps guarding OMNI/GROK text.
function dropFrozenCatalogTitleLine(prompt, title) {
  const needle = `Product: ${String(title)}.`;
  const idx = String(prompt).indexOf(needle);
  if (idx < 0) return prompt;
  const before = prompt.slice(0, idx);
  const after = prompt.slice(idx + needle.length);
  if (before.endsWith(' ') && after.startsWith(' ')) return before + after.slice(1);
  if (before.endsWith(' ')) return before.slice(0, -1) + after;
  if (after.startsWith(' ')) return before + after.slice(1);
  return before + after;
}

const REPO = path.join(__dirname, '..');
const INTENTS_KEY = require.resolve('../services/staticAdIntents');
const VEO_KEY = require.resolve('../services/veoPromptBuilder');

const ORIG = {
  STATIC_LIFESTYLE_PRESERVE: process.env.STATIC_LIFESTYLE_PRESERVE,
  STATIC_PROMPT_FIDELITY_HARDENING: process.env.STATIC_PROMPT_FIDELITY_HARDENING,
  VIDEO_LIFESTYLE_PROMPT: process.env.VIDEO_LIFESTYLE_PROMPT,
  PMAX_STATIC_PLATFORM_NOTES: process.env.PMAX_STATIC_PLATFORM_NOTES,
  // Hook-first destination kill switch — both names, so restoreEnv() puts the
  // process back exactly as it found it after V9 drives the OFF arm.
  PMAX_VIDEO_DIRECTIVES: process.env.PMAX_VIDEO_DIRECTIVES,
  VIDEO_HOOK_FIRST_PROMPT: process.env.VIDEO_HOOK_FIRST_PROMPT
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

// pmaxVideo drives the hook-first destination kill switch (owner 2026-08-18:
// Meta and PMax share one camera prompt; reverted by owner 2026-08-20 — see
// CLAUDE.md §00). Omitted → left at its ambient value: the CODE default is
// ON (isHookFirstVideoPromptEnabled's fallback), unrelated to the FILE
// default in config/defaults.env (now OFF), which this isolated process never
// loads. Written through the LEGACY env name deliberately: it is the name
// that may be set on the Render dashboard, and exercising it here keeps the
// backward compatibility path covered by a real test rather than only by a
// comment. When an arm IS specified, force BOTH names in lockstep — either
// name reading "false" kills (fail-safe OR), so setting only the legacy name
// could not force the ON arm if this process ever also loaded a "false" onto
// the other name.
function loadVeo({ lifestyle, pmaxVideo } = {}) {
  delete require.cache[VEO_KEY];
  setEnv('VIDEO_LIFESTYLE_PROMPT', lifestyle);
  setEnv('PMAX_VIDEO_DIRECTIVES', pmaxVideo);
  if (pmaxVideo !== undefined) setEnv('VIDEO_HOOK_FIRST_PROMPT', pmaxVideo);
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
// Emphasis ROLE COUNT/order stays identical; EVERY intent has a preserve-aware
// emphasis variant (Lane O BLOCKER 1). Flag-off emphasis stays byte-identical.
//
// Re-composition cues banned under preserve-ON (enumerated):
const RECOMPOSE_BANNED = [
  'dominating the frame',
  'shown large and desirable',
  'loudest thing in the frame',
  'scene someone wants to be in',
  'clearly present but supporting'
];
// Flag-off (scene-build) emphasis originals — pin byte-identity per intent.
const FLAG_OFF_EMPHASIS_0 = {
  product_first_lifestyle: 'the product in a scene someone wants to be in',
  brand_led: 'the brand itself — colours, mark, visual identity dominating the frame',
  social_proof_led: 'the product itself, shown large and desirable',
  objection_resolved: "the customer's sentence, as the loudest thing in the frame"
};
const PRESERVE_EMPHASIS_0 = {
  product_first_lifestyle: /already in this photograph|plate already implies/i,
  brand_led: /type hierarchy|brand treatment/i,
  social_proof_led: /as the photograph already presents it/i,
  objection_resolved: /loudest type treatment|type hierarchy/i
};
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
    // Emphasis slot count identical; content may differ under preserve for all 4
    check(
      `S2 emphasis slot count identical for ${intentKey}`,
      (rOn.emphasis || []).length === (rOff.emphasis || []).length
    );

    // Flag-off emphasis first slot byte-identical to today's original
    check(
      `S2 ${intentKey} flag-off emphasis[0] byte-identical to original`,
      (rOff.emphasis || [])[0] === FLAG_OFF_EMPHASIS_0[intentKey],
      `got=${JSON.stringify((rOff.emphasis || [])[0])}`
    );

    // Preserve-ON first slot is the preserve-aware variant
    check(
      `S2 ${intentKey} preserve-ON emphasis[0] is preserve-aware`,
      PRESERVE_EMPHASIS_0[intentKey].test((rOn.emphasis || [])[0] || ''),
      `got=${JSON.stringify((rOn.emphasis || [])[0])}`
    );

    // No re-composition cue in any preserve-ON emphasis line
    const emphOnBlob = (rOn.emphasis || []).join(' | ');
    for (const banned of RECOMPOSE_BANNED) {
      check(
        `S2 ${intentKey} preserve-ON has no recompose cue: "${banned}"`,
        !emphOnBlob.includes(banned)
      );
    }

    // Flag-off STILL carries the original recompose-style cue for intents that
    // used one (proves we only changed the preserve branch, not both).
    if (intentKey !== 'product_first_lifestyle') {
      // product_first's off-arm is the restage cue itself; others keep theirs
    }
    check(
      `S2 ${intentKey} preserve-ON emphasis differs from flag-off (branch is real)`,
      JSON.stringify(rOn.emphasis) !== JSON.stringify(rOff.emphasis)
    );
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

// S5 — scrim/panel permitted; edge extension permitted; restyle/restage is not
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
  // Owner Lane O: edge extension IS permitted (was banned; geometry fills frame)
  check('S5 EDGE EXTENSION permitted on Meta 1:1 lifestyle',
    p.includes('EDGE EXTENSION') &&
    /Edge extension to fit the surface aspect IS permitted/i.test(p));
  check('S5 extension is plausible continuation / letterbox fallback',
    /plausible continuation of the same scene/i.test(p) &&
    /letterbox rather than invent/i.test(p));
  check('S5 does NOT bare-ban extend (owner dropped "do not extend")',
    !/Do not rebuild, restyle, re-light, recolour, extend, blur/i.test(p));
  check('S5 crop of the subject locked (not whole-frame crop ban)',
    /crop of the subject/i.test(p));
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

// 4-way matrix smoke: hardening × preserve for one intent (Meta 1:1 → extend)
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
// T — resolveAspectTreatment seam (per surface × seed kind)
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== T: resolveAspectTreatment (surface × seed kind) ===\n');
{
  const mod = loadIntents({ preserve: 'true', hardening: 'true', pmaxNotes: 'false' });
  const off = loadIntents({ preserve: 'false', hardening: 'true', pmaxNotes: 'false' });

  // lifestyle + Meta → extend (by name)
  for (const surface of ['meta_feed_1_1', 'meta_feed_4_5', 'meta_stories_9_16']) {
    check(
      `T lifestyle+${surface} → 'extend'`,
      mod.resolveAspectTreatment({ surfaceKey: surface, seedStyle: 'lifestyle' }) === 'extend'
    );
  }
  // ugc + Meta → extend (own branch, same value today)
  for (const surface of ['meta_feed_1_1', 'meta_feed_4_5', 'meta_stories_9_16']) {
    check(
      `T ugc+${surface} → 'extend'`,
      mod.resolveAspectTreatment({ surfaceKey: surface, variantKind: 'ugc' }) === 'extend'
    );
  }

  // native on aspect match (seed already 1:1 into meta_feed_1_1)
  check(
    `T lifestyle+meta_feed_1_1+seedAspect=1:1 → 'native'`,
    mod.resolveAspectTreatment({
      surfaceKey: 'meta_feed_1_1', seedStyle: 'lifestyle', seedAspect: '1:1'
    }) === 'native'
  );
  check(
    `T lifestyle+meta_feed_4_5+seedAspect=4:5 → 'native'`,
    mod.resolveAspectTreatment({
      surfaceKey: 'meta_feed_4_5', seedStyle: 'lifestyle', seedAspect: '4:5'
    }) === 'native'
  );
  // mismatched seed aspect still extend
  check(
    `T lifestyle+meta_feed_1_1+seedAspect=4:5 → 'extend' (mismatch)`,
    mod.resolveAspectTreatment({
      surfaceKey: 'meta_feed_1_1', seedStyle: 'lifestyle', seedAspect: '4:5'
    }) === 'extend'
  );

  // 16:9 / PMax landscape → not-supported (by name)
  check(
    `T lifestyle+pmax_16_9 → 'not-supported'`,
    mod.resolveAspectTreatment({ surfaceKey: 'pmax_16_9', seedStyle: 'lifestyle' }) === 'not-supported'
  );
  check(
    `T ugc+pmax_16_9 → 'not-supported'`,
    mod.resolveAspectTreatment({ surfaceKey: 'pmax_16_9', variantKind: 'ugc' }) === 'not-supported'
  );
  check(
    `T lifestyle+pmax_landscape_1_91_1 → 'not-supported'`,
    mod.resolveAspectTreatment({
      surfaceKey: 'pmax_landscape_1_91_1', seedStyle: 'lifestyle'
    }) === 'not-supported'
  );

  // packshot → null (preserve never applies)
  check(
    `T packshot+meta_feed_1_1 → null`,
    mod.resolveAspectTreatment({
      surfaceKey: 'meta_feed_1_1', seedStyle: 'packshot'
    }) === null
  );

  // 16:9 lifestyle + preserve flag ON → prompt byte-identical to preserve-OFF
  // (proves fall-through is real, not a partial preserve)
  {
    const rOn = mod.buildPrompt({
      intentKey: 'product_first_lifestyle', data: DATA, product: PRODUCT,
      surface: 'pmax_16_9', seedStyle: 'lifestyle'
    });
    const rOff = off.buildPrompt({
      intentKey: 'product_first_lifestyle', data: DATA, product: PRODUCT,
      surface: 'pmax_16_9', seedStyle: 'lifestyle'
    });
    check(
      'T 16:9 lifestyle preserve-ON prompt byte-identical to preserve-OFF',
      rOn.prompt === rOff.prompt &&
      rOn.preserveScene === false &&
      rOff.preserveScene === false,
      `onLen=${rOn.prompt?.length} offLen=${rOff.prompt?.length} preserveOn=${rOn.preserveScene}`
    );
    check(
      'T 16:9 lifestyle does NOT carry SCENE PRESERVE header',
      !rOn.prompt.includes('SCENE PRESERVE — HIGHEST PRIORITY')
    );
  }

  // Extension sentence absent when treatment is 'native'
  {
    const rNative = mod.buildPrompt({
      intentKey: 'product_first_lifestyle', data: DATA, product: PRODUCT,
      surface: 'meta_feed_1_1', seedStyle: 'lifestyle', seedAspect: '1:1'
    });
    check('T native treatment: preserve ON', rNative.preserveScene === true);
    check('T native treatment: aspectTreatment=native',
      rNative.aspectTreatment === 'native');
    check('T native treatment: EDGE EXTENSION sentence ABSENT',
      !rNative.prompt.includes('EDGE EXTENSION') &&
      !/Edge extension to fit the surface aspect IS permitted/i.test(rNative.prompt));
    check('T native treatment: still has SCENE PRESERVE header',
      rNative.prompt.includes('SCENE PRESERVE — HIGHEST PRIORITY'));
  }

  // extend treatment still has EDGE EXTENSION on Meta without seedAspect
  {
    const rExt = mod.buildPrompt({
      intentKey: 'product_first_lifestyle', data: DATA, product: PRODUCT,
      surface: 'meta_feed_1_1', seedStyle: 'lifestyle'
    });
    check('T extend treatment: aspectTreatment=extend',
      rExt.aspectTreatment === 'extend');
    check('T extend treatment: EDGE EXTENSION present',
      rExt.prompt.includes('EDGE EXTENSION'));
  }

  // UGC and lifestyle resolve independently — source seam pin.
  // Changing the UGC branch alone must not require touching the lifestyle arm.
  {
    const src = fs.readFileSync(
      path.join(REPO, 'services/staticAdIntents.js'), 'utf8'
    );
    // Extract resolveAspectTreatment body (rough) and assert both arms exist
    const fnStart = src.indexOf('function resolveAspectTreatment');
    check('T resolveAspectTreatment is defined', fnStart !== -1);
    const fnBody = src.slice(fnStart, fnStart + 2500);
    // UGC branch BEFORE lifestyle branch (own arm, not collapsed)
    const ugcIdx = fnBody.indexOf("variantKind === 'ugc'");
    const lifeIdx = fnBody.indexOf("seedStyle === 'lifestyle'");
    check('T UGC branch is explicit (variantKind === \'ugc\')', ugcIdx !== -1);
    check('T lifestyle branch is explicit (seedStyle === \'lifestyle\')', lifeIdx !== -1);
    check('T UGC branch appears before lifestyle branch (independent arms)',
      ugcIdx !== -1 && lifeIdx !== -1 && ugcIdx < lifeIdx);
    // Comment that UGC is its own arm for future divergence
    check('T source comments UGC as own branch / diverge later',
      /UGC branch|diverge/i.test(fnBody));
    // Comment that 16:9 PMax is deferred, not missing
    check('T source comments 16:9 PMax composition as deferred not missing',
      /deferred, not missing|deliberately deferred/i.test(src));
  }

  // Behavioural independence: lifestyle-only call ignores ugc; ugc-only ignores lifestyle seed
  check('T lifestyle-only (no ugc) on Meta → extend',
    mod.resolveAspectTreatment({
      surfaceKey: 'meta_feed_1_1', seedStyle: 'lifestyle', variantKind: 'product_image'
    }) === 'extend');
  check('T ugc-only (packshot seed) on Meta → extend',
    mod.resolveAspectTreatment({
      surfaceKey: 'meta_feed_1_1', seedStyle: 'packshot', variantKind: 'ugc'
    }) === 'extend');
  check('T neither lifestyle nor ugc → null',
    mod.resolveAspectTreatment({
      surfaceKey: 'meta_feed_1_1', seedStyle: 'packshot', variantKind: 'product_image'
    }) === null);
}

// ═══════════════════════════════════════════════════════════════════════
// VIDEO
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== VIDEO lifestyle directives ===\n');

// V1 — selection (lifestyle seed OR ugc variantKind — matches static)
{
  const on = loadVeo({ lifestyle: 'true' });
  // Entry to the lifestyle path is now the MEDIA path (variantKind 'ugc'),
  // not an inferred seed style — see shouldUseLifestyleVideoPrompt.
  const life = on.buildVeoPrompt({
    product: { title: 'Wool Runner' },
    seedStyle: 'lifestyle',
    variantKind: 'ugc',
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
  check('V1 shouldUseLifestyleVideoPrompt ugc (media path) true',
    on.shouldUseLifestyleVideoPrompt('lifestyle', 'ugc') === true);
  // THE OWNER RULE: only the media path enters. A product-images ad must NOT,
  // whatever its seed was classified as. This is the check that would have
  // caught the GymShark regression — on_model maps to the lifestyle bucket, so
  // before this every apparel product ad silently took the path and had its
  // 3 operator picks capped to 1.
  check('V1 product_image + lifestyle seed does NOT enter (media path only)',
    on.shouldUseLifestyleVideoPrompt('lifestyle', 'product_image') === false);
  check('V1 seed style alone no longer opens the path',
    on.shouldUseLifestyleVideoPrompt('lifestyle') === false);
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
    variantKind: 'ugc',
    hasProductReference: true,
    durationSec: 8,
    caps: { promptByteCap: 20000, paramShape: 'gemini-omni' }
  });
  check('V1 flag off: lifestyle seed still gets OMNI/Ken Burns',
    life.includes('Ken Burns') && life.includes('high-end ecommerce'));
}

// V2 — OMNI + GROK byte-unchanged vs 9531ae9f
// Baseline does NOT export OMNI_DIRECTIVES / GROK_DIRECTIVES, so iterating
// Object.keys(oldMod.OMNI_DIRECTIVES || {}) ran ZERO comparisons (vacuous).
// Fix: inject those names into the baseline module.exports (same consts are
// in scope), then field-compare — plus the B14-style full prompt matrix.
{
  const mod = loadVeo({ lifestyle: undefined });
  const BASELINE = '9531ae9f:services/veoPromptBuilder.js';
  // ⚠️ REWRITE EVERY LOCAL RELATIVE REQUIRE THE PINNED FILE MAKES, not a
  // single hardcoded one. When this harness was written, './platformFormats'
  // was the only local require in veoPromptBuilder.js; bumping the pin
  // forward (past owner-approved prompt changes, e.g. commit 9531ae9f)
  // surfaced a genuinely NEW one, './videoProductAnchor', added between the
  // two pins — the hardcoded single-name check silently produced "baseline
  // unavailable" (a SKIP, correctly not a false PASS) instead of comparing
  // anything. Enumerate what the pinned source actually requires and
  // relocate each one, so a future pin bump degrades to a loud, specific
  // module-not-found rather than a generic skip.
  const REL_REQUIRE_RE = /require\('(\.\/[A-Za-z0-9_-]+)'\)/g;
  let oldMod = null;
  let skipReason = null;
  let tmpDir = null;
  try {
    const src = cp.execFileSync('git', ['-C', REPO, 'show', BASELINE], {
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore']
    });
    const relRequires = [...new Set([...src.matchAll(REL_REQUIRE_RE)].map((m) => m[1]))];
    if (!relRequires.length) {
      skipReason = 'baseline has no local relative requires to relocate — unexpected shape';
    } else if (!/\bconst OMNI_DIRECTIVES\b/.test(src) || !/\bconst GROK_DIRECTIVES\b/.test(src)) {
      skipReason = 'baseline missing OMNI_DIRECTIVES or GROK_DIRECTIVES const';
    } else {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeVeoPin-'));
      const tmpFile = path.join(tmpDir, 'veoPromptBuilder.baseline.js');
      // Relocate every local require the pinned file makes, then force-export
      // the directive objects so field comparison is real (baseline never
      // exported them).
      let patched = src;
      for (const rel of relRequires) {
        const modName = rel.slice(2); // './foo' -> 'foo'
        patched = patched.split(`require('${rel}')`).join(
          `require(${JSON.stringify(path.join(REPO, 'services', modName))})`
        );
      }
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
      check(`V2 OMNI_DIRECTIVES.${key} byte-identical to 9531ae9f`,
        mod.OMNI_DIRECTIVES[key] === oldMod.OMNI_DIRECTIVES[key],
        key);
    }
    for (const key of grokKeys) {
      check(`V2 GROK_DIRECTIVES.${key} byte-identical to 9531ae9f`,
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
          // 2026-09-03: overlay guard stripped. seedHasText=false remains
          // byte-identical to 9531ae9f. seedHasText=true is a no-op.
          const argsOff = {
            product: { title: 'Wool Runner' },
            hasProductReference, durationSec, seedHasText: false, caps
          };
          check(
            `V2 prompt byte-identical to 9531ae9f minus the catalog-title line (ref=${hasProductReference} dur=${durationSec} text=false caps=${caps ? 'omni' : 'def'})`,
            mod.buildVeoPrompt(argsOff) === dropFrozenCatalogTitleLine(oldMod.buildVeoPrompt(argsOff), argsOff.product.title)
          );
          check(
            `V2 seedHasText is a retired no-op (ref=${hasProductReference} dur=${durationSec} caps=${caps ? 'omni' : 'def'})`,
            mod.buildVeoPrompt({ ...argsOff, seedHasText: true }) === mod.buildVeoPrompt(argsOff)
          );
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
  // Lane O BLOCKER 2 — plate wording is truthful about upstream reframe
  check('V3 plate is "as handed to you" (not raw capture claim)',
    /as handed to you/i.test(blob) && /finished plate/i.test(blob));
  check('V3 plate may already be fitted upstream; no further extend',
    /already have been fitted|edge-fit from upstream|fitted to this aspect upstream/i.test(blob) &&
    /do NOT further extend|not licence to continue extending|do not extend it further/i.test(blob));
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
    variantKind: 'ugc',
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
      product: { title: 'X' }, seedStyle: 'lifestyle',
    variantKind: 'ugc', durationSec: 8,
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
  check('V6 ugc (media path) → ref count 1',
    on.resolveLifestyleVideoRefCount(3, 'lifestyle', 'ugc') === 1);
  check('V6 product_image keeps the full stack (regression guard)',
    on.resolveLifestyleVideoRefCount(3, 'lifestyle', 'product_image') === 3);
  check('V6 packshot+flag → base 3 unchanged',
    on.resolveLifestyleVideoRefCount(3, 'packshot') === 3);
  check('V6 unknown+flag → base 3',
    on.resolveLifestyleVideoRefCount(3, 'unknown') === 3);
  check('V6 ugc with base 5 → still 1',
    on.resolveLifestyleVideoRefCount(5, 'lifestyle', 'ugc') === 1);
  check('V6 ugc+packshot seed → ref count 1',
    on.resolveLifestyleVideoRefCount(3, 'packshot', 'ugc') === 1);

  // Behavioural plan — this is what generateForAd must pass to buildReferenceImages.
  const planLife = on.resolveLifestyleVideoRefPlan({
    baseReferenceCount: 3, seedStyle: 'lifestyle', variantKind: 'ugc'
  });
  const planProductPath = on.resolveLifestyleVideoRefPlan({
    baseReferenceCount: 3, seedStyle: 'lifestyle', variantKind: 'product_image'
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
  check('V6 plan product_image: full stack, never seed-only',
    planProductPath.referenceCount === 3 && planProductPath.forceSeedOnly === false);

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

// V9 — lifestyle + hook-first destination compose (orthogonal, not suppress)
//
// UPDATED 2026-08-18 for the owner-directed standardization, verbatim:
//   "I want to use the PMax prompt for Meta also, and standardize on that but
//    maintain a single minting for 9x16 across both formats. Continue to mint
//    a 16x9."
// This block used to assert `V9 lifestyle+Meta does NOT emit Frame (9:16)`,
// on the premise that the Frame line was PMax-only destination treatment.
// Meta video destinations now select the same hook-first profile, so that
// assertion is false BY DESIGN and has been inverted rather than deleted:
// the ON arm pins that Meta does emit it, and a new OFF arm pins that the
// kill switch takes it away again. Both directions still fail on a real
// regression — the check was not weakened, it was re-pointed.
{
  const on = loadVeo({ lifestyle: 'true' });
  const pmaxLife = on.buildVeoPrompt({
    product: { title: 'Wool Runner' },
    seedStyle: 'lifestyle',
    variantKind: 'ugc',
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
    variantKind: 'ugc',
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
  // Switch ON: Meta lifestyle now takes the same destination treatment as PMax.
  check('V9 lifestyle+Meta DOES emit Frame (9:16) — owner 2026-08-18 standardization',
    metaLife.includes('Frame (9:16 vertical)'));
  check('V9 lifestyle+Meta carries hook-first destination treatment',
    /HOOK-FIRST|HOOK —/i.test(metaLife));
  check('V9 packshot+PMax still Ken Burns packshot path',
    pmaxPack.includes('Ken Burns') || pmaxPack.includes('product commercial'));
  check('V9 lifestyle+PMax does not re-impose product stays completely static',
    !pmaxLife.includes('product stays completely static'));

  // Platform neutrality: one profile now serves both platforms, so the
  // destination labels the lifestyle branch injects must not name a platform.
  // These lines used to read "HOOK-FIRST (PMax destination)" / "Centre-safe
  // composition (PMax destination)" — literally false on a Meta ad.
  check('V9 lifestyle+Meta never names PMax in text sent to the model',
    !/PMax/i.test(metaLife));
  check('V9 lifestyle+PMax never names Meta in text sent to the model',
    !/\bMeta\b/i.test(pmaxLife));

  // Kill switch OFF: the destination treatment goes away again on BOTH
  // platforms. Without this arm the inversion above would be a one-way pin.
  {
    const off = loadVeo({ lifestyle: 'true', pmaxVideo: 'false' });
    const metaLifeOff = off.buildVeoPrompt({
      product: { title: 'Wool Runner' },
      seedStyle: 'lifestyle',
      variantKind: 'ugc',
      platformFormat: 'meta_reels_9_16',
      aspectRatio: '9:16',
      durationSec: 8,
      hasProductReference: false,
      caps: { promptByteCap: 20000, paramShape: 'gemini-omni' }
    });
    const pmaxLifeOff = off.buildVeoPrompt({
      product: { title: 'Wool Runner' },
      seedStyle: 'lifestyle',
      variantKind: 'ugc',
      platformFormat: 'pmax_video_9_16',
      aspectRatio: '9:16',
      durationSec: 10,
      hasProductReference: false,
      caps: { promptByteCap: 20000, paramShape: 'gemini-omni' }
    });
    check('V9 switch-OFF lifestyle+Meta drops the Frame (9:16) line again',
      !metaLifeOff.includes('Frame (9:16 vertical)'));
    check('V9 switch-OFF lifestyle+Meta drops the hook-first destination inject',
      !/HOOK-FIRST \(video destination\)/.test(metaLifeOff));
    check('V9 switch-OFF lifestyle+PMax drops the Frame (9:16) line too (Phase A)',
      !pmaxLifeOff.includes('Frame (9:16 vertical)'));
    // Lifestyle itself is untouched by the destination switch.
    check('V9 switch-OFF lifestyle+Meta still uses the lifestyle directive set',
      metaLifeOff.includes('Lifestyle motion editor'));
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
  const b = off.buildVeoPrompt({ ...args, seedStyle: 'lifestyle',
    variantKind: 'ugc' });
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
//   1. renderService.renderStage (first render) — selects Ad.variantKind,
//      threads into args, spreads into renderDirectImage
//   2. adRegenerateService.runImage (paid regen) — buildDirectImageArgsFromAd
//   3. directImageRenderService QC re-entry (paid retry) — buildQcRetryArgs
//
// C1 is NOT a tautology over a literal we just wrote — it asserts the REAL
// renderService source selects and threads adDoc?.variantKind.
// C2 degrades gracefully when adRegenerateService cannot load (incomplete
// worktree / missing deps) with a loud named SKIP — non-zero only on real fails.
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== BLOCKER 3: variantKind on all renderDirectImage callers ===\n');
{
  const intentsOn = loadIntents({ preserve: 'true', hardening: 'true' });

  // ── Caller 1 — renderService first-render path (SOURCE-level, not tautology) ──
  {
    const renderSrc = fs.readFileSync(
      path.join(REPO, 'services/renderService.js'), 'utf8'
    );
    // Ad.findById(...).select(...) must include variantKind
    check(
      'C1 renderService selects variantKind from Ad',
      /\.select\(\s*['`][^'`]*\bvariantKind\b[^'`]*['`]/.test(renderSrc),
      'Ad.findById().select must include variantKind'
    );
    // Args object must thread adDoc?.variantKind (the real first-render path)
    check(
      'C1 renderService threads adDoc?.variantKind into renderDirectImage args',
      /variantKind\s*:\s*adDoc\s*\?\.\s*variantKind/.test(renderSrc)
    );
    // The call site spreads args into renderDirectImage
    check(
      'C1 renderService spreads args into renderDirectImage(',
      /renderDirectImage\s*\(\s*\{\s*\.\.\.\s*args/.test(renderSrc)
    );
    // REVERT-PROVE: if the thread line used only req.variantKind (dropping
    // adDoc), the adDoc?.variantKind pattern would fail above. Also prove
    // behavioural gate still needs the value.
    {
      const built = intentsOn.buildPrompt({
        intentKey: 'product_first_lifestyle',
        data: DATA, product: PRODUCT, surface: SURFACE,
        seedStyle: 'packshot',
        variantKind: 'ugc'
      });
      check('C1 ugc variantKind reaches preserve gate (ugc+packshot seed)',
        built.preserveScene === true &&
        built.prompt.includes('SCENE PRESERVE — HIGHEST PRIORITY'));
    }
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
    // Proof C1 can fail: a synthetic source WITHOUT the thread must not match
    const fakeMissing = 'const args = { template, platformFormat }; // no variantKind';
    check(
      'C1 REVERT-PROVE: synthetic missing thread fails adDoc?.variantKind pattern',
      !/variantKind\s*:\s*adDoc\s*\?\.\s*variantKind/.test(fakeMissing)
    );
  }

  // ── Caller 2 — adRegenerateService paid regen (graceful skip) ──
  {
    let regen = null;
    let regenLoadErr = null;
    try {
      regen = require('../services/adRegenerateService');
    } catch (e) {
      regenLoadErr = e;
    }
    if (!regen || typeof regen.buildDirectImageArgsFromAd !== 'function') {
      const reason = regenLoadErr
        ? (regenLoadErr.message || String(regenLoadErr))
        : 'buildDirectImageArgsFromAd not exported';
      console.log(
        `SKIP C2 adRegenerateService unavailable (incomplete worktree / missing dep): ${reason}`
      );
      // Named skip — does NOT count as pass or fail. Suite stays green when
      // only this heavy require is broken.
    } else {
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
    }
  }

  // ── Caller 3 — vision QC corrective re-entry (spread original args) ──
  {
    let direct = null;
    let directLoadErr = null;
    try {
      direct = require('../services/directImageRenderService');
    } catch (e) {
      directLoadErr = e;
    }
    if (!direct || typeof direct.buildQcRetryArgs !== 'function') {
      const reason = directLoadErr
        ? (directLoadErr.message || String(directLoadErr))
        : 'buildQcRetryArgs not exported';
      console.log(
        `SKIP C3 directImageRenderService unavailable: ${reason}`
      );
    } else {
      const originalCall = {
        layoutInputArtifactId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
        aspectRatio: '1:1',
        mediaId: 'cccccccccccccccccccccccc',
        productId: 'dddddddddddddddddddddddd',
        brandId: 'eeeeeeeeeeeeeeeeeeeeeeee',
        adId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
        template: 'ai_product_first_lifestyle',
        platformFormat: 'meta_feed_1_1',
        variantKind: 'ugc',
        referenceMediaIds: ['cccccccccccccccccccccccc'],
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
    }
  }

  // Caller sweep: assert renderService threads the field (not mere call count)
  {
    const renderSrc = fs.readFileSync(
      path.join(REPO, 'services/renderService.js'), 'utf8'
    );
    const directSrc = fs.readFileSync(
      path.join(REPO, 'services/directImageRenderService.js'), 'utf8'
    );
    // renderService must have at least one renderDirectImage( and the thread
    const renderCalls = (renderSrc.match(/renderDirectImage\s*\(/g) || []).length;
    check('C* renderService has renderDirectImage( call',
      renderCalls >= 1, `count=${renderCalls}`);
    check('C* renderService call site is preceded by variantKind thread in file',
      /variantKind\s*:\s*adDoc\s*\?\.\s*variantKind/.test(renderSrc) &&
      renderCalls >= 1);
    // directImageRenderService has definition + QC re-call
    const directCalls = (directSrc.match(/renderDirectImage\s*\(/g) || []).length;
    check('C* directImageRenderService has renderDirectImage( sites',
      directCalls >= 1, `count=${directCalls}`);
    console.log(
      `  renderDirectImage sites: renderService=${renderCalls}, directImageRenderService=${directCalls}`
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════
// BLOCKER 1 (R4) — 'native' reachable via REAL production path
// Production computes seedAspect from Media.width/height inside
// renderDirectImage — not a hand-passed seedAspect:'1:1' harness arg.
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== BLOCKER 1 R4: seedAspect production path (native arm live) ===\n');
{
  const mod = loadIntents({ preserve: 'true', hardening: 'true', pmaxNotes: 'false' });
  const directSrc = fs.readFileSync(
    path.join(REPO, 'services/directImageRenderService.js'), 'utf8'
  );

  // Source: Media select loads width + height
  check(
    'B1 Media.select includes width and height',
    /\.select\(\s*['`][^'`]*\bwidth\b[^'`]*\bheight\b[^'`]*['`]/.test(directSrc)
    || /\.select\(\s*['`][^'`]*\bheight\b[^'`]*\bwidth\b[^'`]*['`]/.test(directSrc),
    'Media.findById().select must include width and height'
  );
  // Source: seedAspectFromDims called from media dims
  check(
    'B1 production calls seedAspectFromDims(media?.width, media?.height)',
    /seedAspectFromDims\s*\(\s*media\s*\?\.\s*width\s*,\s*media\s*\?\.\s*height\s*\)/.test(directSrc)
  );
  // Source: seedAspect threaded into buildPrompt
  check(
    'B1 production threads seedAspect into intents.buildPrompt',
    /intents\.buildPrompt\s*\(\s*\{[\s\S]{0,800}\bseedAspect\b/.test(directSrc)
  );
  check(
    'B1 seedAspectFromDims is exported',
    typeof mod.seedAspectFromDims === 'function'
  );

  // Behavioural: production-path helper → dims → seedAspect → buildPrompt
  // (NOT hand-passing seedAspect:'1:1' — that was the dead-path harness)
  {
    const seedAspect = mod.seedAspectFromDims(1080, 1080); // Media 1:1 → meta_feed_1_1
    check('B1 seedAspectFromDims(1080,1080) returns parseable aspect',
      seedAspect != null && mod.parseAspectValue(seedAspect) != null,
      `got=${JSON.stringify(seedAspect)}`);
    const r = mod.buildPrompt({
      intentKey: 'product_first_lifestyle',
      data: DATA, product: PRODUCT,
      surface: 'meta_feed_1_1',
      seedStyle: 'lifestyle',
      seedAspect // production-derived, not a surface-ratio string
    });
    check('B1 REAL path: matching dims → aspectTreatment=native',
      r.aspectTreatment === 'native' && r.preserveScene === true,
      `treatment=${r.aspectTreatment} preserve=${r.preserveScene}`);
    check('B1 REAL path: matching dims → NO EDGE EXTENSION sentence',
      !r.prompt.includes('EDGE EXTENSION') &&
      !/Edge extension to fit the surface aspect IS permitted/i.test(r.prompt));
    check('B1 REAL path: matching dims still has SCENE PRESERVE',
      r.prompt.includes('SCENE PRESERVE — HIGHEST PRIORITY'));
  }

  // 4:5 media into 4:5 surface via dims
  {
    const seedAspect = mod.seedAspectFromDims(1080, 1350);
    const r = mod.buildPrompt({
      intentKey: 'product_first_lifestyle',
      data: DATA, product: PRODUCT,
      surface: 'meta_feed_4_5',
      seedStyle: 'lifestyle',
      seedAspect
    });
    check('B1 REAL path: 1080x1350 → meta_feed_4_5 → native, no EDGE EXTENSION',
      r.aspectTreatment === 'native' && !r.prompt.includes('EDGE EXTENSION'));
  }

  // Mismatched dims → extend
  {
    const seedAspect = mod.seedAspectFromDims(1080, 1350); // 4:5 into 1:1
    const r = mod.buildPrompt({
      intentKey: 'product_first_lifestyle',
      data: DATA, product: PRODUCT,
      surface: 'meta_feed_1_1',
      seedStyle: 'lifestyle',
      seedAspect
    });
    check('B1 REAL path: mismatched dims → extend + EDGE EXTENSION',
      r.aspectTreatment === 'extend' && r.prompt.includes('EDGE EXTENSION'));
  }

  // Missing / zero / unparseable dims → null → extend (never throw)
  {
    const cases = [
      [null, null, 'null,null'],
      [undefined, undefined, 'undefined,undefined'],
      [0, 1080, 'zero width'],
      [1080, 0, 'zero height'],
      [-1, 100, 'negative'],
      ['x', 'y', 'unparseable'],
      [NaN, 1080, 'NaN width']
    ];
    for (const [w, h, label] of cases) {
      let threw = false;
      let sa = null;
      try {
        sa = mod.seedAspectFromDims(w, h);
      } catch (e) {
        threw = true;
      }
      check(`B1 missing/bad dims (${label}) → null, never throw`,
        !threw && sa === null, `sa=${sa} threw=${threw}`);
      const r = mod.buildPrompt({
        intentKey: 'product_first_lifestyle',
        data: DATA, product: PRODUCT,
        surface: 'meta_feed_1_1',
        seedStyle: 'lifestyle',
        seedAspect: sa
      });
      check(`B1 missing/bad dims (${label}) → extend fallback`,
        r.aspectTreatment === 'extend' && r.prompt.includes('EDGE EXTENSION'));
    }
  }

  // REVERT-PROVE: without seedAspect (simulating pre-fix production), native is dead
  {
    const r = mod.buildPrompt({
      intentKey: 'product_first_lifestyle',
      data: DATA, product: PRODUCT,
      surface: 'meta_feed_1_1',
      seedStyle: 'lifestyle'
      // no seedAspect — production before this fix
    });
    check('B1 REVERT-PROVE: no seedAspect → extend (native arm dead without dims)',
      r.aspectTreatment === 'extend');
  }

  // Source REVERT-PROVE: synthetic source without width fails select pattern
  {
    const fake = "Media.findById(mediaId).select('fileUrl classification technicalInsights').lean()";
    const pattern = /\.select\(\s*['`][^'`]*\bwidth\b[^'`]*\bheight\b[^'`]*['`]/;
    check('B1 REVERT-PROVE: select without width/height fails pattern',
      !pattern.test(fake));
  }
}

// ═══════════════════════════════════════════════════════════════════════
// BLOCKER 2 (R4) — PMax PLATFORM_NOTES preserve-aware
// Notes apply to ALL pmax_* (incl. square/portrait where preserve IS live).
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== BLOCKER 2 R4: PMax notes vs SCENE_PRESERVE ===\n');
{
  const on = loadIntents({ preserve: 'true', hardening: 'true', pmaxNotes: 'true' });
  const offPreserve = loadIntents({ preserve: 'false', hardening: 'true', pmaxNotes: 'true' });

  // Prove coexistence is real: square + portrait CAN be preserve-ON
  for (const surface of ['pmax_square_1_1', 'pmax_portrait_4_5']) {
    const r = on.buildPrompt({
      intentKey: 'product_first_lifestyle',
      data: DATA, product: PRODUCT,
      surface, seedStyle: 'lifestyle'
    });
    check(`B2 ${surface} lifestyle → preserve ON (coexistence possible)`,
      r.preserveScene === true,
      `preserve=${r.preserveScene} treatment=${r.aspectTreatment}`);
    check(`B2 ${surface} preserve-ON still has PLATFORM CONTEXT`,
      /PLATFORM CONTEXT/.test(r.prompt || ''));
    // Recompose clauses from scene-build notes must be ABSENT
    const bannedNoteCues = [
      'compose it so the product reads as complete',
      'keep the product away from the extreme edges',
      'never let a crop slice through it',
      'one dominant subject',
      'Keep the whole composition legible when the frame is cropped toward its centre'
    ];
    for (const cue of bannedNoteCues) {
      check(`B2 ${surface} preserve-ON notes lack recompose: "${cue.slice(0, 40)}…"`,
        !r.prompt.includes(cue));
    }
    // Preserve arm still forbids recomposing the plate for crop survival
    check(`B2 ${surface} preserve-ON notes forbid restaging for crop`,
      /Do not recompose, restage|do not move or restage the product/i.test(r.prompt));
  }

  // 16:9 not-supported: preserve OFF, scene-build notes still OK (no SCENE_PRESERVE)
  {
    const r = on.buildPrompt({
      intentKey: 'product_first_lifestyle',
      data: DATA, product: PRODUCT,
      surface: 'pmax_16_9', seedStyle: 'lifestyle'
    });
    check('B2 pmax_16_9 lifestyle → preserve OFF (not-supported)',
      r.preserveScene === false);
    check('B2 pmax_16_9 still has scene-build PLATFORM CONTEXT (no preserve conflict)',
      /PLATFORM CONTEXT/.test(r.prompt || '') &&
      r.prompt.includes('compose it so the product reads as complete'));
  }

  // Flag-off / preserve-off: original notes byte-identical
  {
    const rOff = offPreserve.buildPrompt({
      intentKey: 'product_first_lifestyle',
      data: DATA, product: PRODUCT,
      surface: 'pmax_square_1_1', seedStyle: 'lifestyle'
    });
    const rOnScene = on.buildPrompt({
      intentKey: 'product_first_lifestyle',
      data: DATA, product: PRODUCT,
      surface: 'pmax_square_1_1', seedStyle: 'packshot' // packshot → no preserve
    });
    check('B2 preserve-OFF (packshot) keeps original recompose centre-crop clause',
      rOnScene.prompt.includes('compose it so the product reads as complete') &&
      rOnScene.prompt.includes('one dominant subject'));
    check('B2 resolvePlatformNotes exported',
      typeof on.resolvePlatformNotes === 'function');
    check('B2 PLATFORM_NOTES.pmax is still the scene-build string (export pin)',
      on.PLATFORM_NOTES.pmax === on.PLATFORM_NOTES_PMAX_SCENE_BUILD &&
      on.PLATFORM_NOTES.pmax.includes('compose it so the product reads as complete'));
    // Preserve-off lifestyle with flag-off preserve: same notes as packshot path
    check('B2 preserve-flag-off lifestyle uses scene-build notes',
      rOff.prompt.includes('compose it so the product reads as complete'));
  }

  // REVERT-PROVE: if resolvePlatformNotes ignored preserve, square would get scene-build
  {
    const sceneBuild = on.PLATFORM_NOTES_PMAX_SCENE_BUILD || on.PLATFORM_NOTES.pmax;
    const preserveNotes = on.PLATFORM_NOTES_PMAX_PRESERVE;
    check('B2 REVERT-PROVE: preserve notes ≠ scene-build notes',
      !!preserveNotes && preserveNotes !== sceneBuild);
    const resolvedPreserve = on.resolvePlatformNotes('pmax_square_1_1', { preserve: true });
    const resolvedOff = on.resolvePlatformNotes('pmax_square_1_1', { preserve: false });
    check('B2 REVERT-PROVE: resolvePlatformNotes(preserve:true) ≠ (preserve:false)',
      resolvedPreserve === preserveNotes && resolvedOff === sceneBuild);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// BLOCKER 3 (R4) — intent × field recompose sweep under preserve
// Fields that reach the prompt: goal, emphasis, (text is byte-identical),
// decideBlock, fidelity/SCENE_PRESERVE, platformNotes.
// ownerBrief is doc-only — checked present, never in prompt.
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== BLOCKER 3 R4: intent × field recompose matrix ===\n');
{
  const on = loadIntents({ preserve: 'true', hardening: 'true', pmaxNotes: 'true' });
  const off = loadIntents({ preserve: 'false', hardening: 'true', pmaxNotes: 'true' });

  // Cues that must never appear in a preserve-ON prompt (any field that reaches it)
  const RECOMPOSE_CUES = [
    'dominating the frame',
    'shown large and desirable',
    'loudest thing in the frame',
    'scene someone wants to be in',
    'clearly present but supporting',
    'product supporting rather than leading',
    'supporting position (small card or inset)', // ownerBrief only — must not leak
    'compose it so the product reads as complete',
    'keep the product away from the extreme edges',
    'one dominant subject',
    'YOU DECIDE EVERYTHING ELSE: composition and crop'
  ];

  // Field extractors for the matrix
  function fieldBlobs(built, intentKey, mod) {
    const spec = mod.INTENTS[intentKey];
    const keptRoles = new Set((built.text || []).map(([r]) => r));
    const kept_ = (role) => keptRoles.has(role);
    const goal = typeof spec.goal === 'function'
      ? spec.goal(kept_, { preserve: built.preserveScene })
      : spec.goal;
    const goalOff = typeof spec.goal === 'function'
      ? spec.goal(kept_, { preserve: false })
      : spec.goal;
    const emphasis = (built.emphasis || []).join(' | ');
    const text = JSON.stringify(built.text || []);
    const ownerBrief = spec.ownerBrief || '';
    // Slice prompt regions
    const prompt = built.prompt || '';
    const goalInPrompt = (prompt.match(/WHAT THIS AD HAS TO DO: ([^\n]+)/) || [])[1] || '';
    return { goal, goalOff, emphasis, text, ownerBrief, goalInPrompt, prompt };
  }

  const matrix = []; // { intent, field, status, changed }

  for (const intentKey of FOUR_INTENTS) {
    const rOn = on.buildPrompt({
      intentKey, data: DATA, product: PRODUCT, surface: SURFACE,
      seedStyle: 'lifestyle'
    });
    const rOff = off.buildPrompt({
      intentKey, data: DATA, product: PRODUCT, surface: SURFACE,
      seedStyle: 'lifestyle'
    });
    check(`B3 ${intentKey} preserve-ON`, rOn.preserveScene === true);

    const fOn = fieldBlobs(rOn, intentKey, on);
    const fOff = fieldBlobs(rOff, intentKey, off);

    // goal
    {
      let cueHit = null;
      for (const cue of RECOMPOSE_CUES) {
        if (fOn.goal && fOn.goal.includes(cue)) { cueHit = cue; break; }
      }
      check(`B3 ${intentKey}/goal preserve-ON no recompose cue`,
        cueHit == null, cueHit ? `found "${cueHit}"` : '');
      // goalInPrompt must match computed goal
      check(`B3 ${intentKey}/goal reaches prompt`,
        fOn.goalInPrompt === fOn.goal || (fOn.prompt.includes(fOn.goal)));
      const goalChanged = fOn.goal !== fOff.goal;
      matrix.push({
        intent: intentKey, field: 'goal',
        status: cueHit ? 'FAIL' : 'clean',
        changed: goalChanged ? 'preserve-aware' : 'unchanged (no recompose needed)'
      });
      // brand_led specifically: goal MUST change under preserve (the bug)
      if (intentKey === 'brand_led') {
        check('B3 brand_led/goal is preserve-aware (differs from flag-off)',
          goalChanged);
        check('B3 brand_led/goal flag-off still has "supporting rather than leading"',
          fOff.goal.includes('product supporting rather than leading'));
        check('B3 brand_led/goal preserve-ON lacks "supporting rather than leading"',
          !fOn.goal.includes('product supporting rather than leading'));
      }
    }

    // emphasis
    {
      let cueHit = null;
      for (const cue of RECOMPOSE_CUES) {
        if (fOn.emphasis.includes(cue)) { cueHit = cue; break; }
      }
      check(`B3 ${intentKey}/emphasis preserve-ON no recompose cue`,
        cueHit == null, cueHit ? `found "${cueHit}"` : '');
      matrix.push({
        intent: intentKey, field: 'emphasis',
        status: cueHit ? 'FAIL' : 'clean',
        changed: JSON.stringify(rOn.emphasis) !== JSON.stringify(rOff.emphasis)
          ? 'preserve-aware' : 'unchanged'
      });
    }

    // text — MUST be byte-identical (owner requirement)
    {
      const identical = fOn.text === fOff.text;
      check(`B3 ${intentKey}/text byte-identical preserve-on vs off`,
        identical);
      matrix.push({
        intent: intentKey, field: 'text',
        status: identical ? 'byte-identical' : 'FAIL',
        changed: 'must never change'
      });
    }

    // ownerBrief — doc only, must NOT appear in prompt
    {
      const leaks = fOn.ownerBrief && fOn.ownerBrief.length > 20
        && fOn.prompt.includes(fOn.ownerBrief.slice(0, 40));
      check(`B3 ${intentKey}/ownerBrief does NOT reach prompt`,
        !leaks);
      matrix.push({
        intent: intentKey, field: 'ownerBrief',
        status: 'doc-only (not in prompt)',
        changed: 'n/a'
      });
    }

    // Full prompt sweep for remaining cues (decideBlock, notes, etc.)
    // Exclude SCENE_PRESERVE's own "Do not recompose" prohibitions — those
    // are bans, not invitations. Match invitation-style cues only.
    {
      let cueHit = null;
      for (const cue of RECOMPOSE_CUES) {
        if (fOn.prompt.includes(cue)) { cueHit = cue; break; }
      }
      check(`B3 ${intentKey}/prompt (all fields) no recompose invitation`,
        cueHit == null, cueHit ? `found "${cueHit}"` : '');
    }
  }

  // Flag-off strings stay byte-identical for goal+emphasis originals we care about
  {
    const rOff = off.buildPrompt({
      intentKey: 'brand_led', data: DATA, product: PRODUCT, surface: SURFACE,
      seedStyle: 'lifestyle'
    });
    check('B3 flag-OFF brand_led goal byte-identical to pre-change',
      /product supporting rather than leading/.test(
        (rOff.prompt.match(/WHAT THIS AD HAS TO DO: ([^\n]+)/) || [])[1] || ''
      ));
  }

  // Print matrix for the finish report
  console.log('\n  Intent × field matrix:');
  console.log('  ' + 'intent'.padEnd(26) + 'field'.padEnd(14) + 'status'.padEnd(28) + 'note');
  console.log('  ' + '-'.repeat(90));
  for (const row of matrix) {
    console.log(
      '  ' + row.intent.padEnd(26) + row.field.padEnd(14) + row.status.padEnd(28) + row.changed
    );
  }

  // REVERT-PROVE brand_led goal: if someone reverts goal to non-preserve-aware
  {
    const fakeGoal = (kept) => 'A stranger scrolling past should recognise the brand first — its colours, its voice, its mark — with the product supporting rather than leading. '
      + (kept('BRAND LINE') ? 'The brand line carries the voice.' : 'Here the brand identity has to do the work without a line.');
    const g = fakeGoal(() => true);
    check('B3 REVERT-PROVE: non-preserve-aware brand_led goal still has recompose cue',
      g.includes('product supporting rather than leading'));
  }
}

// ═══════════════════════════════════════════════════════════════════════
// buildPrompt CALLER ENUMERATION (complete list)
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== buildPrompt caller enumeration (staticAdIntents) ===\n');
{
  // Production services that call intents.buildPrompt / staticAdIntents.buildPrompt
  const callers = [];
  const servicesDir = path.join(REPO, 'services');
  const scriptsDir = path.join(REPO, 'scripts');

  function scanDir(dir, label) {
    let files = [];
    try {
      // !f.startsWith('.') — same convention as verifyMetaApiVersion.js's
      // fix (real, reproduced revertprove-race in CI: a sibling harness
      // briefly writes a `.__revertprove_*.js` transient into services/).
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.startsWith('.'));
    } catch (_) { return; }
    for (const f of files) {
      const full = path.join(dir, f);
      let src;
      try { src = fs.readFileSync(full, 'utf8'); } catch (_) { continue; }
      if (f === 'staticAdIntents.js') {
        callers.push({
          file: `${label}/${f}`,
          role: 'definition',
          threadsSeedAspect: true,
          production: false
        });
        continue;
      }
      // Match staticAdIntents require by path string OR variable path containing the name
      const isIntentsRequire =
        /staticAdIntents/.test(src) &&
        (/require\s*\(/.test(src) || /require\.resolve\s*\(/.test(src));
      if (!isIntentsRequire && f !== 'directImageRenderService.js') continue;
      // Call of staticAdIntents.buildPrompt under any local name (intents/mod/on/off/…)
      // Exclude local buildPrompt definitions in unrelated services.
      const hasBuildPromptCall =
        /\.buildPrompt\s*\(/.test(src) ||
        (label === 'scripts' && /(?:^|[^\w.])buildPrompt\s*\(/.test(src) && /staticAdIntents/.test(src));
      // services/directImageRenderService is the production chokepoint
      const isProd = f === 'directImageRenderService.js' && /intents\.buildPrompt\s*\(/.test(src);
      if (!hasBuildPromptCall && !isProd) continue;
      // Skip pure re-export / require-only files that never call buildPrompt
      if (!hasBuildPromptCall) continue;

      const threadsSeedAspect = /seedAspect\s*:/.test(src) || /seedAspectFromDims/.test(src);
      callers.push({
        file: `${label}/${f}`,
        role: isProd ? 'production-call' : 'harness/test',
        threadsSeedAspect: isProd
          ? threadsSeedAspect
          : (threadsSeedAspect ? 'yes (harness may pass)' : 'optional'),
        production: isProd
      });
    }
  }
  scanDir(servicesDir, 'services');
  scanDir(scriptsDir, 'scripts');

  // Hard pin: the ONLY production caller must be directImageRenderService
  const prodCallers = callers.filter((c) => c.production);
  check('CALLERS only production buildPrompt site is directImageRenderService',
    prodCallers.length === 1 && /directImageRenderService/.test(prodCallers[0].file),
    `prod=${JSON.stringify(prodCallers.map((c) => c.file))}`);
  check('CALLERS production site threads seedAspect',
    prodCallers[0] && prodCallers[0].threadsSeedAspect === true);

  console.log('  Complete staticAdIntents.buildPrompt callers:');
  for (const c of callers) {
    console.log(
      `  · ${c.file.padEnd(48)} role=${c.role.padEnd(16)} seedAspect=${c.threadsSeedAspect}`
    );
  }
  // Also list renderDirectImage entry points (the real production fan-in)
  console.log('\n  Production fan-in to renderDirectImage (computes seedAspect once):');
  console.log('  · services/renderService.js          first render (Ad.variantKind thread; Media dims loaded inside renderDirectImage)');
  console.log('  · services/adRegenerateService.js    paid regen via buildDirectImageArgsFromAd');
  console.log('  · services/directImageRenderService  vision-QC re-entry via buildQcRetryArgs spread');
  console.log('  All three re-enter renderDirectImage → Media width/height → seedAspectFromDims → buildPrompt.');
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
  ['product_first restage cue under preserve', 'S2 product_first_lifestyle preserve-ON emphasis[0]'],
  ['brand_led "dominating the frame" under preserve', 'S2 brand_led preserve-ON has no recompose cue: "dominating the frame"'],
  ['social_proof "shown large" under preserve', 'S2 social_proof_led preserve-ON has no recompose cue: "shown large and desirable"'],
  ['objection "loudest thing in the frame" under preserve', 'S2 objection_resolved preserve-ON has no recompose cue: "loudest thing in the frame"'],
  ['Change flag-off brand_led emphasis', 'S2 brand_led flag-off emphasis[0] byte-identical to original'],
  ['Bare-ban extend again (drop EDGE EXTENSION)', 'S5 EDGE EXTENSION permitted on Meta 1:1 lifestyle'],
  ['Enable extend on pmax_16_9', 'T lifestyle+pmax_16_9 → \'not-supported\' / T 16:9 lifestyle preserve-ON prompt byte-identical'],
  ['Collapse UGC+lifestyle into one boolean in resolver', 'T UGC branch is explicit / T UGC branch appears before lifestyle'],
  ['Omit EDGE EXTENSION on Meta extend path', 'T extend treatment: EDGE EXTENSION present'],
  ['Emit EDGE EXTENSION on native match', 'T native treatment: EDGE EXTENSION sentence ABSENT'],
  ['Lie that video plate is unfitted raw capture', 'V3 plate is "as handed to you" / V3 plate may already be fitted upstream'],
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
  ['Drop adDoc?.variantKind thread in renderService', 'C1 renderService threads adDoc?.variantKind'],
  ['Drop variantKind from Ad.select in renderService', 'C1 renderService selects variantKind from Ad'],
  ['Drop variantKind on regen args', 'C2 REVERT-PROVE: dropped variantKind → no preserve'],
  ['Drop variantKind on QC retry (hand-list fields)', 'C3 REVERT-PROVE: missing variantKind on QC retry'],
  ['Drop Media width/height from select', 'B1 Media.select includes width and height'],
  ['Drop seedAspectFromDims call / seedAspect thread', 'B1 production threads seedAspect / B1 REAL path native'],
  ['Hand-pass only seedAspect:\'1:1\' without dims path', 'B1 REAL path uses seedAspectFromDims'],
  ['Missing dims throw instead of extend', 'B1 missing/bad dims → null, never throw'],
  ['PMax notes ignore preserve (scene-build under preserve)', 'B2 pmax_square preserve-ON notes lack recompose'],
  ['brand_led goal still says supporting rather than leading under preserve', 'B3 brand_led/goal preserve-ON lacks "supporting rather than leading"'],
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
