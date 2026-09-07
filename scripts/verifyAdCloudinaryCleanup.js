#!/usr/bin/env node
'use strict';
//
// verifyAdCloudinaryCleanup — MONEY-adjacent Cloudinary hygiene for Ad
// delete, campaign cascade, and (adgen) regenerate.
//
// WHAT THIS PINS
// --------------
// 1. collectAdCloudinaryUrls gathers renderUrl, veoVideoUrl,
//    visionQc.attempts[].renderUrl/discardedRenderUrl, and an independent
//    posterUrl; a so_2,f_jpg transform of this ad's own video is skipped.
// 2. destroyUnsharedAdAssets destroys a distinct unshared veoVideoUrl.
// 3. It does NOT destroy a URL still held as renderUrl or veoVideoUrl on
//    another Ad — Meta-family AND PMax-family (the previous DELETE route
//    only protected PMax).
// 4. visionQc attempt URLs are collected and destroyed when unshared.
// 5. cascadeDeleteCampaign uses collectAdCloudinaryUrls (so veoVideoUrl
//    is in the collected set).
// 6. Shared-ref lookup fails CLOSED (keeps the asset).
// 7. DELETE /api/ads/:id routes through destroyUnsharedAdAssets and no
//    longer names PMax format constants.
//
// Revert-prove (each mutation must fail this harness):
//   1. Drop veoVideoUrl from collectAdCloudinaryUrls          → A2
//   2. Drop visionQc attempt collection                       → A3
//   3. Collect a so_2,f_jpg transform poster                  → A4
//   3b Skip an independent ai_video_poster upload             → A4b
//   9. Destroy previous titled renderUrl when current delivery
//      is still the raw master (renderUrl === veoVideoUrl)    → F1
//  10. Dedup-by-pid before shared-ref (two URLs, one shared)  → F2
//  11. pidFromStored on titled renderUrl destroys the master  → F2b
//   4. destroyUnsharedAdAssets always destroy, skip shared check → B2/B3
//   5. Shared check only looks at renderUrl (not veoVideoUrl) → B2b
//   6. Lookup throw destroys anyway                           → B4
//   7. cascadeDeleteCampaign goes back to renderUrl+posterUrl → C1/C2
//   8. DELETE route inlines deleteFromCloudinary(ad.renderUrl)→ D1/D2
//
// Pure + offline: no DB, no network, no API key.
//   node scripts/verifyAdCloudinaryCleanup.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const H = require('../services/adCloudinaryCleanup');

let passed = 0;
const failures = [];
function check(label, fn) {
  try {
    const out = fn();
    if (out && typeof out.then === 'function') {
      throw new Error(`${label}: async check used check() — use checkAsync`);
    }
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}\n     ${err.message}`);
    console.log(`  ✗ ${label} — ${err.message.split('\n')[0].slice(0, 240)}`);
  }
}
async function checkAsync(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}\n     ${err.message}`);
    console.log(`  ✗ ${label} — ${err.message.split('\n')[0].slice(0, 240)}`);
  }
}

const CLD = 'https://res.cloudinary.com/demo';
function videoUrl(id) {
  return `${CLD}/video/upload/v1/liquidretail/${id}.mp4`;
}
function imageUrl(id) {
  return `${CLD}/image/upload/v1/liquidretail/${id}.png`;
}

function makeAdModel(docs) {
  return {
    findOne(filter) {
      const found = docs.find((d) => matchDoc(d, filter)) || null;
      const q = {
        select() { return q; },
        lean() { return Promise.resolve(found); },
        then(onF, onR) { return Promise.resolve(found).then(onF, onR); }
      };
      return q;
    }
  };
}

function matchDoc(d, filter) {
  if (filter._id && filter._id.$ne != null && String(d._id) === String(filter._id.$ne)) {
    return false;
  }
  if (filter.campaignId != null && String(d.campaignId) !== String(filter.campaignId)) {
    return false;
  }
  if (filter.brandId != null && String(d.brandId) !== String(filter.brandId)) {
    return false;
  }
  if (Array.isArray(filter.$or)) {
    const ok = filter.$or.some((clause) => Object.entries(clause).every(([k, v]) => d[k] === v));
    if (!ok) return false;
  }
  return true;
}

