#!/usr/bin/env node
// Offline pins for the catalog-alt Media projection at the TWO sister sites
// that feed reframeReferenceForAspect / chooseStrategy:
//
//   1. services/videoRefPrewarmService.js   (backend pre-warm reframe)
//   2. services/atlasVideoService.js        (live generateForAd path)
//
// Both projections MUST include `refinedProducts` — the DINO-derived
// bbox field written at ingest by mediaYoloRefine (open-vocab route,
// commit 7758b32) and consumed by reframeStrategyChooser.subjectUnionBbox
// (composite-mask tolerance path, commit da22486). Dropping the field
// silently forces every alt through paid nano-banana outpaint even though
// the bboxes are already stamped on the Media doc — Mongoose `.select()`
// of an unrequested field returns undefined without a warning, and
// `Array.isArray(undefined)` is false, so subjectUnionBbox returns null,
// chooseStrategy returns action='defer' with reason 'no YOLO subject bbox
// on media.refinedProducts[]', and reframeReferenceForAspect falls through
// to the outpaint branch.
//
// This is the exact class of contract-drift trap that CLAUDE.md §4 warns
// about generically for Brand (`.select() of a field that does not exist
// is SILENT`), but is a distinct variant: here every projected field IS
// real — they're just INCOMPLETE for the consumer set that landed later.
//
// Real-run evidence (2026-09-02 Pelagic video, run 6a98a58e...cf11):
//   • 2 of 3 refs (both on_model alts) went through Nano Banana outpaint
//     despite carrying 2-3 DINO-derived person bboxes each
//   • 88s of avoidable reframe hold + ~$0.16 outpaint burn per run
//   • Outpainted alts fed into Omni's ref stack, plausibly compounding
//     the master's fidelity failures (invented logos / wrong colors)
//
// Runs zero DB / zero network.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', 'config', 'defaults.env'), quiet: true });

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

// ── Section A — structural pin on the two projection strings ─────────
//
// A future rebase that drops `refinedProducts` from either projection
// fails HERE, before it reaches production. We match on the exact
// `.select('...')` string so the pin can't be silently defeated by a
// renamed variable or a comment.

console.log('\n== A. projection strings contain refinedProducts ==');

const prewarmSrc = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'videoRefPrewarmService.js'),
  'utf8'
);
const atlasSrc = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'atlasVideoService.js'),
  'utf8'
);

