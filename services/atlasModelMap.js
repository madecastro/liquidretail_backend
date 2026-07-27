// Atlas model map — the single place legacy provider model IDs resolve
// to Atlas Cloud gateway slugs, with the ORIGINAL direct-provider model
// retained as the fallback target (operator directive: keep fallbacks
// with direct providers).
//
// Every atlas slug here was verified ROUTABLE against the live catalog +
// a real chat probe on 2026-07-21 (catalog listing alone is not enough —
// openai/gpt-4.1 is listed but has no router). The gpt-4.x/4o family has
// no Atlas router, so those roles substitute the routable gpt-5.6 line:
//   gpt-4.1      → openai/gpt-5.6-terra ("dependable general-purpose",
//                  same $2.5/$15 price point as gpt-4.1 held)
//   gpt-4.1-mini → openai/gpt-5.6-luna  (cheapest routable OpenAI, $1/$6)
//   gpt-4o-mini  → openai/gpt-5.6-luna
// Direct fallbacks keep the original model names, which still exist on
// the vendors' own APIs.
//
// Env overrides: ATLAS_MODEL_<ROLE> (dots/dashes → underscores, upper),
// e.g. ATLAS_MODEL_GPT_4_1=openai/gpt-5.4 re-points every gpt-4.1 call.

'use strict';

const MAP = Object.freeze({
  // ── review-text role ─────────────────────────────────────────────
  //
  // Short-context, high-volume, latency-tolerant work over customer review
  // sentences: pulling the sharpest phrase out of a review, judging which
  // review is worth quoting. Under ~2k tokens in, under ~300 out, and called
  // once per ad rather than once per catalog row — see docs/REVIEW_VENDORS.md
  // §11 for why the per-review storage path uses no model at all.
  //
  // A ROLE, not a model, so the choice lives in exactly one place and moves
  // with one env var (ATLAS_MODEL_REVIEW_TEXT).
  //
  // CHOSEN BY MEASUREMENT, 2026-07-27 — 6 real reviews per model through the
  // actual quoteSnippetService schema and prompt, scored on hard failures,
  // off-product snippets, non-verbatim output, cost and latency:
  //
  //   google/gemini-2.5-flash-lite  0 fail  0 off  0 non-verbatim  $0.000012   851ms  ← chosen
  //   openai/gpt-5.6-luna           0 fail  0 off  0 non-verbatim  $0.000195  1245ms
  //   bytedance/doubao-1.6-flash    0 fail  0 off  0 non-verbatim  $0.000406 15526ms
  //   anthropic/claude-haiku-4.5    1 fail  0 off  5/6 NON-VERBATIM $0.000124 1223ms
  //   openai/gpt-5-nano             HTTP 400 "router not found" — listed, not routable
  //   qwen/qwen3.5-flash            HTTP 400 on strict json_schema
  //
  // 16x cheaper and 1.5x faster than the luna it replaces, with identical
  // correctness on the sample.
  //
  // WHY THE HEADLINE PRICES MISLEAD: the cheapest-looking slugs are REASONING
  // models, and hidden reasoning tokens are billed as output. doubao-1.6-flash
  // is nominally 20x cheaper per output token than luna but spent up to 5,735
  // reasoning tokens on a one-sentence extraction — so it is 2x more expensive
  // in practice, 12x slower, and blows the max_tokens+RESERVE budget (828),
  // which returns an empty message and silently degrades to mechanical
  // truncation. gemini-2.5-flash-lite spends ZERO reasoning tokens and emits
  // ~20. For short extractive work, "does it think" dominates the sticker price.
  //
  // claude-haiku-4.5 is disqualified on correctness, not cost: it returned
  // non-verbatim text for 5 of 6 reviews, which for a quote is a fabrication.
  //
  // Overridable per deployment: ATLAS_MODEL_REVIEW_TEXT=<slug>.
  'review-text':      { atlas: 'google/gemini-2.5-flash-lite', direct: { provider: 'google', model: 'gemini-2.5-flash-lite' } },

  'gpt-4.1':          { atlas: 'openai/gpt-5.6-terra', direct: { provider: 'openai', model: 'gpt-4.1' } },
  'gpt-4.1-mini':     { atlas: 'openai/gpt-5.6-luna',  direct: { provider: 'openai', model: 'gpt-4.1-mini' } },
  'gpt-4o-mini':      { atlas: 'openai/gpt-5.6-luna',  direct: { provider: 'openai', model: 'gpt-4o-mini' } },
  'gpt-4o':           { atlas: 'openai/gpt-5.6-terra', direct: { provider: 'openai', model: 'gpt-4o' } },
  'gemini-2.5-flash': { atlas: 'google/gemini-2.5-flash', direct: { provider: 'google', model: 'gemini-2.5-flash' } },
  'gemini-2.5-pro':   { atlas: 'google/gemini-2.5-pro',   direct: { provider: 'google', model: 'gemini-2.5-pro' } },
});

function envKeyFor(role) {
  return 'ATLAS_MODEL_' + role.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

/**
 * Resolve a legacy model id (or an already-prefixed Atlas slug) to
 * { atlas, direct }. Unknown ids pass through unchanged as the atlas id
 * (with a same-id openai direct fallback only when un-prefixed).
 */
function resolveModel(id) {
  const entry = MAP[id];
  if (entry) {
    const override = process.env[envKeyFor(id)];
    return override ? { ...entry, atlas: override } : entry;
  }
  if (id && id.includes('/')) return { atlas: id, direct: null }; // already an Atlas slug
  return { atlas: id, direct: id ? { provider: 'openai', model: id } : null };
}

module.exports = { resolveModel, MAP };
