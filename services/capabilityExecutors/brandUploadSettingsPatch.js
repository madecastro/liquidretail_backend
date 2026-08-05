// Executor for capability brand.uploadSettings.patch (Tier 1, brand scope).
//
// Update Brand.uploadSettings — currently just autoCreateFromDetect
// (Upload-6). Off by default: confident detect matches don't
// auto-write draft CatalogProduct rows unless the operator explicitly
// opts in.

'use strict';

const mongoose = require('mongoose');
const Brand = require('../../models/Brand');

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawBrandId = args?.brandId;
  if (!rawBrandId) return { ok: false, error: 'brandId required' };
  if (!mongoose.isValidObjectId(rawBrandId)) {
    return { ok: false, error: `brandId "${rawBrandId}" is not a valid ObjectId` };
  }

  const settings = args?.settings;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return { ok: false, error: 'settings required (object)' };
  }
  const hasAuto = Object.prototype.hasOwnProperty.call(settings, 'autoCreateFromDetect');
  if (!hasAuto) {
    return { ok: false, error: 'settings must include at least one supported key: autoCreateFromDetect' };
  }
  if (hasAuto && typeof settings.autoCreateFromDetect !== 'boolean') {
    return { ok: false, error: 'autoCreateFromDetect must be a boolean' };
  }

  const brand = await Brand.findOne({ _id: rawBrandId, advertiserId: req.advertiserId });
  if (!brand) return { ok: false, error: `brand ${rawBrandId} not found` };

  const priorSettings = brand.uploadSettings || {};
  const nextSettings = { ...priorSettings };
  if (hasAuto) nextSettings.autoCreateFromDetect = settings.autoCreateFromDetect;

  if (JSON.stringify(nextSettings) === JSON.stringify(priorSettings)) {
    return {
      ok: true,
      kind: 'brandUpdate',
      data: {
        _id: String(brand._id),
        name: brand.name,
        uploadSettings: nextSettings,
        noop: true,
        note: 'no changes to apply'
      }
    };
  }

  brand.uploadSettings = nextSettings;
  brand.markModified('uploadSettings');
  await brand.save();

  return {
    ok: true,
    kind: 'brandUpdate',
    data: {
      _id:  String(brand._id),
      name: brand.name,
      uploadSettings: brand.uploadSettings,
      priorSettings
    }
  };
}

module.exports = { run };
