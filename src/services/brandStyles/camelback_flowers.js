// Camelback Flowers video ad chrome style.
//
// Brand character: premium local florist. Warm cream and deep espresso
// against real botanical imagery. Where U Beauty leans clinical and
// geometric, Camelback leans editorial and organic — elegant serif
// headlines, a flowing titling script for hero moments (CTA + price),
// and cream/espresso instead of black-and-white.
//
// The "titling script" is Great Vibes: a formal flowing script widely
// used on wedding invitations and florist branding. Reserved for CTA
// and price so it stays legible — scripts don't survive at eyebrow /
// caption sizes. Headlines stay in Cormorant Garamond (high-contrast
// serif, reads editorial when set uppercase). Body copy is Lora, a
// warm humanist serif that pairs with Cormorant without competing.
//
// Layout keeps the vertical center clear so the flower imagery is
// the hero. Text lives in upper / lower thirds. Brand mark sits in
// the TOP LEFT (vs U Beauty's bottom right) so it doesn't compete
// with the script-heavy CTA cluster in the lower third.

module.exports = {
  brandName: 'Camelback Flowers',
  notes:     'Premium local florist. Warm cream + espresso, elegant serif headlines, titling script for CTA + price.',

  // ── Role layout ────────────────────────────────────────────────────
  //
  // Same principles as u_beauty.js — brand layout picks WHERE + HOW,
  // storyboard picks WHICH roles + WHAT text.
  role_layout: {
    // Upper-third: headline zone. Cormorant Garamond wash-backed so
    // it reads against varied botanical backdrops without a hard card.
    headline: {
      position:             'upper_third',
      scale:                'large',
      font_style:           'confident_sans',
      color_hint:           'neutral_white',
      motion:               'fade',
      background_treatment: 'wash'
    },
    subheadline: {
      position:             'upper_third',
      scale:                'medium',
      font_style:           'humanist_sans',
      color_hint:           'neutral_white',
      motion:               'fade',
      background_treatment: 'wash'
    },
    eyebrow: {
      position:             'upper_third',
      scale:                'small',
      font_style:           'confident_sans',
      color_hint:           'warm_gold',
      motion:               'fade',
      background_treatment: 'none'
    },
    // Benefits stay upper-third so lower-third stays reserved for
    // proof + CTA.
    benefit: {
      position:             'upper_third',
      scale:                'medium',
      font_style:           'humanist_sans',
      color_hint:           'neutral_white',
      motion:               'fade',
      background_treatment: 'wash'
    },
    highlight: {
      position:             'upper_third',
      scale:                'small',
      font_style:           'confident_sans',
      color_hint:           'warm_gold',
      motion:               'fade',
      background_treatment: 'none'
    },

    // Lower-third: proof cluster + CTA. Quote in italic serif for
    // editorial warmth. Attribution / rating in small serif caps.
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
    product_name: {
      position:             'lower_third',
      scale:                'small',
      font_style:           'humanist_sans',
      color_hint:           'neutral_white',
      motion:               'fade',
      background_treatment: 'none'
    },
    badge: {
      position:             'lower_third',
      scale:                'small',
      font_style:           'confident_sans',
      color_hint:           'neutral_white',
      motion:               'fade',
      background_treatment: 'solid_card'
    },

    // Price on center_lower — Great Vibes at hero scale on a cream
    // wash pill for promotional concepts.
    price: {
      position:             'center_lower',
      scale:                'large',
      font_style:           'display',
      color_hint:           'high_contrast_dark',
      motion:               'scale_in',
      background_treatment: 'wash'
    },

    // The signature moment — CTA in the titling script, hero scale,
    // deep espresso on a cream wash pill. Legibility comes from the
    // wash background contrast + the hero size; script would fail at
    // smaller scales.
    cta: {
      position:             'lower_third',
      scale:                'hero',
      font_style:           'display',
      color_hint:           'high_contrast_dark',
      motion:               'scale_in',
      background_treatment: 'wash'
    },

    // Brand mark opposite U Beauty — top-left corner. Keeps the
    // script-heavy CTA cluster in the lower right visually uncluttered.
    brand_mark: {
      position:             'corner_top_left',
      scale:                'small',
      font_style:           'confident_sans',
      color_hint:           'neutral_white',
      motion:               'static',
      background_treatment: 'none'
    }
  },

  fonts: {
    // Cormorant Garamond — high-contrast display serif. Reads editorial
    // when set uppercase for headlines; the tall x-height + tapered
    // terminals pair naturally with botanical imagery.
    confident_sans: {
      importFragment: 'Cormorant+Garamond:wght@500;600;700;800',
      fontFamily:     "'Cormorant Garamond', 'Playfair Display', 'Times New Roman', serif",
      weight:         700
    },
    // Lora — warm humanist serif. Subheadlines / benefits / body copy.
    // Chosen over Cormorant here so the two levels of hierarchy don't
    // fight each other.
    humanist_sans: {
      importFragment: 'Lora:ital,wght@0,400;0,500;0,600;1,400',
      fontFamily:     "'Lora', 'Cormorant Garamond', 'Georgia', serif",
      weight:         500
    },
    // The titling script. Great Vibes is a formal flowing script —
    // wedding-invitation vocabulary. Legible at hero + large scales,
    // falls apart below medium. Reserved for CTA + price so the
    // renderer never asks it to carry small text.
    display: {
      importFragment: 'Great+Vibes:wght@400',
      fontFamily:     "'Great Vibes', 'Allura', 'Petit Formal Script', 'Playfair Display', cursive",
      weight:         400
    },
    // Playfair Display Italic for quotes — editorial magazine feel.
    refined_serif: {
      importFragment: 'Playfair+Display:ital,wght@1,400;1,500;1,600',
      fontFamily:     "'Playfair Display', 'Cormorant Garamond', 'Georgia', serif",
      weight:         500
    }
  },

  colors: {
    // Warm cream instead of stark #FFFFFF — reads premium against
    // botanical photography where a pure white pill looks synthetic.
    neutral_white:      '#F7F1E8',
    // Deep espresso instead of pure black. Complements the cream and
    // stays legible on cream wash pills.
    neutral_black:      '#2C1810',
    high_contrast_dark: '#2C1810',
    high_contrast_light:'#F7F1E8',
    // Softer, muted gold — reads as botanical accent (dried grass /
    // amber) rather than metallic.
    warm_gold:          '#B8945E'
  },

  fontSizes: {
    // Script fonts have LESS visual weight per pixel than a bold sans —
    // they need extra size to feel like a hero moment. Bump hero from
    // default 124 to 140 so Great Vibes reads at end-card scale.
    hero: 140
    // large / medium / small fall through to defaults.
  },

  // A touch more breathing room than U Beauty's 56 — 60px inset gives
  // the top-left brand mark room to sit without crowding.
  cornerInset: 60,

  // Narrower centered content — 0.72 vs U Beauty's 0.75. Keeps the
  // flower imagery visible around any centered price/CTA cluster.
  centerMaxWidthRatio: 0.72
};
