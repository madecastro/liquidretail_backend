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
    enum:    ['meta_feed_1_1', 'meta_feed_4_5', 'meta_reels_9_16', 'meta_stories_9_16', 'pmax_16_9'],
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

  // sha256 over identity inputs (campaignId, productId, mediaId,
  // template, aspectRatio, variantKind, paletteSource, ctaText,
  // ctaUrl, ctaUrlParams, rafflePrizeMediaId). Computed at queue time;
  // unique per campaign.
  identityDigest: { type: String, required: true, index: true },

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
  // Face-safe base-plate crop, computed by services/basePlateCropService.js before Remotion
  // titling. Shape: { version, format, sourceUrl, videoUrl|null, rect?, sourceW?, sourceH?,
  // frames?, faceHits?, envelope?, reason?, computedAt }.
  //   videoUrl non-null -> the liveness-probed Cloudinary c_crop derivative titling consumes
  //   videoUrl null     -> a persisted SKIP (reason says why) so re-titles don't re-pay detection
  // BINDING INVARIANT: only honoured when sourceUrl === the ad's CURRENT veoVideoUrl — a
  // regenerated base video must never ship a crop of footage the operator replaced. The consumer
  // (basePlateCropService.resolveBasePlateVideoUrl) enforces this; anything that rewrites
  // veoVideoUrl can leave this stale without harm, but SHOULD clear it to save a wasted lookup.
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
  // Exact font resolution audit for the direct static-image path.
  // { heading/body: { requestedFamily, resolvedFamily, source, exact } }
  fontResolution:     { type: mongoose.Schema.Types.Mixed, default: null },
  posterUrl:          { type: String, default: null },
  // Sparse index — queued ads carry null, only rendered ads contribute.
  cloudinaryPublicId: { type: String, default: null, index: { sparse: true } },
  width:              { type: Number, default: null },
  height:             { type: Number, default: null },
  bytes:              { type: Number, default: null },
  durationMs:         { type: Number, default: null },

  // Render diagnostics. renderError is populated when status='failed';
  // renderAttempts counts every attempt regardless of outcome.
  renderError: {
    message: { type: String },
    stage:   { type: String },
    at:      { type: Date }
  },
  renderAttempts: { type: Number, default: 0 },

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
