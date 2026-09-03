#!/usr/bin/env node
'use strict';
//
// verifyRegenerateInFlightGate — MONEY harness for adRegenerateService's
// in-flight-render gate. Starting a regenerate on an ad that is still in
// its first-time render (or queued for it, or holding an untitled paid
// master) would submit a second billable provider call against work the
// ad has already bought or is about to buy.
//
// EXECUTION, NOT SOURCE TEXT. This file requires the REAL
// inFlightRefusal / preflight / runClaimedRegeneration /
// titlingResumeService.buildResumeFilter and drives them against an
// in-memory Ad stub. A source-text assertion passes against a
// reimplementation that keeps the name; this repo has been burned by
// that. MiniCollection is NOT used for Ad: its findById().select() is a
// no-op, which would make group B2 (projection-honouring) untestable
// and hide a dropped field in the execute-time .select().
//
// Offline: no DB, no network, no mongoose, no node_modules, never npm ci,
// never NODE_PATH. Run:
//   node scripts/verifyRegenerateInFlightGate.js

const path = require('path');
const assert = require('assert');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');

let pass = 0;
const failures = [];

async function check(label, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}\n     ${err.message}`);
    console.log(`  ✗ ${label}`);
  }
}

function selectKeys(selectArg) {
  if (typeof selectArg === 'string') {
    return selectArg.trim().split(/[\s,]+/).filter(Boolean);
  }
  if (Array.isArray(selectArg)) return selectArg.map(String);
  if (selectArg && typeof selectArg === 'object') {
    return Object.keys(selectArg).filter((k) => selectArg[k]);
  }
  throw new Error(`Ad.findById().select() got unexpected argument: ${JSON.stringify(selectArg)}`);
}

function projectDoc(doc, selectArg) {
  const keys = selectKeys(selectArg);
  const out = {};
  if (!keys.some((k) => k === '-_id' || k === '-id')) {
    if (Object.prototype.hasOwnProperty.call(doc, '_id')) out._id = doc._id;
  }
  for (const k of keys) {
    if (k[0] === '-') continue;
    if (k === '_id') continue;
    if (Object.prototype.hasOwnProperty.call(doc, k)) out[k] = doc[k];
  }
  return out;
}

// ── Ad stub that HONOURS .select() (group B2) ──────────────────────────
const adStore = {
  docs: [],
  lastSelectArg: null,
  lastProjected: null,
  updateCalls: [],
  findByIdCalls: []
};

function resetAds(docs) {
  adStore.docs = (docs || []).map((d) => ({ ...d }));
  adStore.lastSelectArg = null;
  adStore.lastProjected = null;
  adStore.updateCalls = [];
  adStore.findByIdCalls = [];
}

function findDoc(id) {
  return adStore.docs.find((d) => String(d._id) === String(id)) || null;
}

const AdStub = {
  findOne(filter) {
    const doc = adStore.docs.find((d) => {
      if (filter._id != null && String(d._id) !== String(filter._id)) return false;
      if (filter.brandId != null && String(d.brandId) !== String(filter.brandId)) return false;
      return true;
    });
    return {
      lean: async () => (doc ? { ...doc } : null)
    };
  },
  findById(id) {
    const rec = { id: String(id), selectArg: null };
    adStore.findByIdCalls.push(rec);
    let selectArg = null;
    const chain = {
      select(fields) {
        selectArg = fields;
        rec.selectArg = fields;
        adStore.lastSelectArg = fields;
        return chain;
      },
      lean: async () => {
        const doc = findDoc(id);
        if (!doc) return null;
        if (selectArg == null) return { ...doc };
        const projected = projectDoc(doc, selectArg);
        adStore.lastProjected = projected;
        return projected;
      }
    };
    return chain;
  },
  updateOne(filter, update, opts) {
    adStore.updateCalls.push({ filter, update, opts });
    return Promise.resolve({ matchedCount: 1, modifiedCount: 1 });
  }
};

const providers = {
  renderDirectImage: 0,
  generateForAd: 0,
  prepareStoryboard: 0,
  startRun: 0,
  ugcPassthrough: 0,
  brandScript: 0
};

function resetProviders() {
  providers.renderDirectImage = 0;
  providers.generateForAd = 0;
  providers.prepareStoryboard = 0;
  providers.startRun = 0;
  providers.ugcPassthrough = 0;
  providers.brandScript = 0;
}

class CancelledError extends Error {
  constructor(msg) {
    super(msg || 'cancelled');
    this.name = 'CancelledError';
  }
}

function chainableFindById(result) {
  return {
    select() { return this; },
    lean: async () => result
  };
}

// resolveDeriveFromMaster is stubbed (the real module pulls mongoose + five
// models + several services — same reason verifyRendererVideoMoneyInvariants
// does not require it). The two signals A7/B8 actually use are the explicit
// marker and the PMax 1:1 format. See the closing note if this drifts.
function resolveDeriveFromMasterStub(ad) {
  if (!ad) return null;
  if (typeof ad.deriveFromMaster === 'string' && ad.deriveFromMaster) {
    return ad.deriveFromMaster;
  }
  if (ad.platformFormat === 'pmax_video_1_1') return 'pmax_video_9_16';
  return null;
}

function seed(rel, exportsObj) {
  const full = require.resolve(path.join(ROOT, rel));
  require.cache[full] = new Module(full, null);
  require.cache[full].filename = full;
  require.cache[full].loaded = true;
  require.cache[full].exports = exportsObj;
  return full;
}

const mongooseStub = {
  Types: {
    ObjectId: class ObjectId {
      constructor(v) { this.id = String(v); }
      toString() { return this.id; }
      static isValid() { return true; }
    }
  }
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'mongoose') return mongooseStub;
  return origLoad.apply(this, arguments);
};

const adModelPath = seed('src/models/Ad.js', AdStub);
seed('src/models/Media.js', {
  findById: (id) => chainableFindById(null),
  exists: async () => false
});
seed('src/models/Brand.js', {
  findById: () => chainableFindById({ advertiserId: 'adv-verify' })
});
seed('src/models/CampaignRun.js', {
  findOne: () => chainableFindById(null)
});
seed('src/services/videoRouter.js', {
  generateForAd: async () => {
    providers.generateForAd += 1;
    throw new Error('videoRouter.generateForAd must not run');
  },
  prepareStoryboard: async () => {
    providers.prepareStoryboard += 1;
    throw new Error('videoRouter.prepareStoryboard must not run');
  }
});
seed('src/services/brandScriptExecutor.js', {
  renderBrandScriptAndSave: async () => { providers.brandScript += 1; },
  qcAndStampVideoAd: async () => { providers.brandScript += 1; }
});
seed('src/services/cloudinaryService.js', {
  uploadBufferToCloudinary: async () => ({
    secure_url: 'https://res.cloudinary.com/verify/image/upload/v1/ad.png',
    public_id: 'verify/ad',
    width: 8,
    height: 8,
    bytes: 3
  })
});
seed('src/services/directImageRenderService.js', {
  renderDirectImage: async () => {
    providers.renderDirectImage += 1;
    return { buffer: Buffer.from('png'), width: 8, height: 8, bytes: 3 };
  }
});
seed('src/services/campaignAdsGenerationService.js', {
  resolveDeriveFromMaster: resolveDeriveFromMasterStub,
  // Cascade after markComplete calls isGooglePmaxVideoFormat; without this
  // the destructure is undefined and a successful video regen TypeErrors
  // inside the swallowed cascade.
  isGooglePmaxVideoFormat: (fmt) => fmt === 'pmax_video_9_16' || fmt === 'pmax_video_16_9' || fmt === 'pmax_video_1_1'
});
seed('src/services/seededUniverseService.js', {
  isUgcFirstSeedingEnabled: () => false
});
seed('src/services/ugcVideoPipeline.js', {
  preparePassthroughMaster: async () => {
    providers.ugcPassthrough += 1;
    return { passthrough: false, reason: 'verify stub' };
  }
});
seed('src/services/progressService.js', {
  CancelledError,
  startRun: async () => {
    providers.startRun += 1;
    return {
      checkpoint: async () => {},
      stage() {},
      succeed: async () => {},
      fail: async () => {}
    };
  }
});
// Receipt-peek + cost-reconcile for the reclaim-only MONEY gate
// (fix/regenerate-lease-expiry). Stubbed for the same reason as every other
// provider boundary above: requiring the REAL atlasVideoService.js pulls in
// models/Campaign.js, which needs a full mongoose.Schema — this harness's
// Module._load override only stubs mongoose.Types.ObjectId, so the real file
// would crash at require time, not call time. None of this suite's scenarios
// set regenerationRequest.priorVeoPredictionSetAt, so hasFreshReceipt is
// always false and none of these should ever actually be CALLED; throw loudly
// if a future scenario ever reaches this branch unstubbed.
seed('src/services/atlasVideoService.js', {
  resumeForAd: async () => { throw new Error('atlasVideoService.resumeForAd must not run in the in-flight-gate matrix'); },
  reconcileVideoCostFromTerminal: () => { throw new Error('atlasVideoService.reconcileVideoCostFromTerminal must not run in the in-flight-gate matrix'); },
  resolveFailureCostReconcile: () => { throw new Error('atlasVideoService.resolveFailureCostReconcile must not run in the in-flight-gate matrix'); }
});
seed('src/services/costTracker.js', {
  reconcileCost: () => { throw new Error('costTracker.reconcileCost must not run in the in-flight-gate matrix'); }
});

const trsPath = require.resolve(path.join(ROOT, 'src/services/titlingResumeService.js'));
const regenPath = require.resolve(path.join(ROOT, 'src/services/adRegenerateService.js'));
delete require.cache[trsPath];
delete require.cache[regenPath];

const titlingResume = require(trsPath);
const regen = require(regenPath);

function restore() {
  Module._load = origLoad;
  if (require.cache[adModelPath]) delete require.cache[adModelPath];
  delete require.cache[trsPath];
  delete require.cache[regenPath];
}

const BRAND = 'brand-1';
function baseAd(over) {
  return {
    _id: 'ad-1',
    brandId: BRAND,
    kind: 'image',
    status: 'draft',
    metaSyncStatus: null,
    regenerating: false,
    deriveFromMaster: null,
    platformFormat: 'meta_feed_1_1',
    titlingResumeState: null,
    veoVideoUrl: null,
    renderUrl: 'https://cdn/titled.png',
    canaryField: 'MUST_NOT_LEAK',
    regenerationHistory: [],
    ...over
  };
}

async function expectReject(fn) {
  let err;
  try { await fn(); } catch (e) { err = e; }
  assert.ok(err, 'expected a throw, got a return');
  return err;
}

async function captureLog(fn) {
  const lines = [];
  const origLog = console.log;
  console.log = (...args) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
    origLog.apply(console, args);
  };
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    console.log = origLog;
  }
}

function completeSets() {
  return adStore.updateCalls
    .map((c) => c.update && c.update.$set)
    .filter((s) => s && Object.prototype.hasOwnProperty.call(s, 'regenerationHistory.$[e].status'));
}

function completeError() {
  const sets = completeSets();
  assert.ok(sets.length >= 1, 'markComplete never wrote a regenerationHistory status');
  return sets[sets.length - 1];
}

async function runClaimed(doc, req) {
  resetProviders();
  resetAds([doc]);
  const adArg = {
    _id: doc._id,
    brandId: doc.brandId,
    kind: req && req.kind ? req.kind : (doc.kind || 'image')
  };
  return regen.runClaimedRegeneration(adArg, req || { kind: adArg.kind });
}

async function runPreflight(doc) {
  resetAds([doc]);
  return regen.preflight(doc._id, doc.brandId);
}

function verdictOf(refusal) {
  return refusal ? 'REFUSE' : 'ALLOW';
}

function receiptKeyed(ad) {
  if (ad && ad.veoPredictionId) return { arm: 'receipt' };
  if (ad && ad.imageGeneration && ad.imageGeneration.predictionId) return { arm: 'receipt' };
  return null;
}

function renderUrlScoped(ad) {
  if (ad && ad.status === 'rendering' && !ad.renderUrl) return { arm: 'renderUrl' };
  return null;
}

function applyArmCond(doc, field, cond) {
  if (field.includes('.')) {
    throw new Error(`C1 builder: real buildResumeFilter arm uses dotted path ${field}`);
  }
  if (cond === null) {
    doc[field] = null;
    return;
  }
  if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
    const keys = Object.keys(cond);
    if ('$ne' in cond && keys.length === 1) {
      doc[field] = cond.$ne === null ? `https://present.example/${field}` : `not-${String(cond.$ne)}`;
      return;
    }
    if ('$lt' in cond && keys.length === 1) {
      // Refusal matcher treats $lt as satisfied. Stamp a FRESH date so this
      // doc would NOT match the real sweep's staleness bound — proving the
      // refusal ignores staleness (the documented arm-2 policy).
      doc[field] = new Date();
      return;
    }
    throw new Error(`C1 builder: unsupported operator ${field}: ${JSON.stringify(cond)}`);
  }
  doc[field] = cond;
}

