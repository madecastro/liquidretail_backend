#!/usr/bin/env node
'use strict';
//
// verifyTitlingDeliveryTruth — pins the "delivered means titled" fix.
//
// INCIDENT (2026-08-20): a 39-ad run reported 29/39 "delivered" by the
// codebase's own heuristic (renderUrl non-null + status:'draft'), but only
// 16 carried an actually-titled asset. The other 13 were the bare Omni
// master — no headline, CTA, rating, quote, or logo — indistinguishable
// from a finished ad by any field an operator could see. This harness pins:
//
//   1. services/adTitlingTruth.js — the one function that tells a genuine
//      composite apart from a raw master parked on renderUrl.
//   2. services/campaignRunGuards.js classifyRunAdOutcome — the run rollup
//      must not count an untitled master as "succeeded", and must not
//      finalize a run while one is outstanding (isSettled).
//   3. worker.js's reconciliation call site — the Ad projection it fetches
//      MUST include the fields isVideoTitlingSettled needs, or the check
//      above silently becomes a no-op (an unselected `kind` reads
//      `undefined !== 'video'`, so every ad is treated as a static and the
//      titling debt is never seen at all).
//   4. routes/ads.js projectAd, routes/catalog.js and routes/campaigns.js
//      ads-detail — the discriminator must actually reach the JSON the
//      frontend gets, not just be computed and dropped (the exact bug
//      found live in both ads-detail endpoints: renderStage/renderStageAt
//      were fetched in the $project and never put on the mapped row, so
//      the operator-facing status pill's "empty stage = done" fallback
//      called every draft ad — including untitled masters — finished).
//   5. services/metaAdsPushService.js — an untitled master must not be
//      pushable to Meta.
//   6. services/backlogWatchdog.js — an ad stuck with an open titling debt
//      must eventually alert (the "no signal at all" half of the incident).
//
// Offline only: no DB, no network, no API key.
//   node scripts/verifyTitlingDeliveryTruth.js
//
// Revert-prove (each mutation must fail this harness):
//   make isVideoTitlingSettled return true unconditionally      → D1-D6
//   drop the titlingIncomplete bucket from classifyRunAdOutcome → C1-C4
//   narrow worker.js's reconciliation .select() back to 'status'→ W1
//   drop `titled`/`titlingResumeState` from projectAd            → P1-P3
//   drop them from catalog.js / campaigns.js ads-detail rows     → CAT1-CAT4, CMP1-CMP4
//   drop the titling gate from metaAdsPushService.pushOne        → M1-M2
//   remove the titling-stuck watchdog check                      → B1-B3

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const ADS_SRC        = read('routes', 'ads.js');
const CATALOG_SRC     = read('routes', 'catalog.js');
const CAMPAIGNS_SRC   = read('routes', 'campaigns.js');
const GUARDS_SRC      = read('services', 'campaignRunGuards.js');
const WORKER_SRC      = read('worker.js');
const META_PUSH_SRC   = read('services', 'metaAdsPushService.js');
const WATCHDOG_SRC    = read('services', 'backlogWatchdog.js');

// Comment-stripped source for every text assertion below — a check a
// COMMENT can satisfy is worthless (see verifyTitlingResume.js's own note;
// this repo has shipped that exact bug before).
function stripComments(src) {
  let out = ''; let i = 0; let quote = null;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (quote) {
      if (c === '\\') { out += c + (n || ''); i += 2; continue; }
      if (c === quote) quote = null;
      out += c; i++; continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && n === '*') {
      out += '  '; i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      out += '  '; i += 2; continue;
    }
    out += c; i++;
  }
  return out;
}

const ADS_CODE       = stripComments(ADS_SRC);
const CATALOG_CODE    = stripComments(CATALOG_SRC);
const CAMPAIGNS_CODE  = stripComments(CAMPAIGNS_SRC);
const GUARDS_CODE     = stripComments(GUARDS_SRC);
const WORKER_CODE     = stripComments(WORKER_SRC);
const META_PUSH_CODE  = stripComments(META_PUSH_SRC);
const WATCHDOG_CODE   = stripComments(WATCHDOG_SRC);

let pass = 0;
const failures = [];
function checkTrue(label, cond, extra) {
  if (cond) { pass++; return; }
  failures.push(label + (extra ? ` — ${extra}` : ''));
}

const truth   = require('../services/adTitlingTruth');
const guards  = require('../services/campaignRunGuards');
const watchdog = require('../services/backlogWatchdog');

// ── Fixtures — real Ad-doc shapes, not guesses ────────────────────────
const IMAGE_AD = { kind: 'image', status: 'draft', renderUrl: 'https://c/img.jpg' };

const TITLED_VIDEO = {
  kind: 'video', status: 'draft',
  renderUrl: 'https://c/titled.mp4', veoVideoUrl: 'https://c/master.mp4',
  titlingResumeState: null, renderStage: 'done'
};

