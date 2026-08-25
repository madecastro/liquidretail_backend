#!/usr/bin/env node
'use strict';
//
// verifyModelParity — adgen vendors copies of liquidretail_backend's
// Mongoose models (33 of them today), and BOTH services write the SAME
// production database (ADGEN_RENDERER_ENABLED=true is the permanent live
// state — see README.md). A schema drift between the two copies is a live
// data-corruption risk: if adgen's copy of a model declares a field the
// backend's copy does not, one service can write a document shape the
// other silently cannot see (Mongoose strict mode drops writes to
// undeclared paths with no error — liquidretail_backend/CLAUDE.md §4
// already recorded a real production loss this exact way,
// renderError.predictionId).
//
// RULE CHOSEN, STATED EXPLICITLY (the task that created this file asked
// for this decision to be recorded, not just made): SUBSET, not full
// parity. adgen asserts
//
//     adgen's top-level schema paths ⊆ backend's top-level schema paths
//
// for every model that exists in both trees — never full equality. adgen
// is a narrower render-only service; the backend legitimately owns more
// surface area (auth, billing, scraping, …) and will keep growing fields
// adgen has no reason to vendor. Requiring exact parity would fail on every
// such legitimate backend-only addition and pressure someone into copying
// fields adgen never reads just to keep this harness green — a worse
// outcome than the drift it exists to catch. The dangerous direction is the
// other one: adgen inventing a field the backend's copy of the SAME model
// lacks, which means the two processes now disagree about what a document
// of that collection can contain. That is FAIL. A backend-only field is
// reported as INFO (informational — not vendored into adgen, which may be
// entirely intentional) and never fails the build.
//
// MECHANISM — each model is REQUIRED for real, not regex-parsed. A source-
// text scan of `{ field: {...} }` object literals cannot reliably handle
// nested braces, enum arrays, commented-out fields, or computed keys across
// 33 files this size (Ad.js alone is 90+ top-level fields with deeply
// nested Mixed/subdocument blocks) — Mongoose has already done that parsing
// correctly the moment the file is required. mongoose.model() is
// intercepted (never actually calling the original) so requiring adgen's
// and the backend's copy of the SAME model name in one process cannot throw
// `OverwriteModelError`, and nothing is ever really registered/compiled.
// Object.keys(schema.paths) is then reduced to top-level names (everything
// before the first '.').
//
// NODE_MODULES: this needs mongoose to construct real Schema objects — a
// fresh worktree here has no node_modules of its own (documented in this
// repo's task brief). require('mongoose') falls back to the sibling
// liquidretail_backend's node_modules via a Module._load patch — the same
// technique liquidretail_backend/scripts/verifyQuoteProvenanceStamp.js
// already uses there to stub a missing https-proxy-agent. If neither this
// repo nor the sibling backend has mongoose installed, this FAILS with an
// actionable message (never a silent skip) — per this task's own
// instruction: "if something genuinely needs a real install, say so rather
// than faking it."
//
// THE PATCH IS DELIBERATELY LEFT INSTALLED FOR THE LIFE OF THE PROCESS, NOT
// RESTORED RIGHT AFTER THIS FILE'S OWN `require('mongoose')`. First draft
// restored it immediately and every model FAILED with "Cannot find module
// mongoose" anyway — captureSchema() below requires 33 adgen model files
// and 33 backend model files, and EVERY ONE of those files does its own
// `const mongoose = require('mongoose')`, at the time THAT require runs,
// not at the time this file's top-level require ran. Restoring the patch
// early left every one of those later requires hitting the unpatched
// loader again. A verify script is a one-shot process anyway, so leaving
// the patch installed until the process exits is the correct scope, not a
// shortcut.
//
// BACKEND LOCATION: scripts/lib/siblingBackend.js — ADGEN_BACKEND_PATH env,
// else ../liquidretail_backend. If neither resolves to a real checkout,
// the cross-repo comparison is SKIPPED with a clear INFO line and this
// script exits 0 — a checkout that only has adgen genuinely cannot run a
// two-repo comparison, which is a different situation from a bug in either
// repo, and must not be reported as a failure.
//
// COMPARISON REF: origin/main of that sibling, not its working tree. The
// sibling checkout is shared and routinely dirty and behind origin/main
// (measured 2026-08-25: 18 commits behind, 9 modified tracked files).
// Requiring models/*.js straight off that working tree produced a FALSE
// FAILURE — Ad.js: adgen declares field(s) the backend model LACKS:
// titlingAttempts, titlingNeeded — even though origin/main (e5f4a3ff)
// declares both (models/Ad.js:536 and :559). The subset rule was working;
// the comparison target was stale. We therefore `git archive` origin/main's
// models/ (plus the two files those models require at load time — see
// EXTRA_ARCHIVE_PATHS) into a temp dir and require() those copies for
// real: same mongoose.model intercept, same Module._load mongoose
// fallback. A dirty or behind working tree cannot masquerade as "what
// backend has shipped". The info line matches verifyVendorDrift:
// "comparing backend origin/main <sha>; working tree HEAD <sha> is
// ignored". If origin/main is missing (different remote name, bare/odd
// clone) we fall back to the working tree with a clear INFO line and
// never hard-fail on that. Override the ref with ADGEN_BACKEND_REF (same
// knob as verifyVendorDrift). We do not fetch. The temp dir is removed
// on every exit path including throw.
//
// Otherwise fully offline: mongoose.Schema() never opens a connection, and
// nothing here touches the network, a real DB, or an API key.
//
// Revert-prove:
//   node scripts/verifyModelParity.js                         → pass
//   (edit src/models/Ad.js: add `notInBackend: { type: String }`)
//   node scripts/verifyModelParity.js                         → FAILS,
//     names Ad.js and the exact field "notInBackend"
//   (revert the edit)
//   node scripts/verifyModelParity.js                         → pass again
//   (sibling backend working tree behind origin/main and/or dirty on
//    models/Ad.js — the 2026-08-25 false-failure shape)
//   node scripts/verifyModelParity.js                         → still pass,
//     prints "info: comparing backend origin/main <sha>; working tree HEAD
//     <sha> is ignored" and does not FAIL Ad.js for titlingAttempts /
//     titlingNeeded (those fields exist on origin/main)

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { spawnSync } = require('child_process');
const { resolveBackendRoot } = require('./lib/siblingBackend');
const { isGitRepo, resolveRefSha } = require('./lib/vendorDrift');

