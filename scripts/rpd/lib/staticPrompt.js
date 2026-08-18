// scripts/rpd/lib/staticPrompt.js — prompt construction for STATIC RPD cells.
//
// Sibling of promptVariants.js (video). Builds the EXACT prompt a production
// static generation would carry, then applies the variant's lever. Levers map
// onto the production static prompt system:
//
//   baseline → staticAdIntents.buildPrompt(fixture)   (canonical intent prompt)
//   raw      → the variant string IS the prompt        (= Ad.imagePromptRaw,
//                                                       full replace, ≤40000)
//   blocks   → replace a whole canonical BLOCK (PRODUCT_FIDELITY, …) with new
//              text — what a code change to that constant would produce
//   patch    → literal find/replace surgery on the finished prompt
//
// WHY `blocks` AND NOT VIDEO'S `directives`: the video directive sets are
// OBJECTS, so patching a property mutates the same binding buildVeoPrompt
// reads. The static blocks are module-scope `const` STRINGS read lexically
// (`staticAdIntents.js:1333`) — strings are immutable and the binding is
// captured at module load, so assigning to `module.exports.PRODUCT_FIDELITY`
// changes NOTHING the builder sees. That failure mode is silent: the cell would
// report `lever: blocks` and quietly render the baseline. Instead we exploit
// the fact that these blocks appear VERBATIM in the built prompt (asserted
// below) and substitute the exact string — no module mutation, nothing to
// restore, and a loud error if the block is not actually present (e.g. a flag
// routed the prompt to the LEGACY paragraph instead).
//
// Pure and offline: no network, no DB, no spend.

const intents = require('../../../services/staticAdIntents');
const { applyStringPatches, diffVsBaseline } = require('./promptVariants');

// Blocks a variant may replace wholesale. Value is read at call time so the
// live constant (and any flag that selects between arms) is always the source.
const PATCHABLE_BLOCKS = {
  PRODUCT_FIDELITY: () => intents.PRODUCT_FIDELITY,
  SCENE_PRESERVE: () => intents.SCENE_PRESERVE,
  SCENE_PRESERVE_EDGE_EXTEND: () => intents.SCENE_PRESERVE_EDGE_EXTEND
};

// routes/ads.js caps Ad.imagePromptRaw at 4000 chars for the wizard, but the
// documented ceiling for the full-replace slot is 40000; the harness uses the
// larger one and says so, since it is not going through the wizard validator.
const RAW_MAX_CHARS = 40000;

function assertString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`rpd: ${label} must be a non-empty string`);
  }
  return value;
}

// Fixture mirroring what directImageRenderService.buildIntentData would hand
// buildPrompt — but supplied by the spec, so no DB is needed. PROOF-CLASS
// fields (rating/reviewCount/reviewsText/quote/attribution) are passed ONLY
// when the operator supplies them: a defaulted rating or quote is a fabricated
// claim, the same rule the titling fixture follows.
function staticFixture({ spec, variant }) {
  const stat = spec.static || {};
  const copy = { ...(stat.copy || {}), ...(variant.copy || {}) };
  const desc = variant.productDesc || stat.productDesc;
  if (!desc || !String(desc).trim()) {
    throw new Error('rpd: spec.static.productDesc is required (the product sentence production derives via describeProductForPrompt)');
  }
  const data = {
    headline: copy.headline,
    subhead: copy.subhead,
    // Production default (directImageRenderService: layoutInput.cta.text || 'SHOP NOW').
    cta: copy.cta || 'SHOP NOW'
  };
  for (const k of ['rating', 'reviewCount', 'reviewsText', 'quote', 'attribution']) {
    if (copy[k] != null && copy[k] !== '') data[k] = copy[k];
  }
  // badge: production always leaves this undefined — do not invent one.
  return {
    intentKey: variant.intent || stat.intent || 'product_first_lifestyle',
    data,
    product: {
      desc: String(desc),
      ...(stat.look || variant.look ? { look: variant.look || stat.look } : {}),
      logoCorner: stat.logoCorner || 'bottom-right'
    },
    surface: variant.surface || stat.surface || 'meta_feed_1_1',
    seedStyle: variant.seedStyle || stat.seedStyle || null,
    variantKind: variant.variantKind || stat.variantKind || null,
    seedAspect: variant.seedAspect || stat.seedAspect || null
  };
}

function runBuild(fixture) {
  const built = intents.buildPrompt(fixture);
  if (!built || built.skipped) {
    throw new Error(
      `rpd: staticAdIntents refused this surface (${fixture.surface}) — ${built && built.skipped ? built.skipped : 'skipped'}` +
      ' (meta_reels_9_16 is video-only, for example)'
    );
  }
  if (built.error) throw new Error(`rpd: staticAdIntents error: ${built.error}`);
  if (!built.prompt) throw new Error('rpd: staticAdIntents returned no prompt');
  return built;
}

