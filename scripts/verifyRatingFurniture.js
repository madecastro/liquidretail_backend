#!/usr/bin/env node
'use strict';

/**
 * verifyRatingFurniture — offline, behavioural pins for the social_proof_led
 * rating-as-furniture fix + the universal-endorsement copy ban.
 *
 * THE DEFECT (three delivered ads, 2026-08-24)
 * --------------------------------------------
 * `ai_social_proof_led`'s core IS the rating. In all three of these it
 * rendered a rating CLAIM as the headline and no proof furniture at all:
 *   1. Soludos, meta_feed_4_5:     "Rated 5 Stars By Everyone Who's Tried Them"
 *   2. Soludos, meta_stories_9_16: same string
 *   3. Pelagic, pmax_landscape_1_91_1: "5-star brand-wide rating"
 *
 * (1)/(2) is an unqualified universal endorsement printed with nothing on
 * frame to support it. (3) shows the honesty mechanism's scope label arrived
 * and the image model paraphrased it into a headline. Video (Remotion)
 * composites literal furniture; only the static gpt-image-2 path paraphrases.
 *
 * Two layers, one flag (`STATIC_RATING_FURNITURE`, default ON):
 *   A. static prompt — demand a star-glyph widget; invert the star-row BAN
 *      that made a sentence the only legal rating mark.
 *   B. Director copy contract — validateDirectorPayload rejects the same
 *      language, stated in the round prompt so the validator is not silent.
 *
 * REMOVED (dormant render fallback deletion): E4 (`buildIntentData` still
 * hands over scoped reviewsText). That function was deleted with
 * `renderDirectImage`; adgen owns static rendering unconditionally now.
 * Surviving coverage is the live `staticAdIntents` rating-furniture prompt
 * text, `resolveIntent` descent, and Director validation. The scoped
 * `reviewsText` itself is still authored by `ratingDisplay.js` (C-group of
 * verifySocialProofRestoration / verifyStaticCtaAndProof).
 *
 * Calls the REAL buildPrompt / validateDirectorPayload /
 * copyFailsCompliance / resolveIntent. No source scan of a constraint that
 * can be asserted by calling.
 *
 * REVERT-PROOF
 * ------------
 * Flag-off IS the revert. Every flag-on check below is paired with the
 * assertion that the flag-off prompt/validator FAILS it — backing the fix
 * out (or flipping the flag) turns those checks red, which is the proof
 * they can fail. Additional mechanical mutations, each confirmed to fail
 * the named check:
 *   a) delete RATING_FURNITURE_NOTE emission          → A2 / A3
 *   b) restore the "ONLY rating mark permitted" ban
 *      on social_proof_led                            → A4
 *   c) drop copyFailsCompliance from the validator    → C1
 *   d) hollow UNIVERSAL_ENDORSEMENT_PATTERNS          → B1 / C1
 *   e) drop the kill switch from defaults.env         → F4
 *
 * Offline: no DB, no network, no API key.
 *   node scripts/verifyRatingFurniture.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const ORIGINAL_FURNITURE = process.env.STATIC_RATING_FURNITURE;
const ORIGINAL_MENU = process.env.DIRECTOR_PROOF_MENU_ENABLED;
const DEFAULTS_ENV = path.join(__dirname, '..', 'config/defaults.env');

const MUST_BLOCK = [
  "Rated 5 Stars By Everyone Who's Tried Them",
  'Rated 5 Stars By Everyone Who\'s Tried Them',
  '5-star brand-wide rating'
];
const MUST_KEEP = [
  'Rated 4.8 by 2,341 verified buyers',
  'Highly rated by the runners who log 50-mile weeks'
];

const PRODUCT = {
  desc: 'Soludos Classic Lace-Up Espadrille in Natural — canvas upper, jute midsole.',
  look: 'sunlit coastal, natural canvas, easy summer',
  logoCorner: 'bottom-right'
};

const PROOF_DATA = {
  rating: '5.0',
  reviewCount: 41000,
  reviewsText: '41000 brand reviews',
  quote: 'The most comfortable shoe I own.',
  attribution: 'Dana',
  headline: 'Walk lighter.',
  cta: 'Shop Now'
};

function restoreEnv() {
  if (ORIGINAL_FURNITURE === undefined) delete process.env.STATIC_RATING_FURNITURE;
  else process.env.STATIC_RATING_FURNITURE = ORIGINAL_FURNITURE;
  if (ORIGINAL_MENU === undefined) delete process.env.DIRECTOR_PROOF_MENU_ENABLED;
  else process.env.DIRECTOR_PROOF_MENU_ENABLED = ORIGINAL_MENU;
  try {
    delete require.cache[require.resolve('../services/adCopyGuards')];
    delete require.cache[require.resolve('../services/staticAdIntents')];
    delete require.cache[require.resolve('../services/aiCreativeDirectorService')];
    delete require.cache[require.resolve('../services/directImageRenderService')];
  } catch (_) { /* ignore */ }
}

