#!/usr/bin/env node
'use strict';
//
// verifyConcurrencyConfig — offline harness for the concurrency table.
//
// Asserts:
//   1. Every knob resolves from env with its documented default.
//   2. No concurrency numeric literal remains in the A2 service list
//      (they must read services/concurrency.js).
//   3. PROVIDER-IMPOSED ceilings cannot be raised above max via env
//      (Grok stays <=1 RPS; GROK_MAX_RPS=99 clamps to 1).
//   4. Grok min spacing survives ATLAS_SUBMIT_SPACING_MS=0.
//   5. pacedModelSubmit is per-model-slug (Omni and Grok do not share a
//      gate) so raising VEO_CONCURRENCY cannot break Grok's 1 RPS.
//   6. logConcurrencyConfig runs cleanly.
//
// Pure + offline: no DB, no network, no API key.
//   node scripts/verifyConcurrencyConfig.js
//
// Revert-prove: temporarily hardcode a literal back into one A2 file
// (or set GROK_MAX_RPS clamp to allow >1) and confirm this script fails.

const fs = require('fs');
const path = require('path');

// Load defaults.env the same way index.js does (env always wins).
require('dotenv').config({ path: path.join(__dirname, '..', 'config', 'defaults.env') });

const {
  SPEC,
  resolveAll,
  resolveKnob,
  isGrokModel,
  submitSpacingMsForModel,
  logConcurrencyConfig
} = require('../services/concurrency');

let pass = 0;
const failures = [];

function check(label, actual, expected) {
  const ok = Object.is(actual, expected) || actual === expected;
  if (ok) { pass++; return; }
  failures.push(`${label}\n      expected: ${expected}\n      actual:   ${actual}`);
}

function checkTrue(label, cond) {
  if (cond) { pass++; return; }
  failures.push(`${label}\n      expected: truthy\n      actual:   ${cond}`);
}

// ── A. Documented defaults resolve ────────────────────────────────────
// Snapshot env, clear every concurrency env var, resolve, restore.
const ENV_KEYS = Object.values(SPEC).map((s) => s.env);
const saved = {};
for (const k of ENV_KEYS) {
  saved[k] = process.env[k];
  delete process.env[k];
}
const clean = resolveAll();
for (const [key, spec] of Object.entries(SPEC)) {
  check(`A default ${key}`, clean[key], spec.default);
}
check('A GROK_MIN_SUBMIT_SPACING_MS at 1 RPS is 1000', clean.GROK_MIN_SUBMIT_SPACING_MS, 1000);
// Restore defaults.env values (or prior env).
for (const k of ENV_KEYS) {
  if (saved[k] === undefined) delete process.env[k];
  else process.env[k] = saved[k];
}
// Re-apply defaults.env so subsequent checks see file defaults.
require('dotenv').config({ path: path.join(__dirname, '..', 'config', 'defaults.env') });
const fromDefaults = resolveAll();
// 8 -> 24 on 2026-08-04 (owner: renders should all go to Atlas at once).
// MAX_CREATIVES_PER_RUN is 20, so this gate is now non-binding for a full run —
// every static ad submits together. Pinned so the file and the code default
// cannot drift apart: a disagreement between them is the exact "silent config
// lie" CLAUDE.md 4a warns about.
check('A defaults.env RENDER_CONCURRENCY is 24', fromDefaults.RENDER_CONCURRENCY, 24);
check('A RENDER_CONCURRENCY exceeds MAX_CREATIVES_PER_RUN, so a full run fires at once',
  fromDefaults.RENDER_CONCURRENCY >= fromDefaults.MAX_CREATIVES_PER_RUN, true);
