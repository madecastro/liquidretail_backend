# Cost-ledger attribution follow-up — detect/ingest pipeline only

Follow-up to `2026-08-24_cost-ledger-attribution-gap.md` (same day, same branch
`fix/cost-ledger-attribution`). A broader Grok audit from the original pass found
~12 more CostLog producer call sites with real attribution IDs one hop away in their
callers. Mid-session redirect from the owner: focus effort on `liquidretail_adgen`
(the live render path) — don't bother ledgering calls on backend paths that aren't
used anymore now that adgen owns rendering (`ADGEN_RENDERER_ENABLED=true`). This repo
still owns HTTP generate/expansion/mint/claim AND the separate DETECT/INGEST pipeline
(`pipelines/detect.js` — social-media UGC product detection, unrelated to ad
rendering), which is genuinely still live here. So this follow-up kept only the items
confirmed to sit on that live pipeline:

- `services/yoloIdentifyService.js` / `services/geminiIdentifyService.js` — both
  called exclusively from `pipelines/detect.js` (confirmed: no other requirer of
  either file). Threaded `brandId`/`productId` (from `run.brandId || media.brandId`
  / `media.metadata?.catalogProductId`, the same cascade the original 6-stage pass
  already used for `subject_text`/`crop_refine`/etc. in this same file) through a
  single shared `hints` object both identify calls consume.
- `services/productMatchService.js` (UGC-to-catalog visual matching:
  `compareUgcCropToCatalogProduct`, `findCatalogMatchByText`, `catalogFirstMatchOneRefined`)
  and `services/visualCatalogMatchService.js` (`compareCropToCandidate`) — confirmed
  live via `grep -n "require(.*productMatchService" pipelines/detect.js`
  (`findProductMatches`/`findPerProductMatches`, both required there). Threaded
  `brandId`/`productId` through `compareCropToCandidate`'s signature and
  `compareUgcCropToCatalogProduct`'s new third `{ brandId }` options param, updating
  all 3 of its call sites plus the `findCatalogMatchByText` embedding call.

## Also landed before the redirect (harmless, not chased further)

A handful of small additive edits landed on the RENDER path in this repo just before
the redirect arrived — `services/adVisionQcService.js` (both QC judges +
`campaignRunId` threading through `directImageRenderService.js`'s
`renderDirectImage`), `services/aiOverlayPolishService.js` /
`services/aiVideoPosterService.js` (an `adId` field each), `services/imageRecoveryService.js`
(a `productId` field, twice), `services/atlasVideoService.js`'s `reframe-outpaint`
stage (`adId`/`campaignRunId`, adjacent to the original pass's
`reframeReferenceForAspect` fix), `services/brandEnrichmentService.js`,
`services/aiLayoutStudioService.js`. These are purely additive and harmless whether
or not the enclosing backend render path is actually exercised for new ads — left in
place rather than reverted, since undoing them would cost more than the (possibly
zero) value of removing dead-path telemetry. Not expanded further, and
`services/plateIntelService.js`'s `remotionRenderService.js` caller — confirmed to
have no other requirer, i.e. genuinely render-path-only — was deliberately NOT wired
(only the function signature got an inert, unused `ids` param).

## Vendor-drift note

None of this follow-up's files are in the backend↔adgen vendored-file tracking
(`services/productMatchService.js`, `visualCatalogMatchService.js`,
`yoloIdentifyService.js`, `geminiIdentifyService.js` are backend-only per the
original pass's file-existence check) — no `verifyVendorDrift.js` reconcile needed
for this half.

## Verify state

Lint clean, `node --check` clean on all touched files. Full suite 197/199, exactly
the pre-existing baseline from the original pass (`verifyPreparingReap.js`,
`verifyRenderStages.js`, both unrelated). Existing `scripts/verifyCostAttribution.js`
(40 checks, from the original pass) untouched and still green — this follow-up's new
call sites were deliberately NOT added to that harness, since the owner's redirect
came mid-pass and further harness investment on this slice wasn't the priority;
flagging as a natural next step if this repo's detect-pipeline attribution is
revisited.

See `liquidretail_adgen`'s
`session.d/2026-08-24_cost-ledger-attribution-followup-adgen-render-path.md` for the
paired, actually-prioritized adgen render-path fix (same day, same branch name,
different repo).
