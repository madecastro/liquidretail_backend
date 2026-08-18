// scripts/rpd/lib/promptVariants.js — prompt construction for RPD cells.
//
// Builds the EXACT prompt a production video generation would carry for a
// given (model, variant) cell, then applies the variant's lever. Levers map
// 1:1 onto the production prompt system (atlasVideoService.js ~3905-3950):
//
//   baseline   → buildVeoPrompt(fixture)            (canonical camera prompt)
//   guidance   → buildVeoPrompt({operatorPrompt})   (= videoPromptGuidance /
//                                                     wizard prepend, lever 3)
//   raw        → enforceRawByteCap(raw, caps)       (= Ad.videoPromptRaw full
//                                                     replace, lever 2 — the
//                                                     "canonical directives
//                                                     bypassed" path)
//   directives → patch OMNI/GROK/PMAX_DIRECTIVES keys for this one build,
//                restore after (what a code change to the canonical
//                directives would produce)
//   patch      → literal find/replace surgery on the finished prompt string
//
// Pure and offline: no network, no DB, no spend. The module NEVER mutates a
// directive set beyond the scope of one buildForCell call (patch → build →
// restore in finally), and verifyRpdHarness.js pins that with a before/after
// snapshot.

const {
  buildVeoPrompt,
  enforceRawByteCap,
  promptProfileFor,
  directivesForProfile,
  LIFESTYLE_DIRECTIVES,
  shouldUseLifestyleVideoPrompt
} = require('../../../services/veoPromptBuilder');

// Fixture mirroring generateForAd's promptArgs for a catalog product ad
// (no Director concept, no layoutInput on the camera path — by design).
function buildFixture({ spec, model, caps, variant }) {
  const aspectRatio = variant.aspectRatio || spec.aspectRatio || '9:16';
  const durationSec = variant.durationSec || spec.durationSec || 8;
  return {
    brand: null,
    product: spec.seed && spec.seed.productTitle ? { title: spec.seed.productTitle } : null,
    media: null,
    layoutInput: null,
    sourceMedia: null,
    aspectRatio,
    seedHasText: variant.seedHasText ?? spec.seedHasText ?? false,
    // Multi-ref stacks get the multi-view PRODUCT FIDELITY wording; a bare
    // seed gets seed-only wording. Mirrors hasProductAnchor (>= 2 images).
    hasProductReference:
      variant.hasProductReference ??
      (Array.isArray(spec.seed && spec.seed.refs) && spec.seed.refs.length > 0),
    operatorPrompt: null,
    storyboard: null,
    caps,
    durationSec,
    platformFormat: variant.platformFormat || spec.platformFormat || null,
    promptProfile: variant.promptProfile || null,
    seedStyle: null,
    variantKind: variant.variantKind || spec.variantKind || null
  };
}

function assertString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`rpd: ${label} must be a non-empty string`);
  }
  return value;
}

// Which directive set will buildVeoPrompt actually read for this fixture?
// Mirrors the builder's own selection (veoPromptBuilder ~:580): a lifestyle
// build (VIDEO_LIFESTYLE_PROMPT on + variantKind 'ugc') uses
// LIFESTYLE_DIRECTIVES, NOT the profile set — patching the profile set there
// would be a silent no-op reported as an experiment arm (adversarial
// finding 6).
function directiveTargetFor(fixture) {
  const profile = promptProfileFor(fixture.caps, {
    platformFormat: fixture.platformFormat,
    promptProfile: fixture.promptProfile
  });
  if (shouldUseLifestyleVideoPrompt(fixture.seedStyle, fixture.variantKind)) {
    return { profile: 'lifestyle', target: LIFESTYLE_DIRECTIVES };
  }
  return { profile, target: directivesForProfile(profile) };
}

// Patch directive keys on the module singleton buildVeoPrompt will read, for
// the duration of one build, then restore byte-identical originals. Unknown
// keys are a hard error — a typo must never silently produce the baseline
// prompt and get reported as an experiment arm.
function buildWithDirectivePatch(fixture, directivePatch) {
  const { profile, target } = directiveTargetFor(fixture);
  const saved = {};
  for (const [key, value] of Object.entries(directivePatch)) {
    if (!Object.prototype.hasOwnProperty.call(target, key)) {
      throw new Error(
        `rpd: directives patch key "${key}" does not exist on the ${profile} directive set ` +
        `(valid: ${Object.keys(target).join(', ')})`
      );
    }
    assertString(value, `directives.${key}`);
    saved[key] = target[key];
  }
  try {
    for (const [key, value] of Object.entries(directivePatch)) target[key] = value;
    return buildVeoPrompt(fixture);
  } finally {
    for (const [key, value] of Object.entries(saved)) target[key] = value;
  }
}

