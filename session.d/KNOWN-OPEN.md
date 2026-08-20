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
- **NEEDS AN OWNER DECISION (PR #265): `scripts/backfillBrandFontGenerics.js` has
  not been run, so the static-ad typeface fix is INERT for every brand already
  ingested — including Marine Layer 2, the brand it was written for.** The fix
  reads a serif/sans classification from the CSS generic a storefront declares
  beside its own font (`font-family: Seriously Nostalgic, serif`), captured at
  ingest into `websiteFontUsage.{heading,body,button}Generic`. Brands ingested
  before that capture existed have no such field, and `Brand.fontIngestedAt`
  exists specifically to stop the pipeline re-crawling storefronts, so there is
  no natural refresh — nothing changes until the backfill runs or a brand is
  re-ingested. The script is dry-run by default, writes only those three fields
  (never a family, never `customFonts`), refuses to overwrite an existing
  generic, skips any role whose live family no longer matches what was recorded,
  shares ingest's own `collectStylesheets`/scorer so it cannot derive a value the
  pipeline would not, and writes each field under a filter requiring it to still
  be unset. Its derivation path is live-verified against marinelayer.com; the
  **Mongo write is the one part never exercised**. Suggested order:
  `--brand "Marine Layer 2"` dry run, then `--apply` for that brand, then a wider
  dry run. Until then the classification behaviour of every existing brand is
  byte-identical to before PR #265.
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
- **PR #245 fixed productIds ownership on POST /generate; the same
  missing-`brandId` pattern existed in five more places, found by an
  adversarial (Grok, `--effort xhigh`) review of #245. UPDATED 2026-08-19 —
  a SECOND independent Grok pass (`--effort high`, told to be adversarial
  toward the first review) plus hand-verification of every cited file:line
  materially corrected several of these; read the corrected version below,
  not the original claims.**
  - **FIXED** (`fix/detect-media-brand-tenancy`, see
    `session.d/2026-08-19_detect-prep-mediaids-brand-leak-fix.md`):
    `services/campaignAdsGenerationService.js`'s `expandWizardJob` detect-prep
    block resolved the request's raw, unfiltered `mediaIds` via
    `Media.find({ _id: { $in } })` with no `brandId` clause, and
    `services/catalogProductDetectService.js`'s `ensureDetectForProducts`
    accepted a `brandId` param but never applied it to either of its
    `CatalogProduct.find` calls. Confirmed live+exploitable and measured
    against prod (see the fix's write-up for the numbers) before landing.
  - **`firstCatalogMediaForProduct`, CONFIRMED, still latent, NOT fixed** —
    `services/campaignAdsGenerationService.js` ~3035-3087, the deterministic
    VIDEO seed path (separate from `buildSeededUniverse`, which #245 fixed):
    every query (`CatalogProduct.findById`, two `Media.findOne`) is scoped to
    `catalogProductId`/`source`, never `brandId`. Not reachable via /generate
    today since `productIds` are ownership-filtered before reaching it
    post-#245. Follow-up.
  - **`/preview` has no ownership check — CONFIRMED, but the blast radius is
    much narrower than first claimed.** On the LIVE path
    (`AI_CONCEPT_DRIVEN=true`, the actual prod default — see below), `dryRun`
    skips detect-prep entirely and the estimate branch computes billable
    counts by pure arithmetic over the request array — it does NOT read any
    foreign brand's real catalog/media. Only misquotes the estimate; not
    billable, not tenant-data-exposing, on the path that runs today. The
    narrower flag-off cartesian path genuinely reads foreign data and can
    trigger a real detect write — but see the flag-state correction below,
    that path is not live by default. Not fixed. Follow-up.
  - **`resolveOwnedProductIds` doesn't dedupe `productIds` — CONFIRMED, real
    money, not tenant-exposing.** `routes/ads.js:403-414` filters the raw
    request array without deduping; a duplicate OWNED productId gets a
    second paid Director+Judge round (~$0.105/round) via
    `runConceptDrivenExpansion`. Deterministic video is protected by its own
    identity-digest unique index; static is only sometimes protected (digest
    also includes `conceptId`, so two rounds emitting different concept
    slugs both insert and bill). Not fixed — a one-line dedupe in
    `resolveOwnedProductIds` is the whole fix. Follow-up, next priority after
    the fixed item above.
  - **Legacy cartesian fallback (`seedsFromMedia`/`seedsFromProduct`) has no
    brandId check — CONFIRMED PATTERN, but the "flag off ⇒ live" premise was
    WRONG. Latent, not live, lower urgency than first reported.**
    `AI_CONCEPT_DRIVEN` reads `false` from a bare unset `process.env` lookup,
    but `config/defaults.env:31` sets it `true` and loads after process env
    with no override — the EFFECTIVE default in prod is `true`, so the
    concept-driven path runs and this cartesian fallback is dead code by
    default. Even flag-off, the live universe build already brand-scopes
    `mediaIds` (`seededUniverseService.js:451`) — so this needs BOTH the flag
    off AND an image-only/single-format request to be reachable. Real bug,
    correctly identified pattern, not a live default-config leak. Follow-up.
  - **Unfiltered `mediaIds` persisted onto `Campaign.mediaIds` — PARTIALLY
    CONFIRMED; persistence is real, "re-triggers cost on every subsequent
    generate" was WRONG.** `routes/ads.js:813-819` does persist the raw,
    unfiltered ids (contrast the dedicated pin routes in `routes/campaigns.js`,
    which DO brand-filter). But `expandWizardJob` never reads
    `Campaign.mediaIds` back, and even if a client re-posts a persisted
    foreign id, the live universe build drops it before it can become a
    billable seed. **The actual live leak is read-back, not re-billing**:
    `GET /api/campaigns/:id/media` (`routes/campaigns.js:944`) does
    `Media.find({ _id: { $in: ids } })` with no `brandId` clause and returns
    `fileUrl` — so a foreign brand's pinned media genuinely gets served to
    the operator's UI. That's the real, live fix target, not a rebilling
    loop. Not fixed. Follow-up.
  - Recommended order for the remaining four: the `resolveOwnedProductIds`
    dedupe (cheapest, real money), then the `GET .../media` read-back leak
    (cheapest, real tenant-data exposure), then `firstCatalogMediaForProduct`
    and the legacy cartesian path (both latent, lower urgency) — each with
    the same rigor as the fixed item: prod measurement where applicable,
    revert-proved offline harness, full verify+lint gate, PR.

- **`services/mediaAssignmentService.js`'s `attachProduct` (and every other
  attach/detach in the file) scopes ownership by `advertiserId` ONLY, never
  `brandId` — despite the file's own header claiming "Cross-tenant attach is
  impossible." CONFIRMED by reading the code (adversarial review of PR #257
  `fix/detect-media-brand-tenancy`, 2026-08-19); report-only, not fixed —
  this is a separate change from that PR's scope.**
  `assertMediaOwned` (`:23-27`) is `Media.findOne({ _id: mediaId,
  advertiserId })` and `assertProductOwned` (`:30-34`) is
  `CatalogProduct.findOne({ _id: productId, advertiserId })` — brandId never
  enters either query, and `attachProduct` (`:48-...`) calls only these two
  before writing the assignment. `models/Brand.js:37` confirms an advertiser
  routinely owns MULTIPLE brands (`advertiserId` is a real, indexed field,
  and the unique index at `:495` is `{advertiserId, nameNormalized}` — i.e.
  uniqueness is per-brand-name-within-an-advertiser, not one brand per
  advertiser). So an operator on a multi-brand advertiser account can call
  the attach-product endpoint with a `mediaId` belonging to Brand A and a
  `productId` belonging to Brand B (same advertiser, different brand) and it
  succeeds — creating exactly the cross-brand Media↔CatalogProduct shape
  that `catalogProductDetectService.js`'s (now-corrected, see the fix landed
  in this same PR) fail-open comment gestured at, except this one is a real,
  reachable write path, not a dead conditional. Downstream consequence:
  `catalogProductDetectService.ensureDetectForProducts` is now scoped to the
  CALLER's brandId, but if an operator has attached a foreign-brand product
  to a Media row via this path, later detect/render flows that trust
  `Media.matchedProducts[].catalogProductId` as "this brand's product" would
  still be handed a cross-brand id — the attach is the actual hole, not the
  detect scoping this PR fixed. Not fixed here — scoped as its own follow-up
  (add `brandId` to both `assertMediaOwned`/`assertProductOwned`, derived
  from the Media's own `brandId` for the product/category assert, and fix
  the file's header comment to stop claiming an invariant the code does not
  enforce).

---

