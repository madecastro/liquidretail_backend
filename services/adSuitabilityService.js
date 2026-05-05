// Phase A-0 — derived "Ad Readiness" score + reason bullets.
//
// Computed from already-captured artifacts at the end of detect, so the
// Media Library page can render the Summary tab without any on-the-fly
// derivation. Closes backlog row #28 (adSuitability scoring writer).
//
// SCORE: 0–10 composite, 1-decimal precision. Mix of additive signals
// ("good things in this image") and subtractive penalties ("things that
// reduce readiness").
//
// REASONS: typed bullets the UI renders as ✓ / ⚠ rows. Each reason is one
// of:
//   { kind: 'product_visibility' | 'safe_zones' | 'lighting' | 'focus' |
//           'subject_prominence' | 'text_on_subject' | 'competitor' |
//           'low_match_quality',
//     label: 'human-readable bullet text',
//     severity: 'positive' | 'caution' | 'negative' }
//
// All thresholds are first-cut. Tune from real-world readiness scoring
// once we have ad-performance feedback.

const POSITIVE_BUCKETS = {
  product_visibility:  'Strong product visibility',
  safe_zones:          'Clean safe overlay zones',
  lighting:            'Good lighting on subject',
  focus:               'Image is in focus',
  subject_prominence:  'Primary subject well-framed'
};

const CAUTION_BUCKETS = {
  text_on_subject:     'Slight text on rock',                  // overridden when label produced
  low_match_quality:   'Low product-match confidence'
};

const NEGATIVE_BUCKETS = {
  competitor:          'Competitor brand detected'
};

