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
//
// planTimestamps / buildFrameUrl / buildFrameUrls / fetchFrameBuffers are
// UNCHANGED below — pinned byte-for-byte by scripts/verifyAdVisionQc.js O13
// and relied on as-is by services/basePlateCropService.js. The
// *-AtTimestamps siblings added below are pure additive refactors (shared
// URL-building / fetch plumbing, exposed for an explicit timestamp list
// instead of a duration-derived plan) — added for
// services/videoQcFrameSelectionService.js's dense pre-filter, which needs
// to fetch a caller-supplied timestamp list rather than re-deriving one.
//
// planAdditionalTimestamps / buildAdditionalFrameUrls are similarly additive
// (gap-midpoint extra samples for basePlateCropService's one-shot
// face-quorum retry). They reuse evenlySpaced / round1 / dedupeSorted;
// planTimestamps itself is unchanged.

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

// Dense, EARLY-WEIGHTED candidate timestamps — a much larger set than
// planTimestamps, meant to be probed CHEAPLY (small width, no vision call)
// by services/videoQcFrameSelectionService.js's perceptual pre-filter, not
// sent to a paid model directly. Concentrates samples in the first
// `earlyWindowSec` because that is where a generative video model's
// transient artifacts empirically cluster (2026-08-20 storefront-chrome
// incident: visible at t=0.1s/0.5s, gone by t=2.5s) while still covering
// the rest of the clip — the pre-filter's outlier score needs frames from
// the WHOLE clip to know what the clip's own "steady state" looks like.
//
// Exported so callers that need to know WHICH returned timestamps are
// "early" (e.g. videoQcFrameSelectionService.js, to keep its outlier
// reference derived from the "late" cluster only — see that module's file
// header) use the exact same boundary planDenseTimestamps itself applies,
// rather than a second hardcoded "2" that could silently drift from it.
const DEFAULT_EARLY_WINDOW_SEC = 2;

// Pure function, no I/O. Exported for direct unit testing of the timestamp
// plan independent of network/image-decode behavior.
function planDenseTimestamps(durationSec, opts = {}) {
  const d = Number(durationSec);
  if (!Number.isFinite(d) || d <= 0) return [];

  const {
    earlyWindowSec = DEFAULT_EARLY_WINDOW_SEC,
    earlySampleCount = 6,
    lateSampleCount = 6
  } = opts;

  // Tiny clip — no meaningful "early vs. late" distinction to weight
  // toward; just spread samples evenly across the whole thing.
  if (d <= earlyWindowSec) {
    const n = Math.max(2, Math.min(earlySampleCount, Math.round(d * 3)));
    return dedupeSorted(evenlySpaced(0.1, Math.max(0.1, d - 0.1), n), d);
  }

  const early = evenlySpaced(0.1, earlyWindowSec, earlySampleCount);
  const remainder = d - earlyWindowSec;
  const lateCount = Math.max(2, Math.min(lateSampleCount, Math.round(remainder)));
  const late = evenlySpaced(
    earlyWindowSec + remainder / (lateCount + 1),
    Math.max(earlyWindowSec + 0.1, d - 0.1),
    lateCount
  );

  return dedupeSorted([...early, ...late], d);
}

function evenlySpaced(start, end, n) {
  if (!(end > start)) return [round1(start)];
  if (n <= 1) return [round1((start + end) / 2)];
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(round1(start + (end - start) * (i / (n - 1))));
  }
  return out;
}

function dedupeSorted(nums, durationSec) {
  const set = new Set(nums.map(round1).filter((t) => t > 0 && t < durationSec));
  return [...set].sort((a, b) => a - b);
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
  return buildFrameUrlsAtTimestamps(videoUrl, stamps, opts);
}

// Same as buildFrameUrls, but for a caller-supplied timestamp list
// instead of one derived from planTimestamps. Shared by buildFrameUrls
// (stamps = planTimestamps(...)) and the dense QC pre-filter
// (stamps = planDenseTimestamps(...) or a curated final selection).
function buildFrameUrlsAtTimestamps(videoUrl, timestamps, opts = {}) {
  if (!Array.isArray(timestamps) || !timestamps.length) return [];
  return timestamps
    .map((t) => ({ timestampSec: round1(t), url: buildFrameUrl(videoUrl, t, opts) }))
    .filter((f) => f.url)
    .sort((a, b) => a.timestampSec - b.timestampSec);
}

