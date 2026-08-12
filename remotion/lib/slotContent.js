// Pure slot content resolution for the title-spec interpreter.
// Kept free of React/Remotion so offline harnesses can drive the same
// decision the composition uses (visibleWhenEmpty, bind chains, caps).

// Word-safe display cap: never cut mid-word; ellipsis only BETWEEN words.
// Used for productName (close-phase / endcard lead) and multi-item strings
// that previously hard-sliced. If no space exists in the first half of the
// window, fall back to a hard cut so pathological one-word titles still fit.
export function truncateWordSafe(str, maxLen) {
  const s = String(str ?? '').replace(/\s+/g, ' ').trim();
  if (!maxLen || maxLen < 1 || s.length <= maxLen) return s;
  const window = s.slice(0, maxLen);
  let cut = window.lastIndexOf(' ');
  if (cut < Math.floor(maxLen * 0.5)) cut = maxLen;
  const out = s.slice(0, cut).trimEnd();
  return out.length < s.length ? `${out}…` : out;
}

// Per-slot character caps for on-screen text. productName is the one that
// previously printed mid-word SKU titles on the close phase ("…(Dark…").
//
// These numbers are the HISTORICAL global ceiling (calibrated for Meta
// vertical's near-full-width stack). They remain the no-context default so
// every pre-existing caller is byte-identical — see deriveCharCap.
export const TEXT_CHAR_CAP = {
  productName: 48,
  headline: 72,
  quote: 120,
  deliveryLine: 40,
  badge: 28,
  promo: 28,
  productDescription: 80,
  tagline: 56,
};

// ── Format-aware cap derivation (2026-08-12, model v2) ─────────────────────
//
// THE DEFECT. TEXT_CHAR_CAP was a single global table. resolveSlotContent
// applied it with no knowledge of format, slot width, line count, or font
// size. The identical 72-char headline was asked to fit both Meta vertical
// 9:16 (full-width, 3-line, ~82px type) and PMax landscape 16:9 (0.46
// width, 2-line, 72px type). Width-fraction scaling alone (v1) tightened
// landscape but left vertical at 72 — yet a delivered Marine Layer 9:16
// still clamp-cut at ~51 chars via CSS -webkit-line-clamp. The char cap
// never fired; the browser did the cutting, mid-phrase, not word-safe.
//
// MODEL (matches services/videoHeadlineService.js header arithmetic):
//   chars ≈ (usableWidthPx × maxLines) / (AVG_CHAR_WIDTH_EM × fontPx)
//         × CHAR_CAP_SAFETY
//   AVG_CHAR_WIDTH_EM = 0.70  (from a delivered landscape clip:
//     2 lines × 883px box / 35 chars / 72px ≈ 0.70em)
//   CHAR_CAP_SAFETY   = 0.91  (32/35 — same margin videoHeadlineService uses)
//
// TWO REAL DELIVERED ARTEFACTS this model reproduces:
//   landscape headline: 0.46×1920=883px, maxLines 2, font 72px
//     → 883×2/(0.70×72)=35; ×0.91≈32  (= LANDSCAPE_HEADLINE_BUDGET_CHARS)
//   vertical headline:  0.9×1080=972px, maxLines 3, font 68×1.2=81.6px
//     → 972×3/(0.70×81.6)=51; ×0.91≈46  (= VERTICAL_HEADLINE_BUDGET_CHARS)
//
// No hardcoded per-format cap table — derive from box geometry. Absent/
// empty ctx still returns TEXT_CHAR_CAP byte-identical (inertness). Never
// expand past the historical base; never go below TEXT_CHAR_FLOOR.

/** Average glyph width in em — videoHeadlineService measured ~0.70. */
export const AVG_CHAR_WIDTH_EM = 0.70;
/**
 * Safety margin applied after the geometric estimate (32/35 ≈ 0.91).
 * Being slightly tight costs a shorter pick; being loose reopens clamp cuts.
 */
export const CHAR_CAP_SAFETY = 0.91;

/** Vertical/hook headline maxWidthPct — historical full-width reference. */
export const CAP_REF_MAX_WIDTH_PCT = 0.9;
/** Landscape preset: every text slot in canonical.json byFormat.landscape. */
export const LANDSCAPE_DEFAULT_MAX_WIDTH_PCT = 0.46;
/**
 * Panel column width under landscapeYt west, as fraction of frame.
 * half − gutter/2 − left = 0.5 − 0.02 − 0.075 = 0.405 (safeZones.js).
 */
