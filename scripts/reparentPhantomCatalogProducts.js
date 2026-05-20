// Reparent ProductMatchArtifact + related refs from phantom
// `detect-identified` CatalogProduct rows to their synced twins, then
// delete the phantoms.
//
// Why: ensureCatalogProductForMatch's previous exact-title-regex match
// missed real synced rows when titles differed by promo cruft / case /
// separator, so it created `detect-identified` duplicates and routed
// matches there instead of to the synced ig-catalog / manual-upload
// row. The catalog browser and campaign wizard both read by
// catalogProductId, so those matches became invisible.
//
// Strategy:
//   For each detect-identified CP with matches:
//     - Find the best synced twin via normalizedTitle exact OR fuzzy
//       (≥3 shared tokens AND ≥0.7 overlap). No twin → skip; row might
//       be a genuinely new product.
//     - Reparent every CatalogProduct ref from phantom → twin:
//         ProductMatchArtifact.catalogProductId         (simple set)
//         Media.matchedProducts[].catalogProductId      (positional set)
//         Campaign.matchedProductIds[]                  (pull + addToSet)
//         Category.relatedProducts[]                    (pull + addToSet)
//         Ad.productId                                  (per-doc, E11000 → delete)
//         LayoutInputArtifact.productId                 (per-doc, E11000 → delete)
//     - Rebuild twin.matchedMedia[] from the artifacts now pointing at it.
//     - Delete the phantom.
//
// Dry-run by default. Use --apply to write.
//
// Usage:
//   node scripts/reparentPhantomCatalogProducts.js --brand <id>
//   node scripts/reparentPhantomCatalogProducts.js --brand <id> --apply
//   node scripts/reparentPhantomCatalogProducts.js                # all brands
//   node scripts/reparentPhantomCatalogProducts.js --min-overlap 0.8 --min-shared 4

require('dotenv').config();
const mongoose = require('mongoose');

const CatalogProduct       = require('../models/CatalogProduct');
const ProductMatchArtifact = require('../models/ProductMatchArtifact');
const Media                = require('../models/Media');
const Campaign             = require('../models/Campaign');
const Category             = require('../models/Category');
const Ad                   = require('../models/Ad');
const LayoutInputArtifact  = require('../models/LayoutInputArtifact');
const { normalizeTitle, titleSimilarity } = require('../utils/titleNormalize');

const args = process.argv.slice(2);
const DRY = !args.includes('--apply');
const BRAND = pickArg('--brand');
// score = shared / min(|tokens(a)|, |tokens(b)|). At 1.0, one side is
// a strict subset of the other — neither has unique distinguishing
// tokens. Anything below 1.0 means both sides have a unique token,
// which for product SKUs almost always indicates a flavor / variant
// difference ("smokey" vs "original") and should NOT collapse.
const MIN_OVERLAP = parseFloat(pickArg('--min-overlap') || '1.0');
const MIN_SHARED  = parseInt(pickArg('--min-shared') || '3', 10);

function pickArg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

// Find the best synced twin for a given phantom row, restricted to the
// same brand. Returns { row, score, shared, reason } or null.
function findTwin(phantom, syncedRows) {
  const normP = phantom.normalizedTitle || normalizeTitle(phantom.title);
  if (!normP) return null;

  // 1. Exact normalized hit — highest confidence.
  const exact = syncedRows.find(r => (r.normalizedTitle || normalizeTitle(r.title)) === normP);
  if (exact) return { row: exact, score: 1.0, shared: normP.split(' ').length, reason: 'normalized-exact' };

  // 2. Subset overlap — score = 1.0 (default) means strict subset.
  // Tiebreak by shared-token count so the candidate that shares more
  // tokens (e.g. matches both brand + variant) wins over one that
  // matches only the brand prefix.
  let best = null;
  for (const r of syncedRows) {
    const { score, shared } = titleSimilarity(phantom.title, r.title);
    if (shared >= MIN_SHARED && score >= MIN_OVERLAP && (!best || shared > best.shared)) {
      best = { row: r, score, shared, reason: 'subset' };
    }
  }
  return best;
}

