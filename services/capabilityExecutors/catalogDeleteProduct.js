// Executor for capability catalog.deleteProduct (Tier 1, product scope).
//
// Two modes:
//   • Default (soft):  set CatalogProduct.deletedAt = now. Historical
//     ads still resolve the row by _id (renderer joins by id, not by
//     list scan), but the catalog browser, wizard picker, and Product
//     Ads page all filter it out. Reversible by setting deletedAt=null.
//   • hardDelete:true: cascade cleanup then Mongo deleteOne. Not
//     reversible; use for real cleanup of never-published rows.
//
// Cascade is applied in BOTH modes so a Product Ads page can't render
// a ghost row after soft-delete either. Ad rows keep for history but
// their productId is unset so regenerate + navigation stop resolving.

'use strict';

const mongoose = require('mongoose');
const CatalogProduct = require('../../models/CatalogProduct');
const Brand = require('../../models/Brand');
const { cascadeCleanupOnDelete } = require('../catalogBulkOps');

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const productId = args?.productId;
  if (!productId) return { ok: false, error: 'productId required' };
  if (!mongoose.isValidObjectId(productId)) {
    return { ok: false, error: `productId "${productId}" is not a valid ObjectId` };
  }
  const hardDelete = args?.hardDelete === true;

  // Tenant-scope the read — never leak that a foreign row exists.
  const product = await CatalogProduct.findOne({
    _id:          productId,
    advertiserId: req.advertiserId
  }).select('_id brandId title deletedAt').lean();
  if (!product) return { ok: false, error: `product ${productId} not found` };

  // Brand hydrate for the response — the operator wants to see WHICH
  // brand this belonged to on confirmation.
  const brand = await Brand.findById(product.brandId).select('_id name').lean();

  // Cascade cleanup runs in BOTH modes. Soft-delete without cascade
  // would still surface the id in Campaign.matchedProductIds → the
  // wizard's intersection query would resolve to a hidden row.
  const cascade = await cascadeCleanupOnDelete([productId]);

  let outcome;
  if (hardDelete) {
    await CatalogProduct.deleteOne({ _id: productId, advertiserId: req.advertiserId });
    outcome = 'hard-deleted';
  } else {
    // Idempotency-friendly — only set deletedAt if it's currently null,
    // so a re-run doesn't move the tombstone timestamp forward.
    const now = new Date();
    await CatalogProduct.updateOne(
      { _id: productId, advertiserId: req.advertiserId, deletedAt: null },
      { $set: { deletedAt: now } }
    );
    outcome = product.deletedAt ? 'already-soft-deleted' : 'soft-deleted';
  }

  return {
    ok: true,
    kind: 'productDelete',
    data: {
      productId: String(productId),
      title:     product.title || null,
      brandId:   String(product.brandId),
      brandName: brand?.name || null,
      outcome,
      hardDelete,
      cascade
    }
  };
}

module.exports = { run };
