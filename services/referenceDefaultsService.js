// Default reference-stack policy for VIDEO and STATIC ad requests.
//
// Owner requirement (2026-08-05): "For video generation I always want to use the
// first, second and third catalog images as downloaded from the website or their
// Shopify feed. These are usually the front, side and back but that may vary.
// Let's set these defaults in ENV so we can change the number and the type of
// images included in default video requests and default image requests."
//
// Two INDEPENDENT policies, because the rails feed different pipelines and have
// always had different defaults (video: 3 references; static: the first image
// alone). One shared knob would force a behaviour change on whichever path was
// not being tuned — and deriving the static count from the video count is a
// known past bug: it produced a 3-image static universe when hero-only was
// intended, because a non-empty mediaIds sets
// universeTopN = max(mediaIds.length, DIRECTOR_UNIVERSE_TOP_N).
//
// ── Scope: exactly two dials, both wired ─────────────────────────────────────
//
//   COUNT     — how many images the default stack uses.
//   SHOT TYPE — an ORDERED PREFERENCE over classification.shotType.
//
// An earlier draft of this module also had a SOURCE dial (catalog /
// catalog_then_ugc / any). It was CUT before shipping because it was dead in
// every wired path: the picker's rows come solely from GET /api/catalog/:id and
// are therefore always catalog-product, and applying it inside
// buildReferenceImages was unsafe (catalogMedias is also where callers place
// deliberately-chosen lifestyle/social media, so narrowing there would discard
// operator intent). A config knob that silently does nothing is worse than no
// knob — it will be trusted later. If cross-source defaults are wanted, that is
// a real feature with its own wiring and its own PR.
//
// ── Why shot type is a PREFERENCE and not a FILTER ──────────────────────────
// Load-bearing, not a style choice. shotType is written by the per-product
// detect pass, and detect is DEFERRED (CATALOG_DETECT_PRECOMPUTE=false), so a
// freshly ingested product has NO shotType on any of its media. A hard filter
// would return an EMPTY stack for exactly the products an operator is most
// likely generating for. Instead: matching media sort to the front in list
// order, everything else keeps its feed position behind them, and nothing is
// ever dropped.
//
// There is NO default shot-type preference and there must not be one. Both
// env vars ship empty, which is a strict no-op — pure catalog feed order, the
// "as downloaded" behaviour the owner asked for. The dial is opt-in.

'use strict';

const { SHOT_TYPE_RANK } = require('./shotTypeRank');

// Video counts are bounded by the same ceiling the video cascade enforces
// (atlasVideoService MAX_REFERENCE_IMAGE_COUNT = 7, a hard per-model API limit).
// Keeping these equal matters: a looser bound here would let us SERVE a count
// that resolveReferenceImageCount then rejects, so the picker would advertise
// e.g. 10 while generation actually used 3.
const MAX_VIDEO_COUNT = 7;
// Static has no model-side limit; bound it only so a typo cannot fan out.
const MAX_IMAGE_COUNT = 12;

const VALID_SHOT_TYPES = Object.keys(SHOT_TYPE_RANK);

function parseCount(raw, fallback, max, label) {
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < 1 || n > max) {
    console.warn(
      `⚠️  referenceDefaults: invalid ${label}='${raw}' (want 1–${max}) — using ${fallback}`
    );
    return fallback;
  }
  return n;
}

