// services/brandWebsiteBackfill.js
//
// Shared back-fill for the "brand has a catalog but no websiteUrl" hole.
//
// Root cause (2026-08-18): every catalog-ingest path that pulls a brand's
// products from its own storefront (shopify-direct, generic-sitemap /
// sitemap-jsonld, the legacy apify-shopify actor) resolves an ORIGIN to
// scrape from (usually Brand.apifyDemo.shopifyUrl) but never copies that
// origin onto Brand.websiteUrl. Every downstream enrichment tier — GPT
// tagline/summary/tone, website logo discovery, website font ingest — is
// gated on websiteUrl, so a brand with a fully-synced catalog (Marine
// Layer: 2400+ products, GymShark: 207) can sit forever with a completely
// empty brand identity and NO error recorded anywhere. Confirmed victims:
// see scripts/backfillBrandWebsiteUrl.js.
//
// This module is the ONE place that decides "is this URL safe to promote
// to Brand.websiteUrl", used by both the live ingest hooks (this file's
// callers in shopifyPublicIngestService / genericCatalogIngestService /
// apifyIngestService) and the one-time historical backfill script — so a
// future ingest path gets the same host-safety guarantees for free instead
// of a re-implemented cascade (same rule CLAUDE.md states for
// resolveDeriveFromMaster / resolveStoreOrigin).
//
// SAFETY — do not promote a non-storefront host to websiteUrl. websiteUrl
// feeds three scrapers directly (brandEnrichmentService's GPT homepage
// fetch, brandLogoIngestService, brandFontIngestService all `axios.get`
// it verbatim) and Brandfetch lookups. Two concrete hosts have already
// been observed where a naive "take the origin of any known URL" rule
// would have picked the WRONG host:
//   - `*.myshopify.com` — the EFFECTIVE backend origin
//     (shopifyPublicIngestService.js `access.origin`) that headless-store
//     discovery substitutes for the real custom domain when minting
//     CatalogProduct.productUrl. GymShark's own products carry
//     `https://gymsharkusa.myshopify.com/products/...` even though the
//     brand's real site is `https://www.gymshark.com` — its own
//     `apifyDemo.shopifyUrl` already holds the correct value.
//   - CDN / thumbnail hosts (`cdn.shopify.com`, `*.gstatic.com`,
//     `*.cloudinary.com`) — never a marketing site, but exactly the kind
//     of string that ends up in an image field a careless caller might
//     reach for instead of productUrl.
// `safeWebsiteOrigin()` rejects all of the above; callers must go through
// it rather than calling `new URL().origin` themselves.

'use strict';

const Brand = require('../models/Brand');

// Suffix-matched — `foo.myshopify.com`, `cdn.shopify.com`,
// `encrypted-tbn0.gstatic.com`, `res.cloudinary.com` all match their entry.
const BLOCKED_HOST_SUFFIXES = [
  'myshopify.com',
  'cdn.shopify.com',
  'gstatic.com',
  'cloudinary.com',
  'googleusercontent.com'
];

function hostIsBlocked(hostname) {
  const h = String(hostname || '').toLowerCase();
  return BLOCKED_HOST_SUFFIXES.some(suffix => h === suffix || h.endsWith(`.${suffix}`));
}

/**
 * safeWebsiteOrigin(candidate) → origin string | null
 *
 * Normalizes a raw URL/host string to `https://host` origin form (matching
 * resolveStoreOrigin's convention) and rejects anything on the CDN/backend
 * denylist above. Returns null for anything unparseable or blocked —
 * callers must treat null as "no safe candidate", never throw.
 */
function safeWebsiteOrigin(candidate) {
  if (!candidate || typeof candidate !== 'string') return null;
  let s = candidate.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let url;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (hostIsBlocked(url.hostname)) return null;
  return url.origin;
}

/**
 * backfillBrandWebsiteUrl(brand, candidateUrl, { ingestSource }) →
 *   Promise<{ updated: boolean, websiteUrl: string|null }>
 *
 * Call this once a catalog-ingest path has PROVEN a domain by successfully
 * resolving/scraping it (i.e. after `products.length > 0`, not merely
 * because a config field holds a string) — see the call sites in
 * shopifyPublicIngestService.syncBrandShopifyDirect,
 * genericCatalogIngestService.syncBrandGenericCatalog, and
 * apifyIngestService.syncBrandShopify.
 *
 * `brand` needs only `_id` (a hydrated doc or a lean projection both
 * work) — the write itself is an atomic conditional findOneAndUpdate, so
 * a caller holding a stale in-memory doc mid-loop cannot race a
 * concurrent write or double-fire enrichment.
 *
 * Guards mirror the existing manual-logo-upload back-fill in
 * brandCatalogService.js:57 — never overwrite an existing websiteUrl,
 * never touch a brand a human has curated (`source === 'curated'` or
 * `'websiteUrl' ∈ curatedFields`).
 *
 * On an actual write, fires `enrichBrandFromUrl` in the background —
 * ingest never awaits it — because today NONE of the three ingest paths
 * trigger brand-level enrichment on their own (only the Apify Instagram
 * branch does, and only when websiteUrl already existed). Without this,
 * the back-fill would set the field and still leave the brand starved.
 */
async function backfillBrandWebsiteUrl(brand, candidateUrl, { ingestSource = 'unknown', triggerEnrichment = true } = {}) {
  if (!brand || !brand._id) return { updated: false, websiteUrl: null };

  const origin = safeWebsiteOrigin(candidateUrl);
  if (!origin) return { updated: false, websiteUrl: null };

  let updated;
  try {
    updated = await Brand.findOneAndUpdate(
      {
        _id: brand._id,
        $and: [
          { $or: [{ websiteUrl: null }, { websiteUrl: '' }, { websiteUrl: { $exists: false } }] },
          { source: { $ne: 'curated' } },
          { curatedFields: { $ne: 'websiteUrl' } }
        ]
      },
      { $set: { websiteUrl: origin } },
      { new: true }
    );
  } catch (err) {
    console.warn(`   ⚠️  websiteUrl back-fill write failed for brand=${brand._id}: ${err.message}`);
    return { updated: false, websiteUrl: null };
  }
  if (!updated) return { updated: false, websiteUrl: null };

  console.log(`🌐 back-filled Brand.websiteUrl for "${updated.name}" from ${ingestSource} ingest → ${origin}`);

  // Fire-and-forget by default — a long-lived ingest process (web/worker)
  // must not block on enrichment, and enrichment itself now records why it
  // declines rather than silently no-op'ing (brandEnrichmentService).
  // `triggerEnrichment: false` is for short-lived one-off scripts (see
  // scripts/backfillBrandWebsiteUrl.js) — a script process can exit before
  // a fire-and-forget promise here ever resolves, so THOSE callers await
  // enrichBrandFromUrl themselves instead of relying on this side effect.
  if (triggerEnrichment) {
    try {
      require('./brandEnrichmentService')
        .enrichBrandFromUrl(updated._id)
        .catch(err => console.warn(`   ⚠️  post-backfill enrichment enqueue failed for "${updated.name}": ${err.message}`));
    } catch (err) {
      console.warn(`   ⚠️  post-backfill enrichment require failed: ${err.message}`);
    }
  }

  return { updated: true, websiteUrl: origin };
}

module.exports = { backfillBrandWebsiteUrl, safeWebsiteOrigin, BLOCKED_HOST_SUFFIXES };
