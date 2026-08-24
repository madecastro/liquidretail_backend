// Layout input service. On-demand builder: given (mediaId, template,
// aspectRatio), assembles the canonical RS Social Proof Creative Input JSON
// the renderer consumes. One Gemini structured-output call derives
// subjective fields (quotes, copy, benefits, badges, theme hints, CTA,
// trusted_by_text); everything else is deterministic mapping from detect
// artifacts + Brand catalog + Media metadata.
//
// MEDIA-PAIR CONVENTION (per renderer spec §7.4 — "poster is required for
// every video slot"): whenever we emit a media pair like
// `product.hero_media: { image, video }` or `creator.portrait_media: {...}`,
// the `image` field is the video's poster. The renderer uses it for the
// pre-autoplay still and for video-unsupported placements. We always
// populate both when a video is available — the pairing is guaranteed by
// pickHeroMedia / pickCreatorMedia below.
//
// OUTPUT SHAPE — canonical paths as defined by the normalized template
// schema. Each top-level module:
//
//   template, aspect_ratio
//   theme:          { style, background_style, emphasis }
//   brand:          { name, tagline, logo, primary_color, ...,
//                     font_family, tone[] }
//   product:        { id, name, category, price, currency, description,
//                     short_benefits[], badges[],
//                     hero_media: { image, video },
//                     secondary_media: { image, video } }
//   creator:        { name, handle, platform, avatar,
//                     portrait_media: { image, video } }
//   ugc:            { post_id, platform, post_type, caption,
//                     media: { image, video },
//                     likes, comments, shares, saves,
//                     rights_approved }
//   social_proof:   { rating_value, review_count, trusted_by_text,
//                     proof_badges[],
//                     primary_quote: {...}, secondary_quotes[] }
//   performance:    { engagement: { likes, comments, shares, saves, views },
//                     metrics[] }
//   cta:            { text, url, subtext, offer_text }
//   trust:          { retailer_logos[], trusted_by_text,
//                     certifications[], press_mentions[] }
//   copy:           { headline, subheadline, eyebrow,
//                     highlight_text, disclaimer }
//   layout_options: { show_logo, show_price, show_rating, ... }
//   defaults:       { fallback_quote, fallback_headline, cta_text,
//                     product_name }
//
// Cached by (mediaId, template, aspectRatio) unique-indexed
// LayoutInputArtifact; `refresh: true` bypasses.

const axios = require('axios');
const crypto = require('crypto');
const mongoose = require('mongoose');

const Media                  = require('../models/Media');
const DetectionArtifact      = require('../models/DetectionArtifact');
const CropArtifact           = require('../models/CropArtifact');
const ExtendedCropArtifact   = require('../models/ExtendedCropArtifact');
const ProductMatchArtifact   = require('../models/ProductMatchArtifact');
const OverlayZoneArtifact    = require('../models/OverlayZoneArtifact');
const LayoutInputArtifact    = require('../models/LayoutInputArtifact');
const CatalogProduct         = require('../models/CatalogProduct');
// Brand is resolved by NAME first (findBrandByName); this is for the brandId
// FK fallback in loadContext, which rescues brands whose scraped name carries
// a tagline and therefore never matches nameNormalized.
const Brand                  = require('../models/Brand');
const Category               = require('../models/Category');
const Comment                = require('../models/Comment');
const { findBrandByName }    = require('./brandCatalogService');
const { placeOverlays }      = require('./overlayPlacementService');
const registry               = require('./templateRegistry');
const { hydrateMatch }       = require('./productMatchHydration');
const { resolveDeriveProductPair, classifyProductReviewsProvenance } = require('./ratingPairAtomic');
const { computeSlotBudgets } = require('./slotBudget');
const { displayNormalizeTitle } = require('../utils/titleNormalize');
const { extractSnippet, PROOF_LINE_MAX_CHARS, usableProofCommentsOrNone } = require('./quoteSnippetService');
// Video-headline SELECTION for fallbackDerivation — reuses an EXISTING
// CreativeDirectionArtifact round (never calls the Director LLM) and picks
// the best-fitting copy string instead of a templated headline. See
// services/videoHeadlineService.js for the full design rationale.
const { resolveVideoHeadline } = require('./videoHeadlineService');
// Same evidence thresholds the render-time claim gate uses (see
// buildMetaForAd in brandScriptExecutor.js) — reused here so this
// deterministic default never asserts a claim the gate would strip anyway.
const { RATING_CLAIM_MIN, SAMPLE_FLOOR } = require('./claimSubstantiationService');

// Atlas gateway (Gemini served OpenAI-compatible; Google's OpenAI-compat
// endpoint as the direct fallback inside the transport).
const { chatCompletion, isConfigured: atlasConfigured } = require('./atlasLlmService');

const GEMINI_MODEL = process.env.GEMINI_SEARCH_MODEL || 'gemini-2.5-pro';

// Bump when the canonical input shape changes — cached LayoutInputArtifact
// docs with a mismatching version are treated as cache misses and forced
// to re-derive. 2.1 added the optional `placement` block for overlay-mode
// templates. 2.2 added `placement.decisions[]` — the per-element
// placement trace used by the preview's inspector panel. 2.3 added
// `placement.analysis` (restrictions, grids, primarySubjectRectPct) and
// `placement.usingFallbackImage` for the universal debug overlay. 2.4
// added shape-variant metadata on each placed element (variant, layout,
// maxLines) — the placement algorithm now considers horizontal + stacked
// + narrow-column candidates per element, so rects can land in much
// tighter spaces than before. 2.5 wires the matching-service decision
// tree outcomes into the input: 'category' overrides cta to the brand
// collection page, 'branding' injects brand-reviews quotes + ratings,
// 'do_not_use' hard-stops layout assembly. 2.6 makes the derivation
// prompt + defaults brand-focused when outcome='branding' — headline,
// quotes, cta, and fallback strings shift from product-shaped to
// brand-shaped so a Media without a real product produces brand
// creative, not invented product copy. 2.7 renames outcomes to the
// product_match / product_category / brand_match / do_not_use family
// and surfaces brandCategory (OpenAI category enrichment) on every
// product outcome — cta.subtext carries the breadcrumb so the
// collection is always one click away even when the SKU resolves.
// 2.8 surfaces a video URL on placement.backgroundMedia.video for
// overlay-mode templates when the source Media is a video — the
// preview / renderer uses the video as the hero asset with the
// still image as the pre-autoplay poster.
// 2.9 adds copy.headline_lead + copy.headline_main — the slot-aware
// split fields the derivation prompt now writes against per-slot char
// budgets (slotBudget.js). copy.headline is auto-joined from those
// when present so legacy bindings still resolve. Cached 2.8 docs are
// re-derived so the renderer's split-headline path can light up.
// 3.0 retargets testimonial_spotlight 1:1 + 4:5 to the new
// split-panel design language (display_script headline, eyebrow_rules,
// with_verified_buyers proof_bar, with_author_photo quote_card,
// callouts badge_row) and switches the hero source to the 4:5 crop
// for ALL testimonial_spotlight variants. Cached 2.9 docs need to
// re-derive so the prompt's slot budgets reflect the new geometry.
// 3.1 tightens palette_vibrant: returns null when the palette is
// monochromatic (most-saturated entry below VIBRANT_MIN_SATURATION),
// instead of falling back to a near-dominant palette entry. Lets
// the headline binding default cleanly to white for grayscale-ish
// images. Cached 3.0 docs re-derive so a stored
// palette_vibrant=#454545 (grey) gets nulled out.
// 3.2 adds a WCAG contrast guard on top of the saturation threshold.
// Catches "all-blues" palettes where the most-saturated entry passes
// the saturation gate but still blends with palette_dominant (panel
// bg) because they share a hue family. Headlines fall through to
// white when contrast against the dominant is below 4.0.
// 3.3 retargets ugc_split_screen to the testimonial_spotlight design
// language: image-led split panel + display_script headline +
// eyebrow_rules + with_verified_buyers proof_bar + section_header +
// product_meta + callouts badge_row + cta. testimonial_spotlight no
// longer has section_header / product_meta. Hero source crop now
// 4:5 for both templates (was just testimonial_spotlight). Cached
// docs re-derive against the new validation + slot bindings.
// 3.4 dials VIBRANT_MIN_SATURATION 0.30 → 0.40 so more borderline
// palettes (tan/beige product photography, low-saturation lifestyle
// shots) fall through to the white-headline default.
// 3.5 dials thresholds way up: saturation 0.40 → 0.80, contrast 4.0
// → 8.0 (AAA territory). Tightens cta_button_bg chain for
// testimonial_spotlight + ugc_split_screen to drop palette_accent —
// it's dominance-ranked palette[1] and can be a near-white off-tone
// that washes out the white CTA text.
// 3.6 drops the 4:5 hero-source override on testimonial_spotlight +
// ugc_split_screen — pickHeroMedia now uses the canvas ratio's own
// crop (with the existing closest-match fallback for 16:9). Cached
// 3.5 docs re-derive so support_media URLs swap to the per-ratio
// crop winner.
// 3.7 picks the hero source by MEDIA SLOT ratio, not canvas ratio.
// For split-panel layouts the slot is half-canvas (1:1 canvas →
// 1:2 slot) so the canvas-matched crop forces a heavy second crop.
// pickHeroSourceRatio finds the closest of {5:4, 1:1, 4:5, 9:16,
// 1.91:1} to the slot's actual w/h. Net effect: 1:1 → 9:16 source,
// 4:5 → 1.91:1, 9:16 → 1:1, 16:9 + 1.91:1 → 4:5.
// 3.8 branches testimonial_overlay → testimonial_overlay (slim:
// logo + headline + quote + cta) + new product_overlay (logo +
// headline + product_meta + cta). product_overlay added to
// OVERLAY_MODE_TEMPLATES. Both have white-default headline,
// brand font_family_headline, dark-gray chip bg behind headline +
// quote text.
// 3.9 fixes the placement engine ignoring the normalized template's
// element_priority_order — placeOverlays now accepts an elementIds
// filter, threaded through from layoutInputService. Without this
// the hardcoded element specs in overlayPlacementService place
// EVERY element regardless of template (testimonial_overlay was
// still placing product_meta).
// 4.0 rewrites overlay placement to a 4-box anchored algorithm
// (logo TL, cta BR, headline upper-half least-violating, quote /
// product_meta lower-half least-violating). Inset fallback + shape
// variant cascade + priority cascade are gone. Placement now runs
// BEFORE derivation so the chosen box dimensions can constrain
// Gemini's headline + cta + quote copy length via a new
// overlayBoxes prompt section. Cached docs re-derive against the
// new placement + budgets.
// One definition of printable provenance, shared with every renderer.
const {
  toPrintableCustomerQuote,
  ANONYMOUS_PRINT_ORIGINS,
  selectBrandQuotesForScope
} = require('./quoteProvenance');
const { usableColourwayQuote } = require('./quoteColourway');

// 4.2 (2026-08-24, OWNER-DIRECTED): forces every cached LayoutInputArtifact to
// re-derive so PR #312's provenance fix actually reaches existing products.
//
// #312 fixed stampQuoteOrigins reading container.source instead of
// container.quotesOrigin, which had made 20934 first-party reviews across 937
// products unprintable. But assembleInput is CACHED on this constant, and every
// production artifact was already 4.1 holding a brand-tier quote with an empty
// product pool — so the fix was live in code and inert in effect. A render-time
// re-pick cannot repair it: the stored pool itself is empty, and there is
// nothing to re-pick from.
//
// COST, stated because this is a spend decision and not a free one: each
// artifact re-derives lazily on next use, and runDerivation calls
// chatCompletion (:892). So this is one paid LLM call per (media, template,
// aspect, product) key as it is next touched — amortised over normal use rather
// than a bulk charge, and it does NOT re-bill any image or video generation.
//
// 4.1: quote provenance (origin + tier) stamped on primary_quote; LLM tiers removed
const INPUT_SCHEMA_VERSION = '4.2';

// productReviews storage went 10 → 30 so rotation has a deeper pool.
// The cached LayoutInputArtifact must NOT inherit that 3× dump:
// secondary_quotes is written onto every artifact and is the render-time
// rotation pool. Cap it (same-tier first) so the document stays bounded.
// Director already slices to MAX_QUOTES_PER_TIER=4; this is the artifact
// bound, not a Director-prompt change.
const MAX_LAYOUT_SECONDARY_QUOTES = 16;

// QUOTE_STAGE_AWARE (default false). When on, Ad.funnelStage + concept
// angle reach pickStrongestQuote via the already-built STAGE_TERMS
// scorer. The printed quote is re-picked at RENDER / TITLING time from
// the artifact's stored pool (primary_quote + secondary_quotes) — NOT
// by partitioning LayoutInputArtifact.campaignContextHash.
//
// WHY NO CACHE-KEY PARTITION. The ads that actually carry Ad.funnelStage
// (PMax funnel retitles) never call buildLayoutInput. Titling loads
// {mediaId, productId} newest. A hash no paid reader honours is worse
// than no hash: logs would claim funnel=awareness while pixels stayed
// the unstaged winner. Freshness is stage-aware via applyStagedQuotePick,
// so we do NOT bump INPUT_SCHEMA_VERSION (a global bump would rebuild
// every artifact while the flag is off and the pick is unchanged).
// Flag-off is byte-identical: quoteOpts stay empty and the cache key
// is HEAD-identical (product → null; brand/promo → kind/promo/raffle).
function quoteStageAwareEnabled() {
  return String(process.env.QUOTE_STAGE_AWARE || 'false').toLowerCase() === 'true';
}

// Templates that render via the overlay-on-image placement algorithm
// instead of the canonical canvas-zone composition.
const OVERLAY_MODE_TEMPLATES = new Set(['testimonial_overlay', 'product_overlay']);

// Until webhook ingestion lands, every detect-uploaded Media is treated as
// Instagram creator UGC — the uploader is standing in for a creator's post.
const DEFAULT_CREATOR_PLATFORM = 'instagram';
const DEFAULT_POST_TYPE        = 'ugc';

const DERIVATION_SCHEMA = {
  type: 'object',
  properties: {
    quotes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text:         { type: 'string' },
          author_name:  { type: 'string' },
          author_title: { type: 'string' },
          source:       { type: 'string', enum: ['review', 'ugc', 'creator', 'survey', 'testimonial'] },
          verified:     { type: 'boolean' },
          stars:        { type: 'number' }
        },
        required: ['text', 'source']
      }
    },
    short_benefits:   { type: 'array', items: { type: 'string' } },
    badges:           { type: 'array', items: { type: 'string' } },
    copy: {
      type: 'object',
      properties: {
        // headline_lead + headline_main render as a stacked
        // display-script split (small lead phrase over a larger main
        // phrase). When the prompt provides per-slot char budgets, the
        // LLM writes these directly — the prompt accounts for the
        // half-size lead so the chars cap on each piece is honored.
        // headline (legacy combined string) is kept for templates that
        // don't use the split; assembleInput joins lead+main into it
        // when both are present so existing zones still resolve.
        headline:       { type: 'string' },
        headline_lead:  { type: 'string' },
        headline_main:  { type: 'string' },
        subheadline:    { type: 'string' },
        eyebrow:        { type: 'string' },
        highlight_text: { type: 'string' }
      }
    },
    cta: {
      type: 'object',
      properties: {
        text:       { type: 'string' },
        subtext:    { type: 'string' },
        offer_text: { type: 'string' }
      },
      required: ['text']
    },
    trusted_by_text:  { type: 'string' },
    tone:             { type: 'array', items: { type: 'string' } },
    theme_style:      { type: 'string', enum: ['clean', 'modern', 'editorial', 'bold', 'playful', 'luxury'] },
    background_style: { type: 'string', enum: ['solid', 'gradient', 'soft-blur', 'card-stack', 'minimal'] },
    emphasis:         { type: 'string', enum: ['product-first', 'quote-first', 'ugc-first', 'metrics-first'] }
  },
  required: ['cta', 'copy', 'theme_style', 'emphasis']
};

// ──────────────────────────────────────────────────────────────
//  Public entry point
// ──────────────────────────────────────────────────────────────
async function buildLayoutInput({ mediaId, template, aspectRatio, options = {}, refresh = false }) {
  if (!registry.getNormalized(template)) throw badRequest(`Unknown template: ${template}`);
  const supportedRatios = registry.getSupportedAspectRatios(template);
  if (!supportedRatios.includes(aspectRatio))
    throw badRequest(`Template ${template} does not support aspect ratio ${aspectRatio}`);

  // AI templates ride on top of a hand-authored base for derivation +
  // assembly — the input shape is template-independent for our
  // purposes (copy candidates, palette, slot data). Cache under the
  // AI template id so re-renders stay isolated from the base, but
  // derive + assemble against the base so we reuse all the existing
  // slot-budget / overlay-placement / copy machinery.
  let effectiveTemplate     = template;
  const aiNormalized        = registry.isAi(template) ? registry.getNormalized(template) : null;
  if (aiNormalized) {
    effectiveTemplate = aiNormalized.derivationTemplate || 'ugc_split_screen';
  }

  // Cache key includes productId + variantKind so different seed
  // products on the same media don't share a cached input. Both
  // default to null for legacy callers (ads.html preview) — those
  // cluster under (null, null) and don't conflict with ad-render
  // entries that always have both set.
  // campaignContextHash partitions further so a kind='brand' /
  // kind='promotional' campaign gets a separate cache entry from a
  // kind='product' campaign on the same (mediaId, template, ratio,
  // productId, variantKind). Edits to promotionalDetails change the
  // hash, forcing a re-derivation.
  //
  // Funnel stage is NOT a cache-key dimension. Staged quote selection
  // happens at render/titling via applyStagedQuotePick against the
  // stored pool. See the QUOTE_STAGE_AWARE comment on INPUT_SCHEMA_VERSION.
  const cacheKeyProductId     = options.productId   || null;
  const cacheKeyVariantKind   = options.variantKind || null;
  const cacheKeyPaletteSource = options.paletteSource || 'media';
  const campaignContextHash   = computeCampaignContextHash(options);
  if (!refresh) {
    const cached = await LayoutInputArtifact.findOne({
      mediaId, template, aspectRatio,
      productId:     cacheKeyProductId,
      variantKind:   cacheKeyVariantKind,
      campaignContextHash,
      paletteSource: cacheKeyPaletteSource
    }).lean();
    // Cache hit only if the stored schema version matches what we emit today.
    // Without this check, v1 cached docs (with old paths like hero_image_url)
    // get served even though the renderer now reads hero_media.image —
    // resulting in blank zones across the preview until an explicit refresh.
    if (cached && cached.schemaVersion === INPUT_SCHEMA_VERSION) return cached.input;
  }

  const ctx = await loadContext(mediaId, options);
  if (!ctx) throw notFound(`Media ${mediaId} not found`);

  // Hard-stop: matching service flagged this Media as 'do_not_use'
  // (typically multi-brand contention). Templates can't safely render
  // ad creative for it; surface a clear error rather than producing
  // ambiguous output.
  if (ctx.match?.outcome === 'do_not_use') {
    throw badRequest(`Media flagged as do_not_use by product matching: ${ctx.match.outcomeReasoning || 'multiple brands detected'}`);
  }

  // For overlay-mode templates, run placement BEFORE derivation so the
  // chosen box dimensions can constrain the LLM's headline + cta copy
  // length. Canvas-zone templates run derivation first as before
  // (their slot budgets come from canvas.zones, not placement).
  let precomputedPlacement = null;
  let overlayBoxes = null;
  if (OVERLAY_MODE_TEMPLATES.has(effectiveTemplate)) {
    try {
      precomputedPlacement = computeOverlayPlacement(ctx, aspectRatio, options, /* content */ ctx, effectiveTemplate);
      overlayBoxes = extractOverlayBoxes(precomputedPlacement, aspectRatio);
    } catch (err) {
      console.warn(`   ⚠️  overlay placement (pre-derivation) failed for ${effectiveTemplate} ${aspectRatio}: ${err.message}`);
    }
  }

  const derivation = await runDerivation(ctx, effectiveTemplate, aspectRatio, { ...options, overlayBoxes });
  const input = await assembleInput(ctx, effectiveTemplate, aspectRatio, options, derivation, precomputedPlacement);

  await LayoutInputArtifact.findOneAndReplace(
    {
      mediaId, template, aspectRatio,
      productId:     cacheKeyProductId,
      variantKind:   cacheKeyVariantKind,
      campaignContextHash,
      paletteSource: cacheKeyPaletteSource
    },
    {
      // Tenant scope — required for the /by-id/:id endpoint's
      // tenantFilter to match. Without these, every artifact is
      // written with advertiserId/brandId=null and the by-id lookup
      // 404s (the Puppeteer page that fetches by FK ends up rendering
      // the "artifact not found" stub instead of the canvas).
      advertiserId:  ctx.media?.advertiserId || null,
      brandId:       ctx.media?.brandId      || null,
      mediaId,
      runId: ctx.runId || null,
      template,
      aspectRatio,
      productId:     cacheKeyProductId,
      variantKind:   cacheKeyVariantKind,
      campaignContextHash,
      paletteSource: cacheKeyPaletteSource,
      schemaVersion: INPUT_SCHEMA_VERSION,
      input,
      derivation,
      createdAt: new Date()
    },
    { upsert: true }
  );

  return input;
}

