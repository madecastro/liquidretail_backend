// Executor for capability sales.brand.patch (Tier 1, global scope).
//
// Mirrors PATCH /api/sales-demos/brands/:id — update the Apify config
// (igHandle, shopifyUrl, method) on a demo brand. Only these three
// fields are editable; agent cannot mutate arbitrary brand fields via
// this capability (use Phase 3's brand.patch for the general surface).

'use strict';

const { findDemoBrand } = require('./_salesDemosCommon');
const { normalizeIgHandle, normalizeShopifyUrl, normalizeMethod } = require('../salesDemosService');

async function run({ req, args }) {
  const found = await findDemoBrand({ req, args });
  if (!found.ok) return found;
  const { brand } = found;

  const updates = args?.updates;
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    return { ok: false, error: 'updates required (object of allowed keys)' };
  }
  const allowed = new Set(['igHandle', 'shopifyUrl', 'method']);
  const keys = Object.keys(updates);
  if (keys.length === 0) return { ok: false, error: 'updates must contain at least one field' };
  for (const k of keys) {
    if (!allowed.has(k)) {
      return { ok: false, error: `unknown field "${k}" — allowed: ${[...allowed].join(', ')}` };
    }
  }

  const prior = {
    igHandle:   brand.apifyDemo?.igHandle   || null,
    shopifyUrl: brand.apifyDemo?.shopifyUrl || null,
    method:     brand.apifyDemo?.method     || null
  };
  if (!brand.apifyDemo) brand.apifyDemo = {};
  if ('igHandle'   in updates) brand.apifyDemo.igHandle   = normalizeIgHandle(updates.igHandle);
  if ('shopifyUrl' in updates) brand.apifyDemo.shopifyUrl = normalizeShopifyUrl(updates.shopifyUrl);
  if ('method'     in updates) {
    const m = normalizeMethod(updates.method);
    if (m) brand.apifyDemo.method = m;
  }
  const shopifyUrlChanged = 'shopifyUrl' in updates
    && (brand.apifyDemo?.shopifyUrl || null) !== (prior.shopifyUrl || null);
  if (shopifyUrlChanged) {
    brand.shopifyFontsIngestedAt = null;
    brand.shopifyFontsIngestError = null;
    brand.shopifyFontsIngestAttempts = 0;
    brand.shopifyFontsIngestNextRetryAt = null;
    brand.customFonts = (Array.isArray(brand.customFonts) ? brand.customFonts : [])
      .filter((f) => f && f.source !== 'shopify-theme');
    brand.markModified('customFonts');
  }
  brand.markModified('apifyDemo');
  await brand.save();

  if (shopifyUrlChanged && brand.apifyDemo?.shopifyUrl) {
    try {
      require('../brandEnrichmentService')
        .queueBrandEnrichment(brand._id, 'sales-brand-patch-shopifyUrl', brand.name);
    } catch (err) {
      console.warn(`sales.brand.patch: enrichment enqueue failed for "${brand.name}": ${err.message}`);
    }
  }

  return {
    ok: true,
    kind: 'brandUpdate',
    data: {
      _id: String(brand._id),
      name: brand.name,
      apifyDemo: brand.apifyDemo,
      priorApifyDemo: prior,
      note: 'Apify config updated. Run sales.brand.sync to pull with the new settings.'
    }
  };
}

module.exports = { run };
