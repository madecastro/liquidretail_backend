// Product match orchestrator. Runs every enabled provider in parallel,
// then applies a decision tree to decide what kind of identification
// downstream layout templates can rely on.
//
// Decision tree (top-down — first match wins):
//   1. multi-brand contention      → outcome: 'do_not_use'
//      yoloIdentifications carry products from MULTIPLE different brands
//      (UGC scene with mixed brands; we shouldn't generate ad creative
//      from this Media at all).
//   2. no product detected anywhere → outcome: 'branding'
//      yoloIdentifications + geminiMatches both empty. Treat the Media
//      as brand content and pull BRAND-level reviews to substitute for
//      product reviews downstream.
//   3. yolo + gemini agree         → outcome: 'confirmed'
//      Both signals point at the same product. No extra lookup needed.
//   4. low confidence everywhere    → outcome: 'category'
//      max(yoloConf, geminiConf) < CONFIDENCE_FLOOR but a product was
//      detected. Look up the brand's own collection-page taxonomy on
//      their website (via Gemini grounded search) so the CTA can link
//      to the right collection rather than a wrong SKU.
//   5. yolo wins                    → outcome: 'lookup_from_yolo'
//      Run Gemini grounded search using YOLO's identification to fetch
//      the canonical product listing.
//   6. gemini wins                  → outcome: 'lookup_from_gemini'
//      Use Gemini's already-found product as canonical.
//
// Adding a new provider (e.g. Vertex AI Product Search for a brand catalog):
//   1. Create server/services/providers/<name>.js exporting { match, isEnabled, PROVIDER_NAME }
//   2. require + register it below
//   3. Its output slot in the response appears automatically; no call-site changes.

const mongoose = require('mongoose');

const { getCoarseSubtreeIds } = require('./categoryClassifier');
const geminiSearch = require('./providers/geminiSearchProvider');
const googleLens   = require('./providers/googleLensProvider');
const { identifyProduct } = require('./productReasoner');
const productDetails  = require('./productDetailsService');
const productCategory = require('./productCategoryService');
const visualCatalogMatch = require('./visualCatalogMatchService');   // Phase 1.7
const categoryReviewsSvc = require('./categoryReviewsService');       // Phase 1.7c
const Category = require('../models/Category');                        // Phase 2a
const { findOrCreateCategoryTree } = require('../models/Category');    // Phase 2a
const Brand           = require('../models/Brand');
const { normalizeTitle, titleSimilarity } = require('../utils/titleNormalize');
const { normalizeBrandName } = require('../models/Brand');
const textEmbedding = require('./textEmbeddingService');   // T3 — semantic similarity tier
const CatalogProduct     = require('../models/CatalogProduct');
const Media              = require('../models/Media');
const DetectionArtifact  = require('../models/DetectionArtifact');
const { loadBrandSafety, evaluatePostSafety } = require('./brandSafetyService');

// How long a cached Brand.brandReviews snapshot is considered fresh
// before we re-fetch. 30 days — brand sentiment moves slowly enough
// that older data is still representative for ad creative.
const BRAND_REVIEWS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Same TTL for product-level reviews on CatalogProduct.productReviews.
// Reviews on a specific SKU evolve at roughly the same pace as brand
// sentiment, so we reuse the same window.
const PRODUCT_REVIEWS_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const PROVIDERS = [
  geminiSearch,
  googleLens
];

// ── Decision-tree thresholds ─────────────────────────────────────────
// PRODUCT_FLOOR — YOLO+GPT below this is treated as "no product detected".
//                 YOLO+GPT is the authoritative product oracle (Gemini
//                 search returns matches for ANY query). Below 0.7 → no
//                 product, regardless of Gemini.
// HIGH_CONFIDENCE — DUAL-ENGINE + CATALOG threshold. YOLO+GPT reconciled
//                 confidence to promote a match to product_match, and the
//                 catalog-first combined score to declare a winner and
//                 short-circuit providers. Vision + text agree at 0.80.
// REASONER_*     — Per-product REASONER thresholds. The reasoner's own
//                 guide names 0.70-0.89 as "high" and 0.50-0.69 as
//                 "medium"; we align the decision tree to that shape.
//                 Previously overloaded HIGH_CONFIDENCE (0.80) as the
//                 reasoner cut too — measured 2026-08-13: 126/166 UGC
//                 matches landed in brand_match, and reasoner rows at
//                 cert 0.70-0.79 were being demoted from "high" to
//                 product_category (or worse to brand_match if URL guard
//                 fired), which is what the reasoner's own guide would
//                 have called product_match. Split constants close the
//                 gap; kill switch REASONER_ALIGNED_BANDS=false restores
//                 the pre-2026-08-17 code (HIGH_CONFIDENCE for reasoner).
const PRODUCT_FLOOR    = 0.70;
const HIGH_CONFIDENCE  = 0.80;
const CATEGORY_LOWER   = 0.69;   // > 0.69 (i.e. ≥ 0.70 effectively) — DUAL-ENGINE band
const CATEGORY_UPPER   = 0.79;   // ≤ 0.79 — DUAL-ENGINE band
const REASONER_ALIGNED_BANDS = process.env.REASONER_ALIGNED_BANDS !== 'false';
const REASONER_PRODUCT_MATCH_MIN = REASONER_ALIGNED_BANDS ? 0.70 : 0.80;
const REASONER_CATEGORY_LOWER    = REASONER_ALIGNED_BANDS ? 0.49 : 0.69;
const REASONER_CATEGORY_UPPER    = REASONER_ALIGNED_BANDS ? 0.69 : 0.79;

async function findProductMatches({
  brand, category, caption, primarySubject, textDetected, imageUrl,
  brandUrl,                     // brand homepage (used by category + branding lookups)
  advertiserId = null,          // tenant scope — needed to find the cached Brand for brand-reviews lookup
  brandId      = null,          // Phase C — needed for catalog lookup against CatalogProduct
  yoloIdentifications = []      // [{ identification: { label, brand, category, confidence, ... } }]
}) {
  const enabled = PROVIDERS.filter(p => p.isEnabled());
  const skipped = PROVIDERS.filter(p => !p.isEnabled()).map(p => p.PROVIDER_NAME);

  // ── Run all providers in parallel ─────────────────────────────────
  const tasks = enabled.map(p =>
    p.match({ brand, category, caption, primarySubject, textDetected, imageUrl })
     .then(result => ({ status: 'ok', name: p.PROVIDER_NAME, result }))
     .catch(err => ({ status: 'err', name: p.PROVIDER_NAME, error: err.message || String(err) }))
  );
  const settled = await Promise.all(tasks);

  const providers = {};
  const errors = {};
  let totalMatches = 0;
  for (const s of settled) {
    if (s.status === 'ok') {
      providers[s.name] = s.result;
      totalMatches += s.result.matches.length;
    } else {
      errors[s.name] = s.error;
      console.warn(`   ✗ ${s.name}: ${s.error}`);
    }
  }

  // ── Existing GPT-4.1 reasoner (kept) ──────────────────────────────
  // Triangulates across all providers. We still keep it because the
  // decision tree below uses its `productName` + `certainty` as the
  // "Gemini-side winner candidate" — productReasoner does the cross-
  // provider synthesis we'd otherwise need to redo here.
  let identification = null;
  if (totalMatches > 0) {
    try {
      identification = await identifyProduct({
        brand, category, caption, primarySubject, textDetected, imageUrl, providers
      });
      console.log(`🔎 Identification: ${identification.productName || '(none)'} — ${identification.certaintyLabel} (${(identification.certainty * 100).toFixed(0)}%)`);
    } catch (err) {
      console.warn(`   ✗ productReasoner: ${err.message}`);
      errors.reasoner = err.message;
    }
  }

  // ── Catalog lookup (Phase C) ──
  // Search the brand's CatalogProduct rows for a text + category match
  // against what YOLO+GPT and Gemini have surfaced. Brands without a
  // synced catalog skip silently (returns null).
  let catalogMatch = null;
  if (brandId) {
    try {
      const yoloTopForCatalog = (yoloIdentifications || [])
        .map(d => d?.identification)
        .filter(id => id && (id.confidence || 0) >= PRODUCT_FLOOR && id.label && id.label !== 'non-product')
        .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0] || null;
      catalogMatch = await findCatalogMatch({
        brandId,
        yoloTop:        yoloTopForCatalog,
        geminiTop:      identification,
        category,
        // Phase C — also feed in the upstream pipeline artifacts so the
        // scorer sees text detected on the product itself (often a SKU
        // name or model number), the GPT-4.1 scene description, and the
        // user-supplied caption.
        caption,
        primarySubject,
        textDetected
      });
      if (catalogMatch) {
        console.log(`📦 catalog match: "${catalogMatch.product.title}" (score ${catalogMatch.score.toFixed(2)}) — ${catalogMatch.reasoning}`);
      }
    } catch (err) {
      console.warn(`   ✗ catalog lookup: ${err.message}`);
      errors.catalogMatch = err.message;
    }
  }

  // ── DECISION TREE ─────────────────────────────────────────────────
  const decision = await runDecisionTree({
    yoloIdentifications,
    geminiIdentification: identification,
    catalogMatch,
    brand, brandUrl, category
  });
  const { outcome, outcomeReasoning, winner } = decision;
  let { brandCategory, brandReviews } = decision;

  // Provenance flags for the artifact. matchSource is 'ig-catalog'
  // when the catalog won outright, 'both' when catalog agreed with
  // remote signals, 'gemini-search' when remote signals won alone,
  // null when there's no specific product (brand_match / do_not_use).
  let matchSource = null;
  if (outcome === 'product_match') {
    if (winner === 'catalog')     matchSource = 'ig-catalog';
    else if (catalogMatch?.score >= 0.5) matchSource = 'both';
    else                          matchSource = 'gemini-search';
  }

  // ── Post-decision enrichment per outcome ──────────────────────────
  // Pick the best YOLO product up here so winner='yolo' enrichment can
  // use it without re-running the filter.
  const yoloProductIds = (yoloIdentifications || [])
    .map(d => d?.identification)
    .filter(id => id && (id.confidence || 0) >= PRODUCT_FLOOR
                 && typeof id.label === 'string' && id.label.trim().length > 0
                 && id.label !== 'non-product')
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  const yoloTop = yoloProductIds[0] || null;

  // YOLO-winner: override identification.productName/brand with YOLO's
  // label so downstream consumers see the YOLO-identified product.
  // identification.details (URL/price/etc.) stays from Gemini's first
  // pass — best-effort enrichment for v1; future work can do a targeted
  // Gemini lookup keyed on YOLO's label for higher fidelity.
  if (outcome === 'product_match' && winner === 'yolo' && yoloTop) {
    if (!identification) identification = {};
    identification.productName = yoloTop.label;
    if (yoloTop.brand) identification.brand = yoloTop.brand;
    identification.certainty = yoloTop.confidence;
    identification.certaintyLabel = 'yolo-winner';
    console.log(`   · YOLO winner override: identification.productName → "${yoloTop.label}"`);
  }

  // Catalog winner: identification points at the catalog row directly —
  // canonical title + URL come from the brand's authoritative inventory,
  // not derived from prose. details.url overrides whatever Gemini found
  // (the brand's own product page beats third-party retailer URLs).
  if (outcome === 'product_match' && winner === 'catalog' && catalogMatch?.product) {
    if (!identification) identification = {};
    const cp = catalogMatch.product;
    identification.productName    = cp.title;
    identification.certainty      = catalogMatch.score;
    identification.certaintyLabel = 'catalog-winner';
    identification.details = Object.assign({}, identification.details, {
      url:        cp.productUrl || identification.details?.url || null,
      imageUrl:   cp.imageUrl   || identification.details?.imageUrl || null,
      price:      cp.price      != null ? cp.price : identification.details?.price,
      currency:   cp.currency   || identification.details?.currency,
      source:     'ig-catalog'
    });
    console.log(`   · catalog winner override: identification.productName → "${cp.title}" (URL ${cp.productUrl || '∅'})`);
  }

  // SKU details — only fetch when we have a confident product to look up.
  if (outcome === 'product_match' && identification?.productName && (identification.certainty || 0) >= 0.3) {
    if (productDetails.isEnabled()) {
      try {
        identification.details = await productDetails.fetchProductDetails(identification);
      } catch (err) {
        console.warn(`   ✗ productDetails: ${err.message}`);
        errors.productDetails = err.message;
      }
    } else {
      skipped.push('product-details (SERPAPI_API_KEY not set)');
    }
  }

  // OpenAI brand-collection enrichment — runs for EVERY identified
  // product (product_match) AND for product_category (where it's the
  // primary signal). Every identified product should know which brand
  // collection it belongs to.
  if (outcome === 'product_match' || outcome === 'product_category') {
    const productLabel = identification?.productName
                       || yoloTop?.label
                       || category;
    const productDescription = yoloTop?.description || null;
    const productCategoryHint = yoloTop?.category || category;
    if (productLabel && productCategory.isEnabled()) {
      try {
        brandCategory = await productCategory.enrichProductCategory({
          brandName: brand,
          brandUrl,
          productLabel,
          productCategory: productCategoryHint,
          productDescription
        });
      } catch (err) {
        console.warn(`   ✗ productCategory: ${err.message}`);
        errors.productCategory = err.message;
      }
    } else if (!productCategory.isEnabled()) {
      skipped.push('product-category (OPENAI_API_KEY not set)');
    }
  }

  // Brand reviews — only for brand_match outcomes. Read from the
  // cached Brand.brandReviews (Phase: standalone branding) when
  // available + fresh; fall back to a fresh Gemini call otherwise.
  // Note the cached version still gets persisted to the per-Media
  // ProductMatchArtifact for audit / historical record.
  if (outcome === 'brand_match') {
    brandReviews = await fetchBrandReviewsCachedOrFresh({ brand, brandUrl, advertiserId });
  }

  console.log(`🎯 Match outcome: ${outcome}${winner ? ` (winner=${winner})` : ''} — ${outcomeReasoning}`);

  // ── Lazy product-reviews (Phase E) ──
  // When a catalog product won (or both signals agreed on it), fire-and-
  // forget a Gemini grounded search for product-specific reviews and
  // cache on CatalogProduct.productReviews. Subsequent matches on the
  // same SKU read the cache. Skipped when reviews are still fresh.
  let productReviews = null;
  if (outcome === 'product_match' && catalogMatch?.product) {
    productReviews = await maybeFetchProductReviewsCached({
      catalogProductId: catalogMatch.product._id,
      productName:      identification?.productName || catalogMatch.product.title,
      brandName:        brand,
      productUrl:       catalogMatch.product.productUrl
    });
  }

  return {
    query: { brand, brandUrl, category, caption, primarySubject, textDetected },
    identification,           // existing — single canonical product (from reasoner)
    providers,                // existing — per-provider evidence trail
    errors,
    skipped,
    totalMatches,

    // ── New decision-tree outputs ──
    outcome,                  // 'confirmed' | 'lookup_from_yolo' | 'lookup_from_gemini' |
                              // 'category' | 'branding' | 'do_not_use'
    outcomeReasoning,         // human-readable why
    winner,                   // 'yolo' | 'gemini' | 'agree' | 'catalog' | null
    brandCategory,            // { breadcrumb, url, confidence } or null
    brandReviews,             // { quotes, rating, reviewCount, summary } or null

    // ── Phase C provenance ──
    matchSource,              // 'ig-catalog' | 'gemini-search' | 'both' | null
    catalogMatch,             // { product, score, reasoning } when found, else null

    // ── Phase E ──
    // Cached product-level reviews from CatalogProduct (cache hit) or
    // null if a fresh fetch was kicked off (background; appears next run).
    productReviews
  };
}

