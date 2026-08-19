// scripts/rpd/lib/runner.js — RPD experiment runner: expand a spec into
// (model × variant) cells, dry-run them for free, or run them live against
// Atlas under a hard budget cap.
//
// MONEY RULES (pinned by scripts/verifyRpdHarness.js; adversarially reviewed
// 2026-08-18 — findings 1/2/3 from that review are fixed here):
//   - The ONLY billable call is atlasVideoService.submitGeneration — the
//     production submit path (pacedModelSubmit spacing, structured-429-only
//     retry, maxRedirects:0). No other POST in this harness bills.
//   - Live mode requires BOTH opts.live and a finite opts.maxUsd; the summed
//     floor-grade estimate of every submittable cell must fit under the cap
//     BEFORE the first submit, or the whole run is refused. A cell whose
//     estimate is missing OR non-finite is never live-submitted (NaN is not
//     a price).
//   - The requested resolution must be a member of the model's published
//     enum: an unknown string would be PRICED at the 720p fallback but
//     SUBMITTED verbatim (a 4k-priced render under a $1 gate). Skip, never
//     guess.
//   - The predictionId (spend receipt) is assigned and flushed to
//     manifest.json OUTSIDE the submit try/catch: a submit failure can never
//     be conflated with a persistence failure, and a persistence failure
//     aborts the run LOUDLY with the receipt printed — it must never
//     reclassify a successful (billed) submit as 'failed', which would hide
//     the receipt from `rpd resume` forever.
//   - Settled `price` read back from Atlas is the reported spend; the
//     estimate is a floor (Omni developer overstates ~33% at 10s).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  MODEL_CAPS,
  capsFor,
  resolveDurationSec,
  estimateRenderCostUsd,
  buildSubmissionBody,
  cropImageUrlForAspect,
  buildVideoSegmentUrl,
  submitGeneration
} = require('../../../services/atlasVideoService');
const { buildForCell } = require('./promptVariants');
const { settleCell, probeUrls } = require('./atlasPoll');
const { announceReceipt } = require('./receiptEscape');
const { writeManifest } = require('./manifest');

// MODEL_CAPS carries these rates with an UNVERIFIED comment — the estimate
// is a guess in an unknown direction (unlike Omni developer, which measures
// LOWER than its formula). Live cells on these models run, but with a loud
// warning; keep this list in sync with the MODEL_CAPS comments.
const UNVERIFIED_PRICING_SLUGS = new Set([
  'xai/grok-imagine-video-v1.5/image-to-video',
  'xai/grok-imagine-video/reference-to-video',
  'google/veo3.1/image-to-video'
]);

function loadSpec(specPath) {
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  if (!spec.name || !/^[a-z0-9][a-z0-9-_]*$/i.test(spec.name)) {
    throw new Error('rpd: spec.name is required (letters/digits/dashes only — it becomes the run directory)');
  }
  if (!spec.seed || (!spec.seed.url && !spec.seed.productId)) {
    throw new Error(
      'rpd: spec.seed needs either `url` (the still — images[0] and the gallery thumb) or ' +
      '`productId` (DB seed mode: resolves the merchant-feed primary + refs). ' +
      'Reference-to-video models additionally need spec.seed.videoUrl.'
    );
  }
  // A spec may carry a video section, a static section, or both.
  const hasVideo = Array.isArray(spec.models) && spec.models.length > 0;
  const hasStatic = !!(spec.static && Array.isArray(spec.static.variants) && spec.static.variants.length);
  if (!hasVideo && !hasStatic) {
    throw new Error('rpd: nothing to run — provide spec.models + spec.variants (video) and/or spec.static.variants');
  }
  if (hasVideo) {
    if (!Array.isArray(spec.variants) || spec.variants.length === 0) throw new Error('rpd: spec.variants must be a non-empty array');
    const ids = new Set();
    for (const v of spec.variants) {
      if (!v.id || !/^[a-z0-9][a-z0-9-_]*$/i.test(v.id)) throw new Error('rpd: every variant needs an id (letters/digits/dashes)');
      if (ids.has(v.id)) throw new Error(`rpd: duplicate variant id "${v.id}"`);
      ids.add(v.id);
    }
    for (const m of spec.models) {
      if (!MODEL_CAPS[m]) {
        throw new Error(`rpd: unknown video model "${m}". Registered:\n  ${Object.keys(MODEL_CAPS).join('\n  ')}`);
      }
    }
  }
  if (hasStatic) {
    const sids = new Set();
    for (const v of spec.static.variants) {
      if (!v.id || !/^[a-z0-9][a-z0-9-_]*$/i.test(v.id)) throw new Error('rpd: every static variant needs an id');
      if (sids.has(v.id)) throw new Error(`rpd: duplicate static variant id "${v.id}"`);
      sids.add(v.id);
    }
  }
  return spec;
}

