#!/usr/bin/env node
'use strict';
/**
 * verifyFontIngestEveryImportPath — every Brand create/import path must
 * reach the font choke point (website files + Meta-ads names + Shopify
 * theme when applicable).
 *
 * WHY
 * Owner: "make sure that font is ingested regardless of import method,
 * make sure every method is getting fonts from social media ads and
 * from their website." Catalog/brand ingest is backend-owned. Before
 * this pin, several create/import paths never called enrichBrandFromUrl,
 * and enrichBrandFromUrl itself returned on missing websiteUrl BEFORE
 * the Meta-ads / Shopify-theme font tiers — so a social-first brand
 * never got ad-creative fonts, and a catalog re-sync of a brand that
 * already had websiteUrl never retried a skipped font scan.
 *
 * WHAT THIS PINS
 *   A. Structural scan of real production files (not a hardcoded list):
 *      Brand.create / new Brand / Brand.findOneAndUpdate upsert, plus
 *      ingest implementations (syncBrand*, syncCatalog, syncPosts,
 *      processWebhookPayload). Each must call queueBrandEnrichment,
 *      enrichBrandFromUrl, or ensureBrandFontsIngested.
 *   B. enrichBrandFromUrl no longer bails past fonts on missing
 *      websiteUrl — it records enrichmentSkipReason AND still calls
 *      ensureBrandFontsIngested when Meta-ads / Shopify can run.
 *   C. Behavioural: ensureBrandFontsIngested invokes the Meta-ads tier
 *      once; #362 billableAttempted false does NOT stamp
 *      metaFontsIngestedAt (retryable); true does; a stamped brand is
 *      not scanned again. No websiteUrl → website ingest skipped,
 *      Meta-ads still runs.
 *   D. Revert-prove: dropping one path's wiring fails group A; dropping
 *      the no-websiteUrl → ensureBrandFontsIngested call fails group B.
 *
 * Offline: no DB, no network. Font-tier services are injected via deps.
 *
 *   node scripts/verifyFontIngestEveryImportPath.js
 */

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENRICH_PATH = path.join(ROOT, 'services', 'brandEnrichmentService.js');
const ENRICH_SRC = fs.readFileSync(ENRICH_PATH, 'utf8');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`✗ ${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

const asyncChecks = [];
function checkAsync(name, fn) {
  asyncChecks.push(async () => {
    try {
      await fn();
      passed += 1;
      console.log(`✓ ${name}`);
    } catch (err) {
      failed += 1;
      console.log(`✗ ${name}: ${err && err.message ? err.message : String(err)}`);
    }
  });
}

function skipNonCode(src, i) {
  const n = src.length;
  if (src[i] === '/' && src[i + 1] === '/') {
    while (i < n && src[i] !== '\n') i++;
    return i;
  }
  if (src[i] === '/' && src[i + 1] === '*') {
    i += 2;
    while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
    return Math.min(n, i + 2);
  }
  if (src[i] === "'" || src[i] === '"' || src[i] === '`') {
    const q = src[i++];
    while (i < n) {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === q) { i++; break; }
      i++;
    }
    return i;
  }
  return i;
}

function stripCommentsAndStrings(src) {
  // String-aware: a `/*` inside a quote must not eat Brand.create
  // (the naive regex that caused routes/brand.js to vanish from A0).
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const next = skipNonCode(src, i);
    if (next !== i) {
      const ch = src[i];
      if (ch === "'" || ch === '"' || ch === '`') out += ch === '`' ? '``' : (ch + ch);
      i = next;
      continue;
    }
    out += src[i];
    i++;
  }
  return out;
}

function extractBraced(src, fromIdx) {
  let i = fromIdx;
  const n = src.length;
  while (i < n) {
    const next = skipNonCode(src, i);
    if (next !== i) { i = next; continue; }
    if (src[i] === '{') break;
    i++;
  }
  if (src[i] !== '{') return '';
  const open = i;
  let depth = 0;
  while (i < n) {
    const next = skipNonCode(src, i);
    if (next !== i) { i = next; continue; }
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
    i++;
  }
  return src.slice(open);
}

function extractFnBody(src, start) {
  // Skip the parameter list so `{ isBrandAborted } = {}` is not mistaken
  // for the function body (that was why every ingest file looked unwired).
  const head = src.slice(start, start + 48);
  if (/^(async\s+)?function\s+/.test(head)) {
    let i = start;
    const n = src.length;
    while (i < n) {
      const next = skipNonCode(src, i);
      if (next !== i) { i = next; continue; }
      if (src[i] === '(') break;
      i++;
    }
    let depth = 0;
    while (i < n) {
      const next = skipNonCode(src, i);
      if (next !== i) { i = next; continue; }
      if (src[i] === '(') depth++;
      else if (src[i] === ')') {
        depth--;
        if (depth === 0) { i++; break; }
      }
      i++;
    }
    return extractBraced(src, i);
  }
  return extractBraced(src, start);
}

