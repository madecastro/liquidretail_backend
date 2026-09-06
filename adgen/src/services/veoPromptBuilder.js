// Builds the camera-only video prompt for the AI video model (Gemini
// Omni via Atlas by default; Grok/Veo via per-brand/per-product/
// per-canvas overrides — see atlasVideoService.resolveVideoModel).
// The prompt is a fixed "Ken Burns" luxury product-commercial spec:
// the model animates a virtual camera over the supplied photographs
// and must NOT generate, recreate, or alter the imagery. It contains
// NO text choreography — every on-screen overlay (headline, CTA,
// quote, brand mark) is composited downstream by the canonical
// brand-script overlay (brandScriptExecutor + brandScripts/*.script.js),
// which reads its text from ad.copy + LayoutInputArtifact +
// Brand.styleTheme.
//
// Timeline is FIXED — a canonical 3-scene 8.0s arc (pan → logo zoom →
// zoom-out reveal). The GPT storyboard (veoStoryboardService) is
// retired on the Atlas path: camera is fully specified below and audio
// uses a fixed default.
// Labeled default-prompt profiles (PROMPT_PROFILES):
//   • gemini-omni — verbose; optimized for google/gemini-omni-flash/*
//     (20,000-byte cap). STILL FROZEN, and still byte-identical to the
//     pre-#61 prompt (owner PR #61 full rollback). It is no longer the
//     live Meta profile — see hook_first below — but it IS what the kill
//     switch falls back to, so the rollback guarantee lives here. Do NOT
//     reword: verifyPostPilotBatch B14/B15 assert byte-identity.
//   • grok — compact re-authoring of the same rules; optimized for
//     xai/grok-imagine-video* (4,096-byte cap); also serves veo/generic
//   • hook_first — hook-first + centre-safe + aspect-aware Frame. Was the
//     PMax-only profile ('pmax'); STANDARDIZED ONTO META TOO on owner
//     instruction 2026-08-18, verbatim: "I want to use the PMax prompt for
//     Meta also, and standardize on that but maintain a single minting for
//     9x16 across both formats. Continue to mint a 16x9." Selected for any
//     Meta OR PMax video destination while the kill switch is on (default).
//     'pmax' is still accepted as an alias everywhere it was a valid value.
// promptProfileFor(caps, opts) selects the profile from destination first,
// then caps.paramShape. The prompt-size cap is per-model (caps.promptByteCap).


// Aspect-ratio resolution lives in services/platformFormats.js — the
// canonical capability table for every platformFormat. Re-exported here
// so existing callers keep working without an import rewrite.
const {
  PLATFORM_FORMATS,
  aspectRatioForPlatformFormat
} = require('./platformFormats');
const {
  isVideoProductAnchorEnabled,
  productRegionForAd,
  buildProductAnchorBlock,
  videoSubjectHoldEnabled,
  subjectHoldRegionForMedia,
  buildSubjectHoldBlock
} = require('./videoProductAnchor');
const PLATFORM_FORMAT_ASPECT = Object.fromEntries(
  Object.entries(PLATFORM_FORMATS).map(([k, v]) => [k, v.aspectRatio])
);

// Per-model-family / per-destination default-prompt profiles. Static Ken
// Burns directives are authored once per profile so Omni (20k headroom),
// Grok (4,096), and hook_first (destination overlay on Omni) can be tuned
// independently; shared dynamic lines (operator lead, duration-scaled
// Timeline/Output, PRODUCT FIDELITY, compositing) stay in
// buildVeoPrompt. hook_first also adds aspect-aware Frame lines there.
const PROMPT_PROFILES = {
  'gemini-omni': {
    label: 'Gemini Omni default prompt',
    optimizedFor: [
      'google/gemini-omni-flash/image-to-video-developer',
      'google/gemini-omni-flash/reference-to-video-developer'
    ],
    promptByteBudget: 20000
  },
  'grok': {
    label: 'Grok default prompt',
    optimizedFor: [
      'xai/grok-imagine-video-v1.5/image-to-video',
      'xai/grok-imagine-video/reference-to-video'
    ],
    promptByteBudget: 4096
  },
  'hook_first': {
    label: 'Hook-first video prompt (Meta + Google PMax)',
    optimizedFor: [
      'meta_stories_9_16',
      'meta_reels_9_16',
      'meta_feed_4_5',
      'meta_feed_1_1',
      'pmax_video_9_16',
      'pmax_video_16_9',
      'pmax_video_1_1'
    ],
    // Renders on Omni under the hood — same 20k byte budget.
    promptByteBudget: 20000
  }
};

// Legacy profile key. 'pmax' was this profile's only name until the owner
// standardized Meta onto it (2026-08-18); accepted everywhere a profile name
// is read so an explicit override, a stored value, or an older harness keeps
// resolving to the same directives.
const PROFILE_ALIASES = { pmax: 'hook_first' };

function canonicalProfileName(name) {
  const n = String(name || '').trim();
  return PROFILE_ALIASES[n] || n;
}

// True for Google PMax video platformFormat keys (masters + derive-only).
// Destination is passed in — never sniffed from globals.
function isPmaxVideoDestination(platformFormat) {
  const f = String(platformFormat || '');
  return f.startsWith('pmax_video_');
}

// True for Meta platformFormat keys (meta_stories_9_16, meta_reels_9_16,
// meta_feed_4_5, meta_feed_1_1). buildVeoPrompt is only ever reached on the
// VIDEO render path, so any meta_* key arriving here is a video destination.
//
// Deliberately a PREFIX test rather than a PLATFORM_FORMATS kinds lookup: the
// capability table is edited by other work in flight (the single-9:16-master
// minting change), and profile selection must not silently move because a
// `kinds` array changed under it. Prefix matching is self-contained here and
// picks up any future meta_* surface automatically.
function isMetaVideoDestination(platformFormat) {
  return String(platformFormat || '').startsWith('meta_');
}

// Destinations that take the hook_first profile: BOTH platforms as of
// owner 2026-08-18. Kept as one predicate so the two platforms cannot drift.
function isHookFirstVideoDestination(platformFormat) {
  return isPmaxVideoDestination(platformFormat)
    || isMetaVideoDestination(platformFormat);
}

// Kill switch (default TRUE). Off → EVERY video destination falls through to
// the Omni/Grok profile selection: Meta returns to the frozen pre-#61
// gemini-omni text byte-for-byte, PMax returns to Phase A. That off-arm
// byte-identity IS the surviving PR #61 rollback guarantee — pinned by
// verifyPostPilotBatch B14/B15.
//
// TWO NAMES, AND EITHER ONE CAN KILL. VIDEO_HOOK_FIRST_PROMPT is the current
// name; PMAX_VIDEO_DIRECTIVES is the name that shipped in Phase B and may be
// set on the Render dashboard. The rule is "explicit 'false' on EITHER name
// disables", NOT "new name wins", because config/defaults.env is loaded with
// dotenv (no override): a Render override of the LEGACY name would be silently
// shadowed the moment anyone added the new name to defaults.env with a value.
// Fail-safe OR makes the backward-compatibility guarantee unbreakable by a
// later defaults.env edit. Blank/whitespace values count as unset.
const HOOK_FIRST_ENV_NAMES = ['VIDEO_HOOK_FIRST_PROMPT', 'PMAX_VIDEO_DIRECTIVES'];

function isHookFirstVideoPromptEnabled() {
  for (const name of HOOK_FIRST_ENV_NAMES) {
    const v = process.env[name];
    if (typeof v === 'string' && v.trim() !== '' && v.trim().toLowerCase() === 'false') {
      return false;
    }
  }
  return true;
}

// Deprecated alias kept for call-site stability. Same switch, wider reach.
const isPmaxVideoDirectivesEnabled = isHookFirstVideoPromptEnabled;

// Select the default-prompt profile.
//   1. Explicit opts.promptProfile wins (harness / override), alias-resolved.
//   2. Meta OR PMax video destination + kill switch on → 'hook_first'.
//   3. Else paramShape starting with 'gemini-omni' → gemini-omni;
//      'grok' → grok; anything else (veo/generic) → grok.
// Second arg is optional: absent opts (no destination) still resolves to the
// frozen gemini-omni/grok path exactly as before — that is the legacy
// scaffold / aiVideoReferenceService / B14 contract and must not move.
function promptProfileFor(caps, opts = null) {
  const o = opts && typeof opts === 'object' ? opts : {};
  if (typeof o.promptProfile === 'string' && o.promptProfile.trim()) {
    return canonicalProfileName(o.promptProfile);
  }
  const dest = o.platformFormat || o.destination || null;
  if (isHookFirstVideoDestination(dest) && isHookFirstVideoPromptEnabled()) {
    return 'hook_first';
  }
  const shape = String(caps?.paramShape || '');
  if (shape.startsWith('gemini-omni')) return 'gemini-omni';
  if (shape.startsWith('grok')) return 'grok';
  return 'grok';
}


