// AI template metadata. Each entry describes an AI-driven template
// — the LLM emits the canvas spec at render time, the renderer
// (drawTpCanvas) draws it just like a hand-authored one.
//
// Phase 1c scope: ai_brand_led, 1:1 only, both variants. Adding more
// styles or ratios is a one-line edit each — the prompt, validator,
// and dispatch logic don't change shape.
//
// The shim shape mirrors hand-authored normalized templates closely
// enough that campaignAdsGenerationService's cartesian iteration
// (registry.getNormalized + tpl.aspect_ratios?.supported) just works.

const AI_TEMPLATES = {
  ai_brand_led: {
    label:       'AI: Brand-led',
    description: 'AI-generated layout. Brand colors + logo + hero media dominate; small product card + CTA.',
    creativeStyle: 'brand_led',
    aspect_ratios: {
      supported: ['1:1'],          // Phase 1c: 1:1 only.
      preferred: ['1:1']
    },
    variants: ['ugc', 'product_image'],
    derivationTemplate: 'ugc_split_screen'   // base template used to derive copy + assemble the input; the AI spec rides on top
  }
};

function listAiTemplates() {
  return Object.entries(AI_TEMPLATES).map(([id, m]) => ({
    template_id: id,
    name:        m.label,
    emphasis:    m.description,
    aspect_ratios: m.aspect_ratios,
    family:      'ai',
    kind:        'ai',
    creativeStyle: m.creativeStyle
  }));
}

function getAiTemplate(id) {
  return AI_TEMPLATES[id] || null;
}

function isAi(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(AI_TEMPLATES, id);
}

// Shim that emulates the shape registry.getNormalized returns for
// hand-authored templates. The cartesian only reads aspect_ratios from
// it today; we add a kind:'ai' marker so other callers can branch
// without prefix-matching the id string.
function getNormalizedShim(id) {
  const t = AI_TEMPLATES[id];
  if (!t) return null;
  return {
    template_id:   id,
    version:       '1.0.0',
    status:        'active',
    kind:          'ai',
    family:        'ai',
    creativeStyle: t.creativeStyle,
    aspect_ratios: t.aspect_ratios,
    derivationTemplate: t.derivationTemplate,
    // Hand-authored templates carry a zones map here used by
    // validateInputAgainstTemplate. AI templates don't need it — the
    // LLM spec carries its own zones, validated by the spec service.
    zones: {}
  };
}

module.exports = {
  isAi,
  listAiTemplates,
  getAiTemplate,
  getNormalizedShim,
  AI_TEMPLATES
};
