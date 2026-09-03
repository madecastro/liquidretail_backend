#!/usr/bin/env node
'use strict';
//
// verifyGeminiVideoProvider — the money pins for the direct-Gemini video path.
//
// WHY THESE AND NOT OTHERS. Every check here exists because getting it wrong
// costs real money or silently loses a paid asset. The failure modes are all
// MEASURED, not hypothetical:
//
//   * Exceeding the rate cap returns HTTP 200 + an interaction_id, and the
//     rejection arrives on the FIRST POLL as `too_many_requests`. So an
//     accepted id is the charge point. Porting Atlas's isDefinite429 shape
//     would read that as "rejected before work began" and resubmit.
//   * `background:false` bills SYNCHRONOUSLY — that is how a stray $0.36 got
//     spent during an earlier validation pass.
//   * `finalizeFlatCost` always does `$set costUsd: Number(x)||0`, so an
//     absent cost silently becomes $0 on a real charge.
//   * Gemini NEVER returns `price`. Atlas's "no price ⇒ unbilled" inference
//     would mark every completion unbilled and resubmit forever.
//   * The cap is per-PROJECT per-model, so an in-process limiter gives each
//     autoscaled instance the full budget of 8.
//
// OFFLINE. No network, no DB, no API key. The provider module requires axios,
// which a BARE adgen worktree deliberately does not have (see CLAUDE.md — an
// npm ci here breaks verifyModelParity), so the pure functions are extracted
// from source and evaluated in isolation rather than required.
//
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const SVC = path.join(ROOT, 'src', 'services');
const PROVIDER_SRC = fs.readFileSync(path.join(SVC, 'geminiVideoService.js'), 'utf8');
const LEASE_SRC = fs.readFileSync(path.join(SVC, 'geminiVideoLease.js'), 'utf8');

// STRIP COMMENTS BEFORE ANY SOURCE SCAN.
//
// This harness's first run failed B2/F1/F4 by matching the provider's OWN
// EXPLANATORY COMMENTS — the header documents "background:false bills
// synchronously", "confirmedCharge from a missing price" and
// "pacedModelSubmit / semaphore.js as the cap" precisely so a future reader
// knows not to do those things, and a naive regex read those warnings as the
// defects they warn about. Exactly the trap verifyLlmErrorCodes D5 records
// ("fooled by its OWN explanatory comment containing the string it
// searched for").
//
// Regex-literal aware: a bare quote-tracker desyncs for the rest of a file
// the moment it meets `/re/` and mistakes the slashes for division, which
// would silently un-strip everything after it.
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let inS = null;       // ' " ` when inside a string
  let inRe = false;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (inS) {
      out += c;
      if (c === '\\') { out += d || ''; i += 2; continue; }
      if (c === inS) inS = null;
      i += 1; continue;
    }
    if (inRe) {
      out += c;
      if (c === '\\') { out += d || ''; i += 2; continue; }
      if (c === '/') inRe = false;
      i += 1; continue;
    }
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1; i += 2; continue; }
    if (c === '\'' || c === '"' || c === '`') { inS = c; out += c; i += 1; continue; }
    if (c === '/') {
      // Division vs regex: a regex can only start where a value cannot have
      // just ended. Look back at the last significant char.
      const prev = out.replace(/\s+$/, '').slice(-1);
      if (prev === '' || '(,=:[!&|?{};+-*%~^<>'.includes(prev)) { inRe = true; out += c; i += 1; continue; }
    }
    out += c; i += 1;
  }
  return out;
}
const PROVIDER_CODE = stripComments(PROVIDER_SRC);
const LEASE_CODE = stripComments(LEASE_SRC);

let pass = 0;
const failures = [];
function check(label, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); return; }
  failures.push(detail ? `${label} — ${detail}` : label);
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
}

