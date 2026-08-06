// Executor for capability sales.brand.create (Tier 1, global scope).
//
// Mirrors POST /api/sales-demos/brands — creates a demo Brand under
// the Sales Demos advertiser. Wraps salesDemosService.createDemoBrand,
// which sets Brand.isDemo=true + Brand.apifyDemo.{igHandle,shopifyUrl,
// method}. Caller must already be scoped to the Sales Demos advertiser
// (use sales.bootstrap first if not).

'use strict';

const { requireSalesDemosScope } = require('./_salesDemosCommon');
const { createDemoBrand } = require('../salesDemosService');

async function run({ req, args }) {
  const scope = await requireSalesDemosScope(req);
  if (!scope.ok) return scope;

  const name = String(args?.name || '').trim();
  if (!name) return { ok: false, error: 'name required' };
  if (name.length > 200) return { ok: false, error: `name too long (${name.length} > 200 chars)` };

  const igHandle   = args?.igHandle   != null ? String(args.igHandle) : null;
  const shopifyUrl = args?.shopifyUrl != null ? String(args.shopifyUrl) : null;
  const method     = args?.method     != null ? String(args.method) : null;

  try {
    const brand = await createDemoBrand({ name, igHandle, shopifyUrl, method });
    return {
      ok: true,
      kind: 'brandUpdate',
      data: {
        _id:  String(brand._id),
        name: brand.name,
        isDemo: true,
        apifyDemo: brand.apifyDemo || null,
        note: 'Demo brand created. Wire igHandle / shopifyUrl via sales.brand.patch, then run sales.brand.sync to pull data.'
      }
    };
  } catch (err) {
    return { ok: false, error: err.message || 'create demo brand failed' };
  }
}

module.exports = { run };
