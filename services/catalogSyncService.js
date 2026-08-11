// Meta Catalog → CatalogProduct sync. Loads the active IG credential
// for a Brand, decrypts the access token, paginates the catalog
// products endpoint, and upserts CatalogProduct rows keyed on
// (brandId, externalId).
//
// Idempotent: reruns refresh existing rows in place. Items removed
// from the source catalog are NOT deleted automatically (V2: add
// availability='archived' on missing rows so we can age them out).

const axios = require('axios');

const IntegrationCredential = require('../models/IntegrationCredential');
const CatalogProduct = require('../models/CatalogProduct');
const { decrypt } = require('./integrationCryptoService');
const { inferCoarseEnum, resolveCoarseCategoryRef } = require('./categoryClassifier');
const { startRun, CancelledError } = require('./progressService');
const { concurrency: CONC } = require('./concurrency');

const META_API_VERSION = process.env.META_API_VERSION || 'v19.0';
const META_GRAPH_ROOT  = `https://graph.facebook.com/${META_API_VERSION}`;

// Shared per-product alt-image cap (hero is separate). Zero-dep module —
// Meta catalog sync has nothing to do with web scraping and must not
// pull the scraper stack just to read an integer. See catalogImageLimits.
const { MAX_ADDITIONAL_IMAGES } = require('./catalogImageLimits');

// Hard cap so a runaway catalog doesn't spin forever inside an HTTP
// request. Brands with > 500 SKUs need V2 background sync; typical
// IG Commerce catalogs are well under this. Env-overridable
// (CATALOG_SYNC_MAX_ITEMS) so smoke tests can cap to a smaller set
// without a code change.
const MAX_ITEMS = Math.max(1, parseInt(process.env.CATALOG_SYNC_MAX_ITEMS, 10) || 500);
const PAGE_SIZE = Math.min(100, MAX_ITEMS);
const FIELDS = [
  'id', 'retailer_id', 'name', 'description', 'brand', 'category',
  'price', 'currency', 'availability', 'image_url',
  'additional_image_urls', 'url',
  // V3 #2 dedup signals — Meta only fills these when the merchant
  // submitted them. gtin is the canonical barcode (EAN/UPC); mpn is
  // the manufacturer part number used as fallback.
  'gtin', 'mpn',
  // Variant grouping — Shopify-via-Meta sets this id to the shared
  // parent product across size/color/scent variants. Used by detect
  // enqueue to collapse the per-variant fanout.
  'item_group_id'
].join(',');

// Meta returns price as a string like "29.99 USD". Strip the trailing
// currency token if present and return a Number.
function parsePrice(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return raw;
  const s = String(raw).trim();
  const m = s.match(/^([\d.]+)/);
  return m ? Number(m[1]) : null;
}

// Normalize gtin to a clean digit string. Meta sometimes returns it
// with whitespace, stringified numbers with leading zeros, or even
// empty strings. Returns null when there's nothing usable.
function normalizeGtin(raw) {
  if (raw == null) return null;
  const cleaned = String(raw).trim().replace(/[^\d]/g, '');
  // Valid GTINs are 8/12/13/14 digits (UPC-A/E, EAN-13, ITF-14).
  // Reject anything outside that range — likely junk.
  if (![8, 12, 13, 14].includes(cleaned.length)) return null;
  return cleaned;
}

// Pull currency out of either the explicit `currency` field or the
// trailing token of a "29.99 USD"-style price string.
function parseCurrency(rawPrice, rawCurrency) {
  if (rawCurrency) return String(rawCurrency).toUpperCase();
  if (typeof rawPrice === 'string') {
    const m = rawPrice.match(/[A-Z]{3}\s*$/);
    if (m) return m[0].trim();
  }
  return null;
}

