'use strict';
/**
 * QC-insights aggregation loop.
 *
 * Collects Ad.visionQc verdicts over a sliding window, segments them, and
 * writes a QcInsightsReport. Structurally spend-incapable: this file must
 * never require atlasImageService, atlasVideoService, or renderService.
 *
 * The loop is STATIC-ads-only for prompt-override purposes (video prompt
 * text is frozen). Video QC verdicts still exist on their own gate; they
 * are excluded from this aggregation because the override mechanism only
 * ever touches services/staticAdIntents.js.
 */

const mongoose = require('mongoose');
const Ad = require('../models/Ad');
const CatalogProduct = require('../models/CatalogProduct');
const Media = require('../models/Media');
const QcInsightsReport = require('../models/QcInsightsReport');
const qc = require('./adVisionQcService');

const CATEGORIES = qc.CATEGORIES || Object.freeze([
  'competitor_marks', 'product_fidelity', 'text_defects', 'layout_safe_box'
]);

function parseBoolDefaultTrue(raw) {
  if (raw == null || String(raw).trim() === '') return true;
  return String(raw).toLowerCase() !== 'false';
}
function parseBoolExactTrue(raw) {
  return String(raw || '').trim().toLowerCase() === 'true';
}
function parsePositiveNumber(raw, fallback) {
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

const ENABLED = parseBoolDefaultTrue(process.env.QC_INSIGHTS_ENABLED);
const INTERVAL_HOURS = parsePositiveNumber(process.env.QC_INSIGHTS_INTERVAL_HOURS, 24);
const WINDOW_DAYS = parsePositiveNumber(process.env.QC_INSIGHTS_WINDOW_DAYS, 14);
const MIN_SEGMENT_N = parsePositiveNumber(process.env.QC_INSIGHTS_MIN_SEGMENT_N, 20);
const PROPOSALS_ENABLED = parseBoolExactTrue(process.env.QC_INSIGHTS_PROPOSALS_ENABLED);

let inFlight = false;
let _schedulerStarted = false;

/**
 * KNOWN, ACCEPTED LIMITATION (found in review, not fixed): `inFlight` is a
 * plain in-process boolean with NO cross-instance coordination — same
 * documented characteristic as `pacedModelSubmit` elsewhere in this
 * codebase. It bounds concurrency PER WEB INSTANCE, not per deployment, and
 * bounds concurrency, not RATE — nothing stops a caller invoking POST /run
 * repeatedly in series. Two manual POST /run calls landing on two different
 * autoscaled instances in the same instant can each see isRunning()===false
 * locally and both proceed, producing duplicate QcInsightsReport docs and
 * duplicate Slack notifications.
 *
 * Accepted as low-severity because: (1) /api/qc-insights is super-admin-only
 * (see routes/qcInsights.js header) — this is not attacker-reachable, only
 * an operator mistake; (2) the blast radius is analytics rows, no unique-
 * index violation, no data corruption; (3) QC_INSIGHTS_PROPOSALS_ENABLED
 * defaults false, so today a collision costs nothing. If that flag is ever
 * turned on, re-evaluate: two colliding runs would each pay the proposal
 * LLM call independently. Do not build a distributed lock preemptively —
 * revisit only if the flag is enabled AND a collision is observed.
 */
function isRunning() {
  return inFlight === true;
}

async function snapshotQcConfig() {
  const staticQcEnabled = (typeof qc.resolveStaticEnabled === 'function')
    ? await qc.resolveStaticEnabled()
    : (typeof qc.isStaticEnabled === 'function' ? qc.isStaticEnabled() : false);
  const videoQcEnabled = (typeof qc.resolveVideoEnabled === 'function')
    ? await qc.resolveVideoEnabled()
    : (typeof qc.isVideoEnabled === 'function' ? qc.isVideoEnabled() : false);
  return {
    staticQcEnabled: staticQcEnabled === true,
    videoQcEnabled: videoQcEnabled === true,
    mode: staticQcEnabled === true ? 'full' : 'off',
    samplePct: staticQcEnabled === true ? 100 : 0,
    proposalsEnabled: PROPOSALS_ENABLED
  };
}

function judgedStatus(visionQc) {
  if (!visionQc || typeof visionQc !== 'object') return 'unjudged';
  if (visionQc.skipped === true || visionQc.disabled === true) return 'unjudged';
  return 'judged';
}

function extractVerdictFacts(visionQc) {
  const empty = {
    judged: false,
    passed: false,
    attempt1Fail: false,
    regenRescued: false,
    categoryFails: Object.fromEntries(CATEGORIES.map((k) => [k, false])),
    findings: [],
    mode: visionQc && visionQc.mode ? String(visionQc.mode) : null
  };
  if (judgedStatus(visionQc) !== 'judged') return empty;
  const attempts = Array.isArray(visionQc.attempts) ? visionQc.attempts : [];
  const first = attempts[0] || null;
  const attempt1Fail = !!(first && first.pass === false);
  const passed = visionQc.passed === true;
  const regenRescued = attempt1Fail && passed === true;
  const last = attempts.length ? attempts[attempts.length - 1] : null;
  const cats = (last && last.categories) || (first && first.categories) || {};
  const categoryFails = {};
  const findings = [];
  for (const key of CATEGORIES) {
    const c = cats[key] || {};
    const fail = c.pass === false;
    categoryFails[key] = fail;
    if (Array.isArray(c.findings)) {
      for (const f of c.findings) {
        if (f) findings.push({ category: key, text: String(f) });
      }
    }
  }
  if (Array.isArray(visionQc.findings)) {
    for (const f of visionQc.findings) {
      if (f) findings.push({ category: 'general', text: String(f) });
    }
  }
  return { judged: true, passed, attempt1Fail, regenRescued, categoryFails, findings, mode: empty.mode };
}

function categoryPathFromProduct(product) {
  if (!product) return 'unknown';
  if (product.category && String(product.category).trim()) return String(product.category).trim();
  if (Array.isArray(product.inferredBreadcrumb) && product.inferredBreadcrumb.length) {
    return product.inferredBreadcrumb.join(' > ');
  }
  return 'unknown';
}

function segmentKeysForAd(ad, product, media) {
  const ir = (ad && ad.intentResolution) || {};
  const shot = (media && media.classification && media.classification.shotType)
    ? String(media.classification.shotType)
    : 'unknown';
  return {
    categoryTop: categoryPathFromProduct(product),
    shotType: shot || 'unknown',
    seedStyle: ir.seedStyle ? String(ir.seedStyle) : 'unstamped',
    surface: (ad && ad.platformFormat) ? String(ad.platformFormat) : 'unknown',
    intent: ir.delivered ? String(ir.delivered) : 'unknown'
  };
}

function emptyCatBucket() {
  return { n: 0, fails: 0, attempt1Fails: 0, regenRescued: 0 };
}

function computeStats(rows) {
  const totals = {
    judged: 0,
    passed: 0,
    attempt1Fails: 0,
    regenRescued: 0
  };
  const categories = {};
  for (const key of CATEGORIES) categories[key] = emptyCatBucket();
  const segmentMap = new Map();

  function segKey(dim, value) {
    return `${dim}::${value}`;
  }
  function ensureSeg(dim, value) {
    const k = segKey(dim, value);
    if (!segmentMap.has(k)) {
      segmentMap.set(k, {
        dimension: dim,
        value,
        n: 0,
        passed: 0,
        attempt1Fails: 0,
        regenRescued: 0,
        categories: Object.fromEntries(CATEGORIES.map((c) => [c, emptyCatBucket()]))
      });
    }
    return segmentMap.get(k);
  }

  for (const row of rows) {
    const facts = row.facts;
    if (!facts || !facts.judged) continue;
    totals.judged += 1;
    if (facts.passed) totals.passed += 1;
    if (facts.attempt1Fail) totals.attempt1Fails += 1;
    if (facts.regenRescued) totals.regenRescued += 1;
    for (const key of CATEGORIES) {
      categories[key].n += 1;
      if (facts.categoryFails[key]) categories[key].fails += 1;
      if (facts.attempt1Fail && facts.categoryFails[key]) categories[key].attempt1Fails += 1;
      if (facts.regenRescued && facts.categoryFails[key]) categories[key].regenRescued += 1;
    }
    const segs = row.segments || {};
    for (const dim of Object.keys(segs)) {
      const bucket = ensureSeg(dim, segs[dim]);
      bucket.n += 1;
      if (facts.passed) bucket.passed += 1;
      if (facts.attempt1Fail) bucket.attempt1Fails += 1;
      if (facts.regenRescued) bucket.regenRescued += 1;
      for (const key of CATEGORIES) {
        bucket.categories[key].n += 1;
        if (facts.categoryFails[key]) bucket.categories[key].fails += 1;
        if (facts.attempt1Fail && facts.categoryFails[key]) bucket.categories[key].attempt1Fails += 1;
        if (facts.regenRescued && facts.categoryFails[key]) bucket.categories[key].regenRescued += 1;
      }
    }
  }

  const passRate = totals.judged ? totals.passed / totals.judged : 0;
  const attempt1FailRate = totals.judged ? totals.attempt1Fails / totals.judged : 0;
  const regenRescueRate = totals.attempt1Fails ? totals.regenRescued / totals.attempt1Fails : 0;

  const segments = [];
  for (const bucket of segmentMap.values()) {
    if (bucket.n < 3) continue; // noise
    bucket.attempt1FailRate = bucket.n ? bucket.attempt1Fails / bucket.n : 0;
    bucket.passRate = bucket.n ? bucket.passed / bucket.n : 0;
    segments.push(bucket);
  }
  segments.sort((a, b) => b.attempt1FailRate - a.attempt1FailRate);

  return {
    totals: {
      ...totals,
      passRate,
      attempt1FailRate,
      regenRescueRate
    },
    categories,
    segments
  };
}

function classifySegmentVerdicts(stats, minN = MIN_SEGMENT_N) {
  const out = {};
  const globalN = (stats.totals && stats.totals.judged) || 0;
  for (const key of CATEGORIES) {
    const g = stats.categories[key] || emptyCatBucket();
    const gRate = g.n ? g.fails / g.n : 0;
    if (globalN < minN) {
      out[key] = { verdict: 'insufficient-data', concentrations: [] };
      continue;
    }
    if (gRate === 0) {
      out[key] = { verdict: 'clean', concentrations: [] };
      continue;
    }
    const concentrations = [];
    for (const seg of stats.segments || []) {
      if (seg.n < minN) continue;
      const s = (seg.categories && seg.categories[key]) || emptyCatBucket();
      const segRate = s.n ? s.fails / s.n : 0;
      const lift = gRate > 0 ? segRate / gRate : 0;
      const delta = segRate - gRate;
      if (lift >= 1.5 && delta >= 0.10) {
        concentrations.push({
          dimension: seg.dimension,
          value: seg.value,
          n: seg.n,
          rate: segRate,
          lift,
          delta
        });
      }
    }
    out[key] = {
      verdict: concentrations.length ? 'segment-specific' : 'general',
      concentrations
    };
  }
  return out;
}

function clusterFindings(rows) {
  const map = new Map();
  for (const row of rows) {
    const findings = (row.facts && row.facts.findings) || [];
    for (const f of findings) {
      const text = String(f.text || '').trim().toLowerCase();
      if (!text) continue;
      const key = `${f.category || 'general'}::${text}`;
      if (!map.has(key)) {
        map.set(key, { category: f.category || 'general', text: String(f.text || '').trim(), n: 0 });
      }
      map.get(key).n += 1;
    }
  }
  return [...map.values()].sort((a, b) => b.n - a.n).slice(0, 50);
}

function compareArms(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!row.facts || !row.facts.judged) continue;
    const flags = (row.ad && row.ad.intentResolution && row.ad.intentResolution.promptFlags) || {};
    const sha = (row.ad && row.ad.intentResolution && row.ad.intentResolution.promptSha256) || 'unstamped';
    const hardening = flags.fidelityHardening === true ? 'fid-on' : (flags.fidelityHardening === false ? 'fid-off' : 'fid-unstamped');
    const key = `${hardening}::${sha.slice(0, 12)}`;
    if (!map.has(key)) {
      map.set(key, { key, n: 0, passed: 0, attempt1Fails: 0, promptSha256: sha, promptFlags: flags });
    }
    const b = map.get(key);
    b.n += 1;
    if (row.facts.passed) b.passed += 1;
    if (row.facts.attempt1Fail) b.attempt1Fails += 1;
  }
  return [...map.values()].map((b) => ({
    ...b,
    passRate: b.n ? b.passed / b.n : 0,
    attempt1FailRate: b.n ? b.attempt1Fails / b.n : 0
  })).sort((a, b) => b.n - a.n);
}

