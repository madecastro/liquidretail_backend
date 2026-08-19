// Phase 1.7c — category-level reviews fetch.
//
// Gemini grounded search for reviews of a specific category within a brand,
// keyed by breadcrumb. Different from brandReviews (overall brand sentiment)
// and productReviews (specific SKU sentiment) — this fills the middle tier:
// "what do reviewers say about Pelagic Gear's performance shirts?" → quotes
// like "best fishing shirt I've owned" that mention the category but aren't
// SKU-specific.
//
// Cache: persisted on Brand.categoryReviews[] keyed by a normalized
// breadcrumb hash. 30-day TTL (matches brandReviews + productReviews).
// Cache-aware resolver returns immediately on fresh hit, fires async
// fetch on miss/stale.
//
// Used by:
//   - Phase 1.7b enrichment Tier 2 (product_category outcomes)
//   - Phase 1.7b enrichment Tier 1 fallback when productReviews is empty
//   - Phase 1.7c instagramCommentService category-level comment quotes

// NO `axios` require here on purpose (removed 2026-08-19). Both of this file's
// billable POSTs now go through a ledgered transport — the grounded pass via
// providers/geminiSearchProvider.trackedGenerate, the structuring pass via
// atlasLlmService.chatCompletion. A bare axios.post reappearing in this file is
// a call billing Google with nothing in CostLog; that is what
// scripts/verifyGroundedGeminiLedger.js E1/E2 exist to catch.
const Brand    = require('../models/Brand');
const Category = require('../models/Category');
const { breadcrumbToKey } = require('../models/Category');
// The ad-usable quote directive and pool cap live in ONE place
// (providers/geminiSearchProvider) so the brand, product and category retrieval
// prompts cannot drift apart. Imported, never restated.
const {
  AD_USABLE_QUOTE_DIRECTIVE,
  LLM_QUOTE_CAP,
  keepVerbatimQuotes,
  GROUNDED_PASS1_CONFIG,
  GROUNDED_PASS2_MAX_TOKENS,
  GROUNDED_CALL_TIMEOUT_MS,
  warnIfTruncated,
  // The LEDGERED direct-REST transport (stage/purposeTag/grounded + CostLog
  // write, response BODY not axios envelope, maxRedirects:0). Imported, never
  // re-implemented — see its comment in the provider for the three things a
  // near-copy gets wrong.
  trackedGenerate,
  // Was `process.env.GEMINI_SEARCH_MODEL || 'gemini-2.5-flash'` declared locally.
  // Identical value, but declared twice: now imported so the model this file
  // NAMES in its error logs is provably the model trackedGenerate LEDGERS.
  GEMINI_REST_MODEL: GEMINI_MODEL
} = require('./providers/geminiSearchProvider');
// Pass 2 (narrative -> JSON) is never grounded, so it is Atlas-routed — same
// reasoning, same model, as geminiSearchProvider.structureReviewNarrative.
const { chatCompletion } = require('./atlasLlmService');
// ONE shared LLM error taxonomy — services/llmError.js. Imported, not
// re-implemented per call site. Every LLM failure in this file is REPORTED
// with a stable code, the provider/model/status/request_id context, and the
// action the system actually took next — so a Render log at 2am distinguishes
// "rate limited", "timed out", "no key" and "bad request", which all used to
// print as one indistinguishable `err.message`.
const {
  LLM_ERROR_CODES, LLM_ACTIONS, classifyLlmFailure, makeLlmError,
  extractRequestId, formatLlmLogLine,
} = require('./llmError');

// ENDPOINT deleted 2026-08-19 — the direct REST URL lives in ONE place now
// (providers/geminiSearchProvider, behind trackedGenerate). Re-adding it here
// means someone is about to bypass the ledger again.
const TTL_MS       = 30 * 24 * 60 * 60 * 1000;  // 30 days

function isEnabled() { return !!process.env.GEMINI_API_KEY; }

