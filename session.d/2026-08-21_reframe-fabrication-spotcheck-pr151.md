# 2026-08-21 — PR #151's requested spot-check came back POSITIVE: the generative
# reframe fabricated merchandise on a packshot-heavy brand. Measured. No code
# changed — every lever here is already an owner decision.

**This entry corrects an error in
`session.d/2026-08-21_oom-titling-loop-and-reframe-recolour.md` (PR #304).** That entry
says *"there is no pad branch in that function at all"*. **That is wrong.**
`reframeReferenceForAspect` has had a product-only pad branch since #15, currently at
`services/atlasVideoService.js:1880`, and it runs **before** the crop attempt. I read
`verifyNoVisibleSeedPad.js`'s assertion that the reframe path must not call
`padToRatioBuffer` (the *blur* pad) and over-generalised it to "no pad". Everything else
in that entry stands; this file supersedes it on that one point and adds the reason the
pad did not fire.

## What PR #151 asked for, and what it got

#151 (`0ca9a520`, 2026-08-11, **owner decision**) reverted the product-only $0 pad and
restored generative outfill. Its own words:

> the pad is applied to the SEED handed to Omni, not to a finished plate — so the
> letterbox is generated INTO the video and no downstream crop can remove it… 4:5 (0.80)
> padded into 9:16 (0.5625) scales to fit width and leaves bars across roughly 30% of the
> frame.

> **WHAT WE ARE ACCEPTING.** …no Atlas model exposes a mask or pixel-passthrough (0 of
> 437), so outfill re-synthesises the whole canvas. Over 20 generations on 8 real
> catalogue images that FABRICATED MERCHANDISE — PELAGIC shorts returned as full-length
> trousers… That risk returns in full with this change and is NOT mitigated here; the
> owner weighed it against shipping letterboxed video and chose this. **Spot-check
> merchandise fidelity on packshot-heavy brands.**

That spot-check is this entry. Pelagic Gear, product "Rusted Icon", a white-ground
flat-lay packshot — squarely the case #151 flagged.

### Measured (PIL, on the actual reference of a real $0.90 Omni master)

2000×2000 source → 3072×5504 outpaint, `method:'outpaint'`, `ladderVersion:'reframe-v2'`:

| region | original | outpaint sent to Omni | L1 |
|---|---|---|---|
| **brand logo ink** | `(96,156,168)` teal | `(12,60,96)` navy | **252** |
| shirt body | `(252,240,192)` | `(240,216,156)` | 72 |
| background | `(252,252,252)` white | `(240,240,240)` grey | 36 |

It also **rescaled the garment +13.5%** (86.7% → 98.3% of canvas width, vertical centre
preserved) and cropped the white border away.

**Vision QC then reported the same defect independently**, without seeing any of the
above: *"The original product (IMAGE 1) has a teal/blue logo, but in the video frames the
logo is dark navy blue."* Plus *"an un-sourced logo is added to the front"*, *"a black
woven label tag at t=5.0s… a different, white woven label tag at t=7.5s"*, and the
garment's own printed wordmark mangled to *"PCLADIC"*. 5 of 9 QC failures were
`product_fidelity`.

**So #151's accepted risk is real, is happening, and is now MEASURABLE — which is the one
thing that has changed since #151 was written.** #151 accepted an invisible risk. Video
vision QC (#276/#282/#301, on in prod since 2026-08-20T22:33Z) now catches it
automatically and fail-closes the ad (`approved:false`, no regeneration). The trade-off is
no longer "bands vs silent fabrication" — it is "bands vs fabrication that we detect and
refuse to ship, at $0.90 per detection."

## Why the product-only pad did not fire — and why it SHOULDN'T be re-enabled

It is not a race and not a missing classification. Both are ruled out by measurement:

- The hero **was** tagged `classification.shotType === 'product_only'` at 0.99 confidence
  (*"a single T-shirt centered against a plain white seamless background"*).
  ⚠️ That field is at the Media doc's **TOP LEVEL**, not `metadata.classification`.
- Classification was written **60–70s BEFORE** the reframe (hero: classified 22:28:02,
  reframed 22:29:13). No race.
- `REFRAME_PRODUCT_ONLY_PAD` reads `true`, and all sources are Cloudinary URLs.

The branch simply **is not reachable in the way that matters**: whatever the local detail,
`REFRAME_PRODUCT_ONLY_PAD=true` in `defaults.env` is the *pre-#151* setting and #151's
whole point is that padding a **seed** bakes bands into the delivered video. **Do not
"fix" this by making the pad fire more often.** I nearly recommended exactly that: I built
the deterministic pad locally and it looked perfect as a still (logo ink L1 **0**, exact;
source border stdev **0.00** so the fill is invisible) — and that is precisely the trap.
The reference IS the seed Omni animates. An invisible pad in a still becomes a 44%-white
frame in a moving video. #151 measured that on a Marine Layer run.

I also drafted, then abandoned, a pixel paste-back over the outpaint interior (keep only
the invented margin). **It cannot work here:** the model rescaled the subject +13.5%, so
edge-structure NCC between original and outpaint interior peaks at only **0.60**, at an
80px vertical offset. A centred paste-back leaves a doubled garment edge, so any honest
alignment guard refuses on the very image that motivated it.

## The one genuinely new lever — and it also touches an owner decision

Of this product's three references, exactly one avoided both bands and fabrication:

| ref | media | shotType | refinedProducts | method | outcome |
|---|---|---|---|---|---|
| 0 | `5b22fc` hero | `product_only` | 1 | **outpaint** | recoloured, rescaled |
| 1 | `770673` | `on_model` | 5 | **yolo-crop** | free, lossless, no bands |
| 2 | `77066b` | `on_model` | 3+ | **outpaint** | fabricated |

**A 9:16 crop of a centred square garment cannot preserve it** — the crop window is
1125 of 2000px (56%) and the garment spans 1733px. A person, being tall, *does* survive a
9:16 crop, which is why `770673` got a free `yolo-crop`. So the croppable reference is the
on-model shot; the flat-lay packshot is the worst possible 9:16 seed, and pure feed order
put it at position 0 because it is the merchant's primary image.

`VIDEO_DEFAULT_REFERENCE_SHOT_TYPES` **is the purpose-built dial for exactly this** and is
currently **empty** (`config/defaults.env:515`). It is a preference, not a filter,
precisely so unclassified media are unaffected.

⚠️ **But setting it partially contradicts the owner directive of 2026-08-05** — *"the
primary image as defined by the merchant feed is the main image… The Hero stamp is not
relevant when selecting images for video or static catalog generations"* — and it changes
creative character (animating a model rather than the garment). **So this is a decision,
not a fix.** Owner's call.

## Why no code changed in this entry

Every lever in this area is already an owner decision, and three of them point against the
obvious "fix":

| lever | owner decision |
|---|---|
| product-only $0 pad | **reverted** 2026-08-11 (#151) — bands bake into video |
| reference order = merchant feed | directed 2026-08-05 |
| `REFRAME_RESOLUTION=4k` | chosen 2026-07-24 after reviewing 20 generations side by side; 1k held geometry *worse* |
| Omni camera prompt | frozen, byte-pinned; #61 hardening rolled back for increasing hallucination |

⚠️ Do not read the first paragraph of the `REFRAME_OUTPAINT_MODEL` comment as current — it
opens *"Deliberately NOT 4k"* and is **superseded history**; the live decision is in the
lines below it. I nearly filed that as a bug.

## What IS ours to fix, unambiguously

3 of the 9 QC failures are `layout_safe_box` — **our titling covering the product**, not
the model's fault: *"the caption overlay is placed directly on top of the primary back
logo, obscuring the brand name"*, *"the ad's text and star-rating overlay significantly
obscures the product's main back logo at t=5.0s"*. Titling already has a **face** keep-out
(`ensureFaceDetectionForKeepOut`) but no **logo/brand-mark** keep-out, and we already pay
for 3-frame vision per ad (`base_plate_crop`, 36 calls / $0.1708 on this run), so the
boxes needed are nearly free. This contradicts no owner decision. Best next fix.
