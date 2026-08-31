#!/usr/bin/env node
'use strict';
/**
 * verifyClearConfigAbsentMetaFontStamps — offline guard for the
 * clearConfigAbsentMetaFontStamps one-off remediation script's `classify()`
 * function.
 *
 * WHY THIS EXISTS
 * classify() is a STRING match against historical metaFontsIngestError text
 * (unavoidable — those rows predate the `billableAttempted` field this PR
 * adds; see the header comment in clearConfigAbsentMetaFontStamps.js for why
 * that fragility is accepted only here, not in the live code path). A wrong
 * classification in either direction is a real hazard:
 *   · a false positive (calling a genuine paid miss "zero-spend") clears a
 *     legitimate stamp, and the very next enrichment run pays for the vision
 *     call / Apify run all over again for a brand that was already looked at.
 *   · a false negative just leaves a brand stuck one release cycle longer —
 *     annoying, not a money bug — so the classifier is deliberately
 *     conservative (an unrecognised segment disqualifies the row).
 *
 * No DB, no network, no API key. Safe in CI.
 *   node scripts/verifyClearConfigAbsentMetaFontStamps.js
 */

const assert = require('assert');
const { classify } = require('./clearConfigAbsentMetaFontStamps');

let pass = 0;
const failures = [];
function check(label, fn) {
  try { fn(); pass++; }
  catch (err) { failures.push(`${label}: ${err.message}`); }
}

console.log('\nverifyClearConfigAbsentMetaFontStamps — legacy stamp classifier\n');

check('C1 the EXACT measured production string classifies as zero-spend', () => {
  const r = classify(
    'connected: no-meta-ads-cred: Brand has no active Meta Ads credential. Connect Meta Ads first.; ' +
    'adlibrary: skipped (APIFY_ADLIB_ACTOR not set)'
  );
  assert.strictEqual(r.zeroSpend, true, r.reason);
});
check('C2 kill switch alone classifies as zero-spend', () => {
  assert.strictEqual(classify('disabled: META_ADS_FONTS_ENABLED=false').zeroSpend, true);
});
check('C3 no-brand-id guard classifies as zero-spend', () => {
  assert.strictEqual(classify('brand has no id').zeroSpend, true);
});
check('C4 the catch-all used when every tier came back silent classifies as zero-spend', () => {
  assert.strictEqual(classify('no ad creatives found').zeroSpend, true);
});
check('C5 a connected-tier failure with any error code classifies as zero-spend (tier 2 is always free)', () => {
  assert.strictEqual(classify('connected: no-ad-account: re-finalize via the picker').zeroSpend, true);
  assert.strictEqual(classify('connected: decrypt: token decrypt failed: bad key').zeroSpend, true);
  assert.strictEqual(classify('connected: account has no ad creatives').zeroSpend, true);
  assert.strictEqual(classify('connected: creative id walk failed: 500').zeroSpend, true);
  assert.strictEqual(classify('connected: creative batch failed: timeout').zeroSpend, true);
});
check('C6 a campaign-docs (tier 1) exception classifies as zero-spend', () => {
  assert.strictEqual(classify('campaign-docs: Mongo connection reset').zeroSpend, true);
});
check('C7 a multi-segment all-zero-spend message classifies as zero-spend', () => {
  const r = classify('connected: no-meta-ads-cred: nope; adlibrary: brand has neither name nor website to search by');
  assert.strictEqual(r.zeroSpend, true, r.reason);
});

// ── Negative controls: these MUST stay stamped — a billable call happened ──
check('N1 a vision call error must NEVER classify as zero-spend', () => {
  assert.strictEqual(classify('vision: 502 upstream').zeroSpend, false);
});
check('N2 a vision parse note must NEVER classify as zero-spend', () => {
  assert.strictEqual(classify('vision parse: not JSON').zeroSpend, false);
});
check('N3 an Apify run that was actually submitted and threw must NEVER classify as zero-spend', () => {
  assert.strictEqual(classify('adlibrary: read ECONNRESET').zeroSpend, false);
});
check('N4 an Apify run that billed but returned nothing usable must NEVER classify as zero-spend', () => {
  assert.strictEqual(classify('adlibrary: actor returned no usable image URLs').zeroSpend, false);
});
check('N5 a genuine paid miss mixed with a zero-spend segment must NEVER classify as zero-spend', () => {
  // One billable segment anywhere in the message disqualifies the whole row.
  const r = classify('connected: no-meta-ads-cred: nope; adlibrary: actor returned no usable image URLs');
  assert.strictEqual(r.zeroSpend, false, r.reason);
});
check('N6 empty/missing error text must NEVER classify as zero-spend (cannot prove nothing was spent)', () => {
  assert.strictEqual(classify(null).zeroSpend, false);
  assert.strictEqual(classify('').zeroSpend, false);
  assert.strictEqual(classify('   ').zeroSpend, false);
});
check('N7 a totally unrecognised message must NEVER classify as zero-spend', () => {
  assert.strictEqual(classify('something a future code change might say that this list has never seen').zeroSpend, false);
});

// ── N8-N11: the EVIDENCE GATE (added on review of PR #362, before the script
// was ever run against production). metaAdsFontService gates tier 2 on
// `images.length < MIN_USABLE_IMAGES` (2), NOT on `=== 0`. So tier 1 can hand
// over exactly ONE image, tier 2 then runs and pushes a `connected: …` error,
// tier 3 is skipped (needs images.length === 0), and the BILLABLE vision call
// runs anyway on that one image. The persisted row then reads
// metaFontsIngestError = "connected: …" — which every ZERO_SPEND_PATTERN
// accepts — while a vision call was in fact paid for. Clearing that stamp
// makes the next enrichment run re-pay it. The usage argument closes it.
check('N8 a connected:-only string WITH a persisted evidence row is NOT zero-spend', () => {
  const r = classify('connected: no-ad-account', {
    heading: null, body: null,
    evidence: [{ family: 'Inter', creativeId: 'abc', confidence: 'low' }],
  });
  assert.strictEqual(r.zeroSpend, false, r.reason);
});
check('N9 a connected:-only string WITH an identified heading is NOT zero-spend', () => {
  const r = classify('connected: creative batch failed', {
    heading: { family: 'Montserrat', confidence: 'high' }, body: null, evidence: [],
  });
  assert.strictEqual(r.zeroSpend, false, r.reason);
});
check('N10 a connected:-only string WITH an identified body is NOT zero-spend', () => {
  const r = classify('connected: no-ad-account', {
    heading: null, body: { family: 'Inter', confidence: 'medium' }, evidence: [],
  });
  assert.strictEqual(r.zeroSpend, false, r.reason);
});
check('N11 the REAL production shape (empty usage + config-absence string) still clears', () => {
  // All 9 live brands measured 2026-08-31 carry exactly this pair. The
  // evidence gate must not make the script a no-op on the rows it exists for.
  const r = classify(
    'connected: no-meta-ads-cred: Brand has no active Meta Ads credential. Connect Meta Ads first.; '
    + 'adlibrary: skipped (APIFY_ADLIB_ACTOR not set)',
    { heading: null, body: null, evidence: [] },
  );
  assert.strictEqual(r.zeroSpend, true, r.reason);
});

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error(`  ❌ ${f}`);
  process.exit(1);
}
console.log('  ✅ verifyClearConfigAbsentMetaFontStamps green\n');
