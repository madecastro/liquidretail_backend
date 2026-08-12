// Video headline SELECTION — replaces layoutInputService.fallbackDerivation's
// literal headline templates ("Meet <productName>" / "See why customers love
// it") with a choice among copy the AI Creative Director already wrote for
// this (brand, product) pair, picked for FIT against the box the delivered
// video actually renders into.
//
// OWNER DIRECTIVES (verbatim, non-negotiable):
//   1. "I don't want any templated video headlines, they should all be on
//      brand and sound natural"
//   2. "Let's let the director make the call, it knows what the goal is and
//      what the intent is and it has a lot to choose from."
//
// This module never writes a new headline string. It only SELECTS among
// strings the Director already produced (copy.headline / .subheadline /
// .eyebrow across every concept in the most recent usable round), or
// returns null. Returning null is a deliberate, safe outcome — see the
// "NULL PATH" note near resolveVideoHeadline.
//
// ── LOOKUP HELPERS INVESTIGATED (services/aiCreativeDirectorService.js) ──
// Its module.exports: directConcepts, directConceptsRound, assembleSignals,
// loadAvoidList, findLastRoundIndex, buildPromptRound, ... — nothing there
// is a pure "give me structured copy candidates for an existing artifact"
// read:
//   - directConcepts() / directConceptsRound() are NOT read-only — on a
//     cache miss EITHER calls the paid Director LLM. Calling either from
//     here would risk exactly the "one round per ad" cost blowup DESIGN
//     item 5 forbids, so neither is used by this module.
//   - loadAvoidList(filter, maxRounds) (exported, ~aiCreativeDirectorService
//     .js:2021) IS read-only and queries the right shape:
//     `{...filter, roundIndex:{$ne:null}}`, sorted `{roundIndex:-1}`,
//     `.select('roundIndex concepts').lean()`. But it returns lossy,
//     pre-formatted STRINGS built for the avoid-list prompt block
//     (headline sliced to 60 chars, embedded in
//     "[round N] archetype=... style=... media=[...] copy=\"...\"") —
//     unsuitable for extracting clean headline/subheadline/eyebrow text.
// So resolveVideoHeadlineCandidates() below MIRRORS loadAvoidList's read-
// only query shape (same filter dimensions, same find().sort().limit()
// .select().lean() shape) rather than inventing a different one, and does
// its own clean field extraction using the SAME v3/v2 dual-read pattern
// the rest of that file already uses for copy fields — see
// aiCreativeDirectorService.js ~2035 (`c.copy?.headline ?? c.copy_picks
// ?.headline`) and ~1342 / ~2783 for the same pattern applied elsewhere.
//
// ── COST ──────────────────────────────────────────────────────────────
// Every DB read here is against an artifact that may or may not already
// exist. This module NEVER calls the Director LLM (no chatCompletion, no
// directConcepts/directConceptsRound). A video-only run with no prior
// Director round for this product resolves to an empty candidate list,
// which resolveVideoHeadline turns into `null` — not a template, and not a
// billable call. See layoutInputService.js's fallbackDerivation comment
// for the full null-path story.
//
// ── PLATFORM-FORMAT SCOPE DECISION (report this if asked) ──────────────
// CreativeDirectionArtifact's real cache key is 6-dimensional: brandId,
// productId, campaignKind, creativeIntent, platformFormat, roundIndex
// (models/CreativeDirectionArtifact.js ~130). This module's lookup filters
// on brandId/productId/campaignKind/creativeIntent + roundIndex != null,
// but deliberately does NOT filter on platformFormat. Reason: nothing
// reaches layoutInputService.js's fallbackDerivation with a platformFormat
// today — every buildLayoutInput() caller (services/renderService.js,
// services/atlasVideoService.js, services/capabilityExecutors/
// aiCanvasTestSpec.js, routes/layout.js, routes/aiCanvasSpec.js) passes
// `aspectRatio` (e.g. '16:9') but never `options.platformFormat`, and
// fallbackDerivation is out of layoutInputService's owned lane beyond that
// call boundary — this module cannot invent a platformFormat value it was
// never given without guessing. Director copy.* is on-brand/on-product
// prose, not aspect-ratio-specific, so a round written for one
// platformFormat is still a reasonable, non-templated candidate for a
// video rendering under a different one; the character-BUDGET check (which
// IS format-aware, via `format`/aspectRatio) is what actually protects
// against overflow, not an exact platformFormat match. This is a scope
// decision, not an oversight — flagged for the orchestrator in case a
// tighter match is wanted later (it would require threading platformFormat
// through options at every buildLayoutInput() call site, all of which are
// outside this lane).

