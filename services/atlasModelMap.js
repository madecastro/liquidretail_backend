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
  // THREE CONSTRAINTS, probed live rather than assumed:
  //  - response_format json_schema  -> HTTP 400, on text AND vision alike.
  //  - response_format json_object  -> accepted but NOT ENFORCED (probed
  //    2026-08-04: with and without the flag both returned prose). Callers
  //    MUST put the JSON contract in the prompt and salvage/validate in code
  //    (see aiCreativeDirectorService OUTPUT CONTRACT + safeParseDirectorJSON).
  //  - vision (image_url parts)     -> works; confirmed sees_image=true and a
  //    correct colour reading. Earlier notes claiming Claude could not do vision
  //    with structured output were wrong: strict schema is the only blocker.
  //
  // reasoning_effort is NOT set: the flat form 400s, and the nested
  // reasoning:{effort} form showed no reproducible benefit on this task (the
  // run-to-run spread at temperature 0.7 was larger than the effect). Consistency
  // comes from the lower temperature and the validator below instead.
  // ROUTE CHANGED 2026-08-04: '-ccmax' → the plain route. `-ccmax` is a Claude
  // CODE agent endpoint, not a plain completion route. Probed live: it returned
  // a tool call named `Grep` — a tool WE NEVER DEFINED — so it carries its own
  // coding-agent toolset, and it ignores `tool_choice` as well as
  // `response_format`. That is why it answered with markdown documents
  // ("## Concept") and conversational preambles instead of JSON.
  // 4 trials each, identical prompt, thin brief:
  //   -ccmax  1/4 usable · 2/4 missing `name` · 1/4 unparseable JSON
  //   plain   4/4 usable, every concept carrying routing.media_picks
  // The 'name'-missing arm matches the `concepts[0].name is missing` warnings
  // production logged. Same model family the 2026-07-31 bake-off picked —
  // this drops the agent wrapper, not the model.
  //
  // ── CROSS-PROVIDER FALLBACK CHAIN (added 2026-08-18, owner directive) ──
  //
  // THE OUTAGE THIS EXISTS FOR. Static ad generation ran at a 100% failure
  // rate for ~20h. Probed live from the production service, same
  // ATLAS_API_KEY, sequential single calls, no concurrency:
  //   anthropic/claude-sonnet-5           -> HTTP 429 after ~51 SECONDS
  //   anthropic/claude-opus-5             -> HTTP 429 after ~50s
  //   anthropic/claude-sonnet-4.5-2025…   -> HTTP 429 after ~50s
  //   anthropic/claude-sonnet-4.6         -> 200, but 52s
  //   anthropic/claude-sonnet-5-ccmax     -> 200 in 1.7s
  //   openai/gpt-5.6-terra                -> 200 in 1.0s
  //   google/gemini-2.5-pro / -flash      -> 200 in 1.7s / 0.7s
  // So Atlas is CAPACITY-STARVED on several direct Anthropic routes. Not our
  // payload (every shape 429'd, including one with an invalid temperature that
  // should have 400'd first), not the model id (sonnet-5 is live in the
  // catalog), not credit (other providers answer instantly on the same key),
  // and not the temperature-400 (rejectsSamplingParams already covers it).
  //
  // WHY THE EXISTING `direct` FALLBACK DID NOT SAVE US, and this is the whole
  // lesson: `direct.provider === 'anthropic'` has NO KEY. DIRECT_KEYS in
  // atlasLlmService only knows openai (OPENAI_API_KEY) and google
  // (GEMINI_API_KEY), and neither Render service carries ANTHROPIC_API_KEY
  // (WEB 24 vars, WORKER 15 — checked). So the Director's configured fallback
  // was structurally incapable of firing, silently, while layoutInputService
  // survived the same Atlas errors purely because ITS fallback is google.
  // A same-provider fallback is not a fallback when the provider is the thing
  // that is down — hence a chain that SPANS providers.
  //
  // ORDER — owner directive, verbatim: "let's fallback to Opus, then go to
  // GPT5.6Terra". opus-5 is ALSO 429 today; it stays in the chain on purpose,
  // because the chain exists precisely so a starved link is skipped in ~50s
  // rather than removed from the design. Quality order matches the
  // 2026-07-31 blind bake-off (sonnet-5 > opus-5 > gpt-5.6-terra).
  //
  // Each link keeps its own `direct` twin with the ORIGINAL vendor model name,
  // same operator directive as every other row. Two of the three are inert
  // until ANTHROPIC_API_KEY exists; that is honest, and the transport skips a
  // keyless direct twin for free (no request, no latency).
  //
  // openai/gpt-5.6-terra is NOT a fresh id from memory — it is the same slug
  // the 'gpt-4.1'/'gpt-4o' rows below already resolve to (verified routable
  // 2026-07-21 with a real chat probe) and the owner re-probed it live today.
  // Its direct twin is 'gpt-4.1' for the same reason: that pair is already in
  // this file and already known good on api.openai.com.
  //
  // SAMPLING, and this is deliberately asymmetric — see (c) in the transport:
  // the Director asks for temperature 0.45 (chosen for CONSISTENCY, not
  // creativity — see DIRECTOR_ROUND_TEMP). The two Claude 5 links CANNOT
  // honour it: Atlas bare-400s temperature/top_p/top_k on that family, so
  // rejectsSamplingParams strips them and those links run at the model's own
  // default. The OpenAI link DOES honour 0.45. So the fallback link runs MORE
  // deterministically than the primary. That is a real behavioural difference
  // and it is stated here rather than discovered later.
  //
  // KNOWN, ACCEPTED FALLBACK DEFECT: terra was the bake-off's eliminated
  // incumbent, specifically for setting the product name in all three concepts
  // against an explicit directive. validateDirectorPayload's `forbiddenStrings`
  // scan catches exactly that, so a terra-served round is likelier to burn its
  // one corrective re-ask and to emit a 'director:contract-warn'. Degraded
  // output beats zero ads — that is the trade, and the fallback-served Slack
  // notice exists so nobody mistakes it for normal.
  //
  // A FOURTH LINK (google/gemini-2.5-pro, measured 1.7s, key present) is one
  // line away and deliberately NOT added: the owner named a three-link order,
  // and every extra link raises the worst-case paid-attempt count.
  'director':         {
    atlas: 'anthropic/claude-sonnet-5', direct: { provider: 'anthropic', model: 'claude-sonnet-5' },
    chain: [
      { atlas: 'anthropic/claude-sonnet-5', direct: { provider: 'anthropic', model: 'claude-sonnet-5' } },
      { atlas: 'anthropic/claude-opus-5',   direct: { provider: 'anthropic', model: 'claude-opus-5'   } },
      { atlas: 'openai/gpt-5.6-terra',      direct: { provider: 'openai',    model: 'gpt-4.1'         } },
    ],
  },

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
  // enabling SystemConfig vision QC — catalog listing alone is not enough
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
  // QC-insights proposal stage (services/qcInsightsProposalService.js).
  // Text-only strict-JSON task: propose additive prompt directives from
  // aggregated vision-QC stats. Same model family already proven routable
  // and reliable for `ad-vision-qc` (live 200 + valid JSON). Own role so it
  // can be repointed independently of the vision gate — and so this path
  // never lands on the capacity-starved Anthropic Atlas routes documented
  // on MAP.director above. Override: ATLAS_MODEL_QC_INSIGHTS=<slug>.
  'qc-insights':      { atlas: 'google/gemini-2.5-pro',   direct: { provider: 'google', model: 'gemini-2.5-pro' } },
  // Typeface identification from a brand's Meta ad creatives
  // (metaAdsFontService). Same model and the same reason as 'ad-vision-qc': the
  // task is fine-grained visual discrimination between similar letterforms, and
  // the answer must arrive in a fixed JSON shape because a malformed verdict is
  // consumed as "identified nothing". Kept as its OWN role rather than reusing
  // 'ad-vision-qc' so either can be repointed without moving the other — the
  // 'gpt-4.1' entry is shared by 11 services and that is exactly the trap.
  'font-vision':      { atlas: 'google/gemini-2.5-pro',   direct: { provider: 'google', model: 'gemini-2.5-pro' } },
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

