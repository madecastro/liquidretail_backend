// services/productReviewsScrapeService.js
//
// Product review + rating engine. ONE entry point, shared by every catalog
// ingest path, so a Shopify-integration brand, a sitemap/JSON-LD brand and
// a Meta-catalog brand all capture reviews the same way.
//
// THREE TIERS, cheapest first, each additive (fetchProductReviews):
//
//   1. ON-PAGE STRUCTURED DATA (here) — the schema.org review data every
//      review app publishes for Google rich snippets, the one output format
//      they all share. One HTTP GET, no per-app knowledge. Free.
//   2. VENDOR PUBLIC API (services/reviewAdapters) — PAGINATED. Rich
//      snippets are a teaser: Judge.me publishes ~2 of 81 reviews,
//      Bazaarvoice ~6 of 156, and a client-rendered widget publishes none.
//      Tier 2 reads the same public endpoint the store's own widget reads,
//      keyed by an identifier sitting in the page HTML. No credentials.
//   3. HEADLESS CAPTURE (services/reviewHeadlessCapture) — PAGINATED. A
//      real browser drives the widget for stores with neither snippets nor
//      a readable API. Expensive, so opt-in (REVIEW_HEADLESS_ENABLED).
//
// Tier 1 always runs; 2 runs when 1 came up short; 3 only when 1+2 found
// nothing. Results merge (aggregates fill gaps, quotes union + dedupe),
// then rank positive-first and truncate to the storage cap.
//
// Captured per product:
//   rating              — aggregate, normalized to a 0–5 scale
//   reviewCount         — the store's own total
//   quotes[]            — { text, title, author, rating, datePublished, source }
//   ratingDistribution  — star histogram of the reviews WE fetched
//   reviewsFetched      — denominator for that histogram (NOT reviewCount)
//   tiers[]             — provenance: ['json-ld','api:judge.me'] …
//   platform            — 'bazaarvoice' | 'judge.me' | … | null
//
// PER-REVIEW STARS ARE THE POINT. The previous extractors kept only
// { text, author } and dropped review.reviewRating.ratingValue, so
// "surface a positive review" degraded to a lexical sentiment guess over
// an unordered sample — a mildly-worded 2-star review could win the
// primary quote slot. With stars captured, selection filters on the
// reviewer's own verdict first (see rankQuotes + MIN_POSITIVE_STARS).
//
// SCHEMA QUIRK, LOAD-BEARING: nested review nodes in the wild often use
// a bare `type` key instead of `@type` (Bazaarvoice-rendered Living
// Spaces PDPs do exactly this — Product carries `@type` while its
// review[] / author / reviewRating children carry `type`). Anything that
// gates on `@type` alone silently captures zero quotes, so every type
// read here goes through nodeTypes().

'use strict';

const http = require('./httpScrapeClient');
const { cleanScrapedText } = require('../utils/htmlEntities');

const LOG = '⭐';

// Quotes kept per product. The cap is a storage bound, not a relevance
// bound — rankQuotes orders BEFORE truncating, so the kept sample is the
// best of what the page had, not the first N in document order.
const MAX_QUOTES = Math.max(
  1,
  parseInt(process.env.PRODUCT_REVIEWS_MAX_QUOTES, 10) || 10
);

// A quote must clear this star rating to be treated as positive. Applies
// only when the page gave us a per-review rating; unrated quotes fall
// through to the text-quality signals.
const MIN_POSITIVE_STARS = 4;

const MAX_QUOTE_CHARS  = 400;
const MAX_TITLE_CHARS  = 140;
const MAX_AUTHOR_CHARS = 120;

// Headless capture (tier 3) is off by default: a real browser per product
// is orders of magnitude more expensive than an HTTP GET. Turn it on for a
// brand whose review app renders client-side, or pass useHeadless per call.
const HEADLESS_DEFAULT = process.env.REVIEW_HEADLESS_ENABLED === 'true';

// Refresh cadence for a brand-wide re-scrape. Matches the 30-day TTL the
// Gemini/SerpAPI enrichment caches use so the two can't fight.
const TTL_DAYS = Math.max(
  1,
  parseInt(process.env.PRODUCT_REVIEWS_TTL_DAYS, 10) || 30
);
const TTL_MS = TTL_DAYS * 24 * 60 * 60 * 1000;

