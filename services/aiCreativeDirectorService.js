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

const Brand                 = require('../models/Brand');
const CatalogProduct        = require('../models/CatalogProduct');
const Media                 = require('../models/Media');
const ProductMatchArtifact  = require('../models/ProductMatchArtifact');
const CreativeDirectionArtifact = require('../models/CreativeDirectionArtifact');

const { ROLES, COMPONENT_STYLE_BY_ROLE } = require('./aiVocabulary');
const { trackLlmCall, recordCacheHit } = require('./costTracker');

const { chatCompletion } = require('./atlasLlmService');
const { usableProofCommentsOrNone } = require('./quoteSnippetService');

// ── Tunables ─────────────────────────────────────────────────────────

const MODEL_ID    = 'gpt-4.1';
const TEMPERATURE = 0.7;          // creative direction wants nuance, not wild variance
const N_CONCEPTS  = 4;            // four distinct concepts per call — gives pickConceptForCell a wider menu to spread across the cartesian (was 2; producing too-tight band)
const MAX_TOKENS  = 3500;         // bumped from 2000 — each concept ~300-400 tokens with rich rationale

// Bump when assembleSignals' output shape OR N_CONCEPTS changes —
// invalidates existing CreativeDirectionArtifact rows so the Director
// re-runs and emits the new count / shape. Mirrors aiCanvasSpec-
// Service.SPEC_SCHEMA_VERSION.
const DIRECTOR_SIGNALS_VERSION = '2.4.0';   // 2.4: platform-format-aware (Phase 3). Director now receives platformFormat (meta_feed_1_1 | meta_reels_9_16) and the prompt has a FORMAT CONSTRAINTS section that weights archetypes per surface — Reels deprioritizes typographic_dominant + magazine_editorial + product_card_grid (text/inset patterns don't read on tall vertical with safe-area reservations), favors hero_quote_overlay + full_bleed_hero_bottom_panel (chrome lives in the middle safe band). 2.3: PMA-based matchedMediaIds + brand-review fallback. 2.2: file_type_distribution added. 2.1: N_CONCEPTS 2 → 4. 2.0: full data projection.

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
  // Platform-format-aware ad generation (Phase 3). When supplied,
  // gates the FORMAT CONSTRAINTS section in the prompt — Reels gets
  // archetype weighting that deprioritizes typographic / magazine /
  // grid patterns and favors hero_quote_overlay + full_bleed since
  // chrome has to live in the middle safe band. Defaults to
  // 'meta_feed_1_1' so callers that don't pass it (and any cached
  // direction artifacts pre-Phase-3) keep producing concepts as before.
  // NOT yet a cache-key dimension — Phase 5 wires that. For now,
  // bumping DIRECTOR_SIGNALS_VERSION on this Phase invalidates all
  // cached artifacts so the next call regenerates with format-awareness.
  platformFormat = 'meta_feed_1_1',
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
    creativeIntent: creativeIntent || null,
    // Phase 5: platformFormat is the 5th cache-key dimension so the
    // Director picks separate concept sets per Meta surface (Reels
    // archetype weighting != Feed archetype weighting).
    platformFormat: platformFormat,
    // Phase A5a: scope V1 path to V1 rows only (roundIndex: null) so
    // the V2 round artifacts (roundIndex: 0..N written by
    // directConceptsRound) can't be matched by this findOne / over-
    // written by the findOneAndReplace below. Without this filter,
    // V1's upsert would happily replace a V2 row, wiping a round's
    // concepts the moment any V1-mode caller fires.
    roundIndex:     null
  };
  const cacheKey = JSON.stringify({
    brandId: String(brandId),
    productId: productId ? String(productId) : null,
    campaignKind, creativeIntent, platformFormat
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

  // Build the input_summary from the actual data. platformFormat lives
  // alongside the signal blocks so it shows up in the persisted input-
  // Summary audit (inspectDirectorInput.js) — operators can see which
  // format the concept was generated for.
  const signals = await assembleSignals({ brandId, productId, campaignKind });
  const inputSummary = { ...signals, platform_format: platformFormat };
  const { system, user } = buildPrompt({ inputSummary, creativeIntent, platformFormat });
  const promptHash = sha256(system + '\n' + user);

  // OpenAI strict JSON schema constrains the output to N concepts with
  // the shape the contract spells out. We only ask the LLM for concepts;
  // input_summary / available_archetypes / creative_rules are added
  // server-side.
  const responseSchema = buildResponseSchema();

  const t0 = Date.now();
  const completion = await chatCompletion(
    {
      stage:      'creative_director',
      provider:   'openai',
      model:      MODEL_ID,
      purposeTag: campaignKind || 'untagged',
      brandId, productId,
      visionImages: 0,
      cacheKey
    },
    {
      model: MODEL_ID,
      response_format: { type: 'json_schema', json_schema: responseSchema },
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: user }
      ],
      temperature: TEMPERATURE,
      max_tokens:  MAX_TOKENS
    }
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

  // Pull matched media via ProductMatchArtifact (the canonical match
  // store — one row per (mediaId, productId/brand) match). The previous
  // implementation read product.matchedMedia (a denormalized array),
  // which had two failure modes:
  //   • brand-mode runs (productId=null): product is null → array is
  //     empty → matchedMediaIds=[] → entire ugc_signal + top_comments
  //     come back blank → Director sees "no media, no proof, no
  //     engagement" and picks safe brand-voice-led concepts.
  //   • product-mode runs where denorm sync ran late or missed: same
  //     empty-array result despite PMAs existing for that product.
  // Querying PMAs directly unifies both modes and removes the
  // denormalization dependency. Top 10 by identification.certainty
  // matches the previous .slice(0, 10) cap on richest matches.
  const pmaFilter = productId
    ? { catalogProductId: productId }
    : { brandId, outcome: { $in: ['brand_match', 'product_category', 'product_match'] } };
  const pmas = await ProductMatchArtifact.find(pmaFilter)
    .sort({ 'identification.certainty': -1 })
    .limit(10)
    .select('mediaId')
    .lean();
  const matchedMediaIds = pmas.map(p => p.mediaId).filter(Boolean);

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
      // Over-fetched because the judge below narrows this; see the note at the
      // topComments mapping. Selecting proofJudgment lets already-judged rows
      // cost nothing.
      topCommentsAcrossMedia = await Comment.find({ mediaId: { $in: matchedMediaIds } })
        .sort({ likeCount: -1, postedAt: -1 })
        .limit(30)
        .select('author authorUsername text content likeCount mediaId proofJudgment')
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
  // Product-level review data preferred; brand-level reviews supplement
  // when the product layer is thin or missing. brand.brandReviews
  // carries aggregated review data scraped during enrichment
  // (WeddingWire, Trustpilot, Google Reviews, etc.) — it's the ONLY
  // proof signal in pure-brand-mode runs, and a critical supplement
  // for product-mode runs whose catalog SKU has zero on-platform
  // reviews even when the parent brand has fifty across third-party
  // sites. The Director's HONESTY RULE checks primary_quote / rating
  // / top_comments — without this fallback brand-mode runs always
  // tripped it and emitted social_proof_type="none" on every concept.
  const productRatingValue = typeof product?.rating === 'number' && product.rating > 0 ? product.rating : null;
  const productRatingCount = product?.productReviews?.reviewCount
                          ?? (Array.isArray(product?.reviews) ? product.reviews.length : null);
  const productReviewQuotes = (Array.isArray(product?.reviews) ? product.reviews : [])
    .map(r => ({ text: r.text || r.body || r.content, author: r.author || r.reviewer || r.user_name }))
    .filter(r => typeof r.text === 'string' && r.text.trim().length > 30);

  // Brand-level — only consulted to fill in what product-level missed.
  // brandReviews.quotes can be either {text, author} objects or plain
  // strings depending on the enrichment provider.
  const brandReviewQuotes = (Array.isArray(brand?.brandReviews?.quotes) ? brand.brandReviews.quotes : [])
    .map(q => {
      if (typeof q === 'string') return { text: q, author: null };
      return {
        text:   q?.text   || q?.body || q?.content || null,
        author: q?.author || q?.reviewer || q?.user_name || null
      };
    })
    .filter(q => typeof q.text === 'string' && q.text.trim().length > 30);
  const brandRatingValue = typeof brand?.brandReviews?.rating === 'number' && brand.brandReviews.rating > 0
    ? brand.brandReviews.rating : null;
  const brandRatingCount = brand?.brandReviews?.reviewCount || null;
  const brandReviewSource = brand?.brandReviews?.source || null;

  // Effective values — prefer product, fall back to brand ONLY when no
  // product is in scope.
  //
  // This fallback is how another product's words reached a product ad. On a
  // multi-SKU brand, brand-level reviews and ratings are about whatever the
  // reviewer bought; handing one to the Director as this product's
  // primary_quote, while COPY PICKS instructs it to ground copy on exactly
  // that field, is an instruction to write about the wrong item. It is also
  // invisible: the ad comes out with the right product id and the right
  // photo, and only the language belongs to something else.
  //
  // The layout tier withholds brand quotes for the same reason, but that
  // alone does not help here — the Director writes copy_picks from this
  // object, well upstream of the layout artifact.
  const isProductScoped = !!product;
  const ratingValue    = productRatingValue ?? (isProductScoped ? null : brandRatingValue);
  const ratingCount    = productRatingCount ?? (isProductScoped ? null : brandRatingCount);
  const primaryQuoteObj = productReviewQuotes[0] || (isProductScoped ? null : brandReviewQuotes[0]) || null;
  if (isProductScoped && !productReviewQuotes.length && brandReviewQuotes.length) {
    console.log(`🔒 director scope — ${brandReviewQuotes.length} brand review(s) withheld from a product concept (cross-product copy risk)`);
  }
  // Source attribution — null when the quote is in-catalog product
  // review (no external attribution needed); non-null (e.g.
  // "WeddingWire") when the quote came from the brand-level scrape.
  // Lets the Layout Generator decide whether to surface attribution.
  // Keyed off the quote actually chosen, not off what was available — a
  // product concept now withholds brand quotes, and attributing a
  // brand-scrape source to a quote that was never included would label a
  // null.
  const primaryQuoteSource = (!productReviewQuotes.length && primaryQuoteObj)
    ? brandReviewSource
    : null;

  // JUDGED, not raw. The Director was handed the most-liked comments verbatim,
  // truncated to 180 chars, with no sentiment screen of any kind — so a
  // complaint could seed the concept that the whole ad is then built around,
  // and `social_proof_type: "creator"` could be chosen on the strength of it.
  // Every other comment surface screens; this one, the most upstream and
  // therefore the most consequential, did not.
  const judgedComments = await usableProofCommentsOrNone(topCommentsAcrossMedia, { brandId, productId }, 'director');
  const topComments = judgedComments.slice(0, 2).map(c => ({
    text:   c.proofLine,
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
      ? {
          text:   snippetText(primaryQuoteObj.text, 200),
          author: primaryQuoteObj.author || null,
          source: primaryQuoteSource    // null = in-catalog product review; non-null = brand-level external review (e.g. "WeddingWire")
        }
      : null,
    top_comments:     topComments,
    strongest_signal: strongestSignal,
    // Counts only proof the Director can actually use: on a product concept
    // the brand quotes are withheld, so including them here would advertise a
    // richness that is not in the payload and push the model toward a
    // proof-led archetype it cannot ground.
    proof_density:    productReviewQuotes.length + (isProductScoped ? 0 : brandReviewQuotes.length) + topComments.length
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
// Word-boundary truncation. The old slice(maxLen - 1) cut mid-word, which
// matters most for social_proof_signal.primary_quote: the Director reads that
// text and is asked to ground copy in it, so a quote ending "the new one is
// horrible. Pl" invites the model to complete a sentence the reviewer never
// wrote. utils/htmlEntities.truncateWords backs off to the last space and marks
// the cut.
function snippetText(s, maxLen) {
  if (!s || typeof s !== 'string') return null;
  const trimmed = s.replace(/\s+/g, ' ').trim();
  if (!trimmed) return null;
  if (trimmed.length <= maxLen) return trimmed;
  return require('../utils/htmlEntities').truncateWords(trimmed, maxLen);
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

// Platform-format-aware archetype weighting (Phase 3). Returns a prompt
// block describing the canvas surface + safe areas + archetype prefs
// per format. Empty string for the legacy meta_feed_1_1 default (no
// extra constraints, matches what the Director was producing pre-
// Phase-3). The Generator + Validator (Phases 3/4) enforce safe-area
// pixel boxes; the Director just picks archetypes that work for the
// surface.
// Per-format archetype steering. Only Reels has explicit overrides today —
// vertical full-screen breaks layouts that work on Feed (typographic_dominant
// competes with IG caption, product_card_grid feels cramped). Other formats
// get the default "all archetypes work" until we learn which ones flop.
const ARCHETYPE_WEIGHTING = {
  meta_reels_9_16: [
    `  ARCHETYPE WEIGHTING:`,
    `    PREFER  hero_quote_overlay (chrome lives in middle band as floating quote_card — natural fit)`,
    `    PREFER  full_bleed_hero_bottom_panel (the "bottom panel" lands inside the safe middle band, not in the reserved bottom strip)`,
    `    PREFER  diagonal_carve (carved chrome inside the middle 1338px is striking on vertical)`,
    `    DEPRIORITIZE typographic_dominant (large headline competes with IG's caption text in the top safe zone — feels visually noisy)`,
    `    DEPRIORITIZE magazine_editorial (inset image + editorial stack reads as static on a video surface)`,
    `    DEPRIORITIZE product_card_grid (multi-card layouts feel cramped on tall vertical)`,
    `    AVOID        stat_led_social_proof (numeric stat as hero competes with creator-handle overlays in top safe zone)`
  ].join('\n'),
  // Stories is NOT Reels, even though both are 9:16. Reels is a scroll surface
  // where the ad competes with entertainment; Stories is tap-through, ephemeral,
  // and natively overlay-heavy (text, stickers, polls), with a much deeper
  // reserved band top and bottom (250 vs 204). Without its own entry Stories got
  // no weighting at all, so the Director picked archetypes tuned for square Feed.
  meta_stories_9_16: [
    `  ARCHETYPE WEIGHTING:`,
    `    PREFER  full_bleed_hero_bottom_panel (full-screen imagery with the panel inside the middle band is exactly how native Stories reads)`,
    `    PREFER  typographic_dominant (Stories creative is natively text-and-sticker heavy — bold type reads as native here, unlike on Reels)`,
    `    PREFER  hero_quote_overlay (a floating quote card in the middle band mirrors the sticker convention)`,
    `    DEPRIORITIZE magazine_editorial (an editorial spread reads as a printed page on a surface people tap through in 3 seconds)`,
    `    DEPRIORITIZE product_card_grid (multi-card layouts get cramped between a 250px chip band and a 250px reply band)`,
    `    AVOID        stat_led_social_proof (a numeric hero competes with the creator chip in the top reserved band)`,
    `    Drive curiosity or urgency over direct sell — the tap-forward is the enemy, not the scroll.`
  ].join('\n'),
  pmax_16_9: [
    `  ARCHETYPE WEIGHTING:`,
    `    PREFER  magazine_editorial (clean editorial spread reads as commercial/professional on landscape)`,
    `    PREFER  typographic_dominant (landscape gives headlines room to breathe — works well as a YouTube pre-roll)`,
    `    DEPRIORITIZE hero_quote_overlay (creator-quote energy reads as "Instagram ad" on YouTube/Display)`,
    `    AVOID        product_card_grid (multi-card layouts get clipped on small Display banner placements)`
  ].join('\n')
};

// ── the objective ────────────────────────────────────────────────────
//
// Shared verbatim by buildPrompt (V1) and buildPromptRound (V2) so the two
// paths cannot drift on what the ad is FOR. Without this, both prompts read as
// "match the signals" — signal-fitting, which optimises for a coherent-looking
// concept rather than for a sale. The Judge downstream scores against the same
// objective, so stating it here is what makes the two agree.
const OBJECTIVE_BLOCK = [
  `THE OBJECTIVE — every concept is judged on this:`,
  `This is direct-response advertising. The ad's job is to move someone who is BROWSING into BUYING. It is not to win a design award, not to be clever, and not to "build awareness". If a choice looks better but sells less, it is the wrong choice.`,
  ``,
  `What actually converts, strongest first:`,
  `  1. REMOVING A PURCHASE OBJECTION. Most people who don't buy have one specific unresolved worry — will it fit, is the colour real, is it durable, is it worth the price. Proof that answers that worry outsells proof that is merely flattering. A review saying "fits true to size" beats a review saying "I love it!!" every time, even though the second sounds more enthusiastic.`,
  `  2. A SPECIFIC, CHECKABLE CLAIM. "Holds a charge six days" converts; "long battery life" does not. Specificity reads as true; superlatives read as marketing.`,
  `  3. PROOF AT SCALE. A high rating with a large count (≥4.5 from ≥50) is credible on its own. A high rating from 3 reviews is not — lean on the quote instead of the number.`,
  `  4. ONE CLEAR NEXT ACTION. Competing CTAs convert worse than one.`,
  ``,
  `Applying it:`,
  `  - emotional_hook should name the objection the concept dissolves ("fit certainty", "worth the price", "will last") rather than a generic mood ("trust", "quality") whenever the data supports it.`,
  `  - When picking which proof to surface, prefer the quote that resolves a doubt over the quote that praises hardest.`,
  `  - NEVER build a concept around shipping, delivery, packaging or customer service. Those describe the retailer, not the product, and they do not move a purchase decision.`,
  `  - rationale must say WHICH objection the concept removes and WHICH signal supports it. "Looks premium" is not a rationale.`,
  `  - The honesty rule below is not in tension with this: an unsupported claim converts once and costs the client afterwards. Never promise proof the data can't back.`
].join('\n');

function buildFormatConstraints(platformFormat) {
  const { getFormatCaps, creativeBriefForPlatformFormat } = require('./platformFormats');
  const caps = getFormatCaps(platformFormat) || getFormatCaps('meta_feed_1_1');
  const { canvas, deliveryDims, safeArea, label, aspectRatio } = caps;
  const brief = creativeBriefForPlatformFormat(platformFormat);

  const lines = [];

  if (brief) {
    lines.push(`SURFACE CONTEXT — ${label}:`);
    lines.push(`  ${brief}`);
    lines.push(``);
  }

  lines.push(`FORMAT CONSTRAINTS — ${platformFormat} (${label}, ${aspectRatio}):`);
  const deliveryStr = deliveryDims
    ? ` (host delivers as ${deliveryDims.width}×${deliveryDims.height}; normalized to ${canvas.width}×${canvas.height})`
    : '';
  lines.push(`  Canvas:        ${canvas.width}×${canvas.height}${deliveryStr}`);

  if (safeArea.top > 0 || safeArea.bottom > 0) {
    const safeY = safeArea.top;
    const safeH = canvas.height - safeArea.top - safeArea.bottom;
    const pct   = Math.round((safeH / canvas.height) * 100);
    lines.push(`  Safe zones:    top 0–${safeArea.top}px AND bottom ${canvas.height - safeArea.bottom}–${canvas.height}px reserved for native UI — no chrome / text / CTA in those bands`);
    lines.push(`  Content rect:  x:0, y:${safeY}, w:${canvas.width}, h:${safeH} (the middle ${pct}% of canvas height)`);
  } else {
    lines.push(`  Safe zones:    none — surface has no reserved bands`);
  }

  const weighting = ARCHETYPE_WEIGHTING[platformFormat];
  if (weighting) {
    lines.push(weighting);
    lines.push(`  Honor the safe zones in your hierarchy — every concept's chrome must fit inside the content rect. The downstream Generator + Validator will reject zones intruding the reserved bands.`);
  } else {
    lines.push(`  ARCHETYPE WEIGHTING: all archetypes work; pick by signal as usual.`);
  }

  return lines.join('\n');
}

function buildPrompt({ inputSummary, creativeIntent, platformFormat = 'meta_feed_1_1' }) {
  const formatConstraints = buildFormatConstraints(platformFormat);
  const system = [
    `You are a creative director planning social-media ad creative for a brand.`,
    ``,
    `Your job: pick ${N_CONCEPTS} distinct creative concepts that match the signals below. You make STRATEGY decisions — archetype, hierarchy, recommended components — NOT coordinates. A downstream Layout Generator materializes each concept into pixels.`,
    ``,
    OBJECTIVE_BLOCK,
    ``,
    `RULES:`,
    `- DO NOT generate coordinates, rects, or pixel positions.`,
    `- The ${N_CONCEPTS} concepts MUST be meaningfully different — different archetype OR different emotional_hook OR different social_proof_type. Avoid two concepts that read the same.`,
    `- Lead with the STRONGEST signal in the data. If social_proof_signal.primary_quote is present and performance is low, lean into the testimonial — don't pick a stat_led archetype.`,
    `- If a signal is "absent" / null / empty, do not build a concept around it.`,
    `- HONESTY RULE: if social_proof_signal.primary_quote is null AND top_comments is empty AND rating is null, you MUST set social_proof_type="none" on EVERY concept. Do not promise proof the data can't back. In that case, also avoid the stat_led_social_proof and hero_quote_overlay archetypes — there is nothing to surface. Lean on brand voice (typographic_dominant, magazine_editorial) or the photo itself (full_bleed_hero_bottom_panel, vertical_split, diagonal_carve).`,
    ``,
    formatConstraints,
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

// ════════════════════════════════════════════════════════════════════
// V2 — Concept-driven director ROUND mode (Phase A — AI_CONCEPT_DRIVEN)
// ════════════════════════════════════════════════════════════════════
//
// Coexists with directConcepts above. No callers at land time; A5 wires
// expandWizardJob into directConceptsRound when AI_CONCEPT_DRIVEN=true.
//
// Differences from V1:
//   • Output count = 3 (vs 4) — operator presses Generate to get more.
//   • Append-only persistence — each Generate press writes a NEW
//     CreativeDirectionArtifact row with roundIndex incremented. No
//     replace-by-key. (V1 unique index on the 5-field tuple stays in
//     place; A5 deploys an index migration adding roundIndex as a 6th
//     dimension so V1 + V2 rows coexist.)
//   • AVOID list — prior rounds' concepts get summarized into the
//     prompt so the LLM doesn't repeat archetype × media-pick × copy-
//     angle combinations across rounds.
//   • Seeded media universe — the universe entries (from
//     seededUniverseService) get attached as vision inputs AND listed
//     in the prompt with their roles. Concepts MUST declare which
//     subset they use via media_picks.
//   • Each concept declares output_shape (static_single/collage/grid
//     for Feed; Reels storyboard added in Phase B) and copy_picks
//     (the final headline/eyebrow/cta strings the renderer ships).
//
// Phase A is FEED-ONLY (meta_feed_1_1). Reels (meta_reels_9_16) gets
// gated with a clear error so a misconfigured flag doesn't silently
// produce bad output. Phase B will add the Reels schema + Veo route.

const N_CONCEPTS_ROUND       = 3;
const ROUND_VERSION          = '1.0.0';   // bump when the round schema/prompt shape changes
const DIRECTOR_ROUND_MODEL   = 'gpt-4.1';
const DIRECTOR_ROUND_TEMP    = 0.8;       // a hair higher than V1 — round diversity matters
const DIRECTOR_ROUND_TOKENS  = 4000;      // 3 concepts × richer shape (media_picks + output_shape + copy_picks)
const AVOID_LIST_MAX_ROUNDS  = parseInt(process.env.DIRECTOR_AVOID_LIST_ROUNDS || '6', 10);
const VISION_ATTACHMENT_CAP  = 6;         // first N universe entries get attached as image_url parts

const CREATIVE_STYLES_ENUM = Object.freeze([
  'brand_led', 'ugc_led', 'social_proof_led', 'editorial', 'promotional'
]);

const FEED_OUTPUT_SHAPES = Object.freeze([
  'static_single',   // single hero image, chrome around it
  'static_collage',  // 2-4 images in an asymmetric arrangement (overlapping, off-grid)
  'static_grid'      // 2-4 images in a clean grid (2x2, 1x3, etc.)
]);

// Reels output shapes (Phase B1). reels_storyboard declares per-beat
// timing for chrome overlays Puppeteer will render on top of a Veo
// base video. The Director owns the storyboard (beat timing + roles +
// positions); Veo owns the base video; Puppeteer + Cloudinary composite
// the chrome onto Veo's output at the declared windows.
const REELS_OUTPUT_SHAPES = Object.freeze(['reels_storyboard']);

const STORYBOARD_BEAT_ROLES = Object.freeze([
  'eyebrow', 'headline', 'subheadline', 'cta', 'badge', 'quote', 'stat', 'logo'
]);
const STORYBOARD_POSITIONS = Object.freeze([
  'top', 'middle', 'bottom',
  'top_left', 'top_right',
  'middle_left', 'middle_right',
  'bottom_left', 'bottom_right'
]);
const STORYBOARD_EMPHASIS = Object.freeze(['subtle', 'normal', 'bold']);

// Reels duration bounds (seconds). Veo 3 generates 5-8s clips natively;
// longer clips would require concatenation which isn't in scope here.
const REELS_DURATION_MIN_SEC = 5;
const REELS_DURATION_MAX_SEC = 8;

// Phase A entry point. Returns the persisted artifact + the parsed
// concepts. Caller (expandWizardJob via A5) consumes concepts to write
// Ad rows; the artifact's _id becomes conceptArtifactId on each Ad.
async function directConceptsRound({
  brandId,
  productId      = null,    // null in brand-only mode — Director branches on campaignKind + productId presence downstream
  platformFormat = 'meta_feed_1_1',
  campaignKind   = null,
  campaignId     = null,    // when set, Campaign.creativeBrief is loaded + threaded into the prompt
  creativeIntent = null,
  seededUniverse,           // [{ mediaId, url, fileType, role, metadata }]
  seedUniverseHash = null,  // from seededUniverseService; persisted on the artifact
  roundIndex      = null,   // computed from prior rows when omitted
  avoidList       = null    // computed from prior rows when omitted
}) {
  if (!brandId) throw badRequest('brandId required');
  if (!Array.isArray(seededUniverse) || !seededUniverse.length) {
    throw badRequest('seededUniverse required and must be non-empty');
  }
  if (!process.env.OPENAI_API_KEY) {
    const e = new Error('OPENAI_API_KEY not set'); e.status = 500; throw e;
  }
  const { PLATFORM_FORMAT_KEYS } = require('./platformFormats');
  if (!PLATFORM_FORMAT_KEYS.includes(platformFormat)) {
    throw badRequest(`directConceptsRound: platformFormat="${platformFormat}" not supported. Allowed: ${PLATFORM_FORMAT_KEYS.join(', ')}.`);
  }

  // Compute roundIndex from prior artifact rows for this cache key when
  // the caller didn't supply one. The V1 row (roundIndex=null) is
  // ignored — V2 rounds count from 0 independently.
  const filter = {
    brandId,
    productId:      productId,
    campaignKind:   campaignKind || null,
    creativeIntent: creativeIntent || null,
    platformFormat
  };
  if (roundIndex == null) {
    const last = await CreativeDirectionArtifact.findOne({ ...filter, roundIndex: { $ne: null } })
      .sort({ roundIndex: -1 })
      .select('roundIndex')
      .lean();
    roundIndex = (last?.roundIndex == null) ? 0 : (last.roundIndex + 1);
  }

  // Build AVOID list from prior rounds (last AVOID_LIST_MAX_ROUNDS).
  // Each prior concept compresses to a one-liner the LLM can scan
  // quickly without ballooning the prompt.
  if (!Array.isArray(avoidList)) {
    avoidList = await loadAvoidList(filter, AVOID_LIST_MAX_ROUNDS);
  }

  // Build the V1-style signal package — Director still benefits from
  // the brand/product/proof/performance context regardless of whether
  // it's emitting strategy-only (V1) or full concept rows (V2).
  const signals = await assembleSignals({ brandId, productId, campaignKind });
  const inputSummary = { ...signals, platform_format: platformFormat };

  // Phase 2 — load derived brand voice + campaign brief if present.
  // Voice is global to the brand and threaded whenever it's been
  // derived; brief is per-campaign and only threaded when campaignId
  // was supplied (campaign-scoped generation). Both are optional —
  // Director still works without them, just leans more on signals.
  let derivedVoice = null;
  let creativeBrief = null;
  try {
    const Brand = require('../models/Brand');
    const brand = await Brand.findById(brandId).select('derivedVoice').lean();
    derivedVoice = brand?.derivedVoice || null;
  } catch (err) {
    console.warn(`   ⚠️  directorRound: Brand voice load failed (${err.message}) — proceeding without`);
  }
  if (campaignId) {
    try {
      const Campaign = require('../models/Campaign');
      const camp = await Campaign.findById(campaignId)
        .select('creativeBrief briefDerivedAt platform kind name objective targeting matchedProductIds status schedule insights adSets brandId')
        .lean();
      creativeBrief = camp?.creativeBrief || null;

      // Lazy synthetic-brief derivation for platform-native campaigns.
      // Platform-synced (meta-ads, google-ads) campaigns have their
      // brief derived at ingest by campaignSyncService. Platform-native
      // (reach-social) campaigns get theirs derived here on first use
      // — same output shape, same downstream flow.
      if (!creativeBrief && camp?.platform === 'reach-social') {
        try {
          const { deriveCampaignBrief } = require('./campaignBriefDerivationService');
          const result = await deriveCampaignBrief(campaignId, { derivedFrom: 'director_lazy' });
          if (result?.brief) {
            creativeBrief = result.brief;
            console.log(
              `📋 directorRound: derived synthetic brief for reach-social campaign=${campaignId} ` +
              `kind=${camp.kind || '-'} focus=${creativeBrief.focus || '-'} ` +
              `cta=${creativeBrief.cta_emphasis || '-'}`
            );
          }
        } catch (deriveErr) {
          console.warn(`   ⚠️  directorRound: synthetic brief derivation failed (${deriveErr.message}) — proceeding without`);
        }
      }
    } catch (err) {
      console.warn(`   ⚠️  directorRound: Campaign brief load failed (${err.message}) — proceeding without`);
    }
  }

  // Compress universe URLs for vision-token efficiency. Same helper the
  // V2 generator uses (aiCreativeV2Helpers.compressVisionAttachments).
  const { compressVisionAttachments } = require('./aiCreativeV2Helpers');
  const compressedUniverse = compressVisionAttachments(seededUniverse, 512);

  const { system, user, visionImages } = buildPromptRound({
    inputSummary, creativeIntent, platformFormat,
    universe: compressedUniverse,
    roundIndex, avoidList,
    derivedVoice, creativeBrief
  });
  const promptHash = sha256(system + '\n' + user);
  const responseSchema = buildResponseSchemaRound(seededUniverse, platformFormat);

  // OpenAI multimodal user content: text + image_url parts.
  const userContent = visionImages.length
    ? [
        { type: 'text', text: user },
        ...visionImages.map(img => ({ type: 'image_url', image_url: { url: img.url } }))
      ]
    : user;

  const t0 = Date.now();
  const completion = await chatCompletion(
    {
      stage:      'creative_director_round',
      provider:   'openai',
      model:      DIRECTOR_ROUND_MODEL,
      purposeTag: `round:${roundIndex}:${campaignKind || 'untagged'}`,
      brandId, productId,
      visionImages: visionImages.length,
      cacheKey:   `directorRound:${brandId}:${productId}:${platformFormat}:${roundIndex}`
    },
    {
      model: DIRECTOR_ROUND_MODEL,
      response_format: { type: 'json_schema', json_schema: responseSchema },
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: userContent }
      ],
      temperature: DIRECTOR_ROUND_TEMP,
      max_tokens:  DIRECTOR_ROUND_TOKENS
    }
  );
  const elapsedMs = Date.now() - t0;

  const raw = completion.choices?.[0]?.message?.content;
  if (!raw) throw new Error('Director (round) returned no content');

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (err) { throw new Error(`Director (round) response not JSON: ${err.message}`); }

  const warnings = validateConceptsRound(parsed.concepts || [], seededUniverse);

  console.log(
    `🎭 directorRound[r${roundIndex}/${platformFormat}]: ` +
    `brand=${brandId} product=${productId || '-'} kind=${campaignKind || '-'} ` +
    `universe=${seededUniverse.length} concepts=${(parsed.concepts || []).length} ` +
    `took=${elapsedMs}ms warnings=${warnings.length}`
  );

  // Append-only persistence. We do NOT use findOneAndReplace — every
  // round writes a NEW artifact. A5 will deploy the index migration so
  // append-only inserts don't collide with the legacy unique constraint.
  const artifact = await CreativeDirectionArtifact.create({
    ...filter,
    contractVersion:    '2.0',
    contractSchemaId:   'creative_direction_round.v1',
    signalsVersion:     DIRECTOR_SIGNALS_VERSION,
    roundIndex,
    seedUniverseHash,
    inputSummary,
    availableArchetypes:     [...AVAILABLE_ARCHETYPES],
    availableComponentRoles: [...ROLES],
    creativeRules:           { ...CREATIVE_RULES },
    concepts:                parsed.concepts || [],
    provider:    'openai',
    modelId:     DIRECTOR_ROUND_MODEL,
    promptHash,
    promptSystem: system,
    promptUser:   user,
    rawResponse:  raw,
    validationWarnings: warnings,
    createdAt:    new Date()
  });

  return {
    artifact:  artifact.toObject ? artifact.toObject() : artifact,
    concepts:  parsed.concepts || [],
    roundIndex,
    avoidListCount: avoidList.length,
    warnings
  };
}

// Build the AVOID block content from prior rounds' concepts. Returns
// an array of compact one-liner strings the prompt joins with newlines.
// Older rounds get pruned (most-recent first, capped at maxRounds).
async function loadAvoidList(filter, maxRounds) {
  const rows = await CreativeDirectionArtifact.find({ ...filter, roundIndex: { $ne: null } })
    .sort({ roundIndex: -1 })
    .limit(maxRounds)
    .select('roundIndex concepts')
    .lean();
  const out = [];
  for (const row of rows.reverse()) {  // chronological order in the prompt
    for (const c of row.concepts || []) {
      const mediaPickIds = Array.isArray(c.media_picks)
        ? c.media_picks.map(p => p.media_id).filter(Boolean).slice(0, 4).join(',')
        : '-';
      const headline = c.copy_picks?.headline
        ? `copy="${String(c.copy_picks.headline).slice(0, 60)}"`
        : '';
      out.push(
        `[round ${row.roundIndex}] archetype=${c.archetype || '-'} ` +
        `style=${c.creative_style || '-'} ` +
        `shape=${c.output_shape?.format || '-'} ` +
        `media=[${mediaPickIds}] ${headline}`.trim()
      );
    }
  }
  return out;
}

// Renders derivedVoice + creativeBrief as compact prompt blocks. Returns
// '' when the input is null so prompt callers can splice unconditionally.
function renderBrandVoiceBlock(voice) {
  if (!voice) return '';
  const lines = [];
  lines.push(`EXISTING BRAND VOICE (derived from ${voice.evidence_count || '?'} live ad creatives${voice.weighted ? ', performance-weighted' : ''}):`);
  if (Array.isArray(voice.tone) && voice.tone.length)            lines.push(`  Tone: ${voice.tone.join(', ')}`);
  if (Array.isArray(voice.value_props) && voice.value_props.length) lines.push(`  Recurring value props: ${voice.value_props.join('; ')}`);
  if (Array.isArray(voice.hooks) && voice.hooks.length)          lines.push(`  Hook patterns the brand uses: ${voice.hooks.join(', ')}`);
  if (Array.isArray(voice.common_phrases) && voice.common_phrases.length) {
    lines.push(`  Recurring phrases (use sparingly to echo brand voice): ${voice.common_phrases.map(p => `"${p}"`).join(', ')}`);
  }
  if (Array.isArray(voice.cta_patterns) && voice.cta_patterns.length) {
    const top = voice.cta_patterns.slice(0, 3).map(c => `"${c.text}"${c.frequency != null ? ` (${Math.round(c.frequency * 100)}%)` : ''}`).join(', ');
    lines.push(`  CTA patterns (dominant): ${top}`);
  }
  if (voice.voice_summary) lines.push(`  Summary: ${voice.voice_summary}`);
  lines.push(`  Use this voice profile to calibrate emotional_hook, copy_picks tone, and CTA wording. Where it conflicts with the operator's tagline, the operator wins; where it conflicts with the campaign brief below, the campaign brief wins.`);
  return lines.join('\n');
}

function renderCampaignBriefBlock(brief, productName = null) {
  if (!brief) return '';
  const lines = [];
  lines.push(`CAMPAIGN BRIEF (the intent of THIS specific campaign — concepts must serve it):`);
  // A campaign brief is written once for the CAMPAIGN, and its goal routinely
  // names one specific product ("Introduce the Training Straight Leg Leggings
  // in Strength Pink..."). Every product generated under that campaign then
  // received it verbatim, under the instruction that concepts MUST serve it —
  // so the Director dutifully wrote leggings copy for a t-shirt, and the
  // one-product rule below lost the argument to a more specific instruction
  // sitting in the same prompt.
  //
  // The brief's STRATEGY still applies to every product in the campaign; only
  // the product its goal happens to name does not.
  if (productName) {
    lines.push(`  SCOPE: this concept is for "${productName}". Where the goal or pitch below names a DIFFERENT product, that naming does NOT apply here — it is campaign-level context. Serve the campaign's strategy (funnel stage, tone, audience, CTA emphasis) for THIS product, and never carry another product's name, category, or attributes into your copy.`);
  }
  if (brief.goal)         lines.push(`  Goal: ${brief.goal}`);
  if (brief.pitch)        lines.push(`  Pitch: ${brief.pitch}`);
  if (brief.focus)        lines.push(`  Dominant lever: ${brief.focus}`);
  if (brief.cta_emphasis) lines.push(`  CTA emphasis: ${brief.cta_emphasis}`);
  if (Array.isArray(brief.tone) && brief.tone.length) lines.push(`  Tone for THIS campaign: ${brief.tone.join(', ')}`);
  if (brief.audience) {
    const a = brief.audience;
    if (a.description) lines.push(`  Audience: ${a.description}`);
    const fragments = [];
    if (a.ageRange) fragments.push(`age ${a.ageRange}`);
    if (Array.isArray(a.geo) && a.geo.length) fragments.push(`geo ${a.geo.slice(0, 8).join('/')}`);
    if (Array.isArray(a.interests) && a.interests.length) fragments.push(`interests ${a.interests.slice(0, 6).join(', ')}`);
    if (Array.isArray(a.segments) && a.segments.length) fragments.push(`segments ${a.segments.slice(0, 4).join(', ')}`);
    if (fragments.length) lines.push(`    (${fragments.join('; ')})`);
  }
  lines.push(
    productName
      ? `  Every concept you emit MUST serve this campaign's STRATEGY — its funnel stage, tone, audience and CTA emphasis — as applied to "${productName}". If a concept doesn't advance that, drop it for one that does. Serving the brief never means advertising a product other than "${productName}".`
      : `  Every concept you emit MUST serve the campaign goal + pitch. If a concept doesn't advance this brief, drop it for one that does.`
  );
  return lines.join('\n');
}

function buildPromptRound({ inputSummary, creativeIntent, platformFormat, universe, roundIndex, avoidList, derivedVoice = null, creativeBrief = null }) {
  const formatConstraints = buildFormatConstraints(platformFormat);
  const brandVoiceBlock   = renderBrandVoiceBlock(derivedVoice);
  const campaignBriefBlock = renderCampaignBriefBlock(creativeBrief, inputSummary?.product_signal?.name || null);

  // Build the universe block — the LLM uses these media_id values
  // verbatim in concept.media_picks. Roles surface so the LLM knows
  // which is hero vs alt vs UGC.
  const universeBlock = universe.map(u => {
    const meta = u.metadata || {};
    const bits = [];
    if (meta.shotType)  bits.push(`shot=${meta.shotType}`);
    if (meta.imageRole) bits.push(`imageRole=${meta.imageRole}`);
    if (meta.creator?.handle) bits.push(`creator=@${meta.creator.handle}`);
    if (meta.engagement?.likes != null) bits.push(`likes=${meta.engagement.likes}`);
    return `  - media_id=${u.mediaId} role=${u.role} fileType=${u.fileType} ${bits.join(' ')}`.trim();
  }).join('\n');

  // First N universe entries become vision attachments.
  const visionImages = universe.slice(0, VISION_ATTACHMENT_CAP);

  const avoidBlock = (avoidList && avoidList.length)
    ? [
        `AVOID — concepts already shipped in earlier rounds for this product:`,
        ...avoidList.map(l => `  ${l}`),
        ``,
        `Your ${N_CONCEPTS_ROUND} new concepts MUST differ from every line above. Hierarchy of variety, in order:`,
        `  1. (HARD) PREFER DIFFERENT MEDIA. If the seeded universe contains media_ids that have NOT been used in any prior round, prioritize those for at least 1 of your N concepts. Reusing the same primary media as a prior round is allowed ONLY when the universe offers no fresh alternative.`,
        `  2. Differ on archetype or output_shape from prior rounds.`,
        `  3. Differ on copy headline angle (emotional hook).`,
        `Round counter is below — later rounds should lean harder into less-used media. NOTE: the universe is pre-ranked (see MEDIA PICKS rule above) — respect that ranking as the primary quality signal. Round-to-round variety is a soft preference; don't sacrifice a lifestyle/on_model top-ranked pick just to differ from a prior round when the alternative is a product_only/detail/packaging shot.`
      ].join('\n')
    : `AVOID — no prior rounds for this product. You're on round 0; lead with the strongest signal.`;

  const system = [
    `You are a senior creative director planning social-media ad creative.`,
    ``,
    `Your job: emit ${N_CONCEPTS_ROUND} distinct creative concepts. Each concept declares: archetype + composition strategy (the V1 fields), WHICH media from the seeded universe it uses (media_picks), what output shape it materializes (output_shape), and the final copy strings it ships (copy_picks).`,
    ``,
    `ROUND CONTEXT: this is round ${roundIndex} for this product on ${platformFormat}. Earlier rounds (if any) are summarized in the AVOID block below. Each Generate press from the operator triggers a new round; concept diversity across rounds matters as much as within-round diversity.`,
    ``,
    OBJECTIVE_BLOCK,
    ``,
    `RULES:`,
    `- DO NOT generate coordinates, rects, or pixel positions. The Layout stage materializes pixels from your strategy + media_picks + output_shape declaration.`,
    `- The ${N_CONCEPTS_ROUND} concepts MUST be meaningfully different — different archetype OR different media-pick combination OR different output_shape OR different copy angle.`,
    `- Lead with the STRONGEST signal in the data.`,
    `- HONESTY RULE: if social_proof_signal.primary_quote is null AND top_comments is empty AND rating is null, you MUST set social_proof_type="none" on EVERY concept. Don't promise proof the data can't back. In that case also avoid stat_led_social_proof and hero_quote_overlay — lean on brand voice (typographic_dominant, magazine_editorial) or the photo itself.`,
    `- MEDIA PICKS: every media_id you reference in media_picks MUST appear in the SEEDED UNIVERSE block below. Pick by media_id verbatim. role is a short label describing how the media sits in your composition. Pick 1-4 media per concept; Reels picks 1 video (preferred) or 1-4 image references for Veo synthesis.`,
    `- [CRITICAL] The SEEDED UNIVERSE is PRE-RANKED by shot-type quality: lifestyle > on_model > flat_lay > product_only > detail > packaging. Earlier entries are BETTER seeds for animation and stronger composition anchors — STRONGLY prefer them for media_picks[0]. Only reach for lower-ranked entries when a specific concept archetype requires that shot type (e.g. product_card_grid can use flat_lay/product_only intentionally, hero_quote_overlay wants lifestyle/on_model).`,
    platformFormat === 'meta_reels_9_16'
      ? `- OUTPUT SHAPE (Reels): format MUST be "reels_storyboard". duration_sec ∈ [${REELS_DURATION_MIN_SEC}, ${REELS_DURATION_MAX_SEC}] (Veo native clip range). storyboard_beats is an array of overlay timing events Puppeteer renders as transparent PNGs and Cloudinary composites onto Veo's base video. Each beat: { t_start (seconds), t_end, role ∈ ${STORYBOARD_BEAT_ROLES.join('|')}, position ∈ ${STORYBOARD_POSITIONS.join('|')}, emphasis ∈ ${STORYBOARD_EMPHASIS.join('|')} }. Beats may overlap. Honor the Reels safe zones in your position picks (top reserved 0-220px, bottom reserved 1558-1778px — use middle positions for chrome that needs to be visible past IG/FB UI).`
      : `- OUTPUT SHAPE (Feed): format ∈ ${FEED_OUTPUT_SHAPES.join(' | ')}; tile_count matches media_picks.length.`,
    `- COPY PICKS: write the final strings the renderer will ship. Pull from brand_signal.tagline / description / brand_reviews_summary, product_signal.description, and social_proof_signal.primary_quote when grounding. Use null for any role the concept intentionally omits (e.g. eyebrow=null when the design has no eyebrow rule). Storyboard beats reference copy_picks by role — each beat's role MUST map to a non-null copy_picks field (e.g. role=headline beat requires copy_picks.headline non-null).`,
    `- ONE PRODUCT ONLY: every string you write describes product_signal.name and nothing else. brand_signal.* and brand_reviews_summary cover the WHOLE catalog — they are there for voice and tone, never for product facts. Never name, describe, or borrow the attributes of another item (a different garment, cut, fabric, or use case) even when the brand material talks about it. If the brand voice material is about a different product, take only its register and write fresh copy about THIS one. Concretely: a t-shirt ad never mentions leggings, joggers, or their fit.`,
    `- CREATIVE STYLE: pick one of ${CREATIVE_STYLES_ENUM.join(' | ')}.`,
    ``,
    formatConstraints,
    ``,
    // PHASE 2 — voice + brief context. Splices in conditionally; both
    // are empty strings when absent so the prompt structure stays
    // stable. Voice → brand-global, brief → this-campaign-specific.
    // Brief is read AFTER voice intentionally — when they disagree on
    // tone/cta, the brief wins (it's the more specific context).
    brandVoiceBlock ? brandVoiceBlock + '\n' : '',
    campaignBriefBlock ? campaignBriefBlock + '\n' : '',
    avoidBlock,
    ``,
    `SEEDED MEDIA UNIVERSE (use media_id verbatim in media_picks; vision attachments below show the first ${VISION_ATTACHMENT_CAP}):`,
    universeBlock,
    ``,
    `AVAILABLE ARCHETYPES (pick one per concept):`,
    AVAILABLE_ARCHETYPES.map(a => `  ${a}`).join('\n'),
    ``,
    `AVAILABLE ROLES (used in recommended_components — map of role → component_style):`,
    ROLES.map(r => `  ${r}: [${(COMPONENT_STYLE_BY_ROLE[r] || []).join(', ')}]`).join('\n'),
    ``,
    `Per concept emit:`,
    `  concept_id       — short slug (must be unique within this round)`,
    `  name             — human-readable concept name`,
    `  archetype        — one of the available archetypes`,
    `  layout_family    — short alias`,
    `  emotional_hook   — what the ad triggers`,
    `  social_proof_type — testimonial / stat / creator / review / rating / none`,
    `  *_priority       — high/medium/low/absent for product, ugc, comment, stat`,
    `  cta_emphasis     — primary/secondary/minimal/absent`,
    `  creative_style   — one of the creative styles enum`,
    `  recommended_components — map of role → component_style`,
    `  media_picks      — [{ media_id, role, notes }] referencing SEEDED UNIVERSE`,
    platformFormat === 'meta_reels_9_16'
      ? `  output_shape     — { format: 'reels_storyboard', duration_sec, storyboard_beats: [{t_start, t_end, role, position, emphasis}] }`
      : `  output_shape     — { format, tile_count }`,
    `  copy_picks       — { headline, subheadline, eyebrow, cta } final strings (nullable per role)`,
    `  rationale        — 1-2 sentences explaining how the signal + universe drove the call`
  ].join('\n');

  const user = [
    `INPUT SUMMARY (signals you're directing for):`,
    '```json',
    JSON.stringify(inputSummary, null, 2),
    '```',
    ``,
    creativeIntent ? `OPERATOR HINT: ${creativeIntent}` : `OPERATOR HINT: none — you decide.`,
    ``,
    `Emit ${N_CONCEPTS_ROUND} distinct concepts that honor the AVOID block, draw from the SEEDED UNIVERSE, and ground every copy_pick in real signal.`
  ].join('\n');

  return { system, user, visionImages };
}

function buildResponseSchemaRound(seededUniverse, platformFormat = 'meta_feed_1_1') {
  // We don't enum-constrain media_id to the universe IDs here — strict
  // mode's enum is fine in principle but the universe IDs are a string
  // set that changes per call. validateConceptsRound enforces the
  // "media_id must be in universe" rule post-parse.
  //
  // output_shape branches per format (Phase B1). Strict mode forbids
  // varying object shapes via oneOf, so we emit a single schema
  // tailored to platformFormat at build time.
  const isReels = platformFormat === 'meta_reels_9_16';

  const outputShapeSchema = isReels
    ? {
        type: 'object',
        additionalProperties: false,
        required: ['format', 'duration_sec', 'storyboard_beats'],
        properties: {
          format:       { type: 'string', enum: [...REELS_OUTPUT_SHAPES] },
          duration_sec: { type: 'integer', minimum: REELS_DURATION_MIN_SEC, maximum: REELS_DURATION_MAX_SEC },
          storyboard_beats: {
            type: 'array',
            minItems: 1,
            maxItems: 8,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['t_start', 't_end', 'role', 'position', 'emphasis'],
              properties: {
                t_start:  { type: 'number', minimum: 0 },
                t_end:    { type: 'number', minimum: 0 },
                role:     { type: 'string', enum: [...STORYBOARD_BEAT_ROLES] },
                position: { type: 'string', enum: [...STORYBOARD_POSITIONS] },
                emphasis: { type: 'string', enum: [...STORYBOARD_EMPHASIS] }
              }
            }
          }
        }
      }
    : {
        type: 'object',
        additionalProperties: false,
        required: ['format', 'tile_count'],
        properties: {
          format:     { type: 'string', enum: [...FEED_OUTPUT_SHAPES] },
          tile_count: { type: 'integer' }
        }
      };

  return {
    name: isReels ? 'creative_director_round_reels_v1' : 'creative_director_round_feed_v1',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['concepts'],
      properties: {
        concepts: {
          type: 'array',
          minItems: N_CONCEPTS_ROUND,
          maxItems: N_CONCEPTS_ROUND,
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'concept_id', 'name', 'archetype', 'layout_family',
              'emotional_hook', 'social_proof_type',
              'product_priority', 'ugc_priority', 'comment_priority', 'stat_priority', 'cta_emphasis',
              'creative_style',
              'recommended_components', 'rationale',
              'media_picks', 'output_shape', 'copy_picks'
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
              creative_style:    { type: 'string', enum: [...CREATIVE_STYLES_ENUM] },
              recommended_components: {
                type: 'object',
                additionalProperties: false,
                required: [...ROLES],
                properties: Object.fromEntries(
                  ROLES.map(r => [r, { type: ['string', 'null'] }])
                )
              },
              rationale: { type: 'string' },
              media_picks: {
                type: 'array',
                minItems: 1,
                maxItems: 4,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['media_id', 'role', 'notes'],
                  properties: {
                    media_id: { type: 'string' },
                    role:     { type: 'string' },
                    notes:    { type: ['string', 'null'] }
                  }
                }
              },
              output_shape: outputShapeSchema,
              copy_picks: {
                type: 'object',
                additionalProperties: false,
                required: ['headline', 'subheadline', 'eyebrow', 'cta'],
                properties: {
                  headline:    { type: ['string', 'null'] },
                  subheadline: { type: ['string', 'null'] },
                  eyebrow:     { type: ['string', 'null'] },
                  cta:         { type: ['string', 'null'] }
                }
              }
            }
          }
        }
      }
    },
    strict: true
  };
}

