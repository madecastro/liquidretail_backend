// progressService — uniform OperationRun lifecycle for long-running work.
//
// Wrap-don't-rewrite: existing in-memory job maps and models with their
// own status keep working. Call sites startRun() and mirror progress
// into OperationRun; a progress DB failure must never kill the business
// process (startRun returns a NO-OP handle on error).
//
// Writes are throttled to ~1/s per run so Mongo isn't hammered. Terminal
// states and the first call of each stage always flush immediately.
// Callers place handle.checkpoint() at safe per-item / per-page
// boundaries — it throws CancelledError when cancel was requested.

const OperationRun = require('../models/OperationRun');

const THROTTLE_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 30 * 1000;
// Runs whose heartbeatAt is older than this are shown as "stalled" in
// the API; the reaper (sweepStaleRuns) marks them failed.
const STALE_HEARTBEAT_MS = 2 * 60 * 1000;
// Safety valve: if a caller forgets succeed()/fail(), stop heartbeating
// after this long so the reaper can flag the abandoned run instead of
// it showing "running" forever.
const MAX_RUN_MS = 4 * 60 * 60 * 1000;

// Kinds the cancel endpoint accepts (plus any run started with
// cancellable: true). Keep in sync with the instrumentation waves.
const CANCELLABLE_KINDS = new Set([
  'social-ingest',
  'catalog-sync',
  'demo-sync',
  'enrichment',
  'category-inference',
  'font-ingest',
  'campaign-sync',
  'scheduled-sync',
  'ad-batch',
  'ad-regenerate',
  'veo-video',
  'ai-layout',
  'detect',
  'catalog-materialize'
]);

class CancelledError extends Error {
  constructor(message = 'Operation cancelled') {
    super(message);
    this.name = 'CancelledError';
    this.code = 'CANCELLED';
  }
}

function isCancellableKind(kind) {
  return CANCELLABLE_KINDS.has(kind);
}

function resolveAdvertiserId({ req, tenant, advertiserId }) {
  if (advertiserId) return advertiserId;
  if (tenant && tenant.advertiserId) return tenant.advertiserId;
  // Same convention as tenantFilter — requireAuth guarantees this.
  if (req && req.advertiserId) return req.advertiserId;
  return null;
}

function makeNoopHandle() {
  const noop = {
    id: null,
    _id: null,
    stage() { return noop; },
    tick() { return noop; },
    note() { return noop; },
    heartbeat() { return noop; },
    succeed() { return Promise.resolve(); },
    fail() { return Promise.resolve(); },
    async checkpoint() { return true; },
    isCancelRequested() { return false; },
    markCancelled() { return Promise.resolve(); }
  };
  return noop;
}

