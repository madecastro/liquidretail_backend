'use strict';
//
// geminiVideoLease — the GLOBAL concurrency guard for direct-Gemini video.
//
// ── WHY THIS IS NOT A SEMAPHORE ──────────────────────────────────────────
// `semaphore.js` in this repo says it outright: an in-process semaphore
// "would NOT be acceptable for a provider rate limit, which is global. Do not
// reuse this for one." `pacedModelSubmit` / ATLAS_SUBMIT_SPACING_MS is the
// same shape — per-process and in-memory. Gemini's cap is enforced by Google
// across the whole PROJECT, and adgen-renderer is autoscalable (render.yaml
// documents min=2/max=8, currently disabled) and is replaced by a SECOND
// live instance during every deploy's drain window. Any in-process limiter
// therefore hands each instance the full budget, which is how you get 2x the
// real rate with every knob apparently set correctly.
//
// So the lease lives in Mongo, keyed per (provider, model), and every
// instance contends for the same rows.
//
// ── WHAT THE CAP ACTUALLY IS ─────────────────────────────────────────────
// MEASURED 2026-09-03: firing 10 concurrent Omni requests produced
//   Quota exceeded for metric:
//   generativelanguage.googleapis.com/generate_content_paid_tier_2_requests,
//   limit: 8, model: gemini-omni-1.1-flash
// Google's quota ids are `…PerProjectPerModel` and its docs say plainly
// "Rate limits are applied per project, not per API key" — so a second API
// key in the same project buys nothing, and the cap is scoped to this one
// model rather than to all Gemini traffic (the ~1,526 grounded-search
// gemini-2.5-flash calls/day are on a different row).
//
// ⚠️ OCCUPANCY vs RPM IS NOT ESTABLISHED. Whether "8" means 8 in flight at
// once or 8 requests per minute was never settled — the two-wave probe that
// would settle it costs real generations and was not run. This lease is
// deliberately safe under BOTH readings, by holding two constraints at once:
//   (a) at most MAX_SLOTS leases are held concurrently (occupancy), AND
//   (b) at most MAX_SLOTS leases are ACQUIRED per rolling window (rate).
// If the real constraint is RPM, (a) alone would let a batch that finishes
// in ~60s legally fire a second batch inside the same minute. If it is
// occupancy, (b) alone would let 8 long generations pile up. Holding both
// costs a little throughput and cannot violate either reading. Do not
// "simplify" this to one of the two without running the probe first.
//
// ── THE LEASE IS A MONEY CONTROL, NOT POLITENESS ─────────────────────────
// Exceeding the cap does NOT cost us a free HTTP 429. MEASURED: the POST
// returned 200 with an interaction_id and the FIRST POLL came back
// `too_many_requests`. An accepted id is the charge-point analog, so a
// rejected-after-accept generation is a possibly-billed dead id. That makes
// staying under the cap worth real dollars, and it is why acquire() happens
// strictly BEFORE the POST, never around it.
//
const mongoose = require('mongoose');

const COLLECTION = 'geminivideoleases';

const MAX_SLOTS = (() => {
  const raw = Number(process.env.GEMINI_VIDEO_MAX_SLOTS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 8;
})();

// Rolling window for constraint (b). 60s because the published limit family
// is per-minute; if the cap turns out to be occupancy-only this is inert.
const RATE_WINDOW_MS = (() => {
  const raw = Number(process.env.GEMINI_VIDEO_RATE_WINDOW_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 60_000;
})();

// TTL after which a held lease is considered abandoned and stealable.
//
// FLOOR IS DELIBERATE AND IS NOT DERIVED FROM THE POLL BUDGET. This repo has
// been bitten twice by tying a claim TTL to a poll ceiling
// (REFRAME_CLAIM_TTL_FLOOR_MS — the two repos drifted 5 minutes apart on when
// a holder is dead, over a claim on a SHARED document). A lease that expires
// while its generation is still in flight lets a second instance fire into a
// full cap; a lease that never expires wedges the pipeline after a crash.
// MEASURED submit→terminal: 46s / 60s / 80.6s, and the file-PROCESSING tail
// can add ~95s more. 10 minutes is ~4x the worst observed total.
const LEASE_TTL_MS = (() => {
  const raw = Number(process.env.GEMINI_VIDEO_LEASE_TTL_MS);
  const v = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 600_000;
  return Math.max(v, 120_000);
})();

function coll() {
  const conn = mongoose.connection;
  if (!conn || conn.readyState !== 1) return null;
  return conn.db.collection(COLLECTION);
}

async function ensureIndexes() {
  const c = coll();
  if (!c) return;
  try {
    await c.createIndex({ scope: 1, slot: 1 }, { unique: true });
    await c.createIndex({ scope: 1, acquiredAt: 1 });
  } catch { /* index creation is best-effort; contention still works without it */ }
}

/**
 * Acquire one slot for `scope` (provider:model). Returns a release handle, or
 * null when no slot is available — the caller MUST treat null as "do not
 * submit", never as "submit anyway".
 *
 * Both constraints are checked against the SAME read so a caller cannot slip
 * between them. The write is an atomic findOneAndUpdate on a unique
 * (scope, slot) pair: two instances racing the same slot means exactly one
 * wins, because the loser's upsert violates the unique index.
 */
async function acquire(scope) {
  const c = coll();
  // FAIL CLOSED. No Mongo means we cannot prove we are under the cap, and the
  // downside of guessing wrong is a possibly-billed dead id, not a delay.
  if (!c) return null;

  await ensureIndexes();
  const now = Date.now();
  const staleBefore = new Date(now - LEASE_TTL_MS);
  const windowStart = new Date(now - RATE_WINDOW_MS);

  // (b) RATE: how many leases were acquired inside the rolling window,
  // including ones already released. Released rows are kept until they age
  // out of the window precisely so this constraint can see them.
  const acquiredInWindow = await c.countDocuments({
    scope,
    acquiredAt: { $gte: windowStart }
  });
  if (acquiredInWindow >= MAX_SLOTS) return null;

  // (a) OCCUPANCY: try each slot index; a slot is free if it has no row, its
  // row is released, or its row is older than the TTL (crashed holder).
  for (let slot = 0; slot < MAX_SLOTS; slot += 1) {
    let won = null;
    try {
      won = await c.findOneAndUpdate(
        {
          scope,
          slot,
          $or: [
            { releasedAt: { $ne: null } },
            { acquiredAt: { $lt: staleBefore } }
          ]
        },
        {
          $set: {
            scope,
            slot,
            acquiredAt: new Date(now),
            releasedAt: null,
            holder: process.env.ADGEN_WORKER_ID || `pid-${process.pid}`
          }
        },
        { upsert: true, returnDocument: 'after' }
      );
    } catch (err) {
      // Duplicate key = another instance won this slot in the same instant.
      // Not an error; try the next slot.
      if (err && (err.code === 11000 || err.code === 11001)) continue;
      // Anything else: fail closed rather than submit unproven.
      return null;
    }
    if (won) {
      let released = false;
      return {
        scope,
        slot,
        release: async () => {
          if (released) return;
          released = true;
          try {
            // Only clear OUR hold. A stolen-then-reacquired slot must not be
            // released by the previous holder finishing late.
            await c.updateOne(
              { scope, slot, releasedAt: null },
              { $set: { releasedAt: new Date() } }
            );
          } catch { /* release is best-effort; the TTL is the backstop */ }
        }
      };
    }
  }
  return null;
}

module.exports = {
  acquire,
  MAX_SLOTS,
  RATE_WINDOW_MS,
  LEASE_TTL_MS,
  COLLECTION
};
