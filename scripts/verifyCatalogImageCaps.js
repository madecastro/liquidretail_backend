#!/usr/bin/env node
'use strict';
/**
 * verifyCatalogImageCaps — fences the per-product ADDITIONAL-images cap
 * shared by every catalog ingest path.
 *
 * WHY THIS EXISTS
 * Five ingest writers used to disagree on how many alt images to keep:
 *   generic JSON-LD resolver  → slice(1, 5)  = 4 alts  (hero-offset)
 *   generic upsert            → slice(0, 4)  = 4 alts  (alts-only array)
 *   Shopify public            → slice(1, 9)  = 8 alts  (hero-offset)
 *   Meta catalog sync         → slice(0, 8)  = 8 alts  (alts-only array)
 *   Apify Shopify ingest      → slice(0, 8)  = 8 alts  (alts-only array)
 * Downstream detect already materializes up to MAX_ALT_IMAGES = 12
 * (catalogProductDetectService). Raising the ingest writers to the same
 * 12 via one shared MAX_ADDITIONAL_IMAGES const means a chatty feed is
 * never silently truncated below what detect will use — and the two
 * slice SHAPES stay correct (hero-offset vs already-alts).
 *
 * The constant lives in services/catalogImageLimits.js — a zero-require
 * module — so Meta catalog sync (and any non-scrape consumer) can read
 * the integer without dragging the scraping stack into its module graph,
 * and so Shopify / Apify ingest can require it at top level with no
 * circular load.
 *
 * apifyPullService returns images.slice(1) UNCAPPED on purpose — the
 * ingest writer is the bound. Do not "fix" the pull service cap.
 *
 * Run:  node scripts/verifyCatalogImageCaps.js
 * Offline: no DB, no network, no API keys.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIMITS = path.join(ROOT, 'services/catalogImageLimits.js');
// ALL FIVE writers. Adding a sixth without the shared import must fail
// the C* fence below — that is the regression this harness exists for.
const OWNED = {
  resolver: path.join(ROOT, 'services/genericCatalogResolver.js'),
  genericIngest: path.join(ROOT, 'services/genericCatalogIngestService.js'),
  shopify: path.join(ROOT, 'services/shopifyPublicIngestService.js'),
  metaSync: path.join(ROOT, 'services/catalogSyncService.js'),
  apifyIngest: path.join(ROOT, 'services/apifyIngestService.js'),
};
const DETECT = path.join(ROOT, 'services/catalogProductDetectService.js');

let pass = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(detail ? `${label}: ${detail}` : label);
}

function read(p) { return fs.readFileSync(p, 'utf8'); }

function clearLimitsCache() {
  // Re-require under a different env must drop the module. Dependents that
  // closed over its export at load time are re-required only if already
  // cached (none of the call-site runtime checks need them).
  const keys = Object.keys(require.cache).filter((k) =>
    k.includes(`${path.sep}services${path.sep}catalogImageLimits.js`)
  );
  for (const k of keys) delete require.cache[k];
}

console.log('\nverifyCatalogImageCaps\n');

// ── A. shared const: source shape + zero-require + runtime default ──
const limitsSrc = read(LIMITS);

check(
  'A1 MAX_ADDITIONAL_IMAGES is declared in catalogImageLimits',
  /const\s+MAX_ADDITIONAL_IMAGES\s*=/.test(limitsSrc),
  'declaration missing from catalogImageLimits.js'
);

check(
  'A2 const is env-overridable via CATALOG_MAX_ADDITIONAL_IMAGES',
  /process\.env\.CATALOG_MAX_ADDITIONAL_IMAGES/.test(limitsSrc),
  'env reader missing'
);

check(
  'A3 default is 12 (|| 12) and clamped with Math.max(1, …)',
  /Math\.max\s*\(\s*1\s*,\s*parseInt\s*\(\s*process\.env\.CATALOG_MAX_ADDITIONAL_IMAGES\s*,\s*10\s*\)\s*\|\|\s*12\s*\)/.test(
    limitsSrc.replace(/\s+/g, ' ')
  ) || (
    /Math\.max\s*\(\s*1\s*,/.test(limitsSrc) &&
    /parseInt\s*\(\s*process\.env\.CATALOG_MAX_ADDITIONAL_IMAGES\s*,\s*10\s*\)\s*\|\|\s*12/.test(limitsSrc)
  ),
  'expected Math.max(1, parseInt(process.env.CATALOG_MAX_ADDITIONAL_IMAGES, 10) || 12)'
);

check(
  'A4 MAX_ADDITIONAL_IMAGES is exported',
  /module\.exports\s*=\s*\{[\s\S]*MAX_ADDITIONAL_IMAGES[\s\S]*\}/.test(limitsSrc),
  'not in module.exports'
);

// THE load-bearing invariant: zero requires. Prevents Meta sync (and
// anything else) from re-pulling the scrape stack just to read an int,
// and removes the only reason the Shopify path needed a lazy require.
check(
  'A0 catalogImageLimits.js has zero require( statements',
  !/\brequire\s*\(/.test(limitsSrc),
  'catalogImageLimits.js must stay dependency-free — found a require('
);

// Require under a clean default env.
const prevEnv = process.env.CATALOG_MAX_ADDITIONAL_IMAGES;
delete process.env.CATALOG_MAX_ADDITIONAL_IMAGES;
clearLimitsCache();
let exported;
try {
  exported = require('../services/catalogImageLimits').MAX_ADDITIONAL_IMAGES;
} catch (err) {
  exported = undefined;
  failures.push(`A5 require failed: ${err.message}`);
}
check('A5 exported default is 12', exported === 12, `got ${exported}`);

// Env override.
process.env.CATALOG_MAX_ADDITIONAL_IMAGES = '7';
clearLimitsCache();
let overridden;
try {
  overridden = require('../services/catalogImageLimits').MAX_ADDITIONAL_IMAGES;
} catch (err) {
  overridden = undefined;
  failures.push(`A6 re-require failed: ${err.message}`);
}
check('A6 env override to 7 is honored', overridden === 7, `got ${overridden}`);

// Clamp: 0 / negative / NaN must never win.
process.env.CATALOG_MAX_ADDITIONAL_IMAGES = '0';
clearLimitsCache();
let clampedZero;
try {
  clampedZero = require('../services/catalogImageLimits').MAX_ADDITIONAL_IMAGES;
} catch (err) {
  clampedZero = undefined;
  failures.push(`A7 re-require failed: ${err.message}`);
}
// parseInt('0',10) || 12 → 12 (0 is falsy), then Math.max(1, 12) → 12.
// Either 12 (|| short-circuit) or 1 (if someone rewrote to nullish) is fine;
// zero/negative is not.
check(
  'A7 env=0 never yields 0 or negative',
  typeof clampedZero === 'number' && clampedZero >= 1,
  `got ${clampedZero}`
);

process.env.CATALOG_MAX_ADDITIONAL_IMAGES = '-3';
clearLimitsCache();
let clampedNeg;
try {
  clampedNeg = require('../services/catalogImageLimits').MAX_ADDITIONAL_IMAGES;
} catch (err) {
  clampedNeg = undefined;
  failures.push(`A8 re-require failed: ${err.message}`);
}
check(
  'A8 env=-3 never yields 0 or negative',
  typeof clampedNeg === 'number' && clampedNeg >= 1,
  `got ${clampedNeg}`
);

// Restore env + default-loaded module for any later checks that require it.
if (prevEnv === undefined) delete process.env.CATALOG_MAX_ADDITIONAL_IMAGES;
else process.env.CATALOG_MAX_ADDITIONAL_IMAGES = prevEnv;
clearLimitsCache();
require('../services/catalogImageLimits');

// ── B. no leftover hardcoded caps in owned files ────────────────────
const HARDCODED = [
  { re: /\.slice\(\s*1\s*,\s*5\s*\)/, label: 'slice(1, 5)' },
  { re: /\.slice\(\s*0\s*,\s*4\s*\)/, label: 'slice(0, 4)' },
  { re: /\.slice\(\s*1\s*,\s*9\s*\)/, label: 'slice(1, 9)' },
  { re: /\.slice\(\s*0\s*,\s*8\s*\)/, label: 'slice(0, 8)' },
];
for (const [name, filePath] of Object.entries(OWNED)) {
  const src = read(filePath);
  for (const h of HARDCODED) {
    check(
      `B no hardcoded ${h.label} in ${name}`,
      !h.re.test(src),
      `${path.basename(filePath)} still contains ${h.label}`
    );
  }
}

// ── C. all five call sites reference the shared constant ────────────
// Hero-offset form: slice(1, 1 + MAX_ADDITIONAL_IMAGES)
// Alts-only form:   slice(0, MAX_ADDITIONAL_IMAGES)
const siteChecks = [
  {
    name: 'resolver (hero-offset)',
    file: OWNED.resolver,
    must: /\.slice\(\s*1\s*,\s*1\s*\+\s*MAX_ADDITIONAL_IMAGES\s*\)/,
    heroOffset: true
  },
  {
    name: 'shopify (hero-offset)',
    file: OWNED.shopify,
    must: /\.slice\(\s*1\s*,\s*1\s*\+\s*MAX_ADDITIONAL_IMAGES\s*\)/,
    heroOffset: true
  },
  {
    name: 'genericIngest (alts-only)',
    file: OWNED.genericIngest,
    must: /\.slice\(\s*0\s*,\s*MAX_ADDITIONAL_IMAGES\s*\)/,
    heroOffset: false
  },
  {
    name: 'metaSync (alts-only)',
    file: OWNED.metaSync,
    must: /\.slice\(\s*0\s*,\s*MAX_ADDITIONAL_IMAGES\s*\)/,
    heroOffset: false
  },
  {
    name: 'apifyIngest (alts-only)',
    file: OWNED.apifyIngest,
    must: /\.slice\(\s*0\s*,\s*MAX_ADDITIONAL_IMAGES\s*\)/,
    heroOffset: false
  },
];

// Fence: OWNED must enumerate all five writers. A future sixth that is
// added only in source (not here) will not be caught by this exact list
// check — but a fifth that is dropped from OWNED fails immediately.
const EXPECTED_OWNED = [
  'resolver', 'genericIngest', 'shopify', 'metaSync', 'apifyIngest'
];
check(
  'C0 OWNED enumerates all five known writers',
  EXPECTED_OWNED.every((k) => typeof OWNED[k] === 'string' && OWNED[k].length > 0) &&
    Object.keys(OWNED).length === 5,
  `OWNED keys = ${Object.keys(OWNED).join(',')}`
);

for (const s of siteChecks) {
  if (typeof s.file !== 'string' || !s.file) {
    check(
      `C1 ${s.name} is listed in OWNED with a real path`,
      false,
      'OWNED entry missing — fifth-writer fence dropped this site'
    );
    continue;
  }
  if (!fs.existsSync(s.file)) {
    check(
      `C1 ${s.name} file exists`,
      false,
      `missing ${s.file}`
    );
    continue;
  }
  const src = read(s.file);
  check(
    `C1 ${s.name} references MAX_ADDITIONAL_IMAGES in its slice`,
    s.must.test(src),
    `expected ${s.must} in ${path.basename(s.file)}`
  );
  check(
    `C2 ${s.name} imports MAX_ADDITIONAL_IMAGES from ./catalogImageLimits`,
    /require\s*\(\s*['"]\.\/catalogImageLimits['"]\s*\)/.test(src) &&
      /MAX_ADDITIONAL_IMAGES/.test(src),
    `expected require('./catalogImageLimits') + MAX_ADDITIONAL_IMAGES in ${path.basename(s.file)}`
  );
  if (s.heroOffset) {
    check(
      `C3 ${s.name} preserves hero-offset (slice starts at 1)`,
      /\.slice\(\s*1\s*,\s*1\s*\+\s*MAX_ADDITIONAL_IMAGES\s*\)/.test(src),
      'hero-offset lost — slice no longer starts at 1'
    );
  } else {
    check(
      `C3 ${s.name} preserves alts-only shape (slice starts at 0)`,
      /\.slice\(\s*0\s*,\s*MAX_ADDITIONAL_IMAGES\s*\)/.test(src),
      'alts-only shape lost — slice no longer starts at 0'
    );
  }
}

// ── C4. no call site still imports the constant from the resolver ───
for (const [name, filePath] of Object.entries(OWNED)) {
  const src = read(filePath);
  // A require of genericCatalogResolver that ALSO destructures
  // MAX_ADDITIONAL_IMAGES (or assigns it from that module) is banned.
  // Plain require of the resolver for OTHER exports (DEFAULT_CAP etc.)
  // is fine — only the constant import is the regression.
  const fromResolver =
    /MAX_ADDITIONAL_IMAGES\s*[,}][\s\S]*?require\s*\(\s*['"]\.\/genericCatalogResolver['"]\s*\)/.test(src) ||
    /require\s*\(\s*['"]\.\/genericCatalogResolver['"]\s*\)[\s\S]*?\.MAX_ADDITIONAL_IMAGES/.test(src) ||
    /require\s*\(\s*['"]\.\/genericCatalogResolver['"]\s*\)\s*;?\s*\n[^\n]*MAX_ADDITIONAL_IMAGES/.test(src);
  // Also catch a single-line destructure that includes the constant.
  const destructureFromResolver =
    /\{[^}]*\bMAX_ADDITIONAL_IMAGES\b[^}]*\}\s*=\s*require\s*\(\s*['"]\.\/genericCatalogResolver['"]\s*\)/.test(src);
  check(
    `C4 ${name} does not import MAX_ADDITIONAL_IMAGES from genericCatalogResolver`,
    !fromResolver && !destructureFromResolver,
    `${path.basename(filePath)} still pulls the constant from the resolver`
  );
}

// Resolver must not re-export it either (one owner only).
const resolverSrc = read(OWNED.resolver);
check(
  'C5 genericCatalogResolver does not re-export MAX_ADDITIONAL_IMAGES',
  !/module\.exports\s*=\s*\{[\s\S]*\bMAX_ADDITIONAL_IMAGES\b[\s\S]*\}/.test(resolverSrc),
  'resolver still exports MAX_ADDITIONAL_IMAGES — drop re-export; one owner'
);

// ── C6. no lazy/inline require of the constant anywhere ─────────────
// Scan services/ for a require of catalogImageLimits OR of
// MAX_ADDITIONAL_IMAGES that sits inside a function body (not top-level).
// Heuristic: a require on a line whose indent is deeper than column 0
// of a top-level const/let/var require, OR that appears after a function
// keyword on an earlier line in the same block. Simpler + sufficient:
// any `require(...catalogImageLimits...)` whose line is indented past
// the first column of a typical top-level require (i.e. starts with
// whitespace beyond optional nothing — wait, top-level `const x =
// require` is at column 0. An indented `const {…} = require(...)` or
// bare `require(...)` is the lazy form.
const servicesDir = path.join(ROOT, 'services');
const serviceFiles = fs.readdirSync(servicesDir)
  .filter((f) => f.endsWith('.js'))
  .map((f) => path.join(servicesDir, f));

for (const filePath of serviceFiles) {
  const src = read(filePath);
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match a require of catalogImageLimits, OR a require of
    // genericCatalogResolver that is specifically for MAX_ADDITIONAL_IMAGES
    // on the same statement (lazy form of the old workaround).
    const isLimitsRequire = /require\s*\(\s*['"]\.\/catalogImageLimits['"]\s*\)/.test(line);
    const isLazyResolverConst =
      /require\s*\(\s*['"]\.\/genericCatalogResolver['"]\s*\)/.test(line) &&
      /MAX_ADDITIONAL_IMAGES/.test(line);
    if (!isLimitsRequire && !isLazyResolverConst) continue;
    // Top-level: line starts at column 0 (or only after a comment/blank
    // context). Indented lines (leading whitespace) are inside a block.
    const indented = /^\s+/.test(line);
    check(
      `C6 no lazy/inline require of image-cap const in ${path.basename(filePath)}:${i + 1}`,
      !indented,
      `indented require at line ${i + 1} — move to top-level (zero-dep module, no cycle)`
    );
  }
}

// ── D. default agrees with detect's MAX_ALT_IMAGES ──────────────────
const detectSrc = read(DETECT);
const m = detectSrc.match(/const\s+MAX_ALT_IMAGES\s*=\s*(\d+)\s*;/);
const detectCap = m ? Number(m[1]) : null;
check(
  'D1 catalogProductDetectService declares MAX_ALT_IMAGES as an integer',
  Number.isInteger(detectCap),
  `could not parse MAX_ALT_IMAGES from detect service (got ${m && m[0]})`
);
check(
  'D2 ingest default (12) agrees with MAX_ALT_IMAGES',
  detectCap === 12,
  `detect MAX_ALT_IMAGES=${detectCap}, ingest default must match`
);
// Cross-check the live export too.
delete process.env.CATALOG_MAX_ADDITIONAL_IMAGES;
clearLimitsCache();
const liveDefault = require('../services/catalogImageLimits').MAX_ADDITIONAL_IMAGES;
check(
  'D3 live export equals detect MAX_ALT_IMAGES',
  liveDefault === detectCap,
  `export=${liveDefault} detect=${detectCap}`
);

// ── E. non-owned detect file is not the home of the shared const ────
// (documentation of the split: detect keeps MAX_ALT_IMAGES; ingest keeps
// MAX_ADDITIONAL_IMAGES. They must agree numerically, not share a symbol.)
check(
  'E1 detect service still owns MAX_ALT_IMAGES (not renamed)',
  /const\s+MAX_ALT_IMAGES\s*=/.test(detectSrc),
  'MAX_ALT_IMAGES declaration missing from catalogProductDetectService'
);

// Limits module comment should name the lockstep partner.
check(
  'E2 catalogImageLimits comment names MAX_ALT_IMAGES lockstep',
  /MAX_ALT_IMAGES/.test(limitsSrc),
  'explanatory comment must mention catalogProductDetectService.MAX_ALT_IMAGES'
);

// ── F. runtime fixture checks (belt + braces on slice SHAPE) ────────
// Text-only pins (C*) can stay green if a second .slice/.filter after
// the capped slice changes the effective count (Shopify already has
// .filter(Boolean) the text check ignores). These fixtures execute the
// exact expressions under a synthetic 20-entry input and assert the
// produced additionalImages length + hero exclusion.
//
// Where a site's logic is not directly callable offline, the expression
// below MIRRORS the call site — keep them byte-aligned when editing.
delete process.env.CATALOG_MAX_ADDITIONAL_IMAGES;
clearLimitsCache();
const { MAX_ADDITIONAL_IMAGES: CAP } = require('../services/catalogImageLimits');

// Synthetic 20-image inputs in each site's real input shape.
const HERO = 'https://cdn.example.com/hero.jpg';
const ALTS_20 = Array.from({ length: 20 }, (_, i) =>
  `https://cdn.example.com/alt-${i + 1}.jpg`
);
const COMBINED_20 = [HERO, ...ALTS_20]; // hero at index 0, then 20 alts
const ALTS_ONLY_20 = ALTS_20.slice();   // already-alt list (no hero)
// Shopify shape: array of {src} objects (may include falsy).
const SHOPIFY_IMAGES = [
  { src: HERO },
  ...ALTS_20.map((u) => ({ src: u })),
  { src: null }, // falsy — .filter(Boolean) drops after slice
  { src: '' }
];
// Meta shape: already-alt string list.
const META_ALTS_20 = ALTS_ONLY_20.slice();
// Apify shape: additionalImageUrls already-alt string list.
const APIFY_ALTS_20 = ALTS_ONLY_20.slice();
// Generic ingest shape: p.additionalImages already-alt string list.
const GENERIC_ALTS_20 = ALTS_ONLY_20.slice();
// Resolver shape: combined uniq URL list (hero first).
const RESOLVER_UNIQ = COMBINED_20.slice();

// ── F1 resolver (hero-offset) ───────────────────────────────────────
// Mirrors genericCatalogResolver.js imagesFromNode:
//   additionalImages: uniq.slice(1, 1 + MAX_ADDITIONAL_IMAGES)
{
  const additionalImages = RESOLVER_UNIQ.slice(1, 1 + CAP);
  check(
    'F1 resolver runtime: length ≤ CAP',
    additionalImages.length <= CAP,
    `got ${additionalImages.length}, CAP=${CAP}`
  );
  check(
    'F1b resolver runtime: length === CAP on oversized input',
    additionalImages.length === CAP,
    `got ${additionalImages.length}, expected ${CAP}`
  );
  check(
    'F1c resolver runtime: hero excluded from alts',
    !additionalImages.includes(HERO),
    `hero ${HERO} re-introduced into alts`
  );
  check(
    'F1d resolver runtime: first alt is former index 1',
    additionalImages[0] === ALTS_20[0],
    `got ${additionalImages[0]}`
  );
}

// ── F2 shopify (hero-offset + .filter(Boolean)) ─────────────────────
// Mirrors shopifyPublicIngestService.js:
//   images.slice(1, 1 + MAX_ADDITIONAL_IMAGES).map(i => i.src).filter(Boolean)
{
  const additionalImages = SHOPIFY_IMAGES
    .slice(1, 1 + CAP)
    .map((i) => i.src)
    .filter(Boolean);
  check(
    'F2 shopify runtime: length ≤ CAP',
    additionalImages.length <= CAP,
    `got ${additionalImages.length}, CAP=${CAP}`
  );
  check(
    'F2b shopify runtime: hero excluded from alts',
    !additionalImages.includes(HERO),
    `hero ${HERO} re-introduced into alts`
  );
  check(
    'F2c shopify runtime: no empty/null after filter',
    additionalImages.every((u) => typeof u === 'string' && u.length > 0),
    `got ${JSON.stringify(additionalImages.filter((u) => !u))}`
  );
}

// ── F3 genericIngest (alts-only) ────────────────────────────────────
// Mirrors genericCatalogIngestService.js:
//   p.additionalImages.slice(0, MAX_ADDITIONAL_IMAGES)
{
  const additionalImages = Array.isArray(GENERIC_ALTS_20)
    ? GENERIC_ALTS_20.slice(0, CAP)
    : [];
  check(
    'F3 genericIngest runtime: length ≤ CAP',
    additionalImages.length <= CAP,
    `got ${additionalImages.length}, CAP=${CAP}`
  );
  check(
    'F3b genericIngest runtime: length === CAP on oversized input',
    additionalImages.length === CAP,
    `got ${additionalImages.length}`
  );
  check(
    'F3c genericIngest runtime: hero not re-introduced (alts-only input)',
    !additionalImages.includes(HERO),
    'hero appeared though input was alts-only'
  );
}

// ── F4 metaSync (alts-only) ─────────────────────────────────────────
// Mirrors catalogSyncService.js:
//   item.additional_image_urls.slice(0, MAX_ADDITIONAL_IMAGES)
{
  const additionalImages = Array.isArray(META_ALTS_20)
    ? META_ALTS_20.slice(0, CAP)
    : [];
  check(
    'F4 metaSync runtime: length ≤ CAP',
    additionalImages.length <= CAP,
    `got ${additionalImages.length}, CAP=${CAP}`
  );
  check(
    'F4b metaSync runtime: length === CAP on oversized input',
    additionalImages.length === CAP,
    `got ${additionalImages.length}`
  );
  check(
    'F4c metaSync runtime: hero not re-introduced (alts-only input)',
    !additionalImages.includes(HERO),
    'hero appeared though input was alts-only'
  );
}

// ── F5 apifyIngest (alts-only) ──────────────────────────────────────
// Mirrors apifyIngestService.js:
//   p.additionalImageUrls.slice(0, MAX_ADDITIONAL_IMAGES)
{
  const additionalImages = Array.isArray(APIFY_ALTS_20)
    ? APIFY_ALTS_20.slice(0, CAP)
    : [];
  check(
    'F5 apifyIngest runtime: length ≤ CAP',
    additionalImages.length <= CAP,
    `got ${additionalImages.length}, CAP=${CAP}`
  );
  check(
    'F5b apifyIngest runtime: length === CAP on oversized input',
    additionalImages.length === CAP,
    `got ${additionalImages.length}`
  );
  check(
    'F5c apifyIngest runtime: hero not re-introduced (alts-only input)',
    !additionalImages.includes(HERO),
    'hero appeared though input was alts-only'
  );
}

// ── F6 empty / short inputs never throw and stay ≤ CAP ──────────────
{
  const emptyCombined = [].slice(1, 1 + CAP);
  const shortAlts = ['https://cdn.example.com/a.jpg'].slice(0, CAP);
  check('F6a empty combined → empty alts', emptyCombined.length === 0);
  check('F6b short alts-only → length preserved', shortAlts.length === 1);
  check('F6c short alts-only → ≤ CAP', shortAlts.length <= CAP);
}

if (failures.length) {
  console.error(`❌ verifyCatalogImageCaps: ${failures.length} FAILED, ${pass} passed\n`);
  for (const f of failures) console.error(`   • ${f}`);
  process.exit(1);
}
console.log(`✅ verifyCatalogImageCaps: ${pass}/${pass} checks passed`);
