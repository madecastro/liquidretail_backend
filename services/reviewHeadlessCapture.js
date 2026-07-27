// services/reviewHeadlessCapture.js
//
// Tier 3 of the review engine: capture reviews from a REAL BROWSER for stores
// that publish neither rich snippets (tier 1) nor a readable public API
// (tier 2 — services/reviewAdapters). Paginated, capped, opt-in.
//
// WHY THIS EXISTS: deathwishcoffee.com runs Bazaarvoice with zero
// aggregateRating in its server HTML — tier 1 sees nothing. golde.co ships a
// static AggregateRating stub but literally zero Review nodes, so tier 1 gets
// a number and no text. Both render their reviews client-side after ~9-11s of
// widget bootstrap. A browser is the only way in.
//
// STRATEGY: RESPONSE INTERCEPTION, NOT DOM SCRAPING (verified live on both
// stores above). We load the PDP, let the widget hydrate, and read the JSON
// the widget's own XHRs return. That yields typed data — integer ratings,
// ISO timestamps, plaintext bodies — where the DOM yields presentation
// artefacts: Bazaarvoice encodes a rating as `<abbr title="4 out of 5
// stars.">` plus a CSS bucket class, Junip draws five inline <use> SVG stars,
// and BOTH render dates as relative strings ("9 months ago"). Interception is
// also frame-agnostic for free — page.on('response') fires for child frames,
// so iframe-hosted widgets need no frames() walk. DOM scraping stays as the
// fallback for a store whose data never crosses a network boundary.
//
// THE INTERCEPTED PAYLOADS ARE THE SAME SHAPES TIER 2 ALREADY PARSES, so this
// module deliberately does NOT re-implement field mapping: it hands each
// payload to the matching adapter's parse()/normalize(). One place to fix a
// vendor's field names, not two.
//
// PAGINATION: click the widget's own load-more/next control, wait for the
// follow-up XHR, repeat. Bazaarvoice advances by the PREVIOUS page's limit
// (observed 0 → 10 → 40 → 70, so never assume page*size) and Junip walks an
// opaque cursor 5 reviews at a time — both reduce to the same loop because we
// read whatever the widget asks for rather than constructing requests.
//
// COST (measured): ~9-11s to first review XHR (storefront + widget bootstrap,
// 200-600 subresources across 40-75 hosts on a typical PDP — not tunable by
// us), then ~1.0-2.5s per pagination click. A full 149-review Bazaarvoice
// product is ~20-25s; a 131-review Junip product would be ~38s because its
// widget pages 5 at a time. Hence the click cap: this is for harvesting a
// pool of positive quotes, not for archiving every review.
//
// ROBOTS: we always fetch the MERCHANT's page (allowed — same check tier 1
// makes) and reading what it renders is fair game. Harvesting the JSON of a
// vendor host that disallows robots is NOT, so intercepted payloads are gated
// per host and a disallowed vendor falls through to the DOM read. loox.io is
// the live example: it disallows /widget, so its JSON is never harvested even
// though the merchant's page fetches it.
//
// SANDBOX GOTCHA worth knowing beyond this feature: bundled Chromium could not
// complete ANY outbound TLS in a container behind a TLS-terminating proxy
// (ERR_CONNECTION_RESET even for https://example.com) until GREASE Encrypted
// ClientHello was disabled by policy. If tier 3 fails everywhere in a new
// image, suspect that before suspecting the selectors.

'use strict';

const { cleanScrapedText } = require('../utils/htmlEntities');

const LOG = '⭐';

