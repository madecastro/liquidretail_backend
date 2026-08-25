#!/usr/bin/env node
'use strict';
//
// verifyTitlingResumeAdgenGate — this repo's titling-resume sweep must stand
// down when adgen owns rendering, and must KEEP sweeping otherwise.
//
// WHY. Two services share one MongoDB. ADGEN_RENDERER_ENABLED decides which
// of them renders. adgen's claim path already honours the flag
// (`src/services/renderer.js` poll() returns before claimOne when the helper
// is false). This repo's titling-resume sweeper did not, so when adgen is
// the designated renderer this process still competed for the same rows —
// unbounded, with no titlingAttempts cap, in a web process not sized for
// Remotion. A deterministically-failing ad that adgen would stop retrying
// gets retried forever if this sweeper wins the race.
//
// THE GATE. resumeUntitledMasters consults adgenBridge.isAdgenRendererEnabled
// at CALL TIME (the helper re-reads process.env every call). Fail-safe is
// this repo keeps sweeping unless the helper is true — the same
// `=== 'true'` (case-insensitive) predicate adgen uses to claim. Missing
// or malformed ⇒ neither helper is true ⇒ this repo still sweeps. Standing
// down on any set/truthy value would strand paid untitled masters, because
// adgen will not claim them.
//
// THE GATE LIVES IN THE FUNCTION BODY, not on the interval in index.js.
// An in-flight pass that has already passed the check is allowed to finish;
// only the decision to start a new one is skipped. The interval itself
// keeps ticking so a dashboard flip takes effect without a redeploy.
//
// Offline only: no DB, no network, no API key. Ad.find is monkey-patched
// on the real Mongoose Model (same house style as verifyStrandedSweep.js /
// verifyDeriveWaitBackup.js) so "stood down" is distinguishable from
// "query threw and the catch returned zeros".
//
//   node scripts/verifyTitlingResumeAdgenGate.js
//
// Revert-prove:
//   drop `if (isAdgenRendererEnabled()) return out;`     → B1
//   cache the helper result at module load               → B5
//   read process.env.ADGEN_RENDERER_ENABLED locally      → A2
//   gate setInterval in index.js instead of the function → A4 / C1
//   stand down on any truthy/set value                   → B2 / B3
//

const fs   = require('fs');
const path = require('path');

const ROOT   = path.join(__dirname, '..');
const RESUME = fs.readFileSync(path.join(ROOT, 'services', 'titlingResumeService.js'), 'utf8');
const INDEX  = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
const BRIDGE = fs.readFileSync(path.join(ROOT, 'services', 'adgenBridge.js'), 'utf8');

function stripComments(src) {
  let out = ''; let i = 0; let quote = null;
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
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      out += '  '; i += 2; continue;
    }
    out += c; i++;
  }
  return out;
}

const RESUME_CODE = stripComments(RESUME);
const INDEX_CODE  = stripComments(INDEX);
const BRIDGE_CODE = stripComments(BRIDGE);

let pass = 0;
const failures = [];
function checkTrue(label, cond, extra) {
  if (cond) { pass++; return; }
  failures.push(label + (extra ? ` — ${extra}` : ''));
}
async function checkAsync(label, fn) {
  try { await fn(); pass++; }
  catch (err) { failures.push(`${label}: ${err.message}`); }
}

const { isAdgenRendererEnabled } = require('../services/adgenBridge');
const svc = require('../services/titlingResumeService');
const Ad  = require('../models/Ad');

console.log('verifyTitlingResumeAdgenGate\n');

