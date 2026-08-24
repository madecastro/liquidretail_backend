#!/usr/bin/env node
'use strict';
//
// verifyQuoteColourway — do not print a customer quote whose colour
// language we cannot verify against the product.
//
// DEFECT (measured 2026-08-24, Soludos run_1787576848754_994b722b):
// product title "Women's Roma Retro Sneaker | White - Wine" with a
// testimonial describing a GREEN accent, printed over a burgundy shoe.
// Vision QC failed, the ads regenerated, failed again — two gpt-image-2
// submits (~$0.14) and nothing shipped. Two of nine statics in one run.
//
// THE GATE is usableColourwayQuote in services/quoteColourway.js — a
// sibling of usableAttribution / toPrintableCustomerQuote, not inside
// them. Colour-free quotes are a no-op. Colourway-matching quotes are
// a no-op. Unparseable colourway + colour language fails CLOSED.
//
// Offline: no DB, no network, no API key.
//   node scripts/verifyQuoteColourway.js
//
// Revert-prove (each mutation must fail this harness — section R runs
// them as sibling copies, it does not edit the tree):
//   R1  usableColourwayQuote always returns quote            → A measured KEEP
//   R2  maskIdioms is identity                               → A blue-chip DROP
//   R3  unparseable colourway returns quote                  → A unparseable KEEP
//   R4  static site skips applyQuoteColourway                → B measured KEEP
//   R5  video site skips applyQuoteColourway                 → C measured KEEP

const fs = require('fs');
const path = require('path');
const Module = require('module');

function ensureHttpsProxyAgent() {
  try {
    require.resolve('https-proxy-agent');
    return 'present';
  } catch { /* fall through */ }
  const orig = Module._load;
  Module._load = function loadStub(request, parent, isMain) {
    if (request === 'https-proxy-agent') {
      return function HttpsProxyAgent() { return {}; };
    }
    return orig.apply(this, arguments);
  };
  return 'stub';
}
ensureHttpsProxyAgent();

// Isolate from QUOTE_PROVENANCE_STRICT noun-scope (default on). This
// harness pins COLOURWAY, not garment-noun matching.
process.env.QUOTE_PROVENANCE_STRICT = 'false';

const {
  usableColourwayQuote,
  applyQuoteColourway,
  colourFamiliesIn,
  productColourwayFromTitle
} = require('../services/quoteColourway');
const { toPrintableCustomerQuote } = require('../services/quoteProvenance');
const { prepareQuotePool, pickPrimaryProductQuote } = require('../services/layoutInputService');
const direct = require('../services/directImageRenderService');
const { gateLayoutInputQuotes } = require('../services/brandScriptExecutor');

const ROOT = path.join(__dirname, '..');
const SRC_QC = path.join(ROOT, 'services', 'quoteColourway.js');
const SRC_STATIC = path.join(ROOT, 'services', 'directImageRenderService.js');
const SRC_VIDEO = path.join(ROOT, 'services', 'brandScriptExecutor.js');
const SRC_ROT = path.join(ROOT, 'services', 'quoteRotationService.js');
const SRC_LIS = path.join(ROOT, 'services', 'layoutInputService.js');
const SRC_DIR = path.join(ROOT, 'services', 'aiCreativeDirectorService.js');

function stripComments(src) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (quote) {
      if (c === '\\') { out += c + (n || ''); i += 2; continue; }
      if (c === quote) quote = null;
      out += c; i++; continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && n === '*') {
      out += '  '; i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += '  '; i += 2; continue;
    }
    out += c; i++;
  }
  return out;
}

const qcSrc = fs.readFileSync(SRC_QC, 'utf8');
const staticSrc = fs.readFileSync(SRC_STATIC, 'utf8');
const videoSrc = fs.readFileSync(SRC_VIDEO, 'utf8');
const rotSrc = fs.readFileSync(SRC_ROT, 'utf8');
const lisSrc = fs.readFileSync(SRC_LIS, 'utf8');
const dirSrc = fs.readFileSync(SRC_DIR, 'utf8');
const qcCode = stripComments(qcSrc);
const staticCode = stripComments(staticSrc);
const videoCode = stripComments(videoSrc);
const rotCode = stripComments(rotSrc);
const lisCode = stripComments(lisSrc);
const dirCode = stripComments(dirSrc);

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const realLog = console.log;
const realWarn = console.warn;
console.log = () => {};
console.warn = () => {};