// ── platform detection ─────────────────────────────────────────────
//
// Ordered most-specific first. Bare-word markers ('loox', 'stamped') are
// checked last and anchored to their asset hosts so a product
// description containing the word "stamped" can't win.
const PLATFORM_SIGNATURES = [
  ['bazaarvoice',      /bazaarvoice|data-bv-|bvrrp|\bBVRRR\b/i],
  ['powerreviews',     /powerreviews|pwr-review|\bpr-snippet\b/i],
  ['turnto',           /turnto\.com|turntocdn/i],
  ['judge.me',         /judge\.me|judgeme|jdgm-/i],
  ['yotpo',            /yotpo/i],
  // data-oke-* is what Okendo stores actually emit on the widget host div
  // (data-oke-widget, data-oke-reviews-product-id) — matching only the
  // literal "okendo" missed every store whose theme uses just the attributes.
  ['okendo',           /okendo|data-oke-|oke-star|api\.okendo\.io/i],
  // ruk_* is REVIEWS.io's own widget prefix (from its reviews.co.uk days) and
  // is often the only marker in a theme's markup.
  ['reviews.io',       /reviews\.io|reviewsio|ruk_rating_snippet|ruk-widget|widget\.reviews\.co\.uk/i],
  ['trustpilot',       /trustpilot/i],
  ['junip',            /junip\.co|junip-/i],
  ['fera',             /fera\.ai|fera-/i],
  ['shopify-reviews',  /spr-review|shopify-product-reviews/i],
  ['loox',             /loox\.io|cdn\.loox|loox-/i],
  ['stamped',          /stamped\.io|cdn-stamped|stamped-/i]
];

/**
 * detectReviewPlatform(html) → platform slug | null
 * Provenance label only — nothing downstream branches on it. Useful in
 * logs when a page has a review widget but no structured data (the
 * widget renders client-side), which is the one case this engine can't
 * read without a headless render.
 */
function detectReviewPlatform(html) {
  if (!html || typeof html !== 'string') return null;
  for (const [name, re] of PLATFORM_SIGNATURES) {
    if (re.test(html)) return name;
  }
  return null;
}

// ── JSON-LD plumbing ───────────────────────────────────────────────

// Reads BOTH `@type` and `type` — see the schema-quirk note in the header.
function nodeTypes(node) {
  if (!node || typeof node !== 'object') return [];
  const raw = node['@type'] != null ? node['@type'] : node.type;
  if (raw == null) return [];
  return (Array.isArray(raw) ? raw : [raw]).map(t => String(t));
}

function isType(node, re) {
  return nodeTypes(node).some(t => re.test(t));
}

function flattenLdNodes(blocks) {
  const out = [];
  const walk = (n, depth) => {
    if (n == null || depth > 8) return;
    if (Array.isArray(n)) { for (const item of n) walk(item, depth + 1); return; }
    if (typeof n !== 'object') return;
    out.push(n);
    if (n['@graph']) walk(n['@graph'], depth + 1);
    // mainEntity wrappers (WebPage → Product) are common on enterprise CMSes.
    if (n.mainEntity) walk(n.mainEntity, depth + 1);
    if (n.itemListElement) walk(n.itemListElement, depth + 1);
    if (n.item) walk(n.item, depth + 1);
  };
  walk(blocks, 0);
  return out;
}

function parseLdBlocks(html) {
  const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const blocks = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = (m[1] || '').trim();
    if (!raw) continue;
    try {
      blocks.push(JSON.parse(raw));
    } catch {
      try {
        blocks.push(JSON.parse(raw.replace(/,\s*([}\]])/g, '$1')));
      } catch { /* skip unparseable block */ }
    }
  }
  return blocks;
}

// ── numeric helpers ────────────────────────────────────────────────

