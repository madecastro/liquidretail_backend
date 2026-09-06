// User — persisted account record for the Google-authenticated user.
//
// Replaces the session-only auth (where req.user was just the raw
// Google profile from the strategy callback). Persisting the user
// gives us a place to attach advertiserId, last-login timestamps,
// per-user feature flags, and eventually multi-Advertiser membership.
//
// The Google OAuth callback in server/index.js upserts this doc on
// every login so it stays current.

const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  // Google profile primary key — stable per Google account.
  googleId: { type: String, required: true, unique: true, index: true },

  email:       { type: String, required: true, index: true, lowercase: true, trim: true },
  displayName: String,
  photoUrl:    String,

  // Tenant scope. Single-Advertiser-per-User to start; agency
  // multi-membership is a future migration. Nullable so existing
  // logged-in users without an advertiser don't get locked out
  // before the backfill runs.
  advertiserId: { type: mongoose.Schema.Types.ObjectId, ref: 'Advertiser', index: true, default: null },

  // Per-user role within their Advertiser. Reserved for Phase 4 (team
  // invitations + permissions). Default 'owner' for now since every
  // user creates their own Advertiser on signup.
  role: { type: String, enum: ['owner', 'admin', 'editor', 'viewer'], default: 'owner' },

  // Cross-tenant super-admin. Bypasses the requireAuth NO_ADVERTISER
  // gate and gets synthetic 'owner' membership for every Advertiser in
  // the workspace switcher. Bootstrapped from the SUPER_ADMIN_EMAILS
  // env allowlist on every Google login (see services/superAdminService).
  // Money-path safety: super-admin does NOT unscope brand queries —
  // they still act inside one Advertiser at a time via the X-Advertiser-Id
  // header, they just have implicit access to every workspace.
  isSuperAdmin: { type: Boolean, default: false, index: true },

  lastLoginAt: Date,
  createdAt:   { type: Date, default: Date.now },
  updatedAt:   { type: Date, default: Date.now }
});

userSchema.pre('save', function (next) { this.updatedAt = Date.now(); next(); });

module.exports = mongoose.model('User', userSchema);
