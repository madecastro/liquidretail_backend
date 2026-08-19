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
//
// SSRF (added 2026-08-19, coordinator review of PR #221) — a candidate can
// come from SCRAPED `CatalogProduct.productUrl` data, i.e. content this
// app does not control, and websiteUrl is then `axios.get`-ed verbatim,
// repeatedly, by three different services. So beyond the CDN/backend
// denylist above, `safeWebsiteOrigin()` also rejects: any non-http(s)
// scheme (`file:`, `javascript:`, `data:`, `gopher:`, `ftp:`, protocol-
// relative `//host/...`); loopback (127.0.0.0/8, `::1`); RFC1918 private
// ranges (10/8, 172.16/12, 192.168/16); link-local (169.254.0.0/16 — this
// is also where cloud-metadata endpoints like 169.254.169.254 live,
// `fe80::/10`); IPv6 unique-local (`fc00::/7`); `0.0.0.0`; and
// `localhost` / `*.internal` / `*.local`. Numeric/hex/octal IPv4
// obfuscation (`2130706433`, `0x7f000001`, `017700000001`, `127.1`) is
// covered for free — Node's URL parser canonicalizes all of those to
// dotted-quad form before this code ever inspects `hostname`, and
// userinfo/fragment host-confusion tricks (`evil.com@169.254.169.254`)
// resolve to the real host the same way. `safeWebsiteOrigin()` rejects
// all of the above; callers must go through it rather than calling
// `new URL().origin` themselves.

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
 * isPrivateOrLoopbackHost(hostname) → boolean
 *
 * hostname is `url.hostname` — for an IPv6 literal that is the BRACKETED
 * form (`"[::1]"`), which this strips before matching. Handles IPv4
 * loopback/private/link-local ranges, IPv6 loopback/link-local/unique-
 * local, IPv4-mapped IPv6 (`::ffff:127.0.0.1`), and the `localhost` /
 * `.internal` / `.local` hostname conventions. A plain public DNS name
 * (even one that happens to start with digits) never matches the IP
 * regexes below and returns false.
 */
function isPrivateOrLoopbackHost(hostname) {
  let h = String(hostname || '').toLowerCase();
  if (!h) return true; // fail closed — no host to safely fetch at all

  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.internal') || h.endsWith('.local')) return true;

  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);

  if (h.includes(':')) {
    // IPv6 literal. Strip a zone id (%eth0) defensively before matching.
    const addr = h.split('%')[0];
    if (addr === '::1' || addr === '::') return true;
    // IPv4-mapped IPv6 — Node's URL parser CANONICALIZES the embedded
    // IPv4 part, so "::ffff:127.0.0.1" as typed comes back out as
    // "::ffff:7f00:1" (two hex 16-bit groups, not a dotted quad). Handle
    // both the rare dotted form and the canonical hex-group form.
    const v4MappedDotted = addr.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (v4MappedDotted) return isPrivateOrLoopbackHost(v4MappedDotted[1]);
    const v4MappedHex = addr.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (v4MappedHex) {
      const hi = parseInt(v4MappedHex[1], 16);
      const lo = parseInt(v4MappedHex[2], 16);
      const quad = [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join('.');
      return isPrivateOrLoopbackHost(quad);
    }
    if (/^fe[89ab][0-9a-f]:/.test(addr)) return true; // fe80::/10 link-local
    if (/^f[cd][0-9a-f]{2}:/.test(addr)) return true;  // fc00::/7 unique-local
    return false;
  }

  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false; // a real DNS hostname, not an IP literal
  const octets = m.slice(1, 5).map(Number);
  if (octets.some((o) => o > 255)) return false; // not a valid IPv4 literal
  const [a, b] = octets;
  if (a === 127) return true;                       // 127.0.0.0/8 loopback
  if (a === 10) return true;                         // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
  if (a === 192 && b === 168) return true;            // 192.168.0.0/16
  if (a === 169 && b === 254) return true;            // 169.254.0.0/16 (incl. cloud metadata)
  if (a === 0) return true;                           // 0.0.0.0/8
  return false;
}

/**
 * safeWebsiteOrigin(candidate) → origin string | null
 *
 * Normalizes a raw URL/host string to `https://host` origin form (matching
 * resolveStoreOrigin's convention), rejects a non-http(s) scheme outright,
 * and rejects anything on the CDN/backend denylist or the private/loopback/
 * link-local range above. Returns null for anything unparseable, unsafe,
 * or blocked — callers must treat null as "no safe candidate", never throw.
 */
function safeWebsiteOrigin(candidate) {
  if (!candidate || typeof candidate !== 'string') return null;
  let s = candidate.trim();
  if (!s) return null;

  // Reject an explicit non-http(s) scheme (`file://`, `javascript:`,
  // `data:`, `gopher://`, `ftp://`, ...) OUTRIGHT — nothing in this system
  // ever legitimately produces one for a storefront URL, and letting the
  // https-prepend below run on it either throws (harmless) or, worse,
  // silently reinterprets the scheme token itself as a hostname
  // (`"file:///etc/passwd"` → hostname `"file"`) instead of failing loud.
  // Protocol-relative (`//host/path`) needs NO special case here: prepending
  // `https:` in front of it degrades to `https:////host/path`, which the
  // WHATWG parser still resolves to the real `host` — so it rides the
  // exact same hostname-safety checks below as every other shape. Verified
  // empirically (a private-IP protocol-relative target still returns null;
  // a safe one still resolves) before relying on it rather than assuming it.
  const schemeMatch = s.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//);
  if (schemeMatch && !/^https?$/i.test(schemeMatch[1])) return null;

  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let url;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (hostIsBlocked(url.hostname)) return null;
  if (isPrivateOrLoopbackHost(url.hostname)) return null;
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

module.exports = { backfillBrandWebsiteUrl, safeWebsiteOrigin, isPrivateOrLoopbackHost, BLOCKED_HOST_SUFFIXES };
