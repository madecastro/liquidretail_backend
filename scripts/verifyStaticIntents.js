#!/usr/bin/env node
'use strict';

/**
 * verifyStaticIntents — coverage + invariant check for services/staticAdIntents.
 *
 * Every intent × every surface × every data condition, with no API calls.
 * Cheap enough to run on every edit.
 *
 * Invariants asserted (from the proven verify_v2 prototype):
 *   1. Every surface is either specced or explicitly skipped with a reason.
 *   2. No unresolved {{placeholder}} survives.
 *   3. No price/currency ever appears (owner directive, system-wide).
 *   4. No layout prescription: no thirds/upper/lower/left-half positional
 *      language, which is the class of bug that caused the fabricated quote.
 *   5. Element count never exceeds the surface density budget.
 *   6. A CTA string never appears on a surface where the platform supplies it.
 *   7. Anything absent from the data is explicitly named as non-existent.
 *   8. Core elements are never sacrificed to density.
 *
 * Owner constraints added at port:
 *   9. No product name in any absence-blocked prompt surface.
 *  10. A role label never appears on the right-hand side of an arrow.
 *  11. meta_reels_9_16 always returns skipped.
 *  12. An intent whose core role is missing from the data falls back rather
 *      than rendering hollow.
 *
 * No network, no database.
 */

const {
  buildPrompt,
  SURFACE_POLICY,
  INTENTS,
  resolveIntent,
  describeSurfaces,
  BRAND_LED_COPY,
  resolveDrawCta,
  PMAX_STATIC_PLATFORM_NOTES
} = require('../services/staticAdIntents');

const PRODUCT = {
  desc: "Men's seamless long-sleeve training top in HEATHER GREY-BLUE (a muted, desaturated grey-blue marl — NOT royal blue, NOT navy, NOT bright blue), tonal diamond-jacquard texture panels, small Gymshark logo on the chest, close athletic fit",
  look: 'high-contrast athletic editorial, charcoal and cool concrete grey, one acid volt-green accent, raw gym environment',
  logoCorner: 'bottom-right'
};

const DATA = {
  RICH: { rating: '4.8', reviewCount: '1,200+', quote: 'Fits true to size and never rides up.', attribution: 'Verified Buyer', badge: 'TOP RATED', headline: 'BE A VISIONARY', cta: 'SHOP NOW' },
  THIN: { rating: '4.8', reviewCount: null, quote: null, attribution: null, badge: null, headline: 'BE A VISIONARY', cta: 'SHOP NOW' },
  BARE: { rating: null, reviewCount: null, quote: null, attribution: null, badge: null, headline: null, cta: 'SHOP NOW' },
  // quote but no rating — the case my v1 gate wrongly allowed through intent 1
  QUOTE_ONLY: { rating: null, reviewCount: null, quote: 'Fits true to size and never rides up.', attribution: 'Verified Buyer', badge: null, headline: 'BE A VISIONARY', cta: 'SHOP NOW' }
};

// positional language — the v1 defect class
const POSITION_RE = /\b(upper|lower|top|bottom|left|right|middle|centre|center)[- ](third|half|quarter|band|panel|corner|side)\b/i;
const PRICE_RE = /(\$\s?\d|[£€]\s?\d|\b\d+% off\b|\bwas \d)/i;
const CTA_RE = /(shop now|learn more|swipe up|link in bio|buy now|add to cart)/i;
// Role labels as they appear left of the arrow (lowercase form in the prompt).
const ROLE_LABELS = [
  'rating', 'customer quote', 'attribution', 'badge', 'cta button',
  'brand line', 'trust mark'
];

let pass = 0, fail = 0;
const failures = [];

const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`  ✗ ${label}\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`);
  }
};
const truthy = (label, v) => check(label, !!v, true);
const falsy = (label, v) => check(label, !!v, false);

const surfaces = Object.keys(SURFACE_POLICY);
const intents = Object.keys(INTENTS);

console.log('\nverifyStaticIntents\n');