const ROOT = path.join(__dirname, '..');
const ADGEN_MODELS_DIR = path.join(ROOT, 'src', 'models');
const BACKEND_ROOT = resolveBackendRoot(ROOT);

let pass = 0;
const failures = [];
const infos = [];

function check(label, fn) {
  try {
    fn();
    pass += 1;
  } catch (err) {
    failures.push(`${label}: ${err.message.split('\n')[0].slice(0, 600)}`);
  }
}

function info(label) {
  infos.push(label);
}

// ---------------------------------------------------------------------------
// Backend origin/main extract. Same rule as verifyVendorDrift: pin to the
// remote-tracking trunk so a dirty/behind shared checkout cannot
// masquerade as "what backend has shipped". ADGEN_BACKEND_REF overrides.
// Media.js also lazy-requires ../services/mediaInsightsService inside a
// post('save') hook that captureSchema never fires, so it is not extracted.
// ---------------------------------------------------------------------------

const EXTRA_ARCHIVE_PATHS = [
  'services/platformFormats.js', // models/AiCanvasArtifact.js load-time require
  'utils/titleNormalize.js',     // models/CatalogProduct.js load-time require
];

let backendExtractDir = null;

function cleanupBackendExtract() {
  if (!backendExtractDir) return;
  try { fs.rmSync(backendExtractDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  backendExtractDir = null;
}
process.on('exit', cleanupBackendExtract);

function gitEnv() {
  // git -C must win. Inherited GIT_DIR/GIT_WORK_TREE (hooks, rebase --exec)
  // point at THIS repo and make `git -C $backend archive origin/main` miss.
  const env = Object.assign({}, process.env);
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_INDEX_FILE;
  return env;
}

function shortSha(sha) {
  return sha ? String(sha).slice(0, 8) : '(none)';
}

function resolveParityBackendRef(backendRoot) {
  if (process.env.ADGEN_BACKEND_REF) return process.env.ADGEN_BACKEND_REF;
  if (!isGitRepo(backendRoot)) return null;
  if (resolveRefSha(backendRoot, 'origin/main')) return 'origin/main';
  return null;
}

function extractBackendRefToTemp(backendRoot, ref) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verifyModelParity-'));
  const archive = spawnSync(
    'git',
    ['-C', backendRoot, 'archive', '--format=tar', ref, '--', 'models', ...EXTRA_ARCHIVE_PATHS],
    { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, env: gitEnv() }
  );
  if (archive.status !== 0 || !archive.stdout || archive.stdout.length === 0) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    return null;
  }
  const tarPath = path.join(tmp, 'backend.tar');
  try {
    fs.writeFileSync(tarPath, archive.stdout);
    const extracted = spawnSync('tar', ['-xf', tarPath, '-C', tmp]);
    try { fs.unlinkSync(tarPath); } catch (e) { /* ignore */ }
    if (extracted.status !== 0) {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
      return null;
    }
  } catch (err) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    return null;
  }
  // Extracted copies live under os.tmpdir(), which has no node_modules.
  // Bare require('mongoose') from those files therefore misses normal
  // lookup and hits the process-wide Module._load patch installed by
  // loadMongooseWithFallback (candidateDir = BACKEND_ROOT/node_modules).
  // Relative requires stay inside this tree. Do not set NODE_PATH — that
  // would make the patch's first origLoad succeed from the wrong place
  // and break schema capture (see this file's NODE_MODULES header).
  return tmp;
}