/**
 * Additional timestamps that sit in the gaps of an already-sampled plan.
 * Reuses evenlySpaced (the same midpoint/even-grid primitive as
 * planDenseTimestamps) — does NOT change planTimestamps.
 *
 * Places `count` new points at the midpoints of the largest gaps between
 * existing samples (including [0, first] and [last, duration]), never
 * repeating an already-sampled timestamp. Equal-size gaps (typical 8s
 * reel quartile plan) are picked evenly along the timeline so two of
 * four land at the first AND last gap (around the existing samples)
 * rather than clustering in the first half.
 */
function planAdditionalTimestamps(durationSec, existingTimestamps, count) {
  const d = Number(durationSec);
  const n = Number(count);
  if (!Number.isFinite(d) || d <= 0) return [];
  if (!Number.isInteger(n) || n < 1) return [];

  const existing = dedupeSorted(existingTimestamps || [], d);
  const bounds = [0, ...existing, d];
  const gaps = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i];
    const end = bounds[i + 1];
    if (!(end > start)) continue;
    const [mid] = evenlySpaced(start, end, 1);
    const r = round1(mid);
    if (r > 0 && r < d && !existing.includes(r)) {
      gaps.push({ start, end, size: end - start, mid: r });
    }
  }
  if (!gaps.length) return [];

  const maxSize = Math.max(...gaps.map((g) => g.size));
  const top = gaps.filter((g) => g.size >= maxSize * 0.9);
  const rest = gaps.filter((g) => g.size < maxSize * 0.9)
    .sort((a, b) => b.size - a.size || a.start - b.start);

  function pickEvenly(arr, k) {
    if (k <= 0 || !arr.length) return [];
    if (k >= arr.length) return arr.slice();
    if (k === 1) return [arr[Math.floor(arr.length / 2)]];
    const out = [];
    const used = new Set();
    for (let i = 0; i < k; i++) {
      let idx = Math.round((i * (arr.length - 1)) / (k - 1));
      while (used.has(idx) && idx < arr.length - 1) idx += 1;
      while (used.has(idx) && idx > 0) idx -= 1;
      if (used.has(idx)) continue;
      used.add(idx);
      out.push(arr[idx]);
    }
    return out;
  }

  const chosen = pickEvenly(top, n);
  if (chosen.length < n) chosen.push(...rest.slice(0, n - chosen.length));
  return chosen.map((g) => g.mid).sort((a, b) => a - b);
}

// Same as buildFrameUrls, but for timestamps that fill the gaps of an
// already-sampled plan. `opts.count` is the number of extra stills.
function buildAdditionalFrameUrls(videoUrl, durationSec, existingTimestamps, opts = {}) {
  const count = Number.isInteger(opts.count) && opts.count > 0 ? opts.count : 0;
  const stamps = planAdditionalTimestamps(durationSec, existingTimestamps, count);
  return buildFrameUrlsAtTimestamps(videoUrl, stamps, opts);
}

// Shared fetch plumbing for a already-built frame-descriptor list. Each
// frame is fetched independently and a 4xx on one frame doesn't poison
// the batch.
async function fetchFramesForUrls(frames, opts = {}) {
  const { timeoutMs = 15000 } = opts;
  const out = [];
  await Promise.all(frames.map(async (f) => {
    try {
      const res = await axios.get(f.url, { responseType: 'arraybuffer', timeout: timeoutMs });
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

// Fetch frame buffers in parallel. Used when the consumer needs the
// raw bytes (e.g. inline-data Gemini calls). Each frame is fetched
// independently and a 4xx on one frame doesn't poison the batch.
async function fetchFrameBuffers(videoUrl, durationSec, opts = {}) {
  const frames = buildFrameUrls(videoUrl, durationSec, opts);
  return fetchFramesForUrls(frames, opts);
}

// Same as fetchFrameBuffers, but for a caller-supplied timestamp list.
// Used by the dense QC pre-filter to pull a cheap, small-width probe set
// that never reaches a vision model directly.
async function fetchFrameBuffersAtTimestamps(videoUrl, timestamps, opts = {}) {
  const frames = buildFrameUrlsAtTimestamps(videoUrl, timestamps, opts);
  return fetchFramesForUrls(frames, opts);
}

module.exports = {
  DEFAULT_EARLY_WINDOW_SEC,
  planTimestamps,
  planDenseTimestamps,
  planAdditionalTimestamps,
  buildFrameUrl,
  buildFrameUrls,
  buildFrameUrlsAtTimestamps,
  buildAdditionalFrameUrls,
  fetchFrameBuffers,
  fetchFrameBuffersAtTimestamps
};
