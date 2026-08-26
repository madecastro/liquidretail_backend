## 2026-08-24 — Four-advertiser onboarding + coverage vs Pelagic Gear

Owner-authorised production onboarding of PB5star, Peloton Apparel, Gymshark, and Janie and Jack, then a measured comparison of catalog data shapes. Goal: test whether strategy-plan coverage figures ("80.5% of SKUs have a usable product review quote", "~89% have ratings") are catalog-wide or Pelagic-dominated.

### Verdict

**These advertisers are materially different.** A pooled catalog-wide percentage is misleading. Per-brand floors are the honest planning unit.

The Pelagic-looking "usable quote" number is also **gate-dependent**. 770/837 Pelagic SKUs (92%) carry on-page `productReviews.quotes`, almost all from `json-ld` / `api:yotpo`, but those quotes have **no `origin` stamp**, so `toPrintableCustomerQuote` rejects them. Printable coverage on Pelagic is **12/837 = 1.4%** (llm-web only). The plan's 80.5% matches the ungated on-page count, not what the live printable gate will burn into an ad.

### Storefront resolution (measured)

| Brand | Storefront | Shopify? | `meta.json` | Published SKUs |
|---|---|---|---|---|
| PB5star | `https://pb5star.com` (USD, `445aa1.myshopify.com`) | yes | name=`PB5star` | **99** |
| Peloton Apparel | `https://apparel.onepeloton.com` (USD, `wear-peloton.myshopify.com`) | yes | name=`Peloton Apparel` | **1492** |
| Gymshark | `https://gymshark.com` (USD, `gymsharkusa.myshopify.com`) | yes | name=`Gymshark US` | **9596** |
| Janie and Jack | `https://www.janieandjack.com` | **no** — Salesforce Commerce Cloud (`Product-Variation?pid=`, `scripts.isml`) | n/a | skipped |

`shop.onepeloton.com` redirects to the marketing site and is not Shopify. The apparel storefront is `apparel.onepeloton.com`. It is apparel-heavy (Bras 252, Shorts 214, Leggings 185, …) with **67/1492** equipment-ish `product_type`s. Newest-first `products.json` page 1 is equipment, so a 200-SKU cap would have been a biased sample.

### What was already in prod (not modified)

Sales Demos (`6a8751266fc5354bf05add95`): Pelagic Gear (837 SKUs), Soludos (194), Soludos GS (202). Reach Social Admin has an empty second Pelagic Gear. **Soludos has two accounts; neither was touched.** None of the four targets existed.

### How they were onboarded

Intended entry is `onboarding.createBrandFromUrl` (not `POST /api/brand`, which only creates + fire-and-forget enrichment). Production HTTP: `POST /api/sales-demos/brands` created the three Shopify brands (`isDemo:true`, `method:shopify-direct`), then the executor reused them (create skipped) and ran enrichment + sync + reviews.

`CATALOG_DETECT_PRECOMPUTE` is **not** on the Render dashboard or the Liquid Retail env group; committed default `false` is live. Detect enqueue returned `deferred:true`, **0 DetectRuns** on the new brands.

Node `fetch` is Cloudflare-blocked on Peloton/Gymshark (`vendor=cloudflare confidence=high`). Python urllib still gets `products.json`. Peloton/Gymshark catalogs were therefore dumped via Python and upserted with the **same** `mapShopifyNormalizedToFlat` mapper the ingest uses. `websiteUrl` stayed on the public domain; `apifyDemo.shopifyUrl` is the myshopify backend (Gymshark must not write `gymsharkusa.myshopify.com` onto `websiteUrl`).

Gymshark ingested **1600 of 9596** (newest-first sample, labelled). PB5star and Peloton are full catalogs.

### Coverage (measured 2026-08-25 against prod)

Printable = `toPrintableCustomerQuote` (allowlist `scraped | social_comment | store-import | llm-web`).

