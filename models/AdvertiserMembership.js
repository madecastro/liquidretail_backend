// AdvertiserMembership — the join between User and Advertiser.
//
// Replaces the User.advertiserId single-pointer (Phase 1) with a
// proper many-to-many model so:
//   1. An Advertiser can have multiple users (team members).
//   2. A user can belong to multiple Advertisers (agency model).
//
// Lifecycle:
//   pending  → invited but not accepted yet (userId may be null
//              if the invitee hasn't signed up; email is set)
//   active   → accepted; user has access at the given role
//   revoked  → membership terminated by an admin/owner; preserved
//              for audit trail rather than deleted
//
// Token semantics: invitations carry a random token used in the
// invite URL. Accepting flips status active + stamps acceptedAt
// + binds userId to the invitee's account.

const mongoose = require('mongoose');
const crypto   = require('crypto');

function generateInviteToken() {
  // 32 bytes → 64 hex chars. Long enough to be effectively
  // unguessable; short enough to fit comfortably in a URL.
  return crypto.randomBytes(32).toString('hex');
}

const advertiserMembershipSchema = new mongoose.Schema({
  advertiserId: { type: mongoose.Schema.Types.ObjectId, ref: 'Advertiser', required: true, index: true },

  // userId is null for pending invites where the invitee hasn't
  // signed up yet. Filled when the invite is accepted.
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },

  // Email always set so the membership is addressable before the
  // user exists (and as a UX fallback for "who did Alice invite?").
  // Lowercased for case-insensitive matching.
  email:        { type: String, required: true, lowercase: true, trim: true, index: true },

  role:         { type: String, enum: ['owner', 'admin', 'editor', 'viewer'], default: 'editor' },

  status:       { type: String, enum: ['pending', 'active', 'revoked'], default: 'pending', index: true },

  // Invitation provenance + token. Token only used while pending;
  // not cleared on accept (audit trail) but no longer accepted.
  inviteToken:  { type: String, default: generateInviteToken, unique: true, sparse: true, index: true },
  invitedBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  invitedAt:    { type: Date, default: Date.now },
  acceptedAt:   Date,
  revokedAt:    Date,
  revokedBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  createdAt:    { type: Date, default: Date.now },
  updatedAt:    { type: Date, default: Date.now }
});

advertiserMembershipSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

// One membership per (advertiser, user) pair when bound — but allow
// multiple pending invites for the same email at the same advertiser
// to support resends. Handled via partial unique index limited to
// userId-bound rows.
advertiserMembershipSchema.index(
  { advertiserId: 1, userId: 1 },
  { unique: true, partialFilterExpression: { userId: { $type: 'objectId' } } }
);

module.exports = mongoose.model('AdvertiserMembership', advertiserMembershipSchema);
module.exports.generateInviteToken = generateInviteToken;
