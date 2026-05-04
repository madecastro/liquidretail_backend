# External Detect API — v1 Contract (DRAFT for review)

**Status:** Draft. Naming + field choices are open. This document is the source of truth once ratified; ticket-level work breakdown should reference it.

**Scope:** Lambda-driven external invocation of the LiquidRetail detect pipeline. External application (running its own Lambda or service) sends a media URL + brand context + optional pre-vectorized catalog, receives a runId synchronously, and gets the assembled match results via webhook (or polling).

**Out of scope for v1:** Streaming results, multi-tenant API key rotation tooling, in-place catalog editing via API, video real-time processing.

---

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/external/v1/detect` | Trigger an async detect run on one or more media URLs |
| `GET`  | `/api/external/v1/detect/:runId` | Poll for status + result (alternative to webhook delivery) |
| `POST` | `/api/external/v1/catalogs/vector-sets` | Upload a pre-vectorized catalog, get a `vectorSetId` |
| `GET`  | `/api/external/v1/catalogs/vector-sets/:id` | Metadata + product count + lastUsedAt |
| `DELETE` | `/api/external/v1/catalogs/vector-sets/:id` | Invalidate a vector set |
| `POST` | `/api/external/v1/brands` | Auto-provision a brand (alternative: pass `brand{}` inline in detect payload) |

---

## Auth

All endpoints accept `Authorization: Bearer <api_key>`. The API key resolves to an `advertiserId` and an optional default `brandId`. Cross-tenant requests (specifying a `brandId` outside the key's advertiser) are rejected with `403 cross_tenant_brand`.

API keys are issued per integration via an admin UI. Keys are stored hashed (SHA-256) at rest; the plaintext is shown once at creation. Each key has a `dailyQuota` and a per-minute rate limit (default 60 req/min).

---

## `POST /api/external/v1/detect`

### Request headers

| Header | Required | Description |
|---|---|---|
| `Authorization` | yes | `Bearer <api_key>` |
| `Content-Type` | yes | `application/json` |
| `Idempotency-Key` | no | Identical retries within 24h return the original response. Falls back to `body.media[].externalId` if not supplied. |
| `X-LR-API-Version` | no | Pin to a major version (default `1`) |

### Request body

```jsonc
{
  // ── Required ─────────────────────────────────────────────────
  "media": [
    {
      "imageUrl": "https://cdn.example.com/post-12345.jpg",   // OR videoUrl
      "videoUrl": null,                                          // exactly one of imageUrl/videoUrl
      "fileName": "post-12345.jpg",                              // optional
      "mimeType": "image/jpeg",                                  // optional, sniffed if omitted
      "externalId": "evt-12345",                                 // REQUIRED per media — caller's stable PK; idempotency uses (apiKey, externalId)
      "sourceUrl": "https://instagram.com/p/...",                // optional original platform URL
      "metadata": {                                              // optional context — propagates to Media.metadata
        "caption": "...",
        "postedAt": "2026-04-30T18:22:00Z",
        "creatorHandle": "@angler_joe",
        "platform": "instagram"
      }
    }
    // ... up to 10 media per request
  ],

  "brand": {                                                     // EITHER brandId OR auto-provision shape — exactly one
    "brandId": "69f26a96a285dfeab54fa31c"
    // OR:
    // "name": "Pelagic Gear",
    // "websiteUrl": "https://pelagicgear.com",
    // "primaryColor": "#2254b2",                                 // optional curated overrides
    // "logoUrl": "..."
  },

  // ── Catalog matching (optional but strongly recommended) ──
  "catalog": {
    "vectorSetId": "vs_pelagic_v3",                              // pre-uploaded vectors (B2 pattern, recommended)
    // OR inline (B1 pattern, payload heavy):
    // "vectors": [{ "externalId": "...", "embedding": [...], "modality": "image" }],
    "embeddingModel": "clip-vit-l-14",                           // REQUIRED if vectors supplied — must match registry
    "source": {                                                   // for hydrating top-K candidates with full product data
      "type": "shopify",                                          // shopify | meta | rest | mongo
      "config": {
        "shopDomain": "pelagicgear.myshopify.com",
        "credentialRef": "secret://aws/sm/pelagic-shopify-token"
      }
    },
    "matchThreshold": 0.80                                        // optional override — combinedScore floor for catalog-winner outcome
  },

  // ── Pipeline tuning (all optional) ───────────────────────────
  "pipeline": {
    "stages": ["detect", "match"],                               // detect | match | enrich | overlay | extended-crops; default: all
    "skipExtendedCrops": false,                                   // skips Gemini image generation (~$0.16 saved per run)
    "skipOverlayZones": false,                                    // skips overlay-zone Gemini Vision (~$0.13 saved)
    "maxRefinedProducts": 10,                                     // hard cap on refined products surfaced (default: no cap)
    "competitorPolicy": "include"                                 // include | exclude — drop competitor-brand matches from output
  },

  // ── Result delivery ──────────────────────────────────────────
  "delivery": {
    "webhookUrl": "https://lambda.example.com/detect-complete",   // optional — server POSTs result here on completion
    "callbackSecret": "shr_abc123",                               // optional — HMAC-SHA256 secret for webhook signing
    "include": ["matches", "summary"],                            // optional — extra: subjects, overlays, crops, transcript
    "responseFormat": "json"                                      // json (default) | json-flat | csv
  }
}
```

### Validation rules

- `media[].imageUrl` or `videoUrl` must be HTTPS, < 10MB, host must not resolve to a private IP (SSRF guard)
- `brand.brandId` must belong to the API key's advertiser
- `catalog.embeddingModel` must be in the supported registry (`clip-vit-l-14`, `clip-vit-b-32`, future-additive)
- `delivery.webhookUrl` must be HTTPS
- Total payload size cap: 5MB (B2 with `vectorSetId`); 30MB (B1 with inline vectors)
- Per-API-key rate limit: 60 requests/min; daily quota per key

### Synchronous response

```jsonc
// 202 Accepted
{
  "runs": [
    {
      "runId":     "69f3db8dfe7e5582bb937509",
      "mediaId":   "69f3db8dfe7e5582bb937507",
      "externalId":"evt-12345",
      "statusUrl": "https://api.liquidretail.app/api/external/v1/detect/69f3db8dfe7e5582bb937509",
      "estimatedCompletionMs": 180000,
      "webhookConfigured": true
    }
  ],
  "requestId": "req_8b3f...",
  "rateLimit": {
    "remaining": 47,
    "resetAt": "2026-05-04T18:23:00Z"
  }
}
```

### Error responses

```jsonc
// 400/401/403/422/429
{
  "error": {
    "code":    "invalid_brand",
    "message": "brand.brandId 69... not found under your advertiser",
    "field":   "brand.brandId",
    "docsUrl": "https://docs.liquidretail.app/errors/invalid_brand"
  },
  "requestId": "req_8b3f..."
}
```

Common codes: `unauthorized`, `quota_exceeded`, `rate_limited`, `invalid_brand`, `invalid_vector_set`, `embedding_model_unsupported`, `image_fetch_failed`, `image_too_large`, `payload_too_large`, `idempotency_conflict`, `cross_tenant_brand`.

---

## Webhook payload (or `GET /api/external/v1/detect/:runId`)

POSTed to `delivery.webhookUrl` when the run reaches `completed` or `failed`. Same shape returned by the polling endpoint.

### Webhook headers

| Header | Description |
|---|---|
| `X-LR-Signature` | `sha256=<hex>` HMAC of the body using `delivery.callbackSecret` |
| `X-LR-Event` | `detect.completed` or `detect.failed` |
| `X-LR-Run-Id` | Convenience — same as body.runId |
| `X-LR-Delivery-Id` | Unique per delivery attempt; use for consumer-side idempotency |

Webhook retries: 3 attempts (10s, 60s, 5min) on consumer 5xx or timeout. After 3 failures, marked dead; consumer can fetch via `statusUrl`.

### Payload — completed run

```jsonc
{
  "schema":  "lr.detect.v1",
  "event":   "detect.completed",
  "runId":   "69f3db8dfe7e5582bb937509",
  "mediaId": "69f3db8dfe7e5582bb937507",
  "externalId": "evt-12345",
  "status":  "completed",
  "createdAt":   "2026-04-30T18:14:05Z",
  "completedAt": "2026-04-30T18:17:23Z",
  "durationMs":  198000,

  // ── Media that was processed ────────────────────────────────
  "media": {
    "type":         "image",
    "imageUrl":     "https://cdn.../resized.jpg",
    "originalUrl":  "https://cdn.example.com/post-12345.jpg",
    "width":  633,
    "height": 850
  },

  // ── Per-product matches (the headline output) ───────────────
  "matches": [
    {
      "refinedProductId": "r1",
      "outcome": "product_match",                              // product_match | product_category | brand_match | no_products
      "winner":  "catalog",                                    // catalog | gemini | yolo | agree | null
      "matchSource": "shopify",
      "confidence": 0.92,
      "scores": {
        "refined":          0.93,
        "reasoner":         0.70,
        "catalogCombined":  0.92,
        "catalogText":      0.88,
        "catalogVisual":    0.92
      },
      "product": {
        "externalId":  "gid://shopify/Product/9876543",        // brand's PK in their catalog
        "title":       "End Game Fishing Gloves",
        "brand":       "Pelagic Gear",
        "category":    "apparel",
        "categoryBreadcrumb": "Mens > Accessories > Gloves",
        "imageUrl":    "https://pelagicgear.com/cdn/shop/products/...",
        "productUrl":  "https://pelagicgear.com/products/end-game-fishing-gloves",
        "price":       60.00,
        "currency":    "USD",
        "availability": "in stock",
        "gtin":        "0123456789012",
        "mpn":         "EG-GLV-BLU-M"
      },
      "evidence": {
        "croppedImageUrl": "https://res.cloudinary.com/.../c_crop,w_101,h_88,x_208,y_51/...",
        "bbox":            { "x1": 208, "y1": 51, "x2": 309, "y2": 139 },
        "label":           "fishing glove",
        "categoryLabel":   "Blue fishing shirt",
        "agreement":       "category-confirmed",                // agree | category-confirmed | gpt-only | gemini-only | catalog
        "providerEvidenceUrls": [
          { "provider": "google-lens", "url": "https://pelagicgear.com/products/end-game-fishing-gloves", "weight": "strong" }
        ]
      },
      "enrichment": {
        "tiers":         ["sku", "category", "brand"],
        "rating":        4.8,
        "reviewCount":   124,
        "topReviews": [
          { "text": "Best gloves I've owned, kept my hands cool all day offshore.", "author": "Mike T.", "source": "pelagicgear.com" }
        ],
        "categoryReviews": {
          "summary": "Pelagic Gear's Mens > Accessories > Gloves category receives generally positive feedback...",
          "quoteCount": 4
        }
      }
    }
    // ... one entry per surviving refined product
  ],

  // ── Run-level summary ──────────────────────────────────────
  "summary": {
    "outcome":           "own_product",                         // own_product | competitor | mixed | category | no_products
    "totalMatches":      3,
    "ownBrandMatches":   2,
    "competitorMatches": 0,
    "categoryOnlyMatches": 1,
    "primarySubject":    "Person wearing Pelagic Gear branded blue fishing apparel..."
  },

  // ── Optional sections (only present when delivery.include[] requested) ──
  "subjects": [...],                                            // include=subjects
  "overlays": { "5:4": {...}, "1:1": {...} },                   // include=overlays
  "crops":    { "smartCrops": {...}, "extendedCrops": {...} },  // include=crops
  "transcript": { ... },                                         // include=transcript (video only)

  // ── Cost + quota metadata ──────────────────────────────────
  "costMetadata": {
    "geminiTokensInput":   18420,
    "geminiTokensOutput":  4210,
    "openaiTokensInput":   12880,
    "openaiTokensOutput":  3050,
    "serpApiCalls":        6,
    "geminiImageGens":     4,
    "approxCostUsd":       0.83
  }
}
```

### Payload — failed run

```jsonc
{
  "schema":  "lr.detect.v1",
  "event":   "detect.failed",
  "runId":   "...",
  "mediaId": "...",
  "externalId": "evt-12345",
  "status":  "failed",
  "createdAt":   "...",
  "failedAt":    "...",
  "durationMs":  ...,
  "error": {
    "stage":   "product-match",                                  // queued | detect | crop-judge | match | enrich | overlay | finalize
    "code":    "gemini_quota_exceeded",
    "message": "Gemini API returned 429 after 3 retries",
    "retryable": true
  },
  "partialResults": {                                            // whatever artifacts the failed run did produce
    "media": { "type": "image", "imageUrl": "...", "width": 633, "height": 850 },
    "subjects": [...],
    "refinedProducts": [...]
  },
  "costMetadata": { ... }                                        // partial cost still incurred
}
```

---

## Catalog vector set lifecycle

### `POST /api/external/v1/catalogs/vector-sets`

```jsonc
{
  "brandId":        "69f26a96a285dfeab54fa31c",
  "embeddingModel": "clip-vit-l-14",
  "modality":       "image",                                     // image | text | both
  "vectors": [
    { "externalId": "gid://shopify/Product/9876543", "embedding": [0.12, -0.04, ...] }
  ],
  "ttlDays": 30
}
```

Returns:

```jsonc
{
  "vectorSetId":  "vs_pelagic_v3_a8f2",
  "productCount": 1247,
  "dim":          768,
  "embeddingModel": "clip-vit-l-14",
  "createdAt":    "2026-05-04T18:20:00Z",
  "expiresAt":    "2026-06-03T18:20:00Z",
  "sizeBytes":    3826176
}
```

---

---

# Brand Enrichment API

Companion surface for provisioning + enriching brand metadata externally. Enrichment populates a Brand row with logo, colors, fonts, tagline, summary, tone, demographics, and review quotes. Triggered on first reference to a brand, or explicitly via this API.

## Pipeline overview

The internal enrichment chain runs four sequential stages tracked on `Brand.enrichmentStage`. Each stage is idempotent — re-running enrichment skips any stage already in `Brand.enrichmentSources[]`.

| # | Stage | Source | Produces | Skipped when |
|---|---|---|---|---|
| 1 | `brandfetch` | Brandfetch brand-kit API | `logoUrl`, `primaryColor`, `secondaryColor`, `accentColor`, `fontFamily`, `description` | No `BRANDFETCH_API_KEY` set, or already attempted |
| 2 | `scraped` | Homepage HTML fetch (axios) | meta theme-color, apple-touch-icon (logo fallback), Google Fonts family, raw text content for GPT input | Already attempted (but always runs even if Brandfetch already ran — provides GPT input) |
| 3 | `gpt` | GPT-4.1 over scraped text + Brandfetch description | `tagline`, `summary`, `tone[]`, `hashtags[]`, `tags[]`, `fontSuggestion`, `demographics[]`, color/font overrides where Brandfetch missed | No `OPENAI_API_KEY`, OR scraped text < 200 chars AND no Brandfetch description, OR already attempted |
| 4 | `brand-reviews` | Gemini grounded search (2-pass: narrative + JSON structuring) | `brandReviews.{quotes, rating, reviewCount, summary, sources}` | No `GEMINI_API_KEY`, OR already attempted, OR `curatedFields` contains `brandReviews` |

Per-field protection via `Brand.curatedFields[]` — fields explicitly set by a user (or the API caller) are NEVER overwritten by enrichment.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/external/v1/brands` | Provision (or look up) a brand and trigger enrichment |
| `GET`  | `/api/external/v1/brands/:brandId` | Fetch current Brand state (whether enriched or not) |
| `GET`  | `/api/external/v1/brands/:brandId/enrichment` | Status + per-stage progress |
| `POST` | `/api/external/v1/brands/:brandId/enrichment/refresh` | Force re-enrichment (clears `enrichmentSources[]`, re-runs all stages) |
| `PATCH` | `/api/external/v1/brands/:brandId` | Set curated overrides (adds to `curatedFields[]`, protects from future enrichment) |

