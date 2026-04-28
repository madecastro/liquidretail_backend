// Auto-reply with a comment on the brand's own IG-sourced post when
// detect produces a confident product_match. Per-brand opt-in
// (Brand.commentReply.enabled), template-driven copy, daily cap to
// prevent at-scale spamming.
//
// Idempotency: Media.metadata.commentReplyAt is set on success and
// blocks repeat replies on the same post. Re-running detect on a
// Media that's already been commented on no-ops.
//
// Tier ordering (the firing function below):
//   1. Source check — Media must come from Instagram.
//   2. Brand opt-in.
//   3. Match outcome must be 'product_match' AND have a productUrl
//      to link to (no point commenting "Shop this look:" with no URL).
//   4. Daily cap.
//   5. Idempotency.
//   6. POST the comment via Graph API.

const axios = require('axios');

const Brand = require('../models/Brand');
const Media = require('../models/Media');
const IntegrationCredential = require('../models/IntegrationCredential');
const { decrypt } = require('./integrationCryptoService');

const META_API_VERSION = process.env.META_API_VERSION || 'v19.0';
const META_GRAPH_ROOT  = `https://graph.facebook.com/${META_API_VERSION}`;

// Renders a comment from the brand's template + match data. Strips
// unresolved placeholders so we never post literal "{productUrl}".
function renderTemplate(template, vars) {
  return String(template || '')
    .replace(/\{(productUrl|productName|brandName)\}/g, (_, key) => vars[key] || '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Count today's auto-replies on this brand. Compares against daily cap.
async function repliesToday(brandId) {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  return Media.countDocuments({
    brandId,
    'metadata.commentReplyAt': { $gte: startOfDay }
  });
}

// Fire-and-forget entry from the detect pipeline. Returns
//   { posted: true, commentId } on success
//   { posted: false, reason } on any guard / failure.
// All errors are caught — never throws — so the detect run never
// fails because of an opportunistic auto-comment.
async function maybePostMatchReply({ media, productMatch }) {
  try {
    return await tryPostMatchReply({ media, productMatch });
  } catch (err) {
    console.warn(`   ⚠️  comment-reply unexpected error: ${err.message}`);
    return { posted: false, reason: `unexpected: ${err.message}` };
  }
}

async function tryPostMatchReply({ media, productMatch }) {
  if (!media || !productMatch) return { posted: false, reason: 'missing inputs' };
  if (media.source !== 'instagram') return { posted: false, reason: 'not an IG-sourced Media' };
  if (productMatch.outcome !== 'product_match') return { posted: false, reason: `outcome=${productMatch.outcome}` };

  const productUrl = productMatch.identification?.details?.url
                  || productMatch.catalogMatch?.product?.productUrl
                  || null;
  if (!productUrl) return { posted: false, reason: 'no productUrl on identification' };

  // Idempotency — already commented on this post?
  if (media.metadata?.commentReplyAt) {
    return { posted: false, reason: 'already commented on this Media' };
  }

  // Brand opt-in.
  if (!media.brandId) return { posted: false, reason: 'Media has no brandId' };
  const brand = await Brand.findById(media.brandId)
    .select('name commentReply')
    .lean();
  if (!brand?.commentReply?.enabled) {
    return { posted: false, reason: 'comment-reply disabled for brand' };
  }

  // Daily cap.
  const cap = brand.commentReply.dailyCap ?? 25;
  if (cap > 0) {
    const todayCount = await repliesToday(media.brandId);
    if (todayCount >= cap) {
      console.log(`   · comment-reply: daily cap reached for brand ${brand.name} (${todayCount}/${cap})`);
      return { posted: false, reason: 'daily cap reached', todayCount, cap };
    }
  }

  // Resolve credential — match by IG account that posted this Media.
  // Today the post sync writes media.metadata.creatorHandle but the
  // canonical link is the credential whose igUsername matches OR which
  // owns the IG account this externalId came from. Simplest: pick any
  // active credential for this brand that has igUserId set; if multi-
  // page, prefer the one whose username matches the post's creatorHandle.
  const creds = await IntegrationCredential.find({
    brandId: media.brandId, type: 'instagram', status: 'active',
    igUserId: { $exists: true, $ne: null }
  });
  if (!creds.length) return { posted: false, reason: 'no active IG credential' };
  const handle = (media.metadata?.creatorHandle || '').toLowerCase();
  const cred = creds.find(c => (c.igUsername || '').toLowerCase() === handle) || creds[0];

  // Render the comment.
  const text = renderTemplate(brand.commentReply.template, {
    productUrl,
    productName: productMatch.identification?.productName || productMatch.catalogMatch?.product?.title || '',
    brandName:   brand.name || ''
  });
  if (!text) return { posted: false, reason: 'rendered comment is empty' };
  if (text.length > 280) {
    // Hard cap on comment length — IG truncates anyway and keeping it
    // tight avoids accidental novel-comments via misconfigured templates.
    return { posted: false, reason: 'rendered comment too long (>280 chars)' };
  }

  let token;
  try { token = decrypt(cred.accessTokenEnc); }
  catch (err) { return { posted: false, reason: `token decrypt failed: ${err.message}` }; }

  // POST the comment via Graph API.
  // Endpoint: POST /{ig-media-id}/comments?message=<text>&access_token=<token>
  let response;
  try {
    response = await axios.post(
      `${META_GRAPH_ROOT}/${media.externalId}/comments`,
      null,
      { params: { message: text, access_token: token }, timeout: 15000 }
    );
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    console.warn(`   ⚠️  comment-reply POST failed for ${media.externalId}: ${detail}`);
    return { posted: false, reason: `Meta error: ${detail}` };
  }

  const commentId = response.data?.id || null;
  // Stamp idempotency on Media so we never double-comment.
  await Media.updateOne(
    { _id: media._id },
    { $set: {
        'metadata.commentReplyAt': new Date(),
        'metadata.commentReplyId': commentId,
        'metadata.commentReplyText': text
      }
    }
  );
  console.log(`💬 comment-reply posted on ${media.externalId} → comment=${commentId}: "${text}"`);
  return { posted: true, commentId, text };
}

module.exports = { maybePostMatchReply };