function archetypeDescription(arch) {
  const map = {
    full_bleed_hero_bottom_panel: 'cinematic full-frame hero shot, subject filling most of the frame',
    vertical_split:               'tight product-focused composition with clean negative space on one side',
    diagonal_carve:               'dynamic angular framing with energetic motion lines',
    typographic_dominant:         'minimal hero product shot with generous negative space (large text overlay will dominate the frame)',
    hero_quote_overlay:           'editorial hero frame, product as the calm focal point with open space for a quote overlay',
    magazine_editorial:           'magazine-spread aesthetic, product as an elegant inset with a clean editorial space beside it',
    stat_led_social_proof:        'centered product showcase, clean open composition, subject prominent',
    product_card_grid:            'crisp multi-product reveal'
  };
  return map[arch] || 'cinematic product shot';
}

// Converts "Person (Florist)" → "florist", "Person (Model)" → "model", etc.
function naturalizeLabel(label) {
  const m = String(label).match(/^Person \((.+)\)$/i);
  return m ? m[1].toLowerCase() : label.toLowerCase();
}

// Resolves subject identity, frame position, and vertical bounds from
// the detect pipeline or layoutInput.product.description. Returns null
// when no subject data exists.
//
// vSpan is the load-bearing field for storyboard text positioning —
// it captures what fraction of the vertical canvas the subject occupies.
// Without it, storyboard picks position enums blindly (e.g. lower_third)
// even when the subject fills the whole vertical canvas, forcing chrome
// to override every position downstream. vSpan lets the storyboard
// choose positions that don't collide with the subject in the first place.
function resolveSubject({ layoutInput, sourceMedia, media }) {
  const subjects   = sourceMedia?.subjects || [];
  const detectLabel = subjects[0]?.label
    || media?.primarySubjectLabel
    || media?.classification?.primarySubjectLabel;
  const richDesc   = layoutInput?.product?.description || null;
  const label      = detectLabel || (richDesc ? 'subject' : null);
  if (!label) return null;

  // Prefer detect-pipeline bboxes (richer schema with x1/y1/x2/y2 OR
  // bbox_pct). Fall back to media.subjects when sourceMedia is absent
  // — same shape on the Media doc with x1/y1/x2/y2.
  let bbox = subjects[0]?.bbox_pct || null;
  let yTop = null, yBottom = null;
  if (bbox) {
    yTop = bbox.y;
    yBottom = bbox.y + bbox.h;
  } else if (subjects[0] && Number.isFinite(subjects[0].y1) && Number.isFinite(subjects[0].y2)) {
    yTop = subjects[0].y1;
    yBottom = subjects[0].y2;
  } else {
    const m = (media?.subjects || []).find(s => s?.role === 'primary' || !s?.role);
    if (m && Number.isFinite(m.y1) && Number.isFinite(m.y2)) {
      yTop = m.y1;
      yBottom = m.y2;
    }
  }

  let hPos = null;
  if (bbox) {
    const cx = bbox.x + bbox.w / 2;
    hPos = cx < 0.35 ? 'left' : cx > 0.65 ? 'right' : 'center';
  } else if (subjects[0] && Number.isFinite(subjects[0].x1) && Number.isFinite(subjects[0].x2)) {
    const cx = (subjects[0].x1 + subjects[0].x2) / 2;
    hPos = cx < 0.35 ? 'left' : cx > 0.65 ? 'right' : 'center';
  } else {
    // Mirror vSpan fallback: when sourceMedia is absent, derive hPos
    // from the primary entry in media.subjects (x1/x2 shape).
    const m = (media?.subjects || []).find(s => s?.role === 'primary' || !s?.role);
    if (m && Number.isFinite(m.x1) && Number.isFinite(m.x2)) {
      const cx = (m.x1 + m.x2) / 2;
      hPos = cx < 0.35 ? 'left' : cx > 0.65 ? 'right' : 'center';
    }
  }

  const vSpan = (yTop != null && yBottom != null)
    ? { top: yTop, bottom: yBottom }
    : null;

  return { label: naturalizeLabel(label), richDesc, hPos, vSpan };
}

// ── GEMINI OMNI default prompt — optimized for google/gemini-omni-flash/* (20,000-byte cap) ──
// CURRENT verbose phrasing verbatim — authored against the Omni default's 20k headroom.
const OMNI_DIRECTIVES = {
  role:
    `Role: Professional product commercial editor. Animate the supplied product photos with virtual camera movement only — ` +
    `do NOT generate, recreate, or alter imagery. The supplied images are the source of truth.`,
  objective:
    // Duration-agnostic (the Timeline/Output lines carry the requested
    // length) — the original "8-second" phrasing predates variable
    // durations and would contradict a 4s/15s render.
    `Objective: Create a premium product commercial using subtle Ken Burns camera moves. ` +
    `Must feel luxury while keeping 100% fidelity to the original product.`,
  sourceImages: `Source images: Use only the supplied images as provided.`,
  productPreservation:
    `Product preservation (highest priority): Treat each image as a locked photograph. The product must stay identical. ` +
    `Do NOT recreate, redraw, regenerate, enhance, sharpen with generative fill, or use AI on any part. ` +
    `Do NOT change colors, stitching, textures, materials, logos, shape, or proportions, or alter lighting, shadows, or reflections. ` +
    `Do NOT add or remove any part or detail. The only motion is the virtual camera.`,
  transitions: `Transitions: Smooth crossfades only, ~0.25s. No wipes, flashes, or animated transitions.`,
  cameraStyle:
    `Camera style: Luxury, slow, elegant, stable. Ease in/out. ` +
    `No shake, handheld, parallax, simulated 3D, orbit, or object movement. The product stays completely static.`,
  background: `Background: Preserve exactly. Do NOT replace, extend, blur, or hallucinate missing areas.`,
  visualStyle:
    `Visual style: Minimal, clean, photorealistic, high-end ecommerce. ` +
    `Crisp focus, natural lighting only. No color grading, bloom, or lens flares.`,
  audio: `AUDIO: natural ambience matching the scene; no music, no dialogue, no voiceover.`,
  noText:
    `CRITICAL: Do NOT render any text, typography, logos, badges, watermarks, or captions that are not already part of the supplied photographs. ` +
    `Text and logos physically present on the product in the source images are fine to show — do not generate any new text or graphics. ` +
    `All ad copy is composited downstream. Any generated text in the video causes rejection.`,
  physicalAccuracy:
    `PHYSICAL ACCURACY: Any person visible must remain anatomically correct — 5-fingered hands, symmetric matching eyes, ` +
    `natural skin texture, real body proportions. No extra digits, warped features, or impossible angles. ` +
    `If the photographs show a person, preserve their face, hair, skin tone, and identity throughout — no morphing mid-shot.`,
  // FULL ROLLBACK OF 134db56's PROMPT CHANGES — OWNER-DIRECTED (2026-08-03).
  // Owner, verbatim: "This is creating additional hallucinations and the
  // previous output was better." All THREE of 134db56's camera-prompt changes
  // are reverted, so this directive set is byte-identical to 134db56~1:
  //   1. Scene 3 "RETURN TO THE PRIMARY VIEW" + the two PRODUCT FIDELITY
  //      sentences about the FINAL reference repeating the primary view.
  //   2. The subjectContinuity directive (both OMNI and GROK sets, plus its
  //      lines.push in buildVeoPrompt). It demanded one continuous person
  //      pose/orientation across scenes while the reference stack legitimately
  //      carries a BACK view the owner wants for product fidelity — the model
  //      could only satisfy both by inventing intermediate body/face pixels.
  //   3. The crossfade-vs-long-dissolve policy. Consequence, which is
  //      DELIBERATE — DO NOT "FIX": `transitions` above permits "Smooth
  //      crossfades only, ~0.25s" while `doNot` below bare-bans "dissolves",
  //      and a crossfade IS a short dissolve. This contradictory pair is the
  //      version that produced the better output; matching the known-good
  //      prompt outranks internal tidiness. Do not soften, split, or reword
  //      either string to resolve it.
  // Pinned by scripts/verifyPostPilotBatch.js, CHANGE 2 block (B1–B14). B14 is
  // the end-to-end pin: it rebuilds the prompt from the 134db56~1 source read
  // out of git and asserts this builder emits a byte-identical string.
  doNot:
    `Do NOT: regenerate/morph/warp/bend the product, hallucinate geometry, invent textures, change branding/logos/stitching/colors, ` +
    `create fake shadows/reflections/depth, animate the product or any of its parts, use generative fill, or create new backgrounds. ` +
    `No fantasy motion — no sparkles, particles, lens flares, floating props, morphing, or dissolves.`
};

