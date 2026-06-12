// Phase 6.1 — HTML Layout Generator (shadow mode).
//
// Generates a complete self-contained HTML document per AiCanvasArtifact,
// alongside the existing JSON canvas spec. Same input contract as the
// JSON Generator: LayoutInput + Director concept + rich context payload
// from buildAiCanvasContext + vision images.
//
// Opt-in via AI_HTML_LAYOUT_ENABLED=true. Runs as a fire-and-forget
// shadow from aiCanvasSpecService.getOrGenerate (similar pattern to
// the Resolver shadow + Image-Ref shadow). Persists outputHtml +
// colorPalette + htmlSchemaVersion on the same AiCanvasArtifact via
// updateOne; outputKind stays 'spec' until Phase 6.3 flips renderer
// onto the HTML path.
//
// Phase 6.2 will add htmlValidationService + Pre-Judge filter; Phase
// 6.3 will branch the renderer on outputKind. This service produces
// the HTML in shadow so we have material to validate + render against.

const OpenAI = require('openai');

const AiCanvasArtifact          = require('../models/AiCanvasArtifact');
const AiHtmlValidationArtifact  = require('../models/AiHtmlValidationArtifact');
const CreativeDirectionArtifact = require('../models/CreativeDirectionArtifact');
const { buildAiCanvasContext }  = require('./aiCanvasInputBuilder');
const { loadContext }           = require('./layoutInputService');
const { trackLlmCall }          = require('./costTracker');
const { validateCandidate }     = require('./htmlValidationService');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MODEL_ID            = 'gpt-4.1';
const TEMPERATURE         = 0.85;
const N_CANDIDATES_DEFAULT = 2;        // HTML output is ~3-5× longer than JSON spec — start conservative
const MAX_TOKENS          = 6000;
const HTML_SCHEMA_VERSION = '1.5.0';   // 1.5: video-overlay slot detection broadened — find ANY kind:'media' zone with a rect (preferring slot:'product.hero_media', falling back to largest media-kind rect) instead of strict slot match. Adds explicit "no <img src=hero_media.*> anywhere" prompt rule — editorial/magazine archetypes were baking the first frame into the chrome and covering the playing video. 1.4: video-overlay mode initial. 1.3: AVAILABLE IMAGE URLS allowlist. 1.2: validator host allowlist. 1.1: archetype I.

function enabled() {
  return String(process.env.AI_HTML_LAYOUT_ENABLED || '').toLowerCase() === 'true';
}

