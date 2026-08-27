'use strict';
//
// mongooseLoader — load a mongoose instance in a BARE adgen worktree.
//
// Extracted verbatim from scripts/verifyModelParity.js (2026-08-27) so the
// second harness that needs it (verifyHandoffContract.js) shares ONE
// definition instead of carrying a copy. This repo's whole vendor-drift
// problem is duplicated logic drifting apart; duplicating a loader THIS
// subtle would have been the wrong way to add a harness about that.
//
// ── WHY THE PATCH IS NOT RESTORED (the subtle part — do not "fix" it) ──
// CLAUDE.md documents this as a tooling trap with measured numbers: a bare
// worktree passes verifyModelParity 33/33; an `npm ci`'d or NODE_PATH-set
// one fails 33/33 with "never called mongoose.model(...) — cannot extract a
// schema", which reads exactly like a real schema-parity defect and is not
// one.
//
// The mechanism: this repo's own `require('mongoose')` must FAIL first.
// Only then is the Module._load patch installed — and it is deliberately
// LEFT INSTALLED for the rest of the process. That is not an oversight. The
// caller goes on to require dozens of model files, each doing its own bare
// `const mongoose = require('mongoose')`. Those requires happen AFTER this
// function returns, so if the patch were restored on the way out they would
// all fail, and every model would report "never called mongoose.model(...)".
// The patch is what makes them all resolve to the SAME instance, which is
// the assumption the mongoose.model() intercept depends on.
//
// So: never `npm ci` an adgen worktree, never set NODE_PATH here, and never
// restore this patch. In CI (`npm ci` has run) the first require succeeds
// and no patch is installed at all — the fallback is a local-worktree
// affordance only.
//
// Resolution order: the requiring file's OWN node_modules always wins,
// because origLoad.apply() is tried before the fallback. Only a BARE
// specifier that fails normal resolution gets the second attempt against
// the sibling backend's node_modules — never a relative or absolute path.
//
const fs = require('fs');
const path = require('path');
const Module = require('module');

// `harnessName` only shapes the error text, so a failure names the script
// the developer actually ran. `backendRoot` is the sibling checkout (or
// null), normally from scripts/lib/siblingBackend.js resolveBackendRoot().
//
// `onUnavailable` decides what "no mongoose anywhere" means for the caller,
// because the two harnesses genuinely differ:
//   * verifyModelParity's ENTIRE job is comparing real Schema objects, so
//     it must exit 1 — the default.
//   * verifyHandoffContract has four other checks that need no mongoose, so
//     it passes a callback that returns null and INFO-skips one check
//     rather than failing the suite for a missing dev dependency.
function loadMongooseWithFallback({ harnessName, backendRoot, onUnavailable } = {}) {
  const name = harnessName || 'harness';
  const bail = (lines) => {
    if (typeof onUnavailable === 'function') return onUnavailable(lines.join('\n'));
    console.error(lines.join('\n'));
    process.exit(1);
  };

  try {
    return require('mongoose');
  } catch (err) {
    if (!err || err.code !== 'MODULE_NOT_FOUND') throw err;
  }

  const candidateDir = backendRoot ? path.join(backendRoot, 'node_modules') : null;
  if (!candidateDir || !fs.existsSync(candidateDir)) {
    return bail([
      `${name}: cannot load "mongoose" (MODULE_NOT_FOUND) and no`,
      'sibling liquidretail_backend/node_modules was found to fall back to.',
      'This needs a real mongoose to construct Schema objects — it is not',
      'faked with a regex — so it genuinely needs mongoose installed.',
      'Fix: run `npm install` in this worktree, or',
      '`export NODE_PATH=<path-to-a-node_modules-containing-mongoose>`.',
      '(But read CLAUDE.md first: doing either in an adgen worktree breaks',
      ' verifyModelParity.js. Prefer running from a bare worktree with the',
      ' sibling liquidretail_backend checked out alongside it.)',
    ]);
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
  // NOT restored — see the header. Every later bare require('mongoose') in
  // this process must resolve to the same instance this call returns.
  try {
    return require('mongoose');
  } catch (err) {
    return bail([
      `${name}: cannot load "mongoose" even via the sibling`,
      `backend's node_modules (${candidateDir}). ${err.message}`,
      'Fix: run `npm install` in this worktree.',
    ]);
  }
}

module.exports = { loadMongooseWithFallback };
