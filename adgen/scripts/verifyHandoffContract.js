#!/usr/bin/env node
'use strict';
//
// verifyHandoffContract — enforces the VERSIONED backend↔adgen handoff
// contract declared in src/services/handoffContract.js.
//
// A COUNTERPART lives at liquidretail_backend/scripts/verifyHandoffContract.js.
// Both repos' CIs run their own copy, so each side independently enforces that
// ITS OWN models/Ad.js still matches the declared contract.
//
// The two are NOT byte-identical, and should not be described as such: they
// differ in the module/model paths (adgen prefixes with src/), in how mongoose
// is obtained (backend has it installed; a bare adgen worktree needs the
// Module._load fallback in scripts/lib/mongooseLoader.js), and in which
// sibling they resolve and in which direction. Only
// services/handoffContract.js itself is held byte-identical — check E is what
// asserts that, and it is the only file where byte-identity is the contract.
//
// ── WHAT IT CHECKS, AND WHY EACH ONE EARNS ITS KEEP ────────────────────
//
// A. DIGEST MATCHES THE FIELD LIST.
//    CONTRACT_DIGEST is a recorded sha256 over the enforced shape of
//    CONTRACT_FIELDS (name, type, writer, enum — prose deliberately
//    excluded). Editing the field list without pasting the new digest
//    fails. That is the mechanism that makes HANDOFF_CONTRACT_VERSION
//    mean something: you cannot change the contract quietly, because the
//    only way to make this check pass again is to run --print-digest,
//    which is the moment you also bump the version and update the doc.
//
// B. THE LIVE SCHEMA STILL DECLARES EVERY CONTRACT FIELD, WITH THE
//    DECLARED TYPE.
//    This is the one with production teeth. models/Ad.js documents the
//    Mongoose-strict trap in at least six separate places, in its own
//    words: "Mongoose strict mode silently drops writes to undeclared
//    paths". A contract field that stops being declared does not throw —
//    the write just stops persisting, and a cross-service handoff stalls
//    with no error anywhere. Several fields (titlingNeeded,
//    titlingAttempts, titlingResumeState) exist in backend's schema for
//    NO other reason than to stop backend stripping adgen's writes, which
//    makes them exactly the fields a well-meaning cleanup would delete as
//    "unused in this repo". This check is what makes that deletion loud.
//
// C. THE DOC NAMES THE CURRENT VERSION.
//    A version constant whose companion document describes an older shape
//    is worse than no document. Cheap check, closes the rot path.
//
// D. THE FLAG PREDICATE IS NOT LOOSENED.
//    isOwnershipFlagOn must accept ONLY case-insensitive 'true'. Widening
//    it to 'yes'/'1'/truthy would silently hand ownership of a shared
//    Mongo collection to a second writer. Asserted by execution over a
//    fixture table, not by reading the source.
//
// E. THE TWO REPOS' CONTRACT MODULES ARE IDENTICAL (when the sibling is
//    present). The module is vendored at the same relative path, so
//    verifyVendorDrift.js tracks it automatically once the backend copy
//    exists — but until then, and as a direct second opinion, this
//    compares the bytes here. A contract declaration that could differ
//    between the two services would be worse than no declaration.
//
// ── WHY NOT A STARTUP ASSERTION ────────────────────────────────────────
// Deliberately NOT enforced at boot. The two services deploy
// independently, so during every rolling deploy they disagree for a
// window; a boot assertion would turn an ordinary deploy into an outage,
// precisely while someone is shipping the fix. handoffContract's
// describeContract() is for a boot LOG line. The gate belongs in CI,
// where a human is present. See the module header for the full reasoning
// and for the two rejected alternatives (a per-document contractVersion
// field, and hard-failing at startup).
//
// ── MONGOOSE ───────────────────────────────────────────────────────────
// Check B needs a real mongoose to instantiate the schema. In CI `npm ci`
// has run, so `require('mongoose')` resolves. In a BARE adgen worktree it
// does not — and per this repo's CLAUDE.md you must NOT `npm ci` a worktree
// or set NODE_PATH here, because that breaks verifyModelParity.js's
// shared-instance fallback. So: try our own, then the sibling backend's,
// then INFO-skip B only. A, C, D and E need no mongoose and always run.
//
// Fully offline: fs + require. No DB, no network, no new dependency.
//
// USAGE
//   node scripts/verifyHandoffContract.js
//   node scripts/verifyHandoffContract.js --print-digest
//
const fs = require('fs');
const path = require('path');
const { resolveBackendRoot } = require('./lib/siblingBackend');
const { loadMongooseWithFallback } = require('./lib/mongooseLoader');
const { resolveBackendRef, readBackendBlob } = require('./lib/vendorDrift');