## `POST /api/external/v1/brands`

Idempotent on `(advertiserId, name+websiteUrl)`. If a brand already exists matching the name + URL, returns its existing record without re-running enrichment (use the `/refresh` endpoint to force).

### Request body

```jsonc
{
  // ── Required ─────────────────────────────────────────────────
  "name":       "Pelagic Gear",
  "websiteUrl": "https://pelagicgear.com",

  // ── Optional ─────────────────────────────────────────────────
  "externalId": "lambda-evt-12345",                // caller's stable PK; used for idempotency + webhook echo
  "curatedFields": {                                // caller-supplied curated values — auto-added to curatedFields[] so enrichment never overwrites
    "primaryColor": "#2254b2",
    "logoUrl":      "https://example.com/curated-logo.png",
    "tagline":      "Performance Fishing Clothing"
  },

  // ── Pipeline tuning ──────────────────────────────────────────
  "pipeline": {
    "stages":           ["brandfetch", "scraped", "gpt", "brand-reviews"],   // opt out of stages by omitting; default: all available
    "skipIfExists":     true,                                                 // default true — return existing brand without re-enrichment
    "waitForCompletion": false                                                // if true, holds the response until enrichment finishes (max 90s); default false (async)
  },

  // ── Result delivery ──────────────────────────────────────────
  "delivery": {
    "webhookUrl":     "https://lambda.example.com/brand-enriched",
    "callbackSecret": "shr_abc123",
    "events": [
      "brand.enrichment.stage-completed",                                     // fires per-stage as each completes
      "brand.enrichment.completed",                                           // fires once at end
      "brand.enrichment.failed"
    ],
    "include": ["brand", "costMetadata"]                                       // brand=full Brand record; costMetadata=token/api-call usage; minimal=just status
  }
}
```

