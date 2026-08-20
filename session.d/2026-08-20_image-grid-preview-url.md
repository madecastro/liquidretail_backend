# Static ad-grid tiles now downscaled — image equivalent of previewVideoUrl. PR #268, NOT YET MERGED.

Owner-reported urgent: static ad images were served as full-resolution PNGs and were the dominant
page-load cost on ad-grid pages, even after the video fix (PR #243/frontend #60) shipped. Real
delivered sizes measured: 1.5-4.3MB per PNG; an 18-static gallery pulled ~40-50MB.

Branch `feat/image-grid-preview-url`, worktree at
`/private/tmp/claude-502/-Volumes-Sayulita-Projects-RS/c11b6fe8-e9aa-40de-bf20-02d8bf71aa33/scratchpad/wt-backend-imgpreview`
(may be gone if that scratchpad dir was cleaned up — recreate off `origin/main` if so, it should
fast-forward cleanly). PR: github.com/Emami-RS-Project/liquidretail_backend/pull/268. Paired
frontend PR: liquidretail#64 (branch of the same name, `master`).

**What shipped:**
- `services/imagePreviewUrl.js` — `buildGridPreviewImageUrl(url, opts)`, mirrors
  `services/videoPreviewUrl.js`'s shape exactly: `c_scale,w_640,q_auto,f_auto` against
  `/image/upload/` instead of `/video/upload/`. 640px chosen (wider than video's 480) because a
  static tile IS the primary visual and the grids that render it cap at a 4-column
  `SimpleGrid` inside a ~1200-1280px content width. Width-only (no `h_`) so 1:1/4:5/9:16/1.91:1/
  1200x1200 statics aren't cropped or letterboxed. Falls back to the input URL (never `null`) for
  anything non-transformable.
- Wired into `routes/ads.js` `projectAd` and `routes/catalog.js` `GET /:id/ads-detail` as
  `previewImageUrl`, computed from **whichever asset is actually displayed** — `extras.photorealUrl
  || ad.renderUrl` in `projectAd`, `photorealMap.get(id) || a.renderUrl` in `ads-detail` — not
  just `renderUrl`, so a pre-2026-07-31 ad whose gallery/detail view shows the gpt-image-1 polish
  doesn't get a tile that silently downscales a DIFFERENT (pre-polish) image. `renderUrl` was
  already in `ads-detail`'s `.project({...})` allowlist so no allowlist change was needed there —
  this is the exact trap `previewVideoUrl` hit before and is called out in both this file's and
  the new verify script's comments so it doesn't get missed a third time.
- `scripts/verifyImageGridPreviewUrl.js` — 18 checks, same shape as
  `scripts/verifyVideoGridPreviewUrl.js`, behavioural (drives the real `buildGridPreviewImageUrl`
  and the real exported `projectAd`), plus a P9 check specifically pinning the photoreal-priority
  behaviour above. Hand revert-proven: broke the transform (c_fill swap), removed the `projectAd`
  wiring, and removed the `ads-detail` wiring one at a time — each went red, then restored to
  green. `npm test`: 179/179. `npm run lint`: clean.

**Real measurement** (see PR #268's top comment for the full table): pulled 11 real static PNG
URLs from Pelagic Gear's live `/product-ads` grid (unpatched, currently-deployed code) and diffed
their actual Cloudinary-served byte counts before/after the transform — **26.37MB → 0.52MB, 98.0%
reduction** across those 11. Per-image range matched the 1.5-4.3MB masters cited in the original
ask. Could not reach the "Marine Layer 2" brand from this login to test against the exact
campaigns named in the ask (`run_1787174963435_ff67021e`, "MArine Layer 2 Test") — the brand
switcher only resolved to "Pelagic Gear" for this account across both listed workspaces (Reach
Social Admin, Sales Demos); not investigated further, not blocking, but worth a look if someone
with broader brand access wants to re-confirm against those specific campaigns.

**Frontend side** (liquidretail#64): `pages/Ads/index.tsx`'s `gridDisplayUrl()` now also prefers
`previewImageUrl` for image ads — fixed a real pre-existing bug where the image branch rendered
`displayUrl(ad)` (full res) directly instead of calling `gridDisplayUrl(ad)` at all (the video
branch already did). `pages/ProductAds/index.tsx` gained a `gridDisplayUrlFor()` (same shape) and
`AdThumbnail` now uses it — covers `pages/ProductAds`, `pages/UgcAds`, `pages/CampaignDetail`, and
`agent/ResourceCard` in one place since all four import `AdThumbnail` from ProductAds. `AdDetailModal`
deliberately untouched, still full resolution.

**NOT fixed, flagged separately (spawned as a background task, not yet started):**
`services/capabilityExecutors/adList.js` (the agent chat's `AdInspectCard`/`ResourceCard` ad tiles)
still emits neither `previewImageUrl` nor `previewVideoUrl` — a pre-existing gap wider than this
PR's scope (routes/ads.js + routes/catalog.js were the two projections named in the ask). Frontend
`agent/ResourceCard.tsx` already has a defensive passthrough waiting for it (`a.previewImageUrl ??
null` etc, currently always null there).

**Not self-merged** per instruction — both PRs open, awaiting review.
