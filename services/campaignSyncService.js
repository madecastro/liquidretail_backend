// Per-platform campaign-sync orchestrator. Dispatches to the right
// adapter (metaAdsCampaignService or googleAdsCampaignService) based
// on the IntegrationCredential's type, then aggregates results.
//
// Phase B-1 ships the dispatcher + the shared upsert helper; the
// per-platform adapters fill in the actual fetch logic in B-2 / B-3.
// Until those land, calls for unimplemented platforms return an
// explanatory error rather than throwing.

const IntegrationCredential = require('../models/IntegrationCredential');
const Campaign = require('../models/Campaign');
const { concurrency: CONC } = require('./concurrency');

// Adapter registry. Each adapter exports:
//   syncForCredential(credDoc) → { ok, campaigns: [normalizedCampaign], errors: [] }
// where normalizedCampaign matches the Campaign schema's create shape
// (minus brandId / advertiserId / credentialId / platform — the
// orchestrator stamps those).
const ADAPTERS = {
  'meta-ads':   require('./metaAdsCampaignService'),    // B-2
  'google-ads': require('./googleAdsCampaignService'),  // B-3
};

function adapterFor(type) {
  return ADAPTERS[type] || null;
}

// Public entry — sync one credential, or every active credential of
// a given platform under a brand. credentialId is optional; when
// omitted we iterate every active credential of the platform.
async function syncCampaigns({ brandId, platform, credentialId }) {
  if (!brandId)  return { ok: false, reason: 'brandId required' };
  if (!platform) return { ok: false, reason: 'platform required' };

  const adapter = adapterFor(platform);
  if (!adapter) {
    return { ok: false, reason: `no campaign-sync adapter for platform "${platform}" yet — add one and register in campaignSyncService.ADAPTERS` };
  }

  const filter = { brandId, type: platform, status: 'active' };
  if (credentialId) filter._id = credentialId;
  const creds = await IntegrationCredential.find(filter);
  if (!creds.length) {
    return { ok: false, reason: `no active ${platform} credential for this brand${credentialId ? ` matching ${credentialId}` : ''}` };
  }

  const t0 = Date.now();
  const summary = { ok: true, perCredential: [], totalUpserted: 0, totalErrors: 0 };

  // Unified progress row (ActivityDock) — cancellable between credentials.
  const { startRun, CancelledError } = require('./progressService');
  const run = await startRun({ kind: 'campaign-sync', advertiserId: creds[0].advertiserId, brandId, label: `${platform} campaign sync` });

  for (const cred of creds) {
    try { await run.checkpoint(); } catch (err) {
      if (err instanceof CancelledError) {
        summary.cancelled = true;
        console.log(`📊 campaign sync cancelled by operator: brand=${brandId}`);
        break;
      }
      throw err;
    }
    run.stage(`syncing ${cred.igUsername || cred.accountName || cred._id}`);
    let result;
    try {
      result = await adapter.syncForCredential(cred);
    } catch (err) {
      console.warn(`   ⚠️  campaign sync threw for cred=${cred._id}: ${err.message}`);
      summary.perCredential.push({ credentialId: String(cred._id), ok: false, reason: err.message });
      summary.totalErrors++;
      continue;
    }
    if (!result?.ok) {
      summary.perCredential.push({ credentialId: String(cred._id), ok: false, reason: result?.reason || 'unknown' });
      summary.totalErrors++;
      continue;
    }
    let upserted = 0;
    for (const c of (result.campaigns || [])) {
      try {
        await upsertCampaign({
          brandId,
          advertiserId: cred.advertiserId,
          credentialId: cred._id,
          platform,
          ...c
        });
        upserted++;
      } catch (err) {
        console.warn(`   ⚠️  campaign upsert failed for ${c.externalId}: ${err.message}`);
      }
    }
    cred.lastUsedAt = new Date();
    cred.lastCampaignSyncAt = new Date();
    await cred.save();
    summary.perCredential.push({
      credentialId: String(cred._id),
      ok: true,
      upserted,
      errors: result.errors || []
    });
    summary.totalUpserted += upserted;
  }

  summary.durationMs = Date.now() - t0;
  if (summary.cancelled) await run.markCancelled('Cancelled — synced credentials kept');
  else await run.succeed({ upserted: summary.totalUpserted, errors: summary.totalErrors });
  console.log(`📣 campaign sync (${platform}): brand=${brandId} upserted=${summary.totalUpserted} errors=${summary.totalErrors} in ${summary.durationMs}ms`);

  // Phase 3 — auto-fire voice + brief derivation after campaign sync.
  // Both run fire-and-forget so the HTTP response doesn't wait on
  // GPT calls. Both respect their own TTLs (7 days), so frequent
  // syncs don't burn LLM credits. Skipped entirely when no campaigns
  // were upserted in this run.
  if (summary.totalUpserted > 0) {
    setImmediate(() => {
      enqueueDerivations({ brandId, platform }).catch(err => {
        console.warn(`   ⚠️  voice/brief derivations enqueue failed for brand=${brandId}: ${err.message}`);
      });
    });
  }

  return summary;
}