// Extract a top-level function by name and eval it with the constants it
// closes over. Keeps this harness offline without stubbing axios/mongoose.
function extract(name) {
  const re = new RegExp(`\\nfunction ${name}\\([\\s\\S]*?\\n\\}`);
  const m = PROVIDER_SRC.match(re);
  if (!m) throw new Error(`could not extract ${name}`);
  return m[0];
}
const SANDBOX_PRELUDE = `
const MODEL = 'gemini-omni-1.1-flash';
const DEFAULT_RESOLUTION = '1080p';
const SUPPORTED_ASPECTS = new Set(['16:9','9:16']);
const PRICED_RESOLUTIONS = new Set(['720p','1080p']);
const USD_PER_M_INPUT = 1.50, USD_PER_M_TEXT_OUT = 9.00, USD_PER_M_VIDEO_OUT = 17.50;
const VIDEO_TOKENS_PER_SEC = 5792;
`;
function load(...names) {
  const body = SANDBOX_PRELUDE + names.map(extract).join('\n') +
    `\nreturn {${names.join(',')}};`;
  // eslint-disable-next-line no-new-func
  return new Function(body)();
}
// videoTokensOf must load in the SAME sandbox as computeCost — computeCost
// calls it, so omitting it gives a ReferenceError at first use rather than a
// failed assertion, which reads as a harness crash instead of a defect.
const { buildRequestBody, computeCost, estimateCost, classifyPoll, videoTokensOf, extractVideoUri } =
  load('videoTokensOf', 'buildRequestBody', 'computeCost', 'estimateCost', 'classifyPoll', 'extractVideoUri');

console.log('\nverifyGeminiVideoProvider\n');

// ── A. THE REQUEST SHAPE (measured; a guess already cost an HTTP 400) ──────
console.log('A. request shape — measured, not inferred');
{
  const b = buildRequestBody({
    images: [{ buffer: Buffer.from('abc'), mimeType: 'image/jpeg' }],
    prompt: 'P', aspectRatio: '9:16', resolution: '1080p', durationSec: 10
  });
  check('A1 top-level key is `input`, not `inputs`',
    Array.isArray(b.input) && b.inputs === undefined);
  check('A2 input is a FLAT typed list (no role/parts wrapper)',
    b.input.every((x) => typeof x.type === 'string' && !('role' in x) && !('parts' in x)),
    JSON.stringify(b.input.map((x) => Object.keys(x))));
  check('A3 the text part is LAST', b.input[b.input.length - 1].type === 'text');
  check('A4 duration is a STRING like "10s", never an integer',
    typeof b.response_format.duration === 'string' && /^\d+(\.\d+)?s$/.test(b.response_format.duration),
    JSON.stringify(b.response_format.duration));
  check('A5 task is reference_to_video',
    b.generation_config.video_config.task === 'reference_to_video');
  check('A6 delivery is uri and store is true (uri requires store)',
    b.response_format.delivery === 'uri' && b.store === true);
  check('A7 stream is false', b.stream === false);
}

// ── B. background:true IS A MONEY GUARD ───────────────────────────────────
console.log('\nB. background:true — the synchronous-billing guard');
{
  const shapes = [
    ['9:16 1080p 10s', { aspectRatio: '9:16', resolution: '1080p', durationSec: 10 }],
    ['16:9 720p 3s',   { aspectRatio: '16:9', resolution: '720p',  durationSec: 3 }],
    ['no duration',    { aspectRatio: '9:16', resolution: '1080p', durationSec: null }]
  ];
  for (const [name, args] of shapes) {
    const b = buildRequestBody({ images: [], prompt: 'x', ...args });
    check(`B1 ${name}: background === true`, b.background === true);
  }
  // Source-level too: a future edit that flips it must fail here, not in prod.
  check('B2 the literal `background: false` appears nowhere in the provider',
    !/background:\s*false/.test(PROVIDER_CODE));
  check('B3 the header records WHY (the $0.36 accidental charge)',
    /bills? IMMEDIATELY|BILLS IMMEDIATELY/i.test(PROVIDER_SRC) && /0\.36/.test(PROVIDER_SRC));
}

// ── C. ASPECT — only two are accepted; everything else derives ────────────
console.log('\nC. aspect ratio — probed enum, safe fallback');
{
  for (const [inp, want] of [['9:16', '9:16'], ['16:9', '16:9'], ['1:1', '9:16'], ['4:5', '9:16'], [null, '9:16']]) {
    const b = buildRequestBody({ images: [], prompt: 'x', aspectRatio: inp, resolution: '720p', durationSec: 10 });
    check(`C1 ${JSON.stringify(inp)} -> ${want}`, b.response_format.aspect_ratio === want,
      b.response_format.aspect_ratio);
  }
}

