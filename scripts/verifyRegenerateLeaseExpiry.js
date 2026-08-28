#!/usr/bin/env node
'use strict';
//
// verifyRegenerateLeaseExpiry — pins the regenerate lease-expiry + receipt-checked
// reclaim fix (Phase A, station-contract elements 3 and 5).
//
// THE DEFECT THIS CLOSES. services/regenerateConsumer.js claimed a deferred
// regenerate with NO lease: a worker that crashed mid-flight left
// regenerateClaimedByWorker set forever, stuck until an operator cleared it by
// hand (confirmed live in production).
//
// WHY A LEASE ALONE WOULD HAVE BEEN A MONEY REGRESSION. A regenerate always runs
// on an ad that ALREADY holds a completed video, so Ad.veoPredictionId is
// essentially always populated BEFORE a regenerate begins — it holds the OLD
// prediction. So "a receipt exists" cannot mean "this attempt paid for
// something", and runVideoFull's generateForAd({allowResume:false}) literal is
// frozen precisely so a regenerate never silently serves the old master back
// (commit 2f99218 / PR #40; pinned by verifyVideoResumeFromReceipt.js C2). This
// fix therefore does NOT widen that flag. Instead:
//
//   1. claimOne arm 1 (fresh claim) snapshots veoPredictionId onto
//      regenerationRequest.priorVeoPredictionId / priorVeoPredictionSetAt in a
//      second, winner-scoped write, before the attempt can touch it.
//   2. claimOne arm 2 (reclaim) takes over a claim older than CLAIM_STALE_MIN,
//      $inc's reclaimCount, and NEVER restamps the baseline.
//   3. runClaimedRegeneration treats a veoPredictionId that DIFFERS from the
//      baseline as the only positive proof the abandoned attempt minted its own
//      Atlas receipt, and peeks it with resumeForAd (a free GET that cannot
//      submit). Anything else falls through to today's dispatch, unchanged.
//
// GROUP A executes the REAL claimOne (module-cache substitution, same technique
// as verifyRegenerateShutdownDrain.js) against a purpose-built atomic stub that
// models $type / $ne / $lt and dotted $set/$inc paths — the shared
// scripts/lib/miniMongoStub.js models none of those, and a claim filter is
// exactly the thing that must not be tested by regex.
//
// GROUP B source-extracts the executor's real decision expressions and evaluates
// them over a matrix (same discipline verifyRegenerateConsumerClaim.js uses for
// the claim filter), then pins that every no-submit branch returns before the
// dispatcher.
//
// GROUP C pins the two structural money invariants this fix leans on, including
// resumeForAd's no-submit guarantee — which three live comments claim is
// enforced by scripts/verifyVideoResume.js, a file that DOES NOT EXIST.
//
// GROUP D executes the REAL runClaimedRegeneration (module-cache
// substitution, same technique as verifyRegenerateInFlightGate.js) and
// walks the real runVideoFull all the way to videoRouter.generateForAd,
// which is stubbed to throw an unsettled-poll-timeout shaped exactly like
// atlasVideoService.resolveTimeoutOutcome. Group B's source-extraction
// cannot catch a defect in a branch that never actually runs — this group
// is the one that would have caught markComplete-on-timeout (wiping the
// reclaim baseline and releasing the claim onto arm 1, which re-snapshots
// the timed-out prediction as if it were the pre-regenerate original).
//
// Offline: no DB, no network, no Atlas key, no node_modules required.

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const CONSUMER_SRC_PATH = path.join(ROOT, 'src/services/regenerateConsumer.js');
const SERVICE_SRC_PATH = path.join(ROOT, 'src/services/adRegenerateService.js');
const ATLAS_SRC_PATH = path.join(ROOT, 'src/services/atlasVideoService.js');

let checks = 0;
const failures = [];
function check(label, fn) {
  try { fn(); checks += 1; console.log(`  ✓ ${label}`); }
  catch (err) { failures.push(`${label}\n     ${err.message}`); console.log(`  ✗ ${label}`); }
}
async function checkAsync(label, fn) {
  try { await fn(); checks += 1; console.log(`  ✓ ${label}`); }
  catch (err) { failures.push(`${label}\n     ${err.message}`); console.log(`  ✗ ${label}`); }
}

// ── balanced-brace source slicing (shared discipline with the sibling harnesses) ──
function balanced(src, openIdx, openCh, closeCh) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === openCh) depth++;
    else if (src[i] === closeCh) { depth--; if (depth === 0) return src.slice(openIdx, i + 1); }
  }
  return null;
}
function functionBody(src, signatureRe) {
  const m = signatureRe.exec(src);
  assert.ok(m, `signature not found: ${signatureRe}`);
  const brace = src.indexOf('{', m.index + m[0].length - 1);
  const body = balanced(src, brace, '{', '}');
  assert.ok(body, `unterminated body for ${signatureRe}`);
  return body;
}