function docForOnlyArm(arm) {
  const doc = { status: 'draft' };
  for (const [field, cond] of Object.entries(arm)) applyArmCond(doc, field, cond);
  if (!('titlingResumeState' in arm)) doc.titlingResumeState = null;
  if (!('veoVideoUrl' in arm)) doc.veoVideoUrl = null;
  if (!('renderUrl' in arm)) doc.renderUrl = 'https://cdn/titled.mp4';
  return doc;
}

async function main() {
  console.log('── A: preflight() executed for real ──');

  let a1Message;
  await check('A1 status:\'rendering\' → throws 409, message names the first render', async () => {
    const err = await expectReject(() => runPreflight(baseAd({ status: 'rendering', renderUrl: null })));
    assert.strictEqual(err.status, 409, `expected 409, got ${err.status}`);
    assert.match(err.message, /first render/i);
    a1Message = err.message;
  });

  let a2Message;
  await check('A2 status:\'queued\' → throws 409, message distinct from A1', async () => {
    const err = await expectReject(() => runPreflight(baseAd({ status: 'queued', renderUrl: null })));
    assert.strictEqual(err.status, 409);
    assert.match(err.message, /queued/i);
    assert.ok(a1Message, 'A1 did not capture a message — A1 must run first');
    assert.notStrictEqual(err.message, a1Message, 'queued message must be distinct from the rendering message');
    a2Message = err.message;
  });

  await check('A3 status:\'draft\' + titlingResumeState:\'claimed\' → throws 409, titling message', async () => {
    const err = await expectReject(() => runPreflight(baseAd({
      status: 'draft',
      titlingResumeState: 'claimed',
      renderUrl: 'https://cdn/master.mp4',
      veoVideoUrl: 'https://cdn/master.mp4'
    })));
    assert.strictEqual(err.status, 409);
    assert.match(err.message, /titl/i);
    assert.notStrictEqual(err.message, a1Message);
    assert.notStrictEqual(err.message, a2Message);
  });

  await check('A4 status:\'draft\' + veoVideoUrl set + renderUrl null (migration arm) → 409', async () => {
    const err = await expectReject(() => runPreflight(baseAd({
      status: 'draft',
      veoVideoUrl: 'https://atlas.example/master.mp4',
      renderUrl: null,
      titlingResumeState: null
    })));
    assert.strictEqual(err.status, 409);
    assert.match(err.message, /paid video master/i);
  });

  await check('A5 status:\'draft\' titled (renderUrl set, no resume stamp) → returns the ad, no throw', async () => {
    const ad = baseAd({
      status: 'draft',
      renderUrl: 'https://cdn/titled.png',
      titlingResumeState: null,
      veoVideoUrl: null
    });
    const got = await runPreflight(ad);
    assert.ok(got, 'preflight returned nothing');
    assert.strictEqual(String(got._id), 'ad-1');
    assert.strictEqual(got.status, 'draft');
  });

  await check('A6 sweep \'live\', \'archived\', \'failed\' → no throw', async () => {
    for (const status of ['live', 'archived', 'failed']) {
      const got = await runPreflight(baseAd({ status, renderUrl: 'https://cdn/x.png' }));
      assert.ok(got, `${status} should return the ad`);
      assert.strictEqual(got.status, status);
    }
  });

  await check('A7 derive-only AND status:\'rendering\' → DERIVE message wins (ordering)', async () => {
    const err = await expectReject(() => runPreflight(baseAd({
      status: 'rendering',
      deriveFromMaster: 'pmax_video_9_16',
      platformFormat: 'pmax_video_1_1',
      renderUrl: null
    })));
    assert.strictEqual(err.status, 409);
    assert.match(err.message, /derived from the already-paid pmax_video_9_16 master/i);
    assert.doesNotMatch(err.message, /first render/i);
  });

  await check('A8 metaSyncStatus:\'synced\' AND status:\'rendering\' → SYNCED message wins', async () => {
    const err = await expectReject(() => runPreflight(baseAd({
      status: 'rendering',
      metaSyncStatus: 'synced',
      renderUrl: null
    })));
    assert.strictEqual(err.status, 409);
    assert.match(err.message, /exported to Meta|synced version is canonical/i);
    assert.doesNotMatch(err.message, /first render/i);
  });

  await check('A9 regenerating:true AND status:\'rendering\' → ALREADY-REGENERATING message wins', async () => {
    const err = await expectReject(() => runPreflight(baseAd({
      status: 'rendering',
      regenerating: true,
      renderUrl: null
    })));
    assert.strictEqual(err.status, 409);
    assert.match(err.message, /already in progress/i);
    assert.doesNotMatch(err.message, /first render/i);
  });

  await check('A10 in-flight AND over the daily cap → in-flight 409 wins over the 429', async () => {
    const cap = regen.DAILY_CAP;
    assert.ok(Number.isFinite(cap) && cap >= 1, `DAILY_CAP is unusable: ${cap}`);
    const history = Array.from({ length: cap }, (_, i) => ({
      at: new Date(Date.now() - i * 1000),
      status: 'done'
    }));
    const err = await expectReject(() => runPreflight(baseAd({
      status: 'rendering',
      renderUrl: null,
      regenerationHistory: history
    })));
    assert.strictEqual(err.status, 409, `expected in-flight 409, got ${err.status} (429 would mean the cap won)`);
    assert.notStrictEqual(err.status, 429);
    assert.match(err.message, /first render/i);
    assert.doesNotMatch(err.message, /Daily regenerate cap/i);
  });

  console.log('\n── B: runClaimedRegeneration() executed for real (LIVE path) ──');

  await check('B1 execute-time .select() argument contains every field inFlightRefusal reads, plus the receipt baseline', async () => {
    await runClaimed(baseAd({ status: 'rendering', renderUrl: null }), { kind: 'image' });
    const arg = adStore.lastSelectArg;
    assert.ok(arg != null, 'Ad.findById().select() was never called');
    const text = typeof arg === 'string' ? arg : JSON.stringify(arg);
    for (const field of ['status', 'titlingResumeState', 'veoVideoUrl', 'renderUrl']) {
      assert.ok(text.includes(field), `select argument ${JSON.stringify(arg)} is missing ${field}`);
    }
    // veoPredictionId now legitimately rides along on this SAME query
    // (fix/regenerate-lease-expiry, adRegenerateService.js ~:1040-1044) so the
    // reclaim receipt gate judges fresh database state without an extra round
    // trip. This is a deliberate addition, not a leak — see B2's canary below,
    // which was re-pointed at a field that is genuinely never selected.
    assert.ok(text.includes('veoPredictionId'),
      `select argument ${JSON.stringify(arg)} is missing veoPredictionId — the receipt-gate baseline read would silently go stale`);
  });

  await check('B2 stub honours the projection — unselected field comes back undefined', async () => {
    await runClaimed(baseAd({
      status: 'rendering',
      renderUrl: null,
      canaryField: 'MUST_NOT_LEAK',
      // NOT veoPredictionId — PR fix/regenerate-lease-expiry deliberately
      // added that to the execute-time select (see B1) so it legitimately
      // rides along now. A field genuinely absent from every select list
      // this harness exercises is still the right canary for "did the stub
      // silently start returning the whole doc".
      unselectedCanaryField2: 'MUST_ALSO_NOT_LEAK'
    }), { kind: 'image' });
    const projected = adStore.lastProjected;
    assert.ok(projected && typeof projected === 'object', 'no projected doc captured');
    assert.strictEqual(projected.status, 'rendering', 'selected field `status` must survive projection');
    assert.strictEqual(projected.canaryField, undefined, 'unselected canaryField leaked through — stub is not honouring .select()');
    assert.ok(!Object.prototype.hasOwnProperty.call(projected, 'canaryField'),
      'unselected canaryField is present on the projected doc');
    assert.ok(!Object.prototype.hasOwnProperty.call(projected, 'unselectedCanaryField2'),
      'unselected unselectedCanaryField2 leaked through — a future dropped select field would still pass');
    assert.ok(Object.prototype.hasOwnProperty.call(projected, 'status'));
    assert.ok(Object.prototype.hasOwnProperty.call(projected, 'titlingResumeState')
      || projected.titlingResumeState === undefined);
  });

  await check('B3 status:\'rendering\' → markComplete failed, zero provider work, startRun never called', async () => {
    const { lines } = await captureLog(() =>
      runClaimed(baseAd({ status: 'rendering', renderUrl: null }), { kind: 'image' })
    );
    const set = completeError();
    assert.strictEqual(set['regenerationHistory.$[e].status'], 'failed');
    assert.match(set['regenerationHistory.$[e].error'] || '', /first render/i);
    assert.strictEqual(providers.startRun, 0, 'progressService.startRun ran — refusal must return before it');
    assert.strictEqual(providers.renderDirectImage, 0, 'runImage/directImage ran');
    assert.strictEqual(providers.generateForAd, 0, 'runVideoFull/generateForAd ran');
    assert.strictEqual(providers.prepareStoryboard, 0, 'prepareStoryboard ran');
    assert.ok(lines.some((l) => /first-time render in flight \(rendering\)/.test(l)),
      `missing execute-time log, got: ${JSON.stringify(lines)}`);
  });

  await check('B4 status:\'queued\' → same refusal shape, arm:\'queued\'', async () => {
    const { lines } = await captureLog(() =>
      runClaimed(baseAd({ status: 'queued', renderUrl: null }), { kind: 'image' })
    );
    const set = completeError();
    assert.strictEqual(set['regenerationHistory.$[e].status'], 'failed');
    assert.match(set['regenerationHistory.$[e].error'] || '', /queued/i);
    assert.strictEqual(providers.startRun, 0);
    assert.strictEqual(providers.renderDirectImage, 0);
    assert.strictEqual(providers.generateForAd, 0);
    assert.ok(lines.some((l) => /first-time render in flight \(queued\)/.test(l)),
      `missing queued arm in log, got: ${JSON.stringify(lines)}`);
  });

  await check('B5 status:\'draft\' + titlingResumeState:\'pending\' → refused', async () => {
    const { lines } = await captureLog(() =>
      runClaimed(baseAd({
        status: 'draft',
        titlingResumeState: 'pending',
        renderUrl: 'https://cdn/master.mp4',
        veoVideoUrl: 'https://cdn/master.mp4'
      }), { kind: 'image' })
    );
    const set = completeError();
    assert.strictEqual(set['regenerationHistory.$[e].status'], 'failed');
    assert.match(set['regenerationHistory.$[e].error'] || '', /titl/i);
    assert.strictEqual(providers.startRun, 0);
    assert.strictEqual(providers.renderDirectImage, 0);
    assert.ok(lines.some((l) => /first-time render in flight \(titling-owed\)/.test(l)),
      `missing titling-owed arm in log, got: ${JSON.stringify(lines)}`);
  });

  await check('B6 status:\'draft\' titled → the image path IS entered', async () => {
    await runClaimed(baseAd({
      status: 'draft',
      kind: 'image',
      renderUrl: 'https://cdn/titled.png',
      titlingResumeState: null,
      veoVideoUrl: null,
      variantKind: 'lifestyle'
    }), { kind: 'image' });
    assert.ok(providers.startRun >= 1, 'startRun was never called — titled draft should proceed');
    assert.ok(providers.renderDirectImage >= 1, 'renderDirectImage was never called — image worker did not run');
    assert.strictEqual(providers.generateForAd, 0, 'video worker ran on an image regenerate');
    const sets = completeSets();
    assert.ok(sets.length >= 1, 'markComplete never ran');
    assert.strictEqual(sets[sets.length - 1]['regenerationHistory.$[e].status'], 'done');
  });

  await check('B7 branch-reached proof — execute-time log printed with the right arm', async () => {
    const { lines } = await captureLog(() =>
      runClaimed(baseAd({ status: 'rendering', renderUrl: null }), { kind: 'image' })
    );
    const hit = lines.filter((l) => /refused at execute time — first-time render in flight \(rendering\)/.test(l));
    assert.strictEqual(hit.length, 1, `expected exactly one execute-time log line, got ${JSON.stringify(lines)}`);
    assert.match(hit[0], /🔀 regenerate-consumer\[ad=ad-1\]/);
  });

  await check('B8 metaSync and derive refusals still fire and still OUTRANK the in-flight one', async () => {
    const synced = await captureLog(() =>
      runClaimed(baseAd({
        status: 'rendering',
        metaSyncStatus: 'synced',
        renderUrl: null
      }), { kind: 'image' })
    );
    const syncedSet = completeError();
    assert.strictEqual(syncedSet['regenerationHistory.$[e].status'], 'failed');
    assert.match(syncedSet['regenerationHistory.$[e].error'] || '', /exported to Meta/i);
    assert.ok(synced.lines.some((l) => /exported to Meta while queued/.test(l)),
      `missing metaSync execute-time log: ${JSON.stringify(synced.lines)}`);
    assert.ok(!synced.lines.some((l) => /first-time render in flight/.test(l)),
      'in-flight log fired — metaSync must outrank it');
    assert.strictEqual(providers.startRun, 0);
    assert.strictEqual(providers.renderDirectImage, 0);

    const derived = await captureLog(() =>
      runClaimed(baseAd({
        status: 'rendering',
        deriveFromMaster: 'pmax_video_9_16',
        platformFormat: 'pmax_video_1_1',
        renderUrl: null
      }), { kind: 'image' })
    );
    const derivedSet = completeError();
    assert.strictEqual(derivedSet['regenerationHistory.$[e].status'], 'failed');
    assert.match(derivedSet['regenerationHistory.$[e].error'] || '', /derived from the already-paid pmax_video_9_16 master/i);
    assert.ok(derived.lines.some((l) => /derive-only \(pmax_video_9_16\)/.test(l)),
      `missing derive execute-time log: ${JSON.stringify(derived.lines)}`);
    assert.ok(!derived.lines.some((l) => /first-time render in flight/.test(l)),
      'in-flight log fired — derive must outrank it');
    assert.strictEqual(providers.startRun, 0);
    assert.strictEqual(providers.renderDirectImage, 0);
  });

  console.log('\n── C: agreement with titlingResumeService.buildResumeFilter ──');

  await check('C1 each $or arm of the real buildResumeFilter → inFlightRefusal arm:\'titling-owed\'', async () => {
    const filter = titlingResume.buildResumeFilter(new Date());
    const arms = filter.$or;
    assert.ok(Array.isArray(arms) && arms.length >= 1, 'buildResumeFilter().$or is empty');
    arms.forEach((arm, i) => {
      const doc = docForOnlyArm(arm);
      const got = regen.inFlightRefusal(doc);
      assert.ok(got, `arm ${i} ${JSON.stringify(arm)} → null (expected titling-owed). doc=${JSON.stringify(doc)}`);
      assert.strictEqual(got.arm, 'titling-owed', `arm ${i} returned ${got.arm}`);
    });
  });

  await check('C2 status:\'draft\' satisfying NO arm → null', async () => {
    const got = regen.inFlightRefusal({
      status: 'draft',
      renderUrl: 'https://cdn/titled.png',
      titlingResumeState: null,
      veoVideoUrl: null
    });
    assert.strictEqual(got, null);
  });

  // C3/C4 — what happens when buildResumeFilter outgrows the matcher.
  //
  // THE MONEY PROPERTY IS "NEVER A SILENT ALLOW", not "throws". An
  // uninterpretable arm must not read as "this ad is not owed titling", because
  // that would let a regenerate discard an already-paid master. The matcher
  // throws internally so the reason survives; inFlightRefusal converts that to
  // an ordinary REFUSAL (arm 'titling-indeterminate') because it is called from
  // runClaimedRegeneration OUTSIDE its try block, where an escaping exception
  // would strand the row via regenerateConsumer's crash path instead of
  // releasing the lock. Both halves are asserted: C3 that it refuses rather
  // than allows, C4 that the exception does not escape.
  await check('C3 an uninterpretable buildResumeFilter arm REFUSES (never a silent allow)', async () => {
    const original = titlingResume.buildResumeFilter;
    const cached = require.cache[trsPath];
    assert.ok(cached && cached.exports === titlingResume, 'titlingResumeService cache entry is not the loaded module');
    try {
      // A dotted path — the PR #80 lesson.
      cached.exports.buildResumeFilter = () => ({
        status: 'draft',
        $or: [{ 'imageGeneration.predictionId': { $ne: null } }]
      });
      const r1 = regen.inFlightRefusal({
        status: 'draft',
        imageGeneration: { predictionId: 'pred_x' }
      });
      assert.ok(r1, 'dotted-path arm was silently treated as no-match — a paid master could be re-bought');
      assert.strictEqual(r1.arm, 'titling-indeterminate');

      // An operator the matcher does not implement.
      cached.exports.buildResumeFilter = () => ({
        status: 'draft',
        $or: [{ veoVideoUrl: { $exists: true } }]
      });
      const r2 = regen.inFlightRefusal({ status: 'draft', veoVideoUrl: 'https://x' });
      assert.ok(r2, 'unsupported operator was silently treated as no-match');
      assert.strictEqual(r2.arm, 'titling-indeterminate');
    } finally {
      cached.exports.buildResumeFilter = original;
    }
    const after = regen.inFlightRefusal({
      status: 'draft',
      renderUrl: 'https://cdn/titled.png',
      titlingResumeState: null,
      veoVideoUrl: null
    });
    assert.strictEqual(after, null, 'C3 monkey-patch leaked — restore failed');
  });

  await check('C4 that refusal reaches the LIVE path as a refusal, not an escaping throw', async () => {
    const original = titlingResume.buildResumeFilter;
    const cached = require.cache[trsPath];
    try {
      cached.exports.buildResumeFilter = () => ({
        status: 'draft',
        $or: [{ 'imageGeneration.predictionId': { $ne: null } }]
      });
      // Must RESOLVE (not reject) and must refuse without provider work.
      await captureLog(() => runClaimed(
        baseAd({ status: 'draft', imageGeneration: { predictionId: 'pred_x' } }),
        { kind: 'image' }
      ));
      const set = completeError();
      assert.strictEqual(set['regenerationHistory.$[e].status'], 'failed',
        'markComplete did not fail the row — it would be left locked');
      assert.match(set['regenerationHistory.$[e].error'] || '',
        /titling state could not be determined/);
      assert.strictEqual(providers.startRun, 0);
      assert.strictEqual(providers.renderDirectImage, 0,
        'a provider call ran on an indeterminate titling state');
      assert.strictEqual(providers.generateForAd, 0,
        'a video submit ran on an indeterminate titling state');
    } finally {
      cached.exports.buildResumeFilter = original;
    }
  });

  console.log('\n── F: signal comparison (why status, not the rejected alternatives) ──');

  const rows = [
    { n: 1,  expected: 'REFUSE', shape: 'fresh mint rendering, unclaimed, no receipt, no renderUrl',
      ad: { status: 'rendering', claimedByWorker: null, renderUrl: null } },
    { n: 2,  expected: 'REFUSE', shape: 'claimed static mid-submit rendering, no receipt yet, no renderUrl',
      ad: { status: 'rendering', claimedByWorker: 'renderer-abc', renderUrl: null } },
    { n: 3,  expected: 'REFUSE', shape: 'claimed static mid-poll rendering, imageGeneration.predictionId set',
      ad: { status: 'rendering', claimedByWorker: 'renderer-abc', imageGeneration: { predictionId: 'img_1' }, renderUrl: null } },
    { n: 4,  expected: 'REFUSE', shape: 'video master mid-titling rendering, receipt+veoVideoUrl+renderUrl, titlingNeeded',
      ad: { status: 'rendering', veoPredictionId: 'veo_1', veoVideoUrl: 'https://cdn/master.mp4', renderUrl: 'https://cdn/master.mp4', titlingNeeded: true } },
    { n: 5,  expected: 'REFUSE', shape: 'video unsettled at poll timeout rendering, unclaimed, veoPredictionId set',
      ad: { status: 'rendering', claimedByWorker: null, veoPredictionId: 'veo_1' } },
    { n: 6,  expected: 'REFUSE', shape: 'derive awaiting sibling rendering, deriveWaitAttempts:3',
      ad: { status: 'rendering', deriveWaitAttempts: 3 } },
    { n: 7,  expected: 'REFUSE', shape: 'never rendered queued, no receipt',
      ad: { status: 'queued' } },
    { n: 8,  expected: 'REFUSE', shape: 'untitled paid master draft, veoVideoUrl set, renderUrl null',
      ad: { status: 'draft', veoVideoUrl: 'https://atlas.example/master.mp4', renderUrl: null } },
    { n: 9,  expected: 'REFUSE', shape: 'titling claimed draft, titlingResumeState claimed, renderUrl set',
      ad: { status: 'draft', titlingResumeState: 'claimed', renderUrl: 'https://cdn/master.mp4', veoVideoUrl: 'https://cdn/master.mp4' } },
    { n: 10, expected: 'ALLOW',  shape: 'delivered static draft, renderUrl + imageGeneration.predictionId',
      ad: { status: 'draft', renderUrl: 'https://cdn/static.png', imageGeneration: { predictionId: 'img_1' }, titlingResumeState: null, veoVideoUrl: null } },
    { n: 11, expected: 'ALLOW',  shape: 'delivered titled video draft, renderUrl + veoPredictionId',
      ad: { status: 'draft', renderUrl: 'https://cdn/titled.mp4', veoPredictionId: 'veo_1', titlingResumeState: null, veoVideoUrl: 'https://cdn/titled.mp4' } },
    { n: 12, expected: 'ALLOW',  shape: 'published live, receipts set',
      ad: { status: 'live', veoPredictionId: 'veo_1', imageGeneration: { predictionId: 'img_1' }, renderUrl: 'https://cdn/x.png' } },
    { n: 13, expected: 'ALLOW',  shape: 'failed video, veoPredictionId set',
      ad: { status: 'failed', veoPredictionId: 'veo_1' } },
    { n: 14, expected: 'ALLOW',  shape: 'failed static, imageGeneration.predictionId set',
      ad: { status: 'failed', imageGeneration: { predictionId: 'img_1' } } },
    { n: 15, expected: 'ALLOW',  shape: 'archived',
      ad: { status: 'archived' } }
  ];

  const RECEIPT_WRONG = [2, 7, 10, 11, 12, 13, 14];
  const RENDERURL_WRONG = [4, 7, 8, 9];

  let inflightRight = 0;
  const receiptWrongHits = [];
  const renderUrlWrongHits = [];
  const extraReceiptWrong = [];
  const extraRenderUrlWrong = [];

  for (const row of rows) {
    const inflight = verdictOf(regen.inFlightRefusal(row.ad));
    const receipt = verdictOf(receiptKeyed(row.ad));
    const scoped = verdictOf(renderUrlScoped(row.ad));
    const ok = inflight === row.expected;
    if (ok) inflightRight += 1;
    if (receipt !== row.expected) {
      if (RECEIPT_WRONG.includes(row.n)) receiptWrongHits.push(row.n);
      else extraReceiptWrong.push(row.n);
    }
    if (scoped !== row.expected) {
      if (RENDERURL_WRONG.includes(row.n)) renderUrlWrongHits.push(row.n);
      else extraRenderUrlWrong.push(row.n);
    }
    const mark = ok ? '✓' : '✗';
    console.log(
      `  F${row.n} ${mark} expected=${row.expected} inFlight=${inflight} receiptKeyed=${receipt} renderUrlScoped=${scoped}  ${row.shape}`
    );
    await check(`F${row.n} inFlightRefusal ${row.expected} — ${row.shape}`, async () => {
      assert.strictEqual(inflight, row.expected,
        `inFlightRefusal was ${inflight}, expected ${row.expected}`);
    });
  }

  await check(`F-tally inFlightRefusal right on all 15 (got ${inflightRight}/15)`, async () => {
    assert.strictEqual(inflightRight, 15);
  });

  await check(`F-receiptKeyed WRONG on rows ${RECEIPT_WRONG.join(',')} (count=${RECEIPT_WRONG.length})`, async () => {
    assert.deepStrictEqual(receiptWrongHits, RECEIPT_WRONG,
      `receiptKeyed was WRONG on ${JSON.stringify(receiptWrongHits)}, expected ${JSON.stringify(RECEIPT_WRONG)}`);
    console.log(`  receiptKeyed extra WRONG (not asserted): ${extraReceiptWrong.join(',') || '(none)'}`);
    console.log(`  receiptKeyed WRONG count on listed rows: ${receiptWrongHits.length}`);
  });

  await check(`F-renderUrlScoped WRONG on rows ${RENDERURL_WRONG.join(',')} (incl. row 4, the most expensive in-flight state)`, async () => {
    assert.deepStrictEqual(renderUrlWrongHits, RENDERURL_WRONG,
      `renderUrlScoped was WRONG on ${JSON.stringify(renderUrlWrongHits)}, expected ${JSON.stringify(RENDERURL_WRONG)}`);
    console.log(`  renderUrlScoped extra WRONG (not asserted): ${extraRenderUrlWrong.join(',') || '(none)'}`);
    console.log(`  renderUrlScoped WRONG count on listed rows: ${renderUrlWrongHits.length}`);
  });

  console.log('');
  // ── D. THE CALL-SITE GROUP ────────────────────────────────────────────
  //
  // Everything above asserts the exported RULE. None of it drives a worker to
  // its billable call, so none of it can see the rule failing to be APPLIED
  // there. Backend's own harness header records that an earlier revision of
  // itself asserted only the exported helper, and that removing the guard from
  // the real call site left it FULLY GREEN. This group exists so that cannot
  // happen here.
  //
  // The race being simulated: the row is clean when the worker loads it, and
  // goes in-flight (reaper requeue / claimAdsForRun / titlingResume claim)
  // during the awaits before the submit. The flip is keyed on the late check's
  // own projection string, which is the only read that uses it — so these
  // checks fail if the late check is removed, and also if it is moved before
  // those awaits.
  function withRaceAfterBodyLoad(inFlightPatch, fn) {
    const realFindById = AdStub.findById;
    let flipped = false;
    AdStub.findById = function (id) {
      const chain = realFindById.call(this, id);
      const realSelect = chain.select.bind(chain);
      chain.select = (fields) => {
        // The late gate is the ONLY read projected to exactly these fields.
        if (String(fields) === 'status titlingResumeState veoVideoUrl renderUrl') {
          flipped = true;
          const doc = adStore.docs[0];
          Object.assign(doc, inFlightPatch);
        }
        return realSelect(fields);
      };
      return chain;
    };
    return Promise.resolve()
      .then(fn)
      .finally(() => { AdStub.findById = realFindById; return flipped; })
      .then((r) => { assert.ok(flipped, 'the late in-flight projection was never requested — the guard is absent or was moved'); return r; });
  }

  await check('D1 [MONEY] runImage: a row that goes in-flight after its body load NEVER reaches renderDirectImage', async () => {
    adStore.docs = [baseAd({ status: 'draft', renderUrl: 'https://cdn/prev.png' })];
    resetProviders();
    adStore.findByIdCalls.length = 0;
    let thrown = null;
    await withRaceAfterBodyLoad({ status: 'rendering' }, async () => {
      try { await regen.runImage('ad-1', 'a new plate'); }
      catch (e) { thrown = e; }
    });
    assert.ok(thrown, 'the late gate must THROW — returning would let the caller stamp status:done');
    assert.strictEqual(thrown.name, 'InFlightRefusalError',
      `expected InFlightRefusalError, got ${thrown && thrown.name}: ${thrown && thrown.message}`);
    assert.strictEqual(thrown.arm, 'rendering');
    assert.strictEqual(providers.renderDirectImage, 0,
      'renderDirectImage was invoked for an ad whose first render is in flight — that is the double bill.');

    // ORDERING. Removing the gate is not the only way to break it: MOVING it
    // up, above the UGC / catalog-reseed awaits, makes it redundant with
    // runClaimedRegeneration's execute-time check and silently reopens the
    // window. Everything above would still pass, because the flip is keyed on
    // the projection rather than on position. So assert position directly:
    // the un-projected body load must come FIRST, the gate's projection after.
    const calls = adStore.findByIdCalls;
    const bodyIdx = calls.findIndex((c) => c.selectArg == null);
    const gateIdx = calls.findIndex((c) => String(c.selectArg) === 'status titlingResumeState veoVideoUrl renderUrl');
    assert.ok(bodyIdx >= 0, 'runImage never issued its un-projected body load');
    assert.ok(gateIdx >= 0, 'the late gate never issued its projection');
    assert.ok(gateIdx > bodyIdx,
      `the in-flight gate ran BEFORE runImage's body load (gate at call ${gateIdx}, body load at ${bodyIdx}). `
      + 'A gate hoisted above the intervening awaits is redundant with the execute-time check and does not '
      + 'close the window it exists for.');
  });

  await check('D2 [MONEY] runVideoFull: a row that goes in-flight before the Omni submit NEVER reaches generateForAd', async () => {
    adStore.docs = [baseAd({ kind: 'video', status: 'draft', renderUrl: 'https://cdn/prev.mp4' })];
    resetProviders();
    let thrown = null;
    // The shared videoRouter stub makes prepareStoryboard THROW, because every
    // other group asserts the video path is never entered. This group has to
    // walk through it to reach the submit, so swap in a non-throwing storyboard
    // for the duration — same targeted-override pattern C3 uses. The
    // generateForAd stub is left exactly as-is: it must still count-and-throw,
    // because reaching it at all is the failure this check is looking for.
    const vrPath = require.resolve(path.join(ROOT, 'src/services/videoRouter.js'));
    const vr = require.cache[vrPath];
    assert.ok(vr, 'videoRouter is not in the require cache');
    const realPrepare = vr.exports.prepareStoryboard;
    vr.exports.prepareStoryboard = async () => {
      providers.prepareStoryboard += 1;
      return { storyboard: null };
    };
    try {
      await withRaceAfterBodyLoad({ status: 'rendering' }, async () => {
        try { await regen.runVideoFull('ad-1', 'a new cut'); }
        catch (e) { thrown = e; }
      });
    } finally {
      vr.exports.prepareStoryboard = realPrepare;
    }
    assert.ok(providers.prepareStoryboard > 0,
      'runVideoFull never reached prepareStoryboard, so it never got near the submit — this check would be vacuous');
    assert.ok(thrown, 'the late gate must THROW');
    assert.strictEqual(thrown.name, 'InFlightRefusalError',
      `expected InFlightRefusalError, got ${thrown && thrown.name}: ${thrown && thrown.message}`);
    assert.strictEqual(providers.generateForAd, 0,
      'generateForAd was invoked for an ad whose first render is in flight — that is a second paid Omni submit.');
  });

  await check('D3 [POSITIVE CONTROL] a row that stays clean DOES reach renderDirectImage', async () => {
    // Without this, D1 would pass just as well against a runImage that never
    // reaches the provider at all for some unrelated reason.
    adStore.docs = [baseAd({ status: 'draft', renderUrl: 'https://cdn/prev.png' })];
    resetProviders();
    let thrown = null;
    await withRaceAfterBodyLoad({ status: 'draft' }, async () => {
      try { await regen.runImage('ad-1', 'a new plate'); }
      catch (e) { thrown = e; }
    });
    assert.strictEqual(thrown, null, `clean row threw: ${thrown && thrown.message}`);
    assert.strictEqual(providers.renderDirectImage, 1,
      'the clean path did NOT reach renderDirectImage, so D1/D2 prove nothing about the guard');
  });

  await check('D4 the late gate reads EVERY field inFlightRefusal consults (a dropped field is a silent no-op)', async () => {
    adStore.docs = [baseAd({ status: 'draft', renderUrl: 'https://cdn/prev.png' })];
    resetProviders();
    let seen = null;
    const realFindById = AdStub.findById;
    AdStub.findById = function (id) {
      const chain = realFindById.call(this, id);
      const realSelect = chain.select.bind(chain);
      chain.select = (fields) => {
        if (String(fields).includes('status') && !String(fields).includes('metaSyncStatus')) seen = String(fields);
        return realSelect(fields);
      };
      return chain;
    };
    try { await regen.runImage('ad-1', 'x'); } catch { /* not what this asserts */ }
    finally { AdStub.findById = realFindById; }
    assert.ok(seen, 'no late in-flight projection was issued at all');
    for (const f of ['status', 'titlingResumeState', 'veoVideoUrl', 'renderUrl']) {
      assert.ok(seen.split(/\s+/).includes(f),
        `the late gate's select omits '${f}', which inFlightRefusal reads — the gate silently no-ops on that arm. select was: '${seen}'`);
    }
  });


  // ── E. MERGE-ORDER GATE (self-healing) ────────────────────────────────
  //
  // This PR must land AFTER the vendor-manifest correction PR, because both
  // touch the ledger entry for services/adRegenerateService.js. That PR runs
  // `--reconcile`, which records the CURRENT adgen hash of this file. If THIS
  // PR lands first, that recorded hash is stale the moment it merges — a
  // false record in the one place cross-repo debts are tracked.
  //
  // Enforced rather than remembered. The check reads the PREREQUISITE's state
  // from the remote trunk ref, not from a working tree, so it is red while the
  // prerequisite is unmerged and goes green the moment it lands — with no
  // further commit on this branch.
  await check('E1 [MERGE-ORDER] the vendor-manifest correction has landed on origin/master', () => {
    const { execFileSync } = require('child_process');
    let raw;
    try {
      raw = execFileSync('git', ['show', 'origin/master:scripts/vendor-manifest.json'],
        { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      // Fail CLOSED. A merge gate that disappears when a ref is unreadable is
      // not a gate. If this fires in an environment with no origin, fetch it
      // rather than deleting the check.
      assert.fail(
        'could not read origin/master:scripts/vendor-manifest.json — run `git fetch origin`. '
        + `This check fails closed on purpose. (${err && err.message})`);
    }
    const entry = JSON.parse(raw).files['services/adRegenerateService.js'];
    assert.ok(entry, 'services/adRegenerateService.js is missing from the manifest on origin/master');
    assert.ok(
      String(entry.reason).includes('OWES PORTS IN BOTH DIRECTIONS'),
      'PREREQUISITE NOT MERGED — this is the merge-order gate, not a defect in this PR.\n'
      + '  This branch changes services/adRegenerateService.js, which moves its adgenHash.\n'
      + '  The manifest-correction PR reconciles that same entry and must land FIRST, or it\n'
      + '  records a hash that is stale on arrival.\n'
      + '  Merge that PR, then re-run this suite. No commit is needed here — this check reads\n'
      + '  origin/master live and will go green on its own.');
  });

  if (failures.length) {
    console.log(`❌ verifyRegenerateInFlightGate: ${pass}/${pass + failures.length} checks passed\n`);
    for (const f of failures) console.log('  ' + f);
    restore();
    process.exit(1);
  }

  console.log(`✅ verifyRegenerateInFlightGate: ${pass}/${pass} checks passed\n`);
  restore();
  process.exit(0);
}

main().catch((err) => {
  restore();
  console.error(err);
  process.exit(1);
});
