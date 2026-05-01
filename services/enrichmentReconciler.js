// Phase 1.5c — dual-engine enrichment reconciliation.
//
// Takes per-detection products[] from yoloIdentifyService (GPT-4.1) and
// geminiIdentifyService (Gemini Vision) and merges into a unified
// reconciled.products[] list per detection. Updates the legacy
// `det.identification` alias to point at the highest-confidence reconciled
// product (or non-product fallback).
//
// Cross-engine matching key: (normalized brand, label token-overlap ≥ 0.5).
// Same brand AND tokens overlap ≥ 50% → both engines saw the same product
// (agreement). Otherwise products are treated as additive — handles the
// case where one engine identified the shirt and the other identified the
// hat in the same crop (real, distinct products that 1.6 didn't split).
//
// Confidence rules:
//   agree (both engines)  → mean(gpt.conf, gemini.conf) + 0.10 boost
//   gpt-only / gemini-only → original conf × 0.85 (single-engine penalty)
//
// When one engine failed entirely (engines.gemini === null), reconciliation
// is essentially passthrough of the working engine's products with the
// single-engine penalty applied.

// Run reconciliation across an array of detections — mutates each in place.
function reconcileEnrichments(detections) {
  if (!Array.isArray(detections) || !detections.length) return;
  for (const det of detections) {
    reconcileOne(det);
  }
}

function reconcileOne(det) {
  if (!det) return;
  det.engines = det.engines || {};

  const gptProducts    = det.engines.gpt?.products    || [];
  // engines.gemini === null means Gemini call failed entirely (different
  // from { products: [] } which means Gemini saw no products in this crop).
  const geminiUnavail  = det.engines.gemini === null;
  const geminiProducts = det.engines.gemini?.products || [];

  const reconciled = mergeProducts(gptProducts, geminiProducts, geminiUnavail);

  det.engines.reconciled = { products: reconciled };
  det.identification     = aliasFromProducts(reconciled);
}

function mergeProducts(gptProducts, geminiProducts, geminiUnavail) {
  const matched = new Set();         // indices in geminiProducts already merged
  const gptUnmatched = [];            // GPT products not paired in pass 1
  const out = [];

  // ── Pass 1 — strict SKU-level agreement (label-token Jaccard ≥ 0.5) ──
  // Both engines see the SAME product at the SAME specificity. Confidence
  // gets the agreement boost.
  for (const g of gptProducts) {
    let bestIdx = -1;
    let bestOverlap = 0;
    for (let i = 0; i < geminiProducts.length; i++) {
      if (matched.has(i)) continue;
      const gem = geminiProducts[i];
      if (!productsLikelySame(g, gem)) continue;
      const overlap = labelOverlap(g.label, gem.label);
      if (overlap >= 0.5 && overlap > bestOverlap) {
        bestIdx = i;
        bestOverlap = overlap;
      }
    }
    if (bestIdx >= 0) {
      matched.add(bestIdx);
      out.push(buildAgreedProduct(g, geminiProducts[bestIdx]));
    } else {
      gptUnmatched.push(g);
    }
  }

  // ── Pass 2 — category-confirmed agreement ──
  // GPT and Gemini agree on (brand, category) but their LABELS differ in
  // specificity — the classic "GPT says 'fishing shirt', Gemini says
  // 'Aquatek Icon Sunshirt'" case. They're describing the same item at
  // different resolutions; not competing interpretations.
  //
  // Both engines confirm at category level, so NO single-engine penalty.
  // The more specific label becomes primary; the broader label is preserved
  // as `categoryLabel` so Phase 1.7 catalog-first matching can use it as a
  // fallback query when the specific label doesn't catalog-match.
  for (const g of gptUnmatched) {
    let bestIdx = -1;
    let bestConf = 0;
    for (let i = 0; i < geminiProducts.length; i++) {
      if (matched.has(i)) continue;
      if (!sameBrandAndCategory(g, geminiProducts[i])) continue;
      const c = geminiProducts[i].confidence || 0;
      if (c > bestConf) {
        bestIdx = i;
        bestConf = c;
      }
    }
    if (bestIdx >= 0) {
      matched.add(bestIdx);
      out.push(buildCategoryConfirmedProduct(g, geminiProducts[bestIdx]));
    } else if (geminiUnavail) {
      // Gemini didn't run at all — single-engine penalty applies.
      const sg = buildSingleEngineProduct(g, 'gpt-only', 'gemini call unavailable');
      if (sg) out.push(sg);
    } else {
      // Gemini ran but neither matched at SKU level nor at brand+category
      // level — this product is GPT's alone. Penalty stands.
      const sg = buildSingleEngineProduct(g, 'gpt-only', 'GPT identified; Gemini did not corroborate at brand/category');
      if (sg) out.push(sg);
    }
  }

  // ── Pass 3 — Gemini products with no GPT pairing ──
  // Same logic: if GPT had a brand+category match available, pass 2 caught
  // it. Reaching pass 3 means Gemini saw a product GPT didn't — single
  // engine penalty applies.
  for (let i = 0; i < geminiProducts.length; i++) {
    if (matched.has(i)) continue;
    const sg = buildSingleEngineProduct(geminiProducts[i], 'gemini-only', 'Gemini identified; GPT did not corroborate');
    if (sg) out.push(sg);
  }

  // Sort by confidence desc — primary product (alias target) is index 0.
  out.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  return out;
}

