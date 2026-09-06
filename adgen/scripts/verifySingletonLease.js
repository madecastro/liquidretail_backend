#!/usr/bin/env node
'use strict';
//
// verifySingletonLease — THE MONEY CHECK for the orchestrator singleton.
//
// Two concurrent expanders that both believe they hold `orchestrator` will
// mint two separate sets of BILLABLE static ads. Static identity digests are
// run-scoped, so nothing downstream catches the duplicate (video would; static
// will not). This harness is the artefact that has to go red before that
// happens, not a source-text scan and not a stub that "looks like Mongo".
//
// WHAT EACH CLASS DEFENDS
//   R1 / R1b  Concurrent acquire: exactly one winner. A JS early-return that
//             yields false without querying would look like a lost race but
//             would not serialise two processes — we require findOneAndUpdate
//             to have actually run (call count ≥ N racers).
//   R2 / R2b  An unexpired holder is exclusive; a self-acquire is a renew
//             (extends expiresAt) not a takeover (fenceToken / acquiredAt
//             stay put). Losing attempts must not refresh expiresAt.
//   R3 / R3b  Expiry is the ONLY legitimate takeover, and a takeover-storm
//             (instance replacement waking N orchestrators) still increments
//             fenceToken exactly once.
//   R4        release() is immediate (holder:null arm of takeable), not a
//             "wait for TTL" polite drop.
//   R5        A live heartbeat keeps the lease through the TTL window — the
//             whole point of renewing.
//   R6        Renew is holder-scoped: a non-holder's heartbeat matches
//             nothing and is a loss, not a refresh of someone else's row.
//   R7        STALE-RELEASE-CLOBBERS-PEER: after A expires and B takes over,
//             A's delayed release must not wipe B. Without the holder:ME
//             filter this is a silent split-brain.
//   R8        Self-expiry: if renewals keep THROWING, the process still
//             stops believing it holds once ttlMs has passed since the last
//             successful renew. Otherwise a partitioned holder mints forever.
//   R9        $lt, not $lte. expiresAt === $$NOW is still held. A later
//             "fix" to $lte would make two racers at the exact boundary
//             both takeable.
//   R10       Upsert E11000 is a lost race, not a crash.
//   R11       onLost fires once; the interval is cleared. A tick-storm of
//             onLost handlers is how a flapping expander gets reaped and
//             immediately re-launched into another storm.
//   R12       Fewer than 3 beats/TTL is a construction error (a 90s TTL
//             with a 60s beat is one missed heartbeat from a split-brain).
//   R13       Shutdown races an in-flight acquire: a win that lands AFTER
//             release() must be handed straight back, or the doc stays held
//             by a dead instance for a full TTL and a replacement cannot
//             expand. Found by execution, not by reading.
//   R14 /     The exclusivity key must be INSTANCE-UNIQUE and must never be
//   R14b      a dashboard-pinnable string. A pinned ADGEN_WORKER_ID is shared
//             by every instance of a Render service, and the pipeline's
//             self-renew arm then reads a peer's live row as "already mine"
//             — two holders, no fence bump, nothing notices. R14 covers the
//             derivation; R14b covers the FACTORY, which R14 alone would let
//             regress to a bare config.WORKER_ID.
//   R15       The 3-beat ratio is scale-free (30/10 passes), so ttlMs also
//             needs an absolute production floor. Raised by adversarial
//             review; the mutation run then proved nothing covered it.
//   S1        The acquire/renew payloads themselves carry '$$NOW' and no
//             client Date except the epoch sentinel. Walking the live object
//             (NOT JSON.stringify — that would hide Date as an ISO string,
//             and NOT a source-text regex).
//
// TWO BACKENDS, ONE ASSERTION SET
//   1. Offline stub (default; what `runVerifySuite` runs). An in-memory
//      collection whose findOneAndUpdate actually evaluates the aggregation
//      pipeline the production module emits. $$NOW is an injectable clock
//      the harness advances by hand — no real sleeps, so this is safe under
//      runVerifySuite's parallel workers.
//   2. Real MongoDB, opt-in via LEASE_VERIFY_MONGODB_URI. Same cases, real
//      mongoose + real SingletonLease model, scratch DB dropped afterwards.
//      THIS ARM IS WHAT PROVES THE OFFLINE STUB IS NOT LYING ABOUT MONGOD.
//      Simulated-clock cases become short real TTLs (400ms) and a few short
//      awaits; $$NOW is mongod's clock and cannot be injected.
//
// WHY A STUB THAT SILENTLY NO-MATCHES IS WORSE THAN A RED HARNESS
//   Every exclusion case (R2, R5, R6, R7, R9-equal) is green if the stub
//   doesn't understand the operator and returns null. Two expanders would
//   then mint two billable static sets in production and this file would
//   still print ✅. Unknown operators THROW. Extend the evaluator
//   deliberately when the pipeline grows; do not "just make it match".
//
// miniMongoStub.js is intentionally NOT used and MUST NOT be mutated —
// it has no pipeline / $$NOW support and other harnesses depend on it.
//
// Required seams on src/services/singletonLease.js (see trailing prose):
//   opts.model, opts.holderId, opts.nowMs; lazy mongoose require.
//
// Pure + offline by default: no DB, no network, no mongoose.
//   node scripts/verifySingletonLease.js
//   LEASE_VERIFY_MONGODB_URI='mongodb://127.0.0.1:27017' node scripts/verifySingletonLease.js

const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Capture real timers BEFORE faking setInterval, and BEFORE requiring the
// SUT, so a load-time `const { setInterval } = global` still sees the fake
// (and so mongo-arm sleeps can use an unfaked setTimeout).
const realSetTimeout = global.setTimeout.bind(global);
const realSetInterval = global.setInterval.bind(global);
const realClearInterval = global.clearInterval.bind(global);

function installFakeTimers() {
  const byRef = new Map();
  let seq = 1;
  let last = null;
  global.setInterval = function fakeSetInterval(fn, ms) {
    const handle = {
      id: seq++,
      fn,
      ms,
      cleared: false,
      unref() { return this; },
      ref() { return this; }
    };
    byRef.set(handle, handle);
    byRef.set(handle.id, handle);
    last = handle;
    return handle;
  };
  global.clearInterval = function fakeClearInterval(handle) {
    if (handle == null) return;
    const h = byRef.get(handle) || (handle && byRef.get(handle.id));
    if (!h) return;
    h.cleared = true;
    byRef.delete(h);
    byRef.delete(h.id);
  };
  return {
    last() { return last; },
    async tick(handle) {
      const h = handle || last;
      if (!h || h.cleared) throw new Error('no active heartbeat timer to tick');
      return h.fn();
    },
    restore() {
      global.setInterval = realSetInterval;
      global.clearInterval = realClearInterval;
    }
  };
}

const timers = installFakeTimers();

const {
  createSingletonLease,
  buildAcquirePipeline,
  buildRenewFilter,
  buildRenewUpdate,
  buildReleaseFilter,
  buildReleaseUpdate,
  deriveHolderId,
  PROCESS_NONCE
} = require(path.join(ROOT, 'src', 'services', 'singletonLease'));

