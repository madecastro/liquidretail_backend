'use strict';
//
// vendorDrift — discover path-corresponding vendored files, hash the
// backend blob they were last reconciled against, and find vendored
// service modules that nothing in src/ requires.
//
// Mechanism only. Policy (pass/fail, seed reasons, historical probes)
// lives in scripts/verifyVendorDrift.js.
//
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildProjectRequireGraph, looksLikeModuleExport } = require('./requireGraph');

const MANIFEST_VERSION = 1;
const STATUSES = new Set(['synced', 'fork', 'unused']);
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function posixRel(from, to) {
  return path.relative(from, to).split(path.sep).join('/');
}

function isGitRepo(dir) {
  try {
    const st = fs.lstatSync(path.join(dir, '.git'));
    return st.isDirectory() || st.isFile();
  } catch (e) {
    return false;
  }
}

function gitEnv() {
  // git -C must win. Inherited GIT_DIR/GIT_WORK_TREE (hooks, rebase --exec)
  // point at THIS repo and make `git -C $backend show origin/main:…` miss.
  const env = Object.assign({}, process.env);
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_INDEX_FILE;
  return env;
}

function runGit(repo, args, encoding) {
  return spawnSync('git', ['-C', repo, ...args], {
    encoding: encoding || 'buffer',
    maxBuffer: GIT_MAX_BUFFER,
    env: gitEnv(),
  });
}

const _gitStringCache = new Map();
const _gitBufferCache = new Map();

function cacheKey(repo, args) {
  return `${repo}\0${args.join('\0')}`;
}

function gitStdoutString(repo, args) {
  const key = cacheKey(repo, args);
  if (_gitStringCache.has(key)) return _gitStringCache.get(key);
  const r = runGit(repo, args, 'utf8');
  const val = r.status !== 0 ? null : String(r.stdout || '').trim();
  _gitStringCache.set(key, val);
  return val;
}

function gitStdoutBuffer(repo, args) {
  const key = cacheKey(repo, args);
  if (_gitBufferCache.has(key)) return _gitBufferCache.get(key);
  const r = runGit(repo, args, 'buffer');
  const val = r.status !== 0 ? null : r.stdout;
  _gitBufferCache.set(key, val);
  return val;
}

function revExists(repo, spec) {
  const r = runGit(repo, ['rev-parse', '--verify', spec], 'utf8');
  return r.status === 0;
}

// Prefer a remote-tracking trunk so a dirty/feature-branch working tree
// cannot masquerade as "what backend has shipped". Override with
// ADGEN_BACKEND_REF (a sha, a branch, or origin/main).
function resolveBackendRef(backendRoot) {
  if (process.env.ADGEN_BACKEND_REF) return process.env.ADGEN_BACKEND_REF;
  if (!isGitRepo(backendRoot)) return null;
  if (revExists(backendRoot, 'origin/main')) return 'origin/main';
  if (revExists(backendRoot, 'origin/master')) return 'origin/master';
  if (revExists(backendRoot, 'HEAD')) return 'HEAD';
  return null;
}

function resolveRefSha(backendRoot, ref) {
  if (!ref || !isGitRepo(backendRoot)) return null;
  return gitStdoutString(backendRoot, ['rev-parse', ref]);
}

function lastTouchSha(backendRoot, ref, relPath) {
  if (!ref || !isGitRepo(backendRoot)) return null;
  return gitStdoutString(backendRoot, ['log', '-1', '--format=%H', ref, '--', relPath]);
}

function readBackendBlob(backendRoot, ref, relPath) {
  if (ref && isGitRepo(backendRoot)) {
    const blob = gitStdoutBuffer(backendRoot, ['show', `${ref}:${relPath}`]);
    if (blob) return { bytes: blob, source: 'ref' };
    return null;
  }
  const abs = path.join(backendRoot, relPath);
  try {
    return { bytes: fs.readFileSync(abs), source: 'worktree' };
  } catch (e) {
    return null;
  }
}

function walkAllFiles(rootDir) {
  const skip = new Set(['node_modules', '.git', 'coverage', 'dist', 'build']);
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
        if (entry.name === '.' || entry.name === '..') continue;
        if (skip.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(full);
      } else if (!entry.name.startsWith('.')) {
        let st;
        try { st = fs.statSync(full); } catch (e) { continue; }
        if (st.isFile()) out.push(full);
      }
    }
  }
  walk(rootDir);
  return out.sort();
}

