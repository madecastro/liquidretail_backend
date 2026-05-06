// One-shot: split the 4:5 panel of testimonial_spotlight + ugc_split_screen
// into a two-column layout below the eyebrow, mirroring the 9:16 pattern.
//   LEFT  60% (x=60, w=528):  proof_bar + (quote_card OR section_header+product_meta)
//   RIGHT 40% (x=604, w=336): badge_row top, cta bottom
// Idempotent — safe to re-run.
const fs = require('fs');
const path = require('path');

const SPEC = path.join(__dirname, '..', 'schemas', 'rsSocialProof.canvas.v1.json');
const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'));

// ── testimonial_spotlight 4:5 ────────────────────────────────────
const ts45 = spec.templates.testimonial_spotlight.variants['4:5'];
ts45._layout_note = "Portrait stacked split-panel: 4:5-source image on TOP (full-width 1000×625), dark content panel BOTTOM (1000×625). Headline + eyebrow_rules span full panel width; below the eyebrow the panel splits into a 60/40 two-column layout — LEFT (proof_bar / quote_card) testimonial column, RIGHT (badge_row top, cta pinned bottom) proof-and-action column. Mirrors 9:16's two-column structure.";
ts45.safe_areas = {
  outer:          { x: 0,    y: 0,    w: 1000, h: 1250 },
  text_primary:   { x: 60,   y: 665,  w: 880,  h: 172 },
  text_secondary: { x: 60,   y: 847,  w: 528,  h: 363 },
  cta_safe:       { x: 622,  y: 1170, w: 300,  h: 40 },
  logo_safe:      { x: 60,   y: 32,   w: 200,  h: 56 },
  no_obstruction: { x: 0,    y: 0,    w: 1000, h: 625 }
};
ts45.zones = [
  { id: "support_media", kind: "media",         slot: "product.hero_media",
    rect: { x: 0, y: 0, w: 1000, h: 625 },
    layer: "media", fit: "subject_preserve", motion_role: "primary" },
  { id: "panel",         kind: "panel",         slot: null,
    rect: { x: 0, y: 625, w: 1000, h: 625 },
    layer: "background" },
  { id: "headline",      kind: "text",          slot: "copy.headline",
    rect: { x: 60, y: 665, w: 880, h: 150 },
    layer: "copy", style_variant: "display_script", max_lines: 3 },
  { id: "eyebrow_rules", kind: "eyebrow_rules", slot: ["copy.subheadline", "brand.tagline"],
    rect: { x: 60, y: 825, w: 880, h: 12 },
    layer: "copy", max_lines: 1 },
  { id: "proof_bar",     kind: "proof_bar",     slot: ["social_proof.rating_value", "social_proof.review_count"],
    rect: { x: 60, y: 847, w: 528, h: 32 },
    layer: "proof", radius: 999, style_variant: "with_verified_buyers", column: "left" },
  { id: "quote_card",    kind: "quote_card",    slot: "social_proof.primary_quote",
    rect: { x: 60, y: 893, w: 528, h: 317 },
    layer: "proof", radius: 8, padding: 16, max_lines: 8,
    style_variant: "with_author_photo", column: "left" },
  { id: "badge_row",     kind: "badge_row",     slot: "product.badges",
    rect: { x: 604, y: 847, w: 336, h: 24 },
    layer: "proof", style_variant: "callouts", max_items: 4, column: "right" },
  { id: "cta",           kind: "cta",           slot: "cta",
    rect: { x: 622, y: 1170, w: 300, h: 40 },
    layer: "cta", radius: 999, column: "right" },
  { id: "logo",          kind: "logo",          slot: "brand.logo",
    rect: { x: 60, y: 32, w: 160, h: 40 },
    layer: "chrome" }
];

// ── ugc_split_screen 4:5 ─────────────────────────────────────────
// Same band structure; LEFT col swaps quote_card for section_header + product_meta.
const ug45 = spec.templates.ugc_split_screen.variants['4:5'];
ug45._layout_note = "Portrait stacked split-panel: 4:5-source image on TOP (full-width 1000×625), dark content panel BOTTOM (1000×625). Headline + eyebrow_rules span full panel width; below the eyebrow the panel splits into a 60/40 two-column layout — LEFT (proof_bar / section_header / product_meta) description column, RIGHT (badge_row top, cta pinned bottom) proof-and-action column. Mirrors 9:16's two-column structure.";
ug45.safe_areas = ts45.safe_areas;
ug45.zones = [
  { id: "support_media", kind: "media",         slot: "product.hero_media",
    rect: { x: 0, y: 0, w: 1000, h: 625 },
    layer: "media", fit: "subject_preserve", motion_role: "primary" },
  { id: "panel",         kind: "panel",         slot: null,
    rect: { x: 0, y: 625, w: 1000, h: 625 },
    layer: "background" },
  { id: "headline",      kind: "text",          slot: "copy.headline",
    rect: { x: 60, y: 665, w: 880, h: 150 },
    layer: "copy", style_variant: "display_script", max_lines: 3 },
  { id: "eyebrow_rules", kind: "eyebrow_rules", slot: ["copy.subheadline", "brand.tagline"],
    rect: { x: 60, y: 825, w: 880, h: 12 },
    layer: "copy", max_lines: 1 },
  { id: "proof_bar",     kind: "proof_bar",     slot: ["social_proof.rating_value", "social_proof.review_count"],
    rect: { x: 60, y: 847, w: 528, h: 32 },
    layer: "proof", radius: 999, style_variant: "with_verified_buyers", column: "left" },
  { id: "section_header",kind: "text",          slot: ["copy.eyebrow", "product.category", "brand.tagline"],
    rect: { x: 60, y: 893, w: 528, h: 14 },
    layer: "copy", style_variant: "section_header", max_lines: 1, column: "left" },
  { id: "product_meta",  kind: "text",          slot: ["product.description", "brand.summary", "brand.tagline"],
    rect: { x: 60, y: 911, w: 528, h: 299 },
    layer: "copy", style_variant: "body_description", max_lines: 14, column: "left" },
  { id: "badge_row",     kind: "badge_row",     slot: "product.badges",
    rect: { x: 604, y: 847, w: 336, h: 24 },
    layer: "proof", style_variant: "callouts", max_items: 4, column: "right" },
  { id: "cta",           kind: "cta",           slot: "cta",
    rect: { x: 622, y: 1170, w: 300, h: 40 },
    layer: "cta", radius: 999, column: "right" },
  { id: "logo",          kind: "logo",          slot: "brand.logo",
    rect: { x: 60, y: 32, w: 160, h: 40 },
    layer: "chrome" }
];

fs.writeFileSync(SPEC, JSON.stringify(spec, null, 2) + '\n', 'utf8');
console.log('4:5 two-columnized for testimonial_spotlight + ugc_split_screen');