// ── caps ───────────────────────────────────────────────────────────
const ENABLED = process.env.REVIEW_HEADLESS_ENABLED === 'true';
const MAX_CLICKS = Math.max(
  0,
  parseInt(process.env.REVIEW_HEADLESS_MAX_CLICKS, 10) || 6
);
const MAX_REVIEWS = Math.max(
  1,
  parseInt(process.env.REVIEW_HEADLESS_MAX_REVIEWS, 10) || 100
);
// Hard per-product wall clock. Everything below is bounded by this too, so a
// hung storefront costs one product, not a stalled sweep.
const BUDGET_MS = Math.max(
  10000,
  parseInt(process.env.REVIEW_HEADLESS_BUDGET_MS, 10) || 60000
);
const NAV_TIMEOUT_MS = Math.max(
  5000,
  parseInt(process.env.REVIEW_HEADLESS_NAV_TIMEOUT_MS, 10) || 30000
);
// Widgets need a beat after their container mounts before their first XHR
// resolves; both verified vendors did.
const HYDRATE_MS = Math.max(
  0,
  parseInt(process.env.REVIEW_HEADLESS_HYDRATE_MS, 10) || 3500
);
const CLICK_WAIT_MS = Math.max(
  1000,
  parseInt(process.env.REVIEW_HEADLESS_CLICK_WAIT_MS, 10) || 12000
);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ── vendor response map ────────────────────────────────────────────
//
// `test` matches a response URL that CARRIES REVIEW DATA — deliberately
// narrow. Bazaarvoice's own loader/telemetry hosts (apps.bazaarvoice.com,
// display.ugc.bazaarvoice.com, network-a.bazaarvoice.com .gif beacons) are
// "this vendor is live here" signals only and must not be harvested.
//
// `unwrap` reshapes the intercepted body into what the tier-2 adapter's
// parse() expects. `adapter` names the module in ./reviewAdapters.
const VENDOR_RESPONSES = [
  {
    platform: 'bazaarvoice',
    adapter: 'bazaarvoice',
    // The widget's batch endpoint bundles resources as resource.qN — the q
    // index SHIFTS between requests, so match on the presence of reviews
    // rather than a fixed index.
    test: (url) => /api\.bazaarvoice\.com\/data\/(batch|reviews)\.json/i.test(url),
    unwrap: (body) => {
      // batch.json responses are JSONP-wrapped and nest under BatchedResults.
      const json = typeof body === 'string' ? unwrapJsonp(body) : body;
      if (!json) return null;
      if (json.BatchedResults && typeof json.BatchedResults === 'object') {
        // Pick the sub-result that actually holds reviews.
        for (const key of Object.keys(json.BatchedResults)) {
          const part = json.BatchedResults[key];
          if (part && Array.isArray(part.Results)) return part;
        }
        return null;
      }
      return Array.isArray(json.Results) ? json : null;
    }
  },
  {
    platform: 'junip',
    adapter: 'junip',
    test: (url) => /apid\.juniphq\.com\/v\d+\/products\/remote\/[^/]+\/reviews/i.test(url),
    // has_media=true fires in parallel for the photo tab — same shape, and
    // dedupe on text means absorbing it is harmless.
    unwrap: (body) => (body && Array.isArray(body.data) ? body : null)
  },
  {
    platform: 'yotpo',
    adapter: 'yotpo',
    test: (url) => /yotpo\.com\/v1\/widget\/[^/]+\/products\/[^/]+\/reviews/i.test(url),
    unwrap: (body) => (body && body.response ? body : null)
  },
  {
    platform: 'okendo',
    adapter: 'okendo',
    test: (url) => /api\.okendo\.io\/v\d+\/stores\/[^/]+\/products\/[^/]+\/reviews/i.test(url),
    unwrap: (body) => (body && Array.isArray(body.reviews) ? body : null)
  },
  {
    platform: 'stamped',
    adapter: 'stamped',
    test: (url) => /stamped\.io\/api\/widget/i.test(url),
    unwrap: (body) => (body && Array.isArray(body.data) ? body : null)
  },
  {
    platform: 'judge.me',
    adapter: 'judge.me',
    test: (url) => /judge\.me\/reviews\/reviews_for_widget/i.test(url),
    unwrap: (body) => (body && typeof body.html === 'string' ? body : null)
  },
  {
    platform: 'powerreviews',
    adapter: 'powerreviews',
    test: (url) => /display\.powerreviews\.com\/m\/[^/]+\/l\/[^/]+\/product\/[^/]+\/reviews/i.test(url),
    unwrap: (body) => (body && Array.isArray(body.results) ? body : null)
  },
  {
    platform: 'fera',
    adapter: 'fera',
    test: (url) => /fera\.ai\/api\/v\d+\/public\/products\/[^/]+\/reviews/i.test(url),
    unwrap: (body) => (body && Array.isArray(body.data) ? body : null)
  },
  {
    platform: 'reviews.io',
    adapter: 'reviews.io',
    test: (url) => /api\.reviews\.io\/(product\/reviews|timeline\/data)/i.test(url),
    unwrap: (body) => (body && Array.isArray(body.reviews) ? body : null)
  }
];

