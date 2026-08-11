#!/usr/bin/env node
/**
 * verifyPmaxTemplateAspect.js — PMax Landscape (1.91:1) must be buildable by
 * every AI template, and 1.91:1 must never leak into the legacy cartesian.
 * Offline: no DB, no network, no API key.
 *
 * WHAT THIS PROTECTS
 * ------------------
 * Two failures, one on each side of the same list.
 *
 *   1. TOO NARROW (the bug this harness was written for). Phase A flipped
 *      pmax_landscape_1_91_1 live, but every AI template still declared
 *      aspect_ratios.supported = ['1:1','4:5','9:16','16:9']. layoutInputService
 *      hard-throws `Template <t> does not support aspect ratio <r>` on any
 *      ratio outside that list, so EVERY PMax Landscape static failed at
 *      layout-input time — observed live on run_1786441791780_90a94f08,
 *      where 3 of 4 concepts died and only the 1:1 survivors delivered.
 *      1.91:1 is a REQUIRED Google asset size; without it the surface is
 *      dead on arrival.
 *
 *   2. TOO WIDE (money). SHIPPING_RATIOS is derived from *live* formats, so
 *      flipping the PMax surfaces live added '1.91:1' and '16:9' to it. The
 *      legacy cartesian in expandWizardJob is
 *          seeds x templates x (supported ∩ SHIPPING_RATIOS ∩ platformAspect)
 *      and it is the path brand campaigns take (no productIds => never reach
 *      the concept-driven path). The ONLY thing keeping that grid at one
 *      ratio per template is that platformAspect is never null — it falls
 *      back to 'meta_feed_1_1'. If that default stopped resolving to a live
 *      format with an aspectRatio, the filter would no-op and every AI
 *      template would queue extra billable statics per seed at ratios nobody
 *      asked for. So this harness pins the fallback itself, not just the list.
 *
 * REVERT-PROOF RECIPE (each must fail this harness — run after mutating):
 *   a) Drop '1.91:1' from any AI template's aspect_ratios.supported  -> A fails
 *   b) Flip pmax_landscape_1_91_1 back to status 'coming_soon'       -> B fails
 *   c) Flip meta_feed_1_1 to 'coming_soon' (kills the default)       -> C fails
 *   d) Delete aspectRatio from any live format entry                 -> C fails
 */

const path      = require('path');
const templates = require(path.join(__dirname, '..', 'services', 'templateRegistry'));
const aiReg     = require(path.join(__dirname, '..', 'services', 'aiTemplateRegistry'));
const {
  PLATFORM_FORMATS,
  LIVE_PLATFORM_FORMAT_KEYS,
  aspectRatioForPlatformFormat
} = require(path.join(__dirname, '..', 'services', 'platformFormats'));