function shortModel(model) {
  return model.split('/').slice(-2).join('-').replace(/[^a-z0-9-]+/gi, '-');
}

// Seed prep — the production deterministic path (reframe/outpaint stays OFF
// here: it is billable and DB-coupled). Cloudinary URLs get the exact
// c_fill,g_auto crop production uses; anything else passes through unresized
// (Atlas pulls the original) and is flagged so the operator knows.
function prepareImageUrls(spec, variant, aspectRatio) {
  const hex = spec.seed.brandHex || null;
  const urls = [spec.seed.url, ...(spec.seed.refs || [])];
  const warnings = [];
  const prepared = urls.map((u) => {
    const cropped = cropImageUrlForAspect(u, aspectRatio, hex);
    if (cropped === u && !/res\.cloudinary\.com/.test(u)) {
      warnings.push(`not a Cloudinary URL — sent to the model UNRESIZED: ${u}`);
    }
    return cropped;
  });
  return { imageUrls: prepared, warnings };
}

// Source-duration guard for reference-to-video seeds. The Atlas r2v schema
// documents a ≤30s source asset (live-verified 2026-07-21) and PRODUCTION DOES
// NOT CHECK IT — `Media.durationSec` is never read before submit. An r2v submit
// is a flat $1.60, so a cheap local ffprobe before spending is worth it.
// Returns { seconds } | { seconds: null, reason } — unknown is NOT a refusal
// (that would make the harness stricter than production over a missing binary),
// it is a warning the operator sees in the dry run.
function probeVideoDurationSec(url) {
  try {
    const res = spawnSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', url
    ], { encoding: 'utf8', timeout: 30_000 });
    if (res.error || res.status !== 0) {
      return { seconds: null, reason: res.error ? res.error.message : `ffprobe exit ${res.status}` };
    }
    const n = Number(String(res.stdout || '').trim());
    return Number.isFinite(n) && n > 0 ? { seconds: n } : { seconds: null, reason: 'unparseable duration' };
  } catch (err) {
    return { seconds: null, reason: err.message };
  }
}

const R2V_MAX_SOURCE_SEC = 30;

