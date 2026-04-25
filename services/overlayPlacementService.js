// Overlay placement algorithm for image-as-canvas templates (e.g.
// testimonial_overlay). Greedy priority-ordered placement that uses the
// detect pipeline's overlay-zone analysis (restrictions + densityGrid +
// brightnessGrid) to pick safe rects on top of the image, with adaptive
// text color, scrim strength, and font-scale hints.
//
// Algorithm summary:
//   1. Convert restrictions → keepOut rects, separated into HARD (product,
//      strictness ≥ 0.95) where 0% overlap is allowed and SOFT where the
//      caller can tolerate up to N% overlap of THAT restriction's area.
//   2. For each element in priority order, generate candidate rects in its
//      preferred region, filter out illegal candidates, score the rest by
//      density (low better) + brightness uniformity (low variance better)
//      + proximity to anchor, pick best, mark its area consumed so lower
//      priority elements can't overlap.
//   3. Sample brightnessGrid under the chosen rect → text color +
//      scrim opacity (gradient strength scales with the bg/text contrast
//      gap — readable text on bright bg gets a dark scrim and vice versa).
//   4. For text-scale elements (headline, product_meta) include a
//      recommended fontScale based on rect area + content length so the
//      renderer/preview can shrink before truncating.
//   5. If any REQUIRED element fails placement, switch to INSET MODE:
//      inscribe a smaller-aspect image inside the canvas and fill margin
//      bands with brand.primary_color, then place remaining elements in
//      those bands which are guaranteed subject-free.

// ── Tunables ─────────────────────────────────────────────────────────────
const HARD_STRICTNESS_FLOOR    = 0.95;   // ≥ this = absolute no-overlap (product, primary subject)
const SOFT_OVERLAP_PCT         = 0.10;   // up to 10% of a soft restriction may be covered
const SOFT_OVERLAP_PCT_LOOSE   = 0.25;   // strictness < 0.5 → loosen further
const MIN_FONT_SCALE           = 0.55;   // never scale text below 55% of base
const SCRIM_BRIGHTNESS_GAP_K   = 0.85;   // multiplier on |bg-text| → scrim opacity
// Gemini's overlay-zone restrictions consistently include 8-15% padding
// around the actual subject silhouette (the prompt asks for tight bounds
// but visual models err generous). Shrink each restriction inward by N%
// per side to recover the canvas area that was never really off-limits.
const RESTRICTION_INSET_PCT    = 0.04;
// Density-aware legality: a candidate that overlaps a hard restriction
// is rescued if the densityGrid sample inside the intersection is below
// this threshold — meaning the overlap falls in an empty pocket of the
// bbox (sky around the head, water around the legs) rather than on the
// subject itself. Cells score 0..1; person silhouettes typically land
// 0.6+, sky/water 0.0-0.15.
const DENSITY_EMPTY_THRESHOLD  = 0.20;

// ── Placement entry point ────────────────────────────────────────────────

function placeOverlays({ canvasW = 1000, canvasH = 1000, analysis, conservation = 0.5, content, brandColors, aspectRatio }) {
  // Build specs for ALL possible elements (including those skipped for
  // missing source data) so the decision trace is complete.
  const { specs: elements, skipped } = buildElementSpecs(content);
  const result = tryPlace({ canvasW, canvasH, analysis, conservation, elements, content, mode: 'overlay', skippedSpecs: skipped });

  // Fallback: if any required element failed, retry in inset mode.
  if (result.failedRequired.length > 0) {
    const inset = tryInset({ canvasW, canvasH, analysis, conservation, elements, content, brandColors, aspectRatio, skippedSpecs: skipped });
    if (inset && inset.failedRequired.length < result.failedRequired.length) return inset;
  }

  return result;
}

