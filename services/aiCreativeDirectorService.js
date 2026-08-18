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
// Salvage parser for Director output — Atlas silently ignores
// response_format:json_object on the Anthropic director model, so a reply can
// arrive fenced or wrapped in prose. Mirrors judgeService's JSON5 precedent.
const JSON5 = require('json5');

const Brand                 = require('../models/Brand');
const CatalogProduct        = require('../models/CatalogProduct');
const Category              = require('../models/Category');
const Media                 = require('../models/Media');
const ProductMatchArtifact  = require('../models/ProductMatchArtifact');
const CreativeDirectionArtifact = require('../models/CreativeDirectionArtifact');

const { ROLES, COMPONENT_STYLE_BY_ROLE } = require('./aiVocabulary');
const alerts = require('./alertService');
const { trackLlmCall, recordCacheHit } = require('./costTracker');
const { conceptField, conceptMediaPicks } = require('./conceptProjection');

const { chatCompletion, chainOutcome } = require('./atlasLlmService');
// ONE shared LLM error taxonomy — see services/llmError.js. Imported, never
// re-implemented per call site (CLAUDE.md §4 records three production
// incidents from a helper that was called but not imported; `npm run lint`'s
// no-undef is the net that catches the next one).
const {
  LLM_ERROR_CODES, LLM_ACTIONS, makeLlmError, stampLlmAction, formatLlmLogLine,
} = require('./llmError');
const { usableProofCommentsOrNone } = require('./quoteSnippetService');
const {
  toPrintableCustomerQuote,
  selectBrandQuotesForScope,
  quoteProvenanceStrictEnabled,
  loadQuoteScopeMediaByIds
} = require('./quoteProvenance');
const { formatBrandReviewsText, formatProductReviewsText } = require('./ratingDisplay');
const { resolveDirectorProductRatingPair } = require('./ratingPairAtomic');

// Master switch for the proof MENU (category tier + social_proof_signal.
// proof_options[] + routing.proof_pick). Default OFF: assembleSignals'
// output is BYTE-IDENTICAL with the flag off — no category_signal key, no
// proof_options key — so this ships with zero cost and zero behaviour
// change until deliberately enabled. See DIRECTOR_PROOF_MENU below for why
// "on" is still nearly free even for the LIVE path.
function directorProofMenuEnabled() {
  return String(process.env.DIRECTOR_PROOF_MENU_ENABLED ?? 'false').toLowerCase() === 'true';
}

// DIRECTOR_QUOTE_POOL_ALIGNED (default false). Independent of
// QUOTE_STAGE_AWARE so the two levers can flip separately.
// Flag-off: primary_quote is product.reviews[0] (SerpAPI arrival
// order) — today's assembleSignals source.
// Flag-on: productReviews.quotes through the SAME pipeline render
// uses (stamp → printable → star gate → pickStrongestQuote).
function directorQuotePoolAlignedEnabled() {
  return String(process.env.DIRECTOR_QUOTE_POOL_ALIGNED || 'false').toLowerCase() === 'true';
}

// DIRECTOR_FUNNEL_STAGE_ALL (default false). PMax already asks for
// routing.funnel_stage (one of each across the round). Flag-on extends
// the schema + a lighter declare-the-stage prompt to EVERY destination
// so Meta concept-driven statics can carry Ad.funnelStage too.
// Flag-off Meta prompt/schema stay byte-identical.
function directorFunnelStageAllEnabled() {
  return String(process.env.DIRECTOR_FUNNEL_STAGE_ALL || 'false').toLowerCase() === 'true';
}

function shouldEmitFunnelStage(platformFormat) {
  return isPmaxPlatformFormat(platformFormat) || directorFunnelStageAllEnabled();
}

function mapArrivalReview(r) {
  return {
    text:   r.text || r.body || r.content,
    author: r.author || r.reviewer || r.user_name
  };
}

/**
 * Pure flag-fork for assembleSignals' primary_quote source.
 * Exported so the harness can assert flag-off === reviews[0] and
 * flag-on === pickStrongestQuote(productReviews.quotes) without Mongo.
 *
 * `opts` is forwarded to pickPrimaryProductQuote (stage / angleTerms).
 * assembleSignals has no per-concept stage yet (stage is a Director
 * OUTPUT), so the single primary_quote field stays the unstaged
 * strongest. When QUOTE_STAGE_AWARE is on, assembleSignals also
 * fills quotes_by_stage by calling this with each stage.
 *
 * @param {object|null} product  CatalogProduct-shaped doc
 * @param {object} [opts]
 * @returns {{text:string, author?:string}|null}
 */
function pickDirectorPrimaryQuote(product, opts) {
  if (!directorQuotePoolAlignedEnabled()) {
    const reviews = Array.isArray(product?.reviews) ? product.reviews : [];
    const mapped = reviews
      .map(mapArrivalReview)
      .filter((r) => typeof r.text === 'string' && r.text.trim().length > 30);
    return mapped[0] || null;
  }
  let pickPrimaryProductQuote;
  try {
    pickPrimaryProductQuote = require('./layoutInputService').pickPrimaryProductQuote;
  } catch {
    pickPrimaryProductQuote = null;
  }
  if (typeof pickPrimaryProductQuote !== 'function') return null;
  const picked = pickPrimaryProductQuote(product?.productReviews, opts || {});
  if (!picked || !picked.text) return null;
  return {
    text:   picked.text,
    author: picked.author_name || picked.author || null
  };
}

/**
 * Product-tier quotes for the Director signal.
 * Flag-off: Immersive product.reviews (arrival order, length > 30).
 * Flag-on: the SAME prepareQuotePool render uses (stamp → printable
 * → star gate). proof_options and primary_quote must not diverge.
 */
function productQuotesForDirector(product) {
  if (!directorQuotePoolAlignedEnabled()) {
    return (Array.isArray(product?.reviews) ? product.reviews : [])
      .map(mapArrivalReview)
      .filter((r) => typeof r.text === 'string' && r.text.trim().length > 30);
  }
  let prepareQuotePool;
  try {
    prepareQuotePool = require('./layoutInputService').prepareQuotePool;
  } catch {
    prepareQuotePool = null;
  }
  if (typeof prepareQuotePool !== 'function') return [];
  return prepareQuotePool(
    product?.productReviews,
    product?.productReviews?.quotes,
    'product'
  ).map((q) => ({
    text:   q.text,
    author: q.author_name || q.author || null,
    rating: q.rating,
    origin: q.origin
  })).filter((q) => typeof q.text === 'string' && q.text.trim().length > 30);
}

/**
 * Pure brand-quote → Director primary_quote shape. brandReviews is the
 * llm-web pool; route through the gate so the Director never sees a byline
 * it can echo into copy.headline / subheadline. Exported for the provenance
 * harness.
 */
function brandQuoteForDirectorSignal(q) {
  const raw = (typeof q === 'string')
    ? { text: q, origin: 'llm-web', verbatim: false }
    : {
        text:        q?.text   || q?.body || q?.content || null,
        author:      q?.author || q?.reviewer || q?.user_name || null,
        author_name: q?.author_name || null,
        source:      q?.source || null,
        verified:    q?.verified,
        origin:      q?.origin || 'llm-web',
        verbatim:    q?.verbatim !== undefined ? q.verbatim : false
      };
  const printable = toPrintableCustomerQuote(raw);
  if (!printable) return null;
  return {
    text:   printable.text,
    author: printable.author || printable.author_name || null
  };
}

/**
 * Build the Director's proof-point menu — one option per tier
 * (product / category / brand), each carrying its own SCOPED numeric
 * disclosure so a copy-writing LLM cannot describe a brand/category
 * aggregate as if it were this product's own number.
 *
 * PURE — no Mongoose, no I/O. Exists as its own function specifically so
 * this truthfulness-sensitive logic can be unit-tested without a database
 * connection (see scripts/verifyDirectorProofMenu.js).
 *
 * A tier is omitted entirely when it has neither a number nor a quote —
 * `proof_options` only ever lists what is actually usable, matching the
 * "ABSENT MEANS ABSENT" rule the rest of this file already enforces.
 *
 * DISCLOSURE IS DECOUPLED FROM THE DISPLAY STAR FLOOR, ON PURPOSE. An
 * adversarial review caught a BLOCKER in the first version of this function:
 * it built `reviews_text` via `resolveCoherentSocialProof`, which is the
 * right call for what actually RENDERS on an ad (that function's job is
 * exactly "is this pair good enough to print"), but wrong here — its
 * rating-only branch nulls the ENTIRE pair, count included, whenever the star
 * rating alone misses the display floor. That left `review_count: 41000`
 * with `reviews_text: null` for e.g. a 3.3-star brand — a raw, unscoped
 * number reaching the Director with no disclosure telling it that number is
 * brand-wide, not this product's. A review COUNT is a fact independent of
 * star quality, so this menu always names its scope whenever a count exists,
 * via `formatBrandReviewsText` / `formatProductReviewsText` directly — the
 * SAME formatters `resolveCoherentSocialProof` itself calls internally, just
 * without that function's separate "is the STAR worth printing" gate. The
 * star-floor rule is fully intact for what actually renders on the ad; it
 * only no longer silently deletes a fact this menu is allowed to state.
 *
 * @param {object} tiers
 * @param {{rating:number|null, reviewCount:number|null, quotes:Array}} tiers.product
 * @param {{rating:number|null, reviewCount:number|null, quotes:Array}} tiers.category
 * @param {{rating:number|null, reviewCount:number|null, quotes:Array}} tiers.brand
 * @returns {Array<{tier:string, rating:number|null, review_count:number|null, reviews_text:string|null, quotes:Array}>}
 */
// Stand-in for "this concept nulled its headline" in the duplicate-line check.
// See validateDirectorPayload for why nulls have to participate in that
// comparison at all.
//
// A SYMBOL, not a string, and that is the point: it must collide with other
// nulls and with NOTHING else. Any string sentinel is a headline the model
// could in principle emit, so the guard would then mis-report a real duplicate
// as "concepts left the headline null". A fresh Symbol is unequal to every
// string by construction, so the two failure modes stay distinguishable.
const NULL_HEADLINE_SENTINEL = Symbol('null-headline');

// How many quotes each proof tier offers the Director. Three concepts per round
// need at least three distinct lines to ground on before they start repeating;
// 4 leaves headroom without bloating a prompt that already carries three tiers.
const MAX_QUOTES_PER_TIER = 4;

// Lazily-bound, fail-open wrapper around layoutInputService.scoreQuote.
//
// LAZY: layoutInputService is a heavy module (it pulls templateRegistry and
// videoHeadlineService) and this file is required by the generation service on
// every run. The require chain is layoutInputService → videoHeadlineService →
// CreativeDirectionArtifact, with no path back here, so a top-level import
// would not be circular — but deferring it keeps module load flat and matches
// how snippetText already inlines its htmlEntities require.
//
// FAIL-OPEN: a scorer that throws or goes missing must not take down a paid
// Director call over the ORDER of a quote list. Returning 0 for everything
// degrades ranking to arrival order, which is exactly the pre-change behaviour.
let _scoreQuote = null;
function scoreQuoteSafe(text) {
  if (_scoreQuote === null) {
    try {
      _scoreQuote = require('./layoutInputService').scoreQuote || false;
    } catch {
      _scoreQuote = false;
    }
  }
  if (!_scoreQuote) return 0;
  try {
    const n = _scoreQuote(String(text || ''));
    if (Number.isFinite(n)) return n;
    // -Infinity IS A VERDICT, NOT A MISSING VALUE. The scorer returns it for
    // hard limiters and negative sentiment ("broke after one day"). Collapsing
    // it to 0 ranked those level with merely-generic praise and ABOVE anything
    // scoring -1 or -2 — so the ranking meant to demote junk was promoting the
    // worst class of it into the Director's top-4. Map it to a floor that keeps
    // it last instead. Any other non-finite result is a scorer malfunction, not
    // a judgement, so it degrades to neutral.
    return n === -Infinity ? Number.NEGATIVE_INFINITY : 0;
  } catch {
    return 0;
  }
}