// Expand spec → cells with prompts, bodies and estimates. Pure + free — this
// IS the dry run; live mode just carries on to submit the same cells.
function expandCells(spec) {
  const cells = [];
  if (!Array.isArray(spec.models) || !Array.isArray(spec.variants)) return cells;
  for (const model of spec.models) {
    const caps = capsFor(model);
    for (const variant of spec.variants) {
      const id = `${shortModel(model)}--${variant.id}`;
      const aspectRatio = variant.aspectRatio || spec.aspectRatio || '9:16';
      const cell = {
        id, model, variantId: variant.id, status: 'planned',
        notes: [], charged: false
      };
      try {
        // Reference-to-video models need a video seed. With `seed.videoUrl`
        // present they are runnable; without it the skip stays honest (an
        // image-only r2v submit would spend $1.60 on `url: undefined`).
        let videoClipUrl = null;
        if (caps.requiresVideoSeed) {
          const videoSeed = spec.seed.videoUrl || null;
          if (!videoSeed) {
            cell.status = 'skipped';
            cell.error = 'model requires a video seed (reference-to-video) — add spec.seed.videoUrl';
            cells.push(cell);
            continue;
          }
          const probe = probeVideoDurationSec(videoSeed);
          if (probe.seconds != null && probe.seconds > R2V_MAX_SOURCE_SEC) {
            cell.status = 'skipped';
            cell.error =
              `video seed is ${probe.seconds.toFixed(1)}s — the r2v schema documents a ` +
              `≤${R2V_MAX_SOURCE_SEC}s source asset, and this model is a flat $1.60 per submit`;
            cells.push(cell);
            continue;
          }
          cell.videoSeedDurationSec = probe.seconds;
          if (probe.seconds == null) {
            cell.seedWarnings = [
              `could not probe the video seed duration (${probe.reason}) — the r2v schema wants ` +
              `≤${R2V_MAX_SOURCE_SEC}s; production does not check this either`
            ];
          }
        }
        if (Array.isArray(caps.supportedAspectRatios) && !caps.supportedAspectRatios.includes(aspectRatio)) {
          cell.status = 'skipped';
          cell.error = `model does not support ${aspectRatio} (supports: ${caps.supportedAspectRatios.join(', ')})`;
          cells.push(cell);
          continue;
        }
        const requestedDur = variant.durationSec || spec.durationSec || 8;
        const durationSec = resolveDurationSec(requestedDur, caps);
        if (durationSec !== requestedDur) cell.durationSnapped = { requested: requestedDur, effective: durationSec };
        const pb0 = Date.now();
        const { prompt, promptMeta } = buildForCell({ spec, model, caps, variant: { ...variant, durationSec } });
        cell.timings = { promptBuildMs: Date.now() - pb0 };
        const { imageUrls, warnings } = prepareImageUrls(spec, variant, aspectRatio);
        if (caps.requiresVideoSeed) {
          // Same expression production uses (generateForAd): the Cloudinary
          // rewrite when possible (so_2,du_N,c_fill,ar_*), else the raw URL and
          // let Atlas trim via start/ends.
          videoClipUrl = buildVideoSegmentUrl(spec.seed.videoUrl, aspectRatio, durationSec)
            || spec.seed.videoUrl;
          cell.videoClipUrl = videoClipUrl;
        }
        const body = buildSubmissionBody({
          model, prompt, imageUrls, aspectRatio, caps,
          videoClipUrl, durationSec
        });
        // Resolution allowlist (adversarial finding 2): an unknown string
        // (e.g. "4K", "2160p") would be priced at the 720p fallback but
        // submitted verbatim — a 4k-priced render sliding under the gate.
        if (body.resolution && Array.isArray(caps.resolutions) && !caps.resolutions.includes(body.resolution)) {
          cell.status = 'skipped';
          cell.error = `resolution "${body.resolution}" is not in the model's enum (${caps.resolutions.join(', ')}) — refusing to price it as 720p and submit it verbatim`;
          cells.push(cell);
          continue;
        }
        cell.prompt = prompt;
        cell.promptMeta = promptMeta;
        cell.aspectRatio = aspectRatio;
        cell.durationSec = body.duration || durationSec;
        cell.resolution = body.resolution || null;
        cell.imageUrls = imageUrls;
        cell.seedWarnings = [...(cell.seedWarnings || []), ...warnings];
        cell.body = body;
        cell.estUsd = estimateRenderCostUsd({
          model, durationSec: cell.durationSec, resolution: cell.resolution
        });
        if (UNVERIFIED_PRICING_SLUGS.has(model)) cell.pricingUnverified = true;
      } catch (err) {
        cell.status = 'skipped';
        cell.error = err.message;
      }
      cells.push(cell);
    }
  }
  return cells;
}

function newRunDir(outRoot, spec) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runDir = path.join(outRoot, `${stamp}--${spec.name}`);
  fs.mkdirSync(path.join(runDir, 'cells'), { recursive: true });
  return runDir;
}

function fmtUsd(n) { return n == null || !Number.isFinite(n) ? 'n/a' : `$${n.toFixed(2)}`; }

