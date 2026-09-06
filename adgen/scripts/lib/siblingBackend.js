'use strict';
//
// siblingBackend — locates the liquidretail_backend checkout this repo was
// forked from, for the harnesses that need to compare against it
// (verifyRequireGraph.js's vendoring-gap note, verifyModelParity.js's whole
// job, verifyHandoffContract.js check E, verifyVendorDrift.js, …). Shared
// rather than copy-pasted per caller, same reasoning as the backend's own
// scripts/lib/sourceWalk.js: one definition means a fix to "how do we find
// the sibling repo" lands once, not once-per-caller.
//
// RESOLUTION ORDER
//   1. process.env.ADGEN_BACKEND_PATH, if set — explicit override, e.g. for
//      a CI box that checks out the backend somewhere non-standard. Post-
//      graft CI sets this to ${{ github.workspace }} (the monorepo root).
//   2. the parent of this repo's root. Post-graft, this checkout lives at
//      <backend>/adgen, so the parent IS the backend (confirmed by a
//      models/ directory at that path).
//   3. ../liquidretail_backend relative to this repo's root. Split-repo
//      checkouts (and worktrees git places as siblings of liquidretail_adgen)
//      still need this; do not delete it.
//
// A candidate "counts" only if it has a models/ directory — cheap proof
// it is really the backend repo and not an empty or unrelated directory.
//
// Returns the resolved absolute path, or null if nothing checked out.
//
// SKIP vs THROW
//   A checkout that only has adgen (narrow CI clone of the still-split
//   repo) genuinely cannot run a two-repo comparison. resolveBackendRoot
//   returns null there and callers may INFO-skip.
//   After the graft, the two trees ARE in one clone. Skipping then is a
//   silent false-green of the exact checks the graft exists to make real
//   (verifyModelParity used to print "✅ 0/0 checks run (skipped)";
//   verifyHandoffContract skipped inside check() so skip incremented pass).
//   assertBackendRoot() throws on a miss when this layout is a monorepo
//   (adgen/ is a child of a directory that has models/) OR when
//   ADGEN_REQUIRE_SIBLING is the string 'true'. ADGEN_REQUIRE_SIBLING has
//   no other JS readers; putting it on a workflow without this throw is
//   vacuous.
const fs = require('fs');
const path = require('path');

function isRealBackendCheckout(candidate) {
  try {
    return fs.statSync(path.join(candidate, 'models')).isDirectory();
  } catch (e) {
    return false;
  }
}

function isMonorepoLayout(repoRoot) {
  const root = path.resolve(repoRoot);
  const parent = path.resolve(root, '..');
  // Post-graft: this checkout is <backend>/adgen and the parent IS the backend.
  if (path.basename(root) === 'adgen' && isRealBackendCheckout(parent)) {
    try {
      return fs.existsSync(path.join(parent, 'adgen', 'package.json'));
    } catch (e) {
      return false;
    }
  }
  // Caller passed the monorepo root itself (adgen/ is a child).
  try {
    return isRealBackendCheckout(root) && fs.existsSync(path.join(root, 'adgen', 'package.json'));
  } catch (e) {
    return false;
  }
}

function siblingRequired(repoRoot) {
  if (String(process.env.ADGEN_REQUIRE_SIBLING || '').toLowerCase() === 'true') return true;
  return isMonorepoLayout(repoRoot);
}

function resolveBackendRoot(repoRoot) {
  const candidates = [];
  if (process.env.ADGEN_BACKEND_PATH) candidates.push(process.env.ADGEN_BACKEND_PATH);
  candidates.push(path.join(repoRoot, '..'));
  candidates.push(path.join(repoRoot, '..', 'liquidretail_backend'));
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (isRealBackendCheckout(resolved)) return resolved;
  }
  return null;
}

function assertBackendRoot(repoRoot) {
  const resolved = resolveBackendRoot(repoRoot);
  if (resolved) return resolved;
  if (siblingRequired(repoRoot)) {
    throw new Error(
      'sibling liquidretail_backend is required in this layout (monorepo adgen/ ' +
      'prefix, or ADGEN_REQUIRE_SIBLING=true) but resolveBackendRoot returned null. ' +
      'Checked ADGEN_BACKEND_PATH, the parent directory, and ../liquidretail_backend.'
    );
  }
  return null;
}

module.exports = {
  resolveBackendRoot,
  assertBackendRoot,
  isMonorepoLayout,
  siblingRequired,
  isRealBackendCheckout
};
