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
const productDetails = require('./productDetailsService');

const PROVIDERS = [
  geminiSearch,
  googleLens
];

const CONFIDENCE_FLOOR = 0.80;   // below this, fall back to brand-category

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
  const { outcome, outcomeReasoning, brandCategory, brandReviews, winner } = decision;

  // ── Enrichment: only fetch SKU details when we actually have a product ──
  // ('confirmed', 'lookup_from_yolo', 'lookup_from_gemini' all imply a real
  // product. 'category', 'branding', 'do_not_use' don't have a SKU to enrich.)
  const productOutcomes = new Set(['confirmed', 'lookup_from_yolo', 'lookup_from_gemini']);
  if (productOutcomes.has(outcome) && identification?.productName && identification.certainty >= 0.3) {
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

  console.log(`🎯 Match outcome: ${outcome} — ${outcomeReasoning}`);

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
async function runDecisionTree({
  yoloIdentifications,
  geminiIdentification,
  brand,
  brandUrl,
  category
}) {
  // Filter YOLO identifications to those with a meaningful confidence
  // — sub-threshold rogue tags shouldn't trigger multi-brand contention.
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
    return {
      outcome: 'do_not_use',
      outcomeReasoning: `multiple brands detected on the same Media (${[...distinctBrands].join(', ')}); creative would be ambiguous`,
      winner: null,
      brandCategory: null,
      brandReviews: null
    };
  }

  // Pick the highest-confidence YOLO identification (after multi-brand check).
  const yoloTop = yoloIds.slice().sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0] || null;
  const yoloConf   = yoloTop?.confidence || 0;
  const geminiTop  = geminiIdentification || null;
  const geminiConf = geminiTop?.certainty || 0;
  const haveAnyProduct = yoloTop || (geminiTop?.productName);

  // 2. Nothing detected → branding.
  if (!haveAnyProduct) {
    const brandReviews = await tryLookupBrandReviews(brand, brandUrl);
    return {
      outcome: 'branding',
      outcomeReasoning: 'no product identified by either YOLO+GPT or Gemini; treating as brand content',
      winner: null,
      brandCategory: null,
      brandReviews
    };
  }

  // 3. Both agree → confirmed (no extra lookup).
  if (yoloTop && geminiTop?.productName && sameProduct(yoloTop, geminiTop)) {
    return {
      outcome: 'confirmed',
      outcomeReasoning: `YOLO+GPT and Gemini both identified "${geminiTop.productName}"`,
      winner: 'agree',
      brandCategory: null,
      brandReviews: null
    };
  }

  // 4. Low confidence everywhere → fall back to brand category.
  if (Math.max(yoloConf, geminiConf) < CONFIDENCE_FLOOR && yoloTop) {
    const brandCategory = await tryLookupBrandCategoryUrl({
      brandUrl,
      brandName: brand,
      label:    yoloTop.label || yoloTop.description,
      category: yoloTop.category || category
    });
    return {
      outcome: 'category',
      outcomeReasoning: `low confidence (yolo ${(yoloConf*100).toFixed(0)}%, gemini ${(geminiConf*100).toFixed(0)}% — both below ${(CONFIDENCE_FLOOR*100).toFixed(0)}%); falling back to brand collection page`,
      winner: yoloConf >= geminiConf ? 'yolo' : 'gemini',
      brandCategory,
      brandReviews: null
    };
  }

  // 5/6. Confidence threshold met — pick the higher one.
  if (yoloConf >= geminiConf) {
    return {
      outcome: 'lookup_from_yolo',
      outcomeReasoning: `YOLO+GPT (${(yoloConf*100).toFixed(0)}%) identified "${yoloTop.label}" with higher confidence than Gemini search (${(geminiConf*100).toFixed(0)}%)`,
      winner: 'yolo',
      brandCategory: null,
      brandReviews: null
    };
  }
  return {
    outcome: 'lookup_from_gemini',
    outcomeReasoning: `Gemini search (${(geminiConf*100).toFixed(0)}%) identified "${geminiTop.productName}" with higher confidence than YOLO+GPT (${(yoloConf*100).toFixed(0)}%)`,
    winner: 'gemini',
    brandCategory: null,
    brandReviews: null
  };
}

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
