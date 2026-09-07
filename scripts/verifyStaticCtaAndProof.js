#!/usr/bin/env node
// verifyStaticCtaAndProof — two delivered-static defects from
// run_1786555875841_2ddf9739 (AllBirds "Men's Cruiser - Natural White").
//
// DEFECT 1 — meta_stories_9_16 shipped with no CTA while 1:1 and 1.91:1 both
// painted "Shop the Cruiser". Hypothesis to test, not assume: the Stories
// safe box squeezed the slot out.
//
// FINDING (a), not (b) or (c). Live logs 2026-08-12T17:34Z:
//   1:1   text=2  intent=objection_resolved (fell back from social_proof_led)
//   4:5   text=2  same
//   9:16  text=1  same intent — CTA stripped
//   1.91  text=2  same
// SURFACE_POLICY.meta_stories_9_16.drawCta was false, so buildPrompt filtered
// CTA BUTTON out and absences forbade a button. The 9:16 box is the largest
// Meta usable band in generated pixels (~1334h vs 1:1's ~901h). Geometry did
// not squeeze anything — the prompt never asked.
//
// DEFECT 2 — no rating or review count on any of the four, despite template
// ai_social_proof_led (whose core IS the rating).
//
// FINDING: descent fired. Same logs:
//   proof: source=product-count rating=none count=11 quoteTier=product
//   intent=objection_resolved(fell back from social_proof_led)
// Eligible did NOT pass with a null rating. The product pair failed the
// star floor, a count of 11 produced source:'product-count' (rating null),
// and that short-circuits the labelled-brand-stars exception (CLAUDE.md
// accepted residual C7e). resolveIntent then walked FALLBACK_ORDER to
// objection_resolved, which typesets the quote and no rating. That is a
// DATA CONDITION, not a code bug — do not invent a rating. Ad.template
// staying ai_social_proof_led is the REQUESTED template; delivered intent
// is on Ad.intentResolution.delivered.
//
// This harness therefore:
//   A. pins that every live Meta static REQUESTS a CTA (including 9:16)
//      and that a CTA slot fits inside every live static safe box
//   B. pins that an unsatisfiable core descends FALLBACK_ORDER
//   C. pins the three ratingDisplay constraints that LOOK optional and
//      are not (=== true, brand count required, allowBrandCountWithoutStars
//      stays false)
//
// REVERT-PROVEN — each mutation confirmed to fail the named check:
//   - drawCta:false on meta_stories_9_16                         → A1 / A2
//   - put 'CTA BUTTON' into SACRIFICE_ORDER                      → A3
//   - social_proof_led.eligible always returns null              → B1
//   - skip FALLBACK_ORDER and stay on the requested intent       → B2
//   - allowLabeledBrandNumbers truthy-gate (`if (flag)`)         → C1
//   - drop the brand-count requirement on the exception          → C2
//   - allowBrandCountWithoutStars: true in the exception         → C8
//     (C3 is the USER-VISIBLE outcome — a 3.1/40 pair prints
//     nothing. Flipping only the flag still returns empty because
//     `exPair.source === 'brand' && exPair.rating` discards
//     brand-count. C8 is the unique pin of constraint (c).)
//
// REMOVED 2026-09-07: group B used to include B5 ("THE RUN") and B6, which
// built their `data` fixture via `buildIntentData` (the cascade that turned
// raw layoutInput/brand/product social-proof fields into the plain
// `{rating, quote, ...}` shape `resolveIntent` reads) to reconstruct the
// exact product-count residual from run_1786555875841_2ddf9739 end-to-end.
// `buildIntentData` lived in services/directImageRenderService.js and was
// deleted along with `renderDirectImage` (the mint-time static-ad render
// entry point) as part of removing the dormant in-process render fallback —
// adgen owns rendering unconditionally now, and neither name is exported
// any more. B1-B4 and B7 below still cover the FALLBACK_ORDER descent logic
// itself (`resolveIntent` in services/staticAdIntents.js, still live) by
// constructing the already-cascaded `data` shape directly, so that coverage
// is intact; only the buildIntentData-cascade reconstruction of the real
// run's raw inputs is gone.
//
// Calls the REAL functions (resolveIntent / computeSurface / buildPrompt /
// resolveCoherentSocialProof) against synthetic inputs.
// No DB, no network, no API key.
//
// Run: node scripts/verifyStaticCtaAndProof.js

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const pf = require('../services/platformFormats');
const {
  INTENTS,
  SURFACE_POLICY,
  SACRIFICE_ORDER,
  FALLBACK_ORDER,
  buildPrompt,
  resolveIntent,
  computeSurface,
  resolveDrawCta,
  applyDensity
} = require('../services/staticAdIntents');
const rd = require('../services/ratingDisplay');

