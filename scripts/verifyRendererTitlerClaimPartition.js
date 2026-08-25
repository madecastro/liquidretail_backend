#!/usr/bin/env node
'use strict';
//
// verifyRendererTitlerClaimPartition — pins the renderer/titler claim
// split that has to hold the moment ADGEN_TITLER_ENABLED flips on.
//
// THE BUG: renderer.js claimOne() matches
//   { status:'rendering', claimedByWorker:null, renderRoute:{$in:['html_gen','veo']} }
// The video path, when isTitlerEnabled(), stamps titlingNeeded:true and
// CLEARS that claim in the same $set, leaving status:'rendering'. The
// next poll re-claims the row — a renderer/titler livelock, and a slot
// that $inc's renderAttempts on a paid master.
//
// WHAT THIS PINS (against the REAL claimOne() bodies, not a hand-copied
// filter and not a source-text scan for the string "titlingNeeded"):
//   A. Titler ON — renderer and titler claim sets are disjoint, and each
//      still takes the work it owns. Headline: a handed-off ad is
//      invisible to the renderer (query ran, store untouched — so a
//      claim-then-JS-skip still fails) and visible to the titler.
//      Mixed FIFO: an OLDER handoff sitting in front of a newer static
//      must not starve the static, and must not get claimed-then-skipped.
//   B. Titler OFF — leftover handoff rows ARE claimable by the renderer
//      (the documented rollback: flip the flag, title in-process again).
//   C. Drain a mixed bag — each ad is won by at most one role, and by
//      the right one.
//
// SOURCE EXTRACTION, not a copy — same discipline as
// verifyRendererAtomicClaim.js / verifyAdgenClaimRespectsRendererFlag.js:
// both claimOne() bodies are sliced out of the real source via
// balanced-brace parsing and executed as AsyncFunctions, so a change to
// the REAL filter changes what this harness tests.
//
// REVERT-PROOF (run by hand, restore before commit):
//   1. Remove the titlingNeeded spread from renderer.js claimOne()
//        → A3/A5/C1 fail (renderer wins the handoff).
//   2. Write `titlingNeeded: false` instead of `{ $ne: true }`
//        → A1 fails (pre-field static is no longer claimable).
//   3. Drop the isTitlerEnabled() gate (always exclude)
//        → B1 fails (rollback leftover stranded).
//   4. Claim then skip in JS (filter unchanged, early-return after)
//        → A3 fails (store was mutated / claimedByWorker set).
//
// Pure + offline: no DB, no network, no API keys, no node_modules
// (only Node builtins: fs, path, assert). Run:
//   node scripts/verifyRendererTitlerClaimPartition.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const RENDERER_PATH = path.join(__dirname, '..', 'src', 'services', 'renderer.js');
const TITLER_PATH   = path.join(__dirname, '..', 'src', 'services', 'titler.js');
const RENDERER_SRC  = fs.readFileSync(RENDERER_PATH, 'utf8');
const TITLER_SRC    = fs.readFileSync(TITLER_PATH, 'utf8');

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

const CLAIM_ONE_SIG = /async function claimOne\s*\(\s*\)\s*\{/;
const rendererClaimBody = functionBody(RENDERER_SRC, CLAIM_ONE_SIG);
const titlerClaimBody   = functionBody(TITLER_SRC, CLAIM_ONE_SIG);

function mongoMatch(filter, doc) {
  for (const [key, cond] of Object.entries(filter)) {
    const val = doc[key];
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
      for (const [op, operand] of Object.entries(cond)) {
        if (op === '$in') { if (!operand.includes(val)) return false; }
        else if (op === '$ne') { if (val === operand) return false; }
        else throw new Error(`mongoMatch: unsupported operator ${op} — extend deliberately`);
      }
    } else if (cond === null) {
      if (!(val === null || val === undefined)) return false;
    } else if (val !== cond) return false;
  }
  return true;
}

