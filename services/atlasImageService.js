// Atlas Cloud image generation/editing — the gateway counterpart to
// atlasVideoService: submit to /api/v1/model/generateImage, poll
// /api/v1/model/prediction/:id, mirror the result. Replaces the direct
// OpenAI images.* calls (gpt-image-1) and Gemini native image gen.
//
// Returns an OpenAI-images-shaped object ({ data: [{ b64_json }], url })
// so migrated call sites keep their `res.data[0].b64_json` parsing.
//
// Fallback (operator directive: keep fallbacks with direct providers):
// on Atlas failure, generate/edit replay against direct OpenAI images
// with the caller's fallbackModel (default gpt-image-1) when
// OPENAI_API_KEY is present. Mask inpainting is NOT offered here at all
// — no Atlas edit model accepts masks (schemas verified 2026-07-21), so
// openaiImageService stays direct by design.
//
// Model IDs verified against the live catalog 2026-07-21:
//   openai/gpt-image-1.5/text-to-image   (size/quality params)
//   openai/gpt-image-1.5/edit            (images[] 1-10, input_fidelity)
//   google/nano-banana-2/edit            (images[] ≤14, aspect_ratio)
// Costs are read from the live catalog once per process (recordFlatCost
// logs $0 + a warn when lookup fails — never blocks generation).

'use strict';

const axios = require('axios');
const { recordFlatCost } = require('./costTracker');

const BASE = process.env.ATLAS_BASE_URL || 'https://api.atlascloud.ai/api/v1';
const KEY = () => process.env.ATLAS_API_KEY;

const DEFAULT_T2I_MODEL = process.env.ATLAS_IMAGE_MODEL || 'openai/gpt-image-1.5/text-to-image';
const DEFAULT_EDIT_MODEL = process.env.ATLAS_IMAGE_EDIT_MODEL || 'openai/gpt-image-1.5/edit';
const POLL_MS = Number(process.env.ATLAS_IMAGE_POLL_MS || 3000);
const TIMEOUT_MS = Number(process.env.ATLAS_IMAGE_TIMEOUT_MS || 180_000);

function isConfigured() { return !!KEY(); }

function positiveTimeout(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// ── live pricing cache (per-image flat costs) ──────────────────────────────
//
// FIXED 2026-07-29 (ARCHITECTURE_REVIEW.md XREPO-1). This read
// `m.pricing?.actual?.price ?? m.pricing?.actual?.output_price`. There is **no
// `pricing` key** on an Atlas catalog entry — verified against the live catalog:
// 0 of 444 entries have `pricing`, 444 of 444 have `price`. So every lookup missed,
// `priceCache` was populated with nothing, and `?? 0` meant **every image generation
// ledgered $0.00**. Silent, because a $0 cost is indistinguishable from a free model.
//
// The real shape is `price.actual.base_price`, a STRING. `actual` is what we pay
// (`origin` is list, `discount` the percentage). Verified live: gpt-image-1.5 = 0.008,
// nano-banana-2/edit = 0.08.
//
// Two traps kept in mind here:
//   • 123 of 444 entries have NO `base_price` — they are per-token LLM models shaped
//     `{type:'flat', input_price, output_price, cache_price}`. Those must not silently
//     resolve to 0; they are simply not this function's business.
//   • For VIDEO models `base_price` is **$/sec**, not per-generation. This function
//     serves image models only, where it is per-image. Do not reuse it for video —
//     see estimateRenderCostUsd in atlasVideoService.js for that.
/**
 * Catalog entries -> Map(model -> flat USD price). Pure, and exported for
 * scripts/verifyImagePricing.js — the parsing is the part that was wrong, so it is the
 * part that needs to be testable without a network call.
 *
 * base_price only. An absent one means "not a flat-priced media model" (per-token LLM
 * entries are shaped {type:'flat', input_price, output_price, cache_price}), which is a
 * different thing from "free" — so those are OMITTED rather than cached as 0, and the
 * caller warns on a miss.
 */
function buildPriceMap(entries) {
  const map = new Map();
  for (const m of entries || []) {
    const raw = m?.price?.actual?.base_price;
    if (raw == null) continue;
    const p = Number(raw);
    if (Number.isFinite(p)) map.set(m.model, p);
  }
  return map;
}

let priceCache = null;
async function priceFor(model) {
  try {
    if (!priceCache) {
      const res = await axios.get(`${BASE}/models`, { timeout: 20_000 });
      priceCache = buildPriceMap(res.data?.data);
      console.log(`💲 atlasImage: priced ${priceCache.size} models from the live catalog`);
    }
    const hit = priceCache.get(model);
    if (hit == null) {
      // Loud, because the bug this replaced was silent. Still returns 0 so a pricing
      // gap never blocks a generation — but it will no longer hide in the ledger.
      console.warn(
        `⚠️  atlasImage: no base_price for '${model}' in the live catalog — ` +
        `ledgering $0. Check the slug and the price shape before trusting spend reports.`
      );
      return 0;
    }
    return hit;
  } catch (err) {
    console.warn(`⚠️  atlasImage: catalog price lookup failed (${err.message}) — ledgering $0`);
    return 0;
  }
}

// ── upload helper (buffers → temporary public URLs for edit inputs) ────────
async function uploadBuffer(buf, filename = 'image.png', mime = 'image/png', timeoutMs = 60_000) {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: mime }), filename);
  const res = await axios.post(`${BASE}/model/uploadMedia`, fd, {
    headers: { Authorization: `Bearer ${KEY()}` },
    timeout: positiveTimeout(timeoutMs, 60_000),
  });
  const url = res.data?.data?.download_url;
  if (!url) throw new Error(`uploadMedia returned no URL: ${JSON.stringify(res.data).slice(0, 200)}`);
  return url;
}

