#!/usr/bin/env node
'use strict';
//
// verifyDurableCostReconcile — durable backstop for CostLog rows stuck on
// costSource:'estimated' after the owning process died (deploy SIGTERM,
// OOM, crash) during the in-process setTimeout reconcile chain
// (~521s / ~8.7 min in atlasImageService.scheduleCostReconcile and
// atlasVideoService.scheduleVideoCostReconcile).
//
// THE DEFECT. That timer chain is the ONLY mechanism that upgrades a
// charge-point CostLog row from estimate → Atlas's settled price. The
// chain lives in process memory. When the process dies, the chain is
// gone and the row stays estimated forever — frequently ~33% HIGH
// (video MODEL_CAPS) or ~7x LOW (image base_price). Persistence has to
// live in the CostLog row itself (discoverable by any fresh process),
// not in an in-memory timer.
//
// WHAT THIS PINS (executing the REAL exported functions against
// scripts/lib/miniMongoStub.js — no live DB, no network, no API key):
//   1. Durable across a simulated restart (Process A dies without ever
//      creating a timer; Process B, sharing only the DB stub, finds and
//      reconciles the orphan).
//   2. Sweep reconciles a completed/settled prediction (estimated →
//      actual, costUsd = settled price, summary.reconciled).
//   3. Sweep does nothing to a still-pending prediction (peek returns
//      null → reconcileCost NOT invoked, row unchanged, stillPending).
//   4. buildReconcileFilter inclusion/exclusion (age bounds, already-
//      actual, null providerRequestId, non-atlas provider, and the
//      atlasLlmStreamService false-positive shape).
//   5. No double-reconciliation: a second pass finds ZERO rows (peek
//      not called, costUsd unchanged) because the filter requires
//      costSource:'estimated'.
//   6. No leak: a settled row no longer matches buildReconcileFilter.
//
// Plus a structural pin that renderer.js wires startCostReconcileSweep
// the same way as the other two sweeps (run / shutdown / unref / gate).
//
// Revert-prove (run by hand; this script does not mutate production files):
//   drop costSource:'estimated' from buildReconcileFilter → 5/6 fail
//   drop providerRequestId $ne:null → 4 (LLM false-positive) fails
//   skip the renderer.js run() assignment → W2 fails

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { MiniCollection, matches } = require('./lib/miniMongoStub');

const ROOT = path.join(__dirname, '..');
const COST_SOURCES = ['actual', 'estimated', 'unknown', 'none'];
const MIN_AGE_MS = 600_000;       // 10 min — past the old ~521s chain
const MAX_AGE_MS = 172_800_000;   // 48h

let pass = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log(`  ✗ ${name}: ${err.message}`);
  }
}

function makeCol(docs) {
  const col = new MiniCollection(docs);
  col.COST_SOURCES = COST_SOURCES;
  return col;
}

function estimatedAtlasRow(overrides) {
  return {
    _id: 'cl-1',
    provider: 'atlas',
    providerRequestId: 'pred-1',
    costSource: 'estimated',
    costUsd: 1.20,
    stage: 'video_render',
    model: 'google/gemini-omni-flash/image-to-video-developer',
    createdAt: new Date(Date.now() - 20 * 60 * 1000),
    ...overrides
  };
}

// The REAL classification helpers, extracted from atlasVideoService's live
// source and evaluated in isolation.
//
// costReconcileSweep.classifyRow lazy-requires `./atlasVideoService` for
// confirmedCharge / SETTLED_POLL_STATUSES / TERMINAL_OK_STATUSES. That module
// pulls in axios, which a bare worktree does not have — and the whole verify
// suite runs bare. The tempting fix is to inject a stub `classify`, but then
// the harness would be testing its own restatement of the classifier instead
// of the classifier, which is the exact "oracle shares the bug" failure this
// file exists to avoid.
//
// So we run the REAL functions. They are small, pure, and dependency-free
// (confirmedCharge reads only SETTLED_POLL_STATUSES), so evaluating their live
// source is running the shipped logic, not a copy of it. Extraction is
// asserted — a rename or reshape fails loudly here rather than silently
// downgrading every classifier check to a stub.
function loadRealAtlasClassifiers() {
  const src = fs.readFileSync(path.join(ROOT, 'src/services/atlasVideoService.js'), 'utf8');

  function slice(startNeedle, endNeedle) {
    const i = src.indexOf(startNeedle);
    assert.ok(i > 0, `atlasVideoService no longer contains ${JSON.stringify(startNeedle)} — `
      + 'costReconcileSweep.classifyRow requires it by name, so this is a real break.');
    const j = src.indexOf(endNeedle, i);
    assert.ok(j > i, `could not bound ${JSON.stringify(startNeedle)} — its shape changed`);
    return src.slice(i, j + endNeedle.length);
  }

  const sets = slice('const TERMINAL_FAILURE_STATUSES = new Set([', '\n]);')
    + '\n' + slice('const TERMINAL_OK_STATUSES = new Set(', ');')
    + '\n' + slice('const SETTLED_POLL_STATUSES = new Set([', '\n]);');
  const fn = slice('function confirmedCharge(data) {', '\n}');

  // eslint-disable-next-line no-new-func
  const mod = new Function(`${sets}\n${fn}\nreturn { confirmedCharge, SETTLED_POLL_STATUSES, TERMINAL_OK_STATUSES, TERMINAL_FAILURE_STATUSES };`)();

  // Positive controls FIRST: a broken extraction must not make the negative
  // assertions below pass for the wrong reason.
  assert.strictEqual(typeof mod.confirmedCharge, 'function', 'extraction did not yield confirmedCharge');
  assert.ok(mod.TERMINAL_OK_STATUSES.has('completed'), 'TERMINAL_OK_STATUSES lost "completed"');
  assert.ok(mod.SETTLED_POLL_STATUSES.has('failed'), 'SETTLED_POLL_STATUSES lost "failed"');
  assert.ok(!mod.SETTLED_POLL_STATUSES.has('processing'), 'SETTLED_POLL_STATUSES wrongly contains "processing"');
  assert.deepStrictEqual(mod.confirmedCharge({ status: 'failed' }), { charged: false, priceUsd: 0 },
    'confirmedCharge no longer reports a priceless terminal failure as unbilled');
  assert.deepStrictEqual(mod.confirmedCharge({ status: 'processing' }), { charged: null, priceUsd: null },
    'confirmedCharge no longer refuses to judge a non-terminal record');
  return mod;
}

