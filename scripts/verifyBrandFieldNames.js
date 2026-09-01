#!/usr/bin/env node
/**
 * Offline harness: Brand field-name fidelity.
 * No DB, no network, no API key.
 *
 * THE DEFECT CLASS THIS EXISTS TO CATCH (2026-08-04):
 *
 *   Reads/projections of Brand fields that DO NOT EXIST on brandSchema.
 *   models/Brand.js defines TWO schemas:
 *     - demographicSchema (line ~22) HAS `description` (and no logo)
 *     - brandSchema (line ~31) is the actual Brand — prose field is `summary`,
 *       logo field is `logoUrl`. There is no `description` and no `logo`.
 *   Reading a missing field is silent, and so is `.select()`ing a missing
 *   path, so these bugs are permanently-null with zero errors.
 *
 * THREE FIXED INSTANCES (already applied — this harness pins them):
 *
 *   1. services/aiCreativeDirectorService.js — brand?.description → brand?.summary;
 *      !!brand?.logo → !!brand?.logoUrl
 *   2. services/aiCanvasInputBuilder.js — Brand .select() + brandDoc?.summary
 *   3. services/brandEnrichmentService.js — wantGpt gated on
 *      (atlasLlmConfigured() || OPENAI_API_KEY), not OPENAI alone
 *
 * WHAT IS AND IS NOT COVERED — read this before trusting a green run.
 *
 *   Group B deliberately scopes to the variable name `brandDoc` only.
 *   A bare `brand` is ambiguous: in some files it is a Mongoose Brand doc,
 *   in others it is a layoutInput projection (`layoutInput.brand`) that
 *   LEGITIMATELY has a `logo` key (layoutInputService sets logo: brand?.logoUrl).
 *   A check that cannot tell those apart would either false-positive on
 *   correct code or have to allowlist half the repo. The narrowness is a
 *   decision, not an oversight. Group C pins the known-fixed `brand?.*`
 *   sites in aiCreativeDirectorService by filename; Group D asserts the
 *   layoutInput contract still uses `logo` so a future "fix" of those
 *   false positives fails loudly.
 *
 *   Negative lookahead on `logo` / `logoUrl` is LOAD-BEARING: the correct
 *   read `brandDoc?.logoUrl` contains the literal `brandDoc?.logo`, so
 *   without `(?![A-Za-z0-9_])` the check would pass on correct code and
 *   could never fail.
 *
 * Run: node scripts/verifyBrandFieldNames.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

// ── helpers ──────────────────────────────────────────────────────────────

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function listJsFiles(dirRel) {
  const abs = path.join(ROOT, dirRel);
  const out = [];
  function walk(d) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      // Skip node_modules AND any dotfile/dotdir — same convention as
      // verifyMetaApiVersion.js's fix: a "revertprove" harness elsewhere in
      // this suite briefly writes a transient sibling file named
      // `.__revertprove_*.js` into services/ or routes/ while mutation-
      // testing; under the parallel runner this walk can otherwise catch
      // that file mid-write and ENOENT when it reads a name that's since
      // been deleted.
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && ent.name.endsWith('.js')) out.push(p);
    }
  }
  walk(abs);
  return out;
}

/** Line number (1-based) of a character offset. */
function lineOf(src, idx) {
  let n = 1;
  for (let i = 0; i < idx && i < src.length; i++) {
    if (src[i] === '\n') n++;
  }
  return n;
}

/**
 * Parse TOP-LEVEL keys of brandSchema from models/Brand.js.
 * Do NOT hardcode the field list — the harness must track schema drift.
 * Ignores demographicSchema entirely (starts only at brandSchema).
 */