function trackingDestroy() {
  const calls = [];
  async function deleteFromCloudinary(url) {
    calls.push(url);
    return { result: 'ok', url };
  }
  return { calls, deleteFromCloudinary, publicIdFromUrl: H.publicIdsHeldByAd && require('../services/cloudinaryService').publicIdFromUrl };
}

const { publicIdFromUrl } = require('../services/cloudinaryService');

(async () => {
  console.log('\n== A. collectAdCloudinaryUrls ==');

  check('A1 empty / null ad → []', () => {
    assert.deepStrictEqual(H.collectAdCloudinaryUrls(null), []);
    assert.deepStrictEqual(H.collectAdCloudinaryUrls({}), []);
  });

  check('A2 collects distinct renderUrl AND veoVideoUrl', () => {
    const urls = H.collectAdCloudinaryUrls({
      renderUrl: videoUrl('titled'),
      veoVideoUrl: videoUrl('master')
    });
    assert.ok(urls.includes(videoUrl('titled')), 'missing renderUrl');
    assert.ok(urls.includes(videoUrl('master')), 'missing veoVideoUrl');
    assert.strictEqual(urls.length, 2);
  });

  check('A3 collects visionQc.attempts[].renderUrl and discardedRenderUrl', () => {
    const urls = H.collectAdCloudinaryUrls({
      renderUrl: imageUrl('final'),
      visionQc: {
        attempts: [
          { renderUrl: imageUrl('a1'), discardedRenderUrl: imageUrl('a1'), discarded: true },
          { renderUrl: imageUrl('a2'), discarded: false }
        ]
      }
    });
    assert.ok(urls.includes(imageUrl('final')));
    assert.ok(urls.includes(imageUrl('a1')));
    assert.ok(urls.includes(imageUrl('a2')));
  });

  check('A4 does NOT collect a so_2,f_jpg transform of this ad\'s own video', () => {
    const master = videoUrl('master');
    const poster = `${CLD}/video/upload/so_2,f_jpg,q_auto:good/v1/liquidretail/master.jpg`;
    const urls = H.collectAdCloudinaryUrls({
      renderUrl: videoUrl('titled'),
      veoVideoUrl: master,
      posterUrl: poster
    });
    assert.ok(!urls.includes(poster), `transform posterUrl was collected: ${urls.join(',')}`);
  });

  check('A4b [F3] DOES collect an independent aiVideoPosterService-style posterUrl', () => {
    const independent = `${CLD}/image/upload/v1/liquidretail/ai_video_poster/xyz.png`;
    const urls = H.collectAdCloudinaryUrls({
      renderUrl: videoUrl('titled'),
      veoVideoUrl: videoUrl('master'),
      posterUrl: independent
    });
    assert.ok(urls.includes(independent), `independent posterUrl was dropped: ${urls.join(',')}`);
  });

  check('A5 de-dupes identical renderUrl === veoVideoUrl (inherited plate)', () => {
    const u = videoUrl('shared');
    const urls = H.collectAdCloudinaryUrls({ renderUrl: u, veoVideoUrl: u });
    assert.deepStrictEqual(urls, [u]);
  });

  check('A6 ignores non-Cloudinary hosts', () => {
    const urls = H.collectAdCloudinaryUrls({
      renderUrl: 'https://cdn.example/foo.mp4',
      veoVideoUrl: videoUrl('master')
    });
    assert.deepStrictEqual(urls, [videoUrl('master')]);
  });

  console.log('\n== B. destroyUnsharedAdAssets [MONEY] ==');

  await checkAsync('B1 [MONEY] destroys veoVideoUrl when distinct from renderUrl and unshared', async () => {
    const ad = {
      _id: 'ad-master',
      campaignId: 'camp-1',
      brandId: 'brand-1',
      kind: 'video',
      renderUrl: videoUrl('titled'),
      veoVideoUrl: videoUrl('master')
    };
    const calls = [];
    const results = await H.destroyUnsharedAdAssets(ad, {
      Ad: makeAdModel([ad]),
      deleteFromCloudinary: async (url) => { calls.push(url); return { result: 'ok' }; },
      publicIdFromUrl,
      excludeAdId: ad._id,
      campaignId: ad.campaignId,
      brandId: ad.brandId
    });
    assert.ok(calls.includes(videoUrl('titled')), `did not destroy titled: ${calls}`);
    assert.ok(calls.includes(videoUrl('master')), `did not destroy master: ${calls}`);
    assert.ok(results.every((r) => r.result === 'ok' || r.reason !== 'still-referenced'));
  });

  await checkAsync('B2 [MONEY] Meta: does NOT destroy a plate still on a derive sibling (renderUrl)', async () => {
    const masterUrl = videoUrl('meta-plate');
    const master = {
      _id: 'ad-meta-master',
      campaignId: 'camp-1',
      brandId: 'brand-1',
      kind: 'video',
      platformFormat: 'meta_stories_9_16',
      renderUrl: videoUrl('meta-titled'),
      veoVideoUrl: masterUrl
    };
    const sibling = {
      _id: 'ad-meta-feed',
      campaignId: 'camp-1',
      brandId: 'brand-1',
      kind: 'video',
      platformFormat: 'meta_feed_1_1',
      renderUrl: masterUrl,
      veoVideoUrl: masterUrl
    };
    const calls = [];
    const results = await H.destroyUnsharedAdAssets(master, {
      Ad: makeAdModel([master, sibling]),
      deleteFromCloudinary: async (url) => { calls.push(url); return { result: 'ok' }; },
      publicIdFromUrl,
      excludeAdId: master._id,
      campaignId: master.campaignId,
      brandId: master.brandId
    });
    assert.ok(!calls.includes(masterUrl), `destroyed shared Meta plate: ${calls}`);
    const skipped = results.find((r) => r.url === masterUrl);
    assert.ok(skipped && skipped.reason === 'still-referenced', `expected still-referenced, got ${JSON.stringify(skipped)}`);
    assert.ok(calls.includes(videoUrl('meta-titled')), 'master titled output should still be destroyed');
  });

  await checkAsync('B2b [MONEY] Meta mixed-run: sibling holding the plate as veoVideoUrl (not renderUrl) is enough to keep it', async () => {
    const plate = videoUrl('shared-portrait');
    const master = {
      _id: 'ad-stories',
      campaignId: 'camp-1',
      brandId: 'brand-1',
      kind: 'video',
      renderUrl: videoUrl('stories-titled'),
      veoVideoUrl: plate
    };
    const pmaxChild = {
      _id: 'ad-pmax-9-16',
      campaignId: 'camp-1',
      brandId: 'brand-1',
      kind: 'video',
      platformFormat: 'pmax_video_9_16',
      renderUrl: videoUrl('pmax-titled'),
      veoVideoUrl: plate
    };
    const calls = [];
    await H.destroyUnsharedAdAssets(master, {
      Ad: makeAdModel([master, pmaxChild]),
      deleteFromCloudinary: async (url) => { calls.push(url); return { result: 'ok' }; },
      publicIdFromUrl,
      excludeAdId: master._id,
      campaignId: master.campaignId,
      brandId: master.brandId
    });
    assert.ok(!calls.includes(plate), `destroyed mixed-run shared plate: ${calls}`);
  });

  await checkAsync('B3 [MONEY] PMax: does NOT destroy a 9:16 plate still on a 1:1 derive sibling', async () => {
    const plate = videoUrl('pmax-9-16-plate');
    const master = {
      _id: 'ad-pmax-9',
      campaignId: 'camp-1',
      brandId: 'brand-1',
      kind: 'video',
      platformFormat: 'pmax_video_9_16',
      renderUrl: videoUrl('pmax-9-titled'),
      veoVideoUrl: plate
    };
    const square = {
      _id: 'ad-pmax-1-1',
      campaignId: 'camp-1',
      brandId: 'brand-1',
      kind: 'video',
      platformFormat: 'pmax_video_1_1',
      renderUrl: plate,
      veoVideoUrl: plate
    };
    const calls = [];
    const results = await H.destroyUnsharedAdAssets(master, {
      Ad: makeAdModel([master, square]),
      deleteFromCloudinary: async (url) => { calls.push(url); return { result: 'ok' }; },
      publicIdFromUrl,
      excludeAdId: master._id,
      campaignId: master.campaignId,
      brandId: master.brandId
    });
    assert.ok(!calls.includes(plate), `destroyed shared PMax plate: ${calls}`);
    assert.strictEqual(results.find((r) => r.url === plate).reason, 'still-referenced');
  });

  await checkAsync('B3b visionQc attempt URLs are destroyed when unshared', async () => {
    const ad = {
      _id: 'ad-static',
      campaignId: 'camp-1',
      brandId: 'brand-1',
      kind: 'image',
      renderUrl: imageUrl('final'),
      visionQc: {
        attempts: [
          { renderUrl: imageUrl('qc1'), discardedRenderUrl: imageUrl('qc1'), discarded: true },
          { renderUrl: imageUrl('final'), discarded: false }
        ]
      }
    };
    const calls = [];
    await H.destroyUnsharedAdAssets(ad, {
      Ad: makeAdModel([ad]),
      deleteFromCloudinary: async (url) => { calls.push(url); return { result: 'ok' }; },
      publicIdFromUrl,
      excludeAdId: ad._id
    });
    assert.ok(calls.includes(imageUrl('final')));
    assert.ok(calls.includes(imageUrl('qc1')), `qc attempt not destroyed: ${calls}`);
  });

  await checkAsync('B4 [MONEY] lookup throw → keep asset (fail closed)', async () => {
    const ad = {
      _id: 'ad-x',
      campaignId: 'camp-1',
      brandId: 'brand-1',
      renderUrl: videoUrl('only')
    };
    const calls = [];
    let lookupErrs = 0;
    const results = await H.destroyUnsharedAdAssets(ad, {
      Ad: {
        findOne() {
          return {
            select() { return this; },
            lean() { return Promise.reject(new Error('mongo down')); }
          };
        }
      },
      deleteFromCloudinary: async (url) => { calls.push(url); return { result: 'ok' }; },
      publicIdFromUrl,
      onLookupError: () => { lookupErrs += 1; },
      excludeAdId: ad._id
    });
    assert.strictEqual(calls.length, 0, `destroyed despite lookup failure: ${calls}`);
    assert.ok(lookupErrs >= 1);
    assert.ok(results.every((r) => r.reason === 'still-referenced'));
  });

  await checkAsync('B5 destroyReplacedAdAssets skips the same public_id the current ad still holds (static overwrite)', async () => {
    const oldUrl = `${CLD}/image/upload/v111/liquidretail/ad_renders/abc.png`;
    const newUrl = `${CLD}/image/upload/v222/liquidretail/ad_renders/abc.png`;
    const previousAd = {
      _id: 'ad-static',
      campaignId: 'camp-1',
      brandId: 'brand-1',
      kind: 'image',
      renderUrl: oldUrl,
      cloudinaryPublicId: 'liquidretail/ad_renders/abc'
    };
    const currentAd = {
      _id: 'ad-static',
      campaignId: 'camp-1',
      brandId: 'brand-1',
      kind: 'image',
      renderUrl: newUrl,
      cloudinaryPublicId: 'liquidretail/ad_renders/abc'
    };
    const calls = [];
    const results = await H.destroyReplacedAdAssets({
      previousAd,
      currentAd,
      Ad: makeAdModel([currentAd]),
      deleteFromCloudinary: async (url) => { calls.push(url); return { result: 'ok' }; },
      publicIdFromUrl
    });
    assert.strictEqual(calls.length, 0, `destroyed overwritten public_id: ${calls}`);
    assert.ok(results.some((r) => r.reason === 'still-current-public-id'));
  });

  await checkAsync('B6 destroyReplacedAdAssets DOES destroy the old video master after a new unique public_id lands', async () => {
    const previousAd = {
      _id: 'ad-vid',
      campaignId: 'camp-1',
      brandId: 'brand-1',
      kind: 'video',
      renderUrl: videoUrl('old-titled'),
      veoVideoUrl: videoUrl('old-master')
    };
    const currentAd = {
      _id: 'ad-vid',
      campaignId: 'camp-1',
      brandId: 'brand-1',
      kind: 'video',
      renderUrl: videoUrl('new-titled'),
      veoVideoUrl: videoUrl('new-master')
    };
    const calls = [];
    await H.destroyReplacedAdAssets({
      previousAd,
      currentAd,
      Ad: makeAdModel([currentAd]),
      deleteFromCloudinary: async (url) => { calls.push(url); return { result: 'ok' }; },
      publicIdFromUrl
    });
    assert.ok(calls.includes(videoUrl('old-titled')), `missing old titled: ${calls}`);
    assert.ok(calls.includes(videoUrl('old-master')), `missing old master: ${calls}`);
    assert.ok(!calls.includes(videoUrl('new-titled')));
    assert.ok(!calls.includes(videoUrl('new-master')));
  });

  await checkAsync('B7 destroyReplacedAdAssets does NOT destroy the old plate a sibling still holds', async () => {
    const oldPlate = videoUrl('old-master');
    const previousAd = {
      _id: 'ad-vid',
      campaignId: 'camp-1',
      brandId: 'brand-1',
      kind: 'video',
      renderUrl: videoUrl('old-titled'),
      veoVideoUrl: oldPlate
    };
    const currentAd = {
      _id: 'ad-vid',
      campaignId: 'camp-1',
      brandId: 'brand-1',
      kind: 'video',
      renderUrl: videoUrl('new-titled'),
      veoVideoUrl: videoUrl('new-master')
    };
    const sibling = {
      _id: 'ad-feed',
      campaignId: 'camp-1',
      brandId: 'brand-1',
      renderUrl: oldPlate,
      veoVideoUrl: oldPlate
    };
    const calls = [];
    await H.destroyReplacedAdAssets({
      previousAd,
      currentAd,
      Ad: makeAdModel([currentAd, sibling]),
      deleteFromCloudinary: async (url) => { calls.push(url); return { result: 'ok' }; },
      publicIdFromUrl
    });
    assert.ok(!calls.includes(oldPlate), `destroyed sibling-held old plate: ${calls}`);
    assert.ok(calls.includes(videoUrl('old-titled')));
  });

  await checkAsync('F1 [MONEY] untitled fallback (renderUrl === veoVideoUrl) does NOT destroy the previous titled video', async () => {
    const previousAd = {
      _id: 'ad-vid', campaignId: 'camp-1', brandId: 'brand-1', kind: 'video',
      renderUrl: videoUrl('old-titled'),
      veoVideoUrl: videoUrl('old-master')
    };
    const currentAd = {
      _id: 'ad-vid', campaignId: 'camp-1', brandId: 'brand-1', kind: 'video',
      renderUrl: videoUrl('new-master'),
      veoVideoUrl: videoUrl('new-master')
    };
    const calls = [];
    const results = await H.destroyReplacedAdAssets({
      previousAd, currentAd,
      Ad: makeAdModel([currentAd]),
      deleteFromCloudinary: async (url) => { calls.push(url); return { result: 'ok' }; },
      publicIdFromUrl
    });
    assert.ok(!calls.includes(videoUrl('old-titled')), `destroyed last-known-good titled video: ${calls}`);
    assert.ok(calls.includes(videoUrl('old-master')), `old raw master should still go: ${calls}`);
    assert.ok(results.some((r) => r.url === videoUrl('old-titled') && r.result === 'skipped'));
  });

  await checkAsync('F1b [MONEY] no-chrome / no-brand / cap-exceeded all share the untitled-delivery shape', async () => {
    const keep = H.previousTitledDeliveryToKeep(
      { kind: 'video', renderUrl: videoUrl('old-titled'), veoVideoUrl: videoUrl('old-master') },
      { kind: 'video', renderUrl: videoUrl('new-master'), veoVideoUrl: videoUrl('new-master') }
    );
    assert.strictEqual(keep, videoUrl('old-titled'));
    const afterSuccess = H.previousTitledDeliveryToKeep(
      { kind: 'video', renderUrl: videoUrl('old-titled'), veoVideoUrl: videoUrl('old-master') },
      { kind: 'video', renderUrl: videoUrl('new-titled'), veoVideoUrl: videoUrl('new-master') }
    );
    assert.strictEqual(afterSuccess, null);
    const alreadyUntitled = H.previousTitledDeliveryToKeep(
      { kind: 'video', renderUrl: videoUrl('old-master'), veoVideoUrl: videoUrl('old-master') },
      { kind: 'video', renderUrl: videoUrl('new-master'), veoVideoUrl: videoUrl('new-master') }
    );
    assert.strictEqual(alreadyUntitled, null);
  });

  await checkAsync('F2 [MONEY] two URLs same public_id, only one exact string is shared → pid is kept', async () => {
    const pid = 'liquidretail/shared-plate';
    const v111 = `${CLD}/video/upload/v111/${pid}.mp4`;
    const v222 = `${CLD}/video/upload/v222/${pid}.mp4`;
    const ad = {
      _id: 'ad-master', campaignId: 'camp-1', brandId: 'brand-1', kind: 'video',
      renderUrl: v222,
      veoVideoUrl: v111
    };
    const sibling = {
      _id: 'ad-feed', campaignId: 'camp-1', brandId: 'brand-1',
      renderUrl: v111,
      veoVideoUrl: v111
    };
    const calls = [];
    const results = await H.destroyUnsharedAdAssets(ad, {
      Ad: makeAdModel([ad, sibling]),
      deleteFromCloudinary: async (url) => { calls.push(url); return { result: 'ok' }; },
      publicIdFromUrl,
      excludeAdId: ad._id,
      campaignId: ad.campaignId,
      brandId: ad.brandId
    });
    assert.strictEqual(calls.length, 0, `destroyed a pid still referenced via a different version URL: ${calls}`);
    assert.ok(results.some((r) => r.reason === 'still-referenced' || r.reason === 'same-public-id-still-referenced'));
  });

  await checkAsync('F2b pidFromStored must not destroy the raw master off a titled/unparseable renderUrl', async () => {
    const masterPid = 'liquidretail/raw-master';
    const unparsedRender = `${CLD}/video/upload/${masterPid}`;
    const ad = {
      _id: 'ad-vid', campaignId: 'camp-1', brandId: 'brand-1', kind: 'video',
      renderUrl: unparsedRender,
      veoVideoUrl: videoUrl('other'),
      cloudinaryPublicId: masterPid
    };
    const pidCalls = [];
    await H.destroyUnsharedAdAssets(ad, {
      Ad: makeAdModel([ad]),
      deleteFromCloudinary: async (url) => ({ result: 'ok', url }),
      deletePublicIdFromCloudinary: async (pid) => { pidCalls.push(pid); return { result: 'ok', pid }; },
      publicIdFromUrl,
      excludeAdId: ad._id
    });
    assert.ok(!pidCalls.includes(masterPid), `pidFromStored fired on titled/unparseable renderUrl: ${pidCalls}`);
  });

  await checkAsync('F3 independent posterUrl is destroyed when unshared', async () => {
    const independent = `${CLD}/image/upload/v1/liquidretail/ai_video_poster/xyz.png`;
    const ad = {
      _id: 'ad-vid', campaignId: 'camp-1', brandId: 'brand-1', kind: 'video',
      renderUrl: videoUrl('titled'),
      veoVideoUrl: videoUrl('master'),
      posterUrl: independent
    };
    const calls = [];
    await H.destroyUnsharedAdAssets(ad, {
      Ad: makeAdModel([ad]),
      deleteFromCloudinary: async (url) => { calls.push(url); return { result: 'ok' }; },
      publicIdFromUrl,
      excludeAdId: ad._id
    });
    assert.ok(calls.includes(independent), `independent poster not destroyed: ${calls}`);
  });

  check('F3b transform poster of own video is still not collected (source destroy invalidates it)', () => {
    const poster = `${CLD}/video/upload/so_2,f_jpg,q_auto:good,w_360/v1/liquidretail/master.jpg`;
    const urls = H.collectAdCloudinaryUrls({
      renderUrl: videoUrl('titled'),
      veoVideoUrl: videoUrl('master'),
      posterUrl: poster
    });
    assert.ok(!urls.includes(poster));
  });

  check('S1 summarizeCloudinaryCleanup does not count not-found as destroyed', () => {
    const s = H.summarizeCloudinaryCleanup([
      { url: 'https://res.cloudinary.com/demo/video/upload/v1/a.mp4', result: 'ok' },
      { url: 'https://res.cloudinary.com/demo/video/upload/v1/b.mp4', result: 'not found' }
    ]);
    assert.deepStrictEqual(s.destroyed, ['https://res.cloudinary.com/demo/video/upload/v1/a.mp4']);
    assert.deepStrictEqual(s.notFound, ['https://res.cloudinary.com/demo/video/upload/v1/b.mp4']);
  });

  console.log('\n== C. cascadeDeleteCampaign wiring ==');

  {
    const src = fs.readFileSync(path.join(ROOT, 'services/cascadeDeleteService.js'), 'utf8');
    const fnStart = src.indexOf('async function cascadeDeleteCampaign');
    assert.ok(fnStart >= 0, 'cascadeDeleteCampaign not found');
    const body = src.slice(fnStart, src.indexOf('async function', fnStart + 10) === -1
      ? src.indexOf('module.exports', fnStart)
      : src.length);
    check('C1 cascadeDeleteCampaign calls collectAdCloudinaryUrls', () => {
      assert.ok(/collectAdCloudinaryUrls/.test(src));
      assert.ok(/adCloudinaryCleanup/.test(src));
    });
    check('C2 cascadeDeleteCampaign projection includes veoVideoUrl (not just renderUrl)', () => {
      assert.ok(/veoVideoUrl:\s*1/.test(body), 'projection dropped veoVideoUrl');
      assert.ok(/visionQc:\s*1/.test(body), 'projection dropped visionQc');
    });
    check('C3 cascadeDeleteCampaign projects posterUrl so independent posters can be collected', () => {
      assert.ok(/posterUrl:\s*1/.test(body), 'independent posters need posterUrl in the projection');
    });
  }

  console.log('\n== D. DELETE /api/ads/:id wiring ==');

  {
    const adsSrc = fs.readFileSync(path.join(ROOT, 'routes/ads.js'), 'utf8');
    const delIdx = adsSrc.indexOf("router.delete('/:id'");
    assert.ok(delIdx >= 0);
    const delBody = adsSrc.slice(delIdx, adsSrc.indexOf("router.get('/:id'", delIdx));
    check('D1 DELETE calls destroyUnsharedAdAssets', () => {
      assert.ok(/destroyUnsharedAdAssets/.test(delBody));
      assert.ok(/adCloudinaryCleanup/.test(adsSrc));
    });
    check('D2 [MONEY] DELETE no longer inlines PMax-only shared-plate logic', () => {
      assert.ok(!/stillInheritedPlate/.test(delBody));
      assert.ok(!/masterOfLiveDerive/.test(delBody));
      assert.ok(!/PMAX_VIDEO_DERIVE_SOURCE/.test(delBody));
      assert.ok(!/deleteFromCloudinary\(ad\.renderUrl\)/.test(delBody));
    });
    check('D3 capability ad.delete uses the same helper (must not drift from the HTTP route)', () => {
      const cap = fs.readFileSync(path.join(ROOT, 'services/capabilityExecutors/adDelete.js'), 'utf8');
      assert.ok(/destroyUnsharedAdAssets/.test(cap));
      assert.ok(!/deleteFromCloudinary\(ad\.renderUrl\)/.test(cap));
    });
  }

  const total = passed + failures.length;
  if (failures.length) {
    console.error(`\n❌ verifyAdCloudinaryCleanup: ${failures.length} FAILED, ${passed} passed (of ${total})\n`);
    for (const f of failures) console.error(`   • ${f}`);
    process.exit(1);
  }
  console.log(`\n✅ verifyAdCloudinaryCleanup: ${passed} checks passed\n`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
