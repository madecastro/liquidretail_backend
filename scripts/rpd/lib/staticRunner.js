// scripts/rpd/lib/staticRunner.js — STATIC (image) cells for the RPD harness.
//
// The video rail submits through atlasVideoService.submitGeneration and polls
// separately. The image rail cannot: editImage() bundles submit + poll +
// download in one call and only returns `submission.predictionId` at the end.
// That difference drives every design choice here.
//
// MONEY RULES (pinned by scripts/verifyRpdHarness.js):
//   - `allowFallback: false` is HARDCODED, never spec-controlled. The default
//     `true` catches an Atlas failure and resubmits to direct OpenAI
//     (atlasImageService.js:786-806) — a second billable generation the
//     experiment never asked for, on a different model, silently relabelled.
//     An A/B that quietly swaps providers is worse than a failed cell.
//   - RECEIPTS COME FROM THE CALLBACK, NOT THE RETURN VALUE. `meta.onPredictionId`
//     fires at the charge point inside submitAndPoll, so a crash mid-poll still
//     leaves the receipt on disk. Receipts accumulate in an ARRAY: the retry
//     wrapper (submitAndPollWithRetry → mayResubmit) can legitimately resubmit
//     when Atlas proved the prior attempt was NOT charged, and a harness that
//     kept only the last id would hide the earlier prediction.
//   - Estimates come from a MEASURED table, never the Atlas catalog
//     `base_price` (measured ~7x LOW on gpt-image-2 — quoting it would let a
//     $1 cap authorise ~$7 of generations). Unknown model ⇒ refused live.
//   - Settled price is read back from Atlas (peekImagePrediction) and is the
//     only figure reported as spend.

const fs = require('fs');
const path = require('path');
const {
  editImage,
  peekImagePrediction
} = require('../../../services/atlasImageService');
const { buildForStaticCell } = require('./staticPrompt');
const { writeManifest } = require('./manifest');
const { announceReceipt } = require('./receiptEscape');

// MEASURED settled prices (Phase B 2026-08-10/11 + this harness), NOT catalog
// base_price. Value is the HIGHEST measured size for that model, because the
// budget gate must fail safe: over-estimating refuses a run that would have
// fit; under-estimating authorises spend the operator did not agree to.
//   gpt-image-2/edit:            1:1 $0.071728 · 4:5 $0.066660 · 1.91:1 $0.061440
//   gpt-image-2-developer/edit:  ~half (measured $0.03586 on 1:1)
// The developer variant is CHEAPER but production deliberately does not use it
// (~16% hard-fail rate — directImageRenderService.js:87-98). Fine for an
// experiment; know why the arms may differ in reliability, not just quality.
const STATIC_PRICE_USD = {
  'openai/gpt-image-2/edit': 0.0718,
  'openai/gpt-image-2-developer/edit': 0.0359
};

// The measured points are all `quality: 'medium'`, and only at these sizes.
// ADVERSARIAL FINDING (2026-08-18): the table was keyed on model alone while
// `quality` and `size` are operator-settable and both move the real price —
// this repo documents gpt-image-1 at low $0.011 / medium $0.042 / high $0.167,
// so a `quality: 'high'` cell authorised at the medium figure could settle
// several times over the cap AFTER the POST. gpt-image-2 at high was never
// measured. So an estimate is only offered for the arms we actually measured;
// anything else is priced `null`, which assertBudget turns into a refusal.
const MEASURED_QUALITY = 'medium';
const MEASURED_SIZES = new Set(['1024x1024', '1088x1360', '2048x1152', '1152x2048']);

function estimateStaticCostUsd(model, { quality = MEASURED_QUALITY, size = null } = {}) {
  const v = STATIC_PRICE_USD[model];
  if (!Number.isFinite(v)) return null;
  if (quality !== MEASURED_QUALITY) return null;
  if (size && !MEASURED_SIZES.has(size)) return null;
  return v;
}

// Why a cell was refused a price — surfaced so the operator can fix the spec
// instead of guessing why a cell was skipped.
function priceRefusalReason(model, { quality, size }) {
  if (!Number.isFinite(STATIC_PRICE_USD[model])) {
    return `no measured price for ${model} — refusing a live submit at an unknown price ` +
           `(measured: ${Object.keys(STATIC_PRICE_USD).join(', ')})`;
  }
  if (quality !== MEASURED_QUALITY) {
    return `quality "${quality}" has never been measured for ${model} — only "${MEASURED_QUALITY}" has a ` +
           'settled figure, and image prices scale steeply with quality, so the budget gate cannot ' +
           'honestly authorise this. Measure it with one deliberate submit first, then add it to the table.';
  }
  return `size ${size} has no measured price — the gate would authorise it at another size's figure`;
}

