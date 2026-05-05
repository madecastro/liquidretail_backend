// Drops legacy IntegrationCredential indexes that block re-linking
// Meta Ads / Google Ads after the schema was updated to partial
// per-account-id indexes.
//
// Symptoms before running:
//   E11000 duplicate key error collection: liquidRetail.integrationcredentials
//   index: brandId_1_type_1 dup key: { brandId: ..., type: "meta-ads" }
//
// The current schema replaces the old "one row per (brandId, type)"
// rule with partial unique indexes scoped to the platform-specific
// account id and limited to status='active'. Old indexes have to be
// dropped manually.
//
// Idempotent — already-dropped indexes are caught and ignored.
//
// Usage:
//   node server/scripts/dropLegacyIntegrationIndexes.js
//
// Also wired as a one-shot startup hook in index.js so a fresh deploy
// auto-cleans without manual intervention.

require('dotenv').config();
const mongoose = require('mongoose');

const LEGACY_INDEXES = [
  'brandId_1_type_1',
  'brandId_1_type_1_igUserId_1'
];

async function dropLegacyIntegrationIndexes(connection) {
  const conn = connection || mongoose.connection;
  const coll = conn.collection('integrationcredentials');

  let existing = [];
  try {
    existing = await coll.indexes();
  } catch (err) {
    // Collection may not exist yet on a fresh DB — nothing to drop.
    if (err && /ns does not exist|NamespaceNotFound/i.test(err.message || '')) {
      return { dropped: [], skipped: LEGACY_INDEXES, reason: 'collection-missing' };
    }
    throw err;
  }
  const existingNames = new Set(existing.map(i => i.name));

  const dropped = [];
  const skipped = [];
  for (const name of LEGACY_INDEXES) {
    if (!existingNames.has(name)) { skipped.push(name); continue; }
    try {
      await coll.dropIndex(name);
      console.log(`   · dropped legacy index ${name}`);
      dropped.push(name);
    } catch (err) {
      // 27 = IndexNotFound (race with another process); treat as already-dropped.
      if (err && (err.codeName === 'IndexNotFound' || err.code === 27)) {
        skipped.push(name);
      } else {
        console.warn(`   ⚠️  failed to drop ${name}: ${err.message}`);
      }
    }
  }
  return { dropped, skipped };
}

module.exports = dropLegacyIntegrationIndexes;

if (require.main === module) {
  (async () => {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      console.error('MONGODB_URI not set');
      process.exit(1);
    }
    await mongoose.connect(uri);
    try {
      const r = await dropLegacyIntegrationIndexes();
      console.log(`✅ legacy-index cleanup: dropped=[${r.dropped.join(', ') || '∅'}] skipped=[${r.skipped.join(', ') || '∅'}]`);
    } finally {
      await mongoose.disconnect();
    }
  })().catch(err => {
    console.error('legacy-index cleanup failed:', err);
    process.exit(1);
  });
}
