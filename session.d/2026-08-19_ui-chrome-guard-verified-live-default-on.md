# 2026-08-19 — UI-chrome hallucination guard verified live, default flipped ON (PR #262)

PR #262 (`fix/video-ui-chrome-hallucination`) shipped the guard OFF by default because
confirming it needed a live, non-refundable ~$0.90 Omni submit that the fix's author
deliberately did not spend. This session did that live A/B (owner-authorized, $2 budget for
the slice, production Atlas balance ~$22.14) and flipped the default.

## What was run

One real Omni submit, guard forced `true`, using the EXACT product/brand/seed stack as the
original incident: run `run_1787174963435_ff67021e`, brand Marine Layer 2, product "Custom
Cut & Sew Bode Puffer Jacket" (`6a7b72f4935d0a8e81905544`), `platformFormat:
'meta_stories_9_16'` (9:16, 10s), the same 3 `referenceMediaIds` the defective master used.

Mechanism: the PR branch's patched `services/veoPromptBuilder.js` (the only file that PR
touches at runtime) was fetched via `https.get` from GitHub raw content into a fresh Render
one-off job's ephemeral container (`/opt/render/project/src`, currently-deployed commit
`cddee569` — confirmed no drift in that file between the PR's base and that commit, so this
is byte-identical to what a real merge would run) and written over the deployed copy on disk
for that job only — one-off jobs are isolated containers, never the live-traffic dyno. The
job then set `VIDEO_PROMPT_UI_CHROME_GUARD=true` and called the real, unmodified
`atlasVideoService.generateForAd()` directly with a synthetic (never-persisted) `Ad._id`
built from the real master ad's fields — so `Ad.updateOne` at the charge point was a
harmless no-op (matched zero docs) and no real Ad/CampaignRun document was touched or
overwritten. Preflighted first with a free (non-billable) job that fetched the same patched
file and confirmed `isVideoUiChromeGuardEnabled()` flips correctly and
`atlasVideoService.js` still loads clean against it, before spending anything.

## Result

**The guard works.** `predictionId 3e579bc492bd4da785d77316c8011c3c`, Atlas-settled **$0.90**
(confirmed straight from Atlas: `GET /model/prediction/{id}` → `status:"completed"`,
`price:"0.9"`). Frames pulled from the raw pre-titling video at **0.1 / 0.3 / 0.5 / 0.8 / 1.2
/ 2.5s** — densely sampling the first second, since the original defect was confirmed gone by
t=2.5s and invisible to quartile QC sampling — show a clean product shot at every single
timestamp: no nav bar, no hamburger icon, no shopping-bag icon, no garbled header/footer text.
t=0.1s and t=0.5s (where the original chrome was most visible) are clean. The captured prompt
(from the real `generateForAd` return value) contains the guard line verbatim, in the position
the code puts it. Colorway was correct (navy) throughout — the separate, not-fixed-here
wrong-colorway defect did not recur in this run (it was specific to the 16:9 master in the
original incident; not chased further here, per scope).

Flipped `config/defaults.env`'s `VIDEO_PROMPT_UI_CHROME_GUARD` to `true` on this evidence.
Updated the "unverified" prose in `veoPromptBuilder.js` and `verifyVideoUiChromeGuard.js` to
record it — no assertion logic changed (the harness already drives the env var directly).
59/59 guard-specific checks still pass; full repo suite 175/175 `verify*.{js,mjs}` green,
`npm run lint` clean. Committed (`e06ddcaa`) and pushed to the PR branch. **Not self-merged**
— PR is `OPEN`, `MERGEABLE`, `mergeStateStatus: CLEAN`, awaiting review.

Frames and the downloaded raw master video are at
`/private/tmp/claude-502/-Volumes-Sayulita-Projects-RS/c11b6fe8-e9aa-40de-bf20-02d8bf71aa33/scratchpad/ml2-check/`
(`guardon_t0.1.jpg` … `guardon_t2.5.jpg`, `guardon_raw_master.mp4`) alongside the original
incident's known-bad frames (`raw_t0.1.jpg` etc.) for side-by-side comparison.

## Separate finding, flagged not fixed: Mongo Atlas cluster is at its storage quota

The charge-point `CostLog` insert for this test's submission **failed** —
`costTracker.persist failed: you are over your space quota, using 512 MB of 512 MB. Writes
are blocked on your cluster.` This is NOT specific to this test: it means **every production
generation's cost-ledger write is failing right now**, silently (the code already treats a
telemetry/bookkeeping failure as non-fatal to the generation itself, by design — see
`atlasVideoService.js`'s charge-point comment — so nothing user-facing errors, but spend is
going unledgered cluster-wide until this is resolved). `db.stats()` at the time showed
`dataSize` ~386MB / `storageSize` ~127MB against the 512MB cap. Needs an Atlas tier
upgrade or a cleanup/archival pass — owner's call on which; not attempted here, out of scope
for this PR.
