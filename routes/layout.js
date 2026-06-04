const express = require('express');
const router = express.Router();

const { buildLayoutInput, getCandidatesForMedia } = require('../services/layoutInputService');
const registry = require('../services/templateRegistry');
const { assertMediaInTenant, tenantFilter } = require('../middleware/tenantHelpers');
const LayoutInputArtifact = require('../models/LayoutInputArtifact');

// POST /api/layout-input
// Body: { mediaId, template, aspect_ratio, options?, refresh? }
// Query: ?include=canvas to bundle the canvas spec in the response.
//
// Response shape:
//   {
//     input:      <RS Social Proof Creative Input JSON>,
//     validation: <validator result for (input, template)>,
//     canvas?:    <canvas spec when include=canvas>
//   }
//
// On validation failure, returns 422 with the structured validation detail
// so the caller can pick a different template. Pass options.allow_invalid=
// true to force a 200 even when validation fails (debug / preview use).
router.post('/', express.json(), async (req, res) => {
  try {
    const { mediaId, template, aspect_ratio: aspectRatio, options, refresh } = req.body || {};
    if (!mediaId || !template || !aspectRatio) {
      return res.status(400).json({ error: 'mediaId, template, aspect_ratio required' });
    }

    // Tenant assertion — 404s rather than 403s on cross-tenant access
    // so the existence of the row isn't leaked.
    await assertMediaInTenant(mediaId, req);

    const input = await buildLayoutInput({
      mediaId, template, aspectRatio, options: options || {}, refresh: !!refresh
    });

    // AI templates skip the hand-authored validation block (the AI
    // spec is validated by aiCanvasSpecService.validateSpec instead),
    // and the canvas comes from the LLM, not the static schema.
    const isAi = registry.isAi(template);
    const validation = isAi ? { ok: true, template_id: template, ai: true } : registry.validateInputAgainstTemplate(input, template);

    const response = { input, validation };
    if (req.query.include === 'canvas') {
      if (isAi) {
        const Media = require('../models/Media');
        const m = await Media.findById(mediaId).select('advertiserId brandId').lean();
        const aiSvc = require('../services/aiCanvasSpecService');
        const aiNorm = registry.getNormalized(template);
        const result = await aiSvc.getOrGenerate({
          input,
          template,
          aspectRatio,
          creativeStyle: aiNorm?.creativeStyle || 'brand_led',
          mediaId,
          productId:           (options && options.productId)   || null,
          variantKind:         (options && options.variantKind) || null,
          paletteSource:       (options && options.paletteSource) || 'media',
          advertiserId:        m?.advertiserId || null,
          brandId:             m?.brandId      || null,
          refresh:             !!refresh
        });
        // Use resolvedInput (input with copy_picks applied) so the
        // renderer reads input.copy.headline / .subheadline / .eyebrow
        // and gets the LLM-picked candidate text.
        response.input = result.resolvedInput || input;
        response.canvas = result.spec;
        response.style_bindings = resolveAiBindings(result.spec.style_bindings || {}, response.input);
        response.ai_artifact_id = result.artifactId;
        response.ai_warnings    = result.warnings || [];
      } else {
        response.canvas = registry.getCanvas(template, aspectRatio);
        response.style_bindings = registry.resolveStyleBindings(input, template);
      }
    }

    if (!validation.ok && !(options && options.allow_invalid)) {
      return res.status(422).json({
        error: 'Input does not satisfy template validation',
        ...response
      });
    }

    res.json(response);
  } catch (err) {
    const status = err.status || 500;
    // Print the full stack to Render logs so we can diagnose 500s without
    // the request needing a repro.
    console.error(`❌ POST /api/layout-input failed (${status}): ${err.message}\n${err.stack || ''}`);
    res.status(status).json({ error: err.message || 'Layout input generation failed' });
  }
});

