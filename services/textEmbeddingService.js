// Text-embedding client — mirrors atlasLlmService's Atlas-primary /
// OpenAI-direct-fallback pattern for the /v1/embeddings endpoint.
//
// Built for T3 (2026-08-17) — semantic-similarity tier in
// findCatalogMatchByText. Token-overlap alone misses "sweater ↔
// pullover", "chore coat ↔ shacket", etc.; a small embedding model
// closes the gap for negligible cost.
//
// Cost floor: openai/text-embedding-3-small is ~$0.02 per 1M tokens.
// A 20-token title + 100-token caption × 500 candidates × 20 runs/day
// ≈ 12M tokens/month ≈ $0.24/mo. Persist embeddings on
// CatalogProduct.titleEmbedding so we only pay for each product once.

'use strict';

const axios = require('axios');
const crypto = require('crypto');
const { trackLlmCall } = require('./costTracker');

const ATLAS_EMBED_URL = (process.env.ATLAS_TEXT_BASE_URL || 'https://api.atlascloud.ai/v1') + '/embeddings';
const OPENAI_EMBED_URL = 'https://api.openai.com/v1/embeddings';

const MODEL_ID = process.env.TEXT_EMBEDDING_MODEL || 'openai/text-embedding-3-small';
const DIRECT_MODEL_ID = MODEL_ID.replace(/^openai\//, '');
const TIMEOUT_MS = Number(process.env.ATLAS_LLM_TIMEOUT_MS || 60_000);

function isConfigured() {
  return !!process.env.ATLAS_API_KEY;
}
function directKey() {
  return process.env.OPENAI_API_KEY;
}

async function post(url, key, body) {
  return axios.post(url, body, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    timeout: TIMEOUT_MS,
    validateStatus: () => true
  });
}

// Content-based digest so we can tell whether a stored embedding still
// matches its source text. Kept short (16 hex chars = 64 bits — plenty
// of collision headroom for a per-product cache key).
function digestOf(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16);
}

// Cosine similarity for pre-normalized vectors (OpenAI embeddings are
// L2-normalized). For non-normalized vectors we'd divide by the norms;
// for OpenAI's case dot product IS cosine.
function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * embed(meta, input) → { embeddings: number[][], model, digest }
 *   meta:  { service, purposeTag, brandId, cacheKey } for cost ledger.
 *   input: string OR string[]. Non-empty strings only.
 * Throws when both Atlas + OpenAI fail; returns null when the model is
 * disabled at the env level.
 */
async function embed(meta, input) {
  const arr = Array.isArray(input) ? input : [input];
  const strs = arr.map(s => String(s || '').trim()).filter(Boolean);
  if (!strs.length) return { embeddings: [], model: null, digests: [] };

  const digests = strs.map(digestOf);
  const body = { model: MODEL_ID, input: strs, encoding_format: 'float' };

  // ── Atlas primary ──
  let lastErr = null;
  if (isConfigured()) {
    try {
      const res = await trackLlmCall(
        { ...meta, provider: 'atlas', model: MODEL_ID, purpose: (meta?.purpose || meta?.purposeTag || '') },
        async () => {
          const r = await post(ATLAS_EMBED_URL, process.env.ATLAS_API_KEY, body);
          if (r.status !== 200) {
            const e = new Error(`Atlas embed ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
            e.status = r.status;
            throw e;
          }
          return r.data;
        }
      );
      return {
        embeddings: (res.data || []).map(d => d.embedding),
        model:      MODEL_ID,
        digests
      };
    } catch (err) {
      lastErr = err;
    }
  }

  // ── OpenAI direct fallback ──
  const key = directKey();
  if (!key) throw lastErr || new Error('no ATLAS_API_KEY and no OPENAI_API_KEY for embeddings');
  console.warn(`🌐 textEmbedding: falling back to direct openai/${DIRECT_MODEL_ID} (${lastErr?.message?.slice(0, 120) || 'no atlas'})`);
  const directBody = { ...body, model: DIRECT_MODEL_ID };
  const res = await trackLlmCall(
    { ...meta, provider: 'openai', model: DIRECT_MODEL_ID, purpose: (meta?.purpose || meta?.purposeTag || '') + ':direct-fallback' },
    async () => {
      const r = await post(OPENAI_EMBED_URL, key, directBody);
      if (r.status !== 200) throw new Error(`direct openai embed ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
      return r.data;
    }
  );
  return {
    embeddings: (res.data || []).map(d => d.embedding),
    model:      DIRECT_MODEL_ID,
    digests
  };
}

function isEnabled() {
  return process.env.CATALOG_TEXT_EMBEDDING_ENABLED === 'true';
}

module.exports = { embed, cosine, digestOf, isEnabled, MODEL_ID };