// ── D. COST — the zeroing hazard is the point of this group ───────────────
console.log('\nD. cost — never silently $0 on a real charge');
{
  // The MEASURED 1080p run: 3,539 in / 57,920 video / 59,127 total out.
  const c = computeCost({ total_input_tokens: 3539, total_output_tokens: 59127, video_tokens: 57920 }, '1080p');
  check('D1 measured 1080p run prices to ~$1.035 (settled $1.0351)',
    c.costSource === 'actual' && Math.abs(c.costUsd - 1.0351) < 0.01,
    JSON.stringify(c));
  check('D2 720p at the same token count prices identically (measured equal)',
    Math.abs(computeCost({ total_input_tokens: 3539, total_output_tokens: 59127, video_tokens: 57920 }, '720p').costUsd - c.costUsd) < 1e-9);
  // THE HAZARD: an unpriced resolution must be 'unknown', NEVER 0. If this
  // returns 0 it flows into finalizeFlatCost's `Number(x)||0` and a real
  // charged master is ledgered free.
  for (const res of ['4k', '360p', '480p', '', null, undefined]) {
    const u = computeCost({ total_input_tokens: 1, total_output_tokens: 57921, video_tokens: 57920 }, res);
    check(`D3 unpriced resolution ${JSON.stringify(res)} -> unknown, NOT 0`,
      u.costSource === 'unknown' && u.costUsd === null, JSON.stringify(u));
  }
  check('D4 absent usage -> unknown, NOT 0',
    computeCost(null, '1080p').costSource === 'unknown' && computeCost(null, '1080p').costUsd === null);
  check('D5 zero video tokens -> unknown, NOT 0 (a completion with no video is not free)',
    computeCost({ total_input_tokens: 10, total_output_tokens: 10, video_tokens: 0 }, '1080p').costSource === 'unknown');
  // Thoughts are INSIDE total_output_tokens; adding them separately would
  // double-charge. Text-out must be derived by subtraction.
  check('D6 text-out is derived by subtraction, not added on top',
    /outTok\s*-\s*videoTok/.test(PROVIDER_SRC));
  const e = estimateCost({ durationSec: 10, resolution: '1080p' });
  check('D7 pre-submit estimate is a floor, tagged estimated',
    e.costSource === 'estimated' && e.costUsd > 0 && e.costUsd <= 1.0351, JSON.stringify(e));
  check('D8 estimate for an unpriced resolution is unknown, NOT 0',
    estimateCost({ durationSec: 10, resolution: '4k' }).costSource === 'unknown');
}