// ── GROK default prompt — optimized for xai/grok-imagine-video-v1.5/image-to-video (4,096-byte cap) ──
// Compact re-authoring of the SAME directives (same rules, tighter sentences —
// no meaning changes, no new creative direction). Sized so a typical full
// prompt lands well under 4,096 bytes without relying on DROP_PRIORITY.
const GROK_DIRECTIVES = {
  role:
    `Role: Product commercial editor. Animate supplied photos with virtual camera only — ` +
    `do NOT generate, recreate, or alter imagery. Supplied images are source of truth.`,
  objective:
    `Objective: Premium Ken Burns product commercial. Luxury feel, 100% fidelity to the original product.`,
  sourceImages: `Source images: Use only the supplied images as provided.`,
  productPreservation:
    `Product preservation (highest priority): Each image is a locked photograph; product stays identical. ` +
    `Do NOT recreate, redraw, regenerate, enhance, generative-fill, or AI-alter any part. ` +
    `Do NOT change colors, stitching, textures, materials, logos, shape, proportions, lighting, shadows, or reflections. ` +
    `Do NOT add or remove detail. Only motion is the virtual camera.`,
  transitions: `Transitions: Smooth crossfades ~0.25s only. No wipes, flashes, or animated transitions.`,
  cameraStyle:
    `Camera style: Luxury, slow, elegant, stable. Ease in/out. ` +
    `No shake, handheld, parallax, 3D, orbit, or object movement. Product stays static.`,
  background: `Background: Preserve exactly. Do NOT replace, extend, blur, or hallucinate areas.`,
  visualStyle:
    `Visual style: Minimal, clean, photorealistic, high-end ecommerce. ` +
    `Crisp focus, natural light only. No grading, bloom, or flares.`,
  audio: `AUDIO: natural ambience matching the scene; no music, no dialogue, no voiceover.`,
  noText:
    `CRITICAL: Do NOT render text, typography, logos, badges, watermarks, or captions not already in the supplied photographs. ` +
    `On-product text/logos in source images may show — generate no new text or graphics. ` +
    `Ad copy is composited downstream. Generated text causes rejection.`,
  physicalAccuracy:
    `PHYSICAL ACCURACY: Persons must stay anatomically correct — 5-fingered hands, symmetric eyes, ` +
    `natural skin, real proportions. No extra digits, warped features, or impossible angles. ` +
    `Preserve face, hair, skin tone, identity — no mid-shot morphing.`,
  doNot:
    `Do NOT: regenerate/morph/warp/bend the product, hallucinate geometry, invent textures, change branding/logos/stitching/colors, ` +
    `fake shadows/reflections/depth, animate the product or parts, use generative fill, or create new backgrounds. ` +
    `No fantasy motion — no sparkles, particles, flares, floating props, morphing, or dissolves.`
};

// ── HOOK-FIRST video prompt — destination profile for META *and* PMAX ─────
// Was PMAX_DIRECTIVES (pmax_video_* only). OWNER-DIRECTED STANDARDIZATION
// 2026-08-18, verbatim: "I want to use the PMax prompt for Meta also, and
// standardize on that but maintain a single minting for 9x16 across both
// formats. Continue to mint a 16x9." Meta video destinations now select this
// profile too.
//
// Starts from OMNI_DIRECTIVES (proven Meta text). Changes ONLY what the
// destination requires: hook-first objective, centre-safe camera. Fidelity
// / noText / physicalAccuracy / productPreservation are referenced from
// OMNI so they cannot drift. Timeline + aspect Frame lines are assembled
// in buildVeoPrompt when profile === 'hook_first'. Kill switch:
// VIDEO_HOOK_FIRST_PROMPT / PMAX_VIDEO_DIRECTIVES = false restores the
// Omni/Grok path for BOTH platforms — Meta back to the frozen pre-#61 text
// byte-for-byte, PMax back to Phase A.
//
// THE DIRECTIVE TEXT BELOW IS WHAT THE OWNER STANDARDIZED ON — do not reword
// it to "improve" it. It is deliberately aspect-neutral and platform-neutral;
// nothing here may name a platform, because one string now serves both.
// DO NOT import PR #61 rollback text. DO NOT touch OMNI_DIRECTIVES.
const HOOK_FIRST_DIRECTIVES = {
  role:
    `Role: Professional product commercial editor. Animate the supplied product photos with virtual camera movement only — ` +
    `do NOT generate, recreate, or alter imagery. The supplied images are the source of truth.`,
  objective:
    `Objective: Create a premium product commercial using subtle Ken Burns camera moves. ` +
    // Aspect-neutral AND platform-neutral by design: this one profile serves
    // the landscape and vertical masters on BOTH Meta and PMax, and the
    // aspect-specific direction is the Frame line assembled in buildVeoPrompt.
    // Naming one aspect here (an earlier draft said "swipe-away vertical") is
    // simply false on the other master and gives the model a contradictory
    // cue; naming one PLATFORM is now false for the same reason. "This
    // surface" is deliberately generic and is true of Meta Stories/Reels
    // (swipe-away, hook in the first second — see their creativeBriefs in
    // platformFormats.js) exactly as it is of YouTube Shorts.
    `HOOK-FIRST: this surface is skipped or scrolled past in seconds — the product must be identifiable within the first 2 seconds; the opening frames carry the whole ad. ` +
    `Must feel luxury while keeping 100% fidelity to the original product.`,
  // Shared fidelity block — reference, do not re-author (drift guard).
  sourceImages: OMNI_DIRECTIVES.sourceImages,
  productPreservation: OMNI_DIRECTIVES.productPreservation,
  transitions: OMNI_DIRECTIVES.transitions,
  cameraStyle:
    `Camera style: Luxury, slow, elegant, stable. Ease in/out. ` +
    `Centre-safe composition: keep the product and any focal detail within the central region of the frame — ` +
    `away from the top and bottom bands and the outer side margins, where the platform overlays UI. ` +
    `No shake, handheld, parallax, simulated 3D, orbit, or object movement. The product stays completely static.`,
  background: OMNI_DIRECTIVES.background,
  visualStyle: OMNI_DIRECTIVES.visualStyle,
  audio: OMNI_DIRECTIVES.audio,
  noText: OMNI_DIRECTIVES.noText,
  physicalAccuracy: OMNI_DIRECTIVES.physicalAccuracy,
  doNot: OMNI_DIRECTIVES.doNot
};

function directivesForProfile(profile) {
  const p = canonicalProfileName(profile);
  if (p === 'hook_first') return HOOK_FIRST_DIRECTIVES;
  if (p === 'gemini-omni') return OMNI_DIRECTIVES;
  return GROK_DIRECTIVES;
}

