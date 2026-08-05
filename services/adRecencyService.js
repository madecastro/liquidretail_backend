// adRecencyService — the Ad's TRUE "last activity" signal, for ranking/display only.
//
// WHY THIS EXISTS
// Ad.generatedAt (models/Ad.js) is stamped ONCE when a row is first created and is
// NEVER updated afterward — not by a fresh render (services/renderService.js
// `persistStage`, which sets status/renderedAt/renderUrl but leaves generatedAt
// untouched) and not by dedupe-reuse (routes/ads.js `claimAdsForRun`, which only
// `$addToSet`s campaignRunIds). So a row created weeks ago and re-rendered today
// still sorts/badges as if nothing happened. renderedAt IS updated on every real
// render (including a re-render of a reused row) and is the correct signal for
// "was this recently active" — it just wasn't being read anywhere.
//
// This is a read-time projection only. generatedAt keeps its existing meaning
// ("row first existed") everywhere; nothing here writes to either field.

// Aggregation-pipeline form — drop into any $group/$addFields stage.
const AD_RECENCY_EXPR = { $ifNull: ['$renderedAt', '$generatedAt'] };

// Plain-JS mirror of the identical semantics, for code holding already-fetched
// Ad-like plain objects. Must stay behaviorally identical to AD_RECENCY_EXPR —
// pinned by scripts/verifyAdsRecency.js.
function resolveAdRecency(adLike) {
  return (adLike && (adLike.renderedAt || adLike.generatedAt)) || null;
}

module.exports = { AD_RECENCY_EXPR, resolveAdRecency };
