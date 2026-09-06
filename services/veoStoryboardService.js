// GPT-composed variance knobs for the fixed 8-second lifestyle video
// template. Emits camera + audio + vibe strings that veoPromptBuilder
// splices into the fixed beat template. Only these three per-ad
// variance fields flow to Grok; beat structure itself is fixed.
//
// Text overlays are NOT choreographed here. The canonical brand-script
// overlay (brandScriptExecutor + brandScripts/*.script.js) handles all
// on-screen text using ad.copy + LayoutInputArtifact + Brand.styleTheme.
//
// Off by default — flip VEO_USE_GPT_STORYBOARD=true to enable. When off
// or the GPT call fails, veoPromptBuilder falls back to safe defaults
// for camera / audio / vibe so the render path stays unblocked.

const { trackLlmCall } = require('./costTracker');
const { archetypeDescription } = require('./veoPromptBuilder');
const { conceptField } = require('./conceptProjection');

const { chatCompletion } = require('./atlasLlmService');

const MODEL_ID    = process.env.VEO_STORYBOARD_MODEL_ID || 'gpt-4.1';
const TEMPERATURE = 0.85;
const MAX_TOKENS  = 200;

function enabled() {
  return String(process.env.VEO_USE_GPT_STORYBOARD || '').toLowerCase() === 'true';
}

const RESPONSE_SCHEMA = {
  name:   'veo_storyboard',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['camera', 'audio', 'vibe'],
    properties: {
      camera: {
        type:        'string',
        description: 'One camera move for the entire 8-second shot — e.g. "slow dolly-in", "lateral truck right to left", "static lock-off with subtle handheld drift", "slow orbit clockwise". Keep it singular and disciplined.'
      },
      audio: {
        type:        'string',
        description: 'One line of audio direction — natural ambience + optional subtle sonic cue. No voices, no dialogue, no narration, no music with vocals.'
      },
      vibe: {
        type:        'string',
        description: '2–4 words capturing the energy — e.g. "editorial, warm, quiet".'
      }
    }
  }
};

function buildSystemPrompt() {
  return [
    'You are directing the per-ad variance knobs for an 8-second AI-generated lifestyle product video. The beat structure is FIXED downstream (a lifestyle arc that stills into a hold at 0:06 for an endcard overlay); you pick the camera move, the audio ambience, and a short vibe descriptor.',
    '',
    'HARD RULES:',
    '- Single continuous shot. No cuts. Total runtime 8 seconds.',
    '- Motion stays subtle — this is premium lifestyle, not a montage.',
    '- Audio: ambience + at most one subtle sonic cue. NEVER voices, dialogue, or narration.',
    '- Camera is ONE move for the full shot.',
    '',
    'OUTPUT a JSON object matching the provided schema.'
  ].join('\n');
}

function buildUserPrompt({ concept, brand, product, scene, lighting, mood, subject, aspectRatio, operatorPrompt }) {
  const lines = [];
  // Catalog title is NEVER interpolated into a generative prompt.
  // Same incident as veoPromptBuilder (2026-08-26): Omni painted a fake
  // VAPORTEK lockup from a labelled `Product: {title}` line over a
  // PELAGIC product. This GPT-storyboard user prompt is only reached
  // when VIDEO_PROVIDER is vertex (atlas/gemini prepareStoryboard
  // returns {storyboard:null}), but it is the same $0.90 hallucination
  // door. Identity comes from product description + brand + scene,
  // not a labelled title field.
  if (product?.description) lines.push(`Product description: ${product.description}`);

  if (brand?.name)          lines.push(`Brand: ${brand.name}`);
  if (brand?.tone?.length)  lines.push(`Brand voice (operator-curated): ${brand.tone.slice(0, 5).join(', ')}`);
  if (brand?.tagline)       lines.push(`Brand essence: "${brand.tagline}"`);

  if (brand?.derivedVoice?.voice_summary) {
    lines.push(`Derived brand voice (from live campaigns): ${brand.derivedVoice.voice_summary}`);
  }

  // Dual-read nested v3 routing + flat v2 so storyboard variance still
  // sees archetype / hook when the Director nests them under routing.
  const archetype = conceptField(concept, 'archetype');
  const emotionalHook = conceptField(concept, 'emotional_hook');
  const socialProofType = conceptField(concept, 'social_proof_type');
  if (archetype) {
    lines.push(`Concept archetype: ${archetype} — ${archetypeDescription(archetype)}`);
  }
  if (emotionalHook) lines.push(`Emotional hook: ${emotionalHook}`);
  if (socialProofType && socialProofType !== 'none' && socialProofType !== 'absent') {
    lines.push(`Social proof angle: ${socialProofType}`);
  }

  if (scene)    lines.push(`Scene: ${scene}`);
  if (lighting) lines.push(`Lighting: ${lighting}`);
  if (mood)     lines.push(`Mood: ${mood}`);

  if (subject?.label) {
    const posText = subject.hPos ? ` framed on the ${subject.hPos} side` : '';
    lines.push(`Primary subject: ${subject.label}${posText}`);
  }

  lines.push(`Aspect ratio: ${aspectRatio}`);

  if (operatorPrompt && String(operatorPrompt).trim()) {
    lines.push('');
    lines.push(`OPERATOR REFINEMENT (must be honored): ${String(operatorPrompt).trim()}`);
  }

  lines.push('');
  lines.push('Write the motion script for this ad.');
  return lines.join('\n');
}

