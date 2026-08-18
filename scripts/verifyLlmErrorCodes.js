#!/usr/bin/env node
'use strict';

// Verifies that EVERY LLM failure is reported with a complete, stable error
// code — and with what the system actually DID about it.
//
// WHY THIS EXISTS
// ---------------
// On 2026-08-18 static ad generation was dead for ~20h and the only thing that
// reached the operator was `Atlas 400: {"code":400,"msg":"bad request"}`. That
// string cannot distinguish a param bug from a capacity outage from a missing
// API key — and the actual cause was a THIRD thing again (HTTP 429 after ~51s
// on a starved Anthropic route). Owner directive: "every failure to an LLM call
// should be reported with an easy to understand and complete error code", and
// "and what steps were taken next".
//
// THE SITE LIST IS DERIVED BY SCANNING, NEVER HARDCODED. A scanner with a blind
// spot reports green: CLAUDE.md §4 records `receiptFree` shipping broken to
// production because a harness proved a call was WRITTEN, not that it
// RESOLVED, and a sibling scan that walked only services/ + routes/ silently
// missed worker.js at the repo root. This walks the whole tree.
//
// Offline: no network, no DB connection, no keys. The CampaignRun check uses
// the REAL mongoose schema (not a stub) because the thing being verified is
// precisely that a strict schema does not silently drop the new paths.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const llmError = require('../services/llmError');
const {
  LLM_ERROR_CODES, LLM_ACTIONS, CODE_META, ADVANCES_CHAIN, CONTENT_CODES,
  classifyLlmFailure, makeLlmError, isLlmError, stampLlmAction, adoptLlmFailure,
  formatLlmLogLine, formatChainSummary, extractRequestId,
} = llmError;

let pass = 0;
const failures = [];
function check(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (err) { failures.push(name); console.log(`  ✗ ${name}\n      ${err.message}`); }
}

// ── repo scan ────────────────────────────────────────────────────────────
const SKIP_DIRS = new Set(['node_modules', '.git', 'frontend', 'coverage', 'dist', '.claude']);
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}
const ALL_JS = walk(REPO);

// An "LLM endpoint" for this harness = a TEXT model endpoint: an
// OpenAI-compatible /chat/completions or /embeddings, or a Google
// generativelanguage :generateContent.
//
// IMAGE and VIDEO endpoints are deliberately EXCLUDED and must stay excluded:
// their retry/replay semantics are governed by CLAUDE.md §2 and
// services/atlasErrorPolicy.js, where a replay is only safe on structured
// proof of pre-work rejection. An "LLM error code" refactor must never leak
// into that path.
const LLM_ENDPOINT_RE = /\/chat\/completions|\/embeddings|:generateContent/;
const IMAGE_VIDEO_ONLY = new Set([
  'services/geminiImageService.js',       // image generation
  'services/aiVideoReferenceService.js',  // Veo video operations
]);
const rel = (f) => path.relative(REPO, f);

