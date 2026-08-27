'use strict';

/**
 * seedTextTruth — decide, HONESTLY, whether an ad's seed image carried
 * burned-in text, and say which signal answered.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * The generation inspector (`GET /api/ads/:id/generation-inspector`) reported
 * `seedHasText: false, burnedInText: []` for a real production ad on which the
 * render path's `if (seedHasText)` had FIRED (veoPromptBuilder's burned-in-text
 * guard block was in the submitted prompt). Measured 2026-08-27.
 *
 * ROOT CAUSE was a DECODE MISMATCH, not staleness and not a missing write:
 *   • producer (render): `Array.isArray(media.text) && media.text.length > 0`
 *     — atlasVideoService / aiVideoReferenceService. A RAW LENGTH COUNT.
 *   • reader (inspector): mapped each element through `t?.text || t?.value`,
 *     `filter(Boolean)`, then took `.length > 0` of THAT.
 * The only production writer of `Media.text` is subjectTextService, whose
 * elements are `{ id, content, type, x1, y1, x2, y2, confidence }` — the
 * readable string is on **`content`**. So every element decoded to `null`, the
 * decoded array emptied, and the boolean inverted. Same document, same field,
 * same instant. Every OTHER live reader in this repo already used `.content`
 * (pipelines/detect.js, judgeService, adSuitabilityService, layoutInputService,
 * aiCanvasInputBuilder, aiCanvasHtmlGeneratorService, brandSafetyService); the
 * inspector was the sole outlier.
 *
 * ── WHY IT MATTERED MORE THAN A WRONG BOOLEAN ──────────────────────────────
 * The `seed-has-burned-in-text` warning exists specifically to tell an
 * investigator that burned-in SOURCE text — not the titling engine — is the
 * usual cause of garbled on-screen text. Deriving the flag from the decoded
 * array meant the warning was suppressed on exactly the ads where the render
 * path had detected the condition.
 *
 * ── THE RULE THIS MODULE ENCODES ───────────────────────────────────────────
 * Never re-derive a diagnostic from a projection when the thing being reported
 * is "what did the render compute". Prefer, in order:
 *   1. `render-prompt` — the persisted prompt CONTAINS the guard block. This is
 *      the strongest evidence available: it is what was actually submitted, and
 *      it survives `Media.text` being overwritten afterwards (each detect run
 *      `$set`s that array wholesale, including to `[]` when its subjects-text
 *      stage fails — so a later honest re-read can go empty on an ad whose
 *      render really did fire).
 *   2. `seed-media` — the RAW element count, mirroring the producer term for
 *      term. Used when no prompt was persisted, or when a raw-prompt override
 *      bypassed buildVeoPrompt so the guard block's absence proves nothing.
 *   3. `none`.
 *
 * The decoded strings remain a human-readable convenience ONLY. They must never
 * drive the boolean: an element whose `content` is an empty string still counts
 * for the render path (which only counts) but vanishes from a `filter(Boolean)`.
 */

/**
 * Decode one Media.text element to its readable string, or null.
 *
 * `.content` FIRST — the canonical key written by subjectTextService.
 * `.text` / `.value` are retained as legacy fallbacks for any historical row of
 * a different shape: they can only ever ADD detail, never manufacture a false
 * positive, because the boolean does not depend on this function at all.
 */
function decodeSeedTextElement(el) {
  if (typeof el === 'string') return el || null;
  if (!el || typeof el !== 'object') return null;
  return el.content || el.text || el.value || null;
}

/**
 * Mirror of the render path's producer, term for term.
 * atlasVideoService: `const seedHasText = Array.isArray(media.text) && media.text.length > 0;`
 *
 * Deliberately a RAW COUNT with no decode. If this ever starts decoding, the
 * inspector and the render path can disagree again.
 */
function seedHasTextFromMedia(media) {
  return Array.isArray(media?.text) && media.text.length > 0;
}

/**
 * Did the RENDER compute seedHasText=true? Read off the submitted prompt.
 *
 * Tri-state, and the third state is load-bearing:
 *   true  — the guard block is present in the persisted prompt.
 *   false — a prompt was persisted, buildVeoPrompt built it, and it does NOT
 *           carry the guard block.
 *   null  — we cannot tell: no prompt persisted (pre-capture render), or
 *           `videoPromptRaw` replaced the whole prompt so buildVeoPrompt never
 *           ran and its guard block could not have been emitted regardless.
 *           Collapsing null to false is what would re-introduce the lie.
 */
function renderComputedSeedHasText({ veoPrompt, videoPromptRaw, guardLine }) {
  const prompt = typeof veoPrompt === 'string' ? veoPrompt : '';
  if (!prompt) return null;
  const usedRawOverride = typeof videoPromptRaw === 'string' && videoPromptRaw.trim().length > 0;
  if (usedRawOverride) return null;
  if (typeof guardLine !== 'string' || !guardLine) return null;
  return prompt.includes(guardLine);
}

/**
 * The whole verdict, in one call.
 *
 * @param {object}  media      the seed Media row (lean); needs `.text`
 * @param {object}  ad         the Ad row; needs `.veoPrompt`, `.videoPromptRaw`
 * @param {string}  guardLine  veoPromptBuilder.SEED_BURNED_IN_TEXT_GUARD_LINE —
 *                             passed in, never re-declared here, so a reworded
 *                             builder cannot silently stop matching.
 * @returns {{
 *   seedHasText: boolean,
 *   seedHasTextSource: 'render-prompt'|'seed-media'|'none',
 *   renderComputedSeedHasText: boolean|null,
 *   seedTextElementCount: number,
 *   burnedInText: string[],
 *   recordChangedSinceRender: boolean
 * }}
 */
function resolveSeedTextTruth({ media, ad, guardLine } = {}) {
  const rawTextEls = Array.isArray(media?.text) ? media.text : [];
  const burnedInText = rawTextEls.map(decodeSeedTextElement).filter(Boolean);

  const fromMedia = seedHasTextFromMedia(media);
  const fromPrompt = renderComputedSeedHasText({
    veoPrompt:      ad?.veoPrompt,
    videoPromptRaw: ad?.videoPromptRaw,
    guardLine
  });

  // The prompt WINS when it says true — it is the only signal that describes
  // the submission rather than the current state of the world.
  const seedHasText = fromPrompt === true ? true : fromMedia;
  const seedHasTextSource = fromPrompt === true
    ? 'render-prompt'
    : (fromMedia ? 'seed-media' : 'none');

  return {
    seedHasText,
    seedHasTextSource,
    renderComputedSeedHasText: fromPrompt,
    seedTextElementCount: rawTextEls.length,
    burnedInText,
    // Itself diagnostic: the render saw text, the live record no longer does,
    // so Media.text was overwritten after the render and does not describe
    // what was submitted.
    recordChangedSinceRender: fromPrompt === true && !fromMedia
  };
}

module.exports = {
  resolveSeedTextTruth,
  // Exported for scripts/verifyTruthfulReporting.js — behavioural checks call
  // these directly rather than scanning route source text.
  decodeSeedTextElement,
  seedHasTextFromMedia,
  renderComputedSeedHasText
};
