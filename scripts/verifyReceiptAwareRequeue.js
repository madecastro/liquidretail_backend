#!/usr/bin/env node
'use strict';
//
// verifyReceiptAwareRequeue — pins the ONE rule that keeps a restart from
// re-buying work we have already paid for:
//
//   AN AD HOLDING A SPEND RECEIPT IS NEVER REQUEUED.
//
// WHY THIS EXISTS (2026-08-04, measured in production):
//   There are exactly TWO places that move an ad `rendering` -> `queued`:
//     1. services/processAlerts.js  persistOrphans  — runs on EVERY SIGTERM,
//        so on every deploy. This is the dangerous one.
//     2. worker.js                  reapOrphans     — the 15-minute sweep.
//   Both were unconditional `updateMany({ status: 'rendering' }, ...)`.
//
//   An ad holding Ad.veoPredictionId (video) or Ad.imageGeneration.predictionId
//   (static) has ALREADY BEEN BILLED — the provider charges at submit, not at
//   completion. Requeuing it means the next run SUBMITS AGAIN, so we pay twice
//   for a generation Atlas may already have delivered. atlasVideoService says so
//   itself at the charge point: "without it a crash mid-poll loses the only
//   handle to work we have paid for, and the reaper re-queues the ad into a
//   second submit."
//
//   Measured: a 411s Omni master completed at 17:27:09 and persistOrphans
//   requeued its run one second later, at 17:27:10.
//
//   Receipt-FREE ads must STILL be requeued — they were never billed, so
//   re-running them costs the one charge that was always owed. A fix that
//   stopped requeuing everything would strand legitimate work, so this harness
//   pins BOTH directions.
//
// This harness is pure + offline: no DB, no network, no API key.
//   node scripts/verifyReceiptAwareRequeue.js
//
// Revert-prove (each mutation must fail this harness):
//   (a) In worker.js reapOrphans, drop the receipt clauses from the Ad
//       updateMany filter -> W* fail.
//   (b) In processAlerts persistOrphans, drop them there -> P* fail.
//   (c) Add a THIRD unconditional `status: 'rendering'` -> `queued` write
//       anywhere in worker.js / services/ -> X1 fails (the exhaustive scan).
//   (d) In worker.js reapOrphans, drop `claimedByWorker: null` from the
//       receiptFree filter -> W5 fails (an adgen-claimed row is reaped).
//   Report the failing output verbatim when proving.
//
// Covered:
//   W*  worker.js reapOrphans excludes both receipt fields AND does not
//       reap rows already claimed by an adgen worker (claimedByWorker set)
//   P*  processAlerts persistOrphans excludes both receipt fields
//   R*  receipt-free ads are still requeued (the fix did not strand work)
//   X*  exhaustive: no OTHER site requeues rendering -> queued unguarded

const fs   = require('fs');
const path = require('path');
const { walkSource } = require('./lib/sourceWalk');

const ROOT = path.join(__dirname, '..');
const WORKER = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
const ALERTS = fs.readFileSync(path.join(ROOT, 'services', 'processAlerts.js'), 'utf8');

// Conservative JS comment stripper, used by every source assertion in this file.
//
// LOAD-BEARING (2026-08-04). An adversarial pass found these checks false-passing:
// with the real `receiptFree` import COMMENTED OUT — so the identifier is genuinely
// unbound at runtime, reproducing the exact production bug this harness exists to
// catch — a raw-text regex still matched the commented line and the harness went
// green. A check a comment can satisfy is the same defect it was written to catch.
// It also matters for X1: a commented-out receiptFree( inside a requeue block would
// make an UNGUARDED money write look guarded.
// Respects string/template literals so an import quoted in a string cannot pass
// either. Comment bodies become spaces so offsets stay stable.
function stripComments(src) {
  let out = '';
  let i = 0;
  let quote = null;   // ' " ` when inside a string
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (quote) {
      if (c === '\\') { out += c + (n || ''); i += 2; continue; }
      if (c === quote) quote = null;
      out += c; i++; continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue; }
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (c === '/' && n === '*') {
      out += '  '; i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' '; i++;
      }
      out += '  '; i += 2;
      continue;
    }
    out += c; i++;
  }
  return out;
}
const GUARD  = fs.readFileSync(path.join(ROOT, 'services', 'spendReceipt.js'), 'utf8');

