#!/usr/bin/env node
'use strict';
/**
 * verifyImagePricing — guards the Atlas catalog price-parsing shape.
 *
 * WHY THIS EXISTS
 * atlasImageService.priceFor read `m.pricing?.actual?.price`. There is no `pricing` key
 * on an Atlas catalog entry — 0 of 444 live entries have one, 444 of 444 have `price`.
 * So every lookup missed, the cache filled with nothing, and `?? 0` meant every image
 * generation ledgered $0.00. It was invisible because a $0 cost is indistinguishable
 * from a free model, and nothing asserted otherwise.
 *
 * These checks pin the field path against real catalog shapes. Pure — no DB, no
 * network, no API key.
 */

const assert = require('assert');
const { buildPriceMap } = require('../services/atlasImageService');

let pass = 0;
const failures = [];
function check(label, fn) {
  try { fn(); pass++; }
  catch (err) { failures.push(`${label}: ${err.message}`); }
}

// Fixtures copied verbatim from the live catalog 2026-07-29, including the string
// (not number) base_price and the exact nesting.
const MEDIA_ENTRY = {
  model: 'openai/gpt-image-1.5/text-to-image',
  price: { discount: '85', actual: { base_price: '0.008' }, origin: { base_price: '0.009' } }
};
const NANO_ENTRY = {
  model: 'google/nano-banana-2/edit-developer',
  price: { discount: '50', actual: { base_price: '0.04' }, origin: { base_price: '0.08' } }
};
// Per-token LLM entry — has NO base_price. Must not be cached, and must not be 0.
const LLM_ENTRY = {
  model: 'xai/grok-4.5',
  price: { discount: '100', actual: { type: 'flat', input_price: '2', output_price: '6', cache_price: '0.5' },
           origin: { type: 'flat', input_price: '2', output_price: '6', cache_price: '0.5' } }
};
// The shape the OLD code looked for. It does not exist in the catalog; if a fixture
// like this ever starts resolving, someone has reintroduced the wrong field path.
const LEGACY_WRONG_SHAPE = {
  model: 'fake/legacy-shape',
  pricing: { actual: { price: '1.23', output_price: '4.56' } }
};

console.log('\nverifyImagePricing\n');

// ── A. the correct field path resolves ──────────────────────────────────────
check('A1 price.actual.base_price is read', () => {
  const m = buildPriceMap([MEDIA_ENTRY]);
  assert.strictEqual(m.get('openai/gpt-image-1.5/text-to-image'), 0.008);
});
check('A2 string base_price is coerced to a number', () => {
  const v = buildPriceMap([MEDIA_ENTRY]).get('openai/gpt-image-1.5/text-to-image');
  assert.strictEqual(typeof v, 'number', 'must be a number, not the raw string');
});
check('A3 `actual` is used, not `origin` (we pay the discounted price)', () => {
  const m = buildPriceMap([NANO_ENTRY]);
  assert.strictEqual(m.get('google/nano-banana-2/edit-developer'), 0.04,
    'got the origin/list price instead of actual — spend reports would be 2x reality');
});

// ── B. the regression itself, pinned ────────────────────────────────────────
check('B1 the old `pricing.actual.price` shape resolves to NOTHING', () => {
  const m = buildPriceMap([LEGACY_WRONG_SHAPE]);
  assert.strictEqual(m.size, 0,
    'a `pricing`-shaped entry was priced — the wrong field path is back');
});
check('B2 a catalog of only per-token LLM entries prices nothing (not zero)', () => {
  const m = buildPriceMap([LLM_ENTRY]);
  assert.strictEqual(m.has('xai/grok-4.5'), false,
    'cached a per-token model — absent base_price must mean "not my business", never "free"');
});

// ── C. defensive shapes ─────────────────────────────────────────────────────
check('C1 empty / null input does not throw', () => {
  assert.strictEqual(buildPriceMap([]).size, 0);
  assert.strictEqual(buildPriceMap(null).size, 0);
  assert.strictEqual(buildPriceMap(undefined).size, 0);
});
check('C2 malformed entries are skipped, not fatal', () => {
  const m = buildPriceMap([
    null,
    {},
    { model: 'a' },
    { model: 'b', price: {} },
    { model: 'c', price: { actual: {} } },
    { model: 'd', price: { actual: { base_price: 'not-a-number' } } },
    MEDIA_ENTRY
  ]);
  assert.strictEqual(m.size, 1, 'exactly the one valid entry should survive');
  assert.ok(m.has(MEDIA_ENTRY.model));
});
check('C3 base_price of "0" is kept as a real zero, not dropped', () => {
  // A genuinely free model must be distinguishable from an unpriced one: 0 is cached,
  // absent is not. Conflating them is how the original bug hid.
  const m = buildPriceMap([{ model: 'free/model', price: { actual: { base_price: '0' } } }]);
  assert.strictEqual(m.get('free/model'), 0);
  assert.strictEqual(m.has('free/model'), true);
});
check('C4 a mixed catalog prices only the flat media entries', () => {
  const m = buildPriceMap([MEDIA_ENTRY, LLM_ENTRY, NANO_ENTRY, LEGACY_WRONG_SHAPE]);
  assert.strictEqual(m.size, 2);
  assert.strictEqual(m.get(MEDIA_ENTRY.model), 0.008);
  assert.strictEqual(m.get(NANO_ENTRY.model), 0.04);
});

if (failures.length) {
  console.error(`❌ verifyImagePricing: ${failures.length} FAILED, ${pass} passed\n`);
  for (const f of failures) console.error(`   • ${f}`);
  process.exit(1);
}
console.log(`✅ verifyImagePricing: ${pass}/${pass} checks passed`);