/**
 * unwrapJsonp(text) → object | null
 * Bazaarvoice's batch endpoint answers `BV._internal.dataHandler0({…})` (the
 * callback name varies: bv_<n>_<n> too). Strip to the outermost {...} and
 * parse. Plain JSON passes through unchanged.
 */
function unwrapJsonp(text) {
  if (typeof text !== 'string') return null;
  const s = text.trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch { /* fall through to the JSONP shape */ }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first === -1 || last <= first) return null;
  try {
    return JSON.parse(s.slice(first, last + 1));
  } catch {
    return null;
  }
}

/** matchVendorResponse(url) → vendor entry | null */
function matchVendorResponse(url) {
  if (!url) return null;
  for (const v of VENDOR_RESPONSES) {
    if (v.test(url)) return v;
  }
  return null;
}

// ── load-more controls ─────────────────────────────────────────────
//
// Ordered per platform, then a generic text-matched sweep. Bazaarvoice's
// "Next Reviews" REPLACES the list rather than appending — irrelevant when
// harvesting XHRs, but it's why the DOM fallback snapshots after each click.
const LOAD_MORE_SELECTORS = [
  // bazaarvoice
  'button.bv-content-btn-pages-last:not(.bv-content-btn-pages-inactive)',
  'button.bv-content-pagination-buttons-item-next:not([disabled])',
  // judge.me / yotpo / okendo / loox / stamped / fera
  'a.jdgm-paginate__next-page',
  '.yotpo-pager .yotpo-icon-right-arrow',
  'button[data-oke-reviews-more], .oke-showMore-button, button.oke-button--more',
  'button.loox-load-more, .loox-reviews-more',
  '.stamped-pagination-next, a.stamped-paginate-next',
  'button.fera-load-more'
];

// Junip's control is text-only ("See more reviews"), and so are plenty of
// theme-custom ones. Kept separate because a text sweep is the risky path —
// it must never match "Write a review".
const LOAD_MORE_TEXT_RE = /(load|show|see)\s+more|more\s+reviews|next\s+reviews|next\s+page/i;
const LOAD_MORE_TEXT_DENY_RE = /write\s+a?\s*review|ask\s+a\s+question|see\s+more\s+products/i;

// ── DOM fallback selectors ─────────────────────────────────────────
const DOM_REVIEW_SELECTORS = [
  { platform: 'bazaarvoice', item: 'li.bv-content-item.bv-content-review',
    text: '.bv-content-summary-body-text', author: '.bv-content-author-name',
    rating: 'abbr.bv-rating-stars-off[title], abbr[title*="out of 5"]' },
  { platform: 'junip', item: '.junip-review',
    text: '.junip-review-body, .junip-review__body', author: '.junip-review-author',
    rating: '[aria-label*="star"]' },
  { platform: 'generic', item: '[class*="review-item"], [class*="review__item"], [data-review-id]',
    text: '[class*="review-body"], [class*="review__body"], [class*="review-content"]',
    author: '[class*="review-author"], [class*="reviewer-name"]',
    rating: '[aria-label*="star"], [title*="out of 5"]' }
];

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * harvestFromPayload(vendor, body, ctxHint) → quotes[]
 * Reuses the tier-2 adapter's parse()/normalize() on an intercepted payload,
 * so vendor field mappings live in exactly one place. Pure apart from the
 * adapter require; exported for tests.
 */
