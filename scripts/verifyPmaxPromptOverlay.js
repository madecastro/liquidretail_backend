#!/usr/bin/env node
'use strict';

/**
 * verifyPmaxPromptOverlay — Phase B PMax prompt overlay pins.
 *
 * Offline only: no DB, no network, no API key. Exercises the two kill
 * switches that gate destination-aware prompt work:
 *
 *   PMAX_STATIC_PLATFORM_NOTES  (staticAdIntents)  — default ON
 *   PMAX_VIDEO_DIRECTIVES       (veoPromptBuilder) — default OFF as of the
 *                               2026-08-20 owner revert (see V2c); was ON
 *                               2026-08-18..2026-08-20 (the standardization
 *                               below). The switch and both arms are
 *                               unchanged — only the shipped default flipped.
 *
 * Inventory
 * ─────────
 *   S0  Loader sanity — both arms load; invalidating BOTH staticAdIntents
 *       AND platformFormats is required (documented trap: one-module
 *       invalidation silently pins the wrong build).
 *   S1  BOTH-ARM META BYTE-IDENTITY (most important). Every Meta surface ×
 *       every intent × several data conditions: flag ON prompt === flag OFF
 *       prompt, byte-for-byte.
 *   S2  Flag OFF ⇒ no pmax prompt contains "PLATFORM CONTEXT".
 *   S3  Flag ON  ⇒ every live pmax static surface's prompt contains the
 *       platform-notes block, AFTER the FORMAT geometry block.
 *   S4  Platform notes never appear on any Meta surface, either arm.
 *   S5  resolveDrawCta truth table, both arms.
 *   V1  Switch ON  ⇒ Meta and PMax destination prompts are ONE identical
 *       prompt, and both differ from the destination-less prompt.
 *   V2  Switch OFF ⇒ BOTH Meta and PMax destination prompts collapse back to
 *       the destination-less prompt (Meta → frozen pre-#61, PMax → Phase A).
 *   V2b The switch honours BOTH env names and EITHER can kill — general OR-
 *       logic regression guard (new name true + legacy false, and vice
 *       versa), independent of whatever config/defaults.env currently ships.
 *   V2c config/defaults.env ships BOTH names as "false" (2026-08-20 owner
 *       revert) — the real production default, not simulated.
 *   V3  Destination-less prompt is byte-identical to the IMMUTABLE
 *       `134db56~1` baseline (B14 technique; relative requires rewritten so
 *       the temp copy resolves), in BOTH arms; plus the live Meta destination
 *       matches that baseline in the OFF arm and has moved in the ON arm.
 *   V4  Hook-first video content on BOTH platforms: hook-first, centre-safe,
 *       aspect Frame lines, platform-neutral text, 10s timeline arithmetic
 *       (3.33 / 6.40 / 10.0 — not hardcoded 8s).
 *
 * ── OWNER-DIRECTED STANDARDIZATION, 2026-08-18 (why V1/V2/V4 were rewritten)
 * Owner, verbatim: "I want to use the PMax prompt for Meta also, and
 * standardize on that but maintain a single minting for 9x16 across both
 * formats. Continue to mint a 16x9." The old V1/V2 pair read "flag ON ⇒ PMax
 * ≠ Meta / flag OFF ⇒ PMax === Meta" — the exact opposite of the intended
 * end state, and in any case both were comparing against a DESTINATION-LESS
 * prompt that no Meta ad ever receives (the fixture passed no platformFormat).
 * Both problems are fixed above. What is still frozen: the OFF arm, and the
 * OMNI_DIRECTIVES text itself.
 *
 * ── REVERT-PROOF RECIPE ──────────────────────────────────────────────────
 * Concrete mutations that MUST fail this harness (run against a COPY of the
 * source or an in-memory monkey-patch — do not leave services/ dirty):
 *
 *   1. Meta byte-identity: append "x" to PLATFORM_NOTES.pmax → S1 still
 *      passes (Meta untouched), but change destinationForSurface to always
 *      return 'pmax' → S1 FAILS (Meta gains PLATFORM CONTEXT under flag ON).
 *   2. Drop platform-notes append in buildPrompt (platformNotesBlock='')
 *      → S3 FAILS (live pmax missing PLATFORM CONTEXT under flag ON).
 *   3. resolveDrawCta always returns policy.drawCta (ignore intent)
 *      → S5 flag-ON pmax non-objection_resolved rows FAIL (expect false).
 *   4. PMAX_VIDEO_DIRECTIVES forced false inside isPmaxVideoDirectivesEnabled
 *      → V1 FAILS (PMax prompt no longer differs from Meta under "ON").
 *   5. Hardcode Timeline at 8.0s regardless of durationSec
 *      → V4 FAILS (durationSec=10 still shows 2.66/5.12/8.0).
 *   6. Drop the HOOK-FIRST sentence from PMAX_DIRECTIVES.objective
 *      → V4 hook-first content pin FAILS.
 *   7. Emit Frame (16:9 landscape) for every pmax aspect
 *      → V4 9:16 "does not claim landscape" pin FAILS.
 *
 * Run: node scripts/verifyPmaxPromptOverlay.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const REPO = path.join(__dirname, '..');
const INTENTS_PATH = path.join(REPO, 'services', 'staticAdIntents.js');
const PF_PATH = path.join(REPO, 'services', 'platformFormats.js');
const VEO_PATH = path.join(REPO, 'services', 'veoPromptBuilder.js');

let pass = 0;
let fail = 0;
const failures = [];

function check(label, actual, expected) {
  const ok = arguments.length === 2
    ? !!actual
    : JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    failures.push(label);
    if (arguments.length === 2) {
      console.log(`  ✗ ${label}`);
    } else {
      console.log(`  ✗ ${label}\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`);
    }
  }
}
const truthy = (label, v) => check(label, !!v, true);
const falsy = (label, v) => check(label, !!v, false);

const PRODUCT = {
  desc: "Men's seamless long-sleeve training top in HEATHER GREY-BLUE",
  look: 'high-contrast athletic editorial',
  logoCorner: 'bottom-right'
};

const DATA_CONDITIONS = {
  RICH: {
    rating: '4.8', reviewCount: '1,200+', quote: 'Fits true to size.',
    attribution: 'Verified Buyer', badge: 'TOP RATED',
    headline: 'BE A VISIONARY', cta: 'SHOP NOW'
  },
  THIN: {
    rating: '4.8', reviewCount: null, quote: null, attribution: null,
    badge: null, headline: 'BE A VISIONARY', cta: 'SHOP NOW'
  },
  BARE: {
    rating: null, reviewCount: null, quote: null, attribution: null,
    badge: null, headline: null, cta: 'SHOP NOW'
  },
  QUOTE_ONLY: {
    rating: null, reviewCount: null, quote: 'Fits true to size.',
    attribution: 'Verified Buyer', badge: null,
    headline: 'BE A VISIONARY', cta: 'SHOP NOW'
  },
  BRAND_FULL: {
    headline: 'Built for salt', subhead: 'Every tide.',
    rating: '4.8', cta: 'SHOP NOW'
  }
};

/**
 * CRITICAL: invalidate BOTH staticAdIntents AND platformFormats.
 * Invalidating only one is the documented silent-wrong-build trap
 * (see verifyBrandLedCopy.js header; same class).
 */
