#!/usr/bin/env node
//
// Unit checks for utils/htmlEntities, plus the pure row transform in
// scripts/backfillHtmlEntities. No network, no DB connection, no test
// framework — node:assert + the house check() runner (scripts/test*.js).
//
// Usage:
//   node scripts/testHtmlEntities.js

'use strict';

const assert = require('node:assert/strict');
const {
  decodeHtmlEntities,
  cleanScrapedText,
  hasHtmlEntity
} = require('../utils/htmlEntities');
// Model registration only — the backfill connects to Mongo solely under
// require.main, so requiring it here is inert.
const { repairProductFields, ENTITY_MONGO_RE } = require('./backfillHtmlEntities');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`✗ ${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

// ── the bug that started this: inch marks ──────────────────────────

check('inch marks: &quot; / &#34; / &#x22; all decode to "', () => {
  assert.equal(decodeHtmlEntities('33&quot; Table'), '33" Table');
  assert.equal(decodeHtmlEntities('33&#34; Table'), '33" Table');
  assert.equal(decodeHtmlEntities('33&#x22; Table'), '33" Table');
  assert.equal(decodeHtmlEntities('33&#X22; Table'), '33" Table');
});

check('real Living Spaces titles round-trip', () => {
  assert.equal(
    decodeHtmlEntities('Austen Black 74&quot; Wide Wood TV Stand | Doors | Shelves'),
    'Austen Black 74" Wide Wood TV Stand | Doors | Shelves'
  );
  assert.equal(
    decodeHtmlEntities('Paulina Black &amp; Grey 71&quot; Modern Asymmetrical Wood TV Stand'),
    'Paulina Black & Grey 71" Modern Asymmetrical Wood TV Stand'
  );
  assert.equal(
    decodeHtmlEntities('Voyage Natural 80&quot; TV Stand By Nate Berkus &#x2B; Jeremiah Brent'),
    'Voyage Natural 80" TV Stand By Nate Berkus + Jeremiah Brent'
  );
  assert.equal(
    decodeHtmlEntities('Capri Brown Eucalyptus 100&#x201D; Outdoor Dining Set'),
    'Capri Brown Eucalyptus 100” Outdoor Dining Set'
  );
});

// ── decoding rules ─────────────────────────────────────────────────

check('named refs are case-sensitive per HTML5; unknown names survive', () => {
  assert.equal(decodeHtmlEntities('a &AMP; b'), 'a &AMP; b');
  assert.equal(decodeHtmlEntities('Model &foo; 5'), 'Model &foo; 5');
  assert.equal(decodeHtmlEntities('50% &off; today'), '50% &off; today');
});

check('semicolon required — bare & and &amp without ; are left alone', () => {
  assert.equal(decodeHtmlEntities('Salt & Pepper'), 'Salt & Pepper');
  assert.equal(decodeHtmlEntities('A &amp B'), 'A &amp B');
});

check('single pass — double-escaped &amp;quot; decodes to the literal &quot;', () => {
  assert.equal(decodeHtmlEntities('&amp;quot;'), '&quot;');
});

check('numeric guards: NUL, lone surrogate, out-of-range left verbatim', () => {
  assert.equal(decodeHtmlEntities('a&#0;b'), 'a&#0;b');
  assert.equal(decodeHtmlEntities('a&#xD800;b'), 'a&#xD800;b');
  assert.equal(decodeHtmlEntities('a&#x110000;b'), 'a&#x110000;b');
});

check('windows-1252 remap: &#147;/&#148; are curly quotes, not C1 controls', () => {
  assert.equal(decodeHtmlEntities('&#147;quoted&#148;'), '“quoted”');
  assert.equal(decodeHtmlEntities('&#151;'), '—');
});

check('astral code points survive (emoji in titles)', () => {
  assert.equal(decodeHtmlEntities('&#x1F6CB;'), '\u{1F6CB}');
});

check('non-strings: null/undefined → empty string', () => {
  assert.equal(decodeHtmlEntities(null), '');
  assert.equal(decodeHtmlEntities(undefined), '');
  assert.equal(decodeHtmlEntities(42), '42');
});

// ── cleanScrapedText ───────────────────────────────────────────────

check('cleanScrapedText: decodes, folds nbsp, collapses whitespace, trims', () => {
  assert.equal(cleanScrapedText('  33&quot;&nbsp;Wide   Table \n'), '33" Wide Table');
});

check('cleanScrapedText: strips zero-width + BOM + soft hyphen', () => {
  assert.equal(cleanScrapedText('Sofa​﻿­Bed'), 'SofaBed');
  assert.equal(cleanScrapedText('Sofa&#x200B;Bed'), 'SofaBed');
});

check('cleanScrapedText: empty / whitespace-only → null', () => {
  assert.equal(cleanScrapedText(''), null);
  assert.equal(cleanScrapedText('   '), null);
  assert.equal(cleanScrapedText('&nbsp;'), null);
  assert.equal(cleanScrapedText(null), null);
});

check('cleanScrapedText: objects → null, never "[object Object]"', () => {
  assert.equal(cleanScrapedText({ name: 'x' }), null);
  assert.equal(cleanScrapedText(['a']), null);
});

check('cleanScrapedText: maxLen truncates AFTER decoding, on a word boundary', () => {
  // "&quot;" is 6 chars encoded, 1 decoded — truncating first would cut
  // mid-entity and leave "&quo" in the field. The cut also lands between
  // words and is marked, so a clipped review reads as an excerpt rather than
  // as corrupted text.
  const out = cleanScrapedText('33&quot; Wide Table', 8);
  assert.equal(out, '33" Wide…');
  // Nothing is removed when it already fits.
  assert.equal(cleanScrapedText('33&quot; Wide', 20), '33" Wide');
});

// ── hasHtmlEntity (backfill row selection) ─────────────────────────

check('hasHtmlEntity: true only when something would actually change', () => {
  assert.equal(hasHtmlEntity('33&quot; Table'), true);
  assert.equal(hasHtmlEntity('Table &#x2B; Lamp'), true);
  assert.equal(hasHtmlEntity('33" Table'), false);
  assert.equal(hasHtmlEntity('Salt & Pepper'), false);
  assert.equal(hasHtmlEntity('Model &foo; 5'), false);
  assert.equal(hasHtmlEntity(null), false);
});

// ── backfill row transform ─────────────────────────────────────────

check('backfill: damaged row → decoded fields + recomputed normalizedTitle', () => {
  const set = repairProductFields({
    title: 'Austen Black 74&quot; Wide Wood TV Stand',
    description: '&lt;div&gt;Holds a 74&quot; TV&lt;/div&gt;',
    brand: 'Berkus &#x2B; Brent',
    category: 'TV Stands &amp; Consoles',
    inferredBreadcrumb: ['Lighting', 'Table &#x2B; Buffet Lamps'],
    productReviews: { quotes: [{ text: 'Fits my 55&quot; TV', author: 'Sam &#x2B; Dana' }] },
    normalizedTitle: 'austen black 74 quot wide wood tv stand'
  });
  assert.equal(set.title, 'Austen Black 74" Wide Wood TV Stand');
  assert.equal(set.description, 'Holds a 74" TV');
  assert.equal(set.brand, 'Berkus + Brent');
  assert.equal(set.category, 'TV Stands & Consoles');
  assert.deepEqual(set.inferredBreadcrumb, ['Lighting', 'Table + Buffet Lamps']);
  assert.equal(set['productReviews.quotes'][0].text, 'Fits my 55" TV');
  assert.equal(set['productReviews.quotes'][0].author, 'Sam + Dana');
  // "quot" token is gone from the matcher key
  assert.equal(set.normalizedTitle, 'austen black 74 wide wood tv stand');
});

check('backfill: clean row → empty $set (idempotent, no rewrite)', () => {
  const set = repairProductFields({
    title: 'Austen Black 74" Wide Wood TV Stand',
    description: 'Holds a 74" TV',
    brand: 'Berkus + Brent',
    category: 'TV Stands & Consoles',
    inferredBreadcrumb: ['Lighting', 'Table + Buffet Lamps'],
    productReviews: { quotes: [{ text: 'Fits my 55" TV', author: 'Sam' }] },
    normalizedTitle: 'austen black 74 wide wood tv stand'
  });
  assert.deepEqual(set, {});
});

check('backfill: literal ampersand text is left alone', () => {
  assert.deepEqual(repairProductFields({ title: 'Salt & Pepper Mill' }), {});
});

check('backfill: prefilter regex matches encoded rows only', () => {
  assert.equal(ENTITY_MONGO_RE.test('74&quot; Stand'), true);
  assert.equal(ENTITY_MONGO_RE.test('Table &#x2B; Lamp'), true);
  assert.equal(ENTITY_MONGO_RE.test('74" Stand'), false);
});

// ── summary ────────────────────────────────────────────────────────

const total = passed + failed;
console.log(`${passed}/${total} checks passed`);
process.exit(failed ? 1 : 0);