function toNumber(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  // "4,9" (EU decimal comma) and "4.9 out of 5" both appear in the wild.
  const s = String(v).trim().replace(',', '.');
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function toCount(v) {
  const n = toNumber(v);
  if (n == null || n < 0) return null;
  return Math.round(n);
}

/**
 * normalizeStars(value, bestRating?) → 0–5 | null
 * Sites publish ratings on 5-, 10- and 100-point scales. Everything is
 * rescaled to 5 so `rating` means one thing everywhere downstream (the
 * ad renderer draws 5 stars; a raw 9.4/10 would render as off-scale).
 */
function normalizeStars(value, bestRating = null) {
  const v = toNumber(value);
  if (v == null || v < 0) return null;
  const best = toNumber(bestRating);
  const scale = best != null && best > 1 ? best : (v > 5 ? (v > 10 ? 100 : 10) : 5);
  const out = (v / scale) * 5;
  if (!Number.isFinite(out)) return null;
  return Math.max(0, Math.min(5, Math.round(out * 100) / 100));
}

// ── review mapping ─────────────────────────────────────────────────

function authorName(author) {
  if (author == null) return null;
  if (typeof author === 'string') return cleanScrapedText(author, MAX_AUTHOR_CHARS);
  if (Array.isArray(author)) return authorName(author[0]);
  if (typeof author === 'object') {
    return cleanScrapedText(author.name || author.alternateName, MAX_AUTHOR_CHARS);
  }
  return null;
}

function publishedAt(raw) {
  if (raw == null) return null;
  const d = new Date(String(raw));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * mapReviewNode(node, source) → quote | null
 * schema.org Review → { text, title, author, rating, datePublished, source }.
 */
function mapReviewNode(node, source = null) {
  if (!node || typeof node !== 'object') return null;

  const text = cleanScrapedText(
    node.reviewBody != null ? node.reviewBody : node.description,
    MAX_QUOTE_CHARS
  );
  if (!text) return null;

  const rr = node.reviewRating || node.rating || null;
  const rating = rr && typeof rr === 'object'
    ? normalizeStars(rr.ratingValue, rr.bestRating)
    : normalizeStars(rr);

  // Review.name is the reviewer's own headline ("Great addition!") —
  // short, punchy, and often a better overlay line than the body.
  const title = cleanScrapedText(node.name || node.headline, MAX_TITLE_CHARS);

  return {
    text,
    title:         title && title !== text ? title : null,
    author:        authorName(node.author),
    rating,
    datePublished: publishedAt(node.datePublished || node.dateCreated),
    source:        source || 'store'
  };
}

/**
 * rankQuotes(quotes) → quotes ordered best-first
 *
 * Ordering, in priority order:
 *   1. star verdict — rated ≥ MIN_POSITIVE_STARS first, rated-negative last
 *   2. substance    — a body in the 60–220 char band beats a one-liner
 *      and beats a wall of text; digits / duration refs add specificity
 *   3. recency      — newer wins ties
 *
 * This is intentionally coarse: it decides which quotes are worth
 * STORING. layoutInputService still runs its own sentiment scorer when
 * it picks the one quote that goes on an ad.
 */
function quoteStrength(q) {
  let score = 0;

  if (q.rating != null) {
    if (q.rating >= MIN_POSITIVE_STARS) score += 40 + (q.rating - MIN_POSITIVE_STARS) * 5;
    else if (q.rating >= 3)             score += 5;
    else                                score -= 60;   // 1–2 stars: never a hero quote
  }

  const len = q.text.length;
  if (len >= 60 && len <= 220)      score += 8;
  else if (len >= 40 && len < 60)   score += 4;
  else if (len < 25 || len > 320)   score -= 6;

  if (/\d/.test(q.text))                                       score += 2;
  if (/\b(week|month|year|day)s?\b/i.test(q.text))             score += 2;
  if (q.title)                                                 score += 1;
  if (q.author)                                                score += 1;
  if (/https?:\/\/|www\./i.test(q.text))                       score -= 20;

  return score;
}

function rankQuotes(quotes) {
  return quotes
    .map((q, i) => ({ q, i, s: quoteStrength(q) }))
    .sort((a, b) => {
      if (b.s !== a.s) return b.s - a.s;
      const at = a.q.datePublished ? a.q.datePublished.getTime() : 0;
      const bt = b.q.datePublished ? b.q.datePublished.getTime() : 0;
      if (bt !== at) return bt - at;
      return a.i - b.i;                      // stable for equal candidates
    })
    .map(x => x.q);
}

// ── microdata / meta fallback ──────────────────────────────────────
//
// Some templates emit only itemprop microdata for the aggregate (no
// JSON-LD). Cheap to read and it's the difference between "no rating"
// and a rating for those stores. Individual review bodies are NOT
// scraped from arbitrary markup — that path yields navigation chrome and
// truncated widget text far more often than usable quotes.
function microdataAggregate(html) {
  const grab = (prop) => {
    const re = new RegExp(
      `<[^>]+itemprop\\s*=\\s*["']${prop}["'][^>]*>`,
      'i'
    );
    const tag = (html.match(re) || [])[0];
    if (!tag) return null;
    const content = (tag.match(/\scontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i) || []);
    const val = content[1] != null ? content[1] : content[2];
    return val != null ? val : null;
  };
  const ratingValue = grab('ratingValue');
  const bestRating  = grab('bestRating');
  const count       = grab('reviewCount') || grab('ratingCount');
  return {
    rating:      normalizeStars(ratingValue, bestRating),
    reviewCount: toCount(count)
  };
}

// ── main extractors ────────────────────────────────────────────────

/**
 * reviewsFromProductNode(node, opts?) → { rating, reviewCount, quotes[] }
 * For callers that already parsed the PDP's Product JSON-LD (the
 * sitemap resolver keeps the node in hand). Pure.
 */
function reviewsFromProductNode(node, { source = null, maxQuotes = MAX_QUOTES } = {}) {
  const empty = { rating: null, reviewCount: null, quotes: [] };
  if (!node || typeof node !== 'object') return empty;

  let rating = null;
  let reviewCount = null;

  const ar = node.aggregateRating;
  if (ar && typeof ar === 'object') {
    rating = normalizeStars(ar.ratingValue, ar.bestRating);
    reviewCount = toCount(ar.reviewCount != null ? ar.reviewCount : ar.ratingCount);
  } else if (ar != null) {
    rating = normalizeStars(ar);
  }

  const rev = node.review != null ? node.review : node.reviews;
  const arr = Array.isArray(rev) ? rev : rev ? [rev] : [];
  const quotes = [];
  for (const r of arr) {
    const q = mapReviewNode(r, source);
    if (q) quotes.push(q);
  }

  return {
    rating,
    reviewCount,
    quotes: rankQuotes(quotes).slice(0, maxQuotes)
  };
}

/**
 * extractOnPageReviews(html, opts?) → {
 *   rating, reviewCount, quotes[], platform, quotesFound, source
 * }
 * The engine. JSON-LD Product first (any review app's rich snippets),
 * standalone Review nodes second, itemprop microdata for the aggregate
 * last. `quotesFound` is the pre-cap count so callers can log how much
 * a page actually had.
 */
function extractOnPageReviews(html, { platform = undefined, maxQuotes = MAX_QUOTES } = {}) {
  const plat = platform === undefined ? detectReviewPlatform(html) : platform;
  const out = {
    rating: null,
    reviewCount: null,
    quotes: [],
    platform: plat,
    quotesFound: 0,
    source: null
  };
  if (!html || typeof html !== 'string') return out;

  const nodes = flattenLdNodes(parseLdBlocks(html));
  const label = plat || 'store';

  // 1. Product nodes — the aggregate lives here, and so do review[]
  //    entries on every app that publishes rich snippets.
  const collected = [];
  for (const node of nodes) {
    if (!isType(node, /product/i)) continue;
    const r = reviewsFromProductNode(node, { source: label, maxQuotes: Infinity });
    if (out.rating == null && r.rating != null) out.rating = r.rating;
    if (out.reviewCount == null && r.reviewCount != null) out.reviewCount = r.reviewCount;
    collected.push(...r.quotes);
    if (r.rating != null || r.quotes.length) out.source = 'json-ld';
  }

  // 2. Standalone Review nodes — several apps emit reviews as siblings of
  //    the Product rather than nested inside it.
  if (!collected.length) {
    for (const node of nodes) {
      if (!isType(node, /^review$/i)) continue;
      const q = mapReviewNode(node, label);
      if (q) collected.push(q);
    }
    if (collected.length) out.source = 'json-ld';
  }

  // 3. Aggregate-only microdata fallback.
  if (out.rating == null) {
    const md = microdataAggregate(html);
    if (md.rating != null) {
      out.rating = md.rating;
      if (out.reviewCount == null) out.reviewCount = md.reviewCount;
      out.source = out.source || 'microdata';
    }
  }

  out.quotesFound = collected.length;
  out.quotes = rankQuotes(collected).slice(0, maxQuotes);
  return out;
}

/**
 * ratingDistributionOf(quotes) → [{ stars, count }] | null
 * Star histogram over the reviews we actually collected. Descending by
 * stars, only the buckets present. Null when nothing carried a rating.
 *
 * NOTE this is the distribution of the FETCHED SAMPLE, not of the store's
 * whole review set — `reviewsFetched` next to it says how big that sample
 * was, and `reviewCount` says how many the store claims in total. Callers
 * that render percentages must divide by reviewsFetched, not reviewCount.
 */
function ratingDistributionOf(quotes) {
  const buckets = new Map();
  for (const q of quotes || []) {
    if (!q || !Number.isFinite(q.rating)) continue;
    const star = Math.max(1, Math.min(5, Math.round(q.rating)));
    buckets.set(star, (buckets.get(star) || 0) + 1);
  }
  if (!buckets.size) return null;
  return [...buckets.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([stars, count]) => ({ stars, count }));
}

/**
 * mergeTier(base, tier) → base
 * Fold a tier-2/3 result into the tier-1 snapshot. Aggregates fill gaps
 * only — a vendor API's own count/average is authoritative when the page
 * had none, but we never overwrite a figure the page stated. Quotes are
 * unioned and deduped on normalized text, so the handful of rich-snippet
 * reviews and the paginated set collapse into one list.
 */
function mergeTier(base, tier, label) {
  if (!tier) return base;
  if (base.rating == null && tier.average != null) {
    base.rating = normalizeStars(tier.average);
  }
  if (base.reviewCount == null && tier.total != null) {
    base.reviewCount = tier.total;
  }
  if (!base.vendorDistribution && tier.distribution) {
    base.vendorDistribution = tier.distribution;
  }

  const seen = new Set(base.quotes.map(q => reviewKey(q.text)));
  for (const q of tier.reviews || []) {
    const key = reviewKey(q.text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    base.quotes.push(Object.assign({ source: tier.platform || base.platform || 'store' }, q));
  }

  base.quotesFound += (tier.reviews || []).length;
  base.pagesFetched = (base.pagesFetched || 0) + (tier.pagesFetched || 0);
  base.truncated = base.truncated || !!tier.truncated;
  base.tiers.push(tier.platform ? `${label}:${tier.platform}` : label);
  if (!base.platform && tier.platform) base.platform = tier.platform;
  return base;
}

function reviewKey(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 160);
}

/**
 * fetchProductReviews(productUrl, opts?) → merged result + { ok, reason }
 *
 * Three tiers, cheapest first, each additive:
 *
 *   1. ON-PAGE STRUCTURED DATA — one GET, the review app's rich-snippet
 *      output. Free and always tried.
 *   2. VENDOR PUBLIC API (services/reviewAdapters) — paginated. Runs when
 *      tier 1 came up short: apps publish only a couple of reviews in
 *      snippets (Judge.me ~2 of 81, Bazaarvoice ~6 of 156) and
 *      client-rendered widgets publish none. Same public endpoint the
 *      widget itself reads, no credentials.
 *   3. HEADLESS CAPTURE (services/reviewHeadlessCapture) — a real browser,
 *      paginated by driving the widget. Expensive, so it only runs when
 *      tiers 1-2 found NOTHING and the caller opts in.
 *
 * Robots-aware and throttled throughout (httpScrapeClient). Never throws.
 */
async function fetchProductReviews(productUrl, {
  timeoutMs = 15000,
  maxBytes = 4_000_000,
  maxQuotes = MAX_QUOTES,
  useAdapters = true,
  useHeadless = false,
  adapterMaxPages = undefined,
  adapterMaxReviews = undefined
} = {}) {
  const fail = (reason) => ({
    ok: false, reason, rating: null, reviewCount: null,
    quotes: [], platform: null, quotesFound: 0, source: null,
    tiers: [], pagesFetched: 0, truncated: false,
    ratingDistribution: null, reviewsFetched: 0
  });
  if (!productUrl) return fail('no productUrl');

  let allowed = true;
  try { allowed = await http.isAllowedByRobots(productUrl); } catch { allowed = true; }
  if (!allowed) return fail('robots disallow');

  let res;
  try {
    res = await http.fetchText(productUrl, { timeoutMs, maxBytes });
  } catch (err) {
    return fail(`fetch failed: ${err.message}`);
  }
  if (res.cfChallenged) return fail('cloudflare challenge');
  if (res.rateLimited)  return fail('rate limited');
  if (!res.ok || !res.text) return fail(`http ${res.status || 'error'}`);

  const html = res.text;
  // Tier 1 keeps every review it can see — the storage cap is applied once
  // at the end, after all tiers have contributed to the ranking pool.
  const merged = Object.assign(
    { ok: true, reason: null, tiers: [], pagesFetched: 0, truncated: false, vendorDistribution: null },
    extractOnPageReviews(html, { maxQuotes: Infinity })
  );
  if (merged.source) merged.tiers.push('json-ld');

  // ── tier 2: vendor public API, paginated ─────────────────────────
  if (useAdapters && merged.quotes.length < maxQuotes) {
    try {
      const adapters = require('./reviewAdapters');
      const viaApi = await adapters.fetchViaAdapters(html, productUrl, {
        platform: merged.platform,
        ...(adapterMaxPages   != null ? { maxPages:   adapterMaxPages }   : {}),
        ...(adapterMaxReviews != null ? { maxReviews: adapterMaxReviews } : {})
      });
      if (viaApi) mergeTier(merged, viaApi, 'api');
    } catch (err) {
      console.warn(`   ⚠️  ${LOG}  adapter tier failed for ${productUrl}: ${err.message}`);
    }
  }

  // ── tier 3: headless, only when the cheap tiers found nothing ────
  if (useHeadless && !merged.quotes.length) {
    try {
      const headless = require('./reviewHeadlessCapture');
      const viaBrowser = await headless.captureReviews(productUrl, {
        platform: merged.platform,
        maxReviews: adapterMaxReviews
      });
      if (viaBrowser) mergeTier(merged, viaBrowser, 'headless');
    } catch (err) {
      console.warn(`   ⚠️  ${LOG}  headless tier failed for ${productUrl}: ${err.message}`);
    }
  }

  // Rank across everything collected, then cap for storage.
  merged.reviewsFetched = merged.quotes.length;
  merged.ratingDistribution = ratingDistributionOf(merged.quotes);
  merged.quotes = rankQuotes(merged.quotes).slice(0, maxQuotes);
  if (!merged.source && merged.tiers.length) merged.source = merged.tiers[0];
  return merged;
}

// ── persistence ────────────────────────────────────────────────────

/**
 * buildProductReviews(extracted, existing?) → productReviews | null
 *
 * Shapes the CatalogProduct.productReviews snapshot. Preserves the
 * `summary` a previous web-wide (Gemini) enrichment wrote — the scrape
 * owns first-party quotes/rating, the narrative summary comes from a
 * different engine and must survive a re-scrape.
 */
function buildProductReviews(extracted, existing = null) {
  if (!extracted) return null;
  const hasSignal = extracted.rating != null ||
    extracted.reviewCount != null ||
    (extracted.quotes && extracted.quotes.length > 0);
  if (!hasSignal) return null;

  return {
    quotes:      extracted.quotes || [],
    rating:      extracted.rating,
    reviewCount: extracted.reviewCount,
    summary:     existing && existing.summary != null ? existing.summary : null,
    platform:    extracted.platform || null,
    source:      extracted.source || null,
    quotesFound: extracted.quotesFound || 0,
    // Star histogram of the reviews we collected. `reviewsFetched` is its
    // denominator — NOT reviewCount, which is the store's total.
    ratingDistribution: extracted.ratingDistribution
      || ratingDistributionOf(extracted.quotes)
      || null,
    // Distribution as the vendor reported it, when their API gave one.
    vendorDistribution: extracted.vendorDistribution || null,
    reviewsFetched: extracted.reviewsFetched != null
      ? extracted.reviewsFetched
      : (extracted.quotes || []).length,
    // Provenance: ['json-ld'], ['json-ld','api:judge.me'], ['headless:okendo'] …
    tiers:        Array.isArray(extracted.tiers) ? extracted.tiers : [],
    pagesFetched: extracted.pagesFetched || 0,
    truncated:    !!extracted.truncated,
    fetchedAt:   new Date()
  };
}

/**
 * isFresh(productReviews) → boolean
 * True when a snapshot carries real signal inside the TTL. A snapshot
 * with neither rating nor quotes is treated as stale so an empty page is
 * retried on the next refresh (widgets get their SEO snippets enabled).
 */
function isFresh(productReviews) {
  if (!productReviews) return false;
  const hasSignal = productReviews.rating != null ||
    (Array.isArray(productReviews.quotes) && productReviews.quotes.length > 0);
  if (!hasSignal) return false;
  const ts = productReviews.fetchedAt ? new Date(productReviews.fetchedAt).getTime() : 0;
  return Number.isFinite(ts) && (Date.now() - ts) < TTL_MS;
}

/**
 * captureForProduct(row, opts?) → { captured, reason, productReviews }
 * Fetch + extract + persist for ONE CatalogProduct row (lean doc with
 * _id / productUrl / productReviews / title). Writes `rating` alongside
 * the snapshot so existing consumers that read the top-level field pick
 * the on-page value up.
 */
async function captureForProduct(row, {
  force = false,
  maxQuotes = MAX_QUOTES,
  useAdapters = true,
  useHeadless = HEADLESS_DEFAULT,
  adapterMaxPages = undefined,
  adapterMaxReviews = undefined
} = {}) {
  const CatalogProduct = require('../models/CatalogProduct');
  if (!row || !row.productUrl) return { captured: false, reason: 'no productUrl' };
  if (!force && isFresh(row.productReviews)) {
    return { captured: false, reason: 'fresh' };
  }

  const extracted = await fetchProductReviews(row.productUrl, {
    maxQuotes, useAdapters, useHeadless, adapterMaxPages, adapterMaxReviews
  });
  if (!extracted.ok) return { captured: false, reason: extracted.reason };

  const productReviews = buildProductReviews(extracted, row.productReviews);
  if (!productReviews) {
    return {
      captured: false,
      reason: extracted.platform
        ? `no reviews reachable (${extracted.platform}: no rich snippets, no public API hit${useHeadless ? ', headless found none' : ''})`
        : 'no structured reviews on page'
    };
  }

  const $set = { productReviews };
  if (productReviews.rating != null) $set.rating = productReviews.rating;
  await CatalogProduct.updateOne({ _id: row._id }, { $set });

  return { captured: true, reason: null, productReviews };
}

// ── brand-wide refresh ─────────────────────────────────────────────

const SYNC_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.PRODUCT_REVIEWS_CONCURRENCY, 10) || 4
);
const SYNC_MAX_PER_RUN = Math.max(
  1,
  parseInt(process.env.PRODUCT_REVIEWS_MAX_PER_RUN, 10) || 2000
);