function makeAtomicCollection(seedDocs) {
  const store = seedDocs.map((d) => ({ ...d }));
  let calls = 0;
  return {
    findOneAndUpdate(filter, update, opts = {}) {
      calls += 1;
      let candidates = store.filter((d) => mongoMatch(filter, d));
      if (opts.sort) {
        const [key] = Object.keys(opts.sort);
        const dir = opts.sort[key];
        candidates = candidates.slice().sort((a, b) => (
          (a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0) * dir
        ));
      }
      const match = candidates[0];
      if (!match) return null;
      const idx = store.indexOf(match);
      const out = { ...match };
      if (update.$set) Object.assign(out, update.$set);
      store[idx] = out;
      return opts.new ? out : match;
    },
    all() { return store.map((d) => ({ ...d })); },
    callCount() { return calls; },
    byId(id) { return store.find((d) => d._id === id); }
  };
}

function buildClaimOne(body) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const inner = body.slice(1, -1);
  // eslint-disable-next-line no-new-func
  return new AsyncFunction('Ad', 'isAdgenRendererEnabled', 'isTitlerEnabled', 'WORKER_ID', inner);
}

const rendererOn = () => true;
const t0 = new Date('2026-01-01T00:00:00Z');
const t1 = new Date('2026-01-01T00:00:01Z');

function handoffDoc(over) {
  return Object.assign({
    _id: 'handoff',
    status: 'rendering',
    claimedByWorker: null,
    renderRoute: 'veo',
    titlingNeeded: true,
    veoVideoUrl: 'https://example/master.mp4',
    createdAt: t0
  }, over);
}

async function run() {
  const rendererClaim = buildClaimOne(rendererClaimBody);
  const titlerClaim   = buildClaimOne(titlerClaimBody);

  // ── A. Titler ON: partition ──────────────────────────────────────────
  {
    const Ad = makeAtomicCollection([
      { _id: 'static-prefield', status: 'rendering', claimedByWorker: null, renderRoute: 'html_gen', createdAt: t0 }
    ]);
    const won = await rendererClaim(Ad, rendererOn, () => true, 'renderer-1');
    check('A1 renderer+titlerOn claims a pre-field static (titlingNeeded absent)', () => {
      assert.ok(won && won._id === 'static-prefield',
        '`$ne: true` must match missing; `titlingNeeded: false` would drop pre-field rows');
      assert.strictEqual(Ad.byId('static-prefield').claimedByWorker, 'renderer-1');
    });
  }

  {
    const Ad = makeAtomicCollection([
      { _id: 'video-false', status: 'rendering', claimedByWorker: null, renderRoute: 'veo', titlingNeeded: false, createdAt: t0 }
    ]);
    const won = await rendererClaim(Ad, rendererOn, () => true, 'renderer-1');
    check('A2 renderer+titlerOn claims an explicit titlingNeeded:false video', () => {
      assert.ok(won && won._id === 'video-false');
    });
  }

  {
    const Ad = makeAtomicCollection([handoffDoc()]);
    const won = await rendererClaim(Ad, rendererOn, () => true, 'renderer-1');
    check('A3 [THE BUG] renderer+titlerOn does not claim a handed-off ad — query ran, store untouched', () => {
      assert.strictEqual(won, null, 'renderer claimed a titlingNeeded:true row — livelock');
      assert.ok(Ad.callCount() >= 1,
        'findOneAndUpdate must have run; a JS early-return that claims nothing also returns null but would hide a broken filter behind "renderer stood down"');
      assert.strictEqual(Ad.byId('handoff').claimedByWorker, null,
        'claim-then-JS-skip still steals the row from the titler');
    });
  }

  {
    const Ad = makeAtomicCollection([handoffDoc()]);
    const won = await titlerClaim(Ad, rendererOn, () => true, 'titler-1');
    check('A4 titler claims the same handed-off ad', () => {
      assert.ok(won && won._id === 'handoff', 'titler filter must select titlingNeeded:true + veoVideoUrl set');
      assert.strictEqual(Ad.byId('handoff').claimedByWorker, 'titler-1');
    });
  }

  {
    const Ad = makeAtomicCollection([
      handoffDoc({ _id: 'older-handoff', createdAt: t0 }),
      { _id: 'newer-static', status: 'rendering', claimedByWorker: null, renderRoute: 'html_gen', createdAt: t1 }
    ]);
    const won = await rendererClaim(Ad, rendererOn, () => true, 'renderer-1');
    check('A5 mixed FIFO: older handoff must not win (or starve) the newer static', () => {
      assert.ok(won && won._id === 'newer-static',
        `expected newer-static, got ${won && won._id} — without the exclusion, sort:createdAt:1 hands the renderer the older handoff`);
      assert.strictEqual(Ad.byId('older-handoff').claimedByWorker, null);
    });
  }

  {
    const Ad = makeAtomicCollection([handoffDoc({ veoVideoUrl: null })]);
    const won = await titlerClaim(Ad, rendererOn, () => true, 'titler-1');
    check('A6 titler does not claim a handoff with veoVideoUrl:null (receipt guard)', () => {
      assert.strictEqual(won, null);
    });
  }

  {
    const Ad = makeAtomicCollection([
      { _id: 'static', status: 'rendering', claimedByWorker: null, renderRoute: 'html_gen', createdAt: t0 }
    ]);
    const won = await titlerClaim(Ad, rendererOn, () => true, 'titler-1');
    check('A7 titler does not claim a static (no URL, titlingNeeded not true)', () => {
      assert.strictEqual(won, null);
    });
  }

  // ── B. Titler OFF: rollback leftover ─────────────────────────────────
  {
    const Ad = makeAtomicCollection([handoffDoc()]);
    const won = await rendererClaim(Ad, rendererOn, () => false, 'renderer-1');
    check('B1 renderer+titlerOff claims a leftover handoff (rollback path)', () => {
      assert.ok(won && won._id === 'handoff',
        'unconditional `$ne: true` strands leftover handoffs once the titler poll is asleep');
    });
  }

  // ── C. Drain a mixed bag ─────────────────────────────────────────────
  {
    const Ad = makeAtomicCollection([
      { _id: 'static', status: 'rendering', claimedByWorker: null, renderRoute: 'html_gen', createdAt: t0 },
      { _id: 'video', status: 'rendering', claimedByWorker: null, renderRoute: 'veo', titlingNeeded: false, createdAt: t0 },
      handoffDoc({ _id: 'handoff' }),
      { _id: 'queued', status: 'queued', claimedByWorker: null, renderRoute: 'html_gen', createdAt: t0 },
      handoffDoc({ _id: 'owned', claimedByWorker: 'someone-else' })
    ]);
    const rendererWins = [];
    for (;;) {
      const r = await rendererClaim(Ad, rendererOn, () => true, 'renderer-1');
      if (!r) break;
      rendererWins.push(r._id);
    }
    const titlerWins = [];
    for (;;) {
      const r = await titlerClaim(Ad, rendererOn, () => true, 'titler-1');
      if (!r) break;
      titlerWins.push(r._id);
    }
    check('C1 mixed drain: disjoint winners, right owner, no leftovers that should have been claimed', () => {
      assert.deepStrictEqual(rendererWins.sort(), ['static', 'video']);
      assert.deepStrictEqual(titlerWins, ['handoff']);
      assert.strictEqual(Ad.byId('queued').claimedByWorker, null);
      assert.strictEqual(Ad.byId('owned').claimedByWorker, 'someone-else');
    });
  }
}

