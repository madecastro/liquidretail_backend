#!/usr/bin/env node
'use strict';
//
// verifyGeminiVideoKey — pins the dedicated Gemini VIDEO key slot.
//
// GEMINI_VIDEO_API_KEY is a quota-isolation slot for the forthcoming
// geminiVideoService. Until a distinct key is supplied it must fall back
// to GEMINI_API_KEY, so same-value-today is a no-op. This harness is
// offline: no DB, no network, no real API key.
//
//   node scripts/verifyGeminiVideoKey.js

const fs = require('fs');
const path = require('path');
const { resolveBackendRoot } = require('./lib/siblingBackend');

const ROOT = path.resolve(__dirname, '..');
const DEFAULTS_ENV = path.join(ROOT, 'config', 'defaults.env');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond === true) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const defaultsEnv = fs.readFileSync(DEFAULTS_ENV, 'utf8');

// Comments that document THIS key live in the blank/comment run immediately
// above `GEMINI_VIDEO_API_KEY=` and end at the next `KEY=` assignment.
// Scanning the whole file lets "quota isolation" satisfy A3 from the
// TITLE_FACE_KEEPOUT section (mutation-tested).
function envKeyBlock(text, key) {
  const lines = String(text || '').split('\n');
  const idx = lines.findIndex((l) => l === `${key}=` || l.startsWith(`${key}=`));
  if (idx < 0) return '';
  let start = idx;
  while (start > 0) {
    const prev = lines[start - 1];
    if (/^[A-Z][A-Z0-9_]*=/.test(prev)) break;
    start -= 1;
  }
  let end = idx + 1;
  while (end < lines.length) {
    if (/^[A-Z][A-Z0-9_]*=/.test(lines[end])) break;
    end += 1;
  }
  return lines.slice(start, end).join('\n');
}
const geminiVideoKeyBlock = envKeyBlock(defaultsEnv, 'GEMINI_VIDEO_API_KEY');

check('A1: config/defaults.env declares GEMINI_VIDEO_API_KEY= (empty)',
  /^GEMINI_VIDEO_API_KEY=$/m.test(defaultsEnv));
check('A2: comment states fallback to GEMINI_API_KEY',
  /falls?\s+back to GEMINI_API_KEY/.test(geminiVideoKeyBlock));
check('A3: comment states quota isolation from grounded-search traffic',
  /quota isolation/i.test(geminiVideoKeyBlock) && /grounded-search/i.test(geminiVideoKeyBlock));
check('A4: comment states the secret lives in the Render dashboard, never this file',
  /Render dashboard/i.test(geminiVideoKeyBlock) && /never in this file/i.test(geminiVideoKeyBlock));
check('A5: GEMINI_VIDEO_API_KEY is not given a committed secret value',
  !/^GEMINI_VIDEO_API_KEY=./m.test(defaultsEnv));

