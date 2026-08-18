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

const fs = require('fs');
const path = require('path');
const { readManifest, writeManifest } = require('./manifest');
const { settleCell, fetchSettledPrice, downloadVideo } = require('./atlasPoll');

// STATIC RECOVERY. A static cell whose editImage call died mid-poll is marked
// `failed`, but its receipt may name a prediction Atlas went on to COMPLETE —
// i.e. a plate we already paid for. peekImagePrediction is a free GET, so
// recovering it costs nothing and not recovering it wastes the charge. Only
// ever reads: no submit, no regenerate. (Mirrors the intent of
// atlasImageService.resumeImageForAd for the Ad path.)
async function recoverStaticCells(runDir, manifest, cells) {
  const candidates = cells.filter((c) =>
    c.kind === 'static'
    && !c.localPath
    && Array.isArray(c.predictionIds) && c.predictionIds.length
  );
  if (!candidates.length) return 0;
  const { peekImagePrediction } = require('../../../services/atlasImageService');
  let recovered = 0;
  for (const cell of candidates) {
    // Newest receipt first: a resubmit means the later prediction is the one
    // that was expected to produce the plate.
    for (const id of [...cell.predictionIds].reverse()) {
      let peek;
      try { peek = await peekImagePrediction(id); } catch (err) { peek = { state: 'unknown', message: err.message }; }
      if (peek.state !== 'done' || !peek.imageUrl) continue;
      const rel = path.join('cells', cell.id, 'plate.png');
      try {
        await downloadVideo(peek.imageUrl, path.join(runDir, rel)); // generic streamed GET
        cell.localPath = rel;
        cell.status = 'done';
        cell.charged = true;
        cell.recoveredFrom = id;
        delete cell.error;
        try { cell.timings = { ...(cell.timings || {}), outputBytes: fs.statSync(path.join(runDir, rel)).size }; } catch { /* non-fatal */ }
        if (peek.priceConfirmed && Number(peek.price) > 0) {
          cell.costUsd = Number(peek.price);
          cell.costSource = 'actual';
        }
        recovered++;
        writeManifest(runDir, manifest);
        console.log(`  ♻️  ${cell.id}: recovered a PAID plate from receipt ${id}`);
      } catch (err) {
        console.warn(`  ⚠️  ${cell.id}: found a completed prediction but could not download it — ${err.message}`);
      }
      break;
    }
  }
  return recovered;
}

async function resumeRun(runDir) {
  const manifest = readManifest(runDir);
  const cells = manifest.cells || [];

  // Video receipts: submitted/submitting cells still need polling.
  const unsettled = cells.filter((c) => c.kind !== 'static' && c.predictionId && (c.status === 'submitted' || c.status === 'submitting'));
  const unpriced = cells.filter((c) => c.predictionId && c.status === 'done' && c.costSource !== 'actual');
  const staticOrphans = cells.filter((c) => c.kind === 'static' && !c.localPath && Array.isArray(c.predictionIds) && c.predictionIds.length);

  if (!unsettled.length && !unpriced.length && !staticOrphans.length) {
    console.log('rpd resume: nothing to do — every receipt is settled and priced.');
    return manifest;
  }

  console.log(
    `rpd resume: ${unsettled.length} unsettled video receipt(s), ${staticOrphans.length} static receipt(s) without a plate, ` +
    `${unpriced.length} unpriced done cell(s). Polling (free)…`
  );
  await recoverStaticCells(runDir, manifest, cells);
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