function prepareBackendModelsDir() {
  const fallback = path.join(BACKEND_ROOT, 'models');
  const ref = resolveParityBackendRef(BACKEND_ROOT);
  if (!ref) {
    info('backend origin/main not found — comparing the working tree');
    return fallback;
  }
  const extracted = extractBackendRefToTemp(BACKEND_ROOT, ref);
  if (!extracted) {
    info(`backend ${ref} archive failed — comparing the working tree`);
    return fallback;
  }
  backendExtractDir = extracted;
  const modelsDir = path.join(extracted, 'models');
  if (!fs.existsSync(modelsDir)) {
    info(`backend ${ref} extract had no models/ — comparing the working tree`);
    cleanupBackendExtract();
    return fallback;
  }
  const backendHead = resolveRefSha(BACKEND_ROOT, ref);
  const workingTreeHead = isGitRepo(BACKEND_ROOT) ? resolveRefSha(BACKEND_ROOT, 'HEAD') : null;
  if (backendHead && workingTreeHead && backendHead !== workingTreeHead) {
    info(
      `comparing backend ${ref} ${shortSha(backendHead)}; ` +
      `working tree HEAD ${shortSha(workingTreeHead)} is ignored`
    );
  }
  return modelsDir;
}

// ---------------------------------------------------------------------------
// mongoose loader with a sibling-node_modules fallback. Patches
// Module._load so a bare specifier (never a relative or absolute path)
// that fails NORMAL resolution gets one more attempt resolved against the
// candidate dir — this repo's own node_modules, if it ever gets one, always
// wins first, since orig.apply() is tried before the fallback. Restored
// immediately after mongoose is loaded so this file does not leave a
// process-wide monkeypatch behind for anything requiring it later in the
// same process (the runVerifySuite.js pool spawns a fresh process per
// script, so this matters only for a direct `node -e` harness chain).
// ---------------------------------------------------------------------------
function loadMongooseWithFallback() {
  try {
    return require('mongoose');
  } catch (err) {
    if (!err || err.code !== 'MODULE_NOT_FOUND') throw err;
  }

  const candidateDir = BACKEND_ROOT ? path.join(BACKEND_ROOT, 'node_modules') : null;
  if (!candidateDir || !fs.existsSync(candidateDir)) {
    console.error(
      [
        'verifyModelParity: cannot load "mongoose" (MODULE_NOT_FOUND) and no',
        'sibling liquidretail_backend/node_modules was found to fall back to.',
        'This harness constructs real mongoose.Schema objects — it is not',
        'faked with a regex — so it genuinely needs mongoose installed.',
        'Fix: run `npm install` in this worktree, or',
        '`export NODE_PATH=<path-to-a-node_modules-containing-mongoose>`.'
      ].join('\n')
    );
    process.exit(1);
  }

  const origLoad = Module._load;
  Module._load = function fallbackLoad(request, parent, isMain) {
    try {
      return origLoad.apply(this, arguments);
    } catch (err) {
      if (err && err.code === 'MODULE_NOT_FOUND' && !request.startsWith('.') && !path.isAbsolute(request)) {
        try {
          const resolved = require.resolve(request, { paths: [candidateDir] });
          return origLoad.call(this, resolved, parent, isMain);
        } catch (e2) { /* fall through to the original error */ }
      }
      throw err;
    }
  };
  // NOT restored here — see the comment above this function.
  try {
    return require('mongoose');
  } catch (err) {
    console.error(
      [
        `verifyModelParity: cannot load "mongoose" even via the sibling`,
        `backend's node_modules (${candidateDir}). ${err.message}`,
        'Fix: run `npm install` in this worktree.'
      ].join('\n')
    );
    process.exit(1);
  }
}