// Fire-and-forget orchestrator. Walks campaigns whose brief is stale
// (or missing) and derives one per campaign; then refreshes brand voice
// once. Both services already enforce a TTL, so this is idempotent on
// re-runs within the TTL window.
async function enqueueDerivations({ brandId, platform }) {
  const { deriveCampaignBrief, TTL_DAYS: BRIEF_TTL_DAYS } = require('./campaignBriefDerivationService');
  const { deriveBrandVoice }                              = require('./brandVoiceDerivationService');

  // Brief — per campaign on this brand/platform whose brief is stale.
  const briefStaleCutoff = new Date(Date.now() - BRIEF_TTL_DAYS * 24 * 60 * 60 * 1000);
  const stale = await Campaign.find({
    brandId, platform,
    $or: [
      { briefDerivedAt: null },
      { briefDerivedAt: { $lt: briefStaleCutoff } }
    ]
  }).select('_id').lean();

  if (stale.length) {
    console.log(`📋 campaignBrief: enqueueing ${stale.length} stale brief(s) for brand=${brandId}`);
    // Concurrency-limited rolling batch — derivation hits OpenAI per
    // campaign, so we cap in-flight (CAMPAIGN_BRIEF_CONCURRENCY) to avoid stampeding.
    const queue = stale.map(c => c._id);
    const CONCURRENCY = CONC.CAMPAIGN_BRIEF_CONCURRENCY;
    let cursor = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (cursor < queue.length) {
        const id = queue[cursor++];
        try {
          await deriveCampaignBrief(id, { derivedFrom: 'ingest' });
        } catch (err) {
          console.warn(`   ⚠️  brief derivation failed for campaign=${id}: ${err.message}`);
        }
      }
    });
    await Promise.all(workers);
  }

  // Brand voice — single shot, TTL-guarded by the service itself.
  try {
    const r = await deriveBrandVoice(brandId);
    if (r.skipped) {
      console.log(`🗣️  brandVoice: brand=${brandId} skipped (${r.reason})`);
    }
  } catch (err) {
    console.warn(`   ⚠️  brand voice derivation failed for brand=${brandId}: ${err.message}`);
  }
}

// Idempotent upsert keyed on (brandId, platform, externalId).
// Aggregates productSetIds across embedded ad sets so the Phase C
// matcher can do a single IN-query.
async function upsertCampaign(c) {
  if (!c.brandId || !c.platform || !c.externalId) {
    throw new Error('upsertCampaign requires brandId + platform + externalId');
  }
  const productSetIds = Array.from(new Set(
    (c.adSets || []).map(s => s.productSetId).filter(Boolean)
  ));
  const update = {
    advertiserId:  c.advertiserId,
    credentialId:  c.credentialId,
    name:          c.name || '(unnamed)',
    status:        c.status || null,
    objective:     c.objective || null,
    budget:        c.budget || null,
    schedule:      c.schedule || null,
    targeting:     c.targeting || null,
    productSetIds,
    adSets:        c.adSets || [],
    matchedProductIds: c.matchedProductIds || [],
    kind:          c.kind || null,
    insights:      c.insights || null,
    rawData:       c.rawData || null,
    lastSyncedAt:  new Date()
  };
  return Campaign.findOneAndUpdate(
    { brandId: c.brandId, platform: c.platform, externalId: c.externalId },
    { $set: update, $setOnInsert: { firstSeenAt: new Date() } },
    { upsert: true, new: true }
  );
}

// Brand-page status helper. Returns {connected, count, lastSyncedAt}
// for one platform under a brand without pulling every campaign row.
async function getCampaignStatus(brandId, platform) {
  const [credCount, count, latest] = await Promise.all([
    IntegrationCredential.countDocuments({ brandId, type: platform, status: 'active' }),
    Campaign.countDocuments({ brandId, platform }),
    Campaign.findOne({ brandId, platform }).sort({ lastSyncedAt: -1 }).select('lastSyncedAt').lean()
  ]);
  return {
    connected:    credCount > 0,
    count,
    lastSyncedAt: latest?.lastSyncedAt || null
  };
}

module.exports = {
  ADAPTERS,
  syncCampaigns,
  upsertCampaign,
  getCampaignStatus
};
