// Dry-run of catalogRetroLinkService.runBrandWide for one brand.
// Mirrors the read-only parts of runImpl so we can preview what Pass A
// (unlinked artifact re-link) and Pass B (phantom twin collapse) would
// do WITHOUT persisting anything.
//
// Usage: node scripts/dryRunRetroLink.js "<Brand Name>"

'use strict';

require('dotenv').config();
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'config', 'defaults.env') });

const mongoose = require('mongoose');
const Brand = require('../models/Brand');
const CatalogProduct = require('../models/CatalogProduct');
const ProductMatchArtifact = require('../models/ProductMatchArtifact');
const Media = require('../models/Media');
const { normalizeTitle } = require('../utils/titleNormalize');

// Match-time knobs. The production service uses MIN_SHARED_TOKENS=3
// with the shared titleSimilarity helper; this dry-run adds a per-brand
// stopword layer so we can loosen the threshold to 2 WITHOUT introducing
// generic false positives ("Pelagic Gear" as noise, not signal).
const MIN_SHARED_TOKENS = Math.max(1, parseInt(process.env.DRY_MIN_SHARED_TOKENS, 10) || 2);
const SUBSET_SCORE = 1.0;

// Per-brand stopwords: brand names, category-generic terms, and
// abbreviations that appear in phantom marketing strings but carry no
// discriminating power ("PELAGIC Ws Trucker - <SKU>" style). Lowercased,
// applied AFTER normalizeTitle. If we widen this list to more brands
// later, promote to a per-brand collection.
const BRAND_STOP_TOKENS = new Set([
  'pelagic', 'gear',              // brand name
  'ws',                           // "Ws" prefix used by Pelagic for women's
  'trucker', 'hat', 'cap',        // generic accessory categories
  'shirt', 'hooded', 'performance', 'fishing', 'jacket',
  'top', 'bottom', 'visor',
  'low', 'profile',
  'ws', 'mens', 'womens', 'youth', 'kids',
  'style'
]);

// Base stopwords from titleNormalize.js (function-word filter). Keeping
// the same set here so we don't accidentally count "the/of/a" as shared.
const BASE_STOP = new Set([
  'the','a','an','and','or','of','for','with','to','in','on','by','at','from',
  'is','are','be','this','that','it','as','if','so','do','not','no'
]);

function tokensStopped(normalized) {
  return String(normalized || '')
    .split(' ')
    .filter((t) => t && t.length > 1 && !BASE_STOP.has(t) && !BRAND_STOP_TOKENS.has(t));
}

function titleSimilarityStopped(a, b) {
  const ta = new Set(tokensStopped(normalizeTitle(a)));
  const tb = new Set(tokensStopped(normalizeTitle(b)));
  if (!ta.size || !tb.size) return { score: 0, shared: 0, tokensA: [...ta], tokensB: [...tb] };
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  const score = shared / Math.min(ta.size, tb.size);
  return { score, shared, tokensA: [...ta], tokensB: [...tb] };
}

const brandName = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!brandName) { console.error('Usage: node scripts/dryRunRetroLink.js "<Brand Name>"'); process.exit(1); }

