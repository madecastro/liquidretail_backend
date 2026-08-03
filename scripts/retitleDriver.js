#!/usr/bin/env node
//
// retitleDriver.js — serial re-titling driver for production (SSH on the box).
//
// Re-renders Remotion brand-script chrome over each ad's already-paid Omni
// master (ad.veoVideoUrl). Powers a visual-quality scoring sweep.
//
// IT MUST NEVER TRIGGER A BILLABLE GENERATION (Omni / image-gen).
//
// ── MONEY INVARIANT (verified 2026-08-02) ─────────────────────────────
// renderBrandScriptAndSave (services/brandScriptExecutor.js:1120-1171)
// always resolves to remotion via resolveTitlingEngine hard-wire
// (:920-929 → engine:'remotion' unconditionally) and calls
// renderWithRemotionAndSave (:1004-1112). That path:
//
//   1. Requires ad.veoVideoUrl (throws 400 if missing) — :1005-1008
//   2. buildMetaForAd — Mongo reads only (LayoutInput / CatalogProduct /
//      Media / IntegrationCredential); no Atlas — :666+
//   3. resolveSpec / buildBrandTokens (titleSpecService) — local
//   4. resolveBasePlateVideoUrl (basePlateCropService) — Cloudinary
//      c_crop derivative of the EXISTING master, or the raw master.
//      Never submits video/image generation.
//   5. remotionRenderService.renderTitles — local Remotion compositor
//      over plateUrl (cropped master or ad.veoVideoUrl)
//   6. uploadRenderAndStamp → cloudinaryService.uploadBufferToCloudinary
//      (upload of the titled mp4) + Ad.updateOne { renderUrl, status:'draft' }
//
// Confirmed NOT reachable from renderBrandScriptAndSave:
//   - atlasVideoService (no require / no submit / no generateForAd)
//   - atlasImageService.editImage (no require / no call)
//   - Any Atlas /model/generateImage or /model/generateVideo POST
// Grep of brandScriptExecutor.js, remotionRenderService.js,
// titleSpecService.js, plateIntelService.js: zero atlasVideo/atlasImage
// /editImage/generate paths.
//
// SIDE COST (not generation; not blocked): basePlateCropService may call
// atlasLlmService.chatCompletion for face-detection vision on cache miss
// (basePlateCropService.js:196-213, ~4 frames, ~$0.02). Cached re-titles
// (Ad.basePlate bound to current veoVideoUrl) and full-frame formats
// (9:16 on 9:16 master) cost $0 vision (basePlateCropService.js:45-47,
// :307-310, :145-148). This driver never re-submits Omni.
//
// Usage (on the production box, MONGODB_URI already in env):
//   node scripts/retitleDriver.js
//   node scripts/retitleDriver.js --formats=meta_reels_9_16,meta_feed_4_5
//   node scripts/retitleDriver.js --limit=10 --skip=0
//   node scripts/retitleDriver.js --ids=abc,def
//   node scripts/retitleDriver.js --dry-run
//   node scripts/retitleDriver.js --log=/tmp/retitle-progress.log
//   node scripts/retitleDriver.js --preset=canonical-conversion
//
// --preset=<name> forces remotion/presets/<name>.json for every ad
// (argument only — NEVER written to Brand/Ad). Invalid names fall through
// to the normal resolveSpec ladder with a warning.
//
// STRICTLY SERIAL: one renderBrandScriptAndSave at a time. Remotion peaks
// 1.5-3GB; parallel renders can OOM the box.
//
// SIGTERM: finishes the current render (if any), writes the summary line,
// exits 0. Does not start a new ad after the signal.

require('dotenv').config();
require('dotenv').config({ path: require('path').join(__dirname, '..', 'config', 'defaults.env') });

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const Ad = require('../models/Ad');
const Brand = require('../models/Brand');
const { renderBrandScriptAndSave } = require('../services/brandScriptExecutor');

const DEFAULT_FORMATS = [
  'meta_reels_9_16',
  'meta_stories_9_16',
  'meta_feed_4_5',
  'meta_feed_1_1',
];
const DEFAULT_LOG = '/tmp/retitle-progress.log';

