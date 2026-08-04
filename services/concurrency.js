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
    why: 'In-flight static/image ads per campaign run. 4→8 (2026-08-02): image submits are unpaced and 8 concurrent openai/gpt-image-2/edit measured clean (85s wall, zero 429s). 8→24 (2026-08-04, owner-directed: renders should all go to Atlas at once). MAX_CREATIVES_PER_RUN=20, so 24 makes this gate non-binding for a full run. Spend is unchanged — the submit COUNT is fixed by the ad count, only the rate moves. Unmeasured above 8: watch for 429 backoff on the first full-size run.'
  },
  VEO_CONCURRENCY: {
    env: 'VEO_CONCURRENCY',
    default: 4,
    min: 1,
    max: 32,
    ceiling: 'SELF-IMPOSED',
    why: 'In-flight video ads per campaign run. Raised 1→4 (2026-08-02) as a deliberate probe: Omni RPS is unpublished/unmeasured; the old "stay at 1" justification belonged to retired direct-Veo and to Grok\'s real 1 RPS (aspect-fallback only). Re-measure before going higher. NOT 16.'
  },
  MAX_CREATIVES_PER_RUN: {
    env: 'MAX_CREATIVES_PER_RUN',
    default: 20,
    min: 1,
    max: 200,
    ceiling: 'SELF-IMPOSED',
    why: 'Hard cap on ads claimed into one CampaignRun. Cartesian product×template×ratio expansion.'
  },

  // ── Worker process ──────────────────────────────────────────────────
  WORKER_CONCURRENCY: {
    env: 'WORKER_CONCURRENCY',
    default: 5,
    min: 1,
    max: 100,
    ceiling: 'SELF-IMPOSED',
    why: 'Parallel DetectRun/Job polling loops inside the worker process. I/O-bound; Mongo pool scales with it.'
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
