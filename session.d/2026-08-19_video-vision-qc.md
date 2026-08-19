## 2026-08-19 — Video ads get post-render vision QC (statics-only gap closed)

Branch `fix/video-vision-qc`, worktree
`/private/tmp/.../scratchpad/worktrees/wt-video-qc`, rebased onto
`origin/main` (`dcca06cb`, the session.md → session.d/ restructure).

**The gap, as measured before this change:** `adVisionQcService.runPostRenderQc`
had exactly one call site (`directImageRenderService.js:1853`, the STATIC
image path). Zero references in `routes/ads.js`,
`services/brandScriptExecutor.js`, `services/atlasVideoService.js`,
`services/videoRouter.js` — every video ad shipped with `Ad.visionQc: null`,
read as "clean" by every downstream surface. Owner quote that started this:
*"we need to focus on video quality... I am still seeing mixed colored type,
truncations, etc. Everything needs to be perfect."*

### What shipped

- `services/adVisionQcService.js` — three new exports:
  `buildVideoVisionUserContent`, `judgeVideoRender`, `runVideoPostRenderQc`.
  Same 4 category keys (`competitor_marks`, `product_fidelity`,
  `text_defects`, `layout_safe_box`), same model role (`ad-vision-qc` →
  `google/gemini-2.5-pro`), same `PASS_FLOOR` as the static path — one
  vision call over `[seed image, frame1..frameN]` instead of `[seed,
  render]`. `text_defects` is narrowed to product-intrinsic text (woven
  labels, hang tags) — the ad's own caption/CTA/rating overlay is explicitly
  out of scope (owned by the Remotion titling QA track, a different
  in-flight fix). `layout_safe_box` is repurposed as framing/visibility
  (crop-clipping, caption fully covering the product) since no static
  safe-box geometry is available at the video call site.
