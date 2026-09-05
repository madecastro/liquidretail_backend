#!/usr/bin/env node
//
// verifyImageUrlUpgrade — offline harness for services/imageUrlUpgrade.js
// and its wiring into genericCatalogResolver.imagesFromNode.
//
// Pure + offline: no DB, no network, no API key. fetchHead is INJECTED.
//   node scripts/verifyImageUrlUpgrade.js
//
// Revert-prove (report both numbers):
//   (i)  make upgrade unconditional (drop HEAD verification) → false-positive
//        check MUST FAIL
//   (ii) de-dupe BEFORE upgrading instead of after → collapse check MUST FAIL

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Load defaults.env the same way index.js does (env always wins).
require('dotenv').config({ path: path.join(__dirname, '..', 'config', 'defaults.env') });

const {
  upgradeImageUrl,
  resolveUpgradedImageUrl,
  upgradeImageUrlList,
  dedupeUrlsFirstSeen,
  createImageUpgradeRun,
  isCatalogImageUpgradeEnabled,
  catalogImageUpgradeMaxChecks
} = require('../services/imageUrlUpgrade');

const { imagesFromNode } = require('../services/genericCatalogResolver');

let pass = 0;
let fail = 0;

function check(label, fn) {
  try {
    fn();
    pass += 1;
    console.log(`✓ ${label}`);
  } catch (err) {
    fail += 1;
    const msg = err && err.message ? err.message : String(err);
    console.log(`❌ ${label}: ${msg}`);
  }
}

async function checkAsync(label, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`✓ ${label}`);
  } catch (err) {
    fail += 1;
    const msg = err && err.message ? err.message : String(err);
    console.log(`❌ ${label}: ${msg}`);
  }
}

// ── fixtures (measured live, marinelayer.com 2026-08-11) ───────────

const ML_SMALL =
  'https://www.marinelayer.com/cdn/shop/files/F1_W_Riley_Denim_Barn_Jacket_Rinse_11822-Final-Web_small.jpg?v=1784225280';
const ML_ORIGINAL =
  'https://www.marinelayer.com/cdn/shop/files/F1_W_Riley_Denim_Barn_Jacket_Rinse_11822-Final-Web.jpg?v=1784225280';

const CDN_BASE =
  'https://cdn.shopify.com/s/files/1/0831/9103/files/F1_W_Riley_Denim_Barn_Jacket_Rinse_11822-Final-Web';

// ── A. Pure upgrade — measured pair ────────────────────────────────

check('A1 marinelayer _small → unsuffixed, ?v= preserved byte-for-byte', () => {
  const r = upgradeImageUrl(ML_SMALL);
  assert.equal(r.upgraded, true);
  assert.equal(r.url, ML_ORIGINAL);
  assert.equal(r.original, ML_SMALL);
  assert.ok(r.reason);
  // Query string preserved exactly
  assert.ok(r.url.endsWith('?v=1784225280'));
  assert.equal(r.url.includes('_small'), false);
});

check('A2 cdn.shopify.com host form also upgrades', () => {
  const small = `${CDN_BASE}_small.jpg?v=1784225280`;
  const r = upgradeImageUrl(small);
  assert.equal(r.upgraded, true);
  assert.equal(r.url, `${CDN_BASE}.jpg?v=1784225280`);
});

check('A3 already-original is not upgraded', () => {
  const r = upgradeImageUrl(ML_ORIGINAL);
  assert.equal(r.upgraded, false);
  assert.equal(r.url, ML_ORIGINAL);
});

// ── B. Named sizes + dimension shapes ──────────────────────────────

const NAMED = [
  'pico', 'icon', 'thumb', 'small', 'compact', 'medium',
  'large', 'grande', 'original', 'master'
];

for (const name of NAMED) {
  check(`B named _${name} stripped`, () => {
    const inUrl = `https://cdn.shopify.com/s/files/1/x/y/photo_${name}.jpg?v=9`;
    const r = upgradeImageUrl(inUrl);
    assert.equal(r.upgraded, true, `expected upgrade for _${name}`);
    assert.equal(r.url, 'https://cdn.shopify.com/s/files/1/x/y/photo.jpg?v=9');
  });
}

