#!/usr/bin/env node
'use strict';
//
// verifyRegenerateConsumerClaim — pins the money invariant for the
// ad-gen regenerate-consumer handoff (routing fix, 2026-08-26): the
// backend's adRegenerateService.regenerateAd(), when ADGEN_RENDERER_ENABLED
// is true, stamps Ad.regenerationRequest and returns without executing;
// services/regenerateConsumer.js here claims and executes it. A double
// claim is a double billable submit (video Omni ~$0.90, static
// ~$0.07-0.15) — same money shape as verifyRendererAtomicClaim.js pins for
// the mint-time render claim, applied to this SEPARATE claim.
//
// WHAT THIS PINS (against the REAL source of regenerateConsumer.js, not a
// hand-copied reimplementation — same "SOURCE EXTRACTION" discipline as
// verifyRendererAtomicClaim.js):
//   A. claimOne()'s filter requires regenerating:true,
//      regenerationRequest:{$type:'object'}, regenerateClaimedByWorker:null.
//   B. Two concurrent claims against the same Ad document cannot both win —
//      simulated against an offline atomic-collection stub, driven by the
//      REAL filter/update text evaluated out of the source file.
//   C. claimOne() is gated on isAdgenRendererEnabled() — returns null
//      immediately when the flag is off, so a rolled-back deployment
//      cannot claim work the backend is about to execute itself.
//   D. DISJOINTNESS: this claim's filter can never match a row shaped for
//      the mint-time render claim (status:'rendering' + claimedByWorker)
//      or the titler claim (titlingNeeded), and vice versa — the three
//      claims key on entirely different field sets, so none can steal a
//      document that belongs to another.
//
// SOURCE EXTRACTION, not a copy. Every filter/update object this harness
// evaluates is sliced out of the actual src/services/regenerateConsumer.js
// text (via balanced-brace parsing) and evaluated with `new Function`, so a
// change to the REAL filter changes what this harness tests. Same
// discipline as verifyRendererAtomicClaim.js and backend's own
// verifyArchiveDigestRelease.js.
//
// Pure + offline: no DB, no network, no API keys. Run:
//   node scripts/verifyRegenerateConsumerClaim.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const CONSUMER_PATH = path.join(__dirname, '..', 'src', 'services', 'regenerateConsumer.js');
const SRC = fs.readFileSync(CONSUMER_PATH, 'utf8');

let checks = 0;
const failures = [];
function check(label, fn) {
  try { fn(); checks += 1; }
  catch (err) { failures.push(`${label}\n     ${err.message}`); }
}

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

check('A0 claimOne gates on isAdgenRendererEnabled() before ever querying', () => {
  const gateIdx = claimOneBody.search(/if\s*\(\s*!isAdgenRendererEnabled\(\)\s*\)\s*return\s+null;/);
  assert.ok(gateIdx >= 0, 'claimOne must return null immediately when the flag is off');
  const queryIdx = claimOneBody.indexOf('Ad.findOneAndUpdate(');
  assert.ok(queryIdx > gateIdx, 'the flag check must come BEFORE the query, not after');
});

const { args: claimArgs } = callArgs(claimOneBody, 'Ad.findOneAndUpdate(');
assert.strictEqual(claimArgs.length, 3, `claimOne's findOneAndUpdate should take (filter, update, opts) — got ${claimArgs.length} args`);
const [filterText, updateText, optsText] = claimArgs;

let claimFilter;
check('A1 filter is a self-contained literal — safe to literal-eval', () => {
  // eslint-disable-next-line no-new-func
  claimFilter = new Function(`return (${filterText});`)();
  assert.ok(claimFilter && typeof claimFilter === 'object');
});

