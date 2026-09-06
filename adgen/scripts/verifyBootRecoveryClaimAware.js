'use strict';
//
// verifyBootRecoveryClaimAware — EXECUTION-based proof that adgen's own
// bootRecoveryService sweep cannot stomp work another adgen role is legitimately
// holding, AND that it still recovers genuinely dead work.
//
// WHY THIS EXISTS (2026-08-26). liquidretail_backend PR #346 made backend's copy
// of this file ownership-gated and claim-aware, and said in its own body what it
// did NOT close: "adgen's own vendored copy of this file is untouched,
// unaudited, and still claim-blind — this PR closes the race for backend as a
// writer, not universally." This harness pins the adgen half.
//
// The adgen-specific hole is NOT the one that phrasing implies. In production
// (ADGEN_TITLER_ENABLED=true, verified live on Render srv-da4bh9rbc2fs73cff2rg)
// the dangerous row has NO CLAIM AT ALL, so a claim check alone would not have
// caught it: renderer.js's titler handoff clears `claimedByWorker`, stamps
// `titlingNeeded: true` + the Cloudinary-mirrored `veoVideoUrl`, and never
// touches `status` — leaving the row `status:'rendering'` with its spend receipt
// and nothing beating `updatedAt` until adgen-titler claims it. At end-of-run,
// with the titler draining a backlog (REMOTION_QUEUE_CONCURRENCY=2 x ~76s vs
// ADGEN_MAX_INFLIGHT=32 handoffs), that wait routinely exceeds
// RESUME_STALE_MIN. Sweeping such a row stamped `titlingResumeState:'pending'`
// while `titlingNeeded` stayed true — and titler.claimOne arbitrates on
// `claimedByWorker` while titlingResumeService arbitrates on
// `titlingResumeState`, so neither can see the other's claim and BOTH could
// win: two Remotion renders on one ~$0.90 paid master.
//
// EXECUTION, NOT SOURCE TEXT. Every assertion below runs the REAL exported
// `buildRecoverySweepFilter` / `resumeInFlightAds`. A source-text harness
// passes against a reimplementation that merely keeps the right words, which is
// exactly the failure mode this file's subject matter cannot afford. Mongo is
// modelled by scripts/lib/miniMongoStub.js (dependency-free — this repo's
// CLAUDE.md forbids npm ci / NODE_PATH in a worktree), and the mongoose-backed
// requires are pre-seeded into require.cache, so nothing here touches a real DB
// or the network.

const path = require('path');
const fs = require('fs');
const Module = require('module');
const { matches, MiniCollection } = require('../scripts/lib/miniMongoStub');

const REPO = path.resolve(__dirname, '..');
const SVC = path.join(REPO, 'src', 'services');