### Synchronous response

```jsonc
// 202 Accepted (async) — enrichment running in background
{
  "brandId":    "69f26a96a285dfeab54fa31c",
  "isNew":      true,                                                          // false if brand already existed and was returned as-is
  "wasEnrichmentTriggered": true,                                              // false when isNew=false AND skipIfExists=true
  "statusUrl":  "https://api.liquidretail.app/api/external/v1/brands/.../enrichment",
  "estimatedCompletionMs": 60000,                                              // typical full-chain runtime
  "stagesPlanned": ["brandfetch", "scraped", "gpt", "brand-reviews"],          // stages that will actually run (excludes already-attempted)
  "stagesSkipped": [],                                                          // e.g. ["brand-reviews"] when GEMINI_API_KEY missing
  "webhookConfigured": true,
  "requestId":  "req_..."
}
```

When `pipeline.waitForCompletion: true`, the response is `200 OK` with the full enriched Brand record inline — same shape as the `brand.enrichment.completed` webhook payload below. Caller blocks for up to 90s; if enrichment isn't done by then, falls back to the 202 async shape.

## Enrichment trigger events (webhooks)

POSTed to `delivery.webhookUrl` with the same auth + retry behavior as detect webhooks (HMAC-SHA256 signed via `X-LR-Signature`, 3 attempts at 10s/60s/5min).

