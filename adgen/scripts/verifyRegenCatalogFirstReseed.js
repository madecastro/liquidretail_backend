#!/usr/bin/env node
'use strict';
//
// verifyRegenCatalogFirstReseed — ports backend's deleted
// scripts/verifyRegeneration.js groups R3 / R3b / R3c (PR #411 removed
// the in-process backend copy; the LIVE logic is now only in
// src/services/adRegenerateService.js). Catalog-first reseed on STATIC
// regenerate: when eligible, a product_image ad re-derives its reference
// image from the product's own catalog photo instead of replaying a stale
// UGC-derived Director stack.
//
// WHAT THIS PINS (against the REAL exported functions, not a reimplementation):
//   R3   reseedDecision / shouldReseedFromCatalog gate + REGEN_RESEED_CATALOG_FIRST
//        env parse + every RESEED_SKIP reason code.
//   R3b  pickFirstCatalogMediaId / isCatalogMediaForProduct tier cascade
//        (hero > earliest createdAt > nothing) and every disqualifier
//        (UGC source, wrong product, wrong brand, missing ids).
//   R3c  a derived id must be USABLE: null/whitespace fileUrl never
//        selectable; catalog VIDEO never selectable as the first catalog
//        IMAGE. An unusable "winner" must not shadow a usable image —
//        otherwise renderDirectImage silently falls back to the original
//        UGC seed after we already logged a successful reseed (a billed
//        submit over a false success).
//   R3d  deriveFirstCatalogMediaId query-shape contract (not exported —
//        evaluated out of the live function body). Two findOne calls,
//        both pinning source:'catalog-product' + product + brand, SELECT
//        including fileType AND fileUrl (dropping either silently
//        re-opens the UGC-seed fallback), hero then earliest-createdAt.
//
// Not a byte-copy of the backend harness: that file used backend paths
// and a now-deleted module. Cases (inputs/outputs) are the spec; this
// file follows adgen harness conventions (Module._load mongoose stub so
// a bare worktree can require the live service, check()/assert, suite
// auto-discovery via scripts/verify*.js).
//
// Pure + offline: no DB, no network, no API keys. Run:
//   node scripts/verifyRegenCatalogFirstReseed.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const SVC_PATH = path.join(ROOT, 'src', 'services', 'adRegenerateService.js');
const SRC = fs.readFileSync(SVC_PATH, 'utf8');

let checks = 0;
const failures = [];
function check(label, fn) {
  try { fn(); checks += 1; }
  catch (err) { failures.push(`${label}\n     ${err.message}`); }
}
async function checkAsync(label, fn) {
  try { await fn(); checks += 1; }
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

function seed(rel, exportsObj) {
  const full = require.resolve(path.join(ROOT, rel));
  require.cache[full] = new Module(full, null);
  require.cache[full].filename = full;
  require.cache[full].loaded = true;
  require.cache[full].exports = exportsObj;
  return full;
}

function chainableFindById(result) {
  return {
    select() { return this; },
    lean: async () => result
  };
}

// Real mongoose.Types.ObjectId throws on a non-24-hex string; the live
// deriveFirstCatalogMediaId catch-returns null on that throw. A stub that
// never throws would hide a parser change that started accepting garbage
// ids (or stopped catching). 24-hex is the only shape the recovered
// fixtures use.
class ObjectId {
  constructor(v) {
    const s = String(v);
    if (!/^[a-fA-F0-9]{24}$/.test(s)) throw new Error(`invalid ObjectId: ${s}`);
    this.id = s;
  }
  toString() { return this.id; }
  valueOf() { return this.id; }
  static isValid(v) { return /^[a-fA-F0-9]{24}$/.test(String(v)); }
}

const mongooseStub = { Types: { ObjectId } };
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'mongoose') return mongooseStub;
  return origLoad.apply(this, arguments);
};