'use strict';

const CreativeDirectionArtifact = require('../models/CreativeDirectionArtifact');

// ────────────────────────────────────────────────────────────────────────
//  Per-format character budget
// ────────────────────────────────────────────────────────────────────────
//
// LANDSCAPE is EMPIRICALLY anchored on the defect this module fixes: a
// delivered 1920x1080 video where CSS webkit-line-clamp (2 lines —
// remotion/presets/canonical.json byFormat.landscape headline treatment.
// maxLines:2) rendered exactly 35 characters of
// "Meet Short Sleeve Strato Breathe Te" before cutting mid-word. That is
// the OBSERVED amount of text this exact box/font pairing holds across 2
// lines for a real title-case headline. LANDSCAPE_HEADLINE_BUDGET_CHARS is
// set to 32 — a few characters BELOW that observed ceiling as a safety
// margin, because a headline with wider average letterforms (more capital
// M/W, fewer spaces) than the observed sample could fit noticeably less.
// Being slightly too conservative costs a shorter/plainer pick; being too
// generous reproduces the exact defect this module exists to kill.
//
// IMPORTANT — this is NOT a pixel-measured value. No canvas / text-metrics
// library was used to measure real glyph widths; it is a safety margin
// applied to ONE real observed data point (the delivered clip above).
//
// VERTICAL is an ESTIMATE, extrapolated from that same landscape data
// point — it has not been independently verified against a delivered
// vertical clip. Method: the landscape sample implies an average
// character width of ~0.70em at 72px font
// (2 lines x 883px box / 35 chars / 72px = 0.70). Applying that same
// ~0.70em/char to vertical's own box/font/line-count —
// maxWidthPct 0.9 of a 1080px-wide canvas, up to 68px base x 1.2
// sizeScale = 81.6px font (remotion/components/slotRenderers.jsx
// BASE_SIZE.headline.vertical=68; canonical.json's 'hook'-phase vertical
// headline treatment, the tighter of vertical's two headline entries),
// 3 lines (maxLines:3) — gives (3 x 972px) / (0.70 x 81.6px) ~= 51 chars.
// The same proportional safety margin used for landscape (32/35 ~= 0.91)
// brings that to 46. Treat 46 as a reasoned estimate that should be
// validated against a real delivered vertical clip, not a measurement.
const LANDSCAPE_HEADLINE_BUDGET_CHARS = 32; // empirically grounded (see above)
const VERTICAL_HEADLINE_BUDGET_CHARS  = 46; // estimate, extrapolated (see above)

const HEADLINE_CHAR_BUDGET = Object.freeze({
  landscape: LANDSCAPE_HEADLINE_BUDGET_CHARS,
  vertical:  VERTICAL_HEADLINE_BUDGET_CHARS,
  // feed / square: remotion/presets/canonical.json defines NO `headline`
  // slot for either format (verified — byFormat.feed.slots and
  // byFormat.square.slots both lack any entry with key:'headline'; only
  // 'vertical' and 'landscape' have one). A headline candidate selected
  // for a feed/square ad is therefore inert today: nothing binds meta
  // .headline to a rendered slot in that composition. Budgeted anyway,
  // defensively, at the TIGHTER of the two known real budgets, so this
  // module fails safe rather than over-permitting if a headline slot is
  // ever added to feed/square later without this file being revisited.
  feed:      LANDSCAPE_HEADLINE_BUDGET_CHARS,
  square:    LANDSCAPE_HEADLINE_BUDGET_CHARS,
});

