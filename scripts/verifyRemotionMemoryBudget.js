'use strict';
// Pins REMOTION_QUEUE_CONCURRENCY coherence (2026-08-26). Before this: the
// committed file default (3), adgen-renderer's live dashboard (2), and
// adgen-titler's live dashboard (4) were three different values for the
// same memory-governing knob, plus a FOURTH silently-diverging number in
// remotionRenderService.js's own in-code fallback (`|| 4`). adgen-titler
// running at 4 (~7.9 GiB of an 8 GiB box) OOM-killed three instances in
// 44h — see config/defaults.env's 2026-08-26 section for the full incident
// and the autoscaling-trigger mechanism that made adding instances make it
// WORSE, not better.
//
// This harness pins: (A) the file default and code fallback now agree at 2;
// (B) a boot-time loud-log guard exists and actually fires at unsafe values
// — proven by spawning REAL child processes with controlled env, not a
// regex; (C) the guard is configurable so it can follow a real instance-size
// change without a code edit; (D) render.yaml's own comments were brought
// back in line with the live dashboard values they describe.

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const REPO = path.resolve(__dirname, '..');

const failures = [];
const passes = [];
function check(name, cond, detail) {
  if (cond === true) passes.push(name);
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const svcPath = path.join(REPO, 'src', 'services', 'remotionRenderService.js');
const svcSrc = fs.readFileSync(svcPath, 'utf8');
const defaultsEnv = fs.readFileSync(path.join(REPO, 'config', 'defaults.env'), 'utf8');
const renderYaml = fs.readFileSync(path.join(REPO, 'render.yaml'), 'utf8');

// ── A. Committed default + in-code fallback agree at 2 ─────────────────────
check('A1: config/defaults.env declares REMOTION_QUEUE_CONCURRENCY=2',
  /^REMOTION_QUEUE_CONCURRENCY=2$/m.test(defaultsEnv));
check('A2: remotionRenderService.js\'s in-code fallback is `|| 2`, not the old `|| 4`',
  /parseInt\(process\.env\.REMOTION_QUEUE_CONCURRENCY,\s*10\)\s*\|\|\s*2\s*\n?\s*\)/.test(svcSrc));
