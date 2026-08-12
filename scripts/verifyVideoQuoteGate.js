#!/usr/bin/env node
'use strict';
//
// verifyVideoQuoteGate — pins the video dual-gate on titling meta.
//
// Static dual-gates at assembly + directImageRenderService. Video did
// not: metaCascadeResolver is path-blind, so a cached pre-provenance
// LayoutInputArtifact carrying origin:'llm-web' still burned a fabricated
// customer claim into delivered Remotion chrome. gateLayoutInputQuotes
// is the video-side twin of isPrintableCustomerQuote in buildIntentData.
//
// BEHAVIOUR, not source-scan: a non-printable quote is dropped, a
// printable one survives, ad.copy.quote operator override still wins,
// and the drop path cannot throw (Atlas is already billed).
//
// Offline: no DB, no network, no key.
//   node scripts/verifyVideoQuoteGate.js
//
// Revert-prove: temporarily blank gateLayoutInputQuotes to `return layoutInput;`
// and re-run — BAD quotes reappear in cascaded meta and the harness fails.

const fs = require('fs');
const path = require('path');
const {
  gateLayoutInputQuotes
} = require('../services/brandScriptExecutor');
const {
  resolveMeta, mergeCascades, buildContext, DEFAULT_META_CASCADES
} = require('../services/metaCascadeResolver');
const provenance = require('../services/quoteProvenance');

let pass = 0;
const failures = [];