export const PANEL_DEFAULT_WIDTH_FRAC = 0.405;
/**
 * Full-width safe stack as fraction of frame (canvas landscape/vertical
 * left+right 0.075 each). Kept for callers/harnesses that still reason in
 * stack-fraction units; the char model uses canvas-relative usableWidthPx.
 */
export const FULL_STACK_WIDTH_FRAC = 0.85;

/**
 * Native composition widths (remotion/Root.jsx). Used when ctx.canvasWidth
 * is absent — Canonical always passes the live width.
 */
export const CANVAS_WIDTH_DEFAULT = Object.freeze({
  vertical: 1080,
  feed: 1080,
  square: 1080,
  landscape: 1920,
});

/**
 * Default maxWidthPct when the caller only supplies format (canonical.json
 * primary entries: hook/main). Vertical/feed/square headline/stack ~0.9;
 * landscape every text slot 0.46.
 */
export const DEFAULT_MAX_WIDTH_PCT = Object.freeze({
  vertical: CAP_REF_MAX_WIDTH_PCT,
  feed: CAP_REF_MAX_WIDTH_PCT,
  square: CAP_REF_MAX_WIDTH_PCT,
  landscape: LANDSCAPE_DEFAULT_MAX_WIDTH_PCT,
});

/**
 * Default maxLines per slot×format from remotion/presets/canonical.json
 * primary (hook/main/close) entries. Missing pair → 2 (safe generic).
 * When a value genuinely isn't at the call site, fall back HERE rather
 * than guessing a tighter number silently in deriveCharCap.
 */
export const DEFAULT_MAX_LINES = Object.freeze({
  headline: Object.freeze({ vertical: 3, feed: 2, square: 2, landscape: 2 }),
  quote: Object.freeze({ vertical: 3, feed: 2, square: 1, landscape: 2 }),
  productName: Object.freeze({ vertical: 2, feed: 2, square: 1, landscape: 2 }),
  productDescription: Object.freeze({ vertical: 3, feed: 2, square: 2, landscape: 2 }),
  tagline: Object.freeze({ vertical: 2, feed: 2, square: 1, landscape: 2 }),
  deliveryLine: Object.freeze({ vertical: 1, feed: 1, square: 1, landscape: 1 }),
  badge: Object.freeze({ vertical: 1, feed: 1, square: 1, landscape: 1 }),
  promo: Object.freeze({ vertical: 1, feed: 1, square: 1, landscape: 1 }),
});

/**
 * Base font px per slot×format — mirrors remotion/components/slotRenderers.jsx
 * BASE_SIZE (square aliases feed). Kept here so offline harnesses do not
 * import React. Live renders pass ctx.fontPx from baseSize() instead.
 */
export const DEFAULT_BASE_FONT_PX = Object.freeze({
  headline: Object.freeze({ vertical: 68, feed: 44, square: 44, landscape: 60 }),
  quote: Object.freeze({ vertical: 56, feed: 30, square: 30, landscape: 36 }),
  productName: Object.freeze({ vertical: 56, feed: 36, square: 36, landscape: 54 }),
  productDescription: Object.freeze({ vertical: 30, feed: 22, square: 22, landscape: 26 }),
  tagline: Object.freeze({ vertical: 40, feed: 28, square: 28, landscape: 34 }),
  deliveryLine: Object.freeze({ vertical: 22, feed: 16, square: 16, landscape: 22 }),
  badge: Object.freeze({ vertical: 24, feed: 18, square: 18, landscape: 22 }),
  promo: Object.freeze({ vertical: 26, feed: 20, square: 20, landscape: 24 }),
});

/**
 * Default sizeScale for the primary (hook/main) instance of each slot in
 * canonical.json. Font px = base × sizeScale (videoHeadlineService uses
 * headline vertical 68×1.2=81.6 and landscape 60×1.2=72).
 */
