// Stage 1 artifact: raw analysis (YOLO products, GPT subjects + text +
// background). Owned by the `detect` step today; in the eventual split this
// is the only collection the detection service writes.
//
// Always keyed by (mediaId, runId). Re-runs insert new docs — they don't
// overwrite — so cross-run diffs are queryable.

const mongoose = require('mongoose');

const detectionArtifactSchema = new mongoose.Schema({
  advertiserId: { type: mongoose.Schema.Types.ObjectId, ref: 'Advertiser', index: true, default: null },
  brandId: { type: mongoose.Schema.Types.ObjectId, ref: 'Brand',      index: true, default: null },
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

  // Phase 1.6 — GPT-4.1 batch bbox refinement output. After the YOLO+OpenCV+
  // gpt-4o-mini pipeline + Phase-1.5 non-product filter, each surviving
  // detection is sent through one batched Vision call that returns tight
  // per-item bboxes (1+ per input crop, since a 'person' container may yield
  // bikini-top + bikini-bottom + accessories). Coordinates are in source-image
  // pixel space (translated from the crop-relative GPT response). Each entry:
  //   { id, sourceDetectionId, x1, y1, x2, y2, label, confidence,
  //     croppedImageUrl }   // croppedImageUrl is a Cloudinary URL of the
  //                         // tight crop, used for catalog visual matching.
  // Empty array if Phase 1.6 fails (downstream falls back to yoloProducts).
  refinedProducts:  [mongoose.Schema.Types.Mixed],

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