// ── A. reels is always skipped ──────────────────────────────────────────
console.log('A. meta_reels_9_16 is always skipped (video-only)');
for (const intentKey of intents) {
  for (const [dataKey, d] of Object.entries(DATA)) {
    const r = buildPrompt({ intentKey, data: d, product: PRODUCT, surface: 'meta_reels_9_16' });
    truthy(`reels/${intentKey}/${dataKey}: returns skipped`, !!r.skipped);
    falsy(`reels/${intentKey}/${dataKey}: no prompt`, !!r.prompt);
    falsy(`reels/${intentKey}/${dataKey}: no error`, !!r.error);
  }
}

// ── B. core-role missing → fallback, not hollow render ──────────────────
console.log('\nB. missing core falls back rather than rendering hollow');
// social_proof_led requires rating; BARE and QUOTE_ONLY lack it.
{
  const r = resolveIntent('social_proof_led', DATA.BARE);
  check('social_proof_led + BARE falls back', r.key, 'product_first_lifestyle');
  truthy('social_proof_led + BARE records fellBackFrom', r.fellBackFrom === 'social_proof_led');
}
{
  const r = resolveIntent('social_proof_led', DATA.QUOTE_ONLY);
  // quote alone is not enough; core is RATING
  check('social_proof_led + QUOTE_ONLY falls back off rating gate', r.key !== 'social_proof_led', true);
  truthy('social_proof_led + QUOTE_ONLY fell back from requested', r.fellBackFrom === 'social_proof_led');
}
// objection_resolved requires quote; BARE and THIN lack it.
{
  const r = resolveIntent('objection_resolved', DATA.BARE);
  check('objection_resolved + BARE falls back', r.key, 'product_first_lifestyle');
  truthy('objection_resolved + BARE records fellBackFrom', r.fellBackFrom === 'objection_resolved');
}
{
  // THIN has rating but no quote: chain is objection_resolved → social_proof_led
  // (eligible via rating) → product_first_lifestyle. Must not stay on hollow quote.
  const r = resolveIntent('objection_resolved', DATA.THIN);
  check('objection_resolved + THIN falls back to social_proof_led', r.key, 'social_proof_led');
  truthy('objection_resolved + THIN records fellBackFrom', r.fellBackFrom === 'objection_resolved');
}
// product_first_lifestyle is the floor and always eligible.
{
  const r = resolveIntent('product_first_lifestyle', DATA.BARE);
  check('product_first_lifestyle + BARE stays itself', r.key, 'product_first_lifestyle');
  check('product_first_lifestyle + BARE no fallback', r.fellBackFrom, null);
}

// ── C. coverage matrix — intent × surface × data ────────────────────────
console.log('\nC. coverage matrix — intent × surface × data\n');
console.log('intent                  surface              data        result');
console.log('-'.repeat(96));

