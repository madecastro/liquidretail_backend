# LiquidRetail Backend — Background & Creative Pipelines

This is the engineer reference for every background and creative pipeline in the LiquidRetail backend (Node/Express + Mongoose). For each pipeline: what triggers it, its stages, which models/APIs it calls (and rough cost), which env knobs tune it, how progress/cancel works, and what consumes its output. Facts are code-verified as of **2026-07-23** (deterministic-first video rework: backend PRs #11/#12/#13, frontend #10). Prefer this doc over tribal memory; when in doubt, open the cited files.

> **Cost hot-spots (read first)**
>
> | Hot-spot | When it fires | Rough cost | Mitigation (current default) |
> |---|---|---|---|
> | **Overlay zones** (`overlayZoneService.analyzeOverlayZones`, Gemini-2.5 vision) | Per catalog-product image after detect | ~**13–26s / image** Gemini vision | **Deferred** to ad time (`CATALOG_DETECT_PRECOMPUTE=false`); only products a campaign will use |
> | **User-actuated product enrichment** (SerpAPI shopping + immersive + Gemini grounded-search) | Sales Demos **Enrich** button | ~**$0.05–0.12 / product** | Opt-in only; auto path is reviews gap-fill |
> | **Static ad photoreal finish** (`gpt-image-2` image-ref, quality `high`) | After GPT-4.1 HTML layout + Puppeteer raster | Dominant static-ad $ when enabled | `AI_IMAGE_REFERENCE_ENABLED` / quality knob; seed dumps via `IMAGE_REF_DUMP_SEEDS` |
> | **Veo / Atlas video** | Video ad generation | Provider rate limits (429 at concurrency >1) | `VEO_CONCURRENCY=1` — **do not raise** |
> | **Catalog scan (sitemap + JSON-LD)** | Demo / catalog sync | Deterministic HTTP only — **no LLM** | Caps + per-host min-gap; bounded PDP concurrency |

Non-secret defaults live in `config/defaults.env` (versioned). Secrets stay in the Render environment only (see [§9](#9-configuration--secrets)).

---

## 1. Catalog scan + save (generic sitemap + JSON-LD)

Deterministic, cheap product ingest: discover product URLs from sitemaps, fetch PDPs, extract structured product data, upsert into `CatalogProduct`. No LLM.

### Trigger

- Sales-demo / catalog sync path that selects the **generic-sitemap** method (via `services/apifyIngestService.js` orchestration; kill-switch `GENERIC_CATALOG_ENABLED`).
- Resolve: `services/genericCatalogResolver.js` → `resolveGenericCatalog`.
- Persist: `services/genericCatalogIngestService.js` → `syncBrandGenericCatalog`.

### Stages

1. **Discovery** — robots.txt + sitemap index/urlset walk; product-URL ranking; lastmod descending.
2. **Bounded caps** — `GENERIC_CATALOG_LIMIT` (products), `GENERIC_CATALOG_MAX_SITEMAP_URLS` (URL walk bound).
3. **Per-PDP fetch** — `services/httpScrapeClient.js`:
   - Per-host min-gap throttle (default **250ms**, `HTTP_SCRAPE_MIN_GAP_MS`)
   - UA rotation, 429 / `Retry-After`, Cloudflare detection, streaming `maxBytes`
4. **Bounded-parallel PDP scan** — `GENERIC_CATALOG_PDP_CONCURRENCY` (default **5**) parallel fetches when the site declares **no** crawl-delay; still **serial + spaced** when crawl-delay is present. `httpScrapeClient` enforces per-host min-gap regardless. ~**4–8×** faster than the old fully serial loop.
5. **Extraction**
   - Primary: JSON-LD Product → `mapJsonLdProduct` (`genericCatalogResolver.js`)
   - Fallback: Open Graph → `mapOgProduct`
   - **Entity decode** — every human-readable field goes through `utils/htmlEntities.js` `cleanScrapedText`. A `<script type="application/ld+json">` is a raw-text element, so the HTML parser never decodes character references inside it: sites that escape their JSON-LD ship `Austen Black 74&quot; TV Stand` and `Table &#x2B; Buffet Lamps` straight through `JSON.parse`. Same for `<meta content="…">` values, which are entity-encoded by definition. Decoding is a **single pass**, so a double-escaped `&amp;quot;` becomes the literal `&quot;` rather than a bare quote. Descriptions additionally get tag-stripped on both sides of the decode (`stripHtml`) because escaped markup (`&lt;div&gt;…`) is only strippable once decoded. Rows synced before this landed are repaired by `scripts/backfillHtmlEntities.js`.
6. **Validate** → **sku-dedup** → **CatalogProduct upsert**.
7. **In-scan breadcrumb (NEW)** — reuses `services/breadcrumbParser.js` `extractBreadcrumb` → persisted as `inferredBreadcrumb` + `inferredCategoryAt` + Category tree via `Category.findOrCreateCategoryTree`, so post-sync category inference **skips** these products (no second crawl). See [§2](#2-post-sync-trio).

**On-page fields captured:** title, description, price/currency/availability, primary + additional images, brand, gtin/mpn/sku, category, aggregate rating, review quotes, **and category breadcrumb**.

**Feed-id strategy (`externalId`):**  
`sku` → `productID` → `offers.sku`  
**Never** use mpn/gtin as `externalId` — they repeat across variants; stored separately. Matches Shopify/GMC feed `id`.

### Models & cost

- **None (LLM).** Pure HTTP + HTML/JSON-LD parse. Cost is bandwidth + time under host politeness.

### Env knobs

| Var | Default | Role |
|---|---|---|
| `GENERIC_CATALOG_ENABLED` | `true` | Kill-switch (`false` disables generic-sitemap method) |
| `GENERIC_CATALOG_LIMIT` | `10000` | Max products per resolve/sync |
| `GENERIC_CATALOG_MAX_SITEMAP_URLS` | `20000` | Sitemap URL walk bound |
| `GENERIC_CATALOG_PDP_CONCURRENCY` | `5` | Parallel PDP fetches (when no crawl-delay) |
| `HTTP_SCRAPE_MIN_GAP_MS` | `250` | Per-host minimum gap between requests |
| `HTTP_SCRAPE_DOMAIN_CONCURRENCY` | `3` | Concurrent in-flight per domain (`httpScrapeClient`) |

See `config/defaults.env` and `services/genericCatalogResolver.js` / `httpScrapeClient.js`.

### Progress / cancel

- **OperationRun** kind: `demo-sync` (generic-catalog method under the broader demo-sync surface; also used by Apify/Shopify-direct paths with different stages).
- Stages: `resolving generic catalog` → `saving products to catalog`.
- Save-phase note: `saved X/Y products · Z% with reviews` (Z = share of *saved-so-far* products with rating/quotes).
- Cancellable: yes (`demo-sync` ∈ `CANCELLABLE_KINDS` in `services/progressService.js`).

### Consumers

- `CatalogProduct` rows → IG→product matching, Sales Demos UI, campaign product pickers, later detect/enrichment/ads.
- In-scan breadcrumb stamps → skip post-sync full category crawl ([§2c](#2-post-sync-trio)).
- Variant-role stamping at end of sync (detect enqueue path) still runs even when image detect is deferred ([§3](#3-per-product-detect--overlay-zones--ad-readiness-deferred-to-ad-time)).

---

## 2. Post-sync trio

Historically three jobs fired at the end of a catalog sync (`services/genericCatalogIngestService.js` ~258–324; mirrored in Shopify public / Apify / `catalogSyncService`). **Current behavior:**

| # | Job | Behavior now |
|---|---|---|
| **(a)** | Product-detect enqueue | **DEFERRED** — variant roles stamped; image detect skipped unless precompute. [§3](#3-per-product-detect--overlay-zones--ad-readiness-deferred-to-ad-time) |
| **(b)** | Catalog enrichment | **Free on-site review scrape (all paths)**, then paid gap-fill for what's left. [§4](#4-catalog-enrichment-reviews--cross-seller-details) |
| **(c)** | Category inference | **Mostly skipped** — breadcrumbs captured in-scan; backfills only gaps |

### (c) Category inference (gap backfill)

- **File:** `services/productCategoryInferenceService.js` → `inferBatch` (accepts `onProgress`).
- **Query:** products with `productUrl` and missing/stale `inferredCategoryAt` (TTL-based).
- **Concurrency:** 6, per-domain throttled.
- **Progress:** own OperationRun — kind **`category-inference`** (distinct from paid `enrichment` so it isn't conflated in the activity log or blocked by the Enrich lock), label **`Category inference`**, per-item progress + cancel (`checkpoint` between items).

---

## 3. Per-product detect + overlay-zones + ad-readiness (DEFERRED to ad time)

The former “idle worker” cost center: per catalog-product image, run vision pipelines that produce crops, **overlay zones**, and ad-readiness. Matching does **not** need this; **ad generation does**.

### Trigger

| Mode | When | Entry |
|---|---|---|
| **Sync-time (default)** | After catalog sync | `catalogProductDetectService.enqueueBrandProductDetects` — stamps **variant roles only** (`isPrimaryVariant` / `primaryProductId`); **skips** image enqueue unless `CATALOG_DETECT_PRECOMPUTE=true` |
| **Eager precompute** | `CATALOG_DETECT_PRECOMPUTE=true` | Same function enqueues hero (+ alt) detects for primaries missing `imageMediaId` |
| **On-demand (primary)** | Ad generation | `ensureDetectForProducts(ids, { wait })` from `campaignAdsGenerationService.expandWizardJob` (explicit product picks **and** products matched to selected media) |
| **Pre-warm backstop** | IG post **confirms** a product match | Fire-and-forget in `productMatchService.js` — post-scale, not catalog-scale |

### Stages (`pipelines/detect.js` → `runCatalogProductPipeline` ~480–640)

Per catalog-product **Media** (source `catalog-product`):

1. **YOLO object detection** — self-hosted microservice via `services/yoloService.js` (`yolo-microservice.onrender.com`) — cheap, fast; catalog path skips dual-engine product identify (metadata is source of truth).
2. **Gemini vision classification** (subjects/text/shot-type chain).
3. **Smart crops + LLM judge.**
4. **Lazy chain (expensive):**
   - **Overlay zones** — `services/overlayZoneService.js` `analyzeOverlayZones` — Gemini-2.5 vision (`GEMINI_VISION_MODEL` / default `gemini-2.5-pro`), ~**13–26s / image**.
   - **Ad-readiness** — `services/adSuitabilityService.js` `scoreMedia`.

### Models & cost

| Step | Model / API | Cost notes |
|---|---|---|
| YOLO | Self-hosted microservice | Cheap / fast |
| Classification / crops / judge | Gemini (+ related vision helpers) | Moderate |
| Overlay zones | Gemini-2.5 vision | **Dominant** — multi-second per image |
| Ad-readiness | Scoring over artifacts | Cheap relative to zones |

### Env knobs

| Var | Default | Role |
|---|---|---|
| `CATALOG_DETECT_PRECOMPUTE` | `false` | If `true`, restore whole-catalog eager detect at sync |

Worker pool concurrency: `WORKER_CONCURRENCY` (`worker.js`, default 4, prod **5** via `defaults.env`) drains DetectRuns.

### Progress / cancel

- **On-demand:** OperationRun kind `detect`, label **`Preparing product imagery`**, cancellable.
- Materialize + enqueue is fast; optional **bounded wait ~4 min** polls hero Media until `latestArtifacts.overlayZones` land (lazy chain finishes *after* DetectRun critical path). Timeout → caller proceeds; render degrades without spatial analysis.
- `detect` ∈ `CANCELLABLE_KINDS`.

### Consumers (why defer, not delete)

| Consumer | Needs |
|---|---|
| **IG→product matching** | **No** — post-driven text overlap on `CatalogProduct` + visual confirm falls back to raw `product.imageUrl` when refined crops are missing |
| `adSuitabilityService` | Overlay / readiness score (catalog UI + Generate Ads picker) |
| `overlayPlacementService` | `product_overlay` text placement/contrast from brightness + density grids |
| `aiCanvasInputBuilder` | `spatial_analysis` block fed to GPT-4.1 layout LLM |

---

## 4. Catalog enrichment (reviews + cross-seller details)

**File:** `services/catalogProductEnrichmentService.js`.

Phase 0 (free, both paths) then two paths split for cost control:

### Phase 0 — on-site reviews + ratings (ALL FOUR INGEST PATHS)

**File:** `services/productReviewsScrapeService.js` — the single review engine.

Runs at the top of `runEnrichment`, so every catalog source gets identical review coverage: all four converge here when their sync completes.

| Ingest path | Entry | On-site reviews |
|---|---|---|
| Shopify auth (Meta/IG catalog) | `catalogSyncService.syncCatalog` | phase 0 only (path never crawls PDPs) |
| Shopify direct | `shopifyPublicIngestService.syncBrandShopifyDirect` | inline “reviews & ratings” stage + phase 0 gap-fill |
| Apify actor | `apifyIngestService.syncBrandShopify` | phase 0 only (actor returns no review data) |
| Generic sitemap | `genericCatalogResolver` → `genericCatalogIngestService` | in-scan (same HTML) + phase 0 gap-fill |

- **Source:** the schema.org review data the store’s review app publishes for Google rich snippets — `Product.aggregateRating` + `review[]`, standalone `Review` nodes, or `itemprop` microdata for the aggregate. **Review-app agnostic**: Bazaarvoice, Judge.me, Yotpo, Okendo, Loox, Stamped, PowerReviews, TurnTo, Reviews.io, Junip, Fera, legacy Shopify Product Reviews. No vendor API keys, no per-app adapters.
- **Captured:** `rating` (rescaled to 0–5 from 5/10/100-point scales), `reviewCount`, and per review: `text`, `title` (reviewer’s headline), `author`, **`rating` (stars)**, `datePublished`, `source` (platform label).
- **Stored:** `CatalogProduct.productReviews` = `{ quotes[], rating, reviewCount, summary, platform, source, quotesFound, fetchedAt }` + top-level `rating`. A `summary` written earlier by the Gemini path is **preserved** across re-scrapes.
- **Ranking:** quotes are ordered positive-first (star verdict → substance → recency) **before** the `PRODUCT_REVIEWS_MAX_QUOTES` cap, so the stored sample is the best of the page, not the first N in document order.
- **Cost:** free — no LLM, no SerpAPI. One `GET` per product page, robots-aware, per-host throttled by `httpScrapeClient`, TTL-gated at `PRODUCT_REVIEWS_TTL_DAYS` (30). A snapshot with no rating **and** no quotes counts as stale so pages are retried later (stores turn rich snippets on).
- **`type` vs `@type`:** nested review nodes in the wild often use a bare `type` key (Bazaarvoice-rendered PDPs do). Every type read goes through `nodeTypes()`, which accepts both — gating on `@type` alone captures **zero** quotes on those pages.
- **Manual re-scrape:** `POST /api/sales-demos/brands/:id/sync-reviews` — `?force=1` ignores the TTL, `?headless=1` enables tier 3, `?pages=N` caps tier-2 pages. Free, so it isn’t behind the Enrich lock.

#### Tier 2 — vendor public APIs, paginated (`services/reviewAdapters/`)

Rich snippets are a *teaser*: Judge.me publishes ~2 of 81 reviews, Bazaarvoice ~6 of 156, and a client-rendered widget publishes none. Tier 2 reads the same public endpoint the store’s own widget reads, keyed by an identifier sitting in the page HTML. No credentials, no vendor accounts. Runs when tier 1 came up short.

| Adapter | Verified live against | Paging | Page cap |
|---|---|---|---|
| `bazaarvoice` | livingspaces.com, deathwishcoffee.com | `Offset`/`Limit` — 0-indexed **record offset** | 100 |
| `judge.me` | beardbrand.com | `page` 1-indexed (returns an **HTML fragment**) | 30, silent clamp |
| `yotpo` | soldejaneiro.com | `page`/`per_page` 1-indexed | 150, silent clamp |
| `okendo` | — | opaque `nextUrl` **cursor** | 100 |
| `stamped` | innosupps.com | `page`/`take` 1-indexed | 100, silent clamp |
| `reviews.io` | boxraw.com | `page` — **0-INDEXED** | — |
| `powerreviews` | ulta.com | `paging.from` record offset | 25 (hard 400) |
| `junip` | hexclad.com | opaque `meta.after` **cursor** | 50 (hard 400) |
| `fera` | thevintagesecret.com.au | `page`/`page_size` 1-indexed | 100, silent clamp |

- **Driver** (`reviewAdapters/index.js`): every request goes through `httpScrapeClient` (per-host throttle, UA rotation, 429/Retry-After), **robots is enforced on the vendor host**, and paging stops on any of: vendor `hasMore:false`, a short page, a page yielding no *new* reviews (protects against a vendor ignoring the page param), page/review caps, HTTP error or rate-limit (partials kept).
- **`discover()` may be async.** Bazaarvoice’s display passkey takes **three hops** (PDP → `deployments/<client>/bv.js` → `legacyScoutUrl` `bvapi.js` → `apiconfig:{passkey}`); resolved keys are cached per client for the process, so a 5000-product sync costs 2 extra requests, not 10 000. PowerReviews probes up to 4 `page_id` candidates because a wrong one returns **200 with `total_results:0`**, not an error.
- **Vendors report failure inside a 200 body** — BV with `Errors[]`, PowerReviews with `status_code:400`. Both map to a driver stop that keeps earlier pages.
- **FAMILY/GROUP ROLLUP** (Bazaarvoice + Junip): both pool reviews across a variant family, so a query for one product returns quotes about siblings (livingspaces.com returned ottoman reviews under a sofa id with identical `TotalResults` for every family member). Exact-product rows win; family rows are used only when nothing matches and are stamped `familyRollup: true`.
- **Not built, deliberately:** **Loox** — `loox.io/robots.txt` disallows `/widget` and `/widgets`, and `publicStoreId` isn’t derivable from PDP HTML. **Shopify legacy Product Reviews** — removed 2023-09-05, backend shut down 2024-05-06; `productreviews.shopifyapps.com` no longer answers TLS.

#### Tier 3 — headless capture, paginated (`services/reviewHeadlessCapture.js`)

For stores with neither snippets nor a readable API. **Opt-in** (`REVIEW_HEADLESS_ENABLED=true` or `?headless=1`) because it costs a browser per product.

- **Response interception, not DOM scraping.** The PDP loads, the widget hydrates, and we read the JSON its own XHRs return — typed ratings, ISO dates, plaintext bodies. The DOM alternative is presentation-only: Bazaarvoice encodes a rating in `<abbr title="4 out of 5 stars">` plus a CSS bucket class, Junip draws five inline SVG stars, and **both render dates as relative strings** (“9 months ago”). Interception is also frame-agnostic for free (`page.on('response')` fires for child frames), so iframe-hosted widgets need no `frames()` walk. DOM scraping remains the fallback when nothing crosses the network boundary.
- **Intercepted payloads are the shapes tier 2 already parses**, so tier 3 calls the matching adapter’s `parse()`/`normalize()` rather than duplicating field maps. Bazaarvoice’s `batch.json` is JSONP-wrapped and nests under `BatchedResults.qN` where **N shifts between requests** — the harvester picks whichever sub-result holds `Results`.
- **Pagination** clicks the widget’s own control and waits for the follow-up XHR. BV advances by the *previous* page’s limit (observed 0 → 10 → 40 → 70 — never `page*size`); Junip walks a cursor 5 at a time. The text-matched control sweep has a **denylist** so it can never click “Write a review” and navigate away mid-capture.
- **Reuses `headlessScrapeService.getBrowser()`** (one pooled Chrome, lazily required so a container without puppeteer degrades to “tier 3 unavailable”).
- **Cost, measured:** ~9–11 s to the first review XHR (storefront + widget bootstrap pulls 200–600 subresources across 40–75 hosts — not tunable by us), then ~1.0–2.5 s per click. ~20–25 s for a 149-review BV product; ~38 s for a 131-review Junip product (5/click). Hence the click cap.
- **Robots:** the merchant’s page is always fetched (same check tier 1 makes) and reading what it renders is fair game; harvesting a *vendor* host’s JSON is gated per host, so a disallowed vendor (Loox) falls through to the DOM read.
- **Sandbox gotcha beyond this feature:** bundled Chromium could not complete **any** outbound TLS behind a TLS-terminating proxy (`ERR_CONNECTION_RESET` even for `https://example.com`) until GREASE Encrypted ClientHello was disabled by policy. If tier 3 fails everywhere in a new image, suspect that before the selectors.

### A. AUTO — reviews-only gap-fill (after sync)

- **Entry:** `enqueueBrandProductEnrichment(brandId)` (post-sync `setImmediate`) → phase 0, then the gap-fill.
- **Gate:** `needsEnrichment(row)` = true only when **no** review signal remains **after phase 0**: no review quotes **and** `rating == null`. Rows are loaded after the scrape so the gate sees fresh state — anything scraped is never billed.
- **Does not** run SerpAPI product-details.
- **OperationRun:** kind `enrichment`, label **`Review gap-fill`**, per-item progress + cancel. Phase 0 opens its own `enrichment` run labelled **`Reviews · <brand>`**.

### B. USER-ACTUATED — full cross-seller + reviews (Enrich button)

- **Entry:** `enrichBrandDetails` via `POST /api/sales-demos/brands/:id/enrich`.
- **Work per product:** SerpAPI `google_shopping` (up to **8** sellers) + Gemini grounded-search review synthesis + SerpAPI `google_immersive_product` specs.
- **Cost:** ~**$0.05–0.12 / product** (cold cache; sibling gtin/mpn hit → $0).
- **OperationRun:** kind `enrichment`, label **`Product enrichment`**. **409** if already running.

### Write-through fix

`services/productDetailsService.js` `writeThroughToCatalogProduct`:

- **`rating`:** gap-fill only when row’s rating is **null** (never clobber on-page AggregateRating).
- **`ratingDistribution` / `reviews` / `specs` / `sellers` / `reviewSummary`:** cross-web data (disjoint from scan) — refresh in place.
- Sets `detailsRefreshedAt`.

**Why the old path was wasteful:** gate field `detailsRefreshedAt` was never written by the scan, so SerpAPI+Gemini details fired for **100%** of products on every first sync even when price/rating/reviews were already on-page.

### Env knobs

| Var | Default | Role |
|---|---|---|
| `CATALOG_ENRICHMENT_CONCURRENCY` | `6` | Parallel enrich workers |
| `CATALOG_ENRICHMENT_MAX_PER_RUN` | `500` | Hard cap per brand run |
| `PRODUCT_REVIEWS_MAX_QUOTES` | `10` | Quotes **stored** per product (ranked positive-first before truncation) |
| `PRODUCT_REVIEWS_TTL_DAYS` | `30` | Re-scrape cadence for on-site reviews |
| `PRODUCT_REVIEWS_CONCURRENCY` | `4` | Parallel PDP fetches in the review sweep |
| `PRODUCT_REVIEWS_MAX_PER_RUN` | `2000` | Products per review sweep |
| `REVIEW_ADAPTERS_ENABLED` | `true` | Kill-switch for tier 2 (set `false` to disable all vendor APIs) |
| `REVIEW_ADAPTER_MAX_PAGES` | `5` | Vendor-API pages per product |
| `REVIEW_ADAPTER_MAX_REVIEWS` | `100` | Reviews read per product across all tiers |
| `REVIEW_ADAPTER_TIMEOUT_MS` | `12000` | Per-request timeout for vendor APIs |
| `REVIEW_HEADLESS_ENABLED` | `false` | Tier 3 master switch (a browser per product) |
| `REVIEW_HEADLESS_MAX_CLICKS` | `6` | Pagination clicks per product |
| `REVIEW_HEADLESS_BUDGET_MS` | `60000` | Hard per-product wall clock for tier 3 |
| `REVIEW_HEADLESS_NAV_TIMEOUT_MS` | `30000` | PDP navigation timeout |
| `REVIEW_HEADLESS_HYDRATE_MS` | `3500` | Settle window after `domcontentloaded` before reading |
| `REVIEW_HEADLESS_CLICK_WAIT_MS` | `12000` | Wait for the XHR a pagination click triggers |

**Blast radius.** A 10 k-product catalog at the defaults is bounded by `PRODUCT_REVIEWS_MAX_PER_RUN` (2000 products/sweep) × `REVIEW_ADAPTER_MAX_PAGES` (5) — and every row is TTL-gated, so a re-sync of an already-scraped brand costs ~0 requests. Tier 3 stays off unless asked for, per brand or per env.

Requires secrets: `SERPAPI_API_KEY`, `GEMINI_API_KEY` (details path no-ops if SerpAPI disabled).

### Progress / cancel

Both paths: kind `enrichment`, cancellable; partials kept. Idempotent via 30-day caches + gtin/mpn sibling dedup in underlying services.

### Consumers

- Catalog UI (sellers table, specs, review summary, rating distribution).
- Ad copy / social-proof templates that pull review quotes and ratings.
- Matching still works without enrichment; enrichment improves merchandising + social-proof creatives.

### Surfacing a POSITIVE review on an ad

`services/layoutInputService.js` `pickStrongestQuote` runs over the 6-tier quote pool (product → category → brand → social comment → LLM → synth):

- When **any** candidate in a tier carries a scraped star rating, candidates the reviewer scored below **`MIN_STARS_FOR_AD` (4)** are dropped, and a small bonus breaks ties in favour of 5-star over 4-star. Tiers with no ratings (comments, LLM-authored) are unaffected and fall through to the lexical scorer as before.
- The lexical `scoreQuote` sentiment gate still applies on top; stars decide *eligibility*, prose decides *which* eligible quote wins.
- `normalizeQuote` carries `rating` + `title` through onto the artifact, so the renderer can draw stars next to the quote and use the reviewer’s own headline.
- Star ratings do **not** exist on Gemini web-wide quotes; those still rely on the lexical gate alone.

---

## 5. Static-image ad generation (THE default ad path)

> **Critical:** the default static ad is **not** a diffusion image model from a text prompt alone.  
> Flow: **GPT-4.1 authors an HTML/CSS layout** → **Puppeteer rasterizes** → (optional) **image model re-renders** that screenshot for a photoreal finish.

### Trigger

- `routes/ads.js` `POST /generate` → **202** + `setImmediate` → `campaignAdsGenerationService.expandWizardJob` → `selectAdsForRun` → `runRenderLoop` (all in the **web** process).
- `CampaignRun` tracks batch status; ad-batch progress via OperationRun kind `ad-batch`.

### Stages

1. **Ensure product imagery** — `ensureDetectForProducts` for campaign products ([§3](#3-per-product-detect--overlay-zones--ad-readiness-deferred-to-ad-time)).
2. **Concept / seed selection** — wizard expansion; when `AI_CONCEPT_DRIVEN=true`, concept-driven V2 path (`aiCreativeDirectorService` / related).
3. **HTML layout (default creative)** — `services/aiCanvasHtmlGeneratorService.js`  
   - `MODEL_ID = 'gpt-4.1'`  
   - Gated by `AI_HTML_LAYOUT_ENABLED`  
   - Templates: `ai_brand_led` / `ai_ugc_led` / `ai_social_proof_led` / `ai_editorial` / `ai_promotional`  
   - Older overlay templates: `product_overlay` / `testimonial_overlay` via `services/overlayPlacementService.js`
4. **Rasterize** — `services/renderService.js` (Puppeteer).
5. **Image-ref photoreal finish** (when `AI_IMAGE_REFERENCE_ENABLED=TRUE`, **on in prod**):  
   - `services/aiImageReferenceService.js`  
   - `AI_IMAGE_REF_MODEL_ID` = **`gpt-image-2`** (prod via defaults)  
   - `AI_IMAGE_REF_QUALITY` = **`high`**  
   - `Campaign.useImageRefAsProduction` (default **true**) swaps it in as production creative via `services/adDisplayUrlService.js`.

**Other image-model uses (not the default full-ad path):**

- Extended-crop outpainting — `services/openaiImageService.js` (`gpt-image-1`, masked) before overlay zones exist.
- Atlas gateway — `services/atlasImageService.js` defaults `openai/gpt-image-1.5` for text-to-image/edit.

### Overlay-zone consumers in this path

| Service | Role |
|---|---|
| `adSuitabilityService` | Ad-readiness score (catalog UI + Generate Ads picker) |
| `overlayPlacementService` | `product_overlay` text placement / contrast from brightness + density grids |
| `aiCanvasInputBuilder` | `spatial_analysis` block for the GPT-4.1 layout LLM |

### Models & cost

| Stage | Model | Notes |
|---|---|---|
| Layout authoring | **GPT-4.1** | HTML/CSS layout spec |
| Raster | Puppeteer | CPU/memory on web process |
| Photoreal finish | **gpt-image-2** (prod) | Quality `high` — main static $ driver when enabled |
| Extended crop / Atlas edit | gpt-image-1 / gpt-image-1.5 | Secondary paths |

### Env knobs

| Var | Default (repo) | Role |
|---|---|---|
| `AI_IMAGE_REFERENCE_ENABLED` | `TRUE` | Enable image-ref re-render |
| `AI_IMAGE_REF_MODEL_ID` | `gpt-image-2` | Image-ref model |
| `AI_IMAGE_REF_QUALITY` | `high` | Image-ref quality |
| `IMAGE_REF_DUMP_SEEDS` | `true` | Diagnostic — uploads every seed PNG; **candidate to turn off** to cut Cloudinary writes |
| `AI_CONCEPT_DRIVEN` | `true` | Concept-driven V2 expansion |
| `AI_HTML_LAYOUT_ENABLED` | `true` | GPT-4.1 HTML layout path |
| `AI_LAYOUT_DIRECT_HTML` | `true` | Direct HTML (JSON-gen retirement path) |
| `RENDER_CONCURRENCY` | `4` | Parallel static renders in `runRenderLoop` |

### Progress / cancel

- OperationRun kinds: `ad-batch` (pool stops claiming; in-flight finish; unclaimed → draft), `ad-regenerate`, `ai-layout` as applicable.
- Cancel semantics: item/pool boundaries via `progressService.checkpoint`.

### Consumers

- `Ad` documents / display URLs → Meta & Google push, previews, campaign UI.
- `Campaign.useImageRefAsProduction` controls whether image-ref or HTML screenshot is production.

---

## 6. Video generation (Veo / Atlas) — deterministic-first

> **Default path:** product campaigns queue **one deterministic video ad per product** (hero seed or operator-ordered catalog stack). The Creative Director no longer drives video by default — it serves **static image ads** and **opt-in video variants** only (backend PRs #11/#12/#13; wizard controls frontend PR #10).

### Trigger

- Wizard / API: `POST /api/ads/preview` (dry-run) or `POST /api/ads/generate` → `campaignAdsGenerationService.expandWizardJob` when resolved kinds include `video` and format flags allow (`AI_VEO_FEED` / `AI_VEO_REELS`).
- Phase-3 body fields (also on preview): `directorVariants`, `seedMediaIds`, `videoPromptGuidance`, `videoPromptRaw` (`routes/ads.js` `parsePhase3WizardFields`).
- Render: `selectAdsForRun` → `runRenderLoop` → `videoRouter` → `atlasVideoService.generateForAd` when `VIDEO_PROVIDER=atlas` (default).

### Expansion routing (`expandWizardJob`)

After kinds are resolved against the platform format and Veo env gates, three independent flags decide which expanders run (`services/campaignAdsGenerationService.js`):

| Flag | Condition | What queues |
|---|---|---|
| **`deterministicVideo`** | `wantsVideo && productIds.length > 0` | **One** video `Ad` per product via `expandDeterministicVideo` |
| **`conceptVideo`** | `wantsVideo && (productIds.length === 0 \|\| directorVariants === true)` | Director video variants (`runConceptDrivenExpansion` with `kinds` including `video`). Brand-only (no products) **always** uses director for video; product campaigns only when the wizard **director toggle** is on (default **off**) |
| **`conceptImage`** | `wantsImage && (AI_CONCEPT_DRIVEN \|\| wantsVideo)` | Director image ads. The `\|\| wantsVideo` clause preserves mixed image+video runs when the concept flag is off so image is not silently dropped |

**Legacy cartesian** (seeds × templates × ratios) is **image-only**: reachable only when the concept/deterministic branches do not run for that run, and **`video` is always stripped** so video never double-queues via cartesian.

Results from deterministic + concept expanders are combined with **`mergeExpansionResults`** (deterministic `newAdIds` / `perProduct` first; `queuedCount` = max of snapshots, not sum). Dry-run returns `byMode: { deterministic, director }` for the wizard preview split.

#### Deterministic video (`expandDeterministicVideo`)

- **Exactly one ad per product** that has a resolvable seed — **no** `VEO_ADS_PER_PRODUCT_CAP` (that cap applies only to concept/legacy video).
- **Seed selection**
  - If the operator passes ordered catalog-product `seedMediaIds`: grouped by `metadata.catalogProductId`, order preserved; **position 0 = primary seed** (`mediaId` + `referenceMediaIds` stack).
  - Else: feed-order **hero** (`imageRole: 'hero'` → earliest `createdAt` → lazy materialize from `product.imageUrl`); empty `referenceMediaIds` so render derives hero + alts.
- **Ad shape:** `renderRoute: 'veo'`, `kind: 'video'`, `template: 'ai_brand_led'`, `conceptId` / `judgeRank` null, `variantKind: 'product_image'`, run-level `videoPromptGuidance` / `videoPromptRaw` stamped when provided.
- **Identity digest:** namespaced **`det-video:v1`** via `computeDeterministicVideoDigest` (campaign, product, ordered ref key or mediaId, platformFormat, CTA fields, guidance/raw). Does not collide with V1 JSON or V2 concept digests.

#### Concept / director path

- Image concepts: still Director + Judge (`aiCreativeDirectorService` / `aiJudgeService`); template label maps from `concept.creative_style`.
- Video concepts: only when `conceptVideo` is true; still capped at `VEO_ADS_PER_PRODUCT_CAP` (default **1**) per product in the concept expander.
- **Director does not drive video titling or the camera prompt** (PR #11). Layout-input / title template for video is **canonical `ai_brand_led`** unless Title Studio overrides cascade (below). `concept.creative_style` is ignored for video titling.

#### Run selection (`selectAdsForRun`)

Tiered drain so the guaranteed baseline videos render before optional variants fill `MAX_CREATIVES_PER_RUN`:

0. **Tier 0 — deterministic videos first:** `status: queued`, `conceptId: null`, `judgeRank: null`, `renderRoute: 'veo'`, FIFO `queuedAt`.
1. **Tier 1 — judged concepts:** `judgeRank != null`, sort `judgeRank` ASC.
2. **Tier 2 — legacy remainder:** other `judgeRank: null` (excluding already-taken det rows), `readinessScore` DESC.

### Cascades (category tier)

Category settings sit **between product and brand**, ordered **leaf → root**, via `categoryChainService.loadCategoryChainForProduct` (breadcrumbKey prefixes).

| Resolver | File | Cascade (most-specific wins) |
|---|---|---|
| `resolveVideoModel` | `atlasVideoService.js` | product `videoSettings.model` / `modelByCanvas` → **category** same → brand same → `ATLAS_VIDEO_MODEL` → built-in Omni default |
| `resolveTitleTemplate` | `atlasVideoService.js` | product `videoSettings.titleTemplate` → **category** → brand → **`ai_brand_led`** (canonical) |
| `resolveSpec` | `titleSpecService.js` | ad `titleStyleSpec[format]` → product → **category** → brand → brand preset → Remotion `canonical` preset |
| `resolvePromptGuidance` | `atlasVideoService.js` | ad `videoPromptGuidance` → product `videoSettings.promptGuidance` → **category** → brand → null (first non-empty; no concatenation) |

**Writable overrides**

| Level | How |
|---|---|
| Brand | `PATCH /api/brand/:id` — `videoSettings`, `titleStyleSpec` (shallow-merge `videoSettings`) |
| Category | `PATCH /api/catalog/categories/:id` — `videoSettings`, `titleStyleSpec` only |
| Product | `PATCH /api/catalog/:id` — `videoSettings` (and product title fields as elsewhere) |
| Ad | `Ad.titleStyleSpec`, `Ad.videoPromptGuidance`, `Ad.videoPromptRaw` (run stamp or per-ad later) |

`videoSettings` may include: `model`, `modelByCanvas`, `referenceImageCount`, `titleTemplate`, `promptGuidance`, `titlingEngine`, `titlePlacementMode` (validated by `validateVideoSettings`).

### Per-run / per-level video prompt

| Field | Semantics |
|---|---|
| **`videoPromptGuidance`** | Short operator note (≤1000 chars). Merged as **`operatorPrompt` prepend** inside `buildVeoPrompt` via the guidance cascade above. |
| **`videoPromptRaw`** | Full prompt replacement (≤4000 chars body validation). **Bypasses** `buildVeoPrompt`; clamped with `enforceRawByteCap` to the model’s `promptByteCap`. |

**`generateForAd` priority** (`atlasVideoService.js`):

1. Explicit **`operatorPrompt`** argument (regenerate UI) — non-empty after trim → `buildVeoPrompt({ operatorPrompt })`.
2. Else **`ad.videoPromptRaw`** — full replace + byte cap.
3. Else guidance cascade → `buildVeoPrompt({ operatorPrompt: effectiveGuidance })`.

**Wizard Advanced editor feed:** `GET /api/ads/veo-prompt-scaffold?campaignId=&productId?&platformFormat?&durationSec?` → `buildPromptScaffold` returns `{ prompt, model, aspectRatio, durationSec, byteCap }` (canonical prompt; `media=null`; placeholder product title when no product).

### Reference stack + reframe

`buildReferenceImages` (`atlasVideoService.js`):

- When **`Ad.referenceMediaIds` is non-empty:** load Media in **exact pick order** as `orderedReferenceMedia` (position **0 = seed**); skip default seed+catalog assembly.
- When empty: seed (`ad.mediaId`) first, then catalog-product medias (createdAt asc ≈ hero-first), then product URL fallbacks; count from `resolveReferenceImageCount` (product → brand → env → default **3**), capped by model `maxReferenceImages`.
- Every ref is still **generatively reframed / outpainted** to the target aspect via `reframeReferenceForAspect` — **video reference images only**, the static-ad image path is untouched: cached on `Media.metadata.reframes`, single-flight + fresh-DB re-read, kill-switch `REFRAME_ENABLED`; failure degrades to Cloudinary crop.

**Reframe ladder** (`reframeReferenceForAspect`, ported from ReachSocialLLMExpander `runSafeZoneReframe`; replaces a prior unmasked-whole-image edit that had no subject-preservation clause and produced visible artifacts — warped logos, mangled label text, drifted product shape). Persisted entries carry `ladderVersion: 'uncrop-v1'`:

1. **Guards** — kill-switch / Atlas unconfigured / no source → crop, no spend. Persistent cache hit on `Media.metadata.reframes[aspectKey]` → return, no spend. In-process single-flight collapses concurrent callers for the same media+aspect (product fan-out shares reference medias across ads). Fresh DB re-read closes the post-settle window where a sibling worker persisted this aspect after the lean doc was loaded.
2. **Exact-fit skip** — source aspect already within `REFRAME_SKIP_THRESHOLD` of target → Cloudinary crop, persisted as `method: 'exact'`, no spend.
3. **Product-only $0 pad (new, tier 5b)** — `Media.classification.shotType === 'product_only'` → deterministic pad, **before any billable POST**. See "Product-only routing" below for the full rationale. Persisted as `method: 'pad-product-only'`. Any failure here falls through to step 4 rather than returning a crop.
4. **Normalize source** (conditional) — download (timeout + byte cap + content-type check) → sharp `.rotate()` (EXIF auto-orient) → `.flatten({ background: '#ffffff' })` (white-flatten so transparent PNGs aren't matted black by the model) → resize to max 2048px wide → JPEG q88 → re-host on Cloudinary, but **only when the source carries alpha or an EXIF rotation** — otherwise the original bytes are forwarded untouched. Normalize failure → crop, **no spend** — an un-normalized source is the artifact-prone path this ladder replaces.
5. **Outpaint** — single billable POST to `REFRAME_OUTPAINT_MODEL` at `REFRAME_RESOLUTION` (default `4k`). Prompt selected by `REFRAME_PROMPT_STYLE` (default `reframe`; anything unrecognised falls back to it): `reframe` is the conservative extension instruction; `uncrop` is the verbatim "Expand and uncrop…" spec — better at revealing scene on cropped lifestyle frames, but its "continue the subject (reveal more of the body/product/clothing)" clause is the exact mechanism behind the fabrication findings below, so it isn't the default.
6. **Validate output** — byte floor (512B) + aspect ratio within `REFRAME_RATIO_TOLERANCE` of target (ratio only — pixel size is never compared). Rejected → falls through to the pad.
7. **Pad fallback** — $0 deterministic letterbox from the normalized source. Prefers a sampled **solid** fill (`detectBorderFill`, same check as step 3) when the extended edges are flat and agree with each other; falls back to the blurred cover (scaled-to-cover + `.blur(24)`) only when the background genuinely has content — on a uniform studio background the blur smears product colour and hair into the bands. Persisted as `method: 'pad-fallback'`.
8. **Cleanup** — the normalized-source Cloudinary mirror (if one was made) is deleted once the prediction reaches a terminal state (best-effort, never throws), so a reframe no longer leaks a permanent Cloudinary asset.

A persisted entry's `method` is one of `'exact' | 'pad-product-only' | 'outpaint' | 'pad-fallback' | 'crop-after-bill'`.

**Product-only routing — why generative outpaint is banned on these shots:** Measured on 20 live generations across 8 real catalogue images (2026-07-24): no Atlas model exposes a mask or pixel-passthrough (0 of 437 catalog models), so the whole canvas is re-synthesised on every outpaint call. On flat-lay/studio product shots that doesn't just add artifacts — it **fabricates merchandise**: a pair of PELAGIC shorts came back as full-length trousers, a waistband crop came back as an invented whole garment with the "PELAGIC HIGH PERFORMANCE" lockup reduced to illegible marks, and an embroidered Soludos espadrille came back with a different arrangement of fruits than the shoe actually being sold. That is product misrepresentation, not an aesthetic artifact — **do not simplify this routing away** on the assumption it's just extra caution. A deterministic `c_pad` scales-to-fit and never redraws a pixel, so the product ships exactly as photographed, for $0.

Routing is on `isProductOnlyShot` (`Media.classification.shotType === 'product_only'`) — LLM-judged, so a hint, not a guarantee. The asymmetry favours trusting it anyway: a false positive costs only a letterbox with the product intact, while a false negative risks invented product. Gated by `REFRAME_PRODUCT_ONLY_PAD` (default on).

`detectBorderFill` samples only the edges the padding will actually add (a 1:1 source going to 9:16 gains height, so left/right never matter) on a ~5KB Cloudinary derivative (`fetchBorderSample`). Edges that are each flat AND agree with each other → exact `b_rgb:<hex>` match; otherwise `b_auto:predominant_gradient`, which Cloudinary derives from the border server-side and is the always-available soft option on this plan (`b_blurred` needs an add-on this account doesn't have — see `services/extendedCropsService.js`). Measured against real imagery: studio white = stddev 0.0, a lifestyle frame = 27–39; threshold is `REFRAME_BORDER_STD_MAX` (default `8`). Both transforms were confirmed returning HTTP 200 at exactly 720×1280; `b_blurred` still 400s on this plan — the control that proves the check detects add-on gating, not a false negative.

Non-Cloudinary sources can't be transformed by URL, so they pad locally via `padSolidBuffer` + upload instead — still zero model spend.

**`billed` invariant (money-critical):** flips true the instant `pollPrediction` resolves — Atlas bills on terminal-ok — and is never cleared afterward, so `recordFlatCost` fires on **every** subsequent path, including a rejected output that falls through to the pad. This closes a pre-existing ledger gap where a Cloudinary upload failure after a successful generation skipped the cost record entirely. The product-only pad (step 3) returns before any POST, so it never touches `billed` or the ledger.

**Known tradeoff:** a persisted `pad-fallback` or `pad-product-only` entry is a permanent cache hit — a single transient Atlas failure, or a wrong `shotType` classification, locks that image+aspect to a letterbox until the entry is invalidated (`ladderVersion` makes targeted invalidation possible).

### Titling composite

- Downstream of base video: `brandScriptExecutor` + Remotion (default) or canvas override.
- Title template for layoutInput derivation is **canonical `ai_brand_led`** unless cascaded `titleTemplate` override.
- Placement mode / engine: see `docs/TITLING.md` (`titlePlacementMode`, `titleStyleSpec` cascade including category).
- **Does not use overlay zones** — text is scripted, not zone-driven product overlay.

### Wizard controls (frontend PR #10; backend contract)

| Control | Backend field | Default / notes |
|---|---|---|
| Director toggle | `directorVariants` | **Off** — product runs get det video only; on → also queues concept video (capped) |
| Ordered catalog seed picker | `seedMediaIds` | Order-significant; empty → hero default |
| Guidance / raw Advanced editor | `videoPromptGuidance` / `videoPromptRaw` | Scaffold from `GET /api/ads/veo-prompt-scaffold` |
| Preview counts | `POST /api/ads/preview` `dryRun` | Response includes `byMode: { deterministic, director }` |

### Stages / files

| Piece | File | Role |
|---|---|---|
| Expansion + det digest + merge + selection | `services/campaignAdsGenerationService.js` | Routing, `expandDeterministicVideo`, `selectAdsForRun` |
| Category chain | `services/categoryChainService.js` | Leaf→root Category docs for cascades |
| Atlas submit/poll + refs + model/prompt resolve | `services/atlasVideoService.js` | `generateForAd`, `buildReferenceImages`, resolvers, scaffold |
| Camera prompt builder | `services/veoPromptBuilder.js` | `buildVeoPrompt`, `enforceRawByteCap` |
| Title style cascade | `services/titleSpecService.js` | `resolveSpec` (ad > product > category > brand) |
| Brand title/script composite | `services/brandScriptExecutor.js` | Titling over base video |
| Provider router | `services/videoRouter.js` | `VIDEO_PROVIDER` → atlas / vertex |
| Storyboard text (Vertex / legacy) | `services/veoStoryboardService.js` | GPT storyboard when that path uses it; **Atlas path retired storyboard** (Ken Burns prompt is complete) |
| Direct Veo fallback (deprecated) | `services/aiVideoReferenceService.js` | `VIDEO_PROVIDER=vertex` |

### Models & cost

- Atlas image-to-video (default Gemini Omni; Grok / Veo slugs in `MODEL_CAPS`) — rate-limited; **429s if concurrency > 1**.
- Per-ref generative reframe (nano-banana-2 class edit when enabled) — ladder is exact-fit skip → product-only $0 pad → outpaint → $0 pad fallback; outpaint billed at `REFRAME_COST_USD` per image (default `$0.08` @ `4k`), cached per media+aspect on first success. Product-only shots (`Media.classification.shotType`) never reach the billable POST.
- LayoutInput derivation (Gemini / existing builder) when artifact missing — non-fatal.
- GPT storyboard only on non-Atlas paths that still call it.

### Env knobs

| Var | Default | Role |
|---|---|---|
| `VIDEO_PROVIDER` | `atlas` | `atlas` \| `vertex` |
| `AI_VEO_FEED` | `true` | Enable video for non-Reels formats |
| `AI_VEO_REELS` | `true` | Enable video for 9:16 Reels |
| `VEO_CONCURRENCY` | **`1`** | **Keep at 1** — provider 429s above this |
| `VEO_ADS_PER_PRODUCT_CAP` | `1` | Cap on **concept** video variants only (not deterministic) |
| `VEO_USE_GPT_STORYBOARD` | `true` | Storyboard on paths that still use it (not Atlas Ken Burns) |
| `ATLAS_VIDEO_FORCE_CHROME` | `true` | Force chrome handling on Atlas path |
| `ATLAS_POLL_INTERVAL_MS` | `15000` (`defaults.env`; code fallback `5000`) | Prediction poll interval |
| `ATLAS_VIDEO_MODEL` | (empty) | Optional model override in resolve chain |
| `REFRAME_ENABLED` | `true` | Master switch for generative reframe of video reference images; `false` → Cloudinary crop only |
| `REFRAME_OUTPAINT_MODEL` | `google/nano-banana-2/edit-developer` | Atlas image-edit model for outpaint (billable per image, single submit; `-developer` is a half-price billing variant, not a lower-fidelity tier) |
| `REFRAME_RESOLUTION` | `4k` | Outpaint output resolution (`1k`\|`2k`\|`4k`). `4k` per operator decision (2026-07-24) after reviewing 20 live generations side by side — held product geometry better than `1k`; the reframed reference is also surfaced at full size in the generation inspector. The render itself stays 720p (`ATLAS_VIDEO_RESOLUTION`) |
| `REFRAME_PROMPT_STYLE` | `reframe` | `reframe` (conservative, default) \| `uncrop` (scene-revealing, riskier on product-only imagery — see reframe ladder step 5); unrecognised values fall back to `reframe` |
| `REFRAME_SKIP_THRESHOLD` | `0.985` | Skip outpaint when source aspect is within this ratio of target (0–1) |
| `REFRAME_COST_USD` | `0.08` | Per-image outpaint price recorded in the cost ledger (observability only, not a spend gate). `0.08` reflects `-developer` @ `4k`; readme documents "4K costs 2x" but not whether that stacks on the discounted `-developer` base, so this deliberately errs high |
| `REFRAME_RATIO_TOLERANCE` | `0.05` | Relative ratio tolerance when validating outpaint output (ratio only, never pixel size) |
| `REFRAME_MAX_SOURCE_BYTES` | `52428800` (50 MiB) | Max bytes for source / outpaint downloads |
| `REFRAME_PRODUCT_ONLY_PAD` | `true` | Route `product_only`-classified shots to the deterministic $0 pad instead of the billable outpaint (see "Product-only routing" above); `false` accepts the merchandise-fabrication risk |
| `REFRAME_BORDER_STD_MAX` | `8` | Max per-channel stddev on an extended edge to treat the background as flat/uniform and match it with a solid fill (studio white measures `0.0`; lifestyle frames measured `27`–`39`) |

Secret: `ATLAS_API_KEY`.

### Progress / cancel

- Kind `veo-video` / regenerate stages; poll accepts `shouldCancel` (stops waiting; provider job may still finish server-side). See `docs/PROGRESS.md`.

### Consumers

- Video `Ad` assets, Meta Reels / feed push, retitle batch (`POST /api/brand/:id/retitle-videos` — see `docs/TITLING.md`), generation inspector (`veoPrompt`, `veoReferenceImages`, `referenceMediaIds`).

---

## 7. Progress + activity system

### Core

- **Model:** `models/OperationRun.js` — tenant-scoped runs (kind, status, stage, note, pct/items, heartbeat, cancel).
- **Service:** `services/progressService.js`
  - Lifecycle: `startRun` → `stage` / `tick` / `note` / `checkpoint` → `succeed` / `fail` / `markCancelled`
  - Throttled writes ~**1/s**; heartbeat **30s**; stale reaper **2 min** (`STALE_HEARTBEAT_MS`); max run **4h** (`MAX_RUN_MS`)
  - `startRun` never throws into business code (no-op handle on failure)
  - `checkpoint()` throws `CancelledError` at safe boundaries when cancel requested

### Cancellable kinds

From `CANCELLABLE_KINDS` in `progressService.js`:

`social-ingest`, `catalog-sync`, `demo-sync`, `enrichment`, `font-ingest`, `campaign-sync`, `scheduled-sync`, `ad-batch`, `ad-regenerate`, `veo-video`, `ai-layout`, `detect`

### Surfaces

| Surface | Location |
|---|---|
| Global activity dock | Frontend `src/shell/ActivityBar.tsx` (separate **liquidretail** repo, `frontend/app/`) |
| Per-brand SyncProgress | Sales Demos page |
| Cross-brand Activity log | `GET /api/sales-demos/activity` → active + recent runs (`routes/salesDemos.js`) |
| Progress API | `routes/progress.js` — `GET /api/progress/active`, `GET /:runId`, `POST /:runId/cancel` |

Deeper instrumentation notes: `docs/PROGRESS.md`.

### Scheduler

- `services/scheduledSyncService.js` — **60s** `setInterval`, per-brand catalog/posts cadence; labels spawned syncs `(scheduled)`; kind `scheduled-sync`.

---

## 8. Concurrency knobs

| Knob | Default | Prod / notes |
|---|---|---|
| `WORKER_CONCURRENCY` | 4 (`worker.js` fallback) | **5** in `defaults.env` — DetectRun / job poll workers |
| `RENDER_CONCURRENCY` | 4 | Static ad Puppeteer pool (`routes/ads.js`) |
| `VEO_CONCURRENCY` | **1** | **Do not raise** — provider 429s at >1 |
| `CATALOG_ENRICHMENT_CONCURRENCY` | 6 | Enrich auto + full path |
| `GENERIC_CATALOG_PDP_CONCURRENCY` | 5 | Parallel PDP fetches (no crawl-delay) |
| Category inference concurrency | **6** | Hardcoded in post-sync call; per-domain throttled |
| `HTTP_SCRAPE_DOMAIN_CONCURRENCY` | 3 | In-flight HTTP per host |

Video and static image runs share `runRenderLoop` but pick concurrency by run type (`isVeoRun` → `VEO_CONCURRENCY`, else `RENDER_CONCURRENCY`).

---

## 9. Configuration & secrets

### Non-secret config — `config/defaults.env`

Versioned with the repo. Loaded in `index.js` / `worker.js` **after** the process environment so **env always wins** (Render dashboard or local `.env` can override without editing the file).

**Categories in `defaults.env`:**

| Category | Examples |
|---|---|
| AI creative feature flags | `AI_CONCEPT_DRIVEN`, `AI_HTML_LAYOUT_ENABLED`, `AI_LAYOUT_DIRECT_HTML`, `CANONICAL_DR_V1`, `RENDER_USE_HTML`, `RENDER_USE_RESOLVED` |
| Static image-ref path | `AI_IMAGE_REFERENCE_ENABLED`, `AI_IMAGE_REF_MODEL_ID`, `AI_IMAGE_REF_QUALITY`, `IMAGE_REF_DUMP_SEEDS` |
| Video (Veo / Atlas) | `AI_VEO_FEED`, `AI_VEO_REELS`, `AI_VIDEO_POSTER_ENABLED`, `VIDEO_PROVIDER`, `VEO_USE_GPT_STORYBOARD`, `ATLAS_*`, `VEO_CONCURRENCY` |
| Concurrency | `WORKER_CONCURRENCY`, `RENDER_CONCURRENCY`, `VEO_CONCURRENCY` |
| Ingest tuning | `APIFY_*`, `POST_FETCH_LIMIT`, `CATALOG_SYNC_MAX_ITEMS`, `CATALOG_VISUAL_MATCH_MAX_IMAGES` |
| Generic catalog scraper | `GENERIC_CATALOG_*`, `HTTP_SCRAPE_MIN_GAP_MS` |
| Catalog detect / enrichment | `CATALOG_DETECT_PRECOMPUTE`, `CATALOG_ENRICHMENT_*` |
| Public IDs / URLs | Cloudinary cloud name, frontend URLs, Google/Meta client IDs & redirect URIs, Jira base/email, sales-demo admins, Shopify store domain |

**Never put secrets in this file** — it is committed to git.

### Secrets — Render env only

| Secret | Used for |
|---|---|
| `APIFY_TOKEN` | Apify actors (IG / Shopify scrapers) |
| `ATLAS_API_KEY` | Atlas video / image / LLM gateway |
| `BRANDFETCH_API_KEY` | Brand enrichment |
| `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | Media storage |
| `GEMINI_API_KEY` | Vision, grounded search, overlay zones |
| `GOOGLE_CLIENT_SECRET` | Google OAuth (app login) |
| `GOOGLE_ADS_CLIENT_SECRET` / `GOOGLE_ADS_DEVELOPER_TOKEN` | Google Ads integration |
| `INTEGRATION_ENCRYPTION_KEY` | Encrypted integration credentials at rest |
| `JIRA_API_TOKEN` | Jira integration |
| `JWT_SECRET` | Auth tokens |
| `META_APP_SECRET` | Meta / Instagram OAuth & webhooks |
| `MONGODB_URI` | Database |
| `OPENAI_API_KEY` | GPT / image models (direct OpenAI paths) |
| `RENDER_AUTH_TOKEN` | Render-protected service auth |
| `SERPAPI_API_KEY` | Shopping / immersive product enrichment |
| `SESSION_SECRET` | Session cookies |
| `SHOPIFY_ACCESS_TOKEN` / `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` | Shopify API |

---

## Quick map: file → pipeline

| Concern | Primary files |
|---|---|
| Generic catalog resolve/save | `services/genericCatalogResolver.js`, `genericCatalogIngestService.js`, `httpScrapeClient.js`, `breadcrumbParser.js` |
| Post-sync trio | `genericCatalogIngestService.js` (end-of-run), `catalogProductDetectService.js`, `catalogProductEnrichmentService.js`, `productCategoryInferenceService.js` |
| Detect / overlay / readiness | `pipelines/detect.js`, `yoloService.js`, `overlayZoneService.js`, `adSuitabilityService.js`, `worker.js` |
| Enrichment | `catalogProductEnrichmentService.js`, `productDetailsService.js` |
| Static ads | `routes/ads.js`, `campaignAdsGenerationService.js`, `aiCanvasHtmlGeneratorService.js`, `renderService.js`, `aiImageReferenceService.js`, `overlayPlacementService.js`, `aiCanvasInputBuilder.js` |
| Video (deterministic-first + director opt-in) | `campaignAdsGenerationService.js` (expand/select), `atlasVideoService.js`, `veoPromptBuilder.js`, `categoryChainService.js`, `titleSpecService.js`, `brandScriptExecutor.js`, `videoRouter.js`, `routes/ads.js` (`/preview`, `/generate`, `/veo-prompt-scaffold`), `routes/catalog.js` (`PATCH .../categories/:id`) |
| Progress | `progressService.js`, `models/OperationRun.js`, `routes/progress.js`, `routes/salesDemos.js` (`/activity`) |
| Config | `config/defaults.env`, `index.js`, `worker.js` |

Related docs: `docs/PROGRESS.md` (progress/cancel details), `docs/ai-creative-pipeline.md` (creative depth), `docs/ATLAS.md` (Atlas migration), `docs/TITLING.md` (video titling engine).
