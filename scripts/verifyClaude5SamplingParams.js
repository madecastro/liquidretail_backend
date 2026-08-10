#!/usr/bin/env node
'use strict';

// Verifies the Claude 5 sampling-param strip.
//
// THE OUTAGE THIS GUARDS
// ----------------------
// Atlas began rejecting temperature / top_p / top_k on the Claude 5 family
// with a bare HTTP 400 {"code":400,"msg":"bad request"}. Role 'director' is
// the only Anthropic entry in atlasModelMap and it sent temperature 0.45, so
// every concept-driven expansion threw before creating a single static Ad row:
//
//   conceptDriven[product=...]: failed (Atlas 400: {"code":400,"msg":"bad request"})
//   [campaignRun run_...] start - 4 ad(s) concurrency=veo:12(4) image:24(0)
//                                                              ^^^^^^^^^^
//                                             zero static ads, run reports OK
//
// Static ad generation ran at a 100% failure rate. Video was unaffected
// because every other role maps to an openai/* or google/* slug.
//
// Live probe 2026-08-10 (production key) — the ground truth encoded below:
//   anthropic/claude-sonnet-5  temperature 0 / 0.45 / 0.7 -> 400
//                              top_p 0.9 -> 400, top_k 40 -> 400
//                              temperature 1, or omitted  -> 200
//   anthropic/claude-opus-5    temperature 0.45 -> 400, omitted -> 200
//   claude-opus-4.8 / sonnet-4.6 / sonnet-4.5 -> temperature accepted (200)
//   openai/* and google/*                     -> temperature accepted (200)
//   max_tokens 30768, response_format, stop, seed, frequency_penalty,
//   presence_penalty                          -> all accepted (200)
//
// Offline only: no DB, no network. Asserts against the REAL modules.

const assert = require('assert');

const {
  rejectsSamplingParams,
  stripSamplingParams,
  SAMPLING_PARAMS,
  resolveModel,
} = require('../services/atlasModelMap');
const { buildAtlasBody } = require('../services/atlasLlmService');
const { buildStreamBody } = require('../services/atlasLlmStreamService');

let pass = 0;
const failures = [];
function check(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (err) { failures.push(name); console.log(`  ✗ ${name}\n      ${err.message}`); }
}

// The exact body the Director sends (aiCreativeDirectorService.directConceptsRound).
const DIRECTOR_PARAMS = Object.freeze({
  model: 'director',
  response_format: { type: 'json_object' },
  messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }],
  temperature: 0.45,
  max_tokens: 30000,
});

console.log('\nA. rejectsSamplingParams — which slugs refuse the knobs');

check('A1 the Claude 5 family is caught, incl. -ccmax and a future point release', () => {
  for (const id of [
    'anthropic/claude-sonnet-5',
    'anthropic/claude-opus-5',
    'anthropic/claude-sonnet-5-ccmax',
    'anthropic/claude-opus-5-ccmax',
    'anthropic/claude-sonnet-5.1',
    'anthropic/claude-haiku-5',
    'anthropic/claude-sonnet-5-20260101',
  ]) {
    assert.strictEqual(rejectsSamplingParams(id), true, `${id} should reject sampling params`);
  }
});

check('A2 Claude 4.x, OpenAI and Google are NOT caught (they accept temperature)', () => {
  for (const id of [
    'anthropic/claude-sonnet-4.6',
    'anthropic/claude-opus-4.8',
    'anthropic/claude-sonnet-4.5-20250929',
    'anthropic/claude-opus-4.5-20251101',
    'anthropic/claude-haiku-4.5-20251001',
    'openai/gpt-5.6-terra',
    'openai/gpt-5.6-luna',
    'google/gemini-2.5-pro',
    'google/gemini-2.5-flash-lite',
  ]) {
    assert.strictEqual(rejectsSamplingParams(id), false, `${id} must keep its temperature`);
  }
});

check('A3 empty / null / undefined are safe and do not match', () => {
  for (const id of ['', null, undefined, 0]) {
    assert.strictEqual(rejectsSamplingParams(id), false);
  }
});

