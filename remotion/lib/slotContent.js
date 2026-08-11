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
 */
export function resolveSlotContentCore(slot, meta) {
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
      const charCap = TEXT_CHAR_CAP[slot.key];
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
 */
export function resolveSlotContent(slot, meta, allSlots = null) {
  if (slot.visibleWhenEmpty) {
    const siblingKey = slot.visibleWhenEmpty;
    const sibling = Array.isArray(allSlots)
      ? allSlots.find((s) => s.key === siblingKey)
      : null;
    // Missing sibling → treat as empty (validator should have rejected).
    if (sibling) {
      const sibContent = resolveSlotContentCore(sibling, meta);
      if (sibContent != null) return null;
    }
  }
  return resolveSlotContentCore(slot, meta);
}
