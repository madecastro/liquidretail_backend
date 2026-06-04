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
const { buildCloudinaryCropUrl } = require('./layoutInputService');

const SMART_CROP_RATIOS = ['1:1', '4:5', '5:4'];          // base smart crops
const EXTENDED_CROP_RATIOS = ['9:16', '1.91:1'];          // ai-extended

// Map a real aspect-ratio string ('1.91:1') to the underscored key
// the LLM puts in slot paths ('1_91_1' — dots/colons can't appear in
// dotted slot resolution). Used on the way IN to build the crops map
// AND on the way OUT when the LLM emits a slot like
// "product.hero_media.crops.1_91_1".
function ratioKey(ratio) {
  return String(ratio).replace(/[:.]/g, '_');
}

async function buildAiCanvasContext({ ctx, layoutInput, aspectRatio, brandId = null, productId = null, creativeStyle = null }) {
  const { media, detection, crops, extended, match, overlayZones, productHero } = ctx;
  const brand = layoutInput.brand || {};
  const product = layoutInput.product || {};
  const copy = layoutInput.copy || {};

  // Phase 4 — load style-aware copy candidates from CopyCandidatesArtifact
  // (cached per brand × product × creativeStyle). Replaces the legacy
  // single-element wrap of input.copy.* when available; falls through
  // to the legacy shape silently when not.
  let derivedCopy = null;
  if (brandId && creativeStyle) {
    try {
      const copyDerivation = require('./copyDerivationService');
      const cached = await copyDerivation.loadCached({ brandId, productId, creativeStyle });
      if (cached?.candidates) derivedCopy = cached.candidates;
    } catch (err) {
      // Lazy lookup failure is non-fatal — Generator falls back to
      // length-1 copy_candidates arrays. Log for diagnosis.
      console.warn(`   ⚠️  copy-candidates lazy load: ${err.message}`);
    }
  }

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
      // Per-crop spatial analysis (1d-h/1d-i). For each available
      // crop ratio (canvas + the alt ratios the LLM can slot via
      // product.hero_media.crops.*), expose the OverlayZoneArtifact's
      // density grid (visual busy-ness 0–1 per cell), brightness grid
      // (0–1 per cell, drives text-color picking), keep-out zones
      // (subject / face / text / product restrictions in 0..1000
      // coords) and the primary subject rect. This is the real
      // spatial intelligence the renderer has access to — previously
      // the safe_overlay_zones field silently returned [] because
      // extractSafeZones read the wrong artifact shape.
      spatial_analysis: buildSpatialAnalysisMap(overlayZones, aspectRatio)
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

    // Copy CANDIDATES — arrays so the LLM picks by index. Phase 4 fills
    // these from a CopyCandidatesArtifact (per brand × product × style)
    // when present — 3-5 distinct candidates per slot, voiced for the
    // style. Falls back to single-element arrays drawn from the existing
    // input.copy.* when no derivation artifact exists for this cell.
    copy_candidates: {
      headlines:    (derivedCopy?.headlines?.length    ? derivedCopy.headlines    : nonEmptyArray([copy.headline])),
      subheadlines: (derivedCopy?.subheadlines?.length ? derivedCopy.subheadlines : nonEmptyArray([copy.subheadline])),
      eyebrows:     (derivedCopy?.eyebrows?.length     ? derivedCopy.eyebrows     : nonEmptyArray([copy.eyebrow])),
      // cta_text retained as a single string for legacy slot resolution
      // (cta.text path). cta_micro_copy is an additional candidate array
      // the V2 Generator can pick from for button copy variants.
      cta_text:       layoutInput.cta?.text || copy.cta_text || 'Shop now',
      cta_micro_copy: derivedCopy?.cta_micro_copy?.length ? derivedCopy.cta_micro_copy : nonEmptyArray([layoutInput.cta?.text || copy.cta_text || 'Shop now']),
      short_benefits: Array.isArray(product.short_benefits) ? product.short_benefits : [],
      quotes: (layoutInput.social_proof?.secondary_quotes || []).concat(
                 layoutInput.social_proof?.primary_quote ? [layoutInput.social_proof.primary_quote] : []
               ).slice(0, 5).map(q => ({
                 text:   q.text || null,
                 author: q.author_name || null
               })),
      badges_pool: Array.isArray(product.badges) ? product.badges : [],
      // Provenance: tell the LLM whether candidates are style-tailored
      // (5+ variants) or single-string fallbacks. Affects copy_picks
      // behavior — when length=1, the only valid pick is index 0.
      derived_for_style: derivedCopy ? creativeStyle : null
    }
  };

  // ── All-ratio crop maps ─────────────────────────────────────────
  // Build the full menu of crop URLs per source (hero / lifestyle /
  // product_only). The canvas-ratio winner is what the renderer reads
  // by default at `product.hero_media.image`, but the LLM can now
  // slot a different ratio (e.g. product.hero_media.crops.1_91_1 for
  // a panoramic strip on a 1:1 canvas, or .crops.4_5 for a vertical
  // inset). aiCanvasSpecService grafts these onto resolvedInput so
  // the slot paths resolve at render time.
  const heroCrops = buildAllRatioCrops(ctx, 'hero');
  const lifestyleCrops = buildAllRatioCrops(ctx, 'lifestyle');
  const productOnlyCrops = buildAllRatioCrops(ctx, 'product_only');

  // Surface the menu in the text payload so the LLM knows which slot
  // paths are available. URLs themselves are tracked here too so the
  // LLM can reference them in its rationale if it wants.
  text.source_media.alt_crops = {
    hero:          Object.keys(heroCrops),
    lifestyle:     Object.keys(lifestyleCrops),
    product_only:  Object.keys(productOnlyCrops),
    canvas_ratio:  aspectRatio
  };

  // ── Vision attachments ──────────────────────────────────────────
  // Order matters — the prompt references "image[N]" indices. Skip
  // entries with no URL so OpenAI doesn't 400 on null image_url.
  // We pass the canvas-ratio crop as the primary visual, plus up to
  // 2 alt ratios per source so the LLM can SEE what the alt framings
  // look like (not just URLs in text). Token cost stays bounded.
  const images = [];
  if (brand.logo) {
    images.push({ role: 'brand_logo', url: brand.logo, label: 'Brand logo' });
  }
  const heroUrl = product.hero_media?.image || product.image || null;
  if (heroUrl) {
    images.push({ role: 'source_hero', url: heroUrl, label: `Hero @ ${aspectRatio} (canvas crop, default)` });
  }
  // Pick up to 2 alt-ratio hero crops for vision. Prefer the most
  // different aspects from the canvas (a 1.91:1 strip and a 9:16
  // portrait give the LLM the widest creative range).
  const altHeroPick = pickAltRatiosForVision(heroCrops, aspectRatio, 2);
  for (const { ratio, url } of altHeroPick) {
    if (!images.some(img => img.url === url)) {
      images.push({ role: `hero_${ratioKey(ratio)}`, url, label: `Hero @ ${ratio} (alt crop — slot via product.hero_media.crops.${ratioKey(ratio)})` });
    }
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

  // Return crop maps alongside text + images so aiCanvasSpecService
  // can graft them onto resolvedInput.product.{hero_media,
  // lifestyle_image, product_image}.crops for slot resolution at
  // render time.
  return {
    text,
    images,
    cropMaps: {
      hero:         heroCrops,
      lifestyle:    lifestyleCrops,
      product_only: productOnlyCrops
    }
  };
}

