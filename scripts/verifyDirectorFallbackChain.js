#!/usr/bin/env node
'use strict';

// Verifies the Director's CROSS-PROVIDER fallback chain and the alerting that
// makes a Director outage visible.
//
// THE OUTAGE THIS GUARDS
// ----------------------
// Static ad generation was 100% dead for ~20h on 2026-08-18. Probed live from
// the production service, same ATLAS_API_KEY, sequential single calls:
//   anthropic/claude-sonnet-5 (the Director)  -> HTTP 429 after ~51 SECONDS
//   anthropic/claude-opus-5                   -> HTTP 429 after ~50s
//   anthropic/claude-sonnet-4.6               -> 200 but 52s
//   openai/gpt-5.6-terra                      -> 200 in 1.0s
//   google/gemini-2.5-pro                     -> 200 in 1.7s
// Atlas is capacity-starved on several DIRECT Anthropic routes. The Director's
// configured `direct: {provider:'anthropic'}` fallback could not save it:
// DIRECT_KEYS knows only openai/google and NO Render service carries
// ANTHROPIC_API_KEY, so the fallback was structurally incapable of firing —
// silently. Nothing alerted, because the per-product catch
// (campaignAdsGenerationService) only console.error'd.
//
// Fully offline: no network, no DB, no keys. axios and costTracker are stubbed
// through require.cache the way the repo's other harnesses inject data access.

const assert = require('assert');
const path = require('path');

// ── stub costTracker BEFORE anything requires it ─────────────────────────
// atlasLlmService destructures `trackLlmCall` at require time, so the stub has
// to be in the cache first. Pre-seeding the cache entry (rather than mutating
// the real module's exports) keeps the real costTracker — and its mongoose
// models — from loading at all.
const costTrackerPath = require.resolve('../services/costTracker');
const ledger = [];
require.cache[costTrackerPath] = {
  id: costTrackerPath, filename: costTrackerPath, loaded: true, children: [], paths: [],
  exports: {
    trackLlmCall: async (meta, fn) => {
      ledger.push({ provider: meta.provider, model: meta.model, purpose: meta.purpose });
      return fn();
    },
  },
};

const axios = require('axios');
const realPost = axios.post;

// ── the modules under test ───────────────────────────────────────────────
const modelMap  = require('../services/atlasModelMap');
const llmError  = require('../services/llmError');
const llm       = require('../services/atlasLlmService');
const alerts    = require('../services/alertService');

const { LLM_ERROR_CODES, LLM_ACTIONS, ADVANCES_CHAIN } = llmError;

let pass = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (err) { failures.push(name); console.log(`  ✗ ${name}\n      ${err.message}`); }
}

// ── HTTP stub ────────────────────────────────────────────────────────────
// Every axios.post is recorded (url, model, timeout, body) and answered from a
// scripted queue of responses. A response is either { status, data } (returned
// to the transport, which decides) or { throws: Error } (transport-level).
let calls = [];
let script = [];
function installHttp(responses) {
  calls = [];
  script = responses.slice();
  axios.post = async (url, body, cfg) => {
    calls.push({ url, body, timeout: cfg && cfg.timeout, model: body && body.model });
    const next = script.shift();
    if (!next) throw new Error(`HTTP stub: unscripted call #${calls.length} to ${url} (${body && body.model})`);
    if (next.throws) throw next.throws;
    return { status: next.status, data: next.data, headers: next.headers || {} };
  };
}
function restoreHttp() { axios.post = realPost; }

const ok200 = (content = '{"concepts":[]}') => ({
  status: 200,
  data: { choices: [{ message: { content }, finish_reason: 'stop' } ], usage: {} },
  headers: { 'x-request-id': 'req-ok' },
});
const err429 = () => ({ status: 429, data: { code: 429, msg: 'too many requests', request_id: 'rq-429' } });
const err500 = () => ({ status: 500, data: { code: 500, msg: 'internal error' } });
const err400 = () => ({ status: 400, data: { code: 400, msg: 'bad request' } });
const err401 = () => ({ status: 401, data: { code: 401, msg: 'unauthorized' } });
const errUnrouted = () => ({ status: 400, data: { code: 400, msg: 'router not found' } });
const thrownWithCode = (code, message) => {
  const e = new Error(message);
  e.code = code;
  return { throws: e };
};
const timeoutThrow = () => {
  const e = new Error('timeout of 75000ms exceeded');
  e.code = 'ECONNABORTED';
  return { throws: e };
};

const DIRECTOR_PARAMS = () => ({
  model: 'director',
  response_format: { type: 'json_object' },
  messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }],
  temperature: 0.45,
  max_tokens: 30000,
});
const META = { service: 'aiCreativeDirectorService', purposeTag: 'round:0' };

// Environment the transport reads. Set once; individual checks override.
function baseEnv() {
  process.env.ATLAS_API_KEY = 'test-atlas-key';
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;      // the real production shape
  delete process.env.ATLAS_MODEL_DIRECTOR;
}

