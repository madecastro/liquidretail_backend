# 2026-08-21 — OWNER VERDICT: the generative reframe is ACCEPTABLE. Do not "fix" it.
# Closes the question left open by 2026-08-21_reframe-fabrication-spotcheck-pr151.md.

**Read this before acting on either earlier reframe entry from today.** Both framed the
generative reframe as an open decision needing the owner's call. The call has been made,
against a full visual review of every affected image, and the answer is: **leave it alone.**

## What was put in front of the owner

All 33 catalog images whose video reference was produced by
`google/nano-banana-2/edit-developer`, each beside the real catalog photograph it came from,
plus 10 non-generative references (`yolo-crop`, `pad-product-only`) as controls, plus magnified
print-detail crops aligned to each image's own subject bounding box. Measurements shown, **no
verdict offered** — deliberately, because this session had already misjudged the set twice by eye.

## The verdict, verbatim

> *"these all look completely acceptable with the exception of Rusted Icon which had two
> notable color shifts and I would reject"*

The criteria that matter, also verbatim, so future sessions judge by the same standard:

> *"I am more concerned about significant shifts in color and of course logo deformation, type
> deformation, stitching details, fabric, etc"*

And explicitly NOT problems — ruling on cases this session had wrongly escalated:

> *"the hand stretching the fabric is fine, the logo is intact and correct. The shirt is resized
> but the graphics are to scale"*

So: **composition changes are not damage.** Invented legs, footwear, a hand entering frame, and
rescaling where the graphics stay proportional are all acceptable — the reference exists to fill
a taller frame. Only the product's own appearance counts.

## The resulting rate and cost

| | |
|---|---|
| distinct products with a generative reference | 9 |
| products the owner would reject | **1** (Rusted Icon) — 11% |
| references at the rejectable colour shift | 3 of 33 — 9% |
| cost of a rejected product | $0.40 references + $0.90 Omni master ≈ **$1.30** |
| **expected waste per product generated** | **≈ $0.14** |

And nothing ships. Rusted Icon **is** the product from the 2026-08-21 billable run: 9 of its 12
vision-QC verdicts failed, 5 on `product_fidelity`, with the verbatim finding *"the original
product (IMAGE 1) has a teal/blue logo, but in the video frames the logo is dark navy blue."*
Every affected ad was stamped `approved:false` with no regeneration.

**The whole chain behaved correctly:** a degraded reference produced a degraded video, QC
detected it semantically, and the ads were refused for ~$1.30. That is precisely the bet PR #151
made when it accepted this risk, and it paid off.

## Do NOT do these four things — each ruled out on measurement, not opinion

1. **Do not re-enable the product-only pad for 9:16.** Unchanged from #151: the reference IS the
   seed Omni animates, so letterbox bands bake into the delivered video and no downstream crop
   reaches them.
2. **Do not build a pixel pre-flight screen** to reject references before paying for the master.
   **Measured: it cannot work.** Ranked by print-colour delta, the owner's three rejected
   references sit at ranks **4, 5 and 8** — interleaved with references he *accepted* at deltas
   of **730, 410, 260, 250 and 210**. Lunker Jacket carries the worst number in the entire set
   and was accepted; Rusted Icon scores lower and was rejected. **No threshold separates accept
   from reject.** Only a semantic judge does, and that judge already exists.
3. **Do not route by product attribute.** Damage correlates with nothing measurable (n=31):
   print contrast **r=+0.03**, garment lightness +0.34, on-model −0.16, product-only −0.01,
   target aspect 9:16 +0.13, is-primary-image −0.01.
4. **Do not build the paste-back composite.** Abandoned on measurement: the model rescales the
   subject (+13.5% on the case measured in detail), so edge-structure correlation between the
   original and the outpaint interior peaks at **0.60**, at an 80px vertical offset. A centred
   paste-back leaves a doubled garment edge, and any honest alignment guard refuses on the very
   image that motivated it.

## What IS still worth doing

1. **Keep video vision QC on.** It is the only instrument that detects this class. This entry is
   the evidence it earns its ~$0.025/ad.
2. **The keep-out band gap** (`2026-08-21_titling-keepout-band-gap.md`, PR #306) is a separate,
   still-open, plain bug — `plateIntelService.BANDS.bottom` tests 0.52–0.65 while Stories copy
   paints to 0.86. That one is ours, not the model's. Moved to another session 2026-08-21.

## Method note — two metrics with ZERO discriminative power, do not resurrect them as gates

- **Colour clustering** (dominant fabric/ink colour delta): catches a recolour, scores a
  stitching loss as clean, and ranks an *accepted* image worst in the set. It also silently locks
  onto **skin tone** on on-model shots — the "Lunker Jacket Δ730" row is a shadow compared with
  a forearm, and is meaningless.
- **Ink coverage / stroke weight**: catches the stitching loss, scores the recolour as clean, and
  is confounded by the model's rescaling (one reference reads 21.7% → 1.6% purely because a
  proportionally-aligned sampling window moved).

Neither can see letterform deformation at constant colour and constant area, which is one of the
classes the owner named first. **Pixel statistics are the wrong instrument for this question.**

**The one technique that IS solid, and worth reusing:** the **`yolo-crop` control group**. Those
references are Cloudinary `c_crop` transforms that record their own geometry in the URL
(`c_crop,w_1125,h_2000,x_442,y_0`), so the exactly-corresponding source pixels can be compared —
no bounding-box approximation. All 10 non-generative references came back at print-colour delta
**0** and mean absolute pixel difference **0.23/255** (JPEG quantisation noise). That is what
isolates the model as the cause and rules out re-encoding and colour-space conversion, since both
paths share that code. Rusted Icon's own reference stack contains the control and the treatment
side by side: its cropped reference is exact, its generated one is off by 240.
