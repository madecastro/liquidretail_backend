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
const { findBrandByName }    = require('./brandCatalogService');
const { placeOverlays }      = require('./overlayPlacementService');
const registry               = require('./templateRegistry');

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
// tighter spaces than before.
const INPUT_SCHEMA_VERSION = '2.4';

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
        headline:       { type: 'string' },
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

  const [detection, crops, extended, match, overlayZones] = await Promise.all([
    media.latestArtifacts?.detection    ? DetectionArtifact.findById(media.latestArtifacts.detection).lean()    : null,
    media.latestArtifacts?.crops        ? CropArtifact.findById(media.latestArtifacts.crops).lean()              : null,
    media.latestArtifacts?.extended     ? ExtendedCropArtifact.findById(media.latestArtifacts.extended).lean()   : null,
    media.latestArtifacts?.match        ? ProductMatchArtifact.findById(media.latestArtifacts.match).lean()      : null,
    media.latestArtifacts?.overlayZones ? OverlayZoneArtifact.findById(media.latestArtifacts.overlayZones).lean(): null
  ]);
  const runId = detection?.runId || null;
  const brandName = match?.identification?.brand || media.metadata?.brand || null;
  const brand = brandName
    ? await findBrandByName(brandName).then(b => b?.toObject?.() || b).catch(() => null)
    : null;

  return { media, detection, crops, extended, match, overlayZones, brand, runId };
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
  const { media, detection, match } = ctx;
  const ident = match?.identification || {};
  const details = ident.details || {};
  const lines = [];

  lines.push(`You are composing creative copy for a social-proof ad layout.`);
  lines.push(`Template: ${template} (${templateIntent(template)}).`);
  lines.push(`Aspect ratio: ${aspectRatio}.`);
  if (options.tone_hint) lines.push(`Caller tone hint: ${options.tone_hint}.`);
  lines.push('');
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
  lines.push('REVIEW SIGNAL:');
  if (typeof details.rating === 'number')      lines.push(`  Rating: ${details.rating}`);
  if (typeof details.reviewCount === 'number') lines.push(`  Review count: ${details.reviewCount}`);
  if (details.reviewSummary?.summary)          lines.push(`  Review summary: ${details.reviewSummary.summary}`);
  lines.push('');
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
  lines.push(`- "copy.headline" REQUIRED, ≤ 8 words. "subheadline" ≤ 15 words. "eyebrow" ≤ 3 words. "highlight_text" ≤ 5 words.`);
  lines.push(`- "short_benefits" 3–5 items, each ≤ 6 words, concrete buyer benefits (not specs).`);
  lines.push(`- "badges" 2–4 items, each 1–3 words. Examples supported by data: "4.7★ rated" if rating ≥ 4.5; "1k+ reviews" if reviewCount ≥ 1000; "Top rated", "Editor's pick", "Best seller". Prefer real signal over filler.`);
  // Quote length target depends on template — narrow zones (split-screen
  // quote_bubble, review_collage cards) clip on mobile when quotes run long.
  const quoteLengthRule = (template === 'ugc_split_screen' || template === 'review_collage')
    ? '10–14 words and UNDER 90 characters each (split-screen / collage zones clip at 4 lines on narrow canvases)'
    : '12–18 words, ≤ 120 characters each';

  if (demos.length) {
    lines.push(`- "quotes" ${quoteTarget} NOTIONAL persona-authored reviews/comments. Use the BRAND KEY PERSONAS above as the quote voices — match each quote to a persona's vocabulary, concerns, and tone. author_name is the persona's name; author_title is a one-phrase identity cue; source="testimonial" or "ugc". Ground substance in the review summary. verified=true only if the brand has well-documented social proof. Target ${quoteLengthRule}. Mix angles across quotes.`);
  } else {
    lines.push(`- "quotes" ${quoteTarget} short notional reviews/comments drawn from the review summary. author_name can be null; source="review" unless signal clearly implies creator/ugc. verified=false unless clearly endorsed. Target ${quoteLengthRule}. Mix angles.`);
  }
  lines.push(`- "cta.text" REQUIRED, ≤ 3 words, imperative voice (e.g. "Shop now"). "offer_text" only if price/offer data supports it.`);
  lines.push(`- "trusted_by_text" preferred if review_count ≥ 50 — format "Trusted by Xk+ customers", "Loved by Nk shoppers", etc.`);
  lines.push(`- "tone" 2–4 single-word descriptors matching brand + caption voice.`);
  lines.push(`- "theme_style" / "background_style" / "emphasis" pick values best suited to the template and signal.`);
  lines.push(`Goal: the output must FILL the template's visible zones. If a template needs multiple quotes / badges / benefits and you have enough source material, produce them. Do not invent specific reviewer names, retailer names, or pricing that aren't grounded in the data.`);
  return lines.join('\n');
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

  const heroMedia      = pickHeroMedia(ctx, aspectRatio);
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
      name:          ident.productName || details.title || 'Product',
      category:      media.metadata?.category || firstYoloCategory(detection) || undefined,
      price:         details.price?.value ?? details.price?.display ?? undefined,
      currency:      details.price?.currency || undefined,
      description:   details.description || detection?.primarySubjectDesc || undefined,
      short_benefits: limitArray(derivation.short_benefits, 5),
      badges:         limitArray(derivedBadges, 4),
      hero_media:      mediaPair(heroMedia),
      secondary_media: mediaPair(secondaryMedia)
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
      rating_value:    typeof details.rating === 'number' ? details.rating : undefined,
      review_count:    typeof details.reviewCount === 'number' ? details.reviewCount : undefined,
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

    cta: mergeCta(derivation.cta, options.cta, details),

    trust: stripEmpty({
      retailer_logos:  buildRetailerLogos(details.sellers),
      trusted_by_text: derivation.trusted_by_text || trustedByFromStats(details) || undefined,
      certifications:  undefined,
      press_mentions:  undefined
    }),

    copy: stripEmpty({
      headline:       derivation.copy?.headline,
      subheadline:    derivation.copy?.subheadline,
      eyebrow:        derivation.copy?.eyebrow,
      highlight_text: derivation.copy?.highlight_text,
      disclaimer:     options.disclaimer
    }),

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
      fallback_quote:    'Customers love it.',
      fallback_headline: brandName ? `See why ${brandName} customers come back` : 'See why they come back',
      cta_text:          'Shop now',
      product_name:      ident.productName || 'This product'
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
  //   v3 array: [{ provider, variant, candidateId, imageUrl, analysis }]
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
  const det = (detection?.yoloProducts || []).find(d => d.identification?.category);
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

function mergeCta(derivedCta, callerCta, details) {
  const primarySellerUrl = Array.isArray(details.sellers) && details.sellers[0]?.link
    ? details.sellers[0].link
    : null;
  return stripEmpty({
    text:       callerCta?.text       || derivedCta?.text       || 'Shop now',
    url:        callerCta?.url        || primarySellerUrl       || undefined,
    subtext:    callerCta?.subtext    || derivedCta?.subtext    || undefined,
    offer_text: callerCta?.offer_text || derivedCta?.offer_text || undefined
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