async function expectThrow(fn) {
  try { await fn(); } catch (e) { return e; }
  throw new Error('expected a throw, got none');
}

(async () => {
baseEnv();

console.log('\nA. chain resolution — and every OTHER role provably unchanged');

await check('A1 director resolves to the owner-directed 3-link cross-provider order', () => {
  const c = modelMap.resolveChain('director');
  assert.deepStrictEqual(c.map(l => l.atlas), [
    'anthropic/claude-sonnet-5',
    'anthropic/claude-opus-5',
    'openai/gpt-5.6-terra',
  ], 'chain order is owner-directed (primary → Opus → GPT-5.6-Terra)');
  assert.ok(c.some(l => !/^anthropic\//.test(l.atlas)), 'the chain must SPAN providers — a same-provider chain is what failed');
});

await check('A2 EVERY other role is a single link identical to resolveModel (unchanged pin)', () => {
  const others = Object.keys(modelMap.MAP).filter(r => r !== 'director').sort();
  // ENUMERATED, not `>= 6`. A floor passes while a role quietly disappears from
  // MAP — and "every other role is unchanged" is meaningless if the harness
  // cannot say which roles it checked.
  assert.deepStrictEqual(others, [
    'ad-vision-qc', 'font-vision', 'gemini-2.5-flash', 'gemini-2.5-pro',
    'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'review-text',
  ], 'the MAP role inventory changed — a role was added or removed, confirm its chain behaviour deliberately');
  for (const role of others) {
    const chain = modelMap.resolveChain(role);
    assert.strictEqual(chain.length, 1, `${role} grew a chain — every other role must stay single-link`);
    const single = modelMap.resolveModel(role);
    assert.strictEqual(chain[0].atlas, single.atlas, `${role} atlas drifted`);
    assert.deepStrictEqual(chain[0].direct, single.direct || null, `${role} direct drifted`);
    assert.ok(!('chain' in modelMap.MAP[role]), `${role} must not declare a chain`);
  }
});

await check('A3 resolveModel("director") still returns the PRIMARY (stream transport + old harnesses)', () => {
  assert.strictEqual(modelMap.resolveModel('director').atlas, 'anthropic/claude-sonnet-5');
});

await check('A4 ATLAS_MODEL_DIRECTOR override collapses the chain to ONE link', () => {
  process.env.ATLAS_MODEL_DIRECTOR = 'google/gemini-2.5-pro';
  const c = modelMap.resolveChain('director');
  assert.strictEqual(c.length, 1, 'the emergency lever must not silently re-add paid attempts');
  assert.strictEqual(c[0].atlas, 'google/gemini-2.5-pro');
  const m = modelMap.resolveModel('director');
  assert.strictEqual(m.atlas, 'google/gemini-2.5-pro');
  assert.ok(!('chain' in m), 'resolveModel must drop a chain that contradicts the override');
  delete process.env.ATLAS_MODEL_DIRECTOR;
});

await check('A5 an override on a NON-chain role behaves exactly as before', () => {
  process.env.ATLAS_MODEL_GPT_4_1 = 'openai/gpt-5.4';
  assert.strictEqual(modelMap.resolveModel('gpt-4.1').atlas, 'openai/gpt-5.4');
  assert.deepStrictEqual(modelMap.resolveChain('gpt-4.1').map(l => l.atlas), ['openai/gpt-5.4']);
  delete process.env.ATLAS_MODEL_GPT_4_1;
});

await check('A6 unknown ids resolve to one link matching resolveModel', () => {
  for (const id of ['openai/some-slug', 'legacy-thing']) {
    const c = modelMap.resolveChain(id);
    const m = modelMap.resolveModel(id);
    assert.strictEqual(c.length, 1);
    assert.strictEqual(c[0].atlas, m.atlas);
    assert.deepStrictEqual(c[0].direct, m.direct || null);
  }
});

console.log('\nB. WHAT ADVANCES THE CHAIN — transport failures only');

for (const [label, resp, code] of [
  ['429 rate limit',   err429(),      LLM_ERROR_CODES.LLM_RATE_LIMITED],
  ['5xx upstream',     err500(),      LLM_ERROR_CODES.LLM_UPSTREAM_ERROR],
  ['client timeout',   timeoutThrow(), LLM_ERROR_CODES.LLM_TIMEOUT],
  ['router not found', errUnrouted(), LLM_ERROR_CODES.LLM_MODEL_UNROUTED],
]) {
  // eslint-disable-next-line no-loop-func
  await check(`B1 ${label} on link 1 ADVANCES and link 2 serves the call`, async () => {
    baseEnv();
    assert.ok(ADVANCES_CHAIN.has(code), `${code} must be in ADVANCES_CHAIN`);
    installHttp([resp, ok200()]);
    const res = await llm.chatCompletion(META, DIRECTOR_PARAMS());
    assert.strictEqual(calls.length, 2, `expected 2 upstream calls, saw ${calls.length}`);
    assert.strictEqual(calls[0].model, 'anthropic/claude-sonnet-5');
    assert.strictEqual(calls[1].model, 'anthropic/claude-opus-5');
    const out = llm.chainOutcome(res);
    assert.strictEqual(out.link, 2, 'served by link 2');
    assert.strictEqual(out.degraded, true);
    restoreHttp();
  });
}

await check('B2 a 400 BAD REQUEST does NOT advance — the chain stops at link 1', async () => {
  baseEnv();
  assert.ok(!ADVANCES_CHAIN.has(LLM_ERROR_CODES.LLM_BAD_REQUEST));
  installHttp([err400()]);
  const err = await expectThrow(() => llm.chatCompletion(META, DIRECTOR_PARAMS()));
  assert.strictEqual(calls.length, 1, `a non-transport 4xx must not buy the same answer at another model's price (saw ${calls.length} calls)`);
  assert.strictEqual(err.code, LLM_ERROR_CODES.LLM_BAD_REQUEST);
  restoreHttp();
});

await check('B3 a 401 does NOT advance', async () => {
  baseEnv();
  installHttp([err401()]);
  const err = await expectThrow(() => llm.chatCompletion(META, DIRECTOR_PARAMS()));
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(err.code, LLM_ERROR_CODES.LLM_AUTH_REJECTED);
  restoreHttp();
});

await check('B4 a 200 with BAD JSON content does NOT advance — one call, returned to the caller', async () => {
  baseEnv();
  // The exact production shape: prose instead of JSON ("I don't have enough
  // information…"). This is the Director's one-shot corrective re-ask path and
  // must NEVER become a chain advance — a different model does not fix prompt
  // compliance, and advancing would multiply PAID calls per round.
  installHttp([ok200("I don't have enough information to generate concepts.")]);
  const res = await llm.chatCompletion(META, DIRECTOR_PARAMS());
  assert.strictEqual(calls.length, 1, 'bad CONTENT is not a transport failure');
  assert.strictEqual(res.choices[0].message.content.slice(0, 5), "I don");
  const out = llm.chainOutcome(res);
  assert.strictEqual(out.degraded, false, 'link 1 served it — nothing was degraded');
  assert.ok(!ADVANCES_CHAIN.has(LLM_ERROR_CODES.LLM_CONTENT_UNPARSEABLE), 'content codes must never advance a chain');
  assert.ok(!ADVANCES_CHAIN.has(LLM_ERROR_CODES.LLM_CONTENT_EMPTY));
  restoreHttp();
});

console.log('\nC. BOUNDS — the chain must never become unbounded paid attempts');

await check('C1 all links starved: total upstream requests <= CHAIN_MAX_ATTEMPTS', async () => {
  baseEnv();
  process.env.OPENAI_API_KEY = 'test-openai';   // the only direct twin with a key
  installHttp([err429(), err429(), err429(), err429(), err429(), err429()]);
  const err = await expectThrow(() => llm.chatCompletion(META, DIRECTOR_PARAMS()));
  assert.strictEqual(calls.length, 4, 'director worst case is exactly 4: 3 atlas links + 1 openai direct twin');
  // Pin the CEILING ITSELF, not just "<= whatever the constant currently is".
  // A `<=` against the live constant passes no matter how high someone raises
  // it — the revert-proof caught exactly that. 4 is also the documented
  // worst-case paid-call count per chatCompletion; changing it is a money
  // decision that must be made deliberately, here.
  assert.strictEqual(llm.CHAIN_MAX_ATTEMPTS, 4,
    'CHAIN_MAX_ATTEMPTS is the documented worst-case paid-call bound (3 Atlas links + 1 keyed direct twin) — raising it raises spend per Director round');
  assert.strictEqual(err.code, LLM_ERROR_CODES.LLM_RATE_LIMITED);
  restoreHttp();
});

await check('C1b the ceiling actually BINDS — lowering it truncates the walk', async () => {
  baseEnv();
  process.env.OPENAI_API_KEY = 'test-openai';
  const saved = process.env.ATLAS_LLM_CHAIN_MAX_ATTEMPTS;
  process.env.ATLAS_LLM_CHAIN_MAX_ATTEMPTS = '2';
  delete require.cache[require.resolve('../services/atlasLlmService')];
  const llm2 = require('../services/atlasLlmService');
  installHttp([err429(), err429(), err429(), err429()]);
  await expectThrow(() => llm2.chatCompletion(META, DIRECTOR_PARAMS()));
  assert.strictEqual(calls.length, 2, `the ceiling must be a real bound, not decoration (saw ${calls.length})`);
  restoreHttp();
  if (saved === undefined) delete process.env.ATLAS_LLM_CHAIN_MAX_ATTEMPTS;
  else process.env.ATLAS_LLM_CHAIN_MAX_ATTEMPTS = saved;
  delete require.cache[require.resolve('../services/atlasLlmService')];
  require('../services/atlasLlmService');
});

await check('C2 NON-final links are time-boxed below the final link', async () => {
  baseEnv();
  installHttp([err429(), err429(), ok200()]);
  await llm.chatCompletion(META, DIRECTOR_PARAMS());
  assert.strictEqual(calls[0].timeout, llm.CHAIN_LINK_TIMEOUT_MS, 'link 1 must use the short per-attempt budget');
  assert.strictEqual(calls[1].timeout, llm.CHAIN_LINK_TIMEOUT_MS, 'link 2 must use the short per-attempt budget');
  assert.strictEqual(calls[2].timeout, 120000, 'the FINAL link keeps the full budget');
  assert.ok(llm.CHAIN_LINK_TIMEOUT_MS < 120000, 'a chain that cannot fail fast cannot reach a healthy link');
  restoreHttp();
});

await check('C3 the per-attempt budget sits ABOVE the measured 429 latency and the slowest measured success', () => {
  // ~51s for a 429 (measured 2026-08-18). Cutting below it converts a clean,
  // definitely-unbilled rejection into an ambiguous maybe-billed timeout.
  assert.ok(llm.CHAIN_LINK_TIMEOUT_MS > 51000,
    `CHAIN_LINK_TIMEOUT_MS (${llm.CHAIN_LINK_TIMEOUT_MS}) must exceed the measured 429 latency (~51s)`);
  // 52s for the slowest measured SUCCESS (anthropic/claude-sonnet-4.6).
  assert.ok(llm.CHAIN_LINK_TIMEOUT_MS > 52000,
    `CHAIN_LINK_TIMEOUT_MS (${llm.CHAIN_LINK_TIMEOUT_MS}) must exceed the slowest measured success (52s) or healthy calls are abandoned`);
  // And two non-final links must still fit inside the wall budget, or the
  // final link can never start.
  assert.ok(2 * llm.CHAIN_LINK_TIMEOUT_MS < llm.CHAIN_BUDGET_MS,
    'the budget must admit every Atlas link, or the last resort is unreachable');
});

await check('C4 the wall-clock budget stops the chain from STARTING more work', async () => {
  baseEnv();
  const saved = process.env.ATLAS_LLM_CHAIN_BUDGET_MS;
  process.env.ATLAS_LLM_CHAIN_BUDGET_MS = '60';
  delete require.cache[require.resolve('../services/atlasLlmService')];
  const llm2 = require('../services/atlasLlmService');
  // Each stubbed request burns 40 (logical) ms, so the budget admits the
  // first two starts and refuses the third — the real shape, just scaled down
  // from 210s / 75s. The gate is on STARTING: an in-flight attempt is never
  // cut short, because truncating it would trade a clean verdict for an
  // ambiguous maybe-billed timeout.
  //
  // DETERMINISM (fixed 2026-08-19): this used to burn the 40ms with a REAL
  // setTimeout and race it against atlasLlmService's real Date.now() budget
  // check. Under CPU oversubscription (measured: 20% of runs at
  // --concurrency=16, always this check) the scheduler doesn't guarantee a
  // setTimeout(40) returns within a 60ms wall-clock window, so the second
  // call sometimes never started and `calls.length` came back 1 instead of
  // 2 — a scheduler race, not a budget-logic bug. Faking BOTH the clock
  // atlasLlmService reads (Date.now) and the "work" the stub does (advance a
  // counter instead of actually waiting) takes the host scheduler out of the
  // assertion entirely: the elapsed time the budget gate sees is now
  // *computed*, not *measured*, so this asserts the gate logic deterministically
  // instead of racing it.
  installHttp([err429(), err429(), err429(), err429()]);
  const inner = axios.post;
  const realDateNow = Date.now;
  let fakeNow = realDateNow();
  Date.now = () => fakeNow;
  axios.post = async (...args) => { fakeNow += 40; return inner(...args); };
  let err;
  try {
    err = await expectThrow(() => llm2.chatCompletion(META, DIRECTOR_PARAMS()));
  } finally {
    Date.now = realDateNow;
  }
  assert.strictEqual(calls.length, 2, `budget must stop the walk, saw ${calls.length} upstream calls`);
  assert.ok(err.chain.some(r => r.code === 'BUDGET_EXHAUSTED'),
    'a budget stop must be RECORDED, never a silent gap that reads as if the link was never in the chain');
  assert.strictEqual(err.action, LLM_ACTIONS.EXHAUSTED_CHAIN, 'running out of budget is still a give-up, not a recovery');
  restoreHttp();
  if (saved === undefined) delete process.env.ATLAS_LLM_CHAIN_BUDGET_MS;
  else process.env.ATLAS_LLM_CHAIN_BUDGET_MS = saved;
  delete require.cache[require.resolve('../services/atlasLlmService')];
  require('../services/atlasLlmService');
});

// ── C5/C6: "every OTHER role is unchanged" — BEHAVIOURALLY, per failure class.
//
// The first version of C5 scripted 429 ONLY, and that is exactly why two real
// regressions shipped invisibly: using the chain's ADVANCES_CHAIN set for the
// in-link retry decision turned an unrouted-400 from ONE Atlas POST into THREE,
// and added ECONNREFUSED / ENOTFOUND / EPIPE to the retry set. Both are
// single-link-role behaviour, and both were green under a 429-only test.
// Every class the pre-chain predicate distinguished now gets a case, with the
// EXACT pre-change attempt count asserted.
const PRE_CHANGE_SINGLE_LINK = [
  // label,                    scripted failure,                         atlas attempts before the direct twin
  ['429 rate limit',           () => err429(),                            3],
  ['5xx upstream',             () => err500(),                            3],
  ['client timeout',           () => timeoutThrow(),                      3],
  ['ECONNRESET (transient)',   () => thrownWithCode('ECONNRESET', 'socket hang up'),        3],
  ['EAI_AGAIN (transient DNS)',() => thrownWithCode('EAI_AGAIN', 'getaddrinfo EAI_AGAIN'),  3],
  // ↓ the two that regressed. Pre-chain these broke after ONE attempt.
  ['unrouted 400',             () => errUnrouted(),                       1],
  ['ECONNREFUSED (hard)',      () => thrownWithCode('ECONNREFUSED', 'connect ECONNREFUSED'), 1],
  ['ENOTFOUND (dead host)',    () => thrownWithCode('ENOTFOUND', 'getaddrinfo ENOTFOUND'),   1],
  ['EPIPE (broken pipe)',      () => thrownWithCode('EPIPE', 'write EPIPE'),                 1],
  // Non-retryable 4xx: one attempt, then the direct twin. Unchanged throughout.
  ['400 bad request',          () => err400(),                            1],
  ['401 unauthorized',         () => err401(),                            1],
];

for (const [label, mk, expectedAtlasAttempts] of PRE_CHANGE_SINGLE_LINK) {
  // eslint-disable-next-line no-loop-func
  await check(`C5 single-link role: ${label} → ${expectedAtlasAttempts} Atlas attempt(s) then the direct twin`, async () => {
    baseEnv();
    process.env.OPENAI_API_KEY = 'test-openai';
    const saved = process.env.ATLAS_LLM_BACKOFF_MS;
    process.env.ATLAS_LLM_BACKOFF_MS = '1';
    delete require.cache[require.resolve('../services/atlasLlmService')];
    const llm2 = require('../services/atlasLlmService');
    // Exactly the expected number of Atlas failures, then a success. Too MANY
    // attempts consumes the ok200 on an Atlas call (atlasCalls overshoots);
    // too FEW leaves the direct twin holding a failure and the call throws.
    // Either deviation is caught.
    installHttp([...Array(expectedAtlasAttempts).fill(null).map(() => mk()), ok200()]);
    await llm2.chatCompletion(META, { model: 'gpt-4.1', messages: [], max_tokens: 100 });
    const atlasCalls = calls.filter(c => c.model === 'openai/gpt-5.6-terra').length;
    assert.strictEqual(atlasCalls, expectedAtlasAttempts,
      `${label}: expected ${expectedAtlasAttempts} Atlas attempt(s), saw ${atlasCalls} — ` +
      `single-link roles must match the PRE-CHAIN predicate exactly`);
    assert.strictEqual(calls[calls.length - 1].model, 'gpt-4.1',
      'the direct twin must still get its shot with the ORIGINAL vendor model name');
    for (const c of calls) {
      assert.strictEqual(c.timeout, 120000, 'a single-link role must never be time-boxed by the chain tuning');
    }
    restoreHttp();
    if (saved === undefined) delete process.env.ATLAS_LLM_BACKOFF_MS; else process.env.ATLAS_LLM_BACKOFF_MS = saved;
    delete require.cache[require.resolve('../services/atlasLlmService')];
    require('../services/atlasLlmService');
  });
}

await check('C6 retry and advance are SEPARATE predicates, and they really differ', () => {
  const { ADVANCES_CHAIN: AC, shouldRetrySameLink, makeLlmError: mk } = llmError;
  const withCode = (code, transportCode) => mk({
    code, cause: transportCode ? Object.assign(new Error('x'), { code: transportCode }) : undefined,
  });
  // The divergent cases are the whole point of the split. If these ever agree,
  // someone has collapsed the two predicates back together.
  assert.ok(AC.has(LLM_ERROR_CODES.LLM_MODEL_UNROUTED), 'unrouted must ADVANCE');
  assert.ok(!shouldRetrySameLink(withCode(LLM_ERROR_CODES.LLM_MODEL_UNROUTED)),
    'unrouted must NOT be re-sent — three identical 400s teach nothing');
  assert.ok(AC.has(LLM_ERROR_CODES.LLM_NETWORK_ERROR), 'a network failure must ADVANCE (another host may answer)');
  assert.ok(!shouldRetrySameLink(withCode(LLM_ERROR_CODES.LLM_NETWORK_ERROR, 'ECONNREFUSED')),
    'a refused connection must NOT burn in-link retries');
  assert.ok(shouldRetrySameLink(withCode(LLM_ERROR_CODES.LLM_NETWORK_ERROR, 'ECONNRESET')),
    'a reset socket IS transient and must still retry, exactly as before the chain');
  // And the sets are genuinely not the same object/contents.
  const advancing = [...AC].sort();
  const retrying = advancing.filter(c => shouldRetrySameLink(withCode(c, 'ECONNRESET')));
  assert.notDeepStrictEqual(advancing, retrying,
    'ADVANCES_CHAIN and shouldRetrySameLink must not be interchangeable — that equality WAS the regression');
});

await check('C7 the transport code survives classification (shouldRetrySameLink depends on it)', async () => {
  baseEnv();
  installHttp([thrownWithCode('ECONNREFUSED', 'connect ECONNREFUSED 1.2.3.4:443'), err429(), ok200()]);
  const res = await llm.chatCompletion(META, DIRECTOR_PARAMS());
  assert.strictEqual(calls.length, 3, 'a refused connection advances immediately, it does not retry in-link');
  assert.ok(llm.chainOutcome(res).degraded);
  restoreHttp();
});

console.log('\nD. SAMPLING PARAMS — stripped per Claude link, honoured on the OpenAI link');

await check('D1 Claude 5 links lose temperature/top_p/top_k; the OpenAI link keeps them', async () => {
  baseEnv();
  installHttp([err429(), err429(), ok200()]);
  await llm.chatCompletion(META, { ...DIRECTOR_PARAMS(), top_p: 0.9, top_k: 40 });
  for (const i of [0, 1]) {
    for (const k of ['temperature', 'top_p', 'top_k']) {
      assert.ok(!(k in calls[i].body), `link ${i + 1} (${calls[i].model}) must not send ${k} — Atlas bare-400s the Claude 5 family`);
    }
  }
  assert.strictEqual(calls[2].body.temperature, 0.45,
    'the OpenAI fallback link DOES honour the Director temperature — a real, documented asymmetry');
  assert.strictEqual(calls[2].body.top_p, 0.9);
  assert.strictEqual(calls[2].body.reasoning_effort, 'low', 'openai/* keeps the reasoning headroom default');
  restoreHttp();
});

console.log('\nE. ACTIONS — the reported action must be what ACTUALLY happened');

await check('E1 an EXHAUSTED chain reports EXHAUSTED_CHAIN, never a fallback action', async () => {
  baseEnv();
  installHttp([err429(), err429(), err429()]);
  const err = await expectThrow(() => llm.chatCompletion(META, DIRECTOR_PARAMS()));
  assert.strictEqual(err.action, LLM_ACTIONS.EXHAUSTED_CHAIN,
    `a chain that recovered nothing must never claim it did (got ${err.action})`);
  assert.notStrictEqual(err.action, LLM_ACTIONS.ADVANCED_TO_NEXT_LINK);
  assert.notStrictEqual(err.action, LLM_ACTIONS.FELL_BACK_TO_DIRECT_PROVIDER);
  assert.ok(/gave up/i.test(err.actionDetail || ''), 'the give-up must be stated in plain words');
  restoreHttp();
});

await check('E2 SUCCESS on link 2 reports advancement + success and NO give-up', async () => {
  baseEnv();
  installHttp([err429(), ok200()]);
  const res = await llm.chatCompletion(META, DIRECTOR_PARAMS());
  const out = llm.chainOutcome(res);
  assert.strictEqual(out.link, 2);
  assert.strictEqual(out.degraded, true);
  assert.strictEqual(out.servedBy.model, 'anthropic/claude-opus-5');
  assert.ok(/ok/.test(out.summary), `summary must show the success: ${out.summary}`);
  assert.ok(!/gave up/i.test(out.summary), 'a recovered chain must never read as a give-up');
  restoreHttp();
});

await check('E3 SUCCESS on link 1 is not degraded', async () => {
  baseEnv();
  installHttp([ok200()]);
  const out = llm.chainOutcome(await llm.chatCompletion(META, DIRECTOR_PARAMS()));
  assert.strictEqual(out.degraded, false);
  assert.strictEqual(out.link, 1);
  restoreHttp();
});

await check('E4 the final error carries a readable, ordered chain summary', async () => {
  baseEnv();
  process.env.OPENAI_API_KEY = 'test-openai';
  installHttp([err429(), err429(), err429(), err500()]);
  const err = await expectThrow(() => llm.chatCompletion(META, DIRECTOR_PARAMS()));
  const s = err.chainSummary;
  assert.ok(s.indexOf('anthropic/claude-sonnet-5') < s.indexOf('anthropic/claude-opus-5'), 'summary must be in attempt order');
  assert.ok(s.indexOf('anthropic/claude-opus-5') < s.indexOf('openai/gpt-5.6-terra'));
  assert.ok(/429/.test(s), 'each link must report its own result');
  restoreHttp();
});

await check('E5 the KEYLESS anthropic direct twin is a NAMED, coded skip (the outage root cause)', async () => {
  baseEnv();                                   // no ANTHROPIC_API_KEY — production shape
  installHttp([err429(), err429(), err429()]);
  const err = await expectThrow(() => llm.chatCompletion(META, DIRECTOR_PARAMS()));
  const skips = err.chain.filter(r => r.code === LLM_ERROR_CODES.LLM_AUTH_MISSING);
  const anthropicSkips = skips.filter(r => r.provider === 'anthropic');
  assert.strictEqual(anthropicSkips.length, 2,
    'both anthropic direct twins must be recorded as auth-missing skips, not silence — this is the exact hole that made the outage invisible');
  assert.strictEqual(skips.length, 3, 'with no keys at all, every direct twin is a recorded skip');
  assert.ok(/auth_missing/.test(err.chainSummary), `the summary must say a link was skipped for want of a key: ${err.chainSummary}`);
  restoreHttp();
});

await check('E6 a direct-provider save stamps FELL_BACK_TO_DIRECT_PROVIDER and marks the result degraded', async () => {
  baseEnv();
  process.env.OPENAI_API_KEY = 'test-openai';
  installHttp([err429(), err429(), err429(), ok200()]);
  const res = await llm.chatCompletion(META, DIRECTOR_PARAMS());
  const out = llm.chainOutcome(res);
  assert.strictEqual(out.viaDirect, true);
  assert.strictEqual(out.degraded, true);
  assert.strictEqual(out.servedBy.provider, 'openai');
  assert.strictEqual(out.servedBy.model, 'gpt-4.1');
  restoreHttp();
});

await check('E7 request_id from the provider survives onto the thrown error', async () => {
  baseEnv();
  installHttp([err429(), err429(), err429()]);
  const err = await expectThrow(() => llm.chatCompletion(META, DIRECTOR_PARAMS()));
  assert.strictEqual(err.requestId, 'rq-429', 'request_id is what a support escalation needs — it must never be dropped');
  restoreHttp();
});

console.log('\nF. ALERTING — "more than once" threshold, and never on the paid path');

await check('F1 minCount:2 holds the FIRST occurrence and delivers the SECOND', async () => {
  alerts._resetState();
  process.env.SLACK_BOT_TOKEN = 'xoxb-test';
  process.env.SLACK_ALERT_CHANNEL = 'C123';
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (_u, o) => { sent.push(JSON.parse(o.body)); return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true }) }; };
  const a = await alerts.notify({ level: 'fatal', title: 'T', key: 'k:test', minCount: 2 });
  assert.strictEqual(a, false, 'the FIRST occurrence must not page — the owner asked for "more than once"');
  assert.strictEqual(sent.length, 0);
  const b = await alerts.notify({ level: 'fatal', title: 'T', key: 'k:test', minCount: 2 });
  assert.strictEqual(b, true, 'the SECOND occurrence must page');
  assert.strictEqual(sent.length, 1);
  assert.ok(/\+1 more/.test(sent[0].text), 'the held first occurrence must be folded into the tally, not lost');
  global.fetch = realFetch;
});

await check('F2 WITHOUT minCount the first occurrence delivers (every existing caller unchanged)', async () => {
  alerts._resetState();
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (_u, o) => { sent.push(JSON.parse(o.body)); return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true }) }; };
  const a = await alerts.notify({ level: 'error', title: 'T2', key: 'k:test2' });
  assert.strictEqual(a, true);
  assert.strictEqual(sent.length, 1);
  global.fetch = realFetch;
});

