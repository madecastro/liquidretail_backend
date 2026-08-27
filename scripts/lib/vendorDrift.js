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

// v2 (2026-08-27) added `adgenHash` on every entry and the `unported`
// status. Both exist to close holes v1 had by construction:
//
//   * adgenHash — v1 recorded ONLY the backend blob's hash, so every
//     cross-repo check needed the sibling backend checkout to say anything
//     at all. In GitHub Actions that sibling does not exist, so all four of
//     verifyVendorDrift's cross-repo checks skipped with an INFO and exit 0
//     — the manifest had real teeth on a dev machine and none in CI.
//     Recording adgen's OWN bytes makes "did this vendored file change
//     without anyone re-attesting the pairing?" answerable with nothing but
//     this repo, which is exactly what CI has.
//
//   * unported — v1 had one bucket, `fork`, for two different things: "adgen
//     deliberately owns a different shape here, forever" and "a fix landed
//     on one side and the other side still owes it". The second is a DEBT
//     with a counterparty, and v1 recorded it as free-text prose in
//     `reason` that nothing could act on. veoPromptBuilder.js sat as
//     status=fork with a reason reading "a human must apply the same edit in
//     liquidretail_backend" — true, unactioned, and permanently green.
//
const MANIFEST_VERSION = 2;
const STATUSES = new Set(['synced', 'fork', 'unported', 'unused']);
const PORT_TARGETS = new Set(['backend', 'adgen']);
// How long an unported obligation may sit before it fails the suite.
// Deliberately generous — the point is not to rush a port, it is to make
// the debt impossible to forget. Override with ADGEN_UNPORTED_GRACE_DAYS.
const UNPORTED_GRACE_DAYS_DEFAULT = 14;
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
      // adgen's OWN bytes, right now. Recorded in the manifest so the
      // "has anyone looked?" question survives the backend being absent.
      adgenHash: sha256Hex(adgenBytes),
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
  if (typeof entry.adgenHash !== 'string' || !/^[0-9a-f]{64}$/.test(entry.adgenHash)) {
    throw new Error(
      `manifest entry for ${rel} has invalid or missing adgenHash (manifest v${MANIFEST_VERSION} ` +
      `requires it — re-seed with: node scripts/verifyVendorDrift.js --seed)`
    );
  }
  const status = entry.status || 'synced';
  if (!STATUSES.has(status)) {
    throw new Error(`manifest entry for ${rel} has invalid status ${status}`);
  }
  if (status !== 'synced' && !String(entry.reason || '').trim()) {
    throw new Error(`manifest entry for ${rel} is ${status} but has no reason`);
  }
  // `unported` is a DEBT, so it carries a counterparty and a clock. Without
  // both it degrades into exactly the free-text `fork` reason it replaced.
  if (status === 'unported') {
    if (!PORT_TARGETS.has(entry.portTo)) {
      throw new Error(
        `manifest entry for ${rel} is unported but portTo is ${JSON.stringify(entry.portTo)} — ` +
        `must be one of ${[...PORT_TARGETS].join('|')} (which repo OWES the port)`
      );
    }
    const owed = Date.parse(entry.owedSince || '');
    if (!Number.isFinite(owed)) {
      throw new Error(
        `manifest entry for ${rel} is unported but owedSince is not a parseable date ` +
        `(${JSON.stringify(entry.owedSince)}) — an obligation with no clock never comes due`
      );
    }
  }
  return {
    backendHash: entry.backendHash,
    adgenHash: entry.adgenHash,
    backendSha: entry.backendSha || null,
    status,
    reason: entry.reason ? String(entry.reason) : undefined,
    portTo: entry.portTo || null,
    owedSince: entry.owedSince || null,
  };
}

function unportedGraceDays() {
  const raw = parseInt(process.env.ADGEN_UNPORTED_GRACE_DAYS, 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : UNPORTED_GRACE_DAYS_DEFAULT;
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
    adgenDrift: [],        // adgen's own bytes moved since the last look
    adgenMissing: [],      // tracked path is gone from adgen src/
    unportedOverdue: [],   // an owed port past its grace window
    unportedHeld: [],      // an owed port still inside its grace window
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
    report.skippedDrift = 'sibling liquidretail_backend not found (ADGEN_BACKEND_PATH or ../liquidretail_backend) — BACKEND-side drift skipped; the adgen-side hash check, the unported-obligation check and the dead-module check all still run with full teeth';
    // adgenHash is still computed from DISK here, not copied from the
    // manifest. That is the entire point of v2: the adgen-side check must
    // work in a clone that has only this repo (i.e. in CI), so it can
    // never be satisfied by reading back the value it is meant to verify.
    discovered = [...manifestRels].map((rel) => {
      const abs = path.join(adgenRoot, 'src', rel);
      let adgenHash = null;
      try {
        adgenHash = sha256Hex(fs.readFileSync(abs));
      } catch (e) {
        adgenHash = null;   // missing on disk — surfaces as adgenMissing below
      }
      return {
        rel,
        adgenAbs: abs,
        backendHash: manifestFiles[rel] && manifestFiles[rel].backendHash,
        adgenHash,
        backendSha: manifestFiles[rel] && manifestFiles[rel].backendSha,
        identical: null,
        source: 'manifest',
      };
    });
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
    const entry = normalizeEntry(v.rel, manifestFiles[v.rel]);

    // ── ADGEN SIDE — runs whether or not the backend is checked out ────
    if (v.adgenHash == null) {
      report.adgenMissing.push({ rel: v.rel, recorded: entry });
    } else if (entry.adgenHash !== v.adgenHash) {
      report.adgenDrift.push({ rel: v.rel, recorded: entry, current: v });
    }

    // An owed port comes due on a wall clock, not on a file change, so
    // this is evaluated backend-absent too.
    if (entry.status === 'unported') {
      const ageDays = (Date.now() - Date.parse(entry.owedSince)) / 86400000;
      const grace = unportedGraceDays();
      const item = { rel: v.rel, recorded: entry, ageDays, graceDays: grace };
      if (ageDays > grace) report.unportedOverdue.push(item);
      else report.unportedHeld.push(item);
    }

    // ── BACKEND SIDE — needs the sibling checkout ─────────────────────
    if (report.backendAbsent) continue;
    if (entry.backendHash !== v.backendHash) {
      if (!v.backendSha) v.backendSha = lastTouchSha(backendRoot, backendRef, v.rel);
      report.drift.push({ rel: v.rel, recorded: entry, current: v });
    } else if (entry.status === 'fork' || entry.status === 'unported') {
      report.forksHeld.push({ rel: v.rel, status: entry.status, reason: entry.reason });
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

function makeEntry(v, status, reason, extra) {
  const entry = {
    backendHash: v.backendHash,
    adgenHash: v.adgenHash,
    backendSha: v.backendSha || null,
    status,
  };
  if (reason) entry.reason = reason;
  if (status === 'unported') {
    entry.portTo = (extra && extra.portTo) || null;
    // Preserve an existing owedSince across a re-attest — re-reconciling an
    // unported file must NOT silently reset its clock, or the grace window
    // becomes infinitely extendable by rerunning the command.
    entry.owedSince = (extra && extra.owedSince) || new Date().toISOString();
  }
  return entry;
}

module.exports = {
  MANIFEST_VERSION,
  STATUSES,
  PORT_TARGETS,
  UNPORTED_GRACE_DAYS_DEFAULT,
  unportedGraceDays,
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
