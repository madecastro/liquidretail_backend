'use strict';
//
// verifyAutomatedRunRequesterLabel — pins two things that shipped together
// 2026-08-24 and must never separate again:
//
// 1. THE REGRESSION FIX. PR #328 hoisted the *bare* `runFeed.startRun({...,
//    requestedBy})` call above the adgen-handoff early `return` in
//    `runRenderLoop` (routes/ads.js), but left the ENRICHMENT that resolves a
//    human `User.displayName` (and used to fire a SECOND, "upgrade" startRun
//    call) below that same return — still reasoning in terms of the OLD
//    two-call design. On the handoff path (the ONLY path now — the flag and
//    its in-process fallback are both deleted, see session.d/) that
//    enrichment was dead code: the parent posted once, to a raw short id or
//    nothing, and was NEVER refreshed.
//    `scripts/verifyRunFeedStartsUnderHandoff.js` already pins "startRun
//    fires before the handoff" — this file's job is the part THAT
//    harness does not cover: that the brand/requester RESOLUTION itself (the
//    `Promise.all`) also precedes both the call and the gate, and that there
//    is now exactly ONE `runFeed.startRun` call in the whole file (a second
//    one reappearing would mean the "post fast now, upgrade unreachably
//    later" shape crept back in).
//
// 2. THE NEW FEATURE. `scripts/mintTestToken.js` (the ui-smoke skill's
//    offline JWT minter) authenticates as a REAL User — a genuine
//    AdvertiserMembership is required to drive the app — so before this
//    change an automated test run was indistinguishable from the owner's own
//    click in the Slack feed: same `requestedBy`, same resolved
//    `User.displayName`. `CampaignRun.automation` (stamped from JWT claims
//    `middleware/requireAuth.js` reads, never inferred from heuristics) lets
//    `routes/ads.js` render `<session> (Claude session)` — or the honest
//    `automated (Claude session)` when no session label was supplied —
//    INSTEAD of the human lookup, never merely beside it.
//
// All checks are structural (real source text via fs.readFileSync — no live
// Mongo, no network, no jwt verification) so this runs instantly offline
// like its siblings. See docs/ALERTING.md "Who ordered the run" / "Automated
// runs" for the prose version of everything asserted here.

const fs = require('fs');
const path = require('path');

const ADS_SRC_PATH   = path.join(__dirname, '..', 'routes', 'ads.js');
const MODEL_PATH      = path.join(__dirname, '..', 'models', 'CampaignRun.js');
const AUTH_PATH       = path.join(__dirname, '..', 'middleware', 'requireAuth.js');
const MINT_PATH       = path.join(__dirname, '..', 'scripts', 'mintTestToken.js');

const adsSrc   = fs.readFileSync(ADS_SRC_PATH, 'utf8');
const modelSrc = fs.readFileSync(MODEL_PATH, 'utf8');
const authSrc  = fs.readFileSync(AUTH_PATH, 'utf8');
const mintSrc  = fs.readFileSync(MINT_PATH, 'utf8');

let failed = 0;
const ok = (name, cond, detail) => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

// Strip comments so prose describing the bug (which names every token this
// file searches for) cannot satisfy or defeat a check.
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const adsStripped   = stripComments(adsSrc);
const modelStripped = stripComments(modelSrc);
const authStripped  = stripComments(authSrc);
const mintStripped  = stripComments(mintSrc);

console.log('verifyAutomatedRunRequesterLabel\n');

// ── A. models/CampaignRun.js declares the automation field ────────────────
// A strict Mongoose schema silently DROPS an undeclared path (the same trap
// that lost renderError.predictionId and Ad.titlingResumeState in this repo
// — see CLAUDE.md §5) — so this must be a real declaration, not merely the
// string "automation" appearing anywhere (e.g. in a comment).
console.log('A. CampaignRun schema declares automation\n');

