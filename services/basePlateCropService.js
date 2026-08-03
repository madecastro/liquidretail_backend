'use strict';
/**
 * basePlateCropService — face-safe crop of the BASE video before Remotion titling.
 *
 * WHY: since 713c2e5 every portrait target renders at Omni's family native (9:16, 1080x1920 at
 * ATLAS_VIDEO_RESOLUTION=1080p) and reaches its 4:5 canvas via Remotion BasePlate.jsx:18
 * `objectFit:'cover'` — a subject-blind centre crop. Measured on a head at y154-499 of a 1080x1920
 * master: the centre crop cuts 131px of head at 4:5 and 266px at 1:1. This service computes a
 * face-safe rect (services/faceSafeCrop.js), turns it into a synchronous Cloudinary c_crop URL
 * (services/videoCropUrl.js), verifies the URL is actually deliverable, persists it on the Ad, and
 * hands it to titling in place of ad.veoVideoUrl — so objectFit:'cover' becomes a no-op.
 *
 * DEGRADATION CONTRACT — the load-bearing property:
 * every failure, gate miss, or doubt returns null, and the caller uses ad.veoVideoUrl unchanged,
 * i.e. byte-for-byte today's behaviour. The ONE exception this must never allow: substituting a URL
 * that fails at delivery time. remotionRenderService downloads the plate with axios's default
 * validateStatus, renderTitles' failure is swallowed non-fatally at routes/ads.js (brand-script
 * chrome is best-effort), and the ad then ships renderUrl = the RAW UNTITLED 9:16 master — strictly
 * worse than today's titled-but-beheaded output. Hence the liveness probe below, and the
 * retry-with-raw in brandScriptExecutor.
 *
 * Gates, in order (each with a logged reason):
 *   kill switch            BASE_PLATE_CROP_ENABLED !== 'false'   (on by default; env off-switch)
 *   format target          TARGET_BY_FORMAT[format] — keyed on classifyFormat's output ONLY.
 *                          Never ad.aspectRatio, never platformFormat: classifyFormat also reads
 *                          aspectRatio, so deriving the target from anything else can disagree with
 *                          the composition Remotion will actually use — and then the crop parks the
 *                          head FACE_TOP_MARGIN_FRAC from an edge a second blind crop removes.
 *   catchall guard         aspectRatioForPlatformFormat(ad.platformFormat) must EQUAL the target.
 *                          'feed' is classifyFormat's catch-all, so a 1.91:1 or 5:4 ad lands there;
 *                          without this check it would be silently cropped to 4:5.
 *   URL shape              transformable /video/upload/, no existing crop transform (double-crop).
 *   source dims            measured from a DELIVERY-space still (sharp on an so_0 full-size frame),
 *                          never from upload metadata — upload space is the v1 black-bar bug. Must
 *                          be integers and within the delivery cap.
 *   full-frame no-op       a 9:16 target on a 9:16 master needs no crop: return null, zero cost.
 *   face quorum            heads must be found in >= FACE_MIN_FRAMES sampled frames
 *                          (consensusFaceBox). No quorum -> null.
 *   face anchor            the rect's anchorY must be a face anchor. anchorY 'center' is NOT
 *                          "today's output" — centerOnBox centres on the SUBJECT's centre of
 *                          gravity, and a skewed subject box can cut MORE head than the blind
 *                          centre crop. Only a face-verified rect may replace the plate.
 *   liveness               range-GET on the derived URL must return 200/206 before it is trusted.
 *
 * COST: ~4 vision calls per newly generated portrait ad (~$0.02, ledgered automatically via
 * chatCompletion -> trackLlmCall), $0 for cached re-titles (Ad.basePlate), $0 for every gated-out
 * ad. No ffmpeg, no video download — frames are Cloudinary so_<sec> stills at the CDN edge.
 */

const axios = require('axios');
const sharp = require('sharp');
const Ad = require('../models/Ad');
const { chatCompletion } = require('./atlasLlmService');
const { buildFrameUrls } = require('./videoFrameService');
const { aspectRatioForPlatformFormat } = require('./platformFormats');
const {
  computeGravityCropRect, parseAspect, windowFor, unionBoxes, consensusFaceBox,
} = require('./faceSafeCrop');
const {
  buildVideoCropUrl, isTransformableVideoUrl, hasExistingCropTransform,
} = require('./videoCropUrl');
const { noteRenderIssue } = require('./adStage');

