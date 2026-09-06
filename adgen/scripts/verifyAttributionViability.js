#!/usr/bin/env node
'use strict';
//
// verifyAttributionViability — a reviewer byline must actually attribute.
//
// PORTED from liquidretail_backend/scripts/verifyAttributionViability.js
// (branch fix/attribution-viability). Path adaptation only: services/* →
// src/services/*. No assertion was weakened. This repo vendors the render
// path; without this port the backend's usableAttribution gate is INERT for
// every newly generated ad (ADGEN_RENDERER_ENABLED=true).
//
// DEFECT (measured 2026-08-24, Pelagic Gear video ad): a scraped product
// review whose author field was the bare initial "D" rendered as
//
//     — D
//
// under the customer quote (`slotRenderers.jsx` prepends the em-dash). That
// identifies nobody and reads as a truncation bug. Nothing filtered it: the
// video path assigned `cascaded.reviewer` straight onto meta.reviewer, and
// the static path did `String(quote.author_name).trim()`.
//
// THE GATE is `usableAttribution` in src/services/quoteProvenance.js — letter
// count via \p{L}, not string length, not [A-Za-z]. A single Unicode letter
// (with or without a trailing period) is dropped; two or more letters are
// kept, trimmed. ONE definition, imported by both render paths. A per-caller
// copy is how the static and video quote gates drift apart.
//
// Deliberately does NOT filter "Anonymous" / "Guest" / "Verified Buyer" —
// those are review-UI conventions, not a correctness bug. Does NOT change
// what counts as a PRINTABLE quote (toPrintableCustomerQuote).
//
// Offline: no DB, no network, no API key.
//   node scripts/verifyAttributionViability.js
//
// Revert-prove (each mutation must fail this harness):
//   1. Helper neutered to identity (`return raw`)            → A (D kept)
//   2. Video site unwired (reviewer: cascaded.reviewer)      → C video call
//   3. Static site unwired (String(author_name).trim())      → B / C static
//   4. Letter threshold lowered to 1 (`letterCount(s) < 1`)  → A (D kept)
//   5. Video wraps then falls back (`|| cascaded.reviewer`)  → C video call
//      (prefix-only regex was green on this; it restores "— D")
//   6. Swap \p{L} for [A-Za-z]                               → A CJK / D unicode
//   7. Comment out the import + dummy string with the same
//      characters (processAlerts class)                      → C video import
//   8. Duplicate `reviewer:` key (last-wins restores raw)    → C video call

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

// Isolate from QUOTE_PROVENANCE_STRICT noun-scope (default on). This harness
// pins ATTRIBUTION viability, not quote printability; a noun-mismatch drop
// would make every "kept" case look like a gate failure.
process.env.QUOTE_PROVENANCE_STRICT = 'false';

const {
  usableAttribution,
  letterCount,
  toPrintableCustomerQuote
} = require('../src/services/quoteProvenance');
const direct = require('../src/services/directImageRenderService');

const ROOT = path.join(__dirname, '..');
const SRC_QP = path.join(ROOT, 'src', 'services', 'quoteProvenance.js');
const SRC_VIDEO = path.join(ROOT, 'src', 'services', 'brandScriptExecutor.js');
const SRC_STATIC = path.join(ROOT, 'src', 'services', 'directImageRenderService.js');

// Comment-stripped source for every assertion. A check a COMMENT can satisfy
// is worthless — verifyReceiptAwareRequeue shipped exactly that (a commented
// import satisfied its "is it imported" regex; processAlerts then threw
// ReferenceError in production with a green harness).
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

const qpSrc = fs.readFileSync(SRC_QP, 'utf8');
const videoSrc = fs.readFileSync(SRC_VIDEO, 'utf8');
const staticSrc = fs.readFileSync(SRC_STATIC, 'utf8');
const qpCode = stripComments(qpSrc);
const videoCode = stripComments(videoSrc);
const staticCode = stripComments(staticSrc);

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

const REAL_TEXT = 'The fabric held up through a whole season of training.';

function intentFor(author_name) {
  return direct.buildIntentData({
    concept: { copy_picks: { headline: 'Built for the long season' } },
    layoutInput: {
      social_proof: {
        primary_quote: {
          text: REAL_TEXT,
          origin: 'scraped',
          verbatim: true,
          author_name
        }
      }
    },
    brand: {},
    cta: 'SHOP NOW'
  });
}

