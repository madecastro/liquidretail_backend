// Executor for capability catalog.bulkDeleteCategories (Tier 4, brand
// scope). Same T4 rationale as catalog.bulkDeleteProducts: a bad filter
// can nuke the whole picker.
//
// TWO-PHASE Tier 4 workflow:
//   preview({ req, args })              → side-effect-free plan card
//   execute({ req, args, onProgress? }) → performs the delete
//
// Tier 4 here is a STRUCTURAL contract — routes/agent.js buckets on
// `cap.execute.workflow === true` and calls preview() while the call is
// unconfirmed, execute() after the operator confirms. The operator sees
// the resolved write set (including descendants pulled in by cascade,
// and which targets were refused) before anything is mutated.
//
// Two shapes:
//   { brandId, categoryIds: [...] }         explicit
//   { brandId, filter }                     filter DSL
//
// hardDelete:true — Mongo deleteMany after cascade cleanup.
// cascade:true — includes every descendant per delete-target. Without
// cascade, targets with live children are REPORTED in `refused[]` and
// skipped; the operation still applies to the ones that CAN safely
// be removed.
//
// Count-first cap check: resolution builds the target set (including
// any descendants under cascade:true) and refuses if it exceeds
// MAX_BULK_CATEGORIES. No partial writes on typos. The cap is
// re-checked in execute(), not just preview().

'use strict';

const mongoose = require('mongoose');
const Brand = require('../../models/Brand');
const Category = require('../../models/Category');
const {
  MAX_BULK_CATEGORIES, resolveFilter, countForQuery,
  applyProductRefFilter, findDescendantIds, cascadeCleanupOnDelete
} = require('../categoryBulkOps');

// ── SHARED RESOLUTION ────────────────────────────────────────────────
//
// Both phases run this, so the plan the operator confirms is produced
// by the same scoping, filter resolution, descendant expansion and cap
// check that then performs the write. Read-only throughout — that is
// what makes preview() safe on an unconfirmed tool_call.
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

  const hardDelete     = args?.hardDelete === true;
  const cascade        = args?.cascade === true;
  const hasCategoryIds = Array.isArray(args?.categoryIds);
  const hasFilter      = !!args?.filter;
  if (!hasCategoryIds && !hasFilter) {
    return { ok: false, error: 'either categoryIds[] or filter required' };
  }
  if (hasCategoryIds && hasFilter) {
    return { ok: false, error: 'pass EITHER categoryIds[] OR filter, not both' };
  }

  let queryResolved;
  try {
    queryResolved = resolveFilter(
      hasCategoryIds ? { categoryIds: args.categoryIds } : args.filter || {},
      { brandId: brand._id, advertiserId: req.advertiserId, includeDeleted: hardDelete }
    );
  } catch (err) {
    return { ok: false, error: `filter resolution failed: ${err.message}` };
  }
  const scoped = queryResolved.query;

  const base = {
    ok: true,
    brand,
    hardDelete,
    cascade,
    mode: hasCategoryIds ? 'explicit' : 'filter',
    warnings: queryResolved.warnings
  };

  // First-pass: resolve to concrete ids so descendant + hasProducts
  // filters can run.
  const firstPass = await Category.find(scoped).select('_id name').lean();
  let targetIds = firstPass.map((d) => String(d._id));
  const nameById = new Map(firstPass.map((d) => [String(d._id), d.name]));

  // hasProducts / hasNoProducts post-filter.
  if (queryResolved.needsProductJoin) {
    const asOids = targetIds.map((id) => new mongoose.Types.ObjectId(id));
    targetIds = (await applyProductRefFilter({
      categoryIds:   asOids,
      hasProducts:   queryResolved.filter.hasProducts === true,
      hasNoProducts: queryResolved.filter.hasNoProducts === true,
      brandId:       brand._id,
      advertiserId:  req.advertiserId
    })).map(String);
  }

  if (targetIds.length === 0) {
    return {
      ...base,
      writeSet: [],
      refused: [],
      nameById,
      note: 'no categories matched — nothing to delete'
    };
  }

  // Descendant expansion. Under cascade:true every child gets swept.
  // Without cascade, targets with children are REFUSED (reported +
  // skipped, not fatal — the safe ones still delete).
  const refused = [];
  const expandedIds = new Set(targetIds);
  for (const id of targetIds) {
    const kids = await findDescendantIds([id], { includeDeleted: hardDelete });
    if (kids.length > 0) {
      if (cascade) {
        for (const k of kids) expandedIds.add(String(k));
      } else {
        refused.push({ categoryId: id, reason: 'has-children', descendantCount: kids.length });
      }
    }
  }
  if (!cascade && refused.length > 0) {
    // Remove refused targets from the write set.
    for (const r of refused) expandedIds.delete(r.categoryId);
  }
  const writeSet = [...expandedIds];
  // Directly-matched targets that survived refusal. Anything in the
  // write set beyond these came from cascade descendant expansion —
  // the number the operator most wants to see before confirming.
  const directCount = targetIds.length - refused.length;
  const descendantsAdded = Math.max(0, writeSet.length - directCount);

  if (writeSet.length > MAX_BULK_CATEGORIES) {
    return {
      ok: false,
      error: `would delete ${writeSet.length} categories (> ${MAX_BULK_CATEGORIES}). Narrow the filter and re-run in chunks.`,
      count: writeSet.length,
      refused
    };
  }

  if (writeSet.length === 0) {
    return {
      ...base,
      writeSet: [],
      refused,
      nameById,
      note: 'every matched category has children and cascade was not set'
    };
  }

  return { ...base, writeSet, refused, nameById, descendantsAdded, note: null };
}