### Stage completion event

Fired once per stage as it finishes. Lets the consumer surface progressive UI updates ("Logo found ✓ → Generating personas...").

```jsonc
// X-LR-Event: brand.enrichment.stage-completed
{
  "schema":     "lr.brand.v1",
  "event":      "brand.enrichment.stage-completed",
  "brandId":    "69f26a96a285dfeab54fa31c",
  "externalId": "lambda-evt-12345",
  "stage":      "brandfetch",                                                  // brandfetch | scraped | gpt | brand-reviews
  "stageIndex": 1,
  "totalStages": 4,
  "elapsedMs":  4200,
  "fields": {                                                                   // what this stage produced
    "logoUrl":         "https://cdn.brandfetch.io/.../logo.png",
    "primaryColor":    "#2254b2",
    "secondaryColor":  "#000000",
    "accentColor":     "#2254b2",
    "fontFamily":      "Oswald",
    "description":     "Pelagic Gear is a performance fishing apparel brand..."
  },
  "fieldsSkipped": [],                                                          // fields the stage tried but couldn't fill
  "fieldsLockedByCuration": ["logoUrl"]                                          // fields the stage WOULD have set but couldn't because they're in curatedFields[]
}
```

### Completion event

Fired once after all stages finish (or after the last successful stage if some failed gracefully).

