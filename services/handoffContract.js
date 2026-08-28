'use strict';
//
// handoffContract — the VERSIONED declaration of the Ad-document handoff
// between liquidretail_backend and liquidretail_adgen.
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────
// Backend never calls adgen. It mints an Ad, moves it to
// `status:'rendering'` with `claimedByWorker:null`, and returns; an adgen
// renderer polls, atomically claims the row, renders, and writes the
// terminal state back. That is deliberately restart-resilient — there is
// no synchronous call to fail — but it means the ENTIRE interface between
// two independently deployed services is an implicit Mongo document shape
// that no code on either side declares.
//
// The cost of that has already been paid, twice, in ways worth naming:
//   * One prompt bug existed in THREE files across TWO repos with a single
//     copy fixed (see docs/CONTRACT-backend-adgen.md §"Known divergence").
//   * `scripts/vendor-manifest.json` carried a written attestation that
//     `regenerationRequest` "now exists on both sides" — the field list was
//     right, but the same manifest's prose described the claim filter with
//     the OLD `$ne:null` operator that had caused a double-claim bug.
//     Prose rots; nothing checked it.
//
// This module is the thing that does not rot: a machine-checkable list of
// the fields that constitute the contract, a version number, and a digest
// over the list. `scripts/verifyHandoffContract.js` (present in BOTH repos,
// running in BOTH CIs) fails when the list changes without the version
// being bumped, and when the live Mongoose schema no longer matches what
// the list declares.
//
// ── THIS FILE IS VENDORED AND MUST STAY BYTE-IDENTICAL ─────────────────
// Two copies exist, at the same path modulo adgen's `src/` prefix:
//   liquidretail_backend/services/handoffContract.js
//   liquidretail_adgen/src/services/handoffContract.js
// That pairing is exactly what adgen's `scripts/lib/vendorDrift.js`
// `discoverVendored()` matches up, so the vendor manifest tracks this file
// automatically and `verifyVendorDrift.js` fails the moment the two copies
// diverge. `verifyHandoffContract.js` also byte-compares them directly.
//
// KEEP THIS FILE BYTE-IDENTICAL IN BOTH REPOS. A contract declaration that
// could differ between the two services would be worse than no declaration
// at all — so nothing here may reference "this repo", a repo-specific path,
// or anything that would have to be edited on one side only.
//
// Consequently: NO repo-specific requires, NO path math, NO `require`
// of a model. `assertContractShape()` takes the schema as an argument so
// each repo's harness can hand it its own `models/Ad.js`. Keep it pure
// data plus pure functions.
//
// ── WHY A VERSION CONSTANT AND NOT A DOCUMENT FIELD ────────────────────
// Rejected alternative: stamping a `contractVersion` onto every Ad row.
// That is a migration on a hot collection, it needs a backfill story for
// millions of existing rows, and it still does not stop anything — the
// reader has to decide what to do with an unexpected value, and the only
// safe answer at render time is "carry on", which is what it would already
// have done. It moves the cost to runtime and buys no enforcement.
//
// Rejected alternative: hard-fail at startup on a version mismatch.
// The two services deploy independently. During EVERY rolling deploy they
// are guaranteed to disagree for a window of seconds to minutes. A boot
// assertion would convert an ordinary deploy into an outage, and would do
// it precisely when someone is shipping the fix. `describeContract()` is
// meant to be LOGGED at boot (observable, greppable in Render logs) and
// never to exit the process.
//
// Chosen: a shared constant + a digest, enforced in CI at PR time — when a
// human is present and can act — following the precedent this codebase
// already set with `INPUT_SCHEMA_VERSION` in `layoutInputService.js`,
// which must match across both repos or the `layoutinputartifacts` cache
// split-brains.
//
// ── HOW TO CHANGE THE CONTRACT ─────────────────────────────────────────
//   1. Edit CONTRACT_FIELDS here.
//   2. Run `node scripts/verifyHandoffContract.js --print-digest` and paste
//      the value into CONTRACT_DIGEST below.
//   3. Bump HANDOFF_CONTRACT_VERSION (minor for an added field, major for a
//      removed/retyped field or a changed transition rule).
//   4. Update `docs/CONTRACT-backend-adgen.md` — the harness checks that the
//      doc names the current version.
//   5. Apply steps 1-4 to the OTHER repo in the same session. Until you do,
//      `verifyVendorDrift.js` fails on this path in adgen, by design.
//

