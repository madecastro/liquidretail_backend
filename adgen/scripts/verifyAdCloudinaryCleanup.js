#!/usr/bin/env node
'use strict';
//
// verifyAdCloudinaryCleanup — adgen half of Cloudinary hygiene on
// regenerate. The helper itself is hand-synced with
// liquidretail_backend/services/adCloudinaryCleanup.js; this file pins
// (1) the adgen copy's destroy/skip behaviour and (2) that
// runClaimedRegeneration actually calls it after a new render can have
// stamped, and recascadeDerivativeSibling after a successful CAS.
//
// Revert-prove:
//   1. Drop destroyReplacedAdAssets from runClaimedRegeneration finally → R1
//   2. Snapshot after runVideoFull (old URLs already overwritten)     → R2
//   3. Helper always destroys, skip shared check                      → B2
//   4. Drop keepPublicIds skip (static overwrite destroys the new asset) → B5
//
// Pure + offline: no DB, no network, no API key.
//   node scripts/verifyAdCloudinaryCleanup.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const H = require('../src/services/adCloudinaryCleanup');
const { publicIdFromUrl } = require('../src/services/cloudinaryService');

let passed = 0;
const failures = [];
function check(label, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${label}`); }
  catch (err) {
    failures.push(`${label}\n     ${err.message}`);
    console.log(`  ✗ ${label} — ${err.message.split('\n')[0].slice(0, 240)}`);
  }
}
async function checkAsync(label, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${label}`); }
  catch (err) {
    failures.push(`${label}\n     ${err.message}`);
    console.log(`  ✗ ${label} — ${err.message.split('\n')[0].slice(0, 240)}`);
  }
}

const CLD = 'https://res.cloudinary.com/demo';
function videoUrl(id) { return `${CLD}/video/upload/v1/liquidretail/${id}.mp4`; }
function imageUrl(id) { return `${CLD}/image/upload/v1/liquidretail/${id}.png`; }

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
  if (filter._id && filter._id.$ne != null && String(d._id) === String(filter._id.$ne)) return false;
  if (filter.campaignId != null && String(d.campaignId) !== String(filter.campaignId)) return false;
  if (filter.brandId != null && String(d.brandId) !== String(filter.brandId)) return false;
  if (Array.isArray(filter.$or)) {
    const ok = filter.$or.some((clause) => Object.entries(clause).every(([k, v]) => d[k] === v));
    if (!ok) return false;
  }
  return true;
}

