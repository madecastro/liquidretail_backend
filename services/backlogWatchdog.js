// Periodic health sweep → Slack. Runs in the worker alongside the
// orphan reaper.
//
// The reaper itself alerts when it reaps (that IS the "work got dropped"
// event). This watchdog covers the cases the reaper can't see:
//
//   1. An Ad wedged in 'rendering' — alerted BEFORE the 15-minute reap so
//      a dead web instance is visible while the evidence is still fresh.
//   2. A CampaignRun 'running' that has gone SILENT — age is only a
//      noise filter (see arm 2 below). Never key this on startedAt alone.
//   3. The DetectRun queue growing — the one queue the worker actually
//      drains, so a real backlog there means the worker is wedged.
//   4. Spend in the trailing hour above a ceiling. Video is the expensive
//      stage, but the cost model this once cited was FALSE: it said a 4:5
//      canvas can't run on Omni and falls back to Grok at $0.50/s (~$4.00
//      per 8s clip). `omniFamilyNativeFor()` (atlasVideoService.js:508-522)
//      returns '9:16' for any r < 1, so 4:5 runs on Omni; Grok is only the
//      square opt-out and explicitly-selected non-Omni models. An 8s 1080p
//      Omni clip is ~$1.00. The threshold in defaults.env was tuned against
//      the inflated figure and is correspondingly too high — see the note
//      there. A 20-ad batch is still real money.
//
// Deliberately NOT alerted on: a nonzero count of 'queued' Ads. That is
// normal inventory — expandWizardJob routinely queues more creatives than
// MAX_CREATIVES_PER_RUN (20) drains in one run, so alerting on it would
// fire constantly. Queue depth is carried as CONTEXT on the alerts above
// instead.
//
// Never throws: the caller is worker.js's interval, and a failed sweep must
// not take the worker down.

const alerts = require('./alertService');

const N = (name, dflt) => {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
};

// 12 min sits under worker.js's REAP_STALE_MIN (15) on purpose — we want the
// warning before the reaper rewrites the evidence.
const RENDERING_STALE_MIN = () => N('ALERT_RENDERING_STALE_MIN', 12);
// AGE is a noise filter only — a 20-ad veo batch at VEO_CONCURRENCY=4 is
// ~1 min/ad wall-clock per slot (~5 min for 20 if each takes ~1 min).
// 45 still clears a legitimately long batch. (Historical: at
// VEO_CONCURRENCY=1 a 20-ad video batch was ~20–35 min.)
const RUN_STALE_MIN       = () => N('ALERT_RUN_STALE_MIN', 45);
// SILENCE is the trigger. MUST stay strictly below worker.js's
// REAP_STALE_MIN (default 15). The reaper mutates
//   { status:'running', updatedAt: { $lt: 15m } } → failed
// every REAP_INTERVAL_MIN (5), so a silence threshold >= 15 is a
// structurally empty set (the reaper rewrites the evidence first).
// 12 sits under 15 the same way RENDERING_STALE_MIN does — we want
// the warning before that rewrite. Do NOT "fix" this by dropping
// startedAt and raising updatedAt to 45: that is the empty set.
const RUN_SILENCE_MIN     = () => N('ALERT_RUN_SILENCE_MIN', 12);
const DETECT_BACKLOG_MIN  = () => N('ALERT_DETECT_BACKLOG_MIN', 20);
const DETECT_BACKLOG_N    = () => N('ALERT_DETECT_BACKLOG_COUNT', 25);
const HOURLY_SPEND_USD    = () => {
  const v = parseFloat(process.env.ALERT_HOURLY_SPEND_USD);
  return Number.isFinite(v) && v > 0 ? v : 25;
};