let checks = 0;
const ok = (label, fn) => {
  try { fn(); checks += 1; }
  catch (err) {
    console.error(`  ❌ ${label}\n     ${err.message}`);
    process.exitCode = 1;
  }
};

console.log('verifyStaticCtaAndProof\n');

const PRODUCT = {
  desc: "Men's Cruiser in Natural White — wool upper, sugarcane foam midsole",
  look: 'quiet California light, pale walls, unforced lifestyle',
  logoCorner: 'bottom-right'
};
const CTA = 'Shop the Cruiser';
const RICH = {
  rating: '4.8', reviewCount: 240, reviewsText: '240 reviews',
  quote: 'The most comfortable shoe I own.', attribution: 'Verified Buyer',
  headline: 'Walk lighter.', cta: CTA
};
const QUOTE_ONLY = {
  rating: null, reviewCount: null, quote: 'The most comfortable shoe I own.',
  attribution: 'Verified Buyer', headline: 'Walk lighter.', cta: CTA
};
const BARE = {
  rating: null, reviewCount: null, quote: null, attribution: null,
  headline: null, cta: CTA
};

const LIVE_META_STATIC = [...pf.META_STATIC_FANOUT];
const LIVE_GOOGLE_STATIC = [...pf.GOOGLE_STATIC_FANOUT];
const LIVE_STATIC = [...LIVE_META_STATIC, ...LIVE_GOOGLE_STATIC];

// Conservative CTA pill in GENERATED pixels. "Shop the Cruiser" at ~14px
// is ~140 wide; 160×48 leaves room for padding. A slot that cannot hold
// this cannot hold the button the feed surfaces actually painted.
const CTA_MIN_W = 160;
const CTA_MIN_H = 48;
const CTA_INSET = 8;

function boxPx(surface) {
  const s = computeSurface(surface);
  const [gw, gh] = String(s.generate).split('x').map(Number);
  const x0 = (s.box.left / 100) * gw;
  const x1 = (s.box.right / 100) * gw;
  const y0 = (s.box.top / 100) * gh;
  const y1 = (s.box.bottom / 100) * gh;
  return { s, gw, gh, x0, x1, y0, y1, w: x1 - x0, h: y1 - y0 };
}

function textRoles(built) {
  return (built.text || []).map(([role]) => role);
}

function textBlockOf(prompt) {
  return (prompt || '').split('SET EXACTLY THESE STRINGS')[1]?.split('Set no other words')[0] || '';
}

// ── A. CTA requested + slot fits ───────────────────────────────────────
console.log('A. every live Meta static requests a CTA; the slot fits every live box');

ok('A0 live Meta static fanout is the three Meta image surfaces', () => {
  assert.deepStrictEqual(LIVE_META_STATIC.sort(),
    ['meta_feed_1_1', 'meta_feed_4_5', 'meta_stories_9_16'].sort());
});

// ⚠️ STORIES DRAWS NO IN-IMAGE CTA, AND THAT IS THE DECISION — owner-reaffirmed
// 2026-08-13. Stories supplies its own link sticker, so a burned-in button is a
// DUPLICATE that also burns the reserved band.
//
// This assertion was briefly inverted (drawCta:true) after the audit of
// run_1786555875841_2ddf9739 read the absent button as a defect. The owner
// confirmed the original reasoning stands. It is pinned in THIS direction now
// so the round trip does not happen a third time.
//
// The geometry is deliberately NOT the reason and must not be cited as one:
// Stories has ~1331px of usable height against the 1:1's ~901px — 48% MORE
// room. A0c measures that, so a future reader cannot mistake policy for a
// squeeze.
ok('A0b [OWNER] Stories draws NO in-image CTA — the platform supplies the sticker', () => {
  assert.strictEqual(SURFACE_POLICY.meta_stories_9_16.static, true);
  assert.strictEqual(SURFACE_POLICY.meta_stories_9_16.drawCta, false,
    'Stories link sticker is owner-stated and reaffirmed — an in-image button duplicates it');
  assert.ok(/link affordance/i.test(SURFACE_POLICY.meta_stories_9_16.ctaNote || ''),
    'the ctaNote is the reason-of-record; losing it is how this got "fixed" once already');
});

