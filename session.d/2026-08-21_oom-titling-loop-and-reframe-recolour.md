# 2026-08-21 — REMOTION_QUEUE_CONCURRENCY=8 OOM-killed the web process; recovery
# was flawless; and the 9:16 generative reframe is recolouring brand logos before
# Omni ever runs.

Written from an unattended E2E loop (owner: *"choose products and generate ads to test
the system and then qc the entire process from end to end"*, $50 budget). One billable
12-ad Pelagic Gear video run: **$1.3761 total** — one Omni master $0.90 settled, 12 video
QC verdicts $0.3053, 36 `base_plate_crop` vision calls $0.1708 (still `estimated`).

Read `2026-08-21_HANDOFF-account-switch.md` §10 first if you have not — its premise
(vision QC might be off in prod) was already false when written; QC has been ON since
`2026-08-20T22:33:11Z`.

---

## 1. THE BUG — `REMOTION_QUEUE_CONCURRENCY=8` does not fit an 8Gi box. FIXED (#303, `8fc602d6`).

The 4→8 raise (#274, 2026-08-20, owner-approved) was made **contingent** on one thing,
in its own config note: *"Doubling to 8 is one step, not a leap; it must be validated
against the web-service memory graph on a full run before going further."*

That validation ran. 8 failed it, in exactly the predicted manner. Render metrics API,
web `srv-d1vuktqli9vc73ft07ng`:

    10:33:00   0.33 GiB   idle, titling not started
    10:33:30   3.88 GiB   titling begins
    10:34:00   6.33 GiB
    10:34:30   5.46 GiB
    10:35:00   7.57 GiB
    10:35:30   7.49 GiB
    10:35:54   OOM KILL — server_failed, oomKilled, memoryLimit 8Gi
    10:36:30   0.72 GiB   replacement instance

**~0.9 GiB per concurrent Remotion slot** ((7.57−0.33)/8). 8 slots want ~7.2 GiB of an
8 GiB box — zero headroom. 4 slots want ~4 GiB, which is why the note called 4 *"the only
concurrency this process has actually survived."*

Reverted 8→4 with the measured graph written into the config note (it asked for exactly
that number). **Four sites pin this value and must always move together** or
`verifyConcurrencyConfig` / `verifyTitlingPermit` fail: `config/defaults.env`, the
`services/concurrency.js` SPEC `default`, `verifyConcurrencyConfig` check A,
`verifyTitlingPermit` B2. 174/174 verify scripts pass. Deployed and confirmed live in
production (`EFFECTIVE_remotion_queue=4`); same titling workload now peaks at
**3.38 GiB** vs 7.57.

`VEO_CONCURRENCY` deliberately LEFT at 24. That re-creates the titling bottleneck the
coupled raise was avoiding — wall-clock only, and slow strictly beats an OOM that strands
paid masters. **Do not re-raise the queue without a memory graph showing real headroom at
the new value. Raising instance RAM is the prerequisite, not an alternative.**

## 2. RECOVERY WORKED PERFECTLY, AND THAT IS THE MORE IMPORTANT FINDING.

Do not read §1 as "the pipeline lost a run". It lost nothing. From the OOM, with no human
action and **no re-spend** (Remotion is local):

- `titlingResumeService` reclaimed the `titlingResumeState:'claimed'` titling debt at
  `TITLING_RESUME_STALE_MIN=15` and re-titled all 12, draining ~5 per 5-minute pass
  (interrupted twice more by my own deploys, and it simply resumed).
- The worker's reaper evaluated the stuck run **and deliberately spared it**, five times,
  logging: `⏳ left 1 stale-looking CampaignRun(running) alone — receipt-holding ad(s)
  still genuinely rendering or untitled-master recovery in flight, not abandoned`.
- Then, once every claimed ad had settled, it reconciled the counters from Ad truth:
  `✅ reconciled 1 CampaignRun(running) → done from real Ad truth (every claimed ad had
  already settled; the process that owned the render loop never got to write its own done
  stamp)`.

Final: **12/12 titled, 0 raw masters shipped, 12 QC verdicts, run `done · succeeded 12 ·
failed 0`.** Elapsed ~55 min. If you are ever tempted to "fix" the reaper for leaving a
stale-looking run alone, or to widen the resume window — read this section first. Both
behaviours are load-bearing and both were measured working here.

## 3. VIDEO VISION QC IS VALIDATED END-TO-END IN PRODUCTION. First time.

The split gate from #301 (`videoVisionQcEnabled`) is confirmed live: `SystemConfig` reads
`staticVisionQcEnabled: true, videoVisionQcEnabled: true`, and 12 real verdicts landed at
**~$0.025 each** — not one `{disabled:true}` or `{skipped:true}` stub.

**3 pass / 9 fail.** Failing categories across the 9:

| category | n | scores |
|---|---|---|
| `product_fidelity` | 5 | 3, 1, 4, 2, 4 |
| `text_defects` | 3 | 4, 3, 2 |
| `layout_safe_box` | 3 | 2, 2, 3 |
| `competitor_marks` | 2 | 3, 2 |

Every failure correctly stamps `approved:false` +
`renderError: "video ad failed vision QC (no regeneration)"`. **The money rule held: no
re-spend on a failed video.** QC is earning its keep — it is catching real defects with
frame-level specificity, e.g. *"A black woven label tag appears on the lower-left side
seam at t=5.0s, which is absent from the original product photo"* then *"a different,
white woven label tag appears in the same position at t=7.5s."*

⚠️ **Statistical caveat:** all 12 assets derive from ONE master. This is one defective
master judged 12 times, not 9 independent failures. **Do not quote a per-master defect
rate from n=1.**

## 4. THE NEW DEFECT — the 9:16 generative reframe recolours the product before Omni runs. NOT FIXED.

`reframeReferenceForAspect` fits catalog stills to 9:16 via
`google/nano-banana-2/edit-developer`. **That model has no mask** — the file says so three
times, e.g. *"THE MODEL HAS NO MASK. submitImageGeneration posts { model, images, prompt,
aspect_ratio, resolution } — there is no region or mask parameter anywhere in the Atlas
image API"* — so it re-synthesises the **entire canvas**, including the ~56% we already had
ground truth for. There is **no pixel paste-back anywhere**; the generated bytes are
uploaded as-is to `liquidretail/reframes` and handed to Omni as
*"the ABSOLUTE source of truth for shape, color, label text."*

Measured with PIL on the actual reference of this run's master (Pelagic "Rusted Icon",
2000×2000 source → 3072×5504 outpaint):

