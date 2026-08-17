// Executor for capability catalog.bulkDeleteProducts (Tier 4, brand
// scope).
//
// TWO-PHASE Tier 4 workflow:
//   preview({ req, args })              → side-effect-free plan card
//   execute({ req, args, onProgress? }) → performs the delete
//
// Tier 4 in this registry is a STRUCTURAL contract, not just a danger
// label: routes/agent.js `splitByGate` buckets on
// `cap.execute.workflow === true` and calls preview() when the call is
// unconfirmed, execute() once the operator has confirmed. A bulk delete
// is exactly the case that ceremony exists for — the operator sees the
// resolved blast radius (how many rows, which ones, reversible or not)
// BEFORE anything is mutated, rather than confirming a filter blind.
//
// Two shapes, one wins per call:
//
//   1. { brandId, productIds: [...] }
//      Explicit list — surgical removal of a known set.
//
//   2. { brandId, filter }
//      Filter-based — every product matching `filter`. Same DSL as
//      catalog.bulkPatchProducts.
//
// hardDelete:true runs cascade cleanup + Mongo deleteMany. Default is
// soft — sets deletedAt = now on every match. Cascade cleanup runs in
// BOTH modes so downstream refs (Campaign.matchedProductIds,
// Media.matchedProducts, Ad.productId) stop pointing at hidden rows.
//
// Cap: MAX_BULK_PRODUCTS (500). Resolution counts BEFORE mutating and
// refuses if the resolved set exceeds the cap — no partial writes. The
// cap is re-checked in execute(), not just preview(), so a set that
// grows between plan and confirm still cannot slip through.

'use strict';

const mongoose = require('mongoose');
const Brand = require('../../models/Brand');
const CatalogProduct = require('../../models/CatalogProduct');
const {
  MAX_BULK_PRODUCTS, resolveFilter, countForQuery, cascadeCleanupOnDelete
} = require('../catalogBulkOps');

