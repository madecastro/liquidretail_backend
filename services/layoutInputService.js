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

const Media                  = require('../models/Media');
const DetectionArtifact      = require('../models/DetectionArtifact');
const CropArtifact           = require('../models/CropArtifact');
const ExtendedCropArtifact   = require('../models/ExtendedCropArtifact');
const ProductMatchArtifact   = require('../models/ProductMatchArtifact');
const OverlayZoneArtifact    = require('../models/OverlayZoneArtifact');
const LayoutInputArtifact    = require('../models/LayoutInputArtifact');
const CatalogProduct         = require('../models/CatalogProduct');
const { findBrandByName }    = require('./brandCatalogService');
const { placeOverlays }      = require('./overlayPlacementService');
const registry               = require('./templateRegistry');
const { hydrateMatch }       = require('./productMatchHydration');
const { computeSlotBudgets } = require('./slotBudget');

const GEMINI_MODEL    = process.env.GEMINI_SEARCH_MODEL || 'gemini-2.5-pro';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

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
const INPUT_SCHEMA_VERSION = '3.0';

// Templates that render via the overlay-on-image placement algorithm
// instead of the canonical canvas-zone composition.
const OVERLAY_MODE_TEMPLATES = new Set(['testimonial_overlay']);

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

  if (!refresh) {
    const cached = await LayoutInputArtifact.findOne({ mediaId, template, aspectRatio }).lean();
    // Cache hit only if the stored schema version matches what we emit today.
    // Without this check, v1 cached docs (with old paths like hero_image_url)
    // get served even though the renderer now reads hero_media.image —
    // resulting in blank zones across the preview until an explicit refresh.
    if (cached && cached.schemaVersion === INPUT_SCHEMA_VERSION) return cached.input;
  }

  const ctx = await loadContext(mediaId);
  if (!ctx) throw notFound(`Media ${mediaId} not found`);

  // Hard-stop: matching service flagged this Media as 'do_not_use'
  // (typically multi-brand contention). Templates can't safely render
  // ad creative for it; surface a clear error rather than producing
  // ambiguous output.
  if (ctx.match?.outcome === 'do_not_use') {
    throw badRequest(`Media flagged as do_not_use by product matching: ${ctx.match.outcomeReasoning || 'multiple brands detected'}`);
  }

  const derivation = await runDerivation(ctx, template, aspectRatio, options);
  const input = assembleInput(ctx, template, aspectRatio, options, derivation);

  await LayoutInputArtifact.findOneAndReplace(
    { mediaId, template, aspectRatio },
    {
      mediaId,
      runId: ctx.runId || null,
      template,
      aspectRatio,
      schemaVersion: INPUT_SCHEMA_VERSION,
      input,
      derivation,
      createdAt: new Date()
    },
    { upsert: true }
  );

  return input;
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
      const input = assembleInput(ctx, tmpl.template_id, aspectRatio, {}, stubDerivation);
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
async function loadContext(mediaId) {
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
  const match = await hydrateMatch(rawMatch);
  const runId = detection?.runId || null;
  const brandName = match?.identification?.brand || media.metadata?.brand || null;
  const brand = brandName
    ? await findBrandByName(brandName).then(b => b?.toObject?.() || b).catch(() => null)
    : null;

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
        brandId:     match.brandId,
        categoryRef: categoryRefForPool,
        draft:       { $ne: true },
        ...(match.catalogProductId ? { _id: { $ne: match.catalogProductId } } : {})
      })
        .select('title imageUrl productUrl price currency category')
        .limit(12)
        .lean()
        .catch(err => { console.warn(`   ⚠️  categoryPool fetch failed: ${err.message}`); return []; })
    : [];

  return { media, detection, crops, extended, match, overlayZones, brand, runId, categoryPool };
}

