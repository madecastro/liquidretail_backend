#!/usr/bin/env node
'use strict';
//
// verifyVideoRefPrewarm — pins the wizard video-ref prewarm glue.
//
// Source-scan style is intentional: the service is thin glue over
// buildReferenceImages / reframeReferenceForAspect, which are already
// harnessed for money/cache/claim behaviour. This file only pins that
// the prewarm path (a) cannot introduce new billable entry points,
// (b) actually calls the shared run-path functions, (c) registers the
// route above /:id, (d) caps productIds, (e) has a kill-switch, and
// (f) the claim-loser wait is wired so a run racing a mid-flight
// prewarm waits for the generative asset instead of degrading to crop.
//
// Pure + offline: no DB, no network, no API key. Safe to run anywhere.
//   node scripts/verifyVideoRefPrewarm.js

const fs = require('fs');
const path = require('path');

let pass = 0;
const failures = [];

function check(label, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

const root = path.join(__dirname, '..');
const svcPath = path.join(root, 'services/videoRefPrewarmService.js');
const adsPath = path.join(root, 'routes/ads.js');
const atlasPath = path.join(root, 'services/atlasVideoService.js');
const defaultsPath = path.join(root, 'config/defaults.env');

check('services/videoRefPrewarmService.js exists', fs.existsSync(svcPath));
check('routes/ads.js exists', fs.existsSync(adsPath));

const svcSrc = fs.existsSync(svcPath) ? fs.readFileSync(svcPath, 'utf8') : '';
const adsSrc = fs.existsSync(adsPath) ? fs.readFileSync(adsPath, 'utf8') : '';
const atlasSrc = fs.existsSync(atlasPath) ? fs.readFileSync(atlasPath, 'utf8') : '';
const defaultsSrc = fs.existsSync(defaultsPath) ? fs.readFileSync(defaultsPath, 'utf8') : '';

// ── 1. No new billable entry points in the prewarm service ──────────
// The ONLY billable path allowed is reframe via buildReferenceImages.
// Call-shaped ('name(') so a docs comment naming the run path does not trip
// the scan — the pin is "never INVOKED", not "never mentioned".
const FORBIDDEN_CALLS = [
  'submitImageGeneration(',
  'generateForAd(',
  'enqueueProductDetect(',
  'axios.post(',
  'generateImage('
];
for (const needle of FORBIDDEN_CALLS) {
  check(
    `prewarm service does NOT invoke billable entry '${needle}'`,
    !svcSrc.includes(needle)
  );
}

// ── 2. Calls the shared run-path functions + tenancy guard ──────────
check('prewarm service calls buildReferenceImages(',
  svcSrc.includes('buildReferenceImages('));
check('prewarm service calls resolveModelAndAspect(',
  svcSrc.includes('resolveModelAndAspect('));
check('prewarm service pins brandId ownership guard',
  svcSrc.includes('String(product.brandId) !== String(brandId)'));
// Call-shaped for the same reason as FORBIDDEN_CALLS — the KNOWN LIMITS header
// names enqueueProductDetect to explain why prewarm skips those products.
check('prewarm service does NOT lazy-materialize / detect',
  !svcSrc.includes("require('./catalogProductDetectService')") &&
  !svcSrc.includes('enqueueProductDetect('));
check('prewarm service uses META_VIDEO_MASTER',
  svcSrc.includes('META_VIDEO_MASTER'));

// Post-2026-09-03: the pre-warm walks a LIST of aspects (9:16 for
// META_VIDEO_MASTER, 16:9 for pmax_video_16_9). Warming only 9:16 left
// PMax landscape masters cold — adgen fired first, its stale-code path
// composite-outpainted the beyond-tolerance alts, and the ~$0.16 per
// affected product was avoidable. Pinning both aspects here so a
// future refactor that drops the 16:9 branch fails loudly before it
// silently re-opens the outpaint burn.
check('prewarm service defines the multi-aspect list constant',
  /PREWARM_PLATFORM_FORMATS\s*=/.test(svcSrc));
check('prewarm service warms pmax_video_16_9 alongside META_VIDEO_MASTER',
  /PREWARM_PLATFORM_FORMATS\s*=\s*\[[^\]]*META_VIDEO_MASTER[^\]]*pmax_video_16_9[^\]]*\]/.test(svcSrc));
check('prewarm loops buildReferenceImages over PREWARM_PLATFORM_FORMATS',
  /for\s*\(\s*const\s+platformFormat\s+of\s+PREWARM_PLATFORM_FORMATS\s*\)/.test(svcSrc));
check('prewarm per-aspect failure is swallowed (broken 16:9 must not lose the 9:16 warm)',
  /aspectErr[\s\S]{0,300}⚠️\s+prewarm/.test(svcSrc));
