const express = require('express');
const router = express.Router();

const { buildLayoutInput, getCandidatesForMedia } = require('../services/layoutInputService');
const registry = require('../services/templateRegistry');

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

    const input = await buildLayoutInput({
      mediaId, template, aspectRatio, options: options || {}, refresh: !!refresh
    });
    const validation = registry.validateInputAgainstTemplate(input, template);

    const response = { input, validation };
    if (req.query.include === 'canvas') {
      response.canvas = registry.getCanvas(template, aspectRatio);
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
    res.status(status).json({ error: err.message || 'Layout input generation failed' });
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
    const candidates = await getCandidatesForMedia(req.params.mediaId, aspectRatio);
    res.json({
      media_id: req.params.mediaId,
      aspect_ratio: aspectRatio,
      candidates
    });
  } catch (err) {
    const status = err.status || 500;
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

module.exports = router;
