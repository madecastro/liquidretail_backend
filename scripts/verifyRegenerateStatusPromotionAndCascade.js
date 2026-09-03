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
//    site still exists). An earlier draft of this PR tried to gate that
//    stamp with retitleMode; that expansion was reverted (QC-quarantine /
//    titling-resume / incomplete-branch defects). Regenerating an
//    already-'live' video ad on adgen still silently un-publishes it —
//    a known, unfixed follow-up, not this harness's job. This backend
//    copy no longer calls that stamp (titling removed 2026-08-28).
//
//  FIX 2 — cascadeRegenerateToDerivatives / findDerivativesOfMaster /
//    recascadeDerivativeSibling: after a master ad's video regenerate
//    succeeds, its same-identity derivative siblings (deriveFromMaster === the
//    master's own platformFormat) get a provenance update from the NEW
//    master plate, with ZERO Atlas/Omni spend — the same money invariant
//    resolveDeriveFromMaster / routes/ads.js's renderDeriveOnlyVideoAd
//    protect at mint time, applied to the regenerate path. THIS repo does
//    not composite (no Remotion); a titled sibling is provenance-only, an
//    inherited sibling also updates renderUrl to keep renderUrl ===
//    veoVideoUrl. Joins the rest of computeDeterministicVideoDigest's
//    identity (mediaId / referenceMediaIds, CTA, prompt fields, and
//    videoDurationSec for Google PMax only), not just
//    campaignId+productId+deriveFromMaster — a second Generate with a
//    different seed or CTA is a different family. Not scoped by
//    campaignRunIds (that under-matches later-run same-family siblings).
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
// Group E is the money invariant proper: function-body scan PLUS a real
// require-graph BFS (the pattern scripts/verifyTitlingResumeNeverResubmits.js
// uses) starting from brandScriptExecutor.js — the only heavy callee of
// the cascade. A body-text regex on the three functions cannot see a
// helper they call that then requires atlasVideoService.
//
// Group F drives the REAL runVideoFull tail (fresh-verdict gate, promote,
// cascade) against stubbed providers.
//
// Revert-prove — mutations confirmed to fail this harness (see each group):
//   promoteFailedToDraft loses its status:'failed' filter clause → A2-A5
//   promoteFailedToDraft becomes an unconditional $set (any status->draft)  → A2-A5
//   findDerivativesOfMaster drops the deriveFromMaster / campaignId /
//     productId / kind clause, or any in-flight exclusion               → B2-B8
//   findDerivativesOfMaster fails to exclude the master's own document   → B9
//   recascadeDerivativeSibling re-promotes on top of a fresh QC failure  → C3
//   recascadeDerivativeSibling's try/catch around the CAS write is
//     deleted (C4 must FAIL — it used to be vacuous because a re-stub of
//     require.cache[AD] never rebound the module's captured Ad)          → C4
//   recascadeDerivativeSibling stamps veoModel without the derive-from
//     marker, or fails to clear stale basePlate                         → C1-C2
//   recascadeDerivativeSibling provenance-only-writes an inherited
//     sibling (renderUrl left on the OLD plate)                         → C5
//   findDerivativesOfMaster drops the PMax videoDurationSec join        → B21
//   findDerivativesOfMaster drops the ctaUrl / ctaUrlParams /
//     videoPromptGuidance join                                          → B26-B28
//   buildDerivativesOfMasterFilter fails to refuse a missing campaignId /
//     productId / empty-media master (BSON would drop the key)          → B29-B31
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
    if (key === '$or') return cond.some((sub) => matches(doc, sub));
    if (key === '$and') return cond.every((sub) => matches(doc, sub));
    const val = doc[key];
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      return Object.entries(cond).every(([op, opVal]) => {
        if (op === '$ne') return val !== opVal;
        // Array-field $in/$nin: Mongo's $in against an array field matches
        // when ANY element of the array is in the list (array-contains-any),
        // not scalar equality of the whole array. Missing fields are treated
        // as null for $in, matching Mongo `{field: {$in:[null]}}` on a
        // present-null (lean() docs in these tests always materialise the
        // identity fields, so this is belt-and-braces).
        if (op === '$in') {
          return Array.isArray(val)
            ? val.some((v) => opVal.includes(v))
            : opVal.includes(val === undefined ? null : val);
        }
        if (op === '$nin') {
          return Array.isArray(val)
            ? !val.some((v) => opVal.includes(v))
            : !opVal.includes(val === undefined ? null : val);
        }
        if (op === '$exists') return opVal ? val !== undefined : val === undefined;
        if (op === '$size') return Array.isArray(val) && val.length === opVal;
        throw new Error(`unsupported operator ${op}`);
      });
    }
    // Mongo array equality is by value (order-significant), not JS reference.
    if (Array.isArray(cond)) {
      if (!Array.isArray(val) || val.length !== cond.length) return false;
      return val.every((v, i) => v === cond[i] || String(v) === String(cond[i]));
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
  stub(VEO, {
    prepareStoryboard: async () => ({ storyboard: null }),
    generateForAd: async () => ({
      videoUrl: 'https://new.example/omni-master.mp4',
      aspectRatio: '9:16',
      prompt: 'p',
      storyboard: null,
      model: 'omni',
      referenceImages: [],
      skipped: false
    })
  });
  bseCalls = [];
  bseState = { visionQc: { passed: true, skipped: false, disabled: false }, swallowQc: false };
  const buildVideoQcFailureFields = (visionQc) => {
    const failed = !!visionQc && visionQc.passed === false && !visionQc.skipped && !visionQc.disabled;
    if (!failed) return {};
    return { status: 'failed', renderError: { message: 'sim vision QC fail', stage: 'vision-qc', at: new Date(), charged: true } };
  };
  stub(BSE, {
    buildVideoQcFailureFields,
    qcAndStampVideoAd: async ({ ad, deliveredUrl, brandName }) => {
      bseCalls.push({ fn: 'qcAndStampVideoAd', adId: String(ad._id), deliveredUrl, brandName });
      if (bseState.swallowQc) return null;
      const verdict = bseState.visionQc;
      const fields = { visionQc: verdict, ...buildVideoQcFailureFields(verdict) };
      await AdCol.updateOne({ _id: ad._id }, { $set: fields });
      return verdict || null;
    }
  });
  stub(CLOUD, { uploadBufferToCloudinary: async () => ({}) });
  stub(DI, {});
  stub(CAGS, {
    resolveDeriveFromMaster: (ad) => {
      if (!ad) return null;
      if (typeof ad.deriveFromMaster === 'string' && ad.deriveFromMaster) return ad.deriveFromMaster;
      if (ad.platformFormat === 'pmax_video_1_1') return 'pmax_video_9_16';
      return null;
    },
    // Same 3-format predicate as campaignAdsGenerationService.isGooglePmaxVideoFormat
    // (GOOGLE_VIDEO_MASTER_SET ∪ PMAX_VIDEO_DERIVE_ONLY). Production code
    // imports the real export; this stub exists because install() replaces
    // the whole CAGS module before requiring the service.
    isGooglePmaxVideoFormat: (fmt) =>
      fmt === 'pmax_video_9_16' || fmt === 'pmax_video_16_9' || fmt === 'pmax_video_1_1'
  });
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
    mediaId:    'x0000000000000000000000',
    referenceMediaIds: [],
    ctaText: '',
    ctaUrl: '',
    ctaUrlParams: '',
    videoPromptGuidance: null,
    videoPromptRaw: null,
    platformFormat: 'meta_stories_9_16',
    deriveFromMaster: null,
    kind: 'video',
    status: 'draft',
    regenerating: false,
    claimedByWorker: null,
    retitleClaimedByWorker: null,
    titlingNeeded: false,
    veoVideoUrl: null,
    veoAspectRatio: null,
    renderUrl: null,
    basePlate: undefined,
    campaignRunIds: ['run-1'],
    visionQc: null,
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
    AdCol = new MiniCollection([baseAd({ status: 'failed' })]);
    stub(AD, { find: (f) => AdCol.find(f), findById: (id) => AdCol.findById(id), updateOne: (f, u) => AdCol.updateOne(f, u) });
    // See C4's own comment for why AdCol.updateOne is overridden in place
    // rather than re-calling stub(AD, {...}) with a brand-new object.
    AdCol.updateOne = async () => { throw new Error('simulated Mongo error'); };
    await svc.promoteFailedToDraft('a0000000000000000000000'); // must not throw
  });

  // ═══════════════════════════════════════════════════════════════════
  // GROUP B — findDerivativesOfMaster (inverts findSiblingMasterAd)
  // ═══════════════════════════════════════════════════════════════════
  function buildFamily() {
    const master = baseAd({ _id: 'm0000000000000000000000', deriveFromMaster: null, veoVideoUrl: 'https://old.example/master', campaignRunIds: ['run-1'] });
    const eligible  = baseAd({ _id: 's1000000000000000000000', deriveFromMaster: master.platformFormat, campaignRunIds: ['run-1'] });
    const claimed   = baseAd({ _id: 's2000000000000000000000', deriveFromMaster: master.platformFormat, claimedByWorker: 'renderer-x', campaignRunIds: ['run-1'] });
    const regening  = baseAd({ _id: 's3000000000000000000000', deriveFromMaster: master.platformFormat, regenerating: true, campaignRunIds: ['run-1'] });
    const retitled  = baseAd({ _id: 's4000000000000000000000', deriveFromMaster: master.platformFormat, retitleClaimedByWorker: 'titler-x', campaignRunIds: ['run-1'] });
    const otherCamp = baseAd({ _id: 's5000000000000000000000', deriveFromMaster: master.platformFormat, campaignId: 'zzzzzzzzzzzzzzzzzzzzzzzz', campaignRunIds: ['run-1'] });
    const otherProd = baseAd({ _id: 's6000000000000000000000', deriveFromMaster: master.platformFormat, productId: 'zzzzzzzzzzzzzzzzzzzzzzzz', campaignRunIds: ['run-1'] });
    const wrongFmt  = baseAd({ _id: 's7000000000000000000000', deriveFromMaster: 'pmax_video_9_16', campaignRunIds: ['run-1'] });
    const trueMaster = baseAd({ _id: 's8000000000000000000000', deriveFromMaster: null, campaignRunIds: ['run-1'] });
    const titlerOwned = baseAd({ _id: 's9000000000000000000000', deriveFromMaster: master.platformFormat, titlingNeeded: true, campaignRunIds: ['run-1'] });
    const stillRendering = baseAd({ _id: 'sA000000000000000000000', deriveFromMaster: master.platformFormat, status: 'rendering', campaignRunIds: ['run-1'] });
    const archived = baseAd({ _id: 'sB000000000000000000000', deriveFromMaster: master.platformFormat, status: 'archived', campaignRunIds: ['run-1'] });
    // A genuine sibling minted in a LATER run than the master's own
    // campaignRunIds snapshot (e.g. a funnel-variant added on a later
    // Generate) — MUST still be found. An earlier version of this fix
    // scoped by campaignRunIds and would have missed this row; removed
    // after a second adversarial review pass proved that scoping wrong in
    // the harmful direction (see findDerivativesOfMaster's own comment).
    const laterRunSibling = baseAd({ _id: 'sC000000000000000000000', deriveFromMaster: master.platformFormat, campaignRunIds: ['run-9'] });
    return {
      master,
      docs: [master, eligible, claimed, regening, retitled, otherCamp, otherProd, wrongFmt, trueMaster, titlerOwned, stillRendering, archived, laterRunSibling]
    };
  }

  await checkAsync('B1 finds the eligible siblings, INCLUDING one from a later campaign run', async () => {
    const { master, docs } = buildFamily();
    AdCol = new MiniCollection(docs);
    stub(AD, { find: (f) => AdCol.find(f), findById: (id) => AdCol.findById(id), updateOne: (f, u) => AdCol.updateOne(f, u) });
    const found = await svc.findDerivativesOfMaster(master);
    const foundIds = found.map((d) => d._id).sort();
    assert.deepStrictEqual(foundIds, ['s1000000000000000000000', 'sC000000000000000000000'].sort(),
      `expected exactly the same-run and later-run siblings, got ${foundIds}`);
  });

  const exclusions = [
    ['B2 excludes a sibling claimed by a renderer', 's2000000000000000000000'],
    ['B3 excludes a sibling currently regenerating', 's3000000000000000000000'],
    ['B4 excludes a sibling retitle-claimed', 's4000000000000000000000'],
    ['B5 excludes a different campaignId', 's5000000000000000000000'],
    ['B6 excludes a different productId', 's6000000000000000000000'],
    ['B7 excludes a different deriveFromMaster value (wrong master format)', 's7000000000000000000000'],
    ['B8 excludes an unrelated true master (deriveFromMaster:null)', 's8000000000000000000000'],
    ['B9 [MONEY] excludes a titler-owned sibling (titlingNeeded:true)', 's9000000000000000000000'],
    ['B10a excludes a sibling still mid-first-render (status:rendering)', 'sA000000000000000000000'],
    ['B10b [MONEY] excludes an archived sibling', 'sB000000000000000000000']
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

  await checkAsync('B11 [MONEY] never returns the master\'s own document', async () => {
    const master = baseAd({ _id: 'm0000000000000000000000', deriveFromMaster: 'meta_stories_9_16', platformFormat: 'meta_stories_9_16' });
    AdCol = new MiniCollection([master]);
    stub(AD, { find: (f) => AdCol.find(f), findById: (id) => AdCol.findById(id), updateOne: (f, u) => AdCol.updateOne(f, u) });
    const found = await svc.findDerivativesOfMaster(master);
    assert.strictEqual(found.length, 0, 'the _id:{$ne:...} clause must exclude the master itself');
  });

  await checkAsync('B12 [BLOCKER 1] a same-campaign/product/format sibling with a DIFFERENT mediaId is excluded (cross-family)', async () => {
    const master = baseAd({ _id: 'm0000000000000000000000', deriveFromMaster: null, mediaId: 'media-family-1', veoVideoUrl: 'https://m1' });
    const sameFamily = baseAd({ _id: 's1000000000000000000000', deriveFromMaster: master.platformFormat, mediaId: 'media-family-1' });
    const otherFamily = baseAd({ _id: 'sD000000000000000000000', deriveFromMaster: master.platformFormat, mediaId: 'media-family-2' });
    AdCol = new MiniCollection([master, sameFamily, otherFamily]);
    stub(AD, { find: (f) => AdCol.find(f), findById: (id) => AdCol.findById(id), updateOne: (f, u) => AdCol.updateOne(f, u) });
    const found = await svc.findDerivativesOfMaster(master);
    const foundIds = found.map((d) => d._id);
    assert.deepStrictEqual(foundIds, ['s1000000000000000000000']);
  });

  await checkAsync('B13 [BLOCKER 1] a sibling with a different ctaText is excluded', async () => {
    const master = baseAd({ _id: 'm0000000000000000000000', deriveFromMaster: null, ctaText: 'SHOP NOW', veoVideoUrl: 'https://m1' });
    const sameFamily = baseAd({ _id: 's1000000000000000000000', deriveFromMaster: master.platformFormat, ctaText: 'SHOP NOW' });
    const otherCta = baseAd({ _id: 'sE000000000000000000000', deriveFromMaster: master.platformFormat, ctaText: 'BUY NOW' });
    AdCol = new MiniCollection([master, sameFamily, otherCta]);
    stub(AD, { find: (f) => AdCol.find(f), findById: (id) => AdCol.findById(id), updateOne: (f, u) => AdCol.updateOne(f, u) });
    const found = await svc.findDerivativesOfMaster(master);
    assert.deepStrictEqual(found.map((d) => d._id), ['s1000000000000000000000']);
  });

  await checkAsync('B14 [BLOCKER 1] a sibling with a different videoPromptRaw is excluded', async () => {
    const master = baseAd({ _id: 'm0000000000000000000000', deriveFromMaster: null, videoPromptRaw: 'canonical A', veoVideoUrl: 'https://m1' });
    const sameFamily = baseAd({ _id: 's1000000000000000000000', deriveFromMaster: master.platformFormat, videoPromptRaw: 'canonical A' });
    const otherPrompt = baseAd({ _id: 'sF000000000000000000000', deriveFromMaster: master.platformFormat, videoPromptRaw: 'canonical B' });
    AdCol = new MiniCollection([master, sameFamily, otherPrompt]);
    stub(AD, { find: (f) => AdCol.find(f), findById: (id) => AdCol.findById(id), updateOne: (f, u) => AdCol.updateOne(f, u) });
    const found = await svc.findDerivativesOfMaster(master);
    assert.deepStrictEqual(found.map((d) => d._id), ['s1000000000000000000000']);
  });

  await checkAsync('B15 [BLOCKER 1] a sibling with a different referenceMediaIds stack is excluded', async () => {
    const master = baseAd({ _id: 'm0000000000000000000000', deriveFromMaster: null, referenceMediaIds: ['r1', 'r2'], mediaId: 'r1', veoVideoUrl: 'https://m1' });
    const sameFamily = baseAd({ _id: 's1000000000000000000000', deriveFromMaster: master.platformFormat, referenceMediaIds: ['r1', 'r2'], mediaId: 'r1' });
    const otherRefs = baseAd({ _id: 'sG000000000000000000000', deriveFromMaster: master.platformFormat, referenceMediaIds: ['r9'], mediaId: 'r9' });
    AdCol = new MiniCollection([master, sameFamily, otherRefs]);
    stub(AD, { find: (f) => AdCol.find(f), findById: (id) => AdCol.findById(id), updateOne: (f, u) => AdCol.updateOne(f, u) });
    const found = await svc.findDerivativesOfMaster(master);
    assert.deepStrictEqual(found.map((d) => d._id), ['s1000000000000000000000']);
  });

  await checkAsync('B16 [BLOCKER 2] missing platformFormat returns [] AND never queries (BSON would drop the key)', async () => {
    const master = baseAd({ _id: 'm0000000000000000000000', platformFormat: undefined, deriveFromMaster: null, veoVideoUrl: 'https://m1' });
    const otherPaidMaster = baseAd({ _id: 's8000000000000000000000', deriveFromMaster: null, veoVideoUrl: 'https://other-master' });
    const wouldMatchIfDropped = baseAd({ _id: 's1000000000000000000000', deriveFromMaster: 'meta_stories_9_16' });
    AdCol = new MiniCollection([master, otherPaidMaster, wouldMatchIfDropped]);
    stub(AD, { find: (f) => AdCol.find(f), findById: (id) => AdCol.findById(id), updateOne: (f, u) => AdCol.updateOne(f, u) });
    // Spy on the LIVE collection — re-stubbing require.cache[AD] does not
    // rebind adRegenerateService's `const Ad = require(...)` (see C4).
    let findCalled = false;
    const origFind = AdCol.find.bind(AdCol);
    AdCol.find = (f) => { findCalled = true; return origFind(f); };
    const found = await svc.findDerivativesOfMaster(master);
    assert.strictEqual(found.length, 0);
    assert.strictEqual(findCalled, false, 'must not query at all — BSON drops deriveFromMaster:undefined and would match every video ad in the product, including other paid masters');
  });

  check('B17 [BLOCKER 2] buildDerivativesOfMasterFilter returns null when platformFormat is missing', () => {
    assert.strictEqual(typeof svc.buildDerivativesOfMasterFilter, 'function');
    const filter = svc.buildDerivativesOfMasterFilter(baseAd({ platformFormat: undefined }));
    assert.strictEqual(filter, null);
  });

  check('B18 [BLOCKER 2] JSON/BSON-style drop: an undefined deriveFromMaster key disappears from a naive filter (why the guard exists)', () => {
    const naive = { campaignId: 'c', productId: 'p', deriveFromMaster: undefined, kind: 'video' };
    const dropped = JSON.parse(JSON.stringify(naive));
    assert.ok(!Object.prototype.hasOwnProperty.call(dropped, 'deriveFromMaster'),
      'undefined keys are dropped on the wire; the guard must refuse before this filter is built');
  });

  check('B19 [BLOCKER 2] a valid filter keeps deriveFromMaster as a real string (never undefined)', () => {
    const filter = svc.buildDerivativesOfMasterFilter(baseAd({ platformFormat: 'meta_stories_9_16' }));
    assert.ok(filter);
    assert.strictEqual(filter.deriveFromMaster, 'meta_stories_9_16');
    const roundTripped = JSON.parse(JSON.stringify(filter));
    assert.strictEqual(roundTripped.deriveFromMaster, 'meta_stories_9_16');
  });

  check('B20 sibling cap is a finite positive integer', () => {
    assert.ok(Number.isInteger(svc.MAX_REGEN_CASCADE_SIBLINGS) && svc.MAX_REGEN_CASCADE_SIBLINGS >= 1);
  });

  await checkAsync('B21 [BLOCKER] a PMax 10s master does NOT match a 12s same-family-otherwise derive', async () => {
    const master10 = baseAd({
      _id: 'm0000000000000000000000',
      platformFormat: 'pmax_video_9_16',
      deriveFromMaster: null,
      videoDurationSec: 10,
      veoVideoUrl: 'https://m10'
    });
    const derive10 = baseAd({
      _id: 's1000000000000000000000',
      platformFormat: 'pmax_video_1_1',
      deriveFromMaster: 'pmax_video_9_16',
      videoDurationSec: 10
    });
    const derive12 = baseAd({
      _id: 'sH000000000000000000000',
      platformFormat: 'pmax_video_1_1',
      deriveFromMaster: 'pmax_video_9_16',
      videoDurationSec: 12
    });
    AdCol = new MiniCollection([master10, derive10, derive12]);
    const found = await svc.findDerivativesOfMaster(master10);
    assert.deepStrictEqual(found.map((d) => d._id), ['s1000000000000000000000'],
      `10s master must not cascade onto a 12s derive; got ${found.map((d) => d._id)}`);
  });

  await checkAsync('B22 Meta duration is NOT identity — an 8s master still finds a 10s sibling', async () => {
    const master = baseAd({
      _id: 'm0000000000000000000000',
      platformFormat: 'meta_stories_9_16',
      deriveFromMaster: null,
      videoDurationSec: 8,
      veoVideoUrl: 'https://m8'
    });
    const sibling10 = baseAd({
      _id: 's1000000000000000000000',
      deriveFromMaster: 'meta_stories_9_16',
      videoDurationSec: 10
    });
    AdCol = new MiniCollection([master, sibling10]);
    const found = await svc.findDerivativesOfMaster(master);
    assert.deepStrictEqual(found.map((d) => d._id), ['s1000000000000000000000']);
  });

  check('B23 PMax filter joins videoDurationSec (null/empty → null, same helper as other identity fields)', () => {
    const ten = svc.buildDerivativesOfMasterFilter(baseAd({ platformFormat: 'pmax_video_9_16', videoDurationSec: 10 }));
    assert.ok(ten);
    assert.strictEqual(ten.videoDurationSec, 10);
    const empty = svc.buildDerivativesOfMasterFilter(baseAd({ platformFormat: 'pmax_video_9_16', videoDurationSec: null }));
    assert.strictEqual(empty.videoDurationSec, null);
    const blank = svc.buildDerivativesOfMasterFilter(baseAd({ platformFormat: 'pmax_video_9_16', videoDurationSec: '' }));
    assert.strictEqual(blank.videoDurationSec, null);
  });

  check('B24 Meta filter does NOT join videoDurationSec', () => {
    const filter = svc.buildDerivativesOfMasterFilter(baseAd({ platformFormat: 'meta_stories_9_16', videoDurationSec: 10 }));
    assert.ok(filter);
    assert.ok(!Object.prototype.hasOwnProperty.call(filter, 'videoDurationSec'),
      'Meta duration is not identity; joining it would under-match a family');
  });

  check('B25 [STRUCT] duration join uses imported isGooglePmaxVideoFormat, not a local format-set', () => {
    const src = fs.readFileSync(SVC, 'utf8');
    const cagsSrc = fs.readFileSync(CAGS, 'utf8');
    assert.ok(/isGooglePmaxVideoFormat/.test(src), 'adRegenerateService must call isGooglePmaxVideoFormat');
    assert.ok(/isGooglePmaxVideoFormat/.test(src.split('require(\'./campaignAdsGenerationService\')')[0]),
      'isGooglePmaxVideoFormat must be imported from campaignAdsGenerationService');
    assert.ok(/function isGooglePmaxVideoFormat\(platformFormat\)/.test(cagsSrc));
    assert.ok(/isGooglePmaxVideoFormat/.test(cagsSrc.slice(cagsSrc.indexOf('module.exports'))),
      'campaignAdsGenerationService must export isGooglePmaxVideoFormat');
    const start = src.indexOf('function buildDerivativesOfMasterFilter');
    const end = src.indexOf('async function findDerivativesOfMaster');
    assert.ok(start !== -1 && end > start, 'could not isolate buildDerivativesOfMasterFilter');
    const filterFn = src.slice(start, end);
    assert.ok(/isGooglePmaxVideoFormat\(masterAd\.platformFormat\)/.test(filterFn));
    assert.ok(!/pmax_video_9_16/.test(filterFn),
      'filter builder must not duplicate the PMax format-set; got a local pmax_video_9_16');
  });

  await checkAsync('B26 [BLOCKER 1] a sibling with a different ctaUrl is excluded', async () => {
    const master = baseAd({ _id: 'm0000000000000000000000', deriveFromMaster: null, ctaUrl: 'https://brand.example/a', veoVideoUrl: 'https://m1' });
    const sameFamily = baseAd({ _id: 's1000000000000000000000', deriveFromMaster: master.platformFormat, ctaUrl: 'https://brand.example/a' });
    const otherUrl = baseAd({ _id: 'sI000000000000000000000', deriveFromMaster: master.platformFormat, ctaUrl: 'https://brand.example/b' });
    AdCol = new MiniCollection([master, sameFamily, otherUrl]);
    stub(AD, { find: (f) => AdCol.find(f), findById: (id) => AdCol.findById(id), updateOne: (f, u) => AdCol.updateOne(f, u) });
    const filter = svc.buildDerivativesOfMasterFilter(master);
    assert.ok(filter);
    assert.strictEqual(filter.ctaUrl, 'https://brand.example/a');
    const found = await svc.findDerivativesOfMaster(master);
    assert.deepStrictEqual(found.map((d) => d._id), ['s1000000000000000000000']);
  });

  await checkAsync('B27 [BLOCKER 1] a sibling with a different ctaUrlParams is excluded', async () => {
    const master = baseAd({ _id: 'm0000000000000000000000', deriveFromMaster: null, ctaUrlParams: 'utm_source=ig', veoVideoUrl: 'https://m1' });
    const sameFamily = baseAd({ _id: 's1000000000000000000000', deriveFromMaster: master.platformFormat, ctaUrlParams: 'utm_source=ig' });
    const otherParams = baseAd({ _id: 'sJ000000000000000000000', deriveFromMaster: master.platformFormat, ctaUrlParams: 'utm_source=fb' });
    AdCol = new MiniCollection([master, sameFamily, otherParams]);
    stub(AD, { find: (f) => AdCol.find(f), findById: (id) => AdCol.findById(id), updateOne: (f, u) => AdCol.updateOne(f, u) });
    const filter = svc.buildDerivativesOfMasterFilter(master);
    assert.ok(filter);
    assert.strictEqual(filter.ctaUrlParams, 'utm_source=ig');
    const found = await svc.findDerivativesOfMaster(master);
    assert.deepStrictEqual(found.map((d) => d._id), ['s1000000000000000000000']);
  });

  await checkAsync('B28 [BLOCKER 1] a sibling with a different videoPromptGuidance is excluded', async () => {
    const master = baseAd({ _id: 'm0000000000000000000000', deriveFromMaster: null, videoPromptGuidance: 'slow pan left', veoVideoUrl: 'https://m1' });
    const sameFamily = baseAd({ _id: 's1000000000000000000000', deriveFromMaster: master.platformFormat, videoPromptGuidance: 'slow pan left' });
    const otherGuidance = baseAd({ _id: 'sK000000000000000000000', deriveFromMaster: master.platformFormat, videoPromptGuidance: 'fast push-in' });
    AdCol = new MiniCollection([master, sameFamily, otherGuidance]);
    stub(AD, { find: (f) => AdCol.find(f), findById: (id) => AdCol.findById(id), updateOne: (f, u) => AdCol.updateOne(f, u) });
    const filter = svc.buildDerivativesOfMasterFilter(master);
    assert.ok(filter);
    assert.strictEqual(filter.videoPromptGuidance, 'slow pan left');
    const found = await svc.findDerivativesOfMaster(master);
    assert.deepStrictEqual(found.map((d) => d._id), ['s1000000000000000000000']);
  });

  await checkAsync('B29 [BLOCKER 2] missing campaignId returns [] AND never queries (BSON would drop the key)', async () => {
    const master = baseAd({ _id: 'm0000000000000000000000', campaignId: undefined, deriveFromMaster: null, veoVideoUrl: 'https://m1' });
    const wouldMatchIfDropped = baseAd({ _id: 's1000000000000000000000', deriveFromMaster: 'meta_stories_9_16' });
    AdCol = new MiniCollection([master, wouldMatchIfDropped]);
    stub(AD, { find: (f) => AdCol.find(f), findById: (id) => AdCol.findById(id), updateOne: (f, u) => AdCol.updateOne(f, u) });
    assert.strictEqual(svc.buildDerivativesOfMasterFilter(master), null);
    let findCalled = false;
    const origFind = AdCol.find.bind(AdCol);
    AdCol.find = (f) => { findCalled = true; return origFind(f); };
    const found = await svc.findDerivativesOfMaster(master);
    assert.strictEqual(found.length, 0);
    assert.strictEqual(findCalled, false, 'must not query at all — BSON drops campaignId:undefined and would match every video ad of this product/format, including other families');
  });

  await checkAsync('B30 [BLOCKER 2] missing productId returns [] AND never queries (BSON would drop the key)', async () => {
    const master = baseAd({ _id: 'm0000000000000000000000', productId: undefined, deriveFromMaster: null, veoVideoUrl: 'https://m1' });
    const wouldMatchIfDropped = baseAd({ _id: 's1000000000000000000000', deriveFromMaster: 'meta_stories_9_16' });
    AdCol = new MiniCollection([master, wouldMatchIfDropped]);
    stub(AD, { find: (f) => AdCol.find(f), findById: (id) => AdCol.findById(id), updateOne: (f, u) => AdCol.updateOne(f, u) });
    assert.strictEqual(svc.buildDerivativesOfMasterFilter(master), null);
    let findCalled = false;
    const origFind = AdCol.find.bind(AdCol);
    AdCol.find = (f) => { findCalled = true; return origFind(f); };
    const found = await svc.findDerivativesOfMaster(master);
    assert.strictEqual(found.length, 0);
    assert.strictEqual(findCalled, false, 'must not query at all — BSON drops productId:undefined and would match every video ad of this campaign/format, including other families');
  });

  await checkAsync('B31 [BLOCKER 2] mediaId == null with empty referenceMediaIds returns [] AND never queries', async () => {
    const master = baseAd({
      _id: 'm0000000000000000000000',
      mediaId: null,
      referenceMediaIds: [],
      deriveFromMaster: null,
      veoVideoUrl: 'https://m1'
    });
    const wouldMatchIfDropped = baseAd({ _id: 's1000000000000000000000', deriveFromMaster: 'meta_stories_9_16' });
    AdCol = new MiniCollection([master, wouldMatchIfDropped]);
    stub(AD, { find: (f) => AdCol.find(f), findById: (id) => AdCol.findById(id), updateOne: (f, u) => AdCol.updateOne(f, u) });
    assert.strictEqual(svc.buildDerivativesOfMasterFilter(master), null);
    let findCalled = false;
    const origFind = AdCol.find.bind(AdCol);
    AdCol.find = (f) => { findCalled = true; return origFind(f); };
    const found = await svc.findDerivativesOfMaster(master);
    assert.strictEqual(found.length, 0);
    assert.strictEqual(findCalled, false, 'must not query at all — a master with no media identity would otherwise match every same-campaign/product/format video derive');
  });

  // ═══════════════════════════════════════════════════════════════════
  // GROUP C — recascadeDerivativeSibling — THIS REPO CANNOT COMPOSITE A
  // SIBLING AT ALL (no titling since abf7e0c2) — see the function's own
  // doc comment. A TITLED sibling (renderUrl !== veoVideoUrl) is
  // provenance-only: veoVideoUrl updates, renderUrl/posterUrl/status stay.
  // An INHERITED sibling (renderUrl === veoVideoUrl, the mint-time
  // derive shape) updates BOTH so the equality invariant holds.
  // qcAndStampVideoAd/promoteFailedToDraft are NEVER called on a sibling.
  // ═══════════════════════════════════════════════════════════════════
  function freshMaster(over = {}) {
    return baseAd({ _id: 'm0000000000000000000000', veoVideoUrl: 'https://new.example/master-v2', veoAspectRatio: '9:16', platformFormat: 'meta_stories_9_16', ...over });
  }

  await checkAsync('C1 [MONEY/INTEGRITY] updates provenance, clears stale basePlate, and NEVER writes renderUrl/posterUrl/status', async () => {
    const master = freshMaster();
    const sibling = baseAd({ _id: 's1000000000000000000000', deriveFromMaster: master.platformFormat, veoVideoUrl: 'https://old.example/sibling-v1', renderUrl: 'https://old.example/titled-sibling-v1.mp4', basePlate: { sourceUrl: 'https://old.example/sibling-v1' }, status: 'live' });
    AdCol = new MiniCollection([master, sibling]);
    stub(AD, { find: (f) => AdCol.find(f), findById: (id) => AdCol.findById(id), updateOne: (f, u) => AdCol.updateOne(f, u) });
    await svc.recascadeDerivativeSibling(sibling, master);
    const after = await AdCol.findById(sibling._id).lean();
    assert.strictEqual(after.veoVideoUrl, master.veoVideoUrl, 'provenance DOES update');
    assert.strictEqual(after.veoModel, `derive-from:${master.platformFormat}`);
    assert.strictEqual(after.basePlate, undefined, 'a stale crop-rect from a DIFFERENT video must not survive');
    assert.strictEqual(after.renderUrl, 'https://old.example/titled-sibling-v1.mp4', 'this repo cannot composite — the titled, already-live renderUrl must NEVER be replaced with the raw master');
    assert.strictEqual(after.status, 'live', 'status must never move — nothing was actually delivered for this sibling');
  });

  await checkAsync('C2 [MONEY/INTEGRITY] a sibling claimed by another process between find() and write is skipped, not overwritten (CAS)', async () => {
    const master = freshMaster();
    const sibling = baseAd({ _id: 's1000000000000000000000', deriveFromMaster: master.platformFormat, veoVideoUrl: 'https://old.example/sibling-v1', claimedByWorker: 'renderer-x' /* claimed AFTER the find() this test skips straight to the write */ });
    AdCol = new MiniCollection([master, sibling]);
    stub(AD, { find: (f) => AdCol.find(f), findById: (id) => AdCol.findById(id), updateOne: (f, u) => AdCol.updateOne(f, u) });
    await svc.recascadeDerivativeSibling(sibling, master);
    const after = await AdCol.findById(sibling._id).lean();
    assert.strictEqual(after.veoVideoUrl, 'https://old.example/sibling-v1', 'the CAS write must not have matched a now-claimed row');
  });

  await checkAsync('C3 never calls promoteFailedToDraft on a sibling (nothing was actually delivered)', async () => {
    const master = freshMaster();
    const sibling = baseAd({ _id: 's1000000000000000000000', deriveFromMaster: master.platformFormat, status: 'failed' });
    AdCol = new MiniCollection([master, sibling]);
    stub(AD, { find: (f) => AdCol.find(f), findById: (id) => AdCol.findById(id), updateOne: (f, u) => AdCol.updateOne(f, u) });
    await svc.recascadeDerivativeSibling(sibling, master);
    const after = await AdCol.findById(sibling._id).lean();
    assert.strictEqual(after.status, 'failed', 'a still-failed sibling must stay failed — this repo did not fix anything for it');
  });

  await checkAsync('C4 a per-sibling failure never throws out of recascadeDerivativeSibling (master regenerate unaffected)', async () => {
    const master = freshMaster();
    const sibling = baseAd({ _id: 's1000000000000000000000', deriveFromMaster: master.platformFormat });
    AdCol = new MiniCollection([master, sibling]);
    // Mutate the LIVE collection's method in place — the same pattern as A6.
    // Re-stubbing require.cache[AD] does NOT rebind adRegenerateService's
    // `const Ad = require(...)` captured at install(); that previous C4
    // was vacuous (the throw never reached the code under test).
    let hit = false;
    AdCol.updateOne = async () => {
      hit = true;
      throw new Error('simulated DB error on the CAS write');
    };
    await svc.recascadeDerivativeSibling(sibling, master); // must not throw
    assert.ok(hit, 'AdCol.updateOne must actually be reached — a stub that never fires makes this check vacuous');
  });

  await checkAsync('C5 [BLOCKER] an inherited sibling (renderUrl === veoVideoUrl) updates BOTH to the new plate', async () => {
    const master = freshMaster();
    const oldPlate = 'https://old.example/inherited-plate.mp4';
    const sibling = baseAd({
      _id: 's1000000000000000000000',
      deriveFromMaster: master.platformFormat,
      veoVideoUrl: oldPlate,
      renderUrl: oldPlate,
      status: 'draft'
    });
    AdCol = new MiniCollection([master, sibling]);
    await svc.recascadeDerivativeSibling(sibling, master);
    const after = await AdCol.findById(sibling._id).lean();
    assert.strictEqual(after.veoVideoUrl, master.veoVideoUrl, 'inherited veoVideoUrl must move to the new plate');
    assert.strictEqual(after.renderUrl, master.veoVideoUrl, 'inherited renderUrl must move with it (mint-time invariant)');
    assert.strictEqual(after.renderUrl, after.veoVideoUrl, 'renderUrl === veoVideoUrl must still hold after cascade');
    assert.strictEqual(after.status, 'draft', 'status must not move');
  });

  await checkAsync('C6 [RACE] an inherited snapshot whose DB row was titled between find() and write is skipped', async () => {
    const master = freshMaster();
    const oldPlate = 'https://old.example/inherited-plate.mp4';
    const titledUrl = 'https://old.example/just-titled-sibling.mp4';
    const snapshot = baseAd({
      _id: 's1000000000000000000000',
      deriveFromMaster: master.platformFormat,
      veoVideoUrl: oldPlate,
      renderUrl: oldPlate
    });
    const dbRow = { ...snapshot, renderUrl: titledUrl };
    AdCol = new MiniCollection([master, dbRow]);
    await svc.recascadeDerivativeSibling(snapshot, master);
    const after = await AdCol.findById(snapshot._id).lean();
    assert.strictEqual(after.renderUrl, titledUrl, 'must not overwrite a concurrently-titled renderUrl with the raw plate');
    assert.strictEqual(after.veoVideoUrl, oldPlate, 'CAS miss must leave provenance untouched too');
  });

  // ═══════════════════════════════════════════════════════════════════
  // GROUP D — cascadeRegenerateToDerivatives (end-to-end)
  // ═══════════════════════════════════════════════════════════════════
  await checkAsync('D1 cascades provenance to an eligible sibling and leaves an ineligible (claimed) one untouched', async () => {
    const master = freshMaster({ status: 'draft' });
    const eligible = baseAd({ _id: 's1000000000000000000000', deriveFromMaster: master.platformFormat, status: 'failed', veoVideoUrl: 'https://old.example/s1' });
    const claimed = baseAd({ _id: 's2000000000000000000000', deriveFromMaster: master.platformFormat, status: 'failed', claimedByWorker: 'renderer-x', veoVideoUrl: 'https://old.example/s2' });
    AdCol = new MiniCollection([master, eligible, claimed]);
    stub(AD, { find: (f) => AdCol.find(f), findById: (id) => AdCol.findById(id), updateOne: (f, u) => AdCol.updateOne(f, u) });
    await svc.cascadeRegenerateToDerivatives(master._id);
    const afterEligible = await AdCol.findById(eligible._id).lean();
    const afterClaimed  = await AdCol.findById(claimed._id).lean();
    assert.strictEqual(afterEligible.veoVideoUrl, master.veoVideoUrl, 'the eligible sibling\'s provenance must update');
    assert.strictEqual(afterEligible.status, 'failed', 'status must NOT be promoted — this repo delivered nothing new');
    assert.strictEqual(afterClaimed.veoVideoUrl, 'https://old.example/s2', 'a claimed sibling must be left alone this pass');
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

  await checkAsync('D6 [MONEY] a master with a real QC-FAILED visionQc never fans out to siblings', async () => {
    const master = freshMaster({ status: 'failed', visionQc: { passed: false, skipped: false, disabled: false, attempts: [{ summary: 'sim' }] } });
    const sibling = baseAd({ _id: 's1000000000000000000000', deriveFromMaster: master.platformFormat, veoVideoUrl: 'https://old.example/s1', status: 'live' });
    AdCol = new MiniCollection([master, sibling]);
    stub(AD, { find: (f) => AdCol.find(f), findById: (id) => AdCol.findById(id), updateOne: (f, u) => AdCol.updateOne(f, u) });
    await svc.cascadeRegenerateToDerivatives(master._id);
    const after = await AdCol.findById(sibling._id).lean();
    assert.strictEqual(after.veoVideoUrl, 'https://old.example/s1', 'a REJECTED master plate must never fan out to a live sibling');
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
    // Skip default-arg object literals (`opts = {}`) so we extract the
    // function BODY brace, not a parameter initializer.
    let i = m.index + m[0].length - 1;
    let depth = 0;
    let inParams = true;
    for (; i < SRC.length; i++) {
      const ch = SRC[i];
      if (inParams) {
        if (ch === '(') depth++;
        else if (ch === ')') { depth--; if (depth === 0) inParams = false; }
        continue;
      }
      if (ch === '{') break;
    }
    const body = balanced(SRC, i, '{', '}');
    assert.ok(body, `unterminated function body for ${signatureRe}`);
    return body;
  }
  const FORBIDDEN = /veoService|atlasVideoService|atlasImageService|generateForAd|prepareStoryboard|submitGeneration|directImageRenderService/;

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
  check('E5 [MONEY] cascadeRegenerateToDerivatives re-derives its own qcJustFailed gate (defense in depth against a future standalone caller)', () => {
    const body = functionBody(/async function cascadeRegenerateToDerivatives\(/);
    assert.ok(/buildVideoQcFailureFields\(masterAd\.visionQc\)/.test(body), 'the internal qcJustFailed re-derivation must be present');
  });
  check('E6 [MONEY/INTEGRITY] recascadeDerivativeSibling writes renderUrl ONLY on the inherited branch; never writes posterUrl', () => {
    const body = functionBody(/async function recascadeDerivativeSibling\(/);
    assert.ok(/stillInherited/.test(body), 'must name the inherited/titled branch');
    assert.ok(/sibling\.renderUrl === sibling\.veoVideoUrl/.test(body),
      'must branch on the mint-time renderUrl === veoVideoUrl invariant');
    assert.ok(/\$set\.renderUrl\s*=\s*masterAd\.veoVideoUrl/.test(body),
      'inherited branch must stamp renderUrl to the new master plate');
    assert.ok(!/posterUrl\s*:/.test(body) && !/\$set\.posterUrl/.test(body),
      'must never stamp posterUrl (provenance update, no compositing in this repo)');
  });
  check('E7 [MONEY/INTEGRITY] recascadeDerivativeSibling never calls qcAndStampVideoAd or promoteFailedToDraft on a sibling', () => {
    const body = functionBody(/async function recascadeDerivativeSibling\(/);
    assert.ok(!/qcAndStampVideoAd/.test(body), 'qcAndStampVideoAd has no preserveAdStatus concept — must never run on a sibling');
    assert.ok(!/promoteFailedToDraft/.test(body), 'nothing is actually delivered for a sibling here — must never promote its status');
  });
  check('E8 [MONEY/INTEGRITY] the sibling CAS write re-asserts siblingStillEligible, not a bare {_id}', () => {
    const body = functionBody(/async function recascadeDerivativeSibling\(/);
    assert.ok(/siblingStillEligible\(sibling\)/.test(body), 'the write must re-assert the same exclusion filter as the read, not a plain {_id}');
  });

  // Real require-graph BFS — same recipe as verifyTitlingResumeNeverResubmits.js.
  // Starting from adRegenerateService.js itself is vacuous (that file
  // requires videoRouter for runVideoFull). The cascade's only heavy callee
  // is brandScriptExecutor (buildVideoQcFailureFields; adgen also calls
  // renderBrandScriptAndSave). If THAT graph can reach a billable submit
  // module, a cascade can spend.
  function parseRequireSpecs(src) {
    const specs = [];
    const re = /require\(\s*(['"])((?:(?!\1).)+)\1\s*\)/g;
    let m;
    while ((m = re.exec(src))) specs.push(m[2]);
    return specs;
  }
  function bfsRequireGraph(entryFiles) {
    const visited = new Set();
    const queue = [...entryFiles].map((f) => fs.realpathSync(f));
    const edges = [];
    while (queue.length) {
      const file = queue.shift();
      if (visited.has(file)) continue;
      visited.add(file);
      let src;
      try { src = fs.readFileSync(file, 'utf8'); } catch { continue; }
      for (const spec of parseRequireSpecs(src)) {
        if (!spec.startsWith('.')) continue;
        let resolved;
        try { resolved = fs.realpathSync(require.resolve(spec, { paths: [path.dirname(file)] })); }
        catch { continue; }
        edges.push({ from: file, to: resolved });
        if (!visited.has(resolved)) queue.push(resolved);
      }
    }
    return { visited, edges };
  }
  const ATLAS_VIDEO = fs.realpathSync(path.join(ROOT, 'services', 'atlasVideoService.js'));
  const ATLAS_IMAGE = fs.realpathSync(path.join(ROOT, 'services', 'atlasImageService.js'));
  const VIDEO_ROUTER = fs.realpathSync(path.join(ROOT, 'services', 'videoRouter.js'));
  const DIRECT_IMAGE = fs.realpathSync(path.join(ROOT, 'services', 'directImageRenderService.js'));

  check('E9 [MONEY][POSITIVE CONTROL] BFS from adRegenerateService.js DOES reach atlasVideoService (via videoRouter)', () => {
    const { visited } = bfsRequireGraph([SVC]);
    assert.ok(visited.has(ATLAS_VIDEO), 'positive control: if this misses atlasVideoService, E10-E12 are vacuous');
  });
  check('E10 [MONEY] brandScriptExecutor.js require-graph never reaches atlasVideoService / atlasImageService / videoRouter / directImageRenderService', () => {
    const { visited } = bfsRequireGraph([BSE]);
    assert.ok(visited.size > 5, `graph looks too small (${visited.size}) — resolver may be broken`);
    assert.ok(!visited.has(ATLAS_VIDEO), 'brandScriptExecutor must not reach atlasVideoService');
    assert.ok(!visited.has(ATLAS_IMAGE), 'brandScriptExecutor must not reach atlasImageService');
    assert.ok(!visited.has(VIDEO_ROUTER), 'brandScriptExecutor must not reach videoRouter');
    assert.ok(!visited.has(DIRECT_IMAGE), 'brandScriptExecutor must not reach directImageRenderService');
  });
  check('E11 [MONEY] cascade function bodies never name atlasImageService / directImageRenderService / submitGeneration', () => {
    for (const re of [
      /async function findDerivativesOfMaster\(/,
      /async function recascadeDerivativeSibling\(/,
      /async function cascadeRegenerateToDerivatives\(/
    ]) {
      const body = functionBody(re);
      assert.ok(!/atlasImageService|directImageRenderService|submitGeneration/.test(body), body);
    }
  });
  check('E12 canvas-titling path is a documented latent landmine, not asserted permanently dead', () => {
    const bseSrc = fs.readFileSync(BSE, 'utf8');
    assert.ok(/restore when re-enabling the canvas path/.test(bseSrc),
      'resolveTitlingEngine is hard-wired to remotion; recascadeDerivativeSibling not calling qcAndStampVideoAd is true TODAY because of that kill switch — do not claim the canvas path is permanently dead');
  });

  // ═══════════════════════════════════════════════════════════════════
  // GROUP F — runVideoFull tail (fresh verdict, promote, cascade)
  // ═══════════════════════════════════════════════════════════════════
  const dummyProgress = { checkpoint: async () => {}, stage() {} };

  function bindAd() {
    stub(AD, { find: (f) => AdCol.find(f), findById: (id) => AdCol.findById(id), updateOne: (f, u) => AdCol.updateOne(f, u) });
  }

  await checkAsync('F1 [TAIL] successful regen of a failed master promotes it and recascades a same-family sibling', async () => {
    const master = baseAd({ _id: 'a0000000000000000000000', status: 'failed', deriveFromMaster: null, veoVideoUrl: 'https://old.example/m', visionQc: { passed: false, skipped: false, disabled: false } });
    const sibling = baseAd({ _id: 's1000000000000000000000', deriveFromMaster: master.platformFormat, status: 'draft', veoVideoUrl: 'https://old.example/s1' });
    AdCol = new MiniCollection([master, sibling]);
    bindAd();
    bseState.visionQc = { passed: true, skipped: false, disabled: false };
    bseState.swallowQc = false;
    bseCalls = [];
    await svc.runVideoFull(master._id, null, dummyProgress);
    const afterMaster = await AdCol.findById(master._id).lean();
    const afterSibling = await AdCol.findById(sibling._id).lean();
    assert.strictEqual(afterMaster.status, 'draft', 'failed → draft on a genuine success');
    assert.strictEqual(afterSibling.veoVideoUrl, 'https://new.example/omni-master.mp4', 'same-family sibling provenance must update');
  });

  await checkAsync('F2 [TAIL] a real QC failure does not promote and does not cascade', async () => {
    const master = baseAd({ _id: 'a0000000000000000000000', status: 'failed', deriveFromMaster: null, veoVideoUrl: 'https://old.example/m' });
    const sibling = baseAd({ _id: 's1000000000000000000000', deriveFromMaster: master.platformFormat, veoVideoUrl: 'https://old.example/s1' });
    AdCol = new MiniCollection([master, sibling]);
    bindAd();
    bseState.visionQc = { passed: false, skipped: false, disabled: false, attempts: [{ summary: 'sim' }] };
    bseState.swallowQc = false;
    await svc.runVideoFull(master._id, null, dummyProgress);
    const afterMaster = await AdCol.findById(master._id).lean();
    const afterSibling = await AdCol.findById(sibling._id).lean();
    assert.strictEqual(afterMaster.status, 'failed');
    assert.strictEqual(afterSibling.veoVideoUrl, 'https://old.example/s1', 'rejected plate must not fan out');
  });

  await checkAsync('F3 [TAIL] swallowed QC (no fresh verdict) is fail-closed: no promote, no cascade, even if prior visionQc was a pass', async () => {
    const master = baseAd({
      _id: 'a0000000000000000000000',
      status: 'failed',
      deriveFromMaster: null,
      veoVideoUrl: 'https://old.example/m',
      visionQc: { passed: true, skipped: false, disabled: false }
    });
    const sibling = baseAd({ _id: 's1000000000000000000000', deriveFromMaster: master.platformFormat, veoVideoUrl: 'https://old.example/s1' });
    AdCol = new MiniCollection([master, sibling]);
    bindAd();
    bseState.swallowQc = true;
    await svc.runVideoFull(master._id, null, dummyProgress);
    bseState.swallowQc = false;
    const afterMaster = await AdCol.findById(master._id).lean();
    const afterSibling = await AdCol.findById(sibling._id).lean();
    assert.strictEqual(afterMaster.status, 'failed', 'must not promote off a stale prior pass');
    assert.strictEqual(afterSibling.veoVideoUrl, 'https://old.example/s1', 'must not cascade with no fresh verdict');
  });

  await checkAsync('F4 [TAIL] a cross-family sibling (different mediaId) is not recascaded by runVideoFull', async () => {
    const master = baseAd({ _id: 'a0000000000000000000000', status: 'failed', deriveFromMaster: null, mediaId: 'family-1', veoVideoUrl: 'https://old.example/m' });
    const otherFamily = baseAd({ _id: 'sD000000000000000000000', deriveFromMaster: master.platformFormat, mediaId: 'family-2', veoVideoUrl: 'https://old.example/other' });
    AdCol = new MiniCollection([master, otherFamily]);
    bindAd();
    bseState.visionQc = { passed: true, skipped: false, disabled: false };
    bseState.swallowQc = false;
    await svc.runVideoFull(master._id, null, dummyProgress);
    const afterOther = await AdCol.findById(otherFamily._id).lean();
    assert.strictEqual(afterOther.veoVideoUrl, 'https://old.example/other');
  });

  await checkAsync('F5 operator cancel mid-cascade is rethrown (does not swallow CancelledError)', async () => {
    const master = freshMaster({ status: 'draft', veoVideoUrl: 'https://new.example/master-v2' });
    const sibling = baseAd({ _id: 's1000000000000000000000', deriveFromMaster: master.platformFormat, veoVideoUrl: 'https://old.example/s1' });
    AdCol = new MiniCollection([master, sibling]);
    bindAd();
    const cancelErr = Object.assign(new Error('Operation cancelled'), { name: 'CancelledError', code: 'CANCELLED' });
    let threw = false;
    try {
      await svc.cascadeRegenerateToDerivatives(master._id, {
        progressRun: { checkpoint: async () => { throw cancelErr; } }
      });
    } catch (err) {
      threw = err === cancelErr || err.name === 'CancelledError';
    }
    assert.ok(threw, 'CancelledError must propagate so the caller can settle the run as cancelled');
  });

  console.log(`\n${checks} passed, ${failures.length} failed\n`);
  if (failures.length) process.exit(1);
})();
