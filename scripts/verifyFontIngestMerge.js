#!/usr/bin/env node
'use strict';
/**
 * verifyFontIngestMerge — offline guards for font ingest merge / integrity /
 * hold preservation / commercial cap (adversarial findings 2026-08).
 *
 * REVERT MAP (which checks fail if each fix is undone):
 *   (F1) mergeFontEntries last-write-wins without url:null guard
 *        → M1 fails (good url clobbered by flagged null)
 *   (F2) isFontMagic / downloadFontFile magic check removed
 *        → B1–B5 fail (HTML accepted; real magics rejected or helper gone)
 *   (F3) merge no longer preserves needsLicense on usable faces
 *        → H1 fails (human hold wiped); H2 must still pass (auto-flag ≠ hold)
 *   (F4) single MAX_INGESTED_FACES cap over all licenses again
 *        → C1 fails (open faces starved after 12 commercial candidates)
 *
 * No DB, no network, no API key. Safe in CI.
 *   node scripts/verifyFontIngestMerge.js
 */

const assert = require('assert');

let pass = 0;
const failures = [];
function check(label, fn) {
  try { fn(); pass++; }
  catch (err) { failures.push(`${label}: ${err.message}`); }
}

const {
  mergeFontEntries,
} = require('../services/brandFontPersistenceService');
const {
  isFontMagic,
  canMirrorFace,
  bumpMirrorCount,
  downloadFailureClass,
  MAX_INGESTED_FACES,
  MAX_COMMERCIAL_FACES,
} = require('../services/brandFontIngestService');

console.log('\nverifyFontIngestMerge — merge / magic / hold / commercial cap\n');
console.log(`  MAX_INGESTED_FACES    = ${MAX_INGESTED_FACES}`);
console.log(`  MAX_COMMERCIAL_FACES  = ${MAX_COMMERCIAL_FACES}\n`);

// ── F1. url:null must not clobber a good mirror ───────────────────────────
// Fails if mergeFontEntries reverts to blind last-write-wins.
check('M1 good url survives later url:null candidate (F1)', () => {
  const existing = [{
    family: 'Söhne',
    weight: 400,
    style: 'normal',
    url: 'https://res.cloudinary.com/example/raw/soehne-good.woff2',
    license: 'commercial',
    needsLicense: false,
  }];
  const result = {
    ingested: [],
    flagged: [{
      family: 'Söhne',
      weight: 400,
      style: 'normal',
      url: null,
      license: 'commercial',
      needsLicense: true,
    }],
  };
  const merged = mergeFontEntries(existing, result);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(
    merged[0].url,
    'https://res.cloudinary.com/example/raw/soehne-good.woff2',
    'good url must survive flagged re-ingest'
  );
  assert.strictEqual(merged[0].needsLicense, false, 'must keep prior entry intact');
});

check('M2 url:null still ADDED when no prior url exists (F1 add path)', () => {
  const existing = [];
  const result = {
    ingested: [],
    flagged: [{
      family: 'Söhne',
      weight: 400,
      style: 'normal',
      url: null,
      license: 'commercial',
      needsLicense: true,
    }],
  };
  const merged = mergeFontEntries(existing, result);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].url, null);
  assert.strictEqual(merged[0].needsLicense, true);
});

check('M3 last-write-wins still applies for non-null urls (F1 rest)', () => {
  const existing = [{
    family: 'Inter',
    weight: 400,
    style: 'normal',
    url: 'https://res.cloudinary.com/example/raw/inter-old.woff2',
    license: 'google',
    needsLicense: false,
  }];
  const result = {
    ingested: [{
      family: 'Inter',
      weight: 400,
      style: 'normal',
      url: 'https://res.cloudinary.com/example/raw/inter-new.woff2',
      license: 'google',
      needsLicense: false,
    }],
    flagged: [],
  };
  const merged = mergeFontEntries(existing, result);
  assert.strictEqual(merged[0].url, 'https://res.cloudinary.com/example/raw/inter-new.woff2');
});

// ── F2. magic bytes ───────────────────────────────────────────────────────
// Fails if isFontMagic is loosened or removed.
check('B1 HTML buffer rejected (F2)', () => {
  const html = Buffer.from('<html><body>challenge</body></html>');
  // pad past 1KB so size alone would have accepted it
  const padded = Buffer.concat([html, Buffer.alloc(2048, 0x20)]);
  assert.strictEqual(isFontMagic(padded), false);
  assert.strictEqual(isFontMagic(html), false);
});
check('B2 wOFF magic accepted (F2)', () => {
  const buf = Buffer.concat([Buffer.from('wOFF'), Buffer.alloc(16, 0)]);
  assert.strictEqual(isFontMagic(buf), true);
});
check('B3 wOF2 magic accepted (F2)', () => {
  assert.strictEqual(isFontMagic(Buffer.from('wOF2xxxx')), true);
});
check('B4 OTTO (otf) magic accepted (F2)', () => {
  assert.strictEqual(isFontMagic(Buffer.from('OTTOxxxx')), true);
});
check('B5 ttf \\x00\\x01\\x00\\x00 magic accepted (F2)', () => {
  assert.strictEqual(isFontMagic(Buffer.from([0x00, 0x01, 0x00, 0x00, 0xaa, 0xbb])), true);
});
check('B6 ttcf collection magic accepted (F2)', () => {
  assert.strictEqual(isFontMagic(Buffer.from('ttcfxxxx')), true);
});
check('B7 not-a-font failure class (F2)', () => {
  assert.strictEqual(
    downloadFailureClass(new Error('font payload not-a-font (magic=0x3c68746d, 4096B)')),
    'not-a-font'
  );
});

