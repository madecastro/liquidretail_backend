// Layout input service. On-demand per (mediaId, template, aspectRatio) →
// assembled RS Social Proof Creative Input JSON the downstream renderer
// consumes. Cached via LayoutInputArtifact (unique on that tuple); repeat
// requests return the cache unless `refresh: true` is passed.
//
// One LLM call per build: Gemini 2.5 Pro with structured output derives the
// subjective fields (quotes, copy, benefits, badges, theme hints). Everything
// else is direct mapping / deterministic transformation from the detect
// artifacts + Brand catalog + Media metadata. See docs in repo on the
// mapping; when a field has no source we emit null / omit per schema.

const axios = require('axios');

const Media                  = require('../models/Media');
const DetectRun              = require('../models/DetectRun');
const DetectionArtifact      = require('../models/DetectionArtifact');
const CropArtifact           = require('../models/CropArtifact');
const ExtendedCropArtifact   = require('../models/ExtendedCropArtifact');
const ProductMatchArtifact   = require('../models/ProductMatchArtifact');
const LayoutInputArtifact    = require('../models/LayoutInputArtifact');
const { findBrandByName }    = require('./brandCatalogService');

const GEMINI_MODEL = process.env.GEMINI_SEARCH_MODEL || 'gemini-2.5-pro';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const TEMPLATES = ['testimonial_spotlight', 'ugc_split_screen', 'review_collage', 'results_proof', 'creator_endorsement'];
const ASPECT_RATIOS = ['1:1', '4:5', '9:16', '16:9', '1.91:1'];

// Derivation response schema enforced via Gemini responseSchema. These are the
// fields the LLM is actually responsible for — everything else is assembled
// deterministically from detect artifacts.
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
    short_benefits: { type: 'array', items: { type: 'string' } },
    badges:         { type: 'array', items: { type: 'string' } },
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
    tone:             { type: 'array', items: { type: 'string' } },
    theme_style:      { type: 'string', enum: ['clean', 'modern', 'editorial', 'bold', 'playful', 'luxury'] },
    background_style: { type: 'string', enum: ['solid', 'gradient', 'soft-blur', 'card-stack', 'minimal'] },
    emphasis:         { type: 'string', enum: ['product-first', 'quote-first', 'ugc-first', 'metrics-first'] }
  },
  required: ['cta', 'copy', 'theme_style', 'emphasis']
};

async function buildLayoutInput({ mediaId, template, aspectRatio, options = {}, refresh = false }) {
  if (!TEMPLATES.includes(template))         throw badRequest(`Unknown template: ${template}`);
  if (!ASPECT_RATIOS.includes(aspectRatio))  throw badRequest(`Unknown aspect_ratio: ${aspectRatio}`);

  // Cache lookup
  if (!refresh) {
    const cached = await LayoutInputArtifact.findOne({ mediaId, template, aspectRatio }).lean();
    if (cached) return cached.input;
  }

  // Load media + all latest artifacts
  const ctx = await loadContext(mediaId);
  if (!ctx) throw notFound(`Media ${mediaId} not found`);

  // Run the single derivation LLM call
  const derivation = await runDerivation(ctx, template, aspectRatio, options);

  // Assemble the full input
  const input = assembleInput(ctx, template, aspectRatio, options, derivation);

  // Cache it (replace any prior doc for the same tuple)
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

async function loadContext(mediaId) {
  const media = await Media.findById(mediaId).lean();
  if (!media) return null;
  const runId = media.latestArtifacts?.detection ? await mostRecentRunIdFor(media.latestArtifacts.detection) : null;
  const [detection, crops, extended, match] = await Promise.all([
    media.latestArtifacts?.detection    ? DetectionArtifact.findById(media.latestArtifacts.detection).lean()    : null,
    media.latestArtifacts?.crops        ? CropArtifact.findById(media.latestArtifacts.crops).lean()              : null,
    media.latestArtifacts?.extended     ? ExtendedCropArtifact.findById(media.latestArtifacts.extended).lean()   : null,
    media.latestArtifacts?.match        ? ProductMatchArtifact.findById(media.latestArtifacts.match).lean()      : null
  ]);
  const brandName = match?.identification?.brand || media.metadata?.brand || null;
  const brand = brandName ? await findBrandByName(brandName).then(b => b?.toObject?.() || b).catch(() => null) : null;
  return { media, detection, crops, extended, match, brand, runId };
}

async function mostRecentRunIdFor(artifactId) {
  const a = await DetectionArtifact.findById(artifactId).select('runId').lean();
  return a?.runId || null;
}

async function runDerivation(ctx, template, aspectRatio, options) {
  if (!process.env.GEMINI_API_KEY) {
    // No LLM — return a safe minimum so assembly still produces a valid
    // (if bland) input.
    return fallbackDerivation(ctx);
  }

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
  lines.push(`  Platform: ${media.source}`);
  if (media.metadata?.caption) lines.push(`  Caption: "${media.metadata.caption}"`);
  if (media.platformStats) {
    const s = media.platformStats;
    const stats = ['likes','comments','shares','saves','views'].map(k => s[k] != null ? `${k}=${s[k]}` : null).filter(Boolean).join(', ');
    if (stats) lines.push(`  Stats: ${stats}`);
  }
  if (detection?.transcript?.text) lines.push(`  Transcript: "${String(detection.transcript.text).slice(0, 800)}"`);
  lines.push('');
  lines.push('REVIEW SIGNAL:');
  if (typeof details.rating === 'number')     lines.push(`  Rating: ${details.rating}`);
  if (typeof details.reviewCount === 'number') lines.push(`  Review count: ${details.reviewCount}`);
  if (details.reviewSummary?.summary) {
    lines.push(`  Review summary: ${details.reviewSummary.summary}`);
  }
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
  lines.push(`TASK:`);
  lines.push(`Produce JSON that matches the provided schema. Rules:`);
  lines.push(`- "copy.headline" ≤ 8 words. "subheadline" ≤ 15 words. "eyebrow" ≤ 3 words. "highlight_text" ≤ 5 words.`);
  lines.push(`- "short_benefits" ≤ 5 items, each ≤ 6 words, phrased as concrete buyer benefits (not specs).`);
  lines.push(`- "badges" ≤ 4 items, each 1–3 words. Only emit a badge the signal actually supports (e.g. "4.7★ rated" only if rating ≥ 4.5).`);
  lines.push(`- "quotes" up to 6. Synthesize from the review summary — do NOT invent specific reviewer names. Set author_name to null and source="review" unless signal is obviously creator/ugc. Set verified=false unless clearly endorsed. Keep text ≤ 20 words per quote.`);
  lines.push(`- "cta.text" ≤ 3 words, imperative voice (e.g. "Shop now", "See reviews"). "offer_text" only if price/offer data supports it; otherwise omit.`);
  lines.push(`- "tone" 2–4 single-word descriptors matching the brand + caption voice.`);
  lines.push(`- "theme_style" / "background_style" / "emphasis" pick values best suited to the template and available signal.`);
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
      headline:    ident.productName ? `Meet ${ident.productName}` : 'See why customers love it',
      subheadline: '',
      eyebrow:     ident.brand || '',
      highlight_text: ''
    },
    cta: { text: 'Shop now' },
    tone: [],
    theme_style:      'clean',
    background_style: 'soft-blur',
    emphasis:         'product-first'
  };
}

