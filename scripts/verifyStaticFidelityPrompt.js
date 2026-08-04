#!/usr/bin/env node
/**
 * Offline harness for the static product-fidelity prompt hardening.
 * No DB, no network, no API key, no mongoose.
 *
 * Only `require('../services/staticAdIntents')` — reloaded with a cleared
 * require cache so both arms of the kill switch can be exercised in one
 * process. The module reads STATIC_PROMPT_FIDELITY_HARDENING once at require
 * time into a module-level const (FIDELITY_HARDENING). loadIntents(flag)
 * below deletes require.cache for that module, sets/clears the env var, then
 * re-requires. Verified: flag 'false' ships LEGACY_PRODUCT_FIDELITY; any other
 * value (including unset) ships PRODUCT_FIDELITY. platformFormats stays cached
 * across reloads (pure geometry table; not flag-dependent).
 *
 * Why this harness exists:
 *
 *   F1  Default is ON. A fail-open default means a typo'd env value silently
 *       ships the unhardened prompt — the opposite of a kill switch.
 *   F2  Flag-off is a COMPLETE revert (block + absences + textBlock carve-outs).
 *       A flag that reverts only the block and not the absences / textBlock
 *       carve-outs gives an A/B whose control arm is not the arm that produced
 *       the measured 139/140 text-fidelity baseline.
 *   F3  Flag-on, every load-bearing clause of PRODUCT_FIDELITY is present.
 *       Named per clause so a failure says which sentence was lost.
 *   F4  The pre-existing text contract is undamaged under flag-on. The
 *       hardening block was inserted ABOVE it; these fail loudly if a future
 *       edit displaces or truncates SET EXACTLY THESE STRINGS / the geometry
 *       block (still last, starts with FORMAT).
 *   F5  Both textBlock branches (with-copy and no-copy) carry the carve-out,
 *       anchored to the REFERENCE photograph not to "the product". The looser
 *       "already on the product" phrasing is a justification handle for
 *       inventing a label the model believes the product normally carries.
 *   F6  No accidental template interpolation or truncation of PRODUCT_FIDELITY.
 *
 * Run: node scripts/verifyStaticFidelityPrompt.js
 */
'use strict';

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

/**
 * Re-require staticAdIntents under a specific kill-switch value.
 * `undefined` unsets the env var (default-ON path).
 */
function loadIntents(flag) {
  const key = require.resolve('../services/staticAdIntents');
  delete require.cache[key];
  if (flag === undefined) delete process.env.STATIC_PROMPT_FIDELITY_HARDENING;
  else process.env.STATIC_PROMPT_FIDELITY_HARDENING = flag;
  return require('../services/staticAdIntents');
}

// Exact pre-hardening control arm (not exported; must match source byte-for-byte).
const LEGACY_PRODUCT_FIDELITY = `The supplied photograph is a PRODUCT REFERENCE ONLY. Reproduce this exact item faithfully — its colour, material, construction and any branding printed on the product itself — then build an entirely new scene around it. Do not reuse the reference's background, crop or lighting.`;

const HARDENING_FINGERPRINTS = [
  'PRODUCT FIDELITY — HIGHEST PRIORITY',
  'PRESERVE EXACTLY',
  'already visible on the product itself in the reference photograph',
  'wording already printed on the product itself is not an addition',
  'reproduced from the reference rather than redrawn'
];

const DATA = {
  rating: '4.8 ★',
  reviewCount: '312',
  quote: 'Softest walkers I own — no break-in needed.',
  attribution: 'M. Chen',
  badge: 'Best Seller',
  headline: 'Walk lighter.',
  cta: 'Shop Now'
};

const PRODUCT = {
  desc: 'Allbirds Tree Runners in Natural Black — knit upper, sugarcane midsole.',
  look: 'calm, premium, airy lifestyle photography with soft natural light',
  logoCorner: 'bottom-right'
};

const EMPTY_DATA = {};