function evaluateOverrides(rows, minN = MIN_SEGMENT_N) {
  const byId = new Map();
  const baseline = { n: 0, attempt1Fails: 0 };
  for (const row of rows) {
    if (!row.facts || !row.facts.judged) continue;
    const flags = (row.ad && row.ad.intentResolution && row.ad.intentResolution.promptFlags) || {};
    const ids = Array.isArray(flags.segmentOverrides) ? flags.segmentOverrides : [];
    if (!ids.length) {
      baseline.n += 1;
      if (row.facts.attempt1Fail) baseline.attempt1Fails += 1;
      continue;
    }
    for (const id of ids) {
      if (!byId.has(id)) byId.set(id, { id, n: 0, attempt1Fails: 0 });
      const b = byId.get(id);
      b.n += 1;
      if (row.facts.attempt1Fail) b.attempt1Fails += 1;
    }
  }
  const baseRate = baseline.n ? baseline.attempt1Fails / baseline.n : 0;
  const out = [];
  for (const b of byId.values()) {
    const rate = b.n ? b.attempt1Fails / b.n : 0;
    let recommendation = 'inconclusive';
    if (b.n < minN || baseline.n < minN) recommendation = 'inconclusive';
    else if (rate - baseRate >= 0.10) recommendation = 'revert';
    else if (baseRate - rate >= 0.10) recommendation = 'keep';
    out.push({
      id: b.id,
      n: b.n,
      attempt1FailRate: rate,
      baselineN: baseline.n,
      baselineAttempt1FailRate: baseRate,
      recommendation
    });
  }
  return out;
}