// Entry point. Called fire-and-forget from aiCanvasSpecService once
// the JSON spec generation completes. Idempotent on (aiCanvasArtifactId,
// htmlSchemaVersion) — if the artifact already has outputHtml at the
// current schema version, skip.
async function generateForArtifact({ aiCanvasArtifactId, refresh = false }) {
  if (!enabled() && !refresh) {
    return { skipped: true, reason: 'AI_HTML_LAYOUT_ENABLED=false' };
  }
  if (!process.env.OPENAI_API_KEY) {
    return { skipped: true, reason: 'OPENAI_API_KEY not set' };
  }

  const canvas = await AiCanvasArtifact.findById(aiCanvasArtifactId).lean();
  if (!canvas) throw new Error(`AiCanvasArtifact ${aiCanvasArtifactId} not found`);

  if (!refresh && canvas.outputHtml && canvas.htmlSchemaVersion === HTML_SCHEMA_VERSION) {
    return { skipped: true, reason: 'html already current' };
  }

  // V2 contract — HTML Generator requires a Director concept. Skip
  // when the canvas was a V1 generation (no concept attached).
  if (!canvas.directionArtifactId || !canvas.directionConceptId) {
    return { skipped: true, reason: 'no director concept (V1 row)' };
  }

  // Re-load the director concept by id. The artifact persisted the
  // concept_id but not the full concept object; we read it fresh.
  const direction = await CreativeDirectionArtifact.findById(canvas.directionArtifactId).lean();
  const concept = (direction?.concepts || []).find(c => c.concept_id === canvas.directionConceptId);
  if (!concept) {
    return { skipped: true, reason: `director concept ${canvas.directionConceptId} not found in artifact ${canvas.directionArtifactId}` };
  }

  // Re-load the layout input — it lives on the LayoutInputArtifact,
  // not on the canvas. The canvas was generated against a specific
  // layoutInput at JSON-Gen time; we need the same input shape so HTML
  // generation grounds in the same data.
  const LayoutInputArtifact = require('../models/LayoutInputArtifact');
  const layoutInputRow = await LayoutInputArtifact.findOne({
    mediaId:             canvas.mediaId,
    template:            canvas.template,
    aspectRatio:         canvas.aspectRatio,
    productId:           canvas.productId,
    variantKind:         canvas.variantKind,
    campaignContextHash: canvas.campaignContextHash,
    paletteSource:       canvas.paletteSource
  }).lean();
  if (!layoutInputRow) {
    return { skipped: true, reason: 'layout input artifact missing — JSON Gen path normally creates it' };
  }
  const input = layoutInputRow.input;

  // Build the rich context — same call shape the JSON Generator uses.
  // Reuses Phase 5c.2's enriched signal payload so HTML output sees
  // the same brand description / commerce / cross-media distributions.
  let richContext = null;
  try {
    const ctx = await loadContext(canvas.mediaId, {
      productId:     canvas.productId,
      variantKind:   canvas.variantKind,
      paletteSource: canvas.paletteSource
    });
    if (ctx) {
      richContext = await buildAiCanvasContext({
        ctx, layoutInput: input,
        aspectRatio:  canvas.aspectRatio,
        brandId:      canvas.brandId,
        productId:    canvas.productId,
        creativeStyle: canvas.creativeStyle
      });
    }
  } catch (err) {
    console.warn(`   ⚠️  html-gen rich-context build failed: ${err.message}`);
  }

  // Video-overlay mode — when source Media is video AND the canvas spec
  // has ANY kind:'media' zone with a rect, the LLM emits
  // body{background:transparent} + leaves the chosen media rect
  // transparent so the Puppeteer omitBackground screenshot yields a
  // transparent PNG Cloudinary composites over the source video.
  //
  // Slot picking: prefer slot:'product.hero_media' (the canonical
  // single-video-slot contract JSON Gen targets). Fall back to the
  // largest media-kind rect when the spec used a non-canonical slot —
  // alt-crop (product.hero_media.crops.*), product.lifestyle_image,
  // etc., which editorial / magazine archetypes historically picked.
  // Without this fallback the strict slot filter missed those specs,
  // videoMode came back false, the LLM got no transparency instructions,
  // and the source frame got baked into the chrome as <img>, covering
  // the playing video behind a frozen first frame.
  //
  // No media zone at all → videoMode=false, render as static PNG —
  // composeVideoOutput will return null and the pipeline ships the
  // static PNG as the ad.
  const Media = require('../models/Media');
  const sourceMedia = await Media.findById(canvas.mediaId).select('fileType').lean();
  const isVideoSource = sourceMedia?.fileType === 'video';
  const mediaZones = (canvas.canvasSpec?.zones || []).filter(z =>
    z.kind === 'media' && z.rect
  );
  const heroSlotted = mediaZones.find(z => z.slot === 'product.hero_media');
  const largestMedia = mediaZones.slice()
    .sort((a, b) => (b.rect.w * b.rect.h) - (a.rect.w * a.rect.h))[0] || null;
  const mediaZone = heroSlotted || largestMedia;
  const videoMode = isVideoSource && !!mediaZone;
  const mediaRect = videoMode ? mediaZone.rect : null;

  const dims = canvasDims(canvas.aspectRatio);
  const { system, user, images } = buildPrompt({
    canvas, concept, input, richContext, dims, videoMode, mediaRect
  });

  const nCandidates = N_CANDIDATES_DEFAULT;
  const responseSchema = buildResponseSchema();

  // Parallel candidate generation — same pattern as JSON Generator.
  const userContent = composeUserContent(user, images);

  const oneGeneration = async (genIndex) => {
    const t0 = Date.now();
    const completion = await trackLlmCall(
      {
        stage:       'layout_generator_html',
        provider:    'openai',
        model:       MODEL_ID,
        purposeTag:  `html:${canvas.directionConceptId}:cand${genIndex}`,
        brandId:     canvas.brandId,
        mediaId:     canvas.mediaId,
        productId:   canvas.productId,
        visionImages: images.length,
        cacheKey:    `htmlcanvas:${canvas._id}:${HTML_SCHEMA_VERSION}`
      },
      () => openai.chat.completions.create({
        model: MODEL_ID,
        response_format: { type: 'json_schema', json_schema: responseSchema },
        messages: [
          { role: 'system', content: system },
          { role: 'user',   content: userContent }
        ],
        temperature: TEMPERATURE,
        max_tokens:  MAX_TOKENS
      })
    );
    const elapsedMs = Date.now() - t0;
    const raw = completion.choices?.[0]?.message?.content;
    if (!raw) throw new Error(`html-gen: OpenAI returned no content (cand ${genIndex})`);
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (err) { throw new Error(`html-gen: response not JSON (cand ${genIndex}): ${err.message}`); }
    return { parsed, raw, elapsedMs };
  };

  const results = await Promise.allSettled(
    Array.from({ length: nCandidates }, (_, i) => oneGeneration(i))
  );
  const successes = results.map((r, i) => ({ r, i })).filter(x => x.r.status === 'fulfilled');
  if (!successes.length) {
    const firstReject = results.find(r => r.status === 'rejected');
    throw firstReject?.reason || new Error('all html candidates failed');
  }

  const candidates    = successes.map(s => s.r.value.parsed);
  const candidateRaws = successes.map(s => s.r.value.raw);
  const totalElapsed  = successes.reduce((m, s) => Math.max(m, s.r.value.elapsedMs), 0);

  // Phase 6.2 — validate every candidate. Persist an AiHtmlValidation-
  // Artifact per candidate (replace-on-re-run via unique index on
  // {aiCanvasArtifactId, candidateIndex}). Pre-Judge filter drops
  // candidates with hard_violations.length > 0; if all candidates
  // violate, keep them all (don't return empty) but log loudly.
  const validations = await Promise.all(candidates.map((c, i) => validateCandidate(c.html, {
    aspectRatio:   canvas.aspectRatio,
    hierarchySpec: c.hierarchy_spec || null,
    candidateIndex: i,
    colorPalette:  Array.isArray(c.color_palette) ? c.color_palette : []
  })));

  // Replace-on-re-run via the unique (aiCanvasArtifactId, candidateIndex)
  // index. Doing per-row upsert in parallel — small fanout.
  await Promise.all(validations.map(v =>
    AiHtmlValidationArtifact.findOneAndReplace(
      { aiCanvasArtifactId: canvas._id, candidateIndex: v.candidateIndex },
      {
        aiCanvasArtifactId: canvas._id,
        candidateIndex:     v.candidateIndex,
        parseOk:            v.parseOk,
        hardViolations:     v.hardViolations,
        warnings:           v.warnings,
        imageProbe:         v.imageProbe,
        contrastChecks:     v.contrastChecks,
        computedDimensions: v.computedDimensions,
        createdAt:          new Date()
      },
      { upsert: true, new: true, includeResultMetadata: false }
    )
  ));

  // Pre-Judge filter — preferred candidates have ZERO hard violations.
  // When ALL candidates have hard violations, keep the full pool and
  // log loudly so we can see Generator prompt failures.
  const eligibleIndices = validations
    .map((v, i) => v.hardViolations.length === 0 ? i : null)
    .filter(i => i !== null);
  let winnerIndex;
  if (eligibleIndices.length === 0) {
    console.warn(
      `   ⚠️  html-gen Pre-Judge: ALL ${candidates.length} candidates have hard violations ` +
      `(${validations.map(v => v.hardViolations.join('+')).join(' | ')}) — picking index 0 anyway`
    );
    winnerIndex = 0;
  } else if (eligibleIndices.length < candidates.length) {
    const dropped = candidates.length - eligibleIndices.length;
    console.log(
      `   ⛔ html-gen Pre-Judge: dropped ${dropped}/${candidates.length} candidates for hard violations ` +
      `(kept indices: ${eligibleIndices.join(',')})`
    );
    winnerIndex = eligibleIndices[0];
  } else {
    winnerIndex = 0;
  }
  const winner          = candidates[winnerIndex];
  const winnerValidation = validations[winnerIndex];

  // Look up the persisted validation artifact for the winner so we can
  // FK it on the canvas row.
  const winnerValidationDoc = await AiHtmlValidationArtifact.findOne({
    aiCanvasArtifactId: canvas._id,
    candidateIndex:     winnerIndex
  }).select('_id').lean();

  // Persist HTML + palette on the same AiCanvasArtifact. outputKind
  // stays 'spec' for now — Phase 6.3 flips renderer to read 'html'.
  await AiCanvasArtifact.updateOne(
    { _id: canvas._id },
    {
      $set: {
        outputHtml:        winner.html || null,
        outputCss:         winner.css_extracted || null,
        colorPalette:      Array.isArray(winner.color_palette) ? winner.color_palette : [],
        htmlSchemaVersion: HTML_SCHEMA_VERSION,
        htmlValidationId:  winnerValidationDoc?._id || null,
        // Stash the raw response for diagnostic visibility (mirrors the
        // JSON Generator's rawResponse pattern). One field, winner only;
        // multi-candidate raws are not persisted for cost / index size.
        htmlRawResponse:   candidateRaws[winnerIndex] || null
      }
    }
  );

  const totalWarnings = validations.reduce((s, v) => s + v.warnings.length, 0);
  console.log(
    `🌐 htmlGen[${canvas.template}/${canvas.aspectRatio}/${canvas.creativeStyle}]: ` +
    `media=${canvas.mediaId} product=${canvas.productId || '-'} ` +
    `concept=${canvas.directionConceptId} cands=${candidates.length} ` +
    `winner=${winnerIndex} took=${totalElapsed}ms html_len=${(winner.html || '').length} ` +
    `warnings=${totalWarnings} winner_hard_violations=${winnerValidation.hardViolations.length}`
  );

  return {
    artifactId:    String(canvas._id),
    candidateCount: candidates.length,
    winnerIndex,
    htmlLength:    (winner.html || '').length,
    palette:       winner.color_palette || [],
    totalWarnings,
    winnerHardViolations: winnerValidation.hardViolations,
    cached:        false
  };
}

