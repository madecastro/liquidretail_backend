// When a detect-identified CatalogProduct draft is promoted (draft
// flipped from true → false), retroactively link every existing
// ProductMatchArtifact in the brand whose identification.productName
// subset-matches the promoted title. Collapses any other
// detect-identified twin rows into the promoted one along the way.
//
// Why: the matching pipeline can't know about a SKU before it exists
// in the catalog. When the operator promotes a draft they discovered
// on one piece of media, every other media that already produced a
// matching identification should now point at the canonical row —
// not still float as unlinked artifacts or sit on phantom twins.
//
// Conservative by design — uses the same subset-overlap criterion
// the reparent script uses (score = 1.0 strict-subset, ≥3 shared
// content tokens). Won't collapse SKU-distinguishing variants
// ("Smokey" into "Original") because their variant tokens prevent
// the subset condition from holding.

const CatalogProduct       = require('../models/CatalogProduct');
const ProductMatchArtifact = require('../models/ProductMatchArtifact');
const Media                = require('../models/Media');
const Campaign             = require('../models/Campaign');
const Category             = require('../models/Category');
const Ad                   = require('../models/Ad');
const LayoutInputArtifact  = require('../models/LayoutInputArtifact');
const { normalizeTitle, titleSimilarity } = require('../utils/titleNormalize');

const MIN_SHARED_TOKENS = 3;
const SUBSET_SCORE      = 1.0;

// Public entry. Fire-and-forget safe — never throws.
async function onPromote(promoted) {
  if (!promoted || !promoted._id || !promoted.brandId) return { ok: false, reason: 'missing inputs' };
  if (promoted.draft === true) return { ok: false, reason: 'still draft — skip' };
  try {
    return await runRetroLink(promoted);
  } catch (err) {
    console.warn(`   ⚠️  catalogProductPromote.onPromote(${promoted._id}) failed: ${err.message}`);
    return { ok: false, reason: err.message };
  }
}

async function runRetroLink(promoted) {
  const promotedNormalized = promoted.normalizedTitle || normalizeTitle(promoted.title);
  if (!promotedNormalized) return { ok: false, reason: 'promoted has empty normalizedTitle' };

  // 1. Reparent twin detect-identified rows for the same brand whose
  //    title is a subset match. Collapses them entirely so all their
  //    artifacts land on the promoted row, then deletes the phantom.
  const otherDetectIdentified = await CatalogProduct.find({
    brandId: promoted.brandId,
    source:  'detect-identified',
    _id:     { $ne: promoted._id }
  }).select('_id title normalizedTitle').lean();

  let twinsCollapsed = 0;
  let twinArtifactsMoved = 0;
  for (const twin of otherDetectIdentified) {
    const { score, shared } = titleSimilarity(twin.normalizedTitle || twin.title, promoted.title);
    if (shared < MIN_SHARED_TOKENS || score < SUBSET_SCORE) continue;
    const r = await reparentAllRefs(twin._id, promoted._id);
    await CatalogProduct.deleteOne({ _id: twin._id });
    twinsCollapsed++;
    twinArtifactsMoved += r.pma;
  }

  // 2. Link unlinked artifacts (catalogProductId=null) for the same
  //    brand whose identification.productName subset-matches the
  //    promoted title. Skips brand-match outcomes (those are
  //    intentionally null-FK by design).
  const unlinked = await ProductMatchArtifact.find({
    brandId:          promoted.brandId,
    catalogProductId: null,
    outcome:          { $in: ['product_match', 'product_category'] },
    'identification.productName': { $exists: true, $ne: null }
  }).select('_id identification mediaId').lean();

  const toLink = [];
  for (const a of unlinked) {
    const { score, shared } = titleSimilarity(a.identification.productName, promoted.title);
    if (shared >= MIN_SHARED_TOKENS && score >= SUBSET_SCORE) {
      toLink.push(a._id);
    }
  }
  if (toLink.length) {
    await ProductMatchArtifact.updateMany(
      { _id: { $in: toLink } },
      { $set: { catalogProductId: promoted._id } }
    );
  }

  // 3. Rebuild promoted.matchedMedia[] from the artifacts now pointing
  //    at it. Replaces any stale entries — artifacts are the source of
  //    truth.
  await rebuildMatchedMedia(promoted._id);

  console.log(
    `🔗 promote retro-link: brand=${promoted.brandId} promoted=${promoted._id} ` +
    `twinsCollapsed=${twinsCollapsed} (artifactsMoved=${twinArtifactsMoved}) ` +
    `unlinkedLinked=${toLink.length}`
  );

  return {
    ok: true,
    twinsCollapsed,
    twinArtifactsMoved,
    unlinkedLinked: toLink.length
  };
}

// Move every CatalogProduct ref from loserId to keeperId. Mirrors the
// reparent script's logic but kept here so the service is self-contained.
async function reparentAllRefs(loserId, keeperId) {
  const pmaResult = await ProductMatchArtifact.updateMany(
    { catalogProductId: loserId },
    { $set: { catalogProductId: keeperId } }
  );
  await Media.updateMany(
    { 'matchedProducts.catalogProductId': loserId },
    { $set: { 'matchedProducts.$[elem].catalogProductId': keeperId } },
    { arrayFilters: [{ 'elem.catalogProductId': loserId }] }
  );
  const campaigns = await Campaign.find({ matchedProductIds: loserId }).select('_id matchedProductIds').lean();
  await Campaign.updateMany({ matchedProductIds: loserId }, { $pull: { matchedProductIds: loserId } });
  for (const c of campaigns) {
    if (!c.matchedProductIds.some(id => String(id) === String(keeperId))) {
      await Campaign.updateOne({ _id: c._id }, { $addToSet: { matchedProductIds: keeperId } });
    }
  }
  const categories = await Category.find({ relatedProducts: loserId }).select('_id relatedProducts').lean();
  await Category.updateMany({ relatedProducts: loserId }, { $pull: { relatedProducts: loserId } });
  for (const c of categories) {
    if (!c.relatedProducts.some(id => String(id) === String(keeperId))) {
      await Category.updateOne({ _id: c._id }, { $addToSet: { relatedProducts: keeperId } });
    }
  }
  for (const Model of [Ad, LayoutInputArtifact]) {
    const docs = await Model.find({ productId: loserId });
    for (const d of docs) {
      try { d.productId = keeperId; await d.save(); }
      catch (err) { if (err.code === 11000) await Model.deleteOne({ _id: d._id }); else throw err; }
    }
  }
  return { pma: pmaResult.modifiedCount || 0 };
}

async function rebuildMatchedMedia(catalogProductId) {
  const artifacts = await ProductMatchArtifact
    .find({ catalogProductId })
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
    { _id: catalogProductId },
    { $set: { matchedMedia: entries } }
  );
}

module.exports = { onPromote };