// GET /api/layout-input/by-id/:id
//
// Direct fetch by stored artifact _id. The render path uses this
// instead of POST /api/layout-input so the Puppeteer page never has
// to reconstruct the cache key from URL params (campaignContextHash
// would silently drift, miss the cache, force a full re-derive, and
// time out the Netlify gateway at 30s — exactly what we just hit).
//
// Returns the same shape POST does: { input, canvas, style_bindings }.
// The artifact was already validated when it was written; no need to
// re-run validation here. Tenant filter scopes by brandId from the
// token.
router.get('/by-id/:id', async (req, res) => {
  try {
    const artifact = await LayoutInputArtifact.findOne(tenantFilter(req, { _id: req.params.id })).lean();
    if (!artifact) return res.status(404).json({ error: 'layout input artifact not found' });

    let input, canvas, style_bindings, ai_artifact_id, ai_warnings;
    if (registry.isAi(artifact.template)) {
      const aiSvc = require('../services/aiCanvasSpecService');
      const aiNorm = registry.getNormalized(artifact.template);

      // Phase 2 V2 dispatch — when ?v2=1 is on the URL (renderService
      // appended it from Campaign.aiCreativeV2Enabled), look up the
      // Director's concept for (brandId, productId, campaignKind,
      // creativeIntent) and feed it to the Generator.
      let directionArtifactId = null;
      let directionConcept    = null;
      if (req.query.v2 === '1' && artifact.brandId) {
        try {
          const CreativeDirectionArtifact = require('../models/CreativeDirectionArtifact');
          const { pickConceptForCell } = require('../services/aiCreativeV2Helpers');
          const directionFilter = {
            brandId:        artifact.brandId,
            productId:      artifact.productId || req.query.productId || null,
            campaignKind:   req.query.campaignKind   || null,
            creativeIntent: req.query.creativeIntent || null
          };
          const direction = await CreativeDirectionArtifact.findOne(directionFilter).lean();
          if (direction?.concepts?.length) {
            directionArtifactId = String(direction._id);
            // Cell key combines media + paletteSource so cells of the
            // same product spread across the Director's concepts.
            const cellKey = `${artifact.mediaId}|${artifact.paletteSource || ''}|${artifact.variantKind || ''}`;
            directionConcept = pickConceptForCell({ concepts: direction.concepts, cellKey });
          } else {
            console.warn(`   ⚠️  v2 requested but no Director concepts found for brand=${artifact.brandId} product=${directionFilter.productId || '-'} kind=${directionFilter.campaignKind || '-'} — falling back to V1`);
          }
        } catch (err) {
          console.warn(`   ⚠️  v2 director lookup failed: ${err.message} — falling back to V1`);
        }
      }

      // Phase 3 — multi-candidate + Judge for V2 production renders.
      // Preview path (?preview=1) skips the multi-gen for cheap operator
      // iteration. V1 path stays N=1 regardless.
      const previewMode  = req.query.preview === '1';
      const v2Mode       = !!directionConcept;
      const nCandidates  = v2Mode && !previewMode
        ? Math.max(1, Math.min(5, parseInt(req.query.n || '3', 10) || 3))
        : 1;

      const result = await aiSvc.getOrGenerate({
        input:           artifact.input,
        template:        artifact.template,
        aspectRatio:     artifact.aspectRatio,
        creativeStyle:   aiNorm?.creativeStyle || 'brand_led',
        mediaId:         artifact.mediaId,
        productId:       artifact.productId,
        variantKind:     artifact.variantKind,
        campaignContextHash: artifact.campaignContextHash,
        paletteSource:   artifact.paletteSource,
        advertiserId:    artifact.advertiserId,
        brandId:         artifact.brandId,
        refresh:         false,
        // V2 inputs — null on V1 path; getOrGenerate branches internally.
        directionArtifactId,
        directionConcept,
        // Phase 3 multi-candidate inputs.
        nCandidates,
        previewMode
      });
      input          = result.resolvedInput || artifact.input;
      canvas         = result.spec;
      style_bindings = resolveAiBindings(result.spec.style_bindings || {}, input);
      ai_artifact_id = result.artifactId;
      ai_warnings    = result.warnings || [];
    } else {
      input          = artifact.input;
      canvas         = registry.getCanvas(artifact.template, artifact.aspectRatio);
      style_bindings = registry.resolveStyleBindings(artifact.input, artifact.template);
    }

    const response = { input, canvas, style_bindings };
    if (ai_artifact_id) { response.ai_artifact_id = ai_artifact_id; response.ai_warnings = ai_warnings; }

    // Phase 5b.2 — when ?useResolved=1 is on the URL (renderer opt-in),
    // attach the ResolvedLayoutArtifact for this canvas spec. Renderer
    // uses it for: skip removed zones, use post-fallback component_style,
    // apply Resolver's computed pixel-accurate font sizes inline. Falls
    // back to standard rendering when the resolver hasn't fired yet.
    if (req.query.useResolved === '1' && ai_artifact_id) {
      try {
        const ResolvedLayoutArtifact = require('../models/ResolvedLayoutArtifact');
        const resolved = await ResolvedLayoutArtifact
          .findOne({ aiCanvasArtifactId: ai_artifact_id })
          .sort({ createdAt: -1 })
          .lean();
        if (resolved) {
          response.resolved_layout = {
            resolution_status: resolved.resolutionStatus,
            resolved_zones:    resolved.resolvedZones || [],
            resolved_data:     resolved.resolvedData  || { slots: {} },
            warnings:          resolved.warnings      || [],
            fallbacks_used:    resolved.fallbacksUsed || []
          };
        }
      } catch (err) {
        console.warn(`   ⚠️  resolved_layout lookup failed: ${err.message}`);
      }
    }
    res.json(response);
  } catch (err) {
    console.error(`❌ GET /api/layout-input/by-id/${req.params.id} failed: ${err.message}`);
    res.status(500).json({ error: err.message || 'layout input fetch failed' });
  }
});