for (const intentKey of intents) {
  for (const surface of surfaces) {
    for (const [dataKey, d] of Object.entries(DATA)) {
      const r = buildPrompt({ intentKey, data: d, product: PRODUCT, surface });
      const label = `${intentKey}/${surface}/${dataKey}`;
      const short = `${intentKey.padEnd(24)}${surface.padEnd(21)}${dataKey.padEnd(12)}`;

      if (r.error) {
        console.log(short + `❌ ERROR ${r.error}`);
        check(`${label} no error`, false, true);
        continue;
      }
      if (r.skipped) {
        console.log(short + `— skipped: ${r.skipped}`);
        truthy(`${surface} skip has reason`, !!r.skipped);
        // reels-specific invariant already covered in A; still assert reason text
        if (surface === 'meta_reels_9_16') {
          truthy(`${label} reels skip reason names video`, /video/i.test(r.skipped));
        }
        continue;
      }

      const p = r.prompt;
      const policy = SURFACE_POLICY[surface];
      const fellBack = r.resolved.fellBackFrom ? ` (fell back from ${r.resolved.fellBackFrom})` : '';
      const droppedNote = r.dropped.length ? ` -${r.dropped.join(',')}` : '';

      falsy(`${label} no placeholder`, /\{\{[^}]+\}\}/.test(p));
      falsy(`${label} no price`, PRICE_RE.test(p));

      // positional language may appear ONLY in the reserved-logo-corner line and
      // the geometry block, both of which are legitimate hard constraints.
      const bodyOnly = p
        .split('\n')
        .filter(l => !/^Keep the .* corner clear/.test(l) && !/^FORMAT:/.test(l))
        .join('\n');
      const posHit = bodyOnly.match(POSITION_RE);
      falsy(`${label} no layout prescription`, !!posHit);

      check(`${label} density <= ${policy.maxTextElements}`,
        r.text.length <= policy.maxTextElements, true);

      // An empty text list must NOT emit a "set this text" heading above nothing
      // — that is the v1 defect (an instruction pointing at an empty slot).
      if (r.text.length === 0) {
        truthy(`${label} zero-text declared positively`, /THIS AD CARRIES NO TEXT AT ALL/.test(p));
        falsy(`${label} no dangling set-text heading`, /SET EXACTLY THESE STRINGS/.test(p));
      } else {
        truthy(`${label} set-text heading present`, /SET EXACTLY THESE STRINGS/.test(p));
        // The one sentence that actually fixes the observed failure: the model
        // must be told the list it received is already complete, so a short list
        // does not read as a template with gaps.
        //
        // Two other paragraphs were added here on 2026-08-01 and REVERTED the
        // same day after review. Recorded so they are not reintroduced:
        //   - A "NEVER CREATE INFORMATION" block enumerating rating/badge/price/
        //     percentage/etc. It was UNCONDITIONAL, so on a social_proof_led ad it
        //     forbade a rating ~400 chars below `rating -> 4.8 ★`. absences()
        //     already states each of those only when the datum is genuinely
        //     absent, and says "the single rating string above is the ONLY rating
        //     mark permitted" when it is present — nuance the flat block destroyed.
        //   - "NONE OF THESE ELEMENTS IS REQUIRED", whose nearest antecedent is the
        //     SET EXACTLY THESE STRINGS list, so it read as permission to drop the
        //     verbatim strings.
        // An emphasis-list sentence was reverted too: every emphasis list is
        // already filtered by kept(), so the only entries without a string are the
        // unconditional ones — measured across 768 buildable prompts, that is
        // always THE PRODUCT, ranked #1 in 576. It told the model its hero subject
        // was not part of the ad.
        truthy(`${label} says the text list is complete`, /complete and only text for this ad/i.test(p));
        truthy(`${label} sets nothing else`, /set NOTHING ELSE/.test(p));
        truthy(`${label} absence is the brief, not a gap`, /accurate brief rather than a gap to fill/.test(p));
        falsy(`${label} does not enumerate forbidden proof nouns unconditionally`, /NEVER CREATE INFORMATION/.test(p));
        falsy(`${label} does not tell the model elements are optional`, /NONE OF THESE ELEMENTS IS REQUIRED/.test(p));
        falsy(`${label} never says an emphasis item is not part of the ad`, /not part of this ad/.test(p));
        const blockLines = (p.split('SET EXACTLY THESE STRINGS')[1] || '')
          .split('Set no other words')[0].trim().split('\n').length;
        truthy(`${label} text block non-empty`, blockLines > 1);
      }

      // CTA must not be SET as text where the platform supplies it. The absence
      // list legitimately names it in order to forbid it, so check the text block.
      //
      // Phase B (PMAX_STATIC_PLATFORM_NOTES default ON): effective drawCta is
      // intent-aware on pmax_* — suppressed for every resolved intent EXCEPT
      // objection_resolved. Meta still uses SURFACE_POLICY.drawCta only.
      // Never key on the raw SURFACE_POLICY boolean for pmax: brand_led /
      // social_proof_led / product_first_lifestyle all suppress CTA there.
      // Use the RESOLVED intent (r.resolved.key), not the requested one —
      // a fallback off objection_resolved must suppress CTA too.
      const textBlock = p.split('SET EXACTLY THESE STRINGS')[1]?.split('Set no other words')[0] || '';
      const effectiveDrawCta = resolveDrawCta({
        surfaceKey: surface,
        policy,
        intentKey: r.resolved.key
      });
      // Cross-check: buildPrompt returns the same effective policy.
      check(`${label} r.policy.drawCta matches resolveDrawCta`,
        r.policy.drawCta, effectiveDrawCta);
      if (!effectiveDrawCta) {
        falsy(`${label} no CTA text on this surface`, CTA_RE.test(textBlock));
        truthy(`${label} CTA explicitly forbidden`, /no CTA button/.test(p));
      } else {
        truthy(`${label} CTA present`, CTA_RE.test(textBlock));
      }

      // OBSERVED DEFECT 1: "RATING: 4.8 ★" printed label-and-all in 4/5 renders.
      // Role names must be declared non-printing and separated from the string.
      if (r.text.length) {
        truthy(`${label} labels declared non-printing`, /must NEVER appear in the image/.test(p));
        falsy(`${label} no uppercase ROLE: colon form`, /\n {2}[A-Z][A-Z ]+:/.test(p));

        // Role label never appears on the RIGHT-hand side of an arrow.
        for (const line of textBlock.split('\n')) {
          const m = line.match(/^\s*.+?\s*->\s*(.*)$/);
          if (!m) continue;
          const rhs = m[1];
          for (const role of ROLE_LABELS) {
            // whole-token match on the role words themselves, not substrings of copy
            const re = new RegExp(`\\b${role.replace(/ /g, '\\s+')}\\b`, 'i');
            // CTA BUTTON's string is often "SHOP NOW" etc — role name itself must not be the payload
            if (re.test(rhs) && rhs.trim().toLowerCase() === role) {
              falsy(`${label} role "${role}" not on RHS`, true);
            }
          }
          // stronger: the RHS of each arrow must equal the kept string, not the role
          // (roles are lowercased on the left; RHS is the verbatim copy)
        }
        // Assert each kept role appears left of arrow and its string is RHS-only
        for (const [role, str] of r.text) {
          const leftForm = role.toLowerCase();
          truthy(`${label} role ${role} left of arrow`,
            textBlock.includes(`${leftForm} -> ${str}`));
          // RHS must not itself be a role label (would mean hollow/mislabeled)
          falsy(`${label} RHS of ${role} is not a role label`,
            ROLE_LABELS.includes(str.trim().toLowerCase()));
        }
      }

      // OBSERVED DEFECT 2: a five-star glyph row drawn beside the supplied
      // rating in 2/5 renders — and at 4.5 stars for a 4.8 rating.
      if (r.text.some(([role]) => role === 'RATING' || role === 'TRUST MARK')) {
        truthy(`${label} star-row explicitly fenced`, /ONLY rating mark permitted/.test(p));
      }

      // the geometry line must not assert an element exists
      falsy(`${label} geometry element-agnostic`, /ALL text, the CTA/.test(p));

      // absences must name every missing thing
      const eff = r.resolved.spec;
      if (!d.quote || !eff.renders.rendersQuote) {
        truthy(`${label} quote absence stated`, /no customer quote/.test(p));
      }
      if (!d.badge || !eff.renders.rendersBadge) {
        truthy(`${label} badge absence stated`, /no badge/.test(p));
      }
      if (!d.rating || !eff.renders.rendersRating) {
        truthy(`${label} rating absence stated`, /no numeric score/.test(p));
      }

      // no price/currency language in the absence-enforced ban (owner system-wide)
      truthy(`${label} price ban in absences`, /no price, currency symbol/.test(p));
      // no product name (owner constraint)
      truthy(`${label} product-name ban in absences`, /no product name/.test(p));

      // core never sacrificed
      for (const c of eff.core) {
        falsy(`${label} core ${c} kept`, r.dropped.includes(c));
      }

      // If the requested intent's core was missing, we must have fallen back
      // rather than rendered that intent hollow.
      const requestedSpec = INTENTS[intentKey];
      const coreMissing = requestedSpec.core.some((role) => {
        if (role === 'RATING') return !d.rating;
        if (role === 'CUSTOMER QUOTE') return !d.quote;
        return false;
      });
      if (coreMissing) {
        check(`${label} did not run hollow requested intent`,
          r.resolved.key !== intentKey || requestedSpec.core.length === 0, true);
        if (r.resolved.key !== intentKey) {
          check(`${label} fellBackFrom is requested`, r.resolved.fellBackFrom, intentKey);
        }
      }

      console.log(short + `ok ${String(r.text.length)} el, ${p.length}c -> ${r.resolved.key}${fellBack}${droppedNote}`);
    }
  }
}