// ── Assembly ─────────────────────────────────────────────────────────────

function assembleInput(ctx, template, aspectRatio, options, derivation) {
  const { media, detection, crops, extended, match, brand } = ctx;
  const ident   = match?.identification || {};
  const details = ident.details || {};
  const palette = detection?.background?.palette || [];

  const hero      = pickHeroImageUrl(ctx, aspectRatio);
  const secondary = pickSecondaryImageUrl(ctx, aspectRatio);

  const rightsApproved = !!media.rights?.approved;

  const input = {
    template,
    aspect_ratio: aspectRatio,

    theme: {
      style:            derivation.theme_style      || 'clean',
      background_style: derivation.background_style || 'soft-blur',
      emphasis:         derivation.emphasis         || 'product-first'
    },

    brand: {
      name:            ident.brand || media.metadata?.brand || brand?.name || 'Brand',
      tagline:         brand?.tagline || undefined,
      logo_url:        brand?.logoUrl || undefined,
      primary_color:   brand?.primaryColor   || palette[0] || undefined,
      secondary_color: brand?.secondaryColor || palette[1] || undefined,
      accent_color:    brand?.accentColor    || palette[2] || undefined,
      font_family:     brand?.fontFamily || undefined,
      tone:            (brand?.tone?.length ? brand.tone : derivation.tone) || undefined
    },

    product: {
      id:             details.productId || undefined,
      name:           ident.productName || details.title || 'Product',
      category:       media.metadata?.category || firstYoloCategory(detection) || undefined,
      price:          details.price?.value ?? details.price?.display ?? undefined,
      currency:       details.price?.currency || undefined,
      hero_image_url: hero || media.fileUrl,
      secondary_image_url: secondary || undefined,
      description:    details.description || detection?.primarySubjectDesc || undefined,
      short_benefits: limitArray(derivation.short_benefits, 5),
      badges:         limitArray(derivation.badges, 4)
    },

    ugc: {
      post_id:        media.externalId,
      platform:       normalizePlatform(media.source),
      image_url:      detection?.imageUrl || media.fileUrl,
      caption:        media.metadata?.caption || undefined,
      creator_name:   media.metadata?.creatorName   || undefined,
      creator_handle: media.metadata?.creatorHandle || undefined,
      likes:          media.platformStats?.likes    ?? undefined,
      comments:       media.platformStats?.comments ?? undefined,
      shares:         media.platformStats?.shares   ?? undefined,
      saves:          media.platformStats?.saves    ?? undefined,
      rights_approved: rightsApproved,
      post_type:       media.source === 'manual_upload' ? 'branded' : 'ugc'
    },

    social_proof: {
      rating:       typeof details.rating === 'number' ? details.rating : undefined,
      review_count: typeof details.reviewCount === 'number' ? details.reviewCount : undefined,
      proof_badges: limitArray(derivation.badges, 4),
      quotes:       limitArray(derivation.quotes, 6)
    },

    performance_metrics: buildPerformanceMetrics(media, match),

    cta: mergeCta(derivation.cta, options.cta, details),

    trust_markers: {
      retailer_logos: buildRetailerLogos(details.sellers)
    },

    copy: stripEmpty({
      headline:       derivation.copy?.headline,
      subheadline:    derivation.copy?.subheadline,
      eyebrow:        derivation.copy?.eyebrow,
      highlight_text: derivation.copy?.highlight_text,
      disclaimer:     options.disclaimer
    }),

    layout_options: options.layout_options || {
      show_logo:          !!brand?.logoUrl,
      show_price:         !!(details.price?.display || details.price?.value),
      show_rating:        typeof details.rating === 'number',
      show_review_count:  typeof details.reviewCount === 'number',
      show_creator_handle: !!media.metadata?.creatorHandle && rightsApproved,
      show_engagement:    !!media.platformStats && rightsApproved,
      show_badges:        (derivation.badges?.length || 0) > 0,
      show_cta:           true
    }
  };

  return stripUndefinedDeep(input);
}

