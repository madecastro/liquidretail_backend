#!/usr/bin/env node
'use strict';
//
// verifyRenderErrorTails — a remotion child failure must keep its
// stderr/stdout tails on Ad.renderError.
//
// WHY THIS EXISTS. remotionChildSupervisor.makeChildError attaches
// stderrTail (last 40 lines) / stdoutTail (last 10) onto the thrown
// Error. Tonight's production failures (run_1787579089058_b7efb329)
// persisted only `remotion child exited code=1 signal=none` because:
//   1. Ad.renderError is a strict mongoose subdocument and those two
//      fields were not declared — silent drop on every save, same trap
//      as renderError.predictionId.
//   2. renderer.js processAd's persist copied message/stage/code and
//      never copied the tails off the Error.
// Either hole alone makes a live titling failure undiagnosable. The
// parent log line did not carry the tail either.
//
// BEHAVIOURAL. Mongoose strips undeclared paths at SET time (the same
// moment save() would lose them). We construct a real Ad doc, assign a
// renderError carrying both tails, and assert they survive toObject /
// JSON. We also drive makeChildError (the real supervisor helper) and
// assert the persist object that renderer.js $sets still has the tails
// after schema set. No network, no DB, no Chrome.
//
// Revert-prove:
//   remove renderError.stderrTail from src/models/Ad.js      → A2/A3 red
//   clone the schema without the two paths (in-process)      → A4 still
//     proves the drop, so A2 is not a tautology
//   processAd persist no longer spreads childTailsFrom       → C1 red
//   clipTail no longer truncates                             → B2 red

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

function loadMongoose() {
  try {
    return require('mongoose');
  } catch (err) {
    if (!err || err.code !== 'MODULE_NOT_FOUND') throw err;
  }
  const { resolveBackendRoot } = require('./lib/siblingBackend');
  const backend = resolveBackendRoot(ROOT);
  const candidate = backend ? path.join(backend, 'node_modules') : null;
  if (!candidate || !fs.existsSync(candidate)) {
    console.error('verifyRenderErrorTails: cannot load mongoose (MODULE_NOT_FOUND). Run npm install in this worktree.');
    process.exit(1);
  }
  const Module = require('module');
  const orig = Module._load;
  Module._load = function fallbackLoad(request, parent, isMain) {
    try {
      return orig.apply(this, arguments);
    } catch (e) {
      if (e && e.code === 'MODULE_NOT_FOUND' && !request.startsWith('.') && !path.isAbsolute(request)) {
        try {
          const resolved = require.resolve(request, { paths: [candidate] });
          return orig.call(this, resolved, parent, isMain);
        } catch (e2) { /* fall through */ }
      }
      throw e;
    }
  };
  return require('mongoose');
}

const mongoose = loadMongoose();
const Ad = require(path.join(ROOT, 'src', 'models', 'Ad.js'));
const {
  childTailsFrom,
  clipTail,
  STDERR_TAIL_MAX_CHARS,
  STDOUT_TAIL_MAX_CHARS
} = require(path.join(ROOT, 'src', 'services', 'renderErrorFields.js'));
const { makeChildError } = require(path.join(ROOT, 'src', 'services', 'remotionChildSupervisor.js'));