// Build the full ordered element spec list. Each spec includes the source
// data path it needs, so we can distinguish ATTEMPTED-BUT-DROPPED from
// NEVER-ATTEMPTED-DUE-TO-MISSING-DATA in the decision trace.
//
// SHAPE VARIANTS: each spec now declares multiple shape variants so the
// candidate generator can try e.g. a 1-line horizontal headline OR a
// 2-line stacked narrow-column headline. When the preferred shape is
// blocked by subject keep-outs, scoring falls through to the secondary
// shape rather than declaring the element unplaceable. Each shape carries:
//   - variant:     label for downstream renderer ('horizontal'/'stacked-2'/…)
//   - sizePct:     nominal width/height in canvas fractions
//   - sizeBounds:  min/max bounds for width-multiplier search
//   - maxLines:    how many text lines the container accommodates
//   - layout:      'inline' | 'stack' — hint to renderer for meta_group
//   - preferBonus: score bonus (+) for preferred shapes, (-) for last-resort
//
// Returns { specs: [...active specs in priority order],
//           skipped: [...specs that never got attempted because source
//                     data was null] }
function buildElementSpecs(content) {
  const all = [
    {
      id: 'logo', kind: 'logo', priority: 1, required: true,
      slot: 'brand.logo', region: 'top-left',
      contentLength: 0,
      shapes: [
        // Preferred: wordmark-shaped horizontal rect.
        { variant: 'horizontal', sizePct: { w: 0.14, h: 0.06 }, sizeBounds: { minW: 0.08, maxW: 0.20, minH: 0.04, maxH: 0.07 }, maxLines: 1, layout: 'inline', preferBonus: 0.6 },
        // Mark-only square — compresses the logo into tight corners if the
        // wordmark's row is obstructed by a subject keep-out.
        { variant: 'square',     sizePct: { w: 0.08, h: 0.08 }, sizeBounds: { minW: 0.06, maxW: 0.11, minH: 0.06, maxH: 0.11 }, maxLines: 1, layout: 'inline', preferBonus: -0.2 }
      ],
      _hasSource: !!content?.brand?.logo,
      _missingPath: 'brand.logo'
    },
    {
      id: 'headline', kind: 'text', priority: 2, required: true,
      slot: 'copy.headline', region: 'top-band',
      contentLength: (content?.copy?.headline || '').length,
      scaleText: true,
      // Headlines commonly bleed onto the subject in real ads (sky over
      // the person's shoulder, etc.). Allow up to 25% of the headline's
      // own area to sit on the primary subject so we keep overlay mode
      // and avoid falling to inset bands when the subject is wide.
      allowedHardOverlapPct: 0.25,
      shapes: [
        // Preferred: 1-line wide strip — the classic top banner headline.
        { variant: 'horizontal', sizePct: { w: 0.84, h: 0.13 }, sizeBounds: { minW: 0.56, maxW: 0.92, minH: 0.08, maxH: 0.18 }, maxLines: 1, layout: 'inline', preferBonus: 0.6 },
        // 2-line stacked — narrower column, ~40% less width. Fits when the
        // frame has a centered subject cutting the horizontal band in half.
        { variant: 'stacked-2',  sizePct: { w: 0.60, h: 0.20 }, sizeBounds: { minW: 0.40, maxW: 0.72, minH: 0.14, maxH: 0.28 }, maxLines: 2, layout: 'stack',  preferBonus: 0.0 },
        // 3-line narrow column — last-resort for very portrait frames
        // (9:16 with a central subject) where only a thin side-rail is legal.
        { variant: 'stacked-3',  sizePct: { w: 0.42, h: 0.28 }, sizeBounds: { minW: 0.28, maxW: 0.54, minH: 0.20, maxH: 0.38 }, maxLines: 3, layout: 'stack',  preferBonus: -0.3 }
      ],
      _hasSource: !!content?.copy?.headline,
      _missingPath: 'copy.headline'
    },
    {
      id: 'product_meta', kind: 'meta_group', priority: 3, required: true,
      slots: ['product.name', 'product.price', 'social_proof.rating_value', 'social_proof.review_count'],
      region: 'mid-band',
      contentLength: (content?.product?.name || '').length + 12,
      scaleText: true,
      // Same as headline: allow up to 25% overlap with the primary
      // subject so the meta block can land in mid-band side-rails even
      // when the subject is centered.
      allowedHardOverlapPct: 0.25,
      shapes: [
        // Preferred: name+price and rating stacked on 2 inline-ish lines.
        { variant: 'inline',     sizePct: { w: 0.60, h: 0.10 }, sizeBounds: { minW: 0.38, maxW: 0.78, minH: 0.07, maxH: 0.14 }, maxLines: 2, layout: 'inline', preferBonus: 0.4 },
        // Full-width slim — for bottom-third placement above CTA.
        { variant: 'inline-wide',sizePct: { w: 0.76, h: 0.08 }, sizeBounds: { minW: 0.52, maxW: 0.88, minH: 0.06, maxH: 0.11 }, maxLines: 2, layout: 'inline', preferBonus: 0.2 },
        // Stacked column — name / stars / count vertically. Works in a
        // side-rail on portrait frames.
        { variant: 'stacked',    sizePct: { w: 0.34, h: 0.20 }, sizeBounds: { minW: 0.22, maxW: 0.46, minH: 0.14, maxH: 0.28 }, maxLines: 3, layout: 'stack',  preferBonus: -0.2 }
      ],
      _hasSource: !!content?.product?.name || typeof content?.social_proof?.rating_value === 'number',
      _missingPath: 'product.name OR social_proof.rating_value'
    },
    {
      id: 'cta', kind: 'button', priority: 4, required: true,
      slot: 'cta.text', region: 'bottom-third',
      contentLength: (content?.cta?.text || '').length,
      shapes: [
        // Preferred: classic horizontal button.
        { variant: 'horizontal', sizePct: { w: 0.36, h: 0.08 }, sizeBounds: { minW: 0.24, maxW: 0.50, minH: 0.06, maxH: 0.11 }, maxLines: 1, layout: 'inline', preferBonus: 0.5 },
        // Wide slim pill — sits under the image nicely in inset mode.
        { variant: 'pill-wide',  sizePct: { w: 0.52, h: 0.07 }, sizeBounds: { minW: 0.36, maxW: 0.72, minH: 0.05, maxH: 0.09 }, maxLines: 1, layout: 'inline', preferBonus: 0.1 },
        // Narrow tall pill — tight horizontal space, e.g. squeezed next to
        // a centered subject at the bottom of a portrait frame.
        { variant: 'pill-narrow',sizePct: { w: 0.22, h: 0.10 }, sizeBounds: { minW: 0.16, maxW: 0.30, minH: 0.08, maxH: 0.14 }, maxLines: 1, layout: 'inline', preferBonus: -0.3 }
      ],
      _hasSource: !!content?.cta?.text,
      _missingPath: 'cta.text'
    },
    {
      id: 'quote', kind: 'quote_card', priority: 5, required: false,
      slot: 'social_proof.primary_quote', region: 'flex',
      contentLength: (content?.social_proof?.primary_quote?.text || '').length,
      truncate: 'ellipsis',
      // Quote is allowed to sit up to 50% over the primary subject —
      // testimonial-style overlays commonly land a speech-bubble-like
      // block partially on top of the person or product so the eye
      // reads them as linked. Measured as (intersection / quoteRectArea).
      allowedHardOverlapPct: 0.5,
      shapes: [
        // Preferred: medium card with 4 lines of body copy.
        { variant: 'card',       sizePct: { w: 0.62, h: 0.20 }, sizeBounds: { minW: 0.44, maxW: 0.82, minH: 0.14, maxH: 0.28 }, maxLines: 4, layout: 'inline', preferBonus: 0.4 },
        // Wide thin card — less vertical footprint, good for 16:9 / 1.91:1.
        { variant: 'card-wide',  sizePct: { w: 0.78, h: 0.16 }, sizeBounds: { minW: 0.58, maxW: 0.90, minH: 0.12, maxH: 0.22 }, maxLines: 3, layout: 'inline', preferBonus: 0.1 },
        // Narrow tall column — wraps to 6 lines; fits a portrait side-rail.
        { variant: 'card-narrow',sizePct: { w: 0.38, h: 0.30 }, sizeBounds: { minW: 0.26, maxW: 0.50, minH: 0.22, maxH: 0.40 }, maxLines: 6, layout: 'inline', preferBonus: -0.2 }
      ],
      _hasSource: !!content?.social_proof?.primary_quote?.text,
      _missingPath: 'social_proof.primary_quote.text'
    }
  ];

  const specs = all.filter(s => s._hasSource);
  const skipped = all.filter(s => !s._hasSource).map(s => ({
    id: s.id,
    priority: s.priority,
    required: s.required,
    region: s.region,
    state: 'skipped',
    reason: `no source data (${s._missingPath} missing)`
  }));
  return { specs, skipped };
}