function budgetForFormat(format) {
  const budget = HEADLINE_CHAR_BUDGET[format];
  return Number.isFinite(budget) && budget > 0 ? budget : LANDSCAPE_HEADLINE_BUDGET_CHARS;
}

// Maps an aspectRatio string to the Remotion composition "format" key
// (vertical | square | landscape | feed), for the aspectRatio-only case.
//
// Mirrors, deliberately, the SAME precedence
// services/brandScriptExecutor.js's classifyFormat/isVerticalFormat/
// isSquareFormat/isLandscapeFormat use to pick the actual Remotion
// composition (vertical > square > landscape > feed-default; see that
// file ~50-94) — the comment on TARGET_BY_FORMAT in
// services/basePlateCropService.js explicitly warns against deriving a
// format target any other way, since disagreeing with classifyFormat
// points titling at the wrong composition.
//
// classifyFormat also consults ad.platformFormat; that value is not
// available at layoutInputService's fallbackDerivation call site (see the
// "PLATFORM-FORMAT SCOPE DECISION" note above this file's requires), so
// this function only implements the aspectRatio half of that OR-check.
// In practice this rarely disagrees with classifyFormat: every write path
// that sets Ad.aspectRatio derives it FROM platformFormat via
// aspectRatioForPlatformFormat() (services/platformFormats.js), so the two
// stay in sync.
function classifyHeadlineFormat(aspectRatio) {
  const ar = String(aspectRatio || '').trim();
  if (ar === '9:16') return 'vertical';
  if (ar === '1:1')  return 'square';
  if (ar === '16:9') return 'landscape';
  return 'feed';
}