check('A2 claim filter requires regenerating:true', () => {
  assert.strictEqual(claimFilter.regenerating, true,
    'without this the consumer could claim an ad that is not actually locked — a stray regenerationRequest with no lock is not a legal deferred request');
});
check('A3 [THE HANDOFF BIT] [MONEY] claim filter requires regenerationRequest:{$type:"object"} — NOT $ne:null', () => {
  assert.deepStrictEqual(claimFilter.regenerationRequest, { $type: 'object' },
    'regenerationRequest is the ONE field the backend local-execution path never writes, and it is also ABSENT ' +
    'on every ad that predates this migration. $ne:null is documented to match absent fields (MongoDB: "This ' +
    'includes documents that do not contain the field"), so a filter using $ne:null here would claim every ' +
    'regenerating:true row regardless of who is executing it — including ones the backend is running ' +
    'in-process right now. $type:"object" is the only operator that actually means "the backend stamped this".');
});
check('A4 [THE COMPARE-AND-SWAP] claim filter requires regenerateClaimedByWorker:null', () => {
  assert.strictEqual(claimFilter.regenerateClaimedByWorker, null,
    'without this the filter would match an ALREADY-CLAIMED row and a second worker could win it too');
});
check('A5 claim filter does NOT key on status or claimedByWorker (disjoint from the mint-time render claim)', () => {
  assert.ok(!('status' in claimFilter), 'this claim must not depend on Ad.status — a regenerate never sets it');
  assert.ok(!('claimedByWorker' in claimFilter), 'claimedByWorker belongs to the mint-time render claim; reusing it here would let this claim collide with that one');
});
check('A6 claim filter does NOT key on titlingNeeded (disjoint from the titler claim)', () => {
  assert.ok(!('titlingNeeded' in claimFilter));
});
check('A7 claim sorts oldest-first (fair queue, not starvation-prone) and returns the post-image', () => {
  assert.match(optsText, /sort:\s*\{\s*updatedAt:\s*1\s*\}/);
  assert.match(optsText, /new:\s*true/, 'findOneAndUpdate must return the POST-update doc, not the pre-image');
});

let claimUpdateShape;
check('A8 update sets regenerateClaimedByWorker and regenerateClaimedAt — nothing else', () => {
  // eslint-disable-next-line no-new-func
  claimUpdateShape = new Function('WORKER_ID', `return (${updateText});`)('__WORKER__');
  assert.ok(claimUpdateShape.$set, 'update must be a $set');
  const keys = Object.keys(claimUpdateShape.$set).sort();
  assert.deepStrictEqual(keys, ['regenerateClaimedAt', 'regenerateClaimedByWorker']);
  assert.strictEqual(claimUpdateShape.$set.regenerateClaimedByWorker, '__WORKER__');
});

