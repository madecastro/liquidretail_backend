#!/usr/bin/env node
//
// Clear the queued-ad backlog so a new "Generate Ad" renders only what the
// operator just asked for.
//
// WHY THIS EXISTS. selectAdsForRun (services/campaignAdsGenerationService.js)
// selects on { campaignId, status:'queued' } with NO product filter, and its
// first tier sorts { queuedAt: 1 } — oldest first. So pressing Generate for
// product X renders the OLDEST queued ads in that campaign, which may belong to
// a completely different product from an earlier session. The observed symptom
// is "Rendering 1 of 20" starting on an unrelated product.
//
// Queued ads have not been rendered, so they have cost nothing YET. They become
// billable the moment a run drains them. Clearing the backlog is therefore a
// cost-control action, not a cleanup.
//
// DEFAULT IS ARCHIVE, NOT DELETE. 'archived' is already in the Ad status enum
// and selectAdsForRun only ever matches 'queued', so archiving takes them out
// of every future run while keeping the rows (and the work that produced them)
// inspectable and reversible via --restore. --delete is available but is not
// the default: the unique index on (campaignId, identityDigest) means a deleted
// ad can be regenerated, but its judge scores and concept lineage cannot.
//
// Usage:
//   node scripts/purgeQueuedAds.js                          # dry run, ALL brands
//   node scripts/purgeQueuedAds.js --brand <brandId>          # scope to one brand
//   node scripts/purgeQueuedAds.js --campaign <campaignId>    # scope to one campaign
//   node scripts/purgeQueuedAds.js --before 2026-07-28        # only ads queued before a date
//   node scripts/purgeQueuedAds.js --keep-product <productId> # spare one product's ads
//   node scripts/purgeQueuedAds.js --apply                    # actually archive
//   node scripts/purgeQueuedAds.js --apply --delete           # hard delete instead
//   node scripts/purgeQueuedAds.js --apply --restore          # un-archive (undo)
//   node scripts/purgeQueuedAds.js --apply --release-stuck    # see below
//
// --release-stuck also handles ads stranded in status:'rendering' by a crashed
// or cancelled run. Those are invisible to selectAdsForRun (it matches
// 'queued') so they are stuck forever otherwise. Combined with the default
// archive, this clears both halves of the backlog. The worker's own orphan
// reaper (worker.js REAP_STALE_MIN) returns them to 'queued' after 15 minutes,
// which puts them straight back in the backlog — so release-stuck archives them
// rather than re-queueing.

require('dotenv').config();
require('dotenv').config({ path: require('path').join(__dirname, '..', 'config', 'defaults.env') });
const mongoose = require('mongoose');

const Ad          = require('../models/Ad');
const CampaignRun = require('../models/CampaignRun');
// THE archive / restore writes — one definition, shared with the Stop handler,
// the 24h sweeper and the ad.archive / ad.restore capabilities. They move the
// row's identityDigest to/from preArchiveIdentityDigest so an archived
// NEVER-BILLED identity stops squatting its slot on the (campaignId,
// identityDigest) unique index. Never hand-roll a $set here — --restore in
// particular puts rows back into 'queued', where selectAdsForRun can claim and
// BILL them, so a row must never re-enter the queue carrying a tombstone.
const {
  archiveAdsReleasingDigest,
  restoreOneRestoringDigest,
  isDigestCollisionError,
  restoreTookEffect,
  DIGEST_COLLISION_MESSAGE,
  UNRESTORABLE_TOMBSTONE_MESSAGE
} = require('../services/adArchiveDigest');

const args = process.argv.slice(2);
const DRY      = !args.includes('--apply');
const DELETE   = args.includes('--delete');
const RESTORE  = args.includes('--restore');
const RELEASE  = args.includes('--release-stuck');
const BRAND    = pickArg('--brand');
const CAMPAIGN = pickArg('--campaign');
const BEFORE   = pickArg('--before');
const KEEP     = pickArg('--keep-product');

function pickArg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

function oid(v, label) {
  if (!v) return null;
  if (!mongoose.Types.ObjectId.isValid(v)) {
    console.error(`${label} is not a valid ObjectId: ${v}`);
    process.exit(1);
  }
  return new mongoose.Types.ObjectId(v);
}