// VEO_CONCURRENCY 4 -> 12 on 2026-08-05, when the veo lane's two halves were
// split. It now gates the SUBMIT+POLL half only (remote, idle — an Omni poll is
// ~2min of waiting, measured p50 117s / p99 247s). The Remotion titling half —
// headless Chrome + ffmpeg in-process, which is what the old 4 was really
// protecting — moved behind VEO_TITLING_CONCURRENCY and is deliberately still 4.
// Kept <= MAX_CREATIVES_PER_RUN unlike RENDER_CONCURRENCY: going non-binding
// here is a separate, measured decision. See scripts/verifyTitlingPermit.js.
check('A defaults.env VEO_CONCURRENCY is 12', fromDefaults.VEO_CONCURRENCY, 12);
check('A defaults.env VEO_TITLING_CONCURRENCY is 4', fromDefaults.VEO_TITLING_CONCURRENCY, 4);
check('A the veo split holds: submit+poll runs wider than in-process titling',
  fromDefaults.VEO_CONCURRENCY > fromDefaults.VEO_TITLING_CONCURRENCY, true);
check('A defaults.env ATLAS_SUBMIT_SPACING_MS is 1200', fromDefaults.ATLAS_SUBMIT_SPACING_MS, 1200);
check('A defaults.env GROK_MAX_RPS is 1', fromDefaults.GROK_MAX_RPS, 1);

// ── B. Env overrides work for SELF-IMPOSED ────────────────────────────
process.env.RENDER_CONCURRENCY = '12';
process.env.VEO_CONCURRENCY = '6';
process.env.CAMPAIGN_BRIEF_CONCURRENCY = '5';
const overridden = resolveAll();
check('B RENDER_CONCURRENCY env override', overridden.RENDER_CONCURRENCY, 12);
check('B VEO_CONCURRENCY env override', overridden.VEO_CONCURRENCY, 6);
check('B CAMPAIGN_BRIEF_CONCURRENCY env override', overridden.CAMPAIGN_BRIEF_CONCURRENCY, 5);
delete process.env.RENDER_CONCURRENCY;
delete process.env.VEO_CONCURRENCY;
delete process.env.CAMPAIGN_BRIEF_CONCURRENCY;
require('dotenv').config({ path: path.join(__dirname, '..', 'config', 'defaults.env') });

// ── C. PROVIDER-IMPOSED: Grok cannot be raised above 1 RPS ────────────
process.env.GROK_MAX_RPS = '99';
const raised = resolveAll();
check('C GROK_MAX_RPS=99 clamps to 1 (PROVIDER ceiling)', raised.GROK_MAX_RPS, 1);
check('C GROK_MIN_SUBMIT_SPACING_MS still >= 1000 when env tries 99 RPS',
  raised.GROK_MIN_SUBMIT_SPACING_MS >= 1000, true);
delete process.env.GROK_MAX_RPS;

process.env.GROK_MAX_RPS = '0.5';
const lowered = resolveAll();
check('C GROK_MAX_RPS=0.5 allowed (can only lower)', lowered.GROK_MAX_RPS, 0.5);
check('C GROK_MIN_SUBMIT_SPACING_MS at 0.5 RPS is 2000', lowered.GROK_MIN_SUBMIT_SPACING_MS, 2000);
delete process.env.GROK_MAX_RPS;
require('dotenv').config({ path: path.join(__dirname, '..', 'config', 'defaults.env') });

// Spacing for Grok ignores a zero ATLAS_SUBMIT_SPACING_MS floor-break attempt.
process.env.ATLAS_SUBMIT_SPACING_MS = '0';
process.env.GROK_MAX_RPS = '1';
const zeroSpacing = resolveAll();
const grokSlug = 'xai/grok-imagine-video-v1.5/image-to-video';
const omniSlug = 'google/gemini-omni-flash/image-to-video-developer';
check('C Grok spacing with ATLAS_SUBMIT_SPACING_MS=0 is still >=1000',
  submitSpacingMsForModel(grokSlug, zeroSpacing) >= 1000, true);
check('C Omni spacing with ATLAS_SUBMIT_SPACING_MS=0 is 0',
  submitSpacingMsForModel(omniSlug, zeroSpacing), 0);