let pass = 0;
const failures = [];
function check(label, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}\n     ${err.message}`);
    console.log(`  ✗ ${label}`);
  }
}

const STDERR_BODY = [
  'Error: Cannot find composition CanonicalVertical',
  '    at renderMedia (/app/src/services/remotionRenderService.js:1:1)',
  '    at processTicksAndRejections (node:internal/process/task_queues:95:5)'
].join('\n');
const STDOUT_BODY = '{"ok":false,"error":{"message":"Cannot find composition CanonicalVertical"}}';

function persistedTails(doc) {
  const obj = JSON.parse(JSON.stringify(doc.toObject()));
  return {
    stderrTail: obj.renderError && obj.renderError.stderrTail,
    stdoutTail: obj.renderError && obj.renderError.stdoutTail
  };
}

console.log('\nverifyRenderErrorTails\n');

console.log('A. Ad.renderError round-trip keeps the child tails');
check('A1 schema declares stderrTail and stdoutTail', () => {
  assert.ok(Ad.schema.path('renderError.stderrTail'), 'stderrTail undeclared — mongoose will drop it');
  assert.ok(Ad.schema.path('renderError.stdoutTail'), 'stdoutTail undeclared — mongoose will drop it');
});
check('A2 assigning the tails onto a real Ad doc keeps them', () => {
  const ad = new Ad({
    renderError: {
      message: 'remotion child exited code=1 signal=none',
      stage: 'render',
      at: new Date(),
      code: '1',
      stderrTail: STDERR_BODY,
      stdoutTail: STDOUT_BODY
    }
  });
  assert.strictEqual(ad.renderError.stderrTail, STDERR_BODY);
  assert.strictEqual(ad.renderError.stdoutTail, STDOUT_BODY);
});
check('A3 toObject/JSON round-trip (what save() would persist) keeps them', () => {
  const ad = new Ad({
    renderError: {
      message: 'remotion child exited code=1 signal=none',
      stage: 'render',
      at: new Date(),
      code: '1',
      stderrTail: STDERR_BODY,
      stdoutTail: STDOUT_BODY
    }
  });
  const got = persistedTails(ad);
  assert.strictEqual(got.stderrTail, STDERR_BODY);
  assert.strictEqual(got.stdoutTail, STDOUT_BODY);
});
check('A4 revert-proof: the identical assignment DROPS the tails when the paths are undeclared', () => {
  const stripped = new mongoose.Schema({
    renderError: {
      message: String,
      stage:   String,
      at:      Date,
      code:    String
    }
  }, { strict: true });
  const name = 'AdBareRenderErrorTails';
  const Bare = mongoose.models[name] || mongoose.model(name, stripped);
  const dropped = persistedTails(new Bare({
    renderError: {
      message: 'x',
      stderrTail: STDERR_BODY,
      stdoutTail: STDOUT_BODY
    }
  }));
  assert.strictEqual(dropped.stderrTail, undefined, 'undeclared stderrTail must vanish — otherwise A2 is not testing the trap');
  assert.strictEqual(dropped.stdoutTail, undefined, 'undeclared stdoutTail must vanish');
});

console.log('\nB. persist-side clip keeps the TAIL and bounds document size');
check('B1 clip constants are 8 KiB stderr / 2 KiB stdout', () => {
  assert.strictEqual(STDERR_TAIL_MAX_CHARS, 8 * 1024);
  assert.strictEqual(STDOUT_TAIL_MAX_CHARS, 2 * 1024);
});
check('B2 stderr clip keeps the START (child writes err.stack throw-first)', () => {
  const long = 'Error: Cannot find composition' + 'x'.repeat(STDERR_TAIL_MAX_CHARS) + 'DEEP_FRAME';
  const clipped = clipTail(long, STDERR_TAIL_MAX_CHARS, 'start');
  assert.ok(clipped.length <= STDERR_TAIL_MAX_CHARS);
  assert.ok(clipped.startsWith('Error: Cannot find composition'), 'must keep the throw — remotionRender.child writes err.stack first');
  assert.ok(!clipped.includes('DEEP_FRAME'));
  assert.ok(clipped.endsWith('...'));
});
check('B2b stdout clip keeps the END (JSON report is the last line)', () => {
  const long = '::progress' + 'y'.repeat(STDOUT_TAIL_MAX_CHARS) + '{"ok":false}';
  const clipped = clipTail(long, STDOUT_TAIL_MAX_CHARS, 'end');
  assert.ok(clipped.length <= STDOUT_TAIL_MAX_CHARS);
  assert.ok(clipped.endsWith('{"ok":false}'));
  assert.ok(!clipped.includes('::progress'));
});
check('B2c NULs are stripped so a dirty child byte cannot veto the failed stamp', () => {
  const clipped = clipTail('Error:\u0000 boom', 100, 'start');
  assert.strictEqual(clipped, 'Error: boom');
  assert.ok(!clipped.includes('\u0000'));
});

console.log('\nC. supervisor error → persist object → schema set (the production path)');
check('C1 makeChildError attaches both tails', () => {
  const err = makeChildError({
    kind: 'exit',
    message: 'remotion child exited code=1 signal=none',
    code: 1,
    signal: null,
    stderr: STDERR_BODY,
    stdout: STDOUT_BODY
  });
  assert.strictEqual(err.stderrTail, STDERR_BODY);
  assert.strictEqual(err.stdoutTail, STDOUT_BODY);
});
check('C2 renderer persist shape + schema set keeps the tails (this is what processAd $sets)', () => {
  const err = makeChildError({
    kind: 'exit',
    message: 'remotion child exited code=1 signal=none',
    code: 1,
    signal: null,
    stderr: STDERR_BODY,
    stdout: STDOUT_BODY
  });
  // Mirror renderer.js processAd catch — the live $set payload.
  const landed = {
    message: String(err.message || err).slice(0, 400),
    stage: 'render',
    at: new Date(),
    code: err.code || null,
    ...childTailsFrom(err)
  };
  assert.ok(landed.stderrTail, 'childTailsFrom dropped stderrTail before the schema even saw it');
  assert.ok(landed.stdoutTail, 'childTailsFrom dropped stdoutTail before the schema even saw it');
  const ad = new Ad({ renderError: landed });
  const got = persistedTails(ad);
  assert.strictEqual(got.stderrTail, STDERR_BODY);
  assert.strictEqual(got.stdoutTail, STDOUT_BODY);
});
check('C3 childTailsFrom reads tails off err.cause (wrapper-safe)', () => {
  const inner = makeChildError({
    kind: 'exit',
    message: 'remotion child exited code=1 signal=none',
    code: 1,
    signal: null,
    stderr: STDERR_BODY,
    stdout: STDOUT_BODY
  });
  const wrapped = new Error(`wrapped: ${inner.message}`, { cause: inner });
  const got = childTailsFrom(wrapped);
  assert.strictEqual(got.stderrTail, STDERR_BODY);
  assert.strictEqual(got.stdoutTail, STDOUT_BODY);
});

console.log('\nD. write sites actually call childTailsFrom (a helper that is never used is the original bug)');
function srcOf(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}

check('D1 renderer.js processAd persist spreads childTailsFrom(err)', () => {
  const src = stripComments(srcOf('src/services/renderer.js'));
  assert.match(src, /stage:\s*'render'[\s\S]{0,250}childTailsFrom\(err\)/);
});
check('D2 titlingResumeService terminal persist spreads childTailsFrom(err)', () => {
  const src = stripComments(srcOf('src/services/titlingResumeService.js'));
  assert.match(src, /childTailsFrom\(err\)/);
});
check('D3 brandScriptExecutor titling-failure stamp spreads childTailsFrom(err)', () => {
  // WAS: a single OOM-only inline stamp with a literal code:'REMOTION_CHILD_OOM'
  // in the same object as the spread. The titling-recoverability fix
  // consolidated OOM/timeout/generic into one shared
  // stampTitlingFailureAndThrow, whose renderError object now carries a
  // COMPUTED `code` variable (REMOTION_CHILD_OOM is still one of its three
  // possible values) rather than the literal inline — so the check now pins
  // (a) the OOM code constant still exists, and (b) the renderError object
  // still spreads childTailsFrom(err) immediately after `code,` — true for
  // BOTH the terminal and resumable stamps.
  const src = stripComments(srcOf('src/services/brandScriptExecutor.js'));
  assert.match(src, /'REMOTION_CHILD_OOM'/);
  assert.match(src, /stampTitlingFailureAndThrow/);
  const spreads = src.match(/code,\s*\.\.\.renderErrorFields\.childTailsFrom\(err\)/g) || [];
  assert.ok(spreads.length >= 2, `expected childTailsFrom(err) spread on both the terminal and resumable stamps, found ${spreads.length}`);
});
check('D4 noteRenderIssue forwards tails from the thrown err', () => {
  const src = stripComments(srcOf('src/services/adStage.js'));
  assert.match(src, /childTailsFrom\(err\)/);
});
check('D5 serialized-error close path copies stdoutTail AFTER deserializeError (not just makeChildError)', () => {
  const src = stripComments(srcOf('src/services/remotionChildSupervisor.js'));
  const close = /if \(report && report\.ok === false && report\.error\) \{[\s\S]{0,500}?return finish\(reject, err\);/.exec(src);
  assert.ok(close, 'deserialize close path not found');
  assert.match(close[0], /if \(stderr\) err\.stderrTail/);
  assert.match(close[0], /if \(stdout\) err\.stdoutTail/);
});
check('D6 processAd logs stderrTail so the parent log is not mute either', () => {
  const src = stripComments(srcOf('src/services/renderer.js'));
  assert.match(src, /child stderrTail/);
});
check('D7 video Slack notify puts stderr in detail (not a 200-char fields head-slice)', () => {
  const src = stripComments(srcOf('src/services/renderer.js'));
  assert.match(src, /title:\s*'Video generation failed'[\s\S]{0,250}detail:\s*stderrDetail/);
});

if (failures.length) {
  console.log(`\n❌ verifyRenderErrorTails: ${pass}/${pass + failures.length} checks passed\n`);
  for (const f of failures) console.log('  ' + f);
  process.exit(1);
}
console.log(`\n✅ verifyRenderErrorTails: ${pass}/${pass} checks passed\n`);
process.exit(0);
