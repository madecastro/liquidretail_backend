'use strict';
//
// services/catalogImageLimits.js — SINGLE place the per-product ADDITIONAL
// images cap is resolved from env.
//
// WHY: five catalog ingest writers (generic JSON-LD resolver, generic
// upsert, Shopify public, Meta catalog sync, Apify Shopify ingest) used
// to disagree on how many alt images to keep (4 vs 8). Raising them all
// to the same number via one shared constant means a chatty feed never
// stores more alts than catalogProductDetectService will materialize
// (MAX_ALT_IMAGES = 12 there). This module has ZERO requires so Meta
// sync (and any other non-scrape consumer) can import the integer without
// dragging the scraping stack into its module graph — and so the Shopify
// / Apify ingest paths can require it at top level without a circular load.
//
// MUST stay in numeric lockstep with
// catalogProductDetectService.MAX_ALT_IMAGES (also 20).
//
// RAISED 12 -> 20 (owner, 2026-08-11). Measured: marinelayer.com products carry
// up to 15 images, so 12 truncated 3 per product on the richest SKUs. Env-overridable via
// CATALOG_MAX_ADDITIONAL_IMAGES; clamp never allows 0/negative
// (Math.max(1, …)). Hero / imageUrl is SEPARATE — total images per
// product = 1 + this.

const MAX_ADDITIONAL_IMAGES = Math.max(
  1,
  parseInt(process.env.CATALOG_MAX_ADDITIONAL_IMAGES, 10) || 20
);

module.exports = {
  MAX_ADDITIONAL_IMAGES
};
