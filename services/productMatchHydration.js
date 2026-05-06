// Phase 2g — hydrate ProductMatchArtifact for consumer reads.
//
// Pre-Phase-2 the artifact carried snapshot copies of all enrichment data
// (identification.details, productReviews, categoryReviews, brandReviews,
// brandCategory). Phase 2 normalized those into CatalogProduct / Category /
// Brand. Consumers (layoutInputService, instagramCommentService, the
// /detect status route) need the data on the same field paths they already
// read, so this helper resolves the FKs and returns a view object where:
//
//   match.identification.details   ← CatalogProduct commerce fields
//   match.productReviews           ← CatalogProduct.productReviews
//   match.categoryReviews          ← Category.categoryReviews
//   match.brandCategory            ← { breadcrumb, url } from Category row
//   match.brandReviews             ← Brand.brandReviews
//
// Snapshot fields on the artifact are used as fallback so legacy artifacts
// (pre-Phase-2 runs) still render. Once 2e drops the snapshot fields, the
// fallback paths become dead and can be removed in a follow-up.

const CatalogProduct = require('../models/CatalogProduct');
const Category       = require('../models/Category');
const Brand          = require('../models/Brand');

async function hydrateMatch(match) {
  if (!match) return null;

  const [catalog, category, brand] = await Promise.all([
    match.catalogProductId
      ? CatalogProduct.findById(match.catalogProductId)
          .select('productUrl imageUrl description price currency category categoryRef rating ratingDistribution reviews specs sellers reviewSummary productReviews')
          .lean()
      : null,
    match.categoryId
      ? Category.findById(match.categoryId).select('breadcrumb url categoryReviews').lean()
      : null,
    match.brandId
      ? Brand.findById(match.brandId).select('brandReviews websiteUrl').lean()
      : null
  ]);

  const view = { ...match };

  if (catalog) {
    const snapDetails = match.identification?.details || {};
    view.identification = {
      ...match.identification,
      details: {
        ...snapDetails,
        // Canonical commerce fields override snapshot when present.
        url:                catalog.productUrl       || snapDetails.url       || null,
        imageUrl:           catalog.imageUrl         || snapDetails.imageUrl  || null,
        description:        catalog.description      || snapDetails.description || null,
        category:           catalog.category         || snapDetails.category  || null,
        categoryRef:        catalog.categoryRef      || snapDetails.categoryRef || null,
        rating:             catalog.rating         ?? snapDetails.rating      ?? null,
        ratingDistribution: (catalog.ratingDistribution?.length ? catalog.ratingDistribution : snapDetails.ratingDistribution) || [],
        reviews:            (catalog.reviews?.length            ? catalog.reviews            : snapDetails.reviews)            || [],
        specs:              catalog.specs            || snapDetails.specs    || null,
        sellers:            (catalog.sellers?.length            ? catalog.sellers            : snapDetails.sellers)            || [],
        reviewSummary:      catalog.reviewSummary    || snapDetails.reviewSummary || null,
        price:              snapDetails.price ?? (catalog.price != null
          ? { value: catalog.price, currency: catalog.currency || null, display: formatPrice(catalog.price, catalog.currency) }
          : null)
      }
    };
    if (catalog.productReviews) view.productReviews = catalog.productReviews;
  }

  if (category) {
    if (category.categoryReviews) view.categoryReviews = category.categoryReviews;
    // brandCategory previously carried { breadcrumb, url, confidence, reasoning, source }.
    // Keep snapshot's confidence/reasoning (not stored on Category) and override
    // breadcrumb/url with the canonical Category row.
    view.brandCategory = {
      ...(match.brandCategory || {}),
      breadcrumb: category.breadcrumb || match.brandCategory?.breadcrumb || null,
      url:        category.url        || match.brandCategory?.url        || null
    };
  }

  if (brand?.brandReviews) view.brandReviews = brand.brandReviews;

  return view;
}

function formatPrice(value, currency) {
  if (value == null) return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const sym = currency === 'USD' ? '$' : (currency || '');
  return sym ? `${sym}${num.toFixed(2)}` : `${num.toFixed(2)}`;
}

module.exports = { hydrateMatch };