// The ONE definition. If these field names drift from models/Ad.js, every site
// silently stops guarding — so they are pinned here, once.
const { RECEIPT_FREE, HAS_RECEIPT, receiptFree } = require('../services/spendReceipt');

let pass = 0;
const failures = [];
function checkTrue(label, cond, extra) {
  if (cond) { pass++; return; }
  failures.push(label + (extra ? ` — ${extra}` : ''));
}

// Both receipt fields must be excluded. Checking only one would let the other
// class of paid work be re-bought: video receipts live on veoPredictionId,
// static receipts on imageGeneration.predictionId.
// After 2026-08-04 every requeue site composes ONE shared filter rather than
// carrying its own copy — five hand-written copies of a money guard is five
// chances to get it wrong. So the sites are checked for USE of the helper and
// the helper itself is checked for the actual field names.
function guardsBothReceipts(block) {
  return /receiptFree\(/.test(block);
}

// Isolate the Ad requeue write from each site so a receipt mention ELSEWHERE in
// the file cannot satisfy the check by accident.
// Must find the AD requeue, not just the first `status: 'queued'` write.
// worker.js also resets DetectRun `processing` -> `queued`, which matched the
// naive search and made these checks assert against the wrong query entirely —
// they failed while the real Ad guard was present and correct.
//
// TWO anchor shapes, added 2026-08-19 alongside the undispatched-tail fix
// (services/adArchiveDigest.js, "THE UNDISPATCHED-TAIL GAP"). Both worker.js's
// reaper and processAlerts.js's SIGTERM handler moved from a bare
// `{ $set: { status: 'queued', ... } }` to `buildRequeuePipeline({...})`, so
// the literal `status: 'queued'` text no longer appears at either call site —
// it lives inside that function, in a different file. The `receiptFree(...)`
// FILTER (this function's whole reason to exist) is completely unchanged at
// both sites, still the first argument to the SAME `updateMany(` call, so
// once the block is found the receipt checks below still evaluate the real
// guard, not a copy.
function adRequeueBlock(src) {
  for (const anchor of ["$set: { status: 'queued'", 'buildRequeuePipeline(']) {
    let at = src.indexOf(anchor);
    while (at >= 0) {
      const from = src.lastIndexOf('updateMany(', at);
      if (from >= 0) {
        const block = src.slice(from, at + 60);
        if (/status: 'rendering'/.test(block)) return block;   // ads only
      }
      at = src.indexOf(anchor, at + 1);
    }
  }
  return '';
}

// ── W: worker.js reapOrphans ─────────────────────────────────────────
const wBlock = adRequeueBlock(WORKER);
checkTrue('W0 worker.js still has an Ad rendering->queued requeue', wBlock.length > 0);
checkTrue('W1 worker reaper excludes BOTH receipt fields from the requeue',
  guardsBothReceipts(wBlock));
checkTrue('W2 worker reaper still filters on status rendering + a staleness cutoff',
  /status: 'rendering'/.test(wBlock) && /updatedAt/.test(wBlock));
// Visibility: an ad left in `rendering` on purpose must not look like a bug.
checkTrue('W3 the worker logs the ads it deliberately did NOT requeue',
  /hold a spend receipt/.test(WORKER) && /NOT requeued/.test(WORKER));

// ── W4–W7: claimedByWorker:null is a MONEY conjunct, not decoration ────
// Adgen claims rows via findOneAndUpdate({status:'rendering',
// claimedByWorker:null}, {$set:{claimedByWorker, claimedAt}}). Without this
// conjunct the backend reaper would $set status:'queued' on ads adgen is
// currently rendering, stealing the claim (observed 2026-08-22: derive
// b431a9 accumulated 15 runIds in ~5 hours while adgen was mid-wait for a
// sibling master). A source-text "the words are still there" pin would stay
// green if the conjunct were moved into a comment; these checks evaluate
// the REAL worker.js reaper filter against a constructed document.
//
// Matcher supports exactly what receiptFree(reaper-inner) emits: $and, $or,
// $lt, $in, $exists, dotted paths, and plain equality (incl. Mongo's
// missing===null). Unsupported operators throw — extend on purpose.
function getPath(doc, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), doc);
}
function mongoNullEquals(actual, operand) {
  if (operand === null) return actual === null || actual === undefined;
  return actual === operand;
}
function matchesCondition(actual, cond) {
  if (cond !== null && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
    for (const [op, operand] of Object.entries(cond)) {
      if (op === '$lt') {
        if (actual == null) return false;
        const a = actual instanceof Date ? actual.getTime() : actual;
        const b = operand instanceof Date ? operand.getTime() : operand;
        if (!(a < b)) return false;
      } else if (op === '$in') {
        if (!operand.some((v) => mongoNullEquals(actual, v))) return false;
      } else if (op === '$nin') {
        if (operand.some((v) => mongoNullEquals(actual, v))) return false;
      } else if (op === '$exists') {
        const exists = actual !== undefined;
        if (operand ? !exists : exists) return false;
      } else {
        throw new Error(`matchesCondition: unsupported operator ${op} — extend deliberately`);
      }
    }
    return true;
  }
  return mongoNullEquals(actual, cond);
}
function matchesFilter(doc, filter) {
  for (const [key, cond] of Object.entries(filter)) {
    if (key === '$and') {
      if (!cond.every((sub) => matchesFilter(doc, sub))) return false;
      continue;
    }
    if (key === '$or') {
      if (!cond.some((sub) => matchesFilter(doc, sub))) return false;
      continue;
    }
    if (!matchesCondition(getPath(doc, key), cond)) return false;
  }
  return true;
}
function extractReceiptFreeArg(block) {
  const start = block.indexOf('receiptFree(');
  if (start < 0) return null;
  let i = start + 'receiptFree('.length;
  while (i < block.length && /\s/.test(block[i])) i++;
  if (block[i] !== '{') return null;
  const objStart = i;
  let depth = 0;
  for (; i < block.length; i++) {
    const c = block[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return block.slice(objStart, i + 1);
    }
  }
  return null;
}

