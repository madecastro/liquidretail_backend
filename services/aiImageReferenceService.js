// Phase X.1 (shadow experiment) — AI Image Reference.
//
// For each AiCanvasArtifact we generate, also fire a single gpt-image-1
// call that synthesizes a complete ad from the SAME Director concept +
// brand/product context. The output is persisted as AiFullRenderArtifact
// and surfaced side-by-side with the deterministic render in the spec
// preview, so we can eyeball the gap between "what our layout pipeline
// can compose" vs "what raw image gen produces from the same brief."
//
// Opt-in: set AI_IMAGE_REFERENCE_ENABLED=true to enable. Off by default
// because image gen runs $0.042/call medium quality 1024² — a 24-ad
// batch is ~$1 of image-gen cost on top of the LLM spend.
//
// Shadow only — no caller relies on the result for the render path.

const crypto       = require('crypto');
const axios        = require('axios');
const OpenAI       = require('openai');
const { toFile }   = require('openai');

const Brand                     = require('../models/Brand');
const CatalogProduct            = require('../models/CatalogProduct');
const Media                     = require('../models/Media');
const Comment                   = require('../models/Comment');
const AiCanvasArtifact          = require('../models/AiCanvasArtifact');
const AiFullRenderArtifact      = require('../models/AiFullRenderArtifact');
const CreativeDirectionArtifact = require('../models/CreativeDirectionArtifact');
const { uploadBufferToCloudinary } = require('./cloudinaryService');
const { trackLlmCall, recordCacheHit } = require('./costTracker');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MODEL_ID = 'gpt-image-1';
const QUALITY  = 'medium';     // low=$0.011 / medium=$0.042 / high=$0.167 (1024²)

// gpt-image-1 only supports these three sizes.
function sizeForRatio(aspectRatio) {
  switch (String(aspectRatio || '').trim()) {
    case '9:16':
    case '4:5':   return { size: '1024x1536', width: 1024, height: 1536 };
    case '1.91:1':
    case '5:4':   return { size: '1536x1024', width: 1536, height: 1024 };
    case '1:1':
    default:      return { size: '1024x1024', width: 1024, height: 1024 };
  }
}

// Per-call USD estimate (medium tier). Keeps cost telemetry comparable
// to the LLM stages; not authoritative for billing.
function estimateCostUsd(size) {
  if (size === '1024x1024') return 0.042;
  return 0.063;
}

function enabled() {
  return String(process.env.AI_IMAGE_REFERENCE_ENABLED || '').toLowerCase() === 'true';
}

// ── Public API ───────────────────────────────────────────────────────