// ── submit + poll ──────────────────────────────────────────────────────────
async function submitAndPoll(model, params, meta = {}, { timeoutMs = TIMEOUT_MS } = {}) {
  const generationTimeoutMs = positiveTimeout(timeoutMs, TIMEOUT_MS);
  const t0 = Date.now();
  const submit = await axios.post(`${BASE}/model/generateImage`, { model, ...params }, {
    headers: { Authorization: `Bearer ${KEY()}`, 'Content-Type': 'application/json' },
    timeout: Math.min(60_000, generationTimeoutMs),
    validateStatus: () => true,
    // BILLABLE POST — axios defaults to maxRedirects 21 and re-sends the body on a
    // 307/308, which is a double charge inside a single call and invisible to any
    // retry logic. Redirects are followed BEFORE validateStatus runs, so
    // `validateStatus: () => true` above does not protect against it. With 0, a 3xx
    // becomes the final response and the status check below turns it into a clear
    // error. Same guard as both billable POSTs in atlasVideoService.js.
    maxRedirects: 0,
  });
  if (submit.status !== 200 || !submit.data?.data?.id) {
    throw new Error(`Atlas image submit ${submit.status}: ${JSON.stringify(submit.data).slice(0, 200)}`);
  }
  const id = submit.data.data.id;
  let lastStatus = null;
  console.log(`   ⏳ atlasImage: submitted ${id} (${model}); deadline=${generationTimeoutMs}ms`);

  while (Date.now() - t0 < generationTimeoutMs) {
    const remainingBeforePoll = generationTimeoutMs - (Date.now() - t0);
    await new Promise((r) => setTimeout(r, Math.min(POLL_MS, Math.max(0, remainingBeforePoll))));
    const remaining = generationTimeoutMs - (Date.now() - t0);
    if (remaining <= 0) break;
    const poll = await axios.get(`${BASE}/model/prediction/${id}`, {
      headers: { Authorization: `Bearer ${KEY()}` },
      timeout: Math.min(30_000, Math.max(1000, remaining)),
      validateStatus: () => true,
    });
    // Atlas reports errors as a TOP-LEVEL {code, msg} with no data.status —
    // e.g. {"code":402,"msg":"insufficient balance"}. Reading only
    // data.status turned every one of those into st='unknown', which matches
    // neither the success nor the failure list, so the loop span the full
    // deadline and reported "timed out". An out-of-credit account therefore
    // looked like a slow model, for 60s per ad, and was then ledgered as
    // CHARGED spend for work Atlas never performed.
    //
    // Check the envelope before the status. A non-200, or a body carrying an
    // error code, is terminal now — there is nothing to wait for.
    const apiCode = poll.data?.code;
    const apiMsg  = poll.data?.msg || poll.data?.message || null;
    const isErrorEnvelope = (typeof apiCode === 'number' && apiCode !== 200) || (poll.status !== 200 && !poll.data?.data);
    if (isErrorEnvelope) {
      // Billing is an outage, not a bad ad: every render in every run fails
      // identically until someone tops the account up. Flagged fatal so it
      // pages instead of hiding behind per-ad render failures.
      const isBilling = apiCode === 402 || /insufficient balance|quota|credit/i.test(String(apiMsg || ''));
      recordFlatCost({
        ...meta, provider: 'atlas', model,
        costUsd: 0, durationMs: Date.now() - t0, status: isBilling ? 'rejected-billing' : 'rejected',
      }).catch?.(() => {});
      const err = new Error(
        `Atlas image ${isBilling ? 'REJECTED — insufficient balance' : 'error'} ` +
        `(HTTP ${poll.status}, code ${apiCode ?? 'n/a'}): ${apiMsg || JSON.stringify(poll.data).slice(0, 160)} [prediction ${id}]`
      );
      // NOT charged: Atlas explicitly declined to run it, so recording spend
      // would inflate the ledger with work that never happened.
      err.charged = false;
      err.atlasCode = apiCode ?? null;
      if (isBilling) { err.alertLevel = 'fatal'; err.alertKey = 'atlas:insufficient-balance'; }
      throw err;
    }
    const st = String(poll.data?.data?.status || 'unknown').toLowerCase();
    if (st !== lastStatus) {
      console.log(`   ⏳ atlasImage: ${id} status=${st} elapsed=${Date.now() - t0}ms`);
      lastStatus = st;
    }
    if (st === 'completed' || st === 'succeeded') {
      const out = poll.data.data.outputs?.[0];
      if (!out) throw await chargedError('Atlas image completed with no outputs', id, model, meta, t0);
      recordFlatCost({
        ...meta, provider: 'atlas', model,
        costUsd: await priceFor(model), durationMs: Date.now() - t0, status: 'ok',
      }).catch?.(() => {});
      // Output is a URL (or base64 when enable_base64_output was set) —
      // normalize to a b64 payload so callers get buffers without egress.
      if (/^https?:\/\//.test(out)) {
        const img = await axios.get(out, { responseType: 'arraybuffer', timeout: 20_000 });
        return { b64: Buffer.from(img.data).toString('base64'), url: out, predictionId: id };
      }
      return { b64: out, url: null, predictionId: id };
    }
    if (['failed', 'error', 'cancelled', 'canceled', 'rejected'].includes(st)) {
      // Atlas explicitly reported failure. Providers generally do not bill a failed
      // generation, so this is NOT marked charged — but the attempt is ledgered at $0
      // so it is still visible in spend reports rather than vanishing.
      recordFlatCost({
        ...meta, provider: 'atlas', model,
        costUsd: 0, durationMs: Date.now() - t0, status: 'failed',
      }).catch?.(() => {});
      throw new Error(`Atlas image failed: ${JSON.stringify(poll.data?.data).slice(0, 200)}`);
    }
  }
  // Timed out waiting. The submit succeeded, so Atlas is doing (or has done) the work
  // and will bill for it — and it may well complete after we stop polling. Charged.
  throw await chargedError(`Atlas image timed out after ${generationTimeoutMs}ms`, id, model, meta, t0);
}

