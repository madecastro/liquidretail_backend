// Gate for "is this brand allowed to create campaigns / generate ads?"
//
// Strictest definition (chosen 2026-05-14): for EACH source the brand
// has connected, require at least one completed DetectRun AND zero
// in-flight runs (queued OR processing). Partial state is the failure
// mode we keep hitting — ads composed against a half-ingested catalog
// pair the seed SKU with stale or wrong-jar UGC.
//
// Sources are derived from the same signals the onboarding-status
// endpoint uses, so the gate and the panel agree on what's connected:
//
//   catalog (catalog-product Media) — connected when an active
//     Instagram IntegrationCredential carries a catalogId.
//   social  (instagram Media)       — connected when an active
//     Instagram IntegrationCredential exists (catalogId optional).
//
// Returns { ready, reason, blockers[] }:
//   ready    true when every connected source has ≥1 completed + 0 in-flight
//   reason   short human-readable summary (for tooltips + 409 body)
//   blockers list of { code, message, source } so the UI can render
//            per-source rows that mirror OnboardingStatusPanel

const DetectRun            = require('../models/DetectRun');
const Media                = require('../models/Media');
const IntegrationCredential = require('../models/IntegrationCredential');

// Per-source connection probes. Returning false means "not connected,
// no gate needed" — a brand that hasn't linked IG simply skips the
// social source rather than being blocked forever on a step they
// never started.
//
// Social presence is defined by ACTUAL ingested posts, not by the
// presence of an IG credential. A brand that connected IG for Meta
// catalog access only (catalogId set, posts ingestion never opted
// into) shouldn't be blocked by "No Instagram posts ingested yet" —
// catalog-only ad generation is a first-class supported workflow.
// Catalog presence stays credential-driven (catalogId set) so that
// a freshly connected brand mid-first-sync is still gated until at
// least one catalog product lands.
async function probeConnections(brandId) {
  const cred = await IntegrationCredential.findOne({
    brandId, type: 'instagram', status: 'active'
  }).select('catalogId').lean();
  const socialMediaCount = await Media.countDocuments({
    brandId, source: 'instagram'
  });
  return {
    catalog: !!cred?.catalogId,
    social:  socialMediaCount > 0
  };
}

// Bucket DetectRuns for a media id set into { queued, processing,
// completed, failed }. Mirrors brand.js bucketRunsByStatus but
// operates over a specific media set rather than the brand-wide
// not-product partition.
async function bucketForMediaIds(mediaIds) {
  const out = { queued: 0, processing: 0, completed: 0, failed: 0 };
  if (!mediaIds.length) return out;
  const rows = await DetectRun.aggregate([
    { $match: { mediaId: { $in: mediaIds } } },
    { $group: { _id: '$status', n: { $sum: 1 } } }
  ]);
  for (const r of rows) if (out[r._id] !== undefined) out[r._id] = r.n;
  return out;
}

async function getAdReadiness(brandId) {
  if (!brandId) return { ready: false, reason: 'brandId required', blockers: [] };

  const connections = await probeConnections(brandId);

  if (!connections.catalog && !connections.social) {
    return {
      ready: false,
      reason: 'Connect Instagram (catalog and/or posts) before creating ads.',
      blockers: [{
        code: 'no-source-connected',
        source: null,
        message: 'No active Instagram integration. Connect via Brand → Integrations.'
      }]
    };
  }

  // Fan out media id sets per source so we can bucket DetectRuns by
  // source without coupling to mediaIds outside the source's partition.
  const [catalogMediaIds, socialMediaIds] = await Promise.all([
    connections.catalog
      ? Media.find({ brandId, source: 'catalog-product' }).select('_id').lean().then(rs => rs.map(r => r._id))
      : Promise.resolve([]),
    connections.social
      ? Media.find({ brandId, source: 'instagram' }).select('_id').lean().then(rs => rs.map(r => r._id))
      : Promise.resolve([])
  ]);

  const [catalogRuns, socialRuns] = await Promise.all([
    bucketForMediaIds(catalogMediaIds),
    bucketForMediaIds(socialMediaIds)
  ]);

  const blockers = [];

  // Catalog source — ≥1 completed AND 0 in-flight.
  if (connections.catalog) {
    if (catalogMediaIds.length === 0) {
      blockers.push({
        code: 'catalog-empty',
        source: 'catalog',
        message: 'No catalog products synced yet. Run a catalog sync first.'
      });
    } else if (catalogRuns.completed === 0) {
      blockers.push({
        code: 'catalog-detect-not-started',
        source: 'catalog',
        message: `No catalog product detect runs have completed yet (${catalogRuns.queued + catalogRuns.processing} in flight).`
      });
    } else if (catalogRuns.queued + catalogRuns.processing > 0) {
      blockers.push({
        code: 'catalog-detect-in-flight',
        source: 'catalog',
        message: `Catalog product detect is still running (${catalogRuns.queued + catalogRuns.processing} in flight).`
      });
    }
  }

  // Social source — same shape as catalog.
  if (connections.social) {
    if (socialMediaIds.length === 0) {
      blockers.push({
        code: 'social-empty',
        source: 'social',
        message: 'No Instagram posts ingested yet. Run an Instagram sync first.'
      });
    } else if (socialRuns.completed === 0) {
      blockers.push({
        code: 'social-detect-not-started',
        source: 'social',
        message: `No post detect runs have completed yet (${socialRuns.queued + socialRuns.processing} in flight).`
      });
    } else if (socialRuns.queued + socialRuns.processing > 0) {
      blockers.push({
        code: 'social-detect-in-flight',
        source: 'social',
        message: `Post detect is still running (${socialRuns.queued + socialRuns.processing} in flight).`
      });
    }
  }

  if (blockers.length === 0) {
    return { ready: true, reason: 'Account setup complete.', blockers: [] };
  }

  return {
    ready: false,
    reason: 'Account setup is still in progress — finish detect on all connected sources before creating ads.',
    blockers
  };
}

module.exports = { getAdReadiness };