const SOLUDOS_TITLE = "Women's Roma Retro Sneaker | White - Wine";
const GREEN_TEXT = 'Love the green accent on the heel — it makes the whole shoe.';
const NONE_TEXT = 'The quality is amazing and they fit true to size.';
const MATCH_TEXT = 'The burgundy heel tab is perfect with the white upper.';
const WINE_TEXT = 'The wine-colored heel tab is gorgeous.';
const BLUECHIP_TEXT = 'blue-chip quality from day one of wearing them.';
const ROSE_TEXT = 'it rose to the occasion on race day and never blistered.';
const BLACK_TEXT = 'we have been in the black since switching to these.';

function q(text, extra) {
  return {
    text,
    origin: 'scraped',
    verbatim: true,
    author_name: 'Jamie L.',
    ...(extra || {})
  };
}

function kept(quote, product) {
  return usableColourwayQuote(quote, product) != null;
}

// ── A. Behavioural: drive the REAL exported helper ────────────────────
check('A0 usableColourwayQuote is a function', typeof usableColourwayQuote === 'function');
check('A0 applyQuoteColourway is a function', typeof applyQuoteColourway === 'function');
check('A0 colourFamiliesIn is a function', typeof colourFamiliesIn === 'function');
check('A0 productColourwayFromTitle is a function', typeof productColourwayFromTitle === 'function');

check('A measured: Soludos title parses to white + wine', (() => {
  const way = productColourwayFromTitle(SOLUDOS_TITLE);
  return way && way.has('white') && way.has('wine') && way.size === 2;
})());

check('A measured: green-accent quote names green',
  colourFamiliesIn(GREEN_TEXT).includes('green')
  && colourFamiliesIn(GREEN_TEXT).length === 1);

check('A measured: green accent on White-Wine is REJECTED',
  kept(q(GREEN_TEXT), SOLUDOS_TITLE) === false);

check('A no-op: colour-free quote on White-Wine is KEPT',
  kept(q(NONE_TEXT), SOLUDOS_TITLE) === true);

check('A match: burgundy (wine synonym) on White-Wine is KEPT',
  kept(q(MATCH_TEXT), SOLUDOS_TITLE) === true);

check('A match: wine-colored on White-Wine is KEPT',
  kept(q(WINE_TEXT), SOLUDOS_TITLE) === true);

check('A match: white + wine combo on White-Wine is KEPT',
  kept(q('the white and wine combo is perfect'), SOLUDOS_TITLE) === true);

check('A fail-closed: colour language + unparseable title is REJECTED',
  kept(q(GREEN_TEXT), 'Roma Retro Sneaker') === false);

check('A fail-closed: colour-free quote + unparseable title is KEPT',
  kept(q(NONE_TEXT), 'Roma Retro Sneaker') === true);

check('A fail-closed: colour language + empty title is REJECTED',
  kept(q(GREEN_TEXT), '') === false);

check('A fail-closed: colour language + {title:""} is REJECTED',
  kept(q(GREEN_TEXT), { title: '' }) === false);

check('A no-product: colour language with null product is KEPT (brand/media ads)',
  kept(q(GREEN_TEXT), null) === true);

check('A no-product: colour language with undefined product is KEPT',
  kept(q(GREEN_TEXT), undefined) === true);

check('A conflict: navy on White-Wine is REJECTED',
  kept(q('the navy laces are my favourite part'), SOLUDOS_TITLE) === false);

check('A conflict: greenish on White-Wine is REJECTED',
  kept(q('greenish accent on the side'), SOLUDOS_TITLE) === false);

check('A pipe-suffix: Pink Floyd Tee | Black colourway is black only, not pink', (() => {
  const way = productColourwayFromTitle('Pink Floyd Graphic Tee | Black');
  return way && way.has('black') && !way.has('pink') && way.size === 1;
})());

// Ordinary-word trap — MUST KEEP. A colour WORD used as a non-colour.
check('A idiom MUST-KEEP: blue-chip quality',
  kept(q(BLUECHIP_TEXT), SOLUDOS_TITLE) === true
  && colourFamiliesIn(BLUECHIP_TEXT).length === 0);

check('A idiom MUST-KEEP: rose to the occasion',
  kept(q(ROSE_TEXT), SOLUDOS_TITLE) === true
  && colourFamiliesIn(ROSE_TEXT).length === 0);

