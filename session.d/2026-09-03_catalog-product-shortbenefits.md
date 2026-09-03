# 2026-09-03 — CatalogProduct.shortBenefits (Part C rewire + ingest derivation)

Worktree `/Volumes/Sayulita/Projects/RS/.wt-benefits-directors`, branch
`feat/benefits-to-directors`. **Not committed.** Builds on Parts A–D.

## Why

Part C originally read `LayoutInputArtifact.findOne` at expansion. The
artifact is written at RENDER. Measured: 21 of 2192 products (1%) have a
benefits-bearing artifact, and a first generate vs a later generate of the
same product could disagree. Owner approved: persist benefits once on
`CatalogProduct` at ingest, cheap flash derivation.

## Part C rewire

`assembleSignals` now reads `product.shortBenefits`. `product` is already
loaded by a bare `CatalogProduct.findById(productId).lean()` with no
projection — zero added I/O, same shape as the existing `specs` comment.
`normalizeBenefitList` (5 items, 56 chars, never below 3) unchanged.
`[]` never null. Flag `DIRECTOR_PRODUCT_BENEFITS === 'true'`. Key omitted
when off. `DIRECTOR_SIGNALS_VERSION` stays **3.5.0**. HONESTY RULE /
PROOF-LED / `social_proof_led` eligibility untouched.

Determinism: same product doc → same brief on first generate and every
regenerate. Pinned by `scripts/verifyDirectorBenefits.js` A14 + B10 (zero
`LayoutInputArtifact` in `assembleSignals`).

## Schema

`CatalogProduct.shortBenefits` `{ type: [String], default: undefined }`
and `shortBenefitsDerivedAt` `{ type: Date, default: null }`.

**`default: undefined`, not `[]`.** assembleSignals and the backfill must
distinguish "never derived" (field absent) from "derived, genuinely
nothing" (`[]` + timestamp). `[]` as the schema default would collapse
those and make the backfill unresumable.

## copyDerivationService verdict

`copyDerivationService.js:208` used to read `product.shortBenefits` and
always sent `[]` because the field was undeclared. Adding the field would
have made that read LIVE.

Reachable? **No on the live path.** `deriveCopy` is only called from
`runCopyDerivationEager`, which sits on the legacy cartesian path
(`campaignAdsGenerationService.js:2069`) **below** the concept-driven
early return at `:1636-1647`. `AI_CONCEPT_DRIVEN=true` in
`config/defaults.env`. `aiCanvasInputBuilder` only `loadCached` (a cache
read, no derive). HTML canvas is dead for new generation.

The cartesian fallback is still reachable if concept expansion returns
empty. To prevent a silent behaviour change on that dead-legacy path, the
reader is now a **literal `[]`**, pinned by `verifyProductBenefits.js` B13
/ RP3. Flagged, not deleted.

## Derivation (new billable path)

`services/productBenefitsService.js`. Model `gemini-2.5-flash` via
`atlasLlmService.chatCompletion` (ledgered, `maxRedirects:0`, stage
`product_benefits`). Kill switch `PRODUCT_BENEFITS_DERIVATION` default
**true** (ingest of a new product should not wait for a backfill; harnesses
that don't load `defaults.env` see unset = OFF).

- Idempotent: skip when `shortBenefits` is non-empty OR `shortBenefitsDerivedAt`
  is set. Service also refuses cheaply if handed such a product.
- No retry loop. Transport error → `[]` without stamping (backfill can retry).
  Honest empty / below-floor → persist `[]` + timestamp (do not re-bill).
- Never throws into ingest.
- Prompt register mirrors `layoutInputService.js:1276` (3–5 items, ≤6 words,
  buyer benefits not specs). Floor 3, cap 5.

**Not reachable** from `assembleSignals`, `expandWizardJob`, or any render
path. Pinned structurally.

## Ingest write sites enumerated (before editing)

| site | creates products? | wired? |
|---|---|---|
| `shopifyPublicIngestService.syncBrandShopifyDirect` | upsert | yes, insert-only via `rawResult` + `collectIfNew` |
| `genericCatalogIngestService.syncBrandGenericCatalog` | upsert | yes, same |
| `apifyIngestService.syncBrandShopify` | upsert (`rawResult` already) | yes |
| `catalogSyncService` (Meta IG catalog) | upsert (`rawResult` already) | yes |
| `capabilityExecutors/catalogCreateProduct` | upsert | yes, `isNew` |
| `capabilityExecutors/catalogBulkCreateProducts` | upsert | yes, bounded batch |
| `routes/upload.js` manual product | upsert | yes, `isNew` |
| `catalogProductDraftService` | upsert | yes, `isNew` |
| `productMatchService.ensureCatalogProductForMatch` `CatalogProduct.create` | create | yes |
| `catalogProductDetectService` | updates existing (imageMediaId / shot styles) | **no** — not a create |
| `productDetailsService` / reviews scrape / quote rotation | updates existing | **no** |

Fire-and-forget: pushed onto `backgroundWork` where that array exists
(HTTP callers ignore it); elsewhere the promise is started and not
awaited. Bounded concurrency 4. Insert-only so a 2192-product **resync
of already-derived rows is ~$0**. First resync of the current undeclared
corpus is also ~$0 on ingest (existing rows are updates); the backfill
is the spend for those 2171.

## Backfill

`scripts/backfillProductBenefits.js`. Dry-run by default. `--apply`
required to spend. `--limit`, `--brand`, resumable, bounded concurrency,
running spend total. **Not run with `--apply` this session.**

Projected: `$0.002/product × 2171 ≈ $4.34` (comparable ledgered flash
stages: category_reviews $0.00205, product_review_summary $0.00287,
product_reviews $0.00187, visual_catalog_match $0.00124).

## Stale docs (short)

- `session.d/2026-09-03_benefits-to-directors-part-a-c.md` still describes
  the artifact-read Part C. Superseded by this file for the source; the
  flag / caps / honesty-rule constraints there still hold.
- Part A (`titleSpecContentSample.loadProductBenefits`) still samples
  **rendered** artifact benefits. That is correct for a titling-director
  sample of what actually shipped; it is no longer the static Director's
  source.
