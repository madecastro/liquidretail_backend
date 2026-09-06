// Runtime resolver for the meta-field cascade engine.
//
// Given a cascade config (default + optional per-brand overrides) and a
// context of loaded documents, produce the meta blob the titling engine
// consumes. Every field the pipeline used to compute inline in
// buildMetaForAd is now data-driven — brands can point a field's
// cascade at different sources, add literals, or reorder tiers without
// a code change.
//
// Public surface:
//   resolveMeta(cascades, context, options?)
//     → { <field>: value, ... } for every field in the merged cascade
//   resolveField(sources, context)
//     → { value, sourceIndex, sourceTrace } for one field (used by inspector)
//   validateBrandOverrides(overrides)
//     → { ok, errors, normalized } for PATCH validation
//   mergeCascades(defaults, brandOverrides)
//     → { <field>: sources[] } with brand overrides replacing defaults
//     entirely (per-field, not per-source)

'use strict';

const {
  DEFAULT_META_CASCADES,
  CASCADED_FIELDS,
  CONTEXT_DOC_NAMES,
} = require('./metaCascadeConfig');

// ── Path resolution ────────────────────────────────────────────────
//
// Supports dot notation with `[N]` array indexes: `input.product.badges[0]`.
// Missing intermediate values return `undefined` (the caller treats that
// as "skip this source"). No exceptions raised for shape mismatches.

