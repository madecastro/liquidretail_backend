#!/usr/bin/env node
'use strict';
//
// verifyArchiveDigestRelease — an ARCHIVED ad must stop occupying its identity
// digest, and Stop must archive only the stopping run's own work.
//
// ── DEFECT 1 (money-adjacent, operator-visible). routes/ads.js Stop ran
//    `Ad.updateMany({ campaignId, status: 'queued' }, …archive…)` — EVERY
//    queued ad on the campaign, including rows other runs minted and are
//    waiting to claim, and mint leftovers waiting for a "Generate more".
//    Stopping run A silently destroyed run B's pending work. Owner ruled this
//    a bug 2026-08-18. Stop now parks only rows the stopping run owns
//    (campaignRunIds membership — stamped at mint, $addToSet'd at claim).
//
// ── DEFECT 2 (MONEY). `adSchema.index({ campaignId, identityDigest },
//    { unique: true })` is NOT partial — partialFilterExpression cannot say
//    `status != 'archived'`. Video digests deliberately omit generationRunId
//    (CLAUDE.md §2 — that omission is THE guard against a repeat Generate
//    re-billing a PAID Omni master). So once a never-billed leftover video was
//    archived, a repeat Generate's insertMany collided on the index, the 11000
//    was swallowed, and that video identity could never be minted again.
//    Archiving a receipt-free / renderUrl-empty row now RELEASES its digest to
//    an `archived:<_id>` tombstone; restoring hands it back.
//
// ── THE MONEY ANALYSIS THIS HARNESS EXISTS TO PIN. Freeing the slot is safe
//    ONLY for a row that was never billed and never delivered. The unique
//    index's job is to protect PAID identities from re-billing; a never-billed
//    identity SHOULD be re-mintable. Every check tagged [MONEY] below asserts
//    that a receipt-holding or renderUrl-bearing row KEEPS its digest.
//
// These checks EVALUATE the real exported pipeline stages and the real
// exported filters against real document shapes — not a regex over source.
// A source-text assertion cannot tell a working query from one that merely
// still contains the right words (verifyNoStrandedQueued's lesson), and a
// regex cannot see an unbound identifier at all (CLAUDE.md §4 — the
// `receiptFree` production incident), which is why group E derives the site
// list by SCANNING and asserts every site IMPORTS the helper.
//
// Revert-prove (each mutation must fail this harness):
//   1. Bypass the helper at one archive site (e.g. queuedArchiveSweeper writes
//      `$set: { status: 'archived' }` again)      → E2/E4 fail
//   2. Widen Stop's backlog filter back to `{ campaignId, status: 'queued' }`
//                                                  → D2/D3 fail
//   3. Drop the digest restore from the restore stage (status flip only)
//                                                  → C1 fails
//   4. Drop the no-double-wrap clause from DIGEST_RELEASABLE  → B3 fails
//   5. Remove `preArchiveIdentityDigest` from models/Ad.js    → E8 fails
//
// Pure + offline: no DB, no network, no API key.
//   node scripts/verifyArchiveDigestRelease.js

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const H = require('../services/adArchiveDigest');
const {
  TOMBSTONE_PREFIX,
  DIGEST_COLLISION_MESSAGE,
  tombstoneFor,
  isTombstoneDigest,
  buildArchiveSetStage,
  buildRestoreSetStage,
  buildArchivePipeline,
  buildRestorePipeline,
  isDigestCollisionError,
  buildStopUndispatchedArchiveFilter,
  buildStopBacklogArchiveFilter
} = H;
const { receiptFree } = require('../services/spendReceipt');

let checks = 0;
const ok = (label, fn) => {
  try { fn(); checks += 1; }
  catch (err) { console.error(`  ❌ ${label}\n     ${err.message}`); process.exitCode = 1; }
};

console.log('verifyArchiveDigestRelease\n');

const ROOT = path.join(__dirname, '..');

// ─────────────────────────────────────────────────────────────────────────
// A tiny AGGREGATION-EXPRESSION evaluator, covering exactly the operators the
// archive/restore stages use. Deliberately NOT general: it throws on anything
// it does not implement, so a future operator added to the pipeline cannot be
// silently mis-evaluated into a false pass (same discipline as the Mongo
// matcher in verifyNoStrandedQueued).
// ─────────────────────────────────────────────────────────────────────────
function resolvePath(doc, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), doc);
}

function evalExpr(expr, doc) {
  if (typeof expr === 'string') {
    if (expr.startsWith('$')) {
      const v = resolvePath(doc, expr.slice(1));
      return v === undefined ? undefined : v;
    }
    return expr;
  }
  if (expr === null || typeof expr !== 'object' || expr instanceof Date) return expr;
  if (Array.isArray(expr)) return expr.map((e) => evalExpr(e, doc));

  const keys = Object.keys(expr);
  if (keys.length !== 1 || !keys[0].startsWith('$')) {
    throw new Error(`evaluator: not an expression object: ${JSON.stringify(expr)}`);
  }
  const [op] = keys;
  const arg = expr[op];
  const A = () => (Array.isArray(arg) ? arg.map((a) => evalExpr(a, doc)) : [evalExpr(arg, doc)]);

  switch (op) {
    case '$literal': return arg;
    case '$ifNull': {
      const [v, fallback] = A();
      return (v === null || v === undefined) ? fallback : v;
    }
    case '$eq': { const [a, b] = A(); return sameValue(a, b); }
    case '$ne': { const [a, b] = A(); return !sameValue(a, b); }
    case '$and': return A().every(truthy);
    case '$or':  return A().some(truthy);
    case '$not': return !truthy(A()[0]);
    case '$cond': {
      if (!Array.isArray(arg)) throw new Error('evaluator: $cond object form not implemented');
      return truthy(evalExpr(arg[0], doc)) ? evalExpr(arg[1], doc) : evalExpr(arg[2], doc);
    }
    case '$in': {
      const [needle, hay] = A();
      return Array.isArray(hay) && hay.some((h) => sameValue(h, needle));
    }
    case '$type': {
      const [v] = A();
      if (v === undefined) return 'missing';
      if (v === null) return 'null';
      if (Array.isArray(v)) return 'array';
      if (v instanceof Date) return 'date';
      if (typeof v === 'string') return 'string';
      if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'double';
      if (typeof v === 'boolean') return 'bool';
      return 'object';
    }
    case '$concat': return A().map((v) => (v === null || v === undefined ? null : String(v))).join('');
    case '$toString': { const [v] = A(); return v === null || v === undefined ? null : String(v); }
    case '$substrCP': {
      const [s, start, len] = A();
      return String(s ?? '').slice(start, start + len);
    }
    default:
      throw new Error(`evaluator does not implement ${op} — extend it deliberately`);
  }
}

