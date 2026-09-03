# 2026-09-03 — shared video-ref resolver + adgen port required

## The finding

Two of the most recent Pelagic video runs (`6a99d793` Lure Flag,
`6a99cc35` Stick Figure Freespool Islander) went through
**`gemini-omni-1.1-flash`** — a NEW model whose prediction IDs are
`v1_Chd3ZGVa...` (Base64-encoded Google Veo/Gemini identifiers, not the
UUIDs Atlas Omni predictions use) and whose video output lands under
`.../liquidretail/gemini_renders/gemini-omni-1.1-flash/gemini_v1_...`.

The `veoReferenceImages` those masters carry are ALL of the form:
```
b_rgb:FFFFFF,c_fill,w_720,h_1280,g_auto,f_jpg,q_auto:good/v.../catalog-product/x/y.jpg
```

That's `atlasVideoService.cropImageUrlForAspect`'s output — a Cloudinary
`c_fill` with **`g_auto` saliency crop at the model's 720p target dims**.
Zero cost, zero hallucination, but **Cloudinary's built-in saliency model
decides what to centre, not our DINO bboxes**.

Meanwhile the SAME source medias on the SAME run have persisted reframes
on `Media.metadata.reframes.9_16` and `.16_9` — source-native
`pad-product-only` for product_only heroes, `yolo-crop` /
`yolo-crop-forced` for on_model / detail alts, all under
`ladderVersion: 'reframe-v2'`. The reframe cache did its job. Backend
`videoRefPrewarmService` pre-warmed both aspects (Meta 9:16 +
PMax 16:9 — landed 2026-09-03 in commit `01a62e86`).

**The direct-Gemini path doesn't consult the cache.** It calls
`cropImageUrlForAspect` directly, throwing away the DINO decision.

Backend has no code path that submits to gemini-omni-1.1-flash directly
(zero grep hits for `gemini-omni-1.1`, `generativelanguage`,
`/interactions`, `response_format`, or the `gemini_renders` upload
folder outside session notes). The submission is in **liquidretail_adgen**
— the live renderer.

## What backend shipped in response

`services/videoReferenceResolver.js` (new). Single exported helper:

```js
resolveVideoReferenceForMedia({ media, aspectRatio, brand, preferReframe = true })
// → { url, source, aspectKey, method, ladderVersion }
```

1. If `media.metadata.reframes[<aspectKey>].url` exists → return it, with
   source `'reframe-cache'` and the cached `method` + `ladderVersion` for
   post-run tracing.
2. Otherwise fall back to
   `cropImageUrlForAspect(media.fileUrl, aspectRatio, brand)`, source
   `'c-fill-fallback'`. Same URL adgen produces today when it bypasses
   the cache — so the fallback arm is byte-identical to current
   behaviour on cache misses.

`mediaAspectKey(aspectRatio)` is exported alongside — the SAME
normalisation (`[^a-z0-9]+` → `_`) `persistReframe` uses in
`atlasVideoService.js`, so the resolver's key is guaranteed to match
what the writer stored. Harness section D pins that parity across four
aspect ratios; a resolver bug that computed a slightly different key
(dropped underscore, kept `:` verbatim, whatever) would silently miss
every cache entry — no error, no log, 100% `c_fill` fallback. This is
the class of drift the helper exists to make impossible.

Pinned by `scripts/verifyVideoReferenceResolver.js` — 22 checks,
offline, zero DB.

## The adgen port

Adgen's direct-Gemini ref builder MUST import this helper (or an
identical port under adgen's `services/`) and route every reference
through it before submit. Backend cannot force this from here — the
codebase that talks to `gemini-omni-1.1-flash` and stamps
`veoReferenceImages` on ad rows is `liquidretail_adgen`.

Shape of the port:

  - Copy `services/videoReferenceResolver.js` into adgen's `services/`
    verbatim. The only import (`cropImageUrlForAspect` from
    `./atlasVideoService`) is already vendored in adgen.
  - Copy `scripts/verifyVideoReferenceResolver.js` too.
  - Find adgen's direct-Gemini ref builder — grep for
    `cropImageUrlForAspect(` or `c_fill,g_auto` in the adgen render
    loop and titler service; the call site is wherever the model's
    reference-image parameter is assembled from a Media doc.
  - Replace the direct `cropImageUrlForAspect(media.fileUrl,
    aspectRatio, brand)` calls with:
    ```js
    const { resolveVideoReferenceForMedia } = require('./videoReferenceResolver');
    const { url, source, method } = resolveVideoReferenceForMedia({
      media, aspectRatio, brand
    });
    // log source + method alongside the ad id so a post-run trace can
    // separate cache hits from fallback misses per-reference
    ```
  - Log the resolver's `source` field beside every submission so a
    single Render log grep can show which references hit cache vs
    fell through — critical for verifying the port is live.

## Expected impact once ported

Measured on run 6a99d793 (Lure Flag, Meta 9:16 master, 2026-09-03):

  - Media `6a98302271bb20a6b41362ea` has a DINO union of **9 person
    bboxes**, subject 1995×1710 exceeding the 10% tolerance. Backend
    force-crop computed a bbox-centred rect at `x=438, y=0`,
    `w=1125, h=2000` — persisted with `method: 'yolo-crop-forced'`,
    `ladder: 'reframe-v2'`.
  - The direct-Gemini path served Cloudinary's `g_auto` crop at
    `w=720, h=1280` — a completely different portion of the frame,
    chosen by Cloudinary's saliency model with no knowledge of the
    9-bbox subject union.
  - Both are $0 deterministic Cloudinary URLs, but the DINO version
    is the one every other reframe path in the pipeline treats as
    the fidelity source of truth.

Runs on graphic-heavy garments (Vaportek, Stick Figure Collection tees)
have been vision-QC-failing at rates the cache-fed path was
demonstrated to reduce; this port extends that reduction to the
direct-Gemini traffic.

## Not this file's job

  - Changing what the resolver returns per model. If a specific model
    needs target-dim URLs (say `w=720`) rather than source-native
    (`w=2000`), that's a wrapper on top, not a fork of the resolver.
    Bake it into the caller.
  - Deciding whether adgen should call `gemini-omni-1.1-flash` at all.
    That's a routing / model-choice decision upstream; the resolver
    just serves whichever ref the caller asks for.
  - Backfilling `veoReferenceImages` on already-shipped ads. The
    live-run URLs are frozen at submit time; only NEW submits benefit
    from the port.

## References

  - `services/videoReferenceResolver.js` — the helper
  - `scripts/verifyVideoReferenceResolver.js` — 22 offline checks
  - Live evidence: run `6a99d793338db77175601189` (Meta 9:16 master,
    Lure Flag, product `prem-tee-lure-flag-white`,
    prediction `v1_Chd3ZGVaYW9Yc0xjZml6N0lQOThDVjZBaxIXd2RlWmFvWHNMY2ZpejdJUDk4Q1Y2QWs`)
  - Persist writer: `atlasVideoService.persistReframe` +
    `reframeReferenceForAspect` aspectKey normalisation, both in
    `services/atlasVideoService.js`
  - `session.d/2026-09-03_gemini-omni-1.1-flash-direct-leaderman.md`
    documents the ONE POST that established the direct-Gemini path
    exists and produces working output; that same path is now shipping
    production traffic
