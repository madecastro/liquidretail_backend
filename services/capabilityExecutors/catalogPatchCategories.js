// Executor for capability catalog.patchCategories (Tier 1, brand scope).
//
// Per-category override edits — sets Category.videoSettings and/or
// Category.titleStyleSpec. These sit in the resolution cascade between
// the Brand-level defaults and any per-product override, so a change
// here silently reshapes every catalog product in the category. That's
// the point (tuning "Performance Shirts" as a group), but it's why the
// change note calls out that ads regenerated afterwards will look
// different.
//
// Mirrors PATCH /api/catalog/categories/:id. Both fields are Mixed on
// the schema so markModified is required after write.

'use strict';

const mongoose = require('mongoose');
const Category = require('../../models/Category');

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawCategoryId = args?.categoryId;
  if (!rawCategoryId) return { ok: false, error: 'categoryId required' };
  if (!mongoose.isValidObjectId(rawCategoryId)) {
    return { ok: false, error: `categoryId "${rawCategoryId}" is not a valid ObjectId` };
  }
  const updates = args?.updates;
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    return { ok: false, error: 'updates required (object with videoSettings and/or titleStyleSpec)' };
  }
  const keys = Object.keys(updates);
  if (keys.length === 0) return { ok: false, error: 'updates must contain at least one field' };
  const allowed = new Set(['videoSettings', 'titleStyleSpec']);
  for (const k of keys) {
    if (!allowed.has(k)) {
      return { ok: false, error: `unknown field "${k}" — allowed: videoSettings, titleStyleSpec` };
    }
  }

  // Validator shape mirrors the route. Reject invalid videoSettings /
  // titleStyleSpec up front so a bad edit never persists.
  if ('videoSettings' in updates && updates.videoSettings != null) {
    const { validateVideoSettings } = require('../atlasVideoService');
    const err = validateVideoSettings(updates.videoSettings);
    if (err) return { ok: false, error: `videoSettings invalid: ${err}` };
  }
  let normalizedTitleSpec;
  if ('titleStyleSpec' in updates && updates.titleStyleSpec != null) {
    const { validateTitleStyleSpecDoc } = require('../titleSpecValidator');
    const specRes = validateTitleStyleSpecDoc(updates.titleStyleSpec);
    if (!specRes.ok) {
      return { ok: false, error: `titleStyleSpec invalid: ${specRes.errors.slice(0, 5).join('; ')}` };
    }
    normalizedTitleSpec = specRes.normalized;
  }

  const category = await Category.findOne({ _id: rawCategoryId, advertiserId: req.advertiserId });
  if (!category) return { ok: false, error: `category ${rawCategoryId} not found` };

  const prior = {};
  const changed = {};

  for (const k of keys) {
    const v = updates[k];
    const isEmpty = v == null || v === '' || (Array.isArray(v) && v.length === 0);
    if (isEmpty) {
      if (category[k] == null) continue;
      prior[k] = category[k];
      category[k] = null;
      changed[k] = null;
    } else if (
      // SHALLOW MERGE for videoSettings — matches the route's semantics
      // so multiple partial patches don't clobber sibling keys.
      k === 'videoSettings'
      && v && typeof v === 'object' && !Array.isArray(v)
      && category.videoSettings && typeof category.videoSettings === 'object'
      && !Array.isArray(category.videoSettings)
    ) {
      prior[k] = { ...category.videoSettings };
      category.videoSettings = { ...category.videoSettings, ...v };
      changed[k] = category.videoSettings;
    } else {
      prior[k] = category[k] ?? null;
      category[k] = k === 'titleStyleSpec' ? normalizedTitleSpec : v;
      changed[k] = category[k];
    }
    category.markModified(k);
  }

  if (Object.keys(changed).length === 0) {
    return {
      ok: true,
      kind: 'categoryUpdate',
      data: { _id: String(category._id), name: category.name, noop: true, note: 'no changes to apply' }
    };
  }

  await category.save();

  return {
    ok: true,
    kind: 'categoryUpdate',
    data: {
      _id: String(category._id),
      brandId: String(category.brandId),
      name: category.name,
      breadcrumbKey: category.breadcrumbKey || null,
      changed,
      prior,
      cacheNote: 'Every catalog product under this category picks up the change on the NEXT ad generation — already-rendered ads are unaffected until they regenerate.'
    }
  };
}

module.exports = { run };
