'use strict';
//
// DISTRIBUTED SINGLETON LEASE — adgen-native, modelled on backend
// services/singletonLease.js but NOT a port of it.
//
// Problem this closes: the orchestrator (and later any other singleton
// station) must run on exactly one instance at a time. Adgen's static
// identity digests are run-scoped and the (campaignId, identityDigest)
// unique index only protects the video side, so two concurrent expanders
// mint two separate, uncaught sets of billable static ads. That is the
// single failure this lease exists to prevent.
//
// Shape: one Mongo doc per named lease (collection singleton_leases,
// shared with backend — different NAMES, so no cross-service collision;
// see models/SingletonLease.js). `holder` is an INSTANCE-UNIQUE key — see
// deriveHolderId / PROCESS_NONCE below, and do NOT reduce it to
// config.WORKER_ID, which is pinnable and caused a measured two-holder
// bug. `expiresAt` is when the lease auto-releases if the holder crashes.
// Renewal happens
// on every heartbeat (safer than counting on graceful shutdown, which
// Render's SIGTERM does not always give).
//
// Usage:
//   const lease = createSingletonLease('adgen-expand', {
//     ttlMs: 90_000, heartbeatMs: 30_000, onLost(reason) { /* stop work */ }
//   });
//   const acquired = await lease.acquire();   // true if this instance holds it now
//   if (acquired) lease.startHeartbeat();     // renew every heartbeatMs
//   // ...run the singleton work, gated on lease.holds()...
//   await lease.release();                    // optional; expiresAt handles crash
//
// ── WHY THE ACQUIRE PIPELINE DEVIATES FROM BACKEND'S PLAIN-FILTER FORM ──
// Backend derives both `now` and the new `expiresAt` from the CALLING
// PROCESS's Date.now():
//
//   filter: { _id, $or: [{ expiresAt: { $lt: now } }, { holder: ME }] }
//   update: { holder: ME, expiresAt: now + ttlMs }
//
// That is atomic against a racer, but it assumes every process's wall
// clock agrees. A process whose clock runs S seconds fast sees a live
// lease as expiring S seconds early; once S >= ttlMs it steals a healthy
// holder's lease immediately and permanently — TWO HOLDERS COEXISTING,
// which is the failure above. $$NOW makes mongod's clock the sole
// authority, so inter-process skew cannot matter.
//
// $literal around the holder id is load-bearing: the readable half of the
// id comes from RENDER_INSTANCE_ID / ADGEN_WORKER_ID, both operator-
// supplied, and a value starting with `$` would otherwise be read as a
// field path — matching a document field that does not exist instead of
// this process. Do not "simplify" it to a bare string.
//
// Do not switch this back to a plain filter "because backend does it
// that way" or "because the pipeline is harder to read." The pipeline
// is the product.
//
// ── VERIFIED LIVE AGAINST MONGODB 7 (measured, not reasoned) ────────────
//   • 12 concurrent acquire() calls on a FRESH doc → exactly 1 winner,
//     0 duplicate-key errors surfaced.
//   • 12 concurrent calls on an EXPIRED doc → exactly 1 winner and
//     fenceToken incremented exactly once (7→8).
//   • $$NOW is server-side (9ms from the client clock on a local mongod).
//   • a renew scoped { _id, holder: <not me> } returns null.
//
// The 11000 catch on acquire is still required: concurrent upserts of a
// not-yet-existing _id are documented to surface DuplicateKey, even
// though this 12-way race did not trip it (findAndModify retries
// internally). Do not delete the catch because a race test was clean.
//
// ── WHAT ELSE THIS FILE CLOSES THAT BACKEND'S COPY DOES NOT ─────────────
// Backend's heartbeat, on a null renew, logs and KEEPS TICKING. The
// losing process still does singleton work. That is the coexisting-
// holder bug with a log line on it. Here a null renew is local loss:
// holds→false, timer stopped, onLost(reason) so the caller actually
// stands down.
//
// If renewals keep THROWING (Mongo unreachable / partition), the doc
// still expires server-side and a peer takes over while this process
// would keep believing it holds. We track the last SUCCESSFUL renewal
// on a monotonic clock (process.hrtime.bigint() — a wall-clock NTP
// step must not be able to extend the window) and once elapsed >= ttlMs
// we declare the lease locally lost. This is one process measuring its
// own elapsed time, so it is NOT a cross-process skew assumption.
//
// fenceToken is exposed and deliberately unconsumed today. It exists so
// the next PR can condition expansion writes on "still the same lease
// generation", making a stale holder's write detectable rather than
// merely improbable. Do not delete it as dead.

