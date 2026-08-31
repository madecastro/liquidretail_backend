#!/usr/bin/env node
'use strict';
/**
 * backfillBrandFonts — audit and backfill brand typography coverage.
 *
 * ANSWERS THE QUESTION "does every brand have properly extracted fonts?"
 * Note that "fontIngestedAt is set" does NOT answer it: that stamp records an
 * ATTEMPT, and it is written even when the scan found nothing reusable. So the
 * report's verdict per brand is the resolver's OWN answer — it calls
 * resolveBrandFonts and reports what each role actually resolves to and via
 * which source. A role landing on `library-match` or `default` is an
 * approximation, not the brand's typeface, however green the stamps look.
 *
 * REPORT MODE IS THE DEFAULT and touches nothing. --apply writes.
 *
 * Must be run from the repo root (node scripts/backfillBrandFonts.js) — it
 * requires app modules via relative paths.
 *
 *   node scripts/backfillBrandFonts.js                  # coverage report
 *   node scripts/backfillBrandFonts.js --matrix         # include healthy brands
 *   node scripts/backfillBrandFonts.js --brand Allbirds
 *   node scripts/backfillBrandFonts.js --apply          # free website re-ingest
 *   node scripts/backfillBrandFonts.js --apply --skip-meta
 *
 * COST. Report mode is free but NOT offline: resolveBrandFonts fetches Google
 * Fonts on a cache miss (no API key, no billing). --apply re-runs the website
 * font scan, which is also free (HTTP only) — it deliberately calls
 * ingestBrandFonts DIRECTLY rather than enrichBrandFromUrl, because that entry
 * point would also fire the billable LLM and grounded-search tiers.
 * The meta-ads step is the only billable part and is summarised, with an
 * estimate, before it runs.
 */

require('dotenv').config();
require('dotenv').config({ path: require('path').join(__dirname, '..', 'config', 'defaults.env') });

const mongoose = require('mongoose');
const Brand = require('../models/Brand');
const { ingestBrandFonts } = require('../services/brandFontIngestService');
const {
  applyFontIngestResult, applyMetaFontsResult,
} = require('../services/brandFontPersistenceService');
const { resolveBrandFonts } = require('../services/fontResolverService');

// Optional: the service may be absent on a checkout that predates it. Report
// mode must still work in that case.
let identifyBrandAdFonts = null;
let metaAdsFontsEnabled = () => false;
try {
  const m = require('../services/metaAdsFontService');
  identifyBrandAdFonts = m.identifyBrandAdFonts;
  metaAdsFontsEnabled = m.metaAdsFontsEnabled;
} catch { /* report mode only */ }

const DEFAULT_DELAY_MS = 2000;
const ROLES = ['heading', 'body', 'quote'];
// Rough, for the pre-apply estimate only. One gemini-2.5-pro call plus the
// $0.005/image vision surcharge.
const META_COST_PER_BRAND_USD = 0.03;
const APIFY_COST_PER_BRAND_USD = Number(process.env.APIFY_ADLIB_COST_USD || 0.25);

function parseArgs(argv) {
  const out = {
    apply: false, brand: null, limit: null, delayMs: DEFAULT_DELAY_MS,
    matrix: false, skipMeta: false, forceReingest: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') { out.apply = true; continue; }
    if (a === '--matrix') { out.matrix = true; continue; }
    if (a === '--skip-meta') { out.skipMeta = true; continue; }
    if (a === '--force-reingest') { out.forceReingest = true; continue; }
    const eq = a.indexOf('=');
    let key, val;
    if (a.startsWith('--') && eq > 0) { key = a.slice(2, eq); val = a.slice(eq + 1); }
    else if (a.startsWith('--')) {
      key = a.slice(2); val = argv[i + 1];
      if (val === undefined || String(val).startsWith('--')) {
        console.error(`--${key} needs a value`); process.exit(1);
      }
      i++;
    } else { console.error(`Unexpected argument: ${a}`); process.exit(1); }

    if (key === 'brand') { out.brand = val; continue; }
    if (key === 'delay-ms') {
      const n = parseInt(val, 10);
      if (!Number.isFinite(n) || n < 0) { console.error('--delay-ms must be >= 0'); process.exit(1); }
      out.delayMs = n; continue;
    }
    if (key === 'limit') {
      const n = parseInt(val, 10);
      if (!Number.isFinite(n) || n < 1) { console.error('--limit must be >= 1'); process.exit(1); }
      out.limit = n; continue;
    }
    console.error(`Unknown flag: --${key}`); process.exit(1);
  }
  return out;
}
const opts = parseArgs(process.argv.slice(2));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// mongoose.isValidObjectId accepts ANY 12-byte string (repo trap: 'video-models'
// passes). Match hex strictly so a 12-character brand name cannot be mistaken
// for an _id on a single-brand run.
const looksLikeObjectId = (v) => /^[0-9a-fA-F]{24}$/.test(String(v || '').trim());
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function findBrandByNameOrId(val) {
  const trimmed = String(val || '').trim();
  if (!trimmed) return null;
  if (looksLikeObjectId(trimmed)) {
    const byId = await Brand.findById(trimmed);
    if (byId) return byId;
  }
  const exact = await Brand.findOne({ nameNormalized: trimmed.toLowerCase() });
  if (exact) return exact;
  const rx = new RegExp(`^${escapeRegex(trimmed)}$`, 'i');
  const candidates = await Brand.find({ name: rx });
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    console.error(`"${trimmed}" is ambiguous — matches ${candidates.length} brands. Use an _id.`);
    return null;
  }
  return null;
}

