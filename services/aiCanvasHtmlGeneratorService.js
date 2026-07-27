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


const AiCanvasArtifact          = require('../models/AiCanvasArtifact');
const AiHtmlValidationArtifact  = require('../models/AiHtmlValidationArtifact');
const CreativeDirectionArtifact = require('../models/CreativeDirectionArtifact');
const { buildAiCanvasContext }  = require('./aiCanvasInputBuilder');
const { loadContext }           = require('./layoutInputService');
const { trackLlmCall }          = require('./costTracker');
const { validateCandidate }     = require('./htmlValidationService');

const { chatCompletion } = require('./atlasLlmService');

const MODEL_ID            = 'gpt-4.1';
const TEMPERATURE         = 0.85;
const N_CANDIDATES_DEFAULT = 2;        // HTML output is ~3-5× longer than JSON spec — start conservative
const MAX_TOKENS          = 12000;     // animated video-overlay HTML with cycling reviews can exceed 8K chars
const HTML_SCHEMA_VERSION = '2.4.0';  // 2.4: video-overlay animation unlock — CSS @keyframes allowed, cycling reviews, 5s timing context. MAX_TOKENS raised to 12000. 2.3: JSON Gen retirement (AI_LAYOUT_DIRECT_HTML flag). Response schema gains a `copy_picks` object so HTML Gen owns the final headline/eyebrow/cta/subheadline strings; persisted on AiCanvasArtifact.copyPicks for downstream consumers (Image Ref) that previously read pickCopyFromSpec(canvasSpec). Also handles canvasSpec=null gracefully: videoMode derives from sourceMedia.fileType alone, mediaRect defaults to the full canvas (so video bleeds edge-to-edge when no zones[] is available to declare a slot rect). 2.2: platform-format-aware Phase 4 — passes platformFormat into validateCandidate so the new safe_area_violation HARD rule catches chrome that intrudes Reels reserved bands. Pairs with the JSON Gen's FORMAT CONSTRAINTS section (SPEC 3.1.0): two LLMs + one validator all reasoning in the same safe-area pixel space. 2.1: HTML Gen format-aware prompt (Phase 3). 2.0: video-overlay prompt rolled back to pipeline fundamentals.

// Rewrite a Cloudinary /video/upload/ URL to a still JPEG so it's
// safe to embed as an <img> source. Uses so_2 (2 seconds in) instead
// of so_auto — so_auto is the AI-Preview add-on and 400s on accounts
// without it. so_2 skips typical intro flashes and works on any plan.
// Non-video URLs and non-Cloudinary videos pass through unchanged.
function toStillIfVideo(url) {
  if (!url || typeof url !== 'string') return url;
  if (!url.includes('/video/upload/')) return url;
  return url
    .replace('/video/upload/', '/video/upload/so_2,f_jpg,q_auto:good/')
    .replace(/\.(mp4|mov|webm|m4v)(\?.*)?$/i, '.jpg$2');
}

function enabled() {
  return String(process.env.AI_HTML_LAYOUT_ENABLED || '').toLowerCase() === 'true';
}

