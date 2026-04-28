// One-shot migration: ensure a default Advertiser exists, then
// backfill every existing User / Brand / Media row whose
// advertiserId is null with that default.
//
// Idempotent — safe to run repeatedly. Subsequent invocations
// re-find the existing default Advertiser and only touch rows
// that are still null.
//
// Usage:
//   node server/scripts/backfillAdvertiser.js
//
// Optional env:
//   DEFAULT_ADVERTISER_NAME — name to use for the default
//                              Advertiser (default: "Default")
//   DEFAULT_ADVERTISER_OWNER_EMAIL — owner email recorded on
//                              the default Advertiser

require('dotenv').config();
const mongoose = require('mongoose');

const Advertiser = require('../models/Advertiser');
const User       = require('../models/User');
const Brand      = require('../models/Brand');
const Media      = require('../models/Media');

const DEFAULT_NAME  = process.env.DEFAULT_ADVERTISER_NAME  || 'Default';
const DEFAULT_OWNER = process.env.DEFAULT_ADVERTISER_OWNER_EMAIL || null;

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is required');
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log('🔌 connected to', mongoose.connection.host);

  // 1. Find or create the default Advertiser.
  const slug = Advertiser.slugify(DEFAULT_NAME);
  let defaultAdv = await Advertiser.findOne({ slug });
  if (!defaultAdv) {
    defaultAdv = await Advertiser.create({
      name:       DEFAULT_NAME,
      slug,
      ownerEmail: DEFAULT_OWNER,
      plan:       'free',
      status:     'active'
    });
    console.log(`✓ created default Advertiser "${defaultAdv.name}" (slug=${defaultAdv.slug}, _id=${defaultAdv._id})`);
  } else {
    console.log(`· reusing existing default Advertiser "${defaultAdv.name}" (slug=${defaultAdv.slug}, _id=${defaultAdv._id})`);
  }

  // 2. Drop the legacy global-unique index on Brand.nameNormalized
  // if present, so the new compound (advertiserId, nameNormalized)
  // index can take over without a constraint conflict.
  try {
    const indexes = await Brand.collection.indexes();
    const legacy = indexes.find(i =>
      i.unique && i.key && Object.keys(i.key).length === 1 && i.key.nameNormalized === 1
    );
    if (legacy) {
      await Brand.collection.dropIndex(legacy.name);
      console.log(`✓ dropped legacy unique index Brand.${legacy.name}`);
    }
  } catch (err) {
    console.warn(`· could not drop legacy index (probably already gone): ${err.message}`);
  }

  // 3. Backfill rows where advertiserId is null.
  const usersTouched  = await User.updateMany({ advertiserId: null },  { $set: { advertiserId: defaultAdv._id } });
  const brandsTouched = await Brand.updateMany({ advertiserId: null }, { $set: { advertiserId: defaultAdv._id } });
  const mediaTouched  = await Media.updateMany({ advertiserId: null }, { $set: { advertiserId: defaultAdv._id } });

  console.log(`✓ backfill complete:`);
  console.log(`  · Users   touched: ${usersTouched.modifiedCount}`);
  console.log(`  · Brands  touched: ${brandsTouched.modifiedCount}`);
  console.log(`  · Media   touched: ${mediaTouched.modifiedCount}`);

  // 4. Ensure new compound index on Brand exists. Mongoose creates
  // indexes lazily on first model load; explicitly trigger here so
  // the migration leaves the schema in its final state.
  await Brand.syncIndexes();
  console.log(`✓ Brand indexes synced`);

  await mongoose.disconnect();
  console.log('🔌 disconnected');
}

main().catch(err => {
  console.error('❌ migration failed:', err);
  process.exit(1);
});
