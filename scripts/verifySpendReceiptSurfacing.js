#!/usr/bin/env node
/**
 * verifySpendReceiptSurfacing — the spend receipt must survive serialization.
 *
 * WHY THIS EXISTS
 * ---------------
 * `Ad.veoPredictionId` (video) and `Ad.imageGeneration.predictionId` (static)
 * are SPEND RECEIPTS: the provider charges at submit, so these ids are the only
 * durable handle to "did this ad cost money, and what did we buy?" — and the
 * provider retains a prediction for only ~30 days.
 *
 * `routes/ads.js` `projectAd()` is an explicit ALLOWLIST object literal. It was
 * written 2026-05-07 (`5690df0f`); `veoPredictionId` reached the schema
 * 2026-07-29 (`f60c1c70`), a commit that never touched routes/ads.js. So the
 * allowlist simply never learned the field existed — an ACCIDENTAL omission, not
 * a payload or leakage decision. Measured on `c77a4774` (the commit live in
 * production at the time): `projectAd(videoAd, full=true)` returned 60 keys and
 * ZERO `veo*` keys while the id sat populated on the document. The static
 * counterpart was dropped by the same allowlist in the same way.
 *
 * Scope note, so nobody over-claims this: the receipt was NOT invisible to the
 * whole API. `GET /:id/generation-inspector` already returned
 * `video.submission.predictionId` (routes/ads.js:5294) and
 * `image.submission.predictionId` (:5438), and `GET /render-activity` a merged
 * `predictionId` (:4182). What was missing was the receipt on the documented
 * "full doc" endpoint that already exposes `identityDigest`, `renderError` and
 * `renderAttempts`, and on the primary Product Ads surface
 * (`GET /api/catalog/:id/ads-detail`).
 *
 * BEHAVIOURAL, NOT A SOURCE SCAN, wherever it can be. `routes/ads.js` exports
 * `projectAd` for exactly this. A regex over the object literal would pass
 * against a reimplementation that kept the key and returned `undefined` — the
 * failure mode that matters most here (see D2).
 *
 * REVERT-PROOF (each must fail the harness):
 *   1. Delete the `...adSpendReceipts(ad)` spread in projectAd's base
 *   2. Move that spread inside the `if (full)` block
 *   3. Replace the accessor body with a bare `x || null` (drops the type guard)
 *   4. Drop `veoPredictionId`/`imageGeneration.predictionId` from catalog.js $project
 *   5. Drop the `...adSpendReceipts(a)` spread from catalog.js adRows
 *   6. Add `veoPrompt: ad.veoPrompt` to projectAd
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const REPO = path.join(__dirname, '..');
let pass = 0;
const failures = [];
function check(name, fn) {
  try { fn(); pass++; }
  catch (err) { failures.push(`${name}: ${err.message}`); }
}

// ── Fixtures ────────────────────────────────────────────────────────────────
// Shaped after the real measured ad 6a905e99eb9dcfda71fdd889 (run
// run_1787846180549_eefa581d) — a delivered video ad holding a receipt.
function videoAdWithReceipt(predId = 'a69cd0453ebe4e7dac1a3b6a2d4f7a6f') {
  return {
    _id: '6a905e99eb9dcfda71fdd889',
    brandId: '6a1111111111111111111111',
    kind: 'video',
    status: 'draft',
    aspectRatio: '9:16',
    platformFormat: 'meta_stories_9_16',
    renderUrl: 'https://res.cloudinary.com/x/video/upload/v1/final.mp4',
    veoPredictionId: predId,
    veoModel: 'google/gemini-omni-flash/image-to-video-developer',
    veoAspectRatio: '9:16',
    // ~4.2KB in production. E1 pins that this is NOT copied into the payload.
    veoPrompt: 'CAMERA: slow push-in. '.repeat(200),
    veoVideoUrl: 'https://res.cloudinary.com/x/video/upload/v1/master.mp4',
    veoStoryboard: { scenes: [{ t: 0 }, { t: 3.3 }] },
    veoReferenceImages: ['https://cdn/seed.jpg', 'https://cdn/alt1.jpg'],
    copy: {}
  };
}

function staticAdWithReceipt(predId = 'IMG-7f3c9a1b') {
  return {
    _id: '6a905e99eb9dcfda71fdd777',
    brandId: '6a1111111111111111111111',
    kind: 'image',
    status: 'draft',
    aspectRatio: '1:1',
    platformFormat: 'meta_feed_1_1',
    renderUrl: 'https://res.cloudinary.com/x/image/upload/v1/final.png',
    imageGeneration: {
      predictionId: predId,
      model: 'openai/gpt-image-2/edit',
      pipeline: 'direct_image'
    },
    copy: {}
  };
}

const BARE_AD = {
  _id: '6a905e99eb9dcfda71fdd000',
  brandId: '6a1111111111111111111111',
  kind: 'video',
  copy: {}
};

// ── A. the serializer + the shared accessor both load ───────────────────────
let projectAd = null;
let adSpendReceipts = null;

check('A1 services/spendReceipt.js exports adSpendReceipts', () => {
  const mod = require(path.join(REPO, 'services', 'spendReceipt.js'));
  assert.strictEqual(typeof mod.adSpendReceipts, 'function',
    'the read-side accessor must live beside the requeue filters that read the same two fields');
  adSpendReceipts = mod.adSpendReceipts;
});

check('A2 routes/ads.js requires cleanly and exports projectAd', () => {
  const mod = require(path.join(REPO, 'routes', 'ads.js'));
  assert.strictEqual(typeof mod.projectAd, 'function',
    'projectAd must stay exported — this harness drives the real function');
  projectAd = mod.projectAd;
});

// ── B. video receipt, BOTH arms ─────────────────────────────────────────────
// Unconditional (not behind `full`): "which of these billed" is a LIST question
// too, and the pair costs +88 bytes.
check('B1 video receipt is on the COMPACT (full=false) projection', () => {
  assert.ok(projectAd, 'A2 must run first');
  assert.strictEqual(projectAd(videoAdWithReceipt(), false).veoPredictionId,
    'a69cd0453ebe4e7dac1a3b6a2d4f7a6f');
});

check('B2 video receipt is on the FULL projection — GET /api/ads/:id', () => {
  assert.ok(projectAd, 'A2 must run first');
  assert.strictEqual(projectAd(videoAdWithReceipt(), true).veoPredictionId,
    'a69cd0453ebe4e7dac1a3b6a2d4f7a6f');
});

check('B3 a DIFFERENT receipt id is carried verbatim (not a hardcoded echo)', () => {
  assert.ok(projectAd, 'A2 must run first');
  assert.strictEqual(projectAd(videoAdWithReceipt('ffffffff00000000ffffffff00000000'), true).veoPredictionId,
    'ffffffff00000000ffffffff00000000');
});

// ── C. static counterpart — the SAME allowlist dropped it the same way ──────
check('C1 static receipt is on the COMPACT projection', () => {
  assert.ok(projectAd, 'A2 must run first');
  assert.strictEqual(projectAd(staticAdWithReceipt(), false).imageGenerationPredictionId,
    'IMG-7f3c9a1b');
});

check('C2 static receipt is on the FULL projection', () => {
  assert.ok(projectAd, 'A2 must run first');
  assert.strictEqual(projectAd(staticAdWithReceipt(), true).imageGenerationPredictionId,
    'IMG-7f3c9a1b');
});

// ── D. the "survives serialization" contract ────────────────────────────────
check('D1 BOTH receipt keys are present on every arm, receipt or not', () => {
  assert.ok(projectAd, 'A2 must run first');
  const cases = [
    ['video+receipt',  videoAdWithReceipt()],
    ['static+receipt', staticAdWithReceipt()],
    ['no receipt',     BARE_AD]
  ];
  for (const [label, ad] of cases) {
    for (const full of [false, true]) {
      const row = projectAd(ad, full);
      assert.ok('veoPredictionId' in row,
        `${label} full=${full}: veoPredictionId key missing`);
      assert.ok('imageGenerationPredictionId' in row,
        `${label} full=${full}: imageGenerationPredictionId key missing`);
    }
  }
});

check('D2 absent receipt is null, NEVER undefined (undefined vanishes from JSON)', () => {
  // The check a source-text scan cannot make. `JSON.stringify` DROPS
  // undefined-valued keys, so returning undefined would make "no receipt"
  // indistinguishable from "this endpoint does not report receipts" — the exact
  // ambiguity that sent an investigation to the database.
  assert.ok(projectAd, 'A2 must run first');
  for (const full of [false, true]) {
    const row = projectAd(BARE_AD, full);
    assert.strictEqual(row.veoPredictionId, null,
      `full=${full}: expected null, got ${String(row.veoPredictionId)}`);
    assert.strictEqual(row.imageGenerationPredictionId, null,
      `full=${full}: expected null, got ${String(row.imageGenerationPredictionId)}`);
    const revived = JSON.parse(JSON.stringify(row));
    assert.ok('veoPredictionId' in revived,
      `full=${full}: veoPredictionId did not survive JSON`);
    assert.ok('imageGenerationPredictionId' in revived,
      `full=${full}: imageGenerationPredictionId did not survive JSON`);
  }
});

check('D3 receipt survives the REAL response envelope, JSON round-tripped', () => {
  // GET /api/ads/:id does res.json({ ad: projectAd(ad, true, {...}) }).
  // Reproduce that exactly.
  assert.ok(projectAd, 'A2 must run first');
  const v = JSON.parse(JSON.stringify({ ad: projectAd(videoAdWithReceipt(), true, { productUrl: null }) }));
  assert.strictEqual(v.ad.veoPredictionId, 'a69cd0453ebe4e7dac1a3b6a2d4f7a6f',
    'the video spend receipt must survive res.json()');
  const s = JSON.parse(JSON.stringify({ ad: projectAd(staticAdWithReceipt(), true, { productUrl: null }) }));
  assert.strictEqual(s.ad.imageGenerationPredictionId, 'IMG-7f3c9a1b',
    'the static spend receipt must survive res.json()');
});

check('D4 the two receipts are independent — one never fills in for the other', () => {
  assert.ok(projectAd, 'A2 must run first');
  assert.strictEqual(projectAd(videoAdWithReceipt(), true).imageGenerationPredictionId, null,
    'a video ad must not report an image receipt');
  assert.strictEqual(projectAd(staticAdWithReceipt(), true).veoPredictionId, null,
    'a static ad must not report a video receipt');
});

// ── E. payload bound — the verbose veo* fields stay OUT, deliberately ───────
check('E1 the ~4.2KB veoPrompt (and storyboard/refs/master URL) are NOT copied in', () => {
  // DELIBERATE WITHHOLDING, not an oversight. GET /:id/generation-inspector
  // already returns prompt / model / aspect / storyboard / reference stack
  // per-ad with far richer structure (per-reference describes, mediaId,
  // feedIndex, promptBytes vs cap). Duplicating a 4.2KB prompt into every
  // detail AND list row to serve a consumer that already has a better endpoint
  // is not a trade worth making. If a future change adds them here, this fails
  // and forces the reasoning to be revisited rather than drifted past.
  assert.ok(projectAd, 'A2 must run first');
  const forbidden = ['veoPrompt', 'veoStoryboard', 'veoReferenceImages', 'veoVideoUrl'];
  for (const full of [false, true]) {
    const row = projectAd(videoAdWithReceipt(), full);
    for (const key of forbidden) {
      assert.ok(!(key in row),
        `full=${full}: ${key} must stay out of projectAd — the inspector owns it`);
    }
  }
});

check('E2 the receipt block stays a small payload bound (< 200 bytes)', () => {
  // Measured delta when it shipped: +88 bytes on the full projection
  // (1141 -> 1229, +7.7%).
  assert.ok(projectAd, 'A2 must run first');
  const withR = projectAd(videoAdWithReceipt(), true);
  const withoutR = { ...withR };
  delete withoutR.veoPredictionId;
  delete withoutR.imageGenerationPredictionId;
  const delta = Buffer.byteLength(JSON.stringify(withR), 'utf8')
              - Buffer.byteLength(JSON.stringify(withoutR), 'utf8');
  assert.ok(delta > 0, 'the receipt fields must actually add bytes (are they present?)');
  assert.ok(delta < 200, `receipt block grew to ${delta} bytes — expected < 200`);
});

// ── F. the Mixed type guard — a receipt is a STRING or it is absent ─────────
// `Ad.imageGeneration` is Mongoose Mixed, so a legacy/corrupt row can hold
// anything. A bare `x || null` passes every truthy non-string into JSON, which
// would advertise an object as a spend receipt.
check('F1 a non-object imageGeneration parent yields null, never a throw', () => {
  assert.ok(adSpendReceipts, 'A1 must run first');
  for (const val of [null, undefined, 'legacy-string', [], 42, true, 0, '']) {
    const out = adSpendReceipts({ imageGeneration: val });
    assert.strictEqual(out.imageGenerationPredictionId, null,
      `imageGeneration=${JSON.stringify(val)} must yield null`);
  }
});

check('F2 an ARRAY parent carrying a receipt-shaped element still yields null', () => {
  // Fail-closed: only a plain object may carry a receipt.
  assert.ok(adSpendReceipts, 'A1 must run first');
  const out = adSpendReceipts({ imageGeneration: [{ predictionId: 'IMG-in-array' }] });
  assert.strictEqual(out.imageGenerationPredictionId, null);
});

check('F3 a TRUTHY NON-STRING predictionId is refused, not serialized', () => {
  assert.ok(adSpendReceipts, 'A1 must run first');
  const garbage = [{ nested: 1 }, ['x'], 123, true, { toString: () => 'nope' }];
  for (const val of garbage) {
    const out = adSpendReceipts({ imageGeneration: { predictionId: val } });
    assert.strictEqual(out.imageGenerationPredictionId, null,
      `predictionId=${JSON.stringify(val)} must be refused — a receipt is a string`);
    const vOut = adSpendReceipts({ veoPredictionId: val });
    assert.strictEqual(vOut.veoPredictionId, null,
      `veoPredictionId=${JSON.stringify(val)} must be refused`);
  }
});

check('F4 an empty-string receipt reads as null (a blank id is not a receipt)', () => {
  assert.ok(adSpendReceipts, 'A1 must run first');
  assert.strictEqual(adSpendReceipts({ veoPredictionId: '' }).veoPredictionId, null);
  assert.strictEqual(
    adSpendReceipts({ imageGeneration: { predictionId: '' } }).imageGenerationPredictionId, null);
});

check('F5 adSpendReceipts tolerates a null/undefined ad without throwing', () => {
  assert.ok(adSpendReceipts, 'A1 must run first');
  for (const ad of [null, undefined, {}]) {
    const out = adSpendReceipts(ad);
    assert.strictEqual(out.veoPredictionId, null);
    assert.strictEqual(out.imageGenerationPredictionId, null);
  }
});

check('F6 the projection returns EXACTLY the two receipt keys, nothing else', () => {
  // A spread into projectAd's base means any extra key here silently joins
  // every ads payload. Pin the shape so growth is a deliberate edit.
  assert.ok(adSpendReceipts, 'A1 must run first');
  assert.deepStrictEqual(
    Object.keys(adSpendReceipts(videoAdWithReceipt())).sort(),
    ['imageGenerationPredictionId', 'veoPredictionId']);
});

// ── G. lockstep: routes/ads.js and routes/catalog.js must not drift ─────────
// routes/catalog.js's ads-detail is the PRIMARY Product Ads surface and keeps a
// PARALLEL allowlist. Its own $project comment records this defect class twice
// already (visionQc, then renderStage — the second "projected but never
// emitted", i.e. one half done). Both halves are pinned here.
//
// Source-text, deliberately: driving that handler needs a live DB. The IMPORT
// checks matter as much as the call-site ones — a harness that asserts a call
// site uses a helper without asserting the file IMPORTS it shipped a broken
// money guard to production once already (CLAUDE.md §4, `receiptFree`), and
// `npm run lint`'s no-undef is the other half of that net.
function readSrc(rel) {
  return fs.readFileSync(path.join(REPO, rel), 'utf8');
}

check('G1 routes/ads.js IMPORTS adSpendReceipts from the shared module', () => {
  const src = readSrc('routes/ads.js');
  assert.ok(/require\(['"]\.\.\/services\/spendReceipt['"]\)/.test(src),
    'routes/ads.js must require services/spendReceipt');
  assert.ok(/adSpendReceipts[^=]*=\s*require\(['"]\.\.\/services\/spendReceipt['"]\)/.test(src)
    || /\{[^}]*adSpendReceipts[^}]*\}\s*=\s*require\(['"]\.\.\/services\/spendReceipt['"]\)/.test(src),
    'adSpendReceipts must be destructured from that require, not re-implemented');
});

check('G2 routes/catalog.js IMPORTS adSpendReceipts from the shared module', () => {
  const src = readSrc('routes/catalog.js');
  assert.ok(/\{[^}]*adSpendReceipts[^}]*\}\s*=\s*require\(['"]\.\.\/services\/spendReceipt['"]\)/.test(src),
    'routes/catalog.js must destructure adSpendReceipts from services/spendReceipt');
});

check('G3 catalog ads-detail $project selects BOTH receipt paths', () => {
  // Half 1. A field missing from an aggregate $project arrives `undefined`
  // regardless of what is on the document.
  const src = readSrc('routes/catalog.js');
  assert.ok(/veoPredictionId:\s*1/.test(src),
    "catalog ads-detail $project must include `veoPredictionId: 1`");
  assert.ok(/['"]imageGeneration\.predictionId['"]\s*:\s*1/.test(src),
    "catalog ads-detail $project must include `'imageGeneration.predictionId': 1` " +
    '(the SUB-PATH — projecting the whole Mixed object drags the prompt onto a 60-row grid)');
});

check('G4 catalog ads-detail actually EMITS the receipts in its adRows map', () => {
  // Half 2 — the 2026-08-20 bug was projecting without emitting.
  const src = readSrc('routes/catalog.js');
  const mapStart = src.indexOf('const adRows = ads.map(');
  assert.ok(mapStart > 0, 'could not locate the adRows map — did it get renamed?');
  const region = src.slice(mapStart, mapStart + 4000);
  assert.ok(/\.\.\.adSpendReceipts\(/.test(region),
    'the adRows map must spread adSpendReceipts(...) — projecting the fields ' +
    'without emitting them is exactly the renderStage bug its own comment records');
});

check('G5 neither route re-implements the receipt expression inline', () => {
  // The whole point of the shared accessor. An inline
  // `ad.imageGeneration?.predictionId || null` in a PAYLOAD builder is the
  // drift this closes. render-activity's own merged read is exempt — it
  // predates this and deliberately publishes a merged field.
  const adsSrc = readSrc('routes/ads.js');
  const projectStart = adsSrc.indexOf('function projectAd(');
  assert.ok(projectStart > 0, 'could not locate projectAd');
  const body = adsSrc.slice(projectStart, adsSrc.indexOf('\n}', projectStart));
  assert.ok(!/imageGeneration\?\.predictionId/.test(body),
    'projectAd must use the shared accessor, not an inline imageGeneration?.predictionId read');
  assert.ok(!/ad\.veoPredictionId\s*\|\|/.test(body),
    'projectAd must use the shared accessor, not an inline veoPredictionId read');
});

// ── Report ──────────────────────────────────────────────────────────────────
const total = pass + failures.length;
console.log('\nverifySpendReceiptSurfacing');
console.log('  A. serializer + shared accessor load');
console.log('  B. video spend receipt on both arms');
console.log('  C. static spend receipt on both arms (same allowlist, same fault)');
console.log('  D. survives serialization — null not undefined, real envelope');
console.log('  E. payload bound — verbose veo* fields deliberately withheld');
console.log('  F. Mixed type guard — a receipt is a string or it is absent');
console.log('  G. lockstep — /api/ads and catalog ads-detail cannot drift');
if (failures.length) {
  console.log(`\n❌ verifySpendReceiptSurfacing: ${failures.length} of ${total} checks FAILED\n`);
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  process.exit(1);
}
console.log(`\n✅ verifySpendReceiptSurfacing: ${pass}/${total} checks passed`);
