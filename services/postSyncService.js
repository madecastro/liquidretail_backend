// Pulls recent posts/reels from a Brand's connected Instagram Business
// account, mirrors the media into Cloudinary (Meta CDN URLs expire),
// creates a Media doc per new post, and enqueues a DetectRun so the
// existing detect pipeline runs on it unchanged.
//
// Idempotency: Media.findOne({ source: 'instagram', externalId: <ig-id> })
// is the dedup key. Posts already ingested are skipped — we don't
// re-enqueue DetectRuns for them. Re-running this sync after a few
// hours will only ingest posts published since the last sync.
//
// Carousels: V1 takes only the first child item (image or video) as
// the primary media. Multi-asset detect runs are a V2 concern.

const axios = require('axios');

const IntegrationCredential = require('../models/IntegrationCredential');
const Brand = require('../models/Brand');
const Media = require('../models/Media');
const DetectRun = require('../models/DetectRun');
const { decrypt } = require('./integrationCryptoService');
const { uploadUrlToCloudinary } = require('./cloudinaryService');

const META_API_VERSION = process.env.META_API_VERSION || 'v19.0';
const META_GRAPH_ROOT  = `https://graph.facebook.com/${META_API_VERSION}`;

// Default page size + cap. IG Business returns ~25 by default; we ask
// for 50. Hard cap of 50 per call keeps the foreground request inside
// a reasonable HTTP timeout (mirroring + upserts are the slow part).
const DEFAULT_LIMIT = 50;

const POST_FIELDS = [
  'id', 'media_type', 'media_url', 'thumbnail_url', 'permalink',
  'caption', 'timestamp', 'username', 'is_comment_enabled'
].join(',');
const CHILD_FIELDS = ['id', 'media_type', 'media_url', 'thumbnail_url'].join(',');

async function syncPosts(brandId, options = {}) {
  const limit = Math.min(options.limit || DEFAULT_LIMIT, 50);
  // V2 #4 — when called from the scheduler, options.dailyDetectRunCap
  // is set so we throttle DetectRuns. Manual sync passes null and
  // every new post enqueues a run.
  const dailyCap = options.dailyDetectRunCap == null ? null : Math.max(0, Number(options.dailyDetectRunCap) || 0);
  const trigger  = options.trigger || 'instagram-sync';
  const t0 = Date.now();

  const cred = await IntegrationCredential.findOne({
    brandId, type: 'instagram', status: 'active'
  });
  if (!cred)              return { ok: false, reason: 'no active Instagram credential' };
  if (!cred.igUserId)     return { ok: false, reason: 'credential has no igUserId — re-connect Instagram from a Page that owns an IG Business account' };

  let token;
  try { token = decrypt(cred.accessTokenEnc); }
  catch (err) { return { ok: false, reason: `token decrypt failed: ${err.message}` }; }

  // Pull metadata we'll attach to each Media so detect's downstream
  // brand/category lookups work without the upload-form context.
  const brand = await Brand.findById(brandId).select('name websiteUrl').lean();
  const brandName = brand?.name || null;
  const brandUrl  = brand?.websiteUrl || null;

  console.log(`📸 IG post sync starting: brand=${brandId} igUser=${cred.igUserId} limit=${limit}`);

  // ── Pull recent posts ──
  let posts = [];
  try {
    const res = await axios.get(`${META_GRAPH_ROOT}/${cred.igUserId}/media`, {
      params: { fields: POST_FIELDS, limit, access_token: token },
      timeout: 20000
    });
    posts = res.data?.data || [];
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    console.warn(`   ⚠️  IG post fetch failed: ${detail}`);
    return { ok: false, reason: `Meta error: ${detail}` };
  }

  // Compute remaining cap if dailyCap was passed. Counts auto-queued
  // DetectRuns for this brand created today (UTC midnight floor).
  let runsRemaining = null;
  if (dailyCap != null) {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const todayCount = await DetectRun.countDocuments({
      advertiserId: cred.advertiserId,
      mediaId:      { $exists: true },
      createdAt:    { $gte: startOfDay },
      trigger:      'instagram-sync'
    });
    runsRemaining = Math.max(0, dailyCap - todayCount);
    console.log(`   · IG post sync cap check: ${todayCount}/${dailyCap} runs today; ${runsRemaining} remaining`);
  }

  const summary = {
    fetched:  posts.length,
    ingested: 0,
    skipped:  0,
    capSkipped: 0,
    errors:   0,
    queuedRunIds: []
  };

  for (const post of posts) {
    const externalId = String(post.id || '').trim();
    if (!externalId) { summary.errors++; continue; }

    // Idempotent skip: already ingested.
    const existing = await Media.findOne({ source: 'instagram', externalId }).select('_id').lean();
    if (existing) { summary.skipped++; continue; }

    // Cap check — when out of remaining runs, still ingest the Media
    // (cheap, idempotent) but don't enqueue a DetectRun. Tomorrow's
    // sweep can pick them up if cadence allows.
    const enqueueRun = (runsRemaining == null) || runsRemaining > 0;

    try {
      const ingested = await ingestPost({
        post, cred, brandName, brandUrl, token, enqueueRun, trigger
      });
      if (ingested?.mediaId) {
        summary.ingested++;
        if (ingested.runId) {
          summary.queuedRunIds.push(String(ingested.runId));
          if (runsRemaining != null) runsRemaining--;
        } else if (runsRemaining === 0) {
          summary.capSkipped++;
        }
      } else {
        summary.errors++;
      }
    } catch (err) {
      console.warn(`   ⚠️  IG ingest failed for post ${externalId}: ${err.message}`);
      summary.errors++;
    }
  }

  cred.lastUsedAt = new Date();
  cred.lastPostsSyncAt = new Date();
  await cred.save();

  console.log(`📸 IG post sync done: brand=${brandId} fetched=${summary.fetched} ingested=${summary.ingested} skipped=${summary.skipped} errors=${summary.errors} in ${Date.now() - t0}ms`);

  return {
    ok: true,
    durationMs: Date.now() - t0,
    ...summary
  };
}