// The budget gate. Refuses rather than trims: a silently smaller experiment
// is worse than a refused one (the operator sized the matrix deliberately).
// NaN is not a price: any non-finite estimate is treated exactly like a
// missing one (adversarial finding 1 — NaN summed into total made the cap
// comparison silently false).
function assertBudget(cells, maxUsd) {
  const submittable = cells.filter((c) => c.status === 'planned');
  for (const c of submittable) {
    if (c.estUsd == null || !Number.isFinite(c.estUsd)) {
      c.status = 'skipped';
      // Static cells carry a specific reason (unmeasured quality/size/model);
      // video cells fall back to the generic MODEL_CAPS message.
      c.error = c.priceRefusal || 'no pricing data in MODEL_CAPS — refusing a live submit at an unknown price';
    }
  }
  const live = cells.filter((c) => c.status === 'planned');
  const total = live.reduce((s, c) => s + c.estUsd, 0);
  if (!(Number.isFinite(maxUsd) && maxUsd > 0)) {
    throw new Error('rpd: --live requires --max-usd <dollars> (hard cap; estimates are checked against it before any submit)');
  }
  if (!Number.isFinite(total) || total > maxUsd) {
    const lines = live.map((c) => `  ${c.id}: ~${fmtUsd(c.estUsd)}`).join('\n');
    throw new Error(
      `rpd: estimated total ~${fmtUsd(total)} exceeds --max-usd ${fmtUsd(maxUsd)} — refusing to submit anything.\n${lines}\n` +
      'Raise the cap or shrink the matrix. (Estimates are floor-grade; Omni developer settles ~33% under the formula.)'
    );
  }
  return { live, total };
}

// Submit one batch of cells. Deps are injectable so verifyRpdHarness can
// exercise the receipt invariants functionally (no network):
//   - a submit() throw marks the cell failed with charge state UNKNOWN and
//     moves on (the only in-process retry lives inside submitGeneration,
//     and it replays only on a structured 429);
//   - receipt assignment + flush happen OUTSIDE that catch, so a persist
//     failure can never reclassify a successful (billed) submit as failed —
//     it prints the receipt and ABORTS the run instead.
async function submitCells(submittable, { runDir, manifest, submit = submitGeneration, persist = writeManifest, log = console } = {}) {
  for (const cell of submittable) {
    cell.status = 'submitting';
    persist(runDir, manifest);
    let predictionId = null;
    const sub0 = Date.now();
    try {
      const caps = capsFor(cell.model);
      // videoClipUrl MUST come from the cell: hardcoding null here would send
      // `video_clips[0].url: undefined` on a reference-to-video model and spend
      // its flat $1.60 on a body Atlas cannot use. Pinned by verifyRpdHarness.
      predictionId = await submit({
        model: cell.model,
        prompt: cell.prompt,
        imageUrls: cell.imageUrls,
        aspectRatio: cell.aspectRatio,
        caps,
        videoClipUrl: cell.videoClipUrl || null,
        durationSec: cell.durationSec
      });
    } catch (err) {
      cell.status = 'failed';
      cell.error = `submit failed: ${err.message}`;
      // No prediction id ⇒ no receipt ⇒ charge state unknowable.
      cell.charged = null;
      persist(runDir, manifest);
      log.error(`  ❌ ${cell.id}: ${err.message}`);
      continue;
    }
    // RECEIPT: assigned and flushed outside the catch above. If persist
    // throws here, the receipt is printed and the run aborts — never
    // silently reclassified.
    cell.predictionId = predictionId;
    cell.status = 'submitted';
    cell.submittedAt = new Date().toISOString();
    cell.timings = cell.timings || {};
    cell.timings.submitMs = Date.now() - sub0; // includes pacing wait + any structured-429 backoff
    cell.costUsd = cell.estUsd;
    cell.costSource = 'estimated';
    // Push the receipt OFF the box too (opt-in, hosted runs) — an ephemeral
    // filesystem discards manifest.json, and a receipt nobody holds is money
    // that can never be reconciled. Fire-and-forget, never throws.
    announceReceipt({
      cellId: cell.id, predictionId, model: cell.model,
      estUsd: cell.estUsd, runName: manifest && manifest.name
    });
    try {
      persist(runDir, manifest);
    } catch (err) {
      log.error(
        `  🚨 rpd: SPEND RECEIPT COULD NOT BE FLUSHED — prediction ${predictionId} for cell ${cell.id} is BILLED but not on disk. ` +
        `Record it manually before doing anything else. (${err.message})`
      );
      throw err;
    }
    log.log(`  🎬 submitted ${cell.id} → ${predictionId}`);
  }
}

