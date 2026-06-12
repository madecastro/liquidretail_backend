// Phase 1 — AI Creative Director.
//
// Picks creative concepts (strategy + hierarchy + recommended components,
// NO coordinates) per (brandId, productId, campaignKind, creativeIntent).
//
// Caching: one CreativeDirectionArtifact per cache key. A 24-ad batch
// using 4 products produces 4 Director calls regardless of how many
// templates, ratios, or palettes the cartesian fans out to. (Lever 1
// from the cost-savings plan — biggest single $/ad reduction.)
//
// Shadow mode through Phase 1: artifacts are persisted but the render
// pipeline still uses the legacy aiCanvasSpec path. Phase 2 wires the
// Generator to read concepts from here.

const crypto = require('crypto');
const OpenAI = require('openai');

const Brand                 = require('../models/Brand');
const CatalogProduct        = require('../models/CatalogProduct');
const Media                 = require('../models/Media');
const ProductMatchArtifact  = require('../models/ProductMatchArtifact');
const CreativeDirectionArtifact = require('../models/CreativeDirectionArtifact');

const { ROLES, COMPONENT_STYLE_BY_ROLE } = require('./aiVocabulary');
const { trackLlmCall, recordCacheHit } = require('./costTracker');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Tunables ─────────────────────────────────────────────────────────

const MODEL_ID    = 'gpt-4.1';
const TEMPERATURE = 0.7;          // creative direction wants nuance, not wild variance
const N_CONCEPTS  = 4;            // four distinct concepts per call — gives pickConceptForCell a wider menu to spread across the cartesian (was 2; producing too-tight band)
const MAX_TOKENS  = 3500;         // bumped from 2000 — each concept ~300-400 tokens with rich rationale

// Bump when assembleSignals' output shape OR N_CONCEPTS changes —
// invalidates existing CreativeDirectionArtifact rows so the Director
// re-runs and emits the new count / shape. Mirrors aiCanvasSpec-
// Service.SPEC_SCHEMA_VERSION.
const DIRECTOR_SIGNALS_VERSION = '2.2.0';   // 2.2: ugc_signal.file_type_distribution added — when matched media includes video, Director steers away from archetype I (ugc_x_product_split — requires two media zones, but the video composite flow only fits one). 2.1: N_CONCEPTS bump 2 → 4. 2.0: full data projection.

// Canonical archetype enum (the 8 we've been using, with descriptive
// names matching the contract). Director picks from these; Generator
// must materialize.
const AVAILABLE_ARCHETYPES = Object.freeze([
  'full_bleed_hero_bottom_panel',  // A — classic safe default
  'vertical_split',                // B — image + brand panel side-by-side
  'diagonal_carve',                // C — angled clipPolygon split
  'typographic_dominant',          // D — headline IS the hero
  'hero_quote_overlay',            // E — full-bleed photo + overlaid testimonial
  'magazine_editorial',            // F — print-spread aesthetic
  'stat_led_social_proof',         // G — numeric stat is the visual anchor
  'product_card_grid'              // H — multi-product mosaic
]);

const CREATIVE_RULES = Object.freeze({
  do_not_generate_coordinates:    true,
  produce_distinct_concepts:      true,
  prioritize_strongest_signal:    true,
  avoid_repeating_same_archetype: true
});

// ── Public API ───────────────────────────────────────────────────────

