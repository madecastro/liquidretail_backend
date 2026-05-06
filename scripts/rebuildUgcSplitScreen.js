// One-shot script: replaces the ugc_split_screen entry in the canvas
// spec with a fresh template that mirrors testimonial_spotlight's
// split-panel layout but swaps the quote_card slot for section_header
// + product_meta. Idempotent — safe to run multiple times.
//
// Run: node scripts/rebuildUgcSplitScreen.js
const fs = require('fs');
const path = require('path');

const SPEC = path.join(__dirname, '..', 'schemas', 'rsSocialProof.canvas.v1.json');

const ugcTemplate = {
  master: {
    intent: "image-led split-panel product/brand ad — shares the testimonial_spotlight design language but swaps the quote_card slot for section_header + product_meta (description-led instead of testimonial-led)",
    zone_roles: ["background","support_media","panel","headline","eyebrow_rules","proof_bar","section_header","product_meta","badge_row","cta","logo"],
    hierarchy:  ["support_media","headline","section_header","product_meta","proof_bar","cta"],
    default_motion: { primary_motion_zone: "support_media", secondary_motion_zone: null, style: "subtle" },
    notes: [
      "Image-led split-panel — same geometry as testimonial_spotlight.",
      "section_header + product_meta replace the quote_card slot for product/brand description instead of customer quote.",
      "4:5 source crop is the hero (Cloudinary c_fill,g_auto smart-crops to fit each ratio's image rect)."
    ]
  },
  variants: {
    "1:1": {
      template_id: "ugc_split_screen",
      aspect_ratio: "1:1",
      _layout_note: "Square split-panel: 4:5-source image LEFT (full-height half), dark content panel RIGHT. Mirrors testimonial_spotlight 1:1 with section_header + product_meta replacing the quote_card slot.",
      zone_scalers: { proof_bar: 1.25, eyebrow_rules: 2, badge_row: 2 },
      canvas: { unit_system: "normalized_1000", width: 1000, height: 1000, background: { style: "split_panel" } },
      safe_areas: {
        outer:          { x: 0,   y: 0,   w: 1000, h: 1000 },
        text_primary:   { x: 540, y: 80,  w: 420,  h: 280 },
        text_secondary: { x: 540, y: 380, w: 420,  h: 380 },
        cta_safe:       { x: 540, y: 800, w: 420,  h: 80 },
        logo_safe:      { x: 540, y: 32,  w: 200,  h: 56 },
        no_obstruction: { x: 0,   y: 0,   w: 500,  h: 1000 }
      },
      zones: [
        { id: "support_media", kind: "media",         slot: "product.hero_media",
          rect: { x: 0, y: 0, w: 500, h: 1000 },
          layer: "media", fit: "subject_preserve", motion_role: "primary" },
        { id: "panel",         kind: "panel",         slot: null,
          rect: { x: 500, y: 0, w: 500, h: 1000 },
          layer: "background" },
        { id: "headline",      kind: "text",          slot: "copy.headline",
          rect: { x: 540, y: 80, w: 420, h: 240 },
          layer: "copy", style_variant: "display_script", max_lines: 4 },
        { id: "eyebrow_rules", kind: "eyebrow_rules", slot: ["copy.subheadline", "brand.tagline"],
          rect: { x: 540, y: 334, w: 420, h: 14 },
          layer: "copy", max_lines: 1 },
        { id: "proof_bar",     kind: "proof_bar",     slot: ["social_proof.rating_value", "social_proof.review_count"],
          rect: { x: 540, y: 362, w: 420, h: 38 },
          layer: "proof", radius: 999, style_variant: "with_verified_buyers" },
        { id: "section_header",kind: "text",          slot: ["copy.eyebrow", "product.category", "brand.tagline"],
          rect: { x: 540, y: 418, w: 420, h: 14 },
          layer: "copy", style_variant: "section_header", max_lines: 1 },
        { id: "product_meta",  kind: "text",          slot: ["product.description", "brand.summary", "brand.tagline"],
          rect: { x: 540, y: 436, w: 420, h: 282 },
          layer: "copy", style_variant: "body_description", max_lines: 12 },
        { id: "badge_row",     kind: "badge_row",     slot: "product.badges",
          rect: { x: 540, y: 750, w: 420, h: 30 },
          layer: "proof", style_variant: "callouts", max_items: 4 },
        { id: "cta",           kind: "cta",           slot: "cta",
          rect: { x: 590, y: 820, w: 320, h: 50 },
          layer: "cta", radius: 999 },
        { id: "logo",          kind: "logo",          slot: "brand.logo",
          rect: { x: 540, y: 32, w: 160, h: 40 },
          layer: "chrome" }
      ],
      layers: ["background","media","scrim","copy","proof","chrome","cta"],
      motion_policy: {
        max_concurrent_motion_zones: 1, primary_motion_zone: "support_media", secondary_motion_zone: null,
        allow_background_video: true, text_scrim_required_over_video: false, poster_fallback_required: true
      }
    },
    "4:5": {
      template_id: "ugc_split_screen",
      aspect_ratio: "4:5",
      _layout_note: "Portrait stacked split-panel: 4:5-source image on TOP (full-width 1000×625), dark content panel on BOTTOM (1000×625). Mirrors testimonial_spotlight 4:5 with section_header + product_meta replacing the quote_card slot.",
      zone_scalers: { headline: 2, proof_bar: 1.5, eyebrow_rules: 2, badge_row: 2 },
      canvas: { unit_system: "normalized_1000", width: 1000, height: 1250, background: { style: "split_panel" } },
      safe_areas: {
        outer:          { x: 0,    y: 0,    w: 1000, h: 1250 },
        text_primary:   { x: 60,   y: 665,  w: 880,  h: 220 },
        text_secondary: { x: 60,   y: 890,  w: 880,  h: 240 },
        cta_safe:       { x: 60,   y: 1170, w: 880,  h: 80 },
        logo_safe:      { x: 60,   y: 32,   w: 200,  h: 56 },
        no_obstruction: { x: 0,    y: 0,    w: 1000, h: 625 }
      },
      zones: [
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
          rect: { x: 60, y: 847, w: 880, h: 32 },
          layer: "proof", radius: 999, style_variant: "with_verified_buyers" },
        { id: "section_header",kind: "text",          slot: ["copy.eyebrow", "product.category", "brand.tagline"],
          rect: { x: 60, y: 891, w: 880, h: 12 },
          layer: "copy", style_variant: "section_header", max_lines: 1 },
        { id: "product_meta",  kind: "text",          slot: ["product.description", "brand.summary", "brand.tagline"],
          rect: { x: 60, y: 907, w: 880, h: 199 },
          layer: "copy", style_variant: "body_description", max_lines: 10 },
        { id: "badge_row",     kind: "badge_row",     slot: "product.badges",
          rect: { x: 60, y: 1122, w: 880, h: 24 },
          layer: "proof", style_variant: "callouts", max_items: 4 },
        { id: "cta",           kind: "cta",           slot: "cta",
          rect: { x: 60, y: 1170, w: 320, h: 40 },
          layer: "cta", radius: 999 },
        { id: "logo",          kind: "logo",          slot: "brand.logo",
          rect: { x: 60, y: 32, w: 160, h: 40 },
          layer: "chrome" }
      ],
      layers: ["background","media","scrim","copy","proof","chrome","cta"],
      motion_policy: {
        max_concurrent_motion_zones: 1, primary_motion_zone: "support_media", secondary_motion_zone: null,
        allow_background_video: true, text_scrim_required_over_video: false, poster_fallback_required: true
      }
    },
    "9:16": {
      template_id: "ugc_split_screen",
      aspect_ratio: "9:16",
      _layout_note: "Stories split-panel: 4:5-source image on TOP (1000×889), dark content panel BOTTOM (1000×889). Mirrors testimonial_spotlight 9:16 with section_header + product_meta replacing the quote_card slot in the LEFT column.",
      zone_scalers: { headline: 2, proof_bar: 1.5, eyebrow_rules: 2, badge_row: 2 },
      canvas: { unit_system: "normalized_1000", width: 1000, height: 1778, background: { style: "split_panel" } },
      safe_areas: {
        outer:          { x: 0,    y: 0,    w: 1000, h: 1778 },
        text_primary:   { x: 60,   y: 949,  w: 880,  h: 266 },
        text_secondary: { x: 60,   y: 1231, w: 528,  h: 487 },
        cta_safe:       { x: 622,  y: 1664, w: 300,  h: 54 },
        logo_safe:      { x: 60,   y: 900,  w: 200,  h: 32 },
        no_obstruction: { x: 0,    y: 0,    w: 1000, h: 889 }
      },
      zones: [
        { id: "support_media", kind: "media",         slot: "product.hero_media",
          rect: { x: 0, y: 0, w: 1000, h: 889 },
          layer: "media", fit: "subject_preserve", motion_role: "primary" },
        { id: "panel",         kind: "panel",         slot: null,
          rect: { x: 0, y: 889, w: 1000, h: 889 },
          layer: "background" },
        { id: "logo",          kind: "logo",          slot: "brand.logo",
          rect: { x: 60, y: 900, w: 160, h: 32 },
          layer: "chrome" },
        { id: "headline",      kind: "text",          slot: "copy.headline",
          rect: { x: 60, y: 949, w: 880, h: 240 },
          layer: "copy", style_variant: "display_script", max_lines: 4 },
        { id: "eyebrow_rules", kind: "eyebrow_rules", slot: ["copy.subheadline", "brand.tagline"],
          rect: { x: 60, y: 1201, w: 880, h: 14 },
          layer: "copy", max_lines: 1 },
        { id: "proof_bar",     kind: "proof_bar",     slot: ["social_proof.rating_value", "social_proof.review_count"],
          rect: { x: 60, y: 1231, w: 528, h: 32 },
          layer: "proof", radius: 999, style_variant: "with_verified_buyers", column: "left" },
        { id: "section_header",kind: "text",          slot: ["copy.eyebrow", "product.category", "brand.tagline"],
          rect: { x: 60, y: 1277, w: 528, h: 14 },
          layer: "copy", style_variant: "section_header", max_lines: 1, column: "left" },
        { id: "product_meta",  kind: "text",          slot: ["product.description", "brand.summary", "brand.tagline"],
          rect: { x: 60, y: 1295, w: 528, h: 423 },
          layer: "copy", style_variant: "body_description", max_lines: 18, column: "left" },
        { id: "badge_row",     kind: "badge_row",     slot: "product.badges",
          rect: { x: 604, y: 1231, w: 336, h: 24 },
          layer: "proof", style_variant: "callouts", max_items: 4, column: "right" },
        { id: "cta",           kind: "cta",           slot: "cta",
          rect: { x: 622, y: 1664, w: 300, h: 54 },
          layer: "cta", radius: 999, column: "right" }
      ],
      layers: ["background","media","scrim","copy","proof","chrome","cta"],
      motion_policy: {
        max_concurrent_motion_zones: 1, primary_motion_zone: "support_media", secondary_motion_zone: null,
        allow_background_video: true, text_scrim_required_over_video: false, poster_fallback_required: true
      }
    },
    "16:9": {
      template_id: "ugc_split_screen",
      aspect_ratio: "16:9",
      _layout_note: "Landscape split-panel: 4:5-source image LEFT 40%, dark content panel RIGHT 60%. Mirrors testimonial_spotlight 16:9 with section_header + product_meta replacing the quote_card slot.",
      zone_scalers: { proof_bar: 1.5, eyebrow_rules: 2, badge_row: 2 },
      canvas: { unit_system: "normalized_1000", width: 1000, height: 563, background: { style: "split_panel" } },
      safe_areas: {
        outer:          { x: 0,   y: 0,   w: 1000, h: 563 },
        text_primary:   { x: 452, y: 32,  w: 516,  h: 200 },
        text_secondary: { x: 452, y: 240, w: 516,  h: 220 },
        cta_safe:       { x: 452, y: 460, w: 516,  h: 80 },
        logo_safe:      { x: 32,  y: 32,  w: 200,  h: 56 },
        no_obstruction: { x: 0,   y: 0,   w: 400,  h: 563 }
      },
      zones: [
        { id: "support_media", kind: "media",         slot: "product.hero_media",
          rect: { x: 0, y: 0, w: 400, h: 563 },
          layer: "media", fit: "subject_preserve", motion_role: "primary" },
        { id: "panel",         kind: "panel",         slot: null,
          rect: { x: 400, y: 0, w: 600, h: 563 },
          layer: "background" },
        { id: "headline",      kind: "text",          slot: "copy.headline",
          rect: { x: 452, y: 24, w: 516, h: 210 },
          layer: "copy", style_variant: "display_script", max_lines: 4 },
        { id: "eyebrow_rules", kind: "eyebrow_rules", slot: ["copy.subheadline", "brand.tagline"],
          rect: { x: 452, y: 242, w: 516, h: 11 },
          layer: "copy", max_lines: 1 },
        { id: "proof_bar",     kind: "proof_bar",     slot: ["social_proof.rating_value", "social_proof.review_count"],
          rect: { x: 452, y: 265, w: 516, h: 28 },
          layer: "proof", radius: 999, style_variant: "with_verified_buyers" },
        { id: "section_header",kind: "text",          slot: ["copy.eyebrow", "product.category", "brand.tagline"],
          rect: { x: 452, y: 307, w: 516, h: 12 },
          layer: "copy", style_variant: "section_header", max_lines: 1 },
        { id: "product_meta",  kind: "text",          slot: ["product.description", "brand.summary", "brand.tagline"],
          rect: { x: 452, y: 323, w: 516, h: 120 },
          layer: "copy", style_variant: "body_description", max_lines: 7 },
        { id: "badge_row",     kind: "badge_row",     slot: "product.badges",
          rect: { x: 452, y: 457, w: 516, h: 24 },
          layer: "proof", style_variant: "callouts", max_items: 4 },
        { id: "cta",           kind: "cta",           slot: "cta",
          rect: { x: 452, y: 495, w: 516, h: 34 },
          layer: "cta", radius: 999 }
      ],
      layers: ["background","media","scrim","copy","proof","chrome","cta"],
      motion_policy: {
        max_concurrent_motion_zones: 1, primary_motion_zone: "support_media", secondary_motion_zone: null,
        allow_background_video: true, text_scrim_required_over_video: false, poster_fallback_required: true
      }
    },
    "1.91:1": {
      template_id: "ugc_split_screen",
      aspect_ratio: "1.91:1",
      _layout_note: "Landscape split-panel — sibling of 16:9 with tighter vertical budget. Mirrors testimonial_spotlight 1.91:1 with section_header + product_meta replacing the quote_card slot.",
      zone_scalers: { proof_bar: 1.5, eyebrow_rules: 2, badge_row: 2 },
      canvas: { unit_system: "normalized_1000", width: 1000, height: 524, background: { style: "split_panel" } },
      safe_areas: {
        outer:          { x: 0,   y: 0,   w: 1000, h: 524 },
        text_primary:   { x: 452, y: 32,  w: 516,  h: 168 },
        text_secondary: { x: 452, y: 210, w: 516,  h: 200 },
        cta_safe:       { x: 452, y: 416, w: 516,  h: 80 },
        logo_safe:      { x: 32,  y: 32,  w: 200,  h: 56 },
        no_obstruction: { x: 0,   y: 0,   w: 400,  h: 524 }
      },
      zones: [
        { id: "support_media", kind: "media",         slot: "product.hero_media",
          rect: { x: 0, y: 0, w: 400, h: 524 },
          layer: "media", fit: "subject_preserve", motion_role: "primary" },
        { id: "panel",         kind: "panel",         slot: null,
          rect: { x: 400, y: 0, w: 600, h: 524 },
          layer: "background" },
        { id: "headline",      kind: "text",          slot: "copy.headline",
          rect: { x: 452, y: 22, w: 516, h: 198 },
          layer: "copy", style_variant: "display_script", max_lines: 4 },
        { id: "eyebrow_rules", kind: "eyebrow_rules", slot: ["copy.subheadline", "brand.tagline"],
          rect: { x: 452, y: 226, w: 516, h: 10 },
          layer: "copy", max_lines: 1 },
        { id: "proof_bar",     kind: "proof_bar",     slot: ["social_proof.rating_value", "social_proof.review_count"],
          rect: { x: 452, y: 246, w: 516, h: 24 },
          layer: "proof", radius: 999, style_variant: "with_verified_buyers" },
        { id: "section_header",kind: "text",          slot: ["copy.eyebrow", "product.category", "brand.tagline"],
          rect: { x: 452, y: 280, w: 516, h: 10 },
          layer: "copy", style_variant: "section_header", max_lines: 1 },
        { id: "product_meta",  kind: "text",          slot: ["product.description", "brand.summary", "brand.tagline"],
          rect: { x: 452, y: 294, w: 516, h: 100 },
          layer: "copy", style_variant: "body_description", max_lines: 6 },
        { id: "badge_row",     kind: "badge_row",     slot: "product.badges",
          rect: { x: 452, y: 408, w: 516, h: 22 },
          layer: "proof", style_variant: "callouts", max_items: 4 },
        { id: "cta",           kind: "cta",           slot: "cta",
          rect: { x: 452, y: 442, w: 516, h: 38 },
          layer: "cta", radius: 999 }
      ],
      layers: ["background","media","scrim","copy","proof","chrome","cta"],
      motion_policy: {
        max_concurrent_motion_zones: 1, primary_motion_zone: "support_media", secondary_motion_zone: null,
        allow_background_video: true, text_scrim_required_over_video: false, poster_fallback_required: true
      }
    }
  }
};

const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'));
spec.templates.ugc_split_screen = ugcTemplate;
fs.writeFileSync(SPEC, JSON.stringify(spec, null, 2) + '\n', 'utf8');
console.log('ugc_split_screen template rebuilt — 5 variants written.');