/**
 * Build an error for a failure that happened AFTER a successful billable submit.
 *
 * Ledgers the spend before throwing, because the alternative is losing it: the success
 * path was previously the only place recordFlatCost fired, so a no-outputs response or
 * a poll timeout charged real money and recorded nothing (ARCHITECTURE_REVIEW.md
 * XREPO-4 for the video equivalent).
 *
 * `charged` is the same flag atlasVideoService.submitImageGeneration sets, and it is
 * what tells the caller a direct-provider fallback would mean paying TWICE for one
 * image rather than once.
 */
async function chargedError(message, predictionId, model, meta, t0) {
  const costUsd = await priceFor(model);
  recordFlatCost({
    ...meta, provider: 'atlas', model,
    costUsd, durationMs: Date.now() - t0, status: 'charged-no-output',
  }).catch?.(() => {});
  const err = new Error(`${message} (prediction ${predictionId})`);
  err.charged = true;
  err.predictionId = predictionId;
  err.costUsd = costUsd;
  return err;
}

// Model-specific request bodies (mirrors atlasVideoService's paramShape).
function buildParams(model, { prompt, size, quality, images, inputFidelity, aspectRatio }) {
  if (/nano-banana/.test(model)) {
    const p = { prompt };
    if (images?.length) p.images = images;
    if (aspectRatio) p.aspect_ratio = aspectRatio;
    return p;
  }
  // gpt-image family: size enum 1024x1024|1024x1536|1536x1024, quality low|medium|high.
  const p = { prompt };
  if (size) p.size = size;
  if (quality) p.quality = quality;
  if (images?.length) p.images = images;
  if (inputFidelity) p.input_fidelity = inputFidelity;
  return p;
}

