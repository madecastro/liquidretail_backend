#!/usr/bin/env node
// backfillUntitledOrphans — one-off recovery for masters already stranded in
// production before the render path learned to declare its titling debt.
//
// WHY A SCRIPT AND NOT A SWEEPER ARM. The forward fix (routes/ads.js stamping
// titlingResumeState:'claimed' beside the master) only marks renders that start
// AFTER the deploy. Ads stranded before it carry {status:'draft',
// renderUrl === veoVideoUrl, titlingResumeState:null} — and that state is
// byte-for-byte identical to a no-chrome ad that correctly ships its bare
// master. There is no field that separates them, so this cannot be an automatic
// arm without re-titling every no-chrome ad on every pass forever.
//
// WHY RUNNING IT IS STILL SAFE. Re-titling a no-chrome ad is self-limiting and
// free: titlingResumeService calls renderBrandScriptAndSave, which returns
// {skipped:true, reason:'no-chrome'} BEFORE any Remotion render, and the
// service then clears titlingResumeState (titlingResumeService.js, the success
// branch treats skipped as success). So each ad is examined exactly once, the
// genuinely untitled ones get titled, and the rest settle permanently.
//
// COSTS NOTHING. Remotion is local and titling never calls Atlas. The paid
// master is already on renderUrl and is never deleted or re-submitted — this
// script does not import atlasVideoService and is structurally incapable of
// spending.
//
// USAGE (dry-run is the default, and prints exactly what it would touch):
//   node scripts/backfillUntitledOrphans.js
//   node scripts/backfillUntitledOrphans.js --apply
//   node scripts/backfillUntitledOrphans.js --apply --campaign <campaignId>
//   node scripts/backfillUntitledOrphans.js --apply --since 2026-08-01
require('dotenv').config({ path: require('path').join(__dirname, '..', 'config', 'defaults.env') });
const mongoose = require('mongoose');
const Ad = require('../models/Ad');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

const APPLY = has('--apply');
const CAMPAIGN = val('--campaign');
const SINCE = val('--since');
const LIMIT = parseInt(val('--limit'), 10) || 500;

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('MONGODB_URI is not set'); process.exit(1); }
  await mongoose.connect(uri);

  // The orphan signature. $expr is what makes "renderUrl IS the raw master"
  // expressible — a plain equality cannot compare two fields of one document.
  const filter = {
    status: 'draft',
    kind: 'video',
    titlingResumeState: null,
    veoVideoUrl: { $nin: [null, ''] },
    $expr: { $eq: ['$renderUrl', '$veoVideoUrl'] },
    ...(CAMPAIGN ? { campaignId: new mongoose.Types.ObjectId(CAMPAIGN) } : {}),
    ...(SINCE ? { updatedAt: { $gte: new Date(SINCE) } } : {})
  };

  const ads = await Ad.find(filter)
    .select('_id campaignId platformFormat renderStage veoVideoUrl updatedAt')
    .sort({ updatedAt: 1 })
    .limit(LIMIT)
    .lean();

  console.log(`\n${APPLY ? 'APPLY' : 'DRY-RUN'} — untitled-orphan backfill`);
  console.log(`matched ${ads.length} ad(s)${ads.length === LIMIT ? ` (capped at --limit ${LIMIT})` : ''}\n`);

  if (!ads.length) { await mongoose.disconnect(); return; }

  // renderStage is a breadcrumb, never a filter (adStage clobbers it) — but for
  // a HUMAN deciding whether to apply, it is the best signal available of where
  // each ad actually stopped.
  const byStage = new Map();
  for (const ad of ads) {
    const k = ad.renderStage || '(none)';
    byStage.set(k, (byStage.get(k) || 0) + 1);
  }
  console.log('  where they stopped (renderStage — informational only):');
  for (const [stage, n] of [...byStage].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(4)}  ${stage}`);
  }

  console.log('\n  sample:');
  for (const ad of ads.slice(0, 10)) {
    console.log(`    ${ad._id}  ${(ad.platformFormat || '?').padEnd(22)} ${ad.updatedAt?.toISOString?.() || ''}`);
  }

  if (!APPLY) {
    console.log('\n  DRY-RUN — nothing written. Re-run with --apply to mark these for titling.');
    console.log('  Each will be examined once by titlingResumeService; no-chrome ads settle and stop.\n');
    await mongoose.disconnect();
    return;
  }

  // 'pending', not 'claimed': there is no live render to protect here, and
  // pending is the arm with no staleness bound, so the sweeper picks these up
  // on its next tick rather than 15 minutes later.
  const res = await Ad.updateMany(
    { _id: { $in: ads.map(a => a._id) }, titlingResumeState: null },
    { $set: { titlingResumeState: 'pending', updatedAt: new Date() } }
  );
  console.log(`\n  marked ${res.modifiedCount} ad(s) pending — titlingResumeService will drain them`);
  console.log('  (web process only; TITLING_RESUME_MAX per tick)\n');

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
