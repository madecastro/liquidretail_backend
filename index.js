require('dotenv').config();
// Repo-versioned non-secret defaults (feature flags, tuning knobs, public
// URLs). Loaded AFTER the environment so Render env / local .env always win
// — dotenv never overrides an already-set var. Secrets are NOT in this file.
require('dotenv').config({ path: require('path').join(__dirname, 'config', 'defaults.env') });
console.log(`⚙️  config: defaults.env applied — WORKER_CONCURRENCY=${process.env.WORKER_CONCURRENCY} CATALOG_DETECT_PRECOMPUTE=${process.env.CATALOG_DETECT_PRECOMPUTE} GENERIC_CATALOG_PDP_CONCURRENCY=${process.env.GENERIC_CATALOG_PDP_CONCURRENCY}`);
// Full concurrency table (self- vs provider-imposed) — single source of truth.
require('./services/concurrency').logConcurrencyConfig();
// Crash / restart / shutdown alerting. Installed FIRST — before any other
// require can throw — so a boot-time failure is still reported. Also the
// only thing standing between an unhandled rejection in a fire-and-forget
// render loop and a silent process death that strands every in-flight
// video generation.
require('./services/processAlerts').installProcessAlerts({ role: 'web' });

const express = require('express');
const session = require('express-session');
const passport = require('passport');
const cors = require('cors');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const mongoose = require('mongoose');
const multer = require('multer');
const Product = require('./models/Product');
const User = require('./models/User');
const Advertiser = require('./models/Advertiser');
const { pushProductToShopify } = require('./services/pushToShopify');
const uploadRoutes = require('./routes/upload');
const jobRoutes = require('./routes/jobs');
const authRoutes = require('./routes/auth');
const detectRoutes = require('./routes/detect');
const layoutRoutes = require('./routes/layout');
const mediaRoutes  = require('./routes/media');
const brandRoutes  = require('./routes/brand');
const meRoutes     = require('./routes/me');
const onboardingRoutes = require('./routes/onboarding');
const invitationRoutes = require('./routes/invitations');
const memberRoutes     = require('./routes/members');
const integrationRoutes = require('./routes/integrations');
const aiLayoutRoutes = require('./routes/aiLayouts');
const catalogRoutes = require('./routes/catalog');
const campaignRoutes = require('./routes/campaigns');
const adsRoutes = require('./routes/ads');
const seedsRoutes = require('./routes/seeds');
const requireAuth = require('./middleware/requireAuth');

const app = express();
const upload = multer({ dest: 'uploads/' });

