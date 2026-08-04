// Per-process registry of render work currently in flight.
//
// Exists so a shutdown alert can say WHAT is about to be lost. Ad rendering
// runs as a fire-and-forget loop inside the web process (routes/ads.js
// runRenderLoop); when Render replaces the instance — a deploy, or an
// autoscale scale-in — that loop dies mid-batch and the ads sit in
// 'rendering' until worker.js's orphan reaper flips them back to 'queued'
// 15 minutes later. "SIGTERM with 1 run / 17 ads in flight" is a far more
// actionable alert than "SIGTERM".
//
// Deliberately in-memory and process-local: it describes THIS process's
// work, and it must be readable from a signal handler without touching the
// database.
//
// Two layers: run-level (how many ads a CampaignRun still owes) and
// ad-level (which specific ads, at what stage, and whether a billable
// Atlas POST already returned). The ad layer is what lets a shutdown
// alert distinguish "lost work that cost nothing" from "lost work we
// already paid for".

const runs = new Map(); // runId → { total, done, brandId, veo, startedAt }
const ads  = new Map(); // adId  → { runId, kind, format, stage, submitted, predictionId, startedAt }

// Hard cap — same constant style and reasoning as alertService.MAX_TRACKED_KEYS.
// An unbounded Map in a long-lived process is exactly the bug pruneDedupeState
// exists to prevent: a slow leak of abandoned keys under load.
const MAX_TRACKED_ADS = 500;

function pruneAds() {
  // Map iteration order is insertion order; keys().next() is the oldest.
  while (ads.size > MAX_TRACKED_ADS) {
    ads.delete(ads.keys().next().value);
  }
}

function track(runId, metaArg) {
  if (!runId) return;
  // `= {}` would not cover an explicit null, and this is called from a
  // render loop where a throw is now fatal (see services/processAlerts.js).
  const meta = metaArg || {};
  runs.set(String(runId), {
    total:     Number(meta.total) || 0,
    done:      0,
    brandId:   meta.brandId ? String(meta.brandId) : null,
    veo:       Boolean(meta.veo),
    startedAt: Date.now()
  });
}

function progress(runId, done) {
  const r = runs.get(String(runId));
  if (r) r.done = Number(done) || 0;
}

function untrack(runId) {
  runs.delete(String(runId));
}

/**
 * Register one ad as in-flight under a run. Safe with null/garbage —
 * never throws (a throw here is fatal once processAlerts is installed).
 * Evicts oldest entries when the map exceeds MAX_TRACKED_ADS.
 */
function trackAd(runId, adId, metaArg) {
  if (!adId) return;
  const meta = metaArg || {};
  const id = String(adId);
  // Re-track of an already-tracked id: delete first so Map insertion
  // order reflects the newest track (eviction stays oldest-first).
  if (ads.has(id)) ads.delete(id);
  ads.set(id, {
    runId:        runId ? String(runId) : null,
    kind:         meta.kind ? String(meta.kind) : null,
    format:       meta.format ? String(meta.format) : null,
    stage:        null,
    submitted:    false,
    predictionId: null,
    startedAt:    Date.now()
  });
  pruneAds();
}

/**
 * Update the live stage string for an ad (e.g. 'veo submit', 'titling').
 * No-op if the ad is not currently tracked.
 */
function adStage(adId, stage) {
  if (!adId) return;
  const a = ads.get(String(adId));
  if (!a) return;
  a.stage = stage == null ? null : String(stage);
}

/**
 * Mark that a BILLABLE Atlas POST has already returned for this ad.
 * Money-critical: the shutdown alert uses submittedAdIds to flag
 * "N ad(s) had a charged submit in flight" — lost work we already paid for,
 * as distinct from an ad killed before any submit (cost nothing).
 * Optional predictionId is stored for correlation if present.
 */
function markSubmitted(adId, metaArg) {
  if (!adId) return;
  const id = String(adId);
  const meta = metaArg || {};
  let a = ads.get(id);
  if (!a) {
    // SELF-REGISTER rather than no-op. Money telemetry must not depend on a
    // caller having remembered trackAd first — the regenerate path bills ~$1
    // per video and never enters the render pool, so a no-op here would report
    // a charged loss as free. Registering on the charge point means every
    // billable submit is visible to the shutdown alert by construction.
    trackAd(null, id, {});
    a = ads.get(id);
    if (!a) return;
  }
  a.submitted = true;
  if (meta.predictionId != null && meta.predictionId !== '') {
    a.predictionId = String(meta.predictionId);
  }
}

function untrackAd(adId) {
  if (!adId) return;
  ads.delete(String(adId));
}

/**
 * @returns {{
 *   runCount:number,
 *   adsRemaining:number,
 *   veoRuns:number,
 *   oldestAgeMs:number,
 *   lines:string[],
 *   runIds:string[],
 *   adIds:string[],
 *   submittedAdIds:string[],
 *   adLines:string[],
 *   oldestAdAgeMs:number
 * }}
 */
function snapshot() {
  const now = Date.now();
  let adsRemaining = 0;
  let veoRuns = 0;
  let oldest = 0;
  const lines = [];
  const runIds = [];
  for (const [runId, r] of runs) {
    const left = Math.max(0, r.total - r.done);
    adsRemaining += left;
    if (r.veo) veoRuns++;
    oldest = Math.max(oldest, now - r.startedAt);
    lines.push(`${runId} ${r.done}/${r.total}${r.veo ? ' veo' : ''} brand=${r.brandId || '-'} age=${Math.round((now - r.startedAt) / 1000)}s`);
    // Included so the shutdown/crash handler can scope the requeue +
    // errors[] stamp to exactly the runs THIS process was working on,
    // instead of a global "any rendering ad" sweep.
    runIds.push(runId);
  }

  // Per-ad view: which ads, live stage, age, and whether a billable submit
  // already returned. Readable from a signal handler with zero DB reads.
  const adIds = [];
  const submittedAdIds = [];
  const adLines = [];
  // Tracked SEPARATELY from `oldest`. processAlerts renders oldestAgeMs as the
  // field literally labelled "oldest run", so folding ad ages into it would
  // make that label lie — an ad can outlive its run's entry here (untrackAd is
  // best-effort, and trackAd does not require a matching track()).
  let oldestAd = 0;
  for (const [adId, a] of ads) {
    adIds.push(adId);
    if (a.submitted) submittedAdIds.push(adId);
    oldestAd = Math.max(oldestAd, now - a.startedAt);
    adLines.push(
      `${adId} stage=${a.stage || '-'} age=${Math.round((now - a.startedAt) / 1000)}s` +
      (a.submitted ? ' SUBMITTED/charged' : '')
    );
  }

  return {
    runCount: runs.size,
    adsRemaining,
    veoRuns,
    oldestAgeMs: oldest,
    lines,
    runIds,
    adIds,
    submittedAdIds,
    adLines,
    oldestAdAgeMs: oldestAd
  };
}

module.exports = {
  track,
  progress,
  untrack,
  trackAd,
  adStage,
  markSubmitted,
  untrackAd,
  snapshot
};