// `marker` is parameterised so the SAME parser covers any model — Group E
// reuses it for catalogProductSchema. The trap being pinned (a `.select()` of
// a path the schema does not declare, which mongoose resolves to `undefined`
// in silence) is model-agnostic, so the check should be too.
function parseBrandSchemaFields(brandFileSrc, marker = 'const brandSchema = new mongoose.Schema({') {
  const start = brandFileSrc.indexOf(marker);
  if (start < 0) throw new Error(`schema declaration not found for marker: ${marker}`);
  const openBrace = start + marker.length - 1;
  if (brandFileSrc[openBrace] !== '{') {
    throw new Error('expected `{` at end of brandSchema Schema( marker');
  }

  const keys = [];
  let depth = 0;
  let bracketDepth = 0;
  let i = openBrace;
  let inLineComment = false;
  let inBlockComment = false;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let escape = false;
  let expectKey = true;

  while (i < brandFileSrc.length) {
    const ch = brandFileSrc[i];
    const next = brandFileSrc[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      i++;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') { inBlockComment = false; i += 2; continue; }
      i++;
      continue;
    }
    if (inSingle) {
      if (escape) { escape = false; i++; continue; }
      if (ch === '\\') { escape = true; i++; continue; }
      if (ch === "'") inSingle = false;
      i++;
      continue;
    }
    if (inDouble) {
      if (escape) { escape = false; i++; continue; }
      if (ch === '\\') { escape = true; i++; continue; }
      if (ch === '"') inDouble = false;
      i++;
      continue;
    }
    if (inTemplate) {
      if (escape) { escape = false; i++; continue; }
      if (ch === '\\') { escape = true; i++; continue; }
      if (ch === '`') inTemplate = false;
      i++;
      continue;
    }

    if (ch === '/' && next === '/') { inLineComment = true; i += 2; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; i += 2; continue; }
    if (ch === "'") { inSingle = true; i++; continue; }
    if (ch === '"') { inDouble = true; i++; continue; }
    if (ch === '`') { inTemplate = true; i++; continue; }

    if (ch === '{') {
      depth++;
      if (depth === 1) expectKey = true;
      else expectKey = false;
      i++;
      continue;
    }
    if (ch === '}') {
      depth--;
      if (depth === 0) break;
      expectKey = false;
      i++;
      continue;
    }
    if (ch === '[') { bracketDepth++; i++; continue; }
    if (ch === ']') { bracketDepth = Math.max(0, bracketDepth - 1); i++; continue; }

    if (ch === ',' && depth === 1 && bracketDepth === 0) {
      expectKey = true;
      i++;
      continue;
    }

    if (expectKey && depth === 1 && bracketDepth === 0) {
      if (/\s/.test(ch)) { i++; continue; }
      if (/[A-Za-z_$]/.test(ch)) {
        let j = i + 1;
        while (j < brandFileSrc.length && /[A-Za-z0-9_$]/.test(brandFileSrc[j])) j++;
        let k = j;
        while (k < brandFileSrc.length && /\s/.test(brandFileSrc[k])) k++;
        if (brandFileSrc[k] === ':') {
          keys.push(brandFileSrc.slice(i, j));
          expectKey = false;
          i = k + 1;
          continue;
        }
      }
      expectKey = false;
    }

    i++;
  }

  return keys;
}

