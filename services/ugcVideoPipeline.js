// UGC-ads Phase 5 — video-input UGC passthrough.
//
// Skips the Omni image-to-video submit (~$3/master, ~2 min wall time)
// when the ad's source Media is a UGC video (Instagram Reel, Apify-
// scraped video post, or an operator-attached video upload). The UGC
// video IS the base plate; downstream titling (Remotion chrome) still
// composites over it, so cost drops to ~$0/master and wall time to
// the Remotion render (~15s).
//
// Contract mirrors the existing atlasVideoService "Grok-skip" branch
// (routes/ads.js §Veo render path, `isVideoSeed`): produce a
// Cloudinary /video/upload/ URL for an aspect-cropped segment, hand it
// back as the master. But that branch fell THROUGH to the Omni submit
// when the source URL was not Cloudinary — which is exactly the
// Apify-scraped case for UGC videos, and is exactly the wasted spend
// this phase exists to close. This service closes it by mirroring
// the source video into Cloudinary on the first pass, then either
// succeeding with a segment URL or skipping the ad (W2 decision, see
// below) — never silently falling through to Omni.
//
// W2 DECISION (mirror failure fallback): the ad is SKIPPED rather
// than routed to Omni. A silent Omni fallback would be a surprise
// $3 charge every time Cloudinary is slow; skip surfaces the failure
// to the operator (perProduct.warning + non-fatal), the mirror runs
// async on the next attempt, and the money invariant stays honest.
// Same class of decision as the money notes in server/CLAUDE.md §2:
// prefer visible failure over silent double-bill.
//
// KILL SWITCH: UGC_VIDEO_PASSTHROUGH, DEFAULT OFF. On until validated
// against a real Apify-scraped video ad; flipping ON is the whole
// rollout — nothing else needs to change to opt a brand in.

const Media                = require('../models/Media');
const { uploadUrlToCloudinary } = require('./cloudinaryService');
const { buildVideoSegmentUrl }  = require('./atlasVideoService');

// Sources that indicate a Media doc originated from UGC ingestion.
// Kept in one place so the picker (Phase 2), the /api/media?ugc=true
// scoping (Phase 4), and this pipeline all agree on the definition.
const UGC_SOURCES = new Set(['instagram', 'apify-ig']);

// Cloudinary mirror timeout — chosen from spec W1 ("mirror on first
// pass … cache the secure_url on the Media row") + W2 ("fallback if
// mirror … takes >30s"). Enforced with Promise.race — the cloudinary
// SDK doesn't accept an AbortSignal, so a client-side clock is the
// portable way to bound this. 30s is generous for a typical Reels
// video (~2-5 MB) but tight enough that a wedged pull surfaces as a
// skip within one adStage.
const MIRROR_TIMEOUT_MS = 30_000;

function isUgcVideoPassthroughEnabled() {
  // OFF by default until validated. Matches the pattern used for
  // other rollout switches in this repo (UGC_FIRST_SEEDING,
  // CATALOG_FEED_ORDER_SEEDING) but with the opposite default.
  const raw = process.env.UGC_VIDEO_PASSTHROUGH;
  if (raw == null || raw === '') return false;
  return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

// A Media doc is a UGC video when:
//   • it's a video by fileType, AND
//   • it came from a social source, OR it has ANY operator-added
//     attachment (product / category / branding / promotional).
//
// The OR half is what makes an operator-attached manual video upload
// eligible — attaching IS the operator's declaration that this asset
// is UGC-adjacent, regardless of source label. Same rule as the
// /api/media?ugc=true filter.
function isUgcVideoSeed(media) {
  if (!media) return false;
  if (media.fileType !== 'video') return false;
  if (media.source && UGC_SOURCES.has(media.source)) return true;
  const hasOperatorProduct  = Array.isArray(media.matchedProducts)
    && media.matchedProducts.some(mp => mp.source === 'operator');
  const hasOperatorCategory = Array.isArray(media.matchedCategories)
    && media.matchedCategories.some(mc => mc.source === 'operator');
  const hasBranding    = !!media.brandingAssignment?.assignedAt;
  const hasPromotional = !!media.promotionalAssignment?.assignedAt;
  return hasOperatorProduct || hasOperatorCategory || hasBranding || hasPromotional;
}

// Detect whether the URL is already usable as a Cloudinary video-upload
// asset. Same test buildVideoSegmentUrl uses, but exposed so the caller
// can decide whether to mirror or use the URL directly.
function isCloudinaryVideoUrl(url) {
  return typeof url === 'string' && url.includes('/video/upload/');
}

// Race a promise against a timeout. Returns { ok: true, value } or
// { ok: false, reason }. Cloudinary's upload is a Promise with no
// AbortSignal support; a timeout wrapper is the portable way.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise.then(v => ({ ok: true, value: v })),
    new Promise(resolve => setTimeout(
      () => resolve({ ok: false, reason: `${label} timed out after ${ms}ms` }),
      ms
    ))
  ]);
}

