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
  // ── Google — ALL coming_soon (owner deferred 2026-08-02) ─────────────
  // Visible in the UI so operators see the roadmap. NEVER generatable:
  // filtered out of every fan-out, every resolvePreset path, and refused
  // by assertGeneratablePlatformFormat when named on a generate request.
  //
  // pmax_16_9 is FROZEN (was live). 45 existing Ads keep this key for
  // read paths (labels, geometry, render-activity board); they become
  // non-regenerable. Do NOT delete the key. kinds/canvas/deliveryDims/
  // safeArea stay byte-identical so lookups still resolve.
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
  pmax_landscape_1_91_1: {
    platform:    'google',
    status:      'coming_soon',
    aspectRatio: '1.91:1',
    surface:     'pmax',
    label:       'PMax Landscape',
    kinds:       ['image'],
    canvas:       { width: 1000, height: 524 },
    deliveryDims: { width: 1200, height: 628 },
    safeArea:     { top: 0, bottom: 0 },
    chromeStyleHints: ['editorial'],
    creativeBrief: 'Google Performance Max landscape marketing image (1.91:1) — coming soon.'
  },
  pmax_square_1_1: {
    platform:    'google',
    status:      'coming_soon',
    aspectRatio: '1:1',
    surface:     'pmax',
    label:       'PMax Square',
    kinds:       ['image'],
    canvas:       { width: 1000, height: 1000 },
    deliveryDims: { width: 1200, height: 1200 },
    safeArea:     { top: 0, bottom: 0 },
    chromeStyleHints: ['editorial'],
    creativeBrief: 'Google Performance Max square marketing image — coming soon.'
  },
  pmax_portrait_4_5: {
    platform:    'google',
    status:      'coming_soon',
    aspectRatio: '4:5',
    surface:     'pmax',
    label:       'PMax Portrait',
    kinds:       ['image'],
    canvas:       { width: 1000, height: 1250 },
    deliveryDims: { width: 960, height: 1200 },
    safeArea:     { top: 0, bottom: 0 },
    chromeStyleHints: ['editorial'],
    creativeBrief: 'Google Performance Max portrait marketing image (4:5) — coming soon.'
  },

  // Recommended Google Performance Max video sizes (separate from static —
  // one click must never double-spend static + video the way google_pmax did).
  pmax_video_16_9: {
    platform:    'google',
    status:      'coming_soon',
    aspectRatio: '16:9',
    surface:     'pmax',
    label:       'PMax Video Landscape',
    kinds:       ['video'],
    canvas:       { width: 1000, height: 563 },
    deliveryDims: { width: 1920, height: 1080 },
    safeArea:     { top: 0, bottom: 0 },
    chromeStyleHints: ['editorial', 'yt_shorts'],
    creativeBrief: 'Google Performance Max landscape video (16:9) — coming soon.'
  },
  pmax_video_1_1: {
    platform:    'google',
    status:      'coming_soon',
    aspectRatio: '1:1',
    surface:     'pmax',
    label:       'PMax Video Square',
    kinds:       ['video'],
    canvas:       { width: 1000, height: 1000 },
    deliveryDims: { width: 1080, height: 1080 },
    safeArea:     { top: 0, bottom: 0 },
    chromeStyleHints: ['editorial'],
    creativeBrief: 'Google Performance Max square video — coming soon.'
  },
  pmax_video_9_16: {
    platform:    'google',
    status:      'coming_soon',
    aspectRatio: '9:16',
    surface:     'pmax',
    label:       'PMax Video Portrait',
    kinds:       ['video'],
    canvas:       { width: 1000, height: 1778 },
    deliveryDims: { width: 1080, height: 1920 },
    safeArea:     { top: 0, bottom: 0 },
    chromeStyleHints: ['yt_shorts', 'editorial'],
    creativeBrief: 'Google Performance Max vertical video (9:16) — coming soon.'
  },

  // Demand Gen / Shorts — also Google, also coming soon. Both PMax and
  // Demand Gen are legitimate Google surfaces.
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

