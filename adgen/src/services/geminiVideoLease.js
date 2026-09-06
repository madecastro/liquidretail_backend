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
const crypto = require('crypto');

const COLLECTION = 'geminivideoleases';

// B6 FIX. A SEPARATE, APPEND-ONLY ledger for constraint (b). See the long
// comment above acquire() for the full story; short version: constraint (a)
// deliberately REUSES one document per slot (findOneAndUpdate on the unique
// (scope, slot) key, overwriting acquiredAt in place when a slot is
// stolen/recycled) — that reuse is exactly right for occupancy, but it means
// a countDocuments query against THAT collection can never report more than
// MAX_SLOTS results, no matter how many times a slot actually turned over
// within the window: there are only MAX_SLOTS possible (scope, slot) rows,
// period. So a naive rate check against the occupancy collection is
// structurally incapable of ever firing — measured directly: 20 sequential,
// completely non-concurrent, single-process fast acquire/release cycles all
// reusing slot 0 inside one 60s window sailed straight through the old
// pre-check every time (it read "1 in the window" forever), for a true rate
// of 20 submits/60s against a cap of 8. No race, no concurrency needed at
// all — this reproduces with ONE worker. The ledger fixes it by recording
// one INSERT per acquisition (never overwritten), so the count is the true
// number of acquisitions in the window regardless of how fast any given
// slot recycles.
const RATE_EVENTS_COLLECTION = 'geminivideoleaseevents';

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

// Storage hygiene only — NOT a correctness dependency. Every rate query
// filters explicitly by `acquiredAt: {$gte: windowStart}`, so a TTL row that
// lags its expiry (Mongo's TTL monitor runs on its own ~60s cadence and only
// promises EVENTUAL deletion) is simply excluded by that filter in the
// meantime, never counted stale. The margin here just bounds how long a
// long-idle scope's dead rows sit on disk.
const RATE_EVENT_TTL_SECONDS = Math.ceil(RATE_WINDOW_MS / 1000) + 300;

// TTL after which a held lease is considered abandoned and stealable.
//
// FLOOR IS DELIBERATE AND IS NOT DERIVED FROM THE POLL BUDGET. This repo has
// been bitten twice by tying a claim TTL to a poll ceiling
// (REFRAME_CLAIM_TTL_FLOOR_MS — the two repos drifted 5 minutes apart on when
// a holder is dead, over a claim on a SHARED document). A lease that expires
// while its generation is still in flight lets a second instance fire into a
// full cap; a lease that never expires wedges the pipeline after a crash.
//
// LIVE HOLDERS HEARTBEAT. acquire() used to stamp acquiredAt once and never
// refresh it, so a worker that acquired at T=0, spent 120s on the submit
// POST, then polled until T=600 (LEASE_TTL_MS) was stealable while still
// legitimately polling — a second worker could take the "free" slot and
// Google would see 9 in-flight against a hard cap of 8. The handle returned
// by acquire() now exposes heartbeat(), which $sets acquiredAt=now matching
// THIS acquisition's claimToken. generateForAd calls it on every poll tick.
// TTL is therefore how long a DEAD holder (no heartbeat) can sit before a
// steal, not a wall-clock budget a live generation has to finish inside.
// MEASURED submit→terminal: 46s / 60s / 80.6s, plus a ~95s file-PROCESSING
// tail; 10 minutes of silence is still ~4x the worst observed total, which
// is the right abandon window after the last heartbeat.
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

function rateEventsColl() {
  const conn = mongoose.connection;
  if (!conn || conn.readyState !== 1) return null;
  return conn.db.collection(RATE_EVENTS_COLLECTION);
}

// B7 FIX. The unique (scope, slot) index is WHAT MAKES THE OCCUPANCY RACE
// DECIDABLE — it is the sole reason two concurrent upserts against the same
// empty filter cannot both succeed. Without it, `findOneAndUpdate` with
// `upsert:true` has NO way to detect that another instance already inserted
// a document for this (scope, slot) an instant earlier: both calls can
// independently see "no match" and both insert, giving two live documents
// for the same slot with no duplicate-key error to catch it. The previous
// version of this function swallowed EVERY createIndex failure ("best-effort;
// contention still works without it") — that claim is false for the unique
// index specifically, and swallowing it is exactly the fail-OPEN shape this
// file exists to avoid: a permissions problem or a slow/unreachable index
// build would silently downgrade "provably capped at 8" to "hope nobody
// races." Returns false when the unique index cannot be confirmed so the
// caller can fail closed instead. The second index is pure query
// performance for the rate-window count and staying best-effort there is
// fine — a missing one only makes countDocuments slower, never wrong.
async function ensureIndexes() {
  const c = coll();
  if (!c) return false;
  try {
    await c.createIndex({ scope: 1, slot: 1 }, { unique: true });
  } catch {
    return false;
  }
  // The rate-event ledger needs no unique index (every acquisition is an
  // independent row) — a query-performance index and a storage-hygiene TTL
  // are both best-effort. Neither failing weakens correctness: the query
  // scans without the index if it's missing, and TTL is explicitly not a
  // correctness dependency (see RATE_EVENT_TTL_SECONDS above).
  const events = rateEventsColl();
  if (events) {
    try {
      await events.createIndex({ scope: 1, acquiredAt: 1 });
    } catch { /* pure performance index; best-effort is fine here */ }
    try {
      await events.createIndex({ acquiredAt: 1 }, { expireAfterSeconds: RATE_EVENT_TTL_SECONDS });
    } catch { /* storage hygiene only; best-effort is fine here */ }
  }
  return true;
}

