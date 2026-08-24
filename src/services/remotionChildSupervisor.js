'use strict';
//
// Parent-side supervisor for a Remotion titling child.
//
// House pattern: brandScriptExecutor.runChild / brandScriptRunner.child.js.
// stdin = one JSON payload (paths and plain data, never buffers). stdout last
// non-empty line = JSON report. Lines starting with '::' are progress.
// The child is SIGKILL'd if it outlives the timeout.
//
// WHY THIS FILE IS SEPARATE FROM remotionRenderService.js: the verify harness
// has to drive the supervision logic against a stub child WITHOUT loading
// Remotion, Chrome, axios, or mongoose. This module's requires are Node
// builtins only.

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Parent-side kill budget. SAME constant remotionRenderService applies as
// timeoutInMilliseconds on selectComposition/renderMedia
// (`Number(process.env.REMOTION_TIMEOUT_MS || 180_000)`).
//
// WHY this and not brandScriptExecutor's CHILD_TIMEOUT_MS (5 min): this
// child IS a Remotion render. A hung child holding one of the
// REMOTION_QUEUE_CONCURRENCY slots (live: 2) for 5 minutes would stall
// the entire titling queue. The remotion-specific budget is the right
// one. The canvas-engine 5 min is a different workload (per-frame PNG
// loop), not a render-timeout constant.
//
// The parent timer is a BACKSTOP. If Remotion's own watchdog fires
// cleanly the child exits non-zero and we surface that as a render throw
// (kind:'render'), with the Error's message/stack restored from the JSON
// report. If Chrome/ffmpeg hang past that watchdog, we SIGKILL and
// surface kind:'timeout' — distinct from an OS OOM SIGKILL because we
// set timedOut BEFORE killing.
const RENDER_TIMEOUT_MS = Number(process.env.REMOTION_TIMEOUT_MS || 180_000);

const KEEP_ENV = [
  'PATH', 'NODE_PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP',
  'USER', 'LOGNAME',
  'REMOTION_CONCURRENCY', 'REMOTION_TIMEOUT_MS', 'REMOTION_BROWSER_EXECUTABLE',
  'TITLE_PLATE_SCAN', 'TITLE_FACE_KEEPOUT',
  'NODE_ENV',
  'FONTCONFIG_PATH', 'FONTCONFIG_FILE',
  'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
  'LANG', 'LC_ALL', 'TZ',
  'PUPPETEER_CACHE_DIR', 'PUPPETEER_EXECUTABLE_PATH'
];

function defaultChildEnv() {
  const env = { REMOTION_IN_CHILD: '1' };
  for (const k of KEEP_ENV) {
    if (process.env[k] != null) env[k] = process.env[k];
  }
  // Any other REMOTION_* / TITLE_* dashboard knobs (concurrency, browser
  // executable, plate-scan) must reach the child; they are not secrets.
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('REMOTION_') || k.startsWith('TITLE_')) env[k] = process.env[k];
  }
  env.REMOTION_IN_CHILD = '1';
  if (!env.HOME) env.HOME = os.tmpdir();
  if (!env.TMPDIR) env.TMPDIR = os.tmpdir();
  return env;
}

function assertNoBuffers(value, key) {
  // Walk BEFORE JSON.stringify. Buffer.prototype.toJSON runs first inside
  // stringify, so a replacer never sees Buffer.isBuffer(val) === true —
  // it sees { type:'Buffer', data:[...] }. Catch both shapes here.
  if (Buffer.isBuffer(value)) {
    throw new Error(`remotion child IPC forbids buffers (key=${key || '<root>'}); pass a path`);
  }
  if (!value || typeof value !== 'object') return;
  if (value.type === 'Buffer' && Array.isArray(value.data)) {
    throw new Error(`remotion child IPC forbids Buffer JSON (key=${key || '<root>'}); pass a path`);
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) assertNoBuffers(value[i], `${key || ''}[${i}]`);
    return;
  }
  for (const k of Object.keys(value)) assertNoBuffers(value[k], k);
}

function serializePayload(payload) {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('remotion child IPC payload must be a plain object (paths, not buffers)');
  }
  assertNoBuffers(payload, '');
  return JSON.stringify(payload);
}

function serializeError(err) {
  if (!err) return { name: 'Error', message: 'unknown error', stack: null, code: null };
  if (typeof err === 'string') return { name: 'Error', message: err, stack: null, code: null };
  return {
    name: err.name || 'Error',
    message: String(err.message || err),
    stack: err.stack ? String(err.stack) : null,
    code: err.code == null ? null : err.code
  };
}

function deserializeError(payload) {
  const src = payload && typeof payload === 'object' ? payload : { message: String(payload) };
  const err = new Error(src.message || 'remotion child render failed');
  err.name = src.name || 'Error';
  if (src.stack) err.stack = src.stack;
  if (src.code != null) err.code = src.code;
  err.kind = 'render';
  return err;
}

