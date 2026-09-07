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
} = require('../../../src/services/atlasVideoService');
const {
  submitGeneration: submitGeminiGeneration,
  resolveGeminiModel,
  estimateCost: estimateGeminiCost,
  SUPPORTED_ASPECTS: GEMINI_SUPPORTED_ASPECTS,
  PRICED_RESOLUTIONS: GEMINI_PRICED_RESOLUTIONS,
  PROVIDER: GEMINI_PROVIDER
} = require('../../../src/services/geminiVideoService');
const { resolveVideoReferenceForMedia } = require('../../../src/services/videoReferenceResolver');
const { fetchImagesAsBase64 } = require('./geminiImages');
const { buildForCell } = require('./promptVariants');
const { settleCell, probeUrls } = require('./atlasPoll');
const { settleCell: settleGeminiCell } = require('./geminiPoll');
const { announceReceipt } = require('./receiptEscape');
const { writeManifest } = require('./manifest');

// The SAME discriminator services/geminiVideoService.resolveGeminiModel uses
// in production to decide whether an operator-dropdown override is a Gemini
// id or an Atlas slug. A spec.models entry matching this is routed to the
// direct Gemini Developer API instead of Atlas — no separate spec field, no
// separate CLI flag, so a spec can mix both providers in one models[] array
// and compare them cell-for-cell in one gallery.
function isGeminiModel(model) {
  return /^gemini-/i.test(String(model || ''));
}

