#!/usr/bin/env node
'use strict';
//
// verifyRegenerateStatusPromotionAndCascade — pins TWO coordinated fixes to
// services/adRegenerateService.js (2026-09-02):
//
//  FIX 1 — promoteFailedToDraft: a genuinely successful regenerate promotes
//    a previously-'failed' ad to 'draft'. It must NEVER touch a prior
//    'draft' / 'live' / 'archived' status (the exact hazard that motivated
//    NOT simply restoring brandScriptExecutor.uploadRenderAndStamp's old
//    unconditional preserveAdStatus:false default — see that function's
//    header, and adgen's copy of this file, where the same-shaped call
//    site still exists and needed a conditional retitleMode instead of
//    just being removed).
//
//  FIX 2 — cascadeRegenerateToDerivatives / findDerivativesOfMaster /
//    recascadeDerivativeSibling: after a master ad's video regenerate
//    succeeds, its free derivative siblings (deriveFromMaster === the
//    master's own platformFormat) are re-composited from the NEW master
//    plate, with ZERO Atlas/Omni submits — the same money invariant
//    resolveDeriveFromMaster / routes/ads.js's renderDeriveOnlyVideoAd
//    protect at mint time, applied to the regenerate path.
//
// NOTE ON REACHABILITY: this file's runVideoFull (and therefore this whole
// three-function chain) is currently unreachable in production — see
// runVideoFull's own header: regenerateAd returns before performRegeneration
// whenever shouldDeferToAdgen() is true, and ADGEN_RENDERER_ENABLED is true
// in production (adgen's copy is the one that actually runs). This harness
// still pins the local-execution copy for parity and for correctness if
// ADGEN_RENDERER_ENABLED is ever rolled back — same posture this repo
// already takes with scripts/verifyRendererVideoMoneyInvariants.js's own
// backend-side structural checks.
//
// WHY EXECUTION, NOT JUST SOURCE TEXT. A regex can see the words
// `status: 'failed'` exist near an updateOne somewhere. It cannot tell a
// scoped promotion (filtered on status:'failed' in the query itself, so a
// 'live' ad's status can never be touched) from an unconditional stamp (the
// exact shape of the pre-2026-08-28 hazard this fix does NOT reintroduce).
// Groups A-D below call the REAL exported functions against a small
// in-memory Mongo-like collection (real query/update semantics — $ne, $set,
// $unset — not a hand-waved reimplementation) and assert on the ACTUAL
// persisted documents afterward.
//
// Group E is the money invariant proper, and IS source text — mirroring
// scripts/verifyRendererVideoMoneyInvariants.js's own style: it extracts
// findDerivativesOfMaster / recascadeDerivativeSibling /
// cascadeRegenerateToDerivatives's function bodies from the REAL source
// file (balanced-brace extraction, not a copy) and asserts none of them
// reference veoService / atlasVideoService / generateForAd /
// prepareStoryboard — a submit inside any of these three functions would be
// a free-surface ad silently billing Omni on every master regenerate.
//
// Revert-prove — mutations confirmed to fail this harness (see each group):
//   promoteFailedToDraft loses its status:'failed' filter clause → A2-A5
//   promoteFailedToDraft becomes an unconditional $set (any status->draft)  → A2-A5
//   findDerivativesOfMaster drops the deriveFromMaster / campaignId /
//     productId / kind clause, or any in-flight exclusion               → B2-B8
//   findDerivativesOfMaster fails to exclude the master's own document   → B9
//   recascadeDerivativeSibling re-promotes on top of a fresh QC failure  → C4
//   recascadeDerivativeSibling stamps veoModel without the derive-from
//     marker, or fails to clear stale basePlate                         → C1-C2
//   cascadeRegenerateToDerivatives fails to skip a derivative master     → D4
//   a submit helper becomes reachable from any of the three functions    → E1-E3
//
// Pure + offline: no network, no API keys. Uses the real installed
// mongoose (this worktree has node_modules — see this repo's own CLAUDE.md
// on backend worktrees needing npm run setup:worktree, unlike adgen's
// bare-worktree rule). Run:
//   node scripts/verifyRegenerateStatusPromotionAndCascade.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let checks = 0;
const failures = [];
function check(label, fn) {
  try { fn(); checks += 1; console.log(`  ✓ ${label}`); }
  catch (err) { failures.push(label); console.log(`  ✗ ${label} — ${String(err.message).split('\n')[0].slice(0, 240)}`); }
}
async function checkAsync(label, fn) {
  try { await fn(); checks += 1; console.log(`  ✓ ${label}`); }
  catch (err) { failures.push(label); console.log(`  ✗ ${label} — ${String(err.message).split('\n')[0].slice(0, 240)}`); }
}

