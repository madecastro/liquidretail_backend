// Advertiser — top-level tenant. The customer organization using
// liquidretail (e.g. "Pelagic Gear, Inc." for a single-brand
// customer, or an agency like "WPP Bristol" managing multiple
// client brands).
//
// Owns:
//   - Users (members who can log in and operate the account)
//   - Brands (one or many — single-brand customers have 1, agencies
//     and multi-brand companies have N)
//   - Media + DetectRuns + all artifacts (via Brand → Media chain)
//
// Single-Advertiser-per-User to start. Multi-Advertiser membership
// (an agency user belonging to several client Advertisers) is a
// future migration via a separate AdvertiserMembership join table.

const mongoose = require('mongoose');

function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')   // strip accents
    .replace(/[^a-z0-9]+/g, '-')                          // non-alnum → dash
    .replace(/^-+|-+$/g, '')                              // trim dashes
    .slice(0, 64);
}

const advertiserSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  // URL-safe identifier — defaults to slugify(name) on first save if missing.
  // Stored unique so URLs / API paths can use it interchangeably with _id.
  slug: { type: String, required: true, unique: true, index: true, lowercase: true, trim: true },

  // Optional: who created this Advertiser (the founding user). Audit trail.
  // Not used for permissions today; teammate invites land via separate
  // membership records once Phase 4 ships.
  ownerEmail: { type: String, trim: true, lowercase: true },

  // Plan / status are placeholders for billing + lifecycle. Not enforced
  // anywhere yet — keeping the schema in place so future work doesn't
  // have to migrate.
  plan:   { type: String, enum: ['free', 'pro', 'agency', 'enterprise'], default: 'free' },
  status: { type: String, enum: ['active', 'suspended', 'archived'], default: 'active' },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

advertiserSchema.pre('validate', function (next) {
  if (!this.slug && this.name) this.slug = slugify(this.name);
  next();
});
advertiserSchema.pre('save', function (next) { this.updatedAt = Date.now(); next(); });

module.exports = mongoose.model('Advertiser', advertiserSchema);
module.exports.slugify = slugify;
