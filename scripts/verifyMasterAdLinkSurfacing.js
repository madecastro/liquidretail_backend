#!/usr/bin/env node
/**
 * verifyMasterAdLinkSurfacing — a derivative ad must be able to name, and link
 * to, the MASTER video ad that produced it.
 *
 * WHY THIS EXISTS
 * ---------------
 * Owner ask 2026-08-28, verbatim: "We need this to properly QC analyze errors in
 * the master video used to produce derivatives." A production run minted
 * 1 master + 3 unstaged derives + 8 staged retitles = 12 rows, and all eleven
 * derives inherited the master's outcome. When a derive looks wrong the defect is
 * usually IN THE MASTER, and there was no way to get from one to the other.
 *
 * THE LINKAGE IS A FORMAT STRING PLUS A QUERY, NOT AN ID. `Ad.deriveFromMaster`
 * (models/Ad.js) holds the MASTER'S `platformFormat` string; no master ObjectId
 * is persisted anywhere. So "master not found" is a real, expected outcome and
 * must be reported honestly rather than crashing or rendering a dead link.
 *
 * BEHAVIOURAL, NOT A SOURCE SCAN. `routes/ads.js` exports `buildMasterBlock` and
 * `masterAdDiagnosticQuery` for exactly this. A regex over the route would pass
 * against a reimplementation that kept the keys and returned undefined — the
 * failure mode that matters most (see B-group and D2).
 *
 * THE TWO THINGS MOST LIKELY TO BE BROKEN BY A WELL-MEANING EDIT, both pinned:
 *   1. `failed` must NOT suppress the master's URLs (group C). On a titling
 *      failure the master is stamped `failed` with "master rendered; titling
 *      failed" and the PAID plate is KEPT — so a failed master usually still has
 *      an inspectable video. A link that disappears exactly when the master
 *      failed breaks the feature's primary use case.
 *   2. The diagnostic query must NOT inherit findSiblingMasterAd's
 *      `videoDurationSec: { $gte: 10 }` eligibility gate (group E). `$gte`
 *      matches neither null nor an absent field, so inheriting it reports every
 *      legacy 8s / unstamped master as deleted.
 *
 * REVERT-PROOF (each must fail this harness):
 *   1. Gate the URLs on `!failed` in buildMasterBlock
 *   2. Drop `brandId` from masterAdDiagnosticQuery
 *   3. Add `videoDurationSec: { $gte: 10 }` to masterAdDiagnosticQuery
 *   4. Return `null` from buildMasterBlock when `master` is falsy (instead of
 *      the honest `{found:false, reason}`)
 *   5. Compute `hasVideo` from `status !== 'failed'` instead of from the URLs
 *   6. Drop the true-master ($and) clause from masterAdDiagnosticQuery
 *   7. Make buildMasterBlock return a block for a TRUE master (deriveFmt null)
 */

const assert = require('assert');

let pass = 0;
const failures = [];
function check(name, fn) {
  try { fn(); pass++; }
  catch (err) { failures.push(`${name}: ${err.message}`); }
}

const {
  buildMasterBlock,
  masterAdDiagnosticQuery,
  videoStillUrl,
  resolveDeriveFromMaster
} = require('../routes/ads');

// ── Fixtures ────────────────────────────────────────────────────────────────
const BRAND = '6a1111111111111111111111';
const OTHER_BRAND = '6a2222222222222222222222';
const CAMPAIGN = '6a3333333333333333333333';
const PRODUCT = '6a4444444444444444444444';

const PLATE = 'https://res.cloudinary.com/x/video/upload/v1/master-plate.mp4';
const FINAL = 'https://res.cloudinary.com/x/video/upload/v1/master-final.mp4';