// ── LIFESTYLE video directives — SIBLING of OMNI_DIRECTIVES (flag-gated) ──
// Selected only when VIDEO_LIFESTYLE_PROMPT=true AND the seed is lifestyle.
// Does NOT alter a single byte of OMNI_DIRECTIVES / GROK_DIRECTIVES / the
// existing packshot assembly path. B14 still pins the packshot path against
// 134db56~1; lifestyle is a parallel branch on a new input (seedStyle).
//
// Owner 2026-08: lifestyle video brings a real captured moment to life with
// the product as the star. Ambient life is wanted; product morph and fantasy
// motion are still banned. Multi-reference stacks are packshot-only — lifestyle
// ships ONE ref (the seed). See buildReferenceImages / resolveLifestyleVideoRefCount.
// Plate wording note (Lane O / owner 2026-08): buildReferenceImages may already
// have run reframeReferenceForAspect (generative fit) on the seed BEFORE this
// prompt is submitted. The image AS HANDED TO THE MODEL is final — do not tell
// the model the original capture is untouched, and do not licence further
// extension. Upstream fit is not licence to continue extending.
const LIFESTYLE_DIRECTIVES = {
  role:
    `Role: Lifestyle motion editor. Bring the lifestyle photograph to life as an authentic, lived-in moment — ` +
    `do NOT rebuild, restyle, restage, recompose, or replace the scene. ` +
    `The image as handed to you is the finished plate and source of truth — it may already have been fitted to this aspect upstream; ` +
    `do NOT further extend, restyle, or recompose it. That upstream fit is not licence to continue extending.`,
  objective:
    `Objective: Animate the real captured moment so the product is the star. Authentic, editorial, documentary-adjacent — ` +
    `not a staged luxury product commercial. Ambient life that was already implicit in the photograph may move. ` +
    `Product fidelity means IDENTITY (form, construction, materials, surface, colour, branding) is absolute frame to frame — not immobility. ` +
    `A worn garment may shift with breath or body motion as a real garment would; a rigid product (bottle, shoe sole, device) does not deform.`,
  sourceImages: `Source images: Use only the image as handed to you. One lifestyle seed — do not invent additional views, and do not further extend or reframe it.`,
  productPreservation:
    `Product preservation (highest priority — never relaxes): The product's IDENTITY is absolute and unchanged frame to frame — ` +
    `form, construction, materials, surface, colour, branding, logos, stitching, proportions, and any on-item graphics never change. ` +
    `Do NOT recreate, redraw, regenerate, morph, warp, stretch, re-drape into a different shape or a different garment, re-pose, ` +
    `enhance with generative fill, or AI-alter any part of the product. Do NOT invent alternate product geometry. ` +
    `The product may move ONLY as the real physical item would, as a consequence of the wearer's or scene's motion — ` +
    `a worn garment shifting with a breath or weight transfer, a strap settling. It is never independently animated, ` +
    `never re-posed by the model, never regenerated. ` +
    `For a rigid or hard-goods product (bottle, shoe, device, hard packaging) the practical effect is unchanged: it does not deform, bend, flex, or change shape — only whole-object camera-relative motion is allowed, never material deformation.`,
  transitions: `Transitions: Prefer a single continuous shot. If a cut is unavoidable, smooth crossfades only, ~0.25s. No wipes, flashes, or animated transitions.`,
  cameraStyle:
    `Camera style: Gentle motion appropriate to a real scene — as a human-operated camera would move. Ease in/out. ` +
    `The frame may drift, push, or settle to find and hold the product. ` +
    `No whip pans, no simulated 3D, no parallax, no synthesized 2.5D depth pop, no orbit around the subject, no shake, no aggressive handheld. ` +
    `A real camera drifting is fine; a fabricated multi-plane depth effect is not. ` +
    `Camera finds and holds the product as the star; ambient life is context around it, never competing with it.`,
  background:
    `Background / scene identity: Preserve THAT scene exactly as handed to you. Do NOT replace, further extend, blur, recolour, or invent a second location. ` +
    `No new environments, no environment replacement, no restaging. The plate may already include edge-fit from upstream; do not extend it further.`,
  visualStyle:
    `Visual style: Authentic, editorial, documentary-adjacent, photorealistic. Natural light as in the photograph. ` +
    `No colour grading, bloom, lens flares, or luxury-ecommerce polish. Lived-in, not staged.`,
  audio: `AUDIO: natural ambience matching the scene; no music, no dialogue, no voiceover.`,
  noText:
    `CRITICAL: Do NOT render any text, typography, logos, badges, watermarks, or captions that are not already part of the supplied photograph. ` +
    `Text and logos physically present on the product in the source image are fine to show — do not generate any new text or graphics. ` +
    `All ad copy is composited downstream. Any generated text in the video causes rejection.`,
  physicalAccuracy:
    `PHYSICAL ACCURACY (heightened — people in motion fail here first): Any person visible must remain anatomically correct — 5-fingered hands, symmetric matching eyes, ` +
    `natural skin texture, real body proportions. No extra digits, warped features, or impossible angles. ` +
    `Preserve face, hair, skin tone, and identity throughout with no mid-shot morphing. ` +
    `Hands and faces are the highest-risk failure mode when motion is allowed — keep them correct every frame.`,
  ambientLife:
    `AMBIENT LIFE (the point of this path): hair moving in air, a subtle weight shift or breath, steam, water, foliage, and fabric motion ` +
    `that a real garment or soft material would show as a consequence of the wearer's or scene's motion — never independent product animation, ` +
    `never morphing the product into a different shape or garment. Ambient life is context around the product, never competing with it.`,
  doNot:
    `Do NOT: regenerate/morph/warp/stretch/re-drape the product, invent geometry, invent textures, change branding/logos/stitching/colors, ` +
    `create fake shadows/reflections/depth or parallax, independently animate the product (motion only as a real item would move with the wearer/scene), ` +
    `use generative fill, further extend the plate, or create new backgrounds. ` +
    `No fantasy motion — no sparkles, particles, lens flares, floating props, morphing objects, or invented objects. ` +
    `No second location. No wardrobe, prop, or environment changes beyond ambient motion already implicit in the plate. ` +
    `Do not bend, flex, or deform rigid/hard-goods products.`
};

/**
 * VIDEO_LIFESTYLE_PROMPT kill switch — default OFF.
 * Exact string 'true' enables; unset/empty/false stay off so packshot
 * prompts and reference counts stay byte-identical to today.
 */
function isVideoLifestylePromptEnabled() {
  return process.env.VIDEO_LIFESTYLE_PROMPT === 'true';
}

/**
 * VIDEO_PROMPT_UI_CHROME_GUARD kill switch — default ON.
 *
 * Added 2026-08-19 after a P0: both Omni masters in
 * run_1787174963435_ff67021e (Marine Layer 2, "Cut & Sew Bode Puffer
 * Jacket") hallucinated a fake product-detail-page header/footer — a nav
 * bar with a hamburger icon, garbled pseudo-text, a shopping-bag icon, and
 * a footer repeating the (correctly-spelled) real product name beside more
 * garbled text — directly into the video plate, BEFORE Remotion titling
 * ever touched the frame (confirmed against the raw pre-titling
 * veoVideoUrl, not just the delivered renderUrl). The seed/reference
 * images for that ad were verified clean catalog product photography, no
 * PDP/storefront screenshot anywhere in the stack — so this is a model
 * hallucination, not a bad seed.
 *
 * `noText` (OMNI_DIRECTIVES / GROK_DIRECTIVES, both frozen — see the PR #61
 * rollback note in CLAUDE.md §00) already bans generating new text,
 * typography, logos, badges, watermarks, and captions, and Omni still
 * violated it — but `noText` never named UI/app/webpage CHROME as its own
 * category (nav bars, menus, icons, buttons are graphic elements, not
 * strictly "text"), so an icon-heavy hallucination had no explicit line to
 * violate for half of what it rendered.
 *
 * This is a SEPARATE, ADDITIVE prompt line — deliberately NOT folded into
 * OMNI_DIRECTIVES / GROK_DIRECTIVES / HOOK_FIRST_DIRECTIVES, which must stay
 * byte-identical to `134db56~1` (scripts/verifyPostPilotBatch.js B1-B17).
 *
 * VERIFIED LIVE 2026-08-19, same day: shipped OFF first (unverified — a live
 * submit is ~$0.90 and non-refundable), then a real Omni submit was run
 * against this EXACT incident's product/brand/seed stack
 * (run_1787174963435_ff67021e, referenceMediaIds unchanged, flag forced
 * true) — predictionId `3e579bc492bd4da785d77316c8011c3c`, Atlas-settled
 * price `$0.90` (confirmed via GET /model/prediction/{id}; the CostLog
 * write itself failed that run due to an unrelated Mongo Atlas storage-quota
 * outage — see session.md). Frames pulled from the raw pre-titling video at
 * 0.1/0.3/0.5/0.8/1.2/2.5s — including t=0.1s and t=0.5s, exactly where the
 * original defect was visible — show NO nav bar, icons, or garbled text at
 * any sampled point. Flipped to default true on that evidence. Flip back to
 * 'false' (or unset) to instantly revert to the byte-identical pre-fix
 * prompt if a future case regresses.
 */
function isVideoUiChromeGuardEnabled() {
  return process.env.VIDEO_PROMPT_UI_CHROME_GUARD === 'true';
}

// Kept OUTSIDE every directive object on purpose (see
// isVideoUiChromeGuardEnabled above) so OMNI_DIRECTIVES / GROK_DIRECTIVES /
// HOOK_FIRST_DIRECTIVES never change a byte. Names the failure mode
// concretely (nav bar, hamburger/bag icons, screenshot/mockup) rather than
// only repeating the generic "no text" ban noText already states.
const UI_CHROME_GUARD_LINE =
  `Do NOT render any user-interface, app, or website elements anywhere in the frame — no navigation bars, menus, ` +
  `hamburger icons, shopping-cart/bag icons, buttons, price tags, banners, or any screen-within-the-screen. ` +
  `This is a real-world camera shot of a physical product, never a screenshot, mockup, or render of a web page or app.`;

// KILL SWITCH: VIDEO_RAW_CATALOG_REFERENCES, DEFAULT OFF. Same name as
// atlasVideoService — duplicated here so this file does not require the
// video service (cycle). When on, lifestyle role/sourceImages drop the
// "fitted to this aspect upstream" claim because we no longer reframe.
function isVideoRawCatalogReferencesEnabled() {
  const raw = process.env.VIDEO_RAW_CATALOG_REFERENCES;
  if (raw == null || String(raw).trim() === '') return false;
  return !/^(0|false|no|off)$/i.test(String(raw).trim());
}