const TRIGGER_RE = /queueBrandEnrichment\s*\(|enrichBrandFromUrl\s*\(|ensureBrandFontsIngested\s*\(/;

function calleeHasTrigger(src, name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return false;
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = src.match(re);
  if (!m) return false;
  const body = stripCommentsAndStrings(extractFnBody(src, m.index));
  return TRIGGER_RE.test(body);
}

function handlerHasTrigger(src, body) {
  const code = stripCommentsAndStrings(body);
  if (TRIGGER_RE.test(code)) return true;
  const calls = code.match(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g) || [];
  for (const raw of calls) {
    const name = raw.replace(/\s*\($/, '');
    if (['if', 'for', 'while', 'catch', 'function', 'require', 'async', 'return'].includes(name)) continue;
    if (calleeHasTrigger(src, name)) return true;
  }
  return false;
}

function wiresFontTrigger(src, kind) {
  if (kind === 'ingest' || kind === 'create+ingest') {
    const names = [];
    for (const name of ['syncCatalog', 'syncPosts', 'processWebhookPayload', 'handleMediaChange']) {
      const re = new RegExp('async function ' + name + '\\s*\\(');
      const m = src.match(re);
      if (m) names.push(m.index);
    }
    const re = /async function (syncBrand[A-Z]\w*)\s*\(/g;
    let m;
    while ((m = re.exec(src))) {
      if (/Reviews|Comments/i.test(m[1])) continue;
      names.push(m.index);
    }
    // Webhook: the ingest happens in handleMediaChange; processWebhookPayload
    // only dispatches. Prefer the leaf if both exist.
    if (src.includes('async function handleMediaChange') && src.includes('async function processWebhookPayload')) {
      const leaf = names.filter((idx) => /async function handleMediaChange/.test(src.slice(idx, idx + 40)));
      if (leaf.length) names.length = 0, names.push(...leaf);
    }
    if (!names.length) return false;
    return names.every((idx) => handlerHasTrigger(src, extractFnBody(src, idx)));
  }
  // create: the handler whose body contains Brand.create / upsert
  const starts = [];
  const fnRe = /(?:async\s+)?function\s+\w+\s*\(|router\.(?:post|patch|put)\s*\(/g;
  let m;
  while ((m = fnRe.exec(src))) starts.push(m.index);
  let sawCreate = false;
  for (const idx of starts) {
    const body = extractFnBody(src, idx);
    const code = stripCommentsAndStrings(body);
    if (!/Brand\.create|new Brand|upsert\s*:\s*true/.test(code)) continue;
    sawCreate = true;
    if (handlerHasTrigger(src, body)) return true;
  }
  return !sawCreate ? TRIGGER_RE.test(stripCommentsAndStrings(src)) : false;
}

function isBrandCreateFile(code) {
  if (/\bBrand\.create\s*\(/.test(code)) return true;
  if (/\bnew\s+Brand\s*\(/.test(code)) return true;
  if (/\bBrand\.findOneAndUpdate\s*\(/.test(code) && /upsert\s*:\s*true/.test(code)) return true;
  return false;
}

function isIngestImplFile(code) {
  if (/async function syncCatalog\s*\(/.test(code)) return true;
  if (/async function syncPosts\s*\(/.test(code)) return true;
  if (/async function processWebhookPayload\s*\(/.test(code)) return true;
  // syncBrand* catalog/social ingest writers. Exclude review/comment
  // fan-outs (syncBrandProductReviews, syncBrandInstagramCommentsApify)
  // which are not brand-import paths.
  const re = /async function (syncBrand[A-Z]\w*)\s*\(/g;
  let m;
  while ((m = re.exec(code))) {
    if (/Reviews|Comments/i.test(m[1])) continue;
    return true;
  }
  return false;
}

function walkProductionJs(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  const skip = new Set(['node_modules', 'remotion', 'scripts', 'models', 'public', 'docs', 'session.d', 'frontend']);
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue;
    if (skip.has(ent.name)) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkProductionJs(p, acc);
    else if (ent.name.endsWith('.js')) acc.push(p);
  }
  return acc;
}

function collectEntryPoints(readSrc) {
  const files = [];
  for (const rootName of ['routes', 'services', 'pipelines']) {
    walkProductionJs(path.join(ROOT, rootName), files);
  }
  for (const extra of ['worker.js', 'index.js']) {
    const p = path.join(ROOT, extra);
    if (fs.existsSync(p)) files.push(p);
  }

  const entries = [];
  for (const abs of files) {
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    const src = readSrc(rel, abs);
    // Scan raw source. Stripping comments/strings is unsafe here: a `/*`
    // inside a string in a large route file (routes/brand.js) eats the
    // real Brand.create and silently drops the file from the scan.
    const create = isBrandCreateFile(src);
    const ingest = isIngestImplFile(src);
    if (!create && !ingest) continue;
    const kind = create && ingest ? 'create+ingest' : create ? 'create' : 'ingest';
    entries.push({
      rel,
      src,
      kind,
      wired: wiresFontTrigger(src, kind)
    });
  }
  return entries;
}

function unwiredOf(entries) {
  return entries.filter((e) => !e.wired);
}

// ── Group A — structural scan of real files ──────────────────────────

const LIVE = collectEntryPoints((_rel, abs) => fs.readFileSync(abs, 'utf8'));

check('A0 scanner found brand-create AND ingest entry points (not an empty scan)', () => {
  const creates = LIVE.filter((e) => e.kind !== 'ingest');
  const ingests = LIVE.filter((e) => e.kind !== 'create');
  assert.ok(creates.length >= 4, `expected ≥4 brand-create files, got ${creates.length}: ${creates.map((e) => e.rel).join(', ')}`);
  assert.ok(ingests.length >= 4, `expected ≥4 ingest impl files, got ${ingests.length}: ${ingests.map((e) => e.rel).join(', ')}`);
  const rels = new Set(LIVE.map((e) => e.rel));
  assert.ok(rels.has('routes/brand.js'), 'POST /api/brand must be in the scan');
  assert.ok(rels.has('routes/onboarding.js'), 'onboarding starter-brand create must be in the scan');
  assert.ok(rels.has('services/shopifyPublicIngestService.js'), 'shopify-direct ingest must be in the scan');
  assert.ok(rels.has('services/catalogSyncService.js'), 'IG catalog sync must be in the scan');
  assert.ok(rels.has('services/postSyncService.js'), 'IG posts sync must be in the scan');
  assert.ok(rels.has('services/instagramWebhookService.js'), 'IG webhook must be in the scan');
  assert.ok(rels.has('services/salesDemosService.js'), 'demo-brand upsert must be in the scan');
  assert.ok(rels.has('services/brandCatalogService.js'), 'detect stub upsert must be in the scan');
});

check('A1 every scanned create/import file reaches the font choke point', () => {
  const missing = unwiredOf(LIVE);
  assert.equal(
    missing.length,
    0,
    'unwired entry point(s) — wire queueBrandEnrichment / enrichBrandFromUrl / ensureBrandFontsIngested: '
      + missing.map((e) => `${e.rel} (${e.kind})`).join(', ')
  );
});

function handlerStartsFor(src, kind) {
  const starts = [];
  if (kind === 'ingest' || kind === 'create+ingest') {
    for (const name of ['syncCatalog', 'syncPosts', 'processWebhookPayload', 'handleMediaChange']) {
      const re = new RegExp('async function ' + name + '\\s*\\(');
      const m = src.match(re);
      if (m) starts.push(m.index);
    }
    const re = /async function (syncBrand[A-Z]\w*)\s*\(/g;
    let m;
    while ((m = re.exec(src))) {
      if (/Reviews|Comments/i.test(m[1])) continue;
      starts.push(m.index);
    }
  }
  if (kind === 'create' || kind === 'create+ingest') {
    const fnRe = /(?:async\s+)?function\s+\w+\s*\(|router\.(?:post|patch|put)\s*\(/g;
    let m;
    while ((m = fnRe.exec(src))) starts.push(m.index);
  }
  return [...new Set(starts)];
}

function mutantDeleteHandlerCalls(src, kind) {
  let out = src;
  const starts = handlerStartsFor(src, kind).sort((a, b) => b - a);
  for (const idx of starts) {
    const body = extractFnBody(src, idx);
    if (!body) continue;
    const code = stripCommentsAndStrings(body);
    if ((kind === 'create' || kind === 'create+ingest') && !/Brand\.create|new Brand|upsert\s*:\s*true/.test(code)
        && !(kind === 'ingest' || /async function sync/.test(src.slice(idx, idx + 80)))) {
      if (kind === 'create') continue;
    }
    const mutatedBody = body
      .replace(/queueBrandEnrichment\s*\(/g, 'notTheTrigger(')
      .replace(/enrichBrandFromUrl\s*\(/g, 'notEnrich(')
      .replace(/ensureBrandFontsIngested\s*\(/g, 'notEnsure(')
      .replace(/attachBrandFontIngest\s*\(/g, 'notAttach(')
      .replace(/triggerEnrichment\s*\(/g, 'notTrigger(');
    const braceAt = out.indexOf(body, Math.max(0, idx - 10));
    if (braceAt < 0) continue;
    out = out.slice(0, braceAt) + mutatedBody + out.slice(braceAt + body.length);
  }
  return out;
}

check('A1b [REVERT] deleting the trigger call in EACH wired handler (keeping the helper) fails A1', () => {
  for (const e of LIVE) {
    if (!e.wired) continue;
    const next = mutantDeleteHandlerCalls(e.src, e.kind);
    assert.notEqual(next, e.src, `${e.rel}: mutation was a no-op`);
    const wired = wiresFontTrigger(next, e.kind);
    assert.equal(wired, false, `${e.rel}: deleting the handler call but leaving helpers/comments must fail the scan`);
  }
});

check('A2 choke point is queueBrandEnrichment (coalesced) or enrichBrandFromUrl, not a per-tier copy-paste', () => {
  // Leaf ingest writers and create paths should hit the shared helper,
  // not call identifyBrandAdFonts themselves (operator routes are the
  // explicit exception — they are not import paths).
  const importRels = LIVE.map((e) => e.rel);
  for (const rel of importRels) {
    if (rel === 'routes/brand.js') continue; // operator ingest-meta-fonts lives here
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const code = stripCommentsAndStrings(src);
    assert.ok(
      !(/identifyBrandAdFonts\s*\(/.test(code) && !/queueBrandEnrichment|enrichBrandFromUrl|ensureBrandFontsIngested/.test(src)),
      `${rel} calls identifyBrandAdFonts without going through the choke point`
    );
  }
});

// ── Group B — enrichBrandFromUrl no-websiteUrl still runs fonts ──────

function assertNoWebsiteUrlFontPath(src, label) {
  const start = src.indexOf('async function enrichBrandFromUrlInner');
  const end = src.indexOf('async function runEnrichment');
  assert.ok(start > -1 && end > start, `${label}: enrichBrandFromUrlInner / runEnrichment anchors moved`);
  const fn = src.slice(start, end);
  assert.ok(/if\s*\(\s*!brand\.websiteUrl\s*\)/.test(fn), `${label}: must still branch on missing websiteUrl`);
  assert.ok(/ensureBrandFontsIngested/.test(fn), `${label}: must still run font tiers without a websiteUrl`);
  assert.ok(/markEnrichmentSkipped/.test(fn), `${label}: skip recording must still exist for the cannot-run-fonts arm`);
  const skipOnlyArm = fn.includes('if (!plan.anyWithoutWebsite)');
  assert.ok(skipOnlyArm, `${label}: skip must be gated on !anyWithoutWebsite so fonts-will-run does not mark skip`);
}

check('B1 enrichBrandFromUrl no-websiteUrl still calls ensureBrandFontsIngested (skip only when fonts cannot run)', () => {
  assertNoWebsiteUrlFontPath(ENRICH_SRC, 'live');
});

check('B2 runEnrichment delegates font tiers to ensureBrandFontsIngested (one implementation)', () => {
  const start = ENRICH_SRC.indexOf('async function runEnrichment');
  assert.ok(start > -1);
  const fn = ENRICH_SRC.slice(start, ENRICH_SRC.indexOf('function extractTextFromHtml'));
  assert.ok(/await ensureBrandFontsIngested\(brand,\s*run/.test(fn), 'runEnrichment must call ensureBrandFontsIngested');
  const codeOnly = fn.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(
    !/identifyBrandAdFonts/.test(codeOnly),
    'runEnrichment must not in-line the Meta-ads call — that would re-open a second copy of the money gate'
  );
});

check('B3 enrichBrandFromUrl itself is coalesced (not only queueBrandEnrichment)', () => {
  assert.ok(/_queuedEnrichment/.test(ENRICH_SRC), 'must keep an in-process map');
  assert.ok(/function startCoalescedEnrichment/.test(ENRICH_SRC));
  assert.ok(/async function enrichBrandFromUrl\(/.test(ENRICH_SRC));
  const publicFn = ENRICH_SRC.slice(
    ENRICH_SRC.indexOf('async function enrichBrandFromUrl('),
    ENRICH_SRC.indexOf('async function enrichBrandFromUrlInner')
  );
  assert.ok(/startCoalescedEnrichment/.test(publicFn), 'public enrichBrandFromUrl must go through the Map');
  assert.ok(/already in flight/.test(ENRICH_SRC), 'coalesce path must be explicit, not a silent Map.set overwrite');
  assert.ok(/metaFontsIngestStartedAt/.test(ENRICH_SRC), 'cross-process claim must exist — the Map is not the money gate');
});

check('B6 homepage GET is gated on wantHomepage (not unconditional when only Meta remains)', () => {
  const start = ENRICH_SRC.indexOf('async function runEnrichment');
  const fn = ENRICH_SRC.slice(start, ENRICH_SRC.indexOf('function extractTextFromHtml'));
  assert.ok(/const wantHomepage/.test(fn));
  assert.ok(/if \(wantHomepage\)/.test(fn));
  const getIdx = fn.indexOf('axios.get(brand.websiteUrl');
  const gateIdx = fn.lastIndexOf('if (wantHomepage)', getIdx);
  assert.ok(getIdx > -1 && gateIdx > -1 && gateIdx < getIdx, 'axios.get(brand.websiteUrl) must sit inside if (wantHomepage)');
});

check('B7 coalesce Map is keyed on (brandId, websiteUrl) — PATCH must not inherit the old-domain promise', () => {
  const start = ENRICH_SRC.indexOf('async function coalesceKey');
  const end = ENRICH_SRC.indexOf('async function startCoalescedEnrichment');
  assert.ok(start > -1 && end > start, 'coalesceKey must exist');
  const fn = ENRICH_SRC.slice(start, end);
  assert.ok(/websiteUrl/.test(fn), 'coalesce key must include websiteUrl');
  assert.ok(/\$\{String\(brandId\)\}\|/.test(fn), 'key form is brandId|websiteUrl');
});

check('B8 [MONEY] Meta claim is findOneAndUpdate on _id + unstamped + stale-or-null startedAt, BEFORE identifyBrandAdFonts', () => {
  const start = ENRICH_SRC.indexOf('async function ensureBrandFontsIngested');
  const end = ENRICH_SRC.indexOf('const _queuedEnrichment');
  const fn = ENRICH_SRC.slice(start, end);
  const claimAt = fn.indexOf('findOneAndUpdate');
  const identAt = fn.indexOf('identifyBrandAdFonts');
  assert.ok(claimAt > -1 && identAt > claimAt, 'CAS must sit before identifyBrandAdFonts');
  assert.ok(/metaFontsIngestedAt:\s*null/.test(fn));
  assert.ok(/metaFontsIngestStartedAt:\s*null/.test(fn));
  assert.ok(/metaFontsIngestStartedAt:\s*\{\s*\$lt:/.test(fn));
  assert.ok(/\$set:\s*\{\s*metaFontsIngestStartedAt:/.test(fn));
  const codeOnly = fn.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/enrichInFlight/.test(codeOnly), 'must not reuse apifyDemo.enrichInFlight');
  const staleLit = ENRICH_SRC.match(/META_FONTS_CLAIM_STALE_MS\s*=\s*([^;]+)/);
  assert.ok(staleLit, 'STALE constant must be declared');
  const staleMs = Function(`return (${staleLit[1]})`)();
  assert.ok(staleMs >= (5 * 60 * 1000 + 15_000) + 120_000,
    `STALE ${staleMs} must cover Apify runActorSync 315s + vision 120s`);
});

check('A3 new callers wrap brandEnrichmentService require in try (like brandCreate.js)', () => {
  const sites = [
    'services/instagramWebhookService.js',
    'services/postSyncService.js',
    'services/salesDemosService.js',
    'routes/onboarding.js',
    'services/catalogSyncService.js',
    'services/brandCatalogService.js',
    'services/capabilityExecutors/salesBrandPatch.js'
  ];
  for (const rel of sites) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const lines = src.split('\n');
    let found = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!/require\([^)]*brandEnrichmentService/.test(lines[i])) continue;
      found += 1;
      const window = lines.slice(Math.max(0, i - 4), i + 1).join('\n');
      assert.ok(/try\s*\{/.test(window), `${rel}:${i + 1} require(brandEnrichmentService) must sit inside try {`);
    }
    assert.ok(found > 0, `${rel} must require brandEnrichmentService`);
  }
});

check('E1 sales.brand.patch shopifyUrl change clears shopify font stamp + shopify-theme faces', () => {
  const src = fs.readFileSync(path.join(ROOT, 'services/capabilityExecutors/salesBrandPatch.js'), 'utf8');
  assert.ok(/shopifyUrlChanged/.test(src));
  assert.ok(/shopifyFontsIngestedAt\s*=\s*null/.test(src));
  assert.ok(/shopifyFontsIngestError\s*=\s*null/.test(src));
  assert.ok(/source\s*!==\s*'shopify-theme'/.test(src));
});

check('B4 early returns on fetch/LLM failure still fall through when font tiers remain', () => {
  // A homepage fetch failure must not skip Meta-ads fonts — those do not
  // need the marketing site.
  const start = ENRICH_SRC.indexOf('async function runEnrichment');
  const fn = ENRICH_SRC.slice(start, ENRICH_SRC.indexOf('function extractTextFromHtml'));
  const fetchBail = fn.match(/if\s*\(\s*!bf\s*&&\s*!wantLogoIngest([\s\S]*?)return/);
  assert.ok(fetchBail, 'fetch-failed early return not found');
  assert.ok(/wantMetaFonts/.test(fetchBail[0]), 'fetch-failed return must consider wantMetaFonts');
  assert.ok(/wantShopifyFonts/.test(fetchBail[0]), 'fetch-failed return must consider wantShopifyFonts');
  assert.ok(/wantFontIngest/.test(fetchBail[0]), 'fetch-failed return must consider wantFontIngest');
});

check('B5 planFontTiers gates Shopify on apifyDemo.shopifyUrl, not method/isDemo', () => {
  const line = ENRICH_SRC.match(/const wantShopifyFonts\s*=\s*[^\n]+/);
  assert.ok(line, 'must find the wantShopifyFonts declaration');
  assert.ok(/shopifyUrl/.test(line[0]));
  assert.ok(!/apifyDemo\.method/.test(line[0]));
  assert.ok(!/isDemo/.test(line[0]));
});

// ── Group C — behavioural, stubbed Brand + font services ─────────────

const {
  ensureBrandFontsIngested,
  planFontTiers,
  queueBrandEnrichment,
  enrichBrandFromUrl,
  META_FONTS_CLAIM_STALE_MS
} = require('../services/brandEnrichmentService');
const persistence = require('../services/brandFontPersistenceService');
const Brand = require('../models/Brand');

function makeBrand(overrides = {}) {
  return {
    _id: 'brand1',
    name: 'Test Brand',
    websiteUrl: 'https://example.com',
    fontIngestedAt: null,
    fontIngestError: null,
    metaFontsIngestedAt: null,
    metaFontsIngestError: null,
    shopifyFontsIngestedAt: null,
    shopifyFontsIngestError: null,
    apifyDemo: { shopifyUrl: 'https://store.example.com' },
    customFonts: [],
    curatedFields: [],
    save: async () => {},
    markModified: () => {},
    ...overrides
  };
}

function emptyWebsiteResult() {
  return { ingested: [], flagged: [], errors: [], usage: { heading: null, body: null, evidence: [] } };
}
function emptyShopifyResult() {
  return { ingested: [], flagged: [], errors: [], usage: { heading: null, body: null, evidence: [] }, via: 'public' };
}
function metaResult({ billableAttempted, errors = [] }) {
  return {
    usage: { heading: null, body: null, evidence: [] },
    via: 'none',
    imagesUsed: 0,
    billableAttempted,
    errors
  };
}

function stubBrand(brand, { claimStore } = {}) {
  const store = claimStore || { startedAt: null, ingestedAt: brand.metaFontsIngestedAt };
  return {
    findById: async () => brand,
    updateOne: async () => ({ acknowledged: true }),
    findOneAndUpdate: async (filter, update) => {
      if (brand.metaFontsIngestedAt) return null;
      if (brand.metaFontsIngestStartedAt) {
        const age = Date.now() - new Date(brand.metaFontsIngestStartedAt).getTime();
        if (age < META_FONTS_CLAIM_STALE_MS) return null;
      }
      brand.metaFontsIngestStartedAt = (update.$set && update.$set.metaFontsIngestStartedAt) || new Date();
      store.startedAt = brand.metaFontsIngestStartedAt;
      return brand;
    }
  };
}

function dummyProgress() {
  return {
    startRun: async () => ({
      checkpoint: async () => {},
      stage() {},
      succeed: async () => {},
      fail: async () => {},
    }),
    CancelledError: class CancelledError extends Error {}
  };
}

function baseFontDeps(brand, calls, extra = {}) {
  return {
    Brand: stubBrand(brand, extra),
    metaAdsFontsEnabled: () => true,
    metaAdsScanConfigured: extra.metaAdsScanConfigured || (async () => true),
    ingestBrandFonts: async () => { calls.website += 1; return emptyWebsiteResult(); },
    identifyBrandAdFonts: extra.identifyBrandAdFonts || (async () => {
      calls.meta += 1;
      return metaResult({ billableAttempted: false, errors: ['no cred'] });
    }),
    ingestShopifyThemeFonts: async () => { calls.shopify += 1; return emptyShopifyResult(); },
    applyFontIngestResult: persistence.applyFontIngestResult,
    applyMetaFontsResult: persistence.applyMetaFontsResult,
    applyShopifyFontIngestResult: persistence.applyShopifyFontIngestResult,
    progressService: dummyProgress(),
    ...extra
  };
}

checkAsync('C1 no websiteUrl: website ingest skipped, Meta-ads still invoked', async () => {
  const brand = makeBrand({ websiteUrl: null });
  const calls = { website: 0, meta: 0, shopify: 0 };
  await ensureBrandFontsIngested(brand, null, baseFontDeps(brand, calls));
  assert.equal(calls.website, 0, 'website ingest must not run without websiteUrl');
  assert.equal(calls.meta, 1, 'Meta-ads tier must still run — that is the social-first gap this change closes');
  assert.equal(calls.shopify, 1, 'Shopify-theme tier runs when apifyDemo.shopifyUrl is set');
  assert.equal(brand.fontIngestError, 'no websiteUrl');
  assert.equal(brand.fontIngestedAt, null, 'must not stamp fontIngestedAt on a skip — free path stays retryable');
});

checkAsync('C2 [MONEY] billableAttempted:false does NOT stamp; cooldown bounds the retry', async () => {
  const brand = makeBrand({ apifyDemo: {} });
  const calls = { website: 0, meta: 0, shopify: 0 };
  const deps = baseFontDeps(brand, calls);
  await ensureBrandFontsIngested(brand, null, deps);
  assert.equal(calls.meta, 1);
  assert.equal(brand.metaFontsIngestedAt, null, 'config-absence must not permanently disable the scan (#362)');
  assert.ok(brand.metaFontsIngestNextRetryAt instanceof Date, 'unbilled gather must set a cooldown, not retry every hour');
  await ensureBrandFontsIngested(brand, null, deps);
  assert.equal(calls.meta, 1, 'cooldown must suppress the next hourly trigger');
  brand.metaFontsIngestNextRetryAt = new Date(0);
  await ensureBrandFontsIngested(brand, null, deps);
  assert.equal(calls.meta, 2, 'after cooldown expires the scan retries');
});

checkAsync('C3 [MONEY] billableAttempted:true stamps, and a stamped brand is not scanned again', async () => {
  const brand = makeBrand({ apifyDemo: {} });
  const calls = { website: 0, meta: 0, shopify: 0 };
  const deps = baseFontDeps(brand, calls, {
    identifyBrandAdFonts: async () => {
      calls.meta += 1;
      return metaResult({ billableAttempted: true, errors: [] });
    }
  });
  await ensureBrandFontsIngested(brand, null, deps);
  assert.equal(calls.meta, 1);
  assert.ok(brand.metaFontsIngestedAt instanceof Date, 'a real spend must stamp so we never re-pay');
  assert.equal(brand.metaFontsIngestStartedAt, null, 'applyMetaFontsResult must release the cross-process claim');
  await ensureBrandFontsIngested(brand, null, deps);
  assert.equal(calls.meta, 1, 'stamped brand must not re-enter identifyBrandAdFonts');
});

checkAsync('C4 Meta kill-switch off: identifyBrandAdFonts is never called', async () => {
  const brand = makeBrand({ apifyDemo: {} });
  const calls = { website: 0, meta: 0, shopify: 0 };
  await ensureBrandFontsIngested(brand, null, baseFontDeps(brand, calls, { metaAdsFontsEnabled: () => false }));
  assert.equal(calls.meta, 0);
  assert.equal(brand.metaFontsIngestedAt, null);
});

checkAsync('C6 [MONEY] DB claim: two ensureBrandFontsIngested share one Meta scan', async () => {
  const brand = makeBrand({ apifyDemo: {}, websiteUrl: null, shopifyFontsIngestedAt: new Date() });
  const calls = { website: 0, meta: 0, shopify: 0 };
  const claimStore = { startedAt: null, ingestedAt: null };
  const deps = baseFontDeps(brand, calls, { claimStore });
  await Promise.all([
    ensureBrandFontsIngested(brand, null, deps),
    ensureBrandFontsIngested(brand, null, deps)
  ]);
  assert.equal(calls.meta, 1, 'losing the CAS must skip the Meta tier this run');
});

checkAsync('C7 [MONEY] two concurrent queueBrandEnrichment / enrichBrandFromUrl share one identifyBrandAdFonts', async () => {
  const brand = makeBrand({
    _id: 'coalesce-brand',
    websiteUrl: null,
    apifyDemo: {},
    shopifyFontsIngestedAt: new Date()
  });
  const calls = { website: 0, meta: 0, shopify: 0 };
  const origFind = Brand.findById;
  const origFOU = Brand.findOneAndUpdate;
  const origUpdate = Brand.updateOne;
  const stub = stubBrand(brand);
  Brand.findById = stub.findById;
  Brand.findOneAndUpdate = stub.findOneAndUpdate;
  Brand.updateOne = stub.updateOne;
  try {
    const opts = baseFontDeps(brand, calls);
    await Promise.all([
      queueBrandEnrichment(brand._id, 'a', brand.name, opts),
      enrichBrandFromUrl(brand._id, opts)
    ]);
    assert.equal(calls.meta, 1, 'in-process coalesce must wrap enrichBrandFromUrl itself');
  } finally {
    Brand.findById = origFind;
    Brand.findOneAndUpdate = origFOU;
    Brand.updateOne = origUpdate;
  }
});

checkAsync('C9 [HIGH] websiteUrl change mid-run discards website faces', async () => {
  const brand = makeBrand({
    websiteUrl: 'https://old.example',
    shopifyFontsIngestedAt: new Date(),
    metaFontsIngestedAt: new Date()
  });
  const calls = { website: 0, meta: 0, shopify: 0 };
  let applied = 0;
  const stub = stubBrand(brand);
  stub.findById = async () => ({ websiteUrl: 'https://new.example' });
  await ensureBrandFontsIngested(brand, null, baseFontDeps(brand, calls, {
    Brand: stub,
    applyFontIngestResult: (b, r) => {
      applied += 1;
      return persistence.applyFontIngestResult(b, r);
    }
  }));
  assert.equal(calls.website, 1, 'website ingest still ran against the URL it started with');
  assert.equal(applied, 0, 'must not write old-domain faces onto a brand whose websiteUrl changed');
  assert.equal(calls.meta, 0);
});

checkAsync('C10 config-absent: identifyBrandAdFonts is not called; cooldown is set', async () => {
  const brand = makeBrand({
    websiteUrl: null,
    apifyDemo: {},
    shopifyFontsIngestedAt: new Date()
  });
  const calls = { website: 0, meta: 0, shopify: 0 };
  await ensureBrandFontsIngested(brand, null, baseFontDeps(brand, calls, {
    metaAdsScanConfigured: async () => false
  }));
  assert.equal(calls.meta, 0, 'unconfigured Meta must not enter identifyBrandAdFonts');
  assert.ok(brand.metaFontsIngestNextRetryAt instanceof Date, 'config-absence is bounded, not hourly-forever');
});

checkAsync('C8 no-URL font-only branch is driven through enrichBrandFromUrl', async () => {
  const brand = makeBrand({
    _id: 'font-only-brand',
    websiteUrl: null,
    apifyDemo: {},
    shopifyFontsIngestedAt: new Date()
  });
  const calls = { website: 0, meta: 0, shopify: 0 };
  const origFind = Brand.findById;
  const origFOU = Brand.findOneAndUpdate;
  const origUpdate = Brand.updateOne;
  const updateCalls = [];
  const stub = stubBrand(brand);
  Brand.findById = stub.findById;
  Brand.findOneAndUpdate = stub.findOneAndUpdate;
  Brand.updateOne = async (filter, update) => {
    updateCalls.push({ filter, update });
    return { acknowledged: true };
  };
  try {
    const result = await enrichBrandFromUrl(brand._id, baseFontDeps(brand, calls));
    assert.equal(result.fontOnly, true);
    assert.equal(calls.meta, 1);
    assert.equal(calls.website, 0);
    const skipWrites = updateCalls.filter((c) => c.update && c.update.$set && c.update.$set.enrichmentSkipReason);
    assert.equal(skipWrites.length, 0, '#7: do not markEnrichmentSkipped when fonts still run');
  } finally {
    Brand.findById = origFind;
    Brand.findOneAndUpdate = origFOU;
    Brand.updateOne = origUpdate;
  }
});

check('C5 planFontTiers: no shopifyUrl → wantShopifyFonts false; stamped meta → wantMetaFonts false', () => {
  const a = planFontTiers({
    fontIngestedAt: null,
    metaFontsIngestedAt: new Date(),
    shopifyFontsIngestedAt: null,
    apifyDemo: {},
    websiteUrl: 'https://x.com'
  }, { metaAdsFontsEnabled: () => true });
  assert.equal(a.wantMetaFonts, false);
  assert.equal(a.wantShopifyFonts, false);
  assert.equal(a.anyWithoutWebsite, false);
  assert.equal(a.wantFontIngest, true);

  const b = planFontTiers({
    fontIngestedAt: new Date(),
    metaFontsIngestedAt: null,
    shopifyFontsIngestedAt: null,
    apifyDemo: { shopifyUrl: 'https://s.myshopify.com' },
    websiteUrl: null
  }, { metaAdsFontsEnabled: () => true });
  assert.equal(b.wantFontIngest, false);
  assert.equal(b.wantMetaFonts, true);
  assert.equal(b.wantShopifyFonts, true);
  assert.equal(b.anyWithoutWebsite, true);
});

// ── Group D — revert-prove ───────────────────────────────────────────

check('D1 [REVERT] removing onboarding.js font-trigger wiring fails A1', () => {
  const mutant = collectEntryPoints((rel, abs) => {
    const src = fs.readFileSync(abs, 'utf8');
    if (rel !== 'routes/onboarding.js') return src;
    const next = mutantDeleteHandlerCalls(src, 'create');
    assert.notEqual(next, src, 'onboarding mutation was a no-op — the wiring shape moved');
    return next;
  });
  const missing = unwiredOf(mutant).filter((e) => e.rel === 'routes/onboarding.js');
  assert.equal(missing.length, 1, 'dropping onboarding create wiring must fail the scan for that file');
});

check('D2 [REVERT] dropping ensureBrandFontsIngested from the no-URL arm fails B1', () => {
  const mutated = ENRICH_SRC.replace(
    /const result = await ensureBrandFontsIngested\(brand, run, opts\);/,
    'const result = { ok: false, ran: [] }; /* REVERT-PROVE */'
  );
  assert.notEqual(mutated, ENRICH_SRC, 'mutation of the font-only call was a no-op');
  let failed = false;
  try {
    assertNoWebsiteUrlFontPath(mutated, 'mutant');
  } catch (_) {
    failed = true;
  }
  assert.equal(failed, true, 'D2 must actually re-run B1 against the mutant and see it fail');
});

check('D3 live tree still has the call D2 deleted (so D2 discriminates)', () => {
  assertNoWebsiteUrlFontPath(ENRICH_SRC, 'live-d3');
});

check('D4 [REVERT] dropping the Meta CAS claim fails B8', () => {
  const mutated = ENRICH_SRC.replace(/findOneAndUpdate\s*\(/, 'findByIdAndNoClaim(');
  assert.notEqual(mutated, ENRICH_SRC);
  let failed = false;
  try {
    const start = mutated.indexOf('async function ensureBrandFontsIngested');
    const end = mutated.indexOf('const _queuedEnrichment');
    const fn = mutated.slice(start, end);
    assert.ok(fn.indexOf('findOneAndUpdate') > -1);
  } catch (_) {
    failed = true;
  }
  assert.equal(failed, true, 'B8 must fail when the CAS is renamed away');
});

check('D5 [REVERT] dropping try around a new-site require fails A3', () => {
  const abs = path.join(ROOT, 'services/instagramWebhookService.js');
  const src = fs.readFileSync(abs, 'utf8');
  const mutated = src.replace(/try \{\s*require\('\.\/brandEnrichmentService'\)/, "require('./brandEnrichmentService')");
  assert.notEqual(mutated, src, 'instagramWebhook try-mutation was a no-op');
  const lines = mutated.split('\n');
  let failed = false;
  for (let i = 0; i < lines.length; i++) {
    if (!/require\([^)]*brandEnrichmentService/.test(lines[i])) continue;
    const window = lines.slice(Math.max(0, i - 4), i + 1).join('\n');
    if (!/try\s*\{/.test(window)) { failed = true; break; }
  }
  assert.equal(failed, true);
});

check('D6 [REVERT] dropping shopify stamp-clear on sales.brand.patch fails E1', () => {
  const src = fs.readFileSync(path.join(ROOT, 'services/capabilityExecutors/salesBrandPatch.js'), 'utf8');
  const mutated = src.replace(/brand\.shopifyFontsIngestedAt = null;/, '/* cleared */');
  assert.notEqual(mutated, src);
  let failed = false;
  try {
    assert.ok(/shopifyFontsIngestedAt\s*=\s*null/.test(mutated));
  } catch (_) {
    failed = true;
  }
  assert.equal(failed, true);
});

(async () => {
  for (const run of asyncChecks) await run();
  const total = passed + failed;
  console.log(`${passed}/${total} checks passed`);
  if (failed) {
    console.log('entry points scanned:');
    for (const e of LIVE) console.log(`  ${e.wired ? '✓' : '✗'} ${e.kind.padEnd(14)} ${e.rel}`);
  }
  process.exit(failed ? 1 : 0);
})();
