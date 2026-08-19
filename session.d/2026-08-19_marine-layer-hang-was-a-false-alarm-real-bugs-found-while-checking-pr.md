## 2026-08-19 — Marine Layer "hang" was a false alarm; real bugs found while checking — PR #233

Branch `fix/apify-catalog-only-guard`, worktree `.worktrees/ingest-heartbeat-hang`
(name is stale — created before the premise below was retracted). **Landed, not yet
merged.**

**The premise was wrong — read this before "fixing" a heartbeat/reaper again.** A
`syncBrandApify` re-ingest of Marine Layer (`6a7ad28d935d0a8e819039e2`) was reported as
frozen for 20+ minutes after upsert (0% CPU, 0 sockets, heartbeat still refreshing). It
was **not stuck**: it completed in **42.9 minutes** —
`{ok:true, shopify:{added:2441, videos:0, reviews:0, errors:2}, ig:{ok:false, reason:
'APIFY_TOKEN is not set'}}`. The log shows two `store rate-limited this server` breaks
(media stage, then reviews stage) with several thousand 400ms-paced product-page fetches
between them. The "0% CPU / 0 sockets" snapshot was almost certainly caught during a
paced/backoff gap, not a wedged process. **No heartbeat/reaper/progressService change
shipped anywhere from this** — a speculative process-wide threadpool-saturation guard in
`ingestShotClassifyService.js` was drafted against the (wrong) hang theory and reverted
before this branch existed. `git log` / `git diff` on this branch has zero touches to
`progressService.js`, `worker.js`, or `backlogWatchdog.js`.

**Two real bugs found while checking the evidence, both fixed in PR #233:**

1. **Money landmine, confirmed live** — the same run's log shows
   `ig:{ok:false, reason:'APIFY_TOKEN is not set'}`: `syncBrandApify` DID attempt the paid
   Apify Instagram actor as a side effect of a catalog-only re-sync, purely because
   `brand.apifyDemo.igHandle` was still stamped from an earlier demo setup. It cost $0
   only because the token was unset in this environment. Fixed:
   `syncBrandApify(brandId, { skipInstagram })`, decided by the exported pure
   `shouldRunInstagramSync()`; default behavior unchanged for the three existing
   combined-pull callers. `igWasAttempted()` stops a deliberate skip from being
   misreported as "Instagram ingested nothing" by `apifySyncOutcome.computeSyncOutcome`.
2. **Background work died when the script disconnected** — the end-of-run trio
   (on-site review scrape + catalog enrichment, category inference) and the IG-side
   brand-enrichment trigger all fired via `setImmediate()`, which defers one tick but
   does not keep the caller's Mongoose connection open for it. The one-off re-ingest
   script disconnected right after `syncBrandApify` returned; all three then threw
   "Client must be connected before running operations" — measured live, three times,
   silent (console.warn only). Fixed by calling directly (no setImmediate) and exposing
   the promises as `backgroundWork` on the result so a connection-owning caller can await
   them first. Existing HTTP/executor callers ignore the field, unaffected.

Also: mid-stage rate-limit breaks used to collapse into a bare `errors[].length` on the
caller's side — an operator watching a finished run with `videos:0 reviews:0` had no way
to tell "rate-limited" from "nothing to find". Now surfaced as `mediaRateLimited` /
`reviewsRateLimited` on the result plus an immediate `run.note()` (existing
progressService channel, not a new one).

Pinned by `scripts/verifyApifyCatalogOnlyGuard.js` (13 checks) and
`scripts/verifyIngestBackgroundWorkSurvives.js` (8 checks), both offline, both
revert-proven. Full suite 167/167, `npm run lint` clean.

**Found in passing, NOT fixed here, needs the owner (data repair blocked by the
auto-mode classifier — same as `scripts/backfillCostReconcile.js`'s precedent, did not
attempt to bypass it):** 12,124 `Media` docs (`source:'catalog-product'`) carry
`brandId:null` and a literal `/undefined/` Cloudinary folder segment — **2,438 on Marine
Layer, 9,686 on Vuori 2**, `createdAt` all between 09:12–10:07Z today. All 12,124 resolve
100% cleanly via `metadata.catalogProductId` to a real `CatalogProduct` with the correct
`brandId`/`advertiserId`/`brand`/`category` — the checked-in `materializeImage` /
`catalogMaterializeDrainService.js` code reads `product.brandId` correctly, so this looks
like an incomplete field projection in whatever ad-hoc/benchmark script called
`materializeMissingHero` directly against these two brands earlier today. Effect: any
Media query scoped by `brandId` (e.g. ad-generation seed selection) cannot see these hero
images even though `CatalogProduct.imageMediaId` points at them — **materialized-looking,
not actually usable.** Dry-run-verified, idempotent backfill script saved at
`/private/tmp/claude-502/-Volumes-Sayulita-Projects-RS/c11b6fe8-e9aa-40de-bf20-02d8bf71aa33/scratchpad/backfill_media_brandid.js`
— run with `--apply` to write. Separately: Marine Layer's own `imageMediaId` pointers are
already 100% populated (2446/2446) and `fix/pelagic-materialize-blocker`'s drain reports
0 remaining candidates for it — that half of "unstick Marine Layer" is already done by
someone else's work, not this session's.

**Also flagged, owner's call, not touched:** Marine Layer (2446 products) and Marine
Layer 2 (2295) are ~90% title-overlapped with near-identical average prices ($81.04 vs
$80.86) — looks like the same store ingested twice. `reviews:0` on Marine Layer is a
genuine Yotpo vendor-coverage gap (every product page shows "yotpo widget detected, no
structured reviews on page"), not a bug to retry. The same `setImmediate()`
background-work-outlives-connection pattern also exists in `catalogSyncService.js`,
`genericCatalogIngestService.js`, and the legacy `syncBrandShopify` path in
`apifyIngestService.js` — same bug class, not fixed here (this diff stayed scoped to the
paths actually implicated in the observed incident).