// ── PREVIEW ──────────────────────────────────────────────────────────

async function preview({ req, args }) {
  const plan = await resolvePlan({ req, args });
  if (!plan.ok) return plan;
  const {
    brand, hardDelete, cascade, mode, warnings,
    writeSet, refused, nameById, descendantsAdded, note
  } = plan;

  const verb = hardDelete
    ? 'PERMANENTLY delete (irreversible Mongo deleteMany)'
    : 'soft-delete (deletedAt tombstone — recoverable)';

  return {
    ok: true,
    kind: 'plan',
    data: {
      workflowId: 'catalog.bulkDeleteCategories',
      brand: { _id: String(brand._id), name: brand.name },
      summary: writeSet.length === 0
        ? `Nothing to delete under ${brand.name} — ${note}.`
        : `Will ${verb} ${writeSet.length} categor${writeSet.length === 1 ? 'y' : 'ies'} under ` +
          `${brand.name} (${mode} mode${cascade ? ', cascade ON — descendants included' : ''}). ` +
          'Cascade cleanup runs in BOTH modes: CatalogProduct.categoryRef → null, ' +
          'Media.matchedCategories pull.' +
          (refused.length ? ` ${refused.length} target(s) REFUSED (have children, cascade not set).` : ''),
      totalSteps:  writeSet.length,
      mode,
      hardDelete,
      cascade,
      reversible:  !hardDelete,
      // Non-billable — pure Mongo writes, no model/LLM call.
      estimateUsd: 0,
      // Positive only when cascade pulled in descendants beyond the
      // directly-matched targets.
      descendantsAdded: descendantsAdded || 0,
      refused,
      // Sample only — the write set can reach MAX_BULK_CATEGORIES.
      sampleSteps: writeSet.slice(0, 10).map((id) => ({
        categoryId:   id,
        categoryName: nameById.get(id) || null
      })),
      warnings,
      note: writeSet.length === 0
        ? 'Nothing to confirm.'
        : 'Write set is re-resolved at execute time — if categories change between this plan ' +
          `and your confirmation the executed count may differ, and the ${MAX_BULK_CATEGORIES} cap is ` +
          're-checked then.' +
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
  const { brand, hardDelete, cascade, mode, warnings, writeSet, refused, note } = plan;

  const emit = (payload) => {
    if (typeof onProgress !== 'function') return;
    try { onProgress(payload); } catch (_) { /* progress never fails the workflow */ }
  };

  const base = {
    brandId:   String(brand._id),
    brandName: brand.name,
    mode,
    hardDelete,
    cascade,
    warnings
  };

  if (writeSet.length === 0) {
    return {
      ok: true,
      kind: 'categoryBulkDelete',
      data: {
        ...base,
        wouldDelete:    0,
        deleted:        0,
        refused,
        cascadeSummary: { products: 0, media: 0 },
        note
      }
    };
  }

  emit({ step: 1, totalSteps: 2, phase: 'cascade-cleanup', categoryCount: writeSet.length });
  const cascadeSummary = await cascadeCleanupOnDelete(writeSet);

  emit({
    step: 2, totalSteps: 2,
    phase: hardDelete ? 'hard-delete' : 'soft-delete',
    categoryCount: writeSet.length,
    cascadeSummary
  });

  let deleted;
  if (hardDelete) {
    const r = await Category.deleteMany({ _id: { $in: writeSet }, advertiserId: req.advertiserId });
    deleted = r.deletedCount || 0;
  } else {
    const now = new Date();
    const r = await Category.updateMany(
      { _id: { $in: writeSet }, advertiserId: req.advertiserId, deletedAt: null },
      { $set: { deletedAt: now } }
    );
    deleted = r.modifiedCount || 0;
  }

  return {
    ok: true,
    kind: 'categoryBulkDelete',
    data: {
      ...base,
      wouldDelete: writeSet.length,
      deleted,
      refused,
      cascadeSummary
    }
  };
}

module.exports = { preview, execute };