// ── Prompt construction ──────────────────────────────────────────────

function buildPrompt({ canvas, concept, input, richContext, dims, videoMode = false, mediaRect = null }) {
  const ctx    = richContext?.text || null;
  const images = richContext?.images || [];
  const creativeStyle = canvas.creativeStyle;
  const aspectRatio   = canvas.aspectRatio;

  const system = [
    `You are a senior creative director + frontend developer producing a single complete HTML+CSS social-media ad creative.`,
    ``,
    `Your output: ONE self-contained HTML document the renderer feeds to a headless browser via page.setContent(). It will be screenshotted at exactly ${dims.width}×${dims.height}px — every visible element must fit inside that viewport.`,
    ``,
    `HARD RULES:`,
    `- Output a complete <html>...</html> document. <head> with <meta charset>, <title>, single inline <style>. <body> with the ad's visible content.`,
    `- <body> MUST be sized exactly ${dims.width}px × ${dims.height}px via inline style="width:${dims.width}px;height:${dims.height}px;margin:0;overflow:hidden". No scrollbars, no overflow.`,
    `- NO <script>. NO external <link rel="stylesheet"> or @import (renderer runs offline; external requests time out).`,
    `- NO external fonts. Use system stack: \`font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif\` OR \`font-family: Georgia, "Times New Roman", serif\` for editorial vibe.`,
    `- All image src URLs MUST come from the supplied crop maps or richContext VERBATIM — use the actual URL strings from product.hero_media.image, product.image, product.product_image.image, product.lifestyle_image.image, product.hero_media.crops.<ratio_key>, brand.logo (if logo_present). Do NOT invent or modify URLs.`,
    `- ALLOWED IMAGE HOSTS: res.cloudinary.com, cdn.brandfetch.io, cdn.shopify.com, scontent.cdninstagram.com, *.fbcdn.net. ANY <img src> whose host is outside this list (especially cdn.openai.com, example.com, placeholder.com, picsum.photos, unsplash.com) is a hard validation failure — the candidate is dropped pre-Judge. If you can't find a URL in FULL CONTEXT to use, OMIT the <img> tag entirely (decorative <div> + brand colors is better than a broken or hallucinated image).`,
    `- NO placeholder text. NO Lorem Ipsum. Pull copy from copy_candidates arrays (pick by index — use index 0 if you can't justify another).`,
    `- Render copy LEGIBLY: white-space, kerning, no text-clipping. Use overflow-wrap, word-break sensibly.`,
    `- Color text + background pairs must achieve WCAG AA contrast (≥ 4.5:1 normal, ≥ 3:1 for ≥ 24px or bold ≥ 19px). Validator will check.`,
    `- All positioning via flexbox / grid / absolute. Use ${dims.width}×${dims.height}px-scoped values (px / %) — NO vw/vh (viewport units misbehave in headless).`,
    ``,
    `CREATIVE BRIEF:`,
    `- creative_style: ${creativeStyle}`,
    `- aspect_ratio: ${aspectRatio}`,
    `- canvas: ${dims.width}×${dims.height}px`,
    ``,
    `COMPOSITION ARCHETYPES (the Director's concept will name one — materialize it):`,
    `  A) FULL-BLEED HERO + BOTTOM PANEL — hero photo covers most of canvas; colored panel band along bottom 25-35% with headline + CTA. Picks a hex that complements the photo.`,
    `  B) VERTICAL SPLIT — hero image and brand panel each ~50% width side-by-side.`,
    `  C) DIAGONAL CARVE — clip-path on the hero region splits the canvas at an angle. Hero one side, brand panel other.`,
    `  D) TYPOGRAPHIC DOMINANT — headline IS the hero (covers 50%+ of canvas), image reduced to small inset or omitted.`,
    `  E) HERO QUOTE OVERLAY — full-bleed hero image, quote_card overlaid on a safe region. UGC + creator quote leads.`,
    `  F) MAGAZINE / EDITORIAL — eyebrow rules + headline + body text stacked vertically over a solid panel, image inset bottom-right.`,
    `  G) STAT-LED SOCIAL PROOF — numeric stat (rating, follower count, engagement) rendered as the hero element. Headline secondary.`,
    `  H) PRODUCT-CARD GRID — multiple product images in a 2×2 or 1×3 arrangement.`,
    `  I) UGC × PRODUCT SPLIT — two media zones: 50/50 vertical split or stacked diagonal. One <img> sources product.hero_media (UGC in real-world context); the other sources product.product_image (clean studio shot) or product.lifestyle_image (catalog lifestyle). "Real people use it / here's what you'd buy" framing. Thin headline strip across the join; no brand panel. ONLY when both product_image_present AND lifestyle_image_present are true in FULL CONTEXT — fall back to A/C/E when only the UGC hero exists.`,
    ``,
    `PALETTE DERIVATION — pick a cohesive 2-5 color palette:`,
    `  1. Read the source photo's dominant tones (food → warm browns/golds; outdoor → earth + sky; product-only → background neutral).`,
    `  2. Pick a panel/card color that sits cleanly against those tones (avoid clashing hue, avoid matching so closely the photo bleeds in).`,
    `  3. Pick a CTA color that's the visual hot-spot — usually high-chroma, complementary to panel.`,
    `  4. Match brand.tone: "premium / minimal" → restrained near-monochrome; "energetic / playful" → saturated + bold.`,
    `  5. Emit the picked colors as a 2-5 entry color_palette array of #rrggbb strings.`,
    ``,
    `CRITICAL: if hierarchy_spec.strategy.social_proof_type is anything OTHER than "none" / "absent" / empty, your HTML MUST include a visible proof element bound to actual proof data — quote text from social_proof.primary_quote.text / secondary_quotes[*].text, rating from product.rating + product.review_count, top_comment from social_context.top_comments[*].text, or rating distribution from product.rating_distribution. Don't fake testimonials. If no proof data exists, set proof zone to absent in your hierarchy_spec.`,
    ``,
    `OUTPUT JSON shape (response_format strict):`,
    `  html             — complete <html>…</html> document (200-30000 chars)`,
    `  css_extracted    — leave "" (inline style is fine)`,
    `  rationale        — 1-3 sentences explaining how composition serves the Director concept + which signal drove the call`,
    `  creative_style   — echo back ${creativeStyle}`,
    `  color_palette    — array of 2-5 hex strings you picked`,
    `  elements_used    — array of role names you rendered (e.g. "hero_media","headline","cta","quote_card")`,
    `  elements_skipped — array of "<role> — <reason>" entries for things you intentionally omitted`,
    `  hierarchy_spec   — { strategy:{archetype,layout_family,emotional_hook,social_proof_type,product_priority,ugc_priority,comment_priority,stat_priority,cta_emphasis}, layout:{layout_family,visual_direction:{},zones:[{role,priority,anchor,weight,component_style}]} }`,
    ``,
    `The hierarchy_spec mirror lets the Pre-Judge filter check proof-strategy compliance without parsing your HTML — it MUST honestly describe what you rendered.`
  ].join('\n');

  const userLines = [];
  userLines.push(`── CREATIVE DIRECTION (from the Director — MATERIALIZE THIS CONCEPT) ──`);
  userLines.push('```json');
  userLines.push(JSON.stringify({
    concept_id:             concept.concept_id,
    name:                   concept.name,
    archetype:              concept.archetype,
    layout_family:          concept.layout_family,
    emotional_hook:         concept.emotional_hook,
    social_proof_type:      concept.social_proof_type,
    product_priority:       concept.product_priority,
    ugc_priority:           concept.ugc_priority,
    comment_priority:       concept.comment_priority,
    stat_priority:          concept.stat_priority,
    cta_emphasis:           concept.cta_emphasis,
    recommended_components: concept.recommended_components || {},
    rationale:              concept.rationale
  }, null, 2));
  userLines.push('```');
  userLines.push(``);
  userLines.push(`Your hierarchy_spec MUST mirror this concept's archetype, layout_family, emotional_hook, social_proof_type, *_priority, and cta_emphasis VERBATIM. Use recommended_components as defaults; override only when a constraint demands it (note in rationale).`);
  userLines.push(``);

  // VIDEO-OVERLAY mode — source media is a video. The renderer screenshots
  // with omitBackground:true and Cloudinary composites the resulting
  // transparent PNG over the source video. Three strict requirements
  // for the LLM:
  //   1. body MUST have background:transparent
  //   2. The media zone at the JSON Generator's exact rect MUST be
  //      transparent — no <img>, no background fill, just an empty
  //      positioned <div data-media-slot="true"> for clarity
  //   3. Every OTHER zone (panel, headline, CTA, logo) renders
  //      normally as it would in static mode
  if (videoMode && mediaRect) {
    userLines.push(`VIDEO-OVERLAY MODE — source media is a video. Your HTML will be screenshot with omitBackground:true and Cloudinary will composite the resulting transparent PNG over the source video. HARD REQUIREMENTS:`);
    userLines.push(`  1. body MUST set background:transparent (NOT a hex color, NOT white). Inline style="background:transparent" on the body tag is required.`);
    userLines.push(`  2. The media zone MUST be a transparent rectangle at EXACTLY x:${mediaRect.x}, y:${mediaRect.y}, width:${mediaRect.w}, height:${mediaRect.h}. Emit it as <div data-media-slot="true" style="position:absolute;left:${mediaRect.x}px;top:${mediaRect.y}px;width:${mediaRect.w}px;height:${mediaRect.h}px;background:transparent"></div>. NO <img> inside this rect. NO background-color, NO background-image. The Cloudinary composite layers the video underneath, so this rect MUST stay see-through.`);
    userLines.push(`  3. Every OTHER zone (panel, headline, CTA, logo, badges, eyebrows) renders normally with opaque backgrounds and visible content as you'd author for a static ad. Those zones land ON TOP of the video.`);
    userLines.push(`  4. Position the OTHER zones so they don't accidentally overlap the transparent slot's rect — the operator wants the video clearly visible in that area.`);
    userLines.push(`  5. CRITICAL — DO NOT emit any <img> tag whose src is product.hero_media.image, any product.hero_media.crops.<ratio> URL, or otherwise points at the source video's frames. ANYWHERE on the canvas. The video plays UNDERNEATH the transparent slot during playback — embedding the source frame as <img> anywhere freezes that frame and covers the live playback. If your archetype calls for a "hero photo panel" / "full-bleed hero" composition, the TRANSPARENT SLOT itself IS that hero panel (the video fills it during playback, the first frame fills it on the poster). Build chrome (panels, text, CTA, logo) AROUND the slot rect — never reference product.hero_media URLs inside an <img src>. Other product imagery (product.product_image, product.lifestyle_image, brand.logo) IS allowed as <img> in non-slot zones.`);
    userLines.push(``);
  }

  if (images.length) {
    userLines.push(`VISION INPUTS (attached as image parts in this message, in order):`);
    images.forEach((img, i) => userLines.push(`  image[${i}] — ${img.role}: ${img.label || ''}`));
    userLines.push(``);
    userLines.push(`Reference these images by URL when embedding into your HTML. The actual URL strings to use are in the FULL CONTEXT below — pull them verbatim.`);
    userLines.push(``);
  }

  if (ctx) {
    userLines.push(`FULL CONTEXT (structured JSON — use brand depth, commerce, cross-media signals, real proof text, copy candidates):`);
    userLines.push('```json');
    userLines.push(JSON.stringify(ctx, null, 2));
    userLines.push('```');
    userLines.push(``);
    userLines.push(`PICK COPY FROM copy_candidates arrays — use the index 0 entry unless a different pick clearly serves the concept better. The chosen string is what ships in the final ad.`);
    userLines.push(``);
    const urlAllowlist = collectImageUrls(input);
    if (urlAllowlist.length) {
      userLines.push(`AVAILABLE IMAGE URLS — these are the ONLY strings you may put in any <img src>. Copy them EXACTLY as written. Do NOT modify, shorten, transform, or invent URLs. If none of these fit a zone you wanted to fill, OMIT the <img> tag entirely and use a styled <div> instead (decorative panels beat broken images).`);
      urlAllowlist.forEach(entry => {
        userLines.push(`  [${entry.role}] ${entry.url}`);
      });
      userLines.push(``);
      userLines.push(`Any <img src> that does NOT exactly match one of the URLs above will fail validation and your candidate will be discarded. Hosts other than res.cloudinary.com, cdn.brandfetch.io, cdn.shopify.com, scontent.cdninstagram.com, *.fbcdn.net are auto-rejected.`);
    } else {
      userLines.push(`IMAGE URLS — embed verbatim from these paths:`);
      userLines.push(`  product.hero_media.image — canvas-ratio hero crop`);
      userLines.push(`  product.image — catalog product-only shot`);
      userLines.push(`  product.lifestyle_image.image — catalog lifestyle shot (when present)`);
      userLines.push(`  product.product_image.image — catalog product-only (when present)`);
      userLines.push(`  product.hero_media.crops.<ratio_key> — alt-ratio hero crops (1_1, 4_5, 5_4, 9_16, 1_91_1) for inset/secondary use`);
      userLines.push(`  brand.logo — only when logo_present is true`);
    }
    userLines.push(``);
  } else {
    userLines.push(`MINIMAL CONTEXT (no rich context available):`);
    userLines.push(`BRAND: ${JSON.stringify(input.brand || {})}`);
    userLines.push(`PRODUCT: ${JSON.stringify({ name: input.product?.name, image: input.product?.image })}`);
    userLines.push(``);
  }

  userLines.push(`Emit the complete HTML document now.`);
  const user = userLines.join('\n');
  return { system, user, images };
}

