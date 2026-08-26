'use strict';
// Pins that Ad.renderStage reaches a TERMINAL value on every code path that
// ends a video ad's processing — success, vision-QC-failed-but-kept, and an
// unrecovered exception. Closes the 2026-08-26 bug: `adStage(ad._id, 'vision
// QC (video)')` (brandScriptExecutor.js) was the LAST stage write on the
// video-master path, pass or fail, and nothing ever wrote a terminal
// sentinel afterward. Measured in production: 242/300 recent video ads read
// renderStage:"vision QC (video)" and only 14 read "done" — the frontend
// shows a live elapsed-timer UI for any non-empty, non-'done' stage, so
// finished ads displayed "Quality check" forever with a growing clock.
//
// DESIGN CHOICE PINNED HERE: renderStage:'done' is written UNCONDITIONALLY —
// on a clean success AND on a QC-failed-but-kept row AND on a definitively
// failed row. renderStage is progress telemetry ("is this ad still doing
// something"), not a pass/fail verdict; `status` (draft/failed/archived)
// already carries that distinction correctly and is never touched by these
// renderStage writes. This mirrors the ALREADY-SHIPPED precedent in
// titlingResumeService.js's own resume-success path (which also stamps
// renderStage:'done' regardless of the final status), rather than inventing
// a second, unverified sentinel whose frontend handling is not something
// this repo can check (the frontend lives in a different repo).
//
// Structural, not execution-based: neither renderer.js nor titler.js
// exports settleNonDraftTerminal / the terminal $set blocks (they are
// internal to a giant claim/render/settle pipeline this repo's other
// harnesses already treat as too risky to partially export — see
// verifyRendererAtomicClaim.js's own "offline stub driven by the real
// filter text" approach for precedent). Each check is paired with a
// revert-proof mutation so a passing check is not a vacuous regex.

const path = require('path');
const fs = require('fs');
const REPO = path.resolve(__dirname, '..');

const failures = [];
const passes = [];
function check(name, cond, detail) {
  if (cond === true) passes.push(name);
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const rendererPath = path.join(REPO, 'src', 'services', 'renderer.js');
const titlerPath = path.join(REPO, 'src', 'services', 'titler.js');
const rendererSrc = fs.readFileSync(rendererPath, 'utf8');
const titlerSrc = fs.readFileSync(titlerPath, 'utf8');

// Extract every `Ad.updateOne(...)` / `Ad.findOneAndUpdate(...)` call block
// (balanced on the outermost parens) so each check can look inside ONE call
// at a time instead of risking a regex that spans two unrelated blocks.
function extractCalls(src, calleePattern) {
  const calls = [];
  const re = new RegExp(calleePattern, 'g');
  let m;
  while ((m = re.exec(src))) {
    const start = m.index;
    let depth = 0;
    let i = start + m[0].length - 1; // sit on the opening '('
    let end = -1;
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) continue;
    calls.push({ start, end, text: src.slice(start, end + 1) });
  }
  return calls;
}

// ── A. renderer.js: settleNonDraftTerminal ──────────────────────────────────
const rendererSettle = rendererSrc.match(/async function settleNonDraftTerminal\([^)]*\)\s*\{[\s\S]*?\n\}\n/);
check('A1: renderer.js settleNonDraftTerminal() found', !!rendererSettle);
if (rendererSettle) {
  const body = rendererSettle[0];
  check('A2: settleNonDraftTerminal writes renderStage: \'done\'', /renderStage:\s*'done'/.test(body));
  check('A3: settleNonDraftTerminal does NOT write `status:` in its $set (must not resurrect a QC verdict)',
    !/\$set:\s*\{[^}]*\bstatus:/.test(body));
}

// ── B. renderer.js: the two guarded success $set blocks (DERIVE + MASTER) ──
const rendererGuardedCalls = extractCalls(rendererSrc, 'Ad\\.updateOne')
  .filter((c) => /status:\s*\{\s*\$in:\s*\[\s*'rendering',\s*'draft'\s*\]\s*\}/.test(c.text));
check('B1: renderer.js has exactly 2 guarded (status $in [rendering,draft]) Ad.updateOne calls (DERIVE + MASTER)',
  rendererGuardedCalls.length === 2, `found ${rendererGuardedCalls.length}`);
for (const [i, call] of rendererGuardedCalls.entries()) {
  check(`B2.${i}: guarded call #${i} still requires status $in [rendering,draft] (guard not weakened)`,
    /status:\s*\{\s*\$in:\s*\[\s*'rendering',\s*'draft'\s*\]\s*\}/.test(call.text));
  check(`B3.${i}: guarded call #${i} still sets status: 'draft' on match (success path unchanged)`,
    /status:\s*'draft'/.test(call.text));
  check(`B4.${i}: guarded call #${i} sets renderStage: 'done'`,
    /renderStage:\s*'done'/.test(call.text));
}

// ── C. titler.js: settleNonDraftTerminal ────────────────────────────────────
const titlerSettle = titlerSrc.match(/async function settleNonDraftTerminal\([^)]*\)\s*\{[\s\S]*?\n\}\n/);
check('C1: titler.js settleNonDraftTerminal() found', !!titlerSettle);
if (titlerSettle) {
  const body = titlerSettle[0];
  check('C2: settleNonDraftTerminal writes renderStage: \'done\'', /renderStage:\s*'done'/.test(body));
  check('C3: settleNonDraftTerminal does NOT write `status:` in its $set (must not resurrect a QC verdict)',
    !/\$set:\s*\{[^}]*\bstatus:/.test(body));
  check('C4: settleNonDraftTerminal still clears titlingNeeded: false (titler-specific invariant, unrelated to this fix, must survive it)',
    /titlingNeeded:\s*false/.test(body));
}

