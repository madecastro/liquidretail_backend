// Lightweight time-driven scheduler. Runs inside the worker process
// (no extra dep) — every TICK_INTERVAL_MS the worker calls runDueSyncs()
// which iterates active integration credentials and triggers catalog
// or post syncs that are due based on the parent Brand's syncSettings.
//
// Cadence is per-Brand (catalogCadenceHours, postsCadenceHours) but
// the implementation is global: we look at credential.lastCatalogSyncAt
// vs (now - catalogCadenceHours) and similarly for posts. The sync
// services themselves stamp the timestamps after each run.
//
// Manual syncs (via the brand-page buttons) also stamp these
// timestamps so the scheduler doesn't immediately re-run what a
// user just kicked off.

const Brand = require('../models/Brand');
const Campaign = require('../models/Campaign');
const IntegrationCredential = require('../models/IntegrationCredential');
const { syncCatalog } = require('./catalogSyncService');
const { syncPosts }   = require('./postSyncService');
const { syncCampaigns } = require('./campaignSyncService');
const { concurrency: CONC } = require('./concurrency');

const AD_PLATFORMS = ['meta-ads', 'google-ads'];

const TICK_INTERVAL_MS = 60 * 1000; // 1 minute — cadence checks are
                                    // hourly+ so finer ticks waste cycles.

// Brand-voice refresh sweep — runs at most once every 6 hours, regardless
// of how often the main scheduler ticks. Catches brands whose campaigns
// haven't changed since the last sync (so the in-sync auto-fire didn't
// trigger), but whose derived voice profile has aged past its 7-day TTL.
const VOICE_SWEEP_INTERVAL_MS = 6 * 3600 * 1000;
let lastVoiceSweepAt = 0;

let inFlight = false;
let lastTickAt = 0;

async function runDueSyncs() {
  if (inFlight) return { skipped: 'already running' };
  inFlight = true;
  const t0 = Date.now();
  lastTickAt = t0;
  const summary = { catalogsSynced: 0, postsSynced: 0, campaignsSynced: 0, errors: [] };

  try {
    // Pull every active IG credential whose Brand has auto-sync enabled.
    // Two-step: load brand IDs with autoSyncEnabled, then fetch creds
    // for those brands (lets us read the cadence/cap from Brand once).
    const brands = await Brand.find({ 'syncSettings.autoSyncEnabled': true })
      .select('_id syncSettings')
      .lean();
    if (!brands.length) { inFlight = false; return summary; }

    const brandsById = new Map(brands.map(b => [String(b._id), b]));
    const creds = await IntegrationCredential.find({
      brandId: { $in: brands.map(b => b._id) },
      type:    'instagram',
      status:  'active'
    }).select('_id brandId catalogId igUserId lastCatalogSyncAt lastPostsSyncAt').lean();

    const now = Date.now();

    for (const cred of creds) {
      const brand = brandsById.get(String(cred.brandId));
      if (!brand) continue;
      const settings = brand.syncSettings || {};
      const catalogCadenceMs = (settings.catalogCadenceHours || 24) * 3600 * 1000;
      const postsCadenceMs   = (settings.postsCadenceHours   || 1)  * 3600 * 1000;

      // ── Catalog ──
      // Pass credentialId so syncCatalog runs only this row, not all
      // siblings — otherwise multi-page brands would multi-sync.
      if (cred.catalogId) {
        const due = !cred.lastCatalogSyncAt
                  || (now - new Date(cred.lastCatalogSyncAt).getTime()) >= catalogCadenceMs;
        if (due) {
          try {
            const result = await syncCatalog(cred.brandId, { label: 'Catalog sync (scheduled)',  credentialId: cred._id });
            if (result.ok) summary.catalogsSynced++;
            else summary.errors.push({ brandId: cred.brandId, credentialId: String(cred._id), kind: 'catalog', reason: result.reason });
          } catch (err) {
            summary.errors.push({ brandId: cred.brandId, credentialId: String(cred._id), kind: 'catalog', reason: err.message });
          }
        }
      }

      // ── Posts ──
      if (cred.igUserId) {
        const due = !cred.lastPostsSyncAt
                  || (now - new Date(cred.lastPostsSyncAt).getTime()) >= postsCadenceMs;
        if (due) {
          try {
            const result = await syncPosts(cred.brandId, { label: 'Social posts ingest (scheduled)', 
              credentialId:      cred._id,
              limit:             25,
              dailyDetectRunCap: settings.dailyDetectRunCap ?? 50,
              trigger:           'instagram-sync'
            });
            if (result.ok) summary.postsSynced++;
            else summary.errors.push({ brandId: cred.brandId, credentialId: String(cred._id), kind: 'posts', reason: result.reason });
          } catch (err) {
            summary.errors.push({ brandId: cred.brandId, credentialId: String(cred._id), kind: 'posts', reason: err.message });
          }
        }
      }
    }

    // ── Campaigns (Meta Ads + Google Ads) ──
    // Separate query because the Brand cadence + the credential type
    // are different from IG. Per-credential due-check on
    // lastCampaignSyncAt; the orchestrator stamps it on success.
    const adCreds = await IntegrationCredential.find({
      brandId: { $in: brands.map(b => b._id) },
      type:    { $in: AD_PLATFORMS },
      status:  'active'
    }).select('_id brandId type lastCampaignSyncAt').lean();

    for (const cred of adCreds) {
      const brand = brandsById.get(String(cred.brandId));
      if (!brand) continue;
      const settings = brand.syncSettings || {};
      const cadenceMs = (settings.campaignCadenceHours || 6) * 3600 * 1000;
      const due = !cred.lastCampaignSyncAt
                || (now - new Date(cred.lastCampaignSyncAt).getTime()) >= cadenceMs;
      if (!due) continue;
      try {
        const result = await syncCampaigns({
          brandId:      cred.brandId,
          platform:     cred.type,
          credentialId: cred._id
        });
        if (result.ok) summary.campaignsSynced++;
        else summary.errors.push({ brandId: cred.brandId, credentialId: String(cred._id), kind: 'campaigns', reason: result.reason });
      } catch (err) {
        summary.errors.push({ brandId: cred.brandId, credentialId: String(cred._id), kind: 'campaigns', reason: err.message });
      }
    }
    // ── Brand-voice refresh sweep ──
    // Once every VOICE_SWEEP_INTERVAL_MS, walk brands whose derivedVoice
    // is stale (older than the service's own TTL) AND that have at
    // least one ingested campaign. Fires deriveBrandVoice fire-and-
    // forget — the service is TTL-guarded so the call is idempotent.
    if ((now - lastVoiceSweepAt) >= VOICE_SWEEP_INTERVAL_MS) {
      lastVoiceSweepAt = now;
      try {
        summary.voiceProfilesRefreshed = await sweepStaleBrandVoices();
      } catch (err) {
        console.warn(`   ⚠️  voice sweep failed: ${err.message}`);
        summary.errors.push({ kind: 'voice_sweep', reason: err.message });
      }
    }
  } finally {
    inFlight = false;
  }

  if (summary.catalogsSynced || summary.postsSynced || summary.campaignsSynced || summary.voiceProfilesRefreshed || summary.errors.length) {
    console.log(`⏱  scheduled-sync tick: catalogs=${summary.catalogsSynced} posts=${summary.postsSynced} campaigns=${summary.campaignsSynced} voiceRefreshed=${summary.voiceProfilesRefreshed || 0} errors=${summary.errors.length} in ${Date.now() - t0}ms`);
  }
  return summary;
}