async function directConcepts({
  brandId,
  productId      = null,
  campaignKind   = null,
  creativeIntent = null,
  refresh        = false
}) {
  if (!brandId) throw badRequest('brandId required');
  if (!process.env.OPENAI_API_KEY) {
    const e = new Error('OPENAI_API_KEY not set'); e.status = 500; throw e;
  }

  const filter = {
    brandId,
    productId:      productId      || null,
    campaignKind:   campaignKind   || null,
    creativeIntent: creativeIntent || null
  };
  const cacheKey = JSON.stringify({
    brandId: String(brandId),
    productId: productId ? String(productId) : null,
    campaignKind, creativeIntent
  });

  if (!refresh) {
    const cached = await CreativeDirectionArtifact.findOne(filter).lean();
    // Cache hit requires the persisted artifact's signalsVersion to
    // match the current code. Older artifacts (no field or older
    // version) re-run against the enriched inputSummary on next call.
    if (cached && cached.signalsVersion === DIRECTOR_SIGNALS_VERSION) {
      recordCacheHit({
        stage:    'creative_director',
        provider: 'openai',
        model:    MODEL_ID,
        brandId, productId,
        cacheKey
      }).catch(() => {});
      return { artifact: cached, cached: true };
    }
  }

  // Build the input_summary from the actual data
  const inputSummary = await assembleSignals({ brandId, productId, campaignKind });
  const { system, user } = buildPrompt({ inputSummary, creativeIntent });
  const promptHash = sha256(system + '\n' + user);

  // OpenAI strict JSON schema constrains the output to N concepts with
  // the shape the contract spells out. We only ask the LLM for concepts;
  // input_summary / available_archetypes / creative_rules are added
  // server-side.
  const responseSchema = buildResponseSchema();

  const t0 = Date.now();
  const completion = await trackLlmCall(
    {
      stage:      'creative_director',
      provider:   'openai',
      model:      MODEL_ID,
      purposeTag: campaignKind || 'untagged',
      brandId, productId,
      visionImages: 0,
      cacheKey
    },
    () => openai.chat.completions.create({
      model: MODEL_ID,
      response_format: { type: 'json_schema', json_schema: responseSchema },
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: user }
      ],
      temperature: TEMPERATURE,
      max_tokens:  MAX_TOKENS
    })
  );
  const elapsedMs = Date.now() - t0;

  const raw = completion.choices?.[0]?.message?.content;
  if (!raw) throw new Error('Director returned no content');

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (err) { throw new Error(`Director response not JSON: ${err.message}`); }

  const warnings = validateConcepts(parsed.concepts || []);

  console.log(
    `🎭 creativeDirector[${campaignKind || '-'}]: ` +
    `brand=${brandId} product=${productId || '-'} intent=${creativeIntent || '-'} ` +
    `concepts=${(parsed.concepts || []).length} took=${elapsedMs}ms warnings=${warnings.length}`
  );

  const artifact = await CreativeDirectionArtifact.findOneAndReplace(
    filter,
    {
      ...filter,
      contractVersion:    '1.0',
      contractSchemaId:   'creative_direction.v1',
      signalsVersion:     DIRECTOR_SIGNALS_VERSION,
      inputSummary,
      availableArchetypes:     [...AVAILABLE_ARCHETYPES],
      availableComponentRoles: [...ROLES],
      creativeRules:           { ...CREATIVE_RULES },
      concepts:                parsed.concepts || [],
      provider:    'openai',
      modelId:     MODEL_ID,
      promptHash,
      promptSystem: system,
      promptUser:   user,
      rawResponse:  raw,
      validationWarnings: warnings,
      createdAt:    new Date()
    },
    { upsert: true, new: true, includeResultMetadata: false }
  );

  return { artifact: artifact.toObject ? artifact.toObject() : artifact, cached: false };
}

// ── Signal assembly ──────────────────────────────────────────────────
// Walks Brand + CatalogProduct + the product's matched-media to build
// the input_summary block. Deterministic (no LLM) — just bucket counts
// into high/medium/low strength labels.

