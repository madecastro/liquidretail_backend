#!/usr/bin/env node
'use strict';
//
// verifyHandoffContract — enforces the VERSIONED backend↔adgen handoff
// contract declared in services/handoffContract.js.
//
// ── WHY THIS EXISTS IN THE BACKEND REPO ────────────────────────────────
// Backend never calls adgen. It mints an Ad, moves it to
// `status:'rendering'` with `claimedByWorker:null`, and returns; an adgen
// renderer polls, atomically claims the row, renders, and writes the
// terminal state back. So the entire interface between two independently
// deployed services is an implicit Mongo document shape that — until
// services/handoffContract.js — neither side declared anywhere.
//
// A COUNTERPART lives at liquidretail_adgen/scripts/verifyHandoffContract.js.
// Both repos run their own copy, and each checks ITS OWN models/Ad.js. That
// symmetry is the point: a contract only one side enforces is a contract one
// side can break.
//
// The two are NOT byte-identical and must not be described as such: they
// differ in the module/model paths, in how mongoose is obtained (this repo has
// it installed; a bare adgen worktree needs a Module._load fallback), in which
// sibling they resolve and in which direction, and in their fixture tables.
// Only services/handoffContract.js itself is held byte-identical — check E is
// what asserts that.
//
// The specific thing it protects against on THIS side: several contract
// fields exist in backend's schema for no reason other than to stop
// Mongoose strict mode dropping ADGEN's writes to them —
// `titlingNeeded`, `titlingAttempts`, `titlingResumeState`. models/Ad.js
// says so in its own comments, repeatedly. Backend has no titler, so those
// fields look unused HERE, which makes them exactly what a well-meaning
// cleanup deletes. Deleting one would not throw: the writes would just
// silently stop persisting and a cross-service handoff would stall with no
// error anywhere. This check is what makes that deletion loud.
//
// ── WHAT IT CHECKS ─────────────────────────────────────────────────────
//   A. CONTRACT_DIGEST still matches CONTRACT_FIELDS, so the field list
//      cannot change without the version being bumped deliberately.
//   B. This repo's live Ad schema declares every contract field with the
//      declared type (the Mongoose-strict guard above).
//   C. The contract document names the current version.
//   D. The ownership-flag predicate has not been loosened — asserted by
//      execution over a fixture table, not by reading the source. It
//      decides which of two services owns a SHARED collection, so a
//      widened truthiness test hands the same rows to two writers.
//   E. The two repos' copies of the contract module are byte-identical
//      (when the adgen sibling is checked out).
//
// ── WHY NOT A STARTUP ASSERTION ────────────────────────────────────────
// Deliberately NOT enforced at boot. The two services deploy
// independently, so during every rolling deploy they disagree for a window
// of seconds to minutes; a boot assertion would turn an ordinary deploy
// into an outage, precisely while someone is shipping the fix.
// describeContract() is for a boot LOG line. The gate belongs in CI, where
// a human is present. Full reasoning, and the two rejected alternatives
// (a per-document contractVersion field; hard-failing at startup), are in
// the module header.
//
// Fully offline: fs + require. No DB, no network, no new dependency.
// mongoose is required directly — this repo has it installed, unlike an
// adgen worktree, whose twin needs a Module._load fallback.
//
// USAGE
//   node scripts/verifyHandoffContract.js
//   node scripts/verifyHandoffContract.js --print-digest
//
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// ── REPO-SPECIFIC WIRING (see the header: the counterpart differs in more
//    than these, so this is not an exhaustive diff) ────────────────────
const CONTRACT_MODULE_REL = 'services/handoffContract.js';
const AD_MODEL_REL = 'models/Ad.js';
const THIS_REPO = 'backend';
const SIBLING_ENV = 'BACKEND_ADGEN_PATH';
const SIBLING_DEFAULT = '../liquidretail_adgen';
const SIBLING_CONTRACT_REL = 'src/services/handoffContract.js';
// ──────────────────────────────────────────────────────────────────────
const CONTRACT_DOC_REL = 'docs/CONTRACT-backend-adgen.md';

const contract = require(path.join(ROOT, CONTRACT_MODULE_REL));
const {
  HANDOFF_CONTRACT_VERSION,
  CONTRACT_DIGEST,
  CONTRACT_FIELDS,
  OWNERSHIP_FLAG,
  isOwnershipFlagOn,
  computeContractDigest,
  assertContractShape,
  describeContract,
} = contract;

if (process.argv.includes('--print-digest')) {
  console.log(computeContractDigest());
  process.exit(0);
}

let pass = 0;
const failures = [];
const infos = [];

function check(label, fn) {
  try {
    fn();
    pass += 1;
  } catch (err) {
    failures.push(`${label}: ${err.message}`);
  }
}

