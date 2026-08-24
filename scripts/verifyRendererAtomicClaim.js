#!/usr/bin/env node
'use strict';
//
// verifyRendererAtomicClaim — pins the ONLY thing preventing two adgen
// renderer instances from double-rendering the same Ad. A double render is
// a double Atlas charge (Omni video ~$0.90, static ~$0.07-0.12 per surface),
// so this is a money invariant even though it lives entirely inside the
// microservice extraction (no backend equivalent — backend's claim shape is
// claimAdsForRun's whole-RUN claim; this is the adgen renderer's own
// per-AD claim, `services/renderer.js`'s `claimOne()`).
//
// WHAT THIS PINS (all against the REAL source of renderer.js, not a
// hand-copied reimplementation — see "SOURCE EXTRACTION" below):
//   A. claimOne()'s filter requires claimedByWorker:null (plus status:
//      'rendering') — the compare-and-swap half of the guarantee.
//   B. Two concurrent claims against the same Ad document cannot both
//      win — simulated against an offline atomic-collection stub, driven
//      by the REAL filter/update text evaluated out of the source file.
//   C. The claim is released (claimedByWorker -> null) whenever an Ad
//      leaves 'rendering' without becoming owned by nobody in particular:
//      the failure path (processAd's catch) and the derive-wait requeue
//      path (requeueDeriveForRetry) both hand the row back so a peer
//      worker can pick it up.
//   D. claimedByWorker is cleared on every TERMINAL write (status:'draft'
//      or status:'failed') — scanned across every Ad.updateOne/updateMany
//      call site in the file, not just the ones read by eye.
//
// SOURCE EXTRACTION, not a copy. Every filter/update object this harness
// evaluates is sliced out of the actual scripts/../src/services/renderer.js
// text (via balanced-brace parsing) and evaluated with `new Function`, so a
// change to the REAL filter changes what this harness tests. A hand-copied
// literal would silently keep testing the OLD shape forever — the same
// "regex over source can't tell a working query from one that merely still
// contains the right words" lesson liquidretail_backend's own
// verifyArchiveDigestRelease.js states in its header.
//
// REVERT-PROOF (performed manually against this file, evidence in the
// session report that shipped it): deleting the `claimedByWorker: null,`
// line from claimOne()'s filter in src/services/renderer.js makes check B2
// fail (both racers win the same Ad) while B1 continues to pass (the filter
// still requires status:'rendering') — restoring the line restores green.
//
// Pure + offline: no DB, no network, no API keys, no node_modules required
// (only Node builtins: fs, path, assert). Run:
//   node scripts/verifyRendererAtomicClaim.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const RENDERER_PATH = path.join(__dirname, '..', 'src', 'services', 'renderer.js');
const SRC = fs.readFileSync(RENDERER_PATH, 'utf8');

let checks = 0;
const failures = [];
function check(label, fn) {
  try { fn(); checks += 1; }
  catch (err) { failures.push(`${label}\n     ${err.message}`); }
}

// ── tiny balanced-bracket slicer (same discipline as backend's balanced()) ─
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
  assert.ok(body, `unterminated function body for ${signatureRe}`);
  return body;
}
function callArgs(src, calleeText, fromIdx = 0) {
  const idx = src.indexOf(calleeText, fromIdx);
  assert.ok(idx >= 0, `call not found: ${calleeText}`);
  const openParen = idx + calleeText.length - 1;
  const whole = balanced(src, openParen, '(', ')');
  assert.ok(whole, `unterminated call args for ${calleeText}`);
  const inner = whole.slice(1, -1);
  // Depth-aware top-level comma split. Not string-aware (no bracket
  // characters appear inside any string literal in this file's call sites),
  // which is a deliberate, stated simplification — see file header.
  const args = [];
  let depth = 0, start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if ('{[('.includes(c)) depth++;
    else if ('}])'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { args.push(inner.slice(start, i)); start = i + 1; }
  }
  args.push(inner.slice(start));
  return { args: args.map((s) => s.trim()), callIdx: idx, endIdx: idx + whole.length };
}

