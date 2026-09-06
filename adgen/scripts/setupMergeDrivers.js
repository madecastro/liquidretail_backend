#!/usr/bin/env node
'use strict';
//
// setupMergeDrivers — one-time (per clone / per worktree) local git config
// so the custom merge driver in .gitattributes actually runs.
//
// WHY THIS HAS TO BE A SEPARATE STEP
// `git config merge.<name>.driver` lives in the repo's LOCAL config
// (.git/config), never in a committed file, and git does NOT read it from
// anywhere versioned — that is a deliberate git security property (a
// cloned repo cannot make your git run an arbitrary command without you
// opting in). .gitattributes only maps a PATH to a driver NAME; without
// this step that name resolves to nothing and git silently falls back to
// its default textual 3-way merge — i.e. exactly the conflict-prone
// behavior this driver exists to remove, with no error and no warning.
// A merge driver nobody configures is worse than no merge driver at all,
// because everyone assumes it is working.
//
// SAFE FOR ADGEN WORKTREES
// This script only runs `git config` (writes to .git/config or, for a
// linked worktree, the shared .git/config it points at — merge drivers are
// NOT per-worktree in git, they are per-repository). It does not run `npm
// install` / `npm ci` and does not touch node_modules — both of which are
// forbidden in an adgen worktree (see CLAUDE.md: verifyModelParity's
// Module._load fallback only installs when adgen's own `require(\'mongoose\')`
// fails, which a populated node_modules would break). Safe to run in any
// adgen worktree, the main checkout, or CI.
//
// USAGE
//   node scripts/setupMergeDrivers.js        (or: npm run setup:worktree)
//
// Idempotent — safe to run again; just overwrites the same two config keys
// with the same values.
//
const { execFileSync } = require('child_process');

const DRIVER_NAME = 'vendor-manifest';
const DRIVER_CMD = 'node scripts/mergeVendorManifest.js %O %A %B %P';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function main() {
  let root;
  try {
    root = git(['rev-parse', '--show-toplevel']);
  } catch (e) {
    console.error('setupMergeDrivers: not inside a git repository.');
    process.exit(1);
  }

  git(['config', `merge.${DRIVER_NAME}.name`, 'Regenerate scripts/vendor-manifest.json from the merged tree']);
  git(['config', `merge.${DRIVER_NAME}.driver`, DRIVER_CMD]);

  const configured = git(['config', `merge.${DRIVER_NAME}.driver`]);
  if (configured !== DRIVER_CMD) {
    console.error(`setupMergeDrivers: verification failed — read back "${configured}", expected "${DRIVER_CMD}".`);
    process.exit(1);
  }

  console.log(`setupMergeDrivers: configured merge.${DRIVER_NAME}.driver in ${root}/.git/config`);
  console.log('  scripts/vendor-manifest.json merges will now regenerate instead of textual 3-way merge.');
  console.log('  This is LOCAL config — every clone/worktree of this repo must run this once.');
}

main();
