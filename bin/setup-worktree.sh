#!/usr/bin/env bash
# bin/setup-worktree.sh — fix the documented worktree gaps (CLAUDE.md header +
# §4 "Repo traps") in one step, so a fresh `git worktree add` doesn't cost you
# an hour discovering environmental failures that look like real code bugs.
#
# Background: `node_modules` is gitignored but ~4,930 files are tracked from
# before the ignore rule was added, so a fresh worktree checkout gets a
# PARTIAL node_modules for free — enough to run most things, but missing (at
# least — this is the committed subset's known gap list, not a guarantee
# nothing else is missing):
#   - https-proxy-agent (anything importing axios, e.g. atlasVideoService,
#     throws MODULE_NOT_FOUND without it)
#   - sharp entirely (it's a native module and was never committed; three
#     verify* harnesses need it — as of 2026-08-19 they `require('sharp')`
#     normally, so a plain install here is all they need, no path hacks)
#   - jsonwebtoken (used by middleware/requireAuth.js, routes/auth.js, and
#     others — also missing from the committed subset. Previously this was
#     only ever installed as a side effect of `npm install --no-save
#     https-proxy-agent@...` reconciling the whole tree against
#     package-lock.json, which happened to pull it in too — undocumented and
#     not guaranteed to keep happening on a future `npm` version, so it now
#     gets its own explicit install step below like the other two.)
#
# This script installs all three WITHOUT touching package.json/package-lock.json
# (matching the documented `--no-save` remedy), restores the tracked
# node_modules/.package-lock.json afterwards so `npm install` doesn't leave
# an uncommitted diff in a tracked file, then runs the verify suite so you
# know your worktree is clean before you start real work.
#
# Usage (from anywhere inside the worktree):
#   bin/setup-worktree.sh
#   npm run setup:worktree      # same thing, via package.json
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "== liquidretail_backend: worktree setup =="
echo "   root: $(pwd)"

if [ ! -d node_modules ]; then
  echo "!! node_modules is entirely missing — this doesn't look like a checkout of this repo"
  echo "   (node_modules is gitignored but thousands of files are tracked; a normal"
  echo "   'git worktree add' or 'git clone' should have brought them along)."
  exit 1
fi

if [ ! -d node_modules/https-proxy-agent ]; then
  echo "-- installing https-proxy-agent@5.0.1 (missing from the committed node_modules subset)"
  npm install --no-save https-proxy-agent@5.0.1
else
  echo "-- https-proxy-agent already present, skipping"
fi

if [ ! -d node_modules/sharp ]; then
  # Pinned to the exact version package.json declares (^0.33.5, which for a
  # 0.x range only floats the patch — 0.33.5 is effectively the only version
  # in practice). An earlier version of this line installed plain `sharp`
  # with no version at all, which grabs npm's CURRENT latest regardless of
  # package.json — unlike https-proxy-agent right above, which was already
  # pinned. That matters here specifically because
  # verifyLogoColorPreservation.js's L1 checks assert a documented,
  # version-specific bug in sharp@0.33.5's `.extract().stats()`: a different
  # version can behave differently there, silently changing what the harness
  # actually verifies. The harness itself now also asserts its loaded sharp
  # version explicitly, so a mismatch (e.g. a nested worktree resolving a
  # parent checkout's different copy — see the node_modules note above) fails
  # loud instead of running version-sensitive checks against the wrong build.
  echo "-- installing sharp@0.33.5 (native module, never committed; pinned to match package.json)"
  npm install --no-save sharp@0.33.5
else
  echo "-- sharp already present, skipping"
fi

if [ ! -d node_modules/jsonwebtoken ]; then
  echo "-- installing jsonwebtoken (missing from the committed node_modules subset)"
  npm install --no-save jsonwebtoken
else
  echo "-- jsonwebtoken already present, skipping"
fi

# npm install above rewrites the tracked node_modules/.package-lock.json even
# with --no-save. Restore it from git so this script never leaves an
# uncommitted diff in a tracked file (per CLAUDE.md §4 — stage explicit
# paths, never `git add -A`, applies just as much to "undo this file").
if git ls-files --error-unmatch node_modules/.package-lock.json >/dev/null 2>&1; then
  if ! git diff --quiet -- node_modules/.package-lock.json 2>/dev/null; then
    echo "-- restoring tracked node_modules/.package-lock.json"
    git checkout -- node_modules/.package-lock.json
  fi
fi

# .codegraph/codegraph.db is gitignored (see .codegraph/.gitignore) and
# CodeGraph resolves the nearest .codegraph/ walking up from cwd, so a fresh
# worktree has no index of its own and either refuses or, worse, silently
# resolves a DIFFERENT checkout's index if one happens to be an ancestor
# directory — stale relative to this worktree's actual commit. Build one
# local to this worktree; it's fast (~1-2s for this repo).
if command -v codegraph >/dev/null 2>&1; then
  if [ ! -f .codegraph/codegraph.db ]; then
    echo "-- building codegraph index for this worktree (not inherited from the main checkout)"
    codegraph init || echo "!! codegraph init failed — continuing without it"
  else
    echo "-- codegraph index already present, syncing"
    codegraph sync -q || echo "!! codegraph sync failed — continuing with existing index"
  fi
else
  echo "-- codegraph not installed, skipping index build"
fi

echo
echo "== running the verify suite to confirm the worktree is clean =="
node scripts/runVerifySuite.js