// ═════════════════════════════════════════════════════════════════════════
// A — locate claimOne() and its Ad.findOneAndUpdate call
// ═════════════════════════════════════════════════════════════════════════
const claimOneBody = functionBody(SRC, /async function claimOne\s*\(\s*\)\s*\{/);
const { args: claimArgs } = callArgs(claimOneBody, 'Ad.findOneAndUpdate(');
assert.strictEqual(claimArgs.length, 3, `claimOne's findOneAndUpdate should take (filter, update, opts) — got ${claimArgs.length} args`);
const [filterText, updateText, optsText] = claimArgs;

let claimFilter;
check('A1 filter is a self-contained literal — safe to literal-eval', () => {
  // A bare (unquoted) identifier used as a VALUE — as opposed to an object
  // KEY, which needs no variable binding — would throw a ReferenceError the
  // instant the returned function is invoked. That throw is exactly the
  // signal that this literal-eval technique has stopped being safe for this
  // file and needs re-deriving; it is not swallowed by `check()`+catch below
  // in the sense that a passing A1 means it demonstrably did NOT throw.
  // eslint-disable-next-line no-new-func
  claimFilter = new Function(`return (${filterText});`)();
  assert.ok(claimFilter && typeof claimFilter === 'object');
});

check('A2 claim filter requires status:"rendering"', () => {
  assert.strictEqual(claimFilter.status, 'rendering');
});
check('A3 claim filter requires claimedByWorker:null — THE compare-and-swap', () => {
  assert.strictEqual(claimFilter.claimedByWorker, null,
    'without this the filter would match an ALREADY-CLAIMED ad and a second worker could win it too');
});
check('A4 claim filter is scoped to renderable routes only', () => {
  assert.deepStrictEqual(claimFilter.renderRoute, { $in: ['html_gen', 'veo'] });
});
check('A5 claim sorts oldest-first (fair queue, not starvation-prone)', () => {
  assert.match(optsText, /sort:\s*\{\s*createdAt:\s*1\s*\}/);
  assert.match(optsText, /new:\s*true/, 'findOneAndUpdate must return the POST-update doc, not the pre-image');
});

// ═════════════════════════════════════════════════════════════════════════
// B — BEHAVIOURAL: replay the REAL filter/update against an offline atomic
// collection and prove two concurrent claimants cannot both win.
// ═════════════════════════════════════════════════════════════════════════
function mongoMatch(filter, doc) {
  for (const [key, cond] of Object.entries(filter)) {
    const val = doc[key];
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
      for (const [op, operand] of Object.entries(cond)) {
        if (op === '$in') { if (!operand.includes(val)) return false; }
        else throw new Error(`mongoMatch: unsupported operator ${op} — extend deliberately`);
      }
    } else if (cond === null) {
      if (!(val === null || val === undefined)) return false;
    } else if (val !== cond) return false;
  }
  return true;
}
function applyUpdate(doc, update) {
  const out = { ...doc };
  if (update.$set) Object.assign(out, update.$set);
  if (update.$inc) for (const [k, v] of Object.entries(update.$inc)) out[k] = (out[k] || 0) + v;
  return out;
}
// Deliberately SYNCHRONOUS core (no internal await) — this is the offline
// analogue of MongoDB's real per-document atomicity: a findOneAndUpdate is
// a single indivisible read-modify-write on the server, so two callers can
// never both observe the SAME pre-image. Modelling it as one synchronous
// JS function reproduces that guarantee exactly (JS never preempts sync
// code), rather than requiring a real database to prove it.
function makeAtomicCollection(seedDocs) {
  const store = seedDocs.map((d) => ({ ...d }));
  return {
    findOneAndUpdate(filter, update, opts = {}) {
      let candidates = store.filter((d) => mongoMatch(filter, d));
      if (opts.sort) {
        const [key] = Object.keys(opts.sort);
        const dir = opts.sort[key];
        candidates = candidates.slice().sort((a, b) => (a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0) * dir);
      }
      const match = candidates[0];
      if (!match) return null;
      const idx = store.indexOf(match);
      const updated = applyUpdate(match, update);
      store[idx] = updated;
      return opts.new ? updated : match;
    },
    all() { return store.map((d) => ({ ...d })); }
  };
}
function evalUpdateFor(workerId) {
  // eslint-disable-next-line no-new-func
  return new Function('WORKER_ID', `return (${updateText});`)(workerId);
}

