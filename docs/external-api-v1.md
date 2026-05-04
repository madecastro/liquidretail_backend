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

## Versioning + change policy

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