const ENABLED = () => String(process.env.BASE_PLATE_CROP_ENABLED ?? 'true').toLowerCase() !== 'false';

// Cloudinary's video pipeline delivers at a capped resolution (account-dependent; the v1 bbox bug
// was crop coords beyond that cap being silently clipped then black-padded). Dims here are measured
// in DELIVERY space, so anything above the cap means the measurement itself is suspect — refuse.
const DELIVERY_CAP = () => {
  const n = Number(process.env.CLOUDINARY_VIDEO_DELIVERY_CAP);
  return Number.isFinite(n) && n >= 480 ? n : 1080;
};

/**
 * Crop target per TITLING FORMAT — the output of brandScriptExecutor.classifyFormat, which is also
 * what picks the Remotion composition. Frozen and asserted by scripts/verifyBasePlateCrop.js to
 * match both remotion/Root.jsx composition dims and platformFormats deliveryDims, so target and
 * composition cannot drift apart.
 */
const TARGET_BY_FORMAT = Object.freeze({
  vertical:  '9:16',
  feed:      '4:5',
  square:    '1:1',
  landscape: '16:9',
});

const CURRENT_VERSION = 1;

// ── pure decision half (offline-testable; scripts/verifyBasePlateCrop.js) ──────────────────────

/**
 * Decide whether/where to crop. Pure — no I/O. Returns
 *   { action: 'crop', target, rect }        — safe to build the URL
 *   { action: 'skip', reason }              — leave the plate alone
 *
 * @param {object} a
 * @param {string} a.format          classifyFormat(ad) output
 * @param {string} a.platformFormat  ad.platformFormat
 * @param {string} a.sourceUrl       ad.veoVideoUrl
 * @param {number} a.sourceW         measured DELIVERY-space width
 * @param {number} a.sourceH         measured DELIVERY-space height
 * @param {object|null} a.subject    union subject box (normalized), or null
 * @param {object|null} a.head       consensus head box (normalized), or null when no quorum
 */
/**
 * The cheap gates that need NO measurement and NO detection — evaluable before any network I/O.
 * decideBasePlateCrop re-runs them (it must stay correct standalone); the orchestrator calls this
 * first so a gated-out ad costs zero vision calls.
 */
function preGateBasePlateCrop({ format, platformFormat, sourceUrl }) {
  const target = TARGET_BY_FORMAT[format];
  if (!target) return { action: 'skip', reason: `unknown-format:${format}` };

  // Catch-all guard. 'feed' swallows every aspect that matches nothing else, so require the
  // platform format to agree with the format-derived target before cropping to it.
  const pfAspect = aspectRatioForPlatformFormat(platformFormat);
  if (pfAspect !== target) return { action: 'skip', reason: `aspect-mismatch:pf=${pfAspect ?? 'null'},target=${target}` };

  if (!isTransformableVideoUrl(sourceUrl)) return { action: 'skip', reason: 'not-transformable-url' };
  if (hasExistingCropTransform(sourceUrl)) return { action: 'skip', reason: 'already-cropped-url' };

  return { action: 'proceed', target };
}

function decideBasePlateCrop({ format, platformFormat, sourceUrl, sourceW, sourceH, subject, head }) {
  const pre = preGateBasePlateCrop({ format, platformFormat, sourceUrl });
  if (pre.action === 'skip') return pre;
  const target = pre.target;

  if (![sourceW, sourceH].every(Number.isInteger) || sourceW < 1 || sourceH < 1) {
    return { action: 'skip', reason: 'bad-dims' };
  }
  // Cap the SMALLER dimension, matching how videoCompositeService bounds srcMin: a 1080x1920
  // portrait and a 1920x1080 landscape master are both "1080-class" deliveries and both fine.
  // (First draft compared sourceW alone, which rejected every legitimate landscape master —
  // caught by verifyBasePlateCrop N2 on its first run.) Dims are measured from a delivery-space
  // still, so exceeding the cap means the measurement is suspect, not just the asset large.
  if (Math.min(sourceW, sourceH) > DELIVERY_CAP()) {
    return { action: 'skip', reason: `dims-exceed-delivery-cap:${sourceW}x${sourceH}` };
  }

  const aspect = parseAspect(target);
  if (!aspect) return { action: 'skip', reason: `bad-target:${target}` };

  // Full-frame no-op: nothing to crop (9:16 on a 9:16 master, 16:9 on a 16:9 master).
  const win = windowFor(sourceW, sourceH, aspect.wr, aspect.hr);
  if (!win) return { action: 'skip', reason: 'degenerate-window' };
  if (win.cw === sourceW && win.ch === sourceH) return { action: 'skip', reason: 'full-frame' };

  // No face quorum -> no crop. NOT a fall-through to centerOnBox: an anchorY 'center' rect centres
  // on the subject's centre of gravity, which a skewed subject box can push to cut MORE head than
  // the blind centre crop we would be replacing. The blind crop is the devil we know.
  if (!head) return { action: 'skip', reason: 'no-face-quorum' };

  const rect = computeGravityCropRect(sourceW, sourceH, aspect.wr, aspect.hr, subject, head);
  if (!rect) return { action: 'skip', reason: 'no-rect' };
  if (rect.anchorY === 'center') return { action: 'skip', reason: 'face-rejected-by-plausibility' };

  return { action: 'crop', target, rect };
}

