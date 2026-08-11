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

const axios = require('axios');
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
  warnIfTruncated
} = require('./providers/geminiSearchProvider');

const GEMINI_MODEL = process.env.GEMINI_SEARCH_MODEL || 'gemini-2.5-flash';
const ENDPOINT     = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
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
  const fresh = await fetchCategoryReviews({ brandName, brandUrl, breadcrumb });
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

// Two-pass Gemini fetch (grounded search → JSON structuring).
// Same pattern as geminiSearchProvider.lookupBrandReviews / lookupProductReviews —
// including the SHARED ad-usable quote directive, imported rather than restated so
// the three retrieval prompts cannot drift apart.
async function fetchCategoryReviews({ brandName, brandUrl, breadcrumb }) {
  if (!isEnabled()) return null;
  if (!brandName || !breadcrumb) return null;

  const t0 = Date.now();

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

  let searchRes;
  try {
    searchRes = await axios.post(
      `${ENDPOINT}?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,
      {
        contents: [{ role: 'user', parts: [{ text: searchPrompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: GROUNDED_PASS1_CONFIG
      },
      { timeout: GROUNDED_CALL_TIMEOUT_MS }   // padded: a timeout throws away a call already paid for
    );
  } catch (err) {
    console.warn(`   ⚠️  categoryReviews search failed: ${err.message}`);
    return null;
  }

  const cand = searchRes.data?.candidates?.[0];
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

  // Pass 2 — structure as JSON
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

  let structRes;
  try {
    structRes = await axios.post(
      `${ENDPOINT}?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,
      {
        contents: [{ role: 'user', parts: [{ text: structPrompt }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: GROUNDED_PASS2_MAX_TOKENS,
          responseMimeType: 'application/json'
        }
      },
      { timeout: GROUNDED_CALL_TIMEOUT_MS }   // padded: a timeout throws away a call already paid for
    );
  } catch (err) {
    console.warn(`   ⚠️  categoryReviews structuring failed: ${err.message}`);
    return { quotes: [], rating: null, reviewCount: null, summary: firstSentences(narrative, 2), sources: sourceDomains };
  }

  const text = (structRes.data?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
  let parsed = null;
  try { parsed = JSON.parse(text); }
  catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
  }
  if (!parsed) {
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

module.exports = { maybeFetchCategoryReviewsCached, fetchCategoryReviews, isEnabled };