check('B dim _1024x1024 stripped', () => {
  const r = upgradeImageUrl('https://cdn.shopify.com/s/files/1/x/y/photo_1024x1024.jpg');
  assert.equal(r.upgraded, true);
  assert.equal(r.url, 'https://cdn.shopify.com/s/files/1/x/y/photo.jpg');
});

check('B dim _600x stripped', () => {
  const r = upgradeImageUrl('https://cdn.shopify.com/s/files/1/x/y/photo_600x.png');
  assert.equal(r.upgraded, true);
  assert.equal(r.url, 'https://cdn.shopify.com/s/files/1/x/y/photo.png');
});

check('B dim _x800 stripped', () => {
  const r = upgradeImageUrl('https://cdn.shopify.com/s/files/1/x/y/photo_x800.webp');
  assert.equal(r.upgraded, true);
  assert.equal(r.url, 'https://cdn.shopify.com/s/files/1/x/y/photo.webp');
});

check('B @2x on dims stripped', () => {
  const r = upgradeImageUrl('https://cdn.shopify.com/s/files/1/x/y/photo_1024x1024@2x.jpg');
  assert.equal(r.upgraded, true);
  assert.equal(r.url, 'https://cdn.shopify.com/s/files/1/x/y/photo.jpg');
});

check('B _crop_center after named size stripped', () => {
  const r = upgradeImageUrl(
    'https://cdn.shopify.com/s/files/1/x/y/photo_large_crop_center.jpg?v=1'
  );
  assert.equal(r.upgraded, true);
  assert.equal(r.url, 'https://cdn.shopify.com/s/files/1/x/y/photo.jpg?v=1');
});

check('B _1024x1024_crop_center stripped', () => {
  const r = upgradeImageUrl(
    'https://cdn.shopify.com/s/files/1/x/y/photo_1024x1024_crop_center.jpg'
  );
  assert.equal(r.upgraded, true);
  assert.equal(r.url, 'https://cdn.shopify.com/s/files/1/x/y/photo.jpg');
});

check('B /cdn/shopifycloud/ path form is Shopify', () => {
  const r = upgradeImageUrl(
    'https://store.example.com/cdn/shopifycloud/s/files/1/x/y/a_medium.jpg'
  );
  assert.equal(r.upgraded, true);
  assert.equal(r.url, 'https://store.example.com/cdn/shopifycloud/s/files/1/x/y/a.jpg');
});

// ── C. Query-param form ────────────────────────────────────────────

check('C width= dropped, v= kept', () => {
  const r = upgradeImageUrl(
    'https://cdn.shopify.com/s/files/1/x/y/photo.jpg?width=400&v=123'
  );
  assert.equal(r.upgraded, true);
  assert.equal(r.url, 'https://cdn.shopify.com/s/files/1/x/y/photo.jpg?v=123');
});

check('C width+height+crop dropped, other keys kept', () => {
  const r = upgradeImageUrl(
    'https://cdn.shopify.com/s/files/1/x/y/photo.jpg?width=400&height=300&crop=center&v=99&format=webp'
  );
  assert.equal(r.upgraded, true);
  assert.equal(
    r.url,
    'https://cdn.shopify.com/s/files/1/x/y/photo.jpg?v=99&format=webp'
  );
});

check('C size suffix AND width query both cleaned', () => {
  const r = upgradeImageUrl(
    'https://cdn.shopify.com/s/files/1/x/y/photo_small.jpg?width=200&v=5'
  );
  assert.equal(r.upgraded, true);
  assert.equal(r.url, 'https://cdn.shopify.com/s/files/1/x/y/photo.jpg?v=5');
});

// ── D. WordPress ───────────────────────────────────────────────────

check('D WordPress -150x150.jpg stripped', () => {
  const r = upgradeImageUrl('https://blog.example.com/wp-content/uploads/2024/shirt-150x150.jpg');
  assert.equal(r.upgraded, true);
  assert.equal(r.url, 'https://blog.example.com/wp-content/uploads/2024/shirt.jpg');
  assert.equal(r.reason, 'wordpress-size-suffix');
});

check('D WordPress -1024x768.png stripped, query kept', () => {
  const r = upgradeImageUrl(
    'https://shop.example.com/wp-content/uploads/a-1024x768.png?ver=2'
  );
  assert.equal(r.upgraded, true);
  assert.equal(r.url, 'https://shop.example.com/wp-content/uploads/a.png?ver=2');
});