async function assembleSignals({ brandId, productId, campaignKind }) {
  const [brand, product] = await Promise.all([
    Brand.findById(brandId).lean(),
    productId ? CatalogProduct.findById(productId).lean() : null
  ]);

  const matchedMediaIds = product?.matchedMedia
    ? product.matchedMedia.map(mm => mm.mediaId).filter(Boolean).slice(0, 10)
    : [];

  // Pull fuller media — classification (shot type, content nature),
  // primarySubjectLabel, adSuitability score, and creator metadata.
  // The Director makes strategy calls; richer fields = richer concepts.
  let medias = [];
  if (matchedMediaIds.length) {
    medias = await Media.find({ _id: { $in: matchedMediaIds } })
      .select('source platformStats metadata classification primarySubjectLabel adSuitability fileType')
      .lean();
  }

  // Top comments across matched media (sorted by likes). Best-effort —
  // Comment model is optional for some ingestion paths.
  let topCommentsAcrossMedia = [];
  if (matchedMediaIds.length) {
    try {
      const Comment = require('../models/Comment');
      topCommentsAcrossMedia = await Comment.find({ mediaId: { $in: matchedMediaIds } })
        .sort({ likeCount: -1, postedAt: -1 })
        .limit(5)
        .select('author authorUsername text content likeCount mediaId')
        .lean();
    } catch (_) { /* Comment model unavailable in some envs */ }
  }

  // ── Brand signal ──
  // Brand colors + font intentionally OMITTED (Generator picks palette).
  // Adds description + tagline + brandReviews summary so the Director can
  // ground strategy in actual voice, not just abstract tone words.
  const brandSignal = {
    name:        brand?.name        || null,
    tagline:     brand?.tagline     || null,
    description: snippetText(brand?.description, 280),
    tone:        Array.isArray(brand?.tone) ? brand.tone.slice(0, 6) : [],
    brand_reviews_summary: snippetText(brand?.brandReviews?.summary, 240),
    has_logo:    !!brand?.logo
  };

  // ── Product signal ──
  const productSignal = {
    name:           product?.title       || null,
    category:       product?.category    || null,
    description:    snippetText(product?.description, 280),
    price:          product?.price ?? null,
    currency:       product?.currency    || null,
    availability:   product?.availability || null,
    badges:         Array.isArray(product?.shortBenefits) ? product.shortBenefits.slice(0, 4) : [],
    review_summary: snippetText(product?.reviewSummary?.summary || product?.productReviews?.summary, 240),
    priority:       !productId ? 'absent' :
                    campaignKind === 'product' ? 'high' :
                    campaignKind === 'brand'   ? 'medium' :
                    'medium'
  };

  // ── UGC signal — aggregate + distributions across matched media ──
  const ugcMedias    = medias.filter(m => m.source === 'instagram' || m.source === 'tiktok');
  const ugcMediaCount= ugcMedias.length;
  const ugcPlatform  = ugcMedias.find(m => m.source)?.source || null;
  const mediaStrength= ugcMediaCount >= 3 ? 'high' :
                        ugcMediaCount >= 1 ? 'medium' :
                        'absent';
  const rightsApproved = ugcMedias.some(m => m.platformStats?.rights_approved) || null;

  // Shot-type + content-nature distributions: tells the Director whether
  // the matched media is lifestyle vs product-only, evergreen vs
  // promotional. Drives ugc_priority + emotional_hook + archetype.
  const shotTypeDist     = distribution(ugcMedias.map(m => m.classification?.shotType).filter(Boolean));
  const contentNatureDist = distribution(ugcMedias.map(m => m.classification?.contentNature).filter(Boolean));
  // Distribution of source file types across matched media. When any
  // entry is 'video', the render pipeline composites the source as a
  // full-bleed transparent slot with chrome as overlay-only (see the
  // CRITICAL VIDEO SOURCE MEDIA rule in aiCanvasSpecService.js). The
  // Director uses this signal to avoid archetype I (ugc_x_product_split)
  // for video-bearing contexts — that archetype needs two media zones
  // and the video flow only fits one.
  const fileTypeDist = distribution(ugcMedias.map(m => m.fileType).filter(Boolean));
  const adReadinessScores = ugcMedias
    .map(m => m.adSuitability?.score)
    .filter(s => typeof s === 'number');
  const avgAdReadiness = adReadinessScores.length
    ? Number((adReadinessScores.reduce((s, n) => s + n, 0) / adReadinessScores.length).toFixed(2))
    : null;
  const subjectLabels = ugcMedias.map(m => m.primarySubjectLabel).filter(Boolean).slice(0, 5);
  // Top creator (by follower count) across matched media. Lets the
  // Director know if there's a meaningful creator anchor to lead with.
  const creators = ugcMedias
    .map(m => ({
      handle:    m.metadata?.creatorHandle || null,
      followers: m.metadata?.creatorFollowerCount ?? null,
      platform:  m.source
    }))
    .filter(c => c.handle);
  const topCreator = creators.sort((a, b) => (b.followers || 0) - (a.followers || 0))[0] || null;

  const ugcSignal = {
    platform:        ugcPlatform,
    media_count:     ugcMediaCount,
    media_strength:  mediaStrength,
    rights_approved: rightsApproved,
    shot_type_distribution:     shotTypeDist,        // { lifestyle: 4, product_only: 1, ... }
    content_nature_distribution: contentNatureDist,  // { evergreen: 3, promotional: 1, ... }
    file_type_distribution:      fileTypeDist,       // { video: 3, image: 1 } — drives video-aware archetype constraint
    avg_ad_readiness: avgAdReadiness,                 // 0–1 mean across matched
    primary_subjects: subjectLabels,                  // ["jar of chili oil", "bowl of noodles", ...]
    top_creator:     topCreator                      // { handle, followers, platform } | null
  };

  // ── Social proof signal — real values + actual quote/comment text ──
  const ratingValue = typeof product?.rating === 'number' && product.rating > 0 ? product.rating : null;
  // ratingCount preference order: productReviews snapshot → reviews[] array length
  const ratingCount = product?.productReviews?.reviewCount
                   ?? (Array.isArray(product?.reviews) ? product.reviews.length : null);

  const productReviewQuotes = (Array.isArray(product?.reviews) ? product.reviews : [])
    .map(r => ({ text: r.text || r.body || r.content, author: r.author || r.reviewer || r.user_name }))
    .filter(r => typeof r.text === 'string' && r.text.trim().length > 30);
  const primaryQuoteObj = productReviewQuotes[0] || null;
  const topComments = topCommentsAcrossMedia.slice(0, 2).map(c => ({
    text:   snippetText(c.text || c.content, 180),
    author: c.author || c.authorUsername || null,
    likes:  c.likeCount ?? null
  })).filter(c => c.text);

  const strongestSignal = primaryQuoteObj  ? 'testimonial' :
                          ratingValue      ? 'rating' :
                          topComments.length ? 'creator' :
                          null;

  const socialProofSignal = {
    rating: ratingValue != null ? { value: Number(ratingValue.toFixed(1)), count: ratingCount } : null,
    primary_quote: primaryQuoteObj
      ? { text: snippetText(primaryQuoteObj.text, 200), author: primaryQuoteObj.author || null }
      : null,
    top_comments:     topComments,
    strongest_signal: strongestSignal,
    proof_density:    productReviewQuotes.length + topComments.length      // crude richness signal
  };

  // ── Performance signal — totals + rates + per-media percentiles ──
  const totalLikes    = ugcMedias.reduce((s, m) => s + (m.platformStats?.likes    || 0), 0);
  const totalComments = ugcMedias.reduce((s, m) => s + (m.platformStats?.comments || 0), 0);
  const totalSaves    = ugcMedias.reduce((s, m) => s + (m.platformStats?.saves    || 0), 0);
  const totalShares   = ugcMedias.reduce((s, m) => s + (m.platformStats?.shares   || 0), 0);
  const engagementRates = ugcMedias
    .map(m => m.platformStats?.engagement)
    .filter(e => typeof e === 'number' && e > 0);
  const avgEngagement = engagementRates.length
    ? Number((engagementRates.reduce((s, n) => s + n, 0) / engagementRates.length).toFixed(4))
    : null;
  const performanceStrength = totalLikes >= 5000 || totalComments >= 200 ? 'high' :
                              totalLikes >= 500  || totalComments >= 20  ? 'medium' :
                              totalLikes > 0     || totalComments > 0    ? 'low' :
                              'absent';
  // Top single post by likes — lets the Director lean into stat_led when
  // one post dominates ("this single post got 12K likes — make IT the ad").
  const topPost = ugcMedias
    .map(m => ({
      likes:    m.platformStats?.likes    || 0,
      comments: m.platformStats?.comments || 0,
      saves:    m.platformStats?.saves    || 0,
      caption:  snippetText(m.metadata?.caption, 140)
    }))
    .filter(p => p.likes > 0 || p.comments > 0)
    .sort((a, b) => b.likes - a.likes)[0] || null;

  const performanceSignal = {
    likes:           totalLikes    || null,
    comments:        totalComments || null,
    saves:           totalSaves    || null,
    shares:          totalShares   || null,
    avg_engagement_rate: avgEngagement,        // 0–1, average across posts with engagement data
    strength:        performanceStrength,
    top_post:        topPost                    // { likes, comments, saves, caption } | null
  };

  return {
    brand_signal:        brandSignal,
    product_signal:      productSignal,
    ugc_signal:          ugcSignal,
    social_proof_signal: socialProofSignal,
    performance_signal:  performanceSignal
  };
}