check('A idiom MUST-KEEP: in the black',
  kept(q(BLACK_TEXT), SOLUDOS_TITLE) === true
  && colourFamiliesIn(BLACK_TEXT).length === 0);

check('A never throws on object-as-quote-without-text',
  usableColourwayQuote({ origin: 'scraped' }, SOLUDOS_TITLE) != null
  || usableColourwayQuote({ origin: 'scraped' }, SOLUDOS_TITLE) === null);

check('A never throws on null quote', usableColourwayQuote(null, SOLUDOS_TITLE) === null);

{
  const quote = q(GREEN_TEXT);
  check('A applyQuoteColourway no-ops without productTitle on scope',
    applyQuoteColourway(quote, {}) === quote);
}

{
  const quote = q(GREEN_TEXT);
  const out = applyQuoteColourway(quote, { productTitle: SOLUDOS_TITLE });
  check('A applyQuoteColourway rejects measured case via scope.productTitle', out === null);
}

{
  const quote = q(NONE_TEXT);
  const out = applyQuoteColourway(quote, { productTitle: SOLUDOS_TITLE });
  check('A applyQuoteColourway keeps colour-free via scope.productTitle',
    out && out.text === NONE_TEXT);
}

// Printability is a SIBLING. The green quote is still a printable
// customer quote — colourway is a later, separate refusal.
{
  const printable = toPrintableCustomerQuote(q(GREEN_TEXT));
  check('A toPrintable still ADMITS the measured green quote (colour is not folded in)',
    !!(printable && printable.text === GREEN_TEXT));
}

// ── B. Static path: drive the REAL buildIntentData ────────────────────
function intentFor(text, product, extraProof) {
  return direct.buildIntentData({
    concept: { copy_picks: { headline: 'Made to be worn' } },
    layoutInput: {
      social_proof: {
        primary_quote: q(text),
        ...(extraProof || {})
      }
    },
    brand: {},
    product: product || null,
    cta: 'SHOP NOW'
  });
}

{
  const d = intentFor(GREEN_TEXT, { title: SOLUDOS_TITLE });
  check('B static measured: green accent on White-Wine does not print',
    d.quote == null || d.quote === undefined,
    `got ${JSON.stringify(d.quote)}`);
}

{
  const d = intentFor(NONE_TEXT, { title: SOLUDOS_TITLE });
  check('B static no-op: colour-free quote still prints',
    d.quote === NONE_TEXT, `got ${JSON.stringify(d.quote)}`);
}

{
  const d = intentFor(MATCH_TEXT, { title: SOLUDOS_TITLE });
  check('B static match: burgundy on White-Wine still prints',
    d.quote === MATCH_TEXT, `got ${JSON.stringify(d.quote)}`);
}

{
  const d = intentFor(GREEN_TEXT, { title: 'Roma Retro Sneaker' });
  check('B static fail-closed: unparseable title drops colour quote',
    d.quote == null || d.quote === undefined,
    `got ${JSON.stringify(d.quote)}`);
}

{
  const d = intentFor(GREEN_TEXT, null);
  check('B static no-product: colour quote still prints (no-op)',
    d.quote === GREEN_TEXT, `got ${JSON.stringify(d.quote)}`);
}

{
  const d = intentFor(BLUECHIP_TEXT, { title: SOLUDOS_TITLE });
  check('B static idiom MUST-KEEP: blue-chip still prints',
    d.quote === BLUECHIP_TEXT, `got ${JSON.stringify(d.quote)}`);
}

{
  const d = intentFor(ROSE_TEXT, { title: SOLUDOS_TITLE });
  check('B static idiom MUST-KEEP: rose to the occasion still prints',
    d.quote === ROSE_TEXT, `got ${JSON.stringify(d.quote)}`);
}

{
  const d = intentFor(GREEN_TEXT, { title: SOLUDOS_TITLE }, {
    secondary_quotes: [q(NONE_TEXT, { tier: null })]
  });
  check('B static rescue: colour-free secondary prints when primary is green',
    d.quote === NONE_TEXT, `got ${JSON.stringify(d.quote)}`);
}

// ── C. Video path: drive the REAL gateLayoutInputQuotes ───────────────
function videoArtifact(text, extra) {
  return {
    input: {
      social_proof: {
        primary_quote: q(text),
        ...(extra || {})
      },
      product: {}
    }
  };
}

