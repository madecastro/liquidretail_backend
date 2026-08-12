// verifyTitlingOrphanResume — a paid master stranded mid-titling must be
// reclaimable, and an ad that legitimately ships bare must never be touched.
//
// THE DELIVERED DEFECT (measured 2026-08-12, run_1786555875841_2ddf9739).
// The web process took SIGTERM at 17:53:15 during a deploy. Two ads —
// meta_feed_1_1 and meta_feed_4_5 — shipped as the RAW UNTITLED 9:16 master:
// wrong aspect, no titling, byte-identical to each other, and both sitting at
// status:'draft' with a populated renderUrl, which reads to the operator as
// DELIVERED. The documented contract is that titling failure flips the ad to
// 'failed' with "master rendered; titling failed". That did not happen.
//
// WHY NOTHING RECOVERED THEM. routes/ads.js stamps status:'draft' AND
// renderUrl = veoVideoUrl BEFORE titling starts — deliberately, as a money
// guard, since leaving a paid master in 'rendering' lets the reaper requeue it
// into a second ~$0.90 Omni submit. That guard works. But it produces a state
// that seven sweepers between them cannot see:
//
//   bootRecoveryService   status:'rendering'   persistOrphans   status:'rendering'
//   worker reapOrphans    status:'rendering'   backlogWatchdog  status:'rendering'
//   strandedRunSweeper    status:'queued'      imageRecovery    excludes 'draft'
//   titlingResumeService  status:'draft' — but its three arms need
//                         titlingResumeState set, or renderUrl null.
//
// The normal render path never wrote titlingResumeState, and it DOES write
// renderUrl. So the ad matched nothing and sat untitled forever.
//
// THE FIX, and the trap inside it. The render path now joins the state machine
// that already existed: stamp titlingResumeState:'claimed' with the master, and
// clear it on every terminal outcome. The trap is that
// `renderUrl === veoVideoUrl` is ALSO the correct permanent state of a
// no-chrome ad (routes/ads.js: "no titling (no-chrome) — shipping master"), so
// a sweeper keyed on that signature alone would re-render those ads on every
// pass forever. Clearing the state on the success path is what separates them,
// and C4 is the check that says so.
//
// These checks evaluate the REAL filter object against REAL document shapes —
// not a regex over the source. A source-text assertion cannot tell a working
// query from one that merely still contains the right words.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildResumeFilter, STATE_PENDING, STATE_CLAIMED
} = require('../services/titlingResumeService');

let checks = 0;
const ok = (label, fn) => {
  try { fn(); checks += 1; }
  catch (err) { console.error(`  ❌ ${label}\n     ${err.message}`); process.exitCode = 1; }
};

console.log('verifyTitlingOrphanResume\n');

// ── A tiny Mongo matcher, covering exactly the operators this filter uses.
// Deliberately NOT a general implementation: it throws on anything it does not
// understand, so a future operator added to the query cannot be silently
// mis-evaluated into a false pass.
function matchOp(value, cond) {
  if (cond !== null && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
    for (const [op, operand] of Object.entries(cond)) {
      if (op === '$ne') { if (value === operand) return false; }
      else if (op === '$lt') { if (!(value != null && value < operand)) return false; }
      else if (op === '$in') { if (!operand.includes(value)) return false; }
      else throw new Error(`matcher does not implement operator ${op} — extend it deliberately`);
    }
    return true;
  }
  // Mongo treats a missing field and an explicit null as equal for `field: null`.
  if (cond === null) return value === null || value === undefined;
  return value === cond;
}

function matches(doc, filter) {
  for (const [key, cond] of Object.entries(filter)) {
    if (key === '$or') {
      if (!cond.some(sub => matches(doc, sub))) return false;
    } else if (key === '$and') {
      if (!cond.every(sub => matches(doc, sub))) return false;
    } else if (key.startsWith('$')) {
      throw new Error(`matcher does not implement top-level ${key}`);
    } else if (!matchOp(doc[key], cond)) return false;
  }
  return true;
}

const NOW = new Date('2026-08-12T18:00:00Z');
const STALE_CUTOFF = new Date(NOW.getTime() - 15 * 60 * 1000);
const OLD = new Date(NOW.getTime() - 60 * 60 * 1000);   // an hour of silence — dead
const FRESH = new Date(NOW.getTime() - 30 * 1000);      // beating — alive
const FILTER = buildResumeFilter(STALE_CUTOFF);

const MASTER = 'https://res.cloudinary.com/x/video/upload/atlas_renders/omni-abc.mp4';
const TITLED = 'https://res.cloudinary.com/x/video/upload/brand_script/product-abc.mp4';

