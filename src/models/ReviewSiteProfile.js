// What we have learned about how ONE retailer's site exposes its reviews.
//
// Keyed by host, not by brand: the knowledge is a property of the storefront's
// architecture (how it names its review-app keys, which id its reviews are
// filed under), so it is reusable across every brand and every product on that
// host, and across worker restarts.
//
// Written by services/reviewSiteProfileService.learn() the first time a probe
// succeeds, read back before the next probe so products 2..N on the same store
// hit the right parameters on the first try. Seeded from
// services/reviewSiteProfiles.json for hosts we have already verified, so a
// fresh deploy starts knowing what we know.

const mongoose = require('mongoose');

const reviewSiteProfileSchema = new mongoose.Schema({
  // Storefront host, lowercased, no scheme: 'www.gap.com'.
  host: { type: String, required: true, unique: true, index: true },

  // Which review app the host runs — matches detectReviewPlatform()'s slugs.
  platform: { type: String, default: null },

  // HOW THE REVIEW ID IS DERIVED from what the page exposes. This is the
  // valuable part: on gap.com the PDP shows pid=130046042 but reviews are filed
  // under 130046, i.e. source='productID' with trim=3. Without it, every
  // product costs a handful of wasted probes — and a store whose ids need a
  // transform we never try looks review-less entirely.
  idSource: { type: String, default: null },   // 'productID' | 'sku' | 'urlPid' | 'canonical' | 'render'
  idTrim:   { type: Number, default: 0 },      // trailing chars removed from that id

  // Where tier 1 found structured data, when it did: 'json-ld' (script tag),
  // 'embedded' (escaped inside a JS/RSC payload), 'microdata'.
  ldSource: { type: String, default: null },

  // Free-form room for per-platform specifics a future adapter needs (e.g. a
  // Bazaarvoice deployment slug) without a migration.
  hints: { type: mongoose.Schema.Types.Mixed, default: null },

  // Provenance so a stale profile can be spotted and re-learned.
  learnedFrom:  { type: String, default: null },   // sample product URL
  reviewsSeen:  { type: Number, default: null },   // total the winning probe reported
  verifiedAt:   { type: Date,   default: Date.now },
  // 'seed' = shipped in the JSON file, 'learned' = discovered at runtime.
  origin: { type: String, enum: ['seed', 'learned'], default: 'learned' }
}, { timestamps: true });

module.exports = mongoose.models.ReviewSiteProfile ||
  mongoose.model('ReviewSiteProfile', reviewSiteProfileSchema);