const ROOT = path.join(__dirname, '..');
// ── REPO-SPECIFIC WIRING (see the header: the counterpart differs in more
//    than these, so this is not an exhaustive diff) ──────────────────
const CONTRACT_MODULE_REL = 'src/services/handoffContract.js';
const AD_MODEL_REL = 'src/models/Ad.js';
const THIS_REPO = 'adgen';
// ──────────────────────────────────────────────────────────────────────
const CONTRACT_DOC_REL = 'docs/CONTRACT-backend-adgen.md';
const BACKEND_CONTRACT_REL = 'services/handoffContract.js';

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
      `      4. apply the SAME change to the other repo's copy of the module`
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
// Shared with verifyModelParity.js via scripts/lib/mongooseLoader.js. The
// Module._load patch that loader installs is what lets src/models/Ad.js's
// OWN bare require('mongoose') resolve in a bare worktree — a createRequire
// shim here would load mongoose for THIS file only and Ad.js would still
// throw MODULE_NOT_FOUND. Unlike verifyModelParity we do NOT exit on a
// missing mongoose: checks A, C, D and E need none, and failing the whole
// suite over a dev dependency would train people to ignore this harness.
const mongoose = loadMongooseWithFallback({
  harnessName: 'verifyHandoffContract',
  backendRoot: resolveBackendRoot(ROOT),
  onUnavailable: () => null,
});
if (!mongoose) {
  infos.push(
    'mongoose unavailable (no own node_modules and no sibling backend) — the LIVE SCHEMA SHAPE ' +
    'check (B) was SKIPPED. It runs in CI, where npm ci has installed mongoose. Everything else ran.'
  );
} else {
  infos.push(`mongoose ${mongoose.version} loaded`);
  check('live Ad schema declares every contract field with the declared type', () => {
    // Fresh model registry so a re-require cannot collide on model name.
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
}

// ── C. doc names the version ───────────────────────────────────────────
check(`${CONTRACT_DOC_REL} exists and names v${HANDOFF_CONTRACT_VERSION}`, () => {
  const docPath = path.join(ROOT, CONTRACT_DOC_REL);
  if (!fs.existsSync(docPath)) {
    throw new Error(`missing ${CONTRACT_DOC_REL} — the contract module's prose companion. A version constant with no document is a number nobody can act on.`);
  }
  const doc = fs.readFileSync(docPath, 'utf8');
  // Matched against the doc's DECLARED version line, not a bare
  // `doc.includes(version)`. A substring search anywhere in the file passes on
  // an unrelated mention — a changelog entry naming 1.1.0, or a code sample —
  // while the document's own header still declares an older version. That is
  // a check that looks like it works and does not.
  const declared = /^\*\*Contract version:\s*([0-9]+\.[0-9]+\.[0-9]+)/m.exec(doc);
  if (!declared) {
    throw new Error(
      `${CONTRACT_DOC_REL} has no parseable version line. Expected a line of the form ` +
      `"**Contract version: X.Y.Z**" so this check reads the document's own declaration ` +
      `rather than any incidental mention of a version string.`
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
    ['true', true], ['TRUE', true], ['True', true], ['  true  '.trim(), true],
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
  const backendRoot = resolveBackendRoot(ROOT);
  if (!backendRoot) {
    infos.push('sibling backend absent — cross-repo contract-module comparison SKIPPED');
    return;
  }
  // Read the backend copy from the REMOTE-TRACKING REF, not the sibling
  // working tree. The sibling siblingBackend.js resolves is a shared,
  // long-lived checkout that other sessions have live edits in and that is
  // routinely parked behind origin/main — reading it would let a stale or
  // dirty tree answer "do the two copies agree?", and the answer would be
  // confidently wrong in whichever direction that checkout happened to sit.
  // verifyVendorDrift.js and verifySharedInvariants.js both already made this
  // decision; an earlier draft of THIS check used fs.readFileSync and would
  // have quietly disagreed with them about the same file.
  const ref = resolveBackendRef(backendRoot);
  const blob = readBackendBlob(backendRoot, ref, BACKEND_CONTRACT_REL);
  if (!blob) {
    infos.push(
      `${BACKEND_CONTRACT_REL} does not exist in the sibling backend at ${ref || '(no ref)'} — the ` +
      `backend half of this contract has not landed there yet. Comparison SKIPPED. Once it lands, ` +
      `verifyVendorDrift.js also picks this path up automatically (same relative path = vendored).`
    );
    return;
  }
  const mine = fs.readFileSync(path.join(ROOT, CONTRACT_MODULE_REL), 'utf8');
  const other = blob.bytes.toString('utf8');
  if (mine !== other) {
    throw new Error(
      `${CONTRACT_MODULE_REL} differs from the backend's ${BACKEND_CONTRACT_REL}. This module is the ` +
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