async function runWatchdog() {
  if (!alerts.isConfigured()) return;

  const Ad          = require('../models/Ad');
  const CampaignRun = require('../models/CampaignRun');
  const DetectRun   = require('../models/DetectRun');
  const CostLog     = require('../models/CostLog');

  const now = Date.now();
  const ago = (min) => new Date(now - min * 60 * 1000);

  // Queue depth is context, not a fault — gathered once and attached below.
  const queuedAds = await Ad.countDocuments({ status: 'queued' }).catch(() => null);

  // ── 1. Ads wedged in 'rendering' ──
  try {
    const cutoff = ago(RENDERING_STALE_MIN());
    const stuck  = await Ad.find({ status: 'rendering', updatedAt: { $lt: cutoff } })
      .sort({ updatedAt: 1 }).limit(50)
      .select('_id renderRoute updatedAt campaignRunIds').lean();
    if (stuck.length) {
      const veo = stuck.filter((a) => a.renderRoute === 'veo').length;
      const oldestMin = Math.round((now - new Date(stuck[0].updatedAt).getTime()) / 60000);
      await alerts.notify({
        level: 'error',
        title: `${stuck.length} ad(s) stuck rendering`,
        key:   'watchdog:ads-rendering',
        fields: {
          'idle past':    `${RENDERING_STALE_MIN()}m`,
          'oldest':       `${oldestMin}m`,
          'video ads':    veo || undefined,
          'queued ads':   queuedAds ?? undefined,
          'likely cause': 'web instance replaced mid-batch (deploy or autoscale)'
        },
        detail: stuck.slice(0, 12)
          .map((a) => `${a._id} route=${a.renderRoute || '-'} idle=${Math.round((now - new Date(a.updatedAt).getTime()) / 60000)}m run=${(a.campaignRunIds || []).slice(-1)[0] || '-'}`)
          .join('\n')
      });
    }
  } catch (err) {
    console.warn(`🔔 watchdog[ads-rendering] failed: ${err.message}`);
  }

  // ── 2. CampaignRuns that have gone silent ──
  // AGE ∧ SILENCE. startedAt is a noise filter (a brand-new run whose
  // first $inc has not landed yet must not trip this). SILENCE is the
  // trigger, and it sits under REAP_STALE_MIN on purpose — see
  // RUN_SILENCE_MIN. The rejected alternative (swap startedAt for
  // updatedAt at the 45m age threshold) is a structurally empty set:
  // the reaper already flips that row to failed at 15m.
  try {
    const ageMin     = RUN_STALE_MIN();
    const silenceMin = RUN_SILENCE_MIN();
    const runs = await CampaignRun.find(buildStalledRunFilter({ now, ageMin, silenceMin }))
      .sort({ startedAt: 1 }).limit(20)
      .select('runId brandId total succeeded failed skipped startedAt updatedAt').lean();
    if (runs.length) {
      await alerts.notify({
        level: 'error',
        title: `${runs.length} campaign run(s) not progressing`,
        key:   'watchdog:runs-stalled',
        fields: {
          'running past': `${ageMin}m`,
          'silent past':  `${silenceMin}m`,
          'queued ads':   queuedAds ?? undefined
        },
        detail: runs.map((r) =>
          `${r.runId} ${r.succeeded || 0}✓/${r.failed || 0}✗/${r.skipped || 0}⊘ of ${r.total || 0} ` +
          `age=${Math.round((now - new Date(r.startedAt).getTime()) / 60000)}m ` +
          `idle=${Math.round((now - new Date(r.updatedAt).getTime()) / 60000)}m ` +
          `brand=${r.brandId || '-'}`
        ).join('\n')
      });
    }
  } catch (err) {
    console.warn(`🔔 watchdog[runs-stalled] failed: ${err.message}`);
  }

  // ── 3. DetectRun backlog (the worker's own queue) ──
  try {
    const [depth, oldest] = await Promise.all([
      DetectRun.countDocuments({ status: 'queued' }),
      DetectRun.findOne({ status: 'queued' }).sort({ createdAt: 1 }).select('createdAt').lean()
    ]);
    const oldestMin = oldest ? Math.round((now - new Date(oldest.createdAt).getTime()) / 60000) : 0;
    if (depth >= DETECT_BACKLOG_N() && oldestMin >= DETECT_BACKLOG_MIN()) {
      await alerts.notify({
        level: 'warn',
        title: `Detect queue backing up — ${depth} queued`,
        key:   'watchdog:detect-backlog',
        fields: {
          'queue depth': depth,
          'oldest':      `${oldestMin}m`,
          'thresholds':  `${DETECT_BACKLOG_N()} items / ${DETECT_BACKLOG_MIN()}m`
        }
      });
    }
  } catch (err) {
    console.warn(`🔔 watchdog[detect-backlog] failed: ${err.message}`);
  }

  // ── 4. Trailing-hour spend ──
  try {
    const ceiling = HOURLY_SPEND_USD();
    const rows = await CostLog.aggregate([
      { $match: { createdAt: { $gte: ago(60) } } },
      { $group: { _id: '$stage', usd: { $sum: '$costUsd' }, n: { $sum: 1 } } },
      { $sort: { usd: -1 } }
    ]);
    const total = rows.reduce((s, r) => s + (r.usd || 0), 0);
    if (total >= ceiling) {
      await alerts.notify({
        level: 'warn',
        title: `Spend $${total.toFixed(2)} in the last hour`,
        key:   'watchdog:spend',
        fields: { ceiling: `$${ceiling.toFixed(2)}`, calls: rows.reduce((s, r) => s + r.n, 0) },
        detail: rows.slice(0, 10).map((r) => `${r._id || 'unknown'}: $${(r.usd || 0).toFixed(2)} (${r.n} calls)`).join('\n')
      });
    }
  } catch (err) {
    console.warn(`🔔 watchdog[spend] failed: ${err.message}`);
  }
}