(async () => {
  console.log('\n== I. hand-sync ==');
  check('I1 adgen helper is byte-identical to backend services/adCloudinaryCleanup.js', () => {
    const a = fs.readFileSync(path.join(ROOT, 'src/services/adCloudinaryCleanup.js'));
    const b = fs.readFileSync(path.join(ROOT, '../services/adCloudinaryCleanup.js'));
    assert.ok(a.equals(b), 'helpers drifted — hand-sync them');
  });

  console.log('\n== B. destroy / skip [MONEY] ==');

  await checkAsync('B1 destroys old unique video assets after a successful new stamp', async () => {
    const previousAd = {
      _id: 'ad-vid', campaignId: 'c1', brandId: 'b1', kind: 'video',
      renderUrl: videoUrl('old-titled'), veoVideoUrl: videoUrl('old-master')
    };
    const currentAd = {
      _id: 'ad-vid', campaignId: 'c1', brandId: 'b1', kind: 'video',
      renderUrl: videoUrl('new-titled'), veoVideoUrl: videoUrl('new-master')
    };
    const calls = [];
    await H.destroyReplacedAdAssets({
      previousAd, currentAd,
      Ad: makeAdModel([currentAd]),
      deleteFromCloudinary: async (url) => { calls.push(url); return { result: 'ok' }; },
      publicIdFromUrl
    });
    assert.ok(calls.includes(videoUrl('old-titled')));
    assert.ok(calls.includes(videoUrl('old-master')));
    assert.ok(!calls.includes(videoUrl('new-master')));
  });

  await checkAsync('B2 [MONEY] does NOT destroy the old plate a Meta/PMax sibling still holds', async () => {
    const oldPlate = videoUrl('old-master');
    const previousAd = {
      _id: 'ad-vid', campaignId: 'c1', brandId: 'b1', kind: 'video',
      renderUrl: videoUrl('old-titled'), veoVideoUrl: oldPlate
    };
    const currentAd = {
      _id: 'ad-vid', campaignId: 'c1', brandId: 'b1', kind: 'video',
      renderUrl: videoUrl('new-titled'), veoVideoUrl: videoUrl('new-master')
    };
    const sibling = {
      _id: 'ad-feed', campaignId: 'c1', brandId: 'b1',
      platformFormat: 'meta_feed_1_1',
      renderUrl: oldPlate, veoVideoUrl: oldPlate
    };
    const calls = [];
    await H.destroyReplacedAdAssets({
      previousAd, currentAd,
      Ad: makeAdModel([currentAd, sibling]),
      deleteFromCloudinary: async (url) => { calls.push(url); return { result: 'ok' }; },
      publicIdFromUrl
    });
    assert.ok(!calls.includes(oldPlate), `destroyed sibling-held plate: ${calls}`);
    assert.ok(calls.includes(videoUrl('old-titled')));
  });

  await checkAsync('B5 [MONEY] static overwrite (same public_id, new version) is NOT destroyed', async () => {
    const oldUrl = `${CLD}/image/upload/v111/liquidretail/ad_renders/abc.png`;
    const newUrl = `${CLD}/image/upload/v222/liquidretail/ad_renders/abc.png`;
    const previousAd = {
      _id: 'ad-s', campaignId: 'c1', brandId: 'b1', kind: 'image',
      renderUrl: oldUrl, cloudinaryPublicId: 'liquidretail/ad_renders/abc'
    };
    const currentAd = {
      _id: 'ad-s', campaignId: 'c1', brandId: 'b1', kind: 'image',
      renderUrl: newUrl, cloudinaryPublicId: 'liquidretail/ad_renders/abc'
    };
    const calls = [];
    const results = await H.destroyReplacedAdAssets({
      previousAd, currentAd,
      Ad: makeAdModel([currentAd]),
      deleteFromCloudinary: async (url) => { calls.push(url); return { result: 'ok' }; },
      publicIdFromUrl
    });
    assert.strictEqual(calls.length, 0, `destroyed overwritten public_id: ${calls}`);
    assert.ok(results.some((r) => r.reason === 'still-current-public-id'));
  });

  await checkAsync('F1 [MONEY] untitled fallback does NOT destroy the previous titled video', async () => {
    const previousAd = {
      _id: 'ad-vid', campaignId: 'c1', brandId: 'b1', kind: 'video',
      renderUrl: videoUrl('old-titled'), veoVideoUrl: videoUrl('old-master')
    };
    const currentAd = {
      _id: 'ad-vid', campaignId: 'c1', brandId: 'b1', kind: 'video',
      renderUrl: videoUrl('new-master'), veoVideoUrl: videoUrl('new-master')
    };
    const calls = [];
    await H.destroyReplacedAdAssets({
      previousAd, currentAd,
      Ad: makeAdModel([currentAd]),
      deleteFromCloudinary: async (url) => { calls.push(url); return { result: 'ok' }; },
      publicIdFromUrl
    });
    assert.ok(!calls.includes(videoUrl('old-titled')), `destroyed last-known-good titled video: ${calls}`);
    assert.ok(calls.includes(videoUrl('old-master')));
  });

  await checkAsync('F2 [MONEY] same public_id, only one version URL is shared → do not destroy the pid', async () => {
    const pid = 'liquidretail/shared-plate';
    const v111 = `${CLD}/video/upload/v111/${pid}.mp4`;
    const v222 = `${CLD}/video/upload/v222/${pid}.mp4`;
    const ad = {
      _id: 'ad-m', campaignId: 'c1', brandId: 'b1', kind: 'video',
      renderUrl: v222, veoVideoUrl: v111
    };
    const sibling = {
      _id: 'ad-s', campaignId: 'c1', brandId: 'b1',
      renderUrl: v111, veoVideoUrl: v111
    };
    const calls = [];
    await H.destroyUnsharedAdAssets(ad, {
      Ad: makeAdModel([ad, sibling]),
      deleteFromCloudinary: async (url) => { calls.push(url); return { result: 'ok' }; },
      publicIdFromUrl,
      excludeAdId: ad._id, campaignId: ad.campaignId, brandId: ad.brandId
    });
    assert.strictEqual(calls.length, 0, `destroyed pid still referenced via another version URL: ${calls}`);
  });

  check('F3 independent poster is collected; transform poster is not', () => {
    const independent = `${CLD}/image/upload/v1/liquidretail/ai_video_poster/xyz.png`;
    const transform = `${CLD}/video/upload/so_2,f_jpg,q_auto:good/v1/liquidretail/master.jpg`;
    const urls = H.collectAdCloudinaryUrls({
      renderUrl: videoUrl('titled'),
      veoVideoUrl: videoUrl('master'),
      posterUrl: independent
    });
    assert.ok(urls.includes(independent));
    const urls2 = H.collectAdCloudinaryUrls({
      renderUrl: videoUrl('titled'),
      veoVideoUrl: videoUrl('master'),
      posterUrl: transform
    });
    assert.ok(!urls2.includes(transform));
  });

  console.log('\n== R. regenerate wiring ==');

  {
    const src = fs.readFileSync(path.join(ROOT, 'src/services/adRegenerateService.js'), 'utf8');
    const claimed = src.indexOf('async function runClaimedRegeneration');
    assert.ok(claimed >= 0);
    const claimedBody = src.slice(claimed, src.indexOf('async function loadBrand', claimed));
    check('R1 [MONEY] runClaimedRegeneration calls destroyReplacedAdAssets in a finally (after new stamp / cascade)', () => {
      assert.ok(/destroyReplacedAdAssets/.test(claimedBody), 'cleanup call missing from runClaimedRegeneration');
      assert.ok(/finally\s*\{/.test(claimedBody), 'cleanup is not in finally');
      const finallyIdx = claimedBody.lastIndexOf('finally');
      const finallyBody = claimedBody.slice(finallyIdx);
      assert.ok(/destroyReplacedAdAssets/.test(finallyBody));
    });
    check('R2 [MONEY] snapshot is taken BEFORE runVideoFull/runImage (old URLs still on the doc)', () => {
      const snapIdx = claimedBody.indexOf('snapshotAdCloudinaryState');
      const videoIdx = claimedBody.indexOf('runVideoFull(');
      const imageIdx = claimedBody.indexOf('runImage(');
      assert.ok(snapIdx >= 0, 'snapshotAdCloudinaryState missing');
      assert.ok(snapIdx < videoIdx, 'snapshot after runVideoFull — old URLs already overwritten');
      assert.ok(snapIdx < imageIdx, 'snapshot after runImage');
    });
    check('R3 snapshot is AFTER the receipt/in-flight early returns (no cleanup on a refused regen)', () => {
      const receiptIdx = claimedBody.indexOf('hasFreshReceipt');
      const snapIdx = claimedBody.indexOf('snapshotAdCloudinaryState');
      assert.ok(receiptIdx >= 0 && snapIdx > receiptIdx, 'snapshot precedes the receipt gate');
    });
    check('R4 recascadeDerivativeSibling calls destroyReplacedAdAssets after a successful CAS', () => {
      const recascade = src.slice(src.indexOf('async function recascadeDerivativeSibling'));
      assert.ok(/destroyReplacedAdAssets/.test(recascade));
      const casIdx = recascade.indexOf('siblingStillEligible');
      const cleanIdx = recascade.indexOf('destroyReplacedAdAssets');
      assert.ok(casIdx >= 0 && cleanIdx > casIdx, 'cleanup before CAS');
    });
    check('R5 regenerateConsumer does not need its own destroy (adRegenerateService owns it)', () => {
      const consumer = fs.readFileSync(path.join(ROOT, 'src/services/regenerateConsumer.js'), 'utf8');
      assert.ok(!/destroyReplacedAdAssets/.test(consumer));
      assert.ok(/runClaimedRegeneration/.test(consumer));
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
