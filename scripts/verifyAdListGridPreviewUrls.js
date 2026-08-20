#!/usr/bin/env node
/**
 * verifyAdListGridPreviewUrls.js
 *
 * Pins the per-ad `previewImageUrl` / `previewVideoUrl` projection on
 * services/capabilityExecutors/adList.js — the agent-facing sibling of
 * routes/ads.js `projectAd()` and routes/catalog.js `ads-detail`.
 *
 * WHY THIS EXISTS: the agent's ad.list resource cards render AdThumbnail
 * tiles. Without these fields the chat grid pulled every full-resolution
 * master (the same 1.5-4.3MB PNG / 1080p video problem
 * scripts/verifyImageGridPreviewUrl.js and verifyVideoGridPreviewUrl.js
 * already closed on the HTTP list endpoints). adList must derive the
 * tile URLs from the SHARED builders, prefer photoreal polish when the
 * join map has one (otherwise the card and AdDetailModal show two
 * different images), and leave `renderUrl` untouched so a detail view
 * of the same row still has the master.
 *
 * BEHAVIOURAL, not source-text, for everything that can be: every
 * projection check drives the REAL exported `run()`. A reimplementation
 * that keeps the field names but changes the derivation still fails.
 * The query layer is stubbed — no Mongo, no network, no mongoose
 * connection. The one source-text check is S2, which forbids a second
 * copy of the transform string inside adList.js itself.
 *
 * STUB ORDER IS LOAD-BEARING. adList.js destructures
 * `{ loadPhotorealUrlMap, loadUseImageRefMap }` at require time, so
 * overwriting adDisplayUrlService's exports AFTER requiring adList
 * is a silent no-op — the photoreal preference would never run and
 * P3 would be testing a path the stubs never reached. Models are
 * different: adList holds the Ad/Brand *objects*, so mutating
 * `Ad.find` / `Brand.findOne` works at any time.
 *
 * REVERT-PROOF:
 *   - drop previewImageUrl / previewVideoUrl from the
 *     projection                          -> P0 red (keys must be `in`)
 *   - image Cloudinary tile equals renderUrl
 *     or lacks c_scale/w_640              -> P1 red
 *   - video Cloudinary tile equals renderUrl
 *     or lacks c_scale/w_480              -> P2 red
 *   - preview from pre-polish renderUrl
 *     when photoreal is set               -> P3 red (grid/detail mismatch)
 *   - non-Cloudinary image URL becomes
 *     null instead of passing through     -> P4 red (broken <img> src)
 *   - null renderUrl becomes the string
 *     "null"/"undefined"                  -> P5 red
 *   - non-Cloudinary video URL becomes
 *     null instead of passing through     -> P6 red
 *   - drop renderUrl or kind from Ad.find
 *     .select()                           -> S1 red (preview computes off
 *                                           undefined)
 *   - inline c_scale,w_N,q_auto,f_auto in
 *     adList.js instead of the shared
 *     builders                            -> S2 red
 *
 * Run: node scripts/verifyAdListGridPreviewUrls.js
 */
'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.join(__dirname, '..');

// Import the declared widths rather than hardcoding them: retuning either
// constant is a legitimate change and must not turn this script red. What is
// pinned here is that adList's tile URL carries THAT service's width — i.e.
// that it went through the shared builder at all.
const { GRID_PREVIEW_WIDTH_PX: IMAGE_W } =
  require(path.join(ROOT, 'services', 'imagePreviewUrl.js'));
const { GRID_PREVIEW_WIDTH_PX: VIDEO_W } =
  require(path.join(ROOT, 'services', 'videoPreviewUrl.js'));

let pass = 0;
const failures = [];
function check(name, fn) {
  try { fn(); pass++; } catch (e) { failures.push(`${name} — ${e.message}`); }
}

const BRAND_ID      = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ADVERTISER_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb';

const ID = {
  imgCloud:   '000000000000000000000001',
  vidCloud:   '000000000000000000000002',
  imgPhoto:   '000000000000000000000003',
  imgForeign: '000000000000000000000004',
  imgNull:    '000000000000000000000005',
  vidForeign: '000000000000000000000006'
};

const IMG_CLOUD =
  'https://res.cloudinary.com/demo/image/upload/v1712345678/ads/static_4x5.png';
const VID_CLOUD =
  'https://res.cloudinary.com/demo/video/upload/v1712345678/ads/master_9x16.mp4';
const IMG_RAW =
  'https://res.cloudinary.com/demo/image/upload/v1/ads/hero_raw.png';
const IMG_PHOTOREAL =
  'https://res.cloudinary.com/demo/image/upload/v1/ads/hero_photoreal.png';
