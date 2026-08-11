// Single source of truth for platform-format capabilities.
//
// Three orthogonal dimensions: surface (where it runs), aspect ratio (canvas
// shape), and kind (image vs video). The legacy `platformFormat` string
// collapses surface + aspect into one slug; kind is operator-selectable per
// format. Reels is video-only by definition; other formats accept either.
//
// Adding a new surface: append to the enum here AND mirror the enum in
//   models/Campaign.js + models/Ad.js (mongoose `enum` is per-doc) for any
//   surface that is status:'live' and can be persisted on those models.
//   coming_soon entries live only in this table until they go live.
//
// Wizard, expandWizardJob, and dispatch all read this table — don't hard-code
// platform strings anywhere else.
//
// PRESETS (2026-08-01) replace the three-knob API (platformFormat + kinds +
// expandStaticFormats) with one operator choice. Old callers still work via
// preset='single' (the default), which reproduces prior behaviour byte-for-
// byte from those three knobs.

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
    platform:    'meta',
    status:      'live',
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
    platform:    'meta',
    status:      'live',
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
    platform:    'meta',
    status:      'live',
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
    // NOTE: `companions` is DEAD data (zero consumers as of 2026-08-01). The live
    // video derivation intent is META_VIDEO_FANOUT + Phase 3 derivation, not this
    // field. Kept for back-compat with any external reader of the table shape.
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
    platform:    'meta',
    status:      'live',
    aspectRatio: '9:16',
    surface:     'meta_stories',
    label:       'Meta Stories',
    kinds:       ['image', 'video'],
    canvas:       { width: 1000, height: 1778 },
    deliveryDims: { width: 1080, height: 1920 },
    safeArea:     { top: 250, bottom: 250 },  // IG Stories: top creator chip + bottom reply input
    // Same 9:16 master, same cheap-crop companions. Stories reserves MORE than
    // Reels (250 vs 204), so a crop that is safe here is safe for Reels too.
    // NOTE: `companions` is DEAD data — see meta_reels_9_16.
    companions:  ['meta_feed_4_5', 'meta_feed_1_1'],
    chromeStyleHints: ['ig_reels', 'editorial'],
    creativeBrief:
      'Vertical IG Stories. Full-screen, 5–15s per slide, viewers tap-through or swipe-away ' +
      'aggressively. More ephemeral and intimate than Reels — feels behind-the-scenes and ' +
      'personal. Native creative is overlay-heavy (text, stickers, polls). Drive curiosity or ' +
      'urgency rather than direct sell. Top 250 + bottom 250 reserved for the creator chip and reply input.'
  },
  // ── Google ───────────────────────────────────────────────────────────
  // Phase A (2026-08-10): six dedicated PMax surfaces are live. Demand Gen
  // and YouTube Shorts keys stay coming_soon (identical deliveryDims to the
  // live PMax set — they reuse those files rather than double-spending).
  // Visible-but-blocked stubs remain filterable via isComingSoonFormat /
  // assertGeneratablePlatformFormat.
  //
  // pmax_16_9 is FROZEN (was live). 45 existing Ads keep this key for
  // read paths (labels, geometry, render-activity board). Do NOT delete the
  // key. kinds/canvas/deliveryDims/safeArea stay byte-identical so lookups
  // still resolve.
  //
  // ⚠️ CORRECTED 2026-08-11: "they become non-regenerable" was WRONG.
  // `assertGeneratablePlatformFormat` only blocks a coming_soon format at
  // GENERATE time; `adRegenerateService.preflight()` has no format gate, so
  // Regenerate on any of those 45 legacy Ads still runs. And its geometry
  // MOVED with the Phase A `GEN_SIZES` addition: `chooseGenSize('16:9')` now
  // picks the exact 2048x1152 instead of 1536x1024, so a regenerated legacy
  // ad renders zero-crop where the original lost 15.6% top and bottom. That
  // is a better frame, not a regression — but it is a real output change on a
  // surface this comment calls frozen, so it is recorded rather than assumed
  // harmless. Freezing here means "not generatable", never "immutable".
  pmax_16_9: {
    platform:    'google',
    status:      'coming_soon',
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
  },

  // Recommended Google Performance Max marketing-image sizes (static).
  // deliveryDims = Google's published recommended asset sizes. No logo
  // asset sizes — logos are uploaded brand assets, not generated ads.
  // safeArea 0/0: statics use the EDGE margin mechanism in staticAdIntents,
  // not a platform UI reserve (host chrome is preview-only for stills).
  pmax_landscape_1_91_1: {
    platform:    'google',
    status:      'live',
    aspectRatio: '1.91:1',
    surface:     'pmax',
    label:       'PMax Landscape',
    kinds:       ['image'],
    canvas:       { width: 1000, height: 524 },
    deliveryDims: { width: 1200, height: 628 },
    safeArea:     { top: 0, bottom: 0 },
    chromeStyleHints: ['editorial'],
    creativeBrief: 'Google Performance Max landscape marketing image (1.91:1).'
  },
  pmax_square_1_1: {
    platform:    'google',
    status:      'live',
    aspectRatio: '1:1',
    surface:     'pmax',
    label:       'PMax Square',
    kinds:       ['image'],
    canvas:       { width: 1000, height: 1000 },
    deliveryDims: { width: 1200, height: 1200 },
    safeArea:     { top: 0, bottom: 0 },
    chromeStyleHints: ['editorial'],
    creativeBrief: 'Google Performance Max square marketing image.'
  },
  pmax_portrait_4_5: {
    platform:    'google',
    status:      'live',
    aspectRatio: '4:5',
    surface:     'pmax',
    label:       'PMax Portrait',
    kinds:       ['image'],
    canvas:       { width: 1000, height: 1250 },
    deliveryDims: { width: 960, height: 1200 },
    safeArea:     { top: 0, bottom: 0 },
    chromeStyleHints: ['editorial'],
    creativeBrief: 'Google Performance Max portrait marketing image (4:5).'
  },

  // Recommended Google Performance Max video sizes (separate from static —
  // one click must never double-spend static + video the way google_pmax did).
  // safeArea is canvas-pixel bands (canvas is width-normalized at 1000).
  pmax_video_16_9: {
    platform:    'google',
    status:      'live',
    aspectRatio: '16:9',
    surface:     'pmax',
    label:       'PMax Video Landscape',
    kinds:       ['video'],
    canvas:       { width: 1000, height: 563 },
    deliveryDims: { width: 1920, height: 1080 },
    // 10% top / 20% bottom of 563h — YouTube landscape player chrome
    safeArea:     { top: 56, bottom: 113 },
    chromeStyleHints: ['editorial', 'yt_shorts'],
    creativeBrief: 'Google Performance Max landscape video (16:9).'
  },
  pmax_video_1_1: {
    platform:    'google',
    status:      'live',
    aspectRatio: '1:1',
    surface:     'pmax',
    label:       'PMax Video Square',
    kinds:       ['video'],
    canvas:       { width: 1000, height: 1000 },
    deliveryDims: { width: 1080, height: 1080 },
    // 10% top / 10% bottom of 1000h — square Discovery / Shorts-adjacent
    safeArea:     { top: 100, bottom: 100 },
    chromeStyleHints: ['editorial'],
    creativeBrief: 'Google Performance Max square video.'
  },
  pmax_video_9_16: {
    platform:    'google',
    status:      'live',
    aspectRatio: '9:16',
    surface:     'pmax',
    label:       'PMax Video Portrait',
    kinds:       ['video'],
    canvas:       { width: 1000, height: 1778 },
    deliveryDims: { width: 1080, height: 1920 },
    // 14% top / 35% bottom of 1778h — YouTube Shorts official ~top-10%/
    // bottom-25% with margin; top band aligned to Meta vertical (249≈250)
    safeArea:     { top: 249, bottom: 622 },
    chromeStyleHints: ['yt_shorts', 'editorial'],
    creativeBrief: 'Google Performance Max vertical video (9:16).'
  },

  // Demand Gen / Shorts — also Google, still coming soon. Identical
  // deliveryDims to the live PMax set; generation reuses those files.
  google_demandgen_1_1: {
    platform:    'google',
    status:      'coming_soon',
    aspectRatio: '1:1',
    surface:     'google_demandgen',
    label:       'Google Demand Gen (Square)',
    kinds:       ['image'],
    canvas:       { width: 1000, height: 1000 },
    deliveryDims: { width: 1200, height: 1200 },
    safeArea:     { top: 0, bottom: 0 },
    chromeStyleHints: ['editorial'],
    creativeBrief: 'Google Demand Gen square — coming soon.'
  },
  google_demandgen_4_5: {
    platform:    'google',
    status:      'coming_soon',
    aspectRatio: '4:5',
    surface:     'google_demandgen',
    label:       'Google Demand Gen (Portrait)',
    kinds:       ['image'],
    canvas:       { width: 1000, height: 1250 },
    deliveryDims: { width: 960, height: 1200 },
    safeArea:     { top: 0, bottom: 0 },
    chromeStyleHints: ['editorial'],
    creativeBrief: 'Google Demand Gen portrait — coming soon.'
  },
  google_demandgen_1_91_1: {
    platform:    'google',
    status:      'coming_soon',
    aspectRatio: '1.91:1',
    surface:     'google_demandgen',
    label:       'Google Demand Gen (Landscape)',
    kinds:       ['image'],
    canvas:       { width: 1000, height: 524 },
    deliveryDims: { width: 1200, height: 628 },
    safeArea:     { top: 0, bottom: 0 },
    chromeStyleHints: ['editorial'],
    creativeBrief: 'Google Demand Gen landscape (1.91:1) — coming soon.'
  },
  google_shorts_9_16: {
    platform:    'google',
    status:      'coming_soon',
    aspectRatio: '9:16',
    surface:     'google_shorts',
    label:       'YouTube Shorts',
    kinds:       ['video'],
    canvas:       { width: 1000, height: 1778 },
    deliveryDims: { width: 1080, height: 1920 },
    safeArea:     { top: 0, bottom: 0 },
    chromeStyleHints: ['yt_shorts', 'editorial'],
    creativeBrief: 'YouTube Shorts vertical — coming soon.'
  }
};