ok('A0c [DIAGNOSTIC] Stories is not CTA-less for lack of room', () => {
  // Recorded so nobody re-derives it. If Stories is ever given a burned-in CTA,
  // the change belongs in SURFACE_POLICY — the safe box was never the blocker.
  const st = computeSurface('meta_stories_9_16');
  const sq = computeSurface('meta_feed_1_1');
  const usable = (s) => {
    const [, h] = String(s.generate).split('x').map(Number);
    return Math.round(h * (s.box.bottom - s.box.top) / 100);
  };
  assert.ok(usable(st) > usable(sq),
    `Stories usable height ${usable(st)}px must exceed the 1:1's ${usable(sq)}px — `
    + 'if this ever flips, the "no room" theory becomes worth revisiting');
});

for (const surface of LIVE_META_STATIC) {
  for (const intentKey of ['social_proof_led', 'objection_resolved', 'product_first_lifestyle', 'brand_led']) {
    // Stories is the deliberate exception; the other two live Meta statics draw one.
    const expected = surface !== 'meta_stories_9_16';
    ok(`A1 ${surface}/${intentKey} resolveDrawCta is ${expected}`, () => {
      const policy = SURFACE_POLICY[surface];
      assert.strictEqual(resolveDrawCta({ surfaceKey: surface, policy, intentKey }), expected);
    });
  }
}

// Feed surfaces request the button. Stories is asserted separately, in the
// opposite direction, because its absence is the DECISION rather than a gap.
for (const surface of LIVE_META_STATIC.filter((s) => s !== 'meta_stories_9_16')) {
  ok(`A2 ${surface} prompt REQUESTS the CTA string (social_proof_led + RICH)`, () => {
    const r = buildPrompt({
      intentKey: 'social_proof_led', data: RICH, product: PRODUCT, surface
    });
    assert.ok(r.prompt, `no prompt for ${surface}: ${r.error || r.skipped}`);
    assert.ok(textRoles(r).includes('CTA BUTTON'),
      `${surface} kept roles: ${textRoles(r).join(',')}`);
    assert.ok(textBlockOf(r.prompt).includes(CTA),
      `${surface} text block does not contain ${JSON.stringify(CTA)}`);
    assert.ok(!/no CTA button/.test(r.prompt),
      `${surface} still forbids a CTA in absences`);
    assert.strictEqual(r.policy.drawCta, true);
  });
}

ok('A2s [OWNER] Stories prompt does NOT request a CTA, and says so in absences', () => {
  // Both halves matter and they must agree. Stripping the role without the
  // absence line is the empty-slot defect that produced a fabricated quote in
  // v1: the model sees a gap and fills it.
  const r = buildPrompt({
    intentKey: 'social_proof_led', data: RICH, product: PRODUCT, surface: 'meta_stories_9_16'
  });
  assert.ok(r.prompt, `no prompt: ${r.error || r.skipped}`);
  assert.ok(!textRoles(r).includes('CTA BUTTON'),
    `Stories asked for a CTA BUTTON; roles: ${textRoles(r).join(',')}`);
  assert.ok(/no CTA button/i.test(r.prompt),
    'Stories must FORBID the button in absences, not merely omit the role');
  assert.strictEqual(r.policy.drawCta, false);
});

ok('A2b Stories 9:16 on the production residual intent: quote yes, CTA no', () => {
  // This is the exact combination the delivered ad ran — social_proof_led
  // falling back to objection_resolved. The DESCENT is what this pins; the
  // absent button is policy (the platform draws the sticker), not a gap.
  const r = buildPrompt({
    intentKey: 'social_proof_led', data: QUOTE_ONLY, product: PRODUCT, surface: 'meta_stories_9_16'
  });
  assert.strictEqual(r.resolved.key, 'objection_resolved');
  assert.ok(textRoles(r).includes('CUSTOMER QUOTE'),
    `stories 9:16 kept ${textRoles(r).join(',')} — the quote is this intent's core`);
  assert.ok(!textRoles(r).includes('CTA BUTTON'),
    'Stories must not burn in a button — Instagram supplies the link sticker');
});

ok('A3 CTA is not in SACRIFICE_ORDER — density cannot drop the button', () => {
  assert.ok(!SACRIFICE_ORDER.includes('CTA BUTTON'),
    'putting CTA in SACRIFICE_ORDER lets Stories budget 3 drop the button');
});