async function withSweep(col, fn) {
  const costLogPath = require.resolve(path.join(ROOT, 'src/models/CostLog'));
  const trackerPath = require.resolve(path.join(ROOT, 'src/services/costTracker'));
  const sweepPath = require.resolve(path.join(ROOT, 'src/services/costReconcileSweep'));
  const atlasPath = require.resolve(path.join(ROOT, 'src/services/atlasVideoService'));
  const prev = {
    costLog: require.cache[costLogPath],
    tracker: require.cache[trackerPath],
    sweep: require.cache[sweepPath],
    atlas: require.cache[atlasPath]
  };
  require.cache[atlasPath] = {
    id: atlasPath,
    filename: atlasPath,
    loaded: true,
    exports: loadRealAtlasClassifiers()
  };
  require.cache[costLogPath] = {
    id: costLogPath,
    filename: costLogPath,
    loaded: true,
    exports: col
  };
  delete require.cache[trackerPath];
  delete require.cache[sweepPath];
  try {
    const sweep = require(sweepPath);
    const costTracker = require(trackerPath);
    return await fn({ col, sweep, costTracker });
  } finally {
    if (prev.costLog) require.cache[costLogPath] = prev.costLog;
    else delete require.cache[costLogPath];
    if (prev.tracker) require.cache[trackerPath] = prev.tracker;
    else delete require.cache[trackerPath];
    if (prev.sweep) require.cache[sweepPath] = prev.sweep;
    else delete require.cache[sweepPath];
    if (prev.atlas) require.cache[atlasPath] = prev.atlas;
    else delete require.cache[atlasPath];
  }
}

function sweepOpts(extra) {
  return { now: Date.now(), minAgeMs: MIN_AGE_MS, maxAgeMs: MAX_AGE_MS, ...extra };
}