// Literal, order-applied find/replace over the finished prompt. Each find
// must occur EXACTLY once — zero matches means the experiment is not testing
// what it claims; two means it is changing more than it claims.
function applyStringPatches(prompt, patches) {
  let out = prompt;
  for (const { find, replace } of patches) {
    assertString(find, 'patch.find');
    if (typeof replace !== 'string') throw new Error('rpd: patch.replace must be a string');
    const first = out.indexOf(find);
    if (first === -1) {
      throw new Error(`rpd: patch.find not present in prompt: ${JSON.stringify(find.slice(0, 80))}`);
    }
    if (out.indexOf(find, first + find.length) !== -1) {
      throw new Error(`rpd: patch.find occurs more than once (ambiguous): ${JSON.stringify(find.slice(0, 80))}`);
    }
    out = out.slice(0, first) + replace + out.slice(first + find.length);
  }
  return out;
}

// Simple line-level diff vs baseline for the gallery (sentence-ish units:
// prompts are space-joined, so split on the '. ' boundaries both sets use).
function diffVsBaseline(baseline, prompt) {
  if (baseline === prompt) return null;
  const split = (s) => s.split(/(?<=\.)\s+/);
  const a = split(baseline);
  const b = split(prompt);
  const aSet = new Set(a);
  const bSet = new Set(b);
  const lines = [];
  for (const line of a) if (!bSet.has(line)) lines.push({ type: 'del', text: line });
  for (const line of b) lines.push(aSet.has(line) ? { type: 'same', text: line } : { type: 'add', text: line });
  return lines;
}

// → { prompt, promptMeta: { lever, profile, bytes, byteCap, baselineDiff } }
function buildForCell({ spec, model, caps, variant }) {
  const fixture = buildFixture({ spec, model, caps, variant });
  const baseline = buildVeoPrompt(fixture);

  const levers = ['guidance', 'raw', 'directives', 'patch'].filter((k) => variant[k] != null);
  if (levers.length > 1) {
    throw new Error(`rpd: variant "${variant.id}" sets multiple levers (${levers.join(', ')}) — pick one`);
  }
  const lever = levers[0] || 'baseline';

  let prompt;
  if (lever === 'baseline') {
    prompt = baseline;
  } else if (lever === 'guidance') {
    prompt = buildVeoPrompt({ ...fixture, operatorPrompt: assertString(variant.guidance, 'guidance') });
  } else if (lever === 'raw') {
    prompt = enforceRawByteCap(assertString(variant.raw, 'raw'), fixture.caps);
  } else if (lever === 'directives') {
    if (!variant.directives || typeof variant.directives !== 'object' || Array.isArray(variant.directives)) {
      throw new Error('rpd: variant.directives must be an object of {directiveKey: newText}');
    }
    prompt = buildWithDirectivePatch(fixture, variant.directives);
  } else {
    if (!Array.isArray(variant.patch) || variant.patch.length === 0) {
      throw new Error('rpd: variant.patch must be a non-empty array of {find, replace}');
    }
    prompt = applyStringPatches(baseline, variant.patch);
  }

  const byteCap = (fixture.caps && fixture.caps.promptByteCap) || 4096;
  const bytes = Buffer.byteLength(prompt, 'utf8');
  if (bytes > byteCap) {
    throw new Error(`rpd: variant "${variant.id}" prompt is ${bytes} bytes — over the ${byteCap}-byte cap for ${model}`);
  }

  return {
    prompt,
    fixture,
    promptMeta: {
      lever,
      profile: promptProfileFor(fixture.caps, {
        platformFormat: fixture.platformFormat,
        promptProfile: fixture.promptProfile
      }),
      bytes,
      byteCap,
      baselineDiff: diffVsBaseline(baseline, prompt)
    }
  };
}

module.exports = { buildForCell, buildFixture, applyStringPatches, diffVsBaseline };