check('A3: [REVERT-PROOF] the old `|| 4` literal is NOT present anywhere near the QUEUE_CONCURRENCY definition',
  !/QUEUE_CONCURRENCY = Math\.max\(\s*\n\s*1,\s*\n\s*parseInt\(process\.env\.REMOTION_QUEUE_CONCURRENCY, 10\) \|\| 4/.test(svcSrc));

// ── B. Boot-time guard exists and is wired ──────────────────────────────────
check('B1: checkRemotionMemoryBudget() is defined', /function checkRemotionMemoryBudget\(\)/.test(svcSrc));
check('B2: it is actually CALLED at module load (not just defined and forgotten)',
  /checkRemotionMemoryBudget\(\);\s*$/m.test(svcSrc));
check('B3: reads REMOTION_MEASURED_MB_PER_SLOT from env with a ~1.97 GiB default',
  /REMOTION_MEASURED_MB_PER_SLOT\s*\|\|\s*2016/.test(svcSrc));
check('B4: reads REMOTION_INSTANCE_MEMORY_MB from env with an 8 GiB (pro_plus) default',
  /REMOTION_INSTANCE_MEMORY_MB\s*\|\|\s*8192/.test(svcSrc));
check('B5: reads REMOTION_AUTOSCALE_TRIGGER_PCT from env with a 60% default (Render\'s actual autoscale trigger)',
  /REMOTION_AUTOSCALE_TRIGGER_PCT\s*\|\|\s*60/.test(svcSrc));
check('B6: distinguishes a hard OOM-territory error (>=90%) from a softer autoscale-trigger warning (>= trigger%)',
  /pctOfInstance >= 90/.test(svcSrc) && /pctOfInstance >= autoscaleTriggerPct/.test(svcSrc));

// ── C. Execution: spawn REAL child processes with controlled env and prove the guard fires ──
function runWithConcurrency(concurrency, extraEnv = {}) {
  // Load only the module (no role/mongo bootstrap needed — this module
  // doesn't require ../config) with REMOTION_QUEUE_CONCURRENCY set, and
  // capture stderr, where console.warn/console.error land. spawnSync (not
  // execFileSync) so stderr is available on BOTH the success and failure
  // path — execFileSync only returns stdout on success.
  const res = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(svcPath)});`], {
    env: { ...process.env, REMOTION_QUEUE_CONCURRENCY: String(concurrency), ...extraEnv },
    encoding: 'utf8',
  });
  return {
    stderr: res.stderr || '',
    threw: res.status !== 0,
    message: res.error ? res.error.message : `exit ${res.status}`,
  };
}

const at4 = runWithConcurrency(4);
check('C1: concurrency=4 does not crash the process (loud, not fatal)', !at4.threw, at4.message);
check('C2: concurrency=4 logs the OOM-territory 🚨 error (this is the exact value that killed adgen-titler three times)',
  /🚨 remotion:.*concurrency=4/.test(at4.stderr) || (/🚨 remotion:/.test(at4.stderr) && /REMOTION_QUEUE_CONCURRENCY=4/.test(at4.stderr)),
  `stderr: ${at4.stderr.slice(0, 300)}`);

const at3 = runWithConcurrency(3);
check('C3: concurrency=3 does not crash the process', !at3.threw, at3.message);
check('C4: concurrency=3 logs the softer ⚠️  autoscale-trigger warning (74% — over the 60% trigger, safe only without autoscaling)',
  /⚠️.*remotion:/.test(at3.stderr) && !/🚨/.test(at3.stderr),
  `stderr: ${at3.stderr.slice(0, 300)}`);

const at2 = runWithConcurrency(2);
check('C5: concurrency=2 does not crash the process', !at2.threw, at2.message);
check('C6: concurrency=2 (the new default — 49%, under the autoscale trigger) logs NEITHER warning',
  !/🚨/.test(at2.stderr) && !/⚠️.*remotion:/.test(at2.stderr),
  `stderr: ${at2.stderr.slice(0, 300)}`);

// A misconfigured override (0 or negative) must not crash the require — the
// check should just skip rather than divide-by-something-broken.
const atZeroInstanceMb = runWithConcurrency(2, { REMOTION_INSTANCE_MEMORY_MB: '0' });
check('C7: a misconfigured REMOTION_INSTANCE_MEMORY_MB=0 override does not crash the require (skips the check instead)',
  !atZeroInstanceMb.threw, atZeroInstanceMb.message);

// ── D. render.yaml comments brought back in line with the live dashboards ──
//
// STRUCTURALLY bounded to each service (same serviceBlock() as
// verifyTitlerHandoff G1–G6), then an exact comment LINE — never
// `adgen-renderer[\s\S]{0,800}REMOTION_QUEUE_CONCURRENCY=2`. That window
// was satisfied by "Do not restore REMOTION_QUEUE_CONCURRENCY=2" while the
// live-value line said 4, and went CI-red when ~700 comment chars landed
// between `name:` and the first `=2`.
function serviceBlock(yamlText, serviceName) {
  const anchor = new RegExp(`name:\\s*${serviceName}\\b`);
  const m = anchor.exec(yamlText);
  if (!m) return null;
  const rest = yamlText.slice(m.index);
  const nextBoundary = /\n\s*-\s*type:\s*\w+/.exec(rest);
  return nextBoundary ? rest.slice(0, nextBoundary.index) : rest;
}
const rendererYamlBlock = serviceBlock(renderYaml, 'adgen-renderer') || '';
const titlerYamlBlock = serviceBlock(renderYaml, 'adgen-titler') || '';

check('D1: render.yaml renderer block states its ACTUAL live value is 2 (was describing 3, which the dashboard never ran)',
  /^\s*# REMOTION_QUEUE_CONCURRENCY=2 \(≈3\.9 GB peak/m.test(rendererYamlBlock));
check('D2: render.yaml titler block documents the 2026-08-26 OOM incident and the 4 -> 2 orchestrator action item',
  /2026-08-26/.test(titlerYamlBlock) &&
  /^\s*# Orchestrator action item: dashboard 4 -> 2\.\s*$/m.test(titlerYamlBlock));

// ── report ───────────────────────────────────────────────────────────────
console.log(`\nverifyRemotionMemoryBudget: ${passes.length} pass, ${failures.length} fail`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
for (const p of passes) console.log('  ✓ ' + p);
console.log('\n✅ REMOTION_QUEUE_CONCURRENCY has one coherent value (2) across the file default and in-code fallback, and the boot-time guard genuinely fires at the values that killed adgen-titler.');
