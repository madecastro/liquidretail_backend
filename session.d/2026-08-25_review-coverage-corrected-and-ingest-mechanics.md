# 2026-08-25 — review coverage corrected; how ingest actually fills ratings

Written for two engineers joining cold. Everything below is measured against
production, not inferred.

---

## 1. The correction that matters most

The strategy document states **"product-specific review quotes: 80.5% of 1,233 live
SKUs."** That number is (a) the **ungated** count — products where
`productReviews.quotes[]` is merely non-empty — and (b) measured on a catalog that is
69.7% Pelagic Gear. It is not printable coverage and it does not generalise.

Measured 2026-08-25 across six brands, `catalogproducts`, 4,424 documents:

| Brand | Products | >=1 quote | `scraped` | `llm-web` | rating > 0 |
|---|---|---|---|---|---|
| Pelagic Gear | 837 | 770 | 758 | 12 | 765 |
| Soludos | 194 | 50 | 20 | 30 | 172 |
| Soludos GS | 202 | 193 | 159 | 34 | 184 |
| PB5star | 99 | 93 | 6 | 87 | 6 |
| Peloton Apparel | 1,492 | 491 | 25 | 466 | 25 |
| Gymshark | 1,600 | 408 | 0 | 408 | 0 |

**First-party (`scraped`) quote coverage across all six: 946 of 4,424 = 21%.**
26,604 quote objects stored in total; 18,612 carry `verified: true`.

Still unexplained and worth someone's time: **Soludos 50/194 vs Soludos GS 193/202**,
on effectively the same 180-SKU catalog from the same store. The two brands were
created 38 seconds apart with different `method` values (`shopify-direct` vs
`generic-sitemap`). That is the most likely cause and it has not been confirmed.

## 2. Where quotes actually live — and the query trap

`catalogproducts.productReviews` is a **Mixed OBJECT, not an array.** Querying
`productReviews.0` matches nothing, on every document, forever. It is not evidence of
absence — I reported exactly that mistake earlier today before catching it. Use:

    { 'productReviews.quotes.0': { $exists: true } }

Container keys: `quotes, quotesOrigin, rating, reviewCount, summary, platform, source,
quotesFound, ratingDistribution, vendorDistribution, reviewsFetched, tiers,
pagesFetched, truncated, fetchedAt`. Each quote:
`{source, text, title, author, rating, datePublished, verified}`.

Not the product-tier store, despite looking like it:
- `catalogproducts.reviews[]` — Google Immersive rows, empty in practice
- `catalogproducts.ratingDistribution` — `[{stars,count}]`, **no text**; non-empty on
  100% of rows, which tells you nothing about quotes
- `Brand.brandReviews.quotes` / `Category.categoryReviews.quotes` — other tiers
- `comments` — Instagram/TikTok, keyed to `mediaId`, reachable only via
  `ProductMatchArtifact`
- `products` — leftover inventory collection, no review fields at all

## 3. The render gate, stated exactly

`pickPrimaryProductQuote` (`services/layoutInputService.js:2265`) =
`stampQuoteOrigins` -> `printableQuotes` -> `gateQuotesByRating` -> `pickStrongestQuote`.
`QUOTE_MIN_RATING` is 4.35; **unrated quotes are kept**; there is **no minimum review
count**. `meetsProofBar`'s 3-word floor (`quoteSnippetService.js:374`) is the snippet
shortener, not SKU eligibility — do not use it to measure coverage.

`services/quoteProvenance.js:37` allowlists `{scraped, social_comment, store-import,
llm-web}`. `llm-web` is on that list deliberately: as of 2026-07-31, **zero** of 1,073
catalog products had a first-party scrape, so `{scraped}` alone would have withheld
every quote on every ad indefinitely.

`ANONYMOUS_PRINT_ORIGINS = {'llm-web'}` strips every byline field structurally at the
gate — `author_name, author, author_title, handle, username, reviewer, user_name,
platform, site`. **llm-web prints text only, never attributed.** A renderer that
forgets to clear the byline still cannot print one, because the object it receives
never had one. This is not an attribution hole; do not re-report it as one.