const objSrc = extractReceiptFreeArg(wBlock);
checkTrue('W4 worker reaper filter is extractable (receiptFree arg)', !!objSrc,
  'adRequeueBlock did not contain a receiptFree({...}) object literal');

const REAP_CUTOFF = new Date('2026-09-06T00:00:00Z');
let reaperFilter = null;
if (objSrc) {
  try {
    reaperFilter = receiptFree(Function('cutoff', `"use strict"; return (${objSrc});`)(REAP_CUTOFF));
  } catch (err) {
    checkTrue('W4b extracted reaper filter evaluates', false, err && err.message);
  }
}

const STALE = new Date(REAP_CUTOFF.getTime() - 20 * 60 * 1000);
const claimedAdgenRow = {
  status: 'rendering',
  updatedAt: STALE,
  claimedByWorker: 'some-adgen-worker-id',
  veoPredictionId: null,
  imageGeneration: { predictionId: null }
};

checkTrue('W5 a stale receipt-free rendering ad claimed by adgen is NOT reaped',
  !!reaperFilter && matchesFilter(claimedAdgenRow, reaperFilter) === false);

checkTrue('W6 the same row with claimedByWorker:null IS reaped (conjunct is the only reason W5 holds)',
  !!reaperFilter && matchesFilter({ ...claimedAdgenRow, claimedByWorker: null }, reaperFilter) === true);

{
  const withoutClaimConjunct = reaperFilter ? { ...reaperFilter } : null;
  if (withoutClaimConjunct) delete withoutClaimConjunct.claimedByWorker;
  checkTrue('W7 dropping claimedByWorker:null WOULD match the adgen-claimed row (W5 is not vacuous)',
    !!withoutClaimConjunct && matchesFilter(claimedAdgenRow, withoutClaimConjunct) === true);
}

// ── P: processAlerts persistOrphans (fires on EVERY deploy) ───────────
const pBlock = adRequeueBlock(ALERTS);
checkTrue('P0 processAlerts still has an Ad rendering->queued requeue', pBlock.length > 0);
checkTrue('P1 persistOrphans excludes BOTH receipt fields from the requeue',
  guardsBothReceipts(pBlock));
checkTrue('P2 persistOrphans still scopes to this process\'s own runIds',
  /campaignRunIds/.test(pBlock));

// ── R: receipt-FREE ads must still be requeued ───────────────────────
// The guard has to be an ABSENCE test, not a blanket exclusion. `$in: [null,'']`
// plus `$exists: false` covers an unset field, an explicit null, and the empty
// string. A bare `$exists: false` alone would miss `veoPredictionId: null`,
// which is the schema DEFAULT (models/Ad.js) — i.e. it would miss almost every
// legitimately requeueable ad and strand the queue.
checkTrue('R1 the guard treats an UNSET receipt as requeueable ($exists: false)',
  /\$exists: false/.test(GUARD));