// One-shot sweep: find brands whose derivedVoice is stale and refresh
// them with VOICE_SWEEP_CONCURRENCY so a backlog doesn't burn the OpenAI
// quota in one tick. Returns the count of refreshes attempted (success and
// skip both increment — skipped means the brand had < MIN_AD_CORPUS
// ads, so there's nothing to derive).
async function sweepStaleBrandVoices() {
  const { deriveBrandVoice, TTL_DAYS } = require('./brandVoiceDerivationService');
  const cutoff = new Date(Date.now() - TTL_DAYS * 24 * 60 * 60 * 1000);

  // Candidate brands: voice missing or stale. Limit to a sane batch
  // size per sweep so a brand backlog doesn't dominate a single tick.
  const SWEEP_BATCH = 20;
  const stale = await Brand.find({
    $or: [
      { derivedVoiceAt: null },
      { derivedVoiceAt: { $lt: cutoff } }
    ]
  }).select('_id').limit(SWEEP_BATCH).lean();
  if (!stale.length) return 0;

  // Restrict to brands that actually have ingested campaigns; without
  // those there's no corpus to derive from.
  const brandIds = stale.map(b => b._id);
  const withCampaigns = await Campaign.aggregate([
    { $match: { brandId: { $in: brandIds }, platform: { $in: AD_PLATFORMS } } },
    { $group: { _id: '$brandId' } }
  ]);
  const eligible = withCampaigns.map(r => r._id);
  if (!eligible.length) return 0;

  console.log(`🗣️  voiceSweep: refreshing ${eligible.length} brand voice profile(s)`);
  const CONCURRENCY = CONC.VOICE_SWEEP_CONCURRENCY;
  let cursor = 0;
  let refreshed = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, eligible.length) }, async () => {
    while (cursor < eligible.length) {
      const id = eligible[cursor++];
      try {
        await deriveBrandVoice(id);
        refreshed++;
      } catch (err) {
        console.warn(`   ⚠️  voiceSweep: brand=${id} failed: ${err.message}`);
      }
    }
  });
  await Promise.all(workers);
  return refreshed;
}

// Public start-up hook for the worker. Returns the interval handle so
// callers can stop it in tests.
function startScheduler() {
  console.log(`⏱  scheduled-sync started (tick every ${Math.round(TICK_INTERVAL_MS / 1000)}s)`);
  // Run once at boot for fast-path post-deploy verification.
  setTimeout(() => { runDueSyncs().catch(err => console.warn('scheduled-sync boot tick failed:', err.message)); }, 5000);
  return setInterval(() => {
    runDueSyncs().catch(err => console.warn('scheduled-sync tick failed:', err.message));
  }, TICK_INTERVAL_MS);
}

module.exports = { runDueSyncs, startScheduler };
