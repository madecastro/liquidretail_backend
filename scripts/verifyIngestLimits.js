#!/usr/bin/env node
// Offline pins for services/ingestLimits.js — env parsers + the two
// exported cap functions — plus structural checks that every ingest
// service actually applies the cap at its persist loop.
//
// Runs zero DB / zero network.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', 'config', 'defaults.env'), quiet: true });

const svc = require('../services/ingestLimits');
const {
  catalogIngestLimit, socialIngestLimit, shouldContinueIngest,
  __test: { readLimit, DEFAULT_LIMIT, CAP_MIN, CAP_MAX }
} = svc;

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

// ── Section A — env parser ────────────────────────────────────────────

console.log('\n== A. readLimit env parser ==');

check('A1 DEFAULT_LIMIT is 10 (matches shipped defaults.env)', () => {
  assert.strictEqual(DEFAULT_LIMIT, 10);
});

const prior = process.env.CATALOG_INGEST_LIMIT;
try {
  check('A2 unset → DEFAULT_LIMIT (10)', () => {
    delete process.env.CATALOG_INGEST_LIMIT;
    assert.strictEqual(readLimit('CATALOG_INGEST_LIMIT'), 10);
  });
  check('A3 "10" → 10', () => {
    process.env.CATALOG_INGEST_LIMIT = '10';
    assert.strictEqual(readLimit('CATALOG_INGEST_LIMIT'), 10);
  });
  check('A4 "50" → 50', () => {
    process.env.CATALOG_INGEST_LIMIT = '50';
    assert.strictEqual(readLimit('CATALOG_INGEST_LIMIT'), 50);
  });
  check('A5 "0" → null (explicit uncapped)', () => {
    process.env.CATALOG_INGEST_LIMIT = '0';
    assert.strictEqual(readLimit('CATALOG_INGEST_LIMIT'), null);
  });
  check('A6 negative → null (uncapped, ops sentinel)', () => {
    process.env.CATALOG_INGEST_LIMIT = '-1';
    assert.strictEqual(readLimit('CATALOG_INGEST_LIMIT'), null);
  });
  check('A7 "unlimited" → default (10) — reads as unset-alias', () => {
    process.env.CATALOG_INGEST_LIMIT = 'unlimited';
    assert.strictEqual(readLimit('CATALOG_INGEST_LIMIT'), 10);
  });
  check('A8 above CAP_MAX (10001) → null (fail-safe against runaway)', () => {
    process.env.CATALOG_INGEST_LIMIT = String(CAP_MAX + 1);
    assert.strictEqual(readLimit('CATALOG_INGEST_LIMIT'), null);
  });
  check('A9 at CAP_MAX (10000) → CAP_MAX', () => {
    process.env.CATALOG_INGEST_LIMIT = String(CAP_MAX);
    assert.strictEqual(readLimit('CATALOG_INGEST_LIMIT'), CAP_MAX);
  });
  check('A10 "10.5" → default (rejects fractional)', () => {
    // parseInt('10.5') is 10 — that would silently truncate a fat-fingered
    // fractional intent. Strict integer parse insists on the whole string
    // representing an integer.
    process.env.CATALOG_INGEST_LIMIT = '10.5';
    assert.strictEqual(readLimit('CATALOG_INGEST_LIMIT'), 10);
  });
  check('A11 garbage → default', () => {
    process.env.CATALOG_INGEST_LIMIT = 'foo';
    assert.strictEqual(readLimit('CATALOG_INGEST_LIMIT'), 10);
  });
  check('A12 leading/trailing whitespace tolerated', () => {
    process.env.CATALOG_INGEST_LIMIT = '  25  ';
    assert.strictEqual(readLimit('CATALOG_INGEST_LIMIT'), 25);
  });
} finally {
  if (prior === undefined) delete process.env.CATALOG_INGEST_LIMIT;
  else process.env.CATALOG_INGEST_LIMIT = prior;
}

// ── Section B — shouldContinueIngest ─────────────────────────────────

console.log('\n== B. shouldContinueIngest gate ==');

check('B1 null cap → always continue (uncapped)', () => {
  assert.strictEqual(shouldContinueIngest(0, null), true);
  assert.strictEqual(shouldContinueIngest(9999, null), true);
});

check('B2 cap not yet reached → continue', () => {
  assert.strictEqual(shouldContinueIngest(0, 10), true);
  assert.strictEqual(shouldContinueIngest(9, 10), true);
});

check('B3 cap reached → stop', () => {
  assert.strictEqual(shouldContinueIngest(10, 10), false);
  assert.strictEqual(shouldContinueIngest(11, 10), false);
});

// ── Section C — public API returns wired to right env names ──────────