function shortModel(model) {
  return model.split('/').slice(-2).join('-').replace(/[^a-z0-9-]+/gi, '-');
}

// Expand the spec's static section into cells. Pure + free — this IS the static
// dry run (prompt, exact size, estimate), and live mode submits these same cells.
function expandStaticCells(spec) {
  const cells = [];
  const stat = spec.static;
  if (!stat) return cells;
  const models = Array.isArray(stat.models) && stat.models.length
    ? stat.models
    : ['openai/gpt-image-2/edit'];
  const variants = Array.isArray(stat.variants) && stat.variants.length
    ? stat.variants
    : [{ id: 'baseline' }];

  for (const model of models) {
    for (const variant of variants) {
      const cell = {
        id: `static--${shortModel(model)}--${variant.id}`,
        kind: 'static',
        model,
        variantId: variant.id,
        status: 'planned',
        notes: [],
        charged: false,
        predictionIds: []
      };
      try {
        const t0 = Date.now();
        const { prompt, size, built, promptMeta } = buildForStaticCell({ spec, model, variant });
        cell.timings = { promptBuildMs: Date.now() - t0 };
        cell.prompt = prompt;
        cell.promptMeta = promptMeta;
        cell.size = size;
        cell.surface = built.surface && built.surface.key ? built.surface.key : (variant.surface || stat.surface || 'meta_feed_1_1');
        cell.intent = promptMeta.intent;
        if (promptMeta.intentDowngraded) cell.intentDowngraded = promptMeta.intentDowngraded;
        // Production plate quality; medium measured BETTER than high on text
        // fidelity (directImageRenderService.js PLATE_QUALITY).
        cell.quality = variant.quality || stat.quality || 'medium';
        // Seed + refs are the same prepared stills the video rail uses, but
        // WITHOUT the 9:16 video crop — the image model gets the seed as-is and
        // `size` carries the target geometry.
        cell.imageUrls = [spec.seed.url, ...(spec.seed.refs || [])];
        cell.estUsd = estimateStaticCostUsd(model, { quality: cell.quality, size: cell.size });
        if (cell.estUsd == null) {
          // assertBudget turns a null estimate into a skip; carry the REASON so
          // the dry run explains itself rather than just refusing.
          cell.priceUnknown = true;
          cell.priceRefusal = priceRefusalReason(model, { quality: cell.quality, size: cell.size });
        }
      } catch (err) {
        cell.status = 'skipped';
        cell.error = err.message;
      }
      cells.push(cell);
    }
  }
  return cells;
}

