// Phase 1.7c — multi-product / multi-tier comment posting.
//
// On a confident detect run, post one comment per high-confidence match
// using the appropriate template tier:
//
//   product_match    → product comment    (productName + productUrl + productReviews quote)
//   product_category → category comment   (breadcrumb + categoryUrl  + categoryReviews quote)
//   brand_match      → brand comment      (brandName + brandUrl       + brandReviews quote)
//
// Progressive fallback ensures we NEVER post a quoteless comment:
//   product_match → if productReviews quote missing AND brand has fallbackToCategory:
//                   re-render as category comment with categoryReviews
//                 → if also missing AND brand has fallbackToBrand:
//                   re-render as brand comment with brandReviews
//                 → if STILL missing, skip
//   product_category → if categoryReviews missing AND fallbackToBrand:
//                      re-render as brand comment with brandReviews
//                    → if still missing, skip
//   brand_match → if brandReviews missing, skip (no further fallback)
//
// Per-Media idempotency is per-product (media.metadata.commentReplies[]
// tracks which productIndex values have been commented on). Re-running
// detect on a Media that produced new matches surfaces those without
// double-commenting on existing ones.
//
// Daily cap counts COMMENTS posted across all Media for the brand today
// (was: count of Media commented on). Per-Media cap limits how many
// comments fire from a single detect run.

const axios = require('axios');

const Brand = require('../models/Brand');
const Media = require('../models/Media');
const IntegrationCredential = require('../models/IntegrationCredential');
const { decrypt } = require('./integrationCryptoService');
const { hydrateMatch } = require('./productMatchHydration');

const META_API_VERSION = process.env.META_API_VERSION || 'v19.0';
const META_GRAPH_ROOT  = `https://graph.facebook.com/${META_API_VERSION}`;
const COMMENT_CHAR_LIMIT = 280;

// Renders a comment from a template + variables. Strips unresolved
// placeholders so we never post literal "{productUrl}".
function renderTemplate(template, vars) {
  return String(template || '')
    .replace(/\{(productName|productUrl|productQuote|breadcrumb|categoryUrl|categoryQuote|brandName|brandUrl|brandQuote)\}/g, (_, key) => vars[key] || '')
    .replace(/\s+/g, ' ')
    .trim();
}

// First quote from a reviews snapshot, truncated to a safe length so the
// rendered comment fits IG's 280-char ceiling alongside URL + name.
function pickQuote(reviews, maxChars = 140) {
  const q = reviews?.quotes?.[0]?.text;
  if (!q || typeof q !== 'string') return null;
  const trimmed = q.trim().replace(/^["“]|["”]$/g, '');   // strip surrounding quotes — template re-adds them
  if (trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, maxChars - 1).trimEnd() + '…';
}

// Count comments posted today across all Media for this brand. Replaces
// the legacy "Media commented on today" count — a single multi-product
// Media now contributes multiple comments to the cap.
async function commentsPostedToday(brandId) {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const result = await Media.aggregate([
    { $match: { brandId, 'metadata.commentReplies.postedAt': { $gte: startOfDay } } },
    { $project: {
        replies: {
          $filter: {
            input: { $ifNull: ['$metadata.commentReplies', []] },
            as:    'r',
            cond:  { $gte: ['$$r.postedAt', startOfDay] }
          }
        }
      }
    },
    { $project: { count: { $size: '$replies' } } },
    { $group: { _id: null, total: { $sum: '$count' } } }
  ]);
  return result[0]?.total || 0;
}

// Has this productIndex on this Media already been commented on?
function alreadyCommented(media, productIndex) {
  const replies = media?.metadata?.commentReplies || [];
  return replies.some(r => r && r.productIndex != null && String(r.productIndex) === String(productIndex));
}

// Phase 1.7c — main entry point. Iterates productMatch.matches and posts
// one comment per high-confidence match (with fallback). Keeps the legacy
// signature so pipelines/detect.js doesn't need updating; extracts
// matches[] from productMatch when present.
async function maybePostMatchReply({ media, productMatch }) {
  try {
    return await tryPostMatchReplies({ media, productMatch });
  } catch (err) {
    console.warn(`   ⚠️  comment-reply unexpected error: ${err.message}`);
    return { posted: 0, results: [], reason: `unexpected: ${err.message}` };
  }
}

