'use strict';
//
// requireGraph — static project-local require()/path.join(__dirname,…)
// scan used by verifyRequireGraph.js (missing targets) and
// verifyVendorDrift.js (vendored-but-dead). One implementation so a
// fix to "how do we decide a file is referenced" cannot land in one
// harness and miss the other.
//
// NOT AN AST PARSER — same convention as liquidretail_backend's
// scripts/runVerifySuite.js (balanced-paren / balanced-bracket /
// quote-aware scanning, adapted from there). Good enough for the
// require shapes this codebase actually uses; anything genuinely
// dynamic is counted and skipped, never guessed at.
//
const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'dist', 'build']);
const DEFAULT_EXTENSIONS = ['.js', '.mjs'];

function shouldSkipDir(name) {
  if (name === '.' || name === '..') return true;
  if (SKIP_DIRS.has(name)) return true;
  if (name.startsWith('.')) return true;
  return false;
}

function listSourceFiles(rootDir, extensions) {
  const exts = extensions || DEFAULT_EXTENSIONS;
  const out = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name)) continue;
        walk(full);
      } else if (entry.isFile() && exts.some((ext) => entry.name.endsWith(ext) && entry.name.length > ext.length)) {
        out.push(full);
      }
    }
  }
  walk(rootDir);
  return out.sort();
}

function fileExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (e) {
    return false;
  }
}

function dirExists(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (e) {
    return false;
  }
}

function scanBalancedParens(source, openIdx) {
  let depth = 0;
  let inString = null;
  let argsStart = -1;
  for (let i = openIdx; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') { inString = ch; continue; }
    if (ch === '(') { depth++; if (depth === 1) argsStart = i + 1; continue; }
    if (ch === ')') {
      depth--;
      if (depth === 0) return { bodyText: source.slice(argsStart, i), afterIdx: i + 1 };
    }
  }
  return null;
}

function scanBalancedBrackets(source, openIdx) {
  let depth = 0;
  let inString = null;
  let bodyStart = -1;
  for (let i = openIdx; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') { inString = ch; continue; }
    if (ch === '[') { depth++; if (depth === 1) bodyStart = i + 1; continue; }
    if (ch === ']') {
      depth--;
      if (depth === 0) return { bodyText: source.slice(bodyStart, i), afterIdx: i + 1 };
    }
  }
  return null;
}

function splitTopLevelArgs(argsText) {
  const parts = [];
  let depth = 0;
  let inString = null;
  let start = 0;
  for (let i = 0; i < argsText.length; i++) {
    const ch = argsText[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') { inString = ch; continue; }
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) { parts.push(argsText.slice(start, i).trim()); start = i + 1; }
  }
  const last = argsText.slice(start).trim();
  if (last.length) parts.push(last);
  return parts.filter(Boolean);
}