// The Claude 5 family refuses the sampling knobs through Atlas: a request
// carrying temperature (!= 1), top_p or top_k comes back as a bare
// HTTP 400 {"code":400,"msg":"bad request"} with no field named. That is the
// Anthropic extended-thinking constraint — with thinking on, sampling is not
// the caller's to set — now enforced at the gateway.
//
// Probed live 2026-08-10 against the production key:
//   anthropic/claude-sonnet-5  temperature 0 / 0.45 / 0.7 → 400
//                              top_p 0.9 → 400, top_k 40 → 400
//                              temperature 1, or omitted  → 200
//   anthropic/claude-opus-5    temperature 0.45 → 400, omitted → 200
//   claude-opus-4.8 / sonnet-4.6 / sonnet-4.5 → temperature accepted
//   every openai/* and google/* slug          → temperature accepted
// max_tokens, response_format, stop, seed, frequency_penalty and
// presence_penalty were all accepted and are deliberately NOT stripped.
//
// This ran static ad generation at a 100% failure rate: role 'director' is the
// only Anthropic entry in MAP, and it sends temperature 0.45, so every
// concept-driven expansion threw and no static Ad row was ever created. Last
// good Director round 2026-08-07 21:20 UTC, first failure 2026-08-10 15:17 UTC,
// with NO deploy in between — the change was Atlas-side, not ours.
//
// Stripping (rather than pinning to 1) is deliberate: 1 is already the model's
// default, and an explicit 1 would imply we still control a knob we do not.
const CLAUDE_5_FAMILY = /^anthropic\/claude-(?:opus|sonnet|haiku)-5(?:$|[-.])/;

