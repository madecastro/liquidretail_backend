// scripts/rpd/lib/promptCatalog.js — "what can I change, and what does it say now?"
//
// The audience is a semi-technical tester asking "what if we use Grok instead of
// Omni?" or "what if we change this bit of the prompt?". Both questions need the
// same thing first: the NAMED, changeable elements and their CURRENT text. Until
// now that lived only in a reference doc, so the answer drifted from the code the
// moment anyone edited a directive.
//
// This reads the live constants, so it cannot go stale. Free, offline, read-only.

const intents = require('../../../services/staticAdIntents');
const veo = require('../../../services/veoPromptBuilder');
const { PATCHABLE_BLOCKS } = require('./staticPrompt');

// WHAT EACH ELEMENT CONTROLS, and the trap attached to it. A tester asking "what
// if we changed this?" needs the meaning, not just the string — and a session
// brainstorming with them needs it to avoid recommending a change that is either
// a known rollback or a structural break. Deep version:
// .claude/skills/rpd-experiments/references/prompt-elements.md
const VIDEO_MEANING = {
  role: 'Persona framing. Sets "camera operator, not image generator". Low-yield to change.',
  objective: 'What the ad is FOR. The PMax variant adds HOOK-FIRST here. Good lever for pacing/attention.',
  sourceImages: 'The locked-photo rule — supplied images are the source of truth. Do not weaken.',
  productPreservation: 'THE fidelity core for video. Weakening it invites drift; strengthening it has not yet been shown to fix the known ~1-in-3 defect.',
  transitions: 'Cut/dissolve policy. HIGH-VALUE lever — measured: "hard cuts only" removed baseline crossfade ghosting. See the deliberate contradiction note.',
  cameraStyle: 'Motion character and amount. HIGH-VALUE — evidence favours LOW motion for product fidelity.',
  background: 'Whether the scene may be extended/replaced. Relevant to studio-vs-lifestyle framing.',
  visualStyle: 'The look — ecommerce polish vs lived-in lifestyle. Direct lever for "studio vs lifestyle".',
  audio: 'Ambience only, no music/VO. We do not use generated audio; low-value to change.',
  noText: 'DO NOT REMOVE. Titles are composited by Remotion afterwards; in-model text burns in and cannot be retitled.',
  physicalAccuracy: 'Hands/faces sanity. Matters only when a person is in frame (on-model shots).',
  doNot: 'The ban list. Paired with `transitions` — read the contradiction note before editing either.',
  ambientLife: 'Lifestyle-only: how much incidental human/world motion is allowed.'
};

const STATIC_MEANING = {
  PRODUCT_FIDELITY: 'THE fidelity core for static. Swapping it measured a NULL result at n=1/arm — treat model choice as the stronger lever.',
  SCENE_PRESERVE: 'Keep the seed photo\'s scene instead of building a new one. Only emitted for lifestyle/UGC seeds, so replacing it on a packshot is an error.',
  SCENE_PRESERVE_EDGE_EXTEND: 'The edge-extension variant of the above. Same lifestyle/UGC-only caveat.'
};

function meaningFor(kind, key) {
  return (kind === 'static' ? STATIC_MEANING : VIDEO_MEANING)[key] || null;
}

// Video: the directive SETS are objects, one per prompt profile, and every key in
// them is individually swappable via a variant's `directives`.
function videoElements(profile = 'gemini-omni') {
  const set = profile === 'lifestyle'
    ? veo.LIFESTYLE_DIRECTIVES
    : veo.directivesForProfile(profile);
  return Object.entries(set).map(([key, text]) => ({ key, text: String(text), meaning: meaningFor('video', key) }));
}

function videoProfiles() {
  return ['gemini-omni', 'grok', 'pmax', 'lifestyle'];
}

// Static: whole blocks, replaced verbatim in the finished prompt.
function staticElements() {
  return Object.entries(PATCHABLE_BLOCKS).map(([key, get]) => {
    let text = null;
    try { text = get(); } catch { /* flag-gated off */ }
    return { key, text: text == null ? null : String(text), meaning: meaningFor('static', key) };
  });
}

function staticIntents() {
  return Object.keys(intents.INTENTS);
}

function truncate(s, n) {
  const one = String(s).replace(/\s+/g, ' ').trim();
  return one.length <= n ? one : `${one.slice(0, n - 1)}…`;
}

// A paste-ready variant, so "change this element" ends in something runnable
// rather than a description of something runnable.
function exampleVariant(kind, key) {
  if (kind === 'video') {
    return JSON.stringify({ id: `my-${key.toLowerCase()}-test`, directives: { [key]: '…your replacement text…' } }, null, 2);
  }
  return JSON.stringify({ id: `my-${key.toLowerCase()}-test`, blocks: { [key]: '…your replacement text…' } }, null, 2);
}

module.exports = { videoElements, videoProfiles, staticElements, staticIntents, truncate, exampleVariant, meaningFor };
