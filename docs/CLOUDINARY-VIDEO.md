# Cloudinary video transforms — what actually works

Live-probed 2026-07-29 against cloud `reach-social-prod` with a real asset
(`/video/upload/v1784827554/liquidretail/brand_script/product-…mp4`, source
1080×1920, 192 frames). **Re-probe before trusting this** — entitlements and
Cloudinary behaviour both change.

Why this file exists: several of these limits are not in Cloudinary's docs in a form
you find by searching, one of them contradicts a comment in our own code, and one
recommendation that looked obviously right (`fl_relative`) is flatly unsupported.

## Probe results

| transform | result |
|---|---|
| *(no transform)* | 200, 7,832,857 b, 1080×1920 |
| `c_fill,w_540,h_540` | 200, **540×540**, synchronous |
| `c_fill,w_540,h_540,g_center` | 200, **540×540**, synchronous |
| `c_fill,w_540,h_540,g_auto` | **423 `Video tracking-crop is pending`** ×3, then 200 |
| `c_crop,w_1080,h_1080,x_0,y_154/c_scale,w_540` | 200, **540×540**, 379,643 b, synchronous |
| `c_scale,w_1080/c_crop,w_1080,h_1080,x_0,y_154/c_scale,w_540` | 200, **byte-identical** 379,643 b |
| `c_fill,…,g_xy_center,x_540,y_400` | **400 `Gravity xy_center not supported for video`** |
| `c_fill,…,g_face` | **400 `Gravity face not supported for video`** |
| `c_crop,fl_relative,w_1.0,h_0.5625,y_0.08` | **400 `resize marked as relative but not performed on a layer`** |

## The four things worth remembering

**1. No face gravity on video.** `g_face` and `g_xy_center` are both rejected outright,
with `x-cld-error` naming the limitation directly (*"Gravity face not supported for
video"*) rather than an entitlement problem — so this reads as a Cloudinary product
limit, not an add-on we lack. Caveat: verified on **one account, one asset**; the error
text is the reason to believe it generalises, not a second data point. `g_auto` weighs
face location among edges/entropy/motion, but it is saliency, not face-targeting, and
you cannot steer it. **So face-aware video framing has to compute its own rect and pass
explicit coordinates.**

**2. `fl_relative` does not work on a base asset** — layers/overlays only. Normalized
crop coordinates are therefore not available directly. This kills the obvious fix for
the coordinate-space bug below.

**3. `g_auto` on video is asynchronous, per asset.** The first request for a given
asset kicks off a "tracking-crop" analysis job and returns **423** with an
`image/gif` placeholder.

Be careful with the numbers here, because only some of them are measurements:
- 423 on three consecutive immediate retries, then 200 on a later check — **observed**.
- The cold-start duration is **NOT measured**. The first request was never timestamped;
  "minutes" is an inference from the gap between commands. Do not quote it as data.
- A *different* `g_auto` variant on the **same** asset returned 200 in **≤5s**, and an
  `so_0` poster derived from a warm variant returned immediately — **measured**.
- From those two, the analysis *appears* to be per-asset and shared across
  derivatives. That is a one-asset, one-sequence observation, not an established
  Cloudinary property.

Why that matters here: composite URLs are **never fetched server-side** (verified in
code). They are persisted as `ad.renderUrl` (`renderService.js:1035`,
`aiOverlayPolishService.js:208`) and dropped into `<video src>`
(`adPreviewPageService.js:220`), with `posterUrl` derived from the same chain
(`buildPosterFromComposite`, `:1348-1353`).

The consequence is **reasoned, not observed**: if a browser is handed a cold `g_auto`
URL and does not retry through the 423, playback fails until the analysis completes.
Since each generated ad is a new asset composited once, the cold path should be the
normal path. But nobody has watched a real first-view fail — client retry behaviour,
CDN caching, and any pre-warm all sit between the code and the user. Treat it as a
credible failure mode to test, not a confirmed outage. The upload-time `eager`
hint (`atlasVideoService.js:2379`) mitigates it by starting the analysis early — but
it is gated on `!aspectsMatch`, it does not cover every upload path, and eager
pre-generates an **exact** transformation string which is *not* the composite chain's.
It works by warming the shared analysis, not by pre-building the derivative.

**Explicit `c_crop` avoids all of this**: synchronous, exact, no analysis job.

**4. The coordinate-space bug, and the actual fix.**
`videoCompositeService.js:83-110` documents why the v1 bbox chain was retired: crop
coordinates were in **upload** pixel space while Cloudinary delivers video at a capped
resolution, so `c_crop,w_2268,h_2268` clipped and `c_lpad` black-padded the remainder.
Three prior fixes missed it because the bbox *was* in bounds of the upload dims — the
upload dims just are not the transform pipeline's dims.

The fix is **not** `fl_relative` (see #2). The candidate is a **`c_scale` prefix**: pin
the coordinate space before cropping, so `c_scale,w_1080` turns any upload into exactly
1080-wide and a rect computed against those dims is exact by construction.
`videoCompositeService.js:119-133` already computes `workW/workH` capped at
`MAX_VIDEO_OUTPUT_DIM = 1080`; scale to those, then crop in that space.

**Separate what is proven from what is reasoned** — these got conflated once already:
- **Proven:** `c_scale,w_1080/c_crop,…/c_scale,w_540` returns 200, synchronously,
  byte-identical (379,643 b) to the bare `c_crop` chain. The syntax works.
- **NOT proven:** that this fixes the oversized-upload mismatch. The probe asset is
  1080×1920 — *already within* the delivery cap, so `c_scale,w_1080` was a no-op on it
  and the failure mode was never reproduced. The v1 bug needed something like
  2268×4032. Until that is tested against a genuinely oversized upload, treat the fix
  as a well-grounded hypothesis, not a verified result.

## Correcting a comment in our own code

`atlasVideoService.js:565-567` claims accounts without the Cloudinary AI add-on
**400 on every `g_auto`**. That is wrong on this account: `g_auto` returns 423-then-200,
never 400. Cloudinary's docs put the add-on requirement on **object-scoped** gravity
(`g_auto:<object>`, `g_handbag`), not plain `g_auto`.

## How to re-probe

A nonexistent public_id **cannot** test this — Cloudinary validates the asset before
the transform, so every variant returns `Resource not found` regardless of gravity.
Use a real `/video/upload/` URL and read the `x-cld-error` header:

```bash
curl -sS -o /dev/null -D - -A "Mozilla/5.0" \
  "https://res.cloudinary.com/reach-social-prod/video/upload/<transform>/<real_public_id>.mp4" \
  | grep -iE "^(HTTP|x-cld-error|content-type|content-length)"
```

Note `c_fill` responses stream without `content-length`, so compare **actual output
dimensions** rather than byte counts:

```bash
ffprobe -v error -select_streams v:0 -show_entries stream=width,height,nb_frames -of csv=p=0 "<url>"
```
