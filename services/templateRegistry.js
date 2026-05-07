// Template registry. Loads the three canonical JSON schemas at boot and
// exposes read-only accessors + the validator. This module is the single
// source of truth for anyone (layout service, preview UI, eventual renderer)
// asking "what does template X look like?" or "does this input satisfy
// template Y?"
//
// The four canonical specs (all under server/schemas/):
//   1. rsSocialProof.templates.catalog.json   — selection rules, purpose,
//      copy strategy, visual character. Human-read, UI-surfaced.
//   2. rsSocialProof.templates.normalized.json — per-zone slot bindings,
//      slot_adapter fallbacks, validation block. The contract.
//   3. rsSocialProof.canvas.v1.json            — 25 ratio-specific canvas
//      variants (5 templates × 5 ratios) + masters + global rules.
//      Geometry the renderer consumes to place zones.
//   4. rsSocialProof.renderer.v1.md            — renderer behavior spec:
//      slot fill order, collapse rules, truncation, media fit, video/
//      poster behavior, scrim, mobile obstruction, empty-state fallbacks.
//      Prose — the eventual renderer service pins to this.
//
// Schemas are READ-ONLY at runtime. Updates land as PRs against the files;
// the service reboots to pick them up.

const fs = require('fs');
const path = require('path');

const SCHEMAS_DIR = path.join(__dirname, '..', 'schemas');

const CATALOG    = loadJson('rsSocialProof.templates.catalog.json');
const NORMALIZED = loadJson('rsSocialProof.templates.normalized.json');
const CANVAS     = loadJson('rsSocialProof.canvas.v1.json');

const CATALOG_BY_ID    = indexBy(CATALOG.templates,   t => t.id);
const NORMALIZED_BY_ID = indexBy(NORMALIZED.templates, t => t.template_id);

console.log(`📐 templateRegistry: ${CATALOG.templates.length} templates, ${countCanvasVariants()} canvas variants loaded`);