// Composite scorer.
//   inputs (all optional; missing = neutral):
//     refinedProducts:     [{ label, brand, confidence, x1..y2 }]
//     overlayZones:        OverlayZoneArtifact.zones[firstRatio]
//                          (densityGrid, brightnessGrid, restrictions[],
//                          primarySubjectRectPct)
//     focus:               { focusScore, focusBucket } from imageQualityService
//     text:                Media.text[] (OCR detections)
//     detectSummaryOutcome: 'own_product'|'competitor'|'mixed'|'category'|'no_products'
//     primarySubjectRectPct: { x1, y1, x2, y2 } in [0,1]
//     mediaWidth, mediaHeight: pixel dims (used to compute area fractions)
//
// Returns:
//   { score: number,            // 0..10 with 1 decimal
//     reasons: ReasonBullet[],   // ordered: positive first, then caution, then negative
//     metrics: {                 // raw values consumed by the score (debug)
//       brightnessAvg, densityAvg,
//       safeAreaFraction,
//       primarySubjectAreaFraction,
//       refinedConfidenceAvg,
//       textOnSubjectCount
//     }
//   }
function scoreMedia(inputs = {}) {
  const {
    refinedProducts = [],
    overlayZones    = null,
    focus           = null,
    text            = [],
    detectSummaryOutcome = null,
    primarySubjectRectPct = null
  } = inputs;

  const reasons = [];
  const metrics = {};
  let score = 5.0;     // baseline; signals push up or down

  // ── product_visibility ──────────────────────────────────────────
  const confidentProducts = refinedProducts.filter(p => (p.confidence || 0) >= 0.85);
  const refinedConfidenceAvg = refinedProducts.length
    ? refinedProducts.reduce((s, p) => s + (p.confidence || 0), 0) / refinedProducts.length
    : 0;
  metrics.refinedConfidenceAvg = round(refinedConfidenceAvg, 2);
  metrics.confidentProductCount = confidentProducts.length;
  if (confidentProducts.length >= 2 || (confidentProducts.length >= 1 && refinedConfidenceAvg >= 0.90)) {
    score += 1.5;
    reasons.push({ kind: 'product_visibility', label: POSITIVE_BUCKETS.product_visibility, severity: 'positive' });
  } else if (refinedProducts.length === 0) {
    score -= 1.0;
    reasons.push({ kind: 'product_visibility', label: 'No products clearly visible', severity: 'negative' });
  } else if (refinedConfidenceAvg < 0.70) {
    score -= 0.5;
    reasons.push({ kind: 'low_match_quality', label: CAUTION_BUCKETS.low_match_quality, severity: 'caution' });
  }

  // ── safe_zones (driven by overlay-zone restrictions) ────────────
  if (overlayZones?.restrictions) {
    const hardArea = overlayZones.restrictions
      .filter(r => (r.strictness || 0) >= 0.9)
      .reduce((s, r) => s + rectArea(r.rectPct), 0);
    const safeAreaFraction = Math.max(0, Math.min(1, 1 - hardArea));
    metrics.safeAreaFraction = round(safeAreaFraction, 2);
    if (safeAreaFraction >= 0.55) {
      score += 1.0;
      reasons.push({ kind: 'safe_zones', label: POSITIVE_BUCKETS.safe_zones, severity: 'positive' });
    } else if (safeAreaFraction < 0.30) {
      score -= 1.0;
      reasons.push({ kind: 'safe_zones', label: 'Limited room for overlays', severity: 'negative' });
    }
  }

  // ── lighting (brightness average from overlay-zone grid) ────────
  if (overlayZones?.brightnessGrid?.cells?.length) {
    const cells = overlayZones.brightnessGrid.cells.flat();
    const brightnessAvg = cells.reduce((s, v) => s + v, 0) / cells.length;
    metrics.brightnessAvg = round(brightnessAvg, 2);
    if (brightnessAvg >= 0.30 && brightnessAvg <= 0.75) {
      score += 0.7;
      reasons.push({ kind: 'lighting', label: POSITIVE_BUCKETS.lighting, severity: 'positive' });
    } else if (brightnessAvg < 0.20) {
      score -= 0.7;
      reasons.push({ kind: 'lighting', label: 'Image is too dark', severity: 'negative' });
    } else if (brightnessAvg > 0.85) {
      score -= 0.5;
      reasons.push({ kind: 'lighting', label: 'Image is overexposed', severity: 'caution' });
    }
  }

  // ── density (clutter; pulled for metrics + light penalty) ──────
  if (overlayZones?.densityGrid?.cells?.length) {
    const cells = overlayZones.densityGrid.cells.flat();
    metrics.densityAvg = round(cells.reduce((s, v) => s + v, 0) / cells.length, 2);
  }

  // ── focus (Laplacian-variance bucket from imageQualityService) ──
  if (focus?.focusBucket) {
    if (focus.focusBucket === 'Sharp') {
      score += 0.5;
      reasons.push({ kind: 'focus', label: POSITIVE_BUCKETS.focus, severity: 'positive' });
    } else if (focus.focusBucket === 'Soft') {
      score -= 1.0;
      reasons.push({ kind: 'focus', label: 'Image appears soft / out of focus', severity: 'negative' });
    }
    metrics.focusScore  = focus.focusScore;
    metrics.focusBucket = focus.focusBucket;
  }

  // ── subject_prominence ──────────────────────────────────────────
  if (primarySubjectRectPct) {
    const psArea = rectArea(primarySubjectRectPct);
    metrics.primarySubjectAreaFraction = round(psArea, 2);
    if (psArea >= 0.10 && psArea <= 0.65) {
      score += 0.5;
      reasons.push({ kind: 'subject_prominence', label: POSITIVE_BUCKETS.subject_prominence, severity: 'positive' });
    } else if (psArea < 0.05) {
      score -= 0.5;
      reasons.push({ kind: 'subject_prominence', label: 'Primary subject is small in frame', severity: 'caution' });
    } else if (psArea > 0.80) {
      score -= 0.3;
      reasons.push({ kind: 'subject_prominence', label: 'Primary subject crowds the frame', severity: 'caution' });
    }
  }

  // ── text_on_subject (OCR over the primary subject rect) ─────────
  if (text?.length && primarySubjectRectPct) {
    const onSubject = text.filter(t => intersects(t, primarySubjectRectPct) && t.type !== 'brand');
    metrics.textOnSubjectCount = onSubject.length;
    if (onSubject.length > 0) {
      score -= 0.4 * Math.min(onSubject.length, 3);
      const label = onSubject.length === 1
        ? `Text overlaps primary subject ("${truncate(onSubject[0].content, 18)}")`
        : `${onSubject.length} text regions overlap primary subject`;
      reasons.push({ kind: 'text_on_subject', label, severity: 'caution' });
    }
  }

  // ── competitor outcome ─────────────────────────────────────────
  if (detectSummaryOutcome === 'competitor') {
    score -= 2.0;
    reasons.push({ kind: 'competitor', label: NEGATIVE_BUCKETS.competitor, severity: 'negative' });
  } else if (detectSummaryOutcome === 'mixed') {
    score -= 0.7;
    reasons.push({ kind: 'competitor', label: 'Competitor product visible alongside own brand', severity: 'caution' });
  }

  // Clamp + round
  const finalScore = Math.max(0, Math.min(10, round(score, 1)));

  // Order reasons: positive → caution → negative for UI rendering
  const order = { positive: 0, caution: 1, negative: 2 };
  reasons.sort((a, b) => order[a.severity] - order[b.severity]);

  return { score: finalScore, reasons, metrics };
}

// ── helpers ──────────────────────────────────────────────────────

function rectArea(r) {
  if (!r) return 0;
  const w = Math.max(0, (r.x2 ?? 0) - (r.x1 ?? 0));
  const h = Math.max(0, (r.y2 ?? 0) - (r.y1 ?? 0));
  return w * h;
}

function intersects(a, b) {
  if (!a || !b) return false;
  return !(a.x2 <= b.x1 || b.x2 <= a.x1 || a.y2 <= b.y1 || b.y2 <= a.y1);
}

function round(n, dp) {
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

function truncate(s, n) {
  s = String(s || '');
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

module.exports = { scoreMedia };
