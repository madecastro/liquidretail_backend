// Single source of truth for platform-format capabilities.
//
// Three orthogonal dimensions: surface (where it runs), aspect ratio (canvas
// shape), and kind (image vs video). The legacy `platformFormat` string
// collapses surface + aspect into one slug; kind is operator-selectable per
// format. Reels is video-only by definition; other formats accept either.
//
// Adding a new surface: append to the enum here AND mirror the enum in
//   models/Campaign.js + models/Ad.js (mongoose `enum` is per-doc).
//
// Wizard, expandWizardJob, and dispatch all read this table — don't hard-code
// platform strings anywhere else.

// safeArea defines the UI band reserved by the host platform — anything
// in those bands gets covered by native chrome (IG comments, like/share
// buttons, Stories caption + creator handle). All chrome MUST render
// inside the content rect ({y: safeArea.top → height - safeArea.bottom}).
// Feed and PMax have no native overlays so the full canvas is usable.
// canvas dimensions follow renderService.CANVAS_DIMS — width-normalized at
// 1000px so HTML/CSS templates render at a known reference width. deliveryDims
// is what the platform delivers to viewers (Cloudinary upscales the screenshot
// to this size on first hit). safeArea is the band reserved by the host's
// native UI overlay.
const PLATFORM_FORMATS = {
  meta_feed_1_1: {
    aspectRatio: '1:1',
    surface:     'meta_feed',
    label:       'Meta Feed (Square)',
    kinds:       ['image', 'video'],
    canvas:       { width: 1000, height: 1000 },
    deliveryDims: { width: 1080, height: 1080 },
    safeArea:     { top: 0, bottom: 0 },
    chromeStyleHints: ['ig_reels', 'editorial'],
    creativeBrief:
      'Square Meta Feed (Instagram + Facebook). Viewers scroll a vertical feed; ads appear inline ' +
      'with friends\' posts. ~1–2 seconds of attention per scroll, longer only if the creative hooks. ' +
      'Native creative is polished but feels social — UGC and editorial both work. Design for ' +
      'thumb-stopping clarity in the first half-second; CTA should land within the first frame, no scroll required.'
  },
  meta_feed_4_5: {
    aspectRatio: '4:5',
    surface:     'meta_feed',
    label:       'Meta Feed (Portrait)',
    kinds:       ['image', 'video'],
    canvas:       { width: 1000, height: 1250 },
    deliveryDims: { width: 1080, height: 1350 },
    safeArea:     { top: 0, bottom: 0 },
    chromeStyleHints: ['ig_reels', 'editorial'],
    creativeBrief:
      'Portrait Meta Feed. Same surface as 1:1 but ~25% more vertical real estate — bigger ' +
      'mobile screen presence and the highest-performing Feed aspect ratio for most brands. ' +
      'Better for product-heavy or layered compositions where copy needs room. Same scroll ' +
      'behavior as 1:1; the first half-second still decides engagement.'
  },
  meta_reels_9_16: {
    aspectRatio: '9:16',
    surface:     'meta_reels',
    label:       'Meta Reels',
    kinds:       ['video'],                   // Reels is video-only
    canvas:       { width: 1000, height: 1778 },
    deliveryDims: { width: 1080, height: 1920 },
    safeArea:     { top: 204, bottom: 204 },  // IG/FB caption + like/share bands
    // Selecting 9:16 also delivers these, cropped from the SAME master render and
    // re-titled for the new frame — no second generation, so no second charge.
    // 1080x1920 centre-crops to 1080x1350 (4:5) and 1080x1080 (1:1), both of which
    // sit inside the 204px safe bands, so nothing meaningful is lost.
    companions:  ['meta_feed_4_5', 'meta_feed_1_1'],
    chromeStyleHints: ['ig_reels', 'tiktok', 'yt_shorts', 'editorial'],
    creativeBrief:
      'Vertical Reels on Instagram + Facebook. Full-screen, fast-paced, sound-on by default. ' +
      'Native creator content sets the tone — trends, hooks, direct-to-camera energy. Ads compete ' +
      'head-to-head with that energy, so polished-static reads as "ad" instantly and gets swiped. ' +
      'Open with a visual hook in the first second, escalate, close with a CTA in the back half. ' +
      'Top + bottom 204px reserved for IG\'s caption + reaction UI.'
  },
  meta_stories_9_16: {
    aspectRatio: '9:16',
    surface:     'meta_stories',
    label:       'Meta Stories',
    kinds:       ['image', 'video'],
    canvas:       { width: 1000, height: 1778 },
    deliveryDims: { width: 1080, height: 1920 },
    safeArea:     { top: 250, bottom: 250 },  // IG Stories: top creator chip + bottom reply input
    // Same 9:16 master, same cheap-crop companions. Stories reserves MORE than
    // Reels (250 vs 204), so a crop that is safe here is safe for Reels too.
    companions:  ['meta_feed_4_5', 'meta_feed_1_1'],
    chromeStyleHints: ['ig_reels', 'editorial'],
    creativeBrief:
      'Vertical IG Stories. Full-screen, 5–15s per slide, viewers tap-through or swipe-away ' +
      'aggressively. More ephemeral and intimate than Reels — feels behind-the-scenes and ' +
      'personal. Native creative is overlay-heavy (text, stickers, polls). Drive curiosity or ' +
      'urgency rather than direct sell. Top 250 + bottom 250 reserved for the creator chip and reply input.'
  },
  pmax_16_9: {
    aspectRatio: '16:9',
    surface:     'pmax',
    label:       'Google Performance Max',
    kinds:       ['image', 'video'],
    canvas:       { width: 1000, height: 563 },   // aligned with renderService.CANVAS_DIMS['16:9']
    deliveryDims: { width: 1920, height: 1080 },
    safeArea:     { top: 0, bottom: 0 },
    chromeStyleHints: ['editorial', 'yt_shorts'],
    creativeBrief:
      'Google Performance Max landscape. Distributes across YouTube, Display Network, Discovery, ' +
      'Gmail, and Maps — the operator cannot pick placement. The single creative MUST work as both ' +
      'a YouTube pre-roll AND a Display banner. Direct-response copy, prominent CTA, broad-appeal ' +
      'imagery. Avoid platform-native styling cues (no IG/TikTok aesthetics) — go editorial / clean / ' +
      'commercial. Treat it as a billboard, not a social post.'
  }
};

