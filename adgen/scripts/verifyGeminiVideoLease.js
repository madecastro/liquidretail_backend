#!/usr/bin/env node
'use strict';
//
// verifyGeminiVideoLease — EXECUTION tests for the direct-Gemini concurrency
// guard (src/services/geminiVideoLease.js). This is the file that stands
// between the renderer and Google's hard cap of 8 concurrent paid Omni
// requests; getting it wrong either wedges the pipeline (safe direction) or
// silently over-submits into a possibly-billed rejection (the expensive
// direction — see that file's own header on why an accepted interaction_id
// is the charge point, not the HTTP status).
//
// Unlike scripts/verifyGeminiVideoProvider.js section G (which text-scans
// LEASE_SRC for structural shape), this harness REQUIRES the real module and
// drives it against two fake Mongo collections — one modelling the occupancy
// documents (reused per slot, unique-index-enforced), one modelling the
// append-only rate-event ledger (insert-only) — that model just enough of
// the raw MongoDB driver's semantics to reproduce or prove absent the three
// fixed bugs:
//   B5 — a stale-then-stolen occupancy slot released by its ORIGINAL,
//        evicted holder (section A).
//   B6 — the rolling rate window. TWO independent failure modes were found
//        here, both fixed by the same append-only-ledger redesign:
//          (i)  a SEQUENTIAL, single-worker, zero-concurrency bug: the old
//               code counted rows in the REUSED occupancy collection, which
//               can never exceed MAX_SLOTS rows for a given scope no matter
//               how many times a slot recycles — so fast turnover of ONE
//               slot silently defeated the entire rate cap with no race
//               required at all (section B-control / B-sequential).
//          (ii) a genuine concurrent lost-update race on the fixed ledger
//               design, closed by the post-insert recheck (section B).
//   B7 — every Mongo-touching error path fails CLOSED, never falls through
//        to granting a lease (section C).
//
// OFFLINE, NO REAL MONGODB. geminiVideoLease.js reaches Mongo via
// `mongoose.connection.db.collection(...)` (the raw driver, not a Mongoose
// Model), so this stubs `mongoose.connection.readyState` / `.db` directly
// rather than monkey-patching a Model the way verifyRetitleConsumerClaim.js
// does. A bare adgen worktree has no local `mongoose` (see this repo's
// CLAUDE.md on npm ci / NODE_PATH), so this loads it the same way
// verifyModelParity.js / verifyRetitleConsumerClaim.js do: via the shared
// Module._load fallback onto the sibling liquidretail_backend's
// node_modules. That patch is intentionally left installed afterward — do
// not "clean it up" — see scripts/lib/mongooseLoader.js's header.
//
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const LEASE_PATH = require.resolve(path.join(ROOT, 'src', 'services', 'geminiVideoLease.js'));

const { resolveBackendRoot } = require('./lib/siblingBackend');
const { loadMongooseWithFallback } = require('./lib/mongooseLoader');
const mongoose = loadMongooseWithFallback({
  harnessName: 'verifyGeminiVideoLease',
  backendRoot: resolveBackendRoot(ROOT),
});

let pass = 0;
const failures = [];
function check(label, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); return; }
  failures.push(detail ? `${label} — ${detail}` : label);
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
}
async function checkAsync(label, fn) {
  try { await fn(); pass += 1; console.log(`  ✓ ${label}`); }
  catch (err) { failures.push(`${label} — ${err.message}`); console.log(`  ✗ ${label} — ${err.message}`); }
}

