// Video frame extraction utility — pure helper for upcoming
// multi-frame analyses (overlay zones, product detection on Reels with
// fast cuts, etc.). Uses Cloudinary's `so_<sec>` transform so frame
// extraction happens at the CDN edge — no ffmpeg / no buffer download
// of the source video. Each call returns the per-frame still URL plus
// (optionally) the downloaded JPEG buffer.
//
// This module deliberately does NOT change pipeline behavior on its
// own. Callers wire it in where multi-frame is wanted; today the
// detect pipeline still operates on a single hero frame for
// subjects/text and Gemini Identify (the YOLO microservice already
// scans the whole clip server-side and returns a hero).

const axios = require('axios');

// Sample at 25/50/75% of duration for short clips, every 5s capped at
// 5 frames for longer ones. Reels (typically 7–60s) hit the short
// branch; long-form videos hit the long branch.
function planTimestamps(durationSec, { isReel = false, max = isReel ? 4 : 5 } = {}) {
  const d = Number(durationSec);
  if (!Number.isFinite(d) || d <= 0) return [];

  // Tiny clips — one mid-frame is enough.
  if (d <= 4) return [round1(d / 2)];

  // Short — quartile sampling.
  if (d <= 20) {
    const out = [];
    for (let q = 1; q < 4; q++) out.push(round1((d * q) / 4));
    return out.slice(0, max);
  }

  // Long — every ~5 seconds, capped.
  const stride = Math.max(5, d / max);
  const out = [];
  for (let t = stride / 2; t < d && out.length < max; t += stride) {
    out.push(round1(t));
  }
  return out;
}

function round1(n) { return Math.round(n * 10) / 10; }

// Build a Cloudinary URL that returns a single JPEG frame at the
// given timestamp. Source URL must be a Cloudinary video URL (has
// /upload/ in the path); returns null otherwise so callers can skip.
//
// Transform: so_<sec> picks the seek offset; f_jpg forces a still
// output; w_<n> downscales to keep the inline-data payload sane for
// downstream Gemini calls.
function buildFrameUrl(videoUrl, timestampSec, { width = 1024 } = {}) {
  if (!videoUrl || typeof videoUrl !== 'string') return null;
  if (!videoUrl.includes('/upload/')) return null;
  const so = `so_${round1(timestampSec)},w_${Math.round(width)},c_limit,f_jpg`;
  // Replace the file extension with .jpg so Cloudinary picks the JPEG
  // delivery pipeline rather than serving the raw video.
  const swapped = videoUrl.replace(/\.(mp4|mov|webm|m4v|mkv)(\?|$)/i, '.jpg$2');
  if (/\/v\d+\//.test(swapped)) {
    return swapped.replace(/\/(v\d+\/)/, `/${so}/$1`);
  }
  return swapped.replace('/upload/', `/upload/${so}/`);
}

// Build N frame URLs at the planned timestamps. No downloads — just
// URLs the caller can pass to whichever vision model needs the bytes.
function buildFrameUrls(videoUrl, durationSec, opts = {}) {
  const stamps = planTimestamps(durationSec, opts);
  return stamps
    .map(t => ({ timestampSec: t, url: buildFrameUrl(videoUrl, t, opts) }))
    .filter(f => f.url);
}

// Fetch frame buffers in parallel. Used when the consumer needs the
// raw bytes (e.g. inline-data Gemini calls). Each frame is fetched
// independently and a 4xx on one frame doesn't poison the batch.
async function fetchFrameBuffers(videoUrl, durationSec, opts = {}) {
  const frames = buildFrameUrls(videoUrl, durationSec, opts);
  const out = [];
  await Promise.all(frames.map(async f => {
    try {
      const res = await axios.get(f.url, { responseType: 'arraybuffer', timeout: 15000 });
      out.push({
        timestampSec: f.timestampSec,
        url:          f.url,
        buffer:       Buffer.from(res.data),
        mimeType:     res.headers['content-type'] || 'image/jpeg'
      });
    } catch (err) {
      console.warn(`   ⚠️  videoFrame fetch failed @${f.timestampSec}s: ${err.response?.status || err.message}`);
    }
  }));
  return out.sort((a, b) => a.timestampSec - b.timestampSec);
}

module.exports = {
  planTimestamps,
  buildFrameUrl,
  buildFrameUrls,
  fetchFrameBuffers
};
