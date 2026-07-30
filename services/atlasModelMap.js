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
  'gpt-4.1':          { atlas: 'openai/gpt-5.6-terra', direct: { provider: 'openai', model: 'gpt-4.1' } },
  'gpt-4.1-mini':     { atlas: 'openai/gpt-5.6-luna',  direct: { provider: 'openai', model: 'gpt-4.1-mini' } },
  'gpt-4o-mini':      { atlas: 'openai/gpt-5.6-luna',  direct: { provider: 'openai', model: 'gpt-4o-mini' } },
  'gpt-4o':           { atlas: 'openai/gpt-5.6-terra', direct: { provider: 'openai', model: 'gpt-4o' } },
  'gemini-2.5-flash': { atlas: 'google/gemini-2.5-flash', direct: { provider: 'google', model: 'gemini-2.5-flash' } },
  'gemini-2.5-pro':   { atlas: 'google/gemini-2.5-pro',   direct: { provider: 'google', model: 'gemini-2.5-pro' } },
  // Extract one short phrase from one short review. Tiny in, ~60 tokens out,
  // strict json_schema, no reasoning. It was riding the 'gpt-4o-mini' role,
  // which maps to gpt-5.6-luna at $1.00/$6.00 per 1M — 20x the input and 15x
  // the output of the nano tier for a task that is a substring search with
  // taste. Prices verified against the live Atlas catalog 2026-07-30.
  // Direct fallback stays on gpt-4o-mini: a known-good OpenAI model name, and
  // this role only reaches it if Atlas is unavailable.
  'quote-snippet':    { atlas: 'openai/gpt-5-nano',       direct: { provider: 'openai', model: 'gpt-4o-mini' } },
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