await check('F3 the threshold window expiring RE-ARMS the counter (two lone hits a day apart never page)', async () => {
  alerts._resetState();
  const realNow = Date.now;
  const realFetch = global.fetch;
  let n = 0;
  global.fetch = async () => { n++; return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true }) }; };
  try {
    let t = 1_000_000_000_000;
    Date.now = () => t;
    await alerts.notify({ level: 'fatal', title: 'T3', key: 'k:test3', minCount: 2 });
    assert.strictEqual(n, 0, 'first occurrence is held');
    t += 31 * 60 * 1000;            // past the 30-minute threshold window
    await alerts.notify({ level: 'fatal', title: 'T3', key: 'k:test3', minCount: 2 });
    assert.strictEqual(n, 0, 'a hit OUTSIDE the window restarts the count — two isolated blips must not weld into a page');
    await alerts.notify({ level: 'fatal', title: 'T3', key: 'k:test3', minCount: 2 });
    assert.strictEqual(n, 1, 'a second hit INSIDE the window pages');
  } finally {
    Date.now = realNow;
    global.fetch = realFetch;
  }
});

await check('F3b ALERT_THRESHOLD_WINDOW_MIN=0 DISABLES the threshold (never a silent mute)', async () => {
  alerts._resetState();
  const saved = process.env.ALERT_THRESHOLD_WINDOW_MIN;
  process.env.ALERT_THRESHOLD_WINDOW_MIN = '0';
  const realFetch = global.fetch;
  let n = 0;
  global.fetch = async () => { n++; return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true }) }; };
  await alerts.notify({ level: 'fatal', title: 'T3b', key: 'k:test3b', minCount: 2 });
  assert.strictEqual(n, 1, 'zero window means "no threshold", matching ALERT_DEDUPE_WINDOW_MIN=0 — it must never mean "mute"');
  global.fetch = realFetch;
  if (saved === undefined) delete process.env.ALERT_THRESHOLD_WINDOW_MIN; else process.env.ALERT_THRESHOLD_WINDOW_MIN = saved;
});

