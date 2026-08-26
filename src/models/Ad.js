// Ad — one (campaign × product × media × template × ratio × variant)
// combination, persisted at queue time and updated as it moves through
// the render lifecycle.
//
// Lifecycle:
//   queued     — created by expandWizardJob; no render output yet
//   rendering  — picked up by a CampaignRun; Puppeteer in flight
//   draft      — render succeeded; ready to publish
//   live       — operator published
//   archived   — soft-deleted
//   failed     — render attempt failed; preserved for diagnostics
//                (no auto-retry; operator-initiated only)
//
// Dedup: identityDigest is sha256 over the IDENTITY inputs (campaignId,
// productId, mediaId, template, aspectRatio, variantKind, cta*). Same
// inputs → same digest → unique index on (campaignId, identityDigest)
// rejects duplicate queue inserts. Same digest also implies same
// rendered output, so render-time skip can use it too.
//
// Copy snapshot is filled at RENDER time, not queue time — the
// LayoutInputArtifact derivation (Gemini-backed copy gen with per-
// template character constraints) is expensive and we only want to
// pay for ads we actually render.

const mongoose = require('mongoose');

const adSchema = new mongoose.Schema({
  // ── Tenancy + grouping ───────────────────────────────────────────
  brandId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Brand',    required: true, index: true },
  campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', default: null,  index: true },

  // Every render run that has SELECTED this Ad. Started as a scalar
  // (the first run's id) but flipped to an array (#111) so re-render
  // calls that hit the (campaignId, identityDigest) dedupe — i.e. the
  // cached Ad already exists — can $addToSet the new runId. Without
  // this, /ads?campaignRunId=X filtered to the new run came back empty
  // because the cached Ad still pointed at its ORIGINAL runId only.
  // Empty until a CampaignRun first picks the Ad.
  campaignRunIds: { type: [String], default: [], index: true },

  // Ad-gen microservice extraction (Phase 1). Which renderer worker (if
  // any) has taken ownership of this ad for the actual render work.
  // NULL while queued OR while status='rendering' but not yet claimed by
  // a worker — a renderer instance atomically claims by findOneAndUpdate
  // ({status:'rendering', claimedByWorker:null}, {$set:{claimedByWorker,
  // claimedAt}}). Cleared when the ad transitions to a terminal state.
  //
  // Backend's in-process render path (flag ADGEN_RENDERER_ENABLED=false)
  // leaves both fields null — its own runRenderLoop owns the work without
  // needing a per-worker marker. When ADGEN_RENDERER_ENABLED=true, backend
  // skips runRenderLoop and adgen renderers race for the claim.
  claimedByWorker: { type: String, default: null, index: true },
  claimedAt:       { type: Date,   default: null, index: true },

  // ── Source linkage ───────────────────────────────────────────────
  mediaId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Media',          required: true, index: true },
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'CatalogProduct', default: null,  index: true },

  // Resolved at render time when buildLayoutInput runs. Null while queued.
  layoutInputArtifactId: { type: mongoose.Schema.Types.ObjectId, ref: 'LayoutInputArtifact', default: null },

  // Stamped at render time alongside layoutInputArtifactId. Gives the
  // Ads list a clean FK to join AiFullRenderArtifact (photoreal polish)
  // instead of reconstructing the 8-field cartesian cache key from
  // fields the Ad doesn't carry (campaignContextHash, creativeStyle).
  // Null for V1/legacy ads — Ads list falls back to a cartesian heuristic.
  aiCanvasArtifactId:    { type: mongoose.Schema.Types.ObjectId, ref: 'AiCanvasArtifact',   default: null },

  // ── Generation context ───────────────────────────────────────────
  template:     { type: String, required: true, index: true },
  aspectRatio:  { type: String, required: true },
  campaignKind: { type: String, default: null },                       // 'brand' | 'promotional' | 'product' | 'collection'

  // Platform-format-aware ad generation (Phase 1a). Carried from the
  // Campaign at queue time so downstream services (Director, HTML Gen,
  // validator, AiCanvasArtifact cache key) can branch on format
  // without re-joining Campaign per render. Defaults to
  // 'meta_feed_1_1' to match legacy behavior on rows queued before
  // the Phase 1a rollout. See Campaign.platformFormat for the full
  // enum + future values.
  platformFormat: {
    type:    String,
    enum:    [
      'meta_feed_1_1', 'meta_feed_4_5', 'meta_reels_9_16', 'meta_stories_9_16', 'pmax_16_9',
      // Phase A live PMax surfaces (mirror services/platformFormats.js status:'live')
      'pmax_landscape_1_91_1', 'pmax_square_1_1', 'pmax_portrait_4_5',
      'pmax_video_16_9', 'pmax_video_1_1', 'pmax_video_9_16'
    ],
    default: 'meta_feed_1_1',
    index:   true
  },

  // requested video length in seconds (wizard format-selection stage); null = standard 8s
  videoDurationSec: { type: Number, default: null },

  // Which match outcome produced this Ad. brand_only is the no-pick
  // path (no operator picks → top brand_match media wide).
  matchTier: {
    type:     String,
    enum:     ['product_match', 'product_category', 'brand_match', 'brand_only'],
    required: true,
    index:    true
  },

  // Which visual asset drives the ad:
  //   product_image — catalog product photo as the media slot
  //   ugc           — UGC media that matched as the media slot
  variantKind: {
    type:     String,
    enum:     ['product_image', 'ugc'],
    required: true,
    index:    true
  },

  // Where the ad's style bindings (panel_bg, headline_text_color,
  // cta_button_bg) resolve their colors from:
  //   media — palette extracted from the hero media (today's default)
  //   brand — Brand.primaryColor / accentColor / secondaryColor
  // Doubles the cartesian: every (media, product, template, ratio,
  // variantKind) combo emits two Ads — one media-colored, one brand-
  // colored. Operator picks the winner per render.
  paletteSource: {
    type:     String,
    enum:     ['media', 'brand'],
    default:  'media',
    required: true,
    index:    true
  },

  // Denormalized at queue time so the selection query can sort
  // without joining Media. Combines Media.adSuitability.score and a
  // match-tier weight (product_match > product_category > brand_match
  // > brand_only). 0..1, null when neither signal is available.
  readinessScore: { type: Number, default: null, index: true },

  // ── Concept-driven generation (Phase A — AI_CONCEPT_DRIVEN flag) ─
  // Replaces the (template × seed × ratio) cartesian with one Ad per
  // Director-emitted concept. Each concept declares which seeded media
  // it uses (mediaIds[]), what output shape it materializes, and the
  // copy strings it picked. The renderer reads renderRoute to dispatch
  // to HTML Gen (Feed) or Veo (Reels). All fields default to null /
  // empty so legacy Ad rows continue to read as before.
  //
  //   conceptId        — Director-emitted concept_id (string, stable per round)
  //   conceptArtifactId— FK to the CreativeDirectionArtifact this concept lives on
  //   mediaIds         — full set of seeded mediaIds the concept uses (collage,
  //                      storyboard, grid, etc.). mediaId above stays populated
  //                      with the "primary" / hero media so existing read paths
  //                      that project mediaId keep working.
  //   judgeRank        — 1..N rank within its Director round (1=best). Null until
  //                      Judge runs.
  //   judgeScore       — 0..1 composite score from the Judge. Null until scored.
  //   generationOrder  — which Generate-press round drained this Ad to render.
  //                      Null while queued; populated when the renderer claims it.
  //   renderRoute      — 'html_gen' (Feed) | 'veo' (Reels). Derived at queue time
  //                      from platformFormat; renderer dispatches on this.
  conceptId:          { type: String, default: null, index: true },
  conceptArtifactId:  { type: mongoose.Schema.Types.ObjectId, ref: 'CreativeDirectionArtifact', default: null, index: true },
  mediaIds:           { type: [mongoose.Schema.Types.ObjectId], ref: 'Media', default: [] },
  // Operator's explicit reference-image stack IN SELECTION ORDER for
  // deterministic video ads (position 0 = primary seed). Empty ⇒ render
  // falls back to default hero + feed-order alts (buildReferenceImages).
  // Distinct from mediaIds (Director concept media picks / full set).
  referenceMediaIds:  { type: [mongoose.Schema.Types.ObjectId], ref: 'Media', default: [] },
  judgeRank:          { type: Number, default: null, index: true },
  judgeScore:         { type: Number, default: null },
  generationOrder:    { type: Number, default: null },
  renderRoute: {
    type:    String,
    enum:    ['html_gen', 'veo', null],
    default: null,
    index:   true
  },

  // ── Lifecycle ────────────────────────────────────────────────────
  status: {
    type:     String,
    enum:     ['queued', 'rendering', 'draft', 'live', 'archived', 'failed'],
    default:  'queued',
    required: true,
    index:    true
  },

  // Operator approval flag — orthogonal to `status` (which tracks the
  // render lifecycle). Flipped via PATCH /api/ads/:id/approve on the
  // Product Ads page. Drives the Draft / Approved / Exported grouping
  // in the inline expansion (combined with metaSyncStatus for Exported).
  // Indexed so the future "approved-only" / "export-ready" lists are fast.
  approved:    { type: Boolean, default: false, index: true },
  approvedAt:  { type: Date,    default: null },
  approvedBy:  { type: String,  default: null },

  // ── Regenerate-with-prompt (Phase 2.5) ───────────────────────────
  // regenerating: true while a regen worker is running on this ad.
  //               The endpoint refuses to start a second regen until
  //               this clears. UI polls /api/catalog/:id/ads-detail
  //               every 5s watching this flag.
  // regenerationStage: where the worker is in the pipeline. UI shows
  //               a friendly label per stage. null when not running.
  //                 'pending'    — worker scheduled, not started yet
  //                 'veo'        — Veo image-to-video in flight
  //                 'chrome'     — GPT chrome HTML being generated
  //                 'composite'  — Puppeteer frame capture + ffmpeg
  //                 'image-gen'  — Image-ad HTML Gen + Puppeteer screenshot
  //                 'image-ref'  — gpt-image-1 photoreal polish (shadow)
  //                 'done'       — completed; cleared to null shortly after
  //                 'failed'     — see regenerationHistory[-1].error
  // regenerationHistory: capped at 5 entries; oldest dropped on push.
  //               Operator can re-enter a prior prompt from the modal.
  regenerating:      { type: Boolean, default: false, index: true },
  regenerationStage: { type: String,  default: null },
  regenerationHistory: {
    type: [{
      _id:         false,
      prompt:      String,
      mode:        { type: String, enum: ['light', 'full'] },  // light = chrome-only re-comp; full = re-run pipeline
      requestedBy: String,
      videoModel:  String,   // per-run model override from the regenerate dropdown (null = brand/product default)
      // true when this run used a verbatim prompt-text override (operator
      // edited the exact prompt in the Generation Details modal) rather
      // than the refinement-note path. The full text lives on the
      // AiCanvasArtifact (htmlPromptSystem/htmlPromptUser), not here.
      rawPromptEdit: { type: Boolean, default: false },
      at:          Date,
      status:      { type: String, enum: ['pending', 'done', 'failed'] },
      error:       String,
      durationMs:  Number
    }],
    default: []
  },

  // Ad-gen microservice handoff for REGENERATE (routing fix, 2026-08-26).
  // Mirrors the claimedByWorker/claimedAt pattern above, one level up: that
  // pair claims a MINT-time render; this pair claims a REGENERATE request.
  //
  // regenerationRequest: non-null ONLY when the backend decided (at request
  // time, reading isAdgenRendererEnabled() once, synchronously) to DEFER this
  // regenerate to adgen rather than run it in that process. This is the
  // single bit that decides who executes the work — NOT `regenerating`,
  // which is shared by both backend's local-execution path
  // (ADGEN_RENDERER_ENABLED false) and the deferred path, and NOT
  // `regenerateClaimedByWorker` alone, which starts null on every regenerate
  // regardless of path. The backend's local path NEVER writes this field, so
  // this repo's regenerate-consumer claim query
  // (regenerationRequest:{$type:'object'}) can never pick up a row the backend is
  // already executing in-process. $type, not $ne:null — Mongo's $ne matches
  // documents that do not contain the field at all, which is every
  // pre-migration ad and every locally-executed regenerate. Cleared by
  // markComplete alongside `regenerating`. See services/regenerateConsumer.js
  // (claim) and services/adRegenerateService.js runClaimedRegeneration
  // (execution).
  regenerationRequest: { type: mongoose.Schema.Types.Mixed, default: null },
  // Which regenerate-consumer worker (if any) has claimed a deferred
  // regenerationRequest. NULL while queued for adgen but not yet claimed.
  // A worker atomically claims by findOneAndUpdate({regenerating:true,
  // regenerationRequest:{$type:'object'}, regenerateClaimedByWorker:null},
  // {$set:{regenerateClaimedByWorker, regenerateClaimedAt}}) — same shape as
  // the mint-time claim above, on a DISJOINT filter so it can never race the
  // mint-time claim (status:'rendering' + claimedByWorker) for the same
  // document. Cleared by markComplete.
  regenerateClaimedByWorker: { type: String, default: null, index: true },
  regenerateClaimedAt:       { type: Date,   default: null },

  // sha256 over identity inputs (campaignId, productId, mediaId,
  // template, aspectRatio, variantKind, paletteSource, ctaText,
  // ctaUrl, ctaUrlParams, rafflePrizeMediaId). Computed at queue time;
  // unique per campaign.
  identityDigest: { type: String, required: true, index: true },

  // THE RELEASED DIGEST of an archived, never-billed row. Null on every other
  // ad. Written ONLY by services/adArchiveDigest.js.
  //
  // WHY. The (campaignId, identityDigest) unique index is not partial —
  // partialFilterExpression cannot express `status != 'archived'` — so an
  // archived row occupied its identity slot forever. Video digests
  // deliberately omit generationRunId (CLAUDE.md §2: that omission is THE
  // money guard against a repeat Generate re-billing a paid Omni master), so
  // an archived never-billed video could never be re-minted: insertMany hit
  // 11000, swallowed it, and the crop simply never appeared.
  //
  // On archive, a row proven receipt-free with no renderUrl has its digest
  // moved HERE and `identityDigest` replaced with `archived:<_id>` — unique by
  // construction. On restore the move is reversed. A row holding a spend
  // receipt or a renderUrl is archived WITHOUT releasing anything: the index
  // exists to protect PAID identities and that protection is untouched.
  //
  // MUST STAY DECLARED. Mongoose strict mode silently drops writes to
  // UNDECLARED paths (CLAUDE.md §4 — this repo already lost
  // renderError.predictionId that way). If this declaration is removed the
  // tombstone still lands, the original digest does NOT, and the ad becomes
  // unrestorable. Pinned by scripts/verifyArchiveDigestRelease.js.
  preArchiveIdentityDigest: { type: String, default: null },

  // DURABLE "this row has been in status:'rendering' and came back" marker.
  // Written by every rendering→queued REQUEUE site, as part of that site's own
  // awaited write. Never cleared.
  //
  // ⚠️ WHY IT EXISTS, and why renderStage could not do this job. Providers
  // charge at SUBMIT and services/spendReceipt.js's receipt is written AFTER
  // the POST returns, so a genuinely-billed ad is receipt-free for one HTTP
  // round-trip. If the process is SIGKILLed inside that window the row is
  // requeued to 'queued' by the reaper / orphan-persist / a crash handler and
  // then looks pristine: receipt-free, renderAttempts 0 (that counter is
  // $inc'd when a render ENDS, not when it starts), and status no longer
  // 'rendering'. Releasing such a row's identityDigest on archive would let a
  // later Generate re-mint and RE-BUY a master we already paid for.
  //
  // `renderStage` is NOT a sufficient guard: services/adStage.js is
  // fire-and-forget BY CONTRACT (never awaited, errors swallowed), so the
  // breadcrumb can simply be missing — and routes/ads.js's CAS-lost release
  // deliberately NULLS it. This field is set by awaited writes on the requeue
  // path itself, so it survives exactly the crash that loses the other two.
  //
  // A mint leftover that was never claimed never enters 'rendering', so this
  // stays false and its digest is still releasable — the archive fix's whole
  // purpose survives. Pinned by scripts/verifyArchiveDigestRelease.js, which
  // scans for the requeue sites rather than hardcoding them.
  //
  // MUST STAY DECLARED — Mongoose strict silently drops writes to undeclared
  // paths (CLAUDE.md §4), which would make every requeue site a no-op here and
  // reopen the hole invisibly.
  wasRendering: { type: Boolean, default: false },

  // For raffle campaigns with multiple prize media (Option B per-media
  // variants), this stamps WHICH prize Media this ad's render should
  // use as its hero. Null on non-raffle ads. The first prize media
  // selected by the operator is "canonical" (renders first in the
  // detail strip + non-rendered contexts); the rest each get their
  // own ad variant per (template × ratio × paletteSource).
  rafflePrizeMediaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Media', default: null, index: true },

  // ── Render output (all null until render lands) ──────────────────
  kind:               { type: String, enum: ['image', 'video'], default: 'image' },
  // Stamped at render time from sourceMedia.fileType. Distinct from
  // kind: kind reflects what SHIPPED ('image' even on a static-on-video
  // fallback), sourceFileType reflects what the seed Media WAS. Used
  // by the UI to suppress POLISHING badges for video-source ads that
  // fell back to static — image-ref correctly skips video sources, so
  // photorealUrl never lands and the badge would otherwise stay on
  // forever.
  sourceFileType:     { type: String, enum: ['image', 'video', null], default: null },
  veoVideoUrl:        { type: String, default: null },  // raw base video from the AI model (before brand-script chrome)
  // Which Atlas model actually rendered this ad's base video (audit
  // trail for the per-brand/per-product/per-canvas resolution chain —
  // see atlasVideoService.resolveVideoModel). Null for video ads whose
  // base came from a Cloudinary segment extract (no model ran) and for
  // ads rendered before this field existed.
  veoModel:           { type: String, default: null },
  // DERIVE-ONLY marker. When set, this ad's base plate is CROPPED FROM the
  // sibling master ad named here — it is NOT its own Omni generation and must
  // never reach a billable submit (routes/ads.js `renderDeriveOnlyVideoAd`).
  // Today:
  //   - `pmax_video_1_1` (source `pmax_video_9_16`)
  //   - funnel-variant ads (source = the paid master of the same surface)
  //   - Meta `meta_feed_1_1` / `meta_feed_4_5` / `meta_reels_9_16`
  //     (source `meta_stories_9_16`) — added 2026-08-11
  //
  // ⚠️ MONEY. Every family has a second gate, but they discriminate differently
  // — do not read one rule for all three.
  //   PMax square   — `platformFormat === 'pmax_video_1_1'` is enough: that
  //                   surface was NEVER a legitimate billable master.
  //   Funnel rows   — `funnelStage` set is enough, same reasoning.
  //   Meta crops    — the format ALONE is not enough, because
  //                   meta_feed_1_1 / 4_5 / reels WERE their own paid masters
  //                   before 919627a0, so historical rows exist that bought
  //                   their own plate. The discriminator is `veoPredictionId`,
  //                   the spend RECEIPT: it is set only when THIS ad submitted
  //                   to Omni, and a derivation never submits. Absent receipt
  //                   ⇒ derivation (free); receipt present ⇒ legacy master,
  //                   keep the billable path.
  //
  // An earlier version of this comment asserted the Meta surfaces "have no
  // such second gate, and cannot". That was wrong — it assumed the format was
  // the only available signal. Pinned by scripts/verifyMixedPlatformVideo.js
  // H3 (the mint carries the marker), I5 (a marker-less crop fail-closes) and
  // I6 (a receipted legacy row does not).
  // Declared so Mongoose strict mode persists the marker.
  deriveFromMaster:   { type: String, default: null },
  // Funnel-stage retitle (PMax AND Meta video). When set, this Ad is a
  // FREE Remotion re-title of an already-paid master plate (or of a free
  // derive plate). PMax uses remotion/presets/canonical-<stage>-pmax10.json;
  // Meta uses the generic 8s canonical-<stage>.json. Absent/null = the
  // unstaged row, which IS awareness — masters never carry a stage, so
  // their identity digest stays byte-identical to every pre-existing
  // row. NEVER billable on its own — routes via resolveDeriveFromMaster
  // → renderDeriveOnlyVideoAd.
  funnelStage: {
    type:    String,
    enum:    ['awareness', 'consideration', 'conversion', null],
    default: null
  },
  // Aspect ratio the model actually rendered (may differ from
  // ad.aspectRatio when the model didn't support the canvas aspect
  // natively and we had to remap). Composite skips its saliency-crop
  // transform when this matches the canvas aspect — same source, no
  // transcode, no 423 race.
  veoAspectRatio:     { type: String, default: null },
  veoPrompt:          { type: String, default: null },  // storyboard prompt sent to Veo — preserved for debugging + reproduction
  // The provider's prediction id, persisted IMMEDIATELY after the billable submit
  // succeeds — before polling starts.
  //
  // This is a SPEND RECEIPT, not telemetry. Previously the id lived only as a local
  // variable inside generateForAd, so a web-process death between submit and
  // completion (deploy, autoscale replacement, OOM) lost it: Atlas was generating a
  // video we had paid for, with no handle to reclaim it, and the orphan reaper would
  // flip the ad back to 'queued' so the next run submitted AGAIN. That is a guaranteed
  // double charge, ~$1.00 a time. Not hypothetical here — Render's SIGKILL lands after
  // a 300s drain window while MAX_POLL_MS is 10 minutes, so an in-flight poll cannot
  // be drained cleanly.
  //
  // Persisting it makes the orphan reconcilable: a restart can poll this id and finish
  // the ad instead of re-submitting. Nothing consumes it that way YET — that resume
  // path belongs with the render-queue move (ARCHITECTURE_REVIEW.md "The render-queue
  // architecture problem"). Until then it is the audit trail that turns a silent
  // double-bill into a visible orphan.
  veoPredictionId:    { type: String, default: null },
  // Face-safe base-plate crop + face keep-out cache, computed by
  // services/basePlateCropService.js before Remotion titling. Shape:
  // { version, format, sourceUrl, videoUrl|null, rect?, sourceW?, sourceH?,
  //   frames?, faceHits?, envelope?, faceSamples?, facesComputed?, reason?, computedAt }.
  //   videoUrl non-null -> the liveness-probed Cloudinary c_crop derivative titling consumes
  //   videoUrl null     -> a persisted SKIP (reason says why) so re-titles don't re-pay detection
  //   faceSamples/envelope/facesComputed -> vision boxes (SOURCE fractions 0..1) reused by
  //     title keep-out (applyFaceKeepOut) so a second detect is never paid for the same master
  // BINDING INVARIANT: only honoured when sourceUrl === the ad's CURRENT veoVideoUrl — a
  // regenerated base video must never ship a crop of footage the operator replaced. The consumer
  // (basePlateCropService.resolveBasePlateVideoUrl / ensureFaceDetectionForKeepOut) enforces
  // this; anything that rewrites veoVideoUrl can leave this stale without harm, but SHOULD clear
  // it to save a wasted lookup.
  basePlate:          { type: mongoose.Schema.Types.Mixed, default: null },
  veoReferenceImages: { type: [String], default: [] },  // exact reference-image stack sent to the model (pos 0 = seed, then product hero + alts) — for the generation inspector
  // GPT-composed structured storyboard. Null when VEO_USE_GPT_STORYBOARD
  // is off or the GPT call failed (Veo prompt then carries the legacy
  // hardcoded storyboard instead). Stored as Mixed so the shape can
  // evolve without a migration.
  veoStoryboard:      { type: mongoose.Schema.Types.Mixed, default: null },
  // chromeHtml + chromeVersion held the HTML/Puppeteer overlay from the
  // retired chrome pipeline. Kept nullable + read-only for legacy ads
  // rendered before the brand-script system landed; no code writes them
  // anymore. Safe to drop in a schema-migration pass once no ads with
  // populated values remain in active campaigns.
  chromeHtml:         { type: String, default: null },
  chromeVersion:      { type: String, default: null },
  renderUrl:          { type: String, default: null },
  // Per-AD (per-video) titling override — top of the resolution cascade
  // (ad > product > category > brand > preset > canonical, see titleSpecService.
  // resolveSpec). Same per-format shape as Brand.titleStyleSpec. Written by
  // the per-video Title Studio when the operator saves scope "this ad";
  // null = inherit product/brand. DISTINCT from titlingSnapshot below (that
  // is a read-only render-time audit copy, NOT a source of truth). Mixed →
  // callers MUST markModified('titleStyleSpec').
  titleStyleSpec:     { type: mongoose.Schema.Types.Mixed, default: null },
  // Operator INPUT fields for video prompt — distinct from the render-time
  // audit outputs veoPrompt / veoModel above. Guidance merges into
  // buildVeoPrompt as the operatorPrompt prepend; raw fully replaces the
  // canonical prompt (bypasses buildVeoPrompt). Most-specific cascade also
  // reads product/category/brand videoSettings.promptGuidance when these
  // are null (see atlasVideoService.resolvePromptGuidance).
  videoPromptGuidance: { type: String, default: null },
  videoPromptRaw:      { type: String, default: null },
  // Snapshot of the EXACT resolved titling used for the last render —
  // { engine, format, spec?, meta, capturedAt }. buildMetaForAd is
  // otherwise recomputed at view time from ad.copy + LayoutInputArtifact +
  // Brand (which drift), so this gives the generation-inspector byte-exact
  // historical titling. Written by brandScriptExecutor at render time.
  titlingSnapshot:    { type: mongoose.Schema.Types.Mixed, default: null },
  // Font resolution audit. DEAD as of 2026-07-31 for new ads — it was produced
  // only by the retired direct-image-with-overlay renderer, which composited
  // headline/subheadline text locally and so had a font to resolve. The
  // current direct_image path lets the model typeset its own copy and never
  // calls fontResolverService. Kept, not removed: still populated on ads
  // rendered before the rewrite, and the inspector still reads it (routes/ads.js)
  // so those historical ads keep their real diagnostic. Null on every ad
  // rendered after 2026-07-31 is expected, not a regression.
  // { heading/body: { requestedFamily, resolvedFamily, source, exact } }
  fontResolution:     { type: mongoose.Schema.Types.Mixed, default: null },
  // Verbatim audit of the image-model request, captured at submit time from
  // the POST body itself (atlasImageService.buildSubmissionRecord):
  // { provider, model, predictionId, submittedAt, prompt, size, quality,
  //   imageCount, images: [{ position, submittedUrl, sourceUrl, role }],
  //   pipeline, stage }. `pipeline` is the delivering render path
  //   ('direct_image' | the retired 'direct_overlay' on historical ads) —
  //   read this, not a guess, when asking "which path made this ad".
  // The generation inspector renders ONLY this — it must never reconstruct a
  // plausible-looking stack, because a diagnostic that shows what should have
  // been sent instead of what was sent silently misdirects every diagnosis
  // built on it. Null on renders that predate this capture; the inspector
  // says so rather than guessing.
  imageGeneration:    { type: mongoose.Schema.Types.Mixed, default: null },
  // Which intent ran and what it did with the data it was given — the
  // provenance a debugging session actually needs, added 2026-07-31 alongside
  // the direct_image rewrite: { surface, requested, delivered, fellBackFrom,
  // renderedRoles[], droppedRoles[], generateSize, logoComposited }.
  // `delivered !== requested` means the data couldn't support the requested
  // intent (e.g. no rating) and the resolver walked down the hierarchy — that
  // is working as designed, not a fault. Null on every ad that predates this
  // field (including the legacy HTML/overlay paths, which never resolved an
  // intent) and on any ad that failed before the intent was built.
  intentResolution:   { type: mongoose.Schema.Types.Mixed, default: null },
  // Post-render vision QC verdict (static direct-image path only).
  // { schemaVersion, skipped, disabled, passed, finalAttempt, maxRegenerations,
  //   regenerationCount, attempts:[{ attempt, pass, categories, findings,
  //   summary, renderUrl, discarded, discardedRenderUrl, imageGeneration }] }.
  // `regenerationCount` added 2026-08-26 — how many times the LLM was
  // re-invoked. Persisted so DB analytics can measure regen success/failure
  // rates without deriving from attempts.length. Legacy rows with the field
  // absent should read as null-not-zero (no regen data available), not "0
  // regens".
  // Per-attempt renderUrl is KEPT when discarded — the first render was
  // already paid for (mirrors Omni master keep on titling failure).
  // Null when AD_VISION_QC_ENABLED is off or the ad predates this field.
  visionQc:           { type: mongoose.Schema.Types.Mixed, default: null },
  // Per-stage wall time in ms for THIS render, whichever pipeline ran.
  //
  // Legacy shape (kept for existing readers): { deriveMs, renderMs, uploadMs }.
  //
  // Planned expansion (2026-08-26, Phase 0 of the wall-time reduction plan):
  //   {
  //     layoutInputMs,      // buildLayoutInput cold LLM call (Phase 2 target)
  //     quoteSnippetMs,     // quoteSnippet LLM (Phase 2 cross-process cache target)
  //     sharpMs,            // reference decode + Sharp composite (Phase 3 worker_threads target)
  //     atlasSubmitMs,      // Atlas submit+poll wall (external — baseline)
  //     visionQcMs,         // Vision QC LLM call (Phase 2/4 target)
  //     remotionMs,         // Chrome + ffmpeg (Phase 3 Chrome-pool target)
  //     titlerPickupWaitMs, // renderer handoff → titler claim (validates backpressure)
  //     ...legacyKeys       // deriveMs, renderMs, uploadMs still emitted
  //   }
  //
  // Callers use `services/stageTiming.stampStageTiming(adId, stage, ms)` —
  // fire-and-forget, non-blocking, silently swallows write errors. Instrumentation
  // lands with each Phase 2/3 change that needs to measure the stage it touches;
  // this field is the foundation, not a big-bang instrumentation PR.
  //
  // Answers "why is this ad slow" without a log-diving session — Atlas submit
  // is normally 60-150s for static; a value far outside that on a specific ad,
  // not the whole pipeline, points at that one Atlas call rather than at the
  // code. Null on ads that predate this field or that raced past instrumentation.
  renderStages:       { type: mongoose.Schema.Types.Mixed, default: null },
  // LIVE per-ad stage, e.g. 'director' | 'master video generation' |
  // 'titling 9:16' | 'cropping 4:5' | 'uploading'. Updated as the render
  // progresses and left at its final value afterwards, so a finished or failed
  // ad still says where it got to.
  //
  // Deliberately PER-AD and not the OperationRun's `stage`. That field is
  // run-level, and with RENDER_CONCURRENCY/VEO_CONCURRENCY > 1 several ads
  // render at once, so the run's stage is whichever ad wrote last — useless for
  // answering "what is THIS asset doing". The whole point of this field is that
  // an operator can read a specific assetId's state without asking someone to
  // grep the logs.
  //
  // Never load-bearing: it is written fire-and-forget and a failed write is
  // swallowed. Telemetry must not be able to fail a paid render.
  renderStage:        { type: String, default: null },
  renderStageAt:      { type: Date, default: null },
  //
  // TITLING RESUME state — services/titlingResumeService.js. 'pending' = a paid
  // master was recovered from its spend receipt and still needs titling;
  // 'claimed' = a web instance is titling it now; null = nothing owed.
  //
  // WHY THIS IS ITS OWN DECLARED FIELD AND NOT A renderStage SENTINEL. The first
  // version of the resume encoded this state in `renderStage`, on the reasoning
  // that reusing an existing field avoids the Mongoose-strict trap where a write
  // to an UNDECLARED path is silently dropped (this repo already lost
  // renderError.predictionId that way). That was wrong: `renderStage` is owned by
  // services/adStage.js, which `$set`s it unconditionally (adStage.js:82-85) and
  // is called throughout titling (brandScriptExecutor.js:1200/1306/1332). So the
  // sentinel was overwritten seconds into the render, and an ad whose render then
  // crashed could never be re-swept — the exact leak the resume exists to close.
  // Declaring the field here is what makes the write safe; the silent-drop trap is
  // about UNdeclared paths, not about new fields. Pinned by
  // scripts/verifyTitlingResume.js (asserts this declaration exists, so the field
  // cannot be used without being declared).
  titlingResumeState: { type: String, enum: ['pending', 'claimed', null], default: null },
  // Handoff marker for out-of-process titling (adgen-titler role).
  // Stamped `true` by the adgen renderer atomic with (veoVideoUrl set +
  // claim release) when ADGEN_TITLER_ENABLED=true; the titler service polls
  // for {status:'rendering', veoVideoUrl:{$ne:null}, titlingNeeded:true,
  // claimedByWorker:null}, claims, does Remotion titling, and clears this
  // field on terminal stamp. Under strict mode an undeclared field would
  // vanish on save (see titlingResumeState note above) — declared so the
  // write actually persists. Existing rows carry undefined which doesn't
  // match `titlingNeeded: true`, so a flag-off deploy shifts nothing.
  titlingNeeded:      { type: Boolean, default: false },
  posterUrl:          { type: String, default: null },
  // Sparse index — queued ads carry null, only rendered ads contribute.
  cloudinaryPublicId: { type: String, default: null, index: { sparse: true } },
  width:              { type: Number, default: null },
  height:             { type: Number, default: null },
  bytes:              { type: Number, default: null },
  durationMs:         { type: Number, default: null },

  // Render diagnostics. renderError is populated when status='failed';
  // renderAttempts counts every attempt that STARTED a render (submit/
  // generation actually reached), regardless of outcome — a wait-only cycle
  // (a derive-only video ad polling for its sibling master, never submitting
  // anything) counts on deriveWaitAttempts below instead, not here.
  renderError: {
    message: { type: String },
    stage:   { type: String },
    at:      { type: Date },
    // RECOVERY HANDLE. Atlas bills image generation on submit and retains the
    // prediction for days, so a render that failed AFTER a successful submit is
    // an image we have already paid for and can still fetch.
    //
    // These three were being written by routes/ads.js and renderService.failed()
    // but were NOT declared here, so mongoose's default strict mode silently
    // dropped them on every save — the write looked fine and stored nothing.
    // Every failed-but-charged render was unrecoverable, and "did this cost us
    // money?" was unanswerable from the Ad doc.
    predictionId: { type: String, default: null },
    // Whether the provider had already billed when this failed. Drives the
    // double-spend warning and the reclaim sweep.
    //
    // ⚠️ TWO-STATE, AND THAT IS THE POINT: `true` means WE KNOW it was charged.
    // It does NOT mean `false` is "free" — see chargeState below.
    charged:      { type: Boolean, default: false },
    // The HONEST answer, added 2026-08-05, because `charged` alone could not
    // tell "definitely not billed" from "we have no idea".
    //
    // atlasErrorPolicy's FALLBACK carries `charged: null` — UNKNOWN — for any
    // failure shape it cannot classify, which is exactly what a bare Cloudflare
    // 502 mid-poll looks like. renderService then wrote `err.charged === true`,
    // collapsing that null to FALSE. So two ads that failed that way on
    // 2026-08-05 are on record as costing nothing when Atlas may well have
    // billed them — and understating the ledger is the one direction it can
    // never be corrected in, because nothing knows to go looking.
    //
    // 'unknown' is not a resting state: services/imageRecoveryService
    // settleChargeState() reads `price` back off the settled prediction (a free
    // GET, and Atlas keeps predictions 30 days) and moves it to 'charged' or
    // 'not-charged' with the real figure. Null on rows written before this
    // existed — absence means "never assessed", not "not charged".
    chargeState:  { type: String, enum: ['charged', 'not-charged', 'unknown', null], default: null },
    // Provider's own error code (Atlas envelope `code`), e.g. 402 insufficient
    // balance — kept so a billing rejection is distinguishable from a timeout.
    atlasCode:    { type: Number, default: null },
    // OUR stable classification (services/atlasErrorPolicy.js IMAGE_* codes —
    // IMAGE_MODERATION_BLOCKED, IMAGE_RATE_LIMITED, ...), added 2026-08-19.
    // Distinguishes "the image model's own safety filter rejected this input,
    // identical retry is futile" from every other render failure, which used
    // to reach an operator as one more generic `renderError.message` with no
    // way to tell content-policy from a bug or an outage without reading the
    // raw text. Declared here for the same reason atlasCode/chargeState are —
    // Mongoose strict mode silently drops an undeclared path on write.
    code:         { type: String, default: null },
    // CHILD STDERR/STDOUT TAILS. remotionChildSupervisor attaches these
    // onto the thrown Error so a `remotion child exited code=1 signal=none`
    // failure still names WHY. They were being written onto renderError
    // and then SILENTLY DROPPED — same trap as predictionId above. Without
    // the declaration, a live production titling failure is undiagnosable
    // from the Ad doc (and the parent log line does not carry the tail
    // either). Persist-side clip lives in services/renderErrorFields.js
    // (8 KiB stderr keep-start / 2 KiB stdout keep-end; NULs stripped).
    stderrTail:   { type: String, default: null },
    stdoutTail:   { type: String, default: null }
  },
  renderAttempts: { type: Number, default: 0 },
  // TITLING-SPECIFIC attempt ceiling — distinct from renderAttempts (which
  // counts the outer submit/generation attempt, not the Remotion titling
  // step nested inside it). brandScriptExecutor's stampTitlingFailureAndThrow
  // $incs this on EVERY titling failure (OOM, timeout, or a generic child
  // exit/exception) before deciding resumable vs terminal, and the SAME
  // counter is shared by a later resume attempt (titlingResumeService calls
  // the identical function), so the ceiling holds across both the original
  // renderer attempt and every retry. Exists because "stamp every titling
  // failure resumable" would otherwise retry a DETERMINISTIC failure (a
  // malformed spec, a missing asset, a serialization bug that throws
  // identically every time — see the ObjectId-Buffer bug fixed nearby)
  // forever: an unbounded retry on a path that already charged for the
  // master is worse than the stranding it replaces. Past
  // TITLING_ATTEMPTS_MAX (default 3, env-overridable) the ad goes terminal
  // (status:'failed') instead of resumable — the master itself is NEVER
  // deleted, so nothing paid for is lost, only the automatic retry stops.
  // MUST STAY DECLARED — Mongoose strict mode silently drops writes to
  // undeclared paths (see titlingResumeState note above); an undeclared
  // counter here would make the cap a no-op and reopen an infinite retry.
  titlingAttempts: { type: Number, default: 0 },
  // A FREE derive-only video ad (deriveFromMaster set) waits IN-RENDER for
  // its sibling master's plate (renderDeriveOnlyVideoAd, routes/ads.js) and
  // requeues to 'queued' if the wait expires — it never submits anything,
  // never bills. That requeue used to $inc renderAttempts, which meant a
  // wait-only ad looked identical to one that had genuinely rendered and
  // failed. services/queuedArchiveSweeper's `renderAttempts:0` guard exists
  // specifically to prove "this row never started, never billed" before
  // archiving a leftover queued ad — so a derive-wait ad that merely polled
  // and requeued became permanently invisible to that sweeper (renderAttempts
  // > 0 forever) even though it started nothing and cost nothing. Declared
  // here so the write is not silently dropped by Mongoose strict mode (see
  // the titlingResumeState note above — undeclared paths vanish on save).
  // renderAttempts keeps meaning "actual render attempts"; this field is the
  // ONLY thing the derive-wait loop increments.
  deriveWaitAttempts: { type: Number, default: 0 },

  // ── Copy snapshot — filled at render time ────────────────────────
  // Cached resolution of the LayoutInputArtifact's derived copy so
  // the ads page list doesn't have to round-trip the artifact for
  // every row. Null while queued.
  copy: {
    headline:     { type: String, default: null },
    cta_text:     { type: String, default: null },
    quote:        { type: String, default: null },
    productName:  { type: String, default: null },
    productPrice: { type: String, default: null }
  },

  // ── CTA (operator-provided, set at queue time) ───────────────────
  ctaText:      { type: String, default: '' },
  ctaUrl:       { type: String, default: '' },
  ctaUrlParams: { type: String, default: '' },

  // ── Meta Ads sync (push-back to Meta Marketing API) ─────────────
  // Populated by services/metaAdsPushService when the operator pushes
  // a rendered Ad to a connected Meta ad account. status='synced'
  // means the Ad lives on Meta as a PAUSED ad; 'failed' preserves the
  // last error message. Re-pushing to a different AdSet overwrites
  // these fields (the prior Meta Ad is left in place — operator can
  // delete from Ads Manager).
  metaAdId:          { type: String, default: null, index: { sparse: true } },
  metaAdCreativeId:  { type: String, default: null },
  metaAdsetId:       { type: String, default: null, index: { sparse: true } },
  metaCampaignId:    { type: String, default: null },
  metaAdAccountId:   { type: String, default: null },
  metaPageId:        { type: String, default: null },
  metaSyncStatus:    { type: String, enum: ['synced', 'failed', null], default: null, index: { sparse: true } },
  metaSyncError:     { type: String, default: null },
  metaSyncedAt:      { type: Date,   default: null },

  // ── Timing ───────────────────────────────────────────────────────
  queuedAt:    { type: Date, default: Date.now },
  renderedAt:  { type: Date, default: null },
  // generatedAt kept as the legacy "this ad first existed" timestamp.
  // For the new flow it equals queuedAt; existing readers that order
  // by generatedAt still work.
  generatedAt: { type: Date, default: Date.now },
  createdAt:   { type: Date, default: Date.now },
  updatedAt:   { type: Date, default: Date.now }
}, {
  timestamps: false
});

// Dedup at queue time. Same campaign + identity = skip the insert.
// Per-campaign unique — different campaigns can hold the same combo
// (an intentional duplicate from a separate operator action).
adSchema.index({ campaignId: 1, identityDigest: 1 }, { unique: true });

// Selection query — "next N queued ads for this campaign, ranked by
// readiness." Drives the render loop's pick.
adSchema.index({ campaignId: 1, status: 1, readinessScore: -1 });

// Run audit — "what did run X render?" Multi-key index over the array.
adSchema.index({ campaignRunIds: 1, status: 1 });

// Ads-page filtered listings (kept).
adSchema.index({ brandId: 1, status: 1, generatedAt: -1 });
adSchema.index({ campaignId: 1, generatedAt: -1 });

adSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('Ad', adSchema);
