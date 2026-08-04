#!/usr/bin/env node
'use strict';
//
// verifyProcessAlerts — offline guards for services/processAlerts.js.
//
// No network, no DB, no API key. crashReporter / inFlight / mongoose / the
// models are replaced in require.cache inside each child.
//
//   node scripts/verifyProcessAlerts.js
//
// WHY CHILD PROCESSES. The two things most worth pinning here are the exit
// SEMANTICS — the real exit code, and the fact that a co-resident SIGTERM
// listener cannot keep the process alive — and those are only observable from
// outside. processAlerts also has module-level `installed` / `terminating`
// latches, so each scenario needs a fresh process anyway.
//
// THE ASSERTIONS THAT MUST NEVER REGRESS:
//   1. persistOrphans runs BEFORE the report, and its requeued ad ids reach
//      the payload. Previously both ran in Promise.all, so the ids the persist
//      step had just learned could never appear in the alert — which is the
//      whole reason a deploy-time alert was undiagnosable.
//   2. The payload names ADS (id + stage + charged), not just counts.
//   3. Termination is guaranteed even when a puppeteer-style listener swallows
//      the re-raised signal, and even when crashReporter rejects.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0;
const failures = [];

function checkTrue(label, cond, extra) {
  if (cond) { pass++; return; }
  failures.push(`${label}${extra ? `\n      ${extra}` : ''}`);
}
function check(label, actual, expected) {
  if (Object.is(actual, expected)) { pass++; return; }
  failures.push(`${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
}

const REPO = path.join(__dirname, '..');

// ── the child harness ────────────────────────────────────────────────────────
// Injects fakes, installs the handlers, triggers one scenario, and prints
// every observed side effect as one JSON line prefixed with @@RESULT@@.
function childSource(scenario) {
  return `
'use strict';
const path = require('path');
const fs = require('fs');
const Module = require('module');
const REPO = ${JSON.stringify(REPO)};
const paPath = path.join(REPO, 'services', 'processAlerts.js');

// Emit SYNCHRONOUSLY with fs.writeSync. On the SIGTERM path the handler
// re-raises and the process dies by signal, so process.exit() never runs and a
// buffered stdout write would be lost with it. Emitting from inside the handler
// is the only way the parent sees the payload at all.
function emit(extra) {
  try {
    fs.writeSync(1, '@@RESULT@@' + JSON.stringify(Object.assign(
      { events, reported, exitCode }, extra || {}
    )) + '\\n');
  } catch (e) { /* ignore */ }
}

function inject(request, parentPath, exportsObj) {
  const resolved = Module._resolveFilename(request, {
    id: parentPath, filename: parentPath,
    paths: Module._nodeModulePaths(path.dirname(parentPath))
  });
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true,
    exports: exportsObj, children: [], paths: [] };
}

const events = [];        // ordered side-effect log
let reported = null;      // the crashReporter payload
let exitCode = null;

const SCENARIO = ${JSON.stringify(scenario)};

// ── fake inFlight ──
const ADS = SCENARIO.clean ? [] : ['ad-aaa', 'ad-bbb'];
const SUBMITTED = SCENARIO.clean ? [] : ['ad-bbb'];
const snapshot = {
  runCount:       SCENARIO.clean ? 0 : 1,
  adsRemaining:   SCENARIO.clean ? 0 : 2,
  veoRuns:        SCENARIO.clean ? 0 : 1,
  oldestAgeMs:    42000,
  lines:          SCENARIO.clean ? [] : ['run-zzz 0/2 veo brand=brand-1 age=42s'],
  runIds:         SCENARIO.clean ? [] : ['run-zzz'],
  adIds:          ADS,
  submittedAdIds: SUBMITTED,
  adLines:        SCENARIO.clean ? [] : [
    'ad-aaa stage=derive age=40s',
    'ad-bbb stage=veo submit age=39s SUBMITTED/charged'
  ],
  oldestAdAgeMs:  40000
};
inject('./inFlight', paPath, { snapshot: () => snapshot, track(){}, progress(){}, untrack(){},
  trackAd(){}, adStage(){}, markSubmitted(){}, untrackAd(){} });

// ── fake crashReporter ──
inject('./crashReporter', paPath, {
  report: async (opts) => {
    events.push('report');
    reported = {
      kind: opts.kind, level: opts.level, title: opts.title,
      signal: opts.signal || null,
      fields: opts.fields || {},
      diagnostic: opts.diagnostic || null,
      inFlightAdIds: (opts.inFlight && opts.inFlight.adIds) || null,
      errMessage: opts.err ? String(opts.err.message || opts.err) : null
    };
    emit();   // synchronous: the SIGTERM path dies by signal right after this
    if (SCENARIO.reportRejects) throw new Error('crashReporter exploded');
    return { incidentId: 'deadbeefcafe', persisted: true, delivered: true };
  },
  reportSync() {}
});

// ── fake alertService (boot alert only) ──
inject('./alertService', paPath, {
  notify: async () => true, notifyAsync() {}, info(){}, warn(){}, error(){}, fatal(){},
  isConfigured: () => true, redact: (s) => s
});

// ── fake mongoose + models ──
inject('mongoose', paPath, { connection: { readyState: SCENARIO.mongoDown ? 0 : 1 } });
inject('../models/Ad', paPath, {
  find: () => ({ lean: async () => { events.push('ad.find'); return ADS.map(id => ({ _id: id })); } }),
  updateMany: async () => { events.push('ad.updateMany'); return { modifiedCount: ADS.length }; }
});
inject('../models/CampaignRun', paPath, {
  updateMany: async () => { events.push('run.updateMany'); return { modifiedCount: 1 }; }
});

process.env.RENDER_GIT_COMMIT = 'abc1234567890';
process.env.ALERT_EXIT_FLUSH_MS = '1500';

// Capture the exit code without actually exiting, so we can print first.
const realExit = process.exit.bind(process);
process.exit = (c) => {
  if (exitCode === null) exitCode = c;
  events.push('exit:' + c);
  emit();
  realExit(c);
};

const { installProcessAlerts } = require(paPath);
installProcessAlerts({ role: 'web' });

// A puppeteer-style co-resident listener: closes its browser, never exits.
// Its presence is why re-raise alone is not enough and the 1s timer exists.
if (SCENARIO.coResidentListener) {
  process.on('SIGTERM', () => { events.push('coResident'); });
}

if (SCENARIO.kind === 'sigterm') {
  process.kill(process.pid, 'SIGTERM');
} else {
  // Drive the handler the way Node would.
  process.emit('uncaughtException', new Error('synthetic boom'));
}

// Keep the loop alive long enough for the async handler + the 1s exit timer.
setTimeout(() => {
  emit({ timedOut: true });
  realExit(99);
}, 6000);
`;
}

function run(scenario) {
  const file = path.join(os.tmpdir(), `pa-child-${process.pid}-${Math.abs(scenario.id)}.js`);
  fs.writeFileSync(file, childSource(scenario));
  try {
    const r = spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 20000 });
    const lines = String(r.stdout || '').split('\n').filter(l => l.startsWith('@@RESULT@@'));
    const line = lines.length ? lines[lines.length - 1] : null;
    let parsed = null;
    if (line) { try { parsed = JSON.parse(line.slice('@@RESULT@@'.length)); } catch { /* ignore */ } }
    return { parsed, status: r.status, signal: r.signal, stderr: String(r.stderr || '') };
  } finally {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  }
}

console.log('\nverifyProcessAlerts — ordering, payload richness, and exit semantics\n');

// ══ A. SIGTERM with ads in flight ═══════════════════════════════════════════
{
  const { parsed, status, signal, stderr } = run({ id: 1, kind: 'sigterm' });
  checkTrue('A0 child produced a result', parsed !== null, stderr.slice(-500));
  if (parsed) {
    const e = parsed.events;
    const iFind = e.indexOf('ad.find');
    const iUpd = e.indexOf('ad.updateMany');
    const iRep = e.indexOf('report');

    // 1. THE ORDERING RULE
    checkTrue('A1 persist queried the orphan ids', iFind >= 0, e.join(','));
    checkTrue('A2 persist updated the ads', iUpd > iFind, e.join(','));
    checkTrue('A3 ORDERING: persistOrphans completes BEFORE the report', iRep > iUpd, e.join(','));

    const f = (parsed.reported && parsed.reported.fields) || {};
    check('A4 kind is shutdown', parsed.reported && parsed.reported.kind, 'shutdown');
    check('A5 level escalates to error when ads are lost', parsed.reported && parsed.reported.level, 'error');
    checkTrue('A6 title names the orphan count',
      /shutting down with 2 ad\(s\) in flight/.test(String(parsed.reported && parsed.reported.title)),
      String(parsed.reported && parsed.reported.title));

    // 2. THE PAYLOAD NAMES ADS, NOT JUST COUNTS
    checkTrue('A7 requeued ad IDS are in the payload',
      String(f['requeued ads'] || '').includes('ad-aaa') && String(f['requeued ads'] || '').includes('ad-bbb'),
      JSON.stringify(f));
    check('A8 requeued count present', f.requeued, 2);
    checkTrue('A9 CHARGED submits flagged as unrecoverable spend',
      /1 ad\(s\)/.test(String(f['charged in flight'])) && /unrecoverable/.test(String(f['charged in flight'])),
      JSON.stringify(f['charged in flight']));
    // `commit` is attached by crashReporter for EVERY kind, not here — see the
    // commit assertion in verifyCrashReporter.js. This harness stubs
    // crashReporter, so asserting it here would only test the stub.
    checkTrue('A10 processAlerts does not duplicate commit (crashReporter owns it)',
      f.commit === undefined, JSON.stringify(f.commit));
    checkTrue('A11 uptime is in the payload', typeof f.uptime === 'string' && /s$/.test(f.uptime), JSON.stringify(f.uptime));
    checkTrue('A12 likely cause states BOTH deploy and autoscale, guessing neither',
      /deploy/.test(String(f['likely cause'])) && /autoscale/.test(String(f['likely cause'])),
      JSON.stringify(f['likely cause']));
    check('A13 signal recorded', parsed.reported && parsed.reported.signal, 'SIGTERM');
    checkTrue('A14 per-ad stage lines reach the diagnostic',
      /ad-bbb stage=veo submit/.test(String(parsed.reported && parsed.reported.diagnostic)),
      String(parsed.reported && parsed.reported.diagnostic));
    checkTrue('A15 SUBMITTED/charged marker reaches the diagnostic',
      /SUBMITTED\/charged/.test(String(parsed.reported && parsed.reported.diagnostic)));
    checkTrue('A16 run lines still present (backwards compatible)',
      /run-zzz 0\/2 veo/.test(String(parsed.reported && parsed.reported.diagnostic)));
    checkTrue('A17 inFlight snapshot ad ids passed for persistence',
      Array.isArray(parsed.inFlightAdIds || (parsed.reported && parsed.reported.inFlightAdIds)) &&
      (parsed.reported.inFlightAdIds || []).includes('ad-bbb'),
      JSON.stringify(parsed.reported && parsed.reported.inFlightAdIds));
  }
  // 3. EXIT SEMANTICS — died by the signal, or by the conventional 128+15.
  checkTrue('A18 process really terminated (SIGTERM or 143)',
    signal === 'SIGTERM' || status === 143, `status=${status} signal=${signal}`);
}

// ══ B. clean shutdown stays INFO (every deploy is a clean shutdown) ══════════
{
  const { parsed, status, signal } = run({ id: 2, kind: 'sigterm', clean: true });
  if (parsed && parsed.reported) {
    check('B1 clean shutdown reports at info, NOT error', parsed.reported.level, 'info');
    checkTrue('B2 clean shutdown title says so',
      /shutting down cleanly/.test(String(parsed.reported.title)), parsed.reported.title);
    checkTrue('B3 clean shutdown skips the orphan persist entirely',
      !parsed.events.includes('ad.find') && !parsed.events.includes('ad.updateMany'),
      parsed.events.join(','));
    const f = parsed.reported.fields || {};
    check('B4 in flight reported as nothing', f['in flight'], 'nothing');
  } else {
    failures.push('B0 clean-shutdown child produced no result');
  }
  checkTrue('B5 clean shutdown still terminates',
    signal === 'SIGTERM' || status === 143, `status=${status} signal=${signal}`);
}

// ══ C. uncaughtException → fatal, exit 1 ════════════════════════════════════
{
  const { parsed, status } = run({ id: 3, kind: 'uncaught' });
  if (parsed && parsed.reported) {
    check('C1 kind is uncaughtException', parsed.reported.kind, 'uncaughtException');
    check('C2 level is fatal', parsed.reported.level, 'fatal');
    checkTrue('C3 the thrown error reaches the report',
      /synthetic boom/.test(String(parsed.reported.errMessage)), parsed.reported.errMessage);
    checkTrue('C4 stack reaches the diagnostic',
      /synthetic boom/.test(String(parsed.reported.diagnostic)));
    checkTrue('C5 crash payload also names the ads',
      /ad-bbb/.test(String(parsed.reported.diagnostic)));
    const iRep = parsed.events.indexOf('report');
    const iUpd = parsed.events.indexOf('ad.updateMany');
    checkTrue('C6 ORDERING holds on the crash path too', iUpd >= 0 && iRep > iUpd, parsed.events.join(','));
  } else {
    failures.push('C0 uncaughtException child produced no result');
  }
  check('C7 uncaughtException exits 1 (Node default preserved)', status, 1);
}

// ══ D. a rejecting crashReporter must not stop termination ══════════════════
{
  const { parsed, status } = run({ id: 4, kind: 'uncaught', reportRejects: true });
  checkTrue('D1 handler survives a rejecting crashReporter', parsed !== null);
  check('D2 still exits 1 (exit lives in a finally)', status, 1);
  if (parsed) {
    checkTrue('D3 did not fall through to the 6s watchdog', parsed.timedOut !== true, JSON.stringify(parsed.events));
  }
}

// ══ E. mongo down — persist skipped, report still happens, still exits ══════
{
  const { parsed, status, signal } = run({ id: 5, kind: 'sigterm', mongoDown: true });
  if (parsed) {
    checkTrue('E1 no DB writes attempted when mongoose is down',
      !parsed.events.includes('ad.updateMany') && !parsed.events.includes('run.updateMany'),
      parsed.events.join(','));
    checkTrue('E2 the report still goes out', parsed.events.includes('report'), parsed.events.join(','));
    checkTrue('E3 payload still names the in-flight ads',
      /ad-bbb/.test(String(parsed.reported && parsed.reported.diagnostic)));
  } else {
    failures.push('E0 mongo-down child produced no result');
  }
  checkTrue('E4 still terminates with mongo down',
    signal === 'SIGTERM' || status === 143, `status=${status} signal=${signal}`);
}

// ══ F. THE PUPPETEER CASE — a co-resident listener must not block the exit ══
// puppeteer registers its own SIGTERM handler on every launch and closes Chrome
// WITHOUT exiting. Re-raise alone therefore leaves the process alive until
// Render SIGKILLs it, stalling every deploy (reproduced: alive at 6s). The
// unstoppable 1s timer is what guarantees death, and 128+15=143 is the code.
{
  const { parsed, status, signal } = run({ id: 6, kind: 'sigterm', coResidentListener: true });
  checkTrue('F1 the co-resident listener did run (re-raise reached it)',
    parsed && parsed.events.includes('coResident'), parsed && parsed.events.join(','));
  checkTrue('F2 process STILL died despite a listener that never exits — the 1s timer',
    status === 143 || signal === 'SIGTERM', `status=${status} signal=${signal}`);
  if (parsed) {
    checkTrue('F3 did not hang to the 6s watchdog', parsed.timedOut !== true, JSON.stringify(parsed.events));
  }
}

console.log(`\nverifyProcessAlerts: ${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error('');
  process.exit(1);
}
console.log('  all checks passed\n');
