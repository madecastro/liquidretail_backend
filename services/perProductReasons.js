// Per-product expansion outcomes — the reasons a Generate produced (or
// failed to produce) creatives for each product.
//
// WHY THIS MODULE EXISTS. campaignAdsGenerationService already computed
// precise skip codes (empty_universe, no_concepts, no_hero_media, …) and
// logged them, then dropped them before the HTTP response. The operator
// saw only the generic "check imagery and templates" line at
// routes/ads.js, which is actively wrong when the Director returned
// nothing. This module is the single place that:
//   1. normalises raw expansion rows into a UI-safe shape (no payload
//      objects, no cross-tenant leakage of unrelated fields);
//   2. builds the run-level expand message from those rows so a uniform
//      skip says THAT, not the generic fallback;
//   3. stays pure — no mongoose, no network — so the offline harness
//      can assert every code without a DB.
//
// Behaviour of generation is untouched. These helpers only describe it.

'use strict';

// Machine codes. Keep these stable — the UI and the verify harness key
// off the strings, not the human messages.
const REASON = Object.freeze({
  INVALID_PRODUCT_ID:       'invalid_product_id',
  NO_HERO_MEDIA:            'no_hero_media',
  EXCLUDED_PAIRING:         'excluded_pairing',
  EMPTY_UNIVERSE:           'empty_universe',
  NO_CONCEPTS:              'no_concepts',
  // Concepts came back, but every one lacked a usable media_pick in the
  // filtered universe. Used to be a silent console.warn that reduced a
  // 3-concept expansion to zero creatives with no operator-visible reason.
  CONCEPTS_NO_USABLE_MEDIA: 'concepts_no_usable_media',
  ERROR:                    'error'
});

// Non-skip advisory codes. WARNING is explicitly NOT part of REASON because
// REASON implies skipped:true (normalizePerProductEntry treats any reason as a
// skip). A product that DID queue but needs an operator signal — e.g. their
// video picks include no catalog image — stamps `warning` instead. Owner
// 2026-08-05: signal the gap; still generate from their selection.
const WARNING = Object.freeze({
  // A catalog image EXISTS for this product but none of the operator picks
  // is a catalog mirror for it. Generation still ran from their selection.
  NO_CATALOG_IN_PICKS: 'no_catalog_in_picks',
  // The product has NO usable catalog image at all. Generation still ran
  // from their selection only.
  NO_CATALOG_IMAGE:    'no_catalog_image'
});

const HUMAN_WARNING = Object.freeze({
  [WARNING.NO_CATALOG_IN_PICKS]:
    'No catalog image among your selected images — generating from your selection only.',
  [WARNING.NO_CATALOG_IMAGE]:
    'No catalog image available for this product — generating from your selection only.'
});

// Full sentences for a single product row (errors[] / perProduct.message).
const HUMAN_FULL = Object.freeze({
  [REASON.INVALID_PRODUCT_ID]:
    'Invalid product id — this product could not be resolved.',
  [REASON.NO_HERO_MEDIA]:
    'No usable product imagery — this product has no catalog hero media.',
  [REASON.EXCLUDED_PAIRING]:
    'Pairing excluded — the operator excluded this product–media pairing.',
  [REASON.EMPTY_UNIVERSE]:
    'No usable imagery in the seed universe for this product (check picks and exclusions).',
  [REASON.NO_CONCEPTS]:
    'Director returned no concepts for this product.',
  [REASON.CONCEPTS_NO_USABLE_MEDIA]:
    'Director returned concepts but none had usable media in the universe.',
  [REASON.ERROR]:
    'Expansion failed for this product.'
});

// Short phrases for the run-level summary ("2 products: …").
const HUMAN_SHORT = Object.freeze({
  [REASON.INVALID_PRODUCT_ID]:       'invalid product id',
  [REASON.NO_HERO_MEDIA]:            'no usable imagery',
  [REASON.EXCLUDED_PAIRING]:         'pairing excluded',
  [REASON.EMPTY_UNIVERSE]:           'no usable imagery',
  [REASON.NO_CONCEPTS]:              'Director returned no concepts',
  [REASON.CONCEPTS_NO_USABLE_MEDIA]: 'concepts had no usable media picks',
  [REASON.ERROR]:                    'expansion error'
});

// Generic last resort — only when no per-product reason exists at all.
// Kept deliberately cautious: it must not claim a cause we do not know.
const GENERIC_EMPTY_MESSAGE =
  'Nothing to render: this selection produced no creatives.';

/**
 * Human message for one product row.
 * @param {string|null|undefined} reason
 * @param {{ error?: string, errorName?: string }|null} [entry]
 */
function humanMessageForReason(reason, entry) {
  if (!reason) return null;
  if (reason === REASON.ERROR) {
    const name = (entry && entry.errorName) || 'Error';
    const msg  = (entry && entry.error) || 'unknown error';
    return `${name}: ${msg}`;
  }
  return HUMAN_FULL[reason] || `Skipped (${reason}).`;
}

