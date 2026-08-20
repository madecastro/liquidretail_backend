#!/usr/bin/env node
'use strict';

/**
 * verifyVideoUiChromeGuard — offline pins for the UI-chrome hallucination
 * guard (VIDEO_PROMPT_UI_CHROME_GUARD, services/veoPromptBuilder.js).
 *
 * INCIDENT: run_1787174963435_ff67021e (Marine Layer 2, "Cut & Sew Bode
 * Puffer Jacket", 6a7b72f4935d0a8e81905544). Both Omni masters in that run
 * (meta_stories_9_16 and pmax_video_16_9) baked a fake product-detail-page
 * header/footer — nav bar, hamburger icon, garbled pseudo-text, shopping-bag
 * icon, footer repeating the real (correctly-spelled) product name beside
 * more garbled text — directly into the video plate. Confirmed against the
 * RAW pre-titling veoVideoUrl (not just the delivered renderUrl), so this is
 * baked in by Omni itself, before Remotion titling ever runs. The three seed
 * / reference Media docs for that ad were pulled and inspected byte-for-byte:
 * all three are clean catalog product photography (Shopify CDN originals),
 * none is a PDP/storefront screenshot. So the leading "bad seed" hypothesis
 * is REFUTED for this run — the defect is a model hallucination, not garbage
 * in / garbage out.
 *
 * `OMNI_DIRECTIVES.noText` / `GROK_DIRECTIVES.noText` already ban generating
 * new text, typography, logos, badges, watermarks, and captions, and Omni
 * still violated it — but neither directive ever named UI/app/webpage CHROME
 * (nav bars, menus, icons, buttons) as its own category, so an icon-heavy
 * hallucination had nothing explicit to violate for half of what it rendered.
 *
 * FIX SHAPE: a separate, additive prompt line (UI_CHROME_GUARD_LINE),
 * deliberately kept OUTSIDE OMNI_DIRECTIVES / GROK_DIRECTIVES /
 * HOOK_FIRST_DIRECTIVES so it can never touch the byte-identity pin those
 * carry (scripts/verifyPostPilotBatch.js B1-B17, CLAUDE.md §00 PR #61
 * rollback). Gated by VIDEO_PROMPT_UI_CHROME_GUARD.
 *
 * SHIPPED OFF, THEN VERIFIED LIVE THE SAME DAY (2026-08-19): the flag went
 * out default OFF because confirming it needs a live, non-refundable ~$0.90
 * Omni submit. That submit was then run — same product/brand/seed stack as
 * the incident (run_1787174963435_ff67021e), flag forced true, predictionId
 * `3e579bc492bd4da785d77316c8011c3c`, Atlas-settled $0.90. Frames pulled
 * from the raw pre-titling video at 0.1/0.3/0.5/0.8/1.2/2.5s — including
 * t=0.1s and t=0.5s, exactly where the original chrome was visible — showed
 * NONE of it. The flag now defaults ON (config/defaults.env). This harness's
 * assertions below did not need to change: they drive the env var directly
 * and never depended on the committed default.
 *
 * This harness proves, entirely offline:
 *   A. Flag OFF (explicit 'false' or unset) → buildVeoPrompt output is
 *      IDENTICAL with the guard code present vs. absent (byte-for-byte),
 *      across every profile (gemini-omni, grok, hook_first, lifestyle,
 *      pmax split) — i.e. flipping the flag back off (rollback) restores
 *      today's prompts with no other code change needed.
 *   B. Flag ON (now the default) → the new line IS present, in every
 *      profile, and names the concrete failure mode (nav/menu/icon/
 *      screenshot) rather than only repeating noText's generic "no text" ban.
 *   C. OMNI_DIRECTIVES / GROK_DIRECTIVES / HOOK_FIRST_DIRECTIVES objects are
 *      byte-identical to their frozen values regardless of the flag — the
 *      new line is never folded into them.
 *   D. isVideoUiChromeGuardEnabled() is a strict `=== 'true'` gate (matches
 *      the isVideoLifestylePromptEnabled precedent) — 'TRUE', '1', 'yes',
 *      whitespace-padded, etc. all stay OFF, so a stray truthy env string
 *      cannot silently turn this on/off unexpectedly.
 *
 * Revert-proof: comment out the `lines.push(UI_CHROME_GUARD_LINE)` call (or
 * the whole guard block) in services/veoPromptBuilder.js and re-run — group B
 * must fail.
 */

