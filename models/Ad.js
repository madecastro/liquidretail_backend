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

  // ── Generation context ───────────────────────────────────────────
  template:     { type: String, required: true, index: true },
  aspectRatio:  { type: String, required: true },
  campaignKind: { type: String, default: null },                       // 'brand' | 'promotional' | 'product' | 'collection'

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

  // ── Lifecycle ────────────────────────────────────────────────────
  status: {
    type:     String,
    enum:     ['queued', 'rendering', 'draft', 'live', 'archived', 'failed'],
    default:  'queued',
    required: true,
    index:    true
  },

  // sha256 over identity inputs (campaignId, productId, mediaId,
  // template, aspectRatio, variantKind, paletteSource, ctaText,
  // ctaUrl, ctaUrlParams). Computed at queue time; unique per campaign.
  identityDigest: { type: String, required: true, index: true },

  // ── Render output (all null until render lands) ──────────────────
  kind:               { type: String, enum: ['image', 'video'], default: 'image' },
  renderUrl:          { type: String, default: null },
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
