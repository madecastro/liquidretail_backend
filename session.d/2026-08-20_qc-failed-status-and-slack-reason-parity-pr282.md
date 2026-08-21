# QC-failed ads now deliver as `failed` with the exact Slack reason — PR #282

Owner decision, stated verbatim: *"It should be delivered as failed with a description in
the detail screen of what was wrong with it. that should be the same that gets echoed to
slack in the vision QC feedback."* Three parts: (1) a QC-failed ad reads Failed, not "Ready
for Review"; (2) the detail screen shows what was wrong; (3) that description is the same
text Slack gets — one formatter, two surfaces, provably.

Branch `feat/qc-failed-status-and-reason`, backend PR
[#282](https://github.com/Emami-RS-Project/liquidretail_backend/pull/282), open, **not
self-merged** (owner holds merges while a generation run may be in flight). Paired frontend
PR [liquidretail#68](https://github.com/Emami-RS-Project/liquidretail/pull/68).

## Coordination

Two peer sessions were named as active in this same file (`isEnabled()` cache race;
video QC frame-sampling density) when this session started. Neither is touched here — this
PR is scoped to the verdict's *consequence* (status + surfacing), not whether QC runs or
what it samples. No file-level collision found; `adVisionQcService.js` is shared but the
edits are additive (new return value, new passthrough field) and were checked against the
file as it stood at `9534502a` (this branch's base).

## What changed, and why each piece is where it is

**1. `alertQcFailure` now returns the exact Slack `detail` text.** It already built
`buildQcSlackDetail(visionQc, {appUrl})` to send to Slack; it now also returns that string.
Every call site that persists a QC-failed `visionQc` onto an `Ad` captures the return value
and stamps it onto `visionQc.failureDetail` **before** the doc is written:

- `directImageRenderService.js` — the static live-render QC-fail-after-retry throw.
- `imageRecoveryService.js` — the static recovery path's QC-fail branch
  (`maybeQcRecoveredPlate`).
- `brandScriptExecutor.js` — the video live-render path (`runVideoVisionQcForAd`).

Because it's the **same function call, same inputs**, the persisted text is byte-identical
to whatever Slack received — there is no independent formatter to drift. Verified this
mechanically, not just by inspection: `scripts/verifyAdVisionQcSurfacing.js` E1 asserts the
returned string literally equals the `detail` field captured off a stubbed `alertService`.

**2. `summarizeVisionQc` passes `failureDetail` through, gated behind `{categories:true}`.**
Same gate the per-category breakdown already uses — list-weight callers (gallery, run
rollup) don't pay for a string that can run up to 2500 chars; only the detail view does.
Absent whenever the verdict wasn't a real failure (skipped/disabled/passed never write this
field).

**3. Video vision QC failures now flip `status:'failed'`.** This is the actual behavior
reversal. `adVisionQcService.js`'s own file-header CONTRACT block, and
`runVideoVisionQcForAd`'s old comment, both said video QC "ships as a normal draft anyway"
on a real failure — a deliberate money call (never regenerate a ~$0.90 master, never discard
an already-paid asset) that the owner has now decided should ALSO mean "don't lie about it
either." `buildVideoQcFailureFields` (`brandScriptExecutor.js`, pure, exported) is the one
function that decides "does this verdict mean `status:'failed'`" — `passed:false && !skipped
&& !disabled`, same tri-state check `imageRecoveryService.js`'s `qcFailed` already used for
the static recovery path. It's called from BOTH places a video ad's terminal write happens:
`uploadRenderAndStamp` (the titled path) and `renderBrandScriptAndSave`'s no-chrome branch
(ships the raw Grok master with no titling step — previously bypassed
`uploadRenderAndStamp` entirely and so would have missed this fix if it weren't factored
out). Sets `status:'failed'` + a short `renderError` (`stage:'vision-qc'`, `charged:true` —
the master render succeeded and was billed; this is a post-hoc rejection, not an infra
failure). Does **not** touch `isEnabled()`, frame sampling, or the regeneration/discard
policy — those are the two peer sessions' lanes.

**4. `routes/catalog.js`'s `GET /:id/ads-detail` allowlist trap.** This is the endpoint
Product Ads' `AdDetailModal` actually calls (NOT `routes/ads.js`) — and its aggregation
`$project` never listed `visionQc` or `renderError` at all, so both arrived `undefined`
regardless of what was on the Ad document. The PR description flagged this exact trap ("a
field missing from that allowlist arrives undefined... that exact trap has bitten three
separate features tonight") — confirmed true a fourth time. Fixed: added both fields to the
`$project`, and the shaped `adRows` now carry `visionQc: summarizeVisionQc(a.visionQc,
{categories:true})` and a conditional `renderErrorMessage` — same convention
`routes/ads.js`'s `projectAd` already uses, reused via `require`, not re-derived.

## Harness

Extended `scripts/verifyAdVisionQcSurfacing.js` (sections E/F/G, +20 checks, 48 total in the
file) — **did not create a new file**, per this repo's stated convention. No DB, no network;
section F's `runVideoVisionQcForAd` behavioral check stubs `adStage` too (a real, unawaited
`Ad.updateOne` this file's own header promises never to trigger).

Hand revert-proven, each independently, then restored:
- `git stash` on `services/adVisionQcService.js` alone → **E1-E4 failed** (4/48), nothing
  else moved.
- `git stash` on `services/brandScriptExecutor.js` alone → **F1-F7 failed** (7/48) —
  confirmed the OLD console log line ("shipping as draft anyway") printed again during the
  run, i.e. the stash genuinely restored the old behavior, not just broke a reference.
- `git stash` on `routes/catalog.js` alone → **G1-G3 failed** (3/48), nothing else moved.

Full suite: `npm test` → **181/181** passed. `npm run lint` → clean on all 6 touched files
(`routes/catalog.js`, `services/adVisionQcService.js`, `services/brandScriptExecutor.js`,
`services/directImageRenderService.js`, `services/imageRecoveryService.js`,
`scripts/verifyAdVisionQcSurfacing.js`).

## Browser verification (real data, no billable generation)

Used the owner-named example: run `run_1787266578461_70865bdd` (Pelagic Gear, product
"Marco Polo Lured"). Fetched read-only via `render jobs create srv-d1vuktqli9vc73ft07ng
--start-command "node -e ..."` (the established "query prod via Render jobs" pattern) —
**39 total ads, 3 real `status:'failed'` statics**, all three legitimate: two logo-outside-
safe-box (`ai_editorial` 4:5, `ai_brand_led` 1.91:1 PMax landscape) and one headline-outside-
safe-box (`ai_brand_led` 9:16 Stories) — genuine `layout_safe_box` category failures, scores
0-2/10, everything else 10/10. (The PR description recalled the split the other way around —
doesn't matter; the real data is what was used.)

These 3 ads predate this fix (rendered via the OLD recovery path, `renderError.stage:
'vision-qc-recovery'`), so their real, persisted `Ad.visionQc` never had `failureDetail`
computed — same "cannot backfill history" situation this repo already documents elsewhere
(gate-off verdicts, etc.). To show what happens to a QC failure **going forward** without
fabricating anything: a small local mock backend (not deployed, not committed) required the
REAL, modified `adVisionQcService.js` and called its real `buildQcSlackDetail` on these 3
ads' real, persisted verdicts — i.e. "what today's code produces for this exact real
failure." Every word in the resulting text is real (the model's actual findings from
whenever QC first ran); only the *timing* of computing `failureDetail` is simulated to stand
in for a fresh failure.

Frontend dev server (`VITE_BACKEND_URL` proxy) pointed at that mock; auth bypassed
legitimately, not by faking a valid signature — `AuthContext`/`jwt.ts` only ever
base64-decodes the JWT client-side (never verifies it; the real backend does that), so a
well-formed unsigned token with a future `exp` is sufficient and the mock never checks it
either. Confirmed in-browser (screenshots in the frontend PR): gallery pill reads **Failed**
for all 3, `AdDetailModal` header pill reads **Failed**, the "Failed vision QC" box shows the
full verdict text matching what `buildQcSlackDetail` produces, and an unrelated real
**passing** ad (`ai_social_proof_led`, genuine QC pass) still reads **Ready for Review** with
no failure banner — confirms no regression on the non-failure path.

## Not done / left for the owner or a follow-up

- Did not backfill `failureDetail` onto any historical `Ad.visionQc` document — those 3 real
  ads (and any other pre-existing QC failure) will show the generic `renderErrorMessage` on
  the detail screen until they're naturally re-rendered, not the rich per-category block.
  Backfilling would need a migration script; not requested and not attempted.
- Did not add a visually distinct pill for "failed vision QC" vs "failed for any other
  reason" (moderation block, crash, etc.) — judged the plain "Failed" badge sufficient since
  the description box beneath it already differentiates via its heading ("Failed vision QC"
  vs "Render failed") and content. Revisit if the owner wants a different visual treatment.
- PR #274 (`fix/concurrency-and-derive-wait-backup`, another session, open at the time this
  branch was cut from `9534502a`) is unrelated and not rebased onto here or vice versa —
  no file overlap found (`routes/ads.js` derive-wait logic vs. this PR's `routes/catalog.js`/
  `adVisionQcService.js`/`brandScriptExecutor.js`).