function makeHandle(doc) {
  const id = doc._id;
  const openedAt = Date.now();
  let lastWriteAt = 0;
  let pending = null;
  let writeTimer = null;
  let closed = false;
  let cancelCached = !!doc.cancelRequested;
  let cancelCheckedAt = 0;
  let lastStage = null;
  // Start of whatever stage is currently "open" — the implicit pre-first-
  // stage period counts too, so a run whose very first .stage() call closes
  // immediately still gets a real durationMs instead of 0.
  let currentStageStartedAt = openedAt;
  let itemsDone = doc.itemsDone || 0;
  let itemsTotal = doc.itemsTotal != null ? doc.itemsTotal : null;
  let lastNote = doc.note || null;
  let warned = false;

  // Close whatever stage is currently open (if any) into a {name, startedAt,
  // endedAt, durationMs, itemsDone, itemsTotal, note} record for OperationRun
  // .stages[]. Returns null when no stage was ever opened (kinds that only
  // use tick()/label, never .stage() — unaffected by this addition). Called
  // from BOTH a normal stage() transition and every terminal write, so the
  // very last stage a run was in always gets its own timed, counted entry
  // instead of being left open forever.
  function closeOpenStagePush() {
    if (lastStage == null) return null;
    const now = Date.now();
    const push = {
      name: lastStage,
      startedAt: new Date(currentStageStartedAt),
      endedAt: new Date(now),
      durationMs: now - currentStageStartedAt,
      itemsDone,
      itemsTotal,
      note: lastNote
    };
    lastStage = null; // closed — guards against a double-push if called twice
    return push;
  }

  function warnOnce(err, where) {
    if (warned) return;
    warned = true;
    console.warn(`[progressService] ${where} (${id}):`, err && err.message ? err.message : err);
  }

  function scheduleFlush() {
    if (writeTimer || closed) return;
    const delay = Math.max(0, THROTTLE_MS - (Date.now() - lastWriteAt));
    writeTimer = setTimeout(() => {
      writeTimer = null;
      const payload = pending;
      pending = null;
      if (payload) flush(payload, { force: true }).catch(() => {});
    }, delay);
    if (writeTimer.unref) writeTimer.unref();
  }

  async function flush(extra = {}, { force = false, push = null } = {}) {
    if (closed && !force) return;

    if (!force && Date.now() - lastWriteAt < THROTTLE_MS) {
      pending = Object.assign(pending || {}, extra);
      // `push` is only ever passed alongside force:true call sites (a stage
      // transition or a terminal write), so there is no batched-push case to
      // handle here — nothing is lost by not merging it into `pending`.
      scheduleFlush();
      return;
    }

    if (writeTimer) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }

    const payload = Object.assign({}, pending, extra);
    pending = null;
    lastWriteAt = Date.now();
    const ts = new Date();
    payload.updatedAt = ts;
    payload.heartbeatAt = ts;

    const update = { $set: payload };
    if (push) update.$push = { stages: push };

    try {
      await OperationRun.updateOne({ _id: id }, update);
    } catch (err) {
      warnOnce(err, 'flush');
      // A $push + $set combined in one updateOne is one atomic write — if
      // it throws (a bad value, a transient Mongo error), the WHOLE write
      // is lost, not just the stage-history push. That is fine for a
      // regular tick()/note() flush (no push involved, unchanged from
      // before this feature). But `push` only ever accompanies a stage
      // transition or a TERMINAL write (succeed/fail/markCancelled/cancel)
      // — losing one of those is worse than losing a stages[] entry: the
      // reaper would otherwise fail the run later with a generic "process
      // restarted" instead of its real status/error. Retry once WITHOUT
      // the push so the terminal status still lands even if the stage
      // history entry does not.
      if (push) {
        try {
          await OperationRun.updateOne({ _id: id }, { $set: payload });
        } catch (err2) {
          warnOnce(err2, 'flush (retry without push)');
        }
      }
    }
  }

  // Keep heartbeatAt fresh even when the job is between ticks. Stops at
  // MAX_RUN_MS so an abandoned handle can't pin a run "running" forever
  // (the reaper then flags it within STALE_HEARTBEAT_MS).
  const hbTimer = setInterval(() => {
    if (closed) return;
    if (Date.now() - openedAt > MAX_RUN_MS) {
      closeTimers();
      return;
    }
    flush({}, { force: true }).catch(() => {});
  }, HEARTBEAT_INTERVAL_MS);
  if (hbTimer.unref) hbTimer.unref();

  function closeTimers() {
    closed = true;
    if (writeTimer) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
    clearInterval(hbTimer);
  }

  const handle = {
    id: String(id),
    _id: id,

    stage(name) {
      if (closed) return handle;
      const firstOfStage = lastStage !== name;
      // Close the PREVIOUS stage (if this is a real transition, not a
      // repeat of the same name) before opening the new one, so its own
      // elapsed time + final counts land in stages[] rather than being
      // silently overwritten by the next stage's progress.
      const push = firstOfStage ? closeOpenStagePush() : null;
      const resetUpdate = {};
      if (firstOfStage) {
        currentStageStartedAt = Date.now();
        // Some real call chains open a stage that is itself immediately
        // superseded by a NESTED call's own .stage() (e.g. apifyIngestService
        // .syncBrandApify's 'shopify catalog' dispatch stage, closed almost
        // instantly by shopifyPublicIngestService.syncBrandShopifyDirect's
        // first 'resolving catalog access' stage on the SAME handle) —
        // without progress of its own in between, that dispatch-only stage
        // would otherwise inherit whatever note/counts the PREVIOUS,
        // unrelated stage last left behind (e.g. an Instagram tally showing
        // up against a "shopify catalog" entry, or a first empty credential
        // in postSyncService.js inheriting a prior credential's count).
        // Reset ALL THREE here — note AND the counts — so a stage that
        // never calls tick()/note() of its own closes (and, until its own
        // first tick(), currently DISPLAYS) as empty rather than stale and
        // misattributed. Included in the SAME $set as `stage` below, not
        // just the in-memory closure, so a live "current stage" reader
        // never shows carried-over numbers either, not only the closed
        // stages[] history. adgen's live hit of this bug is
        // adRegenerateService.js calling .stage() three times per run
        // ('generating video' → 'compositing' → 'generating image') and
        // carrying stale itemsDone/itemsTotal/note across those transitions.
        lastNote = null;
        itemsDone = 0;
        itemsTotal = null;
        resetUpdate.note = null;
        resetUpdate.itemsDone = 0;
        resetUpdate.itemsTotal = null;
        // pct is meaningless without itemsTotal — same convention tick()
        // already uses (only sets pct when itemsTotal is a positive number).
        resetUpdate.pct = null;
      }
      lastStage = name;
      // First call of each stage always flushes; later updates throttle.
      flush({ stage: name, ...resetUpdate }, { force: firstOfStage, push }).catch(() => {});
      return handle;
    },

    tick(done, total, note) {
      if (closed) return handle;
      itemsDone = done;
      if (total != null) itemsTotal = total;
      if (note != null) lastNote = note;
      const update = { itemsDone: done };
      if (total != null) update.itemsTotal = total;
      if (note != null) update.note = note;
      if (itemsTotal != null && itemsTotal > 0) {
        update.pct = Math.min(1, Math.max(0, itemsDone / itemsTotal));
      }
      flush(update).catch(() => {});
      return handle;
    },

    note(text) {
      if (closed) return handle;
      lastNote = text;
      flush({ note: text }).catch(() => {});
      return handle;
    },

    heartbeat() {
      if (closed) return handle;
      flush({}, { force: true }).catch(() => {});
      return handle;
    },

    // Terminal — always flush immediately; never reject to the caller.
    succeed(summary) {
      closeTimers();
      const push = closeOpenStagePush();
      const update = { status: 'succeeded', endedAt: new Date() };
      if (itemsTotal != null) {
        update.itemsDone = itemsTotal;
        update.pct = 1;
      }
      if (summary != null) {
        if (typeof summary === 'string') update.note = summary;
        else if (typeof summary === 'object') update.meta = summary;
      }
      return flush(update, { force: true, push }).catch(() => {});
    },

    // Optional second `meta` arg mirrors succeed(summary): object →
    // OperationRun.meta (Mixed — no schema change). Single-arg callers
    // behave exactly as before. Needed so a *failed* run can still carry
    // per-source diagnostics (the case operators most need them).
    fail(err, meta) {
      closeTimers();
      const push = closeOpenStagePush();
      const message = err && err.message ? err.message : String(err || 'failed');
      const update = { status: 'failed', endedAt: new Date(), error: message, note: message };
      if (meta != null && typeof meta === 'object') update.meta = meta;
      return flush(update, { force: true, push }).catch(() => {});
    },

    // Refresh cancelRequested from Mongo at most 1/s (cached in between).
    // When cancel is requested: write cancelled + endedAt, then throw.
    async checkpoint() {
      if (closed) return true;

      const now = Date.now();
      if (now - cancelCheckedAt >= THROTTLE_MS) {
        cancelCheckedAt = now;
        try {
          const row = await OperationRun.findById(id).select('cancelRequested').lean();
          if (row) cancelCached = !!row.cancelRequested;
        } catch (err) {
          warnOnce(err, 'checkpoint');
        }
      }

      if (cancelCached) {
        closeTimers();
        const push = closeOpenStagePush();
        await flush(
          { status: 'cancelled', endedAt: new Date(), note: 'Cancelled — partial results kept' },
          { force: true, push }
        );
        throw new CancelledError();
      }
      return true;
    },

    // Non-throwing view of the same cache checkpoint() refreshes.
    isCancelRequested() {
      return cancelCached;
    },

    // Terminal cancel WITHOUT throwing — for services with their own
    // break-style abort flow (e.g. apify demo sync's legacy /abort flag).
    markCancelled(note) {
      closeTimers();
      const push = closeOpenStagePush();
      return flush(
        { status: 'cancelled', endedAt: new Date(), note: note || 'Cancelled — partial results kept' },
        { force: true, push }
      ).catch(() => {});
    }
  };

  return handle;
}

