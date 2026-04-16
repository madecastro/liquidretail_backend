require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const cors = require('cors');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const mongoose = require('mongoose');
const multer = require('multer');
const Product = require('./models/Product');
const { pushProductToShopify } = require('./services/pushToShopify');
const uploadRoutes = require('./routes/upload');
const jobRoutes = require('./routes/jobs');
const authRoutes = require('./routes/auth');
const requireAuth = require('./middleware/requireAuth');

const app = express();
const upload = multer({ dest: 'uploads/' });

// ── CORS ─────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: 'https://liquidretail.netlify.app',
  credentials: true
}));

// ── Session (used only for OAuth handshake) ───────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: true, sameSite: 'none' }
}));

// ── Passport / Google OAuth ──────────────────────────────────────────────────
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.GOOGLE_CALLBACK_URL
}, (accessToken, refreshToken, profile, done) => {
  const email = profile.emails?.[0]?.value || '';
  if (!email.endsWith('@floodqrf.com')) {
    return done(null, false);
  }
  return done(null, {
    id: profile.id,
    name: profile.displayName,
    email,
    photo: profile.photos?.[0]?.value
  });
}));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

app.use(passport.initialize());
app.use(passport.session());

// ── Auth routes (public) ─────────────────────────────────────────────────────
app.use('/auth', authRoutes);

// ── Protected API routes ─────────────────────────────────────────────────────
app.use(express.json());
app.use('/api/upload', requireAuth, uploadRoutes);
app.use('/api/jobs', requireAuth, jobRoutes);

app.post('/api/products/:id/push-to-shopify', requireAuth, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    const shopifyProduct = await pushProductToShopify(product);
    res.status(200).json({ message: '✅ Product pushed to Shopify as draft', shopify_product: shopifyProduct });
  } catch (err) {
    console.error('Shopify push error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to push product to Shopify' });
  }
});

app.get('/api/products', requireAuth, async (req, res) => {
  try {
    const { truck, date } = req.query;
    const filter = {};
    if (truck) filter.truck_number = truck;
    if (date) {
      const start = new Date(date);
      const end = new Date(date);
      end.setDate(end.getDate() + 1);
      filter.createdAt = { $gte: start, $lt: end };
    }
    const products = await Product.find(filter).sort({ createdAt: -1 });
    res.status(200).json(products);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

app.delete('/api/products/:id', requireAuth, async (req, res) => {
  try {
    const deleted = await Product.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Product not found' });
    res.status(200).json({ message: 'Product deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

app.get('/api/products/:id', requireAuth, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.status(200).json(product);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch product' });
  }
});

app.put('/api/products/:id', requireAuth, express.json(), async (req, res) => {
  try {
    const updated = await Product.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!updated) return res.status(404).json({ error: 'Product not found' });
    res.status(200).json(updated);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update product' });
  }
});

app.post('/api/products/:id/match-amazon', requireAuth, express.json(), async (req, res) => {
  try {
    const { query } = req.body;
    const matches = [
      { title: "Bosch Hydraulic Pump A2FO", image: "https://via.placeholder.com/300x200?text=Bosch+Pump", price: 179.99, description: "Original Bosch axial piston hydraulic pump." },
      { title: "Hydraulic Gear Pump 16cc", image: "https://via.placeholder.com/300x200?text=Gear+Pump", price: 124.95, description: "Compact hydraulic gear pump, 250 bar." }
    ];
    res.status(200).json({ matches });
  } catch (err) {
    res.status(500).json({ error: 'Failed to search Amazon catalog' });
  }
});

app.get('/api/health', (req, res) => res.status(200).send('API is running ✅'));

// ── MongoDB ──────────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

if (process.env.RUN_WORKER === 'true') {
  console.log('🔄 Starting background job processor...');
  require('./worker');
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