// ── D. describeSurfaces is pure + complete ──────────────────────────────
console.log('\nD. describeSurfaces() inspection helper');
const rows = describeSurfaces();
truthy('describeSurfaces returns a non-empty array', Array.isArray(rows) && rows.length > 0);
// Policy keys must all be present. describeSurfaces may also list
// coming_soon table entries (UI-only formats) — those are extra, not a miss.
check('describeSurfaces covers every SURFACE_POLICY key',
  surfaces.every((s) => rows.some((r) => r.surface === s)),
  true);
for (const row of rows) {
  truthy(`${row.surface}: has generate size`, !!row.generate);
  truthy(`${row.surface}: has box`, row.box && typeof row.box.left === 'number');
  truthy(`${row.surface}: has geometry string`, typeof row.geometry === 'string' && row.geometry.length > 0);
  truthy(`${row.surface}: geometry starts with FORMAT`, /^FORMAT:/.test(row.geometry));
}

// ── E. brand_led intent + additive-safety (SUBHEAD / rendersSubhead) ────
// brand_led is reachable only as an explicitly requested intent (not in
// FALLBACK_ORDER). SUBHEAD was added to SACRIFICE_ORDER and absences gained a
// rendersSubhead branch — both must be additive: every pre-existing intent's
// prompt must stay free of "subhead" in any case. Flipping the absences
// condition to `!rendersSubhead || ...` would silently rewrite every existing
// prompt; E6 is the permanent form of that guard.
console.log('\nE. brand_led intent shape, reachability, density, additive-safety');

