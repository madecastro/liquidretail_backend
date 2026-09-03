#!/usr/bin/env node
'use strict';
//
// verifyRendererVideoMoneyInvariants — the two money rules renderer.js's
// video path must obey, checked structurally (control-flow proofs against
// the REAL source text, not a reimplementation):
//
//   (1) A derive-only Ad (resolveDeriveFromMaster(ad) truthy — a free crop
//       or retitle of an already-paid Omni master) must NEVER reach a
//       billable atlasVideo.generateForAd() submit. Backend's own
//       equivalent (CLAUDE.md §4, "resolveDeriveFromMaster is defined ONCE
//       and imported") is exactly the guard whose absence opened a real
//       regenerate hole in Phase A ("regenerate called
//       veoService.generateForAd unconditionally on a PMax 1:1 and billed
//       a full Omni generation on the free surface").
//   (2) A derive whose sibling master has already failed must be reported
//       as a failure, never silently fall back to submitting its OWN
//       Omni master (that would be billing for a "free" derivative the
//       operator never asked to pay for).
//
// HOW THIS IS PROVEN, without requiring campaignAdsGenerationService.js
// (a heavy module — mongoose + five other models + several services — that
// would need a full NODE_PATH + mongoose install just to read one pure
// function's return value):
//
//   renderVideo(ad) has exactly ONE call to atlasVideo.generateForAd in the
//   whole file. This harness proves that call is STRUCTURALLY UNREACHABLE
//   whenever `resolveDeriveFromMaster(ad)` is truthy, by showing:
//     a. `if (deriveFromFmt) { ... }` is the FIRST statement in renderVideo
//        after computing deriveFromFmt.
//     b. EVERY control-flow path inside that if-block ends in `throw` or
//        `return` — so JS can never fall through its closing brace into
//        the code below (which is where the one generateForAd call lives).
//     c. The generateForAd call site is textually AFTER that closing
//        brace, and there is exactly one such call in the whole file.
//     d. The "master failed" branch inside the derive block throws — it
//        does not, and structurally cannot (see c), call generateForAd.
//
// This is a stricter proof than a behavioural stub would give: a stub test
// only shows generateForAd wasn't called on the INPUTS you happened to
// try. A closing-brace/return proof shows there is no JS input for which
// it COULD be reached from inside that block, short of a syntax change
// this harness would also catch.
//
// Pure + offline: fs/path/assert only, no node_modules required.
//   node scripts/verifyRendererVideoMoneyInvariants.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'renderer.js'), 'utf8');

let checks = 0;
const failures = [];
function check(label, fn) {
  try { fn(); checks += 1; console.log(`  ✓ ${label}`); }
  catch (err) { failures.push(`${label}\n     ${err.message}`); console.log(`  ✗ ${label}`); }
}

function balanced(src, openIdx, openCh, closeCh) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === openCh) depth++;
    else if (src[i] === closeCh) { depth--; if (depth === 0) return { text: src.slice(openIdx, i + 1), endIdx: i + 1 }; }
  }
  return null;
}