// Walk ctx.crops + ctx.extended to extract the winning crop URL for
// every available ratio (1:1, 4:5, 5:4, 9:16, 1.91:1) for a given
// source — 'hero' reads from ctx.crops (the hero Media's smart crop
// artifact) + ctx.extended (the AI-extended crops). 'lifestyle' /
// 'product_only' return empty for now (catalog-product Media don't
// run the smart-crop pipeline yet); future work can extend.
function buildAllRatioCrops(ctx, source) {
  const out = {};
  if (source !== 'hero') return out;  // lifestyle / product_only still single-ratio

  const { detection, crops, extended } = ctx;
  if (!detection?.imageUrl) return out;

  // Base smart crops (1:1, 4:5, 5:4) — judge winner per ratio.
  for (const ratio of SMART_CROP_RATIOS) {
    const winnerId = crops?.winners?.[ratio];
    const list = crops?.smartCrops?.[ratio] || [];
    const winner = list.find(c => c.id === winnerId) || list[0];
    if (winner) {
      out[ratioKey(ratio)] = buildCloudinaryCropUrl(detection.imageUrl, winner);
    }
  }

  // AI-extended crops (9:16, 1.91:1) — already-baked URLs from the
  // extended-crops pipeline, no Cloudinary transform needed.
  for (const ratio of EXTENDED_CROP_RATIOS) {
    const winnerRef = extended?.selectedWinners?.[ratio]?.candidateId;
    const list = extended?.candidates?.[ratio] || [];
    const winner = list.find(c => c.id === winnerRef)
                || list.find(c => c.provider === 'gemini')
                || list[0];
    if (winner?.imageUrl) out[ratioKey(ratio)] = winner.imageUrl;
  }

  return out;
}