// ── CORS ─────────────────────────────────────────────────────────────────────
// Allowlist driven by FRONTEND_URLS env (comma-separated) — same source
// of truth the OAuth redirect validator uses (services/frontendOrigin-
// Validator.js). Lets us run multiple frontend deploys against this
// backend simultaneously (e.g. staging.reach-social.io + the legacy
// liquidretail.netlify.app during cutover) without code changes — just
// add the origin to the env var.
const { validateFrontendOrigin } = require('./services/frontendOriginValidator');
app.use(cors({
  origin: (origin, cb) => {
    // Same-origin / server-to-server requests have no Origin header.
    // cors() invokes this callback with origin=undefined in that case.
    if (!origin) return cb(null, true);
    if (validateFrontendOrigin(origin)) return cb(null, true);
    return cb(new Error(`CORS: origin ${origin} not in FRONTEND_URLS allowlist`));
  },
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
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const email = profile.emails?.[0]?.value || '';
    // TEMPORARILY OPEN: any verified Google account can sign in.
    // TODO: gate this before going public — invite-token table, domain
    // allowlist on Advertiser, or waitlist flow. Until then we still
    // require Google to have given us a non-empty email.
    if (!email) return done(null, false);

    // Upsert the User row so we have a place to attach advertiserId,
    // role, last-login etc. Session still carries the lightweight
    // Google profile shape downstream consumers expect; the persisted
    // User doc is enriched with advertiserId on next-login or via the
    // backfill migration.
    //
    // isSuperAdmin is re-stamped from SUPER_ADMIN_EMAILS on every login
    // so promotions/demotions to the env allowlist take effect on the
    // next sign-in — no manual data patch. Written as a $set (not
    // $setOnInsert) so a removed email demotes the existing User too.
    const { isSuperAdminEmail } = require('./services/superAdminService');
    const userDoc = await User.findOneAndUpdate(
      { googleId: profile.id },
      {
        $set: {
          email,
          displayName:  profile.displayName,
          photoUrl:     profile.photos?.[0]?.value || null,
          lastLoginAt:  new Date(),
          isSuperAdmin: isSuperAdminEmail(email)
        },
        $setOnInsert: { googleId: profile.id }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return done(null, {
      id:           profile.id,
      userId:       userDoc._id,        // ← persisted User._id for downstream lookups
      advertiserId: userDoc.advertiserId, // ← null until backfill / signup flow assigns one
      name:         profile.displayName,
      email,
      photo:        profile.photos?.[0]?.value,
      isSuperAdmin: userDoc.isSuperAdmin === true
    });
  } catch (err) {
    return done(err);
  }
}));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

app.use(passport.initialize());
app.use(passport.session());

// ── Auth routes (public) ─────────────────────────────────────────────────────
app.use('/auth', authRoutes);

// ── Protected API routes ─────────────────────────────────────────────────────
// Raised from Express's 100kb default — the ad regenerate-with-prompt-
// override flow (routes/ads.js POST /:id/regenerate) accepts up to a
// 40,000-char system + 40,000-char user prompt, which in JSON-escaped form
// can exceed 100kb before that route's own friendlier length check ever
// runs, surfacing an opaque body-parser 413 instead.
app.use(express.json({ limit: '2mb' }));
app.use('/api/upload', requireAuth, uploadRoutes);
app.use('/api/jobs', requireAuth, jobRoutes);
app.use('/api/detect', requireAuth, detectRoutes);
app.use('/api/layout-input', requireAuth, layoutRoutes);
app.use('/api/media', requireAuth, mediaRoutes);
app.use('/api/brand', requireAuth, brandRoutes);
app.use('/api/me',    requireAuth, meRoutes);
// Unified progress feed for every long-running process (OperationRun) —
// the ActivityDock polls /active; cancel is cooperative via checkpoints.
app.use('/api/progress', requireAuth, require('./routes/progress'));
// Onboarding mounts WITHOUT requireAuth — its own middleware
// (requireUserOnly) lets users without an Advertiser through so
// they can create one. Mounting requireAuth here would 403 every
// onboarding attempt.
app.use('/api/onboarding', onboardingRoutes);
// Invitations: management routes (POST/GET list/DELETE :id) need
// requireAuth, but the /by-token preview is public and /by-token/accept
// uses requireUserOnly internally. Skip global requireAuth on the
// /by-token paths so anonymous preview + auth-only-not-membership
// accept both work.
app.use('/api/invitations', (req, res, next) => {
  if (req.path.startsWith('/by-token/') || req.path === '/by-token') return next();
  return requireAuth(req, res, next);
}, invitationRoutes);
app.use('/api/members',     requireAuth, memberRoutes);
// Platform-wide admin (vision-QC gates, etc.). Own auth chain lives on
// the router (requireUserOnly + requireSuperAdmin) — do NOT wrap this
// in requireAuth. requireAuth would inject a tenant advertiser id onto
// a surface that must never read one.
app.use('/api/admin', require('./routes/admin'));
// Integrations: Meta OAuth callback comes from a browser redirect with
// no JWT — security on /instagram/callback comes from the signed state
// param, not a session. Skip global requireAuth for that path; require
// auth on every other integrations endpoint.
app.use('/api/integrations', (req, res, next) => {
  if (req.path === '/instagram/callback') return next();
  if (req.path === '/instagram/webhook')  return next();
  if (req.path === '/meta-ads/callback')  return next();
  if (req.path === '/google-ads/callback') return next();
  return requireAuth(req, res, next);
}, integrationRoutes);
app.use('/api/ai-layouts', requireAuth, aiLayoutRoutes);
app.use('/api/ai-layouts/spec', requireAuth, require('./routes/aiCanvasSpec'));
app.use('/api/catalog', requireAuth, catalogRoutes);
app.use('/api/campaigns', requireAuth, campaignRoutes);
// Browser-navigation auth adapter — lifts ?_token=<jwt> from the
// query string into the Authorization header before requireAuth
// runs. Scoped to /api/ads/:adId/preview-page so it doesn't apply
// to API endpoints called with a real Authorization header. Lets
// operators open the preview page directly via window.open() (which
// can't set request headers) by embedding the JWT in the URL.
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  if (!/^\/api\/ads\/[a-f0-9]{24}\/preview-page(?:[/?]|$)/i.test(req.url)) return next();
  if (req.headers.authorization) return next();
  const t = (req.query && req.query._token) || null;
  if (t && typeof t === 'string') req.headers.authorization = `Bearer ${t}`;
  next();
});
app.use('/api/ads',       requireAuth, adsRoutes);
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  if (!/^\/api\/qc-insights\/report(?:[/?]|$)/i.test(req.url)) return next();
  if (req.headers.authorization) return next();
  const t = (req.query && req.query._token) || null;
  if (t && typeof t === 'string') req.headers.authorization = `Bearer ${t}`;
  next();
});
// PLATFORM-WIDE, not tenant-scoped — same reasoning as /api/admin, and
// gated the same way: bare mount, auth lives INSIDE the router (see
// routes/qcInsights.js header) so a future added route cannot forget it.
app.use('/api/qc-insights', require('./routes/qcInsights'));
app.use('/api/seeds',     requireAuth, seedsRoutes);
app.use('/api/sales-demos', requireAuth, require('./routes/salesDemos'));
// Home-page agent (backlog rows 167, 168). Mounted unconditionally so a
// disabled agent returns 503 with a clear reason instead of a 404 the
// frontend can't distinguish from a missing deploy. Enable per env with
// AGENT_ENABLED=true; see config/defaults.env.
const agentRoutes = require('./routes/agent');
app.use('/api/agent',     requireAuth, agentRoutes);

