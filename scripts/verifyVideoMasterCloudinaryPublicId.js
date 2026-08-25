#!/usr/bin/env node
'use strict';
//
// verifyVideoMasterCloudinaryPublicId — regression guard for the video-
// master persist write in renderer.js's renderVideo() (the $setMaster
// object, the ONLY write that follows the paid atlasVideo.generateForAd
// submit). Fixed bug, stated once so the "why" survives past the diff:
//
//   veoResult.cloudinaryPublicId (returned by BOTH atlasVideoService.js and
//   aiVideoReferenceService.js — see videoRouter.js's documented uniform
//   provider shape) identifies the RAW OMNI MASTER's Cloudinary video asset,
//   uploaded BEFORE Remotion titling ever runs. The later titled-render
//   upload (brandScriptExecutor.uploadRenderAndStamp, both repos) only ever
//   stamps renderUrl/posterUrl — grep confirms it never writes any
//   cloudinaryPublicId-shaped key — so this field means "the raw master",
//   for the life of the ad, never "the titled render". Backend's identical
//   write (grep `cloudinaryPublicId` in liquidretail_backend/routes/ads.js —
//   line numbers drift there, not pinned here) puts this same value under
//   the SCHEMA-DECLARED path `cloudinaryPublicId`. adgen's copy of this write
//   used the name `veoCloudinaryPublicId` instead — not a path in EITHER
//   repo's models/Ad.js — so Mongoose strict mode silently dropped it on
//   every write, no error, ever. Every adgen-rendered video master lost its
//   Cloudinary id permanently. 4th instance of this exact failure class in
//   this repo (after renderError.predictionId, the renderStage sentinel,
//   and titlingNeeded — all recorded in models/Ad.js's own comments).
//
// TWO CHECKS, not one:
//   A. The specific regression: $setMaster must map veoResult's Cloudinary
//      id through the literal key `cloudinaryPublicId`, and must NOT
//      contain a `veoCloudinaryPublicId` key anywhere (catches a partial
//      revert that adds the old key back alongside the new one).
//   B. The general case this bug is an instance of: EVERY top-level key
//      $setMaster writes (spread branches excluded — see below) must be a
//      real path in adgen's own src/models/Ad.js schema, checked by
//      actually requiring the model (mongoose.Schema, not a source-text
//      guess at nested Mixed/subdocument shapes — see verifyModelParity.js's
//      header for why that file rejected regex-parsing the SCHEMA side).
//      This is the "compare a write against its schema" axis the model-
//      parity harness does not cover (that one compares two schemas to
//      each other, never a write site to either).
//
// $setMaster's ternary-spread arms (titlingNeeded / titlingResumeState /
// claimedByWorker / claimedAt, added when isTitlerEnabled()) are ONE level
// deeper than $setMaster's own top-level keys (they live inside the `{...}`
// on each side of `...(handoffMode ? {...} : {...})`), so the depth-0
// extraction below does not see them — verifyTitlerHandoff.js already pins
// that handoff shape (44 checks). No duplication intended.
//
// WRITE-SIDE MECHANISM: renderer.js is NOT required — it opens a live Mongo
// connection and pulls in dozens of vendored services at module load, for
// zero benefit here (only one object literal's key names are needed). The
// $setMaster object is instead located by a string/comment-aware bracket
// scan (scripts/lib/sourceLiteralScan.js) anchored on its `const $setMaster
// = {` declaration and walked to its balanced closing brace — a structural
// bound, not a magic line count, so it survives the object being
// reordered or reformatted (only renaming the variable, or restructuring
// renderVideo() so this write no longer exists as one literal, defeats it —
// and the former would itself be a change worth a human re-reading this
// file's header).
//
// SCHEMA-SIDE MECHANISM: same sibling-mongoose-fallback technique as
// verifyModelParity.js (mongoose.model intercepted so requiring Ad.js here
// cannot collide with anything else in the process; NODE_PATH / a populated
// node_modules defeats the fallback the same way documented there — run
// this from a bare worktree). See that file's header for the fuller
// rationale; not re-derived here to avoid the two drifting apart in prose
// while both keep the same mechanism.
//
// Revert-prove:
//   node scripts/verifyVideoMasterCloudinaryPublicId.js                → pass
//   (edit src/services/renderer.js: rename $setMaster's `cloudinaryPublicId:`
//    key back to `veoCloudinaryPublicId:`)
//   node scripts/verifyVideoMasterCloudinaryPublicId.js                → FAILS
//   (revert the edit)
//   node scripts/verifyVideoMasterCloudinaryPublicId.js                → pass again

const fs = require('fs');
const path = require('path');
const Module = require('module');
const { extractTopLevelKeysAfter } = require('./lib/sourceLiteralScan');

const ROOT = path.join(__dirname, '..');
const RENDERER_PATH = path.join(ROOT, 'src', 'services', 'renderer.js');
const AD_MODEL_PATH = path.join(ROOT, 'src', 'models', 'Ad.js');

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
// mongoose loader with a sibling-node_modules fallback. Same technique as
// scripts/verifyModelParity.js (see that file for the full rationale on why
// the patch is left installed for the process lifetime) — duplicated here
// rather than imported because verifyModelParity.js does not currently
// export it; if that changes, both call sites should switch to the shared
// export together rather than one drifting from the other. This repo
// already accepts this kind of duplication deliberately (CLAUDE.md documents
// titler.js duplicating several renderer.js helpers for the same reason:
// "If you edit one copy, edit the other.").
// ---------------------------------------------------------------------------
function resolveBackendNodeModules() {
  const candidate = process.env.ADGEN_BACKEND_PATH
    ? path.resolve(process.env.ADGEN_BACKEND_PATH)
    : path.resolve(ROOT, '..', 'liquidretail_backend');
  const nm = path.join(candidate, 'node_modules');
  return fs.existsSync(nm) ? nm : null;
}