// GET /api/layout-input/templates
// List every template the renderer supports (id, name, emphasis, supported
// aspect ratios). Used by any UI that picks a template.
router.get('/templates', (req, res) => {
  res.json({ templates: registry.listTemplates() });
});

// GET /api/layout-input/canvas?template=...&aspect_ratio=...
// Pure static pass-through of the canvas spec. Safe to cache indefinitely
// by the renderer — canvas only changes when the schema version bumps.
router.get('/canvas', (req, res) => {
  const template    = req.query.template;
  const aspectRatio = req.query.aspect_ratio;
  if (!template || !aspectRatio) {
    return res.status(400).json({ error: 'template and aspect_ratio required' });
  }
  const canvas = registry.getCanvas(template, aspectRatio);
  if (!canvas) {
    return res.status(404).json({
      error: 'No canvas found',
      template,
      aspect_ratio: aspectRatio,
      supported: registry.getSupportedAspectRatios(template)
    });
  }
  res.json(canvas);
});

// GET /api/layout-input/candidates/:mediaId?aspect_ratio=...
// Preflight: runs the assembler with a cheap stub derivation (no LLM) and
// validates against every template. Returns which ones this Media's data
// supports so a UI can grey-out the rest.
router.get('/candidates/:mediaId', async (req, res) => {
  try {
    const aspectRatio = req.query.aspect_ratio || '1:1';
    await assertMediaInTenant(req.params.mediaId, req);
    const candidates = await getCandidatesForMedia(req.params.mediaId, aspectRatio);
    res.json({
      media_id: req.params.mediaId,
      aspect_ratio: aspectRatio,
      candidates
    });
  } catch (err) {
    const status = err.status || 500;
    console.error(`❌ GET /api/layout-input/candidates/${req.params.mediaId} failed (${status}): ${err.message}\n${err.stack || ''}`);
    res.status(status).json({ error: err.message || 'Candidate preflight failed' });
  }
});

// GET /api/layout-input/meta
// Diagnostic — supported templates + aspect ratios + global canvas rules.
router.get('/meta', (req, res) => {
  res.json({
    templates:        registry.listTemplates(),
    global_canvas_rules: registry.getGlobalCanvasRules()
  });
});

// Resolve the AI spec's flat style_bindings shape
// ({ name: 'brand.primary_color' | '#FFCC55' }) against the canonical
// input — hex literals pass through, dotted paths read from input.
// Mirrors the helper in routes/aiCanvasSpec.js; duplicated to keep
// the dependency direction shallow.
function resolveAiBindings(bindings, input) {
  const out = {};
  for (const [name, raw] of Object.entries(bindings || {})) {
    if (typeof raw !== 'string') continue;
    if (raw.startsWith('#')) { out[name] = raw; continue; }
    const v = raw.split('.').reduce((acc, k) => (acc == null ? null : acc[k]), input);
    if (v != null && v !== '') out[name] = v;
  }
  return out;
}

module.exports = router;