/**
 * Acquire one slot for `scope` (provider:model). Returns a release handle, or
 * null when no slot is available — the caller MUST treat null as "do not
 * submit", never as "submit anyway".
 *
 * The occupancy write (a) is an atomic findOneAndUpdate on a unique
 * (scope, slot) pair: two instances racing the same slot means exactly one
 * wins, because the loser's upsert violates the unique index.
 *
 * The rate constraint (b) is answered from a SEPARATE append-only ledger
 * collection (RATE_EVENTS_COLLECTION), not from the occupancy documents —
 * see the B6 comment on that constant for why counting occupancy rows is
 * structurally wrong (a recycled slot overwrites its own prior timestamp
 * instead of adding a new one, so the count can never exceed MAX_SLOTS no
 * matter how many real acquisitions happened). The ledger is checked twice
 * — once optimistically before the occupancy write (cheap, fast-path
 * rejection) and once authoritatively after inserting our own event (the
 * actual safety argument, see the comment at that recheck). Every Mongo
 * touch in both constraints fails closed on error.
 */
async function acquire(scope) {
  const c = coll();
  const events = rateEventsColl();
  // FAIL CLOSED. No Mongo means we cannot prove we are under the cap, and the
  // downside of guessing wrong is a possibly-billed dead id, not a delay.
  if (!c || !events) return null;

  // B7 FIX. ensureIndexes() now reports whether the unique (scope, slot)
  // index — the thing that makes the occupancy race decidable at all — is
  // actually confirmed to exist. The old code discarded this signal
  // entirely (`await ensureIndexes();` with no return value used) and fell
  // through to grant leases regardless. FAIL CLOSED here instead: if we
  // cannot prove the invariant that makes concurrent acquisition safe, we
  // must not hand out a slot on the strength of an unproven assumption.
  const indexed = await ensureIndexes();
  if (!indexed) return null;

  const now = Date.now();
  const staleBefore = new Date(now - LEASE_TTL_MS);
  const windowStart = new Date(now - RATE_WINDOW_MS);

  // (b) RATE, pre-check: how many acquisitions landed in the ledger inside
  // the rolling window. Every past acquisition is its OWN row here, so a
  // slot that turned over 20 times in the last minute counts as 20, not 1.
  //
  // B7 FIX. This query used to run unguarded (against the occupancy
  // collection, before the B6 rewrite) — if countDocuments threw (a
  // missing/slow index, a connection blip, a query timeout), the exception
  // propagated straight out of acquire() instead of resolving to null. That
  // breaks the documented contract ("the caller MUST treat null as do not
  // submit") the moment Mongo is merely having trouble rather than fully
  // down, which is exactly the condition under which a fail-open gap is
  // most dangerous. Fail closed here the same way the findOneAndUpdate loop
  // below already does.
  let acquiredInWindow;
  try {
    acquiredInWindow = await events.countDocuments({
      scope,
      acquiredAt: { $gte: windowStart }
    });
  } catch {
    return null;
  }
  if (acquiredInWindow >= MAX_SLOTS) return null;

  // (a) OCCUPANCY: try each slot index; a slot is free if it has no row, its
  // row is released, or its row is older than the TTL (crashed holder).
  for (let slot = 0; slot < MAX_SLOTS; slot += 1) {
    let won = null;
    // B5 FIX. A per-ACQUISITION token, not just a worker id. See the release
    // closure below for why "just the worker id" is still not enough.
    const claimToken = `${now}-${crypto.randomBytes(9).toString('hex')}`;
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
            holder: process.env.ADGEN_WORKER_ID || `pid-${process.pid}`,
            claimToken
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
    if (!won) continue;

    // Record the acquisition in the ledger — this INSERT is the "submit"
    // constraint (b) actually counts, and unlike the occupancy write it is
    // NEVER overwritten by a later reacquisition of this same slot.
    let eventId;
    try {
      const ins = await events.insertOne({ scope, acquiredAt: new Date(now) });
      eventId = ins.insertedId;
    } catch {
      // Cannot prove the ledger recorded this acquisition — fail closed:
      // give back the occupancy slot we provisionally won and deny.
      try {
        await c.updateOne(
          { scope, slot, claimToken, releasedAt: null },
          { $set: { releasedAt: new Date() } }
        );
      } catch { /* best-effort rollback; the TTL is the backstop */ }
      return null;
    }

    // ── B6 FIX: RE-VERIFY THE RATE WINDOW AFTER THE INSERT, NOT JUST BEFORE ──
    //
    // The pre-check above is a plain read-then-decide: two concurrent
    // acquire() calls can both read `acquiredInWindow` UNDER the cap before
    // either has inserted its ledger row, then both win DIFFERENT occupancy
    // slots (that half is genuinely atomic, via the unique index) and both
    // insert — a lost-update race on the rate constraint even though
    // occupancy itself never double-books a slot.
    //
    // This recheck closes it WITHOUT needing a transaction, because of a
    // property of a single-primary database: writes apply in some total
    // order, and any read issued strictly after a given write is guaranteed
    // to observe every write that preceded it in that order (read-your-own-
    // writes plus causal ordering on one primary). So if N callers race for
    // the same cap, caller-in-order-k's post-insert read sees AT LEAST the
    // first k inserts (its own plus every writer that landed before it) —
    // never fewer, because unlike the occupancy documents these ledger rows
    // are never overwritten, only added. That means at most
    // (MAX_SLOTS - preexisting) callers can ever observe a post-insert count
    // that does not exceed the cap; anyone whose recheck sees more MUST be
    // exceeding it and rolls back. The system can be conservative (reject a
    // slot that a perfectly-ordered scheduler could have granted) but can
    // never UNDER-reject, which is the only direction that matters for a
    // money cap. See scripts/verifyGeminiVideoLease.js section B for the
    // executed proof.
    let acquiredInWindowAfter;
    try {
      acquiredInWindowAfter = await events.countDocuments({
        scope,
        acquiredAt: { $gte: windowStart }
      });
    } catch {
      // Cannot prove the cap held after our own insert landed. Fail closed:
      // treat this exactly like an overrun and roll back.
      acquiredInWindowAfter = Infinity;
    }
    if (acquiredInWindowAfter > MAX_SLOTS) {
      try { await events.deleteOne({ _id: eventId }); } catch { /* best-effort; TTL cleans it up regardless */ }
      try {
        await c.updateOne(
          { scope, slot, claimToken, releasedAt: null },
          { $set: { releasedAt: new Date() } }
        );
      } catch { /* best-effort rollback; the TTL is the backstop */ }
      return null;
    }

    let released = false;
    return {
      scope,
      slot,
      // Refresh acquiredAt so a live holder is never stealable mid-poll.
      // Matched by claimToken: a stolen-then-reacquired slot is a no-op
      // (the new holder's token differs), same argument as release().
      // Returns true when this acquisition still owns the row.
      heartbeat: async () => {
        if (released) return false;
        try {
          const res = await c.updateOne(
            { scope, slot, claimToken, releasedAt: null },
            { $set: { acquiredAt: new Date() } }
          );
          return !!(res && (res.matchedCount || res.modifiedCount));
        } catch {
          return false;
        }
      },
      release: async () => {
        if (released) return;
        released = true;
        try {
          // B5 FIX. Only clear OUR hold, matched by the claimToken minted
          // for THIS acquisition — not just `{ scope, slot, releasedAt: null }`.
          //
          // The old filter matched any live row for this (scope, slot),
          // regardless of who currently holds it. Concretely: worker A
          // acquires slot 3, then stalls (GC pause, a slow Remotion render,
          // a hung network call) past LEASE_TTL_MS while never actually
          // crashing. Worker B's acquire() correctly sees slot 3 as stale
          // and steals it — a NEW document generation, same (scope, slot),
          // with B's holder/claimToken and releasedAt:null again. When A
          // FINALLY reaches its `finally { slot.release() }`, the old
          // filter `{ scope, slot, releasedAt: null }` still matches B's
          // now-active row (releasedAt is null again after the steal) and
          // sets releasedAt on it — releasing B's slot out from under B
          // while B's generation is still in flight. A third worker can
          // then acquire that "free" slot while B is still using it: two
          // workers holding what the system believes is one slot, which is
          // exactly the double-booking this whole file exists to prevent.
          //
          // Scoping on claimToken closes this: after the steal, B's row's
          // claimToken differs from the one A's closure captured, so A's
          // release matches ZERO documents and is a safe no-op. B's own
          // (correct) release later matches its own claimToken normally.
          await c.updateOne(
            { scope, slot, claimToken, releasedAt: null },
            { $set: { releasedAt: new Date() } }
          );
        } catch { /* release is best-effort; the TTL is the backstop */ }
        // The RATE LEDGER ROW IS DELIBERATELY NOT TOUCHED HERE. Constraint
        // (b) is about SUBMITS per window, not occupancy — an acquisition
        // that finishes and releases in 5s must still count toward the rate
        // cap for the rest of the 60s window, exactly like a slow one would.
        // Deleting it on release would reopen the same hole this file fixes:
        // fast turnover would let the ledger "forget" a submit the instant
        // its slot frees up. The TTL index is the only thing that ever
        // removes it, once it has aged out of every possible window anyway.
      }
    };
  }
  return null;
}

module.exports = {
  acquire,
  MAX_SLOTS,
  RATE_WINDOW_MS,
  LEASE_TTL_MS,
  COLLECTION,
  RATE_EVENTS_COLLECTION
};
