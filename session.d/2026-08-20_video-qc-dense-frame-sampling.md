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
3. Each dense frame is downsampled to a 32x32 grayscale grid (`sharp`, already
   a dependency; bumped from an initial 16x16 after adversarial review) and
   scored against a "steady state" reference via a robust median + 3×MAD
   threshold — see "Adversarial review" below for why the reference is the
   LATE cluster only, not the whole dense set.
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

## Adversarial review (Grok, two rounds) — real bugs found and fixed

Per the Grok-first standing rule, both rounds were run via the local Grok CLI
(`grok-4.6`, `--effort high`, read-only sandbox) against the diff. The FIRST
run took ~20 minutes wall-clock (mostly network-bound waiting on its own
fanned-out subagent reviews and self-written verification scripts, confirmed
alive throughout via its terminal call logs, live TCP connections, and
growing output — not a hang, just slow for this effort level) and did not
hang or error; no Grok outage to report.

**Round 1 findings (all fixed, all revert-proven by hand):**
- **Real bug:** `baselineTimestamps()` used a literal `[0.25,0.5,0.75]`
  fractions formula. That matches `videoFrameService.planTimestamps()` only
  inside its 4-20s bucket — diverges for <=4s (a real value: Omni's duration
  enum is `[4,6,8,10]`) and >20s. Fixed by delegating to the real
  `planTimestamps()` directly. Reverting the fix (reinstating the formula)
  fails the new A7/A8 checks.
- **Harness gap:** every E/F-section mock ignored the `stamps` argument
  `selectQcFrameTimestamps` actually passes to `fetchDenseFrames`, so
  swapping the dense planner back to the old quartile-only plan — the exact
  blindness this PR fixes — would still have passed every "catches the
  incident" check. Fixed by asserting the real planner output is what gets
  requested, plus a static source-level pin (F0). Confirmed: making that
  exact swap now fails 6 checks (was 0).
- Also fixed: a header comment overclaiming that one check (F5) alone proved
  every revert mechanism (it only proves the flag-off branch), and a
  redundancy-filter test (old E7) that could pass without the filter it
  claimed to test ever running.

**Round 2 findings, on the round-1 fix itself (both CONFIRMED, both fixed):**
- **Real bug — the more serious one:** the median+MAD outlier detector
  scored every dense frame against the median of ALL dense frames.
  `planDenseTimestamps` splits its ~12 samples roughly 50/50 between an
  early cluster (<=2s) and the rest. Median/MAD have a ~50% breakdown point,
  so a defect persisting across the ENTIRE early cluster (plausible — not a
  1-2 frame flash, ~2 continuous seconds of it) is an even split: the median
  blends into "half defect, half clean," every frame sits about the same
  distance from that blend, and NOTHING gets flagged. That is exactly the
  defect shape early-weighting exists to catch, mathematically invisible to
  the naive scorer. Fixed by scoring against a reference built from the LATE
  cluster only (new shared constant `videoFrameService.DEFAULT_EARLY_WINDOW_SEC`
  so the planner and scorer can't silently disagree on the boundary); falls
  back to whole-set scoring on clips too short for a robust late cluster.
  Reverting to whole-set scoring fails the new D5/D6/D7 (pure) and E8
  (behavioral) checks.
- **Real bug:** a flagged outlier within 0.4s of a baseline quartile was
  dropped as "redundant" — backwards, since an outlier is by definition
  different from its neighbors, including a nearby baseline frame. A defect
  visible only at 7.2s and gone by the 7.5s baseline (0.3s later) would have
  been silently dropped, handing vision the clean frame and calling it
  covered. Removed the proximity filter (Set-based exact-duplicate dedup is
  untouched — that is genuine redundancy). Rewrote E7 to require the
  opposite: a real near-baseline outlier now survives. Reverting (reinstating
  the filter) fails E7 and E8 in the same pass.
- Bumped `SIGNATURE_SIZE` 16→32 after a concern that a thin real chrome bar
  (a few % of frame height) could average away under a coarser grid.
- **Documented, not fixed (labeled "suspected" by the review, not proven):**
  QC inspects the TITLED video (`uploaded.secure_url`), and title/caption
  entrance animates in during the same early window this pre-filter watches
  most closely (e.g. `enterAtSec: 0.15`, not fully composited until ~2s).
  That is a real, expected source of early-window visual change on every
  normally-titled ad, not a defect — so some clean ads may occasionally earn
  an extra flagged frame from title entrance alone. Bounded cost consequence
  only (same caps apply), and the vision prompt already treats a brand's own
  composited chrome as expected rather than a defect, so this should not
  produce a false FAIL — just possibly a higher "flagged" rate than the
  ideal-case cost framing assumes. Not engineered around without real pixel
  data from a titled, defect-free ad, which this offline harness cannot
  fabricate honestly and no billable generation was authorized to obtain.
  **Flag for live monitoring once this ships.**

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

- `scripts/verifyVideoQcFrameSampling.js` — **38 checks** (grew from an
  initial 29 across both adversarial-review rounds): pure timestamp-plan
  shape/early-weighting (A), additive URL/fetch helpers not disturbing the
  existing contract (B), real-sharp-decode signature checks (C), pure
  outlier-scoring math incl. the asymmetric-reference fix and its fallback
  (D), full orchestration incl. cap enforcement and the redundancy-filter
  removal (E), a static source-level pin plus **the real behavioral proof**
  — synthetic-but-faithful reproduction of the exact incident shape, real
  JPEGs, real sharp decode, catches t=0.1s/0.5s while the old baseline
  provably would not (F), a real config/defaults.env pin (H), and live wiring
  into `brandScriptExecutor.runVideoVisionQcForAd` with the old bare call
  proven gone (G).
- **Revert-proven by hand, this session** — every fix, both rounds: (a)
  restoring the old bare `buildFrameUrls(deliveredUrl, durationSec)` call in
  `brandScriptExecutor.js` fails G1/G2. (b) Deleting
  `videoQcFrameSelectionService.js` entirely fails the whole file with
  `MODULE_NOT_FOUND`. (c) Flipping `VIDEO_QC_DENSE_SAMPLING=false` (env, and
  separately the committed `config/defaults.env` line) reproduces the old
  blindness / fails H1 respectively. (d) Swapping the dense planner back to
  quartile-only inside `selectQcFrameTimestamps` fails 6 checks. (e)
  Reverting the asymmetric-reference fix (whole-set scoring again) AND
  reinstating the 0.4s redundancy filter together fail E7 and E8. Every one
  confirmed by actually making the change, watching the named checks fail,
  then restoring the fix.
- `npm test` — **182/182**. `npm run lint` clean.
- `node --check` clean on every touched file.

## Explicitly not touched (per scope)

- Whether a failed video QC blocks delivery — still never fails the ad, still
  flags `Ad.visionQc` and ships as a draft (owner's product decision, tracked
  separately).
- The `isEnabled()` cache-race gate — owned by a separate in-flight fix.

## PR

`fix/video-qc-dense-frame-sampling` — **PR #277**, open, not self-merged.
Three commits: initial implementation, round-1 adversarial fixes, round-2
adversarial fixes (all pushed).
