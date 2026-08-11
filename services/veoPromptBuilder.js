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
//     (20,000-byte cap). FROZEN for Meta — owner PR #61 full rollback;
//     B14 asserts byte-identity to the pre-#61 prompt. Do NOT reword.
//   • grok — compact re-authoring of the same rules; optimized for
//     xai/grok-imagine-video* (4,096-byte cap); also serves veo/generic
//   • pmax — Google PMax video only (hook-first + centre-safe + aspect
//     framing). Selected when platformFormat is a pmax_video_* destination
//     AND PMAX_VIDEO_DIRECTIVES is on (default). Meta path is untouched.
// promptProfileFor(caps, opts) selects the profile from destination first,
// then caps.paramShape. The prompt-size cap is per-model (caps.promptByteCap).


// Aspect-ratio resolution lives in services/platformFormats.js — the
// canonical capability table for every platformFormat. Re-exported here
// so existing callers keep working without an import rewrite.
const {
  PLATFORM_FORMATS,
  aspectRatioForPlatformFormat
} = require('./platformFormats');
const PLATFORM_FORMAT_ASPECT = Object.fromEntries(
  Object.entries(PLATFORM_FORMATS).map(([k, v]) => [k, v.aspectRatio])
);

// Per-model-family / per-destination default-prompt profiles. Static Ken
// Burns directives are authored once per profile so Omni (20k headroom),
// Grok (4,096), and PMax (destination overlay on Omni) can be tuned
// independently; shared dynamic lines (operator lead, duration-scaled
// Timeline/Output, PRODUCT FIDELITY, compositing, seedHasText) stay in
// buildVeoPrompt. PMax also adds aspect-aware Frame lines there.
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
  'pmax': {
    label: 'Google PMax video prompt',
    optimizedFor: [
      'pmax_video_9_16',
      'pmax_video_16_9',
      'pmax_video_1_1'
    ],
    // Renders on Omni under the hood — same 20k byte budget.
    promptByteBudget: 20000
  }
};

// True for Google PMax video platformFormat keys (masters + derive-only).
// Destination is passed in — never sniffed from globals.
function isPmaxVideoDestination(platformFormat) {
  const f = String(platformFormat || '');
  return f.startsWith('pmax_video_');
}

// Kill switch PMAX_VIDEO_DIRECTIVES (default TRUE). Off → PMax destinations
// fall through to the Omni/Grok profile selection (Phase A behaviour).
function isPmaxVideoDirectivesEnabled() {
  return String(process.env.PMAX_VIDEO_DIRECTIVES ?? 'true').toLowerCase() !== 'false';
}