function buildFilter(status) {
  const f = { status };
  const b = oid(BRAND, '--brand');
  const c = oid(CAMPAIGN, '--campaign');
  const k = oid(KEEP, '--keep-product');
  if (b) f.brandId = b;
  if (c) f.campaignId = c;
  if (k) f.productId = { $ne: k };
  if (BEFORE) {
    const d = new Date(BEFORE);
    if (Number.isNaN(d.getTime())) {
      console.error(`--before is not a parseable date: ${BEFORE}`);
      process.exit(1);
    }
    f.queuedAt = { $lt: d };
  }
  return f;
}

// Show WHAT is about to be affected, grouped the way an operator thinks about
// it — which brand, which campaign, which product, how old. Never act on a
// count alone.
async function report(filter, heading) {
  const total = await Ad.countDocuments(filter);
  console.log(`\n${heading}: ${total}`);
  if (!total) return 0;

  const rows = await Ad.aggregate([
    { $match: filter },
    { $group: {
        _id:      { brandId: '$brandId', campaignId: '$campaignId', productId: '$productId' },
        n:        { $sum: 1 },
        oldest:   { $min: '$queuedAt' },
        newest:   { $max: '$queuedAt' },
        routes:   { $addToSet: '$renderRoute' }
    } },
    { $sort: { n: -1 } },
    { $limit: 40 }
  ]);

  // renderRoute 'veo' is the expensive one (Veo video generation), so surface
  // it separately — that is where the money actually is.
  const veo = await Ad.countDocuments({ ...filter, renderRoute: 'veo' });
  console.log(`  of which renderRoute='veo' (video, the expensive ones): ${veo}`);
  console.log('');
  console.log('  brand                     campaign                  product                   n     oldest');
  for (const r of rows) {
    const k = r._id;
    console.log(
      `  ${String(k.brandId || '-').padEnd(25)} ${String(k.campaignId || '-').padEnd(25)} ` +
      `${String(k.productId || '(none)').padEnd(25)} ${String(r.n).padEnd(5)} ` +
      `${r.oldest ? new Date(r.oldest).toISOString().slice(0, 16) : '-'}  [${(r.routes || []).join(',')}]`
    );
  }
  if (total > rows.length) console.log(`  … ${total - rows.length} more group(s) not shown`);
  return total;
}

