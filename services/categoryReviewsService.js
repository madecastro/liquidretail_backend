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
// Same pattern as geminiSearchProvider.lookupBrandReviews / lookupProductReviews.
async function fetchCategoryReviews({ brandName, brandUrl, breadcrumb }) {
  if (!isEnabled()) return null;
  if (!brandName || !breadcrumb) return null;

  const t0 = Date.now();

  // Pass 1 — grounded narrative
  const searchPrompt =
    `Use Google Search to find what real customers say about ${brandName}'s ` +
    `${breadcrumb} category${brandUrl ? ` (${brandUrl})` : ''}. ` +
    `Surface 4-6 SPECIFIC, DIRECT customer quotes (verbatim, in quotation marks) ` +
    `that mention the category broadly — phrases like "best fishing shirt I've ` +
    `owned" or "their performance shirts last forever" — NOT specific SKU names. ` +
    `Pull from review aggregators (Trustpilot, Sitejabber), Reddit threads, ` +
    `YouTube category-overview reviews, and the brand's own collection page. ` +
    `For each quote, name the source platform and author/handle if visible. ` +
    `Also note an approximate average star rating (0-5) and review count if you ` +
    `can see them, plus a one-sentence summary of how reviewers feel about this ` +
    `category specifically. Write naturally — do not format as JSON.`;

  let searchRes;
  try {
    searchRes = await axios.post(
      `${ENDPOINT}?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,
      {
        contents: [{ role: 'user', parts: [{ text: searchPrompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 1500 }
      },
      { timeout: 30000 }
    );
  } catch (err) {
    console.warn(`   ⚠️  categoryReviews search failed: ${err.message}`);
    return null;
  }

  const cand = searchRes.data?.candidates?.[0];
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
    `  "quotes":      [ { "text": "...", "author": "name or null", "source": "domain or platform or null" }, 3-6 entries ],\n` +
    `  "rating":      <number 0-5 or null>,\n` +
    `  "reviewCount": <integer or null>,\n` +
    `  "summary":     "one sentence on overall sentiment about this category"\n` +
    `}\n` +
    `Use direct quotes verbatim from the narrative; do NOT paraphrase or invent quotes.`;

  let structRes;
  try {
    structRes = await axios.post(
      `${ENDPOINT}?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,
      {
        contents: [{ role: 'user', parts: [{ text: structPrompt }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 1200,
          responseMimeType: 'application/json'
        }
      },
      { timeout: 30000 }
    );
  } catch (err) {
    console.warn(`   ⚠️  categoryReviews structuring failed: ${err.message}`);
    return { quotes: [], rating: null, reviewCount: null, summary: narrative.slice(0, 200), sources: sourceDomains };
  }

  const text = (structRes.data?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
  let parsed = null;
  try { parsed = JSON.parse(text); }
  catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
  }
  if (!parsed) {
    return { quotes: [], rating: null, reviewCount: null, summary: narrative.slice(0, 200), sources: sourceDomains };
  }

  const result = {
    quotes:      Array.isArray(parsed.quotes) ? parsed.quotes.slice(0, 6).filter(q => q?.text) : [],
    rating:      typeof parsed.rating === 'number' ? parsed.rating : null,
    reviewCount: typeof parsed.reviewCount === 'number' ? parsed.reviewCount : null,
    summary:     parsed.summary || null,
    sources:     sourceDomains
  };
  console.log(`   ✓ categoryReviews: ${result.quotes.length} quote(s)${result.rating != null ? ` · ${result.rating.toFixed(1)}★` : ''} for "${breadcrumb}" (${Date.now() - t0}ms)`);
  return result;
}

function extractDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

module.exports = { maybeFetchCategoryReviewsCached, fetchCategoryReviews, isEnabled };
