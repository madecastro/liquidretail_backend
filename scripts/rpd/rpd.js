#!/usr/bin/env node
//
// rpd.js — Rapid Product Development harness CLI. A/B video models × prompt
// variants against the REAL production prompt builder, outside the Ad
// pipeline (no Mongo, no Ad rows, no CostLog). See scripts/rpd/README.md.
//
//   node scripts/rpd/rpd.js run <spec.json> [--live --max-usd N] [--out rpd-runs]
//   node scripts/rpd/rpd.js resume <runDir>
//   node scripts/rpd/rpd.js gallery <runDir>
//   node scripts/rpd/rpd.js note <runDir> <cellId|run> "text"
//   node scripts/rpd/rpd.js publish <runDir> [--project rs-rpd]
//   node scripts/rpd/rpd.js models
//
// Dry-run is the default; --live is the only billable door and requires
// --max-usd. Money invariants pinned by scripts/verifyRpdHarness.js.

require('dotenv').config();
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', 'config', 'defaults.env') });

const path = require('path');

function flag(args, name) {
  return args.some((a) => a === name || a.startsWith(`${name}=`));
}
// Supports both `--flag value` and `--flag=value`. A following token that is
// itself a flag is NOT a value — `--out --max-usd 5` must not name the run
// directory "--max-usd" (adversarial finding 5).
function flagValue(args, name) {
  const eq = args.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const next = args[i + 1];
  if (next == null || next.startsWith('--')) {
    throw new Error(`rpd: ${name} needs a value (got ${next == null ? 'nothing' : `"${next}"`})`);
  }
  return next;
}

// Titling pass over settled masters. Shared by `run --live` and `resume` so
// "finished" means the same thing on both paths: settled → master on disk →
// titled (when the spec asks for titling). Free — no Atlas spend — so it is
// safe to re-run; failures keep the master (untitled ≠ lost) and are retried
// on the next resume unless a titled file already exists.
async function titlePass(runDir, manifest) {
  const titlingSpec = manifest.spec && manifest.spec.titling;
  if (!titlingSpec || !titlingSpec.enabled) return;
  const { titleCell } = require('./lib/titling');
  const { writeManifest } = require('./lib/manifest');
  const eligible = manifest.cells.filter((c) => c.status === 'done' && c.localPath && !c.titledPath);
  for (const cell of eligible) {
    console.log(`🎬 titling ${cell.id}…`);
    const t0 = Date.now();
    const res = await titleCell({ runDir, cell, titlingSpec });
    cell.timings = cell.timings || {};
    cell.timings.titlingMs = Date.now() - t0;
    if (res.timings) cell.timings.titling = res.timings;
    if (res.ok) {
      cell.titledPath = path.relative(runDir, res.titledPath);
      delete cell.titlingError;
    } else {
      cell.titlingError = res.error; // master kept — untitled ≠ lost
      console.warn(`   ⚠️ titling failed (master kept): ${res.error}`);
    }
    writeManifest(runDir, manifest);
  }
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  if (cmd === 'run') {
    const specPath = args[0];
    if (!specPath || specPath.startsWith('--')) throw new Error('usage: rpd run <spec.json> [--live --max-usd N] [--out dir]');
    const { runSpec } = require('./lib/runner');
    const { buildGallery } = require('./lib/gallery');
    const live = flag(args, '--live');
    const maxUsd = flagValue(args, '--max-usd') != null ? Number(flagValue(args, '--max-usd')) : null;
    const outRoot = flagValue(args, '--out') || 'rpd-runs';
    const { runDir, manifest } = await runSpec(specPath, { live, maxUsd, outRoot });

    // Optional titling pass over settled masters (spec.titling.enabled).
    if (live) await titlePass(runDir, manifest);

    console.log(`\nGallery: ${buildGallery(runDir)}`);
    console.log(`Next: node scripts/rpd/rpd.js note ${runDir} <cellId|run> "observation"`);
    console.log(`      node scripts/rpd/rpd.js publish ${runDir}`);
    return;
  }

  if (cmd === 'resume') {
    const runDir = args[0];
    if (!runDir) throw new Error('usage: rpd resume <runDir>');
    const { resumeRun } = require('./lib/resume');
    const { buildGallery } = require('./lib/gallery');
    const manifest = await resumeRun(runDir);
    await titlePass(runDir, manifest); // free; makes resume finish cells the same way run does
    console.log(`Gallery: ${buildGallery(runDir)}`);
    return;
  }

  if (cmd === 'gallery') {
    const runDir = args[0];
    if (!runDir) throw new Error('usage: rpd gallery <runDir>');
    const { buildGallery } = require('./lib/gallery');
    console.log(buildGallery(runDir));
    return;
  }

  if (cmd === 'note') {
    const [runDir, scope, ...rest] = args;
    const text = rest.join(' ');
    if (!runDir || !scope || !text) throw new Error('usage: rpd note <runDir> <cellId|run> "text"');
    const { addNote } = require('./lib/manifest');
    const { buildGallery } = require('./lib/gallery');
    addNote(runDir, scope, text);
    console.log(`noted. Gallery: ${buildGallery(runDir)}`);
    return;
  }

  if (cmd === 'publish') {
    const runDir = args[0];
    if (!runDir) throw new Error('usage: rpd publish <runDir> [--project rs-rpd]');
    const { publishRun } = require('./lib/publish');
    const project = flagValue(args, '--project') || 'rs-rpd';
    publishRun(runDir, { project });
    return;
  }

  if (cmd === 'models') {
    const { MODEL_CAPS, estimateRenderCostUsd } = require('../../services/atlasVideoService');
    for (const [slug, caps] of Object.entries(MODEL_CAPS)) {
      const dur = caps.defaultDuration || 8;
      const res = caps.defaultResolution || '720p';
      const est = estimateRenderCostUsd({ model: slug, durationSec: dur, resolution: res });
      console.log(`\n${slug}`);
      console.log(`  label:       ${caps.label || '-'} ${caps.selectable ? '(operator-selectable)' : ''}`);
      console.log(`  paramShape:  ${caps.paramShape}   refs: ${caps.maxReferenceImages || 1}   promptByteCap: ${caps.promptByteCap || 4096}`);
      console.log(`  aspects:     ${(caps.supportedAspectRatios || []).join(', ') || '-'}`);
      console.log(`  duration:    ${caps.durationEnum ? caps.durationEnum.join('/') : `${caps.minDuration || '?'}-${caps.maxDuration || '?'}`}s (default ${dur})`);
      console.log(`  resolutions: ${(caps.resolutions || []).join(', ') || '-'} (default ${res})`);
      const { UNVERIFIED_PRICING_SLUGS } = require('./lib/runner');
      const unv = UNVERIFIED_PRICING_SLUGS.has(slug) ? ' ⚠️ RATE UNVERIFIED — settled price may differ in either direction' : '';
      console.log(`  est @ ${dur}s/${res}: ${est != null ? `~$${est.toFixed(2)} (floor-grade estimate — settled price is the truth)${unv}` : 'NO PRICING DATA (live runs refused)'}`);
      if (caps.requiresVideoSeed) console.log('  requires a VIDEO seed — skipped by the harness (image seeds only today)');
    }
    return;
  }

  console.error('rpd — rapid product development harness. Commands: run | resume | gallery | note | publish | models');
  console.error('See scripts/rpd/README.md');
  process.exit(cmd ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