const RAW_CATALOG_LIFESTYLE_ROLE =
  `Role: Lifestyle motion editor. Bring the lifestyle photograph to life as an authentic, lived-in moment — ` +
  `do NOT rebuild, restyle, restage, recompose, or replace the scene. ` +
  `The image as handed to you is the catalog photograph at native resolution and the source of truth. ` +
  `Output aspect is a separate parameter — do NOT crop, pad, letterbox, or reframe the product to fill the frame, and do NOT extend the scene.`;
const RAW_CATALOG_LIFESTYLE_SOURCE_IMAGES =
  `Source images: Use only the image as handed to you. One lifestyle seed at native catalog resolution — ` +
  `do not invent additional views, and do not crop, pad, or reframe it.`;

/**
 * Lifestyle video prompt branch is active only when the flag is on AND
 * (seed is lifestyle OR variantKind is ugc). Matches static preserve trigger
 * so a UGC video with an unclassified seed does not stay on packshot Ken Burns
 * while its static sibling preserves. Packshot product_image never takes it.
 */
function shouldUseLifestyleVideoPrompt(seedStyle, variantKind = null) {
  if (!isVideoLifestylePromptEnabled()) return false;
  // MEDIA PATH ONLY (owner, 2026-08-11): "make sure that the only things going
  // into it right now are images through the media path not through the
  // product images path."
  //
  // Ad.variantKind is a required enum of exactly ['product_image','ugc'], so
  // 'ugc' IS the media path and 'product_image' IS the product images path.
  // Testing for 'ugc' therefore expresses the rule exactly, with no third
  // state to reason about in production.
  //
  // WHAT WAS REMOVED, and why it mattered: `seedStyle === 'lifestyle'` used to
  // also open this branch. resolveSeedStyle maps BOTH 'lifestyle' AND
  // 'on_model' into the lifestyle bucket (imageShotHeuristicService
  // LLM_LIFESTYLE), and an on-model catalog packshot — activewear photographed
  // on a person, i.e. most of an apparel catalogue — is a PRODUCT shot. So for
  // brands like GymShark essentially every product-path seed took this branch
  // without anyone selecting it. Because the branch caps references to 1, the
  // operator's three picks were then discarded. Observed live:
  //   "lifestyle video path caps references to 1 (seed only; 3 operator picks reduced)"
  //
  // The classification itself is intentionally NOT touched: LLM_LIFESTYLE is
  // shared with the STATIC preserve path, and re-bucketing on_model there
  // would change static behaviour nobody asked to change. That work — plus an
  // operator-facing control — is tracked separately.
  return variantKind === 'ugc';
}

/**
 * Lifestyle video ships exactly ONE reference (the seed). Multi-ref is a
 * packshot fidelity device; stacking lifestyle frames + motion melts hands.
 * Pure: returns 1 when lifestyle path is active, else the provided base count.
 */
function resolveLifestyleVideoRefCount(baseCount, seedStyle, variantKind = null) {
  if (shouldUseLifestyleVideoPrompt(seedStyle, variantKind)) return 1;
  return baseCount;
}

/**
 * Pure plan for lifestyle ref/submit wiring. generateForAd must use these
 * fields (not re-derive a parallel count) so a discarded resolveLifestyleVideoRefCount
 * call cannot leave the stack at 3 refs. Harness V6 asserts this plan.
 */
function resolveLifestyleVideoRefPlan({ baseReferenceCount, seedStyle, variantKind = null } = {}) {
  const lifestyleVideo = shouldUseLifestyleVideoPrompt(seedStyle, variantKind);
  const base = Number.isFinite(baseReferenceCount) && baseReferenceCount >= 1
    ? baseReferenceCount
    : 3;
  return {
    lifestyleVideo,
    // Effective count actually passed to buildReferenceImages.
    referenceCount: lifestyleVideo ? 1 : base,
    // When true, ordered multi-pick stacks are cleared (seed only) and
    // hasProductReference is forced false (seed-only fidelity wording).
    forceSeedOnly: lifestyleVideo
  };
}

/**
 * Director creative room for lifestyle video — one snippet per real intent.
 * Prepended as OPERATOR REFINEMENT via videoPromptGuidance when the cascade
 * has no more-specific value. ≤600 chars; no copy, offers, or text instructions
 * (titling is Remotion from ad.copy).
 */
const LIFESTYLE_VIDEO_GUIDANCE = {
  product_first_lifestyle:
    'Lifestyle seed: gentle authentic motion. Find and hold the product as the star; let fabric, hair, breath, or environment life already in the frame move softly as a real scene would. Mood: open, lived-in, unhurried. No hard sell energy. No fantasy motion. Product identity absolute — no morph, no re-drape, no independent product animation; worn fabric may shift with the wearer.',
  social_proof_led:
    'Lifestyle seed: calm, trustworthy motion. Camera settles on the product already in the real scene; ambient life stays secondary so the plate feels credible, not staged. Hold product readability. Soft editorial pacing. No fantasy particles. Product identity absolute — natural wearer/scene motion only, never morph or regenerate.',
  objection_resolved:
    'Lifestyle seed: clarifying, considered motion. Prefer a slow find of the product-in-use beat already visible in the photo; gentle hold on construction or fit detail the plate already shows. Mood: confident, not urgent. Ambient only. Product identity absolute — may move only as the real item would with the wearer/scene; never independently animated or morphed.',
  brand_led:
    'Lifestyle seed: brand-world mood without restyling the photo. Gentle camera that keeps the product star-readable while ambient life breathes. Editorial, on-brand restraint — not a staged luxury product-commercial pan. No fantasy motion. Product identity absolute — no morph, no re-drape; rigid goods stay undeformed.'
};

function lifestyleVideoGuidanceForIntent(intentKey) {
  const key = String(intentKey || '');
  return LIFESTYLE_VIDEO_GUIDANCE[key] || LIFESTYLE_VIDEO_GUIDANCE.product_first_lifestyle;
}

// Main export. Builds the camera-only "Ken Burns" video prompt for the
// AI model. All text choreography is handled by the chrome compositor
// downstream — the prompt MUST NOT contain any "render this text"
// directives.
//
// layoutInput is LayoutInputArtifact.input. sourceMedia is
// layoutInput.input.source_media from the detect pipeline. Both are
// optional and currently unused by the fixed prompt core, but stay in
// the signature for call-site stability (resolveSubject still consumes
// them for other callers).
//
// storyboard — accepted for signature compatibility but NOT consumed:
// the Ken Burns spec fully defines camera + timeline, and audio uses a
// fixed default. caps is the resolved model's MODEL_CAPS entry;
// caps.promptByteCap drives the size cap (4096 when absent).
// Static directive phrasing comes from OMNI / GROK / PMAX via
// promptProfileFor(caps, { platformFormat }); shared dynamic lines stay
// below. aspectRatio is used ONLY on the pmax profile (Frame line).
// platformFormat / destination / promptProfile select the profile;
// absent → today's Meta/Omni/Grok behaviour exactly.
// THE video prompt. Measured winner of the 2026-09-02/03 comparison — see the
// long note at its push site inside buildVeoPrompt for why this replaced
// 14,883 bytes of directive objects and what that deliberately gave up.
//
// Byte-exact to the measured artifact
// (scratchpad/gemini-direct/native-generic/CORE.txt, 1159 B,
// sha256 67899bcfdf16…) EXCEPT the leading duration, which is interpolated
// so the prompt can never claim a length the render is not. At the
// production default of 10s this function reproduces that file byte-for-byte
// — pinned by scripts/verifyCorePrompt.js, which holds the sha256 rather
// than a paraphrase.
//
// DO NOT reword this to tidy it up. Two precedents: PR #61 hardened the video
// prompt and was rolled back in full ("the previous output was better"), and
// static-fidelity-block-ab measured rewriting a fidelity block as a NULL
// RESULT across 4 cells. It also deliberately says "Meta" on PMax
// destinations — kept because that is the text that was measured. Test a
// variant against this one; do not edit it in place.
function corePromptText(durationSec) {
  const secs = Number(durationSec) > 0 ? Number(durationSec) : 10;
  const dur = Number.isInteger(secs) ? String(secs) : secs.toFixed(1);
  return (
    `${dur}-second premium Meta product commercial. Photoreal. Social-ad energy is welcome: camera may push, pull, pan, orbit, or cut; a wearer may turn, walk, or shift weight. None of that is a problem.\n` +
    `\n` +
    `The product surface is the only hard lock. The supplied photos are the sole source of truth for every logo, wordmark, printed letter, graphic, seam, stitch, zipper, button, grommet, drawcord, mesh panel, hardware, and colourway. Copy those marks from the photos. Do not redraw, restyle, sharpen-with-fill, or substitute a "similar" icon.\n` +
    `\n` +
    `Spell on-garment text from the photos exactly as printed. Do not improvise competing brands, extra slogans, extra icons, extra sleeve prints, extra neck labels, or extra waistband lines. If a surface is blank on the catalog stills, keep it blank.\n` +
    `\n` +
    `When photos disagree, the dedicated product-only catalog still wins over on-model or lifestyle frames.\n` +
    `\n` +
    `No morphing product, no colour drift, no generative fill on logos. AUDIO: natural ambience only — no music, no voiceover, no dialogue. Do not add captions, UI, stickers, price tags, or any text that is not physically printed on the product. Ad copy is composited later.`
  );
}