function buildDirectorProofOptions({ product, category, brand }) {
  // A SECOND adversarial pass (independent of the one that led to the count
  // fix above) caught a second, separate gap: this only ever scoped the
  // COUNT. A rating with NO count at all — a realistic shape, not a corner
  // case — still fell all the way through to `return null`, so a bare
  // `rating: 4.8` under `tier: 'brand'` reached the Director with zero
  // disclosure aid, same failure class as the count bug, different field.
  // PRODUCT tier deliberately stays unscoped here (`return null`) — that
  // matches the rendered ad's own convention (a product-tier bare rating
  // needs no qualifier; it IS the ad's own product) and mirrors how
  // formatProductReviewsText/formatBrandReviewsText only ever take a count,
  // never a rating, throughout this codebase.
  const scopedNumbers = (rating, reviewCount, tier) => {
    if (reviewCount != null) {
      if (tier === 'category') {
        return reviewCount === 1 ? '1 category review' : `${reviewCount} category reviews`;
      }
      return tier === 'brand' ? formatBrandReviewsText(reviewCount) : formatProductReviewsText(reviewCount);
    }
    if (rating != null && tier === 'category') return 'category-wide rating';
    if (rating != null && tier === 'brand')    return 'brand-wide rating';
    return null;
  };
  const buildOption = (tier, rating, reviewCount, quotes) => {
    const safeQuotes = Array.isArray(quotes) ? quotes : [];
    if (rating == null && reviewCount == null && !safeQuotes.length) return null;
    return {
      tier,                                    // 'product' | 'category' | 'brand'
      rating: rating != null ? Number(rating.toFixed(1)) : null,
      review_count: reviewCount ?? null,
      reviews_text: scopedNumbers(rating, reviewCount, tier),  // pre-scoped — use verbatim or paraphrase honestly, never as the product's own
      // WIDENED 2 → MAX_QUOTES_PER_TIER, and RANKED rather than sliced in
      // arrival order. Two quotes per tier could not ground three distinct
      // proof-led concepts, so the third had nothing new to say and fell back
      // to the shared tagline — one reason a round of three read as one slogan
      // repeated. `product.reviews` holds Immersive's top 10, so the pool was
      // always there; only the exposure was narrow.
      //
      // RANKING IS LOAD-BEARING, not tidiness. As of #157 the intake screen
      // deliberately STORES generic praise instead of discarding it ("in the
      // absence of any other social proof, generic praise is better than
      // nothing"), so `brandReviews.quotes` now carries lines it never used to.
      // Measured against the live scorer: "High quality, functional and
      // fashionable products." is 50 chars — it sails through the >30 length
      // filter these arrays already apply — and scores 0. Widening a
      // first-N slice would have handed the Director more filler, not more
      // material. Ranking puts the specific quotes first and lets the generic
      // ones fall off the end of the slice on their own.
      //
      // WHY scoreQuote AND NOT clearsQualityFloor, which is the obvious
      // candidate and is what the render-time rotation uses. Two reasons, and
      // the second is a hard constraint rather than a preference:
      //
      // (a) It is the wrong question. That predicate also requires the
      //     positive-praise lexicon screen, which wants an explicit praise
      //     token. Checked against the real function: "I wore these on a
      //     12-hour offshore trip and they dried in minutes" scores 4.5 and
      //     still returns FALSE, because its endorsement is implicit. That is
      //     precisely the concrete line an editorial or objection-resolved
      //     concept should write from. Rotation asks "would this win the
      //     primary slot"; the Director asks "what is the best material
      //     available" — different questions, different predicate.
      // (b) That lexicon screen was DELIBERATELY REMOVED from this file's
      //     decision path, and scripts/verifyQuoteGate.js pins its absence
      //     here (it survives only inside layoutInputService). Filtering with a
      //     predicate that calls it would put the lexicon back into the
      //     Director's decision path — the exact thing that harness exists to
      //     prevent. Ranking by score keeps the decision numeric.
      //
      // No hard score threshold: a brand whose entire pool is generic still
      // gets its best-of, which is the same call #157 made at intake.
      quotes: [...safeQuotes]
        .map(q => ({ q, score: scoreQuoteSafe(q.text) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_QUOTES_PER_TIER)
        .map(({ q }) => ({ text: snippetText(q.text, 200), author: q.author || null }))
        .filter(q => q.text)
    };
  };
  return [
    buildOption('product',  product?.rating,  product?.reviewCount,  product?.quotes),
    buildOption('category', category?.rating, category?.reviewCount, category?.quotes),
    buildOption('brand',    brand?.rating,     brand?.reviewCount,    brand?.quotes)
  ].filter(Boolean);
}

// ── Tunables ─────────────────────────────────────────────────────────

const MODEL_ID    = 'gpt-4.1';
const TEMPERATURE = 0.7;          // creative direction wants nuance, not wild variance
const N_CONCEPTS  = 4;            // four distinct concepts per call — gives pickConceptForCell a wider menu to spread across the cartesian (was 2; producing too-tight band)
const MAX_TOKENS  = 3500;         // bumped from 2000 — each concept ~300-400 tokens with rich rationale

// Bump when assembleSignals' output shape OR N_CONCEPTS changes —
// invalidates existing CreativeDirectionArtifact rows so the Director
// re-runs and emits the new count / shape. Mirrors aiCanvasSpec-
// Service.SPEC_SCHEMA_VERSION.
const DIRECTOR_SIGNALS_VERSION = '3.4.0';   // BUMPED 2026-08-12: aligned proof_options pool + quotes_by_stage (QUOTE_STAGE_AWARE).
// 3.3: PMax-only round brief adds FUNNEL SPREAD (one concept each of awareness /
// consideration / conversion via routing.funnel_stage) and SOCIAL-PROOF HIERARCHY
// (one dominant proof element; env-backed rating/count thresholds). Meta prompts
// stay byte-identical. Live path re-assembles every round so this is live without
// the bump; the bump is for the SHADOW directConcepts cache-hit gate.
// The predecessor comment held this at 3.1.0 on purpose and said to bump it at
// exactly the moment DIRECTOR_PROOF_MENU_ENABLED was flipped on. That flip is
// this commit (config/defaults.env DIRECTOR_PROOF_MENU_ENABLED=true), so the
// bump is now due: with the menu on, assembleSignals emits a different signal
// SHAPE (category_signal + social_proof_signal.proof_options), and the shadow
// path's cached artifacts are keyed on this constant.
// SCOPE CORRECTION (adversarial review caught this in an earlier draft of this
// very comment, which claimed the flip would be a "silent no-op" without the
// bump — that was WRONG and is worth stating plainly so nobody re-derives it):
// the LIVE path is `directConceptsRound`, and it has NO signalsVersion cache
// gate at all — it calls assembleSignals every round, so the proof menu goes
// live the moment the flag flips, bump or no bump. The ONLY cache-hit gate on
// this constant is at :262 inside the SHADOW/V1 `directConcepts` path. So the
// bump buys shadow-path correctness (stale artifacts built from the narrower
// shape stop being served as current), not live-path correctness.
// KNOWN, ACCEPTED, ONE-TIME COST — do not treat as a defect: this constant is
// the cache-hit key for the SHADOW telemetry path (directConcepts,
// "cached.signalsVersion === DIRECTOR_SIGNALS_VERSION"), and that shadow call is
// `await`ed on the LIVE campaign-expansion request path
// (campaignAdsGenerationService, runCreativeDirectorShadow inside
// expandWizardJob). So this bump forces one paid re-derive per unique
// (brand,product,campaignKind,creativeIntent,platformFormat) on its NEXT
// request. Bounded and self-healing. The LIVE path (directConceptsRound) is
// unaffected either way — it has no cache-hit gate on this constant at all.
// 3.2: DIRECTOR_PROOF_MENU_ENABLED flipped on, so category_signal +
// social_proof_signal.proof_options are now genuinely present in the signal;
// paired with real routing.creative_style selection criteria and a reserved
// proof-led concept slot in buildPromptRound (social-proof static ads had
// collapsed to 18 renders vs brand_led's 200+ over 2026-07-30..08-06).
// 3.1: brand_signal.description now reads brand.summary (was a permanently-null brand.description), has_logo reads logoUrl, dead badges key dropped; bumps cache so artifacts derived from the starved brief re-derive. Load-bearing: cache-hit test is cached.signalsVersion === DIRECTOR_SIGNALS_VERSION, so without the bump every product with an existing CreativeDirectionArtifact keeps serving concepts built from the starved brief and the fix looks like a no-op. 3.0: nest concept into { routing, copy, art_direction, reasoning } so private rationale cannot fall through into image prompts as art direction (2026-08-01 leak). art_direction is OPTIONAL visual prose only; copy.* are the only letterforms; reasoning.rationale is private. Bumps cache so existing flat v2 artifacts re-derive. 2.4: platform-format-aware (Phase 3). 2.3: PMA-based matchedMediaIds + brand-review fallback. 2.2: file_type_distribution. 2.1: N_CONCEPTS 2 → 4. 2.0: full data projection.

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

async function assembleSignals({ brandId, productId, campaignKind, seededUniverse } = {}) {
  const [brand, product] = await Promise.all([
    Brand.findById(brandId).lean(),
    productId ? CatalogProduct.findById(productId).lean() : null
  ]);

  // CATEGORY tier — cache-only read, no live fetch. `categoryReviewsService`
  // is the writer (Gemini grounded search, same pattern as brandReviews); this
  // reads whatever it already cached on the Category doc, exactly as
  // layoutInputService does for the video path's tier-2 cascade
  // (Category.findById(categoryRef).select('categoryReviews').lean()).
  // Fetching category is deferred to AFTER the Promise.all above because it
  // needs product.categoryRef, which only exists once `product` resolves.
  // assembleSignals runs on EVERY live directConceptsRound call (no cache
  // gate) — a live Gemini call from inside this function would be a new,
  // unbounded billable path fired on every ad generation. This must stay a
  // read of an existing field, never a trigger for categoryReviewsService's
  // own fetchAndCache.
  const category = (directorProofMenuEnabled() && product?.categoryRef)
    ? await Category.findById(product.categoryRef).select('categoryReviews breadcrumb name').lean()
    : null;

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
    // Brand field is `summary` ("2-4 sentence verbose brand description"); brand.description
    // does not exist on brandSchema (it is demographicSchema's field). Reading brand.description
    // left brand_signal.description permanently null while the round prompt asked the model to
    // pull from it — JSON key stays `description` so prompt refs brand_signal.description hold.
    description: snippetText(brand?.summary, 280),
    tone:        Array.isArray(brand?.tone) ? brand.tone.slice(0, 6) : [],
    brand_reviews_summary: snippetText(brand?.brandReviews?.summary, 240),
    has_logo:    !!brand?.logoUrl  // field is logoUrl; brand.logo never existed → permanently false
  };

  // ── Product signal ──
  const productSignal = {
    name:           product?.title       || null,
    category:       product?.category    || null,
    description:    snippetText(product?.description, 280),
    price:          product?.price ?? null,
    currency:       product?.currency    || null,
    availability:   product?.availability || null,
    // shortBenefits is not on CatalogProduct schema (always sent []); benefits would have to come from the layout derivation artifact instead.
    review_summary: snippetText(product?.reviewSummary?.summary || product?.productReviews?.summary, 240),
    // REAL PRODUCT FACTS — fabric, fit, construction, care, dimensions.
    // `product` is loaded with a bare findById().lean() (no projection), so
    // `specs` was already in memory on every Director call and simply never
    // forwarded. This is the concrete material an editorial or brand-led
    // concept needs in order to say something specific instead of falling
    // through to the brand tagline. Empty array when absent — never null, so
    // the prompt can test `.length` without a null guard.
    specs: normalizeProductSpecs(product?.specs),
    priority:       !productId ? 'absent' :
                    campaignKind === 'product' ? 'high' :
                    campaignKind === 'brand'   ? 'medium' :
                    'medium'
  };

  // ── Category signal — new tier, previously absent from the Director brief
  // entirely. Only key that ever gets omitted outright (not just null-valued)
  // when the flag is off, so a byte-identity check against the pre-change
  // shape can assert the key's absence, not merely null fields.
  const categorySignal = directorProofMenuEnabled()
    ? {
        breadcrumb: category?.breadcrumb || category?.name || null,
        summary:    snippetText(category?.categoryReviews?.summary, 240)
      }
    : null;

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
  // RATING_PAIR_ATOMIC (default off): productReviews {rating, reviewCount}
  // as one pair, never immersive product.rating + store reviewCount.
  // Flag-off is the two expressions this replaced, verbatim.
  const productRatingPair = resolveDirectorProductRatingPair(product);
  const productRatingValue = productRatingPair.rating;
  const productRatingCount = productRatingPair.reviewCount;
  const productReviewQuotes = productQuotesForDirector(product);

  // Brand-level — only consulted to fill in what product-level missed.
  // brandReviews.quotes is the llm-web pool (geminiSearchProvider.stampLlmQuotes
  // with scope:'brand'). Route every row through toPrintableCustomerQuote so
  // the Director never sees a site-as-author byline it can echo into
  // copy.headline / subheadline — fields that ship without reaching a render
  // gate. Product path below reads Immersive product.reviews and is unchanged.
  const brandReviewQuotes = (Array.isArray(brand?.brandReviews?.quotes) ? brand.brandReviews.quotes : [])
    .map(brandQuoteForDirectorSignal)
    .filter(q => q && typeof q.text === 'string' && q.text.trim().length > 30);
  const brandRatingValue = typeof brand?.brandReviews?.rating === 'number' && brand.brandReviews.rating > 0
    ? brand.brandReviews.rating : null;
  const brandRatingCount = brand?.brandReviews?.reviewCount || null;
  const brandReviewSource = brand?.brandReviews?.source || null;

  // CATEGORY tier — same quote-sanitization mapper as brand (both are the
  // llm-web pool, same shape). Never read when the menu is off; `category` is
  // already null in that case so this collapses to empty arrays / nulls.
  const categoryReviewQuotes = (Array.isArray(category?.categoryReviews?.quotes) ? category.categoryReviews.quotes : [])
    .map(brandQuoteForDirectorSignal)
    .filter(q => q && typeof q.text === 'string' && q.text.trim().length > 30);
  const categoryRatingValue = typeof category?.categoryReviews?.rating === 'number' && category.categoryReviews.rating > 0
    ? category.categoryReviews.rating : null;
  const categoryRatingCount = category?.categoryReviews?.reviewCount || null;

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
  // QUOTE_PROVENANCE_STRICT is media-driven only. Product-attached keeps
  // the brand pool (identity) so last-resort / proof_options brand
  // quotes stay. Media-driven noun-checks against THIS seed — not the
  // brand PMA union of 10, which would let a jacket anywhere in those
  // rows unblock every jacket quote. Flag-off is an identity.
  let quoteScopeMedia = [];
  if (!isProductScoped && quoteProvenanceStrictEnabled()) {
    const seedIds = (Array.isArray(seededUniverse) ? seededUniverse : [])
      .map((e) => e && (e.mediaId || e._id))
      .filter(Boolean);
    if (seedIds.length) {
      try {
        quoteScopeMedia = await loadQuoteScopeMediaByIds(seedIds);
      } catch { quoteScopeMedia = []; }
    }
  }
  const brandQuoteScope = {
    productAttached: isProductScoped,
    productTitle: product?.title || null,
    media: quoteScopeMedia
  };
  // Apply the same scoped filter to every quotes array the Director
  // prompt can echo into copy.headline (primary_quote + proof_options
  // tiers). Do NOT touch brand_reviews_summary / review_summary prose.
  const scopedBrandQuotes = selectBrandQuotesForScope(brandReviewQuotes, brandQuoteScope);
  const scopedCategoryQuotes = selectBrandQuotesForScope(categoryReviewQuotes, brandQuoteScope);
  const scopedProductQuotes = selectBrandQuotesForScope(productReviewQuotes, brandQuoteScope);
  // Flag-off: scopedProductQuotes[0] === product.reviews[0] after the
  // arrival-order map + noun-scope filter (today). Flag-on: BOTH
  // primary_quote AND proof_options.product.quotes come from
  // prepareQuotePool(product.productReviews) — same stamp / printable /
  // star gates. assembleSignals has no per-concept stage (stage is a
  // Director OUTPUT); primary_quote is the unstaged strongest.
  // quotes_by_stage (flag-on only) is how stage reaches
  // pickDirectorPrimaryQuote at signal time.
  let primaryFromBrand = false;
  let primaryQuoteObj;
  if (directorQuotePoolAlignedEnabled()) {
    const aligned = pickDirectorPrimaryQuote(product, {});
    if (aligned) {
      primaryQuoteObj = aligned;
    } else if (!isProductScoped && scopedBrandQuotes[0]) {
      primaryQuoteObj = scopedBrandQuotes[0];
      primaryFromBrand = true;
    } else {
      primaryQuoteObj = null;
    }
  } else {
    primaryQuoteObj = scopedProductQuotes[0]
      || (isProductScoped ? null : scopedBrandQuotes[0])
      || null;
    primaryFromBrand = !!(primaryQuoteObj && !productReviewQuotes.length);
  }
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
  const primaryQuoteSource = (directorQuotePoolAlignedEnabled()
    ? primaryFromBrand
    : (!productReviewQuotes.length && primaryQuoteObj))
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
    proof_density:    scopedProductQuotes.length + (isProductScoped ? 0 : scopedBrandQuotes.length) + topComments.length
  };
  // QUOTE_STAGE_AWARE: per-stage winners from the SAME gated pool as
  // primary_quote. assembleSignals runs before concepts exist, so a
  // single primary cannot be staged; this is how the model sees the
  // staged picks. Flag-off: field absent (signal byte-identical).
  if (String(process.env.QUOTE_STAGE_AWARE || 'false').toLowerCase() === 'true'
      && directorQuotePoolAlignedEnabled()) {
    const byStage = {};
    for (const s of PMAX_FUNNEL_STAGES) {
      const p = pickDirectorPrimaryQuote(product, { funnelStage: s });
      byStage[s] = p
        ? { text: snippetText(p.text, 200), author: p.author || null }
        : null;
    }
    socialProofSignal.quotes_by_stage = byStage;
  }

  // ── PROOF MENU — behind DIRECTOR_PROOF_MENU_ENABLED, additive only. ──
  //
  // Every field above this point is UNCHANGED, including the
  // isProductScoped withholding of brand quotes from `primary_quote` /
  // `rating` / `strongest_signal`. Those stay the single deterministic
  // pick they have always been, for the fields nothing downstream can
  // double-check.
  //
  // `proof_options` is deliberately WIDER: it surfaces category and brand
  // tiers to the Director even on a product-scoped run — that is the
  // entire point (per owner request: "the director may want different
  // proof points at different times"). The reason this is safe where the
  // existing withholding rule says it should not be: every option carrying a
  // number ships with its own SCOPED disclosure string via
  // buildDirectorProofOptions (both the review-COUNT and, separately, a bare
  // RATING with no count — two independent adversarial passes each caught one
  // half of this and both are now closed; see that function's docstring for
  // the full history). The Director is a copy-writing LLM, not a template, so
  // enforcement is instruction-level, not mechanical — the prompt below
  // states explicitly that any option's number must be described using its
  // own tier, never as if it belonged to the product. A THIRD adversarial
  // pass specifically disputed an earlier version of this comment's claim
  // that this is "the same trust boundary as brand_signal.tagline /
  // description" — correctly: a tagline is unfalsifiable prose, while a cited
  // "41,000 reviews" is a checkable claim, so the stakes are not equal.
  // What DOES make the comparison fair now is that, unlike tagline/
  // description, every numeric proof_options entry ships with an accurate,
  // ready-to-quote disclosure phrase — the model has to actively discard
  // correct scoping to get this wrong, not merely fail to reconstruct it.
  // That is a real mitigant, not a full mechanical guarantee; a hard
  // reject-on-mismatch check (parse copy for a proof_options number without
  // its scope word) was considered and deliberately deferred as separate,
  // larger scope than this fix.
  //
  // NEITHER `proof_options` NOR `routing.proof_pick` (the concept-level
  // field it feeds) changes which rating or quote is actually BURNED into
  // an ad's dedicated proof slots — that stays governed, unconditionally,
  // by resolveCoherentSocialProof at render time (brandScriptExecutor /
  // directImageRenderService). This menu only tells us what INFORMED the
  // Director's free-text copy, for consistency and audit.
  if (directorProofMenuEnabled()) {
    socialProofSignal.proof_options = buildDirectorProofOptions({
      product:  { rating: productRatingValue,  reviewCount: productRatingCount,  quotes: scopedProductQuotes },
      category: { rating: categoryRatingValue, reviewCount: categoryRatingCount, quotes: scopedCategoryQuotes },
      // Flag-off: scoped*Quotes are the same arrays as the unscoped pools.
      brand:    { rating: brandRatingValue,     reviewCount: brandRatingCount,    quotes: scopedBrandQuotes }
    });
  }

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
    // categorySignal is only ever non-null when the flag is on — omitted here
    // via the spread so the key itself is ABSENT with the flag off, not merely
    // null-valued, so a byte-identity check can assert its absence.
    ...(categorySignal ? { category_signal: categorySignal } : {}),
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
// ── Product specs → Director brief ──────────────────────────────────────
//
// `CatalogProduct.specs` is Immersive's `product_results.specifications`. It is
// populated for a large share of the catalog and, until now, reached NOTHING in
// the ad pipeline — only the retired canvas path ever read it. That is why
// "editorial" and "brand-led" concepts had nothing concrete to write about and
// fell back to the brand tagline: the one field holding real product facts was
// never in the brief.
//
// SHAPE IS UNTRUSTED. The field is `Mixed`, and Immersive returns it
// inconsistently — sometimes an object of label→value, sometimes an array of
// {name,value} / {label,value} / {key,value} rows, sometimes an array of bare
// strings, sometimes nested one level under a group heading. Normalise all of
// those to a flat [{label, value}] and drop anything that does not survive,
// rather than letting a shape surprise reach the prompt as "[object Object]".
//
// Caps are deliberate: this rides in every Director call, so it is bounded to
// MAX_SPEC_ROWS rows at MAX_SPEC_VALUE chars. Specs are a grounding aid, not a
// datasheet — the model needs a few concrete, quotable facts, not all of them.
const MAX_SPEC_ROWS = 8;
const MAX_SPEC_LABEL = 40;
const MAX_SPEC_VALUE = 90;

function normalizeProductSpecs(raw) {
  const rows = [];
  const pushRow = (label, value) => {
    if (rows.length >= MAX_SPEC_ROWS) return;
    // A value that is itself an object/array is a nesting level we do not
    // understand — skip rather than stringify it into noise.
    if (value != null && typeof value === 'object') return;
    // Same rule for the LABEL, which was the asymmetry: the value was guarded
    // and the label was not, so a localised label — `{ label: { en: 'Material' },
    // value: 'Cotton' }`, a real Immersive shape — reached the brief as
    // "[object Object]: Cotton". A label we cannot read is better dropped than
    // shown: the value alone is still usable copy material.
    const labelIsUnusable = label != null && typeof label === 'object';
    const v = snippetText(value == null ? null : String(value), MAX_SPEC_VALUE);
    if (!v) return;
    const l = labelIsUnusable
      ? null
      : snippetText(label == null ? null : String(label), MAX_SPEC_LABEL);
    // A bare string spec (no label) is still useful — keep it label-less.
    rows.push(l ? { label: l, value: v } : { label: null, value: v });
  };

  const consume = (node, depth) => {
    if (node == null || rows.length >= MAX_SPEC_ROWS) return;
    if (Array.isArray(node)) {
      for (const item of node) {
        if (rows.length >= MAX_SPEC_ROWS) return;
        if (item == null) continue;
        if (typeof item === 'string' || typeof item === 'number') { pushRow(null, item); continue; }
        if (typeof item === 'object') {
          const label = item.label ?? item.name ?? item.key ?? item.title ?? null;
          const value = item.value ?? item.text ?? item.detail ?? null;
          if (label != null || value != null) { pushRow(label, value); continue; }
          // A row that is itself a group — descend once, not forever.
          if (depth < 2) consume(item, depth + 1);
        }
      }
      return;
    }
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (rows.length >= MAX_SPEC_ROWS) return;
        if (v != null && typeof v === 'object') {
          if (depth < 2) consume(v, depth + 1);   // grouped specs
          continue;
        }
        pushRow(k, v);
      }
      return;
    }
    if (typeof node === 'string' || typeof node === 'number') pushRow(null, node);
  };

  consume(raw, 0);
  return rows;
}

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
  ].join('\n'),
  // Phase A live PMax video surfaces — scaffolded from pmax_16_9. Richer
  // per-surface creative direction is Phase B; these keep reserved-chrome
  // surfaces out of the "no weighting → square Feed defaults" hole.
  pmax_video_16_9: [
    `  ARCHETYPE WEIGHTING:`,
    `    PREFER  magazine_editorial (clean editorial spread reads as commercial/professional on landscape)`,
    `    PREFER  typographic_dominant (landscape gives headlines room to breathe — works well as a YouTube pre-roll)`,
    `    DEPRIORITIZE hero_quote_overlay (creator-quote energy reads as "Instagram ad" on YouTube/Display)`,
    `    AVOID        product_card_grid (multi-card layouts get clipped on small Display banner placements)`
  ].join('\n'),
  pmax_video_1_1: [
    `  ARCHETYPE WEIGHTING:`,
    `    PREFER  magazine_editorial (clean editorial reads commercial on square Discovery / PMax placements)`,
    `    PREFER  typographic_dominant (square gives headlines room without vertical chrome pressure)`,
    `    DEPRIORITIZE hero_quote_overlay (creator-quote energy reads as "Instagram ad" on Google surfaces)`,
    `    AVOID        product_card_grid (multi-card layouts get cramped on 1:1 with reserved bands)`
  ].join('\n'),
  pmax_video_9_16: [
    `  ARCHETYPE WEIGHTING:`,
    `    PREFER  full_bleed_hero_bottom_panel (panel lands in the safe middle band, not Shorts chrome)`,
    `    PREFER  magazine_editorial (clean commercial read on YouTube Shorts / PMax vertical)`,
    `    DEPRIORITIZE hero_quote_overlay (creator-quote energy fights Shorts UI chrome)`,
    `    AVOID        product_card_grid (multi-card layouts feel cramped on tall vertical)`
  ].join('\n'),
  // Phase A live PMax STATIC surfaces. The 1.91:1 landscape is a short, wide
  // banner-like canvas where dense multi-element layouts fail; square and 4:5
  // have more room. Modeled on the existing pmax_* entries — do not change Meta.
  pmax_landscape_1_91_1: [
    `  ARCHETYPE WEIGHTING:`,
    `    PREFER  typographic_dominant (1.91:1 is a SHORT, WIDE banner-like canvas — bold headline + one product beat is all that fits)`,
    `    PREFER  magazine_editorial (clean commercial spread; landscape Display placements reward restraint)`,
    `    DEPRIORITIZE hero_quote_overlay (quote cards need vertical room this canvas does not have)`,
    `    AVOID        product_card_grid (dense multi-element / multi-card layouts fail on a short wide banner)`,
    `    AVOID        full_bleed_hero_bottom_panel (bottom panel + reserved chrome leaves almost no content height on a short canvas)`
  ].join('\n'),
  pmax_square_1_1: [
    `  ARCHETYPE WEIGHTING:`,
    `    PREFER  magazine_editorial (clean editorial reads commercial on square Discovery / PMax placements)`,
    `    PREFER  typographic_dominant (square gives headlines room without vertical chrome pressure)`,
    `    PREFER  full_bleed_hero_bottom_panel (square has enough height for a panel without crowding)`,
    `    DEPRIORITIZE hero_quote_overlay (creator-quote energy reads as "Instagram ad" on Google surfaces)`,
    `    AVOID        product_card_grid (multi-card layouts get cramped on 1:1 with reserved bands)`
  ].join('\n'),
  pmax_portrait_4_5: [
    `  ARCHETYPE WEIGHTING:`,
    `    PREFER  full_bleed_hero_bottom_panel (4:5 has room for a panel without Meta-style chrome pressure)`,
    `    PREFER  magazine_editorial (clean commercial read on portrait PMax placements)`,
    `    PREFER  typographic_dominant (portrait height gives type room to breathe)`,
    `    DEPRIORITIZE hero_quote_overlay (creator-quote energy reads as "Instagram ad" on Google surfaces)`,
    `    AVOID        product_card_grid (multi-card layouts still feel busy on portrait Display)`
  ].join('\n')
};