// ── A tiny, purpose-built Mongo matcher ─────────────────────────────────
//
// Only supports exactly the filter shapes geminiVideoLease.js actually
// issues: top-level equality (scope, slot, claimToken), $or of {$ne} /
// {$lt}, and a bare {$gte} for the rate-window count. Unlike
// scripts/lib/miniMongoStub.js (which this deliberately does NOT reuse —
// that stub has no $gte support and is shared by many other harnesses; a
// hand-rolled matcher tailored to this one file's filters is safer than
// widening a shared dependency for one caller), an unrecognised operator
// throws rather than silently mismatching.
function matchOne(doc, filter) {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === '$or') return cond.some((sub) => matchOne(doc, sub));
    const val = doc[key];
    const isOp = cond && typeof cond === 'object' && !(cond instanceof Date);
    if (!isOp) return val === cond;
    return Object.entries(cond).every(([op, opVal]) => {
      switch (op) {
        case '$ne': return val !== opVal;
        case '$lt': return val != null && val < opVal;
        case '$gte': return val != null && val >= opVal;
        default: throw new Error(`verifyGeminiVideoLease stub: unsupported operator ${op}`);
      }
    });
  });
}

// ── Occupancy collection fake (geminivideoleases) ───────────────────────
//
// One document per (scope, slot), REUSED (overwritten) on every
// acquire/steal — this mirrors the real design faithfully, including the
// property that makes counting THIS collection for the rate constraint
// wrong (see section B-sequential below).
class FakeOccupancyCollection {
  constructor() {
    this.docs = new Map(); // key `${scope}::${slot}` -> plain doc object
    this.calls = [];
    this.failCreateIndex = false;
  }

  async createIndex(spec, opts) {
    this.calls.push({ op: 'createIndex', spec, opts });
    if (this.failCreateIndex) throw new Error('simulated index build failure');
    return `idx_${Object.keys(spec).join('_')}`;
  }

  async countDocuments(filter) {
    this.calls.push({ op: 'countDocuments', filter });
    let n = 0;
    for (const doc of this.docs.values()) if (matchOne(doc, filter)) n += 1;
    return n;
  }

  // Models the property a real unique (scope, slot) index provides: if a
  // document already exists for that key but does not match the filter
  // (i.e. it is actively held, not stale/released), the upsert path must
  // NOT create a second document — it throws E11000, exactly like a real
  // unique index would on the resulting duplicate-key insert.
  async findOneAndUpdate(filter, update, opts = {}) {
    this.calls.push({ op: 'findOneAndUpdate', filter, update, opts });
    const key = `${filter.scope}::${filter.slot}`;
    let doc = null;
    for (const d of this.docs.values()) {
      if (d.__key === key && matchOne(d, filter)) { doc = d; break; }
    }
    if (!doc) {
      if (!opts.upsert) return null;
      if (this.docs.has(key)) {
        const err = new Error('E11000 duplicate key error collection: geminivideoleases index: scope_1_slot_1');
        err.code = 11000;
        throw err;
      }
      doc = { __key: key };
      this.docs.set(key, doc);
    }
    if (update.$set) Object.assign(doc, update.$set);
    return { ...doc };
  }

  async updateOne(filter, update) {
    this.calls.push({ op: 'updateOne', filter, update });
    let doc = null;
    for (const d of this.docs.values()) if (matchOne(d, filter)) { doc = d; break; }
    if (!doc) return { matchedCount: 0, modifiedCount: 0 };
    if (update.$set) Object.assign(doc, update.$set);
    return { matchedCount: 1, modifiedCount: 1 };
  }
}

// ── Rate-event ledger fake (geminivideoleaseevents) ─────────────────────
//
// APPEND-ONLY by construction: insertOne always adds a new row, never
// overwrites an existing one. This is the property the B6 fix depends on —
// modelling it any other way would hide the exact bug that was found.
class FakeEventsCollection {
  constructor() {
    this.rows = []; // { _id, scope, acquiredAt }
    this.nextId = 1;
    this.calls = [];
    this.failCreateIndex = false;
    this.failCountDocuments = false;
    this.countCallCount = 0;
    // Fail only the Nth+ countDocuments call and beyond (1-indexed). Lets a
    // test isolate "pre-check succeeds, recheck fails" precisely.
    this.failCountDocumentsFromCall = null;
  }

  async createIndex(spec, opts) {
    this.calls.push({ op: 'createIndex', spec, opts });
    if (this.failCreateIndex) throw new Error('simulated index build failure');
    return `idx_${Object.keys(spec).join('_')}`;
  }

