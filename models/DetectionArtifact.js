// Stage 1 artifact: raw analysis (YOLO products, GPT subjects + text +
// background). Owned by the `detect` step today; in the eventual split this
// is the only collection the detection service writes.
//
// Always keyed by (mediaId, runId). Re-runs insert new docs — they don't
// overwrite — so cross-run diffs are queryable.

const mongoose = require('mongoose');

const detectionArtifactSchema = new mongoose.Schema({
  mediaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Media',     required: true, index: true },
  runId:   { type: mongoose.Schema.Types.ObjectId, ref: 'DetectRun', required: true, index: true },

  type:    { type: String, enum: ['image', 'video'], required: true },
  width:   Number,
  height:  Number,

  imageUrl:         String,            // source image (image jobs) / hero frame (video jobs)
  videoUrl:         String,            // video only — source URL
  heroFrameSec:     Number,            // video only
  heroReason:       String,            // video only — why this frame was picked
  videoDurationSec: Number,            // video only

  yoloProducts:     [mongoose.Schema.Types.Mixed],
  // each: { id, className, confidence, x1, y1, x2, y2, firstSeenSec,
  //         identification: { label, description, brand, category, confidence } }

  subjects:           [mongoose.Schema.Types.Mixed],   // GPT subjects with role
  text:               [mongoose.Schema.Types.Mixed],   // GPT text regions
  background:         mongoose.Schema.Types.Mixed,     // { description, setting, palette[], lighting, style, notes }

  primarySubjectId:   String,                          // judge-arbitrated; null if none
  primarySubjectDesc: String,                          // resolved description (cached)

  safeRect:           mongoose.Schema.Types.Mixed,
  transcript:         mongoose.Schema.Types.Mixed,     // video only

  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('DetectionArtifact', detectionArtifactSchema);
