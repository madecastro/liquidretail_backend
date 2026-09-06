#!/usr/bin/env node
'use strict';
//
// verifyTitlingHeartbeat — while THIS worker is titling a video ad, the ad's
// updatedAt must keep moving, and the beat must not be able to outlive the
// render, run forever, or silently stop protecting the window it exists for.
//
// THE DEFECT THIS PINS. models/Ad.js is `timestamps: false`, so updatedAt only
// moves when written explicitly, and claimOne() writes only claimedByWorker /
// claimedAt. The Atlas Omni poll is covered (pollPrediction -> adStage every
// ~5s). Remotion titling is NOT: it queues behind REMOTION_QUEUE_CONCURRENCY
// with no Ad write at all while it waits. liquidretail_backend's worker runs
// bootRecoveryService against this SAME collection, ungated on
// ADGEN_RENDERER_ENABLED, selecting { status:'rendering', updatedAt <
// now-RESUME_STALE_MIN(5), HAS_RECEIPT }. So a healthy adgen titling job
// becomes "recoverable", backend web's titlingResumeService then titles the
// same paid master, and two Remotion renders race on one ~$0.90 asset.
//
// Made likelier by the OOM fix: REMOTION_QUEUE_CONCURRENCY 4 -> 2, so the
// queue wait per ad is LONGER and the 5-minute window is easier to reach.
//
// SECOND PASS (2026-08-24, xhigh adversarial review of the FIRST version of
// this file). The original six checks were string-PRESENCE checks — they
// verify a name exists somewhere, not that it does its job in the right
// place. Five mutations passed every one of them while reopening the exact
// steal window this file exists to close:
//   1. AD_HEARTBEAT_MS raised past RESUME_STALE_MIN — never checked at all.
//   2. startAdHeartbeat() moved to AFTER the titling call — B1's old check
//      only counted call sites, not their position relative to the call
//      they guard.
//   3. AD_HEARTBEAT_MAX_MS shrunk to ~0 — C1's old check only required the
//      NAME and a clearInterval to exist somewhere, not a sane value.
//   4. openedAt reset every tick, so the cap comparison never fires —
//      nothing checked WHERE openedAt is assigned.
//   5. A dummy `try {} finally { beat.stop() }` elsewhere, not wrapping the
//      actual titling call — the old B2 counted try/finally blocks and
//      titling calls SEPARATELY and never paired them.
// Every check below that replaces one of these is POSITION- or VALUE-aware,
// not presence-only, and each is revert-proven against the specific mutation
// that defeated its predecessor.
//
// Comments are STRIPPED before scanning. This is not optional here: the
// heartbeat's own explanatory comments quote nearly every string these checks
// search for, so an unstripped scan would pass against a deleted heartbeat.
//
// Pure + offline: fs/path/assert only, no node_modules required.
//   node scripts/verifyTitlingHeartbeat.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const RAW = fs.readFileSync(path.join(ROOT, 'src/services/renderer.js'), 'utf8');

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

const SRC = stripComments(RAW);

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
function fnBody(name) {
  const m = new RegExp(`function ${name}\\s*\\(`).exec(SRC);
  if (!m) return null;
  return balanced(SRC, SRC.indexOf('{', SRC.indexOf(')', m.index)), '{', '}');
}

/**
 * The RHS of `const NAME = <expr>;`, balanced through any nested parens/
 * brackets/braces and cut at the top-level (depth 0) semicolon — not a
 * substring match. THIRD PASS fix: the previous D1/C2 checks matched a
 * PREFIX of the expression (e.g. captured `60_000` out of
 * `Number(... || 60_000) * 5` and never noticed the trailing `* 5`) or
 * checked properties ANYWHERE IN THE FILE rather than within this specific
 * statement (so `MAX_INFLIGHT` used elsewhere kept a check green even after
 * the real formula stopped reading it). Scoping to the exact statement and
 * requiring a FULL-STRING match closes both classes.
 */
function constStatement(text, name) {
  const m = new RegExp(`const\\s+${name}\\s*=\\s*`).exec(text);
  if (!m) return null;
  let i = m.index + m[0].length;
  let depth = 0;
  const start = i;
  while (i < text.length) {
    const c = text[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ';' && depth === 0) break;
    i++;
  }
  return text.slice(start, i);
}

