// One-shot schema edit — removes badge_row from testimonial_spotlight
// and ugc_split_screen (canvas + normalized specs), and extends the
// hero card (quote_card for testimonial, product_card for ugc_split)
// to fill the freed vertical space + the gap that previously sat
// between badge_row and CTA.
//
// Run: node server/scripts/removeBadgeRowExtendCards.js
//
// Idempotent — re-running on already-edited specs is a no-op (the
// badge_row removal checks `if (idx < 0) continue`).

const fs   = require('fs');
const path = require('path');

const CANVAS_PATH = path.join(__dirname, '..', 'schemas', 'rsSocialProof.canvas.v1.json');
const NORM_PATH   = path.join(__dirname, '..', 'schemas', 'rsSocialProof.templates.normalized.json');

// Match by KIND not id — testimonial_spotlight's hero is id=quote_card
// kind=quote_card, while ugc_split_screen's hero is id=product_meta
// kind=product_card. Matching on kind covers both without per-variant
// id lookup tables.
const TARGETS = {
  testimonial_spotlight: 'quote_card',
  ugc_split_screen:      'product_card'
};
function isTargetZone(zone, kind) {
  return zone && (zone.id === kind || zone.kind === kind);
}

function bottomPaddingFor(cta) {
  // Leave breathing room between the extended hero card and the CTA.
  // 24px on big canvases (>=1000px tall), 16px otherwise.
  return cta && cta.rect && cta.rect.h >= 50 ? 24 : 16;
}

function editCanvas(spec) {
  let totalEdits = 0;
  for (const [templateId, targetZoneId] of Object.entries(TARGETS)) {
    const tpl = spec.templates?.[templateId];
    if (!tpl?.variants) continue;
    for (const [ratio, variant] of Object.entries(tpl.variants)) {
      const zones = variant.zones || [];
      const badgeIdx = zones.findIndex(z => z.id === 'badge_row');
      const targetIdx = zones.findIndex(z => isTargetZone(z, targetZoneId));
      const ctaIdx    = zones.findIndex(z => z.id === 'cta');
      if (badgeIdx < 0 && targetIdx < 0) continue;

      // Plan the target extension BEFORE mutating zones[].
      if (targetIdx >= 0) {
        const target = zones[targetIdx];
        const cta    = ctaIdx >= 0 ? zones[ctaIdx] : null;
        const pad    = bottomPaddingFor(cta);
        const canvasH = variant.canvas?.height ?? 1000;

        // Bottom limit:
        //   - When target.column !== cta.column (2-column layouts like
        //     4:5 + 9:16 where the hero card sits left and CTA sits
        //     right): extend all the way to canvas.height - pad.
        //   - Otherwise (single-column stack): extend down to cta.top
        //     - pad so the card never overlaps the CTA.
        const isTwoCol = target.column && cta?.column && target.column !== cta.column;
        const bottomLimit = isTwoCol || !cta?.rect?.y
          ? canvasH - pad
          : cta.rect.y - pad;
        const oldH = target.rect.h;
        const newH = bottomLimit - target.rect.y;

        // Only extend (never shrink) — operators that already tuned
        // the card by hand would lose work otherwise.
        if (newH > oldH) {
          console.log(`  ${templateId}/${ratio}: ${target.id} h ${oldH} → ${newH}${isTwoCol ? ' (2-col)' : ''}`);
          target.rect.h = newH;
          // Bump max_lines proportionally so the renderer's auto-fit
          // has room to grow text vs. clamp it back to the old budget.
          // Heuristic: cap max_lines at floor(newH / 50), bounded at 12.
          if (typeof target.max_lines === 'number') {
            const proposed = Math.max(target.max_lines, Math.min(12, Math.floor(newH / 50)));
            if (proposed !== target.max_lines) {
              console.log(`    max_lines ${target.max_lines} → ${proposed}`);
              target.max_lines = proposed;
            }
          }
          totalEdits++;
        }
      }

      // Remove badge_row from zones[].
      if (badgeIdx >= 0) {
        zones.splice(badgeIdx, 1);
        totalEdits++;
      }
      // Remove from render_order.
      if (Array.isArray(variant.render_order)) {
        const i = variant.render_order.indexOf('badge_row');
        if (i >= 0) { variant.render_order.splice(i, 1); totalEdits++; }
      }
      // Remove from zone_scalers.
      if (variant.zone_scalers && Object.prototype.hasOwnProperty.call(variant.zone_scalers, 'badge_row')) {
        delete variant.zone_scalers.badge_row;
        totalEdits++;
      }
    }
  }
  return totalEdits;
}

function editNormalized(spec) {
  let totalEdits = 0;
  const templates = Array.isArray(spec.templates) ? spec.templates : [];
  for (const tpl of templates) {
    if (!Object.prototype.hasOwnProperty.call(TARGETS, tpl.template_id)) continue;
    if (tpl.zones && tpl.zones.badge_row) {
      delete tpl.zones.badge_row;
      totalEdits++;
    }
    if (Array.isArray(tpl.render_order)) {
      const i = tpl.render_order.indexOf('badge_row');
      if (i >= 0) { tpl.render_order.splice(i, 1); totalEdits++; }
    }
    for (const key of ['required_all_of', 'required_any_of', 'optional']) {
      if (Array.isArray(tpl[key])) {
        const i = tpl[key].indexOf('badge_row');
        if (i >= 0) { tpl[key].splice(i, 1); totalEdits++; }
      }
    }
  }
  return totalEdits;
}

function main() {
  const canvasRaw = fs.readFileSync(CANVAS_PATH, 'utf8');
  const normRaw   = fs.readFileSync(NORM_PATH,   'utf8');
  const canvas = JSON.parse(canvasRaw);
  const norm   = JSON.parse(normRaw);

  console.log('Editing canvas.v1.json…');
  const cEdits = editCanvas(canvas);
  console.log(`Canvas edits: ${cEdits}`);

  console.log('\nEditing templates.normalized.json…');
  const nEdits = editNormalized(norm);
  console.log(`Normalized edits: ${nEdits}`);

  fs.writeFileSync(CANVAS_PATH, JSON.stringify(canvas, null, 2) + '\n', 'utf8');
  fs.writeFileSync(NORM_PATH,   JSON.stringify(norm,   null, 2) + '\n', 'utf8');
  console.log('\nWrote both schema files.');
}

main();
