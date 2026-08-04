#!/usr/bin/env node
//
// typeExperimentRun.js — the WHOLE type experiment as one re-runnable pipeline.
//
// Owner, verbatim: "test the entire proposed workstream". This is that: one
// command that selects the masters, captures the baseline, runs both arms over
// the same masters, and writes a single results file the comparison artifact is
// built from. Phases are resumable, so a failure does not cost the earlier work.
//
// RUNS ON THE POD (needs Mongo + Remotion). The artifact is built locally from
// the results file, because frames must be downloaded next to the HTML.
//
//   node scripts/typeExperimentRun.js --dir=/tmp/typeexp --count=30
//   node scripts/typeExperimentRun.js --dir=/tmp/typeexp --phases=pool,baseline
//   node scripts/typeExperimentRun.js --dir=/tmp/typeexp --phases=armA
//   node scripts/typeExperimentRun.js --dir=/tmp/typeexp --phases=extract,armB,collect
//   node scripts/typeExperimentRun.js --dir=/tmp/typeexp --dry-run
//
// PHASES
//   pool      $0  select the masters, resolve each brand's real type + ink
//   baseline  $0  record the renderUrl of every selected ad BEFORE anything
//                 overwrites it. Must run before any arm.
//   armA      $0  re-title all selected ads on the deployed canonical engine
//                 (disciplined deterministic: monochrome ink + the font ladder)
//   extract   ¢   one vision call per BRAND -> type template -> preset file
//   armB      $0  re-title each brand's ads with --preset=typetpl-<brand>
//   autonomy  ¢   one vision call per AD -> a per-ad type plan (arm C)
//   armC      $0  re-title each ad with its OWN plan, --preset=typeauto-<adId>
//   collect   $0  read every renderUrl back and write results.json
//   qc        ¢   judge every row of every arm for readability + on-brand feel
//
// MONEY: the billable phases are `extract`, `autonomy` and `qc` (cents of vision
// LLM each, ledgered, never auto-retried). Every re-title is
// $0 — retitleDriver re-composites Remotion chrome over the already-paid Omni
// master and never submits a generation. Face-detection vision can cost ~$0.02
// on a cold basePlate cache for cropped formats; these masters have been titled
// before, so that cache is warm.
//
// WHY ARM A RUNS BEFORE ARM B: both overwrite Ad.renderUrl, so the URLs are read
// back after each arm and stored per-arm in results.json. Nothing relies on an
// old URL still resolving.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'config', 'defaults.env') });
const fs = require('fs');
const { spawnSync } = require('child_process');
const mongoose = require('mongoose');

const args = process.argv.slice(2);
const flag = (n, d = null) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const has = (n) => args.includes(`--${n}`);

const DIR = flag('dir', '/tmp/typeexp');
const COUNT = flag('count', '30');
const DRY_RUN = has('dry-run');
const ALL_PHASES = ['pool', 'baseline', 'armA', 'extract', 'armB', 'autonomy', 'armC', 'collect', 'qc'];
const PHASES = (flag('phases', ALL_PHASES.join(',')) || '').split(',').map((s) => s.trim()).filter(Boolean);
const BRANDS_FILTER = flag('brands', '');
// SLICE. Render-ssh sessions are dropped by the remote after roughly half an
// hour and the pod filesystem is per-session, so a 30-ad arm cannot run in one
// call: measured throughput is ~6 minutes per re-title, i.e. ~3 hours per arm.
// `--ads=1-10` runs an index range so several sessions can cover an arm in
// parallel, each finishing well inside the drop window. Durable state makes the
// chunks additive: recordColumn merges per-ad, so a partial chunk records only
// the ads it actually re-titled and never mislabels the rest.
const ADS_RANGE = flag('ads', null);

const F = {
  pool: path.join(DIR, 'pool.json'),
  templates: path.join(DIR, 'templates.json'),
  autonomy: path.join(DIR, 'autonomy.json'),
  qc: path.join(DIR, 'qc.json'),
  results: path.join(DIR, 'results.json'),
  log: path.join(DIR, 'run.log'),
};

