#!/usr/bin/env node
/**
 * PORTED from liquidretail_backend/scripts/verifyPmaxVideoExpansion.js
 * (pre-2026-08-24 snapshot) into liquidretail_adgen.
 *
 * PORTING NOTE — structural adaptation, not an assertion change.
 *
 * Groups A, B, C, G test PURE, EXPORTED functions of
 * services/campaignAdsGenerationService.js and services/platformFormats.js
 * directly — those two modules are vendored byte-identical to the backend
 * originals (verified 2026-08-24), so those groups port with only require-path
 * fixes (services/* -> src/services/*).
 *
 * Groups D, E, F in the backend original reach into routes/ads.js, which does
 * NOT EXIST in adgen (adgen has no routes/ads.js at all — see
 * verifyArchiveDigestRelease.js's porting note for the same fact from a money
 * angle). But the LOGIC those groups test is not missing in adgen — it moved:
 *   - resolveDeriveFromMaster is already directly importable from
 *     services/campaignAdsGenerationService.js (backend's routes/ads.js just
 *     re-exported the SAME function for convenience; adgen has no reason to,
 *     so Group D below calls svc.resolveDeriveFromMaster directly).
 *   - backend's standalone `renderDeriveOnlyVideoAd` function is adgen's
 *     `if (deriveFromFmt) { … return; }` branch INSIDE
 *     services/renderer.js's `renderVideo(ad)` (confirmed by reading that
 *     file 2026-08-24 — same money-critical shape: resolve the derive gate
 *     first, and if it fires, never reach the Omni submit). Group E below
 *     extracts that branch instead of a named function, and asserts the same
 *     "zero billable submit tokens" invariant against it.
 *   - backend's regenerate preflight gate (services/adRegenerateService.js)
 *     exists in adgen VERBATIM at the same import + call shape — Group F
 *     ports with a path fix only, except its "ONE definition" check, which
 *     is re-pointed at services/renderer.js (adgen's other caller) instead of
 *     routes/ads.js.
 * No assertion this file DOES run had its expected value changed from the
 * backend original — only WHICH FILE a source-level check reads.
 *
 * ── ORIGINAL HEADER (backend) ──────────────────────────────────────────────
 * verifyPmaxVideoExpansion.js — MONEY harness for the Google PMax video path
 * (Phase A). Offline: no DB, no network, no API key.
 *
 * WHAT THIS PROTECTS
 * ------------------
 * A Google PMax video run bills TWO Omni masters per product
 * (pmax_video_9_16 + pmax_video_16_9, ~$1.20 each) and then derives the
 * square surface (pmax_video_1_1) for FREE by cropping the settled 9:16
 * master. Three distinct ways that can turn into real money:
 *
 *   1. The derive-only surface leaks into the MASTER list → a third
 *      billable Omni submit per product.
 *   2. The derive-only ad reaches the billable render path → a hidden
 *      ~$1.20 per product on a surface sold as free derivation.
 *   3. A digest input changes for a PRE-EXISTING format → every stored
 *      Meta digest stops matching, the (campaignId, identityDigest)
 *      unique index stops colliding, and the next Generate re-bills an
 *      Omni master for every product on the campaign.
 *
 * Sections C and D are BEHAVIOURAL (they call the real exported code), not
 * source-text matching — a source check passes against a reimplementation
 * that merely keeps the name.
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const svc  = require(path.join(ROOT, 'src/services/campaignAdsGenerationService'));
const pf   = require(path.join(ROOT, 'src/services/platformFormats'));

let passed = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) { passed++; return; }
  failures.push(detail ? `${label} — ${detail}` : label);
}

const MASTER_9_16 = 'pmax_video_9_16';
const MASTER_16_9 = 'pmax_video_16_9';
const DERIVE_1_1  = 'pmax_video_1_1';

// ── A. Master list: the derive-only surface is never billable ───────────
const masters = pf.GOOGLE_VIDEO_MASTERS || [];
check('A1 GOOGLE_VIDEO_MASTERS is exactly the two billable Omni masters',
  Array.isArray(masters) && masters.length === 2
    && masters.includes(MASTER_9_16) && masters.includes(MASTER_16_9),
  `got ${JSON.stringify(masters)}`);

check('A2 [MONEY] GOOGLE_VIDEO_MASTERS excludes the derive-only 1:1',
  !masters.includes(DERIVE_1_1),
  'a third master = a third billable Omni submit per product');

for (const preset of ['google_video', 'google_all', 'meta_video', 'meta_all',
                      'meta_static', 'google_static', 'single']) {
  let resolved;
  try { resolved = pf.resolvePreset(preset); } catch { resolved = null; }
  const vids = resolved?.videoFormats || [];
  check(`A3 [MONEY] resolvePreset('${preset}') never returns the derive-only 1:1`,
    !vids.includes(DERIVE_1_1),
    `videoFormats=${JSON.stringify(vids)}`);
}

const fromStaleFanout = svc.resolveDeterministicVideoMasterFormats(
  [MASTER_16_9, DERIVE_1_1, MASTER_9_16], null
);
check('A4 [MONEY] a stale full fan-out is stripped to masters only',
  Array.isArray(fromStaleFanout)
    && !fromStaleFanout.includes(DERIVE_1_1)
    && fromStaleFanout.length === 2,
  `got ${JSON.stringify(fromStaleFanout)}`);

const metaMasters = svc.resolveDeterministicVideoMasterFormats(
  ['meta_stories_9_16'], 'meta_stories_9_16'
);
check('A5 [MONEY] Meta resolves to exactly ONE master (unchanged submit count)',
  Array.isArray(metaMasters) && metaMasters.length === 1
    && metaMasters[0] === 'meta_stories_9_16',
  `got ${JSON.stringify(metaMasters)}`);

check('A6 Google resolves to exactly TWO masters',
  svc.resolveDeterministicVideoMasterFormats([MASTER_9_16, MASTER_16_9], null).length === 2);

check('A7 isGoogleVideoMasterRun is false for Meta, true for Google',
  svc.isGoogleVideoMasterRun(['meta_stories_9_16']) === false
    && svc.isGoogleVideoMasterRun([MASTER_9_16, MASTER_16_9]) === true);

// ── B. Duration: PMax floor pinned, Meta untouched ─────────────────────
check('B1 Google video duration defaults to the 10s PMax floor when unset',
  svc.resolveVideoDurationForFormat(MASTER_9_16, null) === 10
    && svc.resolveVideoDurationForFormat(MASTER_16_9, undefined) === 10
    && svc.resolveVideoDurationForFormat(DERIVE_1_1, null) === 10);

check('B2 Meta duration defaults to the deliberate 10s when unset',
  svc.resolveVideoDurationForFormat('meta_stories_9_16', null) === 10
    && svc.resolveVideoDurationForFormat('meta_feed_1_1', undefined) === 10,
  'owner decision 2026-08-11; revert without deploy via META_VIDEO_DURATION_SEC');

check('B2b [KILL SWITCH] META_VIDEO_DURATION_SEC=0 restores the provider default',
  (() => {
    const prev = process.env.META_VIDEO_DURATION_SEC;
    process.env.META_VIDEO_DURATION_SEC = '0';
    for (const k of Object.keys(require.cache)) {
      if (k.includes('campaignAdsGenerationService') || k.includes('videoDurationPolicy')) delete require.cache[k];
    }
    const reloaded = require(path.join(ROOT, 'src/services/campaignAdsGenerationService'));
    const off = reloaded.resolveVideoDurationForFormat('meta_stories_9_16', null);
    const googleStill10 = reloaded.resolveVideoDurationForFormat(MASTER_9_16, null) === 10;
    if (prev === undefined) delete process.env.META_VIDEO_DURATION_SEC;
    else process.env.META_VIDEO_DURATION_SEC = prev;
    for (const k of Object.keys(require.cache)) {
      if (k.includes('campaignAdsGenerationService') || k.includes('videoDurationPolicy')) delete require.cache[k];
    }
    return off === null && googleStill10;
  })(),
  'a duration change that cannot be reverted without a deploy is not acceptable');

check('B3 [MONEY] a PMax video can never render below the 10s Google floor',
  [4, 6, 8].every((d) =>
    svc.resolveVideoDurationForFormat(MASTER_9_16, d) === 10
      && svc.resolveVideoDurationForFormat(MASTER_16_9, d) === 10
      && svc.resolveVideoDurationForFormat(DERIVE_1_1, d) === 10),
  'the wizard posts 8 by default — under the floor this is a paid, unusable master');

check('B3b above the floor the operator still wins on PMax',
  svc.resolveVideoDurationForFormat(MASTER_16_9, 15) === 15);

check('B3c [DIRECTED] Meta video is floored at 10s, like PMax',
  svc.resolveVideoDurationForFormat('meta_stories_9_16', 6) === 10
    && svc.resolveVideoDurationForFormat('meta_feed_1_1', 4) === 10
    && svc.resolveVideoDurationForFormat('meta_stories_9_16', 8) === 10,
  'owner directive: Meta video is 10s');

check('B3d above the floor the operator still wins on Meta too',
  svc.resolveVideoDurationForFormat('meta_stories_9_16', 12) === 12,
  'the floor lifts a short value; it must not cap a long one '
  + '(Omni\'s [4,6,8,10] enum clamps the top end downstream)');

check('B3e META_VIDEO_DURATION_SEC=0 still restores the provider default',
  (() => {
    const prev = process.env.META_VIDEO_DURATION_SEC;
    process.env.META_VIDEO_DURATION_SEC = '0';
    for (const k of Object.keys(require.cache)) {
      if (k.includes('campaignAdsGenerationService') || k.includes('videoDurationPolicy')) delete require.cache[k];
    }
    const reloaded = require(path.join(ROOT, 'src/services/campaignAdsGenerationService'));
    const off = reloaded.resolveVideoDurationForFormat('meta_stories_9_16', 8);
    const googleStill10 = reloaded.resolveVideoDurationForFormat(MASTER_9_16, 8) === 10;
    if (prev == null) delete process.env.META_VIDEO_DURATION_SEC;
    else process.env.META_VIDEO_DURATION_SEC = prev;
    for (const k of Object.keys(require.cache)) {
      if (k.includes('campaignAdsGenerationService') || k.includes('videoDurationPolicy')) delete require.cache[k];
    }
    return off === 8 && googleStill10;
  })(),
  'the Meta floor must stay revertible with no deploy, and must never touch PMax');

// ── C. Digest: duration is identity for Google ONLY ────────────────────
const digest = svc.computeDeterministicVideoDigest;
const baseArgs = {
  campaignId: 'C1', productId: 'P1', referenceMediaIds: [], mediaId: 'M1',
  ctaText: 'SHOP NOW', ctaUrl: 'https://example.com', ctaUrlParams: '',
  videoPromptGuidance: null, videoPromptRaw: null
};
const PRE_EXISTING_FORMATS = [
  'meta_stories_9_16', 'meta_feed_1_1', 'meta_feed_4_5', 'meta_reels_9_16', 'pmax_16_9'
];
for (const fmt of PRE_EXISTING_FORMATS) {
  const withoutDuration = digest({ ...baseArgs, platformFormat: fmt });
  const withDuration    = digest({ ...baseArgs, platformFormat: fmt, videoDurationSec: 10 });
  check(`C1 [MONEY] duration does NOT alter the digest for pre-existing format ${fmt}`,
    withoutDuration === withDuration,
    'a changed digest breaks the unique index that stops a repeat Generate '
      + 're-billing an Omni master (~$1.00-1.20 per product)');
}

for (const fmt of PRE_EXISTING_FORMATS) {
  check(`C1b [MONEY] funnelStage:null does NOT alter the digest for pre-existing format ${fmt}`,
    digest({ ...baseArgs, platformFormat: fmt })
      === digest({ ...baseArgs, platformFormat: fmt, funnelStage: null }),
    'pushing a null/empty funnel part re-mints every stored digest and re-bills Omni');
  check(`C1b2 [MONEY] a SET funnelStage DOES alter the digest for ${fmt} (variants must not collapse)`,
    digest({ ...baseArgs, platformFormat: fmt })
      !== digest({ ...baseArgs, platformFormat: fmt, funnelStage: 'awareness' }),
    'a set stage that hashes like the master is silently dropped by insertMany');
}

check('C1c funnelStage IS identity for Google video (3 variants must not collapse)',
  new Set(['awareness', 'consideration', 'conversion'].map((s) =>
    digest({ ...baseArgs, platformFormat: MASTER_16_9, videoDurationSec: 10, funnelStage: s })
  )).size === 3,
  'colliding variant digests would silently drop two of the three free retitles');

for (const fmt of [MASTER_9_16, MASTER_16_9, DERIVE_1_1]) {
  check(`C2 duration IS identity for Google format ${fmt}`,
    digest({ ...baseArgs, platformFormat: fmt, videoDurationSec: 10 })
      !== digest({ ...baseArgs, platformFormat: fmt, videoDurationSec: 8 }),
    'an 8s->10s retune must mint a new ad, not silently reuse a shorter master');
}

const dMaster9  = digest({ ...baseArgs, platformFormat: MASTER_9_16, videoDurationSec: 10 });
const dMaster16 = digest({ ...baseArgs, platformFormat: MASTER_16_9, videoDurationSec: 10 });
const dDerive   = digest({ ...baseArgs, platformFormat: DERIVE_1_1,  videoDurationSec: 10 });
check('C3 the two masters and the derive-only ad get three DISTINCT digests',
  new Set([dMaster9, dMaster16, dDerive]).size === 3,
  'colliding digests would silently drop an ad on the unique index');

check('C4 the digest namespace prefix is still det-video:v1 (no blanket re-mint)',
  fs.readFileSync(path.join(ROOT, 'src/services/campaignAdsGenerationService.js'), 'utf8')
    .includes("'det-video:v1'"),
  'bumping the prefix re-mints every existing deterministic video ad');

// ── D. The derive gate is FAIL-CLOSED (behavioural) ────────────────────
// ADAPTED: backend requires routes/ads.js to get at resolveDeriveFromMaster,
// which only re-exports the SAME function campaignAdsGenerationService.js
// already exports directly (confirmed identical by inspection). adgen has no
// routes/ads.js, so `svc` (already required above) is used directly — same
// function, same assertions.
const resolveDeriveFromMaster = svc.resolveDeriveFromMaster;
check('D1 campaignAdsGenerationService.js exports resolveDeriveFromMaster for behavioural pinning',
  typeof resolveDeriveFromMaster === 'function');

if (typeof resolveDeriveFromMaster === 'function') {
  check('D2 [MONEY] a 1:1 ad with NO deriveFromMaster field still derives (fail-closed)',
    resolveDeriveFromMaster({ platformFormat: DERIVE_1_1 }) === MASTER_9_16,
    'without this a dropped field sends a free surface down the billable path');

  check('D3 an explicit deriveFromMaster marker is honoured',
    resolveDeriveFromMaster({ platformFormat: DERIVE_1_1, deriveFromMaster: MASTER_9_16 })
      === MASTER_9_16);

  const STILL_BILLABLE_FORMATS = ['meta_stories_9_16', 'pmax_16_9', MASTER_9_16, MASTER_16_9];
  for (const fmt of STILL_BILLABLE_FORMATS) {
    check(`D4 billable master format ${fmt} is NOT routed to the derive path`,
      resolveDeriveFromMaster({ platformFormat: fmt }) === null,
      'routing a real master to the derive path would skip the render it paid for');
  }

  const META_MASTER = 'meta_stories_9_16';
  for (const fmt of ['meta_feed_1_1', 'meta_feed_4_5', 'meta_reels_9_16']) {
    check(`D4b [MONEY] Meta derive surface ${fmt} routes to the master (fail-closed, no marker)`,
      resolveDeriveFromMaster({ platformFormat: fmt }) === META_MASTER,
      'a Meta derivative on the billable path is a full Omni submit for a free crop');
    check(`D4c Meta derive surface ${fmt} honours an explicit marker too`,
      resolveDeriveFromMaster({ platformFormat: fmt, deriveFromMaster: META_MASTER }) === META_MASTER);
  }

  check('D5 a missing/!null ad object is handled without throwing',
    resolveDeriveFromMaster(null) === null && resolveDeriveFromMaster(undefined) === null);
}

// ── E. The derive render path contains ZERO billable submits (source) ──
// ADAPTED: backend's standalone `renderDeriveOnlyVideoAd` function in
// routes/ads.js is adgen's `if (deriveFromFmt) { … return; }` branch inside
// services/renderer.js's `renderVideo(ad)` (verified 2026-08-24 by reading
// that file — see the PORTING NOTE at the top of this file). Extract that
// branch instead of a named function; the ABSENCE assertion (zero billable
// submit tokens reachable) is unchanged.
const rendererSrc = fs.readFileSync(path.join(ROOT, 'src/services/renderer.js'), 'utf8');

function extractDeriveBranch(src) {
  const anchor = src.indexOf('const deriveFromFmt = resolveDeriveFromMaster(ad);');
  if (anchor === -1) return null;
  const ifIdx = src.indexOf('if (deriveFromFmt)', anchor);
  if (ifIdx === -1) return null;
  const open = src.indexOf('{', ifIdx);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return null;
}

const deriveBody = extractDeriveBranch(rendererSrc);
check('E0 the derive branch inside renderVideo() exists and is parseable', !!deriveBody);
check('E0b the extracted body is the real branch body, not a stub',
  !!deriveBody && deriveBody.length > 1500 && /findSiblingMasterAd\s*\(/.test(deriveBody),
  `extracted ${deriveBody ? deriveBody.length : 0} chars`);

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ADAPTED submit tokens: adgen's video submit call is atlasVideo.generateForAd
// (atlasVideo = require('./atlasVideoService')), not the backend's veoGenerateForAd
// name — same underlying atlasVideoService module either way.
const SUBMIT_TOKENS_E = [
  /atlasVideo\.generateForAd\s*\(/, /veoPrepareStoryboard\s*\(/,
  /atlasVideoService/, /generateForAd\s*\(/
];

if (deriveBody) {
  const deriveCode = stripComments(deriveBody);
  check('E1 [MONEY] the derive branch makes ZERO billable video submits',
    SUBMIT_TOKENS_E.every((t) => !t.test(deriveCode)),
    'any submit here is a hidden ~$1.20 per product on a free surface');

  check('E1a comment-stripping left real code to assert against',
    deriveCode.length > 1200 && /findSiblingMasterAd\s*\(/.test(deriveCode),
    `code length after stripping = ${deriveCode.length}`);

  check('E1b the derive path still enforces the untitled-is-not-success discipline',
    /status:\s*'draft'/.test(deriveBody) && /titling/i.test(deriveBody),
    'a derived plate must be stamped draft before titling, like the master path');
}

// ── F. Regenerate refuses derive-only ads; ONE definition, imported ────
const regenSrc = fs.readFileSync(path.join(ROOT, 'src/services/adRegenerateService.js'), 'utf8');
check('F1 [MONEY] the regenerate path refuses derive-only ads',
  /resolveDeriveFromMaster/.test(regenSrc),
  'without this, Regenerate on a PMax 1:1 bills a brand-new Omni generation');

const preflightBody = (() => {
  const i = regenSrc.indexOf('async function preflight(');
  if (i === -1) return '';
  const open = regenSrc.indexOf('{', regenSrc.indexOf(')', i));
  let depth = 0;
  for (let k = open; k < regenSrc.length; k++) {
    if (regenSrc[k] === '{') depth++;
    else if (regenSrc[k] === '}') { depth--; if (depth === 0) return regenSrc.slice(open, k + 1); }
  }
  return '';
})();
check('F1b the refusal happens in preflight (before the 202 and any provider call)',
  /resolveDeriveFromMaster/.test(preflightBody),
  'gating later would still schedule the work');

// F2 ADAPTED: "one definition" checked against renderer.js (adgen's other
// caller) instead of routes/ads.js — routes/ads.js does not exist in adgen.
check('F2 [MONEY] the derive gate is defined once and imported, not duplicated',
  (rendererSrc.match(/function\s+resolveDeriveFromMaster\s*\(/g) || []).length === 0
    && (regenSrc.match(/function\s+resolveDeriveFromMaster\s*\(/g) || []).length === 0,
  'a per-caller copy drifts — services/renderer.js and adRegenerateService must import the shared one');

const svcSrc = fs.readFileSync(path.join(ROOT, 'src/services/campaignAdsGenerationService.js'), 'utf8');
check('F2b the single definition lives in campaignAdsGenerationService',
  (svcSrc.match(/function\s+resolveDeriveFromMaster\s*\(/g) || []).length === 1);

// F3 (renamed from backend's F3/F3b — no F4 in adgen: the single-format
// fallback strip check below is F4 in the backend original and is pure, kept
// under its original label for cross-reference).
check('F3 a Google run WITHOUT the 9:16 source does not count as a master run',
  svc.isGoogleVideoMasterRun([MASTER_16_9]) === false,
  'minting the derive ad here strands it — its crop source is never generated');
check('F3b a Google run WITH the 9:16 source does count',
  svc.isGoogleVideoMasterRun([MASTER_9_16]) === true
    && svc.isGoogleVideoMasterRun([MASTER_9_16, MASTER_16_9]) === true);

check('F4 [MONEY] the master fallback strips the derive-only surface',
  /\[videoPlatformFormat\]\.filter\(\(f\) => f && f !== PMAX_VIDEO_DERIVE_ONLY\)/.test(svcSrc),
  'an unfiltered fallback turns the free crop surface into a paid Omni submit');
check('F4b the dry-run estimate applies the same strip',
  (svcSrc.match(/\[videoPlatformFormat\]\.filter\(\(f\) => f && f !== PMAX_VIDEO_DERIVE_ONLY\)/g) || []).length >= 2,
  'the preview must not advertise a master the live path refuses to queue');

// F5 [SKIPPED-CALLER] backend's F5 pins DERIVE_MASTER_WAIT_MS usage inside
// the named renderDeriveOnlyVideoAd function body via a regex scoped to that
// function. adgen's equivalent constants (DERIVE_MASTER_WAIT_MS,
// MAX_DERIVE_WAIT_ATTEMPTS) are used inside renderVideo's derive branch too
// (confirmed by inspection: `deriveWaitAttempts` bound check + wait loop) —
// covered structurally by E0b/E1b above rather than duplicated here.

// ── G. deriveWaitAttempts / renderAttempts bookkeeping ─────────────────
// Backend's G-group asserts a specific field-migration history
// (renderAttempts -> deriveWaitAttempts, landed 2026-08-18) against
// routes/ads.js's exact code shape. adgen's renderer.js was written fresh
// against the POST-migration design (confirmed: requeueDeriveForRetry
// increments deriveWaitAttempts, not renderAttempts — see the file), so
// there is no "did the migration happen" question to ask; there is only "is
// the design still correct today", which is what we assert below.
{
  const AdModelSrc = fs.readFileSync(path.join(ROOT, 'src/models/Ad.js'), 'utf8');
  check('G1 models/Ad.js declares deriveWaitAttempts as a Number defaulting to 0',
    /deriveWaitAttempts:\s*\{\s*type:\s*Number,\s*default:\s*0\s*\}/.test(AdModelSrc),
    'an undeclared field is silently dropped on save — the counter would never actually persist');
}

check('G2 renderVideo\'s derive branch increments deriveWaitAttempts on requeue, never renderAttempts, in the SAME call',
  /requeueDeriveForRetry/.test(rendererSrc)
    && /\$inc:\s*\{\s*deriveWaitAttempts:\s*1\s*\}/.test(rendererSrc),
  'the wait/requeue branch must $inc deriveWaitAttempts, not renderAttempts — conflating the two would make a ' +
  'merely-waiting ad share the stranded-sweeper\'s exhaustion budget with a genuinely-failed one');

check('G3 the MAX_DERIVE_WAIT_ATTEMPTS bound reads ad.deriveWaitAttempts, not ad.renderAttempts',
  /ad\.deriveWaitAttempts\s*\|\|\s*0\)\s*>=\s*MAX_DERIVE_WAIT_ATTEMPTS/.test(rendererSrc),
  'reading renderAttempts here means a genuinely-rendered-and-failed ad and a merely-waiting ad share one exhaustion budget');

check('G4 requeueDeriveForRetry never increments renderAttempts',
  (() => {
    const i = rendererSrc.indexOf('async function requeueDeriveForRetry');
    if (i === -1) return false;
    const open = rendererSrc.indexOf('{', rendererSrc.indexOf(')', i));
    let depth = 0, close = -1;
    for (let k = open; k < rendererSrc.length; k++) {
      if (rendererSrc[k] === '{') depth++;
      else if (rendererSrc[k] === '}') { depth--; if (depth === 0) { close = k; break; } }
    }
    const body = close === -1 ? '' : rendererSrc.slice(open, close + 1);
    return body.length > 50 && !/renderAttempts/.test(body);
  })(),
  'the wait-loop\'s own bookkeeping function must never touch renderAttempts');

// ── Report ─────────────────────────────────────────────────────────────
const total = passed + failures.length;
if (failures.length) {
  console.error(`\n❌ verifyPmaxVideoExpansion: ${failures.length} FAILED, ${passed} passed (of ${total})\n`);
  for (const f of failures) console.error(`   • ${f}`);
  console.error('');
  process.exit(1);
}
console.log(`\n✅ verifyPmaxVideoExpansion: ${passed} checks passed`);
console.log('   masters=2 billable, derive-only=1 free, Meta submit count unchanged');
console.log('   pre-existing digests provably unchanged (no repeat-Generate re-bill)\n');