The residual risk is content accuracy, not attribution: Peloton Apparel's recorded
llm-web sources include Lululemon, Nike, REI, Bala, HigherDOSE, Coach, J.Crew and Yeti
product pages, and Gymshark's are largely YouTube haul-video titles. Some llm-web text
plausibly describes a different company's product. Unattributed, but still wrong.

## 4. Ingest never writes ratings — three later passes do

`mapShopifyNormalizedToFlat` (`services/shopifyPublicIngestService.js:198-199`) ALWAYS
starts `rating: null, productReviews: null`. Product rows with images and descriptions
but no reviews prove the upsert committed and the review work has not run.

1. **Stage 3 of the same Shopify-direct run** — GETs each product page, runs
   `extractOnPageReviews` (`:798-870`), writes `productReviews` and top-level `rating`
   when JSON-LD carries an aggregate.
2. **Free on-site pass** — `syncBrandProductReviews`, three tiers: JSON-LD -> the
   store's own review-app public API -> optionally a real browser. Also writes top-level
   `rating`. Reached by `POST /api/sales-demos/brands/:id/sync-reviews?force=1`
   (`routes/salesDemos.js:354`); add `&headless=1` for client-rendered widgets
   (~10-25s per product), `&pages=N` to cap the vendor-API tier.
3. **Paid Gemini gap-fill** — writes `productReviews` quotes ONLY, never top-level
   `rating`, capped at 500 rows, and only targets rows with no quotes AND no rating.

So **`rating > 0` means on-site scrape or paid SerpAPI Enrich — never Gemini.**

**The trap that produced today's confusion:** Peloton Apparel and Gymshark were
Cloudflare-blocked on Node `fetch`, so on 2026-08-24 their catalogs were dumped from
`products.json` by a Python script and upserted with the same mapper — outside the HTTP
loop. That skips Stage 3 **and** the entire end-of-run enrichment trio. Their
`apifyDemo.lastSyncedAt` is still `null`, which is the tell. Also note
`SHOPIFY_DIRECT_LIMIT` defaults to **200**, so any brand with more than 200 products
did not arrive through the normal path.

Gymshark is the genuinely hard one: a Hydrogen storefront with no JSON-LD and no
review-app snippets. The HTTP tiers find nothing there; it needs `headless=1` or the
paid path.

## 5. Akamai is classified, then discarded downstream

Correcting a claim previously recorded here as "the block classifier only knows
Cloudflare." **False.** `services/blockClassifier.js:194-226` recognises Akamai
explicitly (`AkamaiGHost`, `x-akamai-*`, `/_es_/fo/customdeny/`, Access Denied + rcId)
and returns remedy `needs-unblocker`, distinct from Cloudflare's `browser-session`.

The bug is in the consumers, which is narrower and more fixable:

| Surface | Behaviour on an Akamai 403 |
|---|---|
| `shopifyPublicIngestService` Stage 2/3 `politeFetch` | Private CF-only detector; reports **"store rate-limited this server"**. This is the real misreport. |
| Review Phase 0 `fetchProductReviews` | Reads only `cfChallenged`; surfaces `http 403`, looks like a parse miss. |
| Generic Chrome fallback | Only launches for remedies starting `browser-session`, so `needs-unblocker` never tries the cookie harvest that DID recover Peloton/Gymshark `products.json`. |

`httpScrapeClient` does populate `res.block.vendor='akamai'`. The information exists;
it is dropped.

## 6. Janie and Jack

Not a failure — a skip. It is Salesforce Commerce Cloud, not Shopify, and the
2026-08-24 batch passed it over; the brand row was never created. `createDemoBrand`
inserts before any HTTP to the store, so a missing brand row can only mean create was
never called. If someone wants it: create with `method: "generic-sitemap"` and
`websiteUrl: https://www.janieandjack.com`, then `/sync`. Expect 0 products while
Akamai is up — Chrome will not save it without a real unblocker.

## 7. Still open here

Four PRs: **#333** (Slack requester name), **#331** (cost attribution), **#330**
(`scripts/postStatus.js`) — all MERGEABLE — and **#319**, CONFLICTING.

`services/concurrency.js` in this repo still carries the OOM-fatal SPEC fallback
`default: 4`. adgen lowered its own copy to 2 and recorded why. Nobody has decided
whether this repo should follow; it is a degraded-boot fallback only, so it is low
frequency but genuinely fatal when it fires.