/**
 * An audit record of what was ACTUALLY sent to the image model, built from the
 * same `params` object that becomes the POST body — never from what a caller
 * intended to send. The generation inspector renders this verbatim.
 *
 * `submittedUrl` + `imageCount` are ground truth (they are the body). `sourceUrl`
 * and `role` are caller-supplied labels for the same positions: they name where a
 * buffer came from, because uploaded reference URLs are ephemeral Atlas handles
 * that expire and would be useless in a diagnostic later. Labels never replace or
 * reorder the submitted list — a missing label leaves null rather than guessing.
 */
function buildSubmissionRecord({ provider, model, params = {}, predictionId = null, imageMeta = [] }) {
  const images = Array.isArray(params.images) ? params.images : [];
  // An explicit null from a caller would defeat the default and throw on
  // indexing — after a billable submit has already succeeded, which would
  // discard a paid-for image over a labelling detail.
  const labels = Array.isArray(imageMeta) ? imageMeta : [];
  return {
    provider,
    model,
    predictionId,
    submittedAt: new Date().toISOString(),
    prompt:        params.prompt ?? null,
    size:          params.size ?? null,
    quality:       params.quality ?? null,
    aspectRatio:   params.aspect_ratio ?? null,
    inputFidelity: params.input_fidelity ?? null,
    imageCount:    images.length,
    images: images.map((url, i) => ({
      position:     i,
      submittedUrl: typeof url === 'string' ? url : null,
      sourceUrl:    labels[i]?.sourceUrl ?? null,
      role:         labels[i]?.role ?? null
    }))
  };
}

// ── direct-OpenAI fallback (original models, original API) ─────────────────
async function directOpenAiImages({ kind, prompt, size, quality, buffers, fallbackModel }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const OpenAI = require('openai');
  const { toFile } = require('openai');
  const client = new OpenAI({ apiKey: key });
  const model = fallbackModel || 'gpt-image-1';
  console.warn(`🌐 atlasImage: falling back to direct OpenAI images.${kind} (${model})`);
  if (kind === 'edit' && buffers?.length) {
    const files = await Promise.all(buffers.map((b, i) => toFile(b, `ref${i}.png`, { type: 'image/png' })));
    const res = await client.images.edit({ model, image: files.length === 1 ? files[0] : files, prompt, size, quality, n: 1 });
    return { b64: res.data?.[0]?.b64_json, url: res.data?.[0]?.url || null };
  }
  const res = await client.images.generate({ model, prompt, size, quality, n: 1 });
  return { b64: res.data?.[0]?.b64_json, url: res.data?.[0]?.url || null };
}

// ── public API ─────────────────────────────────────────────────────────────

/**
 * generateImage({ prompt, size?, quality?, model?, fallbackModel?, meta? })
 * → { data: [{ b64_json }], url } (OpenAI-images shape).
 */
async function generateImage({
  prompt, size, quality, model, fallbackModel, aspectRatio, meta = {},
  timeoutMs, allowFallback = true
}) {
  const m = model || DEFAULT_T2I_MODEL;
  try {
    if (!isConfigured()) throw new Error('ATLAS_API_KEY not configured');
    // Built inside the try so a throw here still reaches the provider
    // fallback, matching editImage.
    const params = buildParams(m, { prompt, size, quality, aspectRatio });
    const out = await submitAndPoll(m, params, meta, { timeoutMs });
    return {
      data: [{ b64_json: out.b64 }],
      url: out.url,
      submission: buildSubmissionRecord({ provider: 'atlas', model: m, params, predictionId: out.predictionId })
    };
  } catch (err) {
    if (!allowFallback) throw err;
    warnIfDoublePaying(err, 'generate');
    const fb = await directOpenAiImages({ kind: 'generate', prompt, size, quality, fallbackModel }).catch((e) => { throw new Error(`${err.message}; fallback: ${e.message}`); });
    if (!fb) throw err;
    // The fallback is a DIFFERENT provider and model. Reporting the Atlas
    // attempt here would describe a request that produced nothing.
    return {
      data: [{ b64_json: fb.b64 }],
      url: fb.url,
      submission: buildSubmissionRecord({
        provider: 'openai-direct',
        model: fallbackModel || 'gpt-image-1',
        params: { prompt, size, quality }
      })
    };
  }
}

