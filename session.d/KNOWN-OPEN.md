# Known-open items (curated, not a dated log entry)

Living checklist. Update in place; do not append a duplicate list elsewhere.

- **URGENT, ACTIVE: production MongoDB Atlas cluster is at its storage quota — ALL writes
  are currently blocked.** Discovered 2026-08-19 while verifying PR #262 (UI-chrome guard):
  a real Omni video submission's charge-point `CostLog` insert failed with "you are over your
  space quota, using 512 MB of 512 MB. Writes are blocked on your cluster." `db.stats()`
  showed `dataSize` ~386MB / `storageSize` ~127MB against the 512MB cap at that moment. This
  is not scoped to that one test — every generation's cost-ledger write (and any other prod
  write) is failing silently right now; the code treats bookkeeping failures as non-fatal to
  the generation itself by design, so nothing user-facing errors, but spend is going
  unledgered cluster-wide. Needs an Atlas tier upgrade or a cleanup/archival pass — owner's
  call on which. Not attempted, not fixed — flagging only.
- **CLOSED DECISION (forward-only, PR #253): historical spend on
  `categoryReviewsService`'s grounded pass and `productDetailsService.
  fetchReviewSummary` before this PR is NOT reconciled or backfilled into
  CostLog.** Both were bare unledgered `axios.post` calls with zero rows ever
  written for them; PR #253 instruments the call sites going forward
  (`trackedGenerate`, stages `category_reviews` / `product_review_summary`) so
  new calls ledger correctly, but makes no attempt to reconstruct what was
  already spent before this landed — no historical Google billing record
  exists to reconcile against, and per standing owner direction (money
  ledgering is a lower priority than shipping generation work right now,
  fixed up once things are otherwise working) no backfill script is staged or
  should be written. `atlasLlmService.post()` missing `maxRedirects: 0`
  (found adversarially reviewing this same PR, confirmed pre-existing across
  ~27 files) is tracked as its own separate follow-up, not bundled here.
- Video multi-surface fan-out (§00 Phase 3) — intent only.
- `RENDER_AUTH_TOKEN` logs `EXPIRED` at every boot (dead `renderViaSpec` path).
- `npm error could not determine executable to run` during postinstall — non-fatal.
- Dead HTML/canvas paths read `author_name` with no re-gate (`aiCanvasSpecService`,
  `layoutResolverService`, `aiCanvasInputBuilder`) — commented, NOT fixed.
- Reels 204 vs Stories 250 safe zones collapse into one `vertical` entry in
  `remotion/lib/safeZones.js`.
- **CLOSED DECISION (owner, 2026-08-19): pre-existing stranded veo ads from
  before the undispatched-tail fix (PR #241) will NOT be backfilled, drained,
  or recovered. Forward-only — do not re-open or re-derive a recovery plan.**
  Population measured at 35 (`status:'queued'`, `wasRendering:true`,
  `renderStage` empty, across 4 failed runs including the proof case
  `run_1787136860887_654ed621`) after an earlier count the same night found 46
  — confirmed zero of them carry any receipt (`veoPredictionId`,
  `imageGeneration.predictionId`, `renderUrl` all empty, zero `CostLog` rows at
  all for those ad ids), so draining would have been a first render (~$0.90
  each, ~$31.50 total), not a double-bill, but the owner declined the spend
  and separately said "I am not interested in saving any past ads, we are only
  looking forward." No backfill script is staged; none should be written. The
  part that actually matters: **PR #241 already stops this from recurring** —
  `buildRequeueSetStage` (`services/adArchiveDigest.js`) stamps an honest
  `renderStage` breadcrumb at all four requeue sites, so a NEW
  claimed-but-never-dispatched tail is visible to `strandedRunSweeper.js` and
  self-heals; only this one closed-off pre-fix backlog is orphaned.
- **`strandedRunSweeper.js`'s recovery pass is structurally blind to video
  receipts — latent double-bill risk for a FUTURE stranded video ad. Not fixed
  (billing-adjacent, out of scope); write-up only, so it doesn't need
  re-deriving.** `sweepStrandedRuns` (`services/strandedRunSweeper.js:151`)
  defaults its `recover` param to `recoverImageAd`
  (`services/imageRecoveryService.js:69`). That function
  (`imageRecoveryService.js:57-59`) is: `const predictionId =
  ad?.imageGeneration?.predictionId || null; if (!predictionId) return {
  state: 'no-receipt' };` — it reads ONLY the static-image receipt field. A
  video ad's receipt lives in `Ad.veoPredictionId`
  (`services/spendReceipt.js`), which this function never inspects. So for
  every `renderRoute:'veo'` ad, PASS 1 — "recover paid work for free before
  spending again," the sweeper's entire reason for existing — reports
  `no-receipt` unconditionally, right or wrong, and the ad falls straight to
  PASS 2: `requeue` → `requeueStrandedAds` (`routes/ads.js:4713`) →
  `runRenderLoop`, a fresh billable Omni submit (~$0.90), with no code on that
  path ever checking `ad.veoPredictionId` first.
  **Concrete failure scenario:** a video ad is claimed, `atlasVideoService`
  submits it (charged immediately) and writes `veoPredictionId`, then the
  process dies before the render loop records completion. If that ad reaches
  `status:'queued'` with a non-empty `renderStage` while `veoPredictionId` is
  still set — e.g. `adStage()` fired before the crash, or some future requeue
  site omits the `receiptFree()` filter that every current site applies —
  `strandedRunSweeper` calls `recoverImageAd`, gets `no-receipt` (wrongly:
  a receipt exists, this function simply never looked), and requeues it into
  a second paid Omni submit for a master already bought once. **Verified
  tonight this has not happened**: all 35 ads in the decision above have
  `veoPredictionId` empty, so today the gap is latent, not triggered — it
  survives only because every current requeue site (`worker.js`,
  `services/processAlerts.js`, both crash catches in `routes/ads.js`) filters
  through `receiptFree()` before the `rendering`→`queued` move; the sweeper's
  own recovery pass adds no defense-in-depth if that upstream discipline is
  ever missed on some future call site. Fix shape (not implemented): a
  `recoverVideoAd({ad})` that peeks `ad.veoPredictionId` the same read-only way
  `recoverImageAd` peeks image predictions, dispatched by `ad.renderRoute`,
  wired into `sweepStrandedRuns`'s default `recover`; plus a revert-proven
  check in `scripts/verifyStrandedSweep.js` asserting a stranded video ad WITH
  a `veoPredictionId` is recovered, not requeued. Do not widen
  `strandedRunSweeper`'s ad-selection filter itself for this — it is only
  about what the recovery pass does once an ad is already selected. Flagged as
  a spawn_task chip ("Add video-receipt recovery to strandedRunSweeper") in the
  session that found it.
- Root cause of why THIS SPECIFIC run's CampaignRun heartbeat stopped ticking
  at 11:04:32Z, 17 minutes before the 11:21:43Z reap, was not pinned to one
  line. Render logs for the window show **three separate web-instance
  boots/restarts** (11:02:12, 11:04:42, plus a platform-logged "Instance
  restarted" at 11:05:33) — consistent with an ordinary instance replacement
  killing the process holding the heartbeat ticker, NOT a logic bug in
  `isWorking()`. But the render loop's OWN `Promise.all` demonstrably kept
  producing completions in the SAME run for another ~30 minutes after that
  (renderStageAt timestamps up to 11:34:28Z on the 12 ads that did succeed),
  which is odd if the original process were truly gone — most likely explained
  by `bootRecoveryService` recovering the two receipted masters in a
  replacement process and separately-dispatched derive ads completing behind
  them, not literally the same in-memory pool surviving the restart. Not
  reconciled to a single timeline with certainty; if a similar-shaped incident
  recurs with NO instance-replacement log evidence, that would be the signal
  this explanation is incomplete and the heartbeat mechanism itself needs a
  second look.
- **26 pre-existing cross-branded Ads are not cleaned up** by the
  `fix/crossbrand-tenancy-generate` tenant-leak fix (see
  `session.d/2026-08-19_crossbrand-tenant-leak-generate-fix.md`) — the code
  change only prevents FUTURE occurrences. 23 of the 26 carry real billable
  CostLog spend (~$17.54 total, `atlas_video_render` / `direct_image`).
  Someone with an explicit owner call needs to decide whether to
  quarantine/delete those specific Ad documents and whether the already-spent
  ~$17.54 needs any accounting treatment; not attempted as part of the code
  fix (production Ad deletion is a data-remediation decision, not a
  correctness fix). Ad ids are in that PR's description.
- **PR #245 fixed productIds ownership on POST /generate, but the same
  missing-`brandId` pattern still exists in six other places** — found by an
  adversarial (Grok, `--effort xhigh`) review of #245 after it merged, two of
  the six independently re-verified by hand against the real source (not just
  the review's own claim):
  - **CONFIRMED LIVE, still exploitable on the deployed code as of
    2026-08-19**: `services/campaignAdsGenerationService.js` ~1330-1346 (inside
    `expandWizardJob`'s on-demand detect prep) resolves the request's raw,
    UNFILTERED `mediaIds` via `Media.find({ _id: { $in } })` with no `brandId`
    clause, unions their `matchedProducts[].catalogProductId` into `ensureIds`,
    and calls `ensureDetectForProducts(ensureIds, { brandId, ... })` —
    `services/catalogProductDetectService.js` ~367-387 accepts that `brandId`
    param and never uses it (`CatalogProduct.find({ _id: { $in: oids } })`, no
    brand clause). A POST /generate with a foreign brand's UGC `mediaId` can
    still trigger a BILLED Gemini vision detect call against another brand's
    catalog product today, regardless of `productIds`. This is a live money +
    tenant leak independent of what #245 closed.
  - **CONFIRMED, currently latent** (not reachable through /generate post-#245,
    since `productIds` there are now ownership-filtered before reaching this):
    `services/campaignAdsGenerationService.js` ~3035-3087,
    `firstCatalogMediaForProduct` — the DETERMINISTIC VIDEO seed path, a
    separate lookup from `buildSeededUniverse` (which #245 fixed) — has the
    identical no-`brandId` pattern on both its `CatalogProduct.findById` and
    `Media.findOne` calls. #245's own comment that the `buildSeededUniverse`
    brandId clause is "the thing that actually stops the leak when productId
    itself is compromised" is only true for the image/concept path.
  - Four more claimed by the review but **not yet independently verified**:
    `/preview` never got the ownership check (dry-run, so no direct Ad
    spend, but reads/misreports another brand's data for billable-count
    estimates); `resolveOwnedProductIds` doesn't dedupe, so a caller sending
    the same owned productId twice can double a Director round's spend;
    the legacy (`AI_CONCEPT_DRIVEN=false`) cartesian fallback's
    `seedsFromMedia`/`seedsFromProduct` have the same no-brandId pattern;
    unfiltered `mediaIds` still get `$addToSet`ed onto `Campaign.mediaIds`
    (routes/ads.js ~814-818), which can keep re-triggering the detect-cost
    leak above on every subsequent generate for that campaign.
  - Flagged as a spawn_task chip in the session that landed #245
    ("Close remaining brandId gaps in mediaIds/UGC/video product loaders").
    Priority: the `mediaIds`→detect-cost leak (first bullet) is the only one
    confirmed both real AND currently exploitable — verify it against prod
    the same way #245 was (a Render one-off job), fix it, then work through
    the rest with the same rigor (prod measurement, revert-proved harness,
    full verify+lint gate, PR, confirm deploy).

---

