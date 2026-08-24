#!/usr/bin/env node
'use strict';
//
// verifyVideoQcVerdictSurvives (backend) — mirror of the adgen harness of the
// same name. A vision-QC 'failed' verdict must survive every terminal write
// in THIS repo too: routes/ads.js (master + derive) and
// services/titlingResumeService.js (titled + no-brand arms).
//
// WHY THIS FILE EXISTS SEPARATELY FROM E3 (verifyTitlingOrphanResume.js).
// E3 counts `titlingResumeState: null` occurrences — that pins "every
// terminal outcome clears the debt", which is a DIFFERENT invariant from
// "every draft-promoting write is guarded against a stamped verdict". An
// adversarial pass proved the gap is real: reverting every $in guard back to
// a bare filter still leaves the same six `titlingResumeState: null` sites in
// the file (the keep-arms exist as dead code, never taken), so E3 stays green
// while 47/0 reproduces. This file pins the guard itself.
//
// Comments are stripped before scanning — the file's own header and inline
// reasoning quote nearly every string these checks search for.
//
// Pure + offline: fs/path/assert only, no node_modules required.
//   node scripts/verifyVideoQcVerdictSurvives.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const ADS_RAW = fs.readFileSync(path.join(ROOT, 'routes/ads.js'), 'utf8');
const TRS_RAW = fs.readFileSync(path.join(ROOT, 'services/titlingResumeService.js'), 'utf8');
const BSE_RAW = fs.readFileSync(path.join(ROOT, 'services/brandScriptExecutor.js'), 'utf8');

function stripComments(src) {
  let out = ''; let i = 0;
  let inS = null, inBlock = false, inLine = false, inRe = false;
  let prevSig = '';
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (inLine)       { if (c === '\n') { inLine = false; out += c; } i++; continue; }
    if (inBlock)      { if (c === '*' && d === '/') { inBlock = false; i += 2; } else i++; continue; }
    if (inS)          { out += c; if (c === '\\') { out += src[i + 1] || ''; i += 2; continue; }
                        if (c === inS) inS = null; i++; continue; }
    if (inRe)         { out += c; if (c === '\\') { out += src[i + 1] || ''; i += 2; continue; }
                        if (c === '/') inRe = false; i++; continue; }
    if (c === '/' && d === '/') { inLine = true; i += 2; continue; }
    if (c === '/' && d === '*') { inBlock = true; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') { inS = c; out += c; i++; continue; }
    if (c === '/' && /[=(,:[!&|?{};+\-*%^~<>]/.test(prevSig)) { inRe = true; out += c; i++; continue; }
    out += c;
    if (!/\s/.test(c)) prevSig = c;
    i++;
  }
  return out;
}

const ADS_SRC = stripComments(ADS_RAW);
const TRS_SRC = stripComments(TRS_RAW);
const BSE_SRC = stripComments(BSE_RAW);

let failures = 0, passes = 0;
function check(name, fn) {
  try { fn(); passes++; console.log(`  ✓ ${name}`); }
  catch (err) { failures++; console.log(`  ✗ ${name}\n     ${err.message}`); }
}

/** Every Ad.updateOne/findOneAndUpdate call in `src`, as {filter, update}. */
function scanWrites(src) {
  const out = [];
  const CALL = /Ad\.(updateOne|findOneAndUpdate)\s*\(/g;
  let m;
  while ((m = CALL.exec(src))) {
    const openParen = src.indexOf('(', m.index + m[0].length - 1);
    const args = balanced(src, openParen, '(', ')');
    if (!args) continue;
    const firstBrace = args.indexOf('{');
    const filter = balanced(args, firstBrace, '{', '}') || '';
    const afterFilter = firstBrace + filter.length;
    const updBrace = args.indexOf('{', afterFilter);
    const update = balanced(args, updBrace, '{', '}') || '';
    out.push({ filter, update });
    CALL.lastIndex = m.index + args.length;
  }
  return out;
}

/** The subset of writes that promote status to 'draft' AND clear the titling
 *  debt in the same update — the signature of a TERMINAL video-titling write,
 *  as opposed to the pre-titling money stamp (routes/ads.js:2547/2966), which
 *  legitimately runs before any QC verdict exists and must stay unguarded. */
function terminalDraftWrites(src) {
  return scanWrites(src).filter((w) =>
    /status:\s*['"]draft['"]/.test(w.update) &&
    /titlingResumeState:\s*null/.test(w.update));
}

function assertGuarded(writes, label) {
  check(`${label}: found the expected 2 terminal draft-promoting writes`, () => {
    assert.strictEqual(writes.length, 2,
      `expected exactly 2 (titled-success + no-brand-success), found ${writes.length}`);
  });
  check(`${label}: every one is guarded with a status $in allowlist`, () => {
    const unguarded = writes.filter((w) => !/status:\s*\{[^}]*\$in[^}]*\}/.test(w.filter));
    assert.strictEqual(unguarded.length, 0,
      `${unguarded.length} unguarded — will overwrite a vision-QC 'failed' verdict: ` +
      unguarded.map((w) => w.filter.replace(/\s+/g, ' ')).join(' | '));
  });
  check(`${label}: no $nin denylist, no duplicate status key`, () => {
    for (const w of writes) {
      assert.ok(!/\$nin/.test(w.filter), 'a $nin denylist fails open — use $in');
      const occurrences = (w.filter.match(/(?<![\w$])status\s*:/g) || []).length;
      assert.strictEqual(occurrences, 1, `status declared ${occurrences} times in one filter`);
    }
  });
  check(`${label}: the allowlist is exactly rendering+draft`, () => {
    for (const w of writes) {
      const g = /status:\s*\{\s*\$in:\s*\[([^\]]*)\]/.exec(w.filter);
      assert.ok(g, 'no $in allowlist found');
      const allowed = (g[1].match(/'([a-z]+)'/g) || []).sort();
      assert.deepStrictEqual(allowed, ["'draft'", "'rendering'"], `got ${g[1].trim()}`);
    }
  });
}

console.log('\n── routes/ads.js (master + derive terminal writes) ──');
assertGuarded(terminalDraftWrites(ADS_SRC), 'ads.js');

console.log('\n── services/titlingResumeService.js (titled + no-brand arms) ──');
assertGuarded(terminalDraftWrites(TRS_SRC), 'titlingResumeService.js');

console.log('\n── the upstream QC-verdict writer cannot be silently defeated ──');

function balanced(text, openIdx, open, close) {
  if (openIdx < 0 || text[openIdx] !== open) return null;
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) { depth--; if (depth === 0) return text.slice(openIdx, i + 1); }
  }
  return null;
}
function bseFnBody(name) {
  const m = new RegExp(`async function ${name}\\s*\\(`).exec(BSE_SRC);
  if (!m) return null;
  return balanced(BSE_SRC, BSE_SRC.indexOf('{', BSE_SRC.indexOf(')', m.index)), '{', '}');
}
const uploadBody = bseFnBody('uploadRenderAndStamp');