function importsUsableAttribution(code) {
  // Require a real const/let/var destructure. A string literal containing
  // the same characters (commented-import bait) is not an import — that is
  // the processAlerts class: production throws ReferenceError, harness green.
  return /(?:const|let|var)\s*\{[^}]*\busableAttribution\b[^}]*\}\s*=\s*require\s*\(\s*['"]\.\/quoteProvenance['"]\s*\)/.test(code);
}

// ── A. Behavioural: drive the REAL exported helper, not a copy ──────────
check('A0 usableAttribution is a function', typeof usableAttribution === 'function');
check('A0 letterCount is a function', typeof letterCount === 'function');

const DROPPED = [
  ['D', 'D'],
  ['D.', 'D.'],
  ['padded D', ' D '],
  ['empty', ''],
  ['null', null],
  ['undefined', undefined],
  ['number 123', 123],
  ['dots/spaces', '  .']
];
for (const [label, raw] of DROPPED) {
  const got = usableAttribution(raw);
  check(`A drop: ${label}`, got === null, `got ${JSON.stringify(got)}`);
}

const KEPT = [
  ['J.D.', 'J.D.', 'J.D.'],
  ['Connor H.', 'Connor H.', 'Connor H.'],
  ['Matthew E.', 'Matthew E.', 'Matthew E.'],
  ['DBallzdeep', 'DBallzdeep', 'DBallzdeep'],
  ['jefferyledford0811', 'jefferyledford0811', 'jefferyledford0811'],
  ['padded Connor', '  Connor H.  ', 'Connor H.']
];
for (const [label, raw, want] of KEPT) {
  const got = usableAttribution(raw);
  check(`A keep: ${label}`, got === want, `got ${JSON.stringify(got)}`);
}

// Non-Latin MUST survive. letterCount uses \p{L} so a later "simplify" to
// [A-Za-z] cannot silently drop every non-Latin reviewer.
check('A CJK two letters kept (祐子)', usableAttribution('祐子') === '祐子');
check('A CJK one letter dropped (李)', usableAttribution('李') === null);
check('A letterCount(祐子) === 2', letterCount('祐子') === 2);
check('A letterCount(李) === 1', letterCount('李') === 1);
check('A letterCount(D) === 1', letterCount('D') === 1);
check('A letterCount(D.) === 1', letterCount('D.') === 1);
check('A letterCount(J.D.) === 2', letterCount('J.D.') === 2);
check('A letterCount uses Unicode letters, not ASCII', letterCount('José') === 4);

// Editorial names are in scope to KEEP. Suppressing them is a copy decision.
for (const name of ['Anonymous', 'Guest', 'Verified Buyer']) {
  check(`A convention kept: ${name}`, usableAttribution(name) === name);
}

check('A never throws on object', usableAttribution({ author: 'D' }) === null);
check('A never throws on array', usableAttribution(['D']) === null);
check('A collapses internal whitespace', usableAttribution('Connor   H.') === 'Connor H.');

// ── B. Static path: drive the REAL buildIntentData, not a source mirror ──
{
  const dDrop = intentFor('D');
  check('B static quote still prints when byline is a bare initial',
    dDrop.quote === REAL_TEXT, `got ${JSON.stringify(dDrop.quote)}`);
  check('B static drops bare initial (undefined, not null)',
    dDrop.attribution === undefined, `got ${JSON.stringify(dDrop.attribution)}`);

  const dDot = intentFor('D.');
  check('B static drops D.', dDot.attribution === undefined,
    `got ${JSON.stringify(dDot.attribution)}`);

  const dKeep = intentFor('Jessica L.');
  check('B static keeps a real byline', dKeep.attribution === 'Jessica L.',
    `got ${JSON.stringify(dKeep.attribution)}`);

  const dCjk = intentFor('祐子');
  check('B static keeps CJK byline', dCjk.attribution === '祐子',
    `got ${JSON.stringify(dCjk.attribution)}`);

  const dAnon = intentFor('Verified Buyer');
  check('B static does not filter Verified Buyer',
    dAnon.attribution === 'Verified Buyer',
    `got ${JSON.stringify(dAnon.attribution)}`);

  const dNone = intentFor(undefined);
  check('B static absent author stays undefined',
    dNone.attribution === undefined, `got ${JSON.stringify(dNone.attribution)}`);
}

// ── C. Both call sites IMPORT the helper (the processAlerts class) ───────
// A regex proving the call is WRITTEN does not prove it RESOLVES. Assert
// the destructure from './quoteProvenance' on comment-stripped source, then
// assert the call sits on the assignment the defect actually used.
check('C video imports usableAttribution from ./quoteProvenance',
  importsUsableAttribution(videoCode));
check('C static imports usableAttribution from ./quoteProvenance',
  importsUsableAttribution(staticCode));

// The WHOLE assignment, including the fail-closed `?? null`. A prefix-only
// regex (usableAttribution(cascaded.reviewer) with no rest) stays green on
// `usableAttribution(cascaded.reviewer) || cascaded.reviewer` — that restores
// "— D" and was the first adversarial finding against this harness.
check('C video reviewer assignment is usableAttribution(cascaded.reviewer) ?? null',
  /\breviewer\s*:\s*usableAttribution\s*\(\s*cascaded\.reviewer\s*\)\s*\?\?\s*null\s*,/.test(videoCode)
    && (videoCode.match(/\breviewer\s*:/g) || []).length === 1,
  'buildMetaForAd must wrap cascaded.reviewer, must NOT fall back to the raw value, and must not restore it via a later duplicate key');

check('C static attribution assignment calls usableAttribution(quote?.author_name) ?? undefined',
  /\battribution\s*:\s*quoteText\s*\?\s*\(\s*usableAttribution\s*\(\s*quote\?\.author_name\s*\)\s*\?\?\s*undefined\s*\)/.test(staticCode)
    && (staticCode.match(/\battribution\s*:/g) || []).length === 1,
  'buildIntentData must wrap author_name and keep absent as undefined; a later duplicate key must not restore the raw byline');

check('C video does not reimplement or rebind the helper',
  !/function\s+usableAttribution\s*\(/.test(videoCode)
    && !/\busableAttribution\s*=/.test(videoCode));
check('C static does not reimplement or rebind the helper',
  !/function\s+usableAttribution\s*\(/.test(staticCode)
    && !/\busableAttribution\s*=/.test(staticCode));

check('C video reviewer line has no raw cascaded.reviewer fallback',
  !/\breviewer\s*:[^,\n]*cascaded\.reviewer[^,\n]*(?:\|\||\?\?)\s*cascaded\.reviewer/.test(videoCode));

// Runtime bind: the module that defines it actually exports a function.
check('C quoteProvenance.usableAttribution is the bound function',
  typeof require('../src/services/quoteProvenance').usableAttribution === 'function');

// ── D. The definition itself: \p{L}, threshold 2, not inside toPrintable ─
check('D letterCount matches \\p{L} (Unicode letters, not [A-Za-z])',
  /\\p\{L\}/.test(qpCode));
check('D usableAttribution refuses fewer than 2 letters',
  /letterCount\s*\(\s*s\s*\)\s*<\s*2/.test(qpCode)
    || /letterCount\s*\(\s*s\s*\)\s*<=\s*1/.test(qpCode));
check('D helper is defined once in quoteProvenance.js',
  (qpCode.match(/function\s+usableAttribution\s*\(/g) || []).length === 1);

{
  const start = qpSrc.indexOf('function toPrintableCustomerQuote');
  const end = qpSrc.indexOf('function isPrintableCustomerQuote');
  const body = start >= 0 && end > start ? stripComments(qpSrc.slice(start, end)) : '';
  check('D toPrintableCustomerQuote does not call usableAttribution',
    !!body && !/\busableAttribution\s*\(/.test(body),
    'printability and attribution-viability must stay separate gates');
}

// The printable-quote allowlist is untouched — this harness must not become
// licence to fold the two together.
check('D toPrintableCustomerQuote still exported and callable',
  typeof toPrintableCustomerQuote === 'function');
{
  const printable = toPrintableCustomerQuote({
    text: REAL_TEXT, origin: 'scraped', verbatim: true, author_name: 'D'
  });
  check('D toPrintable still ADMITS a quote whose byline is a bare initial',
    !!(printable && printable.text === REAL_TEXT),
    `got ${JSON.stringify(printable && printable.text)}`);
  check('D toPrintable still KEEPS the bare-initial author_name (viability is a renderer concern)',
    printable && printable.author_name === 'D',
    `got ${JSON.stringify(printable && printable.author_name)}`);
}

console.log = realLog;
console.warn = realWarn;

if (failures.length) {
  console.error(`\n❌ verifyAttributionViability: ${failures.length} FAILED, ${pass} passed\n`);
  failures.forEach((f) => console.error(`   • ${f}`));
  process.exit(1);
}
console.log(`✅ verifyAttributionViability: ${pass} checks passed`);
console.log('   helper + static buildIntentData driven for real; both call sites import the one definition');