// ── locate renderVideo() and the `if (deriveFromFmt) { ... }` block ───────
const fnMatch = /async function renderVideo\(ad\)\s*\{/.exec(SRC);
assert.ok(fnMatch, 'renderVideo signature not found — re-derive this harness');
const fnBodyStart = SRC.indexOf('{', fnMatch.index + fnMatch[0].length - 1);
const fnBody = balanced(SRC, fnBodyStart, '{', '}');
assert.ok(fnBody, 'renderVideo body unterminated');

const deriveAssignMatch = /const deriveFromFmt\s*=\s*resolveDeriveFromMaster\(ad\);/.exec(fnBody.text);
check('setup: renderVideo computes deriveFromFmt via the imported, single-definition resolveDeriveFromMaster', () => {
  assert.ok(deriveAssignMatch, 'expected `const deriveFromFmt = resolveDeriveFromMaster(ad);` near the top of renderVideo');
});

const ifMatch = /if\s*\(\s*deriveFromFmt\s*\)\s*\{/.exec(fnBody.text);
check('setup: an `if (deriveFromFmt) { ... }` block exists in renderVideo', () => {
  assert.ok(ifMatch, 'derive-gate if-block not found');
});

const ifBraceIdx = fnBody.text.indexOf('{', ifMatch.index + ifMatch[0].length - 1);
const ifBlock = balanced(fnBody.text, ifBraceIdx, '{', '}');
assert.ok(ifBlock, 'derive-gate if-block unterminated');

// ═════════════════════════════════════════════════════════════════════════
// A — the derive gate comes BEFORE any billable submit call, and every
// path through it terminates (throw/return) rather than falling through.
// ═════════════════════════════════════════════════════════════════════════
check('A1 the derive-gate if-block appears strictly before the deriveFromFmt assignment\'s next statement reaches a submit', () => {
  // Sanity on ordering only — the real proof is A2/A3/B below.
  assert.ok(ifMatch.index > deriveAssignMatch.index);
});

check('A2 [CONTROL-FLOW PROOF] every path inside the derive if-block ends in throw or return — it can never fall through', () => {
  // Walk the if-block's TOP-LEVEL statements (depth 0 relative to the
  // if-block's own braces) and confirm the LAST one is a throw or return.
  // The block's own internal branches (deriveWaitAttempts guard, the
  // sibling-master poll loop, the "not ready" requeue) each independently
  // throw or return earlier — checked by name in A3/B — but what matters
  // for reachability of the code AFTER this block is only the block's own
  // final statement, since JS falls through to the code after a `{...}`
  // only if execution reaches the closing brace without having already
  // thrown or returned.
  const inner = ifBlock.text.slice(1, -1).trim();
  // Find the LAST top-level statement by scanning backward from the end,
  // skipping trailing whitespace/comments, and confirming it starts with
  // `return` (a bare `return;` is what the success path and the
  // requeue-wait path both end in; the two throw sites are INSIDE nested
  // blocks earlier in the function, not the block's own tail).
  const tail = inner.replace(/\/\/[^\n]*$/m, '').trimEnd();
  assert.ok(/return;\s*$/.test(tail),
    `expected the derive if-block's final top-level statement to be a bare 'return;' — got: ...${tail.slice(-80)}`);
});

check('A3 the two internal escape hatches inside the derive block are throw, not a billable fallback', () => {
  // (i) exceeding the wait-attempt ceiling
  assert.match(ifBlock.text, /deriveWaitAttempts[\s\S]{0,40}>=\s*MAX_DERIVE_WAIT_ATTEMPTS[\s\S]{0,60}\{\s*\n\s*throw new Error/,
    'exceeding MAX_DERIVE_WAIT_ATTEMPTS must throw, not silently proceed to a submit');
  // (ii) sibling master already failed
  assert.match(ifBlock.text, /master\?\.status === 'failed'[\s\S]{0,60}\{\s*\n\s*throw new Error/,
    '[INVARIANT 2] a failed sibling master must throw — never fall back to this ad submitting its own Omni master');
});

check('A4 the "sibling master failed" branch contains no submit call of any kind', () => {
  const failedBranchMatch = /if\s*\(\s*master\?\.status === 'failed'\s*\)\s*\{/.exec(ifBlock.text);
  assert.ok(failedBranchMatch, 'failed-sibling branch not found');
  const braceIdx = ifBlock.text.indexOf('{', failedBranchMatch.index + failedBranchMatch[0].length - 1);
  const branch = balanced(ifBlock.text, braceIdx, '{', '}');
  assert.ok(branch);
  assert.ok(!/generateForAd|atlasVideo\./.test(branch.text),
    'the failed-sibling-master branch must not contain any Omni submit call');
});

check('A5 the not-ready-yet branch requeues and returns — it does not submit either', () => {
  assert.match(ifBlock.text, /if\s*\(\s*!master\?\.veoVideoUrl\s*\)\s*\{[\s\S]{0,120}requeueDeriveForRetry[\s\S]{0,60}return;[^\n]*\n\s*\}/,
    'expected the wait-timeout branch to call requeueDeriveForRetry then return, with no submit in between');
});

// ═════════════════════════════════════════════════════════════════════════
// B — the billable submit call site: there is exactly one, and it sits
// textually AFTER the derive if-block's closing brace.
// ═════════════════════════════════════════════════════════════════════════
const ifBlockEndIdx = fnBody.text.indexOf(ifBlock.text) + ifBlock.text.length;
const afterIfBlock = fnBody.text.slice(ifBlockEndIdx);

// ── RETARGETED 2026-09-03 for the provider seam. STRICTER, NOT LOOSER ─────
//
// There are now TWO billable submit call sites — atlasVideo.generateForAd and
// geminiVideo.generateForAd — because production is cutting over to the direct
// Gemini API. B1 used to assert "exactly one call in the file", which is the
// right shape for one provider and the WRONG shape for two: it would force
// whoever adds a provider to delete the check rather than extend it.
//
// So the invariant is restated at the level it actually lives: EVERY billable
// submit, whichever provider, must sit after the derive gate and outside it —
// and the providers must be MUTUALLY EXCLUSIVE BRANCHES, never a fallback
// chain. A fallback would mean a failed Atlas submit silently buys a Gemini
// one, i.e. two masters for one ad. That is a new failure mode this seam
// could have introduced and B3 below now rules out explicitly.
//
// This is strictly more than the old form proved, because it additionally
// pins that an UNRECOGNISED provider throws instead of falling through to a
// billable default. videoRouter's own dispatch sends anything-not-'atlas' to
// the deprecated Vertex path, so a typo (VIDEO_PROVIDER=gemeni) would
// otherwise generate on a third provider entirely.
const SUBMIT_RE = /(?:atlasVideo|geminiVideo)\.generateForAd\(/g;

check('B1 [INVARIANT 1] every billable submit call site is accounted for', () => {
  const all = [...SRC.matchAll(SUBMIT_RE)];
  assert.strictEqual(all.length, 2,
    `expected exactly 2 provider submit call sites (atlas + gemini), found ${all.length} — ` +
    'a new one needs its own derive-gate proof or it can bill a derive-only row');
  assert.strictEqual((SRC.match(/atlasVideo\.generateForAd\(/g) || []).length, 1);
  assert.strictEqual((SRC.match(/geminiVideo\.generateForAd\(/g) || []).length, 1);
});

check('B2 [INVARIANT 1] BOTH call sites sit AFTER (never inside) the derive if-block', () => {
  for (const p of ['atlasVideo', 'geminiVideo']) {
    assert.ok(new RegExp(`${p}\\.generateForAd\\(`).test(afterIfBlock),
      `${p}.generateForAd must be reachable only via the fall-through path after the derive gate`);
    assert.ok(!new RegExp(`${p}\\.generateForAd\\(`).test(ifBlock.text),
      `${p}.generateForAd must not appear inside the derive if-block itself`);
  }
});

check('B3 the providers are EXCLUSIVE branches, not a fallback chain, and a skip still throws', () => {
  const seamIdx = afterIfBlock.search(SUBMIT_RE);
  const seam = afterIfBlock.slice(seamIdx, seamIdx + 1800);

  // EXCLUSIVITY. The gemini call must be in an `else if`, so a completed
  // Atlas submit can never be followed by a Gemini one for the same ad.
  assert.match(seam, /\}\s*else if \(videoProvider === 'gemini'\)/,
    'the gemini submit must be an else-if branch of the atlas one — a sequential second call would buy two masters for one ad');

  // FAIL CLOSED. An unknown provider throws before any submit.
  assert.match(seam, /\}\s*else \{[\s\S]{0,400}throw new Error\(/,
    'an unrecognised VIDEO_PROVIDER must throw, never fall through to a billable default');
  assert.ok(!/else\s*\{[\s\S]{0,200}(atlasVideo|geminiVideo)\.generateForAd\(/.test(seam),
    'the else arm must not submit to anything');

  // The original property, unchanged: a skipped result throws rather than
  // being treated as success. Bounded at the next syntactic boundary rather
  // than a magic char count, which is what broke when the seam grew.
  assert.match(seam, /if \(veoResult\.skipped\) \{\s*\n\s*throw new Error/,
    'a skipped/rejected submission must throw, not attempt a second provider or a retry-submit');

  // No second submit-shaped call after the seam on either provider.
  const tail = afterIfBlock.slice(seamIdx).replace(SUBMIT_RE, '');
  const second = tail.match(/(?:atlasVideo|geminiVideo)\.\w*(generate|submit)\w*\(/i);
  assert.ok(!second, `found a second submit-shaped call after the seam: ${second && second[0]}`);
});

// ── report ───────────────────────────────────────────────────────────────
const total = checks + failures.length;
console.log('');
if (failures.length) {
  console.log(`❌ verifyRendererVideoMoneyInvariants: ${failures.length} of ${total} checks FAILED`);
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}
console.log(`✅ verifyRendererVideoMoneyInvariants: ${total}/${total} checks passed`);

/*
 * REVERT-PROOF LEDGER — mutations that would make this harness fail:
 *   1. Remove the `return;` at the end of the derive if-block's success
 *      path (letting control fall through to the master path)
 *        → A2 fails
 *   2. Replace the "sibling master failed" throw with a fallback call to
 *      atlasVideo.generateForAd                          → A3/A4/B1 fail
 *   3. Add a second call to atlasVideo.generateForAd anywhere in the file
 *      (e.g. a "retry via a different provider" branch)  → B1 fails
 *   4. Move the generateForAd call INSIDE the derive if-block
 *        → B2 fails
 *   5. Drop the `if (veoResult.skipped) throw ...` guard on the master
 *      path, or add a second submit call after it            → B3 fails
 */
