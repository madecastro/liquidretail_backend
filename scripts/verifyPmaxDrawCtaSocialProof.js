#!/usr/bin/env node
/**
 * Behavioural regression harness for the PMax in-image CTA allowlist in
 * `resolveDrawCta` (src/services/staticAdIntents.js). No DB, no network.
 *
 * THE REGRESSION THIS EXISTS FOR, measured with real `buildPrompt()` calls,
 * 2026-08-24: a sibling PR (fix/ugc-intent-and-proof-gate, #34) widens
 * `INTENTS.social_proof_led.eligible` so a usable customer quote ALONE (no
 * numeric rating) is enough for that intent to run — see
 * `STATIC_SOCIAL_PROOF_QUOTE_ELIGIBLE` on that branch. Before the widening,
 * quote-only data failed social_proof_led's rating-only eligibility and fell
 * through FALLBACK_ORDER to objection_resolved instead — which
 * `resolveDrawCta` already allowlists for the PMax in-image CTA. After the
 * widening, the IDENTICAL quote-only ad resolves to social_proof_led
 * directly, and social_proof_led was not on the allowlist: all four
 * `pmax_*` statics silently lost their in-image CTA for this data shape —
 * the CTA tuple was removed from `text` entirely, not merely de-ranked.
 * Meta was unaffected (Meta never consults this allowlist at all).
 *
 * GAP THIS FILLS: verifyStaticCtaDeterminism.js exercises Meta surfaces only
 * (meta_stories_9_16, meta_feed_1_1) and never calls `resolveDrawCta` or any
 * `pmax_*` surface — this allowlist had zero prior coverage.
 *
 * THE FIX, in `resolveDrawCta`: the allowlist grows by exactly one case —
 * social_proof_led resolving WITHOUT a rating (i.e. the render is, in
 * substance, the same risk-reversal-quote ad objection_resolved was built
 * for; it only wears the social_proof_led label because eligibility now
 * lets a quote alone qualify). Deliberately NOT a blanket
 * `intentKey === 'social_proof_led'` — that would also flip the CTA on for
 * the existing, unmeasured, unaffected population of RATED social_proof_led
 * PMax ads (the common, priority-1 case), which nobody asked for and this
 * harness explicitly pins as unchanged (group A "RATED ... unaffected").
 *
 * Groups:
 *   A  resolveDrawCta direct unit coverage — the real allowlist function,
 *      every pmax_* surface x every relevant intent/data combination, plus
 *      Meta held constant throughout.
 *   B  buildPrompt END-TO-END for the exact regression data shape. Because
 *      the coordination rule for this fix is "touch resolveDrawCta only,
 *      never INTENTS.social_proof_led" (avoiding a three-way conflict with
 *      PR #34 and a second in-flight PR on the same object), the sibling
 *      PR's not-yet-merged eligible/core/text widening is reproduced
 *      IN-MEMORY ONLY for the duration of this block (see the comment
 *      there) so the real resolveIntent -> resolveDrawCta -> applyDensity ->
 *      text pipeline runs against the post-#34 world without merging that
 *      branch or editing staticAdIntents.js's INTENTS object on disk.
 *   C  Flag-off revert-proof for PMAX_DRAWCTA_QUOTE_ONLY_SOCIAL_PROOF, run
 *      in a child process (the flag is read once from process.env at
 *      module load, so it cannot be toggled in-process after require).
 *
 * Run: node scripts/verifyPmaxDrawCtaSocialProof.js
 */