// ═══════════════════════════════════════════════════════════════════════════
// A purpose-built atomic collection. Models exactly the operators the new claim
// filter uses, and THROWS on anything else so an unmodelled operator fails LOUD
// rather than silently matching.
// ═══════════════════════════════════════════════════════════════════════════
function getPath(doc, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), doc);
}
function setPath(doc, dotted, val) {
  const parts = dotted.split('.');
  let cur = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = val;
}
function bsonTypeMatches(val, present, operand) {
  if (!present) return false;
  if (operand === 'object') return val !== null && typeof val === 'object' && !Array.isArray(val) && !(val instanceof Date);
  if (operand === 'date') return val instanceof Date;
  throw new Error(`stub: $type:${operand} not modelled — extend deliberately`);
}
function matchOne(doc, key, cond) {
  const val = getPath(doc, key);
  const present = val !== undefined;
  const isOp = cond !== null && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date);
  if (!isOp) {
    if (cond === null) return val === null || val === undefined;
    return val === cond;
  }
  for (const [op, operand] of Object.entries(cond)) {
    if (op === '$type') { if (!bsonTypeMatches(val, present, operand)) return false; }
    // MongoDB's $ne MATCHES documents that do not contain the field at all
    // ("This includes documents that do not contain the field"). An earlier
    // version of this stub returned false for absent — the exact opposite —
    // which both adversarial passes caught. Modelling it wrongly would make
    // every A-group conclusion about arm 2 unsound, since arm 2's own filter
    // uses $ne:null. verifyRegenerateConsumerClaim.js:158-160 models it
    // correctly; this now matches.
    else if (op === '$ne') { if (present && val === operand) return false; }
    else if (op === '$lt') { if (!present || !(val < operand)) return false; }
    else throw new Error(`stub: unsupported operator ${op} — extend deliberately`);
  }
  return true;
}
function mongoMatch(filter, doc) {
  return Object.entries(filter).every(([k, c]) => matchOne(doc, k, c));
}
function applyUpdate(doc, update) {
  if (update.$set) for (const [k, v] of Object.entries(update.$set)) setPath(doc, k, v);
  if (update.$inc) for (const [k, v] of Object.entries(update.$inc)) setPath(doc, k, (getPath(doc, k) || 0) + v);
  return doc;
}
function deepClone(d) {
  return JSON.parse(JSON.stringify(d), (k, v) =>
    (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) ? new Date(v) : v));
}
// Synchronous core — models a real findOneAndUpdate's single indivisible
// read-modify-write. JS never preempts sync code, so two "concurrent" calls are
// genuinely serialised exactly as the server would serialise them.
function makeStore(seed) {
  const store = seed.map(deepClone);
  return {
    store,
    findOneAndUpdate(filter, update, opts = {}) {
      let cands = store.filter((d) => mongoMatch(filter, d));
      if (opts.sort) {
        const [k] = Object.keys(opts.sort);
        const dir = opts.sort[k];
        cands = cands.slice().sort((a, b) => ((a[k] > b[k]) ? 1 : (a[k] < b[k]) ? -1 : 0) * dir);
      }
      const hit = cands[0];
      if (!hit) return null;
      applyUpdate(hit, update);
      return opts.new ? deepClone(hit) : hit;
    },
    updateOne(filter, update) {
      const hit = store.find((d) => mongoMatch(filter, d));
      if (!hit) return { matchedCount: 0, modifiedCount: 0 };
      applyUpdate(hit, update);
      return { matchedCount: 1, modifiedCount: 1 };
    },
    byId(id) { return store.find((d) => d._id === id); }
  };
}

// ── load the REAL regenerateConsumer against fakes ────────────────────────
const CONSUMER_PATH = require.resolve('../src/services/regenerateConsumer');
const CONFIG_PATH = require.resolve('../src/config');
const AD_PATH = require.resolve('../src/models/Ad');
const REGEN_PATH = require.resolve('../src/services/adRegenerateService');
function fakeModule(p, exportsObj) {
  require.cache[p] = {
    id: p, filename: p, loaded: true, children: [],
    paths: Module._nodeModulePaths(path.dirname(p)), exports: exportsObj
  };
}
function loadConsumer(store, { staleMin, maxReclaims, workerId = 'worker-A' } = {}) {
  delete require.cache[CONSUMER_PATH];
  fakeModule(CONFIG_PATH, { WORKER_ID: workerId, isAdgenRendererEnabled: () => true });
  fakeModule(AD_PATH, {
    findOneAndUpdate: (f, u, o) => Promise.resolve(store.findOneAndUpdate(f, u, o)),
    updateOne: (f, u) => Promise.resolve(store.updateOne(f, u))
  });
  fakeModule(REGEN_PATH, { runClaimedRegeneration: async () => {} });
  if (staleMin != null) process.env.ADGEN_REGEN_CLAIM_STALE_MIN = String(staleMin);
  if (maxReclaims != null) process.env.ADGEN_REGEN_MAX_RECLAIMS = String(maxReclaims);
  return require(CONSUMER_PATH);
}
function cleanup() {
  for (const p of [CONSUMER_PATH, CONFIG_PATH, AD_PATH, REGEN_PATH]) delete require.cache[p];
  delete process.env.ADGEN_REGEN_CLAIM_STALE_MIN;
  delete process.env.ADGEN_REGEN_MAX_RECLAIMS;
}

const MIN = 60 * 1000;
function row(over = {}) {
  return {
    _id: 'ad1',
    regenerating: true,
    regenerationRequest: { kind: 'video', prompt: 'punchier' },
    regenerateClaimedByWorker: null,
    regenerateClaimedAt: null,
    veoPredictionId: 'pred_OLD',
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...over
  };
}
// A row mid-flight with a live (fresh) lease, held by a peer.
function claimedRow(ageMin, over = {}) {
  return row({
    regenerateClaimedByWorker: 'worker-DEAD',
    regenerateClaimedAt: new Date(Date.now() - ageMin * MIN),
    regenerationRequest: {
      kind: 'video', prompt: 'punchier',
      priorVeoPredictionId: 'pred_OLD',
      priorVeoPredictionSetAt: new Date(Date.now() - ageMin * MIN)
    },
    ...over
  });
}