const llmPosters = ALL_JS.filter((f) => {
  const r = rel(f);
  if (r.startsWith('scripts/')) return false;          // harnesses/tools, not the product
  if (IMAGE_VIDEO_ONLY.has(r)) return false;
  const src = fs.readFileSync(f, 'utf8');
  if (!LLM_ENDPOINT_RE.test(src)) return false;
  // Must actually ISSUE the request, not merely mention the URL in a comment.
  return /axios\.(post|request)\s*\(|fetch\s*\(/.test(src);
});

console.log('\nA. COVERAGE — every module that posts to an LLM endpoint reports coded failures');

check('A1 the scan found EXACTLY the expected LLM posters (an inventory, not a floor)', () => {
  // `>= 6` was a FLOOR, which is not an inventory: it passes while a module
  // silently drops out of the scan, and a scan that stops seeing a file is
  // exactly how an unguarded call site comes back. Enumerate instead — a new
  // LLM-posting module MUST be added here deliberately, which is the moment
  // someone asks whether it reports coded failures.
  const EXPECTED = [
    'services/atlasLlmService.js',
    'services/atlasLlmStreamService.js',
    'services/atlasTextService.js',
    'services/categoryReviewsService.js',
    'services/productDetailsService.js',
    'services/providers/geminiSearchProvider.js',
    'services/textEmbeddingService.js',
  ].sort();
  const found = llmPosters.map(rel).sort();
  assert.deepStrictEqual(found, EXPECTED,
    'the LLM-poster inventory changed. If a module was ADDED, wire it to services/llmError.js and list it here. ' +
    'If one DISAPPEARED, the scanner is broken — do not just delete the line.');
});

check('A2 every scanned LLM poster IMPORTS the shared taxonomy (not just calls it)', () => {
  // The `receiptFree` lesson: asserting a call is WRITTEN does not prove it
  // RESOLVES. Require the require().
  const missing = [];
  for (const f of llmPosters) {
    const src = fs.readFileSync(f, 'utf8');
    if (!/require\(['"][./]*(\.\.\/)?llmError['"]\)/.test(src)) missing.push(rel(f));
  }
  assert.deepStrictEqual(missing, [], `these post to an LLM endpoint but never import services/llmError.js: ${missing.join(', ')}`);
});

check('A3 every scanned LLM poster actually USES a code (import without use is theatre)', () => {
  const unused = [];
  for (const f of llmPosters) {
    const src = fs.readFileSync(f, 'utf8');
    if (!/makeLlmError\s*\(/.test(src)) unused.push(rel(f));
  }
  assert.deepStrictEqual(unused, [], `these import the taxonomy but never build a coded error: ${unused.join(', ')}`);
});

check('A4 NOBODY re-implements the taxonomy — one definition, imported', () => {
  const offenders = [];
  for (const f of ALL_JS) {
    const r = rel(f);
    if (r === 'services/llmError.js') continue;
    // This harness quotes the very patterns it searches for.
    if (r === 'scripts/verifyLlmErrorCodes.js') continue;
    const src = fs.readFileSync(f, 'utf8');
    // A second `const LLM_ERROR_CODES = {` anywhere is a fork of the taxonomy.
    if (/const\s+LLM_ERROR_CODES\s*=\s*(Object\.freeze\s*\()?\{/.test(src)) offenders.push(r);
    if (/function\s+classifyLlmFailure\s*\(/.test(src)) offenders.push(r);
  }
  assert.deepStrictEqual(offenders, [], `the taxonomy must be imported, never re-declared: ${offenders.join(', ')}`);
});

check('A5 image/video error policy is UNTOUCHED by the LLM taxonomy', () => {
  const policy = fs.readFileSync(path.join(REPO, 'services/atlasErrorPolicy.js'), 'utf8');
  assert.ok(!/llmError/.test(policy),
    'atlasErrorPolicy governs BILLABLE image/video submits — folding the LLM taxonomy into it would import "advancing is free" reasoning into a path where a replay is a second charge');
  for (const f of ['services/atlasImageService.js', 'services/atlasVideoService.js']) {
    const p = path.join(REPO, f);
    if (!fs.existsSync(p)) continue;
    assert.ok(!/require\(['"]\.\/llmError['"]\)/.test(fs.readFileSync(p, 'utf8')),
      `${f} must not adopt the LLM taxonomy — CLAUDE.md §2 submit rules are unchanged by this work`);
  }
});

console.log('\nB. CLASSES — distinct, reachable, and each one says what to DO');

check('B1 every code has meaning + operatorAction + a derived billable/retryable', () => {
  const codes = Object.keys(LLM_ERROR_CODES);
  assert.strictEqual(codes.length, 15, `expected 15 codes, saw ${codes.length}`);
  for (const c of codes) {
    assert.strictEqual(LLM_ERROR_CODES[c], c, `${c}: keys must equal values`);
    const meta = CODE_META[c];
    assert.ok(meta, `${c} has no CODE_META entry`);
    assert.ok(meta.meaning && meta.meaning.length > 4, `${c} has no meaning`);
    assert.ok(meta.operatorAction && meta.operatorAction.length > 30,
      `${c} has no operatorAction — "what a human should DO" is the point of the table`);
    assert.ok([true, false, 'unknown'].includes(meta.billable), `${c} billable must be true|false|'unknown'`);
    assert.strictEqual(typeof meta.retryable, 'boolean', `${c} retryable must be boolean`);
  }
});

check('B2 the distinct classes the owner named are each reachable and DIFFERENT', () => {
  const cases = {
    LLM_RATE_LIMITED:    { httpStatus: 429, message: 'too many requests' },
    LLM_TIMEOUT:         { errCode: 'ECONNABORTED', message: 'timeout of 75000ms exceeded' },
    LLM_BAD_REQUEST:     { httpStatus: 400, message: '{"msg":"bad request"}' },
    LLM_AUTH_REJECTED:   { httpStatus: 401, message: 'invalid api key' },
    LLM_QUOTA_EXHAUSTED: { httpStatus: 402, message: 'insufficient balance' },
    LLM_MODEL_UNROUTED:  { httpStatus: 400, message: 'router not found' },
    LLM_UPSTREAM_ERROR:  { httpStatus: 503, message: 'service unavailable' },
    LLM_NETWORK_ERROR:   { errCode: 'ECONNRESET', message: 'socket hang up' },
    LLM_UNCLASSIFIED:    {},
  };
  const seen = new Set();
  for (const [expected, input] of Object.entries(cases)) {
    const got = classifyLlmFailure(input);
    assert.strictEqual(got, expected, `${JSON.stringify(input)} classified ${got}, expected ${expected}`);
    assert.ok(!seen.has(got), `${got} produced twice — the classes must be distinct`);
    seen.add(got);
  }
});

check('B3 TIMEOUT and RATE_LIMITED are never conflated (they mean different things)', () => {
  assert.notStrictEqual(LLM_ERROR_CODES.LLM_TIMEOUT, LLM_ERROR_CODES.LLM_RATE_LIMITED);
  // The measured 429 took ~51s. If it were reported as a timeout, the operator
  // would raise ATLAS_LLM_TIMEOUT_MS — a knob that never even fired.
  assert.strictEqual(classifyLlmFailure({ httpStatus: 429, elapsedMs: 51000 }), LLM_ERROR_CODES.LLM_RATE_LIMITED);
  assert.strictEqual(CODE_META.LLM_RATE_LIMITED.billable, false, 'a 429 is a pre-work rejection — nothing was billed');
  assert.strictEqual(CODE_META.LLM_TIMEOUT.billable, 'unknown', 'a timeout is genuinely ambiguous and must SAY so');
});

check('B4 "no key configured" is its OWN code, distinct from "key rejected"', () => {
  // This is the exact silent failure behind the outage: the Director's
  // anthropic direct twin had no key and nothing said so.
  assert.notStrictEqual(LLM_ERROR_CODES.LLM_AUTH_MISSING, LLM_ERROR_CODES.LLM_AUTH_REJECTED);
  const e = makeLlmError({ code: LLM_ERROR_CODES.LLM_AUTH_MISSING, provider: 'anthropic', model: 'claude-sonnet-5' });
  assert.strictEqual(e.code, LLM_ERROR_CODES.LLM_AUTH_MISSING);
  assert.strictEqual(e.billable, false, 'we never sent a request');
  assert.ok(/key/i.test(CODE_META.LLM_AUTH_MISSING.operatorAction));
});

check('B5 quota outranks a bare 403 (do not rotate a working key during a credit outage)', () => {
  assert.strictEqual(classifyLlmFailure({ httpStatus: 403, message: 'you have exhausted your quota' }), LLM_ERROR_CODES.LLM_QUOTA_EXHAUSTED);
  assert.strictEqual(classifyLlmFailure({ httpStatus: 403, message: 'permission denied' }), LLM_ERROR_CODES.LLM_AUTH_REJECTED);
});

check('B6 CONTENT codes are HTTP-200 classes: billed, and never chain-advancing', () => {
  for (const c of ['LLM_CONTENT_EMPTY', 'LLM_CONTENT_UNPARSEABLE', 'LLM_REFUSED']) {
    assert.strictEqual(CODE_META[c].billable, true, `${c}: a 200 generated tokens and they were billed`);
    assert.ok(!ADVANCES_CHAIN.has(c), `${c} must never advance a fallback chain — that is the corrective-re-ask path`);
  }
  // And they are unreachable from classify(), which only sees failures.
  assert.notStrictEqual(classifyLlmFailure({ httpStatus: 200 }), LLM_ERROR_CODES.LLM_CONTENT_EMPTY);
});

check('B7 a garbage / hostile code or action degrades safely', () => {
  for (const bad of ['toString', 'constructor', '__proto__', '', null, 42, {}]) {
    const e = makeLlmError({ code: bad, action: bad });
    assert.strictEqual(typeof e.code, 'string', `code became ${typeof e.code} for input ${String(bad)}`);
    assert.ok(Object.prototype.hasOwnProperty.call(LLM_ERROR_CODES, e.code));
    assert.ok(Object.prototype.hasOwnProperty.call(LLM_ACTIONS, e.action));
  }
});

console.log('\nC. CONTEXT — the fields an escalation actually needs');

check('C1 request_id is preserved from an Atlas body and from an OpenAI header', () => {
  assert.strictEqual(extractRequestId({ request_id: 'atlas-123' }, {}), 'atlas-123');
  assert.strictEqual(extractRequestId({ error: { request_id: 'oai-b' } }, {}), 'oai-b');
  assert.strictEqual(extractRequestId(null, { 'X-Request-Id': 'HDR-9' }), 'HDR-9', 'header lookup must be case-insensitive');
  assert.strictEqual(extractRequestId(null, {}), null);
  assert.strictEqual(extractRequestId('a string body', null), null, 'a weird body must not throw');
});

check('C2 every required context field survives onto the thrown object', () => {
  const e = makeLlmError({
    code: 'LLM_RATE_LIMITED', provider: 'atlas', model: 'anthropic/claude-sonnet-5', role: 'director',
    httpStatus: 429, requestId: 'rq1', elapsedMs: 51000, attempt: 1, attemptsMax: 1, link: 1, linkCount: 3,
  });
  for (const f of ['code', 'action', 'provider', 'model', 'role', 'httpStatus', 'requestId',
                   'elapsedMs', 'attempt', 'attemptsMax', 'link', 'linkCount', 'retryable', 'billable']) {
    assert.ok(e[f] !== undefined, `missing ${f} — a caller cannot branch on what is not there`);
  }
  assert.strictEqual(e.llmError, true);
});

check('C3 the LEGACY .status alias survives (judgeService branches on it)', () => {
  // services/judgeService.js:322-334 retries a Cloudinary CDN race with
  // `err?.status === 400 && /Timeout while downloading/i.test(err.message)`.
  // Both halves must keep working or that retry becomes dead code silently.
  const e = makeLlmError({
    code: 'LLM_BAD_REQUEST', httpStatus: 400, provider: 'atlas', model: 'x',
    providerMessage: '{"msg":"Timeout while downloading image"}',
  });
  assert.strictEqual(e.status, 400, 'the .status alias is load-bearing for judgeService');
  assert.ok(/Timeout while downloading/i.test(e.message),
    'the PROVIDER message must survive into .message — judgeService matches on its wording');
});

check('C4 costTracker still classifies a timeout as a timeout off the message', () => {
  // costTracker.js:120 does /timeout/i.test(err?.message) to pick the CostLog
  // status. A coded message must not break that ledger distinction.
  const t = makeLlmError({ code: 'LLM_TIMEOUT', provider: 'atlas', model: 'm' });
  assert.ok(/timeout/i.test(t.message), 'CostLog would mislabel this row as a generic error');
  const r = makeLlmError({ code: 'LLM_RATE_LIMITED', provider: 'atlas', model: 'm' });
  assert.ok(!/timeout/i.test(r.message), 'a 429 must NOT be ledgered as a timeout');
});

check('C5 the log line is one dense greppable line an operator can read', () => {
  const line = formatLlmLogLine(makeLlmError({
    code: 'LLM_RATE_LIMITED', role: 'director', provider: 'atlas', model: 'anthropic/claude-sonnet-5',
    httpStatus: 429, elapsedMs: 51000, attempt: 1, attemptsMax: 1, link: 1, linkCount: 3,
    requestId: '40c25986', actionDetail: 'advanced to anthropic/claude-opus-5',
  }));
  assert.ok(line.startsWith('[LLM_RATE_LIMITED]'), line);
  for (const bit of ['role=director', 'provider=atlas', 'model=anthropic/claude-sonnet-5',
                     'status=429', 'after=51.0s', 'link=1/3', 'request_id=40c25986',
                     'advanced to anthropic/claude-opus-5']) {
    assert.ok(line.includes(bit), `log line missing ${bit}:\n  ${line}`);
  }
  assert.ok(!/\n/.test(line), 'must be ONE line');
  assert.ok(!/undefined/.test(line), 'never print undefined');
  const sparse = formatLlmLogLine(makeLlmError({ code: 'LLM_TIMEOUT' }));
  assert.ok(!/undefined|status=|link=/.test(sparse), `absent fields must be omitted, not blank: ${sparse}`);
});

console.log('\nD. ACTIONS — "what steps were taken next", truthfully');

check('D1 the action enum covers every outcome the owner named', () => {
  for (const a of ['RETRIED_SAME_MODEL', 'ADVANCED_TO_NEXT_LINK', 'FELL_BACK_TO_DIRECT_PROVIDER',
                   'CORRECTIVE_REASK', 'SKIPPED_NO_KEY', 'GAVE_UP_PRODUCT', 'GAVE_UP_RUN', 'EXHAUSTED_CHAIN']) {
    assert.strictEqual(LLM_ACTIONS[a], a, `missing action ${a}`);
  }
  assert.ok(Object.isFrozen(LLM_ACTIONS));
});

check('D2 re-stamping an action rewrites cleanly and never corrupts the diagnosis', () => {
  const e = makeLlmError({ code: 'LLM_RATE_LIMITED', provider: 'atlas', model: 'm', httpStatus: 429 });
  const base = e.baseMessage;
  stampLlmAction(e, LLM_ACTIONS.RETRIED_SAME_MODEL, 'retrying m (attempt 2 of 3)');
  stampLlmAction(e, LLM_ACTIONS.ADVANCED_TO_NEXT_LINK, 'advanced to n');
  stampLlmAction(e, LLM_ACTIONS.EXHAUSTED_CHAIN, 'gave up — every candidate failed');
  assert.strictEqual(e.action, LLM_ACTIONS.EXHAUSTED_CHAIN);
  assert.ok(e.message.startsWith(base), 'the diagnosis must survive every re-stamp intact');
  assert.ok(e.message.endsWith('gave up — every candidate failed'));
  assert.ok(!/retrying m/.test(e.message), 'a superseded action must not linger and read as a lie');
});

check('D3 a chain summary reads as ONE sequence with each result', () => {
  const s = formatChainSummary([
    { provider: 'atlas', model: 'anthropic/claude-sonnet-5', code: 'LLM_RATE_LIMITED', httpStatus: 429, ms: 51000, ok: false },
    { provider: 'atlas', model: 'anthropic/claude-opus-5', code: 'LLM_RATE_LIMITED', httpStatus: 429, ms: 50000, ok: false },
    { provider: 'atlas', model: 'openai/gpt-5.6-terra', httpStatus: 200, ms: 1000, ok: true },
  ]);
  assert.strictEqual(s, 'tried anthropic/claude-sonnet-5 (429, 51.0s) → anthropic/claude-opus-5 (429, 50.0s) → openai/gpt-5.6-terra (ok, 1.0s)');
  assert.strictEqual(formatChainSummary(null), '(no attempts recorded)', 'never fabricate a chain that was not recorded');
});

check('D4 the ACTION is stamped by control flow, never hardcoded beside a call site', () => {
  // Structural pin for the truthfulness rule: the transport must not build an
  // error with a recovery action baked in — it stamps AFTER the branch runs.
  //
  // The first version of this used /makeLlmError\(\{[^}]*action:/ and was a
  // FALSE PASS waiting to happen: `[^}]*` stops at the FIRST `}`, so any
  // nested object or template literal before `action:` (and makeLlmError calls
  // routinely carry both) hid the very thing being checked. Parse the balanced
  // call instead of pattern-matching across it.
  const src = fs.readFileSync(path.join(REPO, 'services/atlasLlmService.js'), 'utf8');

  // Extract each makeLlmError({...}) argument with a brace-depth scan, so a
  // nested `{` can never truncate the region under inspection.
  const calls = [];
  const NEEDLE = 'makeLlmError({';
  for (let i = src.indexOf(NEEDLE); i >= 0; i = src.indexOf(NEEDLE, i + 1)) {
    let depth = 0;
    let end = -1;
    for (let j = i + NEEDLE.length - 1; j < src.length; j++) {
      const c = src[j];
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end > 0) calls.push(src.slice(i, end + 1));
  }
  assert.ok(calls.length >= 3, `expected several makeLlmError call sites, parsed ${calls.length}`);

  // Prove the parser actually sees nested braces — otherwise this check could
  // be passing for the same reason the old regex did.
  assert.ok(calls.some((c) => (c.match(/\{/g) || []).length > 1),
    'the balanced-call parser found no nested braces at all — it is not doing what this check claims');

  const RECOVERY = ['ADVANCED_TO_NEXT_LINK', 'FELL_BACK_TO_DIRECT_PROVIDER', 'RETRIED_SAME_MODEL'];
  for (const call of calls) {
    for (const act of RECOVERY) {
      assert.ok(!new RegExp(`action:\\s*LLM_ACTIONS\\.${act}`).test(call),
        `a recovery action (${act}) is set at CONSTRUCTION — it would claim a step that had not happened yet:\n${call.slice(0, 200)}`);
    }
  }

  // And the stamps must be real calls, not comments mentioning the constant.
  const stripComments = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  for (const act of ['ADVANCED_TO_NEXT_LINK', 'EXHAUSTED_CHAIN', 'FELL_BACK_TO_DIRECT_PROVIDER']) {
    assert.ok(new RegExp(`stampLlmAction\\([^,]+,\\s*LLM_ACTIONS\\.${act}`).test(stripComments),
      `${act} must be stamped by a real call at the branch that took it (comments do not count)`);
  }
});

console.log('\nE. THE OPERATOR SURFACE — CampaignRun.errors[] through the STRICT schema');

check('E1 CampaignRun.errors[] round-trips code/action/chain (strict schemas drop undeclared paths)', () => {
  const mongoose = require('mongoose');
  delete mongoose.connection.models.CampaignRun;
  const CampaignRun = require('../models/CampaignRun');
  const doc = new CampaignRun({
    campaignId: new mongoose.Types.ObjectId(),
    brandId: new mongoose.Types.ObjectId(),
    errors: [{
      index: 0, stage: 'expand', productId: 'p1',
      code: 'LLM_RATE_LIMITED',
      action: 'GAVE_UP_PRODUCT',
      chain: 'tried a (429, 51.0s) → b (429, 50.0s)',
      message: '[LLM_RATE_LIMITED] Error: ...',
    }],
  });
  const e = doc.errors[0];
  assert.strictEqual(e.code, 'LLM_RATE_LIMITED', 'code was DROPPED — declare it on the schema (the renderError.predictionId trap)');
  assert.strictEqual(e.action, 'GAVE_UP_PRODUCT', 'action was dropped');
  assert.ok(/429/.test(e.chain || ''), 'chain summary was dropped');
});

check('E2 CampaignRun.perProduct round-trips the same taxonomy', () => {
  const mongoose = require('mongoose');
  const CampaignRun = mongoose.model('CampaignRun');
  const doc = new CampaignRun({
    campaignId: new mongoose.Types.ObjectId(),
    brandId: new mongoose.Types.ObjectId(),
    perProduct: [{ productId: 'p1', reason: 'error', errorCode: 'LLM_TIMEOUT', errorAction: 'GAVE_UP_PRODUCT', errorChain: 'tried a (timeout, 75.0s)' }],
  });
  assert.strictEqual(doc.perProduct[0].errorCode, 'LLM_TIMEOUT');
  assert.strictEqual(doc.perProduct[0].errorAction, 'GAVE_UP_PRODUCT');
});

check('E3 the normaliser COPIES the taxonomy through (it is the only writer)', () => {
  const { normalizePerProductEntry } = require('../services/perProductReasons');
  const out = normalizePerProductEntry({
    productId: 'p1', skipped: 'error', error: 'boom', errorName: 'Error',
    errorCode: 'LLM_RATE_LIMITED', errorAction: 'GAVE_UP_PRODUCT', errorChain: 'tried a (429, 51.0s)',
  });
  assert.strictEqual(out.errorCode, 'LLM_RATE_LIMITED', 'a field the normaliser does not copy is one the operator never sees');
  assert.strictEqual(out.errorAction, 'GAVE_UP_PRODUCT');
  assert.ok(/429/.test(out.errorChain || ''));
});

check('E4 the route stamps the code onto the errors[] entry it pushes', () => {
  const src = fs.readFileSync(path.join(REPO, 'routes/ads.js'), 'utf8');
  const block = src.slice(src.indexOf('const errorEntries = productErrors.map'), src.indexOf('const errorEntries = productErrors.map') + 900);
  assert.ok(/code:\s*r\.errorCode/.test(block), 'the run error entry must carry the machine code');
  assert.ok(/action:\s*r\.errorAction/.test(block), 'and what the system did about it');
  assert.ok(/chain:\s*r\.errorChain/.test(block), 'and the chain summary');
});

console.log('\nG. THE ORIGINAL OUTAGE CLASS — zero-ads Director failures must be CODED');

// Every one of these ends in ZERO STATIC ADS for a product. Before 2026-08-18
// they all threw plain Errors, so `isLlmError` was false in the per-product
// dispatcher: none paged, and each recorded `errorCode: null` on
// CampaignRun.errors[]. Not an edge case — CLAUDE.md records 10 Director round
// failures to 1 success in 24h from prose responses.
const DIRECTOR_SRC = fs.readFileSync(path.join(REPO, 'services/aiCreativeDirectorService.js'), 'utf8');

const ZERO_AD_THROWS = [
  ['Director (round) returned no content',      'LLM_CONTENT_EMPTY'],
  ['Director (round) response truncated at',    'LLM_CONTENT_TRUNCATED'],
  ['Director (round) response not JSON',        'LLM_CONTENT_UNPARSEABLE'],
  ['Director (round) returned no usable concepts', 'LLM_CONTRACT_UNMET'],
  ['Director returned no content',              'LLM_CONTENT_EMPTY'],
  ['Director response not JSON',                'LLM_CONTENT_UNPARSEABLE'],
];

check('G1 every zero-ads Director throw is ADOPTED into the taxonomy', () => {
  // The messages stay byte-identical (they reach the operator through
  // CampaignRun.errors[].message, and two are pinned by
  // verifyDirectorJsonSalvage) — what changed is that the thrown object now
  // carries a code. So the pin is: every occurrence of the message that is
  // being THROWN sits inside an adoptLlmFailure(...) call, never bare.
  //
  // Deliberately index-based rather than a built regex: escaping a message
  // that contains parentheses into a dynamic RegExp is exactly the kind of
  // fiddly construction that silently matches nothing and passes.
  for (const [msg] of ZERO_AD_THROWS) {
    let found = 0;
    for (let i = DIRECTOR_SRC.indexOf(msg); i >= 0; i = DIRECTOR_SRC.indexOf(msg, i + 1)) {
      // Walk back to the statement that produces this message.
      const before = DIRECTOR_SRC.slice(Math.max(0, i - 160), i);
      if (!/throw\s|new Error\(/.test(before)) continue;      // a comment or a log line
      found++;
      assert.ok(/adoptLlmFailure\(/.test(before),
        `"${msg}" is thrown BARE — it will not page and will record errorCode: null:\n    …${before.slice(-120)}`);
    }
    assert.ok(found > 0, `"${msg}" no longer appears as a throw — did the message change?`);
  }
});

check('G2 each zero-ads failure classifies to a CONTENT code, never a transport one', () => {
  for (const [, code] of ZERO_AD_THROWS) {
    assert.ok(CONTENT_CODES.has(code), `${code} must be a content class`);
    // …and therefore must never advance the fallback chain (a different model
    // does not fix prompt compliance, and advancing multiplies PAID calls).
    assert.ok(!ADVANCES_CHAIN.has(code), `${code} must never advance the chain`);
    assert.strictEqual(CODE_META[code].billable, true, `${code} is an HTTP 200 — the tokens were billed`);
  }
  // All four distinct codes are actually referenced by the Director.
  for (const c of ['LLM_CONTENT_EMPTY', 'LLM_CONTENT_TRUNCATED', 'LLM_CONTENT_UNPARSEABLE', 'LLM_CONTRACT_UNMET']) {
    assert.ok(DIRECTOR_SRC.includes(c), `the Director never raises ${c} — the taxonomy defines it and nothing uses it`);
  }
});

check('G3 adoption makes a plain Error dispatcher-visible WITHOUT changing its message', () => {
  const original = 'Director (round) returned no usable concepts: two concepts share a headline';
  const err = new Error(original);
  const coded = makeLlmError({
    code: LLM_ERROR_CODES.LLM_CONTRACT_UNMET,
    action: LLM_ACTIONS.GAVE_UP_PRODUCT,
    actionDetail: 'gave up this product — no ads are minted for it (video is unaffected)',
    httpStatus: 200, provider: 'atlas', model: 'openai/gpt-5.6-terra',
  });
  adoptLlmFailure(err, coded);
  assert.strictEqual(err.message, original, 'the operator-facing message must be untouched');
  assert.strictEqual(isLlmError(err), true, 'the dispatcher branches on isLlmError — this is the whole fix');
  assert.strictEqual(err.code, LLM_ERROR_CODES.LLM_CONTRACT_UNMET);
  assert.strictEqual(err.action, LLM_ACTIONS.GAVE_UP_PRODUCT);
  assert.strictEqual(err.billable, true);
});

check('G4 adoption NEVER overwrites a more specific classification', () => {
  // A transport failure that bubbles up through a content-level catch keeps its
  // own diagnosis — otherwise a 429 would be reported as "unusable output" and
  // the operator would go tuning prompts during a capacity outage.
  const transport = makeLlmError({ code: LLM_ERROR_CODES.LLM_RATE_LIMITED, httpStatus: 429 });
  adoptLlmFailure(transport, makeLlmError({ code: LLM_ERROR_CODES.LLM_CONTENT_EMPTY }));
  assert.strictEqual(transport.code, LLM_ERROR_CODES.LLM_RATE_LIMITED, 'first classification wins');
  // And a null classification is a no-op, never a crash.
  const plain = new Error('x');
  assert.strictEqual(adoptLlmFailure(plain, null), plain);
  assert.ok(!plain.llmError);
  assert.doesNotThrow(() => adoptLlmFailure(null, null));
});

check('G5 the dispatcher pages content failures under their OWN key, at fatal', () => {
  const camp = fs.readFileSync(path.join(REPO, 'services/campaignAdsGenerationService.js'), 'utf8');
  assert.ok(/CONTENT_CODES\.has\(llmFail\.code\)/.test(camp),
    'the split must read the shared CONTENT_CODES set, not a hand-copied list that drifts');
  assert.ok(/director:content-failure/.test(camp), 'content failures need their own dedupe identity');
  assert.ok(/UNUSABLE/.test(camp), 'the content alert must say what is wrong in plain words');
  // Same severity: the operator impact is identical (zero ads).
  const levels = camp.match(/level:\s*'fatal'/g) || [];
  assert.ok(levels.length >= 1, 'a zero-ads outage is fatal-channel material whichever half it is');
  assert.ok(/minCount:\s*2/.test(camp), 'still the owner\'s "more than once" threshold');
});

check('G6 the error CODE reaches CampaignRun.errors[] for a content failure too', () => {
  const camp = fs.readFileSync(path.join(REPO, 'services/campaignAdsGenerationService.js'), 'utf8');
  // errorCode is derived from the coded error, not from a transport-only branch.
  assert.ok(/errorCode:\s*llmFail \? llmFail\.code : null/.test(camp),
    'errorCode must come from the coded error so a content failure stops recording null');
});

console.log('\nF. DOCS — the code table exists and matches the code');

check('F1 docs/ALERTING.md carries every code WITH its operator-action column', () => {
  // A bare `doc.includes(CODE)` was satisfied by any mention anywhere — the
  // "what to DO" column is the whole point of the table, so pin the ROW.
  const doc = fs.readFileSync(path.join(REPO, 'docs/ALERTING.md'), 'utf8');
  const rows = doc.split('\n').filter((l) => l.trim().startsWith('|'));
  for (const c of Object.keys(LLM_ERROR_CODES)) {
    const row = rows.find((l) => l.includes('`' + c + '`'));
    assert.ok(row, `docs/ALERTING.md has no table ROW for ${c}`);
    const cells = row.split('|').map((x) => x.trim()).filter(Boolean);
    assert.ok(cells.length >= 4,
      `${c}: row must carry code | means | billable | what-to-DO — got ${cells.length} cells`);
    const action = cells[cells.length - 1];
    assert.ok(action.length > 25,
      `${c}: the "what to DO" cell is empty or a stub (${JSON.stringify(action)})`);
    // billable must be one of the three real values, not prose.
    assert.ok(/`(true|false|unknown)`/.test(cells[2]),
      `${c}: billable cell must be \`true\`/\`false\`/\`unknown\`, got ${JSON.stringify(cells[2])}`);
  }
});

check('F2 every code in the docs table is a REAL code (no stale rows)', () => {
  const doc = fs.readFileSync(path.join(REPO, 'docs/ALERTING.md'), 'utf8');
  const mentioned = new Set((doc.match(/`LLM_[A-Z_]+`/g) || []).map((m) => m.replace(/`/g, '')));
  for (const m of mentioned) {
    assert.ok(Object.prototype.hasOwnProperty.call(LLM_ERROR_CODES, m),
      `docs/ALERTING.md documents ${m}, which no longer exists in the taxonomy`);
  }
});

const total = pass + failures.length;
console.log(`\n${failures.length ? '✗' : '✓'} verifyLlmErrorCodes: ${pass}/${total} passed`);
if (failures.length) {
  console.log(`  failed: ${failures.join(', ')}`);
  process.exit(1);
}