/**
 * True when the resolved Atlas slug rejects temperature/top_p/top_k.
 * Lives here, not in a transport, because it is a fact about the MODEL —
 * both atlasLlmService and atlasLlmStreamService consume it so the two
 * transports cannot drift on it.
 */
function rejectsSamplingParams(atlasId) {
  return CLAUDE_5_FAMILY.test(String(atlasId || ''));
}

// Params the Claude 5 family refuses. Exported so a harness can assert the
// transports strip exactly this set and nothing more.
const SAMPLING_PARAMS = Object.freeze(['temperature', 'top_p', 'top_k']);

function stripSamplingParams(body) {
  for (const k of SAMPLING_PARAMS) delete body[k];
  return body;
}

/**
 * Resolve a legacy model id (or an already-prefixed Atlas slug) to
 * { atlas, direct }. Unknown ids pass through unchanged as the atlas id
 * (with a same-id openai direct fallback only when un-prefixed).
 *
 * This is the PRIMARY LINK ONLY. A role that declares a cross-provider
 * `chain` still resolves here to its head, so every existing caller
 * (atlasLlmStreamService, the harnesses) is unchanged. Callers that want the
 * whole chain ask for it by name — see resolveChain.
 */
function resolveModel(id) {
  const entry = MAP[id];
  if (entry) {
    const override = process.env[envKeyFor(id)];
    if (!override) return entry;
    // An override must not drag a contradicting `chain` along with it. The
    // operator named ONE model; returning the role's chain beside it would
    // silently re-add paid attempts against models they just overrode away.
    const out = { ...entry, atlas: override };
    delete out.chain;
    return out;
  }
  if (id && id.includes('/')) return { atlas: id, direct: null }; // already an Atlas slug
  return { atlas: id, direct: id ? { provider: 'openai', model: id } : null };
}

/**
 * The ORDERED list of candidates for a role: [{ atlas, direct }, …].
 *
 * Every role that does NOT declare `chain` returns exactly one link, whose
 * contents are `resolveModel(id)` — so the transport's chain loop over a
 * one-element list is, by construction, the behaviour those roles have today.
 * That equivalence is the reason `chain` is an OPT-IN field on the entry
 * rather than a second Director-specific code path: one mechanism, one loop,
 * and the "every other role is unchanged" claim is structural instead of
 * something a reviewer has to re-derive per role.
 *
 * ENV OVERRIDE PRECEDENCE (documented choice, not an accident):
 *   ATLAS_MODEL_<ROLE> WINS TOTALLY and collapses the chain to ONE link.
 * Reasoning: the override is the zero-deploy emergency lever. An operator
 * reaching for it during an outage is naming the model they want to run RIGHT
 * NOW; quietly appending two more models — each a paid attempt and up to ~50s
 * of 429 latency — would make the lever less predictable exactly when
 * predictability is the point. The cost of this choice, stated plainly: an
 * override pointed at a starved model reinstates the outage until it is
 * changed again, which takes about thirty seconds in the Render dashboard.
 */
function resolveChain(id) {
  const entry = MAP[id];
  if (entry) {
    const override = process.env[envKeyFor(id)];
    if (override) return [{ atlas: override, direct: entry.direct || null }];
    if (Array.isArray(entry.chain) && entry.chain.length) {
      return entry.chain.map((l) => ({ atlas: l.atlas, direct: l.direct || null }));
    }
  }
  const head = resolveModel(id);
  return [{ atlas: head.atlas, direct: head.direct || null }];
}

module.exports = {
  resolveModel,
  resolveChain,
  envKeyFor,
  MAP,
  rejectsSamplingParams,
  stripSamplingParams,
  SAMPLING_PARAMS,
};