// Pull every embeddable image URL out of the layout input into a flat
// allowlist. The LLM gets this as an explicit "USE EXACTLY ONE OF
// THESE" list so it can't hallucinate cdn.openai.com paths from its
// training set — there's no ambiguity about what strings are valid.
// Only emits hosts on the validator's allowlist (res.cloudinary.com,
// cdn.brandfetch.io, etc.) so the prompt and validator agree.
const ALLOWED_PROMPT_HOSTS = [
  'res.cloudinary.com', 'cdn.brandfetch.io', 'cdn.shopify.com',
  'scontent.cdninstagram.com', 'fbcdn.net', 'instagram.com'
];
function isAllowedPromptHost(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return ALLOWED_PROMPT_HOSTS.some(h => host === h || host.endsWith('.' + h) || host.endsWith(h));
  } catch (_) { return false; }
}
function collectImageUrls(input) {
  const out = [];
  const seen = new Set();
  const push = (role, url) => {
    if (typeof url !== 'string' || !url) return;
    if (seen.has(url)) return;
    if (!isAllowedPromptHost(url)) return;   // skip bad hosts so prompt and validator stay in sync
    seen.add(url);
    out.push({ role, url });
  };
  const p = input?.product || {};
  push('hero',              p.hero_media?.image);
  push('product_only',      p.product_image?.image || p.image);
  push('lifestyle',         p.lifestyle_image?.image);
  // Alt-ratio hero crops — flatten the crops map.
  const crops = p.hero_media?.crops || {};
  Object.keys(crops).forEach(k => push(`hero_crop_${k}`, crops[k]?.url || crops[k]));
  push('logo',              input?.brand?.logo);
  return out;
}