/** Count `  <role> -> <string>` lines in the SET EXACTLY block (same parse as C). */
const countEmittedStrings = (prompt) => {
  const textBlock = (prompt || '').split('SET EXACTLY THESE STRINGS')[1]?.split('Set no other words')[0] || '';
  return textBlock.split('\n').filter((l) => /^\s*.+?\s*->\s*.+$/.test(l)).length;
};

// E1 shape
{
  const bl = INTENTS.brand_led;
  truthy('E1 brand_led exists', !!bl);
  check('E1 core is [BRAND LINE]', bl && bl.core, ['BRAND LINE']);
  check('E1 rendersSubhead true', bl && bl.renders && bl.renders.rendersSubhead, true);
  check('E1 rendersQuote false', bl && bl.renders && bl.renders.rendersQuote, false);
  check('E1 rendersBadge false', bl && bl.renders && bl.renders.rendersBadge, false);
  check('E1 rendersRating true', bl && bl.renders && bl.renders.rendersRating, true);
}

// E2 reachability — never selected as a fallback from any other requested intent
{
  const otherKeys = intents.filter((k) => k !== 'brand_led');
  const reachData = [
    ['RICH', DATA.RICH],
    ['rating_only', { rating: '4.8', cta: 'SHOP NOW' }],
    ['quote_only', { quote: 'Fits great.', cta: 'SHOP NOW' }],
    ['empty', {}]
  ];
  for (const requested of otherKeys) {
    for (const [dataKey, d] of reachData) {
      const r = resolveIntent(requested, d);
      check(`E2 ${requested}/${dataKey} never resolves to brand_led`, r.key !== 'brand_led', true);
    }
  }
}

// E3 eligible brand_led stays on brand_led
{
  const r = resolveIntent('brand_led', { headline: 'Built for salt', cta: 'SHOP NOW' });
  check("E3 brand_led + headline stays brand_led", r.key, 'brand_led');
}

// E4 degradation, not hollow render
{
  const cases = [
    ['rating_only', { rating: '4.8', cta: 'SHOP NOW' }],
    ['quote_only', { quote: 'Fits great.', cta: 'SHOP NOW' }],
    ['cta_only', { cta: 'SHOP NOW' }]
  ];
  for (const [name, d] of cases) {
    const r = resolveIntent('brand_led', d);
    check(`E4 brand_led + ${name} is not brand_led`, r.key !== 'brand_led', true);
    truthy(`E4 brand_led + ${name} is a real intent key`, !!r.key && !!INTENTS[r.key]);
    check(`E4 brand_led + ${name} fellBackFrom is brand_led`, r.fellBackFrom, 'brand_led');
  }
}