let checks = 0;
const failures = [];
async function check(label, fn) {
  try {
    await fn();
    checks += 1;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}\n     ${err.message}`);
    console.log(`  ✗ ${label}`);
  }
}

function realSleep(ms) {
  return new Promise((resolve) => realSetTimeout(resolve, ms));
}

// ── pipeline evaluator (operators the production pipeline actually uses) ─

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
}

function cloneValue(v) {
  if (v instanceof Date) return new Date(v.getTime());
  if (Array.isArray(v)) return v.map(cloneValue);
  if (isPlainObject(v)) {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = cloneValue(x);
    return out;
  }
  return v;
}

function bsonEq(a, b) {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a === undefined) a = null;
  if (b === undefined) b = null;
  return a === b;
}

function bsonLt(a, b) {
  const left = a instanceof Date ? a.getTime() : a;
  const right = b instanceof Date ? b.getTime() : b;
  if (typeof left !== 'number' || typeof right !== 'number' || Number.isNaN(left) || Number.isNaN(right)) {
    throw new Error(`pipeline stub: $lt on non-numeric values (${left}, ${right})`);
  }
  return left < right;
}

function bsonAdd(a, b) {
  if (a instanceof Date && typeof b === 'number') return new Date(a.getTime() + b);
  if (typeof a === 'number' && b instanceof Date) return new Date(b.getTime() + a);
  if (typeof a === 'number' && typeof b === 'number') return a + b;
  throw new Error(`pipeline stub: $add unsupported operand types (${typeof a}, ${typeof b})`);
}

function boolish(v) {
  return v !== null && v !== undefined && v !== 0 && v !== false;
}

function evalExpr(expr, doc, now) {
  if (expr === '$$NOW') return now;
  if (typeof expr === 'string' && expr.startsWith('$$')) {
    throw new Error(`pipeline stub: unrecognised system variable ${expr}`);
  }
  if (typeof expr === 'string' && expr.startsWith('$')) {
    const pathName = expr.slice(1);
    return Object.prototype.hasOwnProperty.call(doc, pathName) ? doc[pathName] : undefined;
  }
  if (Array.isArray(expr)) {
    throw new Error('pipeline stub: bare array is not an expression');
  }
  if (isPlainObject(expr)) {
    const keys = Object.keys(expr);
    if (keys.length !== 1) {
      throw new Error(`pipeline stub: expression object must have exactly one operator, got ${keys.join(',') || '<empty>'}`);
    }
    const op = keys[0];
    const arg = expr[op];
    switch (op) {
      case '$literal':
        return arg;
      case '$ifNull': {
        if (!Array.isArray(arg) || arg.length !== 2) throw new Error('$ifNull expects [expr, replacement]');
        const v = evalExpr(arg[0], doc, now);
        return (v === null || v === undefined) ? evalExpr(arg[1], doc, now) : v;
      }
      case '$eq': {
        if (!Array.isArray(arg) || arg.length !== 2) throw new Error('$eq expects [a, b]');
        return bsonEq(evalExpr(arg[0], doc, now), evalExpr(arg[1], doc, now));
      }
      case '$ne': {
        if (!Array.isArray(arg) || arg.length !== 2) throw new Error('$ne expects [a, b]');
        return !bsonEq(evalExpr(arg[0], doc, now), evalExpr(arg[1], doc, now));
      }
      case '$lt': {
        if (!Array.isArray(arg) || arg.length !== 2) throw new Error('$lt expects [a, b]');
        return bsonLt(evalExpr(arg[0], doc, now), evalExpr(arg[1], doc, now));
      }
      case '$add': {
        if (!Array.isArray(arg) || arg.length < 2) throw new Error('$add expects [a, b, ...]');
        return arg.map((x) => evalExpr(x, doc, now)).reduce(bsonAdd);
      }
      case '$or': {
        if (!Array.isArray(arg)) throw new Error('$or expects an array');
        return arg.some((x) => boolish(evalExpr(x, doc, now)));
      }
      case '$and': {
        if (!Array.isArray(arg)) throw new Error('$and expects an array');
        return arg.every((x) => boolish(evalExpr(x, doc, now)));
      }
      case '$cond': {
        if (!Array.isArray(arg) || arg.length !== 3) {
          throw new Error('$cond expects [predicate, then, else] (array form only)');
        }
        return boolish(evalExpr(arg[0], doc, now))
          ? evalExpr(arg[1], doc, now)
          : evalExpr(arg[2], doc, now);
      }
      default:
        throw new Error(
          `pipeline stub: unsupported operator ${op} — extend deliberately ` +
          `(a silent no-match would hide a real pipeline edit)`
        );
    }
  }
  return expr;
}

function applyPipeline(doc, pipeline, now) {
  if (!Array.isArray(pipeline) || pipeline.length === 0) {
    throw new Error('pipeline stub: findOneAndUpdate requires a non-empty aggregation pipeline array');
  }
  let current = cloneValue(doc);
  for (const stage of pipeline) {
    if (!isPlainObject(stage)) throw new Error('pipeline stub: stage must be an object');
    const keys = Object.keys(stage);
    if (keys.length !== 1) {
      throw new Error(`pipeline stub: stage must have exactly one operator, got ${keys.join(',')}`);
    }
    const op = keys[0];
    if (op !== '$set') {
      throw new Error(`pipeline stub: unsupported pipeline stage ${op} — extend deliberately`);
    }
    const spec = stage.$set;
    if (!isPlainObject(spec)) throw new Error('$set spec must be an object');
    const next = cloneValue(current);
    for (const [field, expr] of Object.entries(spec)) {
      const value = evalExpr(expr, current, now);
      next[field] = value instanceof Date ? new Date(value.getTime()) : value;
    }
    current = next;
  }
  return current;
}

function matchesEqualityFilter(doc, filter) {
  if (!isPlainObject(filter)) throw new Error('pipeline stub: filter must be a plain object');
  for (const [k, v] of Object.entries(filter)) {
    if (k.startsWith('$')) {
      throw new Error(`pipeline stub: filter operator ${k} not supported`);
    }
    // DOTTED-PATH GUARD — the convention PR #80 established repo-wide, applied
    // to this stub, which is a FIFTH hand-rolled Mongo matcher and landed too
    // late for that PR's audit to cover.
    //
    // Background: PR #75 found scripts/lib/miniMongoStub.js resolving a dotted
    // filter key as a literal flat key and, on that basis, concluding a
    // stranded image receipt is never selected by the recovery sweep — false in
    // production. #80 then audited the repo and guarded four more copies of the
    // same flat `doc[key]` lookup.
    //
    // Every filter this stub evaluates today is top-level ({_id} and
    // {_id, holder}), so it is not currently passing for the wrong reason — but
    // it is safe BY ACCIDENT, NOT BY CONSTRUCTION, which is exactly what #80
    // said about the four it fixed. One dotted path in a future lease filter
    // and this becomes the next silent false-pass site: `doc['a.b']` is
    // undefined, the filter quietly matches nothing, and an exclusion case
    // goes green having proven nothing. Throw instead.
    if (k.includes('.')) {
      throw new Error(
        `pipeline stub: dotted filter key '${k}' would resolve as a flat property ` +
        `and silently match nothing — add real path resolution before using it ` +
        `(see PR #80, and miniMongoStub's "fails LOUD, not quiet" contract)`
      );
    }
    if (isPlainObject(v)) {
      throw new Error(`pipeline stub: filter operator on ${k} not supported (${Object.keys(v).join(',')})`);
    }
    if (!bsonEq(doc[k], v)) return false;
  }
  return true;
}

