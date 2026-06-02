// Build the rich context payload + vision attachment list the AI
// canvas spec service feeds to the LLM. Reads from the same loadContext
// output layoutInputService uses, plus the layoutInput artifact (for
// derived copy candidates) — packages everything as:
//
//   {
//     text:    { brand, campaign, product, source_media, social_context, copy_candidates }
//     images:  [ { role, url, label? }, ... ]
//   }
//
// text is what gets formatted into the user prompt. images becomes
// image_url message parts on OpenAI / inlineData on Gemini. Roles let
// the prompt reference specific assets unambiguously
// ("the source_hero image shows ...").
//
// Phase 1d scope: arrays for copy candidates even when they contain
// a single entry — the LLM "picks" by index. Phase 1e expands the
// derivation step to emit multiple per field.

const Comment = require('../models/Media').db?.models?.Comment || require('../models/Comment');

const SMART_CROP_RATIOS = ['1:1', '4:5', '5:4'];          // base smart crops
const EXTENDED_CROP_RATIOS = ['9:16', '1.91:1'];          // ai-extended

async function buildAiCanvasContext({ ctx, layoutInput, aspectRatio }) {
  const { media, detection, crops, extended, match, overlayZones, productHero } = ctx;
  const brand = layoutInput.brand || {};
  const product = layoutInput.product || {};
  const copy = layoutInput.copy || {};

  // ── Text payload ────────────────────────────────────────────────
  const text = {
    canvas: {
      aspect_ratio: aspectRatio,
      coordinate_system: '0..1000 normalized on both axes'
    },

    brand: {
      name:           brand.name      || null,
      tagline:        brand.tagline   || null,
      tone:           Array.isArray(brand.tone) ? brand.tone : [],
      primary_color:  brand.primary_color   || null,
      secondary_color:brand.secondary_color || null,
      accent_color:   brand.accent_color    || null,
      font_family:    brand.font_family     || null,
      logo_present:   !!brand.logo
    },

    campaign: {
      kind:          layoutInput.campaign?.kind || null,
      offer:         layoutInput.campaign?.offer || null,
      raffle_prize:  layoutInput.campaign?.raffle?.prizeMedia?.fileUrl ? 'present' : null
    },

    product: {
      name:           product.name        || null,
      description:    product.description || null,
      category:       product.category    || null,
      brand:          product.brand       || null,
      price:          product.price       ?? null,
      currency:       product.currency    || null,
      hero_image_present:     !!product.hero_media?.image,
      lifestyle_image_present:!!product.lifestyle_image?.image,
      product_image_present:  !!product.product_image?.image,
      badges:         Array.isArray(product.badges) ? product.badges : [],
      rating:         product.rating ?? null,
      review_count:   product.review_count ?? null,
      review_summary: product.review_summary || null,
      top_reviews:    (product.reviews || []).slice(0, 3).map(r => ({
        author: r.author || null,
        text:   typeof r.text === 'string' ? r.text.slice(0, 200) : null,
        rating: r.rating ?? null
      }))
    },

    source_media: {
      origin:        media.source || null,             // 'instagram' | 'tiktok' | 'catalog-product' | 'manual_upload'
      file_type:     media.fileType || null,           // 'image' | 'video'
      shot_type:     media.classification?.shotType    || null,
      content_nature:media.classification?.contentNature || null,
      primary_subject: media.primarySubjectLabel || detection?.primarySubjectDesc || null,
      secondary_elements: Array.isArray(media.secondaryElementsTags) ? media.secondaryElementsTags : [],
      background: detection?.background ? {
        setting:    detection.background.setting    || null,
        scene_type: detection.background.sceneType  || null,
        lighting:   detection.background.lighting   || null,
        style:      detection.background.style      || null,
        mood:       Array.isArray(detection.background.mood) ? detection.background.mood : [],
        palette:    Array.isArray(detection.background.palette) ? detection.background.palette : [],
        notes:      detection.background.notes      || null
      } : null,
      // Subjects with bboxes — LLM uses these + overlay zones to know
      // where the photo's content sits, so it can place text in
      // genuinely safe regions instead of guessing.
      subjects: (detection?.subjects || []).slice(0, 5).map(s => ({
        id:          s.id,
        role:        s.role,
        label:       s.description ? s.description.slice(0, 80) : null,
        bbox_pct:    bboxPct(s)
      })),
      text_in_image: (detection?.text || []).slice(0, 5).map(t => ({
        content:   typeof t.content === 'string' ? t.content.slice(0, 60) : null,
        bbox_pct:  bboxPct(t),
        confidence: t.confidence
      })),
      safe_overlay_zones: extractSafeZones(overlayZones, aspectRatio)
    },

    social_context: media.source === 'instagram' || media.source === 'tiktok' ? {
      stats: {
        likes:      media.platformStats?.likes    ?? null,
        comments:   media.platformStats?.comments ?? null,
        shares:     media.platformStats?.shares   ?? null,
        saves:      media.platformStats?.saves    ?? null,
        reach:      media.platformStats?.reach    ?? null,
        engagement: media.platformStats?.engagement ?? null
      },
      creator: {
        handle:         media.metadata?.creatorHandle || null,
        platform:       media.source || null,
        follower_count: media.metadata?.creatorFollowerCount ?? null
      },
      caption:    media.metadata?.caption || null,
      posted_at:  media.metadata?.postedAt || null,
      permalink:  media.metadata?.permalink || null,
      top_comments: await loadTopComments(media._id, 3)
    } : null,

    // Copy CANDIDATES — arrays so the LLM picks by index. Phase 1d
    // expands these to 3-5 each in derivation; today these are
    // single-element arrays drawn from the existing input.copy.*.
    copy_candidates: {
      headlines:    nonEmptyArray([copy.headline]),
      subheadlines: nonEmptyArray([copy.subheadline]),
      eyebrows:     nonEmptyArray([copy.eyebrow]),
      cta_text:     layoutInput.cta?.text || copy.cta_text || 'Shop now',
      short_benefits: Array.isArray(product.short_benefits) ? product.short_benefits : [],
      quotes: (layoutInput.social_proof?.secondary_quotes || []).concat(
                 layoutInput.social_proof?.primary_quote ? [layoutInput.social_proof.primary_quote] : []
               ).slice(0, 5).map(q => ({
                 text:   q.text || null,
                 author: q.author_name || null
               })),
      badges_pool: Array.isArray(product.badges) ? product.badges : []
    }
  };

  // ── Vision attachments ──────────────────────────────────────────
  // Order matters — the prompt references "image[N]" indices. Skip
  // entries with no URL so OpenAI doesn't 400 on null image_url.
  const images = [];
  if (brand.logo) {
    images.push({ role: 'brand_logo', url: brand.logo, label: 'Brand logo' });
  }
  const heroUrl = product.hero_media?.image || product.image || null;
  if (heroUrl) {
    images.push({ role: 'source_hero', url: heroUrl, label: 'Hero media (source photo for the ad)' });
  }
  if (product.lifestyle_image?.image && product.lifestyle_image.image !== heroUrl) {
    images.push({ role: 'product_lifestyle', url: product.lifestyle_image.image, label: 'Catalog lifestyle shot' });
  }
  if (product.product_image?.image && product.product_image.image !== heroUrl) {
    images.push({ role: 'product_only', url: product.product_image.image, label: 'Catalog product-only shot (clean studio)' });
  }
  // Top-2 catalog alt images for the operator's chosen product. These
  // are catalog Media (source='catalog-product') unrelated to hero.
  if (productHero?.catalogProduct?.additionalImages) {
    for (let i = 0; i < productHero.catalogProduct.additionalImages.length && i < 2; i++) {
      const url = productHero.catalogProduct.additionalImages[i];
      if (url && !images.some(img => img.url === url)) {
        images.push({ role: `catalog_alt_${i + 1}`, url, label: `Catalog alt #${i + 1}` });
      }
    }
  }

  return { text, images };
}