async function generateForArtifact({ aiCanvasArtifactId, refresh = false }) {
  if (!enabled() && !refresh) {
    return { skipped: true, reason: 'AI_IMAGE_REFERENCE_ENABLED=false' };
  }
  if (!process.env.OPENAI_API_KEY) {
    return { skipped: true, reason: 'OPENAI_API_KEY not set' };
  }

  const canvas = await AiCanvasArtifact.findById(aiCanvasArtifactId).lean();
  if (!canvas) throw new Error(`AiCanvasArtifact ${aiCanvasArtifactId} not found`);

  const filter = {
    mediaId:             canvas.mediaId,
    template:            canvas.template,
    aspectRatio:         canvas.aspectRatio,
    productId:           canvas.productId,
    variantKind:         canvas.variantKind,
    campaignContextHash: canvas.campaignContextHash,
    paletteSource:       canvas.paletteSource,
    creativeStyle:       canvas.creativeStyle
  };

  if (!refresh) {
    const cached = await AiFullRenderArtifact.findOne(filter).lean();
    if (cached) {
      recordCacheHit({
        stage:    'image_reference',
        provider: 'openai',
        model:    MODEL_ID,
        brandId:  canvas.brandId,
        productId: canvas.productId,
        mediaId:  canvas.mediaId,
        cacheKey: JSON.stringify(filter)
      }).catch(() => {});
      return { artifact: cached, cached: true };
    }
  }

  // Pull the source brand + product + media + Director concept that drove
  // this canvas. Brand/product give the visual identity; media gives the
  // source UGC + creator stats; concept gives the archetype + hook +
  // recommended treatment.
  const [brand, product, media, direction] = await Promise.all([
    canvas.brandId             ? Brand.findById(canvas.brandId).lean() : null,
    canvas.productId           ? CatalogProduct.findById(canvas.productId).lean() : null,
    canvas.mediaId             ? Media.findById(canvas.mediaId).select('source fileUrl platformStats metadata').lean() : null,
    canvas.directionArtifactId ? CreativeDirectionArtifact.findById(canvas.directionArtifactId).lean() : null
  ]);

  const concept   = direction?.concepts?.find(c => c.concept_id === canvas.directionConceptId) || null;
  const proofData = await loadProofData({ product, media });

  const prompt = buildPrompt({
    brand, product, media, concept, proofData,
    aspectRatio:   canvas.aspectRatio,
    creativeStyle: canvas.creativeStyle,
    canvasSpec:    canvas.canvasSpec
  });
  const promptHash = sha256(prompt);
  const { size, width, height } = sizeForRatio(canvas.aspectRatio);

  // Seed image: prefer the clean catalog hero (keeps product identity
  // accurate), fall back to the UGC source photo, fall back to text-only
  // generate when neither is available. images.edit gives the model a
  // visual anchor so it doesn't invent a fake-looking product from a
  // text description.
  const seedImageUrl = product?.imageUrl || media?.fileUrl || null;
  let seedBuffer = null;
  let seedSource = null;
  if (seedImageUrl) {
    try {
      seedBuffer = await fetchImageBuffer(seedImageUrl);
      seedSource = product?.imageUrl ? 'catalog-hero' : 'ugc-source';
    } catch (err) {
      console.warn(`   ⚠️  image-ref: seed download failed (${err.message}) — falling back to text-only generate`);
    }
  }

  const t0 = Date.now();
  const res = await trackLlmCall(
    {
      stage:      'image_reference',
      provider:   'openai',
      model:      MODEL_ID,
      purposeTag: canvas.template || 'untagged',
      brandId:    canvas.brandId,
      productId:  canvas.productId,
      mediaId:    canvas.mediaId,
      cacheKey:   JSON.stringify(filter),
      visionImages: seedBuffer ? 1 : 0
    },
    () => seedBuffer
      ? openai.images.edit({
          model:   MODEL_ID,
          image:   toFile(seedBuffer, 'seed.png', { type: 'image/png' }),
          prompt,
          size,
          quality: QUALITY,
          n:       1
        })
      : openai.images.generate({
          model:   MODEL_ID,
          prompt,
          size,
          quality: QUALITY,
          n:       1
        })
  );
  const elapsedMs = Date.now() - t0;

  const b64 = res?.data?.[0]?.b64_json;
  if (!b64) throw new Error('gpt-image-1 returned no image data');
  const buf = Buffer.from(b64, 'base64');

  const uploaded = await uploadBufferToCloudinary(buf, {
    folder: 'liquidretail/ai_image_reference'
  });

  const artifact = await AiFullRenderArtifact.findOneAndReplace(
    filter,
    {
      ...filter,
      advertiserId:       canvas.advertiserId || null,
      brandId:            canvas.brandId      || null,
      imageUrl:           uploaded.secure_url,
      cloudinaryPublicId: uploaded.public_id,
      modelId:            MODEL_ID,
      promptHash,
      promptText:         prompt,
      width, height,
      costEstimateUsd:    estimateCostUsd(size),
      elapsedMs,
      createdAt:          new Date()
    },
    { upsert: true, new: true, includeResultMetadata: false }
  );

  console.log(
    `🖼  imageReference[${canvas.template}/${canvas.aspectRatio}/${canvas.creativeStyle}]: ` +
    `media=${canvas.mediaId} product=${canvas.productId || '-'} ` +
    `concept=${canvas.directionConceptId || '-'} size=${size} ` +
    `seed=${seedSource || 'none'} took=${elapsedMs}ms`
  );

  return { artifact: artifact.toObject ? artifact.toObject() : artifact, cached: false };
}

// ── Proof data loader ────────────────────────────────────────────────
// Pulls the REAL signals our canonical input carries — rating value +
// count from CatalogProduct, top quote from product.reviews, post stats
// + top comments + creator handle from Media — so the image-gen prompt
// can echo verbatim instead of hallucinating fake testimonials and
// fake star counts.

