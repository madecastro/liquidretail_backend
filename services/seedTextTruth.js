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
 *      term. Used when the prompt says nothing: none persisted, or the
 *      persisted prompt IS a raw override (identified by a prefix test on the
 *      prompt itself, NOT by `videoPromptRaw` merely being set — see
 *      promptCarriesSeedTextGuard), so the guard's absence proves nothing.
 *   3. `none`.
 *
 * BOTH directions of prompt-vs-media disagreement are reported, each as its own
 * flag, because they mean different things and need different action:
 * `recordChangedSinceRender` (prompt yes, record no) and `guardMissingAtRender`
 * (prompt no, record yes — the model got text-bearing pixels unguarded).
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
 * Does the SUBMITTED PROMPT carry the burned-in-text guard sentence?
 *
 * Named for exactly what it measures. An earlier draft called this
 * `renderComputedSeedHasText`, which over-claimed: operator
 * `videoPromptGuidance` and a regenerate `operatorPrompt` are PREPENDED into
 * the same persisted string as an `OPERATOR REFINEMENT (HIGHEST PRIORITY…)`
 * header (veoPromptBuilder ~:776-781), and guidance is capped at 1000 chars
 * while the guard is 282 bytes — so a pasted guard sentence would have made
 * that name false. Under THIS name the answer is true in every case, because
 * either way the model was handed the sentence.
 *
 * Tri-state, and the third state is load-bearing:
 *   true  — the guard sentence is present in the persisted prompt. The model
 *           was told to treat burned-in text as locked, however the prompt was
 *           assembled.
 *   false — a prompt was persisted, buildVeoPrompt assembled it, and it does
 *           NOT carry the guard.
 *   null  — cannot tell: no prompt persisted (pre-capture render), or the
 *           persisted prompt IS a raw override, which replaces the whole string
 *           so the guard could never have been emitted. Collapsing null to
 *           false is what would re-introduce the original lie.
 */
function promptCarriesSeedTextGuard({ veoPrompt, videoPromptRaw, guardLine }) {
  const prompt = typeof veoPrompt === 'string' ? veoPrompt : '';
  if (!prompt) return null;
  if (typeof guardLine !== 'string' || !guardLine) return null;

  // PRESENCE is positive evidence however the prompt was assembled: if the
  // sentence is in the submitted text, the model WAS instructed to treat
  // burned-in text as locked. That is what this function is named for, and it
  // is why presence is checked BEFORE any override gate.
  if (prompt.includes(guardLine)) return true;

  // ABSENCE only means something if buildVeoPrompt actually assembled this
  // prompt. A raw override replaces the whole string, so the guard could never
  // have been emitted and its absence proves nothing.
  //
  // ⚠️ THE GATE IS ON THE PERSISTED PROMPT, NOT ON THE FIELD BEING SET.
  // Gating on `videoPromptRaw` being non-empty was a real hole (adversarial
  // review, 2026-08-27): regenerate is pass-through and never clears that
  // field, so a wizard-stamped `videoPromptRaw` followed by a refinement
  // regenerate persists a CANONICAL veoPrompt while the field stays set. The
  // field-based gate returned null, fell back to a possibly-emptied Media
  // record, and reported false — the original lie, one field removed.
  //
  // `enforceRawByteCap` truncates the raw text on a UTF-8 boundary, so a
  // persisted raw override is a PREFIX of the raw field. That prefix test is
  // what identifies the override, and it cannot be fooled by a stale field.
  const rawTrim = typeof videoPromptRaw === 'string' ? videoPromptRaw.trim() : '';
  const promptIsTheRawOverride = rawTrim.length > 0 && rawTrim.startsWith(prompt.trim());
  if (promptIsTheRawOverride) return null;

  return false;
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
 *   promptCarriesSeedTextGuard: boolean|null,
 *   seedTextElementCount: number,
 *   burnedInText: string[],
 *   recordChangedSinceRender: boolean,
 *   guardMissingAtRender: boolean
 * }}
 */
function resolveSeedTextTruth({ media, ad, guardLine } = {}) {
  const rawTextEls = Array.isArray(media?.text) ? media.text : [];
  const burnedInText = rawTextEls.map(decodeSeedTextElement).filter(Boolean);

  const fromMedia = seedHasTextFromMedia(media);
  const fromPrompt = promptCarriesSeedTextGuard({
    veoPrompt:      ad?.veoPrompt,
    videoPromptRaw: ad?.videoPromptRaw,
    guardLine
  });

  // The prompt WINS when it says true — it is the only signal that describes
  // the submission rather than the current state of the world. A prompt-FALSE
  // does NOT override a media-true: the seed genuinely has text now, and that
  // combination is its own finding (see guardMissingAtRender below).
  const seedHasText = fromPrompt === true ? true : fromMedia;
  const seedHasTextSource = fromPrompt === true
    ? 'render-prompt'
    : (fromMedia ? 'seed-media' : 'none');

  return {
    seedHasText,
    seedHasTextSource,
    // Named for what it MEASURES — "the submitted prompt carries the guard
    // sentence" — not for an inference about what the render computed. The
    // earlier name (`renderComputedSeedHasText`) over-claimed: operator
    // `videoPromptGuidance` is prepended into the same persisted string, so a
    // pasted guard sentence would have made that name a lie. This name is true
    // in every case, which is the whole point of the change.
    promptCarriesSeedTextGuard: fromPrompt,
    seedTextElementCount: rawTextEls.length,
    burnedInText,
    // ── BOTH DIRECTIONS OF DISAGREEMENT ARE REPORTED ─────────────────────
    // The first draft reported only the first of these and the header claimed
    // disagreements "raise their own warning rather than being silently
    // resolved" — which was then false for the reverse case. Adversarial review
    // caught it. Each direction means something different and needs saying:

    // Prompt said text, the live record now says none → Media.text was
    // overwritten after the render (detect $sets it wholesale, including to []
    // when its subjects-text stage fails). The record no longer describes the
    // submission; trust the prompt.
    recordChangedSinceRender: fromPrompt === true && !fromMedia,

    // Prompt did NOT carry the guard, but the seed record HAS text → the model
    // was handed text-bearing pixels with no instruction to leave that text
    // alone. This is the more actionable direction of the two: it is a live
    // candidate cause of garbled on-screen text, not merely a stale record.
    // Either the text was detected after the render, or seedHasText was false
    // at submit while the media already carried detections.
    guardMissingAtRender: fromPrompt === false && fromMedia
  };
}

module.exports = {
  resolveSeedTextTruth,
  // Exported for scripts/verifyTruthfulReporting.js — behavioural checks call
  // these directly rather than scanning route source text.
  decodeSeedTextElement,
  seedHasTextFromMedia,
  promptCarriesSeedTextGuard
};
