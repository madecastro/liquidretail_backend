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

  // ── DECISION TREE ─────────────────────────────────────────────────
  const decision = await runDecisionTree({
    yoloIdentifications,
    geminiIdentification: identification,
    brand, brandUrl, category
  });
  const { outcome, outcomeReasoning, winner } = decision;
  let { brandCategory, brandReviews } = decision;

  // ── Post-decision enrichment per outcome ──────────────────────────
  // Pick the best YOLO product up here so winner='yolo' enrichment can
  // use it without re-running the filter.
  const yoloProductIds = (yoloIdentifications || [])
    .map(d => d?.identification)
    .filter(id => id && (id.confidence || 0) >= PRODUCT_FLOOR
                 && typeof id.label === 'string' && id.label.trim().length > 0)
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

  // Brand reviews — only for brand_match outcomes.
  if (outcome === 'brand_match') {
    brandReviews = await tryLookupBrandReviews(brand, brandUrl);
  }

  console.log(`🎯 Match outcome: ${outcome}${winner ? ` (winner=${winner})` : ''} — ${outcomeReasoning}`);

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
    winner,                   // 'yolo' | 'gemini' | 'agree' | null
    brandCategory,            // { breadcrumb, url, confidence } or null
    brandReviews              // { quotes, rating, reviewCount, summary } or null
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

  // YOLO product candidates — must clear floor AND have a label.
  const yoloProductIds = yoloIds
    .filter(id => (id.confidence || 0) >= PRODUCT_FLOOR
                 && typeof id.label === 'string'
                 && id.label.trim().length > 0)
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

module.exports = { findProductMatches };