// ── Group A — the matcher itself is trustworthy (a test harness that lies is worse
// than none). If these fail, nothing below means anything.
ok('A1 matcher: exact equality', () => {
  assert.strictEqual(matches({ a: 1 }, { a: 1 }), true);
  assert.strictEqual(matches({ a: 2 }, { a: 1 }), false);
});
ok('A2 matcher: $ne, $lt', () => {
  assert.strictEqual(matches({ a: 'x' }, { a: { $ne: null } }), true);
  assert.strictEqual(matches({ a: null }, { a: { $ne: null } }), false);
  assert.strictEqual(matches({ t: OLD }, { t: { $lt: STALE_CUTOFF } }), true);
  assert.strictEqual(matches({ t: FRESH }, { t: { $lt: STALE_CUTOFF } }), false);
});
ok('A3 matcher: missing field equals explicit null (Mongo semantics)', () => {
  assert.strictEqual(matches({}, { a: null }), true);
  assert.strictEqual(matches({ a: undefined }, { a: null }), true);
});
ok('A4 matcher: $or', () => {
  assert.strictEqual(matches({ a: 1 }, { $or: [{ a: 9 }, { a: 1 }] }), true);
  assert.strictEqual(matches({ a: 1 }, { $or: [{ a: 9 }, { a: 8 }] }), false);
});
ok('A5 matcher refuses an operator it does not implement', () => {
  assert.throws(() => matches({ a: 1 }, { a: { $gte: 1 } }), /does not implement/);
});

// ── Group B — the ORPHAN the incident produced must now be reclaimed.
const orphanMaster = {
  status: 'draft', kind: 'video',
  veoVideoUrl: MASTER,
  renderUrl: MASTER,                  // the raw master, stamped pre-titling
  titlingResumeState: STATE_CLAIMED,
  updatedAt: OLD
};

ok('B1 [THE BUG] a master stranded mid-titling is selected', () => {
  assert.strictEqual(matches(orphanMaster, FILTER), true,
    'the delivered defect would still be invisible to the sweeper');
});

ok('B2 the same ad while titling is ALIVE is not touched', () => {
  // The heartbeat keeps updatedAt fresh. Selecting this would start a SECOND
  // Remotion render of an ad already being titled. Measured titling tail on a
  // 20-ad run was 926s, so this is the common case, not a corner.
  assert.strictEqual(matches({ ...orphanMaster, updatedAt: FRESH }, FILTER), false,
    'a live titling render would be double-started');
});

ok('B3 a derive-only plate stranded mid-titling is selected', () => {
  assert.strictEqual(matches({
    status: 'draft', kind: 'video',
    veoVideoUrl: MASTER, renderUrl: MASTER,
    veoModel: 'derive-from:pmax_video_9_16',
    titlingResumeState: STATE_CLAIMED, updatedAt: OLD
  }, FILTER), true);
});

// ── Group C — everything that must NOT be swept. Each of these is a way the
// fix could become a CPU-burning infinite loop or could resurrect a settled ad.
ok('C1 a fully titled ad is left alone', () => {
  assert.strictEqual(matches({
    status: 'draft', veoVideoUrl: MASTER, renderUrl: TITLED,
    titlingResumeState: null, updatedAt: OLD
  }, FILTER), false);
});

ok('C2 an ad that FAILED titling is not retried forever', () => {
  assert.strictEqual(matches({
    status: 'failed', veoVideoUrl: MASTER, renderUrl: MASTER,
    titlingResumeState: null, updatedAt: OLD
  }, FILTER), false, 'a terminal verdict must stay terminal');
});

ok('C3 a queued ad belongs to the render loop, not this sweeper', () => {
  assert.strictEqual(matches({
    status: 'queued', veoVideoUrl: null, renderUrl: null, updatedAt: OLD
  }, FILTER), false);
});

ok('C4 [THE TRAP] a no-chrome ad shipping its bare master is NEVER re-titled', () => {
  // This ad's renderUrl legitimately equals veoVideoUrl forever — the raw
  // master IS the deliverable. It is byte-for-byte indistinguishable from the
  // B1 orphan except for titlingResumeState. Any "fix" that sweeps on the
  // url-equality signature instead re-renders this ad on every pass for the
  // rest of its life. Clearing state on the success path is the whole defence.
  assert.strictEqual(matches({
    status: 'draft', kind: 'video',
    veoVideoUrl: MASTER, renderUrl: MASTER,
    titlingResumeState: null, updatedAt: OLD
  }, FILTER), false,
    'the no-chrome ad would be re-titled forever — an unbounded Remotion loop');
});

ok('C5 a STATIC ad is out of scope', () => {
  assert.strictEqual(matches({
    status: 'draft', kind: 'image', renderUrl: 'https://x/img.png',
    veoVideoUrl: null, titlingResumeState: null, updatedAt: OLD
  }, FILTER), false);
});

// ── Group D — the two pre-existing arms still work (this fix is additive).
ok('D1 recovery-marked pending is still selected', () => {
  assert.strictEqual(matches({
    status: 'draft', veoVideoUrl: MASTER, renderUrl: MASTER,
    titlingResumeState: STATE_PENDING, updatedAt: FRESH
  }, FILTER), true, 'pending has no staleness bound by design — recovery owes a title now');
});