// ── A3c: CTA must not DISPLACE real copy either — owner correction, 2026-08-13.
// A3 protects the button FROM being dropped. It does nothing about the button
// eating a slot and forcing something ELSE out — which is the exact mechanism
// class behind the earlier Stories regression (drawCta:true + budget:3 pushed
// SUBHEAD out). Live today, not hypothetical: pmax_landscape_1_91_1 is
// budget-3 and draws a CTA for objection_resolved/conversion.
ok('A3c [OWNER] a CTA never displaces prose on a tight budget', () => {
  const text = [
    ['BRAND LINE', 'Allbirds'], ['SUBHEAD', 'Every tide.'],
    ['TRUST MARK', '4.8 / 2,667'], ['CTA BUTTON', 'Shop Now']
  ];
  const { kept, dropped } = applyDensity(text, { core: ['BRAND LINE'] }, { maxTextElements: 3 });
  assert.deepStrictEqual(dropped, [],
    `budget 3 + 3 prose roles + a CTA dropped ${JSON.stringify(dropped)} — the button is costing a real copy slot`);
  assert.ok(kept.some(([r]) => r === 'CTA BUTTON'), 'the CTA itself must still render');
  assert.ok(kept.some(([r]) => r === 'SUBHEAD'),
    'SUBHEAD must survive alongside the CTA — this is the exact class that broke Stories');
});

ok('A3d prose still respects its own budget — CTA exclusion is not a blank cheque', () => {
  // Four real copy roles on a budget-3 surface, no CTA in play at all: the
  // budget must still bite. A3c proves CTA is free; this proves everything
  // ELSE still costs a slot as before.
  const text = [
    ['BRAND LINE', 'Allbirds'], ['SUBHEAD', 'Every tide.'],
    ['TRUST MARK', '4.8 / 2,667'], ['RATING', '4.8']
  ];
  const { kept, dropped } = applyDensity(text, { core: ['BRAND LINE'] }, { maxTextElements: 3 });
  assert.strictEqual(kept.length, 3, `expected exactly 3 kept, got ${kept.length}`);
  assert.ok(dropped.length >= 1, 'four prose roles on a budget-3 surface must still sacrifice one');
});

ok('A3b Stories brand_led spends its budget on copy, not a duplicate button', () => {
  // With no burned-in CTA, Stories' budget of 3 buys real copy. That is the
  // POINT of the sticker policy, not a side effect: the reserved band stays
  // clear and the three slots go to the message.
  const r = buildPrompt({
    intentKey: 'brand_led',
    data: { headline: 'Walk lighter.', subhead: 'Wool, all day.', rating: '4.8', cta: CTA },
    product: PRODUCT,
    surface: 'meta_stories_9_16'
  });
  const roles = textRoles(r);
  assert.ok(!roles.includes('CTA BUTTON'), `Stories asked for a button; kept ${roles.join(',')}`);
  assert.ok(roles.includes('BRAND LINE'), `BRAND LINE is brand_led's core; kept ${roles.join(',')}`);
  assert.ok(roles.length <= SURFACE_POLICY.meta_stories_9_16.maxTextElements,
    `${roles.length} roles exceeds the density budget of ${SURFACE_POLICY.meta_stories_9_16.maxTextElements}`);
});

for (const surface of LIVE_STATIC) {
  ok(`A4 ${surface} CTA slot (160×48) fits inside the safe box`, () => {
    const b = boxPx(surface);
    assert.ok(b.w > 0 && b.h > 0, `${surface} degenerate box ${JSON.stringify(b.s.box)}`);
    assert.ok(b.w >= CTA_MIN_W,
      `${surface} box width ${b.w.toFixed(1)}px < CTA min ${CTA_MIN_W}`);
    assert.ok(b.h >= CTA_MIN_H + CTA_INSET,
      `${surface} box height ${b.h.toFixed(1)}px cannot hold a ${CTA_MIN_H}px button`);
    // Place the pill on the bottom edge of the box, centred — the usual
    // "Shop now" landing. The whole rectangle must stay inside.
    const ctaLeft = (b.x0 + b.x1 - CTA_MIN_W) / 2;
    const ctaTop = b.y1 - CTA_INSET - CTA_MIN_H;
    assert.ok(ctaLeft >= b.x0 - 1e-6 && ctaLeft + CTA_MIN_W <= b.x1 + 1e-6,
      `${surface} centred CTA overflows horizontally`);
    assert.ok(ctaTop >= b.y0 - 1e-6 && ctaTop + CTA_MIN_H <= b.y1 + 1e-6,
      `${surface} bottom-aligned CTA overflows vertically`);
  });
}

