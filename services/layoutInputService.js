// Layout input service. On-demand builder: given (mediaId, template,
// aspectRatio), assembles the canonical RS Social Proof Creative Input JSON
// the renderer consumes. One Gemini structured-output call derives
// subjective fields (quotes, copy, benefits, badges, theme hints, CTA,
// trusted_by_text); everything else is deterministic mapping from detect
// artifacts + Brand catalog + Media metadata.
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
const LayoutInputArtifact    = require('../models/LayoutInputArtifact');
const { findBrandByName }    = require('./brandCatalogService');
const registry               = require('./templateRegistry');

const GEMINI_MODEL    = process.env.GEMINI_SEARCH_MODEL || 'gemini-2.5-pro';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

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
    if (cached) return cached.input;
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
    const input = assembleInput(ctx, tmpl.template_id, aspectRatio, {}, stubDerivation);
    results.push(registry.validateInputAgainstTemplate(input, tmpl.template_id));
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

  const [detection, crops, extended, match] = await Promise.all([
    media.latestArtifacts?.detection ? DetectionArtifact.findById(media.latestArtifacts.detection).lean()    : null,
    media.latestArtifacts?.crops     ? CropArtifact.findById(media.latestArtifacts.crops).lean()              : null,
    media.latestArtifacts?.extended  ? ExtendedCropArtifact.findById(media.latestArtifacts.extended).lean()   : null,
    media.latestArtifacts?.match     ? ProductMatchArtifact.findById(media.latestArtifacts.match).lean()      : null
  ]);
  const runId = detection?.runId || null;
  const brandName = match?.identification?.brand || media.metadata?.brand || null;
  const brand = brandName
    ? await findBrandByName(brandName).then(b => b?.toObject?.() || b).catch(() => null)
    : null;

  return { media, detection, crops, extended, match, brand, runId };
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

  lines.push(`TASK:`);
  lines.push(`Produce JSON matching the schema. Rules:`);
  lines.push(`- "copy.headline" ≤ 8 words. "subheadline" ≤ 15 words. "eyebrow" ≤ 3 words. "highlight_text" ≤ 5 words.`);
  lines.push(`- "short_benefits" ≤ 5 items, each ≤ 6 words, phrased as concrete buyer benefits (not specs).`);
  lines.push(`- "badges" ≤ 4 items, each 1–3 words. Only emit a badge the signal supports (e.g. "4.7★ rated" only if rating ≥ 4.5).`);
  if (demos.length) {
    lines.push(`- "quotes" up to 6 NOTIONAL persona-authored reviews/comments. Use the BRAND KEY PERSONAS above as the quote voices — match each quote to a persona's vocabulary, concerns, and tone. author_name is the persona's name; author_title is a one-phrase identity cue; source="testimonial" or "ugc". Ground substance in the review summary. verified=true only if the brand has well-documented social proof. ≤ 22 words per quote; mix lengths.`);
  } else {
    lines.push(`- "quotes" up to 6 short notional reviews/comments drawn from the review summary. author_name can be null; source="review" unless signal clearly implies creator/ugc. verified=false unless clearly endorsed. ≤ 20 words per quote.`);
  }
  lines.push(`- "cta.text" ≤ 3 words, imperative voice (e.g. "Shop now"). "offer_text" only if price/offer data supports it.`);
  lines.push(`- "trusted_by_text" only if review_count ≥ 50 — format "Trusted by Xk+ customers" or similar. Otherwise omit.`);
  lines.push(`- "tone" 2–4 single-word descriptors matching brand + caption voice.`);
  lines.push(`- "theme_style" / "background_style" / "emphasis" pick values best suited to the template and signal.`);
  lines.push(`If a field has no real signal, prefer omitting over fabricating.`);
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

  const quotes = Array.isArray(derivation.quotes) ? derivation.quotes : [];
  const primaryQuote = quotes[0] ? { ...quotes[0] } : null;
  const secondaryQuotes = quotes.slice(1).map(q => ({ ...q }));

  const rightsApproved = !!media.rights?.approved;
  const brandName = ident.brand || media.metadata?.brand || brand?.name || null;

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
      badges:         limitArray(derivation.badges, 4),
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
      proof_badges:    limitArray(derivation.badges, 4),
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

  return stripUndefinedDeep(input);
}

// ──────────────────────────────────────────────────────────────
//  Media resolution helpers
// ──────────────────────────────────────────────────────────────
function pickHeroMedia(ctx, aspectRatio) {
  const { media, detection, crops, extended } = ctx;
  const out = { image: null, video: null };
  const baseRatios = ['5:4', '1:1', '4:5'];

  if (baseRatios.includes(aspectRatio)) {
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
// content: for video, hero frame = image, source URL = video; for image,
// source URL = image, video = null.
function pickCreatorMedia(ctx) {
  const { media, detection } = ctx;
  const out = { image: null, video: null };
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
      if (Array.isArray(cleaned) && cleaned.length === 0) continue;
      if (typeof cleaned === 'object' && !Array.isArray(cleaned) && Object.keys(cleaned).length === 0) continue;
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
