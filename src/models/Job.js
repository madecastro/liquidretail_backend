const mongoose = require('mongoose');

const jobSchema = new mongoose.Schema({
  status: {
    type: String,
    enum: ['queued', 'processing', 'completed', 'failed'],
    default: 'queued'
  },
  fileBuffer: Buffer,
  fileUrl: String,                // Cloudinary URL (used by detect-* jobs so the worker can re-fetch)
  fileMimeType: String,
  fileName: String,
  fileType: {
    type: String,
    enum: ['image', 'video', 'pre-cropped', 'detect-image', 'detect-video'],
    default: 'image'
  },
  detectionData:   { type: mongoose.Schema.Types.Mixed }, // input — old pre-cropped jobs
  detectionResult: { type: mongoose.Schema.Types.Mixed }, // output — detect pipeline result
  detectionStage:  String,        // current pipeline step (for progress UI)
  error: String,
  errorStage: String,
  products: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
  createdAt: { type: Date, default: Date.now },
  completedAt: Date,
  metadata: { type: mongoose.Schema.Types.Mixed }
});

module.exports = mongoose.model('Job', jobSchema);