// A healthy 9:16 Meta master.
function healthyMaster(over = {}) {
  return {
    _id: '6a905e99eb9dcfda71fdd889',
    brandId: BRAND,
    campaignId: CAMPAIGN,
    productId: PRODUCT,
    kind: 'video',
    status: 'draft',
    aspectRatio: '9:16',
    veoAspectRatio: '9:16',
    platformFormat: 'meta_stories_9_16',
    renderUrl: FINAL,
    veoVideoUrl: PLATE,
    veoPredictionId: 'a69cd0453ebe4e7dac1a3b6a2d4f7a6f',
    posterUrl: null,
    visionQc: null,
    renderError: null,
    deriveFromMaster: null,
    funnelStage: null,
    ...over
  };
}

// The derive the owner would be looking at: a free Meta 1:1 crop.
function unstagedDerive(over = {}) {
  return {
    _id: '6a905e99eb9dcfda71fdd88a',
    brandId: BRAND,
    campaignId: CAMPAIGN,
    productId: PRODUCT,
    kind: 'video',
    status: 'draft',
    aspectRatio: '1:1',
    platformFormat: 'meta_feed_1_1',
    deriveFromMaster: 'meta_stories_9_16',
    funnelStage: null,
    ...over
  };
}

// A staged retitle — must link to the MASTER, not to its unstaged parent.
function stagedRetitle(over = {}) {
  return {
    ...unstagedDerive(),
    _id: '6a905e99eb9dcfda71fdd88b',
    funnelStage: 'consideration',
    ...over
  };
}

// ── A. the gate: only derivatives get a master block ────────────────────────
check('A1 a TRUE master (no deriveFromMaster/funnelStage) resolves to no derive format', () => {
  assert.strictEqual(resolveDeriveFromMaster(healthyMaster()), null,
    'a true master must not resolve a derive-from format');
});

check('A2 a true master therefore produces NO master block at all', () => {
  const deriveFmt = resolveDeriveFromMaster(healthyMaster());
  assert.strictEqual(buildMasterBlock({ deriveFmt, master: healthyMaster() }), null,
    'absent must mean "this ad is not a derivative" — never a {found:false} that reads as a lookup failure');
});

check('A3 an unstaged derive resolves its master format from the stored marker', () => {
  assert.strictEqual(resolveDeriveFromMaster(unstagedDerive()), 'meta_stories_9_16');
});

check('A4 a STAGED retitle resolves to the MASTER format, not its parent derive format', () => {
  // The 2-hop trap: a retitle must point at the master, never at the unstaged
  // 1:1 derive it shares a platformFormat with.
  const fmt = resolveDeriveFromMaster(stagedRetitle());
  assert.strictEqual(fmt, 'meta_stories_9_16',
    'a staged retitle must name the master format, not meta_feed_1_1');
});

// ── B. the healthy path ─────────────────────────────────────────────────────
check('B1 a healthy master yields found:true with both URLs and the receipt', () => {
  const b = buildMasterBlock({ deriveFmt: 'meta_stories_9_16', master: healthyMaster() });
  assert.strictEqual(b.found, true);
  assert.strictEqual(b.platformFormat, 'meta_stories_9_16');
  assert.strictEqual(b.adId, '6a905e99eb9dcfda71fdd889');
  assert.strictEqual(b.previewUrl, FINAL, 'previewUrl must be the DELIVERED titled render');
  assert.strictEqual(b.rawVideoUrl, PLATE, 'rawVideoUrl must be the raw pre-titling plate');
  assert.strictEqual(b.predictionId, 'a69cd0453ebe4e7dac1a3b6a2d4f7a6f');
  assert.strictEqual(b.hasVideo, true);
  assert.strictEqual(b.failed, false);
});

check('B2 a thumbnail is derived from a Cloudinary video URL', () => {
  const b = buildMasterBlock({ deriveFmt: 'meta_stories_9_16', master: healthyMaster() });
  assert.ok(typeof b.thumbnailUrl === 'string' && b.thumbnailUrl.endsWith('.jpg'),
    `expected a .jpg still, got ${b.thumbnailUrl}`);
  assert.ok(b.thumbnailUrl.includes('so_2'), 'must use the same still transform as derivedFrom');
});