// PROBED (services/geminiVideoService.js buildRequestBody comment):
// "STRING, never an integer. 3–10s inclusive, fractional allowed." Skip,
// never guess, same as every other Atlas enum check below.
const GEMINI_MIN_DURATION_SEC = 3;
const GEMINI_MAX_DURATION_SEC = 10;

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
      if (!isGeminiModel(m) && !MODEL_CAPS[m]) {
        throw new Error(
          `rpd: unknown video model "${m}". Registered:\n  ${Object.keys(MODEL_CAPS).join('\n  ')}\n  ` +
          `(or any gemini-* id — e.g. gemini-omni-1.1-flash — routed to the direct Gemini Developer API)`
        );
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

// Seed prep — the production deterministic path.
//
// DEFAULT: Cloudinary URLs get the exact c_fill,g_auto crop production's
// URL-only callers use; anything else passes through unresized (Atlas pulls
// the original) and is flagged so the operator knows.
//
// REFRAME-CACHE MODE (spec.seed.useReframeCache=true): routes every URL
// through videoReferenceResolver, the same three-tier helper adgen's live
// direct-Gemini path uses today (reframe-cache → on-demand chooseStrategy
// → source-native c-fill fallback). Gives the harness production-representative
// refs — the DINO-cached c_pad / c_crop URLs the real renderer sends, at
// source-native resolution (e.g. 2000×3556 pad, 1125×2000 yolo-crop for a
// 2000×2000 source at 9:16). Opt-in because the resolver requires Media docs
// (attached by dbSeed on productId-seeded specs as a non-enumerable
// _mediaDocsByUrl Map on spec.seed) — a URL-only spec cannot use this.
//
// The resolver is READ-ONLY across all three tiers; it never triggers a
// billable outpaint. The original file-header concern ("reframe/outpaint stays
// OFF here: billable and DB-coupled") was about `reframeReferenceForAspect`,
// which the resolver deliberately does NOT call. Safe to opt into.
function prepareImageUrls(spec, variant, aspectRatio) {
  const hex = spec.seed.brandHex || null;
  const urls = [spec.seed.url, ...(spec.seed.refs || [])];
  const warnings = [];
  const useResolver = spec.seed.useReframeCache === true && spec.seed._mediaDocsByUrl;
  const prepared = urls.map((u) => {
    if (useResolver) {
      const media = spec.seed._mediaDocsByUrl.get(u);
      if (media) {
        const { url, source, method } = resolveVideoReferenceForMedia({
          media, aspectRatio, brand: hex
        });
        if (url) return url;
        // Resolver returned null (source URL falsy) — extremely unlikely
        // with a real media doc, but fall through to the c-fill path
        // rather than dropping the ref silently.
        warnings.push(`resolver returned null for ${u} (source=${source}/${method || 'none'}) — falling back to c_fill`);
      } else {
        // URL not in the docs map. Happens when the operator manually adds
        // refs to a productId-seeded spec (spec.seed.refs gets extended
        // beyond what dbSeed populated). Fall back to c_fill for those refs.
        warnings.push(`no Media doc for ${u} — resolver skipped, using c_fill fallback`);
      }
    }
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

// Gemini-direct cell expansion. Mirrors the Atlas branch below in shape
// (same cell fields, same dry-run-is-free contract) but against a
// structurally different production service — see
// services/geminiVideoService.js's own header for the money model this
// mirrors (accepted-id-is-the-charge-point, no seed param, no retry-on-429
// at submit time).
function expandOneGeminiCell(spec, model, variant) {
  const resolvedModel = resolveGeminiModel(model);
  const id = `${shortModel(resolvedModel)}--${variant.id}`;
  const aspectRatio = variant.aspectRatio || spec.aspectRatio || '9:16';
  const cell = {
    id, model: resolvedModel, variantId: variant.id, status: 'planned',
    notes: [], charged: false, provider: GEMINI_PROVIDER
  };
  try {
    if (!GEMINI_SUPPORTED_ASPECTS.has(aspectRatio)) {
      cell.status = 'skipped';
      cell.error = `model does not support ${aspectRatio} (supports: ${[...GEMINI_SUPPORTED_ASPECTS].join(', ')})`;
      return cell;
    }
    const resolution = spec.resolution || process.env.GEMINI_VIDEO_RESOLUTION || '1080p';
    if (!GEMINI_PRICED_RESOLUTIONS.has(resolution)) {
      cell.status = 'skipped';
      cell.error = `resolution "${resolution}" has no published Gemini rate (priced: ${[...GEMINI_PRICED_RESOLUTIONS].join(', ')}) — refusing to submit at an unknown price`;
      return cell;
    }
    const requestedDur = variant.durationSec || spec.durationSec || 10;
    if (!(requestedDur >= GEMINI_MIN_DURATION_SEC && requestedDur <= GEMINI_MAX_DURATION_SEC)) {
      cell.status = 'skipped';
      cell.error = `durationSec ${requestedDur} is outside Gemini's documented ${GEMINI_MIN_DURATION_SEC}-${GEMINI_MAX_DURATION_SEC}s range`;
      return cell;
    }
    const durationSec = requestedDur;

    const pb0 = Date.now();
    // caps:null — matches geminiVideoService.generateForAd's own call to
    // buildVeoPrompt EXACTLY (Gemini publishes no prompt byte cap; see that
    // function's comment). Passing anything else here would test a prompt
    // production never actually builds for this provider.
    const { prompt, promptMeta } = buildForCell({ spec, model: resolvedModel, caps: null, variant: { ...variant, durationSec } });
    cell.timings = { promptBuildMs: Date.now() - pb0 };

    const { imageUrls, warnings } = prepareImageUrls(spec, variant, aspectRatio);
    cell.prompt = prompt;
    cell.promptMeta = promptMeta;
    cell.aspectRatio = aspectRatio;
    cell.durationSec = durationSec;
    cell.resolution = resolution;
    cell.imageUrls = imageUrls;
    cell.seedWarnings = warnings;
    // The exact static shape buildRequestBody sends, WITHOUT the image
    // bytes — those are fetched + base64-encoded at submit time only (never
    // during dry-run expansion), so a dry run never touches the network and
    // the manifest never carries megabytes of base64 per cell. See
    // cell.imageUrls for the actual sources.
    cell.body = {
      model: resolvedModel,
      input: `[${imageUrls.length} image(s) fetched + base64-encoded at submit time] + [1 text part, ${Buffer.byteLength(prompt, 'utf8')} bytes]`,
      response_format: { type: 'video', aspect_ratio: aspectRatio, resolution, duration: `${durationSec}s`, delivery: 'uri' },
      generation_config: { video_config: { task: 'reference_to_video' } },
      background: true, store: true, stream: false
    };
    cell.estUsd = estimateGeminiCost({ durationSec, resolution }).costUsd;
    // Schema-confirmed (services/geminiVideoService.js buildRequestBody):
    // no seed field exists on this API. Unlike the Atlas cell below,
    // pinning a seed for a repeatable A/B is not available here — the only
    // lever for "repeatable" on this provider is holding every OTHER input
    // (prompt, references, duration/aspect/resolution) fixed.
    cell.rngNote = 'Gemini Developer API has no seed parameter — repeatability means fixing every other input, not pinning an RNG seed.';
  } catch (err) {
    cell.status = 'skipped';
    cell.error = err.message;
  }
  return cell;
}

// Expand spec → cells with prompts, bodies and estimates. Pure + free — this
// IS the dry run; live mode just carries on to submit the same cells.
function expandCells(spec) {
  const cells = [];
  if (!Array.isArray(spec.models) || !Array.isArray(spec.variants)) return cells;
  for (const model of spec.models) {
    if (isGeminiModel(model)) {
      for (const variant of spec.variants) cells.push(expandOneGeminiCell(spec, model, variant));
      continue;
    }
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
        // Optional pinned seed (variant.rngSeed overrides spec.rngSeed) —
        // schema-confirmed on the 'gemini-omni' paramShape only (live-fetched
        // 2026-09-04; see buildSubmissionBody's own comment). Holding this
        // fixed across cells isolates the PROMPT as the only variable when
        // A/B'ing wording, instead of conflating a wording change with the
        // model's own random seed. Undefined by default — every spec that
        // doesn't set it behaves exactly as before this feature existed.
        const rngSeed = Number.isInteger(variant.rngSeed) ? variant.rngSeed
          : (Number.isInteger(spec.rngSeed) ? spec.rngSeed : null);
        const body = buildSubmissionBody({
          model, prompt, imageUrls, aspectRatio, caps,
          videoClipUrl, durationSec, seed: rngSeed
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
        cell.rngSeed = rngSeed;
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

// A cell's SUBMISSION IDENTITY — everything that decides what the provider
// actually renders. Two cells sharing this fingerprint produce the same video
// and the second one is money burned for a duplicate.
//
// Deliberately NOT just the prompt: a matrix over several PRODUCTS is a
// legitimate experiment, and those cells share a prompt while seeding from
// different images. Seed images are part of the identity for that reason.
function cellFingerprint(cell) {
  const crypto = require('crypto');
  const identity = {
    model: (cell.body && cell.body.model) || cell.model || null,
    prompt: cell.prompt || '',
    imageUrls: Array.isArray(cell.imageUrls) ? cell.imageUrls : [],
    aspectRatio: cell.aspectRatio || null,
    durationSec: cell.durationSec ?? null,
    resolution: cell.resolution || null
  };
  return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

// Group planned cells that would submit the SAME thing. Pure — returns groups
// of 2+ cell ids keyed by fingerprint; empty array when every cell is distinct.
function findDuplicateCells(cells) {
  const byPrint = new Map();
  for (const c of cells) {
    if (c.status !== 'planned') continue;
    const fp = cellFingerprint(c);
    if (!byPrint.has(fp)) byPrint.set(fp, []);
    byPrint.get(fp).push(c);
  }
  return [...byPrint.values()].filter((g) => g.length > 1);
}

// WHY THIS GATE EXISTS — measured 2026-09-06 on the shipped
// specs/example-prompt-ab.json: the `objective-rewrite` variant used the
// `directives` lever, which the frozen-CORE prompt no longer reads, so its
// built prompt was BYTE-IDENTICAL to `baseline`. A --live run would have paid
// ~$1.00 to generate a second copy of the control and presented it as a
// variant — a wasted generation AND a misleading A/B result.
//
// A lever that silently stops working is not a hypothetical: the video prompt
// became one frozen CORE paragraph on 2026-09-03/04 and `directives` went
// inert without any caller changing. This gate catches that class generically
// — it does not know or care WHICH lever failed, only that two cells would
// bill twice for one video.
//
// Refuses rather than skipping the duplicate, for the same reason the budget
// gate refuses: the operator believes they are running an A/B. Silently
// dropping an arm would hand them a result that looks like "no difference"
// when the truth is "your variant never applied". Deliberate duplicates (a
// generation-variance test) opt in with allowDuplicates.
function assertNoDuplicateCells(cells, { allowDuplicates = false } = {}) {
  if (allowDuplicates) return;
  const groups = findDuplicateCells(cells);
  if (!groups.length) return;
  const lines = groups.map((g) => {
    const ids = g.map((c) => `    - ${c.id}`).join('\n');
    // Read the lever off promptMeta, which buildForCell always attaches.
    // (An earlier draft read a `variantLevers` field that is never assigned
    // anywhere, so this line always printed "(baseline)" — i.e. the one
    // diagnostic naming the broken arm was a constant. Caught in review.)
    const levers = [...new Set(g.map((c) => (c.promptMeta && c.promptMeta.lever) || 'baseline'))];
    return `  These ${g.length} cells would submit an IDENTICAL video:\n${ids}\n` +
           `    levers used: ${levers.join(' vs ')}`;
  }).join('\n\n');
  throw new Error(
    'rpd: refusing to submit — some cells build the exact same request, so you would pay\n' +
    'once per copy and the comparison would be meaningless.\n\n' +
    `${lines}\n\n` +
    'Most likely cause: a prompt lever that no longer changes the built prompt. The video\n' +
    'prompt is now ONE frozen CORE paragraph, so `directives` (per-element overrides) is\n' +
    'inert — use `guidance` (prepend), `raw` (full replace), or `patch` (find/replace against\n' +
    'the CORE text) instead. Check what actually differs with:\n' +
    '  node scripts/rpd/rpd.js run <spec> ' + '  # dry run, then diff the prompts in manifest.json\n' +
    'If the duplication is deliberate (testing generation variance on one fixed input),\n' +
    're-run with --allow-duplicate-prompts.'
  );
}

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
async function submitCells(submittable, {
  runDir, manifest, submit = submitGeneration, persist = writeManifest, log = console,
  // Gemini-path deps, injectable for the same reason `submit` is: so
  // verifyRpdHarness can exercise the receipt invariants functionally
  // without a network call or a real API key.
  submitGemini = submitGeminiGeneration, fetchImages = fetchImagesAsBase64
} = {}) {
  for (const cell of submittable) {
    cell.status = 'submitting';
    persist(runDir, manifest);
    let predictionId = null;
    const sub0 = Date.now();
    try {
      if (cell.provider === GEMINI_PROVIDER) {
        // Fetch + base64-encode NOW, not at expand time — this is the one
        // place a Gemini cell touches the network before actually spending.
        const images = await fetchImages(cell.imageUrls);
        const submitted = await submitGemini({
          images, prompt: cell.prompt, aspectRatio: cell.aspectRatio,
          resolution: cell.resolution, durationSec: cell.durationSec, model: cell.model
        });
        predictionId = submitted.interactionId;
      } else {
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
          durationSec: cell.durationSec,
          seed: cell.rngSeed ?? null
        });
      }
    } catch (err) {
      cell.status = 'failed';
      cell.error = `submit failed: ${err.message}`;
      // Gemini's own errors classify billed state precisely (an accepted
      // interaction_id is the charge point, not the HTTP status — see
      // services/geminiVideoService.js's header). Atlas errors don't set
      // err.billed, so this falls back to the existing "unknown" tri-state.
      cell.charged = err.billed === 'yes' ? true : err.billed === 'no' ? false : null;
      persist(runDir, manifest);
      log.error(`  ❌ ${cell.id}: ${err.message}`);
      continue;
    }
    // RECEIPT: assigned and flushed outside the catch above. If persist
    // throws here, the receipt is printed and the run aborts — never
    // silently reclassified.
    cell.predictionId = predictionId;
    cell.status = 'submitted';
    // An ACCEPTED RECEIPT IS THE CHARGE POINT — explicitly so on Gemini (a
    // 200 with an interaction_id is billable even if the poll never settles)
    // and effectively so on Atlas. Leaving `charged` at its initial false
    // here made gallery.js render a grey "uncharged" chip on every cell whose
    // poll timed out — a live spend receipt displayed as costing nothing,
    // which invites exactly the re-run that pays for the same cell twice.
    // settleCell still refines this to null on a terminal failure.
    cell.charged = true;
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

async function runSpec(specPath, { live = false, maxUsd = null, outRoot = 'rpd-runs', upload = false, allowDuplicates = false } = {}) {
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
    // Real on-brand titling for a real product: wire the actual Brand doc
    // (logo/colors/font/tagline/titleStylePreset) through so the burned-in
    // chrome matches production instead of titling.js's Pelagic test fixture.
    // `spec.titling.brand` is a distinct field from `brandName` (a string) —
    // an operator who explicitly sets `spec.titling.brand` themselves (e.g.
    // to force-test a DIFFERENT brand's look) is never overridden here.
    // Only non-proof copy defaults (real product title as headline) — never
    // quote/rating/reviewCount, which stay absent unless the operator
    // supplies them explicitly (same rule titling.js's fixtureMeta enforces).
    if (spec.titling && !spec.titling.brand && resolved.brand) {
      spec.titling.brand = resolved.brand;
    }
    if (spec.titling && resolved.productTitle) {
      spec.titling.copy = spec.titling.copy || {};
      if (!spec.titling.copy.headline) spec.titling.copy.headline = resolved.productTitle;
    }
    spec.seed.resolvedFromDb = {
      productId: String(spec.seed.productId),
      at: new Date().toISOString(),
      refCount: resolved.refs.length
    };
    // Attach the Media docs as a URL→doc map for videoReferenceResolver
    // (consumed by prepareImageUrls when spec.seed.useReframeCache=true).
    // Non-enumerable so JSON.stringify (in manifest.js writeManifest) does
    // not pick it up — Media docs are ~5-10KB each with reframes +
    // refinedProducts, and the manifest is meant to stay portable.
    if (Array.isArray(resolved.docs) && resolved.docs.length) {
      const byUrl = new Map();
      for (const d of resolved.docs) {
        if (d && typeof d.fileUrl === 'string') byUrl.set(d.fileUrl.trim(), d);
      }
      Object.defineProperty(spec.seed, '_mediaDocsByUrl', {
        value: byUrl, enumerable: false, writable: true, configurable: true
      });
    }
    console.log(
      `📦 DB seed: ${resolved.productTitle || '(untitled)'} — seed + ${resolved.refs.length} ref(s), ` +
      `brandHex ${resolved.brandHex}` +
      (spec.seed.useReframeCache ? ` — useReframeCache=true, ${resolved.docs?.length || 0} media doc(s) attached` : '')
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
    // Surface duplicates HERE, for free, rather than only at the live gate —
    // the dry run is where someone checks their spec before spending.
    const dupGroups = findDuplicateCells(cells);
    if (dupGroups.length && !allowDuplicates) {
      console.log('\n⚠️  DUPLICATE CELLS — these would each bill for the SAME video:');
      for (const g of dupGroups) {
        console.log(`     ${g.map((c) => c.id).join('\n     ')}`);
      }
      console.log('   A --live run will REFUSE until the spec is fixed (or --allow-duplicate-prompts).');
      console.log('   Usual cause: `directives` no longer changes the prompt — use guidance / raw / patch.');
    }
    console.log('Prompts + exact request bodies are in manifest.json. Nothing was sent.');
    return { runDir, manifest };
  }

  // Provider-aware credential check. Requiring ATLAS_API_KEY unconditionally
  // refused a Gemini-only run — and Gemini IS the live production provider
  // (VIDEO_PROVIDER=gemini on adgen-renderer), so the most realistic
  // experiment was the one that could not start without an unrelated key.
  const plannedNow = cells.filter((c) => c.status === 'planned');
  const needsAtlas = plannedNow.some((c) => !isGeminiModel((c.body && c.body.model) || c.model || ''));
  const needsGemini = plannedNow.some((c) => isGeminiModel((c.body && c.body.model) || c.model || ''));
  if (needsAtlas && !process.env.ATLAS_API_KEY) {
    throw new Error('rpd: ATLAS_API_KEY is not set — required for --live on Atlas models (google/…, xai/…)');
  }
  if (needsGemini && !process.env.GEMINI_VIDEO_API_KEY && !process.env.GEMINI_API_KEY) {
    throw new Error('rpd: GEMINI_VIDEO_API_KEY (or GEMINI_API_KEY) is not set — required for --live on gemini-* models');
  }
  assertNoDuplicateCells(cells, { allowDuplicates });
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
      if (cell.provider === GEMINI_PROVIDER) await settleGeminiCell(cell, runDir);
      else await settleCell(cell, runDir);
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

module.exports = {
  loadSpec, expandCells, runSpec, assertBudget, prepareImageUrls, submitCells,
  cellFingerprint, findDuplicateCells, assertNoDuplicateCells,
  UNVERIFIED_PRICING_SLUGS
};