async function main() {
  console.log('\nverifyDurableCostReconcile\n');

  // ── 1. Durable across a simulated restart ──────────────────────────
  console.log('1. durable across a simulated restart (the core of this fix)');
  await check('1a Process A leaves an orphaned estimated row (no timer ever created)', async () => {
    const now = Date.now();
    const col = makeCol([estimatedAtlasRow({
      _id: 'cl-orphan',
      providerRequestId: 'pred-A',
      costUsd: 1.20,
      createdAt: new Date(now - 20 * 60 * 1000)
    })]);
    // Process A: the row exists in the durable store and is still
    // estimated. We deliberately do NOT create or invoke any
    // setTimeout/scheduleCostReconcile — that IS the bug being fixed
    // (nothing else would have found this row under the old mechanism).
    const row = col.docs.find((d) => d.providerRequestId === 'pred-A');
    assert.ok(row, 'Process A must persist the charge-point row');
    assert.strictEqual(row.costSource, 'estimated');
    assert.strictEqual(row.costUsd, 1.20);
    assert.strictEqual(row.provider, 'atlas');
  });

  await check('1b Process B (fresh process, shared DB only) finds the orphan and settles it', async () => {
    const now = Date.now();
    const col = makeCol([estimatedAtlasRow({
      _id: 'cl-orphan',
      providerRequestId: 'pred-A',
      costUsd: 1.20,
      createdAt: new Date(now - 20 * 60 * 1000)
    })]);
    assert.strictEqual(col.docs[0].costSource, 'estimated', 'precondition: still estimated');

    // Process B: COMPLETELY FRESH require of the sweep module. The only
    // shared state with Process A is the DB stub itself — no leftover
    // timers, no in-memory chain.
    await withSweep(col, async ({ sweep, costTracker }) => {
      const peekCalls = [];
      const out = await sweep.sweepCostReconcile(sweepOpts({
        now,
        peek: async (id) => { peekCalls.push(id); return { httpStatus: 200, data: { status: 'completed', price: 0.90 } }; },
        reconcile: costTracker.reconcileCost
      }));
      assert.deepStrictEqual(peekCalls, ['pred-A'], 'Process B must discover pred-A from the DB row, not from a timer');
      assert.strictEqual(out.considered, 1);
      assert.strictEqual(out.reconciled, 1);
      assert.strictEqual(out.stillPending, 0);
      assert.strictEqual(out.errors, 0);
      const row = col.docs.find((d) => d.providerRequestId === 'pred-A');
      assert.strictEqual(row.costSource, 'actual');
      assert.strictEqual(row.costUsd, 0.90);
    });
  });

  // ── 2. Sweep reconciles a completed/settled prediction ─────────────
  console.log('\n2. sweep reconciles a completed/settled prediction');
  await check('2a estimated → actual, costUsd set to settled price, summary.reconciled', async () => {
    const now = Date.now();
    const col = makeCol([estimatedAtlasRow({
      providerRequestId: 'pred-settled',
      costUsd: 0.01,           // image base_price floor, ~7x LOW
      createdAt: new Date(now - 20 * 60 * 1000)
    })]);
    assert.strictEqual(col.docs[0].costSource, 'estimated', 'BEFORE: must be estimated (vacuous-pass guard)');
    const beforeUsd = col.docs[0].costUsd;

    await withSweep(col, async ({ sweep, costTracker }) => {
      const out = await sweep.sweepCostReconcile(sweepOpts({
        now,
        peek: async () => ({ httpStatus: 200, data: { status: 'completed', price: 0.072272 } }),
        reconcile: costTracker.reconcileCost
      }));
      assert.strictEqual(out.reconciled, 1, `expected reconciled=1, got ${out.reconciled}`);
      assert.strictEqual(out.considered, 1);
      const row = col.docs[0];
      assert.strictEqual(row.costSource, 'actual', 'AFTER: must be actual');
      assert.strictEqual(row.costUsd, 0.072272);
      assert.notStrictEqual(row.costUsd, beforeUsd, 'settled price must replace the estimate');

      // MONEY: the write is the real reconcileCost filter — estimated-only
      // $set, never an insert, never a $inc.
      const writes = col.calls.filter((c) => c.op === 'updateOne');
      assert.ok(writes.length >= 1, 'reconcileCost must have issued updateOne');
      const w = writes[writes.length - 1];
      assert.strictEqual(w.filter.providerRequestId, 'pred-settled');
      assert.strictEqual(w.filter.costSource, 'estimated');
      assert.strictEqual(w.update.$set.costSource, 'actual');
      assert.strictEqual(w.update.$set.costUsd, 0.072272);
      assert.strictEqual(w.update.$inc, undefined, 'must not $inc spend');
    });
  });

  // ── 3. Sweep does nothing to a still-pending prediction ────────────
  console.log('\n3. sweep does nothing to a still-pending prediction');
  await check('3a peek=null → reconcileCost NOT invoked, row unchanged, stillPending (and peek WAS called)', async () => {
    const now = Date.now();
    const col = makeCol([estimatedAtlasRow({
      providerRequestId: 'pred-pending',
      costUsd: 1.20,
      createdAt: new Date(now - 20 * 60 * 1000)
    })]);
    assert.strictEqual(col.docs[0].costSource, 'estimated');

    await withSweep(col, async ({ sweep, costTracker }) => {
      const peekCalls = [];
      let reconcileCalls = 0;
      const realReconcile = costTracker.reconcileCost.bind(costTracker);
      const out = await sweep.sweepCostReconcile(sweepOpts({
        now,
        peek: async (id) => { peekCalls.push(id); return { httpStatus: 200, data: { status: 'processing' } }; },
        reconcile: async (...args) => {
          reconcileCalls++;
          return realReconcile(...args);
        }
      }));
      assert.deepStrictEqual(peekCalls, ['pred-pending'], 'still-pending path must actually call peek (not just miss the query)');
      assert.strictEqual(reconcileCalls, 0, 'reconcileCost must not run when Atlas has no price yet');
      assert.strictEqual(out.stillPending, 1);
      assert.strictEqual(out.reconciled, 0);
      assert.strictEqual(out.considered, 1);
      const row = col.docs[0];
      assert.strictEqual(row.costSource, 'estimated', 'costSource must stay estimated');
      assert.strictEqual(row.costUsd, 1.20, 'costUsd must stay the estimate');
    });
  });

  // 3b — the sweep's OWN price guard, not the one upstream of it.
  //
  // Added after a mutation escape: weakening the sweep's
  // `price != null && Number.isFinite(price) && price > 0` to a bare
  // `price != null` left this harness fully GREEN. Nothing here covered it.
  //
  // Today that guard is defence-in-depth — `peekSettledPrice` returns
  // `parseAtlasSettledPrice(...)`, which already rejects `<= 0` and
  // non-finite. But it is worth pinning for two concrete reasons:
  //
  //   1. `costTracker.reconcileCost` validates only `Number.isFinite(...)`,
  //      and `Number.isFinite(0) === true` — so a 0 that reaches it IS
  //      written. The sweep's guard is the last thing standing between a
  //      bad peek and a $0 ledger row, and "$0 CostLog rows" is a defect
  //      class this repo has actually shipped before (the image
  //      `base_price` key bug put EVERY image CostLog at $0).
  //   2. `peek` is an INJECTED parameter. Any future caller that supplies
  //      its own peek is not protected by `parseAtlasSettledPrice` at all.
  //
  // So this drives the REAL sweep with a peek that violates the contract
  // and asserts the write never happens.
  await check('3b an UNUSABLE price (negative / NaN / Infinity / non-numeric) NEVER reaches the write', async () => {
    // NOTE: 0 is deliberately NOT in this list — see 3d. A price of exactly 0
    // that Atlas has PUBLISHED on a completed prediction is a real figure and
    // is written; that is different from INFERRING 0 from a failure with no
    // price, which is report-only (3e). This split is backend classifyRow's
    // (`n >= 0` on the success arm, `charged === false` on the failure arm)
    // and is mirrored deliberately rather than re-derived.
    for (const bad of [-1, -0.5, NaN, Infinity, -Infinity, '', 'abc', {}, []]) {
      const now = Date.now();
      const col = makeCol([estimatedAtlasRow({
        providerRequestId: 'pred-badprice',
        costUsd: 1.20,
        createdAt: new Date(now - 20 * 60 * 1000)
      })]);

      await withSweep(col, async ({ sweep }) => {
        const peekCalls = [];
        const reconcileArgs = [];
        const out = await sweep.sweepCostReconcile(sweepOpts({
          now,
          peek: async (id) => { peekCalls.push(id); return { httpStatus: 200, data: { status: 'completed', price: bad } }; },
          reconcile: async (args) => { reconcileArgs.push(args); return true; }
        }));

        const label = typeof bad === 'object' && bad !== null
          ? JSON.stringify(bad)
          : String(bad);

        // The row must have been a candidate and peeked — otherwise this
        // check could pass vacuously by never reaching the guard at all.
        assert.strictEqual(out.considered, 1, `[peek=${label}] row must be a candidate (else this check is vacuous)`);
        assert.deepStrictEqual(peekCalls, ['pred-badprice'], `[peek=${label}] peek must actually have been called`);

        assert.deepStrictEqual(reconcileArgs, [],
          `[peek=${label}] reconcileCost was invoked with a non-positive/non-finite price. `
          + 'costTracker.reconcileCost only checks Number.isFinite, and Number.isFinite(0) is true, '
          + 'so this would $set a $0 (or garbage) costUsd onto a real billed generation.');
        assert.strictEqual(out.reconciled, 0, `[peek=${label}] must not count as reconciled`);
        assert.strictEqual(out.stillPending, 1, `[peek=${label}] must be counted stillPending, so a later real price can land`);
        assert.strictEqual(out.errors, 0, `[peek=${label}] a bad price is "unknown", not an error`);

        const row = col.docs[0];
        assert.strictEqual(row.costSource, 'estimated', `[peek=${label}] costSource must stay estimated`);
        assert.strictEqual(row.costUsd, 1.20, `[peek=${label}] costUsd must stay the estimate, untouched`);
      });
    }
  });

  // 3g — THE DEFECT THIS REWRITE EXISTS TO CLOSE, stated as behaviour.
  //
  // The original sweep gated eligibility on AGE (minAgeMs 10 min), on the
  // premise that this sat past the in-process reconcile chain. It did not:
  // scheduleCostReconcile / scheduleVideoCostReconcile are scheduled at a
  // TERMINAL outcome and then sleep 523s, and video MAX_POLL_MS is 900s — so
  // a row 10 minutes old can still be an IN-FLIGHT prediction. Peeking that
  // and writing a partial price as 'actual' locks the row, after which the
  // real settled figure is refused.
  //
  // This is pinned as behaviour, not as a line: a non-terminal record must
  // not be written EVEN IF it carries a price, and EVEN IF the row is old.
  // Two independent guards enforce it (classifyRow's SETTLED_POLL_STATUSES
  // arm, and confirmedCharge's own refusal to judge a non-terminal record),
  // so no single-line mutation can break it — which is the point.
  await check('3g [MONEY] an IN-FLIGHT prediction is never written, even with a price and an old row', async () => {
    for (const status of ['processing', 'queued', 'starting', 'running', '', 'unknown']) {
      const now = Date.now();
      const col = makeCol([estimatedAtlasRow({
        _id: 'cl-inflight', providerRequestId: 'pred-inflight', costUsd: 1.20,
        // Deliberately far past every age bound — age must not be what saves us.
        createdAt: new Date(now - 24 * 60 * 60 * 1000)
      })]);
      await withSweep(col, async ({ sweep }) => {
        const reconcileArgs = [];
        const out = await sweep.sweepCostReconcile(sweepOpts({
          now,
          peek: async () => ({ httpStatus: 200, data: { status, price: 0.42 } }),
          reconcile: async (args) => { reconcileArgs.push(args); return true; }
        }));
        assert.strictEqual(out.considered, 1,
          `[status=${status || '(empty)'}] row must be a candidate (else this check is vacuous)`);
        assert.deepStrictEqual(reconcileArgs, [],
          `[status=${status || '(empty)'}] a NON-TERMINAL prediction reached the write. Its price is not `
          + 'final; writing it flips costSource to actual and reconcileCost then REFUSES the real '
          + 'settled figure forever. Terminal status is the gate — age is not.');
        assert.strictEqual(col.docs[0].costSource, 'estimated');
        assert.strictEqual(col.docs[0].costUsd, 1.20);
      });
    }
  });

  // 3h — THE MONEY GATE, by name, with its whole coercion table.
  //
  // isPublishedPrice is the single predicate that separates the two states
  // which must never blur:
  //
  //   PUBLISHED zero → transcription. Atlas said 0. Written.
  //   ABSENT price   → inference. We would be guessing 0. Report-only.
  //
  // It must decide by TYPE and literal form, never by coercion, because
  // Number() collapses several "absent" shapes onto 0 — and every one of
  // those reaching a `>= 0` test writes a settled $0 over a real estimate.
  //
  // A JSON-number-only gate is NOT correct here and was explicitly checked:
  // Atlas sends price as a STRING (measured "0.9", "0.75" — see
  // atlasVideoService.parseAtlasSettledPrice's own note), so number-only
  // would route every real price to report-only and disable the fix.
  await check('3h [MONEY GATE] isPublishedPrice separates a PUBLISHED zero from an ABSENT price by type, never by coercion', async () => {
    await withSweep(makeCol([]), async ({ sweep }) => {
      assert.strictEqual(typeof sweep.isPublishedPrice, 'function',
        'isPublishedPrice must be exported so this asserts the REAL gate, not a restatement');

      // [value, expected, why]
      const table = [
        [0,        true,  'a published numeric zero — transcription, not inference'],
        [0.9,      true,  'ordinary numeric price'],
        ['0',      true,  'published zero as a STRING — Atlas sends prices as strings'],
        ['0.9',    true,  'the measured Atlas shape'],
        ['0.75',   true,  'the measured Atlas shape'],
        ['-1',     true,  'well-formed literal; the sign is rejected later by n >= 0, not here'],
        [-1,       true,  'well-formed number; sign rejected by n >= 0'],
        ['',       false, 'empty string is an ABSENT price'],
        [' ',      false, 'whitespace coerces to 0 via Number(" ") — must NOT be read as a published zero'],
        ['\n',     false, 'newline coerces to 0 — same hole'],
        ['\t  ',   false, 'mixed whitespace coerces to 0 — same hole'],
        ['abc',    false, 'non-numeric string'],
        [null,     false, 'Number(null) === 0'],
        [undefined, false, 'absent key'],
        [[],       false, 'Number([]) === 0 — the backend hole'],
        [[5],      false, 'Number([5]) === 5 — an array is never a published price'],
        [[1, 2],   false, 'Number([1,2]) === NaN'],
        [{},       false, 'object'],
        [true,     false, 'Number(true) === 1'],
        [false,    false, 'Number(false) === 0'],
        [NaN,      false, 'not finite'],
        [Infinity, false, 'not finite']
      ];

      for (const [raw, expected, why] of table) {
        const got = sweep.isPublishedPrice(raw);
        const lbl = typeof raw === 'string' ? JSON.stringify(raw)
          : (raw && typeof raw === 'object') ? JSON.stringify(raw) : String(raw);
        assert.strictEqual(got, expected,
          `isPublishedPrice(${lbl}) === ${got}, expected ${expected} — ${why}. `
          + (expected === false
            ? `Number(${lbl}) is ${String(Number(raw))}, so a coercion-based gate would treat this as a published price and write a settled $0 over a real estimate.`
            : 'Rejecting this routes a genuine Atlas price to the report-only path and disables the success arm.'));
      }
    });
  });

  // 3i — the gate's two halves must stay wired to the two different outcomes.
  await check('3i [MONEY] a whitespace price is REPORT-ONLY, not a written $0 (the coercion hole, end to end)', async () => {
    for (const absent of [' ', '\n', '', [], {}, null]) {
      const now = Date.now();
      const col = makeCol([estimatedAtlasRow({
        _id: 'cl-ws', providerRequestId: 'pred-ws', costUsd: 1.20,
        createdAt: new Date(now - 20 * 60 * 1000)
      })]);
      await withSweep(col, async ({ sweep }) => {
        const reconcileArgs = [];
        const out = await sweep.sweepCostReconcile(sweepOpts({
          now,
          peek: async () => ({ httpStatus: 200, data: { status: 'completed', price: absent } }),
          reconcile: async (args) => { reconcileArgs.push(args); return true; }
        }));
        const lbl = typeof absent === 'string' ? JSON.stringify(absent) : JSON.stringify(absent);
        assert.strictEqual(out.considered, 1, `[price=${lbl}] row must be a candidate`);
        assert.deepStrictEqual(reconcileArgs, [],
          `[price=${lbl}] an ABSENT price reached the write. Number(${lbl}) is ${String(Number(absent))}, `
          + 'so this would have settled a real billed generation to $0.');
        assert.strictEqual(col.docs[0].costUsd, 1.20);
        assert.strictEqual(col.docs[0].costSource, 'estimated');
      });
    }
  });

  // 3d — the ONE path on which this sweep can automatically REDUCE a ledger
  // figure. Named explicitly so it can never happen silently.
  //
  // A *completed* prediction whose payload carries `price: 0` is Atlas
  // stating the figure. That is written. It is categorically different from
  // 3e, where a *failed* prediction with NO price lets confirmedCharge INFER
  // that nothing was billed — inference is report-only, because a wrong $0
  // erases spend irrecoverably.
  await check('3d [LEDGER-REDUCING] a PUBLISHED price of 0 on a completed prediction IS written (Atlas\'s own figure)', async () => {
    const now = Date.now();
    const col = makeCol([estimatedAtlasRow({
      _id: 'cl-zero', providerRequestId: 'pred-zero', costUsd: 1.20,
      createdAt: new Date(now - 20 * 60 * 1000)
    })]);
    await withSweep(col, async ({ sweep }) => {
      const out = await sweep.sweepCostReconcile(sweepOpts({
        now,
        peek: async () => ({ httpStatus: 200, data: { status: 'completed', price: 0 } })
      }));
      assert.strictEqual(out.reconciled, 1, 'a published 0 is a real settled figure and must be written');
      assert.strictEqual(out.reportedUnbilled, 0, 'a published 0 is not the inferred-unbilled class');
      assert.strictEqual(col.docs[0].costUsd, 0);
      assert.strictEqual(col.docs[0].costSource, 'actual',
        'a published 0 settles to actual, never to the inferred \'none\'');
    });
  });

  // 3e — THE RULING. The inferred-unbilled class is reported, never written.
  await check('3e [MONEY] an INFERRED $0 (terminal failure, no price) is REPORTED and never written', async () => {
    const now = Date.now();
    const col = makeCol([estimatedAtlasRow({
      _id: 'cl-unbilled', providerRequestId: 'pred-unbilled', costUsd: 1.20,
      createdAt: new Date(now - 20 * 60 * 1000)
    })]);
    await withSweep(col, async ({ sweep }) => {
      const reconcileArgs = [];
      const out = await sweep.sweepCostReconcile(sweepOpts({
        now,
        // A terminal failure with no price. confirmedCharge reads this as
        // charged:false — which backend's script would write to $0/'none'.
        peek: async () => ({ httpStatus: 200, data: { status: 'failed' } }),
        reconcile: async (args) => { reconcileArgs.push(args); return true; }
      }));
      assert.strictEqual(out.considered, 1, 'row must be a candidate (else this check is vacuous)');
      assert.deepStrictEqual(reconcileArgs, [],
        'the inferred-unbilled arm reached the WRITE. A wrong $0 erases real spend irrecoverably, '
        + 'whereas leaving the row estimated merely over-reports and is correctable. This arm is '
        + 'report-only by owner ruling — emit it for a human to run through '
        + 'scripts/backfillCostReconcile.js in the liquidretail_backend repo.');
      assert.strictEqual(out.reportedUnbilled, 1, 'it must still be REPORTED, not silently dropped');
      assert.strictEqual(out.reconciled, 0);
      assert.strictEqual(col.docs[0].costUsd, 1.20, 'the estimate must stand untouched');
      assert.strictEqual(col.docs[0].costSource, 'estimated');
    });
  });

  // 3f — providerRequestId is index:true but NOT unique (src/models/CostLog.js).
  // The sweep has row._id and must pin it, or an updateOne can settle a
  // different row than the one it peeked.
  await check('3f [MONEY] the write is pinned to row._id, not just providerRequestId (which is not unique)', async () => {
    const now = Date.now();
    const shared = 'pred-shared';
    // The discrimination here is deliberate and fragile-looking on purpose.
    //
    // A naive version of this check — two eligible rows, assert the peeked
    // one changed — proves NOTHING, because the row the sweep selects and the
    // row an unpinned `updateOne` lands on are the same row (both the first
    // the collection yields). I wrote that version first and mutating the
    // filter left it green.
    //
    // So `cl-decoy` is placed FIRST and made INELIGIBLE for the sweep (too
    // young for the minAge window) while still matching a filter of
    // {providerRequestId, costSource:'estimated'}. The sweep can therefore
    // only ever select `cl-target`, but an unpinned write lands on `cl-decoy`.
    const col = makeCol([
      estimatedAtlasRow({ _id: 'cl-decoy', providerRequestId: shared, costUsd: 2.22, provider: 'atlas',
        createdAt: new Date(now) }),
      estimatedAtlasRow({ _id: 'cl-target', providerRequestId: shared, costUsd: 1.11, provider: 'atlas',
        createdAt: new Date(now - 30 * 60 * 1000) })
    ]);
    await withSweep(col, async ({ sweep }) => {
      const out = await sweep.sweepCostReconcile(sweepOpts({
        now,
        peek: async () => ({ httpStatus: 200, data: { status: 'completed', price: 0.5 } })
      }));
      assert.strictEqual(out.considered, 1,
        'only the eligible row may be considered — if this is 2 the decoy entered the window and '
        + 'the check no longer discriminates');
      assert.strictEqual(out.reconciled, 1);
      const target = col.docs.find((d) => d._id === 'cl-target');
      const decoy  = col.docs.find((d) => d._id === 'cl-decoy');
      assert.strictEqual(target.costUsd, 0.5, 'the peeked row must be the one settled');
      assert.strictEqual(target.costSource, 'actual');
      assert.strictEqual(decoy.costUsd, 2.22,
        'a DIFFERENT row sharing the same providerRequestId was overwritten. providerRequestId is '
        + 'index:true but NOT unique (src/models/CostLog.js), so an updateOne that does not pin _id '
        + 'can settle a row it never peeked — here, one that was not even eligible.');
      assert.strictEqual(decoy.costSource, 'estimated');
    });
  });

  // 3c — the upstream guard 3b backs up. Pins that parseAtlasSettledPrice
  // really is the first line of defence, so 3b's "defence-in-depth"
  // framing cannot silently go stale.
  //
  // It cannot simply `require('../src/services/atlasVideoService')`: that
  // module needs axios, which a bare worktree does not have, and the whole
  // suite runs bare. A try/require/skip was the first shape of this check
  // and it was WORSE THAN NOTHING — it printed a green tick while testing
  // nothing at all. Proven: mutating `n <= 0` out of the real function left
  // the check GREEN.
  //
  // So this extracts the REAL current source of the function and evaluates
  // it in isolation. That is legitimate here because the target is a small
  // pure numeric function with no dependencies — we are running the live
  // text, not a restatement of it. The extraction itself is asserted, so a
  // rename or a reshape fails loudly instead of skipping.
  await check('3c parseAtlasSettledPrice rejects 0, negatives and non-finite (the guard 3b backs up)', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'services', 'atlasVideoService.js'), 'utf8');

    const start = src.indexOf('function parseAtlasSettledPrice(');
    assert.ok(start > 0,
      'parseAtlasSettledPrice is gone from atlasVideoService.js. costReconcileSweep.peekSettledPrice '
      + 'requires it by name, so this is a real break — re-derive 3b\'s defence-in-depth claim.');

    // Bound the slice at the function's own closing brace (column 0 `}`),
    // not a character count that would drift stale as the file changes.
    const end = src.indexOf('\n}\n', start);
    assert.ok(end > start, 'could not bound parseAtlasSettledPrice — its shape changed');
    const fnSrc = src.slice(start, end + 3);

    // eslint-disable-next-line no-new-func
    const parse = new Function(`${fnSrc}; return parseAtlasSettledPrice;`)();
    assert.strictEqual(typeof parse, 'function', 'extraction did not yield a callable');

    // Positive control FIRST: if this fails, the extraction is broken and
    // every negative assertion below would pass for the wrong reason.
    assert.strictEqual(parse(0.45), 0.45, 'positive control: a real price must pass through');
    assert.strictEqual(parse('0.45'), 0.45, 'positive control: a numeric string price must parse');

    for (const bad of [0, '0', -1, '-1', -0.5, NaN, 'abc', '', null, undefined, Infinity, -Infinity]) {
      assert.strictEqual(parse(bad), null,
        `parseAtlasSettledPrice(${JSON.stringify(bad)}) must be null — it is what stops a $0 `
        + 'or garbage price reaching costTracker.reconcileCost, whose only check is Number.isFinite.');
    }
  });

  // ── 4. buildReconcileFilter correctness ────────────────────────────
  console.log('\n4. buildReconcileFilter correctness (pure)');
  await withSweep(makeCol([]), async ({ sweep }) => {
    const now = Date.now();
    const filter = sweep.buildReconcileFilter({ now, minAgeMs: MIN_AGE_MS, maxAgeMs: MAX_AGE_MS });

    await check('4a excludes a too-young row (inside minAgeMs — still in the live timer window)', () => {
      const row = estimatedAtlasRow({ createdAt: new Date(now - 60_000) });
      assert.ok(!matches(row, filter), 'a 1-minute-old row must not be swept (live chain may still be running)');
    });

    await check('4b excludes a too-old row (past maxAgeMs — permanently unresolvable, stop polling)', () => {
      const row = estimatedAtlasRow({ createdAt: new Date(now - (MAX_AGE_MS + 60_000)) });
      assert.ok(!matches(row, filter), 'a 48h+ row must drop out so we do not poll forever');
    });

    await check('4c excludes a costSource:\'actual\' row', () => {
      const row = estimatedAtlasRow({ costSource: 'actual', costUsd: 0.90 });
      assert.ok(!matches(row, filter), 'already-settled rows must not re-enter the sweep');
    });

    await check('4d excludes providerRequestId:null (atlasLlmStreamService false-positive shape)', () => {
      // atlasLlmStreamService.recordFlatCost sets provider:'atlas' and
      // defaults costSource:'estimated' but never sets providerRequestId.
      // The $ne:null discriminator is what keeps those rows out.
      const row = estimatedAtlasRow({ providerRequestId: null, stage: 'creative_director' });
      assert.ok(!matches(row, filter), 'LLM flat-cost rows must not be treated as Atlas predictions');
    });

    await check('4e excludes a non-\'atlas\' provider row', () => {
      const row = estimatedAtlasRow({ provider: 'openai', providerRequestId: 'pred-openai' });
      assert.ok(!matches(row, filter));
    });

    await check('4f INCLUDES a row that satisfies every condition', () => {
      const row = estimatedAtlasRow({ createdAt: new Date(now - 20 * 60 * 1000) });
      assert.ok(matches(row, filter), 'a 20-minute-old estimated atlas prediction must match');
    });

    await check('4g exported defaults are the 10min / 48h backstop window', () => {
      assert.strictEqual(sweep.DEFAULT_MIN_AGE_MS, MIN_AGE_MS);
      assert.strictEqual(sweep.DEFAULT_MAX_AGE_MS, MAX_AGE_MS);
      assert.ok(filter.createdAt.$lt instanceof Date);
      assert.ok(filter.createdAt.$gt instanceof Date);
      assert.strictEqual(filter.createdAt.$lt.getTime(), now - MIN_AGE_MS);
      assert.strictEqual(filter.createdAt.$gt.getTime(), now - MAX_AGE_MS);
      assert.strictEqual(filter.provider, 'atlas');
      assert.strictEqual(filter.costSource, 'estimated');
      assert.deepStrictEqual(filter.providerRequestId, { $ne: null });
    });
  });

  // ── 5. No double-reconciliation ────────────────────────────────────
  console.log('\n5. no double-reconciliation (money-facing idempotency)');
  await check('5a second pass finds ZERO rows; peek not called; costUsd unchanged', async () => {
    const now = Date.now();
    const col = makeCol([estimatedAtlasRow({
      providerRequestId: 'pred-once',
      costUsd: 1.20,
      createdAt: new Date(now - 20 * 60 * 1000)
    })]);

    await withSweep(col, async ({ sweep, costTracker }) => {
      const peekCalls = [];
      const out1 = await sweep.sweepCostReconcile(sweepOpts({
        now,
        peek: async (id) => { peekCalls.push(id); return { httpStatus: 200, data: { status: 'completed', price: 0.90 } }; },
        reconcile: costTracker.reconcileCost
      }));
      assert.strictEqual(out1.reconciled, 1);
      assert.strictEqual(col.docs[0].costSource, 'actual');
      assert.strictEqual(col.docs[0].costUsd, 0.90);
      assert.deepStrictEqual(peekCalls, ['pred-once']);

      // Second pass: peek would return a DIFFERENT price if called, so a
      // bug that re-reconciles is obvious (costUsd would jump to 9.99).
      const out2 = await sweep.sweepCostReconcile(sweepOpts({
        now,
        peek: async (id) => { peekCalls.push(`SECOND:${id}`); return { httpStatus: 200, data: { status: 'completed', price: 9.99 } }; },
        reconcile: costTracker.reconcileCost
      }));
      assert.strictEqual(out2.considered, 0, 'second pass must query-miss — costSource is no longer estimated');
      assert.strictEqual(out2.reconciled, 0);
      assert.ok(!peekCalls.some((c) => String(c).startsWith('SECOND:')), 'peek must NOT be called on the second pass');
      assert.strictEqual(col.docs[0].costUsd, 0.90, 'costUsd must stay the first settled price, not 9.99');
      assert.strictEqual(col.docs[0].costSource, 'actual');
    });
  });

  // ── 6. No leak ─────────────────────────────────────────────────────
  console.log('\n6. no leak (settled row drops out of the candidate set)');
  await check('6a after reconcile, the row no longer matches buildReconcileFilter', async () => {
    const now = Date.now();
    const col = makeCol([estimatedAtlasRow({
      providerRequestId: 'pred-noleak',
      createdAt: new Date(now - 20 * 60 * 1000)
    })]);

    await withSweep(col, async ({ sweep, costTracker }) => {
      const filter = sweep.buildReconcileFilter({ now, minAgeMs: MIN_AGE_MS, maxAgeMs: MAX_AGE_MS });
      assert.ok(matches(col.docs[0], filter), 'precondition: row must match before settle');
      await sweep.sweepCostReconcile(sweepOpts({
        now,
        peek: async () => ({ httpStatus: 200, data: { status: 'completed', price: 0.90 } }),
        reconcile: costTracker.reconcileCost
      }));
      assert.strictEqual(col.docs[0].costSource, 'actual');
      assert.ok(
        !matches(col.docs[0], filter),
        'a settled row must leave the candidate set via the SAME costSource field the sweep queries — not a separate flag that could fail to clear'
      );
    });
  });

  // ── W. renderer.js lifecycle wiring (structural) ───────────────────
  console.log('\nW. renderer.js wires startCostReconcileSweep like the other two sweeps');
  const rendererSrc = fs.readFileSync(path.join(ROOT, 'src/services/renderer.js'), 'utf8');
  const sweepBody = rendererSrc.match(/function startCostReconcileSweep\(\)\s*\{[\s\S]*?\n\}/);

  await check('W1 startCostReconcileSweep is defined in renderer.js (not only exported from the module)', () => {
    assert.ok(sweepBody, 'startCostReconcileSweep function not found in renderer.js');
  });

  if (sweepBody) {
    const body = sweepBody[0];
    await check('W2 lazy-requires ./costReconcileSweep (not a top-level require)', () => {
      assert.match(body, /require\(['"]\.\/costReconcileSweep['"]\)/);
    });
    await check('W3 calls sweepCostReconcile() inside the tick', () => {
      assert.match(body, /sweepCostReconcile\(\)/);
    });
    await check('W4 reads COST_RECONCILE_INTERVAL_MIN with default 5', () => {
      assert.match(body, /COST_RECONCILE_INTERVAL_MIN[\s\S]*?\|\|\s*5/);
    });
    await check('W5 gated on isAdgenRendererEnabled() (stand down when backend owns the collection)', () => {
      assert.match(body, /isAdgenRendererEnabled\(\)/);
    });
    await check('W6 inFlightPass overlap guard', () => {
      assert.match(body, /inFlightPass\s*=\s*true[\s\S]*?inFlightPass\s*=\s*false/);
    });
    await check('W7 guards against `stopping` (SIGTERM race)', () => {
      assert.match(body, /if\s*\(\s*stopping/);
    });
    await check('W8 setTimeout boot pass + setInterval periodic, both .unref()', () => {
      assert.match(body, /setTimeout\(tick[\s\S]*?setInterval\(tick/);
      assert.match(body, /timeoutHandle\.unref[\s\S]*?intervalHandle\.unref/);
    });
    await check('W9 initial delay is 60s (staggered vs boot-recovery 10s / titling 90s)', () => {
      assert.match(body, /setTimeout\(tick,\s*60\s*\*\s*1000\)/);
    });
    await check('W10 returns { stop() } so shutdown can clear timers', () => {
      assert.match(body, /return\s*\{\s*stop\(\)/);
    });
    await check('W11 promise chain catches errors (fail-open — must not throw)', () => {
      assert.match(body, /\.catch\(/);
      assert.match(body, /\.finally\(/);
    });
  }

  await check('W12 module-level `let costReconcileSweep = null`', () => {
    assert.match(rendererSrc, /let costReconcileSweep\s*=\s*null/);
  });

  const runBody = rendererSrc.match(/async function run\(\)\s*\{[\s\S]*?\n\}/);
  await check('W13 run() assigns costReconcileSweep = startCostReconcileSweep()', () => {
    assert.ok(runBody, 'run() body not found');
    assert.match(runBody[0], /costReconcileSweep\s*=\s*startCostReconcileSweep\(\)/);
  });

  const shutdownBody = rendererSrc.match(/async function shutdown\(\)\s*\{[\s\S]*?\n\}/);
  await check('W14 shutdown() stops costReconcileSweep', () => {
    assert.ok(shutdownBody, 'shutdown() body not found');
    assert.match(shutdownBody[0], /if \(costReconcileSweep\)\s*costReconcileSweep\.stop/);
  });

  const total = pass + failures.length;
  console.log(`\n${failures.length ? '✗' : '✓'} verifyDurableCostReconcile: ${pass}/${total} passed`);
  if (failures.length) {
    console.log('  failed:');
    for (const f of failures) console.log(`   • ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