export const DEFAULT_SIZE_SCALE = Object.freeze({
  headline: Object.freeze({ vertical: 1.2, feed: 1.2, square: 1.2, landscape: 1.2 }),
  quote: Object.freeze({ vertical: 1.15, feed: 1.15, square: 1.15, landscape: 1.15 }),
  productName: Object.freeze({ vertical: 1.2, feed: 1.2, square: 1.2, landscape: 1.2 }),
  productDescription: Object.freeze({ vertical: 1, feed: 1, square: 1, landscape: 1 }),
  tagline: Object.freeze({ vertical: 1, feed: 1, square: 1, landscape: 1 }),
  deliveryLine: Object.freeze({ vertical: 1.265, feed: 1.265, square: 1.265, landscape: 1.265 }),
  badge: Object.freeze({ vertical: 1, feed: 1, square: 1, landscape: 1 }),
  promo: Object.freeze({ vertical: 1, feed: 1, square: 1, landscape: 1 }),
});

/**
 * Readable floors per slot role. A derived cap below the floor is kept at
 * the floor — layout owns the overflow, we do not emit single-word stubs.
 * Headline floor 32 = videoHeadlineService's empirically grounded landscape
 * selection budget. Never expand above TEXT_CHAR_CAP.
 */
export const TEXT_CHAR_FLOOR = {
  productName: 24,
  headline: 32,
  quote: 48,
  deliveryLine: 18,
  badge: 12,
  promo: 12,
  productDescription: 32,
  tagline: 24,
};

const KNOWN_FORMATS = new Set(['vertical', 'feed', 'square', 'landscape']);

/**
 * Resolve usable width in PIXELS for the text box.
 * Prefers ctx.usableWidthPx (Canonical computes it from dims + container).
 * Else: maxWidthPct × canvasWidth, min'd with panel width when panel is on.
 * Returns null → caller keeps TEXT_CHAR_CAP (inertness / malformed).
 *
 * @param {object|null|undefined} ctx
 * @returns {number|null}
 */
export function resolveUsableWidthPx(ctx) {
  if (ctx == null || typeof ctx !== 'object') return null;

  if (Number.isFinite(ctx.usableWidthPx) && ctx.usableWidthPx > 0) {
    return ctx.usableWidthPx;
  }

  const format = ctx.format;
  const panelOn = ctx.panelColumn === true
    || ctx.panelSide === 'west'
    || ctx.panelSide === 'east';

  // Unknown non-empty format without an explicit canvasWidth → inert.
  // Do not invent canvas dims for "nope"/typos.
  if (format != null && format !== '' && !KNOWN_FORMATS.has(format)
    && !(Number.isFinite(ctx.canvasWidth) && ctx.canvasWidth > 0)) {
    return null;
  }

  let canvasW = null;
  if (Number.isFinite(ctx.canvasWidth) && ctx.canvasWidth > 0) {
    canvasW = ctx.canvasWidth;
  } else if (KNOWN_FORMATS.has(format)) {
    canvasW = CANVAS_WIDTH_DEFAULT[format];
  } else if (panelOn) {
    // Panel is a landscape-only placement; no format → assume landscape canvas.
    // Documented fallback — Canonical always passes canvasWidth live.
    canvasW = CANVAS_WIDTH_DEFAULT.landscape;
  }

  if (!Number.isFinite(canvasW) || canvasW <= 0) return null;

  let maxW = null;
  if (Number.isFinite(ctx.maxWidthPct) && ctx.maxWidthPct > 0 && ctx.maxWidthPct <= 1.5) {
    maxW = ctx.maxWidthPct;
  } else if (KNOWN_FORMATS.has(format)) {
    maxW = DEFAULT_MAX_WIDTH_PCT[format];
  }

  let fromPct = (maxW != null && Number.isFinite(maxW)) ? maxW * canvasW : null;

  if (panelOn) {
    const panelFrac = Number.isFinite(ctx.panelWidthFrac) && ctx.panelWidthFrac > 0
      ? ctx.panelWidthFrac
      : PANEL_DEFAULT_WIDTH_FRAC;
    const panelPx = panelFrac * canvasW;
    if (!Number.isFinite(panelPx) || panelPx <= 0) {
      // Bad panel dims → ignore panel, keep fromPct if any.
    } else if (fromPct == null) {
      fromPct = panelPx;
    } else {
      // Min of authored max width and panel column — same unit (px of frame).
      // Product of maxWidthPct × panel would double-narrow the left column.
      fromPct = Math.min(fromPct, panelPx);
    }
  }

  if (fromPct == null || !Number.isFinite(fromPct) || fromPct <= 0) return null;
  return fromPct;
}

/**
 * Resolve effective maxWidthPct (fraction of canvas) for harnesses / legacy
 * callers. Prefer resolveUsableWidthPx for the char model.
 * Returns null when no usable width signal (inertness).
 */
