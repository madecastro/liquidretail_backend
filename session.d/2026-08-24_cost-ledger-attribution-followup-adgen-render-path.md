# Cost-ledger attribution follow-up — the actual live render path

Follow-up to `2026-08-24_cost-ledger-attribution-gap.md` (same day, same branch
`fix/cost-ledger-attribution`). Owner redirect mid-session: focus on the adgen render
path specifically, since backend's OWN copies of the ad-render pipeline
(`directImageRenderService.js`, `atlasVideoService.js`'s `generateForAd`,
`brandScriptExecutor.js`, `remotionRenderService.js`, and everything they call for
vision QC / poster generation / recovery) are largely dead for new ads now that this
repo (`ADGEN_RENDERER_ENABLED=true`) owns rendering — ledgering calls on that dead
backend path isn't worth the effort. This pass fixes the SAME six stages' pattern in
this repo, where it's actually live: `ad_vision_qc`, `ad_video_vision_qc`,
`video_poster`, `direct_image_recovered`, `direct_image_settled`,
`brand_enrichment_gpt`, `title_plate_scan`.

## What changed, and the one non-obvious hop

Same additive pattern: optional `brandId = null, productId = null, adId = null,
campaignRunId = null` threaded through each producer into its `chatCompletion`/
`trackLlmCall`/`finalizeFlatCost` meta, sourced from whatever the real caller in
THIS repo's render loop actually has (`directImageRenderService.js`'s
`renderDirectImage`, `brandScriptExecutor.js`'s two video-QC/titling call sites,
`imageRecoveryService.js`'s `recoverImageAd`/`settleChargeState`).

**The one genuinely tricky part: `title_plate_scan` crosses a child-process IPC
boundary.** `plateIntelService.js`'s `analyzePlate`/`semanticScan` are called from
`remotionRenderService.js`'s `renderTitlesJob`, which — when `REMOTION_IN_CHILD`
isn't set — runs inside a SPAWNED CHILD PROCESS reached only through
`payloadForChild(args)`, an **explicit allow-list** (deliberately, per its own
comment: *"a mongoose lean() doc must not cross the IPC boundary whole"*). Adding
`brandId`/`productId`/`campaignRunId` to `renderTitlesJob`'s own signature would have
been a no-op in the child-process path, because `payloadForChild` would have silently
dropped them before the child ever saw them — the args never survive the `fork()`.
Fixed by adding all three to `payloadForChild`'s allow-list AND `renderTitlesJob`'s
signature, then threading from `brandScriptExecutor.js`'s two `renderTitles({...})`
call sites (`ad.brandId`, `ad.productId`, `ad.campaignRunIds[last]`) through
`renderTitlesJob` → `analyzePlate` → `semanticScan` → the `chatCompletion` meta.
`renderPreview`'s two `analyzePlate` calls (a genuinely ad-less preview path) were
deliberately left untouched — there is no `adId` to give them.

`campaignRunId` is approximated as `ad.campaignRunIds[ad.campaignRunIds.length - 1]`
(the array's last entry) at every hop that has no explicit scalar in scope — this
repo's OWN earlier pass already used that exact heuristic for `basePlateCropService.js`
and `renderer.js`, so this follows established local precedent rather than
introducing a new one.

## Vendor-drift reconciliation

Only `services/brandEnrichmentService.js` newly diverged from a "synced" (byte-
identical-to-backend) status — every other touched file
(`adVisionQcService.js`, `directImageRenderService.js`, `brandScriptExecutor.js`,
`imageRecoveryService.js`, `aiVideoPosterService.js`, `plateIntelService.js`,
`remotionRenderService.js`) was already a recorded fork before this pass (expected —
these ARE the render-path files that make adgen a separate service in the first
place). Reconciled with `--reconcile services/brandEnrichmentService.js`.
`services/quoteSnippetService.js` remains the same pre-existing, unrelated drift
noted in the first entry.

## Adversarial review (xhigh, read-only, real files)

Confirmed the IPC mechanism itself holds end to end: `payloadForChild`'s allow-list
and `renderTitlesJob`'s signature both take the three new fields; both invocation
branches of `renderTitles` (in-process via `REMOTION_IN_CHILD=1`, and child via
`payloadForChild` → stdin JSON) forward them; `analyzePlate` → `semanticScan` →
the `chatCompletion` meta all receive them. No out-of-scope identifiers.

One real finding, fixed: `imageRecoveryService.js`'s `maybeQcRecoveredPlate` already
computed a scalar `runId` for `buildAppPreviewUrl` — but from
`ad.campaignRunIds[0]` (the MINT run, kept there deliberately for the Slack/preview
link-back), not `[length - 1]` (the most-recently-touched run) like this file's other
two new attribution hops. My first draft reused that `runId` for the new
`campaignRunId` field on the `judgeRender` call, silently importing the wrong
run-selection convention. Fixed: that one call site now computes its own
`[length - 1]` value inline, with a comment explaining why it deliberately does not
reuse `runId`. The two pre-existing `campaignRunId: runId` uses at
`noteQcFailToRunFeed`/`noteQcPassToRunFeed` (Slack run-feed links) are untouched —
correct as they were, unrelated to cost attribution.

## Verify state

Lint clean, `node --check` clean on all 8 touched files. Working sessions in this
worktree had run a plain `npm install` early on, which — per this repo's own
`CLAUDE.md` ("never `npm ci` an adgen worktree... it needs adgen's own
`require('mongoose')` to FAIL so its `Module._load` fallback patch installs") —
gave `verifyModelParity.js` a real, working `mongoose` and defeated its
cross-repo schema-comparison shim, and every run through this pass reported it
(and, it turns out, `verifyArchiveDigestRelease.js`'s two scan checks) as failing.
**Neither was a genuine pre-existing defect** — confirmed by moving
`node_modules/mongoose` aside and re-running: `verifyModelParity.js` → 33/33,
full suite → **31/32**, with the ONLY failure being
`verifyRunFinalizesOnSettle_KNOWN_OPEN.js`, which is explicitly red-by-design and
already carried in `scripts/expected-failures.json` as a CI-gated known-open item.
`verifyVendorDrift.js` clean after the one reconcile above. (An earlier run also
showed a one-off `verifyRequireGraph.js` flake — reran clean; a concurrent-agent
artifact, not a real regression, and unrelated to the mongoose issue.) Restored
`node_modules/mongoose` afterward so the worktree is left in its normal state.

## Backend follow-up, done but explicitly NOT the priority

The paired backend session also picked up a broader Grok-identified audit of ~12
more producer call sites, but per the same redirect only kept the ones on backend's
still-live DETECT/INGEST pipeline (`pipelines/detect.js` and everything it calls:
`yoloIdentifyService.js`, `geminiIdentifyService.js`, `productMatchService.js`'s
UGC-to-catalog visual matching, `visualCatalogMatchService.js`) — confirmed live via
`grep -rn "require(.*productMatchService" pipelines/detect.js`. The render-path items
in that same audit (`adVisionQcService.js`, `aiOverlayPolishService.js`,
`aiVideoPosterService.js`, `imageRecoveryService.js`, `plateIntelService.js`'s
`remotionRenderService.js` caller) were left mostly untouched in backend — a couple
of small, harmless additive edits landed before the redirect arrived mid-session,
which cost nothing to leave in place but weren't chased further. See backend's
`session.d/2026-08-24_cost-ledger-attribution-followup-detect-pipeline.md`.
