// Google Ads platform adapter for the creative-matcher cascade.
//
// Different from Meta in two ways:
//   1. Creative content is fetched as part of the campaign sync's
//      ad_group_ad GAQL query (one round-trip) rather than per-ad.
//      So this module doesn't HTTP — it only consumes the in-memory
//      `ad.creative` already populated by the adapter and runs the
//      cascade.
//   2. No Meta-style l.facebook.com unwrapper; ad.final_urls[0] is
//      already the destination URL (Google substitutes {lpurl} at
//      click-time, not in the API response).
//
// extractCreativeContent — pulls headlines/descriptions/final_urls
// from the Google ad-type-specific shape:
//   responsive_search_ad   — headlines[].text + descriptions[].text
//   responsive_display_ad  — headlines[].text + descriptions[].text
//   expanded_text_ad       — headline_part1/2/3 + description, description2
//   image_ad               — image_url
//   final_urls             — universal across ad types
//
// Performance Max asset_groups carry no per-ad creative in this query;
// they get covered by the campaign-level productSetId path which the
// core deriveCampaignKind treats as 'product'.

const CatalogProduct = require('../models/CatalogProduct');
const core = require('./creativeMatcherCore');

// ── Public entry ─────────────────────────────────────────────────────

async function matchCampaignCreatives({ brandId, campaign }) {
  if (!brandId || !campaign) return [];

  const products = await CatalogProduct
    .find({ brandId, draft: { $ne: true } })
    .select('title description productUrl externalId imageUrl category')
    .lean();
  if (products.length === 0) return [];

  const indices = core.buildIndices(products);
  // Google final_urls are already the destination — passthrough unwrap.
  const matchIndices = { ...indices };

  const aggregated = new Set();

  for (const set of (campaign.adSets || [])) {
    for (const ad of (set.ads || [])) {
      if (!ad.creative) {
        ad.matchedProductIds = [];
        ad.matchMethod       = null;
        continue;
      }

      const match = core.matchOne(ad.creative, matchIndices);
      if (match) {
        ad.matchedProductIds = match.productIds;
        ad.matchMethod       = match.method;
        for (const id of match.productIds) aggregated.add(String(id));
      } else {
        ad.matchedProductIds = [];
        ad.matchMethod       = null;
      }
    }
  }

  return Array.from(aggregated);
}

// ── Creative content extraction (called from the campaign sync) ──────

function extractCreativeContent(adRow) {
  const ad = adRow?.adGroupAd?.ad || {};
  const finalUrls = Array.isArray(ad.finalUrls) ? ad.finalUrls : [];

  const titleParts = [];
  const bodyParts  = [];
  let imageUrl     = null;

  // Responsive Search Ad (most common today)
  if (ad.responsiveSearchAd) {
    for (const h of (ad.responsiveSearchAd.headlines    || [])) if (h?.text) titleParts.push(h.text);
    for (const d of (ad.responsiveSearchAd.descriptions || [])) if (d?.text) bodyParts.push(d.text);
  }
  // Responsive Display Ad
  if (ad.responsiveDisplayAd) {
    for (const h of (ad.responsiveDisplayAd.headlines    || [])) if (h?.text) titleParts.push(h.text);
    for (const d of (ad.responsiveDisplayAd.descriptions || [])) if (d?.text) bodyParts.push(d.text);
  }
  // Expanded Text Ad (deprecated 2022 but still served on legacy accounts)
  if (ad.expandedTextAd) {
    for (const k of ['headlinePart1','headlinePart2','headlinePart3']) {
      if (ad.expandedTextAd[k]) titleParts.push(ad.expandedTextAd[k]);
    }
    if (ad.expandedTextAd.description)  bodyParts.push(ad.expandedTextAd.description);
    if (ad.expandedTextAd.description2) bodyParts.push(ad.expandedTextAd.description2);
  }
  // Image / Display creative
  if (ad.imageAd?.imageUrl) imageUrl = ad.imageAd.imageUrl;

  const title = titleParts.length ? titleParts.join(' · ') : (ad.name || null);
  const body  = bodyParts.length  ? bodyParts.join(' ')    : null;

  return {
    title,
    body,
    linkUrl:      finalUrls[0] || null,
    imageUrl,
    thumbnailUrl: imageUrl,
    callToAction: null
  };
}

function creativeFields(extracted) {
  return {
    imageUrl:     extracted.imageUrl     || null,
    thumbnailUrl: extracted.thumbnailUrl || null,
    linkUrl:      extracted.linkUrl      || null,
    title:        extracted.title        || null,
    body:         extracted.body         || null,
    callToAction: extracted.callToAction || null
  };
}

module.exports = {
  matchCampaignCreatives,
  extractCreativeContent,
  creativeFields
};