async function collectWindowData(windowStart, windowEnd) {
  const idFloor = mongoose.Types.ObjectId.createFromTime(
    Math.max(0, Math.floor(windowStart.getTime() / 1000) - 86400)
  );
  const ads = await Ad.find({
    _id: { $gte: idFloor },
    generatedAt: { $gte: windowStart, $lte: windowEnd },
    kind: 'image'
  }).select('visionQc intentResolution platformFormat productId mediaId kind generatedAt').lean();

  const productIds = [...new Set(ads.map((a) => a.productId).filter(Boolean).map(String))];
  const mediaIds = [...new Set(ads.map((a) => a.mediaId).filter(Boolean).map(String))];
  const [products, medias] = await Promise.all([
    productIds.length
      ? CatalogProduct.find({ _id: { $in: productIds } }).select('category inferredBreadcrumb').lean()
      : [],
    mediaIds.length
      ? Media.find({ _id: { $in: mediaIds } }).select('classification.shotType').lean()
      : []
  ]);
  const productById = new Map(products.map((p) => [String(p._id), p]));
  const mediaById = new Map(medias.map((m) => [String(m._id), m]));

  const rows = [];
  let adsWithVerdicts = 0;
  for (const ad of ads) {
    if (ad.visionQc) adsWithVerdicts += 1;
    const facts = extractVerdictFacts(ad.visionQc);
    const product = ad.productId ? productById.get(String(ad.productId)) : null;
    const media = ad.mediaId ? mediaById.get(String(ad.mediaId)) : null;
    rows.push({
      ad,
      facts,
      segments: segmentKeysForAd(ad, product, media)
    });
  }
  return { ads, rows, adsWithVerdicts };
}