// Cache-aware resolver. Phase 2a — reads from the Category collection
// (one row per breadcrumb per brand). Falls back to legacy
// Brand.categoryReviews[] subarray during migration so old runs that
// pre-date Category-collection writes still resolve.
//
// Fresh hit → returns the cached snapshot now. Miss/stale → fires
// background fetch + writes the Category row; returns null so the
// current detect run finishes fast (cached result lands on next run).
async function maybeFetchCategoryReviewsCached({ brandId, brandName, brandUrl, breadcrumb, categoryId = null }) {
  if (!brandId || !breadcrumb) return null;
  const key = breadcrumbToKey(breadcrumb);
  if (!key) return null;

  // Phase 2a primary read — Category collection by FK or breadcrumbKey.
  let categoryRow = null;
  if (categoryId) {
    categoryRow = await Category.findById(categoryId).select('breadcrumb categoryReviews').lean();
  }
  if (!categoryRow) {
    categoryRow = await Category.findOne({ brandId, breadcrumbKey: key }).select('breadcrumb categoryReviews').lean();
  }
  if (categoryRow?.categoryReviews) {
    const r = categoryRow.categoryReviews;
    const fetchedAt = r.fetchedAt ? new Date(r.fetchedAt).getTime() : 0;
    if (fetchedAt && Date.now() - fetchedAt < TTL_MS) {
      return r;
    }
  }

  // Backward-compat fallback — read legacy Brand.categoryReviews[] subarray
  // (will be removed in a follow-up after backfill migrates entries to Category rows).
  const brand = await Brand.findById(brandId).select('name websiteUrl categoryReviews').lean();
  if (!brand) return null;

  const legacyEntry = (brand.categoryReviews || []).find(c => c.categoryKey === key);
  if (legacyEntry?.fetchedAt) {
    const fetchedAt = new Date(legacyEntry.fetchedAt).getTime();
    if (Date.now() - fetchedAt < TTL_MS) {
      // Lazy-promote the legacy entry into the Category collection on read
      // so we stop reading the legacy array next time. Fire-and-forget.
      promoteLegacyCategoryReviews({ brandId, breadcrumb, key, entry: legacyEntry })
        .catch(err => console.warn(`   ⚠️  legacy categoryReviews promotion failed: ${err.message}`));
      return legacyEntry;
    }
  }

  // Stale or missing — fire background fetch.
  fetchAndCache({
    brandId,
    brandName: brandName || brand.name,
    brandUrl:  brandUrl  || brand.websiteUrl,
    breadcrumb,
    categoryId
  }).catch(err => console.warn(`   ⚠️  categoryReviews background fetch failed: ${err.message}`));
  return null;
}

// Lazy migration: when we find a legacy Brand.categoryReviews[] entry on
// read, promote it into the Category collection so subsequent reads use
// the new path. Idempotent — only writes if the Category row doesn't
// already have categoryReviews populated.
async function promoteLegacyCategoryReviews({ brandId, breadcrumb, key, entry }) {
  const Category = require('../models/Category');
  const { findOrCreateCategoryTree } = Category;
  const leafId = await findOrCreateCategoryTree({ brandId, breadcrumb });
  if (!leafId) return;
  await Category.updateOne(
    { _id: leafId, $or: [{ categoryReviews: null }, { categoryReviews: { $exists: false } }] },
    { $set: { categoryReviews: {
      summary:     entry.summary || null,
      quotes:      entry.quotes  || [],
      rating:      entry.rating  ?? null,
      reviewCount: entry.reviewCount ?? null,
      sources:     entry.sources || [],
      fetchedAt:   entry.fetchedAt
    }}}
  );
}

