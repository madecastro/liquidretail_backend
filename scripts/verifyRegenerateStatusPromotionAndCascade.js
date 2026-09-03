#!/usr/bin/env node
'use strict';
//
// verifyRegenerateStatusPromotionAndCascade — pins TWO coordinated fixes to
// src/services/adRegenerateService.js (2026-09-02), hardened by two
// independent adversarial Grok passes (both --effort high) that found real
// bugs in the FIRST version of this diff — see the file's own comments for
// the full reasoning; this header only summarises what's pinned.
//
//  FIX 1 — promoteFailedToDraft: a genuinely successful regenerate promotes
//    a previously-'failed' ad to 'draft'. It must NEVER touch 'draft' /
//    'live' / 'archived'.
//
//  FIX 2 — cascadeRegenerateToDerivatives / findDerivativesOfMaster /
//    recascadeDerivativeSibling: after a master ad's video regenerate
//    succeeds, its same-identity derivative siblings (deriveFromMaster ===
//    the master's own platformFormat AND the rest of
//    computeDeterministicVideoDigest's identity: mediaId/referenceMediaIds,
//    CTA, prompt fields) are re-composited from the NEW master plate, with
//    ZERO Atlas/Omni spend, structurally. Not "free" unqualified: each
//    sibling still costs face-detect + vision-QC + Remotion + Cloudinary,
//    and the cascade is capped (MAX_CASCADE_SIBLINGS).
//
// ADVERSARIAL FINDINGS THIS VERSION CLOSES:
//   - the cascade fanned out a REJECTED plate: no gate on the master's own
//     QC verdict. Now gated on a FRESH !qcJustFailed at the call site AND
//     inside cascadeRegenerateToDerivatives itself (defense in depth).
//   - the sibling write was a plain {_id} updateOne — a TOCTOU window let a
//     concurrent renderer/titler/retitle claim on the SAME row be clobbered.
//     Now a CAS: siblingStillEligible() re-asserts every find() exclusion
//     as the update's OWN filter; a 0-match result means "someone else
//     touched this row" and the sibling is skipped, not overwritten.
//   - the exclusion filter missed two "claim released, work still owed"
//     shapes (titlingNeeded:true+claimedByWorker:null; status:'rendering'/
//     'queued' after a derive-wait requeue) and never excluded 'archived'.
//     All four are covered now, and reused verbatim between find() and the
//     CAS write via siblingStillEligible().
//   - campaignRunIds scoping (added in an earlier hardening pass) UNDER-
//     matched legitimate later-run same-family siblings and was REMOVED.
//     Do NOT restore it. The unique (campaignId, identityDigest) index
//     does NOT make campaignId+productId+deriveFromMaster a complete
//     family key — the digest also hashes seed media + CTA + prompts, so
//     a second Generate with a different seed mints a second master
//     family whose derives stamp the identical deriveFromMaster. The
//     filter now joins those identity fields. (An earlier header claimed
//     campaignRunIds scoping was in place; that was stale relative to the
//     code, which already asserted the opposite in B1.)
//   - undefined masterAd.platformFormat used to drop deriveFromMaster
//     from the Mongo wire (BSON ignoreUndefined) and match every video
//     ad in the campaign+product, including other paid masters. Guarded
//     in buildDerivativeFindFilter; proven against a real BSON
//     round-trip, not miniMongoStub (the stub treats undefined as a
//     matchable value and cannot reproduce the drop).
//   - THE SEVERE ONE: the sibling write stamped renderUrl (and later
//     posterUrl via a titled path) — sometimes the RAW, uncropped,
//     untitled master plate — onto an ALREADY-LIVE ad. renderUrl/posterUrl
//     are now written ONLY atomically together with a genuine composite.
//   - qcAndStampVideoAd, called on a sibling with no preserveAdStatus
//     concept, could flip an untouched live sibling to status:'failed'.
//     No longer called on that fallback path. LATENT: this is true today
//     because resolveTitlingEngine is hard-wired to remotion; the
//     commented canvas path would re-enter qcAndStampVideoAd via
//     renderBrandScriptAndSave's non-remotion branch.
//   - runVideoFull's retitleMode = (priorStatus !== 'failed') expansion
//     was REVERTED (QC-quarantine / titling-resume / incomplete-branch
//     defects). recascadeDerivativeSibling still passes retitleMode:true
//     (original already-shipped-ad contract). The "regenerate of a live
//     ad silently un-publishes it" bug is REAL, still live, and a
//     documented follow-up — this harness does not pin it as correct.
//   - cascade runs AFTER markComplete, outside the 45-min
//     regenerateClaimedAt window.
//
// WHY EXECUTION, NOT JUST SOURCE TEXT. A regex can see the words
// `status: 'failed'` exist near an updateOne somewhere. It cannot tell a
// scoped promotion (filtered on status:'failed' in the query itself) from
// an unconditional stamp, and it cannot prove a CAS filter is actually
// re-asserted at the write site rather than only at the read. Groups A-D
// below call the REAL exported functions against scripts/lib/miniMongoStub.js
// (real query/update semantics — $ne, $in, $nin, $set, $unset — not a
// hand-waved reimplementation) and assert on the ACTUAL persisted documents
// afterward.
//
// Group E is the money invariant proper: a real require-graph BFS
// (Node's own require.resolve, same pattern as
// verifyTitlingResumeNeverResubmits.js) from brandScriptExecutor.js
// (the only heavy callee of recascadeDerivativeSibling) plus a
// body-text belt on the three functions, covering atlasVideoService /
// atlasImageService / directImageRenderService / generateForAd /
// prepareStoryboard / submitGeneration. A file-level BFS from
// adRegenerateService.js itself would be vacuous (runVideoFull in the
// same file legitimately requires videoRouter). Positive control: that
// file-level BFS DOES reach videoRouter.
//
// Revert-prove — mutations confirmed to fail this harness:
//   promoteFailedToDraft loses its status:'failed' filter clause     → A2-A4
//   findDerivativesOfMaster drops any exclusion clause               → B2-B10
//   findDerivativesOfMaster fails to exclude the master's own document → B11
//   the sibling CAS write loses the re-asserted exclusion filter     → C2
//   recascadeDerivativeSibling writes renderUrl on the no-composite path → C3-C5
//   recascadeDerivativeSibling calls qcAndStampVideoAd on a sibling
//     (would flip status on an untouched row)                       → C3-C5
//   cascadeRegenerateToDerivatives loses its qcJustFailed gate       → D6
//   cascadeRegenerateToDerivatives fails to skip a derivative master → D4
//   a submit helper becomes reachable from cascade callees            → E
//   identity-family join dropped (cross-family derive matches)        → B12
//   a single identity-join field dropped (ctaUrl / params / prompts /
//     referenceMediaIds)                                              → B12b-B12g
//   PMax videoDurationSec join dropped (10s master recascades a 12s
//     different-family derive sharing deriveFromMaster)               → B18
//   duration join widened to Meta (under-matches same-family 10s/12s) → B18b
//   platformFormat guard dropped (filter is non-null / BSON-drops)    → B13-B15
//   runVideoFull retitleMode reintroduced                             → F5
//   cascade moved back inside runVideoFull (before markComplete)      → F6
//
// Pure + offline: no DB, no network, no API keys. Run:
//   node scripts/verifyRegenerateStatusPromotionAndCascade.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { MiniCollection } = require('./lib/miniMongoStub');

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
const SVC   = path.join(ROOT, 'src', 'services', 'adRegenerateService.js');
const AD    = path.join(ROOT, 'src', 'models', 'Ad.js');
const MEDIA = path.join(ROOT, 'src', 'models', 'Media.js');
const BRAND = path.join(ROOT, 'src', 'models', 'Brand.js');
const RUN   = path.join(ROOT, 'src', 'models', 'CampaignRun.js');
const VEO   = path.join(ROOT, 'src', 'services', 'videoRouter.js');
const BSE   = path.join(ROOT, 'src', 'services', 'brandScriptExecutor.js');
const CLOUD = path.join(ROOT, 'src', 'services', 'cloudinaryService.js');
const DI    = path.join(ROOT, 'src', 'services', 'directImageRenderService.js');
const SUS   = path.join(ROOT, 'src', 'services', 'seededUniverseService.js');
const UGC   = path.join(ROOT, 'src', 'services', 'ugcVideoPipeline.js');
const COST  = path.join(ROOT, 'src', 'services', 'costTracker.js');
const TRS   = path.join(ROOT, 'src', 'services', 'titlingResumeService.js');
const CAGS  = path.join(ROOT, 'src', 'services', 'campaignAdsGenerationService.js');
const PF    = path.join(ROOT, 'src', 'services', 'platformFormats.js');