// ── F3. human hold preserved; auto-flag is not a hold ─────────────────────
// Fails if needsLicense is always taken from the candidate.
check('H1 usable-face hold survives successful re-ingest (F3)', () => {
  const existing = [{
    family: 'Söhne',
    weight: 400,
    style: 'normal',
    url: 'https://res.cloudinary.com/example/raw/soehne-x.woff2',
    license: 'commercial',
    needsLicense: true, // explicit human hold on a usable face
  }];
  const result = {
    ingested: [{
      family: 'Söhne',
      weight: 400,
      style: 'normal',
      url: 'https://res.cloudinary.com/example/raw/soehne-y.woff2',
      license: 'commercial',
      needsLicense: false, // machine-cleared success
    }],
    flagged: [],
  };
  const merged = mergeFontEntries(existing, result);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].url, 'https://res.cloudinary.com/example/raw/soehne-y.woff2');
  assert.strictEqual(merged[0].needsLicense, true, 'human hold must be preserved');
});

check('H2 auto-flag shape does NOT create a hold (F3)', () => {
  // Existing is a good usable face with needsLicense:false. A failed
  // re-ingest flags {url:null, needsLicense:true} — that must not replace
  // (F1) and must not turn into a hold on the surviving entry.
  const existing = [{
    family: 'Söhne',
    weight: 400,
    style: 'normal',
    url: 'https://res.cloudinary.com/example/raw/soehne-good.woff2',
    license: 'commercial',
    needsLicense: false,
  }];
  const result = {
    ingested: [],
    flagged: [{
      family: 'Söhne',
      weight: 400,
      style: 'normal',
      url: null,
      license: 'commercial',
      needsLicense: true, // auto-flag shape, NOT a human hold
    }],
  };
  const merged = mergeFontEntries(existing, result);
  assert.strictEqual(merged[0].url, 'https://res.cloudinary.com/example/raw/soehne-good.woff2');
  assert.strictEqual(merged[0].needsLicense, false, 'auto-flag must not invent a hold');
});

check('H3 non-hold successful re-ingest still clears needsLicense (F3 rest)', () => {
  const existing = [{
    family: 'Inter',
    weight: 400,
    style: 'normal',
    url: 'https://res.cloudinary.com/example/raw/inter-old.woff2',
    license: 'google',
    needsLicense: false,
  }];
  const result = {
    ingested: [{
      family: 'Inter',
      weight: 400,
      style: 'normal',
      url: 'https://res.cloudinary.com/example/raw/inter-new.woff2',
      license: 'google',
      needsLicense: false,
    }],
    flagged: [],
  };
  const merged = mergeFontEntries(existing, result);
  assert.strictEqual(merged[0].needsLicense, false);
});

// ── F4. commercial cap is independent of open budget ─────────────────────
// Drives the REAL canMirrorFace / bumpMirrorCount selection logic (not a
// re-implementation of the numbers). Fails if caps collapse to one counter.
check('C1 12 commercial + 3 open → commercial capped, all 3 open (F4)', () => {
  assert.ok(MAX_COMMERCIAL_FACES < MAX_INGESTED_FACES,
    'commercial cap must be strictly smaller than open budget for this scenario');
  const counts = { open: 0, commercial: 0 };
  const licenses = [
    ...Array(12).fill('commercial'),
    ...Array(3).fill('open'),
  ];
  const accepted = [];
  for (const license of licenses) {
    if (!canMirrorFace(license, counts)) continue;
    accepted.push(license);
    bumpMirrorCount(license, counts);
  }
  const commercialAccepted = accepted.filter((l) => l === 'commercial').length;
  const openAccepted = accepted.filter((l) => l === 'open').length;
  assert.strictEqual(commercialAccepted, MAX_COMMERCIAL_FACES,
    `commercial must cap at ${MAX_COMMERCIAL_FACES}, got ${commercialAccepted}`);
  assert.strictEqual(openAccepted, 3,
    `all 3 open faces must ingest, got ${openAccepted}`);
  assert.strictEqual(counts.commercial, MAX_COMMERCIAL_FACES);
  assert.strictEqual(counts.open, 3);
});

check('C2 open budget still caps at MAX_INGESTED_FACES (F4 non-regression)', () => {
  const counts = { open: 0, commercial: 0 };
  let accepted = 0;
  for (let i = 0; i < MAX_INGESTED_FACES + 5; i++) {
    if (!canMirrorFace('google', counts)) continue;
    accepted++;
    bumpMirrorCount('google', counts);
  }
  assert.strictEqual(accepted, MAX_INGESTED_FACES);
});

check('C3 commercial alone caps at MAX_COMMERCIAL_FACES (F4)', () => {
  const counts = { open: 0, commercial: 0 };
  let accepted = 0;
  for (let i = 0; i < MAX_COMMERCIAL_FACES + 5; i++) {
    if (!canMirrorFace('commercial', counts)) continue;
    accepted++;
    bumpMirrorCount('commercial', counts);
  }
  assert.strictEqual(accepted, MAX_COMMERCIAL_FACES);
});

// ── summary ───────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.error('\nFAILURES:');
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('all checks green');