async function fetchAndCache({ brandId, brandName, brandUrl, breadcrumb, categoryId }) {
  // brandId is passed for the COST LEDGER, not for the fetch itself: it is what
  // joins this call's CostLog rows back to the brand, the way every other row
  // does. Optional — a caller without one still gets rows, just unjoined.
  const fresh = await fetchCategoryReviews({ brandName, brandUrl, breadcrumb, brandId });
  if (!fresh) return null;

  // Phase 2a — write to Category row. Resolve the leaf id (find-or-create
  // the tree) and set categoryReviews directly.
  let leafId = categoryId;
  if (!leafId) {
    const { findOrCreateCategoryTree } = Category;
    leafId = await findOrCreateCategoryTree({ brandId, breadcrumb });
  }
  if (leafId) {
    await Category.updateOne(
      { _id: leafId },
      { $set: {
        categoryReviews: {
          summary:     fresh.summary,
          quotes:      fresh.quotes || [],
          rating:      fresh.rating ?? null,
          reviewCount: fresh.reviewCount ?? null,
          sources:     fresh.sources || [],
          fetchedAt:   new Date()
        },
        lastSeenAt: new Date()
      }}
    );
  }

  // Backward-compat — also write to legacy Brand.categoryReviews[] until
  // backfill migrates remaining consumers. Idempotent: replace existing
  // entry for this categoryKey.
  await Brand.updateOne(
    { _id: brandId },
    { $pull: { categoryReviews: { categoryKey: breadcrumbToKey(breadcrumb) } } }
  );
  await Brand.updateOne(
    { _id: brandId },
    { $push: {
      categoryReviews: {
        categoryKey: breadcrumbToKey(breadcrumb),
        breadcrumb,
        summary:     fresh.summary,
        quotes:      fresh.quotes || [],
        rating:      fresh.rating ?? null,
        reviewCount: fresh.reviewCount ?? null,
        sources:     fresh.sources || [],
        fetchedAt:   new Date()
      }
    }}
  );
  return fresh;
}

/**
 * CATEGORY_REVIEWS_STRUCTURE_SCHEMA — OpenAI strict json_schema for pass 2,
 * added with the 2026-08-19 Atlas migration of this call.
 *
 * NOT a translation of a Gemini `responseSchema`, because this call never had
 * one: the direct version asked only for `responseMimeType: 'application/json'`
 * and relied entirely on the prompt for shape. So this is a TIGHTENING — the
 * only difference in the RESPONSE CONTRACT. (It is not the only behavioural
 * difference overall: the TRANSPORT changed too — the direct call was exactly
 * one POST, while chatCompletion on this single-link role makes up to
 * MAX_ATTEMPTS (default 3) Atlas attempts plus one ledgered google-openai
 * direct-twin attempt, each writing its own CostLog row. Small, bounded,
 * documented at chatCompletion; ~$0.004/attempt worst case.) The schema
 * tightening is safe in the direction that
 * matters — an unparsable pass 2 is exactly the failure this path degrades on
 * (quotes and rating dropped, summary-only) — and every downstream read already
 * treats a missing field and an explicit null identically:
 * `typeof parsed.rating === 'number' ? ... : null`,
 * `typeof parsed.reviewCount === 'number' ? ... : null`, `parsed.summary || null`,
 * and keepVerbatimQuotes() returns [] for a non-array.
 *
 * SHAPE DELIBERATELY DIFFERS from the provider's REVIEWS_STRUCTURE_SCHEMA, which
 * is why this is not simply reusing structureReviewNarrative: that one asks for a
 * `ratings[]` ARRAY of every aggregate found and instructs the model to leave the
 * scalar `rating` null when it fills the array (the caller then runs
 * pickBestRating over it). This path reads ONLY the scalar `parsed.rating`, so
 * borrowing that prompt/schema pair would silently null out the star rating on
 * every category — the exact class of regression the numbers-first pass-1 prompt
 * comment warns about. Adopting multi-aggregate ratings HERE is a real
 * improvement and a separate, measured change; it is not a routing fix.
 *
 * Strict mode requires additionalProperties:false objects to list EVERY property
 * in `required` and expresses "may be absent" as "present but nullable" — same
 * translation rule, and same reasoning, as the provider's schema comment.
 */