const UNTITLED_CLAIMED = {
  kind: 'video', status: 'draft',
  renderUrl: 'https://c/master.mp4', veoVideoUrl: 'https://c/master.mp4',
  titlingResumeState: 'claimed', renderStage: 'titling 9:16'
};

const UNTITLED_PENDING = {
  kind: 'video', status: 'draft',
  renderUrl: 'https://c/master.mp4', veoVideoUrl: 'https://c/master.mp4',
  titlingResumeState: 'pending', renderStage: 'master recovered; titling pending'
};

// The exact orphan shape measured live: process died, nothing ever
// released the claim back to pending/null, no further write ever landed.
const UNTITLED_ABANDONED = {
  kind: 'video', status: 'draft',
  renderUrl: 'https://c/master.mp4', veoVideoUrl: 'https://c/master.mp4',
  titlingResumeState: null, renderStage: 'titling 4:5'
};

const NO_BRAND_SHIP = {
  kind: 'video', status: 'draft',
  renderUrl: 'https://c/master.mp4', veoVideoUrl: 'https://c/master.mp4',
  titlingResumeState: null, renderStage: 'no titling (no brand) — shipping master'
};

const NO_CHROME_SHIP = {
  kind: 'video', status: 'draft',
  renderUrl: 'https://c/master.mp4', veoVideoUrl: 'https://c/master.mp4',
  titlingResumeState: null, renderStage: 'no titling (no-chrome) — shipping master'
};

const FAILED_VIDEO = {
  kind: 'video', status: 'failed',
  renderUrl: 'https://c/master.mp4', veoVideoUrl: 'https://c/master.mp4',
  titlingResumeState: null, renderStage: 'master rendered; titling failed'
};

// ── D: services/adTitlingTruth.js — the discriminator itself ─────────
checkTrue('D1 exports isVideoTitlingSettled + isAdHonestlyDelivered',
  typeof truth.isVideoTitlingSettled === 'function'
  && typeof truth.isAdHonestlyDelivered === 'function');

checkTrue('D2 a static image is always titling-settled (no titling step exists)',
  truth.isVideoTitlingSettled(IMAGE_AD) === true);

checkTrue('D3 a genuinely composited video (renderUrl !== veoVideoUrl) is settled',
  truth.isVideoTitlingSettled(TITLED_VIDEO) === true);

checkTrue('D4 titlingResumeState claimed/pending is NEVER settled, regardless of renderUrl',
  truth.isVideoTitlingSettled(UNTITLED_CLAIMED) === false
  && truth.isVideoTitlingSettled(UNTITLED_PENDING) === false);

checkTrue('D5 THE INCIDENT SHAPE: raw master + null state + in-flight-looking stage is NOT settled',
  truth.isVideoTitlingSettled(UNTITLED_ABANDONED) === false,
  'this is exactly the 13-ad shape measured live on 2026-08-20 — must never read as delivered');

checkTrue('D6 an intentional no-brand/no-chrome ship (raw master, declared reason) IS settled',
  truth.isVideoTitlingSettled(NO_BRAND_SHIP) === true
  && truth.isVideoTitlingSettled(NO_CHROME_SHIP) === true,
  'a legitimate bare-master ship must not be punished by the fix for the illegitimate one');

checkTrue('D7 isAdHonestlyDelivered requires a delivered status (failed is never delivered)',
  truth.isAdHonestlyDelivered(FAILED_VIDEO) === false);

checkTrue('D8 isAdHonestlyDelivered agrees with isVideoTitlingSettled for draft/live/archived',
  truth.isAdHonestlyDelivered(TITLED_VIDEO) === true
  && truth.isAdHonestlyDelivered(UNTITLED_ABANDONED) === false
  && truth.isAdHonestlyDelivered(IMAGE_AD) === true);

checkTrue('D9 null/undefined ad never throws and never counts as delivered',
  truth.isAdHonestlyDelivered(null) === false
  && truth.isAdHonestlyDelivered(undefined) === false
  && truth.isVideoTitlingSettled(null) === false);

