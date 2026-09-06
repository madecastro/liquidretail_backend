const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  image_url: String,
  truck_number: String,
  product_name: String,
  product_title: String,
  category: String,
  description: String,
  condition: String,
  confidence: Number,
  price_estimate: Number,
  marketing_images: [String],
  shopify_status: { type: String, default: 'pending' },
  location: String, // consider renaming or combining with delivery_location
  delivery_location: String,
  delivery_date: String,
  delivery_time: String,
  fallback_used: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Product', productSchema);