/** Collect every (intent, surface) that yields a real prompt for a data shape. */
function collectPrompts(mod, data) {
  const out = [];
  for (const intentKey of Object.keys(mod.INTENTS)) {
    for (const surface of Object.keys(mod.SURFACE_POLICY)) {
      const r = mod.buildPrompt({ intentKey, data, product: PRODUCT, surface });
      if (r.skipped || r.error) continue;
      if (typeof r.prompt !== 'string' || !r.prompt.length) continue;
      out.push({ intentKey, surface, prompt: r.prompt, result: r });
    }
  }
  return out;
}

// ── Sanity: loadIntents actually flips the const ────────────────────────
// A failure here means the module no longer reads the env at require time and
// every F1–F6 result is meaningless — adapt the helper before trusting the rest.
{
  const on = loadIntents(undefined);
  const off = loadIntents('false');
  const onAgain = loadIntents('true');
  const pOn = on.buildPrompt({
    intentKey: 'product_first_lifestyle', data: DATA, product: PRODUCT, surface: 'meta_feed_1_1'
  }).prompt;
  const pOff = off.buildPrompt({
    intentKey: 'product_first_lifestyle', data: DATA, product: PRODUCT, surface: 'meta_feed_1_1'
  }).prompt;
  const pOn2 = onAgain.buildPrompt({
    intentKey: 'product_first_lifestyle', data: DATA, product: PRODUCT, surface: 'meta_feed_1_1'
  }).prompt;
  check('loadIntents: unset ships hardened header',
    pOn.includes('PRODUCT FIDELITY — HIGHEST PRIORITY'));
  check('loadIntents: "false" ships LEGACY verbatim',
    pOff.includes(LEGACY_PRODUCT_FIDELITY));
  check('loadIntents: "false" does NOT ship hardened header',
    !pOff.includes('PRODUCT FIDELITY — HIGHEST PRIORITY'));
  check('loadIntents: re-enable with "true" ships hardened header again',
    pOn2.includes('PRODUCT FIDELITY — HIGHEST PRIORITY'));
  check('loadIntents: on and off prompts differ', pOn !== pOff);
}

// ── F1 — DEFAULT IS ON ──────────────────────────────────────────────────
// WHY: a fail-open default means a typo'd value silently ships the unhardened
// prompt. Only the exact lowercase string 'false' turns hardening off.
{
  const onValues = [undefined, '', 'true', '0', 'FALSE'];
  for (const flag of onValues) {
    const mod = loadIntents(flag);
    const rows = collectPrompts(mod, DATA);
    const label = flag === undefined ? '(unset)' : JSON.stringify(flag);
    check(`F1 flag ${label}: at least 6 prompts built`, rows.length >= 6,
      `got ${rows.length}`);
    for (const { intentKey, surface, prompt } of rows) {
      check(`F1 flag ${label} ${intentKey}/${surface}: hardened header present`,
        prompt.includes('PRODUCT FIDELITY — HIGHEST PRIORITY'));
    }
  }

  // Explicit: only exact 'false' turns it off.
  const offMod = loadIntents('false');
  const offRows = collectPrompts(offMod, DATA);
  check('F1 flag "false": at least 6 prompts built', offRows.length >= 6,
    `got ${offRows.length}`);
  for (const { intentKey, surface, prompt } of offRows) {
    check(`F1 flag "false" ${intentKey}/${surface}: hardened header ABSENT`,
      !prompt.includes('PRODUCT FIDELITY — HIGHEST PRIORITY'));
    check(`F1 flag "false" ${intentKey}/${surface}: LEGACY present`,
      prompt.includes(LEGACY_PRODUCT_FIDELITY));
  }
}