function wantsPostImage(opts) {
  return opts.new === true || opts.returnDocument === 'after';
}

function queryLike(value) {
  const p = Promise.resolve(value);
  const q = {
    then: (onF, onR) => p.then(onF, onR),
    catch: (onR) => p.catch(onR),
    finally: (onF) => p.finally(onF),
    exec: () => p,
    lean: () => q
  };
  return q;
}

function createPipelineCollection(clock) {
  const docs = [];
  const coll = {
    docs,
    findOneAndUpdateCalls: 0,
    updateOneCalls: 0,
    calls: [],
    clock,
    callCount() { return coll.findOneAndUpdateCalls; },
    byId(id) {
      const d = docs.find((x) => x._id === id);
      return d ? cloneValue(d) : null;
    },
    findOneAndUpdate(filter, update, opts = {}) {
      coll.findOneAndUpdateCalls += 1;
      coll.calls.push({ op: 'findOneAndUpdate', filter, opts });
      let doc = docs.find((d) => matchesEqualityFilter(d, filter));
      if (!doc) {
        if (!opts.upsert) return queryLike(null);
        doc = {};
        for (const [k, v] of Object.entries(filter)) {
          if (!k.startsWith('$') && !isPlainObject(v)) doc[k] = cloneValue(v);
        }
        docs.push(doc);
      }
      const before = cloneValue(doc);
      const now = clock.now();
      const after = applyPipeline(doc, update, now);
      for (const k of Object.keys(doc)) delete doc[k];
      Object.assign(doc, after);
      return queryLike(wantsPostImage(opts) ? cloneValue(doc) : before);
    },
    updateOne(filter, update) {
      coll.updateOneCalls += 1;
      coll.calls.push({ op: 'updateOne', filter, update });
      if (!isPlainObject(update) || Array.isArray(update)) {
        throw new Error('pipeline stub: updateOne expects a $set operator document');
      }
      const keys = Object.keys(update);
      if (keys.length !== 1 || keys[0] !== '$set') {
        throw new Error(`pipeline stub: updateOne only supports $set, got ${keys.join(',')}`);
      }
      const doc = docs.find((d) => matchesEqualityFilter(d, filter));
      if (!doc) return queryLike({ matchedCount: 0, modifiedCount: 0 });
      Object.assign(doc, cloneValue(update.$set));
      return queryLike({ matchedCount: 1, modifiedCount: 1 });
    }
  };
  return coll;
}

function createClock(startMs = Date.UTC(2026, 0, 1, 0, 0, 0)) {
  let ms = startMs;
  return {
    nowMs: () => ms,
    now: () => new Date(ms),
    advance(delta) { ms += delta; return new Date(ms); }
  };
}

function throwAfterN(inner, n, factory) {
  let left = n;
  return {
    get findOneAndUpdateCalls() { return inner.findOneAndUpdateCalls; },
    get updateOneCalls() { return inner.updateOneCalls; },
    byId: (...a) => (inner.byId ? inner.byId(...a) : null),
    findOneAndUpdate(filter, update, opts) {
      if (left <= 0) {
        inner.findOneAndUpdateCalls += 1;
        throw factory();
      }
      left -= 1;
      return inner.findOneAndUpdate(filter, update, opts);
    },
    updateOne(...a) { return inner.updateOne(...a); }
  };
}

function countingWrap(Model) {
  const wrap = {
    findOneAndUpdateCalls: 0,
    updateOneCalls: 0,
    findOneAndUpdate(...args) {
      wrap.findOneAndUpdateCalls += 1;
      return Model.findOneAndUpdate(...args);
    },
    updateOne(...args) {
      wrap.updateOneCalls += 1;
      return Model.updateOne(...args);
    }
  };
  return wrap;
}

function dateMs(v) {
  if (v == null) return v;
  return new Date(v).getTime();
}

function inspectPayload(value) {
  let nowCount = 0;
  const nonEpochDates = [];
  function visit(node) {
    if (node === '$$NOW') nowCount += 1;
    if (node instanceof Date && node.getTime() !== 0) nonEpochDates.push(node.toISOString());
    if (Array.isArray(node)) node.forEach(visit);
    else if (isPlainObject(node)) {
      for (const v of Object.values(node)) visit(v);
    }
  }
  visit(value);
  return { nowCount, nonEpochDates };
}

let nonce = 0;

function createOfflineBackend() {
  return {
    kind: 'offline',
    simulatedClock: true,
    ttlMs: 1000,
    heartbeatMs: 200,
    createContext(label) {
      const clock = createClock();
      const model = createPipelineCollection(clock);
      return {
        model,
        clock,
        name: `lease-${label}`,
        ttlMs: 1000,
        heartbeatMs: 200
      };
    },
    async advance(ctx, ms) { ctx.clock.advance(ms); },
    now(ctx) { return ctx.clock.now(); },
    async read(ctx) { return ctx.model.byId(ctx.name); },
    callCount(ctx) { return ctx.model.findOneAndUpdateCalls; },
    updateCount(ctx) { return ctx.model.updateOneCalls; },
    // Force a takeover WITHOUT advancing the clock. R6 needs a peer to
    // already hold the row while the incumbent's own monotonic elapsed is
    // still inside ttlMs — otherwise the incumbent's self-expiry guard
    // fires first and the renew query never runs, so the holder-scoped
    // renew filter (the property R6 exists to prove) is never exercised.
    // Writes the doc directly rather than through findOneAndUpdate so the
    // findOneAndUpdate call count stays a clean signal for "did the renew
    // actually query".
    async forceHolder(ctx, holderId) {
      const doc = ctx.model.docs.find((d) => d._id === ctx.name);
      if (!doc) throw new Error('forceHolder: no lease doc to take over');
      doc.holder = holderId;
    }
  };
}

function createMongoBackend(Model) {
  return {
    kind: 'mongodb',
    simulatedClock: false,
    ttlMs: 400,
    heartbeatMs: 100,
    createContext(label) {
      nonce += 1;
      const model = countingWrap(Model);
      return {
        model,
        Model,
        clock: { nowMs: () => Date.now(), now: () => new Date() },
        name: `lease-${label}-${process.pid}-${nonce}`,
        ttlMs: 400,
        heartbeatMs: 100
      };
    },
    async advance(_ctx, ms) { await realSleep(ms); },
    now() { return new Date(); },
    async read(ctx) {
      return ctx.Model.findOne({ _id: ctx.name }).lean();
    },
    callCount(ctx) { return ctx.model.findOneAndUpdateCalls; },
    updateCount(ctx) { return ctx.model.updateOneCalls; },
    // See the offline backend's forceHolder for why this exists. Goes
    // through the raw Model (not ctx.model) so it does not disturb the
    // wrapped call counters the assertions read.
    async forceHolder(ctx, holderId) {
      const res = await ctx.Model.updateOne({ _id: ctx.name }, { $set: { holder: holderId } });
      if (!res.matchedCount) throw new Error('forceHolder: no lease doc to take over');
    }
  };
}

function createLease(ctx, holderId, extra = {}) {
  return createSingletonLease(ctx.name, {
    ttlMs: ctx.ttlMs,
    heartbeatMs: ctx.heartbeatMs,
    model: ctx.model,
    holderId,
    nowMs: () => ctx.clock.nowMs(),
    ...extra
  });
}