check('uploadRenderAndStamp() is present and its body extracts', () => {
  assert.ok(uploadBody && uploadBody.length > 200, 'not found — re-derive against brandScriptExecutor.js');
});

check('[THE REAL MECHANISM] the QC-failure merge runs AFTER the draft literal, in the SAME object', () => {
  const draftIdx = uploadBody.search(/status:\s*['"]draft['"]/);
  const assignIdx = uploadBody.indexOf('Object.assign(set, buildVideoQcFailureFields(');
  assert.ok(draftIdx >= 0, "no status:'draft' literal found");
  assert.ok(assignIdx >= 0, 'buildVideoQcFailureFields merge not found');
  assert.ok(assignIdx > draftIdx,
    "Object.assign must run AFTER 'status: draft' so its key overwrites it in the same object. " +
    'Reorder and a real QC failure ships as draft again with the guards above still green, ' +
    'because they only ever see the already-wrong verdict this function handed them.');
});

check('the merge target is the SAME object the draft literal was declared on', () => {
  const setDecl = /const\s+(\w+)\s*=\s*\{[^}]*status:\s*['"]draft['"]/.exec(uploadBody);
  assert.ok(setDecl, "could not find the object literal declaring status:'draft'");
  assert.ok(new RegExp(`Object\\.assign\\(${setDecl[1]}\\s*,`).test(uploadBody),
    `Object.assign must target the SAME variable (${setDecl[1]})`);
});

console.log('');
if (failures) {
  console.log(`❌ verifyVideoQcVerdictSurvives (backend): ${failures} FAILED, ${passes} passed`);
  process.exit(1);
}
console.log(`✅ verifyVideoQcVerdictSurvives (backend): all ${passes} checks passed`);