| region | original catalog still | outpaint sent to Omni | L1 |
|---|---|---|---|
| **brand logo ink** | `(96,156,168)` teal | `(12,60,96)` navy | **252** |
| shirt body | `(252,240,192)` | `(240,216,156)` | 72 |
| background | `(252,252,252)` white | `(240,240,240)` grey | 36 |

**Vision QC independently named the same thing** without seeing my measurement: *"The
original product (IMAGE 1) has a teal/blue logo, but in the video frames the logo is dark
navy blue."* That accounts for the 5 `product_fidelity` failures. Not ICC/gamma — a
profile shift moves all channels together, and 252 on saturated logo ink against 36 on the
background is not that shape.

**Why nothing cheaper caught it — this is a real architectural corner, not a missing flag.**
I went looking for a stale flag or absent classification and there isn't one:

- The hero **was** correctly classified `classification.shotType === 'product_only'` at 0.99
  (*"a single T-shirt centered against a plain white seamless background"*).
  ⚠️ That field is at the Media doc's **TOP LEVEL**, not `metadata.classification` — I
  wasted a probe on the wrong path, and so will you.
- `REFRAME_STRATEGY=crop-first` is already on. A 2000×2000 square → 9:16 leaves a crop
  window of **1125 of 2000 px (56%)**; a centred garment does not fit, so crop-first
  `defer`s and `reframeReferenceForAspect` goes **straight to generation — there is no pad
  branch in that function at all** (`verifyNoVisibleSeedPad.js` enforces its absence).
- The solid pad + `isProductOnlyShot` govern **seed** plates, not references. Visible
  letterbox bands were banned by PR #155.

So a square packshot → 9:16 has exactly three options: clip the garment, band it, or
re-render it. It re-renders it.

**Also compounding:** the 3-ref stack is pure merchant feed order with **no consistency
check** — here a flat-lay BACK view with a large centred logo plus two on-model FRONT views
with a small chest logo, all declared absolute truth, while Scene 2 of the frozen prompt
says *"slow zoom toward the logo"*. QC's *"an un-sourced logo is added to the front"* is
that. And two **independently** outpainted refs invent different details — the black tag at
t=5.0s / white tag at t=7.5s.

### Fix options, ranked (a guarded draft of A exists but is NOT landed)

- **A. Paste the original pixels back** over the outpaint interior, keeping only the
  invented margin — the mask Atlas won't give us, done client-side. Insertion point is
  after `outputRatioOk` succeeds and before `fitBufferForCloudinary`
  (`atlasVideoService.js` ~`:2068-2086`); `srcNorm.buffer` is already in scope ~`:2034`.
  **Must be guard-first**: verify the generated interior still aligns with the original
  (the edit model may have scaled/shifted the subject) and on any doubt upload the plain
  outpaint, i.e. today's behaviour — so the change is a strict improvement or a no-op.
  ⚠️ **Cached reframes carry the navy logo** (`metadata.reframes.<aspectKey>`, reused until
  `REFRAME_LADDER_VERSION` changes), so landing this without a version bump does nothing
  for existing media — and bumping it re-generates at **$0.08 per image**. Cost that
  explicitly before doing it.