// ── E. Untouched / garbage in ──────────────────────────────────────

check('E non-Shopify non-WP URL untouched', () => {
  const u = 'https://images.example.com/products/hero.jpg';
  const r = upgradeImageUrl(u);
  assert.equal(r.upgraded, false);
  assert.equal(r.url, u);
});

check('E null → unchanged, no throw', () => {
  const r = upgradeImageUrl(null);
  assert.equal(r.upgraded, false);
  assert.equal(r.url, null);
});

check('E empty string → unchanged', () => {
  const r = upgradeImageUrl('');
  assert.equal(r.upgraded, false);
  assert.equal(r.url, '');
});

check('E number 42 → unchanged', () => {
  const r = upgradeImageUrl(42);
  assert.equal(r.upgraded, false);
  assert.equal(r.url, 42);
});

check('E "not a url" → unchanged', () => {
  const r = upgradeImageUrl('not a url');
  assert.equal(r.upgraded, false);
  assert.equal(r.url, 'not a url');
});

check('E relative path → unchanged', () => {
  const r = upgradeImageUrl('/cdn/shop/files/photo_small.jpg');
  assert.equal(r.upgraded, false);
  assert.equal(r.url, '/cdn/shop/files/photo_small.jpg');
});

// ── F. False positive — HEAD verification is REQUIRED ──────────────
// A file legitimately named photo_large.jpg must NOT be rewritten to
// photo.jpg when HEAD of the stripped URL returns 404.