const failures = [];
const passes = [];
function check(name, cond, detail) {
  if (cond === true) passes.push(name);
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

// ── require.cache pre-seed ───────────────────────────────────────────────────
// Only the mongoose-backed / network-backed leaves are stubbed. `spendReceipt`
// is deliberately NOT stubbed: it is dependency-free, so HAS_RECEIPT is the
// REAL frozen object, which is the whole point of check G1.
function seed(relPath, exports) {
  const full = require.resolve(path.join(SVC, relPath));
  require.cache[full] = new Module(full, null);
  require.cache[full].filename = full;
  require.cache[full].loaded = true;
  require.cache[full].exports = exports;
  return full;
}
function seedModel(name, exports) {
  const full = require.resolve(path.join(REPO, 'src', 'models', name));
  require.cache[full] = new Module(full, null);
  require.cache[full].filename = full;
  require.cache[full].loaded = true;
  require.cache[full].exports = exports;
  return full;
}

// Mutable hooks the tests re-point per scenario.
const hooks = {
  collection: null,          // MiniCollection standing in for the Ad model
  resumeForAd: async () => ({ state: 'processing' }),
  recoverImageAd: async () => ({ state: 'processing' }),
  reconcileCalls: [],
  alertCalls: []
};

// `Ad` proxies to whatever MiniCollection the current scenario installed.
const AdStub = {
  find(filter)            { return hooks.collection.find(filter); },
  updateOne(filter, upd)  { return hooks.collection.updateOne(filter, upd); },
  findById(id)            { return hooks.collection.findById(id); },
  countDocuments(filter)  {
    return Promise.resolve(hooks.collection.docs.filter((d) => matches(d, filter)).length);
  }
};

seedModel('Ad', AdStub);
seed('atlasVideoService', {
  resumeForAd: (...a) => hooks.resumeForAd(...a),
  reconcileVideoCostFromTerminal: (...a) => { hooks.reconcileCalls.push(['video', ...a]); },
  resolveFailureCostReconcile: () => null
});
seed('imageRecoveryService', { recoverImageAd: (...a) => hooks.recoverImageAd(...a) });
seed('costTracker', { reconcileCost: async (...a) => { hooks.reconcileCalls.push(['cost', ...a]); } });
seed('alertService', { notifyAsync: (...a) => { hooks.alertCalls.push(a); } });
seed('runFeedService', { attachAd() {}, noteEvent() {}, onStage() {} });

// titlingResumeService is stubbed (it pulls three mongoose models), but the
// values are pinned against its real source below (check H1) so this stub can
// never silently drift from the states production actually writes/reads.
const STUB_STATE_PENDING = 'pending';
const STUB_TITLING_PENDING = 'master recovered; titling pending';
seed('titlingResumeService', {
  STATE_PENDING: STUB_STATE_PENDING,
  TITLING_PENDING: STUB_TITLING_PENDING,
  fallbackPosterUrl: () => null
});

process.env.RESUME_IN_FLIGHT_ON_BOOT = 'true';
delete process.env.RESUME_STALE_MIN;
delete process.env.RESUME_CLAIM_STALE_MIN;

const boot = require(path.join(SVC, 'bootRecoveryService'));
const { buildRecoverySweepFilter, resumeInFlightAds } = boot;

// ── fixtures ────────────────────────────────────────────────────────────────
// REAL clock, captured once. `resumeInFlightAds` builds its filter from
// `new Date()` internally (it takes no clock injection), so a hardcoded fixture
// epoch would make every end-to-end row look hours stale and quietly invert the
// alive-but-quiet cases. Anchoring fixtures to the same real instant keeps the
// pure-filter checks (which pass `now: NOW`) and the end-to-end sweeps in
// agreement to within the harness's own runtime.
const NOW = new Date();
const minsAgo = (m) => new Date(NOW.getTime() - m * 60 * 1000);
const MIRRORED = 'https://res.cloudinary.com/x/video/upload/v1/master.mp4';
const RAW_ATLAS = 'https://cdn.atlascloud.ai/ephemeral/pred_abc.mp4';

// Every doc sets claimedByWorker explicitly: models/Ad.js declares it with
// `default: null`, so production rows always carry the key. (Real Mongo would
// also match a MISSING field against `{claimedByWorker: null}`; the stub is
// stricter, so being explicit keeps stub and Mongo semantics aligned.)
function adDoc(over = {}) {
  return {
    _id: over._id || 'ad0',
    status: 'rendering',
    veoPredictionId: 'pred_abc',
    imageGeneration: {},
    veoVideoUrl: null,
    renderUrl: null,
    titlingNeeded: false,
    titlingResumeState: null,
    claimedByWorker: null,
    claimedAt: null,
    updatedAt: minsAgo(30),
    campaignRunIds: ['run_1'],
    ...over
  };
}

// The production-live hazard: master collected + mirrored, claim released,
// waiting for adgen-titler. status stays 'rendering', receipt intact.
const HANDOFF_PENDING = adDoc({
  _id: 'handoff',
  titlingNeeded: true,
  veoVideoUrl: MIRRORED,
  renderUrl: MIRRORED,
  claimedByWorker: null,
  updatedAt: minsAgo(30)          // long past both windows
});

// Genuinely dead mid-generate: the master was NEVER collected (veoVideoUrl
// null) — this is what the module exists to recover.
const DEAD_UNCLAIMED = adDoc({ _id: 'dead_unclaimed', updatedAt: minsAgo(30) });
const DEAD_CLAIMED = adDoc({
  _id: 'dead_claimed',
  claimedByWorker: 'renderer-7364c5b1',
  claimedAt: minsAgo(30),
  updatedAt: minsAgo(30)
});

// Alive-but-quiet: a claim taken 1 minute ago on a row whose updatedAt was
// already stale (claimOne stamps claimedAt but NOT updatedAt).
const FRESH_CLAIM = adDoc({
  _id: 'fresh_claim',
  claimedByWorker: 'titler-aaaa',
  claimedAt: minsAgo(1),
  updatedAt: minsAgo(30)
});

const NO_RECEIPT = adDoc({ _id: 'no_receipt', veoPredictionId: null, imageGeneration: {} });
const NOT_STALE = adDoc({ _id: 'not_stale', updatedAt: minsAgo(1) });
const IMAGE_DEAD = adDoc({
  _id: 'image_dead',
  veoPredictionId: null,
  imageGeneration: { predictionId: 'img_pred_1' },
  updatedAt: minsAgo(30)
});
// Claimed, but claimedAt was never stamped — must NOT strand forever.
const CLAIMED_NO_CLOCK = adDoc({
  _id: 'claimed_no_clock',
  claimedByWorker: 'renderer-legacy',
  claimedAt: null,
  updatedAt: minsAgo(30)
});

const FILTER = buildRecoverySweepFilter({ now: NOW });
const sel = (doc) => matches(doc, FILTER);

// ── A. the production-live defect: the titler handoff is excluded ────────────
check('A1: a titler-handoff-pending row (master collected + mirrored, awaiting titler) is NOT selected',
  sel(HANDOFF_PENDING) === false);
check('A2: the SAME row IS selected once titlingNeeded is cleared (proves A1 is the handoff term, not staleness)',
  sel({ ...HANDOFF_PENDING, titlingNeeded: false }) === true);
check('A3: titlingNeeded:true WITHOUT a collected master IS still selected (a crash before the master landed must recover)',
  sel({ ...HANDOFF_PENDING, veoVideoUrl: null, renderUrl: null }) === true);
check('A4: an EMPTY-STRING veoVideoUrl counts as not-collected (a truthiness-only guard would strand it)',
  sel({ ...HANDOFF_PENDING, veoVideoUrl: '' }) === true);
check('A5: handoff exclusion holds even once the titler HAS claimed it',
  sel({ ...HANDOFF_PENDING, claimedByWorker: 'titler-aaaa', claimedAt: minsAgo(30) }) === false);

// ── B. claim-awareness: alive-but-quiet claims survive ──────────────────────
check('B1: a claim taken 1min ago on an already-stale row is NOT selected (claimedAt is the arbiter)',
  sel(FRESH_CLAIM) === false);
check('B2: same row IS selected once the claim itself ages past the claim window',
  sel({ ...FRESH_CLAIM, claimedAt: minsAgo(30) }) === true);
check('B3: a claimed row stale past 5min but NOT past 15min is NOT selected',
  sel({ ...DEAD_CLAIMED, claimedAt: minsAgo(9), updatedAt: minsAgo(9) }) === false);
check('B4: a claimed row whose updatedAt is FRESH is not selected even with an old claim',
  sel({ ...DEAD_CLAIMED, claimedAt: minsAgo(30), updatedAt: minsAgo(1) }) === false);

// ── C. the sweep must NOT become a no-op ────────────────────────────────────
check('C1: a genuinely dead UNCLAIMED row (never-collected master, stale 30min) IS selected',
  sel(DEAD_UNCLAIMED) === true);
check('C2: a genuinely dead CLAIMED row (both clocks stale past 15min) IS selected',
  sel(DEAD_CLAIMED) === true);
check('C3: a stranded image receipt IS still selected (image recovery is untouched)',
  sel(IMAGE_DEAD) === true);
check('C4: a claimed row with NO claimedAt is selected on updatedAt alone (must not strand forever)',
  sel(CLAIMED_NO_CLOCK) === true);

// ── D. pre-existing guards still hold ───────────────────────────────────────
check('D1: a receipt-FREE row is never selected (HAS_RECEIPT survived the $and compose)',
  sel(NO_RECEIPT) === false);
check('D2: a not-yet-stale unclaimed row is not selected',
  sel(NOT_STALE) === false);
check('D3: a non-rendering status is never selected',
  sel({ ...DEAD_UNCLAIMED, status: 'draft' }) === false);

// ── E. window ordering cannot be inverted by env ────────────────────────────
{
  const child = require('child_process').spawnSync(process.execPath, ['-e', `
    process.env.RESUME_STALE_MIN='10';
    process.env.RESUME_CLAIM_STALE_MIN='1';
    const p=${JSON.stringify(path.join(SVC, 'bootRecoveryService'))};
    const orig=require('module')._load;
    require('module')._load=function(req,parent,iso){
      if(/models\\/Ad$|atlasVideoService$|imageRecoveryService$|costTracker$|alertService$|titlingResumeService$|runFeedService$/.test(req)) return {};
      return orig.apply(this,arguments);
    };
    const m=require(p);
    console.log(JSON.stringify({ claim:m.RESUME_CLAIM_STALE_MIN, stale:m.RESUME_STALE_MIN }));
  `], { encoding: 'utf8' });
  let parsed = null;
  try { parsed = JSON.parse((child.stdout || '').trim().split('\n').pop()); } catch { /* reported below */ }
  check('E1: RESUME_CLAIM_STALE_MIN below RESUME_STALE_MIN is clamped UP, never inverted',
    !!parsed && parsed.claim >= parsed.stale && parsed.stale === 10,
    parsed ? `claim=${parsed.claim} stale=${parsed.stale}` : `child failed: ${(child.stderr || '').slice(0, 300)}`);
}

// ── F. END-TO-END: run the real sweep and assert the WRITES ─────────────────
async function runSweep(docs, { resumeForAd, recoverImageAd } = {}) {
  hooks.collection = new MiniCollection(docs);
  hooks.reconcileCalls = [];
  hooks.alertCalls = [];
  hooks.resumeForAd = resumeForAd || (async () => ({ state: 'processing' }));
  hooks.recoverImageAd = recoverImageAd || (async () => ({ state: 'processing' }));
  const out = await resumeInFlightAds({});
  return { out, coll: hooks.collection };
}

(async () => {
  // F1-F4: the handoff row is never even considered, and never written.
  {
    let peeked = 0;
    const { out, coll } = await runSweep([HANDOFF_PENDING], {
      resumeForAd: async () => { peeked++; return { state: 'done', videoUrl: RAW_ATLAS, predictionId: 'pred_abc' }; }
    });
    check('F1: sweep considered 0 handoff-pending rows', out.considered === 0, `considered=${out.considered}`);
    check('F2: resumeForAd was never called on the handoff row', peeked === 0, `peeks=${peeked}`);
    check('F3: NO write landed on the handoff row', coll.calls.length === 0,
      `writes=${JSON.stringify(coll.calls).slice(0, 300)}`);
    const row = coll.docs.find((d) => d._id === 'handoff');
    check('F4: the mirrored Cloudinary URL was NOT clobbered with the raw Atlas URL',
      row.veoVideoUrl === MIRRORED && row.renderUrl === MIRRORED, `veoVideoUrl=${row.veoVideoUrl}`);
    check('F5: titlingResumeState was NOT stamped pending (no dual-claim state created)',
      row.titlingResumeState === null && row.titlingNeeded === true,
      `state=${row.titlingResumeState} needed=${row.titlingNeeded}`);
  }

  // F6-F9: genuinely dead work IS still recovered — the other direction.
  {
    let peeked = 0;
    const { out, coll } = await runSweep([DEAD_UNCLAIMED], {
      resumeForAd: async () => { peeked++; return { state: 'done', videoUrl: RAW_ATLAS, predictionId: 'pred_abc', price: 0.9 }; }
    });
    check('F6: a dead unclaimed row WAS considered', out.considered === 1, `considered=${out.considered}`);
    check('F7: resumeForAd WAS called (the recovery branch was actually reached)', peeked === 1, `peeks=${peeked}`);
    check('F8: recovered count is 1', out.recovered === 1, JSON.stringify(out));
    const row = coll.docs.find((d) => d._id === 'dead_unclaimed');
    check('F9: the paid master was collected — status draft + titling queued',
      row.status === 'draft' && row.veoVideoUrl === RAW_ATLAS
        && row.titlingResumeState === STUB_STATE_PENDING,
      `status=${row.status} state=${row.titlingResumeState}`);
  }

  // F10-F11: a dead CLAIMED row is still recovered (claim-awareness is not a
  // blanket exemption — this is the 273-minute-tail case that motivated wiring
  // the sweep at all, and it had claimedByWorker SET).
  {
    let peeked = 0;
    const { out } = await runSweep([DEAD_CLAIMED], {
      resumeForAd: async () => { peeked++; return { state: 'done', videoUrl: RAW_ATLAS, predictionId: 'pred_abc' }; }
    });
    check('F10: a dead CLAIMED row is still recovered', out.recovered === 1, JSON.stringify(out));
    check('F11: its recovery branch was actually reached', peeked === 1, `peeks=${peeked}`);
  }

  // F12: a live claim is not stomped end-to-end.
  {
    let peeked = 0;
    const { out, coll } = await runSweep([FRESH_CLAIM], {
      resumeForAd: async () => { peeked++; return { state: 'done', videoUrl: RAW_ATLAS }; }
    });
    check('F12: a freshly-claimed row is neither peeked nor written',
      out.considered === 0 && peeked === 0 && coll.calls.length === 0,
      `considered=${out.considered} peeks=${peeked} writes=${coll.calls.length}`);
  }

  // F13-F14: LIMIT STARVATION — excluded rows must not consume limit slots.
  // 3 handoff rows + 1 genuinely dead row, limit 3. A loop-level `continue`
  // would let the three handoff rows eat the whole limit and starve the real
  // recovery; a query-level exclusion cannot.
  {
    const many = [
      adDoc({ _id: 'h1', titlingNeeded: true, veoVideoUrl: MIRRORED }),
      adDoc({ _id: 'h2', titlingNeeded: true, veoVideoUrl: MIRRORED }),
      adDoc({ _id: 'h3', titlingNeeded: true, veoVideoUrl: MIRRORED }),
      DEAD_UNCLAIMED
    ];
    hooks.collection = new MiniCollection(many);
    hooks.reconcileCalls = [];
    let peekedIds = [];
    hooks.resumeForAd = async ({ ad }) => {
      peekedIds.push(String(ad._id));
      return { state: 'done', videoUrl: RAW_ATLAS, predictionId: 'p' };
    };
    hooks.recoverImageAd = async () => ({ state: 'processing' });
    const out = await resumeInFlightAds({ limit: 3 });
    check('F13: with limit=3 and 3 excluded rows ahead of it, the real dead row is still recovered',
      out.recovered === 1 && peekedIds.includes('dead_unclaimed'),
      `recovered=${out.recovered} peeked=${JSON.stringify(peekedIds)}`);
    check('F14: none of the excluded handoff rows consumed a limit slot',
      out.considered === 1 && !peekedIds.some((id) => id.startsWith('h')),
      `considered=${out.considered} peeked=${JSON.stringify(peekedIds)}`);
  }

  // ── G. the receipt guard is real, not incidental ──────────────────────────
  {
    const { out } = await runSweep([NO_RECEIPT], {
      resumeForAd: async () => ({ state: 'done', videoUrl: RAW_ATLAS })
    });
    check('G1: a receipt-free row is never swept end-to-end', out.considered === 0, JSON.stringify(out));
    const j = JSON.stringify(FILTER);
    check('G2: the filter nests HAS_RECEIPT under $and (a spread would have dropped it)',
      Array.isArray(FILTER.$and) && FILTER.$and.some((c) => JSON.stringify(c).includes('veoPredictionId')),
      j.slice(0, 200));
  }

  // ── H. the live call site + stub fidelity ─────────────────────────────────
  {
    const src = fs.readFileSync(path.join(SVC, 'bootRecoveryService.js'), 'utf8');
    check('H1: production really calls buildRecoverySweepFilter (not a hand-copied literal)',
      /Ad\.find\(\s*buildRecoverySweepFilter\(/.test(src));
    check('H2: no leftover inline `status: \'rendering\', updatedAt:` sweep literal',
      !/Ad\.find\(\s*\{\s*status:\s*'rendering'\s*,\s*updatedAt:/.test(src));
    const trs = fs.readFileSync(path.join(SVC, 'titlingResumeService.js'), 'utf8');
    const pend = trs.match(/const STATE_PENDING\s*=\s*'([^']+)'/);
    const tpend = trs.match(/const TITLING_PENDING\s*=\s*'([^']+)'/);
    check('H3: this harness\'s titlingResumeService stub matches the REAL constants',
      !!pend && !!tpend && pend[1] === STUB_STATE_PENDING && tpend[1] === STUB_TITLING_PENDING,
      `real=${pend && pend[1]}/${tpend && tpend[1]}`);
    check('H4: buildRecoverySweepFilter + RESUME_CLAIM_STALE_MIN are exported',
      typeof boot.buildRecoverySweepFilter === 'function'
        && typeof boot.RESUME_CLAIM_STALE_MIN === 'number');
    check('H5: default claim window is 15min and strictly longer than the 5min unclaimed window',
      boot.RESUME_CLAIM_STALE_MIN === 15 && boot.RESUME_STALE_MIN === 5,
      `claim=${boot.RESUME_CLAIM_STALE_MIN} stale=${boot.RESUME_STALE_MIN}`);
    // The filter must not reach for an operator miniMongoStub cannot evaluate —
    // that would make future coverage silently impossible. `$nin` is fine (the
    // stub models it, and it comes from the real HAS_RECEIPT); `$nor` is not,
    // which is why the handoff exclusion is written in De Morgan form.
    check('H6: the sweep\'s own arms avoid $nor (keeps the filter evaluable)',
      !/\$nor/.test(JSON.stringify(FILTER)));
    // Prove the stub is not silently ignoring an operator: every operator the
    // real filter uses must be one `matches` actually implements.
    {
      const ops = [...new Set((JSON.stringify(FILTER).match(/\$[a-z]+/g) || []))];
      const stubSrc = fs.readFileSync(path.join(REPO, 'scripts', 'lib', 'miniMongoStub.js'), 'utf8');
      const unmodelled = ops.filter((op) => !stubSrc.includes(`case '${op}'`) && !['$and', '$or'].includes(op));
      check('H7: every operator in the real filter is modelled by miniMongoStub',
        unmodelled.length === 0, `unmodelled=${JSON.stringify(unmodelled)} all=${JSON.stringify(ops)}`);
    }
  }

  // ── I. THE DUAL-CLAIM INVARIANT ──────────────────────────────────────────
  // The two titling claimants arbitrate on DISJOINT fields, so no single field
  // can express "who owns this row". The real invariant is therefore: after any
  // write this module makes, a row must never satisfy BOTH claim filters. Model
  // both real filters and assert that directly — this is what actually rules out
  // two Remotion renders on one paid master, and it is stronger than asserting
  // any individual field value.
  {
    // Mirrors titler.js claimOne (:155-164).
    const TITLER_CLAIM = {
      status: { $in: ['rendering', 'draft'] },
      veoVideoUrl: { $ne: null },
      titlingNeeded: true,
      claimedByWorker: null
    };
    // Mirrors titlingResumeService.buildResumeFilter arm 1 (:131-134).
    const RESUME_CLAIM = { status: 'draft', titlingResumeState: STUB_STATE_PENDING };

    // Pin the models against the real sources so they cannot silently drift.
    const titlerSrc = fs.readFileSync(path.join(SVC, 'titler.js'), 'utf8');
    const trsSrc = fs.readFileSync(path.join(SVC, 'titlingResumeService.js'), 'utf8');
    check('I1: titler.claimOne still keys on titlingNeeded + claimedByWorker (model is current)',
      /titlingNeeded:\s*true/.test(titlerSrc) && /claimedByWorker:\s*null/.test(titlerSrc));
    check('I2: titlingResumeService still keys arm 1 on titlingResumeState PENDING (model is current)',
      /titlingResumeState:\s*STATE_PENDING/.test(trsSrc));

    // A row the filter STILL selects on purpose, that also carries the titler
    // handoff flag: titlingNeeded true but the master was never collected.
    // Recovering it is correct; creating a dual-claim state while doing so is not.
    const RECOVERABLE_WITH_FLAG = adDoc({
      _id: 'flagged_no_master',
      titlingNeeded: true,
      veoVideoUrl: null,
      renderUrl: null,
      updatedAt: minsAgo(30)
    });
    check('I3: such a row IS still selected (recovery must not regress)',
      sel(RECOVERABLE_WITH_FLAG) === true);

    let peeked = 0;
    const { out, coll } = await runSweep([RECOVERABLE_WITH_FLAG], {
      resumeForAd: async () => { peeked++; return { state: 'done', videoUrl: RAW_ATLAS, predictionId: 'pred_abc' }; }
    });
    check('I4: it WAS recovered and the write branch was reached',
      out.recovered === 1 && peeked === 1, `recovered=${out.recovered} peeks=${peeked}`);

    const after = coll.docs.find((d) => d._id === 'flagged_no_master');
    const titlerWants = matches(after, TITLER_CLAIM);
    const resumeWants = matches(after, RESUME_CLAIM);
    check('I5: after the recovery write, EXACTLY ONE titling owner matches (no dual-claim state)',
      (titlerWants ? 1 : 0) + (resumeWants ? 1 : 0) === 1,
      `titlerClaim=${titlerWants} resumeClaim=${resumeWants} doc=${JSON.stringify({
        status: after.status, titlingNeeded: after.titlingNeeded,
        titlingResumeState: after.titlingResumeState, claimedByWorker: after.claimedByWorker
      })}`);
    check('I6: the surviving owner is titlingResumeService (the state this module stamps)',
      resumeWants === true && titlerWants === false,
      `titlerClaim=${titlerWants} resumeClaim=${resumeWants}`);
    check('I7: the recovered ad is still VIEWABLE (paid asset on renderUrl/posterUrl)',
      !!after.renderUrl && !!after.posterUrl && after.status === 'draft',
      `renderUrl=${after.renderUrl} status=${after.status}`);
  }

  // ── report ───────────────────────────────────────────────────────────────
  console.log(`\nverifyBootRecoveryClaimAware — ${passes.length} passed, ${failures.length} failed`);
  for (const p of passes) console.log(`  ✅ ${p}`);
  if (failures.length) {
    console.log('');
    for (const f of failures) console.log(`  ❌ ${f}`);
    process.exit(1);
  }
  process.exit(0);
})().catch((err) => {
  console.error(`verifyBootRecoveryClaimAware: threw — ${err && err.stack}`);
  process.exit(1);
});
