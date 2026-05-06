// Slot budget calculator. Given a canvas variant, returns per-zone
// character/word/line budgets that the renderer's rect, font scale, and
// decorations can actually accept without auto-fit shrinking the text.
//
// The point of this module is to push design-aware char caps into the
// derivation prompt so Gemini writes copy *to* the slot, instead of
// producing copy that the runtime fitAndClampZone has to compress.
//
// Numbers below are paired to the rendered CSS in
// frontend/client/ads.html. If the CSS rules drift (font_em changes,
// letter-spacing changes, lead-clause scale changes), update ZONE_STYLE
// and AVG_GLYPH_W_EM here in the same PR.
//
// Coordinates are normalized canvas units (1000 wide, height varies by
// ratio). Since fonts and zones scale together the answer is the same
// at any pixel size: chars = zoneW / charW with both in the same units.

// Stage's em-base mirrors ads.html line 167:
//   stage.style.fontSize = `${Math.max(12, canvasW / 22)}px`
// So 1em on canvas = canvasW / 22 normalized units.
const EM_BASE_DIVISOR = 22;

// Average glyph advance (per em) by font kind. These are heuristics,
// not measurements — refine if a specific letter mix in production
// consistently overflows or underfills.
// Calibrated against the reference creative ("COMING IN HOT" — 13 chars
// fitting the 516-unit slot at fontMain ≈ 84 normalized px implies a
// per-em glyph advance of ~0.47). 0.50 leaves a small slack so the
// budget doesn't push the LLM into copy that just barely overflows.
const AVG_GLYPH_W_EM = {
  display_script:  0.50, // Knewave / Bungee uppercase
  body_uppercase:  0.62, // Inter uppercase + tracking
  body_sentence:   0.52  // Inter mixed-case
};

// Per-zone-kind style — must mirror the live CSS so budgets match what
// the renderer paints. headline.font_em is the *main clause*; the lead
// clause is half of that (per .tp-headline-lead { font-size: 0.5em }).
const ZONE_STYLE = {
  display_script: {
    font_em:           1.85,
    line_height:       0.95,
    lead_scale:        0.5,
    lead_line_height:  1.0,
    lead_margin_em:    0.05,
    glyph_class:       'display_script'
  },
  eyebrow_rules: {
    font_em:                 0.28,
    line_height:             1.0,
    letter_spacing_em:       0.18,
    glyph_class:             'body_uppercase',
    decoration_overhead_frac: 0.30 // hairline rules + flanking gaps eat ~30% of zone width
  }
};

function emBasePx(canvasW) { return canvasW / EM_BASE_DIVISOR; }

// Compute headline budget for a display_script zone. Returns separate
// caps for `lead` (small first clause) and `main` (large second clause).
// Layout assumption: 1 lead line stacked on top, then N main lines under
// it — same as the .tp-headline-lead / .tp-headline-main split applied
// in resolveZoneContent.
function computeHeadlineBudget(zone, canvas) {
  const style = ZONE_STYLE.display_script;
  const fontMainPx = emBasePx(canvas.width) * style.font_em;
  const fontLeadPx = fontMainPx * style.lead_scale;

  const charWMain = fontMainPx * AVG_GLYPH_W_EM.display_script;
  const charWLead = fontLeadPx * AVG_GLYPH_W_EM.display_script;

  const lineHMain = fontMainPx * style.line_height;
  const lineHLead = fontLeadPx * style.lead_line_height;

  const leadSpace = lineHLead + (fontLeadPx * style.lead_margin_em);
  const remaining = Math.max(0, zone.rect.h - leadSpace);
  const mainLinesGeo = Math.max(1, Math.floor(remaining / lineHMain));
  const mainLines    = Math.min(mainLinesGeo, Math.max(1, (zone.max_lines || 4) - 1));

  const charsPerLineMain = Math.max(4, Math.floor(zone.rect.w / charWMain));
  const charsPerLineLead = Math.max(4, Math.floor(zone.rect.w / charWLead));

  return {
    lead: {
      max_chars: charsPerLineLead,
      max_lines: 1,
      max_words: Math.max(1, Math.floor(charsPerLineLead / 5))
    },
    main: {
      max_chars: charsPerLineMain * mainLines,
      max_lines: mainLines,
      max_words: Math.max(2, Math.floor((charsPerLineMain * mainLines) / 5))
    },
    chars_per_line: { lead: charsPerLineLead, main: charsPerLineMain },
    total_lines: mainLines + 1
  };
}

// Compute eyebrow_rules budget. Single line, white-space:nowrap, with
// hairlines flanking the centered text. Reserve decoration_overhead_frac
// of zone width so the rules stay visually present (don't collapse to
// near-zero); the remaining width × char-advance gives the cap.
function computeEyebrowBudget(zone, canvas) {
  const style = ZONE_STYLE.eyebrow_rules;
  const fontPx     = emBasePx(canvas.width) * style.font_em;
  const glyphW     = fontPx * AVG_GLYPH_W_EM[style.glyph_class];
  const letterAdv  = fontPx * style.letter_spacing_em;
  const charAdvance = glyphW + letterAdv;

  const usableW  = zone.rect.w * (1 - style.decoration_overhead_frac);
  const max_chars = Math.max(8, Math.floor(usableW / charAdvance));
  return {
    max_chars,
    max_lines: 1,
    max_words: Math.max(2, Math.floor(max_chars / 7))
  };
}

// Walk a canvas variant and emit budgets for the slots Gemini writes.
// Currently scoped to headline (display_script split) and eyebrow_rules,
// since those are the slots whose decorations make naive char counts
// wrong. Other zones rely on truncation_rules + auto-fit as before.
function computeSlotBudgets(canvasVariant) {
  if (!canvasVariant || !Array.isArray(canvasVariant.zones)) return {};
  const canvas = canvasVariant.canvas || { width: 1000, height: 1000 };
  const out = {};

  const headlineZone = canvasVariant.zones.find(z =>
    z.id === 'headline' && z.style_variant === 'display_script');
  if (headlineZone) out.headline = computeHeadlineBudget(headlineZone, canvas);

  const eyebrowZone = canvasVariant.zones.find(z => z.kind === 'eyebrow_rules');
  if (eyebrowZone) out.eyebrow = computeEyebrowBudget(eyebrowZone, canvas);

  return out;
}

module.exports = {
  computeSlotBudgets,
  computeHeadlineBudget,
  computeEyebrowBudget
};
