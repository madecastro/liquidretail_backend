# 2026-08-19 — Cross-brand tenant leak on POST /generate closed (rescued from an orphaned working tree)

Branch `fix/crossbrand-tenancy-generate`. This fix existed only as uncommitted edits in
the shared `liquidretail_backend` checkout, written by a session that died ~9 hours
before this one started. Rescued into a clean worktree off `origin/main`, verified
against prod, extended (a real gap found while writing the harness), and landed.

## The bug

`POST /api/ads/generate` never asserted that the request body's `productIds` belong to
the campaign's brand. A stale cross-brand product picker on the frontend (or a
hand-crafted request) could mint an `Ad` stamped with the campaign's own `brandId` but
pointing at ANOTHER brand's `CatalogProduct`. When no operator-picked `mediaIds`
narrowed the seeded universe, `buildSeededUniverse`'s product-mode catalog query
(`services/seededUniverseService.js`) filtered only on `metadata.catalogProductId` — no
`brandId` clause — so it happily resolved the OTHER brand's own correctly-tagged media
too, producing a fully cross-branded, billable ad.

## Prod evidence (measured 2026-08-19, via a Render one-off job — MONGODB_URI is already
in env there; `render jobs create --service srv-d1vuktqli9vc73ft07ng --start-command
"node -e \"...\""`, base64-encoded to sidestep quoting)

- **26 ads across 7 distinct brand pairs**, 2026-07-23..2026-08-11.
- **23 of the 26 carry a real billable CostLog receipt** (`atlas_video_render` /
  `direct_image`), summing to **~$17.54**.
- Named example: `Ad 6a7bae8abea2eb1ad6bd0f13`, brand "Pelagic Gear Test 2", `productId`
  resolves to a "Marine Layer 2"-brand `CatalogProduct` ("Isla Double Cloth Short"), the
  ad's single `mediaIds[0]` is that same Marine Layer 2 media — 100% cross-branded,
  `status:'archived'`, `renderUrl` set (it rendered), 4 CostLog rows including a $0.90
  Omni video charge.
- The uncommitted code comment this fix was rescued from claimed "11 with real
  Omni/image-gen receipts" — that number could not be reproduced against a fresh
  measurement (23, not 11) and was corrected in the landed comment. Don't re-cite 11.
- These 26 ads/their spend are **not retouched by this fix** — see KNOWN-OPEN.

## The fix, two parts

1. `routes/ads.js` — new `resolveOwnedProductIds(productIds, brandId)`, called from
   `POST /generate` right after the campaign lookup. Drops any `productId` not owned by
   the campaign's brand (warns, does not 400 the whole request — same pattern as
   `POST /campaigns/:id/products` in `routes/campaigns.js`) **unless every requested
   productId was unowned**, in which case it 400s (`code: 'products-not-owned'`) instead
   of falling through with `productIds:[]`.
2. `services/seededUniverseService.js` — `buildSeededUniverse`'s product-mode
   `catalogQuery` gained a bare `brandId` clause. Defence in depth: a no-op for a
   legitimate `productId` (its media already belongs to that brand), decisive when the
   id is unowned.

## The gap found while writing the harness (not in the original uncommitted patch)

The original patch's all-unowned path fell through with `productIds` filtered to `[]`
and kept going. That is NOT safe: `campaignAdsGenerationService`'s
`useBrandOnly = productIds.length === 0 && mediaIds.length === 0` treats an empty
`productIds` array as "no product scope requested" — the *legitimate*
media-library/brand-wide signal. A caller who asked for specific (unowned) products
would silently get a **full brand-wide expansion** instead of an honest failure — a
scope blowup layered on top of the tenant leak the rest of the fix closes. Added the
400 guard (item 1 above) to close it. Caught because the harness's own spec ("an
all-unowned request doesn't silently proceed with an empty product set") forced tracing
what an empty `productIds` actually does downstream, not just what the original patch's
code comments claimed.

## Verification

- `resolveOwnedProductIds` is extracted (not left inline) and exported from
  `routes/ads.js`, same convention as `claimAdsForRun` / `resolveDeriveFromMaster` /
  `projectAd` in that file — testable without reimplementing it or scanning source text.
- `scripts/verifyGenerateProductTenancy.js` (25 checks): behavioural pins on
  `resolveOwnedProductIds` and `buildSeededUniverse` against faithful (not lenient)
  model-static stubs, an end-to-end drive of the REAL `POST /generate` handler extracted
  off the Router's `.stack` (Campaign/CatalogProduct stubbed, `adReadinessService`
  pre-empted in `require.cache` so every call short-circuits at a deterministic 409
  right after the tenant check — no need to stub the rest of the generation pipeline),
  plus 3 revert-prove mutations (temp sibling copies of the real files, deleted after)
  that each flip a specific named check red. **Proved for real**, not just by the
  mutation harness: stashed the actual fix out of the working tree and re-ran the
  harness — 19 of 25 checks failed, spanning every section (module surface, ownership
  filtering, universe leak, route wiring, source anchors, revert-prove no-ops). Restored
  and re-ran green.
- Adversarial review: traced independently (not just via the harness) that the mediaIds
  path was already brand-scoped by pre-existing code (`Media.find({..., brandId})` in
  `buildSeededUniverse`'s `restrictToMediaIds` branch, "safety — never leak media from
  other brands"), and that a Director's `media_picks` can only ever reach
  `Ad.mediaIds` after being filtered through `universeById.has()` — i.e. the universe
  IS the gate, so this fix's `brandId` clause on the universe query is the actual
  closure point, not a partial one. Checked PRs #240 (video vision QC) and #241
  (undispatched-tail renderStage) that landed on `main` while this branch was in
  flight — neither touches productIds/brandId logic; no interaction.
- Full offline suite: **170/170 `scripts/verify*.{js,mjs}` pass, 0 fail, 0 timeout**
  (re-count before quoting, this number drifts — see `CLAUDE.md` §5) + `npm run lint`
  clean (its one enabled rule, `no-undef`). Includes `verifyLogoSilhouette.js`,
  `verifyLogoColorPreservation.js`, `verifyStaticTextInk.js` — this worktree's
  `node_modules` needed `npm install --no-save https-proxy-agent@5.0.1` (the sharp
  gap the session.md note warns about did not reproduce here; all three passed
  without a separate `sharp` reinstall).

## KNOWN-OPEN carried forward

- The 26 already-existing cross-branded ads (23 with real CostLog spend, ~$17.54) are
  **not cleaned up or flagged** by this fix — it only prevents FUTURE occurrences. Ad
  ids are in the PR description. Someone needs to decide: quarantine/delete those Ads,
  and whether the ~$17.54 already spent needs any accounting treatment. Not attempted
  here — this was a code-correctness fix, not a data-remediation task, and touching
  production Ad documents (deleting billed creative) needs an explicit owner call.