// ── F2 — FLAG OFF IS A COMPLETE, NOT PARTIAL, REVERT ────────────────────
// WHY: a flag that reverts only the block and not the absences / textBlock
// carve-outs gives an A/B whose control arm is not the arm that produced the
// measured 139/140 text-fidelity baseline. Every fingerprint of the hardening
// — including the absences and textBlock carve-outs — must be gone.
{
  const mod = loadIntents('false');
  const rows = collectPrompts(mod, DATA);
  check('F2 at least 6 (intent, surface) pairs produced a prompt',
    rows.length >= 6, `got ${rows.length}`);

  for (const { intentKey, surface, prompt } of rows) {
    const tag = `${intentKey}/${surface}`;
    check(`F2 ${tag}: LEGACY_PRODUCT_FIDELITY verbatim`,
      prompt.includes(LEGACY_PRODUCT_FIDELITY));
    for (const fp of HARDENING_FINGERPRINTS) {
      check(`F2 ${tag}: no fingerprint ${JSON.stringify(fp).slice(0, 48)}`,
        !prompt.includes(fp));
    }
  }
}

// ── F3 — FLAG ON, load-bearing clauses all present ──────────────────────
// One check per clause, named so a failure says which clause was lost.
{
  const mod = loadIntents(undefined);
  const rows = collectPrompts(mod, DATA);
  check('F3 at least 6 (intent, surface) pairs produced a prompt',
    rows.length >= 6, `got ${rows.length}`);

  const CLAUSES = [
    ['precedence: product accuracy wins', 'product accuracy wins'],
    ['precedence exempts text contract', 'does not relax the text instructions'],
    ['precedence defers to reserved corner', 'does not override the reserved-corner rule'],
    ['category/brand prior', 'Do not infer the product from its category'],
    ['colour lock', 'No hue shift, recolour'],
    ['lighting-vs-colour scope', 'New lighting may fall across those colours'],
    ['no-new-branding', 'never licence to place a brand mark anywhere else in the frame'],
    ['hidden geometry', 'geometry only, never a graphic, label or marking'],
    ['creative freedom retained', 'WHAT MAY CHANGE'],
    ['closing check: BEFORE YOU FINISH', 'BEFORE YOU FINISH'],
    ['closing check: every string once', 'every string given below appears exactly once'],
    ['no-substitute / no-variant line', 'NEVER substitute a similar-looking version'],
    ['material swap ban', 'Never swap in a richer or cheaper-looking material'],
    ['hidden-closure ban', 'A closure the reference hides under a flap stays hidden'],
    ['no-added-pocket ban', 'a pocket the reference does not show is never added'],
    ['logo may not be resized or restyled', 'never resized, restyled or swapped for a different mark'],
    ['name-prior ban', 'its name']
  ];

  for (const { intentKey, surface, prompt } of rows) {
    const tag = `${intentKey}/${surface}`;
    for (const [name, needle] of CLAUSES) {
      check(`F3 ${tag}: ${name}`, prompt.includes(needle));
    }
  }
}

// ── F4 — PRE-EXISTING TEXT CONTRACT UNDAMAGED, flag ON ──────────────────
// WHY: the hardening block was inserted ABOVE the text contract; these checks
// fail loudly if a future edit displaces or truncates it. Geometry stays last
// (final section starts with FORMAT — same assertion style as verifyStaticIntents).
{
  const mod = loadIntents('true');
  const rows = collectPrompts(mod, DATA);
  check('F4 at least 6 (intent, surface) pairs produced a prompt',
    rows.length >= 6, `got ${rows.length}`);

  let withText = 0;
  for (const { intentKey, surface, prompt, result } of rows) {
    const tag = `${intentKey}/${surface}`;
    const hasText = Array.isArray(result.text) && result.text.length > 0;

    if (hasText) {
      withText++;
      check(`F4 ${tag}: SET EXACTLY THESE STRINGS present`,
        prompt.includes('SET EXACTLY THESE STRINGS'));
      check(`F4 ${tag}: words-left-of-arrow rule`,
        prompt.includes('The words to the LEFT of each arrow'));
      check(`F4 ${tag}: Set no other words ban`,
        prompt.includes('Set no other words, numerals or letterforms'));
    }

    // Geometry block is still last — final non-empty section starts with FORMAT.
    const lastSection = prompt.trim().split(/\n\n+/).pop() || '';
    check(`F4 ${tag}: geometry starts with FORMAT`,
      /^FORMAT:/.test(lastSection.trim()),
      `last section starts: ${JSON.stringify(lastSection.slice(0, 40))}`);
  }
  check('F4 at least one with-copy prompt exercised the text contract',
    withText >= 1, `withText=${withText}`);
}

