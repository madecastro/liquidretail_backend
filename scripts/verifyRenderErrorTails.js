#!/usr/bin/env node
'use strict';
//
// verifyRenderErrorTails — a remotion/brand-script child failure must keep
// its stderr/stdout tails on Ad.renderError.
//
// WHY THIS EXISTS. The supervisor (adgen remotionChildSupervisor, and the
// canvas brand-script child here) captures the child's stderr into
// err.stderrTail. Tonight's production failures persisted only
// `remotion child exited code=1 signal=none` because:
//   1. Ad.renderError is a strict mongoose subdocument and stderrTail /
//      stdoutTail were not declared — silent drop on every save, same trap
//      as renderError.predictionId (see verifyRenderFailureRecord).
//   2. The persist sites that build renderError copied message/stage/code
//      and never copied the tails off the Error.
// Either hole alone makes a live titling failure undiagnosable.
//
// BEHAVIOURAL. Mongoose strips undeclared paths at SET time (the same
// moment save() would lose them). We construct a real Ad doc, assign a
// renderError carrying both tails, and assert they survive toObject /
// JSON — the round-trip that would have caught this. No network, no DB.
//
// Revert-prove:
//   remove renderError.stderrTail from models/Ad.js          → A2/A3 red
//   clone the schema without the two paths (in-process)      → A4 still
//     proves the drop, so A2 is not a tautology
//   childTailsFrom not spread at the persist site            → C pins red
//   clipTail no longer truncates                             → B2 red

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const mongoose = require('mongoose');

const ROOT = path.join(__dirname, '..');
const Ad = require(path.join(ROOT, 'models', 'Ad.js'));
const {
  childTailsFrom,
  clipTail,
  STDERR_TAIL_MAX_CHARS,
  STDOUT_TAIL_MAX_CHARS
} = require(path.join(ROOT, 'services', 'renderErrorFields.js'));

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