async function tryPostMatchReplies({ media, productMatch }) {
  if (!media || !productMatch) return { posted: 0, results: [], reason: 'missing inputs' };
  if (media.source !== 'instagram') return { posted: 0, results: [], reason: 'not an IG-sourced Media' };
  if (!media.brandId) return { posted: 0, results: [], reason: 'Media has no brandId' };

  // Brand opt-in.
  const brand = await Brand.findById(media.brandId)
    .select('name websiteUrl commentReply')
    .lean();
  if (!brand?.commentReply?.enabled) {
    return { posted: 0, results: [], reason: 'comment-reply disabled for brand' };
  }

  // Resolve credential — prefer the IG account whose username matches
  // the post's creatorHandle; fall back to first active.
  const creds = await IntegrationCredential.find({
    brandId: media.brandId, type: 'instagram', status: 'active',
    igUserId: { $exists: true, $ne: null }
  });
  if (!creds.length) return { posted: 0, results: [], reason: 'no active IG credential' };
  const handle = (media.metadata?.creatorHandle || '').toLowerCase();
  const cred = creds.find(c => (c.igUsername || '').toLowerCase() === handle) || creds[0];

  let token;
  try { token = decrypt(cred.accessTokenEnc); }
  catch (err) { return { posted: 0, results: [], reason: `token decrypt failed: ${err.message}` }; }

  // Daily cap snapshot at start (re-checked per comment to avoid races).
  const dailyCap   = brand.commentReply.dailyCap   ?? 25;
  const perMediaCap = brand.commentReply.perMediaCap ?? 3;

  // Collect commentable matches. matches[] is the new shape; legacy
  // single-result is wrapped in [productMatch] for backward compat.
  const rawMatches = Array.isArray(productMatch.matches) && productMatch.matches.length
    ? productMatch.matches
    : (productMatch.identification ? [productMatch] : []);

  // Phase 2g — hydrate every match from canonical FK targets BEFORE the
  // isCommentable filter, since the filter reads brandCategory.url and
  // identification.details.url which now live on Category / CatalogProduct.
  const matches = await Promise.all(rawMatches.map(m => hydrateMatch(m)));

  const commentable = matches.filter(m => isCommentable(m));
  if (!commentable.length) {
    return { posted: 0, results: [], reason: 'no commentable matches' };
  }

  // Per-comment loop. Stops at perMediaCap or dailyCap.
  const results = [];
  let postedThisRun = 0;
  for (const m of commentable) {
    if (perMediaCap > 0 && postedThisRun >= perMediaCap) {
      results.push({ productIndex: m.productIndex, posted: false, reason: 'per-Media cap reached this run' });
      break;
    }
    if (alreadyCommented(media, m.productIndex)) {
      results.push({ productIndex: m.productIndex, posted: false, reason: 'already commented on this productIndex' });
      continue;
    }
    if (dailyCap > 0) {
      const todayCount = await commentsPostedToday(media.brandId);
      if (todayCount >= dailyCap) {
        results.push({ productIndex: m.productIndex, posted: false, reason: 'daily cap reached', todayCount, dailyCap });
        break;
      }
    }

    const result = await tryPostOneComment({ media, match: m, brand, cred, token });
    results.push(result);
    if (result.posted) {
      postedThisRun++;
      await stampCommentReply(media._id, {
        productIndex: m.productIndex,
        commentLevel: result.commentLevel,
        commentId:    result.commentId,
        text:         result.text,
        postedAt:     new Date()
      });
    }
  }

  console.log(`💬 IG comment-reply: posted ${postedThisRun} comment(s) for ${media.externalId} from ${commentable.length} commentable match(es)`);
  return { posted: postedThisRun, results };
}

// Decide whether a match qualifies for a comment.
// product_match    — needs a productUrl
// product_category — needs a brandCategory.url
// brand_match      — needs a brand websiteUrl (resolved at render time)
function isCommentable(match) {
  if (!match) return false;
  if (match.outcome === 'product_match') {
    return !!(match.identification?.details?.url || match.catalogMatch?.product?.productUrl);
  }
  if (match.outcome === 'product_category') {
    return !!match.brandCategory?.url;
  }
  if (match.outcome === 'brand_match') {
    return true;   // brand_match always has a brand homepage fallback
  }
  return false;
}