// ── Core greedy pass ─────────────────────────────────────────────────────

function tryPlace({ canvasW, canvasH, analysis, conservation, elements, content, mode, availableRegions, skippedSpecs }) {
  const threshold = 1 - conservation;

  // Tighten each restriction inward — Gemini's bboxes pad generously
  // around the actual subject. Don't shrink below a sensible minimum
  // size (5% canvas dimension) so we don't accidentally annihilate a
  // small far-away product restriction.
  const restrictions = (analysis?.restrictions || []).map(r => ({
    rect: shrinkRect(r.rectPct, RESTRICTION_INSET_PCT, 0.05),
    strictness: r.strictness ?? 1
  }));
  const hardKeepOut = restrictions.filter(r => r.strictness >= HARD_STRICTNESS_FLOOR);
  const softKeepOut = restrictions.filter(r => r.strictness >= threshold && r.strictness < HARD_STRICTNESS_FLOOR);
  const densityGrid = analysis?.densityGrid || null;

  const consumed = [];
  const placed = [];
  const decisions = [...(skippedSpecs || [])]; // include missing-data skips in the trace
  const failedRequired = [];

  for (const el of elements) {
    const candidates = generateCandidates(el, availableRegions);
    const nCandidates = candidates.length;

    const hardAllow = el.allowedHardOverlapPct || 0;
    const legal = candidates.filter(c =>
      withinCanvas(c) &&
      !overlapsAnyHard(c, hardKeepOut, hardAllow, densityGrid) &&
      softOverlapWithinLimit(c, softKeepOut, el) &&
      !overlapsAnyConsumed(c, consumed)
    );

    let pick = null;
    let state = 'placed';
    let reason = `placed in ${el.region}`;

    if (legal.length) {
      pick = legal.reduce((best, c) => {
        const s = score(c, el, analysis, consumed);
        return s > (best.s ?? -Infinity) ? { c, s } : best;
      }, {}).c;
      reason = `placed in ${el.region} (${legal.length}/${nCandidates} legal candidates)`;
    } else if (el.required) {
      // Last-resort: ignore SOFT overlap entirely; only avoid HARD + consumed.
      const fallback = candidates.filter(c =>
        withinCanvas(c) && !overlapsAnyHard(c, hardKeepOut, hardAllow, densityGrid) && !overlapsAnyConsumed(c, consumed)
      );
      if (fallback.length) {
        pick = fallback.reduce((best, c) => {
          const s = score(c, el, analysis, consumed);
          return s > (best.s ?? -Infinity) ? { c, s } : best;
        }, {}).c;
        state = 'fallback-placed';
        reason = `forced into ${el.region} — no candidates respected the 10% subject-overlap budget; relaxed to avoid hard keep-out only (${fallback.length}/${nCandidates})`;
      }
    }

    if (!pick) {
      if (el.required) {
        failedRequired.push(el.id);
        decisions.push({
          id: el.id, priority: el.priority, required: el.required, region: el.region,
          state: 'failed-required',
          reason: hardKeepOut.length
            ? `no legal candidate — hard keep-out (product/subject) overlapped every option in ${el.region} (${nCandidates} candidates evaluated)`
            : softKeepOut.length
              ? `no legal candidate — conservation level excluded every option in ${el.region}`
              : `no legal candidate — geometry couldn't fit the required size in ${el.region}`,
          candidatesEvaluated: nCandidates,
          candidatesLegal: 0
        });
      } else {
        decisions.push({
          id: el.id, priority: el.priority, required: el.required, region: el.region,
          state: 'dropped',
          reason: `optional element — no safe area found in ${el.region} (${nCandidates} candidates evaluated, ${legal.length} legal)`,
          candidatesEvaluated: nCandidates,
          candidatesLegal: legal.length
        });
      }
      continue;
    }

    const brightness = sampleAvg(analysis?.brightnessGrid, pick);
    const density    = sampleAvg(analysis?.densityGrid, pick);
    const textColor  = brightness < 0.5 ? '#FFFFFF' : '#0A0A0A';
    const scrim      = computeAdaptiveScrim(textColor, brightness, density, pick);
    // Shape-aware font scale: maxLines comes from the picked candidate's
    // shape variant (horizontal headline → 1, stacked-3 → 3), so content
    // length divides by the right line budget.
    const pickMaxLines = pick.maxLines || 2;
    const fontScale  = el.scaleText ? recommendFontScale(el, pick, canvasW, canvasH, pickMaxLines) : 1;

    placed.push({
      id:        el.id,
      kind:      el.kind,
      slot:      el.slot,
      slots:     el.slots,
      rectPct:   { x1: pick.x1, y1: pick.y1, x2: pick.x2, y2: pick.y2 },
      variant:   pick.variant,
      layout:    pick.layout,
      maxLines:  pickMaxLines,
      textColor,
      scrim,
      fontScale,
      truncate:  el.truncate
    });
    consumed.push(pick);

    decisions.push({
      id: el.id, priority: el.priority, required: el.required, region: el.region,
      state,
      reason: `${reason} [${pick.variant}/${pick.layout}, ${pickMaxLines} line(s)]`,
      rectPct: { x1: pick.x1, y1: pick.y1, x2: pick.x2, y2: pick.y2 },
      variant: pick.variant,
      layout:  pick.layout,
      maxLines: pickMaxLines,
      textColor,
      scrim: { type: scrim.type, opacity: Number(scrim.opacity.toFixed(2)), direction: scrim.direction },
      fontScale: Number(fontScale.toFixed(2)),
      stats: {
        candidatesEvaluated: nCandidates,
        candidatesLegal: legal.length,
        bgBrightness: Number(brightness.toFixed(2)),
        bgDensity: Number(density.toFixed(2))
      }
    });
  }

  // Sort the decision trace by priority so the UI renders in the order
  // the algorithm considered elements.
  decisions.sort((a, b) => (a.priority || 99) - (b.priority || 99));

  return {
    mode,
    backgroundMedia: { useFullBleedImage: true },
    elements: placed,
    decisions,
    failedRequired
  };
}