function pickHeroImageUrl(ctx, ratio) {
  const { detection, crops, extended } = ctx;
  const base = ['5:4', '1:1', '4:5'];
  if (base.includes(ratio)) {
    const winnerId = crops?.winners?.[ratio];
    const list = crops?.smartCrops?.[ratio] || [];
    const winner = list.find(c => c.id === winnerId) || list[0];
    if (winner && detection?.imageUrl) return buildCloudinaryCropUrl(detection.imageUrl, winner);
  }
  if (ratio === '9:16' || ratio === '1.91:1') {
    const winnerRef = extended?.selectedWinners?.[ratio]?.candidateId;
    const list = extended?.candidates?.[ratio] || [];
    const winner = list.find(c => c.id === winnerRef) || list.find(c => c.provider === 'gemini') || list[0];
    if (winner?.imageUrl) return winner.imageUrl;
  }
  // 16:9 isn't produced yet — fall back to source.
  return detection?.imageUrl || null;
}

function pickSecondaryImageUrl(ctx, heroRatio) {
  // Pick a different ratio's winner as the secondary, preferring a contrasting
  // orientation (portrait hero → landscape secondary and vice versa).
  const order = heroRatio === '9:16' || heroRatio === '4:5'
    ? ['1.91:1', '5:4', '1:1', '4:5', '9:16']
    : ['4:5', '1:1', '9:16', '1.91:1', '5:4'];
  for (const r of order) {
    if (r === heroRatio) continue;
    const url = pickHeroImageUrl(ctx, r);
    if (url && url !== pickHeroImageUrl(ctx, heroRatio)) return url;
  }
  return null;
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

function firstYoloCategory(detection) {
  const det = (detection?.yoloProducts || []).find(d => d.identification?.category);
  return det?.identification?.category || null;
}

function normalizePlatform(source) {
  if (!source) return 'other';
  const map = { meta: 'facebook', instagram: 'instagram', tiktok: 'tiktok', youtube: 'youtube', manual_upload: 'other' };
  return map[source] || 'other';
}

function buildPerformanceMetrics(media, match) {
  const metrics = [];
  const stats = media.platformStats || {};
  if (typeof stats.views    === 'number' && stats.views    > 0) metrics.push({ label: 'Views',    value: formatCount(stats.views) });
  if (typeof stats.likes    === 'number' && stats.likes    > 0) metrics.push({ label: 'Likes',    value: formatCount(stats.likes) });
  if (typeof stats.comments === 'number' && stats.comments > 0) metrics.push({ label: 'Comments', value: formatCount(stats.comments) });
  if (typeof stats.shares   === 'number' && stats.shares   > 0) metrics.push({ label: 'Shares',   value: formatCount(stats.shares) });
  const rating = match?.identification?.details?.rating;
  const reviewCount = match?.identification?.details?.reviewCount;
  if (typeof rating === 'number')      metrics.push({ label: 'Rating',      value: `${rating.toFixed(1)}★` });
  if (typeof reviewCount === 'number') metrics.push({ label: 'Reviews',     value: formatCount(reviewCount) });
  return metrics.slice(0, 6);
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
  const primarySellerUrl = Array.isArray(details.sellers) && details.sellers[0]?.link ? details.sellers[0].link : null;
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
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v == null || v === '') continue;
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

module.exports = { buildLayoutInput, TEMPLATES, ASPECT_RATIOS };
