## 2026-08-20 — productUrl / funnelStage never reached three endpoints PR #263 missed

Branch `chore/verify-ads-detail-producturl`, worktree
`.worktrees/retailer-link-catalog-check`, branched fresh off `origin/main`
(`d9c7dd0d`). PR #273.

**The trigger:** owner reported the retailer product-page link (PR #63/#263)
wasn't visible anywhere he actually looks. `pages/Ads/index.tsx` (the legacy
`/ads` gallery) had it; `pages/ProductAds/index.tsx` (`/product-ads`, the
primary nav route) did not, despite `AdDetailModal`/`AdThumbnail` living
there and being shared by five other surfaces.

**Root cause — the same explicit-allowlist trap PR #263's own commit message
warned about, hit three more times:**

- `routes/catalog.js` `GET /:id/ads-detail` — had `funnelStage` in its
  `$project` (PR #263 did add it here) but never called `loadProductUrlMap()`
  at all, and its `$project` omitted `brandId` — so even a naive call to that
  shared helper would've silently resolved an empty map, since
  `loadProductUrlMap` groups its per-brand join by each row's own
  `ad.brandId`, not the route's already-known `brandObjectId`.
- `routes/campaigns.js` `GET /:id/ads-detail` (the `/campaigns` expansion) —
  missing `funnelStage` **and** `productUrl` entirely; PR #263 apparently
  never touched this file.
- `services/capabilityExecutors/adList.js` (agent `ad.list` capability,
  feeds `agent/ResourceCard.tsx`) — same double gap, plus its own
  `.select()` allowlist needed `brandId` added for the same reason.

**Fix:** same pattern in all three — import `loadProductUrlMap` from
`services/adDisplayUrlService.js`, add `brandId` to the projection/select,
add the `loadProductUrlMap(ads)` call alongside the existing
photoreal/useImageRef joins, thread `productUrl` (+ `funnelStage` where
missing) into the response the same shape `routes/ads.js` already uses.

**Verification — no local Mongo, no CLI, no mongosh installed on this
Mac, so a Docker `mongo:7` container was used instead:** seeded via the real
mongoose models (Advertiser/User/AdvertiserMembership/Brand/Campaign/
CatalogProduct/Media/Ad) — one product with the real prod Pelagic
`productUrl`, one without. Ran a minimal Express harness mounting the real
route files + `requireAuth` against that fixture Mongo (not a mock — the
actual route code, actual middleware, actual shared service). Both fixed
endpoints and the `adList.js` executor (called directly at the function
level) returned `productUrl` correctly for the product with a URL and
`null` (never `undefined`, never a throw) for the one without.
`npm run test:affected` fell back to the full suite (couldn't resolve
`routes/campaigns.js`'s dependents) — 178/178 passed regardless.

**Companion frontend PR:** `Emami-RS-Project/liquidretail#66` — adds the
retailer-link render block + intent-profile/media-type tile treatment to
`AdDetailModal`/`AdThumbnail`, plus forwards both fields through the three
frontend adapters (`UgcAds`, `CampaignDetail`, `ResourceCard`) that were
also silently dropping them despite the fields already being on the wire
via `/api/ads` since PR #263.

**Not touched, on purpose (flagged as follow-up candidates, not fixed
here):** `pages/RenderActivity` (pipeline-diagnostics board, doesn't render
ad creative/metadata at all) and `pages/MediaLibrary/Canvas.tsx` (renders
source Media, not generated Ads) were checked and don't apply.
`components/GenerationInspectorModal.tsx` is a diagnostic drill-down opened
*from* `AdDetailModal`, not an independent ad-listing surface, so it inherits
coverage rather than needing its own fix.