// ── A. structural: reuse the helper, gate the function, not the interval ─
checkTrue('A1 resumeUntitledMasters requires ./adgenBridge',
  /require\s*\(\s*['"]\.\/adgenBridge['"]\s*\)/.test(RESUME_CODE),
  'a second reader will drift from adgen\'s claim predicate');

checkTrue('A2 the service does not read process.env.ADGEN_RENDERER_ENABLED itself',
  !/process\.env\.ADGEN_RENDERER_ENABLED/.test(RESUME_CODE),
  'inline env reads are how a !== \'false\' / truthy check silently strands ads');

checkTrue('A3 resumeUntitledMasters calls isAdgenRendererEnabled() before Ad.find',
  (() => {
    const fnAt = RESUME_CODE.indexOf('async function resumeUntitledMasters');
    if (fnAt < 0) return false;
    const body = RESUME_CODE.slice(fnAt, RESUME_CODE.indexOf('module.exports', fnAt));
    const gateAt = body.search(/isAdgenRendererEnabled\s*\(\s*\)/);
    const findAt = body.search(/Ad\.find\s*\(/);
    return gateAt >= 0 && findAt >= 0 && gateAt < findAt;
  })(),
  'gating after the query still claims rows; gating only in index.js leaves the export ungated');

{
  const at = INDEX_CODE.indexOf('resumeUntitledMasters');
  const block = at >= 0 ? INDEX_CODE.slice(at, at + 1800) : '';
  checkTrue('A4 index.js keeps the interval running (does not boot-gate on the helper)',
    /setInterval/.test(block) && !/isAdgenRendererEnabled/.test(block),
    'gating setInterval at boot freezes the decision until the next deploy');
}

checkTrue('A5 adgenBridge helper is the exact === \'true\' predicate (call-time env read)',
  /toLowerCase\s*\(\s*\)\s*===\s*['"]true['"]/.test(BRIDGE_CODE)
  && /process\.env\.ADGEN_RENDERER_ENABLED/.test(BRIDGE_CODE)
  && typeof isAdgenRendererEnabled === 'function',
  'a looser predicate would stand this repo down while adgen is also not claiming');

// ── B. behavioural: stand down only when the helper is true ──────────────
const origAdFind = Ad.find;
const origAdgen  = process.env.ADGEN_RENDERER_ENABLED;
const origResume = process.env.TITLING_RESUME_ENABLED;

function withFindSpy(fn) {
  const calls = [];
  Ad.find = function findSpy() {
    calls.push(Array.from(arguments));
    return {
      sort() {
        return {
          limit() {
            return { lean: async () => [] };
          }
        };
      }
    };
  };
  return Promise.resolve()
    .then(fn)
    .then((result) => ({ result, calls }))
    .finally(() => { Ad.find = origAdFind; });
}

(async () => {
  // Kill-switch off so a leftover TITLING_RESUME_ENABLED=false cannot
  // masquerade as the adgen gate.
  process.env.TITLING_RESUME_ENABLED = 'true';

  await checkAsync('B1 ADGEN_RENDERER_ENABLED=true → sweep does not query', async () => {
    process.env.ADGEN_RENDERER_ENABLED = 'true';
    const { calls } = await withFindSpy(() => svc.resumeUntitledMasters());
    if (calls.length !== 0) {
      throw new Error(`Ad.find called ${calls.length} time(s) — this repo raced adgen`);
    }
  });

  await checkAsync('B2 committed default ADGEN_RENDERER_ENABLED=false → sweep still queries', async () => {
    process.env.ADGEN_RENDERER_ENABLED = 'false';
    const { calls } = await withFindSpy(() => svc.resumeUntitledMasters());
    if (calls.length === 0) {
      throw new Error('stood down on \'false\' — adgen will not claim either, paid masters strand');
    }
  });

  await checkAsync('B3 unset ADGEN_RENDERER_ENABLED → sweep still queries', async () => {
    delete process.env.ADGEN_RENDERER_ENABLED;
    const { calls } = await withFindSpy(() => svc.resumeUntitledMasters());
    if (calls.length === 0) {
      throw new Error('stood down on missing flag — dual-none would strand paid masters');
    }
  });

  await checkAsync('B4 malformed values (yes/1/empty) still query; TRUE stands down', async () => {
    for (const v of ['yes', '1', '', 'on']) {
      process.env.ADGEN_RENDERER_ENABLED = v;
      const { calls } = await withFindSpy(() => svc.resumeUntitledMasters());
      if (calls.length === 0) {
        throw new Error(`stood down on malformed ${JSON.stringify(v)} — adgen claim predicate is === 'true'`);
      }
    }
    process.env.ADGEN_RENDERER_ENABLED = 'TRUE';
    const { calls } = await withFindSpy(() => svc.resumeUntitledMasters());
    if (calls.length !== 0) {
      throw new Error('TRUE (case-insensitive) must stand down — that is the shared helper');
    }
  });

  await checkAsync('B5 call-time, not module-load: flipping the env after require takes effect', async () => {
    process.env.ADGEN_RENDERER_ENABLED = 'true';
    const { calls: onCalls } = await withFindSpy(() => svc.resumeUntitledMasters());
    if (onCalls.length !== 0) {
      throw new Error('pre-flip: expected stand-down with flag true');
    }
    process.env.ADGEN_RENDERER_ENABLED = 'false';
    const { calls: offCalls } = await withFindSpy(() => svc.resumeUntitledMasters());
    if (offCalls.length === 0) {
      throw new Error('cached the helper at module load — a dashboard flip would need a redeploy');
    }
  });

  // ── C. gate the sweep, not the module ──────────────────────────────────
  await checkAsync('C1 TITLING_RESUME_ENABLED=false still short-circuits independently of adgen', async () => {
    process.env.TITLING_RESUME_ENABLED = 'false';
    process.env.ADGEN_RENDERER_ENABLED = 'false';
    const { calls } = await withFindSpy(() => svc.resumeUntitledMasters());
    if (calls.length !== 0) {
      throw new Error('TITLING_RESUME_ENABLED=false must still skip; the adgen gate must not replace it');
    }
  });

  // restore
  if (origAdgen === undefined) delete process.env.ADGEN_RENDERER_ENABLED;
  else process.env.ADGEN_RENDERER_ENABLED = origAdgen;
  if (origResume === undefined) delete process.env.TITLING_RESUME_ENABLED;
  else process.env.TITLING_RESUME_ENABLED = origResume;
  Ad.find = origAdFind;

  const total = pass + failures.length;
  if (failures.length) {
    console.error(`verifyTitlingResumeAdgenGate: ${pass}/${total} passed, ${failures.length} FAILED`);
    for (const f of failures) console.error('  FAIL', f);
    process.exit(1);
  }
  console.log(`verifyTitlingResumeAdgenGate: ${pass}/${total} passed`);
  process.exit(0);
})().catch((err) => {
  if (origAdgen === undefined) delete process.env.ADGEN_RENDERER_ENABLED;
  else process.env.ADGEN_RENDERER_ENABLED = origAdgen;
  if (origResume === undefined) delete process.env.TITLING_RESUME_ENABLED;
  else process.env.TITLING_RESUME_ENABLED = origResume;
  Ad.find = origAdFind;
  console.error('verifyTitlingResumeAdgenGate: threw', err);
  process.exit(1);
});