// Comma-separated ordered preference list. Unknown tokens are dropped with a
// warning rather than failing the request — a typo must not stop generation, and
// an empty result simply means "pure feed order", the safe default.
function parseShotTypes(raw, label) {
  if (raw == null || String(raw).trim() === '') return [];
  const out = [];
  for (const tok of String(raw).split(',')) {
    const v = tok.trim().toLowerCase();
    if (!v) continue;
    if (!VALID_SHOT_TYPES.includes(v)) {
      console.warn(
        `⚠️  referenceDefaults: unknown shot type '${v}' in ${label} — ignoring ` +
        `(valid: ${VALID_SHOT_TYPES.join(', ')})`
      );
      continue;
    }
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

// VIDEO policy.
//
// NOTE on count: the authoritative video count remains
// atlasVideoService.resolveReferenceImageCount, whose cascade is
// CatalogProduct.videoSettings.referenceImageCount → Brand.videoSettings →
// ATLAS_REFERENCE_IMAGE_COUNT → VIDEO_DEFAULT_REFERENCE_COUNT → 3. This `count`
// is the same floor value, exposed for logging/diagnostics only; the picker
// reads the resolved cascade result (scaffold `defaultReferenceCount`) so a
// per-product override still wins. Two different numbers must never be served
// as "the video count".
function videoReferenceDefaults() {
  return {
    count:     parseCount(process.env.VIDEO_DEFAULT_REFERENCE_COUNT, 3, MAX_VIDEO_COUNT, 'VIDEO_DEFAULT_REFERENCE_COUNT'),
    shotTypes: parseShotTypes(process.env.VIDEO_DEFAULT_REFERENCE_SHOT_TYPES, 'VIDEO_DEFAULT_REFERENCE_SHOT_TYPES')
  };
}

// STATIC / image-ad queue policy.
//
// count defaults to 1 — the catalog's first image alone, which is what the
// picker hardcoded as IMAGE_QUEUE_DEFAULT_COUNT before this module existed.
//
// SCOPE, stated plainly: this governs the Step 2 picker's PRE-PICK, which is
// what drives generation on the wizard path (the picks POST as mediaIds). It
// does NOT change the backend's own empty-mediaIds fallback, which remains the
// shotType-ranked universe trimmed to DIRECTOR_UNIVERSE_TOP_N. An API caller
// that sends no mediaIds is unaffected by this knob.
function imageReferenceDefaults() {
  return {
    count:     parseCount(process.env.IMAGE_DEFAULT_REFERENCE_COUNT, 1, MAX_IMAGE_COUNT, 'IMAGE_DEFAULT_REFERENCE_COUNT'),
    shotTypes: parseShotTypes(process.env.IMAGE_DEFAULT_REFERENCE_SHOT_TYPES, 'IMAGE_DEFAULT_REFERENCE_SHOT_TYPES')
  };
}

// STABLE preference ordering over an already-feed-ordered media array.
//
// Contract, and every part of it matters. The frontend mirrors this exactly
// (Step2Picker.orderByShotTypePreference) — any divergence means the picker pins
// one order while the backend would have assembled another:
//   • Returns the SAME members, never fewer. This is a sort, not a filter.
//   • Empty preference returns the input order untouched (feed order).
//   • Media matching shotTypes[0] come first, then shotTypes[1], and so on —
//     LIST order, not the shotTypeRank quality order.
//   • Everything unmatched — including every media with NO shotType, the normal
//     state under deferred detect — keeps its relative feed order, behind the
//     matched ones.
//   • Stable within each bucket, so feed order is the tiebreak everywhere.
//
// Deliberately NOT reusing shotTypeRank.rankByShotType: that imposes a fixed
// quality order with its own hero/recency tiebreaks. This is operator-configured
// preference over feed order — a different question, and its tiebreak must stay
// feed position so an unconfigured policy is a true no-op.
function orderByShotTypePreference(medias, shotTypes) {
  if (!Array.isArray(medias) || medias.length < 2) return Array.isArray(medias) ? medias.slice() : [];
  // Normalise FIRST so the comparator can never see a non-array. The early
  // return below is then only a fast path — removing it stays
  // behaviour-preserving, because an all-equal bucket set already sorts to feed
  // order on its own.
  const prefs = Array.isArray(shotTypes) ? shotTypes : [];
  if (!prefs.length) return medias.slice();

  const bucketOf = (m) => {
    const st = m?.classification?.shotType;
    if (!st) return prefs.length;                   // unclassified → behind all matches
    const i = prefs.indexOf(String(st).toLowerCase());
    return i === -1 ? prefs.length : i;
  };

  // decorate → sort → undecorate, so feed index is the guaranteed tiebreak
  // (Array#sort stability is spec'd, but being explicit documents the intent).
  return medias
    .map((m, i) => ({ m, i, b: bucketOf(m) }))
    .sort((a, b) => (a.b !== b.b ? a.b - b.b : a.i - b.i))
    .map(x => x.m);
}

module.exports = {
  videoReferenceDefaults,
  imageReferenceDefaults,
  orderByShotTypePreference,
  MAX_VIDEO_COUNT,
  MAX_IMAGE_COUNT,
  VALID_SHOT_TYPES
};