// models/Ad.js declares veoPredictionId with `default: null`, so the field
// EXISTS on essentially every ad. A bare $exists:false would match almost
// nothing and strand the whole queue.
checkTrue('R2 the guard treats a NULL/empty receipt as requeueable (schema default is null)',
  /\$in: \[null, ''\]/.test(GUARD));
checkTrue('R3 the guard names BOTH receipt fields (video AND static)',
  /veoPredictionId/.test(GUARD) && /imageGeneration\.predictionId/.test(GUARD));
checkTrue('R4 HAS_RECEIPT is the exact inverse ($nin), for the held-back count',
  /\$nin: \[null, ''\]/.test(GUARD));
// receiptFree must COMPOSE, not spread — a spread would silently drop an
// existing $and on the caller's filter and lose part of their query.
{
  const merged = receiptFree({ status: 'rendering', $and: [{ foo: 1 }] });
  checkTrue('R5 receiptFree preserves a caller\'s existing $and',
    merged.$and.length === RECEIPT_FREE.$and.length + 1
    && JSON.stringify(merged.$and[0]) === JSON.stringify({ foo: 1 }),
    JSON.stringify(merged.$and));
  checkTrue('R6 receiptFree keeps the caller\'s other keys', merged.status === 'rendering');
}

// ── X: exhaustive — no other unguarded requeue site ──────────────────
// A third site added later would silently reintroduce the double-bill, and no
// unit test would catch it because the money moves in a different file.
const SCAN_DIRS = [path.join(ROOT, 'services'), path.join(ROOT, 'routes')];

// RECURSIVE, deliberately (widened 2026-08-04). The previous version read only
// each dir's top level, so 36 .js files under services/providers,
// services/capabilityExecutors, services/reviewAdapters, services/brandStyles
// and services/brandScripts were invisible to this check. capabilityExecutors
// is the newest surface that mutates ads, so "a third requeue site added later"
// — the exact thing X1 exists to catch — could have landed there unguarded.
// No nested file matches today; this closes the hole before it is used.
function walkJs(dir) {
  // node_modules/assets hold no source. Worktree, .drafts and dot-dir
  // exclusion comes from the shared helper — scripts/lib/sourceWalk.js.
  return walkSource(dir, { extensions: ['.js'], extraSkipDirs: ['assets'] });
}

const offenders = [];
// TWO anchor shapes — see adRequeueBlock's header for why. A bare
// `{ $set: { status: 'queued', ... } }` still exists at every PRE_DISPATCH
// site; `buildRequeuePipeline(` (adArchiveDigest.js) is the newer shape two
// real routes/ads.js sites use since 2026-08-19, and X1 must stay able to see
// BOTH or a future unguarded site in either shape ships invisible.
const REQUEUE_ANCHORS = ["$set: { status: 'queued'", 'buildRequeuePipeline('];
for (const dir of SCAN_DIRS) {
  for (const full of walkJs(dir)) {
    // Comment-stripped: a commented-out receiptFree( must not make an unguarded
    // rendering->queued write look guarded.
    const src = stripComments(fs.readFileSync(full, 'utf8'));
    for (const anchor of REQUEUE_ANCHORS) {
      let idx = src.indexOf(anchor);
      while (idx >= 0) {
        const from = src.lastIndexOf('updateMany(', idx);
        const block = from >= 0 ? src.slice(from, idx + 60) : '';
        // Only writes that move ads OUT of `rendering` are money-relevant.
        // ALLOWLIST: the claim-anomaly release takes a claim and hands it straight
        // back BEFORE any render or submit, so no receipt can exist yet and an
        // unconditional release is correct. Named, not silently skipped.
        const near = src.slice(Math.max(0, from - 900), idx);
        const isClaimAnomalyRelease = /CLAIM ANOMALY/.test(near);
        if (block && /status: 'rendering'/.test(block)
            && !guardsBothReceipts(block) && !isClaimAnomalyRelease) {
          offenders.push(`${path.relative(ROOT, full)} (offset ${idx})`);
        }
        idx = src.indexOf(anchor, idx + 1);
      }
    }
  }
}
checkTrue('X1 no unguarded rendering->queued requeue anywhere in services/ or routes/',
  offenders.length === 0, offenders.join(', '));