// ── detection half (I/O) ───────────────────────────────────────────────────────────────────────

/**
 * Vision prompt — the expander's verbatim smart-crop prompt (media.ts detectBoxes) plus one
 * DIVERGENCE: the head box must include HEADWEAR. The geometry holds the box's TOP edge off the
 * frame edge, so a hat outside the box gets cropped off — the exact miss the owner called out.
 */
const DETECT_SYSTEM_PROMPT =
  'You locate content in an ad video frame for smart-cropping. Return STRICT JSON only, no prose:\n' +
  '{"subject":{"left":..,"top":..,"right":..,"bottom":..},"face":{"left":..,"top":..,"right":..,"bottom":..}|null}\n' +
  'All values are fractions 0.0-1.0 of image width/height. left/right are horizontal (0=left edge, 1=right edge); ' +
  'top/bottom are vertical (0=top, 1=bottom). "subject" is the tight box around ALL important content ' +
  '(people, products, text). "face" is the tight box around the PRIMARY person\'s whole head — null if no ' +
  'human head is clearly visible. The head box must contain the entire head including hair and chin, AND any ' +
  'headwear worn (hat, cap, hood, helmet, headscarf) — the box\'s top edge is used to keep the head clear of ' +
  'the crop edge, so headwear outside the box gets cut off. Include nothing below the chin.';

/** Parse one normalized box from vision JSON; null on any doubt (mirrors the expander's parseBox). */
function parseBox(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const clamp01 = (n) => Math.min(1, Math.max(0, n));
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
  const box = {
    left: clamp01(num(raw.left)), top: clamp01(num(raw.top)),
    right: clamp01(num(raw.right)), bottom: clamp01(num(raw.bottom)),
  };
  if ([box.left, box.top, box.right, box.bottom].some(Number.isNaN)) return null;
  if (box.right <= box.left || box.bottom <= box.top) return null;
  return box;
}