- **No regeneration, ever, and `ok` is always `true`.** A video master is
  ~$0.90 (12x a static's ~$0.07) and the defect classes this exists to
  catch (hallucinated colourway, garbled on-product branding) are generated
  INTO the clip by the video model — there's no cheap corrective-prompt
  retry, and a second $0.90 submit on the same seed is not a reliable fix.
  Chosen policy: **flag, don't discard.** The ad ships as a normal `draft`
  (status untouched) with a failed `Ad.visionQc` an operator sees before
  sending it to a platform, instead of the paid master vanishing. Full
  reasoning is in `runVideoPostRenderQc`'s docstring — read that before
  changing this, not just this file.
- `services/brandScriptExecutor.js` — new `runVideoVisionQcForAd`, called
  from `uploadRenderAndStamp` (the ONE tail both titling engines — remotion
  and canvas — funnel through) plus the "no chrome configured" skip branch
  in `renderBrandScriptAndSave`. Deliberately NOT wired into `routes/ads.js`
  (heavily contended right now — #227 rebasing, the undispatched-tail fix
  in progress, explicitly told not to block that). Wrapped in try/catch
  with NOTHING allowed to escape: this function is called from the single
  place every video ad's `renderUrl` gets written, so a bug here must never
  break rendering repo-wide — worst case it returns `null` and `Ad.visionQc`
  stays unstamped, same as "QC disabled."
- Frame sampling: **reused, not reinvented** — `videoFrameService.js`
  already existed with `buildFrameUrls` (quartile sampling for short clips,
  Cloudinary `so_<sec>` edge transform, zero ffmpeg/local decode) and was
  simply unused ("callers wire it in where multi-frame is wanted" — its own
  header comment). `basePlateCropService.js` already calls it the same way
  for face detection, and `Ad.videoDurationSec` already exists on the model
  — no ffprobe, no new dependency. For our 8-10s ads this is exactly 3
  frames at 25/50/75% of duration.
- Seed image: `ad.veoReferenceImages[0]` when present (the EXACT reference
  actually sent to the video model — same "first reference we actually
  sent" philosophy the static path uses), falling back to
  `CatalogProduct.imageUrl` for derive-only ads (cropped from a sibling
  master, never populate their own `veoReferenceImages`).
- `alertQcFailure`/`alertQcAccepted`/`alertQcSkipped`/`qcFailureTitle` all
  gained an optional `mediaLabel` param (`'Static ad'` default, exact
  back-compat) so video alerts read "Video ad ..." instead of silently
  reusing static's copy.
- **Owner add-on mid-session**: *"I want to see the [vision QC] output even
  if it is approved so I can see what it is looking for and what it
  observes."* `noteQcPassToRunFeed`/`noteQcFailToRunFeed` now attach the
  full `buildQcSlackDetail` block (verdict, every category's score +
  findings, a clean one-line preview for a single-attempt verdict — no
  attempt-trail spam) to the run-feed Slack THREAD on both outcomes, not a
  200-char summary on pass. Did NOT re-enable `alertQcAccepted` (dead in
  prod on purpose — would exhaust `ALERT_RATE_LIMIT_MAX` at real ad volume
  and start silently dropping genuine failures). Verified structurally that
  `runFeedService.js` has no `alertService` dependency at all — its own
  bounded ring buffer + batched Slack posts are a genuinely separate,
  unmetered transport, not an assumption.
- `formatThreadLine` (`runFeedService.js`) appends `meta.qcDetail` as a
  block after the existing one-line summary, only when present — every
  other existing `noteEvent`/`onStage` caller renders byte-identical to
  before.
- Docs: `CLAUDE.md`'s "~1-in-3 static ads" note updated in place (video was
  explicitly called out there as not-QC'd); `docs/ALERTING.md` gained a
  "Video vision QC (2026-08-19, second follow-up)" subsection under the
  existing gap-table writeup, since that row was written for statics only.

### Verification

**Live-verified against the REAL delivered defect**, not a synthetic one
(no new Omni generation submitted — both test videos were already paid
for). Run `run_1787136860887_654ed621`, brand Vuori 2, product *Women's
Vuori Vintage Oversized Denim Jacket | Bone Denim* (productId
`6a8572e6b31cf7b22149ca01`; the sibling catalog row `6a857016b31cf7b22149c0c3`
from the original bug report is a duplicate ingest of the same product,
same image, not the one this ad actually used — confirmed both resolve to
the same cream jacket).

- **Positive (must fail):** ad `6a858be269d85d0c4123f4e4` (`meta_stories_9_16`),
  delivered `renderUrl`
  `.../brand_script/product-1787138609568-1-kes61zfm.mp4`. Visually
  confirmed myself (frame extraction) before writing any code: the video
  renders a light-blue washed denim jacket where the product is Bone Denim
  (cream), plus a back-neck woven label that doesn't read "vuori." Live
  `runVideoPostRenderQc` call: **FAILED**, `product_fidelity=0`
  ("colourway is incorrect in all sampled video frames... light-wash blue
  denim" vs the cream original), `competitor_marks=2` (a woven label
  "absent from the original product... in IMAGE 1"). `text_defects=10`,
  `layout_safe_box=10` — the check correctly localizes the defect to the
  two categories it's actually about, not a blanket fail.
- **Negative control (must pass):** ad `6a8511c23773f42f505660ab`
  (`pmax_video_1_1`), Allbirds Men's Runner NZ Remix (Natural White),
  delivered `renderUrl` `.../brand_script/product-1787108013529-5-fpmopw44.mp4`.
  Visually confirmed correct (white shoe, legible "allbirds" wordmark) before
  the live call. Live result: **PASSED**
  (`competitor_marks=10, product_fidelity=10, text_defects=7,
  layout_safe_box=10`) — the `7` is a real, specific finding (the debossed
  heel wordmark is slightly distorted at one sampled frame), still above
  `PASS_FLOOR`. Proves the gate isn't a rubber stamp (it found something
  real and minor) while correctly not rejecting a good ad.
- **Measured spend for both live calls: $0.0475** (`CostLog`,
  `stage:'ad_video_vision_qc'`, `model:'google/gemini-2.5-pro'`,
  `costSource:'estimated'` — same convention the static path already uses;
  Atlas doesn't return authoritative settled billing at call time). Against
  the up-to-$5 budget for this validation, and against the ~$0.90 cost of
  the video master itself (~5% — right in the "cheap insurance" range the
  brief's cost note argued for).
- **Full offline suite: 160/160** `scripts/verify*.js` green (this
  worktree's `node_modules` was initially missing `sharp`'s native deps —
  `https-proxy-agent` and `ffmpeg-static` too — a fresh `git worktree add`
  artifact, not a code issue; `npm install sharp --no-save --ignore-scripts`
  repaired it cleanly, all three previously-environmental scripts
  (`verifyLogoSilhouette.js`, `verifyLogoColorPreservation.js`,
  `verifyStaticTextInk.js`) now genuinely pass, confirming the coordinator's
  note that this class of failure is no longer expected). `npm run lint`
  clean. `scripts/verifyAdVisionQc.js` extended (not duplicated) with 20 new
  checks — sections O (video QC contracts) and P (verbose-pass run-feed
  wiring) — total 70/70 in that file alone.

### What was NOT verified / deliberately out of scope

- No new Omni/video generation was submitted (explicit instruction) — both
  live QC calls ran against already-delivered, already-paid assets.
- Did not touch `routes/ads.js` (contended) — QC is invoked entirely from
  `services/brandScriptExecutor.js`, one layer below the route.
- Did not build a frontend affordance beyond what's already there:
  `Ad.visionQc` on a video ad reads through the EXACT same
  `summarizeVisionQc`/`projectAd()`/gallery-pill/detail-modal/run-rollup
  code PR #236 already shipped for statics — no video-specific frontend
  change was needed or made.
- Did not add a separate feature flag for video — it shares
  `AD_VISION_QC_ENABLED`/`SystemConfig.adVisionQcEnabled` with the static
  path (one gate, not two; flipping it protects both pipelines at once).
  This is a real judgment call, not an oversight: the tradeoff is one
  fewer operational toggle to remember vs. no independent kill switch if
  the video path specifically misbehaves in production. Mitigated by the
  try/catch backstop in `runVideoVisionQcForAd` — an infra failure there
  degrades to "unstamped," never to a broken render.
- Did not investigate whether the SAME base master (`veoVideoUrl`) shared
  across multiple derived Ad rows (crops/retitles of one billable Omni
  generation) should share ONE QC verdict instead of paying for the vision
  call once per Ad row. Chose per-Ad QC (mirrors the static path's
  granularity, and correctly catches a crop/caption defect specific to one
  surface) over de-duplication by master URL — flagged as a possible future
  cost optimization, not implemented.