function getPath(obj, pathStr) {
  if (obj == null || !pathStr) return undefined;
  // Normalize `[0]` → `.0` then split on dots. `foo.bar[0].baz` → ['foo','bar','0','baz'].
  const parts = String(pathStr).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur = obj;
  for (const key of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

// ── Emptiness semantics ────────────────────────────────────────────
//
// A source's extracted value is treated as "empty" (skip to the next
// source) if:
//   - null / undefined
//   - string that trims to ''
//   - array with length 0
// Zeros and false ARE valid values — likes:0 and reviewCount:0 must be
// distinguishable from "no value known". Callers that want to skip zero
// need to add a literal fallback with a positive default (as the existing
// likes cascade does with `literal: 572`).

function isEmpty(v) {
  if (v == null) return true;
  if (typeof v === 'string' && v.trim() === '') return true;
  if (Array.isArray(v) && v.length === 0) return true;
  return false;
}

// ── Source extraction ──────────────────────────────────────────────

function extractSource(source, context) {
  if (!source || typeof source !== 'object') return undefined;
  if (source.type === 'literal') return source.value;
  if (source.type === 'doc') {
    if (!CONTEXT_DOC_NAMES.has(source.doc)) return undefined;
    const doc = context[source.doc];
    if (doc == null) return undefined;
    let v = getPath(doc, source.path);
    if (isEmpty(v)) return v;
    // Optional string modifiers apply only to string values so a
    // `prefix: '@'` on a numeric doesn't produce '@42'.
    if (typeof v === 'string') {
      if (source.prefix) v = String(source.prefix) + v;
      if (source.suffix) v = v + String(source.suffix);
    }
    return v;
  }
  return undefined;
}

// ── Per-field resolver ─────────────────────────────────────────────

function resolveField(sources, context) {
  const trace = [];
  if (!Array.isArray(sources)) return { value: undefined, sourceIndex: -1, sourceTrace: trace };
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const v = extractSource(s, context);
    trace.push({ source: s, extracted: v, empty: isEmpty(v) });
    if (!isEmpty(v)) return { value: v, sourceIndex: i, sourceTrace: trace };
  }
  return { value: undefined, sourceIndex: -1, sourceTrace: trace };
}

// ── Multi-field resolver ───────────────────────────────────────────

function resolveMeta(cascades, context) {
  const out = {};
  for (const field of Object.keys(cascades || {})) {
    const { value } = resolveField(cascades[field], context);
    if (value !== undefined) out[field] = value;
  }
  return out;
}

// ── Cascade merging ────────────────────────────────────────────────
//
// Brand overrides REPLACE the entire default cascade for a field. This is
// a simpler mental model than merging arrays: the operator sees exactly
// what they authored, no invisible tail from the default. Fields not
// present in the override use their defaults.

function mergeCascades(defaults, brandOverrides) {
  const merged = { ...defaults };
  if (brandOverrides && typeof brandOverrides === 'object') {
    for (const [field, sources] of Object.entries(brandOverrides)) {
      if (Array.isArray(sources) && sources.length > 0) merged[field] = sources;
    }
  }
  return merged;
}

// ── Validation for PATCH input ─────────────────────────────────────
//
// Accepts a partial map { field: source[] } and validates each entry.
// Errors accumulate; nothing is applied unless the whole payload is
// valid (avoids partial-save mysteries). Returns { ok, errors,
// normalized } — the normalized object is the ready-to-persist Mixed
// value.

function validateBrandOverrides(overrides) {
  const errors = [];
  if (overrides == null) return { ok: true, errors: [], normalized: null };
  if (typeof overrides !== 'object' || Array.isArray(overrides)) {
    return { ok: false, errors: ['metaCascades must be an object mapping fields to source arrays'], normalized: null };
  }

  const normalized = {};
  for (const [field, sources] of Object.entries(overrides)) {
    if (!CASCADED_FIELDS.includes(field)) {
      errors.push(`unknown meta field '${field}' — valid: ${CASCADED_FIELDS.slice(0, 6).join(', ')}, ...`);
      continue;
    }
    if (!Array.isArray(sources) || sources.length < 1) {
      errors.push(`${field}: sources must be a non-empty array (omit the field to inherit the default cascade)`);
      continue;
    }
    if (sources.length > 8) {
      errors.push(`${field}: at most 8 sources per field (got ${sources.length})`);
      continue;
    }
    const cleanSources = [];
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      const where = `${field}[${i}]`;
      if (!s || typeof s !== 'object') { errors.push(`${where}: source must be an object`); continue; }
      if (s.type === 'literal') {
        // Any JSON-primitive value acceptable — string/number/array/bool/null.
        // Reject functions and other non-JSON values that Mongoose Mixed would silently store.
        try { JSON.parse(JSON.stringify(s.value)); } catch { errors.push(`${where}: literal.value must be JSON-serializable`); continue; }
        cleanSources.push({ type: 'literal', value: s.value });
        continue;
      }
      if (s.type === 'doc') {
        if (!CONTEXT_DOC_NAMES.has(s.doc)) {
          errors.push(`${where}: unknown doc '${s.doc}' — valid: ${[...CONTEXT_DOC_NAMES].join(', ')}`); continue;
        }
        if (typeof s.path !== 'string' || !s.path.trim()) {
          errors.push(`${where}: path must be a non-empty string`); continue;
        }
        // Path is user-authored; reject obvious injection attempts. Only
        // allow word chars, dots, and bracket-index syntax.
        if (!/^[\w.\[\]]+$/.test(s.path)) {
          errors.push(`${where}: path '${s.path}' contains illegal characters (only letters, digits, _, ., [N] allowed)`); continue;
        }
        const clean = { type: 'doc', doc: s.doc, path: s.path.trim() };
        if (s.prefix != null) {
          if (typeof s.prefix !== 'string' || s.prefix.length > 12) { errors.push(`${where}: prefix must be a string ≤12 chars`); continue; }
          clean.prefix = s.prefix;
        }
        if (s.suffix != null) {
          if (typeof s.suffix !== 'string' || s.suffix.length > 12) { errors.push(`${where}: suffix must be a string ≤12 chars`); continue; }
          clean.suffix = s.suffix;
        }
        cleanSources.push(clean);
        continue;
      }
      errors.push(`${where}: unknown source type '${s.type}' — expected 'doc' or 'literal'`);
    }
    if (cleanSources.length > 0 && !errors.some((e) => e.startsWith(`${field}[`))) {
      normalized[field] = cleanSources;
    }
  }

  if (errors.length) return { ok: false, errors, normalized: null };
  // An empty object is legal — means "clear all brand overrides".
  return { ok: true, errors: [], normalized };
}

// ── Context builder ────────────────────────────────────────────────
//
// Constructs the context object from raw loaded docs. Picks the
// product-only catalog media (the derived doc previously computed inline
// via pickProductOnlyUrl) so the productOnlyImageUrl cascade stays purely
// declarative.

function buildContext({ ad = null, brand = null, catalogProduct = null, layoutInput = null, catalogMedias = [], igCredential = null } = {}) {
  const productOnlyMedia = (catalogMedias || [])
    .find((m) => m?.classification?.shotType === 'product_only' && m?.fileUrl) || null;
  return {
    ad:                       ad || null,
    brand:                    brand || null,
    catalogProduct:           catalogProduct || null,
    layoutInput:              layoutInput || null,
    catalogMediaProductOnly:  productOnlyMedia,
    igCredential:             igCredential || null,
  };
}

module.exports = {
  resolveMeta,
  resolveField,
  mergeCascades,
  validateBrandOverrides,
  buildContext,
  // Re-exports for callers that want the vocabulary without a second require
  DEFAULT_META_CASCADES,
  CASCADED_FIELDS,
  CONTEXT_DOC_NAMES,
};