// ⚠️ THESE DEFAULTS ARE SAFE ONLY BECAUSE THIS LEASE HEARTBEATS.
// DO NOT PORT THEM ONTO A CLAIM THAT DOES NOT.
//
// A 90s TTL is short enough to be attractive as a repo-wide standard, and
// this file is the thing that makes it look portable. It is not, on its own.
// The 90s only works here because startHeartbeat() refreshes expiresAt every
// 30s, so a live holder is distinguishable from a dead one.
//
// The counter-example is in this same repo: regenerateConsumer.js's per-Ad
// claim (`Ad.regenerateClaimedByWorker` / `regenerateClaimedAt`) has NO
// heartbeat, deliberately — regenerateClaimedAt is stamped once at claim time
// and stays frozen for the whole flight, so an in-progress video regenerate
// looks EXACTLY as old as a crashed one. It compensates with a much larger
// threshold, floored (not merely defaulted) at
// `max(ceil(ATLAS_TIMEOUT_MS/60000) + 10, ADGEN_REGEN_CLAIM_STALE_MIN || 45)`
// minutes, so raising ATLAS_TIMEOUT_MS raises the floor with it and an
// operator cannot turn the knob down into a money bug.
//
// So: unifying that claim onto this 90s/30s model requires wiring a heartbeat
// into the regenerate flight path FIRST. The heartbeat and the shorter TTL
// land together or not at all — neither half is safe alone. Shortening the
// threshold without a heartbeat steals every in-flight video regenerate
// mid-generation and resubmits it, and adRegenerateService.runVideoFull
// passes allowResume:false to generateForAd on purpose (an operator
// regenerate always wants a FRESH video), so the reclaim is a genuine second
// billable Omni submit, not a resumed poll. MAX_RECLAIMS (default 2, checked
// before any provider call) caps the blast radius but does not remove it.
//
// Note the config knob CANNOT reach the dangerous value on its own — the
// Math.max floor blocks it — so this is a code-review hazard, not a
// config-drift one. Guard it in review: do not remove that floor.
const DEFAULT_TTL_MS       = 90_000;
const DEFAULT_HEARTBEAT_MS = 30_000;
// Backend's ratio is 30s/90s = 3 beats per TTL. Require at least 3 so a
// holder can miss two consecutive heartbeats (Mongo blip, GC pause, a
// delayed setInterval — which is not a metronome) and the third still
// lands before expiry. A ratio of 2 means missing one beat expires you
// under yourself. A ratio of 1 IS the coexisting-holder bug: any late
// interval firing lets a peer steal while this process still holds()
// true and keeps minting. Throw at construction; do not "tune" below
// this in env to make a demo fail over faster.
const MIN_BEATS_PER_TTL = 3;
// The ratio alone is not enough — it is scale-free. `ttlMs:30,
// heartbeatMs:10` is exactly 3 beats and passes, yet a 40ms event-loop
// delay (trivial: one GC pause, one sync fs call, one big JSON.parse)
// expires the row under a live holder, a peer takes it, and this process
// keeps holds()===true until its next tick. So the TTL also needs an
// absolute floor comfortably above any pause this process can realistically
// take. 15s against a 90s default leaves plenty of room to tune down
// without reaching a value that is unsafe in principle.
//
// SKIPPED when opts.model is injected — that is the harness, which must be
// able to drive 400ms TTLs deterministically without real sleeps. Gating on
// the model seam (rather than a NODE_ENV sniff) keeps the escape hatch tied
// to something only a test can supply.
const MIN_TTL_MS_PRODUCTION = 15_000;
const NS_PER_MS = 1_000_000n;

const crypto = require('crypto');

