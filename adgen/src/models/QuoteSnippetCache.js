'use strict';
//
// QUOTE SNIPPET CACHE — cross-process persistence for the review-text LLM.
//
// WHY (2026-08-26, Phase 2 of the wall-time reduction plan). services/
// quoteSnippetService.extractSnippet was designed with a per-PROCESS LRU only
// (see snippetCache in that file). Measured live on run_1787696303378
// (2026-08-25 22:18): the SAME quote ("fit and look great") was regenerated
// TWICE at 15.7s + 15.9s = 31 seconds of duplicate LLM time on a single 9-ad
// batch, because two different renderer processes each cold-hit the LRU and
// each paid the full LLM round trip.
//
// This model adds a cross-process cache layer between LRU and LLM:
//   1. LRU check (fast, no I/O)
//   2. Mongo check (this collection, ~5-10ms)
//   3. LLM call (~15-30s)
// On LLM success, both LRU and Mongo receive the snippet. On a MECHANICAL
// fallback (LLM failed / rate-limited) only LRU is written — Mongo caches
// only verified LLM output, so a subsequent process retries the LLM in case
// the failure was transient. Same principle as the mechanical() rationale
// in quoteSnippetService.
//
// ── KEY DESIGN ──────────────────────────────────────────────────────────
// The document _id is the SHA-1 that snippetCacheKey() already computes
// (clean text + brandId + productId). Reusing the LRU key means the two
// tiers cannot drift, and the LRU lookup and Mongo lookup return the same
// value when both hit.
//
// ── TTL ────────────────────────────────────────────────────────────────
// 30 days. Reviews rarely change in a way that makes the LLM verdict stale;
// 30 days is generous headroom that Mongo will trim automatically via the
// TTL index below.
//
// ── OBSERVABILITY ───────────────────────────────────────────────────────
// `hits` is $inc'd on every cache read that returns a value, so DB analytics
// can measure the cache's return on cost (how many LLM calls avoided). Not
// load-bearing.

const mongoose = require('mongoose');

const quoteSnippetCacheSchema = new mongoose.Schema({
  // _id is the sha1(clean|brandId|productId) hex — matches quoteSnippetService's
  // snippetCacheKey. Passed explicitly on upsert.
  _id: { type: String, required: true },

  // The verified LLM-returned snippet, verbatim-cut from source. This is the
  // ONLY thing quoteSnippetService returns from a cache read.
  snippet: { type: String, required: true },

  // brandId / productId denormalized for analytics ("how much did this brand
  // pay in LLM avoided cost"). Not used in the read path — the SHA-1 already
  // encodes them.
  brandId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Brand',           index: true, default: null },
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'CatalogProduct',  index: true, default: null },

  // Hit counter for observability. $inc'd on every read that returns a value.
  hits: { type: Number, default: 0 },

  // createdAt has ONE index: the TTL below (expireAfterSeconds). Don't add
  // a second field-level `index: true` — mongoose warns on the duplicate.
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, {
  collection: 'quotesnippetcache',
  minimize: false
});

// TTL — 30 days from createdAt. A refreshed hit does NOT reset createdAt
// (that's what `updatedAt` is for), so a hot entry ages out and gets
// re-verified against the LLM every ~30 days. Preferred over a hits-based
// eviction because it self-refreshes the LLM's judgement on lingering data.
quoteSnippetCacheSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports = mongoose.model('QuoteSnippetCache', quoteSnippetCacheSchema);