// Ingest a single post: resolve its primary media URL (handles carousels),
// mirror to Cloudinary, create Media + DetectRun.
async function ingestPost({ post, cred, brandName, brandUrl, token, enqueueRun = true, trigger = 'instagram-sync' }) {
  const externalId = String(post.id);
  const mediaType = post.media_type;       // IMAGE | VIDEO | CAROUSEL_ALBUM
  const permalink = post.permalink || null;
  const caption   = post.caption || null;
  const timestamp = post.timestamp ? new Date(post.timestamp) : null;
  const username  = post.username || cred.igUsername || null;

  // Resolve the actual media URL we'll mirror.
  let sourceMediaUrl = post.media_url || null;
  let thumbnailUrl   = post.thumbnail_url || null;
  let resolvedType   = mediaType;

  if (mediaType === 'CAROUSEL_ALBUM') {
    try {
      const ch = await axios.get(`${META_GRAPH_ROOT}/${externalId}/children`, {
        params: { fields: CHILD_FIELDS, access_token: token },
        timeout: 15000
      });
      const first = (ch.data?.data || [])[0];
      if (first?.media_url) {
        sourceMediaUrl = first.media_url;
        thumbnailUrl   = first.thumbnail_url || null;
        resolvedType   = first.media_type || mediaType;
      }
    } catch (err) {
      console.warn(`   ⚠️  carousel children fetch failed for ${externalId}: ${err.message}`);
    }
  }

  if (!sourceMediaUrl) throw new Error(`no media_url for post ${externalId} (${mediaType})`);

  const isVideo = resolvedType === 'VIDEO' || resolvedType === 'REEL';
  const fileType = isVideo ? 'video' : 'image';

  // Mirror to Cloudinary so we have a stable URL after Meta's CDN expires.
  const upload = await uploadUrlToCloudinary(sourceMediaUrl, {
    resourceType: isVideo ? 'video' : 'image',
    folder:       'instagram'
  });

  // Idempotent insert: another concurrent sync run could race us, so
  // we use findOneAndUpdate with upsert and check for the duplicate.
  let media;
  try {
    media = await Media.findOneAndUpdate(
      { source: 'instagram', externalId },
      {
        $setOnInsert: {
          advertiserId: cred.advertiserId,
          brandId:      cred.brandId,
          source:       'instagram',
          externalId,
          sourceUrl:    permalink,
          fileType,
          fileUrl:      upload.secure_url,
          fileMimeType: upload.format ? `${fileType}/${upload.format}` : null,
          fileName:     `ig_${externalId}.${upload.format || (isVideo ? 'mp4' : 'jpg')}`,
          width:        upload.width || null,
          height:       upload.height || null,
          durationSec:  upload.duration || null,
          metadata: {
            brand:         brandName,
            brandUrl,
            caption,
            postedAt:      timestamp,
            creatorHandle: username,
            postType:      resolvedType,                         // IMAGE | VIDEO | CAROUSEL_ALBUM
            permalink,
            thumbnailUrl,
            ingestedFrom:  'instagram-post-sync'
          }
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    // E11000 — another concurrent run inserted first. Treat as skip.
    if (err.code === 11000) {
      console.log(`   · post ${externalId} already ingested (race)`);
      return { runId: null };
    }
    throw err;
  }

  // Don't enqueue if the caller is rate-capped — Media is still
  // ingested so a future sync (or manual trigger) can run detect.
  if (!enqueueRun) {
    console.log(`   · ingested IG post ${externalId} → Media ${media._id} (DetectRun deferred — daily cap reached)`);
    return { runId: null, mediaId: media._id };
  }

  // Only enqueue a DetectRun for FRESH inserts. If this Media existed
  // before this sync, we already queued a run for it. The check below
  // is the cheapest way to discriminate: count runs for this media.
  const existingRunCount = await DetectRun.countDocuments({ mediaId: media._id });
  if (existingRunCount > 0) {
    console.log(`   · post ${externalId} already had ${existingRunCount} DetectRun(s) — skipping enqueue`);
    return { runId: null, mediaId: media._id };
  }

  const run = await DetectRun.create({
    advertiserId: cred.advertiserId,
    mediaId:      media._id,
    status:       'queued',
    stage:        'queued',
    trigger
  });
  console.log(`   · ingested IG post ${externalId} → Media ${media._id} + DetectRun ${run._id}`);
  return { runId: run._id, mediaId: media._id };
}

// Light status endpoint for the brand page.
async function getPostsStatus(brandId) {
  const [cred, count, latest] = await Promise.all([
    IntegrationCredential.findOne({ brandId, type: 'instagram', status: 'active' }).lean(),
    Media.countDocuments({ brandId, source: 'instagram' }),
    Media.findOne({ brandId, source: 'instagram' }).sort({ createdAt: -1 }).select('createdAt metadata.postedAt').lean()
  ]);
  return {
    connected:     !!cred,
    igUserId:      cred?.igUserId || null,
    igUsername:    cred?.igUsername || null,
    postCount:     count,
    lastIngestedAt: latest?.createdAt || null,
    latestPostedAt: latest?.metadata?.postedAt || null
  };
}

module.exports = { syncPosts, getPostsStatus };
