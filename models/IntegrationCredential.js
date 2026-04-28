// Per-Brand external-platform credential. Today only Meta/Instagram; the
// `type` enum lets us add TikTok, YouTube, Shopify etc. without a second
// model. Token bytes are AES-256-GCM encrypted at rest — see
// integrationCryptoService — so a DB dump alone never exposes a usable
// access token.
//
// Each Brand can hold at most one ACTIVE credential per type (compound
// unique index below limited to status='active'). Disconnecting marks
// the row status='revoked' and preserves it for audit; a fresh connect
// inserts a new active row.

const mongoose = require('mongoose');

const integrationCredentialSchema = new mongoose.Schema({
  advertiserId: { type: mongoose.Schema.Types.ObjectId, ref: 'Advertiser', required: true, index: true },
  brandId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Brand',      required: true, index: true },

  type:   { type: String, enum: ['instagram', 'meta-ads', 'google-ads'], required: true },
  // 'pending' = token captured but the user hasn't picked which Page /
  // IG Business account / catalog to bind yet (V2.5 picker flow).
  // Pending rows skip sync and the partial-unique-active index.
  status: { type: String, enum: ['active', 'revoked', 'expired', 'pending'], default: 'active', index: true },

  // Encrypted access token blob: { iv, authTag, ciphertext } base64
  // strings. Decryption happens only inside services that actually
  // call the upstream API; route handlers never see plaintext.
  accessTokenEnc: {
    iv:         { type: String, required: true },
    authTag:    { type: String, required: true },
    ciphertext: { type: String, required: true }
  },
  // Long-lived token expiry (Meta returns ~60 days). Surfaced in the UI
  // so users know when they'll need to reconnect.
  expiresAt:    Date,
  scopes:       [String],

  // Provider-specific identifiers — populated at OAuth time when the
  // user granted us their primary IG/Page; sync flows in Phase B/D
  // can let the user pick a different one later if needed.
  igUserId:     String,    // Instagram Business Account ID (graph node)
  pageId:       String,    // Facebook Page that owns the IG account
  catalogId:    String,    // Selected product catalog (for Phase B sync)
  metaUserId:   String,    // The Meta user who granted the connection

  // Display fields cached from the OAuth handshake so the UI doesn't
  // need a fresh Graph call on every render.
  igUsername:   String,
  pageName:     String,

  // Generic per-platform identifiers + display fields. Shape varies
  // by type:
  //   meta-ads   → { adAccountId, adAccountName, accountIdNumeric, currency, timezone, businessId, businessName }
  //   google-ads → { customerId, customerName, managerCustomerId, currencyCode, timeZone }
  // Kept Mixed so each platform can evolve its identifier shape
  // without a schema migration.
  platformData: mongoose.Schema.Types.Mixed,

  // Audit trail
  connectedAt:  { type: Date, default: Date.now },
  connectedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  revokedAt:    Date,
  revokedBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  lastUsedAt:   Date,

  // Auto-sync timestamps (V2 #4) — populated by scheduledSyncService
  // so the next tick can decide whether each tier is due. Manual
  // syncs also touch these to avoid the scheduler immediately
  // re-running what the user just kicked off by hand.
  lastCatalogSyncAt:  Date,
  lastPostsSyncAt:    Date,
  // Ad Platforms Phase B-1 — populated by campaignSyncService.
  lastCampaignSyncAt: Date
});

// V2 #5 — multi-page support. Compound unique index on
// (brandId, type, igUserId) so a brand can hold more than one active
// IG credential but cannot connect the same IG account twice. Limited
// to IG rows so meta-ads / google-ads rows (which have null igUserId)
// don't false-match each other.
//
// MIGRATION NOTE: drop legacy indexes manually after deploying:
//   db.integrationcredentials.dropIndex("brandId_1_type_1")        // V1 → V2#5
//   db.integrationcredentials.dropIndex("brandId_1_type_1_igUserId_1") // V2#5 → Ad Platforms Phase A
integrationCredentialSchema.index(
  { brandId: 1, type: 1, igUserId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: 'active',
      type:   'instagram',
      igUserId: { $exists: true }
    }
  }
);

// Ad Platforms Phase A — meta-ads + google-ads each scoped on their
// own external account id (stored under platformData.adAccountId or
// platformData.customerId). One active credential per ad account
// per Brand; revoked rows excluded.
integrationCredentialSchema.index(
  { brandId: 1, type: 1, 'platformData.adAccountId': 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: 'active',
      type:   'meta-ads',
      'platformData.adAccountId': { $exists: true }
    }
  }
);
integrationCredentialSchema.index(
  { brandId: 1, type: 1, 'platformData.customerId': 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: 'active',
      type:   'google-ads',
      'platformData.customerId': { $exists: true }
    }
  }
);

module.exports = mongoose.model('IntegrationCredential', integrationCredentialSchema);
