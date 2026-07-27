// Judge.me — public widget endpoint.
//
// VERIFIED LIVE 2026-07-27 against beardbrand.com (product 7432276279379).
// robots.txt explicitly allows /api/v1 and does not disallow this path.
//
// THIS ONE RETURNS HTML, NOT PER-REVIEW JSON. The response is JSON, but the
// reviews live inside a `html` string — a rendered widget fragment. Each
// review is a `<div class="jdgm-rev" data-score="5" data-verified-buyer=…>`
// block. So `as: 'json'` + parse the fragment.
//
// PAGE SIZE IS SILENTLY CLAMPED TO 30. per_page=31 and per_page=100 both
// return exactly 30 rows with byte-identical payload sizes — no error. And
// omitting per_page falls back to an undocumented default (7 observed), so
// it is always sent explicitly.
//
// The aggregate is NOT in this payload: average/count come from the PDP's
// own badge markup (data-average-rating / data-number-of-reviews), which
// discover() captures while it is already looking at the HTML.

'use strict';

const {
  firstMatch, pick, toInt, toFloat, toDate, text, htmlToText, shopifyProductId, shopDomain
} = require('./helpers');

const PAGE_SIZE = 30;                    // server cap; asking for more is silently clamped

// data-id on the Judge.me widget div is the Shopify product id. Falls back
// to the platform-standard analytics blob (themes sometimes omit the badge).
const PRODUCT_ID_RES = [
  /class=["'][^"']*jdgm-(?:widget|preview-badge)[^"']*["'][^>]*data-id=["'](\d{6,})["']/i,
  /data-id=["'](\d{6,})["'][^>]*class=["'][^"']*jdgm-/i
];

const AVG_RES = [/data-average-rating=["']([\d.]+)["']/i];
const COUNT_RES = [/data-number-of-reviews=["'](\d+)["']/i];

// Presence check. Apps churn — drsquatch.com was Judge.me and is Okendo now
// — so installation is confirmed from the page, never from a static list.
function isInstalled(html) {
  return /jdgmSettings|jdgm-widget|jdgm-rev\b|judge\.me/i.test(html);
}

function discover(html, pageUrl) {
  if (!html || !isInstalled(html)) return null;
  const productId = firstMatch(html, PRODUCT_ID_RES) || shopifyProductId(html);
  if (!productId) return null;
  const shop = shopDomain(html, pageUrl);
  if (!shop) return null;
  return {
    productId,
    shop,
    // Aggregate scraped from the badge — this endpoint has none.
    pageAverage: toFloat(firstMatch(html, AVG_RES)),
    pageCount: toInt(firstMatch(html, COUNT_RES))
  };
}

function request(ctx, page) {
  const qs = new URLSearchParams({
    url: ctx.shop,
    shop_domain: ctx.shop,
    platform: 'shopify',
    product_id: String(ctx.productId),
    page: String(page + 1),              // 1-indexed; there is no page=0
    per_page: String(PAGE_SIZE)
  });
  return { url: `https://judge.me/reviews/reviews_for_widget?${qs}`, as: 'json' };
}

// One review block per <div class="jdgm-rev …>. Attributes carry the
// structured bits (score, verified, timestamp); the body/title/author are
// nested elements.
const REV_BLOCK_RE = /<div[^>]*class=["'][^"']*\bjdgm-rev\b[^"']*["'][^>]*>[\s\S]*?(?=<div[^>]*class=["'][^"']*\bjdgm-rev\b|<\/div>\s*<\/div>\s*$|$)/gi;

function parseBlock(block) {
  const attr = (name) => firstMatch(block, [new RegExp(`${name}=["']([^"']*)["']`, 'i')]);
  const inner = (cls) => firstMatch(block, [
    new RegExp(`class=["'][^"']*\\b${cls}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/`, 'i')
  ]);
  return {
    body: inner('jdgm-rev__body'),
    title: inner('jdgm-rev__title'),
    author: inner('jdgm-rev__author'),
    score: attr('data-score'),
    verified: attr('data-verified-buyer'),
    timestamp: attr('data-timestamp') || inner('jdgm-rev__timestamp')
  };
}

function parse(payload, ctx) {
  const fragment = pick(payload, 'html');
  if (typeof fragment !== 'string') return { reviews: [] };

  const blocks = fragment.match(REV_BLOCK_RE) || [];
  const reviews = blocks.map(parseBlock).filter(r => r.body);

  // Judge.me's own paging metadata when present; otherwise the driver's
  // short-page rule handles termination.
  const total = toInt(pick(payload, 'total') ?? pick(payload, 'reviews_count') ?? ctx.pageCount);

  return {
    reviews,
    total: total != null ? total : undefined,
    average: ctx.pageAverage != null ? ctx.pageAverage : undefined
  };
}

function normalize(raw) {
  const body = htmlToText(raw.body, 400);
  if (!body) return null;
  return {
    text: body,
    title: htmlToText(raw.title, 140),
    author: text(htmlToText(raw.author, 120), 120),
    rating: toFloat(raw.score),
    datePublished: toDate(raw.timestamp),
    verified: raw.verified === 'true' || raw.verified === '1'
  };
}

module.exports = {
  platform: 'judge.me',
  pageSize: PAGE_SIZE,
  discover,
  request,
  parse,
  normalize
};