let AdCol;
let bseCalls;
let bseState;
let veoState;
let findCalls;

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

// This bare worktree has NO node_modules (adgen's own CLAUDE.md: never npm
// ci / NODE_PATH here) — 'mongoose' cannot resolve at all, so file-path
// caching (stub() above) cannot help; Module._resolveFilename throws before
// the cache is ever consulted. Same fix as
// scripts/verifyRegenerateInFlightGate.js's own header explains: intercept
// Module._load for the bare specifier itself.
const mongooseStub = {
  Types: { ObjectId: class ObjectId {
    constructor(v) { this.id = String(v); }
    toString() { return this.id; }
    static isValid() { return true; }
  } }
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'mongoose') return mongooseStub;
  return origLoad.apply(this, arguments);
};

// resolveDeriveFromMaster is stubbed with the same narrow two-signal
// equivalent verifyRegenerateInFlightGate.js uses (explicit marker + the
// PMax 1:1 format) rather than requiring the real
// campaignAdsGenerationService.js — that module pulls several more
// mongoose-Schema-backed models the ObjectId-only stub above cannot satisfy.
function resolveDeriveFromMasterStub(ad) {
  if (!ad) return null;
  if (typeof ad.deriveFromMaster === 'string' && ad.deriveFromMaster) return ad.deriveFromMaster;
  if (ad.platformFormat === 'pmax_video_1_1') return 'pmax_video_9_16';
  return null;
}

// Same format-set the production isGooglePmaxVideoFormat uses
// (GOOGLE_VIDEO_MASTER_SET ∪ {PMAX_VIDEO_DERIVE_ONLY}), read from the
// single definition in platformFormats.js. The harness cannot require
// campaignAdsGenerationService.js (mongoose models). Production still
// calls the exported predicate — pinned by B19.
const platformFormats = require(PF);
function isGooglePmaxVideoFormatStub(platformFormat) {
  const masters = Array.isArray(platformFormats.GOOGLE_VIDEO_MASTERS)
    ? platformFormats.GOOGLE_VIDEO_MASTERS
    : [];
  return masters.includes(platformFormat)
    || platformFormat === platformFormats.PMAX_VIDEO_DERIVE_ONLY_KEY;
}

