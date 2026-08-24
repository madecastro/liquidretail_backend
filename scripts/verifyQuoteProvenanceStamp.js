#!/usr/bin/env node
'use strict';

/**
 * verifyQuoteProvenanceStamp — offline pins for stampQuoteOrigins reading
 * container.quotesOrigin via classifyProductReviewsProvenance.
 *
 * Defect (measured 2026-08-21): stampQuoteOrigins derived provenance from
 * container.source only. json-ld (788 products / 18452 quotes) and
 * api:yotpo (149 / 2482) carried quotesOrigin:'scraped' but 0 of 20934
 * quotes had their own origin, so every first-party review stamped
 * 'unknown' and was dropped; the brand-tier last-resort printed a brand
 * quote on a t-shirt ad.
 *
 * Kill switch QUOTE_ORIGIN_FROM_CONTAINER (env, default TRUE). Flag-off
 * is today's origin assignment. Flag-on adds one arm after the existing
 * gemini-search / source=store arms, so the change can only convert a
 * previous 'unknown'.
 *
 * Offline: no DB, no network, no API key.
 *   node scripts/verifyQuoteProvenanceStamp.js
 *
 * This worktree's node_modules is incomplete (no https-proxy-agent).
 * The harness stubs that package so requiring layoutInputService does
 * not crash. Flag reads are module-load-time constants: loadLis()
 * evicts require.cache and re-requires.
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');
const cp = require('child_process');
const assert = require('assert');

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

const {
  classifyProductReviewsProvenance
} = require('../services/ratingPairAtomic');
const { toPrintableCustomerQuote } = require('../services/quoteProvenance');

const REPO = path.join(__dirname, '..');
const LIS_PATH = require.resolve('../services/layoutInputService');
const ENV_PATH = path.join(REPO, 'config', 'defaults.env');
const BASELINE_SPEC = '3e4561e2:services/layoutInputService.js';

const ORIGINAL_FLAG = process.env.QUOTE_ORIGIN_FROM_CONTAINER;

function loadLis(flag) {
  delete require.cache[LIS_PATH];
  if (flag === undefined || flag === null) delete process.env.QUOTE_ORIGIN_FROM_CONTAINER;
  else process.env.QUOTE_ORIGIN_FROM_CONTAINER = String(flag);
  return require('../services/layoutInputService');
}

const lisOn = loadLis('true');
const lisOff = loadLis('false');
const lisDefault = loadLis(undefined);

let pass = 0;
const failures = [];

function check(label, fn) {
  try {
    fn();
    pass += 1;
  } catch (err) {
    failures.push(`${label}: ${err.message.split('\n')[0].slice(0, 240)}`);
  }
}

function captureLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => { lines.push(args.map(String).join(' ')); };
  try {
    return { result: fn(), lines };
  } finally {
    console.log = orig;
  }
}

function originOf(stamped, i) {
  const q = stamped[i];
  if (!q) return q;
  return q.origin || null;
}

function expectedOriginOn(container, q) {
  let origin = q?.origin || null;
  if (!origin) {
    const containerSource = container?.source || null;
    if (containerSource === 'gemini-search') origin = 'llm-web';
    else if (q?.source === 'store') origin = 'store-import';
    else {
      const classified = classifyProductReviewsProvenance(container);
      if (classified === 'scraped') origin = 'scraped';
      else if (classified === 'llm-web') origin = 'llm-web';
      else origin = 'unknown';
    }
  }
  return origin;
}

const TEXT = 'Great fit and washes well.';

const YOTPO = { source: 'api:yotpo', quotesOrigin: 'scraped', platform: 'yotpo' };
const JSON_LD = { source: 'json-ld', quotesOrigin: 'scraped' };
const GEMINI = { source: 'gemini-search', quotesOrigin: 'llm-web' };
const CATEGORY = { sources: ['x.com'] };

const CONTAINERS = [
  ['null', null],
  ['undefined', undefined],
  ['string', 'not-a-container'],
  ['number', 42],
  ['empty-object', {}],
  ['yotpo', YOTPO],
  ['json-ld', JSON_LD],
  ['gemini', GEMINI],
  ['gemini-no-quotesOrigin', { source: 'gemini-search' }],
  ['gemini-quotesOrigin-scraped', { source: 'gemini-search', quotesOrigin: 'scraped' }],
  ['category-sources', CATEGORY],
  ['yotpo-no-quotesOrigin', { source: 'api:yotpo', platform: 'yotpo' }],
  ['quotesOrigin-only-scraped', { quotesOrigin: 'scraped' }],
  ['quotesOrigin-SCRAPED', { quotesOrigin: 'SCRAPED' }],
  ['quotesOrigin-Scraped', { quotesOrigin: 'Scraped' }],
  ['quotesOrigin-llm-web', { quotesOrigin: 'llm-web' }],
  ['quotesOrigin-LLM-WEB', { quotesOrigin: 'LLM-WEB' }],
  ['productReviewsScrape', { source: 'productReviewsScrape' }],
  ['nonempty-tiers', { tiers: [{ name: 'x' }] }],
  ['ratingSource', { ratingSource: 'trustpilot.com' }],
  ['json-ld-plus-tiers', { source: 'json-ld', quotesOrigin: 'scraped', tiers: [{}] }],
  ['json-ld-quotesOrigin-llm-web', { source: 'json-ld', quotesOrigin: 'llm-web' }]
];

const QUOTE_LISTS = [
  ['empty-array', []],
  ['a1-yotpo-shape', [{ text: TEXT, source: 'yotpo', rating: 5 }]],
  ['text-only', [{ text: TEXT }]],
  ['origin-scraped', [{ text: TEXT, origin: 'scraped' }]],
  ['origin-llm-web', [{ text: TEXT, origin: 'llm-web' }]],
  ['origin-unknown', [{ text: TEXT, origin: 'unknown' }]],
  ['source-store', [{ text: TEXT, source: 'store' }]],
  ['source-store-origin-scraped', [{ text: TEXT, source: 'store', origin: 'scraped' }]],
  ['falsy-origin', [{ text: TEXT, origin: '' }]],
  ['origin-store-import', [{ text: TEXT, origin: 'store-import' }]],
  ['no-text', [{ source: 'yotpo', rating: 5 }]]
];

function loadBaselineStamp(normalizeQuote) {
  const src = cp.execFileSync('git', ['-C', REPO, 'show', BASELINE_SPEC], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const start = src.indexOf('function stampQuoteOrigins(');
  const end = src.indexOf('\nfunction printableQuotes(', start);
  if (start < 0 || end < 0) {
    throw new Error(`could not extract stampQuoteOrigins from ${BASELINE_SPEC}`);
  }
  const fnSrc = src.slice(start, end);
  if (fnSrc.includes('QUOTE_ORIGIN_FROM_CONTAINER') || fnSrc.includes('classifyProductReviewsProvenance')) {
    throw new Error(`${BASELINE_SPEC} stampQuoteOrigins already contains the new arm`);
  }
  return new Function('normalizeQuote', `${fnSrc}\nreturn stampQuoteOrigins;`)(normalizeQuote);
}

// ── D1 classifier is ungated ──────────────────────────────────────────

check('classifyProductReviewsProvenance is not gated by RATING_PAIR_ATOMIC', () => {
  const prev = process.env.RATING_PAIR_ATOMIC;
  process.env.RATING_PAIR_ATOMIC = 'false';
  try {
    assert.strictEqual(
      classifyProductReviewsProvenance({ source: 'api:yotpo', quotesOrigin: 'scraped' }),
      'scraped'
    );
    assert.strictEqual(
      classifyProductReviewsProvenance({ source: 'gemini-search', quotesOrigin: 'llm-web' }),
      'llm-web'
    );
    assert.strictEqual(classifyProductReviewsProvenance({ sources: ['x.com'] }), 'unknown');
    assert.strictEqual(classifyProductReviewsProvenance(null), null);
  } finally {
    if (prev === undefined) delete process.env.RATING_PAIR_ATOMIC;
    else process.env.RATING_PAIR_ATOMIC = prev;
  }
});

check('defaults.env ships QUOTE_ORIGIN_FROM_CONTAINER=true', () => {
  const envText = fs.readFileSync(ENV_PATH, 'utf8');
  assert.ok(
    /^QUOTE_ORIGIN_FROM_CONTAINER=true$/m.test(envText),
    'committed default must be true so a fresh boot gets the fix'
  );
});

check('unset env (code default) stamps Yotpo as scraped', () => {
  const [stamped] = lisDefault.stampQuoteOrigins(YOTPO, [{ text: TEXT, source: 'yotpo', rating: 5 }]);
  assert.strictEqual(stamped.origin, 'scraped');
});

// ── A. happy path / fail-closed / precedence ──────────────────────────

check('A1 Yotpo container → scraped and printable', () => {
  const quotes = [{ text: TEXT, source: 'yotpo', rating: 5 }];
  const [stamped] = lisOn.stampQuoteOrigins(YOTPO, quotes);
  assert.ok(stamped, 'normalizeQuote dropped the quote');
  assert.strictEqual(stamped.origin, 'scraped');
  const printable = toPrintableCustomerQuote(stamped);
  assert.ok(printable, 'toPrintableCustomerQuote returned null');
  assert.strictEqual(printable.origin, 'scraped');
});

check('A2 json-ld container → scraped', () => {
  const [stamped] = lisOn.stampQuoteOrigins(JSON_LD, [{ text: TEXT }]);
  assert.strictEqual(stamped.origin, 'scraped');
  assert.ok(toPrintableCustomerQuote(stamped));
});

check('A3 gemini container → llm-web (unchanged)', () => {
  const [on] = lisOn.stampQuoteOrigins(GEMINI, [{ text: TEXT }]);
  const [off] = lisOff.stampQuoteOrigins(GEMINI, [{ text: TEXT }]);
  assert.strictEqual(on.origin, 'llm-web');
  assert.strictEqual(off.origin, 'llm-web');
  assert.ok(toPrintableCustomerQuote(on));
});

check('A4 category sources[] (plural, no source, no quotesOrigin) stays unknown', () => {
  const [on] = lisOn.stampQuoteOrigins(CATEGORY, [{ text: TEXT }]);
  const [off] = lisOff.stampQuoteOrigins(CATEGORY, [{ text: TEXT }]);
  assert.strictEqual(on.origin, 'unknown');
  assert.strictEqual(off.origin, 'unknown');
  assert.strictEqual(toPrintableCustomerQuote(on), null);
  assert.strictEqual(classifyProductReviewsProvenance(CATEGORY), 'unknown');
});

check('A5 per-quote origin wins over the container', () => {
  const [overYotpo] = lisOn.stampQuoteOrigins(YOTPO, [{ text: TEXT, origin: 'llm-web' }]);
  assert.strictEqual(overYotpo.origin, 'llm-web');
  const [overGemini] = lisOn.stampQuoteOrigins(GEMINI, [{ text: TEXT, origin: 'scraped' }]);
  assert.strictEqual(overGemini.origin, 'scraped');
  const [explicitUnknown] = lisOn.stampQuoteOrigins(YOTPO, [{ text: TEXT, origin: 'unknown' }]);
  assert.strictEqual(explicitUnknown.origin, 'unknown');
});

check('A6 q.source === store still → store-import (before the new arm)', () => {
  const [bare] = lisOn.stampQuoteOrigins({}, [{ text: TEXT, source: 'store' }]);
  assert.strictEqual(bare.origin, 'store-import');
  const [onScrapedContainer] = lisOn.stampQuoteOrigins(JSON_LD, [{ text: TEXT, source: 'store' }]);
  const [offScrapedContainer] = lisOff.stampQuoteOrigins(JSON_LD, [{ text: TEXT, source: 'store' }]);
  assert.strictEqual(onScrapedContainer.origin, 'store-import');
  assert.strictEqual(offScrapedContainer.origin, 'store-import');
});

check('A7 classifier arms other than quotesOrigin still reach stampQuoteOrigins', () => {
  const [scrapeMarker] = lisOn.stampQuoteOrigins({ source: 'productReviewsScrape' }, [{ text: TEXT }]);
  assert.strictEqual(scrapeMarker.origin, 'scraped');
  const [tiers] = lisOn.stampQuoteOrigins({ tiers: [{ name: 'x' }] }, [{ text: TEXT }]);
  assert.strictEqual(tiers.origin, 'scraped');
  const [ratingSrc] = lisOn.stampQuoteOrigins({ ratingSource: 'trustpilot.com' }, [{ text: TEXT }]);
  assert.strictEqual(ratingSrc.origin, 'llm-web');
});

// ── B. additive safety + flag-off identity ────────────────────────────

check('B1 additive safety: ON vs OFF differ only where OFF was unknown', () => {
  const violations = [];
  let cells = 0;
  for (const [cLabel, container] of CONTAINERS) {
    for (const [qLabel, quotes] of QUOTE_LISTS) {
      cells += 1;
      const on = lisOn.stampQuoteOrigins(container, quotes);
      const off = lisOff.stampQuoteOrigins(container, quotes);
      if (on.length !== off.length) {
        violations.push(`${cLabel} x ${qLabel}: length on=${on.length} off=${off.length}`);
        continue;
      }
      for (let i = 0; i < on.length; i++) {
        const onO = originOf(on, i);
        const offO = originOf(off, i);
        if (onO !== offO) {
          if (offO !== 'unknown') {
            violations.push(`${cLabel} x ${qLabel} [${i}]: changed non-unknown off=${offO} → on=${onO}`);
          }
          if (onO !== 'scraped' && onO !== 'llm-web') {
            violations.push(`${cLabel} x ${qLabel} [${i}]: ON moved unknown to ${onO}, not scraped|llm-web`);
          }
        }
        const raw = quotes[i];
        if (raw && raw.text) {
          const expected = expectedOriginOn(container, raw);
          if (on[i] && on[i].origin !== expected) {
            violations.push(`${cLabel} x ${qLabel} [${i}]: on=${on[i].origin} !== D2 expected ${expected}`);
          }
        }
      }
    }
  }
  assert.ok(cells >= CONTAINERS.length * QUOTE_LISTS.length, 'matrix did not sweep');
  assert.strictEqual(violations.length, 0, violations.slice(0, 8).join('; '));
});

check('B2 flag-off identity against git 3e4561e2 stampQuoteOrigins', () => {
  let baseline;
  try {
    baseline = loadBaselineStamp(lisOff.normalizeQuote);
  } catch (err) {
    throw new Error(`B2 could not reconstruct baseline from git (${err.message})`);
  }
  const mismatches = [];
  for (const [cLabel, container] of CONTAINERS) {
    for (const [qLabel, quotes] of QUOTE_LISTS) {
      const off = lisOff.stampQuoteOrigins(container, quotes);
      const old = baseline(container, quotes);
      if (JSON.stringify(off) !== JSON.stringify(old)) {
        mismatches.push(`${cLabel} x ${qLabel}`);
      }
    }
  }
  assert.strictEqual(mismatches.length, 0, `flag-off drifted from ${BASELINE_SPEC}: ${mismatches.slice(0, 8).join(', ')}`);
});

// ── C. star gate still protects newly admitted quotes ─────────────────

check('C1 scraped 2-star does not survive prepareQuotePool', () => {
  assert.ok(lisOn.QUOTE_MIN_RATING > 2, `QUOTE_MIN_RATING ${lisOn.QUOTE_MIN_RATING} does not sit above 2`);
  const raw = [{ text: TEXT, source: 'yotpo', rating: 2 }];
  const [stamped] = lisOn.stampQuoteOrigins(YOTPO, raw);
  assert.strictEqual(stamped.origin, 'scraped');
  const { result: printable } = captureLog(() => lisOn.printableQuotes([stamped], 'product'));
  assert.strictEqual(printable.length, 1, '2-star scraped quote must be admitted by provenance so the star gate is what drops it');
  const { result: pool } = captureLog(() => lisOn.prepareQuotePool(YOTPO, raw, 'product'));
  assert.strictEqual(pool.length, 0);
});

check('C2 unrated scraped quote still passes (QUOTE_REQUIRE_RATING default false)', () => {
  const raw = [{ text: TEXT, source: 'yotpo' }];
  const { result: pool } = captureLog(() => lisOn.prepareQuotePool(YOTPO, raw, 'product'));
  assert.strictEqual(pool.length, 1);
  assert.strictEqual(pool[0].origin, 'scraped');
  assert.strictEqual(pool[0].rating, undefined);
});

// ── D. provenance-failure log ─────────────────────────────────────────

const WITHHELD_RE = /^🔒 quote provenance\[.+\] — \d+ quote\(s\) withheld: origin not printable as a customer testimonial$/;

check('D1 provenance-failure log: full unknown drop fires; empty pool and other drops do not', () => {
  const unknown = { text: TEXT, origin: 'unknown' };
  const { lines: unknownLines } = captureLog(() => lisOn.printableQuotes([unknown], 'product'));
  assert.ok(unknownLines.some((l) => WITHHELD_RE.test(l)), `missing unchanged withheld line: ${JSON.stringify(unknownLines)}`);
  assert.ok(
    unknownLines.some((l) => l.includes('provenance-failure') && l.includes('origin=unknown')),
    `missing provenance-failure line: ${JSON.stringify(unknownLines)}`
  );
  assert.ok(unknownLines.some((l) => l.includes('kept 0')));

  const { lines: emptyLines } = captureLog(() => lisOn.printableQuotes([], 'product'));
  assert.strictEqual(emptyLines.length, 0, `empty pool logged: ${JSON.stringify(emptyLines)}`);
  const { lines: nullLines } = captureLog(() => lisOn.printableQuotes(null, 'product'));
  assert.strictEqual(nullLines.length, 0, `null pool logged: ${JSON.stringify(nullLines)}`);

  const synthesized = { text: TEXT, origin: 'synthesized' };
  const { lines: synthLines } = captureLog(() => lisOn.printableQuotes([synthesized], 'product'));
  assert.ok(synthLines.some((l) => WITHHELD_RE.test(l)), 'synthesized drop must keep the existing withheld line');
  assert.ok(!synthLines.some((l) => l.includes('provenance-failure')), `provenance-failure fired on synthesized: ${JSON.stringify(synthLines)}`);

  const verbatimFalse = { text: TEXT, origin: 'scraped', verbatim: false };
  const { lines: verbLines } = captureLog(() => lisOn.printableQuotes([verbatimFalse], 'product'));
  assert.ok(verbLines.some((l) => WITHHELD_RE.test(l)));
  assert.ok(!verbLines.some((l) => l.includes('provenance-failure')), `provenance-failure fired on verbatim:false: ${JSON.stringify(verbLines)}`);

  const mixed = [unknown, { text: TEXT, origin: 'scraped' }];
  const { result: mixedKept, lines: mixedLines } = captureLog(() => lisOn.printableQuotes(mixed, 'product'));
  assert.strictEqual(mixedKept.length, 1);
  assert.ok(mixedLines.some((l) => WITHHELD_RE.test(l)));
  assert.ok(!mixedLines.some((l) => l.includes('provenance-failure')), `provenance-failure fired when some quotes were kept: ${JSON.stringify(mixedLines)}`);
});

// Restore the process env so a later require in this process sees the original.
if (ORIGINAL_FLAG === undefined) delete process.env.QUOTE_ORIGIN_FROM_CONTAINER;
else process.env.QUOTE_ORIGIN_FROM_CONTAINER = ORIGINAL_FLAG;

const total = pass + failures.length;
if (failures.length) {
  console.log(`\n❌ verifyQuoteProvenanceStamp: ${failures.length} of ${total} checks FAILED`);
  for (const f of failures) console.log(`   • ${f}`);
  process.exit(1);
}
console.log(`\n✅ verifyQuoteProvenanceStamp: ${total}/${total} checks passed`);

/*
 * REVERT-PROOF — mutations that MUST make this harness fail, and which check
 * catches each. Comment-only: this file does not live-mutate production
 * source (unlike verifyRatingPairAtomic's H loop).
 *
 * M1  Drop the new classifier arm (else origin = 'unknown' always)
 *     → A1, A2, A7, B1 (ON origin !== D2 expected for Yotpo/json-ld)
 * M2  Run classifyProductReviewsProvenance BEFORE gemini-search
 *     → B1 additive-safety on container 'gemini-quotesOrigin-scraped'
 *       (OFF is llm-web, ON would become scraped)
 * M3  Run classifier BEFORE q.source === 'store'
 *     → A6 (json-ld + source:store would become scraped, not store-import)
 * M4  Per-quote origin no longer wins (always restamp from container)
 *     → A5
 * M5  Treat category `{sources:['x.com']}` as llm-web / scraped
 *     → A4
 * M6  Default the flag OFF (`?? 'false'` or missing defaults.env line)
 *     → unset-env check, defaults.env check, A1 if run under default load
 * M7  Flag-on and flag-off share one module-load const (no re-require)
 *     → B1 / B2 (both arms identical, Yotpo ON stays unknown or OFF becomes scraped)
 * M8  Hand-roll quotesOrigin==='scraped' instead of calling classify
 *     → A7 (productReviewsScrape / tiers / ratingSource stay unknown)
 * M9  Skip gateQuotesByRating inside prepareQuotePool
 *     → C1 (2-star scraped survives the pool)
 * M10 Default QUOTE_REQUIRE_RATING to true
 *     → C2 (unrated scraped dropped)
 * M11 Delete the provenance-failure console.log
 *     → D1 unknown-drop case
 * M12 Fire provenance-failure when candidates.length === 0
 *     → D1 empty-pool case
 * M13 Fire provenance-failure on synthesized / verbatim:false / mixed keep
 *     → D1 negative cases
 * M14 Change the existing withheld line's text
 *     → D1 WITHHELD_RE
 * M15 Reconstruct B2 from a hand-copied function that already includes the
 *     new arm (or git show a SHA that has it)
 *     → B2 'already contains the new arm' / identity mismatch
 */
