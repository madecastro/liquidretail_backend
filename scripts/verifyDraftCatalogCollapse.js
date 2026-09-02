#!/usr/bin/env node
// Offline pins for services/catalogProductDraftService.js pre-mint
// catalog-subset collapse. Runs zero DB / zero network — fixtures drive
// every path.
//
// The scenario the collapse exists for (measured 2026-09-01 on
// Pelagic Gear 4 Demos): Gemini identifies a full merchant
// description ("PELAGIC Hooded Performance Shirt - Freespool") for a
// SKU that IS already in the catalog under a terse product-family
// title ("Freespool"). productMatchService's catalog-first gate can't
// see the Gemini productName (it fires against the DINO refined
// label, upstream), so winner=gemini wins and a redundant draft would
// be minted. The collapse catches this before mint by detecting that
// the catalog title's tokens are a strict subset of the productName's
// tokens (i.e. the productName wraps the catalog family name).
//
// Rejects the ambiguous adjacent-SKU cases the raw score would
// otherwise merge — mens/womens, adult/youth, and same-color
// different-family collisions.

'use strict';

const assert = require('assert');
const path = require('path');

// Load defaults.env so DRAFT_COLLAPSE_TO_CATALOG resolves the same way in prod.
require('dotenv').config({ path: path.join(__dirname, '..', 'config', 'defaults.env') });

const svc = require('../services/catalogProductDraftService');
const {
  findCatalogSubsetMatch, isCollapseToCatalogEnabled,
  draftCollapseStopwords, FIT_MODIFIER_TOKENS
} = svc.__test;
const { UNIVERSAL_STOP_TOKENS } = require('../services/catalogRetroLinkService');

