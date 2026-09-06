# 2026-09-05 — stale 8s video-duration fallbacks after the 10s standardization

Worktree: `/Volumes/Sayulita/Projects/RS/.wt-fix-stale-video-duration-backend`
Branch: `fix/stale-video-duration` (off `origin/main`, not pushed).
Paired adgen worktree: `/Volumes/Sayulita/Projects/RS/.wt-fix-stale-video-duration-adgen`.

`config/defaults.env` already has `META_VIDEO_DURATION_SEC=10`. Real Omni clips measure ~10s. Several live fallbacks still used leftover `|| 8` / `: 8` from the provider default. Video cost is `(4k ? $1 : $0.2) + duration × $0.1`, so a wrong duration fallback on estimate or submit is money-adjacent.

## What changed

New `services/videoDurationPolicy.js` is the single `META_VIDEO_DURATION_SEC` reader (10s standard; kill switch 0 → provider 8s). Mint-time `resolveVideoDurationForFormat` now imports `metaVideoDurationSec` from there instead of keeping a second copy.

Live fallbacks wired through `resolveAdVideoDurationSec` / `fallbackVideoDurationSec`:
- `atlasVideoService.estimateRenderCostUsd` omitted duration
- `atlasVideoService.buildVideoSegmentUrl` omitted duration
- `atlasVideoService.generateForAd` (unstamped `Ad.videoDurationSec`)
- `basePlateCropService` detectClipBoxes (2 call sites)
- `brandScriptExecutor` video QC frame sampling
- `ugcVideoPipeline.preparePassthroughMaster` default
- `adRegenerateService` / `routes/ads.js` hardcoded `durationSec: 8` on Cloudinary segments

Left as legitimately-8s:
- `MODEL_CAPS.defaultDuration: 8` and `resolveDurationSec` / `buildSubmissionBody` last-resort `caps.defaultDuration || PROVIDER_DEFAULT_DURATION_SEC` — Atlas provider default and the kill-switch target
- Remotion title-timing 8s grid (`remotion/lib/timing.js` timeScale; 10s plate → 1.25)

`directorTitleCardService.js` is not on `origin/main` (untracked WIP on the dirty adgen checkout) — not in this change.

## Verify

`node scripts/runVerifySuite.js` → **246/246**. New `scripts/verifyVideoDurationPolicy.js` pins the 10s standard, the kill switch, and Omni 720p `$1.00 @ 8s` / `$1.20 @ 10s` (omitted duration must be $1.20, not leftover $1.00).
