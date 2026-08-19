## 2026-08-19 — PR: Generate Ads picker 504s on any 2k+ product catalog — root-caused + fixed

Branch `fix/catalog-picker-scale`, worktree, based on `main` (`a035aeb9`). Fixes the
production bug found in live QA: `GET /api/catalog?brandId&limit=100` — the Generate
Ads picker's list call, `limit=100` already in the query — took 3.0s at 214 products,
6.9s at 831, and hit Render's ~29s gateway timeout (504) at 2,446 and 10,553. Two of
four real brands could not open the picker at all.

**Root cause, profiled live against production Mongo (not guessed):** the list
handler ran ONE `aggregate()` with a `$lookup` into `productmatchartifacts`
(matchCount) and a correlated self-`$lookup` into `catalogproducts` (siblings /
variantCount) for EVERY row matching the brand filter, THEN `$sort` + `$skip` +
`$limit` — so both lookups ran across the WHOLE catalog before pagination narrowed
anything. Isolated per-stage on Vuori 2 (10,553 products): `$match` alone ~130ms;
adding the `productmatchartifacts` lookup +17.2s (that collection's `catalogProductId`
had no index — full collection scan per outer doc); adding the siblings self-lookup
on top didn't finish in 2 minutes (self-join, `$expr`-based match can't use an index
inside a `$lookup` pipeline at all). Separately, `catalogproducts` had no compound
index covering `{brandId, deletedAt, lastSyncedAt}` (the sort key), so the bare
`$sort` stage did a blocking in-memory sort of the whole filtered set — at offset
10000 it hard-errored with `QueryExceededMemoryLimitNoDiskUseAllowed` (code 292,
>32MB), not just slow. `q=denim` "fixing" it was coincidental: search just shrank the
set the lookups then ran over.