// Bumped whenever CONTRACT_FIELDS or a documented transition rule changes.
// MAJOR — a field is removed or retyped, or a state transition's owner changes.
// MINOR — a field is added, or a new transition is documented.
// PATCH — a description/annotation changes with no behavioural meaning.
const HANDOFF_CONTRACT_VERSION = '1.1.0';

// sha256 over the normalized CONTRACT_FIELDS (see computeContractDigest).
// Regenerate with: node scripts/verifyHandoffContract.js --print-digest
const CONTRACT_DIGEST = 'c9ae31f35d22d966a06545d8033d49dfc38c21d82f9eed57c8f11f6551aa4cfa';

// `writer` is the ENFORCED half of the contract — which service is allowed
// to write the field. Verified against every write site in both repos as of
// HANDOFF_CONTRACT_VERSION 1.0.0; the citations are in
// docs/CONTRACT-backend-adgen.md, which is the prose companion to this list.
//
//   'backend'  — only liquidretail_backend writes it.
//   'adgen'    — only liquidretail_adgen writes it.
//   'both'     — both services write it. This does NOT always mean "on disjoint
//                transitions": for regenerationRequest and the regenerate claim
//                pair, backend writes only nulls while adgen writes the live
//                values, and for veoVideoUrl backend's recovery path can write
//                the same field adgen's render path does. Read the per-field
//                note — that is where the actual division lives.
//
// `type` is the Mongoose instance name assertContractShape() checks against
// the live schema: 'String' | 'Number' | 'Boolean' | 'Date' | 'Mixed'.
const CONTRACT_FIELDS = [
  {
    field: 'status',
    type: 'String',
    writer: 'both',
    enum: ['queued', 'rendering', 'draft', 'live', 'archived', 'failed'],
    role: 'lifecycle',
    note:
      'The handoff trigger. Backend mints queued and moves to rendering; that write plus ' +
      'claimedByWorker:null IS the "adgen may take this" signal. Adgen\'s RENDERER writes only ' +
      'draft, failed, or rendering — pinned by scripts/verifyRendererAdStatusEnum.js, whose ' +
      'scope is renderer.js specifically, not the whole repo (adgen\'s titler and boot recovery ' +
      'also write draft/failed; its vendored queuedArchiveSweeper would write archived but is ' +
      'not wired). Backend also writes archived from its OWN live queuedArchiveSweeper. '  +
      'Backend additionally writes rendering->queued in its reaper, but ONLY on rows with ' +
      'claimedByWorker:null, which is what keeps the two services off each other.',
  },
  {
    field: 'renderRoute',
    type: 'String',
    writer: 'backend',
    enum: ['html_gen', 'veo', null],
    role: 'dispatch',
    note:
      'Set at mint. Adgen dispatches on it (html_gen -> static, veo -> video) and its claim ' +
      'filter requires $in:[html_gen,veo], so a null renderRoute row is never claimable.',
  },
  {
    field: 'claimedByWorker',
    type: 'String',
    writer: 'adgen',
    role: 'claim/render',
    note:
      'The mint-time render lease. Adgen sets it in the atomic claim and clears it on every ' +
      'terminal write and on requeue. Backend NEVER writes this field — it only reads it as ' +
      'a filter exclusion (claimedByWorker:null) so its reaper cannot requeue adgen-owned ' +
      'work. Null is therefore both "unclaimed" and "backend is doing this in-process".',
  },
  {
    field: 'claimedAt',
    type: 'Date',
    writer: 'adgen',
    role: 'claim/render',
    note: 'Stamped in the same $set as claimedByWorker; cleared with it. Drives stale-claim detection.',
  },
  {
    field: 'titlingNeeded',
    type: 'Boolean',
    writer: 'adgen',
    role: 'claim/titler',
    note:
      'Renderer->titler handoff within adgen. Declared in backend models/Ad.js ONLY so ' +
      'Mongoose strict mode does not silently drop the write — backend has no titler.',
  },
  {
    field: 'titlingAttempts',
    type: 'Number',
    writer: 'adgen',
    role: 'claim/titler',
    note: 'Bounded retry counter for titling. Declared in backend for the Mongoose-strict reason only.',
  },
  {
    field: 'titlingResumeState',
    type: 'String',
    writer: 'both',
    enum: ['pending', 'claimed', null],
    role: 'recovery',
    note:
      'Titling-resume lease. BOTH services run a titlingResumeService against this field. ' +
      'Backend\'s copy is ungated on ADGEN_RENDERER_ENABLED at the setInterval level (the ' +
      'flag is read inside resumeUntitledMasters at call time), so both sweeps can be live ' +
      'simultaneously; the per-document atomic claim is what prevents double-titling.',
  },
  {
    field: 'renderStage',
    type: 'String',
    writer: 'both',
    role: 'telemetry',
    note:
      'Progress telemetry, NOT a verdict — status carries pass/fail. Both services write it. ' +
      'The frontend renders a live elapsed timer off it, so a stage left un-terminal reads as ' +
      '"stuck" to an operator even when the ad is correctly finished.',
  },
  {
    field: 'renderStageAt',
    type: 'Date',
    writer: 'both',
    role: 'telemetry',
    note: 'Companion timestamp to renderStage.',
  },
  {
    field: 'veoVideoUrl',
    type: 'String',
    writer: 'both',
    role: 'render output',
    note:
      'The raw model video, before brand-script chrome. Writer is BOTH, not adgen-only: ' +
      "backend's boot recovery writes it when it collects an already-paid prediction " +
      '(bootRecoveryService.js:266), and backend writes it on the flag-off in-process render. ' +
      'Load-bearing for the contract because ' +
      'a video DERIVE inherits it from its sibling master during render, and because its ' +
      'presence on a stale claim is what distinguishes a stranded PAID master from an ' +
      'unstarted row.',
  },
  {
    field: 'regenerating',
    type: 'Boolean',
    writer: 'both',
    role: 'regenerate',
    note:
      'The regenerate lock, shared by BOTH the local-execution path (flag off) and the ' +
      'deferred path (flag on). Because it is shared it is NOT the bit that decides who ' +
      'executes — regenerationRequest is. Backend wins this lock on both paths.',
  },
  {
    field: 'regenerationRequest',
    type: 'Mixed',
    writer: 'backend',
    role: 'regenerate',
    note:
      'THE deferral bit. Backend stamps the full pass-through call here ONLY when it decided ' +
      'to defer (isAdgenRendererEnabled() true, read once synchronously at request time). The ' +
      'local path DOES write this field — it sets an explicit null in the same lock write, to ' +
      'clear any stale payload left by a crashed deferred attempt. So the invariant is NOT ' +
      '"the local path never writes it" (that is false and was corrected here); it is that the ' +
      'local path never writes an OBJECT. Adgen claims on {$type:"object"} and NOT {$ne:null} — ' +
      'Mongo $ne:null also matches documents where the field is ABSENT, which is every ' +
      'pre-migration row and every locally-executed regenerate, and that collapse was a real ' +
      'double-claim bug. Cleared by markComplete alongside regenerating.',
  },
  {
    field: 'regenerateClaimedByWorker',
    type: 'String',
    writer: 'both',
    role: 'regenerate',
    note:
      'The regenerate lease. Held on a DIFFERENT field from the mint-time claim, which means ' +
      'the two are NOT mutually exclusive — see the contract doc section 6.5: a row can match ' +
      'the renderer claim and the regenerate claim at the same time, because backend regenerate ' +
      'preflight does not refuse status:rendering. Backend also nulls this pair on its ' +
      'local-execution path. There is ' +
      'deliberately NO release sweep: a crash mid-regenerate leaves this set until an ' +
      'operator clears it, because an automatic retry would be a second billable submit.',
  },
  {
    field: 'regenerateClaimedAt',
    type: 'Date',
    writer: 'both',
    role: 'regenerate',
    note:
      'Stamped in the same $set as regenerateClaimedByWorker. Writer is BOTH for the same ' +
      'reason: only adgen ever sets a worker id, but backend nulls the pair on its ' +
      'local-execution lock write (adRegenerateService.js:658-660).',
  },
  {
    field: 'updatedAt',
    type: 'Date',
    writer: 'both',
    role: 'heartbeat',
    note:
      'MANUALLY maintained — the schema sets timestamps:false in both repos, so Mongoose does ' +
      'NOT touch this. Every stale-claim and reaper cutoff compares against it, which is why ' +
      'the render heartbeat exists at all: without a beat, updatedAt only moves when an ad ' +
      'settles, and a long video titling gap looks identical to a dead worker.',
  },
  {
    field: 'retitleRequest',
    type: 'Mixed',
    writer: 'backend',
    role: 'retitle',
    note:
      'THE deferral bit for manual RE-TITLE (routes/brand.js retitle-videos / title-still), a ' +
      'THIRD independent claim namespace alongside the mint-time render claim and the ' +
      'regenerate claim — deliberately NOT a reuse of titlingNeeded, because that claim ' +
      '(adgen titler.js claimOne, status:{$in:[rendering,draft]}) exists only for the ' +
      'immediately-post-generation handoff and can never match the common manual-retitle ' +
      'target (status:live, delivered days or weeks earlier). Backend stamps the full ' +
      'pass-through call here ONLY when it decided to defer (isAdgenRendererEnabled() true, ' +
      'read once synchronously). The local path DOES write this field — an explicit null in ' +
      'the same stamp write, to clear a stale payload left by a crashed deferred attempt. ' +
      'Same $type:"object" discipline as regenerationRequest and the same reason: {$ne:null} ' +
      'also matches every ad where the field is simply ABSENT. Cleared by the retitle ' +
      'consumer alongside retitleResult, retitleClaimedByWorker, retitleClaimedAt.',
  },
  {
    field: 'retitleClaimedByWorker',
    type: 'String',
    writer: 'both',
    role: 'retitle',
    note:
      'The retitle lease. Held on a field DISJOINT from claimedByWorker (mint-time render), ' +
      'regenerateClaimedByWorker (regenerate), AND titlingNeeded (renderer->titler handoff) — ' +
      'by construction none of the four claims can collide on the same document. Retitle is ' +
      'confirmed FREE (brandScriptExecutor.js never requires an Atlas billing client in ' +
      'either repo), so unlike the regenerate claim this ONE is safe to let a stale-claim ' +
      'reclaim sweep clear — see adgen retitleConsumer.js reclaimStaleRetitleClaims, modeled ' +
      'on titler.js reclaimStaleTitlerClaims. Backend also nulls this on its local-execution ' +
      'stamp write, same defense-in-depth reason as regenerateClaimedByWorker.',
  },
  {
    field: 'retitleClaimedAt',
    type: 'Date',
    writer: 'both',
    role: 'retitle',
    note: 'Stamped in the same $set as retitleClaimedByWorker; cleared with it. Drives the reclaim sweep.',
  },
  {
    field: 'retitleResult',
    type: 'Mixed',
    writer: 'both',
    role: 'retitle',
    note:
      'Result readout for the deferred path. Retitle has no regenerationHistory-style array of ' +
      'its own, and renderUrl alone cannot signal success — a retitle overwrites the SAME ' +
      'Cloudinary public_id in place, so the URL string is frequently unchanged on a ' +
      'successful retitle too. Backend nulls it in the SAME write that stamps a new ' +
      'retitleRequest (so a stale prior result can never be misread as the new request\'s ' +
      'outcome); adgen writes {status,renderUrl,error,completedAt} in the SAME write that ' +
      'clears retitleRequest and the claim pair.',
  },
];

