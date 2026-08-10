// Apify pull — public scrape adapters for Instagram + Shopify. Used
// by demo Brands (created under the Sales Demos advertiser) to pull
// records BEFORE the prospect has done a real OAuth handshake.
//
// One shared token (APIFY_TOKEN) authenticates every call. Actor IDs
// and per-source result limits are env-configurable so the Sales team
// can tune limits without a deploy.
//
// TRANSPORT — measured (default) vs legacy sync. See runActorSync.
// The legacy `run-sync-get-dataset-items` endpoint returns ONLY dataset
// items, so the run's real cost was never observable. The measured path
// starts the run asynchronously, waits on the run object, and reads
// `usageTotalUsd` / `chargedEventCounts` back off it. Kill switch:
// APIFY_COST_READBACK=false restores the single legacy call.
//
// Contract: each puller returns a plain array of normalized records.
// Shape normalization stays intentionally shallow — downstream ingest
// services (apify → Media + DetectRun for IG, apify → CatalogProduct
// for Shopify) are responsible for mapping into the domain shape.

const axios = require('axios');
const { cleanScrapedText } = require('../utils/htmlEntities');

const APIFY_API_ROOT = 'https://api.apify.com/v2';

// Actor slugs — override in .env when Apify releases newer scrapers
// or if we want to swap to a different community actor. The default
// Shopify actor (webdatalabs/shopify-product-scraper) takes a "mode"
// switch: 'url' uses our startUrls; 'storeUrls' uses the actor's
// bundled multi-store list. We always send mode='url' explicitly —
// omitting it lets the actor fall back to its default input, which
// scrapes allbirds.com instead of the target store.
const IG_ACTOR      = process.env.APIFY_IG_ACTOR      || 'apify/instagram-scraper';
const SHOPIFY_ACTOR = process.env.APIFY_SHOPIFY_ACTOR || 'webdatalabs/shopify-product-scraper';

// Per-source result-count ceilings. Env-overridable; defaults land in
// the sweet spot for demo-brand ad generation:
//   IG=50    — enough post variety for concept selection without
//              hitting apify/instagram-scraper's flakiness ramp at
//              ~100+ posts. Cost ~$0.20 per pull.
//   Shopify=200 — deep enough for most brand catalogs to seed real
//              product-driven ad concepts. Sits well under the
//              maxPages=10 × ~30-50 products/page hard ceiling
//              (~300-500 from the actor side). Cost ~$0.15 per pull;
//              downstream enrichment (~$0.05-0.12/product) is where
//              real spend lands (~$10-24 first-run).
const IG_LIMIT      = Math.max(1, parseInt(process.env.APIFY_IG_LIMIT, 10)      || 50);
const SHOPIFY_LIMIT = Math.max(1, parseInt(process.env.APIFY_SHOPIFY_LIMIT, 10) || 200);

// Proxy group used by both actors. Options (per Apify):
//   ''             — Apify's default (datacenter). Cheapest, blocked
//                     by anti-scrape firewalls on some Shopify stores
//                     and IG sometimes.
//   RESIDENTIAL    — real-user IPs; bypasses most firewalls / IG
//                     blocks. 5-10x more expensive per GB.
//   AUTO           — actor picks based on target hostname.
//   Any actor-specific group the user's Apify account has enabled.
// Leave APIFY_PROXY_GROUP unset for the default; set to 'RESIDENTIAL'
// on brands whose stores 403 the datacenter proxy.
const APIFY_PROXY_GROUP = process.env.APIFY_PROXY_GROUP || '';

function proxyConfig() {
  const cfg = { useApifyProxy: true };
  if (APIFY_PROXY_GROUP) cfg.apifyProxyGroups = [APIFY_PROXY_GROUP];
  return cfg;
}

// Apify's sync-run endpoint blocks for up to 5 min. Our HTTP client
// caps at 5 min + 15s slack so we always see the actor error, not an
// axios timeout, when Apify itself is slow.
const APIFY_HTTP_TIMEOUT_MS = 5 * 60 * 1000 + 15_000;

// Kill switch for the measured transport. Default ON. Set
// APIFY_COST_READBACK=false to fall back to the single legacy
// `run-sync-get-dataset-items` call (no cost readback).
const COST_READBACK =
  String(process.env.APIFY_COST_READBACK ?? 'true').trim().toLowerCase() !== 'false';

