// Phase 4 migration: for every existing User with an advertiserId,
// create a corresponding active 'owner' AdvertiserMembership row
// if one doesn't already exist.
//
// Idempotent — safe to run multiple times. Skips users without an
// advertiserId (the Phase 1 backfill should have assigned them, but
// if any slipped through they need to run /onboarding before they
// can have a membership).
//
// Usage:
//   node server/scripts/backfillMemberships.js

require('dotenv').config();
const mongoose = require('mongoose');

const User                 = require('../models/User');
const AdvertiserMembership = require('../models/AdvertiserMembership');

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is required');
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log('🔌 connected to', mongoose.connection.host);

  const users = await User.find({ advertiserId: { $ne: null } }).lean();
  console.log(`· found ${users.length} user(s) with an advertiserId`);

  let created = 0, skipped = 0;
  for (const u of users) {
    const exists = await AdvertiserMembership.findOne({
      advertiserId: u.advertiserId,
      userId:       u._id
    }).lean();
    if (exists) {
      skipped++;
      continue;
    }
    await AdvertiserMembership.create({
      advertiserId: u.advertiserId,
      userId:       u._id,
      email:        u.email,
      role:         'owner',
      status:       'active',
      acceptedAt:   u.createdAt || new Date()
    });
    created++;
    console.log(`  ✓ created membership for ${u.email} → ${u.advertiserId} (owner)`);
  }

  console.log(`\n✓ backfill complete: ${created} created, ${skipped} already existed`);

  await mongoose.disconnect();
  console.log('🔌 disconnected');
}

main().catch(err => {
  console.error('❌ migration failed:', err);
  process.exit(1);
});
