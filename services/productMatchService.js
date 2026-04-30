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
const Brand           = require('../models/Brand');
const { normalizeBrandName } = require('../models/Brand');
const CatalogProduct  = require('../models/CatalogProduct');

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
const HIGH_CONFIDENCE  = 0.85;
const CATEGORY_LOWER   = 0.69;   // > 0.69 (i.e. ≥ 0.70 effectively)
const CATEGORY_UPPER   = 0.84;   // ≤ 0.84

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

module.exports = { findProductMatches };
