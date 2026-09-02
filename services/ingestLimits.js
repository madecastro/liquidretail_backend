// Universal ingest caps (2026-09-02). Two knobs bounding how many rows
// each per-brand sync writes to the catalog / post collections:
//
//   CATALOG_INGEST_LIMIT — max CatalogProduct rows persisted per single
//                          catalogSync / shopifyPublicIngest /
//                          genericCatalogIngest / apifyIngest catalog
//                          pass. Applies to writes, not fetches — the
//                          upstream API may return a page of 250 rows
//                          and we simply stop iterating after N.
//
//   SOCIAL_INGEST_LIMIT  — same cap for social ingest: postSyncService
//                          (Instagram OAuth path) and apifyIngestService
//                          (apify-ig demo path).
//
// Semantics:
//   - null / unset / <= 0 → no cap (pre-2026-09-02 unbounded behaviour)
//   - a positive integer  → hard ceiling on the caller's persist loop
//
// Defaults commit to 10 in config/defaults.env so a fresh Render deploy
// caps at a demo-safe rate; Render dashboard override on either name is
// a straightforward integer bump when a brand needs the full catalog.
// Rejecting non-integer values keeps a fat-fingered '10.5' from
// silently truncating.

'use strict';

const DEFAULT_LIMIT = 10;
const CAP_MIN = 1;
const CAP_MAX = 10000; // Anything above this: treat as "no cap" — a runaway
                       // 1_000_000 in an env would silently keep all the
                       // pre-fix behaviour without warning; capping the
                       // parser's own upper bound forces a real number.

function readLimit(envName) {
  const raw = process.env[envName];
  if (raw == null || raw === '' || String(raw).toLowerCase() === 'unlimited') {
    return DEFAULT_LIMIT;
  }
  // Strict integer parse — `parseInt('10.5')` returns 10, which would
  // silently truncate a fractional intent. Compare vs the strict integer
  // string to reject any decimal / hex / prefix garbage upstream.
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== String(raw).trim()) {
    return DEFAULT_LIMIT;
  }
  if (parsed <= 0) return null;                 // explicit 0 / negative → uncapped
  if (parsed < CAP_MIN) return DEFAULT_LIMIT;   // (unreachable given <=0 above, but future-proofs against a >0 min)
  if (parsed > CAP_MAX) return null;            // very-large values roll over to uncapped
  return parsed;
}

function catalogIngestLimit() {
  return readLimit('CATALOG_INGEST_LIMIT');
}

function socialIngestLimit() {
  return readLimit('SOCIAL_INGEST_LIMIT');
}

// Convenience — a single check the ingest loops use to decide whether
// they should still be iterating. Returns true when the cap is null
// (unlimited) OR the caller's already-persisted count is under the cap.
function shouldContinueIngest(persistedCount, cap) {
  if (cap == null) return true;
  return persistedCount < cap;
}

module.exports = {
  catalogIngestLimit,
  socialIngestLimit,
  shouldContinueIngest,
  __test: {
    readLimit,
    DEFAULT_LIMIT,
    CAP_MIN,
    CAP_MAX
  }
};
