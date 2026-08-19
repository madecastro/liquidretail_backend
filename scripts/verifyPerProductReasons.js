#!/usr/bin/env node
'use strict';
//
// verifyPerProductReasons — expansion skip reasons must reach the run payload.
//
// WHY THIS EXISTS. A production AllBirds run finished done/total:0 with only
// the generic expand message. campaignAdsGenerationService already knew the
// real per-product reason (empty_universe / no_concepts / no_hero_media / …)
// and logged it, then dropped it before the HTTP response. The operator
// could not tell imagery failure from Director failure.
//
// This harness is pure + offline: no DB, no network, no API key.
//   node scripts/verifyPerProductReasons.js
//
// Revert-prove (one assertion):
//   In summarizeEmptyExpansion, replace the uniform no_concepts branch with
//   `return GENERIC_EMPTY_MESSAGE` → "U3 uniform no_concepts says Director"
//   fails. That is the exact production lie this change closes.
//
// Revert-prove (2026-08-19 directorContractWarnings addition):
//   Remove the `directorContractWarnings` copy-through in
//   normalizePerProductEntry → every H* check fails (field never reaches the
//   row). Remove the field from models/CampaignRun.js perProduct schema →
//   I1-I3 fail (mongoose silently drops it on assignment instead of erroring,
//   which is exactly why this is pinned rather than trusted by inspection).
//   Remove the threading in campaignAdsGenerationService.js
//   runConceptDrivenExpansion → J1-J3 fail (source-region pins; the function
//   calls a live LLM so this cannot be exercised end-to-end offline).

const path = require('path');
const {
  REASON,
  WARNING,
  HUMAN_FULL,
  GENERIC_EMPTY_MESSAGE,
  humanMessageForReason,
  normalizePerProductEntry,
  normalizePerProductList,
  summarizeEmptyExpansion
} = require(path.join(__dirname, '..', 'services', 'perProductReasons.js'));

// Schema must declare perProduct or mongoose strict mode silently drops it
// (same class of bug as renderError.predictionId — see verifyRenderFailureRecord).
const CampaignRun = require(path.join(__dirname, '..', 'models', 'CampaignRun.js'));
const fs = require('fs');

let pass = 0;
const failures = [];