function sameValue(a, b) {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  // Mongo compares missing and null as equal only in QUERY context, not in
  // $eq; the stages always wrap reads in $ifNull, so strict is right here.
  return a === b;
}
// Mongo aggregation falsiness: false, null, undefined/missing, 0.
const truthy = (v) => !(v === false || v === null || v === undefined || v === 0);

/** Apply a `$set` stage object to a document, the way the server would. */
function applySetStage(stage, doc) {
  const out = { ...doc };
  for (const [field, expr] of Object.entries(stage)) {
    // Every field expression is evaluated against the stage's INPUT document.
    const v = evalExpr(expr, doc);
    if (field.includes('.')) {
      const parts = field.split('.');
      let cur = out;
      for (let i = 0; i < parts.length - 1; i++) {
        cur[parts[i]] = { ...(cur[parts[i]] || {}) };
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = v;
    } else {
      out[field] = v;
    }
  }
  return out;
}

// ── A Mongo query matcher for the Stop filters. Same shape/discipline as
// verifyNoStrandedQueued's — throws on anything it does not implement.
function matchOp(value, cond) {
  if (cond !== null && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
    for (const [op, operand] of Object.entries(cond)) {
      if (op === '$in') {
        if (value === undefined && operand.includes(null)) continue;
        if (Array.isArray(value)) { if (!value.some((v) => operand.includes(v))) return false; }
        else if (!operand.includes(value)) return false;
      } else if (op === '$nin') {
        if (Array.isArray(value)) { if (value.some((v) => operand.includes(v))) return false; }
        else if (operand.includes(value)) return false;
      } else if (op === '$exists') {
        const exists = value !== undefined;
        if (operand ? !exists : exists) return false;
      } else if (op === '$ne') {
        if (value === operand) return false;
      } else {
        throw new Error(`matcher does not implement operator ${op} — extend it deliberately`);
      }
    }
    return true;
  }
  if (cond === null) return value === null || value === undefined;
  // Mongo: a scalar against an array field is "array contains".
  if (Array.isArray(value)) return value.includes(cond);
  return value === cond;
}

function matches(doc, filter) {
  for (const [key, cond] of Object.entries(filter)) {
    if (key === '$or') { if (!cond.some((s) => matches(doc, s))) return false; }
    else if (key === '$and') { if (!cond.every((s) => matches(doc, s))) return false; }
    else if (key.startsWith('$')) throw new Error(`matcher does not implement top-level ${key}`);
    else {
      const v = Object.prototype.hasOwnProperty.call(doc, key)
        ? doc[key]
        : resolvePath(doc, key);
      if (!matchOp(v, cond)) return false;
    }
  }
  return true;
}

// ── Document fixtures ─────────────────────────────────────────────────────
const REAL_DIGEST = 'det-video:v1:8f3a91c0deadbeef';
const AD_ID = '64c000000000000000000abc';

function inertAd(over = {}) {
  return {
    _id: AD_ID,
    status: 'queued',
    identityDigest: REAL_DIGEST,
    preArchiveIdentityDigest: null,
    renderUrl: null,
    veoPredictionId: null,
    imageGeneration: { predictionId: null },
    campaignRunIds: ['run_stopping'],
    ...over
  };
}

// ─────────────────────────────────────────────────────────────────────────
// SOURCE SCAN. Set up here rather than in group E because groups B/C also
// assert wiring. The list is derived by WALKING services/ + routes/ +
// scripts/ — never hardcoded, so a new archive site cannot slip past
// (CLAUDE.md §4, the receiptFree unbound-identifier incident).
// ─────────────────────────────────────────────────────────────────────────
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const SCAN_DIRS = ['services', 'routes', 'scripts'].map((d) => path.join(ROOT, d));
const FILES = SCAN_DIRS.flatMap((d) => (fs.existsSync(d) ? walk(d) : []))
  // The verify* harnesses talk ABOUT these patterns; they never write.
  .filter((p) => !path.basename(p).startsWith('verify'));
const SRC = new Map(FILES.map((p) => [path.relative(ROOT, p), fs.readFileSync(p, 'utf8')]));
const STRIPPED = new Map([...SRC].map(([k, v]) => [k, stripComments(v)]));

const HELPER_REL = path.join('services', 'adArchiveDigest.js');
const HELPER_FNS = [
  'archiveAdsReleasingDigest', 'archiveOneReleasingDigest',
  'restoreAdsRestoringDigest', 'restoreOneRestoringDigest',
  'buildStopBacklogArchiveFilter', 'buildStopUndispatchedArchiveFilter',
  'isDigestCollisionError', 'DIGEST_COLLISION_MESSAGE',
  'restoreTookEffect', 'UNRESTORABLE_TOMBSTONE_MESSAGE'
];

/** Comment-stripped source of a scanned file, asserting it was found. */
function STRIPPED_LATE(rel) {
  const s = STRIPPED.get(rel);
  assert.ok(s, `${rel} missing from the scan`);
  return s;
}

// ═════════════════════════════════════════════════════════════════════════
// Group A — the evaluator itself is trustworthy.
// ═════════════════════════════════════════════════════════════════════════
ok('A1 evaluator: field paths, $literal, $ifNull', () => {
  assert.strictEqual(evalExpr('$a', { a: 7 }), 7);
  assert.strictEqual(evalExpr('$x.y', { x: { y: 'v' } }), 'v');
  assert.strictEqual(evalExpr({ $literal: '$notAField' }, {}), '$notAField');
  assert.strictEqual(evalExpr({ $ifNull: ['$missing', ''] }, {}), '');
  assert.strictEqual(evalExpr({ $ifNull: ['$a', ''] }, { a: null }), '');
  assert.strictEqual(evalExpr({ $ifNull: ['$a', ''] }, { a: 'x' }), 'x');
});
ok('A2 evaluator: $eq/$ne/$and/$not/$cond', () => {
  assert.strictEqual(evalExpr({ $eq: ['$a', 1] }, { a: 1 }), true);
  assert.strictEqual(evalExpr({ $ne: ['$a', 1] }, { a: 2 }), true);
  assert.strictEqual(evalExpr({ $and: [true, true] }, {}), true);
  assert.strictEqual(evalExpr({ $and: [true, false] }, {}), false);
  assert.strictEqual(evalExpr({ $not: [{ $eq: [1, 1] }] }, {}), false);
  assert.strictEqual(evalExpr({ $cond: [true, 'y', 'n'] }, {}), 'y');
  assert.strictEqual(evalExpr({ $cond: [false, 'y', 'n'] }, {}), 'n');
});
ok('A3 evaluator: $concat / $toString / $substrCP', () => {
  assert.strictEqual(evalExpr({ $concat: ['a:', { $toString: '$_id' }] }, { _id: 42 }), 'a:42');
  assert.strictEqual(evalExpr({ $substrCP: ['archived:xyz', 0, 9] }, {}), 'archived:');
});
ok('A3b evaluator: $type / $in match Mongo semantics for the shapes we gate on', () => {
  assert.strictEqual(evalExpr({ $type: '$missing' }, {}), 'missing');
  assert.strictEqual(evalExpr({ $type: '$a' }, { a: null }), 'null');
  assert.strictEqual(evalExpr({ $type: '$a' }, { a: 'x' }), 'string');
  assert.strictEqual(evalExpr({ $type: '$a' }, { a: [] }), 'array');
  assert.strictEqual(evalExpr({ $type: '$a' }, { a: {} }), 'object');
  assert.strictEqual(evalExpr({ $in: ['$a', ['x', 'y']] }, { a: 'y' }), true);
  assert.strictEqual(evalExpr({ $in: ['$a', ['x']] }, { a: 'z' }), false);
});
ok('A4 evaluator refuses an operator it does not implement', () => {
  assert.throws(() => evalExpr({ $gte: [1, 2] }, {}), /does not implement/);
});
ok('A5 applySetStage evaluates every field against the INPUT doc (not the partial output)', () => {
  // This is the property the archive stage depends on: `preArchive… = '$identityDigest'`
  // must see the ORIGINAL digest even though the same stage overwrites it.
  const out = applySetStage({ b: '$a', a: { $literal: 'new' } }, { a: 'old' });
  assert.strictEqual(out.b, 'old');
  assert.strictEqual(out.a, 'new');
});
ok('A6 matcher: array membership, $in, $exists, $or/$and', () => {
  assert.strictEqual(matches({ ids: ['r1'] }, { ids: 'r1' }), true);
  assert.strictEqual(matches({ ids: ['r2'] }, { ids: 'r1' }), false);
  assert.strictEqual(matches({ _id: 'a' }, { _id: { $in: ['a', 'b'] } }), true);
  assert.strictEqual(matches({}, { renderUrl: null }), true);
  assert.strictEqual(matches({ a: 1 }, { $or: [{ a: 2 }, { a: 1 }] }), true);
  assert.throws(() => matches({ a: 1 }, { a: { $gte: 1 } }), /does not implement/);
});

// ═════════════════════════════════════════════════════════════════════════
// Group B — the ARCHIVE pipeline, driven through the real exported stage.
// ═════════════════════════════════════════════════════════════════════════
const NOW = new Date('2026-08-18T12:00:00Z');
const archive = (doc, opts = {}) => applySetStage(buildArchiveSetStage({ now: NOW, ...opts }), doc);

ok('B1 [THE FIX] an inert row is archived and its digest released to a per-row tombstone', () => {
  const out = archive(inertAd());
  assert.strictEqual(out.status, 'archived');
  assert.strictEqual(out.identityDigest, `${TOMBSTONE_PREFIX}${AD_ID}`);
  assert.strictEqual(out.identityDigest, tombstoneFor(AD_ID));
  assert.ok(isTombstoneDigest(out.identityDigest));
  assert.deepStrictEqual(out.updatedAt, NOW);
});
ok('B1b the tombstone is UNIQUE BY CONSTRUCTION — two rows on one campaign never collide', () => {
  const a = archive(inertAd({ _id: 'id_aaa' }));
  const b = archive(inertAd({ _id: 'id_bbb' }));
  assert.notStrictEqual(a.identityDigest, b.identityDigest,
    'two archived rows sharing a tombstone would fail the (campaignId, identityDigest) unique index');
  // …even when they carried the SAME real digest before archiving (the exact
  // shape the sweeper produces when it parks a batch of duplicate leftovers).
  assert.strictEqual(a.preArchiveIdentityDigest, b.preArchiveIdentityDigest);
});
ok('B2 preArchiveIdentityDigest preserves the REAL digest verbatim', () => {
  const out = archive(inertAd());
  assert.strictEqual(out.preArchiveIdentityDigest, REAL_DIGEST);
  assert.ok(!isTombstoneDigest(out.preArchiveIdentityDigest));
});
ok('B3 [NO DOUBLE WRAP] re-archiving a tombstoned row does not overwrite the saved digest', () => {
  const once = archive(inertAd());
  const twice = archive({ ...once, status: 'archived' });
  assert.strictEqual(twice.preArchiveIdentityDigest, REAL_DIGEST,
    'a second archive must not save the tombstone over the real digest — the ad would be unrestorable');
  assert.strictEqual(twice.identityDigest, once.identityDigest,
    'the tombstone must not be re-wrapped into archived:archived:…');
});
ok('B4 [MONEY] a row holding a VIDEO spend receipt keeps its digest', () => {
  const out = archive(inertAd({ veoPredictionId: 'pred_omni_1', status: 'draft' }));
  assert.strictEqual(out.status, 'archived', 'the archive itself must still happen');
  assert.strictEqual(out.identityDigest, REAL_DIGEST,
    'freeing a PAID identity would let a repeat Generate re-mint and re-bill it (~$0.90 Omni)');
  assert.strictEqual(out.preArchiveIdentityDigest, null);
});
ok('B5 [MONEY] a row holding a STATIC spend receipt keeps its digest', () => {
  const out = archive(inertAd({ imageGeneration: { predictionId: 'pred_img_1' } }));
  assert.strictEqual(out.status, 'archived');
  assert.strictEqual(out.identityDigest, REAL_DIGEST);
  assert.strictEqual(out.preArchiveIdentityDigest, null);
});
ok('B6 [MONEY] a row with a renderUrl keeps its digest (something was delivered)', () => {
  const out = archive(inertAd({ renderUrl: 'https://res.cloudinary.com/x/ad.mp4', status: 'live' }));
  assert.strictEqual(out.status, 'archived');
  assert.strictEqual(out.identityDigest, REAL_DIGEST);
});
ok('B6b [MONEY] an empty-string renderUrl is still "nothing delivered" (default is null)', () => {
  assert.strictEqual(archive(inertAd({ renderUrl: '' })).identityDigest, tombstoneFor(AD_ID));
});
ok('B6c [MONEY] an empty-string receipt is still receipt-free; a missing field too', () => {
  assert.strictEqual(archive(inertAd({ veoPredictionId: '' })).identityDigest, tombstoneFor(AD_ID));
  const noFields = inertAd();
  delete noFields.veoPredictionId;
  delete noFields.imageGeneration;
  delete noFields.renderUrl;
  assert.strictEqual(archive(noFields).identityDigest, tombstoneFor(AD_ID),
    'schema default is null, so $exists:false semantics must not be required');
});
ok('B7 the status flip and updatedAt happen even when the digest is NOT released', () => {
  const out = archive(inertAd({ veoPredictionId: 'p', renderUrl: 'u' }));
  assert.strictEqual(out.status, 'archived');
  assert.deepStrictEqual(out.updatedAt, NOW);
});
ok('B8 extraSet values are $literal-wrapped — a copy string starting with $ is not a field path', () => {
  const stage = buildArchiveSetStage({ extraSet: { 'copy.headline': '$50 off' }, now: NOW });
  assert.deepStrictEqual(stage['copy.headline'], { $literal: '$50 off' },
    'an unwrapped "$50 off" resolves to the missing field "50 off" and silently blanks the headline');
  const out = applySetStage(stage, inertAd());
  assert.strictEqual(out.copy.headline, '$50 off');
});
ok('B9 extraSet cannot smuggle in a managed field', () => {
  for (const f of ['identityDigest', 'preArchiveIdentityDigest', 'status', 'updatedAt']) {
    assert.throws(() => buildArchiveSetStage({ extraSet: { [f]: 'x' } }), /managed by this helper/,
      `${f} must be rejected — overriding it defeats the whole guard`);
  }
});
ok('B11 [MONEY] a status:"rendering" row keeps its digest by default (submit-in-flight window)', () => {
  // "Receipt-free" means "we hold no receipt", NOT "never billed": providers
  // charge at SUBMIT and the receipt is written after the POST returns, so a
  // genuinely-billed ad is receipt-free for one HTTP round-trip. That window is
  // only reachable while status is 'rendering'. renderAttempts does not help —
  // it is $inc'd when a render ENDS, not when it starts.
  const out = archive(inertAd({ status: 'rendering' }));
  assert.strictEqual(out.status, 'archived');
  assert.strictEqual(out.identityDigest, REAL_DIGEST,
    'freeing a mid-submit row\'s identity would let a later Generate re-buy a ~$0.90 Omni master');
  assert.strictEqual(out.preArchiveIdentityDigest, null);
});
ok('B11b the Stop undispatched tail — and ONLY it — may opt in to releasing a rendering row', () => {
  const out = archive(inertAd({ status: 'rendering' }), { allowRenderingRelease: true });
  assert.strictEqual(out.identityDigest, tombstoneFor(AD_ID),
    'p.queue.slice(p.next) rows were provably never dispatched, so no submit can be in flight');
  assert.strictEqual(out.preArchiveIdentityDigest, REAL_DIGEST);
  // The opt-in must not weaken any other guard.
  assert.strictEqual(
    archive(inertAd({ status: 'rendering', veoPredictionId: 'p' }), { allowRenderingRelease: true }).identityDigest,
    REAL_DIGEST);
});
ok('B12 [MONEY] a non-object imageGeneration fails CLOSED, never "no receipt"', () => {
  // `imageGeneration` is Mixed. If it were ever a bare string or an array,
  // `$imageGeneration.predictionId` resolves to MISSING and a naive emptiness
  // test would read a real static receipt as receipt-free and free a PAID
  // identity. The $type guard refuses anything that is not null/absent/object.
  for (const weird of ['pred_paid_1', ['pred'], 42, [{ predictionId: 'p' }]]) {
    assert.strictEqual(archive(inertAd({ imageGeneration: weird })).identityDigest, REAL_DIGEST,
      `imageGeneration=${JSON.stringify(weird)} must not be read as receipt-free`);
  }
  // …while the two legitimate shapes still release.
  assert.strictEqual(archive(inertAd({ imageGeneration: null })).identityDigest, tombstoneFor(AD_ID));
  const missing = inertAd(); delete missing.imageGeneration;
  assert.strictEqual(archive(missing).identityDigest, tombstoneFor(AD_ID));
});
ok('B13 [MONEY] a row that ever ENTERED a render keeps its digest (billed-then-crashed)', () => {
  // "Receipt-free" cannot see a render that was BILLED and then crashed before
  // the receipt was persisted; the reaper requeues that row to 'queued', so it
  // reaches the archive sites looking pristine. Two independent markers refuse
  // it. renderAttempts alone is not enough — it is $inc'd when a render ENDS,
  // so a crash leaves it at 0; renderStage is what catches that case.
  assert.strictEqual(archive(inertAd({ renderAttempts: 1 })).identityDigest, REAL_DIGEST);
  assert.strictEqual(
    archive(inertAd({ renderAttempts: 0, renderStage: 'master video generation' })).identityDigest,
    REAL_DIGEST,
    'a crash mid-submit leaves renderAttempts 0 — renderStage is the only marker left');
  // The target population — mint leftovers and claimed-but-never-dispatched
  // rows — has neither marker. claimAdsForRun does not write renderStage.
  assert.strictEqual(archive(inertAd({ renderAttempts: 0, renderStage: null })).identityDigest,
    tombstoneFor(AD_ID));
  const bare = inertAd(); delete bare.renderAttempts; delete bare.renderStage;
  assert.strictEqual(archive(bare).identityDigest, tombstoneFor(AD_ID));
});
ok('B10 the archive update is an AGGREGATION PIPELINE (a plain $set cannot see $_id)', () => {
  const p = buildArchivePipeline({ now: NOW });
  assert.ok(Array.isArray(p) && p.length === 1 && p[0].$set,
    'mongoose 7.8.7 forwards an array update to the server untouched; an object update cannot derive the tombstone per row');
});

// ═════════════════════════════════════════════════════════════════════════
// Group C — the RESTORE pipeline.
// ═════════════════════════════════════════════════════════════════════════
const restore = (doc, status = 'draft') =>
  applySetStage(buildRestoreSetStage({ status, now: NOW }), doc);

ok('C1 [THE FIX] restoring hands the real digest back and clears the saved copy', () => {
  const archived = archive(inertAd());
  const out = restore(archived, 'draft');
  assert.strictEqual(out.status, 'draft');
  assert.strictEqual(out.identityDigest, REAL_DIGEST,
    'a restore that keeps the tombstone leaves a fake identity on a live ad');
  assert.strictEqual(out.preArchiveIdentityDigest, null);
});
ok('C1b [MONEY] restoring to QUEUED also restores the digest (selectAdsForRun can claim + BILL it)', () => {
  const out = restore(archive(inertAd()), 'queued');
  assert.strictEqual(out.status, 'queued');
  assert.strictEqual(out.identityDigest, REAL_DIGEST);
});
ok('C2 a row that never released a digest is left untouched (legacy / paid rows)', () => {
  const paidArchived = archive(inertAd({ veoPredictionId: 'p' }));
  const out = restore(paidArchived, 'draft');
  assert.strictEqual(out.identityDigest, REAL_DIGEST);
  assert.strictEqual(out.preArchiveIdentityDigest, null);
  assert.strictEqual(out.status, 'draft');
});
ok('C3 a non-tombstoned digest is never overwritten from preArchive… (belt and braces)', () => {
  const weird = inertAd({ status: 'archived', identityDigest: REAL_DIGEST, preArchiveIdentityDigest: 'stale' });
  const out = restore(weird, 'draft');
  assert.strictEqual(out.identityDigest, REAL_DIGEST);
  assert.strictEqual(out.preArchiveIdentityDigest, 'stale');
});
ok('C4 restore refuses a target status of "archived" (that is the archive path)', () => {
  assert.throws(() => buildRestoreSetStage({ status: 'archived' }), /non-archived target status/);
  assert.throws(() => buildRestoreSetStage({}), /non-archived target status/);
});
ok('C5 restore is also a pipeline, and its extraSet is literal-wrapped', () => {
  const p = buildRestorePipeline({ status: 'draft', extraSet: { 'copy.quote': '$ave big' }, now: NOW });
  assert.ok(Array.isArray(p) && p[0].$set);
  assert.deepStrictEqual(p[0].$set['copy.quote'], { $literal: '$ave big' });
});
ok('C6 [409] a duplicate-key error is recognised so the restore surfaces a 409, never a swallow', () => {
  assert.strictEqual(isDigestCollisionError({ code: 11000 }), true);
  assert.strictEqual(isDigestCollisionError({ code: '11000' }), true);
  assert.strictEqual(isDigestCollisionError({ cause: { code: 11000 } }), true);
  assert.strictEqual(isDigestCollisionError({ code: 66 }), false);
  assert.strictEqual(isDigestCollisionError(null), false);
  assert.ok(/re-created by a later generation/.test(DIGEST_COLLISION_MESSAGE));
});
ok('C8 [MONEY][INVARIANT] a tombstone can NEVER end up on a non-archived row', () => {
  // The digest restore is a $cond; an unconditional status flip beside it was a
  // hole. A row carrying `archived:<_id>` with NO saved digest (strict-schema
  // drop, hand-edited row, partial migration) would have been flipped to
  // queued/draft/live with the tombstone live as its identity — and
  // selectAdsForRun matches status:'queued', so it is claimable and BILLABLE
  // under a placeholder identity while the real identity stays free to remint.
  const orphanTombstone = inertAd({
    status: 'archived',
    identityDigest: tombstoneFor(AD_ID),
    preArchiveIdentityDigest: null
  });
  for (const target of ['draft', 'live', 'queued']) {
    const out = restore(orphanTombstone, target);
    assert.strictEqual(out.status, 'archived',
      `restoring to '${target}' must be refused, not silently applied with a placeholder identity`);
    assert.strictEqual(out.identityDigest, tombstoneFor(AD_ID));
    assert.strictEqual(H.restoreTookEffect(out, target), false,
      'restoreTookEffect must tell the caller the restore did not happen');
  }
  // A healthy tombstone still restores, and reports that it did.
  const healthy = restore(archive(inertAd()), 'draft');
  assert.strictEqual(H.restoreTookEffect(healthy, 'draft'), true);
  assert.ok(!isTombstoneDigest(healthy.identityDigest));
});
ok('C9 every restore surface REPORTS the refusal instead of claiming success', () => {
  const patch = STRIPPED_LATE('routes/ads.js');
  assert.ok(/restoreTookEffect\(ad,\s*targetStatus\)/.test(patch) && /identity-digest-unrecoverable/.test(patch),
    'PATCH must 409 when the restore was refused');
  const exec = STRIPPED_LATE('services/capabilityExecutors/adRestore.js');
  assert.ok(/restoreTookEffect\(restored,\s*restoredStatus\)/.test(exec) && /ok:\s*false/.test(exec),
    'ad.restore must return ok:false when the restore was refused');
  const purge = STRIPPED_LATE('scripts/purgeQueuedAds.js');
  assert.ok(/restoreTookEffect\(doc,\s*'queued'\)/.test(purge),
    'purgeQueuedAds --restore must check the status, not modifiedCount');
  assert.ok(!/modifiedCount/.test(purge.slice(purge.indexOf('if (RESTORE)'), purge.indexOf('const queuedFilter'))),
    'counting modifiedCount would report a refused restore as a success');
});
ok('C7 the collision is REACHABLE by construction — a remint takes the freed slot', () => {
  // Archive frees the slot; a later Generate legitimately re-mints the SAME
  // digest on the same campaign. Restoring then puts two rows on one identity,
  // which the unique index rejects. That is the 409 case, not a bug.
  const archived = archive(inertAd());
  const remint = inertAd({ _id: 'id_new', status: 'queued' });
  assert.strictEqual(remint.identityDigest, archived.preArchiveIdentityDigest,
    'the freed slot must genuinely be re-mintable, or the whole fix is pointless');
});

// ═════════════════════════════════════════════════════════════════════════
// Group D — Stop's two archive filters. The REAL exported queries, evaluated.
// ═════════════════════════════════════════════════════════════════════════
const STOPPING = 'run_stopping';
const BACKLOG_FILTER = buildStopBacklogArchiveFilter({ runId: STOPPING });

ok('D1 the stopping run\'s own minted-but-unclaimed leftover IS archived', () => {
  assert.strictEqual(matches(inertAd(), BACKLOG_FILTER), true,
    "Stop must still park its own tail, or the next Generate claims and bills it");
});
ok('D1b a row this run CLAIMED (addToSet) and left queued is archived too', () => {
  assert.strictEqual(
    matches(inertAd({ campaignRunIds: ['run_minted_elsewhere', STOPPING] }), BACKLOG_FILTER),
    true,
    'campaignRunIds membership covers both mint-ownership and claim-ownership'
  );
});
ok('D2 [THE BUG] another run\'s queued ad on the SAME campaign is NOT archived', () => {
  assert.strictEqual(
    matches(inertAd({ campaignRunIds: ['run_other'], campaignId: 'camp_1' }), BACKLOG_FILTER),
    false,
    "stopping one run must not destroy another run's pending work"
  );
});
ok('D2b an UNSTAMPED historical leftover is not archived by Stop (the 24h sweeper owns those)', () => {
  assert.strictEqual(matches(inertAd({ campaignRunIds: [] }), BACKLOG_FILTER), false);
});
ok('D3 the backlog filter is RUN-scoped, never campaign-scoped', () => {
  assert.strictEqual(BACKLOG_FILTER.campaignRunIds, STOPPING);
  assert.strictEqual(BACKLOG_FILTER.status, 'queued');
  assert.ok(!('campaignId' in BACKLOG_FILTER),
    'a campaignId key here is the defect: it archives every queued ad on the campaign');
  // And the bare shape the defect had must not match this run's own row either
  // way round — prove the two filters are genuinely different queries.
  const bare = { campaignId: 'camp_1', status: 'queued' };
  assert.strictEqual(matches(inertAd({ campaignRunIds: ['run_other'], campaignId: 'camp_1' }), bare), true,
    'sanity: the OLD filter did match another run\'s ad — that is what was fixed');
});
ok('D4 [MONEY] the backlog filter refuses a receipt / a renderUrl', () => {
  assert.strictEqual(matches(inertAd({ veoPredictionId: 'p' }), BACKLOG_FILTER), false);
  assert.strictEqual(matches(inertAd({ imageGeneration: { predictionId: 'p' } }), BACKLOG_FILTER), false);
  assert.strictEqual(matches(inertAd({ renderUrl: 'https://x/y.png' }), BACKLOG_FILTER), false);
});
ok('D4b the backlog filter is built with the SHARED receiptFree helper, not a hand-rolled copy', () => {
  const expected = receiptFree({
    campaignRunIds: STOPPING,
    status: 'queued',
    $and: [{ $or: [{ renderUrl: null }, { renderUrl: '' }] }]
  });
  assert.deepStrictEqual(BACKLOG_FILTER, expected);
});
ok('D5 [FAIL CLOSED] a missing runId matches NOTHING, never every queued ad in the DB', () => {
  for (const bad of [undefined, null, '', {}]) {
    const f = bad && typeof bad === 'object' ? buildStopBacklogArchiveFilter(bad) : buildStopBacklogArchiveFilter({ runId: bad });
    assert.strictEqual(matches(inertAd(), f), false,
      '{ campaignRunIds: undefined } is stripped by the driver, leaving { status: "queued" } — the whole database');
    assert.ok(!('status' in f), 'the fail-closed filter must not carry a bare status predicate');
  }
});
ok('D6 the undispatched filter archives only this run\'s claimed, never-dispatched rows', () => {
  const f = buildStopUndispatchedArchiveFilter({ adIds: [AD_ID, 'other'] });
  assert.strictEqual(matches(inertAd({ status: 'rendering' }), f), true);
  assert.strictEqual(matches(inertAd({ _id: 'not_in_list', status: 'rendering' }), f), false);
  assert.strictEqual(matches(inertAd({ status: 'queued' }), f), false,
    'status:rendering is load-bearing — a queued filter matched nothing post-claim (the original strand bug)');
});
ok('D7 [MONEY] the undispatched filter refuses a receipt — that row stays visible in rendering', () => {
  const f = buildStopUndispatchedArchiveFilter({ adIds: [AD_ID] });
  assert.strictEqual(matches(inertAd({ status: 'rendering', veoPredictionId: 'p' }), f), false,
    'bootRecoveryService can still collect a master we already paid for; archiving hides it');
  assert.strictEqual(matches(inertAd({ status: 'rendering', renderUrl: 'u' }), f), false);
});
ok('D8 [FAIL CLOSED] an empty id list matches nothing', () => {
  const f = buildStopUndispatchedArchiveFilter({ adIds: [] });
  assert.strictEqual(matches(inertAd({ status: 'rendering' }), f), false);
  assert.strictEqual(matches(inertAd(), buildStopUndispatchedArchiveFilter()), false);
});

// ═════════════════════════════════════════════════════════════════════════
// Group E — WIRING. The site list is DERIVED BY SCANNING, never hardcoded:
// CLAUDE.md §4 — "when a harness asserts a call site uses a helper, it must
// also assert that file IMPORTS the helper, and derive the file list by
// SCANNING, or the next call site is unguarded again."
// (The scan itself is set up above, before group A, because groups B/C use it
// too.)
// ═════════════════════════════════════════════════════════════════════════
ok('E0 the scan actually sees the repo (a scan that finds nothing passes everything)', () => {
  assert.ok(FILES.length > 200, `expected a real scan, found ${FILES.length} files`);
  assert.ok(SRC.has(HELPER_REL), 'services/adArchiveDigest.js not found by the scan');
});

ok('E1 the helper is the ONE definition — nothing else declares these functions', () => {
  for (const fn of ['archiveAdsReleasingDigest', 'restoreAdsRestoringDigest', 'buildArchiveSetStage']) {
    const definers = [...STRIPPED].filter(([rel, s]) =>
      rel !== HELPER_REL && new RegExp(`function\\s+${fn}\\s*\\(`).test(s));
    assert.deepStrictEqual(definers.map(([r]) => r), [],
      `${fn} is re-implemented outside the helper — the resolveDeriveFromMaster trap (CLAUDE.md §4)`);
  }
});

ok('E2 [SCAN] no file outside the helper writes status:"archived" with a bare $set', () => {
  const offenders = [];
  for (const [rel, s] of STRIPPED) {
    if (rel === HELPER_REL) continue;
    // A `$set` whose object literal contains status:'archived' — i.e. the
    // hand-rolled archive write this change replaced everywhere.
    const re = /\$set:\s*\{[^{}]*status:\s*['"]archived['"]/g;
    if (re.test(s)) offenders.push(rel);
    // Same thing as a bare update document (mongoose allows $set-less updates).
    const re2 = /update(?:One|Many)\(\s*[^;]{0,400}?\{\s*status:\s*['"]archived['"]/g;
    if (re2.test(s)) offenders.push(rel);
  }
  assert.deepStrictEqual([...new Set(offenders)], [],
    'every archive write must go through services/adArchiveDigest.js — a bypassed site leaves that identity slot squatted forever');
});

ok('E3 [SCAN] every file that USES a helper function also REQUIRES the helper', () => {
  // The exact production incident this rule comes from: services/processAlerts.js
  // called receiptFree({...}) and never imported it. A regex over source cannot
  // see an unbound identifier and node --check cannot either.
  const users = [];
  for (const [rel, s] of STRIPPED) {
    if (rel === HELPER_REL) continue;
    if (!HELPER_FNS.some((fn) => new RegExp(`\\b${fn}\\s*\\(`).test(s) || new RegExp(`\\b${fn}\\b`).test(s))) continue;
    users.push(rel);
    assert.ok(/require\(\s*['"][^'"]*adArchiveDigest['"]\s*\)/.test(SRC.get(rel)),
      `${rel} uses an adArchiveDigest export without requiring the module (ReferenceError at runtime)`);
  }
  assert.ok(users.length >= 6,
    `expected ≥6 wired archive/restore sites, scan found ${users.length} — the scan is not seeing them`);
});

ok('E4 [SCAN] every known archive surface routes through the helper', () => {
  // Derived: any file that FILTERS or REPORTS on archived and performs an Ad
  // status write must be one of the wired sites. Enumerated positively here so
  // a site that quietly stops calling the helper fails.
  const mustArchive = [
    'services/queuedArchiveSweeper.js',
    'services/capabilityExecutors/adArchive.js',
    'services/capabilityExecutors/adBulkArchive.js',
    'scripts/purgeQueuedAds.js',
    'routes/ads.js'
  ];
  for (const rel of mustArchive) {
    const s = STRIPPED.get(rel);
    assert.ok(s, `${rel} missing from the scan`);
    assert.ok(/archive(?:Ads|One)Releasing?Digest\(|archiveAdsReleasingDigest\(|archiveOneReleasingDigest\(/.test(s),
      `${rel} no longer calls the shared archive helper`);
    assert.ok(/require\(\s*['"][^'"]*adArchiveDigest['"]\s*\)/.test(SRC.get(rel)),
      `${rel} must require services/adArchiveDigest`);
  }
});

ok('E5 [SCAN] every surface that un-archives restores the digest AND handles the collision', () => {
  const mustRestore = [
    'routes/ads.js',
    'services/capabilityExecutors/adRestore.js',
    'scripts/purgeQueuedAds.js'
  ];
  for (const rel of mustRestore) {
    const s = STRIPPED.get(rel);
    assert.ok(s, `${rel} missing from the scan`);
    assert.ok(/restore(?:Ads|One)Restoring?Digest\(/.test(s),
      `${rel} un-archives without restoring the released identityDigest`);
    assert.ok(/isDigestCollisionError\(/.test(s),
      `${rel} must surface the 11000 as a refusal, never swallow it and keep the tombstone live`);
  }
  // And no un-archive anywhere does a bare status flip out of 'archived'.
  const restoreRel = 'services/capabilityExecutors/adRestore.js';
  assert.ok(!/\$set:\s*\{\s*status:\s*restoredStatus/.test(STRIPPED.get(restoreRel)),
    'adRestore must not bare-flip the status — a restored queued row would carry a fake identity');
});

ok('E6 routes/ads.js Stop uses the exported filter builders, not an inline query', () => {
  const adsSrc = STRIPPED.get('routes/ads.js');
  // Scope to runRenderLoop. A campaign-wide `{ campaignId, status:'queued' }`
  // READ is legitimate elsewhere (GET /runs/:runId counts queuedRemaining for
  // the "Generate more" affordance); it is only the Stop ARCHIVE that must
  // never be campaign-scoped again.
  const a = adsSrc.indexOf('async function runRenderLoop');
  const b = adsSrc.indexOf('async function renderOne');
  assert.ok(a > 0 && b > a, 'runRenderLoop / renderOne not found');
  const loopSrc = adsSrc.slice(a, b);
  // Assert the FULL call, not just that the builder name appears: a builder
  // whose result is never handed to the archive helper archives nothing, and
  // Stop would silently stop parking its own tail.
  assert.ok(
    /archiveAdsReleasingDigest\(\s*\n?\s*Ad,\s*\n?\s*buildStopUndispatchedArchiveFilter\(\{\s*adIds:\s*remaining\s*\}\)/.test(loopSrc),
    'the undispatched tail must be passed to archiveAdsReleasingDigest');
  assert.ok(
    /archiveAdsReleasingDigest\(\s*\n?\s*Ad,\s*\n?\s*buildStopBacklogArchiveFilter\(\{\s*runId:\s*run\.runId\s*\}\)/.test(loopSrc),
    'the run-scoped backlog must be passed to archiveAdsReleasingDigest');
  // …and both writes must still be there. Two archive calls, no more, no less.
  assert.strictEqual((loopSrc.match(/archiveAdsReleasingDigest\(/g) || []).length, 2,
    'Stop has exactly two archive writes: the undispatched tail and this run\'s queued backlog');
  assert.ok(!/campaignId:\s*(?:run|job)\.campaignId,?\s*status:\s*['"]queued['"]/.test(loopSrc),
    'the campaign-wide backlog archive is DEFECT 1 — it must not come back');
  assert.ok(!/Ad\.updateMany\(/.test(loopSrc.slice(loopSrc.indexOf('if (cancelled) {'))),
    'the Stop block must not hand-roll an Ad.updateMany — it bypasses the digest release');
});

ok('E7 PATCH /api/ads/:id answers a digest collision with 409, not 500', () => {
  const adsSrc = STRIPPED.get('routes/ads.js');
  const i = adsSrc.indexOf("router.patch('/:id'");
  assert.ok(i > 0, 'PATCH /:id not found');
  const block = adsSrc.slice(i, i + 4000);
  assert.ok(/archiveOneReleasingDigest\(/.test(block), 'PATCH → archived must release the digest');
  assert.ok(/restoreOneRestoringDigest\(/.test(block), 'PATCH → draft/live must restore the digest');
  assert.ok(/isDigestCollisionError\(err\)/.test(block));
  assert.ok(/res\.status\(409\)/.test(block), 'a taken identity slot is a 409');
});

ok('E8 [STRICT-SCHEMA TRAP] models/Ad.js DECLARES preArchiveIdentityDigest', () => {
  // Mongoose strict mode silently drops writes to UNDECLARED paths — this repo
  // already lost renderError.predictionId that way. Undeclared, the tombstone
  // would land and the saved digest would not: every archived ad unrestorable.
  const modelSrc = fs.readFileSync(path.join(ROOT, 'models', 'Ad.js'), 'utf8');
  assert.ok(/preArchiveIdentityDigest:\s*\{\s*type:\s*String,\s*default:\s*null\s*\}/.test(modelSrc),
    'preArchiveIdentityDigest must be declared on adSchema as { type: String, default: null }');
  assert.ok(/adSchema\.index\(\{\s*campaignId:\s*1,\s*identityDigest:\s*1\s*\},\s*\{\s*unique:\s*true\s*\}\)/.test(modelSrc),
    'the unique index this whole change works around must still exist');
});

ok('E9 the OWNERSHIP premise still holds — the mint stamps campaignRunIds', () => {
  // Stop's backlog filter tests campaignRunIds membership because that is where
  // the MINTING run is recorded (there is no persisted generationRunId field on
  // Ad). If the mint ever stops stamping it, Stop silently stops parking its
  // own leftovers — so pin the premise, not just the filter.
  const genSrc = STRIPPED.get('services/campaignAdsGenerationService.js');
  assert.ok(/function mintedCampaignRunIds/.test(genSrc));
  const uses = genSrc.match(/campaignRunIds:\s*mintedCampaignRunIds\(generationRunId\)/g) || [];
  assert.ok(uses.length >= 3, `expected ≥3 mint sites stamping the owning run, found ${uses.length}`);
  assert.ok(/\$addToSet:\s*\{\s*campaignRunIds:\s*runId\s*\}/.test(STRIPPED.get('routes/ads.js')),
    'the claim must $addToSet the claiming run, or claim-ownership is invisible to Stop');
  // Stop keys the backlog filter on `run.runId`; the mint stamps whatever is
  // passed as `generationRunId`. If those two ever diverge, Stop archives
  // nothing and this run's own leftovers stay queued — claimable, billable,
  // and silent. Pin that they are the same value at the single mint call site.
  const mints = (STRIPPED.get('routes/ads.js').match(/generationRunId:\s*([A-Za-z0-9_.]+)/g) || []);
  assert.ok(mints.length >= 1, 'routes/ads.js no longer passes generationRunId to the expansion');
  for (const m of mints) {
    assert.match(m, /generationRunId:\s*run\.runId/,
      `the mint must stamp run.runId (found "${m}") — Stop's ownership filter keys on it`);
  }
  // And there is genuinely no generationRunId path on the Ad schema to test —
  // if one is ever added, this check forces the filter to be revisited.
  const modelSrc = stripComments(fs.readFileSync(path.join(ROOT, 'models', 'Ad.js'), 'utf8'));
  assert.ok(!/^\s*generationRunId\s*:/m.test(modelSrc),
    'Ad now declares generationRunId — Stop\'s ownership filter should test it too');
});

ok('E10 the helper imports receiptFree rather than re-implementing the receipt clauses', () => {
  const raw = SRC.get(HELPER_REL);
  assert.ok(/require\(\s*['"]\.\/spendReceipt['"]\s*\)/.test(raw));
  assert.ok(/const \{\s*receiptFree\s*\}/.test(raw));
  assert.ok(!/veoPredictionId:\s*\{\s*\$in:/.test(stripComments(raw)),
    'the query-side receipt clauses must come from spendReceipt, not a local copy');
});

ok('E11 the sweeper still archives through the helper (and never deletes)', () => {
  const s = STRIPPED.get('services/queuedArchiveSweeper.js');
  assert.ok(/archiveAdsReleasingDigest\(\s*\n?\s*Ad,\s*\n?\s*buildQueuedArchiveWriteFilter\(/.test(s),
    'the sweep write must keep its money-guarded write filter AND go through the helper');
  assert.ok(!/deleteMany|deleteOne/.test(s));
});

ok('E13 [SCAN][MONEY] exactly ONE call site opts in to releasing a rendering row\'s digest', () => {
  const hits = [];
  for (const [rel, s] of STRIPPED) {
    if (rel === HELPER_REL) continue;
    const m = s.match(/allowRenderingRelease:\s*true/g);
    if (m) hits.push([rel, m.length]);
  }
  assert.deepStrictEqual(hits, [['routes/ads.js', 1]],
    'a second opt-in re-opens the submit-in-flight window (billed but receipt not yet written) — ' +
    'it needs the same by-construction proof Stop\'s undispatched tail has');
  const loop = STRIPPED.get('routes/ads.js');
  // lastIndexOf: the first occurrence is the import destructure at the top.
  const i = loop.lastIndexOf('buildStopUndispatchedArchiveFilter');
  assert.ok(i > 0 && /allowRenderingRelease:\s*true/.test(loop.slice(i, i + 400)),
    'the opt-in must sit on the undispatched-tail archive, nowhere else');
});

ok('E12 the tombstone prefix cannot collide with a real digest', () => {
  // Real digests are sha256 hex or a `det-video:v1:`-prefixed string; neither
  // can begin with 'archived:'. Assert the producers agree.
  const genSrc = STRIPPED.get('services/campaignAdsGenerationService.js');
  const prefixes = (genSrc.match(/createHash\('sha256'\)|det-video:v1|v2:/g) || []);
  assert.ok(prefixes.length > 0, 'digest producers not found — re-check this assumption');
  assert.ok(!genSrc.includes(`'${TOMBSTONE_PREFIX}`),
    `a digest producer emits the reserved prefix ${TOMBSTONE_PREFIX}`);
});

if (process.exitCode) {
  console.log(`\n❌ verifyArchiveDigestRelease: failures above (${checks} passed)`);
} else {
  console.log(`\n✅ verifyArchiveDigestRelease: ${checks}/${checks} checks passed`);
}