app.post('/api/products/:id/push-to-shopify', requireAuth, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    const shopifyProduct = await pushProductToShopify(product);
    product.shopify_status = 'published';
    product.shopify_url = `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/products/${shopifyProduct.id}`;
    await product.save();
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

// Title playground — operator refinement tool for the Remotion titling
// engine (fast still-frame loop against POST /api/brand/:id/title-still).
// The page itself is static and holds no data; it calls the API with the
// operator's own Bearer token, so serving it unauthenticated is safe.
app.get('/title-playground', (req, res) =>
  res.sendFile(require('path').join(__dirname, 'public', 'titlePlayground.html')));

// ── MongoDB ──────────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser:    true,
  useUnifiedTopology: true,
  // When RUN_WORKER=true the same process handles both API and worker
  // queries; size the pool to cover both. 200 stays well under Atlas
  // tier limits (M0=500, M10=1500).
  maxPoolSize:        200
})
  .then(async () => {
    console.log('✅ Connected to MongoDB');
    // Sync the partial-unique indexes that protect concurrent inserts.
    // After a DB drop, autoIndex builds these lazily on first model use —
    // which races against postSyncService / catalogProductDetectService
    // inserts. Explicit sync ensures the guards exist before any traffic.
    try {
      const DetectRun           = require('./models/DetectRun');
      const Ad                  = require('./models/Ad');
      const CampaignRun         = require('./models/CampaignRun');
      const LayoutInputArtifact = require('./models/LayoutInputArtifact');
      const Media               = require('./models/Media');
      await Promise.all([
        DetectRun.syncIndexes(),
        Ad.syncIndexes(),
        CampaignRun.syncIndexes(),
        LayoutInputArtifact.syncIndexes(),
        // Drops the legacy global unique on (source, externalId) and
        // builds the brand-scoped (brandId, source, externalId) one
        // declared on the schema. Required for multi-tenant ingest.
        Media.syncIndexes()
      ]);
      console.log('✅ critical indexes synced (DetectRun, Ad, CampaignRun, LayoutInputArtifact, Media)');
    } catch (err) {
      console.warn(`⚠️  syncIndexes failed (non-fatal): ${err.message}`);
    }
    // One-shot legacy-index cleanup. The IntegrationCredential schema
    // moved from "one row per (brandId, type)" to per-account-id
    // partial indexes; the old global-unique indexes have to be
    // dropped or relinking ad accounts hits E11000. Idempotent — safe
    // to run on every boot.
    try {
      const dropLegacyIntegrationIndexes = require('./scripts/dropLegacyIntegrationIndexes');
      const r = await dropLegacyIntegrationIndexes();
      if (r.dropped.length > 0) {
        console.log(`✅ legacy-index cleanup: dropped=[${r.dropped.join(', ')}]`);
      }
    } catch (err) {
      console.warn(`⚠️  legacy-index cleanup failed (non-fatal): ${err.message}`);
    }
  })
  .catch(err => console.error('MongoDB connection error:', err));

