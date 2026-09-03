#!/usr/bin/env node
'use strict';
/**
 * verifyDirectorBenefits — Part C of benefits-to-directors + Addition 2.
 *
 *   A. assembleSignals with CatalogProduct.shortBenefits attaches capped
 *      benefits; missing/empty → []; flag off omits the key (not []).
 *      Determinism: same product doc → same benefits (no artifact, no
 *      render history).
 *   B. MONEY GUARD (structural): assembleSignals contains ZERO
 *      LayoutInputArtifact reads AND ZERO calls into buildLayoutInput /
 *      any derivation writer. loadProductBenefits (Part A sample) stays
 *      a findOne of an existing artifact.
 *   C. LAYOUT_DERIVATION_MODEL is split from GEMINI_SEARCH_MODEL; default
 *      remains gemini-2.5-pro (zero behaviour change today).
 *
 * Revert-proven: inject a buildLayoutInput call → B fails; inject a
 * LayoutInputArtifact.findOne into assembleSignals → B fails; restore
 * GEMINI_SEARCH_MODEL read → C fails.
 *
 * Run: node scripts/verifyDirectorBenefits.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const DIRECTOR_PATH = path.join(ROOT, 'services/aiCreativeDirectorService.js');
const HELPER_PATH = path.join(ROOT, 'services/titleSpecContentSample.js');
const LIS_PATH = path.join(ROOT, 'services/layoutInputService.js');
const DEFAULTS_ENV = path.join(ROOT, 'config/defaults.env');

const ORIG_FLAG = process.env.DIRECTOR_PRODUCT_BENEFITS;
const ORIG_MENU = process.env.DIRECTOR_PROOF_MENU_ENABLED;

function restoreEnv() {
  if (ORIG_FLAG === undefined) delete process.env.DIRECTOR_PRODUCT_BENEFITS;
  else process.env.DIRECTOR_PRODUCT_BENEFITS = ORIG_FLAG;
  if (ORIG_MENU === undefined) delete process.env.DIRECTOR_PROOF_MENU_ENABLED;
  else process.env.DIRECTOR_PROOF_MENU_ENABLED = ORIG_MENU;
}

process.env.DIRECTOR_PROOF_MENU_ENABLED = 'false';

const director = require('../services/aiCreativeDirectorService');
const helper = require('../services/titleSpecContentSample');
const Brand = require('../models/Brand');
const CatalogProduct = require('../models/CatalogProduct');
const ProductMatchArtifact = require('../models/ProductMatchArtifact');
const LayoutInputArtifact = require('../models/LayoutInputArtifact');

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
    `verifyDirectorBenefits-${path.basename(filePath)}-${process.pid}-${Date.now()}.js`
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

function query(value) {
  const q = {
    sort() { return q; },
    limit() { return q; },
    select() { return q; },
    lean() { return Promise.resolve(value); },
  };
  return q;
}

const origBrandFindById = Brand.findById;
const origProductFindById = CatalogProduct.findById;
const origPmaFind = ProductMatchArtifact.find;
const origLiaFindOne = LayoutInputArtifact.findOne;

function stubAssemble({ product } = {}) {
  Brand.findById = () => query({
    name: 'Acme',
    summary: 'A test brand',
    tagline: 'Go forth',
    tone: ['calm'],
    logoUrl: null,
  });
  CatalogProduct.findById = () => query(product || {
    title: 'Test Tee',
    description: 'A cotton tee',
    specs: [{ label: 'Material', value: 'Cotton' }],
  });
  ProductMatchArtifact.find = () => query([]);
  // Must stay unused: assembleSignals is a pure function of the product
  // doc for this field. A test that still needs this stub is a regression.
  LayoutInputArtifact.findOne = () => {
    throw new Error('assembleSignals must not read LayoutInputArtifact');
  };
}

function unstubAssemble() {
  Brand.findById = origBrandFindById;
  CatalogProduct.findById = origProductFindById;
  ProductMatchArtifact.find = origPmaFind;
  LayoutInputArtifact.findOne = origLiaFindOne;
}

const FORTY_TWO = 'Waterproof packable shell with taped seams';
assert.strictEqual(FORTY_TWO.length, 42);

async function runBehavioral() {
  // ── A. assembleSignals attaches capped benefits from the product doc ─
  try {
    process.env.DIRECTOR_PRODUCT_BENEFITS = 'true';
    stubAssemble({
      product: {
        title: 'Test Tee',
        description: 'A cotton tee',
        specs: [{ label: 'Material', value: 'Cotton' }],
        shortBenefits: [FORTY_TWO, 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth'],
      },
    });
    const on = await director.assembleSignals({
      brandId: '000000000000000000000001',
      productId: '000000000000000000000002',
      campaignKind: 'product',
      seededUniverse: [],
    });
    check('A1 flag-on product_signal.benefits is present',
      Array.isArray(on.product_signal.benefits),
      `keys=${Object.keys(on.product_signal || {})}`);
    check('A2 cap is 5 — sixth item dropped',
      on.product_signal.benefits.length === 5 &&
        !on.product_signal.benefits.includes('Sixth'),
      JSON.stringify(on.product_signal.benefits));
    check('A3 42-char live string survives intact',
      on.product_signal.benefits[0] === FORTY_TWO,
      JSON.stringify(on.product_signal.benefits[0]));
    check('A4 first five items kept (still ≥3)',
      on.product_signal.benefits[1] === 'Second' &&
        on.product_signal.benefits[4] === 'Fifth');
  } finally {
    unstubAssemble();
  }

  try {
    process.env.DIRECTOR_PRODUCT_BENEFITS = 'true';
    stubAssemble({
      product: {
        title: 'Test Tee',
        description: 'A cotton tee',
        specs: [{ label: 'Material', value: 'Cotton' }],
        // never derived — field absent
      },
    });
    const none = await director.assembleSignals({
      brandId: '000000000000000000000001',
      productId: '000000000000000000000002',
      campaignKind: 'product',
      seededUniverse: [],
    });
    check('A5 no shortBenefits → benefits is [] (never null, never omitted when flag on)',
      Array.isArray(none.product_signal.benefits) &&
        none.product_signal.benefits.length === 0 &&
        Object.prototype.hasOwnProperty.call(none.product_signal, 'benefits'));
  } finally {
    unstubAssemble();
  }

  try {
    process.env.DIRECTOR_PRODUCT_BENEFITS = 'false';
    stubAssemble({
      product: {
        title: 'Test Tee',
        shortBenefits: ['Should not appear'],
      },
    });
    const off = await director.assembleSignals({
      brandId: '000000000000000000000001',
      productId: '000000000000000000000002',
      campaignKind: 'product',
      seededUniverse: [],
    });
    check('A6 flag-off OMITS the product_signal.benefits key (not [])',
      !Object.prototype.hasOwnProperty.call(off.product_signal, 'benefits'),
      `keys=${Object.keys(off.product_signal)}`);
  } finally {
    unstubAssemble();
  }

  try {
    // CLAUDE.md §4: a truthy check would let the string "false" enable it.
    process.env.DIRECTOR_PRODUCT_BENEFITS = 'false';
    check('A7 parser is strictly === "true" — the string "false" is OFF',
      director.directorProductBenefitsEnabled() === false);
    process.env.DIRECTOR_PRODUCT_BENEFITS = 'true';
    check('A8 parser accepts the literal "true"',
      director.directorProductBenefitsEnabled() === true);
    process.env.DIRECTOR_PRODUCT_BENEFITS = 'TRUE';
    check('A9 parser does NOT toLowerCase — "TRUE" is OFF (strict === "true")',
      director.directorProductBenefitsEnabled() === false);
    delete process.env.DIRECTOR_PRODUCT_BENEFITS;
    check('A10 unset is OFF (file default is what a real boot loads)',
      director.directorProductBenefitsEnabled() === false);
  } finally {
    restoreEnv();
    process.env.DIRECTOR_PROOF_MENU_ENABLED = 'false';
  }

  try {
    process.env.DIRECTOR_PRODUCT_BENEFITS = 'true';
    const three = ['Alpha', 'Beta', 'Gamma'];
    stubAssemble({
      product: { title: 'Test Tee', shortBenefits: three },
    });
    const got = await director.assembleSignals({
      brandId: '000000000000000000000001',
      productId: '000000000000000000000002',
      campaignKind: 'product',
      seededUniverse: [],
    });
    check('A11 all 3 items present when 3 exist',
      JSON.stringify(got.product_signal.benefits) === JSON.stringify(three),
      JSON.stringify(got.product_signal.benefits));
  } finally {
    unstubAssemble();
  }

  // Direct helper: catalog field first, artifact fallback. Never derives.
  try {
    process.env.DIRECTOR_PRODUCT_BENEFITS = 'true';
    CatalogProduct.findById = () => query({ shortBenefits: ['A', 'B', 'C', 'D'] });
    LayoutInputArtifact.findOne = () => query({
      input: { product: { short_benefits: ['ignored-artifact'] } },
    });
    const list = await helper.loadProductBenefits('000000000000000000000002');
    check('A12 loadProductBenefits prefers CatalogProduct.shortBenefits',
      list.length === 4 && list[0] === 'A',
      JSON.stringify(list));
    CatalogProduct.findById = () => query({ shortBenefits: [] });
    const fallback = await helper.loadProductBenefits('000000000000000000000002');
    check('A12b empty catalog falls back to the layoutInput artifact',
      fallback.length === 1 && fallback[0] === 'ignored-artifact',
      JSON.stringify(fallback));
    CatalogProduct.findById = () => query(null);
    LayoutInputArtifact.findOne = () => query(null);
    const empty = await helper.loadProductBenefits('000000000000000000000002');
    check('A13 loadProductBenefits miss → []',
      Array.isArray(empty) && empty.length === 0);
  } finally {
    CatalogProduct.findById = origProductFindById;
    LayoutInputArtifact.findOne = origLiaFindOne;
  }

  // Determinism: assembleSignals is a pure function of the product doc
  // for this field — no artifact, no render history.
  try {
    process.env.DIRECTOR_PRODUCT_BENEFITS = 'true';
    const doc = {
      title: 'Rain Shell',
      shortBenefits: ['Stays dry in a downpour', 'Packs into its own pocket', 'Tape-sealed seams'],
    };
    stubAssemble({ product: doc });
    const first = await director.assembleSignals({
      brandId: '000000000000000000000001',
      productId: '000000000000000000000002',
      campaignKind: 'product',
      seededUniverse: [],
    });
    const second = await director.assembleSignals({
      brandId: '000000000000000000000001',
      productId: '000000000000000000000002',
      campaignKind: 'product',
      seededUniverse: [],
    });
    check('A14 same product doc → identical benefits on two assembleSignals calls',
      JSON.stringify(first.product_signal.benefits) === JSON.stringify(second.product_signal.benefits) &&
        JSON.stringify(first.product_signal.benefits) === JSON.stringify(doc.shortBenefits));
  } finally {
    unstubAssemble();
  }

  try {
    process.env.DIRECTOR_PRODUCT_BENEFITS = 'true';
    stubAssemble({
      product: { title: 'Hollow SKU', shortBenefits: [], shortBenefitsDerivedAt: new Date() },
    });
    const emptyDerived = await director.assembleSignals({
      brandId: '000000000000000000000001',
      productId: '000000000000000000000002',
      campaignKind: 'product',
      seededUniverse: [],
    });
    check('A15 empty array (derived, genuinely nothing) stays [] not omitted',
      Array.isArray(emptyDerived.product_signal.benefits) &&
        emptyDerived.product_signal.benefits.length === 0 &&
        Object.prototype.hasOwnProperty.call(emptyDerived.product_signal, 'benefits'));
  } finally {
    unstubAssemble();
  }
}

function derivationWriterHits(src) {
  const code = stripCommentsAndStrings(src);
  const hits = [];
  if (/\bbuildLayoutInput\b/.test(code)) hits.push('buildLayoutInput');
  if (/\bfetchAndCache\b/.test(code)) hits.push('fetchAndCache');
  if (/\brunDerivation\b/.test(code)) hits.push('runDerivation');
  if (/\blayoutInputService\b/.test(code)) hits.push('layoutInputService');
  if (/\bchatCompletion\b/.test(code)) hits.push('chatCompletion');
  if (/\btrackedGenerate\b/.test(code)) hits.push('trackedGenerate');
  if (/\bcategoryReviewsService\b/.test(code)) hits.push('categoryReviewsService');
  return hits;
}

function runStructural() {
  const directorSrc = fs.readFileSync(DIRECTOR_PATH, 'utf8');
  const helperSrc = fs.readFileSync(HELPER_PATH, 'utf8');
  const envSrc = fs.readFileSync(DEFAULTS_ENV, 'utf8');

  const assembleSrc = extractFunctionSource(directorSrc, 'assembleSignals');
  check('B0 assembleSignals source located', !!assembleSrc);

  const assembleHits = derivationWriterHits(assembleSrc || '');
  check('B1 assembleSignals contains ZERO derivation writers (the money guard)',
    assembleHits.length === 0,
    `hits=${assembleHits.join(',')}`);

  const loadSrc = extractFunctionSource(helperSrc, 'loadProductBenefits');
  check('B2 loadProductBenefits source located', !!loadSrc);
  const loadHits = derivationWriterHits(loadSrc || '');
  check('B3 loadProductBenefits contains ZERO derivation writers',
    loadHits.length === 0,
    `hits=${loadHits.join(',')}`);

  // Whole helper file — a future edit that requires layoutInputService
  // anywhere in this module is the same money hole.
  const helperHits = derivationWriterHits(helperSrc);
  check('B4 titleSpecContentSample.js contains ZERO derivation writers',
    helperHits.length === 0,
    `hits=${helperHits.join(',')}`);

  check('B5 loadProductBenefits reads CatalogProduct.shortBenefits (not a writer)',
    /CatalogProduct\.findById\(/.test(loadSrc || '') &&
      /shortBenefits/.test(loadSrc || '') &&
      !/\.(create|updateOne|findOneAndUpdate|save|insertMany)\(/.test(stripCommentsAndStrings(loadSrc || '')));
  check('B5b loadProductBenefits may fall back to an artifact findOne (still not a writer)',
    /LayoutInputArtifact\.findOne\(/.test(loadSrc || ''));

  check('B6 assembleSignals only assigns benefits under directorProductBenefitsEnabled()',
    /if \(directorProductBenefitsEnabled\(\)\)/.test(assembleSrc || '') &&
      /productSignal\.benefits =/.test(assembleSrc || ''));

  const assembleCode = stripCommentsAndStrings(assembleSrc || '');
  check('B10 assembleSignals contains ZERO LayoutInputArtifact reads',
    !/LayoutInputArtifact/.test(assembleCode),
    'Part C source is CatalogProduct.shortBenefits, already in memory');
  check('B11 assembleSignals reads product.shortBenefits (catalog field, no extra I/O)',
    /product\?\.shortBenefits/.test(assembleSrc || ''));
  check('B12 assembleSignals does not call loadProductBenefits',
    !/\bloadProductBenefits\b/.test(assembleCode));

  check('B7 DIRECTOR_PRODUCT_BENEFITS=true in defaults.env',
    /^DIRECTOR_PRODUCT_BENEFITS=true$/m.test(envSrc));

  check('B8 DIRECTOR_SIGNALS_VERSION is 3.5.0',
    /const DIRECTOR_SIGNALS_VERSION = '3\.5\.0'/.test(directorSrc));

  check('B9 parser is strictly === \'true\' (no truthy check, no toLowerCase)',
    /process\.env\.DIRECTOR_PRODUCT_BENEFITS === 'true'/.test(directorSrc));

  // ── C. LAYOUT_DERIVATION_MODEL (Addition 2) ──────────────────────────
  const lisSrc = fs.readFileSync(LIS_PATH, 'utf8');
  const lisCode = stripCommentsAndStrings(lisSrc);
  check('C1 layoutInputService does NOT read GEMINI_SEARCH_MODEL',
    !/GEMINI_SEARCH_MODEL/.test(lisCode),
    'sharing GEMINI_SEARCH_MODEL would silently retarget layout derivation');
  check('C2 default is gemini-2.5-pro (zero behaviour change vs the old code default)',
    /LAYOUT_DERIVATION_MODEL \|\| 'gemini-2\.5-pro'/.test(lisSrc));
  check('C3 geminiSearchProvider still owns GEMINI_SEARCH_MODEL (unchanged)',
    /GEMINI_SEARCH_MODEL \|\| 'gemini-2\.5-flash'/.test(
      fs.readFileSync(path.join(ROOT, 'services/providers/geminiSearchProvider.js'), 'utf8')
    ));
  check('C4 defaults.env declares LAYOUT_DERIVATION_MODEL=gemini-2.5-pro',
    /^LAYOUT_DERIVATION_MODEL=gemini-2\.5-pro$/m.test(envSrc));

  // ── RP. revert-prove ─────────────────────────────────────────────────
  {
    let failedAsExpected = false;
    withTempMutation(
      DIRECTOR_PATH,
      '      ? normalizeBenefitList(product?.shortBenefits)',
      '      ? normalizeBenefitList(product?.shortBenefits);\n    await require(\'./layoutInputService\').buildLayoutInput({})',
      (mutSrc) => {
        const fn = extractFunctionSource(mutSrc, 'assembleSignals') || '';
        failedAsExpected = derivationWriterHits(fn).includes('buildLayoutInput');
      }
    );
    check('RP1 [REVERT-PROOF] injecting buildLayoutInput into assembleSignals trips the money guard',
      failedAsExpected);
  }

  {
    let failedAsExpected = false;
    withTempMutation(
      DIRECTOR_PATH,
      '      ? normalizeBenefitList(product?.shortBenefits)',
      '      ? (await LayoutInputArtifact.findOne({ productId }).lean() && normalizeBenefitList(product?.shortBenefits))',
      (mutSrc) => {
        const fn = extractFunctionSource(mutSrc, 'assembleSignals') || '';
        failedAsExpected = /LayoutInputArtifact/.test(stripCommentsAndStrings(fn));
      }
    );
    check('RP1b [REVERT-PROOF] injecting LayoutInputArtifact.findOne into assembleSignals fails B10',
      failedAsExpected);
  }

  {
    let failedAsExpected = false;
    withTempMutation(
      LIS_PATH,
      "const GEMINI_MODEL = process.env.LAYOUT_DERIVATION_MODEL || 'gemini-2.5-pro';",
      "const GEMINI_MODEL = process.env.GEMINI_SEARCH_MODEL || 'gemini-2.5-pro';",
      (mutSrc) => {
        failedAsExpected = /GEMINI_SEARCH_MODEL/.test(stripCommentsAndStrings(mutSrc));
      }
    );
    check('RP2 [REVERT-PROOF] restoring GEMINI_SEARCH_MODEL in layoutInputService fails C1',
      failedAsExpected);
  }

  {
    let failedAsExpected = false;
    withTempMutation(
      LIS_PATH,
      "const GEMINI_MODEL = process.env.LAYOUT_DERIVATION_MODEL || 'gemini-2.5-pro';",
      "const GEMINI_MODEL = process.env.LAYOUT_DERIVATION_MODEL || 'gemini-2.5-flash';",
      (mutSrc) => {
        failedAsExpected = !/LAYOUT_DERIVATION_MODEL \|\| 'gemini-2\.5-pro'/.test(mutSrc);
      }
    );
    check('RP3 [REVERT-PROOF] flipping the layout default to flash fails C2',
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
    unstubAssemble();
    restoreEnv();
  }

  if (failures.length) {
    console.error(`\n❌ director benefits: ${failures.length} FAILED, ${pass} passed\n`);
    failures.forEach((f) => console.error(`   • ${f}`));
    process.exit(1);
  }
  console.log(`✅ director benefits: ${pass} checks passed`);
})();