// Pelagic stopword set for the collapse — same helper the real caller
// uses in services/catalogProductDraftService.js tryCreate. Notably
// PRESERVES the fit-modifier tokens (ws, mens, womens, youth, kids)
// even though UNIVERSAL_STOP_TOKENS strips them, because they
// distinguish independent SKU families here (see FIT_MODIFIER_TOKENS
// comment). Verified by the fit-modifier tests below.
const PELAGIC_STOP = draftCollapseStopwords('Pelagic Gear 4 Demos');

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  ✗ ${name} — ${err.message}`);
  }
}

// Fixture: a compact slice of Pelagic's synced catalog with the exact
// terse-family shape that triggered the miss. Real DB has ~200 rows;
// these are the ones the top-20 candidate list came from.
const PELAGIC_CATALOG = [
  { _id: 'p1',  title: 'Freespool' },
  { _id: 'p2',  title: 'Vaportek' },
  { _id: 'p3',  title: 'Ws Vaportek' },
  { _id: 'p4',  title: 'Aquatek Yellowtail' },
  { _id: 'p5',  title: 'Ws Aquatek' },
  { _id: 'p6',  title: 'Flybridge Deluxe' },
  { _id: 'p7',  title: 'Youth Strike' },
  { _id: 'p8',  title: 'Mako' },
  { _id: 'p9',  title: 'Knockdown' },
  { _id: 'p10', title: 'Icon' },
  { _id: 'p11', title: 'Ws Leiday' },
  { _id: 'p12', title: 'End Game' }
];

console.log('\n== findCatalogSubsetMatch — Pelagic collapse cases ==');

check('Freespool: draft wraps catalog family name → collapse', () => {
  const draft = 'PELAGIC Hooded Performance Shirt - Freespool';
  const m = findCatalogSubsetMatch(draft, PELAGIC_CATALOG, PELAGIC_STOP);
  assert.ok(m, 'expected a match');
  assert.strictEqual(m.row._id, 'p1');
  assert.strictEqual(m.row.title, 'Freespool');
});

check('Vaportek: draft with color modifier still collapses to family', () => {
  const draft = 'PELAGIC Hooded Fishing Shirt - Vaportek Goione Tuna';
  const m = findCatalogSubsetMatch(draft, PELAGIC_CATALOG, PELAGIC_STOP);
  assert.ok(m, 'expected a match');
  assert.strictEqual(m.row.title, 'Vaportek');
});

check('Knockdown: single-token family name → collapse', () => {
  const draft = 'PELAGIC Button Up - Knockdown';
  const m = findCatalogSubsetMatch(draft, PELAGIC_CATALOG, PELAGIC_STOP);
  assert.ok(m);
  assert.strictEqual(m.row.title, 'Knockdown');
});

check('Icon: bare family name is a subset even with modifier in draft', () => {
  // "Performance Visor - Deluxe Icon" — after brand+apparel stops the
  // draft reduces to [deluxe, icon] and catalog "Icon" ⊆ [deluxe, icon].
  const draft = 'Performance Visor - Deluxe Icon';
  const m = findCatalogSubsetMatch(draft, PELAGIC_CATALOG, PELAGIC_STOP);
  assert.ok(m);
  assert.strictEqual(m.row.title, 'Icon');
});

console.log('\n== findCatalogSubsetMatch — false-positive rejections ==');

check('Flybridge Deluxe ⊄ "PELAGIC T-Shirt - Deluxe" (missing flybridge)', () => {
  // The bare-color "Deluxe" draft must NOT collapse into the
  // Flybridge Deluxe family. This is why the check requires SUBSET,
  // not just any shared token.
  const draft = 'PELAGIC T-Shirt - Deluxe';
  const m = findCatalogSubsetMatch(draft, PELAGIC_CATALOG, PELAGIC_STOP);
  assert.strictEqual(m, null, `unexpected collapse to ${m && m.row.title}`);
});

check('Youth Strike ⊄ "PELAGIC Boardshorts - Strike" (adult vs youth SKU split)', () => {
  const draft = 'PELAGIC Boardshorts 19" - Strike';
  const m = findCatalogSubsetMatch(draft, PELAGIC_CATALOG, PELAGIC_STOP);
  assert.strictEqual(m, null, `unexpected collapse to ${m && m.row.title}`);
});

check('Ws Aquatek ⊄ "Aquatek Deluxe" (womens vs mens SKU split)', () => {
  // Adversarial pairing — a bare "Aquatek Deluxe" draft would score
  // high against BOTH "Ws Aquatek" and (if present) a bare "Aquatek"
  // family. With this fixture only Ws Aquatek exists, and it MUST be
  // rejected because "ws" isn't in the draft — the women's fit is a
  // distinct SKU family from the men's Aquatek line.
  const draft = 'Aquatek Deluxe';
  const m = findCatalogSubsetMatch(draft, PELAGIC_CATALOG, PELAGIC_STOP);
  assert.strictEqual(m, null, `unexpected collapse to ${m && m.row.title}`);
});

check('Ws Leiday ⊄ "Leiday Elastic Lined Shorts" (womens vs mens SKU split)', () => {
  const draft = 'Leiday Elastic Lined 17" Shorts';
  const m = findCatalogSubsetMatch(draft, PELAGIC_CATALOG, PELAGIC_STOP);
  assert.strictEqual(m, null, `unexpected collapse to ${m && m.row.title}`);
});

console.log('\n== findCatalogSubsetMatch — specificity + edge cases ==');

check('prefers more specific match when multiple subsets exist', () => {
  // Both "Aquatek" (specific) and a hypothetical bare stopword-only
  // row would satisfy subset; the specific one must win.
  const catalog = [
    { _id: 'x1', title: 'Aquatek' },
    { _id: 'x2', title: 'Aquatek Yellowtail' }
  ];
  const draft = 'PELAGIC Fishing Shirt - Aquatek Yellowtail Blue';
  const m = findCatalogSubsetMatch(draft, catalog, PELAGIC_STOP);
  assert.ok(m);
  assert.strictEqual(m.row.title, 'Aquatek Yellowtail', 'more-specific match should win');
  assert.strictEqual(m.shared, 2);
});

check('empty productName → null', () => {
  const m = findCatalogSubsetMatch('', PELAGIC_CATALOG, PELAGIC_STOP);
  assert.strictEqual(m, null);
});

check('all-stopwords productName → null', () => {
  // Draft that reduces to zero tokens after stops must not vacuously
  // collapse into any catalog row.
  const m = findCatalogSubsetMatch('Pelagic Gear Fishing Shirt', PELAGIC_CATALOG, PELAGIC_STOP);
  assert.strictEqual(m, null);
});

check('all-stopwords catalog row is never chosen', () => {
  // A catalog row with only stopword tokens (e.g. a rogue "Fishing
  // Shirt" title) reduces to the empty set — subset of everything.
  // Must be rejected or every draft would collapse to it.
  const catalog = [{ _id: 'stop', title: 'Fishing Shirt' }, { _id: 'ok', title: 'Freespool' }];
  const draft = 'PELAGIC Hooded Performance Shirt - Freespool';
  const m = findCatalogSubsetMatch(draft, catalog, PELAGIC_STOP);
  assert.ok(m);
  assert.strictEqual(m.row._id, 'ok');
});

check('no candidate satisfies subset → null', () => {
  const catalog = [{ _id: 'a', title: 'Vaportek' }, { _id: 'b', title: 'Freespool' }];
  const draft = 'PELAGIC T-Shirt - Icon Green';
  const m = findCatalogSubsetMatch(draft, catalog, PELAGIC_STOP);
  assert.strictEqual(m, null);
});

check('empty catalog rows → null', () => {
  const m = findCatalogSubsetMatch('Freespool', [], PELAGIC_STOP);
  assert.strictEqual(m, null);
});

check('catalog row with null title is skipped', () => {
  const catalog = [{ _id: 'null', title: null }, { _id: 'ok', title: 'Freespool' }];
  const draft = 'PELAGIC Performance Shirt - Freespool';
  const m = findCatalogSubsetMatch(draft, catalog, PELAGIC_STOP);
  assert.ok(m);
  assert.strictEqual(m.row._id, 'ok');
});

console.log('\n== draftCollapseStopwords — fit-modifier preservation ==');

check('draftCollapseStopwords does NOT strip fit-modifier tokens', () => {
  const stops = draftCollapseStopwords('Pelagic Gear 4 Demos');
  for (const t of FIT_MODIFIER_TOKENS) {
    assert.ok(!stops.has(t), `fit modifier "${t}" leaked into draftCollapseStopwords`);
  }
});

check('UNIVERSAL_STOP_TOKENS legitimately still strips them (retro-link contract)', () => {
  // Structural pin — if these move OUT of UNIVERSAL_STOP_TOKENS,
  // retro-link's behaviour also changes and the whole reason
  // draftCollapseStopwords needs to subtract them goes away.
  for (const t of FIT_MODIFIER_TOKENS) {
    assert.ok(UNIVERSAL_STOP_TOKENS.has(t), `expected universal stops to contain "${t}"`);
  }
});

check('brand tokens ARE stripped (Pelagic vs product)', () => {
  const stops = draftCollapseStopwords('Pelagic Gear 4 Demos');
  assert.ok(stops.has('pelagic'), 'brand name token must still be stripped');
  assert.ok(stops.has('demos'), 'brand name token must still be stripped');
});

console.log('\n== isCollapseToCatalogEnabled ==');
{
  const prior = process.env.DRAFT_COLLAPSE_TO_CATALOG;
  try {
    check('default (unset) → true', () => {
      delete process.env.DRAFT_COLLAPSE_TO_CATALOG;
      assert.strictEqual(isCollapseToCatalogEnabled(), true);
    });
    check('"true" → true', () => {
      process.env.DRAFT_COLLAPSE_TO_CATALOG = 'true';
      assert.strictEqual(isCollapseToCatalogEnabled(), true);
    });
    check('"false" → false', () => {
      process.env.DRAFT_COLLAPSE_TO_CATALOG = 'false';
      assert.strictEqual(isCollapseToCatalogEnabled(), false);
    });
    check('"0" → false', () => {
      process.env.DRAFT_COLLAPSE_TO_CATALOG = '0';
      assert.strictEqual(isCollapseToCatalogEnabled(), false);
    });
    check('"off" → false', () => {
      process.env.DRAFT_COLLAPSE_TO_CATALOG = 'off';
      assert.strictEqual(isCollapseToCatalogEnabled(), false);
    });
    check('mixed case "False" → false', () => {
      process.env.DRAFT_COLLAPSE_TO_CATALOG = 'False';
      assert.strictEqual(isCollapseToCatalogEnabled(), false);
    });
    check('garbage → true (defaults on, matches CLAUDE.md "true means true" convention)', () => {
      process.env.DRAFT_COLLAPSE_TO_CATALOG = 'maybe';
      assert.strictEqual(isCollapseToCatalogEnabled(), true);
    });
  } finally {
    if (prior === undefined) delete process.env.DRAFT_COLLAPSE_TO_CATALOG;
    else process.env.DRAFT_COLLAPSE_TO_CATALOG = prior;
  }
}

// ── Summary ───────────────────────────────────────────────────────────

const total = results.length;
const passed = results.filter((r) => r.ok).length;
console.log(`\n${total} checks — ${passed} passed, ${total - passed} failed`);
if (passed !== total) process.exit(1);