delete process.env.ATLAS_SUBMIT_SPACING_MS;
delete process.env.GROK_MAX_RPS;
require('dotenv').config({ path: path.join(__dirname, '..', 'config', 'defaults.env') });

checkTrue('C isGrokModel recognises Grok 1.5', isGrokModel(grokSlug));
checkTrue('C isGrokModel rejects Omni', !isGrokModel(omniSlug));

// ── D. No concurrency literals in A2 service sources ──────────────────
// Patterns that used to hold the hardcoded pool sizes. Comments and
// identifiers that merely *name* concurrency are fine; bare numeric
// pool sizes assigned/passed as concurrency are not.
const A2_FILES = [
  'services/campaignSyncService.js',
  'services/aiLayoutStudioService.js',
  'services/cloudinaryService.js',
  'services/productCategoryInferenceService.js',
  'services/metaAdsPushService.js',
  'services/genericCatalogIngestService.js',
  'services/catalogSyncService.js',
  'services/scheduledSyncService.js'
];
// Matches e.g. `const CONCURRENCY = 3`, `concurrency: 6`, `concurrency = 4`,
// `COMBO_CONCURRENCY = 3`, default-arg `concurrency = 8`.
const LITERAL_RE = /\b(?:CONCURRENCY|COMBO_CONCURRENCY|PUSH_CONCURRENCY|DOMAIN_CONCURRENCY)\s*=\s*\d+\b|\bconcurrency\s*[:=]\s*\d+\b/;

const root = path.join(__dirname, '..');
for (const rel of A2_FILES) {
  const src = fs.readFileSync(path.join(root, rel), 'utf8');
  // Strip block + line comments so prose like "concurrency=2 so a backlog"
  // in a comment does not fail the scan.
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  const hit = stripped.match(LITERAL_RE);
  checkTrue(`D no concurrency literal in ${rel}`, !hit);
  if (hit) failures[failures.length - 1] += `\n      matched: ${hit[0]}`;
}

// ── E. pacedModelSubmit is per-model-slug ─────────────────────────────
// Two models must be able to submit concurrently (different gates). Same
// model must serialize. We drive the real function with no-op fns and
// zero Omni spacing; Grok still spaces >=1000ms.
process.env.ATLAS_SUBMIT_SPACING_MS = '0';
// atlasVideoService freezes SUBMIT_SPACING via concurrency at require —
// submitSpacingMsForModel re-reads via resolveAll for Grok floor, and for
// Omni uses ATLAS_SUBMIT_SPACING_MS from the *frozen* concurrency object
// loaded at first require of concurrency.js.
//
// To exercise live spacing logic without reloading modules, we only need
// the gate Map behaviour: two different slugs must not share a serial
// chain. Measure wall-clock overlap.
const {
  pacedModelSubmit
} = require('../services/atlasVideoService');

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function runPacingChecks() {
  // E1: different models run in parallel — both "work" for 80ms; if they
  // shared a global gate wall would be ~160ms+.
  const t0 = Date.now();
  await Promise.all([
    pacedModelSubmit('test/model-a', async () => { await sleep(80); return 'a'; }),
    pacedModelSubmit('test/model-b', async () => { await sleep(80); return 'b'; })
  ]);
  const parallelMs = Date.now() - t0;
  checkTrue(`E1 different model slugs run in parallel (wall=${parallelMs}ms < 140)`, parallelMs < 140);

  // E2: same model serializes — two 80ms jobs on one slug → wall >= 150ms.
  const t1 = Date.now();
  await Promise.all([
    pacedModelSubmit('test/model-serial', async () => { await sleep(80); return 1; }),
    pacedModelSubmit('test/model-serial', async () => { await sleep(80); return 2; })
  ]);
  const serialMs = Date.now() - t1;
  checkTrue(`E2 same model slug serializes (wall=${serialMs}ms >= 150)`, serialMs >= 150);

  // E3: Grok floor — two Grok submits with fn that records timestamps.
  // Even if ATLAS_SUBMIT_SPACING_MS process.env is 0, the frozen module
  // value may still be 1200 from first load. Measure delta between starts;
  // require at least GROK floor (1000) OR the module's ATLAS spacing.
  const starts = [];
  await Promise.all([
    pacedModelSubmit(grokSlug, async () => { starts.push(Date.now()); return 1; }),
    pacedModelSubmit(grokSlug, async () => { starts.push(Date.now()); return 2; })
  ]);
  starts.sort((a, b) => a - b);
  const delta = starts[1] - starts[0];
  // Must be at least 1000ms (Grok 1 RPS). If module ATLAS spacing is 1200,
  // delta will be ~1200. Either way we assert the PROVIDER floor.
  checkTrue(`E3 Grok same-slug spacing >= 1000ms (delta=${delta}ms)`, delta >= 950);

  // E4: Omni and Grok gates are independent — a slow Omni must not delay Grok start.
  const marks = { omniStart: 0, grokStart: 0 };
  const omniP = pacedModelSubmit(omniSlug, async () => {
    marks.omniStart = Date.now();
    await sleep(200);
    return 'omni';
  });
  // Start Grok slightly after Omni has entered its gate.
  await sleep(20);
  const grokP = pacedModelSubmit(grokSlug + '-indep', async () => {
    marks.grokStart = Date.now();
    return 'grok';
  });
  await Promise.all([omniP, grokP]);
  const lag = marks.grokStart - marks.omniStart;
  checkTrue(
    `E4 Grok not blocked behind Omni (lag=${lag}ms; should start during Omni work)`,
    marks.grokStart > 0 && lag < 180
  );
}

