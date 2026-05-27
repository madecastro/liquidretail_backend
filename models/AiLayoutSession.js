// Persisted session for AI Layout Studio exploration runs.
//
// The route POST /api/ai-layouts/generate is fire-and-forget: it
// creates a session, kicks off the work via setImmediate, and
// returns 202 immediately with the sessionId. The client polls
// GET /api/ai-layouts/session/:id until status flips to
// 'completed' (or 'failed'). This sidesteps the Netlify edge's
// 26s proxy timeout — 9 parallel gpt-image-1 calls easily exceed
// that, but the polls are sub-second each.
//
// TTL: docs auto-delete after 24h. The data is exploration-only
// (per aiLayoutStudioService's "not cached, not persisted" comment)
// so there's no audit value in keeping completed sessions around.

const mongoose = require('mongoose');

const referenceSchema = new mongoose.Schema({
  variant:          { type: String, required: true },
  aspectRatio:      { type: String, required: true },
  imageUrl:         { type: String, default: null },
  extractedCanvas:  { type: mongoose.Schema.Types.Mixed, default: null },
  status:           { type: String, enum: ['ok', 'error'], required: true },
  error:            { type: String, default: null }
}, { _id: false });

const aiLayoutSessionSchema = new mongoose.Schema({
  // Tenant scope. All three set at create time from req.user.
  advertiserId: { type: mongoose.Schema.Types.ObjectId, ref: 'Advertiser', required: true, index: true },
  brandId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Brand',      default: null },
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User',       required: true },

  // Inputs.
  mediaId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Media', required: true },
  variants:     [{ type: String }],
  aspectRatios: [{ type: String }],
  quality:      { type: String, default: 'low' },

  // Runtime state. status progresses queued → running → (completed | failed).
  status:       { type: String, enum: ['queued', 'running', 'completed', 'failed'], default: 'queued', index: true },
  totalCombos:  { type: Number, default: 0 },

  // Display context — populated when the worker loads context, so the
  // UI can show "brand=X · product=Y" before any references finish.
  brandName:    { type: String, default: null },
  productName:  { type: String, default: null },

  // References array — written incrementally via $push as each combo
  // settles. Client computes "X of N ready" from references.length.
  references:   { type: [referenceSchema], default: [] },

  // Top-level failure (e.g. context load failed, OpenAI key missing).
  // Per-combo errors land inside references[i].error and don't fail
  // the whole session.
  error:        { type: String, default: null },

  startedAt:    Date,
  completedAt:  Date,
  createdAt:    { type: Date, default: Date.now }
});

// TTL — auto-delete completed/failed sessions 24h after creation.
// Mongo's TTL monitor sweeps every ~60s so the cutoff isn't instant
// but well within an order of magnitude.
aiLayoutSessionSchema.index({ createdAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

module.exports = mongoose.model('AiLayoutSession', aiLayoutSessionSchema);
