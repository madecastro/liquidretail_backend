// One-shot script: rebuilds the ugc_split_screen entry in the
// normalized templates spec to mirror testimonial_spotlight's
// structure (image-led split-panel) — same style_bindings,
// truncation_rules, slot_adapter — adapted for section_header +
// product_meta replacing quote_card. Idempotent.
//
// Run: node scripts/rebuildUgcSplitScreenNormalized.js

const fs = require('fs');
const path = require('path');

const SPEC = path.join(__dirname, '..', 'schemas', 'rsSocialProof.templates.normalized.json');

const ugcNormalized = {
  template_id: "ugc_split_screen",
  version: "2.0.0",
  status: "active",
  supports_video: true,
  family: "social_proof",
  layout: {
    base_family: "split_panel",
    overlay_package: "rating_bar",
    copy_system: "headline_description_cta",
    motion_system: "subtle_product_motion"
  },
  aspect_ratios: {
    supported: ["1:1", "4:5", "9:16", "16:9", "1.91:1"],
    preferred: ["1:1", "4:5", "9:16"]
  },
  zones: {
    hero: {
      id: "section_header",
      type: "text",
      required: true,
      slot_binding: {
        source_priority: ["copy.eyebrow", "product.category", "brand.tagline"]
      },
      limits: {
        max_chars: { "1:1": 30, "4:5": 60, "9:16": 60, "16:9": 50, "1.91:1": 50 }
      }
    },
    body: {
      id: "product_meta",
      type: "text",
      required: true,
      slot_binding: {
        source_priority: ["product.description", "brand.summary", "brand.tagline"]
      }
    },
    support_media: {
      id: "support_media",
      type: "media",
      required: false,
      slot_binding: {
        source_priority: [
          "product.hero_media.video",
          "product.hero_media.image",
          "creator.portrait_media.video",
          "creator.portrait_media.image",
          "product.image"
        ],
        comment: "Source-Media-derived smart crop wins. 4:5 source crop is the hero across all ratios — Cloudinary c_fill,g_auto smart-crops to whatever rect the canvas asks for."
      },
      media_rules: {
        accepted_kinds: ["image", "video"],
        crop_mode: "subject_preserve",
        poster_required_for_video: true
      }
    },
    rating_bar: {
      id: "rating_bar",
      type: "proof_bar",
      required: false,
      slot_binding: {
        source_priority: ["social_proof.rating_value", "social_proof.review_count", "trust.trusted_by_text"]
      }
    },
    cta: {
      id: "cta",
      type: "button",
      required: true,
      slot_binding: {
        text: ["cta.text"],
        url: ["cta.url"]
      }
    }
  },
  render_order: ["brand", "support_media", "hero", "body", "rating_bar", "cta", "legal"],
  slot_adapter: {
    "brand.logo":           ["brand.logo"],
    "brand.brand_name":     ["brand.name"],
    "brand.eyebrow":        ["copy.eyebrow", "brand.tagline"],
    "copy.headline":        ["copy.headline"],
    "copy.headline_lead":   ["copy.headline_lead"],
    "copy.headline_main":   ["copy.headline_main"],
    "copy.subheadline":     ["copy.subheadline", "brand.tagline"],
    "copy.eyebrow":         ["copy.eyebrow", "product.category", "brand.tagline"],
    "copy.cta_text":        ["cta.text"],
    "social_proof.rating_value":              ["social_proof.rating_value"],
    "social_proof.review_count":              ["social_proof.review_count"],
    "trust.trusted_by_text":                  ["trust.trusted_by_text", "social_proof.trusted_by_text"],
    "product.name":                           ["product.name"],
    "product.description":                    ["product.description", "brand.summary", "brand.tagline"],
    "product.category":                       ["product.category"],
    "product.badges":                         ["product.badges", "social_proof.proof_badges"],
    "product.hero_media.image":               ["product.hero_media.image", "product.image"],
    "product.hero_media.video":               ["product.hero_media.video"]
  },
  visibility_rules: {
    show_brand_logo: true,
    show_rating_bar_only_if_any_present: true,
    show_badges_max: 4
  },
  truncation_rules: {
    headline_max_lines:        3,
    subheadline_max_lines:     2,
    product_description_max_lines: 12,
    cta_max_chars:             24
  },
  motion_policy: {
    max_concurrent_motion_slots: 1,
    preferred_hero_video_slot:   "support_media",
    allow_background_video:      true,
    mute_required:               true,
    loop_required:               true,
    autoplay_required:           true,
    text_overlay_requires_scrim: false,
    animation_style:             "subtle"
  },
  fallback_policy: {
    if_no_section_header:  "use brand.tagline",
    if_no_description:     "use brand.summary, then brand.tagline",
    if_no_support_media:   "render solid panel using palette_dominant",
    if_no_rating_data:     "hide rating bar",
    if_video_missing_poster: "generate from first frame or fall back to image"
  },
  style_bindings: {
    panel_bg:               { source_priority: ["media.palette_dominant", "brand.primary_color"],   default: "#0B0B0B", comment: "split-panel content surface — leads with source-Media's dominant tone so the panel reads as an extension of the image" },
    card_bg:                { source_priority: ["media.palette_dominant", "brand.secondary_color"], default: "#1A1A1A" },
    card_border:            { source_priority: ["media.palette_vibrant", "media.palette_accent", "brand.primary_color"], default: "#FF6B35" },
    accent_border_color:    { source_priority: ["media.palette_vibrant", "media.palette_accent", "brand.accent_color"],  default: "#FF6B35" },
    section_header_color:   { source_priority: ["media.palette_vibrant", "media.palette_accent", "brand.accent_color"],  default: "#FF6B35" },
    headline_text_color:    { source_priority: ["media.palette_vibrant"],  default: "#FFFFFF", comment: "image-led: vibrant image color when one exists. Monochromatic palettes default to white." },
    proof_bar_bg:           { source_priority: ["media.palette_dominant", "brand.primary_color"],   default: "#1F1F1F" },
    proof_bar_text:         { default: "auto-from-brightness" },
    proof_bar_border:       { source_priority: ["media.palette_vibrant", "media.palette_accent", "brand.accent_color"],  default: "#FF6B35" },
    cta_button_bg:          { source_priority: ["media.palette_vibrant", "media.palette_accent", "brand.accent_color", "brand.primary_color"], default: "#FF6B35" },
    cta_button_text:        { default: "auto-from-brightness" },
    rating_star_color:      { default: "#FFD400" },
    font_family_headline:   { source_priority: ["brand.font_family"], default: "Knewave, Bungee, system-ui" },
    font_family_body:       { default: "Inter, system-ui, sans-serif" }
  },
  validation: {
    required_all_of: ["product.name", "cta.text"],
    required_any_of: [
      ["product.description", "brand.summary", "brand.tagline"],
      ["product.hero_media.image", "creator.portrait_media.image", "ugc.media.image", "product.image"]
    ]
  }
};

const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'));
const idx = spec.templates.findIndex(t => t.template_id === 'ugc_split_screen');
if (idx === -1) throw new Error('ugc_split_screen not found in normalized templates');
spec.templates[idx] = ugcNormalized;
fs.writeFileSync(SPEC, JSON.stringify(spec, null, 2) + '\n', 'utf8');
console.log('ugc_split_screen normalized rebuilt — style_bindings now mirror testimonial_spotlight.');