// ── Inset fallback ───────────────────────────────────────────────────────

function tryInset({ canvasW, canvasH, analysis, conservation, elements, content, brandColors, aspectRatio }) {
  // Inscribe a more-square aspect inside the canvas, leaving brand-color
  // bands at top/bottom (or left/right for landscape canvases) where
  // required elements can be placed in guaranteed subject-free real estate.
  // For a 9:16 canvas we inscribe a 4:5 image (~70% vertical), leaving
  // ~15% bands top + bottom.
  const insetPlan = computeInsetPlan(aspectRatio);
  if (!insetPlan) return null;

  const { imageRect, bands } = insetPlan;

  // Run placement again with availableRegions = bands. We pass an empty
  // analysis (no restrictions) because the bands are guaranteed safe.
  const sub = tryPlace({
    canvasW, canvasH,
    analysis: { restrictions: [], densityGrid: null, brightnessGrid: null },
    conservation,
    elements,
    content,
    mode: 'inset',
    availableRegions: bands
  });

  // Force text color to be readable on the brand-color band (use the
  // brand's own contrast logic). When the brand primary is dark, white
  // text; when light, dark text.
  const onBandColor = readableOn(brandColors?.primary || '#1f2937');
  for (const p of sub.elements) {
    if (insideAny(p.rectPct, bands)) {
      p.textColor = onBandColor;
      p.scrim = { type: 'none', opacity: 0 };  // band is solid color, no scrim needed
    }
  }

  return {
    mode: 'inset',
    backgroundMedia: { useFullBleedImage: false, imageRect, backgroundColor: brandColors?.primary || '#1f2937' },
    elements: sub.elements,
    // Pass the decision trace through so the inspector panel shows WHY
    // inset was invoked and how each element fared in the bands.
    decisions: sub.decisions || [],
    failedRequired: sub.failedRequired
  };
}

