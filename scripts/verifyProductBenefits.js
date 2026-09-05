#!/usr/bin/env node
'use strict';
/**
 * verifyProductBenefits — catalog-field derivation (money-facing).
 *
 *   A. Output contract + kill switch + idempotent refuse (no LLM).
 *   B. MONEY GUARD (structural):
 *        - assembleSignals / expandWizardJob / render paths never
 *          require productBenefitsService or call deriveShortBenefits.
 *        - only ingest writers + the backfill script may require it.
 *        - no retry loop around the billable chatCompletion.
 *        - kill switch is strictly === 'true'.
 *        - copyDerivationService.productSummary.short_benefits stays a
 *          literal [] (populating CatalogProduct.shortBenefits must not
 *          silently change the cartesian fallback).
 *   C. Ingest insert-only: upsertWasInsert is false on updatedExisting.
 *   D. Revert-prove the money guards.
 *   F. Text-change freshness (DATA-PATH-AUDIT §9 item 11):
 *        changed title → stamp cleared + enqueue; identical → no write;
 *        price-only → no write.
 *
 * Run: node scripts/verifyProductBenefits.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const SVC_PATH = path.join(ROOT, 'services/productBenefitsService.js');
const DIRECTOR_PATH = path.join(ROOT, 'services/aiCreativeDirectorService.js');
const EXPAND_PATH = path.join(ROOT, 'services/campaignAdsGenerationService.js');
const COPY_PATH = path.join(ROOT, 'services/copyDerivationService.js');
const LIS_PATH = path.join(ROOT, 'services/layoutInputService.js');
const DEFAULTS_ENV = path.join(ROOT, 'config/defaults.env');
const SCHEMA_PATH = path.join(ROOT, 'models/CatalogProduct.js');

const ORIG_FLAG = process.env.PRODUCT_BENEFITS_DERIVATION;
function restoreFlag() {
  if (ORIG_FLAG === undefined) delete process.env.PRODUCT_BENEFITS_DERIVATION;
  else process.env.PRODUCT_BENEFITS_DERIVATION = ORIG_FLAG;
}

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

function stripCommentsAndStrings(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

function paramListEnd(fileSrc, fromParen) {
  let depth = 0;
  for (let i = fromParen; i < fileSrc.length; i++) {
    const ch = fileSrc[i];
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

function extractFunctionSource(fileSrc, fnName) {
  const start = fileSrc.indexOf(`function ${fnName}(`);
  if (start < 0) return null;
  const afterParams = paramListEnd(fileSrc, fileSrc.indexOf('(', start));
  if (afterParams < 0) return null;
  const open = fileSrc.indexOf('{', afterParams);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < fileSrc.length; i++) {
    const ch = fileSrc[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return fileSrc.slice(start, i + 1); }
  }
  return null;
}

function withTempMutation(filePath, find, replace, runCheck) {
  const original = fs.readFileSync(filePath, 'utf8');
  assert.ok(original.includes(find), `mutate target not found: ${find.slice(0, 80)}`);
  const mutated = original.replace(find, replace);
  const tmp = path.join(
    os.tmpdir(),
    `verifyProductBenefits-${path.basename(filePath)}-${process.pid}-${Date.now()}.js`
  );
  fs.writeFileSync(tmp, mutated);
  try { runCheck(fs.readFileSync(tmp, 'utf8')); }
  finally { try { fs.unlinkSync(tmp); } catch (_) { /* tmp cleanup */ } }
  assert.strictEqual(
    fs.readFileSync(filePath, 'utf8'),
    original,
    'real file was modified — mutation must target the temp copy only'
  );
}

function walkJs(dir, acc) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (_) { return acc; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkJs(full, acc);
    else if (/\.(js|mjs|cjs)$/.test(e.name)) acc.push(full);
  }
  return acc;
}