function buildVeoPrompt({
  brand,          // eslint-disable-line no-unused-vars -- kept for call-site stability
  product,
  media,
  layoutInput = null,     // eslint-disable-line no-unused-vars
  sourceMedia = null,     // eslint-disable-line no-unused-vars
  aspectRatio = '1:1',
  hasProductReference = false,
  operatorPrompt = null,
  storyboard = null,      // eslint-disable-line no-unused-vars
  caps = null,
  durationSec = 8,        // per-ad render length (wizard format-selection stage)
  // Ad.platformFormat — hook_first destination selector. Meta AND PMax video
  // keys both select it since owner 2026-08-18; null/absent still resolves to
  // the frozen gemini-omni/grok path.
  platformFormat = null,
  destination = null,     // alias for platformFormat
  promptProfile = null,   // explicit profile override ('pmax' aliases to 'hook_first')
  // Lifestyle seed style + variantKind — NEW inputs. Absent/null → packshot
  // path unchanged (B14 matrix never passes these). Lifestyle/UGC +
  // VIDEO_LIFESTYLE_PROMPT → LIFESTYLE_DIRECTIVES sibling branch; OMNI/GROK
  // text is not edited. Lifestyle and hook_first are ORTHOGONAL: a hook_first
  // destination keeps hook-first timing + centre-safe/Frame treatment while
  // using lifestyle scene/motion directives.
  seedStyle = null,
  variantKind = null,
  // PMax 16:9 split-stage (2026-08). Absent/null → byte-identical to pre-
  // split output (same contract as REFRAME_PROMPT_HARDENING flag-off).
  // Active ONLY when subjectSide is 'east'|'west' AND aspect is 16:9 —
  // any other combo must not touch a single character of today's prompt.
  // east = subject on the RIGHT (copy panel left); west = mirror.
  // panelTreatment 'brand_panel' = opposite side is a flat brand-colour
  // backdrop; 'scene_extend' / null = continued calm scene. Callers gate
  // on PMAX_SPLIT_VIDEO; this builder never reads that env itself so a
  // forgotten flag cannot still leak split language via residual args.
  subjectSide = null,
  panelTreatment = null
}) {
  const lines = [];
  const lifestyle = shouldUseLifestyleVideoPrompt(seedStyle, variantKind);
  const profile = promptProfileFor(caps, {
    platformFormat: platformFormat || destination || null,
    destination: destination || null,
    promptProfile
  });
  // Lifestyle is a sibling directive set for scene/motion — it does NOT
  // suppress the hook-first destination profile. Packshot path still uses
  // profile selection exactly as before (B14).
  const dBase = lifestyle ? LIFESTYLE_DIRECTIVES : directivesForProfile(profile);
  const d = (lifestyle && isVideoRawCatalogReferencesEnabled())
    ? { ...dBase, role: RAW_CATALOG_LIFESTYLE_ROLE, sourceImages: RAW_CATALOG_LIFESTYLE_SOURCE_IMAGES }
    : dBase;
  // Orthogonal: hook-first destination treatment composes with lifestyle,
  // never gets dropped because the seed is lifestyle.
  //
  // TRUE FOR META AS WELL AS PMAX since owner 2026-08-18. Everything gated on
  // this flag below (hook-first timeline, centre-safe camera, aspect Frame
  // lines) is now emitted for Meta video destinations too — there is no
  // second code path. With the kill switch off, profile falls back to
  // gemini-omni and every one of those branches goes dark again, restoring
  // the frozen pre-#61 Meta text byte-for-byte.
  const isHookFirst = profile === 'hook_first';
  // Used by the hook-first timeline only. The gemini-omni (kill-switch-off)
  // timeline stays frozen and must NOT become aspect-aware — that frozen
  // arm is what the PR #61 rollback note above still protects.
  const isVerticalAspect = String(aspectRatio || '') === '9:16';
  // Split-stage gate. 16:9-only: a 9:16 ad with subjectSide set must stay
  // on today's centre-safe path (vertical already has no lateral pan, and
  // a side-anchored subject on portrait would fight the engagement rail).
  // Strict string match — truthy non-enum values must not activate split
  // (same fail-closed pattern as force === true on IG re-scan).
  const isSplit = (subjectSide === 'east' || subjectSide === 'west')
    && String(aspectRatio || '') === '16:9';
  // Human-readable side labels for the directives. east→right / west→left
  // is the owner convention (subject band vs opposite calm panel).
  const sideLabel = isSplit ? (subjectSide === 'east' ? 'right' : 'left') : null;
  const oppositeLabel = isSplit ? (subjectSide === 'east' ? 'left' : 'right') : null;
  const isBrandPanel = isSplit && panelTreatment === 'brand_panel';

  // Operator refinement (regeneration, and the lifestyle-guidance cascade).
  // Leads the prompt so the model sees the requested change early — but it
  // is SUBORDINATE, not supreme.
  //
  // INCIDENT THIS FIXES (2026-08-26). This block used to be labelled
  // "OPERATOR REFINEMENT (HIGHEST PRIORITY — overrides conflicting guidance
  // below)". Everything "below" includes `d.noText` (~:1100, forbids
  // rendering any text/logo not already in the photographs) and the
  // PRODUCT FIDELITY block (~:1131) — so arbitrary operator free text was
  // stamped as the single highest-priority directive and explicitly declared
  // to override the two inviolable constraints. Same defect class as the
  // catalog-title door closed at :787-799 (a product named "Vaportek" made
  // Omni fabricate a VAPORTEK chest lockup over the real PELAGIC fish-mark,
  // and vision-QC terminal-rejected the $0.90 master); this was the same bug
  // through the OPERATOR door — "make the Vaportek shirt pop" reproduces it
  // from the Regenerate button.
  //
  // THE RULE: fidelity and no-rendered-text constraints are inviolable.
  // Operator refinement STEERS WITHIN them; it never overrides them.
  // Steering is the whole point of the button, so the input is kept intact —
  // only the precedence is corrected. Reinforced by the CONSTRAINT SUPREMACY
  // block pushed as the LAST element of `lines` below (recency), emitted on
  // the same guard so the no-operator path stays byte-identical.
  //
  // LIFESTYLE_VIDEO_GUIDANCE (:636-650) also arrives through this same
  // `operatorPrompt` parameter via the guidance cascade
  // (atlasVideoService.js:4583-4592), so system-authored lifestyle guidance
  // gets the same fencing. Intended — it is mood/pacing direction and reads
  // correctly under the new framing — but note it means the lifestyle
  // GENERATE path also carries these two blocks' bytes.
  // FENCE, DO NOT FILTER. No keyword scrubber, brand-name blocklist, or
  // proper-noun detector — an evadable text filter is a losing game, and a
  // user naming their own brand is legitimate. Instead the operator's words
  // sit inside a delimited region whose framing declares them direction,
  // never content to draw. A determined operator can still write something
  // that reads like a render instruction: the fence is framing, not a parser,
  // and CONSTRAINT SUPREMACY below is what makes the constraints win.
  //
  // Assembled in three PIECES rather than one string so the byte budget at
  // the end of this function can drop the EXPLANATION while keeping the label,
  // the fence, and the supremacy block. Degrade the explanation, never the
  // constraint.
  const operatorTrim = operatorPrompt && String(operatorPrompt).trim();
  let operatorLineFull = null;
  let operatorLineCompact = null;
  let supremacyLine = null;
  if (operatorTrim) {
    // Neutralize OUR OWN control tokens if they appear in the operator's text.
    // Without this, one pasted delimiter closes the fence and the remainder
    // reads as top-level prompt (found by adversarial review). This is NOT the
    // content filter rejected above: it is a CLOSED two-token set that this
    // file defines, so there is no open-ended evasion space to chase. The
    // operator's own words are otherwise interpolated verbatim.
    const safeOperator = String(operatorTrim)
      .split(FENCE_OPEN).join('[delimiter removed]')
      .split(FENCE_CLOSE).join('[delimiter removed]');

    // SIZED DELIBERATELY. label + fence markers + supremacy must stay close to
    // the 274 bytes the old single-string wrapper cost, or a max-length
    // refinement on a 4,096-byte model stops fitting — a real regression this
    // change must not introduce (measured; see the budget block at the end of
    // this function). The long `framing` sentence is the only luxury, and it is
    // the piece the budget drops first.
    const label =
      `OPERATOR REFINEMENT (subordinate to the constraints below). `;
    const framing =
      `The fenced text is camera, motion, pacing, mood and framing direction for the existing scene — never content to draw, never text to render, never branding to add. A brand name inside it says which item to film, never a word to display. `;
    const fence = `${FENCE_OPEN} ${safeOperator} ${FENCE_CLOSE}`;

    operatorLineFull    = label + framing + fence;
    operatorLineCompact = label + fence;
    supremacyLine =
      `CONSTRAINT SUPREMACY: the no-rendered-text, no-invented-branding and PRODUCT FIDELITY constraints above are absolute and outrank this refinement — it may never add text, logos, badges or branding, or change the product identity. Ambient motion already permitted is unaffected.`;

    lines.push(operatorLineFull);
  }

  // ══════════════════════════════════════════════════════════════════════
  // CORE IS THE PROMPT (2026-09-03, owner-directed).
  //
  // Owner, verbatim: "no do it all now, this is what we spent 9 hours on!"
  // and "completely strip the old stuff out permanently."
  //
  // WHY. Nine hours of measured comparison on 2026-09-02/03: this single
  // 1,159-byte prompt (sha256 67899bcfdf16…, measured as
  // scratchpad/gemini-direct/native-generic/CORE.txt) beat the per-SKU
  // PRODUCT-MARKS prompts and the fidelity-block prompts on the thing that
  // actually matters — brand marks surviving intact. It rendered PELAGIC
  // correctly on the first try on the Chubasco jacket, where the
  // hand-written per-SKU marks prompts garbled it.
  //
  // The 14,883 bytes of directive objects this replaces are recorded here so
  // a revert is mechanical rather than archaeological — the text itself is
  // in git at 9e944c8:src/services/veoPromptBuilder.js:
  //     OMNI_DIRECTIVES        4595 B  sha256:07cee0fdcdde41c0
  //     GROK_DIRECTIVES        2430 B  sha256:bd6202cc7a4a3bd0
  //     HOOK_FIRST_DIRECTIVES  2167 B  sha256:c339ca14f0dd83e7
  //     LIFESTYLE_DIRECTIVES   5691 B  sha256:8c9560981ddee4c4
  //
  // THIS DELETES THE PR #61 ROLLBACK GUARANTEE, KNOWINGLY. §00 of both
  // repos' CLAUDE.md says the OMNI/GROK text is frozen byte-for-byte to
  // 9531ae9f and must never be reworded, because the owner rolled #61 back
  // saying "the previous output was better". That guarantee was enforced by
  // verifyPostPilotBatch B14/B15 — and B14 HAS BEEN SILENTLY SKIPPING:
  // its baseline relocation rewrote only require('./platformFormats') while
  // the baseline also requires './videoProductAnchor', so require() threw
  // MODULE_NOT_FOUND from the temp dir and the catch reported it as "git
  // unavailable", which is a misdirection. Forced to actually run, clean
  // origin/main failed it 102 of 236, with 42 of the failing blocks being
  // the seed-text overlay guard. So the frozen prompt had ALREADY drifted
  // from its own baseline on trunk. You cannot lose a guarantee you were
  // not holding — that, not the directive, is the real argument here.
  //
  // WHAT IS DELIBERATELY KEPT:
  //  • The operator-refinement lever above and the CONSTRAINT SUPREMACY line
  //    below — both are real product features, not prompt prose.
  //  • Ad.videoPromptRaw (full replacement, upstream of this function).
  //  • The per-model byte cap.
  //  • promptProfileFor / directivesForProfile / isHookFirstVideoPromptEnabled
  //    as shims. They are vestigial for prompt selection now, but
  //    campaignAdsGenerationService.isSharedPortraitPlatePromptCoherent()
  //    imports isHookFirstVideoPromptEnabled as conjunct 4 of the
  //    shared-portrait-master MONEY gate ($1.80 vs $2.70 on a mixed
  //    Meta+PMax run) and FAILS CLOSED on a missing export. Deleting them
  //    would silently pin that gate closed. Behaviour is unchanged from
  //    today: the switch still ships false, so mixed runs still bill 3
  //    masters. Making the gate honest under a single prompt (Meta and PMax
  //    now provably get identical bytes, so coherence is guaranteed by
  //    construction → $1.80) is a real saving and a real BILLING CHANGE —
  //    it needs its own owner decision, not a side effect of this one.
  //
  // KNOWN AND ACCEPTED: CORE says "premium Meta product commercial" and is
  // sent to PMax destinations too. Kept byte-exact rather than forking a
  // "premium product commercial" variant, because this repo has a MEASURED
  // NULL RESULT on rewriting fidelity prose (static-fidelity-block-ab) and
  // an owner rollback (#61) on doing it anyway. Do not reword it to tidy
  // this up; test a variant if you want to change it.
  //
  // Only the duration is interpolated, so the prompt can never claim a
  // length the render is not.
  // ══════════════════════════════════════════════════════════════════════
  lines.push(corePromptText(durationSec));


  // CONSTRAINT SUPREMACY — the precedence rule, in the strongest position.
  // MUST stay the LAST element of `lines`: recency is what makes the model
  // treat it as final, and it is the actual override-killer for an operator
  // refinement that asks for something the constraints forbid (the fence
  // above is framing only). Do not append anything after this block.
  //
  // Operator-path only, on the SAME guard as the block above: with an empty
  // operatorPrompt the assembled prompt must stay BYTE-IDENTICAL to the
  // pre-change output — that is the ordinary generate branch (~29 paid
  // masters/day). NOTE: verifyPostPilotBatch.js (the B14 byte-identity pin
  // referenced elsewhere in this file) is a BACKEND harness and does NOT exist
  // in this repo — verified 2026-08-26. In adgen the only pin on this property
  // is scripts/verifyOperatorPromptPrecedence.js group A, which is therefore
  // load-bearing rather than belt-and-braces.
  //
  // Label deliberately does not match any DROP_PRIORITY pattern, so
  // enforceByteCap can never drop it.
  if (operatorTrim) lines.push(supremacyLine);

  // Per-model size cap (caps.promptByteCap; Gemini Omni 20,000, Grok
  // 4,096). When over budget, drop optional context lines in defined
  // priority order. Directive blocks (preservation / fidelity / no-text
  // / timeline) are never dropped — they're the load-bearing part.
  // Applies to every profile including pmax.
  //
  // NO-OPERATOR PATH IS UNCHANGED, deliberately: same single enforceByteCap
  // call as before, same warn-and-send behaviour when a prompt is over cap
  // for reasons that have nothing to do with this change (a lifestyle prompt
  // on a 4,096-byte model already overflowed before it). Do not add a throw
  // here — that would be a new failure mode on the ~29-paid-masters/day
  // branch. Pinned by verifyOperatorPromptPrecedence.js group A + D11.
  if (!operatorTrim) return enforceByteCap(lines, caps);

  // ── OPERATOR-PATH BYTE BUDGET ────────────────────────────────────────────
  // The two blocks this change adds cost ~475 bytes on top of the old
  // wrapper's 274. On a 20,000-byte Omni prompt that is noise; on a
  // 4,096-byte grok/veo model (operator-selectable in the regenerate
  // dropdown) a max-length 1,000-char refinement measurably used to fit and
  // would now be rejected by Atlas. Measured before/after, grok cap:
  //   no operator   3153 → 3153  (byte-identical, unchanged)
  //   short refine  3441 → ~3700 (fits)
  //   1000-char     3959 → over cap without this budget
  //
  // PRIORITY, in order: (1) the constraints and the fence are never dropped;
  // (2) OUR explanation yields first — before the pre-existing DROP_PRIORITY
  // lines, because PHYSICAL ACCURACY / Transitions / Visual style predate this
  // change and were tuned deliberately; (3) if even the compact form cannot
  // fit, FAIL CLOSED rather than submit a prompt whose safety constraints have
  // been trimmed away. A refused request costs nothing; a submit with the
  // guardrails silently dropped is the exact failure this change exists to
  // prevent.
  const cap = caps?.promptByteCap || DEFAULT_BYTE_CAP;

  // Is the overflow ATTRIBUTABLE TO THIS CHANGE, or to the operator's own text
  // simply being too long for this model? Probe with the bare fence — no
  // label, no framing, no supremacy. The old wrapper cost 274 bytes, strictly
  // more than the fence markers alone, so if even the bare fence is over cap
  // then the pre-change code was over cap here too. That is a pre-existing
  // condition (a lifestyle prompt on a 4,096-byte model already overflowed),
  // and it is not ours to convert into a hard failure — preserve today's
  // warn-and-send. Otherwise the two new blocks are what tipped it, and
  // failing closed is the correct response.
  const preExistingOverflow = applyByteCap(
    lines
      .filter((l) => l !== supremacyLine)
      .map((l) => (l === operatorLineFull ? `${FENCE_OPEN} ${operatorTrim} ${FENCE_CLOSE}` : l)),
    caps
  ).bytes > cap;

  const full = applyByteCap(lines, caps);
  if (full.bytes <= cap && full.dropped.length === 0) {
    logByteCap(full);
    return full.prompt;
  }

  // Sacrifice the explanation before anything else.
  const compact = applyByteCap(
    lines.map((l) => (l === operatorLineFull ? operatorLineCompact : l)), caps
  );
  if (compact.bytes <= cap) {
    console.log(
      `ℹ️  veoPrompt: dropped the operator-refinement explanation to fit under ${cap} bytes ` +
      `(final=${compact.bytes}); the fence and CONSTRAINT SUPREMACY are retained`
    );
    logByteCap(compact);
    return compact.prompt;
  }

  if (preExistingOverflow) {
    logByteCap(compact);
    return compact.prompt;
  }

  const err = new Error(
    `veoPrompt: the operator refinement cannot fit under this model's ${cap}-byte prompt cap ` +
    `without dropping the no-rendered-text / product-fidelity constraints (needed ${compact.bytes} bytes). ` +
    `Refusing to submit. Shorten the refinement (currently ` +
    `${Buffer.byteLength(String(operatorTrim), 'utf8')} bytes) or pick a model with a larger prompt cap.`
  );
  err.code = 'VEO_PROMPT_OVER_CAP';
  throw err;
}