ok('A5 [NOT A SQUEEZE] Stories usable height is larger than 1:1, not smaller', () => {
  // The hypothesis was "9:16 safeAreaPct {top/bottom: 0.1406} squeezes CTA
  // out". Usable generated pixels say the opposite. If this fails, the
  // geometry story has changed and the diagnosis needs a re-read.
  const stories = boxPx('meta_stories_9_16');
  const square = boxPx('meta_feed_1_1');
  assert.ok(stories.h > square.h,
    `stories usable ${stories.h.toFixed(0)}px is not taller than 1:1 ${square.h.toFixed(0)}px`);
  assert.ok(stories.h > 1000,
    `stories usable ${stories.h.toFixed(0)}px is far larger than a 48px button`);
});

ok('A6 PMax CTA policy is unchanged — not this defect', () => {
  // Do not "fix" 9:16 by also rewriting PMax. Flag-on PMax still suppresses
  // CTA except on objection_resolved.
  for (const surface of LIVE_GOOGLE_STATIC) {
    const policy = SURFACE_POLICY[surface];
    assert.strictEqual(
      resolveDrawCta({ surfaceKey: surface, policy, intentKey: 'social_proof_led' }),
      false,
      `${surface} social_proof_led should still suppress CTA`
    );
    assert.strictEqual(
      resolveDrawCta({ surfaceKey: surface, policy, intentKey: 'objection_resolved' }),
      true,
      `${surface} objection_resolved should still draw CTA`
    );
  }
});

// ── B. unsatisfiable core descends FALLBACK_ORDER ──────────────────────
console.log('B. unsatisfiable core descends; the Cruiser residual is a data condition');

ok('B1 social_proof_led + no rating is NOT selected (eligible does not pass hollow)', () => {
  const r = resolveIntent('social_proof_led', QUOTE_ONLY);
  assert.notStrictEqual(r.key, 'social_proof_led',
    'eligible passed with a null rating — that is the hollow-intent bug');
  assert.strictEqual(r.fellBackFrom, 'social_proof_led');
  assert.ok(r.key && INTENTS[r.key], `landed on unknown intent ${r.key}`);
});

ok('B2 quote-only lands on objection_resolved (core = CUSTOMER QUOTE)', () => {
  const r = resolveIntent('social_proof_led', QUOTE_ONLY);
  assert.strictEqual(r.key, 'objection_resolved');
  assert.ok(INTENTS.objection_resolved.core.includes('CUSTOMER QUOTE'));
});

ok('B3 no rating + no quote lands on product_first_lifestyle (the floor)', () => {
  const r = resolveIntent('social_proof_led', BARE);
  assert.strictEqual(r.key, 'product_first_lifestyle');
  assert.strictEqual(r.fellBackFrom, 'social_proof_led');
});

ok('B4 FALLBACK_ORDER is social_proof → objection → product_first', () => {
  assert.deepStrictEqual(FALLBACK_ORDER,
    ['social_proof_led', 'objection_resolved', 'product_first_lifestyle']);
});

ok('B7 brand_led with no headline also descends rather than rendering hollow', () => {
  const r = resolveIntent('brand_led', { rating: '4.8', cta: CTA });
  assert.notStrictEqual(r.key, 'brand_led');
  assert.strictEqual(r.fellBackFrom, 'brand_led');
  assert.ok(r.key && INTENTS[r.key]);
});

// ── C. three ratingDisplay constraints that LOOK optional and are not ──
console.log('C. allowLabeledBrandNumbers constraints (=== true, count required, no brand-count)');

const commentQuote = { text: 'Unbelievably comfortable for long days.', tier: 'comment' };
const brandPair = { rating: 4.6, reviewCount: 15000 };

const resolveLabeled = (over = {}) => rd.resolveCoherentSocialProof({
  quote: commentQuote,
  product: null,
  brand: brandPair,
  brandAttribution: 'allbirds.com',
  renderedQuoteText: commentQuote.text,
  ...over
});