// ── F5 — BOTH textBlock BRANCHES CARRY THE CARVE-OUT, flag ON ───────────
// WHY: "already on the product" is a justification handle for inventing a
// label the model believes the product normally carries; the anchor must be
// the reference pixels, not a brand prior.
{
  const mod = loadIntents(undefined);
  const ANCHOR = 'already visible on the product itself in the reference photograph';
  const LOOSE = 'not already on the product';

  // With-copy branch: realistic fixture data on a drawCta surface.
  const withCopy = mod.buildPrompt({
    intentKey: 'social_proof_led',
    data: DATA,
    product: PRODUCT,
    surface: 'meta_feed_1_1'
  });
  check('F5 with-copy: built a prompt',
    typeof withCopy.prompt === 'string' && withCopy.prompt.length > 0);
  check('F5 with-copy: SET EXACTLY THESE STRINGS branch',
    withCopy.prompt.includes('SET EXACTLY THESE STRINGS'));
  check('F5 with-copy: carve-out anchor present',
    withCopy.prompt.includes(ANCHOR));
  check('F5 with-copy: loose unanchored phrasing ABSENT',
    !withCopy.prompt.includes(LOOSE));

  // No-copy branch: find an intent+surface that yields THIS AD CARRIES NO TEXT
  // with empty data (Stories + product_first_lifestyle: no headline/rating, CTA
  // stripped by drawCta:false). Iterate so a surface rename cannot hide it.
  let noCopy = null;
  let noCopyTag = null;
  for (const intentKey of Object.keys(mod.INTENTS)) {
    for (const surface of Object.keys(mod.SURFACE_POLICY)) {
      const r = mod.buildPrompt({
        intentKey, data: EMPTY_DATA, product: PRODUCT, surface
      });
      if (r.skipped || r.error || !r.prompt) continue;
      if (r.prompt.includes('THIS AD CARRIES NO TEXT AT ALL')) {
        noCopy = r;
        noCopyTag = `${intentKey}/${surface}`;
        break;
      }
    }
    if (noCopy) break;
  }
  check('F5 no-copy: found an intent+surface producing the no-text branch',
    !!noCopy, 'iterated INTENTS x SURFACE_POLICY with empty data — none matched');
  if (noCopy) {
    check(`F5 no-copy (${noCopyTag}): THIS AD CARRIES NO TEXT AT ALL`,
      noCopy.prompt.includes('THIS AD CARRIES NO TEXT AT ALL'));
    check(`F5 no-copy (${noCopyTag}): carve-out anchor present`,
      noCopy.prompt.includes(ANCHOR));
    check(`F5 no-copy (${noCopyTag}): loose unanchored phrasing ABSENT`,
      !noCopy.prompt.includes(LOOSE));
    // Both branches must carry the anchor.
    check('F5 both branches share the reference-anchored carve-out',
      withCopy.prompt.includes(ANCHOR) && noCopy.prompt.includes(ANCHOR));
  }

  // Also walk every empty-data prompt: wherever the no-copy branch appears, the
  // anchor is required and the loose phrasing is forbidden.
  const emptyRows = collectPrompts(mod, EMPTY_DATA);
  for (const { intentKey, surface, prompt } of emptyRows) {
    if (!prompt.includes('THIS AD CARRIES NO TEXT AT ALL')) continue;
    const tag = `${intentKey}/${surface}`;
    check(`F5 empty ${tag}: carve-out anchor present`,
      prompt.includes(ANCHOR));
    check(`F5 empty ${tag}: loose phrasing ABSENT`,
      !prompt.includes(LOOSE));
  }
  // With-copy under full data: every prompt that sets strings carries the carve-out.
  const fullRows = collectPrompts(mod, DATA);
  for (const { intentKey, surface, prompt, result } of fullRows) {
    if (!result.text || !result.text.length) continue;
    const tag = `${intentKey}/${surface}`;
    check(`F5 full ${tag}: with-copy carve-out anchor present`,
      prompt.includes(ANCHOR));
    check(`F5 full ${tag}: loose phrasing ABSENT`,
      !prompt.includes(LOOSE));
  }
}