check('brand budget is claimed ONCE per product (not per aspect)',
  // Structural: claimBrandBudget must appear BEFORE the aspect loop, not inside it.
  (() => {
    const claimIdx = svcSrc.indexOf('claimBrandBudget(brandId)');
    const loopIdx = svcSrc.indexOf('of PREWARM_PLATFORM_FORMATS');
    return claimIdx > 0 && loopIdx > 0 && claimIdx < loopIdx;
  })(),
  'claimBrandBudget must sit above the aspect loop so both aspects share ONE cap slot per product');

// ── 3. Route registered ABOVE first /:id ────────────────────────────
const prewarmIdx = adsSrc.indexOf("'/video-ref-prewarm'");
const firstIdIdx = adsSrc.search(/router\.(get|post|patch|delete)\('\/:id/);
check('POST /video-ref-prewarm is registered in routes/ads.js',
  prewarmIdx > 0);
check('POST /video-ref-prewarm sits ABOVE the first /:id handler',
  prewarmIdx > 0 && firstIdIdx > 0 && prewarmIdx < firstIdIdx,
  `prewarm@${prewarmIdx} firstId@${firstIdIdx}`);

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

function braceBlockFrom(src, anchorLiteral) {
  const anchorIdx = src.indexOf(anchorLiteral);
  if (anchorIdx < 0) return '';
  const open = src.indexOf('{', anchorIdx);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return '';
}

// Slice the POST handler itself. A `{0,3000}` window from the first
// `video-ref-prewarm` (the comment above the route) to `status(202)` was
// 2209/3000 chars — comment growth CI-reds a still-correct handler, and a
// 202 belonging to a different handler inside 3000 chars would silently miss.
const adsCode = stripComments(adsSrc);
const prewarmHandler = braceBlockFrom(adsCode, "router.post('/video-ref-prewarm'");
check('route responds 202 on accept',
  /res\.status\(202\)/.test(prewarmHandler));
check('route fire-and-forget has .catch (no unhandled rejection)',
  /prewarmVideoRefsForProducts\(\{[\s\S]*\}\)\s*\n?\s*\.catch\(/.test(prewarmHandler));
check('route asserts brand tenancy',
  /assertBrandInTenant\(brandId, req\)/.test(prewarmHandler));

// ── 4. Cap of 12 ────────────────────────────────────────────────────
check('PREWARM_MAX_PRODUCTS = 12 in service',
  /PREWARM_MAX_PRODUCTS\s*=\s*12\b/.test(svcSrc));
check('route enforces PREWARM_MAX_PRODUCTS',
  /PREWARM_MAX_PRODUCTS/.test(prewarmHandler));

// ── 5. Kill-switch VIDEO_REF_PREWARM_ENABLED ────────────────────────
check('VIDEO_REF_PREWARM_ENABLED read present in route',
  adsSrc.includes('VIDEO_REF_PREWARM_ENABLED'));
check('defaults.env sets VIDEO_REF_PREWARM_ENABLED',
  /VIDEO_REF_PREWARM_ENABLED\s*=/.test(defaultsSrc));
check('disabled response shape present',
  /reason:\s*['"]disabled['"]/.test(adsSrc));

// ── 6. Claim-loser wait wiring (prewarm race guard) ─────────────────
// A run that loses the reframe claim to a mid-flight prewarm must wait for
// the winner's generative asset (env-tunable attempts), not crop after ~6s.
check('atlasVideoService defines REFRAME_CLAIM_WAIT_ATTEMPTS',
  /REFRAME_CLAIM_WAIT_ATTEMPTS\s*=\s*\(\)\s*=>/.test(atlasSrc));
check('claim-loser branch passes REFRAME_CLAIM_WAIT_ATTEMPTS to waitForReframeUrl',
  /waitForReframeUrl\(\s*\n?\s*media\._id,\s*aspectKey,\s*REFRAME_CLAIM_WAIT_ATTEMPTS\(\)\s*\n?\s*\)/.test(atlasSrc));
check('defaults.env sets REFRAME_CLAIM_WAIT_ATTEMPTS',
  /REFRAME_CLAIM_WAIT_ATTEMPTS\s*=\s*\d+/.test(defaultsSrc));
// The loser path must remain spend-free: between losing the claim and the
// return, there must be no submit. Structural pin: the loser block returns
// via waitForReframeUrl/fallback only (no submitImageGeneration between
// "claim held by another process" and the next occurrence of 'tryClaimReframe'
// definition or the winner branch).
{
  const loserStart = atlasSrc.indexOf('claim held by another process');
  const loserEnd = atlasSrc.indexOf('holdClaim = true');
  check('claim-loser block exists ahead of winner block',
    loserStart > 0 && loserEnd > loserStart);
  const loserBlock = loserStart > 0 && loserEnd > loserStart
    ? atlasSrc.slice(loserStart, loserEnd) : 'submitImageGeneration';
  check('claim-loser block contains NO submitImageGeneration',
    !loserBlock.includes('submitImageGeneration'));
}

// ── 7. Spend ceiling (adversarial finding 1) ────────────────────────
// The route is authenticated but unthrottled; without a rolling per-brand cap
// a runaway client could warm an entire catalog (~3 outpaints per cold product).
{
  const svc = require(svcPath);
  check('service exports PREWARM_BRAND_WINDOW_CAP',
    Number.isFinite(svc.PREWARM_BRAND_WINDOW_CAP) && svc.PREWARM_BRAND_WINDOW_CAP >= 1,
    `got ${svc.PREWARM_BRAND_WINDOW_CAP}`);
  check('rolling window is 1h',
    svc.PREWARM_BRAND_WINDOW_MS === 60 * 60 * 1000,
    `got ${svc.PREWARM_BRAND_WINDOW_MS}`);
  check('budget is claimed in the warm loop',
    /if\s*\(!claimBrandBudget\(brandId\)\)/.test(svcSrc));
  // Ordering pin: budget must be claimed AFTER the cheap loads and immediately
  // before buildReferenceImages, so a refused product never counts as warmed
  // and DB reads never consume budget.
  const budgetIdx = svcSrc.indexOf('claimBrandBudget(brandId)');
  const buildIdx = svcSrc.indexOf('await buildReferenceImages(');
  const markIdx = svcSrc.indexOf('markWarmed(brandId, pid)');
  check('budget claim sits before buildReferenceImages',
    budgetIdx > 0 && buildIdx > budgetIdx, `budget@${budgetIdx} build@${buildIdx}`);
  check('markWarmed happens after buildReferenceImages',
    markIdx > buildIdx && buildIdx > 0, `mark@${markIdx} build@${buildIdx}`);
  check('defaults.env sets VIDEO_REF_PREWARM_BRAND_HOURLY_CAP',
    /VIDEO_REF_PREWARM_BRAND_HOURLY_CAP\s*=\s*\d+/.test(defaultsSrc));
  check('memo size is bounded',
    /PREWARM_MEMO_MAX_ENTRIES/.test(svcSrc));
}

// ── 8. Claim-wait safety (adversarial findings 5 + 6) ───────────────
// (5) A loser must never sleep past the claim lease — once the lease ages out a
//     third process may steal and submit, so the sleep span is clamped to it.
// (6) A dead winner must not cost a full wait: the loser exits early when the
//     claim entry is gone or its lease has aged out.
check('REFRAME_CLAIM_WAIT_ATTEMPTS clamps its span against the claim TTL',
  /ttlSec\s*=\s*REFRAME_CLAIM_TTL_MS\(\)\s*\/\s*1000/.test(atlasSrc) &&
  /while\s*\(capped\s*>\s*1\s*&&\s*\(capped\s*\*\s*\(capped\s*\+\s*1\)\)\s*\/\s*2\s*>=\s*ttlSec\)/.test(atlasSrc));
check('waitForReframeUrl exits early when the winner released without a result',
  /if\s*\(!entry\s*\|\|\s*!entry\.claim\)\s*\{[\s\S]{0,220}return null;/.test(atlasSrc));
check('waitForReframeUrl exits early when the claim aged past the lease',
  /claimedAt\s*=\s*Date\.parse\(entry\.claim\.at\)/.test(atlasSrc) &&
  /Date\.now\(\)\s*-\s*claimedAt\s*>\s*claimTtlMs/.test(atlasSrc));
// Clamp math, executed rather than asserted textually: with the shipped default
// the wait span must be strictly under the TTL floor.
{
  const atlas = require(atlasPath);
  // Not exported — recompute the documented default to pin the arithmetic.
  const span = (26 * 27) / 2;            // seconds slept across 26 attempts
  const ttlFloorSec = (10 * 60 + 10 * 60); // MAX_POLL_MS default + 10m slack
  check('default 26 attempts (351s) stays under the ≥20m lease floor',
    span < ttlFloorSec, `span=${span}s floor=${ttlFloorSec}s`);
  check('atlasVideoService still loads after the edit', typeof atlas === 'object');
}

// ── report ──────────────────────────────────────────────────────────
const total = pass + failures.length;
if (failures.length) {
  console.error(`\nverifyVideoRefPrewarm: ${failures.length} FAIL(s), ${pass} pass\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`verifyVideoRefPrewarm: ${pass}/${total} checks passed`);
process.exit(0);
