const mongoose = require('mongoose');

const jobSchema = new mongoose.Schema({
  status: {
    type: String,
    enum: ['queued', 'processing', 'completed', 'failed'],
    default: 'queued'
  },
  fileBuffer: Buffer,
  error: String,
  products: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
  createdAt: { type: Date, default: Date.now },
  completedAt: Date
});

module.exports = mongoose.model('Job', jobSchema);