// E5 slot counts with full brand_led data
// Phase A expected pmax_16_9 to emit 4 (CTA drawn). Phase B with
// PMAX_STATIC_PLATFORM_NOTES ON suppresses CTA for brand_led on every
// pmax_* surface — same 3-string shape as Stories (headline + subhead +
// trust mark). Meta feed surfaces still emit 4.
{
  const full = { headline: 'Built for salt', subhead: 'Every tide.', rating: '4.8', cta: 'SHOP NOW' };
  const fourStringSurfaces = ['meta_feed_1_1', 'meta_feed_4_5'];
  for (const surface of fourStringSurfaces) {
    const r = buildPrompt({ intentKey: 'brand_led', data: full, product: PRODUCT, surface });
    const n = countEmittedStrings(r.prompt);
    check(`E5 brand_led/${surface} emits 4 strings`, n, 4);
    check(`E5 brand_led/${surface} count <= maxTextElements`,
      n <= SURFACE_POLICY[surface].maxTextElements, true);
  }
  // Stories: SURFACE_POLICY.drawCta false. PMax: Phase B intent-aware
  // suppress for brand_led. Both emit 3 (CTA stripped).
  const threeStringSurfaces = ['meta_stories_9_16', 'pmax_16_9'];
  for (const surface of threeStringSurfaces) {
    const r = buildPrompt({ intentKey: 'brand_led', data: full, product: PRODUCT, surface });
    const n = countEmittedStrings(r.prompt);
    check(`E5 brand_led/${surface} emits 3 strings (CTA stripped)`, n, 3);
    check(`E5 brand_led/${surface} count <= maxTextElements`,
      n <= SURFACE_POLICY[surface].maxTextElements, true);
  }
}

// E6 additive-safety: no "subhead" in any pre-existing intent's prompt
{
  const otherKeys = intents.filter((k) => k !== 'brand_led');
  for (const intentKey of otherKeys) {
    for (const surface of surfaces) {
      for (const [dataKey, d] of Object.entries(DATA)) {
        const r = buildPrompt({ intentKey, data: d, product: PRODUCT, surface });
        if (r.skipped || r.error || !r.prompt) continue;
        falsy(`E6 ${intentKey}/${surface}/${dataKey} no "subhead" in prompt`,
          /subhead/i.test(r.prompt));
      }
    }
  }
}

// E7 brand_led states subhead absence when no subhead supplied
{
  const r = buildPrompt({
    intentKey: 'brand_led',
    data: { headline: 'X', cta: 'SHOP NOW' },
    product: PRODUCT,
    surface: 'meta_feed_1_1'
  });
  truthy('E7 brand_led without subhead states no subheading',
    /no subheading/i.test(r.prompt || ''));
}

// E8 kill-switch export
{
  check('E8 BRAND_LED_COPY is exported boolean', typeof BRAND_LED_COPY, 'boolean');
}

// ── F. Phase B resolveDrawCta truth table + flag-off pmax Phase A restore ──
// F1: surface family × resolved intent → drawCta (flag ON, default).
// F2: with PMAX_STATIC_PLATFORM_NOTES=false, every pmax surface reverts to
//     SURFACE_POLICY.drawCta (true) for all intents — Phase A behaviour.
console.log('\nF. resolveDrawCta truth table (Phase B) + flag-off Phase A restore');

{
  check('F0 PMAX_STATIC_PLATFORM_NOTES export is boolean',
    typeof PMAX_STATIC_PLATFORM_NOTES, 'boolean');
  check('F0 resolveDrawCta is exported function',
    typeof resolveDrawCta, 'function');
  // Default arm is ON (env unset or not the string "false").
  truthy('F0 PMAX_STATIC_PLATFORM_NOTES default ON in this process',
    PMAX_STATIC_PLATFORM_NOTES === true);
}