'use strict';
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * SUPERSEDED IN THE DEFAULT WORLD — 2026-08-24 owner decision. This harness
 * pins PR #42's ALLOWLIST: the PMax in-image CTA granted to objection_resolved
 * plus a quote-only social_proof_led, and withheld from everything else. That
 * allowlist is no longer what ships. PMAX_STATIC_CTA_ALL_INTENTS (default ON)
 * makes every pmax_* static draw the button on every intent, and #42's
 * allowlist is now reachable only with that switch OFF.
 *
 * So this file pins the OFF arm, deliberately and explicitly, rather than
 * being deleted — same discipline as the Stories CTA revert (#200), which
 * inverted its harness sites instead of removing them so a later unreviewed
 * flip fails a test immediately. Everything below still protects the #42
 * branch: it is the revert path, and PMAX_STATIC_CTA_ALL_INTENTS's own
 * contract is that turning it off restores #42 byte-identically.
 *
 * The ON arm — what actually ships — is pinned by
 * scripts/verifyPmaxCtaAllIntents.js, which also asserts from the other side
 * that this branch survives the OFF arm (its check C2e).
 *
 * MUST be set before requiring staticAdIntents: the flag is read once at
 * module load. Child processes spawned below inherit it, which is intended.
 */
process.env.PMAX_STATIC_CTA_ALL_INTENTS = 'false';

const intents = require('../src/services/staticAdIntents');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const PMAX_SURFACES = ['pmax_16_9', 'pmax_landscape_1_91_1', 'pmax_square_1_1', 'pmax_portrait_4_5'];
const META_SURFACES = ['meta_feed_1_1', 'meta_feed_4_5'];

// ── A: resolveDrawCta direct unit coverage ──────────────────────────────
for (const surface of PMAX_SURFACES) {
  const policy = intents.SURFACE_POLICY[surface];

  const quoteOnly = intents.resolveDrawCta({
    surfaceKey: surface, policy, intentKey: 'social_proof_led',
    data: { quote: 'Fixed my back pain in two weeks', rating: null }
  });
  check(`A ${surface}: quote-only social_proof_led draws the CTA (the fix)`, quoteOnly === true);

  const rated = intents.resolveDrawCta({
    surfaceKey: surface, policy, intentKey: 'social_proof_led',
    data: { quote: 'Fixed my back pain in two weeks', rating: 4.8 }
  });
  check(`A ${surface}: RATED social_proof_led is UNAFFECTED (still no CTA)`, rated === false, `got ${rated}`);

  const neither = intents.resolveDrawCta({
    surfaceKey: surface, policy, intentKey: 'social_proof_led', data: {}
  });
  check(`A ${surface}: social_proof_led with neither quote nor rating never draws a CTA`, neither === false);

  const ratingNoQuote = intents.resolveDrawCta({
    surfaceKey: surface, policy, intentKey: 'social_proof_led',
    data: { rating: 4.8, quote: null }
  });
  check(`A ${surface}: rating-only social_proof_led (no quote) unaffected (still no CTA)`, ratingNoQuote === false);

  const conversion = intents.resolveDrawCta({
    surfaceKey: surface, policy, intentKey: 'objection_resolved', data: { quote: 'x' }
  });
  check(`A ${surface}: objection_resolved unaffected (still draws CTA)`, conversion === true);

  const lifestyle = intents.resolveDrawCta({
    surfaceKey: surface, policy, intentKey: 'product_first_lifestyle', data: {}
  });
  check(`A ${surface}: product_first_lifestyle unaffected (still no CTA)`, lifestyle === false);

  const brandLed = intents.resolveDrawCta({
    surfaceKey: surface, policy, intentKey: 'brand_led', data: { quote: 'x' }
  });
  check(`A ${surface}: brand_led unaffected (still no CTA, quote is irrelevant there)`, brandLed === false);

  // Omitted `data` entirely must not throw and must not accidentally grant a CTA.
  let omittedDataResult, omittedDataThrew = false;
  try {
    omittedDataResult = intents.resolveDrawCta({ surfaceKey: surface, policy, intentKey: 'social_proof_led' });
  } catch (e) { omittedDataThrew = true; }
  check(`A ${surface}: omitted data arg does not throw`, omittedDataThrew === false);
  check(`A ${surface}: omitted data arg defaults safely to no-CTA`, omittedDataResult === false);
}

// Meta must never be rewritten by this allowlist regardless of intent/data —
// resolveDrawCta must return exactly SURFACE_POLICY.drawCta for every Meta
// surface, unconditionally.
for (const surface of [...META_SURFACES, 'meta_stories_9_16']) {
  const policy = intents.SURFACE_POLICY[surface];
  for (const intentKey of ['social_proof_led', 'objection_resolved', 'product_first_lifestyle', 'brand_led']) {
    for (const data of [{ quote: 'x', rating: null }, { quote: 'x', rating: 4.8 }, {}]) {
      const r = intents.resolveDrawCta({ surfaceKey: surface, policy, intentKey, data });
      check(`A ${surface}/${intentKey}/${JSON.stringify(data)}: matches SURFACE_POLICY.drawCta (${policy.drawCta}) unchanged`,
        r === policy.drawCta);
    }
  }
}

// ── B: buildPrompt end-to-end for the exact regression data shape ──────
{
  const spec = intents.INTENTS.social_proof_led;
  const original = { eligible: spec.eligible, core: spec.core, text: spec.text };

  // Mirrors PR #34's literal diff to eligible/core/text (quoted verbatim in
  // spirit, not copy-pasted from that branch) — IN MEMORY ONLY, for this
  // block, restored in `finally` below. staticAdIntents.js on disk is never
  // touched; this lets the real buildPrompt -> resolveIntent ->
  // resolveDrawCta -> applyDensity pipeline run against the post-#34 world
  // this fix targets, without merging or depending on that unmerged branch.
  spec.eligible = (d) => (d.rating || d.quote) ? null : 'no rating or usable quote — this intent is the proof';
  // core is a literal array here (not the function PR #34 uses) because
  // this repo's applyDensity still calls `spec.core.includes(role)` directly
  // — PR #34's own diff also updates applyDensity to resolve either shape,
  // a change this fix deliberately does not carry (out of scope: touches
  // neither resolveDrawCta nor INTENTS). A literal array is sufficient and
  // correct for the fixed quote-only data used in this block.
  spec.core = ['CUSTOMER QUOTE'];
  // text: gate the RATING tuple on d.rating so a rating-less render does not
  // print the literal string "null ★" — same gate PR #34 adds.
  spec.text = (d) => [
    d.rating ? ['RATING', d.reviewsText ? `${d.rating} ★ (${d.reviewsText})`
      : d.reviewCount ? `${d.rating} ★ (${d.reviewCount} reviews)` : `${d.rating} ★`] : null,
    d.quote ? ['CUSTOMER QUOTE', `"${d.quote}"`] : null,
    d.quote && d.attribution ? ['ATTRIBUTION', `— ${d.attribution}`] : null,
    d.badge ? ['BADGE', d.badge] : null,
    ['CTA BUTTON', d.cta]
  ].filter(Boolean);

  try {
    const quoteOnlyData = {
      quote: 'This fixed my chronic back pain in two weeks',
      attribution: 'Jamie R.',
      rating: null,
      reviewCount: null,
      badge: null,
      cta: 'Shop now',
      headline: null
    };

    for (const surface of PMAX_SURFACES) {
      const built = intents.buildPrompt({ intentKey: 'social_proof_led', data: quoteOnlyData, product: {}, surface });
      check(`B ${surface}: quote-only data resolves to social_proof_led (not a fallback)`,
        !!built.resolved && built.resolved.key === 'social_proof_led',
        `got ${JSON.stringify(built.resolved && built.resolved.key)}`);
      const hasCta = built.text.some(([role]) => role === 'CTA BUTTON');
      check(`B ${surface}: [THE REGRESSION, FIXED] quote-only social_proof_led KEEPS the in-image CTA`,
        hasCta === true);
      check(`B ${surface}: no stray "null ★" / "undefined ★" leaked into text`,
        !built.text.some(([, v]) => typeof v === 'string' && /(?:null|undefined)\s*★/.test(v)));
    }

    // Meta unaffected: identical quote-only data + identical simulated
    // eligibility widening, but resolveDrawCta never consults intentKey for
    // Meta, so CTA presence must match today's SURFACE_POLICY exactly.
    for (const surface of META_SURFACES) {
      const built = intents.buildPrompt({ intentKey: 'social_proof_led', data: quoteOnlyData, product: {}, surface });
      const policy = intents.SURFACE_POLICY[surface];
      const hasCta = built.text.some(([role]) => role === 'CTA BUTTON');
      check(`B ${surface}: Meta quote-only social_proof_led CTA matches SURFACE_POLICY.drawCta (${policy.drawCta}) — unaffected`,
        hasCta === policy.drawCta);
    }

    // RATED social_proof_led on PMax: no widening needed for this case (the
    // original, unpatched eligible already accepts a rating) — proved here
    // anyway, inside the same widened-eligible world, that a rated render is
    // byte-identical in CTA outcome: still no CTA. This is the "already-live,
    // unmeasured, deliberately NOT changed by this fix" population named in
    // the file header above.
    const ratedData = { ...quoteOnlyData, rating: 4.8, reviewCount: 900 };
    for (const surface of PMAX_SURFACES) {
      const built = intents.buildPrompt({ intentKey: 'social_proof_led', data: ratedData, product: {}, surface });
      check(`B ${surface}: rated data resolves to social_proof_led`,
        built.resolved.key === 'social_proof_led');
      const hasCta = built.text.some(([role]) => role === 'CTA BUTTON');
      check(`B ${surface}: RATED social_proof_led on PMax is UNAFFECTED by this fix (still no CTA)`,
        hasCta === false);
    }
  } finally {
    spec.eligible = original.eligible;
    spec.core = original.core;
    spec.text = original.text;
  }

  // Restore-proof: the monkeypatch above must be fully undone, so this harness
  // cannot leak state into any script that runs after it in the same suite.
  //
  // UPDATED 2026-08-24. These two checks asserted the PRE-#34 world: that the
  // real eligible REJECTS quote-only data. PR #34 has since merged, and by
  // explicit owner direction a usable quote alone IS proof — so quote-only now
  // resolves social_proof_led rather than descending to objection_resolved.
  // The product code is correct and these assertions were stale; they are
  // updated to the new behaviour. NOT "fixed" by narrowing eligible() again —
  // that would revert an owner directive while showing a green suite.
  //
  // The teardown proof itself is now IDENTITY against `original`, the captures
  // taken before the patch was installed. It must NOT be written against
  // intents.INTENTS.social_proof_led: `spec` IS that object, so such a check
  // reads `X.eligible === X.eligible` and passes whether or not `finally` ran.
  // Verified by neutering the teardown — this form fails, that form does not.
  check('B restore-proof: teardown restored the exact pre-patch eligible/text/core references',
    spec.eligible === original.eligible
    && spec.text === original.text
    && spec.core === original.core);
  check('B restore-proof: the real (merged #34) eligible accepts quote-only data',
    spec.eligible({ quote: 'x', rating: null }) === null);
  const realBuilt = intents.buildPrompt({
    intentKey: 'social_proof_led',
    data: { quote: 'This fixed my chronic back pain', cta: 'Shop now' },
    product: {}, surface: 'pmax_16_9'
  });
  check('B restore-proof: real buildPrompt() resolves social_proof_led for quote-only data (post-#34)',
    realBuilt.resolved.key === 'social_proof_led', `got ${JSON.stringify(realBuilt.resolved.key)}`);
}

// ── C: flag-off revert-proof (child process — env is read at module load) ──
{
  const probe = `
    const intents = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'services', 'staticAdIntents.js'))});
    const r = intents.resolveDrawCta({
      surfaceKey: 'pmax_16_9',
      policy: intents.SURFACE_POLICY.pmax_16_9,
      intentKey: 'social_proof_led',
      data: { quote: 'x', rating: null }
    });
    process.stdout.write(JSON.stringify({ flag: intents.PMAX_DRAWCTA_QUOTE_ONLY_SOCIAL_PROOF, drawCta: r }));
  `;
  const onOut = execFileSync(process.execPath, ['-e', probe], {
    encoding: 'utf8', env: { ...process.env, PMAX_DRAWCTA_QUOTE_ONLY_SOCIAL_PROOF: undefined }
  });
  const onResult = JSON.parse(onOut);
  check('C flag defaults ON when unset', onResult.flag === true);
  check('C flag ON: quote-only social_proof_led on pmax_16_9 draws the CTA', onResult.drawCta === true);

  const offOut = execFileSync(process.execPath, ['-e', probe], {
    encoding: 'utf8', env: { ...process.env, PMAX_DRAWCTA_QUOTE_ONLY_SOCIAL_PROOF: 'false' }
  });
  const offResult = JSON.parse(offOut);
  check('C flag OFF: PMAX_DRAWCTA_QUOTE_ONLY_SOCIAL_PROOF reads false', offResult.flag === false);
  check('C-revert-prove: flag OFF restores the pre-fix allowlist byte-identically (no CTA for quote-only social_proof_led)',
    offResult.drawCta === false, `got ${JSON.stringify(offResult)}`);
}

if (failures.length) {
  console.error(`\n❌ pmax drawCta / social_proof_led: ${failures.length} FAILED, ${pass} passed\n`);
  failures.forEach((f) => console.error(`   • ${f}`));
  process.exit(1);
}
console.log(`✅ pmax drawCta / social_proof_led: ${pass} checks passed`);