- **B. `VIDEO_DEFAULT_REFERENCE_COUNT` 3→1.** Pure config, $0, removes the front/back
  disagreement. The code already measured that *repeating* the primary ref increased
  hallucination (`REPEAT_PRIMARY_REFERENCE=false`), so fewer refs is the direction it
  already points.
- **C. Titling logo keep-out.** 3 of the 9 failures are OURS, not the model's — *"the
  caption overlay is placed directly on top of the primary back logo, obscuring the brand
  name."* Titling already has a **face** keep-out (`ensureFaceDetectionForKeepOut`) and we
  already pay for 3-frame vision per ad in `base_plate_crop`, so the boxes are nearly free.
- **NOT prompt hardening.** PR #61 hardened this exact prompt and was rolled back in full
  for increasing hallucination. The reframe prompt *already* says *"Preserve its shape,
  colors, materials, stitching, label text, and every logo or badge exactly"* and the model
  recoloured anyway. This is architecture, not adjectives.

⚠️ **`REFRAME_RESOLUTION=4k` is NOT a bug — I nearly filed it as one.** The comment above
it opens *"Deliberately NOT 4k… at 4k the decoder must commit to letterforms and logo
strokes it can only guess"*, but that paragraph is **superseded history**; the next lines
record *"4k per operator decision (2026-07-24) after reviewing 20 live generations side by
side: at 4k the conservative 'reframe' prompt held product geometry better than 1k did."*
Owner-measured, and 1k was the worse arm. Same trap as CLAUDE.md §0 — retired reasoning
left in place beside the live decision.

## 5. Pelagic Gear is well set up. Two of my own audit "gaps" were schema artifacts.

Recorded because the next session will otherwise re-derive them wrongly:

- **`CatalogProduct.reviewCount` DOES NOT EXIST.** Counts live at
  `productReviews.reviewCount`. Real numbers: **766 of 837** products populated, 396 at
  ≥50, 292 at ≥100, max 2156, source `api:yotpo`, plus 770 with quotes. Only **1** product
  brand-wide would print a bare star with no volume.
- **`Brand.fonts` DOES NOT EXIST.** It is `Brand.customFonts`, and Pelagic's real brand
  face (`ArchivoV`) was already ingested and mirrored to Cloudinary.
- Genuine remaining gap: `brandReviews.reviewCount` is null beside `rating: 5` sourced from
  `Pelagicgear.com` itself. Low risk — brand stars only print when the product pair fails,
  and 394 products clear the floor with substantiated volume.
- **A duplicate empty "Pelagic Gear" exists** (`6a87714fe8dc2e8ef6c28cfc`, advertiser Reach
  Social Admin, 0 products) alongside the real one (`6a875170b31cf7b2214a46e3`, Sales
  Demos, 837 products). Uniqueness is `(advertiserId, nameNormalized)` so both are legal.
  Do not generate against the empty one; do not "fix" it by ingesting into it.
- **There is no Marine Layer brand at all.** If you ingest it: `SHOPIFY_DIRECT_LIMIT`
  defaults to **200**, so raise it first or the catalog truncates; and
  `createDemoBrand` does not write `websiteUrl` (only `apifyDemo.shopifyUrl`), which starves
  enrichment and font ingest — patch `websiteUrl` immediately after creating.

## 6. Probe hygiene — two traps that cost me real time

- **A Render one-off job running `node -e` never loads dotenv**, so
  `config/defaults.env` is absent and you are testing a different program than production.
  I "found" a broken font ingest this way (`Must supply cloud_name` — `CLOUDINARY_CLOUD_NAME`
  is in `defaults.env`, not the dashboard). Prefix every probe with
  `require('dotenv').config(); require('dotenv').config({path:'config/defaults.env'})`.
  Note the env GROUP ("Liquid Retail") also carries `CLOUDINARY_CLOUD_NAME=dxxilvr1f`,
  which **wins** over the committed default since dotenv never overrides.
- **Never pipe a command whose exit code is the evidence.** I reported the ui-smoke harness
  as "green on a broken run, exit 0". It returned **exit 3** and printed `⚠`; my
  `| tail -45` replaced its status with `tail`'s. `exitCode()` is
  `failed>0 → 1; env>0 → 3; else 0`. The harness is well-calibrated — its post-spend
  `markEnv` (`suites/generation.js:539`) is a deliberate documented choice so a red test
  does not invite a blind $0.90 re-run.