function loadMongooseWithFallback() {
  try {
    return require('mongoose');
  } catch (err) {
    if (!err || err.code !== 'MODULE_NOT_FOUND') throw err;
  }

  const candidateDir = resolveBackendNodeModules();
  if (!candidateDir) {
    console.error(
      [
        'verifyVideoMasterCloudinaryPublicId: cannot load "mongoose"',
        '(MODULE_NOT_FOUND) and no sibling liquidretail_backend/node_modules',
        'was found to fall back to. This harness requires src/models/Ad.js',
        'for real to read its schema paths — it does not guess at them with',
        'a regex. Fix: run `npm install` in this worktree, or',
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
  try {
    return require('mongoose');
  } catch (err) {
    console.error(
      [
        `verifyVideoMasterCloudinaryPublicId: cannot load "mongoose" even via`,
        `the sibling backend's node_modules (${candidateDir}). ${err.message}`,
        'Fix: run `npm install` in this worktree.'
      ].join('\n')
    );
    process.exit(1);
  }
}

function captureAdSchemaTopLevelPaths() {
  const mongoose = loadMongooseWithFallback();
  const origModel = mongoose.model.bind(mongoose);
  let captured = null;
  mongoose.model = function interceptedModel(name, schema) {
    if (!captured) captured = schema;
    return function StubModel() {};
  };
  try {
    delete require.cache[AD_MODEL_PATH];
    require(AD_MODEL_PATH);
  } finally {
    mongoose.model = origModel;
  }
  if (!captured) throw new Error('src/models/Ad.js never called mongoose.model(...) — cannot extract its schema');
  return new Set(Object.keys(captured.paths).map((p) => p.split('.')[0]));
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

function main() {
  const rendererSrc = fs.readFileSync(RENDERER_PATH, 'utf8');

  const extracted = extractTopLevelKeysAfter(rendererSrc, /const\s+\$setMaster\s*=\s*\{/);
  if (!extracted) {
    failures.push(
      'could not find `const $setMaster = { ... }` in src/services/renderer.js — ' +
      'has renderVideo()\'s master persist write been renamed or restructured? ' +
      'This harness needs to be re-pointed, not silently skipped.'
    );
  } else {
    const { keys, members } = extracted;

    check('$setMaster maps the video master to the literal key `cloudinaryPublicId`', () => {
      if (!keys.includes('cloudinaryPublicId')) {
        throw new Error(
          `$setMaster does not write a top-level \`cloudinaryPublicId\` key ` +
          `(found: ${keys.join(', ')}) — the raw Omni master's Cloudinary id ` +
          `will not persist`
        );
      }
    });

    check('$setMaster does NOT write the undeclared `veoCloudinaryPublicId` key', () => {
      if (keys.includes('veoCloudinaryPublicId')) {
        throw new Error(
          '$setMaster still writes `veoCloudinaryPublicId` — that path does not ' +
          'exist in either repo\'s models/Ad.js, so Mongoose strict mode silently ' +
          'drops it (the exact bug this harness exists to catch)'
        );
      }
    });

    check('$setMaster actually reads veoResult.cloudinaryPublicId as its source value', () => {
      // Test ONLY the `cloudinaryPublicId` member's own value text, not the
      // whole object body — a whole-body regex would also match a stale
      // comment, a commented-out old assignment, or a decoy value sitting on
      // a DIFFERENT key, and pass without the real key actually being
      // sourced correctly (flagged by an adversarial review pass — see
      // sourceLiteralScan.js's `members` doc comment). A fix that renamed the
      // key but pointed it at the wrong source (e.g. a titled-render URL
      // that doesn't exist yet at this point in renderVideo()) must still
      // fail this check.
      const idx = keys.indexOf('cloudinaryPublicId');
      const ownMember = idx === -1 ? '' : members[idx];
      if (!/^\s*cloudinaryPublicId\s*:\s*veoResult\.cloudinaryPublicId\b/.test(ownMember)) {
        throw new Error(
          '$setMaster.cloudinaryPublicId is not sourced from veoResult.cloudinaryPublicId ' +
          `(own member text: ${JSON.stringify(ownMember.trim().slice(0, 120))}) — confirm the ` +
          'raw master\'s Cloudinary id is still what gets persisted'
        );
      }
    });

    check('every non-spread $setMaster key is a declared src/models/Ad.js path', () => {
      const declared = captureAdSchemaTopLevelPaths();
      const undeclared = keys.filter((k) => !declared.has(k));
      if (undeclared.length) {
        throw new Error(
          `$setMaster writes field(s) NOT declared in src/models/Ad.js — Mongoose ` +
          `strict mode will silently drop these, no error, ever: ${undeclared.join(', ')}`
        );
      }
      info(`$setMaster's ${keys.length} top-level key(s) are all declared Ad.js paths: ${keys.join(', ')}`);
    });
  }

  const total = pass + failures.length;
  for (const line of infos) console.log(`  info: ${line}`);

  if (failures.length) {
    console.log(`\n❌ verifyVideoMasterCloudinaryPublicId: ${failures.length} of ${total} check(s) FAILED`);
    for (const f of failures) console.log(`   • ${f}`);
    process.exit(1);
  }
  console.log(`\n✅ verifyVideoMasterCloudinaryPublicId: ${total}/${total} check(s) passed`);
}

main();
