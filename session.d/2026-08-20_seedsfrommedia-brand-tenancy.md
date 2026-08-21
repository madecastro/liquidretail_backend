# 2026-08-20 — seedsFromMedia cross-brand tenancy fix (PR #284)

**Cold-read assumption: you have none of this session's context.**

## Task

Side-finding from the `mediaAssignmentService` cross-brand attach fix (PR #271,
`de243f43` — `assertProductOwned`/`assertCategoryOwned` were advertiser-only, never
brand-scoped). A Grok `--effort xhigh` reachability trace during that PR flagged a
downstream consumer of the same shape of data, explicitly out of scope for #271:
`services/campaignAdsGenerationService.js`'s `seedsFromMedia(brandId, mediaId, opts)`
does `Media.findById(mediaId)` with no brand filter, then mints ad seeds off
`matchedProducts[].catalogProductId`. Task: investigate reachability, fix with
brandId scoping (fail-closed, house convention), write a revert-proof behavioural
harness, run `npm test` + `npm run lint`, open a PR, do not self-merge.

## Established facts (file:line evidence)

- `seedsFromMedia` already received `brandId` as its first argument and never used
  it — `services/campaignAdsGenerationService.js:2238` (pre-fix).
- `/generate`'s `mediaIds` request param has **no ownership check anywhere** on the
  path to `seedsFromMedia`, unlike `productIds`: `routes/ads.js:424`
  `resolveOwnedProductIds` scopes `productIds` (drops foreign, 400s if none owned,
  called at `:587-612`); no equivalent exists for `mediaIds`. Confirmed via Grok trace
  + independent grep — `resolveOwnedProductIds` is the only such helper in the file.
- Scoping the Media read alone is insufficient: an own-brand Media row can carry a
  foreign `catalogProductId` via (a) a **pre-#271** operator attach — #271's own
  header comment at `services/mediaAssignmentService.js:9-11` states it is
  "Forward-only: this does not remediate any pre-existing cross-brand row", and it
  hardcodes `outcome:'product_match'` (`:90`), the exact value Case 1 of
  `seedsFromMedia` selects on; (b) the keeper-repoint write paths —
  `services/catalogRetroLinkService.js:150-154` and
  `services/catalogProductPromoteService.js:118-122` both do
  `Media.updateMany({'matchedProducts.catalogProductId': loserId}, {$set:
  {'matchedProducts.$[elem].catalogProductId': keeperId}})` with **no Media.brandId
  clause** — same-brand is an invariant of the caller (twin-matching by
  `brandId`), not of the write itself.
- Reachability, precisely (this needed manual verification — Grok's first pass
  slightly overstated the mitigation): `seedsFromMedia` sits on the **legacy
  cartesian path**. `expandWizardJob` (`campaignAdsGenerationService.js:1475-1614`)
  routes image through `runConceptDrivenExpansion` instead whenever
  `aiConceptDriven || wantsVideo || presetStaticFormats.length > 1`.
  `config/defaults.env:31` ships `AI_CONCEPT_DRIVEN=true`. I verified
  `runConceptDrivenExpansion` (`:3696-4340`) has **no `return null` path** — every
  return is an object — so the documented "fall through to legacy on empty result"
  (`mergeExpansionResults(detResult, conceptResult)` at `:1584`, falls through only
  if both are falsy, `:1613`) **cannot actually fire** when the concept branch runs.
  Net: this is a latent / defense-in-depth hole today, not a live money leak on the
  shipped default — reachable when `AI_CONCEPT_DRIVEN` is off, or on any future
  caller of the now-exported function. Stated exactly this way in the harness header
  so it isn't overstated either direction.
- `models/Media.js:109-120` — `matchedProducts[]` subdocs have no brand field of
  their own; brand is only inferable via `Media.brandId` (the parent) or by joining
  `catalogProductId → CatalogProduct.brandId`.

## Fix