/**
 * The fallback below is deliberate (operator directive at the top of this file: keep
 * fallbacks with direct providers). But when the Atlas failure happened AFTER a
 * successful billable submit, falling back means paying two providers for one image.
 * That is an accepted cost, not an accident — so say so out loud instead of letting it
 * hide. Both charges are in the ledger: Atlas via chargedError, OpenAI via its own
 * recordFlatCost path.
 */
function warnIfDoublePaying(err, kind) {
  if (!err?.charged) return;
  console.warn(
    `💸 atlasImage.${kind}: Atlas already charged ~$${(err.costUsd ?? 0).toFixed(4)} for ` +
    `prediction ${err.predictionId} before failing — falling back to direct OpenAI means ` +
    `PAYING TWICE for one image. Proceeding per the keep-fallbacks directive.`
  );
}

/**
 * editImage({ prompt, images (Buffers or URLs, 1..10), size?, quality?,
 *             inputFidelity?, model?, fallbackModel?, meta? })
 * → { data: [{ b64_json }], url }. NO mask support — mask inpainting
 * stays on direct OpenAI (openaiImageService) by design.
 */
async function editImage({
  prompt, images = [], size, quality, inputFidelity, model, fallbackModel,
  aspectRatio, meta = {}, timeoutMs, uploadTimeoutMs, allowFallback = true,
  imageMeta = []
}) {
  const m = model || DEFAULT_EDIT_MODEL;
  const buffers = images.filter((i) => Buffer.isBuffer(i));
  try {
    if (!isConfigured()) throw new Error('ATLAS_API_KEY not configured');
    // Independent reference uploads should not multiply startup latency. A
    // two-reference static ad now waits for the slower upload, not both.
    const urls = await Promise.all(images.map((img, index) => (
      Buffer.isBuffer(img)
        ? uploadBuffer(img, `reference-${index + 1}.png`, 'image/png', uploadTimeoutMs)
        : img
    )));
    const params = buildParams(m, { prompt, images: urls, size, quality, inputFidelity, aspectRatio });
    const out = await submitAndPoll(m, params, meta, { timeoutMs });
    return {
      data: [{ b64_json: out.b64 }],
      url: out.url,
      submission: buildSubmissionRecord({ provider: 'atlas', model: m, params, predictionId: out.predictionId, imageMeta })
    };
  } catch (err) {
    if (!allowFallback) throw err;
    warnIfDoublePaying(err, 'edit');
    // Direct fallback needs buffers; URL inputs get downloaded first.
    let fbBuffers = buffers;
    if (!fbBuffers.length && images.length) {
      fbBuffers = await Promise.all(images.filter((i) => typeof i === 'string').map(async (u) => Buffer.from((await axios.get(u, { responseType: 'arraybuffer', timeout: 30_000 })).data)));
    }
    const fb = await directOpenAiImages({ kind: 'edit', prompt, size, quality, buffers: fbBuffers, fallbackModel }).catch((e) => { throw new Error(`${err.message}; fallback: ${e.message}`); });
    if (!fb) throw err;
    // Buffers go to OpenAI as multipart files, so there is no submitted URL to
    // record — only the true count and the caller's position labels.
    return {
      data: [{ b64_json: fb.b64 }],
      url: fb.url,
      submission: buildSubmissionRecord({
        provider: 'openai-direct',
        model: fallbackModel || 'gpt-image-1',
        params: { prompt, size, quality, images: fbBuffers },
        imageMeta
      })
    };
  }
}

module.exports = { generateImage, editImage, uploadBuffer, isConfigured, buildPriceMap, buildSubmissionRecord };