function isServiceJs(rel) {
  return rel.startsWith('services/') && /\.(js|mjs)$/.test(rel);
}

function discoverVendored(adgenRoot, backendRoot, ref, opts) {
  const includeSha = !opts || opts.includeSha !== false;
  const srcDir = path.join(adgenRoot, 'src');
  const out = [];
  if (!backendRoot) return out;
  for (const abs of walkAllFiles(srcDir)) {
    const rel = posixRel(srcDir, abs);
    const blob = readBackendBlob(backendRoot, ref, rel);
    if (!blob) continue;
    const adgenBytes = fs.readFileSync(abs);
    out.push({
      rel,
      adgenAbs: abs,
      backendHash: sha256Hex(blob.bytes),
      backendSha: includeSha ? lastTouchSha(backendRoot, ref, rel) : null,
      identical: Buffer.compare(adgenBytes, blob.bytes) === 0,
      source: blob.source,
    });
  }
  return out;
}

function loadManifest(manifestPath) {
  let raw;
  try {
    raw = fs.readFileSync(manifestPath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') throw new Error('vendor-manifest.json is not an object');
  if (parsed.version !== MANIFEST_VERSION) {
    throw new Error(`vendor-manifest.json version ${parsed.version} != ${MANIFEST_VERSION}`);
  }
  if (!parsed.files || typeof parsed.files !== 'object' || Array.isArray(parsed.files)) {
    throw new Error('vendor-manifest.json missing files object');
  }
  return parsed;
}

function normalizeEntry(rel, entry) {
  if (!entry || typeof entry !== 'object') {
    throw new Error(`manifest entry for ${rel} is not an object`);
  }
  if (typeof entry.backendHash !== 'string' || !/^[0-9a-f]{64}$/.test(entry.backendHash)) {
    throw new Error(`manifest entry for ${rel} has invalid backendHash`);
  }
  const status = entry.status || 'synced';
  if (!STATUSES.has(status)) {
    throw new Error(`manifest entry for ${rel} has invalid status ${status}`);
  }
  if ((status === 'fork' || status === 'unused') && !String(entry.reason || '').trim()) {
    throw new Error(`manifest entry for ${rel} is ${status} but has no reason`);
  }
  return {
    backendHash: entry.backendHash,
    backendSha: entry.backendSha || null,
    status,
    reason: entry.reason ? String(entry.reason) : undefined,
  };
}

function sortManifest(manifest) {
  const files = {};
  const keys = Object.keys(manifest.files).sort();
  for (const k of keys) files[k] = manifest.files[k];
  return Object.assign({}, manifest, { files });
}

function saveManifest(manifestPath, manifest) {
  const sorted = sortManifest(manifest);
  fs.writeFileSync(manifestPath, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
}

function reachableFrom(roots, resolvedEdges) {
  const byFrom = new Map();
  for (const e of resolvedEdges) {
    if (!e || !e.from || !e.to) continue;
    if (!byFrom.has(e.from)) byFrom.set(e.from, []);
    byFrom.get(e.from).push(e.to);
  }
  const seen = new Set();
  const stack = roots.slice();
  while (stack.length) {
    const n = stack.pop();
    if (seen.has(n)) continue;
    seen.add(n);
    const next = byFrom.get(n);
    if (next) for (let i = 0; i < next.length; i++) stack.push(next[i]);
  }
  return seen;
}

function findDeadServices({ adgenRoot, vendoredRels, unusedSet }) {
  const srcDir = path.join(adgenRoot, 'src');
  const graph = buildProjectRequireGraph(srcDir);
  const vendoredAbs = new Set();
  for (const rel of vendoredRels) vendoredAbs.add(path.join(srcDir, rel));
  // Live roots = adgen-owned files (entrypoint, renderer, orchestrator, …).
  // A module only required from another unused vendored file is still dead
  // — campaignRunHeartbeat's shape, one hop further.
  const roots = graph.files.filter((f) => !vendoredAbs.has(f));
  const reached = reachableFrom(roots, graph.resolvedEdges || []);
  const dead = [];
  for (const rel of vendoredRels) {
    if (!isServiceJs(rel)) continue;
    if (unusedSet.has(rel)) continue;
    const abs = path.join(srcDir, rel);
    let source;
    try {
      source = fs.readFileSync(abs, 'utf8');
    } catch (e) {
      continue;
    }
    if (!looksLikeModuleExport(source)) continue;
    if (reached.has(abs)) continue;
    dead.push(rel);
  }
  return { dead: dead.sort(), graph };
}

function analyze({ adgenRoot, manifest, backendRoot, includeSha }) {
  const backendRef = backendRoot ? resolveBackendRef(backendRoot) : null;
  const backendHead = backendRoot && backendRef ? resolveRefSha(backendRoot, backendRef) : null;
  const workingTreeHead = backendRoot && isGitRepo(backendRoot) ? resolveRefSha(backendRoot, 'HEAD') : null;
  const manifestFiles = (manifest && manifest.files) || {};
  const manifestRels = new Set(Object.keys(manifestFiles));

  const report = {
    backendRoot: backendRoot || null,
    backendRef,
    backendHead,
    workingTreeHead,
    backendAbsent: !backendRoot,
    skippedDrift: null,
    vendored: [],
    drift: [],
    untracked: [],
    stale: [],
    dead: [],
    forksHeld: [],
    identicalCount: 0,
    divergentCount: 0,
    graph: null,
  };

  let discovered = [];
  if (!backendRoot) {
    report.skippedDrift = 'sibling liquidretail_backend not found (ADGEN_BACKEND_PATH or ../liquidretail_backend) — drift skipped, dead-module check still runs against the manifest';
    discovered = [...manifestRels].map((rel) => ({
      rel,
      adgenAbs: path.join(adgenRoot, 'src', rel),
      backendHash: manifestFiles[rel] && manifestFiles[rel].backendHash,
      backendSha: manifestFiles[rel] && manifestFiles[rel].backendSha,
      identical: null,
      source: 'manifest',
    }));
  } else {
    discovered = discoverVendored(adgenRoot, backendRoot, backendRef, { includeSha: includeSha === true });
    if (!backendRef) {
      report.skippedDrift = null;
      report.worktreeFallback = true;
    }
  }

  report.vendored = discovered;
  const discoveredRels = new Set(discovered.map((v) => v.rel));

  for (const v of discovered) {
    if (v.identical === true) report.identicalCount += 1;
    if (v.identical === false) report.divergentCount += 1;
    if (!manifestRels.has(v.rel)) {
      report.untracked.push(v);
      continue;
    }
    if (report.backendAbsent) continue;
    const entry = normalizeEntry(v.rel, manifestFiles[v.rel]);
    if (entry.backendHash !== v.backendHash) {
      if (!v.backendSha) v.backendSha = lastTouchSha(backendRoot, backendRef, v.rel);
      report.drift.push({ rel: v.rel, recorded: entry, current: v });
    } else if (entry.status === 'fork') {
      report.forksHeld.push({ rel: v.rel, reason: entry.reason });
    }
  }

  if (!report.backendAbsent) {
    for (const rel of manifestRels) {
      if (!discoveredRels.has(rel)) report.stale.push(rel);
    }
  }

  const unusedSet = new Set();
  for (const rel of (report.backendAbsent ? manifestRels : discoveredRels)) {
    const entry = manifestFiles[rel];
    if (entry && entry.status === 'unused') unusedSet.add(rel);
  }
  const deadScanRels = report.backendAbsent ? [...manifestRels] : [...discoveredRels];
  const deadResult = findDeadServices({
    adgenRoot,
    vendoredRels: deadScanRels,
    unusedSet,
  });
  report.dead = deadResult.dead;
  report.graph = deadResult.graph;
  return report;
}

function makeEntry(v, status, reason) {
  const entry = {
    backendHash: v.backendHash,
    backendSha: v.backendSha || null,
    status,
  };
  if (reason) entry.reason = reason;
  return entry;
}

module.exports = {
  MANIFEST_VERSION,
  STATUSES,
  sha256Hex,
  posixRel,
  isGitRepo,
  resolveBackendRef,
  resolveRefSha,
  lastTouchSha,
  readBackendBlob,
  walkAllFiles,
  isServiceJs,
  discoverVendored,
  loadManifest,
  normalizeEntry,
  sortManifest,
  saveManifest,
  findDeadServices,
  analyze,
  makeEntry,
};