const CATEGORY_REVIEWS_STRUCTURE_SCHEMA = {
  name: 'category_reviews_structure',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['quotes', 'rating', 'reviewCount', 'summary'],
    properties: {
      quotes: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['text', 'author', 'source', 'stage'],
          properties: {
            text:   { type: 'string' },
            author: { type: ['string', 'null'] },
            source: { type: ['string', 'null'] },
            stage:  { type: ['string', 'null'], enum: ['awareness', 'consideration', 'conversion', 'retention', 'conquest', null] }
          }
        }
      },
      rating:      { type: ['number', 'null'] },
      // 'number', NOT 'integer' (adversarial-review fix, 2026-08-19): the only
      // reader is `typeof parsed.reviewCount === 'number'`, which accepts
      // 4500.0 — but under strict decode an `integer` type rejects the ENTIRE
      // object on a float, so one "4.5k reviews" approximation would throw away
      // the quotes and rating too and cache the empty result for 30 days. The
      // old schemaless path kept the quotes and merely nulled a bad count;
      // match that failure isolation. (`ratings[].reviewCount` in the sibling
      // provider schema was already 'number' — the two top-levels were the odd
      // ones out.)
      reviewCount: { type: ['number', 'null'] },
      summary:     { type: ['string', 'null'] }
    }
  }
};

/**
 * structureCategoryNarrative — pass 2 of this file's two-pass fetch,
 * ATLAS-ROUTED (2026-08-19). The direct twin of
 * geminiSearchProvider.structureReviewNarrative, and deliberately a sibling
 * rather than a call into it (see CATEGORY_REVIEWS_STRUCTURE_SCHEMA for why the
 * shapes cannot be shared).
 *
 * WHY IT MAY MOVE WHEN PASS 1 MAY NOT: it sends no `tools` and reads no
 * `groundingMetadata`. The ATLAS GROUNDING PROBE comment in
 * providers/geminiSearchProvider.js is about grounded retrieval only.
 *
 * MODEL CHOICE — the SAME model as pass 1 (`GEMINI_MODEL`, default
 * 'gemini-2.5-flash', which atlasModelMap resolves to `google/gemini-2.5-flash`),
 * not the 6x-cheaper flash-lite 'review-text' role and not an upgrade. Identical
 * reasoning to structureReviewNarrative: (a) there is NO cost argument either
 * way — Atlas lists google/gemini-2.5-flash at input $0.30 / output $2.50 per M,
 * the same rate this call already paid direct; (b) this is a fussy
 * strict-JSON-over-a-narrative task, and the closest precedent in this codebase
 * (the 'ad-vision-qc' role) rejected a flash-tier model for one after a live
 * probe found it broke the requested shape. Revisit only with its own A/B.
 *
 * KNOWN, ACCEPTED, IMMATERIAL COST DELTA: the direct call set no thinking budget
 * here either (unlike pass 1, which pins thinkingBudget:0 via
 * GROUNDED_PASS1_CONFIG), so nothing changes on that axis; Atlas has no
 * pass-through for it on a google/* slug in any case, and costTracker's `atlas`
 * branch folds completion_tokens (thinking included) into the ledger correctly.
 *
 * @returns the parsed {quotes, rating, reviewCount, summary}, or null on any
 *          failure — the caller degrades to a summary-only result exactly as it
 *          did when the direct pass-2 call failed.
 */
