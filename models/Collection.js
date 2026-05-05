// Phase A-3 — Collection model.
//
// User-curated grouping of Media within a Brand. Operators use these
// to triage media — "campaign-X candidates", "needs-rights-approval",
// "winter-2026-launch", etc. Lightweight: just a name + a list of
// Media references. No nested folders or tags in v1.
//
// Constraints:
//   (brandId, name) unique  — collection names are scoped per brand
//   mediaIds[] uses ObjectId so cascade-delete-Media middleware can
//                pull them out cleanly
//
// Cascade behavior is handled in services/cascadeDeleteService —
// when a Media is deleted, its id is $pull'd from every Collection
// that references it. Avoids orphan references without a heavy
// post-remove hook on the Media model.

const mongoose = require('mongoose');

const collectionSchema = new mongoose.Schema({
  advertiserId: { type: mongoose.Schema.Types.ObjectId, ref: 'Advertiser', required: true, index: true },
  brandId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Brand',      required: true, index: true },
  name:         { type: String, required: true, trim: true },

  // Member media. Order is insertion order; UI sorts by addedAt or
  // by media.createdAt as needed. Limit not enforced at the schema
  // level but the route does a soft cap to keep responses sane.
  mediaIds:     [{ type: mongoose.Schema.Types.ObjectId, ref: 'Media' }],

  createdAt:    { type: Date, default: Date.now },
  updatedAt:    { type: Date, default: Date.now }
});

// One collection name per brand. (advertiser scope already lives on
// brandId — every brand belongs to exactly one advertiser, so a
// (brandId, name) pair is sufficient.)
collectionSchema.index({ brandId: 1, name: 1 }, { unique: true });

collectionSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('Collection', collectionSchema);
