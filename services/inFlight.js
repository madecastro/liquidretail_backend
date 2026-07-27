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

const runs = new Map(); // runId → { total, done, brandId, veo, startedAt }

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
 * @returns {{runCount:number, adsRemaining:number, veoRuns:number, oldestAgeMs:number, lines:string[]}}
 */
function snapshot() {
  const now = Date.now();
  let adsRemaining = 0;
  let veoRuns = 0;
  let oldest = 0;
  const lines = [];
  for (const [runId, r] of runs) {
    const left = Math.max(0, r.total - r.done);
    adsRemaining += left;
    if (r.veo) veoRuns++;
    oldest = Math.max(oldest, now - r.startedAt);
    lines.push(`${runId} ${r.done}/${r.total}${r.veo ? ' veo' : ''} brand=${r.brandId || '-'} age=${Math.round((now - r.startedAt) / 1000)}s`);
  }
  return { runCount: runs.size, adsRemaining, veoRuns, oldestAgeMs: oldest, lines };
}

module.exports = { track, progress, untrack, snapshot };