run().then(() => {
  const total = checks + failures.length;
  if (failures.length) {
    console.log(`\n❌ verifyRendererTitlerClaimPartition: ${failures.length} of ${total} checks FAILED\n`);
    for (const f of failures) console.log(`  • ${f}`);
    process.exit(1);
  }
  console.log(`✅ verifyRendererTitlerClaimPartition: ${total}/${total} checks passed`);
}).catch((err) => {
  console.log(`\n❌ verifyRendererTitlerClaimPartition: harness threw — ${err.stack || err.message}\n`);
  process.exit(1);
});

/*
 * REVERT-PROOF LEDGER — mutations that must make this harness fail:
 *   1. Remove `...(isTitlerEnabled() ? { titlingNeeded: { $ne: true } } : {})`
 *      from renderer.js claimOne()
 *        → A3 fails (renderer wins the handoff, store mutated);
 *          A5 fails (older handoff sorts ahead of the static);
 *          C1 fails (rendererWins includes 'handoff').
 *   2. `titlingNeeded: false` instead of `{ $ne: true }`
 *        → A1 fails (pre-field static no longer matches).
 *   3. Always include `{ titlingNeeded: { $ne: true } }` (no isTitlerEnabled gate)
 *        → B1 fails (rollback leftover not claimed).
 *   4. Leave the filter alone; after claimOne, skip if ad.titlingNeeded
 *        → A3 fails (claimedByWorker was set — titler can no longer see it).
 */
