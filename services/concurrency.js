'use strict';
//
// services/concurrency.js — SINGLE place every concurrency / parallelism /
// submit-spacing knob is resolved from env.
//
// WHY: these used to be scattered as hardcoded literals and ad-hoc
// process.env reads with diverging defaults. Raising a self-imposed
// ceiling required a code change in multiple files, and it was impossible
// to see the full table of knobs without grepping. This module owns the
// table; callers import the frozen `concurrency` object.
//
// Ceiling kinds:
//   PROVIDER-IMPOSED — real external rate/limit. Env can only LOWER, never
//     raise above the documented ceiling. Grok's 1 RPS is the canonical
//     example: raising VEO_CONCURRENCY must not let Grok submits exceed 1/s.
//   SELF-IMPOSED — our own throttle. Tunable; raise when measured safe.
//
// Money note: Atlas generation POSTs are billable. Concurrency controls
// how many are in flight; ATLAS_SUBMIT_SPACING_MS + per-model pacing
// (atlasVideoService.pacedModelSubmit) control submit rate. Image submits
// are unpaced today (atlasImageService). See CLAUDE.md §2.

const SPEC = Object.freeze({
  // ── Render / video pools (routes/ads.js runRenderLoop) ──────────────
  RENDER_CONCURRENCY: {
    env: 'RENDER_CONCURRENCY',
    default: 24,
    min: 1,
    max: 64,
    ceiling: 'SELF-IMPOSED',
    why: 'In-flight static/image ads per campaign run. 4→8 (2026-08-02): image submits are unpaced and 8 concurrent openai/gpt-image-2/edit measured clean (85s wall, zero 429s). 8→24 (2026-08-04, owner-directed: renders should all go to Atlas at once). 24 is now a WAVE SIZE under the run cap (in-flight bound; a full claim renders in waves), no longer non-binding. Spend is unchanged — the submit COUNT is fixed by the ad count, only the rate moves. Unmeasured above 8: watch for 429 backoff on the first full-size run.'
  },
  VEO_CONCURRENCY: {
    env: 'VEO_CONCURRENCY',
    default: 12,
    min: 1,
    max: 32,
    ceiling: 'SELF-IMPOSED',
    why: 'In-flight video ads per campaign run — now the SUBMIT+POLL half only. Raised 1→4 (2026-08-02) as a probe; 4→12 (2026-08-05) once titling moved behind its own permit (VEO_TITLING_CONCURRENCY). The 4 was never really about Omni: this lane also ran Remotion renderMedia (headless Chrome + ffmpeg, 1080p) IN-PROCESS, so the number was pinned to what local RAM/CPU could take, while being documented against Omni RPS. Splitting them lets the idle half (an Omni poll is ~2min of waiting; measured p50 117s / p99 247s) run wide without touching the memory-bound half. Omni RPS remains unpublished and no Omni 429 has ever been recorded; submit RATE is still governed by pacedModelSubmit + ATLAS_SUBMIT_SPACING_MS, and Grok stays <=1 RPS via GROK_MAX_RPS regardless of this value. 12 bounds in-flight video submits/polls per run — a wave size under the effectively-uncapped claim.'
  },
  VEO_TITLING_CONCURRENCY: {
    env: 'VEO_TITLING_CONCURRENCY',
    default: 48,
    min: 1,
    max: 64,
    ceiling: 'SELF-IMPOSED',
    why: 'How many ads may be INSIDE the titling call at once. 4 -> 48 (owner-directed 2026-08-13) and the note below is rewritten because the old one was wrong about what this bounds. It said "simultaneous Remotion titling renders", but remotionRenderService ran a concurrency-1 promise CHAIN, so only ever ONE render happened regardless of this number — the other permit holders sat idle. That is the whole explanation for the measured 926s / 83%-idle titling tail on a 20-ad run: 13 renders strictly back to back. What this permit actually bounds is the CHEAP prep half — buildMetaForAd, the copy cascade, product/category reads, font resolution. Those are Mongo/disk, not memory-heavy, so a wide value is safe and 48 matches RENDER_CONCURRENCY in being deliberately non-binding. THE MEMORY GUARD IS NOW REMOTION_QUEUE_CONCURRENCY, which is the number to move carefully. One caveat that survives the rewrite: ~$0.02 of billable face-detection vision runs inside this permit per ad (basePlateCropService), so a wide value bursts those calls concurrently — same total spend, higher instantaneous rate.'
  },

  REMOTION_QUEUE_CONCURRENCY: {
    env: 'REMOTION_QUEUE_CONCURRENCY',
    default: 4,
    min: 1,
    max: 16,
    ceiling: 'SELF-IMPOSED',
    why: 'Simultaneous Remotion renders — headless Chrome page + ffmpeg 1080p encode, IN the web process. This is the real titling limit and inherits the caution the old VEO_TITLING_CONCURRENCY note carried: the failure mode is not a provider 429, it is RSS exhaustion -> Render autoscale (60% CPU+mem) -> process replacement -> a paid Omni master stranded mid-titling (~$1.00 each). Default 4 is a 4x throughput win over the serial chain it replaces (926s tail -> ~230s projected) and is NOT arbitrary: 4 is the value the combined VEO_CONCURRENCY carried when it ran submit+poll AND Remotion in one lane, so it is the only concurrency this process has actually survived. It is still not an RSS MEASUREMENT. Raise one step at a time against the web service memory graph across a full run; 1080p is 2.25x the pixels of 720p and one measured render is 76.2s.'
  },
  MAX_CREATIVES_PER_RUN: {
    env: 'MAX_CREATIVES_PER_RUN',
    default: 1000,
    min: 1,
    max: 1000,
    ceiling: 'SELF-IMPOSED',
    why: 'Effectively uncapped by owner directive 2026-08-18 ("immediately remove the cap"); 1000 is a sanity ceiling, not a product cap. The prior 20 starved statics once PR #197 made an Everything run mint 21 videos/product — selectAdsForRun drains the video tier first, so tier 0 alone filled the whole claim and the operator\'s statics never rendered.'
  },

  // ── Worker process ──────────────────────────────────────────────────
  WORKER_CONCURRENCY: {
    env: 'WORKER_CONCURRENCY',
    default: 8,
    min: 1,
    max: 100,
    ceiling: 'SELF-IMPOSED',
    why: 'Parallel DetectRun/Job polling loops inside the worker process. I/O-bound; Mongo pool scales with it. Raised 5→8 on 2026-08-14 (deferred YOLO plan step #1).'
  },

  // ── Atlas video submit pacing ───────────────────────────────────────
  ATLAS_SUBMIT_SPACING_MS: {
    env: 'ATLAS_SUBMIT_SPACING_MS',
    default: 1200,
    min: 0,
    max: 60_000,
    ceiling: 'SELF-IMPOSED',
    why: 'Start-to-start spacing for same-model video submits (pacedModelSubmit). Default 1200ms ≈ 0.83 RPS. Do not lower casually. VIDEO-ONLY — image submits are unpaced.'
  },
  // PROVIDER-IMPOSED: Grok Imagine documented 1 RPS. Env may lower RPS
  // (raise min spacing) but cannot raise above 1. Applied as a floor on
  // spacing for any model slug matching isGrokModel(), independent of
  // ATLAS_SUBMIT_SPACING_MS and of VEO_CONCURRENCY.
  GROK_MAX_RPS: {
    env: 'GROK_MAX_RPS',
    default: 1,
    min: 0.05,
    max: 1, // PROVIDER ceiling — cannot raise above 1 via env
    ceiling: 'PROVIDER-IMPOSED',
    why: 'Grok Imagine (xai/grok-imagine-*) documented 1 RPS. Aspect-fallback model. pacedModelSubmit enforces min spacing = ceil(1000/GROK_MAX_RPS) for those slugs.'
  },

  // ── Catalog ingest / enrichment ─────────────────────────────────────
  GENERIC_CATALOG_PDP_CONCURRENCY: {
    env: 'GENERIC_CATALOG_PDP_CONCURRENCY',
    default: 5,
    min: 1,
    max: 32,
    ceiling: 'SELF-IMPOSED',
    why: 'Parallel product-page fetches during generic sitemap+JSON-LD catalog scan. Per-host min-gap still applies.'
  },
  CATALOG_ENRICHMENT_CONCURRENCY: {
    env: 'CATALOG_ENRICHMENT_CONCURRENCY',
    default: 6,
    min: 1,
    max: 32,
    ceiling: 'SELF-IMPOSED',
    why: 'Parallel products in catalog enrichment (reviews/details). Bounds SerpAPI/Gemini spend rate.'
  },
  // Free sharp packshot/lifestyle classify at catalog ingest
  // (services/ingestShotClassifyService). Same default as enrichment — bounds
  // concurrent HTTP GETs of product images during a sync, not billable LLM.
  CATALOG_INGEST_SHOT_CLASSIFY_CONCURRENCY: {
    env: 'CATALOG_INGEST_SHOT_CLASSIFY_CONCURRENCY',
    default: 6,
    min: 1,
    max: 32,
    ceiling: 'SELF-IMPOSED',
    why: 'Concurrent image fetches for zero-cost ingest-time shot-style classification. Per-sync wall-clock budget is separate (CATALOG_INGEST_SHOT_CLASSIFY_BUDGET_MS).'
  },

  // ── Hardcoded literals moved here (current behaviour as defaults) ───
  CAMPAIGN_BRIEF_CONCURRENCY: {
    env: 'CAMPAIGN_BRIEF_CONCURRENCY',
    default: 3,
    min: 1,
    max: 16,
    ceiling: 'SELF-IMPOSED',
    why: 'In-flight campaign-brief LLM derivations after campaign sync (campaignSyncService).'
  },
  AI_LAYOUT_COMBO_CONCURRENCY: {
    env: 'AI_LAYOUT_COMBO_CONCURRENCY',
    default: 3,
    min: 1,
    max: 16,
    ceiling: 'SELF-IMPOSED',
    why: 'In-flight layout-reference image gens in AI Layout Studio (aiLayoutStudioService).'
  },
  CLOUDINARY_DELETE_CONCURRENCY: {
    env: 'CLOUDINARY_DELETE_CONCURRENCY',
    default: 4,
    min: 1,
    max: 32,
    ceiling: 'SELF-IMPOSED',
    why: 'Parallel Cloudinary destroy calls in deleteManyFromCloudinary. Free tier ~500 ops/hr; modest default avoids cascade-delete storms. Cloudinary paid tiers allow higher.'
  },
  CATALOG_MATERIALIZE_CONCURRENCY: {
    env: 'CATALOG_MATERIALIZE_CONCURRENCY',
    default: 4,
    min: 1,
    max: 16,
    ceiling: 'SELF-IMPOSED',
    why: 'Parallel materializeMissingHero() calls in catalogMaterializeDrainService — each is one Cloudinary UPLOAD (mirror source imageUrl), the upload-side twin of CLOUDINARY_DELETE_CONCURRENCY and deliberately given the SAME default and the SAME "free tier ~500 ops/hr" caution: this is a bulk-materialize sweep over an entire brand catalog (measured 826 candidates on Pelagic Gear, thousands more queued behind Marine Layer), i.e. exactly the kind of burst the delete limiter already exists to avoid on the other side of the same account-level quota. No vision/LLM spend rides on this path (materializeMissingHero is deliberately hero-only, no DetectRun) so the only cost this knob paces is Cloudinary transfer + our own egress, not money. Raise once measured safe against a real multi-thousand-product brand.'
  },
  CATEGORY_INFERENCE_DOMAIN_CONCURRENCY: {
    env: 'CATEGORY_INFERENCE_DOMAIN_CONCURRENCY',
    default: 3,
    min: 1,
    max: 16,
    ceiling: 'SELF-IMPOSED',
    why: 'Per-host concurrent product-page scrapes for category inference. Protects Cloudflare/Fastly-fronted stores.'
  },
  CATEGORY_INFERENCE_BATCH_CONCURRENCY: {
    env: 'CATEGORY_INFERENCE_BATCH_CONCURRENCY',
    default: 6,
    min: 1,
    max: 32,
    ceiling: 'SELF-IMPOSED',
    why: 'Global worker pool for inferBatch (and catalog/ingest call sites). Per-domain cap still applies. Default matches prior call-site value of 6.'
  },
  META_PUSH_CONCURRENCY: {
    env: 'META_PUSH_CONCURRENCY',
    default: 3,
    min: 1,
    max: 16,
    ceiling: 'SELF-IMPOSED',
    why: 'In-flight Meta Graph ad-publish rows per pushAdsBatch. Meta write throttling is account-level; 3 is conservative.'
  },
  VOICE_SWEEP_CONCURRENCY: {
    env: 'VOICE_SWEEP_CONCURRENCY',
    default: 2,
    min: 1,
    max: 8,
    ceiling: 'SELF-IMPOSED',
    why: 'In-flight brand-voice LLM refreshes in the scheduled voice sweep. Low to avoid burning OpenAI quota on a backlog tick.'
  }
});