// Vision attachments cost real tokens. Pick at most N alt-ratio
// hero crops, preferring the ones most aspect-different from the
// canvas (a panorama + a portrait give the LLM the widest range).
function pickAltRatiosForVision(cropsMap, canvasRatio, n) {
  const canvasKey = ratioKey(canvasRatio);
  const KEY_TO_RATIO = { '1_1': '1:1', '4_5': '4:5', '5_4': '5:4', '9_16': '9:16', '1_91_1': '1.91:1' };
  const ranked = ['1_91_1', '9_16', '4_5', '5_4', '1_1']
    .filter(k => k !== canvasKey)
    .filter(k => cropsMap[k]);
  return ranked.slice(0, n).map(k => ({ ratio: KEY_TO_RATIO[k], url: cropsMap[k] }));
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

// Build a per-ratio spatial analysis map. OverlayZoneArtifact shape:
//   zones[ratio] is either an array of variant entries (v3) OR a keyed
//   object by variantKey (legacy). Each entry has .analysis containing
//   { densityGrid, brightnessGrid, restrictions, primarySubjectRectPct,
//     imageWidth, imageHeight }. We surface ALL ratios the artifact has
//     data for so the LLM can read the right grid when it slots an alt
//     crop via product.hero_media.crops.<ratio>.
function buildSpatialAnalysisMap(overlayZones, canvasRatio) {
  if (!overlayZones?.zones || typeof overlayZones.zones !== 'object') {
    return { canvas_ratio: canvasRatio, by_ratio: {}, available_ratios: [] };
  }
  const by_ratio = {};
  for (const ratio of Object.keys(overlayZones.zones)) {
    const a = extractAnalysisForRatio(overlayZones.zones[ratio]);
    if (a) by_ratio[ratioKey(ratio)] = a;
  }
  return {
    canvas_ratio: canvasRatio,
    by_ratio,
    available_ratios: Object.keys(by_ratio)
  };
}

// Pick the right variant entry inside zones[ratio] (array v3 or keyed
// object) and project its .analysis into the LLM-friendly shape.
function extractAnalysisForRatio(rawForRatio) {
  if (!rawForRatio) return null;
  let entry = null;
  if (Array.isArray(rawForRatio)) {
    entry = rawForRatio.find(e => e?.analysis && e.variant === 'base')
         || rawForRatio.find(e => e?.analysis)
         || rawForRatio[0];
  } else if (typeof rawForRatio === 'object') {
    entry = Object.values(rawForRatio).find(e => e?.analysis)
         || Object.values(rawForRatio)[0];
  }
  const a = entry?.analysis;
  if (!a) return null;
  return {
    image_size:           { w: a.imageWidth || null, h: a.imageHeight || null },
    density_grid:         compactGrid(a.densityGrid),
    brightness_grid:      compactGrid(a.brightnessGrid),
    keep_out_zones:       (a.restrictions || []).slice(0, 8).map(r => ({
      id:             r.id || null,
      role:           r.role || null,
      classification: r.classification || null,
      strictness:     typeof r.strictness === 'number' ? +r.strictness.toFixed(2) : null,
      rect:           rectPctToCanvas(r.rectPct),
      reason:         typeof r.reason === 'string' ? r.reason.slice(0, 120) : null
    })).filter(z => z.rect),
    primary_subject_rect: rectPctToCanvas(a.primarySubjectRectPct)
  };
}

// {cols, rows, cells: [[0..1]...]} → compact row strings. 1-decimal
// floats keep the token cost low while preserving signal — 8 rows of
// 8 numbers ≈ 250 chars. Each row reads left→right; rows go top→bottom.
function compactGrid(grid) {
  if (!grid || !Array.isArray(grid.cells) || !grid.cells.length) return null;
  return {
    cols: grid.cols || null,
    rows: grid.rows || null,
    rows_top_to_bottom: grid.cells.map(row =>
      Array.isArray(row)
        ? row.map(v => (Number(v) || 0).toFixed(1)).join(' ')
        : ''
    )
  };
}

function rectPctToCanvas(r) {
  if (!r || typeof r !== 'object') return null;
  return bboxPct({ x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2 });
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