function loadStaticArm(flag) {
  delete require.cache[require.resolve(INTENTS_PATH)];
  delete require.cache[require.resolve(PF_PATH)];
  if (flag === undefined) delete process.env.PMAX_STATIC_PLATFORM_NOTES;
  else process.env.PMAX_STATIC_PLATFORM_NOTES = flag;
  return require(INTENTS_PATH);
}

function loadVeoArm(flag) {
  delete require.cache[require.resolve(VEO_PATH)];
  // veoPromptBuilder requires platformFormats — drop both so a fresh
  // builder cannot hold a stale nested module either.
  delete require.cache[require.resolve(PF_PATH)];
  if (flag === undefined) {
    delete process.env.PMAX_VIDEO_DIRECTIVES;
    delete process.env.VIDEO_HOOK_FIRST_PROMPT;
  } else {
    // Set BOTH names. Either one reading "false" kills (fail-safe OR), so
    // setting only the legacy name cannot force ON if a future dotenv load
    // ever put config/defaults.env's new-default "false" on the other name
    // (that file now ships both false — see V2c). This process never loads
    // that file today, but the arm should not depend on that staying true.
    process.env.PMAX_VIDEO_DIRECTIVES = flag;
    process.env.VIDEO_HOOK_FIRST_PROMPT = flag;
  }
  return require(VEO_PATH);
}

function isMetaSurface(key) {
  return !String(key).startsWith('pmax_');
}

function isPmaxSurface(key) {
  return String(key).startsWith('pmax_');
}

function sectionsOf(prompt) {
  return String(prompt || '').trim().split(/\n\n+/).filter((s) => s.trim().length);
}

console.log('\nverifyPmaxPromptOverlay — Phase B static + video pins\n');