async function loadProofData({ product, media }) {
  const out = {
    rating:        null,   // { value, count }
    topReview:     null,   // { text, author }
    topComments:   [],     // [{ text, author, likes }]
    creator:       null,   // { handle, platform, followers }
    postStats:     null,   // { likes, comments, engagement }
    caption:       null
  };

  if (product) {
    if (typeof product.rating === 'number' && product.rating > 0) {
      const count = Array.isArray(product.reviews) ? product.reviews.length : null;
      out.rating = {
        value: Number(product.rating.toFixed(1)),
        count: product?.productReviews?.reviewCount || count || null
      };
    }
    // Prefer Immersive reviews[] (live commerce reviews) over the
    // lazy-fetched productReviews.quotes snapshot.
    const reviewQuote = (Array.isArray(product.reviews) ? product.reviews : [])
      .map(r => ({ text: r.text || r.body || r.content, author: r.author || r.reviewer || r.user_name }))
      .find(r => typeof r.text === 'string' && r.text.trim().length > 20);
    if (reviewQuote) {
      out.topReview = { text: reviewQuote.text.slice(0, 200), author: reviewQuote.author || null };
    } else if (product?.productReviews?.quotes?.length) {
      const q = product.productReviews.quotes.find(q => q?.text);
      if (q) out.topReview = { text: String(q.text).slice(0, 200), author: q.author || null };
    }
  }

  if (media && (media.source === 'instagram' || media.source === 'tiktok')) {
    const s = media.platformStats || {};
    if (s.likes || s.comments || s.engagement) {
      out.postStats = {
        likes:      s.likes      ?? null,
        comments:   s.comments   ?? null,
        engagement: s.engagement ?? null
      };
    }
    if (media.metadata?.creatorHandle) {
      out.creator = {
        handle:    media.metadata.creatorHandle,
        platform:  media.source,
        followers: media.metadata.creatorFollowerCount ?? null
      };
    }
    out.caption = media.metadata?.caption || null;

    // Top 3 comments by likes — matches what loadTopComments does for
    // the Layout Generator. Best-effort: Comment model might not be
    // populated yet for a given UGC post.
    try {
      const rows = await Comment.find({ mediaId: media._id })
        .sort({ likeCount: -1, postedAt: -1 })
        .limit(3)
        .select('author authorUsername text content likeCount')
        .lean();
      out.topComments = rows.map(c => ({
        text:   String(c.text || c.content || '').slice(0, 180),
        author: c.author || c.authorUsername || null,
        likes:  c.likeCount ?? null
      })).filter(c => c.text);
    } catch (_) { /* Comment model optional */ }
  }

  return out;
}

// Download an image URL to a PNG buffer for openai.images.edit. gpt-image-1
// accepts JPEG too but PNG round-trips cleanly through Cloudinary fetch
// transforms, so we don't risk format-related failures.
async function fetchImageBuffer(url) {
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
  return Buffer.from(res.data);
}

// ── Prompt construction ──────────────────────────────────────────────
// We're asking gpt-image-1 to produce a complete social ad — composition,
// typography, brand color, product/UGC integration. Give it the same
// strategic brief the Layout Generator works from, the actual copy the
// canvas picked, AND the actual proof data so it doesn't fabricate fake
// testimonials/star ratings.