const mediaCalls = [];
let mediaResponses = [];
function resetMedia() {
  mediaCalls.length = 0;
  mediaResponses = [];
}
function projectDoc(doc, selectArg) {
  if (typeof selectArg !== 'string') return { ...doc };
  const keys = selectArg.trim().split(/[\s,]+/).filter(Boolean);
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
const MediaStub = {
  findOne(filter) {
    const rec = { filter, selectArg: null, sortArg: null };
    mediaCalls.push(rec);
    const chain = {
      select(fields) { rec.selectArg = fields; return chain; },
      sort(s) { rec.sortArg = s; return chain; },
      lean: async () => {
        const doc = mediaResponses[mediaCalls.length - 1];
        if (doc == null) return null;
        if (rec.selectArg == null) return { ...doc };
        return projectDoc(doc, rec.selectArg);
      }
    };
    return chain;
  },
  findById: (id) => chainableFindById(null),
  exists: async () => false
};

seed('src/models/Ad.js', {
  findOne: () => ({ lean: async () => null }),
  findById: () => chainableFindById(null),
  updateOne: async () => ({ matchedCount: 0, modifiedCount: 0 })
});
seed('src/models/Media.js', MediaStub);
seed('src/models/Brand.js', { findById: () => chainableFindById(null) });
seed('src/models/CampaignRun.js', { findOne: () => chainableFindById(null) });
seed('src/services/videoRouter.js', {
  generateForAd: async () => { throw new Error('videoRouter.generateForAd must not run'); },
  prepareStoryboard: async () => { throw new Error('videoRouter.prepareStoryboard must not run'); }
});
seed('src/services/brandScriptExecutor.js', {
  renderBrandScriptAndSave: async () => {},
  qcAndStampVideoAd: async () => {}
});
seed('src/services/cloudinaryService.js', {
  uploadBufferToCloudinary: async () => ({ secure_url: 'https://cdn.example/x', public_id: 'x' })
});
seed('src/services/directImageRenderService.js', {
  renderDirectImage: async () => { throw new Error('directImageRenderService.renderDirectImage must not run'); }
});
seed('src/services/campaignAdsGenerationService.js', {
  resolveDeriveFromMaster: () => null,
  isGooglePmaxVideoFormat: () => false
});
seed('src/services/seededUniverseService.js', { isUgcFirstSeedingEnabled: () => false });
seed('src/services/ugcVideoPipeline.js', {
  preparePassthroughMaster: async () => ({ passthrough: false, reason: 'stub' })
});
seed('src/services/videoDurationPolicy.js', { resolveAdVideoDurationSec: () => 10 });
seed('src/services/costTracker.js', { reconcileCost: () => {} });
seed('src/services/titlingResumeService.js', {
  STATE_PENDING: 'pending',
  TITLING_PENDING: 'pending',
  fallbackPosterUrl: () => null
});

const regenPath = require.resolve(SVC_PATH);
delete require.cache[regenPath];
const regen = require(regenPath);

function restore() {
  Module._load = origLoad;
  delete require.cache[regenPath];
}

const PRODUCT = '6a6a4d58054561c15f3ff8a2';
const BRAND   = '6a6a4d58054561c15f3ff800';
const AD = (over) => ({
  kind: 'image',
  variantKind: 'product_image',
  referenceMediaIds: [],
  productId: PRODUCT,
  brandId: BRAND,
  mediaIds: ['aaaaaaaaaaaaaaaaaaaaaaa1', 'aaaaaaaaaaaaaaaaaaaaaaa2', 'aaaaaaaaaaaaaaaaaaaaaaa3'],
  ...over
});
const decide = (over, flagEnabled = true) =>
  regen.reseedDecision({ ad: AD(over), flagEnabled });

const SCOPE = { productId: PRODUCT, brandId: BRAND };
// fileUrl is part of the fixture because it is part of the CONTRACT: a derived
// id is only usable if it resolves to an image the renderer can fetch.
// `over.fileUrl === null` builds the unusable case on purpose; pass fileUrl:''
// for the empty-string variant.
const cat = (id, over = {}) => ({
  _id: id,
  source: 'catalog-product',
  brandId: BRAND,
  fileType: over.fileType || 'image',
  fileUrl: 'fileUrl' in over ? over.fileUrl : `https://cdn.example/${id}.jpg`,
  createdAt: over.createdAt || '2026-01-01T00:00:00Z',
  metadata: { catalogProductId: PRODUCT, ...(over.metadata || {}) }
});
const pick = (list) => regen.pickFirstCatalogMediaId(list, SCOPE);

function loadDeriveFromSource() {
  // Signature MUST consume the destructuring `{ productId, brandId }` so
  // functionBody's "first `{` after the match" is the FUNCTION body, not
  // the parameter object. A too-short regex here evals `{ productId, brandId }`
  // as the body and every R3d check returns undefined.
  const body = functionBody(
    SRC,
    /async function deriveFirstCatalogMediaId\s*\(\s*\{\s*productId,\s*brandId\s*\}\s*\)\s*\{/
  );
  assert.ok(
    body.includes('Media.findOne') && body.includes('isCatalogMediaForProduct'),
    'extracted deriveFirstCatalogMediaId body is the parameter destructure, not the function'
  );
  // eslint-disable-next-line no-new-func
  return new Function(
    'mongoose',
    'Media',
    'isCatalogMediaForProduct',
    `"use strict"; return async function deriveFirstCatalogMediaId({ productId, brandId }) ${body};`
  )(mongooseStub, MediaStub, regen.isCatalogMediaForProduct);
}

(async () => {
  // ── R3: catalog-first reseed GATE ─────────────────────────────────────
  // Regenerating used to REPLAY the stored Ad.mediaIds stack, so an ad queued
  // while DIRECTOR_UNIVERSE_TOP_N was 10 still sent 3+ references on every
  // regen — forever. It now RE-DERIVES the seed. It must NOT be a trim to
  // mediaIds[0]: those stacks were shotType-ranked LIFESTYLE-FIRST over a
  // pool merging catalog media with product_match UGC, so [0] is frequently
  // a UGC post and trimming would lock a social image in as the seed.
  //
  // Money shape is untouched: this changes WHICH image seeds the ad, never
  // how many billable submits happen (still exactly one gpt-image-2/edit).

  check('R3 exported helpers are the live functions (not undefined)', () => {
    assert.strictEqual(typeof regen.reseedDecision, 'function');
    assert.strictEqual(typeof regen.shouldReseedFromCatalog, 'function');
    assert.strictEqual(typeof regen.isRegenReseedCatalogFirstEnabled, 'function');
    assert.strictEqual(typeof regen.isCatalogMediaForProduct, 'function');
    assert.strictEqual(typeof regen.pickFirstCatalogMediaId, 'function');
    assert.ok(regen.RESEED_SKIP && typeof regen.RESEED_SKIP === 'object');
  });

  check('R3 RESEED_SKIP reason codes are the live strings', () => {
    assert.strictEqual(regen.RESEED_SKIP.FLAG_OFF, 'REGEN_RESEED_CATALOG_FIRST=false');
    assert.strictEqual(regen.RESEED_SKIP.VIDEO, 'video regenerate (static-only behaviour)');
    assert.strictEqual(regen.RESEED_SKIP.NOT_PRODUCT_IMAGE,
      'variantKind is not product_image (UGC path is unoptimized — owner)');
    assert.strictEqual(regen.RESEED_SKIP.OPERATOR_REFS,
      'operator referenceMediaIds present (explicit pick always wins)');
    assert.strictEqual(regen.RESEED_SKIP.NO_PRODUCT, 'ad has no productId');
    assert.strictEqual(regen.RESEED_SKIP.NO_CATALOG_MEDIA,
      'no catalog-product Media for this product+brand');
  });

  // (b) THE OWNER GATE, verbatim: "UGC ads shouldn't be affected by this
  // change, we haven't optimized that path yet." A variantKind:'ugc' ad is
  // SUPPOSED to seed from a social image.
  check('R3 variantKind ugc is NEVER re-seeded (owner: UGC path is unoptimized)', () => {
    assert.strictEqual(decide({ variantKind: 'ugc' }).reseed, false);
  });
  check('R3 variantKind ugc skip reason names variantKind', () => {
    assert.strictEqual(decide({ variantKind: 'ugc' }).reason, regen.RESEED_SKIP.NOT_PRODUCT_IMAGE);
  });
  check('R3 a missing variantKind is NOT treated as product_image', () => {
    assert.strictEqual(decide({ variantKind: undefined }).reseed, false);
  });
  check('R3 a missing variantKind skip reason is NOT_PRODUCT_IMAGE', () => {
    assert.strictEqual(decide({ variantKind: undefined }).reason, regen.RESEED_SKIP.NOT_PRODUCT_IMAGE);
  });

  check('R3 product_image with empty referenceMediaIds IS re-seeded', () => {
    assert.strictEqual(decide({}).reseed, true);
  });
  check('R3 re-seeding returns no skip reason', () => {
    assert.strictEqual(decide({}).reason, null);
  });
  check('R3 missing referenceMediaIds (not just empty array) IS re-seeded', () => {
    assert.strictEqual(decide({ referenceMediaIds: undefined }).reseed, true);
  });

  // (c) owner: "unless the user overrides it".
  check('R3 non-empty referenceMediaIds is NEVER re-seeded (operator pick wins)', () => {
    assert.strictEqual(decide({ referenceMediaIds: ['bbbbbbbbbbbbbbbbbbbbbbb1'] }).reseed, false);
  });
  check('R3 operator-override skip reason names referenceMediaIds', () => {
    assert.strictEqual(
      decide({ referenceMediaIds: ['bbbbbbbbbbbbbbbbbbbbbbb1'] }).reason,
      regen.RESEED_SKIP.OPERATOR_REFS
    );
  });

  // (d) nothing to derive from.
  check('R3 no productId is NEVER re-seeded', () => {
    assert.strictEqual(decide({ productId: null }).reseed, false);
  });
  check('R3 no-productId skip reason names productId', () => {
    assert.strictEqual(decide({ productId: null }).reason, regen.RESEED_SKIP.NO_PRODUCT);
  });

  // (a) static only.
  check('R3 a video regenerate is NEVER re-seeded', () => {
    assert.strictEqual(decide({ kind: 'video' }).reseed, false);
  });
  check('R3 video skip reason names video', () => {
    assert.strictEqual(decide({ kind: 'video' }).reason, regen.RESEED_SKIP.VIDEO);
  });

  check('R3 flag off -> NEVER re-seeded', () => {
    assert.strictEqual(decide({}, false).reseed, false);
  });
  check('R3 flag-off skip reason names REGEN_RESEED_CATALOG_FIRST', () => {
    assert.strictEqual(decide({}, false).reason, regen.RESEED_SKIP.FLAG_OFF);
  });

  const savedFlag = process.env.REGEN_RESEED_CATALOG_FIRST;
  try {
    delete process.env.REGEN_RESEED_CATALOG_FIRST;
    check('R3 flag UNSET means ON (the owner asked for this behaviour)', () => {
      assert.strictEqual(regen.isRegenReseedCatalogFirstEnabled(), true);
    });
    process.env.REGEN_RESEED_CATALOG_FIRST = '';
    check('R3 flag EMPTY means ON', () => {
      assert.strictEqual(regen.isRegenReseedCatalogFirstEnabled(), true);
    });
    for (const off of ['false', 'FALSE', '0', 'no', 'off', ' off ']) {
      process.env.REGEN_RESEED_CATALOG_FIRST = off;
      check(`R3 flag ${JSON.stringify(off)} means OFF`, () => {
        assert.strictEqual(regen.isRegenReseedCatalogFirstEnabled(), false);
      });
    }
    for (const on of ['true', '1', 'yes', 'on']) {
      process.env.REGEN_RESEED_CATALOG_FIRST = on;
      check(`R3 flag ${JSON.stringify(on)} means ON`, () => {
        assert.strictEqual(regen.isRegenReseedCatalogFirstEnabled(), true);
      });
    }
    // End-to-end through the gate with the real env read, flag unset.
    delete process.env.REGEN_RESEED_CATALOG_FIRST;
    check('R3 flag unset + product_image + no operator refs -> re-seeded (default ON)', () => {
      assert.strictEqual(regen.shouldReseedFromCatalog({
        ad: AD({}), flagEnabled: regen.isRegenReseedCatalogFirstEnabled()
      }), true);
    });
    process.env.REGEN_RESEED_CATALOG_FIRST = 'false';
    check('R3 flag false + product_image + no operator refs -> NOT re-seeded', () => {
      assert.strictEqual(regen.shouldReseedFromCatalog({
        ad: AD({}), flagEnabled: regen.isRegenReseedCatalogFirstEnabled()
      }), false);
    });
  } finally {
    if (savedFlag === undefined) delete process.env.REGEN_RESEED_CATALOG_FIRST;
    else process.env.REGEN_RESEED_CATALOG_FIRST = savedFlag;
  }

  // ── R3c: a derived id must be USABLE, not merely well-scoped ──────────
  // Found by adversarial review of the original backend diff. The derivation
  // returns only an id; renderDirectImage then loads it and, on finding ZERO
  // resolvable references, silently falls back to media.fileUrl — the ad's
  // ORIGINAL seed, which on exactly the historical rows this feature exists
  // to fix is frequently the UGC/lifestyle image.
  {
    const noUrl    = cat('no_url',    { fileUrl: null, metadata: { imageRole: 'hero' } });
    const blankUrl = cat('blank_url', { fileUrl: '   ', metadata: { imageRole: 'hero' } });
    const good     = cat('good_alt',  { createdAt: '2026-09-01T00:00:00Z' });

    check('R3c a hero doc with a NULL fileUrl is not selectable', () => {
      assert.strictEqual(pick([noUrl]), null);
    });
    check('R3c a hero doc with a whitespace-only fileUrl is not selectable', () => {
      assert.strictEqual(pick([blankUrl]), null);
    });
    check('R3c an unusable hero does not shadow a usable catalog image — tier 2 still wins', () => {
      assert.strictEqual(pick([noUrl, good])?.mediaId, 'good_alt');
    });
    check('R3c a catalog VIDEO is never selectable as the first catalog IMAGE', () => {
      assert.strictEqual(pick([cat('vid', { fileType: 'video', metadata: { imageRole: 'video' } })]), null);
    });
    check('R3c the imageRole video stamp alone also disqualifies', () => {
      assert.strictEqual(pick([cat('vid2', { metadata: { imageRole: 'video' } })]), null);
    });
    check('R3c a video does not shadow a usable image', () => {
      assert.strictEqual(
        pick([cat('vid3', { fileType: 'video', createdAt: '2020-01-01T00:00:00Z' }), good])?.mediaId,
        'good_alt'
      );
    });
    check('R3c a legacy catalog image with absent fileType is still selectable', () => {
      const legacy = cat('legacy_untyped', { createdAt: '2026-02-01T00:00:00Z' });
      delete legacy.fileType;
      assert.strictEqual(pick([legacy])?.mediaId, 'legacy_untyped');
    });
  }

  // ── R3b: the tier cascade ─────────────────────────────────────────────
  const heroLate  = cat('hero_late',  { createdAt: '2026-06-01T00:00:00Z', metadata: { imageRole: 'hero' } });
  const altEarly  = cat('alt_early',  { createdAt: '2026-01-01T00:00:00Z', metadata: { imageRole: 'alt' } });
  check('R3b tier 1 (imageRole hero) beats tier 2 even when it is the newest doc', () => {
    assert.strictEqual(pick([altEarly, heroLate])?.mediaId, 'hero_late');
  });
  check('R3b tier 1 reports tier "hero"', () => {
    assert.strictEqual(pick([altEarly, heroLate])?.tier, 'hero');
  });

  const a2 = cat('alt_2026_03', { createdAt: '2026-03-01T00:00:00Z', metadata: { imageRole: 'alt' } });
  const a1 = cat('alt_2026_01', { createdAt: '2026-01-15T00:00:00Z', metadata: { imageRole: 'alt' } });
  const a3 = cat('alt_2026_09', { createdAt: '2026-09-01T00:00:00Z', metadata: { imageRole: 'alt' } });
  check('R3b tier 2 is used when no doc carries the hero stamp', () => {
    assert.strictEqual(pick([a2, a1, a3])?.mediaId, 'alt_2026_01');
  });
  check('R3b tier 2 is order-independent (reversed input, same winner)', () => {
    assert.strictEqual(pick([a3, a2, a1])?.mediaId, 'alt_2026_01');
  });
  check('R3b tier 2 reports tier "earliest-createdAt"', () => {
    assert.strictEqual(pick([a2, a1, a3])?.tier, 'earliest-createdAt');
  });
  check('R3b tier 2 ties break to input/feed order (strict <, not <=)', () => {
    const t1 = cat('tie_first',  { createdAt: '2026-05-01T00:00:00Z', metadata: { imageRole: 'alt' } });
    const t2 = cat('tie_second', { createdAt: '2026-05-01T00:00:00Z', metadata: { imageRole: 'alt' } });
    assert.strictEqual(pick([t1, t2])?.mediaId, 'tie_first');
    assert.strictEqual(pick([t2, t1])?.mediaId, 'tie_second');
  });

  check('R3b tier 3: an empty candidate list derives NOTHING', () => {
    assert.strictEqual(pick([]), null);
  });
  check('R3b tier 3: a list with no catalog media derives NOTHING', () => {
    assert.strictEqual(pick([{
      _id: 'ugc_1', source: 'instagram', brandId: BRAND,
      metadata: { catalogProductId: PRODUCT }
    }]), null);
  });

  // THE CENTRAL SAFETY PROPERTY. A UGC doc must be unselectable no matter
  // what metadata it carries — including the hero stamp, which is exactly
  // the trap that querying imageRole alone would fall into.
  const ugcHero = {
    _id: 'ugc_hero', source: 'instagram', brandId: BRAND,
    createdAt: '2020-01-01T00:00:00Z',
    metadata: { catalogProductId: PRODUCT, imageRole: 'hero' }
  };
  check('R3b a UGC doc stamped imageRole:hero can NEVER be selected', () => {
    assert.strictEqual(pick([ugcHero, a2])?.mediaId, 'alt_2026_03');
  });
  check('R3b a UGC doc is not selected even when it is the ONLY candidate', () => {
    assert.strictEqual(pick([ugcHero]), null);
  });
  check('R3b every non-catalog source is rejected', () => {
    assert.ok(['instagram', 'tiktok', 'upload', 'brand-site', 'competitor', null, undefined]
      .every((src) => pick([{ ...ugcHero, source: src }]) === null));
  });
  check('R3b the guard rejects any non-catalog source directly', () => {
    assert.strictEqual(regen.isCatalogMediaForProduct(ugcHero, SCOPE), false);
  });

  check('R3b a catalog doc for a DIFFERENT product is rejected', () => {
    assert.strictEqual(pick([cat('other_product', {
      metadata: { catalogProductId: 'ffffffffffffffffffffffff', imageRole: 'hero' }
    })]), null);
  });
  check('R3b a catalog doc for a DIFFERENT brand is rejected (cross-tenant)', () => {
    assert.strictEqual(pick([{
      ...cat('other_brand', { metadata: { imageRole: 'hero' } }),
      brandId: 'ffffffffffffffffffffffff'
    }]), null);
  });
  check('R3b a catalog doc with no catalogProductId is rejected', () => {
    assert.strictEqual(pick([cat('no_product', {
      metadata: { catalogProductId: null, imageRole: 'hero' }
    })]), null);
  });
  check('R3b a catalog doc with no brandId is rejected', () => {
    assert.strictEqual(pick([{
      ...cat('no_brand', { metadata: { imageRole: 'hero' } }),
      brandId: null
    }]), null);
  });
  check('R3b ids compare by string, so ObjectId-vs-string never causes a miss', () => {
    assert.strictEqual(
      regen.isCatalogMediaForProduct(cat('str_ok'), {
        productId: { toString: () => PRODUCT },
        brandId: { toString: () => BRAND }
      }),
      true
    );
  });

  // Built literally, NOT via cat(), because cat()'s `||` default would coerce
  // a null createdAt back to a real date and silently defeat the assertion.
  const noTs = {
    _id: 'no_ts', source: 'catalog-product', brandId: BRAND,
    fileType: 'image', fileUrl: 'https://cdn.example/no_ts.jpg',
    createdAt: null, metadata: { catalogProductId: PRODUCT, imageRole: 'alt' }
  };
  check('R3b a doc with no createdAt loses tier 2 to a stamped doc', () => {
    assert.strictEqual(pick([noTs, a3])?.mediaId, 'alt_2026_09');
  });
  check('R3b a doc with no createdAt is still selectable when it is the only one', () => {
    assert.strictEqual(pick([noTs])?.mediaId, 'no_ts');
  });

  // ── R3d: deriveFirstCatalogMediaId query-shape + smoke ────────────────
  // Not exported (exporting would change the production file hash and trip
  // vendor-drift). The live body is evaluated with injected mongoose/Media
  // so a SELECT/scope change in the real function is what this group sees.
  // MiniCollection has no findOne, so a custom recording stub honours
  // .select() — without that, dropping fileUrl from SELECT would stay
  // invisible (the guard would see the unprojected field as undefined and
  // reject a perfectly-usable hero, falling through to tier 3 / UGC seed).

  check('R3d deriveFirstCatalogMediaId is NOT on module.exports (query-shape covered here, not by adding an export)', () => {
    assert.strictEqual(typeof regen.deriveFirstCatalogMediaId, 'undefined');
  });
  check('R3d runImage is the live caller of deriveFirstCatalogMediaId', () => {
    const runImageBody = functionBody(SRC, /async function runImage\s*\(/);
    assert.ok(
      /deriveFirstCatalogMediaId\s*\(\s*\{\s*productId:\s*ad\.productId/.test(runImageBody),
      'runImage must call deriveFirstCatalogMediaId with the ad\'s productId/brandId'
    );
    assert.ok(
      runImageBody.includes('RESEED_SKIP.NO_CATALOG_MEDIA'),
      'tier-3 (nothing derived) must log NO_CATALOG_MEDIA, not silently keep the UGC stack under a success log'
    );
  });

  const derive = loadDeriveFromSource();

  await checkAsync('R3d missing productId returns null with zero Media queries', async () => {
    resetMedia();
    const got = await derive({ productId: null, brandId: BRAND });
    assert.strictEqual(got, null);
    assert.strictEqual(mediaCalls.length, 0);
  });
  await checkAsync('R3d missing brandId returns null with zero Media queries', async () => {
    resetMedia();
    const got = await derive({ productId: PRODUCT, brandId: null });
    assert.strictEqual(got, null);
    assert.strictEqual(mediaCalls.length, 0);
  });
  await checkAsync('R3d an invalid ObjectId returns null (fail closed, no query)', async () => {
    resetMedia();
    const got = await derive({ productId: 'not-an-objectid', brandId: BRAND });
    assert.strictEqual(got, null);
    assert.strictEqual(mediaCalls.length, 0);
  });

  const heroDoc = {
    _id: 'hero_media',
    source: 'catalog-product',
    brandId: BRAND,
    fileType: 'image',
    fileUrl: 'https://cdn.example/hero.jpg',
    createdAt: '2026-06-01T00:00:00Z',
    metadata: { catalogProductId: PRODUCT, imageRole: 'hero' }
  };
  const earliestDoc = {
    _id: 'early_media',
    source: 'catalog-product',
    brandId: BRAND,
    fileType: 'image',
    fileUrl: 'https://cdn.example/early.jpg',
    createdAt: '2026-01-01T00:00:00Z',
    metadata: { catalogProductId: PRODUCT, imageRole: 'alt' }
  };

  await checkAsync('R3d tier-1 hero query: source + brand + product + fileType $ne video + imageRole hero', async () => {
    resetMedia();
    mediaResponses = [heroDoc];
    const got = await derive({ productId: PRODUCT, brandId: BRAND });
    assert.deepStrictEqual(got, { mediaId: 'hero_media', tier: 'hero' });
    assert.strictEqual(mediaCalls.length, 1, 'hero hit must not also run the earliest query');
    const f = mediaCalls[0].filter;
    assert.strictEqual(f.source, 'catalog-product');
    assert.strictEqual(String(f.brandId), BRAND);
    assert.strictEqual(String(f['metadata.catalogProductId']), PRODUCT);
    assert.deepStrictEqual(f.fileType, { $ne: 'video' });
    assert.strictEqual(f['metadata.imageRole'], 'hero');
  });

  await checkAsync('R3d both findOne calls project fileType AND fileUrl (silent UGC-seed hole if dropped)', async () => {
    resetMedia();
    mediaResponses = [heroDoc];
    await derive({ productId: PRODUCT, brandId: BRAND });
    const sel = String(mediaCalls[0].selectArg || '');
    const fields = sel.trim().split(/\s+/);
    for (const need of ['_id', 'source', 'brandId', 'fileType', 'fileUrl', 'metadata', 'createdAt']) {
      assert.ok(fields.includes(need), `SELECT missing ${need}: ${sel}`);
    }
  });

  await checkAsync('R3d honouring .select(): a hero whose fileUrl is not projected is rejected (would otherwise silently pass)', async () => {
    // Prove the projection is load-bearing: if SELECT omitted fileUrl, the
    // stub would strip it and the guard would reject a usable hero. We
    // simulate that omission by returning a doc that only has the fields
    // a broken SELECT would leave.
    resetMedia();
    const broken = { _id: 'hero_media', source: 'catalog-product', brandId: BRAND, metadata: { catalogProductId: PRODUCT, imageRole: 'hero' } };
    mediaResponses = [broken, earliestDoc];
    const got = await derive({ productId: PRODUCT, brandId: BRAND });
    // First call (hero) is unusable without fileUrl → fall through to earliest.
    assert.deepStrictEqual(got, { mediaId: 'early_media', tier: 'earliest-createdAt' });
    assert.strictEqual(mediaCalls.length, 2);
  });

  await checkAsync('R3d tier-2 earliest query sorts createdAt:1 and does NOT re-filter imageRole', async () => {
    resetMedia();
    mediaResponses = [null, earliestDoc];
    const got = await derive({ productId: PRODUCT, brandId: BRAND });
    assert.deepStrictEqual(got, { mediaId: 'early_media', tier: 'earliest-createdAt' });
    assert.strictEqual(mediaCalls.length, 2);
    const f = mediaCalls[1].filter;
    assert.strictEqual(f.source, 'catalog-product');
    assert.strictEqual(String(f.brandId), BRAND);
    assert.strictEqual(String(f['metadata.catalogProductId']), PRODUCT);
    assert.deepStrictEqual(f.fileType, { $ne: 'video' });
    assert.ok(!('metadata.imageRole' in f), 'earliest query must not require the hero stamp');
    assert.deepStrictEqual(mediaCalls[1].sortArg, { createdAt: 1 });
    const sel = String(mediaCalls[1].selectArg || '');
    assert.ok(sel.split(/\s+/).includes('fileType'));
    assert.ok(sel.split(/\s+/).includes('fileUrl'));
  });

  await checkAsync('R3d tier-3: both queries empty → null (honest skip, not UGC fallback)', async () => {
    resetMedia();
    mediaResponses = [null, null];
    const got = await derive({ productId: PRODUCT, brandId: BRAND });
    assert.strictEqual(got, null);
    assert.strictEqual(mediaCalls.length, 2);
  });

  await checkAsync('R3d mongoose.Types.ObjectId conversion is used (Mixed metadata path does not auto-cast)', async () => {
    resetMedia();
    mediaResponses = [heroDoc];
    await derive({ productId: PRODUCT, brandId: BRAND });
    const f = mediaCalls[0].filter;
    assert.ok(f.brandId instanceof ObjectId, 'brandId must be an ObjectId, not a raw string');
    assert.ok(f['metadata.catalogProductId'] instanceof ObjectId,
      'metadata.catalogProductId must be an ObjectId — mongoose does not cast inside Mixed');
  });

  // Report
  console.log('verifyRegenCatalogFirstReseed');
  if (failures.length) {
    console.error(`\n❌ verifyRegenCatalogFirstReseed: ${failures.length} of ${checks + failures.length} checks FAILED\n`);
    failures.forEach((f) => console.error(`  ✗ ${f}`));
    restore();
    process.exit(1);
  }
  console.log(`✅ verifyRegenCatalogFirstReseed: ${checks}/${checks} checks passed`);
  restore();
  process.exit(0);
})().catch((err) => {
  restore();
  console.error(err);
  process.exit(1);
});