function parseNumber(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function resolveKnob(spec) {
  const raw = process.env[spec.env];
  let v = parseNumber(raw, spec.default);
  // Always floor at min.
  if (typeof spec.min === 'number') v = Math.max(spec.min, v);
  // PROVIDER-IMPOSED: hard ceiling — env cannot raise above max.
  // SELF-IMPOSED: soft cap for sanity (typos like 99999).
  if (typeof spec.max === 'number') v = Math.min(spec.max, v);
  // Integers for concurrency counts; GROK_MAX_RPS and spacing keep floats/ints as resolved.
  if (spec.env !== 'GROK_MAX_RPS' && spec.env !== 'ATLAS_SUBMIT_SPACING_MS') {
    v = Math.floor(v);
  }
  return v;
}

/** Resolve every knob once. Call after dotenv / defaults.env are loaded. */
function resolveAll() {
  const out = {};
  for (const [key, spec] of Object.entries(SPEC)) {
    out[key] = resolveKnob(spec);
  }
  // Derived: Grok min start-to-start spacing from the (capped) RPS.
  // 1 RPS → 1000ms; 0.5 RPS → 2000ms. Never below 1000ms when max RPS is 1.
  const rps = out.GROK_MAX_RPS;
  out.GROK_MIN_SUBMIT_SPACING_MS = Math.max(1000, Math.ceil(1000 / rps));
  return out;
}

/** True for Grok Imagine video model slugs (aspect-fallback + selectable). */
function isGrokModel(model) {
  return typeof model === 'string' && model.startsWith('xai/grok');
}

/**
 * Effective submit spacing for a model slug.
 * Grok always gets at least GROK_MIN_SUBMIT_SPACING_MS (PROVIDER 1 RPS).
 * Other models use ATLAS_SUBMIT_SPACING_MS only.
 */
function submitSpacingMsForModel(model, values = null) {
  const v = values || resolveAll();
  const base = v.ATLAS_SUBMIT_SPACING_MS;
  if (isGrokModel(model)) return Math.max(base, v.GROK_MIN_SUBMIT_SPACING_MS);
  return base;
}

/** One-line boot log of every resolved value + ceiling kind. */
function logConcurrencyConfig(values = null) {
  const v = values || resolveAll();
  const lines = Object.entries(SPEC).map(([key, spec]) => {
    const val = v[key];
    const tag = spec.ceiling === 'PROVIDER-IMPOSED' ? 'PROVIDER' : 'self';
    return `${key}=${val}[${tag}]`;
  });
  lines.push(`GROK_MIN_SUBMIT_SPACING_MS=${v.GROK_MIN_SUBMIT_SPACING_MS}[derived]`);
  console.log(`⚙️  concurrency: ${lines.join(' ')}`);
  return v;
}

// Resolve at first require. index.js / worker.js load defaults.env BEFORE
// requiring app code, so this sees the right env. Tests that mutate
// process.env can call resolveAll() / rebuild for a fresh snapshot.
const concurrency = Object.freeze(resolveAll());

module.exports = {
  SPEC,
  concurrency,
  resolveAll,
  resolveKnob,
  isGrokModel,
  submitSpacingMsForModel,
  logConcurrencyConfig
};
