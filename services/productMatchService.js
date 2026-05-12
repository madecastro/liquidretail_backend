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
const { normalizeBrandName } = require('../models/Brand');
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
// HIGH_CONFIDENCE — single-source confidence to call a product_match.
// CATEGORY_BAND  — when at least one signal lands in (LOW, HIGH) range
//                 we fall back to product_category.
const PRODUCT_FLOOR    = 0.70;
const HIGH_CONFIDENCE  = 0.80;
const CATEGORY_LOWER   = 0.69;   // > 0.69 (i.e. ≥ 0.70 effectively)
const CATEGORY_UPPER   = 0.79;   // ≤ 0.79

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
// Decision tree:
//   reasoner.certainty ≥ HIGH_CONFIDENCE  → product_match (SKU-level hit)
//   reasoner.certainty in mid AND refined ≥ HIGH_CONFIDENCE
//                                          → product_match using REFINED
//                                            label (broader claim still
//                                            confident; SKU stays as
//                                            secondary evidence)
//   reasoner.certainty in mid              → product_category
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
  if (cleanedIdent?.productName && cert >= HIGH_CONFIDENCE) {
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
  } else if (cleanedIdent?.productName && cert > CATEGORY_LOWER && cert <= CATEGORY_UPPER) {
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

  // Phase 1.7 — per-refined-product catalog-first (text + visual)
  let perRefinedCatalog = [];
  let anyCatalogWinner  = false;
  if (refinedProducts.length && brandId) {
    perRefinedCatalog = await Promise.all(refinedProducts.map(rp =>
      catalogFirstMatchOneRefined(rp, { brandId, caption, textDetected })
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
      // Backfill CatalogProduct.categoryRef + category string when both ends
      // now exist. ensureCatalogProductForMatch runs BEFORE category
      // resolution, so the catalog row was created with the freeform query
      // category (e.g. "apparel"); replace it with the breadcrumb leaf
      // (e.g. "Mens > Tops > Hooded Performance Shirts") now that we have it.
      if (match.catalogProductId && match.categoryId) {
        const breadcrumb = match.brandCategory?.breadcrumb || null;
        await CatalogProduct.updateOne(
          { _id: match.catalogProductId, $or: [{ categoryRef: null }, { categoryRef: { $exists: false } }] },
          { $set: { categoryRef: match.categoryId, ...(breadcrumb ? { category: breadcrumb } : {}) } }
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
  if (shorter.length < 4) return false;
  return longer.startsWith(shorter + ' ');
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
async function tryLookupBrandReviews(brandName, brandUrl) {
  try { return await geminiSearch.lookupBrandReviews({ brandName, brandUrl }); }
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

  // Fresh fetch.
  const fresh = await tryLookupBrandReviews(brandName, brandUrl);
  if (!fresh || !Array.isArray(fresh.quotes) || fresh.quotes.length === 0) return fresh;

  // Write back to the catalog if we have a row to write to.
  if (brandDoc) {
    try {
      brandDoc.brandReviews = Object.assign({}, fresh, { fetchedAt: new Date() });
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
async function findCatalogMatchByText({
  brandId,
  category,                     // optional category filter
  caption,
  textDetected = [],
  comments     = [],
  topK         = 3
}) {
  if (!brandId) return [];

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
    signals.push({ text: String(caption), weight: 0.9, src: 'caption' });
  }
  for (const c of (comments || []).slice(0, 10)) {
    const txt = typeof c === 'string' ? c : c?.text;
    if (typeof txt === 'string' && txt.trim()) {
      signals.push({ text: txt, weight: 0.7, src: 'comment' });
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
  let rows = [];
  if (category) {
    const filtered = await CatalogProduct
      .find({ ...baseQuery, category: { $regex: escapeRegex(category), $options: 'i' } })
      .limit(500)
      .select('title description category brand price currency imageUrl productUrl externalId source')
      .lean();
    if (filtered.length >= 3) {
      rows = filtered;
    } else {
      console.log(`   · catalog text search: only ${filtered.length} category-scoped candidate(s) for "${category}"; broadening to full catalog`);
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
    const haystackTokens = new Set(tokenize(haystack));
    if (!haystackTokens.size) continue;

    let totalWeight = 0, matchedWeight = 0;
    const matchedSrcs = new Set();
    for (const sig of signals) {
      const sigTokens = new Set(tokenize(sig.text));
      if (!sigTokens.size) continue;
      let shared = 0;
      for (const t of sigTokens) if (haystackTokens.has(t)) shared++;
      const overlap = shared / sigTokens.size;
      totalWeight   += sig.weight;
      matchedWeight += sig.weight * overlap;
      if (shared > 0) matchedSrcs.add(sig.src);
    }
    if (!totalWeight) continue;
    let textScore = matchedWeight / totalWeight;

    if (cat && row.category) {
      const rc = String(row.category).toLowerCase().trim();
      if (rc === cat || rc.includes(cat) || cat.includes(rc)) {
        textScore = Math.min(1, textScore + 0.10);
      }
    }

    if (textScore >= 0.30) {
      scored.push({
        product:     row,
        textScore,
        reasoning:   `weighted token overlap (${matchedSrcs.size} signal type(s) hit: ${[...matchedSrcs].join(', ')})`,
        signalsUsed: [...matchedSrcs]
      });
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

  // 2. Title + brand match (same SKU detected on a different Media earlier)
  const titleEsc = escapeRegex(ident.productName.trim());
  const brandEsc = identBrand || activeBrand ? escapeRegex(identBrand || activeBrand) : null;
  const titleQuery = {
    brandId: ctx.brandId,
    draft:   { $ne: true },              // exclude drafts (don't dedupe against incomplete rows)
    title:   { $regex: `^${titleEsc}$`, $options: 'i' }
  };
  if (brandEsc) titleQuery.brand = { $regex: brandEsc, $options: 'i' };
  existing = await CatalogProduct.findOne(titleQuery).select('_id source').lean();
  if (existing) {
    console.log(`   · ensureCatalogProduct[${match.productIndex || 'primary'}]: existing row by title (source=${existing.source}) → ${existing._id}`);
    return existing._id;
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
  const medias = await Media.find(
    { source: 'catalog-product', 'metadata.catalogProductId': catalogProductId },
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

async function catalogFirstMatchOneRefined(refined, { brandId, caption, textDetected, comments }) {
  if (!brandId || !refined) return { combinedScore: 0, catalogMatch: null, visualResult: null };

  const textCandidates = await findCatalogMatchByText({
    brandId,
    category: refined.category || null,
    caption,
    textDetected,
    comments,
    topK: 3
  });
  if (!textCandidates.length) {
    return { combinedScore: 0, catalogMatch: null, visualResult: null };
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
    .select('productReviews title gtin mpn').lean();
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
  geminiSearch.lookupProductReviews({ productName, brandName, productUrl })
    .then(async (fresh) => {
      if (!fresh || !Array.isArray(fresh.quotes) || fresh.quotes.length === 0) return;
      try {
        await CatalogProduct.updateOne(
          { _id: catalogProductId },
          { $set: { productReviews: Object.assign({}, fresh, { fetchedAt: new Date() }) } }
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
  catalogFirstMatchOneRefined // Phase 1.7 per-product catalog-first (text + visual)
};
