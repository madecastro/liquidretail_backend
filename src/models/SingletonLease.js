// Distributed singleton lease document.
//
// Collection name `singleton_leases` is SHARED with liquidretail_backend
// (services/singletonLease.js there). That is intentional — one table, two
// services, same Mongo — and it is SAFE because the primary key is the
// lease NAME, not the service. Backend today holds exactly ONE name:
// `_id: 'worker-housekeeping'` (liquidretail_backend/worker.js:250-254 —
// verified, NOT 'scheduler', which is only the usage example in that
// file's own header comment). Adgen must pick different names. A name
// collision would be two codepaths fighting over
// one row, which is the coexisting-holder bug this collection exists to
// prevent. Do not "namespace" with a second collection; do not reuse a
// backend name.
//
// This is NOT a vendored copy of backend's inline schema. Adgen's schema
// is a strict extension: nullable `holder` (so release does not leave a
// stale name), `acquiredAt`, `fenceToken`. Backend inlines a smaller
// schema inside the service file and has no models/SingletonLease.js, so
// verifyModelParity will INFO-skip this file. That skip is expected.
//
// ⚠️ Do NOT add an expireAfterSeconds TTL index on expiresAt. A TTL
// index DELETES the document, which (a) resets fenceToken so the next
// generation is indistinguishable from the first and (b) re-opens the
// concurrent-upsert 11000 window on every expiry. Expired rows must
// STAY so a takeover can increment fenceToken (measured: 7→8). A
// regular (non-TTL) index on expiresAt is fine for ops queries.

const mongoose = require('mongoose');

const singletonLeaseSchema = new mongoose.Schema({
  // Lease name. String _id so `'expander'` is the document, not an
  // ObjectId we then have to look up. Required so a missing name cannot
  // insert as a generated ObjectId and silently become a second lease.
  _id: { type: String, required: true },

  // Worker id of the current holder, or null if released. Nullable
  // DELIBERATELY — backend's copy is required:true and only epoch-expires
  // the row, which leaves a dead holder's name on the doc forever. A
  // stale name is what a confused operator greps for and what a future
  // "is this still us?" check would misread. Release here sets null.
  holder: { type: String, default: null },

  // When mongod's clock ($$NOW, not the holder's Date.now()) considers
  // this row takeable by a peer. Regular index, NOT a TTL index — see
  // the file header.
  expiresAt: { type: Date, required: true, index: true },

  // When the current generation was taken (set to $$NOW only on
  // takeover, preserved on self-renew). Diagnostic + the next PR's
  // "how long has this expander been running" signal. Not consulted
  // by acquire/renew/release.
  acquiredAt: { type: Date, default: null },

  // Monotonic generation. Incremented exactly once per takeover
  // (measured 7→8 under a 12-way race). Exposed on the service for a
  // future PR to condition expansion writes on "still the same lease
  // generation" so a stale holder's write is detectable rather than
  // merely improbable. Unconsumed today — do not delete it as dead.
  fenceToken: { type: Number, default: 0 }
}, {
  collection: 'singleton_leases',
  // timestamps:false is load-bearing. mongoose timestamps would stamp
  // updatedAt from the CALLING PROCESS's clock, which is the exact
  // skew vector the $$NOW pipeline exists to close. Do not "turn on
  // timestamps for free audit fields."
  timestamps: false,
  // versionKey is noise on a 1-doc-per-name lease and a pipeline $set
  // of the four real fields has nothing to do with __v. Off so a
  // future editor does not start reasoning about version conflicts
  // that cannot happen here.
  versionKey: false
});

// Guard: a harness that require()s this file twice in one process
// (verifyModelParity intercepts mongoose.model; other harnesses do
// not) must not throw OverwriteModelError. mongoose.models.X is the
// same pattern ReviewSiteProfile.js already uses.
module.exports = mongoose.models.SingletonLease ||
  mongoose.model('SingletonLease', singletonLeaseSchema);
