#!/usr/bin/env node
'use strict';
//
// verifyCrashReporter — offline guards for services/crashReporter.js.
//
// No network, no DB, no API key. mongoose and models/IncidentLog are replaced
// in require.cache BEFORE crashReporter is loaded, so the real driver never
// starts and no connection is attempted.
//
//   node scripts/verifyCrashReporter.js
//
// THE ASSERTION THAT MUST NEVER REGRESS — the ordering rule:
//   the IncidentLog row is written BEFORE the Slack send and is NEVER
//   conditional on it. With crash alerts deliberately un-folded (unique
//   dedupe key per incident), ALERT_RATE_LIMIT_MAX is the only silent drop
//   point left. If the row were written after a successful send, every
//   rate-limited crash would vanish with no record anywhere.

const path = require('path');
const Module = require('module');

let pass = 0;
const failures = [];

function checkTrue(label, cond, extra) {
  if (cond) { pass++; return; }
  failures.push(`${label}${extra ? `\n      ${extra}` : ''}`);
}

function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (ok) { pass++; return; }
  failures.push(`${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
}

// ── fake IncidentLog + mongoose, installed into require.cache ────────────────
// A shared event log records the ORDER of every side effect, which is what the
// ordering assertions read.
const events = [];

const fakeState = {
  created: [],
  updated: [],
  createBehaviour: 'ok',   // 'ok' | 'throw' | 'hang'
  readyState: 1
};

const KINDS = [
  'uncaughtException', 'unhandledRejection', 'shutdown',
  'dispatch-crash', 'render-crash', 'render-stage-failed', 'direct-image-unavailable',
  'video-generation-failed', 'video-titling-failed',
  'static-render-failed', 'ad-not-found',
  'regenerate-failed', 'expansion-product-failed',
  'worker-loop-crash', 'reaper-failed',
  'cost-row-dropped', 'vision-qc-failed', 'director-contract-warn', 'proof-judge-unavailable',
  'alert-rate-limit-spill'
];

const fakeIncidentLog = {
  KINDS,
  LEVELS: ['warn', 'error', 'fatal'],
  TTL_DAYS: 90,
  async create(doc) {
    events.push('incidentlog.create');
    if (fakeState.createBehaviour === 'throw') throw new Error('simulated write failure');
    if (fakeState.createBehaviour === 'hang') await new Promise(() => {});   // never settles
    fakeState.created.push(doc);
    return doc;
  },
  updateOne(filter, update) {
    events.push('incidentlog.updateOne');
    fakeState.updated.push({ filter, update });
    return Promise.resolve({ modifiedCount: 1 });
  }
};

const fakeMongoose = { connection: { get readyState() { return fakeState.readyState; } } };

function inject(request, parentPath, exportsObj) {
  const resolved = Module._resolveFilename(request, { id: parentPath, filename: parentPath, paths: Module._nodeModulePaths(path.dirname(parentPath)) });
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj, children: [], paths: [] };
  return resolved;
}

const svcDir = path.join(__dirname, '..', 'services');
const crashReporterPath = path.join(svcDir, 'crashReporter.js');
inject('../models/IncidentLog', crashReporterPath, fakeIncidentLog);
inject('mongoose', crashReporterPath, fakeMongoose);

const alerts = require('../services/alertService');
const crash = require('../services/crashReporter');

// ── Slack transport stub ─────────────────────────────────────────────────────
const origFetch = global.fetch;
let sends = [];
let sendMode = 'ok';   // 'ok' | 'okfalse' | 'network'

global.fetch = async (url, opts) => {
  events.push('slack.send');
  let body = {};
  try { body = JSON.parse(opts.body); } catch { /* ignore */ }
  sends.push(body);
  if (sendMode === 'network') throw new Error('simulated network failure');
  const payload = sendMode === 'okfalse' ? { ok: false, error: 'channel_not_found' } : { ok: true };
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => payload,
    text: async () => JSON.stringify(payload)
  };
};

function reset(mode = 'ok') {
  events.length = 0;
  sends = [];
  sendMode = mode;
  fakeState.created = [];
  fakeState.updated = [];
  fakeState.createBehaviour = 'ok';
  fakeState.readyState = 1;
  alerts._resetState();
  process.env.SLACK_BOT_TOKEN = 'xoxb-test-token-verify';
  process.env.SLACK_ALERT_CHANNEL = 'C_TEST';
  process.env.ALERT_MIN_LEVEL = 'warn';
  process.env.ALERTS_ENABLED = 'true';
  delete process.env.CRASH_PERSIST_TIMEOUT_MS;
}

(async () => {
  // ══ 1. THE ORDERING RULE ═══════════════════════════════════════════════════
  reset();
  const r1 = await crash.report({
    kind: 'render-crash', level: 'error', title: 'boom',
    err: Object.assign(new Error('kaboom'), { charged: true, predictionId: 'pred-1' }),
    ad: { _id: 'ad-1', status: 'rendering', kind: 'video' },
    run: { runId: 'run-1' }
  });
  const iCreate = events.indexOf('incidentlog.create');
  const iSend = events.indexOf('slack.send');
  checkTrue('ordering: IncidentLog.create happens', iCreate >= 0, `events=${events.join(',')}`);
  checkTrue('ordering: slack.send happens', iSend >= 0, `events=${events.join(',')}`);
  checkTrue('ORDERING RULE: create strictly BEFORE send', iCreate >= 0 && iSend > iCreate,
    `events=${events.join(',')}`);
  check('report() reports persisted', r1.persisted, true);
  check('report() reports delivered', r1.delivered, true);
  checkTrue('incidentId is 12 hex chars', /^[0-9a-f]{12}$/.test(r1.incidentId || ''), r1.incidentId);

  // ══ 2. NO FOLDING — unique dedupe key per incident ═════════════════════════
  reset();
  const ids = [];
  for (let i = 0; i < 5; i++) {
    // Identical title + identical error: under the old folding behaviour only
    // the first of these would have reached Slack for 15 minutes.
    const r = await crash.report({ kind: 'dispatch-crash', title: 'same title every time', err: new Error('same message') });
    ids.push(r.incidentId);
  }
  check('no folding: 5 identical crashes → 5 Slack sends', sends.length, 5);
  check('no folding: 5 IncidentLog rows', fakeState.created.length, 5);
  check('no folding: all incidentIds distinct', new Set(ids).size, 5);
  checkTrue('no folding: none of the messages carries a "suppressed" tally',
    sends.every(s => !/suppressed/.test(String(s.text || ''))));

  // ══ 3. SLACK FAILURE STILL LEAVES A COMPLETE ROW ═══════════════════════════
  // {ok:false} on HTTP 200 is the documented Slack trap — a failed send.
  reset('okfalse');
  const r3 = await crash.report({ kind: 'video-generation-failed', title: 'vendor down', err: new Error('502') });
  check('slack ok:false → delivered=false', r3.delivered, false);
  check('slack ok:false → row STILL persisted', r3.persisted, true);
  check('slack ok:false → exactly one row', fakeState.created.length, 1);
  const patch3 = fakeState.updated[0] && fakeState.updated[0].update.$set;
  checkTrue('slack ok:false → slackDelivered patched false', patch3 && patch3.slackDelivered === false,
    JSON.stringify(patch3));
  checkTrue('slack ok:false → slackError recorded', patch3 && typeof patch3.slackError === 'string' && patch3.slackError.length > 0,
    JSON.stringify(patch3));

  reset('network');
  const r3b = await crash.report({ kind: 'render-crash', title: 'net down', err: new Error('x') });
  check('slack network failure → delivered=false', r3b.delivered, false);
  check('slack network failure → row still persisted', r3b.persisted, true);

  // ══ 4. ALERTS UNCONFIGURED — the row is the only record, and it exists ═════
  reset();
  delete process.env.SLACK_BOT_TOKEN;
  const r4 = await crash.report({ kind: 'shutdown', title: 'no token', err: new Error('x') });
  check('no token → delivered=false', r4.delivered, false);
  check('no token → row STILL persisted (DB is system of record)', r4.persisted, true);
  check('no token → nothing sent', sends.length, 0);

  // ══ 5. MONGO DOWN — degrades, never throws, and SAYS SO in Slack ═══════════
  reset();
  fakeState.readyState = 0;
  const r5 = await crash.report({ kind: 'uncaughtException', title: 'boot crash', err: new Error('early') });
  check('mongo down → persisted=false', r5.persisted, false);
  check('mongo down → Slack still delivered', r5.delivered, true);
  check('mongo down → no create attempted', fakeState.created.length, 0);
  checkTrue('mongo down → Slack message names the omission',
    /incident log/i.test(String(sends[0] && sends[0].text)) &&
    /mongo not connected/i.test(String(sends[0] && sends[0].text)),
    String(sends[0] && sends[0].text).slice(0, 400));

  // ══ 6. PERSIST FAILURE / TIMEOUT still delivers the alert ══════════════════
  reset();
  fakeState.createBehaviour = 'throw';
  const r6 = await crash.report({ kind: 'render-crash', title: 'write fails', err: new Error('x') });
  check('persist throw → persisted=false', r6.persisted, false);
  check('persist throw → alert STILL delivered', r6.delivered, true);

  reset();
  fakeState.createBehaviour = 'hang';
  process.env.CRASH_PERSIST_TIMEOUT_MS = '250';
  const t0 = Date.now();
  const r6b = await crash.report({ kind: 'render-crash', title: 'write hangs', err: new Error('x') });
  const elapsed = Date.now() - t0;
  check('persist hang → persisted=false', r6b.persisted, false);
  check('persist hang → alert STILL delivered', r6b.delivered, true);
  checkTrue('persist hang → bounded by CRASH_PERSIST_TIMEOUT_MS (not indefinite)',
    elapsed < 3000, `elapsed=${elapsed}ms`);
  checkTrue('persist hang → Slack says the row is missing',
    /incident log/i.test(String(sends[0] && sends[0].text)),
    String(sends[0] && sends[0].text).slice(0, 300));

  // ══ 7. NEVER THROWS on any input ══════════════════════════════════════════
  reset();
  const NASTY = [
    undefined,
    {},
    { kind: 'render-crash' },                                  // no title
    { title: 'no kind' },                                      // no kind
    { kind: 'render-crash', title: 123 },                      // non-string title
    { kind: 'render-crash', title: 'x', err: 'a plain string' },
    { kind: 'render-crash', title: 'x', err: { message: 429 } },// non-string .message
    { kind: 'render-crash', title: 'x', err: Object.create(null) },
    { kind: 'render-crash', title: 'x', ad: null, run: null },
    { kind: 'render-crash', title: 'x', ad: 'not-an-object' },
    { kind: 'render-crash', title: 'x', fields: 'not-an-object' },
    { kind: 'render-crash', title: 'x', inFlight: 'nope' },
    { kind: 'render-crash', title: 'x', ids: null }
  ];
  let threw = null;
  for (const o of NASTY) {
    try { await crash.report(o); } catch (e) { threw = `${JSON.stringify(o)} → ${e.message}`; break; }
  }
  checkTrue('report() never throws on malformed input', threw === null, threw);

  // An error whose .message getter itself throws — the pathological vendor case.
  const hostile = {};
  Object.defineProperty(hostile, 'message', { get() { throw new Error('hostile getter'); } });
  Object.defineProperty(hostile, 'stack', { get() { throw new Error('hostile getter'); } });
  let hostileThrew = null;
  try { await crash.report({ kind: 'render-crash', title: 'hostile', err: hostile }); }
  catch (e) { hostileThrew = e.message; }
  checkTrue('report() survives an error with throwing property getters', hostileThrew === null, hostileThrew);

  // reportSync must never surface a rejection (an unhandledRejection handler is
  // installed in production — a rejecting alert path would kill the process).
  let unhandled = null;
  const onUnhandled = (e) => { unhandled = e; };
  process.on('unhandledRejection', onUnhandled);
  crash.reportSync(undefined);
  crash.reportSync({ kind: 'render-crash', title: 'x', err: hostile });
  await new Promise(r => setTimeout(r, 150));
  process.removeListener('unhandledRejection', onUnhandled);
  checkTrue('reportSync never produces an unhandledRejection', unhandled === null,
    unhandled && String(unhandled));

  // ══ 8. MONEY TAGS — charged / predictionId must reach the row and Slack ════
  reset();
  await crash.report({
    kind: 'render-crash', title: 'charged crash',
    err: Object.assign(new Error('after submit'), { charged: true, predictionId: 'pred-money' }),
    ad: { _id: 'ad-m' }
  });
  const mrow = fakeState.created[0] || {};
  check('money: charged persisted', mrow.charged, true);
  check('money: predictionId persisted', mrow.predictionId, 'pred-money');
  checkTrue('money: charged surfaced in Slack', /charged/i.test(String(sends[0] && sends[0].text)),
    String(sends[0] && sends[0].text).slice(0, 300));

  // err.cause carries the tags on wrapped errors — CLAUDE.md §2.
  reset();
  const wrapped = new Error('wrapper');
  wrapped.cause = { charged: true, predictionId: 'pred-cause' };
  await crash.report({ kind: 'render-crash', title: 'wrapped', err: wrapped });
  check('money: charged read from err.cause', (fakeState.created[0] || {}).charged, true);
  check('money: predictionId read from err.cause', (fakeState.created[0] || {}).predictionId, 'pred-cause');

  // Ad.veoPredictionId is the video spend receipt.
  reset();
  await crash.report({ kind: 'video-generation-failed', title: 'v', err: new Error('x'), ad: { _id: 'ad-v', veoPredictionId: 'pred-veo' } });
  check('money: predictionId read from Ad.veoPredictionId', (fakeState.created[0] || {}).predictionId, 'pred-veo');

  // ══ 9. DIAGNOSTIC REUSE — the render-activity block, not a second schema ═══
  reset();
  await crash.report({
    kind: 'render-crash', title: 'diag',
    ad: { _id: 'ad-diag', status: 'rendering', kind: 'video', platformFormat: 'meta_reels_9_16', aspectRatio: '9:16' },
    run: { runId: 'run-diag' }
  });
  const drow = fakeState.created[0] || {};
  checkTrue('diagnostic built from the ad', typeof drow.diagnostic === 'string' && drow.diagnostic.includes('asset=ad-diag'), drow.diagnostic);
  checkTrue('diagnostic carries the render-activity shape', /status=rendering/.test(drow.diagnostic || ''), drow.diagnostic);
  checkTrue('diagnostic reaches Slack as the detail block',
    /asset=ad-diag/.test(String(sends[0] && sends[0].text)),
    String(sends[0] && sends[0].text).slice(0, 500));

  // An explicit diagnostic wins and is used verbatim.
  reset();
  await crash.report({ kind: 'shutdown', title: 'explicit', diagnostic: 'VERBATIM-BLOCK-XYZ' });
  check('explicit diagnostic used verbatim', (fakeState.created[0] || {}).diagnostic, 'VERBATIM-BLOCK-XYZ');

  // ══ 10. TOKEN NEVER LEAKS into a persisted row or a message ════════════════
  reset();
  process.env.SLACK_BOT_TOKEN = 'xoxb-super-secret-value-1234';
  await crash.report({
    kind: 'render-crash', title: 'leaky',
    err: new Error('failed calling https://slack.com with xoxb-super-secret-value-1234')
  });
  const leakRow = JSON.stringify(fakeState.created[0] || {});
  const leakMsg = String(sends[0] && sends[0].text);
  checkTrue('token is not echoed into the Slack message body',
    !leakMsg.includes('xoxb-super-secret-value-1234'), leakMsg.slice(0, 300));
  // The row is internal, but a token in the DB is still a leak worth knowing about.
  checkTrue('token is not echoed into the IncidentLog row',
    !leakRow.includes('xoxb-super-secret-value-1234'),
    'stack/message carried the raw token into Mongo');

  // ══ 11. inFlight snapshot is recorded for crash/shutdown kinds ═════════════
  reset();
  await crash.report({
    kind: 'shutdown', level: 'error', title: 'web shutting down with 3 ad(s) in flight',
    signal: 'SIGTERM',
    inFlight: { runCount: 1, adsRemaining: 3, runIds: ['run-x'], adIds: ['a1', 'a2', 'a3'], submittedAdIds: ['a2'] }
  });
  const srow = fakeState.created[0] || {};
  check('shutdown: signal persisted', srow.signal, 'SIGTERM');
  checkTrue('shutdown: adIds persisted', Array.isArray(srow.inFlight && srow.inFlight.adIds) && srow.inFlight.adIds.length === 3,
    JSON.stringify(srow.inFlight));
  checkTrue('shutdown: submittedAdIds (charged, unrecoverable) persisted',
    Array.isArray(srow.inFlight && srow.inFlight.submittedAdIds) && srow.inFlight.submittedAdIds[0] === 'a2',
    JSON.stringify(srow.inFlight));

  // ══ 11b. DEPLOY CORRELATION — commit must ride every report ═══════════════
  // The colleague's alert could not be tied to a deploy because RENDER_GIT_COMMIT
  // only ever appeared on the info-level boot message, which is muted at the
  // default ALERT_MIN_LEVEL=warn. crashReporter attaches it to every kind, and
  // `incident` must survive the MAX_FIELDS cap on the richest alerts.
  reset();
  process.env.RENDER_GIT_COMMIT = 'abcdef1234567890';
  const manyFields = {};
  for (let i = 0; i < 14; i++) manyFields[`extra${i}`] = `v${i}`;
  const r11b = await crash.report({
    kind: 'shutdown', level: 'error', title: 'crowded payload',
    fields: manyFields,
    ad: { _id: 'ad-c' }, run: { runId: 'run-c' }
  });
  const crowded = String(sends[0] && sends[0].text);
  check('commit persisted on the row', (fakeState.created[0] || {}).commit, 'abcdef12');
  checkTrue('commit reaches Slack', /commit: \*abcdef12\*/.test(crowded), crowded.slice(0, 600));
  checkTrue('incident id survives the MAX_FIELDS cap on a crowded payload',
    crowded.includes(r11b.incidentId), `incidentId=${r11b.incidentId}\n${crowded.slice(0, 800)}`);
  delete process.env.RENDER_GIT_COMMIT;

  // ══ 11c. PER-AD SUPPRESSION — one PAGE per logical failure, every row kept ═
  // One failing static ad surfaces at up to three layers (renderService stage
  // catch, the route's failed-result branch, the route's outer catch). Crash
  // keys are unique by design, so nothing folds them: a 20-ad vendor blip would
  // post 40-60 messages. Slack gets one per ad per window; the DB gets all of
  // them, because "every crash documented" is the other half of the ask.
  reset();
  crash._resetState();
  process.env.CRASH_AD_WINDOW_MS = '60000';
  const layers = ['render-stage-failed', 'static-render-failed', 'render-crash'];
  const results = [];
  for (const k of layers) {
    results.push(await crash.report({ kind: k, title: k, err: new Error('one logical failure'), ad: { _id: 'ad-cascade' } }));
  }
  check('cascade: all three layers persist a row', fakeState.created.length, 3);
  check('cascade: only ONE Slack message', sends.length, 1);
  check('cascade: first is delivered', results[0].delivered, true);
  checkTrue('cascade: later layers are marked suppressed',
    results[1].suppressed === true && results[2].suppressed === true,
    JSON.stringify(results.map(r => r.suppressed)));
  checkTrue('cascade: suppressed rows point at the reported incident',
    results[1].duplicateOf === results[0].incidentId,
    `${results[1].duplicateOf} vs ${results[0].incidentId}`);
  const dupRow = fakeState.created[1] || {};
  check('cascade: duplicateOf persisted on the row', dupRow.duplicateOf, results[0].incidentId);
  const dupPatch = (fakeState.updated.find(u => u.filter.incidentId === results[1].incidentId) || {}).update;
  checkTrue('cascade: suppressed row records WHY no Slack message exists',
    dupPatch && /suppressed/.test(String(dupPatch.$set.slackError)),
    JSON.stringify(dupPatch));

  // A DIFFERENT ad must still page — no folding across ads (the owner's choice).
  reset();
  crash._resetState();
  await crash.report({ kind: 'render-crash', title: 'x', ad: { _id: 'ad-1' } });
  await crash.report({ kind: 'render-crash', title: 'x', ad: { _id: 'ad-2' } });
  await crash.report({ kind: 'render-crash', title: 'x', ad: { _id: 'ad-3' } });
  check('three DIFFERENT ads → three Slack messages (no folding across ads)', sends.length, 3);

  // Process-level crashes carry no adId and must never be suppressed.
  reset();
  crash._resetState();
  await crash.report({ kind: 'uncaughtException', level: 'fatal', title: 'boom 1' });
  await crash.report({ kind: 'uncaughtException', level: 'fatal', title: 'boom 2' });
  check('adId-less reports are never suppressed', sends.length, 2);

  // The window is tunable, and 0 disables suppression entirely.
  reset();
  crash._resetState();
  process.env.CRASH_AD_WINDOW_MS = '0';
  await crash.report({ kind: 'render-crash', title: 'x', ad: { _id: 'ad-same' } });
  await crash.report({ kind: 'render-crash', title: 'x', ad: { _id: 'ad-same' } });
  check('CRASH_AD_WINDOW_MS=0 disables suppression', sends.length, 2);
  delete process.env.CRASH_AD_WINDOW_MS;

  // Bounded — the tracking Map must not grow forever in a long-lived process.
  crash._resetState();
  process.env.CRASH_AD_WINDOW_MS = '60000';
  reset();
  for (let i = 0; i < 640; i++) {
    await crash.report({ kind: 'render-crash', title: 'bulk', ad: { _id: `bulk-${i}` } });
  }
  checkTrue('per-ad map is bounded (<= 500)', crash._stateSize().lastByAd <= 500,
    JSON.stringify(crash._stateSize()));
  delete process.env.CRASH_AD_WINDOW_MS;
  crash._resetState();

  // ══ 12. exports + KINDS contract ══════════════════════════════════════════
  checkTrue('exports report', typeof crash.report === 'function');
  checkTrue('exports reportSync', typeof crash.reportSync === 'function');
  checkTrue('re-exports KINDS', Array.isArray(crash.KINDS) && crash.KINDS.length > 0);
  for (const k of ['shutdown', 'uncaughtException', 'dispatch-crash', 'video-generation-failed', 'render-crash']) {
    checkTrue(`KINDS includes ${k}`, crash.KINDS.includes(k));
  }

  // ── report ────────────────────────────────────────────────────────────────
  global.fetch = origFetch;
  console.log(`\nverifyCrashReporter: ${pass} passed, ${failures.length} failed\n`);
  if (failures.length) {
    for (const f of failures) console.error(`  ✗ ${f}`);
    console.error('');
    process.exit(1);
  }
  console.log('  all checks passed\n');
})().catch(err => {
  console.error(`\nverifyCrashReporter: harness itself threw — ${err && err.stack}\n`);
  process.exit(1);
});
