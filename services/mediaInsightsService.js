// Per-Media insights refresh — pulls fresh post analytics + inbound
// comments for one Media at a time, on operator demand.
//
// Two complementary operations:
//   refreshInsightsForMedia(mediaId)  — re-pulls like_count /
//      comments_count + IG insights metrics, writes to
//      Media.platformStats. Same shape postSyncService uses at
//      ingest, just refreshable for ageing posts.
//   fetchCommentsForMedia(mediaId)    — pulls /{ig-media-id}/comments
//      and upserts Comment docs by (mediaId, externalId). V1 fetches
//      top-level comments only; reply ingestion lands later when
//      threaded UI surfaces.
//
// Runs as in-process foreground today (single-Media refresh from a
// detail-page button). Bulk refresh across a brand is exposed but
// rate-limit-aware: serial per credential, hard cap to keep within
// IG's per-app token budget.

const axios = require('axios');

const Media = require('../models/Media');
const Comment = require('../models/Comment');
const IntegrationCredential = require('../models/IntegrationCredential');
const { decrypt } = require('./integrationCryptoService');

const META_API_VERSION = process.env.META_API_VERSION || 'v19.0';
const META_GRAPH_ROOT  = `https://graph.facebook.com/${META_API_VERSION}`;

const POST_BASIC_FIELDS = ['id', 'media_type', 'like_count', 'comments_count', 'timestamp'].join(',');

const INSIGHTS_METRICS_FEED  = ['impressions', 'reach', 'engagement', 'saved'];
const INSIGHTS_METRICS_REEL  = ['reach', 'plays', 'total_interactions', 'likes', 'comments', 'shares', 'saved'];
const INSIGHTS_METRICS_VIDEO = ['impressions', 'reach', 'saved', 'video_views'];

const COMMENT_FIELDS = ['id', 'text', 'timestamp', 'username', 'from', 'like_count'].join(',');

// Hard cap on comments per fetch — IG returns 50/page; cap pagination
// at 10 pages so a single high-engagement post doesn't burn the token
// budget.
const COMMENT_PAGE_SIZE = 50;
const COMMENT_MAX_PAGES = 10;

// ── Public API ───────────────────────────────────────────────────────

async function refreshInsightsForMedia(mediaId) {
  const media = await Media.findById(mediaId);
  if (!media) return { ok: false, reason: 'media not found' };
  if (media.source !== 'instagram') {
    return { ok: false, reason: `unsupported source: ${media.source}` };
  }
  if (!media.externalId) return { ok: false, reason: 'media has no externalId' };

  const cred = await findCredForMedia(media);
  if (!cred) return { ok: false, reason: 'no active Instagram credential for this brand' };
  const token = decrypt(cred.accessTokenEnc);

  const basic = await fetchPostBasic(media.externalId, token);
  if (!basic) return { ok: false, reason: 'failed to fetch post basics (auth or post deleted)' };

  const insights = await fetchPostInsights(media.externalId, basic.media_type, token);
  const stats = buildPlatformStats(basic, insights, basic.media_type);

  // Merge over existing — don't wipe fields we couldn't refresh.
  media.platformStats = Object.assign({}, media.platformStats || {}, stats);
  await media.save();

  return { ok: true, stats: media.platformStats };
}

