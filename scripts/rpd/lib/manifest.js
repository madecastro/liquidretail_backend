// scripts/rpd/lib/manifest.js — run-directory state for the RPD harness.
//
// The manifest is the spend ledger: every predictionId is a receipt for real
// money, so it is flushed to disk atomically (tmp + rename) around every
// state change — a crash between submit and poll must never lose a receipt.

const fs = require('fs');
const path = require('path');

function manifestPath(runDir) {
  return path.join(runDir, 'manifest.json');
}

function readManifest(runDir) {
  const p = manifestPath(runDir);
  if (!fs.existsSync(p)) throw new Error(`rpd: no manifest at ${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeManifest(runDir, manifest) {
  const p = manifestPath(runDir);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
  fs.renameSync(tmp, p);
  return p;
}

function addNote(runDir, scope, text) {
  const manifest = readManifest(runDir);
  const note = { at: new Date().toISOString(), text: String(text) };
  if (scope === 'run') {
    manifest.observations = manifest.observations || [];
    manifest.observations.push({ ...note, scope: 'run' });
  } else {
    const cell = (manifest.cells || []).find((c) => c.id === scope);
    if (!cell) {
      const ids = (manifest.cells || []).map((c) => c.id).join('\n  ');
      throw new Error(`rpd: no cell "${scope}" in this run. Cells:\n  ${ids}`);
    }
    cell.notes = cell.notes || [];
    cell.notes.push(note);
  }
  writeManifest(runDir, manifest);
  return manifest;
}

module.exports = { manifestPath, readManifest, writeManifest, addNote };