function loadJson(filename) {
  const p = path.join(SCHEMAS_DIR, filename);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function indexBy(arr, keyFn) {
  const out = {};
  for (const item of arr) out[keyFn(item)] = item;
  return out;
}

function countCanvasVariants() {
  let n = 0;
  for (const t of Object.values(CANVAS.templates || {})) n += Object.keys(t.variants || {}).length;
  return n;
}

// ── Read-only accessors ──

function listTemplates() {
  return CATALOG.templates.map(t => ({
    id:        t.id,
    name:      t.name,
    ui_label:  t.ui_label,
    status:    t.status,
    emphasis:  t.emphasis,
    supported_aspect_ratios: NORMALIZED_BY_ID[t.id]?.aspect_ratios?.supported || []
  }));
}

function getCatalog(id)            { return CATALOG_BY_ID[id] || null; }
function getNormalized(id)         { return NORMALIZED_BY_ID[id] || null; }
function getCanvas(id, aspectRatio) {
  const variant = CANVAS.templates?.[id]?.variants?.[aspectRatio];
  if (!variant) return null;
  // Merge per-template truncation_rules into per-zone max_lines /
  // max_chars so the renderer reads ONE authoritative value. Template
  // truncation_rules win when present (editorial intent); the canvas
  // zone's own max_lines is the geometric fallback. Without this,
  // headline_max_lines: 3 in the template silently lost to
  // zone.max_lines: 2 from the canvas spec.
  const tr = NORMALIZED_BY_ID[id]?.truncation_rules || {};
  const zones = (variant.zones || []).map(z => {
    const override = pickTruncationOverride(z, tr);
    if (override.max_lines == null && override.max_chars == null) return z;
    return { ...z, ...override };
  });
  return { ...variant, zones };
}

// Map a zone's id+kind to the matching truncation_rules entry.
// truncation_rules names don't 1:1 match zone ids (zone 'product_meta'
// reads 'product_name_max_lines'; any zone whose id mentions 'quote'
// reads 'quote_max_lines'), so the mapping is explicit.
function pickTruncationOverride(zone, tr) {
  const out = {};
  const zid = zone.id || '';
  if (zid === 'headline'     && tr.headline_max_lines)      out.max_lines = tr.headline_max_lines;
  if (zid === 'subheadline'  && tr.subheadline_max_lines)   out.max_lines = tr.subheadline_max_lines;
  if (zid === 'product_meta' && tr.product_name_max_lines)  out.max_lines = tr.product_name_max_lines;
  // truncation_rules.quote_max_lines acts as a CAP — canvas zone
  // max_lines can go lower (e.g. 16:9 / 1.91:1 quote_card capping at
  // 2 lines for the tighter landscape slots) but not higher than
  // the editorial cap.
  if (/quote/.test(zid) && tr.quote_max_lines) {
    out.max_lines = (zone.max_lines != null)
      ? Math.min(zone.max_lines, tr.quote_max_lines)
      : tr.quote_max_lines;
  }
  if (zid === 'cta'          && tr.cta_max_chars)           out.max_chars = tr.cta_max_chars;
  return out;
}
function getCanvasMaster(id)       { return CANVAS.templates?.[id]?.master || null; }
function getGlobalCanvasRules()    { return CANVAS.global_canvas_rules || {}; }
function getSupportedAspectRatios(id) {
  return NORMALIZED_BY_ID[id]?.aspect_ratios?.supported || [];
}

// ── Validation ──
//
// Validates an assembled input against a template's `validation` block.
// Returns { ok, template_id, missing[], anyOfFailures[][], minCountFailures{} }.

function validateInputAgainstTemplate(input, templateId) {
  const spec = NORMALIZED_BY_ID[templateId];
  if (!spec) {
    return { ok: false, template_id: templateId, reason: `unknown template: ${templateId}` };
  }
  const v = spec.validation || {};
  const missing = [];
  const anyOfFailures = [];
  const minCountFailures = {};

  for (const p of v.required_all_of || []) {
    if (!isPresent(getPath(input, p))) missing.push(p);
  }
  for (const group of v.required_any_of || []) {
    if (!group.some(p => isPresent(getPath(input, p)))) anyOfFailures.push(group);
  }
  for (const [p, min] of Object.entries(v.minimum_counts || {})) {
    const val = getPath(input, p);
    const have = Array.isArray(val) ? val.length : 0;
    if (have < min) minCountFailures[p] = { needed: min, have };
  }

  const ok = !missing.length && !anyOfFailures.length && !Object.keys(minCountFailures).length;
  return { ok, template_id: templateId, missing, anyOfFailures, minCountFailures };
}

// Path resolver supporting:
//   - dotted keys        product.name
//   - numeric indices    social_proof.quotes.0.text
//   - bracketed indices  social_proof.quotes[0].text
function getPath(obj, pathStr) {
  if (!obj || !pathStr) return undefined;
  const parts = pathStr.split('.');
  let cur = obj;
  for (const part of parts) {
    if (cur == null) return undefined;
    const bracket = part.match(/^([^\[]+)\[(\d+)\]$/);
    if (bracket) {
      cur = cur[bracket[1]];
      if (Array.isArray(cur)) cur = cur[Number(bracket[2])];
      else                    return undefined;
      continue;
    }
    if (/^\d+$/.test(part) && Array.isArray(cur)) { cur = cur[Number(part)]; continue; }
    cur = cur[part];
  }
  return cur;
}

// "Present" = non-null, non-empty for strings / arrays / plain objects.
// Numbers and booleans always count as present if defined.
function isPresent(v) {
  if (v == null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

// Resolve a template's style_bindings against an assembled input.
// Each entry in style_bindings is { source_priority: [paths], default: <value> }
// (per-field map for composite slots, but style_bindings are flat). Walk
// the source_priority chain, return the first defined non-empty value;
// fall through to default; finally to null. The renderer sets the
// returned map as CSS custom properties.
//
// Special default sentinel: 'auto-from-brightness' is passed through
// unresolved so the renderer can compute it from the brightness grid /
// adjacent surface color at render time.
function resolveStyleBindings(input, templateId) {
  const spec = NORMALIZED_BY_ID[templateId];
  const bindings = spec?.style_bindings || {};
  const out = {};
  for (const [name, b] of Object.entries(bindings)) {
    if (!b || typeof b !== 'object') continue;
    let resolved = null;
    for (const p of (b.source_priority || [])) {
      const v = getPath(input, p);
      if (isPresent(v)) { resolved = v; break; }
    }
    if (resolved == null) resolved = b.default ?? null;
    if (resolved != null) out[name] = resolved;
  }
  return out;
}

module.exports = {
  listTemplates,
  getCatalog, getNormalized, getCanvas, getCanvasMaster, getGlobalCanvasRules,
  getSupportedAspectRatios,
  validateInputAgainstTemplate,
  resolveStyleBindings,
  getPath, isPresent,
  CATALOG, NORMALIZED, CANVAS
};