function check(label, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

const REAL_TEXT = 'The fabric held up through a whole season of training.';

// Drive the real production path: gate → cascade. Mirrors buildMetaForAd
// without Mongo (layoutInput is handed in; catalog/brand docs omitted).
function videoMetaFor(primary_quote, adCopyQuote = null) {
  const raw = primary_quote === undefined
    ? null
    : { input: { social_proof: { primary_quote } } };
  const gated = gateLayoutInputQuotes(raw);
  const ad = adCopyQuote != null ? { copy: { quote: adCopyQuote } } : {};
  const ctx = buildContext({ ad, layoutInput: gated });
  return resolveMeta(mergeCascades(DEFAULT_META_CASCADES, null), ctx);
}

// Quiet the 🔒 log so harness output stays readable.
const realLog = console.log;
const realWarn = console.warn;
console.log = (...args) => {
  if (typeof args[0] === 'string' && args[0].includes('quote withheld')) return;
  realLog(...args);
};
console.warn = (...args) => {
  if (typeof args[0] === 'string' && args[0].includes('quote gate')) return;
  realWarn(...args);
};

// ── A. Non-printable quotes are dropped from cascaded meta ──────────
// llm-web is no longer here: owner 2026-08-02 admits grounded-search text
// (anonymous). synthesized / unknown / first-party non-verbatim stay out.
const BAD = [
  ['synthesized', { text: REAL_TEXT, origin: 'synthesized', verbatim: false }],
  ['unstamped legacy', { text: REAL_TEXT }],
  ['unknown', { text: REAL_TEXT, origin: 'unknown' }],
  ['scraped but non-verbatim', { text: REAL_TEXT, origin: 'scraped', verbatim: false }],
  ['empty text', { text: '   ', origin: 'scraped', verbatim: true }]
];
for (const [label, q] of BAD) {
  // Sanity: predicate agrees (one allowlist — no second rule here).
  check(`A predicate withholds: ${label}`,
    provenance.isPrintableCustomerQuote(q) === false);
  const m = videoMetaFor(q);
  check(`A cascade drops quote for: ${label}`,
    m.quote === undefined, `got ${JSON.stringify(m.quote)}`);
  check(`A cascade drops quoteSnippet for: ${label}`,
    m.quoteSnippet === undefined, `got ${JSON.stringify(m.quoteSnippet)}`);
  check(`A cascade drops reviewer for: ${label}`,
    m.reviewer === undefined, `got ${JSON.stringify(m.reviewer)}`);
}

// ── A2. llm-web (grounded) prints text, NEVER a byline ───────────────
{
  const q = {
    text: REAL_TEXT,
    origin: 'llm-web',
    verbatim: false,
    author_name: 'vertexaisearch.cloud.google.com',
    author: 'Reddit (r/BuyItForLife)',
    source: 'UBeauty.com'
  };
  check('A2 predicate admits llm-web + verbatim:false',
    provenance.isPrintableCustomerQuote(q) === true);
  const m = videoMetaFor(q);
  check('A2 cascade burns grounded quote text',
    m.quote === REAL_TEXT, `got ${JSON.stringify(m.quote)}`);
  check('A2 cascade burns NO reviewer for grounded (source-as-author blocked)',
    m.reviewer === undefined, `got ${JSON.stringify(m.reviewer)}`);
}

// ── B. Printable quotes still reach chrome ──────────────────────────
{
  const q = {
    text: REAL_TEXT,
    snippet: 'fabric held up',
    origin: 'scraped',
    verbatim: true,
    author_name: 'Jessica L.'
  };
  check('B predicate prints scraped+verbatim',
    provenance.isPrintableCustomerQuote(q) === true);
  const m = videoMetaFor(q);
  check('B printable quote burns into meta.quote',
    m.quote === REAL_TEXT, `got ${JSON.stringify(m.quote)}`);
  check('B printable snippet preferred when present',
    m.quoteSnippet === 'fabric held up', `got ${JSON.stringify(m.quoteSnippet)}`);
  check('B printable byline burns into meta.reviewer',
    m.reviewer === 'Jessica L.', `got ${JSON.stringify(m.reviewer)}`);
}
{
  const m = videoMetaFor({ text: REAL_TEXT, origin: 'social_comment', verbatim: true });
  check('B social_comment quote burns in', m.quote === REAL_TEXT);
}
{
  const m = videoMetaFor({ text: REAL_TEXT, origin: 'store-import' });
  check('B store-import quote burns in', m.quote === REAL_TEXT);
}

// ── C. Operator override (ad.copy.quote) still wins ─────────────────
// Cascade tier 0 is ad.copy.quote. A non-printable artifact quote must
// not silence an operator PATCH. Use synthesized (still withheld) so
// the override is the only source of quote text.
{
  const m = videoMetaFor(
    { text: REAL_TEXT, origin: 'synthesized', verbatim: false },
    'Operator-authored line'
  );
  check('C ad.copy.quote wins even when artifact quote is synthesized',
    m.quote === 'Operator-authored line', `got ${JSON.stringify(m.quote)}`);
}
// llm-web is now printable: override still outranks the artifact text.
{
  const m = videoMetaFor(
    { text: REAL_TEXT, origin: 'llm-web', verbatim: false },
    'Operator-authored line'
  );
  check('C ad.copy.quote also outranks a printable llm-web artifact quote',
    m.quote === 'Operator-authored line', `got ${JSON.stringify(m.quote)}`);
}
{
  const m = videoMetaFor(
    { text: REAL_TEXT, origin: 'scraped', verbatim: true },
    'Operator override of a good quote'
  );
  check('C ad.copy.quote also outranks a printable artifact quote',
    m.quote === 'Operator override of a good quote', `got ${JSON.stringify(m.quote)}`);
}

// ── D. Drop path cannot throw ───────────────────────────────────────
// Titling runs after the billable Omni submit. A throw here burns money
// AND leaves the ad without chrome. Every weird shape must degrade.
const NO_THROW = [
  null,
  undefined,
  {},
  { input: null },
  { input: {} },
  { input: { social_proof: null } },
  { input: { social_proof: {} } },
  { input: { social_proof: { primary_quote: null } } },
  { input: { social_proof: { primary_quote: 'not-an-object' } } },
  { input: { social_proof: { primary_quote: { text: REAL_TEXT, origin: 'llm-web' } } } },
  { input: { social_proof: { primary_quote: { text: REAL_TEXT, origin: 'scraped' } } } }
];
for (const raw of NO_THROW) {
  let threw = null;
  let out;
  try { out = gateLayoutInputQuotes(raw); }
  catch (e) { threw = e; }
  check(`D no-throw on ${JSON.stringify(raw)?.slice(0, 60)}`,
    threw === null, threw && threw.message);
  // And the result is always safe to hand to cascade.
  try {
    const ctx = buildContext({ ad: {}, layoutInput: out });
    resolveMeta(mergeCascades(DEFAULT_META_CASCADES, null), ctx);
    check(`D cascade-safe after gate on ${JSON.stringify(raw)?.slice(0, 40)}`, true);
  } catch (e) {
    check(`D cascade-safe after gate on ${JSON.stringify(raw)?.slice(0, 40)}`, false, e.message);
  }
}

// ── E. Clone only — never mutate the input artifact ─────────────────
// Non-printable path: nulls primary_quote on the clone.
{
  const artifact = {
    input: {
      social_proof: {
        primary_quote: { text: REAL_TEXT, origin: 'synthesized', author_name: 'Fake' }
      }
    }
  };
  const before = JSON.stringify(artifact);
  const gated = gateLayoutInputQuotes(artifact);
  check('E input artifact is not mutated (withhold path)',
    JSON.stringify(artifact) === before);
  check('E gated output nulls non-printable primary_quote',
    gated.input.social_proof.primary_quote === null);
  check('E gated output is a different object (withhold path)',
    gated !== artifact);
}
// Printable llm-web path: reseats a stripped copy; original untouched.
{
  const artifact = {
    input: {
      social_proof: {
        primary_quote: {
          text: REAL_TEXT,
          origin: 'llm-web',
          verbatim: false,
          author_name: 'vertexaisearch.cloud.google.com'
        }
      }
    }
  };
  const before = JSON.stringify(artifact);
  const gated = gateLayoutInputQuotes(artifact);
  check('E input artifact is not mutated (admit path)',
    JSON.stringify(artifact) === before);
  check('E gated output keeps grounded text',
    gated.input.social_proof.primary_quote?.text === REAL_TEXT);
  check('E gated output strips author_name on admit',
    gated.input.social_proof.primary_quote &&
      !('author_name' in gated.input.social_proof.primary_quote));
  check('E gated output is a different object (admit path)',
    gated !== artifact);
}

// ── F. Wire is live in buildMetaForAd (revert surface) ──────────────
// Behaviour above tests the pure function. This pins that buildMetaForAd
// actually calls it — without this, a "return layoutInput" stub at the
// call site would leave the harness green while production was open.
const bseSrc = fs.readFileSync(
  path.join(__dirname, '../services/brandScriptExecutor.js'), 'utf8'
);
// Accept the optional scope arg (STRICT seed labels) but still require
// the live assignment: layoutInput = gateLayoutInputQuotes(layoutInput…).
// A one-arg call and a two-arg call both pass; a missing assignment or
// a call that does not reseat layoutInput still fails.
check('F buildMetaForAd calls gateLayoutInputQuotes',
  /layoutInput\s*=\s*gateLayoutInputQuotes\s*\(\s*layoutInput\b/.test(bseSrc));
check('F buildMetaForAd passes seed media into the quote gate',
  /gateLayoutInputQuotes\s*\(\s*layoutInput[\s\S]{0,400}?\bmedia\s*:/.test(bseSrc));
check('F gate uses toPrintableCustomerQuote from quoteProvenance (one allowlist + strip)',
  /require\(['"]\.\/quoteProvenance['"]\)/.test(bseSrc) &&
  /toPrintableCustomerQuote/.test(bseSrc));
check('F gate nulls primary_quote on withhold (does not delete social_proof wholesale)',
  /primary_quote:\s*null/.test(bseSrc));
check('F gate reseats primary_quote with printable on admit (structural strip)',
  /primary_quote:\s*printable/.test(bseSrc));

// restore console
console.log = realLog;
console.warn = realWarn;

// ── report ──────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`\nverifyVideoQuoteGate: ${failures.length} FAIL(s), ${pass} pass\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`verifyVideoQuoteGate: ${pass} pass, 0 fail`);
process.exit(0);
