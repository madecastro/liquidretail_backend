# Cost-ledger attribution gap — adgen's copy of the backend fix

Paired with `liquidretail_backend`'s `fix/cost-ledger-attribution` (same branch name,
different repo) — see that repo's `session.d/2026-08-24_cost-ledger-attribution-gap.md`
for the full incident writeup. Summary: a live audit found ~42% of one day's real
Atlas spend landing in CostLog with `brandId`/`productId`/`adId`/`campaignRunId` all
null across six stages. Four of those six exist as separate copies in this repo —
`layoutInputService.js`, `basePlateCropService.js`, `judgeService.js`,
`overlayZoneService.js` — confirmed via `git ls-tree -r origin/master` (an earlier
check against a stale local `liquidretail_adgen` checkout wrongly reported
`overlayZoneService.js` as absent). Since `ADGEN_RENDERER_ENABLED=true` in prod, this
repo is the live renderer, so the backend-only fix would have been inert for new ad
generation on these four stages.

## What changed

Same pattern as backend: optional `brandId = null, productId = null, adId = null,
campaignRunId = null` threaded through each producer and its real callers in THIS
repo — `src/services/renderer.js` and `src/services/atlasVideoService.js` (this
repo's own render loop, not backend's `pipelines/detect.js`/`renderService.js`,
which don't apply here). `judgeService.js`'s `judgeDetections`/`judgeExtendedCrops`
have zero in-repo callers today (confirmed by grep — this repo's live judge path is
`aiJudgeService.js`, a different file); the attribution params were still added for
parity/future-proofing, but they're inert until something actually calls this file.

`campaignRunId` is derived from `ad.campaignRunIds[ad.campaignRunIds.length - 1]`
(the array's last entry) where no explicit run id is otherwise in scope
(`renderer.js`'s `renderStatic`, `basePlateCropService.js`'s two `detectClipBoxes`
callers) — an approximation, not exact, since an ad's `campaignRunIds` can hold more
than one run across its life (mint + claim). Adversarially reviewed (Grok, high
effort, read-only) specifically for this and for the two `refreshStaleLayoutInput`
call sites in `atlasVideoService.js` (`prepareStoryboard` vs `generateForAd`, only
one of which has a `campaignRunId` param) — came back clean, no findings.

## Vendor-drift reconciliation

`scripts/verifyVendorDrift.js` correctly flagged all four touched files as no longer
byte-identical to their backend counterparts (they're not, by design — the calling
context genuinely differs between the two repos). Recorded as intentional forks via
`node scripts/verifyVendorDrift.js --reconcile <path> --reason "…"` for all four,
matching the existing precedent for `services/directImageRenderService.js`. One
pre-existing, unrelated drift item (`services/quoteSnippetService.js`) was already
failing before this change and is untouched.

## Verify state

`npm run lint` clean. `node --check` clean on all six touched files. Full suite:
24/28 (same as an unmodified `origin/master` checkout, confirmed via `git stash` —
`verifyArchiveDigestRelease.js` (2 pre-existing scan failures), `verifyModelParity.js`
(pre-existing, looks like a worktree sibling-path resolution issue — all 33 models
fail identically with "never called mongoose.model(...)" even though every one
genuinely does; not caused by this change, not investigated further), and
`verifyRunFinalizesOnSettle_KNOWN_OPEN.js` (explicitly self-labeled as an expected-red
known-open defect harness) are all pre-existing and unrelated).

No harness equivalent to backend's new `scripts/verifyCostAttribution.js` was added
here — flagging as a reasonable follow-up rather than building it unprompted; the
backend harness's structural approach (revert-proven against real file content,
covering both producer signatures and real caller call sites) would port directly.
