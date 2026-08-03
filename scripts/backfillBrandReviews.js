#!/usr/bin/env node
//
// backfillBrandReviews.js — ops driver: populate Brand.brandReviews for
// brands that have none, by DRIVING the existing enrichment pipeline.
//
// This script does NOT talk to Gemini/OpenAI/Brandfetch itself and does NOT
// reimplement any enrichment logic. It calls the one real entry point,
// services/brandEnrichmentService.js → enrichBrandFromUrl(brandId), and
// reports what came back. That function is a monolithic, per-brand pipeline
// (Brandfetch → homepage scrape/Tailwind → GPT-4.1 → Gemini brand-reviews →
// website fonts/logo) driven by which `enrichmentSources` are already
// attempted (brandEnrichmentService.js:111-123) — there is no narrower
// "just do brand reviews" entry point, so calling it MAY also trigger other
// pending, separately-billable tiers as a side effect (see the dry-run
// "other pending tiers" note below; this is intentional transparency, not
// this script deciding to run them).
//
// CURATION — brandEnrichmentService owns this, this script does not
// duplicate the write-side logic: brand.brandReviews is only overwritten
// when `wantBrandReviews && !isCurated('brandReviews')`
// (brandEnrichmentService.js:464, isCurated defined :305 as
// `Array.isArray(brand.curatedFields) && brand.curatedFields.includes(k)`).
// A brand with 'brandReviews' in curatedFields is therefore already
// protected by the service itself — this script's own isCurated() check
// below (mirroring that exact one-line predicate) is used only to WARN in
// the dry-run preview, never to alter what gets written.
//
// LEDGER / COST — verified by reading the actual call chain before writing
// this comment:
//   - Tier 3 (GPT-4.1 tagline/tone/etc, chatCompletion → atlasLlmService.js)
//     IS ledgered: every call goes through costTracker.trackLlmCall into the
//     CostLog collection (atlasLlmService.js:24-30, costTracker.js).
//   - Tier 4 (brand reviews — the tier this script cares about,
//     services/providers/geminiSearchProvider.js:lookupBrandReviews) is NOT
//     ledgered anywhere: it calls axios.post directly against the raw Gemini
//     generativelanguage endpoint with no costTracker/CostLog involvement.
//     This script does not add ledgering (that is a service-level change,
//     out of scope for a read-only-elsewhere driver) — flagging it here so
//     the gap is documented at the one place an operator will look before
//     running a paid sweep.
//
// DEFAULT IS DRY-RUN. Nothing is written and no billable call is made unless
// --apply is passed.
//
// Usage:
//   node scripts/backfillBrandReviews.js                          # dry run, all brands missing a rating
//   node scripts/backfillBrandReviews.js --brand "GymShark"       # dry run, one brand (name or _id)
//   node scripts/backfillBrandReviews.js --apply                  # LIVE — writes, costs money
//   node scripts/backfillBrandReviews.js --apply --brand <id>     # LIVE — one brand
//   node scripts/backfillBrandReviews.js --apply --only-missing=false --brand AllBirds
//                                                                  # force re-run even if it already has a rating
//   node scripts/backfillBrandReviews.js --apply --delay-ms=3000  # override the inter-brand pause
//   node scripts/backfillBrandReviews.js --apply --limit=5        # cap how many brands this invocation touches
//
// Must be run from the repo root (node scripts/backfillBrandReviews.js) —
// this file requires app modules via relative paths (../models/Brand etc),
// which only resolve correctly against this file's real location inside
// scripts/, not if it's copied elsewhere and MONGODB_URI is picked up from
// .env in the current working directory.

require('dotenv').config();
// Non-secret tuning/flags live here too (index.js loads it the same way);
// harmless if it doesn't add anything relevant to this script.
require('dotenv').config({ path: require('path').join(__dirname, '..', 'config', 'defaults.env') });

const mongoose = require('mongoose');

