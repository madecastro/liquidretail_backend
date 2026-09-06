// Shared shot-type ranking used across the seed / reference pipelines.
//
// Ranks Media docs by classification.shotType — a scene-first,
// product-last order that reflects animation and composition quality
// for downstream Grok video / image generation.
//
// Callers: seededUniverseService (director seed universe), and
// campaignAdsGenerationService.rankCatalogMediasForHero (legacy
// hero picker). Do NOT copy this table anywhere else — import from here.
//
// Historical note: earlier versions ranked `unknown` above `product_only`.
// That tied "classifier failed" ahead of "confidently-classified plain
// product shot," which is not what we want — a confidently-classified
// product_only is a stronger signal than unclassified media.
const SHOT_TYPE_RANK = {
  lifestyle:    1,
  on_model:     2,
  flat_lay:     3,
  product_only: 4,
  detail:       5,
  packaging:    6,
  unknown:      7
};

// APPAREL-SAFE variant. Inverts the top of the ladder so flat_lay and
// product_only outrank on_model and lifestyle. Same shape as the default
// so the sort code doesn't branch — callers pick which map to hand to
// rankByShotType via the `apparelSafe` option below.
//
// WHY. OpenAI gpt-image-2/edit's safety classifier false-positives on
// on-model swimwear/apparel photography (measured 2026-08-25 on
// run_1787684512013_e5feaf12 — 4 of 9 statics flagged
// safety_violations=[sexual] on Pelagic swimwear catalog images). Ranking
// flat_lay / product_only first for APPAREL products only means the seed
// carries less moderation risk in the exact cases where the filter trips.
// Non-apparel products stay on the default ladder unchanged. See
// services/apparelCategory.js for the isApparelCategory / env-flag pair.
const APPAREL_SHOT_TYPE_RANK = {
  flat_lay:     1,
  product_only: 2,
  on_model:     3,
  lifestyle:    4,
  detail:       5,
  packaging:    6,
  unknown:      7
};

function rankOf(media, rankMap = SHOT_TYPE_RANK) {
  return rankMap[media?.classification?.shotType] ?? rankMap.unknown;
}

// Sort a Media array by shot-type quality (best first). Ties within a
// shot-type tier resolve on:
//   1. metadata.imageRole === 'hero' (merchant's primary listing wins)
//   2. createdAt desc (recency)
// Both tiebreaks are deterministic and cheap — no adSuitability lookups.
//
// `apparelSafe:true` swaps in APPAREL_SHOT_TYPE_RANK — see the header on
// that constant for the rationale. Default false = unchanged behaviour for
// every existing caller.
function rankByShotType(medias, { apparelSafe = false } = {}) {
  if (!Array.isArray(medias) || !medias.length) return [];
  const rankMap = apparelSafe ? APPAREL_SHOT_TYPE_RANK : SHOT_TYPE_RANK;
  return medias.slice().sort((a, b) => {
    const ra = rankOf(a, rankMap);
    const rb = rankOf(b, rankMap);
    if (ra !== rb) return ra - rb;

    const ahero = a?.metadata?.imageRole === 'hero' ? 0 : 1;
    const bhero = b?.metadata?.imageRole === 'hero' ? 0 : 1;
    if (ahero !== bhero) return ahero - bhero;

    const at = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bt = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
    return bt - at;
  });
}

module.exports = {
  SHOT_TYPE_RANK,
  APPAREL_SHOT_TYPE_RANK,
  rankOf,
  rankByShotType
};