// ⚠️ THE EXCLUSIVITY KEY MUST BE INSTANCE-UNIQUE. DO NOT REPLACE THIS WITH
// config.WORKER_ID.
//
// MEASURED against real MongoDB 7 (2026-08-26), two holders, deterministically:
// `src/config.js` derives WORKER_ID as `process.env.ADGEN_WORKER_ID || <random>`
// and its own comment invites an operator to pin it ("operator-supplied for
// pinning"). A Render service's env vars are shared by every instance of that
// service, so a pinned ADGEN_WORKER_ID gives two instances the SAME holder
// string. The acquire pipeline's self-renew arm (`$eq: ['$holder', me]`) then
// reads the OTHER instance's live, unexpired row as "already mine" — so the
// second instance wins too, both startHeartbeat(), both extend the same row,
// and fenceToken never bumps because it is not scored as a takeover. No expiry
// race, no 11000, no null renew: nothing anywhere notices. With expansion
// wired that is two uncaught sets of billable static ads, during a rolling
// deploy — the exact moment this lease is supposed to earn its keep.
//
// WORKER_ID is claim-TRACING identity (it is stamped on Ad.claimedByWorker so
// a human can grep ownership). Reusing it as a mutual-exclusion key conflates
// "who to blame" with "who is unique". Backend got this right by keying on
// RENDER_INSTANCE_ID / pid+random (liquidretail_backend/services/singletonLease.js:37-38).
//
// One nonce per PROCESS, computed once at require time. Uniqueness therefore
// does not depend on any env var being present or correctly configured — even
// with RENDER_INSTANCE_ID absent AND ADGEN_WORKER_ID pinned, two processes get
// two keys. The readable prefix is kept so logs stay greppable.
const PROCESS_NONCE = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

// Per-lease-object counter ON TOP of the process nonce. Cross-process
// uniqueness comes from PROCESS_NONCE; this closes the remaining footgun of
// two createSingletonLease() calls with the SAME name inside ONE process,
// which under a process-wide key would both read the other's row as a
// self-renew and both "hold" — the same shape as the pinned-WORKER_ID bug,
// one scope down. Backend's copy is process-wide and has this hole; it is
// unreachable in adgen's current wiring (the orchestrator builds one lease)
// but costs one integer to remove, and "unreachable today" is how the
// pinned-id bug got written in the first place.
let leaseSeq = 0;

/**
 * Pure so it can be tested without src/config.js's module-level process.exit.
 * `label` is for humans; `nonce` is what actually guarantees exclusivity.
 */
function deriveHolderId({ workerId, renderInstanceId, nonce } = {}) {
  const label = renderInstanceId || workerId || 'adgen';
  return `${label}:${nonce || PROCESS_NONCE}`;
}

function resolvePositiveInt(override, envVal, fallback, label) {
  const raw = override != null ? override : envVal;
  if (raw == null || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`createSingletonLease: ${label} must be a positive integer (got ${JSON.stringify(raw)})`);
  }
  return n;
}

function isDupKey(err) {
  // Mongoose 8 usually puts 11000 on err.code; some wrapped paths put it
  // on err.cause. Either is "someone else won the insert."
  return !!(err && (err.code === 11000 || (err.cause && err.cause.code === 11000)));
}

/**
 * THE acquire payload. Live acquire() calls this; a harness drives the
 * same object with no DB. Do not reconstruct the pipeline at the call
 * site — that is how the next editor "simplifies" $$NOW back to Date.now().
 *
 * @returns {{ filter: object, pipeline: object[], options: object }}
 */
