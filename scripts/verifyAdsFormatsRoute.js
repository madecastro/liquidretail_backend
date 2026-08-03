#!/usr/bin/env node
'use strict';
//
// verifyAdsFormatsRoute — pins GET /api/ads/formats wiring.
//
// formatCatalog() was exported but routed nowhere, so the SPA hardcoded
// the format list and offered Performance Max (pmax_16_9), which the
// backend refuses with 400 PLATFORM_FORMAT_COMING_SOON. The frontend
// now consumes this endpoint (static fallback if absent); shape and
// registration order matter.
//
// Offline: no DB, no network, no key.
//   node scripts/verifyAdsFormatsRoute.js

const fs = require('fs');
const path = require('path');
const pf = require('../services/platformFormats');

let pass = 0;
const failures = [];

function check(label, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

const adsSrc = fs.readFileSync(path.join(__dirname, '../routes/ads.js'), 'utf8');

// ── 1. Route registered above /:id ──────────────────────────────────
const formatsIdx = adsSrc.indexOf("router.get('/formats'");
const firstIdIdx = adsSrc.search(/router\.(get|post|patch|delete)\('\/:id/);
check('GET /formats is registered', formatsIdx > 0);
check('GET /formats sits ABOVE the first /:id handler',
  formatsIdx > 0 && firstIdIdx > 0 && formatsIdx < firstIdIdx,
  `formats@${formatsIdx} firstId@${firstIdIdx}`);

// ── 2. Handler calls formatCatalog, no brandId gate ─────────────────
const slice = adsSrc.slice(formatsIdx, formatsIdx + 500);
check('handler calls formatCatalog()', /formatCatalog\s*\(/.test(slice));
check('no brandId required gate on /formats', !/brandId required/.test(slice));
check('returns formatCatalog() verbatim via res.json',
  /res\.json\s*\(\s*formatCatalog\s*\(\s*\)\s*\)/.test(slice));

// ── 3. Payload shape matches what the SPA expects ───────────────────
const cat = pf.formatCatalog();
check('formatCatalog returns { platforms: [...] }',
  Array.isArray(cat?.platforms) && cat.platforms.length >= 2);
const ids = (cat.platforms || []).map((p) => p.id);
check('catalog includes meta', ids.includes('meta'));
check('catalog includes google', ids.includes('google'));

const meta = cat.platforms.find((p) => p.id === 'meta');
const google = cat.platforms.find((p) => p.id === 'google');
check('meta has live formats the SPA can offer',
  (meta?.formats || []).some((f) => f.status === 'live'));
check('every google platform format is coming_soon (incl. pmax)',
  (google?.formats || []).length > 0 &&
  (google.formats || []).every((f) => f.status === 'coming_soon'));
check('pmax_16_9 is present and coming_soon (the bug the SPA was hardcoding live)',
  (google?.formats || []).some((f) => f.key === 'pmax_16_9' && f.status === 'coming_soon'));

// ── 4. Brand-agnostic / no tenant surface ───────────────────────────
// formatCatalog is pure in-memory PLATFORM_FORMATS data — no brandId
// arg, no Mongo, no advertiser fields. Re-assert by shape inspection.
const json = JSON.stringify(cat);
check('catalog payload has no advertiser/brand id fields',
  !/"advertiserId"/.test(json) && !/"brandId"/.test(json) && !/"_id"/.test(json));
check('formatCatalog takes no brand argument (arity 0)',
  pf.formatCatalog.length === 0);

// ── report ──────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`\nverifyAdsFormatsRoute: ${failures.length} FAIL(s), ${pass} pass\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`verifyAdsFormatsRoute: ${pass} pass, 0 fail`);
process.exit(0);