console.log('\n== C. catalogIngestLimit / socialIngestLimit → right env ==');

check('C1 catalogIngestLimit reads CATALOG_INGEST_LIMIT', () => {
  const priorCat = process.env.CATALOG_INGEST_LIMIT;
  try {
    process.env.CATALOG_INGEST_LIMIT = '25';
    assert.strictEqual(catalogIngestLimit(), 25);
  } finally {
    if (priorCat === undefined) delete process.env.CATALOG_INGEST_LIMIT;
    else process.env.CATALOG_INGEST_LIMIT = priorCat;
  }
});

check('C2 socialIngestLimit reads SOCIAL_INGEST_LIMIT', () => {
  const priorSoc = process.env.SOCIAL_INGEST_LIMIT;
  try {
    process.env.SOCIAL_INGEST_LIMIT = '15';
    assert.strictEqual(socialIngestLimit(), 15);
  } finally {
    if (priorSoc === undefined) delete process.env.SOCIAL_INGEST_LIMIT;
    else process.env.SOCIAL_INGEST_LIMIT = priorSoc;
  }
});

check('C3 catalogIngestLimit + socialIngestLimit are independent', () => {
  const pc = process.env.CATALOG_INGEST_LIMIT;
  const ps = process.env.SOCIAL_INGEST_LIMIT;
  try {
    process.env.CATALOG_INGEST_LIMIT = '5';
    process.env.SOCIAL_INGEST_LIMIT = '20';
    assert.strictEqual(catalogIngestLimit(), 5);
    assert.strictEqual(socialIngestLimit(), 20);
  } finally {
    if (pc === undefined) delete process.env.CATALOG_INGEST_LIMIT; else process.env.CATALOG_INGEST_LIMIT = pc;
    if (ps === undefined) delete process.env.SOCIAL_INGEST_LIMIT; else process.env.SOCIAL_INGEST_LIMIT = ps;
  }
});

// ── Section D — every ingest service applies the cap ─────────────────
//
// Structural pins on each ingest file — if a future refactor drops the
// cap from any of them, that service will silently blow past the demo
// budget the env is meant to guard.

console.log('\n== D. every ingest service applies the cap ==');

const ingestFiles = [
  { file: 'services/catalogSyncService.js',            capFn: 'catalogIngestLimit', envName: 'CATALOG_INGEST_LIMIT' },
  { file: 'services/shopifyPublicIngestService.js',    capFn: 'catalogIngestLimit', envName: 'CATALOG_INGEST_LIMIT' },
  { file: 'services/genericCatalogIngestService.js',   capFn: 'catalogIngestLimit', envName: 'CATALOG_INGEST_LIMIT' },
  { file: 'services/apifyIngestService.js',            capFn: 'catalogIngestLimit', envName: 'CATALOG_INGEST_LIMIT' },
  { file: 'services/postSyncService.js',               capFn: 'socialIngestLimit',  envName: 'SOCIAL_INGEST_LIMIT'  },
  { file: 'services/apifyIngestService.js',            capFn: 'socialIngestLimit',  envName: 'SOCIAL_INGEST_LIMIT'  }
];

for (const { file, capFn, envName } of ingestFiles) {
  check(`D-${capFn}: ${file} requires ingestLimits + calls ${capFn}`, () => {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.match(src, /require\(['"]\.\/ingestLimits['"]\)/,
      `${file} must require ingestLimits`);
    assert.match(src, new RegExp(`${capFn}\\s*\\(`),
      `${file} must call ${capFn}()`);
    assert.match(src, new RegExp(envName),
      `${file}'s cap log line must reference ${envName} so an operator reading Render logs knows which env to bump`);
  });
}

// ── Section E — defaults.env commits the shipped values ──────────────

console.log('\n== E. defaults.env commits the shipped values ==');

const defaults = fs.readFileSync(path.join(__dirname, '..', 'config', 'defaults.env'), 'utf8');

check('E1 CATALOG_INGEST_LIMIT=10 in defaults.env', () => {
  assert.match(defaults, /^CATALOG_INGEST_LIMIT=10$/m);
});
check('E2 SOCIAL_INGEST_LIMIT=10 in defaults.env', () => {
  assert.match(defaults, /^SOCIAL_INGEST_LIMIT=10$/m);
});
check('E3 OVERLAY_ZONES_MODE=dino in defaults.env (flipped 2026-09-02)', () => {
  assert.match(defaults, /^OVERLAY_ZONES_MODE=dino$/m);
});

// ── Summary ──────────────────────────────────────────────────────────

const total = results.length;
const passed = results.filter(r => r.ok).length;
console.log(`\n${total} checks — ${passed} passed, ${total - passed} failed`);
if (passed !== total) process.exit(1);