  async countDocuments(filter) {
    this.countCallCount += 1;
    this.calls.push({ op: 'countDocuments', filter, callNumber: this.countCallCount });
    if (this.failCountDocuments) throw new Error('simulated countDocuments failure (index missing/slow/unreachable)');
    if (this.failCountDocumentsFromCall != null && this.countCallCount >= this.failCountDocumentsFromCall) {
      throw new Error('simulated countDocuments failure on a later call');
    }
    let n = 0;
    for (const row of this.rows) if (matchOne(row, filter)) n += 1;
    return n;
  }

  async insertOne(doc) {
    const _id = this.nextId++;
    const row = { _id, ...doc };
    this.rows.push(row);
    this.calls.push({ op: 'insertOne', doc: row });
    return { acknowledged: true, insertedId: _id };
  }

  async deleteOne(filter) {
    this.calls.push({ op: 'deleteOne', filter });
    const idx = this.rows.findIndex((r) => matchOne(r, filter));
    if (idx < 0) return { deletedCount: 0 };
    this.rows.splice(idx, 1);
    return { deletedCount: 1 };
  }
}

// Wire the fakes into mongoose.connection, routed by collection name.
// geminiVideoLease.js reads mongoose.connection fresh on every call
// (coll()/rateEventsColl()), so mutating this shared connection object
// before each test is enough — no need to touch the module beyond that.
let occupancyFake = new FakeOccupancyCollection();
let eventsFake = new FakeEventsCollection();
mongoose.connection.readyState = 1;
Object.defineProperty(mongoose.connection, 'db', {
  configurable: true,
  get() {
    return {
      collection: (name) => {
        if (name === 'geminivideoleases') return occupancyFake;
        if (name === 'geminivideoleaseevents') return eventsFake;
        throw new Error(`verifyGeminiVideoLease stub: unexpected collection name "${name}"`);
      }
    };
  }
});