function computeInsetPlan(aspectRatio) {
  // Returns { imageRect: { x1,y1,x2,y2 }, bands: [{x1,y1,x2,y2},...] }
  // All in normalized 0..1 of the canvas.
  switch (aspectRatio) {
    case '9:16': {
      // 4:5 image inscribed: image_h/canvas_h = (canvas_w * 5/4) / canvas_h
      // For 9:16: canvas_h/canvas_w = 16/9, so image_h/canvas_h = (5/4) / (16/9) = 45/64 ≈ 0.703
      const imgH = 0.70;
      const margin = (1 - imgH) / 2; // ~0.15 each band
      return {
        imageRect: { x1: 0, y1: margin, x2: 1, y2: margin + imgH },
        bands: [
          { x1: 0.04, y1: 0.02, x2: 0.96, y2: margin - 0.01 },          // top band
          { x1: 0.04, y1: margin + imgH + 0.01, x2: 0.96, y2: 0.98 }    // bottom band
        ]
      };
    }
    case '4:5': {
      // 1:1 inscribed in 4:5: image_h = canvas_w, so image_h/canvas_h = canvas_w / (canvas_w * 5/4) = 0.80
      const imgH = 0.80;
      const margin = (1 - imgH) / 2;
      return {
        imageRect: { x1: 0, y1: margin, x2: 1, y2: margin + imgH },
        bands: [
          { x1: 0.04, y1: 0.02, x2: 0.96, y2: margin - 0.01 },
          { x1: 0.04, y1: margin + imgH + 0.01, x2: 0.96, y2: 0.98 }
        ]
      };
    }
    case '1.91:1': {
      // 1:1 inscribed in 1.91:1: image_w = canvas_h, so image_w/canvas_w = canvas_h/(canvas_h * 1.91) = 1/1.91 ≈ 0.524
      const imgW = 0.52;
      const margin = (1 - imgW) / 2;
      return {
        imageRect: { x1: margin, y1: 0, x2: margin + imgW, y2: 1 },
        bands: [
          { x1: 0.02, y1: 0.06, x2: margin - 0.01, y2: 0.94 },          // left band
          { x1: margin + imgW + 0.01, y1: 0.06, x2: 0.98, y2: 0.94 }    // right band
        ]
      };
    }
    case '16:9': {
      const imgW = 0.56; // 1:1 in 16:9
      const margin = (1 - imgW) / 2;
      return {
        imageRect: { x1: margin, y1: 0, x2: margin + imgW, y2: 1 },
        bands: [
          { x1: 0.02, y1: 0.06, x2: margin - 0.01, y2: 0.94 },
          { x1: margin + imgW + 0.01, y1: 0.06, x2: 0.98, y2: 0.94 }
        ]
      };
    }
    default:
      return null;
  }
}

// ── Candidate generation per region ─────────────────────────────────────

function generateCandidates(el, availableRegions) {
  const out = [];
  // Loop shape variants so a single element gets horizontal + stacked +
  // column candidates. Each candidate carries the shape's variant/maxLines/
  // layout/preferBonus so downstream scoring and the renderer can respect
  // the chosen shape.
  for (const shape of el.shapes) {
    for (const c of candidatesForShape(el, shape, availableRegions)) {
      out.push(c);
    }
  }
  return out;
}

