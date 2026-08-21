# 2026-08-20 — Video vision-QC sampling was structurally blind to short-lived defects

## The problem

`services/adVisionQcService.js`'s `runVideoPostRenderQc` compares the seed product
photo against N frames sampled from the delivered video via
`services/videoFrameService.buildFrameUrls` — quartile sampling (25/50/75% of
duration). Three frames on a ~10s clip land at 2.5s/5.0s/7.5s. A defect that
appears and disappears inside one quartile window is invisible to that sampling
by construction, no matter how good the vision prompt is.

**Proven, same night:** a hallucinated fake storefront UI (nav bar, shopping-bag
icon, garbled header/footer text) was baked into a video plate. Visible at
t=0.1s AND t=0.5s. Completely gone by t=2.5s. Quartile sampling would have seen
nothing. Separately, the pre-existing 2026-08-19 note about the Vuori colourway
defect (visible at all three quartiles) is unaffected and still true — that was
a *persistent* hallucination, not a transient one; the two findings describe
different defect shapes and neither supersedes the other.

**Could not access the literal referenced known-bad asset.** The task specified
a verification asset at `scratchpad/ml2-check/` (`raw_t0.1.jpg`, `raw_t0.5.jpg`,
the mp4). An exhaustive search (this session's scratchpad root, every sibling
session scratchpad directory under `/private/tmp/claude-502/...`, broader
`/private/tmp`, `~/Downloads`, `~/Desktop`, and `mdfind`) did not locate it —
it was presumably already cleaned up or lived in a session whose temp storage
is no longer reachable. The fix below is instead verified against a
synthetically-generated but faithful reproduction of the *exact same defect
shape* (a distinct visual block present only at t=0.1s/0.5s on an otherwise
identical 10s clip, gone by t=2.5s) — real JPEGs, sharp-encoded in-memory, real
sharp-decode scoring, no mocked math. See `scripts/verifyVideoQcFrameSampling.js`
section F. This should be re-verified against the real asset if it resurfaces.

## The fix

New `services/videoQcFrameSelectionService.js` — a cheap, LOCAL, non-billable
pre-filter in front of the paid vision call:

1. `services/videoFrameService.js` gained `planDenseTimestamps` (dense,
   early-weighted timestamp plan — ~12 samples for a 10s clip, >=50% inside the
   first 2s, still spanning the whole clip) plus additive
   `buildFrameUrlsAtTimestamps` / `fetchFrameBuffersAtTimestamps` for an
   explicit timestamp list. `planTimestamps` / `buildFrameUrl` / `buildFrameUrls`
   / `fetchFrameBuffers` are **unchanged** (still pinned byte-for-byte by
   `scripts/verifyAdVisionQc.js` O13; `basePlateCropService.js` still calls the
   original `buildFrameUrls` for clip-box detection, untouched).
2. The dense set is probed at a TINY width (160px) via Cloudinary's `so_<sec>`
   edge transform — bandwidth only, no vision cost.
3. Each dense frame is downsampled to a 16x16 grayscale grid (`sharp`, already
   a dependency) and scored against the clip's OWN per-pixel median ("steady
   state") via a robust median + 3×MAD threshold — this catches a MINORITY-frame
   outlier wherever in the clip it lands, not just in the weighted-early window.
4. The vision call gets the existing 3-frame quartile baseline PLUS up to 2
   frames that actually scored as outliers (capped at 5 total).
5. `brandScriptExecutor.js`'s `runVideoVisionQcForAd` now calls
   `videoQcFrameSelectionService.selectQcFrameTimestamps` instead of the bare
   `videoFrameService.buildFrameUrls(deliveredUrl, durationSec)`, then builds
   the final vision-call frame URLs from whatever timestamps that returns.
6. Kill switch `VIDEO_QC_DENSE_SAMPLING` (default `true`, `config/defaults.env`)
   — `false` restores the byte-identical pre-existing quartile-only call with no
   deploy.
7. Fail-safe throughout: any failure in the pre-filter (network, decode, too few
   frames) degrades to the baseline quartile set — i.e. exactly today's
   behavior. A bug here can only ever leave QC as blind as it already was.

## Cost delta

Measured baseline: ~$0.02/check (one vision call, seed + 3 frames = 4 images).
The pre-filter's own probe is NOT billed to a vision model (Cloudinary edge
transform + bandwidth only).

- **Common case (no local outlier flagged) — the overwhelming majority of
  ads:** cost is UNCHANGED. Same 3 frames, same ~$0.02/check.
- **Flagged case (the pre-filter found something worth a second look):** up to
  2 extra frames go to the SAME vision call — 6 images vs. 4, roughly **1.5x**
  that check's cost (~$0.03), only on the minority of ads whose local probe
  already looked suspicious.
- No change to `MAX_QC_REGENERATIONS` (video never regenerates — unchanged),
  no change to how many vision calls run per ad (still exactly one), no change
  to the enablement gate or to whether a failed QC blocks delivery (untouched,
  per scope — that is the owner's call, tracked separately).

## Verification

- New `scripts/verifyVideoQcFrameSampling.js` — 29 checks: pure timestamp-plan
  shape/early-weighting (A), additive URL/fetch helpers not disturbing the
  existing contract (B), real-sharp-decode signature checks (C), pure
  outlier-scoring math incl. cap enforcement and redundancy suppression (D/E),
  **the real behavioral proof** — synthetic-but-faithful reproduction of the
  exact incident shape, real JPEGs, real sharp decode, catches t=0.1s/0.5s
  while the old baseline provably would not (F), and live wiring into
  `brandScriptExecutor.runVideoVisionQcForAd` with the old bare call proven
  gone (G).
- **Revert-proven by hand, this session:** (a) restoring the old bare
  `buildFrameUrls(deliveredUrl, durationSec)` call in `brandScriptExecutor.js`
  fails G1/G2 (confirmed — ran the harness against the reverted file, 2
  failures, restored). (b) Deleting `videoQcFrameSelectionService.js` entirely
  fails the whole file with `MODULE_NOT_FOUND` (confirmed, restored). (c) F5
  flips `VIDEO_QC_DENSE_SAMPLING=false` on the exact same real-incident frames
  and reasserts the old blindness reappears.
- `npm test` — **182/182** (was 181 + this file). `npm run lint` clean.
- `node --check` clean on every touched file.

## Explicitly not touched (per scope)

- Whether a failed video QC blocks delivery — still never fails the ad, still
  flags `Ad.visionQc` and ships as a draft (owner's product decision, tracked
  separately).
- The `isEnabled()` cache-race gate — owned by a separate in-flight fix.

## PR

`fix/video-qc-dense-frame-sampling` — opened, not self-merged. See PR number in
the branch's own PR description / GitHub.