async function runSpec(specPath, { live = false, maxUsd = null, outRoot = 'rpd-runs', upload = false } = {}) {
  const spec = loadSpec(specPath);

  // DB seed mode: resolve the merchant-feed primary + refs from a productId and
  // STAMP them onto the spec, so the manifest is self-describing and every later
  // command (resume/gallery/publish) works with no database.
  if (spec.seed.productId) {
    const { resolveSeedFromDb } = require('./dbSeed');
    const resolved = await resolveSeedFromDb(spec.seed.productId);
    spec.seed.url = resolved.url;
    if (!spec.seed.refs || !spec.seed.refs.length) spec.seed.refs = resolved.refs;
    spec.seed.productTitle = spec.seed.productTitle || resolved.productTitle;
    spec.seed.brandHex = spec.seed.brandHex || resolved.brandHex;
    if (spec.titling && !spec.titling.brandName) spec.titling.brandName = resolved.brandName;
    spec.seed.resolvedFromDb = {
      productId: String(spec.seed.productId),
      at: new Date().toISOString(),
      refCount: resolved.refs.length
    };
    console.log(
      `📦 DB seed: ${resolved.productTitle || '(untitled)'} — seed + ${resolved.refs.length} ref(s), ` +
      `brandHex ${resolved.brandHex}`
    );
  }

  // Spec resolution override must be in env BEFORE bodies are built —
  // buildSubmissionBody reads ATLAS_VIDEO_RESOLUTION for omni shapes.
  if (spec.resolution) process.env.ATLAS_VIDEO_RESOLUTION = spec.resolution;

  const cells = expandCells(spec);
  // Static (image) cells live in the same manifest and share the budget gate.
  if (spec.static) {
    const { expandStaticCells } = require('./staticRunner');
    cells.push(...expandStaticCells(spec));
  }
  const manifest = {
    name: spec.name,
    notes: spec.notes || null,
    createdAt: new Date().toISOString(),
    mode: live ? 'live' : 'dry-run',
    maxUsd: live ? maxUsd : null,
    spec,
    cells,
    observations: []
  };

  const runDir = newRunDir(outRoot, spec);
  writeManifest(runDir, manifest);

  console.log(`\nRPD run: ${spec.name}  (${live ? 'LIVE' : 'dry-run — nothing will be submitted'})`);
  console.log(`Run dir: ${runDir}\n`);
  for (const c of cells) {
    const est = Number.isFinite(c.estUsd) ? `~${fmtUsd(c.estUsd)}` : 'no estimate';
    const unverified = c.pricingUnverified ? '  ⚠️ UNVERIFIED RATE — settled price may differ in either direction' : '';
    const shape = c.kind === 'static'
      ? `${c.size || '-'} ${c.intent || ''}`
      : `${c.durationSec || '-'}s ${c.resolution || ''}`;
    console.log(`  [${c.status}] ${c.id}  ${shape} ${est}${unverified}${c.error ? `  (${c.error})` : ''}`);
    if (c.intentDowngraded) {
      console.log(`      ⚠️  intent downgraded ${c.intentDowngraded.requested} → ${c.intentDowngraded.resolved} (its data is absent)`);
    }
    for (const w of c.seedWarnings || []) console.log(`      ⚠️  ${w}`);
  }

  if (!live) {
    const planned = cells.filter((c) => c.status === 'planned');
    const wouldSpend = planned.reduce((s, c) => s + (Number.isFinite(c.estUsd) ? c.estUsd : 0), 0);
    console.log(`\nDry run only. A --live run would submit ${planned.length} cells, estimated ~${fmtUsd(wouldSpend)} (floor-grade).`);
    console.log('Prompts + exact request bodies are in manifest.json. Nothing was sent.');
    return { runDir, manifest };
  }

  if (!process.env.ATLAS_API_KEY) throw new Error('rpd: ATLAS_API_KEY is not set — required for --live');
  const { live: submittable, total } = assertBudget(cells, maxUsd);
  writeManifest(runDir, manifest);
  console.log(`\nBudget: ${submittable.length} cells, estimated ~${fmtUsd(total)} ≤ cap ${fmtUsd(maxUsd)}. Submitting…`);

  // Time the Cloudinary transforms BEFORE submitting: the first fetch of a
  // derived crop URL pays the on-the-fly transform, which is a real
  // component of production generation latency (Atlas fetches these same
  // URLs). Free GETs; results land in cell.timings.seedProbe. De-duped so a
  // shared seed is only probed cold once.
  const probed = new Map();
  for (const cell of submittable) {
    const results = [];
    for (const url of cell.imageUrls) {
      if (!probed.has(url)) probed.set(url, (await probeUrls([url]))[0]);
      results.push(probed.get(url));
    }
    cell.timings = { ...(cell.timings || {}), seedProbe: results };
    const bad = results.filter((r) => r.status && r.status >= 400);
    for (const b of bad) console.warn(`  ⚠️  ${cell.id}: reference URL returned HTTP ${b.status}: ${b.url}`);
  }
  writeManifest(runDir, manifest);

  // Video cells: submit (receipt) then poll separately. Static cells: the image
  // service bundles submit+poll, so they run through their own runner and are
  // already settled when it returns.
  await submitCells(submittable.filter((c) => c.kind !== 'static'), { runDir, manifest });

  const staticSubmittable = submittable.filter((c) => c.kind === 'static');
  if (staticSubmittable.length) {
    const { runStaticCells } = require('./staticRunner');
    console.log(`\nGenerating ${staticSubmittable.length} static plate(s)…`);
    await runStaticCells(staticSubmittable, { runDir, manifest });
  }

  // Poll everything concurrently — polls are free.
  const pending = cells.filter((c) => c.status === 'submitted');
  console.log(`\nPolling ${pending.length} predictions…`);
  await Promise.all(pending.map(async (cell) => {
    try {
      await settleCell(cell, runDir);
    } catch (err) {
      cell.status = 'submitted'; // receipt retained — resume can retry the free part
      cell.error = `poll/download failed: ${err.message}`;
    }
    writeManifest(runDir, manifest);
    const cost = cell.costSource === 'actual' ? fmtUsd(cell.costUsd) : `~${fmtUsd(cell.costUsd)} est`;
    console.log(`  ${cell.status === 'done' ? '✅' : '❌'} ${cell.id}: ${cell.status} ${cost}${cell.error ? ` (${cell.error})` : ''}`);
  }));

  // Optional Cloudinary mirror. Runs AFTER settle and can never un-settle a
  // paid cell (uploadCellOutputs never throws).
  if (upload) {
    const { uploadCellOutputs, uploadManifest } = require('./upload');
    for (const cell of cells.filter((c) => c.status === 'done' && c.localPath)) {
      const res = await uploadCellOutputs(runDir, cell, spec.name);
      if (!res.ok) console.warn(`  ⚠️  ${cell.id}: upload — ${res.errors.join('; ')}`);
      writeManifest(runDir, manifest);
    }
    // The ledger last, so it reflects every uploadedUrl written above.
    const mres = await uploadManifest(runDir, spec.name);
    if (mres.ok) console.log(`  ☁️  manifest mirrored: ${mres.url}`);
    else console.warn(`  ⚠️  manifest not mirrored — ${mres.errors.join('; ')}`);
  }

  // Spend line: settled truth + every receipt still carrying an estimate.
  // A cell with a predictionId has been billed (or is being billed) whatever
  // its status — the in-flight/timed-out ones must not vanish from this line
  // (adversarial finding 7).
  const settled = cells.filter((c) => c.costSource === 'actual').reduce((s, c) => s + c.costUsd, 0);
  const receiptEst = cells.filter((c) => c.predictionId && c.costSource !== 'actual');
  const estOnly = receiptEst.reduce((s, c) => s + (Number.isFinite(c.costUsd) ? c.costUsd : 0), 0);
  console.log(
    `\nSpend: ${fmtUsd(settled)} settled` +
    (receiptEst.length ? ` + ~${fmtUsd(estOnly)} across ${receiptEst.length} unsettled receipt(s) (estimates)` : '') +
    ` (cap was ${fmtUsd(maxUsd)})`
  );
  return { runDir, manifest };
}

module.exports = { loadSpec, expandCells, runSpec, assertBudget, prepareImageUrls, submitCells, UNVERIFIED_PRICING_SLUGS };