{
  const gated = gateLayoutInputQuotes(
    videoArtifact(GREEN_TEXT),
    { productTitle: SOLUDOS_TITLE }
  );
  check('C video measured: green accent on White-Wine is withheld',
    gated.input.social_proof.primary_quote == null);
}

{
  const gated = gateLayoutInputQuotes(
    videoArtifact(NONE_TEXT),
    { productTitle: SOLUDOS_TITLE }
  );
  check('C video no-op: colour-free quote is reseated, not dropped',
    gated.input.social_proof.primary_quote
    && gated.input.social_proof.primary_quote.text === NONE_TEXT);
}

{
  const gated = gateLayoutInputQuotes(
    videoArtifact(MATCH_TEXT),
    { productTitle: SOLUDOS_TITLE }
  );
  check('C video match: burgundy on White-Wine is kept',
    gated.input.social_proof.primary_quote
    && gated.input.social_proof.primary_quote.text === MATCH_TEXT);
}

{
  const gated = gateLayoutInputQuotes(
    videoArtifact(GREEN_TEXT),
    { productTitle: 'Roma Retro Sneaker' }
  );
  check('C video fail-closed: unparseable title withholds colour quote',
    gated.input.social_proof.primary_quote == null);
}

{
  const gated = gateLayoutInputQuotes(videoArtifact(GREEN_TEXT), {});
  check('C video no-product: colour quote is a no-op KEEP',
    gated.input.social_proof.primary_quote
    && gated.input.social_proof.primary_quote.text === GREEN_TEXT);
}

{
  const gated = gateLayoutInputQuotes(
    videoArtifact(GREEN_TEXT, { secondary_quotes: [q(NONE_TEXT)] }),
    { productTitle: SOLUDOS_TITLE }
  );
  check('C video rescue: colour-free secondary reseated when primary is green',
    gated.input.social_proof.primary_quote
    && gated.input.social_proof.primary_quote.text === NONE_TEXT);
}

// ── D. Pool assembly: prepareQuotePool / pickPrimaryProductQuote ──────
{
  const container = {
    source: 'store-import',
    quotes: [q(GREEN_TEXT), q(NONE_TEXT), q(MATCH_TEXT)]
  };
  const unfiltered = prepareQuotePool(container, container.quotes, 'product');
  check('D 3-arg prepareQuotePool is a colour no-op (existing callers)',
    unfiltered.length === 3,
    `got ${unfiltered.length}`);

  const filtered = prepareQuotePool(container, container.quotes, 'product', SOLUDOS_TITLE);
  const texts = filtered.map((x) => x.text);
  check('D 4-arg prepareQuotePool drops green, keeps none + burgundy',
    texts.includes(NONE_TEXT)
    && texts.includes(MATCH_TEXT)
    && !texts.includes(GREEN_TEXT),
    `got ${JSON.stringify(texts)}`);

  const picked = pickPrimaryProductQuote(container, { productTitle: SOLUDOS_TITLE });
  check('D pickPrimaryProductQuote with productTitle does not return green',
    picked && picked.text !== GREEN_TEXT, `got ${JSON.stringify(picked && picked.text)}`);
}

// ── D2. Director flag-off (the shipped default) also colour-filters ──
{
  process.env.DIRECTOR_QUOTE_POOL_ALIGNED = 'false';
  delete require.cache[require.resolve('../services/aiCreativeDirectorService')];
  const dir = require('../services/aiCreativeDirectorService');
  const product = {
    title: SOLUDOS_TITLE,
    reviews: [
      { text: GREEN_TEXT, author: 'Green' },
      { text: NONE_TEXT, author: 'None' }
    ]
  };
  const picked = dir.pickDirectorPrimaryQuote(product);
  check('D2 Director flag-off skips green arrival review when title is present',
    picked && picked.text === NONE_TEXT, `got ${JSON.stringify(picked && picked.text)}`);
  const pool = dir.productQuotesForDirector(product);
  check('D2 Director flag-off pool drops green, keeps colour-free',
    pool.every((x) => x.text !== GREEN_TEXT) && pool.some((x) => x.text === NONE_TEXT),
    `got ${JSON.stringify(pool.map((x) => x.text))}`);
  const noTitle = dir.pickDirectorPrimaryQuote({
    reviews: [{ text: GREEN_TEXT, author: 'Green' }]
  });
  check('D2 Director flag-off without title is still a colour no-op (existing D1)',
    noTitle && noTitle.text === GREEN_TEXT, `got ${JSON.stringify(noTitle && noTitle.text)}`);
}