```jsonc
// X-LR-Event: brand.enrichment.completed
{
  "schema":      "lr.brand.v1",
  "event":       "brand.enrichment.completed",
  "brandId":     "69f26a96a285dfeab54fa31c",
  "externalId":  "lambda-evt-12345",
  "status":      "completed",
  "stagesCompleted": ["brandfetch", "scraped", "gpt", "brand-reviews"],
  "stagesSkipped":   [],                                                        // [] | ["brand-reviews"] (no Gemini key) | etc.
  "stagesFailed":    [],                                                        // graceful per-stage failures don't fail the run; listed here
  "durationMs":  38400,
  "brand": {                                                                     // full Brand record (only if delivery.include includes "brand")
    "id":            "69f26a96a285dfeab54fa31c",
    "advertiserId":  "...",
    "name":          "Pelagic Gear",
    "websiteUrl":    "https://pelagicgear.com",
    "source":        "enriched",                                                  // 'stub' | 'enriched' | 'curated'
    "enrichmentSources": ["brandfetch", "scraped", "gpt", "brand-reviews"],
    "enrichmentStage":   null,                                                    // null when enrichment completed
    "enrichedAt":    "2026-05-04T18:22:17Z",
    "curatedFields": ["primaryColor", "logoUrl", "tagline"],

    // Visual identity
    "logoUrl":         "https://example.com/curated-logo.png",                    // from curatedFields → not overwritten
    "primaryColor":    "#2254b2",
    "secondaryColor":  "#000000",
    "accentColor":     "#2254b2",
    "fontColor":       "#000000",
    "fontFamily":      "Oswald",
    "fontSource":      "brandfetch",                                              // brandfetch | suggested

    // Voice + positioning
    "tagline":         "Performance Fishing Clothing",
    "summary":         "Pelagic Gear is a brand specializing in high-performance fishing apparel and accessories...",
    "tone":            ["technical", "outdoorsy", "practical", "energetic"],
    "hashtags":        ["#pelagic", "#fishing", "#performancegear", "#offshore", "#anglerlife"],
    "tags":            ["fishing", "performance", "apparel", "outdoor", "sun-protection"],

    // Demographics — caller can use these to drive ad-creative variants
    "demographics": [
      {
        "name":        "Saltwater Joe",
        "description": "A dedicated saltwater angler who spends weekends and vacations on the ocean.",
        "interests":   ["offshore fishing", "boat trips", "tournaments"],
        "painPoints":  ["sun exposure", "durability", "comfort in wet conditions"],
        "toneHint":    "Speaks with confidence and uses fishing jargon..."
      }
      // ... up to 6 personas
    ],

    // Reviews
    "brandReviews": {
      "quotes": [
        {
          "text":   "Awesome High Quality Hat! Recently purchased a couple of Offshore caps...",
          "author": null,
          "source": "Pelagic Gear website"
        }
      ],
      "rating":      null,
      "reviewCount": null,
      "summary":     "Real customers generally praise Pelagic Gear for its high-quality, functional, and stylish fishing apparel...",
      "sources":     ["pelagicgear.com", "trustpilot.com", "reddit.com"],
      "fetchedAt":   "2026-05-04T18:22:14Z"
    }
  },
  "costMetadata": {
    "brandfetchCalls":   1,
    "scrapeRequests":    1,
    "openaiTokensInput":  4820,
    "openaiTokensOutput": 1640,
    "geminiTokensInput":  3200,
    "geminiTokensOutput": 980,
    "approxCostUsd":     0.08
  }
}
```