function slackLine(report) {
  const t = report.totals || {};
  const judged = t.judged || 0;
  const passPct = judged ? Math.round((t.passRate || 0) * 100) : 0;
  const a1 = judged ? Math.round((t.attempt1FailRate || 0) * 100) : 0;
  const cfg = report.qcConfig || {};
  const staticLabel = cfg.staticQcEnabled ? 'ON' : 'OFF';
  const videoLabel = cfg.videoQcEnabled ? 'ON' : 'OFF';
  return `QC insights ${new Date(report.generatedAt).toISOString().slice(0, 10)} · judged ${judged} · pass ${passPct}% · attempt-1 fail ${a1}% · Static QC ${staticLabel} · Video QC ${videoLabel}`;
}

async function runNow() {
  if (inFlight) {
    const err = new Error('qc-insights run already in flight');
    err.status = 409;
    throw err;
  }
  inFlight = true;
  const started = Date.now();
  try {
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - WINDOW_DAYS * 86400000);
    const qcConfig = await snapshotQcConfig();
    const { ads, rows, adsWithVerdicts } = await collectWindowData(windowStart, windowEnd);
    const stats = computeStats(rows);
    const segmentVerdicts = classifySegmentVerdicts(stats, MIN_SEGMENT_N);
    const findingsClusters = clusterFindings(rows);
    const armComparison = compareArms(rows);
    const overridePerformance = evaluateOverrides(rows, MIN_SEGMENT_N);
    const notes = [];
    if (!qcConfig.staticQcEnabled || !qcConfig.videoQcEnabled) {
      notes.push('One or both vision-QC gates are OFF — coverage gap; banner the report.');
    }
    notes.push('Aggregation is STATIC ads only (kind=image). Video prompt text is frozen and out of scope for prompt overrides.');

    const doc = await QcInsightsReport.create({
      schemaVersion: 1,
      windowStart,
      windowEnd,
      generatedAt: new Date(),
      durationMs: Date.now() - started,
      adsScanned: ads.length,
      adsWithVerdicts,
      qcConfig,
      totals: stats.totals,
      categories: stats.categories,
      segmentVerdicts,
      segments: stats.segments,
      findingsClusters,
      armComparison,
      overridePerformance,
      proposals: [],
      proposalsProvenance: null,
      notes
    });

    try {
      const alerts = require('./alertService');
      const channel = (process.env.SLACK_QC_INSIGHTS_CHANNEL || '').trim() || undefined;
      alerts.notifyAsync({
        level: 'warn',
        key: 'qc-insights:report',
        title: slackLine(doc),
        channel
      });
    } catch (err) {
      console.warn(`   ⚠️  qc-insights: slack ping failed: ${err.message}`);
    }

    return doc;
  } finally {
    inFlight = false;
  }
}