// ── I: every receiptFree( call site must actually import it ──────────
// guardsBothReceipts is a regex over source TEXT. It proves the call is
// written; it cannot see that the identifier is unbound. `node --check`
// cannot catch it either — a ReferenceError is runtime, not syntax. That is
// why a live money guard shipped broken with a green harness (processAlerts
// called receiptFree without importing it; SIGTERM requeue was a no-op).
// Derive the file list by scanning, so the next new call site is guarded too.
//
// EVERY TEST BELOW RUNS ON COMMENT-STRIPPED SOURCE, and that is load-bearing.
// An adversarial pass found the first version of these checks false-passing: with
// the real import COMMENTED OUT — i.e. `receiptFree` genuinely unbound at runtime,
// reproducing the exact production bug — the raw-text regex still matched the
// commented line and the harness reported all green. A check that a comment can
// satisfy is the same defect it was written to catch, one level up. Revert-proven
// against BOTH deleting the import and commenting it out.
{
  const callSites = [];
  const scanRoots = [
    path.join(ROOT, 'services'),
    path.join(ROOT, 'routes'),
    path.join(ROOT, 'worker.js')
  ];
  function scanFile(full) {
    if (!full.endsWith('.js')) return;
    // The definition file itself is not a call site.
    if (path.basename(full) === 'spendReceipt.js') return;
    // CODE only — a commented-out call is not a call site, and a commented-out
    // import must not satisfy the binding check below.
    const src = stripComments(fs.readFileSync(full, 'utf8'));
    if (!/\breceiptFree\s*\(/.test(src)) return;
    callSites.push({ rel: path.relative(ROOT, full), full, src });
  }
  // Recursive for the same reason X1 is — a call site in a subdirectory
  // (services/capabilityExecutors, services/providers, …) must not be able to
  // call receiptFree without importing it just because it is one level down.
  for (const root of scanRoots) {
    if (fs.statSync(root).isFile()) scanFile(root);
    else for (const full of walkJs(root)) scanFile(full);
  }
  checkTrue('I0 at least one receiptFree( call site exists to scan', callSites.length > 0,
    'scan found zero call sites');

  const unbound = [];
  for (const site of callSites) {
    // require('./spendReceipt') or require('../services/spendReceipt') etc.,
    // with a destructuring that includes receiptFree.
    const importsIt = /require\s*\(\s*['"][^'"]*spendReceipt['"]\s*\)/.test(site.src)
      && /\{[^}]*\breceiptFree\b[^}]*\}\s*=\s*require\s*\(\s*['"][^'"]*spendReceipt['"]\s*\)/.test(site.src);
    if (!importsIt) unbound.push(site.rel);
  }
  checkTrue('I1 every file that calls receiptFree( also imports it from spendReceipt',
    unbound.length === 0, unbound.join(', '));

  // Genuine RUNTIME assertion: the module loads, the source binds receiptFree,
  // and spendReceipt.receiptFree is a real function. Do not execute persistOrphans
  // (needs mongoose + inFlight state).
  let processAlertsLoaded = false;
  try {
    require('../services/processAlerts');
    processAlertsLoaded = true;
  } catch (err) {
    failures.push(`I2 processAlerts.js module loads — ${err && err.message}`);
  }
  if (processAlertsLoaded) pass++;

  // Comment-stripped for the reason documented at the top of this block: the raw
  // source false-passes when the import is merely commented out.
  const ALERTS_CODE = stripComments(ALERTS);
  checkTrue('I3 processAlerts CODE references receiptFree inside persistOrphans',
    /async function persistOrphans[\s\S]*?receiptFree\s*\(/.test(ALERTS_CODE));
  checkTrue('I4 processAlerts CODE destructures receiptFree from spendReceipt (not in a comment)',
    /\{[^}]*\breceiptFree\b[^}]*\}\s*=\s*require\s*\(\s*['"]\.\/spendReceipt['"]\s*\)/.test(ALERTS_CODE));
  checkTrue('I5 spendReceipt.receiptFree is a function (runtime bind)',
    typeof require('../services/spendReceipt').receiptFree === 'function');
}

const total = pass + failures.length;
if (failures.length) {
  console.error(`verifyReceiptAwareRequeue: ${pass}/${total} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error('  FAIL', f);
  process.exit(1);
}
console.log(`verifyReceiptAwareRequeue: ${pass}/${total} passed`);
process.exit(0);