// ── PMax-only round brief (gated on platformFormat) ──────────────────
//
// Google PMax delivers ALL creative for a product into ONE asset group and
// picks per impression by viewer intent — so the asset SET must SPAN the
// funnel and concepts must be meaningfully different (not cosmetic variants).
// Meta rounds must stay completely unaffected: every helper below is gated
// on isPmaxPlatformFormat and never spliced into a Meta prompt or schema.
// Thresholds are env-backed and INTERPOLATED into the prompt so the prose
// and config/defaults.env can never disagree.

const PMAX_FUNNEL_STAGES = Object.freeze(['awareness', 'consideration', 'conversion']);

function isPmaxPlatformFormat(platformFormat) {
  return typeof platformFormat === 'string' && platformFormat.startsWith('pmax_');
}

// PMAX_SPLIT_VIDEO — Stage 1 kill switch (default OFF) for the split-stage
// 16:9 PMax video unit: product anchored to one side of frame, the OTHER
// side generatively extended to carry copy (side geometry lives in the pure
// services/pmaxSplitStrategy.js, not here). Stage 1 only adds the
// Director's routing.panelTreatment field to the PMax-VIDEO prompt/schema —
// gating that addition on this flag means every existing PMax video round's
// prompt + schema text stay BYTE-IDENTICAL until the flag is deliberately
// flipped on, the same "ship dark, cost nothing by default" posture
// DIRECTOR_PROOF_MENU_ENABLED already established above for the proof menu.
function pmaxSplitVideoEnabled() {
  return String(process.env.PMAX_SPLIT_VIDEO ?? 'false').toLowerCase() === 'true';
}

// scene_extend — the seed is a real environment worth continuing sideways.
// brand_panel  — the seed is a clean studio backdrop with no scene to
//                continue, so a solid brand-colour panel reads more premium
//                than an invented continuation of nothing.
// Legibility of the copy is deliberately NOT part of this decision: the
// renderer places and sizes text on the panel deterministically regardless
// of which treatment wins, so asking the Director to weigh it would only
// be asking it to guess at layout math it cannot see and does not control.
const PANEL_TREATMENT_VALUES = Object.freeze(['scene_extend', 'brand_panel']);

/**
 * Director's panelTreatment choice for the PMax split-stage video panel, or
 * null. Dual-reads via conceptField (routing.panelTreatment first, flat
 * fallback) so a Director round recorded BEFORE this field existed — every
 * round before this stage shipped, and every Meta/non-video round, which
 * never asks for it (see isPmaxSplitVideo in buildResponseSchemaRound) —
 * degrades to null instead of surfacing an undefined/garbage value.
 *
 * @param {object|null|undefined} concept
 * @returns {'scene_extend'|'brand_panel'|null}
 */
function panelTreatmentFromConcept(concept) {
  const v = conceptField(concept, 'panelTreatment');
  return PANEL_TREATMENT_VALUES.includes(v) ? v : null;
}

/**
 * Read a numeric threshold from the environment, falling back to the default
 * when it is unset, blank, or unparseable.
 *
 * ⚠️ `Number('')` and `Number('   ')` are **0**, not NaN — so a plain
 * `Number.isFinite` guard treats a var that is present-but-empty (exactly what
 * an operator leaves behind after clearing a value in the Render dashboard, and
 * what `FOO=` in an env file produces) as a deliberate **zero**. That would put
 * "strong rating ≥ 0" and "substantial count ≥ 0" into the prompt, which
 * inverts the entire hierarchy: every SKU would qualify as RATING-FIRST and the
 * weak-count suppression rule could never fire.
 */
