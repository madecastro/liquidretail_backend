# 2026-09-04 — font ingest on every brand import path

Owner: *"make sure that font is ingested regardless of import method, make sure every method is getting fonts from social media ads and from their website."*

Uncommitted on `feat/font-ingest-every-import`. Do not treat as landed.

## Choke point

`ensureBrandFontsIngested` in `services/brandEnrichmentService.js` is the one implementation of the three font tiers. `enrichBrandFromUrl` calls it (including a font-only path when `websiteUrl` is missing). Fire-and-forget callers use `queueBrandEnrichment` (in-process coalesce so IG+Shopify in one `syncBrandApify` cannot double-pay Meta-ads).

## MONEY

`metaFontsIngestedAt` still stamps only on `billableAttempted === true` (#362). Config-absence remains retryable. Coalescing is in-process only; the stamp is the cross-process gate.

## Pin

`scripts/verifyFontIngestEveryImportPath.js` — structural scan of real create/ingest files + behavioural Meta-ads stamp semantics + revert-prove.

`npm test` 244/244.

## Adgen

Dead vendored code. renderer → layoutInputService → `findBrandByName` only. `upsertBrandStub` / `enrichBrandFromUrl` have no live caller from entrypoint roles or regenerate/retitle consumers.