// ── args ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {
    limit: null,
    skip: 0,
    ids: null,
    formats: DEFAULT_FORMATS.slice(),
    dryRun: false,
    log: DEFAULT_LOG,
    preset: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    let key, val;
    if (a.startsWith('--') && eq > 0) {
      key = a.slice(2, eq);
      val = a.slice(eq + 1);
    } else if (a.startsWith('--')) {
      key = a.slice(2);
      val = argv[i + 1];
      // flags without values
      if (key === 'dry-run') { out.dryRun = true; continue; }
      if (val === undefined || String(val).startsWith('--')) {
        console.error(`--${key} needs a value`);
        process.exit(1);
      }
      i++;
    } else {
      console.error(`Unexpected argument: ${a}`);
      process.exit(1);
    }

    if (key === 'dry-run') { out.dryRun = true; continue; }
    if (key === 'limit') {
      const n = parseInt(val, 10);
      if (!Number.isFinite(n) || n < 0) { console.error('--limit must be a non-negative integer'); process.exit(1); }
      out.limit = n;
      continue;
    }
    if (key === 'skip') {
      const n = parseInt(val, 10);
      if (!Number.isFinite(n) || n < 0) { console.error('--skip must be a non-negative integer'); process.exit(1); }
      out.skip = n;
      continue;
    }
    if (key === 'ids') {
      out.ids = String(val).split(',').map(s => s.trim()).filter(Boolean);
      if (!out.ids.length) { console.error('--ids needs at least one id'); process.exit(1); }
      continue;
    }
    if (key === 'formats') {
      out.formats = String(val).split(',').map(s => s.trim()).filter(Boolean);
      if (!out.formats.length) { console.error('--formats needs at least one format'); process.exit(1); }
      continue;
    }
    if (key === 'log') {
      out.log = String(val);
      continue;
    }
    if (key === 'preset') {
      const name = String(val || '').trim();
      if (!name) { console.error('--preset needs a preset name (e.g. canonical-conversion)'); process.exit(1); }
      out.preset = name;
      continue;
    }
    console.error(`Unknown flag: --${key}`);
    process.exit(1);
  }
  return out;
}

const opts = parseArgs(process.argv.slice(2));

// ── logging ──────────────────────────────────────────────────────────