// Public entry — V2 #5 multi-page aware. When options.credentialId is
// set, sync just that one credential; otherwise iterate every active
// IG credential for the brand that has a catalogId. Aggregates the
// per-credential results.
async function syncCatalog(brandId, options = {}) {
  const t0 = Date.now();
  const credFilter = {
    brandId, type: 'instagram', status: 'active', catalogId: { $exists: true, $ne: null }
  };
  if (options.credentialId) credFilter._id = options.credentialId;

  const creds = await IntegrationCredential.find(credFilter);
  if (!creds.length) {
    return { ok: false, reason: options.credentialId
        ? 'credential not found or has no catalogId'
        : 'no active Instagram credential with a catalogId for this brand' };
  }

  // Unified progress row (ActivityDock) — cancellable at page/item
  // boundaries. options.run lets an orchestrator (scheduler sweep)
  // supply its own handle; otherwise the sync owns one.
  const run = options.run
    || await startRun({
      kind: 'catalog-sync',
      advertiserId: creds[0].advertiserId,
      brandId,
      label: options.label || 'Catalog sync',
      meta: { credentialCount: creds.length }
    });
  const ownRun = !options.run;

  try {
    // Multi-credential path: aggregate per-credential results.
    if (creds.length > 1 && !options.credentialId) {
      const aggregated = { ok: true, fetched: 0, added: 0, updated: 0, errors: 0, totalCount: 0, perCredential: [] };
      for (const c of creds) {
        await run.checkpoint();
        run.stage(`syncing @${c.igUsername || c._id}`);
        const r = await syncCatalogForCred(c, run);
        aggregated.perCredential.push({ credentialId: String(c._id), igUsername: c.igUsername, ...r });
        if (r.ok) {
          aggregated.fetched += r.fetched || 0;
          aggregated.added   += r.added   || 0;
          aggregated.updated += r.updated || 0;
          aggregated.errors  += r.errors  || 0;
          aggregated.totalCount = r.totalCount; // last wins; total is brand-wide either way
        }
      }
      aggregated.durationMs = Date.now() - t0;
      if (ownRun) await run.succeed({ fetched: aggregated.fetched, added: aggregated.added, updated: aggregated.updated });
      return aggregated;
    }

    // Single-credential path.
    run.stage('syncing catalog');
    const result = await syncCatalogForCred(creds[0], run);
    result.durationMs = Date.now() - t0;
    if (ownRun) {
      if (result.ok) await run.succeed({ fetched: result.fetched, added: result.added, updated: result.updated });
      else await run.fail(new Error(result.reason || 'sync failed'));
    }
    return result;
  } catch (err) {
    if (err instanceof CancelledError) {
      // Graceful stop: everything upserted so far stays; the run row is
      // already marked cancelled by checkpoint(). The credential's
      // lastCatalogSyncAt was NOT stamped, so the scheduler retries later.
      console.log(`📦 catalog sync cancelled by operator: brand=${brandId}`);
      return { ok: false, cancelled: true, reason: 'cancelled by operator', durationMs: Date.now() - t0 };
    }
    if (ownRun) await run.fail(err);
    throw err;
  }
}

