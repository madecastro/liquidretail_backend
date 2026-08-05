// Executor for capability ad.bulkArchive (Tier 1, brand scope).
//
// Archive up to 50 ads in one call. Each row is tenant-checked
// (brand.advertiserId === req.advertiserId) individually — a single
// mismatched brand does not abort the whole batch; it's recorded in
// the per-row outcomes and skipped. Idempotent per-row via
// alreadyArchived.
//
// Reversible per-row via ad.restore.

'use strict';

const mongoose = require('mongoose');
const Ad = require('../../models/Ad');
const Brand = require('../../models/Brand');

const MAX_BATCH = 50;

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const adIds = Array.isArray(args?.adIds) ? args.adIds : null;
  if (!adIds) return { ok: false, error: 'adIds must be an array' };
  if (adIds.length === 0) return { ok: false, error: 'adIds cannot be empty' };
  if (adIds.length > MAX_BATCH) {
    return { ok: false, error: `too many adIds (${adIds.length} > ${MAX_BATCH})` };
  }

  // Pre-validate ids at the top. Any invalid id fails the whole batch —
  // caller almost certainly has a bug worth surfacing.
  for (const id of adIds) {
    if (!mongoose.isValidObjectId(id)) {
      return { ok: false, error: `invalid ObjectId in adIds: "${id}"` };
    }
  }

  // Fetch ads with brandId so we can tenant-check each independently.
  const ads = await Ad.find({ _id: { $in: adIds } })
    .select('_id brandId status').lean();
  const adsById = new Map(ads.map((a) => [String(a._id), a]));

  // Resolve which brands belong to this advertiser in one query.
  const brandIds = [...new Set(ads.map((a) => String(a.brandId)))];
  const validBrands = brandIds.length === 0
    ? []
    : await Brand.find({ _id: { $in: brandIds }, advertiserId: req.advertiserId })
        .select('_id').lean();
  const validBrandSet = new Set(validBrands.map((b) => String(b._id)));

  const outcomes = [];
  const toArchive = [];

  for (const id of adIds) {
    const ad = adsById.get(String(id));
    if (!ad) {
      outcomes.push({ adId: id, status: 'not_found' });
      continue;
    }
    if (!validBrandSet.has(String(ad.brandId))) {
      // Cross-tenant leak attempt or stale UI state — treat as not
      // found (never leak "exists but not yours" to the agent output).
      outcomes.push({ adId: id, status: 'not_found' });
      continue;
    }
    if (ad.status === 'archived') {
      outcomes.push({ adId: id, status: 'already_archived' });
      continue;
    }
    toArchive.push(ad._id);
    outcomes.push({ adId: id, status: 'archived', priorStatus: ad.status });
  }

  if (toArchive.length > 0) {
    await Ad.updateMany(
      { _id: { $in: toArchive } },
      { $set: { status: 'archived', updatedAt: new Date() } }
    );
  }

  const archived = outcomes.filter((o) => o.status === 'archived').length;
  const already  = outcomes.filter((o) => o.status === 'already_archived').length;
  const missing  = outcomes.filter((o) => o.status === 'not_found').length;

  return {
    ok: true,
    kind: 'adBulkUpdate',
    data: {
      requested: adIds.length,
      archived,
      alreadyArchived: already,
      notFound: missing,
      outcomes,
      note: 'Each archive is reversible per-row via ad.restore.'
    }
  };
}

module.exports = { run };