const ALLOWED_REQUIRE = new Set([
  'services/productBenefitsService.js',
  'services/shopifyPublicIngestService.js',
  'services/genericCatalogIngestService.js',
  'services/apifyIngestService.js',
  'services/catalogSyncService.js',
  'services/catalogProductDraftService.js',
  'services/capabilityExecutors/catalogCreateProduct.js',
  'services/capabilityExecutors/catalogBulkCreateProducts.js',
  'services/productMatchService.js',
  'routes/upload.js',
  'scripts/backfillProductBenefits.js',
  'scripts/verifyProductBenefits.js',
].map((p) => path.normalize(p)));

const FORBIDDEN_FILES = [
  'services/aiCreativeDirectorService.js',
  'services/campaignAdsGenerationService.js',
  'services/renderService.js',
  'services/brandScriptExecutor.js',
  'services/directImageRenderService.js',
  'services/layoutInputService.js',
  'routes/ads.js',
  'worker.js',
  'index.js',
];

process.env.PRODUCT_BENEFITS_DERIVATION = 'true';

const atlas = require('../services/atlasLlmService');
const CatalogProduct = require('../models/CatalogProduct');
const Brand = require('../models/Brand');
const svc = require('../services/productBenefitsService');

const origChat = atlas.chatCompletion;
const origUpdate = CatalogProduct.updateOne;
const origBrandFind = Brand.findById;
let chatCalls = 0;
let lastChatArgs = null;

function stubLlm(payload) {
  chatCalls = 0;
  lastChatArgs = null;
  atlas.chatCompletion = async (meta, params) => {
    chatCalls += 1;
    lastChatArgs = { meta, params };
    if (typeof payload === 'function') return payload(meta, params);
    if (payload instanceof Error) throw payload;
    return {
      choices: [{ message: { content: JSON.stringify(payload) } }],
    };
  };
  CatalogProduct.updateOne = async () => ({ acknowledged: true, modifiedCount: 1 });
  Brand.findById = () => ({
    select() { return this; },
    lean() { return Promise.resolve({ name: 'Acme', tone: ['calm'], summary: 'A test brand' }); },
  });
}

function unstubLlm() {
  atlas.chatCompletion = origChat;
  CatalogProduct.updateOne = origUpdate;
  Brand.findById = origBrandFind;
}