/**
 * Re-require staticAdIntents under a specific furniture-flag value.
 * `undefined` unsets the env var (default-ON path).
 */
function loadIntents(flag) {
  const key = require.resolve('../services/staticAdIntents');
  const guardKey = require.resolve('../services/adCopyGuards');
  delete require.cache[key];
  delete require.cache[guardKey];
  if (flag === undefined) delete process.env.STATIC_RATING_FURNITURE;
  else process.env.STATIC_RATING_FURNITURE = flag;
  return require('../services/staticAdIntents');
}

function loadGuards(flag) {
  const key = require.resolve('../services/adCopyGuards');
  delete require.cache[key];
  if (flag === undefined) delete process.env.STATIC_RATING_FURNITURE;
  else process.env.STATIC_RATING_FURNITURE = flag;
  return require('../services/adCopyGuards');
}

function loadDirector() {
  const key = require.resolve('../services/aiCreativeDirectorService');
  delete require.cache[key];
  delete require.cache[require.resolve('../services/adCopyGuards')];
  return require('../services/aiCreativeDirectorService');
}

const SURFACES = ['meta_feed_4_5', 'meta_stories_9_16', 'pmax_landscape_1_91_1'];

const OLD_PROOF_MENU = 'your words MUST carry that option\'s own scope (e.g. "loved across our whole line" / "brand-wide")';
const NEW_PROOF_MENU = 'do NOT put the number or "brand-wide" in the headline';
const FURNITURE_DIRECTOR_RULE = 'RATING IS FURNITURE, NOT A HEADLINE';

function conceptPayload(headlines) {
  return {
    concepts: headlines.map((headline, i) => ({
      copy: { headline, subheadline: null, eyebrow: null, cta: 'Shop' },
      routing: { creative_style: i === 0 ? 'social_proof_led' : 'brand_led' }
    }))
  };
}

const THREE_KEEP = conceptPayload([
  MUST_KEEP[0],
  MUST_KEEP[1],
  'Built for the long haul'
]);