function ensureLogDir(logPath) {
  const dir = path.dirname(logPath);
  if (dir && dir !== '.' && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function appendLine(logPath, obj) {
  const line = JSON.stringify(obj);
  console.log(line);
  fs.appendFileSync(logPath, line + '\n');
}

// ── SIGTERM: finish current ad, then stop ────────────────────────────

let stopRequested = false;
let inFlight = false;
let shuttingDown = false;

function onSignal(sig) {
  if (stopRequested) return;
  stopRequested = true;
  console.error(`\n${sig} received — will finish current render (if any), write summary, exit`);
}

process.on('SIGTERM', () => onSignal('SIGTERM'));
process.on('SIGINT', () => onSignal('SIGINT'));

// ── main ─────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI not set');
    process.exit(1);
  }

  ensureLogDir(opts.log);
  await mongoose.connect(process.env.MONGODB_URI);

  let adIds;
  if (opts.ids) {
    // --ids overrides the query entirely
    adIds = opts.ids.map(id => {
      if (!mongoose.Types.ObjectId.isValid(id)) {
        console.error(`Invalid ObjectId in --ids: ${id}`);
        process.exit(1);
      }
      return new mongoose.Types.ObjectId(id);
    });
  } else {
    const filter = {
      renderRoute: 'veo',
      veoVideoUrl: { $ne: null },
      platformFormat: { $in: opts.formats },
    };
    let q = Ad.find(filter).select('_id').sort({ _id: 1 }).lean();
    if (opts.skip) q = q.skip(opts.skip);
    if (opts.limit != null) q = q.limit(opts.limit);
    const rows = await q;
    adIds = rows.map(r => r._id);
  }

  const total = adIds.length;
  console.error(
    `retitleDriver: ${total} ad(s)` +
    (opts.ids ? ' (--ids)' : ` formats=[${opts.formats.join(',')}] skip=${opts.skip} limit=${opts.limit == null ? 'none' : opts.limit}`) +
    (opts.preset ? ` preset=${opts.preset}` : '') +
    (opts.dryRun ? ' DRY-RUN' : '') +
    ` log=${opts.log}`
  );

  if (opts.dryRun) {
    for (let i = 0; i < total; i++) {
      const ad = await Ad.findById(adIds[i])
        .select('_id platformFormat brandId veoVideoUrl renderUrl status')
        .lean();
      const line = {
        i: i + 1,
        total,
        adId: String(adIds[i]),
        format: ad?.platformFormat || null,
        brandId: ad?.brandId ? String(ad.brandId) : null,
        ok: !!ad && !!ad.veoVideoUrl,
        ms: 0,
        dryRun: true,
        veoVideoUrl: ad?.veoVideoUrl || null,
        renderUrl: ad?.renderUrl || null,
        status: ad?.status || null,
        error: !ad ? 'ad not found' : (!ad.veoVideoUrl ? 'no veoVideoUrl' : undefined),
      };
      appendLine(opts.log, line);
    }
    const summary = { done: true, ok: total, failed: 0, totalMs: 0, dryRun: true };
    appendLine(opts.log, summary);
    await mongoose.disconnect().catch(() => {});
    process.exit(0);
  }

  let ok = 0;
  let failed = 0;
  const t0 = Date.now();
  let processed = 0;

  for (let i = 0; i < total; i++) {
    if (stopRequested) break;

    const adId = adIds[i];
    const i1 = i + 1;
    const tAd = Date.now();
    inFlight = true;

    try {
      const ad = await Ad.findById(adId);
      if (!ad) {
        failed++;
        appendLine(opts.log, {
          i: i1, total, adId: String(adId), format: null, brandId: null,
          ok: false, ms: Date.now() - tAd, error: 'ad not found',
        });
        processed++;
        continue;
      }

      if (!ad.veoVideoUrl) {
        failed++;
        appendLine(opts.log, {
          i: i1, total, adId: String(ad._id), format: ad.platformFormat || null,
          brandId: ad.brandId ? String(ad.brandId) : null,
          ok: false, ms: Date.now() - tAd, error: 'no veoVideoUrl',
        });
        processed++;
        continue;
      }

      const brand = ad.brandId ? await Brand.findById(ad.brandId) : null;
      if (!brand) {
        // Brand may be null → log skip (not a hard failure of the render path,
        // but we cannot title without brand tokens/spec; count as failed).
        failed++;
        appendLine(opts.log, {
          i: i1, total, adId: String(ad._id), format: ad.platformFormat || null,
          brandId: ad.brandId ? String(ad.brandId) : null,
          ok: false, ms: Date.now() - tAd, error: 'brand not found — skip',
        });
        processed++;
        continue;
      }

      const result = await renderBrandScriptAndSave({
        ad,
        brand,
        presetOverride: opts.preset || null,
      });
      const ms = Date.now() - tAd;

      if (result?.skipped) {
        // no-chrome: not a failure; still "ok" for the sweep (raw master ships)
        ok++;
        appendLine(opts.log, {
          i: i1, total, adId: String(ad._id), format: ad.platformFormat || null,
          brandId: String(brand._id),
          ok: true, ms, renderUrl: ad.renderUrl || null, skipped: true,
          reason: result.reason || 'no-chrome',
          preset: opts.preset || null,
        });
      } else {
        ok++;
        appendLine(opts.log, {
          i: i1, total, adId: String(ad._id), format: ad.platformFormat || null,
          brandId: String(brand._id),
          ok: true, ms, renderUrl: result?.renderUrl || null,
          preset: opts.preset || null,
        });
      }
      processed++;
    } catch (err) {
      failed++;
      processed++;
      appendLine(opts.log, {
        i: i1, total, adId: String(adId), format: null, brandId: null,
        ok: false, ms: Date.now() - tAd,
        error: (err && err.message) ? err.message : String(err),
      });
    } finally {
      inFlight = false;
    }
  }

  const summary = {
    done: true,
    ok,
    failed,
    totalMs: Date.now() - t0,
    processed,
    total,
    stoppedEarly: stopRequested && processed < total,
  };
  appendLine(opts.log, summary);

  shuttingDown = true;
  await mongoose.disconnect().catch(() => {});
  process.exit(0);
}

main().catch(async (err) => {
  console.error('retitleDriver fatal:', err);
  try {
    appendLine(opts.log, {
      done: true,
      ok: 0,
      failed: 0,
      totalMs: 0,
      error: err.message || String(err),
    });
  } catch { /* log may not be writable */ }
  try { await mongoose.disconnect(); } catch { /* */ }
  // Still exit 0 per contract? Spec says end with process.exit(0) after
  // summary. Fatal before the loop still writes a done line; exit 0 so
  // SSH wrappers don't confuse signal cleanup with a partial batch.
  process.exit(0);
});
