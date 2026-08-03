#!/usr/bin/env node
'use strict';
/**
 * verifyTitleSpecResolution — offline guard for the title-spec cascade.
 *
 * WHY THIS EXISTS
 * A live render logged `spec=brand`, meaning a PERSISTED Brand.titleStyleSpec
 * won over remotion/presets/canonical.json. Canonical's vertical slots all
 * carry scrim:"none" (no-scrim cinema standard, commits 0e885c5 / da1f2b4),
 * but the brand doc still had heavy grey scrims — so improving canonical
 * never reached any brand carrying a frozen override. Owner 2026-08-05:
 * all new renders ignore tier-1 persisted titleStyleSpec docs; named
 * curated presets (titleStylePreset → remotion/presets/<name>.json) and
 * canonical stay live.
 *
 * Every check below pins that read-path change. No DB, no network, no key.
 *
 * If these fail after a revert of the ignore gate (or after reintroducing
 * scrims into canonical.vertical), the harness exits non-zero. Comment on
 * each check names the failure mode.
 *
 *   node scripts/verifyTitleSpecResolution.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
const failures = [];
function check(label, fn) {
  try { fn(); pass++; }
  catch (err) { failures.push(`${label}: ${err.message}`); }
}

const ROOT = path.join(__dirname, '..');

// Isolate the flag for this process — defaults.env is only loaded at boot
// of index/worker; the harness drives process.env itself.
const SAVED = process.env.TITLE_SPEC_IGNORE_PERSISTED;
process.env.TITLE_SPEC_IGNORE_PERSISTED = 'true';

const {
  resolveSpec,
  resolveSpecForBrand,
  loadPresetFile,
  clearPresetCache,
  ignoresPersistedTitleSpecs,
  CANONICAL_PRESET,
} = require('../services/titleSpecService');

// Minimal valid per-format override with an intentional non-canonical look
// (solid scrim) so we can prove it is NOT selected on the render path.
const SCRIMMY_OVERRIDE = {
  version: 1,
  phases: [{ key: 'hook', startSec: 0, endSec: 3 }],
  slots: [{
    key: 'headline',
    phase: 'hook',
    position: { anchor: 'upperThird', align: 'left', maxWidthPct: 0.9 },
    timing: { enterAtSec: 0, exitAtSec: 2.6, enterDurationSec: 0.4, exitDurationSec: 0.4 },
    transition: { type: 'fade' },
    treatment: { scrim: 'solid', shadow: 'layered', fontRole: 'heading', weight: 700, maxLines: 3 },
  }],
};

const PRESET_NAME = 'soludos-summer-postcard';
const presetFile = loadPresetFile(PRESET_NAME);
assert.ok(presetFile?.byFormat?.vertical, `fixture preset '${PRESET_NAME}' must exist on disk`);

console.log('\nverifyTitleSpecResolution — TITLE_SPEC_IGNORE_PERSISTED=true (render path)\n');

// ── A. Render path ignores tier-1 persisted docs ──────────────────────────
check('A1 brand.titleStyleSpec.vertical does NOT win (source !== brand)', () => {
  // FAIL-IF-REVERTED: without the ignore gate, source would be 'brand'.
  const brand = { titleStyleSpec: { vertical: SCRIMMY_OVERRIDE } };
  const { source, spec } = resolveSpec({ brand, format: 'vertical' });
  assert.strictEqual(source, 'canonical', `expected canonical, got ${source}`);
  assert.notStrictEqual(source, 'brand');
  // And the winning slots must not carry the solid scrim from the override.
  const headline = spec.slots.find((s) => s.key === 'headline');
  assert.ok(headline, 'canonical must have a headline slot');
  assert.strictEqual(headline.treatment?.scrim, 'none',
    'resolved headline still has solid scrim — brand override leaked through');
});

check('A2 ad.titleStyleSpec is ignored on the render path', () => {
  // FAIL-IF-REVERTED: source would be 'ad'.
  const ad = { titleStyleSpec: { vertical: SCRIMMY_OVERRIDE } };
  const { source } = resolveSpec({ brand: {}, ad, format: 'vertical' });
  assert.strictEqual(source, 'canonical', `expected canonical, got ${source}`);
});

check('A3 product.titleStyleSpec is ignored on the render path', () => {
  // FAIL-IF-REVERTED: source would be 'product'.
  const product = { titleStyleSpec: { vertical: SCRIMMY_OVERRIDE } };
  const { source } = resolveSpec({ brand: {}, product, format: 'vertical' });
  assert.strictEqual(source, 'canonical', `expected canonical, got ${source}`);
});

check('A4 ad beats product only when honouring; both ignored on render path', () => {
  // With ignore on, neither tier-1 doc wins even if both are present.
  const ad = { titleStyleSpec: { vertical: SCRIMMY_OVERRIDE } };
  const product = { titleStyleSpec: { vertical: SCRIMMY_OVERRIDE } };
  const { source } = resolveSpec({ brand: {}, ad, product, format: 'vertical' });
  assert.strictEqual(source, 'canonical');
});

// ── B. Tier 2 named presets still win ─────────────────────────────────────
check('B1 brand.titleStylePreset still resolves to that preset (tier 2 intact)', () => {
  // FAIL-IF-REVERTED-AND-BROKEN: if tier 2 is accidentally disabled with tier 1,
  // a brand with only a preset pin would fall to canonical.
  const brand = { titleStylePreset: PRESET_NAME };
  const { source } = resolveSpec({ brand, format: 'vertical' });
  assert.strictEqual(source, `preset:${PRESET_NAME}`, `expected preset:${PRESET_NAME}, got ${source}`);
});

check('B2 persisted brand spec + named preset → preset wins (not brand, not canonical)', () => {
  // The live bug case: brand had a frozen titleStyleSpec AND may have a
  // preset pin. With ignore on, preset must win over the stored doc.
  const brand = {
    titleStyleSpec: { vertical: SCRIMMY_OVERRIDE },
    titleStylePreset: PRESET_NAME,
  };
  const { source } = resolveSpec({ brand, format: 'vertical' });
  assert.strictEqual(source, `preset:${PRESET_NAME}`,
    `expected preset:${PRESET_NAME}, got ${source} — brand override must not shadow the curated preset`);
});

// ── C. Floor + authoring opt-in ───────────────────────────────────────────
check('C1 no overrides at all → canonical still wins', () => {
  const { source } = resolveSpec({ brand: {}, format: 'vertical' });
  assert.strictEqual(source, 'canonical');
});

check('C2 resolveSpecForBrand with honourPersistedOverrides still returns brand', () => {
  // Authoring path must keep reading stored specs. FAIL-IF-AUTHORING-BROKEN.
  const brand = { titleStyleSpec: { vertical: SCRIMMY_OVERRIDE } };
  const { source } = resolveSpecForBrand(brand, 'vertical', { honourPersistedOverrides: true });
  assert.strictEqual(source, 'brand', `authoring must see brand, got ${source}`);
});

check('C3 resolveSpec honourPersistedOverrides:true restores ad tier', () => {
  const ad = { titleStyleSpec: { vertical: SCRIMMY_OVERRIDE } };
  const { source } = resolveSpec({ brand: {}, ad, format: 'vertical', honourPersistedOverrides: true });
  assert.strictEqual(source, 'ad');
});

// ── D. Canonical no-scrim cinema standard (vertical) ──────────────────────
check('D1 canonical.vertical has scrim:"none" on every slot', () => {
  // FAIL-IF-CANONICAL-EDIT: a future edit that reintroduces a scrim on any
  // vertical slot must fail here. Pins the no-scrim standard.
  const raw = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'remotion', 'presets', 'canonical.json'), 'utf8'
  ));
  const slots = raw.byFormat?.vertical?.slots;
  assert.ok(Array.isArray(slots) && slots.length > 0, 'canonical.vertical.slots missing');
  const withScrim = slots
    .filter((s) => (s.treatment?.scrim || 'none') !== 'none')
    .map((s) => `${s.key}:${s.treatment.scrim}`);
  assert.strictEqual(withScrim.length, 0,
    `canonical.vertical slots reintroduced a scrim: ${withScrim.join(', ')}`);
});

check('D2 resolved canonical vertical also normalizes to scrim none', () => {
  const { spec, source } = resolveSpec({ brand: {}, format: 'vertical' });
  assert.strictEqual(source, 'canonical');
  const bad = (spec.slots || [])
    .filter((s) => s.treatment?.scrim !== 'none')
    .map((s) => `${s.key}:${s.treatment?.scrim}`);
  assert.strictEqual(bad.length, 0, `normalized vertical slots with scrim: ${bad.join(', ')}`);
});

// ── E. Flag flip restores old override behaviour ──────────────────────────
check('E1 TITLE_SPEC_IGNORE_PERSISTED=false restores brand override win', () => {
  // FAIL-IF-FLAG-DEAD: the env kill-switch must be live, not a dead constant.
  process.env.TITLE_SPEC_IGNORE_PERSISTED = 'false';
  assert.strictEqual(ignoresPersistedTitleSpecs(), false);
  const brand = { titleStyleSpec: { vertical: SCRIMMY_OVERRIDE } };
  const { source } = resolveSpec({ brand, format: 'vertical' });
  assert.strictEqual(source, 'brand', `flag off should honour brand, got ${source}`);
  // Restore default for any subsequent checks / process exit hygiene.
  process.env.TITLE_SPEC_IGNORE_PERSISTED = 'true';
  assert.strictEqual(ignoresPersistedTitleSpecs(), true);
});

check('E2 after flag restore, brand override is ignored again', () => {
  const brand = { titleStyleSpec: { vertical: SCRIMMY_OVERRIDE } };
  const { source } = resolveSpec({ brand, format: 'vertical' });
  assert.strictEqual(source, 'canonical');
});

// ── F. Helper + default ───────────────────────────────────────────────────
check('F1 ignoresPersistedTitleSpecs defaults to true when env unset', () => {
  delete process.env.TITLE_SPEC_IGNORE_PERSISTED;
  assert.strictEqual(ignoresPersistedTitleSpecs(), true);
  process.env.TITLE_SPEC_IGNORE_PERSISTED = 'true';
});

check('F2 CANONICAL_PRESET is the floor name', () => {
  assert.strictEqual(CANONICAL_PRESET, 'canonical');
  clearPresetCache();
  assert.ok(loadPresetFile(CANONICAL_PRESET)?.byFormat?.vertical);
});

// ── G. New canonical 9-slot / 3-phase architecture ───────────────────────
const { validateTitleSpec, FORMATS } = require('../services/titleSpecValidator');
const { cleanProductNameForDisplay } = require('../services/brandScriptExecutor');

const FUNNEL_VARIANTS = [
  'canonical-awareness',
  'canonical-consideration',
  'canonical-conversion',
];
// Experimental scoring prototypes (compete against canonical family).
const PROTO_PRESETS = [
  'proto-kinetic-center',
  'proto-bottom-editorial',
];
const REQUIRED_VERTICAL_SLOTS = ['rating', 'productName', 'deliveryLine', 'cta'];

function assertAllScrimNone(doc, label) {
  for (const fmt of FORMATS) {
    const slots = doc?.byFormat?.[fmt]?.slots;
    assert.ok(Array.isArray(slots) && slots.length > 0, `${label}.${fmt}.slots missing`);
    const bad = slots
      .filter((s) => (s.treatment?.scrim || 'none') !== 'none')
      .map((s) => `${s.key}:${s.treatment?.scrim}`);
    assert.strictEqual(bad.length, 0, `${label}.${fmt} reintroduced scrim: ${bad.join(', ')}`);
  }
}

function assertCtaVisibleAllFormats(doc, label) {
  for (const fmt of FORMATS) {
    const cta = (doc.byFormat[fmt].slots || []).find((s) => s.key === 'cta');
    assert.ok(cta, `${label}.${fmt} missing cta slot`);
    assert.notStrictEqual(cta.visible, false, `${label}.${fmt}.cta must be visible:true (got visible:${cta.visible})`);
  }
}

check('G1 canonical validates for all 4 formats', () => {
  // FAIL-IF-CANONICAL-BROKEN: rewritten 9-slot canonical must pass the
  // validator for every format in FORMATS.
  clearPresetCache();
  const raw = loadPresetFile('canonical');
  assert.ok(raw?.byFormat, 'canonical.json missing byFormat');
  for (const fmt of FORMATS) {
    assert.ok(raw.byFormat[fmt], `canonical missing byFormat.${fmt}`);
    const res = validateTitleSpec(raw.byFormat[fmt], { format: fmt });
    assert.ok(res.ok, `canonical.${fmt} invalid: ${(res.errors || []).join('; ')}`);
  }
});

check('G2 canonical.vertical has 3 phases; close ends at spec duration; ≥9 slots', () => {
  // FAIL-IF-ARCHITECTURE-REGRESSED: the old 2-phase upperThird-only
  // vertical left 26% of frame height unused and went text-dark after 5.6s.
  const raw = loadPresetFile('canonical');
  const v = raw.byFormat.vertical;
  const phaseKeys = (v.phases || []).map((p) => p.key);
  assert.ok(phaseKeys.includes('hook'), 'vertical missing hook phase');
  assert.ok(phaseKeys.includes('proof'), 'vertical missing proof phase');
  assert.ok(phaseKeys.includes('close'), 'vertical missing close phase');
  assert.strictEqual(v.phases.length, 3, `expected 3 phases, got ${v.phases.length}`);
  const close = v.phases.find((p) => p.key === 'close');
  const extent = Math.max(...v.phases.map((p) => p.endSec));
  assert.strictEqual(close.endSec, extent, `close.endSec (${close.endSec}) must equal phase envelope end (${extent})`);
  assert.ok((v.slots || []).length >= 9, `vertical needs ≥9 slots, got ${(v.slots || []).length}`);
});

check('G3 canonical.vertical has rating + productName + deliveryLine + cta', () => {
  // FAIL-IF-SLOTS-DROPPED: old canonical lacked these four entirely on vertical.
  const keys = new Set((loadPresetFile('canonical').byFormat.vertical.slots || []).map((s) => s.key));
  for (const k of REQUIRED_VERTICAL_SLOTS) {
    assert.ok(keys.has(k), `canonical.vertical missing required slot '${k}'`);
  }
});

check('G4 cta visible:true on every format of canonical', () => {
  // FAIL-IF-CTA-HIDDEN: owner decision — CTA visible on all formats.
  assertCtaVisibleAllFormats(loadPresetFile('canonical'), 'canonical');
});

check('G5 scrim none on every slot of every format of canonical + funnel variants', () => {
  // FAIL-IF-SCRIM-RETURNS: no-scrim cinema standard (pins G + variants).
  assertAllScrimNone(loadPresetFile('canonical'), 'canonical');
  for (const name of FUNNEL_VARIANTS) {
    const doc = loadPresetFile(name);
    assert.ok(doc, `missing funnel preset ${name}.json`);
    assertAllScrimNone(doc, name);
  }
});

check('G6 funnel variants load + validate for all 4 formats; cta visible', () => {
  // FAIL-IF-VARIANT-BROKEN: each funnel preset must be a complete 4-format doc.
  for (const name of FUNNEL_VARIANTS) {
    clearPresetCache();
    const doc = loadPresetFile(name);
    assert.ok(doc?.byFormat, `${name} missing byFormat`);
    for (const fmt of FORMATS) {
      assert.ok(doc.byFormat[fmt], `${name} missing byFormat.${fmt}`);
      const res = validateTitleSpec(doc.byFormat[fmt], { format: fmt });
      assert.ok(res.ok, `${name}.${fmt} invalid: ${(res.errors || []).join('; ')}`);
    }
    assertCtaVisibleAllFormats(doc, name);
  }
});

check('G7 presetOverride valid name wins (source=override:<name>)', () => {
  // FAIL-IF-OVERRIDE-DEAD: explicit arg must beat brand preset + canonical.
  clearPresetCache();
  const brand = { titleStylePreset: PRESET_NAME };
  const { source } = resolveSpec({
    brand,
    format: 'vertical',
    presetOverride: 'canonical-conversion',
  });
  assert.strictEqual(source, 'override:canonical-conversion', `expected override:canonical-conversion, got ${source}`);
});

check('G8 presetOverride bogus name falls through to normal ladder', () => {
  // FAIL-IF-OVERRIDE-THROWS: invalid name warns + falls through, never throws.
  clearPresetCache();
  const { source } = resolveSpec({
    brand: {},
    format: 'vertical',
    presetOverride: 'does-not-exist-xyz',
  });
  assert.strictEqual(source, 'canonical', `bogus override should fall to canonical, got ${source}`);

  const brand = { titleStylePreset: PRESET_NAME };
  const r2 = resolveSpec({
    brand,
    format: 'vertical',
    presetOverride: 'also-bogus-999',
  });
  assert.strictEqual(r2.source, `preset:${PRESET_NAME}`,
    `bogus override with brand preset should fall to preset, got ${r2.source}`);
});

check('G9 productName cleaning strips parenthetical / pipe / trailing dash; full preserved', () => {
  // FAIL-IF-CLEAN-REGRESSED: close-phase SKU titles must not print colorways,
  // pipe-suffixes, or trailing " - <colorway|fit>" segments.
  // Parenthetical only (legacy case — dash segment kept because remainder
  // is long enough; wait: after paren strip we get "... - Warm Red" which
  // has head "Women's Breezer Point" ≥2 words → dash also strips now).
  const sample = "Women's Breezer Point - Warm Red (Dark Cocoa Sole)";
  const { productName, productNameFull } = cleanProductNameForDisplay(sample);
  assert.strictEqual(productName, "Women's Breezer Point");
  assert.strictEqual(productNameFull, sample);

  // Live frame: trailing " - <colorway>" with no paren.
  const colorway = "Women's Breezer Point - Warm Red";
  const c = cleanProductNameForDisplay(colorway);
  assert.strictEqual(c.productName, "Women's Breezer Point");
  assert.strictEqual(c.productNameFull, colorway);

  // Live frame: pipe-suffix + trailing dash (order: paren → pipe → dash).
  const pipe = 'Short Sleeve Bridge Button Down - Relaxed Fit | Blue Stripe';
  const p = cleanProductNameForDisplay(pipe);
  assert.strictEqual(p.productName, 'Short Sleeve Bridge Button Down');
  assert.strictEqual(p.productNameFull, pipe);

  // Guard: short name whose dash is integral — remainder too short to strip.
  const guard = 'Mach 5 - Turbo';
  const g = cleanProductNameForDisplay(guard);
  assert.strictEqual(g.productName, 'Mach 5 - Turbo');
  assert.strictEqual(g.productNameFull, guard);

  const plain = cleanProductNameForDisplay('Simple Shoe');
  assert.strictEqual(plain.productName, 'Simple Shoe');
  assert.strictEqual(plain.productNameFull, 'Simple Shoe');

  const empty = cleanProductNameForDisplay(null);
  assert.strictEqual(empty.productName, null);
  assert.strictEqual(empty.productNameFull, null);

  // Whitespace collapse
  const ws = cleanProductNameForDisplay('  Foo   Bar  (Baz)  ');
  assert.strictEqual(ws.productName, 'Foo Bar');
  assert.strictEqual(ws.productNameFull, 'Foo Bar (Baz)');
});

// ── H. Experimental proto presets (scoring pilot) ─────────────────────────
check('H1 proto presets load + validate for all 4 formats; scrim none; cta visible', () => {
  // FAIL-IF-PROTO-BROKEN: scoring-pilot prototypes must stay legal grammar.
  for (const name of PROTO_PRESETS) {
    clearPresetCache();
    const doc = loadPresetFile(name);
    assert.ok(doc?.byFormat, `${name} missing byFormat`);
    for (const fmt of FORMATS) {
      assert.ok(doc.byFormat[fmt], `${name} missing byFormat.${fmt}`);
      const res = validateTitleSpec(doc.byFormat[fmt], { format: fmt });
      assert.ok(res.ok, `${name}.${fmt} invalid: ${(res.errors || []).join('; ')}`);
    }
    assertAllScrimNone(doc, name);
    assertCtaVisibleAllFormats(doc, name);
  }
});

// ── I. Type-scale bumps + proof claim fallback (owner 2026-08-05) ──────────
const { resolveSlotContent } = require('../remotion/lib/slotContent.js');

const TYPE_SCALE_FLOOR = {
  headline: 1.2,
  quote: 1.15,
  productName: 1.2,
  rating: 1.25,
  deliveryLine: 1.15,
  cta: 1.15,
};

function minimalSpec(extraSlots = []) {
  return {
    version: 1,
    phases: [
      { key: 'hook', startSec: 0, endSec: 2.7 },
      { key: 'proof', startSec: 2.7, endSec: 5.1 },
    ],
    slots: [
      {
        key: 'headline',
        phase: 'hook',
        position: { anchor: 'upperThird', align: 'left', maxWidthPct: 0.9 },
        timing: { enterAtSec: 0.15, exitAtSec: 2.4, enterDurationSec: 0.7, exitDurationSec: 0.6 },
        transition: { type: 'fade' },
        treatment: { sizeScale: 1.2, maxLines: 3, fontRole: 'heading', weight: 700 },
      },
      {
        key: 'quote',
        phase: 'proof',
        position: { anchor: 'upperThird', align: 'left', maxWidthPct: 0.92 },
        timing: { enterAtSec: 2.7, exitAtSec: 4.8, enterDurationSec: 0.8, exitDurationSec: 0.6 },
        transition: { type: 'fade' },
        treatment: { maxLines: 3, fontRole: 'quote', weight: 500 },
      },
      ...extraSlots,
    ],
  };
}

check('I1 validator accepts visibleWhenEmpty referencing an existing slot', () => {
  // FAIL-IF-GATE-DROPPED: proof claim fallback grammar must validate.
  const spec = minimalSpec([{
    key: 'headline',
    phase: 'proof',
    bind: ['headline'],
    visibleWhenEmpty: 'quote',
    position: { anchor: 'upperThird', align: 'left', maxWidthPct: 0.9 },
    timing: { enterAtSec: 2.7, exitAtSec: 4.8, enterDurationSec: 0.7, exitDurationSec: 0.6 },
    transition: { type: 'fade' },
    treatment: { sizeScale: 1.02, maxLines: 3, fontRole: 'heading', weight: 700 },
  }]);
  const res = validateTitleSpec(spec, { format: 'vertical' });
  assert.ok(res.ok, `expected ok, got: ${(res.errors || []).join('; ')}`);
  const fb = res.normalized.slots.find((s) => s.visibleWhenEmpty === 'quote');
  assert.ok(fb, 'normalized must retain visibleWhenEmpty');
  assert.strictEqual(fb.key, 'headline');
  assert.deepStrictEqual(fb.bind, ['headline']);
});

check('I2 validator rejects visibleWhenEmpty referencing an unknown slot', () => {
  // FAIL-IF-REF-UNCHECKED: unknown sibling keys must hard-fail save.
  const spec = minimalSpec([{
    key: 'headline',
    phase: 'proof',
    bind: ['headline'],
    visibleWhenEmpty: 'notARealSlot',
    position: { anchor: 'upperThird' },
    timing: { enterAtSec: 2.7, exitAtSec: 4.8 },
    transition: { type: 'fade' },
    treatment: { sizeScale: 1.02 },
  }]);
  const res = validateTitleSpec(spec, { format: 'vertical' });
  assert.strictEqual(res.ok, false, 'unknown visibleWhenEmpty ref must fail');
  assert.ok(
    (res.errors || []).some((e) => /visibleWhenEmpty/.test(e) && /notARealSlot/.test(e)),
    `expected visibleWhenEmpty ref error, got: ${(res.errors || []).join('; ')}`
  );
});

check('I3 canonical.vertical has proof fallback-headline bound like headline + visibleWhenEmpty:quote', () => {
  // FAIL-IF-FALLBACK-MISSING: rating-only proof beat needs the claim restatement.
  clearPresetCache();
  const raw = loadPresetFile('canonical');
  const slots = raw.byFormat.vertical.slots || [];
  const fb = slots.find((s) => s.visibleWhenEmpty === 'quote');
  assert.ok(fb, 'canonical.vertical missing visibleWhenEmpty:"quote" slot');
  assert.strictEqual(fb.key, 'headline', `fallback key must be headline, got ${fb.key}`);
  assert.strictEqual(fb.phase, 'proof', `fallback phase must be proof, got ${fb.phase}`);
  const bind = fb.bind || ['headline']; // default bind for headline is ['headline']
  assert.ok(
    bind.includes('headline'),
    `fallback bind must include 'headline', got ${JSON.stringify(bind)}`
  );
  // After validate, default bind is applied.
  const res = validateTitleSpec(raw.byFormat.vertical, { format: 'vertical' });
  assert.ok(res.ok, `canonical.vertical invalid: ${(res.errors || []).join('; ')}`);
  const nfb = res.normalized.slots.find((s) => s.visibleWhenEmpty === 'quote');
  assert.deepStrictEqual(nfb.bind, ['headline']);
});

check('I4 sizeScale bumps present on the six slots in canonical.vertical (pin floors)', () => {
  // FAIL-IF-SCALE-REVERTED: owner type-scale raise (headline×1.2 … cta×1.15).
  // Floors are the post-multiply values for a previously-unscaled slot so a
  // full revert fails; deliveryLine already had 1.1 → floor 1.265.
  clearPresetCache();
  const slots = loadPresetFile('canonical').byFormat.vertical.slots || [];
  // Prefer the hook/non-fallback instance for headline (not visibleWhenEmpty).
  const pick = (key) => {
    if (key === 'headline') {
      return slots.find((s) => s.key === 'headline' && !s.visibleWhenEmpty)
        || slots.find((s) => s.key === 'headline');
    }
    return slots.find((s) => s.key === key);
  };
  const floors = {
    headline: 1.2,
    quote: 1.15,
    productName: 1.2,
    rating: 1.25,
    deliveryLine: 1.265,
    cta: 1.15,
  };
  for (const [key, floor] of Object.entries(floors)) {
    const s = pick(key);
    assert.ok(s, `canonical.vertical missing slot '${key}'`);
    const ss = Number(s.treatment?.sizeScale ?? 1);
    assert.ok(
      ss + 1e-9 >= floor,
      `canonical.vertical.${key}.sizeScale ${ss} < floor ${floor}`
    );
  }
});

check('I5 resolveSlotContent: visibleWhenEmpty:quote yields content only when quote empty', () => {
  // Behavioural (no browser): pure core of the proof claim fallback.
  const res = validateTitleSpec(minimalSpec([{
    key: 'headline',
    phase: 'proof',
    bind: ['headline'],
    visibleWhenEmpty: 'quote',
    position: { anchor: 'upperThird' },
    timing: { enterAtSec: 2.7, exitAtSec: 4.8 },
    transition: { type: 'fade' },
    treatment: { sizeScale: 1.02, maxLines: 3 },
  }]), { format: 'vertical' });
  assert.ok(res.ok, (res.errors || []).join('; '));
  const slots = res.normalized.slots;
  const fb = slots.find((s) => s.visibleWhenEmpty === 'quote');
  assert.ok(fb);

  const withQuote = resolveSlotContent(
    fb,
    { headline: 'All-day comfort', quote: 'Best shoes I own', quoteSnippet: 'Best shoes I own' },
    slots
  );
  assert.strictEqual(withQuote, null, 'fallback must hide when quote is usable');

  const noQuote = resolveSlotContent(
    fb,
    { headline: 'All-day comfort', rating: 4.8, reviewCount: 120 },
    slots
  );
  assert.strictEqual(noQuote, 'All-day comfort', `fallback must show claim when quote empty, got ${JSON.stringify(noQuote)}`);

  // Empty-string quote still counts as empty (resolveSlotContentCore returns null).
  const emptyStr = resolveSlotContent(
    fb,
    { headline: 'All-day comfort', quote: '   ' },
    slots
  );
  assert.strictEqual(emptyStr, 'All-day comfort');
});

// ── report ────────────────────────────────────────────────────────────────
if (SAVED === undefined) delete process.env.TITLE_SPEC_IGNORE_PERSISTED;
else process.env.TITLE_SPEC_IGNORE_PERSISTED = SAVED;

if (failures.length) {
  console.error(`❌ verifyTitleSpecResolution: ${failures.length} FAILED, ${pass} passed\n`);
  for (const f of failures) console.error(`   • ${f}`);
  process.exit(1);
}
console.log(`✅ verifyTitleSpecResolution: ${pass}/${pass} checks passed`);
