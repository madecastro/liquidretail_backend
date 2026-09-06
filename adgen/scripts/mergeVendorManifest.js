#!/usr/bin/env node
'use strict';
//
// mergeVendorManifest — git merge driver for scripts/vendor-manifest.json.
//
// WHY THIS EXISTS
// vendor-manifest.json is a GENERATED file (scripts/lib/vendorDrift.js
// `saveManifest`, invoked by `verifyVendorDrift.js --seed` / `--reconcile`).
// It was the single most merge-conflicted path in the repo (9 of the last
// 38 merges) purely because git's default textual 3-way merge diffs lines,
// and two unrelated `--reconcile` calls on different files land their new
// JSON keys near each other in the sorted object and collide as a line
// conflict even though the actual changes never overlap. Hand-resolving
// that is pure waste: there is a mechanically correct answer (recompute the
// manifest from the merged tree), so this driver does that instead of
// asking a human to eyeball JSON.
//
// WHAT THIS DOES
//   1. Parses the three versions git hands it (ancestor / ours / theirs).
//   2. 3-way merges the `files` map AT THE KEY LEVEL (per vendored path),
//      not as text. A key changed by only one side wins trivially. A key
//      changed identically by both sides is a no-op. A key changed
//      DIFFERENTLY by both sides (e.g. two branches independently
//      reconciled the same vendored file with different reasons) is a
//      real conflict — this driver does not guess; it fails the merge and
//      prints both values so a human can pick.
//   3. For anything new in the merged working tree (a file either branch
//      newly vendored) that has no manifest entry yet, it re-derives an
//      entry from the ACTUAL current backend + current src/ tree — this is
//      the "re-run the generator" step, using the exact same
//      discoverVendored/findDeadServices primitives verifyVendorDrift.js
//      itself uses, not a reimplementation.
//   4. Verifies the merged result the same way `verifyVendorDrift.js`
//      would: no untracked, no stale, no vendored-but-dead entries. Any of
//      those FAILS the merge (loudly) rather than silently committing a
//      manifest that would just turn around and fail CI five minutes
//      later. Backend drift / held forks are informational only — they
//      are "has a human looked lately", an orthogonal question the act of
//      merging two branches cannot answer, so this driver does not block
//      on them.
//   5. If the sibling backend checkout is not present, steps 3 and 4 are
//      skipped with an info line (same "backend absent -> skip" contract
//      verifyVendorDrift.js uses) and only the pure key-level JSON merge
//      runs. That still resolves the large majority of real conflicts
//      (disjoint --reconcile additions) with zero backend dependency.
//
// KNOWN NON-DETERMINISM — READ BEFORE TRUSTING A "CLEAN" MERGE
// The manifest's top-level `generatedAt` (wall-clock ISO timestamp) and
// `backendHead` (the sibling backend's live origin/main SHA at the moment
// of writing) are NOT deterministic functions of repo content: the same
// logical merge run a minute apart, or with backend having advanced a
// commit in between, produces different bytes in those two fields even
// when every `files` entry is identical. This driver reproduces that
// existing behavior (it calls the same `saveManifest` the real generator
// uses) rather than inventing a different, divergent format. It is safe
// only because `loadManifest()` / `verifyVendorDrift.js` never read those
// two fields back for pass/fail — they are bookkeeping, not a checked
// input (confirmed by reading scripts/lib/vendorDrift.js: `loadManifest`
// validates only `version` and `files`). A `git diff` of a driver-produced
// commit will still show `generatedAt`/`backendHead` churn even when no
// vendored file actually changed — that is expected, not a driver bug.
// See session.md / the PR description for the recommendation to stop
// writing these two fields on every mechanical write, which would remove
// the last source of non-determinism; this driver does not make that
// schema change unilaterally.
//
// INVOCATION (see .gitattributes + scripts/setupMergeDrivers.js)
//   git config merge.vendor-manifest.driver \
//     "node scripts/mergeVendorManifest.js %O %A %B %P"
// %O ancestor, %A ours (OVERWRITTEN with the result), %B theirs, %P the
// real path (used only for log messages). Exit 0 = resolved, git stages
// the rewritten %A. Exit non-zero = conflict; %A is left as git's default
// "ours" copy (valid JSON, never corrupted with conflict markers — this
// script does not touch %A at all in the failure path) and the conflicting
// keys are printed to stderr for a human to hand-edit.
//
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function readJsonLenient(p) {
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    return null;
  }
  if (!raw || !raw.trim()) return null;
  return JSON.parse(raw);
}

function fail(msg) {
  process.stderr.write(`mergeVendorManifest: ${msg}\n`);
  process.exit(1);
}

function repoRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch (e) {
    // Fall back to two levels up from this file (scripts/mergeVendorManifest.js).
    return path.join(__dirname, '..');
  }
}

function main() {
  const [ancestorPath, oursPath, theirsPath, origPath] = process.argv.slice(2);
  if (!ancestorPath || !oursPath || !theirsPath) {
    fail('expected three paths: <ancestor> <ours> <theirs> [<orig-path>]; check merge.vendor-manifest.driver in .gitattributes / git config');
  }
  const displayPath = origPath || 'scripts/vendor-manifest.json';

  const ROOT = repoRoot();
  const vendorDrift = require(path.join(ROOT, 'scripts', 'lib', 'vendorDrift.js'));
  const { resolveBackendRoot } = require(path.join(ROOT, 'scripts', 'lib', 'siblingBackend.js'));
  const {
    MANIFEST_VERSION,
    normalizeEntry,
    sortManifest,
    saveManifest,
    discoverVendored,
    resolveBackendRef,
    resolveRefSha,
    findDeadServices,
  } = vendorDrift;

  let ancestor;
  let ours;
  let theirs;
  try {
    ancestor = readJsonLenient(ancestorPath) || { version: MANIFEST_VERSION, files: {} };
    ours = readJsonLenient(oursPath);
    theirs = readJsonLenient(theirsPath);
  } catch (err) {
    fail(`one of the three inputs is not valid JSON — ${err.message}. Resolve ${displayPath} by hand.`);
  }
  if (!ours || !theirs) {
    fail(`ours or theirs side of ${displayPath} is missing/empty — cannot regenerate. Resolve by hand.`);
  }
  for (const [label, m] of [['ours', ours], ['theirs', theirs]]) {
    if (m.version !== MANIFEST_VERSION) {
      fail(`${label} side of ${displayPath} has version ${m.version}, expected ${MANIFEST_VERSION} — schema change, resolve by hand.`);
    }
  }

  const ancestorFiles = (ancestor && ancestor.files) || {};
  const oursFiles = ours.files || {};
  const theirsFiles = theirs.files || {};

  function normOrNull(entry, rel, side) {
    if (entry === undefined) return undefined;
    try {
      return normalizeEntry(rel, entry);
    } catch (err) {
      fail(`${side} entry for ${rel} in ${displayPath} is malformed — ${err.message}`);
    }
  }
  function key(entry) {
    return entry === undefined ? undefined : JSON.stringify(entry);
  }

  const allKeys = new Set([
    ...Object.keys(ancestorFiles),
    ...Object.keys(oursFiles),
    ...Object.keys(theirsFiles),
  ]);

  const merged = {};
  const trueConflicts = [];

  for (const rel of allKeys) {
    const o = normOrNull(ancestorFiles[rel], rel, 'ancestor');
    const a = normOrNull(oursFiles[rel], rel, 'ours');
    const b = normOrNull(theirsFiles[rel], rel, 'theirs');
    const ka = key(a);
    const kb = key(b);
    const ko = key(o);

    if (ka === kb) {
      if (a !== undefined) merged[rel] = a; // identical on both sides (or both deleted)
      continue;
    }
    if (ka === ko) {
      // ours unchanged from ancestor -> take theirs (add/modify/delete)
      if (b !== undefined) merged[rel] = b;
      continue;
    }
    if (kb === ko) {
      // theirs unchanged from ancestor -> take ours
      if (a !== undefined) merged[rel] = a;
      continue;
    }
    // Both sides changed this key, disagreeing with each other AND the ancestor.
    trueConflicts.push({ rel, ancestor: o, ours: a, theirs: b });
  }

  if (trueConflicts.length) {
    const lines = [
      `${trueConflicts.length} vendor-manifest.json key(s) were reconciled differently by both sides — cannot mechanically pick a winner:`,
    ];
    for (const c of trueConflicts) {
      lines.push(`  ${c.rel}`);
      lines.push(`    ours:   ${JSON.stringify(c.ours)}`);
      lines.push(`    theirs: ${JSON.stringify(c.theirs)}`);
    }
    lines.push('');
    lines.push(`${displayPath} was left untouched (git’s "ours" copy). Edit the "files" entries above by hand,`);
    lines.push('then `git add scripts/vendor-manifest.json` and continue the merge/rebase.');
    process.stderr.write(lines.join('\n') + '\n');
    process.exit(1);
  }

  // No key-level conflicts. Re-run the generator against the CURRENT
  // working tree (which, by the time this driver runs, already reflects
  // the merge for every other path) to pick up anything newly vendored
  // that neither side's manifest recorded yet, and to verify the result.
  const backendRoot = resolveBackendRoot(ROOT);
  let info = [];
  let blocking = [];

  if (backendRoot) {
    const backendRef = resolveBackendRef(backendRoot);
    const backendHead = backendRef ? resolveRefSha(backendRoot, backendRef) : null;
    const discovered = discoverVendored(ROOT, backendRoot, backendRef, { includeSha: true });

    const deadCheckRels = new Set(Object.keys(merged));
    for (const v of discovered) deadCheckRels.add(v.rel);
    const { dead } = findDeadServices({
      adgenRoot: ROOT,
      vendoredRels: [...deadCheckRels],
      unusedSet: new Set(Object.keys(merged).filter((rel) => merged[rel] && merged[rel].status === 'unused')),
    });
    const deadSet = new Set(dead);

    let seeded = 0;
    for (const v of discovered) {
      if (merged[v.rel]) continue; // already covered by the key-level merge above
      let status;
      let reason;
      if (deadSet.has(v.rel)) {
        status = 'unused';
        reason = 'auto-seeded by merge driver: no src/ requirer found at merge time; replace this reason or wire a caller';
      } else if (v.identical === false) {
        status = 'fork';
        reason = 'auto-seeded by merge driver: adgen bytes differ from backend at merge time; replace with a real reason via --reconcile';
      } else {
        status = 'synced';
        reason = undefined;
      }
      merged[v.rel] = { backendHash: v.backendHash, backendSha: v.backendSha || null, status, reason };
      seeded += 1;
    }
    if (seeded) info.push(`auto-seeded ${seeded} newly-vendored file(s) discovered in the merged tree`);

    // Verify: recompute discovered/merged against reality. untracked and
    // dead should now be empty by construction; stale means a manifest
    // entry survives for a file the merge removed from src/ or backend.
    const discoveredRels = new Set(discovered.map((v) => v.rel));
    const stillUntracked = discovered.filter((v) => !merged[v.rel]);
    const stale = Object.keys(merged).filter((rel) => !discoveredRels.has(rel));
    const { dead: deadAfter } = findDeadServices({
      adgenRoot: ROOT,
      vendoredRels: [...discoveredRels],
      unusedSet: new Set(Object.keys(merged).filter((rel) => merged[rel] && merged[rel].status === 'unused')),
    });

    if (stillUntracked.length) {
      blocking.push(`${stillUntracked.length} vendored file(s) still untracked after auto-seed (driver bug, not a normal conflict): ${stillUntracked.map((v) => v.rel).join(', ')}`);
    }
    if (stale.length) {
      blocking.push(`${stale.length} manifest entr(y/ies) now stale (file no longer vendored/found): ${stale.join(', ')}. Remove by hand or --reconcile.`);
    }
    if (deadAfter.length) {
      blocking.push(`${deadAfter.length} vendored service module(s) have no requirer after this merge: ${deadAfter.join(', ')}. Wire a caller or --reconcile --unused --reason "..."`);
    }

    // Drift / forks-held are informational: "has a human looked lately" is
    // orthogonal to whether these two branches merge cleanly.
    const drifted = discovered.filter((v) => merged[v.rel] && merged[v.rel].backendHash !== v.backendHash);
    if (drifted.length) {
      info.push(`${drifted.length} file(s) have backend drift pre-existing this merge (unrelated to the merge itself; run verifyVendorDrift.js): ${drifted.map((v) => v.rel).join(', ')}`);
    }

    if (blocking.length) {
      process.stderr.write(
        [`mergeVendorManifest: merged file failed verification, not writing ${displayPath}:`, ...blocking.map((b) => `  ${b}`)].join('\n') + '\n'
      );
      process.exit(1);
    }
  } else {
    info.push('sibling liquidretail_backend not found (ADGEN_BACKEND_PATH or ../liquidretail_backend) — key-level merge only, no auto-seed/verify');
  }

  const result = {
    version: MANIFEST_VERSION,
    backendRef: backendRoot ? resolveBackendRef(backendRoot) : (ours.backendRef || theirs.backendRef || null),
    backendHead: null,
    generatedAt: new Date().toISOString(),
    files: merged,
  };
  if (backendRoot) {
    result.backendHead = result.backendRef ? resolveRefSha(backendRoot, result.backendRef) : null;
  } else {
    result.backendHead = ours.backendHead || theirs.backendHead || null;
  }

  saveManifest(oursPath, sortManifest(result));

  for (const line of info) process.stderr.write(`mergeVendorManifest: info: ${line}\n`);
  process.stderr.write(`mergeVendorManifest: regenerated ${displayPath} cleanly (${Object.keys(merged).length} file(s)).\n`);
  process.exit(0);
}

main();