// A generic scan across both files: every catalog-product-scoped
// Media.find(...).select(...) call feeding reframe must project
// refinedProducts. Written as a source regex so the pin fires no
// matter which file introduces a new caller (or breaks an existing
// one). The `[\s\S]{0,400}?` gives the query and .select() up to
// ~400 chars of slack (the real projections here are 100-140 chars).
const CATALOG_ALT_PROJECTION_RE =
  /source:\s*['"]catalog-product['"][\s\S]{0,400}?\.select\(\s*['"]([^'"]+)['"]/g;

function scanForCatalogAltProjections(source, label) {
  const found = [];
  let match;
  while ((match = CATALOG_ALT_PROJECTION_RE.exec(source)) !== null) {
    const projection = match[1];
    // Skip `_id`-only projections. Those are safe-by-construction
    // existence checks — the returned doc is used ONLY to get an id
    // and (typically) a fresh full doc is re-loaded before any
    // reframe/split consumer touches the shape. Widening the scan
    // to include them would false-positive on every scope check.
    const tokens = projection.split(/\s+/).filter(Boolean);
    if (tokens.length === 1 && tokens[0] === '_id') continue;
    found.push({ label, projection });
  }
  CATALOG_ALT_PROJECTION_RE.lastIndex = 0;
  return found;
}

const prewarmProjections = scanForCatalogAltProjections(prewarmSrc, 'videoRefPrewarmService');
const atlasProjections = scanForCatalogAltProjections(atlasSrc, 'atlasVideoService');
const allProjections = [...prewarmProjections, ...atlasProjections];

check('A1 at least one catalog-alt projection found in each file', () => {
  assert.ok(prewarmProjections.length >= 1,
    `expected ≥1 catalog-product projection in videoRefPrewarmService; got ${prewarmProjections.length}`);
  assert.ok(atlasProjections.length >= 1,
    `expected ≥1 catalog-product projection in atlasVideoService; got ${atlasProjections.length}`);
});

check('A2 every catalog-alt projection includes refinedProducts', () => {
  const missing = allProjections.filter(p => !/\brefinedProducts\b/.test(p.projection));
  assert.strictEqual(missing.length, 0,
    `projections missing refinedProducts:\n  ${missing.map(p => p.label + ': ' + p.projection).join('\n  ')}`);
});

check('A3 every catalog-alt projection includes width', () => {
  const missing = allProjections.filter(p => !/\bwidth\b/.test(p.projection));
  assert.strictEqual(missing.length, 0,
    `projections missing width:\n  ${missing.map(p => p.label + ': ' + p.projection).join('\n  ')}`);
});

check('A4 every catalog-alt projection includes height', () => {
  const missing = allProjections.filter(p => !/\bheight\b/.test(p.projection));
  assert.strictEqual(missing.length, 0,
    `projections missing height:\n  ${missing.map(p => p.label + ': ' + p.projection).join('\n  ')}`);
});

check('A5 every catalog-alt projection includes fileUrl', () => {
  const missing = allProjections.filter(p => !/\bfileUrl\b/.test(p.projection));
  assert.strictEqual(missing.length, 0,
    `projections missing fileUrl:\n  ${missing.map(p => p.label + ': ' + p.projection).join('\n  ')}`);
});

// ── Section B — behavioral: a projected-shape media reaches action='crop' ─
//
// This is the load-bearing test — a projection that satisfies the string
// checks above but is functionally broken (say, a typo like
// `refinedProduct` singular) would silently pass A2 while still returning
// null from subjectUnionBbox. B feeds an actual projected-shape doc into
// chooseStrategy and demands action='crop'.

console.log('\n== B. behavioral — projected-shape doc reaches action=crop ==');

// Kill switch must be ON for chooseStrategy to attempt crop-first at all.
// defaults.env has REFRAME_STRATEGY=crop-first shipped, but the env may
// have been overridden — force it here so the test is deterministic.
process.env.REFRAME_STRATEGY = 'crop-first';

const { chooseStrategy, subjectUnionBbox } = require('../services/reframeStrategyChooser');

// A doc that mirrors the SHAPE of a real projected result: only the
// fields the new projection includes should appear here. Everything
// else must be undefined so the test proves the fix works with
// exactly the fields the callers now request.
function makeProjectedAltMedia({ withRefined = true } = {}) {
  return {
    _id: 'fixture-alt-6a988cd0',
    fileUrl: 'https://res.cloudinary.com/reach-social-prod/image/upload/v1788382415/catalog-product/x/alt.jpg',
    classification: { shotType: 'on_model' },
    adSuitability: null,
    metadata: { imageRole: 'alt', feedIndex: 1 },
    width: 2000,
    height: 2000,
    // The whole point of the fix: this field must be present on the
    // projected doc so subjectUnionBbox can see it. Match the on_model
    // shape from the real Pelagic Vaportek/Stick Figure alts
    // (2 person bboxes, both narrow-tall, both easily fitting a 9:16 crop
    // window on a 2000×2000 source).
    refinedProducts: withRefined ? [
      { x1: 840, y1: 393, x2: 1350, y2: 1198, label: 'person', confidence: 0.98 },
      { x1: 841, y1: 840, x2: 1351, y2: 1833, label: 'person', confidence: 0.98 }
    ] : []
  };
}

check('B1 subjectUnionBbox returns a valid union from the projected shape', () => {
  const media = makeProjectedAltMedia();
  const bbox = subjectUnionBbox(media);
  assert.ok(bbox, 'subjectUnionBbox returned null — projection likely missing refinedProducts');
  assert.strictEqual(bbox.count, 2);
  assert.strictEqual(bbox.x1, 840);
  assert.strictEqual(bbox.y2, 1833);
});

check('B2 chooseStrategy(9:16) returns action=crop with a valid rect', () => {
  const media = makeProjectedAltMedia();
  const s = chooseStrategy({
    media,
    aspectRatio: '9:16',
    sourceUrl: media.fileUrl
  });
  assert.strictEqual(s.action, 'crop',
    `expected action=crop; got action=${s.action} reason='${s.reason}'`);
  assert.ok(s.rect, 'crop rect missing');
  assert.ok(s.rect.w > 0 && s.rect.h > 0, `degenerate rect: ${JSON.stringify(s.rect)}`);
  // 2000-wide source → 9:16 crop width = 2000 * 9/16 = 1125
  assert.strictEqual(s.rect.w, 1125);
});

check('B3 regression control: a doc WITHOUT refinedProducts defers to outpaint', () => {
  // This is the state the PRE-FIX projection produced. If someone breaks
  // the fix later, this asserts the OLD behaviour was actually the
  // outpaint fallback, not something else — so we can trust the
  // 'crop' verdict in B2 is really due to the fix.
  const broken = makeProjectedAltMedia({ withRefined: false });
  const s = chooseStrategy({
    media: broken,
    aspectRatio: '9:16',
    sourceUrl: broken.fileUrl
  });
  assert.strictEqual(s.action, 'defer');
  assert.match(s.reason, /no YOLO subject bbox on media\.refinedProducts\[\]/);
});

// ── Section C — sister-file drift protection ─────────────────────────
//
// Both sites started from a copy of the same projection string. If ANY
// future edit re-diverges them (adds a field to one but not the other),
// the pre-warm and the live path will silently disagree — masters
// generated via the live path could use a different reframe result
// than the pre-warm committed to Media.metadata.reframes cache. Assert
// the two projections stay in structural lockstep.

console.log('\n== C. sister-file drift protection ==');

check('C1 videoRefPrewarm + atlasVideo project the same required fields', () => {
  // Both must project this exact required set. Order doesn't matter,
  // extras are allowed (atlas has createdAt, prewarm does not).
  const REQUIRED = ['_id', 'fileUrl', 'classification', 'adSuitability', 'metadata', 'width', 'height', 'refinedProducts'];
  for (const p of allProjections) {
    const tokens = p.projection.split(/\s+/).filter(Boolean);
    for (const r of REQUIRED) {
      assert.ok(tokens.includes(r),
        `${p.label} projection missing '${r}': "${p.projection}"`);
    }
  }
});

// ── Summary ──────────────────────────────────────────────────────────

const total = results.length;
const passed = results.filter(r => r.ok).length;
console.log(`\n${total} checks — ${passed} passed, ${total - passed} failed`);
if (passed !== total) process.exit(1);
