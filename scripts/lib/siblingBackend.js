'use strict';
//
// siblingBackend — locates the liquidretail_backend checkout this repo was
// forked from, for the two harnesses that need to compare against it
// (verifyRequireGraph.js's vendoring-gap note, verifyModelParity.js's whole
// job). Shared rather than copy-pasted twice, same reasoning as the
// backend's own scripts/lib/sourceWalk.js: one definition means a fix to
// "how do we find the sibling repo" lands once, not once-per-caller.
//
// RESOLUTION ORDER
//   1. process.env.ADGEN_BACKEND_PATH, if set — explicit override, e.g. for
//      a CI box that checks out the backend somewhere non-standard.
//   2. ../liquidretail_backend relative to this repo's root. This repo's own
//      README documents the fork relationship, and every checkout observed
//      so far (main checkout and every git worktree, which git places as a
//      sibling directory, never nested inside) puts both repos as direct
//      children of the same parent — so this candidate resolves correctly
//      whether ROOT is .../RS/liquidretail_adgen or .../RS/.wt-<name>.
//
// A candidate "counts" only if it has a models/ directory — cheap proof
// it is really the backend repo and not an empty or unrelated directory.
//
// Returns the resolved absolute path, or null if nothing checked out.
// Callers MUST treat null as "skip the cross-repo check with an INFO line",
// never as a failure — a checkout that only has adgen (e.g. a narrow CI
// clone) genuinely cannot run a two-repo comparison, and that is different
// from a bug in either repo.
const fs = require('fs');
const path = require('path');

function isRealBackendCheckout(candidate) {
  try {
    return fs.statSync(path.join(candidate, 'models')).isDirectory();
  } catch (e) {
    return false;
  }
}

function resolveBackendRoot(repoRoot) {
  const candidates = [];
  if (process.env.ADGEN_BACKEND_PATH) candidates.push(process.env.ADGEN_BACKEND_PATH);
  candidates.push(path.join(repoRoot, '..', 'liquidretail_backend'));
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (isRealBackendCheckout(resolved)) return resolved;
  }
  return null;
}

module.exports = { resolveBackendRoot };