function install() {
  for (const m of [SVC, AD, MEDIA, BRAND, RUN, VEO, BSE, CLOUD, DI, SUS, UGC, COST, TRS, CAGS]) {
    delete require.cache[m];
  }
  AdCol = new MiniCollection([]);
  findCalls = [];
  stub(AD, {
    find:     (filter) => { findCalls.push(filter); return AdCol.find(filter); },
    findById: (id) => AdCol.findById(id),
    updateOne: (filter, update) => AdCol.updateOne(filter, update)
  });
  // loadBrand() (adRegenerateService.js) is Media.findById(ad.mediaId) then
  // Brand.findById(media.brandId) — keying the whole two-hop resolution off
  // bseState.brandDoc lets each check simply set bseState.brandDoc to
  // control whether the brand-resolved or no-brand branch runs.
  stub(MEDIA, {
    findById: () => ({ select: () => ({ lean: async () => (bseState.brandDoc ? { brandId: 'br00000000000000000000' } : null) }) }),
    exists:   async () => false
  });
  stub(BRAND, { findById: () => ({ select: () => ({ lean: async () => bseState.brandDoc }) }) });
  stub(RUN, { findOne: () => ({ select: () => ({ lean: async () => null }) }) });
  veoState = {
    prepareStoryboard: async () => ({ storyboard: null }),
    generateForAd: async () => ({
      videoUrl: 'https://atlas.example/master.mp4',
      aspectRatio: '9:16',
      prompt: 'p',
      storyboard: null,
      model: 'omni',
      referenceImages: [],
      skipped: false
    })
  };
  stub(VEO, {
    prepareStoryboard: (...a) => veoState.prepareStoryboard(...a),
    generateForAd: (...a) => veoState.generateForAd(...a)
  });
  bseCalls = [];
  bseState = { visionQc: { passed: true, skipped: false, disabled: false }, brandDoc: null, throwOnRender: false, swallowQc: false };
  // buildVideoQcFailureFields mirrors the REAL function's predicate exactly
  // (see brandScriptExecutor.js) — same shape, so a harness assertion that
  // depends on this predicate is exercising the real decision rule.
  const buildVideoQcFailureFields = (visionQc) => {
    const failed = !!visionQc && visionQc.passed === false && !visionQc.skipped && !visionQc.disabled;
    if (!failed) return {};
    return { status: 'failed', renderError: { message: 'sim vision QC fail', stage: 'vision-qc', at: new Date(), charged: true } };
  };
  stub(BSE, {
    buildVideoQcFailureFields,
    // qcAndStampVideoAd is intentionally NOT called by recascadeDerivative
    // Sibling's no-brand/chrome-throw fallback any more (see the source
    // file's own header) — it stays stubbed here only because runVideoFull
    // (not under direct test in this harness — see the file-level note)
    // and the brand-resolved fallback branch may still reference it.
    qcAndStampVideoAd: async ({ ad, deliveredUrl, brandName }) => {
      bseCalls.push({ fn: 'qcAndStampVideoAd', adId: String(ad._id), deliveredUrl, brandName });
      if (bseState.swallowQc) return null;
      const verdict = bseState.visionQc;
      const fields = { visionQc: verdict, ...buildVideoQcFailureFields(verdict) };
      await AdCol.updateOne({ _id: ad._id }, { $set: fields });
      return verdict || null;
    },
    renderBrandScriptAndSave: async ({ ad, brand, retitleMode }) => {
      bseCalls.push({ fn: 'renderBrandScriptAndSave', adId: String(ad._id), retitleMode });
      if (bseState.throwOnRender) throw new Error('simulated chrome/Remotion failure');
      const verdict = bseState.visionQc;
      const qcFields = buildVideoQcFailureFields(verdict);
      if (retitleMode) delete qcFields.status; // mirror uploadRenderAndStamp's preserveAdStatus
      const fields = {
        visionQc:  verdict,
        renderUrl: `https://titled.example/${String(ad._id)}`,
        posterUrl: `https://titled.example/${String(ad._id)}.jpg`,
        ...(retitleMode ? {} : (Object.keys(qcFields).length ? {} : { status: 'draft' })),
        ...qcFields
      };
      await AdCol.updateOne({ _id: ad._id }, { $set: fields });
      return fields;
    }
  });
  stub(CLOUD, { uploadBufferToCloudinary: async () => ({}) });
  stub(DI, {});
  stub(SUS, { isUgcFirstSeedingEnabled: () => false });
  stub(UGC, { preparePassthroughMaster: async () => ({ passthrough: false, reason: 'stub' }) });
  stub(COST, { reconcileCost: async () => {} });
  stub(TRS, {
    STATE_PENDING: 'pending',
    TITLING_PENDING: 'pending',
    fallbackPosterUrl: () => null,
    buildResumeFilter: () => ({ $or: [] })
  });
  stub(CAGS, {
    resolveDeriveFromMaster: resolveDeriveFromMasterStub,
    isGooglePmaxVideoFormat: isGooglePmaxVideoFormatStub
  });
  return require(SVC);
}

const svc = install();