// Brace-depth extraction, not a lazy regex — `automation: { ... }` has a
// NESTED `{` (isAutomated's own `{ type: Boolean, ... }`), and a naive lazy
// `\{([\s\S]{0,300}?)\}` stops at that first inner `}`, silently truncating
// the block before it ever reaches `sessionLabel`.
function extractBracedBlock(text, anchor) {
  const i = text.indexOf(anchor);
  if (i < 0) return null;
  const open = text.indexOf('{', i);
  if (open < 0) return null;
  let depth = 0;
  for (let j = open; j < text.length; j++) {
    if (text[j] === '{') depth++;
    else if (text[j] === '}') { depth--; if (depth === 0) return text.slice(open, j + 1); }
  }
  return null;
}
const automationBlock = extractBracedBlock(modelStripped, 'automation:') || '';
ok('A1 automation block exists on the schema', !!automationBlock,
   'no `automation: { ... }` block found in models/CampaignRun.js');
ok('A2 automation.isAutomated is declared as Boolean',
   /isAutomated\s*:\s*\{\s*type\s*:\s*Boolean/.test(automationBlock),
   'isAutomated must be a real schema path (type: Boolean), not left undeclared');
ok('A3 automation.isAutomated defaults to false',
   /isAutomated[\s\S]{0,60}default\s*:\s*false/.test(automationBlock),
   'a run must default to NOT automated — an undefaulted/true default would mislabel every human run');
ok('A4 automation.sessionLabel is declared as String',
   /sessionLabel\s*:\s*\{\s*type\s*:\s*String/.test(automationBlock),
   'sessionLabel must be a real schema path (type: String), not left undeclared');
ok('A5 automation.sessionLabel defaults to null',
   /sessionLabel[\s\S]{0,40}default\s*:\s*null/.test(automationBlock),
   'sessionLabel must default to null (honest "unknown"), never a non-null placeholder');

// ── B. middleware/requireAuth.js resolves the JWT claims strictly ─────────
console.log('\nB. requireAuth reads automated/sessionLabel off the JWT\n');

ok('B1 automated is a STRICT boolean comparison (=== true)',
   /payload\.automated\s*===\s*true/.test(authStripped),
   'a loose/truthy check would let a forged non-boolean claim (e.g. the string "true") grant the marker');
ok('B2 sessionLabel is read (typeof guard against a non-string claim)',
   /payload\.sessionLabel/.test(authStripped) && /typeof\s+payload\.sessionLabel\s*===\s*['"]string['"]/.test(authStripped),
   'sessionLabel must be type-checked before use — a non-string JWT claim must not reach req.user.sessionLabel unguarded');
// req.user is built as a single object literal in requireAuth — assert the
// literal itself carries both new keys, not just that the identifiers are
// used somewhere in the file (which a stray unrelated reference could satisfy).
const reqUserMatch = authStripped.match(/req\.user\s*=\s*\{([\s\S]*?)\};/);
const reqUserBlock = reqUserMatch ? reqUserMatch[1] : '';
ok('B3 req.user object literal exists', !!reqUserMatch,
   'could not find `req.user = { ... };` in middleware/requireAuth.js — harness is stale, fix the harness');
// reqUserBlock is already scoped to just the req.user object literal's body
// (see B3), so a bare word-boundary presence check cannot be fooled by an
// unrelated reference elsewhere in the file — it can only be satisfied by
// `automated` / `sessionLabel` appearing as a key (explicit or ES6
// shorthand) inside THIS object.
ok('B4 req.user carries `automated`', /\bautomated\b/.test(reqUserBlock),
   'downstream code (routes/ads.js CampaignRun.create) reads req.user.automated — it must be attached here');
ok('B5 req.user carries `sessionLabel`', /\bsessionLabel\b/.test(reqUserBlock),
   'downstream code reads req.user.sessionLabel — it must be attached here');

// ── C. scripts/mintTestToken.js marks every token it mints ────────────────
console.log('\nC. mintTestToken.js signs the automation claims\n');

const claimsMatch = mintStripped.match(/const\s+claims\s*=\s*\{([\s\S]*?)\};/);
const claimsBlock = claimsMatch ? claimsMatch[1] : '';
ok('C1 claims object exists', !!claimsMatch,
   'could not find `const claims = { ... };` — harness is stale, fix the harness');
ok('C2 automated is signed as the LITERAL true (unconditional — every minted token is a test token)',
   /automated\s*:\s*true\b/.test(claimsBlock),
   'automated must be a literal `true`, not a variable that could be conditionally false for this offline-only minter');
// The claims object may assign sessionLabel a direct expression referencing
// args.sessionLabel, OR (e.g. once a sanitizer is introduced) a bare
// identifier that is itself defined elsewhere in the file from
// args.sessionLabel — check both shapes so a legitimate refactor (extracting
// the value into a named, sanitized variable) does not fail this check.
// [,}] OR end-of-string — sessionLabel may be the LAST property in the
// object literal, in which case the capturing regex above (claimsMatch)
// already excluded the closing `}` from claimsBlock entirely.
const sessionLabelValueMatch = claimsBlock.match(/sessionLabel\s*:\s*([A-Za-z_$][\w$]*)\s*(?:[,}]|$)/);
const sessionLabelIdent = sessionLabelValueMatch ? sessionLabelValueMatch[1] : null;
const sessionLabelDirect = /sessionLabel\s*:[\s\S]{0,80}args\.sessionLabel/.test(claimsBlock);
const sessionLabelViaVar = sessionLabelIdent
  ? new RegExp(`\\b${sessionLabelIdent}\\s*=[\\s\\S]{0,300}?args\\.sessionLabel`).test(mintStripped)
  : false;
ok('C3 sessionLabel is derived from args.sessionLabel, not hardcoded',
   sessionLabelDirect || sessionLabelViaVar,
   'sessionLabel in the signed claims (directly, or via a named variable) must come from the parsed --session-label flag');
ok('C4 --session-label is a recognized CLI flag',
   /['"]--session-label['"]/.test(mintStripped) && /out\.sessionLabel\s*=/.test(mintStripped),
   '--session-label must be parsed into args.sessionLabel the same way other flags (e.g. --brand-id) are');
ok('C5 real Google-login claims (id/userId/email/name/photo) are still present — additive, not a replacement',
   ['id', 'userId', 'email', 'name', 'photo'].every((k) => new RegExp(`\\b${k}\\s*:`).test(claimsBlock)),
   'the automation claims must be ADDITIVE to the real login claim shape (routes/auth.js), never a substitute for it');

// ── D. routes/ads.js: the ordering fix ─────────────────────────────────────
console.log('\nD. runRenderLoop resolves automation/requester BEFORE startRun and the handoff gate\n');

const handoffIdx  = adsStripped.indexOf('ADGEN handoff');
const startRunIdxs = [...adsStripped.matchAll(/runFeed\.startRun\s*\(/g)].map((m) => m.index);
ok('D1 handoff log line found', handoffIdx >= 0,
   'could not find the "ADGEN handoff" log line — this harness is stale, fix the harness');
ok('D2 exactly ONE runFeed.startRun call exists in the whole file',
   startRunIdxs.length === 1,
   `found ${startRunIdxs.length} — a second call reappearing means the "post fast, upgrade ` +
   `unreachably later" shape (the original #328 defect) has crept back in`);

const promiseAllIdx = adsStripped.indexOf('const [brandDoc, humanRequesterLabel] = await Promise.all([');
ok('D3 the brand/requester-label Promise.all resolution is found',
   promiseAllIdx >= 0,
   'could not find the brandDoc/humanRequesterLabel resolution — harness is stale or the resolution was renamed/restructured');

const autoLabelDeclIdx = adsStripped.indexOf('const autoLabel = automatedRunLabel(run);');
ok('D4 autoLabel is computed', autoLabelDeclIdx >= 0,
   'could not find `const autoLabel = automatedRunLabel(run);` — harness is stale, fix the harness');

if (handoffIdx >= 0 && startRunIdxs.length === 1 && promiseAllIdx >= 0 && autoLabelDeclIdx >= 0) {
  const firstStart = startRunIdxs[0];
  // THE CHECKS THIS FILE EXISTS FOR — ordering, not mere presence.
  ok('D5 autoLabel is computed BEFORE the Promise.all (automation must gate the human lookup, not race it)',
     autoLabelDeclIdx < promiseAllIdx,
     `autoLabel@${autoLabelDeclIdx} promiseAll@${promiseAllIdx} — an automated run must already know ` +
     `it is automated before deciding whether to run the human User lookup`);
  ok('D6 the Promise.all resolves BEFORE runFeed.startRun is called',
     promiseAllIdx < firstStart,
     `promiseAll@${promiseAllIdx} startRun@${firstStart} — this is the exact gap PR #328 left open: ` +
     `hoisting the CALL without hoisting the RESOLUTION it depends on`);
  ok('D7 runFeed.startRun fires BEFORE the adgen handoff',
     firstStart < handoffIdx,
     `startRun@${firstStart} handoff@${handoffIdx} — startRun positioned after the handoff ` +
     `means the original #328 defect (posted once, to a raw id, never refreshed) has crept back in`);

  // The single call's payload must actually carry the resolved label, or the
  // ordering fix is cosmetic — the field has to reach the Slack feed.
  const open = adsStripped.indexOf('{', firstStart);
  let depth = 0, callBody = '';
  for (let j = open; j < adsStripped.length; j++) {
    if (adsStripped[j] === '{') depth++;
    else if (adsStripped[j] === '}') { depth--; if (depth === 0) { callBody = adsStripped.slice(open, j + 1); break; } }
  }
  for (const field of ['runId', 'brandId', 'total', 'adIds', 'requesterLabel']) {
    const present = new RegExp(`\\b${field}\\s*(?::|,|\\s*\\})`).test(callBody);
    ok(`D8 the single startRun payload carries ${field}`, present,
       `the resolved value must actually reach the call, not just exist unused earlier in the function`);
  }
}

// ── E. routes/ads.js: automation wins over the human lookup ───────────────
console.log('\nE. automated wins over — never merely supplements — the human displayName lookup\n');

ok('E1 isAutomated is derived from automatedRunLabel(run), the single source of truth for the label string',
   /const\s+isAutomated\s*=\s*autoLabel\s*!==\s*null/.test(adsStripped),
   'isAutomated must be derived from the same function that builds the label, so the two can never disagree');
ok('E2 the human User lookup is SKIPPED (not merely ignored) when automated',
   /isAutomated\s*\?\s*Promise\.resolve\(null\)\s*:/.test(adsStripped),
   'an automated run must not pay for (or risk resolving) a real displayName only to discard it');
ok('E3 the final requesterLabel prefers autoLabel over the human label',
   /const\s+requesterLabel\s*=\s*autoLabel\s*\|\|\s*humanRequesterLabel/.test(adsStripped),
   'automated must WIN, not merely be appended beside a real name — showing both would still read as a real person');

// ── F. automatedRunLabel — the one function that decides the string ───────
console.log('\nF. automatedRunLabel is the single source of the label string\n');

const fnMatch = adsStripped.match(/function\s+automatedRunLabel\s*\(run\)\s*\{([\s\S]{0,300}?)\n\}/);
const fnBody = fnMatch ? fnMatch[1] : '';
ok('F1 automatedRunLabel is declared', !!fnMatch,
   'could not find `function automatedRunLabel(run) { ... }` — harness is stale, fix the harness');
ok('F2 it gates strictly on automation.isAutomated === true',
   /run\?\.automation\?\.isAutomated\s*!==\s*true/.test(fnBody) || /run\?\.automation\?\.isAutomated\s*===\s*true/.test(fnBody),
   'must be a strict boolean check, not a truthy one — an unset/undefined automation object must resolve non-automated');
ok('F3 it returns null for a non-automated run (callers rely on falsy to fall back)',
   /return\s+null/.test(fnBody),
   'callers (E3, and both crash-alert sites in section G) depend on a falsy return to fall through to the human path');
ok('F4 the label text is "<session> (Claude session)" with an honest "automated" fallback',
   /\$\{run\.automation\.sessionLabel\s*\|\|\s*['"]automated['"]\}\s*\(Claude session\)/.test(fnBody),
   'no session label must render as the honest "automated (Claude session)", never a fabricated name');

// ── G. the two crash alerts reuse automatedRunLabel — no extra DB read ────
console.log('\nG. crash alerts (outside runRenderLoop) also distinguish automated runs\n');

const crashAlertCalls = [...adsStripped.matchAll(/by:\s*automatedRunLabel\(run\)\s*\|\|\s*\(run\?\.requestedBy/g)];
ok('G1 both "Campaign run crashed" alerts resolve `by:` via automatedRunLabel first',
   crashAlertCalls.length === 2,
   `found ${crashAlertCalls.length}, expected 2 — these alerts fire on a crash path and must not silently ` +
   `misattribute an automated run's failure to the human account that minted its token`);

console.log('');
if (failed) {
  console.log(`❌ verifyAutomatedRunRequesterLabel: ${failed} FAILED`);
  process.exitCode = 1;
} else {
  console.log('✅ verifyAutomatedRunRequesterLabel: all checks passed');
}