export function resolveEffectiveMaxWidthPct(ctx) {
  if (ctx == null || typeof ctx !== 'object') return null;
  const px = resolveUsableWidthPx(ctx);
  if (px == null) return null;

  let canvasW = null;
  if (Number.isFinite(ctx.canvasWidth) && ctx.canvasWidth > 0) {
    canvasW = ctx.canvasWidth;
  } else if (KNOWN_FORMATS.has(ctx.format)) {
    canvasW = CANVAS_WIDTH_DEFAULT[ctx.format];
  } else if (ctx.panelColumn === true || ctx.panelSide === 'west' || ctx.panelSide === 'east') {
    canvasW = CANVAS_WIDTH_DEFAULT.landscape;
  }
  if (!Number.isFinite(canvasW) || canvasW <= 0) return null;
  const frac = px / canvasW;
  return Number.isFinite(frac) && frac > 0 ? frac : null;
}

/**
 * Resolve maxLines for a slot under ctx. Explicit ctx.maxLines wins;
 * else DEFAULT_MAX_LINES[slot][format]; else 2.
 */
export function resolveMaxLines(slotKey, ctx) {
  if (ctx && Number.isFinite(ctx.maxLines) && ctx.maxLines > 0) {
    return Math.max(1, Math.floor(ctx.maxLines));
  }
  const format = ctx && KNOWN_FORMATS.has(ctx.format) ? ctx.format : null;
  const table = DEFAULT_MAX_LINES[slotKey];
  if (table && format && Number.isFinite(table[format])) return table[format];
  // Documented generic fallback when format/slot pair is missing.
  return 2;
}

/**
 * Resolve font size in px. Explicit ctx.fontPx wins (Canonical passes
 * baseSize()). Else DEFAULT_BASE_FONT_PX × sizeScale (ctx or default).
 * Returns null only when even the generic fallback would be invalid.
 */
export function resolveFontPx(slotKey, ctx) {
  if (ctx && Number.isFinite(ctx.fontPx) && ctx.fontPx > 0) {
    return ctx.fontPx;
  }
  const format = ctx && KNOWN_FORMATS.has(ctx.format) ? ctx.format : 'vertical';
  const baseTable = DEFAULT_BASE_FONT_PX[slotKey];
  const base = (baseTable && Number.isFinite(baseTable[format]))
    ? baseTable[format]
    : (baseTable && Number.isFinite(baseTable.vertical) ? baseTable.vertical : 24);
  let scale = 1;
  if (ctx && Number.isFinite(ctx.sizeScale) && ctx.sizeScale > 0) {
    scale = ctx.sizeScale;
  } else {
    const scaleTable = DEFAULT_SIZE_SCALE[slotKey];
    if (scaleTable && Number.isFinite(scaleTable[format])) scale = scaleTable[format];
    else if (scaleTable && Number.isFinite(scaleTable.vertical)) scale = scaleTable.vertical;
  }
  const px = base * scale;
  return Number.isFinite(px) && px > 0 ? px : null;
}

/**
 * True when ctx carries enough layout signal to leave the inert baseline.
 * Empty / null / unknown-format-only → false (TEXT_CHAR_CAP unchanged).
 */
export function hasCapContext(ctx) {
  if (ctx == null || typeof ctx !== 'object') return false;
  if (Number.isFinite(ctx.usableWidthPx) && ctx.usableWidthPx > 0) return true;
  if (KNOWN_FORMATS.has(ctx.format)) return true;
  if (Number.isFinite(ctx.maxWidthPct) && ctx.maxWidthPct > 0 && ctx.maxWidthPct <= 1.5) {
    // Need a canvas to turn pct into px — format default or explicit.
    if (Number.isFinite(ctx.canvasWidth) && ctx.canvasWidth > 0) return true;
    if (KNOWN_FORMATS.has(ctx.format)) return true;
    // Panel implies landscape canvas default.
    if (ctx.panelColumn === true || ctx.panelSide === 'west' || ctx.panelSide === 'east') return true;
  }
  if (ctx.panelColumn === true || ctx.panelSide === 'west' || ctx.panelSide === 'east') return true;
  return false;
}