function check(label, actual, expected) {
  const ok = Object.is(actual, expected) || actual === expected;
  if (ok) { pass++; return; }
  failures.push(`${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
}

function checkTrue(label, cond) {
  if (cond) { pass++; return; }
  failures.push(`${label}\n      expected: truthy\n      actual:   ${cond}`);
}

function checkIncl(label, haystack, needle) {
  const ok = typeof haystack === 'string' && haystack.includes(needle);
  if (ok) { pass++; return; }
  failures.push(`${label}\n      expected to include: ${JSON.stringify(needle)}\n      actual:   ${JSON.stringify(haystack)}`);
}

console.log('\nverifyPerProductReasons\n');

// ── A. every machine code has a human message ─────────────────────────
console.log('A. reason codes map to human messages');
const ALL_CODES = [
  REASON.INVALID_PRODUCT_ID,
  REASON.NO_HERO_MEDIA,
  REASON.EXCLUDED_PAIRING,
  REASON.EMPTY_UNIVERSE,
  REASON.NO_CONCEPTS,
  REASON.CONCEPTS_NO_USABLE_MEDIA,
  REASON.ERROR
];
for (const code of ALL_CODES) {
  checkTrue(`HUMAN_FULL[${code}] is a non-empty string`,
    typeof HUMAN_FULL[code] === 'string' && HUMAN_FULL[code].length > 0);
  const msg = humanMessageForReason(code, { error: 'boom', errorName: 'TypeError' });
  checkTrue(`humanMessageForReason(${code}) is non-empty`, typeof msg === 'string' && msg.length > 0);
}
checkIncl('ERROR message carries error class', humanMessageForReason(REASON.ERROR, {
  error: 'x is not defined', errorName: 'ReferenceError'
}), 'ReferenceError');
check('null reason → null message', humanMessageForReason(null), null);

// ── B. normalize preserves reason + actionable fields, strips payloads ─
console.log('\nB. normalizePerProductEntry shape');
{
  const raw = {
    productId: 'p1',
    skipped: REASON.EMPTY_UNIVERSE,
    // Full Ad payload objects must NEVER land on CampaignRun.
    payloads: [{ identityDigest: 'x'.repeat(64), mediaIds: ['m1', 'm2'] }]
  };
  const n = normalizePerProductEntry(raw, { p1: "Men's Tree Runner" });
  check('B1 productId', n.productId, 'p1');
  check('B2 productName from map', n.productName, "Men's Tree Runner");
  check('B3 reason code survives', n.reason, REASON.EMPTY_UNIVERSE);
  checkTrue('B4 message is human, not the code alone',
    n.message === HUMAN_FULL[REASON.EMPTY_UNIVERSE]);
  check('B5 skipped is boolean true', n.skipped, true);
  check('B6 payloads is a count, not an array', n.payloads, 1);
  checkTrue('B7 no identityDigest leaked', !('identityDigest' in n));
}

{
  // Success row with silent concept skips + cap discards (Task 3).
  const raw = {
    productId: 'p2',
    payloads: [{}, {}, {}],
    conceptCount: 3,
    conceptSkips: [
      { conceptId: 'c_a', reason: 'no_media_picks' },
      { conceptId: 'c_b', reason: 'media_outside_universe', mediaId: 'm99' }
    ],
    capped: [{ kind: 'image', format: 'meta_feed_1_1', before: 5, after: 3, dropped: 2 }],
    payloadsBeforeCap: 5
  };
  const n = normalizePerProductEntry(raw);
  check('B8 success reason is null', n.reason, null);
  check('B9 success skipped is false', n.skipped, false);
  check('B10 payloads count', n.payloads, 3);
  check('B11 conceptCount', n.conceptCount, 3);
  check('B12 conceptSkips length', n.conceptSkips.length, 2);
  check('B13 conceptSkip reason', n.conceptSkips[0].reason, 'no_media_picks');
  check('B14 conceptSkip mediaId', n.conceptSkips[1].mediaId, 'm99');
  check('B15 capped dropped', n.capped[0].dropped, 2);
  check('B16 payloadsBeforeCap', n.payloadsBeforeCap, 5);
}

{
  // concepts_no_usable_media — the silent zero-ads path.
  const n = normalizePerProductEntry({
    productId: 'p3',
    payloads: [],
    skipped: REASON.CONCEPTS_NO_USABLE_MEDIA,
    conceptCount: 3,
    conceptSkips: [
      { conceptId: 'c1', reason: 'no_media_picks' },
      { conceptId: 'c2', reason: 'media_outside_universe', mediaId: 'mx' },
      { conceptId: 'c3', reason: 'no_media_picks' }
    ]
  });
  check('B17 concepts_no_usable_media reason', n.reason, REASON.CONCEPTS_NO_USABLE_MEDIA);
  checkTrue('B18 message mentions concepts/media',
    /concept/i.test(n.message) && /media/i.test(n.message));
  check('B19 conceptCount on zero-payload skip', n.conceptCount, 3);
}

{
  // Error row keeps class + message for the failed-run path.
  const n = normalizePerProductEntry({
    productId: 'p4',
    payloads: [],
    skipped: REASON.ERROR,
    error: 'foo is not defined',
    errorName: 'ReferenceError'
  });
  check('B20 error reason', n.reason, REASON.ERROR);
  checkIncl('B21 error message has class', n.message, 'ReferenceError');
  check('B22 error field kept', n.error, 'foo is not defined');
  check('B23 errorName kept', n.errorName, 'ReferenceError');
}

{
  // Malformed input must not throw and must not invent a confident cause.
  let threw = false;
  let n;
  try { n = normalizePerProductEntry(null); } catch (_) { threw = true; }
  check('B24 null input does not throw', threw, false);
  check('B25 null input skipped', n.skipped, true);
}

// ── C. list normalisation ─────────────────────────────────────────────
console.log('\nC. normalizePerProductList');
{
  const list = normalizePerProductList([
    { productId: 'a', skipped: REASON.NO_CONCEPTS, payloads: [] },
    { productId: 'b', payloads: 2 }
  ], { a: 'Alpha', b: 'Beta' });
  check('C1 length', list.length, 2);
  check('C2 name a', list[0].productName, 'Alpha');
  check('C3 name b', list[1].productName, 'Beta');
  check('C4 reason a', list[0].reason, REASON.NO_CONCEPTS);
  check('C5 reason b null', list[1].reason, null);
  check('C6 non-array → empty', normalizePerProductList(null).length, 0);
}

// ── D. every skip code survives expand → run payload shape ────────────
console.log('\nD. every reason code survives into the run payload shape');
{
  // Simulate what routes/ads.js persists: normalised list → CampaignRun.
  const rawExpansion = ALL_CODES.map((code, i) => ({
    productId: `prod_${i}`,
    payloads: [],
    skipped: code,
    error: code === REASON.ERROR ? 'boom' : undefined,
    errorName: code === REASON.ERROR ? 'Error' : undefined,
    mediaId: code === REASON.EXCLUDED_PAIRING ? 'media_x' : undefined,
    conceptCount: code === REASON.CONCEPTS_NO_USABLE_MEDIA ? 3 : undefined,
    conceptSkips: code === REASON.CONCEPTS_NO_USABLE_MEDIA
      ? [{ conceptId: 'c1', reason: 'no_media_picks' }]
      : undefined
  }));
  const payload = normalizePerProductList(rawExpansion, {
    prod_0: 'P0', prod_1: 'P1', prod_2: 'P2', prod_3: 'P3',
    prod_4: 'P4', prod_5: 'P5', prod_6: 'P6'
  });

  for (let i = 0; i < ALL_CODES.length; i++) {
    const code = ALL_CODES[i];
    const row = payload[i];
    check(`D${i}a reason ${code} on payload`, row.reason, code);
    checkTrue(`D${i}b message non-empty for ${code}`, !!row.message && row.message.length > 0);
    checkTrue(`D${i}c message is not the generic fallback for ${code}`,
      row.message !== GENERIC_EMPTY_MESSAGE);
    check(`D${i}d skipped true for ${code}`, row.skipped, true);
  }

  // Assign onto a real CampaignRun doc — strict mode would drop unknown paths.
  const run = new CampaignRun({
    runId: 'run_verify_per_product',
    brandId: new (require('mongoose').Types.ObjectId)(),
    campaignId: new (require('mongoose').Types.ObjectId)(),
    perProduct: payload
  });
  check('D schema: perProduct path declared', !!CampaignRun.schema.path('perProduct'), true);
  check('D schema: length survives assignment', run.perProduct.length, ALL_CODES.length);
  check('D schema: reason survives assignment', run.perProduct[4].reason, REASON.NO_CONCEPTS);
  check('D schema: productName survives', run.perProduct[0].productName, 'P0');
  check('D schema: conceptSkips survive',
    run.perProduct[5].conceptSkips && run.perProduct[5].conceptSkips[0].reason,
    'no_media_picks');
}

// ── E. summarizeEmptyExpansion — the run-level message ────────────────
console.log('\nE. summarizeEmptyExpansion reflects actual reasons');
{
  // alreadyQueued wins.
  checkIncl('E1 alreadyQueued',
    summarizeEmptyExpansion({ alreadyQueued: 4, perProduct: [] }),
    'already queued');
}

{
  // Uniform no_concepts — THE production case that looked like "check imagery".
  const msg = summarizeEmptyExpansion({
    perProduct: [
      { productId: 'p1', reason: REASON.NO_CONCEPTS, skipped: true },
      { productId: 'p2', reason: REASON.NO_CONCEPTS, skipped: true }
    ]
  });
  checkIncl('E2 uniform no_concepts says Director', msg, 'Director');
  checkTrue('E3 uniform no_concepts does NOT say check imagery',
    !/check that the product has usable imagery/i.test(msg));
  checkTrue('E4 uniform no_concepts does NOT use generic fallback alone',
    msg !== GENERIC_EMPTY_MESSAGE);
}

{
  const msg = summarizeEmptyExpansion({
    perProduct: [
      { productId: 'p1', reason: REASON.NO_HERO_MEDIA, skipped: true }
    ]
  });
  checkIncl('E5 uniform no_hero_media says imagery', msg, 'imagery');
}

{
  const msg = summarizeEmptyExpansion({
    perProduct: [
      { productId: 'p1', reason: REASON.EMPTY_UNIVERSE, skipped: true },
      { productId: 'p2', reason: REASON.EMPTY_UNIVERSE, skipped: true },
      { productId: 'p3', reason: REASON.EMPTY_UNIVERSE, skipped: true }
    ]
  });
  checkIncl('E6 uniform empty_universe count', msg, '3');
  checkIncl('E7 uniform empty_universe imagery', msg, 'imagery');
}

{
  const msg = summarizeEmptyExpansion({
    perProduct: [
      { productId: 'p1', reason: REASON.CONCEPTS_NO_USABLE_MEDIA, skipped: true }
    ]
  });
  checkIncl('E8 concepts_no_usable_media mentions concepts', msg, 'concept');
}

{
  // Mixed — count summary, not a single wrong cause.
  const msg = summarizeEmptyExpansion({
    perProduct: [
      { productId: 'p1', reason: REASON.NO_HERO_MEDIA, skipped: true },
      { productId: 'p2', reason: REASON.NO_HERO_MEDIA, skipped: true },
      { productId: 'p3', reason: REASON.NO_CONCEPTS, skipped: true }
    ]
  });
  checkIncl('E9 mixed mentions imagery bucket', msg, 'no usable imagery');
  checkIncl('E10 mixed mentions Director', msg, 'Director returned no concepts');
  checkTrue('E11 mixed does not claim a single uniform cause as the whole message',
    !/^Nothing to render: Director returned no concepts for 3/.test(msg));
}

{
  // Absent reason must NEVER render as a confident wrong cause.
  const msg = summarizeEmptyExpansion({ perProduct: [] });
  check('E12 empty perProduct → generic', msg, GENERIC_EMPTY_MESSAGE);
  checkTrue('E13 generic does NOT say check templates',
    !/template/i.test(msg));
  checkTrue('E14 generic does NOT claim imagery failure',
    !/no usable imagery for/i.test(msg));
  checkTrue('E15 generic does NOT claim Director failure',
    !/Director returned no concepts/i.test(msg));
}

{
  // Raw expansion shape (skipped: string) still works before normalize.
  const msg = summarizeEmptyExpansion({
    perProduct: [{ productId: 'p1', skipped: 'no_concepts' }]
  });
  checkIncl('E16 raw skipped:string still summarised', msg, 'Director');
}

{
  // summarize must not throw on garbage.
  let threw = false;
  let msg;
  try { msg = summarizeEmptyExpansion(null); } catch (_) { threw = true; }
  check('E17 null opts does not throw', threw, false);
  check('E18 null opts → generic', msg, GENERIC_EMPTY_MESSAGE);
}

// ── F. routes wire-up (source-level: the drop site is closed) ──────────
console.log('\nF. routes/ads.js surfaces perProduct + summarizeEmptyExpansion');
{
  const routesSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ads.js'), 'utf8');
  checkTrue('F1 imports summarizeEmptyExpansion',
    /require\(['"]\.\.\/services\/perProductReasons['"]\)/.test(routesSrc));
  checkTrue('F2 empty-expand path calls summarizeEmptyExpansion',
    /summarizeEmptyExpansion\s*\(/.test(routesSrc));
  checkTrue('F3 persists perProduct on CampaignRun',
    /\$set:\s*perProductSet|perProduct\s*:/.test(routesSrc) &&
    /perProductSet/.test(routesSrc));
  checkTrue('F4 GET /runs returns perProduct',
    /perProduct:\s*run\.perProduct/.test(routesSrc));
  checkTrue('F5 old misleading "check that the product has usable imagery" line is gone',
    !/Check that the product has usable imagery and at least one template is selected/.test(routesSrc));
}

// ── G. expansion records silent skips (source-level) ──────────────────
console.log('\nG. campaignAdsGenerationService records concept skips + caps');
{
  const svcSrc = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'campaignAdsGenerationService.js'), 'utf8'
  );
  checkTrue('G1 records no_media_picks conceptSkips',
    /reason:\s*['"]no_media_picks['"]/.test(svcSrc));
  checkTrue('G2 records media_outside_universe conceptSkips',
    /reason:\s*['"]media_outside_universe['"]/.test(svcSrc));
  checkTrue('G3 stamps concepts_no_usable_media when all concepts skipped',
    /CONCEPTS_NO_USABLE_MEDIA|concepts_no_usable_media/.test(svcSrc));
  checkTrue('G4 records capped discards into per-product structure',
    /capped\.push|capped:/.test(svcSrc) && /payloadsBeforeCap/.test(svcSrc));
  checkTrue('G5 normalises via attachProductNames / normalizePerProductList',
    /attachProductNames/.test(svcSrc));
}

// ── H. directorContractWarnings — Director round-contract reasons ──────
// The 2026-08-19 gap: this used to be console + Slack ('director:contract-
// warn') ONLY, never written to CampaignRun (docs/ALERTING.md "In-app run
// status vs Slack"). Independent of skip status — it describes the ROUND,
// not this product's outcome — so unlike `warning` it must survive on a
// skip row too.
console.log('\nH. directorContractWarnings — Director round-contract reasons');
{
  const queuedRow = normalizePerProductEntry({
    productId: 'p1', payloads: 2,
    directorContractWarnings: ['concept[0] missing headline', 'duplicate concept_id c2']
  });
  checkTrue('H1 queued row carries directorContractWarnings',
    Array.isArray(queuedRow.directorContractWarnings));
  check('H2 queued row is not marked skipped', queuedRow.skipped, false);
  checkIncl('H3 queued row keeps the actual reason text (not a generic code)',
    (queuedRow.directorContractWarnings || []).join('; '), 'missing headline');

  // The round can warn AND still fail to map to a payload for an unrelated
  // reason (concepts_no_usable_media) — the field must survive there too.
  const skipRow = normalizePerProductEntry({
    productId: 'p2', skipped: REASON.CONCEPTS_NO_USABLE_MEDIA,
    directorContractWarnings: ['concept[1] missing art_direction']
  });
  checkTrue('H4 skip row also carries directorContractWarnings (round-level, not skip-level)',
    Array.isArray(skipRow.directorContractWarnings) && skipRow.directorContractWarnings.length === 1);
  check('H5 skip row skipped stays true', skipRow.skipped, true);

  // Capped at 6 — same slice(0,6) the director:contract-warn Slack alert
  // uses. Must not silently grow past what the alert already shows.
  const many = Array.from({ length: 10 }, (_, i) => `reason ${i}`);
  const cappedRow = normalizePerProductEntry({ productId: 'p3', payloads: 1, directorContractWarnings: many });
  check('H6 capped at 6 (matches the director:contract-warn Slack alert slice)',
    (cappedRow.directorContractWarnings || []).length, 6);

  // Absent (not an empty array) when the round had no warnings — must not
  // bloat every clean row with a dead key.
  const cleanRow = normalizePerProductEntry({ productId: 'p4', payloads: 1 });
  checkTrue('H7 field is absent when the round had no warnings',
    !('directorContractWarnings' in cleanRow));

  // `warning` (fixed enum) and `directorContractWarnings` (free-text list)
  // are separate channels and must not collide when both are present.
  const bothRow = normalizePerProductEntry({
    productId: 'p5', payloads: 1, warning: WARNING.NO_CATALOG_IMAGE,
    directorContractWarnings: ['missing proof block']
  });
  check('H8 warning (fixed enum) unaffected by directorContractWarnings presence',
    bothRow.warning, WARNING.NO_CATALOG_IMAGE);
  checkTrue('H9 directorContractWarnings unaffected by warning presence',
    Array.isArray(bothRow.directorContractWarnings) && bothRow.directorContractWarnings.length === 1);
}

// ── I. directorContractWarnings survives the strict CampaignRun schema ─
console.log('\nI. directorContractWarnings survives CampaignRun strict schema');
{
  const perProductPath = CampaignRun.schema.path('perProduct');
  checkTrue('I1 perProduct declares directorContractWarnings (undeclared keys are silently dropped on $set)',
    !!perProductPath?.schema?.path('directorContractWarnings'));
  checkTrue('I2 …and it is an array of String',
    perProductPath?.schema?.path('directorContractWarnings')?.instance === 'Array' &&
    perProductPath?.schema?.path('directorContractWarnings')?.caster?.instance === 'String');

  const row = normalizePerProductEntry({
    productId: 'p1', payloads: 1,
    directorContractWarnings: ['concept[0] missing headline']
  });
  const run = new CampaignRun({
    runId: 'run_verify_contract_warn',
    brandId: new (require('mongoose').Types.ObjectId)(),
    campaignId: new (require('mongoose').Types.ObjectId)(),
    perProduct: [row]
  });
  check('I3 survives assignment onto a real CampaignRun doc',
    run.perProduct[0].directorContractWarnings && run.perProduct[0].directorContractWarnings[0],
    'concept[0] missing headline');
}

// ── J. campaignAdsGenerationService threads directorContractWarnings ───
// (source-level: runConceptDrivenExpansion calls a live LLM via
// director.directConceptsRound, so the full chain can't run offline — same
// reason scripts/verifyDirectorRoundPersist.js pins directConceptsRound's
// own return value by source region rather than by calling it.)
console.log('\nJ. campaignAdsGenerationService threads directorContractWarnings');
{
  const svcSrc = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'campaignAdsGenerationService.js'), 'utf8'
  );
  checkTrue('J1 destructures contractWarnings off directConceptsRound',
    /contractWarnings:\s*directorContractWarnings\s*\}\s*=[\s\S]{0,60}await director\.directConceptsRound/.test(svcSrc));
  checkTrue('J2 threads it onto the success per-product row',
    /productId, payloads,[\s\S]{0,800}directorContractWarnings\s*\}\s*:\s*\{\}\)/.test(svcSrc));
  checkTrue('J3 threads it onto the concepts_no_usable_media skip row too (round-level, not skip-level)',
    /CONCEPTS_NO_USABLE_MEDIA,[\s\S]{0,800}directorContractWarnings\s*\}\s*:\s*\{\}\)/.test(svcSrc));
}

// ── U. REVERT-PROVE (documented; run by temporarily breaking the code) ─
// The assertion below is the permanent stand-in: if someone reverts the
// uniform no_concepts branch to GENERIC_EMPTY_MESSAGE, E2/E3/U3 fail.
console.log('\nU. revert-prove anchor (uniform no_concepts must not be generic)');
{
  const msg = summarizeEmptyExpansion({
    perProduct: [{ productId: 'p1', reason: REASON.NO_CONCEPTS, skipped: true }]
  });
  // THIS is the assertion to break when revert-proving:
  //   In services/perProductReasons.js summarizeEmptyExpansion, change the
  //   REASON.NO_CONCEPTS case to `return GENERIC_EMPTY_MESSAGE;` and re-run.
  //   Expected fail:
  //     U3 uniform no_concepts is not the generic fallback
  //       expected: false
  //       actual:   true
  checkTrue('U3 uniform no_concepts is not the generic fallback',
    msg !== GENERIC_EMPTY_MESSAGE);
  checkIncl('U3b message names Director', msg, 'Director');
}

// ── summary ───────────────────────────────────────────────────────────
console.log('');
if (failures.length) {
  console.error(`FAIL ${failures.length} (passed ${pass})\n`);
  for (const f of failures) console.error('  ✗ ' + f + '\n');
  process.exit(1);
}
console.log(`OK ${pass} checks\n`);
process.exit(0);
