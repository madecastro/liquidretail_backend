// Display-URL joins for Ad rows.
//
// Ad.renderUrl is the Puppeteer composite (and for video ads the
// ffmpeg-composited mp4). Image ads get a separate "photoreal" polish
// via gpt-image-1 stored on AiFullRenderArtifact — when the campaign's
// useImageRefAsProduction flag is on, the frontend should display
// photorealUrl instead of renderUrl.
//
// These joins are shared between routes/ads.js (the legacy flat list)
// and routes/catalog.js (the new product-centric expansion endpoint)
// so both produce identical thumbnail rendering.

const AiFullRenderArtifact = require('../models/AiFullRenderArtifact');
const Campaign             = require('../models/Campaign');
const CatalogProduct       = require('../models/CatalogProduct');

// Cache-key string for an Ad row that matches AiFullRenderArtifact's
// unique index. Ad doesn't carry campaignContextHash / creativeStyle
// directly; the 6 available fields are enough to disambiguate within
// typical batches. When multiple rows match, the most recent createdAt
// wins.
function photorealCacheKey(ad) {
  return [
    String(ad.mediaId      || ''),
    String(ad.template     || ''),
    String(ad.aspectRatio  || ''),
    String(ad.productId    || ''),
    String(ad.variantKind  || ''),
    String(ad.paletteSource|| 'media')
  ].join('|');
}

// Returns Map<adId, photorealUrl>. Two-pass lookup:
//   1) FK join via Ad.aiCanvasArtifactId — populated for every render
//      that went through the Phase 6.5.1 eager prime (V2 ai_* with
//      RENDER_USE_HTML on). One indexed query, deterministic.
//   2) Cartesian-heuristic fallback for Ads without the FK (older
//      renders, V1, non-AI templates). Same 6-field $or, scoped to
//      the leftover ad ids.
async function loadPhotorealUrlMap(adRows) {
  const map = new Map();
  if (!adRows.length) return map;

  // Pass 1 — direct FK join.
  const adsByCanvas = new Map();
  for (const ad of adRows) {
    if (!ad.aiCanvasArtifactId) continue;
    const k = String(ad.aiCanvasArtifactId);
    if (!adsByCanvas.has(k)) adsByCanvas.set(k, []);
    adsByCanvas.get(k).push(ad);
  }
  if (adsByCanvas.size) {
    const fkRows = await AiFullRenderArtifact
      .find({ aiCanvasArtifactId: { $in: [...adsByCanvas.keys()] } })
      .sort({ createdAt: -1 })
      .select('aiCanvasArtifactId imageUrl createdAt')
      .lean();
    const fkMap = new Map();
    for (const r of fkRows) {
      const k = String(r.aiCanvasArtifactId);
      if (!fkMap.has(k)) fkMap.set(k, r.imageUrl);
    }
    for (const [canvasKey, ads] of adsByCanvas.entries()) {
      const url = fkMap.get(canvasKey);
      if (url) for (const ad of ads) map.set(String(ad._id), url);
    }
  }

  // Pass 2 — cartesian fallback for Ads without an FK or where the FK
  // didn't resolve (race-condition cold cells).
  const leftover = adRows.filter(ad => !map.has(String(ad._id)));
  if (!leftover.length) return map;
  const keys = new Set();
  for (const ad of leftover) keys.add(photorealCacheKey(ad));
  const orClauses = [...keys].map(k => {
    const [mediaId, template, aspectRatio, productId, variantKind, paletteSource] = k.split('|');
    return {
      mediaId,
      template,
      aspectRatio,
      productId:     productId || null,
      variantKind:   variantKind || null,
      paletteSource: paletteSource || 'media'
    };
  });
  const rows = await AiFullRenderArtifact
    .find({ $or: orClauses })
    .sort({ createdAt: -1 })
    .select('mediaId template aspectRatio productId variantKind paletteSource imageUrl createdAt')
    .lean();
  const heuristicMap = new Map();
  for (const r of rows) {
    const k = [r.mediaId, r.template, r.aspectRatio, r.productId, r.variantKind, r.paletteSource || 'media'].join('|');
    if (!heuristicMap.has(k)) heuristicMap.set(k, r.imageUrl);
  }
  for (const ad of leftover) {
    const url = heuristicMap.get(photorealCacheKey(ad));
    if (url) map.set(String(ad._id), url);
  }
  return map;
}

// Returns Map<campaignId, useImageRefAsProduction:boolean>. Drives the
// frontend's renderUrl → photorealUrl swap.
async function loadUseImageRefMap(adRows) {
  const map = new Map();
  const campaignIds = [...new Set(adRows.map(a => a.campaignId).filter(Boolean).map(String))];
  if (!campaignIds.length) return map;
  const campaigns = await Campaign.find({ _id: { $in: campaignIds } })
    .select('_id useImageRefAsProduction')
    .lean();
  for (const c of campaigns) map.set(String(c._id), !!c.useImageRefAsProduction);
  return map;
}

// Returns Map<productId, productUrl> — the retailer's own product page,
// for the ad detail view's outbound link.
//
// Grouped and queried per the OWNING ad's brandId, never a single global
// $in across all productIds — PR #245 fixed a real cross-brand leak where
// an ad's productId pointed at another brand's CatalogProduct and the UI
// rendered (and could bill against) that other brand's creative. Scoping
// every lookup to (brandId, _id) keeps that class of bug from reopening
// here even if a future caller ever passes rows spanning multiple brands.
async function loadProductUrlMap(adRows) {
  const map = new Map();
  const idsByBrand = new Map();
  for (const ad of adRows) {
    if (!ad.productId || !ad.brandId) continue;
    const brandKey = String(ad.brandId);
    if (!idsByBrand.has(brandKey)) idsByBrand.set(brandKey, new Set());
    idsByBrand.get(brandKey).add(String(ad.productId));
  }
  if (!idsByBrand.size) return map;

  const perBrandRows = await Promise.all(
    [...idsByBrand.entries()].map(([brandId, ids]) =>
      CatalogProduct.find({ _id: { $in: [...ids] }, brandId })
        .select('_id productUrl')
        .lean()
    )
  );
  for (const rows of perBrandRows) {
    for (const p of rows) {
      if (p.productUrl) map.set(String(p._id), p.productUrl);
    }
  }
  return map;
}

module.exports = {
  photorealCacheKey,
  loadPhotorealUrlMap,
  loadUseImageRefMap,
  loadProductUrlMap
};
