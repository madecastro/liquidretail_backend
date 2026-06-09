// Wipes Ads + AiCanvasArtifacts + dependent rows for a campaign so the
// next campaign run regenerates everything from scratch. Use when a
// prompt/schema change needs to invalidate cached layouts that
// identityDigest dedup would otherwise keep in place.
//
// Usage:
//   node scripts/resetCampaignAds.js --campaign <campaignId> [--dry-run]
//
// What gets deleted (scoped to the campaign):
//   - Ad docs                          (campaignId)
//   - AiCanvasArtifact rows            (matched by mediaId of the campaign's Ads)
//   - AiHtmlValidationArtifact rows    (FK → AiCanvasArtifact)
//   - ResolvedLayoutArtifact rows      (FK → AiCanvasArtifact)
//   - AiFullRenderArtifact rows        (FK → AiCanvasArtifact)
//   - AiJudgeResultArtifact rows       (FK → AiCanvasArtifact)
//
// LayoutInputArtifacts are KEPT — they're keyed independently and
// re-deriving them costs LLM tokens.

require('dotenv').config();
const mongoose = require('mongoose');

const Ad                        = require('../models/Ad');
const AiCanvasArtifact          = require('../models/AiCanvasArtifact');
const AiHtmlValidationArtifact  = require('../models/AiHtmlValidationArtifact');
const ResolvedLayoutArtifact    = require('../models/ResolvedLayoutArtifact');
const AiFullRenderArtifact      = require('../models/AiFullRenderArtifact');
const AiJudgeResultArtifact     = require('../models/AiJudgeResultArtifact');

const args = process.argv.slice(2);
const CAMPAIGN_ID = pickArg('--campaign');
const DRY_RUN     = args.includes('--dry-run');

function pickArg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

(async function main() {
  if (!CAMPAIGN_ID) {
    console.error('Usage: node scripts/resetCampaignAds.js --campaign <campaignId> [--dry-run]');
    process.exit(1);
  }
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI not set');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI);

  const campaignObjectId = new mongoose.Types.ObjectId(CAMPAIGN_ID);

  // 1. Find all Ads for the campaign — these give us the mediaIds whose
  //    canvas/resolved/validation artifacts we need to nuke.
  const ads = await Ad.find({ campaignId: campaignObjectId })
    .select('_id mediaId')
    .lean();
  const mediaIds = [...new Set(ads.map(a => String(a.mediaId)))]
    .map(s => new mongoose.Types.ObjectId(s));

  console.log(`Found ${ads.length} Ads for campaign ${CAMPAIGN_ID}`);
  console.log(`Affecting ${mediaIds.length} distinct mediaIds`);

  if (!ads.length) {
    console.log('Nothing to delete.');
    await mongoose.disconnect();
    return;
  }

  // 2. Find AiCanvasArtifacts for these mediaIds (canvas cache is keyed
  //    on the media + cartesian dimensions — clearing by mediaId is
  //    coarser than strictly necessary but safe for a campaign reset).
  const canvases = await AiCanvasArtifact.find({ mediaId: { $in: mediaIds } })
    .select('_id')
    .lean();
  const canvasIds = canvases.map(c => c._id);
  console.log(`Found ${canvasIds.length} AiCanvasArtifacts to delete`);

  // 3. Count dependents — for dry-run reporting and post-hoc verification.
  const [htmlValCount, resolvedCount, fullRenderCount, judgeCount] = await Promise.all([
    AiHtmlValidationArtifact.countDocuments({ aiCanvasArtifactId: { $in: canvasIds } }),
    ResolvedLayoutArtifact.countDocuments({ aiCanvasArtifactId: { $in: canvasIds } }),
    AiFullRenderArtifact.countDocuments({ aiCanvasArtifactId: { $in: canvasIds } }),
    AiJudgeResultArtifact.countDocuments({ aiCanvasArtifactId: { $in: canvasIds } })
  ]);
  console.log(`Dependent rows — html_val:${htmlValCount} resolved:${resolvedCount} full_render:${fullRenderCount} judge:${judgeCount}`);

  if (DRY_RUN) {
    console.log('\n--dry-run set — no deletes performed.');
    await mongoose.disconnect();
    return;
  }

  // 4. Delete in dependent order (children → parents).
  console.log('\nDeleting...');
  const r1 = await AiHtmlValidationArtifact.deleteMany({ aiCanvasArtifactId: { $in: canvasIds } });
  console.log(`  AiHtmlValidationArtifact: ${r1.deletedCount}`);
  const r2 = await ResolvedLayoutArtifact.deleteMany({ aiCanvasArtifactId: { $in: canvasIds } });
  console.log(`  ResolvedLayoutArtifact:   ${r2.deletedCount}`);
  const r3 = await AiFullRenderArtifact.deleteMany({ aiCanvasArtifactId: { $in: canvasIds } });
  console.log(`  AiFullRenderArtifact:     ${r3.deletedCount}`);
  const r4 = await AiJudgeResultArtifact.deleteMany({ aiCanvasArtifactId: { $in: canvasIds } });
  console.log(`  AiJudgeResultArtifact:    ${r4.deletedCount}`);
  const r5 = await AiCanvasArtifact.deleteMany({ _id: { $in: canvasIds } });
  console.log(`  AiCanvasArtifact:         ${r5.deletedCount}`);
  const r6 = await Ad.deleteMany({ campaignId: campaignObjectId });
  console.log(`  Ad:                       ${r6.deletedCount}`);

  console.log('\nDone. Trigger a fresh campaign run from the UI to regenerate.');
  await mongoose.disconnect();
})().catch(async (err) => {
  console.error('reset failed:', err.stack || err.message || err);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