const TAIL_PAYLOAD = {
  message:    'remotion child exited code=1 signal=none',
  stage:      'render',
  at:         new Date('2026-08-24T00:00:00Z'),
  code:       '1',
  stderrTail: 'Error: Cannot find composition CanonicalVertical\n    at renderMedia',
  stdoutTail: '{"ok":false,"error":{"message":"Cannot find composition"}}'
};

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
  const ad = new Ad({ renderError: TAIL_PAYLOAD });
  assert.strictEqual(ad.renderError.stderrTail, TAIL_PAYLOAD.stderrTail);
  assert.strictEqual(ad.renderError.stdoutTail, TAIL_PAYLOAD.stdoutTail);
});
check('A3 toObject/JSON round-trip (what save() would persist) keeps them', () => {
  const ad = new Ad({ renderError: TAIL_PAYLOAD });
  const got = persistedTails(ad);
  assert.strictEqual(got.stderrTail, TAIL_PAYLOAD.stderrTail);
  assert.strictEqual(got.stdoutTail, TAIL_PAYLOAD.stdoutTail);
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
  const dropped = persistedTails(new Bare({ renderError: TAIL_PAYLOAD }));
  assert.strictEqual(dropped.stderrTail, undefined, 'undeclared stderrTail must vanish — otherwise A2 is not testing the trap');
  assert.strictEqual(dropped.stdoutTail, undefined, 'undeclared stdoutTail must vanish');
});
check('A5 a renderError without tails still constructs (defaults null, not a required field)', () => {
  const ad = new Ad({ renderError: { message: 'x', stage: 'render', at: new Date() } });
  assert.strictEqual(ad.renderError.stderrTail, null);
  assert.strictEqual(ad.renderError.stdoutTail, null);
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
  assert.ok(!clipped.includes('DEEP_FRAME'), 'deep frames are what we discard on an over-budget stack');
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
check('B3 childTailsFrom copies both tails off a supervisor-shaped Error', () => {
  const err = Object.assign(new Error('remotion child exited code=1 signal=none'), {
    code: 1,
    stderrTail: TAIL_PAYLOAD.stderrTail,
    stdoutTail: TAIL_PAYLOAD.stdoutTail
  });
  const got = childTailsFrom(err);
  assert.strictEqual(got.stderrTail, TAIL_PAYLOAD.stderrTail);
  assert.strictEqual(got.stdoutTail, TAIL_PAYLOAD.stdoutTail);
});
check('B4 childTailsFrom reads tails off err.cause (wrapper-safe)', () => {
  const inner = Object.assign(new Error('inner'), { stderrTail: 'INNER_ERR', stdoutTail: 'INNER_OUT' });
  const wrapped = new Error(`wrapped: ${inner.message}`, { cause: inner });
  const got = childTailsFrom(wrapped);
  assert.strictEqual(got.stderrTail, 'INNER_ERR');
  assert.strictEqual(got.stdoutTail, 'INNER_OUT');
});
check('B5 childTailsFrom on a bare Error is {} (spread is a no-op)', () => {
  const got = childTailsFrom(new Error('plain'));
  assert.deepStrictEqual(got, {});
});
check('B6 childTailsFrom clips stderr from the start and stdout from the end', () => {
  const err = Object.assign(new Error('exit'), {
    stderrTail: 'Error: boom' + 'y'.repeat(STDERR_TAIL_MAX_CHARS) + 'DEEP',
    stdoutTail: 'HEAD' + 'z'.repeat(STDOUT_TAIL_MAX_CHARS) + '{"ok":false}'
  });
  const got = childTailsFrom(err);
  assert.ok(got.stderrTail.length <= STDERR_TAIL_MAX_CHARS);
  assert.ok(got.stdoutTail.length <= STDOUT_TAIL_MAX_CHARS);
  assert.ok(got.stderrTail.startsWith('Error: boom'));
  assert.ok(got.stdoutTail.endsWith('{"ok":false}'));
});

console.log('\nC. write sites forward the tails onto the object that is $set');
function srcOf(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}

// C1 (services/titlingResumeService.js) and C2 (routes/ads.js's
// childTailsFrom(titlingFailed) master/derive titling persists) REMOVED
// 2026-08-28 — backend titling removal (owner directive: "remove and
// disable the backend titling function"). titlingResumeService.js is
// deleted; routes/ads.js no longer has a titlingFailed terminal outcome to
// persist a renderError for (there is no more in-process titling to fail).
check('C3 routes/ads.js crash and veo persists spread childTailsFrom(err)', () => {
  const src = stripComments(srcOf('routes/ads.js'));
  assert.match(src, /stage:\s*'veo'[\s\S]{0,200}childTailsFrom\(err\)/);
  assert.match(src, /stage:\s*'crash'[\s\S]{0,400}childTailsFrom\(err\)/);
});
check('C4 noteRenderIssue forwards tails from the thrown err', () => {
  const src = stripComments(srcOf('services/adStage.js'));
  assert.match(src, /childTailsFrom\(err\)/);
});
check('C5 end-to-end: supervisor-shaped err → persist object still has the tails after schema set', () => {
  const err = Object.assign(new Error('remotion child exited code=1 signal=none'), {
    code: 1,
    stderrTail: TAIL_PAYLOAD.stderrTail,
    stdoutTail: TAIL_PAYLOAD.stdoutTail
  });
  const landed = {
    message: String(err.message).slice(0, 400),
    stage: 'render',
    at: new Date(),
    code: err.code || null,
    ...childTailsFrom(err)
  };
  const ad = new Ad({ renderError: landed });
  const got = persistedTails(ad);
  assert.strictEqual(got.stderrTail, TAIL_PAYLOAD.stderrTail);
  assert.strictEqual(got.stdoutTail, TAIL_PAYLOAD.stdoutTail);
});

if (failures.length) {
  console.log(`\n❌ verifyRenderErrorTails: ${pass}/${pass + failures.length} checks passed\n`);
  for (const f of failures) console.log('  ' + f);
  process.exit(1);
}
console.log(`\n✅ verifyRenderErrorTails: ${pass}/${pass} checks passed\n`);
process.exit(0);