async function runAsyncChecks() {
  await checkAsync('F1 404 on upgraded → keep ORIGINAL thumbnail (false-positive safe)', async () => {
    const original = 'https://cdn.shopify.com/s/files/1/x/y/photo_large.jpg?v=1';
    const upgraded = 'https://cdn.shopify.com/s/files/1/x/y/photo.jpg?v=1';
    // Prove pure upgrade WOULD strip (so the resolve path is the guard)
    const pure = upgradeImageUrl(original);
    assert.equal(pure.upgraded, true);
    assert.equal(pure.url, upgraded);

    let calls = 0;
    const fetchHead = async (url) => {
      calls += 1;
      assert.equal(url, upgraded);
      return 404;
    };
    const out = await resolveUpgradedImageUrl(original, { fetchHead });
    assert.equal(out, original, 'must fall back to original on non-2xx');
    assert.equal(calls, 1);
  });

  await checkAsync('F2 200 on upgraded → keep UPGRADED url', async () => {
    const original = ML_SMALL;
    let calls = 0;
    const fetchHead = async (url) => {
      calls += 1;
      assert.equal(url, ML_ORIGINAL);
      return 200;
    };
    const out = await resolveUpgradedImageUrl(original, { fetchHead });
    assert.equal(out, ML_ORIGINAL);
    assert.equal(calls, 1);
  });

  await checkAsync('F3 network error → keep original', async () => {
    const original = ML_SMALL;
    const fetchHead = async () => {
      throw new Error('ECONNRESET');
    };
    const out = await resolveUpgradedImageUrl(original, { fetchHead });
    assert.equal(out, original);
  });

  await checkAsync('F4 no fetchHead injected → keep original (fail safe)', async () => {
    const out = await resolveUpgradedImageUrl(ML_SMALL, {});
    assert.equal(out, ML_SMALL);
  });

  // ── G. Collapse / de-dupe AFTER upgrade ──────────────────────────

  await checkAsync('G1 _small + _1024x1024 collapse to ONE original, first-seen order', async () => {
    const a = 'https://cdn.shopify.com/s/files/1/x/y/photo_small.jpg?v=1';
    const b = 'https://cdn.shopify.com/s/files/1/x/y/photo_1024x1024.jpg?v=1';
    const c = 'https://cdn.shopify.com/s/files/1/x/y/other_medium.jpg?v=1';
    const origA = 'https://cdn.shopify.com/s/files/1/x/y/photo.jpg?v=1';
    const origC = 'https://cdn.shopify.com/s/files/1/x/y/other.jpg?v=1';

    const fetchHead = async () => 200;
    const list = await upgradeImageUrlList([a, b, c], { fetchHead });
    assert.deepEqual(list, [origA, origC]);
  });

  await checkAsync('G2 imagesFromNode upgrades then de-dupes (feed order)', async () => {
    const node = {
      image: [
        'https://cdn.shopify.com/s/files/1/x/y/hero_small.jpg?v=1',
        'https://cdn.shopify.com/s/files/1/x/y/hero_1024x1024.jpg?v=1',
        'https://cdn.shopify.com/s/files/1/x/y/alt_medium.jpg?v=1'
      ]
    };
    const run = createImageUpgradeRun({ fetchHead: async () => 200 });
    const out = await imagesFromNode(node, 'https://store.example.com/p/1', {
      upgradeRun: run
    });
    assert.equal(out.imageUrl, 'https://cdn.shopify.com/s/files/1/x/y/hero.jpg?v=1');
    assert.deepEqual(out.additionalImages, [
      'https://cdn.shopify.com/s/files/1/x/y/alt.jpg?v=1'
    ]);
  });

  await checkAsync('G3 flag-off / no upgradeRun → exact-dedupe only (byte-identical prior)', async () => {
    const node = {
      image: [
        'https://cdn.shopify.com/s/files/1/x/y/hero_small.jpg?v=1',
        'https://cdn.shopify.com/s/files/1/x/y/hero_small.jpg?v=1',
        'https://cdn.shopify.com/s/files/1/x/y/alt.jpg?v=1'
      ]
    };
    // No upgradeRun → prior path even when flag is on
    const out = await imagesFromNode(node, 'https://store.example.com/p/1');
    assert.equal(out.imageUrl, 'https://cdn.shopify.com/s/files/1/x/y/hero_small.jpg?v=1');
    assert.deepEqual(out.additionalImages, [
      'https://cdn.shopify.com/s/files/1/x/y/alt.jpg?v=1'
    ]);
  });

  // ── H. Memoisation ───────────────────────────────────────────────

  await checkAsync('H1 same URL twice → ONE fetchHead call', async () => {
    let calls = 0;
    const fetchHead = async () => {
      calls += 1;
      return 200;
    };
    const run = createImageUpgradeRun({ fetchHead });
    const a = await run.resolve(ML_SMALL);
    const b = await run.resolve(ML_SMALL);
    assert.equal(a, ML_ORIGINAL);
    assert.equal(b, ML_ORIGINAL);
    assert.equal(calls, 1, `expected 1 HEAD, got ${calls}`);
  });

  // ── I. Cap ───────────────────────────────────────────────────────

  await checkAsync('I1 past MAX_CHECKS → leave further candidates un-upgraded', async () => {
    let calls = 0;
    const fetchHead = async () => {
      calls += 1;
      return 200;
    };
    const run = createImageUpgradeRun({ fetchHead, maxChecks: 2 });
    const u1 = 'https://cdn.shopify.com/s/files/1/x/y/a_small.jpg';
    const u2 = 'https://cdn.shopify.com/s/files/1/x/y/b_small.jpg';
    const u3 = 'https://cdn.shopify.com/s/files/1/x/y/c_small.jpg';
    const r1 = await run.resolve(u1);
    const r2 = await run.resolve(u2);
    const r3 = await run.resolve(u3);
    assert.equal(r1, 'https://cdn.shopify.com/s/files/1/x/y/a.jpg');
    assert.equal(r2, 'https://cdn.shopify.com/s/files/1/x/y/b.jpg');
    // Third is past the cap → original left in place
    assert.equal(r3, u3);
    assert.equal(calls, 2);
    assert.equal(run.checksUsed, 2);
  });

  // ── J. Env / wiring ──────────────────────────────────────────────

  check('J1 CATALOG_IMAGE_UPGRADE_ENABLED defaults true', () => {
    assert.equal(isCatalogImageUpgradeEnabled(), true);
  });

  check('J2 CATALOG_IMAGE_UPGRADE_MAX_CHECKS defaults 500', () => {
    assert.equal(catalogImageUpgradeMaxChecks(), 500);
  });

  check('J3 defaults.env declares both keys', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'config', 'defaults.env'),
      'utf8'
    );
    const env = src
      .replace(/^[ \t]*#.*$/gm, '')
      .replace(/[ \t]+#.*$/gm, '')
      .replace(/[ \t]+$/gm, '');
    // Line-anchored after stripping `#` comments — a leftover `# …=true`
    // comment used to satisfy the flag, and `=500` is a prefix of `=5000`.
    // Same shape as verifyRegeneration.js R6a / verifyNoStrandedQueued.js F13.
    assert.ok(/^CATALOG_IMAGE_UPGRADE_ENABLED=true$/m.test(env),
      'CATALOG_IMAGE_UPGRADE_ENABLED must ship true (a comment documenting the old value does not count)');
    assert.ok(!/^CATALOG_IMAGE_UPGRADE_ENABLED=false$/m.test(env),
      'CATALOG_IMAGE_UPGRADE_ENABLED must not also ship false');
    const maxChecks = env.match(/^CATALOG_IMAGE_UPGRADE_MAX_CHECKS=(\d+)$/m);
    assert.ok(maxChecks, 'CATALOG_IMAGE_UPGRADE_MAX_CHECKS assignment missing from defaults.env');
    assert.equal(Number(maxChecks[1]), 500);
    // Measured pair cited in the comment (defence against a drive-by rewrite)
    assert.ok(/3,?820/.test(src) || /3820/.test(src));
    assert.ok(/757,?341/.test(src) || /757341/.test(src));
  });

  check('J4 .env.example documents both keys', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '.env.example'),
      'utf8'
    );
    assert.ok(/CATALOG_IMAGE_UPGRADE_ENABLED=/.test(src));
    assert.ok(/CATALOG_IMAGE_UPGRADE_MAX_CHECKS=/.test(src));
  });

  check('J5 genericCatalogResolver wires imageUrlUpgrade', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'genericCatalogResolver.js'),
      'utf8'
    );
    assert.ok(/require\('\.\/imageUrlUpgrade'\)/.test(src));
    assert.ok(/createImageUpgradeRun/.test(src));
    assert.ok(/makeHttpScrapeFetchHead/.test(src));
    assert.ok(/upgradeRun/.test(src));
  });

  check('J6 imageUrlUpgrade has no require() of I/O modules (pure core)', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'imageUrlUpgrade.js'),
      'utf8'
    );
    // No http/https/axios/httpScrapeClient requires — fetchHead is injected.
    assert.equal(/require\(['"]https?['"]\)/.test(src), false);
    assert.equal(/require\(['"].*httpScrapeClient['"]\)/.test(src), false);
    assert.equal(/require\(['"]axios['"]\)/.test(src), false);
    assert.equal(/require\(['"]node-fetch['"]\)/.test(src), false);
  });

  check('J7 dedupeUrlsFirstSeen preserves first-seen order', () => {
    assert.deepEqual(
      dedupeUrlsFirstSeen(['a', 'b', 'a', 'c', 'b']),
      ['a', 'b', 'c']
    );
  });

  // ── K. Revert-proof probes (structural — the mutations themselves are
  // run manually; these assert the guards that make those mutations fail) ─

  await checkAsync('K1 resolve path consults fetchHead before accepting upgrade', async () => {
    // Structural: if HEAD verification were dropped, this would return upgraded
    // on 404. Pin that 404 keeps original.
    const original = 'https://cdn.shopify.com/s/files/1/x/y/realname_large.jpg';
    const out = await resolveUpgradedImageUrl(original, {
      fetchHead: async () => 404
    });
    assert.equal(out, original);
  });

  await checkAsync('K2 upgradeList de-dupes AFTER resolve (not before)', async () => {
    // If de-dupe ran first on exact URLs, a_small and a_1024x1024 would both
    // survive as distinct; after upgrade they must collapse.
    const fetchHead = async () => 200;
    const list = await upgradeImageUrlList(
      [
        'https://cdn.shopify.com/s/files/1/x/y/a_small.jpg',
        'https://cdn.shopify.com/s/files/1/x/y/a_1024x1024.jpg'
      ],
      { fetchHead }
    );
    assert.equal(list.length, 1);
    assert.equal(list[0], 'https://cdn.shopify.com/s/files/1/x/y/a.jpg');
  });
}

runAsyncChecks()
  .then(() => {
    const total = pass + fail;
    console.log(`\n${pass}/${total} checks passed`);
    process.exit(fail ? 1 : 0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