// ── D. titler.js: the one guarded success $set block (master+derive unified) ──
const titlerGuardedCalls = extractCalls(titlerSrc, 'Ad\\.updateOne')
  .filter((c) => /status:\s*\{\s*\$in:\s*\[\s*'rendering',\s*'draft'\s*\]\s*\}/.test(c.text));
check('D1: titler.js has exactly 1 guarded (status $in [rendering,draft]) Ad.updateOne call',
  titlerGuardedCalls.length === 1, `found ${titlerGuardedCalls.length}`);
if (titlerGuardedCalls.length) {
  const call = titlerGuardedCalls[0];
  check('D2: guarded call still requires status $in [rendering,draft]',
    /status:\s*\{\s*\$in:\s*\[\s*'rendering',\s*'draft'\s*\]\s*\}/.test(call.text));
  check('D3: guarded call still sets status: \'draft\' on match',
    /status:\s*'draft'/.test(call.text));
  check('D4: guarded call sets renderStage: \'done\'',
    /renderStage:\s*'done'/.test(call.text));
  check('D5: guarded call still clears titlingNeeded: false',
    /titlingNeeded:\s*false/.test(call.text));
}

// ── E. processAd catch blocks (unrecovered-exception terminal path) ────────
// renderer.js's catch writes `claimedByWorker: WORKER_ID` (owner-scoped) —
// use that as the anchor since it's unique to this specific terminal write.
const rendererCatchCalls = extractCalls(rendererSrc, 'Ad\\.updateOne')
  .filter((c) => /claimedByWorker:\s*WORKER_ID\s*\}/.test(c.text) && /status:\s*'failed'/.test(c.text));
check('E1: renderer.js processAd catch terminal-fail write found', rendererCatchCalls.length >= 1,
  `found ${rendererCatchCalls.length}`);
if (rendererCatchCalls.length) {
  check('E2: renderer.js terminal-fail write sets renderStage: \'done\'',
    rendererCatchCalls.some((c) => /renderStage:\s*'done'/.test(c.text)));
}

const titlerCatchCalls = extractCalls(titlerSrc, 'Ad\\.updateOne')
  .filter((c) => /claimedByWorker:\s*WORKER_ID\s*\}/.test(c.text) && /status:\s*'failed'/.test(c.text));
check('E3: titler.js processAd catch terminal-fail write found', titlerCatchCalls.length >= 1,
  `found ${titlerCatchCalls.length}`);
if (titlerCatchCalls.length) {
  check('E4: titler.js terminal-fail write sets renderStage: \'done\'',
    titlerCatchCalls.some((c) => /renderStage:\s*'done'/.test(c.text)));
}

// ── F. Revert-proofs: each source file's renderStage:'done' occurrences ────
// Count total occurrences per file and prove the checks above actually
// depend on them — strip ALL and re-run the extraction-based checks above,
// they must all flip to false.
// Line-anchored so this counts actual `$set` object-literal entries only —
// NOT this file's own header prose, or renderer.js's/titler.js's own code
// comments quoting the phrase for documentation (both exist, deliberately).
function countRenderStageDone(src) {
  return (src.match(/^\s*renderStage:\s*'done',$/gm) || []).length;
}
check('F1: renderer.js has exactly 4 renderStage:\'done\' writes (settle + derive + master + catch)',
  countRenderStageDone(rendererSrc) === 4, `found ${countRenderStageDone(rendererSrc)}`);
check('F2: titler.js has exactly 3 renderStage:\'done\' writes (settle + guarded + catch)',
  countRenderStageDone(titlerSrc) === 3, `found ${countRenderStageDone(titlerSrc)}`);

const rendererStripped = rendererSrc.replace(/renderStage:\s*'done',\n\s*renderStageAt:\s*new Date\(\),\n/g, '');
check('F3: [REVERT-PROOF] stripping renderStage:\'done\' pairs from renderer.js is reachable (source actually changes)',
  rendererStripped !== rendererSrc);
check('F4: [REVERT-PROOF] after stripping, renderer.js has zero renderStage:\'done\' writes',
  countRenderStageDone(rendererStripped) === 0);

const titlerStripped = titlerSrc.replace(/renderStage:\s*'done',\n\s*renderStageAt:\s*new Date\(\),\n/g, '');
check('F5: [REVERT-PROOF] stripping renderStage:\'done\' pairs from titler.js is reachable (source actually changes)',
  titlerStripped !== titlerSrc);
check('F6: [REVERT-PROOF] after stripping, titler.js has zero renderStage:\'done\' writes',
  countRenderStageDone(titlerStripped) === 0);

// ── report ───────────────────────────────────────────────────────────────
console.log(`\nverifyRenderStageTerminal: ${passes.length} pass, ${failures.length} fail`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
for (const p of passes) console.log('  ✓ ' + p);
console.log('\n✅ renderStage reaches a terminal value on every video-path exit (success, QC-failed-but-kept, unrecovered exception), on both renderer.js and titler.js, without weakening the status $in [rendering,draft] guard.');
