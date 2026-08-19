# Known-open items (curated, not a dated log entry)

Living checklist. Update in place; do not append a duplicate list elsewhere.

- Video multi-surface fan-out (§00 Phase 3) — intent only.
- `RENDER_AUTH_TOKEN` logs `EXPIRED` at every boot (dead `renderViaSpec` path).
- `npm error could not determine executable to run` during postinstall — non-fatal.
- Dead HTML/canvas paths read `author_name` with no re-gate (`aiCanvasSpecService`,
  `layoutResolverService`, `aiCanvasInputBuilder`) — commented, NOT fixed.
- Reels 204 vs Stories 250 safe zones collapse into one `vertical` entry in
  `remotion/lib/safeZones.js`.
- The 9 pre-existing stranded ads in `run_1787136860887_654ed621` (the real,
  measured proof case for the undispatched-tail fix — see
  `session.d/2026-08-19_undispatched-tail-fix-stranded-ads-close-the-loop.md`)
  still sit `queued` with no `renderStage` — the CODE fix only prevents this
  happening to FUTURE reap/SIGTERM/crash events, it does not retroactively
  touch rows already written before it existed. A one-time backfill script
  (stamps the identical breadcrumb the fix would have written, via the same
  `buildRequeueSetStage`, dry-run verified against the real 9 documents) is
  ready but was **not applied** — the session's own write attempt was blocked
  by the Claude Code permission classifier (a live production DB write).
  Someone with write access needs to either run that script (ask the session
  that wrote it, or re-derive: filter on `campaignRunIds` containing the run,
  `status:'queued'`, `wasRendering:true`, `renderStage` empty, both attempt
  counters 0) or simply press **Generate more** on the campaign, which drains
  them today regardless of this fix.
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