if (process.env.RUN_WORKER === 'true') {
  console.log('🔄 Starting background job processor...');
  require('./worker');
}

// Boot-time Google Fonts download for the brand-script overlay pipeline.
// Non-blocking — server accepts requests immediately; brand-script renders
// happen seconds-to-minutes later, giving the download time to complete.
// Failures per-family are logged but don't abort startup.
require('./services/fontLoader')
  .ensureFontsLoaded()
  .catch(err => console.warn(`🔤 fontLoader: unexpected failure (${err.message})`));

// Remotion titling engine warmup — webpack-bundles the remotion/ island
// and prepares the headless browser + loopback asset server so the first
// render doesn't pay the ~30s cold start. Same non-blocking contract as
// the font warmup: failure logs and the first render retries from cold.
require('./services/remotionRenderService')
  .warmup()
  .catch(err => console.warn(`🎬 remotion: warmup failed (${err.message}) — first render will retry`));

// Titling resume sweeper — REMOVED 2026-08-28 (owner directive: "remove and
// disable the backend titling function, we are not going to go back to it").
// This used to run services/titlingResumeService.js (deleted) on an interval,
// titling masters recovered by bootRecoveryService. Backend no longer titles
// video in-process at all — adgen owns titling exclusively, and this sweeper
// was flagged as a residual defect: an independent interval sweep with no
// lease could still race adgen's own titling-resume path and terminal-fail a
// recoverable ad if it somehow won that race. See CLAUDE.md / session.d for
// the full removal write-up.

