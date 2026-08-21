// Sales Demos — helpers for the internal-sales-only "demo brand" flow.
// A single top-level Advertiser (slug: 'sales-demos') owns every demo
// Brand. Sales reps are given membership to that Advertiser so they
// can create/tear down prospect demos without touching real customer
// tenants.
//
// A demo Brand differs from a real Brand only in two fields:
//   isDemo: true              — filter flag used by customer-facing
//                                brand lists to hide demo rows
//   apifyDemo: { ... }        — public IG handle + Shopify store URL
//                                used by apifyPullService instead of
//                                an OAuth-backed IntegrationCredential
//
// The rest of the Brand + downstream detect / ad-gen path is unchanged,
// so demo brands go through the exact same pipeline as real brands.

const Advertiser = require('../models/Advertiser');
const Brand      = require('../models/Brand');
const { normalizeBrandName } = require('../models/Brand');

const SALES_DEMOS_SLUG = 'sales-demos';
const SALES_DEMOS_NAME = 'Sales Demos';

// Idempotent get-or-create of the Sales Demos advertiser. Called
// lazily by any code that needs it (route handlers, admin scripts) so
// no startup migration is required — first demo creation seeds it.
async function ensureSalesDemosAdvertiser() {
  let adv = await Advertiser.findOne({ slug: SALES_DEMOS_SLUG });
  if (adv) return adv;
  adv = await Advertiser.create({
    name: SALES_DEMOS_NAME,
    slug: SALES_DEMOS_SLUG,
    plan: 'enterprise',   // no billing implications; keeps it out of trial-based filters
    status: 'active'
  });
  return adv;
}

// Normalize a user-entered IG handle: strip leading '@', trim, lower.
// Empty string / null → null.
function normalizeIgHandle(raw) {
  if (!raw) return null;
  const cleaned = String(raw).trim().replace(/^@+/, '').toLowerCase();
  return cleaned || null;
}

// Catalog ingest method for demo brands. 'shopify-direct' (default when
// a shopifyUrl is present) hits the public products.json path; 'apify'
// keeps the legacy Apify shopify-scraper; 'generic-sitemap' runs the
// client-agnostic XML-sitemap + JSON-LD scraper for non-Shopify
// server-rendered stores (reuses shopifyUrl as the target URL). Invalid
// values → null so callers can ignore them without clobbering the stored
// method. Keep this allowlist in sync with the Brand.apifyDemo.method enum.
function normalizeMethod(raw) {
  if (!raw) return null;
  const m = String(raw).trim().toLowerCase();
  return (m === 'shopify-direct' || m === 'apify' || m === 'generic-sitemap') ? m : null;
}

// Normalize a Shopify store URL to a canonical form. Accepts bare
// hostnames ("brand.myshopify.com") or full URLs. Returns null when
// the input isn't URL-shaped enough to be useful.
function normalizeShopifyUrl(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    return `${u.protocol}//${u.hostname}${u.pathname === '/' ? '' : u.pathname}`.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

// Create a demo Brand under the Sales Demos advertiser. Idempotent on
// (advertiserId, nameNormalized) via Brand's existing compound index —
// re-creating with the same name updates the apifyDemo config.
// Optional `method` ('shopify-direct' | 'apify') selects the catalog
// source; invalid values are ignored. On INSERT, defaults to
// shopify-direct when a shopifyUrl is present, else apify.
async function createDemoBrand({ name, igHandle, shopifyUrl, method }) {
  if (!name || !String(name).trim()) {
    const e = new Error('Demo brand name is required');
    e.status = 400;
    throw e;
  }
  const adv = await ensureSalesDemosAdvertiser();
  const trimmedName = String(name).trim();
  const nameNormalized = normalizeBrandName(trimmedName);

  const normalizedUrl    = normalizeShopifyUrl(shopifyUrl);
  const normalizedMethod = normalizeMethod(method);

  const update = {
    $setOnInsert: {
      advertiserId:   adv._id,
      name:           trimmedName,
      nameNormalized,
      isDemo:         true,
      source:         'stub'
    },
    // Only write the fields the caller actually provided — an
    // idempotent re-create with just {name, method} must not null out
    // a stored igHandle/shopifyUrl (adversarial-review find).
    $set: {}
  };
  if (igHandle   !== undefined) update.$set['apifyDemo.igHandle']   = normalizeIgHandle(igHandle);
  if (shopifyUrl !== undefined) update.$set['apifyDemo.shopifyUrl'] = normalizedUrl;
  // method: explicit valid value → $set (applies to insert AND update).
  // Otherwise default it on INSERT ONLY. The same path must never sit
  // in both $set and $setOnInsert — MongoDB rejects that update
  // outright as a path conflict (adversarial-review critical).
  if (normalizedMethod) {
    update.$set['apifyDemo.method'] = normalizedMethod;
  } else {
    update.$setOnInsert['apifyDemo.method'] = normalizedUrl ? 'shopify-direct' : 'apify';
  }
  if (!Object.keys(update.$set).length) delete update.$set;
  const brand = await Brand.findOneAndUpdate(
    { advertiserId: adv._id, nameNormalized },
    update,
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return brand;
}

// Comma-separated allowlist of emails permitted to bootstrap the Sales
// Demos workspace via POST /api/sales-demos/bootstrap. Additional reps
// are added via the normal /api/members invite flow after the first
// admin lands. Case-insensitive.
//
// Super-admins (SUPER_ADMIN_EMAILS) are ALSO accepted here by design —
// keeping two parallel lists in sync would drift the moment a new
// super-admin is promoted, and the owner's stated invariant is "any
// super admin should have access to sales-demos". A user only needs to
// appear on ONE of the two lists to bootstrap.
function isAllowedBootstrapper(email) {
  if (!email) return false;
  const { isSuperAdminEmail } = require('./superAdminService');
  if (isSuperAdminEmail(email)) return true;
  const raw = process.env.SALES_DEMOS_ADMINS || '';
  const allow = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return allow.includes(String(email).trim().toLowerCase());
}

module.exports = {
  SALES_DEMOS_SLUG,
  SALES_DEMOS_NAME,
  ensureSalesDemosAdvertiser,
  normalizeIgHandle,
  normalizeShopifyUrl,
  normalizeMethod,
  createDemoBrand,
  isAllowedBootstrapper
};