ok('C1 === true, not truthiness — string "false" must not opt in', () => {
  for (const truthyString of ['false', 'FALSE', '0', 'no']) {
    const r = resolveLabeled({ allowLabeledBrandNumbers: truthyString });
    assert.strictEqual(r.rating, null,
      `the string ${JSON.stringify(truthyString)} opted in — gate must be === true`);
    assert.strictEqual(r.reviewCount, null);
  }
  const on = resolveLabeled({ allowLabeledBrandNumbers: true });
  assert.strictEqual(on.rating, '4.6');
  assert.ok(/brand review/i.test(on.reviewsText || ''),
    `scope label missing: ${on.reviewsText}`);
});

ok('C2 a stars-only brand pair is refused — no count means no label vehicle', () => {
  const r = resolveLabeled({
    allowLabeledBrandNumbers: true,
    brand: { rating: 4.7, reviewCount: null }
  });
  assert.strictEqual(r.rating, null,
    `stars-only brand pair printed ${r.rating} with reviewsText=${JSON.stringify(r.reviewsText)}`);
  assert.strictEqual(r.reviewCount, null);
});

ok('C3 sub-floor brand pair prints nothing (stars or count)', () => {
  // Combined outcome of the star floor + the exception whitelist
  // (`source === 'brand' && rating`). NOT a unique pin of constraint (c) —
  // flipping only allowBrandCountWithoutStars still returns empty because
  // brand-count is discarded at the whitelist. C8 pins (c) itself.
  const r = resolveLabeled({
    allowLabeledBrandNumbers: true,
    brand: { rating: 3.1, reviewCount: 40 }
  });
  assert.strictEqual(r.rating, null, `a 3.1 must never print stars, got ${r.rating}`);
  assert.strictEqual(r.reviewCount, null,
    `a sub-floor brand pair must not print a count either, got ${r.reviewCount}`);
  assert.notStrictEqual(r.source, 'brand-count');
});

ok('C4 product-count still short-circuits the exception (accepted residual, this run)', () => {
  // The Cruiser case: product 3.2 / 11 → product-count, brand 3.8 / 2667
  // cannot displace it. social_proof_led stays ineligible. Do NOT "fix"
  // this by letting brand numbers displace a product-tier number.
  const r = rd.resolveCoherentSocialProof({
    quote: { text: 'The Cruiser is the most comfortable shoe I own.', tier: 'product' },
    product: { rating: 3.2, reviewCount: 11 },
    brand: { rating: 3.8, reviewCount: 2667 },
    brandAttribution: 'allbirds.com',
    renderedQuoteText: 'The Cruiser is the most comfortable shoe I own.',
    allowLabeledBrandNumbers: true
  });
  assert.strictEqual(r.source, 'product-count');
  assert.strictEqual(r.rating, null);
  assert.strictEqual(r.reviewCount, 11);
});

ok('C5 default is OFF so video/every other caller is unchanged by construction', () => {
  const r = resolveLabeled(); // no allowLabeledBrandNumbers
  assert.strictEqual(r.rating, null, 'default-on would leak brand stars onto video');
});

// Source pins — a future edit that rewrites the exception to look the same
// under today's fixtures still fails these. Comments stripped first so the
// check cannot pass on its own prose.
{
  const ratingSrc = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'ratingDisplay.js'), 'utf8'
  ).replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

  ok('C6 source: opt-in gate is === true (not truthy)', () => {
    assert.ok(/allowLabeledBrandNumbers\s*===\s*true/.test(ratingSrc),
      'the exception gate is no longer `=== true`');
  });
  ok('C7 source: exception requires a normalized brand count', () => {
    assert.ok(/exBrandCount\s*!=\s*null/.test(ratingSrc),
      'the brand-count requirement on the exception is gone');
  });
  ok('C8 source: exception calls resolveAtomicRatingPair with allowBrandCountWithoutStars: false', () => {
    const gate = ratingSrc.indexOf('allowLabeledBrandNumbers === true');
    assert.ok(gate > 0, 'cannot find the exception gate');
    const window = ratingSrc.slice(gate, gate + 800);
    assert.ok(/allowBrandCountWithoutStars:\s*false/.test(window),
      'the exception no longer forces allowBrandCountWithoutStars: false');
  });
}

if (process.exitCode) {
  console.log(`\n❌ verifyStaticCtaAndProof: failures above (${checks} passed)`);
} else {
  console.log(`\n✅ verifyStaticCtaAndProof: ${checks}/${checks} checks passed`);
}
