#!/usr/bin/env node
/**
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
 *      Omni master for every product on the campaign. That index is the
 *      ONLY guard there (computeDeterministicVideoDigest deliberately
 *      omits generationRunId — CLAUDE.md §2 "the index protects video").
 *
 * Sections C and D are BEHAVIOURAL (they call the real exported code), not
 * source-text matching — a source check passes against a reimplementation
 * that merely keeps the name.
 *
 * REVERT-PROOF RECIPE (each must fail this harness):
 *   1. Add 'pmax_video_1_1' to GOOGLE_VIDEO_MASTERS            → A2/A4
 *   2. Drop the derive-only strip in resolveDeterministicVideoMasterFormats → A4
 *   3. Make resolveVideoDurationForFormat return 10 for Meta    → B2
 *   4. Append the duration part unconditionally in
 *      computeDeterministicVideoDigest (i.e. not gated on the Google
 *      formats)                                                 → C1
 *   5. Make resolveDeriveFromMaster ignore platformFormat and read only
 *      the (droppable) deriveFromMaster field                   → D2
 *
 * REMOVED (dormant render fallback deletion): recipe items 6/7 used to
 * mutate `renderDeriveOnlyVideoAd` (add a veoGenerateForAd call → E1;
 * move the derive gate below the master submit → E2). That function and
 * the in-process render loop are gone. MONEY invariant "a derive-only ad
 * must never reach a billable Omni submit" is still enforced by
 * `resolveDeriveFromMaster` (campaignAdsGenerationService.js) at
 * mint/preflight time — still pinned in this file's D-group and F1/F2
 * regenerate preflight. Adgen's renderer owns actual derive rendering.
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const svc  = require(path.join(ROOT, 'services/campaignAdsGenerationService'));
const pf   = require(path.join(ROOT, 'services/platformFormats'));

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

// The stale-fanout guard: even if a caller hands us the full Google video
// fan-out (which still contains the 1:1), the master resolver must strip it.
const fromStaleFanout = svc.resolveDeterministicVideoMasterFormats(
  [MASTER_16_9, DERIVE_1_1, MASTER_9_16], null
);
check('A4 [MONEY] a stale full fan-out is stripped to masters only',
  Array.isArray(fromStaleFanout)
    && !fromStaleFanout.includes(DERIVE_1_1)
    && fromStaleFanout.length === 2,
  `got ${JSON.stringify(fromStaleFanout)}`);

// META EQUIVALENCE — the whole reason iterating masters is safe to ship.
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

// B2 previously pinned "Meta duration stays null when unset". That was the
// correct invariant while a Meta duration change would have been UNINTENDED.
// It is now a deliberate owner decision (2026-08-11): Meta standardises on 10s.
// Re-pinned to the new intent — and the guard that actually protects money is
// kept and strengthened below in C1: duration must still not enter the Meta
// identity digest, so this is a render-length change, NOT a re-mint of the
// existing library.
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
    const reloaded = require(path.join(ROOT, 'services/campaignAdsGenerationService'));
    const off = reloaded.resolveVideoDurationForFormat('meta_stories_9_16', null);
    // Google must be unaffected by the Meta switch — its floor is a Google spec.
    const googleStill10 = reloaded.resolveVideoDurationForFormat(MASTER_9_16, null) === 10;
    if (prev === undefined) delete process.env.META_VIDEO_DURATION_SEC;
    else process.env.META_VIDEO_DURATION_SEC = prev;
    for (const k of Object.keys(require.cache)) {
      if (k.includes('campaignAdsGenerationService') || k.includes('videoDurationPolicy')) delete require.cache[k];
    }
    return off === null && googleStill10;
  })(),
  'a duration change that cannot be reverted without a deploy is not acceptable');

// B3 previously asserted "an explicit operator duration ALWAYS wins". That was
// wrong for PMax and shipped a real defect: the wizard's Video Length control
// has no "auto" option and posts 8 on every run, so every PMax video generated
// through the UI would have been born at 8s — under Google's 10s minimum, i.e.
// a $0.90 render that cannot be used as an asset. 10s is a platform FLOOR.
check('B3 [MONEY] a PMax video can never render below the 10s Google floor',
  [4, 6, 8].every((d) =>
    svc.resolveVideoDurationForFormat(MASTER_9_16, d) === 10
      && svc.resolveVideoDurationForFormat(MASTER_16_9, d) === 10
      && svc.resolveVideoDurationForFormat(DERIVE_1_1, d) === 10),
  'the wizard posts 8 by default — under the floor this is a paid, unusable master');

check('B3b above the floor the operator still wins on PMax',
  svc.resolveVideoDurationForFormat(MASTER_16_9, 15) === 15);

// B3c WAS "Meta keeps the operator value exactly (no floor applies)".
// INVERTED BY OWNER DIRECTIVE 2026-08-18, verbatim: "make meta videos 10 sec
// also, we already discussed this." This is a DIRECTED change, not drift —
// do not restore the old assertion without a new directive.
//
// Why it mattered: the 10s Meta default (owner, 2026-08-11) only applied when
// duration was UNSET, and the wizard's Video Length control has no "auto" and
// posts 8 on every run. So the documented "Meta is 10s" was false on literally
// every UI run. Meta is now a FLOOR, the same shape as PMax above.
// It is also what makes the shared portrait plate a legal PMax asset — see
// resolvePortraitMasterFormat and scripts/verifySharedPortraitMaster.js.
check('B3c [DIRECTED] Meta video is floored at 10s, like PMax',
  svc.resolveVideoDurationForFormat('meta_stories_9_16', 6) === 10
    && svc.resolveVideoDurationForFormat('meta_feed_1_1', 4) === 10
    && svc.resolveVideoDurationForFormat('meta_stories_9_16', 8) === 10,
  'owner directive: Meta video is 10s');

check('B3d above the floor the operator still wins on Meta too',
  svc.resolveVideoDurationForFormat('meta_stories_9_16', 12) === 12,
  'the floor lifts a short value; it must not cap a long one '
  + '(Omni\'s [4,6,8,10] enum clamps the top end downstream)');

// The floor is REVERSIBLE without a deploy, and that lever is load-bearing
// for the shared portrait plate — see F-group in verifySharedPortraitMaster:
// with the floor off, sharing must refuse rather than ship an 8s PMax asset.
check('B3e META_VIDEO_DURATION_SEC=0 still restores the provider default',
  (() => {
    const prev = process.env.META_VIDEO_DURATION_SEC;
    process.env.META_VIDEO_DURATION_SEC = '0';
    for (const k of Object.keys(require.cache)) {
      if (k.includes('campaignAdsGenerationService') || k.includes('videoDurationPolicy')) delete require.cache[k];
    }
    const reloaded = require(path.join(ROOT, 'services/campaignAdsGenerationService'));
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
// C1 is the pin for the regression found (and fixed) during Phase A: an
// unconditional duration part changed EVERY stored Meta digest.
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

// C1b: the money guard is NULL-ONLY, not format-scoped. Pre-existing
// Meta/legacy rows store funnelStage=null, so appending the part only
// when set cannot change a stored master digest. A set stage MUST
// change the hash — that is how Meta/PMax intent variants stop
// collapsing onto the master on the unique index.
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
  fs.readFileSync(path.join(ROOT, 'services/campaignAdsGenerationService.js'), 'utf8')
    .includes("'det-video:v1'"),
  'bumping the prefix re-mints every existing deterministic video ad');

// ── D. The derive gate is FAIL-CLOSED (behavioural) ────────────────────
const adsRoute = require(path.join(ROOT, 'routes/ads.js'));
const resolveDeriveFromMaster = adsRoute.resolveDeriveFromMaster;
check('D1 routes/ads.js exports resolveDeriveFromMaster for behavioural pinning',
  typeof resolveDeriveFromMaster === 'function');

if (typeof resolveDeriveFromMaster === 'function') {
  // The marker field can be dropped (schema drift, legacy row). The gate
  // must STILL route the 1:1 to the free derive path on platformFormat alone.
  check('D2 [MONEY] a 1:1 ad with NO deriveFromMaster field still derives (fail-closed)',
    resolveDeriveFromMaster({ platformFormat: DERIVE_1_1 }) === MASTER_9_16,
    'without this a dropped field sends a free surface down the billable path');

  check('D3 an explicit deriveFromMaster marker is honoured',
    resolveDeriveFromMaster({ platformFormat: DERIVE_1_1, deriveFromMaster: MASTER_9_16 })
      === MASTER_9_16);

  // ⚠️ PRE_EXISTING_FORMATS is NOT the billable list any more — it is the
  // DIGEST-SCOPING list (C1/C1b), and the two diverged when the Meta
  // derivations were restored. meta_feed_1_1 / meta_feed_4_5 /
  // meta_reels_9_16 are now produced by cropping or retitling the Stories
  // master, so they MUST route to the derive path; they still belong in
  // PRE_EXISTING_FORMATS because their digests must stay unaffected by
  // duration and by funnelStage:null. A SET stage is identity (C1b2).
  // Conflating the two lists is what made this check fail, and it would
  // have been the wrong fix to widen the gate instead.
  const STILL_BILLABLE_FORMATS = ['meta_stories_9_16', 'pmax_16_9', MASTER_9_16, MASTER_16_9];
  for (const fmt of STILL_BILLABLE_FORMATS) {
    check(`D4 billable master format ${fmt} is NOT routed to the derive path`,
      resolveDeriveFromMaster({ platformFormat: fmt }) === null,
      'routing a real master to the derive path would skip the render it paid for');
  }

  // D4b — the inverse, and the point of the Meta restoration: every Meta
  // derive surface routes to the master on platformFormat ALONE (marker
  // dropped), exactly like the PMax square in D2. Without this the row takes
  // the billable Omni path and re-creates the 3-paid-masters waste that
  // commit 919627a0 removed.
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

// ── E. REMOVED (dormant render fallback deletion) ────────────────────
// E0/E0b/E1/E1a/E1b/E2/E3 used to extract `renderDeriveOnlyVideoAd` from
// routes/ads.js and assert ZERO billable submits + the derive gate sitting
// BEFORE the Omni submit in the in-process render loop. That function and
// the loop are gone. MONEY invariant "a derive-only ad must never reach a
// billable Omni submit" is still enforced by resolveDeriveFromMaster
// (campaignAdsGenerationService.js) at mint/preflight time — still pinned
// in this file's D-group and F1/F2 regenerate preflight. Adgen's renderer
// owns actual derive rendering now. The render-loop gate is gone because
// the loop is gone.
const adsSrc = fs.readFileSync(path.join(ROOT, 'routes/ads.js'), 'utf8');
check('E-abs [ABSENCE] routes/ads.js no longer defines renderDeriveOnlyVideoAd',
  !/async function renderDeriveOnlyVideoAd\s*\(/.test(adsSrc),
  'the in-process derive renderer came back — restore the E-group money pins');
check('E-abs2 [ABSENCE] routes/ads.js no longer defines findSiblingMasterAd',
  !/async function findSiblingMasterAd\s*\(/.test(adsSrc),
  'the in-process sibling lookup came back — that lookup moved to adgen');

// ── F. Holes found by adversarial review — pinned so they cannot reopen ─
// Every check here corresponds to a defect that was CONFIRMED against the
// real code during Phase A review, not a hypothetical.

// F1: regenerate reached veoService.generateForAd for a derive-only ad,
// billing a fresh video ($1.20–$5.00 a press, up to DAILY_CAP a day) on
// the surface sold as free derivation.
const regenSrc = fs.readFileSync(path.join(ROOT, 'services/adRegenerateService.js'), 'utf8');
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

// F2: ONE definition of the gate. Two copies is exactly how F1 opened.
check('F2 [MONEY] the derive gate is defined once and imported, not duplicated',
  (adsSrc.match(/function\s+resolveDeriveFromMaster\s*\(/g) || []).length === 0
    && (regenSrc.match(/function\s+resolveDeriveFromMaster\s*\(/g) || []).length === 0,
  'a per-caller copy drifts — routes/ads.js and adRegenerateService must import the shared one');

const svcSrc = fs.readFileSync(path.join(ROOT, 'services/campaignAdsGenerationService.js'), 'utf8');
check('F2b the single definition lives in campaignAdsGenerationService',
  (svcSrc.match(/function\s+resolveDeriveFromMaster\s*\(/g) || []).length === 1);

// F3: minting the derive ad on a run that never generates its 9:16 source
// produced an ad that can only wait and fail (legacy `single` preset with
// platformFormat pmax_video_16_9 resolves to a one-master Google run).
check('F3 a Google run WITHOUT the 9:16 source does not count as a master run',
  svc.isGoogleVideoMasterRun([MASTER_16_9]) === false,
  'minting the derive ad here strands it — its crop source is never generated');
check('F3b a Google run WITH the 9:16 source does count',
  svc.isGoogleVideoMasterRun([MASTER_9_16]) === true
    && svc.isGoogleVideoMasterRun([MASTER_9_16, MASTER_16_9]) === true);

// F4: the single-format fallback could put the derive-only surface back in
// as a BILLABLE master (`single` + platformFormat pmax_video_1_1).
check('F4 [MONEY] the master fallback strips the derive-only surface',
  /\[videoPlatformFormat\]\.filter\(\(f\) => f && f !== PMAX_VIDEO_DERIVE_ONLY\)/.test(svcSrc),
  'an unfiltered fallback turns the free crop surface into a paid Omni submit');
check('F4b the dry-run estimate applies the same strip',
  (svcSrc.match(/\[videoPlatformFormat\]\.filter\(\(f\) => f && f !== PMAX_VIDEO_DERIVE_ONLY\)/g) || []).length >= 2,
  'the preview must not advertise a master the live path refuses to queue');

// F5 used to pin DERIVE_MASTER_WAIT_MS / findSiblingMasterAd inside
// renderDeriveOnlyVideoAd. Both the wait loop and the sibling lookup were
// deleted with the in-process render loop; adgen owns derive rendering
// (and waiting for the master) now.
check('F5 [ABSENCE] routes/ads.js no longer waits in-process for a derive master',
  !/async function renderDeriveOnlyVideoAd\s*\(/.test(adsSrc)
    && !/async function findSiblingMasterAd\s*\(/.test(adsSrc),
  'the in-process derive wait came back — that wait moved to adgen');


// F6: a derive-only ad's renderUrl IS its master's plate until it uploads
// its own titled file — deleting it destroyed the video the master paid for.
check('F6 DELETE does not destroy an inherited master plate (child side)',
  /derive-from:/.test(adsSrc) && /stillInheritedPlate/.test(adsSrc),
  'destroying the shared asset breaks the paid master ad too');

// F6b: the SAME relationship from the master's side. The first fix was
// asymmetric — a master carries no `derive-from:` marker, so deleting it fell
// through and destroyed the plate its derive-only sibling still points at,
// and that sibling cannot self-heal (regenerate is refused for derive-only).
check('F6b [MONEY] DELETE checks for a dependent derive-only sibling before destroying a master plate',
  /masterOfLiveDerive/.test(adsSrc)
    && /platformFormat:\s*PMAX_VIDEO_DERIVE_ONLY/.test(adsSrc)
    && /renderUrl:\s*ad\.renderUrl/.test(adsSrc),
  'deleting the 9:16 master would destroy the plate the free 1:1 is still using');

check('F6c the dependent lookup fails CLOSED (keeps the asset when it cannot prove disuse)',
  /masterOfLiveDerive = true;/.test(adsSrc),
  'a failed lookup must keep a paid plate, not destroy it');

// ── G. deriveWaitAttempts FIELD (still live — the sweeper uses it) ──
//
// WHY THE FIELD STILL MATTERS. A FREE derive-only video ad that used to
// wait in-render for its master and requeue on expiry used to $inc
// renderAttempts on that requeue. services/queuedArchiveSweeper's
// `renderAttempts:0` guard exists to prove a leftover queued ad NEVER
// STARTED before archiving it — so a wait-only ad that had inflated
// renderAttempts became permanently invisible to that sweeper. The
// dedicated `deriveWaitAttempts` field is still declared on Ad; historical
// rows may carry it, and the sweeper must still ignore it (fix is
// upstream, never a loosened guard).
//
// REMOVED (dormant render fallback deletion): G2–G4 extracted
// renderDeriveOnlyVideoAd / handleDeriveMasterBackup bodies and counted
// their $inc sites. Both functions are gone; adgen owns derive rendering.
// Dropping the field declaration is still a silent-drop trap → G1.
{
  const Ad = require(path.join(ROOT, 'models/Ad'));
  const waitPath = Ad.schema.path('deriveWaitAttempts');
  check('G1 models/Ad.js declares deriveWaitAttempts (Mongoose strict silently drops undeclared writes)',
    !!waitPath && waitPath.instance === 'Number',
    'an undeclared field is silently dropped on save — the counter would never actually persist');
  check('G1b deriveWaitAttempts defaults to 0 (matches renderAttempts convention)',
    !!waitPath && waitPath.defaultValue === 0);
}


// G5: the sweeper's own guard must stay untouched — the fix is upstream
// (stop polluting the counter), never a loosened guard. The sweeper must
// still key its money guard on renderAttempts and must not reference
// deriveWaitAttempts at all — if it did, that would be a DIFFERENT kind of
// change (widening what counts as "inert"), not this fix.
{
  const sweepSrc = fs.readFileSync(path.join(ROOT, 'services/queuedArchiveSweeper.js'), 'utf8');
  check('G5 queuedArchiveSweeper still keys its guard on renderAttempts:0 (unweakened)',
    (sweepSrc.match(/\{\s*renderAttempts:\s*0\s*\},\s*\{\s*renderAttempts:\s*null\s*\}/g) || []).length >= 2,
    'the renderAttempts:0 guard is the invariant this whole fix protects — it must not change');
  check('G5b queuedArchiveSweeper does not reference deriveWaitAttempts (fix is upstream, not a guard change)',
    !/deriveWaitAttempts/.test(sweepSrc));
}

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