// ──────────────────────────────────────────────────────────────
//  Derivation LLM
// ──────────────────────────────────────────────────────────────
async function runDerivation(ctx, template, aspectRatio, options) {
  if (!process.env.GEMINI_API_KEY) return fallbackDerivation(ctx);

  const prompt = buildDerivationPrompt(ctx, template, aspectRatio, options);

  try {
    const res = await axios.post(
      `${GEMINI_ENDPOINT}?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,
      {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 3000,
          thinkingConfig: { thinkingBudget: 1024 },
          responseMimeType: 'application/json',
          responseSchema: DERIVATION_SCHEMA
        }
      },
      { timeout: 45000 }
    );
    const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      console.warn(`   ⚠️  layout-derivation: empty response (finishReason=${res.data?.candidates?.[0]?.finishReason})`);
      return fallbackDerivation(ctx);
    }
    return JSON.parse(text);
  } catch (err) {
    console.warn(`   ⚠️  layout-derivation failed: ${err.response?.data?.error?.message || err.message}`);
    return fallbackDerivation(ctx);
  }
}

function buildDerivationPrompt(ctx, template, aspectRatio, options) {
  const { media, detection, match, brand } = ctx;
  const ident = match?.identification || {};
  const details = ident.details || {};
  const isBranding = match?.outcome === 'brand_match';
  const brandName = ident.brand || media.metadata?.brand || brand?.name || null;
  const lines = [];

  lines.push(`You are composing creative copy for a social-proof ad layout.`);
  lines.push(`Template: ${template} (${templateIntent(template)}).`);
  lines.push(`Aspect ratio: ${aspectRatio}.`);
  if (options.tone_hint) lines.push(`Caller tone hint: ${options.tone_hint}.`);
  lines.push('');

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
          lines.push(`    - "${q.text}"${q.author ? ` — ${q.author}` : ''}${q.source ? ` (${q.source})` : ''}`);
        }
      }
      lines.push('');
    }
  } else {
    lines.push('REVIEW SIGNAL:');
    if (typeof details.rating === 'number')      lines.push(`  Rating: ${details.rating}`);
    if (typeof details.reviewCount === 'number') lines.push(`  Review count: ${details.reviewCount}`);
    if (details.reviewSummary?.summary)          lines.push(`  Review summary: ${details.reviewSummary.summary}`);
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

  if (isBranding) {
    // Brand-mode headline / quote rules. Override the product-shaped
    // defaults so the LLM doesn't backslide into product-specific copy.
    if (useSplitHeadline) {
      const hb = slotBudgets.headline;
      lines.push(`- "copy.headline_lead" REQUIRED — the small first clause of a stacked display-script headline. MAX ${hb.lead.max_chars} characters, ${hb.lead.max_lines} line, ~${hb.lead.max_words} words. This clause renders at HALF the size of headline_main, so it can hold a setup phrase ("WHY ANGLERS LOVE", "BUILT FOR THE", "SAY HELLO TO").`);
      lines.push(`- "copy.headline_main" REQUIRED — the large second clause that completes the headline. MAX ${hb.main.max_chars} characters across ${hb.main.max_lines} line(s), ~${hb.main.max_words} words. This is the punch ("THE OFFSHORE LIFE", "EVERY ADVENTURE", "CRISPY OIL"). Keep it BRAND-FOCUSED, not product-specific.`);
      lines.push(`    Together they must read as ONE headline: lead + " " + main. Good: lead="WHY ANGLERS TRUST" / main="${(brandName || 'THIS BRAND').toUpperCase()}". Bad: a complete sentence in the lead.`);
      lines.push(`- Also emit "copy.headline" as the joined "<headline_lead> <headline_main>" string for downstream compatibility.`);
    } else {
      lines.push(`- "copy.headline" REQUIRED, ≤ 8 words. Must be BRAND-FOCUSED, not product-specific.`);
      lines.push(`    Good examples: "Built for the offshore life", "Why anglers trust ${brandName || 'us'}", "Made for every adventure", "${brandName || 'Brand'}: gear that lasts".`);
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
      lines.push(`- "copy.headline_lead" REQUIRED — the small first clause of a stacked display-script headline. MAX ${hb.lead.max_chars} characters, ${hb.lead.max_lines} line, ~${hb.lead.max_words} words. Renders at HALF the size of headline_main, so it carries a setup phrase ("SAY HELLO TO", "MEET THE", "SOMETHING NEW IS").`);
      lines.push(`- "copy.headline_main" REQUIRED — the large second clause. MAX ${hb.main.max_chars} characters across ${hb.main.max_lines} line(s), ~${hb.main.max_words} words. The punch ("HOT CRISPY OIL", "COMING IN HOT", "THE NEW ESSENTIAL").`);
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
    lines.push(`- "badges" 2–4 items, each 1–3 words. Examples supported by data: "4.7★ rated" if rating ≥ 4.5; "1k+ reviews" if reviewCount ≥ 1000; "Top rated", "Editor's pick", "Best seller". Prefer real signal over filler.`);
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
// short primary quote from its first sentence. Keeps hero zones populated in
// the low-signal case. Never invents text — only surfaces what Gemini
// already wrote in the review-summary step.
function synthesizeQuoteFromReviewSummary(ctx) {
  const summary = ctx.match?.identification?.details?.reviewSummary?.summary;
  if (!summary || typeof summary !== 'string') return null;
  const first = summary.trim().split(/(?<=[.!?])\s+/)[0];
  if (!first || first.length < 20 || first.length > 220) return null;
  return {
    text:     first,
    source:   'review',
    verified: false
  };
}

// Rating/review-driven badge defaults when the LLM returned none. Fills the
// badge_row / product.badges / social_proof.proof_badges slots that
// otherwise render as placeholders.
function defaultBadgesFromSignal(details) {
  const out = [];
  if (typeof details.rating === 'number' && details.rating >= 4.5) out.push('Top rated');
  if (typeof details.reviewCount === 'number') {
    if (details.reviewCount >= 10000) out.push('10k+ reviews');
    else if (details.reviewCount >= 1000) out.push('1k+ reviews');
    else if (details.reviewCount >= 100)  out.push('100+ reviews');
  }
  return out;
}

function fallbackDerivation(ctx) {
  const ident = ctx.match?.identification || {};
  return {
    quotes: [],
    short_benefits: [],
    badges: [],
    copy: {
      headline:       ident.productName ? `Meet ${ident.productName}` : 'See why customers love it',
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
function assembleInput(ctx, template, aspectRatio, options, derivation) {
  const { media, detection, match, brand } = ctx;
  const ident   = match?.identification || {};
  const details = ident.details || {};
  const palette = detection?.background?.palette || [];

  // testimonial_spotlight uses the 4:5 source crop for ALL canvas
  // ratios — its layouts are built so the renderer's c_fill,g_auto
  // chain can subject-aware-crop the 4:5 source into whatever rect the
  // canvas asks for (full-bleed in landscape, left half in 1:1, top
  // half in 4:5). Using the 4:5 source instead of a ratio-matched
  // crop gives Cloudinary the most pixels to crop from and avoids
  // double-cropping artifacts.
  const heroSourceRatio = (template === 'testimonial_spotlight') ? '4:5' : aspectRatio;
  const heroMedia      = pickHeroMedia(ctx, heroSourceRatio);
  const secondaryMedia = pickSecondaryMedia(ctx, aspectRatio);
  const creatorMedia   = pickCreatorMedia(ctx);
  const ugcMedia       = creatorMedia;  // detect uploads == creator post asset

  const quotes = Array.isArray(derivation.quotes) ? derivation.quotes.slice() : [];

  // Synthesis fallback — if the LLM emitted no quotes but a review summary
  // exists, carve the first sentence out as a primary quote so hero zones
  // aren't blank. Cheap, deterministic, and clearly grounded.
  if (quotes.length === 0) {
    const syn = synthesizeQuoteFromReviewSummary(ctx);
    if (syn) quotes.push(syn);
  }

  // Branding-outcome quote injection. When the matching service couldn't
  // identify a specific product but did pull brand-level reviews, use
  // those quotes so the testimonial templates still have hero copy.
  if (ctx.match?.outcome === 'brand_match' && Array.isArray(ctx.match?.brandReviews?.quotes)) {
    for (const q of ctx.match.brandReviews.quotes) {
      if (q?.text) quotes.push({ text: q.text, author_name: q.author || q.source || 'Verified buyer' });
    }
  }

  const primaryQuote = quotes[0] ? { ...quotes[0] } : null;
  const secondaryQuotes = quotes.slice(1).map(q => ({ ...q }));

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
      name:          (match?.catalogProductId
                        ? (details.title || ident.productName)
                        : (ident.productName || details.title))
                     || brandName
                     || 'Product',
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
      // Catalog-stock fallback. Direct CatalogProduct.imageUrl —
      // distinct from hero_media which is always source-Media-derived
      // (smart crops of the post being matched). Templates that want
      // to gracefully degrade when no source Media exists (e.g. brands
      // with only manual-upload catalog rows) put product.image at the
      // end of their canvas/background source_priority chain. Empty
      // when CatalogProduct isn't linked or has no imageUrl.
      image:           details.imageUrl || undefined,
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
      }))
    },

    creator: {
      name:     media.metadata?.creatorName   || undefined,
      handle:   media.metadata?.creatorHandle || undefined,
      platform: DEFAULT_CREATOR_PLATFORM,
      avatar:   undefined,                                // not derived yet; future persona-avatar gen slot
      portrait_media: mediaPair(creatorMedia)
    },

    ugc: {
      post_id:         media.externalId,
      platform:        DEFAULT_CREATOR_PLATFORM,
      post_type:       DEFAULT_POST_TYPE,
      caption:         media.metadata?.caption || undefined,
      media:           mediaPair(ugcMedia),
      likes:           media.platformStats?.likes    ?? undefined,
      comments:        media.platformStats?.comments ?? undefined,
      shares:          media.platformStats?.shares   ?? undefined,
      saves:           media.platformStats?.saves    ?? undefined,
      rights_approved: rightsApproved
    },

    social_proof: {
      // For 'branding' outcome (no SKU) fall back to brand-level rating /
      // review_count from Gemini brand-reviews lookup so the proof bar
      // isn't blank when only brand sentiment is available.
      rating_value:    typeof details.rating === 'number'
                          ? details.rating
                          : (ctx.match?.outcome === 'brand_match' && typeof ctx.match?.brandReviews?.rating === 'number'
                              ? ctx.match.brandReviews.rating : undefined),
      review_count:    typeof details.reviewCount === 'number'
                          ? details.reviewCount
                          : (ctx.match?.outcome === 'brand_match' && typeof ctx.match?.brandReviews?.reviewCount === 'number'
                              ? ctx.match.brandReviews.reviewCount : undefined),
      trusted_by_text: derivation.trusted_by_text || trustedByFromStats(details) || undefined,
      proof_badges:    limitArray(derivedBadges, 4),
      primary_quote:   primaryQuote || undefined,
      secondary_quotes: secondaryQuotes.length ? secondaryQuotes : undefined
    },

    performance: {
      engagement: stripEmpty({
        likes:    media.platformStats?.likes    ?? undefined,
        comments: media.platformStats?.comments ?? undefined,
        shares:   media.platformStats?.shares   ?? undefined,
        saves:    media.platformStats?.saves    ?? undefined,
        views:    media.platformStats?.views    ?? undefined
      }),
      metrics: buildPerformanceMetrics(media, match)
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
      subheadline:    derivation.copy?.subheadline || brand?.tagline || undefined,
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
    media: {
      palette:           palette || [],
      palette_dominant:  palette[0] || null,
      palette_accent:    palette[1] || null,
      palette_neutral:   palette[2] || null,
      // Most-saturated color from the palette regardless of dominance
      // rank. The detect pipeline returns palette[] in dominance order,
      // which puts a deep-black backdrop at index 0 even when the
      // eye-catching highlights (flame orange on black) are what the
      // creative should LEAD with. palette_vibrant fixes that for
      // image-led templates by walking the array and returning the
      // entry with highest saturation. Falls back to palette_accent.
      palette_vibrant:   pickVibrantColor(palette) || palette[1] || palette[0] || null,
      background_setting:     detection?.background?.setting     || null,
      background_lighting:    detection?.background?.lighting    || null,
      background_style:       detection?.background?.style       || null,
      background_description: detection?.background?.description || null
    },

    layout_options: options.layout_options || {
      show_logo:           !!brand?.logoUrl,
      show_price:          !!(details.price?.display || details.price?.value),
      show_rating:         typeof details.rating === 'number',
      show_review_count:   typeof details.reviewCount === 'number',
      show_creator_handle: !!media.metadata?.creatorHandle,
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
    try {
      const placement = computeOverlayPlacement(ctx, aspectRatio, options, input);
      if (placement) input.placement = placement;
    } catch (err) {
      console.warn(`   ⚠️  overlay placement failed for ${template} ${aspectRatio}: ${err.message}`);
    }
  }

  return stripUndefinedDeep(input);
}

// Picks the analyzed image to use as full-bleed background and runs the
// placement algorithm against its overlay-zone analysis. Returns the
// `placement` block to attach to the input, or null if no analyzed image
// is available for this aspect ratio.
function computeOverlayPlacement(ctx, aspectRatio, options, content) {
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

  const result = placeOverlays({
    canvasW, canvasH,
    aspectRatio,
    analysis:     overlayPick.analysis,  // may be null — placement handles it
    conservation,
    content,
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
function pickHeroMedia(ctx, aspectRatio) {
  const { media, detection, crops, extended } = ctx;
  const out = { image: null, video: null };
  const baseRatios = ['5:4', '1:1', '4:5'];

  if (baseRatios.includes(aspectRatio)) {
    const product = pickTopYoloProduct(detection);
    if (product && detection?.imageUrl) {
      out.image = buildCloudinaryCropUrl(detection.imageUrl, product);
      if (media.fileType === 'video' && media.fileUrl) {
        out.video = buildCloudinaryCropUrl(media.fileUrl, product);
      }
      return out;
    }
    const winnerId = crops?.winners?.[aspectRatio];
    const list = crops?.smartCrops?.[aspectRatio] || [];
    const winner = list.find(c => c.id === winnerId) || list[0];
    if (winner && detection?.imageUrl) {
      out.image = buildCloudinaryCropUrl(detection.imageUrl, winner);
    }
    if (media.fileType === 'video' && media.fileUrl && winner) {
      out.video = buildCloudinaryCropUrl(media.fileUrl, winner);
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
  return best;
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
  loadContext
};