try {
  // ── Sanity: loadIntents actually flips the const ──────────────────────
  {
    const on = loadIntents(undefined);
    const off = loadIntents('false');
    const on2 = loadIntents('true');
    check('loadIntents: unset ships RATING_FURNITURE true', on.RATING_FURNITURE === true);
    check('loadIntents: "false" ships RATING_FURNITURE false', off.RATING_FURNITURE === false);
    check('loadIntents: "true" ships RATING_FURNITURE true', on2.RATING_FURNITURE === true);
    check('loadIntents: on and off differ', on.RATING_FURNITURE !== off.RATING_FURNITURE);
  }

  // ── A. static prompt, social_proof_led ────────────────────────────────
  console.log('A. static prompt — furniture demand on social_proof_led');
  {
    const on = loadIntents(undefined);
    const off = loadIntents('false');

    for (const surface of SURFACES) {
      const onR = on.buildPrompt({
        intentKey: 'social_proof_led', data: PROOF_DATA, product: PRODUCT, surface
      });
      const offR = off.buildPrompt({
        intentKey: 'social_proof_led', data: PROOF_DATA, product: PRODUCT, surface
      });
      const tag = surface;

      check(`A0 ${tag}: both arms built a prompt`,
        typeof onR.prompt === 'string' && typeof offR.prompt === 'string');
      check(`A0 ${tag}: stayed social_proof_led`,
        onR.resolved && onR.resolved.key === 'social_proof_led'
        && offR.resolved && offR.resolved.key === 'social_proof_led');

      const onP = onR.prompt || '';
      const offP = offR.prompt || '';

      // A1 — SET EXACTLY still carries the scoped rating string. Scope stays
      // attached to the number; we relocate how it is DRAWN, not the string.
      check(`A1 ${tag} ON: RATING string still in SET EXACTLY`,
        onP.includes('rating -> ') && onP.includes('41000 brand reviews'));
      check(`A1 ${tag} OFF: RATING string still in SET EXACTLY`,
        offP.includes('rating -> ') && offP.includes('41000 brand reviews'));

      // A2 — furniture note present flag-on, absent flag-off (revert-proof:
      // the OFF prompt fails this check).
      check(`A2 ${tag} ON: furniture note present`,
        onP.includes(on.RATING_FURNITURE_NOTE));
      check(`A2 ${tag} OFF: furniture note ABSENT (revert)`,
        !offP.includes(on.RATING_FURNITURE_NOTE));
      check(`A2 ${tag} ON: demands a review widget`,
        /review widget/.test(onP) && /star glyphs/.test(onP));
      check(`A2 ${tag} OFF: does NOT demand a review widget (revert)`,
        !/review widget/.test(offP));

      // A3 — measured claim-headlines named as failures, so a prose restatement
      // cannot satisfy the demand.
      check(`A3 ${tag} ON: names Soludos claim as failure`,
        onP.includes('Rated 5 stars by everyone'));
      check(`A3 ${tag} ON: names Pelagic claim as failure`,
        onP.includes('5-star brand-wide rating'));
      check(`A3 ${tag} OFF: does not name those claims (revert)`,
        !offP.includes('Rated 5 stars by everyone')
        && !offP.includes('5-star brand-wide rating'));

      // A4 — invert the star-row ban on this intent only.
      check(`A4 ${tag} ON: does NOT ban the star row`,
        !onP.includes('ONLY rating mark permitted'));
      check(`A4 ${tag} OFF: restores the star-row ban (revert)`,
        offP.includes('ONLY rating mark permitted'));
      check(`A4 ${tag} ON: furniture absence present`,
        onP.includes(on.RATING_FURNITURE_ABSENCE));
      check(`A4 ${tag} OFF: furniture absence ABSENT (revert)`,
        !offP.includes(on.RATING_FURNITURE_ABSENCE));

      // A5 — goal no longer invites "everyone".
      check(`A5 ${tag} ON: goal is the widget`,
        onP.includes('The rating is those marks, not a sentence about them'));
      check(`A5 ${tag} OFF: original "many real people" goal (revert)`,
        offP.includes('many real people already bought this and rate it highly'));
      check(`A5 ${tag} ON: original goal gone`,
        !onP.includes('many real people already bought this and rate it highly'));

      // A6 — furniture note sits AFTER SET EXACTLY, never above it.
      const onSet = onP.indexOf('SET EXACTLY THESE STRINGS');
      const onNote = onP.indexOf(on.RATING_FURNITURE_NOTE);
      check(`A6 ${tag} ON: furniture note after SET EXACTLY`,
        onSet >= 0 && onNote > onSet);

      // A6b — catch-all "no mark not in the text" must not forbid the glyph
      // row (self-contradictory-prompt class, PR #61). Flag-off keeps the
      // original sentence with no exception.
      check(`A6b ${tag} ON: catch-all carves out the star-glyph row`,
        onP.includes('except the star-glyph row the rating widget requires'));
      check(`A6b ${tag} OFF: original catch-all, no furniture carve-out`,
        offP.includes('if a word, numeral or mark is not in the text above, it does not belong in the image')
        && !offP.includes('except the star-glyph row the rating widget requires'));
      check(`A6b ${tag} ON: furniture note says the glyph row is not extra copy`,
        onP.includes('not extra copy, and not a violation of SET EXACTLY THESE STRINGS'));

      // A7 — flag-off vs a fresh off is the previous prompt: the two OFF
      // builds are equal to each other; ON differs from OFF.
      check(`A7 ${tag}: ON prompt differs from OFF prompt`, onP !== offP);
    }

    // A8 — other intents are byte-identical across the flag (no blast radius).
    const OTHER = ['product_first_lifestyle', 'brand_led', 'objection_resolved'];
    const otherData = { ...PROOF_DATA, headline: 'Walk lighter.', quote: 'Fits true to size.' };
    for (const intentKey of OTHER) {
      for (const surface of SURFACES) {
        const onP = on.buildPrompt({
          intentKey, data: otherData, product: PRODUCT, surface
        }).prompt;
        const offP = off.buildPrompt({
          intentKey, data: otherData, product: PRODUCT, surface
        }).prompt;
        check(`A8 ${intentKey}/${surface}: byte-identical across furniture flag`,
          onP === offP,
          onP === offP ? '' : `len on=${(onP || '').length} off=${(offP || '').length}`);
      }
    }
  }

  // ── B. copyFailsCompliance — the detector the validator calls ──────────
  console.log('B. copyFailsCompliance detector (shared, behavioural)');
  {
    const guards = loadGuards(undefined);

    for (const h of MUST_BLOCK) {
      const fail = guards.copyFailsCompliance(h);
      check(`B1 MUST-BLOCK ${JSON.stringify(h)}`,
        !!fail,
        fail ? '' : 'detector returned null — this headline would ship');
    }
    // Distinct codes: Soludos is universal-endorsement, Pelagic is scope-as-headline.
    check('B1 Soludos code is universal-endorsement',
      guards.copyFailsCompliance(MUST_BLOCK[0])?.code === 'universal-endorsement');
    check('B1 Pelagic code is scope-as-headline',
      guards.copyFailsCompliance('5-star brand-wide rating')?.code === 'scope-as-headline');

    for (const h of MUST_KEEP) {
      const fail = guards.copyFailsCompliance(h);
      check(`B2 MUST-KEEP ${JSON.stringify(h)}`,
        fail == null,
        fail ? `blocked as ${fail.code}: ${fail.message}` : '');
    }
    check('B2 "rated" alone is not a ban',
      guards.copyFailsCompliance('Rated for the long haul') == null);

    // Close variants the image model actually produces.
    check('B3 smart-apostrophe everyone who\'s tried',
      guards.hasUniversalEndorsement("everyone who’s tried them") === true);
    check('B3 BY EVERYONE case-insensitive',
      guards.hasUniversalEndorsement('Loved BY EVERYONE') === true);
    check('B3 universally',
      guards.hasUniversalEndorsement('Universally adored canvas') === true);
    check('B3 all customers',
      guards.hasUniversalEndorsement('Loved by all customers') === true);
    check('B3 every customer',
      guards.hasUniversalEndorsement('Every customer comes back') === true);
    check('B3 "everyone" alone is NOT enough (not a blanket ban)',
      guards.hasUniversalEndorsement('Not for everyone') === false);
    check('B3 "brand reviews" is NOT "brand-wide"',
      guards.hasScopeAsHeadline('41000 brand reviews') === false);
  }

  // ── C. validateDirectorPayload — the copy contract ─────────────────────
  console.log('C. validateDirectorPayload (real function)');
  {
    process.env.STATIC_RATING_FURNITURE = 'true';
    const directorOn = loadDirector();

    for (const h of MUST_BLOCK) {
      const reasons = directorOn.validateDirectorPayload(
        conceptPayload([h, MUST_KEEP[0], MUST_KEEP[1]])
      );
      check(`C1 ON MUST-BLOCK ${JSON.stringify(h)} is rejected`,
        reasons.some((r) => /universal-endorsement|brand-wide|never emittable/i.test(r)),
        `reasons=${JSON.stringify(reasons)}`);
    }

    const keepReasons = directorOn.validateDirectorPayload(THREE_KEEP);
    check('C2 ON MUST-KEEP headlines are accepted',
      keepReasons.length === 0,
      `reasons=${JSON.stringify(keepReasons)}`);

    // Flag-off: the validator does NOT reject the measured headlines.
    // That is the revert-proof of C1 — backing the scan out (flag-off)
    // lets those headlines through.
    process.env.STATIC_RATING_FURNITURE = 'false';
    const directorOff = loadDirector();
    for (const h of MUST_BLOCK) {
      const reasons = directorOff.validateDirectorPayload(
        conceptPayload([h, MUST_KEEP[0], MUST_KEEP[1]])
      );
      check(`C3 OFF MUST-BLOCK ${JSON.stringify(h)} is NOT rejected (revert)`,
        !reasons.some((r) => /universal-endorsement|brand-wide|never emittable/i.test(r)),
        `reasons=${JSON.stringify(reasons)}`);
    }

    // Pricing ban is independent of this flag — still fires flag-off.
    const priced = directorOff.validateDirectorPayload(
      conceptPayload(['$40 off today', MUST_KEEP[0], MUST_KEEP[1]])
    );
    check('C4 OFF still rejects pricing (unrelated scan untouched)',
      priced.some((r) => /pricing or discount/i.test(r)),
      `reasons=${JSON.stringify(priced)}`);
  }

  // ── D. Director round prompt ───────────────────────────────────────────
  console.log('D. Director round prompt (real buildPromptRound)');
  {
    const UNIVERSE = [{ mediaId: 'm1', role: 'hero', fileType: 'image', metadata: {} }];
    const summary = {
      brand_signal: { name: 'Acme', tagline: null, description: null, tone: [], brand_reviews_summary: null, has_logo: false },
      product_signal: { name: 'Widget', category: null, description: null, price: null, currency: null, availability: null, review_summary: null, priority: 'high' },
      ugc_signal: { media_strength: 'absent', shot_type_distribution: {}, content_nature_distribution: {}, file_type_distribution: {}, primary_subjects: [], top_creator: null },
      social_proof_signal: {
        rating: 5, primary_quote: null, top_comments: [], strongest_signal: 'rating', proof_density: 1,
        proof_options: [{ tier: 'brand', rating: 5, review_count: 41000, reviews_text: '41000 brand reviews', quotes: [] }]
      },
      performance_signal: { likes: null, comments: null, saves: null, shares: null, avg_engagement_rate: null, strength: 'absent', top_post: null }
    };

    process.env.DIRECTOR_PROOF_MENU_ENABLED = 'true';
    process.env.STATIC_RATING_FURNITURE = 'true';
    const directorOn = loadDirector();
    const on = directorOn.buildPromptRound({
      inputSummary: summary, creativeIntent: null, platformFormat: 'meta_feed_1_1',
      universe: UNIVERSE, roundIndex: 0, avoidList: []
    });

    process.env.STATIC_RATING_FURNITURE = 'false';
    const directorOff = loadDirector();
    const off = directorOff.buildPromptRound({
      inputSummary: summary, creativeIntent: null, platformFormat: 'meta_feed_1_1',
      universe: UNIVERSE, roundIndex: 0, avoidList: []
    });

    check('D1 ON: furniture rule in system prompt',
      on.system.includes(FURNITURE_DIRECTOR_RULE));
    check('D1 OFF: furniture rule ABSENT (byte-identity of the revert)',
      !off.system.includes(FURNITURE_DIRECTOR_RULE));

    check('D2 ON: proof menu relocates brand-wide',
      on.system.includes(NEW_PROOF_MENU));
    check('D2 ON: old brand-wide-as-copy instruction gone',
      !on.system.includes(OLD_PROOF_MENU));
    check('D2 OFF: original proof menu restored (revert)',
      off.system.includes(OLD_PROOF_MENU));
    check('D2 OFF: new relocation instruction ABSENT',
      !off.system.includes(NEW_PROOF_MENU));

    check('D3 ON prompt is not byte-identical to OFF (the flag does work)',
      on.system !== off.system);

    // Menu-off + furniture-off: no PROOF MENU line (existing kill switch).
    process.env.DIRECTOR_PROOF_MENU_ENABLED = 'false';
    process.env.STATIC_RATING_FURNITURE = 'false';
    const bothOff = loadDirector().buildPromptRound({
      inputSummary: summary, creativeIntent: null, platformFormat: 'meta_feed_1_1',
      universe: UNIVERSE, roundIndex: 0, avoidList: []
    });
    check('D4 both flags off: no PROOF MENU line',
      !bothOff.system.includes('PROOF MENU'));
    check('D4 both flags off: no furniture rule',
      !bothOff.system.includes(FURNITURE_DIRECTOR_RULE));
  }

  // ── E. fallback / intent data / scope label stay attached ──────────────
  console.log('E. fallback, intent data, scope label');
  {
    const on = loadIntents(undefined);
    // E1 — no rating still falls back. Furniture cannot run hollow.
    const noRating = on.resolveIntent('social_proof_led', {
      quote: 'Love these.', cta: 'Shop Now'
    });
    check('E1 no rating: social_proof_led falls back (not a hollow claim)',
      noRating.key !== 'social_proof_led' && noRating.fellBackFrom === 'social_proof_led');

    // E2 — brand_led with no headline + a rating lands on social_proof_led
    // (the documented known-open descent). That descent now demands furniture
    // rather than printing an unsupported claim.
    const descent = on.resolveIntent('brand_led', {
      rating: '5.0', reviewCount: 100, reviewsText: '100 brand reviews', cta: 'Shop Now'
    });
    check('E2 brand_led + no headline + rating → social_proof_led',
      descent.key === 'social_proof_led' && descent.fellBackFrom === 'brand_led');
    const descentPrompt = on.buildPrompt({
      intentKey: 'brand_led',
      data: { rating: '5.0', reviewCount: 100, reviewsText: '100 brand reviews', cta: 'Shop Now' },
      product: PRODUCT,
      surface: 'meta_feed_4_5'
    });
    check('E2 descent prompt still demands the widget',
      (descentPrompt.prompt || '').includes('review widget')
      && descentPrompt.resolved.key === 'social_proof_led');

    // E3 — RATING is core, so density cannot drop it. Furniture is always
    // reachable when the intent is eligible.
    check('E3 social_proof_led.core is [RATING]',
      JSON.stringify(on.INTENTS.social_proof_led.core) === JSON.stringify(['RATING']));

    // E4 (`buildIntentData` still hands over scoped reviewsText) was removed
    // with `renderDirectImage`/`buildIntentData` (dormant render fallback
    // deletion, 2026-09-07). The prompt still consumes a scoped reviewsText
    // when one is supplied — pin that consumption, not the deleted cascade.
    const scoped = on.buildPrompt({
      intentKey: 'social_proof_led',
      data: {
        rating: '5.0',
        reviewCount: 41000,
        reviewsText: '41000 brand reviews',
        headline: MUST_KEEP[0],
        cta: 'SHOP NOW'
      },
      product: PRODUCT,
      surface: 'meta_feed_4_5'
    });
    check('E4 prompt still carries BRAND_SCOPE_LABEL from reviewsText',
      (scoped.prompt || '').includes('brand reviews'),
      `prompt missing scoped reviewsText`);
  }

  // ── F. kill switch is committed ────────────────────────────────────────
  console.log('F. defaults.env kill switch');
  {
    const envText = fs.readFileSync(DEFAULTS_ENV, 'utf8');
    check('F4 STATIC_RATING_FURNITURE=true is committed',
      /^STATIC_RATING_FURNITURE=true$/m.test(envText));
    check('F4 comment names the byte-identical revert',
      /STATIC_RATING_FURNITURE[\s\S]{0,800}BYTE-IDENTICAL/i.test(envText)
      || /BYTE-IDENTICAL[\s\S]{0,400}STATIC_RATING_FURNITURE/i.test(envText)
      || /false restores a BYTE-IDENTICAL/i.test(envText));
    // Default-ON: a typo'd env value must not silently ship the unfixed prompt.
    const guardsUnset = loadGuards(undefined);
    check('F1 unset (default) is ON', guardsUnset.ratingFurnitureEnabled() === true);
    const guardsFalse = loadGuards('false');
    check('F1 exact "false" is OFF', guardsFalse.ratingFurnitureEnabled() === false);
    const guardsTypo = loadGuards('False');
    check('F1 "False" (wrong case) stays ON — fail-closed toward the fix',
      guardsTypo.ratingFurnitureEnabled() === true);
  }

  // ── G. flag-off social_proof_led is the previous prompt, proven ────────
  // Collect a second OFF build and assert equality with the first OFF build
  // (stability), then assert a known fingerprint of the PRE-CHANGE prompt.
  console.log('G. flag-off fingerprint of the pre-change social_proof_led prompt');
  {
    const off = loadIntents('false');
    const p = off.buildPrompt({
      intentKey: 'social_proof_led', data: PROOF_DATA, product: PRODUCT, surface: 'meta_feed_4_5'
    }).prompt || '';
    check('G1 OFF still has SET EXACTLY THESE STRINGS',
      p.includes('SET EXACTLY THESE STRINGS'));
    check('G1 OFF still has the star-row fence',
      p.includes('the single rating string above is the ONLY rating mark permitted anywhere in the frame'));
    check('G1 OFF still has the original goal',
      p.includes('many real people already bought this and rate it highly'));
    check('G1 OFF has no furniture note',
      !p.includes('review widget'));
    check('G1 OFF has no measured-claim names',
      !p.includes('5-star brand-wide rating') && !p.includes('Rated 5 stars by everyone'));
  }

} catch (err) {
  failures.push(`FATAL: ${err && err.stack ? err.stack : err}`);
} finally {
  restoreEnv();
}

const total = pass + failures.length;
if (failures.length) {
  console.error(`\n❌ verifyRatingFurniture: ${failures.length} FAILED, ${pass} passed (of ${total})\n`);
  failures.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log(`\n✅ verifyRatingFurniture: ${pass} checks passed`);
