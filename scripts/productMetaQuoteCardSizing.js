// One-shot: drop section_header from ugc_split_screen and apply
// quote_card's per-ratio sizing pattern to product_meta. Idempotent.
//
//   - product_meta absorbs section_header's vertical (y/h roll up).
//   - zone_scalers.product_meta = { font: 1.6 } per ratio.
//   - min_h_fraction per ratio mirrors quote_card calibration.
//   - max_lines per ratio matches quote_card's curve.
const fs = require('fs');
const path = require('path');

const SPEC = path.join(__dirname, '..', 'schemas', 'rsSocialProof.canvas.v1.json');
const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'));

// quote_card-aligned values per ratio
const PER_RATIO = {
  '1:1':    { product_meta_y: 418,  product_meta_h: 300, min_h_fraction: 0.75, max_lines: 6 },
  '4:5':    { product_meta_y: 893,  product_meta_h: 317, min_h_fraction: 0.75, max_lines: 8 },
  '9:16':   { product_meta_y: 1277, product_meta_h: 441, min_h_fraction: 0.4,  max_lines: 9 },
  '16:9':   { product_meta_y: 307,  product_meta_h: 136, min_h_fraction: 1.0,  max_lines: 2 },
  '1.91:1': { product_meta_y: 280,  product_meta_h: 114, min_h_fraction: 1.0,  max_lines: 2 }
};

const ugc = spec.templates.ugc_split_screen.variants;
for (const [ratio, cfg] of Object.entries(PER_RATIO)) {
  const v = ugc[ratio];
  if (!v) continue;

  // Drop section_header
  v.zones = v.zones.filter(z => z.id !== 'section_header');

  // Update product_meta zone: absorb section_header's y, set new h,
  // add min_h_fraction, set max_lines.
  const pm = v.zones.find(z => z.id === 'product_meta');
  if (pm) {
    pm.rect.y = cfg.product_meta_y;
    pm.rect.h = cfg.product_meta_h;
    pm.max_lines = cfg.max_lines;
    pm.min_h_fraction = cfg.min_h_fraction;
  }

  // Add product_meta font scaler to zone_scalers
  v.zone_scalers = v.zone_scalers || {};
  v.zone_scalers.product_meta = { font: 1.6 };
}

// Master: drop section_header from zone_roles + hierarchy
const master = spec.templates.ugc_split_screen.master;
if (master) {
  master.zone_roles = (master.zone_roles || []).filter(r => r !== 'section_header');
  master.hierarchy  = (master.hierarchy  || []).filter(r => r !== 'section_header');
}

fs.writeFileSync(SPEC, JSON.stringify(spec, null, 2) + '\n', 'utf8');
console.log('ugc_split_screen rebuilt — section_header removed, product_meta sized like quote_card per ratio');