// Compose OpenAI's multimodal user message: text + image_url parts
// when vision attachments are present.
function composeUserContent(userText, images) {
  if (!images.length) return userText;
  const parts = [{ type: 'text', text: userText }];
  for (const img of images) {
    if (img.url) parts.push({ type: 'image_url', image_url: { url: img.url } });
  }
  return parts;
}

// OpenAI strict json_schema for the response. Mirrors ai_canvas_html.v1
// but flattened to satisfy strict mode (no regex patterns, all
// properties required, additionalProperties: false at every level).
function buildResponseSchema() {
  return {
    name: 'ai_canvas_html_v1',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['html', 'css_extracted', 'rationale', 'creative_style', 'color_palette', 'elements_used', 'elements_skipped', 'hierarchy_spec'],
      properties: {
        html:           { type: 'string' },
        css_extracted:  { type: 'string' },
        rationale:      { type: 'string' },
        creative_style: { type: 'string', enum: ['brand_led', 'ugc_led', 'social_proof_led', 'editorial', 'promotional'] },
        color_palette:  {
          type: 'array',
          items: { type: 'string' }
        },
        elements_used:    { type: 'array', items: { type: 'string' } },
        elements_skipped: { type: 'array', items: { type: 'string' } },
        hierarchy_spec: {
          type: 'object',
          additionalProperties: false,
          required: ['strategy', 'layout'],
          properties: {
            strategy: {
              type: 'object',
              additionalProperties: false,
              required: ['archetype', 'layout_family', 'emotional_hook', 'social_proof_type', 'product_priority', 'ugc_priority', 'comment_priority', 'stat_priority', 'cta_emphasis'],
              properties: {
                archetype:         { type: 'string' },
                layout_family:     { type: 'string' },
                emotional_hook:    { type: 'string' },
                social_proof_type: { type: 'string' },
                product_priority:  { type: 'string' },
                ugc_priority:      { type: 'string' },
                comment_priority:  { type: 'string' },
                stat_priority:     { type: 'string' },
                cta_emphasis:      { type: 'string' }
              }
            },
            layout: {
              type: 'object',
              additionalProperties: false,
              required: ['layout_family', 'zones'],
              properties: {
                layout_family: { type: 'string' },
                zones: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['role', 'priority', 'anchor', 'component_style'],
                    properties: {
                      role:            { type: 'string' },
                      priority:        { type: 'string' },
                      anchor:          { type: 'string' },
                      component_style: { type: 'string' }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  };
}

// Canvas pixel dimensions per ratio — mirrors aiCanvasSpecService.parseRatio.
function canvasDims(aspectRatio) {
  const map = {
    '1:1':    { width: 1000, height: 1000 },
    '4:5':    { width: 1000, height: 1250 },
    '5:4':    { width: 1250, height: 1000 },
    '9:16':   { width: 1000, height: 1778 },
    '1.91:1': { width: 1500, height: 785 }
  };
  return map[aspectRatio] || map['1:1'];
}

module.exports = {
  generateForArtifact,
  enabled,
  MODEL_ID,
  HTML_SCHEMA_VERSION
};