### Failure event

```jsonc
// X-LR-Event: brand.enrichment.failed
{
  "schema":     "lr.brand.v1",
  "event":      "brand.enrichment.failed",
  "brandId":    "...",
  "externalId": "lambda-evt-12345",
  "status":     "failed",
  "stagesCompleted": ["brandfetch", "scraped"],                                  // partial progress
  "failedStage": "gpt",
  "error": {
    "code":      "openai_quota_exceeded",
    "message":   "OpenAI API returned 429 after 3 retries",
    "retryable": true
  },
  "partialBrand": { /* Brand record at point of failure */ },
  "costMetadata": { ... }
}
```

Note: brand enrichment is intentionally graceful at the per-stage level — a failed stage doesn't halt the pipeline. The whole run only enters `failed` status when an unrecoverable error blocks all remaining stages (auth failure, fetch timeout on the brand homepage with no Brandfetch fallback, etc.). Otherwise stages that fail land in `stagesFailed[]` of the `completed` event.

## `GET /api/external/v1/brands/:brandId/enrichment`

Polling endpoint for callers without a webhook receiver.

```jsonc
{
  "brandId":     "69f26a96a285dfeab54fa31c",
  "status":      "running",                                                     // pending | running | completed | failed
  "currentStage":"gpt",                                                          // null when not running
  "stagesCompleted": ["brandfetch", "scraped"],
  "stagesPending":   ["gpt", "brand-reviews"],
  "stagesSkipped":   [],
  "stagesFailed":    [],
  "startedAt":   "2026-05-04T18:21:39Z",
  "elapsedMs":   12400,
  "estimatedRemainingMs": 47000
}
```

When `status: 'completed' | 'failed'`, the response also includes the full `brand` object (and `error` for failures) — same shape as the corresponding webhook payload.