/** One frame -> { subject, face } | null. Failures return null (a frame that couldn't vote). */
async function detectFrameBoxes(frameUrl, meta) {
  try {
    const response = await chatCompletion(
      { stage: 'base_plate_crop', service: 'basePlateCropService', ...meta },
      {
        model: 'gpt-4.1', // legacy id -> atlasModelMap -> openai/gpt-5.6-terra on the Atlas transport
        messages: [
          { role: 'system', content: DETECT_SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Locate the subject and the head.' },
              { type: 'image_url', image_url: { url: frameUrl } },
            ],
          },
        ],
        max_tokens: 400,
        temperature: 0,
      },
    );
    const text = String(response?.choices?.[0]?.message?.content ?? '').replace(/```(?:json)?/gi, '');
    const m = /\{[\s\S]*\}/.exec(text);
    if (!m) return null;
    const o = JSON.parse(m[0]);
    const subject = parseBox(o.subject);
    if (!subject) return null;
    return { subject, face: parseBox(o.face) };
  } catch (err) {
    console.warn(`   ⚠️  basePlateCrop: frame detection failed (${err.message})`);
    return null;
  }
}

/**
 * Sample the clip and reconcile per-frame boxes.
 * Returns { subject, head, frames, faceHits, envelope } — head is null without a quorum.
 */
async function detectClipBoxes(sourceUrl, durationSec, meta) {
  const frames = buildFrameUrls(sourceUrl, durationSec, { width: 640, isReel: true });
  if (!frames.length) return { subject: null, head: null, frames: 0, faceHits: 0, envelope: null };

  const results = [];
  // Serial, deliberately: 3-4 frames, and vision RPS buckets are shared with the rest of the
  // pipeline. Latency (~2-6s total) is fine — this runs post-generation, pre-titling, not in any
  // interactive request path.
  for (const f of frames) results.push(await detectFrameBoxes(f.url, meta));

  const frameBoxes = results.map((r) => r?.subject ?? null);
  const frameFaces = results.map((r) => r?.face ?? null);
  const subject = unionBoxes(frameBoxes);
  const head = consensusFaceBox(frameBoxes, frameFaces);
  const envelope = unionBoxes(frameFaces);
  return {
    subject,
    head,
    frames: frames.length,
    faceHits: frameFaces.filter(Boolean).length,
    envelope,
  };
}

/** Measure DELIVERY-space dims: sharp.metadata() on a full-size first-frame still. */
async function measureDeliveryDims(sourceUrl) {
  try {
    const stillUrl = sourceUrl
      .replace(/\.(mp4|mov|webm|m4v|mkv)(\?|$)/i, '.jpg$2')
      .replace(/\/(video\/upload)\//, '/$1/so_0,f_jpg/');
    const res = await axios.get(stillUrl, { responseType: 'arraybuffer', timeout: 20_000, maxRedirects: 0 });
    const m = await sharp(Buffer.from(res.data)).metadata();
    if (!m.width || !m.height) return null;
    return { sourceW: m.width, sourceH: m.height };
  } catch (err) {
    console.warn(`   ⚠️  basePlateCrop: dims measurement failed (${err.message})`);
    return null;
  }
}

/**
 * The derived URL must be provably deliverable BEFORE it replaces the plate. A range-GET is the
 * honest probe: a HEAD can be answered from asset metadata without generating the derivative.
 * Anything but 200/206 (a 423 pending job, a 400 on the transform, a 404) -> not trusted.
 */
async function probeUrlLive(url) {
  try {
    const res = await axios.get(url, {
      headers: { Range: 'bytes=0-0' },
      timeout: 30_000,
      maxRedirects: 0,
      validateStatus: (s) => s === 200 || s === 206,
      responseType: 'arraybuffer',
    });
    return !!res;
  } catch {
    return false;
  }
}

// ── orchestrator ───────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the video URL titling should consume for this ad.
 * Returns { videoUrl, cropped, rect?, reason? } — videoUrl is ALWAYS safe to hand to Remotion:
 * either the probed cropped derivative or ad.veoVideoUrl unchanged.
 */
async function resolveBasePlateVideoUrl({ ad, format }) {
  const raw = { videoUrl: ad?.veoVideoUrl || null, cropped: false };
  try {
    if (!ENABLED()) return { ...raw, reason: 'disabled' };
    if (!ad?.veoVideoUrl) return { ...raw, reason: 'no-source' };

    // Cache: bound to the exact source video. A regenerated base MUST invalidate — a stale crop
    // ships footage the operator never approved.
    const cached = ad.basePlate;
    if (cached && cached.version === CURRENT_VERSION && cached.sourceUrl === ad.veoVideoUrl && cached.format === format) {
      if (cached.videoUrl) return { videoUrl: cached.videoUrl, cropped: true, rect: cached.rect };
      return { ...raw, reason: `cached-skip:${cached.reason}` };
    }

    // Cheap pure gates before any network I/O — a gated-out ad costs zero vision calls.
    const preGate = preGateBasePlateCrop({
      format, platformFormat: ad.platformFormat, sourceUrl: ad.veoVideoUrl,
    });
    if (preGate.action === 'skip') {
      await persistSkip(ad, format, preGate.reason);
      return { ...raw, reason: preGate.reason };
    }

    const dims = await measureDeliveryDims(ad.veoVideoUrl);
    if (!dims) { await persistSkip(ad, format, 'dims-unmeasurable'); return { ...raw, reason: 'dims-unmeasurable' }; }

    const durationSec = Number(ad.videoDurationSec) > 0 ? Number(ad.videoDurationSec) : 8;
    const det = await detectClipBoxes(ad.veoVideoUrl, durationSec, {
      brandId: ad.brandId, campaignId: ad.campaignId, adId: ad._id, mediaId: ad.mediaId,
    });

    const decision = decideBasePlateCrop({
      format,
      platformFormat: ad.platformFormat,
      sourceUrl: ad.veoVideoUrl,
      sourceW: dims.sourceW, sourceH: dims.sourceH,
      subject: det.subject, head: det.head,
    });

    // Envelope diagnostic — measured, not guessed: a WIDE face envelope means one static crop
    // cannot be face-safe for this clip (multi-vignette), and centre is the safe fallback. Logged
    // per ad so "how often does this happen?" becomes a grep, not a debate.
    const env = det.envelope
      ? `${Math.round((det.envelope.right - det.envelope.left) * 100)}x${Math.round((det.envelope.bottom - det.envelope.top) * 100)}%`
      : 'none';
    console.log(
      `   🎯 basePlateCrop[ad=${ad._id}] format=${format} dims=${dims.sourceW}x${dims.sourceH} ` +
      `frames=${det.frames} faceHits=${det.faceHits} envelope=${env} -> ` +
      (decision.action === 'crop' ? `crop ${JSON.stringify(decision.rect)}` : `skip:${decision.reason}`)
    );

    if (decision.action !== 'crop') { await persistSkip(ad, format, decision.reason); return { ...raw, reason: decision.reason }; }

    const url = buildVideoCropUrl({
      sourceUrl: ad.veoVideoUrl, rect: decision.rect, sourceW: dims.sourceW, sourceH: dims.sourceH,
    });
    if (!url) { await persistSkip(ad, format, 'url-build-refused'); return { ...raw, reason: 'url-build-refused' }; }
    if (url === ad.veoVideoUrl) { await persistSkip(ad, format, 'full-frame'); return { ...raw, reason: 'full-frame' }; }

    if (!(await probeUrlLive(url))) {
      // Not persisted as a permanent skip: a cold-cache 423-ish failure may succeed on the next
      // render. Fall back for THIS render only.
      console.warn(`   ⚠️  basePlateCrop[ad=${ad._id}]: derived URL failed liveness probe — using raw plate this render`);
      return { ...raw, reason: 'probe-failed' };
    }

    await Ad.updateOne({ _id: ad._id }, {
      $set: {
        basePlate: {
          version: CURRENT_VERSION,
          format,
          sourceUrl: ad.veoVideoUrl,
          videoUrl: url,
          rect: decision.rect,
          sourceW: dims.sourceW, sourceH: dims.sourceH,
          frames: det.frames, faceHits: det.faceHits, envelope: det.envelope,
          computedAt: new Date(),
        },
        updatedAt: new Date(),
      },
    }).catch((err) => console.warn(`   ⚠️  basePlateCrop: persist failed (${err.message}) — crop still used this render`));

    return { videoUrl: url, cropped: true, rect: decision.rect };
  } catch (err) {
    console.warn(`   ⚠️  basePlateCrop[ad=${ad?._id}]: ${err.message} — using raw plate`);
    return { ...raw, reason: `error:${err.message?.slice(0, 80)}` };
  }
}

/** Persist a skip so re-titles of the same base don't re-pay detection. */
async function persistSkip(ad, format, reason) {
  await Ad.updateOne({ _id: ad._id }, {
    $set: {
      basePlate: {
        version: CURRENT_VERSION, format, sourceUrl: ad.veoVideoUrl,
        videoUrl: null, reason, computedAt: new Date(),
      },
      updatedAt: new Date(),
    },
  }).catch(() => {});
  // Also surface on renderError so GET /api/ads/render-activity shows the
  // reason without a route change. Soft note — status is not flipped.
  noteRenderIssue(ad?._id, {
    message: `face-safe crop skipped: ${reason}`,
    stage: 'face-safe-crop'
  });
}

module.exports = {
  resolveBasePlateVideoUrl,
  decideBasePlateCrop,       // pure — for the harness
  preGateBasePlateCrop,      // pure — for the harness
  TARGET_BY_FORMAT,
  DETECT_SYSTEM_PROMPT,      // for the harness (headwear sentence asserted)
  _internal: { parseBox, measureDeliveryDims, probeUrlLive, detectClipBoxes },
};
