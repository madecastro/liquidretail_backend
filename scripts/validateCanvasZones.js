#!/usr/bin/env node
// Validates every (template × aspect_ratio) zone against the canvas
// spec's safe_areas + global_canvas_rules. Pure tooling — no DB, no
// network. Run on demand:
//
//   node server/scripts/validateCanvasZones.js
//
// Exit code: 0 = clean, 1 = violations found.
//
// Rules enforced:
//   - all_cta_zones_must_be_inside_cta_safe        — zone.id === 'cta'
//   - all_primary_copy_must_be_inside_text_primary — kind === 'text'
//                                                    with 'copy.*' slot
//                                                    or zone.id ===
//                                                    'headline'
//   - logo zones must be inside logo_safe          — zone.id === 'logo'
//   - all zones must be inside the canvas's outer  — universal (catches
//                                                    spec drift)
//
// Fast (< 100ms across all templates × ratios) — fine to run pre-deploy.

const path = require('path');
const fs   = require('fs');

const CANVAS_PATH = path.join(__dirname, '..', 'schemas', 'rsSocialProof.canvas.v1.json');
const canvas = JSON.parse(fs.readFileSync(CANVAS_PATH, 'utf8'));

function rectInside(inner, outer) {
  if (!inner || !outer) return false;
  const ix2 = inner.x + inner.w;
  const iy2 = inner.y + inner.h;
  const ox2 = outer.x + outer.w;
  const oy2 = outer.y + outer.h;
  return inner.x >= outer.x && inner.y >= outer.y && ix2 <= ox2 && iy2 <= oy2;
}

function isPrimaryCopy(zone) {
  if (zone.kind !== 'text') return false;
  if (zone.id === 'headline') return true;
  const slot = Array.isArray(zone.slot) ? zone.slot.join(',') : (zone.slot || '');
  return /^copy\.headline\b|^copy\.subheadline\b/.test(slot);
}

const violations = [];
let totalChecks = 0;

for (const [templateId, tmpl] of Object.entries(canvas.templates || {})) {
  for (const [ratio, variant] of Object.entries(tmpl.variants || {})) {
    const safe = variant.safe_areas || {};
    const canvasOuter = { x: 0, y: 0, w: variant.canvas?.width || 0, h: variant.canvas?.height || 0 };
    for (const zone of (variant.zones || [])) {
      const r = zone.rect;
      if (!r) continue;

      // Universal: zone within the canvas itself.
      totalChecks++;
      if (!rectInside(r, canvasOuter)) {
        violations.push({ templateId, ratio, zoneId: zone.id, rule: 'within_canvas',
                          rect: r, against: canvasOuter });
      }

      // CTA inside cta_safe.
      if (zone.id === 'cta' && safe.cta_safe) {
        totalChecks++;
        if (!rectInside(r, safe.cta_safe)) {
          violations.push({ templateId, ratio, zoneId: zone.id, rule: 'cta_inside_cta_safe',
                            rect: r, against: safe.cta_safe });
        }
      }

      // Primary copy inside text_primary.
      if (isPrimaryCopy(zone) && safe.text_primary) {
        totalChecks++;
        if (!rectInside(r, safe.text_primary)) {
          violations.push({ templateId, ratio, zoneId: zone.id, rule: 'primary_copy_inside_text_primary',
                            rect: r, against: safe.text_primary });
        }
      }

      // Logo inside logo_safe.
      if (zone.id === 'logo' && safe.logo_safe) {
        totalChecks++;
        if (!rectInside(r, safe.logo_safe)) {
          violations.push({ templateId, ratio, zoneId: zone.id, rule: 'logo_inside_logo_safe',
                            rect: r, against: safe.logo_safe });
        }
      }
    }
  }
}

if (violations.length === 0) {
  console.log(`✅ canvas zones clean (${totalChecks} checks across all template × ratio combinations)`);
  process.exit(0);
}

console.log(`✗ ${violations.length} violation(s) across ${totalChecks} checks:\n`);
for (const v of violations) {
  console.log(`  ${v.templateId} @ ${v.ratio} — zone "${v.zoneId}" — ${v.rule}`);
  console.log(`    zone:   x=${v.rect.x}, y=${v.rect.y}, w=${v.rect.w}, h=${v.rect.h}`);
  console.log(`    bound:  x=${v.against.x}, y=${v.against.y}, w=${v.against.w}, h=${v.against.h}`);
}
process.exit(1);
