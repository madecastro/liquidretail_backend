#!/usr/bin/env node
'use strict';
/**
 * verifyVideoReferenceLineage — the generation-inspector must name the
 * catalog original behind a video reference that was pad/crop/reframed
 * before submit.
 *
 * WHY THIS EXISTS
 * ---------------
 * The frontend SeedCompareModal (`GenerationInspectorModal.tsx`) renders
 * "No original catalog media could be traced for this reference. Showing
 * the image that was sent." whenever `target.originalUrl` is falsy.
 * Position 0 has a seed.url fallback; every other reference depends on
 * the backend supplying `originalUrl`. The inspector used to look up
 * Media by exact `fileUrl === submittedUrl`. That match almost always
 * misses: `buildReferenceImages` runs every identity through
 * `reframeReferenceForAspect`, which returns a reframe-cache URL, a new
 * derivative, or a Cloudinary transform of fileUrl — never the catalog
 * original in the common case.
 *
 * THE FIX is read-time reverse-resolution in services/videoReferenceLineage.js
 * (no schema change, so already-generated ads light up). This harness
 * drives the REAL helpers, including invertibility against the REAL
 * `cropImageUrlForAspect` / pad / YOLO-crop producers — a source scan
 * of the regex would pass against a pattern that does not actually
 * invert what the pipeline emits.
 *
 * REVERT-PROOF (each must fail this harness):
 *   1. Drop originalUrl from the shaped entry
 *   2. Stop stripping the cropImageUrlForAspect transform
 *   3. Stop scanning metadata.reframes.*.url
 *   4. Stop restoring video .jpg → .mp4 after a still-extract crop
 *   5. Stop calling the helper from the inspector route (fall back to
 *      `fileUrl: { $in: referenceUrls }` only)
 *   6. Over-strip an unrelated first Cloudinary segment (c_limit,w_2000)
 *      and claim it as the original
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  stripKnownCloudinaryTransform,
  candidateOriginalUrls,
  lookupUrlsFor,
  knownMediaIdsFor,
  buildVideoReferenceMediaFilter,
  resolveOneReference,
  describeReference,
  buildReferenceImageEntries,
  inferMethodFromSubmittedUrl
} = require('../services/videoReferenceLineage');

const { cropImageUrlForAspect } = require('../services/atlasVideoService');
const { __test: reframeTest } = require('../services/reframeStrategyChooser');

let pass = 0;
const failures = [];
function check(name, fn) {
  try { fn(); pass++; }
  catch (err) { failures.push(`${name}: ${err.message}`); }
}
function section(t) { console.log(`\n${t}`); }

const CATALOG = 'https://res.cloudinary.com/reach-social-prod/image/upload/v1780000000/liquidretail/catalog/hero.jpg';
const CATALOG_WITH_EXISTING = 'https://res.cloudinary.com/reach-social-prod/image/upload/c_limit,w_2000/v1780000000/liquidretail/catalog/hero.jpg';
const VIDEO_SRC = 'https://res.cloudinary.com/reach-social-prod/video/upload/v1780000000/liquidretail/catalog/clip.mp4';
const SHOPIFY = 'https://cdn.shopify.com/s/files/1/hero.jpg';
const REFRAME_DERIV = 'https://res.cloudinary.com/reach-social-prod/image/upload/v1780000999/liquidretail/reframes/outpaint-9-16.jpg';

const MEDIA_PRIMARY = {
  _id: '6a1111111111111111111111',
  fileUrl: CATALOG,
  source: 'catalog-product',
  fileType: 'image',
  primarySubjectDesc: 'white sneaker',
  metadata: { imageRole: 'hero', feedIndex: 0, catalogProductId: '6a4444444444444444444444' }
};
const MEDIA_ALT = {
  _id: '6a2222222222222222222222',
  fileUrl: 'https://res.cloudinary.com/reach-social-prod/image/upload/v1780000000/liquidretail/catalog/alt.jpg',
  source: 'catalog-product',
  fileType: 'image',
  metadata: {
    imageRole: 'alt',
    feedIndex: 1,
    reframes: {
      '9_16': { url: REFRAME_DERIV, method: 'outpaint', aspect: '9:16' }
    }
  }
};
const MEDIA_VIDEO = {
  _id: '6a3333333333333333333333',
  fileUrl: VIDEO_SRC,
  source: 'catalog-product',
  fileType: 'video',
  metadata: { imageRole: 'video', feedIndex: 2 }
};

console.log('verifyVideoReferenceLineage');

// ══ A. cropImageUrlForAspect is invertible ════════════════════════════════
section('A. cropImageUrlForAspect transform is reversible (real producer)');

check('A1 9:16 image crop strips back to the catalog fileUrl', () => {
  const sent = cropImageUrlForAspect(CATALOG, '9:16', { websiteBackground: '#FFFFFF' });
  assert.ok(sent && sent !== CATALOG, 'producer must actually transform the URL');
  assert.ok(sent.includes('/image/upload/b_rgb:FFFFFF,c_fill,w_720,h_1280,g_auto,f_jpg,q_auto:good/'),
    `expected known crop segment, got ${sent}`);
  assert.strictEqual(stripKnownCloudinaryTransform(sent), CATALOG);
});

check('A2 16:9 image crop also inverts (different dims)', () => {
  const sent = cropImageUrlForAspect(CATALOG, '16:9', '#0a0a0a');
  assert.ok(sent.includes('c_fill,w_1280,h_720'), `got ${sent}`);
  assert.strictEqual(stripKnownCloudinaryTransform(sent), CATALOG);
});

check('A3 1:1 image crop inverts', () => {
  const sent = cropImageUrlForAspect(CATALOG, '1:1', null);
  assert.strictEqual(stripKnownCloudinaryTransform(sent), CATALOG);
});

check('A4 brand hex other than white is still stripped (regex not hardcoded to FFFFFF)', () => {
  const sent = cropImageUrlForAspect(CATALOG, '9:16', '#c0ffee');
  assert.ok(sent.includes('b_rgb:C0FFEE') || sent.includes('b_rgb:c0ffee'), `got ${sent}`);
  assert.strictEqual(stripKnownCloudinaryTransform(sent), CATALOG);
});

check('A5 video still-extract crop strips the transform AND restores .mp4', () => {
  const sent = cropImageUrlForAspect(VIDEO_SRC, '9:16', null);
  assert.ok(sent.endsWith('.jpg'), `video crop must rewrite extension to .jpg, got ${sent}`);
  assert.ok(sent.includes('/video/upload/so_2,c_fill,'), `got ${sent}`);
  const stripped = stripKnownCloudinaryTransform(sent);
  assert.ok(stripped && stripped.endsWith('.jpg'), `strip leaves .jpg, got ${stripped}`);
  const candidates = candidateOriginalUrls(sent);
  assert.ok(candidates.includes(VIDEO_SRC),
    `candidates must restore .mp4; got ${JSON.stringify(candidates)}`);
});

check('A6 crop of a URL that ALREADY had a transform peels only OUR segment', () => {
  const sent = cropImageUrlForAspect(CATALOG_WITH_EXISTING, '9:16', null);
  assert.strictEqual(stripKnownCloudinaryTransform(sent), CATALOG_WITH_EXISTING);
});

check('A7 a URL with an unrelated first transform is NOT stripped', () => {
  assert.strictEqual(stripKnownCloudinaryTransform(CATALOG_WITH_EXISTING), null);
});

check('A8 a raw catalog URL (no transform) strips to null — not to itself', () => {
  assert.strictEqual(stripKnownCloudinaryTransform(CATALOG), null);
});

check('A9 a non-Cloudinary URL is a no-op', () => {
  assert.strictEqual(stripKnownCloudinaryTransform(SHOPIFY), null);
  assert.deepStrictEqual(candidateOriginalUrls(SHOPIFY), [SHOPIFY]);
});

check('A10 4:5 crop (Meta feed) inverts', () => {
  const sent = cropImageUrlForAspect(CATALOG, '4:5', null);
  assert.ok(sent.includes('w_720,h_900'), `got ${sent}`);
  assert.strictEqual(stripKnownCloudinaryTransform(sent), CATALOG);
});

// ══ B. pad + YOLO crop (the other $0 URL-insert paths) ════════════════════
section('B. pad and YOLO c_crop transforms are reversible');

check('B1 solid-pad URL inverts', () => {
  const sent = CATALOG.replace(
    '/image/upload/',
    '/image/upload/b_rgb:fafafa,c_pad,w_720,h_1280,f_jpg,q_auto:good/'
  );
  assert.strictEqual(stripKnownCloudinaryTransform(sent), CATALOG);
  assert.strictEqual(inferMethodFromSubmittedUrl(sent), 'pad');
});

check('B2 predominant-gradient pad URL inverts', () => {
  const sent = CATALOG.replace(
    '/image/upload/',
    '/image/upload/b_auto:predominant_gradient,c_pad,w_1280,h_720,f_jpg,q_auto:good/'
  );
  assert.strictEqual(stripKnownCloudinaryTransform(sent), CATALOG);
});

check('B3 YOLO c_crop from the REAL chooser helper inverts', () => {
  const sent = reframeTest.buildCloudinaryCropUrl(CATALOG, { x: 12, y: 40, w: 800, h: 1422 });
  assert.ok(sent && sent.includes('c_crop,w_800,h_1422,x_12,y_40'), `got ${sent}`);
  assert.strictEqual(stripKnownCloudinaryTransform(sent), CATALOG);
  assert.strictEqual(inferMethodFromSubmittedUrl(sent), 'crop');
});

check('B4 lookupUrlsFor expands the submitted crop to include the original', () => {
  const sent = cropImageUrlForAspect(CATALOG, '9:16', null);
  const urls = lookupUrlsFor([sent]);
  assert.ok(urls.includes(sent), 'must keep the submitted URL for exact match');
  assert.ok(urls.includes(CATALOG), 'must include the stripped original so fileUrl $in can hit');
});

// ══ C. resolveOneReference — the three match strategies ═══════════════════
section('C. resolveOneReference matches fileUrl / strip / reframe-cache');

check('C1 exact fileUrl match (the rare unprocessed case)', () => {
  const r = resolveOneReference(CATALOG, [MEDIA_PRIMARY, MEDIA_ALT]);
  assert.strictEqual(r.resolvedVia, 'fileUrl');
  assert.strictEqual(r.originalUrl, CATALOG);
  assert.strictEqual(String(r.media._id), String(MEDIA_PRIMARY._id));
});

check('C2 crop-transform match is the common case the bug was about', () => {
  const sent = cropImageUrlForAspect(CATALOG, '9:16', null);
  const r = resolveOneReference(sent, [MEDIA_PRIMARY, MEDIA_ALT]);
  assert.strictEqual(r.resolvedVia, 'stripped-transform', `got ${r.resolvedVia}`);
  assert.strictEqual(r.originalUrl, CATALOG);
  assert.strictEqual(r.method, 'crop');
  assert.ok(r.originalUrl !== sent, 'original must differ from the submitted crop URL');
});

check('C3 video still-extract match restores the .mp4 fileUrl', () => {
  const sent = cropImageUrlForAspect(VIDEO_SRC, '9:16', null);
  const r = resolveOneReference(sent, [MEDIA_PRIMARY, MEDIA_VIDEO]);
  assert.strictEqual(r.resolvedVia, 'stripped-transform', `got ${r.resolvedVia}`);
  assert.strictEqual(r.originalUrl, VIDEO_SRC);
});

check('C4 generative-reframe URL matches metadata.reframes.*.url (any aspect key)', () => {
  const r = resolveOneReference(REFRAME_DERIV, [MEDIA_PRIMARY, MEDIA_ALT]);
  assert.strictEqual(r.resolvedVia, 'reframe-cache', `got ${r.resolvedVia}`);
  assert.strictEqual(r.originalUrl, MEDIA_ALT.fileUrl);
  assert.strictEqual(r.method, 'outpaint');
  assert.strictEqual(String(r.media._id), String(MEDIA_ALT._id));
});

check('C5 split-stage reframe key (9_16_split_east) is also scanned — not a guessed key', () => {
  const splitUrl = REFRAME_DERIV.replace('outpaint-9-16', 'split-east');
  const media = {
    ...MEDIA_ALT,
    metadata: {
      ...MEDIA_ALT.metadata,
      reframes: {
        '9_16_split_east': { url: splitUrl, method: 'outpaint' },
        '1_1': { url: 'https://example/other.jpg', method: 'exact' }
      }
    }
  };
  const r = resolveOneReference(splitUrl, [media]);
  assert.strictEqual(r.resolvedVia, 'reframe-cache');
  assert.strictEqual(r.originalUrl, MEDIA_ALT.fileUrl);
});

check('C6 unknown URL is honest — originalUrl null, not a guess', () => {
  const r = resolveOneReference('https://res.cloudinary.com/x/image/upload/v1/nope.jpg', [MEDIA_PRIMARY]);
  assert.strictEqual(r.media, null);
  assert.strictEqual(r.originalUrl, null);
  assert.strictEqual(r.resolvedVia, null);
});

check('C7 a crop of ALT does not resolve to PRIMARY (no cross-wiring)', () => {
  const sent = cropImageUrlForAspect(MEDIA_ALT.fileUrl, '9:16', null);
  const r = resolveOneReference(sent, [MEDIA_PRIMARY, MEDIA_ALT]);
  assert.strictEqual(String(r.media._id), String(MEDIA_ALT._id));
  assert.strictEqual(r.originalUrl, MEDIA_ALT.fileUrl);
});

check('C8 Shopify passthrough with no Media row stays unresolved', () => {
  const r = resolveOneReference(SHOPIFY, [MEDIA_PRIMARY]);
  assert.strictEqual(r.originalUrl, null);
});

// ══ D. shaped inspector payload ═══════════════════════════════════════════
section('D. buildReferenceImageEntries — the payload the modal reads');

check('D1 a cropped non-seed ref carries originalUrl (this is the user-visible fix)', () => {
  const sent = cropImageUrlForAspect(MEDIA_ALT.fileUrl, '9:16', null);
  const entries = buildReferenceImageEntries([CATALOG, sent], [MEDIA_PRIMARY, MEDIA_ALT]);
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].originalUrl, CATALOG, 'seed original');
  assert.strictEqual(entries[1].originalUrl, MEDIA_ALT.fileUrl, 'alt original must be populated');
  assert.strictEqual(entries[1].sourceUrl, MEDIA_ALT.fileUrl, 'sourceUrl alias matches static-path convention');
  assert.strictEqual(entries[1].url, sent, 'submitted URL is still the crop, not rewritten');
  assert.strictEqual(entries[1].processed, true);
  assert.ok(entries[1].originalUrl, 'falsy originalUrl is exactly the frontend warning');
});

check('D2 unresolved NON-seed ref keeps originalUrl null (honest, not a fabricated catalog URL)', () => {
  // Position 0 is labelled seed by construction even when unresolved — that
  // is the submit record's only pin. The user-visible bug is on position >= 1.
  const entries = buildReferenceImageEntries(
    [CATALOG, 'https://cdn.example/mystery.jpg'],
    [MEDIA_PRIMARY]
  );
  assert.strictEqual(entries[1].originalUrl, null);
  assert.strictEqual(entries[1].sourceUrl, null);
  assert.strictEqual(entries[1].mediaId, null);
  assert.strictEqual(entries[1].describes, 'not resolvable — no Media row matches this URL now');
});

check('D3 position 0 is labelled seed even when unresolved', () => {
  assert.strictEqual(describeReference(null, 0), 'seed — the frame the model animated');
  const entries = buildReferenceImageEntries(['https://cdn.example/x.jpg'], []);
  assert.strictEqual(entries[0].describes, 'seed — the frame the model animated');
});

check('D4 catalog primary / alt labels still derive from feedIndex', () => {
  const entries = buildReferenceImageEntries(
    [MEDIA_PRIMARY.fileUrl, MEDIA_ALT.fileUrl],
    [MEDIA_PRIMARY, MEDIA_ALT]
  );
  assert.strictEqual(entries[0].describes, 'seed — the frame the model animated');
  assert.strictEqual(entries[1].describes, 'catalog alt (merchant feed image 1)');
  assert.strictEqual(entries[1].feedIndex, 1);
  assert.strictEqual(entries[0].feedIndex, 0);
});

check('D5 reframe-cache entry exposes method + processed + originalUrl', () => {
  const entries = buildReferenceImageEntries(
    [MEDIA_PRIMARY.fileUrl, REFRAME_DERIV],
    [MEDIA_PRIMARY, MEDIA_ALT]
  );
  assert.strictEqual(entries[1].resolvedVia, 'reframe-cache');
  assert.strictEqual(entries[1].method, 'outpaint');
  assert.strictEqual(entries[1].originalUrl, MEDIA_ALT.fileUrl);
  assert.strictEqual(entries[1].processed, true);
});

check('D6 submit-time originalUrl on an object entry wins over the lookup', () => {
  const stamped = { url: REFRAME_DERIV, originalUrl: 'https://cdn.example/stamped-original.jpg' };
  const entries = buildReferenceImageEntries([stamped], [MEDIA_ALT]);
  assert.strictEqual(entries[0].originalUrl, 'https://cdn.example/stamped-original.jpg');
  assert.strictEqual(entries[0].url, REFRAME_DERIV);
});

check('D7 primarySubjectDesc is forwarded (colourway misfile is visible here)', () => {
  const entries = buildReferenceImageEntries([CATALOG], [MEDIA_PRIMARY]);
  assert.strictEqual(entries[0].primarySubjectDesc, 'white sneaker');
});

// ══ E. Mongo filter — what the route actually queries ═════════════════════
section('E. buildVideoReferenceMediaFilter');

check('E1 fileUrl $in includes BOTH the submitted crop AND the stripped original', () => {
  const sent = cropImageUrlForAspect(CATALOG, '9:16', null);
  const filter = buildVideoReferenceMediaFilter({
    brandId: 'brand1',
    productId: 'prod1',
    knownMediaIds: ['6a1111111111111111111111'],
    lookupUrls: lookupUrlsFor([sent])
  });
  const fileUrlBranch = filter.$or.find((c) => c.fileUrl && c.fileUrl.$in);
  assert.ok(fileUrlBranch, 'must have a fileUrl $in branch');
  assert.ok(fileUrlBranch.fileUrl.$in.includes(sent), 'submitted URL in $in');
  assert.ok(fileUrlBranch.fileUrl.$in.includes(CATALOG), 'stripped original in $in — otherwise crop misses');
});

check('E2 catalog-product branch is tenant-scoped (brandId + catalogProductId)', () => {
  const filter = buildVideoReferenceMediaFilter({
    brandId: 'brand1',
    productId: 'prod1',
    knownMediaIds: [],
    lookupUrls: [CATALOG]
  });
  const catalog = filter.$or.find((c) => c['metadata.catalogProductId']);
  assert.ok(catalog, 'must search catalog media for this product so reframes can be scanned');
  assert.strictEqual(catalog.brandId, 'brand1');
  assert.strictEqual(catalog['metadata.catalogProductId'], 'prod1');
});

check('E3 catalog-product branch is ABSENT without brandId (fail closed on tenancy)', () => {
  const filter = buildVideoReferenceMediaFilter({
    brandId: null,
    productId: 'prod1',
    knownMediaIds: [],
    lookupUrls: [CATALOG]
  });
  assert.ok(!filter.$or.some((c) => c['metadata.catalogProductId']),
    'must not scan another tenant\'s catalog');
});

check('E4 known media ids from the ad are included (seed + operator picks)', () => {
  const ids = knownMediaIdsFor({
    mediaId: 'm0',
    mediaIds: ['m1', 'm0'],
    referenceMediaIds: ['m2']
  });
  assert.deepStrictEqual(ids.map(String), ['m0', 'm1', 'm2']);
  const filter = buildVideoReferenceMediaFilter({
    brandId: 'b',
    productId: null,
    knownMediaIds: ids,
    lookupUrls: []
  });
  const idBranch = filter.$or.find((c) => c._id);
  assert.ok(idBranch);
  assert.strictEqual(idBranch._id.$in.length, 3);
});

check('E5 empty inputs return null rather than `{ $or: [] }` (invalid Mongo)', () => {
  assert.strictEqual(buildVideoReferenceMediaFilter({
    brandId: 'b', productId: null, knownMediaIds: [], lookupUrls: []
  }), null);
});

check('E6 fileUrl branch is NOT gated on brandId — URL is the identity, same as the pre-fix query', () => {
  const filter = buildVideoReferenceMediaFilter({
    brandId: 'b',
    productId: null,
    knownMediaIds: [],
    lookupUrls: [CATALOG]
  });
  const fileUrlBranch = filter.$or.find((c) => c.fileUrl);
  assert.ok(fileUrlBranch);
  assert.ok(!('brandId' in fileUrlBranch),
    'adding brandId here would miss legacy Media with brandId null');
});

// ══ F. the inspector route actually uses the helper ═══════════════════════
section('F. inspector route wiring');

check('F1 generation-inspector calls buildReferenceImageEntries (not an inline fileUrl-only map)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ads.js'), 'utf8');
  const start = src.indexOf("router.get('/:id/generation-inspector'");
  assert.ok(start > 0, 'inspector route not found — this check is stale');
  const end = src.indexOf('res.json({ inspector: out })', start);
  assert.ok(end > start, 'could not bound the inspector handler');
  const body = src.slice(start, end);
  assert.ok(/buildReferenceImageEntries\s*\(/.test(body),
    'the route must call buildReferenceImageEntries so originalUrl is populated');
  assert.ok(/buildVideoReferenceMediaFilter\s*\(/.test(body),
    'the route must use buildVideoReferenceMediaFilter, not a hand-rolled fileUrl $in');
  assert.ok(/lookupUrlsFor\s*\(/.test(body),
    'the route must expand lookup URLs (stripped transforms) before querying');
  assert.ok(/metadata\.reframes/.test(body),
    'the select must include metadata.reframes or the cache match is blind');
});

check('F2 the inspector no longer does a fileUrl-only $in of the raw submitted list', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ads.js'), 'utf8');
  const start = src.indexOf('── Video generation inputs ──');
  assert.ok(start > 0, 'video-inputs anchor not found');
  const end = src.indexOf('if (!referenceUrls.length)', start);
  assert.ok(end > start, 'could not bound the reference-image lookup');
  const body = src.slice(start, end);
  assert.ok(!/fileUrl:\s*\{\s*\$in:\s*referenceUrls\s*\}/.test(body),
    'raw `fileUrl: { $in: referenceUrls }` is the bug — crops/reframes never match');
});

check('F3 the lookup is still read-only (no writes in the reference-image block)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ads.js'), 'utf8');
  const start = src.indexOf('── Video generation inputs ──');
  const end = src.indexOf("out.video = {", start);
  assert.ok(end > start);
  const body = src.slice(start, end);
  for (const mutator of ['updateOne', 'updateMany', 'insertMany', '$set', '$inc', 'deleteOne', '.save(']) {
    assert.ok(!body.includes(mutator),
      `the reference-image lookup must be READ-ONLY — found ${mutator}`);
  }
});

check('F4 routes/ads.js requires the lineage module (a call without an import is a ReferenceError)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ads.js'), 'utf8');
  assert.ok(/require\('\.\.\/services\/videoReferenceLineage'\)/.test(src),
    'the route must import videoReferenceLineage — a regex on the call site cannot see an unbound identifier');
});

// ── report ──────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`\n❌ verifyVideoReferenceLineage: ${failures.length} of ${pass + failures.length} checks FAILED\n`);
  failures.forEach((f, i) => console.error(`  ${i + 1}. ${f}`));
  process.exit(1);
}
console.log(`\n✅ verifyVideoReferenceLineage: ${pass}/${pass} checks passed`);