const PLATFORM_FORMAT_KEYS = Object.keys(PLATFORM_FORMATS);

// Live (generatable) subset — the expandWizardJob allowlist and any path that
// must refuse coming_soon. Prefer this over PLATFORM_FORMAT_KEYS when deciding
// whether a format may queue billable work.
const LIVE_PLATFORM_FORMAT_KEYS = PLATFORM_FORMAT_KEYS.filter(
  (k) => PLATFORM_FORMATS[k].status === 'live'
);

function getFormatCaps(platformFormat) {
  return PLATFORM_FORMATS[platformFormat] || null;
}

function isLiveFormat(platformFormat) {
  return PLATFORM_FORMATS[platformFormat]?.status === 'live';
}

function isComingSoonFormat(platformFormat) {
  return PLATFORM_FORMATS[platformFormat]?.status === 'coming_soon';
}

// Channel label for a format key. Prefers the declared `platform` field;
// falls back to key-prefix sniffing for unknown / legacy keys so callers
// that held historical strings keep working.
function platformForFormat(platformFormat) {
  const caps = PLATFORM_FORMATS[platformFormat];
  if (caps?.platform) return caps.platform;
  const f = String(platformFormat || '');
  if (f.startsWith('meta_')) return 'meta';
  if (f.startsWith('pmax_') || f.startsWith('google_')) return 'google';
  if (f.startsWith('tiktok_')) return 'tiktok';
  return null;
}