async function syncCatalogForCred(cred, run = null) {
  const t0 = Date.now();
  const brandId = cred.brandId;
  if (!cred.catalogId) return { ok: false, reason: `credential ${cred._id} has no catalogId` };
  // Progress is optional — direct callers without a run get a no-op.
  const progress = run || { stage: () => {}, tick: () => {}, checkpoint: async () => true };

  let token;
  try { token = decrypt(cred.accessTokenEnc); }
  catch (err) { return { ok: false, reason: `token decrypt failed: ${err.message}` }; }

  console.log(`📦 catalog sync starting: brand=${brandId} catalog=${cred.catalogId} (cred=${cred._id})`);

  let url = `${META_GRAPH_ROOT}/${cred.catalogId}/products`;
  let params = { fields: FIELDS, limit: PAGE_SIZE, access_token: token };
  let added = 0, updated = 0, errors = 0, fetched = 0;

  while (url && fetched < MAX_ITEMS) {
    // Cooperative cancel boundary: between pages (and every 25 items
    // below). Throws CancelledError — syncCatalog handles it; partial
    // upserts stay in Mongo.
    await progress.checkpoint();
    let res;
    try {
      res = await axios.get(url, { params, timeout: 20000 });
    } catch (err) {
      const detail = err.response?.data?.error?.message || err.message;
      console.warn(`   ⚠️  catalog page fetch failed: ${detail}`);
      // Auth / catalog-not-found is fatal; transient is recoverable.
      const code = err.response?.data?.error?.code;
      if (code === 190 || code === 200 || code === 100) {
        return { ok: false, reason: `Meta error: ${detail}`, added, updated, errors, fetched };
      }
      errors++;
      break;
    }

    const items = res.data?.data || [];
    fetched += items.length;
    let pageIdx = 0;
    for (const item of items) {
      if (++pageIdx % 25 === 0) await progress.checkpoint();
      const externalId = String(item.id || '').trim();
      if (!externalId) { errors++; continue; }

      const update = {
        advertiserId:    cred.advertiserId,
        brandId:         cred.brandId,
        source:          'ig-catalog',
        externalId,
        retailerId:      item.retailer_id || null,
        itemGroupId:     item.item_group_id ? String(item.item_group_id).trim() || null : null,
        // V3 #2 dedup keys — normalized so cross-tenant lookups
        // match regardless of formatting (Meta sometimes wraps gtin
        // in whitespace or pads with leading zeros).
        gtin:            normalizeGtin(item.gtin),
        mpn:             item.mpn ? String(item.mpn).trim() || null : null,
        title:           item.name || '(untitled)',
        description:     item.description || null,
        brand:           item.brand || null,
        category:        item.category || null,
        price:           parsePrice(item.price),
        currency:        parseCurrency(item.price, item.currency),
        availability:    item.availability || null,
        imageUrl:        item.image_url || null,
        // Meta's additional_image_urls is ALREADY the alt list (hero is
        // image_url), so slice from 0 — not the hero-offset form used on
        // Shopify/JSON-LD combined arrays. Cap = MAX_ADDITIONAL_IMAGES
        // (shared; see catalogImageLimits).
        additionalImages: Array.isArray(item.additional_image_urls)
                          ? item.additional_image_urls.slice(0, MAX_ADDITIONAL_IMAGES)
                          : [],
        productUrl:      item.url || null,
        rawData:         item,
        lastSyncedAt:    new Date()
      };

      try {
        const result = await CatalogProduct.findOneAndUpdate(
          { brandId: cred.brandId, externalId },
          { $set: update, $setOnInsert: { firstSeenAt: new Date() } },
          { upsert: true, new: true, rawResult: true }
        );
        // updatedExisting=false means this was an insert.
        if (result?.lastErrorObject?.updatedExisting) updated++;
        else                                          added++;

        // Stamp a COARSE Category leaf on rows that don't already have
        // a fine-grained categoryRef. Heuristic on Meta's category +
        // title — best-effort; nothing breaks if it can't classify.
        // This is what makes findCatalogMatchByText's pre-match filter
        // hit on freshly-synced rows. Match-time productCategoryService
        // later upgrades this to a fine-grained descendant leaf when
        // the row wins a real match.
        const row = result.value || result;
        if (row && !row.categoryRef) {
          try {
            const enumCategory = inferCoarseEnum(item.category, item.name);
            if (enumCategory) {
              const coarseRef = await resolveCoarseCategoryRef({
                brandId:      cred.brandId,
                advertiserId: cred.advertiserId,
                enumCategory
              });
              if (coarseRef) {
                await CatalogProduct.updateOne(
                  { _id: row._id, $or: [{ categoryRef: null }, { categoryRef: { $exists: false } }] },
                  { $set: { categoryRef: coarseRef } }
                );
              }
            }
          } catch (err) {
            // Best-effort — never let category stamping break a sync.
            console.warn(`   ⚠️  coarse-category stamp failed for ${externalId}: ${err.message}`);
          }
        }
      } catch (err) {
        console.warn(`   ⚠️  upsert failed for ${externalId}: ${err.message}`);
        errors++;
      }
    }

    // Total is unknown until Meta stops paginating — report count-so-far
    // (the dock renders an indeterminate bar with a live counter).
    progress.tick(fetched, null, `${added} added · ${updated} updated${errors ? ` · ${errors} errors` : ''}`);

    const next = res.data?.paging?.next;
    if (next && fetched < MAX_ITEMS) {
      // Use the absolute `next` URL Meta gives us — it contains the
      // cursor and all required params, so we drop our `params` and
      // pass null below.
      url = next;
      params = null;
    } else {
      url = null;
    }
  }

  // Update credential last-used + last-catalog-sync so the scheduler
  // knows when this tier last completed.
  cred.lastUsedAt = new Date();
  cred.lastCatalogSyncAt = new Date();
  await cred.save();

  const totalCount = await CatalogProduct.countDocuments({ brandId, source: 'ig-catalog' });
  console.log(`📦 catalog sync done: brand=${brandId} fetched=${fetched} added=${added} updated=${updated} errors=${errors} total=${totalCount} in ${Date.now() - t0}ms`);

  // Trigger the product-path detect pipeline for any product that
  // doesn't yet have an imageMediaId. Each product gets one DetectRun
  // for the hero + up to MAX_ALT_IMAGES alt runs. Idempotent — re-syncs
  // skip products whose imageMediaId is already populated.
  progress.stage('queueing product detects');
  try {
    const { enqueueBrandProductDetects } = require('./catalogProductDetectService');
    await enqueueBrandProductDetects(brandId);
  } catch (err) {
    console.warn(`   ⚠️  product-path detect enqueue failed: ${err.message}`);
  }

  // Eager review + commerce enrichment (Phase: catalog-sync-enrichment).
  // Walks the brand's products and fires productReviews + productDetails
  // for any row that's missing them OR has stale (>30d) cache. Both
  // downstream services are idempotent on their caches so re-running on
  // a fully-cached brand is a no-op. Fire-and-forget — the sync HTTP
  // response shouldn't block on review/SerpAPI calls (cold-cache enrich
  // of 100 products at concurrency=3 takes ~5–8 minutes).
  // enqueueBrandProductEnrichment leads with the free on-site review
  // scrape (productReviewsScrapeService) and only then pays for the
  // web-wide gap-fill — the Meta/Shopify-auth path has no PDP crawl of
  // its own, so that scrape is where its first-party reviews come from.
  setImmediate(() => {
    require('./catalogProductEnrichmentService')
      .enqueueBrandProductEnrichment(brandId)
      .catch(err => console.warn(`   ⚠️  catalog enrichment enqueue failed: ${err.message}`));
  });

  // JSON-LD category inference. Scrapes each product's productUrl for
  // BreadcrumbList structured data and builds the Category tree from
  // the brand's actual site collections — far richer than Meta's coarse
  // category enum. Fire-and-forget; the inference service throttles
  // per-domain and respects a 14-day TTL so re-syncs are cheap.
  setImmediate(() => {
    (async () => {
      try {
        const inference = require('./productCategoryInferenceService');
        // NOTE: not { $ne: null, …, $ne: '' } — duplicate keys in a JS
        // object literal keep only the LAST one, so the null exclusion
        // was silently dropped and null productUrls reached inferBatch.
        const candidates = await CatalogProduct.find({
          brandId,
          productUrl: { $exists: true, $nin: [null, ''] },
          $or: [
            { inferredCategoryAt: null },
            { inferredCategoryAt: { $lt: new Date(Date.now() - inference.TTL_DAYS * 24 * 60 * 60 * 1000) } }
          ]
        }).select('_id').lean();
        if (!candidates.length) return;
        console.log(`🔎 categoryInference: brand=${brandId} scheduling ${candidates.length} product page scrapes`);
        const result = await inference.inferBatch(candidates.map(c => c._id), { concurrency: CONC.CATEGORY_INFERENCE_BATCH_CONCURRENCY });
        console.log(`🔎 categoryInference: brand=${brandId} done — ok=${result.ok} cfChallenged=${result.challenged || 0} skipped=${result.skipped} failed=${result.failed}`);
      } catch (err) {
        console.warn(`   ⚠️  category inference enqueue failed: ${err.message}`);
      }
    })();
  });

  return {
    ok: true,
    fetched,
    added,
    updated,
    errors,
    totalCount,
    cappedAt: fetched >= MAX_ITEMS ? MAX_ITEMS : null,
    durationMs: Date.now() - t0
  };
}

// Quick stats endpoint for the brand page header.
async function getCatalogStatus(brandId) {
  const [cred, count, latest] = await Promise.all([
    IntegrationCredential.findOne({ brandId, type: 'instagram', status: 'active' }).lean(),
    CatalogProduct.countDocuments({ brandId, source: 'ig-catalog' }),
    CatalogProduct.findOne({ brandId, source: 'ig-catalog' }).sort({ lastSyncedAt: -1 }).select('lastSyncedAt').lean()
  ]);
  return {
    connected:    !!cred,
    catalogId:    cred?.catalogId || null,
    itemCount:    count,
    lastSyncedAt: latest?.lastSyncedAt || null
  };
}

module.exports = { syncCatalog, getCatalogStatus };