// ── E. THE CHARGE-POINT CONTRACT (the double-bill) ────────────────────────
console.log('\nE. charge point — an accepted id is possibly billed');
{
  const rr = classifyPoll({ error: { code: 'too_many_requests' } });
  check('E1 poll `too_many_requests` is TERMINAL, not retryable',
    rr.state === 'rate_rejected' && rr.retryable === false, JSON.stringify(rr));
  check('E2 poll `too_many_requests` is possibly BILLED (an id already exists)',
    rr.billed === 'possible', JSON.stringify(rr));
  check('E3 completed is billed', classifyPoll({ status: 'completed' }).billed === 'yes');
  check('E4 failed is possibly billed, never provably free',
    classifyPoll({ status: 'failed' }).billed === 'possible');
  check('E5 pending is not retryable-as-resubmit',
    classifyPoll({ status: 'running' }).retryable === false);
  // No classification may ever be BOTH not-billed and retryable except a
  // structured pre-work rejection, which never reaches classifyPoll.
  for (const body of [{}, { status: 'queued' }, { status: 'processing' }, { error: {} }]) {
    const v = classifyPoll(body);
    check(`E6 ${JSON.stringify(body)} never claims provably-unbilled`,
      v.billed !== 'no', JSON.stringify(v));
  }
  check('E7 submit returns an id whenever one exists, regardless of HTTP status',
    /if \(id\) \{[\s\S]{0,200}interactionId/.test(PROVIDER_SRC));
  check('E8 only a 4xx WITH a structured error body is marked provably unbilled',
    /billed = \(res\.status >= 400 && res\.status < 500 && res\.data\?\.error\) \? 'no' : 'possible'/.test(PROVIDER_SRC));
  check('E9 a transport throw is marked possibly billed',
    /err\.billed = 'possible'/.test(PROVIDER_SRC));
}

// ── F. WHAT MUST NOT BE PORTED FROM ATLAS ─────────────────────────────────
console.log('\nF. Atlas inferences that must NOT appear here');
{
  check('F1 no `confirmedCharge` inference (Gemini never returns `price`)',
    !/confirmedCharge/.test(PROVIDER_CODE));
  check('F2 does not read a `price` field off the provider',
    !/\.price\b/.test(PROVIDER_CODE));
  check('F3 does not import Atlas submit-retry semantics',
    !/submitRetryDecision|isDefinite429/.test(PROVIDER_CODE));
  check('F4 does not use pacedModelSubmit or the in-process semaphore as the cap',
    !/pacedModelSubmit|require\(['"]\.\/semaphore/.test(PROVIDER_CODE));
  // SCOPED TO THE POST CALL, not the whole file.
  //
  // The first version of this check was VACUOUS and revert-proving is the only
  // reason we know: it asserted /maxRedirects:\s*0/ anywhere in the source, so
  // deleting it from the billable POST still passed on the strength of the
  // free GET's copy. The POST is the one that matters — axios defaults to 21
  // redirects and RE-SENDS THE BODY on 307/308, which is a second billable
  // generation inside one call, invisible to every retry guard.
  const postCall = (() => {
    const i = PROVIDER_CODE.indexOf('axios.post(');
    if (i < 0) return '';
    // Bound the slice at the end of the options object, not a magic length.
    const rest = PROVIDER_CODE.slice(i);
    const end = rest.indexOf('});');
    return end < 0 ? rest : rest.slice(0, end + 3);
  })();
  check('F5 the axios.post call was located', postCall.length > 0);
  check('F5a maxRedirects:0 is INSIDE the billable POST call (not merely somewhere in the file)',
    /maxRedirects:\s*0/.test(postCall), JSON.stringify(postCall.slice(0, 160)));
  const getCall = (() => {
    const i = PROVIDER_CODE.indexOf('axios.get(');
    if (i < 0) return '';
    const rest = PROVIDER_CODE.slice(i);
    const end = rest.indexOf('});');
    return end < 0 ? rest : rest.slice(0, end + 3);
  })();
  check('F5b the free GET carries it too (a redirected GET is free but still wrong)',
    /maxRedirects:\s*0/.test(getCall));
  check('F6 the POST is the ONLY axios.post in the file',
    (PROVIDER_SRC.match(/axios\.post\(/g) || []).length === 1);
  check('F7 resume/peek use GET only',
    /axios\.get\(/.test(PROVIDER_SRC) && !/axios\.post[\s\S]{0,400}resumeForAd/.test(PROVIDER_SRC));
  check('F8 resumeForAd contains no submit call',
    !/function resumeForAd[\s\S]*?\n\}/.exec(PROVIDER_SRC)[0].includes('submitGeneration'));
}

// ── G. THE LEASE IS GLOBAL AND FAILS CLOSED ───────────────────────────────
console.log('\nG. concurrency lease — global, fails closed, safe under both readings');
{
  check('G1 the lease lives in Mongo, not in process memory',
    /mongoose/.test(LEASE_SRC) && /findOneAndUpdate/.test(LEASE_SRC));
  check('G2 no Mongo -> acquire returns null (FAIL CLOSED, never submit unproven)',
    /if \(!c\) return null;/.test(LEASE_SRC));
  check('G3 holds BOTH an occupancy and a rate constraint (occupancy-vs-RPM unproven)',
    /acquiredInWindow >= MAX_SLOTS/.test(LEASE_SRC) && /slot < MAX_SLOTS/.test(LEASE_SRC));
  check('G4 default cap is 8 (the measured limit)', /:\s*8;/.test(LEASE_SRC));
  check('G5 duplicate-key on a contended slot is handled, not fatal',
    /11000/.test(LEASE_SRC));
  check('G6 a unique (scope, slot) index makes the race decidable',
    /createIndex\(\{ scope: 1, slot: 1 \}, \{ unique: true \}\)/.test(LEASE_SRC));
  check('G7 release only clears OUR hold (a stolen slot is not released late)',
    /\{ scope, slot, releasedAt: null \}/.test(LEASE_SRC));
  check('G8 the TTL is NOT derived from any poll ceiling (the REFRAME_CLAIM drift lesson)',
    /NOT DERIVED FROM THE POLL BUDGET/i.test(LEASE_SRC) && !/MAX_POLL_MS/.test(LEASE_CODE));
  check('G9 the TTL has a hard floor so a typo cannot make leases instantly stale',
    /Math\.max\(v, 120_000\)/.test(LEASE_SRC));
  check('G10 the lease is documented as a MONEY control, not politeness',
    /MONEY CONTROL|money control/i.test(LEASE_SRC));
}

// ── H. PROVIDER TAGGING — so recovery can route ───────────────────────────
console.log('\nH. provider tagging — recovery must not Atlas-GET a Gemini id');
{
  check('H1 a provider tag exists', /const PROVIDER = 'gemini'/.test(PROVIDER_SRC));
  check('H2 a distinct cost stage exists', /const COST_STAGE = 'gemini_video_render'/.test(PROVIDER_SRC));
  check('H3 the receipt field is the EXISTING Ad.veoPredictionId, not a new one',
    /veoPredictionId/.test(PROVIDER_SRC) && !/geminiPredictionId/.test(PROVIDER_CODE));
  check('H4 the endpoint is the measured one',
    /generativelanguage\.googleapis\.com\/v1beta\/interactions/.test(PROVIDER_SRC));
  check('H5 the model is the GA id, not the Vertex-only preview id',
    /gemini-omni-1\.1-flash/.test(PROVIDER_SRC) && !/gemini-omni-1\.1-flash-preview/.test(PROVIDER_SRC));
}

// ── I. THE REAL RESPONSE — both shapes that were wrong when INFERRED ──────
//
// scripts/fixtures/gemini-terminal-9x16.json is an ACTUAL terminal response
// captured from the 2026-09-03 gate run (Vaportek Worldwide Wahoo, 1080p
// 9:16, $1.0305 settled). It exists because two field paths in this provider
// were wrong, both from inferring a name instead of reading a response, and
// neither was findable offline:
//
//   * cost read `usage.video_tokens` — DOES NOT EXIST. Real path is
//     usage.output_tokens_by_modality[].modality === 'video'. Consequence:
//     every real generation priced as 'unknown'; no master ever priced.
//   * the URI was read at `output.uri` — real path is the model_output STEP,
//     steps[].content[] where type === 'video'. Consequence: a SUCCEEDED,
//     BILLED generation threw GEMINI_NO_OUTPUT_URI — a ~$1.03 master lost on
//     every single call.
//
// Asserting against a real captured response is the only pin that could have
// caught either. A hand-written stub would have encoded the same guess.
console.log('\nI. real captured response — the two inferred-wrong shapes');
{
  const FIX = path.join(__dirname, 'fixtures', 'gemini-terminal-9x16.json');
  check('I0 the fixture exists', fs.existsSync(FIX));
  if (fs.existsSync(FIX)) {
    const real = JSON.parse(fs.readFileSync(FIX, 'utf8'));
    check('I1 videoTokensOf finds 57920 in the REAL nested shape',
      videoTokensOf(real.usage) === 57920, String(videoTokensOf(real.usage)));
    check('I2 a flat usage.video_tokens does NOT exist on the real response',
      real.usage.video_tokens === undefined);
    check('I3 the nested modality array is where it actually lives',
      Array.isArray(real.usage.output_tokens_by_modality) &&
      real.usage.output_tokens_by_modality.some((m) => m.modality === 'video'));

    const cost = computeCost(real.usage, '1080p');
    check('I4 the real response prices to the settled $1.0305 (±$0.005)',
      cost.costSource === 'actual' && Math.abs(cost.costUsd - 1.0305) < 0.005,
      JSON.stringify(cost));

    const uri = extractVideoUri(real);
    check('I5 extractVideoUri finds the uri in the model_output step',
      typeof uri === 'string' && /generativelanguage\.googleapis\.com\/v1beta\/files\//.test(uri),
      String(uri).slice(0, 80));
    check('I6 the uri is NOT at output.uri (the path that was inferred)',
      real.output === undefined || !real.output?.uri);
    check('I7 status is completed — so these paths run on the SUCCESS branch',
      String(real.status) === 'completed');
    check('I8 the fixture carries no base64 image payload',
      !/"data": "[A-Za-z0-9+/]{200,}/.test(fs.readFileSync(FIX, 'utf8')));
    check('I9 thoughts are inside total_output_tokens (not additive)',
      Number(real.usage.total_thought_tokens) > 0 &&
      Number(real.usage.total_output_tokens) > Number(real.usage.total_thought_tokens));
  }
}

console.log('');
if (failures.length) {
  console.log(`❌ geminiVideoProvider: ${failures.length} FAILED, ${pass} passed\n`);
  for (const f of failures) console.log(`   • ${f}`);
  process.exit(1);
}
console.log(`✅ geminiVideoProvider: ${pass} checks passed\n`);