// Compact text → null/empty/length-capped clean snippet. Used to keep
// the Director's inputSummary tight while still passing actual content.
function snippetText(s, maxLen) {
  if (!s || typeof s !== 'string') return null;
  const trimmed = s.replace(/\s+/g, ' ').trim();
  if (!trimmed) return null;
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen - 1) + '…' : trimmed;
}

// Count distinct values in an array. Used for shot-type + content-nature
// distributions across matched media.
function distribution(values) {
  const out = {};
  for (const v of values) {
    if (!v) continue;
    out[v] = (out[v] || 0) + 1;
  }
  return out;
}

// ── Prompt construction ──────────────────────────────────────────────

function buildPrompt({ inputSummary, creativeIntent }) {
  const system = [
    `You are a creative director planning social-media ad creative for a brand.`,
    ``,
    `Your job: pick ${N_CONCEPTS} distinct creative concepts that match the signals below. You make STRATEGY decisions — archetype, hierarchy, recommended components — NOT coordinates. A downstream Layout Generator materializes each concept into pixels.`,
    ``,
    `RULES:`,
    `- DO NOT generate coordinates, rects, or pixel positions.`,
    `- The ${N_CONCEPTS} concepts MUST be meaningfully different — different archetype OR different emotional_hook OR different social_proof_type. Avoid two concepts that read the same.`,
    `- Lead with the STRONGEST signal in the data. If social_proof_signal.primary_quote is present and performance is low, lean into the testimonial — don't pick a stat_led archetype.`,
    `- If a signal is "absent" / null / empty, do not build a concept around it.`,
    `- HONESTY RULE: if social_proof_signal.primary_quote is null AND top_comments is empty AND rating is null, you MUST set social_proof_type="none" on EVERY concept. Do not promise proof the data can't back. In that case, also avoid the stat_led_social_proof and hero_quote_overlay archetypes — there is nothing to surface. Lean on brand voice (typographic_dominant, magazine_editorial) or the photo itself (full_bleed_hero_bottom_panel, vertical_split, diagonal_carve).`,
    ``,
    `READING THE INPUT SUMMARY — use the FULL signal, not just strength labels:`,
    `  brand_signal.description / tagline / brand_reviews_summary → voice + emotional_hook calibration`,
    `  product_signal.description / review_summary / price → aspirational vs accessible vs functional positioning`,
    `  ugc_signal.shot_type_distribution → if mostly lifestyle/on_model → ugc-led / hero_quote_overlay; if product_only → typographic_dominant / vertical_split`,
    `  ugc_signal.content_nature_distribution → if mostly evergreen → safe to surface; if mostly promotional → archetype should sidestep the dated feel`,
    `  ugc_signal.file_type_distribution → when video > 0, the matched media includes a video clip. The render pipeline composites video as a FULL-BLEED transparent slot with chrome as OVERLAY-ONLY (panels, text, CTAs, badges, social proof live on top of the playing video — they NEVER cover the full canvas). AVOID archetype ugc_x_product_split when video is present (it requires two media zones, but the video flow only fits one). All other archetypes work; pick the chrome composition that reads cleanly over a playing video — full_bleed_hero_bottom_panel for a clean bottom band, hero_quote_overlay for a floating quote card, stat_led_social_proof for a centered stat callout, magazine_editorial for a stacked corner inset, diagonal_carve for an angled chrome shape, etc.`,
    `  ugc_signal.primary_subjects → what the photos ACTUALLY show — drives emotional_hook word choice`,
    `  ugc_signal.top_creator → if a creator with significant followers anchors the matched set, pick a creator-led archetype (hero_quote_overlay) and set comment_priority=high`,
    `  ugc_signal.avg_ad_readiness → high (>0.7) = photo-led works; low (<0.4) = lean typographic or brand-color-led to avoid weak imagery`,
    `  social_proof_signal.primary_quote.text → if it makes a specific claim (e.g. "tastes like Italy") let the quote's CONTENT inform emotional_hook (e.g. "authenticity" not generic "trust")`,
    `  social_proof_signal.top_comments[].text → same — if comments cluster on a topic ("flavor", "spice"), the concept's emotional_hook should pick up that theme`,
    `  social_proof_signal.rating.value + count → if rating ≥ 4.5 AND count ≥ 50 → stat_led_social_proof is justified; smaller counts = lean on quote not number`,
    `  performance_signal.top_post.likes → if a single post dramatically outperforms (>>median) the others, archetype should center THAT post's visual (hero_quote_overlay over that post's media)`,
    `  performance_signal.avg_engagement_rate → high (>0.05) = social-proof-led safe; low = brand-voice-led safer`,
    `Concepts that ignore the signal in favor of generic archetypes get rejected by the Judge downstream. SHOW that the signal drove the call in rationale.`,
    ``,
    `AVAILABLE ARCHETYPES (pick one per concept):`,
    AVAILABLE_ARCHETYPES.map(a => `  ${a}`).join('\n'),
    ``,
    `AVAILABLE ROLES (used in recommended_components — map of role → component_style):`,
    ROLES.map(r => `  ${r}: [${(COMPONENT_STYLE_BY_ROLE[r] || []).join(', ')}]`).join('\n'),
    ``,
    `For each concept, recommend ONE component_style per role you want featured. You don't have to fill every role — only the ones the strategy calls for. Generator will fill the rest.`,
    ``,
    `Output JSON matching the schema. Per concept emit:`,
    `  concept_id          — short slug (e.g. "cd_quote_lead", "cd_brand_typo")`,
    `  name                — human-readable concept name`,
    `  archetype           — one of the available archetypes`,
    `  layout_family       — short alias (hero_quote, vertical_split, etc.)`,
    `  emotional_hook      — what the ad triggers (trust, authenticity, urgency, etc.)`,
    `  social_proof_type   — testimonial / stat / creator / review / rating / none`,
    `  *_priority          — high/medium/low/absent for product, ugc, comment, stat`,
    `  cta_emphasis        — primary/secondary/minimal/absent`,
    `  recommended_components — map of role → component_style`,
    `  rationale           — 1-2 sentences explaining why this concept matches the signals`
  ].join('\n');

  const user = [
    `INPUT SUMMARY (signals you're directing for):`,
    '```json',
    JSON.stringify(inputSummary, null, 2),
    '```',
    ``,
    creativeIntent ? `OPERATOR HINT: ${creativeIntent}` : `OPERATOR HINT: none — you decide.`,
    ``,
    `Emit ${N_CONCEPTS} distinct concepts. Make them genuinely different.`
  ].join('\n');

  return { system, user };
}

