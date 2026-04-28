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

const META_API_VERSION = process.env.META_API_VERSION || 'v19.0';
const META_GRAPH_ROOT  = `https://graph.facebook.com/${META_API_VERSION}`;

// Hard cap so a runaway catalog doesn't spin forever inside an HTTP
// request. Brands with > 500 SKUs need V2 background sync; typical
// IG Commerce catalogs are well under this.
const MAX_ITEMS = 500;
const PAGE_SIZE = 100;
const FIELDS = [
  'id', 'retailer_id', 'name', 'description', 'brand', 'category',
  'price', 'currency', 'availability', 'image_url',
  'additional_image_urls', 'url',
  // V3 #2 dedup signals — Meta only fills these when the merchant
  // submitted them. gtin is the canonical barcode (EAN/UPC); mpn is
  // the manufacturer part number used as fallback.
  'gtin', 'mpn'
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

  // Multi-credential path: aggregate per-credential results.
  if (creds.length > 1 && !options.credentialId) {
    const aggregated = { ok: true, fetched: 0, added: 0, updated: 0, errors: 0, totalCount: 0, perCredential: [] };
    for (const c of creds) {
      const r = await syncCatalogForCred(c);
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
    return aggregated;
  }

  // Single-credential path.
  const result = await syncCatalogForCred(creds[0]);
  result.durationMs = Date.now() - t0;
  return result;
}

async function syncCatalogForCred(cred) {
  const t0 = Date.now();
  const brandId = cred.brandId;
  if (!cred.catalogId) return { ok: false, reason: `credential ${cred._id} has no catalogId` };

  let token;
  try { token = decrypt(cred.accessTokenEnc); }
  catch (err) { return { ok: false, reason: `token decrypt failed: ${err.message}` }; }

  console.log(`📦 catalog sync starting: brand=${brandId} catalog=${cred.catalogId} (cred=${cred._id})`);

  let url = `${META_GRAPH_ROOT}/${cred.catalogId}/products`;
  let params = { fields: FIELDS, limit: PAGE_SIZE, access_token: token };
  let added = 0, updated = 0, errors = 0, fetched = 0;

  while (url && fetched < MAX_ITEMS) {
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
    for (const item of items) {
      const externalId = String(item.id || '').trim();
      if (!externalId) { errors++; continue; }

      const update = {
        advertiserId:    cred.advertiserId,
        brandId:         cred.brandId,
        source:          'ig-catalog',
        externalId,
        retailerId:      item.retailer_id || null,
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
        additionalImages: Array.isArray(item.additional_image_urls)
                          ? item.additional_image_urls.slice(0, 8) : [],
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
      } catch (err) {
        console.warn(`   ⚠️  upsert failed for ${externalId}: ${err.message}`);
        errors++;
      }
    }

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
