// Executor for capability catalog.patchProduct (Tier 1, product scope).
//
// Partial update for editable CatalogProduct fields. Mirrors the route
// PATCH /api/catalog/:id but exposes ONLY the operator-safe subset —
// videoSettings is deliberately withheld from the agent path (renderer
// slug + reference count is a per-brand tuning decision, not something
// a chat operator should tweak by accident). Route keeps the fuller
// surface for the catalog editor UI.
//
// Draft promotion (draft:true → false) triggers the same retroactive
// match-link + variant collapse that the route runs, so ads that were
// waiting on the promotion pick up matchedMedia.

'use strict';

const mongoose = require('mongoose');
const CatalogProduct = require('../../models/CatalogProduct');
const catalogProductPromoteService = require('../catalogProductPromoteService');

const ALLOWED_FIELDS = new Set([
  'title', 'brand', 'category', 'price', 'currency',
  'productUrl', 'imageUrl', 'description', 'draft'
]);

const MAX_STR_LEN = 2000;   // description can run long

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawProductId = args?.productId;
  if (!rawProductId) return { ok: false, error: 'productId required' };
  if (!mongoose.isValidObjectId(rawProductId)) {
    return { ok: false, error: `productId "${rawProductId}" is not a valid ObjectId` };
  }
  const updates = args?.updates;
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    return { ok: false, error: 'updates required (object of allowed keys)' };
  }
  const keys = Object.keys(updates);
  if (keys.length === 0) return { ok: false, error: 'updates must contain at least one field' };

  const normalized = {};
  for (const key of keys) {
    if (!ALLOWED_FIELDS.has(key)) {
      return { ok: false, error: `unknown field "${key}" — allowed: ${[...ALLOWED_FIELDS].join(', ')}` };
    }
    const v = updates[key];
    if (v === null || v === '') { normalized[key] = null; continue; }
    if (key === 'draft') { normalized.draft = !!v; continue; }
    if (key === 'price') {
      const n = Number(v);
      if (!Number.isFinite(n)) {
        return { ok: false, error: `price must be a finite number or null (got ${JSON.stringify(v)})` };
      }
      normalized.price = n;
      continue;
    }
    if (typeof v !== 'string') {
      return { ok: false, error: `${key} must be a string or null` };
    }
    if (v.length > MAX_STR_LEN) {
      return { ok: false, error: `${key} too long (${v.length} > ${MAX_STR_LEN} chars)` };
    }
    normalized[key] = v.trim();
  }

  const product = await CatalogProduct.findOne({ _id: rawProductId, advertiserId: req.advertiserId });
  if (!product) return { ok: false, error: `product ${rawProductId} not found` };

  // Snapshot the draft flag BEFORE mutation so the promotion transition
  // (draft:true → false) is detectable regardless of whether the update
  // actually changed the field.
  const wasDraftBefore = product.draft === true;

  const changed = {};
  const prior = {};
  for (const [k, v] of Object.entries(normalized)) {
    if (JSON.stringify(product[k] ?? null) === JSON.stringify(v ?? null)) continue;
    prior[k] = product[k] ?? null;
    changed[k] = v;
    product[k] = v;
  }

  if (Object.keys(changed).length === 0) {
    return {
      ok: true,
      kind: 'productUpdate',
      data: { _id: String(product._id), title: product.title, noop: true, note: 'no changes to apply' }
    };
  }

  // Belt & braces: detect-identified rows should always be primary
  // variants once the operator touches them (mirrors the route's
  // legacy-rescue behaviour).
  if (product.source === 'detect-identified' && product.isPrimaryVariant === false) {
    product.isPrimaryVariant = true;
  }
  await product.save();

  // Draft promotion transition — mirrors routes/catalog.js:1008.
  const wasPromoted = wasDraftBefore && product.draft === false;
  let promotionOutcome = null;
  if (wasPromoted) {
    try {
      const res = await catalogProductPromoteService.onPromote(product.toObject());
      promotionOutcome = res || { ok: true };
    } catch (err) {
      promotionOutcome = { ok: false, error: err.message };
    }
  }

  return {
    ok: true,
    kind: 'productUpdate',
    data: {
      _id: String(product._id),
      title: product.title,
      changed,
      prior,
      promoted: wasPromoted,
      promotionOutcome,
      cacheNote: 'LayoutInputArtifact rows may still carry the OLD field values until they re-derive. Regenerate affected ads to reflect the new fields.'
    }
  };
}

module.exports = { run };