async function structureCategoryNarrative({ brandName, breadcrumb, narrative, sourceDomains, ledger }) {
  const structPrompt =
    `Convert the following category-review narrative into structured JSON.\n\n` +
    `Brand:    ${brandName}\n` +
    `Category: ${breadcrumb}\n` +
    (sourceDomains.length ? `Sources cited: ${sourceDomains.join(', ')}\n` : '') +
    `\nNarrative:\n"""\n${narrative}\n"""\n\n` +
    `Return EXACTLY this shape (no commentary, no markdown):\n` +
    `{\n` +
    `  "quotes":      [ { "text": "...", "author": "name or null", "source": "domain or platform or null", "stage": "awareness|consideration|conversion|retention|conquest or null" } ],\n` +
    `  "rating":      <number 0-5 or null>,\n` +
    `  "reviewCount": <integer or null>,\n` +
    `  "summary":     "one sentence on overall sentiment about this category"\n` +
    `}\n` +
    `QUOTE RULES (strict):\n` +
    `- Each quote.text MUST be a verbatim substring of the narrative above, copied character-for-character. If the narrative does not contain any verbatim customer quotes (e.g. it only summarizes sentiment), return an EMPTY quotes array — do NOT chop the summary into clause-fragments and label them as quotes, do NOT paraphrase, do NOT invent.\n` +
    `- A real quote describes the customer's experience in their own voice (e.g. "best fishing shirt I've ever owned", "fits perfectly even on long offshore trips"). Meta-commentary about reviews ("category receives positive feedback", "reviewers note good comfort") is NOT a quote — exclude it.\n` +
    `- Acceptable to return zero quotes. Better to return none than fakes.`;

  let completion;
  try {
    completion = await chatCompletion(
      {
        stage: 'category_reviews',
        provider: 'google',
        model: GEMINI_MODEL,
        purposeTag: 'json_structure',
        brandId: ledger?.brandId ?? null,
        cacheKey: ledger?.cacheKey ?? null,
        visionImages: 0
      },
      {
        model: GEMINI_MODEL,
        response_format: { type: 'json_schema', json_schema: CATEGORY_REVIEWS_STRUCTURE_SCHEMA },
        messages: [{ role: 'user', content: structPrompt }],
        temperature: 0.1,
        max_tokens: GROUNDED_PASS2_MAX_TOKENS
      }
    );
  } catch (err) {
    // chatCompletion throws an already-CODED llmError when every chain candidate
    // fails — format that rather than re-classifying an axios-shaped error which
    // no longer exists on this path.
    console.warn(formatLlmLogLine(err && err.llmError ? err : makeLlmError({
      code: classifyLlmFailure({ message: err?.message }),
      // 'unknown', not 'atlas': this fallback only fires on a NON-coded throw,
      // and chatCompletion may have died on its google-openai direct twin —
      // stamping Atlas would hide a Google-side failure from the operator.
      provider: 'unknown', model: GEMINI_MODEL, role: 'category-reviews-structuring',
      providerMessage: err?.message,
      action: LLM_ACTIONS.GAVE_UP_PRODUCT,
      actionDetail: 'returned a partial result — narrative summary kept, quotes/rating/count dropped',
    })));
    return null;
  }

  const text = completion?.choices?.[0]?.message?.content || '';
  let parsed = null;
  try { parsed = JSON.parse(text); }
  catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch { /* fall through to null */ } }
  }
  if (!parsed) {
    console.warn(`   · categoryReviews: structuring produced no parsable JSON for "${breadcrumb}"`);
  }
  return parsed;
}

