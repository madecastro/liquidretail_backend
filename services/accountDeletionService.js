// Self-service account deletion.
//
// Walks every membership the user has and decides per-advertiser:
//
//   role !== 'owner'                       → revoke this membership
//   role === 'owner', other owners exist   → revoke this membership
//   role === 'owner', sole owner, no other
//     active members                       → cascade-delete the
//                                            advertiser (every brand
//                                            via cascadeDeleteBrand,
//                                            then memberships, then
//                                            the Advertiser doc)
//   role === 'owner', sole owner, OTHER
//     active members exist                 → BLOCK; require the user
//                                            to either promote a new
//                                            owner or remove the other
//                                            members first
//
// After membership work succeeds, the User row is hard-deleted.
//
// preview(userId) returns the same plan without executing — the UI
// shows it in the confirmation modal so the user understands the
// blast radius before typing their email to confirm.

const User                  = require('../models/User');
const Advertiser            = require('../models/Advertiser');
const AdvertiserMembership  = require('../models/AdvertiserMembership');
const Brand                 = require('../models/Brand');
const { cascadeDeleteBrand } = require('./cascadeDeleteService');

async function planAccountDeletion(userId) {
  const memberships = await AdvertiserMembership.find({
    userId,
    status: 'active'
  }).lean();

  const advertisersToCascade = [];   // [{ advertiserId, name, brandCount }]
  const membershipsToRevoke  = [];   // [{ advertiserId, role }]
  const blockers             = [];   // [{ advertiserId, name, otherActiveMembers }]

  // Aggregate per advertiser to bound queries even when the user is
  // a member of many advertisers.
  for (const m of memberships) {
    const isOwner = m.role === 'owner';
    if (!isOwner) {
      membershipsToRevoke.push({ advertiserId: m.advertiserId, role: m.role });
      continue;
    }
    // Sole-owner check — count OTHER active owners on this advertiser.
    const otherOwnerCount = await AdvertiserMembership.countDocuments({
      advertiserId: m.advertiserId,
      role:         'owner',
      status:       'active',
      userId:       { $ne: userId }
    });
    if (otherOwnerCount > 0) {
      membershipsToRevoke.push({ advertiserId: m.advertiserId, role: m.role });
      continue;
    }
    // Sole owner. Decide cascade vs block based on whether any other
    // active members exist (regardless of role).
    const otherActiveMembers = await AdvertiserMembership.countDocuments({
      advertiserId: m.advertiserId,
      status:       'active',
      userId:       { $ne: userId }
    });
    const adv = await Advertiser.findById(m.advertiserId).select('name slug').lean();
    if (otherActiveMembers > 0) {
      blockers.push({
        advertiserId:       String(m.advertiserId),
        name:               adv?.name || '(deleted)',
        slug:               adv?.slug || null,
        otherActiveMembers
      });
    } else {
      const brandCount = await Brand.countDocuments({ advertiserId: m.advertiserId });
      advertisersToCascade.push({
        advertiserId: String(m.advertiserId),
        name:         adv?.name || '(deleted)',
        slug:         adv?.slug || null,
        brandCount
      });
    }
  }

  return {
    canDelete:           blockers.length === 0,
    blockers,
    advertisersToCascade,
    membershipsToRevoke: membershipsToRevoke.map(m => ({
      advertiserId: String(m.advertiserId),
      role:         m.role
    }))
  };
}

async function executeAccountDeletion(userId) {
  const t0 = Date.now();
  const plan = await planAccountDeletion(userId);
  if (!plan.canDelete) {
    const err = new Error('Cannot delete account: sole-owner blockers exist');
    err.code = 'SOLE_OWNER_BLOCKED';
    err.blockers = plan.blockers;
    throw err;
  }

  // Step 1 — cascade-delete advertisers where the user is the sole
  // member. For each, walk every brand via the existing service so all
  // child artifacts + Cloudinary assets get cleaned up the same way a
  // brand-level delete would.
  const advertiserResults = [];
  for (const a of plan.advertisersToCascade) {
    const brands = await Brand.find({ advertiserId: a.advertiserId }).select('_id name').lean();
    const brandResults = [];
    for (const b of brands) {
      try {
        const r = await cascadeDeleteBrand(b._id);
        brandResults.push({ brandId: String(b._id), brandName: b.name, ok: r.ok });
      } catch (err) {
        console.warn(`   ⚠️  account-delete: brand cascade failed for ${b._id}: ${err.message}`);
        brandResults.push({ brandId: String(b._id), brandName: b.name, ok: false, error: err.message });
      }
    }
    // Remove this advertiser's memberships (the user's, plus any
    // pending/revoked rows that point at the now-deleted advertiser)
    // and the advertiser doc itself.
    const memRes = await AdvertiserMembership.deleteMany({ advertiserId: a.advertiserId });
    const advRes = await Advertiser.deleteOne({ _id: a.advertiserId });
    advertiserResults.push({
      advertiserId:        a.advertiserId,
      name:                a.name,
      brandsDeleted:       brandResults.length,
      brandResults,
      membershipsRemoved:  memRes.deletedCount || 0,
      advertiserDeleted:   advRes.deletedCount === 1
    });
  }

  // Step 2 — revoke memberships on advertisers that survive (other
  // owners exist, or user is non-owner). Soft-delete preserves the
  // audit trail per AdvertiserMembership's documented lifecycle.
  let revokedCount = 0;
  if (plan.membershipsToRevoke.length > 0) {
    const advertiserIds = plan.membershipsToRevoke.map(m => m.advertiserId);
    const r = await AdvertiserMembership.updateMany(
      { userId, advertiserId: { $in: advertiserIds }, status: 'active' },
      { $set: { status: 'revoked', revokedAt: new Date(), revokedBy: userId, updatedAt: new Date() } }
    );
    revokedCount = r.modifiedCount || 0;
  }

  // Step 3 — hard-delete the User. Pending invites that point at this
  // user's email but were never accepted live on as ghost rows; that's
  // fine — they re-bind if the email is reused on a new signup. The
  // primary identity record is gone.
  const userRes = await User.deleteOne({ _id: userId });

  console.log(`🗑️  account-delete done: user=${userId} advertisersCascaded=${advertiserResults.length} membershipsRevoked=${revokedCount} in ${Date.now() - t0}ms`);

  return {
    ok:                  true,
    userDeleted:         userRes.deletedCount === 1,
    advertisersCascaded: advertiserResults,
    membershipsRevoked:  revokedCount,
    durationMs:          Date.now() - t0
  };
}

module.exports = {
  planAccountDeletion,
  executeAccountDeletion
};
