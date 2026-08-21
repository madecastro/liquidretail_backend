# 2026-08-21 — the face keep-out's TEST bands do not cover where Stories copy
# actually PAINTS. 21% of the frame is unguarded. Verified, not fixed.

Found while scoping a *logo* keep-out (3 of 9 vision-QC failures on the 2026-08-21 Pelagic
video run were `layout_safe_box` — our own overlay covering the product's brand mark). The
logo work is a separate decision; **this entry is a plain bug in the face keep-out that
already ships**, and it is worth fixing on its own merits.

## The measurement

`services/plateIntelService.js:57-61` — the rectangles keep-out actually tests:

```js
const BANDS = {
  top:    [0.14, 0.28],
  middle: [0.40, 0.55],
  bottom: [0.52, 0.65],
};
```

`remotion/lib/safeZones.js:186-191` — where a `lowerThird` group starts painting:

```js
export const ANCHOR_TOP = {
  upperThird: 0.135,
  lowerThird: 0.54,
};
```

…and how far down it may paint, which is `1 - safeZone.bottom`:

```js
vertical: { top: 0.14, bottom: 0.35, ... }   // paints 0.54 → 0.65   ✅ band covers it
reels:    { top: 0.14, bottom: 0.35, ... }   // paints 0.54 → 0.65   ✅ band covers it
stories:  { top: 0.14, bottom: 0.14, ... }   // paints 0.54 → 0.86   ❌ band stops at 0.65
```

**On `meta_stories_9_16` the region 0.65–0.86 is tested by nothing.** That is 21% of frame
height, and it is precisely where the close phase (`productName`, `deliveryLine`, `cta` —
all authored at `lowerThird`) lands. A face there does not flag. A brand logo there does
not flag. Keep-out is structurally blind to it.

The comment directly above `ANCHOR_TOP` asserts *"content ends by 0.65"*. That is **true for
`vertical`/`reels` (bottom inset 0.35) and false for `stories` (bottom inset 0.14)**. The
bands were evidently sized against the 0.35 surfaces and never re-derived when `stories`
took a 0.14 inset. Classic constant-drift: two encodings of one geometry, in two files,
that must agree and are not derived from each other.

## Why this matters beyond faces

It is the same class as the `safeArea` vs `safeZones.js` trap already in CLAUDE.md §00: an
authority mismatch where the thing you'd naturally edit is not the thing that is read. Here
both files are read — they simply disagree about where the bottom of the frame is.

Corroborating evidence from the run: of the three `layout_safe_box` failures, the
`meta_stories_9_16` one reported *"at t=5.0s and t=7.5s, the caption overlay is placed
directly on top of the primary back logo"* — close phase, `lowerThird`, i.e. inside the
blind region. The two `meta_reels_9_16` failures are a **different** miss: reels' band IS
correct, so those are the `FACE_BAND_OVERLAP_THRESHOLD = 0.20`
(`plateIntelService.js:304`) refusing a small chest mark that cannot cover 20% of an
84%×14% band, plus the untested gaps at 0.28–0.40 and 0.55–0.52 between bands.

## The fix, and why I did not land it

**Derive the test bands from the surface's own safe zone + `ANCHOR_TOP`** instead of
hardcoding three rectangles, so the tested rect is by construction the painted rect. That
removes the drift permanently rather than patching one number.

Not landed, deliberately, for two reasons:

1. **It changes titling placement, which is burned into the delivered file.** Widening the
   bottom band means more `avoid` flags, which means `resolveGroupAnchor` hops groups that
   it previously left alone — a creative change across every Stories ad, not just defective
   ones. That wants an owner decision and a before/after look, not a 1am merge.
2. `plateIntelService.BANDS` is also consumed by the **luma/`busy` scoring** that decides
   dark-vs-light ink, not only by keep-out. Changing the rectangles moves ink decisions
   too. Any fix must confirm whether both consumers want the same geometry — I did not
   establish that, and assuming it is exactly the kind of shortcut that produces the next
   entry in this directory.

Harnesses that pin this area, to run against any fix:
`scripts/verifyProofBeat.js` (K2 pins the Gymshark-wordmark texture behaviour),
`scripts/verifyReelsSafeZone.mjs`, `scripts/verifyBasePlateCrop.js` (P1–P3 pin the detect
prompt).

## Related scoping, so it is not redone

A **logo** keep-out does not exist. The face channel is:
`ensureFaceDetectionForKeepOut` (`basePlateCropService.js:749`, returns `faceSamples` as
0..1 fractions of the SOURCE frame, cached on `Ad.basePlate`) → `applyFaceKeepOut`
(`plateIntelService.js:432`) → `plateHints.bands[*].avoid` → `resolveGroupAnchor`
(`Canonical.jsx:166`) hops the anchor among `KEEP_OUT_CANDIDATES`. **Remotion never
receives the boxes**, only the band flags — so any logo keep-out should populate that same
`avoid` flag and must NOT add a new Remotion prop.

`detectFrameBoxes` returns only `{subject, face}` — no logo box anywhere
(`DETECT_SYSTEM_PROMPT`, `basePlateCropService.js:373-382`). Getting one means either
extending that prompt (**$0 extra, but it is a shared BILLABLE prompt whose job is crop
geometry — degrading `subject`/`face` would behead the 1:1 and 4:5 derivatives, so owner
sign-off**) or a separate vision call (~$0.005–0.014/ad). `Media.refinedProducts` is NOT
a substitute: it boxes the *garment* in *catalog-still* pixels, not the printed graphic on
the Omni plate (`videoProductAnchor.js:29-31` records that mapping as deferred).

⚠️ And note: simply adding a logo box to `faceSamples` would **not** fix the three observed
failures, because of the band-vs-paint gap and the 20% threshold above. The gap is the
prerequisite.
