#!/usr/bin/env node
'use strict';
//
// verifyVideoQcVerdictSurvives (backend) — mirror of the adgen harness of the
// same name. A vision-QC 'failed' verdict must survive every terminal write
// in THIS repo too: routes/ads.js (master + derive).
//
// Used to also pin services/titlingResumeService.js (titled + no-brand
// arms) — that file is DELETED 2026-08-28 (backend titling removal, owner
// directive: "remove and disable the backend titling function"). Nothing
// in this repo runs Remotion titling in-process any more, so there is no
// second writer left to guard.
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
// SECTION E — uploadRenderAndStamp's OWN internal merge-order correctness —
// used to be a second source-text scan (regex over the function body,
// hardened across three rounds against decoys/resurrection). RETIRED
// 2026-08-24 after an adversarial (Grok xhigh) pass found it still went
// green on six real shapes that clobber the verdict just the same:
// findByIdAndUpdate, Ad.collection.updateOne (bypasses Mongoose), a $set
// built as a variable, a computed key, a backtick-quoted status, and an
// assignment sitting after the merge in a spot the scan didn't cover. Each
// round closed the shapes we'd thought of and left the ones we hadn't — an
// unbounded game against JS/Mongoose syntax. Replaced with a BEHAVIOURAL
// test: it calls the real uploadRenderAndStamp (Cloudinary/vision-QC/Ad
// stubbed via the require-cache convention scripts/verifyAdVisionQcSurfacing
// .js's own F-section already established), forces a genuine QC failure,
// and asserts the ACTUAL Ad.updateOne payload it produces. That is immune to
// all six shapes at once, and to any future one, because it never reads
// source — it runs the function and inspects what it does.
//
// Pure + offline: no live DB/network — see the stub block below for what's
// faked and why. No node_modules beyond what brandScriptExecutor.js itself
// already requires.
//   node scripts/verifyVideoQcVerdictSurvives.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const ADS_RAW = fs.readFileSync(path.join(ROOT, 'routes/ads.js'), 'utf8');

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

let failures = 0, passes = 0;
function check(name, fn) {
  try { fn(); passes++; console.log(`  ✓ ${name}`); }
  catch (err) { failures++; console.log(`  ✗ ${name}\n     ${err.message}`); }
}

function balanced(text, openIdx, open, close) {
  if (openIdx < 0 || text[openIdx] !== open) return null;
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) { depth--; if (depth === 0) return text.slice(openIdx, i + 1); }
  }
  return null;
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