/**
 * Drop line/block comments. Leaves strings intact enough for our substring
 * checks; crude but adequate for Group B (code reads, not comment prose that
 * documents the old bug name, e.g. "brandDoc.description -> brandDoc.summary").
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  let inLine = false;
  let inBlock = false;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let escape = false;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (inLine) {
      if (ch === '\n') { inLine = false; out += ch; }
      i++;
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') { inBlock = false; i += 2; continue; }
      if (ch === '\n') out += ch;
      i++;
      continue;
    }
    if (inSingle) {
      out += ch;
      if (escape) { escape = false; i++; continue; }
      if (ch === '\\') { escape = true; i++; continue; }
      if (ch === "'") inSingle = false;
      i++;
      continue;
    }
    if (inDouble) {
      out += ch;
      if (escape) { escape = false; i++; continue; }
      if (ch === '\\') { escape = true; i++; continue; }
      if (ch === '"') inDouble = false;
      i++;
      continue;
    }
    if (inTemplate) {
      out += ch;
      if (escape) { escape = false; i++; continue; }
      if (ch === '\\') { escape = true; i++; continue; }
      if (ch === '`') inTemplate = false;
      i++;
      continue;
    }
    if (ch === '/' && next === '/') { inLine = true; i += 2; continue; }
    if (ch === '/' && next === '*') { inBlock = true; i += 2; continue; }
    if (ch === "'") { inSingle = true; out += ch; i++; continue; }
    if (ch === '"') { inDouble = true; out += ch; i++; continue; }
    if (ch === '`') { inTemplate = true; out += ch; i++; continue; }
    out += ch;
    i++;
  }
  return out;
}

/** Matching close paren for an open paren at `openIdx`. */
function matchParen(src, openIdx) {
  let depth = 0;
  let inLine = false;
  let inBlock = false;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let escape = false;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (inLine) { if (ch === '\n') inLine = false; continue; }
    if (inBlock) { if (ch === '*' && next === '/') { inBlock = false; i++; } continue; }
    if (inSingle) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (inTemplate) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '`') inTemplate = false;
      continue;
    }
    if (ch === '/' && next === '/') { inLine = true; i++; continue; }
    if (ch === '/' && next === '*') { inBlock = true; i++; continue; }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === '`') { inTemplate = true; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Find Brand/BrandModel .find*().select('…') projections in a source file.
 * Returns [{ line, paths: string[], selectArg }].
 */
// `modelAlt` is the alternation of model identifiers to scan for, parameterised
// so Group E can reuse the whole finder for CatalogProduct.
function findBrandSelects(src, modelAlt = 'Brand|BrandModel') {
  const results = [];
  const callRe = new RegExp(`\\b((?:${modelAlt})\\.(?:findById|findOne|find))\\s*\\(`, 'g');
  let m;
  while ((m = callRe.exec(src)) !== null) {
    const openParen = m.index + m[0].length - 1;
    const closeParen = matchParen(src, openParen);
    if (closeParen < 0) continue;
    // Look ahead for .select('...') / .select("...") within a short window,
    // allowing whitespace/newlines between the find call and .select.
    const after = src.slice(closeParen + 1, closeParen + 1 + 400);
    const selectMatch = after.match(/^\s*\.select\s*\(\s*(['"])([\s\S]*?)\1\s*\)/);
    if (!selectMatch) continue;
    const selectArg = selectMatch[2];
    const paths = selectArg
      .split(/\s+/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        // mongoose inclusion/exclusion prefix
        let s = p.replace(/^[+-]/, '');
        // nested path → top segment
        return s.split('.')[0];
      })
      .filter((p) => p && p !== '_id');
    results.push({
      line: lineOf(src, m.index),
      paths,
      selectArg
    });
  }
  return results;
}

// ── A. Parse brandSchema field set ───────────────────────────────────────

const brandSrc = read('models/Brand.js');
const schemaKeys = parseBrandSchemaFields(brandSrc);
// mongoose virtuals / built-ins that may appear in .select() strings
const ALLOWED_BUILTINS = new Set(['id', '__v', '_id']);
const schemaFieldSet = new Set([...schemaKeys, ...ALLOWED_BUILTINS]);

check(
  'A0 brandSchema parse found a plausible field set',
  schemaKeys.length >= 20
    && schemaKeys.includes('name')
    && schemaKeys.includes('summary')
    && schemaKeys.includes('logoUrl')
    && schemaKeys.includes('tagline'),
  `got ${schemaKeys.length} keys: ${schemaKeys.slice(0, 12).join(', ')}…`
);
// Sanity: demographic-only field must NOT appear as a top-level brandSchema key
check(
  'A0b brandSchema top-level does not include demographic-only `description`',
  !schemaKeys.includes('description'),
  'parser likely captured demographicSchema or nested keys'
);

// ── A. Brand .select() paths must be real fields ─────────────────────────

const scanRoots = ['services', 'routes'];
const scanFiles = scanRoots.flatMap((d) => listJsFiles(d));

const selectOffenders = [];
for (const abs of scanFiles) {
  const rel = path.relative(ROOT, abs);
  const src = fs.readFileSync(abs, 'utf8');
  const selects = findBrandSelects(src);
  for (const sel of selects) {
    for (const p of sel.paths) {
      if (!schemaFieldSet.has(p)) {
        selectOffenders.push({ rel, line: sel.line, path: p, selectArg: sel.selectArg });
      }
    }
  }
}

if (selectOffenders.length === 0) {
  check('A1 all Brand/BrandModel .select() paths are real brandSchema fields', true);
} else {
  for (const o of selectOffenders) {
    check(
      `A1 ${o.rel}:${o.line} .select path "${o.path}" is not on brandSchema`,
      false,
      `select('${o.selectArg}') — "${o.path}" is not a top-level brandSchema field`
    );
  }
}

// ── B. No known-bad reads off brandDoc ───────────────────────────────────
// Negative lookahead is LOAD-BEARING: `brandDoc?.logoUrl` contains the
// literal `brandDoc?.logo`, so without it this check passes on correct
// code and can never fail.
//
// Scope is deliberately `brandDoc` only — bare `brand` is ambiguous
// (layoutInput projection vs Mongoose doc). See header.
//
// Scan comment-stripped source so prose documenting the old bug name
// (e.g. "brandDoc.description -> brandDoc.summary") is not a false positive.

const badDescRe = /\bbrandDoc\s*\??\.\s*description(?![A-Za-z0-9_])/;
const badLogoRe = /\bbrandDoc\s*\??\.\s*logo(?![A-Za-z0-9_])/;

const brandDocOffenders = [];
for (const abs of scanFiles) {
  const rel = path.relative(ROOT, abs);
  const src = fs.readFileSync(abs, 'utf8');
  const code = stripComments(src);
  if (badDescRe.test(code)) {
    const idx = src.search(badDescRe);
    brandDocOffenders.push({
      rel,
      line: idx >= 0 ? lineOf(src, idx) : '?',
      kind: 'description'
    });
  }
  if (badLogoRe.test(code)) {
    const idx = src.search(badLogoRe);
    brandDocOffenders.push({
      rel,
      line: idx >= 0 ? lineOf(src, idx) : '?',
      kind: 'logo'
    });
  }
}

if (brandDocOffenders.length === 0) {
  check('B1 no brandDoc?.description / brandDoc?.logo reads in services/ + routes/', true);
} else {
  for (const o of brandDocOffenders) {
    check(
      `B1 ${o.rel}:${o.line} reads brandDoc.${o.kind}`,
      false,
      o.kind === 'description'
        ? 'brandSchema field is summary, not description'
        : 'brandSchema field is logoUrl, not logo'
    );
  }
}

// ── C. Pin the three fixed sites (source-level) ──────────────────────────

const directorSrc = read('services/aiCreativeDirectorService.js');
const canvasInSrc = read('services/aiCanvasInputBuilder.js');
const enrichSrc = read('services/brandEnrichmentService.js');

check(
  'C1 aiCreativeDirectorService sources brand?.summary into brand_signal',
  /snippetText\(brand\?\.summary,/.test(directorSrc),
  'expected snippetText(brand?.summary,'
);
check(
  'C2 aiCreativeDirectorService has_logo sources brand?.logoUrl',
  /!!brand\?\.logoUrl/.test(directorSrc),
  'expected !!brand?.logoUrl'
);
// Negative lookahead load-bearing — see header.
check(
  'C3 aiCreativeDirectorService does not read brand?.description',
  !/brand\?\.description(?![A-Za-z0-9_])/.test(directorSrc),
  'brand?.description is permanently null on brandSchema'
);
check(
  'C4 aiCreativeDirectorService does not read brand?.logo (except logoUrl)',
  !/brand\?\.logo(?![A-Za-z0-9_])/.test(directorSrc),
  'brand?.logo never existed — use logoUrl'
);

check(
  'C5 aiCanvasInputBuilder sources brandDoc?.summary',
  /snippetText\(brandDoc\?\.summary,/.test(canvasInSrc),
  'expected snippetText(brandDoc?.summary,'
);
const canvasSelects = findBrandSelects(canvasInSrc);
const canvasBrandSelect = canvasSelects.find((s) =>
  /\bsummary\b/.test(s.selectArg) || /\btagline\b/.test(s.selectArg)
);
check(
  'C6 aiCanvasInputBuilder Brand .select() includes summary',
  !!(canvasBrandSelect && /\bsummary\b/.test(canvasBrandSelect.selectArg)),
  canvasBrandSelect
    ? `select('${canvasBrandSelect.selectArg}')`
    : 'no Brand/BrandModel .select() found'
);
check(
  'C7 aiCanvasInputBuilder Brand .select() does not include description',
  !!(canvasBrandSelect && !/\bdescription\b/.test(canvasBrandSelect.selectArg)),
  canvasBrandSelect
    ? `select('${canvasBrandSelect.selectArg}') still projects description`
    : 'no Brand/BrandModel .select() found'
);

check(
  'C8 brandEnrichmentService imports isConfigured from atlasLlmService',
  /isConfigured\s*:\s*atlasLlmConfigured/.test(enrichSrc)
    && /require\(['"]\.\/atlasLlmService['"]\)/.test(enrichSrc),
  'expected `isConfigured: atlasLlmConfigured` from ./atlasLlmService'
);
check(
  'C9 brandEnrichmentService wantGpt references atlasLlmConfigured (or isConfigured)',
  /wantGpt[\s\S]{0,200}atlasLlmConfigured/.test(enrichSrc)
    || /wantGpt[\s\S]{0,200}isConfigured/.test(enrichSrc),
  'wantGpt must consult atlasLlmConfigured — Atlas is primary, OpenAI is fallback'
);
check(
  'C10 brandEnrichmentService does not gate wantGpt on OPENAI_API_KEY alone',
  !/wantGpt\s*=\s*!!process\.env\.OPENAI_API_KEY\s*&&/.test(enrichSrc),
  'wantGpt = !!process.env.OPENAI_API_KEY && … drops Atlas-only deployments'
);

// ── D. Counter-checks — layoutInput contract must keep `logo` ────────────
// These prove the harness is not over-broad. If a future "fix" renames
// layoutInput.brand.logo → logoUrl, THIS group fails and tells the author
// they broke the layoutInput contract — not Group B (which never saw it).

check(
  'D1 aiCanvasInputBuilder still projects const brand = layoutInput.brand',
  /const\s+brand\s*=\s*layoutInput\.brand/.test(canvasInSrc),
  'layoutInput.brand is a different object from a Mongoose Brand doc'
);
const layoutSrc = read('services/layoutInputService.js');
check(
  'D2 layoutInputService still sets logo: from brand?.logoUrl',
  /logo\s*:\s*brand\?\.logoUrl/.test(layoutSrc),
  'layoutInput.brand.logo is the projected key; source is brand.logoUrl'
);
const specSrc = read('services/aiCanvasSpecService.js');
check(
  'D3 aiCanvasSpecService ALLOWED_SLOTS still contains brand.logo',
  /ALLOWED_SLOTS\s*=\s*\[[\s\S]*?'brand\.logo'/.test(specSrc),
  "'brand.logo' is a slot-binding contract path against resolved layoutInput, not a Brand doc read"
);

// ── E. SAME TRAP, CatalogProduct ─────────────────────────────────────────
// Group A pinned this for Brand and the identical bug then shipped on
// CatalogProduct: brandScriptExecutor selected `reviewCount`, which
// catalogProductSchema does not declare, so `catalogProduct.reviewCount` was
// permanently `undefined` and every product-tier video ad rendered stars with
// no review count. The generalised parser + finder above mean this group is the
// same logic pointed at a second model, not a second copy of it.

const catalogSrc = read('models/CatalogProduct.js');
const catalogKeys = parseBrandSchemaFields(catalogSrc, 'const catalogProductSchema = new mongoose.Schema({');
const catalogFieldSet = new Set([...catalogKeys, ...ALLOWED_BUILTINS]);

check(
  'E0 catalogProductSchema parse found a plausible field set',
  catalogKeys.length >= 20
    && catalogKeys.includes('title')
    && catalogKeys.includes('rating')
    && catalogKeys.includes('productReviews'),
  `got ${catalogKeys.length} keys: ${catalogKeys.slice(0, 12).join(', ')}…`
);

// The specific absence that caused the bug. If someone later ADDS a real
// top-level `reviewCount` to the schema, this check fails loudly and tells them
// to revisit the productReviews-first precedence in buildMetaForAd rather than
// silently ending up with two competing sources for one number.
check(
  'E1 catalogProductSchema still has NO top-level reviewCount',
  !catalogKeys.includes('reviewCount'),
  'reviewCount lives ONLY inside productReviews; if you add a top-level one, revisit brandScriptExecutor productSnapshot precedence'
);

// PRE-EXISTING undeclared selects, found by this group the first time it ran.
// They are ALLOWLISTED, not fixed, and deliberately so: these queries use
// `.lean()`, and a lean projection of an undeclared path still returns whatever
// the raw MongoDB document holds. So a legacy row written before the current
// schema COULD legitimately carry one of these, and deleting the read without
// querying production would be a silent data loss rather than a cleanup. Each
// needs its own verified follow-up. Anything NOT on this list still fails, which
// is the point — the list is closed, and adding to it should feel expensive.
const CATALOG_SELECT_ALLOWLIST = new Map([
  ['canonicalUrl', 'catalogProductReviewRefreshService: dead second arm of `productUrl || canonicalUrl`; productUrl (:118) is real and covers it'],
  ['createdAt',    'routes/catalog.js: schema sets no `timestamps`, so this is only present on rows some other writer stamped'],
  ['productImages', 'catalogProductLifestyleImageService: no writer anywhere in the repo — almost certainly fully dead'],
  ['lifestyle_image', 'catalogProductLifestyleImageService: written on layoutInput/spec objects, not on CatalogProduct'],
  ['size',         'routes/catalog.js: not declared; likely a legacy variant field'],
]);

const catalogSelectOffenders = [];
for (const abs of scanFiles) {
  const rel = path.relative(ROOT, abs);
  const src = fs.readFileSync(abs, 'utf8');
  for (const sel of findBrandSelects(src, 'CatalogProduct|CatalogModel')) {
    for (const p of sel.paths) {
      if (!catalogFieldSet.has(p) && !CATALOG_SELECT_ALLOWLIST.has(p)) {
        catalogSelectOffenders.push(`${rel}:${sel.line} selects '${p}' — not a catalogProductSchema field`);
      }
    }
  }
}

// The allowlist must not rot into a place where a real bug hides: every entry
// has to still be undeclared. Once a field becomes real, its entry is removed.
const staleAllowlist = [...CATALOG_SELECT_ALLOWLIST.keys()].filter((k) => catalogFieldSet.has(k));
check(
  'E2a the CatalogProduct select allowlist contains no now-real fields',
  staleAllowlist.length === 0,
  `these are declared on the schema now — drop them from the allowlist: ${staleAllowlist.join(', ')}`
);
check(
  'E2 every CatalogProduct .select() path is a real catalogProductSchema field',
  catalogSelectOffenders.length === 0,
  catalogSelectOffenders.join('\n     ')
);

// Pin the fixed site directly: the video path must read the atomic pair out of
// productReviews, and must NOT go back to selecting the phantom field.
const execSrc = read('services/brandScriptExecutor.js');
check(
  'E3 brandScriptExecutor selects productReviews on CatalogProduct',
  /\.select\('[^']*\bproductReviews\b[^']*'\)/.test(execSrc),
  'the atomic rating+count pair comes from productReviews'
);
check(
  'E4 brandScriptExecutor no longer selects the phantom top-level reviewCount',
  !/\.select\('[^']*\breviewCount\b[^']*'\)/.test(execSrc),
  'reviewCount is not a catalogProductSchema path — selecting it is a silent undefined'
);
check(
  'E5 productSnapshot prefers productReviews over the top-level rating mirror',
  /prHasRating/.test(execSrc)
    && execSrc.indexOf('if (prHasRating)') < execSrc.indexOf('} else if (catalogHasRatingOrCount)'),
  'productReviews is fresher and is the only container carrying a count'
);
// The rename is not cosmetic — gating on a RATING rather than on "any number" is
// what stops a count-only productReviews from erasing a good top-level rating.
check(
  'E6 productReviews must carry a usable RATING to win, not merely a count',
  /const prHasRating = !!pr && typeof pr\.rating === 'number';/.test(execSrc)
    && !/typeof pr\.reviewCount === 'number'\s*\)?\s*;?\s*$/m.test(
      (execSrc.match(/const prHasRating[^\n]*\n/) || [''])[0]
    ),
  'winning on count alone sets rating:null and erases the top-level rating — a proof regression'
);

// ── summary ──────────────────────────────────────────────────────────────

if (failures.length) {
  console.error(`\n❌ verifyBrandFieldNames: ${failures.length} FAILED, ${pass} passed\n`);
  failures.forEach((f) => console.error(`   • ${f}`));
  process.exit(1);
}
console.log(`✅ verifyBrandFieldNames: ${pass} checks passed`);
console.log(`   brandSchema fields parsed: ${schemaKeys.length}; Brand .select() sites scanned across services/ + routes/`);
console.log('   Group B scoped to brandDoc only (bare brand is ambiguous — see header)');