check('A4 a 4.x id is not matched by a loose "-5" substring (regression guard)', () => {
  // '-4.5'/'-45' must never be read as the 5 family.
  assert.strictEqual(rejectsSamplingParams('anthropic/claude-sonnet-45'), false);
  assert.strictEqual(rejectsSamplingParams('anthropic/claude-opus-50'), false);
  assert.strictEqual(rejectsSamplingParams('anthropic/claude-sonnet-4.5'), false);
});

console.log('\nB. the role that actually broke');

check('B1 role "director" still resolves to a Claude 5 slug that refuses sampling', () => {
  const { atlas } = resolveModel('director');
  assert.ok(/^anthropic\/claude/.test(atlas), `director resolved to ${atlas}`);
  assert.strictEqual(
    rejectsSamplingParams(atlas), true,
    `director -> ${atlas} must be covered by the strip; if this model changed, re-probe Atlas`
  );
});

check('B2 no OTHER mapped role silently depends on the strip', () => {
  // Documents blast radius: if a second Anthropic role appears, this fails and
  // whoever added it must confirm the Atlas behaviour for that slug.
  const { MAP } = require('../services/atlasModelMap');
  const anthropicRoles = Object.entries(MAP)
    .filter(([, v]) => /^anthropic\//.test(v.atlas))
    .map(([k]) => k);
  assert.deepStrictEqual(
    anthropicRoles, ['director'],
    `expected only 'director' on Anthropic, got: ${anthropicRoles.join(', ')}`
  );
});

console.log('\nC. buildAtlasBody — the non-stream transport');

check('C1 the Director body loses temperature entirely', () => {
  const body = buildAtlasBody({ ...DIRECTOR_PARAMS }, 'anthropic/claude-sonnet-5');
  assert.ok(!('temperature' in body), 'temperature must be absent, not 1 and not 0.45');
});

check('C2 top_p and top_k are stripped too', () => {
  const body = buildAtlasBody(
    { ...DIRECTOR_PARAMS, top_p: 0.9, top_k: 40 },
    'anthropic/claude-sonnet-5'
  );
  for (const k of ['temperature', 'top_p', 'top_k']) {
    assert.ok(!(k in body), `${k} must be stripped`);
  }
});

check('C3 EXACTLY the sampling params are stripped — nothing else is lost', () => {
  const params = {
    ...DIRECTOR_PARAMS,
    top_p: 0.9, top_k: 40,
    stop: ['x'], seed: 42, frequency_penalty: 0.5, presence_penalty: 0.5,
  };
  const body = buildAtlasBody({ ...params }, 'anthropic/claude-sonnet-5');
  // Everything Atlas accepts must survive (all probed 200 on 2026-08-10).
  assert.deepStrictEqual(body.response_format, { type: 'json_object' });
  assert.deepStrictEqual(body.messages, params.messages);
  assert.deepStrictEqual(body.stop, ['x']);
  assert.strictEqual(body.seed, 42);
  assert.strictEqual(body.frequency_penalty, 0.5);
  assert.strictEqual(body.presence_penalty, 0.5);
  const removed = Object.keys(params).filter((k) => !(k in body));
  assert.deepStrictEqual(removed.sort(), [...SAMPLING_PARAMS].sort(), `removed: ${removed}`);
});

check('C4 max_tokens clamp + reserve is untouched by the strip', () => {
  const {
    ATLAS_MAX_OUTPUT_TOKENS, REASONING_RESERVE_TOKENS,
  } = require('../services/atlasLlmService');
  const body = buildAtlasBody({ ...DIRECTOR_PARAMS }, 'anthropic/claude-sonnet-5');
  assert.strictEqual(
    body.max_tokens,
    Math.min(ATLAS_MAX_OUTPUT_TOKENS, 30000) + REASONING_RESERVE_TOKENS
  );
});

check('C5 a NON-Claude-5 model keeps its temperature (no collateral damage)', () => {
  for (const id of ['openai/gpt-5.6-terra', 'google/gemini-2.5-pro', 'anthropic/claude-sonnet-4.6']) {
    const body = buildAtlasBody({ ...DIRECTOR_PARAMS, top_p: 0.9 }, id);
    assert.strictEqual(body.temperature, 0.45, `${id} lost its temperature`);
    assert.strictEqual(body.top_p, 0.9, `${id} lost its top_p`);
  }
});

check('C6 the openai reasoning_effort default still applies', () => {
  const body = buildAtlasBody({ ...DIRECTOR_PARAMS }, 'openai/gpt-5.6-terra');
  assert.strictEqual(body.reasoning_effort, 'low');
});

check('C7 the caller object is not mutated (strip works on the copy)', () => {
  const params = { ...DIRECTOR_PARAMS };
  buildAtlasBody(params, 'anthropic/claude-sonnet-5');
  assert.strictEqual(params.temperature, 0.45, 'caller params must be left intact');
});

console.log('\nD. buildStreamBody — the duplicated transport must not drift');

check('D1 the stream transport strips the same params', () => {
  const body = buildStreamBody(
    { ...DIRECTOR_PARAMS, top_p: 0.9, top_k: 40 },
    'anthropic/claude-sonnet-5'
  );
  for (const k of SAMPLING_PARAMS) assert.ok(!(k in body), `stream kept ${k}`);
  assert.strictEqual(body.stream, true, 'stream flag lost');
});

check('D2 the stream transport spares non-Claude-5 models', () => {
  const body = buildStreamBody({ ...DIRECTOR_PARAMS }, 'openai/gpt-5.6-terra');
  assert.strictEqual(body.temperature, 0.45);
});

check('D3 both transports agree on every id (drift guard)', () => {
  const ids = [
    'anthropic/claude-sonnet-5', 'anthropic/claude-opus-5',
    'anthropic/claude-sonnet-5-ccmax', 'anthropic/claude-sonnet-4.6',
    'openai/gpt-5.6-terra', 'google/gemini-2.5-pro',
  ];
  for (const id of ids) {
    const a = buildAtlasBody({ ...DIRECTOR_PARAMS, top_p: 0.9 }, id);
    const s = buildStreamBody({ ...DIRECTOR_PARAMS, top_p: 0.9 }, id);
    for (const k of SAMPLING_PARAMS) {
      assert.strictEqual(
        k in a, k in s,
        `transports disagree on ${k} for ${id}: atlas=${k in a} stream=${k in s}`
      );
    }
  }
});

console.log('\nF. atlasTextService — the third transport, which posts directly');

check('F1 a Claude 5 model loses the sampling params here too', () => {
  const { buildTextBody } = require('../services/atlasTextService');
  const body = buildTextBody({
    model: 'anthropic/claude-sonnet-5',
    messages: [{ role: 'user', content: 'u' }],
    temperature: 0.4,
    maxTokens: 4096,
  });
  assert.ok(!('temperature' in body), 'atlasTextService must strip temperature on Claude 5');
  assert.strictEqual(body.max_tokens, 4096, 'max_tokens must survive');
  assert.strictEqual(body.model, 'anthropic/claude-sonnet-5');
});

check('F2 its 4.x default keeps temperature (today\'s behaviour is unchanged)', () => {
  const { buildTextBody, DEFAULT_MODEL } = require('../services/atlasTextService');
  assert.strictEqual(
    rejectsSamplingParams(DEFAULT_MODEL), false,
    `DEFAULT_MODEL ${DEFAULT_MODEL} is now a Claude 5 slug — temperature is being dropped; confirm that is intended`
  );
  const body = buildTextBody({
    model: DEFAULT_MODEL,
    messages: [{ role: 'user', content: 'u' }],
    temperature: 0.4,
    maxTokens: 4096,
  });
  assert.strictEqual(body.temperature, 0.4);
});

console.log('\nE. helper contract');

check('E1 stripSamplingParams removes the set and returns the body', () => {
  const body = { temperature: 0.45, top_p: 1, top_k: 2, messages: [] };
  const out = stripSamplingParams(body);
  assert.strictEqual(out, body, 'should return the same object');
  assert.deepStrictEqual(Object.keys(out), ['messages']);
});

check('E2 SAMPLING_PARAMS is exactly the probed-rejected set and is frozen', () => {
  assert.deepStrictEqual([...SAMPLING_PARAMS].sort(), ['temperature', 'top_k', 'top_p']);
  assert.ok(Object.isFrozen(SAMPLING_PARAMS));
});

const total = pass + failures.length;
console.log(`\n${failures.length ? '✗' : '✓'} verifyClaude5SamplingParams: ${pass}/${total} passed`);
if (failures.length) {
  console.log(`  failed: ${failures.join(', ')}`);
  process.exit(1);
}