async function main() {
  const url = process.env.MONGODB_URI || process.env.MONGO_URL || process.env.MONGO_URI;
  if (!url) { console.error('No Mongo URI in env (MONGODB_URI).'); process.exit(1); }
  await mongoose.connect(url);

  console.log('─'.repeat(78));
  console.log('mode:', DRY ? 'DRY RUN (no writes)' : (RESTORE ? 'APPLY — RESTORE' : (DELETE ? 'APPLY — HARD DELETE' : 'APPLY — ARCHIVE')));
  if (BRAND)    console.log('brand filter:   ', BRAND);
  if (CAMPAIGN) console.log('campaign filter:', CAMPAIGN);
  if (BEFORE)   console.log('queued before:  ', BEFORE);
  if (KEEP)     console.log('sparing product:', KEEP);
  if (RELEASE)  console.log("also archiving ads stranded in status:'rendering'");
  console.log('─'.repeat(78));

  if (RESTORE) {
    const filter = buildFilter('archived');
    const n = await report(filter, "Archived ads that would be returned to 'queued'");
    if (!DRY && n) {
      // Per-row, so one identity collision does not abort the whole restore.
      // A collision means a later Generate already re-minted that identity
      // while the row sat archived — the row stays archived and is reported.
      const rows = await Ad.find(filter).select('_id').lean();
      let restored = 0;
      const collided = [];
      const unrecoverable = [];
      for (const row of rows) {
        let doc;
        try {
          doc = await restoreOneRestoringDigest(
            Ad, { _id: row._id }, { status: 'queued', queryOptions: { new: true, lean: true } }
          );
        } catch (err) {
          if (isDigestCollisionError(err)) { collided.push(String(row._id)); continue; }
          throw err;
        }
        // modifiedCount alone would count a REFUSED restore as a success: the
        // stage leaves a tombstoned row with no saved digest at 'archived' on
        // purpose, because a 'queued' row is claimable and billable and must
        // never carry a placeholder identity. Check the status, not the count.
        if (restoreTookEffect(doc, 'queued')) restored += 1;
        else unrecoverable.push(String(row._id));
      }
      console.log(`\nrestored ${restored} ad(s) to 'queued'`);
      if (collided.length) {
        console.log(`⚠️  ${collided.length} ad(s) left archived — ${DIGEST_COLLISION_MESSAGE}`);
        console.log(`    ${collided.slice(0, 20).join(', ')}${collided.length > 20 ? ' …' : ''}`);
      }
      if (unrecoverable.length) {
        console.log(`⚠️  ${unrecoverable.length} ad(s) left archived — ${UNRESTORABLE_TOMBSTONE_MESSAGE}`);
        console.log(`    ${unrecoverable.slice(0, 20).join(', ')}${unrecoverable.length > 20 ? ' …' : ''}`);
      }
    }
    await finish();
    return;
  }

  const queuedFilter = buildFilter('queued');
  const nQueued = await report(queuedFilter, "Ads with status:'queued' (the backlog)");

  let nStuck = 0;
  let stuckFilter = null;
  if (RELEASE) {
    stuckFilter = buildFilter('rendering');
    nStuck = await report(stuckFilter, "Ads stranded in status:'rendering' (crashed/cancelled runs)");
  }

  // Runs still marked in-flight. These are what keeps a spinner on screen and,
  // if a render loop is genuinely still alive in a server process, what is
  // still spending money. Archiving ads does NOT stop an already-dispatched
  // in-flight render — only the process finishing or restarting does.
  const runFilter = { status: { $in: ['preparing', 'running'] } };
  if (BRAND) runFilter.brandId = oid(BRAND, '--brand');
  const liveRuns = await CampaignRun.find(runFilter)
    .select('runId brandId campaignId status total succeeded failed skipped createdAt')
    .sort({ createdAt: -1 })
    .limit(20)
    .lean()
    .catch(() => []);
  if (liveRuns.length) {
    console.log(`\nCampaignRuns still marked in-flight: ${liveRuns.length}`);
    for (const r of liveRuns) {
      console.log(`  ${r.runId || r._id}  ${r.status.padEnd(10)} ` +
                  `${r.succeeded || 0}/${r.total || 0} ok · ${r.failed || 0} failed · ${r.skipped || 0} skipped  ` +
                  `${r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 16) : ''}`);
    }
    console.log('  NOTE: a run whose process already died stays "running" forever — it is not');
    console.log('        necessarily still spending. Check that its counters are advancing.');
  }

  if (DRY) {
    console.log('\n' + '─'.repeat(78));
    console.log(`Dry run — nothing written. Would affect ${nQueued + nStuck} ad(s).`);
    console.log('Re-run with --apply to archive, or --apply --delete to remove outright.');
    console.log('─'.repeat(78));
    await finish();
    return;
  }

  let archived = 0;
  let deleted  = 0;
  if (nQueued) {
    if (DELETE) {
      const r = await Ad.deleteMany(queuedFilter);
      deleted += r.deletedCount || 0;
    } else {
      const r = await archiveAdsReleasingDigest(Ad, queuedFilter);
      archived += r.modifiedCount || 0;
    }
  }
  if (RELEASE && nStuck) {
    if (DELETE) {
      const r = await Ad.deleteMany(stuckFilter);
      deleted += r.deletedCount || 0;
    } else {
      const r = await archiveAdsReleasingDigest(Ad, stuckFilter);
      archived += r.modifiedCount || 0;
    }
  }

  console.log('\n' + '─'.repeat(78));
  if (archived) console.log(`archived ${archived} ad(s) — invisible to selectAdsForRun, reversible with --restore`);
  if (deleted)  console.log(`deleted  ${deleted} ad(s)`);
  console.log('The next Generate will only see ads queued after this point.');
  console.log('─'.repeat(78));
  await finish();
}

async function finish() {
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('purge failed:', err);
  try { await mongoose.disconnect(); } catch { /* noop */ }
  process.exit(1);
});
