// Executor for capability sales.bootstrap (Tier 1, global scope).
//
// Mirrors POST /api/sales-demos/bootstrap — for a user on the
// SALES_DEMOS_ADMINS allowlist, seed the Sales Demos advertiser row
// (if absent) and grant the caller an active owner membership. Runs
// even when req.advertiserId is NOT the sales-demos advertiser — this
// is the way IN to that advertiser, so the standard scope guard would
// deadlock. Only the email allowlist gates access.

'use strict';

const AdvertiserMembership = require('../../models/AdvertiserMembership');
const { ensureSalesDemosAdvertiser, isAllowedBootstrapper } = require('../salesDemosService');

async function run({ req }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const email = req.user?.email;
  const userId = req.user?.userId;
  if (!email || !userId) {
    return { ok: false, error: 'no user context on request — auth middleware did not run' };
  }
  if (!isAllowedBootstrapper(email)) {
    return {
      ok: false,
      error: 'email is not on the SALES_DEMOS_ADMINS allowlist',
      code:  'NOT_ALLOWLISTED'
    };
  }

  const adv = await ensureSalesDemosAdvertiser();
  const existing = await AdvertiserMembership.findOne({ advertiserId: adv._id, userId });
  let membership;
  if (existing) {
    let changed = false;
    if (existing.role !== 'owner')    { existing.role   = 'owner';   changed = true; }
    if (existing.status !== 'active') { existing.status = 'active';  existing.acceptedAt = existing.acceptedAt || new Date(); changed = true; }
    if (changed) await existing.save();
    membership = existing;
  } else {
    membership = await AdvertiserMembership.create({
      advertiserId: adv._id,
      userId,
      email,
      role:         'owner',
      status:       'active',
      acceptedAt:   new Date()
    });
  }

  return {
    ok: true,
    kind: 'advertiserJoin',
    data: {
      advertiserId:   String(adv._id),
      advertiserSlug: adv.slug,
      advertiserName: adv.name,
      membershipId:   String(membership._id),
      role:           membership.role,
      note: 'You now hold an active owner membership on Sales Demos. Switch to that advertiser context to invoke sales.* capabilities.'
    }
  };
}

module.exports = { run };