// Produce candidate rects for a single shape variant. Tags each output
// rect with its shape metadata so scoring + placement echo the variant.
function candidatesForShape(el, shape, availableRegions) {
  const out = [];
  const tag = (r) => Object.assign(r, {
    variant:     shape.variant,
    maxLines:    shape.maxLines,
    layout:      shape.layout,
    preferBonus: shape.preferBonus || 0
  });

  // Inset mode: candidates come from inside explicit bands. We keep
  // shape selection generous here — inset bands sit on a flat brand-
  // color background (no image clutter), so a slightly-undersized
  // container is still legible. Skip a shape only when even an absolute
  // floor (0.04 of canvas) won't fit; otherwise clamp to the band.
  const ABS_FLOOR = 0.04;
  if (availableRegions && availableRegions.length) {
    for (const band of availableRegions) {
      const bh = band.y2 - band.y1;
      const bw = band.x2 - band.x1;
      if (bw < ABS_FLOOR || bh < ABS_FLOOR) continue;
      // Width: prefer shape's nominal but never exceed band, with
      // shape.sizeBounds.minW only as a soft target.
      const w = Math.min(bw - 0.005, Math.max(ABS_FLOOR, shape.sizePct.w));
      // Height: prefer shape's nominal but always fit the band — minH
      // is advisory in inset, not enforced.
      const h = Math.min(bh - 0.005, Math.max(ABS_FLOOR, shape.sizePct.h));
      const cx = (band.x1 + band.x2) / 2;
      const cy = (band.y1 + band.y2) / 2;
      out.push(tag({ x1: cx - w/2,     y1: cy - h/2, x2: cx - w/2 + w, y2: cy - h/2 + h }));
      out.push(tag({ x1: band.x1,      y1: cy - h/2, x2: band.x1 + w,  y2: cy - h/2 + h }));
      out.push(tag({ x1: band.x2 - w,  y1: cy - h/2, x2: band.x2,      y2: cy - h/2 + h }));
    }
    return out;
  }

  // Full-canvas candidates: sweep width multipliers × position anchors.
  const w = shape.sizePct.w;
  const h = shape.sizePct.h;
  const widths = [w, w * 0.85, w * 0.70, w * 1.10].filter(v => v >= shape.sizeBounds.minW && v <= shape.sizeBounds.maxW);
  const heights = [h]; // height is currently fixed per shape; shape catalog already expresses vertical variants.

  for (const hh of heights) {
    switch (el.region) {
      case 'top-left':
        for (const ww of widths) {
          out.push(tag({ x1: 0.04, y1: 0.04, x2: 0.04 + ww, y2: 0.04 + hh }));
          out.push(tag({ x1: 0.05, y1: 0.06, x2: 0.05 + ww, y2: 0.06 + hh }));
        }
        break;
      case 'top-right':
        for (const ww of widths) {
          out.push(tag({ x1: 0.96 - ww, y1: 0.04, x2: 0.96, y2: 0.04 + hh }));
        }
        break;
      case 'top-band':
        for (const y of [0.06, 0.10, 0.14, 0.18]) {
          for (const ww of widths) {
            out.push(tag({ x1: (1 - ww) / 2, y1: y, x2: (1 - ww) / 2 + ww, y2: y + hh }));
            out.push(tag({ x1: 0.05,         y1: y, x2: 0.05 + ww,         y2: y + hh }));
            // Side-rail anchors so tall-narrow shapes can hug the edges
            // when a subject blocks the centered band.
            out.push(tag({ x1: 0.95 - ww,    y1: y, x2: 0.95,              y2: y + hh }));
          }
        }
        break;
      case 'mid-band':
        for (const y of [0.32, 0.40, 0.48, 0.56, 0.64]) {
          for (const ww of widths) {
            out.push(tag({ x1: (1 - ww) / 2, y1: y, x2: (1 - ww) / 2 + ww, y2: y + hh }));
            out.push(tag({ x1: 0.05,         y1: y, x2: 0.05 + ww,         y2: y + hh }));
            out.push(tag({ x1: 0.95 - ww,    y1: y, x2: 0.95,              y2: y + hh }));
          }
        }
        break;
      case 'bottom-third':
        for (const y of [0.68, 0.74, 0.80, 0.85, 0.90]) {
          for (const ww of widths) {
            // Skip candidates whose bottom edge exceeds the canvas — common
            // for tall pill-narrow CTAs at the lowest anchor.
            if (y + hh > 0.99) continue;
            out.push(tag({ x1: (1 - ww) / 2, y1: y, x2: (1 - ww) / 2 + ww, y2: y + hh }));
            out.push(tag({ x1: 0.05,         y1: y, x2: 0.05 + ww,         y2: y + hh }));
            out.push(tag({ x1: 0.95 - ww,    y1: y, x2: 0.95,              y2: y + hh }));
          }
        }
        break;
      case 'flex':
      default:
        // Dense sweep — quotes can go almost anywhere; let scoring decide.
        for (const y of [0.10, 0.22, 0.34, 0.46, 0.58, 0.70]) {
          for (const ww of widths) {
            if (y + hh > 0.99) continue;
            out.push(tag({ x1: 0.04,         y1: y, x2: 0.04 + ww,         y2: y + hh }));
            out.push(tag({ x1: (1 - ww) / 2, y1: y, x2: (1 - ww) / 2 + ww, y2: y + hh }));
            out.push(tag({ x1: 0.96 - ww,    y1: y, x2: 0.96,              y2: y + hh }));
          }
        }
        break;
    }
  }
  return out;
}

// ── Geometry / overlap helpers ──────────────────────────────────────────