function harvestFromPayload(vendor, body, ctxHint = {}) {
  const out = { quotes: [], total: null, average: null, distribution: null };
  if (!vendor) return out;

  let payload;
  try {
    payload = vendor.unwrap(body);
  } catch {
    payload = null;
  }
  if (!payload) return out;

  let adapter;
  try {
    adapter = require('./reviewAdapters').BY_PLATFORM.get(vendor.adapter);
  } catch {
    adapter = null;
  }
  if (!adapter) return out;

  // The adapter's parse()/normalize() want a ctx. We do not have discovery
  // output here (the browser did the discovering), so hand over a minimal ctx
  // and let the family/group filters no-op when productId is unknown.
  const ctx = Object.assign({ productId: null }, ctxHint);
  let parsed;
  try {
    parsed = adapter.parse(payload, ctx, 0);
  } catch {
    return out;
  }
  if (!parsed || parsed.error) return out;

  for (const raw of parsed.reviews || []) {
    let q;
    try {
      q = adapter.normalize(raw, ctx);
    } catch {
      q = null;
    }
    if (q && q.text) {
      q.source = vendor.platform;
      out.quotes.push(q);
    }
  }
  if (parsed.total != null) out.total = parsed.total;
  if (parsed.average != null) out.average = parsed.average;
  if (parsed.distribution) out.distribution = parsed.distribution;
  return out;
}

// Cached robots verdicts for vendor hosts — one lookup per host per process.
const ROBOTS_CACHE = new Map();

async function harvestAllowed(url) {
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return false;
  }
  if (ROBOTS_CACHE.has(origin)) return ROBOTS_CACHE.get(origin);
  let allowed = true;
  try {
    allowed = await require('./httpScrapeClient').isAllowedByRobots(url);
  } catch {
    allowed = true;                       // unreachable robots.txt states nothing
  }
  ROBOTS_CACHE.set(origin, allowed);
  if (!allowed) {
    console.log(`   · ${LOG}  headless: ${origin} disallows robots — DOM read only`);
  }
  return allowed;
}

/**
 * scrapeDomReviews(page) → quotes[]
 * Fallback when nothing crossed the network boundary. Reads visible review
 * nodes; ratings come from aria-label / title text because the visual star
 * state is CSS. Dates are deliberately NOT read — both verified vendors
 * render them as relative strings ("9 months ago"), which is worse than null.
 */
async function scrapeDomReviews(page, selectors) {
  try {
    return await page.evaluate((groups) => {
      const readRating = (el) => {
        if (!el) return null;
        const src = el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '';
        const m = String(src).match(/(\d(?:\.\d)?)\s*(?:out of|\/)\s*5|(\d(?:\.\d)?)\s*star/i);
        const v = m ? Number(m[1] || m[2]) : NaN;
        return Number.isFinite(v) ? v : null;
      };
      for (const g of groups) {
        const items = Array.from(document.querySelectorAll(g.item));
        if (!items.length) continue;
        const rows = items.map((el) => {
          const t = el.querySelector(g.text);
          return {
            text: (t ? t.textContent : el.textContent || '').trim().slice(0, 600),
            author: (() => { const a = el.querySelector(g.author); return a ? a.textContent.trim() : null; })(),
            rating: readRating(el.querySelector(g.rating)),
            platform: g.platform
          };
        }).filter(r => r.text && r.text.length >= 20);
        if (rows.length) return rows;
      }
      return [];
    }, selectors);
  } catch {
    return [];
  }
}

