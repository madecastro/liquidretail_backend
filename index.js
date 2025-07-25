require('dotenv').config();
const express = require('express');
const multer = require('multer');
const mongoose = require('mongoose');
const { processImage } = require('./services/openaiService');
const { uploadToS3 } = require('./services/s3Service');
const Product = require('./models/Product');

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(express.json());

// ✅ Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('✅ Connected to MongoDB'))
.catch(err => console.error('MongoDB connection error:', err));

// ✅ Upload route
app.post('/api/upload', upload.single('photo'), async (req, res) => {
  try {
    const fileUrl = await uploadToS3(req.file);
    const result = await processImage(fileUrl);

    const product = new Product({
      image_url: fileUrl,
      ...result
    });

    await product.save();
    res.status(200).json(product);
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Failed to process image' });
  }
});

// ✅ Health check route (for Render to verify)
app.get('/api/health', (req, res) => {
  res.status(200).send('API is running ✅');
});

// ✅ Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
// ✅ New: Get one product
app.get('/api/products/:id', async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.status(200).json(product);
  } catch (err) {
    console.error('Error fetching product:', err);
    res.status(500).json({ error: 'Failed to fetch product' });
  }
});

// ✅ New: Update product
app.put('/api/products/:id', express.json(), async (req, res) => {
  try {
    const updated = await Product.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!updated) return res.status(404).json({ error: 'Product not found' });
    res.status(200).json(updated);
  } catch (err) {
    console.error('Error updating product:', err);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

// ✅ New: Simulate Amazon product match
app.post('/api/products/:id/match-amazon', express.json(), async (req, res) => {
  try {
    const { query } = req.body;
    console.log(`🔍 Simulating Amazon match for: "${query}"`);

    const matches = [
      {
        title: "Bosch Hydraulic Pump A2FO",
        image: "https://via.placeholder.com/300x200?text=Bosch+Pump",
        price: 179.99,
        description: "Original Bosch axial piston hydraulic pump for industrial machinery."
      },
      {
        title: "Hydraulic Gear Pump 16cc",
        image: "https://via.placeholder.com/300x200?text=Gear+Pump",
        price: 124.95,
        description: "Compact hydraulic gear pump with 250 bar operating pressure."
      }
    ];

    res.status(200).json({ matches });
  } catch (err) {
    console.error('Error simulating Amazon match:', err);
    res.status(500).json({ error: 'Failed to search Amazon catalog' });
  }
});