// ── C: services/campaignRunGuards.js classifyRunAdOutcome ────────────
{
  const outcomeAllTitled = guards.classifyRunAdOutcome([TITLED_VIDEO, IMAGE_AD, NO_BRAND_SHIP]);
  checkTrue('C1 a run whose ads are all genuinely titled/settled is isSettled with 3 succeeded',
    outcomeAllTitled.isSettled === true && outcomeAllTitled.succeeded === 3
    && outcomeAllTitled.titlingIncomplete === 0);

  const outcomeWithOrphan = guards.classifyRunAdOutcome([TITLED_VIDEO, UNTITLED_ABANDONED, IMAGE_AD]);
  checkTrue('C2 THE INCIDENT: an untitled-master draft is NOT counted as succeeded',
    outcomeWithOrphan.succeeded === 2 && outcomeWithOrphan.titlingIncomplete === 1);
  checkTrue('C3 a run with an untitled-master draft is NOT settled — must not finalize',
    outcomeWithOrphan.isSettled === false,
    'finalizing here is exactly what would stamp a dishonest succeeded count onto the run');

  const outcomeStillRendering = guards.classifyRunAdOutcome([{ status: 'rendering' }]);
  checkTrue('C4 stillRendering and titlingIncomplete both independently block isSettled',
    outcomeStillRendering.isSettled === false && outcomeStillRendering.stillRendering === 1);

  const outcomeClaimedVideo = guards.classifyRunAdOutcome([UNTITLED_CLAIMED, UNTITLED_PENDING]);
  checkTrue('C5 claimed/pending video drafts are titlingIncomplete, not succeeded or failed',
    outcomeClaimedVideo.titlingIncomplete === 2
    && outcomeClaimedVideo.succeeded === 0 && outcomeClaimedVideo.failed === 0);
}