ok('D2 the legacy migration arm (veoVideoUrl, no renderUrl) still selected', () => {
  assert.strictEqual(matches({
    status: 'draft', veoVideoUrl: MASTER, renderUrl: null,
    titlingResumeState: null, updatedAt: FRESH
  }, FILTER), true);
});

ok('D3 the filter is scoped to draft — it can never claim a rendering ad', () => {
  // Overlapping with bootRecoveryService/reaper would race two recovery systems
  // for one paid master.
  for (const status of ['rendering', 'queued', 'failed', 'live', 'archived']) {
    assert.strictEqual(matches({
      status, veoVideoUrl: MASTER, renderUrl: null, updatedAt: OLD
    }, FILTER), false, `status '${status}' must not be swept here`);
  }
});

// ── Group E — the render path writes the state. Source-level, because these are
// literal object keys in a 4000-line route handler with no callable seam.
// Comments are STRIPPED before matching: a check that passes because it found
// its own explanatory prose teaches the next reader to ignore it.
const adsSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ads.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');

ok('E1 both pre-titling stamps declare the titling debt', () => {
  // Located PER SITE rather than counted file-wide. A whole-file count of
  // "claimed" also catches the heartbeat's filter (E4), so it would pass while
  // a stamp was missing — the count would just be satisfied by the wrong line.
  const stampIdxs = [];
  const re = /renderUrl:\s*veoVideoUrl/g;
  for (let m = re.exec(adsSrc); m; m = re.exec(adsSrc)) stampIdxs.push(m.index);
  assert.strictEqual(stampIdxs.length, 2,
    `expected 2 pre-titling stamps (master + derive-only), found ${stampIdxs.length}`);

  for (const idx of stampIdxs) {
    // Scope to the remainder of this $set object literal — up to its $inc
    // sibling or the update's close, whichever comes first.
    const rest = adsSrc.slice(idx);
    const end = Math.min(
      ...['$inc:', '\n      );', '\n  );'].map(t => {
        const i = rest.indexOf(t);
        return i === -1 ? Infinity : i;
      })
    );
    const block = rest.slice(0, Number.isFinite(end) ? end : 1200);
    assert.ok(/titlingResumeState:\s*'claimed'/.test(block),
      `the pre-titling stamp at offset ${idx} does not declare the titling debt`);
  }
});

ok('E2 [ANTI-DOUBLE-RENDER] the stamp is claimed, never pending', () => {
  // 'pending' is arm 1, which has NO staleness bound — a sweeper tick would
  // claim an ad this process is actively titling and render it twice.
  assert.ok(!/titlingResumeState:\s*'pending'/.test(adsSrc),
    "routes/ads.js must not stamp 'pending' — arm 1 has no staleness bound");
});

ok('E3 every terminal outcome clears the debt', () => {
  const cleared = adsSrc.match(/titlingResumeState:\s*null/g) || [];
  assert.strictEqual(cleared.length, 4,
    `expected 4 terminal clears (2 paths x {titled, failed}), found ${cleared.length}`);
});

ok('E4 the heartbeat covers a claimed draft, not just rendering', () => {
  // Without this the sweeper cannot distinguish "waiting behind
  // VEO_TITLING_CONCURRENCY" from "process died", and B2 becomes reachable.
  const hb = adsSrc.slice(adsSrc.indexOf('const heartbeat = setInterval'));
  const body = hb.slice(0, hb.indexOf('}, 60_000)'));
  assert.ok(/status:\s*'rendering'/.test(body), 'heartbeat lost its rendering arm');
  assert.ok(/status:\s*'draft'/.test(body) && /titlingResumeState:\s*'claimed'/.test(body),
    'heartbeat must also refresh a draft ad that still owes a title');
});

ok('E5 the money guard is intact — draft is still stamped before titling', () => {
  const stampIdx = adsSrc.indexOf("status:             'draft'");
  const titleIdx  = adsSrc.indexOf('renderBrandScriptAndSave({ ad: adFinal');
  assert.ok(stampIdx > 0 && titleIdx > 0 && stampIdx < titleIdx,
    'draft must still be stamped BEFORE titling — reverting that reopens the double-bill hole');
});

ok('E6 the sweeper query is built by the exported pure function', () => {
  const svc = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'titlingResumeService.js'), 'utf8');
  assert.ok(/Ad\.find\(buildResumeFilter\(/.test(svc),
    'the live query must use buildResumeFilter, or these checks test a copy');
});

if (process.exitCode) {
  console.log(`\n❌ verifyTitlingOrphanResume: failures above (${checks} passed)`);
} else {
  console.log(`\n✅ verifyTitlingOrphanResume: ${checks}/${checks} checks passed`);
}