// ═══════════════════════════════════════════════════════════════════════
// S0 — loader sanity
// ═══════════════════════════════════════════════════════════════════════
console.log('S0. loader sanity (both arms, dual-module invalidation)');
{
  const on = loadStaticArm('true');
  const off = loadStaticArm('false');
  truthy('S0 flag-on export true', on.PMAX_STATIC_PLATFORM_NOTES === true);
  truthy('S0 flag-off export false', off.PMAX_STATIC_PLATFORM_NOTES === false);
  truthy('S0 resolveDrawCta exported (on)', typeof on.resolveDrawCta === 'function');
  truthy('S0 resolveDrawCta exported (off)', typeof off.resolveDrawCta === 'function');
  truthy('S0 PLATFORM_NOTES.pmax present (on)',
    !!(on.PLATFORM_NOTES && on.PLATFORM_NOTES.pmax));
  truthy('S0 dual-invalidate: on and off modules are distinct objects', on !== off);
}

// ═══════════════════════════════════════════════════════════════════════
// S1 — BOTH-ARM META BYTE-IDENTITY (most important check)
// ═══════════════════════════════════════════════════════════════════════
console.log('\nS1. Meta byte-identity: PMAX_STATIC_PLATFORM_NOTES ON === OFF');
{
  const on = loadStaticArm('true');
  const off = loadStaticArm('false');
  const intents = Object.keys(on.INTENTS);
  const metaSurfaces = Object.keys(on.SURFACE_POLICY).filter(isMetaSurface);
  let pairs = 0;
  let identical = 0;

  for (const intentKey of intents) {
    for (const surface of metaSurfaces) {
      for (const [dataKey, data] of Object.entries(DATA_CONDITIONS)) {
        const rOn = on.buildPrompt({ intentKey, data, product: PRODUCT, surface });
        const rOff = off.buildPrompt({ intentKey, data, product: PRODUCT, surface });
        // Skipped / error must agree, and prompts must be byte-identical.
        if (rOn.skipped || rOff.skipped) {
          check(`S1 ${intentKey}/${surface}/${dataKey} skip agreement`,
            !!rOn.skipped, !!rOff.skipped);
          pairs++;
          if (!!rOn.skipped === !!rOff.skipped) identical++;
          continue;
        }
        if (rOn.error || rOff.error) {
          check(`S1 ${intentKey}/${surface}/${dataKey} error agreement`,
            rOn.error || null, rOff.error || null);
          pairs++;
          continue;
        }
        pairs++;
        const same = rOn.prompt === rOff.prompt;
        if (same) identical++;
        check(`S1 ${intentKey}/${surface}/${dataKey} Meta prompt byte-identical`,
          same, true);
      }
    }
  }
  truthy('S1 exercised at least 20 Meta (intent×surface×data) pairs', pairs >= 20);
  check('S1 every Meta pair byte-identical', identical, pairs);
}

// ═══════════════════════════════════════════════════════════════════════
// S2 — flag OFF: no PLATFORM CONTEXT on any pmax prompt
// ═══════════════════════════════════════════════════════════════════════
console.log('\nS2. flag OFF ⇒ pmax prompts carry no PLATFORM CONTEXT');
{
  const off = loadStaticArm('false');
  const intents = Object.keys(off.INTENTS);
  const pmaxSurfaces = Object.keys(off.SURFACE_POLICY).filter(isPmaxSurface);
  let n = 0;
  for (const intentKey of intents) {
    for (const surface of pmaxSurfaces) {
      for (const [dataKey, data] of Object.entries(DATA_CONDITIONS)) {
        const r = off.buildPrompt({ intentKey, data, product: PRODUCT, surface });
        if (r.skipped || r.error || !r.prompt) continue;
        n++;
        falsy(`S2 ${intentKey}/${surface}/${dataKey} no PLATFORM CONTEXT`,
          /PLATFORM CONTEXT/.test(r.prompt));
      }
    }
  }
  truthy('S2 exercised at least 8 pmax prompts under flag OFF', n >= 8);
}