function withinCanvas(r) {
  return r.x1 >= 0 && r.y1 >= 0 && r.x2 <= 1 && r.y2 <= 1 && r.x2 > r.x1 && r.y2 > r.y1;
}
function rectArea(r) { return (r.x2 - r.x1) * (r.y2 - r.y1); }
function rectsIntersect(a, b) {
  return !(b.x1 >= a.x2 || b.x2 <= a.x1 || b.y1 >= a.y2 || b.y2 <= a.y1);
}
function rectIntersectionArea(a, b) {
  if (!rectsIntersect(a, b)) return 0;
  const w = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
  const h = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
  return w * h;
}
function overlapsAnyHard(cand, hardKeepOut, allowedHardOverlapPct = 0, densityGrid = null) {
  // Density-aware path: if we have a densityGrid, weight each
  // intersection by the average busyness of the cells it covers — an
  // intersection through low-density cells (sky around the head, water
  // around the legs) is in an empty pocket of the bbox and shouldn't
  // count as real overlap with the subject. Allows headlines/CTAs into
  // the negative space inside a person-shaped restriction.
  if (densityGrid) {
    const candArea = rectArea(cand) || 1;
    let effectiveOverlapTotal = 0;
    for (const k of hardKeepOut) {
      if (!rectsIntersect(cand, k.rect)) continue;
      const inter = {
        x1: Math.max(cand.x1, k.rect.x1),
        y1: Math.max(cand.y1, k.rect.y1),
        x2: Math.min(cand.x2, k.rect.x2),
        y2: Math.min(cand.y2, k.rect.y2)
      };
      const interArea = rectArea(inter);
      if (interArea <= 0) continue;
      const density = sampleAvg(densityGrid, inter);
      // Below the empty threshold the intersection is visually background
      // and counts as zero. Above it, scale the area by density so a half-
      // dense overlap costs half as much as a fully-dense one. Cap at 1.
      const weight = density < DENSITY_EMPTY_THRESHOLD ? 0 : Math.min(1, density);
      effectiveOverlapTotal += interArea * weight;
    }
    return (effectiveOverlapTotal / candArea) > allowedHardOverlapPct;
  }

  // No densityGrid: legacy strict check, with the per-element allowance.
  if (allowedHardOverlapPct <= 0) {
    return hardKeepOut.some(k => rectsIntersect(cand, k.rect));
  }
  const candArea = rectArea(cand) || 1;
  for (const k of hardKeepOut) {
    if (!rectsIntersect(cand, k.rect)) continue;
    const overlap = rectIntersectionArea(cand, k.rect);
    if ((overlap / candArea) > allowedHardOverlapPct) return true;
  }
  return false;
}

// Shrink a rect inward by `inset` (fraction of canvas) on each side
// while preserving a minimum dimension. Used to tighten Gemini's
// generously-padded restriction bboxes back toward the actual subject.
function shrinkRect(rect, inset, minDim = 0.05) {
  if (!rect || inset <= 0) return rect;
  const w = rect.x2 - rect.x1;
  const h = rect.y2 - rect.y1;
  // Don't shrink past minDim — keeps small/distant subject boxes from
  // collapsing to a point.
  const ix = Math.min(inset, Math.max(0, (w - minDim) / 2));
  const iy = Math.min(inset, Math.max(0, (h - minDim) / 2));
  return {
    x1: rect.x1 + ix,
    y1: rect.y1 + iy,
    x2: rect.x2 - ix,
    y2: rect.y2 - iy
  };
}
function overlapsAnyConsumed(cand, consumed) {
  return consumed.some(c => rectIntersectionArea(cand, c) > 0.0005);
}
function softOverlapWithinLimit(cand, softKeepOut, el) {
  for (const k of softKeepOut) {
    const overlap = rectIntersectionArea(cand, k.rect);
    if (overlap === 0) continue;
    const allowedPct = k.strictness < 0.5 ? SOFT_OVERLAP_PCT_LOOSE : SOFT_OVERLAP_PCT;
    const restrictionArea = rectArea(k.rect) || 1;
    if ((overlap / restrictionArea) > allowedPct) return false;
  }
  return true;
}
function insideAny(rect, regions) {
  return regions.some(reg =>
    rect.x1 >= reg.x1 - 0.005 && rect.y1 >= reg.y1 - 0.005 &&
    rect.x2 <= reg.x2 + 0.005 && rect.y2 <= reg.y2 + 0.005
  );
}

// ── Scoring ─────────────────────────────────────────────────────────────

function score(cand, el, analysis, consumed) {
  // Lower density = calmer area = higher score.
  const density = sampleAvg(analysis?.densityGrid, cand);
  // Lower brightness variance = more uniform contrast = higher score.
  const variance = sampleVariance(analysis?.brightnessGrid, cand);
  // Distance from the element's preferred anchor.
  const anchor = regionAnchor(el.region);
  const cx = (cand.x1 + cand.x2) / 2;
  const cy = (cand.y1 + cand.y2) / 2;
  const dist = Math.sqrt((cx - anchor.x) ** 2 + (cy - anchor.y) ** 2);

  // Penalize being adjacent to consumed (avoid crowded compositions).
  let crowding = 0;
  for (const c of consumed) {
    const cd = Math.hypot(((c.x1 + c.x2)/2) - cx, ((c.y1 + c.y2)/2) - cy);
    if (cd < 0.15) crowding += (0.15 - cd) * 4;
  }

  // Shape preference: horizontal/inline variants get a bonus; stacked or
  // pill-narrow shapes carry a penalty so they only win when no preferred-
  // shape candidate is legal. Magnitude is tuned so the preference doesn't
  // override the density/anchor signals — it only breaks near-ties.
  const shapeBonus = cand.preferBonus || 0;

  return -(density * 5 + variance * 3 + dist * 1.2 + crowding) + shapeBonus;
}