// The env flag that decides which service owns the collection. Named here
// so both repos agree on the spelling and the comparison, and so the
// harness can assert the comparison has not been loosened.
const OWNERSHIP_FLAG = 'ADGEN_RENDERER_ENABLED';

// Both repos implement this identically. Duplicated as a pure function so
// the harness can assert the semantics rather than trusting a grep:
// case-insensitive, exact 'true', and EVERYTHING else (unset, malformed,
// 'yes', '1') reads as OFF. Off is the safe direction because backend
// renders unconditionally whenever the flag is not 'true' — so adgen
// standing down leaves work where backend already handles it, while adgen
// claiming on a misread would race backend for the same row.
function isOwnershipFlagOn(rawValue) {
  return String(rawValue || '').toLowerCase() === 'true';
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

// Digest over the ENFORCED shape only: field name, type, writer, enum.
// `note` and `role` are prose and are deliberately EXCLUDED — a wording
// improvement must not force a version bump, or the version stops meaning
// anything and people stop bumping it. Anything that changes behaviour
// (a new field, a retype, a changed writer, a widened enum) is included.
function computeContractDigest(fields) {
  const crypto = require('crypto');
  const normalized = (fields || CONTRACT_FIELDS)
    .map((f) => ({
      field: f.field,
      type: f.type,
      writer: f.writer,
      enum: f.enum === undefined ? null : f.enum,
    }))
    .sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));
  return crypto.createHash('sha256').update(stableStringify(normalized)).digest('hex');
}