// ── Response schema (OpenAI strict) ──────────────────────────────────

function buildResponseSchema() {
  return {
    name: 'creative_director_concepts',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['concepts'],
      properties: {
        concepts: {
          type: 'array',
          minItems: N_CONCEPTS,
          maxItems: N_CONCEPTS,
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'concept_id', 'name', 'archetype', 'layout_family',
              'emotional_hook', 'social_proof_type',
              'product_priority', 'ugc_priority', 'comment_priority', 'stat_priority', 'cta_emphasis',
              'recommended_components', 'rationale'
            ],
            properties: {
              concept_id:        { type: 'string' },
              name:              { type: 'string' },
              archetype:         { type: 'string', enum: AVAILABLE_ARCHETYPES },
              layout_family:     { type: 'string' },
              emotional_hook:    { type: 'string' },
              social_proof_type: { type: 'string' },
              product_priority:  { type: 'string', enum: ['high', 'medium', 'low', 'absent'] },
              ugc_priority:      { type: 'string', enum: ['high', 'medium', 'low', 'absent'] },
              comment_priority:  { type: 'string', enum: ['high', 'medium', 'low', 'absent'] },
              stat_priority:     { type: 'string', enum: ['high', 'medium', 'low', 'absent'] },
              cta_emphasis:      { type: 'string', enum: ['primary', 'secondary', 'minimal', 'absent'] },
              // OpenAI strict mode doesn't allow open-ended objects with
              // additionalProperties:true. We constrain to the fixed
              // ROLE set, each value nullable so the Director can leave
              // most roles unrecommended.
              recommended_components: {
                type: 'object',
                additionalProperties: false,
                required: [...ROLES],
                properties: Object.fromEntries(
                  ROLES.map(r => [r, { type: ['string', 'null'] }])
                )
              },
              rationale: { type: 'string' }
            }
          }
        }
      }
    },
    strict: true
  };
}