(async () => {
  console.log('verifyRegenerateLeaseExpiry\n');
  console.log('── A: claimOne, EXECUTED against an atomic stub ──');

  await checkAsync('A1 a fresh unclaimed request is claimed, and the receipt BASELINE is snapshotted', async () => {
    const store = makeStore([row()]);
    const consumer = loadConsumer(store, { staleMin: 45 });
    const got = await consumer.claimOne();
    assert.ok(got, 'a fresh deferred request must be claimable');
    assert.strictEqual(got.regenerateClaimedByWorker, 'worker-A');
    const stored = store.byId('ad1');
    assert.strictEqual(stored.regenerationRequest.priorVeoPredictionId, 'pred_OLD',
      'the baseline must capture the PRE-regenerate veoPredictionId');
    assert.ok(stored.regenerationRequest.priorVeoPredictionSetAt instanceof Date,
      'priorVeoPredictionSetAt must be a real Date — arm 2 filters on $type:date');
    assert.strictEqual(got.regenerationRequest.priorVeoPredictionId, 'pred_OLD',
      'the baseline must also be mirrored onto the returned in-memory doc (no extra query downstream)');
    cleanup();
  });

  await checkAsync('A2 [THE FIX] a claim older than the lease IS reclaimed, and reclaimCount increments', async () => {
    const store = makeStore([claimedRow(90)]);
    const consumer = loadConsumer(store, { staleMin: 45 });
    const got = await consumer.claimOne();
    assert.ok(got, 'a 90-min-old claim must be reclaimable at a 45-min lease — this is the whole defect');
    assert.strictEqual(got.regenerateClaimedByWorker, 'worker-A');
    assert.strictEqual(store.byId('ad1').regenerationRequest.reclaimCount, 1,
      'arm 2 must $inc reclaimCount so the executor can enforce the ceiling');
    cleanup();
  });

  await checkAsync('A3 a claim INSIDE the lease window is NOT reclaimed (a live worker keeps its work)', async () => {
    const store = makeStore([claimedRow(10)]);
    const consumer = loadConsumer(store, { staleMin: 45 });
    assert.strictEqual(await consumer.claimOne(), null,
      'a 10-min-old claim at a 45-min lease must be left alone — reclaiming a live worker is a double submit');
    cleanup();
  });

  await checkAsync('A4 [MONEY][THE SHIP-BLOCKER] a PRE-FIX stuck row (no baseline) is NEVER reclaimed', async () => {
    // Every row stuck in production today predates this fix and therefore has
    // no baseline. Without the $type:'date' predicate on arm 2 these rows would
    // be auto-reclaimed on deploy, arrive at the executor unjudgeable, fall
    // through to runVideoFull, and fire a brand-new billable Omni submit for
    // each one that had ALREADY paid — turning a $0 stuck state into real money
    // on deploy day. They must stay exactly as they are today.
    const store = makeStore([row({
      regenerateClaimedByWorker: 'worker-DEAD',
      regenerateClaimedAt: new Date(Date.now() - 600 * MIN),
      regenerationRequest: { kind: 'video', prompt: 'punchier' }   // NO baseline
    })]);
    const consumer = loadConsumer(store, { staleMin: 45 });
    assert.strictEqual(await consumer.claimOne(), null,
      'a stale claim with no priorVeoPredictionSetAt must NOT be leased — its receipt state cannot be judged, ' +
      'so reclaiming it can only lead to a blind resubmit');
    cleanup();
  });

  await checkAsync('A5 [THE GUARANTEE] two workers racing the SAME stale lease — exactly one wins', async () => {
    const store = makeStore([claimedRow(90)]);
    const cA = loadConsumer(store, { staleMin: 45, workerId: 'worker-A' });
    const rA = await cA.claimOne();
    cleanup();
    const cB = loadConsumer(store, { staleMin: 45, workerId: 'worker-B' });
    const rB = await cB.claimOne();
    cleanup();
    assert.strictEqual([rA, rB].filter(Boolean).length, 1,
      'two reclaimers must not both win — the winner bumps regenerateClaimedAt, so the loser\'s $lt misses');
    assert.strictEqual(store.byId('ad1').regenerationRequest.reclaimCount, 1,
      'reclaimCount must increment exactly once across the race');
  });

  await checkAsync('A6 arm 2 does NOT restamp the baseline (it must survive every reclaim unchanged)', async () => {
    const store = makeStore([claimedRow(90, { veoPredictionId: 'pred_NEW_FROM_CRASHED_ATTEMPT' })]);
    const consumer = loadConsumer(store, { staleMin: 45 });
    await consumer.claimOne();
    assert.strictEqual(store.byId('ad1').regenerationRequest.priorVeoPredictionId, 'pred_OLD',
      'if a reclaim rebased the baseline onto the receipt it is meant to judge, the receipt check would ' +
      'always see "unchanged" and every reclaim would resubmit');
    cleanup();
  });

  await checkAsync('A7 a FRESH request wins over a reclaimable one (arm 1 is tried first)', async () => {
    const store = makeStore([
      claimedRow(90, { _id: 'stale', updatedAt: new Date('2026-01-01T00:00:00Z') }),
      row({ _id: 'freshAd', updatedAt: new Date('2026-01-01T00:00:05Z') })
    ]);
    const consumer = loadConsumer(store, { staleMin: 45 });
    const got = await consumer.claimOne();
    assert.strictEqual(got._id, 'freshAd', 'arm 1 must be attempted before arm 2');
    cleanup();
  });

  await checkAsync('A8 the renderer-flag gate still precedes BOTH arms', async () => {
    const store = makeStore([row(), claimedRow(90, { _id: 'stale2' })]);
    delete require.cache[CONSUMER_PATH];
    fakeModule(CONFIG_PATH, { WORKER_ID: 'worker-A', isAdgenRendererEnabled: () => false });
    fakeModule(AD_PATH, {
      findOneAndUpdate: () => { throw new Error('claimed with the handoff flag OFF'); },
      updateOne: () => { throw new Error('wrote with the handoff flag OFF'); }
    });
    fakeModule(REGEN_PATH, { runClaimedRegeneration: async () => {} });
    const consumer = require(CONSUMER_PATH);
    assert.strictEqual(await consumer.claimOne(), null,
      'with ADGEN_RENDERER_ENABLED off the backend owns this collection; adgen must claim nothing');
    cleanup();
  });

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n── B: the executor\'s receipt gate, source-extracted and evaluated ──');
  const svcSrc = fs.readFileSync(SERVICE_SRC_PATH, 'utf8');
  const execBody = functionBody(svcSrc, /async function runClaimedRegeneration\s*\([^)]*\)\s*\{/);

  // Pull the REAL hasFreshReceipt expression out of the live source and
  // evaluate it — so a change to the real gate changes what this tests.
  const hfrMatch = /const hasFreshReceipt = ([\s\S]*?);\n/.exec(execBody);
  check('B0 the hasFreshReceipt expression extracts from the live source', () => {
    assert.ok(hfrMatch, 'could not locate `const hasFreshReceipt = ...;` in runClaimedRegeneration');
  });
  const hasFreshReceipt = hfrMatch
    // eslint-disable-next-line no-new-func
    ? new Function('kind', 'req', 'currentPredictionId', `return (${hfrMatch[1]});`)
    : null;

  const MATRIX = [
    ['B1 [COMMON CASE] no baseline at all → NOT a fresh receipt → today\'s dispatch, unchanged',
      'video', {}, 'pred_OLD', false],
    ['B2 [COMMON CASE] baseline present but the receipt is UNCHANGED → not fresh (crash before submit)',
      'video', { priorVeoPredictionSetAt: new Date(), priorVeoPredictionId: 'pred_OLD' }, 'pred_OLD', false],
    ['B3 [THE ONE RESUME CASE] baseline present and the receipt CHANGED → fresh receipt',
      'video', { priorVeoPredictionSetAt: new Date(), priorVeoPredictionId: 'pred_OLD' }, 'pred_NEW', true],
    ['B4 [MONEY] a changed receipt with NO baseline timestamp → fail closed, never resume',
      'video', { priorVeoPredictionId: 'pred_OLD' }, 'pred_NEW', false],
    ['B5 no current receipt at all → not fresh',
      'video', { priorVeoPredictionSetAt: new Date(), priorVeoPredictionId: 'pred_OLD' }, null, false],
    ['B6 [SCOPE] a STATIC regenerate is never receipt-gated (video-only), even with a changed id',
      'image', { priorVeoPredictionSetAt: new Date(), priorVeoPredictionId: 'pred_OLD' }, 'pred_NEW', false],
    ['B7 baseline captured when the ad had NO prior receipt, then one appears → fresh',
      'video', { priorVeoPredictionSetAt: new Date(), priorVeoPredictionId: null }, 'pred_NEW', true]
  ];
  for (const [label, kind, req, cur, expected] of MATRIX) {
    check(label, () => {
      assert.ok(hasFreshReceipt, 'gate expression did not extract');
      assert.strictEqual(!!hasFreshReceipt(kind, req, cur), expected);
    });
  }

  // Structural: every no-submit branch must return BEFORE the dispatcher.
  const dispatchIdx = execBody.search(/\brunVideoFull\s*\(|\brunImage\s*\(/);
  check('B8 the dispatcher is located, so branch ordering can be asserted', () => {
    assert.ok(dispatchIdx > 0, 'could not find runVideoFull/runImage in runClaimedRegeneration');
  });
  const beforeDispatch = execBody.slice(0, dispatchIdx);

  check('B9 [MONEY] the reclaim CEILING gates the SUBMIT but not the COLLECT (peek first, ceiling second)', () => {
    // Ordering is the invariant, not mere presence. An earlier draft checked the
    // ceiling at function entry and BOTH adversarial passes' concern applied: a
    // row holding a PAID prediction whose peek keeps returning processing /
    // unknown would be terminal-failed on the Nth reclaim without ever being
    // peeked again — discarding a paid master. The ceiling must bound resubmits,
    // never collects. So it has to sit AFTER resumeForAd and BEFORE the
    // dispatcher.
    const ceilingIdx = execBody.search(/reclaimCount\s*>\s*MAX_RECLAIMS/);
    const peekIdx = execBody.search(/resumeForAd\s*\(/);
    assert.ok(ceilingIdx > 0,
      'without a ceiling, a crash-looping regenerate bills a fresh submit every lease interval forever');
    assert.ok(peekIdx > 0, 'no resumeForAd peek found');
    assert.ok(ceilingIdx > peekIdx,
      'the reclaim ceiling must be enforced AFTER the receipt peek — checking it first discards paid masters ' +
      'whose peek was merely unsettled (processing / unknown)');
    assert.ok(ceilingIdx < dispatchIdx,
      'the reclaim ceiling must be enforced BEFORE the dispatcher, or it bounds nothing');
  });

  check('B9b [MONEY] the done branch neither completes nor overwrites the existing render', () => {
    // Narrowed after adversarial review: peek.videoUrl is Atlas's raw outputs[0]
    // URL, which the normal path never persists (generateForAd Cloudinary-mirrors
    // first; resumeForAd does not). Writing it to renderUrl would replace a
    // stable asset with an expiring one, and would ship untitled on any non-draft
    // ad. So this branch records provenance, alerts, and returns.
    const dIdx = beforeDispatch.indexOf("peek.state === 'done'");
    const dBlock = balanced(beforeDispatch, beforeDispatch.indexOf('{', dIdx), '{', '}');
    assert.ok(dBlock, 'could not balance the done branch');
    for (const forbidden of ['renderUrl:', 'posterUrl:', 'titlingResumeState:']) {
      assert.ok(!dBlock.includes(forbidden),
        `the done branch must not write ${forbidden} — an unmirrored, expiring Atlas URL must never replace ` +
        'the existing render, and a non-draft ad would never auto-title');
    }
    assert.match(dBlock, /veoVideoUrl:/, 'the done branch must still record veoVideoUrl as the provenance trail');
    assert.match(dBlock, /notifyAsync/,
      'the done branch must alert — the recovered paid master needs collection, and an unalerted recovery is ' +
      'the silent-toil failure this whole change exists to remove');
  });

  check('B10 [MONEY] a reclaim with no baseline is refused before the dispatcher (defence in depth)', () => {
    assert.match(beforeDispatch, /reclaimCount\s*>\s*0\s*&&\s*!\s*req\.priorVeoPredictionSetAt/,
      'if arm 2\'s $type:date predicate is ever weakened, this is the second wall stopping a blind resubmit');
  });
  check('B11 [MONEY] the receipt peek uses resumeForAd, never generateForAd', () => {
    const gateIdx = beforeDispatch.indexOf('hasFreshReceipt');
    const gateRegion = beforeDispatch.slice(gateIdx);
    assert.match(gateRegion, /resumeForAd\s*\(/, 'the receipt gate must peek via resumeForAd');
    assert.ok(!/generateForAd\s*\(/.test(gateRegion),
      'the receipt gate must NEVER call generateForAd — that is the frozen allowResume:false path, and calling ' +
      'it here with resume enabled is exactly the widening this design refuses');
  });
  check('B12 [MONEY] EVERY no-submit branch returns, so none can fall through to a billable submit', () => {
    // The first version of this check only opened the `processing` block and
    // only looked for markComplete. Adversarial review showed that dropping the
    // `return` after the done stamp, or after the unknown log, would fall
    // through to runVideoFull and bill a second submit on a receipt we had just
    // confirmed was collected or unclassifiable — and B12 would have stayed
    // green. Every branch is now checked for a real terminating return.
    const gateIdx = beforeDispatch.indexOf('if (hasFreshReceipt)');
    assert.ok(gateIdx > 0, 'the hasFreshReceipt block was not found');
    const gateBlock = balanced(beforeDispatch, beforeDispatch.indexOf('{', gateIdx), '{', '}');
    assert.ok(gateBlock, 'could not balance the hasFreshReceipt block');

    const branches = [
      ["peek.state === 'done'", true],        // [needle, mustNotMarkCompleteDone]
      ["peek.state === 'processing'", true],
      ["peek.state === 'failed' && peek.charged === false", false]
    ];
    for (const [needle] of branches) {
      assert.ok(gateBlock.includes(needle), `no branch for ${needle}`);
    }

    // done + processing must each return, and must NOT complete: done would
    // wipe the baseline for an uncollected paid master, processing would abandon
    // a live paid render.
    for (const needle of ["peek.state === 'done'", "peek.state === 'processing'"]) {
      const i = gateBlock.indexOf(needle);
      const blk = balanced(gateBlock, gateBlock.indexOf('{', i), '{', '}');
      assert.ok(blk, `could not balance the block for ${needle}`);
      assert.match(blk, /\breturn;/,
        `the ${needle} branch must return — falling through reaches a billable submit`);
      assert.ok(!/markComplete\s*\(\s*adId\s*,\s*\{\s*status:\s*'done'/.test(blk),
        `the ${needle} branch must not markComplete 'done' — the paid master is not on the ad yet, and ` +
        'completing wipes regenerationRequest (the baseline with it) so nothing can ever collect it');
    }

    // The resumeForAd throw handler and the trailing unknown/else arm must both
    // return rather than fall through.
    const catchIdx = gateBlock.search(/catch\s*\(\s*peekErr\s*\)\s*\{/);
    assert.ok(catchIdx > 0, 'no catch (peekErr) around resumeForAd — a throw would fall through to a submit');
    const catchBlk = balanced(gateBlock, gateBlock.indexOf('{', catchIdx), '{', '}');
    assert.match(catchBlk, /\breturn;/, 'the resumeForAd catch must return, never fall through to a submit');

    const elseIdx = gateBlock.lastIndexOf('} else {');
    assert.ok(elseIdx > 0, 'no trailing else (unknown-state) arm found');
    const elseBlk = balanced(gateBlock, gateBlock.indexOf('{', elseIdx + 2), '{', '}');
    assert.match(elseBlk, /\breturn;/,
      "the unknown-state arm must return — 'unknown' means we could not tell whether Atlas charged us, " +
      'and falling through would resubmit on exactly that ambiguity');
  });

  check('B13 [MONEY][FIELD-NAME TRAP] the unbilled branch reads peek.charged, not peek.chargeConfirmed', () => {
    // confirmedCharge() returns { charged, priceUsd }. Reading chargeConfirmed
    // here is `undefined === false` → false → the branch is never taken and
    // every genuinely retryable render is terminal-failed instead.
    assert.match(beforeDispatch, /peek\.charged\s*===\s*false/,
      'the only safe-to-resubmit failure is a CONFIRMED-unbilled one, read from peek.charged');
    assert.ok(!/peek\.chargeConfirmed/.test(beforeDispatch),
      'peek.chargeConfirmed does not exist — confirmedCharge() returns { charged, priceUsd }');
  });

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n── C: the structural money invariants this fix leans on ──');

  check('C1 [FROZEN] runVideoFull still passes the LITERAL allowResume: false, and is the only generateForAd', () => {
    const runBody = functionBody(svcSrc, /async function runVideoFull\s*\([^)]*\)\s*\{/);
    const calls = runBody.match(/generateForAd\s*\(/g) || [];
    assert.strictEqual(calls.length, 1,
      `runVideoFull must contain exactly ONE generateForAd call, found ${calls.length} — a second call site is how ` +
      'a resume-enabled submit would sneak onto the frozen path');
    assert.match(runBody, /allowResume:\s*false/,
      'the allowResume: false LITERAL is frozen (commit 2f99218 / PR #40 — review required it be explicit, not ' +
      'implicit). This fix adds a separate reclaim-only receipt path instead of widening it.');
    // Enumerate every value assigned to allowResume rather than using a
    // negative lookahead: `/allowResume:\s*(?!false)/` looks correct but
    // BACKTRACKS — \s* gives back the space so the lookahead inspects " false",
    // which is not "false", and the assertion fires on correct code. Caught by
    // this harness failing against the real, correct source.
    const values = [...runBody.matchAll(/allowResume:\s*([A-Za-z0-9_$.]+)/g)].map((m) => m[1]);
    assert.ok(values.length >= 1, 'no allowResume assignment found in runVideoFull');
    for (const v of values) {
      assert.strictEqual(v, 'false',
        `allowResume in runVideoFull must be the literal false — found "${v}". A variable, ternary or resolved ` +
        'value is exactly the widening PR #40\'s review rejected ("explicit, not implicit").');
    }
  });

  check('C2 regenerateAd (the non-deferred entry point) is untouched by the receipt gate', () => {
    const regenBody = functionBody(svcSrc, /async function regenerateAd\s*\(\{/);
    for (const token of ['hasFreshReceipt', 'resumeForAd', 'reclaimCount', 'priorVeoPredictionId']) {
      assert.ok(!regenBody.includes(token),
        `regenerateAd must not reference ${token} — this fix is scoped to the deferred/consumer path only`);
    }
  });

  check('C3 [THE UNENFORCED GUARANTEE] resumeForAd cannot submit — asserted here because scripts/verifyVideoResume.js does not exist', () => {
    // atlasVideoService.js:3718, :5094 and bootRecoveryService.js:15 all cite
    // scripts/verifyVideoResume.js as the enforcer of this property. That file
    // is absent from the repo, so the guarantee was unpinned — and this fix's
    // no-submit reclaim path depends on it entirely.
    assert.ok(!fs.existsSync(path.join(ROOT, 'scripts/verifyVideoResume.js')),
      'scripts/verifyVideoResume.js now exists — fold this check into it and delete this one');
    const atlasSrc = fs.readFileSync(ATLAS_SRC_PATH, 'utf8');
    const body = functionBody(atlasSrc, /async function resumeForAd\s*\(\{[^)]*\}\s*=\s*\{\}\s*\)\s*\{/);
    for (const forbidden of [/submitGeneration\s*\(/, /axios\.post\s*\(/, /generateForAd\s*\(/, /pacedModelSubmit\s*\(/]) {
      assert.ok(!forbidden.test(body),
        `resumeForAd's body matches ${forbidden} — it must never submit; the reclaim path treats it as a free GET`);
    }
    const peekBody = functionBody(atlasSrc, /async function peekPrediction\s*\(predictionId\)\s*\{/);
    assert.ok(!/axios\.post\s*\(/.test(peekBody) && !/submitGeneration\s*\(/.test(peekBody),
      'peekPrediction must be a GET-only peek');
  });

  check('C4 the consumer exports the new lease knobs (operable without a code change)', () => {
    const src = fs.readFileSync(CONSUMER_SRC_PATH, 'utf8');
    assert.match(src, /ADGEN_REGEN_CLAIM_STALE_MIN/, 'the lease length must be env-tunable');
    assert.match(src, /ADGEN_REGEN_MAX_RECLAIMS/, 'the reclaim ceiling must be env-tunable');
    const exportsBlock = src.slice(src.indexOf('module.exports'));
    assert.match(exportsBlock, /CLAIM_STALE_MIN/);
    assert.match(exportsBlock, /MAX_RECLAIMS/);
  });

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n── D: runClaimedRegeneration EXECUTED against an unsettled poll timeout ──');
  //
  // Group B evaluates extracted expressions. It cannot see a catch branch that
  // still calls markComplete, because the extracted text of `hasFreshReceipt`
  // never runs that catch. The regression this PR exists to fix lives in
  // code that only executes when generateForAd actually throws
  // `err.unsettledAtTimeout`. So we require the REAL adRegenerateService,
  // stub every provider boundary the way verifyRegenerateInFlightGate.js
  // does, and drive runClaimedRegeneration through the real runVideoFull
  // until generateForAd throws.

  const origLoad = Module._load;
  const dSeeded = [];
  function dSeed(rel, exportsObj) {
    const full = require.resolve(path.join(ROOT, rel));
    require.cache[full] = new Module(full, null);
    require.cache[full].filename = full;
    require.cache[full].loaded = true;
    require.cache[full].exports = exportsObj;
    dSeeded.push(full);
    return full;
  }
  function dSelectKeys(selectArg) {
    if (typeof selectArg === 'string') {
      return selectArg.trim().split(/[\s,]+/).filter(Boolean);
    }
    if (Array.isArray(selectArg)) return selectArg.map(String);
    if (selectArg && typeof selectArg === 'object') {
      return Object.keys(selectArg).filter((k) => selectArg[k]);
    }
    throw new Error(`Ad.findById().select() got unexpected argument: ${JSON.stringify(selectArg)}`);
  }
  function dProjectDoc(doc, selectArg) {
    const keys = dSelectKeys(selectArg);
    const out = {};
    if (!keys.some((k) => k === '-_id' || k === '-id')) {
      if (Object.prototype.hasOwnProperty.call(doc, '_id')) out._id = doc._id;
    }
    for (const k of keys) {
      if (k[0] === '-') continue;
      if (k === '_id') continue;
      if (Object.prototype.hasOwnProperty.call(doc, k)) out[k] = doc[k];
    }
    return out;
  }
  const dStore = { docs: [], updateCalls: [] };
  const dProviders = { generateForAd: 0, prepareStoryboard: 0 };
  function dResetAds(docs) {
    dStore.docs = (docs || []).map((d) => ({ ...d }));
    dStore.updateCalls = [];
  }
  function dResetProviders() {
    dProviders.generateForAd = 0;
    dProviders.prepareStoryboard = 0;
  }
  function dFindDoc(id) {
    return dStore.docs.find((d) => String(d._id) === String(id)) || null;
  }
  const dAdStub = {
    findById(id) {
      let selectArg = null;
      const chain = {
        select(fields) { selectArg = fields; return chain; },
        lean: async () => {
          const doc = dFindDoc(id);
          if (!doc) return null;
          if (selectArg == null) return { ...doc };
          return dProjectDoc(doc, selectArg);
        }
      };
      return chain;
    },
    updateOne(filter, update, opts) {
      dStore.updateCalls.push({ filter, update, opts });
      return Promise.resolve({ matchedCount: 1, modifiedCount: 1 });
    }
  };
  function dChainableFindById(result) {
    return {
      select() { return this; },
      lean: async () => result
    };
  }
  class dCancelledError extends Error {
    constructor(msg) { super(msg || 'cancelled'); this.name = 'CancelledError'; }
  }
  function dResolveDeriveFromMaster(ad) {
    if (!ad) return null;
    if (typeof ad.deriveFromMaster === 'string' && ad.deriveFromMaster) {
      return ad.deriveFromMaster;
    }
    if (ad.platformFormat === 'pmax_video_1_1') return 'pmax_video_9_16';
    return null;
  }

  const PAST = new Date('2026-08-01T00:00:00Z');
  function timeoutAd() {
    return {
      _id: 'ad-timeout-1',
      kind: 'video',
      brandId: 'brand-1',
      status: 'draft',
      metaSyncStatus: null,
      deriveFromMaster: null,
      titlingResumeState: null,
      veoVideoUrl: 'https://cdn/old.mp4',
      renderUrl: 'https://cdn/old.mp4',
      veoPredictionId: 'pred_OLD',
      mediaId: null,
      regenerating: true,
      regenerateClaimedByWorker: 'worker-under-test',
      regenerateClaimedAt: PAST,
      regenerationRequest: {
        kind: 'video',
        prompt: 'x',
        priorVeoPredictionId: 'pred_OLD',
        priorVeoPredictionSetAt: PAST
      },
      regenerationHistory: [{ status: 'pending', at: PAST }]
    };
  }
  function timeoutErr() {
    // Shape copied from atlasVideoService.resolveTimeoutOutcome when the
    // final peek is still processing/unknown: predictionId, unsettledAtTimeout
    // true, chargeConfirmed null. That flag is the entire discriminator the
    // catch in runClaimedRegeneration keys on.
    return Object.assign(
      new Error('atlasVideo: prediction timed out after 600s (id=pred_NEW_FROM_TIMEOUT) — still unsettled at Atlas (processing); receipt preserved for reconciliation.'),
      { predictionId: 'pred_NEW_FROM_TIMEOUT', unsettledAtTimeout: true, chargeConfirmed: null }
    );
  }
  function assertNoTouch(updateCalls, generateCount, { reclaimLabel }) {
    assert.ok(generateCount >= 1,
      `${reclaimLabel}: videoRouter.generateForAd was never called — this check never reached the Omni submit, ` +
      'so a green result would not prove the timeout catch left the row reclaimable (it might have short-circuited ' +
      'at the in-flight gate, the derive gate, UGC passthrough, or the receipt peek)');
    for (let i = 0; i < updateCalls.length; i++) {
      const set = (updateCalls[i].update && updateCalls[i].update.$set) || {};
      assert.ok(!Object.prototype.hasOwnProperty.call(set, 'regenerationRequest'),
        `${reclaimLabel}: Ad.updateOne[${i}] $set contains regenerationRequest — markComplete (or anything else) ` +
        'nulled the reclaim BASELINE (priorVeoPredictionId / priorVeoPredictionSetAt live inside that field). ' +
        'Without the baseline a later reclaim cannot tell this timed-out attempt\'s receipt from the original master, ' +
        'and the next pass falls through to a blind billable resubmit. The unsettled-timeout branch must not touch it.');
      assert.ok(!Object.prototype.hasOwnProperty.call(set, 'regenerateClaimedByWorker'),
        `${reclaimLabel}: Ad.updateOne[${i}] $set contains regenerateClaimedByWorker — releasing the claim, even ` +
        '"to be nice", routes the row through claimOne ARM 1 (fresh claim) on the next consumer tick. Arm 1 ' +
        'unconditionally re-snapshots the baseline onto whatever veoPredictionId is on the ad NOW, which on this ' +
        'error is the id the timed-out attempt just stamped. That collapses hasFreshReceipt to false and reopens ' +
        'a blind resubmit. Leave the claim in place so ARM 2 (lease expiry) takes over instead.');
      assert.ok(!Object.prototype.hasOwnProperty.call(set, 'regenerateClaimedAt'),
        `${reclaimLabel}: Ad.updateOne[${i}] $set contains regenerateClaimedAt — same money defect as touching ` +
        'regenerateClaimedByWorker: a rewritten claim timestamp either releases the lease (arm 1 restamp) or ' +
        'resets the stale clock so the row is never reclaimed. The timeout branch must not write it.');
      assert.ok(!Object.prototype.hasOwnProperty.call(set, 'regenerationHistory.$[e].status'),
        `${reclaimLabel}: Ad.updateOne[${i}] $set contains regenerationHistory.$[e].status — that is ` +
        'markComplete\'s own signature write. markComplete also nulls regenerationRequest and both claim ' +
        'markers in the SAME $set, so this one key is the strongest proof markComplete ran. An unsettled ' +
        'timeout is not a confirmed failure and must not go through it.');
    }
  }

  let dRegen;
  try {
    Module._load = function (request, parent, isMain) {
      if (request === 'mongoose') {
        return {
          Types: {
            ObjectId: class ObjectId {
              constructor(v) { this.id = String(v); }
              toString() { return this.id; }
              static isValid() { return true; }
            }
          }
        };
      }
      return origLoad.apply(this, arguments);
    };

    dSeed('src/models/Ad.js', dAdStub);
    dSeed('src/models/Media.js', {
      findById: () => dChainableFindById(null),
      exists: async () => false
    });
    dSeed('src/models/Brand.js', {
      findById: () => dChainableFindById({ advertiserId: 'adv-verify' })
    });
    dSeed('src/models/CampaignRun.js', {
      findOne: () => dChainableFindById(null)
    });
    // Default videoRouter stubs THROW, matching verifyRegenerateInFlightGate.js:
    // other paths must not silently reach Omni. Group D swaps prepareStoryboard
    // to succeed (D2 pattern in that sibling) so runVideoFull actually walks
    // to generateForAd, which then throws the unsettled-timeout shape.
    dSeed('src/services/videoRouter.js', {
      generateForAd: async () => {
        dProviders.generateForAd += 1;
        throw new Error('videoRouter.generateForAd must not run until Group D swaps the timeout stub in');
      },
      prepareStoryboard: async () => {
        dProviders.prepareStoryboard += 1;
        throw new Error('videoRouter.prepareStoryboard must not run until Group D swaps it');
      }
    });
    dSeed('src/services/brandScriptExecutor.js', {
      renderBrandScriptAndSave: async () => {},
      qcAndStampVideoAd: async () => {}
    });
    dSeed('src/services/cloudinaryService.js', {
      uploadBufferToCloudinary: async () => ({
        secure_url: 'https://res.cloudinary.com/verify/video/upload/v1/ad.mp4',
        public_id: 'verify/ad'
      })
    });
    dSeed('src/services/directImageRenderService.js', {
      renderDirectImage: async () => { throw new Error('directImage must not run on a video timeout path'); }
    });
    dSeed('src/services/campaignAdsGenerationService.js', {
      resolveDeriveFromMaster: dResolveDeriveFromMaster
    });
    dSeed('src/services/seededUniverseService.js', {
      isUgcFirstSeedingEnabled: () => false
    });
    dSeed('src/services/ugcVideoPipeline.js', {
      preparePassthroughMaster: async () => ({ passthrough: false, reason: 'verify stub' })
    });
    dSeed('src/services/progressService.js', {
      CancelledError: dCancelledError,
      startRun: async () => ({
        checkpoint: async () => {},
        stage() {},
        succeed: async () => {},
        fail: async () => {}
      })
    });
    dSeed('src/services/atlasVideoService.js', {
      resumeForAd: async () => { throw new Error('atlasVideoService.resumeForAd must not run — hasFreshReceipt should be false on this timeout path'); },
      reconcileVideoCostFromTerminal: () => { throw new Error('reconcileVideoCostFromTerminal must not run'); },
      resolveFailureCostReconcile: () => { throw new Error('resolveFailureCostReconcile must not run'); }
    });
    dSeed('src/services/costTracker.js', {
      reconcileCost: () => { throw new Error('costTracker.reconcileCost must not run'); }
    });
    dSeed('src/services/alertService.js', {
      notifyAsync: () => {}
    });

    const trsPath = require.resolve(path.join(ROOT, 'src/services/titlingResumeService.js'));
    delete require.cache[trsPath];
    delete require.cache[REGEN_PATH];
    dSeeded.push(trsPath);
    require(trsPath);
    dRegen = require(REGEN_PATH);
    assert.ok(typeof dRegen.runClaimedRegeneration === 'function',
      'adRegenerateService did not export runClaimedRegeneration');
    assert.ok(typeof dRegen.runVideoFull === 'function',
      'adRegenerateService did not export runVideoFull');

    const vrPath = require.resolve(path.join(ROOT, 'src/services/videoRouter.js'));

    async function runUnsettledTimeout(req) {
      dResetProviders();
      dResetAds([timeoutAd()]);
      const vr = require.cache[vrPath];
      assert.ok(vr, 'videoRouter is not in the require cache');
      const realPrepare = vr.exports.prepareStoryboard;
      const realGenerate = vr.exports.generateForAd;
      // D2 pattern from verifyRegenerateInFlightGate.js: the shared stub makes
      // prepareStoryboard THROW so other groups cannot silently enter the video
      // path. This group has to walk through it to reach the submit, so swap
      // in a trivial success for the duration. generateForAd is swapped to the
      // real unsettled-timeout throw — reaching it is required, succeeding is
      // the failure mode under test.
      vr.exports.prepareStoryboard = async () => {
        dProviders.prepareStoryboard += 1;
        return { storyboard: null };
      };
      vr.exports.generateForAd = async () => {
        dProviders.generateForAd += 1;
        throw timeoutErr();
      };
      try {
        const ad = timeoutAd();
        await dRegen.runClaimedRegeneration(ad, req);
      } finally {
        vr.exports.prepareStoryboard = realPrepare;
        vr.exports.generateForAd = realGenerate;
      }
      return {
        updateCalls: dStore.updateCalls.slice(),
        generateForAd: dProviders.generateForAd,
        prepareStoryboard: dProviders.prepareStoryboard
      };
    }

    await checkAsync('D1 [MONEY] an unsettled poll timeout leaves the baseline, the claim, and markComplete untouched (first attempt)', async () => {
      const got = await runUnsettledTimeout({ kind: 'video', prompt: 'x' });
      assert.ok(got.prepareStoryboard >= 1,
        'runVideoFull never reached prepareStoryboard, so it never got near generateForAd — this check would be vacuous');
      assertNoTouch(got.updateCalls, got.generateForAd, { reclaimLabel: 'D1 first attempt (reclaimCount 0)' });
    });

    await checkAsync('D2 [MONEY] the same timeout on a reclaimCount:1 invocation is still a no-touch — the fix is reclaim-count-agnostic', async () => {
      // Production reclaim: processClaimed passes the whole regenerationRequest
      // (arm 2 $inc'd reclaimCount; the ORIGINAL baseline is still on it —
      // arm 2 never restamps). priorVeoPredictionId MUST match the row's
      // veoPredictionId so hasFreshReceipt stays false and we actually enter
      // runVideoFull rather than the receipt-peek gate. MAX_RECLAIMS (default 2)
      // independently bounds how many times this can happen; the timeout catch
      // itself must not care about the count.
      const got = await runUnsettledTimeout({
        kind: 'video',
        prompt: 'x',
        reclaimCount: 1,
        priorVeoPredictionId: 'pred_OLD',
        priorVeoPredictionSetAt: PAST
      });
      assert.ok(got.prepareStoryboard >= 1,
        'reclaimCount:1 path never reached prepareStoryboard — this check would be vacuous');
      assertNoTouch(got.updateCalls, got.generateForAd, { reclaimLabel: 'D2 reclaimCount:1' });
    });

    await checkAsync('D3 [MONEY] the unsettled timeout backfills THIS ATTEMPT\'S OWN receipt when the charge-point stamp did not', async () => {
      // atlasVideoService's veoPredictionId $set at the charge point is
      // deliberately best-effort/non-fatal. If it failed, Ad.veoPredictionId
      // still reads the PRE-regenerate baseline. Without a backfill here, arm
      // 2's later reclaim would compare an unchanged "current" against the
      // unchanged baseline, find them identical, skip the receipt gate
      // entirely, and fall straight through to a brand-new billable
      // generateForAd while this attempt's own prediction may still be
      // rendering (or already delivered) at Atlas. Found by adversarial
      // review (Grok xhigh) against the D1/D2 do-nothing fix.
      const got = await runUnsettledTimeout({ kind: 'video', prompt: 'x' });
      const backfill = got.updateCalls.find((c) => {
        const set = (c.update && c.update.$set) || {};
        return Object.prototype.hasOwnProperty.call(set, 'veoPredictionId');
      });
      assert.ok(backfill,
        'no Ad.updateOne backfilled veoPredictionId onto this attempt\'s own receipt — this is the ' +
        'blind-reclaim-resubmit gap described above');
      assert.strictEqual(backfill.update.$set.veoPredictionId, 'pred_NEW_FROM_TIMEOUT',
        'the backfill must stamp THIS THROW\'S OWN err.predictionId, not any other value');
      assert.strictEqual(backfill.filter.regenerateClaimedByWorker, 'worker-under-test',
        'the backfill write must be claim-scoped (regenerateClaimedByWorker) so a row a DIFFERENT worker has ' +
        'already reclaimed in the meantime is left untouched rather than clobbered');
      const setKeys = Object.keys(backfill.update.$set);
      assert.deepStrictEqual(setKeys, ['veoPredictionId'],
        `the backfill $set must touch ONLY veoPredictionId — found ${JSON.stringify(setKeys)}. Any other key ` +
        'risks crossing into the claim/baseline fields D1/D2 already forbid touching.');
    });
  } finally {
    Module._load = origLoad;
    for (const p of dSeeded) delete require.cache[p];
    delete require.cache[REGEN_PATH];
    cleanup();
  }

  console.log('');
  if (failures.length) {
    console.error(`❌ verifyRegenerateLeaseExpiry: ${failures.length} of ${checks + failures.length} FAILED\n`);
    failures.forEach((f) => console.error(`  ✗ ${f}`));
    process.exit(1);
  }
  console.log(`✅ verifyRegenerateLeaseExpiry: ${checks}/${checks} checks passed`);
})().catch((err) => {
  console.error('verifyRegenerateLeaseExpiry: internal error:', err);
  process.exit(1);
});
