#!/usr/bin/env node
'use strict';
/**
 * verifyRetroLinkDefaults — pins the new default match settings for the
 * catalog retro-link + post rematch pipeline (2026-09-01):
 *
 *   1. utils/titleNormalize.titleSimilarity accepts an optional
 *      { extraStop } param so per-brand stopwords can filter tokens
 *      without touching the default-behavior for existing callers.
 *   2. services/catalogRetroLinkService uses MIN_SHARED_TOKENS=2 (down
 *      from 3), backed by an auto-derived brand-stopword set so
 *      generic tokens (brand name, category words) don't count as
 *      shared signal. Measured on Pelagic Gear 4 Demos: 4→25 fixes.
 *   3. services/postRematchAfterCatalogService source filter includes
 *      both 'instagram' AND 'apify-ig' so demo-brand IG post Media
 *      qualify for paid re-detect. Bug found same day — the old
 *      filter silently zeroed every demo brand's rematch.
 *
 * Offline: no DB, no network, no API keys.
 *   node scripts/verifyRetroLinkDefaults.js
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

let pass = 0;
const failures = [];
function check(id, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${id}`); }
  else {
    const msg = detail ? `${id} — ${detail}` : id;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

// ── A: titleSimilarity signature + backwards compat ──
{
  const { titleSimilarity } = require('../utils/titleNormalize');
  // Backwards-compat: two-arg call still works, no throw.
  const base = titleSimilarity('Freespool Rusted Icon', 'PELAGIC Freespool');
  check('A1: titleSimilarity(a, b) works without opts',
    typeof base.score === 'number' && typeof base.shared === 'number',
    `got ${JSON.stringify(base)}`);
  // Extra stop: passing a stopword drops it from shared count.
  const withStop = titleSimilarity(
    'PELAGIC Trucker - Flybridge Deluxe',
    'Flybridge Deluxe',
    { extraStop: new Set(['pelagic', 'trucker']) }
  );
  check('A2: titleSimilarity honours extraStop (Pelagic/Trucker filtered)',
    withStop.shared === 2 && withStop.score === 1.0,
    `expected shared=2 score=1.0, got ${JSON.stringify(withStop)}`);
  // Without extraStop the same pair would still share 2 (flybridge, deluxe).
  const withoutStop = titleSimilarity(
    'PELAGIC Trucker - Flybridge Deluxe',
    'Flybridge Deluxe'
  );
  check('A3: titleSimilarity default (no extraStop) still counts brand token as noise-neutral',
    withoutStop.shared === 2,
    `expected shared=2, got ${JSON.stringify(withoutStop)}`);
}

// ── B: catalogRetroLinkService constants + exports ──
{
  const svc = require('../services/catalogRetroLinkService');
  check('B1: MIN_SHARED_TOKENS export exists',
    Number.isInteger(svc.MIN_SHARED_TOKENS),
    'MIN_SHARED_TOKENS not exported');
  check('B2: MIN_SHARED_TOKENS === 2',
    svc.MIN_SHARED_TOKENS === 2,
    `expected 2, got ${svc.MIN_SHARED_TOKENS}`);
  check('B3: brandStopTokens exported',
    typeof svc.brandStopTokens === 'function',
    'brandStopTokens not exported');
  check('B4: UNIVERSAL_STOP_TOKENS exported (universal category-generic words)',
    svc.UNIVERSAL_STOP_TOKENS instanceof Set && svc.UNIVERSAL_STOP_TOKENS.size > 0,
    'UNIVERSAL_STOP_TOKENS not exported or empty');
  check('B5: UNIVERSAL_STOP_TOKENS contains category noise words',
    ['gear', 'shirt', 'hat', 'trucker', 'ws'].every(t => svc.UNIVERSAL_STOP_TOKENS.has(t)),
    `missing one of gear/shirt/hat/trucker/ws in ${[...svc.UNIVERSAL_STOP_TOKENS].join(',')}`);
  // brand-name derivation
  const stops = svc.brandStopTokens('Pelagic Gear');
  check('B6: brandStopTokens derives from brand name',
    stops.has('pelagic') && stops.has('gear'),
    `expected {pelagic, gear} in ${[...stops].join(',')}`);
  check('B7: brandStopTokens still includes universal set on top',
    stops.has('shirt') && stops.has('trucker'),
    'universal tokens missing from brandStopTokens output');
  // no brand name → still universal
  const noBrand = svc.brandStopTokens('');
  check('B8: brandStopTokens("") returns universal only',
    noBrand.size === svc.UNIVERSAL_STOP_TOKENS.size,
    `expected size ${svc.UNIVERSAL_STOP_TOKENS.size}, got ${noBrand.size}`);
}

// ── C: postRematchAfterCatalogService source filter ──
{
  const src = read('services/postRematchAfterCatalogService.js');
  check('C1: source filter includes apify-ig (demo brands)',
    /source:\s*\{\s*\$in:\s*\[\s*['"]instagram['"]\s*,\s*['"]apify-ig['"]\s*\]/.test(src),
    'query must accept both real-IG-connected brands and demo brands');
  check('C2: NO residual bare source: "instagram" query on candidate media',
    !/source:\s*['"]instagram['"]\s*\}\)\.select/.test(src),
    'old single-source filter would silently zero every demo brand rematch');
}

// ── D: runBrandWide integrates extraStop through the chain ──
{
  const svcSrc = read('services/catalogRetroLinkService.js');
  check('D1: runImpl computes extraStop via brandStopTokens',
    /extraStop\s*=\s*brandStopTokens\(brandDoc\?\.name\s*\|\|\s*['"]{2}\)/.test(svcSrc),
    'brandStopTokens must be called per brand at runtime');
  check('D2: findBestSyncedTwin accepts + threads extraStop into titleSimilarity',
    /titleSimilarity\([^,]+,\s*[^,]+,\s*opts\)/.test(svcSrc),
    'the twin matcher must pass extraStop through so MIN=2 is safe');
  // Ensure BOTH Pass A and Pass B call findBestSyncedTwin with extraStop.
  const passAWithStop = /findBestSyncedTwin\(a\.identification\?\.productName,\s*synced,\s*extraStop\)/.test(svcSrc);
  const passBWithStop = /findBestSyncedTwin\(phantom\.normalizedTitle[^,]*,\s*synced,\s*extraStop\)/.test(svcSrc);
  check('D3: Pass A (unlinked artifact re-link) passes extraStop',
    passAWithStop,
    'Pass A must use the same stopword set as Pass B');
  check('D4: Pass B (phantom twin collapse) passes extraStop',
    passBWithStop,
    'Pass B must use the same stopword set as Pass A');
}

if (failures.length) {
  console.log(`\n${pass} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`\n${pass} passed, 0 failed`);
process.exit(0);