(async () => {
  console.log('\n── routes/ads.js (master + derive terminal writes) ──');
  assertGuarded(terminalDraftWrites(ADS_SRC), 'ads.js');

  console.log('\n── the upstream QC-verdict writer cannot be silently defeated (behavioural) ──');

  // Same require-cache-stub convention scripts/verifyAdVisionQcSurfacing.js's
  // F-section already uses to drive runVideoVisionQcForAd for real — extended
  // here with Ad + cloudinaryService stubs so uploadRenderAndStamp can run
  // end-to-end and its ACTUAL persisted write can be inspected.
  const cloudinaryPath = require.resolve(path.join(ROOT, 'services', 'cloudinaryService.js'));
  const originalCloudinary = require.cache[cloudinaryPath];
  require.cache[cloudinaryPath] = {
    id: cloudinaryPath, filename: cloudinaryPath, loaded: true,
    exports: {
      uploadFileToCloudinary: async () => ({ secure_url: 'https://res.cloudinary.com/x/video/upload/v1/fake.mp4' })
    }
  };

  const qcPath = require.resolve(path.join(ROOT, 'services', 'adVisionQcService.js'));
  const originalQc = require.cache[qcPath];
  const fakeVerdict = {
    passed: false, skipped: false, disabled: false, finalAttempt: 1,
    attempts: [{
      attempt: 1, pass: false, categories: {}, findings: ['garbled logo'],
      summary: 'hallucinated colourway', renderUrl: 'https://x/v.mp4', discarded: false
    }]
  };
  require.cache[qcPath] = {
    id: qcPath, filename: qcPath, loaded: true,
    exports: {
      resolveVideoEnabled: async () => true,
      warnQcDisabledOnce: () => {},
      buildAppPreviewUrl: () => 'https://app.example/preview',
      runVideoPostRenderQc: async () => ({ ok: true, skipped: false, passed: false, visionQc: fakeVerdict }),
      alertQcFailure: () => 'FAKE_SLACK_DETAIL_TEXT_FOR_TEST',
      noteQcFailToRunFeed: () => {},
      noteQcPassToRunFeed: () => {},
      alertQcSkipped: () => {},
      buildPersistedVerdict: (args) => args,
      buildSkippedVerdict: (reason) => ({ skipped: true, reason })
    }
  };

  // adStage/noteRenderIssue do a real (unawaited) Ad.updateOne in production
  // — harmless there (fire-and-forget, .catch(()=>{})) but this file
  // promises no live DB, so stub it rather than let a stray op float.
  const adStagePath = require.resolve(path.join(ROOT, 'services', 'adStage.js'));
  const originalAdStage = require.cache[adStagePath];
  require.cache[adStagePath] = {
    id: adStagePath, filename: adStagePath, loaded: true,
    exports: { adStage: () => {}, noteRenderIssue: () => {} }
  };

  // The Ad model itself — captures every write call so the check below can
  // assert on what was ACTUALLY sent to Mongo, not on source text. Covers
  // every Mongoose write method AND the raw collection bypass, so a future
  // code change is captured cleanly regardless of which one it uses —
  // deliberately not locked to updateOne only.
  const adModelPath = require.resolve(path.join(ROOT, 'models', 'Ad.js'));
  const originalAdModel = require.cache[adModelPath];
  const updateCalls = [];
  const recordWrite = (filter, update) => {
    updateCalls.push({ filter, update });
    return { matchedCount: 1, modifiedCount: 1 };
  };
  require.cache[adModelPath] = {
    id: adModelPath, filename: adModelPath, loaded: true,
    exports: {
      updateOne: async (filter, update) => recordWrite(filter, update),
      findOneAndUpdate: async (filter, update) => { recordWrite(filter, update); return null; },
      findByIdAndUpdate: async (id, update) => { recordWrite({ _id: id }, update); return null; },
      collection: { updateOne: async (filter, update) => recordWrite(filter, update) }
    }
  };

  const bsePath = require.resolve(path.join(ROOT, 'services', 'brandScriptExecutor.js'));
  const originalBse = require.cache[bsePath];
  delete require.cache[bsePath];
  try {
    const freshBse = require(path.join(ROOT, 'services', 'brandScriptExecutor.js'));

    check('uploadRenderAndStamp() is exported for direct behavioural testing', () => {
      assert.strictEqual(typeof freshBse.uploadRenderAndStamp, 'function');
    });

    const result = await freshBse.uploadRenderAndStamp({
      ad: { _id: '507f1f77bcf86cd799439099', veoReferenceImages: ['https://x/orig.png'], campaignRunIds: [] },
      // Neither path is read for real: uploadFileToCloudinary is stubbed
      // above (never touches finalPath), and tempDir cleanup uses
      // fs.promises.rm(..., { force: true }), which is silent on ENOENT.
      finalPath: '/tmp/verifyVideoQcVerdictSurvives-does-not-exist.mp4',
      tempDir:   '/tmp/verifyVideoQcVerdictSurvives-does-not-exist-tmp',
      timings:   {}
    });

    check('[THE REAL MECHANISM, BEHAVIOURAL] a real QC failure persists status:\'failed\', not draft', () => {
      assert.strictEqual(updateCalls.length, 1, `expected exactly one Ad.updateOne call, saw ${updateCalls.length}`);
      const set = updateCalls[0].update.$set || updateCalls[0].update;
      assert.strictEqual(set.status, 'failed',
        'a real (non-skipped/disabled) vision-QC failure must persist status:\'failed\'. This assertion ' +
        'reads the ACTUAL persisted value, so it does not matter what internal shape produced the write — ' +
        'merge order, a later resurrecting assignment, findByIdAndUpdate instead of updateOne, a raw ' +
        'Ad.collection.updateOne bypass, a computed key, a backtick, or a $set built as a variable all ' +
        'either produce the right payload or they do not, and this is what checks which.');
      assert.ok(set.renderError, 'must include a renderError so the operator sees why');
      assert.strictEqual(set.renderError.charged, true, 'the master was already billed — must not read as an unbilled infra failure');
      assert.strictEqual(set.visionQc?.failureDetail, 'FAKE_SLACK_DETAIL_TEXT_FOR_TEST',
        'must stamp the same failureDetail text alertQcFailure sent to Slack');
    });

    check('uploadRenderAndStamp still returns the delivered renderUrl on a QC failure (asset never discarded)', () => {
      assert.strictEqual(result.renderUrl, 'https://res.cloudinary.com/x/video/upload/v1/fake.mp4');
    });

    // POSITIVE CONTROL — a genuine QC PASS must leave status as 'draft', not
    // 'failed'. Without this, a hypothetical bug that always stamped
    // 'failed' regardless of the verdict would pass every check above.
    require.cache[qcPath].exports.runVideoPostRenderQc = async () => ({
      ok: true, skipped: false, passed: true,
      visionQc: { passed: true, skipped: false, disabled: false, finalAttempt: 1, attempts: [] }
    });
    delete require.cache[bsePath];
    const passFreshBse = require(path.join(ROOT, 'services', 'brandScriptExecutor.js'));
    updateCalls.length = 0;
    const passResult = await passFreshBse.uploadRenderAndStamp({
      ad: { _id: '507f1f77bcf86cd799439098', veoReferenceImages: ['https://x/orig.png'], campaignRunIds: [] },
      finalPath: '/tmp/verifyVideoQcVerdictSurvives-does-not-exist-2.mp4',
      tempDir:   '/tmp/verifyVideoQcVerdictSurvives-does-not-exist-tmp-2',
      timings:   {}
    });
    check('[POSITIVE CONTROL] a genuine QC pass leaves status as \'draft\'', () => {
      assert.strictEqual(updateCalls.length, 1, `expected exactly one Ad.updateOne call, saw ${updateCalls.length}`);
      const set = updateCalls[0].update.$set || updateCalls[0].update;
      assert.strictEqual(set.status, 'draft',
        'a genuine pass must not flip status to failed — if this fails while the FAIL scenario above also ' +
        'passes, something stamps failed unconditionally rather than reading the real verdict.');
      assert.strictEqual(set.renderError, undefined, 'no renderError on a genuine pass');
      assert.strictEqual(passResult.renderUrl, 'https://res.cloudinary.com/x/video/upload/v1/fake.mp4');
    });
  } finally {
    if (originalCloudinary) require.cache[cloudinaryPath] = originalCloudinary; else delete require.cache[cloudinaryPath];
    if (originalQc) require.cache[qcPath] = originalQc; else delete require.cache[qcPath];
    if (originalAdStage) require.cache[adStagePath] = originalAdStage; else delete require.cache[adStagePath];
    if (originalAdModel) require.cache[adModelPath] = originalAdModel; else delete require.cache[adModelPath];
    if (originalBse) require.cache[bsePath] = originalBse; else delete require.cache[bsePath];
    delete require.cache[bsePath];
  }

  console.log('');
  if (failures) {
    console.log(`❌ verifyVideoQcVerdictSurvives (backend): ${failures} FAILED, ${passes} passed`);
    process.exit(1);
  }
  console.log(`✅ verifyVideoQcVerdictSurvives (backend): all ${passes} checks passed`);
})().catch((err) => {
  console.error('verifyVideoQcVerdictSurvives (backend) crashed:', err);
  process.exit(1);
});