## `POST /api/external/v1/brands/:brandId/enrichment/refresh`

Forces re-enrichment by clearing `enrichmentSources[]`. All stages re-run. Useful when:
- Brandfetch came online after the initial enrichment (no API key at first run)
- The brand's site changed substantially (new tagline, different colors)
- You want fresh review quotes (default cache TTL is 30 days, but you can force earlier)

`curatedFields[]` is preserved — re-enrichment still respects per-field protection.

```jsonc
// Request
{
  "stages": ["brand-reviews"],                                                   // optional — restrict to specific stages instead of all
  "delivery": { ... }                                                            // same as POST /brands
}

// Response (202)
{
  "brandId": "...",
  "stagesPlanned": ["brand-reviews"],
  "statusUrl": "...",
  "webhookConfigured": true
}
```

## `PATCH /api/external/v1/brands/:brandId`

Set curated overrides — fields the caller wants to lock against future enrichment.

```jsonc
// Request
{
  "curated": {
    "primaryColor": "#0a2540",
    "tagline":      "We catch what matters.",
    "logoUrl":      "https://cdn.example.com/logos/pelagic-v3.png"
  }
}

// Response (200)
{
  "brandId": "...",
  "updated": ["primaryColor", "tagline", "logoUrl"],
  "curatedFields": ["primaryColor", "tagline", "logoUrl"]                         // full list after PATCH
}
```

PATCHed fields are immediately added to `curatedFields[]` and any future `enrichment/refresh` will skip writing to those fields.

## Brand integration with detect

The `POST /api/external/v1/detect` endpoint accepts an inline `brand: { name, websiteUrl, ...curated }` shape that fires the same provisioning + enrichment pipeline as `POST /api/external/v1/brands` — but in the background, so the detect run isn't blocked. Detect proceeds with whatever brand data is available; brand-dependent enrichment (layout colors, brandReviews quotes for comments) reads brand state at consumption time, so it benefits from any progress enrichment has made by then.

If your Lambda needs the enriched brand BEFORE running detect (e.g. for ad-creative assembly that needs colors), provision the brand first via `POST /api/external/v1/brands` with `pipeline.waitForCompletion: true` and use the returned brandId for subsequent detect calls.

---

# Versioning + change policy

- Major version pinned in URL (`/v1/`)
- Breaking changes require a new major version (`/v2/`); `v1` supported for 12 months minimum after `v2` ships
- Additive changes (new optional fields, new optional matches metadata) within a major version
- `schema` field on every payload identifies version + event type for downstream consumers

---

## Open questions for review

1. **Embedding model registry** — which models do we commit to supporting at v1? Recommend `clip-vit-l-14` only at launch; add `clip-vit-b-32` if a customer needs cheaper/lighter; defer text-only models.
2. **Inline vectors (B1) vs vectorSetId (B2)** — keep both, or B2-only? B2 simplifies plumbing but forces a separate upload step.
3. **Webhook retry policy** — 3 attempts at 10s/60s/5min. Acceptable, or extend to 24h with longer backoff?
4. **Auto-provisioning brands inline in detect** — convenient but races against the brand enrichment background pass; consumer might receive results before brand colors/logo finish enriching. OK because detect doesn't depend on brand enrichment, but worth flagging.
5. **Cost metadata in webhook** — surfaces our internal cost. Some operators may consider this commercially sensitive. Optional flag to suppress?
6. **Competitor matches** — `competitorPolicy: "exclude"` drops them from output. Should we also surface a `competitorCount` so the caller knows we suppressed N matches?
7. **Failure partial results** — surface what we produced or hard-fail? Current proposal: surface partials so the caller can degrade gracefully.

---

## Dependencies + sequencing

- **CatalogAdapter interface** — required for any non-mongo `catalog.source.type`. Recommend MongoCatalogAdapter (refactor of existing inline queries) as zero-risk first commit.
- **API key model + admin UI** — required for any external traffic. Independent of detect plumbing.
- **Webhook dispatch service** — required for async delivery. Hooks into `pipelines/detect.js` finalize.
- **Vector set storage** — required for B2. Mongo collection with binary `Buffer` field is sufficient; defer Pinecone/Weaviate until vector volume warrants it.
- **External brand auto-provision** — small extension to `findOrCreateBrand` to accept additional curated overrides.