// Build + post a single comment with progressive fallback. Returns
//   { posted, commentId, text, commentLevel, reason }
async function tryPostOneComment({ media, match, brand, cred, token }) {
  const fallbackToCategory = brand.commentReply.fallbackToCategory !== false;
  const fallbackToBrand    = brand.commentReply.fallbackToBrand    !== false;
  const productIndex = match.productIndex;

  // Try template tiers in order based on outcome + fallback rules.
  const attempts = [];
  if (match.outcome === 'product_match') {
    attempts.push('product');
    if (fallbackToCategory) attempts.push('category');
    if (fallbackToBrand)    attempts.push('brand');
  } else if (match.outcome === 'product_category') {
    attempts.push('category');
    if (fallbackToBrand) attempts.push('brand');
  } else if (match.outcome === 'brand_match') {
    attempts.push('brand');
  }

  for (const level of attempts) {
    const rendered = renderForTier({ level, match, brand });
    if (!rendered.text) continue;        // missing data for this tier; try next

    if (rendered.text.length > COMMENT_CHAR_LIMIT) {
      console.warn(`   ⚠️  comment-reply[${productIndex}/${level}] rendered ${rendered.text.length} chars (>280); skipping this tier`);
      continue;
    }

    // POST to IG Graph API
    let resp;
    try {
      resp = await axios.post(
        `${META_GRAPH_ROOT}/${media.externalId}/comments`,
        null,
        { params: { message: rendered.text, access_token: token }, timeout: 15000 }
      );
    } catch (err) {
      const detail = err.response?.data?.error?.message || err.message;
      console.warn(`   ⚠️  comment-reply[${productIndex}/${level}] POST failed: ${detail}`);
      return { productIndex, posted: false, reason: `Meta error: ${detail}` };
    }

    const commentId = resp.data?.id || null;
    console.log(`💬 comment-reply[${productIndex}/${level}] posted on ${media.externalId} → ${commentId}: "${rendered.text}"`);
    return {
      productIndex,
      posted:       true,
      commentId,
      commentLevel: level,
      text:         rendered.text
    };
  }

  return { productIndex, posted: false, reason: 'no tier had usable data (no quote, no URL, or all skipped)' };
}

// Render a comment for a specific tier. Returns { text } or { text: null }
// if this tier doesn't have the data it needs (caller falls through to
// the next tier in the chain).
function renderForTier({ level, match, brand }) {
  const ident = match.identification || {};
  const brandName = brand.name || ident.brand || '';

  if (level === 'product') {
    const productUrl = ident.details?.url || match.catalogMatch?.product?.productUrl;
    const productName = ident.productName || match.catalogMatch?.product?.title || '';
    const productQuote = pickQuote(match.productReviews);
    if (!productUrl || !productQuote) return { text: null };
    return {
      text: renderTemplate(brand.commentReply.templateProduct || brand.commentReply.template, {
        productUrl, productName, brandName, productQuote
      })
    };
  }

  if (level === 'category') {
    const categoryUrl = match.brandCategory?.url;
    const breadcrumb  = match.brandCategory?.breadcrumb || '';
    const categoryQuote = pickQuote(match.categoryReviews);
    if (!categoryUrl || !categoryQuote) return { text: null };
    return {
      text: renderTemplate(brand.commentReply.templateCategory, {
        categoryUrl, breadcrumb, brandName, categoryQuote
      })
    };
  }

  if (level === 'brand') {
    const brandUrl = brand.websiteUrl || match.identification?.details?.url;
    const brandQuote = pickQuote(match.brandReviews);
    if (!brandUrl || !brandQuote) return { text: null };
    return {
      text: renderTemplate(brand.commentReply.templateBrand, {
        brandUrl, brandName, brandQuote
      })
    };
  }

  return { text: null };
}

async function stampCommentReply(mediaId, entry) {
  await Media.updateOne(
    { _id: mediaId },
    { $push: { 'metadata.commentReplies': entry } }
  );
}

module.exports = { maybePostMatchReply };