const PLATFORM_FORMAT_KEYS = Object.keys(PLATFORM_FORMATS);

function getFormatCaps(platformFormat) {
  return PLATFORM_FORMATS[platformFormat] || null;
}

function aspectRatioForPlatformFormat(platformFormat) {
  return PLATFORM_FORMATS[platformFormat]?.aspectRatio || null;
}

function canvasForPlatformFormat(platformFormat) {
  return PLATFORM_FORMATS[platformFormat]?.canvas || null;
}

function safeAreaForPlatformFormat(platformFormat) {
  return PLATFORM_FORMATS[platformFormat]?.safeArea || { top: 0, bottom: 0 };
}

function chromeStyleHintsForPlatformFormat(platformFormat) {
  return PLATFORM_FORMATS[platformFormat]?.chromeStyleHints
    || ['ig_reels', 'tiktok', 'yt_shorts', 'editorial'];
}

function creativeBriefForPlatformFormat(platformFormat) {
  return PLATFORM_FORMATS[platformFormat]?.creativeBrief || '';
}

function kindsForPlatformFormat(platformFormat) {
  return PLATFORM_FORMATS[platformFormat]?.kinds || [];
}

// Resolve operator's kind choice ('image' | 'video' | 'both') to the
// concrete kind list, intersected with what the format actually allows.
// Falls back to all supported kinds when input is empty/null.
function resolveKinds(platformFormat, requested) {
  const allowed = kindsForPlatformFormat(platformFormat);
  if (!allowed.length) return [];
  if (!requested || requested === 'both') return allowed;
  return allowed.includes(requested) ? [requested] : allowed;
}

// renderRoute the render pipeline dispatches on. Image → existing HTML Gen
// path; video → Veo + chrome + Puppeteer composite (Stage 1/2/3).
function renderRouteForKind(kind) {
  return kind === 'video' ? 'veo' : 'html_gen';
}

module.exports = {
  PLATFORM_FORMATS,
  PLATFORM_FORMAT_KEYS,
  getFormatCaps,
  aspectRatioForPlatformFormat,
  canvasForPlatformFormat,
  safeAreaForPlatformFormat,
  chromeStyleHintsForPlatformFormat,
  creativeBriefForPlatformFormat,
  kindsForPlatformFormat,
  resolveKinds,
  renderRouteForKind
};