/**
 * Every `try { ... } finally { ... }` block in `text`, paired — not counted
 * separately the way the first version of this file did. Returns
 * { tryIndex, tryBody, finallyBody }.
 */
function tryFinallyBlocks(text) {
  const out = [];
  const TRY = /\btry\s*\{/g;
  let m;
  while ((m = TRY.exec(text))) {
    const tryIndex = m.index;
    const openIdx = text.indexOf('{', m.index);
    const tryBody = balanced(text, openIdx, '{', '}');
    if (!tryBody) { TRY.lastIndex = openIdx + 1; continue; }
    const afterTry = openIdx + tryBody.length;
    const fm = /^\s*finally\s*\{/.exec(text.slice(afterTry, afterTry + 60));
    let finallyBody = '';
    if (fm) {
      const finallyOpen = afterTry + fm[0].lastIndexOf('{');
      finallyBody = balanced(text, finallyOpen, '{', '}') || '';
    }
    out.push({ tryIndex, tryBody, finallyBody });
    TRY.lastIndex = afterTry;
  }
  return out;
}

console.log('\n── A: the beat exists and the scan is real ──');
const beat = fnBody('startAdHeartbeat');

check('A1 startAdHeartbeat() exists', () => {
  assert.ok(beat && beat.length > 200,
    'no per-ad heartbeat — a healthy titling job is stealable by bootRecoveryService after 5 min');
});

check('A2 comment stripping actually removed the prose (a zero-strip scan proves nothing)', () => {
  assert.ok(RAW.length > SRC.length + 500,
    'stripComments removed almost nothing — the checks below would be scanning comments');
});

console.log('\n── B: the beat is PAIRED with the titling call it guards, not merely present ──');

// The pairing this section exists to prove: for EACH titling call site, the
// SAME try/finally wraps that exact call and stops that exact beat, and the
// beat was started immediately before entering that try — not after the
// call already returned, and not via an unrelated try/finally elsewhere.
const guardedPairs = tryFinallyBlocks(SRC).filter((b) =>
  /renderBrandScriptAndSave\s*\(/.test(b.tryBody) && /\.stop\(\)/.test(b.finallyBody));

check('B1 [MUTATION 5: dummy try/finally] exactly 2 try/finally blocks both wrap a titling call AND stop a beat', () => {
  assert.strictEqual(guardedPairs.length, 2,
    `expected 2 real try{titling}/finally{beat.stop()} pairs (derive + master), found ` +
    `${guardedPairs.length}. A finally{...stop()} that does not wrap renderBrandScriptAndSave, or ` +
    'a titling call not wrapped by a stopping finally, would both be invisible to a count that ' +
    'checks the two shapes separately instead of paired.');
});

check('B2 [MUTATION 2: beat started after the call] the beat starts BEFORE each guarded try, not after the titling call', () => {
  for (const pair of guardedPairs) {
    const preTry = SRC.slice(Math.max(0, pair.tryIndex - 250), pair.tryIndex);
    assert.match(preTry, /startAdHeartbeat\s*\(/,
      'no startAdHeartbeat(...) found immediately before this try/finally — a beat started ' +
      'after renderBrandScriptAndSave already returned covers none of the queue wait it exists for');
    assert.ok(!/renderBrandScriptAndSave\s*\(/.test(preTry),
      'found a titling call BEFORE the beat starts in the immediately preceding code — the beat ' +
      'is not in place before the call it is supposed to guard');
  }
});

check('B1b [ANTI-SMUGGLE] the guarding finally does NOTHING but stop the beat', () => {
  // A real, adversarial mutation: `finally { beat.stop(); await Ad.updateOne({_id}, {$set:
  // {status:'draft'}}); }` — a bare, UNGUARDED status write smuggled into the same finally
  // that stops the beat. B1 only checks the finally CONTAINS `.stop()`; it says nothing about
  // what else is in there. That write defeats the entire vision-QC $in guard from #7 while every
  // check about the beat itself stays green, because this file never inspects finally CONTENTS
  // beyond the one string it is looking for.
  for (const pair of guardedPairs) {
    assert.ok(!/\bAd\s*\.\s*(updateOne|updateMany|findOneAndUpdate|findOneAndDelete|deleteOne)\s*\(/.test(pair.finallyBody),
      `the finally that stops the beat must not perform any other Ad write — found one in: ` +
      pair.finallyBody.replace(/\s+/g, ' ').trim());
  }
});

check('B2b [ANTI-DECOY] the finally stops the SAME variable that captured startAdHeartbeat\'s return value', () => {
  // B1 proves a titling call is wrapped and SOME .stop() runs in its
  // finally. It does not prove they are connected. The third pass's
  // decoy: `const beat = startAdHeartbeat(adId); ... finally { beat.stop(); }`
  // where `beat` in the finally is a DIFFERENT local (e.g. shadowed, or a
  // dummy `{ stop(){} }`) than the one holding the real timer handle. Named
  // capture across both regexes closes it: the SAME identifier must appear
  // in both the declaration and the .stop() call.
  for (const pair of guardedPairs) {
    const preTry = SRC.slice(Math.max(0, pair.tryIndex - 250), pair.tryIndex);
    const decl = /(?:const|let)\s+(\w+)\s*=\s*startAdHeartbeat\s*\(/.exec(preTry);
    assert.ok(decl, 'no variable capturing startAdHeartbeat(...)\'s return value found before this try');
    const varName = decl[1];
    assert.match(pair.finallyBody, new RegExp(`\\b${varName}\\.stop\\(\\)`),
      `the finally must call .stop() on "${varName}" specifically — the exact variable that ` +
      'captured startAdHeartbeat\'s return value, not a same-shaped decoy declared separately');
  }
});

console.log('\n── C: it cannot run forever, and the cap cannot be silently defeated ──');

check('C1 [MONEY] the beat has a total lifetime cap, and the cap actually stops the timer', () => {
  assert.match(beat, /AD_HEARTBEAT_MAX_MS/,
    'an uncapped beat on a hung Remotion render keeps the row out of bootRecovery FOREVER, ' +
    'stranding a paid ~$0.90 master — strictly worse than no heartbeat at all');
  assert.match(beat, /clearInterval/, 'the cap must actually stop the timer');
});

check('C1b [ANTI-DEAD-CODE] the cap COMPARISON is not gated dead by a constant', () => {
  // `if (false && Date.now() - openedAt > AD_HEARTBEAT_MAX_MS)` keeps
  // AD_HEARTBEAT_MAX_MS and clearInterval both present (C1 stays green)
  // while the cap NEVER fires — the beat runs forever, the exact "uncapped
  // beat strands a paid master forever" hazard the cap exists to prevent.
  const m = /if\s*\(([^)]*Date\.now\(\)\s*-\s*openedAt\s*>\s*AD_HEARTBEAT_MAX_MS[^)]*)\)/.exec(beat);
  assert.ok(m, 'no if(...) statement found guarding the cap comparison');
  const cond = m[1].replace(/\s+/g, '');
  assert.strictEqual(cond, 'Date.now()-openedAt>AD_HEARTBEAT_MAX_MS',
    `the cap's if-condition must be EXACTLY "Date.now() - openedAt > AD_HEARTBEAT_MAX_MS", found ` +
    `"${m[1].trim()}" — anything else (e.g. "false && ...") can dead-gate the cap while C1's ` +
    'presence checks still report green');
});

check('C2 [MUTATION 3: near-zero cap] the cap resolves via the derived formula with its floor, not a bare fallback', () => {
  // SCOPED TO THE ACTUAL STATEMENT, not "anywhere in the file". The earlier
  // version checked MAX_INFLIGHT / REMOTION_QUEUE_CONCURRENCY / the floor
  // literal as independent whole-file matches — all four stay green if the
  // real formula is gutted (e.g. `Math.max(10*60*1000*0, 1)`) as long as
  // `void MAX_INFLIGHT; void concurrency.REMOTION_QUEUE_CONCURRENCY;` sits
  // anywhere else, or those identifiers are legitimately used elsewhere
  // (MAX_INFLIGHT already is, in poll()).
  const rhs = constStatement(SRC, 'AD_HEARTBEAT_MAX_MS');
  assert.ok(rhs, 'could not find AD_HEARTBEAT_MAX_MS\'s declaration');
  assert.match(rhs, /^Number\(process\.env\.AD_HEARTBEAT_MAX_MS\)\s*\|\|\s*Math\.max\(/,
    'the cap must fall back to a computed Math.max(...), not a bare small default');
  assert.match(rhs, /10\s*\*\s*60\s*\*\s*1000/,
    'the >=10-minute floor must be IN this statement — a very low concurrency value could shrink ' +
    'the cap to uselessness without it');
  assert.ok(!/10\s*\*\s*60\s*\*\s*1000\s*\*\s*0\b/.test(rhs),
    'the floor is multiplied by 0 — a near-zero cap dressed up with the right tokens');
  assert.match(rhs, /MAX_INFLIGHT/, 'the derived formula must read live MAX_INFLIGHT WITHIN this statement, not a constant');
  assert.match(rhs, /concurrency\.REMOTION_QUEUE_CONCURRENCY/,
    'the derived formula must read LIVE REMOTION_QUEUE_CONCURRENCY WITHIN this statement — a ' +
    'hardcoded number silently goes stale the next time that knob moves (it already moved once, ' +
    '4 -> 2, from an OOM)');
});

check('C3 [MUTATION 4: openedAt reset every tick] openedAt is captured ONCE, outside the interval callback, and never reassigned inside it', () => {
  const openedAtDecls = (beat.match(/\bopenedAt\s*=\s*Date\.now\(\)/g) || []).length;
  assert.strictEqual(openedAtDecls, 1,
    `openedAt must be captured exactly once at start; found ${openedAtDecls} assignment(s) to Date.now()`);
  const intervalMatch = /setInterval\s*\(\s*\(\s*\)\s*=>\s*\{/.exec(beat);
  assert.ok(intervalMatch, 'no setInterval(() => {...}) callback found in startAdHeartbeat');
  const cbOpen = beat.indexOf('{', intervalMatch.index);
  const cbBody = balanced(beat, cbOpen, '{', '}');
  assert.ok(cbBody, 'could not extract the setInterval callback body');
  assert.ok(!/openedAt\s*=(?!=)/.test(cbBody),
    'openedAt is reassigned INSIDE the interval callback — that resets the cap on every tick and ' +
    'the cap comparison (Date.now() - openedAt > AD_HEARTBEAT_MAX_MS) can then never fire');
});

check('C3b [MUTATION: nested-helper reassignment] openedAt is declared const, so it cannot be reset via ANY indirection', () => {
  // C3 only inspects the interval callback's own body. A mutation the third
  // adversarial pass found and C3 misses: a helper defined INSIDE
  // startAdHeartbeat (closing over openedAt) that the callback merely CALLS
  // — `function bump(t) { openedAt = t; } ... setInterval(() => bump(Date.now()), ...)`.
  // The reassignment text never appears inside the callback body C3 scans.
  // `const` forecloses the whole indirection CLASS at the language level:
  // any reassignment from anywhere closing over the binding throws at
  // runtime instead of silently resetting the cap.
  assert.match(beat, /\bconst\s+openedAt\s*=\s*Date\.now\(\)/,
    'openedAt must be declared const — that makes a reassignment from ANYWHERE closing over it ' +
    '(inline, or via a nested helper called from the interval) a runtime TypeError instead of a ' +
    'silent reset of the cap comparison');
  assert.ok(!/\blet\s+openedAt\b/.test(beat) && !/\bvar\s+openedAt\b/.test(beat),
    'openedAt must not be declared let/var anywhere in this function');
});

check('C4 the beat writes ONLY updatedAt', () => {
  const upd = /\$set:\s*\{([^}]*)\}/.exec(beat);
  assert.ok(upd, 'no $set found in the beat');
  assert.match(upd[1], /updatedAt/);
  for (const forbidden of ['status', 'titlingResumeState', 'succeeded', 'failed', 'claimedAt']) {
    assert.ok(!new RegExp(`\\b${forbidden}\\s*:`).test(upd[1]),
      `the beat must never write ${forbidden} — it would report work that did not happen`);
  }
});

check('C5 [DIVERGENCE] the filter requires claimedByWorker: WORKER_ID', () => {
  assert.match(beat, /claimedByWorker:\s*WORKER_ID/,
    'losing the claim must STOP the beat — otherwise we keep another owner\'s row alive ' +
    'and out of reach of the recovery that should now own it');
});

check('C6 the filter covers BOTH the rendering and the draft+claimed windows', () => {
  assert.match(beat, /status:\s*'rendering'/,
    'the pre-promote window (no-chrome / no-brand) must be covered');
  assert.match(beat, /status:\s*'draft'[\s\S]{0,80}titlingResumeState:\s*'claimed'/,
    "after uploadRenderAndStamp promotes to 'draft' the row is still stealable by " +
    'titlingResumeService arm 2 — that window needs the beat too');
});

check('C7 the timer is unref\'d so it cannot hold the process open', () => {
  assert.match(beat, /unref/);
});

console.log('\n── D: the interval itself is calibrated against the recovery window it must beat ──');

check('D1 [MUTATION 1: interval too slow] AD_HEARTBEAT_MS_RAW default is a small fraction of backend RESUME_STALE_MIN (5min)', () => {
  // FULL-STRING anchored match, not a prefix .exec() — the earlier version
  // captured only the digits inside Number(... || 60_000) and never noticed
  // trailing arithmetic. `Number(process.env.X || 60_000) * 5` (a 300s
  // interval — EXACTLY RESUME_STALE_MIN) still satisfied a prefix capture of
  // "60_000" while the REAL interval reopened the steal window outright.
  const rhs = constStatement(SRC, 'AD_HEARTBEAT_MS_RAW');
  assert.ok(rhs, 'could not find AD_HEARTBEAT_MS_RAW\'s declaration');
  const trimmed = rhs.replace(/\s+/g, '');
  const m = /^Number\(process\.env\.AD_HEARTBEAT_MS\|\|(\d[\d_]*)\)$/.exec(trimmed);
  assert.ok(m,
    'AD_HEARTBEAT_MS_RAW\'s declaration must be EXACTLY Number(process.env.AD_HEARTBEAT_MS || ' +
    `<literal>) with nothing else in the expression (no trailing "* N" etc). Found: ${rhs.trim()}`);
  const ms = Number(m[1].replace(/_/g, ''));
  // Backend's RESUME_STALE_MIN default is 5 minutes (bootRecoveryService.js).
  // A beat interval anywhere near that defeats the whole mechanism — the
  // steal can fire before even ONE beat has landed. Require comfortably
  // under half: an interval this loose was the exact mutation that reopened
  // the window while every earlier check stayed green.
  assert.ok(ms > 0 && ms <= 90_000,
    `AD_HEARTBEAT_MS_RAW default is ${ms}ms — must stay well under backend's 5min RESUME_STALE_MIN ` +
    '(<=90s) or a slow beat lets recovery fire before protecting the row at all');
});

check('D2 [ANTI-DEAD-CODE] AD_HEARTBEAT_MS is CLAMPED, not merely warned about, if configured too high', () => {
  // A warn-only guard can be silenced by wrapping its condition in dead code
  // (`if (false && ...)`) while the unsafe value still reaches the beat — a
  // presence check on warning TEXT proves nothing about the VALUE actually
  // used. A clamp has no boolean gate to defeat: as long as the Math.min(...)
  // exists in the final assignment, the value used by the beat can never
  // exceed the ceiling, independent of anything wrapped around the log line.
  const finalDecl = constStatement(SRC, 'AD_HEARTBEAT_MS');
  assert.ok(finalDecl, 'could not find the final AD_HEARTBEAT_MS declaration');
  assert.match(finalDecl.replace(/\s+/g, ''), /^Math\.min\(AD_HEARTBEAT_MS_RAW,AD_HEARTBEAT_SAFE_MAX_MS\)$/,
    'AD_HEARTBEAT_MS must be assigned EXACTLY Math.min(AD_HEARTBEAT_MS_RAW, AD_HEARTBEAT_SAFE_MAX_MS) ' +
    '— a value-level clamp, not a conditional warning that can be gated dead');
  assert.match(SRC, /const AD_HEARTBEAT_SAFE_MAX_MS\s*=\s*90_000/,
    'the safe ceiling must be a named constant at 90_000ms');
  assert.match(SRC, /RESUME_STALE_MIN/,
    'the clamp must name the backend constant it is protecting against, so the next reader can ' +
    'find the relationship instead of trusting a bare number');
});

console.log('');
if (failures) {
  console.log(`❌ verifyTitlingHeartbeat: ${failures} FAILED, ${passes} passed`);
  process.exit(1);
}
console.log(`✅ verifyTitlingHeartbeat: all ${passes} checks passed`);