// Replace whole canonical blocks in the finished prompt. Each block must be
// present exactly once, or the experiment is not testing what it claims.
function applyBlockReplacements(prompt, blocks) {
  let out = prompt;
  for (const [key, text] of Object.entries(blocks)) {
    const getter = PATCHABLE_BLOCKS[key];
    if (!getter) {
      throw new Error(
        `rpd: unknown static block "${key}" (valid: ${Object.keys(PATCHABLE_BLOCKS).join(', ')})`
      );
    }
    assertString(text, `blocks.${key}`);
    const find = getter();
    if (typeof find !== 'string' || !find) {
      throw new Error(`rpd: block ${key} resolved to no text — the constant may be flag-gated off`);
    }
    const first = out.indexOf(find);
    if (first === -1) {
      throw new Error(
        `rpd: block ${key} is not present in this prompt — it cannot be replaced. ` +
        'A flag may have routed the prompt to a different arm (e.g. STATIC_PROMPT_FIDELITY_HARDENING=false ' +
        'swaps PRODUCT_FIDELITY for the legacy paragraph), or this intent/surface does not emit it.'
      );
    }
    if (out.indexOf(find, first + find.length) !== -1) {
      throw new Error(`rpd: block ${key} occurs more than once (ambiguous)`);
    }
    out = out.slice(0, first) + text + out.slice(first + find.length);
  }
  return out;
}

// → { prompt, size, built, promptMeta }
function buildForStaticCell({ spec, model, variant }) {
  const fixture = staticFixture({ spec, variant });
  const built = runBuild(fixture);
  const baseline = built.prompt;

  const levers = ['raw', 'blocks', 'patch'].filter((k) => variant[k] != null);
  if (levers.length > 1) {
    throw new Error(`rpd: static variant "${variant.id}" sets multiple levers (${levers.join(', ')}) — pick one`);
  }
  const lever = levers[0] || 'baseline';

  let prompt;
  if (lever === 'baseline') {
    prompt = baseline;
  } else if (lever === 'raw') {
    const raw = assertString(variant.raw, 'raw');
    if (raw.length > RAW_MAX_CHARS) {
      throw new Error(`rpd: static raw prompt is ${raw.length} chars — over the ${RAW_MAX_CHARS} ceiling`);
    }
    prompt = raw;
  } else if (lever === 'blocks') {
    if (!variant.blocks || typeof variant.blocks !== 'object' || Array.isArray(variant.blocks)) {
      throw new Error('rpd: variant.blocks must be an object of {BLOCK_NAME: newText}');
    }
    // An EMPTY object selected the lever, replaced nothing, and reported
    // `lever: blocks` with a null diff — a silent baseline masquerading as an
    // experiment arm (adversarial finding, 2026-08-18). Same class as the
    // unknown-key error, so it fails the same way.
    if (!Object.keys(variant.blocks).length) {
      throw new Error(
        `rpd: static variant "${variant.id}" sets blocks: {} — that replaces nothing and would report ` +
        `a baseline prompt as a "blocks" arm. Name a block (${Object.keys(PATCHABLE_BLOCKS).join(', ')}) or drop the lever.`
      );
    }
    prompt = applyBlockReplacements(baseline, variant.blocks);
  } else {
    if (!Array.isArray(variant.patch) || variant.patch.length === 0) {
      throw new Error('rpd: variant.patch must be a non-empty array of {find, replace}');
    }
    prompt = applyStringPatches(baseline, variant.patch);
  }

  // resolveIntent can DOWNGRADE the requested intent when its data is absent
  // (social_proof_led needs a rating, objection_resolved a quote, brand_led a
  // headline). Surfacing that is mandatory: an arm labelled social_proof_led
  // that silently rendered objection_resolved would invalidate the comparison.
  const resolvedKey = built.resolved && built.resolved.key ? built.resolved.key : fixture.intentKey;
  const promptMeta = {
    lever,
    intent: resolvedKey,
    surface: built.surface && built.surface.key ? built.surface.key : fixture.surface,
    chars: prompt.length,
    baselineDiff: diffVsBaseline(baseline, prompt)
  };
  if (resolvedKey !== fixture.intentKey) {
    promptMeta.intentDowngraded = {
      requested: fixture.intentKey,
      resolved: resolvedKey,
      why: (built.resolved && built.resolved.why) || null
    };
  }

  return {
    prompt,
    size: built.surface.generate,
    built,
    fixture,
    promptMeta
  };
}

module.exports = {
  buildForStaticCell,
  staticFixture,
  applyBlockReplacements,
  PATCHABLE_BLOCKS,
  RAW_MAX_CHARS
};