// ── F6 — NO ACCIDENTAL INTERPOLATION OR TRUNCATION ──────────────────────
{
  const mod = loadIntents(undefined);
  check('F6 PRODUCT_FIDELITY export is a string',
    typeof mod.PRODUCT_FIDELITY === 'string');
  check('F6 PRODUCT_FIDELITY contains no ${ sequence',
    !mod.PRODUCT_FIDELITY.includes('${'));
  check('F6 PRODUCT_FIDELITY is over 4000 chars',
    mod.PRODUCT_FIDELITY.length > 4000,
    `length=${mod.PRODUCT_FIDELITY.length}`);

  const rows = collectPrompts(mod, DATA);
  check('F6 at least 6 (intent, surface) pairs produced a prompt',
    rows.length >= 6, `got ${rows.length}`);
  for (const { intentKey, surface, prompt } of rows) {
    check(`F6 ${intentKey}/${surface}: PRODUCT_FIDELITY verbatim substring`,
      prompt.includes(mod.PRODUCT_FIDELITY));
  }

  // Empty-data prompts (flag ON) must also embed the block verbatim.
  const emptyRows = collectPrompts(mod, EMPTY_DATA);
  for (const { intentKey, surface, prompt } of emptyRows) {
    check(`F6 empty ${intentKey}/${surface}: PRODUCT_FIDELITY verbatim`,
      prompt.includes(mod.PRODUCT_FIDELITY));
  }
}

