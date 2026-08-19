## 2026-08-18 — Generate Ads picker: gstatic-thumbnail seeds + 50-item cap. PR #224 (backend) + liquidretail #57 (frontend), NOT YET MERGED.

Owner-reported live QA on staging, `/generate-ads` step 2. Two bugs, one PR pair.

**Bug 1 — a Google Shopping thumbnail could become a product's generation seed.**
Root cause: `productDetailsService.writeThroughToCatalogProduct`'s SerpAPI
gap-fill wrote `fetched.thumbnail` (gstatic's `encrypted-tbn*.gstatic.com`
CDN — a tiny proxy image, often fails to load) into `CatalogProduct.imageUrl`
whenever a fresh `detect-identified` row (created by
`ensureCatalogProductForMatch`, always `imageUrl: null` at creation) had no
image yet — no host check at all. `catalogProductDetectService.materializeImage`
then mirrored it into Cloudinary and stamped `imageMediaId`, which is exactly
the "generation ready" signal the picker and the render pipeline's default-seed
resolution read. **Live DB scan, all brands:** 91 rows affected (90
`detect-identified` + 1 `ig-catalog`), zero carry any `additionalImages`, so a
straight null-out backfill is safe.

Fix: one new pure classifier, `services/catalogImageQuality.js`
(`isUnusableThumbnailUrl` / `shouldFillImageUrl` / `unusableSeedImageReason` /
`catalogSeedFields`), consumed at the write-guard
(`productDetailsService.js`), the materialize-guard
(`catalogProductDetectService.js materializeImage` — the shared choke point
for `enqueueProductDetect` **and** the lazy `materializeMissingHero`/`Alts`
backfills, so no caller can reopen this individually), and the read-side
honesty flag (`routes/catalog.js projectListRow` → `seedUnusable`/`seedIssue`,
consumed by the frontend picker to grey + label + disable the tile instead of
silently accepting it). Full writeup: `docs/PIPELINES.md` §3 "`imageMediaId`
existing is NOT the same as the hero being a real photo".

**Adjacent bug found while live-testing the above, same file
(`routes/catalog.js`):** the `?ids=` batch-hydration filter built
`_id: { $in: [<string ids>] }` for the aggregation pipeline — `aggregate()`'s
raw `$match` never auto-casts strings to ObjectId, so this silently matched
**zero rows** (while `countDocuments(filter)`'s `total` was correct). This is
the exact mechanism the picker's pre-selected-id hydration depends on. Fixed
with the same cast pattern already used for `brandId`/`advertiserId` two lines
above.

**Bug 2 — the picker hard-capped at 50 with no search, no pagination.**
Frontend-only: `Step2Picker.tsx` hardcoded `limit=50`; the backend already
supported `offset`/`hasMore`/`total` and a `q` search (title/description).
Fix: raised the request to the backend's real max (100), added a debounced
search box (backend PR also extended `q` to `externalId`/`retailerId`), and a
"Load N more" button that pages via `offset` and appends.

**Verify:** `scripts/verifyCatalogImageSeedSafety.js` — 37 checks, EXECUTES the
real functions (Mongo/Cloudinary stubbed, same convention as
`verifyIngestShotClassify.js` §F) — not a source-text assertion. Revert-proven
against all three fix sites (31/37, still failing correctly per site when
reverted individually). Full 144-script suite + lint clean on the branch.
**Backfill** `scripts/backfillUnusableSeedImages.js` — dry-run by default;
dry-run against the live Vuori catalog matched the 14 rows the QA report named
exactly. **NOT run with `--apply` against production** — left for the owner to
decide when.

**Browser-verified**, not deployed: ran the fixed backend + frontend locally
(pointed at the same shared MongoDB), confirmed both fixes end-to-end
(BROKEN IMAGE/NO PHOTO badges + disabled tiles; search surfacing the
previously-50-cap-buried Denim Jacket; Load-more advancing past 100). "Before"
screenshots/diagnostics captured directly on live `staging.reach-social.io`.
Neither PR has been merged or deployed as of this entry.
