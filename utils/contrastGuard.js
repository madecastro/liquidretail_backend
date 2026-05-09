// Post-resolution contrast guard for canvas-zone templates.
//
// resolveStyleBindings cascades each binding through its source_priority
// chain (palette_vibrant → palette_accent → brand color → default). Each
// chain is independent — the cascade has no awareness of what color the
// adjacent surface bg ended up as. So a vibrant headline color can pass
// its own saturation+contrast-vs-dominant gates, then land on a panel_bg
// that resolved to brand.primary_color (because palette_dominant was
// missing) and fail to read.
//
// This guard runs AFTER resolveStyleBindings, walks declared text/bg
// pairs per template, computes WCAG contrast on the resolved hex pair,
// and overrides the text binding with readableOn(bg) when contrast is
// below threshold.
//
// Skipped:
//   - bg or text not a hex (e.g. rgba chip backgrounds, or text resolved
//     to the 'auto-from-brightness' sentinel which the renderer handles)
//   - overlay-on-image templates (testimonial_overlay, product_overlay) —
//     those use brightness-grid sampling at placement time, not pair
//     contrast on resolved bindings.

const { isHex, contrast, readableOn, WCAG_AA_NORMAL, WCAG_AA_LARGE } = require('./colorContrast');

// Threshold band — a tiny margin above WCAG AA so borderline pairs
// (e.g. 4.51 contrast) aren't flipped on every render. The guard only
// kicks in when contrast is meaningfully insufficient.
const HEADLINE_THRESHOLD     = WCAG_AA_LARGE;   // 3.0 — display sizes
const SECTION_HEAD_THRESHOLD = WCAG_AA_NORMAL;  // 4.5 — small uppercase
const BODY_THRESHOLD         = WCAG_AA_NORMAL;  // 4.5 — proof bar, etc.

// Per-template pair definitions. Each entry: { text, bg, threshold, scale }.
//   text:      binding name to potentially override
//   bg:        binding name whose resolved hex sits behind the text
//   threshold: WCAG contrast ratio below which the text gets flipped
const CONTRAST_PAIRS = {
  testimonial_spotlight: [
    { text: 'headline_text_color',  bg: 'panel_bg',       threshold: HEADLINE_THRESHOLD },
    { text: 'section_header_color', bg: 'panel_bg',       threshold: SECTION_HEAD_THRESHOLD },
    { text: 'cta_button_text',      bg: 'cta_button_bg',  threshold: BODY_THRESHOLD },
    { text: 'proof_bar_text',       bg: 'proof_bar_bg',   threshold: BODY_THRESHOLD }
  ],
  ugc_split_screen: [
    { text: 'headline_text_color',  bg: 'panel_bg',       threshold: HEADLINE_THRESHOLD },
    { text: 'section_header_color', bg: 'panel_bg',       threshold: SECTION_HEAD_THRESHOLD },
    { text: 'cta_button_text',      bg: 'cta_button_bg',  threshold: BODY_THRESHOLD },
    { text: 'proof_bar_text',       bg: 'proof_bar_bg',   threshold: BODY_THRESHOLD }
  ]
  // Overlay templates intentionally absent — they use brightness-grid
  // sampling against the actual image pixels, not pair contrast.
};

// Walk the pair list for the template, override failing text bindings
// in-place. Returns the mutated bindings object plus a trace array
// describing each override (for debug surfacing). Untouched when the
// template has no pair definitions.
function applyContrastGuard(bindings, templateId) {
  const pairs = CONTRAST_PAIRS[templateId];
  if (!pairs || !bindings) return { bindings, overrides: [] };

  const overrides = [];
  for (const { text: textKey, bg: bgKey, threshold } of pairs) {
    const bg   = bindings[bgKey];
    const text = bindings[textKey];

    if (!isHex(bg)) continue;     // chip rgba, or unresolved bg — skip
    if (!isHex(text)) continue;   // 'auto-from-brightness' sentinel etc.

    const ratio = contrast(text, bg);
    if (ratio >= threshold) continue;

    const replacement = readableOn(bg);
    bindings[textKey] = replacement;
    overrides.push({
      textKey, bgKey,
      from: text, to: replacement,
      bg, ratio: Math.round(ratio * 100) / 100,
      threshold
    });
  }

  return { bindings, overrides };
}

module.exports = { applyContrastGuard, CONTRAST_PAIRS };