// Hash of campaign-intent inputs that affect derivation. Returns null
// when no campaign-intent overrides are active (kind='product'/null,
// or no promotionalDetails on a brand campaign) so product-mode and
// legacy entries cluster under a single cache slot. Non-null hash for
// kind='brand'/'promotional' captures every input that changes the
// derived headline copy — so an operator editing the offer's end date
// or discount % invalidates the cached derivation cleanly.
function computeCampaignContextHash(options) {
  const kind = options?.campaignKind || null;
  // 'product' is the no-special-handling default; treat as null for
  // cache compatibility with legacy rows.
  if (!kind || kind === 'product' || kind === 'collection') return null;
  const payload = JSON.stringify({
    kind,
    promo: options.promotionalDetails || null,
    // Per-ad prize media partitions the cache so each raffle ad
    // variant gets its own LayoutInputArtifact. Without this, all
    // N raffle variants would resolve to the same cached input and
    // render identically (defeating Option B).
    rafflePrizeMediaId: options.rafflePrizeMediaId || null
  });
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

// ──────────────────────────────────────────────────────────────
//  Preflight — "which templates does this Media's data support?"
//  Runs the assembler with a cheap stub derivation (no LLM) so the
//  validator can be exercised against every template for free. Used by the
//  /candidates endpoint to power template pickers in the UI.
// ──────────────────────────────────────────────────────────────
async function getCandidatesForMedia(mediaId, aspectRatio) {
  const ctx = await loadContext(mediaId);
  if (!ctx) throw notFound(`Media ${mediaId} not found`);

  const stubDerivation = stubDerivationFromCtx(ctx);
  const results = [];
  for (const tmpl of registry.NORMALIZED.templates) {
    if (!tmpl.aspect_ratios?.supported?.includes(aspectRatio)) {
      results.push({ template_id: tmpl.template_id, ok: false, reason: `ratio ${aspectRatio} not supported by this template` });
      continue;
    }
    // Per-template try/catch so one bad assembly (e.g. a new template
    // missing a derivation field) doesn't 500 the whole candidates list.
    try {
      const input = await assembleInput(ctx, tmpl.template_id, aspectRatio, {}, stubDerivation);
      results.push(registry.validateInputAgainstTemplate(input, tmpl.template_id));
    } catch (err) {
      console.warn(`   ⚠️  candidate preflight failed for ${tmpl.template_id}: ${err.message}`);
      results.push({ template_id: tmpl.template_id, ok: false, reason: `preflight error: ${err.message}` });
    }
  }
  return results;
}

function stubDerivationFromCtx(ctx) {
  const details = ctx.match?.identification?.details || {};
  const hasReviewSummary = !!details.reviewSummary?.summary;
  const productName = ctx.match?.identification?.productName;
  return {
    quotes: hasReviewSummary ? [{ text: 'customer quote', source: 'review' }] : [],
    short_benefits: hasReviewSummary ? ['benefit'] : [],
    badges: typeof details.rating === 'number' && details.rating >= 4.5 ? ['top rated'] : [],
    copy: {
      headline:       productName ? `About ${productName}` : 'Social proof',
      subheadline:    '',
      eyebrow:        ctx.match?.identification?.brand || '',
      highlight_text: ''
    },
    cta: { text: 'Shop now' },
    trusted_by_text:  typeof details.reviewCount === 'number' && details.reviewCount >= 50 ? `Trusted by ${details.reviewCount}+ customers` : '',
    tone:             [],
    theme_style:      'clean',
    background_style: 'soft-blur',
    emphasis:         'product-first'
  };
}

// ──────────────────────────────────────────────────────────────
//  Context loader
// ──────────────────────────────────────────────────────────────
async function loadContext(mediaId, options = {}) {
  const media = await Media.findById(mediaId).lean();
  if (!media) return null;

  const [detection, crops, extended, rawMatch, overlayZones] = await Promise.all([
    media.latestArtifacts?.detection    ? DetectionArtifact.findById(media.latestArtifacts.detection).lean()    : null,
    media.latestArtifacts?.crops        ? CropArtifact.findById(media.latestArtifacts.crops).lean()              : null,
    media.latestArtifacts?.extended     ? ExtendedCropArtifact.findById(media.latestArtifacts.extended).lean()   : null,
    media.latestArtifacts?.match        ? ProductMatchArtifact.findById(media.latestArtifacts.match).lean()      : null,
    media.latestArtifacts?.overlayZones ? OverlayZoneArtifact.findById(media.latestArtifacts.overlayZones).lean(): null
  ]);
  // Phase 2g — hydrate the artifact from canonical FK targets so consumers
  // read CatalogProduct / Category / Brand state instead of stale snapshots.
  // hydrateMatch is a no-op when match is null and falls back to snapshot
  // fields when an FK target is missing (legacy pre-Phase-2 artifacts).
  let match = await hydrateMatch(rawMatch);

  // options.productId is the operator's seed pick from the wizard.
  // It's authoritative for the product slots — the latest PMA on
  // this Media might point at a DIFFERENT product (when the media
  // matched several), so we use the seed product instead. Two paths:
  //
  //   no match (catalog-product Media)
  //     → synthesize a full stub-match from the CatalogProduct so
  //       the existing slot-assembly code reads details.* normally
  //   match exists (UGC Media with PMA)
  //     → override match.identification with seed-product details;
  //       keep categoryId / brandReviews / recommendedProducts as-is
  //       (those are scene-context, not product-identity)
  let productHero = null;
  if (options.productId) {
    const cp = await CatalogProduct.findById(options.productId).lean();
    if (cp) {
      if (!match) {
        match = synthesizeMatchFromCatalogProduct(cp);
      } else {
        const seedIdent = buildIdentificationFromCatalogProduct(cp);
        match = {
          ...match,
          catalogProductId: cp._id,
          identification:   seedIdent,
          // The spread carries the PMA's own top-level productReviews, which
          // belong to whatever product the media originally matched — NOT the
          // seed pick. Overwrite it, or productReviewsOf() below can fall back
          // to another product's reviews the moment this one has none.
          productReviews:   cp.productReviews || null
        };
      }
    }
    // Also load the catalog product's hero Media + its CropArtifact so
    // assembleInput can serve cropped catalog imagery for product.image
    // (and any slot that wants a tight product thumbnail) instead of the
    // raw uncropped Shopify URL. Per-ratio judge winners are picked the
    // same way as the main hero — slot consumers get a c_crop transform
    // URL keyed to the slot's ratio.
    //
    // Two slot consumers, two preferences:
    //   - productHero.crops      → product.hero_media / hero of the ad
    //                              wants lifestyle / on_model / flat_lay
    //                              (the wizard's product_image seed
    //                              already pointed mediaId at this one)
    //   - productInset.crops     → product.image inset / product_meta
    //                              wants product_only / packaging — a
    //                              clean isolated shot for the small
    //                              callout. Resolved here by scanning
    //                              alt Media for the product.
    // metadata.catalogProductId stored as ObjectId; cast string forms
    // so api → service hops don't lose the match.
    const productOid = mongoose.isValidObjectId(options.productId)
      ? new mongoose.Types.ObjectId(String(options.productId))
      : options.productId;
    const catalogMediaDocs = productOid ? await Media.find({
      source: 'catalog-product',
      'metadata.catalogProductId': productOid
    })
      .select('_id fileUrl latestArtifacts classification metadata.imageRole')
      .lean() : [];

    // Hero pick — prefer the Media the seed pointed at (loadContext's
    // first arg mediaId); fall back to imageRole='hero' for legacy ads
    // queued before shotType ranking landed.
    const seedMediaId = mediaId ? String(mediaId) : null;
    let heroMediaDoc = seedMediaId
      ? catalogMediaDocs.find(m => String(m._id) === seedMediaId)
      : null;
    if (!heroMediaDoc) {
      heroMediaDoc = catalogMediaDocs.find(m => m.metadata?.imageRole === 'hero') || catalogMediaDocs[0] || null;
    }

    if (heroMediaDoc) {
      // Pull the FULL detection (imageUrl + background) — palette /
      // setting / lighting / style come from the catalog hero's own
      // detection when this image becomes the ad's visual source
      // (variantKind='product_image'). Without it, assembleInput
      // would fall back to the UGC post's background — which is
      // what produced the wrong-color (green jar) bug on catalog-
      // hero variants.
      const heroDetection = heroMediaDoc.latestArtifacts?.detection
        ? await DetectionArtifact.findById(heroMediaDoc.latestArtifacts.detection).select('imageUrl background').lean()
        : null;
      const heroCrops = heroMediaDoc.latestArtifacts?.crops
        ? await CropArtifact.findById(heroMediaDoc.latestArtifacts.crops).lean()
        : null;
      productHero = {
        mediaId:    heroMediaDoc._id,
        imageUrl:   heroDetection?.imageUrl || heroMediaDoc.fileUrl || null,
        crops:      heroCrops || null,
        // Catalog-hero scene context — palette + background descriptors.
        // Consumed by assembleInput only when isProductImage; UGC
        // variants continue to read from the post's own detection.
        palette:    heroDetection?.background?.palette || null,
        background: heroDetection?.background || null
      };
    } else if (productOid) {
      // Detect-identified products often have a CatalogProduct row with
      // imageUrl set but no wrapper Media doc (the Shopify-sync path
      // materializes one via catalogProductDetectService.enqueueProductDetect,
      // but productMatchService.ensureCatalogProduct doesn't enqueue
      // detect for the new row). Without this fallback the canonical
      // input emits null for product.hero_media / product_image /
      // lifestyle_image and ad rendering loses its product imagery.
      //
      // Synthesize a minimal productHero from CatalogProduct.imageUrl
      // so slot bindings resolve. No crops or detection background
      // available here — the eager enqueueProductDetect call shipped
      // alongside this band-aid backfills both on the next render.
      const cpForFallback = await CatalogProduct
        .findById(productOid)
        .select('imageUrl')
        .lean();
      if (cpForFallback?.imageUrl) {
        productHero = {
          mediaId:    null,
          imageUrl:   cpForFallback.imageUrl,
          crops:      null,
          palette:    null,
          background: null
        };
      }
    }

    // Track both shot flavors independently so the canonical input can
    // surface them at fixed paths (product.lifestyle_image,
    // product.product_image). Templates that want a clean studio shot
    // for the small product callout AND a lifestyle thumbnail
    // elsewhere can bind both. The seed's mediaId already determined
    // the AD hero (above); these two are reference paths that get
    // populated independently.
    const lifestyleCandidates = catalogMediaDocs
      .filter(m => ['lifestyle', 'on_model', 'flat_lay'].includes(m.classification?.shotType));
    const productOnlyCandidates = catalogMediaDocs
      .filter(m => ['product_only', 'packaging', 'detail'].includes(m.classification?.shotType));

    // Per-flavor pick: highest-confidence within the flavor, then
    // prefer the merchant's primary (imageRole=hero) as a tiebreak.
    function pickByConfidence(arr) {
      if (!arr.length) return null;
      const sorted = arr.slice().sort((a, b) => {
        const ca = a.classification?.shotTypeConfidence ?? 0;
        const cb = b.classification?.shotTypeConfidence ?? 0;
        if (cb !== ca) return cb - ca;
        const aHero = (a.metadata?.imageRole === 'hero') ? 0 : 1;
        const bHero = (b.metadata?.imageRole === 'hero') ? 0 : 1;
        return aHero - bHero;
      });
      return sorted[0];
    }
    const lifestyleMediaDoc = pickByConfidence(lifestyleCandidates);
    const productOnlyMediaDoc = pickByConfidence(productOnlyCandidates);

    // Hydrate crops + detection imageUrl for each flavor (cheap parallel).
    async function hydrate(doc) {
      if (!doc) return null;
      const [det, crops] = await Promise.all([
        doc.latestArtifacts?.detection
          ? DetectionArtifact.findById(doc.latestArtifacts.detection).select('imageUrl').lean()
          : Promise.resolve(null),
        doc.latestArtifacts?.crops
          ? CropArtifact.findById(doc.latestArtifacts.crops).lean()
          : Promise.resolve(null)
      ]);
      return {
        mediaId:  doc._id,
        imageUrl: det?.imageUrl || doc.fileUrl || null,
        crops:    crops || null
      };
    }
    const lifestyleHydrated   = await hydrate(lifestyleMediaDoc);
    const productOnlyHydrated = await hydrate(productOnlyMediaDoc);

    if (productHero) {
      productHero.lifestyle   = lifestyleHydrated;     // best lifestyle/on_model/flat_lay
      productHero.productOnly = productOnlyHydrated;   // best product_only/packaging/detail
      // Legacy alias (used by existing pickProductImage path) — point
      // at productOnly when available so the inset slot already in use
      // gets the clean shot; falls back to hero's own crop in
      // pickProductImage when both are null.
      if (productOnlyHydrated) {
        productHero.insetMediaId  = productOnlyHydrated.mediaId;
        productHero.insetImageUrl = productOnlyHydrated.imageUrl;
        productHero.insetCrops    = productOnlyHydrated.crops;
      }
    }
  }
  const runId = detection?.runId || null;
  const brandName = match?.identification?.brand || media.metadata?.brand || null;
  let brand = brandName
    ? await findBrandByName(brandName).then(b => b?.toObject?.() || b).catch(() => null)
    : null;
  // FK FALLBACK — deliberately only when the NAME lookup failed, so every
  // resolution that works today is byte-identical.
  //
  // The name on a Media/CatalogProduct is scraped page text and is often not
  // the brand's name at all. Measured in production: GymShark's catalog media
  // carries `metadata.brand = "Gymshark | Be a visionary."` (name + site
  // tagline), which normalizeBrandName turns into "gymshark be a visionary" —
  // it can never match the real doc's "gymshark". So findBrandByName returned
  // null, ctx.brand was null, and EVERY brand-sourced field silently vanished:
  // brandReviews (so the brand-tier quote fallback had an empty pool and could
  // never fire), styleTheme, logo, tagline.
  // media.brandId / match.brandId is the authoritative FK and was correct all
  // along. Not fixing the scraped name here on purpose — that is ingestion,
  // owned elsewhere; this is the lookup being resilient to it.
  if (!brand) {
    const brandFk = media.brandId || match?.brandId || null;
    if (brandFk) {
      brand = await Brand.findById(brandFk).lean().catch(() => null);
      if (brand) {
        console.log(
          `🔗 layoutInput: brand name lookup failed for ${JSON.stringify(brandName)} — ` +
          `resolved via brandId FK to "${brand.name}" (scraped name is not the brand name)`
        );
      }
    }
  }

  // Category-pool resolution. When the match resolves to a Category
  // (either via the linked CatalogProduct.categoryRef or via the
  // ProductMatchArtifact.categoryId stamped on product_category
  // outcomes), pull sibling SKUs in the same category so templates and
  // downstream consumers can fall back from "we don't have this exact
  // SKU" to "here are products in this category". Capped at 12 so the
  // canonical input doesn't bloat.
  const categoryRefForPool = match?.identification?.details?.categoryRef || match?.categoryId || null;
  const categoryPool = categoryRefForPool && match?.brandId
    ? await CatalogProduct.find({
        brandId:          match.brandId,
        categoryRef:      categoryRefForPool,
        draft:            { $ne: true },
        isPrimaryVariant: { $ne: false },
        ...(match.catalogProductId ? { _id: { $ne: match.catalogProductId } } : {})
      })
        .select('title imageUrl productUrl price currency category')
        .limit(12)
        .lean()
        .catch(err => { console.warn(`   ⚠️  categoryPool fetch failed: ${err.message}`); return []; })
    : [];

  // Raffle context — when the campaign is a raffle (campaignKind=
  // 'promotional' + promotionalDetails.discountType='raffle'), the
  // prize Media is the visual hero of every ad. Loaded here so
  // assembleInput can override the default pickHeroMedia path and
  // compute per-product entry counts based on the conversion rate.
  //
  // Per-ad prize: when the campaign has MULTIPLE prize media, each
  // queued Ad carries its own rafflePrizeMediaId stamping which prize
  // to render. expandWizardJob multiplies the cartesian by N prize
  // media so the operator gets N visual takes per (template × ratio
  // × paletteSource) cell. Falls back to the campaign's first prize
  // media when options.rafflePrizeMediaId is absent (non-render paths
  // like operator-driven preview that don't know about per-ad prize).
  let raffle = null;
  const promo = options.promotionalDetails || null;
  const prizeMediaIdForThisAd = options.rafflePrizeMediaId
    || (Array.isArray(promo?.rafflePrizeMediaIds) && promo.rafflePrizeMediaIds[0])
    || promo?.rafflePrizeMediaId   // legacy singular field — fallback for pre-migration docs
    || null;
  if (options.campaignKind === 'promotional' && promo?.discountType === 'raffle' && prizeMediaIdForThisAd) {
    const prizeMedia = await Media.findById(prizeMediaIdForThisAd).lean();
    if (prizeMedia) {
      const [prizeCrops, prizeDetection] = await Promise.all([
        prizeMedia.latestArtifacts?.crops
          ? CropArtifact.findById(prizeMedia.latestArtifacts.crops).lean()
          : null,
        prizeMedia.latestArtifacts?.detection
          ? DetectionArtifact.findById(prizeMedia.latestArtifacts.detection).select('imageUrl background').lean()
          : null
      ]);
      raffle = {
        prizeMedia,
        prizeCrops,
        prizeDetection,
        entriesPerDollar: Number(promo.raffleEntriesPerDollar) || 0,
        prizeDescription: promo.rafflePrize || null,
        drawDate:         promo.raffleDrawDate || promo.endsAt || null
      };
    } else {
      console.warn(`   ⚠️  raffle prize Media ${prizeMediaIdForThisAd} not found — falling back to default hero`);
    }
  }

  // Top social comments — surfaced on the canonical input as
  // ugc.top_comments[] so the new comment_card zone kind can render
  // IG-style / TikTok-style social proof distinct from review quotes.
  // Empty array when no Comment docs exist (the Comment collection is
  // populated by mediaInsightsService.fetchCommentsForMedia at sync
  // time; pre-population brands just render with an empty list and the
  // zone stays hidden). Top-3 by likeCount keeps the canonical input
  // bounded and gives the renderer a small carousel to choose from.
  // Over-fetched, then narrowed by the judge downstream. Taking the top 3 by
  // likes FIRST and screening after would return nothing whenever a post's
  // three most-liked comments are noise — which on a popular post they usually
  // are ("🔥🔥", "need this") — while genuinely usable praise sat at #4.
  const topComments = await Comment.find({ mediaId: media._id, parentExternalId: null })
    .sort({ likeCount: -1, postedAt: -1 })
    .limit(25)
    .lean()
    .catch(err => { console.warn(`   ⚠️  top comments fetch failed: ${err.message}`); return []; });

  return { media, detection, crops, extended, match, overlayZones, brand, runId, categoryPool, productHero, raffle, topComments };
}

// Identification block built from a CatalogProduct. Mirrors the
// shape hydrateMatch produces for a matched PMA so downstream slot
// assembly reads details.* the same way for both paths.
function buildIdentificationFromCatalogProduct(cp) {
  return {
    productName: cp.title || null,
    brand:       cp.brand || null,
    certainty:   1.0,
    details: {
      productId:     cp._id,
      title:         cp.title       || null,
      imageUrl:      cp.imageUrl    || null,
      productUrl:    cp.productUrl  || null,
      category:      cp.category    || null,
      categoryRef:   cp.categoryRef || null,
      price: cp.price != null ? {
        value:    cp.price,
        currency: cp.currency,
        display:  cp.priceDisplay || (typeof cp.price === 'number' ? `$${cp.price.toFixed(2)}` : String(cp.price))
      } : null,
      rating:        cp.rating        ?? null,
      reviewCount:   cp.reviewCount   ?? null,
      reviewSummary: cp.reviewSummary || null,
      productReviews: cp.productReviews || null,
      description:   cp.description   || null
    }
  };
}

// Build a stub ProductMatchArtifact-shaped object from a CatalogProduct.
// Used in the product_image variant path where the source Media is a
// catalog product image (no PMA).
function synthesizeMatchFromCatalogProduct(cp) {
  if (!cp) return null;
  return {
    outcome:          'product_match',
    winner:           'catalog',
    catalogProductId: cp._id,
    categoryId:       cp.categoryRef || null,
    brandId:          cp.brandId || null,
    identification:   buildIdentificationFromCatalogProduct(cp)
  };
}

// The matched product's review snapshot, wherever it actually lives.
//
// hydrateMatch writes CatalogProduct.productReviews to the TOP LEVEL of the
// artifact (productMatchHydration.js:66) and never into identification.details
// — the same shape gap that hides catalogProductId (see :1779). Reading only
// details.productReviews therefore left the product quote tier structurally
// EMPTY on every hydrated match: the 3-tier review engine's SKU-specific,
// star-rated quotes never reached an ad, and every testimonial fell through to
// the category / brand / comment tiers instead.
//
// details wins when present because it is the operator's seed pick (:470),
// which is authoritative for the product being advertised.
// A truthy-but-quoteless snapshot must not mask a populated one, so the
// fallthrough tests for quotes rather than existence. That cannot cross
// products: details.productReviews is only ever written by
// buildIdentificationFromCatalogProduct, and both of its callers
// (the seed branch at :471 and synthesizeMatchFromCatalogProduct) set the
// top-level field from the SAME CatalogProduct — so where both exist they
// describe the same product.
function productReviewsOf(match) {
  const seeded   = match?.identification?.details?.productReviews || null;
  const hydrated = match?.productReviews || null;
  if (seeded?.quotes?.length)   return seeded;
  if (hydrated?.quotes?.length) return hydrated;
  return seeded || hydrated || null;
}

// ──────────────────────────────────────────────────────────────
//  Derivation LLM
// ──────────────────────────────────────────────────────────────
async function runDerivation(ctx, template, aspectRatio, options) {
  if (!atlasConfigured() && !process.env.GEMINI_API_KEY) return fallbackDerivation(ctx, aspectRatio, options);

  const prompt = buildDerivationPrompt(ctx, template, aspectRatio, options);

  try {
    // DERIVATION_SCHEMA has genuinely optional fields, so it rides as
    // non-strict json_schema guidance (strict mode requires all-required).
    // Hidden reasoning spends from max_tokens on the OpenAI-compat path
    // (no thinkingBudget knob) — the transport pads a reserve on top.
    const res = await chatCompletion(
      { stage: 'layout_derivation', service: 'layoutInputService' },
      {
        model: GEMINI_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 3000,
        response_format: { type: 'json_schema', json_schema: { name: 'layout_derivation', strict: false, schema: DERIVATION_SCHEMA } }
      }
    );
    const text = res.choices?.[0]?.message?.content;
    if (!text) {
      console.warn(`   ⚠️  layout-derivation: empty response (finishReason=${res.choices?.[0]?.finish_reason})`);
      return fallbackDerivation(ctx, aspectRatio, options);
    }
    return JSON.parse(text);
  } catch (err) {
    console.warn(`   ⚠️  layout-derivation failed: ${err.response?.data?.error?.message || err.message}`);
    return fallbackDerivation(ctx, aspectRatio, options);
  }
}

/**
 * One line of quote text for the derivation / tone prompt.
 *
 * The quote TEXT is the tonal signal. The byline is a liability: on llm-web
 * rows it is a site or platform label ("vertexaisearch.cloud.google.com",
 * "Reddit (r/BuyItForLife)"), and inventing "Verified buyer" / "Anonymous
 * Customer" because a field is empty seeds the same LLM that writes
 * input.copy.* — which the video cascade can burn as headline when
 * ad.copy.headline is empty (metaCascadeConfig). Never synthesise a persona.
 * Never pass source as a person. Anonymous-print origins are text-only.
 */
function quoteLineForTonePrompt(q) {
  const text = String(q?.text || '').trim();
  if (!text) return null;

  // Prefer a stamped origin; brand/product gemini rows already carry
  // origin:'llm-web'. Unstamped rows get text only — never invent.
  const origin = q.origin || null;
  if (origin && ANONYMOUS_PRINT_ORIGINS.has(origin)) {
    return `    - "${text}"`;
  }
  if (origin) {
    // First-party / attributed printable: a real name only, never source.
    const printable = toPrintableCustomerQuote({ ...q, origin, text });
    if (printable) {
      const author = printable.author_name || printable.author || null;
      return author ? `    - "${text}" — ${author}` : `    - "${text}"`;
    }
    // Non-printable origin: still useful as tone, text only.
    return `    - "${text}"`;
  }
  // Unstamped: text only. Do not fall back to q.source or invent a persona.
  return `    - "${text}"`;
}

function buildDerivationPrompt(ctx, template, aspectRatio, options) {
  const { media, detection, match, brand } = ctx;
  const ident = match?.identification || {};
  const details = ident.details || {};
  const isBranding = match?.outcome === 'brand_match';
  const isProductImage = options.variantKind === 'product_image';
  const brandName = ident.brand || media.metadata?.brand || brand?.name || null;
  const campaignKind = options.campaignKind || null;
  const promo = options.promotionalDetails || null;
  const lines = [];

  lines.push(`You are composing creative copy for a social-proof ad layout.`);
  lines.push(`Template: ${template} (${templateIntent(template)}).`);
  lines.push(`Aspect ratio: ${aspectRatio}.`);
  if (options.tone_hint) lines.push(`Caller tone hint: ${options.tone_hint}.`);

  // Match-type signal — the LLM should know whether this is the exact
  // SKU, just the SKU's category, or brand-only. Calibrates how
  // specific the copy can be:
  //   product_match    — exact SKU; write specific feature claims
  //   product_category — same category, may not be the exact item;
  //                      keep feature claims general
  //   brand_match      — no product signal; brand-only mode (BRAND
  //                      banner below also fires)
  const outcome = match?.outcome || null;
  if (outcome === 'product_match') {
    lines.push(`Match type: product_match — this is the exact SKU. Specific feature claims (material, scent, size, etc.) are safe.`);
  } else if (outcome === 'product_category') {
    lines.push(`Match type: product_category — this is in the SKU's category but may not be the exact item. Keep feature claims GENERAL (talk about the product class, not specific cuts/colors/scents you can't verify).`);
  } else if (outcome === 'brand_match') {
    lines.push(`Match type: brand_match — no specific product was identified. See BRAND-ONLY MODE below.`);
  }
  lines.push('');

  // CAMPAIGN INTENT — overrides default headline rules when the
  // operator chose 'brand' (tagline-anchored variants) or 'promotional'
  // (offer-aware copy with urgency). 'product'/null/'collection' keep
  // the existing match-outcome-driven framing below.
  if (campaignKind === 'brand') {
    const tagline = brand?.tagline || null;
    const tone    = Array.isArray(brand?.tone) ? brand.tone.filter(Boolean) : [];
    lines.push('CAMPAIGN INTENT — BRAND CAMPAIGN');
    if (tagline) {
      lines.push(`Anchor every headline variant on the brand's tagline: "${tagline}".`);
      lines.push(`Do not invent a new brand position. Reword, tighten, or punch up the tagline to fit the slot's character budget. The headline should READ as a variant of the tagline, not unrelated copy.`);
    } else {
      lines.push(`No tagline is on file for the brand. Treat headlines as brand-positioning lines — short, evocative, focused on the brand itself rather than any specific product or offer.`);
    }
    if (tone.length) {
      lines.push(`Match the brand's voice. Tone descriptors: ${tone.join(', ')}.`);
    }
    lines.push('Do NOT write product-specific feature claims or pitches in the headline.');
    lines.push('');
  } else if (campaignKind === 'promotional') {
    lines.push('CAMPAIGN INTENT — PROMOTIONAL CAMPAIGN');
    // Raffle is a structurally different promotional shape — the prize
    // is the story; the product is the entry mechanic. Branched out
    // before the standard discount-type rendering so the prompt frames
    // the headline around the prize first.
    if (promo?.discountType === 'raffle') {
      const prize = promo.rafflePrize || 'the featured prize';
      const epd   = Number(promo.raffleEntriesPerDollar) || 0;
      const draw  = promo.raffleDrawDate || promo.endsAt || null;
      lines.push(`This is a RAFFLE / sweepstakes campaign.`);
      lines.push(`- Prize: ${prize}`);
      if (epd > 0) lines.push(`- Entry rate: ${epd} entr${epd === 1 ? 'y' : 'ies'} per dollar spent (every purchase earns at least 1 entry).`);
      if (promo.discountCode) lines.push(`- Promo code (optional): ${promo.discountCode}`);
      if (draw) {
        const drawIso = new Date(draw).toISOString().slice(0, 10);
        const daysLeft = Math.ceil((new Date(draw).getTime() - Date.now()) / 86400000);
        lines.push(`- Drawing date: ${drawIso}${Number.isFinite(daysLeft) && daysLeft > 0 ? ` (${daysLeft} day${daysLeft === 1 ? '' : 's'} from now)` : ''}.`);
      }
      if (promo.headline) lines.push(`- Operator's preferred headline anchor: "${promo.headline}".`);
      if (promo.notes)    lines.push(`- Notes: ${promo.notes}`);
      lines.push('');
      lines.push('Headline MUST surface the prize and the entry mechanic. Examples: "Win [prize]! Every $1 earns 5 entries", "Buy a box, get 50 chances", "Enter to win — every purchase counts".');
      lines.push('Do not describe the product as the prize — the prize is separate. The product is the path to entering.');
      lines.push('Use phrases like "Enter to win", "Your chance to win", "Each purchase earns entries" — NOT "save X%" or "discount" (this is a raffle, not a sale).');
      if (draw) {
        const daysLeft = Math.ceil((new Date(draw).getTime() - Date.now()) / 86400000);
        if (Number.isFinite(daysLeft) && daysLeft > 0 && daysLeft <= 7) {
          lines.push(`Add urgency — the drawing is in ${daysLeft} day${daysLeft === 1 ? '' : 's'}. Use phrases like "Drawing Friday", "${daysLeft} days to enter", "Last chance to enter".`);
        }
      }
      lines.push('Reference sweepstakes-style framing; NEVER imply a guaranteed win.');
      lines.push('');
    } else if (promo && Object.keys(promo).length) {
      const promoLines = [];
      if (promo.discountType && promo.discountValue != null) {
        const v = promo.discountValue;
        const offer = promo.discountType === 'percent' ? `${v}% off`
                    : promo.discountType === 'amount'  ? `$${v} off`
                    : promo.discountType === 'bogo'    ? 'Buy one, get one'
                    : promo.discountType === 'bundle'  ? 'Bundle savings'
                    : promo.discountType === 'gift'    ? `Free gift${promo.giveaway ? `: ${promo.giveaway}` : ''}`
                    : promo.discountType === 'free_shipping' ? 'Free shipping'
                    : `${promo.discountType}: ${v}`;
        promoLines.push(`- Offer: ${offer}`);
      } else if (promo.giveaway) {
        promoLines.push(`- Giveaway: ${promo.giveaway}`);
      }
      if (promo.discountCode)             promoLines.push(`- Promo code: ${promo.discountCode}`);
      if (promo.startsAt || promo.endsAt) {
        const start = promo.startsAt ? new Date(promo.startsAt).toISOString().slice(0, 10) : '—';
        const end   = promo.endsAt   ? new Date(promo.endsAt).toISOString().slice(0, 10)   : '—';
        promoLines.push(`- Window: ${start} → ${end}`);
      }
      if (promo.headline) promoLines.push(`- Operator's preferred headline: "${promo.headline}" (use as anchor; vary tone + length to fit the slot).`);
      if (promo.notes)    promoLines.push(`- Notes: ${promo.notes}`);
      lines.push('Operator-supplied promotional details:');
      promoLines.forEach(l => lines.push(l));
      lines.push('');
      lines.push('Headline MUST surface the offer or giveaway. Cite the discount, promo code, or freebie clearly — that is the reason this ad is running.');
      if (promo.endsAt) {
        const daysLeft = Math.ceil((new Date(promo.endsAt).getTime() - Date.now()) / 86400000);
        if (Number.isFinite(daysLeft) && daysLeft > 0 && daysLeft <= 7) {
          lines.push(`Add urgency — the offer ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}. Use phrases like "Ends Friday", "${daysLeft} days left", "Don't miss it" where natural.`);
        }
      }
    } else {
      lines.push('Promotional campaign with no operator-supplied details. Lean toward urgency + "limited time" framing without inventing specific numbers or dates.');
    }
    lines.push('Do not undercut the offer with generic brand copy — every headline variant should reference the deal in some form.');
    lines.push('');
  }


  // Brand-mode banner — sets framing for the whole prompt up front so
  // every TASK rule the model considers below is filtered through
  // "brand-only, no product".
  if (isBranding) {
    lines.push('BRAND-ONLY MODE — NO SPECIFIC PRODUCT WAS IDENTIFIED');
    lines.push(`The Media is brand content (no recognizable SKU). All copy must focus on the BRAND ITSELF — its values, its community, its category leadership — NOT on a specific product.`);
    lines.push(`Do NOT invent a product name. Do NOT write headlines like "The best X" or "Try our Y". Write headlines that sell the brand.`);
    lines.push('');
    lines.push('BRAND:');
    if (brandName)             lines.push(`  Name: ${brandName}`);
    if (brand?.tagline)        lines.push(`  Tagline: ${brand.tagline}`);
    if (Array.isArray(brand?.tone) && brand.tone.length) lines.push(`  Voice: ${brand.tone.join(', ')}`);
    if (media.metadata?.category) lines.push(`  Category: ${media.metadata.category}`);
    if (detection?.primarySubjectDesc) lines.push(`  Scene: ${detection.primarySubjectDesc}`);
    if (match?.brandReviews?.summary) lines.push(`  Brand sentiment summary: ${match.brandReviews.summary}`);
  } else {
    lines.push('PRODUCT:');
    if (ident.productName) lines.push(`  Name: ${ident.productName}`);
    if (ident.brand)       lines.push(`  Brand: ${ident.brand}`);
    if (media.metadata?.category) lines.push(`  Category: ${media.metadata.category}`);
    if (details.price?.display)   lines.push(`  Price: ${details.price.display}`);
    if (detection?.primarySubjectDesc) lines.push(`  Description: ${detection.primarySubjectDesc}`);
    if (Array.isArray(detection?.text) && detection.text.length) {
      const tokens = detection.text.slice(0, 10).map(t => `"${t.content}"`).filter(Boolean).join(', ');
      if (tokens) lines.push(`  Text visible on product: ${tokens}`);
    }
  }
  lines.push('');
  // SOCIAL CONTEXT only applies to UGC variants — catalog-product Media
  // has no creator / caption / engagement. Skipping the section
  // entirely (instead of emitting an empty one) keeps the prompt
  // focused on product copy when variantKind === 'product_image'.
  if (!isProductImage) {
    lines.push('SOCIAL CONTEXT:');
    lines.push(`  Platform: ${DEFAULT_CREATOR_PLATFORM} (simulated; real ingestion will supply this)`);
    if (media.metadata?.caption)       lines.push(`  Caption: "${media.metadata.caption}"`);
    if (media.metadata?.creatorName)   lines.push(`  Creator: ${media.metadata.creatorName}`);
    if (media.metadata?.creatorHandle) lines.push(`  Handle: ${media.metadata.creatorHandle}`);
    if (media.platformStats) {
      const s = media.platformStats;
      const stats = ['likes','comments','shares','saves','views'].map(k => s[k] != null ? `${k}=${s[k]}` : null).filter(Boolean).join(', ');
      if (stats) lines.push(`  Engagement stats: ${stats}`);
    }
    if (detection?.transcript?.text) lines.push(`  Transcript: "${String(detection.transcript.text).slice(0, 800)}"`);
    lines.push('');
  }
  if (isBranding) {
    // Branding-mode review signal comes from brand-level Gemini search
    // not product-level SerpAPI. Surface those quotes so the LLM can
    // draw on real brand sentiment when authoring its own quotes.
    const br = match?.brandReviews;
    if (br) {
      lines.push('BRAND REVIEW SIGNAL:');
      if (typeof br.rating === 'number')      lines.push(`  Brand rating: ${br.rating}`);
      if (typeof br.reviewCount === 'number') lines.push(`  Brand review count: ${br.reviewCount}`);
      if (br.summary)                         lines.push(`  Brand sentiment: ${br.summary}`);
      if (Array.isArray(br.quotes) && br.quotes.length) {
        lines.push('  Real brand quotes (use these to inform tone, do NOT copy verbatim):');
        for (const q of br.quotes.slice(0, 5)) {
          const line = quoteLineForTonePrompt(q);
          if (line) lines.push(line);
        }
      }
      lines.push('');
    }
  } else {
    lines.push('REVIEW SIGNAL:');
    if (typeof details.rating === 'number')      lines.push(`  Rating: ${details.rating}`);
    if (typeof details.reviewCount === 'number') lines.push(`  Review count: ${details.reviewCount}`);
    if (details.reviewSummary?.summary)          lines.push(`  Review summary: ${details.reviewSummary.summary}`);
    // Real product-level review quotes (when available) — surfaced so
    // the LLM can ground its tone in actual customer language. Cap at
    // 5 to keep the prompt budget reasonable.
    const productReviews = productReviewsOf(match);
    if (productReviews?.quotes?.length) {
      lines.push('  Real product quotes (use these to inform tone, do NOT copy verbatim):');
      for (const q of productReviews.quotes.slice(0, 5)) {
        const line = quoteLineForTonePrompt(q);
        if (line) lines.push(line);
      }
    }
    lines.push('');
  }
  if (detection?.background) {
    const bg = detection.background;
    lines.push(`SCENE CONTEXT (for theme hints):`);
    if (bg.description) lines.push(`  ${bg.description}`);
    if (bg.style)       lines.push(`  Style: ${bg.style}`);
    if (bg.lighting)    lines.push(`  Lighting: ${bg.lighting}`);
    if (bg.setting)     lines.push(`  Setting: ${bg.setting}`);
    lines.push('');
  }

  // Demographics → persona-authored notional quotes
  const demos = Array.isArray(ctx.brand?.demographics) ? ctx.brand.demographics.slice(0, 5) : [];
  if (demos.length) {
    lines.push('BRAND KEY PERSONAS (use these as quote authors):');
    demos.forEach((d, i) => {
      const parts = [];
      if (d.description) parts.push(d.description);
      if (Array.isArray(d.interests)  && d.interests.length)  parts.push(`cares about: ${d.interests.join(', ')}`);
      if (Array.isArray(d.painPoints) && d.painPoints.length) parts.push(`worried about: ${d.painPoints.join(', ')}`);
      if (d.toneHint) parts.push(`voice: ${d.toneHint}`);
      lines.push(`  ${i + 1}. ${d.name} — ${parts.join(' · ')}`);
    });
    lines.push('');
  }

  // Per-template quote count targets. review_collage stacks multiple cards,
  // so we push the LLM to produce enough to actually fill the stacks.
  const quoteTarget = template === 'review_collage'      ? 'AT LEAST 4, ideally 5 or 6'
                    : template === 'testimonial_spotlight' ? 'at least 1 strong hero quote plus 2–3 supporting'
                    : 'at least 2, ideally 3–5';

  lines.push(`TASK:`);
  lines.push(`Produce JSON matching the schema. Rules:`);

  // Slot-aware char budgets — derived from the canvas variant's actual
  // headline + eyebrow rect dimensions, font scale, and decoration
  // overhead (display_script lead/main split, eyebrow_rules hairlines).
  // When present, these are HARD caps the LLM must write to; the
  // word-count rules below are softer guidance.
  const canvasVariant = registry.CANVAS.templates?.[template]?.variants?.[aspectRatio] || null;
  const slotBudgets   = canvasVariant ? computeSlotBudgets(canvasVariant) : {};
  const useSplitHeadline = !!slotBudgets.headline;

  // Overlay-mode templates run placement BEFORE derivation; the box
  // dimensions for headline / cta / quote are passed in via
  // options.overlayBoxes. Convert each to a char-budget hint and
  // surface as prompt rules so the LLM writes copy that fits the
  // chosen rect rather than relying on auto-fit shrinkage.
  const overlayBoxes = options.overlayBoxes || null;
  const overlayBoxBudgets = overlayBoxes ? overlayBoxesToBudgets(overlayBoxes) : null;

  if (isBranding) {
    // Brand-mode headline / quote rules. Override the product-shaped
    // defaults so the LLM doesn't backslide into product-specific copy.
    if (useSplitHeadline) {
      const hb = slotBudgets.headline;
      lines.push(`- "copy.headline_lead" REQUIRED — the small first clause of a stacked display-script headline. MAX ${hb.lead.max_chars} characters, ${hb.lead.max_lines} line, ~${hb.lead.max_words} words. It renders at HALF the size of headline_main, so it carries the setup: an audience cue, a claim opener, or an invitation — written in THIS brand's register.`);
      lines.push(`- "copy.headline_main" REQUIRED — the large second clause that completes the headline. MAX ${hb.main.max_chars} characters across ${hb.main.max_lines} line(s), ~${hb.main.max_words} words. This is the punch: the payoff the lead sets up. Keep it BRAND-FOCUSED, not product-specific.`);
      lines.push(`    Together they must read as ONE headline: lead + " " + main. Bad: a complete sentence in the lead.`);
      lines.push(`- Also emit "copy.headline" as the joined "<headline_lead> <headline_main>" string for downstream compatibility.`);
    } else {
      lines.push(`- "copy.headline" REQUIRED, ≤ 8 words. Must be BRAND-FOCUSED, not product-specific.`);
      lines.push(`    Shapes that work (these describe STRUCTURE — do not reuse this wording): the audience and what they trust; what the brand is built for; a promise about how long it lasts. Write the actual words from THIS brand's voice and category.`);
      lines.push(`    Bad examples: "The best fishing shirt" (specific product), "Try the AquaTek Pro" (specific SKU), "50% off select items" (offer-specific).`);
    }

    if (slotBudgets.eyebrow) {
      const eb = slotBudgets.eyebrow;
      lines.push(`- "copy.subheadline" REQUIRED — renders as a centered all-caps phrase between two horizontal hairlines. MAX ${eb.max_chars} characters (the hairlines reserve ~30% of the slot width on each side, so the text stays readable; longer strings collapse the rules). ~${eb.max_words} words. Use punchy three-beat phrasing like "REAL HEAT. REAL FLAVOR. REAL RESULTS." or "CRAFTED. TESTED. LOVED.".`);
      lines.push(`- "eyebrow" ≤ 3 words (e.g. brand category or audience). "highlight_text" ≤ 5 words.`);
    } else {
      lines.push(`- "subheadline" ≤ 15 words, expands the brand promise. "eyebrow" ≤ 3 words (e.g. brand category or audience). "highlight_text" ≤ 5 words.`);
    }
    lines.push(`- DO NOT emit "short_benefits" or product "badges" — there is no specific product. Use brand-level proof badges instead (e.g. "Trusted by anglers", "Family-owned since 2003", "${brand?.tone?.[0] || 'Premium'} quality").`);
  } else {
    if (useSplitHeadline) {
      const hb = slotBudgets.headline;
      lines.push(`- "copy.headline_lead" REQUIRED — the small first clause of a stacked display-script headline. MAX ${hb.lead.max_chars} characters, ${hb.lead.max_lines} line, ~${hb.lead.max_words} words. Renders at HALF the size of headline_main, so it carries the setup: the benefit, the objection it answers, the moment it is used, or the audience — in THIS brand's register.`);
      lines.push(`- "copy.headline_main" REQUIRED — the large second clause. MAX ${hb.main.max_chars} characters across ${hb.main.max_lines} line(s), ~${hb.main.max_words} words. The punch the lead pays off.`);
      lines.push(`    Together: lead + " " + main reads as one headline. Bad: full sentence in lead, or a clause that doesn't grammatically chain into main.`);
      lines.push(`- Also emit "copy.headline" as the joined "<headline_lead> <headline_main>" string for downstream compatibility.`);
    } else {
      lines.push(`- "copy.headline" REQUIRED, ≤ 8 words.`);
    }
    if (slotBudgets.eyebrow) {
      const eb = slotBudgets.eyebrow;
      lines.push(`- "copy.subheadline" REQUIRED — renders as a centered all-caps phrase between two horizontal hairlines. MAX ${eb.max_chars} characters (the hairlines reserve ~30% of the slot width on each side; longer strings collapse the rules). ~${eb.max_words} words. Three-beat phrasing reads best: "REAL HEAT. REAL FLAVOR. REAL RESULTS.".`);
      lines.push(`- "eyebrow" ≤ 3 words. "highlight_text" ≤ 5 words.`);
    } else {
      lines.push(`- "subheadline" ≤ 15 words. "eyebrow" ≤ 3 words. "highlight_text" ≤ 5 words.`);
    }
    lines.push(`- "short_benefits" 3–5 items, each ≤ 6 words, concrete buyer benefits (not specs).`);
    // Rewritten 2026-08-19 (compliance): the prior wording listed "Top
    // rated" / "Editor's pick" / "Best seller" as bare examples with no
    // "if" condition attached to them — unlike the two lines right before
    // them, which do carry one — and the model read that as license to
    // print any of the five with no evidence, confirmed live
    // (run_1787174963435_ff67021e: badges=["Top rated","Best seller",
    // "Sustainably made"] with rating=null/reviewCount=null). A downstream
    // gate (services/claimSubstantiationService.js, applied in
    // buildMetaForAd) is the enforced backstop regardless of what this
    // prompt produces, but the prompt should not be inviting the fabrication
    // in the first place.
    lines.push(`- "badges" 0–4 items, each 1–3 words, and ONLY when the data above supports one: "<rating>★ rated" or "Top rated" ONLY if Rating ≥ 4.5 AND Review count ≥ 100 were BOTH given above; "<count>+ reviews" ONLY restating a review-count figure actually given above. If Rating/Review count were not given above, or don't clear those bars, output an EMPTY array — that is the correct, expected answer for most products, not a fallback to avoid. NEVER emit a sales-rank or endorsement claim ("Best seller", "Top seller", "#1", "Most popular", "Editor's pick", "Staff pick", "Trending") — this pipeline has no sales-rank or editorial data for any product, ever. NEVER emit an environmental, ethical or certification claim ("Sustainably made", "Eco-friendly", "Organic", "Cruelty-free", etc.) — these are regulated advertising claims (e.g. FTC Green Guides) this pipeline cannot substantiate from catalog data, for any product.`);
  }

  // CASING — stated once, explicitly, because nothing else in this prompt
  // said anything about it.
  //
  // There is no textTransform in the renderers and no title-case helper on
  // this path: whatever the model returns is what a customer reads. With no
  // rule, it guessed differently every run — the same product shipped
  // "MEET THE STRATO BREATHE" on one ad and "Meet The New Softest Tee" on
  // another, and naive title-case capitalised short prepositions
  // ("Built To Move. Styled To Stay."). Owner, 2026-08-11: "I just don't
  // want to see meet the, especially in all caps. I noticed it is sometimes
  // capitalizing random words in titles also."
  //
  // The examples above used to be written in CAPS, which is where the model
  // learned to shout; they are now abstract shapes, so this rule is what
  // fills the vacuum they left.
  lines.push(`- CASING: write copy in sentence case — capitalise the first word and proper nouns only. Do NOT Capitalise Every Word, and do not capitalise short words like "to", "the", "for", "and", "of" mid-phrase. Do NOT write in ALL CAPS: the layout applies its own emphasis, and caps in the copy itself cannot be undone downstream. The one exception is a word the brand itself always styles that way (a wordmark or an established brand phrase).`);

  // Overlay-template box-aware caps (testimonial_overlay, product_overlay).
  // The placement engine reserved boxes BEFORE derivation; tell the LLM
  // exactly how many chars / lines fit each box. Hard caps that override
  // the word-count guidance above.
  if (overlayBoxBudgets) {
    if (overlayBoxBudgets.headline) {
      const hb = overlayBoxBudgets.headline;
      lines.push(`- "copy.headline" REQUIRED — overlay placement box is ${hb.w_px}×${hb.h_px}px. MAX ${hb.max_chars} characters across ${hb.max_lines} line(s), ~${hb.max_words} words. Write to FIT the box exactly; auto-fit shrinkage at render time is the safety net, not the goal.`);
    }
    if (overlayBoxBudgets.cta) {
      const cb = overlayBoxBudgets.cta;
      lines.push(`- "cta.text" REQUIRED — overlay button box is ${cb.w_px}×${cb.h_px}px. MAX ${cb.max_chars} characters, 1 line, ~${cb.max_words} words. Imperative voice, e.g. "Shop now", "Get yours", "Discover".`);
    }
    if (overlayBoxBudgets.quote) {
      const qb = overlayBoxBudgets.quote;
      lines.push(`- "quotes[0].text" — overlay quote box is ${qb.w_px}×${qb.h_px}px. MAX ${qb.max_chars} characters across ${qb.max_lines} line(s). Notional review/testimonial sentence; keep it tight.`);
    }
  }

  // Quote length target depends on template — narrow zones (split-screen
  // quote_bubble, review_collage cards) clip on mobile when quotes run long.
  const quoteLengthRule = (template === 'ugc_split_screen' || template === 'review_collage')
    ? '10–14 words and UNDER 90 characters each (split-screen / collage zones clip at 4 lines on narrow canvases)'
    : '12–18 words, ≤ 120 characters each';

  if (isBranding) {
    // Brand-mode quotes: about the BRAND, not a product.
    lines.push(`- "quotes" ${quoteTarget} short notional brand-experience quotes. Each speaks to the BRAND — its values, community, what it stands for — NOT a specific product purchase.`);
    if (demos.length) {
      lines.push(`    Author each quote in the voice of one of the BRAND KEY PERSONAS above. author_name = persona name; author_title = persona one-phrase cue; source="testimonial" or "ugc".`);
    } else {
      lines.push(`    author_name can be null; source="review".`);
    }
    if (match?.brandReviews?.quotes?.length) {
      lines.push(`    Use the BRAND REVIEW SIGNAL above as your tonal grounding — paraphrase, don't copy verbatim.`);
    }
    lines.push(`    Target ${quoteLengthRule}. Mix angles (community, values, longevity, fit-for-purpose).`);
  } else if (demos.length) {
    lines.push(`- "quotes" ${quoteTarget} NOTIONAL persona-authored reviews/comments. Use the BRAND KEY PERSONAS above as the quote voices — match each quote to a persona's vocabulary, concerns, and tone. author_name is the persona's name; author_title is a one-phrase identity cue; source="testimonial" or "ugc". Ground substance in the review summary. verified=true only if the brand has well-documented social proof. Target ${quoteLengthRule}. Mix angles across quotes.`);
  } else {
    lines.push(`- "quotes" ${quoteTarget} short notional reviews/comments drawn from the review summary. author_name can be null; source="review" unless signal clearly implies creator/ugc. verified=false unless clearly endorsed. Target ${quoteLengthRule}. Mix angles.`);
  }

  if (isBranding) {
    lines.push(`- "cta.text" REQUIRED, ≤ 3 words, brand-shop imperative (e.g. "Shop the brand", "Discover", "Explore").`);
  } else {
    lines.push(`- "cta.text" REQUIRED, ≤ 3 words, imperative voice (e.g. "Shop now"). "offer_text" only if price/offer data supports it.`);
  }
  lines.push(`- "trusted_by_text" preferred if review_count ≥ 50 — format "Trusted by Xk+ customers", "Loved by Nk shoppers", etc.`);
  lines.push(`- "tone" 2–4 single-word descriptors matching brand + caption voice.`);
  lines.push(`- "theme_style" / "background_style" / "emphasis" pick values best suited to the template and signal.`);
  lines.push(`Goal: the output must FILL the template's visible zones. If a template needs multiple quotes / badges / benefits and you have enough source material, produce them. Do not invent specific reviewer names, retailer names, or pricing that aren't grounded in the data.`);
  return lines.join('\n');
}

// Join headline_lead + headline_main into a single string for slot
// bindings that read copy.headline directly. Trims and collapses
// whitespace so an empty lead doesn't leave a leading space.
function joinHeadlineParts(lead, main) {
  const a = (lead || '').trim();
  const b = (main || '').trim();
  if (!a && !b) return undefined;
  return [a, b].filter(Boolean).join(' ');
}

function templateIntent(template) {
  switch (template) {
    case 'testimonial_spotlight': return 'one strong quote + product hero, minimal copy';
    case 'ugc_split_screen':      return 'UGC image + product hero side-by-side';
    case 'review_collage':        return 'multiple short quotes tiled around the product';
    case 'results_proof':         return 'metrics-forward (stars, review count, stats) with the product';
    case 'creator_endorsement':   return 'creator persona + quote + product, social-first tone';
    default:                      return '';
  }
}

// If Gemini returned zero quotes but the review summary is present, carve a
// ── Quote selection: universal scorer + tiered pool ──────────────
//
// Scores a candidate quote for "sentiment magnitude + specificity"
// using cross-vertical structural signals — no product/brand keyword
// lists, so this works identically for skincare, apparel, flowers,
// gear, etc. Higher = better.
//
// Positive signals (all additive):
//   Length in the 60-140 char goldilocks zone      +3
//   Length in the 40-180 char acceptable zone      +1
//   Contains a digit (specific claim)              +1
//   Contains a time/duration reference             +1
//   Contains a first-person-experience verb        +1
//   Universal positive-sentiment words             +1 per hit, capped
//   Universal enthusiasm phrases                   +2 per hit, capped
//
// Penalties:
//   Too short (<25 chars) or too long (>220)       -3
//   Fewer than 5 words                             -3
//   More than 40 words (rambling)                  -2
//   ALL CAPS (6+ chars)                            -2
//   Contains a URL                                 -5
//   Short + only positive tokens (generic praise)  -2
//
// Sentiment gate (post-signal check):
//   Any negation of positive sentiment             → -Infinity (disqualify)
//     (e.g. "not worth it", "would not recommend", "wasn't great")
//   Any complaint / disappointment marker          → -Infinity
//     (e.g. "terrible", "disappointed", "broke", "returned", "refund")
//   Any bare negative-affect verb                  → -Infinity
//     (e.g. "hate", "regret", "avoid")
//   Explicit low star rating in the text           → -Infinity
//     ("1 star", "2 stars", "1/5", "2/5")
//
// A quote must clear the sentiment gate to be selectable. Downstream
// pickStrongestQuote also requires a positive final score (see the
// SCORE_FLOOR there).
const STRONG_POSITIVE = /\b(love[ds]?|loving|adore[ds]?|adoring|obsess(ed|ion)|amazing|incredible|unbelievable|phenomenal|extraordinary|exceptional|outstanding|perfect|flawless|immaculate|impeccable|pristine|best|greatest|finest|premier|favou?rite|stunning|gorgeous|beautiful|exquisite|elegant|superb|magnificent|splendid|marvel(l)?ous|worth|worthy|fantastic|fabulous|wonderful|delightful|delighted|brilliant|terrific|essential|staple|thrill(ed|ing)|ecstatic|impressed|impressive|premium|luxurious|game[- ]?chang(er|ing)|life[- ]?chang(er|ing)|life[- ]?sav(er|ing)|must[- ]?have|go[- ]?to)\b/gi;

const MODERATE_POSITIVE = /\b(great|excellent|high[- ]?quality|top[- ]?notch|first[- ]?rate|solid|dependable|reliable|sturdy|durable|comfortable|cozy|effective|efficient|recommend(ed|ing|ation)?|happy|satisfied|pleased|smooth|reliable|noticeable|convenient|handy|well[- ]?made|thoughtful|beautifully|nicely)\b/gi;

// SENSORY PRAISE COUNTS AS PRAISE (owner decision 2026-08-11).
//
// This list was previously SCORING-ONLY, on the reasoning that bare fragments like
// "True to size" or "Soft enough for light activity" would otherwise qualify as
// endorsements. That reasoning was sound about FRAGMENTS and wrong about sentences: it
// meant *"These might be the softest sweatpants I've ever put on."* — real, specific,
// enthusiastic apparel praise — was thrown away at intake, because "soft" was the only
// positive word in it and this list did not open the gate. Measured on Vuori: 6 of 12
// retrieved quotes dropped, several of them genuinely good copy.
//
// So the ADJECTIVES move into the positivity bar (below), and the two bare FIT
// DESCRIPTORS stay scoring-only — "true to size" and "holds its shape" state a fact
// about sizing rather than expressing praise, and they are exactly the fragments the
// earlier review named. The other protection against bare fragments is unchanged and
// does the real work: scoreQuote's SCORE_FLOOR rejects short generic filler, and the
// static typeset judge additionally requires several words, so "Soft." cannot become a
// testimonial on its own.
// FIT-QUALITY DESCRIPTORS ARE PRAISE TOO (owner, 2026-08-11: *"'slim tailored fit'
// is a positive not neutral"*). The lexicon had sensory words but nothing for how a
// garment is CUT, so "All clothes, including the workout shorts, have a slim, tailored
// fit." read as a neutral description and was dropped at intake. In apparel that
// sentence is the compliment.
//
// "slim" and "fitted" are deliberately NOT here on their own — "runs slim" / "too
// fitted" are complaints, and HARD_LIMITER already owns the "runs small|narrow|tight"
// family. It is the CRAFT words that carry the praise.
// ONE list, used by BOTH the positivity lexicon and the negation guard below.
//
// It was two, and that was a live defect: #150 added these words to the positivity
// side without touching NEGATED_POSITIVE, so "Not as soft as I had hoped for the
// price." scored +1 and read as PRAISE — a complaint eligible for a paid ad. Any word
// that can make a line positive must also be a word that a negator can invert, so the
// two are now derived from the same string and cannot drift apart again.
const SENSORY_WORDS = 'soft|softer|softest|breathable|flattering|supportive|buttery|plush'
  + '|cushion(?:ed|y)?|cool(?:ing)?|stretchy|weightless|tailored|well[- ]?fitting'
  + '|well[- ]?cut|streamlined|sculpted';
const SENSORY_POSITIVE = new RegExp(`\\b(?:${SENSORY_WORDS})\\b`, 'gi');

// STILL SCORING ONLY: these state a fact about fit, they do not praise.
const SCORING_POSITIVE = /\b(soft|softer|softest|breathable|flattering|supportive|true to size|holds? (?:its )?shape)\b/gi;

const PHRASE_STRONG = /\b(worth every penny|worth the money|worth it|highly recommend|would recommend|five stars?|5[- ]?stars?|10\/10|hands down|blown away|blew me away|exceeded (my )?expectations|pleasantly surprised|fell in love|in love with|couldn't be happier|couldn'?t be more pleased|better than expected)\b/gi;

const EXPERIENCE_VERB = /\b(bought|purchas(ed|ing)|got|use[ds]?|using|wore|wearing|wear|tr(ied|ying)|ordered|received|installed|took|been (using|wearing|loving)|have had|had (this|it|them)|own(ed)?|opened|unboxed)\b/i;

const DURATION_REF = /\b(week|weeks|month|months|day|days|hour|hours|year|years|minute|minutes|second|seconds|since|for months|for years|for weeks|all day|every day)\b/i;

// PREFER A DIRECT TESTIMONIAL — owner directive 2026-08-11: *"It should prefer direct
// testimonials, but those can be used otherwise."*
//
// A PREFERENCE, NOT A GATE, and the distinction is the whole point. The tempting
// shortcut is to judge by SOURCE — treat a blog or a YouTube channel as "not a real
// customer" — and that inference is simply not supported: "A Busy Dad's Honest Review"
// is as likely to be someone writing up a purchase as it is to be sponsored content,
// and a video review is very often just a customer with a camera. We cannot read intent
// off a domain name.
//
// What we CAN read is VOICE. "I've worn these every day since June" is a person
// describing their own experience; "She says the bra provides the most comfortable
// support" is that person relaying someone else's. Only the first is a testimonial in
// the sense an ad needs — the second attributes words to a third party who never
// addressed us. So first-person voice earns a bonus and reported speech takes a
// penalty, both bounded, and neither disqualifies: a well-written third-person line
// still ranks and can still be used, it just loses to a customer speaking for themself.
//
// SIZED SMALL, AND HERE IS WHY. First-person pronouns are a WEAK PROXY: "Easy to wash,
// they are super comfortable and held up after 6 months" is unmistakably a customer
// describing their own experience and contains no pronoun at all. The absence of "I" is
// not evidence of anything, so this signal must nudge and never decide.
//
// At +2 it was strong enough to cancel the funnel-stage lever — verifyProofBeat caught
// it: at `stage: 'consideration'` a durability quote must outrank a repeat-purchase one,
// and the bonus flipped that purely because the repeat-purchase line happened to say
// "I". Stage is the mechanism that makes a quote match the AD'S INTENT; voice is a
// tie-breaker about who is speaking. A tie-breaker must not outrank the intent.
//
// MEASURED, not guessed. Scoring the real fixtures across candidate values showed the
// two constraints are in direct conflict for any single "big" number:
//
//   bonus   stage lever still works?   first-person beats a LONGER third-person line?
//   0.5     yes (6.20 vs 6.00)         no  (5.50 vs 6.00)
//   1.5     NO  (6.20 vs 7.00)         yes (6.50 vs 6.00)
//
// There is no value that does both — which is the answer, not a tuning problem. A
// preference is not supposed to beat a third-person line that is simply better copy:
// "The Strato Tech is so soft and comfortable, and it's moisture wicking…" is more
// specific and longer than "Every single piece I have is well made", and it SHOULD
// outrank it. What the preference has to do is win a near-tie between two otherwise
// comparable lines. That is +0.5.
//
// The reported-speech penalty stays larger at -2: that one is not a proxy at all, it is
// an explicit statement that the words belong to somebody who never addressed us.
const FIRST_PERSON = /(?:^|[^a-z])(?:i|i'?m|i'?ve|i'?d|i'?ll|my|me|mine|we|we'?re|we'?ve|our|us)(?![a-z])/i;

// Second-hand attribution. "She says…", "my wife says…", "the reviewer notes…" — the
// speaker is reporting, not testifying. AGGREGATE_VOICE in quoteSnippetService covers
// the plural summary register ("customers report…"); this covers the singular one,
// which that pattern deliberately does not match.
const REPORTED_SPEECH = /\b(?:he|she|they|my (?:wife|husband|partner|friend|mom|mum|dad|son|daughter|sister|brother)|the (?:reviewer|author|writer))\s+(?:\w+\s+){0,2}(?:says?|said|reports?|reported|notes?|noted|mentions?|mentioned|thinks?|thought|finds?|found|tells?|told)\b/i;

const FIRST_PERSON_BONUS = Number(process.env.QUOTE_FIRST_PERSON_BONUS || 0.5);
const REPORTED_SPEECH_PENALTY = Number(process.env.QUOTE_REPORTED_SPEECH_PENALTY || 2);


// ── Sentiment gate ─────────────────────────────────────────────────
// Any single hit here disqualifies the quote outright. False positives
// are acceptable — losing a genuinely-positive quote that happens to
// mention a friend's bad experience is better than shipping a negative
// review on an ad. The intent is a strict positive-selection filter.

// Explicitly-negated praise: "not worth it", "would not recommend",
// "didn't love it", "wasn't great", "not the best fit", etc.
// Matches negation particle immediately followed by (up to 3 tokens)
// a strong/moderate positive lexeme or phrase marker. The positive
// lexeme list here is broader than the scoring regexes above so mild
// negations ("not the best", "not great") still trip the gate — a
// review that leads with any negation of praise shouldn't headline an ad.
// SENSORY_WORDS is spliced in on purpose — see the note there. A negator in front of
// any word that can carry praise has to invert it, or the praise lexicon becomes a way
// for complaints to score.
const NEGATED_POSITIVE = new RegExp(
  "\\b(not|no|never|hardly|barely|isn'?t|wasn'?t|aren'?t|weren'?t|don'?t|doesn'?t|didn'?t"
  + "|won'?t|wouldn'?t|couldn'?t|shouldn'?t|can'?t|cannot|nothing)\\s+(\\w+\\s+){0,3}?"
  + "(love[ds]?|worth|recommend|great|amazing|good|perfect|impressed|impressive|happy"
  + "|satisfied|pleased|worth it|best|excellent|comfortable|nice|beautiful|quality|fit"
  + "|wow|thrilled|delighted|enough|" + SENSORY_WORDS + ")\\b", 'i');

// Complaint / product-defect / disappointment lexicon. Structural
// (not brand-specific): mentions of returns, refunds, defects,
// physical breakage, buyer's remorse, or emotional negatives.
const NEGATIVE_SENTIMENT = /\b(terrible|awful|horrible|dreadful|abysmal|garbage|trash|junk|useless|worthless|disappoint(ed|ing|ment)?|frustrat(ed|ing)|annoy(ed|ing)|regret(ted)?|avoid|scam|ripoff|rip[- ]?off|misleading|deceptive|false|fake|counterfeit|cheap(ly)?[- ]?made|poor(ly)?[- ]?made|shoddy|flimsy|defect(ive)?|broken|broke|snapped|torn|tore|ripped|shattered|cracked|leak(ed|ing|s)?|melt(ed|ing)?|faded|peel(ed|ing)?|stain(ed)?|smell(ed|s|y)|stink(s|y|ing)?|reek(s|ed)|hate[ds]?|hating|loathe|despise|worst|refund(ed|ing)?|return(ed|ing)?[- ]?it|returning|sent[- ]?back|had to return|took it back|would not (buy|recommend|purchase)|wouldn'?t (buy|recommend|purchase)|don'?t (buy|waste|bother)|do not (buy|waste|bother)|save your (money|time)|beware|warning|stay away|not for me|not what i expected|nothing like (the picture|advertised)|false advertising|not as (described|advertised|shown|pictured)|two[- ]?star|one[- ]?star|1\/5|2\/5|one star|two stars?)\b/i;

function scoreQuote(text, { stage = null, angleTerms = null } = {}) {
  const s = String(text || '').trim();
  if (!s) return -Infinity;

  // A hard limiter disqualifies outright: it argues against the purchase.
  if (HARD_LIMITER.test(s)) return -Infinity;

  // Sentiment gate — disqualifies negative quotes outright. Runs before
  // scoring so a well-structured 1-star review can't accumulate points.
  if (NEGATED_POSITIVE.test(s)) return -Infinity;
  if (NEGATIVE_SENTIMENT.test(s)) return -Infinity;

  const len = s.length;
  const words = s.split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  let score = 0;

  // Length band
  if (len >= 60 && len <= 140)      score += 3;
  else if (len >= 40 && len <= 180) score += 1;
  else if (len < 25 || len > 220)   score -= 3;

  // Sentiment magnitude — capped so a review can't win purely by piling on
  // superlatives; the specificity signals below break ties for lived-experience quotes.
  let strongHits     = (s.match(STRONG_POSITIVE)   || []).length;
  const moderateHits = (s.match(MODERATE_POSITIVE) || []).length;
  const phraseHits   = (s.match(PHRASE_STRONG)     || []).length;
  // "best" is in STRONG_POSITIVE, but "best suited for" is a limitation, not
  // praise. Do not let the narrowing phrase earn a positivity point.
  if (BEST_AS_LIMITER.test(s)) strongHits = Math.max(0, strongHits - 1);
  const scoringHits  = (s.match(SCORING_POSITIVE) || []).length;
  score += Math.min(strongHits * 1.5 + phraseHits * 2 + moderateHits + Math.min(scoringHits, 2), 5);
  const positiveSignals = strongHits + moderateHits + phraseHits + scoringHits;

  // Soft hedges qualify the praise around them.
  if (SOFT_HEDGE.test(s) || HEDGED_EXPECTATION.test(s)) score -= 1.5;

  // PURELY FACTUAL LINES ARE NOT PROOF. "Customers consistently praise the
  // fabric" and "Ballet flat design is a bit dressier than I expected" carry no
  // enthusiasm; they read as product copy, not as a customer speaking.
  if (positiveSignals === 0) score -= 2;

  // STAGE AFFINITY — reserved headroom, never a gate.
  // Applied BEFORE angle and independently capped so two angle hits
  // cannot zero the stage nudge. A shared BIAS_CAP=3 made stage a
  // no-op whenever conceptAngle already saturated the cap (two ≥4-
  // letter hook tokens → bias=3 before stage was added).
  let stageBias = 0;
  const stageKey = normalizeStage(stage);
  if (stageKey && STAGE_TERMS[stageKey]) {
    const hits = (s.match(STAGE_TERMS[stageKey]) || []).length;
    stageBias = Math.min(hits, 2) * STAGE_WEIGHT;
  }

  // DIRECTOR ANGLE AFFINITY — when a concept is driving the ad, a quote that
  // speaks to the same hook is worth more than a generically strong one.
  let angleBias = 0;
  if (Array.isArray(angleTerms) && angleTerms.length) {
    // WORD-BOUNDED, and short terms ignored: a substring test let ['soft'] match
    // "Microsoft" and a one-letter term match every quote ever written.
    const hits = angleTerms.filter((t) => {
      const term = String(t || '').trim();
      if (term.length < 4) return false;
      return new RegExp(`(?:^|[^a-z])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z])`, 'i').test(s);
    }).length;
    angleBias = Math.min(hits, 2) * ANGLE_WEIGHT;
  }
  // Stage reserved; angle still uses BIAS_CAP. Combined they can exceed 3.
  // The remaining honest no-op: a base-score lead larger than STAGE_HEADROOM
  // cannot be flipped by stage (thin SKU, single quote, or an 80–140 char
  // rave vs a 12-word closer). The harness pins that boundary.
  score += Math.min(stageBias, STAGE_HEADROOM);
  score += Math.min(angleBias, BIAS_CAP);

  // Specificity signals
  if (/\d/.test(s))            score += 1;
  if (DURATION_REF.test(s))    score += 1;
  if (EXPERIENCE_VERB.test(s)) score += 1;

  // VOICE — prefer a customer speaking for themself. See FIRST_PERSON above.
  // Reported speech is checked first so a line that does both ("She says I would love
  // it") is treated as the relay it is rather than earning the testimonial bonus.
  if (REPORTED_SPEECH.test(s))   score -= REPORTED_SPEECH_PENALTY;
  else if (FIRST_PERSON.test(s)) score += FIRST_PERSON_BONUS;

  // Penalties
  if (/^[A-Z\s!?.]{6,}$/.test(s))                       score -= 2;
  if (/https?:\/\/|www\./i.test(s))                     score -= 5;
  if (wordCount < 5)                                    score -= 3;
  if (wordCount > 40)                                   score -= 2;
  // Generic praise (short + only positive tokens, no lived-experience signals)
  if (wordCount <= 6 && (strongHits + moderateHits + phraseHits) >= 1 && !/\d/.test(s) && !DURATION_REF.test(s) && !EXPERIENCE_VERB.test(s)) {
    score -= 2;
  }
  // Trailing without terminator on longer quotes suggests truncation
  if (/[a-z]$/i.test(s) && !/[.!?]$/.test(s) && wordCount > 8) score -= 1;

  return score;
}

// Pick the highest-scoring quote from a candidate array. Returns
// { text, author_name, source } shape or null when the array is empty,
// nothing clears the sentiment gate, or the best-scoring quote scores
// below SCORE_FLOOR.
//
// SCORE_FLOOR = 1 — a winning quote must accumulate at least one net
// positive signal beyond just having non-negative sentiment. A quote
// like "I bought it last week" passes the sentiment gate but has no
// endorsement content; it shouldn't win the primary slot when better
// candidates might exist in a later tier (LLM-authored or synthesized).
// Also requires at least one explicit positive lexeme so we don't
// promote neutral-lived-experience quotes with no endorsement value.
const SCORE_FLOOR = 1;

// Ratings arrive on 5-, 10- and 100-point scales depending on the review app,
// and the vendor adapters store each review's stars verbatim (only the
// AGGREGATE goes through normalizeStars). Normalize before ANY comparison:
// read literally, a 90/100 clears every threshold, and as a scoring bonus it
// would add +85 to a text score that runs in single digits — the
// highest-NUMBERED rating would take the primary slot regardless of what the
// review actually says.
function toFiveScale(rating) {
  // Reject non-ratings BEFORE Number(): Number(null), Number('') and
  // Number(false) are all 0, which would reclassify an UNRATED quote as one
  // the reviewer scored zero stars — inverting the gate, since unrated
  // quotes are allowed through and 0-star quotes must not be.
  // A real 0 stays a real 0 and fails the threshold, which is correct.
  if (rating === null || rating === undefined || rating === '' || typeof rating === 'boolean') return null;
  const n = Number(rating);
  if (!Number.isFinite(n)) return null;
  if (n > 10) return n / 20;   // 100-point
  if (n > 5)  return n / 2;    // 10-point
  return n;
}

// Star gate for review-backed quote tiers, applied to a whole candidate list
// BEFORE it reaches pickStrongestQuote. A testimonial on a paid ad should
// come from someone who actually rated the product highly — text scoring
// alone cannot tell "the fabric feels amazing" in a 5-star review from the
// same clause inside a 2-star complaint.
//
// Applies to reviews only. Instagram comments and LLM-authored lines carry no
// star rating and are gated by sentiment elsewhere.
// QUOTE ELIGIBILITY FLOOR — which reviewers may be QUOTED. Distinct from the STAR
// floor (ratingDisplay.RATING_STAR_MIN), which governs which NUMBER may print.
//
// 4.35 as of 2026-08-04, following the owner moving the star floor so a DISPLAYED
// 4.4 prints. Left at 4.5 the two gates contradict each other on one ad: a
// 4.4-rated product would show "4.4 ★★★★★" while its own reviewers' words were
// filtered out, and the quote beside its stars would come from the category or
// brand tier instead. Owner chose to keep them coherent.
//
// WHY 4.35 AND NOT 4.4. This gate compares the RAW rating via toFiveScale, not the
// rounded display value the star gate uses. A raw 4.37 DISPLAYS as 4.4, so it
// prints stars; a 4.4 cut-off here would still refuse to quote that reviewer.
//
// Env-tunable via config/defaults.env, so the floor can move without a deploy.
const QUOTE_MIN_RATING     = Number(process.env.QUOTE_MIN_RATING || 4.35);

// ── LIMITATIONS ARE NOT TESTIMONIALS ───────────────────────────────────
//
// Owner, on a delivered GymShark ad: the quote "low-support option best suited
// for lighter activities" is "not great". It is not negative, so the sentiment
// gate passed it; and it scored 2.5, BEATING "This cactus is such a statement
// piece" (0) and "Customers consistently praise the Vuori fabric" (1). The reason
// is precise and slightly absurd: STRONG_POSITIVE matches the word "best" inside
// "best suited for", counting a phrase that NARROWS the product as praise.
//
// A limiting qualifier tells a shopper what the product is NOT for. That is the
// opposite of proof, and on a paid ad it argues against the sale.
// ANCHORED, AND NARROW. The first cut joined bare strings with no word
// boundaries, so it matched INSIDE other words — "fol(low support)",
// "yel(low-support)", "not great (for)tune" — and it was far too broad: adversarial
// review found six genuinely positive reviews it killed, including
//   "I wish I had bought these sooner"   (a strong conversion quote)
//   "If you want a legging that lasts, buy these"
//   "My only complaint is I did not buy two pairs"
// Those read as praise. Only phrases that UNAMBIGUOUSLY narrow the product's
// suitability veto a quote; anything hedgier is a scored penalty instead.
const HARD_LIMITER = new RegExp(
  "(?:^|[^a-z])(?:"
  + [
      "best suited (?:for|to)\\b",
      "better suited (?:for|to)\\b",
      "not (?:ideal|meant|designed|suitable|intended) for\\b",
      "isn'?t (?:ideal|meant|designed|suitable) for\\b",
      "runs (?:small|large|big|narrow|tight)\\b",
      "low[- ]?support\\b",
      "not enough (?:support|coverage|padding)\\b",
    ].join("|")
  + ")", 'i');

// Softer hedges: they can sit inside a genuinely positive line ("softer than I
// expected"), so they are penalised rather than disqualifying.
const SOFT_HEDGE = /\b(?:a bit|a little (?:small|large|tight|loose|thin|sheer)|slightly|somewhat|although|however|but the|but it|for the price|at this price)\b/i;
// "better than expected" / "softer than I expected" are PRAISE; only an unqualified
// expectation clause is a hedge.
const HEDGED_EXPECTATION = /(?:^|[^a-z])(?<!better |softer |nicer |cheaper |faster |bigger |more )than (?:i )?expected\b/i;

// "best" only counts as praise when it is not narrowing the product.
// "the best for the price" and "the best for me" are PRAISE — a bare "best for"
// veto demoted them. Only strip the positive hit when a NARROWING use case follows.
const BEST_AS_LIMITER = /\bbest (?:suited\b|for (?:light|casual|lounging|layering|mild|warm|cool|beginners?|occasional|short))/i;

// ── FUNNEL STAGE ───────────────────────────────────────────────────────
//
// Owner: "the quote selection should be influenced by the director and the
// position in the funnel". The same review is not equally useful at every stage:
// top of funnel needs a feeling, mid funnel needs an objection removed, bottom of
// funnel needs the purchase justified. Terms are additive nudges (bounded), never
// gates — a stage must not be able to promote a weak quote over a strong one.
const STAGE_TERMS = {
  // Discovery: sensory, emotional, "people noticed".
  awareness: /\b(obsessed|in love|gorgeous|stunning|beautiful|compliment(s|ed)?|every ?day|favou?rite|so soft|feels? (amazing|incredible|luxurious)|turn(s|ed)? heads|statement)\b/gi,
  // Objection removal: fit, quality, durability, comparison, care.
  consideration: /\b(true to size|fits? (perfectly|great|true)|held up|holds up|washed?|washing|durable|quality|sturdy|after (weeks|months|years)|compared|versus|vs\.?|sizing|runs true|breathable|no pilling|still looks?)\b/gi,
  // Decision: value, repeat purchase, regret-free.
  conversion: /\b(worth (every penny|the money|it)|bought (another|a second|two|more)|reorder(ed|ing)?|repurchas(ed|ing)|buy(ing)? again|wish i('?d| had) (bought|ordered)|no regrets|best purchase|highly recommend|10\/10)\b/gi,
};
const STAGE_ALIASES = { awareness: 'awareness', consideration: 'consideration', conversion: 'conversion',
  top: 'awareness', mid: 'consideration', middle: 'consideration', bottom: 'conversion', bofu: 'conversion',
  tofu: 'awareness', mofu: 'consideration' };
function normalizeStage(v) {
  const k = String(v || '').toLowerCase().replace(/[^a-z]/g, '');
  return STAGE_ALIASES[k] || null;
}

// Flag-off: empty opts so pickStrongestQuote is today's scorer (no
// STAGE_TERMS / angle nudge). Flag-on: stage + conceptAngle from the
// caller. Callers may always pass the fields; this function is the
// single gate that keeps flag-off byte-identical.
function quoteOptsFromOptions(options) {
  if (!quoteStageAwareEnabled()) return { stage: null, angleTerms: null };
  return {
    stage: normalizeStage(options?.funnelStage || options?.stage || null),
    angleTerms: Array.isArray(options?.conceptAngle) ? options.conceptAngle.slice(0, 8) : null
  };
}

// Director emotional_hook → word list for scoreQuote's angleTerms.
// Dual-read via conceptField so a v3 nested hook is not silently dropped.
function conceptAngleTerms(concept) {
  if (!concept) return null;
  const { conceptField } = require('./conceptProjection');
  const hook = conceptField(concept, 'emotional_hook');
  if (typeof hook !== 'string' || !hook.trim()) return null;
  const terms = hook.split(/[^a-zA-Z]+/).map((t) => t.trim()).filter((t) => t.length >= 4);
  return terms.length ? terms.slice(0, 8) : null;
}

// Best-effort angle resolution for render callers. Flag-off skips the
// concept fetch so the default path pays no extra query.
async function resolveQuoteAssemblyOptions(ad) {
  const funnelStage = ad?.funnelStage || null;
  if (!quoteStageAwareEnabled()) {
    return { funnelStage, conceptAngle: null };
  }
  let conceptAngle = Array.isArray(ad?.conceptAngle) ? ad.conceptAngle.slice(0, 8) : null;
  const artifactId = ad?.conceptArtifactId || ad?.adConceptArtifactId || null;
  const conceptId  = ad?.conceptId || ad?.adConceptId || null;
  if (!conceptAngle && artifactId && conceptId) {
    try {
      const CreativeDirectionArtifact = require('../models/CreativeDirectionArtifact');
      const art = await CreativeDirectionArtifact.findById(artifactId).select('concepts').lean();
      const concept = (art?.concepts || []).find((c) => c.concept_id === conceptId);
      conceptAngle = conceptAngleTerms(concept);
    } catch {
      /* angle is a nudge, never a hard dep */
    }
  }
  return { funnelStage, conceptAngle };
}

/**
 * Re-pick social_proof.primary_quote from the artifact's stored pool
 * (primary + secondary_quotes) using the Ad's stage / concept angle.
 *
 * This is the paid-path contract for QUOTE_STAGE_AWARE. PMax funnel
 * retitles never write their own LayoutInputArtifact; they share the
 * master's {mediaId, productId} newest 4.1 row. Hash-partitioning that
 * row would miss, fall back to the unstaged winner, and log
 * funnel=awareness while burning the unstaged quote. Re-scoring the
 * already-gated pool at render/titling time is the only pick those
 * rows can honour.
 *
 * Flag-off / no stage / single-quote pool: identity (returns `input`
 * unchanged, same object). Stays inside the winning tier so a
 * conversion-flavoured brand quote cannot outrank a product-tier
 * primary — same cascade rotation already obeys.
 *
 * Does not mutate `input`. Does not persist. Callers (buildMetaForAd,
 * buildIntentData, deriveStage) apply this to the in-memory object
 * they are about to print.
 */
function applyStagedQuotePick(input, options = {}) {
  if (!input || typeof input !== 'object') return input;
  if (!quoteStageAwareEnabled()) return input;
  const quoteOpts = quoteOptsFromOptions(options);
  if (!quoteOpts.stage && !quoteOpts.angleTerms) return input;
  const proof = input.social_proof;
  if (!proof || !proof.primary_quote || !proof.primary_quote.text) return input;

  const primary = proof.primary_quote;
  const rest = Array.isArray(proof.secondary_quotes) ? proof.secondary_quotes : [];
  const pool = [primary, ...rest].filter((q) => q && String(q.text || '').trim());
  if (pool.length < 2) return input;

  const tier = primary.tier || null;
  const candidates = tier
    ? pool.filter((q) => (q.tier || null) === tier)
    : pool;
  if (candidates.length < 2) return input;

  const picked = pickStrongestQuote(candidates, quoteOpts);
  if (!picked || picked.text === primary.text) return input;

  const secondary = pool.filter((q) => q.text !== picked.text);
  return {
    ...input,
    social_proof: {
      ...proof,
      primary_quote: picked,
      secondary_quotes: secondary.length ? secondary : undefined
    }
  };
}

const STAGE_WEIGHT = Number(process.env.QUOTE_STAGE_WEIGHT || 1.2);
// Angle still uses this cap. Stage has its own reserved headroom
// (STAGE_HEADROOM) so a saturated angle cannot make the stage a no-op.
// Combined they can exceed 3 — that is deliberate; the remaining no-op
// is a base-score lead larger than STAGE_HEADROOM, which the harness pins.
const BIAS_CAP = Number(process.env.QUOTE_BIAS_CAP || 3);
const ANGLE_WEIGHT = Number(process.env.QUOTE_ANGLE_WEIGHT || 1.5);
// Default = max stage nudge (2 hits × STAGE_WEIGHT 1.2). Env-tunable
// without a deploy; not in defaults.env (this lane does not edit that file).
const STAGE_HEADROOM = Number(process.env.QUOTE_STAGE_HEADROOM || 2.4);
// NO SECOND FLOOR HERE. SCORE_FLOOR (=1) plus hasPositiveSignal already decide
// whether a candidate may take the primary slot, and this file records what
// happens when a filter brings its own lower threshold along: it is a no-op until
// some caller skips the first gate, and then it silently admits what the first
// gate existed to reject. A limp quote is rejected by SCORE_FLOOR; the changes
// above only make the SCORE honest.
// Whether a quote with NO recorded rating may still be used. Per-review stars
// were not captured until recently, so every already-synced product has
// unrated quotes: requiring a rating outright would strip testimonials from
// the entire existing catalog until each product is re-synced. Default keeps
// them and reports the gap; set true once coverage is good.
const QUOTE_REQUIRE_RATING = String(process.env.QUOTE_REQUIRE_RATING || 'false').toLowerCase() === 'true';

// Brand-tier review quotes are catalog-wide (see the isProductScoped guard
// below): on a product-scoped ad they used to be withheld outright, so a
// brand with zero product/category-level reviews rendered no testimonial at
// all even when it had brand reviews to spare. Default ON (owner decision,
// 2026-08-03): let brand quotes serve as a LAST-RESORT fallback on product
// ads — below product, category, AND product-scoped comments — rather than
// showing nothing. Set false to restore the old withhold-entirely behavior
// without a deploy.
const QUOTE_BRAND_TIER_FALLBACK = String(process.env.QUOTE_BRAND_TIER_FALLBACK || 'true').toLowerCase() === 'true';

// Stamp a quote's origin from the parent productReviews container when the
// quote itself has none. Default ON. Measured 2026-08-21: 0 of 20934
// first-party quotes carried their own origin, so json-ld (788 products /
// 18452 quotes) and api:yotpo (149 / 2482) containers carrying
// quotesOrigin:'scraped' all stamped 'unknown' and were dropped as
// unprintable; the brand-tier last-resort then printed a brand quote about
// "two pairs of these" on a t-shirt ad. Uses classifyProductReviewsProvenance
// — the SAME classifier the ratings path already trusts (ratingPairAtomic.js
// :73), so one snapshot can no longer have a trusted rating and untrusted
// quotes. That function is pure and is NOT gated by RATING_PAIR_ATOMIC.
// `||` not `??`, matching the neighbours above: a BLANK value (a cleared
// Render dashboard var) must fall back to the committed default of true, not
// silently revert to the buggy stamp. A deliberate disable is `=false`, which
// works either way. Set false to restore the pre-change stamp (gemini-search
// / q.source==='store' only) with no deploy.
const QUOTE_ORIGIN_FROM_CONTAINER = String(process.env.QUOTE_ORIGIN_FROM_CONTAINER || 'true').toLowerCase() === 'true';

function gateQuotesByRating(candidates, tierName) {
  if (!Array.isArray(candidates) || !candidates.length) return [];
  let rated = 0, dropped = 0, unrated = 0;
  const kept = candidates.filter((q) => {
    if (typeof q?.rating !== 'number' || !Number.isFinite(q.rating)) {
      unrated += 1;
      return !QUOTE_REQUIRE_RATING;
    }
    rated += 1;
    if (toFiveScale(q.rating) >= QUOTE_MIN_RATING) return true;
    dropped += 1;
    return false;
  });
  if (dropped || unrated) {
    console.log(
      `⭐ quote gate[${tierName}] — kept=${kept.length}/${candidates.length} ` +
      `rated=${rated} belowMin=${dropped} unrated=${unrated} ` +
      `(min=${QUOTE_MIN_RATING}, requireRating=${QUOTE_REQUIRE_RATING})`
    );
  }
  return kept;
}

function pickStrongestQuote(candidates, opts = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  // STAR VERDICT BEATS TEXT SENTIMENT. Scraped reviews now carry the
  // reviewer's own rating (productReviewsScrapeService), which is a far
  // better positivity signal than lexical scoring — a calmly-worded
  // 2-star ("the fabric is nice but the frame cracked") can clear a
  // lexical gate, while a 5-star one-liner gets penalized for brevity.
  // When ANY candidate in this tier is star-rated, drop the ones the
  // reviewer themself scored below the bar and let the text scorer choose
  // among what's left. Tiers with no ratings at all (comments, LLM-authored)
  // are unaffected.
  //
  // ONE THRESHOLD, QUOTE_MIN_RATING. This filter arrived with a second,
  // LOWER floor of its own (4 vs the tier gate's 4.5), which was a no-op only
  // for as long as every rated tier happened to pass through
  // gateQuotesByRating first. Any tier that skipped that gate would have
  // silently quoted 4-star reviews on a paid ad.
  const rated = candidates.filter(q => toFiveScale(q?.rating) !== null);
  const pool = rated.length
    ? candidates.filter((q) => {
        const r = toFiveScale(q?.rating);
        return r === null || r >= QUOTE_MIN_RATING;
      })
    : candidates;

  let best = null;
  let bestScore = -Infinity;
  for (const q of pool) {
    if (!q?.text) continue;
    // Small nudge so a 5-star beats a 4.5-star when the prose scores level.
    // Bounded to 0–0.5 by the normalization above; it breaks ties, it does
    // not outrank the text.
    const normalized = toFiveScale(q.rating);
    const starBonus = normalized === null ? 0 : (normalized - QUOTE_MIN_RATING);
    const score = scoreQuote(q.text, opts) + starBonus;
    if (score > bestScore) {
      bestScore = score;
      best = q;
    }
  }
  // PREFERRED TIER: cleared the floor AND reads as praise.
  if (best && bestScore >= SCORE_FLOOR && hasPositiveSignal(best.text)) return best;

  // LAST RESORT — "in the absence of any other social proof, generic praise is better
  // than nothing" (owner, 2026-08-11).
  //
  // SCORE_FLOOR's job is to stop a weak quote winning WHEN A BETTER ONE EXISTS. It was
  // also, silently, deciding that a brand whose pool is nothing but "Love it, great
  // product." gets NO testimonial at all — that line scores -5.5 because generic praise
  // is penalised for being generic, which is correct RANKING and wrong as a veto.
  //
  // This does not reopen the mediocre/negative gate. The candidate must still clear
  // hasPositiveSignal, and everything scoreQuote disqualifies outright stays at
  // -Infinity and is unreachable here: hard limiters, negated positives, and negative
  // sentiment. What gets through is praise that is merely unspecific — which is exactly
  // what the owner said beats an empty slot.
  let fallback = null;
  let fallbackScore = -Infinity;
  for (const q of pool) {
    if (!q?.text) continue;
    const score = scoreQuote(q.text, opts);
    if (!Number.isFinite(score)) continue;          // disqualified stays disqualified
    if (!hasPositiveSignal(q.text)) continue;       // still has to read as praise
    if (score > fallbackScore) { fallbackScore = score; fallback = q; }
  }
  if (fallback) {
    console.log(`   · quote: nothing cleared the quality floor — falling back to the best available praise (score ${fallbackScore.toFixed(1)})`);
  }
  return fallback;
}

// "Does this text express praise" — NOT "does it contain a positive word".
//
// Two conditions, both required:
//   1. At least one positive lexeme, so pure lived-experience narration
//      ("Bought this three weeks ago") is not read as an endorsement.
//   2. No negation of that praise and no complaint, so "Not great, would not
//      buy again" is not read as one either. Testing (1) alone passed that
//      line — "great" is right there in it.
//
// Condition 2 matters most where this is the ONLY gate. scoreQuote applies
// the same two patterns before scoring, so the primary quote slot was already
// safe; the callers that were not are buildProofComments, the comment quote
// pool, and aiCanvasInputBuilder's loadTopComments — every one of them a path
// that renders a social comment on an ad for a client whose only proof IS
// comments.
function hasPositiveSignal(text) {
  const s = String(text || '');
  const hasPositive =
       STRONG_POSITIVE.test(s)
    || MODERATE_POSITIVE.test(s)
    || PHRASE_STRONG.test(s)
    || SENSORY_POSITIVE.test(s);
  // Reset the regex `lastIndex` state since these use the global flag; leaving
  // lastIndex non-zero would break subsequent matches on the next call.
  STRONG_POSITIVE.lastIndex = 0;
  MODERATE_POSITIVE.lastIndex = 0;
  PHRASE_STRONG.lastIndex = 0;
  SENSORY_POSITIVE.lastIndex = 0;
  if (!hasPositive) return false;
  return !NEGATED_POSITIVE.test(s) && !NEGATIVE_SENTIMENT.test(s);
}

/**
 * "Does this text argue against the purchase" — the HARD_LIMITER half of scoreQuote,
 * exposed on its own.
 *
 * scoreQuote folds three different judgements into one number: hard limiters and
 * negativity (absolute disqualifiers) and a length/specificity SCORE (a ranking device
 * for choosing among candidates). A caller shortening an ALREADY-APPROVED quote needs
 * the disqualifiers without the brevity penalty — a 40-character extract of a good
 * quote is short on purpose, and scoring it as if it were competing for selection
 * rejects nearly everything. Exported for exactly that use.
 */
/**
 * clearsQualityFloor(text, opts) → boolean
 *
 * "Would this quote win the primary slot on its own merits?" — i.e. the PREFERRED tier
 * of pickStrongestQuote, without its last-resort fallback.
 *
 * Exported for the render-time rotation, which must never rotate a good quote out in
 * favour of a weaker one. pickStrongestQuote itself is the wrong predicate there: it now
 * answers "is anything printable at all", so it says yes to generic praise, which is
 * correct as a floor and wrong as a rotation candidate.
 */
function clearsQualityFloor(text, opts = {}) {
  const s = String(text || '').trim();
  if (!s) return false;
  return scoreQuote(s, opts) >= SCORE_FLOOR && hasPositiveSignal(s);
}

function hasHardLimiter(text) {
  const s = String(text || '');
  const hit = HARD_LIMITER.test(s);
  HARD_LIMITER.lastIndex = 0;
  return hit;
}

// Social comments rendered as proof go through the SAME pipeline as review
// quotes: positive-sentiment gate, then extractSnippet — the one place a
// quote is shortened, which enforces a self-contained thought on a whole
// word. Comments that carry no praise, or that yield nothing usable, are
// dropped rather than shown half-finished. Nothing downstream shortens
// these again.
async function buildProofComments(topComments, ctx, limit = 3) {
  const rows = Array.isArray(topComments) ? topComments : [];
  if (!rows.length) return [];
  // ONE judgment, made at ingest and shared with every other comment surface.
  // This used to run its own lexical gate and then its own extractSnippet call,
  // which meant this path and the quote-pool path could disagree about whether
  // the same comment counted as praise — and both were deciding on keywords.
  const usable = await usableProofCommentsOrNone(rows, {
    brandId:   ctx.media?.brandId || null,
    // catalogProductId is the hydrated FK; the nested details copy is never
    // written (see :1779), so reading only that attributed every judge call to
    // a null product in the cost ledger.
    productId: ctx.match?.catalogProductId || null
  }, 'proofComments');
  return usable.slice(0, limit).map(c => ({
    text:            c.proofLine,
    author_username: c.authorUsername || c.author || null,
    like_count:      c.likeCount || 0,
    reply_count:     c.replyCount || 0,
    posted_at:       c.postedAt || null
  }));
}

// Normalize a raw quote object from any tier into the shape the
// layout-input artifact expects: { text, author_name, source }.
// A quote an LLM wrote or rewrote is not a first-party review, so it must not
// inherit the first-party defaults below. `origin` is stamped at capture time
// (see docs/REVIEW_VENDORS.md §7): 'scraped' by the review engine, 'llm-web' by
// geminiSearchProvider/categoryReviewsService, 'synthesized' by
// synthesizeQuoteFromReviewSummary. Legacy rows predating the stamp have no
// origin and keep the previous behaviour.
function isFirstPartyQuote(q) {
  return q.origin !== 'llm-web' && q.origin !== 'synthesized';
}

function normalizeQuote(q) {
  if (!q?.text) return null;
  // rating is carried so selection can gate on the reviewer's stars. It was
  // dropped here, which left scoring to judge the wording alone — a low-rated
  // review that reads positively could win the primary slot.
  // null means genuinely unknown (older rows, comments, LLM-authored), never
  // "unrated so assume good". Falls back to the raw schema.org shape for
  // callers that haven't gone through productReviewsScrapeService's own
  // normalization.
  const rating = Number(q.rating ?? q.reviewRating?.ratingValue);
  const firstParty = isFirstPartyQuote(q);
  // Resolved BEFORE the byline, because the byline asserts it.
  const verified = q.verified !== undefined ? q.verified : firstParty;
  return {
    text:        String(q.text).trim(),
    // A REAL name, or nothing at all. Every fallback that used to live here
    // manufactured a person:
    //
    //   q.source     — a SITE, not a human. Measured against production, this
    //                  is where bylines like "Reddit (r/BuyItForLife)",
    //                  "UBeauty.com", "Peloton Apparel" and — 80 times over —
    //                  "vertexaisearch.cloud.google.com" came from. An ad that
    //                  prints a search endpoint as the customer who said the
    //                  words is not a formatting bug, it is a fabricated
    //                  attribution.
    //   'Verified buyer'    — a CLAIM about a purchase, asserted for someone we
    //                  cannot name. 104 live artifacts carry it.
    //   'Anonymous Customer' — reads as a real byline in a serif italic under a
    //                  testimonial, which is exactly how it renders.
    //
    // An unattributed real quote is honest; an attributed fake is not.
    // `verified` and `source` survive below as their own fields for anything
    // that wants to reason about them without printing them as a name.
    //
    // NOT a claim that no surface can still manufacture one: metaCascadeConfig
    // and the Remotion brand scripts hold their own byline defaults, and those
    // are fixed separately. This field simply stops being the place it happens.
    author_name: q.author_name || q.author || undefined,
    source:      q.source || undefined,
    verified,
    // Carried through from the scrape so pickStrongestQuote can gate on
    // the reviewer's own star rating. undefined for tiers that have none.
    rating:      Number.isFinite(rating) ? rating : undefined,
    title:       q.title || undefined,
    // Provenance survives normalisation — otherwise this funnel is exactly
    // where a rewritten line becomes indistinguishable from a real review.
    origin:      q.origin || undefined,
    verbatim:    q.verbatim !== undefined ? q.verbatim : undefined,
    scope:       q.scope || undefined
  };
}

// Shared with assembleInput AND the Director-aligned primary_quote
// pick (pickPrimaryProductQuote). Same origin rules as the closure
// that used to live inside assembleInput — a per-quote stamp wins,
// then container source, then store-import, else unknown.
function stampQuoteOrigins(container, quotes) {
  const containerSource = container?.source || null;
  return (quotes || []).map((q) => {
    let origin = q?.origin || null;
    if (!origin) {
      if (containerSource === 'gemini-search') origin = 'llm-web';
      else if (q?.source === 'store') origin = 'store-import';
      else if (QUOTE_ORIGIN_FROM_CONTAINER) {
        // The container knows its own provenance in `quotesOrigin`, and this
        // function never read it — which is the whole defect. Delegate to the
        // classifier the ratings path already uses so the two halves of one
        // snapshot cannot disagree about whether it is a first-party scrape.
        // ORDER IS LOAD-BEARING: this arm sits AFTER the two above, so it can
        // only ever convert an outcome that was previously 'unknown'. Every
        // other outcome is bit-identical (pinned: verifyQuoteProvenanceStamp
        // B1/B2). Moving it earlier changes gemini-search and store rows.
        const classified = classifyProductReviewsProvenance(container);
        if (classified === 'scraped') origin = 'scraped';
        else if (classified === 'llm-web') origin = 'llm-web';
      }
      // Anything the classifier could not name positively stays unknown, and
      // unknown is not printable. A category-shaped container (`sources`
      // plural, no `source`) still lands here — that fail-closed case is the
      // one the comment above assembleInput was written to guard.
      if (!origin) origin = 'unknown';
    }
    return normalizeQuote({ ...q, origin });
  });
}

function printableQuotes(quotes, tierName) {
  const candidates = (quotes || []).filter(Boolean);
  const kept = candidates.map(toPrintableCustomerQuote).filter(Boolean);
  const dropped = candidates.length - kept.length;
  if (dropped) {
    console.log(`🔒 quote provenance[${tierName}] — ${dropped} quote(s) withheld: origin not printable as a customer testimonial`);
  }
  // A STORED review that cannot print is a bug signal, not an empty pool, and
  // the line above cannot tell those apart — it read the same for 20934
  // quotes whose provenance was simply never looked up. Log-only and NOT
  // flag-gated: this is diagnostics, not behaviour. No alertService and no
  // await — this is a hot render path and stage telemetry here is
  // fire-and-forget by contract.
  if (candidates.length >= 1 && kept.length === 0) {
    const droppedUnknown = candidates.filter((q) => q.origin === 'unknown').length;
    if (droppedUnknown >= 1) {
      console.log(
        `🔒 quote provenance[${tierName}] — provenance-failure: ${droppedUnknown}/${candidates.length} ` +
        `candidate(s) stamped origin=unknown; kept 0 (a stored review that cannot print is a bug, not an absence)`
      );
    }
  }
  return kept;
}

// Stamp the tier a quote came from, without overwriting one already set.
// Module scope (was a closure inside buildQuotePool) so the stage-aware pick
// below ranks quotes carrying the SAME tier the renderer will read.
function stampTier(quotes, tierName) {
  return (quotes || []).filter(Boolean).map((q) => (q.tier ? q : { ...q, tier: tierName }));
}
// Tier pool prep, in ONE place, so pickPrimaryProductQuote ranks exactly the
// pool the renderer prints from. Composition is identical to the nested calls
// this replaced — stampTier ∘ gateQuotesByColourway ∘ gateQuotesByRating ∘
// printableQuotes ∘ stampQuoteOrigins — for product and category.
//
// BRAND also routes through here, which stamps tier one step earlier than
// before; that is neutral and verified, not incidental. selectBrandQuotesForScope
// is tier-blind, and the only .tier reader (applyStrictQuoteScope) treats
// unstamped and 'brand' identically, so the later stampTier(…, 'brand') is an
// idempotent no-op. COMMENT tier does not use this: it skips stampQuoteOrigins.
//
// productTitle is OPTIONAL. Omitted / null → colourway gate is a no-op so
// every existing 3-arg caller stays byte-identical. A real title filters
// colour-describing quotes fail-closed (services/quoteColourway.js).
function gateQuotesByColourway(quotes, productTitle, tierName) {
  if (productTitle == null || !String(productTitle).trim()) return quotes || [];
  const list = quotes || [];
  const kept = [];
  let dropped = 0;
  for (const q of list) {
    if (usableColourwayQuote(q, productTitle)) kept.push(q);
    else dropped++;
  }
  if (dropped) {
    console.log(
      `🔒 quote colourway[${tierName || '?'}] — ${dropped} quote(s) withheld: ` +
      `colour language does not match product colourway`
    );
  }
  return kept;
}

function prepareQuotePool(container, quotes, tierName, productTitle) {
  return stampTier(
    gateQuotesByColourway(
      gateQuotesByRating(printableQuotes(stampQuoteOrigins(container, quotes), tierName), tierName),
      productTitle,
      tierName
    ),
    tierName
  );
}

// Render's product-tier winner: productReviews.quotes → stamp →
// printable → star gate → pickStrongestQuote. Director alignment
// (DIRECTOR_QUOTE_POOL_ALIGNED) calls this so both paths rank the
// same pool. opts is the same shape assembleInput hands the scorer.
function pickPrimaryProductQuote(productReviews, opts = {}) {
  if (!productReviews || !Array.isArray(productReviews.quotes) || !productReviews.quotes.length) {
    return null;
  }
  return pickStrongestQuote(
    prepareQuotePool(productReviews, productReviews.quotes, 'product', opts.productTitle),
    opts
  );
}

// Load brand-scoped Instagram/TikTok comments as quote-pool candidates.
// Comments are ranked by likeCount desc then recency; filtered to a
// reasonable length window (skip "🔥"-only replies and walls of text).
// Returns an array of already-normalized quote objects — safe to
// concatenate directly into the pool without a further normalizeQuote pass.
async function loadBrandCommentsForQuotePool(ctx) {
  try {
    const brandId = ctx.media?.brandId || null;
    if (!brandId) return [];

    // PRODUCT-SCOPED on a product ad. The review tiers already withhold
    // brand-level quotes here (see tierBrand) because a brand-wide review is
    // about whatever the reviewer bought, which on a multi-SKU brand is usually
    // NOT this product — a leggings review under a tee photo. Comments had no
    // such guard: this queried by brandId alone, so the most-liked comment on
    // ANY of the brand's posts could become this product's testimonial.
    //
    // Rather than withhold the tier outright — comments are the only proof some
    // clients have — narrow it to comments left on media that actually matched
    // THIS product. Those are comments about this item. A brand ad claims no
    // single product, so brand-wide is correct there.
    const scopeProductId = ctx.match?.catalogProductId || null;
    const scope = { brandId };
    if (scopeProductId) {
      const pmas = await ProductMatchArtifact
        .find({ catalogProductId: scopeProductId, outcome: 'product_match' })
        .select('mediaId')
        .limit(200)
        .lean();
      const mediaIds = pmas.map(p => p.mediaId).filter(Boolean);
      if (!mediaIds.length) {
        console.log(`🔒 comment quote pool — no product-matched media for ${scopeProductId}, comment tier empty on this product ad`);
        return [];
      }
      scope.mediaId = { $in: mediaIds };
    }

    // BOUNDED. This was an unlimited find over every comment the brand has
    // ever received. Feeding that to the judge in one batch would overrun the
    // token budget on a chatty brand, truncate the response, and fail the ad.
    // Like-sorted first so the cap keeps the best candidates.
    const comments = await Comment.find(scope)
      .sort({ likeCount: -1, postedAt: -1 })
      .limit(60)
      .select('text authorUsername likeCount postedAt createdAt proofJudgment')
      .lean();

    // JUDGED BEFORE THE LIKE SORT, not after. Comments are the fallback proof
    // tier for a client with no star-rated reviews at all, so this is the only
    // gate between a brand's comment section and its ads — and ranking by
    // likes first would let ten popular neutral comments crowd out the
    // genuinely good one sitting at #11, emptying a tier that had usable
    // praise in it.
    //
    // The verdict comes from the ingest judge (inference over the whole
    // sentence), not from a keyword test, and it is shared with every other
    // surface that renders a comment. It also matters that this runs on the
    // whole pool rather than just the winner: pickStrongestQuote only protects
    // the PRIMARY slot, and everything else here flows into secondary_quotes
    // for the renderer to rotate through.
    const usable = await usableProofCommentsOrNone(comments, { brandId }, 'quotePool');
    const filtered = usable.filter(c => {
      const t = String(c.proofLine || '').trim();
      return t.length >= 20 && t.length <= 300;
    });

    filtered.sort((a, b) => {
      const la = a.likeCount ?? 0;
      const lb = b.likeCount ?? 0;
      if (la !== lb) return lb - la;
      const ta = a.postedAt || a.createdAt || 0;
      const tb = b.postedAt || b.createdAt || 0;
      return new Date(tb).getTime() - new Date(ta).getTime();
    });

    // proofLine, never c.text: the judged, ad-ready form is the processed
    // artifact. Passing the raw comment on would re-open the door to a
    // downstream surface shortening it a second time, or rendering the part
    // the judge did not approve.
    return filtered.slice(0, 10).map(c => normalizeQuote({
      text:        c.proofLine,
      // The commenter's real handle or no byline. "Instagram commenter" named
      // nobody — same manufactured attribution as the "Verified buyer" default
      // normalizeQuote used to apply.
      author_name: c.authorUsername || undefined,
      source:      'social_comment',
      // POSITIVE provenance stamp, and it is deliberately `origin` rather than
      // `source`. DERIVATION_SCHEMA declares a `source` property and the
      // derivation call is strict:false, so the LLM persona tier can emit any
      // `source` string it likes — including this one. It cannot emit `origin`,
      // because nothing downstream of the schema ever sets it. A consumer
      // allowlist keyed on origin therefore cannot be forged from the LLM path.
      origin:      'social_comment',
      verbatim:    true,   // proofLine is the ingest judge's contiguous extract
      verified:    false
    })).filter(Boolean);
  } catch (err) {
    console.warn(`quotePool: comment tier load failed (${err.message})`);
    return [];
  }
}

// Load categoryReviews for the ad's matched category. Uses the same
// Category-collection first, categoryRef-then-categoryId fallback
// that categoryReviewsService uses. Returns { quotes: [], ... } or
// null on miss. Best-effort — never throws.
async function loadCategoryReviewsForMatch(match) {
  try {
    const categoryRef =
      match?.identification?.details?.categoryRef ||
      match?.categoryId ||
      null;
    if (!categoryRef) return null;
    const cat = await Category.findById(categoryRef).select('categoryReviews').lean();
    return cat?.categoryReviews || null;
  } catch {
    return null;
  }
}

// synthesizeQuoteFromReviewSummary was DELETED on 2026-07-31, not disabled.
//
// It took the first sentence of `reviewSummary.summary` — LLM-written prose
// ABOUT the reviews — and returned it shaped as a customer quote, stamped
// origin:'synthesized', verbatim:false by the author who knew exactly what it
// was. Its own comment said the text "must never be stored or rendered as one",
// and the tier-6 fallback then stored and rendered it. It is removed rather
// than kill-switched because this repo has been bitten repeatedly by retired
// paths left in place (see CLAUDE.md §0/§1), and a function that manufactures
// proof is the last one that should be sitting around waiting to be re-called.

// Rating/review-driven badge defaults when the LLM returned none. Fills the
// badge_row / product.badges / social_proof.proof_badges slots that
// otherwise render as placeholders.
//
// FIXED 2026-08-19 (compliance): 'Top rated' used to append on
// `rating >= 4.5` alone, with no floor on HOW MANY reviews backed that
// rating — a 4.5 from a single review passed exactly as readily as a 4.5
// from ten thousand. Now requires the SAME minimum sample size
// (SAMPLE_FLOOR, from claimSubstantiationService) the render-time gate
// requires for any "top rated"-class claim, so this deterministic path
// can never assert something the gate would strip from an LLM-authored
// badge anyway. This is belt-and-suspenders, not the enforcement point:
// buildMetaForAd's gate re-checks every badge regardless of origin.
function defaultBadgesFromSignal(details) {
  const out = [];
  if (typeof details.rating === 'number' && details.rating >= RATING_CLAIM_MIN
    && typeof details.reviewCount === 'number' && details.reviewCount >= SAMPLE_FLOOR) out.push('Top rated');
  if (typeof details.reviewCount === 'number') {
    if (details.reviewCount >= 10000) out.push('10k+ reviews');
    else if (details.reviewCount >= 1000) out.push('1k+ reviews');
    else if (details.reviewCount >= 100)  out.push('100+ reviews');
  }
  return out;
}

// headline is NEVER a template. It used to be a "Meet <productName>" /
// "See why customers love it" literal — banned by
// owner directive: "I don't want any templated video headlines, they
// should all be on brand and sound natural" + "Let's let the director make
// the call, it knows what the goal is and what the intent is and it has a
// lot to choose from." headline now comes from resolveVideoHeadline
// (services/videoHeadlineService.js): a SELECTION among copy an EXISTING
// CreativeDirectionArtifact round already wrote for this (brand, product,
// campaignKind), picked for fit against this video's per-format character
// budget. It is read-only — it never calls the Director LLM, so a
// video-only run with no prior round costs nothing extra here — and it
// resolves to null when no round exists or nothing fits, on any lookup
// failure, and on any unexpected error (resolveVideoHeadline never
// throws).
//
// A null copy.headline here is NOT the end of the line: assembleInput's
// `stripEmpty` drops the empty key from input.copy, and
// metaCascadeConfig's `headline` cascade (services/metaCascadeConfig.js
// ~44-48) falls through ad.copy.headline -> input.copy.headline ->
// Brand.tagline before the slot has nothing left to bind — Brand.tagline
// is a real, on-brand string, not a template. Only when that is ALSO
// unset does the headline slot resolve to no content, which
// remotion/lib/slotContent.js + remotion/compositions/Canonical.jsx render
// as an omitted slot (see this lane's report for the confirmed-safe
// null-path trace through Canonical.jsx).
async function fallbackDerivation(ctx, aspectRatio, options = {}) {
  const ident = ctx.match?.identification || {};
  const headline = await resolveVideoHeadline({
    brandId:      ctx.media?.brandId || null,
    productId:    options?.productId    || null,
    campaignKind: options?.campaignKind || null,
    aspectRatio
  });
  return {
    quotes: [],
    short_benefits: [],
    badges: [],
    copy: {
      headline,
      subheadline:    '',
      eyebrow:        ident.brand || '',
      highlight_text: ''
    },
    cta: { text: 'Shop now' },
    trusted_by_text:  '',
    tone: [],
    theme_style:      'clean',
    background_style: 'soft-blur',
    emphasis:         'product-first'
  };
}

// ──────────────────────────────────────────────────────────────
//  Canonical assembly
// ──────────────────────────────────────────────────────────────
// Compose a structured offer payload for the renderer's visual pill
// overlay. label is the short text (max ~24 chars to fit a corner
// badge); urgency is an optional second-line countdown that fires when
// the relevant end/draw date is within 7 days. kind drives optional
// renderer style hints. Returns null when the campaign isn't
// promotional or no label can be derived — the renderer presence-
// checks before painting the pill so this stays a clean opt-out.
function deriveCampaignOffer(campaignKind, promo, raffleCtx) {
  if (campaignKind !== 'promotional' || !promo) return null;

  let label = null;
  let kind  = null;
  switch (promo.discountType) {
    case 'percent':
      if (promo.discountValue != null) { label = `${promo.discountValue}% OFF`; kind = 'discount'; }
      break;
    case 'amount':
      if (promo.discountValue != null) { label = `$${promo.discountValue} OFF`; kind = 'discount'; }
      break;
    case 'bogo':         label = 'BOGO';                  kind = 'discount'; break;
    case 'bundle':       label = 'BUNDLE SAVINGS';        kind = 'discount'; break;
    case 'free_shipping': label = 'FREE SHIPPING';        kind = 'discount'; break;
    case 'gift':
      label = (promo.giveaway && String(promo.giveaway).trim())
        ? truncateToBudget(`FREE: ${String(promo.giveaway).trim().toUpperCase()}`, 24)
        : 'FREE GIFT';
      kind = 'giveaway';
      break;
    case 'raffle': {
      // Prize-first framing — operator's prize description if present,
      // otherwise a generic "ENTER TO WIN". The numeric entries-per-$
      // rides in the urgency line below since the pill stays a short
      // hook rather than a stat readout.
      const prize = (promo.rafflePrize || raffleCtx?.prizeDescription || '').trim();
      label = prize ? truncateToBudget(`WIN: ${prize.toUpperCase()}`, 24) : 'ENTER TO WIN';
      kind  = 'raffle';
      break;
    }
    default: break;
  }
  if (!label) return null;

  // Urgency — drawing date for raffle, end date otherwise. Fires when
  // the date is within 7 days; below that threshold the label alone
  // carries the offer.
  const dateRaw = (promo.discountType === 'raffle')
    ? (promo.raffleDrawDate || raffleCtx?.drawDate || promo.endsAt || null)
    : (promo.endsAt || null);
  let urgency = null;
  if (dateRaw) {
    const ms = new Date(dateRaw).getTime();
    if (Number.isFinite(ms)) {
      const days = Math.ceil((ms - Date.now()) / 86400000);
      if (days > 0 && days <= 7) {
        const word = promo.discountType === 'raffle' ? 'DRAWING' : 'ENDS';
        urgency = days === 1 ? `${word} TOMORROW` : `${days} DAYS LEFT`;
      } else if (days === 0) {
        // Same-day urgency — fires until the actual end-of-day passes.
        urgency = promo.discountType === 'raffle' ? 'DRAWING TODAY' : 'ENDS TODAY';
      }
    }
  }

  // Add the entry rate to raffle pills' urgency line when no countdown
  // is active — it's a useful secondary stat the operator would
  // otherwise lose to the visual.
  if (kind === 'raffle' && !urgency) {
    const epd = Number(promo.raffleEntriesPerDollar) || 0;
    if (epd > 0) urgency = `${epd} ENTR${epd === 1 ? 'Y' : 'IES'} / $1`;
  }

  return { label, urgency, kind };
}

// Trim text to a max-char budget at the last word boundary. Returns
// the original text when it already fits. Used to enforce eyebrow_rules
// max_chars on brand.tagline fallbacks — without this, a long tagline
// (e.g. "Restored and Modified, Better than New") spills past the
// hairline rules and looks broken in the rendered ad.
function truncateToBudget(text, maxChars) {
  if (!text || typeof text !== 'string') return text;
  if (typeof maxChars !== 'number' || maxChars <= 0) return text;
  if (text.length <= maxChars) return text;
  // Cut at the last whitespace that fits, drop trailing punctuation.
  const slice = text.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > Math.floor(maxChars * 0.6) ? slice.slice(0, lastSpace) : slice;
  return cut.replace(/[\s,.;:–—-]+$/, '');
}

async function assembleInput(ctx, template, aspectRatio, options, derivation, precomputedPlacement) {
  const { media, detection, match, brand } = ctx;
  const ident   = match?.identification || {};
  const details = ident.details || {};
  // Slot budgets — used to enforce per-zone caps on resolved copy
  // fields. Today this only enforces eyebrow_rules max_chars on the
  // subheadline fallback; headline path enforces caps inside the
  // derivation prompt itself.
  const canvasVariantForBudgets = registry.CANVAS.templates?.[template]?.variants?.[aspectRatio] || null;
  const slotBudgets = canvasVariantForBudgets ? computeSlotBudgets(canvasVariantForBudgets) : {};
  const eyebrowMaxChars = slotBudgets.eyebrow?.max_chars || null;
  // product_image variant uses the catalog product directly as the
  // visual + content source. Suppress UGC-only blocks (creator,
  // ugc, performance.engagement) so the renderer doesn't pull
  // creator handles, post captions, or social signals that don't
  // exist for a catalog hero shot.
  const isProductImage = options.variantKind === 'product_image';
  // Raffle inversion — for raffle campaigns, the prize is the visual
  // anchor of every ad. ctx.raffle is set by loadContext when the
  // campaign is promotional + discountType=raffle + has a prize media
  // selected. Overrides the normal hero source (UGC media or catalog
  // product image) and the scene/palette context.
  const isRaffle = !!ctx.raffle;
  // Palette + scene context come from the SOURCE of the hero. For
  // UGC variants that's the post's own detection; for product_image
  // variants the hero is the catalog product, so we read its
  // detection (hydrated onto ctx.productHero in loadContext). Before
  // this branch, both variants read from `detection` (the UGC post
  // detection) which produced wrong-color backgrounds on catalog-
  // hero ads (green-jar variants showing UGC-scene colors).
  // For raffle, palette/scene come from the prize media.
  const sceneBackground = isRaffle
    ? (ctx.raffle.prizeDetection?.background || detection?.background || null)
    : isProductImage
      ? (ctx.productHero?.background || detection?.background || null)
      : (detection?.background || null);
  const palette = sceneBackground?.palette || [];

  // Hero source crop matches the MEDIA SLOT'S ratio (not the canvas
  // ratio). For split-panel layouts the image slot is half-canvas
  // (1:1 canvas → 500×1000 → 1:2 slot) which differs significantly
  // from the canvas ratio — sourcing the canvas-matched crop forces
  // Cloudinary to do a heavy second crop and lose subject framing.
  // Picking the closest available source ratio (9:16 for a 1:2 slot)
  // gives Cloudinary the right framing to start from. Falls back to
  // canvas ratio when the canvas variant or its media zone can't be
  // resolved.
  const canvasVariantForHero = registry.CANVAS.templates?.[template]?.variants?.[aspectRatio] || null;
  const heroSourceRatio = pickHeroSourceRatio(canvasVariantForHero) || aspectRatio;
  // Hero override for raffle — prize Media wins regardless of variant
  // kind. Uses the prize's smart crops when detect ran on it; falls
  // back to the raw fileUrl otherwise.
  const heroMedia      = isRaffle
    ? pickRafflePrizeMedia(ctx.raffle, heroSourceRatio)
    : pickHeroMedia(ctx, heroSourceRatio);
  const secondaryMedia = pickSecondaryMedia(ctx, aspectRatio);
  const creatorMedia   = pickCreatorMedia(ctx);
  const ugcMedia       = creatorMedia;  // detect uploads == creator post asset

  // Quote selection — 6-tier priority with universal scorer inside
  // each tier so the STRONGEST candidate wins primary, not just the
  // first one. See scoreQuote() for the heuristic.
  //
  //   Tier 1: productReviews.quotes[]         (SKU-specific, highest trust)
  //   Tier 2: category.categoryReviews.quotes (same category on this brand)
  //   Tier 3: brand.brandReviews.quotes[]     (brand-level, always available)
  //   Tier 4: brand-scoped social comments    (Instagram / TikTok, real user language)
  //
  // There is no tier 5 or 6. Both were LLM-authored — notional persona reviews
  // and a sentence lifted from an LLM summary — and both are removed below
  // rather than demoted, because a fabricated quote is not a weaker quote.
  //
  // First non-empty tier's best-scoring quote wins the primary slot.
  // Everything else across all tiers goes to secondary_quotes so the
  // renderer can rotate through them.
  // Provenance is stamped HERE, from the container the quotes arrived in,
  // because this is the last point at which it is known. Every review document
  // in production carries `source` on the container ('gemini-search' or, for
  // older store imports, null) and nothing carries an origin stamp — measured,
  // not assumed: 0 of 1073 products and 0 of 74 categories had one. So the
  // stamps that normalizeQuote faithfully carries through were always empty,
  // and every gate built on them was inert.
  // POSITIVE identification on both sides. The first cut of this said "anything
  // that is not 'gemini-search' is a store import", which is a denylist wearing
  // an allowlist's clothes — and it had exactly the hole denylists always have:
  // categoryReviewsService writes `sources` (plural, a list of domains) and no
  // `source` at all, so every legacy category row — LLM web-search output —
  // would have been stamped 'store-import' and printed as a customer quote.
  //
  // So: name what a thing IS, and call everything else unknown. An unknown
  // origin is not printable, which is the correct answer for provenance we
  // cannot establish.
  // stampQuoteOrigins / printableQuotes / stampTier / prepareQuotePool live at
  // MODULE scope (they were closures here) so the Director-aligned pick
  // (pickPrimaryProductQuote) ranks the SAME product-tier pool the renderer
  // prints from. One definition each — two copies of the provenance stamp is
  // how the pick and the print silently disagree about which quote won.
  const productReviewsForMatch = productReviewsOf(ctx.match);
  // Colourway is a SKU check. Brand / media-library ads have no
  // product colourway; ident.productName is a noun-scope label and
  // must not fail-closed colour-describing quotes on those ads.
  const colourwayTitle = (options && options.productId)
    ? (details.title || ident.productName || null)
    : null;
  const tierProduct = prepareQuotePool(productReviewsForMatch, productReviewsForMatch?.quotes, 'product', colourwayTitle);
  const catReviewsForMatch = await loadCategoryReviewsForMatch(ctx.match);
  const tierCategory = prepareQuotePool(catReviewsForMatch, catReviewsForMatch?.quotes, 'category', colourwayTitle);
  // Brand-tier reviews are catalog-wide: they are about whatever the reviewer
  // bought, which on a multi-SKU brand is usually NOT this product. Rendering
  // one under this product's photo presents another item's praise as if it
  // were about this one — a leggings review as the testimonial on a tee ad.
  // Brand reviews therefore only back a BRAND ad outright — on a product ad
  // they are demoted to a LAST-RESORT fallback (QUOTE_BRAND_TIER_FALLBACK,
  // default on): they may still win, but only when product, category, AND
  // product-scoped comments all yielded nothing, so a brand with zero
  // product-level proof isn't left with no testimonial at all. Set the flag
  // false to restore the pre-2026-08-03 behavior of withholding brand quotes
  // from product ads entirely, without a deploy.
  // catalogProductId is the FK on ProductMatchArtifact (:78) and is what the
  // rest of this file tests product scope with (:653, :1850). The nested
  // identification.details.catalogProductId is NOT hydrated —
  // productMatchHydration rebuilds that object from the CatalogProduct's
  // commerce fields and never writes an id onto it — so reading it here would
  // have left isProductScoped false on real product ads and leaked the brand
  // quotes this guard exists to demote.
  const isProductScoped = !!(ctx.match?.catalogProductId || ctx.match?.identification?.details?.catalogProductId);
  const brandReviewsContainer = ctx.match?.brandReviews || ctx.brand?.brandReviews || null;
  const brandQuotesRaw = (brandReviewsContainer?.quotes || []);
  // Withhold entirely only when this IS a product ad AND the fallback flag is
  // off (the old behavior, kept as the revert path). Otherwise brand quotes
  // go through the SAME gates as every other tier — stampQuoteOrigins →
  // printableQuotes (toPrintableCustomerQuote) → gateQuotesByRating — no second
  // allowlist. Ranking (last-resort on product ads vs. legitimate top-tier
  // proof on brand ads) is enforced below, at pick time, not by hiding the
  // pool here.
  // STRICT is media-driven only (owner 2026-08-12). Product-attached ads
  // keep QUOTE_BRAND_TIER_FALLBACK last-resort — do not empty the pool.
  const withholdBrandOnProductAd = isProductScoped && !QUOTE_BRAND_TIER_FALLBACK;
  const tierBrandUnscoped = withholdBrandOnProductAd
    ? []
    : prepareQuotePool(brandReviewsContainer, brandQuotesRaw, 'brand', colourwayTitle);
  // Noun-scope the brand pool ONLY when this run has no CatalogProduct
  // attached (options.productId). A PMA catalogProductId is not that —
  // media-driven ads often carry a product_match PMA (the Vuori case)
  // and must still be noun-checked. Flag-off is an identity.
  const tierBrand = stampTier(selectBrandQuotesForScope(tierBrandUnscoped, {
    productAttached: !!(options && options.productId),
    productTitle: details.title || ident.productName || null,
    media,
    match: ctx.match
  }), 'brand');
  if (withholdBrandOnProductAd && brandQuotesRaw.length) {
    console.log(`🔒 quote scope — ${brandQuotesRaw.length} brand-tier quote(s) withheld from a product ad (cross-product risk; QUOTE_BRAND_TIER_FALLBACK=false)`);
  } else if (isProductScoped && brandQuotesRaw.length) {
    console.log(`🔓 quote scope — ${brandQuotesRaw.length} brand-tier quote(s) demoted to last-resort on a product ad (cross-product risk; wins only if product/category/comment tiers are empty)`);
  } else if (!isProductScoped && tierBrandUnscoped.length !== tierBrand.length) {
    console.log(
      `🔒 quote provenance[strict] — withheld ${tierBrandUnscoped.length - tierBrand.length} brand-tier quote(s) ` +
      `that named a product type missing from the seed labels (${tierBrand.length} remain)`
    );
  }
  const tierComment  = stampTier(
    gateQuotesByColourway(
      printableQuotes(await loadBrandCommentsForQuotePool(ctx), 'comment'),
      colourwayTitle,
      'comment'
    ),
    'comment'
  );

  // TIERS 5 AND 6 ARE GONE, and they are not coming back behind a flag.
  //
  // Tier 5 was `derivation.quotes` — the LLM's own output. The prompt that
  // produces it (:1180) asks in as many words for "NOTIONAL persona-authored
  // reviews", with "author_name is the persona's name". That is an invented
  // person saying an invented sentence, and it was eligible to win the primary
  // quote slot and be typeset into a paid advertisement as a customer
  // testimonial. Tier 6 was synthesizeQuoteFromReviewSummary, the first
  // sentence of LLM prose ABOUT the reviews, stamped verbatim:false by the
  // function that built it.
  //
  // Neither is proof. The owner's rule is that an absent field renders as
  // absent — the intent module states missing proof as an explicit prohibition
  // ("this ad has NO customer quote"), so losing this slot degrades correctly
  // instead of leaving a hole. An ad with no testimonial is a thinner ad; an ad
  // with a fabricated one is a lie in the pixels.
  const llmQuoteCount = Array.isArray(derivation.quotes) ? derivation.quotes.length : 0;
  if (llmQuoteCount) {
    console.log(`🔒 quote pool — ${llmQuoteCount} LLM-authored quote(s) withheld: notional personas are not customer proof`);
  }

  // Funnel stage and Director angle come from the caller (options).
  // QUOTE_STAGE_AWARE (default false) is the gate: flag-off quoteOpts
  // are empty so STAGE_TERMS stay inert even if a caller threads
  // funnelStage. Flag-on applies the already-built scorer on a FRESH
  // assemble. Cached artifacts still share one primary_quote; the
  // paid printers re-pick via applyStagedQuotePick. Owner: "the quote
  // selection should be influenced by the director and the position
  // in the funnel".
  const quoteOpts = quoteOptsFromOptions(options);
  if (quoteOpts.stage || quoteOpts.angleTerms) {
    console.log(`📐 quote bias[media=${media._id}] stage=${quoteOpts.stage || '-'} ` +
      `angle=${quoteOpts.angleTerms ? quoteOpts.angleTerms.join('|') : '-'}`);
  }
  const pickedProduct  = pickStrongestQuote(tierProduct, quoteOpts);
  const pickedCategory = pickedProduct ? null : pickStrongestQuote(tierCategory, quoteOpts);
  // Precedence forks here on ad type, and ONLY here:
  //
  // - Product ad (isProductScoped): product -> category -> comment -> brand.
  //   Brand is dead last — comment outranks it — because comment quotes are
  //   already product-scoped (loadBrandCommentsForQuotePool) while brand
  //   quotes are catalog-wide cross-product risk. Brand only wins when
  //   product, category, AND comment all yielded nothing.
  // - Brand ad (!isProductScoped): product -> category -> brand -> comment,
  //   UNCHANGED from before this change. No product is being claimed, so a
  //   brand-tier review is legitimate top-tier proof and still outranks a
  //   comment, same as it always has.
  let pickedBrand;
  let pickedComment;
  if (isProductScoped) {
    pickedComment = (pickedProduct || pickedCategory) ? null : pickStrongestQuote(tierComment, quoteOpts);
    pickedBrand   = (pickedProduct || pickedCategory || pickedComment) ? null : pickStrongestQuote(tierBrand, quoteOpts);
  } else {
    pickedBrand   = (pickedProduct || pickedCategory) ? null : pickStrongestQuote(tierBrand, quoteOpts);
    pickedComment = (pickedProduct || pickedCategory || pickedBrand) ? null : pickStrongestQuote(tierComment, quoteOpts);
  }
  let primaryQuote = pickedProduct || pickedCategory || pickedBrand || pickedComment || null;
  const quoteTier = pickedProduct  ? 'product'
                  : pickedCategory ? 'category'
                  : pickedBrand    ? 'brand'
                  : pickedComment  ? 'comment'
                  :                  null;
  // This decision must stay visible in Render logs: brand tier winning a
  // primary slot on a product ad is the fallback actually firing, not just
  // being available. (Brand winning on a brand ad is the long-standing,
  // unchanged path and isn't logged here.)
  if (isProductScoped && quoteTier === 'brand') {
    console.log(`🔓 quote scope — brand-tier quote WON as last-resort fallback on product ad (media=${media._id})`);
  }

  // The synth fallback that used to sit here is gone with tier 6. It existed to
  // keep hero zones populated; an empty zone is the correct rendering of proof
  // we do not have.
  //
  // The tier is STAMPED onto the quote, not merely logged. It was computed
  // right here, printed to stdout at the line below, and then dropped — so the
  // artifact recorded no provenance at all and every consumer had to guess.
  // Persisting it is what makes a render-time gate possible.
  if (primaryQuote) primaryQuote.tier = quoteTier;

  // Snippet extraction — a ≤50-char punchy version of the winning quote,
  // for the 3-second proof overlay in the vertical DR video template.
  // Extractive; falls back to mechanical word-boundary truncation if the
  // LLM is unavailable or returns something non-verbatim.
  if (primaryQuote) {
    const snippet = await extractSnippet(primaryQuote.text, {
      brandId:   ctx.media?.brandId || null,
      productId: ctx.match?.catalogProductId || null
    });
    // Always populate, even when it equals the source. `snippet` means "the
    // <=50-char, word-safe form of this quote", which for an already-short
    // quote IS the quote. Setting it only when it DIFFERED left the field
    // absent for every short quote, so a layout binding
    // social_proof.primary_quote.snippet rendered an empty proof element
    // precisely when the quote needed no shortening.
    if (snippet) primaryQuote.snippet = snippet;
  }

  // Social comments used as proof go through the same gate + snippet path.
  const proofComments = await buildProofComments(ctx.topComments, ctx);

  // Observability — show tier counts + which tier won so a bad
  // primary_quote is diagnosable from Render logs without a DB query.
  console.log(
    `📐 quote pool[media=${media._id}] ` +
    `product=${tierProduct.length} category=${tierCategory.length} ` +
    `brand=${tierBrand.length} comment=${tierComment.length} llm-withheld=${llmQuoteCount} ` +
    `→ winner=${quoteTier || 'none'}${primaryQuote ? ` "${(primaryQuote.snippet || primaryQuote.text).slice(0, 60)}${(primaryQuote.snippet || primaryQuote.text).length > 60 ? '…' : ''}"` : ''}`
  );

  // Secondaries: every other quote from every SURVIVING tier, minus the primary.
  // Every tier feeding this is gated before it gets here — the review-backed
  // ones on the reviewer's own stars (gateQuotesByRating), the comment tier on
  // sentiment. That matters because secondary_quotes is rendered by rotation, so
  // anything in this array can reach an ad without pickStrongestQuote ever
  // having judged it — which is precisely why the LLM tier must not be here
  // either. Excluding it from the primary slot while leaving it in the rotation
  // pool would have moved the fabricated quote rather than removed it.
  const allQuotes = [...tierProduct, ...tierCategory, ...tierBrand, ...tierComment];
  const others = primaryQuote
    ? allQuotes.filter(q => q.text !== primaryQuote.text)
    : allQuotes;
  // Same-tier first so the 16-cap cannot evict the rotation pool in
  // favour of a high-scoring other-tier line. Mixed-tier dump is what
  // turned the 10→30 storage raise into a 3× artifact.
  const sameTier = primaryQuote
    ? others.filter(q => (q.tier || null) === (primaryQuote.tier || quoteTier || null))
    : others;
  const otherTier = primaryQuote
    ? others.filter(q => (q.tier || null) !== (primaryQuote.tier || quoteTier || null))
    : [];
  const secondaryQuotes = [...sameTier, ...otherTier]
    .slice(0, MAX_LAYOUT_SECONDARY_QUOTES)
    .map(q => ({ ...q }));

  const rightsApproved = !!media.rights?.approved;
  const brandName = ident.brand || media.metadata?.brand || brand?.name || null;

  // Badge set assembly. Take LLM-emitted badges if any, then supplement with
  // rating/review defaults to ensure badge_row / engagement_row zones have
  // at least ~2 items. Dedupe case-insensitively so we don't repeat a
  // "Top rated" the LLM already wrote.
  const llmBadges = Array.isArray(derivation.badges) ? derivation.badges.filter(Boolean) : [];
  const defaultBadges = defaultBadgesFromSignal(details);
  const seenBadges = new Set(llmBadges.map(b => String(b).toLowerCase()));
  const derivedBadges = [...llmBadges];
  for (const b of defaultBadges) {
    if (derivedBadges.length >= 4) break;
    if (!seenBadges.has(b.toLowerCase())) {
      derivedBadges.push(b);
      seenBadges.add(b.toLowerCase());
    }
  }

  const input = {
    template,
    aspect_ratio: aspectRatio,

    theme: {
      style:            derivation.theme_style      || 'clean',
      background_style: derivation.background_style || 'soft-blur',
      emphasis:         derivation.emphasis         || 'product-first'
    },

    brand: {
      name:            brandName,
      tagline:         brand?.tagline || undefined,
      logo:            brand?.logoUrl || undefined,
      primary_color:   brand?.primaryColor   || palette[0] || undefined,
      secondary_color: brand?.secondaryColor || palette[1] || undefined,
      accent_color:    brand?.accentColor    || palette[2] || undefined,
      font_family:     brand?.fontFamily || undefined,
      tone:            (brand?.tone?.length ? brand.tone : derivation.tone) || undefined
    },

    product: {
      id:            details.productId || undefined,
      // Catalog-first naming chain:
      //   details.title (CatalogProduct.title, hydrated)  — when linked
      //   ident.productName (matcher's per-post output)   — when no link
      //   brandName                                       — brand_match
      //                                                     fallback so
      //                                                     product_meta
      //                                                     renders the
      //                                                     brand name
      //                                                     instead of a
      //                                                     literal
      //                                                     placeholder
      //   'Product'                                       — last resort
      //                                                     (no catalog,
      //                                                     no model, no
      //                                                     brand)
      // Templates with product_meta in required_all_of stay valid for
      // brand_match because a meaningful name is always present.
      // Strip promo cruft ("Subscribe and Save", "30% Off applied",
      // empty parens, stranded separators) at render time so the
      // catalog row's stored title can keep the promo phrasing for
      // the brand's shop without bleeding into the ad's product_meta.
      // Catalog rows often arrive as e.g. "Hot Crispy Oil - Original
      // Subscribe and Save 30% Off applied at checkout" — 67 chars
      // that overflow the product_card in narrow zones (9:16, 1:1
      // stacked). Display-normalize trims that to "Hot Crispy Oil -
      // Original".
      name:          displayNormalizeTitle(
                       (match?.catalogProductId
                          ? (details.title || ident.productName)
                          : (ident.productName || details.title))
                       || brandName
                       || 'Product'
                     ) || brandName || 'Product',
      // Catalog-first: when a CatalogProduct is linked, its category
      // (Meta's catalog taxonomy via details.category) is authoritative.
      // For unlinked / brand_match outcomes, fall back to the source
      // Media's per-post category tag, then YOLO's coarse class.
      category:      (match?.catalogProductId
                        ? (details.category || media.metadata?.category || firstYoloCategory(detection))
                        : (media.metadata?.category || firstYoloCategory(detection) || details.category))
                     || undefined,
      price:         details.price?.value ?? details.price?.display ?? undefined,
      currency:      details.price?.currency || undefined,
      description:   details.description || detection?.primarySubjectDesc || undefined,
      short_benefits: limitArray(derivation.short_benefits, 5),
      badges:         limitArray(derivedBadges, 4),
      hero_media:      mediaPair(heroMedia),
      secondary_media: mediaPair(secondaryMedia),
      // Catalog product image (legacy single-shot path). When the
      // wizard threaded a productId (every ad-render does), prefer the
      // JUDGE-CROPPED catalog product_only shot for the heroSourceRatio
      // over the raw CatalogProduct.imageUrl. Falls back through hero
      // crop → raw URL. Kept for templates that bind to product.image
      // directly; new templates should prefer the explicit
      // lifestyle_image / product_image paths below.
      image:           pickProductImage(ctx, heroSourceRatio, details) || undefined,
      // Explicit per-flavor catalog imagery. Always populated when the
      // catalog has the shot classified, regardless of variantKind, so
      // a UGC ad can also show a clean product callout AND a lifestyle
      // thumbnail. Null when the catalog lacks the flavor (e.g.,
      // product-only brand with no lifestyle photography). Both ride
      // the same ratio-aware crop URL machinery as the hero.
      lifestyle_image: pickFlavorImage(ctx?.productHero?.lifestyle,   heroSourceRatio) || null,
      product_image:   pickFlavorImage(ctx?.productHero?.productOnly, heroSourceRatio) || null,
      // Sibling SKUs in the matched category — populated when the match
      // resolves to a Category (via CatalogProduct.categoryRef on a
      // product_match, or via ProductMatchArtifact.categoryId on a
      // product_category outcome). Templates can use this for
      // category-mode fallback (e.g. "Other styles in this collection")
      // when the primary product slot can't render.
      category_pool: (ctx.categoryPool || []).map(p => ({
        id:         String(p._id),
        title:      p.title,
        image_url:  p.imageUrl   || null,
        product_url: p.productUrl || null,
        price:      p.price      ?? null,
        currency:   p.currency   || null,
        category:   p.category   || null
      })),
      // Raffle entry count earned by purchasing this product. Computed
      // as floor(price × entriesPerDollar) with a min-1 guard so a
      // sub-$1 purchase still earns a single entry (operator intent —
      // a purchase should always result in at least one ticket).
      // Null when not a raffle campaign or no price on the product;
      // templates bind to product.raffle_entries to render a counter
      // alongside the price.
      raffle_entries: isRaffle && Number.isFinite(details.price?.value)
        ? Math.max(1, Math.floor(details.price.value * ctx.raffle.entriesPerDollar))
        : null
    },

    // Top-level raffle context block — templates and the derivation
    // prompt read this when present. Null/absent on non-raffle ads
    // so existing template bindings keep their conditional rendering
    // shape (presence-check, not value-check).
    ...(isRaffle ? {
      raffle: {
        prize_description:  ctx.raffle.prizeDescription || null,
        entries_per_dollar: ctx.raffle.entriesPerDollar,
        prize_media:        mediaPair(heroMedia),
        draw_date:          ctx.raffle.drawDate || null
      }
    } : {}),

    // Top-level campaign context. Today it only carries the offer
    // pill payload — a structured offer label + urgency line the
    // renderer overlays on top of the canvas as a designed badge.
    // Independent of the LLM-generated headline so the visual offer
    // is consistent across every ad regardless of derivation drift.
    // Absent when the campaign isn't promotional or no label can
    // be derived (renderer presence-checks before painting).
    ...(() => {
      const offer = deriveCampaignOffer(options.campaignKind, options.promotionalDetails, ctx.raffle);
      return offer ? { campaign: { offer } } : {};
    })(),

    creator: isProductImage ? {} : {
      name:     media.metadata?.creatorName   || undefined,
      handle:   media.metadata?.creatorHandle || undefined,
      platform: DEFAULT_CREATOR_PLATFORM,
      avatar:   undefined,                                // not derived yet; future persona-avatar gen slot
      portrait_media: mediaPair(creatorMedia)
    },

    ugc: isProductImage ? {} : {
      post_id:         media.externalId,
      platform:        DEFAULT_CREATOR_PLATFORM,
      post_type:       DEFAULT_POST_TYPE,
      caption:         media.metadata?.caption || undefined,
      media:           mediaPair(ugcMedia),
      likes:           media.platformStats?.likes    ?? undefined,
      comments:        media.platformStats?.comments ?? undefined,
      shares:          media.platformStats?.shares   ?? undefined,
      saves:           media.platformStats?.saves    ?? undefined,
      rights_approved: rightsApproved,
      // Top 3 social comments by likeCount — populated by Comment
      // collection at loadContext time. The new comment_card zone
      // binds to ugc.top_comments[]; existing metrics_row continues
      // to bind to ugc.{likes,comments,saves,shares} as counts.
      // Positive-gated and snippetized through the same path as review
      // quotes (see buildProofComments) — previously the raw comment was
      // passed through and the renderer clipped whatever overflowed.
      top_comments: proofComments
    },

    social_proof: {
      // rating_value / review_count are an ATOMIC PAIR — see
      // deriveSocialProofNumbers() below for the R2 fix and the
      // stale-artifact handling (`rating_source`).
      ...deriveSocialProofNumbers(details, ctx),
      trusted_by_text: derivation.trusted_by_text || trustedByFromStats(details) || undefined,
      proof_badges:    limitArray(derivedBadges, 4),
      primary_quote:   primaryQuote || undefined,
      secondary_quotes: secondaryQuotes.length ? secondaryQuotes : undefined
    },

    performance: {
      engagement: isProductImage ? {} : stripEmpty({
        likes:    media.platformStats?.likes    ?? undefined,
        comments: media.platformStats?.comments ?? undefined,
        shares:   media.platformStats?.shares   ?? undefined,
        saves:    media.platformStats?.saves    ?? undefined,
        views:    media.platformStats?.views    ?? undefined
      }),
      metrics: isProductImage ? [] : buildPerformanceMetrics(media, match)
    },

    cta: mergeCta(derivation.cta, options.cta, details, {
      outcome:       ctx.match?.outcome,
      brandCategory: ctx.match?.brandCategory,
      brandUrl:      ctx.brand?.websiteUrl || ctx.media?.metadata?.brandUrl || null
    }),

    trust: stripEmpty({
      retailer_logos:  buildRetailerLogos(details.sellers),
      trusted_by_text: derivation.trusted_by_text || trustedByFromStats(details) || undefined,
      certifications:  undefined,
      press_mentions:  undefined
    }),

    copy: stripEmpty({
      // headline_lead / headline_main are the slot-aware split fields the
      // derivation prompt asks the LLM to write to when the canvas variant
      // uses display_script. headline is the joined fallback — when the
      // LLM emitted lead+main but no joined string, synthesize it so
      // existing slot bindings on `copy.headline` keep resolving.
      headline_lead:  derivation.copy?.headline_lead,
      headline_main:  derivation.copy?.headline_main,
      headline:       derivation.copy?.headline
                       || joinHeadlineParts(derivation.copy?.headline_lead, derivation.copy?.headline_main),
      // Subheadline + eyebrow fallbacks: many landscape templates
      // bind these directly (eyebrow_rules zone, section_header zone)
      // and the derivation LLM doesn't always produce them. When empty,
      // fall through to brand.tagline (subheadline) or brand.tone[0] +
      // an action verb / category (eyebrow). Keeps the panel populated
      // for brand_match outcomes the LLM under-emits on.
      //
      // Budget enforcement: when the resolved subheadline rides into
      // the eyebrow_rules zone (the common case across the v1 templates),
      // hard-cap to the slot's max_chars budget at the last word
      // boundary. The LLM gets the cap in its prompt and respects it,
      // but the brand.tagline fallback path doesn't — a long tagline
      // like "Restored and Modified, Better than New" otherwise spills
      // past the hairlines and looks broken.
      subheadline:    truncateToBudget(
        derivation.copy?.subheadline || brand?.tagline || undefined,
        eyebrowMaxChars
      ),
      eyebrow:        derivation.copy?.eyebrow
                       || (Array.isArray(brand?.tone) && brand.tone[0] ? `Built for ${String(brand.tone[0]).toLowerCase()}` : null)
                       || media.metadata?.category
                       || undefined,
      highlight_text: derivation.copy?.highlight_text,
      disclaimer:     options.disclaimer
    }),

    // Source-Media-derived palette + scene context. Templates opt in
    // via style_bindings.source_priority (e.g. testimonial_overlay sets
    // scrim_tint to ['media.palette.0', 'brand.primary_color'] so the
    // image's dominant tone wins for image-led layouts; structured
    // templates like results_proof keep brand.primary_color first).
    // Empty when no detection has run.
    //
    // paletteSource='brand' override: when the operator generated a
    // brand-colorway variant (cartesian doubles each seed across both
    // sources), the palette_* fields surface the BRAND'S colors
    // instead of the hero media's. Templates' style_bindings then
    // resolve the same way (no per-template change) but draw from
    // brand.primaryColor / accentColor / secondaryColor. Falls back
    // to media-derived values per field when a brand color is missing.
    // Pass sceneBackground rather than the raw detection so the
    // catalog-hero variant routes through productHero.background.
    // buildMediaBlock only reads background.* fields off whatever
    // object is passed in detection-shape, so this is a safe swap.
    media: buildMediaBlock({ palette, brand, sceneBackground, paletteSource: options.paletteSource || 'media' }),

    layout_options: options.layout_options || {
      show_logo:           !!brand?.logoUrl,
      show_price:          !!(details.price?.display || details.price?.value),
      show_rating:         typeof details.rating === 'number',
      show_review_count:   typeof details.reviewCount === 'number',
      // BOTH gated on rights. Engagement was gated and the handle was not,
      // which is backwards: the like count is a number about a post, the handle
      // is a real person's identity, and printing it on a paid ad implies they
      // endorsed it. If we will not show someone's like count without approved
      // rights we certainly cannot show their name.
      show_creator_handle: !!media.metadata?.creatorHandle && rightsApproved,
      show_engagement:     !!media.platformStats && rightsApproved,
      show_badges:         (derivation.badges?.length || 0) > 0,
      show_cta:            true
    },

    defaults: {
      fallback_quote:    ctx.match?.outcome === 'brand_match'
                            ? `Made for people like us.`
                            : 'Customers love it.',
      fallback_headline: ctx.match?.outcome === 'brand_match'
                            ? (brandName ? `Built for the ${brandName} community` : 'Built for our community')
                            : (brandName ? `See why ${brandName} customers come back` : 'See why they come back'),
      cta_text:          ctx.match?.outcome === 'brand_match' ? 'Shop the brand' : 'Shop now',
      product_name:      ident.productName || (ctx.match?.outcome === 'brand_match' ? brandName || 'This brand' : 'This product')
    }
  };

  // Overlay-mode templates (testimonial_overlay, etc.) carry a `placement`
  // block computed from the picked image's overlay-zone analysis. The
  // renderer reads placement.elements[] for resolved rects/text colors/scrim
  // instead of the canonical canvas geometry. Errors here must NEVER take
  // down the whole assembly — surface as null placement and let the caller
  // / preview decide what to do.
  if (OVERLAY_MODE_TEMPLATES.has(template)) {
    // Reuse the precomputed placement when buildLayoutInput passed
    // it in — avoids running the placement search twice (once before
    // derivation for box dims, again here for the input). Falls
    // back to recomputing when assembleInput is called from a
    // path that didn't precompute (preflight / candidates etc.).
    if (precomputedPlacement) {
      input.placement = precomputedPlacement;
    } else {
      try {
        const placement = computeOverlayPlacement(ctx, aspectRatio, options, input, template);
        if (placement) input.placement = placement;
      } catch (err) {
        console.warn(`   ⚠️  overlay placement failed for ${template} ${aspectRatio}: ${err.message}`);
      }
    }
  }

  return stripUndefinedDeep(input);
}

// Picks the analyzed image to use as full-bleed background and runs the
// placement algorithm against its overlay-zone analysis. Returns the
// `placement` block to attach to the input, or null if no analyzed image
// is available for this aspect ratio.
// Convert overlay box dimensions (w_px × h_px) into char-budget hints
// for the derivation prompt. Per-element font-size assumptions match
// the renderer's renderOverlay* functions:
//   headline: 1.55em base × stage emBase (canvasW/22) ≈ 70px on a
//             1000-wide canvas. We use a per-rect estimate instead —
//             font scales to fit the box height (~0.7 of h_px for 1
//             line, half that for 2 lines).
//   cta:      ~0.85em × emBase ≈ 38px. Single line.
//   quote:    ~0.95em × emBase ≈ 43px. Multi-line.
// Average glyph advance ~0.5 em for display fonts, ~0.55 for body.
function overlayBoxesToBudgets(boxes) {
  if (!boxes) return null;
  const out = {};
  if (boxes.headline) {
    const w = boxes.headline.w_px, h = boxes.headline.h_px;
    // Headline tries 1 line first; max_lines = floor(h / lineHeight).
    const fontPx = Math.min(h * 0.6, w * 0.08);  // bigger of "fits 1 line" or "fits width-aware"
    const lineH  = fontPx * 1.05;
    const maxLines = Math.max(1, Math.min(2, Math.floor(h / lineH)));
    const charW = fontPx * 0.5;
    const charsPerLine = Math.max(8, Math.floor(w / charW));
    out.headline = {
      w_px: w, h_px: h,
      max_chars: charsPerLine * maxLines,
      max_lines: maxLines,
      max_words: Math.max(2, Math.floor((charsPerLine * maxLines) / 5))
    };
  }
  if (boxes.cta) {
    const w = boxes.cta.w_px, h = boxes.cta.h_px;
    const fontPx = h * 0.45;
    const charW = fontPx * 0.55;
    const charsPerLine = Math.max(6, Math.floor((w * 0.85) / charW));  // 0.85 = padding for button pill
    out.cta = {
      w_px: w, h_px: h,
      max_chars: Math.min(24, charsPerLine),
      max_words: Math.max(1, Math.floor(charsPerLine / 5))
    };
  }
  if (boxes.quote) {
    const w = boxes.quote.w_px, h = boxes.quote.h_px;
    const fontPx = Math.min(h * 0.18, 26);  // smaller, multi-line
    const lineH  = fontPx * 1.3;
    const maxLines = Math.max(2, Math.min(4, Math.floor(h / lineH) - 1));  // reserve 1 line for attribution
    const charW = fontPx * 0.55;
    const charsPerLine = Math.max(20, Math.floor((w * 0.9) / charW));
    out.quote = {
      w_px: w, h_px: h,
      max_chars: charsPerLine * maxLines,
      max_lines: maxLines
    };
  }
  return out;
}

// Convert overlay placement.elements[] into a {headline, cta, quote}
// box dimensions map for the derivation prompt. Each entry carries
// the box's px width × height (canvas-normalized) so the prompt can
// estimate char-budget caps. Returns null if no boxes were placed.
function extractOverlayBoxes(placement, aspectRatio) {
  if (!placement || !Array.isArray(placement.elements)) return null;
  const dims = CANVAS_PIXEL_DIMS[aspectRatio] || { w: 1000, h: 1000 };
  const out = {};
  for (const el of placement.elements) {
    if (!el?.rectPct) continue;
    const wPx = (el.rectPct.x2 - el.rectPct.x1) * dims.w;
    const hPx = (el.rectPct.y2 - el.rectPct.y1) * dims.h;
    out[el.id] = { w_px: Math.round(wPx), h_px: Math.round(hPx) };
  }
  return Object.keys(out).length ? out : null;
}

// Canvas pixel dimensions per ratio — used for converting overlay
// box %s to absolute px for char-budget estimation. Mirrors what
// templatePreview.js applyCanvasSize uses as the stage size.
const CANVAS_PIXEL_DIMS = {
  '1:1':    { w: 1000, h: 1000 },
  '4:5':    { w: 1000, h: 1250 },
  '9:16':   { w: 1000, h: 1778 },
  '16:9':   { w: 1000, h: 563  },
  '1.91:1': { w: 1000, h: 524  }
};

function computeOverlayPlacement(ctx, aspectRatio, options, content, template) {
  // Pick the analyzed image for this ratio. If none is available (e.g.
  // detect didn't run overlay zones for this ratio, or Gemini failed for
  // this variant), fall back to the media source — placement will run
  // against empty restrictions so elements still get placed. The user can
  // then see in the debug trace that "no analysis — placement is not
  // subject-aware" rather than getting a blank preview.
  const overlayPick = pickOverlayBackground(ctx, aspectRatio);
  const usingFallbackImage = !overlayPick.image;
  const image = overlayPick.image || ctx.media?.fileUrl || null;
  if (!image) return null;  // no image at all; give up

  const conservation = typeof options?.conservation === 'number'
    ? Math.max(0, Math.min(1, options.conservation))
    : 0.5;

  const canvasSpec = registry.getCanvas(overlayCanonicalParent('testimonial_overlay'), aspectRatio);
  const canvasW = canvasSpec?.canvas?.width  || 1000;
  const canvasH = canvasSpec?.canvas?.height || 1000;

  // Per-template element filter — the placement engine's hardcoded
  // spec list includes every possible overlay element, but each
  // template's normalized.element_priority_order narrows what should
  // actually be attempted. Without this filter, testimonial_overlay
  // (logo + headline + quote + cta) would still place product_meta.
  const tplNormalized = registry.getNormalized(template);
  const elementIds = (tplNormalized?.placement_policy?.element_priority_order || [])
    .map(e => e.id);

  const result = placeOverlays({
    canvasW, canvasH,
    aspectRatio,
    analysis:     overlayPick.analysis,  // may be null — placement handles it
    conservation,
    content,
    elementIds:   elementIds.length ? elementIds : undefined,
    brandColors:  {
      primary:   content?.brand?.primary_color   || null,
      secondary: content?.brand?.secondary_color || null,
      accent:    content?.brand?.accent_color    || null
    }
  });

  // Surface the analysis data the debug UI needs to visualize keep-outs.
  // Analysis may be null — the UI renders "no analysis" messaging in that
  // case and skips the restriction-bbox layer.
  const analysisSummary = overlayPick.analysis ? {
    restrictions:          overlayPick.analysis.restrictions || [],
    primarySubjectRectPct: overlayPick.analysis.primarySubjectRectPct || null,
    densityGrid:           overlayPick.analysis.densityGrid || null,
    brightnessGrid:        overlayPick.analysis.brightnessGrid || null
  } : null;

  return {
    mode:            result.mode,                  // 'overlay' | 'inset'
    conservation,
    usingFallbackImage,                            // true → image isn't analyzed
    backgroundMedia: {
      image,
      video: overlayPick.video || null,
      ...(result.backgroundMedia || {})
    },
    backgroundColor: result.backgroundMedia?.backgroundColor || null,
    imageRect:       result.backgroundMedia?.imageRect || null,
    analysis:        analysisSummary,
    elements:        result.elements,
    decisions:       result.decisions || [],
    failedRequired:  result.failedRequired
  };
}

// Map an overlay-mode template to its canonical "parent" so we can look up
// canvas pixel dims for the same aspect ratio. Today there's only one
// overlay variant; this is a stub for future ones.
function overlayCanonicalParent(overlayTemplate) {
  switch (overlayTemplate) {
    case 'testimonial_overlay': return 'testimonial_spotlight';
    default: return overlayTemplate;
  }
}

// For overlay templates, pick the analyzed image to use as the full-bleed
// canvas. Base ratios → 'base' variant (smart-crop winner). Extended
// ratios → 'gemini_extension' variant.
function pickOverlayBackground(ctx, aspectRatio) {
  const out = { image: null, video: null, analysis: null };
  const overlay = ctx.overlayZones?.zones?.[aspectRatio];
  if (!overlay) return out;

  const baseRatios = ['5:4', '1:1', '4:5'];
  const preferKey = baseRatios.includes(aspectRatio) ? 'base' : 'gemini_extension';

  // Handle both possible artifact shapes:
  //   v3 array: [{ provider, variant, candidateId, imageUrl, videoUrl?, analysis }]
  //   legacy keyed: { '<variantKey>': { ... } }
  let entry = null;
  if (Array.isArray(overlay)) {
    entry = overlay.find(e => {
      if (preferKey === 'base') return e.variant === 'base';
      return e.provider === 'gemini' && e.variant === 'extension';
    }) || overlay.find(e => !!e.imageUrl);
  } else if (typeof overlay === 'object') {
    entry = overlay[preferKey] || Object.values(overlay).find(v => v?.imageUrl);
  }
  if (!entry) return out;

  out.image = entry.imageUrl || null;
  out.analysis = entry.analysis || null;

  // When the source Media is a video, surface a video URL alongside
  // the image so the preview / renderer can use the video as the
  // hero asset (with the still image as the pre-autoplay poster).
  // Preference order:
  //   1. entry.videoUrl — if the artifact carries a per-variant video crop
  //   2. ctx.media.fileUrl — the original uploaded video, full clip,
  //      letterboxed/cropped via object-fit at render time
  // Extended ratios (9:16 / 1.91:1 / 16:9 from base 4:5 / 5:4) generally
  // don't have a true per-ratio video — Gemini extension is image-only
  // — so we fall back to the source video and accept a less-perfect
  // crop. Better than a static image when the source IS a video.
  if (ctx.media?.fileType === 'video') {
    out.video = entry.videoUrl || ctx.media.fileUrl || null;
  }
  return out;
}

// ──────────────────────────────────────────────────────────────
//  Media resolution helpers
// ──────────────────────────────────────────────────────────────
// Product hero media resolution.
//
// IMPORTANT: the smart-crop judge is optimized for "best crop of the subject
// of interest". On creator UGC where the product is being worn, that subject
// is almost always the PERSON — so using the judge winner for product.hero
// ends up showing the same person as creator.portrait_media, collapsing the
// visual distinction split-screen templates rely on.
//
// Preference order for base ratios:
//   1. High-confidence YOLO product bbox (tight crop of the actual product)
//   2. Judge winner smart crop (subject-of-interest)
//
// For extended ratios (9:16, 1.91:1) we still use the AI-extended Gemini
// winner because those are purpose-built hero assets.
// Available source crop ratios. Limited to BASE smart-crop ratios
// only — extended ratios (9:16, 1.91:1) are AI-generated stills that
// (a) are lazy-enriched and may not exist for fresh detect runs and
// (b) wedge oddly when the slot's actual ratio differs from theirs.
// Cloudinary's c_fill,g_auto reshapes the base crop into the target
// slot using subject-aware gravity, which gives a cleaner result
// than handing it a near-but-not-exact extended crop.
//
// Order matters only on ties (first wins for equidistant matches).
const HERO_SOURCE_OPTIONS = [
  { name: '5:4', value: 5/4 },
  { name: '1:1', value: 1 },
  { name: '4:5', value: 4/5 }
];

// Find the available hero source crop whose ratio is closest to the
// media slot's rect ratio in this canvas variant. Returns null if
// the variant doesn't have a media zone bound to product.hero_media.
function pickHeroSourceRatio(canvasVariant) {
  if (!canvasVariant || !Array.isArray(canvasVariant.zones)) return null;
  const media = canvasVariant.zones.find(z =>
    z.kind === 'media' && z.slot === 'product.hero_media');
  if (!media || !media.rect) return null;
  const slotW = media.rect.w, slotH = media.rect.h;
  if (!slotW || !slotH) return null;
  const target = slotW / slotH;
  let best = null, bestDiff = Infinity;
  for (const opt of HERO_SOURCE_OPTIONS) {
    const d = Math.abs(opt.value - target);
    if (d < bestDiff) { bestDiff = d; best = opt.name; }
  }
  return best;
}

// Raffle hero — uses the prize Media's smart-crop winner for the ratio
// when CropArtifact exists, falls back to the raw mirror URL. Video
// prize media surface video + an image poster derived from the first
// frame transform (same trick the UGC tiles use).
function pickRafflePrizeMedia(raffle, aspectRatio) {
  const pm = raffle?.prizeMedia;
  if (!pm) return { image: null };
  const isVideo = pm.fileType === 'video';
  // Smart crops if available.
  if (raffle.prizeCrops?.winners && pm.fileUrl) {
    const winnerId = raffle.prizeCrops.winners[aspectRatio];
    const list = raffle.prizeCrops.smartCrops?.[aspectRatio] || [];
    const winner = list.find(c => c.id === winnerId) || list[0] || null;
    if (winner) {
      const baseUrl = raffle.prizeDetection?.imageUrl || pm.fileUrl;
      return {
        image: buildCloudinaryCropUrl(baseUrl, winner),
        ...(isVideo && pm.fileUrl ? { video: pm.fileUrl } : {})
      };
    }
  }
  // No crops — raw URL. For video, also expose a Cloudinary poster
  // frame at so_2 (2 seconds in — skips typical intro flashes / title
  // cards on Reels / TikToks). so_auto would be nicer but requires
  // the AI Preview add-on; accounts without it 400 on so_auto URLs.
  if (isVideo) {
    const poster = pm.fileUrl.includes('/video/upload/')
      ? pm.fileUrl.replace('/video/upload/', '/video/upload/so_2,f_jpg,q_auto:good/').replace(/\.(mp4|mov|webm|m4v)(\?.*)?$/i, '.jpg$2')
      : pm.fileUrl;
    return { image: poster, video: pm.fileUrl };
  }
  return { image: pm.fileUrl };
}

function pickHeroMedia(ctx, aspectRatio) {
  const { media, detection, crops, extended } = ctx;
  const out = { image: null, video: null };
  const baseRatios = ['5:4', '1:1', '4:5'];

  if (baseRatios.includes(aspectRatio)) {
    // Priority order:
    //   1. judge smart-crop winner — composition-aware, matches what
    //      the operator sees as the "winner" in the media-library
    //      ribbon. This is the right hero for ads in almost every case.
    //   2. first available smart crop for this ratio (judge missing
    //      or picked nothing).
    //   3. tight YOLO product crop — last resort when there are no
    //      smart crops at all (e.g. catalog-product alts that skip
    //      judge AND have no YOLO products).
    const winnerId = crops?.winners?.[aspectRatio];
    const list = crops?.smartCrops?.[aspectRatio] || [];
    const winner = list.find(c => c.id === winnerId) || list[0] || null;
    if (winner && detection?.imageUrl) {
      out.image = buildCloudinaryCropUrl(detection.imageUrl, winner);
      if (media.fileType === 'video' && media.fileUrl) {
        out.video = buildCloudinaryCropUrl(media.fileUrl, winner);
      }
      return out;
    }
    // No smart crop for this ratio — fall back to YOLO product crop.
    const product = pickTopYoloProduct(detection);
    if (product && detection?.imageUrl) {
      out.image = buildCloudinaryCropUrl(detection.imageUrl, product);
      if (media.fileType === 'video' && media.fileUrl) {
        out.video = buildCloudinaryCropUrl(media.fileUrl, product);
      }
    }
  } else if (aspectRatio === '9:16' || aspectRatio === '1.91:1') {
    const winnerRef = extended?.selectedWinners?.[aspectRatio]?.candidateId;
    const list = extended?.candidates?.[aspectRatio] || [];
    const winner = list.find(c => c.id === winnerRef)
      || list.find(c => c.provider === 'gemini')
      || list[0];
    if (winner?.imageUrl) out.image = winner.imageUrl;
    if (winner?.videoUrl) out.video = winner.videoUrl;
  } else if (aspectRatio === '16:9') {
    // Not produced yet — best-effort fallback to any base ratio winner.
    for (const r of ['5:4', '1:1', '4:5']) {
      const m = pickHeroMedia(ctx, r);
      if (m.image) return m;
    }
  }
  return out;
}

// Pick a cropped catalog-product image keyed to the hero source
// ratio. When ctx.productHero is set (wizard supplied a productId)
// AND its CropArtifact has a winner for the requested ratio, return
// the c_crop transform URL. Otherwise fall back to details.imageUrl
// (the raw CatalogProduct.imageUrl, uncropped).
// Build the canonical input's `media` block. For paletteSource='media'
// (default), populate from the hero media's extracted palette. For
// paletteSource='brand', overlay brand-color overrides per slot,
// falling back to the media palette when a brand color is missing.
// Background context (setting/lighting/style/description) stays
// scene-derived regardless of paletteSource — it informs the prompt
// section, not style bindings.
function buildMediaBlock({ palette, brand, sceneBackground, paletteSource }) {
  // sceneBackground is the resolved background block from the active
  // hero source (UGC post's detection.background OR catalog hero's
  // productHero.background, picked by assembleInput per variantKind).
  const mediaPalette = palette || [];
  const useBrand = paletteSource === 'brand';

  // Brand-variant background picker. The accent color reads as the
  // "pop" foreground (CTA fill, headline emphasis). Whichever of
  // primary/secondary gives the accent the highest WCAG contrast wins
  // the background slot; the other becomes palette_neutral. Without
  // this, brand variants previously stamped primary as the background
  // unconditionally — when accent was close in luminance to primary
  // (e.g. red accent on red primary), the headline blended in.
  const brandBg = useBrand
    ? pickBrandBackground(brand?.primaryColor, brand?.secondaryColor, brand?.accentColor)
    : null;
  const brandOther = useBrand && brandBg
    ? (sameHex(brandBg, brand?.primaryColor) ? brand?.secondaryColor : brand?.primaryColor)
    : null;

  // Resolve each style slot. Brand-mode picks primary/secondary by
  // accent-contrast (above); media-mode uses the historical media-
  // first ordering. palette_vibrant stays brand.accentColor in brand
  // mode (the foreground pop color for CTA + headline emphasis).
  const palette_dominant = useBrand
    ? (brandBg || brand?.primaryColor || mediaPalette[0] || null)
    : (mediaPalette[0] || null);
  const palette_accent = useBrand
    ? (brand?.accentColor || mediaPalette[1] || null)
    : (mediaPalette[1] || null);
  const palette_neutral = useBrand
    ? (brandOther || brand?.secondaryColor || mediaPalette[2] || null)
    : (mediaPalette[2] || null);
  const palette_vibrant = useBrand
    ? (brand?.accentColor || pickVibrantColor(mediaPalette))
    : pickVibrantColor(mediaPalette);
  // When brand mode is active, surface the brand palette as the array
  // form too so consumers that iterate media.palette[] see brand colors.
  const paletteArray = useBrand
    ? [palette_dominant, palette_accent, palette_neutral].filter(Boolean)
    : mediaPalette;
  return {
    palette:           paletteArray,
    palette_dominant,
    palette_accent,
    palette_neutral,
    palette_vibrant,
    background_setting:     sceneBackground?.setting     || null,
    background_lighting:    sceneBackground?.lighting    || null,
    background_style:       sceneBackground?.style       || null,
    background_description: sceneBackground?.description || null
  };
}

// Given a hydrated flavor entry from loadContext.productHero (lifestyle
// or productOnly), return the ratio-aware crop URL when crops exist,
// else the raw imageUrl. Returns null when the entry is missing — the
// caller emits null to the canonical input so templates know the
// flavor isn't available for this product.
function pickFlavorImage(flavor, aspectRatio) {
  if (!flavor) return null;
  if (flavor.crops?.winners && flavor.imageUrl) {
    const winnerId = flavor.crops.winners[aspectRatio];
    const list = flavor.crops.smartCrops?.[aspectRatio] || [];
    const winner = list.find(c => c.id === winnerId) || list[0] || null;
    if (winner) return buildCloudinaryCropUrl(flavor.imageUrl, winner);
  }
  return flavor.imageUrl || null;
}

function pickProductImage(ctx, aspectRatio, details) {
  const ph = ctx?.productHero;
  // Prefer the INSET media (best product_only / clean catalog shot) for
  // the small product callout slot. When loadContext found one, it
  // stashed insetCrops/insetImageUrl on productHero alongside the main
  // hero crops. For single-shot catalogs (no alt classified as
  // product_only), fall through to the hero's own crop.
  if (ph?.insetCrops?.winners && ph?.insetImageUrl) {
    const winnerId = ph.insetCrops.winners[aspectRatio];
    const list = ph.insetCrops.smartCrops?.[aspectRatio] || [];
    const winner = list.find(c => c.id === winnerId) || list[0] || null;
    if (winner) return buildCloudinaryCropUrl(ph.insetImageUrl, winner);
    return ph.insetImageUrl;
  }
  if (ph?.crops?.winners && ph?.imageUrl) {
    const winnerId = ph.crops.winners[aspectRatio];
    const list = ph.crops.smartCrops?.[aspectRatio] || [];
    const winner = list.find(c => c.id === winnerId) || list[0] || null;
    if (winner) return buildCloudinaryCropUrl(ph.imageUrl, winner);
    // No crop for this ratio but we have the catalog hero URL — return
    // it uncropped (better than the raw Shopify URL since it's already
    // mirrored to our Cloudinary, supports c_fill transforms downstream).
    return ph.imageUrl;
  }
  return details?.imageUrl || null;
}

// Pick the best YOLO product detection to use as a tight product crop.
// Ranks by confidence × area (so the model doesn't pick a tiny 0.95 sunglasses
// detection over a larger 0.82 shirt). Returns null if no detection is
// confident enough to trust.
function pickTopYoloProduct(detection) {
  const dets = Array.isArray(detection?.yoloProducts) ? detection.yoloProducts : [];
  if (!dets.length) return null;
  const MIN_CONF = 0.55;
  const scored = dets
    .map(d => {
      const conf = typeof d.confidence === 'number' ? d.confidence : 0;
      if (conf < MIN_CONF) return null;
      // Phase 1.5 — skip detections GPT-4.1 enrichment marked as non-product
      // (UI chrome, scroll arrows, watermarks). The raw YOLO confidence on
      // these can still be high because YOLO matched a COCO class like
      // 'frisbee' to a scroll arrow, but they're not real products.
      if (d.identification?.label === 'non-product') return null;
      const w = Math.max(0, (d.x2 || 0) - (d.x1 || 0));
      const h = Math.max(0, (d.y2 || 0) - (d.y1 || 0));
      const area = w * h;
      if (!area) return null;
      return { det: d, score: conf * Math.sqrt(area) };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.det || null;
}

function pickSecondaryMedia(ctx, heroRatio) {
  const order = (heroRatio === '9:16' || heroRatio === '4:5')
    ? ['1.91:1', '5:4', '1:1', '4:5', '9:16']
    : ['4:5', '1:1', '9:16', '1.91:1', '5:4'];
  const heroImage = pickHeroMedia(ctx, heroRatio).image;
  for (const r of order) {
    if (r === heroRatio) continue;
    const m = pickHeroMedia(ctx, r);
    if (m.image && m.image !== heroImage) return m;
  }
  return { image: null, video: null };
}

// Creator / UGC portrait media. Detect-uploaded Media is treated as creator
// content. We prefer the judge's subject-preserving smart crop over the raw
// source so a creator panel (often tall) doesn't chop heads when the
// renderer's object-fit takes over.
//
// Priority on base ratios (which is where creator panels live in 1:1 / 4:5 /
// 9:16 templates):
//   1. smartCrops['4:5'] winner  — tallest subject-preserving crop, best fit
//      for vertical creator panels
//   2. smartCrops['1:1'] winner  — square; works for most creator zones
//   3. smartCrops['5:4'] winner  — wide fallback
//   4. raw source URL (previous behavior)
//
// Video uses the same crop rect applied to the source video via c_crop.
function pickCreatorMedia(ctx) {
  const { media, detection, crops } = ctx;
  const out = { image: null, video: null };

  const tryRatios = ['4:5', '1:1', '5:4'];
  let winner = null;
  for (const r of tryRatios) {
    const winnerId = crops?.winners?.[r];
    const list = crops?.smartCrops?.[r] || [];
    const found = list.find(c => c.id === winnerId) || list[0];
    if (found) { winner = found; break; }
  }

  if (winner && detection?.imageUrl) {
    out.image = buildCloudinaryCropUrl(detection.imageUrl, winner);
    if (media.fileType === 'video' && media.fileUrl) {
      out.video = buildCloudinaryCropUrl(media.fileUrl, winner);
    }
    return out;
  }

  // Raw-source fallback if no crops exist (pre-detect-pipeline media, or
  // detect failed partway).
  if (media.fileType === 'video') {
    out.image = detection?.imageUrl || media.fileUrl;
    out.video = media.fileUrl;
  } else {
    out.image = media.fileUrl;
  }
  return out;
}

function mediaPair(p) {
  if (!p) return undefined;
  const obj = {};
  if (p.image) obj.image = p.image;
  if (p.video) obj.video = p.video;
  return Object.keys(obj).length ? obj : undefined;
}

// Walk a palette and return the entry with the highest HSL saturation.
// detect.background.palette is dominance-ordered (most-pixels-first),
// which puts a black/grey backdrop at index 0 even when the visually
// striking highlights belong further in. Image-led templates lead with
// the most-saturated color so headlines / CTAs / accents read as the
// 'hero' color of the photograph rather than the muted background.
// Minimum HSL saturation for a "vibrant" pick. Below this, the palette
// is effectively monochromatic (every entry sits on the same color
// family at different shades) and picking any one as the accent
// renders too close to palette_dominant for headline contrast.
// 0.80 is intentionally aggressive — only deeply saturated tones
// (the flame in the HCO reference, a brand-orange logo on neutrals)
// pass. Borderline colors fall through to the white default.
const VIBRANT_MIN_SATURATION = 0.80;

// Minimum WCAG contrast ratio between the vibrant pick and the
// palette's dominant tone (which the panel background is bound to in
// the image-led split-panel layouts). 8.0 is AAA-territory — even
// a high-saturation pick that happens to share a hue family with the
// panel will fail this gate and fall through to the white default.
const VIBRANT_MIN_CONTRAST_VS_DOMINANT = 8.0;

// Brand-variant background picker. Returns whichever of primary /
// secondary gives the accent color the highest WCAG contrast — that's
// where the accent reads as a "pop" foreground (CTA, headline emphasis)
// instead of blending in. Falls back gracefully when one or more
// inputs are missing: returns the first defined color.
function pickBrandBackground(primary, secondary, accent) {
  if (!accent)    return primary || secondary || null;
  if (!primary)   return secondary || null;
  if (!secondary) return primary || null;
  const cP = contrastRatio(accent, primary);
  const cS = contrastRatio(accent, secondary);
  // Tie / null contrast → keep primary as default (matches the legacy
  // behavior so brands without a meaningfully different secondary
  // don't see their bindings flip arbitrarily).
  if (cS == null || cP == null) return primary;
  return cS > cP ? secondary : primary;
}

// Case-insensitive hex equality with optional leading-#. Used by the
// brand-variant picker to identify the "other" color (whichever wasn't
// chosen as background) for the neutral slot.
function sameHex(a, b) {
  if (!a || !b) return false;
  return String(a).replace(/^#/, '').toLowerCase() === String(b).replace(/^#/, '').toLowerCase();
}

function pickVibrantColor(palette) {
  if (!Array.isArray(palette) || palette.length === 0) return null;
  let best = null;
  let bestScore = -1;
  for (const hex of palette) {
    const sat = saturationOfHex(hex);
    if (sat == null) continue;
    if (sat > bestScore) {
      bestScore = sat;
      best = hex;
    }
  }
  if (!best || bestScore < VIBRANT_MIN_SATURATION) return null;

  const dominant = palette[0];
  if (dominant) {
    const cr = contrastRatio(best, dominant);
    if (cr != null && cr < VIBRANT_MIN_CONTRAST_VS_DOMINANT) return null;
  }
  return best;
}

function relativeLuminance(hex) {
  if (typeof hex !== 'string') return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const channels = [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff].map(v => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(hexA, hexB) {
  const lA = relativeLuminance(hexA);
  const lB = relativeLuminance(hexB);
  if (lA == null || lB == null) return null;
  const lighter = Math.max(lA, lB);
  const darker  = Math.min(lA, lB);
  return (lighter + 0.05) / (darker + 0.05);
}

function saturationOfHex(hex) {
  if (typeof hex !== 'string') return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 0xff) / 255;
  const g = ((n >>  8) & 0xff) / 255;
  const b = (n & 0xff)         / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const L = (max + min) / 2;
  if (max === min) return 0;
  const d = max - min;
  return L > 0.5 ? d / (2 - max - min) : d / (max + min);
}

function buildCloudinaryCropUrl(sourceUrl, crop) {
  if (!sourceUrl || !sourceUrl.includes('/upload/')) return sourceUrl;
  const w = Math.max(1, (crop.x2 || 0) - (crop.x1 || 0));
  const h = Math.max(1, (crop.y2 || 0) - (crop.y1 || 0));
  if (!w || !h) return sourceUrl;
  const transform = `c_crop,w_${w},h_${h},x_${crop.x1},y_${crop.y1}`;
  if (/\/v\d+\//.test(sourceUrl)) return sourceUrl.replace(/\/(v\d+\/)/, `/${transform}/$1`);
  return sourceUrl.replace('/upload/', `/upload/${transform}/`);
}

// ──────────────────────────────────────────────────────────────
//  Assorted helpers
// ──────────────────────────────────────────────────────────────
function firstYoloCategory(detection) {
  const det = (detection?.yoloProducts || []).find(d =>
    d.identification?.category &&
    d.identification.category !== 'non-product' &&
    d.identification.label !== 'non-product'
  );
  return det?.identification?.category || null;
}

function buildPerformanceMetrics(media, match) {
  const metrics = [];
  const stats = media.platformStats || {};
  if (typeof stats.views    === 'number' && stats.views    > 0) metrics.push({ label: 'Views',    value: formatCount(stats.views) });
  if (typeof stats.likes    === 'number' && stats.likes    > 0) metrics.push({ label: 'Likes',    value: formatCount(stats.likes) });
  if (typeof stats.comments === 'number' && stats.comments > 0) metrics.push({ label: 'Comments', value: formatCount(stats.comments) });
  if (typeof stats.shares   === 'number' && stats.shares   > 0) metrics.push({ label: 'Shares',   value: formatCount(stats.shares) });
  const rating      = match?.identification?.details?.rating;
  const reviewCount = match?.identification?.details?.reviewCount;
  if (typeof rating === 'number')      metrics.push({ label: 'Rating',  value: `${rating.toFixed(1)}★` });
  if (typeof reviewCount === 'number') metrics.push({ label: 'Reviews', value: formatCount(reviewCount) });
  return metrics.slice(0, 6);
}

/**
 * ATOMIC rating_value/review_count pair for `social_proof` (R2 fix,
 * 2026-08-03).
 *
 * HISTORY — the hole this closes: the previous code resolved rating_value
 * and review_count as TWO INDEPENDENT ternaries, each falling to
 * ctx.match.brandReviews on its own for a 'brand_match' outcome. Ratings and
 * review counts are frequently scraped separately, so a product carrying a
 * rating but no count kept its product-tier rating while the count alone
 * fell through to the BRAND aggregate — printing a catalog-wide review
 * count beside a single product's stars. That is the exact cross-tier mix
 * services/ratingDisplay.js's resolveCoherentSocialProof exists to forbid.
 *
 * FIX: decide the winning TIER once for the whole pair. If the product
 * (`details`) carries EITHER field, the pair is product-tier and BOTH
 * fields come from `details` — a field product doesn't have stays empty
 * rather than borrowing the other tier's value. Only when product has
 * NEITHER field does the pair fall to the brand aggregate, and then BOTH
 * fields come from ctx.match.brandReviews together.
 *
 * `rating_source` ('product'|'brand'|null) records which tier won. This is
 * the mechanism for the ~722/738 artifacts already cached under the OLD
 * two-ternary code: those documents were written before this field existed,
 * so they carry NO `rating_source` at all. A tier-aware consumer
 * (brandScriptExecutor.buildMetaForAd) treats that ABSENCE as "provenance
 * unknown" and does not trust a stale artifact's rating_value/review_count
 * as a coherent PRODUCT pair — CatalogProduct becomes the sole product-tier
 * source for those ads instead (or no product pair at all, if CatalogProduct
 * also has nothing). This does NOT drop proof a brand legitimately has:
 * Brand.brandReviews is fetched independently by buildMetaForAd for the
 * BRAND tier and is untouched by any of this — only the product-shaped
 * fallback that used to live here is what a stale artifact loses.
 *
 * A fix that only changed future writes would not be sufficient on its own
 * (this file cannot rewrite already-persisted Mongo documents) — the
 * `rating_source` marker is what lets a consumer distinguish "written under
 * the atomic rule" from "written under the old, possibly-mixed rule"
 * without a schema-version bump (which would force a live re-derivation —
 * runDerivation() calls the Gemini layout-derivation LLM — across every
 * cached artifact; far too large and costly a side effect for this fix).
 *
 * @returns {{ rating_value: number|undefined, review_count: number|undefined, rating_source: 'product'|'brand'|null }}
 */
function deriveSocialProofNumbers(details, ctx) {
  // RATING_PAIR_ATOMIC (default off): productReviews pair first, then a
  // single-source fallback. Flag-off is the independent details.rating /
  // details.reviewCount read this replaced — including the mixed case.
  // Flag-on: pass EVERY candidate snapshot. `details.productReviews ||
  // match.productReviews` preferred a stale details object over a
  // fresher catalog pair. resolveDeriveProductPair selects by provenance
  // (scraped > llm-web > unknown) then fetchedAt. Flag-off ignores the
  // second argument.
  const productPair = resolveDeriveProductPair(details, [
    details?.productReviews,
    ctx?.match?.productReviews,
    ctx?.match ? productReviewsOf(ctx.match) : null
  ]);
  if (productPair) return productPair;
  // For 'branding' outcome (no SKU) fall back to brand-level rating /
  // review_count from Gemini brand-reviews lookup so the proof bar isn't
  // blank when only brand sentiment is available — atomic, both fields
  // from the SAME brandReviews snapshot.
  const brandReviews = ctx.match?.outcome === 'brand_match' ? ctx.match?.brandReviews : null;
  const hasBrandNumber = brandReviews
    && (typeof brandReviews.rating === 'number' || typeof brandReviews.reviewCount === 'number');
  if (hasBrandNumber) {
    return {
      rating_value:  brandReviews.rating,
      review_count:  brandReviews.reviewCount,
      rating_source: 'brand',
    };
  }
  return { rating_value: undefined, review_count: undefined, rating_source: null };
}

function trustedByFromStats(details) {
  if (typeof details.reviewCount === 'number' && details.reviewCount >= 50) {
    return `Trusted by ${formatCount(details.reviewCount)}+ customers`;
  }
  return null;
}

function formatCount(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000)    return `${Math.round(n / 1_000)}k`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function buildRetailerLogos(sellers) {
  if (!Array.isArray(sellers) || !sellers.length) return undefined;
  const seen = new Set();
  const logos = [];
  for (const s of sellers) {
    const domain = domainFromUrl(s.link);
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    logos.push(`https://www.google.com/s2/favicons?domain=${domain}&sz=64`);
    if (logos.length >= 6) break;
  }
  return logos.length ? logos : undefined;
}

function domainFromUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

// CTA assembly is outcome-aware:
//   - default            → "Shop now" + first SerpAPI seller URL
//   - 'category'         → "Shop the Collection" + brandCategory.url
//                          (breadcrumb surfaced as cta.subtext)
//   - 'branding'         → "Shop the Brand" + brand homepage URL
//                          (no specific product, send to brand site)
function mergeCta(derivedCta, callerCta, details, outcomeCtx) {
  const primarySellerUrl = Array.isArray(details.sellers) && details.sellers[0]?.link
    ? details.sellers[0].link
    : null;
  const outcome  = outcomeCtx?.outcome || null;
  const brandCat = outcomeCtx?.brandCategory || null;
  const brandUrl = outcomeCtx?.brandUrl || null;

  let outcomeText = null;
  let outcomeUrl  = null;
  let outcomeSubtext = null;
  if (outcome === 'product_category' && brandCat?.url) {
    outcomeText    = 'Shop the Collection';
    outcomeUrl     = brandCat.url;
    outcomeSubtext = brandCat.breadcrumb || undefined;
  } else if (outcome === 'product_match' && brandCat?.url) {
    // Even confident product matches get a category-page CTA fallback
    // — useful when the SKU URL 404s downstream.
    outcomeText    = null;        // keep the "Shop now" / derivation default
    outcomeUrl     = null;        // primarySellerUrl wins; brandCat is a backup
    outcomeSubtext = brandCat.breadcrumb || undefined;
  } else if (outcome === 'brand_match' && brandUrl) {
    outcomeText = 'Shop the Brand';
    outcomeUrl  = brandUrl;
  }

  return stripEmpty({
    text:       callerCta?.text       || outcomeText             || derivedCta?.text       || 'Shop now',
    url:        callerCta?.url        || outcomeUrl              || primarySellerUrl       || brandUrl       || undefined,
    subtext:    callerCta?.subtext    || outcomeSubtext          || derivedCta?.subtext    || undefined,
    offer_text: callerCta?.offer_text || derivedCta?.offer_text  || undefined
  });
}

function limitArray(arr, max) {
  if (!Array.isArray(arr) || !arr.length) return undefined;
  return arr.slice(0, max);
}

function stripEmpty(obj) {
  if (!obj) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v == null || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

function stripUndefinedDeep(obj) {
  if (Array.isArray(obj)) return obj.map(stripUndefinedDeep);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      const cleaned = stripUndefinedDeep(v);
      if (cleaned === undefined) continue;
      if (cleaned === null) continue;   // drop null fields (placement block emits some)
      if (Array.isArray(cleaned) && cleaned.length === 0) continue;
      // typeof null === 'object' is the JS gotcha that originally tripped this
      // — the explicit `cleaned !== null` is belt-and-suspenders against any
      // future code path that lets a null reach here.
      if (cleaned !== null && typeof cleaned === 'object' && !Array.isArray(cleaned) && Object.keys(cleaned).length === 0) continue;
      out[k] = cleaned;
    }
    return out;
  }
  return obj;
}

function badRequest(msg) { const e = new Error(msg); e.status = 400; return e; }
function notFound(msg)   { const e = new Error(msg); e.status = 404; return e; }

module.exports = {
  buildLayoutInput,
  getCandidatesForMedia,
  // Exported for tests / future preview UI:
  assembleInput,
  stubDerivationFromCtx,
  loadContext,
  // Exported for the AI-canvas pipeline so it can build per-ratio
  // alt crop URLs from the same crop artifacts the renderer uses.
  buildCloudinaryCropUrl,
  // Shared so every surface that renders a social comment as proof applies
  // the same definition of praise, rather than each growing its own lexicon.
  hasPositiveSignal,
  hasHardLimiter,
  clearsQualityFloor,
  // Exported so the harness ranks with the SHIPPED scorer rather than a copy.
  scoreQuote,
  // Exported so scripts/verifyProofBeat.js can pin the R2 fix BEHAVIOURALLY
  // rather than by source scan. This is the function that decides ONE winning
  // tier for the rating/count pair and stamps `rating_source`; before it, two
  // independent ternaries could take a product rating and a brand count on the
  // same artifact, and downstream had no way to tell brand numbers from product
  // numbers. A revert-proof pass showed nothing failed when the marker was
  // removed, which is why it is exported now.
  deriveSocialProofNumbers,
  // Quote-selection internals, exported so scripts/verifyQuoteGate.js can pin
  // the 4.5-star floor and the product-review lookup. Both have already been
  // broken once by a merge with nothing to catch it.
  gateQuotesByRating,
  pickStrongestQuote,
  // Exported so verifyQuoteRotation A8 can pin tier stamping BEHAVIOURALLY.
  // The old form asserted /const stampTier\s*=/ plus a call count, which
  // hoisting these out of buildQuotePool broke while behaviour was unchanged —
  // a name scan cannot tell a refactor from a regression. Same reasoning as
  // deriveSocialProofNumbers above.
  stampTier,
  prepareQuotePool,
  // Stage-aware quote wiring (QUOTE_STAGE_AWARE) + Director pool
  // alignment (pickPrimaryProductQuote). Exported so the harness and
  // aiCreativeDirectorService call the shipped functions, not copies.
  quoteStageAwareEnabled,
  quoteOptsFromOptions,
  computeCampaignContextHash,
  normalizeStage,
  conceptAngleTerms,
  resolveQuoteAssemblyOptions,
  applyStagedQuotePick,
  STAGE_HEADROOM,
  BIAS_CAP,
  STAGE_WEIGHT,
  stampQuoteOrigins,
  printableQuotes,
  prepareQuotePool,
  gateQuotesByColourway,
  pickPrimaryProductQuote,
  // Exported for scripts/verifyQuoteProvenance.js, which pins the rule that a
  // byline is a real person's name or nothing — this function used to substitute
  // the quote's SOURCE (a website) when no name was known.
  normalizeQuote,
  productReviewsOf,
  toFiveScale,
  QUOTE_MIN_RATING,
  // Exported so the provenance harness can pin: derivation prompt gets quote
  // TEXT for tone, never a byline/persona for anonymous-print origins.
  buildDerivationPrompt,
  quoteLineForTonePrompt,
  // Exported so buildMetaForAd (brandScriptExecutor.js) can require a
  // fresh-schema artifact instead of hardcoding '4.1' — a stale artifact
  // carries pre-provenance UNSTAMPED quotes that the printability gate
  // then withholds wholesale.
  INPUT_SCHEMA_VERSION,
  MAX_LAYOUT_SECONDARY_QUOTES,
  // Exported so scripts/verifyClaimSubstantiation.js can pin the
  // reviewCount sample-floor fix BEHAVIOURALLY (drive the shipped
  // function), not by scanning the source for the literal 'Top rated'.
  defaultBadgesFromSignal
};