const IMG_FOREIGN = 'https://cdn.example.com/i/x.png';
const VID_FOREIGN = 'https://cdn.example.com/v/x.mp4';

function adRow(over) {
  return {
    kind: 'image',
    template: 'ai_brand_led',
    status: 'draft',
    renderUrl: null,
    copy: {},
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    ...over
  };
}

const FIXTURE_ROWS = [
  adRow({ _id: ID.imgCloud,   kind: 'image', renderUrl: IMG_CLOUD }),
  adRow({ _id: ID.vidCloud,   kind: 'video', renderUrl: VID_CLOUD }),
  adRow({ _id: ID.imgPhoto,   kind: 'image', renderUrl: IMG_RAW }),
  adRow({ _id: ID.imgForeign, kind: 'image', renderUrl: IMG_FOREIGN }),
  adRow({ _id: ID.imgNull,    kind: 'image', renderUrl: null }),
  adRow({ _id: ID.vidForeign, kind: 'video', renderUrl: VID_FOREIGN })
];

function selectHas(sel, field) {
  if (typeof sel === 'string') return sel.split(/\s+/).includes(field);
  if (sel && typeof sel === 'object') return sel[field] === 1 || sel[field] === true;
  return false;
}

(async () => {
  // Overwrite the display-url joins on the exports object BEFORE the
  // first require of adList.js — it destructures them at load time and
  // would otherwise keep the originals (which hit Mongo).
  const adDisplayUrlService = require(path.join(ROOT, 'services', 'adDisplayUrlService.js'));
  adDisplayUrlService.loadPhotorealUrlMap = async (ads) => {
    const map = new Map();
    for (const a of ads || []) {
      if (String(a._id) === ID.imgPhoto) map.set(String(a._id), IMG_PHOTOREAL);
    }
    return map;
  };
  adDisplayUrlService.loadUseImageRefMap = async () => new Map();

  const { run } = require(path.join(ROOT, 'services', 'capabilityExecutors', 'adList.js'));
  const Ad    = require(path.join(ROOT, 'models', 'Ad.js'));
  const Brand = require(path.join(ROOT, 'models', 'Brand.js'));

  Brand.findOne = () => {
    const chain = {};
    chain.select = () => chain;
    chain.lean   = async () => ({ _id: BRAND_ID, name: 'Fixture Brand' });
    return chain;
  };

  Ad.countDocuments = async () => FIXTURE_ROWS.length;

  let capturedSelect = null;
  Ad.find = () => {
    const chain = {};
    chain.sort   = () => chain;
    chain.limit  = () => chain;
    chain.select = (fields) => { capturedSelect = fields; return chain; };
    chain.lean   = async () => FIXTURE_ROWS;
    return chain;
  };

  let result;
  try {
    result = await run({
      req:  { advertiserId: ADVERTISER_ID },
      args: { brandId: BRAND_ID }
    });
  } catch (e) {
    result = { ok: false, error: `threw: ${e && e.stack ? e.stack : e}` };
  }

  const ads  = (result && result.data && Array.isArray(result.data.ads)) ? result.data.ads : [];
  const byId = new Map(ads.map((a) => [a._id, a]));

  function row(id) {
    const a = byId.get(id);
    assert.ok(a, `run() did not return ad ${id}`);
    return a;
  }

  check('R1 run() succeeds and returns every fixture row', () => {
    assert.strictEqual(typeof run, 'function', 'adList must export run()');
    assert.ok(result.ok, `run() failed: ${result && result.error}`);
    assert.strictEqual(ads.length, FIXTURE_ROWS.length,
      `expected ${FIXTURE_ROWS.length} ads, got ${ads.length}`);
  });

  // If renderUrl or kind is dropped from the query projection, the
  // preview URLs silently compute off `undefined` and every row looks
  // like the null-renderUrl case — green checks, broken tiles.
  check('S1 Ad.find .select() still projects renderUrl and kind', () => {
    assert.ok(capturedSelect != null, 'Ad.find().select() was never called');
    assert.ok(selectHas(capturedSelect, 'renderUrl'),
      `renderUrl missing from select: ${JSON.stringify(capturedSelect)}`);
    assert.ok(selectHas(capturedSelect, 'kind'),
      `kind missing from select: ${JSON.stringify(capturedSelect)}`);
  });

  check('P0 both preview keys are present on every returned ad', () => {
    assert.ok(ads.length > 0, 'no ads returned — cannot prove keys are present');
    for (const a of ads) {
      assert.ok('previewImageUrl' in a,
        `previewImageUrl missing on ad ${a._id}`);
      assert.ok('previewVideoUrl' in a,
        `previewVideoUrl missing on ad ${a._id}`);
    }
  });

  check('P1 image Cloudinary ad gets a downscaled previewImageUrl, master untouched', () => {
    const a = row(ID.imgCloud);
    assert.ok(a.previewImageUrl, 'previewImageUrl must be populated for an image ad');
    assert.ok(a.previewImageUrl.includes('c_scale'),
      `expected the downscaled variant, got ${a.previewImageUrl}`);
    assert.ok(a.previewImageUrl.includes(`w_${IMAGE_W}`),
      `expected w_${IMAGE_W} in ${a.previewImageUrl}`);
    assert.notStrictEqual(a.previewImageUrl, a.renderUrl,
      'the tile URL must differ from the full master');
    assert.strictEqual(a.previewVideoUrl, null,
      'an image ad must not carry a video tile URL');
    assert.strictEqual(a.renderUrl, IMG_CLOUD,
      'renderUrl must remain the full-quality master');
  });

  check('P2 video Cloudinary ad gets a downscaled previewVideoUrl', () => {
    const a = row(ID.vidCloud);
    assert.ok(a.previewVideoUrl, 'previewVideoUrl must be populated for a video ad');
    assert.ok(a.previewVideoUrl.includes('c_scale'),
      `expected the downscaled variant, got ${a.previewVideoUrl}`);
    assert.ok(a.previewVideoUrl.includes(`w_${VIDEO_W}`),
      `expected w_${VIDEO_W} in ${a.previewVideoUrl}`);
    assert.notStrictEqual(a.previewVideoUrl, a.renderUrl,
      'the tile URL must differ from the full master');
    assert.strictEqual(a.previewImageUrl, null,
      'a video ad must not carry a static-image tile URL (previewVideoUrl already covers it)');
    assert.strictEqual(a.renderUrl, VID_CLOUD,
      'renderUrl must remain the full-quality master');
  });

  // Mirrors displayUrlFor() on the frontend: an image ad shows
  // photorealUrl over renderUrl whenever the polish is populated. The
  // grid tile must downscale THAT asset, or the card and the detail
  // modal would show two different images at two different sizes.
  check('P3 photoreal polish is previewed, not the pre-polish renderUrl', () => {
    const a = row(ID.imgPhoto);
    assert.ok(a.previewImageUrl, 'previewImageUrl must be populated when photoreal is set');
    assert.ok(a.previewImageUrl.includes('hero_photoreal'),
      `expected the previewed asset to be the photoreal polish, got ${a.previewImageUrl}`);
    assert.ok(!a.previewImageUrl.includes('hero_raw'),
      `must not silently fall back to the pre-polish render when photoreal is set: ${a.previewImageUrl}`);
  });

  check('P4 a non-Cloudinary image renderUrl falls back to itself', () => {
    const a = row(ID.imgForeign);
    assert.strictEqual(a.previewImageUrl, IMG_FOREIGN,
      'fallback must be the original URL so the <img> still has a src');
  });

  check('P5 image ad with null renderUrl and no photoreal yields null, not a broken string', () => {
    const a = row(ID.imgNull);
    assert.strictEqual(a.previewImageUrl, null);
    assert.notStrictEqual(a.previewImageUrl, 'null');
    assert.notStrictEqual(a.previewImageUrl, 'undefined');
  });

  check('P6 a non-Cloudinary video renderUrl falls back to itself', () => {
    const a = row(ID.vidForeign);
    assert.strictEqual(a.previewVideoUrl, VID_FOREIGN,
      'fallback must be the original URL so the <video> still has a src');
  });

  // The two builders declare different widths, so asserting the image tile
  // carries the IMAGE width (and the video tile the VIDEO width) also proves
  // the two branches are not crossed — swapping them turns P1/P2 red.
  check('S1b the image and video builders are distinguishable by width', () => {
    assert.notStrictEqual(IMAGE_W, VIDEO_W,
      'if the two widths ever converge, P1/P2 can no longer prove the correct ' +
      'builder was used for each kind — pin the transform another way');
  });

  check('S2 adList.js does not hand-roll the grid transform string', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'services', 'capabilityExecutors', 'adList.js'),
      'utf8'
    );
    assert.ok(!(/c_scale,w_\d+,q_auto,f_auto/).test(src),
      'the transform string must live only in the shared builders, not in adList.js');
  });

  console.log(failures.length
    ? `\n❌ verifyAdListGridPreviewUrls: ${pass} passed, ${failures.length} FAILED\n   ` + failures.join('\n   ')
    : `✅ verifyAdListGridPreviewUrls: ${pass}/${pass} checks passed`);
  process.exit(failures.length ? 1 : 0);
})();