async function runBehavioral() {
  try {
    check('A0 flag parser is strictly === "true"',
      svc.isDerivationEnabled() === true);
    process.env.PRODUCT_BENEFITS_DERIVATION = 'false';
    check('A0b string "false" is OFF', svc.isDerivationEnabled() === false);
    process.env.PRODUCT_BENEFITS_DERIVATION = 'TRUE';
    check('A0c "TRUE" is OFF (no toLowerCase)', svc.isDerivationEnabled() === false);
    delete process.env.PRODUCT_BENEFITS_DERIVATION;
    check('A0d unset is OFF', svc.isDerivationEnabled() === false);
    process.env.PRODUCT_BENEFITS_DERIVATION = 'true';
  } finally {
    process.env.PRODUCT_BENEFITS_DERIVATION = 'true';
  }

  check('A1 normalize keeps 3–5, drops a 6th',
    JSON.stringify(svc.normalizeDerivedBenefits(['a', 'b', 'c', 'd', 'e', 'f'])) ===
      JSON.stringify(['a', 'b', 'c', 'd', 'e']));
  check('A2 below-floor (2 items) → []',
    svc.normalizeDerivedBenefits(['a', 'b']).length === 0);
  // A3 used to pin SLICING to 6 words. That was the bug: slicing produced
  // grammatical fragments ("Keeps you dry in the heaviest") and the terminal
  // stamp made them unrepairable (missingBenefitsFilter excludes non-empty
  // rows). An over-length item is now DROPPED, never sliced, and the >=3
  // floor then judges the survivors. Found by adversarial review 2026-09-03.
  check('A3 over-length item is DROPPED, never sliced into a fragment', (() => {
    const out = svc.normalizeDerivedBenefits([
      'one two three four five six seven',   // 7 words -> dropped
      'stays dry in rain',
      'packs into pocket',
      'feels broken in',
    ]);
    return out.length === 3
      && !out.some((s) => /^one two three four five six$/.test(s))
      && !out.some((s) => s.trim().split(/\s+/).length > 6);
  })());
  check('A3b dropping below the floor yields [] rather than a short list', (() => {
    // two over-length + two good = 2 survivors, under the >=3 floor
    const out = svc.normalizeDerivedBenefits([
      'one two three four five six seven',
      'eight nine ten eleven twelve thirteen fourteen',
      'stays dry in rain',
      'packs into pocket',
    ]);
    return out.length === 0;
  })());
  check('A4 non-array → []',
    svc.normalizeDerivedBenefits(null).length === 0);

  stubLlm({ short_benefits: ['Stays dry in rain', 'Packs into its pocket', 'Feels broken in'] });
  try {
    const out = await svc.deriveShortBenefits({
      product: { _id: 'p1', title: 'Rain Shell', description: 'A shell', brandId: 'b1' },
      brand: { name: 'Acme', tone: ['calm'] },
    });
    check('A5 happy path returns 3 benefits and charged',
      out.charged === true && out.benefits.length === 3 && out.reason === 'ok',
      JSON.stringify(out));
    check('A6 one chatCompletion call (no retry loop)',
      chatCalls === 1, `calls=${chatCalls}`);
    check('A7 stage is product_benefits',
      lastChatArgs && lastChatArgs.meta && lastChatArgs.meta.stage === 'product_benefits');
    check('A8 model is gemini-2.5-flash',
      lastChatArgs && lastChatArgs.params && lastChatArgs.params.model === 'gemini-2.5-flash');
  } finally {
    unstubLlm();
  }

  stubLlm({ short_benefits: ['only one'] });
  try {
    const out = await svc.deriveShortBenefits({
      product: { _id: 'p1', title: 'Thin' },
    });
    check('A9 model returned 1 item → [] (floor) still charged (do not retry)',
      out.charged === true && out.benefits.length === 0 && out.reason === 'below-floor' && chatCalls === 1);
  } finally {
    unstubLlm();
  }

  stubLlm(new Error('boom'));
  try {
    const out = await svc.deriveShortBenefits({
      product: { _id: 'p1', title: 'X' },
    });
    check('A10 LLM throw → [] , not thrown, not charged (backfill can retry)',
      out.benefits.length === 0 && out.charged === false && out.reason === 'error' && chatCalls === 1);
  } finally {
    unstubLlm();
  }

  stubLlm({ short_benefits: ['should not run', 'nope', 'nope'] });
  try {
    const out = await svc.deriveShortBenefits({
      product: {
        _id: 'p1',
        title: 'Already done',
        shortBenefits: ['Stays dry in rain', 'Packs small', 'Broken in day one'],
      },
    });
    check('A11 already-has-benefits refuses cheaply (zero LLM calls)',
      out.skipped === true && out.reason === 'already-has-benefits' && chatCalls === 0,
      `calls=${chatCalls} reason=${out.reason}`);
  } finally {
    unstubLlm();
  }

  stubLlm({ short_benefits: ['a', 'b', 'c'] });
  try {
    const out = await svc.deriveShortBenefits({
      product: {
        _id: 'p1',
        title: 'Tried',
        shortBenefits: [],
        shortBenefitsDerivedAt: new Date(),
      },
    });
    check('A12 already-attempted (empty + derivedAt) refuses cheaply',
      out.skipped === true && out.reason === 'already-attempted' && chatCalls === 0);
  } finally {
    unstubLlm();
  }

  process.env.PRODUCT_BENEFITS_DERIVATION = 'false';
  stubLlm({ short_benefits: ['a', 'b', 'c'] });
  try {
    const out = await svc.deriveShortBenefits({
      product: { _id: 'p1', title: 'X' },
    });
    check('A13 flag-off refuses cheaply (zero LLM)',
      out.skipped === true && out.reason === 'flag-off' && chatCalls === 0);
  } finally {
    unstubLlm();
    process.env.PRODUCT_BENEFITS_DERIVATION = 'true';
  }

  check('A14 upsertWasInsert is false on updatedExisting (resync must not derive)',
    svc.upsertWasInsert({ value: { _id: 'x' }, lastErrorObject: { updatedExisting: true } }) === false);
  check('A15 upsertWasInsert is true only on a proven insert',
    svc.upsertWasInsert({ value: { _id: 'x' }, lastErrorObject: { updatedExisting: false } }) === true);
  check('A16 missing lastErrorObject fails CLOSED (treat as update)',
    svc.upsertWasInsert({ value: { _id: 'x' } }) === false &&
      svc.upsertWasInsert(null) === false);

  const pending = [];
  svc.collectIfNew(
    { value: { _id: 'old' }, lastErrorObject: { updatedExisting: true } },
    pending
  );
  check('A17 collectIfNew skips an update (idempotence on resync)',
    pending.length === 0);
  svc.collectIfNew(
    { value: { _id: 'new' }, lastErrorObject: { updatedExisting: false } },
    pending
  );
  check('A18 collectIfNew keeps an insert',
    pending.length === 1 && pending[0]._id === 'new');

  check('A19 prompt mirrors layoutInputService register (3–5 / ≤ 6 words / buyer benefits not specs)',
    (() => {
      const { system } = svc.buildPrompt({
        product: { title: 'Shell', description: 'A shell' },
        brand: { name: 'Acme' },
      });
      return /3–5 items, each ≤ 6 words, concrete buyer benefits \(not specs\)/.test(system);
    })());

  // ── F. title/description freshness ────────────────────────────────
  check('F1 normalizeProductText trims, collapses whitespace, case-folds',
    svc.normalizeProductText('  Foo   BAR\n') === 'foo bar'
      && svc.normalizeProductText(null) === ''
      && svc.normalizeProductText(undefined) === '');

  const prev = {
    title: 'Trail Jacket',
    description: 'Keeps you dry.',
    shortBenefits: ['Stays dry', 'Packs small', 'Broken in day one'],
    shortBenefitsDerivedAt: new Date(),
  };
  check('F2 changed title → markBenefitsStaleIfTextChanged.changed',
    svc.markBenefitsStaleIfTextChanged(prev, {
      title: 'Trail Jacket V2',
      description: 'Keeps you dry.',
    }).changed === true);
  check('F3 identical (whitespace/case) → not changed',
    svc.markBenefitsStaleIfTextChanged(prev, {
      title: '  TRAIL   JACKET ',
      description: 'Keeps you dry.',
    }).changed === false);
  check('F4 price-only nextFields (same title/desc) → not changed',
    svc.markBenefitsStaleIfTextChanged(prev, {
      title: 'Trail Jacket',
      description: 'Keeps you dry.',
      price: 199,
    }).changed === false);
  check('F4b description change → changed; insert (no prev) → not changed',
    svc.markBenefitsStaleIfTextChanged(prev, {
      title: 'Trail Jacket',
      description: 'A new write-up.',
    }).changed === true
      && svc.markBenefitsStaleIfTextChanged(null, {
        title: 'Brand New',
        description: 'Hello',
      }).changed === false);

  const update = { $set: { title: 'Trail Jacket V2', price: 10 } };
  svc.applyBenefitsStaleToUpdate(update, true);
  check('F5 changed → $unset shortBenefitsDerivedAt (keep shortBenefits)',
    update.$unset
      && update.$unset.shortBenefitsDerivedAt === 1
      && update.$set.shortBenefits === undefined);
  const updateSame = { $set: { title: 'Trail Jacket', price: 11 } };
  svc.applyBenefitsStaleToUpdate(updateSame, false);
  check('F6 identical → applyBenefitsStaleToUpdate is a no-write',
    updateSame.$unset === undefined
      && updateSame.$set.shortBenefits === undefined);

  const stalePending = [];
  svc.collectIfStale(
    { value: { _id: 'old', shortBenefits: ['a', 'b', 'c'], shortBenefitsDerivedAt: new Date() }, lastErrorObject: { updatedExisting: true } },
    stalePending,
    true
  );
  check('F7 collectIfStale on a text-changed update enqueues a redrive view (empty list, no stamp)',
    stalePending.length === 1
      && stalePending[0]._id === 'old'
      && Array.isArray(stalePending[0].shortBenefits)
      && stalePending[0].shortBenefits.length === 0
      && stalePending[0].shortBenefitsDerivedAt == null);
  const skipPending = [];
  svc.collectIfStale(
    { value: { _id: 'old' }, lastErrorObject: { updatedExisting: true } },
    skipPending,
    false
  );
  check('F8 collectIfStale identical → no enqueue',
    skipPending.length === 0);
  const insertPending = [];
  svc.collectAfterCatalogUpsert(
    { value: { _id: 'new' }, lastErrorObject: { updatedExisting: false } },
    insertPending,
    { changed: false }
  );
  check('F9 collectAfterCatalogUpsert still keeps an insert',
    insertPending.length === 1 && insertPending[0]._id === 'new');
}