check('B3 a NON-Cloudinary URL yields a null thumbnail, never a mangled string', () => {
  assert.strictEqual(videoStillUrl('https://example.com/plain.mp4'), null);
  assert.strictEqual(videoStillUrl(null), null);
  assert.strictEqual(videoStillUrl(undefined), null);
  const b = buildMasterBlock({
    deriveFmt: 'meta_stories_9_16',
    master: healthyMaster({ renderUrl: 'https://example.com/a.mp4', veoVideoUrl: null })
  });
  assert.strictEqual(b.thumbnailUrl, null);
});

check('B4 whitespace-only URLs are treated as absent, not as links', () => {
  const b = buildMasterBlock({
    deriveFmt: 'meta_stories_9_16',
    master: healthyMaster({ renderUrl: '   ', veoVideoUrl: '' })
  });
  assert.strictEqual(b.previewUrl, null);
  assert.strictEqual(b.rawVideoUrl, null);
  assert.strictEqual(b.hasVideo, false, 'blank strings must not count as a video');
});

// ── C. THE PRIMARY CASE — a FAILED master ───────────────────────────────────
// This whole group is the feature's reason for existing. `failed` is a status
// treatment; it must never suppress the URLs.
check('C1 [PRIMARY] a FAILED master that KEPT its plate STILL reports its URLs', () => {
  // The real shape: routes/ads.js stamps failed + "master rendered; titling
  // failed" and deliberately KEEPS the paid master.
  const b = buildMasterBlock({
    deriveFmt: 'meta_stories_9_16',
    master: healthyMaster({
      status: 'failed',
      renderUrl: null,                    // titling never produced a delivered file
      veoVideoUrl: PLATE,                 // ...but the PAID plate survives
      renderError: { message: 'master rendered; titling failed', stage: 'titling' }
    })
  });
  assert.strictEqual(b.failed, true, 'must report the failure');
  assert.strictEqual(b.rawVideoUrl, PLATE,
    'REGRESSION: a failed master kept its paid plate — the URL must survive `failed`');
  assert.strictEqual(b.hasVideo, true,
    'REGRESSION: hasVideo must come from the URLs, not from status');
  assert.strictEqual(b.failureMessage, 'master rendered; titling failed');
  assert.strictEqual(b.failureStage, 'titling');
});

check('C2 [PRIMARY] a failed master with NO plate reports hasVideo:false but still identifies itself', () => {
  const b = buildMasterBlock({
    deriveFmt: 'meta_stories_9_16',
    master: healthyMaster({
      status: 'failed',
      renderUrl: null,
      veoVideoUrl: null,
      renderError: { message: 'Omni submit rejected: 429', stage: 'video-generate' }
    })
  });
  assert.strictEqual(b.failed, true);
  assert.strictEqual(b.hasVideo, false);
  assert.strictEqual(b.previewUrl, null);
  assert.strictEqual(b.rawVideoUrl, null);
  // The diagnostic value in this state is the identity, so it must survive.
  assert.strictEqual(b.adId, '6a905e99eb9dcfda71fdd889', 'the master adId must still be reported');
  assert.strictEqual(b.predictionId, 'a69cd0453ebe4e7dac1a3b6a2d4f7a6f',
    'the spend receipt must still be reported — it is what an operator takes to the logs');
  assert.strictEqual(b.failureMessage, 'Omni submit rejected: 429');
});

check('C3 hasVideo is TRUE on a non-failed master with only a raw plate', () => {
  const b = buildMasterBlock({
    deriveFmt: 'meta_stories_9_16',
    master: healthyMaster({ renderUrl: null, veoVideoUrl: PLATE })
  });
  assert.strictEqual(b.hasVideo, true);
});