function bboxPct(b) {
  if (!b) return null;
  const x1 = clamp01(b.x1), y1 = clamp01(b.y1), x2 = clamp01(b.x2), y2 = clamp01(b.y2);
  if (isNaN(x1) || isNaN(y1) || isNaN(x2) || isNaN(y2)) return null;
  // Convert 0..1 normalized to 0..1000 to match the canvas coordinate
  // system the LLM emits zones in.
  return {
    x: Math.round(x1 * 1000),
    y: Math.round(y1 * 1000),
    w: Math.round((x2 - x1) * 1000),
    h: Math.round((y2 - y1) * 1000)
  };
}

function clamp01(v) {
  const n = Number(v);
  return Math.max(0, Math.min(1, isNaN(n) ? 0 : n));
}

function nonEmptyArray(arr) {
  return (arr || []).filter(v => v != null && v !== '');
}

// overlayZones is the OverlayZoneArtifact — { zones: { '1:1': [...], '9:16': [...] } }.
// Each zone entry has rect (0..1 normalized), contrastBg label, brightness.
// Return the zones for the active aspectRatio in 0..1000 coords so the
// LLM can place text inside them.
function extractSafeZones(overlayZones, aspectRatio) {
  if (!overlayZones?.zones) return [];
  const list = overlayZones.zones[aspectRatio] || [];
  return list.slice(0, 6).map((z, i) => ({
    id:          z.id || `safe_${i + 1}`,
    rect:        bboxPct({ x1: z.rect?.x1, y1: z.rect?.y1, x2: z.rect?.x2, y2: z.rect?.y2 }),
    contrast_bg: z.contrastBg || z.contrast_bg || null,
    brightness:  z.brightness ?? null,
    notes:       z.notes || null
  })).filter(z => z.rect);
}

async function loadTopComments(mediaId, n) {
  try {
    const C = require('../models/Comment');
    const rows = await C.find({ mediaId })
      .sort({ likeCount: -1, postedAt: -1 })
      .limit(n)
      .select('author authorUsername text content likeCount postedAt')
      .lean();
    return rows.map(c => ({
      author:  c.author || c.authorUsername || null,
      text:    (c.text || c.content || '').slice(0, 200),
      likes:   c.likeCount ?? null,
      posted_at: c.postedAt || null
    }));
  } catch (_) {
    return [];   // Comment model optional — UGC ingestion may not have populated it yet
  }
}

module.exports = { buildAiCanvasContext };