function buildAgreedProduct(gpt, gemini) {
  // Pick the more specific label (longer non-empty) — tends to be the
  // SKU-level vs category-level identification.
  const moreSpecific = (gemini.label && gemini.label.length > (gpt.label?.length || 0))
    ? gemini : gpt;
  const meanConf = ((gpt.confidence || 0) + (gemini.confidence || 0)) / 2;
  return {
    label:        moreSpecific.label,
    description:  moreSpecific.description || gpt.description || gemini.description || '',
    brand:        gpt.brand || gemini.brand || null,
    category:     moreSpecific.category || gpt.category || gemini.category || 'other',
    confidence:   Math.min(1, meanConf + 0.10),     // agreement boost
    sourceEngines: ['gpt', 'gemini'],
    agreement:    'agree',
    reasoning:    `both engines identified ${moreSpecific.label}`
  };
}

// Engines confirm same brand+category but at different label specificity.
// One says the broader category ("fishing shirt"), the other names the
// specific SKU ("Aquatek Icon Sunshirt"). Both are valid signals about the
// same product family — preserve the SKU as primary and the broader label
// as `categoryLabel` (downstream catalog-first match can fall back to the
// broader label when the specific one doesn't catalog-match).
//
// Confidence: max of the two raw values, NO single-engine penalty (both
// engines did corroborate, just at different specificities). NO agreement
// boost either — this is weaker than a full SKU-level agreement.
function buildCategoryConfirmedProduct(gpt, gemini) {
  const gptLen = (gpt.label || '').length;
  const gemLen = (gemini.label || '').length;
  const isGemMoreSpecific = gemLen > gptLen;
  const specific = isGemMoreSpecific ? gemini : gpt;
  const broader  = isGemMoreSpecific ? gpt    : gemini;
  return {
    label:         specific.label,
    categoryLabel: broader.label && broader.label !== specific.label ? broader.label : null,
    description:   specific.description || broader.description || '',
    brand:         specific.brand || broader.brand || null,
    category:      specific.category || broader.category || 'other',
    confidence:    Math.max(specific.confidence || 0, broader.confidence || 0),
    sourceEngines: ['gpt', 'gemini'],
    agreement:     'category-confirmed',
    reasoning:     `engines confirm same brand+category; ${isGemMoreSpecific ? 'Gemini' : 'GPT'} specified "${specific.label}", ${isGemMoreSpecific ? 'GPT' : 'Gemini'} provided category-level "${broader.label}"`
  };
}

// Single-engine floor: a single-engine identification with post-penalty
// confidence below this is a hallucination risk (one engine saw something
// the other missed AND wasn't very sure about it). Returns null so the
// caller can drop the product from the reconciled list.
const SINGLE_ENGINE_FLOOR = 0.60;

function buildSingleEngineProduct(p, agreement, reasoning) {
  const penalized = Math.max(0, Math.min(1, (p.confidence || 0) * 0.85));    // single-engine penalty
  if (penalized < SINGLE_ENGINE_FLOOR) {
    return null;
  }
  return {
    label:        p.label,
    description:  p.description || '',
    brand:        p.brand || null,
    category:     p.category || 'other',
    confidence:   penalized,
    sourceEngines: [agreement === 'gpt-only' ? 'gpt' : 'gemini'],
    agreement,
    reasoning
  };
}

// Two products are "likely same" when:
//   - brands match (case-insensitive, normalized) OR both null
//   - same category bucket (or one is a generic 'other' fallback)
function productsLikelySame(a, b) {
  if (!a || !b) return false;
  if (!brandsMatchLoose(a.brand, b.brand)) return false;
  // Category mismatch is a strong signal these are different items.
  // 'other' doesn't disqualify — used as a fallback when an engine wasn't sure.
  const ca = (a.category || 'other').toLowerCase();
  const cb = (b.category || 'other').toLowerCase();
  if (ca !== 'other' && cb !== 'other' && ca !== cb) return false;
  return true;
}

// Same brand AND same category — used by pass 2 (category-confirmed). Same
// criteria as productsLikelySame but separated for naming clarity. Allows
// label-level disagreement; just needs brand + category alignment.
function sameBrandAndCategory(a, b) {
  return productsLikelySame(a, b);
}

function brandsMatchLoose(a, b) {
  if (!a && !b) return true;       // both null — treat as compatible
  if (!a || !b) return true;       // one null — don't disqualify on missing brand
  return normalizeBrand(a) === normalizeBrand(b);
}

function normalizeBrand(s) {
  return String(s || '').toLowerCase()
    .replace(/[®™©]/g, '')
    .replace(/\b(inc|co|llc|ltd|corp|corporation)\.?/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function labelOverlap(labelA, labelB) {
  const a = tokenize(labelA);
  const b = tokenize(labelB);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  const union = new Set([...a, ...b]).size;
  return union ? shared / union : 0;
}

function tokenize(s) {
  return new Set(
    String(s || '').toLowerCase()
      .replace(/[®™©]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 3)        // drop stopwords-by-length
  );
}

function aliasFromProducts(products) {
  if (!products || !products.length) return nonProductIdentification();
  const best = products[0];   // already sorted by confidence desc
  return {
    label:       best.label,
    description: best.description || '',
    brand:       best.brand || null,
    category:    best.category || 'other',
    confidence:  best.confidence
  };
}

function nonProductIdentification() {
  return {
    label:       'non-product',
    description: '',
    brand:       null,
    category:    'non-product',
    confidence:  0
  };
}

module.exports = { reconcileEnrichments, reconcileOne };