check('C4 an ARCHIVED master is reported with its status, not hidden', () => {
  const b = buildMasterBlock({
    deriveFmt: 'meta_stories_9_16',
    master: healthyMaster({ status: 'archived' })
  });
  assert.strictEqual(b.found, true, '"the master was archived" IS the diagnosis — do not hide it');
  assert.strictEqual(b.status, 'archived');
  assert.strictEqual(b.failed, false, 'archived is not failed');
});

// ── D. the missing master ───────────────────────────────────────────────────
check('D1 a missing master yields found:false WITH a reason, and no URL fields', () => {
  const b = buildMasterBlock({ deriveFmt: 'meta_stories_9_16', master: null });
  assert.strictEqual(b.found, false);
  assert.strictEqual(b.platformFormat, 'meta_stories_9_16',
    'the format must survive so the UI can still say WHAT is missing');
  assert.ok(typeof b.reason === 'string' && b.reason.length > 10, 'must explain itself');
  assert.strictEqual(b.previewUrl, undefined, 'must not carry URL keys it cannot fill');
  assert.strictEqual(b.rawVideoUrl, undefined);
});

check('D2 a missing master is NOT collapsed to null (which would read as "not a derive")', () => {
  const b = buildMasterBlock({ deriveFmt: 'meta_stories_9_16', master: null });
  assert.notStrictEqual(b, null,
    'a derive with a lost master must be distinguishable from an ad that is not a derive at all');
});

check('D3 no deriveFmt means no block, even if a master doc is handed in', () => {
  assert.strictEqual(buildMasterBlock({ deriveFmt: null, master: healthyMaster() }), null);
  assert.strictEqual(buildMasterBlock({ deriveFmt: '', master: healthyMaster() }), null);
});

// ── E. TENANCY + the duration-gate trap ─────────────────────────────────────
check('E1 [SECURITY] the diagnostic query carries brandId', () => {
  const q = masterAdDiagnosticQuery({
    ad: unstagedDerive(), masterPlatformFormat: 'meta_stories_9_16', brandId: BRAND
  });
  assert.strictEqual(q.brandId, BRAND,
    'REGRESSION: without brandId in the filter this is a cross-advertiser read');
});

check('E2 [SECURITY] a missing brandId refuses to build a query at all (fails closed)', () => {
  assert.strictEqual(
    masterAdDiagnosticQuery({ ad: unstagedDerive(), masterPlatformFormat: 'meta_stories_9_16', brandId: null }),
    null, 'no brandId must mean no query, never an unscoped one');
  assert.strictEqual(
    masterAdDiagnosticQuery({ ad: unstagedDerive(), masterPlatformFormat: 'meta_stories_9_16' }),
    null);
});

check('E3 [HONESTY] the diagnostic query must NOT carry the renderer duration gate', () => {
  const q = masterAdDiagnosticQuery({
    ad: unstagedDerive(), masterPlatformFormat: 'meta_stories_9_16', brandId: BRAND
  });
  assert.ok(!('videoDurationSec' in q),
    'REGRESSION: findSiblingMasterAd gates on videoDurationSec >= 10 for ELIGIBILITY. ' +
    '$gte matches neither null nor an absent field, so inheriting it here reports every ' +
    'legacy 8s / unstamped master as DELETED. A diagnostic must not lie about that.');
});

check('E4 the query is scoped to the ad\'s own campaign + product, and excludes itself', () => {
  const ad = unstagedDerive();
  const q = masterAdDiagnosticQuery({ ad, masterPlatformFormat: 'meta_stories_9_16', brandId: BRAND });
  assert.strictEqual(q.campaignId, CAMPAIGN);
  assert.strictEqual(q.productId, PRODUCT);
  assert.strictEqual(q.kind, 'video');
  assert.deepStrictEqual(q._id, { $ne: ad._id }, 'must never match itself');
  assert.strictEqual(q.platformFormat, 'meta_stories_9_16');
});