/** Click the widget's own next/load-more control. → true when something was clicked. */
async function clickLoadMore(page) {
  for (const sel of LOAD_MORE_SELECTORS) {
    try {
      const handle = await page.$(sel);
      if (!handle) continue;
      const visible = await handle.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' &&
               !el.disabled && el.getAttribute('aria-disabled') !== 'true';
      }).catch(() => false);
      if (!visible) continue;
      await handle.evaluate(el => el.scrollIntoView({ block: 'center' })).catch(() => {});
      await handle.click({ delay: 20 }).catch(() => null);
      return true;
    } catch { /* try the next selector */ }
  }

  // Text-matched sweep for controls with no stable class (Junip's "See more
  // reviews"). Denylist guards against clicking "Write a review", which would
  // navigate away from the page mid-capture.
  try {
    const clicked = await page.evaluate((rxSrc, denySrc) => {
      const rx = new RegExp(rxSrc, 'i');
      const deny = new RegExp(denySrc, 'i');
      const els = Array.from(document.querySelectorAll('button, a[role="button"], a'));
      for (const el of els) {
        const label = (el.textContent || '').trim();
        if (!label || label.length > 40) continue;
        if (deny.test(label) || !rx.test(label)) continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
        el.scrollIntoView({ block: 'center' });
        el.click();
        return true;
      }
      return false;
    }, LOAD_MORE_TEXT_RE.source, LOAD_MORE_TEXT_DENY_RE.source);
    return !!clicked;
  } catch {
    return false;
  }
}

/**
 * captureReviews(productUrl, opts?) → adapter-shaped result | null
 *
 * Same return shape as the tier-2 driver so productReviewsScrapeService can
 * merge it identically: { platform, reviews[], total, average, distribution,
 * pagesFetched, truncated, stopReason }. Never throws — a review miss must
 * not fail a catalog sync.
 */