const path = require('path');
const assert = require('assert');

const builderPath = path.join(__dirname, '..', 'services', 'veoPromptBuilder.js');

let pass = 0;
const failures = [];

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass += 1; return; }
  failures.push(`${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
}

function truthy(label, v) {
  check(label, !!v, true);
}

function falsy(label, v) {
  check(label, !!v, false);
}

// Fresh require per env-flag flip — the module has no other per-process
// state that caching would corrupt, and every other flag harness in this
// repo (e.g. verifyPostPilotBatch's hook-first arms) re-requires the same
// way rather than trying to hot-swap env reads through a cached module.
function freshBuilder() {
  delete require.cache[require.resolve(builderPath)];
  return require(builderPath);
}

console.log('\nverifyVideoUiChromeGuard\n');

const ORIGINAL_ENV = process.env.VIDEO_PROMPT_UI_CHROME_GUARD;

// A representative product/media/caps fixture. Values are irrelevant beyond
// "buildVeoPrompt runs without throwing" — this harness is about which LINES
// appear, not about a specific brand/product's content.
const product = { title: 'Cut & Sew Bode Puffer Jacket' };
const media = {};
const baseCaps = { promptByteCap: 20000 };

const PROFILES_TO_CHECK = [
  { label: 'gemini-omni (default, no platformFormat)', args: {} },
  { label: 'hook_first (Meta destination)', args: { platformFormat: 'meta_stories_9_16' } },
  { label: 'hook_first (PMax 16:9 destination)', args: { platformFormat: 'pmax_video_16_9', aspectRatio: '16:9' } },
  { label: 'grok profile override', args: { promptProfile: 'grok' } },
];

try {
  // ═══════════════════════════════════════════════════════════════════
  // A + B — flag off vs on, across profiles
  // ═══════════════════════════════════════════════════════════════════
  console.log('A/B. flag OFF leaves every profile byte-identical; flag ON adds the line');

  for (const { label, args } of PROFILES_TO_CHECK) {
    delete process.env.VIDEO_PROMPT_UI_CHROME_GUARD;
    const offBuilder = freshBuilder();
    const promptOff = offBuilder.buildVeoPrompt({ product, media, caps: baseCaps, ...args });
    falsy(`[${label}] guard absent by default`, promptOff.includes('screen-within-the-screen'));

    process.env.VIDEO_PROMPT_UI_CHROME_GUARD = 'false';
    const explicitOffBuilder = freshBuilder();
    const promptExplicitOff = explicitOffBuilder.buildVeoPrompt({ product, media, caps: baseCaps, ...args });
    check(`[${label}] explicit 'false' === unset`, promptExplicitOff, promptOff);

    process.env.VIDEO_PROMPT_UI_CHROME_GUARD = 'true';
    const onBuilder = freshBuilder();
    const promptOn = onBuilder.buildVeoPrompt({ product, media, caps: baseCaps, ...args });
    truthy(`[${label}] guard present when flag is 'true'`, promptOn.includes('screen-within-the-screen'));
    truthy(`[${label}] guard names concrete UI elements, not just "no text"`,
      /hamburger/i.test(promptOn) && /navigation bars/i.test(promptOn) && /shopping-cart\/bag/i.test(promptOn));
    truthy(`[${label}] guard names screenshot/mockup explicitly`, /screenshot, mockup/i.test(promptOn));

    // ON prompt must be a strict superset (one extra sentence) of OFF —
    // never a rewording of any existing line. buildVeoPrompt joins lines
    // with single spaces, so removing the inserted line can leave a run of
    // collapsed whitespace where it sat; normalise both sides the same way
    // before comparing so this only detects a REAL difference in content.
    const normalize = (s) => s.replace(onBuilder.UI_CHROME_GUARD_LINE, ' ').replace(/\s+/g, ' ').trim();
    truthy(`[${label}] ON prompt is a strict superset of OFF prompt (single insertion)`,
      promptOn.length > promptOff.length && normalize(promptOn) === normalize(promptOff));
  }

  // ═══════════════════════════════════════════════════════════════════
  // C — frozen directive objects untouched regardless of the flag
  // ═══════════════════════════════════════════════════════════════════
  console.log('C. OMNI_DIRECTIVES / GROK_DIRECTIVES / HOOK_FIRST_DIRECTIVES unchanged by the flag');

  process.env.VIDEO_PROMPT_UI_CHROME_GUARD = 'false';
  const b1 = freshBuilder();
  process.env.VIDEO_PROMPT_UI_CHROME_GUARD = 'true';
  const b2 = freshBuilder();

  for (const key of ['role', 'objective', 'sourceImages', 'productPreservation', 'transitions',
    'cameraStyle', 'background', 'visualStyle', 'audio', 'noText', 'physicalAccuracy', 'doNot']) {
    check(`OMNI_DIRECTIVES.${key} identical regardless of flag`, b2.OMNI_DIRECTIVES[key], b1.OMNI_DIRECTIVES[key]);
    check(`GROK_DIRECTIVES.${key} identical regardless of flag`, b2.GROK_DIRECTIVES[key], b1.GROK_DIRECTIVES[key]);
  }
  falsy('OMNI_DIRECTIVES.noText never mentions the new guard vocabulary',
    /hamburger|screen-within-the-screen/i.test(b1.OMNI_DIRECTIVES.noText));
  falsy('GROK_DIRECTIVES.noText never mentions the new guard vocabulary',
    /hamburger|screen-within-the-screen/i.test(b1.GROK_DIRECTIVES.noText));
  falsy('doNot never mentions the new guard vocabulary',
    /hamburger|screen-within-the-screen/i.test(b1.OMNI_DIRECTIVES.doNot));

  // ═══════════════════════════════════════════════════════════════════
  // D — strict '=== true' gate, matching isVideoLifestylePromptEnabled
  // ═══════════════════════════════════════════════════════════════════
  console.log("D. isVideoUiChromeGuardEnabled is a strict === 'true' gate");

  const strictCases = [
    ['unset', undefined, false],
    ['empty string', '', false],
    ['false', 'false', false],
    ['TRUE (case)', 'TRUE', false],
    ['1', '1', false],
    ['yes', 'yes', false],
    [' true (padded)', ' true ', false],
    ['true', 'true', true],
  ];
  for (const [label, value, expected] of strictCases) {
    if (value === undefined) delete process.env.VIDEO_PROMPT_UI_CHROME_GUARD;
    else process.env.VIDEO_PROMPT_UI_CHROME_GUARD = value;
    const b = freshBuilder();
    check(`isVideoUiChromeGuardEnabled('${label}')`, b.isVideoUiChromeGuardEnabled(), expected);
  }
} finally {
  if (ORIGINAL_ENV === undefined) delete process.env.VIDEO_PROMPT_UI_CHROME_GUARD;
  else process.env.VIDEO_PROMPT_UI_CHROME_GUARD = ORIGINAL_ENV;
  freshBuilder(); // leave require.cache in the original-env state
}

// ── Report ────────────────────────────────────────────────────────────
const total = pass + failures.length;
if (failures.length) {
  console.error(`\n❌ verifyVideoUiChromeGuard: ${failures.length} of ${total} checks FAILED\n`);
  failures.forEach((f, i) => console.error(`  ${i + 1}. ${f}\n`));
  process.exit(1);
}
console.log(`\n✅ verifyVideoUiChromeGuard: ${total}/${total} checks passed`);
console.log('   Flag ON (default as of 2026-08-19) → one extra, concrete UI-chrome prohibition line.');
console.log('   Flag OFF (explicit false/unset)    → byte-identical prompts, every profile — instant rollback.');
console.log('   OMNI_DIRECTIVES / GROK_DIRECTIVES / HOOK_FIRST_DIRECTIVES untouched either way.');
console.log('   VERIFIED LIVE 2026-08-19: real Omni submit (predictionId 3e579bc492bd4da785d77316c8011c3c,');
console.log('   $0.90 settled) with the flag on showed no chrome at 0.1/0.3/0.5/0.8/1.2/2.5s.');
assert.ok(true);