**Fix** (`routes/catalog.js` GET `/`, full profiling trail in the comment above the
handler): matches are a small collection regardless of catalog size, so resolve
"which products have any match" with one cheap unfiltered `$group` over
`ProductMatchArtifact` (capped at 5,000 — the degenerate-case guard: beyond that, a
match just doesn't get the top-ranking treatment rather than the request degrading),
then split the response into a "matched" segment (small, bounded, materialized in
full, sorted in JS) and a "rest" segment (plain indexed
`find().sort({lastSyncedAt:-1}).skip().limit()`). `variantCount` (siblings) is
likewise computed only for the ≤100 rows on the actual page, one `$group` over their
`itemGroupId`s — never a per-row self-join. Nothing in the hot path scales with
catalog size anymore; `total` is unchanged (`countDocuments(filter)` was already
fast, ~100ms even at 10,553 docs).

**Indexes added** (both confirmed via `explain()` to actually get used):
- `CatalogProduct`: `{brandId:1, deletedAt:1, lastSyncedAt:-1}` — serves the "rest"
  segment's `find({brandId,deletedAt:null}).sort({lastSyncedAt:-1})`. Pre-fix explain
  showed a blocking `SORT` stage examining all 10,553 docs; post-fix,
  `IXSCAN+FETCH+LIMIT` examining exactly `limit` keys/docs, no `SORT` stage.
- `ProductMatchArtifact.catalogProductId` (sparse) — serves both the new list
  prequery and the pre-existing `GET /:id/matches` (`ProductMatchArtifact.find({
  catalogProductId: {$in: familyIds} })`, ~line 1166), which had never had this index
  either.

**Bonus bug found + fixed while rewriting this:** the OLD siblings self-`$lookup`'s
`$expr` used `{$ne:['$$gid', null]}` to skip products with no `itemGroupId` — but a
`$let` variable bound to a genuinely MISSING field doesn't get the usual
"missing == null" treatment once captured through `$$var`, so that `$ne` evaluated
true anyway. Since every real `itemGroupId` in production today is unique to a single
product (zero real multi-member groups exist right now), this meant EVERY product
with no `itemGroupId` — the common case — showed a bogus "+N variants" badge
(`CatalogBrowser/Sidebar.tsx`, `variantCount > 0`) counting every OTHER
`itemGroupId`-less product in the brand as a fake sibling: confirmed live, +13 on
Vuori Clothing, +56 on Pelagic Gear. Fixed as a side effect of the rewrite (siblings
are only ever grouped from real, non-empty `itemGroupId` values now).

**Re-verified live against all 4 real brands** (local instance of this exact branch,
pointed at production Mongo read-only for this endpoint, real HTTP round-trip):

| brand | products | before | after |
|---|---|---|---|
| Vuori Clothing | 214 | 200 in 3.0s | 200 in 0.70s |
| Pelagic Gear | 831 | 200 in 6.9s | 200 in 0.66s |
| Marine Layer | 2,446 | 504 after 28.6s | 200 in 0.53s |
| Vuori 2 | 10,553 | 504 after 28.8s | 200 in 0.54s |

Also verified: `q=denim` search (72 results, 1.6s), deep `offset=10000` on Vuori 2
(previously would hit the same 292 hard-error the raw index-less query did — now
0.93s), pagination walked end-to-end across page boundaries on Vuori Clothing with no
duplicate/missing ids and `matchCount` correctly non-increasing across the entire
214-row walk (proves the two-segment pagination math), and the `?ids=` batch-hydration
path with an id from offset 200+ (returns `total:1`, the correct row — this path was
NOT restructured, just carried through the same segmentation, and still relies on
`find()`'s schema auto-casting the way PR #57's `aggFilter._id.$in` fix originally
established for `countDocuments`).

**Verification:** `npm run lint` clean on all 4 touched files. Full verify suite
153/153 (the 3 known worktree-environmental `sharp`-path failures excluded per
standing note). One existing check needed updating, not just re-passing:
`scripts/verifyCatalogImageSeedSafety.js`'s F3 pinned the OLD implementation's
specific `aggFilter._id.$in ... new mongoose.Types.ObjectId(id)` cast text — this
rewrite deletes that whole code path (no more `aggFilter` for the list handler at
all), so F3 now pins the invariant that actually matters (the ids= filter is wired,
and resolved via `find()` not a raw `aggregate()` $match) and both new checks were
revert-proven (removed the wiring → F3 fails; reintroduced an `aggFilter` alias →
F3b fails; restored → both pass).

**Rebased onto PR #232** (`fix/pelagic-materialize-blocker`, merged as `11041776`
mid-session, see the entry directly above) and **PR #233** (`9d94eb95`, also merged
mid-session, does not touch `routes/catalog.js`) — clean auto-merge on
`routes/catalog.js` and `scripts/verifyCatalogImageSeedSafety.js` (only this file had
a conflict, both sessions' entries kept). #232 touches `projectListRow`'s
`catalogSeedFields()` call (now two-arg, `p.imageUrl, p.imageMediaId`) and adds
`POST /api/catalog/materialize` well after the list handler; this PR does not touch
`projectListRow`'s body or that insertion point. Different bug entirely: #232 is
about `imageMediaId` never getting materialized on freshly-ingested products (so the
picker shows a card with no usable image); this PR is about the list *endpoint
itself* timing out before any cards render at all — independent fixes to the same
picker's two different failure modes.

**NOT verified:** a live browser click-through against the deployed staging domain —
this branch is not merged/deployed yet, and the task's own browser-verification step
is scoped to "after merge." The live-Mongo HTTP round-trip above hits the exact same
route code and the exact same production database staging reads from, so it is the
direct backend-level equivalent, but the actual Generate Ads picker UI rendering this
JSON has not been visually confirmed in a browser this session. Also not verified:
behavior above `MAX_MATCH_GROUPS` (5,000) — today's real global count is in the low
thousands, so this is untested territory by construction, not by oversight.

