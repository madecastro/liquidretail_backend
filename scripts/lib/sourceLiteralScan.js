'use strict';
//
// sourceLiteralScan — string/comment-aware helpers for pulling the literal
// key set out of ONE bounded object literal in a source file, without
// requiring the file (renderer.js pulls in a live Mongo connection and
// dozens of vendored services at module load — no benefit to mocking all
// of that just to read one object literal's keys).
//
// DELIBERATELY NARROW, NOT A JS PARSER. This walks characters tracking only
// what it needs to not desync on a stray brace/colon/comma inside a string
// or comment — the exact hazard a naive quote tracker hits on `/regex/`
// literals (this repo has none in the object bodies these helpers are built
// for, so regex literals are not special-cased; do not reuse this against
// source that contains one without adding that case first). Template
// literals are treated as OPAQUE from the first unescaped backtick to the
// next one — `${...}` interpolation is not tokenized — which is safe only
// because the object literals these helpers target (renderer.js's
// $setMaster / $setDerive $set bodies) contain none today. If a future edit
// puts a template literal with its own braces inside one of those objects,
// this scanner needs the interpolation case added, not just a bigger test.
//
// Used by scripts/verifyVideoMasterCloudinaryPublicId.js.

// Advance from `startIdx` (which must point at an opening brace `{`) to the
// index of its matching closing brace, skipping over string/template
// literals and comments so a brace inside one of those cannot desync the
// depth count. Returns the index of the matching `}` in `src`, or -1 if
// `src` ends before the braces balance (malformed input / wrong startIdx).
function findMatchingBrace(src, startIdx) {
  if (src[startIdx] !== '{') {
    throw new Error(`findMatchingBrace: src[${startIdx}] is ${JSON.stringify(src[startIdx])}, not "{"`);
  }
  let depth = 0;
  for (let i = startIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') { depth++; continue; }
    if (ch === '}') { depth--; if (depth === 0) return i; continue; }
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipStringLiteral(src, i, ch);
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
  }
  return -1;
}

// `i` points at the opening quote char `quote`. Returns the index of the
// closing quote (so the caller's for-loop `i++` lands just past it),
// honouring backslash escapes. Template literals (`quote === '`'`) are
// closed the same way — the FIRST unescaped matching backtick — per this
// file's header note on `${}` not being tokenized.
function skipStringLiteral(src, i, quote) {
  let j = i + 1;
  while (j < src.length) {
    if (src[j] === '\\') { j += 2; continue; }
    if (src[j] === quote) return j;
    j++;
  }
  return src.length - 1; // unterminated — let the outer loop end
}

// Given the BODY of an object literal (the text strictly between its outer
// `{` and matching `}`, e.g. from findMatchingBrace above), return the raw
// source substrings of its top-level (depth-0-relative-to-body) comma-
// separated members. A member that is itself `{...}` or `(...)` is walked
// with its own internal brace/string/comment awareness so an inner comma
// never splits it early.
function splitTopLevelMembers(body) {
  const members = [];
  let depth = 0; // counts { and ( together — either nests a member
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipStringLiteral(body, i, ch);
      continue;
    }
    if (ch === '/' && body[i + 1] === '/') {
      const nl = body.indexOf('\n', i);
      i = nl === -1 ? body.length : nl;
      continue;
    }
    if (ch === '/' && body[i + 1] === '*') {
      const end = body.indexOf('*/', i + 2);
      i = end === -1 ? body.length : end + 1;
      continue;
    }
    if (ch === '{' || ch === '(' || ch === '[') { depth++; continue; }
    if (ch === '}' || ch === ')' || ch === ']') { depth--; continue; }
    if (ch === ',' && depth === 0) {
      members.push(body.slice(start, i));
      start = i + 1;
    }
  }
  const tail = body.slice(start);
  if (tail.trim().length) members.push(tail);
  return members;
}

// Extracts the top-level key name from one member string, or null when the
// member is a spread (`...expr`) rather than a `key: value` pair — spreads
// are deliberately NOT expanded (see the verify script's header on why
// depth-0 exclusion is exactly the right cut for $setMaster's ternary
// spread arms, which are covered by a different harness).
const KEY_RE = /^\s*(?:([A-Za-z_$][A-Za-z0-9_$]*)|'([^']*)'|"([^"]*)")\s*:/;
function memberTopLevelKey(member) {
  const trimmed = member.replace(/^\s*\/\/[^\n]*\n/, '').trimStart();
  if (trimmed.startsWith('...')) return null;
  const m = KEY_RE.exec(trimmed);
  if (!m) return null;
  return m[1] || m[2] || m[3];
}

// Top-level convenience: find `declRegex` in `src` (must match up to and
// including the opening `{`), then return { keys, bodyStart, bodyEnd } —
// keys is the array of top-level (depth-0) key names in that object
// literal, spreads excluded.
function extractTopLevelKeysAfter(src, declRegex) {
  const m = declRegex.exec(src);
  if (!m) return null;
  const braceIdx = m.index + m[0].length - 1; // declRegex must end on "{"
  if (src[braceIdx] !== '{') {
    throw new Error(`extractTopLevelKeysAfter: declRegex ${declRegex} must end its match on "{"`);
  }
  const closeIdx = findMatchingBrace(src, braceIdx);
  if (closeIdx === -1) return null;
  const body = src.slice(braceIdx + 1, closeIdx);
  const keys = splitTopLevelMembers(body)
    .map(memberTopLevelKey)
    .filter((k) => k !== null);
  return { keys, bodyStart: braceIdx, bodyEnd: closeIdx };
}

module.exports = {
  findMatchingBrace,
  splitTopLevelMembers,
  memberTopLevelKey,
  extractTopLevelKeysAfter
};