const Brand = require('../models/Brand');
const { enrichBrandFromUrl } = require('../services/brandEnrichmentService');
const { formatDisplayRating } = require('../services/ratingDisplay');

const DEFAULT_DELAY_MS = 2000;

// ── args ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {
    apply: false,
    brand: null,
    onlyMissing: true, // requirement default: skip brands that already have a rating
    delayMs: DEFAULT_DELAY_MS,
    limit: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') { out.apply = true; continue; }
    const eq = a.indexOf('=');
    let key, val;
    if (a.startsWith('--') && eq > 0) {
      key = a.slice(2, eq);
      val = a.slice(eq + 1);
    } else if (a.startsWith('--')) {
      key = a.slice(2);
      val = argv[i + 1];
      if (val === undefined || String(val).startsWith('--')) {
        console.error(`--${key} needs a value`);
        process.exit(1);
      }
      i++;
    } else {
      console.error(`Unexpected argument: ${a}`);
      process.exit(1);
    }

    if (key === 'brand') { out.brand = val; continue; }
    if (key === 'only-missing') {
      out.onlyMissing = !(val === 'false' || val === '0');
      continue;
    }
    if (key === 'delay-ms') {
      const n = parseInt(val, 10);
      if (!Number.isFinite(n) || n < 0) { console.error('--delay-ms must be a non-negative integer'); process.exit(1); }
      out.delayMs = n;
      continue;
    }
    if (key === 'limit') {
      const n = parseInt(val, 10);
      if (!Number.isFinite(n) || n < 1) { console.error('--limit must be a positive integer'); process.exit(1); }
      out.limit = n;
      continue;
    }
    console.error(`Unknown flag: --${key}`);
    process.exit(1);
  }
  return out;
}

const opts = parseArgs(process.argv.slice(2));

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// mongoose.isValidObjectId accepts ANY 12-byte string, not just 24-char hex
// (CLAUDE.md repo trap, confirmed: 'video-models' passes isValidObjectId).
// Match hex strictly so a 12-character brand name can never be mistaken for
// an _id and silently miss on a billable single-brand run.
function looksLikeObjectId(v) {
  return /^[0-9a-fA-F]{24}$/.test(String(v || '').trim());
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function findBrandByNameOrId(val) {
  const trimmed = String(val || '').trim();
  if (!trimmed) return null;

  if (looksLikeObjectId(trimmed)) {
    const byId = await Brand.findById(trimmed);
    if (byId) return byId;
  }

  const norm = Brand.normalizeBrandName(trimmed);
  const exact = await Brand.findOne({ nameNormalized: norm });
  if (exact) return exact;

  // Convenience fallback only if unambiguous — a billable driver must never
  // silently guess between two brands.
  const candidates = await Brand.find({ name: new RegExp(escapeRegex(trimmed), 'i') }).limit(5);
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    console.error(`Ambiguous --brand "${trimmed}" matches ${candidates.length} brands: ${candidates.map(b => b.name).join(', ')}`);
  }
  return null;
}

// Mirrors brandEnrichmentService.js:305 exactly (Array check + includes) —
// a one-line field-name lookup, not a reimplementation of enrichment. Used
// only to annotate the dry-run preview; the service enforces this itself.
function isCurated(brand, field) {
  return Array.isArray(brand.curatedFields) && brand.curatedFields.includes(field);
}

function hasDisplayableRating(brand) {
  const raw = brand.brandReviews && typeof brand.brandReviews.rating === 'number' ? brand.brandReviews.rating : null;
  return raw != null && Number.isFinite(raw);
}