const DEFAULT_BYTE_CAP = 4096;   // legacy Grok/Veo cap — used when caps is absent
const BYTE_CAP_MARGIN  = 96;     // safety margin under the hard cap
// Optional context only. Directive blocks (preservation / fidelity /
// no-text / timeline) are never listed here — they are load-bearing.
// `Product: {title}` used to lead this list; it was removed entirely
// after Omni rendered the catalog title as an on-garment brand mark
// (see the buildVeoPrompt comment above). Do not put a titled Product
// line back just to have something cheap to drop.
const DROP_PRIORITY = [
  /^PHYSICAL ACCURACY: /,
  /^Transitions: /,
  /^Visual style: /
];

// Delimiters for the operator-direction fence. Defined once, in one place, so
// the neutralization in buildVeoPrompt and the fence itself cannot drift.
const FENCE_OPEN  = '<<<OPERATOR>>>';
const FENCE_CLOSE = '<<<END_OPERATOR>>>';

// The cap logic, with NO logging and NO mutation of the caller's array, so
// buildVeoPrompt's operator-path budget can probe candidate line sets before
// choosing one. Split out of enforceByteCap (which is now a logging wrapper)
// rather than reimplemented, so the two can never disagree about drop order,
// target, or join separator. Output for any given input is byte-identical to
// the pre-split function.
//
// NOTE: the pre-split enforceByteCap spliced the CALLER'S array in place. It
// was only ever called as the last statement of buildVeoPrompt, so nothing
// observed that mutation; not mutating is strictly safer.
function applyByteCap(lines, caps = null) {
  const cap    = caps?.promptByteCap || DEFAULT_BYTE_CAP;
  const target = cap - BYTE_CAP_MARGIN;
  const work   = [...lines];
  let prompt = work.join(' ');
  let bytes  = Buffer.byteLength(prompt, 'utf8');
  const dropped = [];
  if (bytes <= target) return { prompt, bytes, dropped, cap, target };

  for (const pattern of DROP_PRIORITY) {
    if (bytes <= target) break;
    const idx = work.findIndex(l => pattern.test(l));
    if (idx < 0) continue;
    dropped.push(work[idx].split(':')[0]);
    work.splice(idx, 1);
    prompt = work.join(' ');
    bytes  = Buffer.byteLength(prompt, 'utf8');
  }
  return { prompt, bytes, dropped, cap, target };
}

