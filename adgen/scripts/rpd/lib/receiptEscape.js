// scripts/rpd/lib/receiptEscape.js — get a spend receipt OFF THE BOX immediately.
//
// WHY THIS EXISTS, and why it is specific to hosted runs:
// on a laptop, manifest.json IS the ledger and the disk outlives the process, so
// flushing the predictionId to disk before polling is sufficient. On Render (and
// any ephemeral host) the filesystem is DISCARDED when the job exits or is
// evicted — so a crash mid-poll loses the receipt entirely, and a receipt nobody
// holds is money that can never be reconciled or recovered.
//
// So on a hosted run the receipt is ALSO pushed somewhere durable the instant it
// exists. Slack is the right channel: the token is already on both Render
// services, it is outside the box, a human reads it, and posting is one free
// HTTP call. Cloudinary carries the artifacts and the settled manifest later
// (see lib/upload.js) but is not reachable early enough to be the receipt path.
//
// Opt-in via RPD_RECEIPT_SLACK=1 so a laptop run is unchanged. Best-effort by
// construction: this must never throw into a billable path — losing the
// notification is bad, failing the generation that was already paid for is worse.

const { postText } = require('./slack');

function receiptEscapeEnabled() {
  return String(process.env.RPD_RECEIPT_SLACK || '').trim() === '1';
}

// Fire-and-forget. Never awaited on the submit path, never throws.
function announceReceipt({ cellId, predictionId, model, estUsd, runName }) {
  if (!receiptEscapeEnabled() || !predictionId) return;
  const text =
    `🧾 RPD receipt — ${runName || 'run'} / ${cellId}\n` +
    `prediction: ${predictionId}\n` +
    `model: ${model}\n` +
    `est: ${estUsd == null ? 'n/a' : `$${Number(estUsd).toFixed(4)}`}\n` +
    'This submit is BILLED. If the run does not report a settled price, reconcile ' +
    'this id against Atlas manually — on an ephemeral host the run directory may be gone.';
  Promise.resolve()
    .then(() => postText(text))
    .catch(() => { /* a lost notification must never fail a paid submit */ });
}

module.exports = { announceReceipt, receiptEscapeEnabled };