// ── SHARED RESOLUTION ────────────────────────────────────────────────
//
// Both phases run this. Keeping it in one place means preview() cannot
// drift from what execute() will actually do — the plan the operator
// confirms is produced by the same validation, scoping, filter
// resolution and cap check that then performs the write.
//
// Read-only: no mutation happens here, which is what makes preview()
// safe to call on an unconfirmed tool_call.
async function resolvePlan({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawBrandId = args?.brandId;
  if (!rawBrandId) return { ok: false, error: 'brandId required' };
  if (!mongoose.isValidObjectId(rawBrandId)) {
    return { ok: false, error: `brandId "${rawBrandId}" is not a valid ObjectId` };
  }
  const brand = await Brand.findOne({ _id: rawBrandId, advertiserId: req.advertiserId })
    .select('_id name advertiserId').lean();
  if (!brand) return { ok: false, error: `brand ${rawBrandId} not found` };

  const hardDelete    = args?.hardDelete === true;
  const hasProductIds = Array.isArray(args?.productIds);
  const hasFilter     = !!args?.filter;
  if (!hasProductIds && !hasFilter) {
    return { ok: false, error: 'either productIds[] or filter required' };
  }
  if (hasProductIds && hasFilter) {
    return { ok: false, error: 'pass EITHER productIds[] OR filter, not both' };
  }

  // Resolve to a Mongo query via the shared DSL — same normalisation
  // in both branches so the delete flow is one code path from here.
  // hardDelete needs to see tombstones so a repeat hard-delete request
  // can pick them up; soft-delete keeps the default guard.
  let queryResolved;
  try {
    queryResolved = resolveFilter(
      hasProductIds ? { productIds: args.productIds } : args.filter || {},
      { brandId: brand._id, advertiserId: req.advertiserId, includeDeleted: hardDelete }
    );
  } catch (err) {
    return { ok: false, error: `filter resolution failed: ${err.message}` };
  }
  const scoped = queryResolved.query;

  // Count-first — refuse over-cap operations before resolving ids.
  const wouldMatch = await countForQuery(scoped);
  if (wouldMatch > MAX_BULK_PRODUCTS) {
    return {
      ok: false,
      error: `would delete ${wouldMatch} products (> ${MAX_BULK_PRODUCTS}). Narrow the filter and re-run in chunks.`,
      count: wouldMatch
    };
  }

  // Materialise the ids ONCE per phase — cascade + delete both use
  // them, and resolving from the query twice within a phase risks
  // racing an ingest that lands between the two reads. `title` rides
  // along so the plan card can name what is about to be removed.
  const docs = wouldMatch === 0
    ? []
    : await CatalogProduct.find(scoped).select('_id title').lean();

  return {
    ok: true,
    brand,
    hardDelete,
    mode: hasProductIds ? 'explicit' : 'filter',
    warnings: queryResolved.warnings,
    wouldMatch,
    docs
  };
}

// ── PREVIEW ──────────────────────────────────────────────────────────

async function preview({ req, args }) {
  const plan = await resolvePlan({ req, args });
  if (!plan.ok) return plan;
  const { brand, hardDelete, mode, warnings, wouldMatch, docs } = plan;

  const verb = hardDelete
    ? 'PERMANENTLY delete (irreversible Mongo deleteMany)'
    : 'soft-delete (deletedAt tombstone — recoverable)';

  return {
    ok: true,
    kind: 'plan',
    data: {
      workflowId: 'catalog.bulkDeleteProducts',
      brand: { _id: String(brand._id), name: brand.name },
      summary: wouldMatch === 0
        ? `No products match under ${brand.name} — nothing to delete.`
        : `Will ${verb} ${wouldMatch} product(s) under ${brand.name} (${mode} mode). ` +
          'Cascade cleanup runs in BOTH modes: Campaign.matchedProductIds pull, ' +
          'Media.matchedProducts pull, Ad.productId unset.',
      totalSteps:  wouldMatch,
      mode,
      hardDelete,
      reversible:  !hardDelete,
      // Non-billable — pure Mongo writes, no model/LLM call.
      estimateUsd: 0,
      // Sample only. The full id list can be 500 entries, which would
      // crowd the tool-result cap; the COUNT is what the confirm
      // decision turns on.
      sampleSteps: docs.slice(0, 10).map((d) => ({
        productId:   String(d._id),
        productName: d.title
      })),
      warnings,
      note: wouldMatch === 0
        ? 'Nothing to confirm.'
        : 'Blast radius is re-resolved at execute time — if the catalog changes between ' +
          `this plan and your confirmation the executed count may differ, and the ${MAX_BULK_PRODUCTS}-row ` +
          'cap is re-checked then.' +
          (hardDelete
            ? ' hardDelete=true is IRREVERSIBLE: rows are removed from Mongo, not tombstoned.'
            : ' Soft delete sets deletedAt; rows stay in Mongo and can be restored.')
    }
  };
}

// ── EXECUTE ──────────────────────────────────────────────────────────
//
// onProgress: optional callback the endpoint threads in. A bulk delete
// is two bulk Mongo operations rather than an N-step fan-out, so it
// reports two steps: cascade cleanup, then the delete itself. Never
// throws — a failing progress callback must not fail the workflow.

async function execute({ req, args, onProgress }) {
  const plan = await resolvePlan({ req, args });
  if (!plan.ok) return plan;
  const { brand, hardDelete, mode, warnings, wouldMatch, docs } = plan;

  const emit = (payload) => {
    if (typeof onProgress !== 'function') return;
    try { onProgress(payload); } catch (_) { /* progress never fails the workflow */ }
  };

  const base = {
    brandId:   String(brand._id),
    brandName: brand.name,
    mode,
    hardDelete,
    warnings
  };

  if (wouldMatch === 0) {
    return {
      ok: true,
      kind: 'productBulkDelete',
      data: {
        ...base,
        wouldMatch: 0,
        deleted:    0,
        cascade:    { campaigns: 0, media: 0, ads: 0 },
        note:       'no products matched — nothing to delete'
      }
    };
  }

  const productIds = docs.map((d) => String(d._id));

  emit({ step: 1, totalSteps: 2, phase: 'cascade-cleanup', productCount: productIds.length });
  const cascade = await cascadeCleanupOnDelete(productIds);

  emit({
    step: 2, totalSteps: 2,
    phase: hardDelete ? 'hard-delete' : 'soft-delete',
    productCount: productIds.length,
    cascade
  });

  let deleted;
  if (hardDelete) {
    const r = await CatalogProduct.deleteMany({ _id: { $in: productIds }, advertiserId: req.advertiserId });
    deleted = r.deletedCount || 0;
  } else {
    // Idempotent on soft — updateMany with deletedAt:null in the
    // filter means already-soft-deleted rows aren't touched twice.
    // Callers see `deleted` for the "actually flipped" count and
    // `wouldMatch` for the "found" count.
    const now = new Date();
    const r = await CatalogProduct.updateMany(
      { _id: { $in: productIds }, advertiserId: req.advertiserId, deletedAt: null },
      { $set: { deletedAt: now } }
    );
    deleted = r.modifiedCount || 0;
  }

  return {
    ok: true,
    kind: 'productBulkDelete',
    data: {
      ...base,
      wouldMatch,
      deleted,
      cascade
    }
  };
}

module.exports = { preview, execute };