function regionAnchor(region) {
  switch (region) {
    case 'top-left':     return { x: 0.12, y: 0.08 };
    case 'top-right':    return { x: 0.88, y: 0.08 };
    case 'top-band':     return { x: 0.50, y: 0.12 };
    case 'mid-band':     return { x: 0.50, y: 0.50 };
    case 'bottom-third': return { x: 0.50, y: 0.85 };
    case 'flex':         return { x: 0.50, y: 0.50 };
    default:             return { x: 0.50, y: 0.50 };
  }
}

// ── Grid sampling ───────────────────────────────────────────────────────

function sampleAvg(grid, rect) {
  if (!grid || !grid.cells || !grid.cols || !grid.rows) return 0.4; // neutral default
  const c0 = Math.max(0, Math.floor(rect.x1 * grid.cols));
  const c1 = Math.min(grid.cols, Math.ceil(rect.x2 * grid.cols));
  const r0 = Math.max(0, Math.floor(rect.y1 * grid.rows));
  const r1 = Math.min(grid.rows, Math.ceil(rect.y2 * grid.rows));
  let sum = 0, n = 0;
  for (let r = r0; r < r1; r++) {
    for (let c = c0; c < c1; c++) {
      const v = grid.cells[r]?.[c];
      if (typeof v === 'number') { sum += v; n++; }
    }
  }
  return n ? sum / n : 0.4;
}

function sampleVariance(grid, rect) {
  if (!grid || !grid.cells || !grid.cols || !grid.rows) return 0.1;
  const c0 = Math.max(0, Math.floor(rect.x1 * grid.cols));
  const c1 = Math.min(grid.cols, Math.ceil(rect.x2 * grid.cols));
  const r0 = Math.max(0, Math.floor(rect.y1 * grid.rows));
  const r1 = Math.min(grid.rows, Math.ceil(rect.y2 * grid.rows));
  const vals = [];
  for (let r = r0; r < r1; r++) {
    for (let c = c0; c < c1; c++) {
      const v = grid.cells[r]?.[c];
      if (typeof v === 'number') vals.push(v);
    }
  }
  if (vals.length < 2) return 0.1;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length;
}

// ── Scrim + text-color helpers ──────────────────────────────────────────

function computeAdaptiveScrim(textColor, brightness, density, rect) {
  // |bg - text|: how big the contrast gap is between bg and the chosen text
  // color. Light text (white = 1.0) on bright bg = small gap → text is hard
  // to read → strong scrim. Dark text (black = 0.0) on dark bg same idea.
  const textL = textColor === '#FFFFFF' ? 1.0 : 0.0;
  const gap = Math.abs(brightness - textL);
  // gap=0 → max scrim; gap=1 → no scrim. Bias mildly by density too.
  let opacity = (1 - gap) * SCRIM_BRIGHTNESS_GAP_K;
  opacity += density * 0.15;
  opacity = Math.max(0, Math.min(0.85, opacity));
  if (opacity < 0.05) return { type: 'none', opacity: 0 };

  // Direction by vertical position.
  const cy = (rect.y1 + rect.y2) / 2;
  let direction = 'full';
  if (cy < 0.35)      direction = 'top-fade';
  else if (cy > 0.65) direction = 'bottom-fade';

  return {
    type:  textColor === '#FFFFFF' ? 'gradient-dark' : 'gradient-light',
    opacity,
    direction
  };
}

function recommendFontScale(el, rect, canvasW, canvasH, maxLinesOverride) {
  // Heuristic: estimate how many characters fit at the default font size,
  // recommend a scale factor down (never up). The renderer/preview can
  // refine via measure-and-shrink at draw time.
  const widthPx  = (rect.x2 - rect.x1) * canvasW;
  const heightPx = (rect.y2 - rect.y1) * canvasH;
  const lines = maxLinesOverride || el.maxLines || 2;
  const baseFontPx   = Math.min(heightPx / lines / 1.25, widthPx / 14);
  const charsPerLine = Math.max(8, Math.floor(widthPx / (baseFontPx * 0.55)));
  const estimatedLines = Math.ceil(el.contentLength / charsPerLine);
  if (estimatedLines <= lines) return 1.0;
  const scale = lines / estimatedLines;
  return Math.max(MIN_FONT_SCALE, Math.min(1.0, scale));
}

function readableOn(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return '#FFFFFF';
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 0xff) / 255;
  const g = ((n >>  8) & 0xff) / 255;
  const b = (n & 0xff)         / 255;
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return L > 0.55 ? '#0A0A0A' : '#FFFFFF';
}

module.exports = { placeOverlays };
