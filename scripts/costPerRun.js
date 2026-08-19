// True cost for one CampaignRun — reads CostLog.campaignRunId directly instead
// of reconstructing spend from a time window (the only option before
// campaignRunId was populated at the write sites, 2026-08-19 — see CLAUDE.md §2
// and session.md).
//
// Usage:
//   node scripts/costPerRun.js <runId>
//   node scripts/costPerRun.js run_1787119100250_eef4d871
//
// Exits non-zero and prints a coverage warning (does not throw) when the run
// predates the campaignRunId fix — those rows were never stamped, so a $0 or
// low total here can mean "genuinely nothing spent" OR "spend happened but
// wasn't attributed"; the CampaignRun's own succeeded/failed/skipped counts
// are the cross-check for which one it is.
//
// Read-only. No writes, no submits.

require('dotenv').config();
const mongoose = require('mongoose');
const CampaignRun = require('../models/CampaignRun');
const { costForRun } = require('../services/costTracker');

async function main() {
  const runId = process.argv[2];
  if (!runId) {
    console.error('Usage: node scripts/costPerRun.js <runId>');
    process.exit(1);
  }
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI not set in env.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  try {
    const [run, cost] = await Promise.all([
      CampaignRun.findOne({ runId }).select('runId status total succeeded failed skipped startedAt completedAt').lean(),
      costForRun(runId)
    ]);

    if (!run) {
      console.warn(`⚠️  No CampaignRun found with runId="${runId}" — showing CostLog totals anyway (may be a run id typo).`);
    } else {
      console.log(`Run ${run.runId} — status=${run.status} total=${run.total} succeeded=${run.succeeded} failed=${run.failed} skipped=${run.skipped}`);
      console.log(`  started=${run.startedAt ? run.startedAt.toISOString() : '-'} completed=${run.completedAt ? run.completedAt.toISOString() : '-'}`);
    }

    console.log(`\nCostLog rows attributed to this run: ${cost.rows}`);
    console.log(`  TOTAL   $${cost.totalUsd.toFixed(4)}`);
    console.log(`    actual    $${cost.actualUsd.toFixed(4)}  (settled by the provider)`);
    console.log(`    estimated $${cost.estimatedUsd.toFixed(4)}  (pre-settlement — never quote as spend, CLAUDE.md §2)`);

    if (cost.byStage.length) {
      console.log('\nBy stage / model / costSource:');
      for (const e of cost.byStage) {
        console.log(`  ${e.stage.padEnd(22)} ${e.model.padEnd(46)} [${e.costSource.padEnd(9)}] n=${String(e.n).padStart(3)}  $${e.usd.toFixed(4)}`);
      }
    }

    if (cost.rows === 0) {
      console.warn(
        '\n⚠️  Zero CostLog rows carry this campaignRunId. If this run generated ads before ' +
        '2026-08-19, that is expected (campaignRunId was not yet populated at the write sites) ' +
        'and NOT proof the run was free — reconstruct from a time window instead for a pre-fix run.'
      );
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('ERROR', err.message);
  process.exit(1);
});