checkTrue('C6 campaignRunGuards imports the discriminator, does not re-derive its own',
  /require\(['"]\.\/adTitlingTruth['"]\)/.test(GUARDS_CODE));

// ── W: worker.js's reconciliation call site must fetch what C needs ───
// The single most dangerous way to silently defeat the whole fix: narrow
// this .select() back to 'status' and every video ad in the run is
// mis-read as `kind === undefined`, which isVideoTitlingSettled treats as
// "not a video" → always settled → titlingIncomplete is always 0 again.
{
  const selectMatch = WORKER_CODE.match(
    /Ad\.find\(\{\s*campaignRunIds:\s*candidate\.runId\s*\}\)\s*\.select\((['"`])([^'"`]+)\1\)/
  );
  checkTrue('W1 the reconciliation Ad.find is followed by a .select() call',
    !!selectMatch, 'could not find worker.js\'s classifyRunAdOutcome data source at all');
  if (selectMatch) {
    const fields = selectMatch[2].split(/\s+/).filter(Boolean);
    for (const f of ['status', 'kind', 'renderUrl', 'veoVideoUrl', 'titlingResumeState', 'renderStage']) {
      checkTrue(`W1.${f} the reconciliation .select() includes "${f}"`, fields.includes(f));
    }
  }
}

checkTrue('W2 worker.js imports classifyRunAdOutcome from campaignRunGuards',
  /classifyRunAdOutcome/.test(WORKER_CODE) && /require\(['"]\.\/services\/campaignRunGuards['"]\)/.test(WORKER_CODE));

// ── P: routes/ads.js projectAd exposes the discriminator ─────────────
checkTrue('P1 projectAd imports isAdHonestlyDelivered from services/adTitlingTruth',
  /require\(['"]\.\.\/services\/adTitlingTruth['"]\)/.test(ADS_CODE));
checkTrue('P2 projectAd base object emits titled: isAdHonestlyDelivered(ad)',
  /titled:\s*isAdHonestlyDelivered\(ad\)/.test(ADS_CODE));
checkTrue('P3 projectAd base object emits raw titlingResumeState',
  /titlingResumeState:\s*ad\.titlingResumeState/.test(ADS_CODE));

// ── CAT / CMP: the two ads-detail endpoints must not drop the fields ──
// they fetch. This is the EXACT bug found live: renderStage/renderStageAt
// were in the $project and never reached the mapped row, so the Product
// Ads page (the primary nav surface, per frontend PR #67) showed every
// draft ad — titled or not — as finished.
function checkAdsDetailEndpoint(name, code) {
  checkTrue(`${name}1 $project includes titlingResumeState + veoVideoUrl`,
    /titlingResumeState:\s*1/.test(code) && /veoVideoUrl:\s*1/.test(code));
  checkTrue(`${name}2 imports isAdHonestlyDelivered`,
    /require\(['"]\.\.\/services\/adTitlingTruth['"]\)/.test(code));
  checkTrue(`${name}3 mapped row emits titled: isAdHonestlyDelivered(a)`,
    /titled:\s*isAdHonestlyDelivered\(a\)/.test(code));
  checkTrue(`${name}4 mapped row emits renderStage — the field it fetched but used to drop`,
    /renderStage:\s*a\.renderStage/.test(code));
}
checkAdsDetailEndpoint('CAT', CATALOG_CODE);
checkAdsDetailEndpoint('CMP', CAMPAIGNS_CODE);

// ── M: services/metaAdsPushService.js — an untitled master is not pushable ─
{
  const idxImport = META_PUSH_CODE.search(/require\(['"]\.\/adTitlingTruth['"]\)/);
  const idxGuard  = META_PUSH_CODE.search(/if\s*\(\s*!isVideoTitlingSettled\(ad\)\s*\)/);
  const idxUpload = META_PUSH_CODE.search(/await\s+uploadVideoToMeta\(/);
  checkTrue('M1 pushOne imports isVideoTitlingSettled', idxImport !== -1);
  checkTrue('M2 pushOne checks isVideoTitlingSettled and throws before any Meta upload',
    idxGuard !== -1 && idxUpload !== -1 && idxGuard < idxUpload,
    'the gate must run before uploadVideoToMeta, not after');
}

// ── B: services/backlogWatchdog.js — the missing signal ──────────────
checkTrue('B1 exports TITLING_STUCK_MIN',
  typeof watchdog.TITLING_STUCK_MIN === 'function');
{
  const prevEnv = process.env.ALERT_TITLING_STUCK_MIN;
  delete process.env.ALERT_TITLING_STUCK_MIN;
  const dflt = watchdog.TITLING_STUCK_MIN();
  process.env.ALERT_TITLING_STUCK_MIN = '7';
  const overridden = watchdog.TITLING_STUCK_MIN();
  if (prevEnv === undefined) delete process.env.ALERT_TITLING_STUCK_MIN;
  else process.env.ALERT_TITLING_STUCK_MIN = prevEnv;
  checkTrue('B2 TITLING_STUCK_MIN defaults to 45 and honors an env override',
    dflt === 45 && overridden === 7);
}
checkTrue('B3 the watchdog queries titlingResumeState in [pending, claimed] gated by updatedAt',
  /titlingResumeState:\s*\{\s*\$in:\s*\[\s*['"]pending['"],\s*['"]claimed['"]\s*\]\s*\}/.test(WATCHDOG_CODE)
  && /watchdog:titling-stuck/.test(WATCHDOG_CODE));

// ── B4-B6: THE BLIND SPOT (2026-08-20 incident, second half). The idle-based
// arm above (B1-B3) cannot see an ad ACTIVELY cycling claim -> abandon ->
// reclaim: titlingResumeService's own stale-claim reclaim (CLAIM_STALE_MIN,
// 15m default) refreshes updatedAt every time it fires, and the reclaim
// interval (≈CLAIM_STALE_MIN + the sweep's own 5m cadence) sits well under
// ALERT_TITLING_STUCK_MIN's 45m default — so the idle predicate can only ever
// fire on an ad the sweeper has STOPPED reaching, never on one it is actively
// (and fruitlessly) re-driving. Measured live: a batch of Remotion renders
// stalled 11-15m straight through an autoscale replacement storm with zero
// alert. Counting claims, not measuring silence, is what makes that visible.
checkTrue('B4 exports TITLING_CYCLES',
  typeof watchdog.TITLING_CYCLES === 'function');
{
  const prevEnv = process.env.ALERT_TITLING_CYCLES;
  delete process.env.ALERT_TITLING_CYCLES;
  const dflt = watchdog.TITLING_CYCLES();
  process.env.ALERT_TITLING_CYCLES = '9';
  const overridden = watchdog.TITLING_CYCLES();
  process.env.ALERT_TITLING_CYCLES = '1';
  const floored = watchdog.TITLING_CYCLES();
  if (prevEnv === undefined) delete process.env.ALERT_TITLING_CYCLES;
  else process.env.ALERT_TITLING_CYCLES = prevEnv;
  checkTrue('B5 TITLING_CYCLES defaults to 2, honors an env override, and floors at 2',
    dflt === 2 && overridden === 9 && floored === 2,
    'a floor of 1 would page on ordinary single-claim recovery doing its job');
}
checkTrue('B6 the watchdog query ALSO matches on titlingResumeAttempts, independent of updatedAt',
  (() => {
    // Locate the titling-stuck query block specifically, not the whole file —
    // a whole-file regex would be satisfied by an unrelated $gte elsewhere.
    const idx = WATCHDOG_CODE.indexOf("key:   'watchdog:titling-stuck'");
    const qIdx = WATCHDOG_CODE.lastIndexOf('Ad.find(', idx);
    const block = WATCHDOG_CODE.slice(qIdx, idx);
    return /titlingResumeAttempts:\s*\{\s*\$gte:\s*cycles\s*\}/.test(block)
      && /\$or:\s*\[/.test(block);
  })(),
  'without this, an ad cycling through reclaims every ~20m never crosses the 45m idle bar '
  + 'and the alert this incident asked for still cannot fire on the case it was written for');

const total = pass + failures.length;
if (failures.length) {
  console.error(`verifyTitlingDeliveryTruth: ${pass}/${total} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error('  FAIL', f);
  process.exit(1);
}
console.log(`verifyTitlingDeliveryTruth: ${pass}/${total} passed`);
process.exit(0);
