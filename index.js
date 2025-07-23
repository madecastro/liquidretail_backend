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