// Apify caps `waitForFinish` at 60s on BOTH the run-start POST and the
// run GET (spec: MAX_ACTOR_JOB_ASYNC_WAIT_SECS). So the measured path
// long-polls in 60s hops until the run is terminal or our own budget
// (APIFY_HTTP_TIMEOUT_MS, matching the legacy 5min sync window) runs out.
const APIFY_WAIT_FOR_FINISH_SECS = 60;
// Terminal only. ABORTING / TIMING-OUT are transitional — treating them as
// terminal would read the cost back before Apify has settled the charge.
const TERMINAL_RUN_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);
// Floor between poll hops. waitForFinish normally holds the connection for
// the full 60s, but a server that answers early must not turn the loop into
// a request flood inside the 5min budget.
const APIFY_POLL_FLOOR_MS = 1000;

function getToken() {
  const t = process.env.APIFY_TOKEN;
  if (!t) throw new Error('APIFY_TOKEN is not set — cannot invoke Apify actors');
  return t;
}

// LEGACY transport — one call, dataset items only, cost unobservable.
// Kept byte-identical to the pre-readback implementation so
// APIFY_COST_READBACK=false is a true revert, not a rewrite.
async function runActorLegacySync(actorId, input) {
  const token = getToken();
  const url = `${APIFY_API_ROOT}/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items`;
  const res = await axios.post(url, input, {
    params:  { token },
    timeout: APIFY_HTTP_TIMEOUT_MS,
    headers: { 'content-type': 'application/json' }
  });
  return Array.isArray(res.data) ? res.data : [];
}

// MEASURED transport. Three steps, one of them billable:
//   1. POST /acts/{id}/runs?waitForFinish=60   → the Run object (BILLABLE)
//   2. GET  /actor-runs/{runId}?waitForFinish=60 (repeat) → settled run
//   3. GET  /datasets/{datasetId}/items        → the same array step 1
//                                                of the legacy call returned
//
// Why not the endpoints the obvious reading suggests — both were checked
// against Apify's published OpenAPI spec on 2026-08-10 and neither works:
//   • `run-sync-get-dataset-items` documents only X-Apify-Pagination-*
//     response headers. There is NO run id anywhere in the response, so
//     the run can't be looked up afterwards.
//   • `run-sync` does NOT return the run object. It returns the record
//     stored under the OUTPUT key of the run's key-value store (the spec
//     calls it "a legacy approach"). No usage figures on it either.
// Starting the run async is therefore the only transport that yields a
// run id, and the run id is the only thing that yields a MEASURED cost.
//
// `maxRedirects: 0` on the billable POST per CLAUDE.md §2 — axios defaults
// to 21 and re-sends the body on 307/308, which is a silent double charge.
// (The legacy branch above lacks this; it is left as-is on purpose so the
// kill switch reverts cleanly. Fix it there separately if it ever matters.)
async function runActorMeasured(actorId, input, costMeta) {
  const token = getToken();
  const deadline = Date.now() + APIFY_HTTP_TIMEOUT_MS;

  const startUrl = `${APIFY_API_ROOT}/acts/${encodeURIComponent(actorId)}/runs`;
  const started = await axios.post(startUrl, input, {
    params:       { token, waitForFinish: APIFY_WAIT_FOR_FINISH_SECS },
    timeout:      APIFY_HTTP_TIMEOUT_MS,
    maxRedirects: 0,
    headers:      { 'content-type': 'application/json' }
  });

  let run = started.data?.data;
  if (!run?.id) {
    // 2xx with no run object. The run may nonetheless be RUNNING and
    // charging, and we have no id to look it up with — so say so rather
    // than let a caller read this as "nothing happened, safe to retry".
    throw new Error(
      `Apify run start for ${actorId} returned 2xx with no run id — a run may be ` +
      `in flight and billing; check the Apify dashboard before re-running`
    );
  }

  // Long-poll to terminal. Each hop is a free GET.
  while (!TERMINAL_RUN_STATUSES.has(run.status) && Date.now() < deadline) {
    const hopStart = Date.now();
    run = (await getRun(token, run.id)) || run;
    const elapsed = Date.now() - hopStart;
    if (!TERMINAL_RUN_STATUSES.has(run.status) && elapsed < APIFY_POLL_FLOOR_MS) {
      await new Promise((r) => setTimeout(r, APIFY_POLL_FLOOR_MS - elapsed));
    }
  }

  // Apify can settle `usageTotalUsd` a beat after the run goes terminal —
  // same lag the Atlas price reconcile exists for (CLAUDE.md §2). One free
  // re-read rather than reporting a measured cost of "unknown".
  if (TERMINAL_RUN_STATUSES.has(run.status) && numeric(run.usageTotalUsd) === null) {
    run = (await getRun(token, run.id)) || run;
  }

  // Record what we know BEFORE the success check — a FAILED run is still
  // a charged run, and the operator needs that number more, not less.
  recordRunCost(costMeta, run);

  if (run.status !== 'SUCCEEDED') {
    // Distinguish "the actor failed" from "we stopped waiting" — the second
    // means the run is STILL GOING and still billing, and re-running the
    // step would pay for the same work twice.
    const abandoned = !TERMINAL_RUN_STATUSES.has(run.status);
    throw new Error(
      abandoned
        ? `Apify run ${run.id} for ${actorId} was still ${run.status || 'UNKNOWN'} after ` +
          `${Math.round(APIFY_HTTP_TIMEOUT_MS / 1000)}s — abandoned the wait; the run may ` +
          `still be executing and billing`
        : `Apify run ${run.id} for ${actorId} ended ${run.status}`
    );
  }

  const datasetId = run.defaultDatasetId;
  if (!datasetId) {
    // A SUCCEEDED run always carries a defaultDatasetId. Returning [] here
    // would report "success, no data" for a run we PAID for — silent loss
    // wearing the same shape as a post that genuinely has no comments.
    throw new Error(
      `Apify run ${run.id} for ${actorId} SUCCEEDED with no defaultDatasetId — ` +
      `results unreachable despite a charged run`
    );
  }
  const items = await axios.get(
    `${APIFY_API_ROOT}/datasets/${encodeURIComponent(datasetId)}/items`,
    { params: { token }, timeout: APIFY_HTTP_TIMEOUT_MS }
  );
  return coerceDatasetItems(items.data, datasetId, run.id);
}

