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
  describeSurfaces
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
      const textBlock = p.split('SET EXACTLY THESE STRINGS')[1]?.split('Set no other words')[0] || '';
      if (!policy.drawCta) {
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
check('describeSurfaces covers every SURFACE_POLICY key',
  rows.map(r => r.surface).sort().join(','),
  surfaces.slice().sort().join(','));
for (const row of rows) {
  truthy(`${row.surface}: has generate size`, !!row.generate);
  truthy(`${row.surface}: has box`, row.box && typeof row.box.left === 'number');
  truthy(`${row.surface}: has geometry string`, typeof row.geometry === 'string' && row.geometry.length > 0);
  truthy(`${row.surface}: geometry starts with FORMAT`, /^FORMAT:/.test(row.geometry));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} verifyStaticIntents: ${pass}/${pass + fail} checks passed\n`);
if (fail) {
  console.log('FAILURES:');
  failures.forEach(f => console.log('  ✗ ' + f));
}
process.exit(fail === 0 ? 0 : 1);