// ── Phase 1.8 — per-product provider runner ──
//
// Replaces the scene-level provider chain with a per-refined-product call.
// Each refined product gets its own Gemini grounded search (multimodal,
// seeded with the tight crop image) + Google Lens (with the tight crop URL).
// The result is a per-product providers map + errors + totalMatches that
// gets fed into productReasoner for a per-product identification.
//
// Returns: { providers, errors, totalMatches, skipped }
async function runPerProductProviders(refined, ctx) {
  const enabled = PROVIDERS.filter(p => p.isEnabled());
  const skipped = PROVIDERS.filter(p => !p.isEnabled()).map(p => p.PROVIDER_NAME);

  const tasks = enabled.map(p =>
    p.match({
      brand:          ctx.brand,
      category:       refined.category || ctx.category,
      caption:        ctx.caption,
      primarySubject: refined.label,                 // ← per-product label seed (was scene-level primarySubject)
      textDetected:   ctx.textDetected,
      imageUrl:       refined.croppedImageUrl,        // ← per-product crop URL (Lens uses this)
      cropImageUrl:   refined.croppedImageUrl         // ← multimodal seed for Gemini grounded search
    })
    .then(result => ({ status: 'ok', name: p.PROVIDER_NAME, result }))
    .catch(err => ({ status: 'err', name: p.PROVIDER_NAME, error: err.message || String(err) }))
  );
  const settled = await Promise.all(tasks);

  const providers = {};
  const errors = {};
  let totalMatches = 0;
  for (const s of settled) {
    if (s.status === 'ok') {
      providers[s.name] = s.result;
      totalMatches += s.result.matches.length;
    } else {
      errors[s.name] = s.error;
      console.warn(`   ✗ per-product ${s.name}[${refined.id}]: ${s.error}`);
    }
  }
  return { providers, errors, totalMatches, skipped };
}

// Per-product reasoner — same productReasoner.identifyProduct as before,
// but seeded with per-product inputs instead of scene-level. Returns the
// reasoner's structured identification or null when no provider hits.
async function runPerProductReasoner(provResult, refined, ctx) {
  if (!provResult || provResult.totalMatches === 0) return null;
  try {
    const ident = await identifyProduct({
      brand:          ctx.brand,
      category:       refined.category || ctx.category,
      caption:        ctx.caption,
      primarySubject: refined.label,
      textDetected:   ctx.textDetected,
      imageUrl:       refined.croppedImageUrl,
      providers:      provResult.providers
    });
    if (ident) {
      console.log(`   · per-product reasoner[${refined.id}]: "${ident.productName || '(none)'}" — ${ident.certaintyLabel} (${((ident.certainty || 0) * 100).toFixed(0)}%)`);
    }
    return ident;
  } catch (err) {
    console.warn(`   ⚠️  per-product reasoner[${refined.id}] failed: ${err.message}`);
    return null;
  }
}

// Build a match record from per-product provider+reasoner output.
//
// Outcome decision uses TWO confidences:
//   - reasoner certainty: SKU-level claim from web-grounded providers
//   - refined confidence: category-level claim from upstream dual-engine
//                         (vision-based, often more confident at the
//                         broader claim than the reasoner is at the SKU)
//
// Decision tree (post-2026-08-17 realignment):
//   reasoner.certainty ≥ REASONER_PRODUCT_MATCH_MIN (0.70)
//                                          → product_match (SKU-level hit)
//   reasoner in category band AND refined ≥ HIGH_CONFIDENCE (0.80)
//                                          → product_match using REFINED
//                                            label (broader claim still
//                                            confident; SKU stays as
//                                            secondary evidence)
//   reasoner in REASONER_CATEGORY band (0.50-0.70)
//                                          → product_category
//   else                                   → brand_match
//
// Also enforces:
//   - URL-type guard: reasoner's productName is only trusted when its
//     primary evidence URL looks like a product page (e.g. /products/,
//     /dp/, /p/). Marketing pages (/pages/, /blog/, /collections/, …)
//     get the productName stripped — they're brand-level evidence only.
//   - brand_match nulls out productName/variant/reasoning/primaryUrl/
//     primaryThumbnail so consumers don't read fabricated SKUs.
function buildPerProductProviderMatchRecord(refined, provResult, ident, ctx) {
  const reasonerCert = ident?.certainty || 0;
  const refinedCert  = clampUnit(refined?.confidence ?? 0);

  // URL-type guard — strip productName when the primary evidence URL
  // doesn't look like a product page. Pelagic Gear's /pages/fleet hit
  // generated a fabricated "PELAGIC Pro Team Fishing Boat (Fleet Series)"
  // SKU; that page is editorial/marketing, not commerce.
  let cleanedIdent = ident;
  if (ident?.productName && !looksLikeProductUrl(ident.primaryUrl, ident.evidenceUrls)) {
    cleanedIdent = {
      ...ident,
      productName: null,
      variant:     null,
      reasoning:   `evidence URL "${ident.primaryUrl || '(none)'}" is not a product page; productName stripped`
    };
  }

  const cert = cleanedIdent?.certainty || 0;
  let outcome, winner, outcomeReasoning;
  if (cleanedIdent?.productName && cert >= REASONER_PRODUCT_MATCH_MIN) {
    outcome = 'product_match';
    winner  = 'gemini';
    outcomeReasoning = `per-product reasoner identified "${cleanedIdent.productName}" at ${(cert * 100).toFixed(0)}% certainty`;
  } else if (refinedCert >= HIGH_CONFIDENCE && refined.brand && cert >= 0.50) {
    // Reasoner couldn't pin a SKU but the dual-engine is confident at
    // brand+category level. Promote to product_match using the BROADER
    // refined label so the high-confidence vision claim isn't lost.
    outcome = 'product_match';
    winner  = 'agree';
    outcomeReasoning = `dual-engine refined identification "${refined.label}" at ${(refinedCert * 100).toFixed(0)}% (reasoner at ${(cert * 100).toFixed(0)}% on SKU "${cleanedIdent?.productName || 'n/a'}")`;
    cleanedIdent = {
      ...(cleanedIdent || {}),
      productName: refined.label,
      brand:       refined.brand,
      certainty:   refinedCert,
      certaintyLabel: 'high',
      reasoning:   `Refined identification used (dual-engine ${(refinedCert * 100).toFixed(0)}% beat reasoner SKU at ${(cert * 100).toFixed(0)}%)`
    };
  } else if (cleanedIdent?.productName && cert > REASONER_CATEGORY_LOWER && cert <= REASONER_CATEGORY_UPPER) {
    outcome = 'product_category';
    winner  = 'gemini';
    outcomeReasoning = `per-product reasoner: mid-confidence (${(cert * 100).toFixed(0)}%); falling back to brand collection page`;
  } else {
    outcome = 'brand_match';
    winner  = null;
    outcomeReasoning = `per-product providers returned no trustworthy product signal (certainty ${(cert * 100).toFixed(0)}%)`;
    // Strip fabricated SKU info from brand_match identifications so
    // consumers don't read low-confidence ghost products. Keep brand,
    // certainty, evidenceUrls — those are real brand-level evidence.
    if (cleanedIdent) {
      cleanedIdent = {
        brand:           cleanedIdent.brand || null,
        certainty:       cleanedIdent.certainty ?? 0,
        certaintyLabel:  cleanedIdent.certaintyLabel || 'low',
        reasoning:       cleanedIdent.reasoning || '',
        evidenceUrls:    cleanedIdent.evidenceUrls || [],
        // Explicitly null these so the schema doesn't carry stale values.
        productName:     null,
        variant:         null,
        primaryUrl:      null,
        primaryRetailer: null,
        primaryThumbnail: null
      };
    }
  }

  return {
    productIndex: refined.id,
    query: {
      brand:          ctx.brand,
      brandUrl:       ctx.brandUrl,
      category:       refined.category || ctx.category,
      caption:        ctx.caption,
      primarySubject: refined.label,
      textDetected:   ctx.textDetected,
      productCrop: {
        id:              refined.id,
        label:           refined.label,
        categoryLabel:   refined.categoryLabel || null,   // broader label from category-confirmed reconciliation
        category:        refined.category,
        brand:           refined.brand || null,
        agreement:       refined.agreement || null,
        confidence:      refinedCert,                     // upstream dual-engine confidence
        x1: refined.x1, y1: refined.y1, x2: refined.x2, y2: refined.y2,
        croppedImageUrl: refined.croppedImageUrl
      }
    },
    identification:       cleanedIdent,
    outcome,
    outcomeReasoning,
    winner,
    matchSource:          outcome === 'product_match' ? 'gemini-search' : null,
    catalogProductId:     null,
    catalogMatch:         null,
    catalogVisualScore:   null,
    catalogCombinedScore: null,
    providers:            provResult.providers || {},
    errors:               provResult.errors    || {},
    productReviews:       null,                        // enrichment fan-out hydrates
    brandCategory:        null,                        // ditto
    brandReviews:         null
  };
}

// Heuristic check — does this URL look like a product page (commerce),
// or is it editorial/marketing? Used to gate productName trust in the
// per-product reasoner output.
function looksLikeProductUrl(primaryUrl, evidenceUrls) {
  const PRODUCT_PATTERNS = /\/(products?|product-detail|item|sku|dp|p|gp\/product|pd\/|shop\/)\b/i;
  const NON_PRODUCT_PATTERNS = /\/(pages|page|blog|news|article|post|category|categories|collections|collection|tag|search|about|team|fleet|community|gallery)\b/i;
  const candidates = [primaryUrl, ...(Array.isArray(evidenceUrls) ? evidenceUrls.map(e => e?.url) : [])].filter(Boolean);
  if (!candidates.length) return false;
  // If ANY candidate URL matches a product pattern, accept. If the only
  // URLs match non-product patterns, reject.
  for (const u of candidates) {
    if (PRODUCT_PATTERNS.test(u)) return true;
  }
  for (const u of candidates) {
    if (NON_PRODUCT_PATTERNS.test(u)) return false;
  }
  // Ambiguous (e.g. domain root). Be conservative — reject so we fall
  // through to brand_match instead of fabricating a SKU.
  return false;
}