function runStructural() {
  const svcSrc = fs.readFileSync(SVC_PATH, 'utf8');
  const directorSrc = fs.readFileSync(DIRECTOR_PATH, 'utf8');
  const expandSrc = fs.readFileSync(EXPAND_PATH, 'utf8');
  const copySrc = fs.readFileSync(COPY_PATH, 'utf8');
  const envSrc = fs.readFileSync(DEFAULTS_ENV, 'utf8');
  const schemaSrc = fs.readFileSync(SCHEMA_PATH, 'utf8');

  check('B0 PRODUCT_BENEFITS_DERIVATION=true in defaults.env',
    /^PRODUCT_BENEFITS_DERIVATION=true$/m.test(envSrc));
  check('B1 parser is strictly === \'true\'',
    /process\.env\.PRODUCT_BENEFITS_DERIVATION === 'true'/.test(svcSrc));
  check('B2 schema declares shortBenefits with default undefined (not [])',
    /shortBenefits:\s*\{\s*type:\s*\[String\],\s*default:\s*undefined\s*\}/.test(schemaSrc));
  check('B3 schema declares shortBenefitsDerivedAt',
    /shortBenefitsDerivedAt:\s*\{\s*type:\s*Date,\s*default:\s*null\s*\}/.test(schemaSrc));

  const deriveSrc = extractFunctionSource(svcSrc, 'deriveShortBenefits') || '';
  const deriveCode = stripCommentsAndStrings(deriveSrc);
  const chatHits = deriveCode.match(/atlasLlmService\.chatCompletion\s*\(/g) || [];
  check('B4 deriveShortBenefits contains exactly one chatCompletion (no retry loop)',
    chatHits.length === 1, `hits=${chatHits.length}`);
  check('B5 deriveShortBenefits has no for/while around the call',
    !/\bfor\s*\(/.test(deriveCode) && !/\bwhile\s*\(/.test(deriveCode));
  check('B6 uses atlasLlmService (maxRedirects:0 transport), not axios',
    /atlasLlmService/.test(deriveCode) && !/\baxios\b/.test(deriveCode));
  check('B7 stage name is product_benefits',
    /stage:\s*STAGE/.test(deriveSrc) && /const STAGE = 'product_benefits'/.test(svcSrc));

  const assembleSrc = extractFunctionSource(directorSrc, 'assembleSignals') || '';
  const assembleCode = stripCommentsAndStrings(assembleSrc);
  check('B8 assembleSignals does not require/call productBenefitsService',
    !/productBenefitsService/.test(assembleCode) &&
      !/\bderiveShortBenefits\b/.test(assembleCode) &&
      !/\bderiveAndPersist\b/.test(assembleCode));
  check('B9 assembleSignals does not read LayoutInputArtifact',
    !/LayoutInputArtifact/.test(assembleCode));

  const expandCode = stripCommentsAndStrings(expandSrc);
  check('B10 expandWizardJob file does not require productBenefitsService',
    !/productBenefitsService/.test(expandCode) &&
      !/\bderiveShortBenefits\b/.test(expandCode));

  for (const rel of FORBIDDEN_FILES) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const code = stripCommentsAndStrings(src);
    check(`B11 ${rel} must not require productBenefitsService`,
      !/productBenefitsService/.test(code) && !/\bderiveShortBenefits\b/.test(code));
  }

  const requirers = [];
  for (const file of walkJs(path.join(ROOT, 'services'), []).concat(
    walkJs(path.join(ROOT, 'routes'), []),
    walkJs(path.join(ROOT, 'scripts'), [])
  )) {
    const rel = path.relative(ROOT, file);
    if (rel.startsWith('scripts' + path.sep) && /verifyProductBenefits/.test(rel)) continue;
    const src = fs.readFileSync(file, 'utf8');
    if (/productBenefitsService/.test(stripCommentsAndStrings(src))) {
      requirers.push(path.normalize(rel));
    }
  }
  const unexpected = requirers.filter((r) => !ALLOWED_REQUIRE.has(r));
  check('B12 only ingest writers + backfill may require productBenefitsService',
    unexpected.length === 0,
    `unexpected=${unexpected.join(',') || '(none)'} seen=${requirers.join(',')}`);

  // copyDerivationService must keep sending [] so populating the catalog
  // field cannot silently change the cartesian fallback.
  const copyCode = stripCommentsAndStrings(copySrc);
  check('B13 copyDerivationService productSummary.short_benefits is a literal []',
    /short_benefits:\s*\[\]/.test(copySrc) &&
      !/product\.shortBenefits/.test(copyCode));

  check('B14 prompt text cites the layoutInputService register',
    /layoutInputService\.js:1276/.test(svcSrc) ||
      /3–5 items, each ≤ 6 words, concrete buyer benefits/.test(svcSrc));

  // ── Item 8: layout does not re-invent catalog shortBenefits ────────
  const lis = require('../services/layoutInputService');
  const EMIT_LINE = '"short_benefits" 3–5 items, each ≤ 6 words, concrete buyer benefits (not specs).';
  const emptyCtx = {
    media: { metadata: { brand: 'Acme' } },
    detection: {},
    match: {
      outcome: 'product_match',
      identification: { brand: 'Acme', productName: 'Rain Shell', details: {} }
    },
    brand: { name: 'Acme' },
    catalogShortBenefits: []
  };
  const catalogCtx = {
    ...emptyCtx,
    match: {
      outcome: 'product_match',
      identification: {
        brand: 'Acme',
        productName: 'Rain Shell',
        details: { shortBenefits: ['Keeps you dry', 'Packs flat', 'Taped seams'] }
      }
    }
  };
  const emptyPrompt = lis.buildDerivationPrompt(emptyCtx, 'ai_brand_led', '1:1', { variantKind: 'product_image' });
  const catalogPrompt = lis.buildDerivationPrompt(catalogCtx, 'ai_brand_led', '1:1', { variantKind: 'product_image' });
  check('L1 empty catalog prompt still emits short_benefits instruction (byte-identical class)',
    emptyPrompt.includes(EMIT_LINE));
  check('L2 catalog-non-empty prompt DROPS the emit instruction',
    !catalogPrompt.includes(EMIT_LINE));
  check('L3 empty vs catalog prompts otherwise keep the badges instruction',
    emptyPrompt.includes('"badges" 0–4 items') && catalogPrompt.includes('"badges" 0–4 items'));
  check('L4 catalogShortBenefitsOf reads details.shortBenefits',
    JSON.stringify(lis.catalogShortBenefitsOf(catalogCtx)) === JSON.stringify(['Keeps you dry', 'Packs flat', 'Taped seams']));
  check('L5 empty catalogShortBenefitsOf is []',
    Array.isArray(lis.catalogShortBenefitsOf(emptyCtx)) && lis.catalogShortBenefitsOf(emptyCtx).length === 0);
  check('L6 resolveLayoutShortBenefits prefers catalog list over derivation',
    JSON.stringify(lis.resolveLayoutShortBenefits(catalogCtx, { short_benefits: ['invented'] }))
      === JSON.stringify(['Keeps you dry', 'Packs flat', 'Taped seams']));
  check('L7 empty catalog falls through to derivation.short_benefits (byte-identical assemble)',
    JSON.stringify(lis.resolveLayoutShortBenefits(emptyCtx, { short_benefits: ['invented', 'two'] }))
      === JSON.stringify(['invented', 'two']));
  check('L8 INPUT_SCHEMA_VERSION stays 4.2 (do not bump — cascade already prefers catalog)',
    lis.INPUT_SCHEMA_VERSION === '4.2'
      && /const INPUT_SCHEMA_VERSION = '4\.2'/.test(fs.readFileSync(LIS_PATH, 'utf8')));
  check('L9 assembleInput source uses resolveLayoutShortBenefits',
    /short_benefits:\s*resolveLayoutShortBenefits\(ctx, derivation\)/.test(fs.readFileSync(LIS_PATH, 'utf8')));

  // ── RP. revert-prove ─────────────────────────────────────────────
  {
    let failedAsExpected = false;
    withTempMutation(
      DIRECTOR_PATH,
      '      ? normalizeBenefitList(product?.shortBenefits)',
      '      ? require(\'./productBenefitsService\').deriveShortBenefits(product)',
      (mutSrc) => {
        const fn = extractFunctionSource(mutSrc, 'assembleSignals') || '';
        // productBenefitsService lives in a string literal (stripped);
        // the call identifier is the money hole.
        failedAsExpected = /\bderiveShortBenefits\b/.test(stripCommentsAndStrings(fn));
      }
    );
    check('RP1 [REVERT-PROOF] injecting deriveShortBenefits into assembleSignals fails B8',
      failedAsExpected);
  }

  {
    let failedAsExpected = false;
    withTempMutation(
      SVC_PATH,
      '    const completion = await atlasLlmService.chatCompletion(',
      '    let completion;\n    for (let attempt = 0; attempt < 3; attempt++) completion = await atlasLlmService.chatCompletion(',
      (mutSrc) => {
        const fn = extractFunctionSource(mutSrc, 'deriveShortBenefits') || '';
        const code = stripCommentsAndStrings(fn);
        failedAsExpected = /\bfor\s*\(/.test(code);
      }
    );
    check('RP2 [REVERT-PROOF] wrapping chatCompletion in a for-loop fails B5',
      failedAsExpected);
  }

  {
    let failedAsExpected = false;
    withTempMutation(
      COPY_PATH,
      '    short_benefits: [],',
      '    short_benefits: Array.isArray(product.shortBenefits) ? product.shortBenefits.slice(0, 5) : [],',
      (mutSrc) => {
        failedAsExpected = /product\.shortBenefits/.test(stripCommentsAndStrings(mutSrc)) &&
          !/short_benefits:\s*\[\]/.test(mutSrc);
      }
    );
    check('RP3 [REVERT-PROOF] restoring the live shortBenefits read in copyDerivation fails B13',
      failedAsExpected);
  }

  {
    let failedAsExpected = false;
    withTempMutation(
      SCHEMA_PATH,
      '  shortBenefits:          { type: [String], default: undefined },',
      '  shortBenefits:          { type: [String], default: [] },',
      (mutSrc) => {
        failedAsExpected = !/shortBenefits:\s*\{\s*type:\s*\[String\],\s*default:\s*undefined\s*\}/.test(mutSrc);
      }
    );
    check('RP4 [REVERT-PROOF] default: [] on shortBenefits fails B2 (would collapse never-derived vs empty)',
      failedAsExpected);
  }

  {
    let failedAsExpected = false;
    withTempMutation(
      LIS_PATH,
      '    if (!catalogShortBenefitsOf(ctx).length) {\n      lines.push(`- "short_benefits" 3–5 items, each ≤ 6 words, concrete buyer benefits (not specs).`);\n    }',
      '    lines.push(`- "short_benefits" 3–5 items, each ≤ 6 words, concrete buyer benefits (not specs).`);',
      (mutSrc) => {
        failedAsExpected = !/if \(!catalogShortBenefitsOf\(ctx\)\.length\)/.test(mutSrc);
      }
    );
    check('RP5 [REVERT-PROOF] always-emitting short_benefits instruction fails L2 gate',
      failedAsExpected);
  }

  const WRITERS = [
    'services/shopifyPublicIngestService.js',
    'services/apifyIngestService.js',
    'services/genericCatalogIngestService.js',
    'services/catalogSyncService.js',
  ];
  for (const rel of WRITERS) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const code = stripCommentsAndStrings(src);
    check(`F10 ${rel} calls markBenefitsStaleIfTextChanged`,
      /markBenefitsStaleIfTextChanged/.test(code));
    check(`F11 ${rel} calls collectAfterCatalogUpsert or collectIfStale`,
      /collectAfterCatalogUpsert/.test(code) || /collectIfStale/.test(code));
    check(`F12 ${rel} uses assignImageUrl (no imageUrl clobber)`,
      /assignImageUrl/.test(code));
    check(`F13 ${rel} does not $set imageUrl via || null`,
      !/imageUrl:\s*[^,\n]+\|\|\s*null/.test(code));
  }

  {
    let failedAsExpected = false;
    withTempMutation(
      LIS_PATH,
      '      short_benefits: resolveLayoutShortBenefits(ctx, derivation),',
      '      short_benefits: limitArray(derivation.short_benefits, 5),',
      (mutSrc) => {
        failedAsExpected = !/short_benefits:\s*resolveLayoutShortBenefits\(ctx, derivation\)/.test(mutSrc);
      }
    );
    check('RP6 [REVERT-PROOF] restoring derivation.short_benefits assemble fails L9',
      failedAsExpected);
  }

  {
    let failedAsExpected = false;
    withTempMutation(
      SVC_PATH,
      '  const changed = productTextChanged(prevDoc, nextFields);\n  return { changed };',
      '  const changed = false;\n  return { changed };',
      (mutSrc) => {
        failedAsExpected = /const changed = false/.test(mutSrc)
          && !/const changed = productTextChanged\(prevDoc, nextFields\)/.test(mutSrc);
      }
    );
    check('RP7 [REVERT-PROOF] hardcoding changed=false is detectable (would skip every re-derive)',
      failedAsExpected);
  }

  {
    let failedAsExpected = false;
    const shopifyPath = path.join(ROOT, 'services/shopifyPublicIngestService.js');
    withTempMutation(
      shopifyPath,
      '      require(\'./catalogImageUrlGuard\').assignImageUrl(set, flat.imageUrl);',
      '      set.imageUrl = flat.imageUrl || null;',
      (mutSrc) => {
        const code = stripCommentsAndStrings(mutSrc);
        failedAsExpected = /imageUrl:\s*[^,\n]+\|\|\s*null/.test(code)
          || /imageUrl = .*\|\|\s*null/.test(code);
      }
    );
    check('RP8 [REVERT-PROOF] restoring imageUrl || null on Shopify-direct fails F13',
      failedAsExpected);
  }
}

(async () => {
  try {
    await runBehavioral();
    runStructural();
  } catch (err) {
    failures.push(`THREW: ${err && err.stack ? err.stack : err}`);
  } finally {
    unstubLlm();
    restoreFlag();
  }

  if (failures.length) {
    console.error(`\n❌ product benefits: ${failures.length} FAILED, ${pass} passed\n`);
    failures.forEach((f) => console.error(`   • ${f}`));
    process.exit(1);
  }
  console.log(`✅ product benefits: ${pass} checks passed`);
})();