`services/campaignAdsGenerationService.js`, `seedsFromMedia`:
1. `if (!brandId) return [];` — fail-closed, zero queries (house idiom, PR #257).
2. `Media.findById(mediaId)` → `Media.findOne({_id: mediaId, brandId})`.
3. New helper `ownedCatalogProductIdSet(ids, brandId)` (same fail-closed idiom,
   mirrors `resolveOwnedProductIds`'s shape) — both the `campaignKind==='brand'`
   short-circuit and the Case-1 `trueProductMatches` path now read
   `ownedMatchedProducts` (brand-filtered) instead of raw `media.matchedProducts`.
4. Tier-0 alt-expansion catalog query gained a `brandId` clause (same guarantee
   PR #245 added to the equivalent query in `seededUniverseService.js:537-539`).

Both `seedsFromMedia` and `ownedCatalogProductIdSet` are now exported (same
precedent as this file's existing `firstCatalogMediaForProduct` export, kept
specifically for its harness).

## State

- **Branch:** `fix/seeds-from-media-brand-tenancy`, pushed to origin, rebased clean
  onto `origin/main` at `db85ac08` (no file overlap with the intervening commits
  #282/#283/#281/#280/#279/#277/#269).
- **PR:** [#284](https://github.com/Emami-RS-Project/liquidretail_backend/pull/284)
  — **open, NOT merged, per instruction not to self-merge.**
- **Gate:** `node --check` clean. New harness `scripts/verifySeedsFromMediaBrandTenancy.js`
  — 21/21 passed, independently re-run (not just Grok's self-report) with
  `NODE_PATH=<main checkout>/node_modules node scripts/verifySeedsFromMediaBrandTenancy.js`
  (this worktree's committed `node_modules` subset lacks `eslint`/`https-proxy-agent`
  — known limitation, see `CLAUDE.md` §4). Manually reintroduced a real one-line
  regression (`findOne`→`findById`) directly into the fixed file (not the harness's
  own synthetic revert-prove copy) and confirmed the harness's own behavioural
  assertion (A1) goes red — restored immediately after.
  `npm test`: **182/183**. The one failure, `verifyTitleBeatScale.mjs`
  (`ERR_MODULE_NOT_FOUND` for `remotion`), is confirmed pre-existing and unrelated:
  `node_modules/remotion` is simply absent from this worktree's committed subset
  (`.mjs` ESM resolution can't be patched via `NODE_PATH`, per the
  `node-modules-is-tracked-in-rs-backend` limitation); reproduced the same file
  passing 42/42 standalone in the main checkout where `remotion` exists.
  `npm run lint`: clean (exit 0) on both changed files, via the same `NODE_PATH`
  borrow.
- Main checkout (`/Volumes/Sayulita/Projects/RS/liquidretail_backend`) was NOT
  touched by this work and was NOT used to run the suite — it is currently dirty
  and ~26 lines diverged from `origin/main` on this exact file (other live
  session's in-flight edit), so running the gate there would have tested the wrong
  code. All work happened in a clean worktree branched off `origin/main`.

## Next action

Get PR #284 reviewed and merged (by a human or another session — not by me, per
instruction). No further code work pending on this thread. If a future session
wants to close the reachability gap fully rather than defense-in-depth, the actual
missing piece is a `resolveOwnedMediaIds` equivalent to `resolveOwnedProductIds` in
`routes/ads.js`, scoped at the `/generate` HTTP boundary — not attempted here
(out of scope, and `seedsFromMedia`'s own fix already closes the money-relevant
gap regardless of whether that boundary check ever gets added).

## Dead ends

- Do not trust Grok's framing of `AI_CONCEPT_DRIVEN` reachability at face value —
  its first-pass trace said the legacy path was reached "only when the concept
  branch is not taken" without checking whether the branch's own fall-through
  could still land there. It can't (confirmed: `runConceptDrivenExpansion` has no
  `return null`), but that required an independent read of `:3696-4340`, not just
  accepting the trace's prose.
- Don't try to run the full suite against the main checkout to "double check" —
  it's dirty and stale (diverges from `origin/main` on the very file under test),
  so a run there proves nothing about the actual fix.

## Blocked on

Nothing. Not blocked — PR is open and complete, waiting on review/merge only.
