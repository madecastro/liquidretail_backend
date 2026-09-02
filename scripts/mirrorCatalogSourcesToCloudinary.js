#!/usr/bin/env node
// One-off repair sweep: mirror catalog-product Media whose fileUrl is
// still on a non-Cloudinary source (e.g. cdn.shopify.com) into
// Cloudinary, persist the mirror on Media.fileUrl, and invalidate
// their cached reframes so the next run recomputes against the
// Cloudinary URL.
//
// Why this exists: catalogProductDetectService's materialize path
// falls back to the source URL when the initial Cloudinary upload
// fails (rate limits, transient network). The probeImageDims fix in
// df6cbdb lets those rows record real dims, but they carry a
// non-Cloudinary fileUrl. Downstream, reframeStrategyChooser's
// c_crop URL insertion refuses non-Cloudinary hosts (correct fail-
// closed) and the reframe worker falls through to raw-source
// nano-banana outpaint — the fabrication class the composite-mask
// work (da22486) exists to reduce.
//
// The reframe worker now also mirrors lazily via ensureCloudinaryMirror
// (see atlasVideoService.js 5a-mirror step), so future Media that hit
// the same rate-limit fallback self-heal on their first reframe.
// This script is the one-off sweep to unblock the existing corpus
// today, without waiting for every Media to be reframed organically.
//
// Idempotent: Media already on Cloudinary /image/upload/ are skipped
// with no I/O. Re-running is safe.
//
// Race with an in-flight reframe worker: the worker holds a claim on
// Media.metadata.reframes.<aspectKey>.claim — this sweep writes
// Media.fileUrl and $unsets metadata.reframes as a whole. If a
// worker completes AFTER our unset it wins (stale outpaint URL under
// the new fileUrl); a re-run of the sweep picks stragglers. In
// practice no reframe workers are running against the swept brand
// while this executes.
//
// Usage:
//   node scripts/mirrorCatalogSourcesToCloudinary.js --brand="Pelagic Gear 4 Demos"
//   node scripts/mirrorCatalogSourcesToCloudinary.js --brand="…" --dry-run
//   node scripts/mirrorCatalogSourcesToCloudinary.js --brand="…" --limit=50 --concurrency=6

'use strict';
require('dotenv').config({ quiet: true });
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'config', 'defaults.env'), quiet: true });

const mongoose = require('mongoose');
const Brand = require('../models/Brand');
const Media = require('../models/Media');
const { ensureCloudinaryMirror } = require('../services/atlasVideoService');

function parseArgs() {
  const out = { brand: null, dryRun: false, limit: null, concurrency: 4 };
  for (const a of process.argv.slice(2)) {
    if (a === '--dry-run') out.dryRun = true;
    else if (a.startsWith('--brand=')) out.brand = a.slice('--brand='.length);
    else if (a.startsWith('--limit=')) out.limit = parseInt(a.slice('--limit='.length), 10) || null;
    else if (a.startsWith('--concurrency=')) out.concurrency = Math.max(1, Math.min(16, parseInt(a.slice('--concurrency='.length), 10) || 4));
  }
  if (!out.brand) {
    console.error('usage: --brand="<name>" [--dry-run] [--limit=N] [--concurrency=1-16]');
    process.exit(1);
  }
  return out;
}

function fmtHost(url) {
  try { return new URL(url).host; } catch { return '?'; }
}

async function main() {
  const args = parseArgs();
  await mongoose.connect(process.env.MONGODB_URI);
  try {
    const brand = await Brand.findOne({ name: args.brand }).lean();
    if (!brand) throw new Error(`brand not found: ${args.brand}`);
    console.log(`Brand: ${brand.name} (${brand._id})`);

    // Pre-filter in the DB so the sweep doesn't stream every catalog
    // Media through node — the /image/upload/ substring check is not
    // indexable, but the source-scope + brand narrows it to a single
    // brand's ~1k rows at most.
    const catalogCount = await Media.countDocuments({
      brandId: brand._id, source: 'catalog-product', deletedAt: null
    });
    const all = await Media.find({
      brandId: brand._id,
      source: 'catalog-product',
      deletedAt: null,
      fileUrl: { $exists: true, $ne: null }
    }).select('_id fileUrl metadata.reframes').lean();
    const affected = all.filter(m =>
      typeof m.fileUrl === 'string' && !m.fileUrl.includes('/image/upload/')
    );
    const target = args.limit ? affected.slice(0, args.limit) : affected;
    console.log(`  ${catalogCount} catalog-product Media`);
    console.log(`  ${affected.length} on non-Cloudinary source (${target.length} in this run)`);

    if (!target.length) {
      console.log('  Nothing to do.');
      return;
    }

    // Host distribution — quick sanity that we're targeting the
    // expected class.
    const hosts = {};
    for (const m of target) {
      const h = fmtHost(m.fileUrl);
      hosts[h] = (hosts[h] || 0) + 1;
    }
    console.log('  Source hosts:', Object.entries(hosts).sort((a,b)=>b[1]-a[1]).map(([h,n]) => `${h}×${n}`).join(', '));

    if (args.dryRun) {
      console.log('\n  (--dry-run — no mirrors uploaded, no writes)');
      for (const m of target.slice(0, 12)) {
        const reframeKeys = Object.keys(m.metadata?.reframes || {});
        console.log(`    ${m._id}  ${fmtHost(m.fileUrl)}  reframes=${reframeKeys.join(',') || '-'}`);
      }
      return;
    }

    let ok = 0, skip = 0, fail = 0;
    const startedAt = Date.now();
    // Batch with bounded concurrency so we don't hammer Cloudinary or
    // the source CDN. ensureCloudinaryMirror is already bounded per
    // request (12MB, 20s) — this bounds how many in flight at once.
    for (let i = 0; i < target.length; i += args.concurrency) {
      const batch = target.slice(i, i + args.concurrency);
      await Promise.all(batch.map(async (m) => {
        try {
          const mirror = await ensureCloudinaryMirror(m.fileUrl);
          if (!mirror) {
            console.warn(`  ✗ ${m._id}: mirror returned null (kept ${fmtHost(m.fileUrl)})`);
            fail++;
            return;
          }
          if (mirror === m.fileUrl) {
            // Fast path returned unchanged — was already Cloudinary
            // despite our filter. Shouldn't happen but count separately
            // rather than as a mirror.
            skip++;
            return;
          }
          // Update fileUrl and clear any cached reframes so the next
          // reframe request recomputes against the mirror. Unsetting
          // the WHOLE metadata.reframes tree is the simplest correct
          // move — every entry was computed against the old (Shopify)
          // sourceUrl and is therefore suspect. A no-op aspect
          // (source aspect already matches target) recomputes and
          // returns the mirror URL directly, so nothing is lost.
          await Media.updateOne(
            { _id: m._id },
            { $set: { fileUrl: mirror }, $unset: { 'metadata.reframes': '' } }
          );
          ok++;
          if (ok % 25 === 0) {
            const rate = (ok / ((Date.now() - startedAt) / 1000)).toFixed(1);
            console.log(`  … ${ok}/${target.length} mirrored (${rate}/s)`);
          }
        } catch (err) {
          console.warn(`  ✗ ${m._id}: ${err.message}`);
          fail++;
        }
      }));
    }
    const wall = ((Date.now() - startedAt) / 1000).toFixed(0);
    console.log(`\nDone in ${wall}s.  mirrored=${ok}  skipped=${skip}  failed=${fail}  of ${target.length}`);
    if (fail) {
      console.log('  Re-run to retry failed rows (idempotent).');
      process.exitCode = 1;
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