async function fetchCommentsForMedia(mediaId) {
  const media = await Media.findById(mediaId);
  if (!media) return { ok: false, reason: 'media not found' };
  if (media.source !== 'instagram') {
    return { ok: false, reason: `unsupported source: ${media.source}` };
  }

  const cred = await findCredForMedia(media);
  if (!cred) return { ok: false, reason: 'no active Instagram credential for this brand' };
  const token = decrypt(cred.accessTokenEnc);

  let url = `${META_GRAPH_ROOT}/${media.externalId}/comments`;
  let params = { fields: COMMENT_FIELDS, limit: COMMENT_PAGE_SIZE, access_token: token };
  let pages = 0;
  let fetched = 0;
  let upserted = 0;

  while (url && pages < COMMENT_MAX_PAGES) {
    let res;
    try {
      res = await axios.get(url, { params, timeout: 15000 });
    } catch (err) {
      // 100 = comments unavailable for this post type, 10 = scope missing.
      // Surface to the operator rather than silently passing.
      const apiErr = err.response?.data?.error?.message || err.message;
      return { ok: false, reason: `IG comments fetch failed: ${apiErr}`, fetched, upserted };
    }

    const rows = res.data?.data || [];
    fetched += rows.length;

    for (const c of rows) {
      try {
        await Comment.findOneAndUpdate(
          { mediaId: media._id, externalId: String(c.id) },
          {
            mediaId:        media._id,
            brandId:        media.brandId,
            advertiserId:   media.advertiserId,
            source:         'instagram',
            externalId:     String(c.id),
            text:           String(c.text || ''),
            authorUsername: c.username || c.from?.username || null,
            authorId:       c.from?.id || null,
            likeCount:      typeof c.like_count === 'number' ? c.like_count : 0,
            postedAt:       c.timestamp ? new Date(c.timestamp) : null,
            parentExternalId: null,
            fetchedAt:      new Date()
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        upserted++;
      } catch (err) {
        // Per-comment failures don't abort the whole fetch.
        console.warn(`⚠️  comment upsert failed (${c.id}): ${err.message}`);
      }
    }

    // Cursor pagination — IG returns paging.next as a fully-formed URL.
    const nextUrl = res.data?.paging?.next || null;
    if (!nextUrl) break;
    url = nextUrl;
    params = undefined; // next URL already carries access_token
    pages++;
  }

  // Sync the comment count on Media so it stays consistent with the
  // collection. IG's comments_count includes replies, but we count
  // top-level only for now — close enough for an in-app readout.
  const total = await Comment.countDocuments({ mediaId: media._id });
  media.platformStats = Object.assign({}, media.platformStats || {}, { comments: total });
  await media.save();

  return { ok: true, fetched, upserted, totalStored: total };
}

// ── Internals ───────────────────────────────────────────────────────

async function findCredForMedia(media) {
  return IntegrationCredential.findOne({
    brandId: media.brandId,
    type:    'instagram',
    status:  'active'
  }).lean();
}

async function fetchPostBasic(externalId, token) {
  try {
    const res = await axios.get(`${META_GRAPH_ROOT}/${externalId}`, {
      params:  { fields: POST_BASIC_FIELDS, access_token: token },
      timeout: 12000
    });
    return res.data || null;
  } catch (err) {
    return null;
  }
}

async function fetchPostInsights(externalId, mediaType, token) {
  const metrics = mediaType === 'REEL'  ? INSIGHTS_METRICS_REEL
                : mediaType === 'VIDEO' ? INSIGHTS_METRICS_VIDEO
                :                         INSIGHTS_METRICS_FEED;
  try {
    const res = await axios.get(`${META_GRAPH_ROOT}/${externalId}/insights`, {
      params:  { metric: metrics.join(','), access_token: token },
      timeout: 12000
    });
    const out = {};
    for (const row of (res.data?.data || [])) {
      const v = row.values?.[0]?.value;
      if (typeof v === 'number') out[row.name] = v;
    }
    return out;
  } catch (_) {
    return null;
  }
}

function buildPlatformStats(post, insights, mediaType) {
  const isVideo = mediaType === 'VIDEO' || mediaType === 'REEL';
  const stats = {
    likes:      typeof post.like_count     === 'number' ? post.like_count     : null,
    comments:   typeof post.comments_count === 'number' ? post.comments_count : null,
    views:      isVideo
                  ? (insights?.plays ?? insights?.video_views ?? null)
                  : (insights?.impressions ?? null),
    reach:      insights?.reach ?? null,
    saves:      insights?.saved ?? null,
    shares:     insights?.shares ?? null,
    engagement: insights?.engagement ?? insights?.total_interactions ?? null,
    fetchedAt:  new Date()
  };
  const out = {};
  for (const [k, v] of Object.entries(stats)) {
    if (v != null) out[k] = v;
  }
  return out;
}

module.exports = {
  refreshInsightsForMedia,
  fetchCommentsForMedia
};
