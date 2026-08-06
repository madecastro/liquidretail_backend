// Executor for capability sales.brand.abort (Tier 1, global scope).
//
// Cooperative cancellation of an in-flight demo pipeline. Sets
// Brand.apifyDemo.aborted=true — the ingest loop reads this between
// records and bails on next check. Mirrors POST
// /api/sales-demos/brands/:id/abort. Already-ingested Media +
// CatalogProduct rows are preserved (not rolled back).

'use strict';

const { findDemoBrand } = require('./_salesDemosCommon');

async function run({ req, args }) {
  const found = await findDemoBrand({ req, args });
  if (!found.ok) return found;
  const { brand } = found;

  if (!brand.apifyDemo) brand.apifyDemo = {};
  brand.apifyDemo.aborted = true;
  brand.markModified('apifyDemo');
  await brand.save();

  return {
    ok: true,
    kind: 'brandUpdate',
    data: {
      _id: String(brand._id),
      name: brand.name,
      aborted: true,
      note: 'Abort flag set. The in-flight ingest loop reads apifyDemo.aborted between records and bails. Already-ingested Media + CatalogProduct rows are preserved.'
    }
  };
}

module.exports = { run };
