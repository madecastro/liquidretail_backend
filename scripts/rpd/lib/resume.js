// scripts/rpd/lib/resume.js — finish an interrupted RPD run for FREE.
//
// Re-polls every cell that holds a predictionId receipt but is not settled,
// downloads outputs, and reconciles settled prices. STRUCTURALLY INCAPABLE
// OF SPENDING: this module imports only atlasPoll + manifest — it must never
// reference the billable submit path or assemble a request body (the verify
// harness scans this file's text for those identifiers, which is why this
// comment names neither). A cell that failed BEFORE a receipt existed stays
// failed; re-running it is a new experiment the operator triggers
// deliberately with `rpd run`.
// (Same invariant shape as services/titlingResumeService — pinned by
// scripts/verifyRpdHarness.js.)

const { readManifest, writeManifest } = require('./manifest');
const { settleCell, fetchSettledPrice } = require('./atlasPoll');

async function resumeRun(runDir) {
  const manifest = readManifest(runDir);
  const cells = manifest.cells || [];

  const unsettled = cells.filter((c) => c.predictionId && (c.status === 'submitted' || c.status === 'submitting'));
  const unpriced = cells.filter((c) => c.predictionId && c.status === 'done' && c.costSource !== 'actual');

  if (!unsettled.length && !unpriced.length) {
    console.log('rpd resume: nothing to do — every receipt is settled and priced.');
    return manifest;
  }

  console.log(`rpd resume: ${unsettled.length} unsettled receipt(s), ${unpriced.length} unpriced done cell(s). Polling (free)…`);
  for (const cell of unsettled) {
    try {
      await settleCell(cell, runDir);
    } catch (err) {
      cell.error = `resume poll failed: ${err.message}`;
    }
    writeManifest(runDir, manifest);
    console.log(`  ${cell.status === 'done' ? '✅' : '⚠️'} ${cell.id}: ${cell.status}${cell.error ? ` (${cell.error})` : ''}`);
  }

  for (const cell of unpriced) {
    const price = await fetchSettledPrice(cell.predictionId);
    if (price != null) {
      cell.costUsd = price;
      cell.costSource = 'actual';
      writeManifest(runDir, manifest);
      console.log(`  💲 ${cell.id}: settled price $${price.toFixed(2)}`);
    }
  }

  return manifest;
}

module.exports = { resumeRun };