function clampUnit(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

// ── Phase 1.7a — per-product orchestrator ──
//
// Wraps findProductMatches with per-refined-product catalog-first matching.
// When refinedProducts is empty (video, refinement failed), behaves exactly
// like findProductMatches — single scene-level match wrapped in a
// matches[1] array for consistency.
//
// Contract:
//   inputs:  same as findProductMatches PLUS refinedProducts[] (Phase 1.6)
//   returns: {
//     matches: [
//       {
//         productIndex,         // refined product id (e.g. 'r1')
//         identification,       // per-product (from catalog row OR scene reasoner OR refined fallback)
//         outcome, winner,
//         catalogMatch, catalogVisualScore, catalogCombinedScore,
//         providers, errors,    // scene-level — replicated only on the primary fallback match
//         query, ...
//       }, ...
//     ],
//     detectSummary: { outcome, matchedProducts, matchedCategories, detectedAt },
//     // Plus all the legacy top-level fields, aliased to the primary match,
//     // so existing callers (pipelines/detect.js writing one ProductMatchArtifact,
//     // routes/detect.js, layoutInputService) keep working without change.
//     query, identification, providers, errors, skipped, totalMatches,
//     outcome, outcomeReasoning, winner,
//     brandCategory, brandReviews,
//     matchSource, catalogMatch, productReviews
//   }
async function findPerProductMatches(args) {
  const { refinedProducts = [], brandId, caption, textDetected, brand } = args;

  // ── Phase 4 follow-up #5 — Brand Safety pre-check ──
  // Short-circuits before any matcher work when the post's text-bearing
  // signals (caption + OCR + comments) hit any of the brand's curated
  // blocked topics. Returns a do_not_use-shaped result so
  // layoutInputService hard-stops downstream creative assembly without
  // having to touch every consumer.
  if (brandId) {
    const safetyConfig = await loadBrandSafety(brandId);
    if (safetyConfig && safetyConfig.blockedTopics.length > 0) {
      const evalResult = evaluatePostSafety(safetyConfig.blockedTopics, {
        caption,
        textDetected,
        comments: args.comments
      });
      if (!evalResult.safe) {
        const topicsHit = [...new Set(evalResult.hits.map(h => h.topic))];
        const sample = evalResult.hits.slice(0, 3)
          .map(h => `${h.topic}→"${h.snippet}" (${h.source})`)
          .join('; ');
        console.log(`🛡️  brand-safety block (${safetyConfig.brandName || brandId}): topics=[${topicsHit.join(', ')}] · ${sample}`);
        return buildBrandSafetyBlockResult(args, topicsHit, evalResult.hits, safetyConfig.brandName);
      }
    }
  }

  // Phase 1.7 — per-refined-product catalog-first (text + visual).
  // `brand` here is the args.brand string (Brand.name) resolved by the
  // dispatcher; we forward it as brandName so T1 handle-expansion in
  // findCatalogMatchByText doesn't have to re-fetch it per call.
  let perRefinedCatalog = [];
  let anyCatalogWinner  = false;
  if (refinedProducts.length && brandId) {
    perRefinedCatalog = await Promise.all(refinedProducts.map(rp =>
      catalogFirstMatchOneRefined(rp, { brandId, brandName: brand || null, caption, textDetected })
        .catch(err => {
          console.warn(`   ⚠️  catalog-first[${rp.id}]: ${err.message}`);
          return { combinedScore: 0, catalogMatch: null, visualResult: null };
        })
    ));
    anyCatalogWinner = perRefinedCatalog.some(r => r.combinedScore >= 0.80);
    const winnerCount = perRefinedCatalog.filter(r => r.combinedScore >= 0.80).length;
    if (winnerCount > 0) {
      console.log(`📦 catalog-first: ${winnerCount} of ${refinedProducts.length} refined product(s) hit catalog at combined ≥ 0.80`);
    }
  }

  // ── Phase 1.8 — per-product providers for non-catalog refined products ──
  //
  // When refinedProducts exist AND some didn't catalog-win, run providers
  // (Gemini grounded search + Google Lens) PER refined product, seeded with
  // that product's tight crop image + label — instead of the scene-level
  // primarySubject / source image. Each per-product call gets its own
  // reasoner pass producing a per-product identification.
  //
  // This closes the scene-leakage gap: non-catalog identifications no longer
  // inherit "Man wearing fishing apparel on boat" as the search query — they
  // get "Pelagic Gear bikini top" with the actual cropped image attached.
  //
  // The legacy scene-level findProductMatches call only fires when refined-
  // Products is empty (e.g., video, or refinement failed entirely).
  const needsProviders = refinedProducts.length
    ? perRefinedCatalog.some(r => r.combinedScore < 0.80)
    : true;

  let sceneLevel = null;
  let perProductProviderResults = [];
  if (refinedProducts.length === 0 && needsProviders) {
    // Legacy single-match fallback (no refined products at all)
    sceneLevel = await findProductMatches(args);
  } else if (refinedProducts.length && needsProviders) {
    // Per-product provider+reasoner for refined products that didn't catalog-win
    perProductProviderResults = await Promise.all(refinedProducts.map(async (rp, i) => {
      if (perRefinedCatalog[i]?.combinedScore >= 0.80) return null; // catalog winner; skip
      const provResult = await runPerProductProviders(rp, args);
      const ident      = await runPerProductReasoner(provResult, rp, args);
      return { provResult, ident };
    }));
    const ranCount = perProductProviderResults.filter(r => r).length;
    if (ranCount > 0) {
      console.log(`📡 per-product providers ran on ${ranCount} of ${refinedProducts.length} refined product(s) (catalog miss path)`);
    }
  } else {
    console.log(`   · all refined products are catalog winners; skipping providers entirely`);
  }

  // Build matches[] array
  const matches = [];

  if (refinedProducts.length) {
    refinedProducts.forEach((rp, i) => {
      const catRes = perRefinedCatalog[i] || {};
      if (catRes.combinedScore >= 0.80 && catRes.catalogMatch?.product) {
        matches.push(buildCatalogWinnerMatchRecord(rp, catRes, args));
        return;
      }
      const provRes = perProductProviderResults[i];
      if (provRes?.ident?.productName) {
        matches.push(buildPerProductProviderMatchRecord(rp, provRes.provResult, provRes.ident, args));
        return;
      }
      // Fall back to refined-only record (no catalog, no provider hit)
      matches.push(buildRefinedFallbackRecord(rp, null, args));
    });
  } else if (sceneLevel) {
    // Legacy single-match path: no refinedProducts, just wrap scene-level
    matches.push(convertSceneLevelToMatchRecord(sceneLevel, args));
  }

  // Detect summary aggregation (Phase 0b consumer for Media.classification)
  const detectSummary = aggregateDetectSummary(matches, brand);

  // ── Phase 1.7b — per-match enrichment fan-out ──
  // Three-tiered (SKU / category / brand). Idempotent: each tier checks
  // whether its target field is already populated (e.g. by the legacy
  // findProductMatches scene-level path) and skips work that would
  // duplicate. Catalog winners arrive un-enriched and get the full pass.
  const enrichCtx = {
    brand:        args.brand,
    brandUrl:     args.brandUrl,
    advertiserId: args.advertiserId,
    brandId:      args.brandId,
    mediaId:      args.mediaId,        // Phase 2a/2b
    category:     args.category
  };
  await Promise.all(matches.map(m =>
    enrichOneMatchInPlace(m, enrichCtx).catch(err => {
      console.warn(`   ⚠️  per-match enrichment[${m.productIndex || 'primary'}] failed: ${err.message}`);
      return m;
    })
  ));

  // Primary match for backward-compat aliasing (post-enrichment so the
  // primary alias carries the enrichment results too).
  const primary = pickPrimaryMatch(matches);

  return {
    // ── Phase 1.7 outputs ──
    matches,
    detectSummary,

    // ── Legacy aliases (primary match) ──
    query:            primary?.query           || sceneLevel?.query           || { brand, brandUrl: args.brandUrl, category: args.category, caption, primarySubject: args.primarySubject, textDetected },
    identification:   primary?.identification  || sceneLevel?.identification  || null,
    providers:        sceneLevel?.providers    || {},
    errors:           sceneLevel?.errors       || {},
    skipped:          sceneLevel?.skipped      || [],
    totalMatches:     sceneLevel?.totalMatches || 0,
    outcome:          primary?.outcome         || sceneLevel?.outcome         || 'brand_match',
    outcomeReasoning: primary?.outcomeReasoning|| sceneLevel?.outcomeReasoning|| '',
    winner:           primary?.winner          || sceneLevel?.winner          || null,
    brandCategory:    primary?.brandCategory   || sceneLevel?.brandCategory   || null,
    brandReviews:     primary?.brandReviews    || sceneLevel?.brandReviews    || null,
    matchSource:      primary?.matchSource     || sceneLevel?.matchSource     || null,
    catalogMatch:     primary?.catalogMatch    || sceneLevel?.catalogMatch    || null,
    productReviews:   primary?.productReviews  || sceneLevel?.productReviews  || null
  };
}

// ── Phase 4 follow-up #5 — brand-safety short-circuit shape ──
//
// Mirrors the legacy return shape so existing consumers (routes/detect,
// pipelines/detect, layoutInputService, ProductMatchArtifact persistence)
// keep working unchanged. outcome=do_not_use is the existing hard-stop
// signal layoutInputService already enforces.
//
// We include a single synthetic match record so detect.js writes a
// ProductMatchArtifact with outcome=do_not_use, making the block
// queryable in run history. matches[] entry has identification=null,
// so enrichOneMatchInPlace short-circuits without firing any provider
// work (Tier 1/2/3 enrichment all gate on identification).
function buildBrandSafetyBlockResult(args, topicsHit, hits, brandName) {
  const reasoning = `Post matched blocked topic(s) in ${brandName ? `"${brandName}"` : 'brand'} safety policy: ${topicsHit.join(', ')}`;
  const query = {
    brand:          args.brand,
    brandUrl:       args.brandUrl,
    category:       args.category,
    caption:        args.caption,
    primarySubject: args.primarySubject,
    textDetected:   args.textDetected
  };
  const syntheticMatch = {
    productIndex:     null,
    query,
    providers:        {},
    errors:           {},
    identification:   null,
    outcome:          'do_not_use',
    outcomeReasoning: reasoning,
    winner:           null,
    matchSource:      null,
    catalogMatch:     null,
    catalogProductId: null,
    brandSafetyBlock: { topics: topicsHit, hits }
  };
  return {
    matches:          [syntheticMatch],
    detectSummary: {
      outcome:           'brand_safety_block',
      matchedProducts:   0,
      matchedCategories: [],
      detectedAt:        new Date()
    },
    query,
    identification:   null,
    providers:        {},
    errors:           {},
    skipped:          ['brand_safety'],
    totalMatches:     0,
    outcome:          'do_not_use',
    outcomeReasoning: reasoning,
    winner:           null,
    brandCategory:    null,
    brandReviews:     null,
    matchSource:      null,
    catalogMatch:     null,
    productReviews:   null,
    brandSafetyBlock: { topics: topicsHit, hits }
  };
}

// ── Phase 1.7b — three-tier per-match enrichment ──
//
// Mutates the match record in place; returns it. Idempotent: each tier
// checks whether its target field is already populated and skips
// re-fetching (matters for the scene-level fallback path, where the
// legacy findProductMatches has already enriched the primary identification).
//
// Tier 1 (SKU):       outcome=product_match + certainty>=0.3 →
//                     productDetails (sellers/rating/reviewSummary) +
//                     productReviews (Gemini grounded, cached on CatalogProduct)
// Tier 2 (Category):  outcome=product_match OR product_category →
//                     productCategoryService (brand collection breadcrumb)
// Tier 3 (Brand):     outcome=product_category OR brand_match →
//                     brandReviews (brand-level Gemini grounded reviews)
// Recommended (bonus): outcome=product_category →
//                     up to 5 sibling CatalogProducts in the same category
async function enrichOneMatchInPlace(match, ctx) {
  if (!match || !match.identification) return match;
  const ident   = match.identification;
  const outcome = match.outcome;
  const tiers   = [];

  // ── Phase 2b — always-create CatalogProduct for confident matches ──
  // When the match has a confident product identification AND points at
  // a brand we own AND is not already linked to a CatalogProduct, find-
  // or-create one with source='detect-identified'. The Brand toggle
  // uploadSettings.autoCreateFromDetect controls draft state (true →
  // auto-promoted, false → draft awaiting review) — NOT whether the row
  // is created. Result: every confident match has a CatalogProduct FK
  // for downstream consumers (productReviews fetching, recommended
  // products query, repeat-match speedup, layout-input lookup).
  if (outcome === 'product_match' && !match.catalogProductId && ctx.brandId
      && ident.productName && (ident.certainty || 0) >= 0.7) {
    try {
      const cpId = await ensureCatalogProductForMatch(match, ctx);
      if (cpId) match.catalogProductId = cpId;
    } catch (err) {
      console.warn(`   ⚠️  ensureCatalogProductForMatch[${match.productIndex || 'primary'}]: ${err.message}`);
    }
  }

  // ── Detect backstop (reverse-flow pre-warm) ──
  // Catalog-product detect (crops/overlay zones) is deferred at sync
  // time and runs on-demand at ad generation. When a post CONFIRMS a
  // product match, that product is a likely ad subject — pre-warm its
  // detect artifacts now (fire-and-forget, no wait) so ad generation
  // finds them ready. Post-scale (few confident matches), not catalog-
  // scale. Lazy require avoids a load-order cycle.
  if (outcome === 'product_match' && match.catalogProductId) {
    try {
      require('./catalogProductDetectService')
        .ensureDetectForProducts([match.catalogProductId], {
          advertiserId: ctx.advertiserId || null,
          brandId:      ctx.brandId || null,
          wait:         false
        })
        .catch(err => console.warn(`   ⚠️  detect pre-warm[${match.catalogProductId}]: ${err.message}`));
    } catch (err) {
      console.warn(`   ⚠️  detect pre-warm enqueue[${match.catalogProductId}]: ${err.message}`);
    }
  }

  // ── Tier 1 — SKU enrichment ──
  if (outcome === 'product_match' && ident.productName && (ident.certainty || 0) >= 0.3) {
    // productDetails — fire when commerce data is thin (catalog rows have
    // price/url/imageUrl but rarely sellers/rating; scene matches start empty).
    const needsCommerce = !ident.details?.rating
                       || !Array.isArray(ident.details?.sellers)
                       || !ident.details.sellers.length;
    if (productDetails.isEnabled() && needsCommerce) {
      try {
        // Phase 2f — pass catalogProductId so productDetails writes-through
        // to the CatalogProduct row + reads from cache on repeat hits.
        const d = await productDetails.fetchProductDetails(ident, match.catalogProductId);
        if (d) {
          // Merge: SerpAPI commerce data fills in, but the catalog-row
          // authoritative fields (url, imageUrl, price, currency,
          // description, source) STAY when they're already set.
          ident.details = {
            ...d,
            ...ident.details,
            // Pull in commerce fields if they were missing
            rating:        ident.details?.rating        ?? d.rating,
            reviewCount:   ident.details?.reviewCount   ?? d.reviewCount,
            sellers:       ident.details?.sellers?.length ? ident.details.sellers : d.sellers,
            reviewSummary: ident.details?.reviewSummary || d.reviewSummary
          };
          tiers.push('sku');
        }
      } catch (err) {
        console.warn(`   ⚠️  productDetails per-match[${match.productIndex || 'primary'}]: ${err.message}`);
      }
    } else if (ident.details?.rating || ident.details?.sellers?.length) {
      tiers.push('sku');   // already enriched (legacy scene-level path); record the tier
    }

    // productReviews — cached on CatalogProduct row when present
    if (match.catalogProductId && !match.productReviews) {
      try {
        match.productReviews = await maybeFetchProductReviewsCached({
          catalogProductId: match.catalogProductId,
          productName:      ident.productName,
          brandName:        ident.brand,
          productUrl:       ident.details?.url
        });
      } catch (err) {
        console.warn(`   ⚠️  productReviews per-match[${match.productIndex || 'primary'}]: ${err.message}`);
      }
    }
  }

  // ── Tier 2 — Category breadcrumb (collection page on the brand's site) ──
  if ((outcome === 'product_match' || outcome === 'product_category') && !match.brandCategory) {
    if (productCategory.isEnabled()) {
      // Inputs cascade SKU label → refined product label → refined category → run-scoped category.
      // For category-confirmed reconciled products (Phase 1.5c), categoryLabel
      // is the broader fallback if specific label gives nothing useful.
      const productLabel = ident.productName
                        || match.query?.productCrop?.categoryLabel
                        || match.query?.productCrop?.label
                        || ctx.category;
      const productCategoryHint = match.query?.productCrop?.category || ctx.category;
      const productDescription  = ident.details?.description || null;
      if (productLabel) {
        try {
          match.brandCategory = await productCategory.enrichProductCategory({
            brandName:       ctx.brand,
            brandUrl:        ctx.brandUrl,
            productLabel,
            productCategory: productCategoryHint,
            productDescription
          });
          if (match.brandCategory) tiers.push('category');
        } catch (err) {
          console.warn(`   ⚠️  productCategory per-match[${match.productIndex || 'primary'}]: ${err.message}`);
        }
      }
    }
  } else if (match.brandCategory) {
    tiers.push('category');
  }

  // ── Phase 2a — resolve the Category tree FK ──
  // Once brandCategory.breadcrumb is set, find-or-create the Category tree
  // (top-down by segment) and link the leaf Category._id onto the match
  // and onto the catalog row when present. Replaces the snapshot-only
  // brandCategory pattern with a relational link.
  if (match.brandCategory?.breadcrumb && !match.categoryId && ctx.brandId) {
    try {
      match.categoryId = await findOrCreateCategoryTree({
        brandId:          ctx.brandId,
        advertiserId:     ctx.advertiserId,
        breadcrumb:       match.brandCategory.breadcrumb,
        url:              match.brandCategory.url || null,
        firstSeenMediaId: ctx.mediaId || null
      });
      // Upgrade CatalogProduct.categoryRef to the fine-grained leaf.
      // catalogSyncService stamps a COARSE Category leaf at sync time
      // (e.g. "Food & Beverage", depth=0); productCategoryService's
      // breadcrumb is prefixed with that same coarse root so the new
      // leaf is a deeper descendant of the coarse root. Overwriting is
      // safe — the fine leaf is strictly more specific than the coarse
      // one, and the coarse subtree still covers it for filter
      // purposes.
      if (match.catalogProductId && match.categoryId) {
        const breadcrumb = match.brandCategory?.breadcrumb || null;
        // Owner rule 2026-08-11 (FEED_TRUTH_CATEGORIES): the feed's
        // categoryRef, if catalogSyncService stamped one, is
        // authoritative. This GPT-4.1 upgrade path used to overwrite
        // unconditionally; now it only stamps categoryRef when the
        // row lacks one. The brand-nav breadcrumb is still written to
        // CatalogProduct.category (a display string, not the filter
        // key) so CTA URLs + downstream copy still get the fine leaf.
        // Flag OFF restores the pre-change unconditional overwrite.
        const { isFeedTruthCategoriesEnabled } = require('./categoryClassifier');
        const existing = await CatalogProduct.findById(match.catalogProductId).select('categoryRef').lean();
        const shouldOverwriteRef = !isFeedTruthCategoriesEnabled() || !existing?.categoryRef;
        await CatalogProduct.updateOne(
          { _id: match.catalogProductId },
          { $set: {
              ...(shouldOverwriteRef ? { categoryRef: match.categoryId } : {}),
              ...(breadcrumb ? { category: breadcrumb } : {})
          } }
        );
        await Category.updateOne(
          { _id: match.categoryId },
          { $addToSet: { relatedProducts: match.catalogProductId } }
        );
      }
      // Track which Media surfaced this category (denormalized cache)
      if (ctx.mediaId && match.categoryId) {
        await Category.updateOne(
          { _id: match.categoryId },
          { $addToSet: { relatedMedia: ctx.mediaId }, $set: { lastSeenAt: new Date() } }
        );
      }
    } catch (err) {
      console.warn(`   ⚠️  category tree resolution[${match.productIndex || 'primary'}]: ${err.message}`);
    }
  }

  // ── Tier 2.5 — Category-level reviews (Phase 1.7c) ──
  // Fetched when we have a brandCategory breadcrumb. Used by category-level
  // comments AND as a quote fallback for product-level comments when
  // productReviews is empty. Cache-aware on Brand.categoryReviews; cache
  // miss kicks off background fetch and returns null (next run picks up).
  if ((outcome === 'product_match' || outcome === 'product_category') && match.brandCategory?.breadcrumb && !match.categoryReviews) {
    try {
      match.categoryReviews = await categoryReviewsSvc.maybeFetchCategoryReviewsCached({
        brandId:    ctx.brandId,
        brandName:  ctx.brand,
        brandUrl:   ctx.brandUrl,
        breadcrumb: match.brandCategory.breadcrumb
      });
      if (match.categoryReviews?.quotes?.length) tiers.push('categoryReviews');
    } catch (err) {
      console.warn(`   ⚠️  categoryReviews per-match[${match.productIndex || 'primary'}]: ${err.message}`);
    }
  } else if (match.categoryReviews?.quotes?.length) {
    tiers.push('categoryReviews');
  }

  // ── Tier 3 — Brand-level reviews (no SKU resolution) ──
  if ((outcome === 'product_category' || outcome === 'brand_match') && !match.brandReviews) {
    try {
      match.brandReviews = await fetchBrandReviewsCachedOrFresh({
        brand:        ctx.brand,
        brandUrl:     ctx.brandUrl,
        advertiserId: ctx.advertiserId
      });
      if (match.brandReviews) tiers.push('brand');
    } catch (err) {
      console.warn(`   ⚠️  brandReviews per-match[${match.productIndex || 'primary'}]: ${err.message}`);
    }
  } else if (match.brandReviews) {
    tiers.push('brand');
  }

  // ── Recommended products (Phase 1.7b bonus) ──
  // For category-confirmed matches that didn't resolve a specific SKU,
  // surface up to 5 sibling CatalogProducts in the same category. Gives
  // downstream layout/template generation a usable surface even without
  // SKU-level identification — the "we know this is in your Mens > Tops
  // category, here's what's recommended in that category" pattern.
  if (outcome === 'product_category' && ctx.brandId && !match.recommendedProducts?.length) {
    const cropCategory = match.query?.productCrop?.category || ctx.category;
    if (cropCategory) {
      try {
        const recs = await CatalogProduct
          .find({
            brandId:  ctx.brandId,
            draft:    { $ne: true },
            category: { $regex: escapeRegex(cropCategory), $options: 'i' }
          })
          .sort({ updatedAt: -1 })
          .limit(5)
          .select('_id title description category brand price currency imageUrl productUrl externalId source')
          .lean();
        match.recommendedProducts = recs;
        if (recs.length) {
          console.log(`   · recommended[${match.productIndex || 'primary'}]: ${recs.length} sibling product(s) in category "${cropCategory}"`);
        }
      } catch (err) {
        console.warn(`   ⚠️  recommendedProducts per-match[${match.productIndex || 'primary'}]: ${err.message}`);
      }
    }
  }

  match.enrichmentTiers = [...new Set(tiers)];
  return match;
}

// ── Match-record builders ──

function buildCatalogWinnerMatchRecord(refined, catRes, args) {
  const cp = catRes.catalogMatch.product;
  return {
    productIndex:        refined.id,
    query: {
      brand:          args.brand,
      brandUrl:       args.brandUrl,
      category:       args.category,
      caption:        args.caption,
      primarySubject: args.primarySubject,
      textDetected:   args.textDetected,
      productCrop: {
        id:               refined.id,
        label:            refined.label,
        categoryLabel:    refined.categoryLabel || null,
        category:         refined.category,
        brand:            refined.brand || null,
        agreement:        refined.agreement || null,
        confidence:       clampUnit(refined.confidence ?? 0),
        x1: refined.x1, y1: refined.y1, x2: refined.x2, y2: refined.y2,
        croppedImageUrl:  refined.croppedImageUrl
      }
    },
    identification: {
      productName:     cp.title,
      brand:           cp.brand || args.brand,
      certainty:       catRes.combinedScore,
      certaintyLabel:  'catalog-winner',
      reasoning:       `catalog text+visual match (text=${catRes.textScore.toFixed(2)}, visual=${catRes.visualScore.toFixed(2)})`,
      details: {
        title:        cp.title,
        description:  cp.description || null,
        category:     cp.category    || refined.category || null,
        url:          cp.productUrl  || null,
        imageUrl:     cp.imageUrl    || null,
        price:        cp.price       || null,
        currency:     cp.currency    || null,
        productId:    cp._id ? String(cp._id) : null,
        source:       'ig-catalog'
      }
    },
    outcome:          'product_match',
    outcomeReasoning: `catalog ${catRes.visualScore >= 0.5 ? 'text+visual' : 'text-only'} match at combined ${catRes.combinedScore.toFixed(2)}`,
    winner:           'catalog',
    brandCategory:    null,
    brandReviews:     null,
    matchSource:      'ig-catalog',
    catalogProductId: cp._id || null,
    catalogMatch: {
      productId:   cp._id,
      title:       cp.title,
      score:       catRes.textScore,
      reasoning:   catRes.catalogMatch.reasoning,
      signalsUsed: catRes.catalogMatch.signalsUsed
    },
    catalogVisualScore:   catRes.visualScore,
    catalogCombinedScore: catRes.combinedScore,
    providers:        {},          // skipped — catalog won
    errors:           {},
    productReviews:   null         // can be hydrated lazily by consumer
  };
}

function buildSceneLevelMatchRecord(refined, sceneLevel, args) {
  return {
    productIndex:    refined.id,
    query: {
      ...sceneLevel.query,
      productCrop: {
        id:              refined.id,
        label:           refined.label,
        categoryLabel:   refined.categoryLabel || null,
        category:        refined.category,
        brand:           refined.brand || null,
        agreement:       refined.agreement || null,
        confidence:      clampUnit(refined.confidence ?? 0),
        x1: refined.x1, y1: refined.y1, x2: refined.x2, y2: refined.y2,
        croppedImageUrl: refined.croppedImageUrl
      }
    },
    identification:   sceneLevel.identification,
    outcome:          sceneLevel.outcome,
    outcomeReasoning: sceneLevel.outcomeReasoning,
    winner:           sceneLevel.winner,
    brandCategory:    sceneLevel.brandCategory,
    brandReviews:     sceneLevel.brandReviews,
    matchSource:      sceneLevel.matchSource,
    catalogProductId: sceneLevel.catalogMatch?.product?._id || null,
    catalogMatch:     sceneLevel.catalogMatch || null,
    catalogVisualScore:   null,
    catalogCombinedScore: sceneLevel.catalogMatch?.score || null,
    providers:        sceneLevel.providers || {},
    errors:           sceneLevel.errors    || {},
    productReviews:   sceneLevel.productReviews || null
  };
}

function buildRefinedFallbackRecord(refined, sceneLevel, args) {
  // Refined product has no catalog hit AND no scene-level identification.
  // Build a minimal record from the refined product's own label/category.
  return {
    productIndex:    refined.id,
    query: {
      brand:          args.brand,
      brandUrl:       args.brandUrl,
      category:       args.category,
      caption:        args.caption,
      primarySubject: args.primarySubject,
      textDetected:   args.textDetected,
      productCrop: {
        id:              refined.id,
        label:           refined.label,
        categoryLabel:   refined.categoryLabel || null,
        category:        refined.category,
        brand:           refined.brand || null,
        agreement:       refined.agreement || null,
        confidence:      clampUnit(refined.confidence ?? 0),
        x1: refined.x1, y1: refined.y1, x2: refined.x2, y2: refined.y2,
        croppedImageUrl: refined.croppedImageUrl
      }
    },
    identification: {
      productName:    refined.label || null,
      brand:          refined.brand || args.brand || null,
      certainty:      Math.min(0.69, refined.confidence || 0.5),     // capped to mid-range — no SKU resolution
      certaintyLabel: 'category-fallback',
      reasoning:      'no catalog match and no scene-level identification; using refined product label',
      details: {
        category:     refined.category || null,
        source:       'refined-yolo'
      }
    },
    outcome:          refined.category && refined.category !== 'non-product' ? 'product_category' : 'brand_match',
    outcomeReasoning: 'refined product had no catalog hit and scene-level providers did not produce a usable identification',
    winner:           null,
    brandCategory:    sceneLevel?.brandCategory || null,
    brandReviews:     sceneLevel?.brandReviews  || null,
    matchSource:      null,
    catalogProductId: null,
    catalogMatch:     null,
    catalogVisualScore:   null,
    catalogCombinedScore: null,
    providers:        {},
    errors:           {},
    productReviews:   null
  };
}

function convertSceneLevelToMatchRecord(sceneLevel, args) {
  return {
    productIndex:    null,                       // legacy — no refined product
    query:           sceneLevel.query,
    identification:  sceneLevel.identification,
    outcome:         sceneLevel.outcome,
    outcomeReasoning: sceneLevel.outcomeReasoning,
    winner:          sceneLevel.winner,
    brandCategory:   sceneLevel.brandCategory,
    brandReviews:    sceneLevel.brandReviews,
    matchSource:     sceneLevel.matchSource,
    catalogProductId: sceneLevel.catalogMatch?.product?._id || null,
    catalogMatch:    sceneLevel.catalogMatch || null,
    catalogVisualScore:   null,
    catalogCombinedScore: sceneLevel.catalogMatch?.score || null,
    providers:       sceneLevel.providers || {},
    errors:          sceneLevel.errors    || {},
    productReviews:  sceneLevel.productReviews || null
  };
}

// Pick the highest-scoring match for legacy aliasing. Catalog winners
// outrank otherwise-equal matches.
function pickPrimaryMatch(matches) {
  if (!matches.length) return null;
  return matches.slice().sort((a, b) => {
    // Catalog winners first
    const aCat = a.winner === 'catalog' ? 1 : 0;
    const bCat = b.winner === 'catalog' ? 1 : 0;
    if (aCat !== bCat) return bCat - aCat;
    // Then by combined catalog score (or certainty if no catalog)
    const aScore = a.catalogCombinedScore ?? a.identification?.certainty ?? 0;
    const bScore = b.catalogCombinedScore ?? b.identification?.certainty ?? 0;
    return bScore - aScore;
  })[0];
}

// Aggregate run-scoped detect summary for Media.classification.detectSummary
// (Phase 0b consumer). Outcome priority: own_product > competitor > category > no_products.
function aggregateDetectSummary(matches, activeBrand) {
  const matchedProducts   = [];
  const matchedCategories = new Set();
  let hasOwn        = false;
  let hasCompetitor = false;
  let hasCategory   = false;

  for (const m of matches) {
    const ident = m.identification || {};
    if (ident.productName) {
      matchedProducts.push({
        name:      ident.productName,
        brand:     ident.brand || null,
        certainty: ident.certainty || 0
      });
    }
    const cat = ident.details?.category || m.brandCategory?.breadcrumb || m.query?.productCrop?.category;
    if (cat) matchedCategories.add(cat);

    if (m.outcome === 'product_match') {
      if (brandsMatchLoose(ident.brand, activeBrand)) hasOwn = true;
      else if (ident.brand)                            hasCompetitor = true;
    } else if (m.outcome === 'product_category') {
      hasCategory = true;
    } else if (m.outcome === 'do_not_use') {
      hasCompetitor = true;     // multi-brand contention — treat as competitor signal
    }
  }

  let outcome = 'no_products';
  if (hasOwn && hasCompetitor)  outcome = 'mixed';
  else if (hasOwn)              outcome = 'own_product';
  else if (hasCompetitor)       outcome = 'competitor';
  else if (hasCategory)         outcome = 'category';

  return {
    outcome,
    matchedProducts,
    matchedCategories: [...matchedCategories],
    detectedAt: new Date()
  };
}

function brandsMatchLoose(a, b) {
  if (!a || !b) return false;       // require BOTH brands present for an own-vs-competitor decision
  const na = normalizeBrand(a);
  const nb = normalizeBrand(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Tolerate the common "short-name vs full-name" pattern: provider returns
  // "Pelagic" while the active brand is "Pelagic Gear" (or vice versa).
  // Match when one normalized form is a whole-token prefix of the other —
  // but require ≥4 chars on the shorter side so a 3-letter coincidence
  // (e.g. "Tom" matching "Tom Brown's School") doesn't sneak through.
  const shorter = na.length <= nb.length ? na : nb;
  const longer  = na.length <= nb.length ? nb : na;
  if (shorter.length >= 4 && longer.startsWith(shorter + ' ')) return true;
  // Abbreviation match — e.g. detect returns "HCO" while the registered
  // brand is "Hot Crispy Oil", or vice versa. Treat the shorter side as
  // an acronym candidate when it's 2-5 contiguous chars; build the
  // first-letter abbreviation of the longer side and compare. Captures
  // the common brand-shorthand case without giving up the false-positive
  // protection that the 4-char prefix rule provides.
  if (shorter.length >= 2 && shorter.length <= 5 && !shorter.includes(' ')) {
    const abbrev = longer.split(/\s+/).filter(Boolean).map(w => w[0]).join('');
    if (abbrev === shorter) return true;
  }
  return false;
}

function normalizeBrand(s) {
  return String(s || '').toLowerCase()
    .replace(/[®™©]/g, '')
    .replace(/\b(inc|co|llc|ltd|corp|corporation)\.?/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Decision tree ────────────────────────────────────────────────────
//
// Outcomes:
//   product_match    — confident specific-product identification.
//                       winner ∈ { 'agree', 'yolo', 'gemini' }
//   product_category — no high-confidence SKU but enough mid-range
//                       signal to land on the brand's collection page.
//                       winner = whichever side had higher conf.
//   brand_match      — no trustworthy product signal; brand-only ad.
//                       winner = null. Brand reviews fetched separately.
//   do_not_use       — multi-brand contention; cannot generate creative.
//
// Threshold table (yC = YOLO+GPT product conf if ≥ PRODUCT_FLOOR else 0;
//                  gC = Gemini reasoner certainty):
//
//   1. multi-brand (≥2 brands in YOLO at conf ≥ 0.7) → do_not_use
//   2. yC > 0 AND gC > 0 AND same product               → product_match (agree)
//   3. yC == 0 AND gC ≥ 0.85                            → product_match (gemini)
//   4. yC ≥ 0.85 AND yC > gC                            → product_match (yolo)
//   5. gC ≥ 0.85 AND gC > yC                            → product_match (gemini)
//   6. yC > 0 AND max(yC, gC) ∈ (0.69, 0.84]           → product_category
//   7. (catch-all)                                       → brand_match
async function runDecisionTree({
  yoloIdentifications,
  geminiIdentification,
  catalogMatch,
  brand,
  brandUrl,
  category
}) {
  const yoloIds = (yoloIdentifications || [])
    .map(d => d?.identification)
    .filter(id => id && typeof id.confidence === 'number');

  // 1. Multi-brand contention.
  const distinctBrands = new Set(
    yoloIds
      .filter(id => id.confidence >= 0.7 && id.brand)
      .map(id => String(id.brand).trim().toLowerCase())
      .filter(Boolean)
  );
  if (distinctBrands.size >= 2) {
    return baseOutcome('do_not_use', null,
      `multiple brands detected on the same Media (${[...distinctBrands].join(', ')}); creative would be ambiguous`);
  }

  // 1b. Confident catalog hit. The brand's own inventory telling us
  // "yes, we sell this" is more authoritative than retailer-search
  // matches. Skip directly to product_match (winner='catalog').
  if (catalogMatch?.score >= HIGH_CONFIDENCE) {
    return baseOutcome('product_match', 'catalog',
      `catalog match "${catalogMatch.product.title}" (${pct(catalogMatch.score)}) — brand's authoritative inventory`);
  }

  // YOLO product candidates — must clear floor AND have a label AND not be
  // explicitly marked non-product (Phase 1.5 escape hatch — prevents UI
  // chrome / scroll arrows / watermarks from feeding the decision tree).
  const yoloProductIds = yoloIds
    .filter(id => (id.confidence || 0) >= PRODUCT_FLOOR
                 && typeof id.label === 'string'
                 && id.label.trim().length > 0
                 && id.label !== 'non-product')
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  const yoloTop = yoloProductIds[0] || null;
  const yC      = yoloTop?.confidence || 0;
  const geminiTop  = geminiIdentification || null;
  const gC         = geminiTop?.certainty || 0;
  const hasGeminiProduct = !!geminiTop?.productName;

  // 2. Both agree.
  if (yoloTop && hasGeminiProduct && sameProduct(yoloTop, geminiTop)) {
    return baseOutcome('product_match', 'agree',
      `YOLO+GPT (${pct(yC)}) and Gemini (${pct(gC)}) both identified "${geminiTop.productName}"`);
  }

  // 3. Gemini-only high confidence.
  if (!yoloTop && gC >= HIGH_CONFIDENCE && hasGeminiProduct) {
    return baseOutcome('product_match', 'gemini',
      `YOLO+GPT detected no product; Gemini search confidently identified "${geminiTop.productName}" (${pct(gC)})`);
  }

  // 4. YOLO wins high.
  if (yC >= HIGH_CONFIDENCE && yC > gC) {
    return baseOutcome('product_match', 'yolo',
      `YOLO+GPT (${pct(yC)}) identified "${yoloTop.label}" with higher confidence than Gemini (${pct(gC)}) — Gemini will enrich`);
  }

  // 5. Gemini wins high.
  if (gC >= HIGH_CONFIDENCE && gC > yC && hasGeminiProduct) {
    return baseOutcome('product_match', 'gemini',
      `Gemini (${pct(gC)}) identified "${geminiTop.productName}" with higher confidence than YOLO+GPT (${pct(yC)})`);
  }

  // 6. Mid-range — YOLO must have detected SOMETHING (Gemini alone in
  // mid range isn't trustworthy — it'll find anything). Max signal must
  // be in (LOWER, UPPER].
  const maxConf = Math.max(yC, gC);
  if (yoloTop && maxConf > CATEGORY_LOWER && maxConf <= CATEGORY_UPPER) {
    return baseOutcome('product_category', yC >= gC ? 'yolo' : 'gemini',
      `mid-confidence signal (yolo ${pct(yC)}, gemini ${pct(gC)}); falling back to brand collection page`);
  }

  // 7. Brand fallback.
  return baseOutcome('brand_match', null,
    `no trustworthy product signal (yolo ${pct(yC)}, gemini ${pct(gC)}); treating as brand content`);
}

function baseOutcome(outcome, winner, reasoning) {
  return { outcome, winner, outcomeReasoning: reasoning,
           brandCategory: null, brandReviews: null };
}
function pct(n) { return `${(n * 100).toFixed(0)}%`; }

// Loose product equality — two identifications point at the same thing
// when their normalized labels share a substantial token overlap. We
// don't have SKUs from YOLO+GPT, so we work with names.
function sameProduct(yolo, gemini) {
  const a = normalizeForMatch(yolo.label || yolo.description || '');
  const b = normalizeForMatch(gemini.productName || '');
  if (!a || !b) return false;
  const aTokens = new Set(a.split(/\s+/).filter(t => t.length >= 3));
  const bTokens = new Set(b.split(/\s+/).filter(t => t.length >= 3));
  if (!aTokens.size || !bTokens.size) return false;
  let shared = 0;
  for (const t of aTokens) if (bTokens.has(t)) shared++;
  // Jaccard similarity ≥ 0.4 means "probably the same product"
  const union = new Set([...aTokens, ...bTokens]).size;
  return (shared / union) >= 0.4;
}

function normalizeForMatch(s) {
  return String(s)
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Wrappers around the gemini provider helpers — soft-fail so an
// outcome resolution always returns a usable shape even if grounded
// search hiccups.
async function tryLookupBrandCategoryUrl(args) {
  try { return await geminiSearch.lookupBrandCategoryUrl(args); }
  catch (err) {
    console.warn(`   ⚠️  brand-category lookup failed: ${err.message}`);
    return null;
  }
}
async function tryLookupBrandReviews(brandName, brandUrl, brandId = null) {
  try { return await geminiSearch.lookupBrandReviews({ brandName, brandUrl, brandId }); }
  catch (err) {
    console.warn(`   ⚠️  brand-reviews lookup failed: ${err.message}`);
    return null;
  }
}

// Cache-aware brand-reviews fetch. Resolution order:
//   1. If we can locate the Brand row by (advertiserId, normalized name)
//      AND it has brandReviews with a fetchedAt within TTL → return cached.
//   2. If we found the Brand but cache is missing/stale → fetch fresh,
//      WRITE to Brand for next time, return.
//   3. If we couldn't find a Brand (advertiser hasn't created one for
//      this name yet) → fetch fresh, don't write, return.
// Returns null if every path fails — caller persists null to artifact.
async function fetchBrandReviewsCachedOrFresh({ brand: brandName, brandUrl, advertiserId }) {
  if (!brandName) return null;

  let brandDoc = null;
  if (advertiserId) {
    const normalized = normalizeBrandName(brandName);
    if (normalized) {
      brandDoc = await Brand.findOne({ advertiserId, nameNormalized: normalized });
    }
  }

  // Cache hit?
  if (brandDoc?.brandReviews?.quotes?.length) {
    const fetchedAt = brandDoc.brandReviews.fetchedAt
      ? new Date(brandDoc.brandReviews.fetchedAt).getTime() : 0;
    const ageMs = Date.now() - fetchedAt;
    if (ageMs < BRAND_REVIEWS_TTL_MS) {
      console.log(`   · brand-reviews: cache hit for "${brandName}" (age ${Math.round(ageMs / 86400000)}d)`);
      return brandDoc.brandReviews;
    }
    console.log(`   · brand-reviews: cache stale for "${brandName}" (age ${Math.round(ageMs / 86400000)}d > 30d), refetching`);
  }

  // Fresh fetch. brandDoc is null when the advertiser has no Brand row for
  // this name yet (resolution case 3) — the cost row is still written, just
  // without the brand join.
  const fresh = await tryLookupBrandReviews(brandName, brandUrl, brandDoc?._id || null);
  if (!fresh || !Array.isArray(fresh.quotes) || fresh.quotes.length === 0) return fresh;

  // Write back to the catalog if we have a row to write to.
  if (brandDoc) {
    try {
      // SAME DATA-LOSS BUG AS THE ENRICHMENT PERSIST SITE, second write path.
      // This runs whenever a match resolves brand reviews with no Brand row cached
      // yet or a stale one, and `fresh` reaching here is guaranteed to have quotes
      // (the early return above) but NOT numbers — grounded search returns the
      // aggregates independently. A wholesale replace therefore wipes a stored
      // rating/count exactly the way the enrichment path did. Reuse the one helper
      // rather than a second merge that can drift from it; required lazily because
      // brandEnrichmentService is a heavy module and this is the only use of it here.
      const { preserveBrandReviewNumbers } = require('./brandEnrichmentService');
      const merged = Object.assign({}, fresh, { fetchedAt: new Date() });
      preserveBrandReviewNumbers(merged, brandDoc.brandReviews);
      brandDoc.brandReviews = merged;
      // Keep enrichmentSources in sync so /refresh-enrichment can
      // detect 'brand-reviews' was attempted.
      const sources = new Set(brandDoc.enrichmentSources || []);
      sources.add('brand-reviews');
      brandDoc.enrichmentSources = [...sources];
      await brandDoc.save();
      console.log(`   · brand-reviews: cached on Brand "${brandName}"`);
    } catch (err) {
      console.warn(`   ⚠️  brand-reviews cache write failed for "${brandName}": ${err.message}`);
    }
  }
  return fresh;
}

// ── Catalog match (Phase C) ──────────────────────────────────────────
//
// Searches the brand's CatalogProduct rows for a row whose title +
// description has the highest weighted-overlap with every text signal
// the detect pipeline produced for this Media — YOLO label, YOLO
// description, Gemini-reasoner productName, OCR'd text on the product,
// GPT-4.1 primarySubject, and the user-supplied caption.
//
// Score is a weighted recall (how many term tokens land in the catalog
// row) summed across all signals and normalized 0-1. Catalog rows in
// the same category as the YOLO category hint get a small bonus.
//
// Returns { product, score, reasoning, signalsUsed } or null when no
// catalog row clears the floor.
async function findCatalogMatch({
  brandId, yoloTop, geminiTop, category,
  caption, primarySubject, textDetected
}) {
  if (!brandId) return null;

  const signals = [];
  if (yoloTop?.label)         signals.push({ text: yoloTop.label,         weight: 1.0, src: 'yolo-label' });
  if (yoloTop?.description)   signals.push({ text: yoloTop.description,   weight: 0.7, src: 'yolo-desc' });
  if (geminiTop?.productName) signals.push({ text: geminiTop.productName, weight: 0.9, src: 'gemini-name' });
  if (Array.isArray(textDetected)) {
    for (const t of textDetected.filter(Boolean).slice(0, 8)) {
      signals.push({ text: String(t), weight: 0.8, src: 'ocr-text' });
    }
  }
  if (primarySubject) signals.push({ text: primarySubject, weight: 0.6, src: 'primary-subject' });
  if (caption)        signals.push({ text: caption,        weight: 0.5, src: 'caption' });
  if (!signals.length) return null;

  // Cap the candidate pull. V1 brands typically have well under 500
  // SKUs; V2 (CLIP embeddings + vector index) handles large catalogs.
  // Match across ig-catalog AND manual-upload sources, but exclude
  // drafts — drafts have incomplete commerce data (no price /
  // productUrl) and shouldn't be presented as confident matches.
  const rows = await CatalogProduct
    .find({ brandId, draft: { $ne: true } })
    .limit(500)
    .select('title description category brand price currency imageUrl productUrl externalId source')
    .lean();
  if (!rows.length) return null;

  const cat = category ? String(category).toLowerCase().trim() : null;

  let best = null;
  for (const row of rows) {
    const haystack = (`${row.title || ''} ${row.description || ''}`).toLowerCase();
    const haystackTokens = new Set(tokenize(haystack));
    if (!haystackTokens.size) continue;

    let totalWeight = 0, matchedWeight = 0;
    const matchedSrcs = new Set();
    for (const sig of signals) {
      const sigTokens = new Set(tokenize(sig.text));
      if (!sigTokens.size) continue;
      let shared = 0;
      for (const t of sigTokens) if (haystackTokens.has(t)) shared++;
      const overlap = shared / sigTokens.size; // term-recall — credit
                                               // for proportion of the
                                               // signal that hit
      totalWeight   += sig.weight;
      matchedWeight += sig.weight * overlap;
      if (shared > 0) matchedSrcs.add(sig.src);
    }
    if (!totalWeight) continue;
    let score = matchedWeight / totalWeight;

    // Category bonus — caps at +0.10 to keep weighted overlap dominant.
    if (cat && row.category) {
      const rc = String(row.category).toLowerCase().trim();
      if (rc === cat || rc.includes(cat) || cat.includes(rc)) {
        score = Math.min(1, score + 0.10);
      }
    }

    // Floor of 0.30 keeps incidental token noise (a, an, the surviving
    // the stopword list) from yielding spurious matches.
    if (score >= 0.30 && (!best || score > best.score)) {
      best = {
        product:     row,
        score,
        reasoning:   `weighted token overlap (${matchedSrcs.size}/${signals.length} signals hit: ${[...matchedSrcs].join(', ')})`,
        signalsUsed: [...matchedSrcs]
      };
    }
  }
  return best;
}

// ── Phase 1.7 — text-only catalog scorer with category scoping ──
//
// Drops the AI-derived signals (yoloTop.label, geminiTop.productName,
// primarySubject) the legacy findCatalogMatch above used. Those create a
// circular feedback loop: model identifies "Aquatek Top" → we search the
// catalog for "Aquatek Top" → catalog confirms what the model already
// said. Catalog confirmation should come from INDEPENDENT signals.
//
// Inputs that survived the trim:
//   - textDetected[] (OCR on the product itself — labels printed on the
//     garment / packaging; SKU-grade signal when available)
//   - caption (user-authored post caption — creator intent)
//   - comments[] (future — IG post-comments sync)
//
// Optional category scoping (Phase 1.7 enhancement): when a confirmed
// reconciled product has a category, restrict the candidate pool to
// catalog rows whose category field substring-matches. Falls back to the
// full-catalog scope if the filtered query returns < 3 candidates (so a
// thin category-mismatch in the catalog doesn't mask a real match).
//
// Returns top-K candidates sorted by textScore desc, instead of a single
// best match. Visual catalog matching (visualCatalogMatchService) then
// arbitrates among them per refined product.
// ── T2 — synonym groups (2026-08-17) ────────────────────────────────
// findCatalogMatchByText used to compare tokens literally, so "sweater"
// never matched "pullover" or "knit". A caption reading "cozy in my
// pullover" against a product titled "Marine Layer Cotton Sweater"
// scored zero shared tokens even though they're the same object class.
// Each group adds a synthetic token `~syn:<group>` to both sides during
// tokenization, so any two members become interchangeable for the token
// overlap calculation. Groups are apparel-first (62% of measured
// traffic) with beauty + food-beverage added.
//
// Kill switch: SKU_TEXT_SYNONYMS_ENABLED=false disables the expansion
// (both sides fall back to literal tokens). Env-tunable so a bad
// synonym pairing can be dropped without a deploy.
const SKU_TEXT_SYNONYMS_ENABLED = process.env.SKU_TEXT_SYNONYMS_ENABLED !== 'false';
const SKU_TEXT_SCORE_FLOOR = Math.max(0.10, Math.min(0.60, parseFloat(process.env.SKU_TEXT_SCORE_FLOOR) || 0.25));
const SKU_TEXT_CATEGORY_BOOST = Math.max(0.05, Math.min(0.40, parseFloat(process.env.SKU_TEXT_CATEGORY_BOOST) || 0.20));

const SYNONYM_GROUPS = {
  jacket:    ['jacket', 'coat', 'chore', 'shacket', 'blazer', 'parka', 'anorak', 'puffer', 'bomber', 'moto', 'trench', 'peacoat', 'windbreaker'],
  denim:     ['denim', 'jean', 'jeans'],
  knit:      ['sweater', 'pullover', 'cardigan', 'knit', 'jumper', 'hoodie', 'sweatshirt', 'crewneck'],
  shirt:     ['shirt', 'buttondown', 'button', 'tee', 'top', 'blouse', 'tunic', 'henley', 'polo', 'flannel', 'oxford'],
  pants:     ['pants', 'trousers', 'chino', 'cargo', 'joggers', 'sweatpants', 'leggings', 'slacks'],
  shorts:    ['shorts', 'short', 'bermudas'],
  dress:     ['dress', 'gown', 'midi', 'mini', 'maxi', 'frock'],
  skirt:     ['skirt', 'kilt'],
  bag:       ['bag', 'tote', 'backpack', 'purse', 'satchel', 'clutch', 'crossbody', 'duffel', 'weekender'],
  shoe:      ['shoe', 'sneaker', 'boot', 'sandal', 'loafer', 'heel', 'flat', 'mule', 'slipper', 'trainer'],
  hat:       ['hat', 'cap', 'beanie', 'fedora', 'bucket', 'snapback'],
  swim:      ['swim', 'swimsuit', 'bikini', 'trunks', 'boardshorts', 'onepiece'],
  skincare:  ['serum', 'moisturizer', 'cleanser', 'toner', 'cream', 'lotion', 'essence', 'balm', 'oil', 'gel'],
  makeup:    ['lipstick', 'gloss', 'mascara', 'foundation', 'blush', 'palette', 'concealer', 'liner', 'bronzer'],
  food:      ['sauce', 'chili', 'dressing', 'condiment', 'seasoning', 'spice', 'marinade'],
  beverage:  ['tea', 'coffee', 'soda', 'juice', 'kombucha', 'beer', 'wine', 'espresso']
};
const TOKEN_TO_SYNONYM_GROUP = new Map();
for (const [group, tokens] of Object.entries(SYNONYM_GROUPS)) {
  for (const t of tokens) TOKEN_TO_SYNONYM_GROUP.set(t, `~syn:${group}`);
}
function expandTokensWithSynonyms(tokenSet) {
  if (!SKU_TEXT_SYNONYMS_ENABLED) return tokenSet;
  const out = new Set(tokenSet);
  for (const t of tokenSet) {
    const g = TOKEN_TO_SYNONYM_GROUP.get(t);
    if (g) out.add(g);
  }
  return out;
}

// ── T1 — brand-handle expansion (2026-08-17) ─────────────────────────
// UGC captions typically compress the brand into a single social handle:
// `@marinelayer` tokenizes to `marinelayer`, but every product title is
// `Marine Layer …` (two tokens). Zero-overlap even when the caption
// clearly names the brand. This inserts spaces at the brand-name
// boundary before tokenization: `marinelayer` → `marine layer`. Only
// fires for brands whose display name has ≥ 2 tokens.
function expandBrandHandle(text, brandName) {
  if (!brandName || !text) return text;
  const brandTokens = String(brandName)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim().split(/\s+/).filter(Boolean);
  if (brandTokens.length < 2) return text;
  const compound = brandTokens.join('');
  // Word boundary is /\b/, case-insensitive, replace with spaced form.
  return String(text).replace(new RegExp(`\\b${compound}\\b`, 'gi'), brandTokens.join(' '));
}

async function findCatalogMatchByText({
  brandId,
  brandName    = null,          // T1 — optional; when set, brand handle in caption expands
  category,                     // optional category filter
  caption,
  textDetected = [],
  comments     = [],
  topK         = 3
}) {
  if (!brandId) return [];

  // Lazily resolve brand name if the caller didn't pass one — needed
  // for T1 brand-handle expansion in captions. One lookup per call is
  // fine (Brand doc is small + cached by Mongoose in-process).
  if (!brandName) {
    try {
      const b = await Brand.findById(brandId).select('name').lean();
      if (b?.name) brandName = b.name;
    } catch (_) { /* non-fatal — fall through with brandName=null */ }
  }

  // Build text-only signal list. Highest weight on OCR text (printed on
  // the product itself = SKU-grade signal); caption next; comments last.
  const signals = [];
  for (const t of (textDetected || []).slice(0, 12)) {
    const txt = typeof t === 'string' ? t : t?.content;
    const conf = typeof t === 'object' ? Number(t?.confidence) : 1;
    if (typeof txt === 'string' && txt.trim() && conf > 0.5) {
      signals.push({ text: txt, weight: 1.0, src: 'ocr' });
    }
  }
  if (caption && String(caption).trim()) {
    signals.push({ text: expandBrandHandle(String(caption), brandName), weight: 0.9, src: 'caption' });
  }
  for (const c of (comments || []).slice(0, 10)) {
    const txt = typeof c === 'string' ? c : c?.text;
    if (typeof txt === 'string' && txt.trim()) {
      signals.push({ text: expandBrandHandle(txt, brandName), weight: 0.7, src: 'comment' });
    }
  }
  if (!signals.length) return [];

  // Candidate pool — try category-scoped first, fall back to full catalog
  // when the filter is too restrictive. isPrimaryVariant: { $ne: false }
  // collapses Meta's per-SKU variant fanout (8 sizes of HCO Original →
  // 1 candidate) so we don't score the same image 8 times. Legacy rows
  // without the field set still pass; only explicit non-primaries are
  // excluded.
  const baseQuery = {
    brandId,
    draft:            { $ne: true },
    isPrimaryVariant: { $ne: false }
  };
  // Category filter: map the refined product's coarse enum (e.g.
  // 'food_beverage') to its Category subtree (the coarse root +
  // descendants that productCategoryService has upgraded). Rows are
  // stamped via:
  //   - catalogSyncService → coarse leaf (depth 0) for every new
  //     CatalogProduct via heuristic inferCoarseEnum
  //   - productMatchService → fine leaf (depth 1+) after a successful
  //     match resolves productCategoryService's GPT-4.1 breadcrumb
  // Both end up under the same coarse root, so a single categoryRef ∈
  // subtreeIds query catches both.
  let rows = [];
  if (category) {
    const subtreeIds = await getCoarseSubtreeIds({ brandId, enumCategory: category });
    if (subtreeIds.length) {
      const filtered = await CatalogProduct
        .find({ ...baseQuery, categoryRef: { $in: subtreeIds } })
        .limit(500)
        .select('title description category brand price currency imageUrl productUrl externalId source +titleEmbedding +titleEmbeddingModel +titleEmbeddingSource +titleEmbeddingAt')
        .lean();
      if (filtered.length >= 3) {
        rows = filtered;
      } else {
        console.log(`   · catalog text search: only ${filtered.length} category-scoped candidate(s) for "${category}" (${subtreeIds.length} subtree node(s)); broadening to full catalog`);
      }
    } else {
      // Coarse enum doesn't map to any Category subtree for this brand
      // yet — either it's 'other'/unrecognized OR no products of that
      // bucket have been synced. Skip the filter and use full catalog.
      console.log(`   · catalog text search: no Category subtree for "${category}"; broadening to full catalog`);
    }
  }
  if (!rows.length) {
    rows = await CatalogProduct
      .find(baseQuery)
      .limit(500)
      .select('title description category brand price currency imageUrl productUrl externalId source')
      .lean();
  }
  if (!rows.length) return [];

  const cat = category ? String(category).toLowerCase().trim() : null;
  const scored = [];

  for (const row of rows) {
    const haystack = (`${row.title || ''} ${row.description || ''}`).toLowerCase();
    // T2 — synonym-expand both sides so knit↔sweater↔pullover etc.
    // count as shared via the synthetic ~syn:<group> tokens.
    const haystackTokens = expandTokensWithSynonyms(new Set(tokenize(haystack)));
    if (!haystackTokens.size) continue;

    let totalWeight = 0, matchedWeight = 0;
    const matchedSrcs = new Set();
    for (const sig of signals) {
      const sigTokens = expandTokensWithSynonyms(new Set(tokenize(sig.text)));
      if (!sigTokens.size) continue;
      let shared = 0;
      for (const t of sigTokens) if (haystackTokens.has(t)) shared++;
      // T1 — min-denominator instead of /sigTokens.size. Previously a
      // 12-token caption with 3 shared tokens scored 3/12 = 0.25 even
      // when all three ("marine layer jacket") uniquely identified the
      // product. Using min(signal, haystack) removes the "long caption"
      // penalty while keeping short-signal short-haystack calibration.
      const denom = Math.min(sigTokens.size, haystackTokens.size);
      const overlap = denom > 0 ? shared / denom : 0;
      totalWeight   += sig.weight;
      matchedWeight += sig.weight * overlap;
      if (shared > 0) matchedSrcs.add(sig.src);
    }
    if (!totalWeight) continue;
    let textScore = matchedWeight / totalWeight;

    // T2 — category boost raised 0.10 → SKU_TEXT_CATEGORY_BOOST
    // (default 0.20). Category is a strong signal on its own; the
    // prior 0.10 was too small to move a mid-tier match across the
    // floor.
    if (cat && row.category) {
      const rc = String(row.category).toLowerCase().trim();
      if (rc === cat || rc.includes(cat) || cat.includes(rc)) {
        textScore = Math.min(1, textScore + SKU_TEXT_CATEGORY_BOOST);
      }
    }

    // T1/T2 — floor lowered 0.30 → SKU_TEXT_SCORE_FLOOR (default 0.25)
    // now that scoring is calibrated better (min-denominator +
    // synonyms). Env-tunable.
    if (textScore >= SKU_TEXT_SCORE_FLOOR) {
      scored.push({
        product:     row,
        textScore,
        reasoning:   `weighted token overlap (${matchedSrcs.size} signal type(s) hit: ${[...matchedSrcs].join(', ')})`,
        signalsUsed: [...matchedSrcs]
      });
    }
  }

  // ── T3 — semantic embedding tier ─────────────────────────────────
  // Token overlap misses paraphrases ("sweater" ↔ "pullover" beyond
  // the T2 synonym list, "denim" ↔ "raw indigo canvas", etc.). We
  // fetch (or reuse cached) title embeddings for every candidate row,
  // score the signal blob against each, and take max(textScore,
  // embScore * SKU_TEXT_EMBEDDING_WEIGHT). Bounded — the query is
  // limited to at most SKU_TEXT_EMBEDDING_TOPN rows above a
  // SKU_TEXT_EMBEDDING_FLOOR similarity, and cached embeddings are
  // written back to CatalogProduct.titleEmbedding so we pay per-SKU
  // once. Kill switch CATALOG_TEXT_EMBEDDING_ENABLED (default off
  // until measured live).
  if (textEmbedding.isEnabled()) {
    try {
      const EMBEDDING_TOPN     = Math.max(5, parseInt(process.env.SKU_TEXT_EMBEDDING_TOPN, 10) || 30);
      const EMBEDDING_FLOOR    = Math.max(0.30, Math.min(0.95, parseFloat(process.env.SKU_TEXT_EMBEDDING_FLOOR) || 0.55));
      const EMBEDDING_WEIGHT   = Math.max(0.10, Math.min(1.0, parseFloat(process.env.SKU_TEXT_EMBEDDING_WEIGHT) || 0.85));

      // Signal blob: concatenate all non-empty signals into one query
      // string. Weighted priority is already encoded via the token
      // scorer — for the semantic pass we treat the signals as one
      // paragraph, since the embedding model already handles internal
      // token weighting. Skip when there's no useful signal.
      const signalBlob = signals.map(s => String(s.text || '').trim()).filter(Boolean).join(' \n ').trim();
      if (signalBlob) {
        // Which rows need a fresh embedding? Only compute for rows
        // that are candidates or plausible candidates — cap at
        // EMBEDDING_TOPN to bound spend. Prefer rows that already
        // have SOME token overlap (any matchedSrcs) before rows with
        // zero token overlap; falling back to the first N when all
        // are zero-overlap.
        const priorityRows = rows.slice(0, EMBEDDING_TOPN);
        const needFetch = [];
        const cached = new Map(); // rowId → embedding vector
        for (const r of priorityRows) {
          const embSource = `${r.title || ''} ${r.description || ''}`.slice(0, 4000);
          const wantDigest = textEmbedding.digestOf(embSource);
          if (r.titleEmbedding && r.titleEmbeddingSource === wantDigest) {
            cached.set(String(r._id), r.titleEmbedding);
          } else {
            needFetch.push({ row: r, embSource, digest: wantDigest });
          }
        }

        // One embedding call for the signal + one for every stale row.
        const inputs = [signalBlob, ...needFetch.map(n => n.embSource)];
        const embRes = await textEmbedding.embed(
          { service: 'productMatchService', purposeTag: 'text-catalog-match' },
          inputs
        );
        const vectors = embRes.embeddings || [];
        const signalVec = vectors[0];
        if (signalVec) {
          // Persist the fresh row embeddings back to Mongo — best-effort,
          // non-blocking for the match itself.
          if (needFetch.length) {
            const now = new Date();
            const model = embRes.model;
            const bulk = needFetch.map((n, i) => {
              const vec = vectors[i + 1];
              cached.set(String(n.row._id), vec);
              return {
                updateOne: {
                  filter: { _id: n.row._id },
                  update: { $set: {
                    titleEmbedding:       vec,
                    titleEmbeddingModel:  model,
                    titleEmbeddingSource: n.digest,
                    titleEmbeddingAt:     now
                  } }
                }
              };
            }).filter(op => Array.isArray(op.updateOne.update.$set.titleEmbedding));
            if (bulk.length) {
              CatalogProduct.bulkWrite(bulk).catch(err =>
                console.warn(`   ⚠️  titleEmbedding bulk persist failed: ${err.message}`));
            }
          }

          // Score every priority row and merge into `scored`.
          const alreadyScoredIds = new Set(scored.map(s => String(s.product._id)));
          for (const r of priorityRows) {
            const vec = cached.get(String(r._id));
            if (!vec) continue;
            const sim = textEmbedding.cosine(signalVec, vec);
            if (sim < EMBEDDING_FLOOR) continue;
            const embScore = Math.min(1, Math.max(0, sim * EMBEDDING_WEIGHT));
            // If already scored via tokens, upgrade its score to max
            // of the two; otherwise add it as a semantic-only match.
            const existing = scored.find(s => String(s.product._id) === String(r._id));
            if (existing) {
              if (embScore > existing.textScore) {
                existing.textScore = embScore;
                existing.reasoning = `${existing.reasoning}; semantic sim=${sim.toFixed(2)}`;
                if (!existing.signalsUsed.includes('embedding')) existing.signalsUsed.push('embedding');
              }
            } else if (embScore >= SKU_TEXT_SCORE_FLOOR) {
              scored.push({
                product:     r,
                textScore:   embScore,
                reasoning:   `semantic sim=${sim.toFixed(2)} (no token overlap)`,
                signalsUsed: ['embedding']
              });
              alreadyScoredIds.add(String(r._id));
            }
          }
        }
      }
    } catch (err) {
      console.warn(`   ⚠️  T3 embedding tier failed (falling back to token-only): ${err.message}`);
    }
  }

  return scored.sort((a, b) => b.textScore - a.textScore).slice(0, topK);
}

function escapeRegex(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Phase 2b — always-create CatalogProduct for non-catalog confident matches ──
//
// Called from enrichOneMatchInPlace. When a confident product_match arrives
// without an existing catalogProductId (i.e. it came through the per-product
// reasoner path or the legacy scene-level path), find-or-create a
// CatalogProduct row so all product data (description, price, reviews, etc.)
// has a single home — and so subsequent matches on the same SKU hit the
// catalog directly.
//
// Brand toggle Brand.uploadSettings.autoCreateFromDetect controls DRAFT
// STATE only (true → not draft, immediately visible; false → draft, queued
// for user review). The row is created either way.
//
// Identity rules — try to find an existing row before creating:
//   1. Exact (brandId, externalId='detect:<mediaId>:<slug>') match
//   2. Exact (brandId, title-normalized, brand-normalized) match — covers
//      the case where the SAME SKU was detected on a previous Media
//   3. If neither: create a new row, source='detect-identified'
//
// Brand-mismatch guard: if identification.brand is set and doesn't match
// the active brand, skip creation entirely. Competitor products don't
// belong in the active brand's catalog.
async function ensureCatalogProductForMatch(match, ctx) {
  const ident = match.identification;
  if (!ident?.productName) return null;
  if (!ctx.brandId) return null;

  const activeBrand = ctx.brand;
  const identBrand  = ident.brand;
  const slug = slugify(ident.productName);
  if (!slug) return null;
  const detectExternalId = `detect:${ctx.mediaId || 'unknown'}:${slug}`;

  // 1. Exact externalId match — runs BEFORE brand-mismatch guard so a row
  //    we created on a prior run still resolves (the guard only governs
  //    NEW row creation, not FK reuse for already-linked products).
  let existing = await CatalogProduct.findOne({
    brandId:    ctx.brandId,
    externalId: detectExternalId
  }).select('_id source').lean();
  if (existing) {
    console.log(`   · ensureCatalogProduct[${match.productIndex || 'primary'}]: existing row by externalId (source=${existing.source}) → ${existing._id}`);
    return existing._id;
  }

  // 2. Normalized-title match (same SKU, ignoring promo cruft, case,
  // separator variants). Replaces the previous exact-regex match which
  // missed real synced rows like "Hot Crispy Oil - Original Subscribe
  // and Save 30% Off applied" when Gemini returned "Hot Crispy Oil -
  // Original". No brand filter at this step — for multi-brand resellers
  // (marketplaces), the identification's brand legitimately differs
  // from the active brand.
  const normalizedQuery = normalizeTitle(ident.productName);
  if (normalizedQuery) {
    existing = await CatalogProduct.findOne({
      brandId:         ctx.brandId,
      draft:           { $ne: true },
      normalizedTitle: normalizedQuery
    }).select('_id source title').lean();
    if (existing) {
      console.log(`   · ensureCatalogProduct[${match.productIndex || 'primary'}]: existing row by normalizedTitle (source=${existing.source}) → ${existing._id} "${existing.title}"`);
      return existing._id;
    }
  }

  // 2b. Subset title fallback — when the Gemini-returned name is a
  // truncated or verbose variant of a synced row (e.g. "Hot Crispy
  // Oil - Original Hot Chili Oil" vs synced "Hot Crispy Oil -
  // Original"). Requires score = 1.0, which by the definition
  //   score = shared / min(|tokens(a)|, |tokens(b)|)
  // means every token of the shorter side appears in the longer side.
  // This is strict subset semantics — neither side has unique
  // distinguishing tokens — so we correctly:
  //   accept: "Hot Crispy Oil Original" → twin (subset, same SKU)
  //   reject: "Hot Crispy Oil SMOKEY"   → "...Original" (both have
  //           unique variant tokens, competing SKUs)
  // Plus a ≥3 shared-tokens floor so 2-token matches don't sneak by.
  if (normalizedQuery) {
    // Include detect-identified rows too — previously they were excluded
    // because the intent was to "prefer synced rows", but the side-effect
    // was that the same detect-identified product never got reused: each
    // UGC matching "Hot Crispy Oil" failed to find the existing detect
    // row and created another one. Inflated detect-identified counts
    // dramatically (one brand had 16 detect rows for ~5 logical
    // products). The PREFERENCE for synced rows is now expressed in the
    // tiebreak below instead of by exclusion.
    const candidates = await CatalogProduct.find({
      brandId: ctx.brandId,
      draft:   { $ne: true }
    }).select('_id title source normalizedTitle').lean();

    let best = null;
    for (const row of candidates) {
      const { score, shared } = titleSimilarity(row.normalizedTitle || row.title, ident.productName);
      if (shared < 3 || score < 1.0) continue;
      if (!best) { best = { row, score, shared }; continue; }
      // Tiebreak: (1) more shared tokens wins, (2) synced rows preferred
      // over detect-identified at equal shared count.
      const isSynced  = (r) => r.source !== 'detect-identified';
      if (shared > best.shared) best = { row, score, shared };
      else if (shared === best.shared && isSynced(row) && !isSynced(best.row)) {
        best = { row, score, shared };
      }
    }
    if (best) {
      console.log(`   · ensureCatalogProduct[${match.productIndex || 'primary'}]: subset title match score=${best.score.toFixed(2)} shared=${best.shared} (source=${best.row.source}) → ${best.row._id} "${best.row.title}"`);
      return best.row._id;
    }
  }

  // 2c. D1 — token-Jaccard fuzzy tier. Measured 2026-08-13: only 4/31
  // product_match outcomes linked to a catalog row (13%). The remaining
  // 87% had identify.productName that didn't exactly OR subset-match any
  // catalog title (marketing verbiage on one side, SKU code on the other,
  // etc.). Fuzzy overlap catches the middle band.
  //
  // Guardrails against catalog pollution:
  //   • brandsMatchLoose required — competitor titles won't link into
  //     this brand's catalog even if tokens overlap
  //   • score ≥ SKU_LINK_FUZZY_MIN_SCORE (default 0.6) — 60% of the
  //     shorter side's tokens must appear on the longer side
  //   • shared ≥ 3 — two-token accidents like "denim jacket" can't win
  //   • synced rows preferred over detect-identified on tie
  //
  // D2 tiebreak: when multiple fuzzy candidates score within
  // SKU_LINK_FUZZY_TIE_BAND of the leader, use the pre-computed visual
  // score on match.query.productCrop.croppedImageUrl vs. candidate hero
  // image as tiebreaker. Bounded — only fires on ties, capped at
  // SKU_LINK_FUZZY_VISUAL_MAX candidates.
  const FUZZY_MIN_SCORE  = Math.max(0.3, Math.min(1, parseFloat(process.env.SKU_LINK_FUZZY_MIN_SCORE) || 0.6));
  const FUZZY_TIE_BAND   = Math.max(0.01, Math.min(0.5, parseFloat(process.env.SKU_LINK_FUZZY_TIE_BAND) || 0.1));
  const FUZZY_VISUAL_MAX = Math.max(2, parseInt(process.env.SKU_LINK_FUZZY_VISUAL_MAX, 10) || 4);
  const FUZZY_ENABLED    = process.env.SKU_LINK_FUZZY_ENABLED !== 'false';
  const brandOk          = !identBrand || !activeBrand || brandsMatchLoose(identBrand, activeBrand);
  if (FUZZY_ENABLED && normalizedQuery && brandOk) {
    const candidates = await CatalogProduct.find({
      brandId: ctx.brandId,
      draft:   { $ne: true }
    }).select('_id title source normalizedTitle imageUrl').lean();

    const scored = [];
    for (const row of candidates) {
      const { score, shared } = titleSimilarity(row.normalizedTitle || row.title, ident.productName);
      if (shared < 3 || score < FUZZY_MIN_SCORE || score >= 1.0) continue;   // subset tier already caught score=1
      scored.push({ row, score, shared });
    }
    if (scored.length) {
      scored.sort((a, b) => (b.score - a.score) || (b.shared - a.shared));
      const leader = scored[0];
      const tieBand = scored.filter(s => (leader.score - s.score) <= FUZZY_TIE_BAND);

      let picked = leader;
      let tieBreak = null;
      if (tieBand.length > 1) {
        // D2 — visual tiebreak. Use the refined crop URL threaded through
        // by buildPerProductProviderMatchRecord (match.query.productCrop
        // .croppedImageUrl). Bounded; degrades silently to token-tiebreak
        // on any visual failure.
        const cropUrl = match.query?.productCrop?.croppedImageUrl;
        if (cropUrl) {
          const pool = tieBand.slice(0, FUZZY_VISUAL_MAX);
          try {
            const visuals = await Promise.all(pool.map(s =>
              compareUgcCropToCatalogProduct(cropUrl, s.row)
                .catch(err => {
                  console.warn(`   ⚠️  D2 visual tiebreak threw: ${err.message}`);
                  return null;
                })
            ));
            let bestV = null;
            for (let i = 0; i < pool.length; i++) {
              const v = visuals[i];
              const vs = v?.isMatch ? Number(v.score || 0) : 0;
              if (vs > 0 && (!bestV || vs > bestV.vs)) bestV = { s: pool[i], vs };
            }
            if (bestV) {
              picked = bestV.s;
              tieBreak = `visual=${bestV.vs.toFixed(2)}`;
            }
          } catch (err) {
            console.warn(`   ⚠️  D2 tiebreak pool failed: ${err.message}`);
          }
        }
        // Fallback tiebreak: prefer synced rows over detect-identified.
        if (!tieBreak) {
          const isSynced = (r) => r.source !== 'detect-identified';
          const synced = tieBand.find(s => isSynced(s.row));
          if (synced) { picked = synced; tieBreak = 'synced-preferred'; }
        }
      }

      console.log(`   · ensureCatalogProduct[${match.productIndex || 'primary'}]: fuzzy title match score=${picked.score.toFixed(2)} shared=${picked.shared} pool=${scored.length}${tieBreak ? ` tiebreak=${tieBreak}` : ''} (source=${picked.row.source}) → ${picked.row._id} "${picked.row.title}"`);
      return picked.row._id;
    }
  }

  // Brand-mismatch guard — gates NEW row creation only. Existing rows above
  // are returned regardless so FK propagation works on subsequent runs.
  if (identBrand && activeBrand && !brandsMatchLoose(identBrand, activeBrand)) {
    console.log(`   · ensureCatalogProduct[${match.productIndex || 'primary'}]: brand mismatch (${identBrand} ≠ ${activeBrand}) — skipping creation (competitor)`);
    return null;
  }

  // 3. Create a new detect-identified row. Draft state is gated by the
  // brand toggle: opted-in → not a draft (auto-promoted); opted-out → draft.
  const brand = await Brand.findById(ctx.brandId).select('uploadSettings').lean();
  const isDraft = !brand?.uploadSettings?.autoCreateFromDetect;

  const cp = await CatalogProduct.create({
    advertiserId:        ctx.advertiserId,
    brandId:             ctx.brandId,
    source:              'detect-identified',
    externalId:          detectExternalId,
    draft:               isDraft,
    title:               ident.productName,
    description:         ident.details?.description || null,
    brand:               identBrand || activeBrand || null,
    category:            ident.details?.category || match.query?.productCrop?.category || null,
    price:               ident.details?.price?.value ?? null,
    currency:            ident.details?.price?.currency || null,
    imageUrl:            ident.details?.imageUrl || null,
    productUrl:          ident.details?.url || null,
    detectedFromMediaId: ctx.mediaId || null,
    categoryRef:         match.categoryId || null,        // populated when category tree resolved
    firstSeenAt:         new Date(),
    lastSyncedAt:        new Date()
  });
  console.log(`📝 catalog row auto-created[${match.productIndex || 'primary'}]: "${ident.productName}" (draft=${isDraft}) → ${cp._id}`);

  // Fire-and-forget: materialize a source: 'catalog-product' Media doc +
  // crops + detection so the canonical input's productHero slot has
  // real per-ratio crop URLs on the next render. Without this the
  // layoutInputService.loadContext band-aid (synthesizes productHero
  // from CatalogProduct.imageUrl directly) is the only thing the ad
  // pipeline sees — works, but loses the cropping pass. Skipped when
  // imageUrl is missing (enqueueProductDetect's own first check).
  if (cp.imageUrl) {
    setImmediate(() => {
      const detectSvc = require('./catalogProductDetectService');
      detectSvc.enqueueProductDetect(cp)
        .then(out => {
          if (out?.skipped) return;
          // Media existence first — enqueued.hero is null when the Media
          // materialized but no DetectRun was created, and logging '-' there
          // hid exactly the state this diagnostic exists to surface.
          const heroId = out?.heroMediaId || out?.enqueued?.hero?.mediaId || '-';
          console.log(`   · ensureCatalogProduct[${cp._id}]: catalog-product detect enqueued (heroMedia=${heroId})`);
        })
        .catch(err => {
          console.warn(`   ⚠️  ensureCatalogProduct[${cp._id}]: catalog-product detect enqueue failed: ${err.message}`);
        });
    });
  }

  return cp._id;
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

// ── Phase 1.7 — per-refined-product catalog-first match ──
//
// For ONE refined product:
//   1. Text catalog query (scoped to refined.category when set)
//   2. Visual catalog match (Gemini Vision) on the top-K text candidates
//   3. combined = max(textScore, visualScore)
//   4. Return the best (highest combined) candidate + scores
//
// Returns:
//   { combinedScore, textScore, visualScore, catalogMatch, visualResult }
// where catalogMatch is the top-K-filtered single best per-refined match
// (or null when no candidate cleared the floor).
// Per-product cap on how many catalog-side images we compare the UGC
// refined crop against. 1 (default) = hero refined crop only or
// product.imageUrl fallback — cheapest path, ~3× fewer Gemini calls
// per match. Bump to 5+ for the multi-image coverage that catches
// alt-angle matches (UGC shows back of product, hero shows front,
// only an alt crop matches). Env-tunable so cost/precision can be
// dialed without a deploy.
const CATALOG_VISUAL_MATCH_MAX_IMAGES = Math.max(1, parseInt(process.env.CATALOG_VISUAL_MATCH_MAX_IMAGES, 10) || 1);

// Compare a UGC refined crop against up to CATALOG_VISUAL_MATCH_MAX_IMAGES
// visual representations of a catalog product. Targets are ordered
// hero-refined-crops first, then alt-refined-crops, then the canonical
// product.imageUrl as a last-resort fallback. The cap is applied
// AFTER ordering so top-1 mode always picks the strongest signal
// available. Returns the best { isMatch, score, reasoning,
// matchedAgainst } across the chosen targets.
async function compareUgcCropToCatalogProduct(ugcCropImageUrl, product) {
  if (!ugcCropImageUrl || !product) return null;

  // Refined crops first (tight YOLO bbox of the product, less
  // background noise than the raw Shopify imageUrl). Hero-first
  // ordering is applied inside loadCatalogRefinedCropUrls.
  const catalogCrops = await loadCatalogRefinedCropUrls(product._id);
  const ordered = [];
  for (const url of catalogCrops) {
    if (!ordered.includes(url)) ordered.push(url);
  }
  if (product.imageUrl && !ordered.includes(product.imageUrl)) {
    ordered.push(product.imageUrl);
  }
  const targets = ordered.slice(0, CATALOG_VISUAL_MATCH_MAX_IMAGES);
  if (!targets.length) return null;

  const results = await Promise.all(targets.map(async (url) => {
    const r = await visualCatalogMatch.compareCropToCandidate({
      cropImageUrl: ugcCropImageUrl,
      candidate:    { imageUrl: url, title: product.title }
    });
    return r ? { ...r, matchedAgainst: url } : null;
  }));

  let best = null;
  for (const r of results) {
    if (!r) continue;
    if (!best || (r.score || 0) > (best.score || 0)) best = r;
  }
  return best;
}

// Pull the top-1 highest-confidence refined YOLO crop URL from EACH
// catalog-product Media tied to the given CatalogProduct, ordered
// HERO FIRST then alts. Hero-first ordering matters for the top-1
// visual-match path — picking the hero's canonical crop over an
// arbitrary alt's gives the strongest single comparison signal.
// Returns [] when no catalog Media exists yet or none have refined crops.
async function loadCatalogRefinedCropUrls(catalogProductId) {
  if (!catalogProductId) return [];
  // metadata.catalogProductId stored as ObjectId; string callers
  // (e.g. from a serialized PMA query) need a cast or the find misses.
  const productOid = mongoose.isValidObjectId(catalogProductId)
    ? new mongoose.Types.ObjectId(String(catalogProductId))
    : catalogProductId;
  const medias = await Media.find(
    { source: 'catalog-product', 'metadata.catalogProductId': productOid },
    { latestArtifacts: 1, 'metadata.imageRole': 1 }
  ).lean();
  if (!medias.length) return [];
  // Sort hero-first; preserve insertion order among alts.
  medias.sort((a, b) => {
    const aHero = a.metadata?.imageRole === 'hero' ? 0 : 1;
    const bHero = b.metadata?.imageRole === 'hero' ? 0 : 1;
    return aHero - bHero;
  });

  // Bulk-load all detections so the per-Media ordering is preserved
  // when we map back. find() with $in doesn't guarantee order, so
  // we index by id and walk the sorted media list.
  const detectionIds = medias.map(m => m.latestArtifacts?.detection).filter(Boolean);
  if (!detectionIds.length) return [];
  const detections = await DetectionArtifact.find(
    { _id: { $in: detectionIds } },
    { refinedProducts: 1 }
  ).lean();
  const detById = new Map(detections.map(d => [String(d._id), d]));

  const urls = [];
  for (const m of medias) {
    const detId = m.latestArtifacts?.detection ? String(m.latestArtifacts.detection) : null;
    const det = detId ? detById.get(detId) : null;
    if (!det) continue;
    const top = (det.refinedProducts || [])
      .filter(rp => rp.croppedImageUrl)
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];
    if (top?.croppedImageUrl) urls.push(top.croppedImageUrl);
  }
  return urls;
}

// C1 — visual-only fallback pool size when text signals are absent.
// Measured 2026-08-13: 100% of catalog match artifacts had NULL
// catalogVisualScore because the visual matcher was gated behind text
// candidates, and UGC lifestyle shots have zero OCR text and rarely
// contain SKU tokens in captions. Bounded top-K keeps Gemini Vision
// spend proportional to run count (each call ~$0.0015; K=8 × ~20 UGC
// runs/day ≈ $0.24/day).
const CATALOG_VISUAL_ONLY_TOPK = Math.max(1, parseInt(process.env.CATALOG_VISUAL_ONLY_TOPK, 10) || 8);

// Pull up to topK candidate CatalogProducts for visual scoring when
// text search returned nothing. Category-scoped when we have a refined
// category enum; falls back to brand-wide. Deliberately non-fatal —
// any failure returns [] and the caller degrades to the old zero-return.
async function fetchVisualOnlyCandidates({ brandId, category, topK }) {
  if (!brandId) return [];
  const baseQuery = {
    brandId,
    draft:            { $ne: true },
    isPrimaryVariant: { $ne: false },
    imageUrl:         { $exists: true, $ne: '' }
  };
  try {
    if (category) {
      const subtreeIds = await getCoarseSubtreeIds({ brandId, enumCategory: category });
      if (subtreeIds.length) {
        const scoped = await CatalogProduct
          .find({ ...baseQuery, categoryRef: { $in: subtreeIds } })
          .limit(topK)
          .select('_id title imageUrl category brand')
          .lean();
        if (scoped.length) return scoped;
      }
    }
    return await CatalogProduct
      .find(baseQuery)
      .limit(topK)
      .select('_id title imageUrl category brand')
      .lean();
  } catch (err) {
    console.warn(`   ⚠️  fetchVisualOnlyCandidates failed: ${err.message}`);
    return [];
  }
}

async function catalogFirstMatchOneRefined(refined, { brandId, brandName = null, caption, textDetected, comments }) {
  if (!brandId || !refined) return { combinedScore: 0, catalogMatch: null, visualResult: null };

  const textCandidates = await findCatalogMatchByText({
    brandId,
    brandName,
    category: refined.category || null,
    caption,
    textDetected,
    comments,
    topK: 3
  });

  // C1 — visual-only fallback when text finds nothing. Previously
  // returned zero here, which is why every catalog match artifact in
  // the 2026-08-13 sample had NULL catalogVisualScore. Falls back to a
  // category-scoped candidate pull and lets Gemini Vision arbitrate on
  // the refined crop directly.
  if (!textCandidates.length) {
    if (!refined.croppedImageUrl) {
      return { combinedScore: 0, catalogMatch: null, visualResult: null };
    }
    const visualCandidates = await fetchVisualOnlyCandidates({
      brandId,
      category: refined.category || null,
      topK:     CATALOG_VISUAL_ONLY_TOPK
    });
    if (!visualCandidates.length) {
      return { combinedScore: 0, catalogMatch: null, visualResult: null };
    }
    const visualResults = await Promise.all(visualCandidates.map(p =>
      compareUgcCropToCatalogProduct(refined.croppedImageUrl, p)
        .catch(err => {
          console.warn(`   ⚠️  visualCatalogMatch (fallback) threw: ${err.message}`);
          return null;
        })
    ));
    let bestV = null;
    for (let i = 0; i < visualCandidates.length; i++) {
      const p = visualCandidates[i];
      const v = visualResults[i];
      const score = v?.isMatch ? Number(v.score || 0) : 0;
      if (!bestV || score > bestV.combinedScore) {
        bestV = {
          catalogMatch:  { product: p, textScore: 0, matchedTerm: null, matchedSrcs: [] },
          visualResult:  v,
          textScore:     0,
          visualScore:   score,
          combinedScore: score
        };
      }
    }
    if (!bestV || bestV.combinedScore === 0) {
      return { combinedScore: 0, catalogMatch: null, visualResult: null };
    }
    console.log(`   · catalog-first[${refined.id}] (visual-only fallback): visual=${bestV.visualScore.toFixed(2)} pool=${visualCandidates.length} → "${bestV.catalogMatch.product.title}"`);
    return bestV;
  }

  // Visual scoring per text candidate: compare the UGC refined crop
  // against the candidate's hero imageUrl PLUS any per-image refined
  // crops persisted by the catalog-product detect pipeline. Best score
  // across all catalog-side images wins.
  const visualResults = await Promise.all(textCandidates.map(c =>
    compareUgcCropToCatalogProduct(refined.croppedImageUrl, c.product)
      .catch(err => {
        console.warn(`   ⚠️  visualCatalogMatch threw: ${err.message}`);
        return null;
      })
  ));

  let best = null;
  for (let i = 0; i < textCandidates.length; i++) {
    const cand = textCandidates[i];
    const visual = visualResults[i];
    const visualScore = visual?.isMatch ? Number(visual.score || 0) : 0;
    const combined = Math.max(cand.textScore, visualScore);
    if (!best || combined > best.combinedScore) {
      best = {
        catalogMatch: cand,
        visualResult: visual,
        textScore:    cand.textScore,
        visualScore,
        combinedScore: combined
      };
    }
  }

  if (!best) return { combinedScore: 0, catalogMatch: null, visualResult: null };
  console.log(`   · catalog-first[${refined.id}]: text=${best.textScore.toFixed(2)} visual=${best.visualScore.toFixed(2)} combined=${best.combinedScore.toFixed(2)} → "${best.catalogMatch.product.title}"`);
  return best;
}

// Cache-aware product-reviews resolver:
//   1. Read CatalogProduct.productReviews.
//   2. If fresh (< 30 days), return immediately — caller surfaces on artifact.
//   3. If stale or missing, kick off a fire-and-forget Gemini lookup and
//      return null. The next match on this SKU picks up the cached value.
//
// Fire-and-forget on miss means the current detect run finishes fast;
// review quotes appear on subsequent runs / re-renders. Awaiting the
// 10-15s Gemini call here would slow every detect that hits a fresh
// catalog SKU.
async function maybeFetchProductReviewsCached({ catalogProductId, productName, brandName, productUrl }) {
  if (!catalogProductId || !productName) return null;

  // Pull dedup keys (gtin/mpn) so we can look up siblings — V3 #2.
  const row = await CatalogProduct.findById(catalogProductId)
    .select('productReviews title gtin mpn brandId').lean();   // brandId: cost-ledger linkage
  if (!row) return null;

  // 1. Cache hit on this row?
  const reviews = row.productReviews;
  if (reviews?.quotes?.length) {
    const fetchedAt = reviews.fetchedAt ? new Date(reviews.fetchedAt).getTime() : 0;
    const ageMs = Date.now() - fetchedAt;
    if (ageMs < PRODUCT_REVIEWS_TTL_MS) {
      console.log(`   · product-reviews: cache hit for "${row.title}" (age ${Math.round(ageMs / 86400000)}d)`);
      return reviews;
    }
    console.log(`   · product-reviews: cache stale for "${row.title}" (age ${Math.round(ageMs / 86400000)}d > 30d), checking siblings`);
  } else {
    console.log(`   · product-reviews: no cache for "${row.title}", checking siblings`);
  }

  // 2. Sibling hit — V3 #2 dedup. Same SKU sold under multiple
  //    advertiser accounts (agencies, parent/child brands) shares
  //    review data. Reviews are public (Trustpilot / Reddit / etc.)
  //    so cross-tenant copy is fine. Search by gtin first (most
  //    reliable), fall back to mpn.
  if (row.gtin || row.mpn) {
    const siblingFilter = { _id: { $ne: catalogProductId } };
    if (row.gtin)      siblingFilter.gtin = row.gtin;
    else if (row.mpn)  siblingFilter.mpn  = row.mpn;
    const sibling = await CatalogProduct.findOne(siblingFilter)
      .select('productReviews title')
      .sort({ 'productReviews.fetchedAt': -1 })
      .lean();
    if (sibling?.productReviews?.quotes?.length) {
      const sFetchedAt = sibling.productReviews.fetchedAt
        ? new Date(sibling.productReviews.fetchedAt).getTime() : 0;
      const sAgeMs = Date.now() - sFetchedAt;
      if (sAgeMs < PRODUCT_REVIEWS_TTL_MS) {
        const dedupKey = row.gtin ? `gtin=${row.gtin}` : `mpn=${row.mpn}`;
        console.log(`   · product-reviews: sibling hit (${dedupKey}, age ${Math.round(sAgeMs / 86400000)}d) — copying from "${sibling.title}"`);
        // Copy synchronously since we already have the data in hand.
        try {
          await CatalogProduct.updateOne(
            { _id: catalogProductId },
            { $set: { productReviews: sibling.productReviews } }
          );
        } catch (err) {
          console.warn(`   ⚠️  sibling-copy write failed for "${row.title}": ${err.message}`);
        }
        return sibling.productReviews;
      }
    }
  }

  // 3. Fire-and-forget Gemini fetch — don't block detect.
  geminiSearch.lookupProductReviews({
    productName, brandName, productUrl,
    // Cost-ledger linkage. This is a fire-and-forget billable call, which is
    // exactly the kind that goes unnoticed without a row to point at.
    brandId:   row.brandId || null,
    productId: catalogProductId
  })
    .then(async (fresh) => {
      if (!fresh || !Array.isArray(fresh.quotes) || fresh.quotes.length === 0) return;
      try {
        // GUARD: this is LLM-derived, web-wide sentiment. It must never
        // replace a snapshot scraped verbatim from the merchant's own review
        // app — the filter makes the write a no-op once real reviews exist,
        // even if this background fetch lands after a later scrape.
        await CatalogProduct.updateOne(
          {
            _id: catalogProductId,
            $or: [
              { 'productReviews.quotesOrigin': { $ne: 'scraped' } },
              { 'productReviews.quotes': { $size: 0 } },
              { 'productReviews.quotes': { $exists: false } }
            ]
          },
          { $set: { productReviews: Object.assign({}, fresh, {
            fetchedAt: new Date(),
            quotesOrigin: 'llm-web'
          }) } }
        );
        console.log(`   · product-reviews: cached on CatalogProduct "${row.title}"`);
      } catch (err) {
        console.warn(`   ⚠️  product-reviews cache write failed for "${row.title}": ${err.message}`);
      }
    })
    .catch(err => console.warn(`   ⚠️  product-reviews lookup failed for "${row.title}": ${err.message}`));

  return null;
}

// English stopwords + filler that pollutes overlap scoring otherwise.
const CATALOG_STOPWORDS = new Set([
  'the','and','for','with','from','that','this','these','those','your','their',
  'are','was','were','has','have','had','will','can','more','than','about','our',
  'all','any','its','too','use','via','very','just','also','most','some','only'
]);
function tokenize(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !CATALOG_STOPWORDS.has(t));
}

module.exports = {
  findProductMatches,         // legacy single-match path (used internally as scene-level fallback)
  findPerProductMatches,      // Phase 1.7 per-refined-product orchestrator
  findCatalogMatchByText,     // Phase 1.7 text-only catalog scorer with category scoping
  catalogFirstMatchOneRefined, // Phase 1.7 per-product catalog-first (text + visual)
  maybeFetchProductReviewsCached // cache-aware Gemini grounded-search reviews fetch; called by catalogProductEnrichmentService on sync
};