async function maybeAttachProposals(report) {
  if (!PROPOSALS_ENABLED) return report;
  if (!report) return report;
  try {
    const { generateAndAttachProposals } = require('./qcInsightsProposalService');
    return await generateAndAttachProposals(report);
  } catch (err) {
    console.warn(`   ⚠️  qc-insights: proposal stage skipped: ${err && err.message ? err.message : err}`);
    return report;
  }
}

function startScheduler() {
  if (_schedulerStarted) return;
  _schedulerStarted = true;
  if (!ENABLED) {
    console.log('📊 qc-insights: disabled (QC_INSIGHTS_ENABLED=false)');
    return;
  }
  const ms = Math.max(1, INTERVAL_HOURS) * 3600 * 1000;
  const tick = () => {
    if (inFlight) return;
    runNow()
      .then((report) => maybeAttachProposals(report))
      .catch((err) => console.warn(`⚠️  qc-insights tick failed: ${err.message}`));
  };
  setTimeout(tick, 120 * 1000);
  setInterval(tick, ms);
  console.log(`📊 qc-insights: every ${INTERVAL_HOURS}h (window ${WINDOW_DAYS}d, minN ${MIN_SEGMENT_N}, proposals ${PROPOSALS_ENABLED ? 'on' : 'off'})`);
}

module.exports = {
  snapshotQcConfig,
  judgedStatus,
  extractVerdictFacts,
  segmentKeysForAd,
  computeStats,
  classifySegmentVerdicts,
  clusterFindings,
  compareArms,
  evaluateOverrides,
  collectWindowData,
  runNow,
  startScheduler,
  maybeAttachProposals,
  isRunning,
  ENABLED,
  INTERVAL_HOURS,
  WINDOW_DAYS,
  MIN_SEGMENT_N,
  PROPOSALS_ENABLED,
  CATEGORIES
};