function pmaxProofThreshold(varName, fallback) {
  const raw = process.env[varName];
  if (typeof raw !== 'string' || raw.trim() === '') return fallback;
  const n = Number(raw.trim());
  // Negative is as meaningless as blank here — both mean "misconfigured".
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Strong-rating floor for RATING-FIRST / popularity-framing (default 4.5). */
function pmaxProofStrongRating() {
  return pmaxProofThreshold('PMAX_PROOF_STRONG_RATING', 4.5);
}

/** Minimum review count treated as "substantial" (default 100). */
function pmaxProofMinReviewCount() {
  return pmaxProofThreshold('PMAX_PROOF_MIN_REVIEW_COUNT', 100);
}

function buildPmaxFunnelSpreadBlock() {
  return [
    `PMAX FUNNEL SPREAD (absolute for this Google Performance Max round):`,
    `Google delivers ALL creative for a product into ONE asset group and picks per impression using the viewer's intent signals. Do NOT treat every concept as the same funnel stage — the asset SET must SPAN the funnel. Your ${N_CONCEPTS_ROUND} concepts MUST cover one of each:`,
    `  awareness     — brand story / lifestyle context / emotional hook; no hard sell; no offer language. Set routing.funnel_stage="awareness".`,
    `  consideration — benefit + proof (reviews, ratings, differentiators, objection handling). Set routing.funnel_stage="consideration".`,
    `  conversion    — offer / urgency / explicit action; product hero and clean. Set routing.funnel_stage="conversion".`,
    `Each concept MUST declare routing.funnel_stage as one of ${PMAX_FUNNEL_STAGES.join('|')}. Across the round, the three stages must each appear exactly once so Google has distinct approaches to test — not cosmetic variations of one ad.`
  ].join('\n');
}

// PMax split-stage 16:9 video only (isPmaxSplitVideo — narrower than the
// isPmax gate above, which also covers PMax IMAGE formats where there is no
// panel to choose a treatment for). Spliced only when PMAX_SPLIT_VIDEO is on
// AND the destination is a pmax_video_* key, same double-gate as the schema
// property below, so this contributes zero characters everywhere else.
function buildPmaxPanelTreatmentBlock() {
  return [
    `PMAX SPLIT-STAGE VIDEO PANEL (this destination anchors the product to one side of a 16:9 frame and generatively extends the OTHER side to carry copy):`,
    `Set routing.panelTreatment to the ONE treatment that fits the seed imagery:`,
    `  scene_extend — the seed is a rich/lifestyle scene (real environment, props, depth) that could plausibly continue sideways without inventing an implausible new setting.`,
    `  brand_panel  — the product sits on a clean flat studio backdrop (seamless paper, plain colour, no environment) with no real scene to extend — a solid brand-colour panel reads more premium than an invented continuation.`,
    `Do NOT weigh legibility when choosing — the renderer places and sizes the panel's copy deterministically regardless of which treatment you pick; your only job is judging which treatment fits what the seed actually shows.`
  ].join('\n');
}

function buildPmaxSocialProofHierarchyBlock() {
  // Interpolate env-backed thresholds — never hardcode the same numbers as
  // prose literals, or the prompt and config/defaults.env can drift apart.
  const strongRating = pmaxProofStrongRating();
  const minCount = pmaxProofMinReviewCount();
  return [
    `PMAX SOCIAL-PROOF HIERARCHY (owner creative guidelines — absolute for this round):`,
    // PRECEDENCE SENTENCE — load-bearing, do not drop. The shared DR block
    // earlier in this prompt states a different review-count threshold
    // ("≥4.5 from ≥50") for when a rating is credible to cite. That text is
    // Meta-tuned and stays untouched, so on a PMax round the model sees two
    // numbers for a similar-looking decision. Naming which one wins removes
    // the ambiguity without editing the shared text (which would change the
    // Meta prompt and break its byte-identity guarantee).
    `Where this hierarchy and any earlier proof guidance in this prompt disagree — including review-count thresholds — THIS block wins for this destination.`,
    `One dominant social-proof element per creative. Supporting proof may appear but must stay visually secondary. Never give quote, rating, review count, price, product name and CTA equal weight.`,
    ``,
    `Per-SKU decision logic — apply using social_proof_signal values already in the brief:`,
    `  - Strong rating (≥${strongRating}) AND substantial review count (≥${minCount}) → RATING-FIRST: the star rating dominant, review count supporting, NO quote.`,
    `  - A short, specific, compelling customer quote → TESTIMONIAL-FIRST: quote is the hero; stars optional and SMALL; usually no count.`,
    `  - Both strong AND a large canvas (1:1 or 4:5) → COMBINATION allowed, but one must still dominate.`,
    `  - Weak review volume (count missing or <${minCount}) → do NOT print the count at all (a small number reads as a negative). Use the rating alone, or a quote.`,
    `  - Rating below ${strongRating} with high volume (≥${minCount}) → prefer POPULARITY framing over the numeric rating (e.g. "Loved by thousands", "18,000+ reviews").`,
    `  - Strong product photography / premium positioning → PRODUCT-FIRST: minimal or no social proof at all. This is a legitimate concept, not a failure.`,
    ``,
    `Concept diversity on the PROOF AXIS: across the round's ${N_CONCEPTS_ROUND} concepts, the DOMINANT proof element must differ — do not return three concepts that all lead with the rating. The proof axis (rating / testimonial / product-hero / offer) is a primary axis of variation, alongside the funnel stage.`
  ].join('\n');
}

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
    ...(directorProofMenuEnabled() ? [
      `- PROOF MENU: social_proof_signal.proof_options[] lists every available proof point across product / category / brand tiers, each with its own pre-scoped "reviews_text" disclosure. Use it to find a stronger angle than primary_quote alone. If you write copy from a category or brand option, use that option's own scoping in your words (e.g. "loved across our whole line" / "brand-wide") — NEVER phrase a category or brand number as if it belonged to this specific product. This menu does NOT change which number or quote the ad actually renders in its dedicated proof slots — that is decided separately and always truthfully; it only tells us which signal informed your copy.`
    ] : []),
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
  // (archetype, emotional_hook, social_proof_type). Dual-read via
  // conceptField so nested v3 routing is not invisible to this soft check.
  if (concepts.length >= 2) {
    const fingerprints = concepts.map(c =>
      `${conceptField(c, 'archetype')}|${conceptField(c, 'emotional_hook')}|${conceptField(c, 'social_proof_type')}`
    );
    if (new Set(fingerprints).size < concepts.length) {
      warnings.push(`concepts are not distinct — fingerprints: ${fingerprints.join(' / ')}`);
    }
  }

  // Validate recommended component styles against the vocabulary.
  for (const c of concepts) {
    const rec = conceptField(c, 'recommended_components');
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
    for (const [role, style] of Object.entries(rec)) {
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

/**
 * Minimal JSON-Schema-subset checker: type, required, enum, minItems/maxItems,
 * nested objects and arrays. Enough to re-assert exactly what the round contract
 * declares, and no more.
 *
 * Deliberately validates AGAINST the schema object rather than a hand-copied field
 * list. Atlas rejects strict json_schema for Anthropic models, so the schema can no
 * longer be enforced at the transport layer — but it is still the contract, and a
 * hand-maintained duplicate would drift from it the first time someone edits the
 * schema. This way editing the schema updates the validation for free.
 */
function schemaErrors(value, schema, at = '') {
  const out = [];
  if (!schema || typeof schema !== 'object') return out;
  const types = Array.isArray(schema.type) ? schema.type : (schema.type ? [schema.type] : []);
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;

  if (types.length && !types.includes(actual)) {
    // integers arrive as 'number'
    if (!(types.includes('integer') && Number.isInteger(value))) {
      out.push(`${at || 'value'} must be ${types.join(' or ')}, got ${actual}`);
      return out;   // wrong type — deeper checks would be noise
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    out.push(`${at || 'value'} must be one of [${schema.enum.join(', ')}], got ${JSON.stringify(value)}`);
  }
  if (actual === 'object') {
    for (const key of schema.required || []) {
      if (key in value) continue;
      /**
       * A missing key whose schema permits null is NOT an error.
       *
       * recommended_components requires all 8 role keys, but every value is
       * type:['string','null'] — so the contract only ever wanted the SHAPE, and a
       * concept with no badge is meant to write `badge: null`. Writing nothing at
       * all means exactly the same thing.
       *
       * Under strict json_schema OpenAI emitted the explicit nulls, so the
       * distinction never surfaced. Treating absence as a hard failure once that
       * guarantee was gone would reject a payload that is semantically correct, and
       * would fail EVERY round over a formatting nicety. Absence is normalised to
       * null instead.
       */
      const sub = (schema.properties || {})[key];
      const subTypes = sub && (Array.isArray(sub.type) ? sub.type : [sub.type]);
      if (subTypes && subTypes.includes('null')) { value[key] = null; continue; }
      out.push(`${at ? at + '.' : ''}${key} is missing`);
    }
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (key in value) out.push(...schemaErrors(value[key], sub, `${at ? at + '.' : ''}${key}`));
    }
  }
  if (actual === 'array') {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
      out.push(`${at} must have at least ${schema.minItems} item(s), got ${value.length}`);
    }
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) {
      out.push(`${at} must have at most ${schema.maxItems} item(s), got ${value.length}`);
    }
    if (schema.items) value.forEach((v, i) => out.push(...schemaErrors(v, schema.items, `${at}[${i}]`)));
  }
  return out;
}

/**
 * Everything the transport used to guarantee, plus the semantic rules a schema
 * cannot express. Returns [] when usable, else reasons that are handed back to the
 * model verbatim on a single re-ask.
 *
 * SEMANTIC RULES, and why each exists:
 *  - duplicate primary line: the chosen model reused one headline across two of
 *    three concepts in the bake-off. Different intents, identical primary line, so
 *    two of three were not distinct ads to a viewer.
 *  - forbidden strings / pricing: checked ONLY against copy_picks values, i.e. text
 *    that actually reaches the image. Scanning the whole concept blob would reject
 *    a rationale that merely discusses the product name or mentions a discount
 *    strategy, and a false reject costs a full re-ask on ~30k vision tokens.
 */
function validateDirectorPayload(parsed, { schema = null, nConcepts = 3, forbiddenStrings = [] } = {}) {
  const reasons = [];

  if (schema) reasons.push(...schemaErrors(parsed, schema.schema || schema, ''));

  const concepts = parsed?.concepts;
  if (!Array.isArray(concepts)) {
    if (!reasons.length) reasons.push('"concepts" must be an array');
    return reasons;
  }
  if (concepts.length !== nConcepts) {
    reasons.push(`"concepts" must contain exactly ${nConcepts} items, got ${concepts.length}`);
  }

  // Only strings that end up rendered count as ad copy. Dual-read v3 `copy`
  // and legacy v2 `copy_picks` so a mixed batch during the nest migration is
  // still scanned for product-name / pricing leaks.
  const copyOf = (c) => Object.values(c?.copy || c?.copy_picks || {}).filter(v => typeof v === 'string');
  // A one- or two-character product name would match almost any copy; substring
  // matching is only meaningful for a reasonably distinctive name.
  const checkable = forbiddenStrings.filter(s => String(s).trim().length >= 4);

  const primaries = [];
  concepts.forEach((c, i) => {
    if (!c || typeof c !== 'object') { reasons.push(`concepts[${i}] is not an object`); return; }

    // copy.headline (v3) / copy_picks.headline (v2) is the contract field; older
    // flat shapes kept so a contract change does not silently disable the
    // duplicate check.
    // A NULL HEADLINE IS A COLLIDING HEADLINE, and missing that is why this
    // guard never caught the reported bug.
    //
    // The check below compares populated lines against each other. A null was
    // simply not pushed, so it could never collide with anything — and a round
    // of three nulls passed clean. But null does not mean "no line": every
    // nulled headline cascades downstream to the SAME string
    // (directImageRenderService buildIntentData → layoutInput.copy.headline →
    // brand.tagline; metaCascadeConfig.headline does the same for video). So
    // three nulls render as one slogan three times — exactly the "same slogan in
    // 3 different intent profiles" the owner rejected — while this validator
    // reported the round as distinct.
    //
    // Nulls are therefore folded in under a sentinel. They collide with each
    // other (two nulls = two ads with the identical fallback line) but never
    // with a real headline, since no genuine line can equal the sentinel. One
    // null is still allowed: it is a legitimate last resort for a single
    // concept, and only becomes a repeat when a second concept does the same.
    const primary = c.copy?.headline ?? c.copy_picks?.headline ?? c.headline ?? c.primary_line ?? null;
    const primaryText = primary == null ? '' : String(primary).trim();
    primaries.push(primaryText ? primaryText.toLowerCase() : NULL_HEADLINE_SENTINEL);

    const copy = copyOf(c).join('  ');
    for (const bad of checkable) {
      if (copy.toLowerCase().includes(String(bad).toLowerCase())) {
        reasons.push(`concepts[${i}].copy contains the product name "${bad}", which must not appear in ad copy`);
      }
    }
    if (/(\$\s?\d|[£€]\s?\d|\b\d+% ?off\b|\bdiscount\b|\bsavings?\b|\bsale\b)/i.test(copy)) {
      reasons.push(`concepts[${i}].copy contains pricing or discount language, which is switched off system-wide`);
    }
  });

  const dupes = primaries.filter((p, i) => primaries.indexOf(p) !== i);
  if (dupes.length) {
    // Two different failures, so say which one it is — "share the same primary
    // line (null)" would read as a bug in the validator rather than a real
    // finding, and the re-ask needs to know that the fix is to WRITE a
    // headline, not to change one.
    reasons.push(dupes[0] === NULL_HEADLINE_SENTINEL
      ? `${dupes.length + 1} concepts left copy.headline null. A nulled headline is not "no line" — every one of them ` +
        `falls back to the SAME brand tagline at render time, so the ads ship as one slogan repeated. ` +
        `Write a distinct grounded headline for each: use a different review quote, or a product spec.`
      : `two concepts share the same primary line (${JSON.stringify(dupes[0])}). ` +
        `Each concept must lead with a DIFFERENT headline — reusing one makes the concepts identical to a viewer.`
    );
  }
  return reasons;
}

const N_CONCEPTS_ROUND       = 3;
const ROUND_VERSION          = '3.1.0';   // 3.1: routing.proof_pick (optional, nullable) added to the schema,
// plus the proof_options[] menu explanation added to the prompt, both behind
// DIRECTOR_PROOF_MENU_ENABLED. NOT a cache key today — no code path compares
// this against a stored value before paying for a round (checked: the round
// system has no cache-hit branch at all, every call regenerates). Bumped
// anyway per this constant's own documented convention ("bump when the round
// schema/prompt shape changes"), so it stays truthful as a shape marker even
// though nothing currently reads it back. 3.0: nested {routing,copy,art_direction,reasoning}; bump when the round schema/prompt shape changes
const DIRECTOR_ROUND_MODEL   = 'director'; // claude-sonnet-5 — see atlasModelMap
// Lowered from 0.8. The bake-off's one real defect was a REPEATED primary line
// across two concepts, and the same prompt produced it on one run and not the
// next — a consistency problem, not a creativity one.
//
// Caveat worth keeping visible: the round contract has no 'intent' field, so
// within-round distinctness is NOT structurally guaranteed — it rests on the
// archetype/output_shape/copy variation the prompt asks for, plus the duplicate
// headline check in validateDirectorPayload. And the cross-round avoid-list is
// prompt text only, so a lower temperature could in principle make later rounds
// stickier. Watch round-over-round variety after this lands.
const DIRECTOR_ROUND_TEMP    = 0.45;
// Raised 4000 -> 8000 -> 30000 (2026-08-06, owner directive). Measured live
// 2026-08-06 (6 real round calls, sequential + concurrent): actual usage was
// 756-904 output tokens — nowhere near even the old 8000 ceiling. This raise
// is headroom for an unmeasured worst case (a product/brief complex enough to
// need a long response), not a fix for anything observed: a controlled
// sequential-vs-concurrent timing test on this same call shape found NO
// token-limit or truncation involvement in that day's slow/timed-out calls
// (see session.md 2026-08-06) — this is orthogonal insurance, not a fix.
// Ceiling verified live against Atlas (POST /v1/chat/completions,
// anthropic/claude-sonnet-5, max_tokens up to 100000 all returned HTTP 200) —
// a catalog listing was not trusted; the catalog's own schema URL for this
// model 404s. Free unless used: billing is per token actually generated.
const DIRECTOR_ROUND_TOKENS  = 30000;
const AVOID_LIST_MAX_ROUNDS  = parseInt(process.env.DIRECTOR_AVOID_LIST_ROUNDS || '6', 10);
const VISION_ATTACHMENT_CAP  = 6;         // first N universe entries get attached as image_url parts

const CREATIVE_STYLES_ENUM = Object.freeze([
  'brand_led', 'ugc_led', 'social_proof_led', 'editorial', 'promotional'
]);

// PROMOTIONAL IS OPT-IN (owner directive 2026-08-12: "strip promotional
// campaigns being generated at all unless specifically requested").
//
// The style was reachable on EVERY run, and picking it was a trap: the copy it
// asks for — an offer, a price, an urgency number — is exactly what
// validateDirectorPayload rejects unconditionally (the pricing scan). A round
// that chose it burned a second paid Director call to be told a rule the prompt
// never stated. Removing the contradiction in the prompt text fixed the wording;
// this removes the reachability, which is the actual ask.
//
// "Specifically requested" == Campaign.kind === 'promotional' (models/Campaign.js
// :183). That is the same field gating Campaign.promotionalDetails, whose own
// comment reads "Only consulted when kind='promotional'" — so this narrowing
// follows the schema's existing contract rather than inventing a second signal.
//
// NARROW THE MENU, NEVER HARD-REJECT AFTER THE FACT. This deliberately mirrors
// feedOutputShapesForUniverse: the value must be withheld from BOTH the prompt
// line and the response-schema enum, or the model is offered a style the
// validator then throws a paid round away for. Same failure this is fixing.
const PROMOTIONAL_STYLE = 'promotional';

function isPromotionalStyleEnabled(campaignKind) {
  if (String(process.env.DIRECTOR_PROMOTIONAL_STYLE || '').trim().toLowerCase() === 'always') return true;
  return campaignKind === 'promotional';
}

// The styles a given run may actually emit. Order is preserved from
// CREATIVE_STYLES_ENUM so the prompt menu and the schema enum stay comparable
// by eye and by grep.
function creativeStylesFor(campaignKind) {
  return isPromotionalStyleEnabled(campaignKind)
    ? [...CREATIVE_STYLES_ENUM]
    : CREATIVE_STYLES_ENUM.filter((s) => s !== PROMOTIONAL_STYLE);
}

const FEED_OUTPUT_SHAPES = Object.freeze([
  'static_single',   // single hero image, chrome around it
  'static_collage',  // 2-4 images in an asymmetric arrangement (overlapping, off-grid)
  'static_grid'      // 2-4 images in a clean grid (2x2, 1x3, etc.)
]);

// Shapes that require 2–4 media picks. When the seeded universe cannot
// satisfy that (size < 2), the menu narrows to static_single only so the
// Director cannot emit a self-inconsistent collage/grid with one tile.
const MULTI_PICK_FEED_SHAPES = Object.freeze(['static_collage', 'static_grid']);

/**
 * Feed output_shape.format values the universe can actually satisfy.
 * Universe size reaches the shape menu via seededUniverse.length on both
 * the prompt line and the response-schema enum (buildPromptRound /
 * buildResponseSchemaRound). Narrow the menu — do not hard-reject after
 * the fact (that would wipe a paid round for a shape the model was offered).
 *
 * @param {number|Array} universeOrSize
 * @returns {string[]}
 */
function feedOutputShapesForUniverse(universeOrSize) {
  const n = Array.isArray(universeOrSize)
    ? universeOrSize.length
    : (Number(universeOrSize) || 0);
  if (n < 2) return ['static_single'];
  return [...FEED_OUTPUT_SHAPES];
}

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

// ── Round-artifact insert race (MONEY) ────────────────────────────────
// Observed live 2026-08-06: three concurrent directConceptsRound calls for
// the same (brand, product, …) key both paid Claude for concepts, then two
// lost on CreativeDirectionArtifact.create with E11000 on the 6-field unique
// index (roundIndex collision). The paid response was thrown away.
//
// Fix: after the billable call, retry the INSERT ONLY — never re-call the
// LLM. Two retryable classes:
//   (1) roundIndex E11000 → re-derive next free index, re-create
//   (2) transient Mongo/network insert faults → re-create at the same index
// Permanent insert failures (validation/schema/auth) still surface promptly.
//
// Bound exists so a pathological hot key cannot spin forever. 25 attempts:
// each retry is one cheap Mongo insert (+ optional re-read on E11000), while
// the payload being protected is a paid Claude Sonnet 5 response. High
// fan-in on one brand+product+kind+intent+format key is rare (generationGate
// keys on productIds only and blocks overlapping product sets across
// campaigns; platformFormat is part of the unique index so different
// surfaces of one run cannot collide with each other). 25 is cheap insurance
// for that residual case, not a claim that multi-racer fan-in is routine.
const ROUND_ARTIFACT_INSERT_MAX_ATTEMPTS = 25;

/**
 * True when `err` is a Mongo duplicate-key (E11000) on the roundIndex
 * unique index. Detects by numeric/string code 11000, then scopes to THIS
 * index via keyPattern / keyValue / cause — not a bare message substring
 * for "is this a duplicate" (unrelated 11000s must still surface).
 */
function isRoundIndexDuplicateKeyError(err) {
  if (!err) return false;
  // Mongoose sometimes wraps the driver error on .cause
  if (err.cause && err.cause !== err && isRoundIndexDuplicateKeyError(err.cause)) {
    return true;
  }
  const code = err.code;
  if (code !== 11000 && code !== '11000') return false;
  if (err.keyPattern && typeof err.keyPattern === 'object') {
    return Object.prototype.hasOwnProperty.call(err.keyPattern, 'roundIndex');
  }
  if (err.keyValue && typeof err.keyValue === 'object') {
    return Object.prototype.hasOwnProperty.call(err.keyValue, 'roundIndex');
  }
  // Production envelope observed without structured keyPattern on some
  // driver paths: index name + "dup key" both mention roundIndex.
  if (typeof err.message === 'string' &&
      /roundIndex/.test(err.message) &&
      (err.name === 'MongoServerError' || /duplicate key/i.test(err.message))) {
    return true;
  }
  // Bare 11000 with no index signal — do not retry (other unique indexes).
  return false;
}

// Node/driver network codes that surface on socket death or pool blips.
// Allowlist (not denylist): only these + named Mongo network classes +
// retryable write labels count as "try the same insert again". Permanent
// application errors (ValidationError, CastError, DocumentValidationFailure,
// auth, unrelated 11000) must NOT match.
const TRANSIENT_INSERT_NET_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'ECONNREFUSED',
  'EAI_AGAIN', 'EPIPE', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH'
]);

/**
 * True when `err` is a TRANSIENT Mongo/network fault where a pure re-create
 * of the same payload may succeed. Predicate is an allowlist so permanent
 * failures (schema validation, cast, auth, DocumentTooLarge, …) surface
 * on the first attempt rather than being retried pointlessly up to the bound.
 *
 * Matches:
 *   - Node net codes (ECONNRESET / ETIMEDOUT / ECONNREFUSED / …)
 *   - Driver names MongoNetworkError / MongoTimeoutError /
 *     MongoServerSelectionError / MongoNetworkTimeoutError
 *   - Mongo errorLabels TransientTransactionError / RetryableWriteError
 *   - Write-concern / MaxTimeMS codes 50, 89, 91
 * Does NOT match: ValidationError, CastError, 11000 (separate path),
 * 121 DocumentValidationFailure, auth (13/18), bare application Errors.
 */