// Mirror a non-Cloudinary UGC video URL into Cloudinary and persist
// the resulting secure_url onto the Media row. Two things matter:
//   1. Persist BEFORE returning — future runs skip the mirror entirely,
//      which is how the "~$0/master" claim holds up across regenerates.
//      A crash between upload and persist is safe (idempotent-adjacent):
//      the next run just re-mirrors, and Cloudinary's own dedupe is on
//      public_id which we don't set here (unique auto-id).
//   2. Race the upload against MIRROR_TIMEOUT_MS. A wedged upload can't
//      be the reason a Generate Ads run stalls for 5 minutes — the caller
//      will skip the ad instead.
async function mirrorUgcVideoToCloudinary(media) {
  const upload = uploadUrlToCloudinary(media.fileUrl, {
    resourceType: 'video',
    folder:       'liquidretail/ugc_video_mirror'
  });
  const raced = await withTimeout(upload, MIRROR_TIMEOUT_MS, 'ugc-video mirror');
  if (!raced.ok) {
    return { ok: false, reason: raced.reason, code: 'MIRROR_TIMEOUT' };
  }
  const secureUrl = raced.value?.secure_url;
  if (!secureUrl || !isCloudinaryVideoUrl(secureUrl)) {
    return {
      ok: false,
      reason: `mirror returned no usable secure_url (${secureUrl || 'null'})`,
      code:   'MIRROR_INVALID'
    };
  }
  // Persist the Cloudinary URL so future runs skip the mirror step.
  // Non-fatal on failure — the current run can still proceed with the
  // in-memory secure_url, and the next run will try to mirror again.
  try {
    await Media.updateOne({ _id: media._id }, { $set: {
      fileUrl:  secureUrl,
      updatedAt: new Date()
    } });
  } catch (persistErr) {
    console.warn(
      `⚠️  [ugc-video] mirror persist failed for media=${media._id}: ${persistErr.message} — ` +
      `secure_url is usable for THIS render but next run will re-mirror`
    );
  }
  return { ok: true, secureUrl };
}

// Main entry — called by the video render dispatcher when it wants to
// know whether to skip Omni and use the UGC video directly.
//
// Returns one of:
//   { passthrough: true, videoUrl, aspectRatio, mirrored }
//   { passthrough: false, reason }         — fall through to Omni
//   { skip:        true,  reason, code }   — do NOT fall through; skip the ad
//
// The three-way return is deliberate: the dispatcher must never
// silently promote a skip into an Omni submit. Callers case-split
// on `passthrough` vs `skip` explicitly.
async function preparePassthroughMaster({ media, aspectRatio, durationSec = 8 }) {
  if (!isUgcVideoPassthroughEnabled()) {
    return { passthrough: false, reason: 'UGC_VIDEO_PASSTHROUGH=false' };
  }
  if (!isUgcVideoSeed(media)) {
    return { passthrough: false, reason: 'source Media is not a UGC video' };
  }

  // Already-Cloudinary path — cheap, no upload.
  if (isCloudinaryVideoUrl(media.fileUrl)) {
    const segmentUrl = buildVideoSegmentUrl(media.fileUrl, aspectRatio, durationSec);
    if (!segmentUrl) {
      // Should not happen — isCloudinaryVideoUrl passed but the segment
      // build refused. Treat as a skip because a fall-through would
      // silently spend on Omni.
      return {
        skip: true,
        code: 'SEGMENT_BUILD_FAILED',
        reason: `Cloudinary URL but buildVideoSegmentUrl rejected it (aspect=${aspectRatio})`
      };
    }
    return { passthrough: true, videoUrl: segmentUrl, aspectRatio, mirrored: false };
  }

  // Non-Cloudinary path — mirror on first pass.
  const mirrorResult = await mirrorUgcVideoToCloudinary(media);
  if (!mirrorResult.ok) {
    return {
      skip: true,
      code: mirrorResult.code || 'MIRROR_FAILED',
      reason: `ugc-video mirror failed: ${mirrorResult.reason}`
    };
  }
  const segmentUrl = buildVideoSegmentUrl(mirrorResult.secureUrl, aspectRatio, durationSec);
  if (!segmentUrl) {
    return {
      skip: true,
      code: 'SEGMENT_BUILD_FAILED',
      reason: 'mirrored URL did not yield a segment URL — unexpected'
    };
  }
  return { passthrough: true, videoUrl: segmentUrl, aspectRatio, mirrored: true };
}

module.exports = {
  isUgcVideoPassthroughEnabled,
  isUgcVideoSeed,
  isCloudinaryVideoUrl,
  preparePassthroughMaster,
  // Exposed for the offline verifier — pure functions can be exercised
  // without a Cloudinary account.
  UGC_SOURCES,
  MIRROR_TIMEOUT_MS
};
