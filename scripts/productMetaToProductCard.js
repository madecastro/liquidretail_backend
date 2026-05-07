// One-shot: convert ugc_split_screen product_meta from a body_description
// text zone into a product_card composite (image + name + price). Idempotent.
const fs = require('fs');
const path = require('path');

const SPEC = path.join(__dirname, '..', 'schemas', 'rsSocialProof.canvas.v1.json');
const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'));

const ugc = spec.templates.ugc_split_screen.variants;
for (const ratio of Object.keys(ugc)) {
  const v = ugc[ratio];
  const pm = v.zones.find(z => z.id === 'product_meta');
  if (!pm) continue;
  pm.kind = 'product_card';
  pm.slot = ['product.image', 'product.name', 'product.price'];
  pm.style_variant = 'with_thumbnail';
  // Keep rect / min_h_fraction / max_lines / column / padding / radius
  // — the per-ratio sizing calibration carries over verbatim.
  pm.padding = pm.padding ?? 14;
  pm.radius  = pm.radius  ?? 8;
}

// Update master zone_roles + hierarchy if it references product_meta
const master = spec.templates.ugc_split_screen.master;
if (master) {
  // role label stays product_meta for continuity
}

fs.writeFileSync(SPEC, JSON.stringify(spec, null, 2) + '\n', 'utf8');
console.log('ugc_split_screen product_meta → product_card with_thumbnail (image + name + price).');