check('B1 sanity: two DIFFERENT unclaimed ads each go to a different racer', () => {
  const coll = makeAtomicCollection([
    { _id: 'ad1', status: 'rendering', claimedByWorker: null, renderRoute: 'html_gen', createdAt: new Date('2026-01-01T00:00:00Z') },
    { _id: 'ad2', status: 'rendering', claimedByWorker: null, renderRoute: 'html_gen', createdAt: new Date('2026-01-01T00:00:01Z') }
  ]);
  const r1 = coll.findOneAndUpdate(claimFilter, evalUpdateFor('workerA'), { new: true, sort: { createdAt: 1 } });
  const r2 = coll.findOneAndUpdate(claimFilter, evalUpdateFor('workerB'), { new: true, sort: { createdAt: 1 } });
  assert.ok(r1 && r2, 'both racers should win DIFFERENT ads when two are available');
  assert.notStrictEqual(r1._id, r2._id);
});

check('B2 [THE GUARANTEE] two racers on the SAME single ad — only one wins', () => {
  const coll = makeAtomicCollection([
    { _id: 'onlyAd', status: 'rendering', claimedByWorker: null, renderRoute: 'veo', createdAt: new Date('2026-01-01T00:00:00Z') }
  ]);
  const results = [];
  for (const workerId of ['workerA', 'workerB']) {
    results.push(coll.findOneAndUpdate(claimFilter, evalUpdateFor(workerId), { new: true, sort: { createdAt: 1 } }));
  }
  const winners = results.filter(Boolean);
  assert.strictEqual(winners.length, 1,
    `expected exactly one winner, got ${winners.length} — a double render is a double Atlas charge`);
  const stored = coll.all()[0];
  assert.strictEqual(stored.claimedByWorker, winners[0].claimedByWorker,
    'the persisted document must reflect the single winner, not a lost update');
});

check('B3 ten racers on one ad — still exactly one winner, in any dispatch order', () => {
  const coll = makeAtomicCollection([
    { _id: 'ad1', status: 'rendering', claimedByWorker: null, renderRoute: 'html_gen', createdAt: new Date() }
  ]);
  const winners = [];
  for (let i = 0; i < 10; i++) {
    const r = coll.findOneAndUpdate(claimFilter, evalUpdateFor(`worker${i}`), { new: true, sort: { createdAt: 1 } });
    if (r) winners.push(r);
  }
  assert.strictEqual(winners.length, 1, `expected 1 winner across 10 racers, got ${winners.length}`);
});

check('B4 an ad already claimed by someone else never matches the filter again', () => {
  const coll = makeAtomicCollection([
    { _id: 'ad1', status: 'rendering', claimedByWorker: 'someone-else', renderRoute: 'html_gen', createdAt: new Date() }
  ]);
  const r = coll.findOneAndUpdate(claimFilter, evalUpdateFor('workerA'), { new: true, sort: { createdAt: 1 } });
  assert.strictEqual(r, null, 'an ad with a non-null claimedByWorker must be invisible to claimOne');
});

check('B5 a queued (not-yet-dispatched) ad is not claimable — status:"rendering" is required', () => {
  const coll = makeAtomicCollection([
    { _id: 'ad1', status: 'queued', claimedByWorker: null, renderRoute: 'html_gen', createdAt: new Date() }
  ]);
  const r = coll.findOneAndUpdate(claimFilter, evalUpdateFor('workerA'), { new: true, sort: { createdAt: 1 } });
  assert.strictEqual(r, null);
});