// The resolver's own usability predicate (fontResolverService.matchCustomFont):
// a face with no mirrored file, or an explicit licence hold, cannot render.
function assumeLicensed() {
  return String(process.env.BRAND_FONT_ASSUME_LICENSED ?? 'true').toLowerCase() !== 'false';
}
function usableFaces(brand) {
  const licensed = assumeLicensed();
  return (brand.customFonts || []).filter((f) =>
    f?.url && f?.needsLicense !== true && (f?.license !== 'commercial' || licensed)
  );
}

async function inspect(brand) {
  const usable = usableFaces(brand);
  const total = (brand.customFonts || []).length;
  const row = {
    name: brand.name || String(brand._id),
    id: String(brand._id),
    websiteUrl: brand.websiteUrl || null,
    fontIngestedAt: brand.fontIngestedAt || null,
    fontIngestError: brand.fontIngestError || null,
    usableCount: usable.length,
    totalFaces: total,
    heldCount: total - usable.length,
    websiteUsage: brand.websiteFontUsage
      ? [brand.websiteFontUsage.heading, brand.websiteFontUsage.body].filter(Boolean).length
      : 0,
    fontFamily: brand.fontFamily || null,
    fontSource: brand.fontSource || null,
    metaFontsIngestedAt: brand.metaFontsIngestedAt || null,
    metaHeading: brand.metaAdsFontUsage?.heading || null,
    resolved: null,
    resolveError: null,
  };

  try {
    const fonts = await resolveBrandFonts(brand);
    row.resolved = {};
    for (const r of ROLES) {
      const f = fonts[r] || {};
      row.resolved[r] = {
        family: f.family || null,
        source: f.source || null,
        exact: f.exact === true,
      };
    }
  } catch (err) {
    row.resolveError = err.message;
  }

  // Verdict. Deliberately driven by RESOLUTION, not by the stamps.
  if (row.resolveError) row.verdict = 'ERROR';
  else if (!row.resolved) row.verdict = 'ERROR';
  else {
    const approx = ROLES.filter((r) => !row.resolved[r].exact);
    if (approx.length === 0) row.verdict = 'OK';
    else if (!row.fontIngestedAt) row.verdict = 'MISSING';
    else if (approx.length === ROLES.length) row.verdict = 'APPROX-ALL';
    else row.verdict = 'APPROX';
    row.approxRoles = approx;
  }
  return row;
}

function printRow(row) {
  const stamp = row.fontIngestedAt
    ? new Date(row.fontIngestedAt).toISOString().slice(0, 10)
    : 'never';
  console.log(`\n  ${row.verdict.padEnd(10)} ${row.name}  [${row.id}]`);
  console.log(
    `    website scan : ${stamp}` +
    `  faces=${row.usableCount} usable / ${row.totalFaces} total` +
    (row.heldCount ? ` (${row.heldCount} held/unusable)` : '') +
    `  cssRoles=${row.websiteUsage}` +
    (row.websiteUrl ? '' : '  ⚠️  NO websiteUrl')
  );
  if (row.fontIngestError) console.log(`    scan error   : ${String(row.fontIngestError).slice(0, 160)}`);
  console.log(`    fontFamily   : ${row.fontFamily || '—'} (${row.fontSource || 'no source'})`);
  const metaStamp = row.metaFontsIngestedAt
    ? new Date(row.metaFontsIngestedAt).toISOString().slice(0, 10)
    : 'never';
  console.log(
    `    meta-ads     : ${metaStamp}` +
    (row.metaHeading ? `  heading=${row.metaHeading.family} (${row.metaHeading.confidence})` : '  no identification')
  );
  if (row.resolveError) {
    console.log(`    RESOLVE FAILED: ${row.resolveError}`);
    return;
  }
  for (const r of ROLES) {
    const g = row.resolved[r];
    const mark = g.exact ? '✓' : '⚠️ ';
    console.log(`    ${mark} ${r.padEnd(8)}→ ${String(g.family).padEnd(20)} via ${g.source}`);
  }
}