function logByteCap(r) {
  if (r.bytes > r.cap) {
    console.warn(`⚠️  veoPrompt: ${r.bytes} bytes still exceeds the model's prompt cap (${r.cap}) after dropping [${r.dropped.join(', ')}] — Atlas will reject`);
  } else if (r.dropped.length) {
    console.log(`ℹ️  veoPrompt: dropped [${r.dropped.join(', ')}] to fit under ${r.target} bytes (final=${r.bytes}, cap=${r.cap})`);
  }
}

function enforceByteCap(lines, caps = null) {
  const r = applyByteCap(lines, caps);
  logByteCap(r);
  return r.prompt;
}

// Hard-truncate a full raw-prompt override to the model's byte cap.
// Unlike enforceByteCap (which drops low-priority lines from a structured
// line list), this just cuts the string on a safe UTF-8 boundary and
// warns — used when ad.videoPromptRaw bypasses buildVeoPrompt entirely.
function enforceRawByteCap(text, caps = null) {
  const cap = caps?.promptByteCap || DEFAULT_BYTE_CAP;
  const s = String(text ?? '');
  const bytes = Buffer.byteLength(s, 'utf8');
  if (bytes <= cap) return s;

  let buf = Buffer.from(s, 'utf8').subarray(0, cap);
  // Do not end mid multi-byte codepoint (continuation bytes are 10xxxxxx).
  while (buf.length > 0 && (buf[buf.length - 1] & 0xc0) === 0x80) {
    buf = buf.subarray(0, buf.length - 1);
  }
  console.warn(
    `⚠️  veoPrompt raw: truncated operator raw prompt from ${bytes} → ${buf.length} bytes (cap=${cap})`
  );
  return buf.toString('utf8');
}

module.exports = {
  buildVeoPrompt,
  // Exported so scripts/verifyOperatorPromptPrecedence.js group A can pin the
  // emitted prompt against the measured artifact rather than a paraphrase.
  corePromptText,
  resolveSubject,
  archetypeDescription,
  aspectRatioForPlatformFormat,
  PLATFORM_FORMAT_ASPECT,
  promptProfileFor,
  PROMPT_PROFILES,
  enforceRawByteCap,
  enforceByteCap,
  isPmaxVideoDestination,
  // ── Owner standardization 2026-08-18 (Meta + PMax on one camera prompt) ──
  // isHookFirstVideoPromptEnabled() IS THE GATE other services should import
  // to ask "are Meta and PMax on the same camera prompt right now?". Do not
  // re-read the env inline anywhere else — the two-name fail-safe OR below is
  // not reproducible by a naive `process.env.X !== 'false'`.
  //
  // NOTE for the plate-sharing decision: prompt-profile EQUALITY is not a
  // sufficient gate. With the switch OFF, Meta and PMax also agree (both fall
  // to gemini-omni) — but they agree on the frozen Ken Burns pan, which is the
  // framing PMax Phase B rejected. Gate on this predicate being TRUE, not on
  // the two profiles merely matching.
  isHookFirstVideoPromptEnabled,
  isHookFirstVideoDestination,
  isMetaVideoDestination,
  // Deprecated alias — same switch, now covering Meta too.
  isPmaxVideoDirectivesEnabled,
  directivesForProfile,
  // Exported for offline verify harnesses (directive continuity / policy).
  OMNI_DIRECTIVES,
  GROK_DIRECTIVES,
  HOOK_FIRST_DIRECTIVES,
  // Deprecated alias for the pre-standardization name.
  PMAX_DIRECTIVES: HOOK_FIRST_DIRECTIVES,
  // Lifestyle video sibling path (VIDEO_LIFESTYLE_PROMPT) — harness + callers.
  LIFESTYLE_DIRECTIVES,
  LIFESTYLE_VIDEO_GUIDANCE,
  isVideoLifestylePromptEnabled,
  shouldUseLifestyleVideoPrompt,
  resolveLifestyleVideoRefCount,
  resolveLifestyleVideoRefPlan,
  lifestyleVideoGuidanceForIntent,
  // Lifestyle product-region anchor (VIDEO_PRODUCT_ANCHOR) — re-export
  // so harnesses can drive the same helpers the prompt builder uses.
  isVideoProductAnchorEnabled,
  productRegionForAd,
  buildProductAnchorBlock,
  // UI-chrome hallucination guard (VIDEO_PROMPT_UI_CHROME_GUARD, default
  // ON as of the 2026-08-19 live verification) — exported for the offline
  // verify harness only; no other caller should read the env var directly.
  isVideoUiChromeGuardEnabled,
  UI_CHROME_GUARD_LINE,
};