// ── E. Call sites IMPORT the helper (processAlerts class) ─────────────
function importsApplyQuoteColourway(code) {
  return /require\s*\(\s*['"]\.\/quoteColourway['"]\s*\)/.test(code)
    && /\bapplyQuoteColourway\b/.test(code);
}

check('E static imports applyQuoteColourway from ./quoteColourway',
  importsApplyQuoteColourway(staticCode));
check('E video imports applyQuoteColourway from ./quoteColourway',
  importsApplyQuoteColourway(videoCode));
check('E rotation requires quoteColourway and calls applyQuoteColourway',
  /require\s*\(\s*['"]\.\/quoteColourway['"]\s*\)/.test(rotCode)
  && /applyQuoteColourway\s*\(/.test(rotCode));
check('E layoutInputService requires usableColourwayQuote',
  /require\s*\(\s*['"]\.\/quoteColourway['"]\s*\)/.test(lisCode)
  && /usableColourwayQuote\s*\(/.test(lisCode));
check('E Director threads product.title into pickPrimaryProductQuote',
  /productTitle\s*:\s*product\?\.title/.test(dirCode));
check('E Director threads product.title into prepareQuotePool',
  /prepareQuotePool\s*\([\s\S]*?product\?\.title/.test(dirCode)
  || /prepareQuotePool\([\s\S]{0,200}product\?\.title/.test(dirSrc));
check('E Director flag-off arrival path colour-filters via usableColourwayQuote',
  /function colourSafeArrivalReviews/.test(dirCode)
  && /usableColourwayQuote/.test(dirCode));

check('E static does not reimplement usableColourwayQuote',
  !/function\s+usableColourwayQuote\s*\(/.test(staticCode));
check('E video does not reimplement usableColourwayQuote',
  !/function\s+usableColourwayQuote\s*\(/.test(videoCode));

check('E static colour assignment calls applyQuoteColourway(quote, strictScope)',
  /const\s+colourOk\s*=\s*applyQuoteColourway\s*\(\s*quote\s*,\s*strictScope\s*\)/.test(staticCode),
  'buildIntentData must wrap the post-strict quote; a prefix-only regex would stay green on a later identity fallback');

check('E video colour assignment calls applyQuoteColourway(printable, scope)',
  /const\s+colourOk\s*=\s*applyQuoteColourway\s*\(\s*printable\s*,\s*scope\s*\)/.test(videoCode));

check('E helper is defined once in quoteColourway.js',
  (qcCode.match(/function\s+usableColourwayQuote\s*\(/g) || []).length === 1);

check('E toPrintableCustomerQuote does not call usableColourwayQuote',
  !/\busableColourwayQuote\s*\(/.test(stripComments(
    require('fs').readFileSync(path.join(ROOT, 'services', 'quoteProvenance.js'), 'utf8')
  )));

// Fail-closed is load-bearing: unparseable colourway + named colour → null.
check('E unparseable path returns null (not the quote)',
  /if\s*\(\s*!way\s*\|\|\s*way\.size\s*===\s*0\s*\)\s*return\s*null/.test(qcCode));

// ── R. Revert-prove via sibling copies (does not edit the tree) ───────
function mutateOrThrow(src, from, to, label) {
  const mutated = src.replace(from, to);
  if (mutated === src) {
    throw new Error(`revert-prove mutation ${label} was a no-op — pattern missed the real source`);
  }
  return mutated;
}

function withMutatedSibling(realAbsPath, mutatedSrc, fn) {
  const dir = path.dirname(realAbsPath);
  const base = path.basename(realAbsPath, '.js');
  const tmpAbsPath = path.join(
    dir,
    `.__revertprove_${base}_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}.js`
  );
  fs.writeFileSync(tmpAbsPath, mutatedSrc);
  try {
    delete require.cache[tmpAbsPath];
    const mod = require(tmpAbsPath);
    return fn(mod, tmpAbsPath);
  } finally {
    try { fs.unlinkSync(tmpAbsPath); } catch { /* best effort */ }
    delete require.cache[tmpAbsPath];
  }
}

{
  // R1: identity helper → measured green is KEPT. If this mutation does
  // not flip A, the A check is not actually calling the helper.
  const mutated = mutateOrThrow(
    qcSrc,
    'return named.every((f) => way.has(f)) ? quote : null;',
    'return quote;',
    'R1'
  );
  withMutatedSibling(SRC_QC, mutated, (mod) => {
    const got = mod.usableColourwayQuote(q(GREEN_TEXT), SOLUDOS_TITLE);
    check('R1 identity helper KEPT the measured green quote (A would go red)',
      got != null && got.text === GREEN_TEXT,
      `got ${JSON.stringify(got && got.text)}`);
  });
}

{
  // R2: skip idiom mask → blue-chip names blue → REJECT. Pins that the
  // MUST-KEEP is the mask, not a hole in the lexicon.
  const mutated = mutateOrThrow(
    qcSrc,
    'function maskIdioms(src) {\n  return String(src).replace(IDIOM_RE, (m) => \' \'.repeat(m.length));\n}',
    'function maskIdioms(src) {\n  return String(src);\n}',
    'R2'
  );
  withMutatedSibling(SRC_QC, mutated, (mod) => {
    // blue-chip is ALSO caught by isHyphenatedNonColour, so the mask
    // itself is pinned on a space-separated idiom: "rose to the occasion".
    const got = mod.usableColourwayQuote(q(ROSE_TEXT), SOLUDOS_TITLE);
    check('R2 unmasked idioms REJECT "rose to the occasion" on White-Wine (A MUST-KEEP would go red)',
      got == null,
      `got ${JSON.stringify(got && got.text)}`);
  });
}

{
  // R3: unparseable returns the quote → fail-closed becomes fail-open.
  const mutated = mutateOrThrow(
    qcSrc,
    'if (!way || way.size === 0) return null;',
    'if (!way || way.size === 0) return quote;',
    'R3'
  );
  withMutatedSibling(SRC_QC, mutated, (mod) => {
    const got = mod.usableColourwayQuote(q(GREEN_TEXT), 'Roma Retro Sneaker');
    check('R3 unparseable-keep mutation KEPT the green quote (A fail-closed would go red)',
      got != null && got.text === GREEN_TEXT,
      `got ${JSON.stringify(got && got.text)}`);
  });
}

{
  // R4: static site skips the colour call → measured green PRINTS.
  const mutated = mutateOrThrow(
    staticSrc,
    'const colourOk = applyQuoteColourway(quote, strictScope);',
    'const colourOk = quote;',
    'R4'
  );
  withMutatedSibling(SRC_STATIC, mutated, (mod) => {
    const d = mod.buildIntentData({
      concept: { copy_picks: { headline: 'Made to be worn' } },
      layoutInput: { social_proof: { primary_quote: q(GREEN_TEXT) } },
      brand: {},
      product: { title: SOLUDOS_TITLE },
      cta: 'SHOP NOW'
    });
    check('R4 unwired static PRINTS the measured green quote (B would go red)',
      d.quote === GREEN_TEXT,
      `got ${JSON.stringify(d.quote)}`);
  });
}

{
  // R5: video site skips the colour call → measured green is reseated.
  const mutated = mutateOrThrow(
    videoSrc,
    'const colourOk = applyQuoteColourway(printable, scope);',
    'const colourOk = printable;',
    'R5'
  );
  withMutatedSibling(SRC_VIDEO, mutated, (mod) => {
    const gated = mod.gateLayoutInputQuotes(
      videoArtifact(GREEN_TEXT),
      { productTitle: SOLUDOS_TITLE }
    );
    const pq = gated.input.social_proof.primary_quote;
    check('R5 unwired video KEEPS the measured green quote (C would go red)',
      pq && pq.text === GREEN_TEXT,
      `got ${JSON.stringify(pq && pq.text)}`);
  });
}

console.log = realLog;
console.warn = realWarn;

if (failures.length) {
  console.error(`\n❌ verifyQuoteColourway: ${failures.length} FAILED, ${pass} passed\n`);
  failures.forEach((f) => console.error(`   • ${f}`));
  process.exit(1);
}
console.log(`✅ verifyQuoteColourway: ${pass} checks passed`);
console.log('   helper + static + video + Director driven for real; revert-proven on 5 mutations');