function findBestSyncedTwin(candidateName, syncedRows) {
  if (!candidateName) return null;
  let best = null;
  for (const r of syncedRows) {
    const { score, shared, tokensA, tokensB } = titleSimilarityStopped(r.normalizedTitle || r.title, candidateName);
    if (shared >= MIN_SHARED_TOKENS && score >= SUBSET_SCORE) {
      if (!best || shared > best.shared) best = { ...r, score, shared, tokensA, tokensB };
    }
  }
  return best;
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const brand = await Brand.findOne({ name: brandName });
  if (!brand) throw new Error(`Brand "${brandName}" not found`);
  const brandId = brand._id;
  console.log(`\nBrand: ${brand.name} (${brandId})`);
  console.log(`Config: MIN_SHARED_TOKENS=${MIN_SHARED_TOKENS}, extra stopwords=${[...BRAND_STOP_TOKENS].join(', ')}`);

  // Synced catalog pool (Pass A + B target set).
  const synced = await CatalogProduct
    .find({ brandId, source: { $ne: 'detect-identified' }, draft: { $ne: true } })
    .select('_id title normalizedTitle source')
    .lean();
  for (const r of synced) if (!r.normalizedTitle) r.normalizedTitle = normalizeTitle(r.title);
  console.log(`\n── Synced catalog target pool: ${synced.length} products ──`);
  if (!synced.length) { console.log('nothing to target — aborting.'); await mongoose.disconnect(); return; }

  // ── Pass A dry-run ──
  const unlinked = await ProductMatchArtifact
    .find({
      brandId,
      catalogProductId: null,
      outcome: { $in: ['product_match', 'product_category'] },
      'identification.productName': { $exists: true, $ne: null }
    })
    .select('_id identification mediaId')
    .lean();
  console.log(`\n── Pass A — unlinked artifacts scan ──`);
  console.log(`  unlinked artifacts (candidates):     ${unlinked.length}`);
  const aByTarget = new Map();  // target -> [{artifactId, name}, ...]
  let aWouldLink = 0;
  let aWouldSkip = 0;
  for (const a of unlinked) {
    const name = a.identification?.productName;
    const target = findBestSyncedTwin(name, synced);
    if (!target) { aWouldSkip++; continue; }
    const k = String(target._id);
    if (!aByTarget.has(k)) aByTarget.set(k, { target, entries: [] });
    aByTarget.get(k).entries.push({ artifactId: a._id, name, shared: target.shared });
    aWouldLink++;
  }
  console.log(`  would LINK:                          ${aWouldLink}  → onto ${aByTarget.size} distinct synced products`);
  console.log(`  would SKIP (no title match found):   ${aWouldSkip}`);
  if (aByTarget.size) {
    console.log(`  top targets:`);
    const sorted = [...aByTarget.values()].sort((a, b) => b.entries.length - a.entries.length).slice(0, 8);
    for (const t of sorted) {
      console.log(`    "${t.target.title}"  ← ${t.entries.length} artifact(s)`);
    }
  }

  // ── Pass B dry-run ──
  const phantoms = await CatalogProduct
    .find({ brandId, source: 'detect-identified' })
    .select('_id title normalizedTitle')
    .lean();
  console.log(`\n── Pass B — phantom detect-identified rows scan ──`);
  console.log(`  detect-identified phantoms:          ${phantoms.length}`);

  const bCollapses = [];
  const bNoTwin = [];
  for (const phantom of phantoms) {
    const twin = findBestSyncedTwin(phantom.normalizedTitle || phantom.title, synced);
    if (!twin) { bNoTwin.push(phantom); continue; }
    // Count PMA rows currently pointing at the phantom (so we can preview
    // "artifacts moved" without executing the reparent).
    const pmaCount = await ProductMatchArtifact.countDocuments({ catalogProductId: phantom._id });
    const mediaCount = await Media.countDocuments({ 'matchedProducts.catalogProductId': phantom._id });
    bCollapses.push({ phantom, twin, pmaCount, mediaCount });
  }
  console.log(`  would COLLAPSE (phantom → twin):     ${bCollapses.length}`);
  console.log(`  no-twin (phantom survives):          ${bNoTwin.length}`);
  const bTotalPma = bCollapses.reduce((n, c) => n + c.pmaCount, 0);
  const bTotalMedia = bCollapses.reduce((n, c) => n + c.mediaCount, 0);
  console.log(`  PMA rows that would move:            ${bTotalPma}`);
  console.log(`  Media rows w/ ref to be re-pointed:  ${bTotalMedia}`);
  if (bCollapses.length) {
    console.log(`  first 8 twin merges:`);
    for (const c of bCollapses.slice(0, 8)) {
      console.log(`    phantom "${c.phantom.title}"  →  synced "${c.twin.title}"  (PMA=${c.pmaCount}, Media=${c.mediaCount})`);
    }
  }
  if (bNoTwin.length) {
    console.log(`  first 8 phantoms with no twin (staying):`);
    for (const p of bNoTwin.slice(0, 8)) console.log(`    "${p.title}"`);
  }

  console.log(`\n── SUMMARY ──`);
  console.log(`  Pass A would link:      ${aWouldLink} PMAs to ${aByTarget.size} synced products`);
  console.log(`  Pass B would collapse:  ${bCollapses.length} phantoms into synced twins (${bTotalPma} PMAs + ${bTotalMedia} Media rows re-pointed)`);
  console.log(`  Pass B would keep:      ${bNoTwin.length} phantoms (no title match)`);
  console.log(`  → dry-run only, nothing persisted.`);

  await mongoose.disconnect();
})().catch((err) => { console.error(err); process.exit(1); });