// Verify the live Mongoose schema actually declares every contract field
// with the declared type. This is the check that catches the specific
// failure mode this codebase has been bitten by repeatedly and documents
// in models/Ad.js at least six separate times: Mongoose strict mode
// silently DROPS a write to an undeclared path, with no error. A contract
// field that stops being declared does not throw — it just stops
// persisting, and the handoff stalls with no signal.
//
// `schema` is a mongoose.Schema. Returns an array of problem strings;
// empty means the shape is intact.
function assertContractShape(schema, fields) {
  const problems = [];
  const list = fields || CONTRACT_FIELDS;
  for (const f of list) {
    const declared = schema && typeof schema.path === 'function' ? schema.path(f.field) : null;
    if (!declared) {
      problems.push(
        `${f.field}: NOT DECLARED on the schema. Mongoose strict mode will silently drop ` +
        `every write to it. Declare it (type ${f.type}) or remove it from CONTRACT_FIELDS ` +
        `and bump HANDOFF_CONTRACT_VERSION.`
      );
      continue;
    }
    const actual = declared.instance || (declared.constructor && declared.constructor.name) || 'unknown';
    if (String(actual) !== String(f.type)) {
      problems.push(
        `${f.field}: declared as ${actual}, contract says ${f.type}. A type change is a MAJOR ` +
        `contract change — the other service is reading this field.`
      );
    }
  }
  return problems;
}

// Intended for a boot log line in both services. NEVER throw or exit from
// a version mismatch — see the header on rolling deploys.
function describeContract() {
  return (
    `handoff-contract v${HANDOFF_CONTRACT_VERSION} ` +
    `digest=${String(CONTRACT_DIGEST).slice(0, 12)} ` +
    `fields=${CONTRACT_FIELDS.length} ` +
    `flag=${OWNERSHIP_FLAG}=${isOwnershipFlagOn(process.env[OWNERSHIP_FLAG]) ? 'on' : 'off'}`
  );
}

module.exports = {
  HANDOFF_CONTRACT_VERSION,
  CONTRACT_DIGEST,
  CONTRACT_FIELDS,
  OWNERSHIP_FLAG,
  isOwnershipFlagOn,
  computeContractDigest,
  assertContractShape,
  describeContract,
};