// STRANDED-RUN SWEEP — finish what a restart abandoned.
//
// processAlerts requeues receipt-free `rendering` ads to `queued` on every
// SIGTERM (so, every deploy) and marks the run failed; nothing then drained
// `queued`, and bootRecoveryService only handles `rendering` + receipt. The work
// simply sat there until a human noticed.
//
// RECOVERY RUNS FIRST and is free — a stranded ad holding a spend receipt is
// already paid for and Atlas keeps it 30 days, so requeuing it would buy the same
// image twice. Only genuinely receipt-free ads reach requeueStrandedAds.
//
// WEB process, not the worker: the requeue half needs runRenderLoop, which lives
// in routes/ads.js. Single-flight for the same reason as the titling sweeper
// above — a pass can outlast its interval, and stacking renders on this process
// is a memory hazard. Concurrency across INSTANCES is safe without a lease
// because the requeue goes through the same atomic `status:'queued'` claim POST
// /runs uses: the first claimer wins, the rest no-op.
//
// The first tick is deliberately late (2 min): on a deploy this process is the
// one that JUST replaced the process whose SIGTERM stranded the ads, so an
// immediate sweep would race the shutdown handler's own requeue write.
(() => {
  const { sweepStrandedRuns, ENABLED } = require('./services/strandedRunSweeper');
  if (!ENABLED()) {
    console.log('♻️  stranded sweep: disabled (STRANDED_SWEEP_ENABLED=false)');
    return;
  }
  const { requeueStrandedAds } = require('./routes/ads');
  const intervalMin = Math.max(1, parseInt(process.env.STRANDED_SWEEP_INTERVAL_MIN, 10) || 10);
  let inFlightPass = false;
  const tick = () => {
    if (inFlightPass) return;
    inFlightPass = true;
    return sweepStrandedRuns({ requeue: requeueStrandedAds })
      .catch(err => console.warn(`⚠️  stranded sweep failed: ${err.message}`))
      .finally(() => { inFlightPass = false; });
  };
  setTimeout(tick, 120 * 1000);
  setInterval(tick, intervalMin * 60 * 1000);
})();

// Progress reaper — runs left behind by the previous process (in-process
// setImmediate jobs die on restart) get marked failed instead of showing
// "running" forever. The worker's periodic reaper covers ongoing sweeps.
require('./services/progressService')
  .sweepStaleRuns()
  .catch(err => console.warn(`🧹 progress sweep failed at boot: ${err.message}`));

// Puppeteer Chrome availability probe — logs the resolved cache dir
// and whether an ACTUAL chrome executable survived the build → runtime
// transition. A directory-only check was the wrong signal: puppeteer's
// install leaves an empty skeleton dir on partial extracts, and the
// probe would report "Chrome found" while runtime launches still fail.
// Now verifies the platform-specific executable path inside the build.
(() => {
  try {
    const fs   = require('fs');
    const path = require('path');
    const cfg  = require('./.puppeteerrc.cjs');
    const cacheDir  = cfg.cacheDirectory;
    const chromeDir = path.join(cacheDir, 'chrome');
    if (!fs.existsSync(chromeDir)) {
      console.warn(`🕵️  puppeteer: no Chrome dir at ${chromeDir} — image ads will fail at render. Check the postinstall log.`);
      return;
    }
    const builds = fs.readdirSync(chromeDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name);
    if (builds.length === 0) {
      console.warn(`🕵️  puppeteer: ${chromeDir} has no build directories — image ads will fail.`);
      return;
    }
    // Check for the actual chrome binary — Linux is the Render deploy
    // target; the mac/win checks stay for local dev-machine parity.
    const candidateExes = (buildName) => [
      path.join(chromeDir, buildName, 'chrome-linux64', 'chrome'),
      path.join(chromeDir, buildName, 'chrome-win64',   'chrome.exe'),
      path.join(chromeDir, buildName, 'chrome-mac-x64',   'Google Chrome for Testing.app'),
      path.join(chromeDir, buildName, 'chrome-mac-arm64', 'Google Chrome for Testing.app'),
    ];
    const complete = builds.filter((b) => candidateExes(b).some((p) => fs.existsSync(p)));
    if (complete.length === 0) {
      console.warn(`🕵️  puppeteer: ${builds.length} build dir(s) exist but no chrome executable — image ads will fail at render. Skeleton dirs: ${builds.join(', ')}`);
      return;
    }
    console.log(`🕵️  puppeteer: Chrome executable verified at ${chromeDir} — builds: ${complete.join(', ')}`);
  } catch (err) {
    console.warn(`🕵️  puppeteer probe failed: ${err.message}`);
  }
})();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