const savedVideo = process.env.GEMINI_VIDEO_API_KEY;
const savedGemini = process.env.GEMINI_API_KEY;
function restoreEnv() {
  if (savedVideo === undefined) delete process.env.GEMINI_VIDEO_API_KEY;
  else process.env.GEMINI_VIDEO_API_KEY = savedVideo;
  if (savedGemini === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = savedGemini;
}

const {
  VIDEO_KEY_ENV,
  FALLBACK_KEY_ENV,
  fingerprintKey,
  resolveGeminiVideoApiKey
} = require(path.join(ROOT, 'src', 'services', 'geminiVideoKey.js'));

check('B1: env names are the contracted strings',
  VIDEO_KEY_ENV === 'GEMINI_VIDEO_API_KEY' && FALLBACK_KEY_ENV === 'GEMINI_API_KEY');

const VIDEO = 'video-slot-key-XXXX';
const FALLBACK = 'fallback-slot-key-YYYY';
check('B2: fingerprint is last 4 chars, never the whole key',
  fingerprintKey(VIDEO) === 'XXXX' && fingerprintKey(FALLBACK) === 'YYYY' &&
  fingerprintKey(VIDEO) !== VIDEO);
check('B3: fingerprint of a short key is <too short>, not the material',
  fingerprintKey('ab') === '<too short>');
check('B4: fingerprint of empty/null is null',
  fingerprintKey('') === null && fingerprintKey(null) === null);

function captureResolve(env) {
  const logs = [];
  const orig = console.log;
  console.log = (msg) => { logs.push(String(msg)); };
  const prevV = process.env.GEMINI_VIDEO_API_KEY;
  const prevG = process.env.GEMINI_API_KEY;
  try {
    if (env.video === undefined) delete process.env.GEMINI_VIDEO_API_KEY;
    else process.env.GEMINI_VIDEO_API_KEY = env.video;
    if (env.fallback === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = env.fallback;
    const result = resolveGeminiVideoApiKey({ log: true });
    return { result, logs };
  } finally {
    console.log = orig;
    if (prevV === undefined) delete process.env.GEMINI_VIDEO_API_KEY;
    else process.env.GEMINI_VIDEO_API_KEY = prevV;
    if (prevG === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevG;
  }
}

function logsLeak(logs, ...secrets) {
  const blob = logs.join('\n');
  return secrets.some((s) => s && blob.includes(s));
}

{
  const { result, logs } = captureResolve({ video: undefined, fallback: FALLBACK });
  check('C1: unset GEMINI_VIDEO_API_KEY falls back to GEMINI_API_KEY',
    result.slot === 'GEMINI_API_KEY' && result.apiKey === FALLBACK);
  check('C2: fallback log names the fallback slot and last-4 fp, not the key',
    logs.some((l) => l === `gemini video key: falling back to GEMINI_API_KEY fp=YYYY len=${FALLBACK.length}`) &&
    !logsLeak(logs, FALLBACK));
}

{
  const { result, logs } = captureResolve({ video: '', fallback: FALLBACK });
  check('C3: empty GEMINI_VIDEO_API_KEY falls back (same as unset)',
    result.slot === 'GEMINI_API_KEY' && result.apiKey === FALLBACK);
  check('C4: empty-slot log is the fallback line, key not present',
    logs.some((l) => /falling back to GEMINI_API_KEY fp=YYYY/.test(l)) &&
    !logsLeak(logs, FALLBACK));
}

{
  const { result, logs } = captureResolve({ video: '   ', fallback: FALLBACK });
  check('C5: whitespace-only GEMINI_VIDEO_API_KEY falls back',
    result.slot === 'GEMINI_API_KEY' && result.apiKey === FALLBACK &&
    !logsLeak(logs, FALLBACK));
}

{
  const { result, logs } = captureResolve({ video: `"${VIDEO}"`, fallback: FALLBACK });
  check('C6: quoted GEMINI_VIDEO_API_KEY is stripped and wins over fallback',
    result.slot === 'GEMINI_VIDEO_API_KEY' && result.apiKey === VIDEO);
  check('C7: dedicated-slot log names GEMINI_VIDEO_API_KEY + last-4 fp, not either key',
    logs.some((l) => l === `gemini video key: GEMINI_VIDEO_API_KEY fp=XXXX len=${VIDEO.length}`) &&
    !logsLeak(logs, VIDEO, FALLBACK));
}

{
  const { result, logs } = captureResolve({ video: VIDEO, fallback: FALLBACK });
  check('C8: set GEMINI_VIDEO_API_KEY wins even when GEMINI_API_KEY is also set',
    result.slot === 'GEMINI_VIDEO_API_KEY' && result.apiKey === VIDEO &&
    result.fingerprint === 'XXXX' && !logsLeak(logs, VIDEO, FALLBACK));
}

{
  const { result, logs } = captureResolve({ video: undefined, fallback: undefined });
  check('C9: neither key → empty apiKey, null slot, NOT SET log, no material',
    result.apiKey === '' && result.slot === null &&
    logs.some((l) => l === 'gemini video key: NOT SET (neither GEMINI_VIDEO_API_KEY nor GEMINI_API_KEY)'));
}

{
  // Same-value-today: dedicated slot populated with the same bytes as the
  // fallback. Behaviour is the same credential; the log must still name
  // GEMINI_VIDEO_API_KEY so an operator can see the slot is live.
  const { result, logs } = captureResolve({ video: FALLBACK, fallback: FALLBACK });
  check('C10: same-value dedicated slot reports GEMINI_VIDEO_API_KEY, not fallback',
    result.slot === 'GEMINI_VIDEO_API_KEY' && result.apiKey === FALLBACK &&
    logs.some((l) => /^gemini video key: GEMINI_VIDEO_API_KEY fp=YYYY/.test(l)) &&
    !logs.some((l) => /falling back/.test(l)) &&
    !logsLeak(logs, FALLBACK));
}

const backendRoot = resolveBackendRoot(ROOT);
if (backendRoot) {
  const backendDefaults = fs.readFileSync(path.join(backendRoot, 'config', 'defaults.env'), 'utf8');
  check('D1: sibling backend config/defaults.env also declares GEMINI_VIDEO_API_KEY= (empty)',
    /^GEMINI_VIDEO_API_KEY=$/m.test(backendDefaults));
  check('D2: sibling backend comment states fallback + quota isolation + Render dashboard',
    /falls?\s+back to GEMINI_API_KEY/.test(backendDefaults) &&
    /quota isolation/i.test(backendDefaults) &&
    /Render dashboard/i.test(backendDefaults) &&
    !/^GEMINI_VIDEO_API_KEY=./m.test(backendDefaults));
} else {
  console.log('INFO: sibling liquidretail_backend not checked out — skipping D1/D2');
}

restoreEnv();

console.log(`\nverifyGeminiVideoKey: ${pass} pass, ${failures.length} fail`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('\n✅ GEMINI_VIDEO_API_KEY slot falls back, fingerprints last-4, never logs the key.');