function freshLease(envOverrides) {
  delete require.cache[LEASE_PATH];
  const saved = {};
  for (const [k, v] of Object.entries(envOverrides || {})) {
    saved[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
    process.env[k] = v;
  }
  const mod = require(LEASE_PATH);
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  return { mod, restore };
}

(async () => {
  console.log('\nverifyGeminiVideoLease\n');

  // Sanity: the collection name constants this stub routes on must actually
  // match the module's own. If a future edit renames either collection,
  // this must fail loudly (every doc would silently land in nobody's fake
  // and the "unexpected collection name" throw below would fire) rather
  // than the whole suite quietly testing the wrong thing.
  {
    const { mod: lease, restore } = freshLease({});
    check('sanity: COLLECTION constant matches this stub\'s routing', lease.COLLECTION === 'geminivideoleases');
    check('sanity: RATE_EVENTS_COLLECTION constant matches this stub\'s routing', lease.RATE_EVENTS_COLLECTION === 'geminivideoleaseevents');
    restore();
  }

  // ═════════════════════════════════════════════════════════════════════
  // A — B5: holder-scoped release. A stale-then-stolen slot must not be
  // released by the ORIGINAL (now-evicted) holder's late release() call.
  // ═════════════════════════════════════════════════════════════════════
  console.log('\nA. B5 — release is scoped to the acquisition, not just the slot');
  {
    occupancyFake = new FakeOccupancyCollection();
    eventsFake = new FakeEventsCollection();
    const { mod: lease, restore } = freshLease({ GEMINI_VIDEO_MAX_SLOTS: '8' });
    try {
      const scope = 'gemini:test-model-A';

      const a = await lease.acquire(scope);
      assert.ok(a, 'worker A must win the first acquire on an empty collection');

      // Simulate A stalling (GC pause / hung network call / slow Remotion
      // render) WITHOUT crashing — its acquiredAt just ages past the TTL.
      const staleDoc = occupancyFake.docs.get(`${scope}::${a.slot}`);
      assert.ok(staleDoc, 'expected a stored doc for the slot A won');
      staleDoc.acquiredAt = new Date(Date.now() - lease.LEASE_TTL_MS - 10_000);

      const b = await lease.acquire(scope);
      assert.ok(b, 'worker B must be able to steal a TTL-expired slot');
      assert.strictEqual(b.slot, a.slot, 'test setup: B should steal the SAME slot A held (only one doc exists)');

      const docAfterSteal = occupancyFake.docs.get(`${scope}::${a.slot}`);
      const bClaimToken = docAfterSteal.claimToken;
      assert.ok(bClaimToken, 'B\'s acquisition must have stamped a claim token');

      check('A1 the pre-fix filter shape ({scope,slot,releasedAt:null}) WOULD have matched B\'s row',
        docAfterSteal.releasedAt === null && docAfterSteal.scope === scope && docAfterSteal.slot === a.slot,
        'sanity check that this scenario actually exercises the hazard, not a vacuous setup');

      // THE BUG, IF PRESENT: A's stale handle releases B's active slot.
      await a.release();
      const docAfterStaleRelease = occupancyFake.docs.get(`${scope}::${a.slot}`);
      check('A2 a non-holder (stale A) release() does not clear the CURRENT holder\'s (B) lease',
        docAfterStaleRelease.releasedAt === null && docAfterStaleRelease.claimToken === bClaimToken,
        JSON.stringify(docAfterStaleRelease));

      // The mechanism still works for the legitimate holder.
      await b.release();
      const docAfterRealRelease = occupancyFake.docs.get(`${scope}::${a.slot}`);
      check('A3 the legitimate holder (B) can still release its own lease',
        docAfterRealRelease.releasedAt instanceof Date);

      // A second call to A's already-used handle must stay a no-op (the
      // in-closure `released` guard), and must not touch B's now-released row.
      await a.release();
      const docAfterDoubleRelease = occupancyFake.docs.get(`${scope}::${a.slot}`);
      check('A4 calling a stale handle release() twice is still inert',
        docAfterDoubleRelease.releasedAt instanceof Date && docAfterDoubleRelease.claimToken === bClaimToken);
    } finally {
      restore();
    }
  }

  // ═════════════════════════════════════════════════════════════════════
  // B-sequential — B6, failure mode (i): a SINGLE worker, NO concurrency,
  // recycling one slot fast enough to blow through the rate cap while the
  // (fixed) rolling-window check still denies it correctly.
  // ═════════════════════════════════════════════════════════════════════
  console.log('\nB-sequential. B6 — fast single-slot recycling cannot outrun the rate cap (zero concurrency)');
  {
    occupancyFake = new FakeOccupancyCollection();
    eventsFake = new FakeEventsCollection();
    const { mod: lease, restore } = freshLease({ GEMINI_VIDEO_MAX_SLOTS: '3', GEMINI_VIDEO_RATE_WINDOW_MS: '60000' });
    try {
      const scope = 'gemini:test-model-Bseq';
      let granted = 0;
      // 10 fully sequential acquire()+release() cycles, all reusing the
      // same slot (only one scope, only one worker, no Promise.all at all).
      // Pre-fix, this sailed through indefinitely (measured: 20/20 granted
      // against a cap of 3-8) because countDocuments against the REUSED
      // occupancy collection can never see more than MAX_SLOTS rows for one
      // scope. Post-fix, the append-only ledger must cap it at MAX_SLOTS.
      for (let i = 0; i < 10; i += 1) {
        const lease_ = await lease.acquire(scope);
        if (lease_) {
          granted += 1;
          await lease_.release();
        }
      }
      check('B-seq1 exactly MAX_SLOTS (3) of 10 sequential single-slot reacquisitions are granted, not all 10',
        granted === 3, `granted=${granted}`);
    } finally {
      restore();
    }
  }

  // ═════════════════════════════════════════════════════════════════════
  // B — B6, failure mode (ii): the rate ledger survives a genuine
  // concurrent acquire race, even when occupancy alone has room for more
  // winners than the rate budget allows.
  // ═════════════════════════════════════════════════════════════════════
  console.log('\nB. B6 — the rolling rate window survives a concurrent acquire race');
  {
    occupancyFake = new FakeOccupancyCollection();
    eventsFake = new FakeEventsCollection();
    // MAX_SLOTS=3 so the numbers are small and the assertion is exact.
    const { mod: lease, restore } = freshLease({ GEMINI_VIDEO_MAX_SLOTS: '3', GEMINI_VIDEO_RATE_WINDOW_MS: '60000' });
    try {
      const scope = 'gemini:test-model-B';
      const now = Date.now();
      // 2 PRIOR ledger events already inside the 60s window — occupancy is
      // completely empty (all 3 slot indices free), so occupancy alone
      // would grant all 3 concurrent racers; the rate window should allow
      // only 1 more (cap 3, 2 already counted).
      eventsFake.rows.push({ _id: 'prior-1', scope, acquiredAt: new Date(now - 5000) });
      eventsFake.rows.push({ _id: 'prior-2', scope, acquiredAt: new Date(now - 4000) });
      eventsFake.nextId = 100;

      const results = await Promise.all([1, 2, 3, 4, 5].map(() => lease.acquire(scope)));
      const winners = results.filter(Boolean);

      check('B1 exactly ONE of 5 concurrent racers wins when the rate window already holds 2/3',
        winners.length === 1,
        `winners=${winners.length} slots=${JSON.stringify(winners.map((w) => w.slot))}`);

      const finalCountInWindow = await eventsFake.countDocuments({ scope, acquiredAt: { $gte: new Date(now - 60000) } });
      check('B2 the true post-race ledger count in the window never exceeds MAX_SLOTS',
        finalCountInWindow <= 3, `finalCountInWindow=${finalCountInWindow}`);

      // The losers must have rolled back their occupancy write too (not
      // just returned null while silently leaving a slot marked held) —
      // otherwise a rejected rate-racer would permanently waste an
      // occupancy slot until the TTL, shrinking real throughput for no
      // reason under repeated contention.
      let heldCount = 0;
      for (const doc of occupancyFake.docs.values()) {
        if (doc.scope === scope && doc.releasedAt === null) heldCount += 1;
      }
      check('B3 rate-rejected racers release the occupancy slot they provisionally won (no wasted holds)',
        heldCount === 1, `heldCount=${heldCount}`);
    } finally {
      restore();
    }
  }

  // Sanity control: the SAME setup but with zero prior rate pressure must
  // still allow the full occupancy cap — isolates that B1 above is driven
  // by real rate pressure, not some accidental universal rejection.
  console.log('\nB′. control — occupancy alone (no prior rate pressure) allows the full cap');
  {
    occupancyFake = new FakeOccupancyCollection();
    eventsFake = new FakeEventsCollection();
    const { mod: lease, restore } = freshLease({ GEMINI_VIDEO_MAX_SLOTS: '3', GEMINI_VIDEO_RATE_WINDOW_MS: '60000' });
    try {
      const scope = 'gemini:test-model-Bcontrol';
      const results = await Promise.all([1, 2, 3, 4, 5].map(() => lease.acquire(scope)));
      const winners = results.filter(Boolean);
      check('B′ with zero prior pressure, exactly MAX_SLOTS (3) of 5 racers win',
        winners.length === 3, `winners=${winners.length}`);
    } finally {
      restore();
    }
  }

  // ═════════════════════════════════════════════════════════════════════
  // C — B7: every Mongo-touching error path fails CLOSED (denied), never
  // falls through to granting a lease.
  // ═════════════════════════════════════════════════════════════════════
  console.log('\nC. B7 — index/lookup failure denies the lease, never grants it');

  await checkAsync('C1 occupancy createIndex() throwing (unique index unconfirmed) denies the lease', async () => {
    occupancyFake = new FakeOccupancyCollection();
    eventsFake = new FakeEventsCollection();
    occupancyFake.failCreateIndex = true;
    const { mod: lease, restore } = freshLease({ GEMINI_VIDEO_MAX_SLOTS: '8' });
    try {
      const result = await lease.acquire('gemini:test-model-C1');
      assert.strictEqual(result, null, 'a lease must not be granted when the unique index cannot be confirmed');
      const wroteAnything = occupancyFake.calls.some((c) => c.op === 'findOneAndUpdate');
      assert.strictEqual(wroteAnything, false, 'must not even attempt to claim a slot without the index confirmed');
    } finally { restore(); }
  });

  await checkAsync('C2 ledger countDocuments() throwing on the PRE-check denies the lease (not an uncaught throw)', async () => {
    occupancyFake = new FakeOccupancyCollection();
    eventsFake = new FakeEventsCollection();
    eventsFake.failCountDocuments = true;
    const { mod: lease, restore } = freshLease({ GEMINI_VIDEO_MAX_SLOTS: '8' });
    try {
      const result = await lease.acquire('gemini:test-model-C2');
      assert.strictEqual(result, null, 'a thrown countDocuments must resolve to null, not propagate');
      const wroteAnything = occupancyFake.calls.some((c) => c.op === 'findOneAndUpdate');
      assert.strictEqual(wroteAnything, false, 'must not attempt occupancy before the rate pre-check can be trusted');
    } finally { restore(); }
  });

  await checkAsync('C3 ledger countDocuments() throwing on the POST-insert recheck rolls back and denies (not grants on the strength of the write alone)', async () => {
    occupancyFake = new FakeOccupancyCollection();
    eventsFake = new FakeEventsCollection();
    // Let the FIRST countDocuments (pre-check) succeed normally, fail the 2nd+ (the recheck).
    eventsFake.failCountDocumentsFromCall = 2;
    const { mod: lease, restore } = freshLease({ GEMINI_VIDEO_MAX_SLOTS: '8' });
    try {
      const scope = 'gemini:test-model-C3';
      const result = await lease.acquire(scope);
      assert.strictEqual(result, null, 'a thrown recheck must deny, not grant on the strength of the write alone');
      const held = [...occupancyFake.docs.values()].filter((d) => d.scope === scope && d.releasedAt === null);
      assert.strictEqual(held.length, 0, 'the provisional occupancy write must be rolled back when the recheck cannot be trusted');
      // The insert (call #1, pre-throw) succeeded and was recorded, then the
      // recheck (call #2) threw — the code's best-effort deleteOne rollback
      // should remove that row too, so a denied acquisition leaves no trace
      // in the ledger to wrongly count against a later, legitimate caller.
      assert.strictEqual(eventsFake.rows.length, 0, 'a denied acquisition must not leave its ledger row behind');
    } finally { restore(); }
  });

  await checkAsync('C4 ledger insertOne() throwing denies the lease and rolls back the occupancy win', async () => {
    occupancyFake = new FakeOccupancyCollection();
    eventsFake = new FakeEventsCollection();
    eventsFake.insertOne = async () => { throw new Error('simulated insert failure'); };
    const { mod: lease, restore } = freshLease({ GEMINI_VIDEO_MAX_SLOTS: '8' });
    try {
      const scope = 'gemini:test-model-C4';
      const result = await lease.acquire(scope);
      assert.strictEqual(result, null, 'a thrown ledger insert must deny the lease');
      const held = [...occupancyFake.docs.values()].filter((d) => d.scope === scope && d.releasedAt === null);
      assert.strictEqual(held.length, 0, 'the provisional occupancy write must be rolled back when the ledger cannot record the acquisition');
    } finally { restore(); }
  });

  // ═════════════════════════════════════════════════════════════════════
  // D — live holders heartbeat acquiredAt so a still-polling worker is
  // never stealable at LEASE_TTL_MS. Without this, worker A acquires at
  // T=0, its POST returns at T=30, its poll deadline is T=630, and at
  // T=600 the slot is stealable while A is still legitimately polling —
  // Google sees 9 in-flight against a cap of 8.
  // ═════════════════════════════════════════════════════════════════════
  console.log('\nD. heartbeat — a live holder is not stealable past TTL');

  await checkAsync('D1 heartbeat() refreshes acquiredAt; a second worker cannot steal the still-held slot', async () => {
    occupancyFake = new FakeOccupancyCollection();
    eventsFake = new FakeEventsCollection();
    const { mod: lease, restore } = freshLease({ GEMINI_VIDEO_MAX_SLOTS: '1' });
    try {
      const scope = 'gemini:test-model-D1';
      const a = await lease.acquire(scope);
      assert.ok(a, 'worker A must win the only slot');
      assert.strictEqual(typeof a.heartbeat, 'function', 'the handle must expose heartbeat()');

      const doc = occupancyFake.docs.get(`${scope}::${a.slot}`);
      const staleAt = new Date(Date.now() - lease.LEASE_TTL_MS - 10_000);
      doc.acquiredAt = staleAt;
      // Age the rate-ledger row out of the window so B is not denied by
      // constraint (b). Without this, MAX_SLOTS=1 would make B return null
      // because of the rate cap even if occupancy WERE stealable — a
      // vacuous pass that would not prove heartbeat does anything.
      for (const row of eventsFake.rows) {
        row.acquiredAt = new Date(Date.now() - 120_000);
      }

      assert.ok(doc.acquiredAt < new Date(Date.now() - lease.LEASE_TTL_MS),
        'test setup: A is currently stale (would be stealable without heartbeat)');

      const beatOk = await a.heartbeat();
      assert.strictEqual(beatOk, true, 'heartbeat must match A\'s still-held row');
      assert.ok(doc.acquiredAt.getTime() !== staleAt.getTime(), 'heartbeat must have written a new acquiredAt');
      assert.ok(doc.acquiredAt > new Date(Date.now() - 5_000), 'refreshed acquiredAt is recent');

      const b = await lease.acquire(scope);
      assert.strictEqual(b, null, 'worker B must NOT steal a heartbeating holder, even if acquiredAt was previously past TTL');
    } finally { restore(); }
  });

  await checkAsync('D2 heartbeat after release (or steal) is a no-op and does not resurrect the slot', async () => {
    occupancyFake = new FakeOccupancyCollection();
    eventsFake = new FakeEventsCollection();
    const { mod: lease, restore } = freshLease({ GEMINI_VIDEO_MAX_SLOTS: '1' });
    try {
      const scope = 'gemini:test-model-D2';
      const a = await lease.acquire(scope);
      await a.release();
      const doc = occupancyFake.docs.get(`${scope}::${a.slot}`);
      const releasedAt = doc.releasedAt;
      const beatOk = await a.heartbeat();
      assert.strictEqual(beatOk, false, 'heartbeat on a released handle must report false');
      assert.strictEqual(doc.releasedAt, releasedAt, 'heartbeat must not clear releasedAt');
    } finally { restore(); }
  });

  await checkAsync('C5 no Mongo connection at all (readyState !== 1) denies the lease', async () => {
    const savedReadyState = mongoose.connection.readyState;
    mongoose.connection.readyState = 0;
    const { mod: lease, restore } = freshLease({ GEMINI_VIDEO_MAX_SLOTS: '8' });
    try {
      const result = await lease.acquire('gemini:test-model-C5');
      assert.strictEqual(result, null);
    } finally {
      mongoose.connection.readyState = savedReadyState;
      restore();
    }
  });

  console.log('');
  if (failures.length) {
    console.log(`❌ geminiVideoLease: ${failures.length} FAILED, ${pass} passed\n`);
    for (const f of failures) console.log(`   • ${f}`);
    process.exit(1);
  }
  console.log(`✅ geminiVideoLease: ${pass} checks passed\n`);
})().catch((err) => {
  console.error('verifyGeminiVideoLease crashed:', err);
  process.exit(1);
});