// F1 — truth table, flag ON (current module load).
// Meta: always SURFACE_POLICY.drawCta (Stories false; feed true).
// PMax: true IFF resolved intent === 'objection_resolved'.
{
  const intentKeys = Object.keys(INTENTS);
  const metaSurfaces = surfaces.filter((s) => !String(s).startsWith('pmax_'));
  const pmaxSurfaces = surfaces.filter((s) => String(s).startsWith('pmax_'));

  for (const surface of metaSurfaces) {
    const policy = SURFACE_POLICY[surface];
    if (!policy || !policy.static) continue;
    for (const intentKey of intentKeys) {
      const got = resolveDrawCta({ surfaceKey: surface, policy, intentKey });
      check(`F1 meta ${surface}/${intentKey} drawCta === policy.drawCta`,
        got, policy.drawCta);
    }
  }
  for (const surface of pmaxSurfaces) {
    const policy = SURFACE_POLICY[surface];
    if (!policy || !policy.static) continue;
    for (const intentKey of intentKeys) {
      const expected = intentKey === 'objection_resolved';
      const got = resolveDrawCta({ surfaceKey: surface, policy, intentKey });
      check(`F1 pmax ${surface}/${intentKey} drawCta === ${expected}`,
        got, expected);
    }
  }
}

// F2 — flag OFF restores Phase A: every pmax surface drawCta true for all
// intents, and buildPrompt emits CTA on pmax for non-Stories-style paths.
// Invalidate BOTH staticAdIntents and platformFormats (documented trap:
// invalidating only one can silently pin the wrong build).
{
  const intentsKey = require.resolve('../services/staticAdIntents');
  const pfKey = require.resolve('../services/platformFormats');
  const prev = process.env.PMAX_STATIC_PLATFORM_NOTES;
  delete require.cache[intentsKey];
  delete require.cache[pfKey];
  process.env.PMAX_STATIC_PLATFORM_NOTES = 'false';
  let offMod;
  try {
    offMod = require('../services/staticAdIntents');
  } finally {
    // Restore env for any later require; re-load default arm below.
    if (prev === undefined) delete process.env.PMAX_STATIC_PLATFORM_NOTES;
    else process.env.PMAX_STATIC_PLATFORM_NOTES = prev;
  }

  check('F2 flag-off: PMAX_STATIC_PLATFORM_NOTES is false',
    offMod.PMAX_STATIC_PLATFORM_NOTES, false);

  const intentKeys = Object.keys(offMod.INTENTS);
  const pmaxSurfaces = Object.keys(offMod.SURFACE_POLICY)
    .filter((s) => String(s).startsWith('pmax_'));
  for (const surface of pmaxSurfaces) {
    const policy = offMod.SURFACE_POLICY[surface];
    if (!policy || !policy.static) continue;
    for (const intentKey of intentKeys) {
      const got = offMod.resolveDrawCta({ surfaceKey: surface, policy, intentKey });
      check(`F2 flag-off resolveDrawCta ${surface}/${intentKey} === policy.drawCta`,
        got, policy.drawCta);
      // Phase A: all live/frozen pmax static surfaces stamp drawCta:true.
      check(`F2 flag-off ${surface}/${intentKey} policy.drawCta is true (Phase A)`,
        policy.drawCta, true);
    }
  }

  // Prompt-level pin: brand_led on pmax_16_9 emits CTA again (4 strings).
  {
    const full = { headline: 'Built for salt', subhead: 'Every tide.', rating: '4.8', cta: 'SHOP NOW' };
    const r = offMod.buildPrompt({
      intentKey: 'brand_led', data: full, product: PRODUCT, surface: 'pmax_16_9'
    });
    const textBlock = (r.prompt || '').split('SET EXACTLY THESE STRINGS')[1]
      ?.split('Set no other words')[0] || '';
    truthy('F2 flag-off brand_led/pmax_16_9 CTA present in text block',
      CTA_RE.test(textBlock));
    check('F2 flag-off brand_led/pmax_16_9 emits 4 strings (Phase A)',
      countEmittedStrings(r.prompt), 4);
  }

  // Drop the flag-off module so a later require reloads the default arm.
  delete require.cache[intentsKey];
  delete require.cache[pfKey];
  if (prev === undefined) delete process.env.PMAX_STATIC_PLATFORM_NOTES;
  else process.env.PMAX_STATIC_PLATFORM_NOTES = prev;
}

console.log(`\n${fail === 0 ? '✅' : '❌'} verifyStaticIntents: ${pass}/${pass + fail} checks passed\n`);
if (fail) {
  console.log('FAILURES:');
  failures.forEach(f => console.log('  ✗ ' + f));
}
process.exit(fail === 0 ? 0 : 1);