// ── Validator ────────────────────────────────────────────────────────
// Soft-warning only — concept failures don't break the pipeline.

function validateConcepts(concepts) {
  const warnings = [];
  if (!Array.isArray(concepts) || !concepts.length) {
    warnings.push('no concepts emitted');
    return warnings;
  }

  // Distinctness: the N concepts should differ on at least one of
  // (archetype, emotional_hook, social_proof_type).
  if (concepts.length >= 2) {
    const fingerprints = concepts.map(c =>
      `${c.archetype}|${c.emotional_hook}|${c.social_proof_type}`
    );
    if (new Set(fingerprints).size < concepts.length) {
      warnings.push(`concepts are not distinct — fingerprints: ${fingerprints.join(' / ')}`);
    }
  }

  // Validate recommended component styles against the vocabulary.
  for (const c of concepts) {
    if (!c?.recommended_components) continue;
    for (const [role, style] of Object.entries(c.recommended_components)) {
      if (style == null) continue;
      const allowed = COMPONENT_STYLE_BY_ROLE[role];
      if (!allowed) {
        warnings.push(`concept ${c.concept_id}: unknown role "${role}" in recommended_components`);
      } else if (!allowed.includes(style)) {
        warnings.push(`concept ${c.concept_id}: role "${role}" picked unknown component_style "${style}" (allowed: ${allowed.join(', ')})`);
      }
    }
  }

  return warnings;
}

// ── Helpers ──────────────────────────────────────────────────────────

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function badRequest(msg) { const e = new Error(msg); e.status = 400; return e; }

module.exports = {
  directConcepts,
  assembleSignals,
  AVAILABLE_ARCHETYPES,
  CREATIVE_RULES,
  MODEL_ID
};