const failures = [];
let passed = 0;
function check(label, cond, detail = '') {
  if (cond) { passed++; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

// The ratio Google requires for PMax Landscape, and the format that carries it.
const PMAX_LANDSCAPE = 'pmax_landscape_1_91_1';
const LANDSCAPE_RATIO = '1.91:1';

// ── A. Every AI template can build a 1.91:1 layout input ──────────────
//
// getSupportedAspectRatios is the EXACT function layoutInputService gates
// on (services/layoutInputService.js: `if (!supportedRatios.includes(...))
// throw badRequest(...)`), so calling it here reproduces the real gate
// rather than re-reading the literal out of the registry object.
const aiIds = Object.keys(aiReg.AI_TEMPLATES);
check('A0 AI templates exist', aiIds.length >= 5, `found ${aiIds.length}`);

for (const id of aiIds) {
  const supported = templates.getSupportedAspectRatios(id);
  check(`A ${id} supports ${LANDSCAPE_RATIO}`,
    Array.isArray(supported) && supported.includes(LANDSCAPE_RATIO),
    `supported=${JSON.stringify(supported)}`);

  // The Meta ratios must survive the widening — this list is shared with
  // every Meta surface, so a careless rewrite here silently kills Meta.
  for (const keep of ['1:1', '4:5', '9:16']) {
    check(`A ${id} still supports ${keep}`,
      Array.isArray(supported) && supported.includes(keep),
      `supported=${JSON.stringify(supported)}`);
  }
}

// ── B. The surface that needs it is actually live and carries that ratio ──
const landscape = PLATFORM_FORMATS[PMAX_LANDSCAPE];
check('B0 pmax_landscape_1_91_1 exists', !!landscape);
check('B1 pmax_landscape_1_91_1 is live', landscape?.status === 'live',
  `status=${landscape?.status}`);
check('B2 pmax_landscape_1_91_1 aspectRatio', landscape?.aspectRatio === LANDSCAPE_RATIO,
  `aspectRatio=${landscape?.aspectRatio}`);
check('B3 aspectRatioForPlatformFormat resolves it',
  aspectRatioForPlatformFormat(PMAX_LANDSCAPE) === LANDSCAPE_RATIO);

// ── C. The cartesian narrowing can never no-op (money) ────────────────
//
// platformAspect = aspectRatioForPlatformFormat(runPlatformFormat) || null,
// and runPlatformFormat bottoms out at 'meta_feed_1_1'. Both halves of that
// fallback have to hold or the ratio filter stops narrowing.
const DEFAULT_FORMAT = 'meta_feed_1_1';
check('C0 default format is live',
  LIVE_PLATFORM_FORMAT_KEYS.includes(DEFAULT_FORMAT),
  `LIVE=${JSON.stringify(LIVE_PLATFORM_FORMAT_KEYS)}`);
check('C1 default format yields a non-null aspect',
  !!aspectRatioForPlatformFormat(DEFAULT_FORMAT));

for (const key of LIVE_PLATFORM_FORMAT_KEYS) {
  check(`C every live format has an aspect (${key})`,
    !!aspectRatioForPlatformFormat(key),
    `got ${aspectRatioForPlatformFormat(key)}`);
}

// ── D. With the filter in force, each run mints ONE ratio per template ──
//
// Reproduces the grid line from expandWizardJob:
//   ratios = supported ∩ SHIPPING_RATIOS, then ∩ platformAspect.
// The assertion is that 1.91:1 reaches the grid ONLY on the PMax Landscape
// run — i.e. widening the template list did not widen anybody else's fan-out.
const SHIPPING_RATIOS = new Set(
  Object.values(PLATFORM_FORMATS)
    .filter(f => f.status === 'live')
    .map(f => f.aspectRatio)
    .filter(Boolean)
);
check('D0 1.91:1 is a shipping ratio', SHIPPING_RATIOS.has(LANDSCAPE_RATIO));

for (const key of LIVE_PLATFORM_FORMAT_KEYS) {
  const platformAspect = aspectRatioForPlatformFormat(key) || null;
  for (const id of aiIds) {
    const ratios = (templates.getSupportedAspectRatios(id) || [])
      .filter(r => SHIPPING_RATIOS.has(r))
      .filter(r => (platformAspect ? r === platformAspect : true));

    check(`D ${key}/${id} mints at most one ratio`, ratios.length <= 1,
      `ratios=${JSON.stringify(ratios)}`);

    const landscapeLeaked = ratios.includes(LANDSCAPE_RATIO) && platformAspect !== LANDSCAPE_RATIO;
    check(`D ${key}/${id} no 1.91:1 leak`, !landscapeLeaked,
      `platformAspect=${platformAspect} ratios=${JSON.stringify(ratios)}`);
  }
}

const total = passed + failures.length;
if (failures.length) {
  console.error(`\n❌ verifyPmaxTemplateAspect: ${failures.length} FAILED, ${passed} passed (of ${total})\n`);
  failures.forEach(f => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log(`\n✅ verifyPmaxTemplateAspect: ${passed} checks passed`);