// ═════════════════════════════════════════════════════════════════════════
// B — BEHAVIOURAL: replay the REAL filter/update against an offline atomic
// collection and prove two concurrent claimants cannot both win.
// ═════════════════════════════════════════════════════════════════════════
// $ne, faithfully: MongoDB's $ne matches documents that do NOT contain the
// field at all, in addition to documents whose value differs — this is
// documented behavior (see the $type case right below for why this stub
// bothers to get that right rather than the "intuitive but wrong" version).
function mongoNe(val, operand, hasKey) {
  if (!hasKey) return true; // absent field -> $ne matches, same as real Mongo
  return val !== operand;
}
// $type:'object' — the fix for the bug this file exists to catch (see A3 /
// B7 / B8 below): unlike $ne:null, $type:'object' requires the field to be
// PRESENT and be a plain embedded-document value. Absent -> false. Explicit
// null -> false. Array -> false (Mongo's "object" BSON type excludes
// arrays, which have their own "array" type).
function mongoIsObjectType(val, hasKey) {
  return hasKey && val !== null && typeof val === 'object' && !Array.isArray(val);
}
function mongoMatch(filter, doc) {
  for (const [key, cond] of Object.entries(filter)) {
    const hasKey = Object.prototype.hasOwnProperty.call(doc, key);
    const val = doc[key];
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
      for (const [op, operand] of Object.entries(cond)) {
        if (op === '$ne') { if (!mongoNe(val, operand, hasKey)) return false; }
        else if (op === '$in') { if (!operand.includes(val)) return false; }
        else if (op === '$type') {
          if (operand !== 'object') throw new Error(`mongoMatch: $type:${operand} not modeled — extend deliberately`);
          if (!mongoIsObjectType(val, hasKey)) return false;
        }
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
  return out;
}
// Synchronous core, same discipline as verifyRendererAtomicClaim.js: models
// a real findOneAndUpdate's server-side atomicity (a single indivisible
// read-modify-write) exactly, since JS never preempts sync code.
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

function deferredDoc(over = {}) {
  return {
    _id: 'ad1', regenerating: true,
    regenerationRequest: { kind: 'video', prompt: 'punchier' },
    regenerateClaimedByWorker: null, regenerateClaimedAt: null,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...over
  };
}

check('B1 sanity: two DIFFERENT unclaimed deferred ads each go to a different racer', () => {
  const coll = makeAtomicCollection([
    deferredDoc({ _id: 'ad1', updatedAt: new Date('2026-01-01T00:00:00Z') }),
    deferredDoc({ _id: 'ad2', updatedAt: new Date('2026-01-01T00:00:01Z') })
  ]);
  const opts = { new: true, sort: { updatedAt: 1 } };
  const r1 = coll.findOneAndUpdate(claimFilter, evalUpdateFor('workerA'), opts);
  const r2 = coll.findOneAndUpdate(claimFilter, evalUpdateFor('workerB'), opts);
  assert.ok(r1 && r2, 'both racers should win DIFFERENT ads when two are available');
  assert.notStrictEqual(r1._id, r2._id);
});

check('B2 [THE GUARANTEE] two racers on the SAME single deferred ad — only one wins', () => {
  const coll = makeAtomicCollection([deferredDoc()]);
  const opts = { new: true, sort: { updatedAt: 1 } };
  const results = [
    coll.findOneAndUpdate(claimFilter, evalUpdateFor('workerA'), opts),
    coll.findOneAndUpdate(claimFilter, evalUpdateFor('workerB'), opts)
  ];
  const winners = results.filter(Boolean);
  assert.strictEqual(winners.length, 1,
    `expected exactly one winner, got ${winners.length} — a double claim is a double billable submit`);
  const stored = coll.all()[0];
  assert.strictEqual(stored.regenerateClaimedByWorker, winners[0].regenerateClaimedByWorker,
    'the persisted document must reflect the single winner, not a lost update');
});

check('B3 ten racers on one deferred ad — still exactly one winner, in any dispatch order', () => {
  const coll = makeAtomicCollection([deferredDoc()]);
  const opts = { new: true, sort: { updatedAt: 1 } };
  const results = [];
  for (let i = 0; i < 10; i++) results.push(coll.findOneAndUpdate(claimFilter, evalUpdateFor(`worker${i}`), opts));
  assert.strictEqual(results.filter(Boolean).length, 1);
});

check('B4 [MONEY] a row with regenerating:true but regenerationRequest:null (local-execution path) is NEVER claimed', () => {
  const coll = makeAtomicCollection([deferredDoc({ regenerationRequest: null })]);
  const r = coll.findOneAndUpdate(claimFilter, evalUpdateFor('workerA'), { new: true, sort: { updatedAt: 1 } });
  assert.strictEqual(r, null,
    'the backend is executing this ad in-process right now (flag was off when it locked) — claiming it here would be a concurrent double-execution');
});

check('B5 a row already claimed by a peer (regenerateClaimedByWorker set) is NOT re-claimed', () => {
  const coll = makeAtomicCollection([deferredDoc({ regenerateClaimedByWorker: 'renderer-abc123' })]);
  const r = coll.findOneAndUpdate(claimFilter, evalUpdateFor('workerA'), { new: true, sort: { updatedAt: 1 } });
  assert.strictEqual(r, null);
});

check('B6 a row with regenerating:false (already completed / not locked) is NOT claimed', () => {
  const coll = makeAtomicCollection([deferredDoc({ regenerating: false })]);
  const r = coll.findOneAndUpdate(claimFilter, evalUpdateFor('workerA'), { new: true, sort: { updatedAt: 1 } });
  assert.strictEqual(r, null);
});

// Truly OMIT a key — not { key: undefined } (object spread keeps that key
// present with an undefined value; hasOwnProperty would still say true).
// This is the shape that actually matters: every Ad document that predates
// this migration, and every ad whose regenerate ran on the LOCAL execution
// path, never had regenerationRequest / regenerateClaimedByWorker written
// at all — the field is genuinely absent, not present-and-null.
function withoutKey(doc, key) {
  const out = { ...doc };
  delete out[key];
  return out;
}

check('B7 [MONEY][THE REGRESSION THIS FILE EXISTS TO CATCH] a STUCK row (regenerating:true, regenerationRequest genuinely ABSENT — e.g. a pre-migration ad, or one crashed on the local-execution path) is NEVER claimed', () => {
  const coll = makeAtomicCollection([withoutKey(deferredDoc(), 'regenerationRequest')]);
  const r = coll.findOneAndUpdate(claimFilter, evalUpdateFor('workerA'), { new: true, sort: { updatedAt: 1 } });
  assert.strictEqual(r, null,
    'MongoDB\'s $ne:null matches documents that do not contain the field at all (documented behavior) — a claim ' +
    'filter using $ne:null here would treat every historically-stuck regenerating:true row, and every row the ' +
    'backend is currently executing locally, as fair game. This is the exact bug: $type:"object" must be used ' +
    'instead, and this check exists specifically so a future edit back to $ne:null goes red here.');
});

check('B8 a row missing regenerateClaimedByWorker entirely (never touched by this claim before) IS still claimable', () => {
  // Sanity companion to B7: omitting the CLAIM field (as opposed to the
  // HANDOFF field) must not become over-strict as a side effect of fixing
  // B7 — a freshly-stamped deferred row that this consumer has never
  // touched yet is exactly what SHOULD be claimable.
  const coll = makeAtomicCollection([withoutKey(deferredDoc(), 'regenerateClaimedByWorker')]);
  const r = coll.findOneAndUpdate(claimFilter, evalUpdateFor('workerA'), { new: true, sort: { updatedAt: 1 } });
  assert.ok(r, 'a deferred row with no prior claim attempt must still be claimable');
});

// ═════════════════════════════════════════════════════════════════════════
// C — DISJOINTNESS: this claim can never collide with the mint-time render
// claim or the titler claim on the same document.
// ═════════════════════════════════════════════════════════════════════════
check('C1 a row shaped for the MINT-TIME RENDER claim (status:rendering, claimedByWorker:null, no regenerate fields) is NOT claimable here', () => {
  const coll = makeAtomicCollection([
    { _id: 'renderAd', status: 'rendering', claimedByWorker: null, renderRoute: 'veo', updatedAt: new Date() }
    // regenerating / regenerationRequest / regenerateClaimedByWorker are all
    // undefined on this doc — a real Ad row not currently mid-regenerate.
  ]);
  const r = coll.findOneAndUpdate(claimFilter, evalUpdateFor('workerA'), { new: true, sort: { updatedAt: 1 } });
  assert.strictEqual(r, null, 'this consumer must never touch a row that only the mint-time render claim owns');
});

check('C2 a deferred regenerate row (this claim\'s target) does not satisfy renderer.js\'s OWN claim filter either', () => {
  // Cross-check using renderer.js's real filter text, so this is not just
  // "we didn't name the field" but "the two filters are provably disjoint
  // on a document that only satisfies one of them".
  const rendererSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'renderer.js'), 'utf8');
  const rendererClaimBody = functionBody(rendererSrc, /async function claimOne\s*\(\s*\)\s*\{/);
  const { args: rendererArgs } = callArgs(rendererClaimBody, 'Ad.findOneAndUpdate(');
  // eslint-disable-next-line no-new-func
  const rendererFilter = new Function('isTitlerEnabled', `return (${rendererArgs[0]});`)(() => false);
  const doc = deferredDoc(); // status/claimedByWorker/renderRoute all undefined
  assert.strictEqual(mongoMatch(rendererFilter, doc), false,
    'a row locked for regenerate (no status:"rendering") must not also satisfy the render claim');
});

// ═════════════════════════════════════════════════════════════════════════
// D — MONEY: runClaimedRegeneration re-checks the two staleness-prone
// preflight gates before spending anything, since the deferred path can now
// sit queued for minutes (preflight ran at the 202, not at execution).
// ═════════════════════════════════════════════════════════════════════════
check('D1 runClaimedRegeneration re-checks metaSyncStatus BEFORE any provider dispatch', () => {
  const adRegenSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'adRegenerateService.js'), 'utf8');
  const fnBody = functionBody(adRegenSrc, /async function runClaimedRegeneration\s*\([^)]*\)\s*\{/);
  const syncedIdx = fnBody.search(/metaSyncStatus\s*===\s*'synced'/);
  assert.ok(syncedIdx >= 0, 'runClaimedRegeneration does not re-check metaSyncStatus at all');
  const dispatchIdx = fnBody.search(/runVideoFull\s*\(|runImage\s*\(/);
  assert.ok(dispatchIdx >= 0, 'could not find the provider dispatch to order against');
  assert.ok(syncedIdx < dispatchIdx,
    'the metaSyncStatus re-check must happen BEFORE runVideoFull/runImage, not after — a synced ad exported ' +
    'while queued must never be silently overwritten by a queued regenerate');
});

check('D2 runClaimedRegeneration re-checks resolveDeriveFromMaster BEFORE any provider dispatch', () => {
  const adRegenSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'adRegenerateService.js'), 'utf8');
  const fnBody = functionBody(adRegenSrc, /async function runClaimedRegeneration\s*\([^)]*\)\s*\{/);
  const deriveIdx = fnBody.search(/resolveDeriveFromMaster\s*\(/);
  assert.ok(deriveIdx >= 0, 'runClaimedRegeneration does not re-check resolveDeriveFromMaster at all');
  const dispatchIdx = fnBody.search(/runVideoFull\s*\(|runImage\s*\(/);
  assert.ok(deriveIdx < dispatchIdx,
    'the derive-only re-check must happen BEFORE runVideoFull/runImage — a fall-through here is exactly the ' +
    'money-critical gate preflight() exists to enforce, on the one surface the product sells as free derivation');
});

check('D3 both stale-gate refusals call markComplete with status:"failed" and NEVER reach the dispatcher', () => {
  const adRegenSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'adRegenerateService.js'), 'utf8');
  const fnBody = functionBody(adRegenSrc, /async function runClaimedRegeneration\s*\([^)]*\)\s*\{/);
  // Both refusal blocks must each contain a `return;` before the function's
  // main try/dispatch — approximated by requiring two `return;` statements
  // ahead of the first runVideoFull/runImage call.
  const dispatchIdx = fnBody.search(/runVideoFull\s*\(|runImage\s*\(/);
  const before = fnBody.slice(0, dispatchIdx);
  const returns = (before.match(/\breturn;/g) || []).length;
  assert.ok(returns >= 2,
    `expected at least 2 early returns before dispatch (one per stale-gate refusal), found ${returns}`);
  const markCompletes = (before.match(/markComplete\s*\(\s*adId\s*,\s*\{\s*\n?\s*status:\s*'failed'/g) || []).length;
  assert.ok(markCompletes >= 2,
    `expected at least 2 markComplete(..., {status:'failed'...}) calls before dispatch, found ${markCompletes}`);
});

// ═════════════════════════════════════════════════════════════════════════
// Report
// ═════════════════════════════════════════════════════════════════════════
console.log('verifyRegenerateConsumerClaim');
if (failures.length) {
  console.error(`\n❌ verifyRegenerateConsumerClaim: ${failures.length} of ${checks + failures.length} checks FAILED\n`);
  failures.forEach((f) => console.error(`  ✗ ${f}`));
  process.exit(1);
}
console.log(`✅ verifyRegenerateConsumerClaim: ${checks}/${checks} checks passed`);
