// Brand-wide retroactive link pass — called after a catalog sync
// drains so existing ProductMatchArtifacts that landed before the
// canonical synced rows existed (or against phantom detect-identified
// twins) get re-pointed at the right synced row.
//
// One pass over the brand's artifacts. Cheaper than per-row onPromote
// because the synced catalog is loaded once and reused for every
// artifact comparison.
//
// Idempotent. Safe to call after every sync.

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

async function runBrandWide({ brandId }) {
  if (!brandId) return { ok: false, reason: 'brandId required' };
  try {
    return await runImpl(brandId);
  } catch (err) {
    console.warn(`   ⚠️  catalogRetroLink.runBrandWide(${brandId}) failed: ${err.message}`);
    return { ok: false, reason: err.message };
  }
}

async function runImpl(brandId) {
  const startedAt = Date.now();

  // Pull all synced (non-detect-identified) non-draft rows once. These
  // are the candidate targets for any unlinked / phantom-linked
  // artifact in the brand.
  const synced = await CatalogProduct
    .find({ brandId, source: { $ne: 'detect-identified' }, draft: { $ne: true } })
    .select('_id title normalizedTitle source')
    .lean();

  if (!synced.length) {
    return { ok: true, reason: 'no synced rows to target', linked: 0, twinCollapses: 0 };
  }

  // Pre-normalize for fast comparison.
  for (const r of synced) {
    if (!r.normalizedTitle) r.normalizedTitle = normalizeTitle(r.title);
  }

  // ─── Pass A — unlinked artifacts (catalogProductId=null) ───
  // Match identification.productName subset against synced titles.
  const unlinked = await ProductMatchArtifact
    .find({
      brandId,
      catalogProductId: null,
      outcome:          { $in: ['product_match', 'product_category'] },
      'identification.productName': { $exists: true, $ne: null }
    })
    .select('_id identification')
    .lean();

  const aLinks = new Map(); // catalogProductId → [artifactId, ...]
  for (const a of unlinked) {
    const target = findBestSyncedTwin(a.identification?.productName, synced);
    if (!target) continue;
    const k = String(target._id);
    if (!aLinks.has(k)) aLinks.set(k, []);
    aLinks.get(k).push(a._id);
  }

  let linkedCount = 0;
  for (const [cpIdStr, artIds] of aLinks.entries()) {
    await ProductMatchArtifact.updateMany(
      { _id: { $in: artIds } },
      { $set: { catalogProductId: cpIdStr } }
    );
    linkedCount += artIds.length;
  }

  // ─── Pass B — collapse phantom detect-identified rows into synced twins ───
  const phantoms = await CatalogProduct
    .find({ brandId, source: 'detect-identified' })
    .select('_id title normalizedTitle')
    .lean();

  let twinCollapses = 0;
  let twinArtifactsMoved = 0;
  const touchedCpIds = new Set();   // synced rows that received artifacts — rebuild matchedMedia[] at end

  for (const phantom of phantoms) {
    const twin = findBestSyncedTwin(phantom.normalizedTitle || phantom.title, synced);
    if (!twin) continue;
    const r = await reparentAllRefs(phantom._id, twin._id);
    await CatalogProduct.deleteOne({ _id: phantom._id });
    twinCollapses++;
    twinArtifactsMoved += r.pma;
    touchedCpIds.add(String(twin._id));
  }

  // Also count any synced rows that just got freshly-linked artifacts in Pass A.
  for (const k of aLinks.keys()) touchedCpIds.add(k);

  // ─── Pass C — rebuild matchedMedia[] on every synced row that got touched. ───
  for (const cpId of touchedCpIds) {
    await rebuildMatchedMedia(cpId);
  }

  const took = Date.now() - startedAt;
  console.log(
    `🔗 catalogRetroLink brand=${brandId}: ` +
    `linked=${linkedCount}  twinCollapses=${twinCollapses} (artifacts=${twinArtifactsMoved})  ` +
    `rebuilt=${touchedCpIds.size}  took=${took}ms`
  );
  return {
    ok: true,
    linked: linkedCount,
    twinCollapses,
    twinArtifactsMoved,
    rebuilt: touchedCpIds.size,
    tookMs: took
  };
}

// Subset matcher: same criterion as ensureCatalogProductForMatch step
// 2b and the reparent script. Returns the synced row with the most
// shared tokens (tiebreak prefers brand+variant matches over brand-only).
function findBestSyncedTwin(candidateName, syncedRows) {
  if (!candidateName) return null;
  let best = null;
  for (const r of syncedRows) {
    const { score, shared } = titleSimilarity(r.normalizedTitle || r.title, candidateName);
    if (shared >= MIN_SHARED_TOKENS && score >= SUBSET_SCORE) {
      if (!best || shared > best.shared) best = { ...r, score, shared };
    }
  }
  return best;
}

// Move every CatalogProduct ref from loserId to keeperId. Mirrors the
// reparent script / promote service.
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

module.exports = { runBrandWide };
