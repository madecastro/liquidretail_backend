// Stage 2 artifact: smart crops at the base ratios (5:4, 1:1, 4:5) plus the
// LLM judge's full output (per-ratio winners + dimension scores +
// products/subjects/text rulings).

const mongoose = require('mongoose');

const cropArtifactSchema = new mongoose.Schema({
  advertiserId: { type: mongoose.Schema.Types.ObjectId, ref: 'Advertiser', index: true, default: null },
  // brandId added so a Brand cascade-delete can find this artifact
  // without joining through Media. Backfilled by scripts/backfillArtifactBrandId.js.
  brandId: { type: mongoose.Schema.Types.ObjectId, ref: 'Brand',      index: true, default: null },
  mediaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Media',     required: true, index: true },
  runId:   { type: mongoose.Schema.Types.ObjectId, ref: 'DetectRun', required: true, index: true },

  smartCrops: { type: mongoose.Schema.Types.Mixed, default: {} },
  // shape: { '5:4': [crop,...], '1:1': [crop,...], '4:5': [crop,...] }

  judge:      { type: mongoose.Schema.Types.Mixed, default: {} },
  // shape: see judgeService output — crop_5_4 / crop_1_1 / crop_4_5 / subjects / products / text

  winners:    { type: mongoose.Schema.Types.Mixed, default: {} },
  // shape: { '5:4': cropId, '1:1': cropId, '4:5': cropId }

  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('CropArtifact', cropArtifactSchema);