// Preview-only mirror of runEnrichment's want* gating (brandEnrichmentService.js
// :112-119). Read-only booleans over fields already on the brand doc — no
// scraping, no LLM call, no network. Purely so a dry run can warn an operator
// that enrichBrandFromUrl may ALSO fire other billable tiers for a brand as a
// side effect of the single monolithic entry point. Never used to decide
// whether this script calls the service — every brand in scope gets called.
function pendingTiers(brand) {
  const attempted = new Set(brand.enrichmentSources || []);
  const pending = [];
  if (process.env.BRANDFETCH_API_KEY && !attempted.has('brandfetch')) pending.push('brandfetch');
  if (!attempted.has('tailwind')) pending.push('tailwind');
  if (!attempted.has('scraped')) pending.push('scraped (homepage fetch)');
  if (process.env.OPENAI_API_KEY && !attempted.has('gpt')) pending.push('gpt (billable)');
  if (process.env.GEMINI_API_KEY && !attempted.has('brand-reviews') && !isCurated(brand, 'brandReviews')) pending.push('brand-reviews (billable — the tier this run wants)');
  const logoIsCurated = Array.isArray(brand.curatedFields) && brand.curatedFields.includes('logoUrl');
  if (!logoIsCurated && !brand.logoIngestedAt) pending.push('website-logo');
  if (!brand.fontIngestedAt) pending.push('website-fonts');
  return pending;
}

function reviewSummary(brand) {
  const br = brand.brandReviews || null;
  const rating = br && typeof br.rating === 'number' ? br.rating : null;
  const reviewCount = br && typeof br.reviewCount === 'number' ? br.reviewCount : null;
  const quoteCount = br && Array.isArray(br.quotes) ? br.quotes.length : 0;
  // Reuse the one real display rule rather than re-deriving ">4.5" here —
  // see services/ratingDisplay.js for why the gate must test the rounded
  // value, not the raw one.
  const displayRating = formatDisplayRating(rating);
  return { rating, reviewCount, quoteCount, clears: !!displayRating, displayRating: displayRating || null };
}

function formatRow(prefix, brand) {
  const { rating, reviewCount, quoteCount, clears, displayRating } = reviewSummary(brand);
  const ratingStr = rating != null ? rating.toFixed(2) : '∅';
  const countStr = reviewCount != null ? String(reviewCount) : '∅';
  const clearsStr = clears ? `YES (${displayRating}★ > 4.5)` : 'no';
  return `${prefix}"${brand.name}" (${brand._id}) — rating=${ratingStr} reviewCount=${countStr} quotes=${quoteCount} clears>4.5=${clearsStr}`;
}