function channelLabelForFormat(platformFormat) {
  const p = platformForFormat(platformFormat);
  if (p === 'meta') return 'Meta';
  if (p === 'google') return 'Google';
  if (p === 'tiktok') return 'TikTok';
  return null;
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

/**
 * `safeArea` expressed as FRACTIONS of frame height (0..1).
 *
 * The raw bands are CANVAS pixels (canvas is width-normalized at 1000 — see
 * the header comment), so dividing them by `deliveryDims.height` silently
 * under-reports: pmax_video_16_9's 113 is 20% of its 563-high canvas but only
 * 10.5% of its 1080-high delivery. Any consumer holding pixels without the
 * canvas has to guess, so this is the one place the space is resolved.
 *
 * Pure and total: an unknown key, a missing canvas, or a non-positive height
 * yields zeros rather than NaN/Infinity — a guardrail drawn from NaN paints
 * over the whole frame, which is a worse lie than drawing nothing.
 */
function safeAreaFractions(platformFormat) {
  const caps = PLATFORM_FORMATS[platformFormat];
  const band = safeAreaForPlatformFormat(platformFormat);
  const height = Number(caps?.canvas?.height);
  if (!Number.isFinite(height) || height <= 0) return { top: 0, bottom: 0 };
  const clamp = (px) => {
    const n = Number(px);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(1, n / height);
  };
  return { top: clamp(band.top), bottom: clamp(band.bottom) };
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
// coming_soon formats always resolve to [] — they are never generatable.
function resolveKinds(platformFormat, requested) {
  if (!isLiveFormat(platformFormat) && PLATFORM_FORMATS[platformFormat]) {
    // Declared but not live → nothing to generate.
    return [];
  }
  const allowed = kindsForPlatformFormat(platformFormat);
  if (!allowed.length) return [];
  if (!requested || requested === 'both') return allowed;
  // A kind this surface does not support yields NOTHING for this surface.
  //
  // It used to fall back to `allowed`, which inverted the operator's choice
  // into its opposite: asking for static on meta_reels_9_16 (kinds:['video'])
  // returned ['video'] and billed a Veo generation for someone who picked
  // static. The product has two separate presets — static fans out to the three
  // Meta static sizes, video derives 4:5 and 1:1 from one 9:16 seed — so "you
  // asked for a kind I don't have" must resolve to zero, not to the other one.
  return allowed.includes(requested) ? [requested] : [];
}

// renderRoute the render pipeline dispatches on. Image → existing HTML Gen
// path; video → Veo + chrome + Puppeteer composite (Stage 1/2/3).
function renderRouteForKind(kind) {
  return kind === 'video' ? 'veo' : 'html_gen';
}

// Keep only live, declared format keys. Used at every fan-out / preset
// boundary so a coming_soon key can never slip into an Ad payload.
function filterLiveFormats(keys) {
  return (keys || []).filter((k) => isLiveFormat(k));
}

// Canonical form for an operator-supplied list of format keys (preset
// 'explicit'). Strings, trimmed, blanks dropped, ORDER PRESERVED.
//
// THE DEDUPE IS A MONEY GUARD, not tidiness. Every entry surviving into
// staticFormats becomes its own billable image generation per concept, so a
// client that sent ['meta_feed_1_1','meta_feed_1_1'] — trivially reachable from
// a checkbox bug or a double-appended state update — would be charged twice for
// one surface and deliver two identical ads. Non-array input yields [] so a
// malformed body queues nothing rather than falling back to a wider set.
function canonicalFormatList(keys) {
  if (!Array.isArray(keys)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of keys) {
    if (raw == null) continue;
    const s = String(raw).trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

// The Meta static surfaces that ONE "static ads" selection fans out to, so an
// operator picking static gets every size they actually run, not just the one
// they happened to click. Owner-set 2026-07-31.
//
// Excludes, deliberately:
//   - meta_reels_9_16 — declared kinds:['video']; it ships no static image.
//   - pmax_16_9 — Google Performance Max, a different ad platform. Available
//     when explicitly selected, never fanned out from a Meta choice.
//   - any coming_soon entry — never generatable.
//
// EACH ENTRY IS A SEPARATE BILLABLE GENERATION, and that is not an oversight.
// The `companions: [...]` fields still declared on the 9:16 formats describe an
// abandoned cheaper plan: render one 9:16 master and centre-crop it to 4:5 and
// 1:1 ("a cheap crop and titling"), no second charge. That worked only while
// copy was composited by us AFTER the crop. The direct_image pipeline has the
// image model typeset the copy INTO the pixels, so cropping a 9:16 master would
// slice through the headline and CTA. Each surface therefore needs its own
// generation, typeset for its own safe box — verified against the per-surface
// geometry in services/staticAdIntents.js. Do not "optimise" this back into a
// crop without first moving text compositing back out of the model.
const META_STATIC_FANOUT = ['meta_feed_1_1', 'meta_feed_4_5', 'meta_stories_9_16'];

// Meta VIDEO derivation set. INTENT ONLY in this pass (Phase 3 builds the
// derivation). Semantics:
//   - ONE billable 9:16 Veo submit (the master: META_VIDEO_MASTER)
//   - THREE free derivations (reels retitle + feed 1:1 + feed 4:5 crops)
// Queueing four video Ads would be a money bug. resolvePreset('meta_video')
// therefore returns videoFormats: [META_VIDEO_MASTER] only — the full fan-out
// list is for Phase 3 derivation consumers, not for expandWizardJob.
//
// Master is Stories 9:16: its safeArea (250/250) is STRICTER than Reels
// (204/204), so a master composed for Stories is safe to retitle for Reels.
// Feed 1:1 and 4:5 are centre-crops of the same 1080x1920 plate.
const META_VIDEO_MASTER = 'meta_stories_9_16';
const META_VIDEO_FANOUT = [
  'meta_stories_9_16', // master — the ONE billable Veo submit
  'meta_reels_9_16',   // derivation (Phase 3)
  'meta_feed_1_1',     // derivation (Phase 3)
  'meta_feed_4_5'      // derivation (Phase 3)
];

// Every static surface an operator's chosen format should produce.
//
// A Meta static pick fans out to all three Meta static surfaces. Any other
// format (today: pmax_16_9) stays exactly as chosen — one format in, one out —
// because fanning a Google placement out to Meta sizes would spend money on
// surfaces the operator never asked for. A format that supports no static image
// at all (Reels) returns [] so the caller queues no image work for it.
// coming_soon always returns [] — never generatable.
function staticFanoutForPlatformFormat(platformFormat) {
  if (!isLiveFormat(platformFormat)) return [];
  if (META_STATIC_FANOUT.includes(platformFormat)) {
    return filterLiveFormats([...META_STATIC_FANOUT]);
  }
  return kindsForPlatformFormat(platformFormat).includes('image')
    ? filterLiveFormats([platformFormat])
    : [];
}

// Mirror of staticFanoutForPlatformFormat for the Meta video derivation set.
// Returns the FULL fan-out (master + derivations) for Phase 3 consumers.
// expandWizardJob / resolvePreset must NOT queue one Ad per entry — only the
// master is billable. coming_soon / non-Meta / non-video → [].
function videoFanoutForPlatformFormat(platformFormat) {
  if (!isLiveFormat(platformFormat)) return [];
  if (META_VIDEO_FANOUT.includes(platformFormat)) {
    return filterLiveFormats([...META_VIDEO_FANOUT]);
  }
  return kindsForPlatformFormat(platformFormat).includes('video')
    ? filterLiveFormats([platformFormat])
    : [];
}

// ── Google format sets ───────────────────────────────────────────────────
// Split static vs video so one click never double-spends both (the bug
// google_pmax had with pmax_16_9 kinds:['image','video']).
//
// Static: PMax marketing images only. pmax_16_9 (legacy dual-kind key) is
// intentionally omitted; the dedicated landscape / square / portrait keys
// replace it. Demand Gen reuses the identical PMax files (same deliveryDims).
// Video: dedicated PMax video sizes. google_shorts_9_16 is omitted — identical
// dims to pmax_video_9_16. Logo asset sizes are never listed — logos are
// uploaded brand assets, not generated ads.
const GOOGLE_STATIC_FANOUT = [
  'pmax_landscape_1_91_1',
  'pmax_square_1_1',
  'pmax_portrait_4_5'
  // Demand Gen reuses the identical PMax files (same deliveryDims) — not listed.
];
// ⚠️ DELIVERY INTENT ONLY — NOT a queue list, and NOT what resolvePreset
// returns. It names the three surfaces a Google video run ultimately DELIVERS.
// Only two of them are billable Omni masters (GOOGLE_VIDEO_MASTERS below); the
// 1:1 is derived free from the settled 9:16 plate by the expansion layer.
//
// It therefore has no runtime consumer today — deliberately kept, and named
// this way, for the same reason META_VIDEO_FANOUT is: the delivered set is
// worth stating in one place. **Wiring this list into a preset's videoFormats
// would mint a THIRD billable master per product (~$0.90 each) for a surface
// the product sells as free.** `scripts/verifyPresets.js` pins that no named
// preset ever returns the derive-only key.
const GOOGLE_VIDEO_FANOUT = [
  'pmax_video_16_9',
  'pmax_video_1_1',   // derive-only — never an Omni submit
  'pmax_video_9_16'
];

// Two billable Omni masters for google runs (9:16 shared with Meta
// creative-wise, 16:9 net-new). pmax_video_1_1 is NOT a master; it derives
// from the settled 9:16 master (no Omni submit).
const GOOGLE_VIDEO_MASTERS = ['pmax_video_9_16', 'pmax_video_16_9'];

// ── PRESETS ─────────────────────────────────────────────────────────────
// Operator-facing choices that replace platformFormat + kinds + expandStaticFormats.
// Each preset resolves to concrete format lists the expansion path can queue.
//
//   meta_static   — 3 billable image gens per concept (one per Meta static size)
//   meta_video    — 1 billable Veo submit per product (9:16 master only)
//   meta_all      — both of the above
//   google_static — 3 billable PMax static sizes per concept
//   google_video  — 2 billable Omni masters per product (9:16 + 16:9); 1:1 is derive-only
//   google_all    — both of the above
//   explicit      — operator MULTI-SELECT: exactly the surfaces named in
//                   opts.staticFormats / opts.videoFormats. Static bills per
//                   surface; VIDEO is clamped PER PLATFORM to that platform's
//                   billable master(s) — see resolveExplicitFormats.
//   single        — back-compat: reproduce prior three-knob behaviour exactly
//
// coming_soon formats never appear in any resolved list.
const PRESETS = {
  meta_static: {
    platform:    'meta',
    label:       'Meta Static',
    description: 'One generation per concept per Meta static size (1:1, 4:5, Stories 9:16).'
  },
  meta_video: {
    platform:    'meta',
    label:       'Meta Video',
    description: 'One 9:16 master per product; other Meta video sizes are derived (Phase 3), not generated.'
  },
  meta_all: {
    platform:    'meta',
    label:       'All sizes, all formats',
    description: 'Meta static fan-out + one Meta video master per product.'
  },
  google_static: {
    platform:    'google',
    label:       'Google Static',
    description: 'One generation per concept per PMax static size (1.91:1, 1:1, 4:5).'
  },
  google_video: {
    platform:    'google',
    label:       'Google Video',
    description: 'Two Omni masters per product (9:16 + 16:9); square 1:1 is derived, not generated.'
  },
  google_all: {
    platform:    'google',
    label:       'Google All',
    description: 'PMax static fan-out + two PMax video masters per product.'
  },
  explicit: {
    platform:    null,
    label:       'Selected sizes',
    description: 'Exactly the sizes the operator ticked. Each static size is its own generation; video stays one master.'
  },
  single: {
    platform:    null,
    label:       'Single format',
    description: 'Legacy three-knob path (platformFormat + kinds + expandStaticFormats).'
  }
};

const PRESET_KEYS = Object.keys(PRESETS);

// Named presets the UI should offer per platform (excludes 'single').
const PLATFORM_PRESET_KEYS = {
  meta:   ['meta_static', 'meta_video', 'meta_all'],
  google: ['google_static', 'google_video', 'google_all']
};

/**
 * Resolve an operator MULTI-SELECT (preset 'explicit') into the concrete format
 * lists the expansion will queue. Pure, total, and safe on hostile input.
 *
 * Exported ON PURPOSE, and the reason is a money bug rather than tidiness: the
 * /generate duplicate gate must fingerprint the surfaces a request will actually
 * BILL FOR, not the raw arrays the client happened to send. Hashing the raw body
 * means two bodies that resolve to the identical billable set — e.g.
 * ['meta_feed_1_1'] vs ['meta_feed_1_1','meta_reels_9_16'], where Reels carries
 * no static image and is dropped — fingerprint differently, so a real
 * double-click is not recognised as one and the second click bills a second full
 * set of static generations. Static has no cross-run collision protection
 * (its identityDigest is scoped to generationRunId), so that is real money.
 * Route and resolver therefore share THIS function; a second copy of the
 * filtering rules would re-open the gap the first time the two drifted.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.staticFormats] ticked static surfaces
 * @param {string[]} [opts.videoFormats]  ticked video surfaces
 * @returns {{ staticFormats: string[], videoFormats: string[], kinds: string[] }}
 */
function resolveExplicitFormats(opts = {}) {
  // STATIC — one billable image generation PER SURFACE, per concept. Dedupe
  // (canonicalFormatList) is the money guard; the capability filter drops a
  // surface that ships no static image at all (Reels); filterLiveFormats drops
  // coming_soon. ORDER PRESERVED — it does not affect output, and preserving it
  // keeps the resolved list readable in logs.
  const staticFormats = filterLiveFormats(canonicalFormatList(opts.staticFormats))
    .filter((k) => kindsForPlatformFormat(k).includes('image'));

  // VIDEO — CLAMPED TO AT MOST ONE ENTRY, however many aspects were ticked.
  // Video is clamped PER PLATFORM to that platform's BILLABLE MASTERS, because
  // the two platforms genuinely differ and collapsing them is a money bug in
  // one direction or the other:
  //
  //   META  — ONE 9:16 master per product; 1:1, 4:5 and Reels are cropped from
  //     it at titling. One video Ad per ticked aspect is the money bug CLAUDE.md
  //     §2 records as MEASURED in production on 2026-08-01.
  //   GOOGLE PMax — TWO masters (9:16 + 16:9). This is NOT a regression of the
  //     Meta rule: a 16:9 landscape cannot be cropped out of a 9:16 vertical
  //     without losing the subject, so it is a second real submit. Its 1:1 IS a
  //     free crop, which is why pmax_video_1_1 is DERIVE-ONLY and must never
  //     appear here — emitting it would be a third billable Omni submit.
  //
  // So a global "clamp to one" would under-generate PMax, and "honour every
  // tick" would over-bill Meta. Partition, then apply each platform's rule.
  //
  // ORDER-INSENSITIVE by construction, and that is load-bearing rather than
  // stylistic: the duplicate gate hashes this list as a SET, so if resolution
  // were order-sensitive (first-ticked wins) then ['a','b'] and ['b','a'] would
  // queue DIFFERENT plates while sharing one fingerprint — and the second
  // request would be refused as a duplicate of a run that generated something
  // else. Meta ties break to the master then alphabetically; Google emits its
  // masters in canonical GOOGLE_VIDEO_MASTERS order.
  const videoWanted = filterLiveFormats(canonicalFormatList(opts.videoFormats))
    .filter((k) => kindsForPlatformFormat(k).includes('video'));

  const metaWanted = videoWanted.filter((k) => platformForFormat(k) === 'meta');
  let videoFormats = [];
  if (metaWanted.length === 1) {
    // Byte-identical to what preset 'single' would have queued for that surface.
    videoFormats.push(metaWanted[0]);
  } else if (metaWanted.length > 1) {
    videoFormats.push(
      metaWanted.includes(META_VIDEO_MASTER)
        ? META_VIDEO_MASTER
        : [...metaWanted].sort()[0]
    );
  }

  // Google: only the billable masters survive, in canonical order. A ticked
  // derive-only surface (pmax_video_1_1) resolves to NOTHING on its own rather
  // than silently promoting a master the operator never asked to pay for — the
  // wizard does not offer a video tick on it, so this is the hand-rolled-request
  // path, and an honest empty is better than implicit spend.
  const googleWanted = new Set(
    videoWanted.filter((k) => platformForFormat(k) === 'google')
  );
  for (const master of GOOGLE_VIDEO_MASTERS) {
    if (googleWanted.has(master) && isLiveFormat(master)) videoFormats.push(master);
  }

  const kinds = [];
  if (staticFormats.length) kinds.push('image');
  if (videoFormats.length) kinds.push('video');
  return { staticFormats, videoFormats, kinds };
}

/**
 * Resolve a wizard preset into the concrete format lists expandWizardJob queues.
 *
 * @param {string} preset            one of PRESET_KEYS; unknown → treated as 'single'
 * @param {string} platformFormat    used by 'single' (and as a soft default elsewhere)
 * @param {object} [opts]
 * @param {string|null} [opts.kinds]              'image'|'video'|'both'|null — 'single' only
 * @param {boolean} [opts.expandStaticFormats]    'single' only; default false
 * @param {string[]} [opts.staticFormats]         'explicit' only — ticked static surfaces
 * @param {string[]} [opts.videoFormats]          'explicit' only — ticked video surfaces
 * @returns {{ staticFormats: string[], videoFormats: string[], kinds: string[] }}
 *
 * MONEY:
 *   meta_static   → 3 billable image submits per concept
 *   meta_video    → 1 billable Omni submit per product (videoFormats length === 1)
 *   meta_all      → both
 *   google_static → 3 billable image submits per concept
 *   google_video  → 2 billable Omni masters per product (9:16 + 16:9; not the 1:1)
 *   google_all    → both Google static + video masters
 *   explicit      → one billable image submit per ticked static surface per
 *                   concept; video clamped PER PLATFORM to that platform's
 *                   billable master(s) — at most 1 Meta + at most the 2 Google
 *                   masters, and NEVER the derive-only pmax_video_1_1
 * Never emit a coming_soon key, and never emit a derive-only key.
 *
 * THE VIDEO RULE IS PER-PLATFORM, not a global count. Meta ships ONE 9:16
 * master and crops the rest; PMax legitimately needs TWO (9:16 + 16:9) because
 * a 16:9 landscape cannot be cropped from a 9:16 vertical without losing the
 * subject, while its 1:1 IS a free crop. So "clamp video to one entry" — true
 * for Meta — would UNDER-generate PMax, and "one submit per ticked aspect" would
 * OVER-bill Meta. Both directions are money bugs; the partition in
 * resolveExplicitFormats is what keeps each platform honest.
 */
function resolvePreset(preset, platformFormat, opts = {}) {
  const { kinds = null, expandStaticFormats = false } = opts;
  // An ABSENT preset means "the caller predates presets" and legitimately means
  // 'single'. An unrecognised STRING means someone named a preset that does not
  // exist, and silently substituting 'single' is how that becomes a wrong bill
  // instead of an error: the run succeeds, produces a different format set than
  // asked for, and nothing reports it. `google_pmax` was removed on 2026-08-02
  // and any caller still sending it must find out, not quietly get one square
  // Meta ad. Same failure shape as the done/total:0 runs — fail loudly instead.
  if (preset != null && preset !== '' && !PRESET_KEYS.includes(preset)) {
    throw new Error(
      `unknown ad-format preset "${preset}" — expected one of: ${PRESET_KEYS.join(', ')}`
    );
  }
  const name = preset || 'single';

  if (name === 'meta_static') {
    // 3 billable image generations per concept — expected, same cost shape as
    // expandStaticFormats:true on a Meta static surface today.
    const staticFormats = filterLiveFormats([...META_STATIC_FANOUT]);
    return {
      staticFormats,
      videoFormats: [],
      kinds: staticFormats.length ? ['image'] : []
    };
  }

  if (name === 'meta_video') {
    // ONE billable Veo submit per product — the 9:16 master only.
    // Do NOT return META_VIDEO_FANOUT here; the other three sizes are
    // Phase 3 derivations, not separate Ad rows / billable submits.
    const master = isLiveFormat(META_VIDEO_MASTER) ? META_VIDEO_MASTER : null;
    const videoFormats = master ? [master] : [];
    return {
      staticFormats: [],
      videoFormats,
      kinds: videoFormats.length ? ['video'] : []
    };
  }

  if (name === 'meta_all') {
    const staticFormats = filterLiveFormats([...META_STATIC_FANOUT]);
    const master = isLiveFormat(META_VIDEO_MASTER) ? META_VIDEO_MASTER : null;
    const videoFormats = master ? [master] : [];
    const kindsOut = [];
    if (staticFormats.length) kindsOut.push('image');
    if (videoFormats.length) kindsOut.push('video');
    return { staticFormats, videoFormats, kinds: kindsOut };
  }

  if (name === 'google_static') {
    // 3 billable image generations per concept — one per live PMax static size.
    const staticFormats = filterLiveFormats([...GOOGLE_STATIC_FANOUT]);
    return {
      staticFormats,
      videoFormats: [],
      kinds: staticFormats.length ? ['image'] : []
    };
  }

  if (name === 'google_video') {
    // Billable Omni masters only — mirrors meta_video → META_VIDEO_MASTER.
    // Do NOT return GOOGLE_VIDEO_FANOUT here; pmax_video_1_1 is a derive-only
    // surface queued by the expansion layer, not a second Omni submit.
    const videoFormats = filterLiveFormats([...GOOGLE_VIDEO_MASTERS]);
    return {
      staticFormats: [],
      videoFormats,
      kinds: videoFormats.length ? ['video'] : []
    };
  }

  if (name === 'google_all') {
    const staticFormats = filterLiveFormats([...GOOGLE_STATIC_FANOUT]);
    // Masters only — same money shape as google_video (see above).
    const videoFormats = filterLiveFormats([...GOOGLE_VIDEO_MASTERS]);
    const kindsOut = [];
    if (staticFormats.length) kindsOut.push('image');
    if (videoFormats.length) kindsOut.push('video');
    return { staticFormats, videoFormats, kinds: kindsOut };
  }

  if (name === 'explicit') {
    // OPERATOR MULTI-SELECT. The wizard's size cards are checkboxes, so the
    // request names a SET of surfaces rather than one platformFormat. The two
    // sides of that set have completely different money shapes and are
    // deliberately NOT symmetrical:
    //
    // STATIC — one billable image generation PER SURFACE, per concept. That is
    //   the same cost shape as meta_static and it is intended: the image model
    //   typesets the copy into the pixels, so each size must be generated for
    //   its own safe box (see META_STATIC_FANOUT above). Ticking three static
    //   sizes really does mean 3x the image spend.
    //
    // VIDEO — CLAMPED TO AT MOST ONE ENTRY, no matter how many video surfaces
    //   were ticked. The pipeline ships ONE Omni 9:16 master per product and
    //   derives the other aspects by cropping at titling time; queueing one
    //   video Ad per ticked aspect is the money bug CLAUDE.md §2 records as
    //   MEASURED IN PRODUCTION on 2026-08-01 ("1:1 + 4:5 + 9:16 = three
    //   separate video submits ... is a money bug if reintroduced"). A
    //   multi-select UI is exactly how that would come back, so the clamp
    //   lives here in the resolver — not in the route and not in the client,
    //   either of which a future caller could bypass.
    //
    // Clamp rule — see resolveExplicitFormats, which owns it so the duplicate-
    // request gate can normalise a body through the SAME code the expansion
    // uses. Two implementations of "which surfaces will this bill for" is how
    // the gate ends up hashing something the expansion does not generate.
    return resolveExplicitFormats(opts);
  }

  // ── 'single' — exact reproduction of pre-preset three-knob behaviour ──
  //
  // Today (expandWizardJob):
  //   requestedKinds = kinds || campaign.adKinds || 'image'  (caller supplies
  //     the already-defaulted value via opts.kinds; we default to 'image' here
  //     to match that terminal fallback when opts.kinds is null/undefined)
  //   resolvedKinds  = resolveKinds(platformFormat, requestedKinds)
  //   static fan-out only when expandStaticFormats && image is wanted:
  //     staticFormats = staticFanoutForPlatformFormat(pf)  (may be [])
  //     else image uses [platformFormat] when image-capable
  //   video always uses [platformFormat] when video is wanted — no video fan-out
  //
  // coming_soon / unknown pf → resolveKinds returns [] → nothing queued.
  // NOTE: expandWizardJob ALSO refuses an explicitly named coming_soon
  // platformFormat via assertGeneratablePlatformFormat — empty resolve is
  // the money belt; the assert is the operator-facing gate.
  const requested = kinds == null || kinds === '' ? 'image' : kinds;
  const resolvedKinds = resolveKinds(platformFormat, requested);
  const wantsImage = resolvedKinds.includes('image');
  const wantsVideo = resolvedKinds.includes('video');

  let staticFormats = [];
  if (wantsImage) {
    if (expandStaticFormats) {
      staticFormats = staticFanoutForPlatformFormat(platformFormat);
      // When fan-out returns [] (e.g. Reels video-only) there is no image work.
      // When fan-out is off, the live path used [platformFormat] even if the
      // empty-staticFormats branch in runConceptDrivenExpansion fell through —
      // mirror that by emitting [pf] for a live image-capable surface.
    } else if (isLiveFormat(platformFormat) && kindsForPlatformFormat(platformFormat).includes('image')) {
      staticFormats = [platformFormat];
    }
  }

  let videoFormats = [];
  if (wantsVideo && isLiveFormat(platformFormat) && kindsForPlatformFormat(platformFormat).includes('video')) {
    videoFormats = [platformFormat];
  }

  // Final belt-and-braces: never let a coming_soon key through.
  staticFormats = filterLiveFormats(staticFormats);
  videoFormats = filterLiveFormats(videoFormats);

  const kindsOut = [];
  if (staticFormats.length && wantsImage) kindsOut.push('image');
  if (videoFormats.length && wantsVideo) kindsOut.push('video');

  return { staticFormats, videoFormats, kinds: kindsOut };
}

/**
 * Gate for generate / preview when the operator names a platformFormat
 * directly (preset 'single'). coming_soon must be REFUSED with a clear
 * error — not silently fall through to campaign default or empty queue.
 *
 * @param {string|null|undefined} platformFormat
 * @throws {Error} when the format is declared but not yet available
 */
function assertGeneratablePlatformFormat(platformFormat) {
  if (platformFormat == null || platformFormat === '') return;
  const key = String(platformFormat);
  if (!PLATFORM_FORMATS[key]) return; // unknown → existing fall-through
  if (!isLiveFormat(key)) {
    const label = PLATFORM_FORMATS[key].label || key;
    const err = new Error(
      `Platform format "${key}" (${label}) is not yet available (coming soon).`
    );
    err.code = 'PLATFORM_FORMAT_COMING_SOON';
    err.platformFormat = key;
    throw err;
  }
}

/**
 * UI catalog: every platform, its presets, and the formats each preset
 * would produce — including coming_soon entries so the frontend can draw
 * greyed cards without hardcoding keys. resolvePreset still never emits
 * coming_soon into a queue; this is display-only.
 *
 * @returns {{
 *   platforms: Array<{
 *     id: string,
 *     label: string,
 *     presets: Array<{
 *       key: string,
 *       label: string,
 *       description: string,
 *       formats: Array<{
 *         key: string,
 *         label: string,
 *         aspectRatio: string,
 *         deliveryDims: { width: number, height: number },
 *         kinds: string[],
 *         status: string
 *       }>
 *     }>,
 *     formats: Array<{ key, label, aspectRatio, deliveryDims, kinds, status }>
 *   }>
 * }}
 */
function formatCatalog() {
  function formatEntry(key) {
    const caps = PLATFORM_FORMATS[key];
    if (!caps) return null;
    return {
      key,
      label: caps.label,
      aspectRatio: caps.aspectRatio,
      deliveryDims: { ...caps.deliveryDims },
      kinds: [...caps.kinds],
      status: caps.status,
      // Reserved bands the PLACEMENT's own native UI covers, as FRACTIONS of
      // frame height (0..1) — the same clamp the renderer applies to titling.
      // Exposed so the ad-preview chrome can draw its clear-zone guardrail
      // from the real clamp instead of frontend-side approximations, which is
      // the only way the guardrail and the render can agree.
      //
      // ⚠️ NORMALISED ON PURPOSE, and it is not tidiness. `safeArea` is in
      // CANVAS pixels (canvas is width-normalized at 1000 — see the header
      // comment), NOT deliveryDims pixels, and the two differ: pmax_video_16_9
      // is 113/563 = 20% of the canvas but would read as 113/1080 = 10.5%
      // against delivery. Publishing raw pixels without also publishing
      // `canvas` hands every consumer that trap; a preview guardrail that
      // picks the wrong divisor understates the reserved band by half and
      // tells the operator their title is safe when the renderer will clamp
      // it. Normalising here is the only place the space is unambiguous.
      //
      // Display-only: nothing about generation reads this from the catalog.
      safeAreaPct: safeAreaFractions(key)
    };
  }

  // Intent lists per named preset (unfiltered — catalog shows stubs).
  // meta_video / google_video show only the billable master(s), not derive-only
  // surfaces (mirrors resolvePreset money shape).
  const presetFormatKeys = {
    meta_static:   [...META_STATIC_FANOUT],
    meta_video:    [META_VIDEO_MASTER],
    meta_all:      [...META_STATIC_FANOUT, META_VIDEO_MASTER],
    google_static: [...GOOGLE_STATIC_FANOUT],
    google_video:  [...GOOGLE_VIDEO_MASTERS],
    google_all:    [...GOOGLE_STATIC_FANOUT, ...GOOGLE_VIDEO_MASTERS]
  };

  const platformOrder = ['meta', 'google'];
  const platforms = platformOrder.map((id) => {
    const presetKeys = PLATFORM_PRESET_KEYS[id] || [];
    const presets = presetKeys.map((pkey) => {
      const meta = PRESETS[pkey] || {};
      const keys = presetFormatKeys[pkey] || [];
      // Deduplicate while preserving order (meta_all master may already be in static).
      const seen = new Set();
      const formats = [];
      for (const k of keys) {
        if (seen.has(k)) continue;
        seen.add(k);
        const entry = formatEntry(k);
        if (entry) formats.push(entry);
      }
      return {
        key: pkey,
        label: meta.label || pkey,
        description: meta.description || '',
        formats
      };
    });

    const platformFormats = PLATFORM_FORMAT_KEYS
      .filter((k) => PLATFORM_FORMATS[k].platform === id)
      .map(formatEntry)
      .filter(Boolean);

    return {
      id,
      label: id === 'meta' ? 'Meta' : id === 'google' ? 'Google' : id,
      presets,
      formats: platformFormats
    };
  });

  return { platforms };
}

module.exports = {
  PLATFORM_FORMATS,
  PLATFORM_FORMAT_KEYS,
  LIVE_PLATFORM_FORMAT_KEYS,
  getFormatCaps,
  isLiveFormat,
  isComingSoonFormat,
  platformForFormat,
  channelLabelForFormat,
  aspectRatioForPlatformFormat,
  canvasForPlatformFormat,
  safeAreaForPlatformFormat,
  chromeStyleHintsForPlatformFormat,
  creativeBriefForPlatformFormat,
  kindsForPlatformFormat,
  resolveKinds,
  renderRouteForKind,
  filterLiveFormats,
  META_STATIC_FANOUT,
  META_VIDEO_FANOUT,
  META_VIDEO_MASTER,
  GOOGLE_STATIC_FANOUT,
  GOOGLE_VIDEO_FANOUT,
  GOOGLE_VIDEO_MASTERS,
  staticFanoutForPlatformFormat,
  videoFanoutForPlatformFormat,
  PRESETS,
  PRESET_KEYS,
  PLATFORM_PRESET_KEYS,
  resolvePreset,
  resolveExplicitFormats,
  assertGeneratablePlatformFormat,
  formatCatalog
};