// ── F. logConcurrencyConfig is clean ──────────────────────────────────
const logs = [];
const origLog = console.log;
console.log = (...args) => { logs.push(args.join(' ')); };
try {
  logConcurrencyConfig(resolveAll());
} finally {
  console.log = origLog;
}
checkTrue('F logConcurrencyConfig emitted a line', logs.length >= 1);
checkTrue('F log contains RENDER_CONCURRENCY', /RENDER_CONCURRENCY=/.test(logs.join('\n')));
checkTrue('F log tags PROVIDER for GROK_MAX_RPS', /GROK_MAX_RPS=\d+(?:\.\d+)?\[PROVIDER\]/.test(logs.join('\n')));

// ── G. SPEC completeness — every entry has ceiling + why ──────────────
for (const [key, spec] of Object.entries(SPEC)) {
  checkTrue(`G ${key} has env name`, typeof spec.env === 'string' && spec.env.length > 0);
  checkTrue(`G ${key} has default`, Number.isFinite(spec.default));
  checkTrue(`G ${key} has why`, typeof spec.why === 'string' && spec.why.length > 10);
  checkTrue(`G ${key} ceiling is PROVIDER or SELF`,
    spec.ceiling === 'PROVIDER-IMPOSED' || spec.ceiling === 'SELF-IMPOSED');
}
checkTrue('G GROK_MAX_RPS is the only PROVIDER-IMPOSED entry (or among them)',
  SPEC.GROK_MAX_RPS.ceiling === 'PROVIDER-IMPOSED');
check('G GROK_MAX_RPS max is 1', SPEC.GROK_MAX_RPS.max, 1);

// Run async pacing checks then report.
runPacingChecks().then(() => {
  if (failures.length) {
    console.error(`verifyConcurrencyConfig: ${failures.length} failure(s), ${pass} passed\n`);
    for (const f of failures) console.error('  FAIL', f);
    process.exit(1);
  }
  console.log(`verifyConcurrencyConfig: ${pass} checks passed`);
  process.exit(0);
}).catch((err) => {
  console.error('verifyConcurrencyConfig: async check crashed:', err);
  process.exit(1);
});
