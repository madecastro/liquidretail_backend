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

/**
 * CTA POLICY, revised 2026-08-03 by owner instruction: *"turn off the CTA for
 * meta surfaces."*
 *
 * Meta renders its own CTA button in the chrome around Reels / Stories / Feed —
 * the app's own surface preview draws it — so a burned-in pill duplicated it, and
 * it was the element most prone to contrast collisions (a cream-accent brand
 * shipped white-on-cream). `landscape` is pmax / YouTube, which has no such
 * furniture, so it KEEPS its CTA.
 *
 * This helper previously asserted visible:true on all four formats, encoding the
 * earlier "CTA everywhere" decision. It is updated rather than deleted so the
 * contract stays pinned in both directions — off where Meta draws one, on where
 * nobody does.
 */
const META_FORMATS = new Set(['vertical', 'feed', 'square']);

function assertCtaPolicyAllFormats(doc, label) {
  for (const fmt of FORMATS) {
    const cta = (doc.byFormat[fmt].slots || []).find((s) => s.key === 'cta');
    assert.ok(cta, `${label}.${fmt} missing cta slot`);
    if (META_FORMATS.has(fmt)) {
      assert.strictEqual(cta.visible, false,
        `${label}.${fmt}.cta must be visible:false — Meta draws its own CTA (got visible:${cta.visible})`);
    } else {
      assert.notStrictEqual(cta.visible, false,
        `${label}.${fmt}.cta must stay visible — ${fmt} is not a Meta surface (got visible:${cta.visible})`);
    }
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

check('G4 cta off on Meta formats, on for landscape (canonical)', () => {
  // FAIL-IF-CTA-HIDDEN: owner decision — CTA visible on all formats.
  assertCtaPolicyAllFormats(loadPresetFile('canonical'), 'canonical');
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

check('G6 funnel variants load + validate for all 4 formats; cta policy', () => {
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
    assertCtaPolicyAllFormats(doc, name);
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

check('G9 productName cleaning strips parenthetical / pipe / trailing dash / leading gender+brand token; full preserved', () => {
  // FAIL-IF-CLEAN-REGRESSED: close-phase SKU titles must not print colorways,
  // pipe-suffixes, trailing " - <colorway|fit>" segments, a leading gender
  // qualifier, or a redundant leading own-brand token (2026-08-19 —
  // TRUNCATION INCIDENT: "Women's Vuori Vintage Oversized…" clamped mid-name
  // on Reels because the source string was never shortened before the char
  // cap fired; see G9b/G10 below for the brand-aware cases and the full
  // reported string).
  // Parenthetical only (legacy case — dash segment kept because remainder
  // is long enough; after paren strip we get "... - Warm Red" which has head
  // "Women's Breezer Point" ≥2 words → dash also strips; then the leading
  // "Women's" qualifier strips too, since it is pure merchandising overhead
  // once the ad already carries the brand elsewhere).
  const sample = "Women's Breezer Point - Warm Red (Dark Cocoa Sole)";
  const { productName, productNameFull } = cleanProductNameForDisplay(sample);
  assert.strictEqual(productName, 'Breezer Point');
  assert.strictEqual(productNameFull, sample);

  // Live frame: trailing " - <colorway>" with no paren.
  const colorway = "Women's Breezer Point - Warm Red";
  const c = cleanProductNameForDisplay(colorway);
  assert.strictEqual(c.productName, 'Breezer Point');
  assert.strictEqual(c.productNameFull, colorway);

  // Live frame: pipe-suffix + trailing dash (order: paren → pipe → dash).
  // No gender qualifier here — must stay untouched by step 4.
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

check('G9b leading gender/brand strip: brand-agnostic, guarded, never mangles a load-bearing token', () => {
  // FAIL-IF-NORMALIZER-REGRESSED / FAIL-IF-NORMALIZER-OVERREACHES: this is
  // the general rule the incident fix depends on — it must fire the same
  // way for ANY brand/category (not a Vuori special-case) and must never
  // fire where the stripped token is load-bearing.

  // THE REPORTED DEFECT, exactly: gender qualifier + brand both leading.
  const reels = cleanProductNameForDisplay("Women's Vuori Vintage Oversized Denim Jacket", 'Vuori');
  assert.strictEqual(reels.productName, 'Vintage Oversized Denim Jacket');
  assert.strictEqual(reels.productNameFull, "Women's Vuori Vintage Oversized Denim Jacket");

  // Order-independent: brand-first, gender-second still strips both.
  const brandFirst = cleanProductNameForDisplay("Vuori Women's Vintage Oversized Denim Jacket", 'Vuori');
  assert.strictEqual(brandFirst.productName, 'Vintage Oversized Denim Jacket');

  // REAL TENANT SHAPE: this platform's demo/test brands are literally named
  // "<Brand> <N>" (e.g. "Vuori 2", "Pelagic Gear Test 2" — see session.md).
  // The catalog title never repeats that trailing digit, so a naive
  // exact-full-string brand match would silently never fire for exactly the
  // account the incident was reported on. Word-by-word prefix matching must
  // still strip "Vuori " even though brandName is "Vuori 2".
  const testTenant = cleanProductNameForDisplay("Women's Vuori Vintage Oversized Denim Jacket", 'Vuori 2');
  assert.strictEqual(testTenant.productName, 'Vintage Oversized Denim Jacket');

  // Case-insensitive brand match.
  assert.strictEqual(cleanProductNameForDisplay('VUORI Trail Shorts', 'Vuori').productName, 'Trail Shorts');

  // Multi-word brand, with the title's own leading "The" the brand name
  // itself doesn't carry.
  assert.strictEqual(
    cleanProductNameForDisplay('The North Face Thermoball Jacket', 'North Face').productName,
    'Thermoball Jacket'
  );
  // Multi-word brand that DOES itself open with "The" — must not double-strip.
  assert.strictEqual(
    cleanProductNameForDisplay('The Ordinary Niacinamide Serum', 'The Ordinary').productName,
    'Niacinamide Serum'
  );

  // GUARD — mid-string brand token is never touched (anchored to the start only).
  assert.strictEqual(cleanProductNameForDisplay('Vintage Vuori Jacket', 'Vuori').productName, 'Vintage Vuori Jacket');

  // GUARD — never empties the whole title (brand name IS the entire product name).
  assert.strictEqual(cleanProductNameForDisplay('Vuori', 'Vuori').productName, 'Vuori');

  // GUARD — a bare singular "Men"/"Women" (no possessive/plural) is never
  // treated as a qualifier: it collides with ordinary English inside a real
  // product name. Only the unambiguous plural/possessive forms fire.
  assert.strictEqual(
    cleanProductNameForDisplay('Men in Black Costume Tee', null).productName,
    'Men in Black Costume Tee'
  );

  // GUARD — the qualifier is part of the BRAND's own identity (a brand
  // literally named "Women's Best"): stripping just "Women's" would sever it
  // from "Best", but stripping the full brand prefix "Women's Best" is still
  // correct and leaves a real product name.
  assert.strictEqual(
    cleanProductNameForDisplay("Women's Best Protein Powder", "Women's Best").productName,
    'Protein Powder'
  );

  // No brandName supplied (byte-identical to every pre-existing 1-arg caller
  // for the brand-token step) — gender-qualifier step alone still applies.
  assert.strictEqual(
    cleanProductNameForDisplay("Mens Compression Shorts").productName,
    'Compression Shorts'
  );
});

check('G10 END-TO-END: the reported Reels/Stories headline-truncation incident is closed', () => {
  // FAIL-IF-TRUNCATION-REGRESSED / REVERT-PROOF: this reproduces the exact
  // reported pixel bug at the DATA layer — cleanProductNameForDisplay feeding
  // deriveCharCap + truncateWordSafe (remotion/lib/slotContent.js), the same
  // two functions Canonical.jsx calls for the live paint. Before the fix,
  // the raw cascade string ("Women's Vuori Vintage Oversized Denim Jacket")
  // was 45 chars — Reels' cap (32, its safe-zone-narrowed width) and
  // Stories' cap (38) both clamped it with a mid-name ellipsis, at DIFFERENT
  // cutoffs (proving the clamp is width-driven, not a fixed source cap):
  // Reels -> "Women's Vuori Vintage Oversized…", Stories ->
  // "Women's Vuori Vintage Oversized Denim…". Revert cleanProductNameForDisplay's
  // step 4 (or drop the brandName argument at its call site) and this check
  // goes red because RAW_TITLE.length (45) once again exceeds both caps.
  const { deriveCharCap, truncateWordSafe, fitProductNameToCap } = require('../remotion/lib/slotContent.js');

  const RAW_TITLE = "Women's Vuori Vintage Oversized Denim Jacket";
  const BRAND_NAME = 'Vuori 2'; // the actual shipping tenant's brand doc name
  const EXPECTED_CLEANED = 'Vintage Oversized Denim Jacket';

  const { productName: cleaned } = cleanProductNameForDisplay(RAW_TITLE, BRAND_NAME);
  assert.strictEqual(cleaned, EXPECTED_CLEANED, `cleaned productName regressed: ${cleaned}`);

  // Same vertical/productName geometry Canonical.jsx stamps for these two
  // platformFormats (canonical.json close phase: maxWidthPct 0.9, maxLines 2,
  // font 56×1.2), differing only in platformFormat -> safe-zone width, which
  // is exactly what produced the two different cutoffs pre-fix.
  const baseCtx = {
    format: 'vertical', canvasWidth: 1080, maxWidthPct: 0.9, maxLines: 2, fontPx: 56 * 1.2,
  };
  const reelsCap = deriveCharCap('productName', { ...baseCtx, platformFormat: 'meta_reels_9_16' });
  const storiesCap = deriveCharCap('productName', { ...baseCtx, platformFormat: 'meta_stories_9_16' });

  // The raw (uncleaned) string would have clamped on BOTH surfaces — this is
  // the pre-fix incident reproduced, asserted so this check would have
  // caught it before it shipped.
  assert.ok(RAW_TITLE.length > reelsCap, `fixture stopped exercising the Reels clamp: raw=${RAW_TITLE.length} cap=${reelsCap}`);
  assert.ok(RAW_TITLE.length > storiesCap, `fixture stopped exercising the Stories clamp: raw=${RAW_TITLE.length} cap=${storiesCap}`);
  assert.ok(reelsCap < storiesCap, `fixture stopped proving the width-driven (not fixed-cap) delta: reels=${reelsCap} stories=${storiesCap}`);

  // The CLEANED string must survive uncut on both — the actual fix.
  const reelsOut = truncateWordSafe(cleaned, reelsCap);
  const storiesOut = truncateWordSafe(cleaned, storiesCap);
  assert.strictEqual(reelsOut, EXPECTED_CLEANED, `Reels still clamps the cleaned name: ${reelsOut}`);
  assert.strictEqual(storiesOut, EXPECTED_CLEANED, `Stories still clamps the cleaned name: ${storiesOut}`);
  assert.ok(!reelsOut.includes('…'), 'Reels productName must not carry an ellipsis');
  assert.ok(!storiesOut.includes('…'), 'Stories productName must not carry an ellipsis');

  // squareYt (pmax_video_1_1) shares the same mechanism with a much tighter
  // 1-line productName cap (26) — the cleaned 30-char name ("Vintage
  // Oversized Denim Jacket") still doesn't fit there on its own. This is
  // exactly where the noun-preserving fitProductNameToCap lever (owner's own
  // suggested fallback: "or even 'Oversized Denim Jacket'") takes over:
  // drop the leading modifier before ever clamping the tail noun away.
  const squareCap = deriveCharCap('productName', {
    format: 'square', canvasWidth: 1080, maxWidthPct: 0.9, maxLines: 1, fontPx: 36 * 1.2,
    platformFormat: 'pmax_video_1_1',
  });
  assert.ok(cleaned.length > squareCap,
    `fixture stopped exercising the noun-preserving fitter: len=${cleaned.length} cap=${squareCap}`);
  const squareOut = fitProductNameToCap(cleaned, squareCap);
  assert.strictEqual(squareOut, 'Oversized Denim Jacket', `squareYt fitter regressed: ${squareOut}`);
  assert.ok(!squareOut.includes('…'), 'squareYt productName must not carry an ellipsis when a whole-word fit exists');
  assert.ok(squareOut.length <= squareCap, `squareYt fitted name still exceeds its cap: ${squareOut}`);
});

// ── H. Experimental proto presets (scoring pilot) ─────────────────────────
check('H1 proto presets load + validate for all 4 formats; scrim none; cta policy', () => {
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
    assertCtaPolicyAllFormats(doc, name);
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