// Entry point. Called fire-and-forget from aiCanvasSpecService once
// the JSON spec generation completes. Idempotent on (aiCanvasArtifactId,
// htmlSchemaVersion) — if the artifact already has outputHtml at the
// current schema version, skip.
async function generateForArtifact({ aiCanvasArtifactId, refresh = false, operatorPrompt = null }) {
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
  // body{background:transparent} + leaves the media rect transparent so
  // the Puppeteer omitBackground screenshot yields a transparent PNG
  // Cloudinary composites over the source video.
  //
  // Slot picking: prefer slot:'product.hero_media' (the canonical
  // single-video-slot contract the JSON Gen targets per SPEC v3.0.0),
  // fall back to largest media-kind rect for backwards-compat with
  // pre-2.10.0 cached specs.
  //
  // The mediaRect handed to the prompt is whatever the spec emitted —
  // full canvas, inset, side strip, diagonal-carve via clipPolygon, all
  // valid. The v2 video composite chain (e283b6c) uses c_fill,g_auto at
  // canvas aspect regardless of slot rect, so the slot rect's role is
  // purely communicating to the LLM "make this region transparent so
  // your design's intended video focus area reads through." Video
  // bleeds through anywhere the overlay isn't opaque, not just at the
  // slot rect — so chrome placement matters more than slot placement.
  //
  // No media zone at all on a video source → videoMode=false, render
  // as static PNG. composeVideoOutput returns null and the pipeline
  // ships the static PNG as the ad. (Shouldn't happen since the JSON
  // Gen mandates one media zone, but the fallback keeps the pipeline
  // robust to any miss.)
  // Prefer platformFormat-keyed canvas (covers all 5 surfaces with correct
  // safe-area metadata). Fall back to aspect-ratio map for legacy V1 callers
  // that never wrote canvas.platformFormat.
  const { canvasForPlatformFormat } = require('./platformFormats');
  const dims = canvasForPlatformFormat(canvas.platformFormat) || canvasDims(canvas.aspectRatio);
  const Media = require('../models/Media');
  // Detect-pipeline outputs the prompts use as hard guardrails:
  //   text[]             OCR boxes → AVOID OVERLAYING EXISTING TEXT block
  //   subjects[]         subject bboxes → AVOID OVERLAYING THE SUBJECT block
  //   primarySubjectDesc human-readable label of the dominant subject
  // Chrome placed on top of either set creates legibility problems
  // (double-text) or hides the product (subject occlusion).
  const sourceMedia = await Media.findById(canvas.mediaId)
    .select('fileType text subjects primarySubjectDesc').lean();
  const sourceText    = Array.isArray(sourceMedia?.text) ? sourceMedia.text : [];
  const sourceSubjects = Array.isArray(sourceMedia?.subjects) ? sourceMedia.subjects : [];
  const sourcePrimarySubjectDesc = sourceMedia?.primarySubjectDesc || null;
  // videoMode was the legacy "transparent slot for Cloudinary video
  // composite" flag. That path is retired — HTML Gen only runs for
  // kind='image' ads now (routing enforces this via renderRoute).
  // Video-seeded image ads get a picked-frame poster URL from
  // layoutInput.media.hero_media.image and render as any other static
  // image. See renderService.renderCreative for the parent flow.
  const videoMode = false;
  const mediaRect = null;

  // Platform-format-aware ad generation (Phase 3). Read from the
  // artifact (stamped by aiCanvasSpecService.getOrGenerate, plumbed
  // from the wizard / Ad row). Drives the FORMAT CONSTRAINTS section
  // injected into the prompt with safe-area pixel boxes for Reels.
  const platformFormat = canvas.platformFormat || 'meta_feed_1_1';

  // Phase A5b — detect V2 concept (has media_picks / output_shape) and
  // dispatch to the V2 prompt builder. V2 concepts declare WHICH media
  // to use + WHAT shape to materialize + WHICH copy strings to render,
  // so the prompt collapses the archetype menu and the LLM's job
  // becomes "execute the declared layout" rather than "pick a strategy
  // and invent a layout." Legacy concepts (no media_picks / no
  // output_shape) keep the existing prompt.
  const isV2Concept = !!(concept && (
    (Array.isArray(concept.media_picks) && concept.media_picks.length > 0)
    || concept.output_shape
  ));
  let mediaUrlMap = null;
  if (isV2Concept) {
    // Resolve concept.media_picks[*].media_id → Media.fileUrl for the
    // V2 prompt's "use THESE URLs verbatim" block. One bulk query per
    // generation; misses default to null and the prompt builder
    // gracefully skips them.
    //
    // Video URLs are rewritten to Cloudinary picked-frame stills so
    // the LLM never sees a .mp4 in the "use these URLs verbatim"
    // block. HTML Gen only runs for kind='image' output, and <img>
    // tags can't render .mp4 sources.
    const Media = require('../models/Media');
    const ids = concept.media_picks.map(p => p.media_id).filter(Boolean);
    const docs = ids.length ? await Media.find({ _id: { $in: ids } }).select('_id fileUrl').lean() : [];
    mediaUrlMap = new Map(docs.map(d => [String(d._id), toStillIfVideo(d.fileUrl)]));
  }

  const { system, user, images } = isV2Concept
    ? buildPromptV2({
        canvas, concept, input, richContext, dims, videoMode, mediaRect, platformFormat,
        mediaUrlMap, sourceText, sourceSubjects, sourcePrimarySubjectDesc, operatorPrompt
      })
    : buildPrompt({
        canvas, concept, input, richContext, dims, videoMode, mediaRect, platformFormat,
        sourceText, sourceSubjects, sourcePrimarySubjectDesc, operatorPrompt
      });

  const nCandidates = N_CANDIDATES_DEFAULT;
  const responseSchema = buildResponseSchema();

  // Parallel candidate generation — same pattern as JSON Generator.
  const userContent = composeUserContent(user, images);

  const oneGeneration = async (genIndex) => {
    const t0 = Date.now();
    const completion = await chatCompletion(
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
      {
        model: MODEL_ID,
        response_format: { type: 'json_schema', json_schema: responseSchema },
        messages: [
          { role: 'system', content: system },
          { role: 'user',   content: userContent }
        ],
        temperature: TEMPERATURE,
        max_tokens:  MAX_TOKENS
      }
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
    colorPalette:  Array.isArray(c.color_palette) ? c.color_palette : [],
    platformFormat
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

  // Pull copy_picks off the winner. Schema marks them required so the
  // LLM always returns the object; null fields are normal (the LLM
  // decided not to render that copy role). Persisting on copyPicks
  // decouples Image Ref from canvasSpec — when JSON Gen is retired
  // (AI_LAYOUT_DIRECT_HTML=true) and canvasSpec is null, Image Ref
  // reads canvas.copyPicks instead of mining zones[].
  const cp = winner.copy_picks || {};
  const copyPicks = {
    headline:    cp.headline    || null,
    subheadline: cp.subheadline || null,
    eyebrow:     cp.eyebrow     || null,
    cta:         cp.cta         || null
  };

  // Persist HTML + palette + copyPicks on the same AiCanvasArtifact.
  // outputKind stays 'spec' for now — Phase 6.3 flips renderer to read 'html'.
  await AiCanvasArtifact.updateOne(
    { _id: canvas._id },
    {
      $set: {
        outputHtml:        winner.html || null,
        outputCss:         winner.css_extracted || null,
        colorPalette:      Array.isArray(winner.color_palette) ? winner.color_palette : [],
        copyPicks,
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

// Platform-format-aware HTML constraints (Phase 3). Returns a prompt
// block describing safe-area pixel boxes for the format. For Reels,
// the top + bottom bands are reserved for IG/FB UI chrome (caption,
// creator overlay, like / comment / share controls) and the LLM MUST
// keep chrome zones inside the middle content rect. Phase 4 will add
// the validator that catches violations as a HARD rejection.
//
// Pixel boxes use the normalized canvas dims (1000×1778 for 9:16
// instead of the actual 1080×1920) so the LLM thinks in the same
// coordinate space the rest of the prompt uses.
// AVOID OVERLAYING EXISTING TEXT — if the detect pipeline's OCR found
// burned-in text on the source media (captions, watermarks, product
// labels, creator handles), warn the LLM with pixel-space bboxes so it
// can route chrome around those regions. Returns '' when no OCR text
// is available (empty block stays out of the prompt entirely).
function buildAvoidExistingTextBlock(sourceText, dims) {
  const boxes = (sourceText || []).filter(
    t => t && Number.isFinite(t.x1) && Number.isFinite(t.y1)
      && Number.isFinite(t.x2) && Number.isFinite(t.y2)
  );
  if (!boxes.length) return '';
  const lines = [];
  lines.push(`AVOID OVERLAYING EXISTING TEXT (HARD CONSTRAINT)`);
  lines.push(`  The source media has visible text burned into the photo (captions, watermarks, product labels, etc.). Chrome layered on top of those regions creates a double-text mess that's unreadable. Route your layout AROUND these regions, NOT over them.`);
  lines.push(`  Pixel-space bounding boxes of existing text on the ${dims.width}×${dims.height} canvas:`);
  for (const t of boxes.slice(0, 8)) {
    const x = Math.round((t.x1 || 0) * dims.width);
    const y = Math.round((t.y1 || 0) * dims.height);
    const w = Math.round(((t.x2 || 0) - (t.x1 || 0)) * dims.width);
    const h = Math.round(((t.y2 || 0) - (t.y1 || 0)) * dims.height);
    const snippet = String(t.content || '').slice(0, 30).replace(/\s+/g, ' ');
    lines.push(`    • x:${x} y:${y} w:${w} h:${h}${snippet ? ` ("${snippet}")` : ''}`);
  }
  lines.push(`  If a chrome zone you'd place lands on one of these boxes, MOVE it to the opposite half of the canvas (or a different quadrant) so the existing text stays visible and your text doesn't compete with it.`);
  return lines.join('\n');
}

// AVOID OVERLAYING THE SUBJECT — chrome placed on top of the detected
// subject(s) hides the product / hero subject of the ad. Lists pixel-
// space bboxes for primary + secondary subjects and proposes safe
// zones based on where the primary sits. Returns '' when no subjects
// were detected (the block stays out of the prompt entirely).
function buildAvoidSubjectBlock(subjects, primarySubjectDesc, dims) {
  const boxes = (subjects || []).filter(
    s => s && (s.role === 'primary' || s.role === 'secondary')
      && Number.isFinite(s.x1) && Number.isFinite(s.y1)
      && Number.isFinite(s.x2) && Number.isFinite(s.y2)
  );
  if (!boxes.length) return '';
  const primaries = boxes.filter(s => s.role === 'primary');
  const secondaries = boxes.filter(s => s.role === 'secondary');
  const lines = [];
  lines.push(`AVOID OVERLAYING THE SUBJECT (HARD CONSTRAINT)`);
  lines.push(`  The detect pipeline identified the visual subject(s) of the source media. Chrome placed on top of these regions OBSCURES THE PRODUCT — defeating the purpose of the ad. Route every chrome zone AROUND the subject, never on top of it.`);
  if (primarySubjectDesc) {
    lines.push(`  Primary subject: "${String(primarySubjectDesc).slice(0, 120)}"`);
  }
  lines.push(`  Pixel-space bounding boxes on the ${dims.width}×${dims.height} canvas:`);
  for (const s of primaries.slice(0, 3)) {
    const x = Math.round((s.x1 || 0) * dims.width);
    const y = Math.round((s.y1 || 0) * dims.height);
    const w = Math.round(((s.x2 || 0) - (s.x1 || 0)) * dims.width);
    const h = Math.round(((s.y2 || 0) - (s.y1 || 0)) * dims.height);
    const desc = String(s.description || s.id || 'subject').slice(0, 40).replace(/\s+/g, ' ');
    lines.push(`    • PRIMARY: x:${x} y:${y} w:${w} h:${h} ("${desc}")`);
  }
  for (const s of secondaries.slice(0, 4)) {
    const x = Math.round((s.x1 || 0) * dims.width);
    const y = Math.round((s.y1 || 0) * dims.height);
    const w = Math.round(((s.x2 || 0) - (s.x1 || 0)) * dims.width);
    const h = Math.round(((s.y2 || 0) - (s.y1 || 0)) * dims.height);
    const desc = String(s.description || s.id || 'subject').slice(0, 40).replace(/\s+/g, ' ');
    lines.push(`    • secondary: x:${x} y:${y} w:${w} h:${h} ("${desc}")`);
  }
  const primary = primaries[0];
  if (primary) {
    const cy = ((primary.y1 || 0) + (primary.y2 || 0)) / 2;
    const cx = ((primary.x1 || 0) + (primary.x2 || 0)) / 2;
    lines.push(`  Suggested safe zones (chrome MAY land here):`);
    if (cy >= 0.35 && cy <= 0.65) {
      lines.push(`    • Top strip: above the subject`);
      lines.push(`    • Bottom strip: below the subject`);
    } else if (cy < 0.5) {
      lines.push(`    • Bottom strip: below the subject (roomiest)`);
    } else {
      lines.push(`    • Top strip: above the subject (roomiest)`);
    }
    if (cx <= 0.35 || cx >= 0.65) {
      const otherSide = cx <= 0.35 ? 'right' : 'left';
      lines.push(`    • Vertical strip on the ${otherSide} side of the canvas (subject is offset to the other side)`);
    }
  }
  lines.push(`  Self-check before emitting: for each chrome zone, confirm its bbox does NOT intersect any of the boxes above. If it does, move the zone into one of the suggested safe zones.`);
  return lines.join('\n');
}

function buildFormatConstraintsBlock(platformFormat, dims) {
  const { getFormatCaps, creativeBriefForPlatformFormat } = require('./platformFormats');
  const caps = getFormatCaps(platformFormat) || getFormatCaps('meta_feed_1_1');
  const { canvas, deliveryDims, safeArea, label, aspectRatio } = caps;
  const brief = creativeBriefForPlatformFormat(platformFormat);

  const lines = [];
  if (brief) {
    lines.push(`SURFACE CONTEXT — ${label}:`);
    lines.push(`  ${brief}`);
    lines.push(``);
  }
  lines.push(`FORMAT CONSTRAINTS — ${platformFormat} (${label}, ${aspectRatio}):`);
  const deliveryStr = deliveryDims
    ? ` (host delivers as ${deliveryDims.width}×${deliveryDims.height}; our normalized space is ${canvas.width}×${canvas.height})`
    : '';
  lines.push(`  Canvas:             ${dims.width}×${dims.height}px${deliveryStr}`);

  const hasSafeArea = safeArea.top > 0 || safeArea.bottom > 0;
  if (hasSafeArea) {
    if (safeArea.top > 0) {
      lines.push(`  Reserved top band:  x:0, y:0, w:${dims.width}, h:${safeArea.top} — platform UI (caption / creator chip) overlays here`);
    }
    if (safeArea.bottom > 0) {
      lines.push(`  Reserved bottom band: x:0, y:${dims.height - safeArea.bottom}, w:${dims.width}, h:${safeArea.bottom} — platform UI (like / share / reply controls) overlays here`);
    }
    const safeY = safeArea.top;
    const safeH = dims.height - safeArea.top - safeArea.bottom;
    const pct   = Math.round((safeH / dims.height) * 100);
    lines.push(`  Content safe rect:  x:0, y:${safeY}, w:${dims.width}, h:${safeH} (the middle ${pct}% of canvas height)`);
    lines.push(`  HARD: NO chrome (panel, text, headline, eyebrow, cta, badges, logo, quote_card, proof_bar) may render in the reserved bands. Every chrome zone's bounding box MUST fit inside the content safe rect (y >= ${safeY} AND y + height <= ${dims.height - safeArea.bottom}). Viewers see those bands COVERED by the platform's native UI — content placed there is invisible and the validator will reject your candidate as a HARD violation.`);
    lines.push(`  Media slot (transparent region for video/image) CAN cross the reserved bands — the underlying media bleeds edge-to-edge and the platform's UI overlays it. Only CHROME has the safe-area constraint.`);
    lines.push(`  Composition guidance: use the middle ${safeH}px of height as your design canvas. Bottom panel bands should end at y=${dims.height - safeArea.bottom} (not at canvas bottom). Top eyebrow rules should start at y=${safeY} (not at canvas top). Floating cards / CTAs in the middle band are ideal.`);
  } else {
    lines.push(`  Safe zones:         none — surface has no reserved bands. Chrome can use the full canvas.`);
  }
  return lines.join('\n');
}

// ══════════════════════════════════════════════════════════════════════
// Phase A5b — V2 prompt builder for concept-driven Ads
// ══════════════════════════════════════════════════════════════════════
//
// Consumed when the loaded concept has media_picks + output_shape (the
// shape directConceptsRound emits). Collapses the archetype menu —
// the concept already declared archetype + layout_family + output_shape
// + media_picks + copy_picks. LLM's job is execution, not strategy.
//
// Differences from V1 buildPrompt:
//   • No COMPOSITION ARCHETYPES menu (concept names the archetype)
//   • No PICK COPY FROM copy_candidates block (concept's copy_picks
//     are the ground truth strings to render)
//   • Explicit URL allowlist scoped to concept.media_picks — the LLM
//     CANNOT use other URLs (validator will reject anything else)
//   • Output shape block instructs single/collage/grid composition
//   • Same hard rules (size, no scripts, no Lorem, allowed hosts, etc.)
//     and same FORMAT CONSTRAINTS for safe-area enforcement.
function buildPromptV2({ canvas, concept, input, richContext, dims, videoMode = false, mediaRect = null, platformFormat = 'meta_feed_1_1', mediaUrlMap = null, sourceText = [], sourceSubjects = [], sourcePrimarySubjectDesc = null, operatorPrompt = null }) {
  const ctx    = richContext?.text || null;
  const images = richContext?.images || [];
  const aspectRatio   = canvas.aspectRatio;
  const formatConstraints = buildFormatConstraintsBlock(platformFormat, dims);
  const avoidTextBlock    = buildAvoidExistingTextBlock(sourceText, dims);
  const avoidSubjectBlock = buildAvoidSubjectBlock(sourceSubjects, sourcePrimarySubjectDesc, dims);

  // Resolve concept.media_picks → URLs. Skip picks whose mediaId
  // didn't resolve (defensive — should not happen since the Director
  // round only emits universe-resident IDs, but the validator drops
  // any survivors anyway).
  const resolvedPicks = (concept.media_picks || []).map(p => ({
    media_id: p.media_id,
    role:     p.role,
    notes:    p.notes || null,
    url:      mediaUrlMap?.get(String(p.media_id)) || null
  })).filter(p => p.url);

  const shape = concept.output_shape || {};
  const cp = concept.copy_picks || {};

  const shapeGuidance = (() => {
    switch (shape.format) {
      case 'static_single':
        return `Single hero image fills the canvas (or canvas-minus-chrome region). The one media_pick is the visual anchor. Chrome (headline, eyebrow, cta, etc.) sits around it per the archetype.`;
      case 'static_collage':
        return `Asymmetric collage of ${shape.tile_count || resolvedPicks.length} images. Tiles may overlap, sit at slight angles, or break the grid for editorial feel. NOT a clean grid — use varied tile sizes and intentional negative space.`;
      case 'static_grid':
        return `Clean grid of ${shape.tile_count || resolvedPicks.length} images. Pick a layout (2×2, 1×3, 3×1, etc.) that uses every tile equally. Tight alignment, consistent gutters, no rotation. Chrome sits in a dedicated band, not overlapping tiles.`;
      default:
        return `Unknown output_shape — fall back to single hero composition.`;
    }
  })();

  const conceptStrategy = [
    `CREATIVE CONCEPT (from the Director — MATERIALIZE THIS, don't reinvent):`,
    `  concept_id:        ${concept.concept_id}`,
    `  name:              ${concept.name || '-'}`,
    `  archetype:         ${concept.archetype}`,
    `  layout_family:     ${concept.layout_family || '-'}`,
    `  creative_style:    ${concept.creative_style}`,
    `  emotional_hook:    ${concept.emotional_hook}`,
    `  social_proof_type: ${concept.social_proof_type}`,
    `  cta_emphasis:      ${concept.cta_emphasis}`,
    `  output_shape:      format=${shape.format} tile_count=${shape.tile_count || resolvedPicks.length}`,
    `  rationale:         ${concept.rationale || '-'}`
  ].join('\n');

  const mediaBlock = resolvedPicks.map((p, i) => (
    `  [${i}] media_id=${p.media_id} role=${p.role} url=${p.url}${p.notes ? ` notes=${p.notes}` : ''}`
  )).join('\n');

  const copyBlock = [
    `COPY (from the Director — render VERBATIM, do not substitute, do not omit):`,
    cp.headline    ? `  headline:    "${cp.headline}"`    : `  headline:    (none — omit headline element)`,
    cp.eyebrow     ? `  eyebrow:     "${cp.eyebrow}"`     : `  eyebrow:     (none — omit eyebrow element)`,
    cp.subheadline ? `  subheadline: "${cp.subheadline}"` : `  subheadline: (none — omit subheadline element)`,
    cp.cta         ? `  cta:         "${cp.cta}"`         : `  cta:         (none — omit cta element)`
  ].join('\n');

  const allowedUrls = resolvedPicks.map(p => p.url);

  const system = [
    `You are a senior creative director + frontend developer producing a single complete HTML+CSS social-media ad creative.`,
    ``,
    `Your output: ONE self-contained HTML document the renderer feeds to a headless browser via page.setContent(). It will be screenshotted at exactly ${dims.width}×${dims.height}px — every visible element must fit inside that viewport.`,
    ``,
    formatConstraints,
    ``,
    ...(avoidSubjectBlock ? [avoidSubjectBlock, ``] : []),
    ...(avoidTextBlock    ? [avoidTextBlock,    ``] : []),
    `HARD RULES:`,
    `- Output a complete <html>...</html> document. <head> with <meta charset>, <title>, single inline <style>. <body> with the ad's visible content.`,
    `- <body> MUST be sized exactly ${dims.width}px × ${dims.height}px via inline style="width:${dims.width}px;height:${dims.height}px;margin:0;overflow:hidden". No scrollbars, no overflow.`,
    `- BOTTOM SAFETY BAND — reserve at least 32px between the bottom edge of any TEXT or INTERACTIVE element (h1, h2, subheadline, .cta, .btn, button, price, footer text, brand mark) and the ${dims.height}px canvas bottom. Same rule for top edge (≥ 24px), left/right (≥ 24px). Fonts render at slightly larger metrics in Chromium than the LLM's mental model — bottom < 32px reliably clips descenders and button borders in the final PNG. Decorative shapes (background circles, gradient orbs, image bleeds) MAY sit against or beyond the edge; content must not.`,
    `- NO <script>. NO external <link rel="stylesheet"> or @import EXCEPT for a single Google Fonts <link> in <head>.`,
    `- Google Fonts allowed. Use ONE <link href="https://fonts.googleapis.com/css2?family=<Family>:wght@<weights>&display=swap" rel="stylesheet"> in <head>, then reference the family in font-family. WHITELIST (pick 1-2 families max): Inter, Playfair Display, Lora, Cormorant, Cormorant Garamond, Antonio, Montserrat, Great Vibes, DM Sans, Bebas Neue, Anton, Oswald, IBM Plex Sans, Poppins, Nunito, Quicksand. If unsure, use Inter (sans) + Playfair Display (serif). No other font hosts.`,
    `- All <img src> values MUST come from the ALLOWED URLS block below — verbatim, no transformations, no invented URLs. Hosts outside res.cloudinary.com / cdn.brandfetch.io / cdn.shopify.com / scontent.cdninstagram.com / *.fbcdn.net auto-fail validation.`,
    `- Render copy VERBATIM from the COPY block — no rewriting, no substitution, no Lorem Ipsum. Omit elements whose copy is "(none)".`,
    `- Render copy LEGIBLY: white-space, kerning, no clipping. Color text + background pairs must achieve WCAG AA contrast (≥ 4.5:1 normal, ≥ 3:1 for ≥ 24px or bold ≥ 19px).`,
    `- All positioning via flexbox / grid / absolute. Use ${dims.width}×${dims.height}px-scoped values (px / %) — NO vw/vh.`,
    ``,
    conceptStrategy,
    ``,
    `OUTPUT SHAPE GUIDANCE:`,
    `  ${shapeGuidance}`,
    ``,
    `ALLOWED URLS (the ONLY strings you may put in any <img src>; verbatim only):`,
    mediaBlock || `  (none — concept emitted no resolvable media_picks; render text-only)`,
    ``,
    copyBlock,
    ``,
    `PALETTE DERIVATION — pick a cohesive 2-5 color palette grounded in the source photo(s)' dominant tones. Match brand.tone (premium / minimal → restrained near-monochrome; energetic / playful → saturated + bold). Emit colors picked as a 2-5 entry color_palette array of #rrggbb strings.`,
    ``,
    `OUTPUT JSON shape (response_format strict):`,
    `  html             — complete <html>…</html> document (200-30000 chars)`,
    `  css_extracted    — leave ""`,
    `  rationale        — 1-2 sentences on how composition serves the declared archetype + output_shape`,
    `  creative_style   — echo ${concept.creative_style}`,
    `  color_palette    — array of 2-5 hex strings you picked`,
    `  copy_picks       — ECHO the COPY block back verbatim: { headline, subheadline, eyebrow, cta } — null where the copy was null`,
    `  elements_used    — array of role names you rendered`,
    `  elements_skipped — array of "<role> — <reason>" entries`,
    `  hierarchy_spec   — { strategy:{archetype,layout_family,emotional_hook,social_proof_type,product_priority,ugc_priority,comment_priority,stat_priority,cta_emphasis}, layout:{layout_family,visual_direction:{},zones:[{role,priority,anchor,weight,component_style}]} } — echo the concept's strategy verbatim into the strategy block`
  ].join('\n');

  // VIDEO-OVERLAY mode — same rules as V1 path. Video source → transparent
  // body + media slot, no <img> using the source video's frames, no
  // clip-path-on-text-children, no backdrop-filter.
  const userLines = [];

  // Regeneration entry point — operator's refinement leads the user
  // prompt so GPT sees the requested change before the rest of the
  // copy/media context. Empty / null prompt → block omitted entirely.
  if (operatorPrompt && String(operatorPrompt).trim()) {
    userLines.push(`OPERATOR REFINEMENT (HIGHEST PRIORITY — overrides any conflicting stylistic default below):`);
    userLines.push(`  ${String(operatorPrompt).trim()}`);
    userLines.push(`Apply that refinement to your output. Concept, brand, copy, media URLs, and the hard rules above still bind — but where the operator's instruction conflicts with a stylistic default, the operator wins.`);
    userLines.push(``);
  }

  if (videoMode && mediaRect) {
    userLines.push(`VIDEO-OVERLAY MODE — source media is a video. Your HTML will be screenshot with omitBackground:true; transparent regions of the PNG become "video shows through" areas in the final composite.`);
    userLines.push(`HARD REQUIREMENTS:`);
    userLines.push(`  1. body MUST set background:transparent.`);
    userLines.push(`  2. Emit a transparent media slot at x:${mediaRect.x}, y:${mediaRect.y}, w:${mediaRect.w}, h:${mediaRect.h} (e.g. <div data-media-slot="true" style="position:absolute;left:${mediaRect.x}px;top:${mediaRect.y}px;width:${mediaRect.w}px;height:${mediaRect.h}px;background:transparent"></div>).`);
    userLines.push(`  3. DO NOT emit any <img> tag pointing at the source video's frames anywhere on the canvas.`);
    userLines.push(`  4. clip-path SAFETY — if a panel uses clip-path, that container MUST NOT contain text children (clip-path slices text descendants); put text in sibling positioned divs.`);
    userLines.push(`  5. NO backdrop-filter — Puppeteer omitBackground:true leaves nothing to blur; use \`background: rgba(<color>, 0.80-0.88)\` for translucent panels.`);
    userLines.push(`  6. CSS ANIMATIONS ARE ALLOWED and strongly encouraged for video overlays. Use @keyframes for text entrances, exits, and cycling proof elements. All animation timing MUST complete within 5 seconds (the video base duration). Guidelines:`);
    userLines.push(`     - Stagger element entrances: headline first (~0.3s in), proof elements follow (~1.0s in), CTA last (~2.5s in).`);
    userLines.push(`     - animation-fill-mode: forwards for one-shot elements (appear and stay).`);
    userLines.push(`     - For cycling reviews / testimonials: multi-step @keyframes per item (opacity 0→0→1→1→0→0) with animation-delay offset per item — each review fades in, holds ~1.5s, fades out as the next fades in.`);
    userLines.push(`     - animation-iteration-count: 1 for one-shots; infinite only for subtle ambient loops with very low amplitude.`);
    userLines.push(`     - Animate only individual chrome elements — not body or structural wrappers.`);
    userLines.push(`     - Timing budget: 0.3-0.5s fade-in, 1.5-2.0s hold, 0.3-0.5s fade-out per element. Total window: 5s.`);

    const v2Quotes = (richContext?.text?.copy_candidates?.quotes || []).filter(q => q?.text);
    if (v2Quotes.length > 1) {
      userLines.push(`  7. CYCLING REVIEWS — ${v2Quotes.length} review quotes are available in the supporting context. For social proof concepts, animate them cycling with staggered @keyframes rather than a single static quote. Suggested timing: each review visible ~${Math.floor(4500 / v2Quotes.length)}ms with 300ms cross-fade transitions.`);
    }
    userLines.push(``);
  }

  if (richContext?.text) {
    userLines.push(`SUPPORTING CONTEXT (brand voice + product depth + proof signals — use for palette derivation, tone, and the hierarchy_spec mirror — DO NOT use copy_candidates here; render the COPY block above verbatim):`);
    userLines.push('```json');
    userLines.push(JSON.stringify({
      brand:           ctx?.brand   || null,
      product_depth:   ctx?.product || null,
      social_proof:    ctx?.social_proof_signal || ctx?.social_context || null,
      campaign:        ctx?.campaign || null
    }, null, 2));
    userLines.push('```');
    userLines.push('');
  }

  if (images.length) {
    userLines.push(`VISION INPUTS (attached as image parts in this message, in order):`);
    images.forEach((img, i) => userLines.push(`  image[${i}] — ${img.role}: ${img.label || ''}`));
    userLines.push('');
  }

  // Echo the allowed URL list ONCE more in the user message for the
  // validator to enforce — same defense as V1's URL allowlist block.
  if (allowedUrls.length) {
    userLines.push(`ALLOWED URLS (echo — these are the ONLY strings you may put in any <img src>):`);
    allowedUrls.forEach(u => userLines.push(`  ${u}`));
    userLines.push('');
  }

  userLines.push(`Emit the complete HTML document now. Materialize the declared archetype + output_shape + media + copy.`);
  const user = userLines.join('\n');
  return { system, user, images };
}

function buildPrompt({ canvas, concept, input, richContext, dims, videoMode = false, mediaRect = null, platformFormat = 'meta_feed_1_1', sourceText = [], sourceSubjects = [], sourcePrimarySubjectDesc = null, operatorPrompt = null }) {
  const ctx    = richContext?.text || null;
  const images = richContext?.images || [];
  const creativeStyle = canvas.creativeStyle;
  const aspectRatio   = canvas.aspectRatio;
  const formatConstraints = buildFormatConstraintsBlock(platformFormat, dims);
  const avoidTextBlock    = buildAvoidExistingTextBlock(sourceText, dims);
  const avoidSubjectBlock = buildAvoidSubjectBlock(sourceSubjects, sourcePrimarySubjectDesc, dims);

  const system = [
    `You are a senior creative director + frontend developer producing a single complete HTML+CSS social-media ad creative.`,
    ``,
    `Your output: ONE self-contained HTML document the renderer feeds to a headless browser via page.setContent(). It will be screenshotted at exactly ${dims.width}×${dims.height}px — every visible element must fit inside that viewport.`,
    ``,
    formatConstraints,
    ``,
    ...(avoidSubjectBlock ? [avoidSubjectBlock, ``] : []),
    ...(avoidTextBlock    ? [avoidTextBlock,    ``] : []),
    `HARD RULES:`,
    `- Output a complete <html>...</html> document. <head> with <meta charset>, <title>, single inline <style>. <body> with the ad's visible content.`,
    `- <body> MUST be sized exactly ${dims.width}px × ${dims.height}px via inline style="width:${dims.width}px;height:${dims.height}px;margin:0;overflow:hidden". No scrollbars, no overflow.`,
    `- BOTTOM SAFETY BAND — reserve at least 32px between the bottom edge of any TEXT or INTERACTIVE element (h1, h2, subheadline, .cta, .btn, button, price, footer text, brand mark) and the ${dims.height}px canvas bottom. Same rule for top edge (≥ 24px), left/right (≥ 24px). Fonts render at slightly larger metrics in Chromium than the LLM's mental model — bottom < 32px reliably clips descenders and button borders in the final PNG. Decorative shapes (background circles, gradient orbs, image bleeds) MAY sit against or beyond the edge; content must not.`,
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
    `  copy_picks       — { headline, subheadline, eyebrow, cta } — the EXACT strings you rendered into the HTML for each role (verbatim text content, not slot names). Use null for any role you intentionally omitted. Downstream image-polish reads from here to keep its text matched to your composition; pulling from copy_candidates without echoing the pick here leaves the polish out of sync.`,
    `  elements_used    — array of role names you rendered (e.g. "hero_media","headline","cta","quote_card")`,
    `  elements_skipped — array of "<role> — <reason>" entries for things you intentionally omitted`,
    `  hierarchy_spec   — { strategy:{archetype,layout_family,emotional_hook,social_proof_type,product_priority,ugc_priority,comment_priority,stat_priority,cta_emphasis}, layout:{layout_family,visual_direction:{},zones:[{role,priority,anchor,weight,component_style}]} }`,
    ``,
    `The hierarchy_spec mirror lets the Pre-Judge filter check proof-strategy compliance without parsing your HTML — it MUST honestly describe what you rendered.`
  ].join('\n');

  const userLines = [];

  // Regeneration entry point — operator's refinement leads so GPT sees
  // the requested change before the Director concept block.
  if (operatorPrompt && String(operatorPrompt).trim()) {
    userLines.push(`OPERATOR REFINEMENT (HIGHEST PRIORITY — overrides any conflicting stylistic default below):`);
    userLines.push(`  ${String(operatorPrompt).trim()}`);
    userLines.push(`Apply that refinement to your output. Concept, copy, media URLs, and the hard rules still bind — but where the operator's instruction conflicts with a stylistic default, the operator wins.`);
    userLines.push(``);
  }

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
    userLines.push(`VIDEO-OVERLAY MODE — source media is a video. Your HTML will be screenshot with omitBackground:true; transparent regions of the PNG become "video shows through" areas in the final composite. The pipeline composites the source video at canvas aspect with content-aware cropping (Cloudinary c_fill,g_auto), so the video fills the canvas — chrome placement determines what's visible, not the slot rect alone.`);
    userLines.push(`HARD REQUIREMENTS:`);
    userLines.push(`  1. body MUST set background:transparent (NOT a hex color, NOT white). Inline style="background:transparent" on the body tag is required.`);
    userLines.push(`  2. Emit the media zone as a transparent rectangle at x:${mediaRect.x}, y:${mediaRect.y}, w:${mediaRect.w}, h:${mediaRect.h} (e.g. <div data-media-slot="true" style="position:absolute;left:${mediaRect.x}px;top:${mediaRect.y}px;width:${mediaRect.w}px;height:${mediaRect.h}px;background:transparent"></div>). This communicates your design's "primary video focus area" — but the composite also bleeds video through anywhere your overlay isn't opaque, so chrome placement matters more than the slot rect's exact dimensions. The slot can be full bleed, inset, side strip, diagonal carve via clip-path — match what the canvas spec emits.`);
    userLines.push(`  3. CRITICAL — DO NOT emit any <img> tag whose src is product.hero_media.image, any product.hero_media.crops.<ratio> URL, or otherwise points at the source video's frames. Anywhere on the canvas. The video plays UNDERNEATH the overlay during playback; embedding the source frame as <img> freezes that frame and obscures the live playback. Other product imagery (product.product_image, product.lifestyle_image, brand.logo) IS allowed as <img>.`);
    userLines.push(`  4. CRITICAL — clip-path SAFETY: when you put clip-path on a panel/container (diagonal carve, custom shape, etc.), that container MUST NOT contain text children. The clip-path silently slices text descendants — right-aligned headlines inside a clipped parent get their leading characters cut off at the diagonal edge. Pattern that BREAKS: <div style="clip-path:polygon(...)"><div>Headline</div></div>. Pattern that WORKS: emit the clip-pathed shape as a STANDALONE positioned div (no text inside), then put the headline / eyebrow / cta in SEPARATE absolutely-positioned sibling divs sized to fit inside the panel's visible (post-clip) region.`);
    userLines.push(`  5. NO backdrop-filter — DO NOT use \`backdrop-filter: blur(...)\` or any other backdrop-filter value on ANY element. Puppeteer's omitBackground:true leaves NO backdrop to blur during the screenshot — backdrop-filter silently degrades to a no-op and your "frosted glass over video" effect becomes a flat semi-opaque rectangle. Use \`background: rgba(<color>, 0.80-0.88)\` for translucent panels, subtle \`box-shadow\` for depth, \`background: linear-gradient(...)\` at 0.80-0.88 opacity for multi-tone glass. If recommended_components specifies "glass_panel", interpret as "translucent rgba panel" — never backdrop-filter.`);
    userLines.push(`  6. CSS ANIMATIONS ARE ALLOWED and strongly encouraged for video overlays. Use @keyframes for text entrances, exits, and cycling proof elements. All animation timing MUST complete within 5 seconds (the video base duration). Guidelines:`);
    userLines.push(`     - Stagger element entrances with animation-delay: headline first (~0.3s in), proof elements follow (~1.0s in), CTA last (~2.5s in).`);
    userLines.push(`     - animation-fill-mode: forwards for one-shot elements (appear and stay).`);
    userLines.push(`     - For cycling reviews / testimonials: use a multi-step @keyframes per item (opacity 0→0→1→1→0→0) with animation-delay offset per item, so each review fades in, holds ~1.5s, then fades out as the next one fades in.`);
    userLines.push(`     - animation-iteration-count: 1 for one-shot entrances; infinite ONLY for subtle ambient loops (slow breathing scale, gentle pulse) with very low amplitude.`);
    userLines.push(`     - DO NOT animate structural layout elements (body, outer wrapper). Animate only individual chrome elements (headline div, quote card, cta button, etc.).`);
    userLines.push(`     - Timing budget: 0.3-0.5s fade-in, 1.5-2.0s hold, 0.3-0.5s fade-out per element. Total window: 5s.`);

    // Pull available reviews from richContext for cycling guidance
    const quotes = (ctx?.copy_candidates?.quotes || []).filter(q => q?.text);
    if (quotes.length > 1) {
      userLines.push(`  7. CYCLING REVIEWS — you have ${quotes.length} review quotes available in copy_candidates.quotes. For social proof concepts, animate them cycling through with staggered entrance/exit @keyframes rather than showing one static quote. Suggested timing for ${quotes.length} reviews across 5s: each review visible ~${Math.floor(4500 / quotes.length)}ms with 300ms cross-fade transitions.`);
    }
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
      required: ['html', 'css_extracted', 'rationale', 'creative_style', 'color_palette', 'copy_picks', 'elements_used', 'elements_skipped', 'hierarchy_spec'],
      properties: {
        html:           { type: 'string' },
        css_extracted:  { type: 'string' },
        rationale:      { type: 'string' },
        creative_style: { type: 'string', enum: ['brand_led', 'ugc_led', 'social_proof_led', 'editorial', 'promotional'] },
        color_palette:  {
          type: 'array',
          items: { type: 'string' }
        },
        // Phase 6.5 (JSON Gen retirement) — the LLM declares which
        // copy strings it actually rendered. Persisted on the canvas
        // artifact's copyPicks; downstream consumers (Image Ref) read
        // from there instead of zone-mining the canvasSpec.
        copy_picks: {
          type: 'object',
          additionalProperties: false,
          required: ['headline', 'subheadline', 'eyebrow', 'cta'],
          properties: {
            headline:    { type: ['string', 'null'] },
            subheadline: { type: ['string', 'null'] },
            eyebrow:     { type: ['string', 'null'] },
            cta:         { type: ['string', 'null'] }
          }
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
