## 2026-08-19 — Pelagic Gear onboarding blocker: 826/831 products unpickable, FIXED

Branch `fix/pelagic-materialize-blocker` (backend, PR #232), paired frontend branch
`fix/pelagic-materialize-picker-honesty` (PR #58 on `liquidretail`). Worktree
`.worktrees/pelagic-materialize`, based on `main` (`a035aeb9`, PRs through #231
included).

**Root cause.** `enqueueBrandProductDetects` defers under
`CATALOG_DETECT_PRECOMPUTE=false` (the default) — nothing at ingest time calls
`materializeMissingHero`. `imageMediaId` only gets set by the pre-existing
per-product lazy backfill in `GET /api/catalog/:id`, which fires only when an
operator opens THAT product's own detail page. On a freshly-ingested brand nobody
has clicked through yet, that's every row but the one someone already viewed.
Measured live: Pelagic Gear 1/831 had `imageMediaId`; Vuori Clothing 56/214.

**Fix — new `services/catalogMaterializeDrainService.js`.** Bounded ($0, no
`DetectRun` — materializeMissingHero's own cost fence), resumable (re-queries
`imageMediaId: null` fresh every pass, no persisted cursor), observable (reuses
`services/progressService.js` / `OperationRun`, `kind: 'catalog-materialize'` —
`GET /api/progress/active` and `GET /api/progress/:runId` already work, no new
progress surface). Idempotent start via `findActiveMaterializeDrain` so retries/
overlap never stack two sweeps over one brand. New `POST /api/catalog/materialize`
(tenant-checked) for operator-triggered runs; **auto-triggered fire-and-forget at
the end of all four ingest paths** (shopify-direct, generic-sitemap, apify-shopify,
Meta/IG-catalog) once products actually landed — a freshly ingested brand (Vuori 2,
Marine Layer, etc.) now drains on its own, no operator action required. New knob
`CATALOG_MATERIALIZE_CONCURRENCY` (`services/concurrency.js` + `defaults.env`,
default 4 — same rationale as `CLOUDINARY_DELETE_CONCURRENCY`).

**Picker honesty — extends PR #224's vocabulary, not a parallel one.**
`catalogImageQuality.js`'s `catalogSeedFields()` gains `pickerReady` /
`pickerBlockReason`. `seedUnusable`/`seedIssue` are UNCHANGED (still URL-only).
`pickerBlockReason` adds a third state, `'materializing'`, distinct from the two
permanent-failure reasons — lets the frontend (paired PR #58) render "still
preparing" instead of silently doing nothing useful (old behavior: the picker
never actually gated on `imageMediaId` at all — a card was always clickable, it
just queued a product with no selectable seed image) or lumping it in with a dead
seed. `routes/brand.js`'s `onboarding-status` gains a `catalogMaterialize` bucket
(`ready`/`pending`/`excludedUnusable`/`running`) for Brand-page visibility.

**Live-verified, $0 spend, on production Mongo** (no Cloudinary creds in the
verifying sandbox, so proved the mechanism through the already-deployed
per-product `GET /api/catalog/:id` lazy backfill — the exact `materializeMissingHero`
this drain calls in bulk — plus, for the full new endpoint + UI, a local dev build
of both paired branches pointed at prod Mongo): **Pelagic Gear 1 → 824 of 827**
imageMediaId-set (3 remaining are genuinely permanently-unusable gstatic thumbnails);
**Vuori Clothing 56 → 144 of 145** via the actual new POST endpoint + banner UI.
Timing (n=38 real samples, hero+alt combined — this drain is hero-only, so faster):
median 2.87s / p95 4.17s. A 743-item live sweep (concurrency 8) completed in 7m57s,
effectively zero failures. Settled drain-only timing (n=87, no Cloudinary egress in
that run): median 230ms / p95 240ms. **The "~68s/product, ~15.6h serial" figure the
prior agent measured was a full materialize+DETECT chain (Gemini vision + smart
crops) — NOT what this drain does.** This drain is materialize-ONLY, matching the
$0 cost fence `materializeMissingHero` already enforces. At the measured safe
concurrency (4-8, zero errors up to 8), the coordinator's stated ~8,000-product
scale (Pelagic + Vuori 2 + both Marine Layer brands) projects to roughly
**1.5-2 hours** total, bounded and resumable, running in the background.

**Not verified:** the drain's own code path against real Cloudinary credentials
(sandbox had none — proved via the equivalent already-deployed endpoint instead);
behavior above concurrency 8. Coordinated with the concurrent Vuori 2 / Marine
Layer ingest session (message sent, no response captured before this session
ended) — have not directly observed this fix's effect on brands that session
was still ingesting.

New harness `scripts/verifyCatalogMaterializeDrain.js` (45 checks, revert-proven on
3 mutations). `verifyCatalogImageSeedSafety.js` extended (+4 checks, C9-C12) for the
`pickerReady`/`pickerBlockReason` addition. Full suite 166/166, lint clean.
