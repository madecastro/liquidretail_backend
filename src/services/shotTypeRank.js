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

function rankOf(media) {
  return SHOT_TYPE_RANK[media?.classification?.shotType] ?? SHOT_TYPE_RANK.unknown;
}

// Sort a Media array by shot-type quality (best first). Ties within a
// shot-type tier resolve on:
//   1. metadata.imageRole === 'hero' (merchant's primary listing wins)
//   2. createdAt desc (recency)
// Both tiebreaks are deterministic and cheap — no adSuitability lookups.
function rankByShotType(medias) {
  if (!Array.isArray(medias) || !medias.length) return [];
  return medias.slice().sort((a, b) => {
    const ra = rankOf(a);
    const rb = rankOf(b);
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
  rankOf,
  rankByShotType
};