// The default `format=json` always yields an array (and `limit` defaults to
// no limit, so there is no silent truncation). Anything else is an anomaly
// on a run we have ALREADY PAID FOR — the legacy transport could only shrug
// and return [], but here we know it was charged, and "[]" is
// indistinguishable from a post that genuinely has no comments.
// Split out so the harness can exercise it without mocking axios.
function coerceDatasetItems(data, datasetId, runId) {
  if (!Array.isArray(data)) {
    throw new Error(
      `Apify dataset ${datasetId} (run ${runId}) returned ${typeof data}, not an ` +
      `array — results unusable despite a charged run`
    );
  }
  return data;
}

// One run read. Returns null (never throws) so a transient GET failure
// costs us a poll hop, not the whole already-paid-for run.
async function getRun(token, runId) {
  try {
    const res = await axios.get(`${APIFY_API_ROOT}/actor-runs/${encodeURIComponent(runId)}`, {
      params:  { token, waitForFinish: APIFY_WAIT_FOR_FINISH_SECS },
      timeout: APIFY_HTTP_TIMEOUT_MS
    });
    return res.data?.data || null;
  } catch (_) {
    return null;
  }
}

// Strict numeric coercion: null → null, NOT 0.
//
// This is load-bearing and was a real bug on the first cut. `Number(null)`
// is 0 and `Number.isFinite(0)` is true, so a run that reports
// `usageTotalUsd: null` — which is exactly what an unsettled run reports —
// was being recorded as a MEASURED cost of $0.00. That is the worst
// possible failure for this feature: it does not merely lose the number,
// it asserts the run was free, and it also skipped the settle-lag re-read
// that would have fetched the real figure.
function numeric(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Copy the measured figures onto the caller's out-param. Never throws —
// a cost-readback problem must not break the data path.
function recordRunCost(costMeta, run) {
  if (!costMeta || typeof costMeta !== 'object' || !run) return;
  try {
    const usage = numeric(run.usageTotalUsd);
    // PAY_PER_EVENT actors report per-event counts; apify/instagram-scraper
    // has exactly one event ('result'), so this is the billable item count.
    const counts = run.chargedEventCounts || {};
    const charged = Object.values(counts).reduce((s, n) => s + (numeric(n) ?? 0), 0);
    costMeta.runId          = run.id || null;
    costMeta.status         = run.status || null;
    costMeta.datasetId      = run.defaultDatasetId || null;
    costMeta.usageTotalUsd  = usage;
    costMeta.chargedResults = Object.keys(counts).length ? charged : null;
    costMeta.measured       = usage !== null;
  } catch (_) { /* cost telemetry is never load-bearing */ }
}

// `costMeta`, when supplied, is an out-param populated with the run's
// MEASURED cost. Callers that don't care pass nothing and are unaffected.
async function runActorSync(actorId, input, costMeta = null) {
  if (!COST_READBACK) return runActorLegacySync(actorId, input);
  return runActorMeasured(actorId, input, costMeta);
}

// Pull recent public posts for an IG handle. Returns normalized
// items — shape below stays close to Media doc fields so the ingest
// service is a thin mapping layer.
async function pullInstagramPosts(handle, { limit } = {}) {
  if (!handle) throw new Error('IG handle is required');
  const cleanHandle = String(handle).trim().replace(/^@+/, '');
  const resultsLimit = Math.max(1, Math.min(parseInt(limit, 10) || IG_LIMIT, IG_LIMIT));

  const input = {
    directUrls:         [`https://www.instagram.com/${cleanHandle}/`],
    resultsType:        'posts',
    resultsLimit,
    addParentData:      false,
    proxyConfiguration: proxyConfig()
  };
  const items = await runActorSync(IG_ACTOR, input);
  return items.map(normalizeIgPost).filter(Boolean);
}

function normalizeIgPost(raw) {
  if (!raw || !raw.id) return null;
  const isVideo = raw.type === 'Video' || raw.type === 'Reel' || !!raw.videoUrl;
  return {
    externalId:    String(raw.id),
    shortCode:     raw.shortCode || null,
    permalink:     raw.url || (raw.shortCode ? `https://www.instagram.com/p/${raw.shortCode}/` : null),
    mediaType:     isVideo ? 'VIDEO' : 'IMAGE',
    mediaUrl:      isVideo ? (raw.videoUrl || raw.displayUrl) : raw.displayUrl,
    thumbnailUrl:  raw.displayUrl || null,
    caption:       raw.caption || null,
    timestamp:     raw.timestamp || null,
    ownerUsername: raw.ownerUsername || null,
    likeCount:     Number.isFinite(raw.likesCount)    ? raw.likesCount    : null,
    commentsCount: Number.isFinite(raw.commentsCount) ? raw.commentsCount : null
  };
}

// Cap on comments per post via the Apify scraper. Env-overridable so
// operators can push it higher for brands where deep comment volume
// matters. Kept low by default because comments cost per-record.
const IG_COMMENTS_LIMIT = Math.max(1, parseInt(process.env.APIFY_IG_COMMENTS_LIMIT, 10) || 50);

// Pull comments for one IG post via the SAME apify/instagram-scraper
// actor but with resultsType='comments'. Input is the post's public
// URL or shortcode-derived permalink. Returns normalized comment
// records shaped for Comment doc upsert (mediaId is filled in by
// the ingest wrapper — this puller doesn't know about DB ids).
// `costMeta` is an optional out-param — pass an object to have the run's
// MEASURED cost written onto it ({runId, usageTotalUsd, chargedResults,
// measured}). The comment fan-out is the one caller that reads it, because
// it is the one an operator approves on a dollar figure.
async function pullInstagramComments(postUrl, { limit, costMeta = null } = {}) {
  if (!postUrl) throw new Error('post URL is required');
  const cleanUrl = String(postUrl).trim();
  if (!/^https?:\/\/(www\.)?instagram\.com\/(p|reel)\//i.test(cleanUrl)) {
    throw new Error(`postUrl must be an instagram.com /p/ or /reel/ permalink (got "${cleanUrl}")`);
  }
  const resultsLimit = Math.max(1, Math.min(parseInt(limit, 10) || IG_COMMENTS_LIMIT, IG_COMMENTS_LIMIT));

  const input = {
    directUrls:         [cleanUrl],
    resultsType:        'comments',
    resultsLimit,
    addParentData:      false,
    proxyConfiguration: proxyConfig()
  };
  const items = await runActorSync(IG_ACTOR, input, costMeta);
  return items.map(normalizeIgComment).filter(Boolean);
}

function normalizeIgComment(raw) {
  if (!raw || !raw.id) return null;
  // Apify's IG scraper emits comments with a mix of camelCase field
  // names — some builds use `ownerUsername`, others `username`, and
  // `likesCount` vs `likeCount`. Tolerant to both.
  return {
    externalId:     String(raw.id),
    text:           raw.text || '',
    authorUsername: raw.ownerUsername || raw.username || null,
    authorId:       raw.ownerId || raw.userId || null,
    likeCount:      Number.isFinite(raw.likesCount) ? raw.likesCount
                    : Number.isFinite(raw.likeCount) ? raw.likeCount
                    : 0,
    replyCount:     Number.isFinite(raw.repliesCount) ? raw.repliesCount
                    : Number.isFinite(raw.replyCount) ? raw.replyCount
                    : 0,
    postedAt:       raw.timestamp ? new Date(raw.timestamp) : null,
    // Apify comment scraper sometimes returns replies with an
    // `answersTo` field pointing at the parent id. Match the existing
    // Comment.parentExternalId shape.
    parentExternalId: raw.answersTo || raw.parentCommentId || null
  };
}

// Pull recent products from a public Shopify storefront. Returns
// normalized items shaped for CatalogProduct upsert.
async function pullShopifyProducts(shopUrl, { limit } = {}) {
  if (!shopUrl) throw new Error('Shopify URL is required');
  const maxItems = Math.max(1, Math.min(parseInt(limit, 10) || SHOPIFY_LIMIT, SHOPIFY_LIMIT));

  // Despite mode='url' + a startUrls field being present, the
  // webdatalabs actor actually consumes `storeUrls` as the primary
  // target list — it even validates "At least one store URL is
  // required in URL mode" when storeUrls is empty. Sending our
  // target URL under `startUrls` alone let the actor's default
  // storeUrls (allbirds) win, which was the original bug.
  //
  // Fix: put the target URL in BOTH fields, and cap max* / maxStores
  // so the actor can't wander to other stores its defaults might list.
  const target = String(shopUrl);
  const input = {
    mode:               'url',
    storeUrls:          [{ url: target }],   // the field the actor actually reads
    startUrls:          [{ url: target }],   // belt-and-suspenders — some builds check this too
    maxItems,
    maxProducts:        maxItems,
    maxStores:          1,
    maxPages:           10,
    category:           '',
    proxyConfiguration: proxyConfig()
  };
  const items = await runActorSync(SHOPIFY_ACTOR, input);
  return items.map(normalizeShopifyProduct).filter(Boolean);
}

function normalizeShopifyProduct(raw) {
  if (!raw) return null;
  const externalId = raw.id || raw.productId || raw.handle;
  if (!externalId) return null;

  const images = Array.isArray(raw.images)
    ? raw.images.map(i => (typeof i === 'string' ? i : i?.src || i?.url)).filter(Boolean)
    : [];
  const variants = Array.isArray(raw.variants) ? raw.variants : [];
  const firstVariant = variants[0] || {};
  const priceStr = raw.price ?? firstVariant.price ?? raw.priceRange?.min ?? null;
  const price    = priceStr != null ? Number(String(priceStr).replace(/[^\d.]/g, '')) : null;

  return {
    externalId:    String(externalId),
    // Actors that scrape HTML hand back entity-encoded text ("33&quot;"),
    // so decode before this becomes CatalogProduct.title.
    title:         cleanScrapedText(raw.title || raw.name),
    description:   raw.description || raw.bodyHtml || null,
    productUrl:    raw.url || raw.productUrl || null,
    imageUrl:      images[0] || raw.image || raw.featuredImage || null,
    additionalImageUrls: images.slice(1),
    price:         Number.isFinite(price) ? price : null,
    currency:      raw.currency || raw.priceRange?.currency || null,
    availability:  raw.available === false ? 'out of stock' : 'in stock',
    brand:         cleanScrapedText(raw.vendor || raw.brand),
    handle:        raw.handle || null
  };
}

module.exports = {
  pullInstagramPosts,
  pullInstagramComments,
  pullShopifyProducts,
  IG_LIMIT,
  IG_COMMENTS_LIMIT,
  SHOPIFY_LIMIT,
  // Exported for scripts/verifyApifyCommentCost.js. A source-shape check
  // cannot tell `numeric` from a reimplementation that still returns 0 for
  // null, so the harness has to CALL these.
  numeric,
  recordRunCost,
  coerceDatasetItems,
  TERMINAL_RUN_STATUSES
};