function assertDistinctHolders(leases) {
  const ids = leases.map((l) => l.holderId);
  const unique = new Set(ids);
  assert.ok(
    ids.every((id) => typeof id === 'string' && id.length > 0),
    `every lease must expose a non-empty holderId, got ${JSON.stringify(ids)}`
  );
  assert.strictEqual(
    unique.size,
    leases.length,
    `createSingletonLease() reused holderId across instances (${ids.join(', ')}). ` +
    `Pass opts.holderId so two processes can be simulated; a process-global INSTANCE_ID ` +
    `makes every race a self-acquire and cannot prove exclusion.`
  );
}

async function settle(leases) {
  for (const l of leases) {
    try { if (l && typeof l.release === 'function') await l.release(); } catch (_) { /* best-effort */ }
  }
}

function makeThrowing11000() {
  return {
    findOneAndUpdateCalls: 0,
    updateOneCalls: 0,
    findOneAndUpdate() {
      this.findOneAndUpdateCalls += 1;
      const err = new Error('E11000 duplicate key error collection: singleton_leases');
      err.code = 11000;
      throw err;
    },
    updateOne() { throw new Error('updateOne should not run on the 11000 path'); }
  };
}

// ── case set (runs against one backend) ──────────────────────────────────

async function runCaseSet(backend) {
  const tag = backend.kind;

  await check(`${tag} R1 two concurrent acquire() → exactly one winner; loser queried`, async () => {
    const ctx = backend.createContext('R1');
    const a = createLease(ctx, 'A');
    const b = createLease(ctx, 'B');
    assertDistinctHolders([a, b]);
    try {
      const results = await Promise.all([a.acquire(), b.acquire()]);
      assert.ok(results.every((r) => r === true || r === false), `acquire() must return a boolean, got ${results}`);
      const wins = results.filter((r) => r === true);
      assert.strictEqual(wins.length, 1, `expected exactly one winner, got ${wins.length} — a double win is two billable expanders`);
      assert.ok(
        backend.callCount(ctx) >= 2,
        `findOneAndUpdate must have run for BOTH racers (got ${backend.callCount(ctx)}); ` +
        `a JS early-return that yields false without querying masquerades as a lost race`
      );
      const doc = await backend.read(ctx);
      const winner = results[0] === true ? a : b;
      const loser = winner === a ? b : a;
      assert.ok(doc, 'lease row must exist after acquire');
      assert.strictEqual(doc.holder, winner.holderId, 'persisted holder must be the winner');
      assert.strictEqual(winner.holds(), true);
      assert.strictEqual(loser.holds(), false);
    } finally {
      await settle([a, b]);
    }
  });

  await check(`${tag} R1b 12 concurrent racers → one winner, fenceToken === 1`, async () => {
    const ctx = backend.createContext('R1b');
    const racers = Array.from({ length: 12 }, (_, i) => createLease(ctx, `R${String(i).padStart(2, '0')}`));
    assertDistinctHolders(racers);
    try {
      const results = await Promise.all(racers.map((r) => r.acquire()));
      assert.strictEqual(results.filter((r) => r === true).length, 1, 'takeover-storm on a fresh lease must still elect exactly one holder');
      assert.ok(backend.callCount(ctx) >= 12, `every racer must have queried, got ${backend.callCount(ctx)}`);
      const doc = await backend.read(ctx);
      assert.strictEqual(doc.fenceToken, 1, `fenceToken must increment exactly once on first acquire, not once per racer (got ${doc.fenceToken})`);
      const winner = racers.find((_, i) => results[i] === true);
      assert.strictEqual(doc.holder, winner.holderId);
    } finally {
      await settle(racers);
    }
  });

  await check(`${tag} R2 unexpired holder blocks a peer 3 times; incumbent fields UNCHANGED`, async () => {
    const ctx = backend.createContext('R2');
    const a = createLease(ctx, 'A');
    const b = createLease(ctx, 'B');
    assertDistinctHolders([a, b]);
    try {
      assert.strictEqual(await a.acquire(), true);
      // Advance a little (well under TTL) so a spurious refresh of expiresAt
      // to $$NOW+ttlMs is visible. With the clock frozen, a buggy losing
      // $set of expiresAt would equal the original and R2 would stay green.
      await backend.advance(ctx, backend.simulatedClock ? 10 : 50);
      const before = await backend.read(ctx);
      for (let i = 1; i <= 3; i++) {
        const n = backend.callCount(ctx);
        assert.strictEqual(await b.acquire(), false, `attempt ${i} must lose`);
        assert.ok(backend.callCount(ctx) > n, `attempt ${i} did not query — JS early-return is not exclusion`);
        const after = await backend.read(ctx);
        assert.strictEqual(after.holder, a.holderId, `attempt ${i} mutated holder`);
        assert.strictEqual(after.fenceToken, before.fenceToken, `attempt ${i} bumped fenceToken`);
        assert.strictEqual(dateMs(after.expiresAt), dateMs(before.expiresAt), `attempt ${i} refreshed expiresAt`);
        assert.strictEqual(dateMs(after.acquiredAt), dateMs(before.acquiredAt), `attempt ${i} moved acquiredAt`);
      }
    } finally {
      await settle([a, b]);
    }
  });

  await check(`${tag} R2b incumbent re-acquire extends expiresAt, does NOT bump fence/acquiredAt`, async () => {
    const ctx = backend.createContext('R2b');
    const a = createLease(ctx, 'A');
    try {
      assert.strictEqual(await a.acquire(), true);
      const before = await backend.read(ctx);
      await backend.advance(ctx, backend.simulatedClock ? 50 : 50);
      assert.strictEqual(await a.acquire(), true);
      const after = await backend.read(ctx);
      assert.ok(
        dateMs(after.expiresAt) > dateMs(before.expiresAt),
        `self-acquire must extend expiresAt (${dateMs(before.expiresAt)} → ${dateMs(after.expiresAt)})`
      );
      assert.strictEqual(after.fenceToken, before.fenceToken, 'self-acquire must not bump fenceToken (that is takeover)');
      assert.strictEqual(dateMs(after.acquiredAt), dateMs(before.acquiredAt), 'self-acquire must not move acquiredAt');
      assert.strictEqual(after.holder, a.holderId);
    } finally {
      await settle([a]);
    }
  });

  await check(`${tag} R3 expired lease is takeable by a peer; fence +1, acquiredAt moves`, async () => {
    const ctx = backend.createContext('R3');
    const a = createLease(ctx, 'A');
    const b = createLease(ctx, 'B');
    assertDistinctHolders([a, b]);
    try {
      assert.strictEqual(await a.acquire(), true);
      const before = await backend.read(ctx);
      await backend.advance(ctx, ctx.ttlMs + 1);
      const n = backend.callCount(ctx);
      assert.strictEqual(await b.acquire(), true, 'peer must win an expired lease');
      assert.ok(backend.callCount(ctx) > n, 'peer acquire did not query');
      const after = await backend.read(ctx);
      assert.strictEqual(after.holder, b.holderId);
      assert.strictEqual(after.fenceToken, before.fenceToken + 1, `fenceToken must bump by exactly 1 on takeover (got ${before.fenceToken} → ${after.fenceToken})`);
      assert.ok(dateMs(after.acquiredAt) > dateMs(before.acquiredAt), 'acquiredAt must move on takeover');
      assert.strictEqual(a.holds(), true, 'A does not learn it lost until its own renew; holds() is local');
      assert.strictEqual(b.holds(), true);
    } finally {
      await settle([a, b]);
    }
  });

  await check(`${tag} R3b 12 racers on an EXPIRED lease → one winner, one fence increment`, async () => {
    const ctx = backend.createContext('R3b');
    const incumbent = createLease(ctx, 'incumbent');
    const racers = Array.from({ length: 12 }, (_, i) => createLease(ctx, `T${String(i).padStart(2, '0')}`));
    // Incumbent must NOT be in the racer set: its acquire would be an
    // expired self-renew (takeable via holder===ME) and would NOT bump fence.
    assertDistinctHolders([incumbent, ...racers]);
    try {
      assert.strictEqual(await incumbent.acquire(), true);
      const before = await backend.read(ctx);
      await backend.advance(ctx, ctx.ttlMs + 1);
      const n = backend.callCount(ctx);
      const results = await Promise.all(racers.map((r) => r.acquire()));
      assert.strictEqual(results.filter((r) => r === true).length, 1, 'takeover-storm must elect exactly one new holder');
      assert.ok(backend.callCount(ctx) - n >= 12, 'every racer must have queried the expired row');
      const after = await backend.read(ctx);
      assert.strictEqual(after.fenceToken, before.fenceToken + 1, `fenceToken must bump once, not once per racer (${before.fenceToken} → ${after.fenceToken})`);
      const winner = racers.find((_, i) => results[i] === true);
      assert.strictEqual(after.holder, winner.holderId);
    } finally {
      await settle([incumbent, ...racers]);
    }
  });

  await check(`${tag} R4 release() then peer acquire succeeds immediately (holder:null arm)`, async () => {
    const ctx = backend.createContext('R4');
    const a = createLease(ctx, 'A');
    const b = createLease(ctx, 'B');
    assertDistinctHolders([a, b]);
    try {
      assert.strictEqual(await a.acquire(), true);
      const beforeRelease = backend.updateCount(ctx);
      await a.release();
      assert.ok(backend.updateCount(ctx) > beforeRelease, 'release() must hit the collection (not a local-only drop)');
      const released = await backend.read(ctx);
      assert.ok(released, 'release must leave the row in place (holder:null), not delete it');
      assert.strictEqual(released.holder, null, 'holder:null is the takeable arm we need; a leftover holder would require TTL');
      assert.ok(
        dateMs(released.expiresAt) < dateMs(backend.now(ctx)),
        `released expiresAt must be in the past, got ${released.expiresAt}`
      );
      const n = backend.callCount(ctx);
      assert.strictEqual(await b.acquire(), true, 'peer must win immediately after release — no TTL wait');
      assert.ok(backend.callCount(ctx) > n, 'peer acquire did not query');
      assert.strictEqual((await backend.read(ctx)).holder, b.holderId);
    } finally {
      await settle([a, b]);
    }
  });

  await check(`${tag} R5 heartbeating holder does not lose to expiry; peer loses at EVERY step`, async () => {
    const ctx = backend.createContext('R5');
    const a = createLease(ctx, 'A');
    const b = createLease(ctx, 'B');
    assertDistinctHolders([a, b]);
    try {
      assert.strictEqual(await a.acquire(), true);
      const beforeHb = timers.last();
      a.startHeartbeat();
      const handle = timers.last();
      assert.ok(handle && handle !== beforeHb, 'startHeartbeat must schedule an interval');
      const steps = Math.ceil(ctx.ttlMs / ctx.heartbeatMs) + 1;
      for (let i = 1; i <= steps; i++) {
        await backend.advance(ctx, ctx.heartbeatMs);
        const nRenew = backend.callCount(ctx);
        await timers.tick(handle);
        assert.ok(backend.callCount(ctx) > nRenew, `step ${i}: heartbeat renew did not query`);
        const nPeer = backend.callCount(ctx);
        assert.strictEqual(await b.acquire(), false, `step ${i}: peer won while holder was heartbeating`);
        assert.ok(backend.callCount(ctx) > nPeer, `step ${i}: peer acquire did not query`);
        const doc = await backend.read(ctx);
        assert.strictEqual(doc.holder, a.holderId, `step ${i}: holder moved`);
      }
      assert.strictEqual(a.holds(), true, 'holder must still holds() after advancing past ttlMs with renews');
    } finally {
      await settle([a, b]);
    }
  });

  await check(`${tag} R6 non-holder renew matches nothing and is a loss`, async () => {
    const ctx = backend.createContext('R6');
    const lost = [];
    const a = createLease(ctx, 'A');
    const b = createLease(ctx, 'B', { onLost: (r) => lost.push(r) });
    assertDistinctHolders([a, b]);
    try {
      assert.strictEqual(await b.acquire(), true);
      const beforeHb = timers.last();
      b.startHeartbeat();
      const handle = timers.last();
      assert.ok(handle && handle !== beforeHb, 'startHeartbeat must schedule an interval');

      // Take the row out from under B WITHOUT advancing the clock. This is
      // the case that isolates the holder-scoped renew filter: B's own
      // monotonic elapsed is still well inside ttlMs, so B's self-expiry
      // guard does NOT fire and the renew genuinely has to query and come
      // back empty. Advancing the clock past ttlMs instead (the obvious
      // setup) makes self-expiry win the race and the renew never runs —
      // the assertion below on callCount is what caught that.
      await backend.forceHolder(ctx, a.holderId);
      assert.strictEqual(b.holds(), true, 'B has not yet observed the loss');

      const n = backend.callCount(ctx);
      await timers.tick(handle);
      assert.ok(backend.callCount(ctx) > n, 'B\'s renew must have queried (holder-scoped filter matching nothing)');
      assert.strictEqual(b.holds(), false, 'null renew is a loss');
      assert.ok(lost.length >= 1, 'onLost must fire when a renew matches nothing');
      // Pin the REASON, not just the fact of a loss. 'lost' means the query
      // ran and matched nothing (the holder-scoped filter did its job);
      // 'renewal-timeout' would mean the self-expiry guard fired instead
      // and this case proved nothing about the filter.
      assert.ok(
        lost.includes('lost'),
        `expected a 'lost' reason from the null renew, got ${JSON.stringify(lost)} — ` +
        `'renewal-timeout' means self-expiry fired and the renew filter was never exercised`
      );
      const doc = await backend.read(ctx);
      assert.strictEqual(doc.holder, a.holderId, 'B\'s failed renew must not clobber A');
    } finally {
      await settle([a, b]);
    }
  });

  await check(`${tag} R7 STALE-RELEASE-CLOBBERS-PEER: A.release() after B takeover leaves B intact`, async () => {
    const ctx = backend.createContext('R7');
    const a = createLease(ctx, 'A');
    const b = createLease(ctx, 'B');
    assertDistinctHolders([a, b]);
    try {
      assert.strictEqual(await a.acquire(), true);
      await backend.advance(ctx, ctx.ttlMs + 1);
      assert.strictEqual(await b.acquire(), true);
      const before = await backend.read(ctx);
      assert.strictEqual(before.holder, b.holderId);
      const n = backend.updateCount(ctx);
      await a.release();
      assert.ok(backend.updateCount(ctx) > n, 'A.release() must still issue updateOne (it locally believes it holds)');
      const after = await backend.read(ctx);
      assert.strictEqual(after.holder, b.holderId, 'stale release clobbered the new holder — split-brain');
      assert.strictEqual(after.fenceToken, before.fenceToken, 'stale release must not touch fenceToken');
      assert.strictEqual(dateMs(after.expiresAt), dateMs(before.expiresAt), 'stale release must not rewrite B\'s expiresAt');
      assert.ok(dateMs(after.expiresAt) > dateMs(backend.now(ctx)), 'B\'s expiresAt must still be in the future');
    } finally {
      await settle([a, b]);
    }
  });

  await check(`${tag} R8 SELF-EXPIRY: throwing renews past ttlMs → onLost('renewal-timeout')`, async () => {
    const ctx = backend.createContext('R8');
    const lost = [];
    const throwing = throwAfterN(ctx.model, 1, () => new Error('injected renew failure'));
    const mono = { ms: ctx.clock.nowMs() };
    const origNow = Date.now;
    Date.now = () => mono.ms;
    const a = createLease(ctx, 'A', {
      model: throwing,
      onLost: (r) => lost.push(r),
      nowMs: () => mono.ms
    });
    try {
      assert.strictEqual(await a.acquire(), true);
      const beforeHb = timers.last();
      a.startHeartbeat();
      const handle = timers.last();
      assert.ok(handle && handle !== beforeHb, 'startHeartbeat must schedule an interval');
      await timers.tick(handle);
      assert.strictEqual(a.holds(), true, 'must not declare lost on the first throwing renew before ttlMs elapses');
      assert.deepStrictEqual(lost, []);
      mono.ms += ctx.ttlMs;
      await timers.tick(handle);
      assert.strictEqual(a.holds(), false, 'holds() must flip once monotonic elapsed reaches ttlMs');
      assert.deepStrictEqual(lost, ['renewal-timeout']);
      assert.ok(
        throwing.findOneAndUpdateCalls >= 2,
        'renew must have been attempted (and thrown) — loss is local, not a null query result'
      );
    } finally {
      Date.now = origNow;
      await settle([a]);
    }
  });

  if (backend.simulatedClock) {
    await check(`${tag} R9 BOUNDARY: expiresAt === $$NOW is NOT expired ($lt, not $lte)`, async () => {
      const ctx = backend.createContext('R9');
      const a = createLease(ctx, 'A');
      const b = createLease(ctx, 'B');
      assertDistinctHolders([a, b]);
      try {
        assert.strictEqual(await a.acquire(), true);
        // expiresAt was $$NOW+ttlMs at acquire. Pin equality first.
        await backend.advance(ctx, ctx.ttlMs);
        const nEq = backend.callCount(ctx);
        assert.strictEqual(await b.acquire(), false, 'expiresAt === $$NOW must NOT be takeable ($lt, not $lte)');
        assert.ok(backend.callCount(ctx) > nEq, 'equality-side acquire did not query');
        const atEq = await backend.read(ctx);
        assert.strictEqual(atEq.holder, a.holderId, 'equality-side must leave the incumbent in place');
        await backend.advance(ctx, 1);
        const nGt = backend.callCount(ctx);
        assert.strictEqual(await b.acquire(), true, 'expiresAt one ms behind $$NOW must be takeable');
        assert.ok(backend.callCount(ctx) > nGt, 'past-side acquire did not query');
        const after = await backend.read(ctx);
        assert.strictEqual(after.holder, b.holderId);
        assert.strictEqual(after.fenceToken, atEq.fenceToken + 1);
      } finally {
        await settle([a, b]);
      }
    });
  } else {
    console.log(`  · ${tag} R9 SKIPPED — cannot pin $$NOW to exact equality against mongod`);
  }

  await check(`${tag} R10 upsert E11000 → acquire() returns false, does not throw`, async () => {
    const ctx = backend.createContext('R10');
    const a = createLease(ctx, 'A', { model: makeThrowing11000() });
    try {
      let threw = null;
      let result;
      try {
        result = await a.acquire();
      } catch (err) {
        threw = err;
      }
      assert.strictEqual(threw, null, `acquire() threw ${threw && threw.message} on E11000 — it must return false`);
      assert.strictEqual(result, false);
      assert.strictEqual(a.holds(), false);
    } finally {
      await settle([a]);
    }
  });

  await check(`${tag} R11 onLost fires once per loss; heartbeat timer is stopped`, async () => {
    const ctx = backend.createContext('R11');
    const lost = [];
    const a = createLease(ctx, 'A', { onLost: (r) => lost.push(r) });
    const b = createLease(ctx, 'B');
    assertDistinctHolders([a, b]);
    try {
      assert.strictEqual(await a.acquire(), true);
      const beforeHb = timers.last();
      a.startHeartbeat();
      const handle = timers.last();
      assert.ok(handle && handle !== beforeHb, 'startHeartbeat must schedule an interval');
      const fn = handle.fn;
      await backend.advance(ctx, ctx.ttlMs + 1);
      assert.strictEqual(await b.acquire(), true);
      await fn();
      assert.strictEqual(a.holds(), false);
      assert.strictEqual(lost.length, 1, `onLost should fire once on first missed renew, got ${lost.length}`);
      assert.ok(handle.cleared, 'heartbeat timer must be clearInterval\'d after loss');
      await fn(); // stale subsequent tick — must not re-fire
      assert.strictEqual(lost.length, 1, 'onLost must not fire again on a subsequent tick');
    } finally {
      await settle([a, b]);
    }
  });
}

