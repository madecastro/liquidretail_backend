// scripts/rpd/lib/geminiPoll.js — FREE Gemini reads for the RPD harness:
// poll an interaction to settlement, read its settled cost, download output.
//
// Mirrors atlasPoll.js's contract exactly (pollToSettlement / settleCell)
// so runner.js can treat both providers uniformly and resume.js can import
// this module without gaining any way to spend — same invariant shape as
// atlasPoll.js (pinned by scripts/verifyRpdHarness.js section B).
//
// MONEY RULE: nothing in this file may submit. It calls only
// geminiVideoService.peekInteraction (a free GET) and
// geminiVideoService.downloadOutputToBuffer (a free GET of the delivered
// file) — never submitGeneration.

const fs = require('fs');
const path = require('path');
const {
  peekInteraction,
  classifyPoll,
  extractVideoUri,
  downloadOutputToBuffer,
  computeCost,
  MAX_POLL_MS,
  POLL_INTERVAL_MS
} = require('../../../src/services/geminiVideoService');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll one interaction until terminal or the budget runs out. Polls are
// free; a timeout leaves the receipt in the manifest for a later
// `rpd resume`. Same MAX_POLL_MS / POLL_INTERVAL_MS the production
// renderer uses, imported rather than re-guessed.
async function pollToSettlement(interactionId, { onTick = null } = {}) {
  const start = Date.now();
  for (;;) {
    const body = await peekInteraction(interactionId);
    const verdict = classifyPoll(body);
    if (verdict.state !== 'pending') return { verdict, body };
    if (Date.now() - start > MAX_POLL_MS) {
      return {
        verdict: { state: 'timeout', billed: 'possible' },
        body,
        message: `still pending after ${Math.round((Date.now() - start) / 1000)}s — receipt kept; run \`rpd resume\` later`
      };
    }
    if (onTick) onTick(verdict, Date.now() - start);
    await sleep(POLL_INTERVAL_MS);
  }
}

async function downloadVideo(uri, destPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const buf = await downloadOutputToBuffer(uri);
  fs.writeFileSync(destPath, buf);
  return destPath;
}

// Shared by run + resume: take a cell that holds an interactionId
// (cell.predictionId — same field name Atlas cells use, so the rest of the
// harness — manifest, gallery, stats — never needs to know which provider a
// cell used), poll it to settlement, download the output, and record the
// settled price. Mutates the cell in place; caller persists the manifest.
async function settleCell(cell, runDir, log = console.log) {
  const { verdict, body, message } = await pollToSettlement(cell.predictionId, {
    onTick: (v, elapsed) => log(`   … ${cell.id}: ${v.state} (${Math.round(elapsed / 1000)}s)`)
  });

  if (verdict.state === 'timeout') {
    cell.status = 'submitted';
    cell.error = message;
    return cell;
  }
  if (verdict.state === 'rate_rejected') {
    // The cap rejection that arrives AFTER an accepted id (measured live —
    // see geminiVideoService.js header). Terminal for this attempt and
    // POSSIBLY BILLED — never resubmit.
    cell.status = 'failed';
    cell.error = 'rate-limited AFTER submit (interaction accepted; possibly billed — NOT resubmitting)';
    cell.charged = null; // tri-state unknown, same convention atlasPoll.js uses
    return cell;
  }
  if (verdict.state === 'failed') {
    cell.status = 'failed';
    cell.error = `gemini video: generation failed (${JSON.stringify(body?.error || {}).slice(0, 300)})`;
    cell.charged = verdict.billed === 'yes' ? true : (verdict.billed === 'no' ? false : null);
    return cell;
  }

  // completed
  const uri = extractVideoUri(body);
  if (!uri) {
    // Completed + billed, file still in the PROCESSING tail (measured:
    // interaction `completed` does not mean the Files API entry is ACTIVE
    // yet). Same recoverability shape as a poll timeout.
    cell.status = 'submitted';
    cell.error = 'completed but no output uri yet (file may still be PROCESSING) — try `rpd resume` shortly';
    return cell;
  }

  cell.settledAt = new Date().toISOString();
  if (cell.submittedAt) cell.latencyMs = Date.parse(cell.settledAt) - Date.parse(cell.submittedAt);
  const rel = path.join('cells', cell.id, 'master.mp4');
  const dl0 = Date.now();
  await downloadVideo(uri, path.join(runDir, rel));
  cell.localPath = rel;
  cell.timings = cell.timings || {};
  cell.timings.queueToTerminalMs = cell.latencyMs ?? null;
  cell.timings.downloadMs = Date.now() - dl0;
  try { cell.timings.downloadBytes = fs.statSync(path.join(runDir, rel)).size; } catch { /* non-fatal */ }

  const settled = computeCost(body?.usage || body?.usage_metadata, cell.resolution);
  if (settled.costUsd != null) {
    cell.costUsd = settled.costUsd;
    cell.costSource = settled.costSource;
  } // else: keep the submit-time estimate — Gemini reports no usage yet.
  cell.status = 'done';
  cell.charged = true;
  return cell;
}

// Free re-check for `rpd resume`'s unpriced-done reconciliation: peek the
// same interaction again and re-run computeCost against whatever usage is
// there now. Unlike Atlas (where price is sometimes published on a LATER
// poll than completion), Gemini's usage arrives WITH the completion body —
// so this mostly re-derives the same figure — but it costs nothing and
// closes the gap for the rare case a cell settled before usage was attached.
async function fetchSettledCost(interactionId, resolution) {
  const body = await peekInteraction(interactionId);
  return computeCost(body?.usage || body?.usage_metadata, resolution);
}

module.exports = { pollToSettlement, downloadVideo, settleCell, fetchSettledCost };
