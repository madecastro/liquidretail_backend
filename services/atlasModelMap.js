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
  // Slugs below are the exact routable catalog ids, so an operator can paste
  // one straight into ATLAS_MODEL_REVIEW_TEXT and still match a MODEL_RATES
  // entry in costTracker — an abbreviated slug resolves to no price and logs
  // the call at $0.
  //
  //   google/gemini-2.5-flash-lite         0 fail 0 off 0 non-verbatim  $0.000012   851ms  ← chosen
  //   openai/gpt-5.6-luna                  0 fail 0 off 0 non-verbatim  $0.000195  1245ms
  //   bytedance/doubao-seed-1.6-flash-250828  0 fail 0 off 0 non-verbatim  $0.000406 15526ms
  //   anthropic/claude-haiku-4.5-20251001  1 fail 0 off 5/6 NON-VERBATIM $0.000124 1223ms
  //   openai/gpt-5-nano                    HTTP 400 "router not found" — listed, not routable
  //   qwen/qwen3.5-flash                   HTTP 400 on strict json_schema
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

  // CREATIVE DIRECTOR role — its own logical name, deliberately NOT a repointed
  // 'gpt-4.1'. Eleven other services share that name (NER, brand enrichment,
  // crop refine, layout studio, canvas spec, the HTML generator, veo storyboard,
  // subject text), and several send strict json_schema, which Atlas rejects with
  // 400 for Anthropic models. Repointing the shared name would have switched all
  // of them at once and broken every schema user silently.
  //
  // Selected by owner review of a blind bake-off (2026-07-31): three candidates
  // each produced three concepts from one brief and seven real catalog photos,
  // and every concept was rendered to a finished ad before judging — the JSON on
  // its own was not a fair test. Ranking: sonnet-5 > opus-5 > gpt-5.6-terra, with
  // terra (the incumbent) eliminated for setting the product name in all three
  // concepts against an explicit directive and never once requesting a second
  // reference image. Sonnet is also the cheapest Claude of the three at $2/$10
  // per M — $0.105 per director run against $0.223 for opus.
  //
  // TWO CONSTRAINTS, probed live rather than assumed:
  //  - response_format json_schema  -> HTTP 400, on text AND vision alike.
  //    Callers MUST use json_object and validate in code.
  //  - vision (image_url parts)     -> works; confirmed sees_image=true and a
  //    correct colour reading. Earlier notes claiming Claude could not do vision
  //    with structured output were wrong: strict schema is the only blocker.
  //
  // reasoning_effort is NOT set: the flat form 400s, and the nested
  // reasoning:{effort} form showed no reproducible benefit on this task (the
  // run-to-run spread at temperature 0.7 was larger than the effect). Consistency
  // comes from the lower temperature and the validator below instead.
  'director':         { atlas: 'anthropic/claude-sonnet-5-ccmax', direct: { provider: 'anthropic', model: 'claude-sonnet-5' } },

  'gpt-4.1':          { atlas: 'openai/gpt-5.6-terra', direct: { provider: 'openai', model: 'gpt-4.1' } },
  'gpt-4.1-mini':     { atlas: 'openai/gpt-5.6-luna',  direct: { provider: 'openai', model: 'gpt-4.1-mini' } },
  'gpt-4o-mini':      { atlas: 'openai/gpt-5.6-luna',  direct: { provider: 'openai', model: 'gpt-4o-mini' } },
  'gpt-4o':           { atlas: 'openai/gpt-5.6-terra', direct: { provider: 'openai', model: 'gpt-4o' } },
  'gemini-2.5-flash': { atlas: 'google/gemini-2.5-flash', direct: { provider: 'google', model: 'gemini-2.5-flash' } },
  'gemini-2.5-pro':   { atlas: 'google/gemini-2.5-pro',   direct: { provider: 'google', model: 'gemini-2.5-pro' } },
  // Post-render vision QC role (services/adVisionQcService.js). Points at the
  // same google/gemini-2.5-flash slug already used for vision identify/match
  // (geminiIdentifyService, visualCatalogMatchService). CHEAP + vision-
  // capable. CRITICAL: confirm ROUTABLE with a live chat probe before
  // enabling AD_VISION_QC_ENABLED — catalog listing alone is not enough
  // (openai/gpt-5-nano is listed but returns HTTP 400 "router not found").
  // Override: ATLAS_MODEL_AD_VISION_QC=<slug>.
  // PRO, not flash — and the draft that introduced this role had it wrong.
  // Both were probed live against a real defect (a Timberland-shaped emblem
  // hallucinated onto an Allbirds shoe) and BOTH caught it, but flash broke the
  // requested JSON shape: it returned `competitor_marks` as a bare boolean and
  // hoisted `findings` out of its object. A malformed verdict is worse than no
  // verdict here — it either ships a bad ad or burns the single allowed
  // regeneration for nothing. The ~$0.0094 delta per check is noise against the
  // $0.01–0.17 generation it protects.
  'ad-vision-qc':     { atlas: 'google/gemini-2.5-pro',   direct: { provider: 'google', model: 'gemini-2.5-pro' } },
  // NO 'quote-snippet' ROLE — deliberately removed, do not re-add it.
  // It mapped to openai/gpt-5-nano, which the benchmark above records as
  // HTTP 400 "router not found": listed in the catalog, not routable. A role
  // is only reachable by name, so the entry sat here inert while the one
  // caller that would have used it (quoteSnippetService) had already been
  // pointed at 'review-text'. Leaving a role wired to a model that 400s is a
  // trap — the next caller to reach for the obvious name gets a silent
  // degrade to mechanical truncation, and gpt-5-nano has no MODEL_RATES entry
  // either, so the failure would not even show up as cost.
  // Review-text work goes through 'review-text'.
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