// ── Google format sets (intent for when Google goes live) ────────────────
// Split static vs video so one click never double-spends both (the bug
// google_pmax had with pmax_16_9 kinds:['image','video']). Today every
// entry is coming_soon, so filterLiveFormats returns [] and the three
// Google presets resolve empty — no second mechanism needed.
//
// Static: PMax marketing images + Demand Gen images. pmax_16_9 (legacy
// dual-kind key) is intentionally omitted from the static fan-out; the
// dedicated pmax_landscape / square / portrait stubs replace it.
// Video: dedicated PMax video sizes + YouTube Shorts. Logo asset sizes
// are never listed — logos are uploaded brand assets, not generated ads.
const GOOGLE_STATIC_FANOUT = [
  'pmax_landscape_1_91_1',
  'pmax_square_1_1',
  'pmax_portrait_4_5',
  'google_demandgen_1_1',
  'google_demandgen_4_5',
  'google_demandgen_1_91_1'
];
const GOOGLE_VIDEO_FANOUT = [
  'pmax_video_16_9',
  'pmax_video_1_1',
  'pmax_video_9_16',
  'google_shorts_9_16'
];

// ── PRESETS ─────────────────────────────────────────────────────────────
// Operator-facing choices that replace platformFormat + kinds + expandStaticFormats.
// Each preset resolves to concrete format lists the expansion path can queue.
//
//   meta_static   — 3 billable image gens per concept (one per Meta static size)
//   meta_video    — 1 billable Veo submit per product (9:16 master only)
//   meta_all      — both of the above
//   google_static — Google static sizes (all coming_soon today → empty)
//   google_video  — Google video sizes (all coming_soon today → empty)
//   google_all    — both Google static + video (empty today)
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
    description: 'Google Performance Max + Demand Gen marketing images. Coming soon.'
  },
  google_video: {
    platform:    'google',
    label:       'Google Video',
    description: 'Google Performance Max video + YouTube Shorts. Coming soon.'
  },
  google_all: {
    platform:    'google',
    label:       'Google All',
    description: 'Google static + video sizes. Coming soon.'
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
 * Resolve a wizard preset into the concrete format lists expandWizardJob queues.
 *
 * @param {string} preset            one of PRESET_KEYS; unknown → treated as 'single'
 * @param {string} platformFormat    used by 'single' (and as a soft default elsewhere)
 * @param {object} [opts]
 * @param {string|null} [opts.kinds]              'image'|'video'|'both'|null — 'single' only
 * @param {boolean} [opts.expandStaticFormats]    'single' only; default false
 * @returns {{ staticFormats: string[], videoFormats: string[], kinds: string[] }}
 *
 * MONEY:
 *   meta_static → 3 billable image submits per concept
 *   meta_video  → 1 billable Veo submit per product (videoFormats length === 1)
 *   meta_all    → both
 *   google_*    → empty while every Google format is coming_soon
 * Never emit a coming_soon key.
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
    // Intended list is GOOGLE_STATIC_FANOUT; filterLiveFormats drops every
    // coming_soon key so today this is always empty. No special-case.
    const staticFormats = filterLiveFormats([...GOOGLE_STATIC_FANOUT]);
    return {
      staticFormats,
      videoFormats: [],
      kinds: staticFormats.length ? ['image'] : []
    };
  }

  if (name === 'google_video') {
    const videoFormats = filterLiveFormats([...GOOGLE_VIDEO_FANOUT]);
    return {
      staticFormats: [],
      videoFormats,
      kinds: videoFormats.length ? ['video'] : []
    };
  }

  if (name === 'google_all') {
    const staticFormats = filterLiveFormats([...GOOGLE_STATIC_FANOUT]);
    const videoFormats = filterLiveFormats([...GOOGLE_VIDEO_FANOUT]);
    const kindsOut = [];
    if (staticFormats.length) kindsOut.push('image');
    if (videoFormats.length) kindsOut.push('video');
    return { staticFormats, videoFormats, kinds: kindsOut };
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
      status: caps.status
    };
  }

  // Intent lists per named preset (unfiltered — catalog shows stubs).
  // meta_video shows only the billable master (not the Phase 3 derivation set).
  const presetFormatKeys = {
    meta_static:   [...META_STATIC_FANOUT],
    meta_video:    [META_VIDEO_MASTER],
    meta_all:      [...META_STATIC_FANOUT, META_VIDEO_MASTER],
    google_static: [...GOOGLE_STATIC_FANOUT],
    google_video:  [...GOOGLE_VIDEO_FANOUT],
    google_all:    [...GOOGLE_STATIC_FANOUT, ...GOOGLE_VIDEO_FANOUT]
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
  staticFanoutForPlatformFormat,
  videoFanoutForPlatformFormat,
  PRESETS,
  PRESET_KEYS,
  PLATFORM_PRESET_KEYS,
  resolvePreset,
  assertGeneratablePlatformFormat,
  formatCatalog
};