function baseAd(over = {}) {
  return {
    _id: 'a0000000000000000000000',
    campaignId: 'c0000000000000000000000',
    productId:  'p0000000000000000000000',
    mediaId:    'x0000000000000000000000',
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
    posterUrl: null,
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
    // See C8's own comment for why AdCol.updateOne is overridden in place
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

  function bsonRoundTrip(obj) {
    let impl;
    try {
      const bson = require('bson');
      impl = bson.BSON || bson;
    } catch {
      impl = null;
    }
    if (!impl || typeof impl.serialize !== 'function') {
      // JSON also drops undefined keys. Weaker than BSON for arrays-of-undefined
      // but identical for the deriveFromMaster:undefined hazard.
      return JSON.parse(JSON.stringify(obj));
    }
    return impl.deserialize(impl.serialize(obj));
  }

  await checkAsync('B12 [MONEY] a same-campaign+product derive of a DIFFERENT seed family is not recascaded', async () => {
    const master = baseAd({
      _id: 'm0000000000000000000000', mediaId: 'media-family-1', ctaText: 'SHOP NOW',
      deriveFromMaster: null, veoVideoUrl: 'https://old.example/m1'
    });
    const sameFamily = baseAd({
      _id: 's1000000000000000000000', mediaId: 'media-family-1', ctaText: 'SHOP NOW',
      deriveFromMaster: master.platformFormat
    });
    const otherSeed = baseAd({
      _id: 'sD000000000000000000000', mediaId: 'media-family-2', ctaText: 'SHOP NOW',
      deriveFromMaster: master.platformFormat
    });
    const otherCta = baseAd({
      _id: 'sE000000000000000000000', mediaId: 'media-family-1', ctaText: 'BUY NOW',
      deriveFromMaster: master.platformFormat
    });
    AdCol = new MiniCollection([master, sameFamily, otherSeed, otherCta]);
    const found = await svc.findDerivativesOfMaster(master);
    const foundIds = found.map((d) => d._id).sort();
    assert.deepStrictEqual(foundIds, ['s1000000000000000000000'],
      `cross-family derives must not match; got ${foundIds}`);
  });

  // Each individually-joined identity field needs its own revert-provable
  // assertion. B12 only varies mediaId and ctaText; removing videoPromptRaw
  // (or ctaUrl / ctaUrlParams / videoPromptGuidance / referenceMediaIds)
  // used to leave this harness green.
  async function assertIdentityJoinExcludes({ label, masterOver, sameOver, otherOver }) {
    await checkAsync(label, async () => {
      const master = baseAd({
        _id: 'm0000000000000000000000', deriveFromMaster: null,
        veoVideoUrl: 'https://old.example/m1', ...masterOver
      });
      const sameFamily = baseAd({
        _id: 's1000000000000000000000', deriveFromMaster: master.platformFormat, ...sameOver
      });
      const otherFamily = baseAd({
        _id: 'sX000000000000000000000', deriveFromMaster: master.platformFormat, ...otherOver
      });
      AdCol = new MiniCollection([master, sameFamily, otherFamily]);
      const found = await svc.findDerivativesOfMaster(master);
      const foundIds = found.map((d) => d._id).sort();
      assert.deepStrictEqual(foundIds, ['s1000000000000000000000'],
        `cross-family derive must not match on ${label}; got ${foundIds}`);
    });
  }

  await assertIdentityJoinExcludes({
    label: 'B12b [MONEY] ctaUrl join excludes a different-family derive',
    masterOver: { ctaUrl: 'https://same.example/shop' },
    sameOver:   { ctaUrl: 'https://same.example/shop' },
    otherOver:  { ctaUrl: 'https://other.example/shop' }
  });
  await assertIdentityJoinExcludes({
    label: 'B12c [MONEY] ctaUrlParams join excludes a different-family derive',
    masterOver: { ctaUrlParams: 'utm_source=a' },
    sameOver:   { ctaUrlParams: 'utm_source=a' },
    otherOver:  { ctaUrlParams: 'utm_source=b' }
  });
  await assertIdentityJoinExcludes({
    label: 'B12d [MONEY] videoPromptGuidance join excludes a different-family derive',
    masterOver: { videoPromptGuidance: 'guidance-family-1' },
    sameOver:   { videoPromptGuidance: 'guidance-family-1' },
    otherOver:  { videoPromptGuidance: 'guidance-family-2' }
  });
  await assertIdentityJoinExcludes({
    label: 'B12e [MONEY] videoPromptRaw join excludes a different-family derive',
    masterOver: { videoPromptRaw: 'raw-family-1' },
    sameOver:   { videoPromptRaw: 'raw-family-1' },
    otherOver:  { videoPromptRaw: 'raw-family-2' }
  });
  await assertIdentityJoinExcludes({
    label: 'B12f [MONEY] referenceMediaIds join excludes a different-stack derive',
    masterOver: { referenceMediaIds: ['ref-aaa', 'ref-bbb'] },
    sameOver:   { referenceMediaIds: ['ref-aaa', 'ref-bbb'] },
    otherOver:  { referenceMediaIds: ['ref-aaa', 'ref-ccc'] }
  });
  await assertIdentityJoinExcludes({
    label: 'B12g [MONEY] mediaId-path master excludes a sibling with a non-empty reference stack',
    masterOver: { mediaId: 'media-family-1', referenceMediaIds: [] },
    sameOver:   { mediaId: 'media-family-1', referenceMediaIds: [] },
    otherOver:  { mediaId: 'media-family-1', referenceMediaIds: ['ref-other'] }
  });

  check('B13 [MONEY] BSON drops deriveFromMaster:undefined — the hazard the guard exists to close', () => {
    const dropped = bsonRoundTrip({
      campaignId: 'c', productId: 'p', deriveFromMaster: undefined, kind: 'video'
    });
    assert.ok(!Object.prototype.hasOwnProperty.call(dropped, 'deriveFromMaster'),
      'if BSON (or JSON fallback) keeps the undefined key, the over-match this guard prevents is gone');
  });

  check('B14 [MONEY] missing platformFormat: buildDerivativeFindFilter returns null (no query)', () => {
    assert.strictEqual(typeof svc.buildDerivativeFindFilter, 'function');
    const f = svc.buildDerivativeFindFilter(baseAd({ platformFormat: undefined }));
    assert.strictEqual(f, null, 'must refuse before building a filter whose deriveFromMaster BSON would drop');
  });

  check('B15 [MONEY] a valid filter keeps deriveFromMaster through a BSON round-trip', () => {
    const f = svc.buildDerivativeFindFilter(baseAd({ platformFormat: 'meta_stories_9_16' }));
    assert.ok(f, 'valid master must produce a filter');
    assert.strictEqual(typeof f.deriveFromMaster, 'string');
    const round = bsonRoundTrip(f);
    assert.strictEqual(round.deriveFromMaster, 'meta_stories_9_16',
      'selectivity clause must survive the Mongo wire');
  });

  await checkAsync('B16 [MONEY] missing platformFormat: findDerivativesOfMaster returns [] and does not query', async () => {
    const master = baseAd({ platformFormat: undefined, veoVideoUrl: 'https://x' });
    const wouldMatchIfUnguarded = baseAd({
      _id: 's1000000000000000000000', deriveFromMaster: 'meta_stories_9_16'
    });
    const otherPaidMaster = baseAd({
      _id: 's8000000000000000000000', deriveFromMaster: null
    });
    AdCol = new MiniCollection([master, wouldMatchIfUnguarded, otherPaidMaster]);
    findCalls = [];
    const found = await svc.findDerivativesOfMaster(master);
    assert.strictEqual(found.length, 0);
    assert.strictEqual(findCalls.length, 0, 'must not issue Ad.find at all when the guard trips');
  });

  check('B17 missing campaignId or productId also refuses', () => {
    assert.strictEqual(svc.buildDerivativeFindFilter(baseAd({ campaignId: undefined })), null);
    assert.strictEqual(svc.buildDerivativeFindFilter(baseAd({ productId: undefined })), null);
    assert.strictEqual(svc.buildDerivativeFindFilter(baseAd({ mediaId: undefined, referenceMediaIds: [] })), null);
  });

  await checkAsync('B18 [MONEY] PMax 10s master does not recascade a 12s derive sharing deriveFromMaster', async () => {
    const identity = {
      campaignId: 'c0000000000000000000000',
      productId:  'p0000000000000000000000',
      mediaId:    'media-family-1',
      ctaText:    'SHOP NOW',
      ctaUrl:     'https://same.example/shop',
      ctaUrlParams: 'utm_source=a',
      videoPromptGuidance: 'guidance-family-1',
      videoPromptRaw: 'raw-family-1'
    };
    const master = baseAd({
      _id: 'm0000000000000000000000', ...identity,
      platformFormat: 'pmax_video_9_16', deriveFromMaster: null,
      videoDurationSec: 10, veoVideoUrl: 'https://old.example/m10'
    });
    const sameDuration = baseAd({
      _id: 's1000000000000000000000', ...identity,
      platformFormat: 'pmax_video_1_1', deriveFromMaster: master.platformFormat,
      videoDurationSec: 10
    });
    const otherDuration = baseAd({
      _id: 'sD120000000000000000000', ...identity,
      platformFormat: 'pmax_video_1_1', deriveFromMaster: master.platformFormat,
      videoDurationSec: 12
    });
    AdCol = new MiniCollection([master, sameDuration, otherDuration]);
    const found = await svc.findDerivativesOfMaster(master);
    const foundIds = found.map((d) => d._id).sort();
    assert.deepStrictEqual(foundIds, ['s1000000000000000000000'],
      `PMax 12s derive is a different digest family; got ${foundIds}`);
  });

  await checkAsync('B18b [MONEY] Meta duration is NOT joined — a 12s same-family derive still matches a 10s master', async () => {
    const master = baseAd({
      _id: 'm0000000000000000000000', platformFormat: 'meta_stories_9_16',
      deriveFromMaster: null, videoDurationSec: 10, veoVideoUrl: 'https://old.example/m10'
    });
    const durationVariant = baseAd({
      _id: 's1000000000000000000000', platformFormat: 'meta_feed_1_1',
      deriveFromMaster: master.platformFormat, videoDurationSec: 12
    });
    AdCol = new MiniCollection([master, durationVariant]);
    const found = await svc.findDerivativesOfMaster(master);
    const foundIds = found.map((d) => d._id).sort();
    assert.deepStrictEqual(foundIds, ['s1000000000000000000000'],
      `Meta 10s/12s is the same family; joining duration would under-match, got ${foundIds}`);
  });

  check('B18c [MONEY] PMax filter joins videoDurationSec via empty-eq; Meta filter omits it', () => {
    const pmax = svc.buildDerivativeFindFilter(baseAd({
      platformFormat: 'pmax_video_9_16', videoDurationSec: 10
    }));
    assert.ok(pmax, 'PMax master must produce a filter');
    assert.strictEqual(pmax.videoDurationSec, 10);
    const pmaxEmpty = svc.buildDerivativeFindFilter(baseAd({
      platformFormat: 'pmax_video_9_16', videoDurationSec: null
    }));
    assert.deepStrictEqual(pmaxEmpty.videoDurationSec, { $in: [null, ''] },
      'PMax duration must use the same empty-bucket helper as the other identity fields');
    const meta = svc.buildDerivativeFindFilter(baseAd({
      platformFormat: 'meta_stories_9_16', videoDurationSec: 10
    }));
    assert.ok(meta, 'Meta master must produce a filter');
    assert.ok(!Object.prototype.hasOwnProperty.call(meta, 'videoDurationSec'),
      'Meta duration must not be a join clause');
  });

  check('B19 [MONEY] production joins PMax duration through the exported isGooglePmaxVideoFormat', () => {
    const regenSrc = fs.readFileSync(SVC, 'utf8');
    const cagsSrc  = fs.readFileSync(CAGS, 'utf8');
    assert.ok(/function isGooglePmaxVideoFormat\s*\(/.test(cagsSrc),
      'isGooglePmaxVideoFormat must remain the digest-site predicate');
    assert.ok(/^\s*isGooglePmaxVideoFormat,?$/m.test(cagsSrc),
      'isGooglePmaxVideoFormat must be exported from campaignAdsGenerationService');
    assert.ok(/isGooglePmaxVideoFormat/.test(
      /const \{[\s\S]*?\}\s*=\s*require\('\.\/campaignAdsGenerationService'\)/.exec(regenSrc)?.[0] || ''
    ), 'adRegenerateService must import isGooglePmaxVideoFormat, not copy the format-set');
    const m = /function buildDerivativeFindFilter\s*\(/.exec(regenSrc);
    assert.ok(m, 'buildDerivativeFindFilter not found');
    const paramOpen = regenSrc.indexOf('(', m.index + m[0].length - 1);
    let depth = 0;
    let paramsEnd = -1;
    for (let i = paramOpen; i < regenSrc.length; i++) {
      if (regenSrc[i] === '(') depth++;
      else if (regenSrc[i] === ')') { depth--; if (depth === 0) { paramsEnd = i; break; } }
    }
    const brace = regenSrc.indexOf('{', paramsEnd + 1);
    depth = 0;
    let bodyEnd = -1;
    for (let i = brace; i < regenSrc.length; i++) {
      if (regenSrc[i] === '{') depth++;
      else if (regenSrc[i] === '}') { depth--; if (depth === 0) { bodyEnd = i; break; } }
    }
    const body = regenSrc.slice(brace, bodyEnd + 1);
    assert.ok(/isGooglePmaxVideoFormat\(\s*masterAd\.platformFormat\s*\)/.test(body),
      'duration join must be gated on isGooglePmaxVideoFormat(masterAd.platformFormat)');
    assert.ok(/videoIdentityEmptyEq\(\s*masterAd\.videoDurationSec\s*\)/.test(body),
      'PMax duration join must reuse videoIdentityEmptyEq');
  });

  // ═══════════════════════════════════════════════════════════════════
  // GROUP C — recascadeDerivativeSibling
  // ═══════════════════════════════════════════════════════════════════
  function freshMaster(over = {}) {
    return baseAd({ _id: 'm0000000000000000000000', veoVideoUrl: 'https://new.example/master-v2', veoAspectRatio: '9:16', platformFormat: 'meta_stories_9_16', ...over });
  }

  await checkAsync('C1 [MONEY/INTEGRITY] brand-resolved success: copies the NEW plate onto provenance AND writes a real composited renderUrl/posterUrl atomically', async () => {
    const master = freshMaster();
    const sibling = baseAd({ _id: 's1000000000000000000000', deriveFromMaster: master.platformFormat, veoVideoUrl: 'https://old.example/sibling-v1', renderUrl: 'https://old.example/titled-sibling-v1.mp4', posterUrl: 'https://old.example/titled-sibling-v1.jpg', basePlate: { sourceUrl: 'https://old.example/sibling-v1' }, status: 'live' });
    AdCol = new MiniCollection([master, sibling]);
    stub(AD, { find: (f) => AdCol.find(f), findById: (id) => AdCol.findById(id), updateOne: (f, u) => AdCol.updateOne(f, u) });
    bseState.brandDoc = { name: 'Acme' };
    bseState.visionQc = { passed: true, skipped: false, disabled: false };
    await svc.recascadeDerivativeSibling(sibling, master);
    const after = await AdCol.findById(sibling._id).lean();
    assert.strictEqual(after.veoVideoUrl, master.veoVideoUrl);
    assert.strictEqual(after.veoModel, `derive-from:${master.platformFormat}`);
    assert.strictEqual(after.basePlate, undefined, 'a stale crop-rect from a DIFFERENT video must not survive');
    assert.strictEqual(after.renderUrl, `https://titled.example/${sibling._id}`, 'a genuine composite DOES update renderUrl');
    assert.strictEqual(after.posterUrl, `https://titled.example/${sibling._id}.jpg`);
    assert.strictEqual(after.status, 'live', 'retitleMode:true suppresses the status write even on a real composite');
  });

  await checkAsync('C2 [MONEY/INTEGRITY] a sibling claimed by another process between find() and write is skipped, not overwritten', async () => {
    const master = freshMaster();
    const sibling = baseAd({ _id: 's1000000000000000000000', deriveFromMaster: master.platformFormat, veoVideoUrl: 'https://old.example/sibling-v1', renderUrl: 'https://old.example/titled-sibling-v1.mp4', claimedByWorker: 'renderer-x' /* claimed AFTER the find() this test skips straight to the write */ });
    AdCol = new MiniCollection([master, sibling]);
    stub(AD, { find: (f) => AdCol.find(f), findById: (id) => AdCol.findById(id), updateOne: (f, u) => AdCol.updateOne(f, u) });
    bseState.brandDoc = { name: 'Acme' };
    bseCalls = [];
    await svc.recascadeDerivativeSibling(sibling, master);
    const after = await AdCol.findById(sibling._id).lean();
    assert.strictEqual(after.veoVideoUrl, 'https://old.example/sibling-v1', 'the CAS write must not have matched a now-claimed row');
    assert.strictEqual(after.renderUrl, 'https://old.example/titled-sibling-v1.mp4');
    assert.ok(!bseCalls.some((c) => c.adId === sibling._id), 'must never even reach loadBrand/composite once the CAS write misses');
  });

  await checkAsync('C3 [MONEY/INTEGRITY] no brand configured: provenance updates, renderUrl/posterUrl/status left UNTOUCHED, no QC stamp on the sibling', async () => {
    const master = freshMaster();
    const sibling = baseAd({ _id: 's1000000000000000000000', deriveFromMaster: master.platformFormat, veoVideoUrl: 'https://old.example/sibling-v1', renderUrl: 'https://old.example/titled-sibling-v1.mp4', posterUrl: 'https://old.example/titled-sibling-v1.jpg', status: 'live' });
    AdCol = new MiniCollection([master, sibling]);
    stub(AD, { find: (f) => AdCol.find(f), findById: (id) => AdCol.findById(id), updateOne: (f, u) => AdCol.updateOne(f, u) });
    bseState.brandDoc = null;
    bseCalls = [];
    await svc.recascadeDerivativeSibling(sibling, master);
    const after = await AdCol.findById(sibling._id).lean();
    assert.strictEqual(after.veoVideoUrl, master.veoVideoUrl, 'provenance DOES update');
    assert.strictEqual(after.renderUrl, 'https://old.example/titled-sibling-v1.mp4', 'delivered renderUrl must NOT change with nothing to composite');
    assert.strictEqual(after.posterUrl, 'https://old.example/titled-sibling-v1.jpg');
    assert.strictEqual(after.status, 'live');
    assert.ok(!bseCalls.some((c) => c.fn === 'qcAndStampVideoAd' && c.adId === sibling._id), 'qcAndStampVideoAd must never run on a sibling with nothing delivered');
  });

  await checkAsync('C4 [MONEY/INTEGRITY] chrome/Remotion throws: renderUrl/posterUrl/status left UNTOUCHED on a live sibling (the severe bug both Grok passes found)', async () => {
    const master = freshMaster();
    const sibling = baseAd({ _id: 's1000000000000000000000', deriveFromMaster: master.platformFormat, veoVideoUrl: 'https://old.example/sibling-v1', renderUrl: 'https://old.example/titled-sibling-v1.mp4', posterUrl: 'https://old.example/titled-sibling-v1.jpg', status: 'live' });
    AdCol = new MiniCollection([master, sibling]);
    stub(AD, { find: (f) => AdCol.find(f), findById: (id) => AdCol.findById(id), updateOne: (f, u) => AdCol.updateOne(f, u) });
    bseState.brandDoc = { name: 'Acme' };
    bseState.throwOnRender = true;
    bseCalls = [];
    await svc.recascadeDerivativeSibling(sibling, master); // must not throw
    bseState.throwOnRender = false;
    const after = await AdCol.findById(sibling._id).lean();
    assert.strictEqual(after.renderUrl, 'https://old.example/titled-sibling-v1.mp4', 'a chrome failure must NEVER leave a raw/uncropped plate live');
    assert.strictEqual(after.posterUrl, 'https://old.example/titled-sibling-v1.jpg');
    assert.strictEqual(after.status, 'live');
    assert.ok(!bseCalls.some((c) => c.fn === 'qcAndStampVideoAd' && c.adId === sibling._id), 'must not QC-stamp a sibling with nothing actually delivered');
  });

  await checkAsync('C5 [MONEY] chrome throws on a previously-failed sibling: no promotion (nothing was actually fixed)', async () => {
    const master = freshMaster();
    const sibling = baseAd({ _id: 's1000000000000000000000', deriveFromMaster: master.platformFormat, status: 'failed' });
    AdCol = new MiniCollection([master, sibling]);
    stub(AD, { find: (f) => AdCol.find(f), findById: (id) => AdCol.findById(id), updateOne: (f, u) => AdCol.updateOne(f, u) });
    bseState.brandDoc = { name: 'Acme' };
    bseState.throwOnRender = true;
    await svc.recascadeDerivativeSibling(sibling, master);
    bseState.throwOnRender = false;
    const after = await AdCol.findById(sibling._id).lean();
    assert.strictEqual(after.status, 'failed', 'nothing was delivered — a still-failed sibling stays failed, not silently promoted');
  });

  await checkAsync('C6 brand-resolved success on a previously-failed sibling IS promoted to draft', async () => {
    const master = freshMaster();
    const sibling = baseAd({ _id: 's1000000000000000000000', deriveFromMaster: master.platformFormat, status: 'failed' });
    AdCol = new MiniCollection([master, sibling]);
    stub(AD, { find: (f) => AdCol.find(f), findById: (id) => AdCol.findById(id), updateOne: (f, u) => AdCol.updateOne(f, u) });
    bseState.brandDoc = { name: 'Acme' };
    bseState.visionQc = { passed: true, skipped: false, disabled: false };
    await svc.recascadeDerivativeSibling(sibling, master);
    const after = await AdCol.findById(sibling._id).lean();
    assert.strictEqual(after.status, 'draft');
  });

  await checkAsync('C7 [MONEY] a fresh real QC FAILURE on a genuine composite is never overwritten back to draft by this cascade\'s own promotion', async () => {
    const master = freshMaster();
    const sibling = baseAd({ _id: 's1000000000000000000000', deriveFromMaster: master.platformFormat, status: 'failed' });
    AdCol = new MiniCollection([master, sibling]);
    stub(AD, { find: (f) => AdCol.find(f), findById: (id) => AdCol.findById(id), updateOne: (f, u) => AdCol.updateOne(f, u) });
    bseState.brandDoc = { name: 'Acme' };
    bseState.visionQc = { passed: false, skipped: false, disabled: false, attempts: [{ summary: 'sim' }] };
    await svc.recascadeDerivativeSibling(sibling, master);
    const after = await AdCol.findById(sibling._id).lean();
    assert.strictEqual(after.status, 'failed', 'qcJustFailed must gate OUT the promoteFailedToDraft call');
  });

  await checkAsync('C8 a per-sibling failure never throws out of recascadeDerivativeSibling (master regenerate unaffected)', async () => {
    const master = freshMaster();
    const sibling = baseAd({ _id: 's1000000000000000000000', deriveFromMaster: master.platformFormat });
    AdCol = new MiniCollection([master, sibling]);
    stub(AD, { find: (f) => AdCol.find(f), findById: (id) => AdCol.findById(id), updateOne: (f, u) => AdCol.updateOne(f, u) });
    // Mutate the LIVE instance's method directly rather than re-calling
    // stub(AD, {...}) with a brand-new object: adRegenerateService.js's own
    // `const Ad = require('../models/Ad')` binding is resolved ONCE, at
    // install()-time, to install()'s stub object, whose methods close over
    // the `AdCol` OUTER variable by reference — reassigning `AdCol` (as
    // every other test in this file does) is honoured because those
    // closures re-read it on every call, but swapping in an entirely
    // DIFFERENT stub object via a second stub(AD, ...) call is NOT: it only
    // replaces require.cache[AD].exports, which nothing re-reads after
    // module load. Overriding AdCol.updateOne in place is what actually
    // reaches the code under test.
    AdCol.updateOne = async () => { throw new Error('simulated DB error on the CAS write'); };
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
    bseState.brandDoc = { name: 'Acme' };
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

  await checkAsync('D6 [MONEY] a master with a real QC-FAILED visionQc never fans out to siblings', async () => {
    const master = freshMaster({ status: 'failed', visionQc: { passed: false, skipped: false, disabled: false, attempts: [{ summary: 'sim' }] } });
    const sibling = baseAd({ _id: 's1000000000000000000000', deriveFromMaster: master.platformFormat, veoVideoUrl: 'https://old.example/s1', status: 'live' });
    AdCol = new MiniCollection([master, sibling]);
    stub(AD, { find: (f) => AdCol.find(f), findById: (id) => AdCol.findById(id), updateOne: (f, u) => AdCol.updateOne(f, u) });
    await svc.cascadeRegenerateToDerivatives(master._id);
    const after = await AdCol.findById(sibling._id).lean();
    assert.strictEqual(after.veoVideoUrl, 'https://old.example/s1', 'a REJECTED master plate must never fan out to a live sibling');
  });

  await checkAsync('D7 sibling count is capped at MAX_CASCADE_SIBLINGS', async () => {
    assert.ok(svc.MAX_CASCADE_SIBLINGS >= 1);
    const master = freshMaster({ status: 'draft' });
    const cap = svc.MAX_CASCADE_SIBLINGS;
    const docs = [master];
    for (let i = 0; i < cap + 2; i++) {
      const id = `s${String(i).padStart(23, '0')}`;
      docs.push(baseAd({
        _id: id,
        deriveFromMaster: master.platformFormat,
        veoVideoUrl: `https://old.example/${id}`
      }));
    }
    AdCol = new MiniCollection(docs);
    bseState.brandDoc = null;
    await svc.cascadeRegenerateToDerivatives(master._id);
    let updated = 0;
    for (let i = 0; i < cap + 2; i++) {
      const id = `s${String(i).padStart(23, '0')}`;
      const after = await AdCol.findById(id).lean();
      if (after.veoVideoUrl === master.veoVideoUrl) updated += 1;
    }
    assert.strictEqual(updated, cap, `expected ${cap} siblings recascaded, got ${updated}`);
  });

  await checkAsync('D8 operator cancel checkpoint stops remaining siblings without throwing', async () => {
    const master = freshMaster({ status: 'draft' });
    const s1 = baseAd({ _id: 's1000000000000000000000', deriveFromMaster: master.platformFormat, veoVideoUrl: 'https://old.example/s1' });
    const s2 = baseAd({ _id: 's2000000000000000000000', deriveFromMaster: master.platformFormat, veoVideoUrl: 'https://old.example/s2' });
    AdCol = new MiniCollection([master, s1, s2]);
    bseState.brandDoc = null;
    let n = 0;
    const progressRun = {
      checkpoint: async () => {
        n += 1;
        if (n >= 2) {
          const err = new Error('cancelled by operator');
          err.name = 'CancelledError';
          throw err;
        }
      }
    };
    await svc.cascadeRegenerateToDerivatives(master._id, { progressRun }); // must not throw
    const after1 = await AdCol.findById(s1._id).lean();
    const after2 = await AdCol.findById(s2._id).lean();
    assert.strictEqual(after1.veoVideoUrl, master.veoVideoUrl, 'first sibling recascades before cancel');
    assert.strictEqual(after2.veoVideoUrl, 'https://old.example/s2', 'later siblings must be skipped after cancel');
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
    // The first '{' after the name is often a default param (`opts = {}`)
    // or a destructured argument (`regenerateAd({`). Skip the parameter
    // list, then take the function body's opening brace.
    const paramOpen = SRC.indexOf('(', m.index + m[0].length - 1);
    const params = balanced(SRC, paramOpen, '(', ')');
    assert.ok(params, `unterminated parameter list for ${signatureRe}`);
    const brace = SRC.indexOf('{', paramOpen + params.length);
    const body = balanced(SRC, brace, '{', '}');
    assert.ok(body, `unterminated function body for ${signatureRe}`);
    return body;
  }
  const FORBIDDEN = /veoService|atlasVideoService|atlasImageService|directImageRenderService|generateForAd|prepareStoryboard|submitGeneration/;

  check('E1 [MONEY] findDerivativesOfMaster never references a submit helper', () => {
    const body = functionBody(/async function findDerivativesOfMaster\(/);
    assert.ok(!FORBIDDEN.test(body), `forbidden identifier found in findDerivativesOfMaster:\n${body}`);
  });
  check('E2 [MONEY] recascadeDerivativeSibling never references a submit helper', () => {
    const body = functionBody(/async function recascadeDerivativeSibling\(/);
    assert.ok(!FORBIDDEN.test(body), `forbidden identifier found in recascadeDerivativeSibling:\n${body}`);
  });
  check('E3 [MONEY] cascadeRegenerateToDerivatives never references a submit helper', () => {
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
  check('E6 [MONEY/INTEGRITY] recascadeDerivativeSibling never writes renderUrl/posterUrl outside the composite branches', () => {
    const body = functionBody(/async function recascadeDerivativeSibling\(/);
    const setBlockMatch = /siblingStillEligible\(sibling\),\s*\{([\s\S]*?)\$unset/.exec(body);
    assert.ok(setBlockMatch, 'could not locate the CAS $set block');
    assert.ok(!/renderUrl\s*:/.test(setBlockMatch[1]), 'the preliminary CAS write must never stamp renderUrl directly');
    assert.ok(!/posterUrl\s*:/.test(setBlockMatch[1]), 'the preliminary CAS write must never stamp posterUrl directly');
  });
  check('E7 [MONEY/INTEGRITY] recascadeDerivativeSibling never calls qcAndStampVideoAd on a sibling', () => {
    const body = functionBody(/async function recascadeDerivativeSibling\(/);
    assert.ok(!/qcAndStampVideoAd/.test(body), 'qcAndStampVideoAd has no preserveAdStatus concept — must never run on a sibling');
  });
  check('E7b LATENT: that E7 pin is because resolveTitlingEngine is hard-wired to remotion (canvas path is commented "restore when re-enabling")', () => {
    const bseSrc = fs.readFileSync(BSE, 'utf8');
    assert.ok(/Kill-switch:\s*always Remotion/.test(bseSrc) || /engine:\s*'remotion'/.test(bseSrc),
      'resolveTitlingEngine must still be the remotion kill-switch');
    assert.ok(/restore when re-enabling the canvas path/.test(bseSrc),
      'the canvas-restore comment must remain so a future flip is not silent');
  });

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

  const paidNames = [
    'atlasVideoService.js',
    'atlasImageService.js',
    'directImageRenderService.js',
    'videoRouter.js'
  ];
  function paidHits(visited) {
    return [...visited].filter((f) => paidNames.includes(path.basename(f)));
  }

  check('E8 [MONEY][POSITIVE CONTROL] BFS from adRegenerateService.js DOES reach a paid submit module', () => {
    const { visited } = bfsRequireGraph([SVC]);
    assert.ok(visited.size > 5, `graph looks too small (${visited.size}) — resolver may be broken`);
    assert.ok(paidHits(visited).length > 0,
      'adRegenerateService.js requires videoRouter/directImage — if BFS misses them, E9 would be vacuous');
  });
  check('E9 [MONEY] BFS from brandScriptExecutor.js (cascade\'s only heavy callee) never reaches a paid submit module', () => {
    const { visited } = bfsRequireGraph([BSE]);
    assert.ok(visited.size > 5, `graph looks too small (${visited.size}) — resolver may be broken`);
    const hits = paidHits(visited);
    assert.strictEqual(hits.length, 0, `paid module reachable from brandScriptExecutor: ${hits.join(', ')}`);
  });

  check('E10 [MONEY] runVideoFull itself no longer invokes cascadeRegenerateToDerivatives', () => {
    const body = functionBody(/async function runVideoFull\(/);
    assert.ok(!/cascadeRegenerateToDerivatives\s*\(/.test(body),
      'cascade must run after markComplete, not inside runVideoFull (45-min reclaim window)');
  });
  check('E11 [MONEY] regenerateAd and runClaimedRegeneration invoke cascade AFTER markComplete(done)', () => {
    for (const sig of [/async function regenerateAd\(/, /async function runClaimedRegeneration\(/]) {
      const body = functionBody(sig);
      const mark = body.indexOf("markComplete(adId, { status: 'done'");
      const casc = body.indexOf('cascadeRegenerateToDerivatives(');
      assert.ok(mark >= 0, `${sig} must markComplete done`);
      assert.ok(casc >= 0, `${sig} must cascade`);
      assert.ok(casc > mark, `${sig} must cascade after markComplete(done), not before`);
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // GROUP F — runVideoFull tail (qcFresh / shouldCascade / no retitleMode)
  // ═══════════════════════════════════════════════════════════════════
  async function seedMasterForRun(over = {}) {
    const ad = baseAd({
      _id: 'a0000000000000000000000',
      status: 'failed',
      veoVideoUrl: 'https://old.example/master',
      visionQc: null,
      ...over
    });
    AdCol = new MiniCollection([ad]);
    bseCalls = [];
    bseState.throwOnRender = false;
    bseState.swallowQc = false;
    bseState.brandDoc = null;
    bseState.visionQc = { passed: true, skipped: false, disabled: false, attempts: [{ summary: 'this-pass' }] };
    return ad;
  }

  await checkAsync('F1 runVideoFull QC-pass on a failed ad: promotes and returns shouldCascade:true', async () => {
    await seedMasterForRun({ status: 'failed' });
    const out = await svc.runVideoFull('a0000000000000000000000', 'refine');
    const after = await AdCol.findById('a0000000000000000000000').lean();
    assert.strictEqual(after.status, 'draft', 'failed + fresh QC pass must promote');
    assert.deepStrictEqual(out, { shouldCascade: true });
  });

  await checkAsync('F2 runVideoFull real QC fail: does not promote, shouldCascade:false', async () => {
    await seedMasterForRun({ status: 'failed' });
    bseState.visionQc = { passed: false, skipped: false, disabled: false, attempts: [{ summary: 'reject' }] };
    const out = await svc.runVideoFull('a0000000000000000000000', 'refine');
    const after = await AdCol.findById('a0000000000000000000000').lean();
    assert.strictEqual(after.status, 'failed');
    assert.deepStrictEqual(out, { shouldCascade: false });
  });

  await checkAsync('F3 [MONEY] swallowed QC (no fresh verdict) is not-promotable and not-cascadable', async () => {
    await seedMasterForRun({
      status: 'failed',
      visionQc: { passed: true, skipped: false, disabled: false, attempts: [{ summary: 'stale-pass' }] }
    });
    bseState.swallowQc = true;
    const out = await svc.runVideoFull('a0000000000000000000000', 'refine');
    const after = await AdCol.findById('a0000000000000000000000').lean();
    assert.strictEqual(after.status, 'failed', 'stale previous PASS must not promote when this pass wrote nothing');
    assert.deepStrictEqual(out, { shouldCascade: false });
  });

  await checkAsync('F4 runVideoFull does not itself recascade siblings', async () => {
    const master = await seedMasterForRun({ status: 'failed', platformFormat: 'meta_stories_9_16' });
    const sibling = baseAd({
      _id: 's1000000000000000000000',
      deriveFromMaster: master.platformFormat,
      veoVideoUrl: 'https://old.example/s1'
    });
    AdCol = new MiniCollection([master, sibling]);
    await svc.runVideoFull(master._id, 'refine');
    const after = await AdCol.findById(sibling._id).lean();
    assert.strictEqual(after.veoVideoUrl, 'https://old.example/s1',
      'cascade is the caller\'s job after markComplete, not runVideoFull\'s');
  });

  await checkAsync('F5 runVideoFull does NOT pass retitleMode to renderBrandScriptAndSave', async () => {
    await seedMasterForRun({ status: 'draft' });
    bseState.brandDoc = { name: 'Acme' };
    bseState.visionQc = { passed: true, skipped: false, disabled: false, attempts: [{ summary: 'ok' }] };
    await svc.runVideoFull('a0000000000000000000000', 'refine');
    const renderCalls = bseCalls.filter((c) => c.fn === 'renderBrandScriptAndSave');
    assert.ok(renderCalls.length >= 1, 'brand path must reach renderBrandScriptAndSave');
    assert.ok(renderCalls.every((c) => !c.retitleMode),
      `runVideoFull must not pass retitleMode; got ${JSON.stringify(renderCalls)}`);
  });

  console.log(`\n${checks} passed, ${failures.length} failed\n`);
  if (failures.length) process.exit(1);
})();