function isTransientInsertError(err) {
  if (!err) return false;
  if (err.cause && err.cause !== err && isTransientInsertError(err.cause)) {
    return true;
  }
  const code = err.code;
  if (typeof code === 'string' && TRANSIENT_INSERT_NET_CODES.has(code)) return true;
  // Mongo numeric: MaxTimeMSExpired=50, NetworkTimeout=89, ShutdownInProgress=91
  // (91 is rare mid-insert; still safe to re-try create once the primary is up)
  if (code === 50 || code === 89 || code === 91) return true;

  const name = err.name || '';
  if (
    name === 'MongoNetworkError' ||
    name === 'MongoTimeoutError' ||
    name === 'MongoServerSelectionError' ||
    name === 'MongoNetworkTimeoutError'
  ) {
    return true;
  }

  if (Array.isArray(err.errorLabels)) {
    if (
      err.errorLabels.includes('TransientTransactionError') ||
      err.errorLabels.includes('RetryableWriteError')
    ) {
      return true;
    }
  }
  if (typeof err.hasErrorLabel === 'function') {
    if (
      err.hasErrorLabel('TransientTransactionError') ||
      err.hasErrorLabel('RetryableWriteError')
    ) {
      return true;
    }
  }

  // Driver/axios envelopes that only carry the code in the message.
  if (typeof err.message === 'string') {
    if (
      /\bECONNRESET\b|\bETIMEDOUT\b|\bECONNREFUSED\b|\bECONNABORTED\b|\bEAI_AGAIN\b|\bEPIPE\b|\bsocket hang up\b/i
        .test(err.message)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Highest V2 roundIndex for the filter, or null if none. Shared by the
 * initial read-then-write pick and by insert-retry re-derivation.
 */
async function findLastRoundIndex(filter) {
  const last = await CreativeDirectionArtifact.findOne({ ...filter, roundIndex: { $ne: null } })
    .sort({ roundIndex: -1 })
    .select('roundIndex')
    .lean();
  return (last?.roundIndex == null) ? null : last.roundIndex;
}

/**
 * Append-only insert of a paid Director-round artifact. INSERT ONLY — no
 * LLM re-call. Retryable paths (still bounded by ROUND_ARTIFACT_INSERT_MAX_ATTEMPTS):
 *   - roundIndex E11000 → re-derive next free index, re-create
 *   - transient Mongo/network create fault → re-create at the same index
 * Permanent create failures throw on first encounter.
 *
 * @param {object} opts
 * @param {object} opts.filter   — brandId/productId/campaignKind/creativeIntent/platformFormat
 * @param {number} opts.roundIndex — initial candidate (may collide)
 * @param {object} opts.doc      — full create payload EXCEPT roundIndex (set here)
 * @param {function} [opts.create] — injectable for harness (default Model.create)
 * @param {function} [opts.findLast] — injectable for harness (default findLastRoundIndex)
 * @returns {{ artifact: object, roundIndex: number, insertAttempts: number }}
 */
async function createRoundArtifactWithRetry({
  filter,
  roundIndex,
  doc,
  create = (payload) => CreativeDirectionArtifact.create(payload),
  findLast = (f) => findLastRoundIndex(f)
}) {
  let idx = roundIndex;
  let lastErr = null;
  for (let attempt = 1; attempt <= ROUND_ARTIFACT_INSERT_MAX_ATTEMPTS; attempt++) {
    try {
      const artifact = await create({ ...doc, ...filter, roundIndex: idx });
      return { artifact, roundIndex: idx, insertAttempts: attempt };
    } catch (err) {
      lastErr = err;
      const isDup = isRoundIndexDuplicateKeyError(err);
      const isTransient = !isDup && isTransientInsertError(err);
      // Permanent non-duplicate (validation/schema/auth/other-index 11000):
      // surface promptly — retrying cannot fix those.
      if (!isDup && !isTransient) throw err;
      if (attempt >= ROUND_ARTIFACT_INSERT_MAX_ATTEMPTS) throw err;

      if (isDup) {
        // Re-derive next free index. max(last+1, idx+1) guarantees progress
        // even if the re-read is momentarily stale under contention.
        //
        // MONEY: the re-read must not cost the paid response. A transient
        // Mongo read failure here would otherwise propagate out of this
        // function and destroy the concepts we already paid Claude Sonnet 5
        // for — reintroducing, on a rarer path, the exact bug this retry
        // exists to fix. Fall back to a plain bump instead: idx+1 is always a
        // legal next candidate (Math.max below already relies on that for
        // forward progress), so a failed re-read costs at most one wasted
        // insert attempt rather than the whole billable payload.
        let rederived;
        try {
          const last = await findLast(filter);
          rederived = (last == null) ? 0 : (last + 1);
        } catch (readErr) {
          rederived = idx + 1;
          console.warn(
            `🎭 directorRound: roundIndex re-read failed (${readErr.message}) — ` +
            `falling back to r${rederived} rather than dropping a paid response`
          );
        }
        const prev = idx;
        idx = Math.max(rederived, idx + 1);
        console.warn(
          `🎭 directorRound: roundIndex E11000 collision on r${prev}; ` +
          `re-derived r${idx}, insert-only retry ${attempt}/${ROUND_ARTIFACT_INSERT_MAX_ATTEMPTS} ` +
          `(paid concepts kept in-memory — no LLM re-call)`
        );
      } else {
        // Transient create fault: same payload, same roundIndex — the insert
        // never landed, so there is nothing to re-derive.
        console.warn(
          `🎭 directorRound: transient insert fault on r${idx} ` +
          `(${err.code || err.name || err.message}); ` +
          `insert-only retry ${attempt}/${ROUND_ARTIFACT_INSERT_MAX_ATTEMPTS} ` +
          `(paid concepts kept in-memory — no LLM re-call)`
        );
      }
    }
  }
  throw lastErr || new Error('createRoundArtifactWithRetry: exhausted without result');
}

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
  // The round director routes to Anthropic via Atlas, so ATLAS_API_KEY is what it
  // actually needs. Gating on OPENAI_API_KEY here would refuse to run on a
  // correctly-configured Atlas-only deployment, and would refuse BEFORE any call —
  // a hard 500 with a misleading message. OPENAI_API_KEY is still accepted because
  // atlasLlmService can fall back to direct OpenAI for other roles.
  if (!process.env.ATLAS_API_KEY && !process.env.OPENAI_API_KEY) {
    const e = new Error('no LLM credentials: set ATLAS_API_KEY (the director role routes via Atlas)');
    e.status = 500; throw e;
  }
  const { PLATFORM_FORMAT_KEYS } = require('./platformFormats');
  if (!PLATFORM_FORMAT_KEYS.includes(platformFormat)) {
    throw badRequest(`directConceptsRound: platformFormat="${platformFormat}" not supported. Allowed: ${PLATFORM_FORMAT_KEYS.join(', ')}.`);
  }

  // Compute roundIndex from prior artifact rows for this cache key when
  // the caller didn't supply one. The V1 row (roundIndex=null) is
  // ignored — V2 rounds count from 0 independently.
  //
  // This is a read-then-write pick with NO lock — concurrent rounds for
  // the same key can collide. That is fine for the PROMPT (avoid-list /
  // round number context). The paid response is protected later by
  // createRoundArtifactWithRetry (E11000 re-derive + transient insert
  // retry, bounded) — residual risk documented at the persist call site.
  const filter = {
    brandId,
    productId:      productId,
    campaignKind:   campaignKind || null,
    creativeIntent: creativeIntent || null,
    platformFormat
  };
  if (roundIndex == null) {
    const last = await findLastRoundIndex(filter);
    roundIndex = (last == null) ? 0 : (last + 1);
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
  // seededUniverse is THIS run's seed — quote-scope must use it, not
  // the brand PMA union of 10.
  const signals = await assembleSignals({ brandId, productId, campaignKind, seededUniverse });
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
    derivedVoice, creativeBrief, campaignKind
  });
  const promptHash = sha256(system + '\n' + user);
  // campaignKind MUST be passed to both builders. Handing it to only one
  // desynchronises the menu from the enum, which is the self-contradictory-prompt
  // failure this whole change exists to remove.
  const responseSchema = buildResponseSchemaRound(seededUniverse, platformFormat, campaignKind);

  // OpenAI multimodal user content: text + image_url parts.
  const userContent = visionImages.length
    ? [
        { type: 'text', text: user },
        ...visionImages.map(img => ({ type: 'image_url', image_url: { url: img.url } }))
      ]
    : user;

  const t0 = Date.now();

  /**
   * json_object, NOT json_schema. Atlas returns 400 "invalid request params" for
   * strict json_schema on Anthropic models — probed on both text-only and vision
   * requests, so it is the schema and not the images.
   *
   * responseSchema is therefore no longer sent to the transport, but it is still the
   * contract: it is handed to validateDirectorPayload, which re-asserts type,
   * required, enum and array-bound rules against the SAME object the transport used
   * to enforce. That keeps enforcement and contract in one place — a hand-copied
   * field list would drift the first time the schema changed.
   *
   * The model is steered by the field list already written into the prompt text (see
   * buildPromptRound); losing transport enforcement does not lose that.
   */
  // Owner directive: the product NAME does not belong in ad copy. The eliminated
  // incumbent set it in all three concepts, so this is checked, not trusted.
  // Path matches the one renderCampaignBriefBlock already reads, and optional
  // chaining keeps a missing signal from throwing.
  const forbiddenStrings = [inputSummary?.product_signal?.name].filter(Boolean);
  let completion, raw, parsed, reasons = [];
  let attempt = 0;
  const messages = [
    { role: 'system', content: system },
    { role: 'user',   content: userContent }
  ];

  for (;;) {
    completion = await chatCompletion(
      {
        stage:      'creative_director_round',
        provider:   'atlas',
        model:      DIRECTOR_ROUND_MODEL,
        purposeTag: `round:${roundIndex}:${campaignKind || 'untagged'}${attempt ? `:retry${attempt}` : ''}`,
        brandId, productId,
        visionImages: visionImages.length,
        // attempt distinguishes the retry in the ledger. There is no response cache
        // on this path, so this is telemetry, not retry isolation.
        cacheKey:   `directorRound:${brandId}:${productId}:${platformFormat}:${roundIndex}:${attempt}`
      },
      {
        model: DIRECTOR_ROUND_MODEL,
        response_format: { type: 'json_object' },
        messages,
        temperature: DIRECTOR_ROUND_TEMP,
        max_tokens:  DIRECTOR_ROUND_TOKENS
      }
    );

    // ── DEGRADED-BUT-WORKING must not be invisible ────────────────────────
    // This is the lower-severity half of the 2026-08-18 alerting work. The
    // outage stayed silent for ~20h partly because there was no signal
    // BETWEEN "fine" and "zero ads": a Director quietly served by a fallback
    // model looks identical to a healthy one in every log and every artifact.
    //
    // WARN, not info — ALERT_MIN_LEVEL defaults to 'warn', so an info notice
    // would be muted in production, which is the same silence in a new hat.
    // WARN, not fatal — ads ARE being produced; this routes to the normal
    // channel and leaves the fatal channel for the total outage.
    //
    // Keyed per serving model so a switch from opus to terra announces
    // itself, and deduped by the standard 15-minute window so a 50-product
    // run pages once with "+N more" rather than fifty times.
    const chainInfo = chainOutcome(completion);
    if (chainInfo && chainInfo.degraded) {
      alerts.notifyAsync({
        level: 'warn',
        title: 'Director served by a FALLBACK model — the primary is unavailable',
        detail:
          `${chainInfo.summary}\n\n` +
          `Ads ARE still being produced, by ${chainInfo.servedBy.provider}/${chainInfo.servedBy.model} ` +
          `instead of ${chainInfo.primary}. Quality is expected to be lower: the fallback links rank ` +
          `below the primary in the 2026-07-31 bake-off, and openai/gpt-5.6-terra specifically was ` +
          `eliminated for putting the product name in ad copy against an explicit directive — expect ` +
          `more contract warnings and more corrective re-asks while it is serving.\n` +
          `Investigate Atlas capacity on ${chainInfo.primary} before treating this as normal.`,
        fields: {
          primary:   chainInfo.primary,
          servedBy:  `${chainInfo.servedBy.provider}/${chainInfo.servedBy.model}`,
          link:      `${chainInfo.link} of ${chainInfo.linkCount}`,
          viaDirect: String(chainInfo.viaDirect),
          took:      `${chainInfo.elapsedMs}ms`,
          brandId:   String(brandId || '-'),
          productId: String(productId || '-'),
          campaignId: String(campaignId || '-'),
        },
        key: `director:fallback-served:${chainInfo.servedBy.provider}/${chainInfo.servedBy.model}`,
      });
      console.warn(
        `🎭 directorRound[r${roundIndex}]: DEGRADED — served by ` +
        `${chainInfo.servedBy.provider}/${chainInfo.servedBy.model} instead of ${chainInfo.primary} ` +
        `(${chainInfo.summary})`
      );
    }

    raw = completion.choices?.[0]?.message?.content;
    if (!raw) throw new Error('Director (round) returned no content');
    // Atlas SILENTLY IGNORES response_format:{type:'json_object'} on the
    // Anthropic director model — probed live 2026-08-04, both with and without
    // the flag, and both returned conversational prose. So the JSON contract is
    // carried by the prompt's OUTPUT CONTRACT block plus this salvage, not by
    // the flag. Measured before this landed: 10 failures / 1 success in 24h,
    // every failure opening with prose ("I don't have enough information…").
    try {
      parsed = safeParseDirectorJSON(raw);
    } catch (err) {
      // Truncation stays a distinct hard fail: a "return JSON only" re-ask
      // cannot fix a response that ran out of tokens, and the message names
      // the actual lever.
      if (completion.choices?.[0]?.finish_reason === 'length') {
        throw new Error(`Director (round) response truncated at ${DIRECTOR_ROUND_TOKENS} tokens — raise DIRECTOR_ROUND_TOKENS`);
      }
      // ONE corrective budget shared with the schema-validation re-ask below
      // (`attempt >= 1`). Parse-retry and validation-retry must not stack into
      // four paid Director calls — worst case stays TWO, as it was before.
      //
      // CONTENT-CLASS failure, deliberately kept OUT of the transport's
      // taxonomy of transport failures: this is an HTTP 200 whose tokens were
      // generated and BILLED. It must never advance the fallback chain (a
      // different model does not fix prompt compliance) — pinned by
      // verifyDirectorFallbackChain B4. It is coded and logged all the same,
      // so a Render log at 2am distinguishes "the model answered badly" from
      // "the model was unreachable", which used to look identical.
      const contentErr = makeLlmError({
        code: LLM_ERROR_CODES.LLM_CONTENT_UNPARSEABLE,
        role: DIRECTOR_ROUND_MODEL,
        provider: chainInfo ? chainInfo.servedBy.provider : 'atlas',
        model: chainInfo ? chainInfo.servedBy.model : null,
        httpStatus: 200,
        elapsedMs: Date.now() - t0,
        attempt: attempt + 1,
        providerMessage: err.message,
      });
      // The give-up / re-ask decision is ONE condition, read once, so the
      // logged action can never disagree with the branch that runs.
      const giveUp = attempt >= 1;
      stampLlmAction(
        contentErr,
        giveUp ? LLM_ACTIONS.GAVE_UP_PRODUCT : LLM_ACTIONS.CORRECTIVE_REASK,
        giveUp
          ? 'gave up this product — the corrective re-ask also failed, so no ads are minted for it (video is unaffected)'
          : 'response not JSON, re-asking once — the one-shot corrective re-ask shares the attempt budget, so worst case stays two paid Director calls'
      );
      if (giveUp) console.error(formatLlmLogLine(contentErr));
      else console.warn(formatLlmLogLine(contentErr));
      if (attempt >= 1) {
        throw new Error(`Director (round) response not JSON: ${err.message}`);
      }
      messages.push({ role: 'assistant', content: raw });
      messages.push({
        role: 'user',
        content:
          'You returned prose or clarifying questions instead of the required JSON object. ' +
          'Return ONLY the JSON object described in the system prompt — no preamble, no markdown ' +
          'fences, no questions. If signal data is thin, still emit best-effort concepts from ' +
          'product_signal.name, brand_signal voice and the seeded media; set ungrounded nullable ' +
          'fields (art_direction, proof) to null rather than asking for more input.'
      });
      attempt++;
      continue;
    }

    reasons = validateDirectorPayload(parsed, { schema: responseSchema, nConcepts: N_CONCEPTS_ROUND, forbiddenStrings });
    if (!reasons.length || attempt >= 1) break;

    console.warn(
      `🎭 directorRound[r${roundIndex}]: payload rejected, re-asking once — ${reasons.join('; ')}`
    );
    messages.push({ role: 'assistant', content: raw });
    messages.push({
      role: 'user',
      content: `That response is not usable. Fix exactly these problems and return the corrected JSON only:\n` +
               reasons.map(r => `- ${r}`).join('\n')
    });
    attempt++;
  }

  /**
   * A validator must not be able to take generation down.
   *
   * The first version threw here, and that turned a formatting quibble into a
   * production outage: static ads stopped generating entirely because the payload
   * omitted nullable keys the previous transport used to fill in. Rejecting a round
   * the renderers could have used is strictly worse than rendering it.
   *
   * So the only throw left is for a payload that genuinely cannot be used — no
   * concepts at all. Anything else proceeds with an alert, so the problem is
   * visible without being fatal.
   */
  const usable = Array.isArray(parsed?.concepts) && parsed.concepts.length > 0;
  if (reasons.length) {
    if (!usable) {
      throw new Error(`Director (round) returned no usable concepts: ${reasons.join('; ')}`);
    }
    console.warn(
      `🎭 directorRound[r${roundIndex}]: proceeding with ${parsed.concepts.length} concept(s) ` +
      `despite ${reasons.length} contract warning(s) — ${reasons.slice(0, 4).join('; ')}`
    );
    alerts.warn({
      title: 'Director payload did not satisfy the round contract',
      detail: reasons.slice(0, 6).join('\n'),
      fields: { model: DIRECTOR_ROUND_MODEL, round: roundIndex, concepts: parsed.concepts.length },
      key: 'director:contract-warn'
    }).catch(() => {});
  }

  const elapsedMs = Date.now() - t0;
  const proofOptionsCount = Array.isArray(inputSummary?.social_proof_signal?.proof_options)
    ? inputSummary.social_proof_signal.proof_options.length : 0;
  const warnings = validateConceptsRound(parsed.concepts || [], seededUniverse, proofOptionsCount);

  // Append-only persistence. We do NOT use findOneAndReplace — every
  // round writes a NEW artifact. Concurrent callers may share the same
  // pre-call roundIndex; createRoundArtifactWithRetry re-derives on
  // E11000 and retries transient insert faults (Mongo insert only —
  // never re-calls the LLM).
  //
  // Guaranteed: as long as create succeeds within
  // ROUND_ARTIFACT_INSERT_MAX_ATTEMPTS, the already-paid concepts land
  // under some free roundIndex (in-memory payload is not dropped on a
  // retryable fault). Residual risk that can still lose the paid
  // response: bound exhaustion under extreme same-key contention, or a
  // permanent insert error (validation/schema/auth) — both throw after
  // the billable call with no further salvage. Do not claim absolute
  // "never discarded" — that overstates what a bounded retry can honour.
  //
  // The prompt's "round N" text is intentionally NOT re-run to match a
  // re-derived index — the concepts remain valid (see loadAvoidList:
  // avoid list is prior rounds only and does not depend on this insert's
  // final index).
  const { artifact, roundIndex: persistedRoundIndex } = await createRoundArtifactWithRetry({
    filter,
    roundIndex,
    doc: {
      contractVersion:    '3.0',
      contractSchemaId:   'creative_direction_round.v3',
      signalsVersion:     DIRECTOR_SIGNALS_VERSION,
      seedUniverseHash,
      inputSummary,
      availableArchetypes:     [...AVAILABLE_ARCHETYPES],
      availableComponentRoles: [...ROLES],
      creativeRules:           { ...CREATIVE_RULES },
      concepts:                parsed.concepts || [],
      provider:    'atlas',   // the director role routes to Anthropic via Atlas now
      modelId:     DIRECTOR_ROUND_MODEL,
      promptHash,
      promptSystem: system,
      promptUser:   user,
      rawResponse:  raw,
      validationWarnings: warnings,
      createdAt:    new Date()
    }
  });
  // Final persisted index — return value, log, and artifact must agree.
  roundIndex = persistedRoundIndex;

  console.log(
    `🎭 directorRound[r${roundIndex}/${platformFormat}]: ` +
    `brand=${brandId} product=${productId || '-'} kind=${campaignKind || '-'} ` +
    `universe=${seededUniverse.length} concepts=${(parsed.concepts || []).length} ` +
    `took=${elapsedMs}ms warnings=${warnings.length}`
  );

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
      // Dual-read flat v2 and nested v3 via conceptField so the avoid list
      // still summarises cached pre-nest artifacts — same helper the
      // expansion consumer uses (conceptProjection).
      const picks = conceptMediaPicks(c);
      const mediaPickIds = picks.map(p => p.media_id).filter(Boolean).slice(0, 4).join(',') || '-';
      const headlineStr = c.copy?.headline ?? c.copy_picks?.headline;
      const headline = headlineStr
        ? `copy="${String(headlineStr).slice(0, 60)}"`
        : '';
      const archetype = conceptField(c, 'archetype');
      const style = conceptField(c, 'creative_style');
      const shape = conceptField(c, 'output_shape')?.format;
      out.push(
        `[round ${row.roundIndex}] archetype=${archetype || '-'} ` +
        `style=${style || '-'} ` +
        `shape=${shape || '-'} ` +
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
  lines.push(`  Use this voice profile to calibrate emotional_hook, copy.* tone, and CTA wording. Where it conflicts with the operator's tagline, the operator wins; where it conflicts with the campaign brief below, the campaign brief wins.`);
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

function buildPromptRound({ inputSummary, creativeIntent, platformFormat, universe, roundIndex, avoidList, derivedVoice = null, creativeBrief = null, campaignKind = null }) {
  // Must agree with buildResponseSchemaRound's enum for the same run — see the
  // creativeStylesFor comment. Defaulting campaignKind to null means an omitted
  // argument withholds promotional, which is the safe direction: a style that is
  // absent costs a missed option, a style that is offered but unrenderable costs
  // a paid round.
  const allowedStyles = creativeStylesFor(campaignKind);
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

  // PROOF PRESENCE — computed here in JS rather than left to the model, because
  // the reserved proof-led slot below must fire on exactly the INVERSE of the
  // HONESTY RULE's condition. If the two ever both fired, the prompt would
  // simultaneously demand a proof-led concept and forbid surfacing proof —
  // the self-contradictory-prompt failure class that cost a full rollback on
  // the video side (CLAUDE.md §00, PR #61). Reading the same fields the
  // honesty rule reads is what keeps them mutually exclusive.
  //
  // proof_options is included deliberately: when DIRECTOR_PROOF_MENU_ENABLED is
  // on, a product-scoped run has its brand/category proof withheld from
  // primary_quote / rating (cross-product copy guard, assembleSignals) yet still
  // carries usable, SCOPE-LABELLED proof in proof_options. That is precisely the
  // case this change exists to serve, so it must count as proof here — and the
  // honesty rule below is amended, under the same flag, to agree.
  //
  // TWO CORRECTIONS from adversarial review — both were real, do not undo:
  //
  //  1. RATING-BEARING, not merely "any proof". Reserving a slot on the strength
  //     of a quote or a comment ALONE would actively make things worse:
  //     INTENTS.social_proof_led.eligible is rating-only (staticAdIntents.js —
  //     its `core` IS the rating), so a quote-only product would mint
  //     ai_social_proof_led and then fall straight back to objection_resolved at
  //     render. That is the exact collapse this change exists to stop, and the
  //     reserved slot would have amplified it. So the slot is gated on a rating
  //     actually being reachable.
  //  2. The proof_options term is gated on the SAME flag as the honesty rule's
  //     proof_options clause. Ungated, an injected/stale summary carrying
  //     proof_options while the menu is OFF would fire the reserved slot while
  //     the (unamended) honesty rule still demanded social_proof_type="none" —
  //     a self-contradictory prompt, the PR #61 class. Gating both on one flag
  //     is what makes "exact inverse" true rather than merely intended.
  const proofSignal   = inputSummary?.social_proof_signal || {};
  const proofOptions  = (directorProofMenuEnabled() && Array.isArray(proofSignal.proof_options))
    ? proofSignal.proof_options : [];
  const optionHasRating = proofOptions.some(o => o && typeof o.rating === 'number' && o.rating > 0);
  const signalHasRating = !!(proofSignal.rating && typeof proofSignal.rating.value === 'number');
  const hasUsableProof  = signalHasRating || optionHasRating;

  // PMax-only objective blocks. Computed once so Meta rounds never even
  // construct the strings (and cannot accidentally pick up a threshold
  // interpolation). Gate is platformFormat.startsWith('pmax_') — Meta keys
  // never match, so Meta system/user prompts stay byte-identical.
  const isPmax = isPmaxPlatformFormat(platformFormat);

  // Narrower than isPmax: also requires (a) a pmax_video_* destination, not
  // a PMax image format, since there is no split-stage panel outside video,
  // and (b) PMAX_SPLIT_VIDEO=true, so Stage 1 landing this file does not by
  // itself change a single byte of any live PMax video round's prompt.
  // isPmaxVideoDestination lives in veoPromptBuilder (the video prompt
  // builder already owns "is this a PMax video destination"); required
  // inline rather than hoisted so a Meta-only prompt build never pays for
  // the require.
  const isPmaxSplitVideo = isPmax &&
    require('./veoPromptBuilder').isPmaxVideoDestination(platformFormat) &&
    pmaxSplitVideoEnabled();

  const system = [
    `You are a senior creative director planning social-media ad creative.`,
    ``,
    `Your job: emit ${N_CONCEPTS_ROUND} distinct creative concepts. Each concept declares: archetype + composition strategy inside routing, WHICH media from the seeded universe it uses (routing.media_picks), what output shape it materializes (routing.output_shape), the final copy strings it ships (copy), optional visual art_direction, and private reasoning.`,
    ``,
    `ROUND CONTEXT: this is round ${roundIndex} for this product on ${platformFormat}. Earlier rounds (if any) are summarized in the AVOID block below. Each Generate press from the operator triggers a new round; concept diversity across rounds matters as much as within-round diversity.`,
    ``,
    OBJECTIVE_BLOCK,
    ``,
    // PMax only — funnel span + social-proof hierarchy. Spread into the array
    // (not concatenated as a single multi-line string) so the join('\n') below
    // produces the same blank-line rhythm as neighbouring blocks. Empty when
    // Meta so this splice contributes ZERO characters to the Meta prompt.
    ...(isPmax ? [
      buildPmaxFunnelSpreadBlock(),
      ``,
      buildPmaxSocialProofHierarchyBlock(),
      ``
    ] : []),
    // Meta (and any non-PMax destination) only when DIRECTOR_FUNNEL_STAGE_ALL.
    // Lighter than the PMax block: declare a stage, do NOT require one-of-each
    // (Meta does not deliver three concepts into one Google asset group).
    ...(!isPmax && directorFunnelStageAllEnabled() ? [
      [
        `FUNNEL STAGE:`,
        `Each concept MUST declare routing.funnel_stage as one of awareness|consideration|conversion, matching the purchase-journey stage the concept serves.`,
        `  awareness     — brand story / lifestyle / emotional hook; no hard sell.`,
        `  consideration — benefit + proof / objection handling.`,
        `  conversion    — offer / urgency / explicit action.`
      ].join('\n'),
      ``
    ] : []),
    // Split-stage panel treatment — PMax VIDEO only (see isPmaxSplitVideo
    // above), so this never touches a Meta or PMax-image prompt.
    ...(isPmaxSplitVideo ? [
      buildPmaxPanelTreatmentBlock(),
      ``
    ] : []),
    `STRUCTURAL RULES (absolute — violating these ships broken ads):`,
    `- copy.headline / copy.subheadline / copy.eyebrow / copy.cta are the ONLY strings that may appear as letterforms in the ad. Write them as final, shippable copy — not notes, not strategy.`,
    `- art_direction is OPTIONAL visual prose only: mood, light, material, type energy, palette feel. It MUST be null when you have no visual brief. NEVER put honesty-rule notes, "because", "no proof", "leans on", objection analysis, or any "why I chose this" text in art_direction. Those belong exclusively in reasoning.rationale.`,
    `- reasoning.rationale is PRIVATE. It explains which purchase objection the concept removes and which signal supports it. It is NEVER rendered, NEVER shown to an image model, NEVER used as art direction. "Looks premium" is not a rationale.`,
    `- ABSENT MEANS ABSENT. Never invent proof, ratings, quotes, or a visual world to fill a gap. If there is no visual brief, art_direction is null — do not substitute honesty notes or brand-voice commentary.`,
    ``,
    `RULES:`,
    `- DO NOT generate coordinates, rects, or pixel positions. The Layout stage materializes pixels from your strategy + media_picks + output_shape declaration.`,
    // VARIETY, TIGHTENED FROM AN "OR" TO A REQUIREMENT ON COPY.
    //
    // The old rule let a round satisfy "meaningfully different" on archetype /
    // style / media / output_shape ALONE, so three concepts could legally ship
    // the same headline — or, with DIRECTOR_UNIVERSE_TOP_N=1 (the default),
    // could only differ on archetype and style at all, because the media-pick
    // and output_shape axes are both structurally single-valued at universe 1.
    // Copy is the axis the operator actually reads, so it is now mandatory
    // rather than one of five interchangeable options.
    `- The ${N_CONCEPTS_ROUND} concepts MUST be meaningfully different — different archetype, different creative_style, different media-pick combination, or different output_shape — AND, separately and non-negotiably, each MUST carry its own copy angle grounded in a DIFFERENT piece of source material. Copy is not one of the interchangeable axes; it is a requirement on every concept. Two concepts whose headlines could be swapped without a viewer noticing is a failed round.`,
    // GROUNDING — which source each style writes FROM.
    //
    // This is the fix for "three intent profiles, one repeated slogan". The
    // Director was told nulling copy on thin data was fine, and every null then
    // cascaded downstream to the same brand.tagline — so a round of three read
    // as one line three times. It now has a per-style source to reach for, and
    // two sources it never had at all: a RANKED multi-quote pool per proof tier
    // (was 2 per tier, arrival-ordered) and product_signal.specs, which is real
    // Immersive specification data that until now reached nothing in the ad
    // pipeline despite being loaded on every call.
    `- GROUNDING — write each concept's copy FROM a named source, chosen to suit its creative_style:`,
    // TIER MATTERS FOR QUOTES, NOT JUST FOR NUMBERS — and the existing scope
    // rule only covered numbers. proof_options deliberately surfaces category
    // and brand tiers even on a product-scoped run, and brand quotes are
    // withheld from primary_quote precisely because they may describe a
    // DIFFERENT SKU. Telling the model to "write from the quote pool" without
    // saying which tier is safe to quote AS this product re-opens that by the
    // front door, and the pool is now twice the size. A brand-tier line about
    // another garment, repeated verbatim as this product's testimonial, is a
    // false claim about a real product — the one failure here that is worse
    // than a repeated slogan.
    `    social_proof_led  → a specific quote, PRODUCT TIER FIRST. Only proof_options[] entries with tier="product" describe THIS item and may be quoted or paraphrased as its testimonial. Paraphrase or excerpt honestly; keep the reviewer's own concrete detail rather than flattening it to "great quality".`,
    `    social_proof_led (no product-tier quote available) → do NOT promote a category or brand quote into this product's voice: those may describe a different item in the catalogue. Use the tier's scoped NUMBER instead (proof_options[].reviews_text, already phrased for its tier), or switch this concept to a spec or brand-voice angle. Never attribute another SKU's words to this one.`,
    `    ugc_led           → a quote or a top_comment, in the reviewer's/creator's own register — first person, casual, unpolished. Not marketing voice.`,
    `    editorial         → product_signal.specs. Name ONE concrete fact (fabric, construction, weight, dimension, care) and build the line on it. A specific verb about a real property beats two adjectives. This is the style that should read as reported, not sold.`,
    `    brand_led         → brand_signal (tone, summary, tagline). This is the ONLY style that should lean on brand voice — it is the fallback of last resort for every other style, not their first move.`,
    ...(allowedStyles.includes(PROMOTIONAL_STYLE) ? [
      `    promotional       → urgency or scarcity grounded in the PRODUCT — a limited colourway, a seasonal window, a use-case moment — plus one hard fact from product_signal (a spec, a material, availability). Verbs first. NOT a price and NOT a discount: this style is subject to the pricing ban below exactly like every other.`
    ] : []),
    // PRICING BAN — the prompt half of a rule that was previously enforced in
    // silence. validateDirectorPayload rejects the WHOLE round on any currency
    // amount, "N% off", or the words discount / sale / savings, and that check
    // is unconditional — no flag, no campaign-kind exemption. Until 2026-08-12
    // the prompt never stated it, while the `promotional` style above actively
    // demanded "the offer plus ... price / availability ... numbers visible" —
    // so a round that picked that style was instructed to produce precisely
    // what the validator throws away. Measured cost on the 2026-08-12 live run:
    // one extra paid Director call, 19.1s, spent being told a rule nobody had
    // written down. Both halves are load-bearing: state the ban AND remove the
    // instruction that contradicts it, or the round is self-contradictory in
    // the same way §00's PR #61 video prompt was.
    `- NO PRICING OR DISCOUNT LANGUAGE, in any copy field, on any concept. Copy containing a currency amount ("$40", "£29", "€35"), a percentage-off claim ("20% off"), or the words "discount", "sale" or "savings" is REJECTED and the ENTIRE round is re-asked — it is not salvaged per concept. Sell on the product, the proof, or the spec; never on the price.`,
    `- DO NOT ground two concepts in the SAME item. If two concepts are both proof-led, they must quote DIFFERENT reviews from the pool. If the pool has only one usable quote, the second concept must switch source — a spec, or brand voice — rather than restate the same quote.`,
    // Counterweight to "THIN DATA IS NOT A STOP" below, which correctly tells
    // the model it may null an UNGROUNDED role. Read alone, that instruction
    // permitted nulling headline on all three concepts, which is the exact
    // input that collapsed them onto one tagline. Specs are the escape hatch:
    // they are product facts, so a headline built on one is grounded by
    // definition and needs no proof to exist.
    `- A NULLED HEADLINE IS A LAST RESORT, NOT A DEFAULT. If you have no quote and no rating, you almost certainly still have product_signal.specs or a product description — write from those. Only null copy.headline when the concept genuinely has no grounded thing to say, and never on all ${N_CONCEPTS_ROUND} concepts at once: that hands every ad the same fallback line and is indistinguishable from having written nothing.`,
    `- Lead with the STRONGEST signal in the data.`,
    // HONESTY RULE. The flag-ON variant adds the proof_options clause so the rule
    // cannot fire while the PROOF MENU is simultaneously offering usable,
    // scope-labelled brand/category proof — see the hasUsableProof comment above.
    // The flag-OFF string is byte-identical to the pre-change text on purpose:
    // DIRECTOR_PROOF_MENU_ENABLED=false must restore the old prompt exactly.
    directorProofMenuEnabled()
      ? `- HONESTY RULE: if social_proof_signal.primary_quote is null AND top_comments is empty AND rating is null AND social_proof_signal.proof_options is empty, you MUST set routing.social_proof_type="none" on EVERY concept. Don't promise proof the data can't back. In that case also avoid stat_led_social_proof and hero_quote_overlay — lean on brand voice (typographic_dominant, magazine_editorial) or the photo itself. Record that choice in reasoning.rationale only — never in art_direction or copy. When proof_options IS non-empty, proof CAN be backed — but only in that option's own scope, so surface it with its scope wording (see PROOF MENU below), never as this product's own number.`
      : `- HONESTY RULE: if social_proof_signal.primary_quote is null AND top_comments is empty AND rating is null, you MUST set routing.social_proof_type="none" on EVERY concept. Don't promise proof the data can't back. In that case also avoid stat_led_social_proof and hero_quote_overlay — lean on brand voice (typographic_dominant, magazine_editorial) or the photo itself. Record that choice in reasoning.rationale only — never in art_direction or copy.`,
    ...(directorProofMenuEnabled() ? [
      `- PROOF MENU: social_proof_signal.proof_options[] lists every available proof point across product / category / brand tiers, each with its own pre-scoped "reviews_text" disclosure. Set routing.proof_pick to the 0-based index of the option your copy draws from, or null if you used none of them / relied on primary_quote instead. If you write copy from a category or brand option, your words MUST carry that option's own scope (e.g. "loved across our whole line" / "brand-wide") — NEVER phrase a category or brand number as if it belonged to this specific product. routing.proof_pick does NOT change which number or quote actually renders in the ad's dedicated proof slots — that is decided separately, deterministically, and always truthfully; it only tells us which signal informed your copy, for audit.`
    ] : []),
    // RESERVED PROOF-LED SLOT — owner directive 2026-08-07, after social-proof
    // static ads all but disappeared from production. Emitted ONLY when a RATING
    // is reachable (see hasUsableProof above), which is both a strict subset of
    // "honesty rule does not fire" — so the two can never contradict — and the
    // condition the render-side intent actually requires. Deliberately not a
    // mechanical post-parse rejection: a thin-data product should degrade to an
    // honest non-proof concept rather than have a hollow proof ad forced on it,
    // which is the same reasoning behind INTENTS.social_proof_led's `core`.
    ...(hasUsableProof ? [
      `- PROOF-LED COVERAGE: this product has a usable RATING, so at least ONE of your ${N_CONCEPTS_ROUND} concepts MUST set routing.creative_style="social_proof_led" and anchor its composition on that rating (a quote or comment may support it, but the rating is what makes the ad renderable). The other concepts stay free. If you truly cannot ground a proof-led concept on this data, explain why in that concept's reasoning.rationale — do not silently skip it.`
    ] : []),
    // The pick ceiling is derived from the universe actually supplied, not
    // hardcoded. It used to always say "1-4" even when the universe held a
    // single hero — asking for a multi-image composition that cannot be built
    // from one asset.
    //
    // The renderer DOES honour the full pick list: renderService falls back to
    // Ad.mediaIds (the Director's picks) when there is no explicit operator
    // stack, and directImageRenderService sends every resolved reference on one
    // edit call. An earlier revision of this comment claimed the renderer
    // honoured only one reference; that was true before that fallback landed and
    // is false now. Corrected rather than left in place — a comment describing
    // retired behaviour is precisely what makes this codebase expensive to read.
    (() => {
      // `universe` — the parameter this function actually declares. It read
      // `seededUniverse` (the name the CALLER uses for the same array), which is
      // an undeclared free variable, so every fresh Director round threw
      // ReferenceError. Runs served from a cached CreativeDirectionArtifact were
      // unaffected, which is why generation looked intermittently broken rather
      // than broken.
      const n = Array.isArray(universe) ? universe.length : 0;
      const ceiling = Math.min(4, Math.max(1, n));
      const pickPhrase = ceiling === 1
        ? `Pick EXACTLY 1 media per concept — the universe below holds a single image.`
        : `Pick 1-${ceiling} media per concept; every one you pick is sent to the image model as a reference, so pick only what the composition genuinely uses.`;
      return `- MEDIA PICKS: every media_id you reference in routing.media_picks MUST appear in the SEEDED UNIVERSE block below. Pick by media_id verbatim. role is a short label describing how the media sits in your composition. ${pickPhrase} Reels picks 1 video (preferred) or 1-4 image references for Veo synthesis.`;
    })(),
    `- [CRITICAL] The SEEDED UNIVERSE is PRE-RANKED by shot-type quality: lifestyle > on_model > flat_lay > product_only > detail > packaging. Earlier entries are BETTER seeds for animation and stronger composition anchors — STRONGLY prefer them for routing.media_picks[0]. Only reach for lower-ranked entries when a specific concept archetype requires that shot type (e.g. product_card_grid can use flat_lay/product_only intentionally, hero_quote_overlay wants lifestyle/on_model).`,
    platformFormat === 'meta_reels_9_16'
      ? `- OUTPUT SHAPE (Reels): routing.output_shape.format MUST be "reels_storyboard". duration_sec ∈ [${REELS_DURATION_MIN_SEC}, ${REELS_DURATION_MAX_SEC}] (Veo native clip range). storyboard_beats is an array of overlay timing events Puppeteer renders as transparent PNGs and Cloudinary composites onto Veo's base video. Each beat: { t_start (seconds), t_end, role ∈ ${STORYBOARD_BEAT_ROLES.join('|')}, position ∈ ${STORYBOARD_POSITIONS.join('|')}, emphasis ∈ ${STORYBOARD_EMPHASIS.join('|')} }. Beats may overlap. Honor the Reels safe zones in your position picks (top reserved 0-220px, bottom reserved 1558-1778px — use middle positions for chrome that needs to be visible past IG/FB UI).`
      : (() => {
          // Universe size reaches the shape menu here (same array the MEDIA
          // PICKS ceiling uses). When n < 2, multi-pick shapes are off the
          // menu so the model cannot declare a collage it cannot fill.
          const offered = feedOutputShapesForUniverse(universe);
          const multiNote = offered.length === 1
            ? ' (universe has fewer than 2 images — collage/grid are not available this round)'
            : '';
          return `- OUTPUT SHAPE (Feed): routing.output_shape.format ∈ ${offered.join(' | ')}${multiNote}; tile_count matches media_picks.length.`;
        })(),
    // `product_signal.specs` and the multi-quote pool added to this list so the
    // authoritative COPY instruction sanctions the same sources the GROUNDING
    // rules above tell each style to reach for. Leaving them out here would
    // have the two blocks disagree, and this is the one the model treats as the
    // definition of "allowed to ground on".
    `- COPY: write the final strings the renderer will ship under copy.{headline,subheadline,eyebrow,cta}. Pull from brand_signal.tagline / description / brand_reviews_summary, product_signal.description, product_signal.specs (real specification facts for THIS product — fabric, construction, weight, dimensions, care), social_proof_signal.primary_quote, and the wider quote pool in social_proof_signal.proof_options[].quotes when grounding. Use null for any role the concept intentionally omits (e.g. eyebrow=null when the design has no eyebrow rule). Storyboard beats reference copy by role — each beat's role MUST map to a non-null copy field (e.g. role=headline beat requires copy.headline non-null).`,
    `- ONE PRODUCT ONLY: every string you write describes product_signal.name and nothing else. brand_signal.* and brand_reviews_summary cover the WHOLE catalog — they are there for voice and tone, never for product facts. Never name, describe, or borrow the attributes of another item (a different garment, cut, fabric, or use case) even when the brand material talks about it. If the brand voice material is about a different product, take only its register and write fresh copy about THIS one. Concretely: a t-shirt ad never mentions leggings, joggers, or their fit.`,
    // CREATIVE STYLE. This was a bare enum listing with no selection criteria,
    // and routing.creative_style is what mints Ad.template downstream
    // (CREATIVE_STYLE_TO_TEMPLATE, campaignAdsGenerationService) where anything
    // unrecognised falls to 'ai_brand_led'. Measured consequence in production
    // over 2026-07-30..08-06: brand_led 200+ renders vs social_proof_led 18.
    // The string "social_proof_led" appeared exactly once in this entire file —
    // in the enum — and in ZERO guidance, so the model had nothing telling it
    // when proof is the right angle. Naming brand_led as the last resort is the
    // deliberate counterweight to that silent default.
    `- CREATIVE STYLE: set routing.creative_style to the ONE style the concept is actually built on. Choose by what the DATA supports, not by variety alone:`,
    `    social_proof_led — the visual anchor IS proof: a star rating, a review count, a customer quote, or a creator comment. Pick this whenever social_proof_signal carries a usable rating, primary_quote, or top_comment${directorProofMenuEnabled() ? ' (or any proof_options entry)' : ''}. Proof is the highest-converting angle available and is currently the most under-used style — reach for it when the data is there.`,
    `    ugc_led — a creator/UGC image is the hero and the concept leans on its authenticity rather than on a claim.`,
    `    editorial — magazine-style art direction; composition and typography carry the ad, with no proof or offer as the anchor.`,
    ...(allowedStyles.includes(PROMOTIONAL_STYLE) ? [
      `    promotional — urgency, scarcity, or a specific objection being dissolved is the headline. Grounded in the product (a limited run, a seasonal window, a fit worry answered) — never in a price or a discount, which are banned outright above.`
    ] : []),
    `    brand_led — brand voice / tagline / positioning carries it. This is the DEFAULT OF LAST RESORT: pick it only when there is no usable proof, no UGC hero, or no editorial angle. Do not pick it out of habit.`,
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
    `SEEDED MEDIA UNIVERSE (use media_id verbatim in routing.media_picks; vision attachments below show the first ${VISION_ATTACHMENT_CAP}):`,
    universeBlock,
    ``,
    `AVAILABLE ARCHETYPES (pick one per concept into routing.archetype):`,
    AVAILABLE_ARCHETYPES.map(a => `  ${a}`).join('\n'),
    ``,
    `AVAILABLE ROLES (used in routing.recommended_components — map of role → component_style):`,
    ROLES.map(r => `  ${r}: [${(COMPONENT_STYLE_BY_ROLE[r] || []).join(', ')}]`).join('\n'),
    ``,
    `Per concept emit (nested shape — additionalProperties false at every level):`,
    `  concept_id          — short slug (must be unique within this round)`,
    `  name                — human-readable concept name`,
    `  routing             — strategy block:`,
    `    archetype         — one of the available archetypes`,
    `    layout_family     — short alias`,
    `    emotional_hook    — purchase OBJECTION the concept dissolves ("fit certainty", "worth the price"), not a visual mood`,
    `    social_proof_type — testimonial / stat / creator / review / rating / none`,
    `    *_priority        — high/medium/low/absent for product, ugc, comment, stat`,
    `    cta_emphasis      — primary/secondary/minimal/absent`,
    `    creative_style    — one of the creative styles enum`,
    `    recommended_components — map of role → component_style`,
    `    media_picks       — [{ media_id, role, notes }] referencing SEEDED UNIVERSE`,
    platformFormat === 'meta_reels_9_16'
      ? `    output_shape      — { format: 'reels_storyboard', duration_sec, storyboard_beats: [{t_start, t_end, role, position, emphasis}] }`
      : `    output_shape      — { format, tile_count }`,
    // PMax always; Meta only when DIRECTOR_FUNNEL_STAGE_ALL. Flag-off
    // Meta prompt stays byte-identical. PMax keeps the one-of-each
    // wording; Meta (flag-on) just asks the concept to declare a stage.
    ...(shouldEmitFunnelStage(platformFormat) ? [
      isPmax
        ? `    funnel_stage     — awareness | consideration | conversion (declare which stage this concept serves; one of each across the round)`
        : `    funnel_stage     — awareness | consideration | conversion (declare which purchase-journey stage this concept serves)`
    ] : []),
    // PMax split-stage VIDEO only — see isPmaxSplitVideo above. Absent from
    // both the PMax-image and Meta per-concept listings.
    ...(isPmaxSplitVideo ? [
      `    panelTreatment   — ${PANEL_TREATMENT_VALUES.join(' | ')} (which treatment the generatively-extended copy panel should use; see PMAX SPLIT-STAGE VIDEO PANEL above)`
    ] : []),
    `  copy                — { headline, subheadline, eyebrow, cta } final strings (nullable per role) — ONLY letterforms`,
    `  art_direction       — null OR { look, palette_hint, typography_hint } visual prose only; null if no visual brief`,
    `  reasoning           — { rationale } PRIVATE: which objection + which signal. Never visual notes.`,
    ``,
    // Atlas drops response_format:json_object for the Anthropic director model,
    // so the JSON contract has to live in the prompt. Without this block the
    // model answered with clarifying questions on thin-signal SKUs and the
    // round threw — 10 failures / 1 success measured over 24h on 2026-08-04.
    `OUTPUT CONTRACT (absolute — non-negotiable):`,
    `- Your entire reply MUST be a single JSON object. No prose before or after it. No markdown fences. No clarifying questions. Never open with "I don't have enough information", "Before I generate", "A couple of things" or any similar preamble.`,
    `- Do NOT ask the operator for more data. This is a non-interactive batch job; the JSON object is your only deliverable.`,
    // NOTE the deliberate wording on product_signal.name: it identifies WHAT you
    // are directing, and must never be pushed into the copy strings.
    // validateDirectorPayload rejects any concept whose copy contains the product
    // name (owner directive), and that rejection would consume the single shared
    // corrective re-ask that exists for genuine parse failures.
    `- THIN DATA IS NOT A STOP. When product_signal.description, reviews, ugc_signal or social_proof_signal are null or empty, still emit ${N_CONCEPTS_ROUND} concepts. Use product_signal.name only to know WHAT the product is — never write it into copy.* — and build from brand_signal voice and the SEEDED UNIVERSE imagery. Set social_proof_type to "none", art_direction to null, and any ungrounded copy role to null. Prefer photo-led or brand-voice archetypes over inventing proof. Never refuse.`
  ].join('\n');

  const user = [
    `INPUT SUMMARY (signals you're directing for):`,
    '```json',
    JSON.stringify(inputSummary, null, 2),
    '```',
    ``,
    creativeIntent ? `OPERATOR HINT: ${creativeIntent}` : `OPERATOR HINT: none — you decide.`,
    ``,
    `Return ONLY a JSON object containing ${N_CONCEPTS_ROUND} distinct concepts. No preamble, no questions, no markdown fences. Honor the AVOID block, draw media_ids from the SEEDED UNIVERSE, and ground every copy.* field in real signal where it exists — where signal is thin, still emit best-effort concepts rather than asking for more input.`
  ].join('\n');

  return { system, user, visionImages };
}

/**
 * Salvage Director output when the gateway ignores response_format.
 *
 * Atlas silently drops `response_format:{type:'json_object'}` for
 * `anthropic/claude-sonnet-5-ccmax` (probed live 2026-08-04 — both arms
 * returned prose), so a reply can arrive fenced, or as a JSON object embedded
 * in commentary. Order: strip fences → JSON.parse → scan EVERY balanced {...}
 * span → JSON5. Mirrors judgeService.safeParseJSON, but uses balanced-brace
 * extraction rather than a greedy /\{[\s\S]*\}/ — the greedy form swallows
 * trailing prose and turns a salvageable reply into a parse error.
 *
 * WHY IT SCANS EVERY CANDIDATE RATHER THAN THE FIRST (adversarial review,
 * 2026-08-04): committing to the first '{' is defeated by prose that merely
 * CONTAINS braces. "I considered {option A} vs {option B}.\n{...real json...}"
 * extracts "{option A}", fails to parse, and the whole salvage throws even
 * though a valid payload sits right there. Scanning every span fixes that.
 *
 * SELECTION RULE when several spans parse: prefer the LAST one carrying a
 * `concepts` array, else the first parseable object. A leading object is far
 * more likely to be an illustrative sketch than the answer — models that
 * preface their work put the real payload last. This is a heuristic on
 * genuinely ambiguous input; validateDirectorPayload + forbiddenStrings still
 * gate whatever comes back, so a wrong pick degrades to a contract warning
 * rather than shipping silently.
 *
 * This CANNOT rescue a pure refusal that contains no JSON at all; that is what
 * the prompt's OUTPUT CONTRACT block and the one corrective re-ask are for.
 */
function safeParseDirectorJSON(raw) {
  let text = String(raw == null ? '' : raw).trim();
  if (!text) throw new Error('empty response');
  text = text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  try { return JSON.parse(text); } catch { /* fall through to extraction */ }

  const parsed = [];
  let i = text.indexOf('{');
  while (i >= 0) {
    const span = balancedSpanFrom(text, i);
    if (!span) { i = text.indexOf('{', i + 1); continue; }
    let obj;
    let ok = true;
    try { obj = JSON.parse(span); }
    catch { try { obj = JSON5.parse(span); } catch { ok = false; } }
    if (ok) {
      parsed.push(obj);
      // A parsed span's nested objects are not separate candidates.
      i = text.indexOf('{', i + span.length);
    } else {
      // Unparseable span (e.g. prose braces) — look inside it too.
      i = text.indexOf('{', i + 1);
    }
  }

  if (!parsed.length) throw new Error('no parseable JSON object in response');
  const withConcepts = parsed.filter((o) => o && Array.isArray(o.concepts));
  return withConcepts.length ? withConcepts[withConcepts.length - 1] : parsed[0];
}

/**
 * The balanced {...} span starting at `start`, tracked with string-aware brace
 * depth so a brace inside a quoted string cannot end the object early.
 *
 * BOTH quote characters are tracked. JSON5 permits single-quoted strings, and
 * this salvage falls back to JSON5 — a scanner that only knew `"` would cut
 * `{'note': 'use } here'}` at the brace inside the single-quoted value and
 * then hand JSON5 a truncated span. Returns null when nothing balances.
 */
function balancedSpanFrom(s, start) {
  if (start < 0 || s[start] !== '{') return null;
  let depth = 0;
  let quote = null;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/** First balanced {...} span in `text`, or null. Thin wrapper for callers. */
function extractFirstBalancedObject(text) {
  const s = String(text);
  return balancedSpanFrom(s, s.indexOf('{'));
}

function buildResponseSchemaRound(seededUniverse, platformFormat = 'meta_feed_1_1', campaignKind = null) {
  // Transport-level half of the promotional narrowing. buildPromptRound withholds
  // the style from the MENU; this withholds it from the ENUM, so a model that
  // ignores the prompt still cannot emit it. Both halves are required — schema
  // alone leaves the prompt advertising an unselectable style, prompt alone
  // leaves the model free to emit one.
  const allowedStyles = creativeStylesFor(campaignKind);
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
    : (() => {
        // Same universe-size gate as the prompt: enum only what the universe
        // can satisfy. schema is soft (json_object transport) but the hand-
        // rolled validator and the prompt must agree on the menu.
        const offered = feedOutputShapesForUniverse(seededUniverse);
        const maxTiles = Math.min(4, Math.max(1, Array.isArray(seededUniverse) ? seededUniverse.length : 1));
        return {
          type: 'object',
          additionalProperties: false,
          required: ['format', 'tile_count'],
          properties: {
            format:     { type: 'string', enum: offered },
            tile_count: { type: 'integer', minimum: 1, maximum: maxTiles }
          }
        };
      })();

  // Nested v3 shape. Private reasoning lives under reasoning.rationale so a
  // render path that only reads art_direction / copy cannot reach it. Transport
  // is still response_format json_object (Atlas 400s on strict json_schema for
  // Anthropic); this schema is for the hand-rolled non-fatal validator only.
  //
  // funnel_stage is PMax-only (gated below). It lives under routing per the v3
  // convention; consumers read it via conceptField() (conceptProjection dual-
  // reads any name — listing it in ROUTING_NESTED_FIELDS is documentation-only
  // for that module and is out of scope for this change).
  const isPmax = isPmaxPlatformFormat(platformFormat);
  // panelTreatment is narrower still — PMax VIDEO only, and only once
  // PMAX_SPLIT_VIDEO is on (see pmaxSplitVideoEnabled's comment). Required
  // inline (not hoisted) for the same reason buildPromptRound does it inline:
  // a Meta/PMax-image schema build never pays for the require.
  const isPmaxSplitVideo = isPmax &&
    require('./veoPromptBuilder').isPmaxVideoDestination(platformFormat) &&
    pmaxSplitVideoEnabled();
  const routingSchema = {
    type: 'object',
    additionalProperties: false,
    required: [
      'archetype', 'layout_family', 'emotional_hook', 'social_proof_type',
      'product_priority', 'ugc_priority', 'comment_priority', 'stat_priority',
      'cta_emphasis', 'creative_style', 'recommended_components',
      'media_picks', 'output_shape',
      // panelTreatment is nullable (see property def below) but — unlike
      // proof_pick / funnel_stage above — IS listed in `required` whenever
      // the property itself is offered. That matches real OpenAI strict-mode
      // semantics (every declared property must be required; nullability is
      // how "optional" is expressed) rather than this file's older
      // soft-validator convention of omitting optional-nullable fields from
      // `required`. Both conditions must travel together: a property present
      // in `properties` without a matching `required` entry — or vice versa —
      // makes schemaErrors() either silently accept a missing field with no
      // nullable escape hatch, or flag every Meta/PMax-image round as missing
      // a field it was never asked to emit.
      ...(isPmaxSplitVideo ? ['panelTreatment'] : [])
    ],
    properties: {
      archetype:         { type: 'string', enum: AVAILABLE_ARCHETYPES },
      layout_family:     { type: 'string' },
      emotional_hook:    { type: 'string' },
      social_proof_type: { type: 'string' },
      product_priority:  { type: 'string', enum: ['high', 'medium', 'low', 'absent'] },
      ugc_priority:      { type: 'string', enum: ['high', 'medium', 'low', 'absent'] },
      comment_priority:  { type: 'string', enum: ['high', 'medium', 'low', 'absent'] },
      stat_priority:     { type: 'string', enum: ['high', 'medium', 'low', 'absent'] },
      cta_emphasis:      { type: 'string', enum: ['primary', 'secondary', 'minimal', 'absent'] },
      creative_style:    { type: 'string', enum: [...allowedStyles] },
      recommended_components: {
        type: 'object',
        additionalProperties: false,
        required: [...ROLES],
        properties: Object.fromEntries(
          ROLES.map(r => [r, { type: ['string', 'null'] }])
        )
      },
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
      // Optional and nullable, and DELIBERATELY absent from `required` above —
      // this is a non-strict, hand-rolled validator (see the comment on
      // routingSchema's transport note), not OpenAI's strict json_schema
      // mode, so an omitted property here is a warning candidate, not a
      // parse failure. A Director run from before this shipped, or with the
      // menu flag off, never emits this key at all; that must keep working.
      proof_pick: { type: ['integer', 'null'] },
      // PMax always; Meta only when DIRECTOR_FUNNEL_STAGE_ALL. Nullable,
      // not required (same soft-validator posture as proof_pick). Flag-off
      // Meta schemas omit this key so Meta stays byte-identical.
      ...(shouldEmitFunnelStage(platformFormat) ? {
        funnel_stage: { type: ['string', 'null'], enum: [...PMAX_FUNNEL_STAGES, null] }
      } : {}),
      // PMax split-stage VIDEO only — see isPmaxSplitVideo above. Nullable
      // AND listed in `required` (unlike funnel_stage/proof_pick) — see the
      // comment on `required` above for why this field intentionally follows
      // the stricter convention.
      ...(isPmaxSplitVideo ? {
        panelTreatment: { type: ['string', 'null'], enum: [...PANEL_TREATMENT_VALUES, null] }
      } : {})
    }
  };

  const copySchema = {
    type: 'object',
    additionalProperties: false,
    required: ['headline', 'subheadline', 'eyebrow', 'cta'],
    properties: {
      headline:    { type: ['string', 'null'] },
      subheadline: { type: ['string', 'null'] },
      eyebrow:     { type: ['string', 'null'] },
      cta:         { type: ['string', 'null'] }
    }
  };

  const artDirectionSchema = {
    // null = no visual brief (correct when honesty rule leaves only typography
    // strategy). Object is OPTIONAL visual prose only — never honesty notes.
    type: ['object', 'null'],
    additionalProperties: false,
    required: ['look', 'palette_hint', 'typography_hint'],
    properties: {
      look:             { type: ['string', 'null'] },
      palette_hint:     { type: ['string', 'null'] },
      typography_hint:  { type: ['string', 'null'] }
    }
  };

  const reasoningSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['rationale'],
    properties: {
      rationale: { type: 'string' }
    }
  };

  return {
    name: isReels ? 'creative_director_round_reels_v3' : 'creative_director_round_feed_v3',
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
              'concept_id', 'name', 'routing', 'copy', 'art_direction', 'reasoning'
            ],
            properties: {
              concept_id:    { type: 'string' },
              name:          { type: 'string' },
              routing:       routingSchema,
              copy:          copySchema,
              art_direction: artDirectionSchema,
              reasoning:     reasoningSchema
            }
          }
        }
      }
    },
    strict: true
  };
}