// Select the default-prompt profile.
//   1. Explicit opts.promptProfile wins (harness / override).
//   2. PMax video destination + kill switch on → 'pmax'.
//   3. Else paramShape starting with 'gemini-omni' → gemini-omni;
//      'grok' → grok; anything else (veo/generic) → grok.
// Second arg is optional: absent opts preserves pre-PMax behaviour exactly
// (Meta / scaffold / B14 paths that only pass caps).
function promptProfileFor(caps, opts = null) {
  const o = opts && typeof opts === 'object' ? opts : {};
  if (typeof o.promptProfile === 'string' && o.promptProfile.trim()) {
    return o.promptProfile.trim();
  }
  const dest = o.platformFormat || o.destination || null;
  if (isPmaxVideoDestination(dest) && isPmaxVideoDirectivesEnabled()) {
    return 'pmax';
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

// ── GOOGLE PMAX video prompt — destination profile for pmax_video_* only ──
// Starts from OMNI_DIRECTIVES (proven Meta text). Changes ONLY what the
// destination requires: hook-first objective, centre-safe camera. Fidelity
// / noText / physicalAccuracy / productPreservation are referenced from
// OMNI so they cannot drift. Timeline + aspect Frame lines are assembled
// in buildVeoPrompt when profile === 'pmax'. Kill switch:
// PMAX_VIDEO_DIRECTIVES=false restores the Omni/Grok path for PMax too.
// DO NOT import PR #61 rollback text. DO NOT touch OMNI_DIRECTIVES.
const PMAX_DIRECTIVES = {
  role:
    `Role: Professional product commercial editor. Animate the supplied product photos with virtual camera movement only — ` +
    `do NOT generate, recreate, or alter imagery. The supplied images are the source of truth.`,
  objective:
    `Objective: Create a premium product commercial using subtle Ken Burns camera moves. ` +
    // Aspect-neutral by design: this one profile serves both the landscape
    // and vertical PMax masters, and the aspect-specific direction is the
    // Frame line assembled in buildVeoPrompt. Naming one aspect here (an
    // earlier draft said "swipe-away vertical") is simply false on the
    // other master and gives the model a contradictory cue.
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
  if (profile === 'pmax') return PMAX_DIRECTIVES;
  if (profile === 'gemini-omni') return OMNI_DIRECTIVES;
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
 * Lifestyle video prompt branch is active only when the flag is on AND
 * (seed is lifestyle OR variantKind is ugc). Matches static preserve trigger
 * so a UGC video with an unclassified seed does not stay on packshot Ken Burns
 * while its static sibling preserves. Packshot product_image never takes it.
 */
function shouldUseLifestyleVideoPrompt(seedStyle, variantKind = null) {
  if (!isVideoLifestylePromptEnabled()) return false;
  if (variantKind === 'ugc') return true;
  if (seedStyle === 'lifestyle') return true;
  return false;
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
function buildVeoPrompt({
  brand,          // eslint-disable-line no-unused-vars -- kept for call-site stability
  product,
  media,
  layoutInput = null,     // eslint-disable-line no-unused-vars
  sourceMedia = null,     // eslint-disable-line no-unused-vars
  aspectRatio = '1:1',
  seedHasText = false,
  hasProductReference = false,
  operatorPrompt = null,
  storyboard = null,      // eslint-disable-line no-unused-vars
  caps = null,
  durationSec = 8,        // per-ad render length (wizard format-selection stage)
  platformFormat = null,  // Ad.platformFormat — PMax destination selector
  destination = null,     // alias for platformFormat
  promptProfile = null,   // explicit profile override (harness / opt-in)
  // Lifestyle seed style + variantKind — NEW inputs. Absent/null → packshot
  // path unchanged (B14 matrix never passes these). Lifestyle/UGC +
  // VIDEO_LIFESTYLE_PROMPT → LIFESTYLE_DIRECTIVES sibling branch; OMNI/GROK
  // text is not edited. Lifestyle and PMax are ORTHOGONAL: a PMax destination
  // keeps hook-first timing + centre-safe/Frame treatment while using lifestyle
  // scene/motion directives.
  seedStyle = null,
  variantKind = null
}) {
  const lines = [];
  const lifestyle = shouldUseLifestyleVideoPrompt(seedStyle, variantKind);
  const profile = promptProfileFor(caps, {
    platformFormat: platformFormat || destination || null,
    destination: destination || null,
    promptProfile
  });
  // Lifestyle is a sibling directive set for scene/motion — it does NOT
  // suppress the PMax destination profile. Packshot path still uses profile
  // selection exactly as before (B14).
  const d = lifestyle ? LIFESTYLE_DIRECTIVES : directivesForProfile(profile);
  // Orthogonal: PMax destination treatment composes with lifestyle, never
  // gets dropped because the seed is lifestyle.
  const isPmax = profile === 'pmax';
  // Used by the PMax timeline only. Meta's timeline is frozen and must not
  // become aspect-aware (see the PR #61 rollback note above).
  const isVerticalAspect = String(aspectRatio || '') === '9:16';

  // Operator refinement (regeneration only). Leads the prompt so the
  // video model sees the requested change before the fixed spec below.
  // Lifestyle guidance (intent × lifestyle) also arrives here via the
  // videoPromptGuidance cascade — ambient motion is already permitted by
  // LIFESTYLE_DIRECTIVES, so guidance can shape mood/pacing without
  // contradicting the base.
  if (operatorPrompt && String(operatorPrompt).trim()) {
    lines.push(
      `OPERATOR REFINEMENT (HIGHEST PRIORITY — overrides conflicting guidance below): ` +
      `${String(operatorPrompt).trim()}. ` +
      `Apply this refinement to the generated video. The product fidelity and no-text guidance still apply, but where the operator's instruction conflicts with stylistic defaults the operator wins.`
    );
  }

  // ── Directives (lifestyle sibling OR packshot Ken Burns per-profile) ─
  lines.push(d.role);
  lines.push(d.objective);
  // PMax hook-first is destination treatment — compose onto lifestyle too.
  // Packshot PMax already carries HOOK-FIRST inside PMAX_DIRECTIVES.objective;
  // lifestyle uses LIFESTYLE_DIRECTIVES.objective, so inject the destination
  // rule once when both are active. Not a contradiction with ambient life:
  // the product must be readable early; ambient motion may still breathe.
  if (lifestyle && isPmax) {
    lines.push(
      `HOOK-FIRST (PMax destination): this surface is skipped or scrolled past in seconds — ` +
      `the product must be identifiable within the first 2 seconds; the opening frames carry the whole ad. ` +
      `Ambient life may move, but never at the cost of early product readability.`
    );
  }
  lines.push(d.sourceImages);
  lines.push(d.productPreservation);

  if (product?.title) {
    lines.push(`Product: ${product.title}.`);
  }

  // Timeline. Lifestyle branch is ambient-life + product-as-star.
  // Packshot Meta branch is FROZEN — do not reword (B14).
  // PMax packshot is hook-first Ken Burns.
  // Lifestyle + PMax composes: lifestyle scene/motion language + PMax
  // hook-first timing + centre-safe framing (not packshot Ken Burns pans —
  // those would re-impose static product commercial moves on a real scene).
  // Residual tension report (not silently dropped): packshot PMax cameraStyle
  // says "product stays completely static"; lifestyle allows real-item motion.
  // Composition keeps lifestyle product-preservation (identity ≠ immobility)
  // and only takes PMax's hook-first + centre-safe + Frame — never the
  // packshot-static product line.
  const dur = Number(durationSec || 8);
  const t1  = (dur / 3).toFixed(2);
  const t2  = (dur * 0.64).toFixed(2);
  if (lifestyle && isPmax) {
    lines.push(
      `Timeline (${dur.toFixed(1)}s): ` +
      `Scene 1 (0.0–${t1}s): HOOK — product fully legible and identifiable from the first frame in the real lifestyle plate; ` +
      `gentle camera finds and holds the product already in the scene; ambient life may begin (fabric with the wearer, hair, breath, steam, water, foliage as present). ` +
      (isVerticalAspect
        ? `Product held on the vertical centre line — no lateral drift toward either side margin. `
        : `Product held in the central band of the wide frame. `) +
      `No whip, no orbit, no parallax. The product must be unmistakable within the first 2.0s. ` +
      `Scene 2 (${t1}–${t2}s): hold the product as the star with centre-safe framing; soft ambient motion continues; optional gentle push or drift as a real camera would. ` +
      `Product identity absolute — may move only as the real item would with the wearer/scene; never morph or independently animate. ` +
      `Scene 3 (${t2}–${dur.toFixed(1)}s): ease to a readable full-scene end state with the product still clear and centre-safe; natural motion only, never fantasy.`
    );
  } else if (lifestyle) {
    lines.push(
      `Timeline (${dur.toFixed(1)}s): ` +
      `Scene 1 (0.0–${t1}s): settle into the real moment — gentle camera finds the product already in the lifestyle plate; ambient life may begin (fabric with the wearer, hair, breath, steam, water, foliage as present). No whip, no orbit, no parallax. ` +
      `Scene 2 (${t1}–${t2}s): hold the product as the star; soft ambient motion continues around it; optional gentle push or drift as a real camera would. ` +
      `Product identity absolute — may move only as the real item would with the wearer/scene; never morph or independently animate. ` +
      `Scene 3 (${t2}–${dur.toFixed(1)}s): ease to a readable full-scene end state with the product still clear; natural motion only, never fantasy.`
    );
  } else if (isPmax) {
    lines.push(
      `Timeline (${dur.toFixed(1)}s): ` +
      `Scene 1 (0.0–${t1}s): HOOK — product fully legible and identifiable from the first frame; ` +
      `the establishing camera move happens WITH the product already reading as the subject, not before it. ` +
      // Scene 1's move must match the aspect. A left→right pan is right for a
      // WIDE frame, but on 9:16 it walks the subject toward the side margins —
      // where the platform's engagement rail sits — directly contradicting the
      // centre-safe rule stated in cameraStyle two lines later. The Frame line
      // is already aspect-aware; the timeline has to be too, or the two halves
      // of the same prompt disagree.
      (isVerticalAspect
        ? `Very slow push-in toward the product, ~8–12% movement, product held on the vertical centre line. No lateral drift toward either side margin. No rotation or perspective shift. `
        : `Slow horizontal pan left→right across the product, ~10–15% movement. No zoom, rotation, or perspective shift. `) +
      `The product must be unmistakable within the first 2.0s. ` +
      `Scene 2 (${t1}–${t2}s): slow zoom toward the logo or most distinctive product detail (~8–10%), centered. No rotation or distortion. ` +
      `Scene 3 (${t2}–${dur.toFixed(1)}s): begin slightly cropped, slow zoom out ~10–12% to reveal the full product. Maintain centre-safe framing.`
    );
  } else {
    lines.push(
      `Timeline (${dur.toFixed(1)}s): ` +
      `Scene 1 (0.0–${t1}s): slow horizontal pan left→right, ~10–15% movement. No zoom, rotation, or perspective shift. ` +
      `Scene 2 (${t1}–${t2}s): slow zoom toward the logo or most distinctive product detail (~8–10%), centered. No rotation or distortion. ` +
      `Scene 3 (${t2}–${dur.toFixed(1)}s): begin slightly cropped, slow zoom out ~10–12% to reveal the full product. Maintain center framing.`
    );
  }
  lines.push(d.transitions);
  lines.push(d.cameraStyle);
  // Centre-safe is PMax destination treatment. Lifestyle cameraStyle does not
  // carry it (would change Meta lifestyle); inject when both are active.
  // Complementary with lifestyle motion — not a contradiction.
  if (lifestyle && isPmax) {
    lines.push(
      `Centre-safe composition (PMax destination): keep the product and any focal detail within the central region of the frame — ` +
      `away from the top and bottom bands and the outer side margins, where the platform overlays UI.`
    );
  }

  // Aspect-aware framing — PMax destination (packshot AND lifestyle). Meta
  // never emits Frame lines (Meta was previously aspect-unused on that path).
  if (isPmax) {
    const ar = String(aspectRatio || '');
    if (ar === '16:9') {
      lines.push(
        `Frame (16:9 landscape): use wider establishing framing; prefer horizontal camera travel rather than vertical. ` +
        `Hold the product in the central band of the wide frame with generous headroom above and below the product.`
      );
    } else if (ar === '9:16') {
      lines.push(
        `Frame (9:16 vertical): vertical-appropriate framing with the product readable upright in portrait. ` +
        `Keep the product in the central region, clear of the top and bottom bands and the right edge where the platform overlays UI.`
      );
    }
  }

  lines.push(d.background);
  lines.push(d.visualStyle);

  // Fixed audio default — some models (Gemini Omni) generate native
  // audio, so the directive is load-bearing even for a camera-only clip.
  lines.push(d.audio);

  // NO TEXT — the brand-script overlay composites downstream. Text and
  // logos physically present in the photographs are fine to show (Scene
  // 2 zooms toward the logo); GENERATING text/graphics is what's banned.
  // (The creative-director negative-space hint was removed — titling is
  // canonical/deterministic and no longer shapes the video prompt.)
  lines.push(d.noText);

  if (seedHasText) {
    lines.push(
      `The reference image contains text overlays / captions / stickers / watermarks burned into the source frame. ` +
      `Treat that burned-in text as part of the locked photograph — do not read, reproduce, extend, or generate more of it. ` +
      `The chrome layer will composite all ad copy downstream.`
    );
  }

  lines.push(d.physicalAccuracy);

  // Lifestyle ambient-life directive (only on the lifestyle branch).
  if (lifestyle && d.ambientLife) {
    lines.push(d.ambientLife);
  }

  // Reference stack: position 0 is the seed (main image); subsequent
  // positions are the product hero + alternate views in stored order
  // (buildReferenceImages). hasProductReference is false only when the
  // stack is seed-only (no product imagery available, or a 1-ref model).
  // Lifestyle path deliberately ships 1 ref → seed-only fidelity wording.
  if (hasProductReference) {
    lines.push(
      `PRODUCT FIDELITY: All supplied images show the exact catalog SKU — the first image is the primary scene, ` +
      `the rest are additional views of the same product. Together they are the ABSOLUTE source of truth for shape, color, ` +
      `label text, packaging, and proportions. If any images disagree on a detail, the dedicated product shots win over the scene image. ` +
      `Do NOT blend the views into new angles, reinterpret the label, shift colors, or generate a similar-but-different variant.`
    );
  } else {
    lines.push(
      `PRODUCT FIDELITY: The product visible in the scene image is the catalog product. ` +
      `Preserve its exact shape, color, label text, packaging, and proportions throughout. ` +
      `Do NOT reinterpret the label, shift colors, or generate a similar-but-different variant.`
    );
  }

  lines.push(d.doNot);

  if (lifestyle) {
    lines.push(
      `Output: ${Number(durationSec || 8).toFixed(1)}s duration. Authentic lived-in moment brought to life. ` +
      `Product identity absolute and unchanged — natural real-item motion with the wearer/scene only; never morph, re-drape, or independently animate. ` +
      `Ambient life only — no fantasy motion. Final result should look like the original photograph breathing, with no sign that AI rebuilt the product or the scene.`
    );
  } else {
    lines.push(
      `Output: ${Number(durationSec || 8).toFixed(1)}s duration. Camera movement only. Product unchanged. Luxury ecommerce aesthetic. ` +
      `Final result should look like a professional camera moving over the original photographs, with no sign that AI touched the product.`
    );
  }

  // Per-model size cap (caps.promptByteCap; Gemini Omni 20,000, Grok
  // 4,096). When over budget, drop optional context lines in defined
  // priority order. Directive blocks (preservation / fidelity / no-text
  // / timeline) are never dropped — they're the load-bearing part.
  // Applies to every profile including pmax.
  return enforceByteCap(lines, caps);
}


const DEFAULT_BYTE_CAP = 4096;   // legacy Grok/Veo cap — used when caps is absent
const BYTE_CAP_MARGIN  = 96;     // safety margin under the hard cap
const DROP_PRIORITY = [
  /^Product: /,
  /^PHYSICAL ACCURACY: /,
  /^Transitions: /,
  /^Visual style: /
];

function enforceByteCap(lines, caps = null) {
  const cap    = caps?.promptByteCap || DEFAULT_BYTE_CAP;
  const target = cap - BYTE_CAP_MARGIN;
  let prompt = lines.join(' ');
  let bytes  = Buffer.byteLength(prompt, 'utf8');
  if (bytes <= target) return prompt;

  const dropped = [];
  for (const pattern of DROP_PRIORITY) {
    if (bytes <= target) break;
    const idx = lines.findIndex(l => pattern.test(l));
    if (idx < 0) continue;
    dropped.push(lines[idx].split(':')[0]);
    lines.splice(idx, 1);
    prompt = lines.join(' ');
    bytes  = Buffer.byteLength(prompt, 'utf8');
  }

  if (bytes > cap) {
    console.warn(`⚠️  veoPrompt: ${bytes} bytes still exceeds the model's prompt cap (${cap}) after dropping [${dropped.join(', ')}] — Atlas will reject`);
  } else if (dropped.length) {
    console.log(`ℹ️  veoPrompt: dropped [${dropped.join(', ')}] to fit under ${target} bytes (final=${bytes}, cap=${cap})`);
  }
  return prompt;
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
  resolveSubject,
  archetypeDescription,
  aspectRatioForPlatformFormat,
  PLATFORM_FORMAT_ASPECT,
  promptProfileFor,
  PROMPT_PROFILES,
  enforceRawByteCap,
  enforceByteCap,
  isPmaxVideoDestination,
  isPmaxVideoDirectivesEnabled,
  directivesForProfile,
  // Exported for offline verify harnesses (directive continuity / policy).
  OMNI_DIRECTIVES,
  GROK_DIRECTIVES,
  PMAX_DIRECTIVES,
  // Lifestyle video sibling path (VIDEO_LIFESTYLE_PROMPT) — harness + callers.
  LIFESTYLE_DIRECTIVES,
  LIFESTYLE_VIDEO_GUIDANCE,
  isVideoLifestylePromptEnabled,
  shouldUseLifestyleVideoPrompt,
  resolveLifestyleVideoRefCount,
  resolveLifestyleVideoRefPlan,
  lifestyleVideoGuidanceForIntent,
};