// Per-doc reparent with E11000 → delete fallback, used for collections
// with unique constraints involving productId.
async function reparentWithUniqueGuard(Model, loserId, keeperId, fieldName) {
  const docs = await Model.find({ [fieldName]: loserId });
  let saved = 0;
  let deleted = 0;
  for (const d of docs) {
    try {
      d[fieldName] = keeperId;
      await d.save();
      saved++;
    } catch (err) {
      if (err.code === 11000) {
        await Model.deleteOne({ _id: d._id });
        deleted++;
      } else {
        throw err;
      }
    }
  }
  return { saved, deleted };
}

async function reparentPhantom(phantom, twin) {
  // 1. ProductMatchArtifact — single FK, no unique constraint involving
  //    catalogProductId on its own; bulk set.
  const pmaResult = await ProductMatchArtifact.updateMany(
    { catalogProductId: phantom._id },
    { $set: { catalogProductId: twin._id } }
  );

  // 2. Media.matchedProducts[].catalogProductId — subdoc array.
  //    Positional $set is fine; duplicate subdocs are deduped at read time.
  const mediaResult = await Media.updateMany(
    { 'matchedProducts.catalogProductId': phantom._id },
    { $set: { 'matchedProducts.$[elem].catalogProductId': twin._id } },
    { arrayFilters: [{ 'elem.catalogProductId': phantom._id }] }
  );

  // 3. Campaign.matchedProductIds[] — pull then add (two-pass).
  const campaignsTouched = await Campaign.find({ matchedProductIds: phantom._id }).select('_id matchedProductIds').lean();
  await Campaign.updateMany(
    { matchedProductIds: phantom._id },
    { $pull: { matchedProductIds: phantom._id } }
  );
  for (const c of campaignsTouched) {
    const hasTwin = c.matchedProductIds.some(id => String(id) === String(twin._id));
    if (!hasTwin) {
      await Campaign.updateOne({ _id: c._id }, { $addToSet: { matchedProductIds: twin._id } });
    }
  }

  // 4. Category.relatedProducts[] — same pattern.
  const categoriesTouched = await Category.find({ relatedProducts: phantom._id }).select('_id relatedProducts').lean();
  await Category.updateMany(
    { relatedProducts: phantom._id },
    { $pull: { relatedProducts: phantom._id } }
  );
  for (const c of categoriesTouched) {
    const hasTwin = c.relatedProducts.some(id => String(id) === String(twin._id));
    if (!hasTwin) {
      await Category.updateOne({ _id: c._id }, { $addToSet: { relatedProducts: twin._id } });
    }
  }

  // 5. Ad.productId + LayoutInputArtifact.productId — per-doc, E11000 → delete loser.
  const adResult = await reparentWithUniqueGuard(Ad, phantom._id, twin._id, 'productId');
  const layoutResult = await reparentWithUniqueGuard(LayoutInputArtifact, phantom._id, twin._id, 'productId');

  // 6. Rebuild twin.matchedMedia[] from current ProductMatchArtifacts now
  //    pointing at it. This replaces any stale entries; the artifact
  //    collection is the source of truth.
  const artifacts = await ProductMatchArtifact
    .find({ catalogProductId: twin._id })
    .select('mediaId outcome catalogCombinedScore identification productIndex _id')
    .lean();
  const seen = new Set();
  const entries = [];
  for (const a of artifacts) {
    const key = String(a.mediaId) + ':' + String(a._id);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      mediaId:                 a.mediaId,
      matchTier:               a.outcome === 'product_match' ? 'product_match' : 'product_category',
      confidence:              a.catalogCombinedScore ?? a.identification?.certainty ?? 0,
      refinedProductId:        a.productIndex || null,
      matchEvidenceArtifactId: a._id,
      matchedAt:               new Date()
    });
  }
  await CatalogProduct.updateOne(
    { _id: twin._id },
    { $set: { matchedMedia: entries } }
  );

  // 7. Delete the phantom.
  await CatalogProduct.deleteOne({ _id: phantom._id });

  return {
    pma:      pmaResult.modifiedCount || 0,
    media:    mediaResult.modifiedCount || 0,
    campaigns: campaignsTouched.length,
    categories: categoriesTouched.length,
    ads:      adResult,
    layouts:  layoutResult,
    matchedMediaEntries: entries.length
  };
}

