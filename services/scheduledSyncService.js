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

const CATALOG_RESYNC_PRODUCT_SOURCES = ['shopify-direct', 'sitemap-jsonld', 'apify-shopify'];
const CATALOG_RESYNC_IN_PROGRESS_KINDS = ['catalog-sync', 'demo-sync'];
const NIGHTLY_TZ = 'America/Los_Angeles';
const DEFAULT_NIGHTLY_HOUR = 2;
const DEFAULT_NIGHTLY_WINDOW_H = 8;
// 3 concurrent brands: enough to drain a typical fleet overnight without
// opening dozens of simultaneous storefront scrapes from one worker.
// Shopify-direct paces ≥400ms/request per brand; 3 parallel brands hit
// different merchant hosts, ~7.5 rps total. Hard ceiling 8 (parser).
const DEFAULT_NIGHTLY_CONCURRENCY = 3;
const NIGHTLY_CONCURRENCY_MAX = 8;

function isCatalogScheduledResyncEnabled() {
  return process.env.CATALOG_SCHEDULED_RESYNC_ENABLED === 'true';
}

function catalogNightlyHour() {
  const raw = process.env.CATALOG_NIGHTLY_HOUR;
  if (raw == null || String(raw).trim() === '') return DEFAULT_NIGHTLY_HOUR;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 23) return DEFAULT_NIGHTLY_HOUR;
  return n;
}

function catalogNightlyWindowMs() {
  const raw = process.env.CATALOG_NIGHTLY_WINDOW_H;
  if (raw == null || String(raw).trim() === '') return DEFAULT_NIGHTLY_WINDOW_H * 3600 * 1000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_NIGHTLY_WINDOW_H * 3600 * 1000;
  if (n > 24) return 24 * 3600 * 1000;
  return n * 3600 * 1000;
}

function catalogNightlyConcurrency() {
  const raw = process.env.CATALOG_NIGHTLY_CONCURRENCY;
  if (raw == null || String(raw).trim() === '') return DEFAULT_NIGHTLY_CONCURRENCY;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_NIGHTLY_CONCURRENCY;
  return Math.min(n, NIGHTLY_CONCURRENCY_MAX);
}

function pacificParts(date, timeZone) {
  const tz = timeZone || NIGHTLY_TZ;
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  const parts = dtf.formatToParts(date instanceof Date ? date : new Date(date));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second')
  };
}

function tzOffsetMs(ms, timeZone) {
  const p = pacificParts(new Date(ms), timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - ms;
}

// Civil wall-clock in `timeZone` → UTC ms. Two-pass offset correction
// (Intl, no extra dep). Spring-forward 2am Pacific is skipped; requesting
// 02:00 that night lands on 03:00 PDT, which is the first valid instant
// ≥ 2am and is the window start we want. Fall-back 2am exists once (PST).
function zonedUtcMs(timeZone, year, month, day, hour, minute, second) {
  const tz = timeZone || NIGHTLY_TZ;
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute || 0, second || 0);
  let instant = utcGuess;
  for (let i = 0; i < 3; i += 1) {
    instant = utcGuess - tzOffsetMs(instant, tz);
  }
  return instant;
}

