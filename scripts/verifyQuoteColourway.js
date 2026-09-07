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
// REMOVED (dormant render fallback deletion): group B (static
// `buildIntentData` integration), the E-static source pins against
// `services/directImageRenderService.js`, and R4 (unwiring that deleted
// static call site). Those lived only on the mint-time static render
// entry point, which is gone; adgen owns static rendering unconditionally
// now. Surviving coverage is `usableColourwayQuote` /
// `toPrintableCustomerQuote` plus the VIDEO path (`gateLayoutInputQuotes`),
// layout pool, Director, and quoteRotationService.
//
// Revert-prove (each mutation must fail this harness — section R runs
// them as sibling copies, it does not edit the tree):
//   R1  usableColourwayQuote always returns quote            → A measured KEEP
//   R2  maskIdioms is identity                               → A idiom KEEP
//   R3  unparseable colourway returns quote                  → A unparseable KEEP
//   R5  video site skips applyQuoteColourway                 → C measured KEEP
//   R6  dash parse last-segment-only                         → M white-sole display KEEP
//   R7  hyphenated adj tails skipped again                   → M green-accented DROP
//   R8  mint collocate removed                               → M mint-condition KEEP
//   R9  productAttached===false no longer short-circuits     → A brand/media KEEP

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
const { displayNormalizeTitle } = require('../utils/titleNormalize');
const { gateLayoutInputQuotes } = require('../services/brandScriptExecutor');

const ROOT = path.join(__dirname, '..');
const SRC_QC = path.join(ROOT, 'services', 'quoteColourway.js');
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
const videoSrc = fs.readFileSync(SRC_VIDEO, 'utf8');
const rotSrc = fs.readFileSync(SRC_ROT, 'utf8');
const lisSrc = fs.readFileSync(SRC_LIS, 'utf8');
const dirSrc = fs.readFileSync(SRC_DIR, 'utf8');
const qcCode = stripComments(qcSrc);
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
const SOLUDOS_DISPLAY = displayNormalizeTitle(SOLUDOS_TITLE);
const GREEN_TEXT = 'Love the green accent on the heel — it makes the whole shoe.';
const GREEN_HYPHEN_TEXT = 'Love the green-accented heel — it makes the whole shoe.';
const GREEN_ONES_TEXT = 'the green ones are lovely';
const NONE_TEXT = 'The quality is amazing and they fit true to size.';
const MATCH_TEXT = 'The burgundy heel tab is perfect with the white upper.';
const WINE_TEXT = 'The wine-colored heel tab is gorgeous.';
const WINE_ACCENT_TEXT = 'The wine accent is gorgeous.';
const WHITE_SOLE_TEXT = 'the white sole is perfect';
const COMFORT_TEXT = 'So comfortable for long walks';
const BLUECHIP_TEXT = 'blue-chip quality from day one of wearing them.';
const ROSE_TEXT = 'it rose to the occasion on race day and never blistered.';
const BLACK_TEXT = 'we have been in the black since switching to these.';
const MINT_TEXT = 'Arrived in mint condition and ready to wear.';
const GOLDEN_TEXT = 'a golden opportunity to upgrade my rotation.';
const SILVER_TEXT = 'every cloud has a silver lining with these.';
const GREENLIGHT_TEXT = 'they gave me the green light to run the race.';
const WHITELIE_TEXT = 'not a white lie, they really last all day.';
const GREYAREA_TEXT = 'sizing is a grey area for me but these fit.';
const REDHANDED_TEXT = 'caught red-handed snacking in them.';

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