const ROOT = path.join(__dirname, '..');
const SVC   = path.join(ROOT, 'services', 'adRegenerateService.js');
const AD    = path.join(ROOT, 'models', 'Ad.js');
const MEDIA = path.join(ROOT, 'models', 'Media.js');
const RUN   = path.join(ROOT, 'models', 'CampaignRun.js');
const VEO   = path.join(ROOT, 'services', 'videoRouter.js');
const BSE   = path.join(ROOT, 'services', 'brandScriptExecutor.js');
const CLOUD = path.join(ROOT, 'services', 'cloudinaryService.js');
const DI    = path.join(ROOT, 'services', 'directImageRenderService.js');
const CAGS  = path.join(ROOT, 'services', 'campaignAdsGenerationService.js');
const SUS   = path.join(ROOT, 'services', 'seededUniverseService.js');
const UGC   = path.join(ROOT, 'services', 'ugcVideoPipeline.js');
const ADGEN = path.join(ROOT, 'services', 'adgenBridge.js');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

// ── Minimal in-memory Mongo-like collection ────────────────────────────
// Small and self-contained deliberately — this repo has no shared
// mini-mongo-stub lib (unlike adgen's scripts/lib/miniMongoStub.js, built
// for its own titling harnesses); duplicating ~30 lines here is cheaper and
// less coupling than introducing a new cross-repo-synced lib file for one
// harness. Supports exactly the operator surface these three functions use:
// top-level equality and $ne.
function matches(doc, filter) {
  return Object.entries(filter).every(([key, cond]) => {
    const val = doc[key];
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      return Object.entries(cond).every(([op, opVal]) => {
        if (op === '$ne') return val !== opVal;
        throw new Error(`unsupported operator ${op}`);
      });
    }
    return val === cond;
  });
}
class MiniCollection {
  constructor(docs = []) { this.docs = docs.map((d) => ({ ...d })); }
  find(filter) {
    const self = this;
    return { lean: async () => self.docs.filter((d) => matches(d, filter)).map((d) => ({ ...d })) };
  }
  findById(id) {
    const self = this;
    return { select() { return this; }, lean: async () => { const d = self.docs.find((x) => String(x._id) === String(id)); return d ? { ...d } : null; } };
  }
  async updateOne(filter, update) {
    const doc = this.docs.find((d) => matches(d, filter));
    if (!doc) return { matchedCount: 0, modifiedCount: 0 };
    if (update.$set) Object.assign(doc, update.$set);
    if (update.$unset) { for (const k of Object.keys(update.$unset)) delete doc[k]; }
    return { matchedCount: 1, modifiedCount: 1 };
  }
}

let AdCol;
let bseCalls;
let bseState;