const STRING_LITERAL_RE = /^(['"`])([\s\S]*)\1$/;

function asStaticStringLiteral(exprSrc) {
  const src = exprSrc.trim();
  const lit = STRING_LITERAL_RE.exec(src);
  if (!lit) return null;
  if (/\$\{/.test(lit[2])) return null;
  return lit[2];
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

function extractStringArrayConstants(source) {
  const table = new Map();
  const re = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*\[/g;
  let m;
  while ((m = re.exec(source))) {
    const openIdx = re.lastIndex - 1;
    const scanned = scanBalancedBrackets(source, openIdx);
    if (!scanned) continue;
    const parts = splitTopLevelArgs(scanned.bodyText);
    const literals = [];
    let allLiteral = parts.length > 0;
    for (const part of parts) {
      const lit = asStaticStringLiteral(part);
      if (lit === null) { allLiteral = false; break; }
      literals.push(lit);
    }
    if (allLiteral) table.set(m[1], literals);
  }
  return table;
}

function extractForOfLoopVarSources(source) {
  const table = new Map();
  const re = /\bfor\s*\(\s*const\s+([A-Za-z_$][\w$]*)\s+of\s+([A-Za-z_$][\w$]*)\s*\)/g;
  let m;
  while ((m = re.exec(source))) table.set(m[1], m[2]);
  return table;
}

function isLineCommentAt(source, index) {
  const lineStart = source.lastIndexOf('\n', index - 1) + 1;
  const before = source.slice(lineStart, index);
  let inString = null;
  for (let i = 0; i < before.length; i++) {
    const ch = before[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') { inString = ch; continue; }
    if (ch === '/' && before[i + 1] === '/') return true;
  }
  return false;
}

function findRequireCalls(source) {
  const calls = [];
  const re = /\brequire\s*\(/g;
  let m;
  while ((m = re.exec(source))) {
    if (isLineCommentAt(source, m.index)) continue;
    const openIdx = re.lastIndex - 1;
    const scanned = scanBalancedParens(source, openIdx);
    if (!scanned) continue;
    re.lastIndex = scanned.afterIdx;
    const parts = splitTopLevelArgs(scanned.bodyText);
    if (!parts.length) continue;
    calls.push({ raw: parts[0], line: lineOf(source, m.index) });
  }
  return calls;
}

function findDirnameJoinTargets(source) {
  const targets = [];
  const re = /\bpath\.(join|resolve)\s*\(/g;
  let m;
  while ((m = re.exec(source))) {
    const openIdx = re.lastIndex - 1;
    const scanned = scanBalancedParens(source, openIdx);
    if (!scanned) continue;
    re.lastIndex = scanned.afterIdx;
    const parts = splitTopLevelArgs(scanned.bodyText);
    if (!parts.length || parts[0].trim() !== '__dirname') continue;
    const rest = [];
    let allLiteral = true;
    for (let i = 1; i < parts.length; i++) {
      const lit = asStaticStringLiteral(parts[i]);
      if (lit === null) { allLiteral = false; break; }
      rest.push(lit);
    }
    if (allLiteral && rest.length) targets.push(rest);
  }
  return targets;
}

function resolveRelativeTarget(fromDir, rawTarget) {
  const absNoExt = path.resolve(fromDir, rawTarget);
  for (const suffix of ['', '.js', '.mjs', '.json']) {
    const candidate = absNoExt + suffix;
    if (fileExists(candidate)) return candidate;
  }
  if (dirExists(absNoExt)) {
    for (const idx of ['index.js', 'index.mjs', 'index.json']) {
      const candidate = path.join(absNoExt, idx);
      if (fileExists(candidate)) return candidate;
    }
  }
  return null;
}

function looksLikeModuleExport(source) {
  return /\bmodule\.exports\b/.test(source) || /^\s*exports\./m.test(source) || /^\s*export\s/m.test(source);
}

// Walk srcDir and return the resolved set of files that something in the
// tree actually names via require() or path.join(__dirname, 'lit', …).
function buildProjectRequireGraph(srcDir) {
  const files = listSourceFiles(srcDir);
  const referenced = new Set();
  const requireEdges = [];
  const resolvedEdges = [];
  let unresolvedDynamicCount = 0;
  const unresolvedDynamicSamples = [];

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const arrayConsts = extractStringArrayConstants(source);
    const forOfSources = extractForOfLoopVarSources(source);

    for (const call of findRequireCalls(source)) {
      const literal = asStaticStringLiteral(call.raw);
      if (literal !== null) {
        if (literal.startsWith('.')) requireEdges.push({ file, line: call.line, raw: literal });
        continue;
      }
      const bareIdent = call.raw.trim();
      let arrayIdent = null;
      if (/^[A-Za-z_$][\w$]*$/.test(bareIdent)) {
        if (arrayConsts.has(bareIdent)) arrayIdent = bareIdent;
        else if (forOfSources.has(bareIdent) && arrayConsts.has(forOfSources.get(bareIdent))) {
          arrayIdent = forOfSources.get(bareIdent);
        }
      }
      if (arrayIdent) {
        for (const target of arrayConsts.get(arrayIdent)) {
          if (target.startsWith('.')) requireEdges.push({ file, line: call.line, raw: target, viaConst: arrayIdent });
        }
        continue;
      }
      unresolvedDynamicCount += 1;
      if (unresolvedDynamicSamples.length < 8) {
        unresolvedDynamicSamples.push(`${file}:${call.line} require(${call.raw.slice(0, 60)})`);
      }
    }

    for (const restParts of findDirnameJoinTargets(source)) {
      const resolved = path.resolve(path.dirname(file), ...restParts);
      referenced.add(resolved);
      resolvedEdges.push({ from: file, to: resolved });
    }
  }

  for (const edge of requireEdges) {
    const resolved = resolveRelativeTarget(path.dirname(edge.file), edge.raw);
    if (resolved) {
      referenced.add(resolved);
      resolvedEdges.push({ from: edge.file, to: resolved });
    }
  }

  return {
    files,
    referenced,
    requireEdges,
    resolvedEdges,
    unresolvedDynamicCount,
    unresolvedDynamicSamples,
  };
}

module.exports = {
  SKIP_DIRS,
  DEFAULT_EXTENSIONS,
  listSourceFiles,
  fileExists,
  dirExists,
  resolveRelativeTarget,
  asStaticStringLiteral,
  looksLikeModuleExport,
  buildProjectRequireGraph,
};