fs.mkdirSync(DIR, { recursive: true });

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
function log(msg) {
  const line = `[${stamp()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(F.log, line + '\n'); } catch { /* log is best-effort */ }
}

/** Run a sibling script with inherited stdio. Returns true on exit 0. */
function run(script, scriptArgs) {
  const argv = [path.join(__dirname, script), ...scriptArgs];
  log(`▶ node ${script} ${scriptArgs.join(' ')}`);
  if (DRY_RUN) { log('  (dry-run: not executed)'); return true; }
  const res = spawnSync(process.execPath, argv, { stdio: 'inherit', env: process.env });
  if (res.status !== 0) log(`✖ ${script} exited ${res.status}`);
  return res.status === 0;
}

const pendingPersist = [];
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2));

/** Merge a column of renderUrls into results.json without losing other columns. */
async function recordColumn(name, urlsByAdId, extra = {}) {
  const results = fs.existsSync(F.results) ? readJson(F.results) : { columns: [], rows: {}, meta: {} };
  if (!results.columns.includes(name)) results.columns.push(name);
  for (const [adId, url] of Object.entries(urlsByAdId)) {
    results.rows[adId] = results.rows[adId] || {};
    results.rows[adId][name] = url;
  }
  results.meta[name] = { recordedAt: new Date().toISOString(), ...extra };
  writeJson(F.results, results);
  // AWAITED, not fire-and-forget. The first version pushed the promise onto a
  // list awaited only at exit, and the write never landed — the state document
  // held `pool` and nothing else. A dropped session after an arm must not lose the
  // only record of that arm's URLs, because the next re-title overwrites them.
  if (!DRY_RUN) await stateSave('results', results);
  const missing = Object.values(urlsByAdId).filter((u) => !u).length;
  log(`📊 column '${name}': ${Object.keys(urlsByAdId).length} ads, ${missing} with no renderUrl`);
}

/** Current renderUrl for every ad in the pool, straight from Mongo. */
async function currentUrls(adIds) {
  const Ad = require('../models/Ad');
  const rows = await Ad.find({ _id: { $in: adIds } }).select('renderUrl status').lean();
  const out = {};
  for (const id of adIds) out[String(id)] = null;
  for (const r of rows) out[String(r._id)] = r.renderUrl || null;
  return out;
}

const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ── STATE MUST OUTLIVE THE SSH SESSION ─────────────────────────────────
//
// The pod's /tmp is PER-SSH-SESSION, not per-pod: a manifest written in one
// `render-ssh` call is gone by the next one (measured — /tmp was empty and
// freshly stamped 30 seconds after a successful pool run). That breaks resumable
// phases, and it corrupts the experiment in a way that would not be obvious:
// re-deriving the pool after arm A has run captures ARM A's renderUrl as the
// "baseline", so the before/after comparison would silently compare an arm
// against itself.
//
// So every phase artifact is mirrored into one Mongo document, and any missing
// local file is restored from it on start. The collection is created on demand
// and is defined HERE rather than in models/ — this is experiment scaffolding and
// must add no production surface. Drop it with:
//   db.type_experiment_state.deleteMany({})
const RUN_ID = flag('run', 'default');
const STATE_COLL = 'type_experiment_state';

async function stateDoc() {
  return mongoose.connection.collection(STATE_COLL).findOne({ _id: RUN_ID });
}
async function stateSave(key, value) {
  await mongoose.connection.collection(STATE_COLL).updateOne(
    { _id: RUN_ID },
    { $set: { [key]: value, updatedAt: new Date() } },
    { upsert: true }
  );
}
/** Restore any phase file this session is missing from the durable copy. */
async function stateRestore() {
  const doc = await stateDoc();
  if (!doc) { log(`state: no durable copy for run '${RUN_ID}' yet`); return; }
  let restored = 0;
  for (const [key, file] of [['pool', F.pool], ['templates', F.templates],
    ['autonomy', F.autonomy], ['results', F.results], ['qc', F.qc]]) {
    if (doc[key] && !fs.existsSync(file)) { writeJson(file, doc[key]); restored++; }
  }
  log(`state: restored ${restored} artifact(s) from run '${RUN_ID}' (saved ${doc.updatedAt?.toISOString?.() || '?'})`);
}
/** Mirror whatever this session produced back into the durable copy. */
async function statePersist() {
  for (const [key, file] of [['pool', F.pool], ['templates', F.templates],
    ['autonomy', F.autonomy], ['results', F.results], ['qc', F.qc]]) {
    if (fs.existsSync(file)) await stateSave(key, readJson(file));
  }
  log(`state: persisted run '${RUN_ID}'`);
}

(async () => {
  log(`=== type experiment: run '${RUN_ID}', phases ${PHASES.join(',')} → ${DIR} ===`);
  // Connect BEFORE the pool phase so a previous session's manifest can be
  // restored — otherwise `pool` would re-derive and clobber the baseline.
  if (!DRY_RUN) { await mongoose.connect(process.env.MONGODB_URI); await stateRestore(); }

  // ── pool ────────────────────────────────────────────────────────────
  if (PHASES.includes('pool')) {
    if (fs.existsSync(F.pool) && !has('reselect')) {
      log('⏭  pool already exists for this run — reusing it (pass --reselect to pick a new set). ' +
        'Re-deriving after an arm has run would capture that arm as the baseline.');
    } else {
      const a = [`--count=${COUNT}`, `--out=${F.pool}`, '--print'];
      if (BRANDS_FILTER) a.push(`--brands=${BRANDS_FILTER}`);
      if (!run('typeExperimentPool.js', a)) process.exit(1);
      if (!DRY_RUN) await stateSave('pool', readJson(F.pool));
    }
  }
  if (!fs.existsSync(F.pool) && !DRY_RUN) {
    log(`✖ no ${F.pool} — run the pool phase first`); process.exit(1);
  }
  const pool = fs.existsSync(F.pool) ? readJson(F.pool) : { ads: [], brands: {} };
  const allAds = pool.ads;
  let sliceAds = allAds;
  if (ADS_RANGE) {
    const [a, b] = ADS_RANGE.split('-').map((n) => parseInt(n, 10));
    sliceAds = allAds.slice(Math.max(0, (a || 1) - 1), b || a || allAds.length);
    log(`slice --ads=${ADS_RANGE} → ${sliceAds.length} of ${allAds.length} ad(s): ` +
      sliceAds.map((x) => `${x.brand} ${x.aspectRatio}`).join(' | '));
  }
  const adIds = sliceAds.map((a) => a.adId);
  log(`pool: ${adIds.length} ads across ${new Set(pool.ads.map((a) => a.brand)).size} brands`);

  // Any ad whose brand is pinned to a brand-specific preset is NOT a valid row:
  // that preset replaces the canonical type decisions both arms are testing.
  const pinned = pool.ads.filter((a) => pool.brands?.[a.brand]?.titleStylePreset);
  if (pinned.length) {
    log(`⚠️  ${pinned.length} ad(s) belong to brands pinned to a brand-specific ` +
      `titleStylePreset (${[...new Set(pinned.map((p) => `${p.brand}→${pool.brands[p.brand].titleStylePreset}`))].join(', ')}) ` +
      `— their canonical arm is not what renders. Reported, not silently dropped.`);
  }

  // ── baseline ────────────────────────────────────────────────────────
  if (PHASES.includes('baseline')) {
    if (DRY_RUN) log('(dry-run) would record baseline URLs');
    else {
      // Prefer the URL the pool captured at selection time; fall back to a live
      // read. If an arm already ran, this phase would otherwise silently record
      // an arm's output as the baseline — so refuse to overwrite an existing one.
      const existing = fs.existsSync(F.results) ? readJson(F.results) : null;
      if (existing?.columns?.includes('baseline')) {
        log('⏭  baseline already recorded — refusing to overwrite (it would capture an arm as the before)');
      } else {
        const fromPool = {};
        for (const a of pool.ads) fromPool[a.adId] = a.baselineRenderUrl || null;
        await recordColumn('baseline', fromPool, { source: 'pool selection', note: 'pre-experiment renders' });
      }
    }
  }

  // ── arm A ───────────────────────────────────────────────────────────
  if (PHASES.includes('armA')) {
    // NEVER hand the driver an empty --ids. retitleDriver's no-ids mode re-titles
    // the WHOLE LIBRARY (382 ads), which is a sweep the owner has not approved.
    // An empty pool must abort, not quietly become a library-wide run.
    if (!adIds.length) { log('✖ refusing to run arm A with an empty id list — that is a library-wide sweep'); process.exit(1); }
    if (!run('retitleDriver.js', [`--ids=${adIds.join(',')}`, `--log=${path.join(DIR, 'armA.progress.log')}`])) {
      log('✖ arm A driver failed — not recording a partial column as complete');
    }
    if (!DRY_RUN) await recordColumn('armA', await currentUrls(adIds), { engine: 'canonical + monochrome ink + font ladder' });
  }

  // ── extract (THE ONLY BILLABLE PHASE) ───────────────────────────────
  if (PHASES.includes('extract')) {
    const brands = [...new Set(pool.ads.map((a) => a.brand))];
    if (fs.existsSync(F.templates) && !has('re-extract')) {
      // Templates were restored from the durable copy, so the vision calls are
      // already paid for. The PRESET FILES cannot be restored — the pod
      // filesystem is per-session — so they are recompiled from the stored
      // templates instead, which costs nothing.
      log('♻️  extract: reusing stored templates (already paid for) — recompiling presets only');
      run('typeTemplateExtract.js', [`--templates=${F.templates}`, '--emit-presets']);
    } else {
      const a = [`--from-pool=${F.pool}`, `--out=${F.templates}`, '--emit-presets'];
      if (DRY_RUN) a.push('--dry-run');
      log(`💰 extract: up to ${brands.length} billable vision call(s), one per brand`);
      if (!run('typeTemplateExtract.js', a)) log('✖ extraction failed — arm B will have no presets');
      if (!DRY_RUN && fs.existsSync(F.templates)) await stateSave('templates', readJson(F.templates));
    }
  }

  // ── arm B ───────────────────────────────────────────────────────────
  if (PHASES.includes('armB')) {
    const templates = fs.existsSync(F.templates) ? readJson(F.templates) : { templates: {} };
    const byBrand = new Map();
    for (const a of pool.ads) {
      if (!byBrand.has(a.brand)) byBrand.set(a.brand, []);
      byBrand.get(a.brand).push(a.adId);
    }
    for (const [brand, ids] of byBrand) {
      const preset = `typetpl-${slugify(brand)}`;
      const presetFile = path.join(__dirname, '..', 'remotion', 'presets', `${preset}.json`);
      if (!templates.templates?.[brand]) { log(`⏭  ${brand}: no template extracted — skipping ${ids.length} ad(s)`); continue; }
      if (!fs.existsSync(presetFile) && !DRY_RUN) {
        // A missing file is the silent-no-op trap: --preset falls through to the
        // normal ladder with a warning and arm B would render as arm A.
        log(`⏭  ${brand}: ${preset}.json missing on this pod — skipping rather than rendering arm A twice`);
        continue;
      }
      run('retitleDriver.js', [`--ids=${ids.join(',')}`, `--preset=${preset}`,
        `--log=${path.join(DIR, `armB.${slugify(brand)}.log`)}`]);
    }
    if (!DRY_RUN) await recordColumn('armB', await currentUrls(adIds), { engine: 'per-brand type template from own statics' });
  }

  // ── autonomy (ARM C plans — billable, one vision call per AD) ───────
  if (PHASES.includes('autonomy')) {
    if (fs.existsSync(F.autonomy) && !has('re-plan')) {
      log('♻️  autonomy: reusing stored per-ad plans (already paid for) — recompiling presets only');
      run('typeAutonomyArm.js', [`--pool=${F.pool}`, `--plans=${F.autonomy}`, '--emit-presets']);
    } else {
      const a = [`--pool=${F.pool}`, `--out=${F.autonomy}`, '--emit-presets'];
      if (DRY_RUN) a.push('--dry-run');
      log(`💰 autonomy: up to ${adIds.length} billable vision call(s), one per AD`);
      if (!run('typeAutonomyArm.js', a)) log('✖ arm C planning failed — arm C will have no presets');
      if (!DRY_RUN && fs.existsSync(F.autonomy)) await stateSave('autonomy', readJson(F.autonomy));
    }
  }

  // ── arm C ───────────────────────────────────────────────────────────
  if (PHASES.includes('armC')) {
    const plans = fs.existsSync(F.autonomy) ? readJson(F.autonomy) : { plans: {} };
    let ran = 0;
    for (const ad of sliceAds) {
      const plan = plans.plans?.[ad.adId];
      if (!plan || plan._dryRun) { log(`⏭  ${ad.adId}: no arm C plan`); continue; }
      const preset = `typeauto-${ad.adId}`;
      if (!fs.existsSync(path.join(__dirname, '..', 'remotion', 'presets', `${preset}.json`)) && !DRY_RUN) {
        log(`⏭  ${ad.adId}: ${preset}.json missing — skipping rather than rendering arm A again`);
        continue;
      }
      // One driver invocation per ad: each ad has its OWN preset in this arm.
      run('retitleDriver.js', [`--ids=${ad.adId}`, `--preset=${preset}`,
        `--log=${path.join(DIR, 'armC.progress.log')}`]);
      ran++;
    }
    log(`arm C: ${ran} ad(s) re-titled with a per-ad plan`);
    if (!DRY_RUN) await recordColumn('armC', await currentUrls(adIds), { engine: 'per-ad LLM type plan (autonomy)' });
  }

  // ── collect ─────────────────────────────────────────────────────────
  if (PHASES.includes('collect') && !DRY_RUN) {
    const results = fs.existsSync(F.results) ? readJson(F.results) : { columns: [], rows: {}, meta: {} };
    // The baseline is recoverable even if its column was lost: the pool manifest
    // captured each ad's renderUrl BEFORE any arm ran, and the manifest is
    // durable. Rebuild rather than leave the before-column empty.
    if (!results.columns.includes('baseline')) {
      results.columns.unshift('baseline');
      for (const a of allAds) {
        results.rows[a.adId] = results.rows[a.adId] || {};
        results.rows[a.adId].baseline = a.baselineRenderUrl || null;
      }
      log('🔁 rebuilt the baseline column from the pool manifest');
    }
    results.pool = pool;
    results.templates = fs.existsSync(F.templates) ? readJson(F.templates) : null;
    results.finishedAt = new Date().toISOString();
    // Per-row annotation so a difference in the artifact is attributable to an
    // input rather than guessed at.
    for (const a of allAds) {
      const t = pool.brands?.[a.brand];
      results.rows[a.adId] = {
        ...(results.rows[a.adId] || {}),
        brand: a.brand, aspectRatio: a.aspectRatio,
        seedLum: a.seedLum, seedSat: a.seedSat,
        subjectFraction: a.subjectFraction, compBucket: a.compBucket, lumBucket: a.lumBucket,
        headline: a.headline,
        fonts: t?.fonts || null, inks: t?.inks || null, scanned: t?.scanned || null,
        titleStylePreset: t?.titleStylePreset || null,
      };
    }
    writeJson(F.results, results);
    log(`📝 ${F.results} — columns: ${results.columns.join(', ')}`);
    const complete = Object.values(results.rows).filter((r) => results.columns.every((c) => r[c])).length;
    log(`📊 rows complete across every column: ${complete}/${Object.keys(results.rows).length}`);
  }

  // ── qc (billable: one vision call per row per arm) ──────────────────
  if (PHASES.includes('qc')) {
    const a = [`--results=${F.results}`, `--out=${F.qc}`];
    if (DRY_RUN) a.push('--dry-run');
    log('💰 qc: one billable vision call per row per arm');
    run('typeQcRenders.js', a);
  }

  if (!DRY_RUN) { await Promise.all(pendingPersist); await statePersist(); }
  if (mongoose.connection.readyState) await mongoose.disconnect();
  log('=== done ===');
  process.exit(0);
})().catch((err) => { log(`💥 ${err.stack || err}`); process.exit(1); });