// Resolves the structured context veoPromptBuilder pulls from
// (LayoutInputArtifact + detect-pipeline sourceMedia) into the flat
// fields the storyboard prompt expects.
function resolveContext({ concept, brand, product, layoutInput, sourceMedia, subject, aspectRatio, operatorPrompt }) {
  const scene =
    layoutInput?.media?.background_description
    || [sourceMedia?.background?.setting, sourceMedia?.background?.scene_type, sourceMedia?.background?.style]
        .filter(Boolean)
        .filter((v, i, arr) => arr.indexOf(v) === i)
        .join(', ')
    || null;

  const lighting = layoutInput?.media?.background_lighting
    || sourceMedia?.background?.lighting
    || null;

  const moods = Array.isArray(sourceMedia?.background?.mood) ? sourceMedia.background.mood.filter(Boolean) : [];
  const mood  = moods.length ? moods.slice(0, 3).join(', ') : (layoutInput?.media?.background_style || null);

  return { concept, brand, product, scene, lighting, mood, subject, aspectRatio, operatorPrompt };
}

// Main export. Returns structured storyboard or null on failure / when
// the flag is off. Callers must handle null and fall back to the
// hardcoded storyboard in veoPromptBuilder.
async function generateStoryboard({
  concept        = null,
  brand          = null,
  product        = null,
  layoutInput    = null,
  sourceMedia    = null,
  subject        = null,
  aspectRatio    = '1:1',
  operatorPrompt = null,
  brandId        = null,
  productId      = null
} = {}) {
  if (!enabled()) return null;
  if (!process.env.OPENAI_API_KEY) {
    console.warn('🎬 veoStoryboard: OPENAI_API_KEY missing — falling back to hardcoded storyboard');
    return null;
  }

  const ctx = resolveContext({ concept, brand, product, layoutInput, sourceMedia, subject, aspectRatio, operatorPrompt });
  const system = buildSystemPrompt();
  const user   = buildUserPrompt(ctx);

  const t0 = Date.now();
  try {
    const completion = await chatCompletion(
      {
        stage:      'veo_storyboard',
        provider:   'openai',
        model:      MODEL_ID,
        purposeTag: 'motion',
        brandId, productId,
        visionImages: 0,
        cacheKey:   null   // per-ad, not cached — variance is the goal
      },
      {
        model:           MODEL_ID,
        response_format: { type: 'json_schema', json_schema: RESPONSE_SCHEMA },
        messages: [
          { role: 'system', content: system },
          { role: 'user',   content: user }
        ],
        temperature: TEMPERATURE,
        max_tokens:  MAX_TOKENS
      }
    );

    const raw = completion.choices?.[0]?.message?.content;
    if (!raw) throw new Error('storyboard returned no content');

    const parsed = JSON.parse(raw);
    const elapsedMs = Date.now() - t0;
    console.log(
      `🎬 veoStoryboard: camera="${parsed.camera}" vibe="${parsed.vibe}" ` +
      `audio="${(parsed.audio || '').slice(0, 40)}${(parsed.audio || '').length > 40 ? '…' : ''}" took=${elapsedMs}ms`
    );
    return parsed;
  } catch (err) {
    const elapsedMs = Date.now() - t0;
    console.warn(`⚠️  veoStoryboard: failed after ${elapsedMs}ms (${err.message}) — falling back to hardcoded storyboard`);
    return null;
  }
}

module.exports = { generateStoryboard, enabled };