// Submit + settle static cells. `edit` is injectable so verifyRpdHarness can
// exercise the receipt/fallback invariants offline with no network.
async function runStaticCells(submittable, {
  runDir, manifest, edit = editImage, peek = peekImagePrediction,
  persist = writeManifest, log = console
} = {}) {
  for (const cell of submittable) {
    cell.status = 'submitting';
    persist(runDir, manifest);
    const sub0 = Date.now();
    try {
      const res = await edit({
        model: cell.model,
        prompt: cell.prompt,
        images: cell.imageUrls,
        size: cell.size,
        quality: cell.quality,
        // HARDCODED. See the money rules at the top of this file.
        allowFallback: false,
        meta: {
          service: 'rpd',
          purpose: 'experiment',
          stage: 'rpd-static',
          // Receipt at the charge point — before the poll, before any crash.
          onPredictionId: (id) => {
            if (!id || cell.predictionIds.includes(id)) return;
            cell.predictionIds.push(id);
            cell.predictionId = id;              // latest, for display
            cell.submittedAt = cell.submittedAt || new Date().toISOString();
            // ONE ESTIMATE PER RECEIPT. submitAndPollWithRetry legitimately
            // re-POSTs on a `predictionFailed` policy (which Atlas states is
            // refunded), and an earlier version kept a single estimate here —
            // so a second billable task would have been invisible in the spend
            // line. Counting per receipt OVER-reports if the refund is real,
            // which is the safe direction; `resume` reconciles each receipt
            // against Atlas's settled price afterwards.
            cell.costUsd = Number((cell.estUsd * cell.predictionIds.length).toFixed(4));
            cell.costSource = 'estimated';
            cell.charged = true;                  // a submit id means money committed
            announceReceipt({
              cellId: cell.id, predictionId: id, model: cell.model,
              estUsd: cell.estUsd, runName: manifest && manifest.name
            });
            if (cell.predictionIds.length > 1) {
              log.warn(
                `  ⚠️  ${cell.id}: Atlas accepted a SECOND submit (${id}) after a failed prediction — ` +
                `${cell.predictionIds.length} receipts now counted. Atlas states failed tasks are refunded; ` +
                'verify against the settled prices before quoting spend.'
              );
            }
            try {
              persist(runDir, manifest);
            } catch (err) {
              // Same severity as the video path, which ABORTS on this: a billed
              // id that never reached disk is invisible to `resume`. The
              // callback cannot throw usefully (atlasImageService swallows it),
              // so flag the cell and let the caller fail the run after the call
              // returns.
              cell.receiptPersistFailed = `${id}: ${err.message}`;
              log.error(
                `  🚨 rpd: SPEND RECEIPT COULD NOT BE FLUSHED — prediction ${id} for ${cell.id} ` +
                `is BILLED but not on disk. Record it manually. (${err.message})`
              );
            }
          }
        }
      });

      cell.timings = { ...(cell.timings || {}), submitAndPollMs: Date.now() - sub0 };
      const rel = path.join('cells', cell.id, 'plate.png');
      const abs = path.join(runDir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const b64 = res && res.data && res.data[0] ? res.data[0].b64_json : null;
      if (b64) {
        fs.writeFileSync(abs, Buffer.from(b64, 'base64'));
      } else if (res && res.url) {
        const axios = require('axios');
        const dl = await axios.get(res.url, { responseType: 'arraybuffer', timeout: 120000, maxRedirects: 3 });
        fs.writeFileSync(abs, Buffer.from(dl.data));
      } else {
        throw new Error('no image returned (neither b64_json nor url) — paid for nothing');
      }
      cell.localPath = rel;
      try { cell.timings.outputBytes = fs.statSync(abs).size; } catch { /* non-fatal */ }
      // The submission record is the authority on which prediction actually
      // produced this plate (the callback may hold several if a resubmit fired).
      const submittedId = res && res.submission ? res.submission.predictionId : null;
      if (submittedId) {
        cell.predictionId = submittedId;
        if (!cell.predictionIds.includes(submittedId)) cell.predictionIds.push(submittedId);
      }
      // Settled price — the only number reported as spend.
      if (cell.predictionId) {
        try {
          const settled = await peek(cell.predictionId);
          if (settled && Number.isFinite(Number(settled.price)) && Number(settled.price) > 0) {
            cell.costUsd = Number(settled.price);
            cell.costSource = 'actual';
          }
        } catch { /* free read; keep the estimate */ }
      }
      cell.status = 'done';
      cell.settledAt = new Date().toISOString();
      persist(runDir, manifest);
      // A receipt that never reached disk is the one failure the video path
      // treats as fatal; match it here now that the call has returned and we
      // can throw meaningfully.
      if (cell.receiptPersistFailed) {
        throw new Error(
          `rpd: a billable receipt for ${cell.id} could not be persisted (${cell.receiptPersistFailed}) — ` +
          'stopping so the id is not lost. The plate is on disk; record the prediction id before re-running.'
        );
      }
      const cost = cell.costSource === 'actual' ? `$${cell.costUsd.toFixed(4)}` : `~$${(cell.costUsd || 0).toFixed(4)} est`;
      log.log(`  ✅ ${cell.id}: done ${cost}`);
    } catch (err) {
      cell.status = 'failed';
      cell.error = err.message;
      // A receipt already recorded via the callback means the submit WAS billed;
      // absent one, the charge state is unknowable (never claim 'not charged').
      if (!cell.predictionIds.length) cell.charged = null;
      cell.timings = { ...(cell.timings || {}), submitAndPollMs: Date.now() - sub0 };
      persist(runDir, manifest);
      log.error(`  ❌ ${cell.id}: ${err.message}`);
    }
  }
}

module.exports = {
  expandStaticCells,
  runStaticCells,
  estimateStaticCostUsd,
  STATIC_PRICE_USD
};
