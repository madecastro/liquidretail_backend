// One-shot: tighten cta_button_bg style binding on testimonial_spotlight
// + ugc_split_screen — drop media.palette_accent (palette[1], can be a
// light off-tone that washes out the white CTA text). Idempotent.
const fs = require('fs');
const path = require('path');

const SPEC = path.join(__dirname, '..', 'schemas', 'rsSocialProof.templates.normalized.json');
const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'));

const TIGHTEN_TEMPLATES = ['testimonial_spotlight', 'ugc_split_screen'];

for (const tpl of spec.templates) {
  if (!TIGHTEN_TEMPLATES.includes(tpl.template_id)) continue;
  const sb = tpl.style_bindings;
  if (!sb || !sb.cta_button_bg) continue;
  sb.cta_button_bg = {
    source_priority: ["media.palette_vibrant", "brand.accent_color"],
    default: "#FF6B35",
    comment: "Image-led: vibrant image color when one passes the saturation+contrast gates. Otherwise brand accent or default orange — NEVER palette_accent (palette[1] is dominance-ranked and can be a near-white off-tone that washes out white CTA text)."
  };
  console.log(`tightened cta_button_bg on ${tpl.template_id}`);
}

fs.writeFileSync(SPEC, JSON.stringify(spec, null, 2) + '\n', 'utf8');
console.log('done.');