// Mirrors adgen's scripts/lib/siblingBackend.js, pointing the other way. A
// candidate counts only if it has the src/services directory — cheap proof
// it really is the adgen repo and not an empty or unrelated directory.
function resolveAdgenRoot() {
  const candidates = [];
  if (process.env[SIBLING_ENV]) candidates.push(process.env[SIBLING_ENV]);
  candidates.push(path.join(ROOT, SIBLING_DEFAULT));
  for (const c of candidates) {
    const resolved = path.resolve(c);
    try {
      if (fs.statSync(path.join(resolved, 'src', 'services')).isDirectory()) return resolved;
    } catch (e) { /* next */ }
  }
  return null;
}

// Read a path from the sibling's remote-tracking trunk. Mirrors what adgen's
// scripts/lib/vendorDrift.js readBackendBlob() does about this repo, kept as a
// tiny local helper because this repo has no equivalent lib and one spawnSync
// is not worth a new shared module.
function readSiblingBlob(repoRoot, relPath) {
  const { spawnSync } = require('child_process');
  const env = Object.assign({}, process.env);
  // Inherited GIT_DIR/GIT_WORK_TREE (hooks, rebase --exec) point at THIS repo
  // and would make `git -C <sibling> show` read the wrong tree entirely.
  delete env.GIT_DIR; delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR; delete env.GIT_INDEX_FILE;
  const run = (args) => spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', env, maxBuffer: 32 * 1024 * 1024 });
  let ref = process.env.BACKEND_ADGEN_REF || null;
  if (!ref) {
    for (const cand of ['origin/master', 'origin/main', 'HEAD']) {
      if (run(['rev-parse', '--verify', cand]).status === 0) { ref = cand; break; }
    }
  }
  if (!ref) return null;
  const out = run(['show', `${ref}:${relPath}`]);
  return out.status === 0 ? out.stdout : null;
}

// ── A. digest ──────────────────────────────────────────────────────────
check('contract digest matches the declared field list', () => {
  const actual = computeContractDigest();
  if (actual !== CONTRACT_DIGEST) {
    throw new Error(
      `CONTRACT_FIELDS changed but CONTRACT_DIGEST was not updated.\n` +
      `    recorded: ${CONTRACT_DIGEST}\n` +
      `    actual:   ${actual}\n` +
      `    This is the gate that makes HANDOFF_CONTRACT_VERSION mean something. To resolve:\n` +
      `      1. node scripts/verifyHandoffContract.js --print-digest   (paste into CONTRACT_DIGEST)\n` +
      `      2. bump HANDOFF_CONTRACT_VERSION (MAJOR if a field was removed/retyped or a writer changed)\n` +
      `      3. update ${CONTRACT_DOC_REL}\n` +
      `      4. apply the SAME change to liquidretail_adgen's copy of the module`
    );
  }
});

check('contract declares a plausible field set', () => {
  if (!Array.isArray(CONTRACT_FIELDS) || CONTRACT_FIELDS.length < 10) {
    throw new Error(`CONTRACT_FIELDS has ${CONTRACT_FIELDS && CONTRACT_FIELDS.length} entries — a contract this small is almost certainly a truncation, not a simplification`);
  }
  const seen = new Set();
  for (const f of CONTRACT_FIELDS) {
    if (!f.field || !f.type || !f.writer) throw new Error(`entry ${JSON.stringify(f)} is missing field/type/writer`);
    if (!['backend', 'adgen', 'both'].includes(f.writer)) throw new Error(`${f.field}: writer must be backend|adgen|both, got ${f.writer}`);
    if (!String(f.note || '').trim()) throw new Error(`${f.field}: has no note — an undocumented contract field is how this drifted in the first place`);
    if (seen.has(f.field)) throw new Error(`${f.field} is declared twice`);
    seen.add(f.field);
  }
});

// ── B. live schema shape ───────────────────────────────────────────────
check(`live ${THIS_REPO} Ad schema declares every contract field with the declared type`, () => {
  const mongoose = require('mongoose');
  let adSchema = null;
  const realModel = mongoose.model.bind(mongoose);
  mongoose.model = function capture(name, schema) {
    if (name === 'Ad' && schema) adSchema = schema;
    try { return realModel(name, schema); } catch (e) { return { schema }; }
  };
  try {
    require(path.join(ROOT, AD_MODEL_REL));
  } finally {
    mongoose.model = realModel;
  }
  if (!adSchema) throw new Error(`could not extract a Schema from ${AD_MODEL_REL} — mongoose.model('Ad', …) was never called`);
  const problems = assertContractShape(adSchema);
  if (problems.length) {
    throw new Error(
      `${problems.length} contract field(s) no longer match ${THIS_REPO}'s live schema:\n    ` +
      problems.join('\n    ')
    );
  }
  infos.push(`live schema shape: all ${CONTRACT_FIELDS.length} contract fields declared with the declared types`);
});