async function runReport(rows) {
  const counts = rows.reduce((m, r) => m.set(r.verdict, (m.get(r.verdict) || 0) + 1), new Map());
  const shown = opts.matrix ? rows : rows.filter((r) => r.verdict !== 'OK');
  for (const row of shown) printRow(row);
  if (!opts.matrix && shown.length < rows.length) {
    console.log(`\n  (${rows.length - shown.length} brand(s) fully exact — pass --matrix to list them)`);
  }

  console.log(`\n${'─'.repeat(70)}`);
  console.log('  COVERAGE');
  for (const v of ['OK', 'APPROX', 'APPROX-ALL', 'MISSING', 'ERROR']) {
    if (counts.get(v)) console.log(`    ${v.padEnd(11)} ${counts.get(v)}`);
  }

  // Candidates for --apply, and what it would cost.
  const needScan = rows.filter((r) =>
    r.websiteUrl && (!r.fontIngestedAt || r.fontIngestError || r.usableCount === 0)
  );
  const noSite = rows.filter((r) => !r.websiteUrl);
  const needMeta = rows.filter((r) =>
    r.verdict !== 'OK' && !r.metaFontsIngestedAt && r.usableCount === 0
  );
  console.log('\n  --apply WOULD DO');
  console.log(`    website re-scan (free)     : ${needScan.length} brand(s)`);
  if (needScan.length) console.log(`      ${needScan.map((r) => r.name).join(', ')}`);
  console.log(`    meta-ads identify (BILLABLE): ${needMeta.length} brand(s)`);
  if (needMeta.length) console.log(`      ${needMeta.map((r) => r.name).join(', ')}`);
  if (noSite.length) {
    console.log(`    skipped, no websiteUrl     : ${noSite.length} (${noSite.map((r) => r.name).join(', ')})`);
  }
  const visionUsd = needMeta.length * META_COST_PER_BRAND_USD;
  const apifyUsd = process.env.APIFY_ADLIB_ACTOR ? needMeta.length * APIFY_COST_PER_BRAND_USD : 0;
  console.log(
    `    estimated cost             : $${(visionUsd + apifyUsd).toFixed(2)}` +
    ` (vision $${visionUsd.toFixed(2)}` +
    (process.env.APIFY_ADLIB_ACTOR
      ? ` + Apify up to $${apifyUsd.toFixed(2)})`
      : `; Apify tier inert — APIFY_ADLIB_ACTOR blank)`)
  );
  console.log(`\n  Report only — nothing was written. Re-run with --apply to fix.`);
}