async function captureReviews(productUrl, {
  platform = null,
  maxReviews = MAX_REVIEWS,
  maxClicks = MAX_CLICKS,
  budgetMs = BUDGET_MS,
  force = false
} = {}) {
  if (!productUrl) return null;
  if (!ENABLED && !force) return null;

  const deadline = Date.now() + budgetMs;
  const seen = new Set();
  const out = {
    platform,
    reviews: [],
    total: null,
    average: null,
    distribution: null,
    pagesFetched: 0,
    truncated: false,
    stopReason: null
  };

  let browser;
  try {
    // Reuse headlessScrapeService's pooled browser rather than launching a
    // second Chrome. Lazily required so a container without puppeteer
    // installed degrades to "tier 3 unavailable" instead of failing at load.
    browser = await require('./headlessScrapeService').getBrowser();
  } catch (err) {
    console.warn(`   ⚠️  ${LOG}  headless unavailable: ${err.message}`);
    return null;
  }

  let page;
  try {
    page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1366, height: 900 });

    // Harvest as responses land. Bodies are read inside the handler because a
    // response body is not retrievable after navigation.
    const pending = [];
    page.on('response', (res) => {
      const url = res.url();
      const vendor = matchVendorResponse(url);
      if (!vendor) return;
      pending.push((async () => {
        try {
          if (!(await harvestAllowed(url))) return;
          const text = await res.text();
          // Bazaarvoice's unwrap handles its own JSONP wrapper, so it takes the
          // raw text; every other vendor answers plain JSON.
          let payload = text;
          if (vendor.platform !== 'bazaarvoice') {
            try { payload = JSON.parse(text); } catch { return; }
          }
          const got = harvestFromPayload(vendor, payload, { productId: null });
          if (!got.quotes.length && got.total == null) return;
          out.platform = out.platform || vendor.platform;
          out.pagesFetched += 1;
          if (out.total == null && got.total != null) out.total = got.total;
          if (out.average == null && got.average != null) out.average = got.average;
          if (!out.distribution && got.distribution) out.distribution = got.distribution;
          for (const q of got.quotes) {
            const key = String(q.text).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 160);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            if (out.reviews.length < maxReviews) out.reviews.push(q);
          }
        } catch { /* one bad response must not kill the capture */ }
      })());
    });

    // networkidle2 is a hang risk — storefront telemetry (Klaviyo, Rebuy,
    // monorail) keeps firing well past any sane idle point — so settle for
    // domcontentloaded and give the widget a fixed hydrate window.
    try {
      await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    } catch (err) {
      out.stopReason = `navigation failed: ${err.message}`;
      return finish(out, page, pending);
    }
    await sleep(Math.min(HYDRATE_MS, Math.max(0, deadline - Date.now())));
    await Promise.allSettled(pending.slice());

    // Pagination: click, wait for the follow-up XHR, repeat.
    let clicks = 0;
    while (clicks < maxClicks && out.reviews.length < maxReviews) {
      if (Date.now() >= deadline) { out.truncated = true; out.stopReason = 'time budget'; break; }
      const before = out.reviews.length;
      const clicked = await clickLoadMore(page);
      if (!clicked) { out.stopReason = out.stopReason || 'no load-more control'; break; }
      clicks += 1;

      const waitUntil = Math.min(Date.now() + CLICK_WAIT_MS, deadline);
      while (Date.now() < waitUntil && out.reviews.length === before) {
        await sleep(300);
        await Promise.allSettled(pending.slice());
      }
      if (out.reviews.length === before) {
        out.stopReason = 'no new reviews after click';
        break;
      }
    }
    if (out.reviews.length >= maxReviews) {
      out.truncated = true;
      out.stopReason = out.stopReason || 'review cap';
    }

    // Nothing crossed the network boundary → read what is on screen.
    if (!out.reviews.length) {
      const rows = await scrapeDomReviews(page, DOM_REVIEW_SELECTORS);
      for (const r of rows) {
        const body = cleanScrapedText(r.text, 400);
        if (!body) continue;
        const key = body.toLowerCase().replace(/\s+/g, ' ').slice(0, 160);
        if (seen.has(key)) continue;
        seen.add(key);
        out.reviews.push({
          text: body,
          title: null,
          author: cleanScrapedText(r.author, 120),
          rating: Number.isFinite(r.rating) ? r.rating : null,
          datePublished: null,             // relative strings only in the DOM
          verified: false,
          source: r.platform === 'generic' ? (out.platform || 'store') : r.platform
        });
        if (out.reviews.length >= maxReviews) break;
      }
      if (out.reviews.length) {
        out.stopReason = 'dom fallback';
        out.pagesFetched = Math.max(out.pagesFetched, 1);
      }
    }

    return finish(out, page, pending);
  } catch (err) {
    console.warn(`   ⚠️  ${LOG}  headless capture failed for ${productUrl}: ${err.message}`);
    try { if (page) await page.close(); } catch { /* noop */ }
    return out.reviews.length ? out : null;
  }
}

async function finish(out, page, pending) {
  try { await Promise.allSettled(pending.slice()); } catch { /* noop */ }
  try { if (page) await page.close(); } catch { /* noop */ }
  if (!out.reviews.length && out.total == null && out.average == null) return null;
  console.log(
    `   · ${LOG}  headless: ${out.reviews.length} review(s) via ${out.platform || 'dom'} ` +
    `(${out.pagesFetched} payload(s), stop=${out.stopReason || 'exhausted'})`
  );
  return out;
}

module.exports = {
  captureReviews,
  // pure/unit-testable internals
  unwrapJsonp,
  matchVendorResponse,
  harvestFromPayload,
  VENDOR_RESPONSES,
  LOAD_MORE_SELECTORS,
  LOAD_MORE_TEXT_RE,
  LOAD_MORE_TEXT_DENY_RE,
  DOM_REVIEW_SELECTORS,
  ENABLED,
  MAX_CLICKS,
  BUDGET_MS
};
