// Onboarding — first-time setup for users who hit 403 NO_ADVERTISER.
// Creates a brand-new Advertiser, attaches it to the requesting
// User, and (optionally) creates a starter Brand under it.
//
// All routes here use requireUserOnly (NOT requireAuth) since by
// definition these users don't yet have an advertiserId.

const express = require('express');
const router  = express.Router();

const Advertiser = require('../models/Advertiser');
const Brand      = require('../models/Brand');
const AdvertiserMembership = require('../models/AdvertiserMembership');
const IntegrationCredential = require('../models/IntegrationCredential');
const requireAuth = require('../middleware/requireAuth');
const requireUserOnly = require('../middleware/requireUserOnly');

// Email-domain allowlist for self-serve workspace creation. Comma-
// separated env var; empty/unset means no allowlist (open signup —
// useful in dev). Matched against the lowercased domain of the
// signed-in user's email. Without this gate any Google account
// could spin up an Advertiser, which isn't what we want at launch.
function parseAllowedDomains() {
  const raw = process.env.WORKSPACE_SIGNUP_ALLOWED_DOMAINS || '';
  return raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

function isEmailDomainAllowed(email) {
  const allowed = parseAllowedDomains();
  if (allowed.length === 0) return true;       // open mode — dev / no env set
  const domain = String(email || '').split('@')[1]?.toLowerCase();
  if (!domain) return false;
  return allowed.includes(domain);
}

// POST /api/onboarding/advertiser
// Body: { name: string, brandName?: string, brandWebsiteUrl?: string }
//
// Creates an Advertiser owned by the current user. If brandName is
// provided, also stubs out the user's first Brand under it so they
// land in a usable state with one click.
//
// Idempotent on the user: if they already have an advertiserId,
// returns 409 with the existing advertiser. Use POST /api/me to
// re-fetch state.
router.post('/advertiser', requireUserOnly, express.json(), async (req, res) => {
  try {
    if (req.userDoc.advertiserId) {
      const existing = await Advertiser.findById(req.userDoc.advertiserId).lean();
      return res.status(409).json({
        error: 'User already has an advertiser',
        advertiser: existing ? { id: String(existing._id), name: existing.name, slug: existing.slug } : null
      });
    }

    // Domain allowlist gate. Skipped when WORKSPACE_SIGNUP_ALLOWED_DOMAINS
    // is unset (dev). In prod this prevents random Google accounts from
    // spinning up Advertisers — only emails on listed domains may
    // self-serve. Existing invite acceptances bypass this entirely
    // (they go through invitations.js, not here).
    if (!isEmailDomainAllowed(req.userDoc.email)) {
      return res.status(403).json({
        error: 'Self-serve workspace creation is restricted. Contact your account team for access.',
        code:  'DOMAIN_NOT_ALLOWED'
      });
    }

    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name required' });

    // Ensure unique slug — append a counter if the desired slug is
    // taken. Cheap enough to do in-line; no race protection because
    // collision on signup is extremely rare and the unique index
    // catches it as a fallback.
    let slug = Advertiser.slugify(name);
    let suffix = 0;
    while (await Advertiser.findOne({ slug }).lean()) {
      suffix += 1;
      slug = `${Advertiser.slugify(name)}-${suffix}`;
    }

    const advertiser = await Advertiser.create({
      name,
      slug,
      ownerEmail: req.userDoc.email,
      plan: 'free',
      status: 'active'
    });

    // Optional starter Brand. Lets the onboarding form become a
    // "create account + first brand" combo so the user lands ready
    // to upload media.
    let brand = null;
    const brandName = String(req.body?.brandName || '').trim();
    if (brandName) {
      const { normalizeBrandName } = Brand;
      brand = await Brand.create({
        advertiserId:    advertiser._id,
        name:            brandName,
        nameNormalized:  normalizeBrandName(brandName),
        websiteUrl:      req.body?.brandWebsiteUrl || null,
        source:          'stub',
        firstSeenMediaId: null
      });
    }

    // Attach the advertiser to the user's record (Phase 1 backward
    // compat — the field is still consulted in some legacy paths)
    // AND create the AdvertiserMembership row that requireAuth (Phase
    // 4) actually uses to resolve the active advertiser.
    req.userDoc.advertiserId = advertiser._id;
    await req.userDoc.save();
    await AdvertiserMembership.create({
      advertiserId: advertiser._id,
      userId:       req.userDoc._id,
      email:        req.userDoc.email,
      role:         'owner',
      status:       'active',
      acceptedAt:   new Date()
    });

    res.status(201).json({
      advertiser: {
        id:    String(advertiser._id),
        name:  advertiser.name,
        slug:  advertiser.slug,
        plan:  advertiser.plan,
        status: advertiser.status
      },
      brand: brand ? {
        id:        String(brand._id),
        name:      brand.name,
        slug:      brand.nameNormalized,
        websiteUrl: brand.websiteUrl
      } : null
    });
  } catch (err) {
    console.error('onboarding/advertiser failed:', err);
    res.status(500).json({ error: err.message || 'Onboarding failed' });
  }
});

// GET /api/onboarding/eligibility
// Returns whether the signed-in user is allowed to self-create an
// Advertiser. Drives the OnboardingPage's "Create workspace" CTA —
// users not on the allowlist see the contact-admin path instead of
// a button that would 403 anyway. Always-200; the answer is the
// payload, not the status code.
router.get('/eligibility', requireUserOnly, async (req, res) => {
  try {
    const hasAdvertiser = !!req.userDoc.advertiserId;
    const domainAllowed = isEmailDomainAllowed(req.userDoc.email);
    res.json({
      email:           req.userDoc.email,
      hasAdvertiser,
      canSelfCreate:   !hasAdvertiser && domainAllowed,
      reason:          hasAdvertiser     ? 'already_has_advertiser'
                     : !domainAllowed    ? 'domain_not_allowed'
                     :                     null
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'eligibility check failed' });
  }
});

// POST /api/onboarding/dispatch-syncs
// Fire the post-onboarding sync fan-out (catalog + posts + campaigns)
// SERVER-SIDE so the requests can't be aborted by client navigation.
//
// Background: the connect page used to fire each sync as a separate
// fetch from the browser, then navigate to /brand. The syncs run
// synchronously server-side (catalog ~8s, posts ~52s), so the
// browser would abort the in-flight requests as the page unloaded —
// none of them reached completion. Now the connect page calls this
// one endpoint, which fans out to the underlying services via
// setImmediate (returns 202 in ms), then navigates safely.
//
// Idempotent: each sync service already de-dupes on
// (brand, externalId) so re-firing is harmless.
router.post('/dispatch-syncs', requireAuth, express.json(), async (req, res) => {
  try {
    const brandId = req.headers['x-brand-id'] || req.body?.brandId;
    console.log(`🚦 dispatch-syncs called: brand=${brandId} advertiser=${req.advertiserId}`);
    if (!brandId) return res.status(400).json({ error: 'brandId required' });

    // Confirm brand belongs to caller's advertiser before scheduling
    // any work for it.
    const brand = await Brand.findOne({ _id: brandId, advertiserId: req.advertiserId }).select('_id').lean();
    if (!brand) {
      console.warn(`🚦 dispatch-syncs: brand ${brandId} not found under advertiser ${req.advertiserId}`);
      return res.status(404).json({ error: 'brand not found' });
    }

    // Inspect connected creds so we only dispatch what's actually
    // useful. We accept 'pending' too because the picker may not
    // have promoted to 'active' yet — both meta/IG creds spend a
    // few seconds in pending while the picker UI runs. The sync
    // services themselves filter on status='active', so dispatching
    // a sync against a pending cred is a harmless no-op rather than
    // a dropped intent.
    const [igCred, metaCred, googleCred] = await Promise.all([
      IntegrationCredential.findOne({ brandId, type: 'instagram',  status: { $in: ['active', 'pending'] } }).select('_id status').lean(),
      IntegrationCredential.findOne({ brandId, type: 'meta-ads',   status: { $in: ['active', 'pending'] } }).select('_id status').lean(),
      IntegrationCredential.findOne({ brandId, type: 'google-ads', status: { $in: ['active', 'pending'] } }).select('_id status').lean()
    ]);
    console.log(`🚦 dispatch-syncs creds: ig=${igCred ? igCred.status : 'none'} meta=${metaCred ? metaCred.status : 'none'} google=${googleCred ? googleCred.status : 'none'}`);

    const dispatched = [];
    if (igCred) {
      dispatched.push('catalog', 'posts');
      setImmediate(async () => {
        try {
          const { syncCatalog } = require('../services/catalogSyncService');
          const r = await syncCatalog(String(brandId), {});
          console.log(`📦 dispatched catalog sync: ok=${r.ok} fetched=${r.fetched || 0}`);
        } catch (err) { console.warn(`⚠️  dispatched catalog sync failed: ${err.message}`); }
        // Same race fix as integrations.js IG finalize: once catalog-
        // product detects drain, re-run post detect for under-matched
        // media so they pick up matches against products whose visual
        // signatures weren't ready during the original race.
        try {
          const { rematchAfterCatalogDetect } = require('../services/postRematchAfterCatalogService');
          await rematchAfterCatalogDetect({ brandId: String(brandId) });
        } catch (err) { console.warn(`⚠️  rematch-after-catalog failed: ${err.message}`); }
      });
      setImmediate(async () => {
        try {
          const { syncPosts } = require('../services/postSyncService');
          const r = await syncPosts(String(brandId), {});
          console.log(`📸 dispatched post sync: ok=${r.ok} ingested=${r.ingested || 0}`);
        } catch (err) { console.warn(`⚠️  dispatched post sync failed: ${err.message}`); }
      });
    }
    if (metaCred) {
      dispatched.push('meta-campaigns');
      setImmediate(async () => {
        try {
          const { syncCampaigns } = require('../services/campaignSyncService');
          const r = await syncCampaigns({ brandId: String(brandId), platform: 'meta-ads' });
          console.log(`📣 dispatched meta-ads sync: upserted=${r?.upserted || 0}`);
        } catch (err) { console.warn(`⚠️  dispatched meta-ads sync failed: ${err.message}`); }
      });
    }
    if (googleCred) {
      dispatched.push('google-campaigns');
      setImmediate(async () => {
        try {
          const { syncCampaigns } = require('../services/campaignSyncService');
          const r = await syncCampaigns({ brandId: String(brandId), platform: 'google-ads' });
          console.log(`📣 dispatched google-ads sync: upserted=${r?.upserted || 0}`);
        } catch (err) { console.warn(`⚠️  dispatched google-ads sync failed: ${err.message}`); }
      });
    }

    res.status(202).json({ dispatched });
  } catch (err) {
    console.error('dispatch-syncs failed:', err);
    res.status(500).json({ error: err.message || 'dispatch failed' });
  }
});

module.exports = router;
