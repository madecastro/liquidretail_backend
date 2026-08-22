// U Beauty video ad chrome style.
//
// Brand character: premium clinical skincare. Refined minimalist black
// and white. The actual U Beauty wordmark uses Gt Pressura Text which
// is not available as a Google Font — closest widely-available match
// with the same clean-geometric character is Inter. For hero display
// moments we use Antonio (condensed geometric) instead of Bebas Neue —
// slightly warmer proportions read as more premium against product
// photography, less "sports poster."
//
// Colors lean deeper than the code defaults: #0A0A0A instead of
// #1A1A1A on darks, giving crisper contrast on light backdrops. Neutral
// white stays pure #FFFFFF — no tint.
//
// Scale: hero drops 6px from the default 124 → 118. Luxury skincare
// reads better with slightly less-shouty typography.

module.exports = {
  brandName: 'U Beauty',
  notes:     'Premium clinical skincare. Deep blacks, clean geometric sans, refined display.',

  // ── Role layout ────────────────────────────────────────────────────
  //
  // Per-role placement + treatment. The storyboard picks WHICH roles
  // and WHAT text; brand layout picks WHERE each role sits and HOW it
  // looks. Applied after content normalization (verbatim + injection),
  // overriding whatever position/scale/style the storyboard chose for
  // that role. Storyboard variance is preserved for text + timing;
  // visual identity stays brand-consistent.
  //
  // Every role that a text_beat could carry should have an entry here.
  // Missing roles fall through to whatever the storyboard picked
  // (renderer defaults apply for unspecified enum fields).
  role_layout: {
    // Signature identity — headline lives in the upper third against
    // a subtle scrim.
    headline: {
      position:             'upper_third',
      scale:                'large',
      font_style:           'confident_sans',
      color_hint:           'neutral_white',
      motion:               'fade',
      background_treatment: 'scrim'
    },
    // Support copy stacked below the headline when both are present.
    subheadline: {
      position:             'upper_third',
      scale:                'medium',
      font_style:           'humanist_sans',
      color_hint:           'neutral_white',
      motion:               'fade',
      background_treatment: 'scrim'
    },
    eyebrow: {
      position:             'upper_third',
      scale:                'small',
      font_style:           'confident_sans',
      color_hint:           'neutral_white',
      motion:               'fade',
      background_treatment: 'scrim'
    },
    // Bottom-third grouping per brand signature — social proof + rating
    // + product_name all sit in the lower canvas so the eye moves from
    // top (headline) to bottom (identity + proof) predictably across ads.
    quote: {
      position:             'lower_third',
      scale:                'medium',
      font_style:           'refined_serif',
      color_hint:           'neutral_white',
      motion:               'fade',
      background_treatment: 'solid_card'
    },
    attribution: {
      position:             'lower_third',
      scale:                'small',
      font_style:           'confident_sans',
      color_hint:           'neutral_white',
      motion:               'fade',
      background_treatment: 'solid_card'
    },
    rating: {
      position:             'lower_third',
      scale:                'small',
      font_style:           'confident_sans',
      color_hint:           'warm_gold',
      motion:               'fade',
      background_treatment: 'solid_card'
    },
    // product_name is a rendered text_beat when the storyboard explicitly
    // chooses it as a role (rare — usually the headline carries the
    // product identity). When it fires, treat like a lower-third label.
    product_name: {
      position:             'lower_third',
      scale:                'small',
      font_style:           'confident_sans',
      color_hint:           'neutral_white',
      motion:               'fade',
      background_treatment: 'none'
    },
    // Trust badges sit in the bottom-third row too, small caption weight.
    badge: {
      position:             'lower_third',
      scale:                'small',
      font_style:           'confident_sans',
      color_hint:           'neutral_white',
      motion:               'fade',
      background_treatment: 'solid_card'
    },
    // Benefit callouts land in the upper-third so they don't compete
    // with the bottom-third social-proof cluster.
    benefit: {
      position:             'upper_third',
      scale:                'medium',
      font_style:           'humanist_sans',
      color_hint:           'neutral_white',
      motion:               'fade',
      background_treatment: 'scrim'
    },
    // Promotional callouts (secondary urgency line) — upper-third
    // small, similar to eyebrow.
    highlight: {
      position:             'upper_third',
      scale:                'small',
      font_style:           'confident_sans',
      color_hint:           'warm_gold',
      motion:               'fade',
      background_treatment: 'none'
    },
    // Price on center_lower for promotional concepts — bold display
    // scale, sits between the headline zone and the CTA zone.
    price: {
      position:             'center_lower',
      scale:                'large',
      font_style:           'display',
      color_hint:           'neutral_white',
      motion:               'scale_in',
      background_treatment: 'wash'
    },
    // The primary action — hero scale on a light wash pill, dominates
    // the end card.
    cta: {
      position:             'lower_third',
      scale:                'hero',
      font_style:           'display',
      color_hint:           'high_contrast_dark',
      motion:               'scale_in',
      background_treatment: 'wash'
    },
    // Identity anchor — always the bottom-right corner for U Beauty.
    // Static so it's readable through the end card freeze.
    brand_mark: {
      position:             'corner_bottom_right',
      scale:                'small',
      font_style:           'confident_sans',
      color_hint:           'neutral_white',
      motion:               'static',
      background_treatment: 'none'
    }
  },

  fonts: {
    // Modern clean geometric sans for headlines / CTAs / brand mark.
    confident_sans: {
      importFragment: 'Inter:wght@400;600;700;800',
      fontFamily:     "'Inter', 'Noto Sans', 'Helvetica Neue', Arial, sans-serif",
      weight:         800
    },
    // Warmer humanist sans — used for benefits / body copy where
    // confident_sans would feel too corporate.
    humanist_sans: {
      importFragment: 'DM+Sans:wght@400;500;700',
      fontFamily:     "'DM Sans', 'Inter', 'Noto Sans', sans-serif",
      weight:         700
    },
    // Antonio is a condensed geometric display — softer proportions
    // than Bebas Neue while keeping the wide-vertical hero energy.
    // Better fit for luxury skincare than Bebas Neue's sports-poster feel.
    display: {
      importFragment: 'Antonio:wght@400;600;700',
      fontFamily:     "'Antonio', 'Bebas Neue', Impact, sans-serif",
      weight:         700
    }
    // refined_serif + monospace fall through to renderer defaults —
    // U Beauty rarely uses either.
  },

  colors: {
    // Deeper than the default #1A1A1A — reads more premium against
    // product photography.
    high_contrast_dark: '#0A0A0A',
    neutral_black:      '#0A0A0A'
    // high_contrast_light, neutral_white, warm_gold fall through to defaults.
  },

  fontSizes: {
    // Slightly smaller hero for a more refined feel. Base 118 (default
    // 124) still fills the frame at hero scale but doesn't feel shouty.
    hero:   118
    // large / medium / small fall through to defaults.
  },

  // Slightly deeper corner insets — the extra 8px breathing room
  // helps brand_mark and eyebrow beats feel deliberate rather than
  // pushed against the safe-area edge.
  cornerInset: 56,

  // Slightly narrower centered content — better for text hierarchy on
  // premium ads (75% of canvas vs default 80%).
  centerMaxWidthRatio: 0.75
};