await check('F4 the threshold window default is documented and > 0', () => {
  const saved = process.env.ALERT_THRESHOLD_WINDOW_MIN;
  delete process.env.ALERT_THRESHOLD_WINDOW_MIN;
  assert.strictEqual(alerts._THRESHOLD_WINDOW_MS(), 30 * 60 * 1000, 'default is 30 minutes — see the comment for the trade');
  if (saved !== undefined) process.env.ALERT_THRESHOLD_WINDOW_MIN = saved;
});

await check('F5 Director transport failure alerts FATAL and the fallback notice does NOT', () => {
  const fs = require('fs');
  const camp = fs.readFileSync(path.join(__dirname, '../services/campaignAdsGenerationService.js'), 'utf8');
  const dir  = fs.readFileSync(path.join(__dirname, '../services/aiCreativeDirectorService.js'), 'utf8');
  // Must be USED at the call site, not merely declared — the revert-proof
  // showed a bare /DIRECTOR_TRANSPORT_ALERT_KEY/ scan is satisfied by the
  // const declaration while the alert quietly uses some other key.
  assert.ok(/notifyAsync\(\{[\s\S]{0,4000}?key:[^\n]*DIRECTOR_TRANSPORT_ALERT_KEY/.test(camp),
    'the per-product catch must fire the alert under the shared, stable key');
  assert.ok(/const DIRECTOR_TRANSPORT_ALERT_KEY = 'director:transport-failure'/.test(camp),
    'the key value is the dedupe identity — changing it silently re-arms every suppressed alert');
  // The CONTENT class is the other half of the same zero-ads outage and must
  // page under its OWN key — sharing one key would dedupe a content failure
  // away behind an unrelated transport page and hand over the wrong remedy.
  assert.ok(/const DIRECTOR_CONTENT_ALERT_KEY = 'director:content-failure'/.test(camp),
    'a content failure must have its own dedupe identity');
  assert.ok(/notifyAsync\(\{[\s\S]{0,4000}?key:[^\n]*DIRECTOR_CONTENT_ALERT_KEY/.test(camp),
    'the content class must actually be routed to its own key at the call site');
  assert.ok(/CONTENT_CODES\.has\(llmFail\.code\)/.test(camp),
    'the split must be driven by the shared CONTENT_CODES set, not a hand-copied code list');
  assert.ok(/level:\s*'fatal'/.test(camp), 'a total static outage is fatal-channel material');
  assert.ok(/minCount:\s*2/.test(camp), 'the owner asked for a "more than once" threshold');
  assert.ok(/ZERO ads/.test(camp), 'the alert must state the consequence in plain words');
  assert.ok(/video is unaffected/i.test(camp), 'the alert must say what is NOT broken');
  assert.ok(/director:fallback-served/.test(dir), 'a degraded-but-working Director must announce itself');
  assert.ok(!/level:\s*'fatal'[\s\S]{0,400}fallback-served/.test(dir), 'the fallback notice must not use the fatal channel');
});

await check('F6 NOTHING alerting is awaited on the render/billable path', () => {
  const fs = require('fs');
  for (const f of ['../services/campaignAdsGenerationService.js', '../services/aiCreativeDirectorService.js']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    assert.ok(!/await\s+alert(Service|s)\s*\./.test(src), `${f}: an alert must never be awaited on a paid path`);
    assert.ok(!/await\s+alert(Service|s)\.notifyAsync/.test(src), `${f}: notifyAsync must not be awaited`);
  }
});

await check('F7 the alert path cannot throw into generation', async () => {
  alerts._resetState();
  const realFetch = global.fetch;
  global.fetch = async () => { throw new Error('slack exploded'); };
  const r = await alerts.notify({ level: 'fatal', title: 'boom', key: 'k:boom' });
  assert.strictEqual(r, false, 'a Slack failure degrades to false, never a rejection');
  assert.doesNotThrow(() => alerts.notifyAsync({ level: 'fatal', title: 'boom2' }));
  global.fetch = realFetch;
});

restoreHttp();
delete process.env.SLACK_BOT_TOKEN;
delete process.env.SLACK_ALERT_CHANNEL;

const total = pass + failures.length;
console.log(`\n${failures.length ? '✗' : '✓'} verifyDirectorFallbackChain: ${pass}/${total} passed`);
if (failures.length) {
  console.log(`  failed: ${failures.join(', ')}`);
  process.exit(1);
}
})();