// ────────────────────────────────────────────────────────────────────────
//  Pure selection
// ────────────────────────────────────────────────────────────────────────
//
// Picks the first candidate (in the given order) that fits `budgetChars`
// (or the format's default budget). NEVER truncates, NEVER fabricates —
// a candidate either fits verbatim or it is skipped. Returns null when
// candidates is empty/absent or nothing fits.
//
// Ordering is the caller's responsibility (see candidatesFromConcepts):
// this function is deliberately dumb about WHY one candidate should beat
// another — it only knows how to find the first one that fits — so the
// ranking policy ("prefer copy.headline, then shorter alternates" — owner
// directive 2) lives in exactly one place and is independently testable.
function selectVideoHeadline({ candidates, format, budgetChars } = {}) {
  const budget = Number.isFinite(budgetChars) && budgetChars > 0
    ? budgetChars
    : budgetForFormat(format);
  if (!Array.isArray(candidates)) return null;
  for (const raw of candidates) {
    if (typeof raw !== 'string') continue;
    // Collapse whitespace the same way slotContent.truncateWordSafe does
    // (remotion/lib/slotContent.js) so a candidate that only LOOKS too
    // long because of doubled spaces isn't rejected for nothing.
    const text = raw.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    // `.length` counts UTF-16 code units, not grapheme clusters — the
    // same approximation remotion/lib/slotContent.js's TEXT_CHAR_CAP /
    // truncateWordSafe already uses for the render-time cap. Consistent
    // with the destination renderer's own notion of "length", not a new
    // gap introduced here.
    if (text.length <= budget) return text;
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────
//  Candidate extraction — pure, offline-testable (inject a fake `concepts`
//  array; no DB involved)
// ────────────────────────────────────────────────────────────────────────
//
// Builds the ordered candidate list from one round's `concepts` array.
// Field-TIER priority: every concept's copy.headline before ANY concept's
// copy.subheadline, before ANY concept's copy.eyebrow — "prefer
// copy.headline, then shorter alternates" (owner directive 2). Within a
// tier, concepts keep the order the Director wrote them in (round array
// order) — deterministic, no re-sorting.
//
// Never throws: null/non-array input, non-object entries, and missing/
// null copy fields all just contribute nothing.
/**
 * The funnel stage a concept declares, or null. PMax rounds are REQUIRED to
 * spread awareness / consideration / conversion across their three concepts —
 * the Director prompt says so in as many words: "the three stages must each
 * appear exactly once so Google has distinct approaches to test — not cosmetic
 * variations of one ad."
 *
 * Dual-read v3 `routing.funnel_stage` / a flat `funnel_stage`, the same shape
 * tolerance candidatesFromConcepts already applies to copy vs copy_picks.
 */
function conceptFunnelStage(c) {
  const r = c && typeof c === 'object' ? c : {};
  const routed = r.routing && typeof r.routing === 'object' ? r.routing.funnel_stage : null;
  const flat = typeof r.funnel_stage === 'string' ? r.funnel_stage : null;
  const stage = typeof routed === 'string' ? routed : flat;
  return typeof stage === 'string' && stage.trim() ? stage.trim().toLowerCase() : null;
}

/**
 * @param {Array} concepts
 * @param {string|null} funnelStage  when set, THIS stage's concept supplies the
 *   candidates first; every other concept follows as fallback.
 *
 * WHY THE STAGE ARGUMENT EXISTS (owner, 2026-08-12). This flattened every
 * concept's copy into one pool and ignored funnel_stage entirely. Downstream,
 * selectVideoHeadline picks the best FITTING candidate from that pool — which
 * is deterministically the same string for all three PMax funnel variants. So
 * awareness, consideration and conversion shipped identical headlines, differing
 * only in preset styling: exactly the "cosmetic variations of one ad" the
 * Director is instructed to avoid. The distinct copy was always there; nothing
 * asked for it by stage.
 *
 * Ordering, not filtering: a stage whose concept carried no usable copy still
 * falls back to the rest of the round rather than going empty. A thinner but
 * present headline beats no headline, and the caller's contract is "null means
 * no Director copy", never a template.
 */
function candidatesFromConcepts(concepts, funnelStage = null) {
  if (!Array.isArray(concepts)) return [];
  const want = typeof funnelStage === 'string' && funnelStage.trim()
    ? funnelStage.trim().toLowerCase()
    : null;
  if (want) {
    const matching = concepts.filter(c => conceptFunnelStage(c) === want);
    if (matching.length) {
      const others = concepts.filter(c => conceptFunnelStage(c) !== want);
      return [
        ...candidatesFromConcepts(matching, null),
        ...candidatesFromConcepts(others, null)
      ];
    }
  }
  const headlines = [];
  const subheadlines = [];
  const eyebrows = [];
  for (const c of concepts) {
    if (!c || typeof c !== 'object') continue;
    // Dual-read v3 `copy` / legacy v2 `copy_picks` — the same fallback
    // aiCreativeDirectorService.js applies to this exact field elsewhere
    // (e.g. ~2035 loadAvoidList, ~1342 validateConceptsRound, ~2783).
    const copy = (c.copy && typeof c.copy === 'object' ? c.copy : null)
      || (c.copy_picks && typeof c.copy_picks === 'object' ? c.copy_picks : null)
      || {};
    pushIfNonEmptyString(headlines,    copy.headline);
    pushIfNonEmptyString(subheadlines, copy.subheadline);
    pushIfNonEmptyString(eyebrows,     copy.eyebrow);
  }
  return [...headlines, ...subheadlines, ...eyebrows];
}

function pushIfNonEmptyString(arr, v) {
  if (typeof v === 'string' && v.trim()) arr.push(v);
}

// ────────────────────────────────────────────────────────────────────────
//  Resolver — READ-ONLY. Never calls the Director LLM.
// ────────────────────────────────────────────────────────────────────────

// Recent rounds to look through for usable copy. Most cache keys will
// only ever have round 0; this bounds the (rare) case where the newest
// round's concepts carried no renderable copy at all. Small on purpose —
// this is a per-render DB read, not a batch job.
const MAX_ROUNDS_TO_SCAN = 3;

// Default DB read — the real Mongo query, mirroring loadAvoidList's shape
// (see file-level comment). Exposed as a parameter (`fetchRounds`) so
// scripts/verifyVideoHeadline.js can inject fake round data and exercise
// the REAL resolveVideoHeadlineCandidates/resolveVideoHeadline functions
// with zero DB/network — not a reimplementation-under-test, the actual
// production code path with the I/O boundary swapped out.
async function defaultFetchRounds(filter, limit) {
  return CreativeDirectionArtifact
    .find(filter)
    .sort({ roundIndex: -1 })
    .limit(limit)
    .select('roundIndex concepts')
    .lean();
}

// Best-effort lookup of an EXISTING CreativeDirectionArtifact round for
// this (brand, product, campaignKind, creativeIntent) and extraction of
// its copy candidates, most-recent-usable-round first. Returns [] (never
// throws) when brandId is missing, the DB read fails, no round exists, or
// every round's concepts carried no usable copy.
async function resolveVideoHeadlineCandidates({
  brandId,
  productId      = null,
  campaignKind   = null,
  creativeIntent = null,
  funnelStage    = null,
  fetchRounds    = defaultFetchRounds
} = {}) {
  if (!brandId) return [];

  // Filter shape mirrors the Director's own cache-key dimensions
  // (aiCreativeDirectorService.js directConcepts/directConceptsRound,
  // models/CreativeDirectionArtifact.js's unique index) MINUS
  // platformFormat — see the "PLATFORM-FORMAT SCOPE DECISION" note at the
  // top of this file — and PLUS `roundIndex: { $ne: null }` to scope to
  // round-based (V2, real copy) artifacts only. The V1 "shadow" artifact
  // (roundIndex: null, written by campaignAdsGenerationService's
  // runCreativeDirectorShadow for every campaign including video-only
  // ones) is deliberately excluded — its concept schema
  // (aiCreativeDirectorService.buildResponseSchema) has no `copy` field
  // at all, so it could never contribute a headline candidate anyway.
  const filter = {
    brandId,
    productId:      productId      || null,
    campaignKind:   campaignKind   || null,
    creativeIntent: creativeIntent || null,
    roundIndex:     { $ne: null }
  };

  let rows;
  try {
    rows = await fetchRounds(filter, MAX_ROUNDS_TO_SCAN);
  } catch (err) {
    // Read-only best-effort lookup — a DB hiccup here must never break
    // headline resolution. Caller falls through to null (never a
    // template); metaCascadeConfig's own headline cascade separately
    // falls through to Brand.tagline before the slot goes empty.
    console.warn(`videoHeadlineService: CreativeDirectionArtifact lookup failed (${err.message})`);
    return [];
  }
  if (!Array.isArray(rows) || !rows.length) return [];

  for (const row of rows) {
    const candidates = candidatesFromConcepts(row && row.concepts, funnelStage);
    if (candidates.length) return candidates;
  }
  return [];
}

// Convenience: resolve candidates + select the best-fitting one, in one
// call. This is what layoutInputService.fallbackDerivation calls. Never
// throws — any failure anywhere in the chain resolves to null, which is
// the correct "no Director copy available" outcome, never a template.
async function resolveVideoHeadline({
  brandId,
  productId      = null,
  campaignKind   = null,
  creativeIntent = null,
  aspectRatio    = null,
  funnelStage    = null,
  fetchRounds    = defaultFetchRounds
} = {}) {
  try {
    const format = classifyHeadlineFormat(aspectRatio);
    const candidates = await resolveVideoHeadlineCandidates({
      brandId, productId, campaignKind, creativeIntent, funnelStage, fetchRounds
    });
    return selectVideoHeadline({ candidates, format });
  } catch (err) {
    console.warn(`videoHeadlineService.resolveVideoHeadline failed (${err.message}) — no headline (never a template)`);
    return null;
  }
}

module.exports = {
  // Pure — offline-testable, no DB
  selectVideoHeadline,
  candidatesFromConcepts,
  conceptFunnelStage,
  classifyHeadlineFormat,
  budgetForFormat,
  HEADLINE_CHAR_BUDGET,
  // Resolver — DB-backed by default, `fetchRounds` injectable for tests
  resolveVideoHeadlineCandidates,
  resolveVideoHeadline,
};