/**
 * Human clause for a non-skip warning code. Generation still ran — these
 * sentences make that clear so the operator knows the choice was theirs.
 * @param {string|null|undefined} code
 * @returns {string|null}
 */
function humanMessageForWarning(code) {
  if (!code) return null;
  return HUMAN_WARNING[code] || null;
}

/**
 * Normalise one raw expansion row into the shape persisted on CampaignRun
 * and returned by GET /runs. Strips full Ad payload objects (they are
 * large and not UI-useful) down to a count.
 *
 * Never throws — a bad row becomes a best-effort entry.
 *
 * @param {object|null|undefined} raw
 * @param {Record<string,string>} [nameById] productId → title
 */
function normalizePerProductEntry(raw, nameById = {}) {
  try {
    if (!raw || typeof raw !== 'object') {
      return {
        productId: null,
        productName: null,
        reason: REASON.ERROR,
        message: 'Malformed per-product entry.',
        skipped: true,
        payloads: 0
      };
    }

    const productId = raw.productId != null && raw.productId !== ''
      ? String(raw.productId)
      : null;

    const payloadCount = Array.isArray(raw.payloads)
      ? raw.payloads.length
      : (typeof raw.payloads === 'number' ? raw.payloads : 0);

    // `skipped` is the machine code from the expansion path. When concepts
    // all lacked usable media, the expansion stamps concepts_no_usable_media
    // rather than leaving an empty payloads array with no reason.
    const reason = raw.skipped || raw.reason || null;
    const skipped = !!reason;

    const productName =
      raw.productName ||
      (productId && nameById[productId]) ||
      null;

    let message = skipped
      ? (humanMessageForReason(reason, raw) || `Skipped (${reason}).`)
      : (payloadCount > 0
          ? `Queued ${payloadCount} creative(s).`
          : 'No creatives queued for this product.');

    // Warning is a SEPARATE channel from reason. When the product skipped,
    // the skip message wins and raw.warning is ignored entirely. When it
    // queued, append a human clause so the operator sees both the success
    // and the advisory (e.g. "Queued 1 creative(s). No catalog image …").
    // skipped must stay false for a warning-only row — never fold warning
    // into reason (that would mark the product skipped:true and overwrite
    // the "Queued N" message).
    let warning = null;
    if (!skipped && raw.warning != null && raw.warning !== '') {
      warning = String(raw.warning);
      const clause = humanMessageForWarning(warning);
      if (clause) {
        message = `${message} ${clause}`;
      }
    }

    const entry = {
      productId,
      productName: productName ? String(productName) : null,
      reason: reason || null,
      message,
      skipped,
      payloads: payloadCount
    };
    if (warning) entry.warning = warning;

    // Actionable ids — only include fields the reason makes relevant so
    // the payload stays small and the UI can deep-link without guessing.
    if (raw.mediaId) entry.mediaId = String(raw.mediaId);
    if (Array.isArray(raw.referenceMediaIds) && raw.referenceMediaIds.length) {
      entry.mediaIds = raw.referenceMediaIds.map(String);
    } else if (Array.isArray(raw.mediaIds) && raw.mediaIds.length) {
      entry.mediaIds = raw.mediaIds.map(String);
    }

    if (raw.conceptCount != null) entry.conceptCount = Number(raw.conceptCount) || 0;
    if (Array.isArray(raw.conceptSkips) && raw.conceptSkips.length) {
      // conceptId + reason (+ mediaId when the pick was out of universe).
      // Cap length so a noisy Director cannot bloat the run doc.
      entry.conceptSkips = raw.conceptSkips.slice(0, 20).map(s => {
        const out = {
          conceptId: s && s.conceptId != null ? String(s.conceptId) : null,
          reason:    s && s.reason != null ? String(s.reason) : 'unknown'
        };
        if (s && s.mediaId) out.mediaId = String(s.mediaId);
        return out;
      });
    }

    if (Array.isArray(raw.capped) && raw.capped.length) {
      entry.capped = raw.capped.map(c => ({
        kind:    c.kind || null,
        format:  c.format || null,
        before:  Number(c.before) || 0,
        after:   Number(c.after) || 0,
        dropped: Number(c.dropped) || 0
      }));
    }
    if (raw.payloadsBeforeCap != null) {
      entry.payloadsBeforeCap = Number(raw.payloadsBeforeCap) || 0;
    }

    // Director round-contract reasons (validateDirectorPayload) — the same
    // array the 'director:contract-warn' Slack alert already carries
    // (aiCreativeDirectorService.js directConceptsRound). Independent of
    // `warning`/`reason`: it describes the ROUND, not this product's skip
    // status, so it is copied through regardless of `skipped`. Capped at 6
    // to match the Slack alert's reasons.slice(0, 6) — this is not the place
    // to carry more detail than the alert that already exists for it.
    if (Array.isArray(raw.directorContractWarnings) && raw.directorContractWarnings.length) {
      entry.directorContractWarnings = raw.directorContractWarnings.slice(0, 6).map(String);
    }

    if (reason === REASON.ERROR) {
      if (raw.error) entry.error = String(raw.error);
      if (raw.errorName) entry.errorName = String(raw.errorName);
      // LLM failure taxonomy (services/llmError.js). Copied here or it never
      // reaches CampaignRun.perProduct — this normaliser is the only writer,
      // and a field it does not copy is a field the operator never sees.
      if (raw.errorCode) entry.errorCode = String(raw.errorCode);
      if (raw.errorAction) entry.errorAction = String(raw.errorAction);
      if (raw.errorChain) entry.errorChain = String(raw.errorChain);
    }

    return entry;
  } catch (_) {
    // Reporting must never fail a generation.
    return {
      productId: raw && raw.productId != null ? String(raw.productId) : null,
      productName: null,
      reason: REASON.ERROR,
      message: 'Failed to normalise per-product entry.',
      skipped: true,
      payloads: 0
    };
  }
}