// ── C. doc names the version ───────────────────────────────────────────
check(`${CONTRACT_DOC_REL} exists and names v${HANDOFF_CONTRACT_VERSION}`, () => {
  const docPath = path.join(ROOT, CONTRACT_DOC_REL);
  if (!fs.existsSync(docPath)) {
    throw new Error(`missing ${CONTRACT_DOC_REL} — the contract module's prose companion. A version constant with no document is a number nobody can act on.`);
  }
  const doc = fs.readFileSync(docPath, 'utf8');
  // Matched against the doc's DECLARED version line, not a bare
  // `doc.includes(version)`. A substring search anywhere in the file passes on
  // an unrelated mention — a changelog entry, or a code sample — while the
  // document's own header still declares an older version. That is a check
  // that looks like it works and does not.
  const declared = /^\*\*Contract version:\s*([0-9]+\.[0-9]+\.[0-9]+)/m.exec(doc);
  if (!declared) {
    throw new Error(
      `${CONTRACT_DOC_REL} has no parseable version line. Expected a line of the form ` +
      `"**Contract version: X.Y.Z**" so this check reads the document's own declaration.`
    );
  }
  if (declared[1] !== HANDOFF_CONTRACT_VERSION) {
    throw new Error(
      `${CONTRACT_DOC_REL} declares version ${declared[1]} but HANDOFF_CONTRACT_VERSION is ` +
      `${HANDOFF_CONTRACT_VERSION}. The constant was bumped and the document was not updated — ` +
      `the exact rot this whole mechanism exists to prevent.`
    );
  }
});

// ── D. flag predicate not loosened ─────────────────────────────────────
check(`${OWNERSHIP_FLAG} predicate accepts only case-insensitive 'true'`, () => {
  const cases = [
    ['true', true], ['TRUE', true], ['True', true],
    ['false', false], ['FALSE', false], ['yes', false], ['1', false], ['on', false],
    ['', false], [undefined, false], [null, false], ['truthy', false], ['true ', false],
  ];
  const bad = [];
  for (const [input, want] of cases) {
    const got = isOwnershipFlagOn(input);
    if (got !== want) bad.push(`isOwnershipFlagOn(${JSON.stringify(input)}) === ${got}, want ${want}`);
  }
  if (bad.length) {
    throw new Error(
      `the ownership predicate has been loosened — this decides which of two services owns a ` +
      `SHARED Mongo collection, so a widened truthiness test hands the same rows to two writers:\n    ` +
      bad.join('\n    ')
    );
  }
  infos.push(`ownership predicate: ${cases.length} fixtures correct (only case-insensitive 'true' is on; unset/malformed reads OFF)`);
});

// ── E. the two repos' contract modules agree ───────────────────────────
check('contract module is identical in both repos', () => {
  const adgenRoot = resolveAdgenRoot();
  if (!adgenRoot) {
    infos.push(
      `sibling liquidretail_adgen not found (${SIBLING_ENV} or ${SIBLING_DEFAULT}) — cross-repo ` +
      `contract-module comparison SKIPPED. Not a failure: a narrow CI clone genuinely cannot do it.`
    );
    return;
  }
  // Read adgen's copy from its REMOTE-TRACKING TRUNK, not its working tree.
  // A sibling checkout is shared, long-lived, and routinely dirty or behind;
  // reading it would let a stale tree answer "do the two copies agree?" and be
  // confidently wrong. adgen's own harnesses make the same choice about THIS
  // repo, so the two must not disagree about the same file.
  const other = readSiblingBlob(adgenRoot, SIBLING_CONTRACT_REL);
  if (other == null) {
    infos.push(
      `${SIBLING_CONTRACT_REL} not readable in the adgen sibling at its trunk — the adgen half ` +
      `has not landed there yet. Comparison SKIPPED.`
    );
    return;
  }
  const mine = fs.readFileSync(path.join(ROOT, CONTRACT_MODULE_REL), 'utf8');
  if (mine !== other) {
    throw new Error(
      `${CONTRACT_MODULE_REL} differs from adgen's ${SIBLING_CONTRACT_REL}. This module is the ` +
      `single declaration of a shared interface; if the two copies can disagree it declares nothing. ` +
      `Make them byte-identical (it is pure data + pure functions precisely so that is always possible).`
    );
  }
  infos.push('cross-repo: contract module is byte-identical in both repos');
});

console.log(`verifyHandoffContract: ${describeContract()}`);
for (const line of infos) console.log(`  info: ${line}`);

const total = pass + failures.length;
if (failures.length) {
  console.log(`\n❌ verifyHandoffContract: ${failures.length} of ${total} check(s) FAILED`);
  for (const f of failures) {
    for (const line of String(f).split('\n')) console.log(`   ${line}`);
  }
  process.exit(1);
}
console.log(`\n✅ verifyHandoffContract: ${total}/${total} checks passed`);