async function runMongoArm() {
  const uri = process.env.LEASE_VERIFY_MONGODB_URI;
  if (!uri) {
    console.log(
      'SKIPPED real MongoDB arm — LEASE_VERIFY_MONGODB_URI is unset. ' +
      'This arm is what proves the offline stub is not lying about mongod aggregation semantics.'
    );
    return;
  }
  let mongoose;
  try {
    mongoose = require('mongoose');
  } catch (err) {
    // Point at the CLAUDE.md-SAFE way to get mongoose here. A bare adgen
    // worktree has no node_modules, and this repo's CLAUDE.md forbids the two
    // obvious fixes: `npm ci` in a worktree and a persistent NODE_PATH BOTH
    // break scripts/verifyModelParity.js, which depends on its own
    // require('mongoose') FAILING first so its Module._load fallback patch
    // installs (a bare worktree passes 33/33; an npm-ci'd or NODE_PATH-set one
    // fails 33/33 with what looks exactly like a real schema-parity defect).
    // So: run this arm from the main checkout, or scope NODE_PATH to this ONE
    // invocation — never export it into the suite run.
    throw new Error(
      `LEASE_VERIFY_MONGODB_URI is set but mongoose is not loadable: ${err.message}\n` +
      `  This arm needs mongoose. Do NOT 'npm ci' this worktree and do NOT export\n` +
      `  NODE_PATH — both break verifyModelParity (see CLAUDE.md). Instead run it\n` +
      `  from the main checkout, or scope the path to this one command:\n` +
      `    NODE_PATH=<repo>/node_modules LEASE_VERIFY_MONGODB_URI=... node scripts/verifySingletonLease.js\n` +
      `  The default (offline) arm needs none of this and is what the suite runs.`
    );
  }
  const dbName = `lease_verify_${process.pid}_${Date.now()}`;
  await mongoose.connect(uri, { dbName });
  let SingletonLease;
  try {
    SingletonLease = require(path.join(ROOT, 'src', 'models', 'SingletonLease'));
  } catch (err) {
    try { await mongoose.disconnect(); } catch (_) { /* ignore */ }
    throw err;
  }
  try {
    console.log('\n── mongodb (LEASE_VERIFY_MONGODB_URI) ──');
    await runCaseSet(createMongoBackend(SingletonLease));
  } finally {
    try { await mongoose.connection.dropDatabase(); } catch (_) { /* ignore */ }
    await mongoose.disconnect();
  }
}

