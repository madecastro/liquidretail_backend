// Template registry. Loads the three canonical JSON schemas at boot and
// exposes read-only accessors + the validator. This module is the single
// source of truth for anyone (layout service, preview UI, eventual renderer)
// asking "what does template X look like?" or "does this input satisfy
// template Y?"
//
// The three schemas:
//   1. schemas/rsSocialProof.templates.catalog.json   — selection rules,
//      purpose, copy strategy, visual character. Human-read, UI-surfaced.
//   2. schemas/rsSocialProof.templates.normalized.json — per-zone slot
//      bindings, slot_adapter fallbacks, validation block. The contract.
//   3. schemas/rsSocialProof.canvas.v1.json           — 25 ratio-specific
//      canvas variants (5 templates × 5 ratios). Geometry the renderer
//      consumes to place zones.
//
// Schemas are READ-ONLY at runtime. Updates land as PRs against the JSON
// files; the service reboots to pick them up.

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
function getCanvas(id, aspectRatio){ return CANVAS.templates?.[id]?.variants?.[aspectRatio] || null; }
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

module.exports = {
  listTemplates,
  getCatalog, getNormalized, getCanvas, getCanvasMaster, getGlobalCanvasRules,
  getSupportedAspectRatios,
  validateInputAgainstTemplate,
  getPath, isPresent,
  CATALOG, NORMALIZED, CANVAS
};