// ── main ─────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is required');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('🔌 connected to', mongoose.connection.host);

  console.log('─'.repeat(70));
  console.log('mode:', opts.apply ? 'APPLY (live — billable calls WILL be made)' : 'DRY RUN (no writes, no billable calls)');
  console.log('only-missing:', opts.onlyMissing);
  if (opts.brand) console.log('brand filter:', opts.brand);
  if (opts.limit != null) console.log('limit:', opts.limit);
  console.log('delay between brands:', `${opts.delayMs}ms`);
  if (!process.env.GEMINI_API_KEY) {
    console.warn('⚠️  GEMINI_API_KEY is not set in this environment — the brand-reviews tier');
    console.warn('   (services/providers/geminiSearchProvider.js) will be skipped for every');
    console.warn('   brand, so this run will likely be a no-op unless other enrichment tiers');
    console.warn('   are also pending for the selected brands.');
  }
  console.log('─'.repeat(70));

  // ── resolve candidate set ──
  let candidates;
  if (opts.brand) {
    const b = await findBrandByNameOrId(opts.brand);
    if (!b) {
      console.error(`❌ no brand found matching --brand "${opts.brand}"`);
      await mongoose.disconnect();
      process.exit(1);
    }
    candidates = [b];
  } else {
    candidates = await Brand.find({}).sort({ name: 1 });
  }

  if (opts.onlyMissing) {
    const before = candidates.length;
    candidates = candidates.filter((b) => !hasDisplayableRating(b));
    console.log(`only-missing filter: ${before} → ${candidates.length} brand(s) (skipped brands that already have a rating)`);
  }

  if (opts.limit != null && candidates.length > opts.limit) {
    console.log(`--limit=${opts.limit}: truncating ${candidates.length} candidate(s) to ${opts.limit}`);
    candidates = candidates.slice(0, opts.limit);
  }

  const total = candidates.length;
  console.log(`\n${total} brand(s) in scope for this run.\n`);

  if (total === 0) {
    console.log('Nothing to do.');
    await mongoose.disconnect();
    process.exit(0);
  }

  // ── DRY RUN: print exactly which brands WOULD be enriched, cost nothing ──
  if (!opts.apply) {
    for (let i = 0; i < total; i++) {
      const b = candidates[i];
      const curated = isCurated(b, 'brandReviews');
      const pending = pendingTiers(b);
      let line = formatRow(`  [${i + 1}/${total}] `, b);
      if (curated) {
        line += `  — CURATED: brandReviews is protected, enrichBrandFromUrl will NOT write it for this brand`;
      } else if (!pending.includes('brand-reviews (billable — the tier this run wants)')) {
        line += `  — brand-reviews tier already attempted (in enrichmentSources) or GEMINI_API_KEY missing; will not retry unless enrichmentSources/websiteUrl changes`;
      }
      console.log(line);
      if (pending.length) console.log(`      would also attempt: ${pending.join(', ')}`);
    }
    console.log('\nDRY RUN — no writes made, no billable calls made. Re-run with --apply to execute.');
    await mongoose.disconnect();
    process.exit(0);
  }

  // ── APPLY: SERIAL, one billable call at a time ──
  let succeeded = 0;
  let skipped = 0;
  let errored = 0;
  const t0 = Date.now();

  for (let i = 0; i < total; i++) {
    const b = candidates[i];
    const i1 = i + 1;
    console.log(`\n[${i1}/${total}] enriching "${b.name}" (${b._id})…`);

    try {
      const result = await enrichBrandFromUrl(b._id);

      // Always re-read from the DB rather than trust result.brand for the
      // print-out: several ok:false paths inside runEnrichment return BEFORE
      // brand.save() while having already mutated fields like logoIngestedAt
      // in memory (brandEnrichmentService.js ~182-204 vs the save at ~499),
      // so an in-memory doc on an early-return path can look enriched
      // without anything actually being persisted. A fresh read reports only
      // what's really in Mongo.
      const fresh = await Brand.findById(b._id).select('name brandReviews').lean();

      if (result && result.ok) {
        succeeded++;
        console.log(`  ok: ${result.reason || 'enriched'}`);
      } else {
        skipped++;
        console.log(`  skip: ${result && result.reason ? result.reason : 'no reason given'}`);
      }
      console.log('  ' + formatRow('', fresh || b));
    } catch (err) {
      errored++;
      console.error(`  ❌ failed: ${err && err.message ? err.message : String(err)}`);
    }

    console.log(`  processed ${i1}/${total} (ok=${succeeded} skip=${skipped} error=${errored})`);

    // SERIAL by construction (no Promise.all) — these are billable
    // LLM/grounded-search calls. Skip the pause after the very last brand.
    if (i1 < total && opts.delayMs > 0) {
      await sleep(opts.delayMs);
    }
  }

  console.log('\n' + '─'.repeat(70));
  console.log(`done: ${total} brand(s) processed in ${Date.now() - t0}ms — ok=${succeeded} skip=${skipped} error=${errored}`);

  await mongoose.disconnect();
  console.log('🔌 disconnected');

  // Never abort mid-run on a per-brand failure (handled above); only signal
  // a hard failure to the caller (cron/shell) if EVERY brand's call threw —
  // a legitimate per-brand skip (curated, nothing to add, no websiteUrl) is
  // not a failure and must not flip the exit code.
  process.exit(errored === total ? 1 : 0);
}

main().catch(async (err) => {
  console.error('❌ backfillBrandReviews fatal:', err);
  try { await mongoose.disconnect(); } catch { /* already down */ }
  process.exit(1);
});