async function applyToBrand(brand, row) {
  const label = brand.name || String(brand._id);
  let didScan = false;

  const needScan = opts.forceReingest ||
    !brand.fontIngestedAt || brand.fontIngestError || usableFaces(brand).length === 0;
  if (needScan) {
    if (!brand.websiteUrl) {
      console.log(`    · website scan skipped — no websiteUrl`);
    } else {
      // ingestBrandFonts DIRECTLY, never enrichBrandFromUrl: that entry point
      // fires the billable LLM + grounded-search tiers as a side effect.
      const result = await ingestBrandFonts(brand, { trackProgress: false });
      applyFontIngestResult(brand, result);
      await brand.save();
      didScan = true;
      console.log(
        `    · website scan: ${result.ingested.length} ingested, ${result.flagged.length} flagged, ` +
        `heading=${result.usage?.heading || 'unknown'}`
      );
    }
  } else {
    console.log(`    · website scan skipped — ${usableFaces(brand).length} usable face(s) already`);
  }

  // Re-read before deciding on the billable step: the scan above may have just
  // supplied the face that makes it unnecessary.
  let fresh = await Brand.findById(brand._id);
  if (!fresh) return { didScan, didMeta: false, after: row };

  const stillNoFace = usableFaces(fresh).length === 0;
  const canMeta = !opts.skipMeta && identifyBrandAdFonts && metaAdsFontsEnabled();
  let didMeta = false;
  if (stillNoFace && !fresh.metaFontsIngestedAt && canMeta) {
    // metaResult stays visible to the catch below so it can tell a genuine
    // paid miss from a config-absence non-run before deciding whether this
    // exception may permanently disable retry — same fix as
    // brandEnrichmentService.js / routes/brand.js ingest-meta-fonts.
    let metaResult = null;
    try {
      const maxImages = Number(process.env.META_ADS_FONTS_MAX_IMAGES) || 4;
      metaResult = await identifyBrandAdFonts(fresh, { maxImages });
      applyMetaFontsResult(fresh, metaResult);
      await fresh.save();
      didMeta = true;
      console.log(
        `    · meta-ads: via=${metaResult.via} images=${metaResult.imagesUsed} ` +
        `heading=${metaResult.usage.heading?.family || 'none'}` +
        `${metaResult.usage.heading ? ` (${metaResult.usage.heading.confidence})` : ''}`
      );
    } catch (err) {
      const billableAttempted = !metaResult || metaResult.billableAttempted === true;
      if (billableAttempted) fresh.metaFontsIngestedAt = new Date();
      fresh.metaFontsIngestError = String(err.message || err).slice(0, 2000);
      await fresh.save().catch(() => {});
      console.log(`    · meta-ads FAILED: ${err.message}`);
    }
  } else if (stillNoFace && !canMeta) {
    console.log(`    · meta-ads skipped (${opts.skipMeta ? '--skip-meta' : 'disabled or unavailable'})`);
  }

  fresh = await Brand.findById(brand._id);
  const after = await inspect(fresh);
  console.log(`    ${row.verdict} → ${after.verdict}` +
    (after.resolved ? `  (${ROLES.map((r) => `${r}:${after.resolved[r].family}`).join(' ')})` : ''));
  return { didScan, didMeta, after, label };
}

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set — cannot run.');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`🔌 connected to ${mongoose.connection.host}`);
  console.log('─'.repeat(70));
  console.log(`  backfillBrandFonts — ${opts.apply ? 'APPLY' : 'REPORT (no writes)'}`);

  let brands;
  if (opts.brand) {
    const one = await findBrandByNameOrId(opts.brand);
    if (!one) { console.error(`brand not found: ${opts.brand}`); await mongoose.disconnect(); process.exit(1); }
    brands = [one];
  } else {
    brands = await Brand.find({}).sort({ name: 1 });
  }
  if (opts.limit) brands = brands.slice(0, opts.limit);
  console.log(`  ${brands.length} brand(s)\n`);

  // Inspection is serial: resolveBrandFonts hits Google Fonts on a cache miss
  // and the module memoises per family, so serial runs warm that cache for
  // every later brand instead of racing N downloads of the same face.
  const rows = [];
  for (const b of brands) rows.push(await inspect(b));

  if (!opts.apply) {
    await runReport(rows);
    await mongoose.disconnect();
    console.log('🔌 disconnected');
    return;
  }

  const byId = new Map(rows.map((r) => [r.id, r]));
  const candidates = brands.filter((b) => {
    const row = byId.get(String(b._id));
    if (opts.forceReingest) return true;
    return row.verdict !== 'OK';
  });
  console.log(`  ${candidates.length} brand(s) need work\n`);

  let ok = 0, skipped = 0, errored = 0, scans = 0, metas = 0;
  const t0 = Date.now();
  // SERIAL by construction (no Promise.all) — the meta-ads step is a billable
  // API call and the website scan hits third-party sites.
  for (let i = 0; i < candidates.length; i++) {
    const b = candidates[i];
    const row = byId.get(String(b._id));
    console.log(`  [${i + 1}/${candidates.length}] ${b.name || b._id}`);
    try {
      const r = await applyToBrand(b, row);
      if (r.didScan) scans++;
      if (r.didMeta) metas++;
      if (!r.didScan && !r.didMeta) skipped++; else ok++;
    } catch (err) {
      errored++;
      console.error(`    ✗ ${err.message}`);
    }
    if (i < candidates.length - 1 && opts.delayMs) await sleep(opts.delayMs);
  }

  console.log(`\n${'─'.repeat(70)}`);
  console.log(
    `done: ${candidates.length} brand(s) in ${Date.now() - t0}ms — ` +
    `worked=${ok} skip=${skipped} error=${errored} (scans=${scans}, meta=${metas})`
  );
  await mongoose.disconnect();
  console.log('🔌 disconnected');
  // Only a total failure is a failed run; a legitimate per-brand skip is not.
  if (errored && errored === candidates.length) process.exit(1);
}

main().catch(async (err) => {
  console.error(`fatal: ${err.message}`);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