/**
 * startRun({ kind, req|tenant|advertiserId, brandId?, total?, meta?, cancellable?, label? })
 * → Promise<handle>
 *
 * Never throws into the caller. On any DB / tenant error returns a
 * NO-OP handle with the same interface so business work continues.
 */
async function startRun({
  kind,
  req = null,
  tenant = null,
  brandId = null,
  total = null,
  meta = null,
  cancellable = false,
  label = null,
  advertiserId = null
} = {}) {
  try {
    const advId = resolveAdvertiserId({ req, tenant, advertiserId });
    if (!advId) {
      console.warn('[progressService] startRun: no advertiserId — returning no-op handle');
      return makeNoopHandle();
    }
    if (!kind) {
      console.warn('[progressService] startRun: kind required — returning no-op handle');
      return makeNoopHandle();
    }

    const now = new Date();
    const doc = await OperationRun.create({
      advertiserId: advId,
      brandId: brandId || null,
      kind,
      label: label || null,
      status: 'running',
      pct: total != null && total > 0 ? 0 : null,
      itemsDone: 0,
      itemsTotal: total != null ? total : null,
      startedAt: now,
      updatedAt: now,
      heartbeatAt: now,
      cancellable: !!(cancellable || isCancellableKind(kind)),
      meta: meta || null
    });

    return makeHandle(doc);
  } catch (err) {
    console.warn('[progressService] startRun failed — returning no-op handle:', err && err.message ? err.message : err);
    return makeNoopHandle();
  }
}

/**
 * Reaper: mark runs left behind by a dead process as failed. Called on
 * boot and from worker.js reapOrphans on its periodic sweep.
 */
async function sweepStaleRuns() {
  const cutoff = new Date(Date.now() - STALE_HEARTBEAT_MS);
  const now = new Date();
  try {
    const res = await OperationRun.updateMany(
      { status: { $in: ['running', 'cancelling'] }, heartbeatAt: { $lt: cutoff } },
      {
        $set: {
          status: 'failed',
          endedAt: now,
          updatedAt: now,
          error: 'process restarted',
          note: 'failed (process restarted or stalled)'
        }
      }
    );
    const n = res.modifiedCount != null ? res.modifiedCount : res.nModified;
    if (n) console.warn(`[progressService] sweepStaleRuns: marked ${n} run(s) failed`);
    return res;
  } catch (err) {
    console.warn('[progressService] sweepStaleRuns failed:', err && err.message ? err.message : err);
    return null;
  }
}

module.exports = {
  startRun,
  CancelledError,
  sweepStaleRuns,
  isCancellableKind,
  CANCELLABLE_KINDS,
  STALE_HEARTBEAT_MS
};