async function main() {
  const url = process.env.MONGO_URL || process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!url) { console.error('No MONGO URL in env.'); process.exit(1); }
  await mongoose.connect(url);
  console.log('─'.repeat(78));
  console.log('mode:', DRY ? 'DRY RUN (no writes)' : 'APPLY (destructive)');
  console.log(`thresholds: min-overlap=${MIN_OVERLAP}  min-shared=${MIN_SHARED}`);
  if (BRAND) console.log('brand filter:', BRAND);
  console.log('─'.repeat(78));

  const cpFilter = { source: 'detect-identified' };
  if (BRAND && mongoose.Types.ObjectId.isValid(BRAND)) {
    cpFilter.brandId = new mongoose.Types.ObjectId(BRAND);
  }

  // Pull all detect-identified rows in scope. Filter to ones with
  // matches in a follow-up step (a row with zero matches is harmless
  // to leave alone — and may be a legitimate genuinely-new product
  // awaiting review).
  const phantoms = await CatalogProduct.find(cpFilter)
    .select('_id brandId title normalizedTitle source draft createdAt')
    .lean();

  if (!phantoms.length) { console.log('\nNo detect-identified rows found.'); await mongoose.disconnect(); return; }

  // Group phantoms by brand so we only load each brand's synced rows once.
  const byBrand = new Map();
  for (const p of phantoms) {
    const k = String(p.brandId);
    if (!byBrand.has(k)) byBrand.set(k, []);
    byBrand.get(k).push(p);
  }

  let collapsedCount = 0;
  let skippedNoMatches = 0;
  let skippedNoTwin = 0;
  let totalArtifactsReparented = 0;

  for (const [brandId, brandPhantoms] of byBrand.entries()) {
    const synced = await CatalogProduct
      .find({ brandId: new mongoose.Types.ObjectId(brandId), source: { $ne: 'detect-identified' } })
      .select('_id title normalizedTitle source draft')
      .lean();

    console.log(`\nbrand=${brandId}  phantoms=${brandPhantoms.length}  synced=${synced.length}`);

    for (const phantom of brandPhantoms) {
      const matchCount = await ProductMatchArtifact.countDocuments({ catalogProductId: phantom._id });
      if (matchCount === 0) {
        skippedNoMatches++;
        continue;
      }

      const twin = findTwin(phantom, synced);
      if (!twin) {
        skippedNoTwin++;
        console.log(`   skip[no-twin]  ${phantom._id}  matches=${matchCount}  "${(phantom.title || '').slice(0, 50)}"`);
        continue;
      }

      console.log(`   COLLAPSE  ${phantom._id}  matches=${matchCount}  "${(phantom.title || '').slice(0, 50)}"`);
      console.log(`     → twin ${twin.row._id}  (${twin.reason}, score=${twin.score.toFixed(2)}, shared=${twin.shared})  "${(twin.row.title || '').slice(0, 50)}"`);

      if (!DRY) {
        const r = await reparentPhantom(phantom, twin.row);
        console.log(`     reparented: pma=${r.pma}, media=${r.media}, campaigns=${r.campaigns}, categories=${r.categories}, ads(saved=${r.ads.saved},del=${r.ads.deleted}), layouts(saved=${r.layouts.saved},del=${r.layouts.deleted}), matchedMedia=${r.matchedMediaEntries}`);
        totalArtifactsReparented += r.pma;
      } else {
        totalArtifactsReparented += matchCount;
      }
      collapsedCount++;
    }
  }

  console.log('\n' + '─'.repeat(78));
  console.log(`${DRY ? 'WOULD collapse' : 'collapsed'} ${collapsedCount} phantom row(s)`);
  console.log(`skipped: ${skippedNoMatches} (no matches) + ${skippedNoTwin} (no twin)`);
  console.log(`artifacts ${DRY ? 'would be' : ''} reparented: ${totalArtifactsReparented}`);
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