// ── F7: the owner-supplied v2 additions (2026-08-03) ────────────────────
//
// Second round of owner template changes on top of the original hardening. Each
// clause is pinned separately so a failure names the sentence that was lost.
//
// The two that carry real risk, and why they are checked as PAIRS:
//   • SCALE AND FRAMING contradicted the prompt as it stood — WHAT MAY CHANGE
//     handed the model crop/camera/perspective, and an older sentence told it not
//     to reuse "the reference's background, crop or lighting". Holding framing to
//     ~10% while also declaring crop free is incoherent, so the free-list must NOT
//     contain 'crop' and the reuse sentence must NOT say 'crop'. Both are asserted
//     negatively; if a future edit pastes the old wording back, this fails.
//   • The framing rule must defer to the FORMAT block, or it reads as licence to
//     change the delivered aspect — which the geometry harness would then catch as
//     a size defect with a confusing cause.
{
  const mod = loadIntents(undefined);
  const F = mod.PRODUCT_FIDELITY;
  const rows = collectPrompts(mod, DATA);
  check('F7 at least 6 (intent, surface) pairs produced a prompt', rows.length >= 6, `got ${rows.length}`);

  const clauses = [
    ['role preamble', 'You are an expert advertising creative director'],
    ['scale/framing rule', 'approximately the same share of the frame'],
    ['framing tolerance stated', 'within about a tenth'],
    ['no dramatic zoom/crop', 'Do not zoom or crop dramatically'],
    ['environment fits product', 'fit the environment to the product, never the product to the environment'],
    ['framing defers to FORMAT', 'fixed by the FORMAT block'],
    ['advertising quality', 'MAKE IT GOOD'],
    ['not stock photography', 'not a stock photograph'],
    ['product is focal point', 'primary focal point'],
    ['materials list', 'fabric, leather, knit, mesh, rubber, plastic, metal, wood, glass'],
    ['no-inference-from-name', 'Do not infer the product from its category, its name'],
    ['final check covers framing', 'roughly the same share of the frame'],
    ['final check covers the wearer', 'the person from the reference is still the one wearing it'],
    ['do-not-invent catch-all', 'if a word, numeral or mark is not in the text above'],
    // Owner instruction 2026-08-03. A PELAGIC jacket seeded from an ON-MODEL photo
    // came back as the jacket lying on a deck with nobody in it — because the
    // creative-freedom list literally offered "whether a person appears". The
    // replacement is asymmetric: a person in the reference must stay, a person
    // absent from it may be added. Pin all three parts; the negative pin below is
    // the one that matters, since restoring the old clause reopens the hole.
    ['person section present', 'THE PERSON.'],
    ['SAME person, identity held', 'do not replace them with someone else'],
    ['identity attributes named', 'Keep their face, hair, skin tone, build and identity'],
    ['rationale recorded in-prompt', "the person is held for the product's sake"],
    ['cannot strip the wearer', 'do not remove them to show the item on its own'],
    ['no hanger/mannequin/flat-lay substitute', 'a hanger, a mannequin, a surface or a flat lay'],
    ['adding a person stays discretionary', 'adding one is your choice'],
    ['worn-ness AND wearer excluded from free list', 'whether the item is worn, and who wears it'],
  ];
  for (const [name, needle] of clauses) {
    for (const { intentKey, surface, prompt } of rows) {
      check(`F7 ${intentKey}/${surface}: ${name}`, prompt.includes(needle));
    }
  }

  // Negative pins — the resolved contradictions must STAY resolved.
  check('F7 WHAT MAY CHANGE no longer lists crop as free',
    !/WHAT MAY CHANGE[^\n]*\bcrop\b/.test(F),
    'crop reappeared in the creative-freedom list, contradicting the framing rule');
  check('F7 the reference-reuse sentence no longer says crop',
    !F.includes("do not reuse the reference's background, crop or lighting"),
    'old wording restored; it contradicts holding framing near the reference');
  check('F7 free-list explicitly excludes product size in frame',
    F.includes('Deliberately NOT on that list'));

  // THE load-bearing negative pin for the person rule. `whether a person appears`
  // must be gone from the HARDENED prompt entirely — leaving it in flatly
  // contradicts WHO WEARS OR HOLDS IT, and the model demonstrably follows the
  // permissive clause when both are present.
  for (const { intentKey, surface, prompt } of rows) {
    check(`F7 ${intentKey}/${surface}: "whether a person appears" is GONE when hardened`,
      !prompt.includes('whether a person appears'),
      'the permissive clause is back; it contradicts WHO WEARS OR HOLDS IT');
  }

  // The v2 additions must revert with the flag, like everything else.
  const off = loadIntents('false');
  for (const { intentKey, surface, prompt } of collectPrompts(off, DATA)) {
    check(`F7 flag off ${intentKey}/${surface}: no role preamble`,
      !prompt.includes('You are an expert advertising creative director'));
    check(`F7 flag off ${intentKey}/${surface}: no framing rule`,
      !prompt.includes('approximately the same share of the frame'));
    check(`F7 flag off ${intentKey}/${surface}: no do-not-invent catch-all`,
      !prompt.includes('if a word, numeral or mark is not in the text above'));
    check(`F7 flag off ${intentKey}/${surface}: no WHO WEARS OR HOLDS IT rule`,
      !prompt.includes('WHO WEARS OR HOLDS IT'));
    // And the baseline KEEPS the permissive clause — that is what byte-identity means.
    check(`F7 flag off ${intentKey}/${surface}: "whether a person appears" RETAINED`,
      prompt.includes('whether a person appears'),
      'flag-off must reproduce the measured baseline exactly, permissive clause included');
  }
}

// ── Floor: harness cannot vacuous-pass if buildPrompt always errors ─────
{
  const mod = loadIntents(undefined);
  const n = collectPrompts(mod, DATA).length;
  check('floor: >=6 prompts under default ON with fixture data',
    n >= 6, `got ${n}`);
}

if (failures.length) {
  console.error(`\n❌ static fidelity prompt: ${failures.length} FAILED, ${pass} passed\n`);
  failures.forEach((f) => console.error(`   • ${f}`));
  process.exit(1);
}
console.log(`✅ static fidelity prompt: ${pass} checks passed`);