/**
 * @param {Array|null|undefined} list
 * @param {Record<string,string>} [nameById]
 */
function normalizePerProductList(list, nameById = {}) {
  if (!Array.isArray(list)) return [];
  return list.map(r => normalizePerProductEntry(r, nameById));
}

/**
 * Run-level expand message when newlyQueued === 0.
 *
 * Rules (owner, 2026-08-02):
 *   - all products skipped for the SAME reason → say that reason
 *   - mixed reasons → summarise counts per short phrase
 *   - no per-product reason at all → generic last resort (NOT the old
 *     "check imagery and templates" line, which was often a lie)
 *   - alreadyQueued > 0 → the identity-digest collision path (already
 *     queued) wins over empty-selection wording
 *
 * @param {{
 *   perProduct?: Array,
 *   alreadyQueued?: number
 * }} opts
 * @returns {string}
 */
function summarizeEmptyExpansion(opts = {}) {
  try {
    const alreadyQueued = Number(opts.alreadyQueued) || 0;
    if (alreadyQueued > 0) {
      return `Nothing new to render: all ${alreadyQueued} creative(s) for this selection are already queued.`;
    }

    const rows = Array.isArray(opts.perProduct) ? opts.perProduct : [];
    // Only rows that actually skipped contribute to the cause. A success
    // row with payloads:0 and no reason is treated as unknown.
    const skipped = rows.filter(r => r && (r.reason || r.skipped === true || (typeof r.skipped === 'string' && r.skipped)));
    const reasons = skipped.map(r => {
      if (typeof r.reason === 'string' && r.reason) return r.reason;
      if (typeof r.skipped === 'string' && r.skipped) return r.skipped;
      return null;
    }).filter(Boolean);

    if (!reasons.length) {
      return GENERIC_EMPTY_MESSAGE;
    }

    // Uniform reason across every skipped product.
    const unique = [...new Set(reasons)];
    if (unique.length === 1) {
      const code = unique[0];
      const n = reasons.length;
      const unit = n === 1 ? 'product' : 'products';
      switch (code) {
        case REASON.NO_HERO_MEDIA:
        case REASON.EMPTY_UNIVERSE:
          return `Nothing to render: no usable imagery for ${n} ${unit}.`;
        case REASON.NO_CONCEPTS:
          return `Nothing to render: Director returned no concepts for ${n} ${unit}.`;
        case REASON.CONCEPTS_NO_USABLE_MEDIA:
          return `Nothing to render: Director concepts had no usable media picks for ${n} ${unit}.`;
        case REASON.EXCLUDED_PAIRING:
          return `Nothing to render: ${n} ${unit} excluded by pairing filter.`;
        case REASON.INVALID_PRODUCT_ID:
          return `Nothing to render: ${n} invalid product id(s).`;
        case REASON.ERROR: {
          // Prefer the concrete error text when there is exactly one product
          // so a ReferenceError surfaces as itself, not "expansion error".
          if (n === 1 && skipped[0]) {
            const detail = humanMessageForReason(REASON.ERROR, skipped[0]);
            return `Nothing to render: ${detail}`;
          }
          return `Nothing to render: expansion error for ${n} ${unit}.`;
        }
        default:
          return `Nothing to render: ${n} ${unit} skipped (${HUMAN_SHORT[code] || code}).`;
      }
    }

    // Mixed reasons — group by short phrase so "no_hero_media" and
    // "empty_universe" collapse into one "no usable imagery" bucket.
    const counts = new Map();
    for (const code of reasons) {
      const phrase = HUMAN_SHORT[code] || code;
      counts.set(phrase, (counts.get(phrase) || 0) + 1);
    }
    const parts = [...counts.entries()].map(([phrase, n]) => {
      const unit = n === 1 ? 'product' : 'products';
      return `${n} ${unit}: ${phrase}`;
    });
    return `Nothing to render: ${parts.join('; ')}.`;
  } catch (_) {
    return GENERIC_EMPTY_MESSAGE;
  }
}

module.exports = {
  REASON,
  WARNING,
  HUMAN_FULL,
  HUMAN_SHORT,
  HUMAN_WARNING,
  GENERIC_EMPTY_MESSAGE,
  humanMessageForReason,
  humanMessageForWarning,
  normalizePerProductEntry,
  normalizePerProductList,
  summarizeEmptyExpansion
};