function buildAcquirePipeline({ name, holder, ttlMs }) {
  // $literal is load-bearing — see file header. A worker id starting
  // with `$` is otherwise a field path, and the lease would match on
  // a document field that does not exist rather than on this process.
  const me = { $literal: holder };

  // Takeable: unheld, already ours (self-renew via acquire), or expired
  // per mongod's clock. The Date(0) fallback is a CONSTANT (epoch), not
  // "now" — a missing expiresAt on a half-written row is treated as
  // already expired so we cannot wedge on a doc with no expiry.
  const takeable = {
    $or: [
      { $eq: [{ $ifNull: ['$holder', null] }, null] },
      { $eq: ['$holder', me] },
      { $lt: [{ $ifNull: ['$expiresAt', new Date(0)] }, '$$NOW'] }
    ]
  };

  // Takeover: takeable AND the current holder is not us. First acquire
  // on a fresh doc is a takeover (null !== ME), so fenceToken goes 0→1
  // and acquiredAt is stamped. Self-renew is takeable but NOT takeover,
  // so fenceToken and acquiredAt are preserved. That is what made the
  // expired-doc 12-way race increment 7→8 exactly once.
  const takeover = {
    $and: [
      takeable,
      { $ne: [{ $ifNull: ['$holder', null] }, me] }
    ]
  };

  return {
    filter: { _id: name },
    pipeline: [{
      $set: {
        holder:     { $cond: [takeable, me, '$holder'] },
        expiresAt:  { $cond: [takeable, { $add: ['$$NOW', ttlMs] }, '$expiresAt'] },
        acquiredAt: { $cond: [takeover, '$$NOW', { $ifNull: ['$acquiredAt', '$$NOW'] }] },
        fenceToken: {
          $cond: [
            takeover,
            { $add: [{ $ifNull: ['$fenceToken', 0] }, 1] },
            { $ifNull: ['$fenceToken', 0] }
          ]
        }
      }
    }],
    // upsert:true is what creates the row on first acquire. Do NOT add
    // setDefaultsOnInsert — MongoDB rejects combining it with an
    // aggregation-pipeline update. new:true so the caller can read
    // res.holder and res.fenceToken off the post-image.
    options: { upsert: true, new: true }
  };
}

// Holder-scoped on purpose: a renew for a holder we are not must not
// extend a peer's lease. Measured: scoped { _id, holder: <not me> }
// returns null.
function buildRenewFilter({ name, holder }) {
  return { _id: name, holder };
}

// Pipeline form is required: $$NOW is an aggregation variable and is
// NOT evaluated in a query-style $set. Flattening this to
// `{ $set: { expiresAt: new Date(Date.now() + ttlMs) } }` reintroduces
// the client-clock skew bug the acquire pipeline exists to close.
function buildRenewUpdate({ ttlMs }) {
  return [{ $set: { expiresAt: { $add: ['$$NOW', ttlMs] } } }];
}

// Holder-scoped filter is what stops a LATE release from clobbering a
// peer that already took over. Without the holder predicate, a SIGTERM
// that lands after we have already lost would $set holder:null on the
// new holder's row and the peer would drop out from under itself.
function buildReleaseFilter({ name, holder }) {
  return { _id: name, holder };
}

function buildReleaseUpdate() {
  // Epoch, not $$NOW: we want the doc immediately takeable, not
  // "expires in 0ms from mongod's clock which a racer might still
  // see as now". holder:null so a stale name does not linger (backend
  // only epoch-expires and leaves the dead id on the row).
  return { $set: { holder: null, expiresAt: new Date(0) } };
}

/**
 * @param {string} name  lease _id. Must NOT collide with backend names
 *   (today backend uses exactly one: 'worker-housekeeping', per
 *   liquidretail_backend/worker.js:250-254). Empty string is rejected,
 *   not coerced.
 * @param {object} [opts]
 * @param {number} [opts.ttlMs]         default ADGEN_LEASE_TTL_MS || 90000
 * @param {number} [opts.heartbeatMs]   default ADGEN_LEASE_HEARTBEAT_MS || 30000
 * @param {function} [opts.onLost]      called with a reason string on
 *   involuntary loss. NOT called on voluntary release.
 * @param {object} [opts.model]         injectable; defaults to the real
 *   SingletonLease model. Same seam campaignRunHeartbeat.js uses so a
 *   harness drives the real payloads with no DB.
 * @param {string} [opts.holder]        test-only override of WORKER_ID.
 *   Production callers omit this. Avoids src/config.js's process.exit
 *   on a missing ADGEN_ROLE when a harness constructs a lease.
 */
