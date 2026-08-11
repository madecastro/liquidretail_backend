# LiquidRetail Backend — Background & Creative Pipelines

This is the engineer reference for every background and creative pipeline in the LiquidRetail backend (Node/Express + Mongoose). For each pipeline: what triggers it, its stages, which models/APIs it calls (and rough cost), which env knobs tune it, how progress/cancel works, and what consumes its output. Facts are code-verified as of **2026-08-03** (prod `13cf679`) with **Phase A + Phase B PMax (2026-08-10/11)** documented against branch `feat/pmax-surfaces-phase-a2`, plus a **post-Phase-B addendum** (video cost reconciliation + adversarial corrections; offline suite **78** scripts green). Prefer this doc over tribal memory; when in doubt, open the cited files. Claims written against pre-`13cf679` binaries (including the long-running `a80ae0b` prod window) are suspect.

> **Cost hot-spots (read first)**
>
> | Hot-spot | When it fires | Rough cost | Mitigation (current default) |
> |---|---|---|---|
> | **Overlay zones** (`overlayZoneService.analyzeOverlayZones`, Gemini-2.5 vision) | Per catalog-product image after detect | ~**13–26s / image** Gemini vision | **Deferred** to ad time (`CATALOG_DETECT_PRECOMPUTE=false`); only products a campaign will use |
> | **User-actuated product enrichment** (SerpAPI shopping + immersive + Gemini grounded-search) | Sales Demos **Enrich** button | ~**$0.05–0.12 / product** | Opt-in only; auto path is reviews gap-fill |
> | **Static ad plate** (`openai/gpt-image-2/edit` via `directImageRenderService`) | Every static `ai_*` ad (default pipeline) | Dominant static-ad $ | One billable edit submit per ad; stages on poll ticks (`ATLAS_IMAGE_POLL_MS` 3s). **Was falsely documented** as "GPT-4.1 HTML → Puppeteer → gpt-image-2 photoreal polish" — that chain is **not** the live default |
> | **Omni / Atlas video** (legacy name `veo`) | Video ad generation | **MEASURED** 10s @ 1080p on the **developer** model (`google/gemini-omni-flash/image-to-video-developer`, production default): **$0.90** settled. The `MODEL_CAPS` formula (`base 0.20 + 0.10/s` → $1.20 @ 10s) **overstates** the developer variant by ~33% — do not quote $1.20 for it. Ledger now **reconciles** settled price (was estimate-forever — see [*Video cost reconciliation*](#video-cost-reconciliation-post-phase-b)). 720p same list tier as 1080p. | `VEO_CONCURRENCY=4` (self-imposed probe 2026-08-02; Omni RPS unpublished). **Was falsely documented** as "must stay at 1 — provider 429s"; that belonged to retired direct-Veo / Grok 1 RPS, not Omni. Re-measure before raising past 4 |
> | **Catalog scan (sitemap + JSON-LD)** | Demo / catalog sync | Deterministic HTTP only — **no LLM** | Caps + per-host min-gap; bounded PDP concurrency |

Non-secret defaults live in `config/defaults.env` (versioned). The Render dashboard holds **secrets only** (plus one deliberate non-secret exception, `JIRA_PROJECT_KEY`) — migration complete 2026-08-03; see [§9](#9-configuration--secrets) and CLAUDE.md §4a.

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
| **Media-only backfill** | `GET /api/catalog/:id` | `materializeMissingHero` + `materializeMissingAlts` — Cloudinary mirror + `Media` doc, **no DetectRun, no vision spend** |

#### `imageMediaId` means "a hero Media exists", NOT "detect ran"

These are separate facts and the code must not conflate them — doing so caused a
production bug where the Step 2 picker's **PRIMARY** tile was permanently greyed
out captioned "image still processing" for a catalog ingested weeks earlier.

- The picker greys any tile whose `imageMediaId` is falsy. With detect deferred,
  **no ingest path** materializes the hero at sync time, and the on-demand pull
  runs *after* the picker renders — so the pointer stayed null with nothing
  queued. Alts escaped only because the detail endpoint already backfilled them.
- `enqueueProductDetect` persists pointers from **materialize** results
  (`heroMediaId` / `altMediaIds`), never from `enqueued.hero` — the latter also
  requires DetectRun creation, which `createDetectRunIfAbsent` declines on an
  E11000-with-no-in-flight-run race. It persists only what it resolved, so a
  failure never writes `null` over the detail endpoint's success.
- `enqueued.hero` still means "a run was queued" and remains the basis of the
  `heroEnqueued` counter.
- **`ensureDetectForProducts` gates on the DetectRun, not the pointer.** A
  pointer-only product (lazy backfill) routes to
  `ensureDetectRunsForExistingMedia` — runs only, deriving and persisting
  nothing. Routing it through `enqueueProductDetect` instead would rewrite
  `additionalImageMediaIds` as a **compact** array, while
  `materializeMissingAlts` maintains an **index-aligned** one; the detail
  response, alt crop galleries and operator exclusion pairings all zip by index,
  so compacting silently mis-pairs every alt.

Fence: `scripts/verifyCatalogHeroMaterialize.js` (65 checks, offline).

### Default reference stacks — ENV-configurable (video and static, independently)

`services/referenceDefaultsService.js`. Owner requirement (2026-08-05): video
defaults to **the first, second and third catalog images as downloaded from the
site / Shopify feed**, with the count and the type settable outside the Render
dashboard.

| var | default | effect |
|---|---|---|
| `VIDEO_DEFAULT_REFERENCE_COUNT` | `3` | Floor of the video count cascade (product → brand → `ATLAS_REFERENCE_IMAGE_COUNT` → this → 3). Bounded by `MAX_REFERENCE_IMAGE_COUNT` (7). |
| `IMAGE_DEFAULT_REFERENCE_COUNT` | `1` | Step 2 image-queue pre-pick size. Was hardcoded in the frontend. |
| `VIDEO_DEFAULT_REFERENCE_SHOT_TYPES` | *(empty)* | Ordered shot-type **preference**. Empty = pure feed order. |
| `IMAGE_DEFAULT_REFERENCE_SHOT_TYPES` | *(empty)* | Same, static rail. |
| `VIDEO_SEED_FEED_ORDER` | `true` | Pre-existing; was reachable only via the dashboard. |
| `VIDEO_SEED_MAX_SUBJECT_FRACTION` | `0.6` | Pre-existing; same. |

**There is no default shot type, by design.** Both preference vars ship empty and
empty is a strict no-op. The dial is opt-in.

**It is a preference, never a filter.** `classification.shotType` is written by
the deferred detect pass, so a freshly ingested product has none — a filter would
empty the stack for exactly the newest products. Matching media sort forward in
list order; everything else, including all unclassified media, keeps feed order
behind them, and nothing is dropped. A configured preference is simply inert
until detect has run.

**Rails are independent.** Separate vars. Deriving the static count from the
video count is a known past bug — a non-empty `mediaIds` sets
`universeTopN = max(mediaIds.length, DIRECTOR_UNIVERSE_TOP_N)`, so a 3-seed video
default silently produced a 3-image static universe where hero-only was intended.

**Scope, stated honestly:**
- The video preference applies to the picker pre-pick **and** to
  `buildReferenceImages`' auto-assembly. It does **not** move the seed at
  position 0, and it never reorders an explicit operator pick list.
- The static policy governs the **picker pre-pick** (those picks POST as
  `mediaIds` and drive the run). It does **not** change the backend's
  empty-`mediaIds` fallback, which remains the shotType-ranked universe trimmed
  to `DIRECTOR_UNIVERSE_TOP_N`. An API caller sending no `mediaIds` is unaffected.
- The picker needs per-image shot types to honour a preference at all (its
  explicit picks suppress the backend's assembly), so `GET /api/catalog/:id`
  returns `imageShotType` + `additionalImageShotTypes`, index-aligned with
  `imageUrl` / `additionalImages` and hole-preserving. Best-effort: a failed
  lookup degrades to nulls rather than 500ing product detail.
- A **SOURCE** dial (catalog / catalog_then_ugc / any) was drafted and **cut
  before shipping** — it was dead in every wired path, and a config var that
  silently does nothing gets trusted later. The fence asserts its absence.

Fence: `scripts/verifyReferenceDefaults.js` (43 checks, offline).

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

> **Full vendor reference — endpoints, credentials, paging models, robots policies, rating filters, rate limits, and how to add an adapter: [`docs/REVIEW_VENDORS.md`](./REVIEW_VENDORS.md).**

- **Driver** (`reviewAdapters/index.js`): every request goes through `httpScrapeClient` (per-host throttle, UA rotation, 429/Retry-After), and paging stops on any of: vendor `hasMore:false`, a short page, a page yielding no *new* reviews (protects against a vendor ignoring the page param), page/review caps, HTTP error or rate-limit (partials kept).
- **Robots is OFF by default, system-wide** (`httpScrapeClient.respectsRobots()`): all scraping — catalog, reviews, lifestyle imagery, enrichment — runs under client authorisation, and the client warrants rights to the content used in their ads. `RESPECT_ROBOTS=true` restores it globally, `REVIEW_RESPECT_ROBOTS=true` for reviews only. **Throttling and `Crawl-delay` are kept regardless.** Note the asymmetry a flag can't fix: a client can authorise *their* storefront, but `loox.io`/`api.bazaarvoice.com`/`judge.me` are third-party infrastructure they cannot consent for — hence Loox stays tier-1/3 only.
- **4★+ escalation under throttling.** On a 429, an adapter that can express `>=4 stars` **server-side in one request** switches the floor on and **retries the same page** rather than stopping — a throttled budget shouldn't be spent on reviews we'd never quote. **Only `bazaarvoice` qualifies** (`Filter=Rating:gte:4`); Yotpo can only filter by exact star (two requests, no saving), REVIEWS.io's `minRating` is undocumented on the path we call, and six vendors have no filter at all. `result.ratingFiltered` records the floor. **The aggregate is never read from a filtered response** — storing "4.9 from 83" for a 3.8-from-156 product is worse than storing no rating.
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

`services/layoutInputService.js` builds a 6-tier quote pool (product → category → brand → social comment → LLM → synth) and picks via `pickStrongestQuote`. **Provenance is the first gate**, not an afterthought.

**Print gate (single definition):** `services/quoteProvenance.js` `toPrintableCustomerQuote()`. ALLOWLIST only — deciding by what a quote is *not* was the bug shape this replaces. Printable origins:

| `origin` | Prints? | Attribution |
|---|---|---|
| `scraped` | yes | byline kept |
| `social_comment` | yes | byline kept |
| `store-import` | yes | byline kept |
| **`llm-web`** | **yes (TEXT ONLY)** | **byline fields + `source` + `verified` structurally `delete`d** — callers MUST use the **return value**, not the input object |
| `synthesized` | **no** | rejected (producer deleted) |
| `unknown` / unstamped | **no** | rejected by omission |

**`llm-web` is PRINTABLE.** That is a deliberate reversal of older docs that treated it as fabricated. Verified: `geminiSearchProvider.js` uses `tools:[{google_search:{}}]` (real grounded search) and records `groundingMetadata.groundingChunks` domains — Gemini is the **retrieval** mechanism, not the author. What *was* broken was attribution: bylines like `Reddit (r/BuyItForLife)` and — 80 times — `vertexaisearch.cloud.google.com` (Google’s grounding-redirect hostname printed as the customer). Strip attribution; keep the words.

**`verbatim:false` is not a blanket fidelity confession.** On first-party origins it still hard-rejects. On `llm-web` it is a **source-class stamp** (“not a first-party scrape”) set blanket by the producer (`geminiSearchProvider`); the gate ignores `verbatim` for anonymous-print origins so ~82% of the pool is not re-excluded. See the header comment in `quoteProvenance.js:106-118`.

**Where the gate runs:**

1. **At pool assembly** in `layoutInputService` (`printableOnly` → `toPrintableCustomerQuote` before rating/lexical pick) so `primary_quote` / `secondary_quotes` are clean for every consumer of the artifact.
2. **At video titling** in `brandScriptExecutor.buildMetaForAd` via `gateLayoutInputQuotes` — reuses the **same** predicate. **Was false:** static dual-gated, video did not; a `LayoutInputArtifact` cached before the provenance fix could burn a fabricated claim into Remotion chrome.

**Also still true:**

- One star threshold, **`QUOTE_MIN_RATING` (4.35 as of 2026-08-04, env-tunable in `config/defaults.env`)**, via `gateQuotesByRating` + re-apply in `pickStrongestQuote`. It is deliberately LOWER than the star floor's 4.39 because this gate reads the RAW rating while the star gate reads the rounded display value — a raw 4.37 displays as 4.4, so both must admit it.
- Ratings normalized to 5-point scale before every comparison.
- Product tier reads `productReviewsOf(match)` (seed pick then hydrated top-level).
- Lexical `scoreQuote` on top of stars.
- `isFirstPartyQuote()` (`layoutInputService.js:1559`) is a **denylist helper for normalize defaults**, not the print gate — do not use it as a substitute for `toPrintableCustomerQuote`.

### Surfacing a COMMENT on an ad

Comments carry no star rating, so sentiment is the only gate — and it is made by
**inference at ingest**, not by a keyword lexicon. The verdict is persisted to
`Comment.proofJudgment` and read by every surface that renders a comment
(quote tier, `top_comments`, the AI-canvas builder, the Director). If the judge is unreachable it **alerts and throws**;
there is no lexical fallback. Full rationale, failure policy and consumer list:
**[docs/PROOF_JUDGE.md](PROOF_JUDGE.md)**.

---

## 5. Static-image ad generation (THE default ad path)

> **Critical (corrected 2026-07-31 / re-verified 2026-08-03):** the default static ad is **one billable `openai/gpt-image-2/edit` call** that returns the finished ad (`services/directImageRenderService.js` `renderDirectImage`). **Was false:** "GPT-4.1 authors HTML → Puppeteer rasterizes → optional gpt-image-2 photoreal polish." That chain is **legacy HTML** only — reached solely when `Brand.staticImagePipeline === 'html'`. `resolveStaticPipeline` (`services/staticPipeline.js:69-70`) maps every other stored value (including `null`, `direct_overlay`, typos) to `direct_image`. Clients may only **write** `'direct_image'`; writing `'html'` is rejected.

### Trigger

- `routes/ads.js` `POST /generate` → **202** + `setImmediate` → `campaignAdsGenerationService.expandWizardJob` → `selectAdsForRun` → `runRenderLoop` (all in the **web** process).
- `POST /api/ads/runs` drains already-queued inventory: `selectAdsForRun` then **`claimAdsForRun()`** (`routes/ads.js:645-750`) — atomic `updateMany` with `status:'queued'`, ownership re-read (`status:'rendering'` + `campaignRunIds: runId`), `modifiedCount` cross-check, post-claim requeue on throw. **Was false:** `/runs` lacked the claim `/generate` already had (double-bill hole on concurrent "render next batch").
- `CampaignRun` tracks batch status; ad-batch progress via OperationRun kind `ad-batch`.
- `GET /api/ads/runs/:runId` returns `perProduct` (machine codes + messages from `services/perProductReasons.js`). New code `concepts_no_usable_media` distinguishes "Director returned nothing" from "returned concepts but none usable". Run-level empty message uses `summarizeEmptyExpansion`, not the old generic "check imagery and templates".

### Concept contract (load-bearing — zero-ads root cause, fixed 2026-08-02)

Director schema **v3** nests strategy fields under `concept.routing` (`media_picks`, `creative_style`, `output_shape`, `funnel_stage`, …). The producer dual-read both shapes and logged `warnings=0` while **every consumer that still read flat v2 discarded the concepts** → `payloads=0` (zero ads, paid Director rounds wasted). **One helper only:** `services/conceptProjection.js` — `conceptField()` / `conceptMediaPicks()`. Consumers include `campaignAdsGenerationService`, `aiJudgeService`, `aiCanvasHtmlGeneratorService`, `veoStoryboardService`. `scripts/verifyConceptContract.js` **fails the suite** if any `services/` or `routes/` file reads a `ROUTING_NESTED_FIELDS` name off a concept without the helper. Verified live after fix: `concepts=3 payloads=3` where it was `payloads=0`.

**Post-Phase-B registration trap:** `routing.funnel_stage` was added to the PMax Director schema but **not** registered in `ROUTING_NESTED_FIELDS`, so the flat-read scanner never covered it. Registered now. Follow-on: removing a name from that list previously failed **nothing** (the check just iterates a shorter list) — **R0b** now pins the load-bearing names (`media_picks`, `creative_style`, `output_shape`, `funnel_stage`) stay registered.

### Which template an ad becomes — the Director picks it, and social proof had collapsed

**The wizard has no template picker.** The frontend hardcodes all five `ai_*` ids into every request (`GenerateAds/index.tsx` `DEFAULT_TEMPLATE_IDS`; the Settings step was removed 2026-06-12, `52cf33c`). Under `AI_CONCEPT_DRIVEN=true` the template is derived from the Director's `routing.creative_style`:

```js
const creativeStyle = conceptField(concept, 'creative_style');
const template = CREATIVE_STYLE_TO_TEMPLATE[creativeStyle] || 'ai_brand_led';
```

so an absent or unrecognised style silently becomes **`ai_brand_led`**. Combined with a round prompt whose *entire* creative_style guidance was one bare enum line, production measured (Render logs, 2026-07-30..08-06):

| template | successful renders |
|---|---|
| `ai_brand_led` | 200+ (query cap) |
| `ai_editorial` | 111 |
| `ai_promotional` | 38 |
| **`ai_social_proof_led`** | **18** |
| `ai_ugc_led` | 2 |

The string `social_proof_led` appeared **once** in `aiCreativeDirectorService.js` — in the enum — and in **zero** guidance. Note the HONESTY RULE was *not* the cause: it constrains `social_proof_type` and two archetypes, never `creative_style`.

**Fixed 2026-08-10 (three parts):**

1. **Selection criteria.** `buildPromptRound` now describes when each style applies, and names `brand_led` the *default of last resort* — the direct counterweight to the `|| 'ai_brand_led'` fallback. `creative_style` is also now a listed concept-diversity axis.
2. **Reserved slot.** When a **RATING** is reachable, ≥1 of the 3 concepts must be `social_proof_led`. **Rating-bearing, not "any proof"** — `INTENTS.social_proof_led.eligible` is rating-only, so reserving a slot on a quote or comment alone would mint `ai_social_proof_led` on products that then fall back at render, *amplifying* the collapse this fixes (adversarial finding, pinned by A5b). The condition is a strict subset of "the HONESTY RULE does not fire"; **the two must never both be active**, or the prompt demands a proof concept while forbidding proof — the self-contradictory-prompt class that forced the PR #61 video rollback (§6 / CLAUDE.md §00). Deliberately instruction-level, not a post-parse rejection: a thin-data product should degrade to an honest non-proof concept rather than ship a hollow proof ad.
3. **`DIRECTOR_PROOF_MENU_ENABLED=true`** (`config/defaults.env`). Product-scoped runs withhold brand quotes/ratings from `primary_quote`/`rating` (cross-product copy guard) but now see them in `proof_options[]`, each with its own pre-scoped disclosure string. The honesty rule is amended **under the same flag**, and the reserved slot's `proof_options` term is gated on that **same flag**, so a stale or injected summary cannot desynchronise them (pinned by A6b). Flag-off restores the pre-change prompt byte-for-byte, original honesty-rule string included.

**Paired with `DIRECTOR_SIGNALS_VERSION` 3.1.0 → 3.2.0.** ⚠️ **Scope, stated correctly — an earlier revision of this section overstated it:** the LIVE path `directConceptsRound` has **no** `signalsVersion` cache gate and calls `assembleSignals` every round, so the menu takes effect with or without the bump. The only cache-hit gate is `aiCreativeDirectorService.js:262`, inside the **shadow** `directConcepts` path. So the bump buys *shadow* correctness (artifacts built from the narrower shape stop being served as current) and is **not** what makes the flip work. **Accepted one-time cost:** that shadow call is `await`ed on live campaign expansion, so the bump forces one paid re-derive per unique (brand, product, campaignKind, creativeIntent, platformFormat) on next request. Bounded and self-healing. Pinned by `scripts/verifySocialProofRestoration.js` groups A/B.

**Later bump (Phase B PMax, 2026-08-11): `3.2.0` → `3.3.0`.** Required for the PMax-only funnel-spread + social-proof hierarchy brief — without it every product that already has a `CreativeDirectionArtifact` keeps serving the pre-hierarchy brief. Meta round prompt stays byte-identical. Full write-up: [§6 *Director: funnel spread + social-proof hierarchy*](#director-funnel-spread--social-proof-hierarchy-phase-b).

### Proof coherence — a LABELLED brand rating may sit beside a product/comment quote (static only)

`resolveCoherentSocialProof` (`services/ratingDisplay.js`) is the single chokepoint pairing quote tier ↔ number tier, shared by static (`buildIntentData`) **and video** (`brandScriptExecutor.buildMetaForAd`). Its invariant #4 forbade *product/comment quote + brand numbers*, because a brand-wide count beside one SKU's testimonial reads as that SKU's volume.

**Measured cost:** 7 of the 18 `ai_social_proof_led` renders logged `intent=objection_resolved(fell back from social_proof_led)`. Mechanism: no product-level rating + a comment-tier quote on frame → brand stars hard-nulled → `d.rating` undefined → `INTENTS.social_proof_led.eligible` fails (its `core` **is** `RATING`) → `FALLBACK_ORDER`. Quote precedence is product → category → comment → brand (`layoutInputService.js`), so comment-tier quotes are common, making this the normal case, not an edge one. The 4.39 star floor was **not** the blocker.

**Owner override, 2026-08-07**, verbatim: *"I don't want brand level stars to block a comment tier quote. We can have both and clearly demarcate brand level stars … The positive comment is different and better social proof than brand level stars"* / *"include the comment and then use brand level stars and include a 'Brand Reviews' next to the stars."*

Implemented as opt-in `allowLabeledBrandNumbers`, **default `false`**:

| guarantee | how |
|---|---|
| video + every other caller unchanged | parameter defaults false; **only** `directImageRenderService` passes true — byte-identical *by construction*, pinned by D3 (recursive over `services/` **and** `routes/`) / D4 |
| product numbers always win | the exception sits **after** both product attempts; it can only ADD proof, never displace product with brand (C4 / C7e) |
| a rating can never print unscoped | **stars only**, and a normalized brand **count is required** so `formatBrandReviewsText` can produce the `BRAND_SCOPE_LABEL` — no count → refuse (C7b/C7c) |
| no brand volume claim beside a product quote | `allowBrandCountWithoutStars` stays **false**; `'brand-count'` is rejected (C7) |
| a raw env string cannot opt in | gate is **`=== true`**, not truthiness (C7d) |
| substituted quotes still earn nothing | the fail-closed `renderedQuoteText` guard is untouched (C8) |

**Three constraints above exist because two independent adversarial passes broke the first draft**, and all three are revert-proven — do not "simplify" them:
- Truthy gate → the literal string `"false"` opted **in**.
- No count requirement → a stars-only brand pair rendered a **bare `4.7 ★`** beside a product/comment testimonial with no qualifier, which the code's own comment claimed was impossible.
- `allowBrandCountWithoutStars: true` → printed a brand volume claim next to a product testimonial *and* still left the intent ineligible (eligibility is rating-only), i.e. all risk, no benefit.

**Known accepted residual:** a product pair with a *sub-floor rating but a non-zero count* returns `product-count` and short-circuits the exception, so that shape still falls back. Fixing it would mean brand numbers displacing a product-tier number — a second override nobody approved. Pinned as a decision by C7e.

Kill switch **`STATIC_BRAND_STARS_WITH_QUOTE=false`**, committed in `config/defaults.env` — reverts with no deploy. **Do not "restore invariant #4"**; it is an owner decision, and this repo has precedent (PR #61) of a later session undoing one. Pinned by `scripts/verifySocialProofRestoration.js` groups C/D — **35 checks, revert-proven on 13 mutations**.

### Seed selection — image vs video (the first-catalog-image rule)

> **Was falsely documented (corrected 2026-08-03):** this section used to be titled *"Hero-image default"* and presented `DIRECTOR_UNIVERSE_TOP_N=1` as delivering the owner's rule. **TOP_N=1 is a COUNT, not a choice of image.** It trims a shotType-ranked pool to one entry; which entry survived was decided by shot type, and catalog media routinely lost.
>
> **Amended the same day.** The rule is no longer stated in terms of the `imageRole: 'hero'` LABEL. Owner, verbatim 2026-08-03: *"I actually just want to use the first image that comes from the catalog not the 'hero' image since that may also come from social media or UGC?"* The default image seed is **the first image that came from the catalog**, and it **can never resolve to UGC**.

**The two rails have genuinely different seed MECHANISMS, but now the same rule. Do not generalize the mechanism.**

| Rail | Default seed | Mechanism |
|---|---|---|
| **Static image** (§5, `runConceptDrivenExpansion` → `buildSeededUniverse`) | the **first image that came from the catalog**, pinned explicitly | shotType ranking **then** the `preferFirstCatalogImage` hoist (a 3-tier cascade), then trim to `topN` |
| **Deterministic video** (§6) | the **first image that came from the catalog**, queried directly | `Media.findOne({ 'metadata.imageRole': 'hero' })` → earliest `createdAt` → lazy materialize. Shot type is never consulted |

**Why the static rail needed a fix.** `buildSeededUniverse`'s auto-assembly branch (`seededUniverseService.js:400-534`) merges catalog media **and** `product_match` UGC into ONE pool, then ranks it with `rankMergedPool` (`:96-120`) by `classification.shotType` first — lifestyle → on_model → flat_lay → product_only → detail → packaging → unknown (`shotTypeRank.js:15-23`). `metadata.imageRole === 'hero'` is only a tiebreak **within** a tier, key #2 of 4 (after the `wantsVideo` burned-text penalty, before engagement and `createdAt`). Source does not gate order, by design: a UGC lifestyle post ranks equal to a catalog lifestyle shot. So `.slice(0, 1)` of that ranking handed the Director a lifestyle catalog **ALT** — or a **UGC post**, which then also flipped `Ad.variantKind` to `'ugc'` via `matchTierForUniverseRole` / `variantKindForUniverseRole`.

**What pins the catalog's first image:** the opt-in `opts.preferFirstCatalogImage`. `promoteFirstCatalogImage` (`seededUniverseService.js:178`) returns a **new array** (pure, non-mutating) with one entry moved to index 0, every other entry keeping its relative order. It is a **cascade**, and every tier is gated on `role === 'catalog'`, so **no tier can select UGC**:

| Tier | Selects | Why |
|---|---|---|
| **1** | first entry with `role === 'catalog'` **and** `media.metadata.imageRole === 'hero'` | That stamp is written in exactly one place: `catalogProductDetectService` materialises `CatalogProduct.imageUrl` — the catalog feed's **first** image — with `imageRole: 'hero'` (`:60`); `additionalImages[]` get `'alt'` (`:80`, `:513`). So tier 1 *is* "the first image from the catalog", wearing a legacy name. Nothing stamps `'hero'` on social/UGC media (the only other writer is `shopifyPublicIngestService.js:526`, which writes `'video'`) |
| **2** | else, among `role === 'catalog'` entries, the one with the **earliest `media.createdAt`** | **This tier is the point of the amendment.** The tier-1 stamp can be **ABSENT** — hero materialisation failed, or the row predates the stamp. A tier-1-only helper returned the pool unchanged in that case, and the shotType ranking then decided index 0 out of a pool that **merges catalog with `product_match` UGC** — which is exactly how a UGC post became the default seed of a catalog product ad. The **fallthrough** is the failure mode; tier 2 removes it, so an **unstamped catalog set still beats UGC**. Catalog `Media` rows are materialised in feed order, so earliest ≈ first |
| **3** | nothing — an unchanged copy | No `role === 'catalog'` entry exists in the pool at all. Nothing came from the catalog, so there is nothing to pin, and the cascade does **not** settle for a UGC entry as a consolation prize |

Tier 2 determinism: the scan uses a strict `<`, so an **equal** `createdAt` never displaces the incumbent and the earlier entry in **ranked** order keeps index 0. A **missing or unparseable** `createdAt` maps to `Infinity` — it sorts **last**, never first, so a legacy row with no timestamp cannot win "earliest" by defaulting to epoch 0. If *every* catalog entry lacks a timestamp they all tie and the earliest in ranked order wins.

Applied at `:504`, on the ranked wrappers, **before** `projectEntry()` and **before** `.slice(0, topN)` — with `topN=1` the slice is the whole decision, so a promotion after it would be inert; and `projectEntry` drops `createdAt` entirely, so tier 2 could not run after it.

**The `role === 'catalog'` test is load-bearing in every tier**, not defensive: UGC docs carry `metadata.imageRole` too (we do not author creator-side metadata), so a creator post stamped `'hero'` must lose tier 1 to an *unstamped* catalog image via tier 2, and must never be selectable by tier 2 either.

**This cascade deliberately mirrors** the proven one on the deterministic video rail, `campaignAdsGenerationService.js:2085` (*"Feed-order hero: imageRole hero → earliest createdAt → lazy materialize"*) — same tier 1, same tier 2. That rail's third step lazily materialises `Media` from `CatalogProduct.imageUrl`, a DB write that cannot live in a pure ranking helper; here tier 3 is "leave the pool alone".

**Where it deliberately does NOT apply** (all three are required, not defensive):

- **`preferFirstCatalogImage` defaults to `false`.** Only `runConceptDrivenExpansion` opts in, and only for image runs with no operator picks: `preferFirstCatalogImage: !operatorPickedMedia && resolvedKinds.includes('image')` (`campaignAdsGenerationService.js:2388`). Every other caller — including `scripts/inspectImageSelection.js` — is byte-identical to before.
- **The `restrictToMediaIds` branch** (`seededUniverseService.js:339-397`) returns before the promotion. Operator picks **are** the "unless the user overrides it" half of the rule; re-ordering them would override the override. They still widen the window via `Math.max(mediaIds.length, DIRECTOR_UNIVERSE_TOP_N)` (`campaignAdsGenerationService.js:2343-2345`) rather than being truncated to 1. Note the override is a **membership** override, not an ordering one — that branch still shotType-ranks the picks.
- **Brand-only runs** (`productId === null`) pool every product's catalog media, so many docs are *some* SKU's first catalog image and "the catalog's first image" has no meaning; promoting one would silently pick a SKU. Gated by `!isBrandOnly`.

**Deliberate precedence:** a catalog image with burned-in text is still promoted, even on a mixed image+video run where `rankMergedPool` penalizes burned text. The owner rule outranks that tiebreak.

**Pinned by** `scripts/verifySeededUniverseHeroDefault.js` — **111 offline checks** (pure, no DB / network / key), covering all three tiers, the tie and missing-`createdAt` outcomes, purity and stability, the end-to-end `buildSeededUniverse` shape at `topN=1` for both tier 1 and tier 2, the override and brand-only gates, and the source wiring (including that the promotion is **not** folded into the shared `rankMergedPool`, which would silently re-order operator picks). Its header carries the revert-proof recipe.

`DIRECTOR_UNIVERSE_TOP_N` default **1** (was 10) is still a **default** change, not a capability removal. Ceiling stays 10; multi-image fully wired (`campaignAdsGenerationService.js:195,2343-2345`). Side effects of TOP_N=1:

- Judge `media_utilization` axis is **N/A** (excluded from average) — it was docking every concept for obeying our own constraint (`aiJudgeService.js:423-431`).
- Output-shape menu narrows to **`static_single` only** so the model cannot emit a collage declaring one tile (`aiCreativeDirectorService.js` `feedOutputShapesForUniverse`).
- The Director's AVOID block asks each round to prefer media the previous round did not use. At universe size 1 that is unsatisfiable regardless of this fix — one entry every round.

**Known-stale prompt text (not changed here):** `aiCreativeDirectorService.js:1541` tells the model the universe is "PRE-RANKED by shot-type quality … earlier entries are BETTER seeds". That stays true at the default (TOP_N=1 ⇒ one entry, nothing to order), but if `DIRECTOR_UNIVERSE_TOP_N` is raised above 1 **with no operator picks**, index 0 is now the pinned first-catalog-image rather than the top shot-type candidate, and that sentence would need rewording before the wider window is used.

### Static regenerate — catalog-first reseed (`REGEN_RESEED_CATALOG_FIRST`)

Shipped in `be5b83f` (2026-08-03). **Default ON** (`config/defaults.env`; unset/empty also ON — only `0`/`false`/`no`/`off` turns it off; `isRegenReseedCatalogFirstEnabled`, `adRegenerateService.js:110-114`).

**Why it exists.** `runImage` used to **replay** the stored stack (`Ad.referenceMediaIds` if non-empty, else `Ad.mediaIds`) and never re-derive (`adRegenerateService.js:477-482` is still that path when the reseed is skipped). Ads queued while `DIRECTOR_UNIVERSE_TOP_N` was 10 still hold 3+ entries in `mediaIds`, so every future regen re-sent that stack forever.

**NOT a trim.** Historical stacks were shotType-ranked **LIFESTYLE-FIRST** over a pool that **merges catalog with `product_match` UGC** (`shotTypeRank.js`). So `mediaIds[0]` is often a UGC post; trimming to `[0]` would permanently lock a social image as the seed. The fix **re-derives** the first catalog image instead.

**Cascade** (`deriveFirstCatalogMediaId` / pure `pickFirstCatalogMediaId`, mirrors `campaignAdsGenerationService.js:2085` and `promoteFirstCatalogImage`):

| Tier | Selects |
|---|---|
| **1** | `source:'catalog-product'` + ad product + ad brand + `metadata.imageRole === 'hero'` |
| **2** | else same scope, earliest `createdAt` |
| **3** | nothing — leave existing behaviour untouched (`NO_CATALOG_MEDIA`) |

Every query pins `source:'catalog-product'` **and** the ad's own `metadata.catalogProductId` **and** `Media.brandId`. `isCatalogMediaForProduct` re-checks every candidate (`adRegenerateService.js:150-172`). A catalog **VIDEO** can never win (`fileType === 'video'` and `metadata.imageRole === 'video'` both reject — `source:'catalog-product'` includes videos from Shopify ingest). An unusable/missing `fileUrl` is an **honest skip**, not a silent fallback to the ad's original seed (that would re-lock the UGC seed under a success log).

**Gates** (`reseedDecision`, all four required):

1. Flag on.
2. `ad.kind !== 'video'` (static only).
3. `ad.variantKind === 'product_image'` only — owner: *"UGC ads shouldn't be affected by this change, we haven't optimized that path yet."* A `variantKind:'ugc'` ad is supposed to seed from a social image.
4. `Ad.referenceMediaIds` empty — a non-empty operator pick **always wins**.
5. `ad.productId` present.

**NOT persisted.** The derived stack is computed at regenerate time and passed into `renderDirectImage` only (`referenceSource: 'catalog-first'`). Writing it back onto `Ad.mediaIds` would rewrite historical rows and make the kill switch useless after one regen. Flipping `REGEN_RESEED_CATALOG_FIRST=false` restores the old output on the next regen with no code deploy. **Not a money knob** — still exactly one `gpt-image-2/edit` per regen; reference count does not move price (`atlasImageService.js:75-104`).

**Pinned by** `scripts/verifyRegeneration.js` (R3 gate matrix, R3b cascade tiers, R3c fileUrl/video/cross-tenant).

### Stages (live direct-image path)

Entry: `runRenderLoop` → `renderCreative` → outer `adStage(…, static image generation (surface))` (`routes/ads.js:1403`) → `renderStage` (`renderService.js:482-511`) for every static `ai_*` template → `directImage.renderDirectImage`. Stages are fire-and-forget via `services/adStage.js` (NEVER awaited — sits where Atlas is already billed; `AD_STAGE_MIN_MS` floor default ~3s). Poll progress piggybacks the **existing** image poll tick (`ATLAS_IMAGE_POLL_MS` default 3s), e.g. `plate generation (meta_feed_1_1) — polling 20s (7)`.

1. **Ensure product imagery** — `ensureDetectForProducts` for campaign products ([§3](#3-per-product-detect--overlay-zones--ad-readiness-deferred-to-ad-time)).
2. **Concept expansion** — when `AI_CONCEPT_DRIVEN=true` (default): Director + Judge → Ad rows with `renderRoute: 'html_gen'` (**misnomer** — means "static", not "the HTML renderer"; real path is chosen inside `renderService`). Reads of `media_picks` / `creative_style` / `output_shape` go through `conceptProjection` only.
3. **Derive layout / resolve concept** — `adStage(…, deriving layout (surface))`; missing concept **throws** (not a silent HTML fallthrough).
4. **Fetch references** — seed media (+ Director/operator multi-pick when present). Zero refs → refuse before spend.
5. **Build prompt + geometry** — intent / copy from concept projection (never invents art from `rationale`); customer quotes only via `toPrintableCustomerQuote`.
6. **Plate submit + poll** — one `openai/gpt-image-2/edit` (or `AI_DIRECT_IMAGE_EDIT_MODEL`) via `atlasImageService`; stages on poll ticks.
7. **Crop + logo composite** — local post; terminal asset on `Ad.renderUrl`; `adStage(…, 'done')` on success.

**Legacy HTML path** (only `Brand.staticImagePipeline === 'html'`): GPT-4.1 HTML (`aiCanvasHtmlGeneratorService`) → Puppeteer raster in `renderService`. Image-ref "photoreal polish" (`aiImageReferenceService`) is **not on the render path** — `AI_IMAGE_REFERENCE_*` vars are kept inert so old deploys resolve; `defaults.env` sets them false and documents them as deleted consumers. Do not re-enable expecting a polish step.

### Overlay-zone / spatial consumers

| Service | Role |
|---|---|
| `adSuitabilityService` | Ad-readiness score (catalog UI + Generate Ads picker) |
| `overlayPlacementService` | legacy `product_overlay` templates only |
| Direct-image path | Does **not** depend on overlay zones for the finished plate |

### Models & cost

| Stage | Model | Notes |
|---|---|---|
| Finished static plate (default) | **`openai/gpt-image-2/edit`** | One billable edit; quality via `AI_DIRECT_IMAGE_QUALITY` (default `medium`) |
| Concept / judge | GPT (Director + Judge) | Expansion cost, not the plate |
| Legacy HTML layout | GPT-4.1 + Puppeteer | Only brands on `staticImagePipeline='html'` |
| Extended crop / Atlas edit | gpt-image-1 / nano-banana etc. | Secondary paths (video reframe, etc.) |

### Env knobs

| Var | Default (repo) | Role |
|---|---|---|
| `AI_CONCEPT_DRIVEN` | `true` | Concept-driven expansion |
| `DIRECTOR_UNIVERSE_TOP_N` | **`1`** | Director seed window without operator picks (ceiling 10) |
| `AI_DIRECT_IMAGE_EDIT_MODEL` | `openai/gpt-image-2/edit` | Plate edit model |
| `AI_DIRECT_IMAGE_QUALITY` | `medium` | Plate quality |
| `AI_DIRECT_IMAGE_TIMEOUT_MS` | `600000` | Wall clock for plate |
| `ATLAS_IMAGE_POLL_MS` | `3000` (code default) | Image prediction poll; also drives stage piggyback |
| `AD_STAGE_MIN_MS` | `3000` (code default; **not** in `defaults.env`) | Stage write floor for same phase |
| `RENDER_CONCURRENCY` | **`8`** | Parallel static ads in `runRenderLoop`. File raised 4→8 on 2026-08-02; **live in prod 2026-08-03** when the dashboard pin of 4 was deleted (see §9 / CLAUDE.md §4a) |
| `PMAX_STATIC_PLATFORM_NOTES` | **`true`** | Phase B: inject `PLATFORM_NOTES` + intent-aware CTA on `pmax_*` statics only. Meta prompts byte-identical both arms. `false` → pre-Phase-B prompt for every surface including pmax. See [*Static PMax prompt overlay*](#static-pmax-prompt-overlay--cta-policy-phase-b-2026-08-11) |
| `AI_HTML_LAYOUT_ENABLED` / `RENDER_USE_HTML` | `true` | Still used by the **legacy** HTML arm only |
| `AI_IMAGE_REFERENCE_*` | `false` / inert | **Not read by the live render path** — was falsely documented as prod-on polish |

### Progress / cancel / stage telemetry

- OperationRun kinds: `ad-batch`, `ad-regenerate`, `ai-layout` as applicable.
- Per-ad `Ad.renderStage` / `renderStageAt` via `adStage()` — closed the previous multi-minute blind spot during Atlas polls. No new timers.
- Cancel: item/pool boundaries via `progressService.checkpoint`.
- **Known open:** `queued` ads still never auto-drain after a web-process death; reaper flips `rendering` → `queued` only.

### Routes worth knowing

| Route | Role |
|---|---|
| `GET /api/ads/formats` | `formatCatalog()` verbatim — display-only, brand-agnostic, no `brandId` (`routes/ads.js:1998-2000`) |
| Named routes before `/:id` | **ROUTE ORDER is load-bearing.** `mongoose.isValidObjectId('video-models') === true` (any 12-byte string casts), so `router.param` ObjectId guards (`routes/ads.js:2105-2112`) cannot protect a 12-char route name — they only turn bad ids into 404 instead of 500 CastError |

### Surface geometry — generation size and the safe box

`META_STATIC_FANOUT` is three **separate billable** `openai/gpt-image-2/edit`
calls, one per surface, because the model typesets headline / CTA / price **into
the pixels**. `platformFormats.js:394-403` explains why one master cannot be
cropped into three aspects: the crop would slice through that typeset copy.
Same shape for Google: `GOOGLE_STATIC_FANOUT` = three PMax marketing images =
three billable submits (`platformFormats.js` `GOOGLE_STATIC_FANOUT` /
`resolvePreset('google_static')`).

**Every Meta live static surface generates at its EXACT delivery aspect.**
Google landscape is the remaining crop case (1.91:1 has no exact enum twin):

| surface | aspect | generate | deliver | scale | post-gen crop | edge margin |
|---|---|---|---|---|---|---|
| `meta_feed_1_1` | 1:1 | `1024x1024` | 1080x1080 | 1.0547 | none | 6% |
| `meta_feed_4_5` | 4:5 | `1088x1360` | 1080x1350 | 0.9926 | none | 6% |
| `meta_stories_9_16` | 9:16 | `1152x2048` | 1080x1920 | 0.9375 | none | 6% |
| `pmax_square_1_1` | 1:1 | `1024x1024` | 1200x1200 | 1.1719 | none | **10%** |
| `pmax_portrait_4_5` | 4:5 | `1088x1360` | 960x1200 | 0.8824 | none | **10%** |
| `pmax_landscape_1_91_1` | 1.91:1 | `2048x1152` | 1200x628 | ~0.586 | ~80px H (~6.9%) | **10%** |
| `pmax_16_9` *(frozen)* | 16:9 | `2048x1152` | 1920x1080 | 0.9375 | **none** | 6% |

**Was false (corrected Phase A 2026-08-10):** this table previously listed
`pmax_16_9` as `1536x1024` with an 80px top+bottom (15.6%) crop. `GEN_SIZES`
gained the schema enum's exact 16:9 member `2048x1152` (`staticAdIntents.js:101-108`)
— no live probe needed, it is **in** `GPT_IMAGE_2_EDIT_SIZE_ENUM`. Consequence:
frozen `pmax_16_9` now zero-crops at 2048x1152, and `pmax_landscape_1_91_1`
crops ~6.9% instead of ~21.5% from the old 3:2 plate. **MEASURED: no Meta
surface's `chooseGenSize` winner changes** (table order + strict lower-loss
still pin 1:1 / 4:5 / 9:16).

Selection stays least-crop over `staticAdIntents.GEN_SIZES` — no per-surface
hardcoding. **Table order is load-bearing:** `chooseGenSize` uses strict
`loss < best.loss`, so an equal-loss tie keeps the earlier entry.

**Per-surface edge margin.** Default `EDGE_MARGIN_PCT = 6`. Override map
`SURFACE_EDGE_MARGIN_PCT` gives the three live PMax statics **10%**
(`pmax_landscape_1_91_1`, `pmax_square_1_1`, `pmax_portrait_4_5`) — Google may
crop ~20% of outer edges on responsive placements, and the image may be shown
with no accompanying text. Every other surface — **including frozen
`pmax_16_9`** — keeps 6% so existing geometry stays byte-identical.
`SURFACE_POLICY` rows for the three new statics: landscape maxTextElements **3**
(dense text hurts on that canvas); square/portrait **4**. **Documented
consequence (not changed):** on the narrow 1.91:1 canvas, density ordering
sacrifices supporting copy **before** the CTA on `brand_led` — that matches
the intent contract (`core` keeps CTA; supporting roles yield first). Do not
"fix" by reordering sacrifice without an owner decision. **Per-intent CTA
policy for PMax is Phase B and is live** — see [*Static PMax prompt overlay +
CTA policy*](#static-pmax-prompt-overlay--cta-policy-phase-b-2026-08-11) below.

**Size legality is a two-tier rule.** The schema `size` enum has 14 values and is
the operative contract; the model README still lists three and is stale. The
schema *also* documents arbitrary `WIDTHxHEIGHT` divisible by 16 for gpt-image-2,
but that text is spliced from OpenAI's own docs and carries an unpublished "must
satisfy the model's current pixel and edge limits" — so **prose is not warrant to
send a size.** A non-enum size is only allowed once a live probe proves it, and
`scripts/verifyStaticSafeBox.js` S4 enforces that with the prediction id
recorded. `1152x2048` and `2048x1152` are enum members. `1088x1360` is not, and
was probed (2026-08-03, one submit, returned exactly 1088x1360, aspect 0.800000).
The failure mode that rule guards against is not a 400 — it is a silent coercion
to the `1024x1024` default, which would hand a square frame to a 4:5 surface and
then centre-crop it.

**The safe box is inset from the KEPT region, additively.** Order is crop →
platform UI reserve → our edge margin (6% default / 10% on live PMax statics),
with the margin measured on the *kept* short side. The previous code used
`Math.max(cropBand, marginPx)`, which treated crop and margin as alternatives:
the margin was 61.44px and the crop band was always larger, so on every cropped
surface the margin collapsed to **zero** and the box handed to the model *was*
the crop line. The tell needed no model compliance — `logoPlacementFor`
composites the logomark from that same box, and it shipped flush to the delivered
frame edge (0px gap) on Stories and 4:5. Emitted percentages are rounded
**inward** (ceil low edge, floor high edge) so one-decimal rounding cannot walk
an edge back into a destroyed band.

**Crop machinery is retained deliberately.** `cropPx` / `extractFor` /
`deliveryGeometryFor` are no-ops on the exact-aspect Meta surfaces, but they
still serve `pmax_landscape_1_91_1` (and any off-size model response) and still
centre-crop rather than stretch. `deliveryGeometryFor` throws unless the kept
region scales uniformly to `deliveryDims` within 0.5%.

**Cost, stated honestly.** The catalog `base_price` is a flat `$0.01`, but real
billing is token-based on `size` *and* aspect:
`tokens = ceil(base × round(base × short/long) × (2,000,000 + W×H) / 4,000,000)`.
Atlas never publishes `base`, so only ratios are derivable: 9:16 at `1152x2048`
is ~**1.03×** the old `1024x1536`, and exact-4:5 is ~**1.11×**. Fewer pixels
pushes cost down while a squarer frame pushes it up, which is why a pixel-count
argument alone gets the direction wrong. Reported spend does not move either way —
the ledger books the flat catalog estimate, which `atlasImageService` already
notes understates this model ~6×.

Offline check: `scripts/verifyStaticSafeBox.js` (per-surface margin recompute +
new generate/crop pins; revert-proven). `describeSurfaces()` dumps every declared
surface including frozen and `coming_soon` entries.

### Google Performance Max statics (Phase A, 2026-08-10)

Six PMax formats flipped `coming_soon` → `live` in `services/platformFormats.js`
— three static (this subsection) and three video ([§6 *Google PMax video*](#google-performance-max-video-phase-a-2026-08-10)).

| key | deliveryDims | status notes |
|---|---|---|
| `pmax_landscape_1_91_1` | 1200×628 | live static |
| `pmax_square_1_1` | 1200×1200 | live static |
| `pmax_portrait_4_5` | 960×1200 | live static |
| `pmax_16_9` | 1920×1080 | **FROZEN** / `coming_soon` (legacy dual-kind key; existing Ads keep the id) |

**Money shape:** `resolvePreset('google_static')` → 3 billable image submits per
concept; `google_all` adds the video masters (see §6). Demand Gen keys +
`google_shorts_9_16` stay `coming_soon`: their `deliveryDims` are **identical**
to live PMax sizes, so the same generated files serve them — generating both
would be double spend. They were **removed from** `GOOGLE_STATIC_FANOUT` /
`GOOGLE_VIDEO_FANOUT` for that reason.

**Enums are mandatory.** `Ad.platformFormat` and `Campaign.platformFormat` both
list the six live keys — without the schema extension every write of a new format
throws a Mongoose `ValidationError`.

**Text assets are deliberately OUT OF SCOPE** (owner decision): clients already
run PMax and their existing headlines/descriptions serve; we supply the visual
layer. Copy burned INTO the creative stays ours. No Google Ads upload path yet
(integration is read/sync only) — v1 is an export bundle.

**No full end-to-end PMax kit has run through the app yet.** Phase B did run
prompt-only live Atlas submits (no DB / no Ad rows) and measured settled prices
— see [*Measured PMax unit costs*](#measured-pmax-unit-costs-phase-b-live-submits-2026-08-1011)
and `session.md` *Next-session prompt*.

### Static PMax prompt overlay + CTA policy (Phase B, 2026-08-11)

All of this lives in `services/staticAdIntents.js`. Kill switch
**`PMAX_STATIC_PLATFORM_NOTES`** (default **true**, `config/defaults.env`).

**`PLATFORM_NOTES` block** — injected **only** for `pmax_*` surfaces, **after**
the geometry block (so the notes can refer to the safe box already specified).
Content, in substance: the platform may crop the outer edges, so **rendered**
elements (copy, marks, badges — not the photograph itself) must sit inside the
safe box; the product only has to survive a centre crop uncut; the image may be
shown with **no** accompanying text and must communicate product + brand alone;
it may be shown small in a feed, so one dominant subject / strong contrast / no
thumbnail-fragile detail.

**Correction (adversarial review of Phase B):** an earlier draft of the notes
told the model the *product* must sit inside the safe box, two lines after
`geometryBlock()` says "EVERY element you render other than the photograph
itself must sit inside the box … The photograph should still fill the whole
frame edge to edge." That revoked the photograph exemption and would have
shrunk the subject on the surface where thumbnail legibility matters most.
Reworded as above.

**Destination + CTA.** `destinationForSurface()` maps `pmax_*` → `'pmax'`,
else `'meta'`. `resolveDrawCta({surfaceKey, policy, intentKey})` applies the
intent-aware CTA policy:

| surface class | flag | intent | `drawCta` |
|---|---|---|---|
| Meta (any) | on **or** off | any | unchanged from pre-Phase-B `SURFACE_POLICY` |
| `pmax_*` | **off** | any | pre-Phase-B `SURFACE_POLICY` boolean (byte-identical prompt) |
| `pmax_*` | **on** | `objection_resolved` (conversion; `ai_promotional` maps here) | **true** — burned CTA stays |
| `pmax_*` | **on** | every other intent | **false** — CTA suppressed |

Rationale: Google renders its own CTA button on most placements; a burned-in
CTA is redundant except on an offer/conversion creative. Suppression reuses
the **same path Stories already used** (`drawCta:false` → CTA stripped before
`applyDensity`, absence line via `ctaNote`) — not a second mechanism.

**Meta byte-identity guarantee (MEASURED, both arms):** every Meta surface ×
every intent is **byte-identical** to pre-Phase-B with the flag **ON** *and*
**OFF**. Only `pmax_*` prompts change, and only when the flag is on. Flag-off
restores a byte-identical pre-Phase-B prompt for every surface including
`pmax_*` (no notes block; pmax `drawCta` stays the per-surface
`SURFACE_POLICY` boolean).

Pinned by `scripts/verifyPmaxPromptOverlay.js` (**314 checks**; Meta
byte-identity in both flag arms with require-cache invalidation of both
`staticAdIntents` and `platformFormats`; flag-off ⇒ no platform notes
anywhere; flag-on ⇒ notes present on every live pmax static **after** the
geometry block and never on Meta; `resolveDrawCta` truth table both arms).
`verifyStaticIntents.js` and `verifyStaticFidelityPrompt.js` are **re-pinned**
(not weakened): pmax CTA suppression truth table; for pmax the last prompt
section is now `PLATFORM CONTEXT` with `FORMAT` immediately before it; for
Meta `FORMAT` must still be last.

### Measured PMax unit costs (Phase B live submits, 2026-08-10/11)

Prompt-only Atlas submits — **no DB, no Ad rows**. Settled prices read back
from each prediction (the authority; never quote catalog `base_price` as the
charge — CLAUDE.md §2). These **correct** the planning estimates:

| item | model | settled price |
|---|---|---|
| static 1:1 @1024×1024 | `openai/gpt-image-2/edit` | **$0.071728** |
| static 1.91:1 @2048×1152 | same | **$0.061440** |
| static 4:5 @1088×1360 | same | **$0.066660** |
| video 10s 16:9 @1080p | `google/gemini-omni-flash/image-to-video-developer` | **$0.90** |

Derived kit costs:

- **3-size PMax static fan-out ≈ $0.199/concept** (was estimated ~$0.22).
- **One 10s Omni master on the developer model = $0.90**, not the **$1.20**
  implied by the `MODEL_CAPS` `base 0.20 + 0.10/s` formula — that formula
  **overstates the developer variant by ~33%**. The developer model **is**
  the production default (`BUILT_IN_DEFAULT_MODEL`). Do not quote $1.20 for it.
- **Two masters = $1.80.** Full PMax kit (3 concepts × 3 statics + 2 masters)
  ≈ **$2.40 standalone**, ≈ **$1.50 marginal** alongside a Meta run that
  already pays for the 9:16 master. (Derive-only 1:1 is free crop+retitle.)

**Live schema facts confirmed the same day:** image `size` enum uses the
`1024x1024` form (a `1024*1024` submit is rejected 400 "invalid size");
`2048x1152` **is** an enum member (Phase A `GEN_SIZES` addition needed no
probe); Omni i2v `aspect_ratio` enum is exactly `['16:9','9:16']` and
`duration` enum `[4,6,8,10]`. Delivered 16:9 video: exactly **1920×1080,
10.000s, 240 frames**.

**Creative signal (n=1 per arm — signal, not verdict):** 16:9 A/B with a
deliberately unbranded seed — canonical profile mid-clip zoomed to an extreme
lace close-up where the product was no longer identifiable; PMax profile kept
the product legible across the whole clip. Neither arm invented a competitor
mark on that seed. Both delivered files exactly **1920×1080, 10.000s, 240
frames**.

**Static A/B (prompt-only, same unbranded seed):** on `pmax_square_1_1` and
`pmax_landscape_1_91_1`, overlay ON → burned-in CTA correctly gone and copy
inside the safe area; OFF → SHOP NOW button with text near the top edge. No
hallucinated marks in either arm.

**Harness lesson:** the first static run typeset `[object Object] ★` because
the test fixture passed `rating` as an object. Real `data.rating` is a
formatted **string** from `formatDisplayRating()`, with the scoped count in
`reviewsText`. A test that bypasses `buildIntentData` must mirror that exact
output shape.

### Consumers

- `Ad` documents / display URLs → Meta & Google push, previews, campaign UI.
- Direct-image output is production; there is no separate image-ref swap.

---

## 6. Video generation (Veo / Atlas) — deterministic-first

> **Default path (Meta):** product campaigns queue **one deterministic video ad per product** (hero seed or operator-ordered catalog stack) — `resolvePreset('meta_video'|'meta_all')` returns `videoFormats: [META_VIDEO_MASTER]` only. **Google PMax is different:** `google_video` / `google_all` queue **two billable Omni masters** (9:16 + 16:9) plus one **free derive-only** 1:1 crop of the 9:16 master — see [*Google Performance Max video*](#google-performance-max-video-phase-a-2026-08-10) below. The Creative Director no longer drives video by default — it serves **static image ads** and **opt-in video variants** only (backend PRs #11/#12/#13; wizard controls frontend PR #10).
>
> **Owner position (2026-08-03):** *"we disabled the director for the video path for now"* / *"we were using a canonical prompt"* / more archetypes may come later — **right now get the canonical prompt right.** Archetype-driven video is **deferred, not missing.** Camera prompt is generic **by design** (titling burns text downstream); levers are `videoPromptGuidance` + canonical directives in `buildVeoPrompt`, **not** concept fields. **PR #61's three camera-prompt changes are fully rolled back** (see *Full PR #61 camera-prompt rollback* below) — tune the restored canonical text, do not re-land those three.

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

- **Per-product count depends on platform.** Meta (`meta_video` / `meta_all`): **exactly one** billable video Ad per product (the master). Google (`google_video` / `google_all`): **two** billable masters + **one** free derive-only 1:1 — see [Google PMax video](#google-performance-max-video-phase-a-2026-08-10). **No** `VEO_ADS_PER_PRODUCT_CAP` on this rail (that cap applies only to concept/legacy video).
- **Seed selection**
  - If the operator passes ordered catalog-product `seedMediaIds`: grouped by `metadata.catalogProductId`, order preserved; **position 0 = primary seed** (`mediaId` + `referenceMediaIds` stack).
  - Else: feed-order **hero** (`imageRole: 'hero'` → earliest `createdAt` → lazy materialize from `product.imageUrl`); empty `referenceMediaIds` so render derives hero + alts.
  - **This rail's default is a literal query cascade, not a ranking** — `Media.findOne({ source:'catalog-product', 'metadata.catalogProductId': productOid, 'metadata.imageRole':'hero' })`, else `.sort({ createdAt: 1 })` over the same catalog scope, else lazy materialize (`campaignAdsGenerationService.js:2074-2118`, same query for the catalog-anchor append). Shot type is never consulted and the scope is `source:'catalog-product'`, so it could never resolve to UGC and nothing here needed the §5 `preferFirstCatalogImage` fix — §5's cascade was written to **mirror this one**. Contrast with the static rail, whose seed comes out of a shotType-ranked merged pool → [§5 *Seed selection — image vs video*](#seed-selection--image-vs-video-the-first-catalog-image-rule).
- **Reference stack (what the model actually receives)** — `buildReferenceImages` (`atlasVideoService.js:1917`) sends the first **3 DISTINCT** views: primary seed at position 0, then catalog mirrors in the order the caller supplied (`buildReferenceImages` does not sort — it trusts the arrival order of `catalogMedias`). Count comes from `DEFAULT_REFERENCE_IMAGE_COUNT = 3` (`:800`), overridable per brand/product via `videoSettings.referenceImageCount` up to `MAX_REFERENCE_IMAGE_COUNT = 7`, and always clamped to the resolved model's `maxReferenceImages`. An explicit operator pick list defines its own count (picking 5 means 5, not "5 truncated to 3") but is still clamped to the stack budget, with a warn.
  - **`REPEAT_PRIMARY_REFERENCE` is OFF** — env `false` (`config/defaults.env:126`) **and** the code default is now `false` when the var is unset/blank (`isRepeatPrimaryReferenceEnabled`, `atlasVideoService.js:829-833`). Owner 2026-08-03: the repeated primary **increased** hallucination and the pre-repeat output was better, so the closing-repeat and its matching return-to-primary prompt text were both reverted (part of the full PR #61 rollback below). Kept as a flag for a future A/B, not deleted. **When set true** it becomes 3 distinct + the primary appended again = **4 total** (`referenceStackBudget` `:865` → `distinctCap 3` / `totalCap 4` from `REPEAT_PRIMARY_TOTAL_CAP = 4` `:808`); the duplicate is appended **after** final-URL dedupe so it survives, and it never evicts a real view — it only appends while `length < totalCap`. Anything above that hallucinated in pilot, so do not raise the cap. **`REPEAT_PRIMARY_TOTAL_CAP` applies only to the flag-on path.** On the default (flag-off) branch the hard ceiling is **`MAX_DISTINCT_REFERENCES = 5`** (`atlasVideoService.js:813`) — owner-set 2026-08-03 because turning the repeat off removed the only clamp, which would have let `videoSettings.referenceImageCount=7` ship seven refs against the owner's "too many images hallucinated" finding.
- **Ad shape:** `renderRoute: 'veo'`, `kind: 'video'`, `template: 'ai_brand_led'`, `conceptId` / `judgeRank` null, `variantKind: 'product_image'`, run-level `videoPromptGuidance` / `videoPromptRaw` stamped when provided. Derive-only Ads also stamp `deriveFromMaster: 'pmax_video_9_16'` and `veoModel: 'derive-from:pmax_video_9_16'`.
- **Identity digest:** namespaced **`det-video:v1`** via `computeDeterministicVideoDigest` (campaign, product, ordered ref key or mediaId, platformFormat, CTA fields, guidance/raw). Does not collide with V1 JSON or V2 concept digests. **Duration joins the key ONLY for Google PMax video formats** — see the digest-scoping money note under [Google PMax video](#google-performance-max-video-phase-a-2026-08-10); pre-existing Meta digests stay byte-identical.

### Google Performance Max video (Phase A, 2026-08-10)

> **Load-bearing money shape.** `google_video` → **2 billable Omni masters per product** (9:16 + 16:9). `pmax_video_1_1` is **derive-only** — never an Omni submit. Mirrors how `meta_video` returns only `META_VIDEO_MASTER`; `resolvePreset('google_video'|'google_all')` returns **only** `GOOGLE_VIDEO_MASTERS`, never the full fan-out.

#### Formats

| key | deliveryDims | role |
|---|---|---|
| `pmax_video_9_16` | 1080×1920 | **billable Omni master** (also the 1:1 crop source) |
| `pmax_video_16_9` | 1920×1080 | **billable Omni master** |
| `pmax_video_1_1` | 1080×1080 | **derive-only** — face-safe crop of the settled 9:16 plate + its own Remotion titling |

Export: `GOOGLE_VIDEO_MASTERS = ['pmax_video_9_16','pmax_video_16_9']` (`platformFormats.js`).
Video `safeArea` (canvas px, width-normalized at 1000): 9:16 `{top:249, bottom:622}`, 16:9 `{top:56, bottom:113}`, 1:1 `{top:100, bottom:100}`. Statics keep 0/0 and use the edge-margin mechanism instead ([§5](#surface-geometry--generation-size-and-the-safe-box)).

Duration pin: Google PMax video floors to **10s** when the wizard leaves duration unset (`GOOGLE_PMAX_VIDEO_DURATION_SEC = 10`, `resolveVideoDurationForFormat`). Meta stays provider-default (Omni ~8s) — an 8s→10s Meta standardization is a **separate, costed** change, never folded in silently.

#### Derive-only surface + the shared gate

`pmax_video_1_1` is **never** an Omni submit. On Google master runs, expansion mints one extra Ad per product with `deriveFromMaster: 'pmax_video_9_16'` (`Ad.deriveFromMaster` schema field, default null).

**THE SHARED GATE:** `resolveDeriveFromMaster(ad)` lives in `services/campaignAdsGenerationService.js` and is **imported** by both `routes/ads.js` (render loop) and `services/adRegenerateService.js` (regenerate). It is **fail-closed on platformFormat** — `pmax_video_1_1` alone is sufficient, so a dropped/absent `deriveFromMaster` field can never turn a free surface into a paid one. **Do not re-implement it per caller** — a per-caller copy is exactly how the regenerate hole (below, defect 2) opened.

**Render path:** `renderDeriveOnlyVideoAd` in `routes/ads.js`. The gate is evaluated **before** the first Omni submit and returns. It **waits in-render** for the master's plate (`DERIVE_MASTER_WAIT_MS` default 12 min, poll `DERIVE_MASTER_POLL_MS` default 10s) rather than requeueing, then crops + titles. Master failed/absent → honest failure, **never** an Omni fallback. Same draft → titling → done money discipline as the master path (untitled is not success).

**Why wait-in-render (not requeue):** the whole run dispatches in one wave (`VEO_CONCURRENCY`), so the master is almost always still `rendering` when the derive Ad starts. Immediate requeue left the free 1:1 stranded in `queued` forever — reaper + stranded sweeper only look at `rendering` ads / failed runs, and a second Generate short-circuits with "Nothing to render" because the deterministic video digest is run-independent by design. Both operator work-arounds cost money.

**Mint only when the crop source is in the run.** `isGoogleVideoMasterRun` requires every entry to be a Google master **and** `PMAX_VIDEO_DERIVE_SOURCE` (`pmax_video_9_16`) to be among them — a single-format run of only `pmax_video_16_9` must not mint a 1:1 whose source was never generated.

**Fallback must strip derive-only.** `single` + `platformFormat: pmax_video_1_1` resolves `videoFormats` to `['pmax_video_1_1']`; the master resolver strips it (empty list); the bare `[videoPlatformFormat]` fallback used to put it straight back as a **paid** Omni submit. Live path **and** dry-run estimate both apply the same strip.

**DELETE must not destroy the master's asset.** Until the derive Ad uploads its own titled file, its `renderUrl` **is** the master's plate URL. DELETE skips Cloudinary destroy while the plate is still inherited (`veoModel` stamped `derive-from:<fmt>` **and** `renderUrl === veoVideoUrl`).

#### Digest scoping (money — caught pre-merge)

An earlier draft appended `videoDurationSec` to the video identity digests **unconditionally** and bumped the namespace `det-video:v1` → `v2`. **MEASURED:** that changed the digest for **every** pre-existing Meta video ad. Because `computeDeterministicVideoDigest` deliberately omits `generationRunId`, the `(campaignId, identityDigest)` unique index is the **only** guard against a repeat Generate re-billing an Omni master — so the next Generate on any existing campaign would have minted fresh ads and paid ~$1.00–1.20 per product again.

**FIX:** duration joins the key **only** for the Google PMax video formats (zero history → cannot collide), and the prefix stays **`det-video:v1`**. Pre-existing Meta digests are provably byte-identical. **If the Meta 8s→10s standardization later wants duration identity for Meta, that is a deliberate one-time re-mint that must be costed and flagged, never folded in silently.**

#### Defects found by adversarial review and fixed in the same change

Record these — they are the expensive lessons. Pinned by `scripts/verifyPmaxVideoExpansion.js` section F (54 checks total; revert-proven against 9 mutations):

1. **Digest re-mint (money, caught pre-merge)** — see above.
2. **Regenerate billed a derive-only ad (CRITICAL).** `adRegenerateService.runVideoFull` called `veoService.generateForAd` unconditionally; nothing in the regenerate route/preflight looked at platformFormat — so Regenerate on a PMax 1:1 billed a brand-new Omni generation (**planning figure was $1.20** at the pinned 10s from the `MODEL_CAPS` formula; **MEASURED Phase B: $0.90** on the developer model — see [*Measured PMax unit costs*](#measured-pmax-unit-costs-phase-b-live-submits-2026-08-1011); up to $5.00 if the square routes to the per-second aspect-fallback model), up to the daily cap per ad. **FIX:** `preflight()` refuses derive-only ads with a **409** (before the 202 and before any provider call), using the **shared** gate.
3. **Derive mint without its source master** — `isGoogleVideoMasterRun` fixed (above).
4. **Fallback reinstate of derive-only as billable** — strip on live + dry-run (above).
5. **Free 1:1 stranded on every first run** — wait-in-render (above).
6. **DELETE destroyed the master's asset** — inherited-plate guard (above).

#### Titling + composition mapping

`classifyFormat` (`brandScriptExecutor.js:89-94`) now checks **SQUARE BEFORE LANDSCAPE**, and `isLandscapeFormat` matches `/pmax_landscape|preroll|youtube|16_9/` instead of bare `/pmax/`. Without this, `pmax_video_1_1` and `pmax_square_1_1` were swallowed by a landscape rule that matched every `pmax_*` id and would have titled on the 1920×1080 composition. Verified mapping: 9:16 → `CanonicalVertical` 1080×1920, 1:1 → `CanonicalSquare` 1080×1080, 16:9 → `CanonicalLandscape` 1920×1080.

**`classifyFormat` MUST keep returning the four CANVAS formats**
(`vertical|square|landscape|feed`) — that string is also the **composition id**
and the **`titleStyleSpec` cascade key**. Returning a zone name from it would
break the render and silently change every spec lookup. Safe-zone selection is
a **separate** concern (below). Non-PMax behaviour is unchanged.

`remotion/lib/safeZones.js` has `verticalYt {0.14/0.35/0.075/0.15}`,
`landscapeYt {0.10/0.20/0.075/0.15}`, `squareYt {0.10 all}` — YouTube UI
overlay bands (engagement rail right, player controls bottom, channel chip
top).

#### YouTube safe zones WIRED (Phase B — closes the Phase A gap)

**WAS Phase A known gap; CLOSED Phase B.** Zones are now resolved per
`platformFormat` and threaded to the composition:
`pmax_video_9_16` → `verticalYt`, `pmax_video_16_9` → `landscapeYt`,
`pmax_video_1_1` → `squareYt` (`brandScriptExecutor` / `remotionRenderService`
/ `remotion/*`). Meta surfaces still use Meta zones.

**Funnel presets — 10s re-time REVERTED (post-Phase-B adversarial review).**
The three funnel titling presets (`canonical-awareness` /
`canonical-consideration` / `canonical-conversion`) are **GENERIC** — any brand
can select them via `brand.titleStylePreset` (`titleSpecService.resolveSpec`
Tier 2) and `scripts/retitleDriver.js --preset=` can force them onto
already-rendered ads. **Nothing scopes them to PMax.** They were authored for
**8-second** plates. `remotion/lib/timing.js` `specTimeScale` only
**compresses**; on a longer plate the authored pacing is kept and hold-to-end
slots just hold — so a 10s master played 8s of pacing then held ~2s. Phase B
re-authored them for 10s (preserving proportions), which dropped
`specTimeScale` from **1.0 → 0.8** for every existing **8-second** render using
those presets — silently re-timing the whole choreography 20% tighter, with no
crash and no failing test (measured against the pre-change files). **Presets
are back at their 8s extent.** If PMax wants 10s pacing it must be **separate
preset files** selected explicitly for PMax video, built together with per-run
preset selection (still open).

**STILL OPEN — per-run funnel preset SELECTION is not built.** The render path
already accepts `presetOverride` (`renderBrandScriptAndSave` →
`renderWithRemotionAndSave` → `resolveSpec` TIER 0), but **no live caller
supplies one** and no Ad/run field carries a funnel stage;
`buildMetaForAd` hardcodes `presetOverride: null` and **must receive the SAME
value as the render path** or the social-proof quote gate desyncs from the
rendered bind list. Only brand-level `titleStylePreset` works today.

#### PMax video directives profile (Phase B)

`services/veoPromptBuilder.js` — new **`PMAX_DIRECTIVES`** profile, same key
shape as `OMNI_DIRECTIVES`, selected only for PMax destinations via a new
optional arg to `buildVeoPrompt` (absent → today's Meta behaviour **exactly**).
Kill switch **`PMAX_VIDEO_DIRECTIVES`** (default **true**).

Differences from the Meta profile, **and only these**:

- **HOOK-FIRST** — product identifiable within the first 2 seconds (this
  surface is skipped/scrolled in seconds; the opening frames carry the ad).
- **Scene 1** reworded so the establishing move happens **with** the product
  already legible — and is **aspect-aware** (post-Phase-B fix): vertical gets a
  centred push-in; a hard-coded horizontal pan on 9:16 walked the subject into
  the engagement rail that `cameraStyle` already says to avoid.
- **Centre-safe composition** — product and focal detail away from the
  top/bottom bands and the outer side margins where the platform overlays UI.
- **Aspect-aware Frame line** — for 16:9: wider establishing framing,
  horizontal rather than vertical camera travel, product in the central band
  with headroom above and below. **`aspectRatio` had never been used in prompt
  text before** — the PMax profile is the first consumer.

Fidelity / noText / physicalAccuracy / productPreservation are **referenced
from `OMNI_DIRECTIVES`** (not re-authored) so they cannot drift.

**Corrections applied during review:**
1. The draft profile told a LANDSCAPE master it was "swipe-away vertical" and
   referenced the vertical right-edge rail — false and contradictory on the
   16:9 master. Shared text is now **aspect-neutral**; all aspect specifics
   live in the Frame line (and Scene 1 after the fix above).
2. See also [*Phase B adversarial corrections*](#phase-b-adversarial-corrections-post-phase-b)
   for the PLATFORM_NOTES / geometry contradiction and the blank-env threshold
   parser.

**The frozen Meta camera prompt is untouched**, confirmed two independent ways:
`scripts/verifyPostPilotBatch.js` **B14** (rebuilds from the pre-PR#61 source
out of git, byte-identity) still passes, **and** a direct build/byte-compare
against `git show HEAD:` across both aspects × durations 8 and 10.

#### Director: funnel spread + social-proof hierarchy (Phase B)

`services/aiCreativeDirectorService.js` — PMax-only round-brief content.
**Meta round prompt is MEASURED byte-identical** for every Meta surface (and
for a null format). PMax round prompt gained ~**3.2k** chars.

1. **Funnel spread.** Google delivers all creative for a product into ONE
   asset group and picks per impression, so the 3 concepts must **SPAN** the
   funnel — awareness / consideration / conversion, one each, each declaring
   `routing.funnel_stage` (new **nullable** field, **PMax schema only**; read
   via `conceptProjection` like every other routing field).
2. **SOCIAL-PROOF HIERARCHY** (owner-supplied creative guidelines). One
   dominant social-proof element per creative; supporting proof visually
   secondary; never equal weight across quote/rating/count/price/name/CTA.
   Per-SKU logic:
   - strong rating + substantial count → **RATING-FIRST** (no quote)
   - compelling short quote → **TESTIMONIAL-FIRST** (small optional stars)
   - both + large canvas → **COMBINATION** with one still dominant
   - weak count → **NEVER** print the count
   - rating below threshold with high volume → **POPULARITY** framing instead
     of the number
   - strong photography → **PRODUCT-FIRST** with minimal proof (a legitimate
     concept, not a failure)
   - **CONCEPT DIVERSITY:** the dominant proof element must **DIFFER** across
     the round's concepts — Google needs distinct approaches to test, not
     cosmetic variants.
3. **Thresholds are env-backed and INTERPOLATED into the prompt** so config and
   prompt cannot disagree: `PMAX_PROOF_STRONG_RATING` (**4.5**),
   `PMAX_PROOF_MIN_REVIEW_COUNT` (**100**). **Blank/whitespace/negative env
   values fall back to the default** — `Number('')` is `0`, not NaN, so a
   present-but-empty var (what clearing a Render dashboard value leaves) would
   have put "strong rating ≥ 0" / "substantial count ≥ 0" into the prompt and
   inverted the hierarchy (every SKU RATING-FIRST; weak-count suppression never
   firing). Fixed post-Phase-B.
4. **PRECEDENCE SENTENCE — load-bearing.** The shared DR block states
   "≥4.5 from ≥50" for when a rating is credible to cite. That text is
   **Meta-tuned and deliberately untouched**, so a PMax round shows the model
   two different counts for a similar-looking decision. The hierarchy block
   therefore states **explicitly that it wins for this destination on any
   disagreement including thresholds**. Do **not** delete that sentence, and
   do **not** "harmonise" the shared text — that would change the Meta prompt.
5. **`ARCHETYPE_WEIGHTING`** entries added for the three PMax **STATIC**
   surfaces (1.91:1 avoids dense multi-element layouts on that short wide
   canvas; square and 4:5 have more room). Phase A already added VIDEO-format
   weighting.
6. **`DIRECTOR_SIGNALS_VERSION` bumped to `3.3.0`** — without it the new brief
   is a no-op on every product that already has a `CreativeDirectionArtifact`
   (cache-hit test is `cached.signalsVersion === DIRECTOR_SIGNALS_VERSION`).
   Same trap class as the starved-brief 3.0→3.1 and social-proof-menu 3.1→3.2
   bumps.

#### Director scaffolding (Phase A; extended Phase B)

`ARCHETYPE_WEIGHTING` entries for the three live PMax **VIDEO** formats
(Phase A, modeled on the existing `pmax_16_9` entry) keep reserved-chrome
surfaces out of the "no weighting → square Feed defaults" hole. Phase B adds
the STATIC-surface entries + the funnel/proof hierarchy above.

#### Harnesses

- `scripts/verifyPmaxVideoExpansion.js` — **54 checks**, the money harness for
  the expansion/derive path: masters exclude the derive-only surface; Meta
  still resolves to exactly ONE master (submit count unchanged); duration
  pinned to 10s for Google and left null for Meta; duration does **not** alter
  any pre-existing format's digest but **does** for Google; the derive gate is
  fail-closed and defined **once**; `renderDeriveOnlyVideoAd` contains **zero**
  billable submit calls (comment-stripped so a money-ASSERT comment cannot
  false-pass); the gate precedes the first submit; section F pins all six
  defects above.
- **NEW** `scripts/verifyPmaxPromptOverlay.js` — **314 checks**, Phase B
  prompt harness: Meta byte-identity in **both** flag arms (require-cache
  invalidation of both `staticAdIntents` and `platformFormats`); flag-off ⇒ no
  platform notes anywhere; flag-on ⇒ notes present on every live pmax static
  **after** the geometry block and never on Meta; `resolveDrawCta` truth table
  both arms; video kill-switch equivalence; Meta camera-prompt baseline out of
  git; PMax video content pins (hook-first, centre-safe, 16:9 Frame line,
  correct 3-scene arithmetic at 10s). Revert-proven against **5** mutations.
- `verifyStaticIntents.js` / `verifyStaticFidelityPrompt.js` — **re-pinned**
  (not weakened) for pmax CTA suppression and section order (`PLATFORM
  CONTEXT` last on pmax; `FORMAT` still last on Meta).
- **NEW** `scripts/verifyVideoCostReconcile.js` — video ledger reconcile
  (post-Phase-B; see below). Revert-proven, including `await` on the
  render-path call site and dropping the `<= 0` price-parser guard.

Suite is **78 scripts, 0 failing**.

#### Phase B adversarial corrections (post-Phase-B)

Defects found by adversarial review of Phase B and fixed. This repo documents
its own reversals:

| # | Defect | Fix |
|---|---|---|
| a | Funnel presets re-timed for 10s silently compressed every brand's 8s renders using those generic presets (`specTimeScale` 1.0→0.8) | **Reverted** to 8s extent; PMax 10s pacing needs separate presets + per-run selection |
| b | `PLATFORM_NOTES` put the *product* inside the safe box, contradicting `geometryBlock()` photograph exemption | Reworded: box governs rendered elements; product survives centre crop uncut |
| c | PMax Scene 1 hard-coded a horizontal pan on both aspects → 9:16 walks into the engagement rail | Scene 1 aspect-aware (vertical → centred push-in) |
| d | `PMAX_PROOF_*` `Number('')` → `0` inverted the hierarchy | Blank/whitespace/negative → default |
| e | `routing.funnel_stage` missing from `ROUTING_NESTED_FIELDS` (scanner blind) | Registered + **R0b** pins load-bearing names stay registered |
| f | Density on 1.91:1 (`maxTextElements: 3`) drops supporting copy before CTA on `brand_led` | Documented against intent contract; not changed |

#### Video cost reconciliation (post-Phase-B)

**Owner rule** (CLAUDE.md §2): always read the actual price back from Atlas after
generation; budget / margin / per-ad claims come from **reconciled** rows. That
was implemented for **images only**. Video booked `estimateRenderCostUsd(...)`
and never read the settled price back, so **every video row in the ledger was
the formula estimate forever**.

**MEASURED:** two live 10s/1080p/16:9 generations on
`google/gemini-omni-flash/image-to-video-developer` (`BUILT_IN_DEFAULT_MODEL`)
both settled at **$0.90**, while `MODEL_CAPS` `base 0.20 + 0.10/s` yields
**$1.20**. The ledger therefore **overstated** video spend by ~33% on the
default model. **Over-REPORTING, not overspending — no money was lost** — but
margin and per-ad cost analysis were wrong, and PMax roughly doubles video
volume.

**Shipped in `services/atlasVideoService.js`:**

- `pollPrediction` returns `{ url, price }` (not a bare url string). Not
  exported; one value-returning path (every other exit throws); both internal
  call sites unwrap. No external consumer.
- `reconcileVideoCostFromTerminal(predictionId, terminalData)` — **fire-and-
  forget** (never awaited; sits on the render path where Atlas is already
  billed) right after the master lands. If the terminal poll **already**
  carries a usable price it reconciles immediately and schedules nothing.
  **Measured:** video publishes `price` at completion (unlike images, where it
  usually appears later) — immediate path is the normal one; re-poll is the
  exception.
- `scheduleVideoCostReconcile(predictionId)` — fallback when the terminal
  response has no price. Same backoff as the image path
  (`[3s, 10s, 30s, 60s, 120s, 300s]`), `.unref()`ed, never throws into the
  caller, gives up with a loud warning that the row stays estimated.
- `parseAtlasSettledPrice` — Atlas returns price as a **string** (`"0.9"`).
  Rejects null/undefined/empty/non-finite/zero/negative so an unusable value
  leaves the estimate in place and can never zero a row.
- Immediate path: `finalizeFlatCost({ providerRequestId, costUsd,
  costSource: 'actual', status: 'ok' })`. Scheduled path:
  `reconcileCost({ providerRequestId, costUsd })` with filter
  `{ providerRequestId, costSource: 'estimated' }` — **idempotent**; never
  clobbers an already-actual row or inserts a second one (a duplicate would
  double-count the charge).
- **`MODEL_CAPS` / `estimateRenderCostUsd` deliberately unchanged** — the
  estimate is still the correct pre-settlement floor (a submit that dies
  mid-poll must still book something). Reconciliation is the fix, not
  re-guessing.

**Consequence:** a video row with `costSource:'estimated'` means the price was
**never published**, not that the estimate is authoritative. Do not quote the
`base + per-second` formula as spend for the developer model.

#### Concept / director path

- Image concepts: still Director + Judge (`aiCreativeDirectorService` / `aiJudgeService`); template label maps from `conceptField(concept, 'creative_style')` (v3 dual-read — flat `concept.creative_style` alone is wrong; see §5 concept contract).
- **Director JSON contract lives in the prompt + salvage, not `response_format`.** The `director` role is `anthropic/claude-sonnet-5-ccmax` (`atlasModelMap.js:98`). Atlas **silently ignores** `response_format:{type:'json_object'}` for that model (probed live 2026-08-04 — both arms returned conversational prose; distinct from `json_schema` HTTP 400). Round system prompt now carries an `OUTPUT CONTRACT` block; parse path is `safeParseDirectorJSON` / `extractFirstBalancedObject` plus a one-shot corrective re-ask that shares the existing `attempt` budget (worst case still two paid Director calls). Measured pre-fix from Render logs over 24h: **10 Director round failures / 1 success** (prose openings → zero ads for that product). Code is applied in the working tree and offline-pinned by `scripts/verifyDirectorJsonSalvage.js` (32 checks, revert-proven); **uncommitted and not deployed** — do not claim production is fixed.
- Video concepts: only when `conceptVideo` is true (opt-in `directorVariants`; default **off**); still capped at `VEO_ADS_PER_PRODUCT_CAP` (default **1**) per product in the concept expander. Storyboard text path reads archetype / hooks via `conceptField` (`veoStoryboardService.js`) — **Atlas/Omni camera prompt does not use that path** (storyboard retired on Atlas; see stages table). Opt-in queues extra concept **Ads**; it does **not** make Director drive the live camera prompt.
- **Director does not drive video titling or the camera prompt** (PR #11) — **even when `directorVariants` is on.** Layout-input / title template for video is **canonical `ai_brand_led`** unless Title Studio overrides cascade (below). `creative_style` / `archetype` / `art_direction` are ignored for the camera prompt and for video titling.

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

**Camera-only by design** (`atlasVideoService.js:2593-2620`). Code comment: *"Camera-only prompt — the canonical brand-script overlay composites all on-screen text downstream from ad.copy + LayoutInputArtifact."* `buildVeoPrompt` receives **no Director concept** — args are `{brand, product, media, layoutInput, sourceMedia, aspectRatio, seedHasText, hasProductReference, storyboard, caps, durationSec}`. A generic-looking Omni prompt is intentional, not a wiring gap. **Do not** "fix" it by plumbing `art_direction` / `creative_style` / `archetype` into the camera prompt. **Levers:** `videoPromptGuidance` (prepend), the canonical directives inside `buildVeoPrompt`, and `videoPromptRaw` (full replace). **Current objective: tune the canonical prompt**; archetype-driven video is deferred.

#### Full PR #61 camera-prompt rollback (owner 2026-08-03)

Commit `134db56` (PR #61) added three camera-prompt changes in `services/veoPromptBuilder.js`. **All three are reverted** (shipped `be5b83f`). Owner, verbatim: *"This is creating additional hallucinations and the previous output was better."*

| # | Reverted piece |
|---|---|
| 1 | Scene 3 "RETURN TO THE PRIMARY VIEW" + two PRODUCT FIDELITY sentences claiming the FINAL reference repeats the primary view |
| 2 | `subjectContinuity` directive — both `OMNI_DIRECTIVES` and `GROK_DIRECTIVES`, plus its `lines.push` in `buildVeoPrompt` |
| 3 | Crossfade-vs-long-dissolve policy rewording |

**Mechanical acceptance test (worth treating as such):** the file now differs from `git show 134db56~1:services/veoPromptBuilder.js` in exactly **two hunks**, both comment/export only (rollback comment block + `OMNI_DIRECTIVES` / `GROK_DIRECTIVES` module exports for harnesses) — **zero prompt-string hunks**. Pinned by `scripts/verifyPostPilotBatch.js` (B1–B14). **B14** rebuilds the prompt from the `134db56~1` source out of git (`git show` only; skips loudly if the baseline is unreachable) and asserts byte-identity.

**CRITICAL — the restored text is deliberately self-contradictory.** `transitions` permits "Smooth crossfades only, ~0.25s" while `doNot` bare-bans "dissolves", and a crossfade **is** a short dissolve. Owner-confirmed after the contradiction was pointed out: that contradictory pair is the version that produced better output. **Anyone "fixing" it is reintroducing the regression.** Do not soften, split, or reword either string to resolve it (`veoPromptBuilder.js:193-207` comment block).

| Field | Semantics |
|---|---|
| **`videoPromptGuidance`** | Short operator note (≤1000 chars). Merged as **`operatorPrompt` prepend** inside `buildVeoPrompt` via the guidance cascade above. |
| **`videoPromptRaw`** | Full prompt replacement (≤4000 chars body validation). **FULL replacement** of canonical — logs *"canonical directives bypassed"*; clamped with `enforceRawByteCap` to the model’s `promptByteCap`. |

**`generateForAd` priority** (`atlasVideoService.js:2595-2620`):

1. Explicit **`operatorPrompt`** argument (regenerate UI) — non-empty after trim → **prepended** to canonical via `buildVeoPrompt({ operatorPrompt })`.
2. Else **`ad.videoPromptRaw`** — **full replacement** of canonical (bypasses `buildVeoPrompt`); byte cap.
3. Else guidance cascade (`videoPromptGuidance` via `resolvePromptGuidance`) → **prepended** to canonical via `buildVeoPrompt({ operatorPrompt: effectiveGuidance })`.

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

- Downstream of base video: `brandScriptExecutor` → **Remotion only**. There is no working canvas override — `resolveTitlingEngine` returns `{ engine: 'remotion' }` **unconditionally** (`brandScriptExecutor.js:913-922`); the cascade below it is inside `/* … */`. `TITLING_ENGINE` and `videoSettings.titlingEngine` are inert. See `docs/TITLING.md` §0. **Was falsely cited at `:806`** — that line region is now `deriveTheme`.
- Title template for layoutInput derivation is **canonical `ai_brand_led`** unless cascaded `titleTemplate` override.
- Placement mode / engine: see `docs/TITLING.md` (`titlePlacementMode`, `titleStyleSpec` cascade including category).
- **Does not use overlay zones** — text is scripted, not zone-driven product overlay.
- **Quote gate on video:** `buildMetaForAd` runs `gateLayoutInputQuotes` → `toPrintableCustomerQuote` on `primary_quote` before Remotion chrome typesets it (`brandScriptExecutor.js` ~588-646, call at ~679). Same allowlist as static. **Was false:** video path did not dual-gate.

### Master → titling outcome (money + status)

**Untitled video is no longer a success** (`routes/ads.js:1258-1361`):

1. Omni master lands → stamp `veoVideoUrl` / `renderUrl` and set `status:'draft'` **before** titling. Intermediate draft is deliberate: without it a crash mid-titling leaves `rendering`, the reaper requeues, and the next drain **pays Omni again**.
2. Remotion titling runs (`adStage` `titling <aspect>`). No-chrome is intentional success (raw master ships).
3. If titling **throws**: ad → `status:'failed'`, `renderStage: 'master rendered; titling failed'`, counted against the run’s `failed`; **raw master KEPT** (it was paid for). Not counted as `succeeded`.
4. Only after clean titling (or deliberate no-chrome) is the run’s `succeeded` counter incremented and `adStage(…, 'done')`.

**Known open (do not claim fixed):**

- **Remotion titling fatal on `library-match` fonts (verified 2026-08-04).** Root cause is a path mismatch: `library-match` Inter resolves to `fonts/Inter.ttf`, but `assetPathFor` maps `/fonts/*` only to `FONT_CACHE_DIR` (`assets/webfonts`) → **404**; the 404 branch set no CORS header so `FontFace.load()` rejects; and installed `@remotion/fonts` `load-font.js` ends `catch (err) { cancelRender(err) }` — so `FontLoader.jsx`'s ".catch → using fallback stack" is a **false safety net** (runs after cancel, cannot un-cancel). `Could not extract frame from compositor / Request closed` is **downstream collateral**, not the fault. Control proof: brands whose fonts resolve via Google (files really in `webfonts/`) render clean. **Fix branch** `fix/remotion-font-fatal-load` exists (working tree; not authorised to commit as of the 2026-08-05 pickup) — see `session.md` §0. **Do not re-claim "font 404 is a red herring."**
- `veoPredictionId` is a spend receipt that is **never resumed** — process death + re-drain can double-bill.
- `queued` ads still never auto-drain after web-process death (reaper only flips `rendering` → `queued`).
- Static: ~1-in-3 ads render a competitor-shaped brand mark on the product (prompts already demand fidelity — fix is measure-and-reject, not prompt tuning). **Video path not QC’d** for the same defect 2026-08-03. **Still open after the 2026-08-03 product-fidelity prompt hardening** — that is owner-directed work layered on top, not a fix for this, and `adVisionQcService` remains the actual fix. The static prompt now opens with `staticAdIntents.PRODUCT_FIDELITY` (source-of-truth, no category/brand-prior inference, preserve form/construction/surface/colour/on-item-graphics/details/condition), plus carve-outs in `absences` and `textBlock` so the no-added-text rules cannot strip the product's own printed label. Kill switch `STATIC_PROMPT_FIDELITY_HARDENING=false` restores a **byte-identical** pre-hardening prompt (block + both carve-out sites revert together). **Watch for a text-fidelity regression:** the prompt more than doubled (~3.5-4.1k → ~7.8-8.4k chars) and sits above `SET EXACTLY THESE STRINGS`, whose measured baseline is 139/140 strings over 20 renders. Pinned by `scripts/verifyStaticFidelityPrompt.js` (419 checks, both arms).
- Meta surface preview chrome still shows placeholder copy (“Lorem ipsum dolor sit amet”) in places — preview-only furniture, not burned-in titles.

### Wizard controls (frontend PR #10; backend contract)

| Control | Backend field | Default / notes |
|---|---|---|
| Director toggle | `directorVariants` | **Off** — product runs get det video only; on → also queues concept video (capped) |
| Ordered catalog seed picker | `seedMediaIds` | Order-significant; empty → hero default |
| Guidance / raw Advanced editor | `videoPromptGuidance` / `videoPromptRaw` | Scaffold from `GET /api/ads/veo-prompt-scaffold` |
| Preview counts | `POST /api/ads/preview` `dryRun` | Response includes `byMode: { deterministic, director }` |

### Stages / files

**"veo" is a legacy name — the live model is Omni.** `BUILT_IN_DEFAULT_MODEL` is `google/gemini-omni-flash/image-to-video-developer`; `ATLAS_VIDEO_MODEL` is blank in `defaults.env`, so that default runs. Everything spelled `veo*` / `AI_VEO_*` / `renderRoute:'veo'` is this pipeline wearing an old name.

| Piece | File | Role |
|---|---|---|
| Expansion + det digest + merge + selection | `services/campaignAdsGenerationService.js` | Routing, `expandDeterministicVideo`, `selectAdsForRun`; concept reads via `conceptProjection` |
| Category chain | `services/categoryChainService.js` | Leaf→root Category docs for cascades |
| Atlas submit/poll + refs + model/prompt resolve | `services/atlasVideoService.js` | `generateForAd`, `buildReferenceImages`, resolvers, scaffold; poll ticks write `adStage` |
| Per-ad stage telemetry | `services/adStage.js` | Fire-and-forget `renderStage` writes; never awaited |
| Camera prompt builder | `services/veoPromptBuilder.js` | `buildVeoPrompt`, `enforceRawByteCap` |
| Title style cascade | `services/titleSpecService.js` | `resolveSpec` (ad > product > category > brand) |
| Brand title/script composite | `services/brandScriptExecutor.js` | Titling over base video + video quote gate |
| Provider router | `services/videoRouter.js` | `VIDEO_PROVIDER` → atlas / vertex |
| Storyboard text (Vertex / legacy) | `services/veoStoryboardService.js` | GPT storyboard when that path uses it; **Atlas path retired storyboard** (Ken Burns prompt is complete) |
| Direct Veo fallback (deprecated) | `services/aiVideoReferenceService.js` | `VIDEO_PROVIDER=vertex` |

**Render-loop stage map (video)** — `routes/ads.js` + `atlasVideoService` + `brandScriptExecutor` piggyback existing poll ticks (`ATLAS_POLL_INTERVAL_MS` 15s). No new timers.

| Stage string (examples) | When |
|---|---|
| `reusing video seed segment (no generation)` | Seed Media is already video → Cloudinary 8s segment, skip Omni |
| `preparing video context` | Pre-submit: model/aspect resolve, layout warm |
| `master video generation (9:16)` | Outer marker before `generateForAd` |
| `reference reframe (…)` | Generative reframe / pad ladder on reference images |
| `master video submit (…)` / `master video generation (…) — polling 4m10s (17)` | Inside Atlas submit/poll (`adStage` on each poll tick) |
| `downloading master video` / `mirror upload` | Post-terminal fetch + Cloudinary |
| (intermediate) `status:'draft'` + raw master on `renderUrl` | Money guard before titling — not a success claim |
| `face-safe crop (…)` | `basePlateCropService` / `brandScriptExecutor` — crop 9:16 master → surface AR |
| `titling …` / `uploading titled video (…)` | Remotion composite + upload |
| `no titling (…) — shipping master` | Intentional no-chrome success |
| `master rendered; titling failed` | Titling threw; master kept, status `failed` |
| `done` | Clean success only |

### Models & cost

- Atlas image-to-video (**default Gemini Omni**; Grok / Veo slugs in `MODEL_CAPS` as fallbacks) — Omni RPS **unpublished/unmeasured**. Same-model video submits paced by `pacedModelSubmit` (`ATLAS_SUBMIT_SPACING_MS` default 1200ms). Grok (aspect-fallback only) stays ≤1 RPS via `GROK_MAX_RPS` floor regardless of `VEO_CONCURRENCY`.
- **Was false:** "429s if concurrency > 1 / keep VEO_CONCURRENCY=1". That justification belonged to retired direct Google Veo and to Grok’s documented 1 RPS — not the primary Omni path. Current default **`VEO_CONCURRENCY=4`** (2026-08-02 probe). Re-measure before raising further.
- Resolution default **`ATLAS_VIDEO_RESOLUTION=1080p`** — same list price as 720p on Omni; matches Meta `deliveryDims` (all 1080-wide).
- **Submit count (money):** Meta live presets = **1** Omni master per product. Google `google_video` = **2** Omni masters per product (9:16 + 16:9 at 10s); the 1:1 is free crop+retitle. **MEASURED unit costs (Phase B, settled prediction prices):** 10s Omni master on the **developer** model = **$0.90** (not the $1.20 `MODEL_CAPS` formula — that overstates developer by ~33%); 3-size PMax static fan-out ≈ **$0.199**/concept. Full kit (3 concepts × 3 statics + 2 masters) ≈ **$2.40** standalone / ≈ **$1.50** marginal beside a Meta run that already paid for 9:16. Earlier planning figure ≈$2.6 is **superseded**. No full end-to-end app run yet — see [*Measured PMax unit costs*](#measured-pmax-unit-costs-phase-b-live-submits-2026-08-1011) and `session.md`.
- **Ledger reconcile (post-Phase-B):** video now upgrades `costSource:'estimated'` → `'actual'` from the settled prediction (images already did). Immediate reconcile when the terminal poll carries `price` (normal for video); scheduled re-poll otherwise. See [*Video cost reconciliation*](#video-cost-reconciliation-post-phase-b). A remaining `estimated` video row means **price never published**, not "trust the formula."
- Per-ref generative reframe (nano-banana-2 class edit when enabled) — ladder is exact-fit skip → product-only $0 pad → outpaint → $0 pad fallback; outpaint billed at `REFRAME_COST_USD` per image (default `$0.08` @ `4k`), cached per media+aspect on first success. Product-only shots (`Media.classification.shotType`) never reach the billable POST.
- LayoutInput derivation (Gemini / existing builder) when artifact missing — non-fatal.
- GPT storyboard only on non-Atlas paths that still call it.

### Env knobs

| Var | Default | Role |
|---|---|---|
| `VIDEO_PROVIDER` | `atlas` | `atlas` \| `vertex` |
| `AI_VEO_FEED` | `true` | Enable video for non-Reels formats |
| `AI_VEO_REELS` | `true` | Enable video for 9:16 Reels |
| `VEO_CONCURRENCY` | **`4`** | Self-imposed in-flight video ads per run (raised 1→4 2026-08-02; re-measure before higher) |
| `VEO_ADS_PER_PRODUCT_CAP` | `1` | Cap on **concept** video variants only (not deterministic) |
| `DERIVE_MASTER_WAIT_MS` | `720000` (12 min) | In-render wait ceiling for the derive-only path to see the master's plate (`routes/ads.js`). Do **not** "fix" by requeueing — see [Google PMax video](#google-performance-max-video-phase-a-2026-08-10) |
| `DERIVE_MASTER_POLL_MS` | `10000` (10s) | Poll interval while waiting for the master plate |
| `PMAX_VIDEO_DIRECTIVES` | **`true`** | Phase B: PMax destinations use `PMAX_DIRECTIVES` in `veoPromptBuilder` (hook-first, centre-safe, aspect-aware Frame). Meta camera prompt untouched. `false` → Omni/Grok canonical profile for PMax too |
| `PMAX_PROOF_STRONG_RATING` | `4.5` | Phase B: interpolated into the PMax-only Director hierarchy (RATING-FIRST vs POPULARITY). Meta never sees it |
| `PMAX_PROOF_MIN_REVIEW_COUNT` | `100` | Phase B: interpolated "substantial count" floor for the PMax hierarchy. Below this, omit the count |
| `VEO_USE_GPT_STORYBOARD` | `true` | Storyboard on paths that still use it (not Atlas Ken Burns) |
| `ATLAS_VIDEO_FORCE_CHROME` | `true` | Force chrome handling on Atlas path |
| `ATLAS_POLL_INTERVAL_MS` | `15000` (`defaults.env`; code fallback `5000`) | Prediction poll interval (+ stage piggyback) |
| `ATLAS_VIDEO_RESOLUTION` | `1080p` | Omni output; same list $ as 720p |
| `ATLAS_VIDEO_MODEL` | (empty) | Optional model override in resolve chain; empty → Omni built-in |
| `ATLAS_SUBMIT_SPACING_MS` | `1200` | Same-model **video** submit spacing |
| `GROK_MAX_RPS` | `1` | Provider ceiling on Grok Imagine submits |
| `REFRAME_ENABLED` | `true` | Master switch for generative reframe of video reference images; `false` → Cloudinary crop only |
| `REFRAME_OUTPAINT_MODEL` | `google/nano-banana-2/edit-developer` | Atlas image-edit model for outpaint (billable per image, single submit; `-developer` is a half-price billing variant, not a lower-fidelity tier) |
| `REFRAME_RESOLUTION` | `4k` | Outpaint output resolution (`1k`\|`2k`\|`4k`). `4k` per operator decision (2026-07-24) after reviewing 20 live generations side by side — held product geometry better than `1k`; the reframed reference is also surfaced at full size in the generation inspector. The video render itself is **`ATLAS_VIDEO_RESOLUTION=1080p`** (same list $ as 720p on Omni) — **was falsely documented as "stays 720p"** |
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
- Per-ad stage strings on `Ad.renderStage` via `adStage` (see stage map above). Floor `AD_STAGE_MIN_MS` (~3s) throttles same-phase poll rewrites.

### Consumers

- Video `Ad` assets, Meta Reels / feed push, retitle batch (`POST /api/brand/:id/retitle-videos` — see `docs/TITLING.md`), generation inspector (`veoPrompt`, `veoReferenceImages`, `referenceMediaIds`).

---

## 7. Progress + activity system

> **Out-of-band alerting:** progress rows are in-app only — nobody sees them
> unless a browser is open. Push alerts for crashes, dropped work, stalled
> runs, and spend spikes go to **Slack** (`services/alertService.js`); see
> **[docs/ALERTING.md](ALERTING.md)**. **Telegram is gone** — there is no
> Telegram transport, token, or channel left in the live path.
>
> **Slack config:**
> - **Only secret:** `SLACK_BOT_TOKEN` — service-level Render env var on **both** web and worker.
> - **Channels are committed** non-secrets in `config/defaults.env`: `SLACK_ALERT_CHANNEL`, `SLACK_ALERT_CHANNEL_FATAL`, and `SLACK_ALERT_CHANNEL_STATUS` (**recorded but READ BY NOTHING** — reserved for a per-run live feed that is **not built**).
> - **CRITICAL API trap:** Slack returns HTTP 200 with `{ok:false,error:…}` on logical failure (bad token, `channel_not_found`, `not_in_channel`, …). Checking `res.ok` alone reports success while nothing was delivered (`alertService.js:220-240`). Always require `body.ok === true`.
> - Boot: worker logs `🔔 alerts: Slack configured` when the token is present (`worker.js`).
>
> That doc also records *why* video batches stall: `runRenderLoop` executes
> in the **web** process, which Render replaces on deploy **and** on
> autoscale (`min 1 / max 3`, CPU+memory at 60%), and reaped ads land in
> `queued` where nothing drains them automatically (**still known-open**).

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

Single resolver: `services/concurrency.js` (frozen `concurrency` object; boot logs the table). `defaults.env` + code defaults agree on the numbers below as of 2026-08-03.

| Knob | Default | Ceiling kind / notes |
|---|---|---|
| `WORKER_CONCURRENCY` | **5** | SELF — DetectRun / job poll workers |
| `RENDER_CONCURRENCY` | **8** | SELF — in-flight static/image ads per run. File raised 4→8 (2026-08-02): unpaced `gpt-image-2/edit` measured clean (85s wall, zero 429s). **Became live in prod on 2026-08-03** when the Render dashboard pin of 4 was deleted as part of the secrets-only migration (dotenv never overrides an already-set var — the file change alone did not move prod for a day). Doubling was a consequence of that cleanup, not a separate tuning decision. **Was also falsely documented as "Puppeteer pool"** — the live pool is direct-image Atlas submits |
| `VEO_CONCURRENCY` | **4** | SELF — in-flight video ads per run. Raised 1→4 (2026-08-02) as an Omni probe. **Was falsely documented as "keep at 1 — provider 429s"**; that belonged to retired direct-Veo + Grok 1 RPS, not Omni. Re-measure before >4 |
| `MAX_CREATIVES_PER_RUN` | 20 | SELF — ads claimed into one `CampaignRun` |
| `ATLAS_SUBMIT_SPACING_MS` | 1200 | SELF — same-model **video** submit spacing only; image submits unpaced |
| `GROK_MAX_RPS` | 1 | **PROVIDER** — env may lower, cannot raise above 1; floors Grok slug spacing independent of `VEO_CONCURRENCY` |
| `CATALOG_ENRICHMENT_CONCURRENCY` | 6 | SELF — enrich auto + full path |
| `GENERIC_CATALOG_PDP_CONCURRENCY` | 5 | SELF — parallel PDP fetches (no crawl-delay) |
| Category inference concurrency | **6** | SELF — post-sync; per-domain throttled |
| `HTTP_SCRAPE_DOMAIN_CONCURRENCY` | 3 | In-flight HTTP per host |
| `DIRECTOR_UNIVERSE_TOP_N` | **1** | Not a render pool — Director seed window (see §5) |

`runRenderLoop` runs **two pools in parallel** (`routes/ads.js:960-961`): `veo` at `VEO_CONCURRENCY` and `image` at `RENDER_CONCURRENCY`. Mixed batches no longer collapse both kinds onto one knob.

---

## 9. Configuration & secrets

Owner rule (2026-08-03), verbatim: *"The dashboard in render should only contain secrets, everything else should be editable outside of the dashboard."* **Migration COMPLETE 2026-08-03.**

**This section is CANONICAL for configuration ownership** — the precedence rule, the delete rule, and the per-key "stays in Render env" inventory below. It is deliberately here rather than in `CLAUDE.md`, because env vars are edited by humans and by other agents, not only by Claude sessions. `CLAUDE.md` §4a carries the same *rules* as a summary for Claude sessions and points back here for the key list; it must **not** grow its own copy of the inventory. If the two ever disagree, this file wins.

### Precedence (the trap)

`index.js:1-5` and `worker.js:18-20` load the process environment **first** (Render dashboard / local `.env`) and `config/defaults.env` **second**. `dotenv` **never overrides an already-set var**. A dashboard var always wins; a value in `defaults.env` is the effective value **only** when no dashboard var of that name exists. A var set in **both** with **different** values is a silent config lie — that is exactly how `RENDER_CONCURRENCY` stayed at 4 in prod for a day after the file said 8. Diagnostic: compare the live dashboard key list against `grep -oE '^[A-Z_][A-Z0-9_]*=' config/defaults.env`.

**Delete rule:** only delete a dashboard var that exists in `config/defaults.env` with an **identical** value. A dashboard-only var must be **migrated into the file first**, never just deleted.

### Non-secret config — `config/defaults.env`

Versioned with the repo. Feature flags, tuning knobs, public IDs/URLs, Slack channel ids. **Never put secrets in this file** — it is committed to git.

**Categories in `defaults.env`:**

| Category | Examples |
|---|---|
| AI creative feature flags | `AI_CONCEPT_DRIVEN`, `AI_HTML_LAYOUT_ENABLED`, `AI_LAYOUT_DIRECT_HTML`, `CANONICAL_DR_V1`, `RENDER_USE_HTML`, `RENDER_USE_RESOLVED` |
| Director seed window | `DIRECTOR_UNIVERSE_TOP_N=1` |
| Static regenerate reseed | `REGEN_RESEED_CATALOG_FIRST=true` (default ON; kill switch for catalog-first reseed on regenerate — see §5) |
| Static direct-image path | `AI_DIRECT_IMAGE_*` (edit model / quality / timeout). `AI_IMAGE_REFERENCE_*` kept **inert** (no live consumer) |
| PMax Phase B creative knobs | `PMAX_STATIC_PLATFORM_NOTES=true`, `PMAX_VIDEO_DIRECTIVES=true`, `PMAX_PROOF_STRONG_RATING=4.5`, `PMAX_PROOF_MIN_REVIEW_COUNT=100` (prompt text only — not money knobs; Meta byte-identity when static/video flags on or off) |
| Video (Omni under `veo*` names) | `AI_VEO_FEED`, `AI_VEO_REELS`, `AI_VIDEO_POSTER_ENABLED`, `VIDEO_PROVIDER`, `VEO_USE_GPT_STORYBOARD`, `ATLAS_*`, `VEO_CONCURRENCY=4`, `REPEAT_PRIMARY_REFERENCE=false` |
| Concurrency | `WORKER_CONCURRENCY`, `RENDER_CONCURRENCY=8` (**live since 2026-08-03** — see above), `VEO_CONCURRENCY=4`, `ATLAS_SUBMIT_SPACING_MS`, `GROK_MAX_RPS`, `MAX_CREATIVES_PER_RUN` — resolved via `services/concurrency.js` |
| Slack alert channels (non-secret) | `SLACK_ALERT_CHANNEL`, `SLACK_ALERT_CHANNEL_FATAL`, `SLACK_ALERT_CHANNEL_STATUS` (per-run live feed via `runFeedService`) |
| Ingest tuning | `APIFY_*`, `POST_FETCH_LIMIT`, `CATALOG_SYNC_MAX_ITEMS`, `CATALOG_VISUAL_MATCH_MAX_IMAGES` |
| Generic catalog scraper | `GENERIC_CATALOG_*`, `HTTP_SCRAPE_MIN_GAP_MS` |
| Catalog detect / enrichment | `CATALOG_DETECT_PRECOMPUTE`, `CATALOG_ENRICHMENT_*` |
| Public IDs / URLs | Cloudinary cloud name, frontend URLs, Google/Meta client IDs & redirect URIs, Jira base/email, sales-demo admins, Shopify store domain |

Channel ids are not secrets; bot tokens are.

### Stays in Render env (secrets + one deliberate exception)

Verified live 2026-08-03 after the cleanup; **WORKER recount 2026-08-04** after `ATLAS_API_KEY` was added. **WEB service** (`srv-d1vuktqli9vc73ft07ng`): **23** keys. **WORKER** (`srv-d8128c1o3t8c73e8kb30`): **15** keys. Everything else that used to live on the dashboard and also lived in `defaults.env` with the same value was deleted (runtime no-ops).

| Key | WEB | WORKER | Used for |
|---|---|---|---|
| `APIFY_TOKEN` | ✓ | | Apify actors (IG / Shopify scrapers) |
| `ATLAS_API_KEY` | ✓ | ✓ | Atlas video / image / LLM gateway |
| `BRANDFETCH_API_KEY` | ✓ | ✓ | Brand enrichment |
| `CLOUDINARY_API_KEY` | ✓ | ✓ | Media storage |
| `CLOUDINARY_API_SECRET` | ✓ | ✓ | Media storage |
| `GEMINI_API_KEY` | ✓ | ✓ | Vision, grounded search, overlay zones |
| `GOOGLE_ADS_CLIENT_SECRET` | ✓ | | Google Ads integration |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | ✓ | ✓ | Google Ads integration |
| `GOOGLE_CLIENT_SECRET` | ✓ | | Google OAuth (app login) |
| `INTEGRATION_ENCRYPTION_KEY` | ✓ | ✓ | Encrypted integration credentials at rest |
| `JIRA_API_TOKEN` | ✓ | | Jira integration |
| **`JIRA_PROJECT_KEY`** | ✓ | | **Not a secret.** Retained because it does **not** exist in `config/defaults.env` — deleting it would lose the value with nothing to fall back on. Migrate into the file before ever deleting the dashboard copy. |
| `JWT_SECRET` | ✓ | | Auth tokens |
| `META_APP_SECRET` | ✓ | ✓ | Meta / Instagram OAuth & webhooks |
| `MONGODB_URI` | ✓ | ✓ | Database |
| `OPENAI_API_KEY` | ✓ | ✓ | GPT / image models (direct OpenAI paths) |
| `RENDER_AUTH_TOKEN` | ✓ | | Render-protected service auth |
| `SERPAPI_API_KEY` | ✓ | ✓ | Shopping / immersive product enrichment |
| `SESSION_SECRET` | ✓ | | Session cookies |
| `SHOPIFY_ACCESS_TOKEN` | ✓ | ✓ | Shopify API |
| `SHOPIFY_API_KEY` | ✓ | ✓ | Shopify API |
| `SHOPIFY_API_SECRET` | ✓ | ✓ | Shopify API |
| **`SLACK_BOT_TOKEN`** | ✓ | ✓ | **Only** alerting secret. Channels live in `defaults.env` |

No Telegram secrets remain. Alerts stay disabled until `SLACK_BOT_TOKEN` is set.

**`ATLAS_API_KEY` on WORKER (added 2026-08-04):** post-cleanup this table marked it WEB-only, but that was a **config gap**, not a design choice — the worker reaches Atlas LLM code on every DetectRun (`atlasLlmService.js:52` `isConfigured()` is `!!process.env.ATLAS_API_KEY`; cropRefine / overlayZone / subjectText / judge all fall back to direct OpenAI/Gemini when unset). Verified live via Render API: WEB had it, WORKER did not (env-group "Liquid Retail" has zero vars), worker logged `ATLAS_API_KEY not configured` continuously until the key was copied onto WORKER (14 → 15) and redeployed; zero such lines after the 16:24Z boot. **Billable consequence:** the key flips `geminiImageService.viaAtlasOrDirect` (`services/geminiImageService.js:12`) onto Atlas `nano-banana-2/edit` for DetectRun extended crops — up to 4 billable image edits per **non-catalog** DetectRun. Catalog DetectRuns are unaffected (`pipelines/detect.js:628` `skipExtendedCrops: true`). Measured 2026-08-04: 115 detect runs in 24h, **all catalog**, **zero** extended-crop activity — exposure is real but currently dormant. Provider **shift** (those crops already billed Gemini direct), not new spend from zero.

**The one non-no-op of the cleanup:** `RENDER_CONCURRENCY`. Dashboard had pinned **4** while the file said **8**; deleting the dashboard copy made the file's **8 live on 2026-08-03**. That is a real concurrency double, not a no-op — consequence of the migration, not a separate tuning decision.

---

## 10. Ad recency — "last activity" must read `renderedAt`, never `generatedAt` alone

**The trap (production incident 2026-08-05).** `Ad.generatedAt` (`models/Ad.js`) is stamped **once**
when the row is created and is **never updated again** — not by a fresh render
(`services/renderService.js` `persistStage`, which writes `status`/`renderedAt`/`renderUrl`) and not
by dedupe-reuse (`routes/ads.js` `claimAdsForRun`, which only `$addToSet`s `campaignRunIds` and flips
status). `renderedAt` **is** written on every real render, including a re-render of a reused row.

So any surface that ranks or badges "recent activity" by `generatedAt` reports **row age, not
activity**. Measured live: brand "Pelagic Gear" generated 12 ads (10 rendered successfully with real
Cloudinary URLs) at 17:17–17:21Z; because those rows had been created 2026-07-30 under an earlier run
and were dedupe-reused, the `/product-ads` page badged the product **"Last Activity ~6 days ago"**
and ranked it #3-5 — the operator could not find the ads at all and reported "the latest ads there
are several hours old". Nothing was broken in generation; the data was invisible.

**The rule: read recency through `services/adRecencyService`, never a bare `$generatedAt`.**
- `AD_RECENCY_EXPR` = `{ $ifNull: ['$renderedAt', '$generatedAt'] }` — for `$group`/`$addFields`.
- `resolveAdRecency(adLike)` = `adLike.renderedAt || adLike.generatedAt || null` — for plain objects.
- `generatedAt` keeps its own meaning ("row first existed"). This is a **read-time projection only**;
  nothing writes either field. Precedent already in-tree: the generation-inspector endpoint
  (`routes/ads.js`) has long used `ad.renderedAt || ad.generatedAt || ad.createdAt`.

**Four call sites, all fixed 2026-08-05.** `routes/catalog.js` (`buildAdStatsByProduct` `$group`,
and `/:id/ads-detail`), `routes/campaigns.js` (`/ads-summary` `$group`, and its own `/:id/ads-detail`
— a near-mirror of catalog's that an adversarial review caught still on the old sort), and
`routes/ads.js` (`GET /api/ads`).

Two things that look like reasonable shortcuts and are **wrong**:
1. **A compound `.sort({renderedAt:-1, generatedAt:-1})` on `.find()` is NOT equivalent.** BSON sorts
   `Date` above `null` unconditionally, so it tiers every ever-rendered ad above every
   not-yet-rendered one regardless of wall-clock recency. Sorting on a coalesced value requires an
   aggregation (`$addFields` a `_recencyAt`, then `$sort` it) — which is why those two `.find()`
   call sites became `Ad.aggregate`.
2. **A filter object reused between `.find()` and an aggregation `$match` must be cast explicitly.**
   Mongoose auto-casts `.find()` filters against the schema; the driver's `$match` does **not**. So
   `brandId`/`campaignId` need `new mongoose.Types.ObjectId(...)` once the query is an aggregation,
   or the `$match` silently returns nothing. `campaignRunIds` is a plain `[String]`, so a bare
   equality is a correct contains-match (same convention as `/render-activity`).

**Cost of the aggregation conversion, accepted knowingly:** `$sort` on a computed field cannot use
`{brandId:1,status:1,generatedAt:-1}` / `{campaignId:1,generatedAt:-1}`, so these sorts are no longer
index-backed. `allowDiskUse: true` is set on the unbounded ones so a large brand cannot 500 the list
endpoint on the 100MB in-memory sort limit. **Not yet measured on the largest brand** — if the ads
list gets slow, this is the first thing to look at.

**Also 2026-08-05: `GET /api/ads` accepts `campaignRunId`** as a real DB-level filter. The Ads page
previously fetched an unscoped, `generatedAt`-sorted, 120-row-capped page and filtered it
**client-side** by run, so a fresh batch outside that window vanished. A containment `$match` cannot
be pushed off a page by a stale sort key; the client filter is retained as a harmless no-op. The
frontend redirects that feed it (`Step4Generate.tsx`, `Campaigns/index.tsx`) were also missing
`campaignId` entirely — fixed in the `liquidretail` repo.

**Pinned by `scripts/verifyAdsRecency.js` (21 checks).** Note check 1.11/1.12 are the general form —
they assert **no** `.sort({generatedAt:-1})` ad query remains in either route file, rather than
naming sites, because the campaigns mirror is exactly what a named-site-only harness missed.

---

## Quick map: file → pipeline

| Concern | Primary files |
|---|---|
| Generic catalog resolve/save | `services/genericCatalogResolver.js`, `genericCatalogIngestService.js`, `httpScrapeClient.js`, `breadcrumbParser.js` |
| Post-sync trio | `genericCatalogIngestService.js` (end-of-run), `catalogProductDetectService.js`, `catalogProductEnrichmentService.js`, `productCategoryInferenceService.js` |
| Detect / overlay / readiness | `pipelines/detect.js`, `yoloService.js`, `overlayZoneService.js`, `adSuitabilityService.js`, `worker.js` |
| Enrichment | `catalogProductEnrichmentService.js`, `productDetailsService.js` |
| Quote provenance | `quoteProvenance.js` (`toPrintableCustomerQuote`), `layoutInputService.js` (pool), `brandScriptExecutor.js` (video gate) |
| Concept dual-read (v2/v3) | `conceptProjection.js` — **only** sanctioned reader of Director routing fields |
| Per-product expand reasons | `perProductReasons.js`, stamped on `CampaignRun.perProduct` |
| Static ads (default direct-image) | `routes/ads.js`, `campaignAdsGenerationService.js`, `directImageRenderService.js`, `staticPipeline.js`, `renderService.js`, `atlasImageService.js`, `adStage.js` |
| Static ads (legacy HTML only) | `aiCanvasHtmlGeneratorService.js`, Puppeteer arm of `renderService.js` — only `Brand.staticImagePipeline==='html'` |
| Video (deterministic-first + director opt-in; Omni under `veo*`) | `campaignAdsGenerationService.js` (expand/select + `resolveDeriveFromMaster` / `GOOGLE_VIDEO_MASTERS`), `atlasVideoService.js`, `veoPromptBuilder.js`, `categoryChainService.js`, `titleSpecService.js`, `brandScriptExecutor.js`, `videoRouter.js`, `adStage.js`, `routes/ads.js` (`/preview`, `/generate`, `/runs` + `claimAdsForRun`, `/formats`, `/veo-prompt-scaffold`, `renderDeriveOnlyVideoAd`), `adRegenerateService.js` (shared derive gate in preflight), `routes/catalog.js` (`PATCH .../categories/:id`) |
| Google PMax surfaces (Phase A + B + post-B addendum) | `platformFormats.js` (`GOOGLE_*_FANOUT`, `GOOGLE_VIDEO_MASTERS`), `staticAdIntents.js` (`GEN_SIZES` + `SURFACE_EDGE_MARGIN_PCT` + `PLATFORM_NOTES` / `resolveDrawCta`), `veoPromptBuilder.js` (`PMAX_DIRECTIVES`), `aiCreativeDirectorService.js` (funnel + proof hierarchy; `DIRECTOR_SIGNALS_VERSION` 3.3.0), `brandScriptExecutor.js` / `remotionRenderService.js` / `remotion/lib/safeZones.js` (Yt zone wiring; funnel presets remain **8s** — 10s re-time reverted), `atlasVideoService.js` (video cost reconcile), `campaignAdsGenerationService.js`, `routes/ads.js` derive path, `scripts/verifyPmaxVideoExpansion.js`, `scripts/verifyPmaxPromptOverlay.js`, `scripts/verifyVideoCostReconcile.js` |
| Concurrency table | `services/concurrency.js`, `config/defaults.env` |
| Alerting | `alertService.js` (Slack), `processAlerts.js` (worker watchdog) |
| Progress | `progressService.js`, `models/OperationRun.js`, `routes/progress.js`, `routes/salesDemos.js` (`/activity`) |
| Config | `config/defaults.env`, `index.js`, `worker.js` |

Related docs: `docs/PROGRESS.md` (progress/cancel details), `docs/ai-creative-pipeline.md` (creative depth), `docs/ATLAS.md` (Atlas migration), `docs/TITLING.md` (video titling engine), `docs/ALERTING.md` (Slack).