function install() {
  for (const m of [SVC, AD, MEDIA, RUN, VEO, BSE, CLOUD, DI, CAGS, SUS, UGC, ADGEN]) {
    delete require.cache[m];
  }
  AdCol = new MiniCollection([]);
  stub(AD, {
    find:      (filter) => AdCol.find(filter),
    findById:  (id) => AdCol.findById(id),
    updateOne: (filter, update) => AdCol.updateOne(filter, update)
  });
  stub(MEDIA, { findById: () => ({ select: () => ({ lean: async () => null }) }), exists: async () => false });
  stub(RUN, { findOne: () => ({ select: () => ({ lean: async () => null }) }) });
  stub(VEO, {});
  bseCalls = [];
  bseState = { visionQc: { passed: true, skipped: false, disabled: false } };
  const buildVideoQcFailureFields = (visionQc) => {
    const failed = !!visionQc && visionQc.passed === false && !visionQc.skipped && !visionQc.disabled;
    if (!failed) return {};
    return { status: 'failed', renderError: { message: 'sim vision QC fail', stage: 'vision-qc', at: new Date(), charged: true } };
  };
  stub(BSE, {
    buildVideoQcFailureFields,
    qcAndStampVideoAd: async ({ ad, deliveredUrl, brandName }) => {
      bseCalls.push({ fn: 'qcAndStampVideoAd', adId: String(ad._id), deliveredUrl, brandName });
      const verdict = bseState.visionQc;
      const fields = { visionQc: verdict, ...buildVideoQcFailureFields(verdict) };
      await AdCol.updateOne({ _id: ad._id }, { $set: fields });
      return verdict || null;
    }
  });
  stub(CLOUD, { uploadBufferToCloudinary: async () => ({}) });
  stub(DI, {});
  stub(CAGS, { resolveDeriveFromMaster: (ad) => {
    if (!ad) return null;
    if (typeof ad.deriveFromMaster === 'string' && ad.deriveFromMaster) return ad.deriveFromMaster;
    if (ad.platformFormat === 'pmax_video_1_1') return 'pmax_video_9_16';
    return null;
  } });
  stub(SUS, { isUgcFirstSeedingEnabled: () => false });
  stub(UGC, { preparePassthroughMaster: async () => ({ passthrough: false, reason: 'stub' }) });
  stub(ADGEN, { isAdgenRendererEnabled: () => false });
  return require(SVC);
}

const svc = install();

function baseAd(over = {}) {
  return {
    _id: 'a0000000000000000000000',
    campaignId: 'c0000000000000000000000',
    productId:  'p0000000000000000000000',
    platformFormat: 'meta_stories_9_16',
    deriveFromMaster: null,
    kind: 'video',
    status: 'draft',
    regenerating: false,
    claimedByWorker: null,
    retitleClaimedByWorker: null,
    veoVideoUrl: null,
    veoAspectRatio: null,
    basePlate: undefined,
    ...over
  };
}

