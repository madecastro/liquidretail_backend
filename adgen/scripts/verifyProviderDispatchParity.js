#!/usr/bin/env node
'use strict';
//
// verifyProviderDispatchParity — every VIDEO_PROVIDER reader parses the env
// the same way, renderer has no provider switch of its own, and the router
// fail-closes on unknown AND vertex.
//
// WHY. Mint used to switch in renderer.js (atlas|gemini) while regenerate
// switched in videoRouter.js (atlas|gemini|vertex). Same env, different
// allowed sets — a typo billed Vertex on regen and threw on mint. Collapse
// PR 2 makes the router the only switch; this harness is what stops that
// from silently regressing.
//
// Offline: fs + assert only.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const SVC = path.join(ROOT, 'src', 'services');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n     ${err.message}`); }
}

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

function balanced(text, openIdx, open, close) {
  if (openIdx < 0 || text[openIdx] !== open) return null;
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) { depth--; if (depth === 0) return text.slice(openIdx, i + 1); }
  }
  return null;
}

const PARSE_RE = /String\(\s*process\.env\.VIDEO_PROVIDER\s*\|\|\s*['"]atlas['"]\s*\)\.toLowerCase\(\)/;
const ENV_READ_RE = /process\.env\.VIDEO_PROVIDER/g;

const FILES = {
  'videoRouter.js': fs.readFileSync(path.join(SVC, 'videoRouter.js'), 'utf8'),
  'renderer.js': fs.readFileSync(path.join(SVC, 'renderer.js'), 'utf8'),
  'geminiVideoService.js': fs.readFileSync(path.join(SVC, 'geminiVideoService.js'), 'utf8'),
  'atlasVideoService.js': fs.readFileSync(path.join(SVC, 'atlasVideoService.js'), 'utf8')
};

console.log('verifyProviderDispatchParity\n');

check('A1 videoRouter.activeProvider parses String(x || \'atlas\').toLowerCase()', () => {
  const src = stripComments(FILES['videoRouter.js']);
  assert.match(src,
    /function activeProvider\(\)[\s\S]{0,250}String\(\s*process\.env\.VIDEO_PROVIDER\s*\|\|\s*['"]atlas['"]\s*\)\.toLowerCase\(\)/);
});

check('A2 geminiVideoService.isEnabled uses the same parse', () => {
  const src = stripComments(FILES['geminiVideoService.js']);
  assert.match(src, /function isEnabled\(\)[\s\S]{0,250}String\(\s*process\.env\.VIDEO_PROVIDER\s*\|\|\s*['"]atlas['"]\s*\)\.toLowerCase\(\)/);
});

check('A3 atlasVideoService.enabled uses the same parse (not || \'\')', () => {
  const src = stripComments(FILES['atlasVideoService.js']);
  assert.match(src, /function enabled\(\)[\s\S]{0,250}String\(\s*process\.env\.VIDEO_PROVIDER\s*\|\|\s*['"]atlas['"]\s*\)\.toLowerCase\(\)/);
  assert.ok(!/process\.env\.VIDEO_PROVIDER\s*\|\|\s*['"]['"]/.test(src),
    'atlas enabled() still uses || \'\' — that disagrees with activeProvider() on unset env');
});

check('A4 renderer.js has no process.env.VIDEO_PROVIDER reader and no provider switch', () => {
  const src = stripComments(FILES['renderer.js']);
  assert.ok(!/process\.env\.VIDEO_PROVIDER/.test(src),
    'renderer.js must not read VIDEO_PROVIDER — videoRouter is the only switch');
  assert.ok(!/(?:atlasVideo|geminiVideo)\.generateForAd\(/.test(src),
    'renderer.js must not call a provider-named generateForAd');
  assert.match(src, /videoRouter\.generateForAd\(/,
    'renderer.js mint must call videoRouter.generateForAd');
});

check('A5 every remaining VIDEO_PROVIDER env read uses the same parse', () => {
  for (const [name, raw] of Object.entries(FILES)) {
    if (name === 'renderer.js') continue;
    const src = stripComments(raw);
    const reads = src.match(ENV_READ_RE) || [];
    if (reads.length === 0) continue;
    const parses = src.match(new RegExp(PARSE_RE.source, 'g')) || [];
    assert.ok(parses.length >= 1,
      `${name} reads VIDEO_PROVIDER but does not parse String(x || 'atlas').toLowerCase()`);
  }
});

const router = stripComments(FILES['videoRouter.js']);
const genStart = router.indexOf('async function generateForAd(');
const genOpen = router.indexOf('{', router.indexOf(')', genStart));
const genBody = balanced(router, genOpen, '{', '}');

check('B1 videoRouter.generateForAd body extracted', () => {
  assert.ok(genBody && genBody.length > 200, 'generateForAd body not found');
});

check('B2 unknown provider throws (fail-closed, never a billable default)', () => {
  assert.match(genBody, /else\s*\{[\s\S]{0,600}throw new Error\(/,
    'the else arm must throw');
  assert.ok(!/else\s*\{[\s\S]{0,400}generateForAd\s*\(/.test(genBody),
    'the unknown-provider else arm must not call generateForAd(');
});

check('B3 vertex arm throws (quarantined); no generateForAd( call in that arm', () => {
  const vertexIf = /else if\s*\(\s*provider\s*===\s*['"]vertex['"]\s*\)\s*\{/.exec(genBody);
  assert.ok(vertexIf, 'missing else if (provider === \'vertex\') arm');
  const braceIdx = genBody.indexOf('{', vertexIf.index + vertexIf[0].length - 1);
  const arm = balanced(genBody, braceIdx, '{', '}');
  assert.ok(arm, 'vertex arm unterminated');
  assert.match(arm, /throw new Error\(/);
  assert.ok(!/generateForAd\s*\(/.test(arm),
    'vertex arm must not call generateForAd( — regen used to bill Vertex here');
  assert.match(arm, /quarantined|receipt stamp|CostLog|maxRedirects/);
});

console.log('');
if (failed) {
  console.log(`❌ verifyProviderDispatchParity: ${failed} checks FAILED`);
  process.exit(1);
}
console.log('✅ verifyProviderDispatchParity: all checks passed');