function buildPrompt({ brand, product, media, concept, proofData, aspectRatio, creativeStyle, canvasSpec }) {
  const brandName    = brand?.name || 'the brand';
  const brandTone    = Array.isArray(brand?.tone) && brand.tone.length ? brand.tone.slice(0, 4).join(', ') : null;
  const primary      = brand?.primaryColor   || null;
  const secondary    = brand?.secondaryColor || null;

  const productName  = product?.title    || null;
  const category     = product?.category || null;

  // Pull whatever copy the canvas picked so the gen-image headline
  // matches what the deterministic render would show.
  const picked = pickCopyFromSpec(canvasSpec) || {};

  const lines = [];
  lines.push(`A polished social-media advertisement at ${aspectRatio} aspect ratio.`);
  lines.push(`The provided reference image shows the actual product. Preserve the product's identity, shape, color, label, and packaging exactly — do NOT redesign the product. You may reframe it, recolor the background, change the composition, add overlays, etc.`);
  lines.push(``);
  lines.push(`Brand: ${brandName}${brandTone ? ` (tone: ${brandTone})` : ''}.`);
  if (productName) lines.push(`Featured product: ${productName}${category ? ` — ${category}` : ''}.`);
  if (primary || secondary) {
    lines.push(`Brand palette: ${[primary, secondary].filter(Boolean).join(' and ')}. Use these as accent colors.`);
  }
  lines.push(`Creative style: ${creativeStyle}.`);

  if (concept) {
    lines.push(``);
    lines.push(`Strategy from creative director:`);
    if (concept.archetype)        lines.push(`- Archetype: ${humanArchetype(concept.archetype)}`);
    if (concept.layout_family)    lines.push(`- Layout family: ${concept.layout_family}`);
    if (concept.emotional_hook)   lines.push(`- Emotional hook: ${concept.emotional_hook}`);
    if (concept.social_proof_type && concept.social_proof_type !== 'none') {
      lines.push(`- Social proof type: ${concept.social_proof_type}`);
    }
    if (concept.cta_emphasis)     lines.push(`- CTA emphasis: ${concept.cta_emphasis}`);
    if (concept.rationale)        lines.push(`- Rationale: ${concept.rationale}`);
  }

  // ── Real proof signals ────────────────────────────────────────────
  // The single biggest correction over the prior text-only prompt. We
  // forbid invented testimonials/ratings and supply the actual data the
  // strategy can bind to. If a field is null, the model knows that proof
  // type isn't available and shouldn't surface it.
  const proofLines = [];
  if (proofData.rating) {
    proofLines.push(`- Rating: ${proofData.rating.value} stars${proofData.rating.count ? ` (${proofData.rating.count} reviews)` : ''}`);
  }
  if (proofData.topReview) {
    proofLines.push(`- Featured review: "${proofData.topReview.text}"${proofData.topReview.author ? ` — ${proofData.topReview.author}` : ''}`);
  }
  if (proofData.topComments.length) {
    proofData.topComments.slice(0, 2).forEach(c => {
      proofLines.push(`- Top comment: "${c.text}"${c.author ? ` — @${c.author}` : ''}${c.likes ? ` (${c.likes} likes)` : ''}`);
    });
  }
  if (proofData.creator) {
    const f = proofData.creator.followers;
    proofLines.push(`- Creator: @${proofData.creator.handle}${f ? ` on ${proofData.creator.platform} (${f.toLocaleString()} followers)` : ''}`);
  }
  if (proofData.postStats) {
    const s = proofData.postStats;
    const bits = [];
    if (s.likes != null)      bits.push(`${s.likes.toLocaleString()} likes`);
    if (s.comments != null)   bits.push(`${s.comments.toLocaleString()} comments`);
    if (s.engagement != null) bits.push(`${(s.engagement * 100).toFixed(1)}% engagement`);
    if (bits.length) proofLines.push(`- Post stats: ${bits.join(', ')}`);
  }

  if (proofLines.length) {
    lines.push(``);
    lines.push(`REAL DATA — render these verbatim where the strategy calls for proof; do NOT invent numbers, names, or quotes that aren't listed here:`);
    proofLines.forEach(l => lines.push(l));
  } else {
    lines.push(``);
    lines.push(`No real social proof data is available for this product/post. Do NOT invent fake testimonials, fake star ratings, fake review counts, or fake creator attributions. If the strategy declared a proof type, omit that element and lean on brand identity / product imagery instead.`);
  }

  if (picked.headline || picked.cta || picked.eyebrow) {
    lines.push(``);
    lines.push(`Render the following copy LEGIBLY (typeset, well-kerned, not garbled):`);
    if (picked.eyebrow)  lines.push(`- Eyebrow: "${picked.eyebrow}"`);
    if (picked.headline) lines.push(`- Headline: "${picked.headline}"`);
    if (picked.cta)      lines.push(`- CTA button: "${picked.cta}"`);
  }

  lines.push(``);
  lines.push(
    `Production notes: photoreal where photographic, typographically sharp, no watermarks, no Lorem Ipsum, no placeholder text. ` +
    `Compose for the chosen archetype — do not default to "centered product on neutral background."`
  );

  return lines.join('\n');
}

function pickCopyFromSpec(spec) {
  if (!spec || !Array.isArray(spec.zones)) return null;
  const out = {};
  for (const z of spec.zones) {
    const slot = z?.slot || '';
    const text = z?.text || z?.copy || null;
    if (!text) continue;
    if (/headline/i.test(slot) && !out.headline) out.headline = String(text).slice(0, 140);
    if (/cta/i.test(slot)      && !out.cta)      out.cta      = String(text).slice(0, 40);
    if (/eyebrow/i.test(slot)  && !out.eyebrow)  out.eyebrow  = String(text).slice(0, 60);
  }
  return out;
}

function humanArchetype(slug) {
  return String(slug || '').replace(/_/g, ' ');
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

module.exports = {
  generateForArtifact,
  enabled,
  MODEL_ID,
  QUALITY
};