function addCivilDays(year, month, day, deltaDays) {
  const utc = Date.UTC(year, month - 1, day) + deltaDays * 24 * 3600 * 1000;
  const d = new Date(utc);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function nightlyWindowStartOnPacificDate(year, month, day, hour, timeZone) {
  return zonedUtcMs(timeZone || NIGHTLY_TZ, year, month, day, hour, 0, 0);
}

function currentNightlyWindowStartMs(now, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const timeZone = o.timeZone || NIGHTLY_TZ;
  const hour = Number.isInteger(o.hour) ? o.hour : catalogNightlyHour();
  const t = Number(now);
  const parts = pacificParts(new Date(t), timeZone);
  let start = nightlyWindowStartOnPacificDate(parts.year, parts.month, parts.day, hour, timeZone);
  if (t < start) {
    const y = addCivilDays(parts.year, parts.month, parts.day, -1);
    start = nightlyWindowStartOnPacificDate(y.year, y.month, y.day, hour, timeZone);
  }
  return start;
}

function isInCatalogNightlyWindow(now, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const t = Number(now);
  if (!Number.isFinite(t)) return false;
  const start = currentNightlyWindowStartMs(t, o);
  const windowMs = Number.isFinite(o.windowMs) && o.windowMs > 0
    ? o.windowMs
    : catalogNightlyWindowMs();
  return t >= start && t < start + windowMs;
}

function isCatalogResyncDue(brand, now, windowStartMs) {
  if (!brand) return false;
  const last = brand.lastCatalogResyncAt;
  if (!last) return true;
  const t = new Date(last).getTime();
  if (!Number.isFinite(t)) return true;
  const start = Number.isFinite(windowStartMs)
    ? windowStartMs
    : currentNightlyWindowStartMs(now);
  return t < start;
}

// Which catalog method a scheduled tick should run. Reuses
// apifyIngestService.resolveCatalogMethod for demo brands (the same
// ternary the live orchestrator uses). Non-demo brands are classified
// from CatalogProduct.source, then apifyDemo.method, then a store
// origin (onboarding default = shopify-direct). Returns null if this
// brand has no non-IG catalog to refresh.
function resolveScheduledCatalogMethod(brand, sourceSet) {
  const sources = sourceSet instanceof Set
    ? sourceSet
    : new Set(Array.isArray(sourceSet) ? sourceSet : []);
  const cfg = (brand && brand.apifyDemo) || {};
  if (brand && brand.isDemo && cfg.shopifyUrl) {
    return require('./apifyIngestService').resolveCatalogMethod(cfg);
  }
  if (sources.has('shopify-direct')) return 'shopify-direct';
  if (sources.has('sitemap-jsonld')) return 'generic-sitemap';
  if (sources.has('apify-shopify')) return 'apify';
  if (cfg.method && ['apify', 'generic-sitemap', 'shopify-direct'].includes(cfg.method)) {
    return require('./apifyIngestService').resolveCatalogMethod(cfg);
  }
  const origin = require('./shopifyAccessResolver').resolveStoreOrigin(brand);
  if (origin) return 'shopify-direct';
  return null;
}

function selectDueCatalogResyncCandidates(brands, sourceByBrand, now, windowStartMs) {
  const due = [];
  for (const b of brands || []) {
    if (!isCatalogResyncDue(b, now, windowStartMs)) continue;
    const key = String(b._id);
    const sources = sourceByBrand instanceof Map
      ? sourceByBrand.get(key)
      : (sourceByBrand && sourceByBrand[key]);
    const method = resolveScheduledCatalogMethod(b, sources);
    if (!method) continue;
    due.push({ brand: b, method });
  }
  due.sort((a, b) => {
    const ta = a.brand.lastCatalogResyncAt ? new Date(a.brand.lastCatalogResyncAt).getTime() : 0;
    const tb = b.brand.lastCatalogResyncAt ? new Date(b.brand.lastCatalogResyncAt).getTime() : 0;
    return ta - tb;
  });
  return due;
}

async function hasCatalogSyncInProgress(brandId) {
  if (!brandId) return false;
  const OperationRun = require('../models/OperationRun');
  const found = await OperationRun.findOne({
    brandId,
    status: { $in: ['running', 'cancelling'] },
    kind: { $in: CATALOG_RESYNC_IN_PROGRESS_KINDS }
  }).select('_id').lean();
  return !!found;
}

async function dispatchCatalogResync(brand, method) {
  if (brand.isDemo) {
    // Existing orchestrator — routes shopify-direct / generic / apify.
    // skipInstagram is the money guard: a catalog-only re-sync must not
    // fire the paid Apify IG actor as a side effect of a stamped igHandle.
    return require('./apifyIngestService').syncBrandApify(brand._id, { skipInstagram: true, uncapped: true });
  }
  const { startRun } = require('./progressService');
  const run = await startRun({
    kind: 'catalog-sync',
    advertiserId: brand.advertiserId,
    brandId: brand._id,
    label: `Catalog re-sync (scheduled, ${method})`
  });
  try {
    let result;
    if (method === 'generic-sitemap') {
      if (process.env.GENERIC_CATALOG_ENABLED === 'false') {
        const skipped = { ok: false, skipped: true, reason: 'generic-sitemap method is disabled (GENERIC_CATALOG_ENABLED=false)' };
        await run.fail(new Error(skipped.reason));
        return skipped;
      }
      result = await require('./genericCatalogIngestService')
        .syncBrandGenericCatalog(brand, run, { isBrandAborted: async () => false, uncapped: true });
    } else {
      result = await require('./shopifyPublicIngestService')
        .syncBrandShopifyDirect(brand, run, { isBrandAborted: async () => false, uncapped: true });
    }
    if (result && result.ok === false) {
      await run.fail(new Error(result.reason || 'catalog resync failed'));
      return result;
    }
    await run.succeed({
      productsUpserted: result && result.productsUpserted || 0,
      method
    });
    return result;
  } catch (err) {
    await run.fail(err);
    throw err;
  }
}

function catalogResyncProductDelta(result, isDemo) {
  if (!result) return 0;
  if (isDemo) {
    const shopify = result.shopify || {};
    return Number(shopify.added || shopify.productsUpserted || 0) || 0;
  }
  return Number(result.productsUpserted || 0) || 0;
}

function catalogResyncSucceeded(result, isDemo) {
  return !!(result
    && result.ok !== false
    && !result.skipped
    && !result.cancelled
    && !(isDemo && result.shopify && result.shopify.ok === false));
}

async function runDueCatalogResyncs(summary, now) {
  if (!isCatalogScheduledResyncEnabled()) return summary;
  if (!isInCatalogNightlyWindow(now)) return summary;

  const windowStartMs = currentNightlyWindowStartMs(now);
  // All brands — eligibility is the catalog-source aggregation + method
  // resolver, not the IG opt-in or demo-only gate. A brand with neither
  // an eligible CatalogProduct.source nor a store origin still resolves
  // method=null and is skipped.
  const brands = await Brand.find({})
    .select('_id advertiserId isDemo websiteUrl apifyDemo lastCatalogResyncAt')
    .lean();
  if (!brands.length) return summary;

  const CatalogProduct = require('../models/CatalogProduct');
  const grouped = await CatalogProduct.aggregate([
    {
      $match: {
        brandId: { $in: brands.map((b) => b._id) },
        deletedAt: null,
        source: { $in: CATALOG_RESYNC_PRODUCT_SOURCES }
      }
    },
    { $group: { _id: '$brandId', sources: { $addToSet: '$source' } } }
  ]);
  const sourceByBrand = new Map(grouped.map((g) => [String(g._id), new Set(g.sources)]));
  const due = selectDueCatalogResyncCandidates(brands, sourceByBrand, now, windowStartMs);
  if (!due.length) return summary;

  const concurrency = catalogNightlyConcurrency();
  const dispatching = [];
  for (const picked of due) {
    if (dispatching.length >= concurrency) break;
    if (await hasCatalogSyncInProgress(picked.brand._id)) continue;
    dispatching.push(picked);
  }
  if (!dispatching.length) return summary;

  // MONEY: first nights drain whatever historical "never fully synced"
  // backlog exists, persist-uncapped, across every eligible brand. No
  // extra approval gate — this is the asked behaviour — but the log
  // is the operator's view of the exposure (brand count + per-brand
  // product delta). YOLO / review-sentiment gap-fill on newly written
  // rows is unchanged and still idempotent.
  console.log(
    `⏱  catalog-nightly: windowStart=${new Date(windowStartMs).toISOString()} ` +
    `due=${due.length} dispatching=${dispatching.length} concurrency=${concurrency} ` +
    `UNCAPPED persist (CATALOG_INGEST_LIMIT bypassed this path only)`
  );

  const settled = await Promise.all(dispatching.map(async (picked) => {
    const hydrated = await Brand.findById(picked.brand._id);
    if (!hydrated) {
      return { picked, ok: false, reason: 'brand disappeared', delta: 0 };
    }
    try {
      const result = await dispatchCatalogResync(hydrated, picked.method);
      const ok = catalogResyncSucceeded(result, hydrated.isDemo);
      const delta = catalogResyncProductDelta(result, hydrated.isDemo);
      if (ok) {
        await Brand.updateOne(
          { _id: hydrated._id },
          { $set: { lastCatalogResyncAt: new Date() } }
        );
      }
      return {
        picked,
        ok,
        skipped: !!(result && result.skipped),
        reason: result && result.reason,
        delta,
        brandId: hydrated._id
      };
    } catch (err) {
      return {
        picked,
        ok: false,
        reason: err.message,
        delta: 0,
        brandId: hydrated._id
      };
    }
  }));

  for (const row of settled) {
    console.log(
      `⏱  catalog-nightly: brand=${row.brandId || row.picked.brand._id} ` +
      `method=${row.picked.method} ok=${!!row.ok} upserted=${row.delta}` +
      (row.reason ? ` reason=${row.reason}` : '')
    );
    if (row.ok) {
      summary.catalogsResynced = (summary.catalogsResynced || 0) + 1;
      summary.catalogResyncProducts = (summary.catalogResyncProducts || 0) + row.delta;
    } else if (row.reason && !row.skipped) {
      summary.errors.push({
        brandId: row.brandId || row.picked.brand._id,
        kind: 'catalog_resync',
        method: row.picked.method,
        reason: row.reason
      });
    }
  }
  return summary;
}

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
    if (!brands.length) {
      // No IG-auto-sync brands — still consider Shopify/generic/Apify
      // catalogs (demo brands, etc.). Flag-off is a no-op inside.
      try { await runDueCatalogResyncs(summary, Date.now()); } catch (err) {
        summary.errors.push({ kind: 'catalog_resync', reason: err.message });
      }
      inFlight = false;
      return summary;
    }

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
    // ── Non-IG catalog re-sync (Shopify-direct / generic / Apify) ──
    // Flag-off is a no-op so the IG loops above stay today's behaviour.
    // Nightly window (2am Pacific, 8h default): up to N brands per tick,
    // persist-uncapped, all brands with an eligible catalog source.
    // lastCatalogResyncAt is the per-window "already swept" marker so a
    // restart mid-window resumes remaining brands, not the whole fleet.
    try {
      await runDueCatalogResyncs(summary, now);
    } catch (err) {
      summary.errors.push({ kind: 'catalog_resync', reason: err.message });
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

  if (summary.catalogsSynced || summary.postsSynced || summary.campaignsSynced || summary.catalogsResynced || summary.voiceProfilesRefreshed || summary.errors.length) {
    console.log(`⏱  scheduled-sync tick: catalogs=${summary.catalogsSynced} posts=${summary.postsSynced} campaigns=${summary.campaignsSynced} catalogResync=${summary.catalogsResynced || 0} voiceRefreshed=${summary.voiceProfilesRefreshed || 0} errors=${summary.errors.length} in ${Date.now() - t0}ms`);
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

module.exports = {
  runDueSyncs,
  startScheduler,
  runDueCatalogResyncs,
  isCatalogScheduledResyncEnabled,
  catalogNightlyHour,
  catalogNightlyWindowMs,
  catalogNightlyConcurrency,
  pacificParts,
  zonedUtcMs,
  currentNightlyWindowStartMs,
  isInCatalogNightlyWindow,
  isCatalogResyncDue,
  resolveScheduledCatalogMethod,
  selectDueCatalogResyncCandidates,
  hasCatalogSyncInProgress,
  dispatchCatalogResync,
  CATALOG_RESYNC_PRODUCT_SOURCES,
  CATALOG_RESYNC_IN_PROGRESS_KINDS,
  NIGHTLY_TZ,
  DEFAULT_NIGHTLY_HOUR,
  DEFAULT_NIGHTLY_WINDOW_H,
  DEFAULT_NIGHTLY_CONCURRENCY
};