// ═══════════════════════════════════════════════════════════════════════
// S3 — flag ON: live pmax static surfaces get notes AFTER geometry
// ═══════════════════════════════════════════════════════════════════════
console.log('\nS3. flag ON ⇒ live pmax statics have PLATFORM CONTEXT after FORMAT');
{
  const on = loadStaticArm('true');
  const pf = require(PF_PATH);
  const livePmaxStatic = Object.keys(on.SURFACE_POLICY).filter((k) => {
    if (!isPmaxSurface(k)) return false;
    const pol = on.SURFACE_POLICY[k];
    if (!pol || !pol.static) return false;
    const caps = pf.PLATFORM_FORMATS[k];
    return caps && caps.status === 'live';
  });
  truthy('S3 found live pmax static surfaces', livePmaxStatic.length >= 3);
  check('S3 live pmax static set',
    livePmaxStatic.slice().sort(),
    ['pmax_landscape_1_91_1', 'pmax_portrait_4_5', 'pmax_square_1_1'].sort());

  // Also pin frozen pmax_16_9 gets notes (still a pmax surface in SURFACE_POLICY).
  const allPmaxStatic = Object.keys(on.SURFACE_POLICY)
    .filter((k) => isPmaxSurface(k) && on.SURFACE_POLICY[k].static);

  for (const surface of allPmaxStatic) {
    const r = on.buildPrompt({
      intentKey: 'product_first_lifestyle',
      data: DATA_CONDITIONS.RICH,
      product: PRODUCT,
      surface
    });
    truthy(`S3 ${surface}: built a prompt`, !!(r.prompt && !r.skipped && !r.error));
    truthy(`S3 ${surface}: contains PLATFORM CONTEXT`,
      /PLATFORM CONTEXT/.test(r.prompt || ''));
    const sections = sectionsOf(r.prompt);
    const last = sections[sections.length - 1] || '';
    const prev = sections[sections.length - 2] || '';
    truthy(`S3 ${surface}: last section is PLATFORM CONTEXT`,
      /^PLATFORM CONTEXT\b/.test(last.trim()));
    truthy(`S3 ${surface}: second-to-last is FORMAT (geometry before notes)`,
      /^FORMAT:/.test(prev.trim()));
  }

  // Live set is a subset of allPmaxStatic — already covered above; keep an
  // explicit live pin so a status flip fails loudly.
  for (const surface of livePmaxStatic) {
    truthy(`S3 live ${surface} is in SURFACE_POLICY`,
      !!on.SURFACE_POLICY[surface]);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// S4 — platform notes never on Meta, either arm
// ═══════════════════════════════════════════════════════════════════════
console.log('\nS4. PLATFORM CONTEXT never on Meta (either arm)');
{
  for (const [arm, flag] of [['ON', 'true'], ['OFF', 'false']]) {
    const mod = loadStaticArm(flag);
    const intents = Object.keys(mod.INTENTS);
    const metaSurfaces = Object.keys(mod.SURFACE_POLICY).filter(isMetaSurface);
    for (const intentKey of intents) {
      for (const surface of metaSurfaces) {
        const r = mod.buildPrompt({
          intentKey, data: DATA_CONDITIONS.RICH, product: PRODUCT, surface
        });
        if (r.skipped || r.error || !r.prompt) continue;
        falsy(`S4 arm=${arm} ${intentKey}/${surface} no PLATFORM CONTEXT`,
          /PLATFORM CONTEXT/.test(r.prompt));
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// S5 — resolveDrawCta truth table, both arms
// ═══════════════════════════════════════════════════════════════════════
console.log('\nS5. resolveDrawCta truth table (both arms)');
{
  // Flag ON
  {
    const on = loadStaticArm('true');
    const intents = Object.keys(on.INTENTS);
    for (const surface of Object.keys(on.SURFACE_POLICY)) {
      const policy = on.SURFACE_POLICY[surface];
      if (!policy || !policy.static) continue;
      for (const intentKey of intents) {
        const got = on.resolveDrawCta({ surfaceKey: surface, policy, intentKey });
        if (isPmaxSurface(surface)) {
          check(`S5 ON pmax ${surface}/${intentKey}`,
            got, intentKey === 'objection_resolved');
        } else {
          check(`S5 ON meta ${surface}/${intentKey}`,
            got, policy.drawCta);
        }
      }
    }
  }
  // Flag OFF — Phase A: every surface uses raw SURFACE_POLICY.drawCta
  {
    const off = loadStaticArm('false');
    const intents = Object.keys(off.INTENTS);
    for (const surface of Object.keys(off.SURFACE_POLICY)) {
      const policy = off.SURFACE_POLICY[surface];
      if (!policy || !policy.static) continue;
      for (const intentKey of intents) {
        const got = off.resolveDrawCta({ surfaceKey: surface, policy, intentKey });
        check(`S5 OFF ${surface}/${intentKey} === policy.drawCta`,
          got, policy.drawCta);
      }
    }
    // Explicit Phase A pmax pin: all pmax static drawCta true under flag OFF
    for (const surface of Object.keys(off.SURFACE_POLICY).filter(isPmaxSurface)) {
      const policy = off.SURFACE_POLICY[surface];
      if (!policy || !policy.static) continue;
      for (const intentKey of Object.keys(off.INTENTS)) {
        check(`S5 OFF pmax ${surface}/${intentKey} is true (Phase A)`,
          off.resolveDrawCta({ surfaceKey: surface, policy, intentKey }), true);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// VIDEO
// ═══════════════════════════════════════════════════════════════════════
console.log('\nV. PMax video directives (PMAX_VIDEO_DIRECTIVES)');

// NAMING, CORRECTED 2026-08-18: this fixture used to be called VEO_ARGS_META
// and every check that used it claimed to be about "Meta". It passes NO
// platformFormat, so it was only ever exercising the DESTINATION-LESS path
// (scaffold / aiVideoReferenceService / legacy). That mislabel became actively
// misleading once Meta destinations started selecting the hook-first profile:
// "flag-OFF: PMax prompt byte-identical to Meta" was comparing PMax against a
// prompt no Meta ad receives. Renamed, and a REAL Meta destination fixture
// added below.
const VEO_ARGS_NO_DEST = {
  product: { title: 'Wool Runner' },
  aspectRatio: '9:16',
  durationSec: 10,
  hasProductReference: true,
  seedHasText: false,
  caps: { promptByteCap: 20000, paramShape: 'gemini-omni' }
};

// The live Meta video master — what atlasVideoService.generateForAd actually
// passes as ad.platformFormat for a Meta video ad.
const VEO_ARGS_META_916 = {
  ...VEO_ARGS_NO_DEST,
  platformFormat: 'meta_stories_9_16'
};

const VEO_ARGS_PMAX_916 = {
  ...VEO_ARGS_NO_DEST,
  aspectRatio: '9:16',
  platformFormat: 'pmax_video_9_16'
};

const VEO_ARGS_PMAX_169 = {
  ...VEO_ARGS_NO_DEST,
  aspectRatio: '16:9',
  platformFormat: 'pmax_video_16_9'
};

// V1 / V2 — kill switch behaviour
//
// REWRITTEN 2026-08-18 for the owner-directed standardization, verbatim:
//   "I want to use the PMax prompt for Meta also, and standardize on that but
//    maintain a single minting for 9x16 across both formats. Continue to mint
//    a 16x9."
// The old V2 ("flag-OFF: PMax destination prompt byte-identical to Meta") was
// comparing against the destination-less prompt and is now stated honestly as
// two separate facts: the kill switch returns BOTH destinations to the
// destination-less/frozen prompt (V2), and with the switch ON the two
// destinations converge on ONE prompt (V1) — which is the standardization.
{
  const on = loadVeoArm('true');
  const noDestOn = on.buildVeoPrompt({ ...VEO_ARGS_NO_DEST });
  const metaOn = on.buildVeoPrompt({ ...VEO_ARGS_META_916 });
  const pmaxOn = on.buildVeoPrompt({ ...VEO_ARGS_PMAX_916 });
  truthy('V1 flag-ON: no-destination, Meta and PMax prompts all non-empty',
    noDestOn.length > 100 && metaOn.length > 100 && pmaxOn.length > 100);
  truthy('V1 flag-ON: PMax destination prompt differs from the destination-less prompt',
    noDestOn !== pmaxOn);
  truthy('V1 flag-ON: Meta destination prompt differs from the destination-less prompt (standardization is live)',
    noDestOn !== metaOn);
  check('V1 flag-ON: Meta 9:16 and PMax 9:16 are ONE identical prompt (owner 2026-08-18 standardization)',
    metaOn, pmaxOn);

  const off = loadVeoArm('false');
  const noDestOff = off.buildVeoPrompt({ ...VEO_ARGS_NO_DEST });
  const metaOff = off.buildVeoPrompt({ ...VEO_ARGS_META_916 });
  const pmaxOff = off.buildVeoPrompt({ ...VEO_ARGS_PMAX_916 });
  truthy('V2 flag-OFF: no-destination, Meta and PMax prompts all non-empty',
    noDestOff.length > 100 && metaOff.length > 100 && pmaxOff.length > 100);
  check('V2 flag-OFF: PMax destination prompt byte-identical to the destination-less prompt (kill switch → Phase A)',
    pmaxOff, noDestOff);
  check('V2 flag-OFF: Meta destination prompt byte-identical to the destination-less prompt (kill switch → frozen pre-#61 Meta text)',
    metaOff, noDestOff);

  // The destination-less path must not depend on the flag at all — the switch
  // only gates destination selection. Cross-arm identity:
  check('V2 destination-less prompt identical across video flag arms',
    noDestOn, noDestOff);
}

// V2b — the kill switch honours BOTH env names, and either one can kill.
// PMAX_VIDEO_DIRECTIVES is the Phase B name that may be set on the Render
// dashboard; VIDEO_HOOK_FIRST_PROMPT is the current name. Backward
// compatibility is a hard requirement — a dashboard override must not
// silently stop working when the code renames its own flag.
{
  const priorHook = process.env.VIDEO_HOOK_FIRST_PROMPT;
  const priorLegacy = process.env.PMAX_VIDEO_DIRECTIVES;
  const load = () => {
    delete require.cache[require.resolve(VEO_PATH)];
    delete require.cache[require.resolve(PF_PATH)];
    return require(VEO_PATH);
  };
  const metaProfile = (mod) =>
    mod.promptProfileFor({ promptByteCap: 20000, paramShape: 'gemini-omni' },
      { platformFormat: 'meta_stories_9_16' });

  delete process.env.VIDEO_HOOK_FIRST_PROMPT;
  delete process.env.PMAX_VIDEO_DIRECTIVES;
  check('V2b both names unset ⇒ ON by default', metaProfile(load()), 'hook_first');

  process.env.PMAX_VIDEO_DIRECTIVES = 'false';
  check('V2b LEGACY name alone kills (Render dashboard back-compat)', metaProfile(load()), 'gemini-omni');

  // A shape that could still occur on a dashboard mid-migration: the NEW name
  // carries a value while a dashboard override sets the LEGACY name to false.
  // A "new name wins" precedence rule would silently ignore the dashboard.
  // (This is no longer the shipped config/defaults.env shape — see V2c for
  // that — but the fail-safe OR must hold for ANY combination, not just the
  // one currently committed.)
  process.env.VIDEO_HOOK_FIRST_PROMPT = 'true';
  check('V2b legacy=false + new=true STILL kills — fail-safe OR, not precedence',
    metaProfile(load()), 'gemini-omni');

  delete process.env.PMAX_VIDEO_DIRECTIVES;
  process.env.VIDEO_HOOK_FIRST_PROMPT = 'false';
  check('V2b NEW name alone kills', metaProfile(load()), 'gemini-omni');

  process.env.VIDEO_HOOK_FIRST_PROMPT = '   ';
  check('V2b blank/whitespace value counts as unset (not as "false")', metaProfile(load()), 'hook_first');

  if (priorHook === undefined) delete process.env.VIDEO_HOOK_FIRST_PROMPT;
  else process.env.VIDEO_HOOK_FIRST_PROMPT = priorHook;
  if (priorLegacy === undefined) delete process.env.PMAX_VIDEO_DIRECTIVES;
  else process.env.PMAX_VIDEO_DIRECTIVES = priorLegacy;
}

// V2c — config/defaults.env pins the SHIPPED default, not just the code
// fallback. Same rationale as verifyPostPilotBatch.js C14 (REPEAT_PRIMARY_
// REFERENCE): defaults.env is committed and dotenv-loaded at boot, so it is
// the REAL production value absent a Render dashboard override — pinning
// only the code default (`isHookFirstVideoPromptEnabled`'s fallback `true`,
// still asserted by V2b "both names unset") would leave this file free to
// drift back to "true" unnoticed. Owner revert 2026-08-20, verbatim: "I want
// to go back to the prompt I was using before we standardized on the pmax
// prompt ... use this same prompt for PMax for now also."
{
  const envText = fs.readFileSync(
    path.join(__dirname, '..', 'config', 'defaults.env'), 'utf8');
  truthy('V2c config/defaults.env sets VIDEO_HOOK_FIRST_PROMPT=false (real prod default, owner revert 2026-08-20)',
    /^VIDEO_HOOK_FIRST_PROMPT=false\s*$/m.test(envText));
  truthy('V2c config/defaults.env sets PMAX_VIDEO_DIRECTIVES=false (real prod default, owner revert 2026-08-20)',
    /^PMAX_VIDEO_DIRECTIVES=false\s*$/m.test(envText));
  falsy('V2c config/defaults.env does NOT still ship VIDEO_HOOK_FIRST_PROMPT=true',
    /^VIDEO_HOOK_FIRST_PROMPT=true\s*$/m.test(envText));
  falsy('V2c config/defaults.env does NOT still ship PMAX_VIDEO_DIRECTIVES=true',
    /^PMAX_VIDEO_DIRECTIVES=true\s*$/m.test(envText));
}

// V3 — destination-less path byte-identical to the pre-#61 baseline
// Mirror verifyPostPilotBatch.js B14: git show → temp file with absolute
// require rewrite. If git is unavailable, SKIP loudly rather than false-pass.
//
// BASELINE CHANGED 2026-08-18: was `HEAD:services/veoPromptBuilder.js`, which
// only ever compared the working tree against the last commit — so the moment
// a prompt change was committed the pin re-based onto it and stopped proving
// anything. Now pinned to the IMMUTABLE `134db56~1` source, the same known-good
// pre-#61 prompt verifyPostPilotBatch B14/B15 use. That is the text this check
// has always been trying to protect, and it cannot drift out from under itself.
console.log('\nV3. destination-less prompt byte-identical to the 134db56~1 baseline (both video arms)');
{
  const BASELINE = '134db56~1:services/veoPromptBuilder.js';
  const REL_REQUIRE = "require('./platformFormats')";
  let oldMod = null;
  let skipReason = null;
  let tmpDir = null;

  try {
    const src = cp.execFileSync('git', ['-C', REPO, 'show', BASELINE], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    if (!src.includes(REL_REQUIRE)) {
      skipReason = `baseline source does not contain ${REL_REQUIRE}`;
    } else {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmaxVeoBaseline-'));
      const tmpFile = path.join(tmpDir, 'veoPromptBuilder.baseline.js');
      fs.writeFileSync(tmpFile, src.replace(
        REL_REQUIRE,
        `require(${JSON.stringify(path.join(REPO, 'services', 'platformFormats'))})`
      ));
      oldMod = require(tmpFile);
      if (typeof oldMod.buildVeoPrompt !== 'function') {
        oldMod = null;
        skipReason = 'baseline module does not export buildVeoPrompt';
      }
    }
  } catch (e) {
    skipReason = `git unavailable or ${BASELINE} not in this clone (${e.code || e.message})`;
  }

  if (!oldMod) {
    // Skip is NOT a pass — print loudly. Do not count as pass or fail.
    console.log(`  ⏭  V3 SKIP (baseline unavailable): ${skipReason}`);
    console.log('      ⚠️  byte-identity to 134db56~1 was NOT verified in this run.');
  } else {
    const baselineNoDest = oldMod.buildVeoPrompt({ ...VEO_ARGS_NO_DEST });
    for (const [arm, flag] of [['ON', 'true'], ['OFF', 'false']]) {
      const mod = loadVeoArm(flag);
      check(`V3 arm=${arm}: destination-less prompt byte-identical to the 134db56~1 baseline`,
        mod.buildVeoPrompt({ ...VEO_ARGS_NO_DEST }), baselineNoDest);
    }
    // The surviving PR #61 rollback guarantee, stated on the LIVE Meta
    // destination rather than on the destination-less path: switch off ⇒ a
    // Meta ad still receives the frozen pre-#61 prompt byte-for-byte.
    // (verifyPostPilotBatch B15 pins the same fact across a wider matrix;
    // it is restated here so this harness is not silently weaker than its
    // own header claims.)
    check('V3 arm=OFF: LIVE Meta destination byte-identical to the 134db56~1 baseline (PR #61 rollback guarantee survives)',
      loadVeoArm('false').buildVeoPrompt({ ...VEO_ARGS_META_916 }), baselineNoDest);
    truthy('V3 arm=ON: LIVE Meta destination has MOVED off the 134db56~1 baseline (owner 2026-08-18 standardization)',
      loadVeoArm('true').buildVeoPrompt({ ...VEO_ARGS_META_916 }) !== baselineNoDest);
    // Also: the baseline must NOT carry destination-gated content
    falsy('V3 baseline (destination-less) has no HOOK-FIRST',
      /HOOK-FIRST/.test(baselineNoDest));
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

// V4 — hook-first video content pins (flag ON), on BOTH platforms
console.log('\nV4. hook-first video content pins (flag ON) — PMax and Meta');
{
  const on = loadVeoArm('true');
  const p916 = on.buildVeoPrompt({ ...VEO_ARGS_PMAX_916 });
  const p169 = on.buildVeoPrompt({ ...VEO_ARGS_PMAX_169 });
  const m916 = on.buildVeoPrompt({ ...VEO_ARGS_META_916 });

  // ── Meta now carries the same hook-first content (owner 2026-08-18) ─────
  // Asserted separately from the Meta≡PMax equality in V1 on purpose: if a
  // future change broke BOTH platforms identically, the equality check alone
  // would still pass. These pin the content itself.
  truthy('V4 Meta 9:16 contains HOOK-FIRST instruction', /HOOK-FIRST/.test(m916));
  truthy('V4 Meta 9:16 Scene 1 is a HOOK beat, not the frozen pan',
    /Scene 1 \(0\.0–3\.33s\): HOOK/.test(m916));
  falsy('V4 Meta 9:16 no longer opens with the frozen left→right pan',
    /Scene 1 \(0\.0–3\.33s\): slow horizontal pan/.test(m916));
  truthy('V4 Meta 9:16 contains centre-safe language', /Centre-safe composition/.test(m916));
  truthy('V4 Meta 9:16 Scene 3 maintains centre-safe framing',
    /Maintain centre-safe framing/.test(m916));
  falsy('V4 Meta 9:16 no longer says "Maintain center framing"',
    /Maintain center framing/.test(m916));
  truthy('V4 Meta 9:16 emits the vertical Frame line (it never did before)',
    /Frame \(9:16 vertical\)/.test(m916));
  // Platform neutrality — one profile serves both platforms, so the text sent
  // to the model must not name either one.
  falsy('V4 Meta prompt never names PMax to the model', /PMax/i.test(m916));
  falsy('V4 PMax prompt never names Meta to the model', /\bMeta\b/i.test(p916));

  // Hook-first
  truthy('V4 9:16 contains HOOK-FIRST instruction', /HOOK-FIRST/.test(p916));
  truthy('V4 16:9 contains HOOK-FIRST instruction', /HOOK-FIRST/.test(p169));
  truthy('V4 9:16 Scene 1 is HOOK beat', /Scene 1 \(0\.0–3\.33s\): HOOK/.test(p916));

  // Centre-safe (British spelling in PMAX_DIRECTIVES)
  truthy('V4 9:16 contains centre-safe language', /Centre-safe composition/.test(p916));
  truthy('V4 16:9 contains centre-safe language', /Centre-safe composition/.test(p169));
  truthy('V4 Scene 3 maintains centre-safe framing',
    /Maintain centre-safe framing/.test(p916));

  // Aspect Frame lines
  truthy('V4 16:9 contains landscape Frame direction',
    /Frame \(16:9 landscape\)/.test(p169));
  truthy('V4 16:9 prefers horizontal camera travel',
    /prefer horizontal camera travel/.test(p169));
  falsy('V4 9:16 does NOT claim landscape framing',
    /Frame \(16:9 landscape\)/.test(p916));
  truthy('V4 9:16 contains vertical Frame direction',
    /Frame \(9:16 vertical\)/.test(p916));

  // Timeline arithmetic at durationSec=10 (ratios 1/3 and 0.64)
  // t1 = (10/3).toFixed(2) = "3.33"; t2 = (10*0.64).toFixed(2) = "6.40"
  const t1 = (10 / 3).toFixed(2);
  const t2 = (10 * 0.64).toFixed(2);
  check('V4 t1 arithmetic at 10s', t1, '3.33');
  check('V4 t2 arithmetic at 10s', t2, '6.40');
  truthy('V4 9:16 Timeline opens at 10.0s', /Timeline \(10\.0s\)/.test(p916));
  truthy('V4 9:16 Scene 1 ends at 3.33s', p916.includes(`Scene 1 (0.0–${t1}s)`));
  truthy('V4 9:16 Scene 2 spans 3.33–6.40s',
    p916.includes(`Scene 2 (${t1}–${t2}s)`));
  truthy('V4 9:16 Scene 3 spans 6.40–10.0s',
    p916.includes(`Scene 3 (${t2}–10.0s)`));
  // Guard against an 8s-hardcoded timeline leaking into a 10s request.
  falsy('V4 9:16 does not hardcode 8.0s Timeline at durationSec=10',
    /Timeline \(8\.0s\)/.test(p916));
  falsy('V4 9:16 does not hardcode Scene 1 end 2.66s (8s arc)',
    /Scene 1 \(0\.0–2\.66s\)/.test(p916));
  falsy('V4 9:16 does not hardcode Scene 2 end 5.12s (8s arc)',
    /Scene 2 \(3\.33–5\.12s\)/.test(p916) || /Scene 2 \(2\.66–5\.12s\)/.test(p916));

  // Cross-check 16:9 timeline same arithmetic
  truthy('V4 16:9 Scene boundaries match 10s arithmetic',
    p169.includes(`Scene 1 (0.0–${t1}s)`) &&
    p169.includes(`Scene 2 (${t1}–${t2}s)`) &&
    p169.includes(`Scene 3 (${t2}–10.0s)`));
}

// Restore default env so a later require in the same process is clean.
delete process.env.PMAX_STATIC_PLATFORM_NOTES;
delete process.env.PMAX_VIDEO_DIRECTIVES;
delete process.env.VIDEO_HOOK_FIRST_PROMPT;
try {
  delete require.cache[require.resolve(INTENTS_PATH)];
  delete require.cache[require.resolve(PF_PATH)];
  delete require.cache[require.resolve(VEO_PATH)];
} catch { /* ignore */ }

console.log(`\n${fail === 0 ? '✅' : '❌'} verifyPmaxPromptOverlay: ${pass}/${pass + fail} checks passed\n`);
if (fail) {
  console.log('FAILURES:');
  failures.forEach((f) => console.log('  ✗ ' + f));
}
process.exit(fail === 0 ? 0 : 1);