function wayKey(title) {
  const way = productColourwayFromTitle(title);
  if (!way) return null;
  return [...way].sort().join(',');
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

// ── M. Fixture matrix — REAL exported predicate, both title forms ────
// Defect 1: display-normalize flattens `|` to ` - `; last-dash-only
// parse kept Wine and dropped White, so "white sole" was a silent
// false rejection. Both forms must yield the same colourway AND the
// same verdict.
check('M display-normalize flattens pipe to dash (the form paint used to pass)',
  SOLUDOS_DISPLAY === "Women's Roma Retro Sneaker - White - Wine",
  `got ${JSON.stringify(SOLUDOS_DISPLAY)}`);

check('M both title forms parse to white+wine (same set)',
  wayKey(SOLUDOS_TITLE) === 'white,wine'
  && wayKey(SOLUDOS_DISPLAY) === 'white,wine',
  `raw=${wayKey(SOLUDOS_TITLE)} display=${wayKey(SOLUDOS_DISPLAY)}`);

function sameVerdict(text) {
  return kept(q(text), SOLUDOS_TITLE) === kept(q(text), SOLUDOS_DISPLAY);
}

// MUST DROP
check('M DROP: green accent on White-Wine (raw AND display)',
  kept(q(GREEN_TEXT), SOLUDOS_TITLE) === false
  && kept(q(GREEN_TEXT), SOLUDOS_DISPLAY) === false
  && sameVerdict(GREEN_TEXT));

check('M DROP: green-accented on White-Wine (raw AND display)',
  kept(q(GREEN_HYPHEN_TEXT), SOLUDOS_TITLE) === false
  && kept(q(GREEN_HYPHEN_TEXT), SOLUDOS_DISPLAY) === false
  && colourFamiliesIn(GREEN_HYPHEN_TEXT).includes('green')
  && sameVerdict(GREEN_HYPHEN_TEXT));

check('M DROP: the green ones are lovely on White-Wine (raw AND display)',
  kept(q(GREEN_ONES_TEXT), SOLUDOS_TITLE) === false
  && kept(q(GREEN_ONES_TEXT), SOLUDOS_DISPLAY) === false
  && sameVerdict(GREEN_ONES_TEXT));

// MUST KEEP — matching colour / colour-free
check('M KEEP: wine accent on White-Wine (raw AND display)',
  kept(q(WINE_ACCENT_TEXT), SOLUDOS_TITLE) === true
  && kept(q(WINE_ACCENT_TEXT), SOLUDOS_DISPLAY) === true
  && sameVerdict(WINE_ACCENT_TEXT));

check('M KEEP: white sole on White-Wine (raw AND display) — defect 1 victim',
  kept(q(WHITE_SOLE_TEXT), SOLUDOS_TITLE) === true
  && kept(q(WHITE_SOLE_TEXT), SOLUDOS_DISPLAY) === true
  && sameVerdict(WHITE_SOLE_TEXT));

check('M KEEP: so comfortable on White-Wine (raw AND display)',
  kept(q(COMFORT_TEXT), SOLUDOS_TITLE) === true
  && kept(q(COMFORT_TEXT), SOLUDOS_DISPLAY) === true
  && colourFamiliesIn(COMFORT_TEXT).length === 0
  && sameVerdict(COMFORT_TEXT));

// MUST KEEP — ordinary-word colour senses (collocate shape, not one-offs)
check('M KEEP idiom: mint condition (raw AND display)',
  kept(q(MINT_TEXT), SOLUDOS_TITLE) === true
  && kept(q(MINT_TEXT), SOLUDOS_DISPLAY) === true
  && colourFamiliesIn(MINT_TEXT).length === 0
  && sameVerdict(MINT_TEXT));

check('M KEEP idiom: golden opportunity (raw AND display)',
  kept(q(GOLDEN_TEXT), SOLUDOS_TITLE) === true
  && colourFamiliesIn(GOLDEN_TEXT).length === 0
  && sameVerdict(GOLDEN_TEXT));

check('M KEEP idiom: silver lining (raw AND display)',
  kept(q(SILVER_TEXT), SOLUDOS_TITLE) === true
  && colourFamiliesIn(SILVER_TEXT).length === 0
  && sameVerdict(SILVER_TEXT));

check('M KEEP idiom: green light (raw AND display)',
  kept(q(GREENLIGHT_TEXT), SOLUDOS_TITLE) === true
  && colourFamiliesIn(GREENLIGHT_TEXT).length === 0
  && sameVerdict(GREENLIGHT_TEXT));

check('M KEEP idiom: white lie (raw AND display)',
  kept(q(WHITELIE_TEXT), SOLUDOS_TITLE) === true
  && colourFamiliesIn(WHITELIE_TEXT).length === 0
  && sameVerdict(WHITELIE_TEXT));

check('M KEEP idiom: grey area (raw AND display)',
  kept(q(GREYAREA_TEXT), SOLUDOS_TITLE) === true
  && colourFamiliesIn(GREYAREA_TEXT).length === 0
  && sameVerdict(GREYAREA_TEXT));

check('M KEEP idiom: caught red-handed (raw AND display)',
  kept(q(REDHANDED_TEXT), SOLUDOS_TITLE) === true
  && colourFamiliesIn(REDHANDED_TEXT).length === 0
  && sameVerdict(REDHANDED_TEXT));

check('M dash walk does not steal Pink Floyd from a colour-named product',
  wayKey('Pink Floyd Graphic Tee - Black') === 'black'
  && wayKey('Pink Floyd Graphic Tee | Black') === 'black');

check('M dash walk keeps Heavy Blue and ignores Limited Edition',
  wayKey('Hoodie - Heavy Blue') === 'blue'
  && wayKey('Foo - Limited Edition') === null);

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

{
  const quote = q(GREEN_TEXT);
  check('A brand/media: productAttached false KEEPS colour quote even with unparseable title',
    applyQuoteColourway(quote, {
      productAttached: false,
      productTitle: 'Roma Retro Sneaker'
    }) === quote);
}

{
  const quote = q(GREEN_TEXT);
  check('A product-attached unknown colourway DROPS colour quote',
    applyQuoteColourway(quote, {
      productAttached: true,
      productTitle: 'Roma Retro Sneaker'
    }) === null);
}

{
  const quote = q(GREEN_TEXT);
  check('A product-attached missing title DROPS colour quote',
    applyQuoteColourway(quote, { productAttached: true }) === null);
}

{
  const quote = q(NONE_TEXT);
  check('A product-attached missing title KEEPS colour-free quote',
    applyQuoteColourway(quote, { productAttached: true }) === quote);
}

// Printability is a SIBLING. The green quote is still a printable
// customer quote — colourway is a later, separate refusal.
{
  const printable = toPrintableCustomerQuote(q(GREEN_TEXT));
  check('A toPrintable still ADMITS the measured green quote (colour is not folded in)',
    !!(printable && printable.text === GREEN_TEXT));
}

// Group B (static buildIntentData integration) was removed with
// `renderDirectImage`/`buildIntentData` (dormant render fallback deletion,
// 2026-09-07). The helper assertions above and the VIDEO call-site pins
// below are the remaining coverage.

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
  const gated = gateLayoutInputQuotes(videoArtifact(GREEN_TEXT), {
    productAttached: false,
    productTitle: 'Roma Retro Sneaker'
  });
  check('C video brand/media: colour quote KEEP when not product-attached',
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

check('E video does not reimplement usableColourwayQuote',
  !/function\s+usableColourwayQuote\s*\(/.test(videoCode));

check('E video colour assignment calls applyQuoteColourway(printable, scope)',
  /const\s+colourOk\s*=\s*applyQuoteColourway\s*\(\s*printable\s*,\s*scope\s*\)/.test(videoCode));

check('E video rotation and paint share colourwayTitle (catalog title first)',
  /const\s+colourwayTitle\s*=\s*catalogProduct\?\.title\s*\|\|\s*layoutInput\?\.input\?\.product\?\.name/.test(videoCode)
  && (videoCode.match(/productTitle:\s*colourwayTitle/g) || []).length === 2,
  'both rotateScope and gateLayoutInputQuotes must read the same catalog-first title');

check('E layoutInput colourwayTitle is product-attached only (options.productId)',
  /const colourwayTitle = \(options && options\.productId\)/.test(lisCode)
  || /colourwayTitle = \(options && options\.productId\)/.test(lisSrc),
  'brand/media layout assembly must not fail-closed on ident.productName');

check('E applyQuoteColourway short-circuits productAttached === false',
  /if\s*\(\s*scope\.productAttached\s*===\s*false\s*\)\s*return\s*quote/.test(qcCode));

check('E hyphenated colour adjectives are not skipped as non-colour',
  /COLOUR_ADJ_TAIL_SET\.has\(tail\)/.test(qcCode)
  && /accented/.test(qcSrc));

check('E mint condition is a collocate, not a one-off sentence',
  /mint:\s*\['condition'\]/.test(qcCode) || /mint:\s*\[\s*'condition'\s*\]/.test(qcSrc));

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

// R4 (unwired static buildIntentData) was removed with
// `renderDirectImage`/`buildIntentData` (dormant render fallback deletion,
// 2026-09-07). R5 below still revert-proves the live VIDEO call site.

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

{
  // R6: last-dash-only parse → display title drops White → "white sole"
  // REJECT. Pins that M KEEP white-sole-on-display is the walk, not luck.
  const mutated = mutateOrThrow(
    qcSrc,
    `  const collected = [];
  for (let i = parts.length - 1; i >= 1; i--) {
    if (segmentIsColourwaySuffix(parts[i])) collected.unshift(parts[i].trim());
    else break;
  }`,
    `  const collected = [];
  const last = parts[parts.length - 1];
  if (segmentIsColourwaySuffix(last)) collected.push(last.trim());`,
    'R6'
  );
  withMutatedSibling(SRC_QC, mutated, (mod) => {
    const displayWay = mod.productColourwayFromTitle(SOLUDOS_DISPLAY);
    const got = mod.usableColourwayQuote(q(WHITE_SOLE_TEXT), SOLUDOS_DISPLAY);
    check('R6 last-dash-only parse DROPS white sole on display title (M would go red)',
      got == null
      && displayWay
      && displayWay.has('wine')
      && !displayWay.has('white'),
      `way=${displayWay ? [...displayWay].join(',') : 'null'} kept=${!!got}`);
  });
}

{
  // R7: hyphenated adjective tails skipped again → green-accented KEEP.
  const mutated = mutateOrThrow(
    qcSrc,
    'if (COLOUR_ADJ_TAIL_SET.has(tail)) return false;',
    'if (false && COLOUR_ADJ_TAIL_SET.has(tail)) return false;',
    'R7'
  );
  withMutatedSibling(SRC_QC, mutated, (mod) => {
    const got = mod.usableColourwayQuote(q(GREEN_HYPHEN_TEXT), SOLUDOS_TITLE);
    check('R7 skipped adj tails KEEP green-accented on White-Wine (M DROP would go red)',
      got != null && got.text === GREEN_HYPHEN_TEXT,
      `got ${JSON.stringify(got && got.text)}`);
  });
}

{
  // R8: mint collocate removed → "mint condition" names green → REJECT.
  const mutated = mutateOrThrow(
    qcSrc,
    "mint:   ['condition'],",
    'mint:   [],',
    'R8'
  );
  withMutatedSibling(SRC_QC, mutated, (mod) => {
    const got = mod.usableColourwayQuote(q(MINT_TEXT), SOLUDOS_TITLE);
    check('R8 mint-collocate-removed REJECTS mint condition (M KEEP would go red)',
      got == null,
      `got ${JSON.stringify(got && got.text)}`);
  });
}

{
  // R9: productAttached===false no longer short-circuits → brand/media
  // ad with a noun-scope title DROPS a colour quote.
  const mutated = mutateOrThrow(
    qcSrc,
    'if (scope.productAttached === false) return quote;',
    'if (scope.productAttached === false) { /* colourway still applies */ }',
    'R9'
  );
  withMutatedSibling(SRC_QC, mutated, (mod) => {
    const quote = q(GREEN_TEXT);
    const got = mod.applyQuoteColourway(quote, {
      productAttached: false,
      productTitle: 'Roma Retro Sneaker'
    });
    check('R9 productAttached-false skip removed DROPS brand/media colour quote (A would go red)',
      got == null,
      `got ${JSON.stringify(got && got.text)}`);
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
console.log('   helper + video + Director driven for real; revert-proven on 8 mutations');