async function run() {
  console.log('verifySingletonLease\n');

  await check('S0 exported surface', () => {
    assert.strictEqual(typeof createSingletonLease, 'function');
    assert.strictEqual(typeof buildAcquirePipeline, 'function');
    assert.strictEqual(typeof buildRenewFilter, 'function');
    assert.strictEqual(typeof buildRenewUpdate, 'function');
    assert.strictEqual(typeof buildReleaseFilter, 'function');
    assert.strictEqual(typeof buildReleaseUpdate, 'function');
  });

  await check('S1 acquire/renew payloads contain $$NOW and no client Date except epoch', () => {
    const args = { name: 'n', holder: 'h', ttlMs: 90_000 };
    const built = buildAcquirePipeline(args);
    // buildAcquirePipeline returns the whole call bundle — {filter, pipeline,
    // options} — so the three cannot drift apart at the call site. Assert
    // the shape rather than assuming it: if a future edit collapses this
    // back to a bare array, this fails loudly instead of walking undefined
    // and vacuously passing.
    assert.ok(built && typeof built === 'object' && !Array.isArray(built),
      'buildAcquirePipeline must return the {filter, pipeline, options} bundle');
    assert.ok(Array.isArray(built.pipeline),
      'bundle.pipeline must be the aggregation-pipeline ARRAY passed to findOneAndUpdate');
    assert.deepStrictEqual(built.filter, { _id: 'n' },
      'the acquire filter must be _id-only — all take-or-not logic belongs in the pipeline, ' +
      'where mongod evaluates it under the document write lock against its own clock');
    assert.strictEqual(built.options.upsert, true, 'upsert:true is what creates the row on first acquire');
    assert.strictEqual(built.options.new, true, 'new:true is required — the caller reads holder/fenceToken off the post-image');
    // Walk the LIVE object. JSON.stringify would turn Date into an ISO
    // string and hide a client-clock regression; a source-text regex would
    // match a comment. This is the payload acquire() actually emits.
    const acq = inspectPayload(built.pipeline);
    assert.ok(acq.nowCount >= 1, `acquire pipeline must contain '$$NOW' (found ${acq.nowCount}) — a baked Date is a client clock`);
    assert.deepStrictEqual(acq.nonEpochDates, [], `acquire pipeline contains a non-epoch Date (client clock): ${acq.nonEpochDates.join(', ')}`);

    const renew = buildRenewUpdate(args);
    const ru = inspectPayload(renew);
    assert.ok(ru.nowCount >= 1, `renew update must contain '$$NOW' (found ${ru.nowCount})`);
    assert.deepStrictEqual(ru.nonEpochDates, [], `renew update contains a non-epoch Date (client clock): ${ru.nonEpochDates.join(', ')}`);
  });

  await check('R12 construction guard: fewer than 3 beats per TTL throws', () => {
    const sentinel = 'model should not be touched at construction';
    const dummy = {
      findOneAndUpdate() { throw new Error(sentinel); },
      updateOne() { throw new Error(sentinel); }
    };
    let threw = null;
    try {
      createSingletonLease('guard-lo', { ttlMs: 3000, heartbeatMs: 1001, model: dummy, holderId: 'g' });
    } catch (err) {
      threw = err;
    }
    assert.ok(threw, 'expected throw when ttlMs/heartbeatMs < 3');
    assert.ok(
      !String(threw.message).includes(sentinel),
      `threw for the wrong reason (model was touched before the guard): ${threw.message}`
    );
    assert.doesNotThrow(() => {
      createSingletonLease('guard-ok', { ttlMs: 3000, heartbeatMs: 1000, model: dummy, holderId: 'g' });
    }, 'exactly 3 beats per TTL must be accepted');
  });

  // R14 — THE EXCLUSIVITY KEY MUST NOT BE A DASHBOARD-PINNABLE STRING.
  //
  // Adversarial review (Grok xhigh) found this; reproduced against real
  // MongoDB 7 before fixing. src/config.js builds WORKER_ID as
  // `ADGEN_WORKER_ID || <random>` and invites an operator to pin it. Render
  // shares a service's env across every instance, so a pinned value gives
  // two instances the SAME holder string — and the acquire pipeline's
  // self-renew arm ($eq ['$holder', me]) then reads the OTHER instance's
  // live, unexpired row as "already mine". Both win. fenceToken never
  // bumps, because it is not scored as a takeover. Nothing notices.
  //
  // MEASURED before the fix: A.acquire() -> true, B.acquire() -> true,
  // both holds() -> true, fenceToken 1 -> 1, on an unexpired row.
  await check('R14 holder id is instance-unique even when ADGEN_WORKER_ID is pinned', () => {
    const PINNED = 'orchestrator';   // what an operator would set

    const a = deriveHolderId({ workerId: PINNED, nonce: 'proc-a' });
    const b = deriveHolderId({ workerId: PINNED, nonce: 'proc-b' });
    assert.notStrictEqual(a, b,
      'two processes sharing a pinned ADGEN_WORKER_ID must still get different ' +
      'holder ids — this is the two-holder bug, measured against real MongoDB');
    assert.notStrictEqual(a, PINNED,
      'the exclusivity key must NOT be the pinnable string itself');
    assert.ok(a.startsWith(PINNED),
      'the readable label should be preserved so logs stay greppable');

    // RENDER_INSTANCE_ID takes precedence as the label (backend's choice),
    // but the nonce is what actually guarantees exclusivity.
    const r1 = deriveHolderId({ workerId: PINNED, renderInstanceId: 'srv-1', nonce: 'n' });
    assert.ok(r1.startsWith('srv-1'), 'RENDER_INSTANCE_ID should win as the label');
    assert.notStrictEqual(
      deriveHolderId({ workerId: PINNED, renderInstanceId: 'srv-1', nonce: 'x' }),
      deriveHolderId({ workerId: PINNED, renderInstanceId: 'srv-1', nonce: 'y' }),
      'even a shared RENDER_INSTANCE_ID must not collapse two processes to one key'
    );

    // The real module-level nonce must not be a constant.
    assert.ok(PROCESS_NONCE && PROCESS_NONCE.length >= 8,
      `PROCESS_NONCE must be a real per-process nonce, got ${JSON.stringify(PROCESS_NONCE)}`);
    assert.ok(/[0-9a-f]{8}/.test(PROCESS_NONCE),
      'PROCESS_NONCE must contain random hex — a pid alone repeats across containers');
  });

  // R15 — the PRODUCTION TTL FLOOR. The 3-beat ratio is scale-free, so
  // ttlMs:30/heartbeatMs:10 passes it while a single 40ms event-loop pause
  // still expires the lease under its own live holder. Adversarial review
  // (Grok xhigh) raised this; the mutation run then showed no case covered
  // the floor at all, because every other harness lease injects a model and
  // the floor is deliberately skipped in that (test) mode.
  //
  // No model here on purpose — that is what makes it "production". holderId
  // is supplied so the factory short-circuits before require('../config'),
  // and the throw lands before the model require, so this stays offline.
  await check('R15 production TTL floor: a sub-floor ttlMs throws without an injected model', () => {
    let threw = null;
    try {
      createSingletonLease('floor-lo', { ttlMs: 1000, heartbeatMs: 300, holderId: 'x' });
    } catch (err) { threw = err; }
    assert.ok(threw, 'ttlMs=1000 passes the 3-beat ratio (3.33) but must fail the absolute floor');
    assert.match(String(threw.message), /floor/i,
      `expected the floor error, got: ${threw && threw.message}`);
    // And the ratio guard must still be the one that fires when IT is the
    // violation, so the two errors stay distinguishable.
    let ratioErr = null;
    try {
      createSingletonLease('floor-ratio', { ttlMs: 90_000, heartbeatMs: 45_000, holderId: 'x' });
    } catch (err) { ratioErr = err; }
    assert.ok(ratioErr, 'a 2-beat pair must still throw');
    assert.match(String(ratioErr.message), /beats per TTL/,
      'the ratio violation must report the ratio, not the floor');
  });

  // R14b — same property, but through the FACTORY's real ME assignment.
  // R14 alone tests deriveHolderId in isolation, so it would stay green if
  // someone reverted the factory line back to a bare config.WORKER_ID — the
  // exact shape of the measured two-holder bug. This drives createSingletonLease
  // itself with the label pinned and no holderId override.
  await check('R14b createSingletonLease() derives distinct ids from ONE pinned label', () => {
    const dummy = { findOneAndUpdate() { throw new Error('unused'); }, updateOne() {} };
    const mk = () => createSingletonLease('pinned-factory', {
      ttlMs: 90_000, heartbeatMs: 30_000, model: dummy, workerId: 'orchestrator'
    });
    const a = mk();
    const b = mk();
    assert.notStrictEqual(a.holderId, b.holderId,
      'two leases built from one pinned label must not share an exclusivity key — ' +
      'if this fails, the factory is using the pinnable value directly');
    assert.notStrictEqual(a.holderId, 'orchestrator',
      'the factory must not use the pinnable label AS the key');
    assert.ok(a.holderId.startsWith('orchestrator'), 'label should still prefix the key');
  });

  // R13 — SHUTDOWN RACES AN IN-FLIGHT ACQUIRE.
  //
  // Found by execution, not by reading: SIGTERM landing while acquire() was
  // awaiting had release() run FIRST (it saw currentlyHolds===false and
  // wrote nothing), and then the acquire resolved, won, and set
  // currentlyHolds=true on a process about to process.exit(0). The lease doc
  // was left held by a dead instance with NO release write ever issued, so a
  // replacement instance had to wait out the whole ttlMs before it could
  // expand. Only one holder, so not a double-mint — but a self-inflicted
  // failover delay in exactly the instance-replacement case this lease is
  // supposed to make smooth.
  //
  // The fix is the leaseGen generation guard in acquire(), the same
  // discipline renewOnce() already used. This case is what stops it being
  // "tidied" back out.
  await check('R13 acquire() that wins AFTER release() hands the lease straight back', async () => {
    let openGate = null;
    const doc = { _id: 'r13', holder: null, fenceToken: 0 };
    const releaseWrites = [];
    const model = {
      findOneAndUpdateCalls: 0,
      findOneAndUpdate(filter) {
        model.findOneAndUpdateCalls += 1;
        return new Promise((resolve) => {
          openGate = () => {
            doc.holder = 'A';
            doc.expiresAt = new Date(Date.now() + 90_000);
            doc.fenceToken += 1;
            resolve({ ...doc, _id: filter._id });
          };
        });
      },
      updateOne(filter, update) {
        releaseWrites.push({ filter, update });
        return Promise.resolve({ matchedCount: 1, modifiedCount: 1 });
      }
    };

    const lease = createSingletonLease('r13', {
      ttlMs: 90_000, heartbeatMs: 30_000, model, holderId: 'A'
    });

    const acquiring = lease.acquire();          // in flight, gated
    await lease.release();                      // SIGTERM path runs first
    assert.strictEqual(releaseWrites.length, 0,
      'release() had nothing to write yet — currentlyHolds was still false');

    openGate();                                 // the acquire now wins
    const won = await acquiring;

    assert.strictEqual(won, false,
      'acquire() must report a LOSS once release() has run — otherwise the caller ' +
      'starts singleton work on a process that is exiting');
    assert.strictEqual(lease.holds(), false, 'holds() must stay false after shutdown');
    assert.strictEqual(releaseWrites.length, 1,
      'the won-then-abandoned lease must be handed back, or a replacement instance ' +
      'waits out the full ttlMs before it can expand');
    // The hand-back must be holder-scoped, or it could clobber a peer that
    // legitimately took the row from us in the meantime.
    assert.deepStrictEqual(releaseWrites[0].filter, { _id: 'r13', holder: 'A' },
      'hand-back write must be holder-scoped');
    assert.strictEqual(releaseWrites[0].update.$set.holder, null,
      'hand-back must null the holder so a peer can take it immediately');
  });

  // Proven to fire, not just written — same discipline PR #80 used ("proven to
  // fire when fed 'imageGeneration.predictionId' against a nested fixture").
  await check('offline stub throws on a DOTTED filter key (PR #80 convention)', () => {
    const clock = createClock();
    const coll = createPipelineCollection(clock);
    coll.docs.push({ _id: 'x', imageGeneration: { predictionId: 'p1' } });
    assert.throws(
      () => coll.findOneAndUpdate({ 'imageGeneration.predictionId': 'p1' }, [{ $set: {} }], {}),
      /dotted filter key/,
      'a dotted key must throw, not resolve to undefined and silently match nothing'
    );
    // The top-level filters this stub actually uses must still work.
    assert.doesNotThrow(() => coll.findOneAndUpdate({ _id: 'x' }, [{ $set: {} }], {}));
  });

  await check('offline stub throws on unrecognised $lte (silent no-match would hide $lt → $lte)', () => {
    const clock = createClock();
    const col = createPipelineCollection(clock);
    col.docs.push({ _id: 'x', holder: 'A', expiresAt: clock.now(), fenceToken: 1 });
    assert.throws(
      () => col.findOneAndUpdate(
        { _id: 'x' },
        [{ $set: { f: { $lte: ['$expiresAt', '$$NOW'] } } }],
        { new: true }
      ),
      /\$lte/
    );
  });

  console.log('\n── offline stub ──');
  await runCaseSet(createOfflineBackend());

  await runMongoArm();
}

run()
  .catch((err) => {
    console.log(`\n❌ verifySingletonLease: harness threw — ${err.stack || err.message}\n`);
    process.exit(1);
  })
  .then(() => {
    const total = checks + failures.length;
    if (failures.length) {
      console.log(`\n❌ verifySingletonLease: ${failures.length} of ${total} checks FAILED\n`);
      for (const f of failures) console.log(`  • ${f}`);
      process.exit(1);
    }
    console.log(`\n✅ verifySingletonLease: ${total}/${total} checks passed`);
  })
  .finally(() => {
    timers.restore();
  });
