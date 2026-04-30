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
  const matched = new Set();   // indices in geminiProducts already matched
  const out = [];

  // Pass 1 — for each GPT product, find the best Gemini match (if any).
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
      const gem = geminiProducts[bestIdx];
      out.push(buildAgreedProduct(g, gem));
    } else if (geminiUnavail) {
      // Gemini didn't run at all — passthrough with penalty so it's not
      // mistakenly treated as a confirmed dual-engine signal.
      out.push(buildSingleEngineProduct(g, 'gpt-only', 'gemini call unavailable'));
    } else {
      // Gemini ran but didn't see this product — could mean it's noise OR
      // it's a real product Gemini missed. Penalty + flag for review.
      out.push(buildSingleEngineProduct(g, 'gpt-only', 'GPT identified; Gemini did not'));
    }
  }

  // Pass 2 — Gemini products GPT didn't see.
  for (let i = 0; i < geminiProducts.length; i++) {
    if (matched.has(i)) continue;
    out.push(buildSingleEngineProduct(geminiProducts[i], 'gemini-only', 'Gemini identified; GPT did not'));
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

function buildSingleEngineProduct(p, agreement, reasoning) {
  return {
    label:        p.label,
    description:  p.description || '',
    brand:        p.brand || null,
    category:     p.category || 'other',
    confidence:   Math.max(0, Math.min(1, (p.confidence || 0) * 0.85)),    // single-engine penalty
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