function createSingletonLease(name, opts = {}) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('createSingletonLease: name must be a non-empty string (the lease _id)');
  }

  const ttlMs = resolvePositiveInt(
    opts.ttlMs, process.env.ADGEN_LEASE_TTL_MS, DEFAULT_TTL_MS, 'ttlMs / ADGEN_LEASE_TTL_MS'
  );
  const heartbeatMs = resolvePositiveInt(
    opts.heartbeatMs, process.env.ADGEN_LEASE_HEARTBEAT_MS, DEFAULT_HEARTBEAT_MS,
    'heartbeatMs / ADGEN_LEASE_HEARTBEAT_MS'
  );

  const beats = ttlMs / heartbeatMs;
  if (beats < MIN_BEATS_PER_TTL) {
    throw new Error(
      `createSingletonLease[${name}]: heartbeatMs=${heartbeatMs} vs ttlMs=${ttlMs} ` +
      `gives ${beats.toFixed(2)} beats per TTL; need >= ${MIN_BEATS_PER_TTL}. ` +
      `A pair this wide lets the lease expire under its own holder (a delayed ` +
      `setInterval tick lands after expiresAt, a peer steals, two expanders ` +
      `mint two uncaught sets of billable static ads). Backend's ratio is ` +
      `30s/90s = 3; do not 'tune' below that.`
    );
  }

  // Absolute floor, not just the ratio. See MIN_TTL_MS_PRODUCTION.
  const injectedModel = opts.model || null;
  if (!injectedModel && ttlMs < MIN_TTL_MS_PRODUCTION) {
    throw new Error(
      `createSingletonLease[${name}]: ttlMs=${ttlMs} is below the production floor ` +
      `of ${MIN_TTL_MS_PRODUCTION}ms. The ${MIN_BEATS_PER_TTL}-beat ratio is scale-free, ` +
      `so a pair like 30/10 passes it while a single 40ms event-loop pause still ` +
      `expires the lease under its own live holder — a peer takes over and two ` +
      `expanders mint two uncaught sets of billable static ads. Raise ttlMs, or ` +
      `inject opts.model if this is a harness.`
    );
  }

  // opts.holderId is a TEST SEAM, and it is load-bearing for the harness:
  // two createSingletonLease() calls in one process must be two DISTINCT
  // holders, or every "race" is really a self-acquire and the exclusion
  // property is never actually exercised. Backend's copy uses a process-
  // global INSTANCE_ID, which is exactly why its shape cannot be
  // race-tested in-process. Production callers omit this and get
  // WORKER_ID. Required lazily so a harness constructing a lease does not
  // trip src/config.js's process.exit on a missing ADGEN_ROLE.
  // NOT config.WORKER_ID directly — see PROCESS_NONCE / deriveHolderId above
  // for the measured two-holder bug that shortcut causes.
  leaseSeq += 1;
  // opts.workerId is a TEST SEAM for the LABEL half only. It exists so a
  // harness can exercise this real derivation path — the factory's actual
  // ME assignment — without loading src/config.js (whose module-level dotenv
  // require is unavailable in a bare worktree, and which process.exit()s on
  // a missing ADGEN_ROLE). Without it, a case could only test deriveHolderId
  // in isolation and would stay green if someone reverted THIS line to a
  // bare config.WORKER_ID, which is precisely the measured two-holder bug.
  const ME = opts.holderId || deriveHolderId({
    workerId: opts.workerId || require('../config').WORKER_ID,
    renderInstanceId: process.env.RENDER_INSTANCE_ID,
    nonce: `${PROCESS_NONCE}-${leaseSeq}`
  });
  const Lease = injectedModel || require('../models/SingletonLease');
  const onLost = typeof opts.onLost === 'function' ? opts.onLost : null;

  // MONOTONIC clock for the self-expiry check, injectable as opts.nowMs
  // (a () => number of milliseconds). Default is process.hrtime.bigint()
  // reduced to ms — deliberately NOT Date.now(): an NTP step backwards
  // would otherwise extend the window in which this process still
  // believes it holds a lease that has already expired server-side, and
  // that window is precisely when a peer is minting. Sub-ms precision is
  // irrelevant here (we compare against a TTL measured in tens of
  // seconds). The seam exists because R8 must drive self-expiry without a
  // real sleep — the verify suite runs harnesses in parallel and must not
  // depend on real timer margins.
  // Honoured ONLY alongside an injected model, i.e. in a harness. If a
  // production caller passed a wall-clock nowMs (Date.now), an NTP step
  // backwards would extend the window in which this process still believes
  // it holds a lease that already expired server-side — and that window is
  // exactly when a peer is minting. Tying the two seams together means
  // production cannot half-use them.
  const monotonicMs = (typeof opts.nowMs === 'function' && injectedModel)
    ? opts.nowMs
    : () => Number(process.hrtime.bigint() / NS_PER_MS);

  let currentlyHolds = false;
  let currentFenceToken = null;
  let lastSuccessMs = null;       // monotonicMs(); null ⇔ never successfully written
  let heartbeatTimer = null;
  let inFlight = false;
  // Local in-process generation of the HEARTBEAT, not fenceToken. A hung
  // renew overlapping a re-acquire would otherwise pin inFlight true and
  // starve the new holder's beats, or a hung success would resurrect
  // currentlyHolds after declareLost. Bumped on every local loss/release.
  let leaseGen = 0;

  function stopHeartbeat() {
    if (!heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  function invokeOnLost(reason) {
    if (!onLost) return;
    try {
      onLost(reason);
    } catch (err) {
      console.warn(`singletonLease[${name}]: onLost('${reason}') threw — ${err.message}`);
    }
  }

  function declareLost(reason) {
    const wasHolding = currentlyHolds;
    currentlyHolds = false;
    lastSuccessMs = null;
    currentFenceToken = null;
    leaseGen += 1;
    inFlight = false;
    stopHeartbeat();
    // Losing is normal; log AT MOST once per transition. A poll loop
    // that loses every tick must not warn every tick.
    if (!wasHolding) return;
    console.warn(`singletonLease[${name}]: lost (${reason}) holder=${ME}`);
    invokeOnLost(reason);
  }

  function selfExpired() {
    if (!currentlyHolds) return false;
    // No successful write since we decided we hold — fail closed. This
    // is one process measuring its own elapsed time (hrtime, not
    // Date.now()), so it is NOT a cross-process skew assumption. NTP
    // stepping the wall clock cannot extend the window.
    if (lastSuccessMs == null) return true;
    return monotonicMs() - lastSuccessMs >= ttlMs;
  }

  async function acquire() {
    // Same generation discipline renewOnce() uses, and for the same reason:
    // this await can outlive the state it was started under. MEASURED
    // (scratch probe, 2026-08-26): SIGTERM landing while an acquire is in
    // flight had release() run first — it saw currentlyHolds===false and
    // wrote NOTHING — and then the acquire resolved, won, and set
    // currentlyHolds=true on a process about to call process.exit(0). The
    // lease doc was left held by a dead instance with no release write ever
    // issued, so a replacement instance had to wait out the whole ttlMs
    // (90s default) before it could expand. Not a double-mint — only one
    // holder — but a self-inflicted failover delay on every deploy that
    // happens to land in this window, which is exactly the
    // instance-replacement case the lease exists to make smooth.
    const gen = leaseGen;
    const { filter, pipeline, options } = buildAcquirePipeline({ name, holder: ME, ttlMs });
    try {
      const res = await Lease.findOneAndUpdate(filter, pipeline, options);
      const won = !!(res && res.holder === ME);
      if (won && leaseGen !== gen) {
        // release() (shutdown) or declareLost() ran while we were in
        // flight. Nobody is going to use this lease, so hand it straight
        // back instead of sitting on it until expiry. The write is
        // holder-scoped, so if a peer somehow already took it from us this
        // is a no-op rather than a clobber. Report a LOSS: the caller must
        // not start singleton work off the back of this call.
        await writeRelease();
        return false;
      }
      if (won) {
        const wasHolding = currentlyHolds;
        currentlyHolds = true;
        currentFenceToken = res.fenceToken;
        lastSuccessMs = monotonicMs();
        if (!wasHolding) {
          console.log(
            `singletonLease[${name}]: acquired holder=${ME} fenceToken=${currentFenceToken}`
          );
        }
        return true;
      }
      // We thought we held; the post-image says we do not. Stand down.
      // A first-try miss (the normal poll-until-win case) is silent.
      if (currentlyHolds) declareLost('lost');
      return false;
    } catch (err) {
      // Concurrent upserts on a not-yet-existing doc can surface 11000.
      // Measured: it did NOT surface in a 12-way race (findAndModify
      // retries internally), but it is documented behaviour and the
      // catch must stay. Losing is normal — return false, do not warn.
      if (isDupKey(err)) return false;
      console.warn(`singletonLease[${name}]: acquire failed — ${err.message}`);
      return false;
    }
  }

  async function renewOnce() {
    const gen = leaseGen;
    try {
      const res = await Lease.findOneAndUpdate(
        buildRenewFilter({ name, holder: ME }),
        buildRenewUpdate({ ttlMs }),
        { new: true }
      );
      if (leaseGen !== gen) return;          // lost/released while this write was in flight
      if (!res) {
        // Null = this process LOST the lease. Backend only logs and
        // keeps ticking, which leaves the losing process still doing
        // singleton work — that is the coexisting-holder bug. Stand
        // down: holds→false, timer stopped, onLost so the caller
        // actually stops minting.
        if (currentlyHolds) declareLost('lost');
        else stopHeartbeat();
        return;
      }
      if (!currentlyHolds) return;
      lastSuccessMs = monotonicMs();
    } catch (err) {
      if (leaseGen !== gen) return;
      console.warn(`singletonLease[${name}]: renew failed — ${err.message}`);
      // Throws (Mongo unreachable / partition) do NOT mean we lost on
      // the server — the doc is still ours until expiresAt. But if we
      // have not successfully renewed within ttlMs of real elapsed
      // time, a peer has either already taken over or is about to, and
      // we must stop believing we hold. See file header.
      if (selfExpired()) declareLost('renewal-timeout');
    }
  }

  async function heartbeatTick() {
    // Self-expiry FIRST, even when a renew is in flight. A hung
    // findOneAndUpdate that never returns would otherwise pin inFlight
    // and never reach the elapsed check — which is the partition case
    // this guard exists for.
    if (selfExpired()) {
      declareLost('renewal-timeout');
      return;
    }
    if (inFlight) return;                    // non-overlapping: setInterval re-enters if renew > heartbeatMs
    inFlight = true;
    const gen = leaseGen;
    try {
      await renewOnce();
    } finally {
      // Only clear the flag if we are still the same local generation;
      // a hung renew's finally must not unpin a NEW holder's in-flight.
      if (leaseGen === gen) inFlight = false;
    }
  }

  function startHeartbeat() {
    if (heartbeatTimer) return;              // idempotent
    if (!currentlyHolds) return;             // acquire first; a timer without a hold is a miss-loop
    // RETURN the promise, do not drop it. setInterval ignores a callback's
    // return value, so this is free in production — but it makes a single
    // tick awaitable, which is what lets the harness assert on the state
    // AFTER the renew resolves instead of racing its microtasks. Dropping
    // it (the obvious `() => { heartbeatTick().catch(...) }`) made R6 read
    // holds()===true because the assertion ran before the await inside
    // renewOnce() had resumed. Do not "tidy" the return away.
    heartbeatTimer = setInterval(() => heartbeatTick().catch((err) => {
      console.warn(`singletonLease[${name}]: heartbeat tick threw — ${err.message}`);
    }), heartbeatMs);
    // Never hold the process open on a heartbeat. Same unref posture as
    // regenerateConsumer.js and campaignRunHeartbeat.js.
    if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
  }

  // THE release write, shared by release() and by acquire()'s hand-back
  // path below. Holder-scoped, so a peer that already took over is never
  // clobbered by a late write from us (see buildReleaseFilter). Never
  // throws — best-effort, backend's posture: the row expires server-side
  // even if this write fails, and we have already stood down locally.
  async function writeRelease() {
    try {
      await Lease.updateOne(
        buildReleaseFilter({ name, holder: ME }),
        buildReleaseUpdate()
      );
    } catch (err) {
      console.warn(`singletonLease[${name}]: release failed — ${err.message}`);
    }
  }

  async function release() {
    stopHeartbeat();
    leaseGen += 1;
    inFlight = false;
    if (!currentlyHolds) return;             // idempotent; never throws
    currentlyHolds = false;
    lastSuccessMs = null;
    currentFenceToken = null;
    await writeRelease();
  }

  function holds() { return currentlyHolds; }
  function fenceToken() { return currentFenceToken; }

  return {
    acquire,
    startHeartbeat,
    release,
    holds,
    fenceToken,
    name,
    holderId: ME
  };
}

module.exports = {
  DEFAULT_TTL_MS,
  deriveHolderId,
  PROCESS_NONCE,
  DEFAULT_HEARTBEAT_MS,
  MIN_BEATS_PER_TTL,
  createSingletonLease,
  buildAcquirePipeline,
  buildRenewFilter,
  buildRenewUpdate,
  buildReleaseFilter,
  buildReleaseUpdate
};