/**
 * Derive the character cap for a slot key under optional layout context.
 * Absent/malformed context → exact TEXT_CHAR_CAP[key] (inertness).
 * Never returns below TEXT_CHAR_FLOOR[key]; never above TEXT_CHAR_CAP[key].
 *
 * Model: round((usableWidthPx × maxLines) / (AVG_CHAR_WIDTH_EM × fontPx)
 *              × CHAR_CAP_SAFETY)
 *
 * @param {string} slotKey
 * @param {object|null|undefined} ctx  {
 *   format, canvasWidth, usableWidthPx, maxWidthPct, maxLines, fontPx,
 *   sizeScale, panelColumn, panelSide, panelWidthFrac
 * }
 * @returns {number|null}  null when the key has no cap (uncapped slot)
 */
export function deriveCharCap(slotKey, ctx) {
  const base = TEXT_CHAR_CAP[slotKey];
  if (base == null) return null;

  if (!hasCapContext(ctx)) return base;

  const usableWidthPx = resolveUsableWidthPx(ctx);
  if (usableWidthPx == null || !Number.isFinite(usableWidthPx) || usableWidthPx <= 0) {
    return base;
  }

  const maxLines = resolveMaxLines(slotKey, ctx);
  const fontPx = resolveFontPx(slotKey, ctx);
  if (!Number.isFinite(maxLines) || maxLines <= 0) return base;
  if (!Number.isFinite(fontPx) || fontPx <= 0) return base;

  const denom = AVG_CHAR_WIDTH_EM * fontPx;
  if (!Number.isFinite(denom) || denom <= 0) return base;

  const raw = (usableWidthPx * maxLines) / denom;
  if (!Number.isFinite(raw) || raw <= 0) return base;

  const derived = Math.round(raw * CHAR_CAP_SAFETY);
  if (!Number.isFinite(derived)) return base;

  const floor = TEXT_CHAR_FLOOR[slotKey] != null
    ? TEXT_CHAR_FLOOR[slotKey]
    : Math.min(base, 12);
  // Floor first (readable minimum), then ceiling at historical base.
  // Never expand past TEXT_CHAR_CAP — the historical number is a ceiling.
  return Math.min(base, Math.max(floor, derived));
}

// Extract the value a bind-chain entry contributes at this render.
// Entries are either meta field names (strings) OR literal fallback
// objects ({ literal: <value> }). Literals always "win" if reached —
// they're the operator's "if nothing else, show this" floor.
export function extractBindEntry(entry, meta) {
  if (entry && typeof entry === 'object' && Object.prototype.hasOwnProperty.call(entry, 'literal')) {
    return entry.literal;
  }
  return meta?.[entry];
}

/**
 * Core resolver — bind chains, rating composite, multi/image/text.
 * Does NOT apply visibleWhenEmpty (call resolveSlotContent for that).
 *
 * @param {object} slot
 * @param {object} meta
 * @param {object|null} [ctx]  optional layout context for deriveCharCap;
 *   absent/null → TEXT_CHAR_CAP byte-identical to pre-2026-08-12.
 */