// ═════════════════════════════════════════════════════════════════════════
// C — the claim is RELEASED (claimedByWorker -> null) on failure and on a
// benign derive-wait requeue, so a peer worker can retry.
// ═════════════════════════════════════════════════════════════════════════
const processAdBody = functionBody(SRC, /async function processAd\s*\(ad\)\s*\{/);
check('C1 processAd catch handler releases the claim on failure', () => {
  const catchIdx = processAdBody.indexOf('} catch (err) {');
  assert.ok(catchIdx >= 0, 'processAd must have a catch block');
  const catchBody = balanced(processAdBody, processAdBody.indexOf('{', catchIdx), '{', '}');
  const { args } = callArgs(catchBody, 'Ad.updateOne(');
  const update = args[1];
  assert.match(update, /status:\s*['"]failed['"]/, 'failure must be recorded as status:failed');
  assert.match(update, /claimedByWorker:\s*null/, 'the claim MUST be released so a peer worker can retry this ad');
  assert.match(update, /claimedAt:\s*null/);
});

const requeueBody = functionBody(SRC, /async function requeueDeriveForRetry\s*\(ad, reason\)\s*\{/);
check('C2 derive-wait requeue also releases the claim (benign retry, not a failure)', () => {
  const { args } = callArgs(requeueBody, 'Ad.updateOne(');
  const update = args[1];
  assert.match(update, /status:\s*['"]rendering['"]/, 'a derive-wait requeue goes back to rendering, not queued');
  assert.match(update, /claimedByWorker:\s*null/, 'a peer worker must be able to pick this ad up once the sibling master lands');
});

// ═════════════════════════════════════════════════════════════════════════
// D — claimedByWorker is cleared on EVERY terminal (draft/failed) write —
// scanned mechanically across every Ad.updateOne/updateMany call site, not
// just the ones a human reader happened to look at.
// ═════════════════════════════════════════════════════════════════════════
function allAdUpdateSites(src) {
  const sites = [];
  const CALL_RE = /Ad\.(updateOne|updateMany)\(/g;
  let m;
  while ((m = CALL_RE.exec(src))) {
    const openParen = m.index + m[0].length - 1;
    const whole = balanced(src, openParen, '(', ')');
    if (!whole) continue;
    const inner = whole.slice(1, -1);
    let depth = 0, start = 0;
    const args = [];
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      if ('{[('.includes(c)) depth++;
      else if ('}])'.includes(c)) depth--;
      else if (c === ',' && depth === 0) { args.push(inner.slice(start, i)); start = i + 1; }
    }
    args.push(inner.slice(start));
    sites.push({ method: m[1], idx: m.index, filter: (args[0] || '').trim(), update: (args[1] || '').trim() });
    CALL_RE.lastIndex = m.index + whole.length;
  }
  return sites;
}

const sites = allAdUpdateSites(SRC);
check('D0 the scan actually found call sites (a zero-result scan proves nothing)', () => {
  assert.ok(sites.length >= 5, `expected several Ad.updateOne/updateMany call sites, found ${sites.length}`);
});

check('D1 every write that sets status:"draft" or status:"failed" also clears claimedByWorker', () => {
  const violations = [];
  for (const site of sites) {
    const setsTerminalStatus = /status:\s*['"](draft|failed)['"]/.test(site.update);
    if (!setsTerminalStatus) continue;
    if (!/claimedByWorker:\s*null/.test(site.update)) {
      violations.push(`line-ish offset ${site.idx}: sets a terminal status without clearing claimedByWorker — ${site.update.slice(0, 120)}`);
    }
  }
  assert.strictEqual(violations.length, 0, violations.join('\n'));
});

// ── report ───────────────────────────────────────────────────────────────
const total = checks + failures.length;
if (failures.length) {
  console.log(`\n❌ verifyRendererAtomicClaim: ${failures.length} of ${total} checks FAILED\n`);
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}
console.log(`✅ verifyRendererAtomicClaim: ${total}/${total} checks passed`);

/*
 * REVERT-PROOF LEDGER — mutations that must make this harness fail:
 *   1. Remove `claimedByWorker: null,` from claimOne()'s filter
 *        → A3 fails immediately (structural); B2/B3 fail behaviourally
 *          (two racers on one ad both win it — the exact double-charge
 *          this harness exists to prevent).
 *   2. Remove `status: 'rendering'` from the filter
 *        → A2 fails; B5 fails (a queued ad becomes claimable).
 *   3. Drop `claimedByWorker: null` from processAd's catch $set
 *        → C1 fails (a failed ad is stuck unclaimed forever).
 *   4. Drop `claimedByWorker: null` from requeueDeriveForRetry's $set
 *        → C2 fails.
 *   5. Drop `claimedByWorker: null` from any terminal (draft/failed) write
 *        → D1 fails, naming the offending call site by source offset.
 */