// Soft-warning validator for V2 concepts. Hard rejection moves to the
// Judge in A4. Here we surface useful diagnostics:
//   • duplicate concept_ids within a round
//   • media_picks referencing IDs outside the seeded universe
//   • output_shape.tile_count != media_picks.length
//   • all copy_picks null (probably an LLM miss)
function validateConceptsRound(concepts, seededUniverse) {
  const warnings = [];
  if (!Array.isArray(concepts) || !concepts.length) {
    warnings.push('no concepts emitted');
    return warnings;
  }
  const universeIds = new Set(seededUniverse.map(u => String(u.mediaId)));
  const conceptIds = new Set();

  for (const c of concepts) {
    if (!c?.concept_id) continue;
    if (conceptIds.has(c.concept_id)) {
      warnings.push(`duplicate concept_id "${c.concept_id}" within round`);
    }
    conceptIds.add(c.concept_id);

    const picks = Array.isArray(c.media_picks) ? c.media_picks : [];
    for (const p of picks) {
      if (!p?.media_id) continue;
      if (!universeIds.has(String(p.media_id))) {
        warnings.push(`concept ${c.concept_id}: media_pick "${p.media_id}" not in seeded universe`);
      }
    }

    const tileCount = c.output_shape?.tile_count;
    if (typeof tileCount === 'number' && tileCount !== picks.length) {
      warnings.push(`concept ${c.concept_id}: output_shape.tile_count=${tileCount} != media_picks.length=${picks.length}`);
    }

    const cp = c.copy_picks || {};
    if (cp.headline == null && cp.subheadline == null && cp.eyebrow == null && cp.cta == null) {
      warnings.push(`concept ${c.concept_id}: all copy_picks are null (likely LLM miss)`);
    }

    // Single-format sanity
    if (c.output_shape?.format === 'static_single' && picks.length !== 1) {
      warnings.push(`concept ${c.concept_id}: output_shape=static_single requires 1 media_pick (got ${picks.length})`);
    }
    if (['static_collage', 'static_grid'].includes(c.output_shape?.format) && (picks.length < 2 || picks.length > 4)) {
      warnings.push(`concept ${c.concept_id}: output_shape=${c.output_shape.format} requires 2-4 media_picks (got ${picks.length})`);
    }

    // Reels storyboard sanity (Phase B1):
    //   • duration_sec within [REELS_DURATION_MIN_SEC, REELS_DURATION_MAX_SEC]
    //   • beats t_end > t_start
    //   • beats t_end <= duration_sec
    //   • beat role maps to a non-null copy_picks field (where applicable)
    //   • at least one beat present
    if (c.output_shape?.format === 'reels_storyboard') {
      const dur = c.output_shape.duration_sec;
      if (typeof dur !== 'number' || dur < REELS_DURATION_MIN_SEC || dur > REELS_DURATION_MAX_SEC) {
        warnings.push(`concept ${c.concept_id}: reels_storyboard duration_sec=${dur} outside [${REELS_DURATION_MIN_SEC},${REELS_DURATION_MAX_SEC}]`);
      }
      const beats = Array.isArray(c.output_shape.storyboard_beats) ? c.output_shape.storyboard_beats : [];
      if (!beats.length) {
        warnings.push(`concept ${c.concept_id}: reels_storyboard has zero storyboard_beats`);
      }
      const copyRoleToField = {
        headline:    'headline',
        eyebrow:     'eyebrow',
        subheadline: 'subheadline',
        cta:         'cta'
        // badge/quote/stat/logo don't bind to copy_picks — they're
        // either signal-derived (rating, stat) or brand-derived (logo).
      };
      for (const beat of beats) {
        if (typeof beat?.t_start !== 'number' || typeof beat?.t_end !== 'number') continue;
        if (beat.t_end <= beat.t_start) {
          warnings.push(`concept ${c.concept_id}: beat role=${beat.role} t_end (${beat.t_end}) <= t_start (${beat.t_start})`);
        }
        if (typeof dur === 'number' && beat.t_end > dur) {
          warnings.push(`concept ${c.concept_id}: beat role=${beat.role} t_end (${beat.t_end}) > duration_sec (${dur})`);
        }
        const requiredCopyField = copyRoleToField[beat.role];
        if (requiredCopyField && cp[requiredCopyField] == null) {
          warnings.push(`concept ${c.concept_id}: beat role=${beat.role} references copy_picks.${requiredCopyField} which is null`);
        }
      }
    }
  }

  // Distinctness — fingerprint by archetype + output_shape + media-pick-set + headline angle.
  if (concepts.length >= 2) {
    const fingerprints = concepts.map(c => {
      const ms = Array.isArray(c.media_picks)
        ? c.media_picks.map(p => p.media_id).sort().join(',')
        : '';
      return `${c.archetype}|${c.output_shape?.format}|${ms}|${(c.copy_picks?.headline || '').slice(0, 30)}`;
    });
    if (new Set(fingerprints).size < concepts.length) {
      warnings.push(`concepts not distinct — fingerprints: ${fingerprints.join(' / ')}`);
    }
  }

  return warnings;
}

module.exports = {
  directConcepts,
  directConceptsRound,
  assembleSignals,
  AVAILABLE_ARCHETYPES,
  CREATIVE_RULES,
  CREATIVE_STYLES_ENUM,
  FEED_OUTPUT_SHAPES,
  REELS_OUTPUT_SHAPES,
  STORYBOARD_BEAT_ROLES,
  STORYBOARD_POSITIONS,
  STORYBOARD_EMPHASIS,
  REELS_DURATION_MIN_SEC,
  REELS_DURATION_MAX_SEC,
  MODEL_ID,
  ROUND_VERSION,
  N_CONCEPTS_ROUND,
  // exposed for testing
  buildPromptRound,
  buildResponseSchemaRound,
  validateConceptsRound,
  loadAvoidList
};