/**
 * Arm-2 predicate as a PURE function of now + the two thresholds.
 *
 * AGE  (startedAt  < now - ageMin)     — noise filter; default 45m.
 * SILENCE (updatedAt < now - silenceMin) — the trigger; default 12m.
 *
 * Extracted so a harness can evaluate the REAL filter against REAL
 * document shapes. The live query MUST call this; a copy in the
 * harness would drift.
 *
 * `now` is a Date or epoch-ms. Thresholds are minutes; omitted
 * values fall through to the env-configurable defaults.
 */
function buildStalledRunFilter({ now, ageMin, silenceMin } = {}) {
  const t = now instanceof Date ? now.getTime() : (Number(now) || Date.now());
  const age = ageMin != null ? Number(ageMin) : RUN_STALE_MIN();
  const silence = silenceMin != null ? Number(silenceMin) : RUN_SILENCE_MIN();
  return {
    // 'preparing' IS INCLUDED, and it is the arm that was actually missing.
    //
    // The reaper only matches status:'running', so a run that dies during
    // EXPANSION — the Director round, the mint — never leaves 'preparing'.
    // Nothing reaps it and, until this line, nothing alerted on it either:
    // this filter was 'running'-only, so the one state with no reaper was also
    // the one state with no warning.
    //
    // MEASURED 2026-08-13: eight such runs in production, the oldest 8.3 days
    // old, every one with total=0 / succeeded=0 / failed=0 and updatedAt never
    // moved off startedAt. Eight generations that silently did nothing and
    // reported nothing.
    //
    // They are also the SAFE half of the pair to alert on: 'preparing' means
    // expansion never finished, so the run holds no claimed ads and no spend —
    // the alert is about a silent no-op, not about stranded money.
    status: { $in: ['preparing', 'running'] },
    startedAt: { $lt: new Date(t - age * 60 * 1000) },
    updatedAt: { $lt: new Date(t - silence * 60 * 1000) }
  };
}

module.exports = {
  runWatchdog,
  buildStalledRunFilter,
  RUN_STALE_MIN,
  RUN_SILENCE_MIN,
  RENDERING_STALE_MIN
};