(async () => {
  console.log('\nRegenerate status-promotion + derivative-cascade fix — behavioural + structural');

  // ═══════════════════════════════════════════════════════════════════
  // GROUP A — promoteFailedToDraft
  // ═══════════════════════════════════════════════════════════════════
  await checkAsync('A0 promoteFailedToDraft is exported and callable', async () => {
    assert.strictEqual(typeof svc.promoteFailedToDraft, 'function');
  });

  await checkAsync('A1 [MONEY-ADJACENT] status:failed IS promoted to draft', async () => {
    AdCol = new MiniCollection([baseAd({ status: 'failed' })]);
    stub(AD, { find: (f) => AdCol.find(f), findById: (id) => AdCol.findById(id), updateOne: (f, u) => AdCol.updateOne(f, u) });
    await svc.promoteFailedToDraft(baseAd()._id);
    const [doc] = await AdCol.find({}).lean();
    assert.strictEqual(doc.status, 'draft');
  });

  for (const priorStatus of ['draft', 'live', 'archived']) {
    await checkAsync(`A2-4 [MONEY] status:${priorStatus} is NEVER touched by promoteFailedToDraft`, async () => {
      AdCol = new MiniCollection([baseAd({ status: priorStatus })]);
      stub(AD, { find: (f) => AdCol.find(f), findById: (id) => AdCol.findById(id), updateOne: (f, u) => AdCol.updateOne(f, u) });
      await svc.promoteFailedToDraft(baseAd()._id);
      const [doc] = await AdCol.find({}).lean();
      assert.strictEqual(doc.status, priorStatus, `must stay ${priorStatus}, got ${doc.status}`);
    });
  }

  await checkAsync('A5 a non-matching adId is a silent no-op (no throw)', async () => {
    AdCol = new MiniCollection([baseAd({ status: 'failed' })]);
    stub(AD, { find: (f) => AdCol.find(f), findById: (id) => AdCol.findById(id), updateOne: (f, u) => AdCol.updateOne(f, u) });
    await svc.promoteFailedToDraft('ffffffffffffffffffffffff');
    const [doc] = await AdCol.find({}).lean();
    assert.strictEqual(doc.status, 'failed', 'the real doc must be untouched by a miss on a different id');
  });

  await checkAsync('A6 an Ad.updateOne throw is swallowed (never fatal to the caller)', async () => {
    stub(AD, { updateOne: async () => { throw new Error('simulated Mongo error'); } });
    await svc.promoteFailedToDraft('a0000000000000000000000'); // must not throw
  });

  // ═══════════════════════════════════════════════════════════════════
  // GROUP B — findDerivativesOfMaster (inverts findSiblingMasterAd)
  // ═══════════════════════════════════════════════════════════════════
  function buildFamily() {
    const master = baseAd({ _id: 'm0000000000000000000000', deriveFromMaster: null, veoVideoUrl: 'https://old.example/master' });
    const eligible = baseAd({ _id: 's1000000000000000000000', deriveFromMaster: master.platformFormat });
    const claimed  = baseAd({ _id: 's2000000000000000000000', deriveFromMaster: master.platformFormat, claimedByWorker: 'renderer-x' });
    const regening = baseAd({ _id: 's3000000000000000000000', deriveFromMaster: master.platformFormat, regenerating: true });
    const retitled = baseAd({ _id: 's4000000000000000000000', deriveFromMaster: master.platformFormat, retitleClaimedByWorker: 'titler-x' });
    const otherCamp = baseAd({ _id: 's5000000000000000000000', deriveFromMaster: master.platformFormat, campaignId: 'zzzzzzzzzzzzzzzzzzzzzzzz' });
    const otherProd = baseAd({ _id: 's6000000000000000000000', deriveFromMaster: master.platformFormat, productId: 'zzzzzzzzzzzzzzzzzzzzzzzz' });
    const wrongFmt  = baseAd({ _id: 's7000000000000000000000', deriveFromMaster: 'pmax_video_9_16' });
    const trueMaster = baseAd({ _id: 's8000000000000000000000', deriveFromMaster: null });
    return { master, docs: [master, eligible, claimed, regening, retitled, otherCamp, otherProd, wrongFmt, trueMaster] };
  }

  await checkAsync('B1 finds the one eligible sibling', async () => {
    const { master, docs } = buildFamily();
    AdCol = new MiniCollection(docs);
    stub(AD, { find: (f) => AdCol.find(f), findById: (id) => AdCol.findById(id), updateOne: (f, u) => AdCol.updateOne(f, u) });
    const found = await svc.findDerivativesOfMaster(master);
    assert.strictEqual(found.length, 1, `expected exactly 1, got ${found.length}: ${found.map((d) => d._id)}`);
    assert.strictEqual(found[0]._id, 's1000000000000000000000');
  });

  const exclusions = [
    ['B2 excludes a sibling claimed by a renderer', 's2000000000000000000000'],
    ['B3 excludes a sibling currently regenerating', 's3000000000000000000000'],
    ['B4 excludes a sibling retitle-claimed', 's4000000000000000000000'],
    ['B5 excludes a different campaignId', 's5000000000000000000000'],
    ['B6 excludes a different productId', 's6000000000000000000000'],
    ['B7 excludes a different deriveFromMaster value (wrong master format)', 's7000000000000000000000'],
    ['B8 excludes an unrelated true master (deriveFromMaster:null)', 's8000000000000000000000']
  ];
  for (const [label, excludedId] of exclusions) {
    await checkAsync(label, async () => {
      const { master, docs } = buildFamily();
      AdCol = new MiniCollection(docs);
      stub(AD, { find: (f) => AdCol.find(f), findById: (id) => AdCol.findById(id), updateOne: (f, u) => AdCol.updateOne(f, u) });
      const found = await svc.findDerivativesOfMaster(master);
      assert.ok(!found.some((d) => d._id === excludedId), `${excludedId} must not be returned`);
    });
  }

  await checkAsync('B9 [MONEY] never returns the master\'s own document', async () => {
    const master = baseAd({ _id: 'm0000000000000000000000', deriveFromMaster: 'meta_stories_9_16', platformFormat: 'meta_stories_9_16' });
    AdCol = new MiniCollection([master]);
    stub(AD, { find: (f) => AdCol.find(f), findById: (id) => AdCol.findById(id), updateOne: (f, u) => AdCol.updateOne(f, u) });
    const found = await svc.findDerivativesOfMaster(master);
    assert.strictEqual(found.length, 0, 'the _id:{$ne:...} clause must exclude the master itself');
  });

  // ═══════════════════════════════════════════════════════════════════
  // GROUP C — recascadeDerivativeSibling (no titling in this repo — see
  // the function's own doc comment on this file's now-titling-free posture)
  // ═══════════════════════════════════════════════════════════════════
  function freshMaster(over = {}) {
    return baseAd({ _id: 'm0000000000000000000000', veoVideoUrl: 'https://new.example/master-v2', veoAspectRatio: '9:16', platformFormat: 'meta_stories_9_16', ...over });
  }

  await checkAsync('C1 copies the NEW master plate onto the sibling, stamps the derive-from marker, and clears stale basePlate', async () => {
    const master = freshMaster();
    const sibling = baseAd({ _id: 's1000000000000000000000', deriveFromMaster: master.platformFormat, veoVideoUrl: 'https://old.example/sibling-v1', basePlate: { sourceUrl: 'https://old.example/sibling-v1' }, status: 'live' });
    AdCol = new MiniCollection([master, sibling]);
    stub(AD, { find: (f) => AdCol.find(f), findById: (id) => AdCol.findById(id), updateOne: (f, u) => AdCol.updateOne(f, u) });
    await svc.recascadeDerivativeSibling(sibling, master);
    const after = await AdCol.findById(sibling._id).lean();
    assert.strictEqual(after.veoVideoUrl, master.veoVideoUrl);
    assert.strictEqual(after.renderUrl, master.veoVideoUrl);
    assert.strictEqual(after.veoModel, `derive-from:${master.platformFormat}`);
    assert.strictEqual(after.basePlate, undefined, 'a stale crop-rect from a DIFFERENT video must not survive');
  });

  await checkAsync('C2 [MONEY-ADJACENT] a QC-passing re-composite promotes a previously-failed sibling to draft', async () => {
    const master = freshMaster();
    const sibling = baseAd({ _id: 's1000000000000000000000', deriveFromMaster: master.platformFormat, status: 'failed' });
    AdCol = new MiniCollection([master, sibling]);
    stub(AD, { find: (f) => AdCol.find(f), findById: (id) => AdCol.findById(id), updateOne: (f, u) => AdCol.updateOne(f, u) });
    bseState.visionQc = { passed: true, skipped: false, disabled: false };
    await svc.recascadeDerivativeSibling(sibling, master);
    const after = await AdCol.findById(sibling._id).lean();
    assert.strictEqual(after.status, 'draft');
  });

  await checkAsync('C3 [MONEY] a QC-passing re-composite NEVER touches a sibling that was live', async () => {
    const master = freshMaster();
    const sibling = baseAd({ _id: 's1000000000000000000000', deriveFromMaster: master.platformFormat, status: 'live' });
    AdCol = new MiniCollection([master, sibling]);
    stub(AD, { find: (f) => AdCol.find(f), findById: (id) => AdCol.findById(id), updateOne: (f, u) => AdCol.updateOne(f, u) });
    bseState.visionQc = { passed: true, skipped: false, disabled: false };
    await svc.recascadeDerivativeSibling(sibling, master);
    const after = await AdCol.findById(sibling._id).lean();
    assert.strictEqual(after.status, 'live');
  });

  await checkAsync('C4 [MONEY] a fresh real QC FAILURE is never overwritten back to draft by this cascade\'s own promotion', async () => {
    const master = freshMaster();
    const sibling = baseAd({ _id: 's1000000000000000000000', deriveFromMaster: master.platformFormat, status: 'failed' });
    AdCol = new MiniCollection([master, sibling]);
    stub(AD, { find: (f) => AdCol.find(f), findById: (id) => AdCol.findById(id), updateOne: (f, u) => AdCol.updateOne(f, u) });
    bseState.visionQc = { passed: false, skipped: false, disabled: false, attempts: [{ summary: 'sim' }] };
    await svc.recascadeDerivativeSibling(sibling, master);
    const after = await AdCol.findById(sibling._id).lean();
    assert.strictEqual(after.status, 'failed', 'qcJustFailed must gate OUT the promoteFailedToDraft call');
  });

  await checkAsync('C5 a per-sibling failure never throws out of recascadeDerivativeSibling (master regenerate unaffected)', async () => {
    const master = freshMaster();
    const sibling = baseAd({ _id: 's1000000000000000000000', deriveFromMaster: master.platformFormat });
    stub(AD, {
      find:      () => ({ lean: async () => [] }),
      findById:  () => ({ lean: async () => { throw new Error('simulated DB error'); } }),
      updateOne: async () => ({ matchedCount: 0, modifiedCount: 0 })
    });
    await svc.recascadeDerivativeSibling(sibling, master); // must not throw
  });

  // ═══════════════════════════════════════════════════════════════════
  // GROUP D — cascadeRegenerateToDerivatives (end-to-end)
  // ═══════════════════════════════════════════════════════════════════
  await checkAsync('D1 cascades to an eligible sibling and leaves an ineligible (claimed) one untouched', async () => {
    const master = freshMaster({ status: 'draft' });
    const eligible = baseAd({ _id: 's1000000000000000000000', deriveFromMaster: master.platformFormat, status: 'failed', veoVideoUrl: 'https://old.example/s1' });
    const claimed = baseAd({ _id: 's2000000000000000000000', deriveFromMaster: master.platformFormat, status: 'failed', claimedByWorker: 'renderer-x', veoVideoUrl: 'https://old.example/s2' });
    AdCol = new MiniCollection([master, eligible, claimed]);
    stub(AD, { find: (f) => AdCol.find(f), findById: (id) => AdCol.findById(id), updateOne: (f, u) => AdCol.updateOne(f, u) });
    bseState.visionQc = { passed: true, skipped: false, disabled: false };
    await svc.cascadeRegenerateToDerivatives(master._id);
    const afterEligible = await AdCol.findById(eligible._id).lean();
    const afterClaimed  = await AdCol.findById(claimed._id).lean();
    assert.strictEqual(afterEligible.veoVideoUrl, master.veoVideoUrl, 'the eligible sibling must be re-composited');
    assert.strictEqual(afterEligible.status, 'draft', 'and promoted off failed');
    assert.strictEqual(afterClaimed.veoVideoUrl, 'https://old.example/s2', 'a claimed sibling must be left alone this pass');
    assert.strictEqual(afterClaimed.status, 'failed');
  });

  await checkAsync('D2 a no-op when the ad has no siblings', async () => {
    const master = freshMaster({ status: 'draft' });
    AdCol = new MiniCollection([master]);
    stub(AD, { find: (f) => AdCol.find(f), findById: (id) => AdCol.findById(id), updateOne: (f, u) => AdCol.updateOne(f, u) });
    await svc.cascadeRegenerateToDerivatives(master._id); // must not throw
  });

  await checkAsync('D3 a missing master ad is a silent no-op', async () => {
    AdCol = new MiniCollection([]);
    stub(AD, { find: (f) => AdCol.find(f), findById: (id) => AdCol.findById(id), updateOne: (f, u) => AdCol.updateOne(f, u) });
    await svc.cascadeRegenerateToDerivatives('ffffffffffffffffffffffff'); // must not throw
  });

  await checkAsync('D4 [MONEY] refuses to cascade FROM a derivative ad (defense in depth)', async () => {
    const derivative = baseAd({ _id: 'd0000000000000000000000', deriveFromMaster: 'pmax_video_9_16', veoVideoUrl: 'https://old.example/d' });
    const wouldMatch = baseAd({ _id: 's1000000000000000000000', deriveFromMaster: derivative.platformFormat, veoVideoUrl: 'https://old.example/s1' });
    AdCol = new MiniCollection([derivative, wouldMatch]);
    stub(AD, { find: (f) => AdCol.find(f), findById: (id) => AdCol.findById(id), updateOne: (f, u) => AdCol.updateOne(f, u) });
    await svc.cascadeRegenerateToDerivatives(derivative._id);
    const after = await AdCol.findById(wouldMatch._id).lean();
    assert.strictEqual(after.veoVideoUrl, 'https://old.example/s1', 'must never touch a would-be sibling of a derivative');
  });

  await checkAsync('D5 a no-op when the master has no veoVideoUrl yet', async () => {
    const master = freshMaster({ veoVideoUrl: null });
    const sibling = baseAd({ _id: 's1000000000000000000000', deriveFromMaster: master.platformFormat, veoVideoUrl: 'https://old.example/s1' });
    AdCol = new MiniCollection([master, sibling]);
    stub(AD, { find: (f) => AdCol.find(f), findById: (id) => AdCol.findById(id), updateOne: (f, u) => AdCol.updateOne(f, u) });
    await svc.cascadeRegenerateToDerivatives(master._id);
    const after = await AdCol.findById(sibling._id).lean();
    assert.strictEqual(after.veoVideoUrl, 'https://old.example/s1');
  });

  // ═══════════════════════════════════════════════════════════════════
  // GROUP E — [MONEY] structural: zero Atlas/Omni reachability
  // ═══════════════════════════════════════════════════════════════════
  const SRC = fs.readFileSync(SVC, 'utf8');
  function balanced(src, openIdx, openCh, closeCh) {
    let depth = 0;
    for (let i = openIdx; i < src.length; i++) {
      if (src[i] === openCh) depth++;
      else if (src[i] === closeCh) { depth--; if (depth === 0) return src.slice(openIdx, i + 1); }
    }
    return null;
  }
  function functionBody(signatureRe) {
    const m = signatureRe.exec(SRC);
    assert.ok(m, `signature not found: ${signatureRe}`);
    const brace = SRC.indexOf('{', m.index + m[0].length - 1);
    const body = balanced(SRC, brace, '{', '}');
    assert.ok(body, `unterminated function body for ${signatureRe}`);
    return body;
  }
  const FORBIDDEN = /veoService|atlasVideoService|generateForAd|prepareStoryboard/;

  check('E1 [MONEY] findDerivativesOfMaster never references a video-submit helper', () => {
    const body = functionBody(/async function findDerivativesOfMaster\(/);
    assert.ok(!FORBIDDEN.test(body), `forbidden identifier found in findDerivativesOfMaster:\n${body}`);
  });
  check('E2 [MONEY] recascadeDerivativeSibling never references a video-submit helper', () => {
    const body = functionBody(/async function recascadeDerivativeSibling\(/);
    assert.ok(!FORBIDDEN.test(body), `forbidden identifier found in recascadeDerivativeSibling:\n${body}`);
  });
  check('E3 [MONEY] cascadeRegenerateToDerivatives never references a video-submit helper', () => {
    const body = functionBody(/async function cascadeRegenerateToDerivatives\(/);
    assert.ok(!FORBIDDEN.test(body), `forbidden identifier found in cascadeRegenerateToDerivatives:\n${body}`);
  });
  check('E4 [MONEY] cascadeRegenerateToDerivatives consults resolveDeriveFromMaster before doing anything else', () => {
    const body = functionBody(/async function cascadeRegenerateToDerivatives\(/);
    assert.ok(/resolveDeriveFromMaster\(masterAd\)/.test(body), 'the defense-in-depth derive guard must be present');
  });

  console.log(`\n${checks} passed, ${failures.length} failed\n`);
  if (failures.length) process.exit(1);
})();