// Soft-warning validator for round concepts. Hard rejection moves to the
// Judge in A4. Here we surface useful diagnostics:
//   • duplicate concept_ids within a round
//   • media_picks referencing IDs outside the seeded universe
//   • output_shape.tile_count != media_picks.length
//   • all copy fields null (probably an LLM miss)
// Dual-reads flat v2 and nested v3 so a mixed cache window still diagnoses.
function validateConceptsRound(concepts, seededUniverse, proofOptionsCount = 0) {
  const warnings = [];
  if (!Array.isArray(concepts) || !concepts.length) {
    warnings.push('no concepts emitted');
    return warnings;
  }
  const universeIds = new Set(seededUniverse.map(u => String(u.mediaId)));
  const conceptIds = new Set();

  // Dual-read v2 (flat) and v3 (nested) via the shared conceptProjection
  // helpers — same contract the expansion consumer uses.
  const copyOf = (c) => (c && (c.copy || c.copy_picks)) || {};

  for (const c of concepts) {
    if (!c?.concept_id) continue;
    if (conceptIds.has(c.concept_id)) {
      warnings.push(`duplicate concept_id "${c.concept_id}" within round`);
    }
    conceptIds.add(c.concept_id);

    const picks = conceptMediaPicks(c);
    for (const p of picks) {
      if (!p?.media_id) continue;
      if (!universeIds.has(String(p.media_id))) {
        warnings.push(`concept ${c.concept_id}: media_pick "${p.media_id}" not in seeded universe`);
      }
    }

    const shape = conceptField(c, 'output_shape');
    const tileCount = shape?.tile_count;
    if (typeof tileCount === 'number' && tileCount !== picks.length) {
      warnings.push(`concept ${c.concept_id}: output_shape.tile_count=${tileCount} != media_picks.length=${picks.length}`);
    }

    // proof_pick bounds — cross-references social_proof_signal.proof_options,
    // which the generic schema walker (schemaErrors) cannot do; it only
    // type-checks the field in isolation. Absence is fine (null / omitted both
    // mean "used none of the menu"); a present value must be a real index into
    // the menu THIS round actually saw, or the audit trail points at proof
    // that either never existed or existed under a different signals version.
    const proofPick = conceptField(c, 'proof_pick');
    if (proofPick != null) {
      if (!Number.isInteger(proofPick) || proofPick < 0 || proofPick >= proofOptionsCount) {
        warnings.push(`concept ${c.concept_id}: proof_pick=${JSON.stringify(proofPick)} is out of range for ${proofOptionsCount} proof_options`);
      }
    }

    const cp = copyOf(c);
    if (cp.headline == null && cp.subheadline == null && cp.eyebrow == null && cp.cta == null) {
      warnings.push(`concept ${c.concept_id}: all copy fields are null (likely LLM miss)`);
    } else if (cp.headline == null) {
      // Blind spot closed: static render typesets only copy.headline (directImageRenderService
      // buildIntentData). A concept that writes subheadline/eyebrow and nulls headline previously
      // logged dirWarnings=0 while shipping an ad whose only text was the CTA.
      warnings.push(`concept ${c.concept_id}: copy.headline is null (static path typesets headline only)`);
    }

    // Single-format sanity
    if (shape?.format === 'static_single' && picks.length !== 1) {
      warnings.push(`concept ${c.concept_id}: output_shape=static_single requires 1 media_pick (got ${picks.length})`);
    }
    if (['static_collage', 'static_grid'].includes(shape?.format) && (picks.length < 2 || picks.length > 4)) {
      warnings.push(`concept ${c.concept_id}: output_shape=${shape.format} requires 2-4 media_picks (got ${picks.length})`);
    }

    // Reels storyboard sanity (Phase B1):
    //   • duration_sec within [REELS_DURATION_MIN_SEC, REELS_DURATION_MAX_SEC]
    //   • beats t_end > t_start
    //   • beats t_end <= duration_sec
    //   • beat role maps to a non-null copy field (where applicable)
    //   • at least one beat present
    if (shape?.format === 'reels_storyboard') {
      const dur = shape.duration_sec;
      if (typeof dur !== 'number' || dur < REELS_DURATION_MIN_SEC || dur > REELS_DURATION_MAX_SEC) {
        warnings.push(`concept ${c.concept_id}: reels_storyboard duration_sec=${dur} outside [${REELS_DURATION_MIN_SEC},${REELS_DURATION_MAX_SEC}]`);
      }
      const beats = Array.isArray(shape.storyboard_beats) ? shape.storyboard_beats : [];
      if (!beats.length) {
        warnings.push(`concept ${c.concept_id}: reels_storyboard has zero storyboard_beats`);
      }
      const copyRoleToField = {
        headline:    'headline',
        eyebrow:     'eyebrow',
        subheadline: 'subheadline',
        cta:         'cta'
        // badge/quote/stat/logo don't bind to copy — they're
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
          warnings.push(`concept ${c.concept_id}: beat role=${beat.role} references copy.${requiredCopyField} which is null`);
        }
      }
    }
  }

  // Distinctness — fingerprint by archetype + output_shape + media-pick-set + headline angle.
  if (concepts.length >= 2) {
    const fingerprints = concepts.map(c => {
      const picks = conceptMediaPicks(c);
      const ms = picks.map(p => p.media_id).sort().join(',');
      const shape = conceptField(c, 'output_shape');
      const headline = (c.copy?.headline || c.copy_picks?.headline || '').slice(0, 30);
      return `${conceptField(c, 'archetype')}|${shape?.format}|${ms}|${headline}`;
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
  directorQuotePoolAlignedEnabled,
  directorFunnelStageAllEnabled,
  shouldEmitFunnelStage,
  pickDirectorPrimaryQuote,
  productQuotesForDirector,
  AVAILABLE_ARCHETYPES,
  CREATIVE_RULES,
  CREATIVE_STYLES_ENUM,
  creativeStylesFor,
  FEED_OUTPUT_SHAPES,
  feedOutputShapesForUniverse,
  MULTI_PICK_FEED_SHAPES,
  REELS_OUTPUT_SHAPES,
  STORYBOARD_BEAT_ROLES,
  STORYBOARD_POSITIONS,
  STORYBOARD_EMPHASIS,
  REELS_DURATION_MIN_SEC,
  REELS_DURATION_MAX_SEC,
  MODEL_ID,
  ROUND_VERSION,
  N_CONCEPTS_ROUND,
  DIRECTOR_ROUND_TOKENS,
  // exposed for testing
  buildPromptRound,
  buildResponseSchemaRound,
  validateConceptsRound,
  loadAvoidList,
  brandQuoteForDirectorSignal,
  resolveDirectorProductRatingPair,
  // Exported so the diversity harness can call the REAL validator rather than
  // assert on its source text — a source check passes against any
  // reimplementation that keeps the name, which is not what needs pinning here.
  validateDirectorPayload,
  // Exported for the same reason: the harness ranks/normalises with the shipped
  // functions, so it cannot drift from what the Director actually receives.
  normalizeProductSpecs,
  scoreQuoteSafe,
  buildDirectorProofOptions,
  directorProofMenuEnabled,
  safeParseDirectorJSON,
  extractFirstBalancedObject,
  // PMax split-stage video (Stage 1 — Director field only, see
  // services/pmaxSplitStrategy.js for the side-choice geometry)
  pmaxSplitVideoEnabled,
  panelTreatmentFromConcept,
  PANEL_TREATMENT_VALUES,
  // money: roundIndex insert-race helpers (verifyDirectorRoundPersist)
  ROUND_ARTIFACT_INSERT_MAX_ATTEMPTS,
  isRoundIndexDuplicateKeyError,
  isTransientInsertError,
  createRoundArtifactWithRetry,
  findLastRoundIndex
};