check('E5 the query keeps the TRUE-MASTER predicate (no derive, no funnel stage)', () => {
  const q = masterAdDiagnosticQuery({
    ad: stagedRetitle(), masterPlatformFormat: 'meta_stories_9_16', brandId: BRAND
  });
  assert.ok(Array.isArray(q.$and) && q.$and.length === 2,
    'REGRESSION: without both clauses a staged retitle can resolve to another ' +
    'derivative instead of the master — a derivative of a derivative');
  const json = JSON.stringify(q.$and);
  assert.ok(json.includes('deriveFromMaster'), 'must exclude derive rows');
  assert.ok(json.includes('funnelStage'), 'must exclude funnel retitle rows');
});

check('E6 [SECURITY] a foreign-brand master is excluded by the filter itself', () => {
  const q = masterAdDiagnosticQuery({
    ad: unstagedDerive(), masterPlatformFormat: 'meta_stories_9_16', brandId: BRAND
  });
  // Simulate the driver: a doc from another brand cannot satisfy a filter that
  // pins brandId. Assert on the filter rather than trusting a comment.
  assert.notStrictEqual(q.brandId, OTHER_BRAND);
  const foreign = healthyMaster({ brandId: OTHER_BRAND });
  assert.notStrictEqual(String(foreign.brandId), String(q.brandId),
    'the fixture must actually be foreign, or this check is vacuous');
});

// ── F. the route wires the pure parts together ──────────────────────────────
// Narrow source assertions, used ONLY for wiring facts a pure call cannot show.
check('F1 the inspector route calls buildMasterBlock and the diagnostic query', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ads.js'), 'utf8');
  const start = src.indexOf("router.get('/:id/generation-inspector'");
  assert.ok(start > 0, 'inspector route not found — this check is stale');
  const end = src.indexOf('res.json({ inspector: out })', start);
  assert.ok(end > start, 'could not bound the inspector handler');
  const body = src.slice(start, end);
  assert.ok(/buildMasterBlock\s*\(/.test(body), 'the route must call buildMasterBlock');
  assert.ok(/masterAdDiagnosticQuery\s*\(/.test(body),
    'the route must use masterAdDiagnosticQuery, not findSiblingMasterAd');
  assert.ok(/out\.master\s*=/.test(body), 'the route must assign out.master');
});

check('F2 the route does NOT write anything in the master block (read-only diagnostic)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ads.js'), 'utf8');
  const start = src.indexOf('── The MASTER video ad this ad was derived from ──');
  assert.ok(start > 0, 'master block comment anchor not found — this check is stale');
  const end = src.indexOf('── Video generation inputs ──', start);
  assert.ok(end > start, 'could not bound the master block');
  const body = src.slice(start, end);
  for (const mutator of ['updateOne', 'updateMany', 'insertMany', '$set', '$inc', 'deleteOne', '.save(']) {
    assert.ok(!body.includes(mutator),
      `the master block must be READ-ONLY — found ${mutator}`);
  }
});

check('F3 projectAd still withholds the veo* fields (this PR must not have widened it)', () => {
  const { projectAd } = require('../routes/ads');
  const row = projectAd(healthyMaster(), true);
  for (const key of ['veoPrompt', 'veoStoryboard', 'veoReferenceImages', 'veoVideoUrl']) {
    assert.ok(!(key in row), `${key} must stay out of projectAd — the inspector owns it`);
  }
  assert.ok(!('master' in row), 'the master block belongs to the inspector, never to the list payload');
});

// ── report ──────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`\n❌ verifyMasterAdLinkSurfacing: ${failures.length} of ${pass + failures.length} checks FAILED\n`);
  failures.forEach((f, i) => console.error(`  ${i + 1}. ${f}`));
  process.exit(1);
}
console.log(`✅ verifyMasterAdLinkSurfacing: ${pass}/${pass} checks passed`);