export function resolveSlotContentCore(slot, meta, ctx = null) {
  const brandMode = meta?.endcardMode === 'brand';
  if (!slot.visible) return null;
  if (brandMode && slot.brandMode === 'hide') return null;

  if (slot.key === 'rating') {
    const rating = Number(meta?.rating);
    const hasRating = Number.isFinite(rating) && rating > 0;
    // NO UNSCOPED FALLBACK. services/ratingDisplay.js builds reviewsText WITH
    // its tier qualifier already attached — "15545 brand reviews" for a brand
    // aggregate, "523 reviews" for this SKU's own — and it returns a string
    // whenever reviewCount is non-null, so on the normal path this fallback was
    // unreachable.
    //
    // It was still a live trap, and the exact one the qualifier exists to close:
    // ANY producer that sets reviewCount without reviewsText (a tenant
    // Brand.metaCascades entry, a hand-built meta, a future caller) would have
    // typeset a BARE "15545 reviews" next to one product — asserting a
    // catalog-wide total as that SKU's own review volume. ratingDisplay's own
    // docstring claims "There is no such hole now"; this line was the hole,
    // sitting in the renderer where that docstring could not see it.
    //
    // Fail closed: no qualifier, no count. The slot then hides unless a rating
    // is present, which is the correct rendering of proof we cannot scope.
    const reviewsText = meta?.reviewsText || '';
    // Owner's ">4.5 stars only" rule can suppress a real-but-low rating
    // upstream (services/ratingDisplay.js sends rating:null in that case)
    // while the brand still has review volume worth showing (e.g. GymShark:
    // 41,000 reviews, 3.3 stars — correctly suppressed but not nothing to say).
    // Only hide the slot when there is truly neither a rating nor a count.
    if (!hasRating && !reviewsText) return null;
    return {
      // null (not 0, not 5) so the renderer can tell "no stars" apart from
      // "zero stars" — clamp only applies once we know it's a real rating.
      rating: hasRating ? Math.min(5, Math.max(0, rating)) : null,
      reviewsText,
    };
  }

  const chain = brandMode && slot.brandModeBind ? slot.brandModeBind : slot.bind;

  // Multi-value slots return the source array (capped at maxItems, empty
  // slots skipped). Bind chain picks the first non-empty array; a
  // literal entry always short-circuits with its embedded array.
  if (slot.slotType === 'multi') {
    for (const entry of chain || []) {
      const arr = extractBindEntry(entry, meta);
      if (Array.isArray(arr) && arr.length > 0) {
        const cap = slot.treatment?.maxItems ?? 4;
        const itemCharCap = 40;
        const items = arr
          .filter((v) => v != null && String(v).trim() !== '')
          .map((v) => truncateWordSafe(String(v).trim(), itemCharCap))
          .slice(0, cap);
        if (items.length > 0) return items;
      }
    }
    return null;
  }

  // Image slots return the URL string.
  if (slot.slotType === 'image') {
    for (const entry of chain || []) {
      const v = extractBindEntry(entry, meta);
      if (typeof v === 'string' && v.trim() !== '') return v.trim();
    }
    return null;
  }

  // Text: first non-empty stringified value in the bind chain.
  for (const entry of chain || []) {
    const v = extractBindEntry(entry, meta);
    if (v != null && String(v).trim() !== '') {
      const raw = String(v).trim();
      // Enrich ctx from the slot when the caller only passed format/dims:
      // maxWidthPct, maxLines, sizeScale from the preset entry. Explicit
      // ctx fields always win (already on ctx). fontPx is left alone —
      // Canonical passes baseSize(); offline callers get DEFAULT_BASE_FONT.
      let capCtx = ctx;
      if (ctx && typeof ctx === 'object') {
        const enrich = {};
        if (ctx.maxWidthPct == null && slot.position
          && Number.isFinite(slot.position.maxWidthPct)) {
          enrich.maxWidthPct = slot.position.maxWidthPct;
        }
        if (ctx.maxLines == null && slot.treatment
          && Number.isFinite(slot.treatment.maxLines) && slot.treatment.maxLines > 0) {
          enrich.maxLines = slot.treatment.maxLines;
        }
        if (ctx.sizeScale == null && slot.treatment
          && Number.isFinite(slot.treatment.sizeScale) && slot.treatment.sizeScale > 0) {
          enrich.sizeScale = slot.treatment.sizeScale;
        }
        if (Object.keys(enrich).length > 0) capCtx = { ...ctx, ...enrich };
      }
      const charCap = deriveCharCap(slot.key, capCtx);
      return charCap ? truncateWordSafe(raw, charCap) : raw;
    }
  }
  return null;
}

/**
 * Full resolver including optional `visibleWhenEmpty: "<slotKey>"`.
 * When set, this slot renders ONLY if the named sibling resolves to no
 * content for this meta (e.g. claim restated when quote is gated empty).
 *
 * Sibling check uses the CORE resolver only — never sibling.visibleWhenEmpty —
 * so cycles cannot form. `allSlots` is the format's full slots array.
 *
 * @param {object} slot
 * @param {object} meta
 * @param {object[]|null} [allSlots]
 * @param {object|null} [ctx]  optional layout context for deriveCharCap
 */
export function resolveSlotContent(slot, meta, allSlots = null, ctx = null) {
  if (slot.visibleWhenEmpty) {
    const siblingKey = slot.visibleWhenEmpty;
    const sibling = Array.isArray(allSlots)
      ? allSlots.find((s) => s.key === siblingKey)
      : null;
    // Missing sibling → treat as empty (validator should have rejected).
    if (sibling) {
      const sibContent = resolveSlotContentCore(sibling, meta, ctx);
      if (sibContent != null) return null;
    }
  }
  return resolveSlotContentCore(slot, meta, ctx);
}