function parseReport(stdout) {
  const lines = String(stdout || '').split('\n').filter((l) => l.trim());
  if (!lines.length) return null;
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

// Classify a child's close(code, signal). timedOut MUST be checked first:
// the timeout path SIGKILLs the child, and that SIGKILL is ours, not the
// kernel OOM killer's. Mixing them up is how a hung render would look like
// a paid-master-preserving OOM and get silently retried forever.
function classifyChildExit({ code, signal, timedOut }) {
  if (timedOut) return 'timeout';
  if (signal === 'SIGKILL' || code === 137 || code === 9) return 'oom';
  if (code === 0) return 'ok';
  return 'exit';
}

function makeChildError({ kind, message, code, signal, stderr, stdout }) {
  const err = new Error(message);
  err.name = 'RemotionChildError';
  err.kind = kind;
  err.oomKilled = kind === 'oom';
  err.timedOut = kind === 'timeout';
  if (kind === 'oom') err.code = 'REMOTION_CHILD_OOM';
  else if (kind === 'timeout') err.code = 'REMOTION_CHILD_TIMEOUT';
  else err.code = code == null ? null : code;
  err.childCode = code;
  err.childSignal = signal || null;
  if (stderr) err.stderrTail = String(stderr).split('\n').slice(-40).join('\n');
  if (stdout) err.stdoutTail = String(stdout).split('\n').slice(-10).join('\n');
  return err;
}

function isRemotionChildOomError(err) {
  return Boolean(
    err && (err.oomKilled === true || err.kind === 'oom' || err.code === 'REMOTION_CHILD_OOM')
  );
}

function isRemotionChildTimeoutError(err) {
  return Boolean(
    err && (err.timedOut === true || err.kind === 'timeout' || err.code === 'REMOTION_CHILD_TIMEOUT')
  );
}

function killChildTree(proc) {
  // Remotion's node child spawns Chrome + ffmpeg. SIGKILL on the node pid
  // alone orphans those descendants (they reparent to init and keep RSS).
  // detached:true below makes the node child a process-group leader, so
  // kill(-pid) takes the whole tree. Fall back to proc.kill for the
  // already-exited / non-group case.
  const pid = proc && proc.pid;
  if (pid) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* group gone or not a leader */ }
  }
  try { proc.kill('SIGKILL'); } catch { /* already exited */ }
}

function superviseRemotionChild({
  runnerPath,
  payload,
  timeoutMs,
  env,
  cwd,
  spawnFn = spawn,
  execPath = process.execPath
} = {}) {
  if (!runnerPath) throw new Error('superviseRemotionChild: runnerPath required');
  const budget = Number(timeoutMs);
  if (!Number.isFinite(budget) || budget <= 0) {
    throw new Error('superviseRemotionChild: timeoutMs must be a positive number (pass RENDER_TIMEOUT_MS)');
  }
  const body = serializePayload(payload);

  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    const proc = spawnFn(execPath, [runnerPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: env || defaultChildEnv(),
      cwd: cwd || REPO_ROOT,
      detached: true
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      timedOut = true;
      killChildTree(proc);
    }, budget);

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };

    proc.stdout.on('data', (d) => {
      const chunk = d.toString();
      stdout += chunk;
      for (const line of chunk.split('\n')) {
        if (line.startsWith('::')) console.log(`   ${line}`);
      }
    });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => finish(reject, err));
    proc.stdin.on('error', () => { /* child may have already exited; close classifies */ });

    proc.on('close', (code, signal) => {
      const kind = classifyChildExit({ code, signal, timedOut });
      if (kind === 'timeout') {
        return finish(reject, makeChildError({
          kind: 'timeout',
          message: `remotion child exceeded ${budget}ms timeout (REMOTION_TIMEOUT_MS=${RENDER_TIMEOUT_MS})`,
          code,
          signal,
          stderr,
          stdout
        }));
      }
      if (kind === 'oom') {
        return finish(reject, makeChildError({
          kind: 'oom',
          message: `remotion child OOM-killed (signal=${signal || 'none'} code=${code})`,
          code,
          signal,
          stderr,
          stdout
        }));
      }

      const report = parseReport(stdout);
      if (kind === 'ok') {
        if (!report || report.ok !== true) {
          return finish(reject, makeChildError({
            kind: 'exit',
            message: `remotion child exited 0 but produced no ok report`,
            code,
            signal,
            stderr,
            stdout
          }));
        }
        if (typeof report.finalPath !== 'string' || typeof report.tempDir !== 'string') {
          return finish(reject, makeChildError({
            kind: 'exit',
            message: 'remotion child report missing finalPath/tempDir strings (IPC is paths, not buffers)',
            code,
            signal,
            stderr,
            stdout
          }));
        }
        return finish(resolve, {
          finalPath: report.finalPath,
          tempDir: report.tempDir,
          timings: report.timings || {}
        });
      }

      // Non-zero exit: prefer the child's serialized Error so the stack
      // survives JSON (structured clone / JSON.stringify(Error) does not).
      if (report && report.ok === false && report.error) {
        const err = deserializeError(report.error);
        err.childCode = code;
        err.childSignal = signal || null;
        if (stderr) err.stderrTail = String(stderr).split('\n').slice(-40).join('\n');
        return finish(reject, err);
      }
      return finish(reject, makeChildError({
        kind: 'exit',
        message: `remotion child exited code=${code} signal=${signal || 'none'}`,
        code,
        signal,
        stderr,
        stdout
      }));
    });

    try {
      proc.stdin.write(body + '\n');
      proc.stdin.end();
    } catch {
      // close will fire
    }
  });
}

module.exports = {
  RENDER_TIMEOUT_MS,
  superviseRemotionChild,
  classifyChildExit,
  serializePayload,
  serializeError,
  deserializeError,
  parseReport,
  defaultChildEnv,
  isRemotionChildOomError,
  isRemotionChildTimeoutError,
  makeChildError
};