| | Pelagic Gear (baseline) | PB5star | Peloton Apparel | Gymshark (1600/9596) |
|---|---|---|---|---|
| SKUs | 837 | 99 | 1492 | 1600 |
| Images / product (mean) | 5.52 | 7.91 | 5.92 | 6.02 |
| SKUs with >1 image | 97.5% | 98.0% | 96.8% | 99.3% |
| Unique descriptions / SKUs-with-desc | **0.493** | **0.490** | **0.647** | **0.968** |
| Any `productReviews.quotes` | **92.0%** | 93.9% | 32.9% | 25.5% |
| **Printable** product-tier quote | **1.4%** | **87.9%** | **31.2%** | **25.5%** |
| Positive star rating | **91.8%** | **66.7%** | **26.0%** | **13.4%** |
| Review-count present | 91.5% | 60.6% | 24.5% | 12.8% |
| DetectRuns | 190 (historical) | 0 | 0 | 0 |

Description uniqueness: `unique(normalized description) / products with a description`. Pelagic and PB5star share copy across a line (colorways). Gymshark almost does not.

Quote sharing: of SKUs with a printable quote, the quote text also appears on another SKU for 71/87 PB5star, 320/466 Peloton, 351/408 Gymshark. Gap-fill + colorway siblings recycle the same testimonial.

On-site vs llm-web (the "honestly this SKU" split):

- Pelagic: 609 json-ld + 149 yotpo-api quotes, **origin unset**, so unprintable. 12 llm-web printable.
- PB5star: 87 llm-web (gemini gap-fill) + 6 json-ld unprintable. On-site scrape was CF rate-limited (`reviewsCaptured=0`, step-4 refresh 0/25).
- Peloton: Yotpo on-site **68 captured / 24 with quotes / 68 with ratings** of 1492 (Phase 0). Rest of printable coverage is llm-web gap-fill (cap 500), including Target/Amazon/Walmart citations for generic equipment and Cadent-line quotes reused across SKUs. Some ratings are nonsense (e.g. `4.2★ / 60,000` attributed to Peloton Apparel).
- Gymshark: Phase 0 **0/1600** (headless, no JSON-LD / no review app). 408 llm-web quotes persisted of 500 gap-fill targets. Late `Client must be connected before running operations` dropped some cache writes; 408/500 is the persisted count.

### Brand enrichment (usable)

All three Shopify brands: logo (Cloudinary, `website:logo-image`), tagline, tone[], `fontFamily`, customFonts ingested.

- PB5star: tagline "Expertly Engineered Pickleball Footwear & Apparel", font `pragmatica-extended`, 7 custom fonts. Brand-review rating null (8 quotes).
- Peloton Apparel: tagline "Gear that keeps you moving", font Inter, 5 custom fonts. **Brand-review source chose Trustpilot for retropeloton.co.uk (a different company) at 4.1★/42 over Peloton's own Trustpilot.** Do not treat that pair as Peloton Apparel proof.
- Gymshark: tagline "Unlock your full potential.", font Montserrat, 9 custom fonts. 9 brand quotes, rating null.

### Spend (CostLog, measured)

Ledgered to the three new brandIds since 2026-08-25T04:13Z: **$8.62** (2,267 rows). No catalog-detect spend. Breakdown:

| brand | product_reviews | brand_reviews |
|---|---|---|
| PB5star | $1.15 | $0.009 |
| Peloton Apparel | $3.87 | $0.022 |
| Gymshark | $3.55 | $0.018 |

Executor estimate was ~$0.15/brand (Brandfetch + LLM). The rest is the ingest's automatic **review gap-fill** (`enqueueBrandProductEnrichment`, Gemini grounded, cap 500, `includeDetails=false` so not the paid SerpAPI Enrich button). Gymshark end-of-run `costTracker.persist` failures mean a sliver of Gemini spend is unledgered.

No ad generation. No DetectRuns.

### Failures / skipped

- **Janie and Jack** — not Shopify; needs a different path; not in scope.
- Node Shopify ladder CF-blocked on Peloton/Gymshark after the PB5star scrape; Python dump + mapper upsert used instead.
- PB5star on-site review scrape rate-limited; quotes are almost all llm-web.
- Gymshark mongoose disconnect near end of gap-fill; 408/500 quotes persisted.
- Peloton brand-reviews attributed to the wrong Trustpilot property.

### IDs

- PB5star `6a8d1683d9e1e0e1dcced516`
- Peloton Apparel `6a8d1683d9e1e0e1dcced517`
- Gymshark `6a8d1684d9e1e0e1dcced518`
- Advertiser: Sales Demos `6a8751266fc5354bf05add95`