// Two-pass Gemini fetch (grounded search → JSON structuring).
// Same pattern as geminiSearchProvider.lookupBrandReviews / lookupProductReviews —
// including the SHARED ad-usable quote directive, imported rather than restated so
// the three retrieval prompts cannot drift apart.
async function fetchCategoryReviews({ brandName, brandUrl, breadcrumb, brandId = null }) {
  if (!isEnabled()) return null;
  if (!brandName || !breadcrumb) return null;

  const t0 = Date.now();
  // Linkage for the cost ledger, shared by BOTH passes. CostLog has no category
  // field, so the breadcrumb key travels as `cacheKey` — the same key the 30-day
  // Category cache is stored under, which makes the (stage, cacheKey) hit-rate
  // query meaningful for this path too.
  const ledger = { brandId, cacheKey: breadcrumbToKey(breadcrumb) || breadcrumb };

  // Pass 1 — grounded narrative
  // NUMBERS FIRST, QUOTES SECOND — see NARRATIVE_ORDER_NOTE in geminiSearchProvider.
  // Anything this prompt asks for LAST is the first thing a MAX_TOKENS truncation eats,
  // and that is exactly how the brand path silently lost its star ratings.
  const searchPrompt =
    `Use Google Search to research ${brandName}'s ${breadcrumb} category` +
    `${brandUrl ? ` (${brandUrl})` : ''}.\n\n` +
    `FIRST — this part must stay HONEST, not flattering: note an approximate average ` +
    `star rating (0-5) and review count if visible, naming the source, plus a ` +
    `one-sentence summary of how reviewers really feel about this category INCLUDING ` +
    `any recurring complaints. Rating and summary are internal signal, never ad copy. ` +
    `Write these BEFORE any quotes.\n\n` +
    `THEN surface up to ${LLM_QUOTE_CAP} SPECIFIC, DIRECT customer quotes (verbatim, in ` +
    // NO EXAMPLE PHRASINGS HERE, DELIBERATELY. This prompt used to illustrate a
    // "good" category quote with "best fishing shirt I've owned" and "their
    // performance shirts last forever" — a superlative and an absolute-durability
    // claim, i.e. exactly two of the classes AD_USABLE_QUOTE_DIRECTIVE (injected a
    // few lines below) tells the model to REJECT. A few-shot example outranks a rule
    // list in practice, so the prompt was teaching the model to break its own rules.
    // Keep this rationale in the comment: putting it in the prompt string re-seeds
    // the very phrases it removes.
    `quotation marks) that describe the category broadly rather than naming a ` +
    `specific SKU — describe how the category feels to wear or how it performed in ` +
    `real use. Pull from review aggregators (Trustpilot, Sitejabber), ` +
    `Reddit threads, YouTube category-overview reviews, and the brand's own ` +
    `collection page.\n\n` +
    `${AD_USABLE_QUOTE_DIRECTIVE}\n\n` +
    `For each quote, give the source platform, the author/handle if visible, and ` +
    `the funnel stage it serves.\n\n` +
    `Write naturally — do not format as JSON.`;

  let searchData;
  try {
    // LEDGERED 2026-08-19 (second pass). This was a bare axios.post: every
    // UGC/IG detect that missed the 30-day category cache billed Google — the
    // ~$0.035-per-request grounding surcharge included, which dwarfs the tokens
    // — and wrote NOTHING to CostLog, so the path read as free.
    //
    // STAYS ON THE DIRECT REST TRANSPORT, and that is proven, not assumed: it is
    // genuinely grounded (`tools: [{ google_search: {} }]` below), and the ATLAS
    // GROUNDING PROBE comment in providers/geminiSearchProvider.js records four
    // live probes showing Atlas rejects or silently drops every way of asking
    // for google_search on this model. Do not "finish the migration" by pointing
    // this at chatCompletion — re-probe live first.
    searchData = await trackedGenerate(
      { stage: 'category_reviews', purposeTag: 'grounded_search', grounded: true, ledger },
      {
        contents: [{ role: 'user', parts: [{ text: searchPrompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: GROUNDED_PASS1_CONFIG
      },
      GROUNDED_CALL_TIMEOUT_MS   // padded: a timeout throws away a call already paid for
    );
  } catch (err) {
    console.warn(formatLlmLogLine(makeLlmError({
      code: classifyLlmFailure({
        httpStatus: err.response?.status, errCode: err.code, message: err.message,
        body: err.response?.data,
      }),
      provider: 'google', model: GEMINI_MODEL, role: 'category-reviews',
      httpStatus: err.response?.status ?? null,
      requestId: extractRequestId(err.response?.data, err.response?.headers),
      providerMessage: err.response?.data?.error?.message || err.message,
      action: LLM_ACTIONS.GAVE_UP_PRODUCT,
      actionDetail: 'returned null — no category review signal; the caller continues without it',
    })));
    return null;
  }

  // `searchData` is the response BODY (trackedGenerate returns r.data — that is
  // what costTracker.extractUsage reads usageMetadata off), so there is no
  // `.data` hop here any more.
  const cand = searchData?.candidates?.[0];
  warnIfTruncated(cand, `categoryReviews pass 1 "${breadcrumb}"`);
  const narrative = (cand?.content?.parts || []).map(p => p.text || '').join(' ').trim();
  const sourceDomains = (cand?.groundingMetadata?.groundingChunks || [])
    .map(c => c.web?.uri && extractDomain(c.web.uri))
    .filter(Boolean)
    .filter((d, i, a) => a.indexOf(d) === i)
    .slice(0, 10);

  if (!narrative || narrative.length < 100) {
    console.log(`   · categoryReviews: no narrative for ${brandName} > ${breadcrumb}`);
    return { summary: null, quotes: [], rating: null, reviewCount: null, sources: sourceDomains };
  }

  // ── Pass 2: structure as JSON — ATLAS-ROUTED (2026-08-19, second pass) ──
  // Never grounded (it sends no `tools` and reads no groundingMetadata), so none
  // of the restriction above applies to it: this is the half that CAN move to
  // the gateway, and the same one that moved for brand/product reviews in the
  // first pass. See structureCategoryNarrative for the model-choice reasoning.
  const parsed = await structureCategoryNarrative({
    brandName, breadcrumb, narrative, sourceDomains, ledger
  });
  if (!parsed) {
    // ONE fallback where there used to be two IDENTICAL ones (transport failure
    // and unparsable content both returned exactly this object): the narrative
    // summary survives, quotes/rating/count are dropped. Behaviour unchanged.
    return { quotes: [], rating: null, reviewCount: null, summary: firstSentences(narrative, 2), sources: sourceDomains };
  }

  // Substring-validate quotes against the narrative — drop anything the model
  // fabricated by chopping the summary into clauses (the failure mode we hit on the
  // first smoke test). Match is whitespace-insensitive.
  //
  // ONE implementation, shared with the brand and product lookups: substring
  // validation against the narrative (≥15 chars, so 1-2 word clause-fragments like
  // "comfort" or "sun protection" are filtered out) AND the sentence-completeness
  // guard. This path previously carried its own copy of the substring check and
  // therefore had none of the completeness protection — the same mid-clause quote
  // that shipped on the brand path ("...keeping me cool in my") could ship here.
  const validatedQuotes = keepVerbatimQuotes(parsed.quotes, narrative, `categoryReviews "${breadcrumb}"`)
    .slice(0, LLM_QUOTE_CAP)
    // PROVENANCE. These clear the substring check above, so the text is a
    // verbatim slice of the narrative — but the NARRATIVE is LLM-written from
    // grounded web search, so the quote is not a customer's own words reaching
    // us first-hand: origin stays 'llm-web', verbatim stays false. scope
    // 'category' is the loosest of the three (a quote about the category, not
    // this product), so a consumer should prefer product- then brand-scoped
    // quotes over these. See docs/REVIEW_VENDORS.md §7.
    .map(q => Object.assign({}, q, {
      origin: 'llm-web',
      verbatim: false,
      scope: 'category'
    }));
  const droppedCount = (Array.isArray(parsed.quotes) ? parsed.quotes.length : 0) - validatedQuotes.length;
  if (droppedCount > 0) {
    console.log(`   · categoryReviews: dropped ${droppedCount} non-verbatim quote(s) for "${breadcrumb}"`);
  }

  const result = {
    quotes:      validatedQuotes,
    rating:      typeof parsed.rating === 'number' ? parsed.rating : null,
    reviewCount: typeof parsed.reviewCount === 'number' ? parsed.reviewCount : null,
    summary:     parsed.summary || null,
    sources:     sourceDomains
  };
  console.log(`   ✓ categoryReviews: ${result.quotes.length} quote(s)${result.rating != null ? ` · ${result.rating.toFixed(1)}★` : ''} for "${breadcrumb}" (${Date.now() - t0}ms)`);
  return result;
}

// Sentence-boundary truncation — replaces brittle .slice(0, 200) which
// cut mid-word. Returns up to N sentences from the start of the narrative.
function firstSentences(s, n = 2) {
  if (!s) return null;
  const sentences = String(s).match(/[^.!?]+[.!?]+(\s|$)/g) || [String(s)];
  return sentences.slice(0, n).join('').trim() || null;
}

function extractDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

module.exports = {
  maybeFetchCategoryReviewsCached, fetchCategoryReviews, isEnabled,
  // Exported for scripts/verifyGroundedGeminiLedger.js — same reason as
  // productDetailsService.fetchReviewSummary's export: a source-regex check on
  // fetchAndCache's own call to fetchCategoryReviews passed against a mutation
  // that dropped the linkage (`brandId: null` still matches
  // /fetchCategoryReviews\(\{[^}]*brandId[^}]*\}\)/). Only calling the real
  // function against stubbed Category/Brand models proves the CALLER — not
  // just the leaf function — actually threads brandId. Not a new public API.
  fetchAndCache
};
