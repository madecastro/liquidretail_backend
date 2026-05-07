// One-shot: branch testimonial_overlay into testimonial_overlay (slim:
// logo + headline + quote + cta) and product_overlay (logo + headline +
// product_meta + cta). Updates normalized.json + catalog.json.
// Idempotent.
const fs = require('fs');
const path = require('path');

const NORM_PATH = path.join(__dirname, '..', 'schemas', 'rsSocialProof.templates.normalized.json');
const CAT_PATH  = path.join(__dirname, '..', 'schemas', 'rsSocialProof.templates.catalog.json');
const norm = JSON.parse(fs.readFileSync(NORM_PATH, 'utf8'));
const cat  = JSON.parse(fs.readFileSync(CAT_PATH, 'utf8'));

// ── 1. Edit testimonial_overlay normalized: drop product_meta, white
//      default headline, dark-gray chip bindings ─────────────────────
const tIdx = norm.templates.findIndex(t => t.template_id === 'testimonial_overlay');
if (tIdx === -1) throw new Error('testimonial_overlay not found');
const t = norm.templates[tIdx];

t.render_order = ['background_media', 'scrim', 'logo', 'headline', 'cta', 'quote'];
t.placement_policy.element_priority_order = t.placement_policy.element_priority_order
  .filter(e => e.id !== 'product_meta');

// Update validation — drop product.name (no product_meta to bind to)
t.validation.required_all_of = ['brand.logo', 'copy.headline', 'cta.text'];

// Style: white-default headline + brand font + dark-gray chip bg behind
// the headline + quote text spans.
t.style_bindings.headline_text_color = {
  source_priority: ['media.palette_vibrant'],
  default: '#FFFFFF',
  comment: 'image-led: vibrant image color when one passes the saturation+contrast gates. Otherwise white. NEVER falls through to palette_accent or brand.accent_color (image-led overlay shouldn\'t substitute brand color for an image color).'
};
t.style_bindings.font_family_headline = {
  source_priority: ['brand.font_family'],
  default: 'Inter, system-ui, sans-serif',
  comment: 'brand-curated headline font wins; falls through to a clean sans default.'
};
t.style_bindings.headline_chip_bg = {
  default: 'rgba(20,20,20,0.85)',
  comment: 'dark-gray chip backing behind the headline text — semi-opaque so it lifts white text off any image background without competing with the photo.'
};
t.style_bindings.quote_chip_bg = {
  default: 'rgba(20,20,20,0.85)',
  comment: 'matches headline_chip_bg — dark-gray chip behind quote text.'
};
t.style_bindings.quote_text_color = {
  default: '#FFFFFF'
};

// ── 2. Create product_overlay normalized — clone + drop quote ────────
const product_overlay = JSON.parse(JSON.stringify(t));  // start from updated testimonial_overlay
product_overlay.template_id = 'product_overlay';
product_overlay.layout = {
  base_family: 'image_overlay',
  overlay_package: 'adaptive_scrim',
  copy_system: 'logo_headline_product_cta',
  motion_system: 'subtle_image_motion'
};

// Render order + element list: logo, headline, product_meta, cta
product_overlay.render_order = ['background_media', 'scrim', 'logo', 'headline', 'product_meta', 'cta'];

// Strip quote, add product_meta as a product_card composite (image + name + price)
const headlineEl = t.placement_policy.element_priority_order.find(e => e.id === 'headline');
const ctaEl      = t.placement_policy.element_priority_order.find(e => e.id === 'cta');
const logoEl     = t.placement_policy.element_priority_order.find(e => e.id === 'logo');

product_overlay.placement_policy.element_priority_order = [
  logoEl,
  headlineEl,
  {
    id: 'product_meta',
    required: true,
    region_hint: 'mid-band',
    variant: 'product_card',
    slot_binding: {
      fields: {
        image: { source_priority: ['product.image', 'product.hero_media.image'] },
        name:  { source_priority: ['product.name'] },
        price: { source_priority: ['product.price'] }
      }
    }
  },
  ctaEl
];

// Drop quote-only style bindings (quote_chip_bg + quote_text_color)
delete product_overlay.style_bindings.quote_chip_bg;
delete product_overlay.style_bindings.quote_text_color;

product_overlay.validation = {
  required_all_of: ['brand.logo', 'copy.headline', 'product.name', 'cta.text'],
  required_any_of: [
    ['product.image', 'product.hero_media.image']
  ]
};
product_overlay.truncation_rules = {
  headline_max_lines: 3,
  product_name_max_lines: 2,
  cta_max_chars: 24
};

// Insert product_overlay right after testimonial_overlay so the order
// in normalized.json keeps related templates adjacent.
norm.templates.splice(tIdx + 1, 0, product_overlay);

// ── 3. Catalog entry for product_overlay ─────────────────────────────
const tCat = cat.templates.find(c => c.id === 'testimonial_overlay');
if (tCat) {
  const productCat = JSON.parse(JSON.stringify(tCat));
  productCat.id = 'product_overlay';
  productCat.name = 'Product Overlay';
  productCat.ui_label = 'Product Overlay';
  productCat.tagline = 'The image is the ad. Logo, headline, product card (image + name + price), and CTA sit on top in safe zones.';
  productCat.purpose = 'Image-as-canvas overlay focused on a specific product. The hero photo fills the entire frame; logo, headline, a product card (catalog image + name + price), and CTA are placed in subject-safe regions using the detect pipeline\'s overlay-zone analysis.';
  productCat.summary = 'Product-focused sibling of testimonial_overlay. Renders the full image as the canvas and overlays the product card + CTA at runtime in safe zones.';
  productCat.preset_architecture = {
    base_family: 'image_overlay',
    overlay_package: 'adaptive_scrim',
    copy_system: 'logo_headline_product_cta',
    motion_system: 'subtle_image_motion'
  };
  productCat.primary_proof_types = ['image_subject', 'product_meta'];
  productCat.required_content = tCat.required_content;
  // Insert in catalog after testimonial_overlay
  const cIdx = cat.templates.findIndex(c => c.id === 'testimonial_overlay');
  // De-dupe
  cat.templates = cat.templates.filter(c => c.id !== 'product_overlay');
  cat.templates.splice(cIdx + 1, 0, productCat);
}

fs.writeFileSync(NORM_PATH, JSON.stringify(norm, null, 2) + '\n', 'utf8');
fs.writeFileSync(CAT_PATH,  JSON.stringify(cat,  null, 2) + '\n', 'utf8');

console.log('testimonial_overlay slimmed to logo + headline + quote + cta');
console.log('product_overlay created with logo + headline + product_meta(product_card) + cta');
console.log('Both have headline_text_color → white, font_family_headline → brand, headline_chip_bg → dark gray.');
