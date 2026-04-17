const mongoose = require('mongoose');

const jobSchema = new mongoose.Schema({
  status: {
    type: String,
    enum: ['queued', 'processing', 'completed', 'failed'],
    default: 'queued'
  },
  fileBuffer: Buffer,
  fileType: { type: String, enum: ['image', 'video'], default: 'image' },
  error: String,
  products: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
  createdAt: { type: Date, default: Date.now },
  completedAt: Date,
  metadata: { type: mongoose.Schema.Types.Mixed }
});

module.exports = mongoose.model('Job', jobSchema);