const mongoose = loadMongooseWithFallback();

// ---------------------------------------------------------------------------
// Schema extraction.
// ---------------------------------------------------------------------------

// Requires `absPath` with mongoose.model() intercepted so nothing is really
// registered (avoids OverwriteModelError when adgen's and backend's copies
// of the same model name are both required in this one process) and
// nothing is really compiled twice. Returns { name, schema } for the FIRST
// mongoose.model(...) call the file makes, or null if it made none (a model
// file that does not call mongoose.model — unexpected for this repo's
// models, but reported as a check failure rather than crashing here).
function captureSchema(absPath) {
  const origModel = mongoose.model.bind(mongoose);
  let captured = null;
  mongoose.model = function interceptedModel(name, schema) {
    if (!captured) captured = { name, schema };
    return function StubModel() {};
  };
  try {
    delete require.cache[absPath];
    require(absPath);
  } finally {
    mongoose.model = origModel;
  }
  return captured;
}

function topLevelPaths(schema) {
  return [...new Set(Object.keys(schema.paths).map((p) => p.split('.')[0]))].sort();
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

function main() {
  if (!BACKEND_ROOT) {
    console.log(
      'verifyModelParity: sibling liquidretail_backend not found (checked ' +
      'ADGEN_BACKEND_PATH and ../liquidretail_backend) — cross-repo model ' +
      'parity check SKIPPED. This is expected in a checkout that only has ' +
      'adgen, and is not a failure.'
    );
    console.log('\n✅ verifyModelParity: 0/0 checks run (skipped — see above)');
    return;
  }

  try {
    const backendModelsDir = prepareBackendModelsDir();
    const files = fs.readdirSync(ADGEN_MODELS_DIR).filter((f) => f.endsWith('.js')).sort();

  for (const f of files) {
    const adgenPath = path.join(ADGEN_MODELS_DIR, f);
    const backendPath = path.join(backendModelsDir, f);

    if (!fs.existsSync(backendPath)) {
      info(`${f}: no counterpart at liquidretail_backend/models/${f} — not compared (renamed, or adgen-only model)`);
      continue;
    }

    check(`${f}: loads + adgen's top-level fields are a subset of backend's`, () => {
      const adgenCaptured = captureSchema(adgenPath);
      if (!adgenCaptured) throw new Error('src/models/' + f + ' never called mongoose.model(...) — cannot extract a schema');
      const backendCaptured = captureSchema(backendPath);
      if (!backendCaptured) throw new Error('backend models/' + f + ' never called mongoose.model(...) — cannot extract a schema');

      const adgenFields = topLevelPaths(adgenCaptured.schema);
      const backendFields = topLevelPaths(backendCaptured.schema);
      const backendSet = new Set(backendFields);
      const adgenSet = new Set(adgenFields);

      const onlyBackend = backendFields.filter((x) => !adgenSet.has(x));
      if (onlyBackend.length) {
        info(`${f}: backend-only field(s), not vendored into adgen (fine, not asserted): ${onlyBackend.join(', ')}`);
      }

      const onlyAdgen = adgenFields.filter((x) => !backendSet.has(x));
      if (onlyAdgen.length) {
        throw new Error(
          `adgen declares field(s) the backend model LACKS — schema drift, ` +
          `both services write the same DB: ${onlyAdgen.join(', ')}`
        );
      }
    });
  }

  const total = pass + failures.length;
  console.log(`verifyModelParity: compared ${total} model(s) against liquidretail_backend/models/ (SUBSET rule — see file header).`);
  for (const line of infos) console.log(`  info: ${line}`);

  if (failures.length) {
    console.log(`\n❌ verifyModelParity: ${failures.length} of ${total} model(s) FAILED`);
    for (const f of failures) console.log(`   • ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n✅ verifyModelParity: ${total}/${total} model(s) passed`);
  } finally {
    cleanupBackendExtract();
  }
}

main();