/**
 * syncBrandProductReviews(brandId, opts?) → summary
 *
 * Brand-wide review capture for ANY catalog source — the point of the
 * shared engine. Meta/IG-catalog and Apify brands never got on-page
 * reviews before (they only had the paid Gemini gap-fill); they have
 * productUrl on the merchant's own site, which is all this needs.
 *
 * Free (no LLM, no SerpAPI), TTL-gated, robots-aware, per-host throttled
 * by httpScrapeClient, and surfaced as a cancellable OperationRun.
 */
async function syncBrandProductReviews(brandId, {
  force = false,
  limit = SYNC_MAX_PER_RUN,
  concurrency = SYNC_CONCURRENCY,
  advertiserId = null,
  run = null,
  // Tier controls. Adapters (tier 2) are on — they are plain HTTP GETs to
  // the same public endpoint the store's own widget reads. Headless
  // (tier 3) is opt-in per run because it costs a browser per product.
  useAdapters = true,
  useHeadless = HEADLESS_DEFAULT,
  adapterMaxPages = undefined,
  adapterMaxReviews = undefined
} = {}) {
  const CatalogProduct = require('../models/CatalogProduct');
  const Brand = require('../models/Brand');
  const { startRun, CancelledError } = require('./progressService');

  const t0 = Date.now();
  const brand = await Brand.findById(brandId).select('_id name advertiserId').lean();
  if (!brand) return { ok: false, reason: 'brand not found' };

  const filter = {
    brandId: brand._id,
    productUrl: { $exists: true, $nin: [null, ''] }
  };
  if (!force) {
    // Cheap pre-filter; isFresh() does the authoritative check per row
    // (it also treats a signal-less snapshot as stale).
    filter.$or = [
      { productReviews: null },
      { productReviews: { $exists: false } },
      { 'productReviews.fetchedAt': { $exists: false } },
      { 'productReviews.fetchedAt': { $lt: new Date(Date.now() - TTL_MS) } },
      { 'productReviews.rating': null, 'productReviews.quotes': { $size: 0 } }
    ];
  }

  const rows = await CatalogProduct.find(filter)
    .select('_id title productUrl productReviews')
    .limit(Math.max(1, limit))
    .lean();

  const summary = {
    ok: true,
    candidates: rows.length,
    captured: 0,
    withQuotes: 0,
    withRating: 0,
    skipped: 0,
    cancelled: false,
    platforms: {},
    tiers: {},
    reviewsCollected: 0,
    pagesFetched: 0,
    durationMs: 0
  };
  if (!rows.length) {
    summary.durationMs = Date.now() - t0;
    return summary;
  }

  const handle = run || await startRun({
    kind: 'enrichment',
    brandId: String(brand._id),
    advertiserId: advertiserId || brand.advertiserId || null,
    total: rows.length,
    cancellable: true,
    label: `Reviews · ${brand.name || 'brand'}`
  });
  handle.stage?.('scraping product reviews');

  let done = 0;
  let cancelled = false;

  const worker = async (queue) => {
    while (queue.length && !cancelled) {
      const row = queue.shift();
      if (!row) break;
      try {
        if (handle.checkpoint) await handle.checkpoint();
      } catch (err) {
        if (err instanceof CancelledError) { cancelled = true; break; }
      }

      try {
        const res = await captureForProduct(row, {
          force, useAdapters, useHeadless, adapterMaxPages, adapterMaxReviews
        });
        if (res.captured) {
          summary.captured += 1;
          const pr = res.productReviews;
          if (pr.quotes.length) summary.withQuotes += 1;
          if (pr.rating != null) summary.withRating += 1;
          const key = pr.platform || 'unlabeled';
          summary.platforms[key] = (summary.platforms[key] || 0) + 1;
          summary.reviewsCollected += pr.reviewsFetched || 0;
          summary.pagesFetched += pr.pagesFetched || 0;
          for (const t of pr.tiers || []) {
            summary.tiers[t] = (summary.tiers[t] || 0) + 1;
          }
        } else {
          summary.skipped += 1;
        }
      } catch (err) {
        summary.skipped += 1;
        console.warn(`   ⚠️  ${LOG}  reviews capture failed for "${row.title}": ${err.message}`);
      }

      done += 1;
      handle.tick?.(
        done,
        rows.length,
        `${done}/${rows.length} pages · ${summary.withQuotes} with quotes · ${summary.withRating} with ratings`
      );
    }
  };

  const queue = rows.slice();
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, () => worker(queue))
  );

  summary.cancelled = cancelled;
  summary.durationMs = Date.now() - t0;

  const note = `${summary.captured} captured · ${summary.withQuotes} with quotes · ` +
    `${summary.withRating} with ratings · ${summary.reviewsCollected} reviews read · ` +
    `${summary.skipped} skipped`;
  if (!run) {
    if (cancelled) await handle.markCancelled?.();
    else await handle.succeed?.(note);
  }

  console.log(
    `${LOG}  reviews sync brand=${brand._id} ${note} ` +
    `platforms=${JSON.stringify(summary.platforms)} tiers=${JSON.stringify(summary.tiers)} ` +
    `in ${Math.round(summary.durationMs / 1000)}s`
  );
  return summary;
}

module.exports = {
  // engine
  detectReviewPlatform,
  extractOnPageReviews,
  reviewsFromProductNode,
  fetchProductReviews,
  // persistence
  buildProductReviews,
  captureForProduct,
  isFresh,
  syncBrandProductReviews,
  // pure helpers (unit-tested)
  normalizeStars,
  mapReviewNode,
  rankQuotes,
  quoteStrength,
  MAX_QUOTES,
  MIN_POSITIVE_STARS,
  TTL_DAYS
};
