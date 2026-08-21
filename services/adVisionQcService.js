// Post-render VISION QC for static AND video product ads.
//
// WHY: prompts already demand product fidelity (staticAdIntents.js:261-264,423)
// and gpt-image-2/edit has no input_fidelity param. Live 2026-08-03 renders still
// stamped competitor-shaped brand marks onto products (~1 in 3). The remaining
// lever is measure-and-reject against the ORIGINAL product photo.
//
// STATIC CONTRACT (runPostRenderQc / judgeRender / buildVisionUserContent):
//   - Always compare ORIGINAL PRODUCT vs FINISHED RENDER in ONE vision call.
//   - Four categories, each scored + findings.
//   - Fail → regenerate exactly ONCE with a corrective prompt → re-QC.
//   - Second failure → fail the ad (never a third generation). MONEY INVARIANT.
//   - Discarded (already-paid) renders keep their URL on the persisted verdict.
//
// VIDEO CONTRACT (runVideoPostRenderQc / judgeVideoRender /
// buildVideoVisionUserContent) — added to close the gap where the video
// pipeline (atlasVideoService / brandScriptExecutor) shipped with ZERO
// vision inspection while statics were protected:
//   - Compare ORIGINAL PRODUCT vs N frames SAMPLED from the delivered video
//     in ONE vision call, same SAME four category keys so Ad.visionQc /
//     summarizeVisionQc / the gallery UI need no video-specific branch. This
//     function does not pick the frames itself — the caller
//     (brandScriptExecutor.runVideoVisionQcForAd) resolves them via
//     services/videoQcFrameSelectionService.js, which sends the pre-existing
//     3-frame quartile baseline (services/videoFrameService.buildFrameUrls —
//     Cloudinary `so_<sec>` edge transform, no ffmpeg/local decode needed)
//     PLUS up to 2 extra frames flagged by a cheap, non-billable perceptual
//     pre-filter — added 2026-08-20 because quartile sampling ALONE is
//     structurally blind to a defect that appears and disappears inside one
//     quartile window (see that module's file header for the full
//     "hallucinated storefront-chrome" incident and the design). This
//     function's contract (compare seed vs whatever frames it is handed,
//     one vision call, no regeneration) is unchanged either way.
//   - NEVER regenerates. A video master is ~$0.90 (vs ~$0.07 for a static)
//     and a colourway/brand-mark defect is baked into the generative clip —
//     a second $0.90 submit on the same seed is not a reliable fix, unlike a
//     static regen with a corrective prompt. See runVideoPostRenderQc's
//     docstring for the full money reasoning.
//   - Deliberately FLAGS rather than fails the ad: the master is already
//     paid for, and re-deriving/re-titling from it cannot un-bake a
//     hallucinated colour. `ok` is always true; the caller (brandScriptExecutor
//     .uploadRenderAndStamp) stamps the failed verdict and ships the ad as a
//     normal draft so an operator sees the FAIL badge (via the same
//     summarizeVisionQc surfacing PR #236 wired up) before sending it to a
//     platform, instead of silently discarding a paid asset.
//
// Feature flag resolution (most specific first) — SHARED by both static and
// video callers (one gate, not two): flipping it protects both pipelines.
//   1. SystemConfig.adVisionQcEnabled when a real boolean (DB, live-flippable)
//   2. process.env.AD_VISION_QC_ENABLED === 'true' after toLowerCase (env)
//   3. default false
// Default stays OFF. DB override is the no-redeploy lever — env alone would
// force a Render restart. See resolveEnabled() / isEnabled() below.
// Model role: 'ad-vision-qc' in atlasModelMap (routing MUST be probed live).

'use strict';

const { chatCompletion } = require('./atlasLlmService');
// Salvage-only fallback for a garbled-but-still-JSON verdict — see
// salvageVerdictJson()'s header for why this is a LOCAL port of
// aiCreativeDirectorService's balanced-brace algorithm rather than an
// import of that module.
const JSON5 = require('json5');

// ── MONEY INVARIANT ───────────────────────────────────────────────────
// Exactly one regeneration is allowed after a failed QC pass. This is a
// hard constant, NOT an env knob — raising it multiplies billable image
// submits. The harness asserts behavioural count, not just this number.
const MAX_QC_REGENERATIONS = 1;

const CATEGORIES = Object.freeze([
  'competitor_marks',
  'product_fidelity',
  'text_defects',
  'layout_safe_box'
]);

// Per-category minimum to pass (0–10 integer scores from the model).
const PASS_FLOOR = 7;

// Role name in atlasModelMap. Env ATLAS_MODEL_AD_VISION_QC can re-point.
//
// RESOLVES TO google/gemini-2.5-pro (atlasModelMap.js, 'ad-vision-qc').
// This comment previously claimed "CHOSEN: gemini-2.5-flash", which was WRONG
// and was the exact doc-drift class this repo keeps getting bitten by: the map
// has routed this role to PRO, not flash, and CLAUDE.md records why — flash
// broke the JSON contract on this very task, and a malformed verdict is
// consumed as a failed one, so it either ships a bad ad or burns the single
// billable regeneration. Do not "restore" flash on the strength of its price.
//
// ROUTABILITY: CONFIRMED LIVE 2026-08-05 against Atlas
// (POST /v1/chat/completions, google/gemini-2.5-pro → HTTP 200, valid JSON,
// finish_reason 'stop'). This check is not optional and not satisfied by the
// catalog listing — see the gpt-5-nano trap in atlasModelMap, where a listed
// model returned HTTP 400 "router not found". Re-probe if the role is repointed.
//
// COST, from the live catalog 2026-08-05 (per 1M tokens): pro in $1.25 / out
// $10. A check is ~2 images + prompt, so roughly $0.01-0.03 including reasoning
// tokens — noise against the ~$0.0717 gpt-image-2/edit render it protects.
// Cheaper gemini tiers exist (3-flash-preview, 3.1-flash-lite) but they are
// flash-class; note google/gemini-3.5-flash is actually MORE expensive on input
// than 2.5-pro ($1.50), so it is not even a cost argument. There is no
// gemini-3.5-pro in the catalog.
const QC_MODEL_ROLE = 'ad-vision-qc';

// Log-once guard for a SystemConfig read failure. A config lookup must
// never be able to break a render; we fall back to env/default and warn.
let _systemConfigReadFailedLogged = false;

/**
 * Env-only gate. Matches the historical isEnabled() contract:
 *   String(env || '').toLowerCase() === 'true'
 * so "TRUE" enables, "false" / "TRUE " / "1" do not.
 */
function envEnabled() {
  return String(process.env.AD_VISION_QC_ENABLED || '').toLowerCase() === 'true';
}

/**
 * Async resolver — preferred for any path that can await.
 *
 * Precedence (most specific first):
 *   1. SystemConfig.adVisionQcEnabled when typeof === 'boolean'
 *   2. env AD_VISION_QC_ENABLED (via envEnabled)
 *   3. default false
 *
 * Fail-safe: a throwing Mongo/config read falls through to env/default and
 * NEVER rejects. deps.getAdVisionQcEnabled is injectable for the harness.
 */
async function resolveEnabled(deps = {}) {
  try {
    const getCfg = deps.getAdVisionQcEnabled
      || require('./systemConfigService').getAdVisionQcEnabled;
    const dbVal = await getCfg();
    if (typeof dbVal === 'boolean') return dbVal;
  } catch (err) {
    if (!_systemConfigReadFailedLogged) {
      _systemConfigReadFailedLogged = true;
      const msg = (err && err.message) ? err.message : String(err || 'unknown');
      console.warn(
        `   ⚠️  adVisionQc: SystemConfig read failed — falling back to env/default: ${msg}`
      );
    }
  }
  return envEnabled();
}

/**
 * SYNCHRONOUS fallback ONLY — as of 2026-08-20, NONE of the three
 * production hot-path callers (directImageRenderService.renderDirectImage /
 * finishPlate, brandScriptExecutor.runVideoVisionQcForAd,
 * imageRecoveryService.maybeQcRecoveredPlate) use this anymore. All three
 * are already `async` functions that already `await` a billable vision
 * call a few lines later, so they now `await resolveEnabled()` directly —
 * there is no reason for an async caller to take a synchronous, cache-racy
 * path when it can just await the correct one.
 *
 * PRODUCTION BUG THIS USED TO HAVE, fixed 2026-08-20 (kept here as the
 * cautionary reason nothing should switch back to calling this from a hot
 * path): `refreshAdVisionQcEnabledCache()` is fire-and-forget, so the
 * `peekAdVisionQcEnabled()` immediately below it can only ever see the
 * state from BEFORE that refresh, never the value it just kicked off. As
 * long as `peekAdVisionQcEnabled()` also expired stale entries (pre-fix),
 * any call landing after the 5s TTL — which is the NORMAL case, since real
 * renders are spaced further apart than 5s — read "no fresh entry" and fell
 * through to `envEnabled()`, silently disabling QC even when
 * SystemConfig.adVisionQcEnabled was genuinely `true`. Measured live: 11 of
 * 18 delivered statics stamped `visionQc.disabled:true` with the flag on.
 * `peekAdVisionQcEnabled()` (services/systemConfigService.js) no longer
 * expires its answer this way — see its doc comment for the fix and the
 * fail-safe-direction reasoning — so this function is safe to call again if
 * a genuinely synchronous caller ever needs it. It still answers from
 * `envEnabled()` on a truly cold cache (nothing ever loaded in this
 * process), which matches the documented "unconfigured → off" default.
 * Never throws.
 */
function isEnabled() {
  try {
    const cfg = require('./systemConfigService');
    if (typeof cfg.refreshAdVisionQcEnabledCache === 'function') {
      cfg.refreshAdVisionQcEnabledCache();
    }
    if (typeof cfg.peekAdVisionQcEnabled === 'function') {
      const peeked = cfg.peekAdVisionQcEnabled();
      // Only a real boolean overrides env. null = "not set" → env.
      // undefined = never loaded in this process → env.
      if (typeof peeked === 'boolean') return peeked;
    }
  } catch (_) {
    // never break a render over a config module hiccup
  }
  return envEnabled();
}

/** Test hook: allow the harness to re-arm the one-shot failure log. */
function _resetSystemConfigFailLogForTests() {
  _systemConfigReadFailedLogged = false;
}

// ── Gate-off visibility ────────────────────────────────────────────────
// PRODUCTION FINDING 2026-08-19: a live run (39/39 ads delivered) shipped
// with visionQc:null on every single ad, static AND video. Root cause was
// NOT a deploy-timing gap or a swallowed exception — process.env had zero
// AD_VISION_QC_ENABLED/*QC* keys and no SystemConfig doc existed at all, so
// resolveEnabled()/isEnabled() correctly fall through to `false`. That part
// is a real, working gate — but every live caller (directImageRenderService
// .renderDirectImage, brandScriptExecutor.runVideoVisionQcForAd,
// imageRecoveryService.maybeQcRecoveredPlate) short-circuits on
// `!isEnabled()` and returns BEFORE ever reaching runPostRenderQc /
// runVideoPostRenderQc's own "Flag off" branch below — which is the only
// code that builds the {skipped:true, disabled:true, reason:...} shape and
// logs anything. Production never executes that branch, so a flag left off
// for weeks produces silence in both the DB (Ad.visionQc stays the schema
// default `null`, indistinguishable from "inspected and passed") and the
// logs (not one line explains why).
//
// warnQcDisabledOnce() is the shared fix: every caller-level early-return
// now (a) builds this SAME disabled-verdict shape itself via
// buildPersistedVerdict (cheap — no network/DB, so no cost to calling it
// unconditionally) instead of bare `return null`, and (b) calls this so the
// gate being off is loud in logs, not silent. One counter shared across all
// three callers/pipelines — a run that mixes static+video ads only warns
// once, not once per ad.
let _qcDisabledWarnedAt = 0;
const QC_DISABLED_REWARN_MS = 60 * 60 * 1000; // re-warn hourly — a flag left off for a week must keep being loud, not just once per process start
function warnQcDisabledOnce(mediaLabel = 'ad') {
  const now = Date.now();
  if (now - _qcDisabledWarnedAt < QC_DISABLED_REWARN_MS) return;
  _qcDisabledWarnedAt = now;
  console.warn(
    `   ⚠️  adVisionQc: AD_VISION_QC_ENABLED is OFF (env unset and no SystemConfig.adVisionQcEnabled ` +
    `override) — every delivered ${mediaLabel} is shipping WITHOUT vision inspection until this is ` +
    'turned on. Not a failure by itself — just make sure this is the intended state.'
  );
}

/** Test hook: allow the harness to re-arm the gate-off warning. */
function _resetQcDisabledWarnForTests() {
  _qcDisabledWarnedAt = 0;
}

function resolveQcModel() {
  const override = process.env.ATLAS_MODEL_AD_VISION_QC || process.env.AD_VISION_QC_MODEL;
  if (override) return override;
  return QC_MODEL_ROLE;
}

/**
 * Build the multimodal user content: labelled text + TWO images.
 * Image order is fixed: [0]=ORIGINAL PRODUCT, [1]=GENERATED AD.
 * Follows aiCreativeDirectorService.js:1208-1212 convention
 * ({type:'image_url', image_url:{url}}).
 *
 * expectedText contract:
 *   - string[] (possibly empty) when the copy contract is KNOWN.
 *     Empty list means pure product image is legitimate (live path).
 *   - expectedTextUnknown:true when the copy contract cannot be
 *     reconstructed (recovery). Then text_defects is scored ONLY on
 *     intrinsic defects — never on "unexpected" copy presence. Do NOT
 *     pass [] for that case: [] means "no text allowed".
 */
function buildVisionUserContent({
  originalProductUrl,
  renderUrl,
  brandName,
  safeBox,
  deliveryDims,
  expectedText,
  expectedTextUnknown = false
}) {
  if (!originalProductUrl) throw new Error('adVisionQc: originalProductUrl required');
  if (!renderUrl) throw new Error('adVisionQc: renderUrl required');

  const brand = brandName || 'the advertiser';
  const box = safeBox || {};
  const dims = deliveryDims || {};

  let expectedTextSection;
  let textDefectsInstruction;
  if (expectedTextUnknown) {
    // Recovery / any path where the exact copy contract is not durable.
    // MUST NOT render as "(none — pure product…)" — that false-fails every
    // ad that legitimately carries a brand line / CTA / rating.
    expectedTextSection =
      'Expected on-ad text strings: UNKNOWN — the exact copy contract for this ' +
      'render is not available to the inspector.\n' +
      '  Score text_defects ONLY on intrinsic defects (misspellings, gibberish ' +
      'letterforms, mangled or duplicated words, literal role-label leakage ' +
      'like "RATING:"). Do NOT fail for the mere presence of brand copy, CTAs, ' +
      'ratings, headlines or other ad text — those may be legitimate. Still ' +
      'fail for intrinsically mangled letterforms.';
    textDefectsInstruction =
      'Misspellings, mangled or duplicated words, gibberish letterforms, and ' +
      'literal label leakage (e.g. "RATING: 4.8 ★" with the role label visible). ' +
      'The expected copy list is UNKNOWN — score ONLY these intrinsic defects; ' +
      'do NOT penalise presence of otherwise-plausible ad copy.';
  } else {
    const textList = Array.isArray(expectedText) && expectedText.length
      ? expectedText.map((t) => `  - ${t}`).join('\n')
      : '  (none — pure product image is legitimate)';
    expectedTextSection =
      'Expected on-ad text strings (if any) — these are the ONLY words that should appear as ad copy:\n' +
      textList;
    textDefectsInstruction =
      'Misspellings, mangled or duplicated words, gibberish letterforms, and ' +
      'literal label leakage (e.g. "RATING: 4.8 ★" printed with the role label ' +
      '"RATING" visible). Compare against the expected text list above.';
  }

  const prompt = `You are a post-render quality inspector for direct-response product ads.

You are given TWO images in this exact order:
  IMAGE 1 — ORIGINAL PRODUCT PHOTO (the source/hero reference the ad was generated from)
  IMAGE 2 — GENERATED AD (the finished render about to ship)

Brand name: ${brand}
Delivery canvas: ${dims.width || '?'}×${dims.height || '?'} px
Declared SAFE BOX (content must stay inside; coordinates in delivered pixels):
  left=${box.left ?? '?'}, top=${box.top ?? '?'}, right=${box.right ?? '?'}, bottom=${box.bottom ?? '?'}
${expectedTextSection}

Score EACH category 0–10 (integer) and list concrete findings. Return ONLY JSON.

CATEGORIES

1. competitor_marks (PRIMARY)
   Logos, wordmarks, emblems, badges, tree/animal/crest marks, or other brand
   devices present ON THE PRODUCT in IMAGE 2 that are ABSENT from the product
   in IMAGE 1, OR that belong to a DIFFERENT brand than ${brand}.
   IMPORTANT: ${brand}'s OWN logo composited into a corner of the ad is EXPECTED
   and must NOT be flagged. Only invent marks on the product surface / midfoot /
   chest / hardware that were not on the original product.

2. product_fidelity
   Silhouette, colourway, materials, panel/pocket count, orientation, and
   construction drift from IMAGE 1. Scene/background change is fine; product
   identity drift is not.

3. text_defects
   ${textDefectsInstruction}

4. layout_safe_box
   Any text, CTA, or logo that breaches the declared safe box numbers above,
   or a CTA that is clipped at the canvas edge. Use the pixel numbers — do
   not invent a different safe region.

JSON SHAPE (no prose outside it):
{
  "categories": {
    "competitor_marks": { "score": 0, "pass": true, "findings": ["..."] },
    "product_fidelity": { "score": 0, "pass": true, "findings": ["..."] },
    "text_defects":     { "score": 0, "pass": true, "findings": ["..."] },
    "layout_safe_box":  { "score": 0, "pass": true, "findings": ["..."] }
  },
  "summary": "one-line overall"
}`;

  return [
    { type: 'text', text: prompt },
    // Explicit labels in adjacent text parts so the model cannot swap them.
    { type: 'text', text: 'IMAGE 1 — ORIGINAL PRODUCT PHOTO:' },
    { type: 'image_url', image_url: { url: originalProductUrl } },
    { type: 'text', text: 'IMAGE 2 — GENERATED AD:' },
    { type: 'image_url', image_url: { url: renderUrl } }
  ];
}

function clampScore(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(10, Math.round(x)));
}

function emptyCategories(reason) {
  const o = {};
  for (const k of CATEGORIES) {
    o[k] = { score: 0, pass: false, findings: reason ? [reason] : [] };
  }
  return o;
}

/**
 * String-aware balanced {...} span starting at `start` — a brace inside a
 * quoted finding string cannot end the object early. Local port of
 * aiCreativeDirectorService's `balancedSpanFrom` (both quote chars tracked
 * for the same JSON5-single-quote reason that file documents). Returns null
 * when nothing balances.
 */
function balancedSpanFrom(s, start) {
  if (start < 0 || s[start] !== '{') return null;
  let depth = 0;
  let quote = null;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Non-greedy, multi-CANDIDATE JSON scan for a vision reply that is
 * JSON-SHAPED but not JSON-ONLY — fenced with trailing commentary after the
 * closing fence, or prefaced/followed by a sentence of prose. Scans every
 * balanced `{...}` span left to right (a span that fails to parse is looked
 * INTO, not skipped, in case the real object is nested inside prose-shaped
 * braces), parsing each with JSON.parse then a JSON5 fallback.
 *
 * Returns EVERY candidate that parsed, plus `hadUnrecoverableSpan` — true
 * when the text contains a `{` that either (a) never found a matching `}`,
 * or (b) DID balance but failed BOTH JSON.parse and JSON5.parse WHILE LOOKING
 * LIKE A GENUINE JSON-OBJECT ATTEMPT (`/^\{\s*"[^"\\]*"\s*:/` — starts with a
 * quoted key and a colon, e.g. `{"categories": …`), as opposed to incidental
 * prose punctuation (`{option A}`, `{finalized}`). That distinction matters:
 * a span that merely LOOKS like decorative prose braces is expected and
 * benign — it's exactly what "look INTO a failed span" below exists to see
 * past — but a span that opens like a real JSON object and then fails to
 * parse is evidence the reply itself is corrupted (e.g. an unescaped quote
 * inside a `findings` string breaks quote-tracking for everything after it),
 * and trusting whatever DID parse elsewhere in that same corrupted text is
 * exactly how a real failing verdict can be shadowed by an accidentally
 * well-formed fragment nested inside it. Both conditions make the whole
 * salvage untrustworthy, not just the one span. Deliberately does NOT pick a
 * winner among the candidates that DID parse — see pickSafestCandidate()
 * below for why that decision needs to be verdict-aware (money-safe), not a
 * generic parsing heuristic.
 *
 * This is a LOCAL PORT of aiCreativeDirectorService.safeParseDirectorJSON's
 * scanning algorithm (the task's named closest fit), not an import of that
 * module: this file today requires nothing but `atlasLlmService` at the top
 * (plus a few lazily-required siblings — systemConfigService, alertService,
 * runFeedService — none of them model-heavy). aiCreativeDirectorService
 * drags in five Mongoose models and half a dozen Director-only services;
 * pulling that into the vision-QC module to reuse a few lines of pure
 * scanning logic would be a much bigger blast radius than the logic itself,
 * and this fix is scoped to touch only this file. The SCAN is reused
 * verbatim — deliberately non-greedy, for the same reason documented there:
 * a greedy `/\{[\s\S]*\}/` swallows trailing prose and turns a salvageable
 * reply into a parse error. Only the WINNER-PICKING half diverges, because
 * "prefer a `concepts` array" (Director) and "never let ambiguity between
 * two replies invent a passing QC score" (here) are different problems.
 */
const LOOKS_LIKE_JSON_OBJECT_ATTEMPT = /^\{\s*"[^"\\]*"\s*:/;

function salvageVerdictJson(rawText) {
  const text = String(rawText == null ? '' : rawText);
  const candidates = [];
  let hadUnrecoverableSpan = false;
  let i = text.indexOf('{');
  while (i >= 0) {
    const span = balancedSpanFrom(text, i);
    if (!span) { hadUnrecoverableSpan = true; i = text.indexOf('{', i + 1); continue; }
    let obj;
    let ok = true;
    try { obj = JSON.parse(span); }
    catch { try { obj = JSON5.parse(span); } catch { ok = false; } }
    if (ok) {
      candidates.push(obj);
      i = text.indexOf('{', i + span.length);
    } else {
      if (LOOKS_LIKE_JSON_OBJECT_ATTEMPT.test(span)) hadUnrecoverableSpan = true;
      i = text.indexOf('{', i + 1);
    }
  }
  return { candidates, hadUnrecoverableSpan };
}

/**
 * Core per-category normalization + scoring for an ALREADY-PARSED object, in
 * any of the tolerated root shapes (nested `categories` wrapper, missing
 * wrapper with keys at root, findings hoisted). Pure, no I/O.
 *
 * Factored out of parseVerdict so there is exactly ONE place that decides
 * "does this parsed object represent a pass or a fail" — both the main path
 * below and pickSafestCandidate()'s money-safe candidate selection call this
 * SAME function, so "which shape drift is tolerated" and "how a salvage
 * candidate is judged safe to trust" can never silently diverge.
 *
 * Drifts tolerated, all shape-only, substance never invented:
 *   (a) The `categories` wrapper missing — the four keys sit on the root
 *       object instead (checked key-by-key, so a PARTIALLY hoisted reply —
 *       some keys nested, one loose at the root — is still recovered per
 *       key, not all-or-nothing). Root fallback is disabled entirely when
 *       `categories` is PRESENT but the wrong type (a string/array/number/
 *       boolean) — that is a different, more corrupted signal than "omitted
 *       wrapper", and trusting root data in that case would let a
 *       coincidental root shape override a categories value the model
 *       clearly (if badly) tried to nest.
 *   (b) `findings` hoisted to the top level instead of nested per category —
 *       tolerated in two shapes: an object keyed by category name (attributed
 *       to that category, merged with — never replacing — any findings the
 *       category itself carried) or a flat array of strings (cannot be
 *       attributed to any one category with any real signal, so it is kept
 *       as unattributed context on a FAILING verdict only, never used to
 *       flip any category's own score/pass).
 *   (c) A category value arriving as a bare boolean instead of an object —
 *       see the direction-of-boolean reasoning inline below. Both `true` and
 *       `false` are treated as an unparseable category and FAIL, same as a
 *       wholly absent category — tolerance never means guessing a pass.
 *
 * A category that is genuinely absent from every one of these shapes still
 * fails: `co` falls back to `{}`, `clampScore(undefined)` is 0, and
 * `0 >= PASS_FLOOR` is false. Nothing here can turn "no data" into a pass.
 */
function scoreVerdictCategories(parsed) {
  const catsRaw = (parsed && typeof parsed === 'object') ? parsed.categories : undefined;
  const wrapper = (catsRaw && typeof catsRaw === 'object' && !Array.isArray(catsRaw)) ? catsRaw : null;
  // Present but the wrong type (string/array/number/boolean) — do NOT treat
  // this the same as "wrapper omitted"; disable root fallback entirely.
  const categoriesPresentButMalformed = catsRaw != null && !wrapper;
  const rootFallback = (!categoriesPresentButMalformed && parsed && typeof parsed === 'object')
    ? parsed : {};

  const hoisted = (parsed && typeof parsed === 'object') ? parsed.findings : undefined;
  const hoistedByCategory = (hoisted && typeof hoisted === 'object' && !Array.isArray(hoisted))
    ? hoisted : null;
  const hoistedGeneral = Array.isArray(hoisted)
    ? hoisted.map((x) => String(x)).filter(Boolean)
    : [];

  const categories = {};
  const findings = [];
  for (const key of CATEGORIES) {
    let c = (wrapper && wrapper[key] != null) ? wrapper[key]
      : (rootFallback[key] != null ? rootFallback[key] : undefined);

    // DIRECTION-OF-BOOLEAN REASONING (do not "fix" this by picking a
    // mapping): a model collapsing {score,pass,findings} to a bare boolean
    // could mean either of two things and there is no signal in the JSON to
    // tell them apart —
    //   (i)  it reused the category's own `pass` field    → true = GOOD
    //   (ii) it answered "is this defect/mark present?"   → true = BAD
    // Every one of these four keys names the THING BEING INSPECTED FOR
    // ("competitor_marks", "text_defects"), not "no_<thing>" or
    // "<thing>_ok" — in common LLM JSON idiom a bare boolean under a name
    // like that reads AT LEAST as plausibly as "defect present" (reading ii)
    // as it does as a stray `pass` echo (reading i), and those two readings
    // invert each other. Guessing (i) when the model meant (ii) turns a REAL
    // defect into a false pass on a money-facing gate — the single worst
    // outcome this fix could produce, worse than the over-strictness it is
    // fixing. Per the task's own instruction: when direction is genuinely
    // ambiguous, treat it as UNKNOWN and fail closed rather than guess a
    // pass. Concretely: both `true` and `false` are normalized to "no
    // parseable category data" (same as a category missing outright), so
    // the observed outcome is UNCHANGED from before this fix (both booleans
    // already failed, via `true.score === undefined` → clampScore → 0) —
    // what changes is that the failure is now INTENTIONAL, uniform across
    // all four categories (not just competitor_marks), and documented with
    // a finding instead of happening by accident of `||` coercion.
    let boolShapeNote = null;
    if (typeof c === 'boolean') {
      boolShapeNote = `${key} arrived as a bare boolean (${c}) instead of ` +
        '{score,findings} — direction is ambiguous (could mean "check passed" ' +
        'or "defect present"); treated as unparseable and failed rather than ' +
        'guessing a pass';
      c = undefined;
    }

    const co = (c && typeof c === 'object') ? c : {};
    const score = clampScore(co.score);
    let f = Array.isArray(co.findings)
      ? co.findings.map((x) => String(x)).filter(Boolean)
      : (co.findings ? [String(co.findings)] : []);
    if (hoistedByCategory && hoistedByCategory[key] != null) {
      const hf = Array.isArray(hoistedByCategory[key])
        ? hoistedByCategory[key].map((x) => String(x)).filter(Boolean)
        : [String(hoistedByCategory[key])];
      f = f.concat(hf);
    }
    if (boolShapeNote) f = [boolShapeNote, ...f];

    const pass = score >= PASS_FLOOR;
    categories[key] = { score, pass, findings: f };
    if (!pass) findings.push(...f.map((t) => `[${key}] ${t}`));
  }
  // Any category below floor fails overall. competitor_marks is primary in
  // the prompt; the floor gate treats all four uniformly so a text defect
  // cannot ship either.
  const pass = CATEGORIES.every((k) => categories[k].pass);
  // Unattributed hoisted findings are additional FAILURE context only —
  // never added on a passing verdict, and never able to flip one, since
  // `pass` above is already fixed by the per-category scores.
  if (!pass && hoistedGeneral.length) {
    findings.push(...hoistedGeneral.map((t) => `[general] ${t}`));
  }
  return { categories, pass, findings };
}

/**
 * Does `cand` look like it is TRYING to be a verdict object at all (as
 * opposed to an incidental balanced-brace span salvage picked up along the
 * way — an empty `{}`, a stray findings fragment, etc.)? Object `categories`
 * key, OR at least one of the four category names sitting on the root.
 */
function looksVerdictShaped(cand) {
  if (!cand || typeof cand !== 'object' || Array.isArray(cand)) return false;
  if (cand.categories && typeof cand.categories === 'object' && !Array.isArray(cand.categories)) return true;
  return CATEGORIES.some((k) => cand[k] != null);
}

/**
 * MONEY-SAFE candidate selection among everything salvageVerdictJson found.
 *
 * A vision reply that needs salvage in the first place is already off-script
 * (that's why AA9/AA10 exist), and a model that goes off-script can restate
 * the requested JSON shape as a trailing "example"/template, or draft an
 * answer and then revise it — both realistic Gemini-2.5-pro behaviours, not
 * theoretical. If more than one balanced span in the reply looks
 * verdict-shaped, there is no way to know FROM THE JSON ALONE which one is
 * "the real verdict" — exactly the same kind of genuine ambiguity the
 * bare-boolean case above resolves toward the safe side, not toward "prefer
 * whichever one is more convenient". So: evaluate every verdict-shaped
 * candidate with the exact same scoring rule real data gets
 * (scoreVerdictCategories), and if ANY of them independently fails, treat
 * the WHOLE salvage as a fail — a false FAIL only costs a wasted regeneration
 * (or an operator glance on video); a false PASS ships the defect this gate
 * exists to catch. Only when every verdict-shaped candidate agrees on a pass
 * is a pass allowed through salvage.
 *
 * This directly closes a real false-pass found in adversarial review: the
 * previous heuristic ("prefer the LAST candidate with an object `categories`
 * key") could pick a later, higher-scoring decorative/example object over an
 * earlier genuine failing verdict. Picking a FAILING candidate first, by
 * scanning ALL of them rather than trusting position, is immune to which one
 * came first or last.
 */
function pickSafestCandidate(candidates) {
  if (!candidates.length) return null;
  let bestFail = null;
  let bestPass = null;
  for (const cand of candidates) {
    if (!looksVerdictShaped(cand)) continue;
    const { pass } = scoreVerdictCategories(cand);
    if (!pass) { bestFail = cand; break; }
    if (!bestPass) bestPass = cand;
  }
  if (bestFail) return bestFail;
  if (bestPass) return bestPass;
  // Nothing looked verdict-shaped at all — fall back to the first parseable
  // object; scoreVerdictCategories will find no recognizable category data
  // in it and fail closed downstream, same as the pre-salvage "not JSON" path.
  return candidates[0];
}

/**
 * Normalize model JSON into a stable verdict shape. Pure — no I/O.
 *
 * TOLERANT OF SHAPE DRIFT, NEVER OF SUBSTANCE. A model reply that drifts
 * from the requested `{categories:{<key>:{score,pass,findings}}}` contract
 * must not silently fail-closed on pure noise (that burns the single
 * allowed static regeneration, or fails an already-paid video out of draft
 * — see this file's header) NOR silently invent a passing score (that ships
 * a real defect). See scoreVerdictCategories()'s header for the three
 * per-category shape drifts tolerated, and pickSafestCandidate()'s header
 * for how ambiguity between multiple salvaged candidates is resolved
 * (toward failure, never toward a guessed pass).
 *
 * `hadUnrecoverableSpan` (from salvageVerdictJson) forces the whole reply to
 * fail closed even when SOME span did parse: a truncated second JSON value,
 * or a balanced span that opens like a real JSON object and then fails to
 * parse (quote-tracking corruption, not decorative prose), is itself a sign
 * the reply is too corrupted to trust confidently, and the safe response to
 * "we don't know what the rest of this says" is the same fail-closed the
 * pre-salvage "not JSON" branch already used — never "trust whatever
 * happened to parse".
 */
function parseVerdict(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    const cleaned = String(raw).replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    try { parsed = JSON.parse(cleaned); }
    catch (err) {
      const { candidates, hadUnrecoverableSpan } = salvageVerdictJson(cleaned);
      const chosen = hadUnrecoverableSpan ? null : pickSafestCandidate(candidates);
      if (chosen && typeof chosen === 'object') {
        parsed = chosen;
      } else {
        return {
          pass: false,
          parseError: err.message,
          categories: emptyCategories('vision response was not JSON'),
          summary: 'parse failure — treating as QC fail (safe default)',
          findings: ['vision response was not JSON']
        };
      }
    }
  }

  const { categories, pass, findings } = scoreVerdictCategories(parsed);
  return {
    pass,
    categories,
    summary: String(parsed?.summary || (pass ? 'pass' : 'fail')).slice(0, 500),
    findings,
    parseError: null
  };
}

/**
 * Corrective operator note appended on the single allowed regeneration.
 * Names the invented marks / defects so the image model has an explicit
 * negative instruction (directImageRenderService operatorPrompt path).
 */
function buildCorrectiveNote(verdict) {
  const lines = ['VISION QC CORRECTION — previous render failed inspection. Fix ALL of the following:'];
  const cats = verdict?.categories || {};
  for (const key of CATEGORIES) {
    const c = cats[key];
    if (!c || c.pass) continue;
    const detail = (c.findings && c.findings.length) ? c.findings.join('; ') : 'failed score';
    lines.push(`- ${key}: ${detail}`);
  }
  if (verdict?.categories?.competitor_marks && !verdict.categories.competitor_marks.pass) {
    lines.push(
      '- CRITICAL: remove any competitor logo, emblem, tree mark, badge or wordmark ' +
      'that was not present on the original product photo. Do not invent brand marks on the product.'
    );
  }
  if (verdict?.categories?.text_defects && !verdict.categories.text_defects.pass) {
    lines.push(
      '- Do not print role labels (e.g. "RATING:") — only the value text. Fix every misspelling.'
    );
  }
  lines.push('Reproduce the original product faithfully. Ship only after these defects are gone.');
  return lines.join('\n');
}

function bufferToDataUrl(buffer, contentType = 'image/png') {
  if (!buffer) return null;
  if (typeof buffer === 'string' && /^https?:\/\//i.test(buffer)) return buffer;
  if (typeof buffer === 'string' && buffer.startsWith('data:')) return buffer;
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  return `data:${contentType};base64,${buf.toString('base64')}`;
}

/**
 * One vision call. Billable LLM — must go through chatCompletion so
 * trackLlmCall ledgers it (overlayZoneService.js:145 pattern).
 *
 * deps.chatCompletion injectable for the offline harness.
 */
async function judgeRender({
  originalProductUrl,
  renderUrl,
  brandName,
  safeBox,
  deliveryDims,
  expectedText,
  expectedTextUnknown = false,
  brandId = null,
  productId = null,
  adId = null,
  campaignId = null
}, deps = {}) {
  const chat = deps.chatCompletion || chatCompletion;
  const model = deps.model || resolveQcModel();
  const userContent = buildVisionUserContent({
    originalProductUrl,
    renderUrl,
    brandName,
    safeBox,
    deliveryDims,
    expectedText,
    expectedTextUnknown
  });

  // ── MONEY: billable vision LLM call ──────────────────────────────
  const res = await chat(
    {
      stage: 'ad_vision_qc',
      service: 'adVisionQcService',
      purposeTag: 'post_render_qc',
      visionImages: 2,
      brandId,
      productId,
      adId,
      campaignId
    },
    {
      model,
      messages: [{ role: 'user', content: userContent }],
      temperature: 0.0,
      // MONEY — this ceiling must cover REASONING tokens, not just the verdict.
      // gemini-2.5-pro is a thinking model: probed live 2026-08-05 against Atlas,
      // a trivial "reply {\"ok\":true}" prompt spent thoughtsTokenCount=147 to
      // emit 5 content tokens, and the SAME call with max_tokens=20 returned
      // HTTP 200 with EMPTY content. A real 2-image QC prompt reasons harder.
      // Empty content is not a soft failure here: it falls through to the
      // `if (!text)` branch below, which parses to zero-score categories and
      // therefore FAILS closed — burning the single allowed billable
      // gpt-image-2/edit regeneration on an infrastructure hiccup rather than a
      // real defect. Raised 1500 -> 5000 for generous headroom; this is FREE,
      // because max_tokens is a CEILING and billing is per token actually
      // GENERATED — an unused ceiling costs nothing. Owner call 2026-08-05:
      // "even 5k tokens is nothing", i.e. deliberately over-provisioned so a
      // hard-thinking verdict can never be truncated into a false failure.
      // Do not lower it without re-probing thoughtsTokenCount on real renders.
      //
      // Reasoning is likewise left at the model default ON PURPOSE. Probed
      // 2026-08-05: reasoning_effort barely moves it (216 -> 180 tokens at
      // 'minimal'; 'none' gave 191, i.e. no reliable effect) and
      // thinking_budget:0 is rejected HTTP 400 — 2.5-pro cannot stop thinking.
      // Even if it could, suppressing reasoning to save ~$0.0004 would trade
      // away accuracy on a fine-grained visual-discrimination task where a
      // false FAIL costs a ~$0.0717 regeneration and a false PASS ships the
      // exact defect this feature exists to catch.
      max_tokens: 5000,
      // json_object: safe across OpenAI + Gemini Atlas routes. Strict
      // json_schema 400s on Anthropic; validate in parseVerdict.
      response_format: { type: 'json_object' }
    }
  );

  const text = res?.choices?.[0]?.message?.content;
  if (!text) {
    return parseVerdict('{"categories":{},"summary":"empty vision response"}');
  }
  return parseVerdict(text);
}

/**
 * Shape persisted on Ad.visionQc (Mixed). Per-attempt: pass/fail, scores,
 * findings, discarded render URL, attempt number.
 *
 * `reason` is set when QC did not run (skipped) so operators can tell WHY —
 * e.g. "no original product URL", "vision call failed: …", "recovered without QC".
 * Null on real inspect-and-pass / inspect-and-fail verdicts.
 */
function buildPersistedVerdict({
  passed,
  attempts,
  finalAttempt,
  skipped = false,
  disabled = false,
  reason = null
}) {
  return {
    schemaVersion: 1,
    skipped: !!skipped,
    disabled: !!disabled,
    passed: !!passed,
    // WHY QC did not inspect (only meaningful when skipped). string|null.
    reason: reason == null ? null : String(reason).slice(0, 500),
    finalAttempt: finalAttempt || null,
    maxRegenerations: MAX_QC_REGENERATIONS,
    attempts: (attempts || []).map((a) => ({
      attempt: a.attempt,
      pass: !!a.pass,
      categories: a.categories || emptyCategories(),
      findings: a.findings || [],
      summary: a.summary || null,
      // Paid render URL for this attempt — kept even when discarded.
      renderUrl: a.renderUrl || null,
      discarded: !!a.discarded,
      discardedRenderUrl: a.discarded ? (a.renderUrl || null) : null,
      imageGeneration: a.imageGeneration || null
    }))
  };
}

/**
 * Verdict for an ad that SHIPPED WITHOUT being inspected.
 *
 * Distinct from `disabled` (the flag was off, so nobody expected QC) and from
 * a failed verdict (inspected, judged bad). This is "QC was supposed to run and
 * could not" — the state an operator must be able to tell apart from a pass,
 * because with the flag on, an absent Ad.visionQc field otherwise reads as
 * "fine". Every consumer that asks "was this inspected?" should check
 * `skipped === true`, not merely that visionQc exists.
 */
function buildSkippedVerdict(reason) {
  return buildPersistedVerdict({
    skipped: true,
    passed: false,
    finalAttempt: null,
    attempts: [],
    reason: String(reason || 'unknown')
  });
}

/**
 * Frontend origin for deep links — SAME resolution as renderService.js
 * (FRONTEND_URL, else first of FRONTEND_URLS). No new env var, no hardcoded domain.
 */
function resolveFrontendOrigin() {
  const single = (process.env.FRONTEND_URL || '').trim();
  if (single) return single.replace(/\/$/, '');
  const first = (process.env.FRONTEND_URLS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
  return first ? first.replace(/\/$/, '') : null;
}

/**
 * App deep link into the ads list filtered to this run/brand, when origin is known.
 * Frontend /ads accepts campaignRunId, campaignId, runBrandId.
 */
function buildAppPreviewUrl({ campaignRunId = null, campaignId = null, brandId = null } = {}) {
  const origin = resolveFrontendOrigin();
  if (!origin) return null;
  if (!campaignRunId && !campaignId && !brandId) return null;
  try {
    const u = new URL(`${origin}/ads`);
    if (campaignRunId) u.searchParams.set('campaignRunId', String(campaignRunId));
    if (campaignId) u.searchParams.set('campaignId', String(campaignId));
    if (brandId) u.searchParams.set('runBrandId', String(brandId));
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Verbose per-decision log + fire-and-forget Slack echo on FAIL only.
 *
 * Owner asked for reporting that is "verbose and echoed to Slack." Verbose
 * lives in the console logs (every verdict, full per-category breakdown) —
 * free and unbounded. Slack is reserved for ACTIONABLE volume:
 *   - FAIL → per-ad warn via notifyAsync (rare; keep per-ad key so individual
 *     failures are not collapsed by alertService's 15-min dedupe)
 *   - PASS → NO individual Slack message. The live pass path already posts
 *     detail to the run feed (noteQcPassToRunFeed) which is built for that
 *     volume. Echoing every pass at warn would re-flood ALERT_RATE_LIMIT_MAX
 *     and starve other warn alerts — the exact scale reason the pre-existing
 *     code moved accepts off alertService.
 *
 * MONEY PATH: never await the Slack call; never let it throw into render.
 * Uses notifyAsync (not notify) for exactly that reason — a paid image
 * generation has already been billed by the time we are here.
 *
 * Run-level aggregate Slack summary (one message per generation run) is the
 * right place for pass counts — but this module has no clean run-completion
 * hook. That belongs at runFeed.finishRun / routes/ads.js when the
 * CampaignRun settles. Do not invent a hook from here.
 */
function reportQcVerdict({
  adId = null,
  attempt = null,
  verdict = null,
  willRegenerate = false,
  terminal = false
} = {}) {
  const pass = !!verdict?.pass;
  const cats = verdict?.categories || {};
  const scoreParts = CATEGORIES.map((k) => {
    const c = cats[k];
    return `${k}=${c ? c.score : '?'}${c && !c.pass ? '!' : ''}`;
  });
  const failing = CATEGORIES
    .filter((k) => cats[k] && !cats[k].pass)
    .map((k) => {
      const c = cats[k];
      const why = (c.findings && c.findings.length) ? c.findings.join('; ') : 'low score';
      return `${k}(${c.score}): ${why}`;
    });

  const regenNote = willRegenerate
    ? ' → regenerating once'
    : (terminal && !pass ? ' → terminal fail (no further regen)' : '');

  // VERBOSE on every verdict (pass AND fail) — this is where "verbose"
  // genuinely lives. Console is free; Slack is not.
  console.log(
    `   🔍 adVisionQc: ad=${adId || '-'} attempt=${attempt ?? '?'} ` +
    `${pass ? 'PASS' : 'FAIL'} floor=${PASS_FLOOR} ` +
    `[${scoreParts.join(' ')}]${regenNote}` +
    (verdict?.summary ? ` summary=${verdict.summary}` : '')
  );
  if (failing.length) {
    console.log(`   🔍 adVisionQc: failing → ${failing.join(' | ')}`);
  }

  // Slack per-ad on FAIL only. Passes stay off alertService (run feed only).
  if (pass) return;

  try {
    const alerts = require('./alertService');
    // notifyAsync — DO NOT await. Paid path; Slack latency/failure must not
    // block or fail the render.
    alerts.notifyAsync({
      // warn (not info): default ALERT_MIN_LEVEL is warn, so info never
      // delivers. warn (not fatal/error here): creative defect is verbose
      // telemetry, not a crash — terminal fail still escalates via
      // alertQcFailure (error) on the caller path.
      level: 'warn',
      title: willRegenerate
        ? 'Vision QC fail — regenerating once'
        : 'Vision QC fail',
      // Per-ad key so individual failures are not deduped away across ads.
      key: `ad-vision-qc:verdict:${adId || 'unknown'}`,
      fields: {
        ad: String(adId || '-'),
        attempt: String(attempt ?? '-'),
        pass: 'no',
        regenerate: willRegenerate ? 'yes' : 'no',
        terminal: terminal ? 'yes' : 'no',
        scores: scoreParts.join(' ').slice(0, 200),
        failing: (failing.join(' | ') || '-').slice(0, 200)
      },
      detail: failing.length
        ? failing.join('\n').slice(0, 1500)
        : (verdict?.summary || 'fail')
    });
  } catch (err) {
    console.warn(`   ⚠️  adVisionQc: verdict Slack echo failed: ${err && err.message}`);
  }
}

/**
 * MONEY-CRITICAL control flow.
 *
 * generate({ attempt, correctiveNote }) → {
 *   buffer, contentType?, width?, height?, imageGeneration?, intentResolution?, ...
 * }
 *   Called for attempt 1 (always) and attempt 2 (only if attempt 1 QC fails).
 *   Each call that reaches the image model is billable — the harness counts these.
 *
 * uploadAttempt({ buffer, attempt, contentType }) → url (optional)
 *   Persist paid pixels so a discarded attempt is not thrown away.
 *
 * judgeFn — injectable; production uses judgeRender.
 *
 * HARD BOUND: regenerations never exceed MAX_QC_REGENERATIONS (1).
 * A second QC failure does NOT call generate a third time.
 *
 * `enabled`:
 *   - boolean → used as-is (callers that already resolved the flag)
 *   - undefined → await resolveEnabled() (SystemConfig → env → false)
 */
async function runPostRenderQc({
  enabled,
  originalProductUrl,
  brandName,
  safeBox,
  deliveryDims,
  expectedText,
  expectedTextUnknown = false,
  brandId = null,
  productId = null,
  adId = null,
  campaignId = null,
  generate,
  uploadAttempt = null,
  judgeFn = null,
  // Test-only: callers cannot raise the production bound above MAX.
  _maxRegenerations = MAX_QC_REGENERATIONS
} = {}) {
  if (typeof generate !== 'function') {
    throw new Error('adVisionQc.runPostRenderQc: generate() required');
  }

  // Resolve the gate once per run. Explicit boolean wins; otherwise the
  // async SystemConfig → env → false cascade. Never throws.
  const qcEnabled = (typeof enabled === 'boolean')
    ? enabled
    : await resolveEnabled();

  // ── MONEY: clamp any attempt to raise the retry bound ────────────
  const maxRegen = Math.min(
    MAX_QC_REGENERATIONS,
    Math.max(0, Number.isFinite(_maxRegenerations) ? Number(_maxRegenerations) : MAX_QC_REGENERATIONS)
  );

  // ── Flag off: one generation, zero vision, zero regeneration ──
  // Do NOT claim passed:true — nothing was inspected. Callers that only
  // check `.passed` would otherwise treat an uninspected plate as clean.
  // Live production short-circuits earlier (isEnabled check in the render
  // service) so this shape is for harnesses and any future direct caller.
  if (!qcEnabled) {
    console.log(
      `   🔍 adVisionQc: ad=${adId || '-'} gate=OFF — skip vision, one generation, zero regen`
    );
    const output = await generate({ attempt: 1, correctiveNote: null });
    return {
      ok: true,
      skipped: true,
      output,
      visionQc: buildPersistedVerdict({
        passed: false,
        skipped: true,
        disabled: true,
        reason: 'AD_VISION_QC_ENABLED=false',
        finalAttempt: 1,
        attempts: []
      }),
      generationCount: 1,
      regenerationCount: 0,
      visionCallCount: 0
    };
  }

  if (!originalProductUrl) {
    throw new Error('adVisionQc: originalProductUrl required when QC is enabled');
  }

  const judge = judgeFn || ((args) => judgeRender(args));
  const attempts = [];
  let output = null;
  let correctiveNote = null;
  let generationCount = 0;
  let regenerationCount = 0;
  let visionCallCount = 0;

  // attempt 1 = first render; attempt 2 = the single allowed regen (if any)
  const maxAttempts = 1 + maxRegen;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // ── MONEY: billable image path ─────────────────────────────────
    // generate() is the image submit (or a return of an already-paid first
    // render). This loop body runs at most (1 + MAX_QC_REGENERATIONS) times.
    output = await generate({ attempt, correctiveNote });
    generationCount += 1;
    if (attempt > 1) regenerationCount += 1;

    // Prefer an already-hosted URL; else data-URL the buffer for vision.
    let renderUrl = output.renderUrl || null;
    if (!renderUrl && output.buffer) {
      renderUrl = bufferToDataUrl(output.buffer, output.contentType || 'image/png');
    }
    if (!renderUrl) {
      throw new Error(`adVisionQc: generate() attempt ${attempt} returned no renderUrl/buffer`);
    }

    // Persist paid pixels for this attempt when an uploader is provided.
    // Failed/discarded attempts MUST keep a durable URL (owner requirement).
    let persistedUrl = output.renderUrl || null;
    if (typeof uploadAttempt === 'function' && output.buffer) {
      try {
        const up = await uploadAttempt({
          buffer: output.buffer,
          attempt,
          contentType: output.contentType || 'image/png',
          width: output.width,
          height: output.height
        });
        if (up) persistedUrl = up;
      } catch (err) {
        console.warn(`   ⚠️  adVisionQc: uploadAttempt(${attempt}) failed: ${err.message}`);
      }
    }

    const visionRenderUrl = persistedUrl || renderUrl;
    // ── MONEY: billable vision LLM call ────────────────────────────
    //
    // THROW vs GARBLED VERDICT — deliberate distinction (money + fidelity):
    //   • A returned-but-garbled / empty / non-JSON verdict is still a
    //     "the model looked" outcome. parseVerdict fails CLOSED (zero scores)
    //     and that DOES consume the single allowed regeneration — the image
    //     may be bad and we get one corrective retry.
    //   • A THROW (Atlas hiccup, timeout, network) means the model never
    //     looked. That is infrastructure failure, NOT evidence the plate is
    //     bad. Burning a ~$0.07 regeneration on it would be a pure waste, and
    //     throwing out of this function would abort the render so the already-
    //     paid plate is later recovered with no verdict at all. Convert the
    //     throw into a skipped/uninspected outcome, keep the paid output, and
    //     do NOT regenerate.
    let verdict;
    try {
      verdict = await judge({
        originalProductUrl,
        renderUrl: visionRenderUrl,
        brandName,
        safeBox,
        deliveryDims,
        expectedText,
        expectedTextUnknown,
        brandId,
        productId,
        adId,
        campaignId
      });
    } catch (err) {
      const msg = (err && err.message) ? err.message : String(err || 'unknown');
      console.warn(
        `   ⚠️  adVisionQc: vision call threw on attempt ${attempt} — ` +
        `shipping paid plate uninspected (no regeneration): ${msg}`
      );
      // Do NOT increment visionCallCount — the call did not complete.
      // Do NOT call generate() again — regeneration budget is for bad images.
      return {
        ok: true,
        skipped: true,
        uninspected: true,
        output: { ...output, renderUrl: persistedUrl || output.renderUrl || null },
        visionQc: buildSkippedVerdict(`vision call failed: ${msg}`),
        generationCount,
        regenerationCount,
        visionCallCount
      };
    }
    visionCallCount += 1;

    attempts.push({
      attempt,
      pass: !!verdict.pass,
      categories: verdict.categories,
      findings: verdict.findings || [],
      summary: verdict.summary,
      renderUrl: persistedUrl || null,
      discarded: false,
      imageGeneration: output.imageGeneration || null
    });

    if (verdict.pass) {
      // Mark prior attempts discarded (they were paid for and kept).
      for (let i = 0; i < attempts.length - 1; i++) {
        attempts[i].discarded = true;
      }
      reportQcVerdict({
        adId,
        attempt,
        verdict,
        willRegenerate: false,
        terminal: true
      });
      return {
        ok: true,
        skipped: false,
        output: { ...output, renderUrl: persistedUrl || output.renderUrl || null },
        visionQc: buildPersistedVerdict({
          passed: true,
          finalAttempt: attempt,
          attempts
        }),
        generationCount,
        regenerationCount,
        visionCallCount
      };
    }

    // Failed this attempt.
    if (attempt >= maxAttempts) {
      // Second failure (or first if maxRegen=0): STOP. No further generate().
      reportQcVerdict({
        adId,
        attempt,
        verdict,
        willRegenerate: false,
        terminal: true
      });
      break;
    }

    // Prepare the single allowed regeneration.
    correctiveNote = buildCorrectiveNote(verdict);
    attempts[attempts.length - 1].discarded = true;
    reportQcVerdict({
      adId,
      attempt,
      verdict,
      willRegenerate: true,
      terminal: false
    });
    console.warn(
      `   ⚠️  adVisionQc: attempt ${attempt} FAILED — ` +
      `regenerating once (${regenerationCount + 1}/${maxRegen}). ` +
      `summary=${verdict.summary}`
    );
  }

  // Double (or single-with-no-regen) failure — never call generate again.
  return {
    ok: false,
    skipped: false,
    output,
    visionQc: buildPersistedVerdict({
      passed: false,
      finalAttempt: attempts.length ? attempts[attempts.length - 1].attempt : null,
      attempts
    }),
    generationCount,
    regenerationCount,
    visionCallCount
  };
}

// ── VIDEO post-render vision QC ─────────────────────────────────────────
// See the file header CONTRACT block for the full static-vs-video
// comparison. Summary: same 4 category keys (so Ad.visionQc /
// summarizeVisionQc / the gallery UI are unchanged), same model, same
// PASS_FLOOR — but ONE vision call over [seed, frame1..frameN] instead of
// [seed, render], and NO regeneration loop.

/**
 * Build the multimodal user content for VIDEO QC: labelled text + ONE seed
 * image + N frames SAMPLED from the delivered video (services/
 * videoFrameService.buildFrameUrls — Cloudinary `so_<sec>` edge transform,
 * no ffmpeg/local decode). Image order is fixed: [0]=ORIGINAL PRODUCT,
 * [1..N]=VIDEO FRAMES in ascending timestamp order.
 *
 * `frames`: [{ timestampSec, url }] — see videoFrameService.buildFrameUrls.
 *
 * Category rubric differences from buildVisionUserContent (static), all
 * driven by what a video ad actually is:
 *   - competitor_marks / product_fidelity: same meaning as static. This
 *     pair is what catches a hallucinated colourway (product_fidelity) or
 *     an invented/foreign brand mark (competitor_marks) — the two real
 *     defects this function exists to catch (see PR description). Scored
 *     against the WORST frame, not the average — a generative video model
 *     can drift color mid-clip even when frame 1 is correct.
 *   - text_defects: narrowed to text/lettering that is part of the PRODUCT
 *     ITSELF (woven labels, hang tags, embossed logos) across the sampled
 *     frames. The ad's own burned-in caption/headline/CTA/rating overlay is
 *     explicitly OUT OF SCOPE — that overlay has its own in-flight QA track
 *     (Reels truncation / rating stray-character fixes) and this function
 *     has no expected-copy contract to check it against without duplicating
 *     that work.
 *   - layout_safe_box: repurposed as framing/visibility (no fixed safe-box
 *     geometry is available at this call site, unlike the static path's
 *     safeBoxInDeliveredPx) — is the product's branding area in-frame, and
 *     does the caption overlay ever fully obscure the product.
 */
function buildVideoVisionUserContent({ originalProductUrl, frames, brandName }) {
  if (!originalProductUrl) throw new Error('adVisionQc: originalProductUrl required');
  if (!Array.isArray(frames) || !frames.length) throw new Error('adVisionQc: frames required');

  const brand = brandName || 'the advertiser';
  const frameList = frames
    .map((f) => `  - t=${Number(f.timestampSec).toFixed(1)}s`)
    .join('\n');

  const prompt = `You are a post-render quality inspector for direct-response VIDEO product ads.

You are given ${frames.length + 1} images in this exact order:
  IMAGE 1 — ORIGINAL PRODUCT PHOTO (the source/hero reference the video was generated from)
  IMAGE 2-${frames.length + 1} — FRAMES SAMPLED FROM THE DELIVERED VIDEO, in this order:
${frameList}

Treat the sampled frames as evidence about the WHOLE clip, not independent
ads: if a defect appears in ANY ONE frame, the category fails for the video.

Brand name: ${brand}

Score EACH category 0-10 (integer) and list concrete findings, citing which
frame(s) (by timestamp) show the problem. Return ONLY JSON.

CATEGORIES

1. competitor_marks (PRIMARY)
   Logos, wordmarks, emblems, badges, tree/animal/crest marks, or other brand
   devices present ON THE PRODUCT in any sampled frame that are ABSENT from
   the product in IMAGE 1, OR that belong to a DIFFERENT brand than ${brand}.
   IMPORTANT: ${brand}'s OWN logo composited into a corner as ad chrome is
   EXPECTED and must NOT be flagged. Only invent marks on the product surface
   (hardware, woven labels, hang tags) that were not on the original product.

2. product_fidelity (PRIMARY)
   Silhouette, COLOURWAY, materials, panel/pocket count, orientation, and
   construction drift from IMAGE 1, checked against EVERY sampled frame. A
   generative video model can drift the product's colour or shape partway
   through a clip even when the opening frame is correct -- score the WORST
   frame, not the average. Scene/background/model/lighting change is fine;
   product identity or colour drift is not.

3. text_defects (product-intrinsic only -- NOT the ad's caption overlay)
   Misspelled, mangled, gibberish, or nonsensical text/lettering that is part
   of the PRODUCT ITSELF or the scene (woven labels, hang tags, embossed or
   debossed logos, packaging). Do NOT score the ad's own burned-in caption,
   headline, CTA button, or star-rating overlay -- that overlay is inspected
   by a separate system and is explicitly OUT OF SCOPE for this category.

4. layout_safe_box (framing/visibility -- no fixed geometry supplied)
   Is the product's key branding area (where a hang tag, woven label, or
   logo would sit) fully in-frame and not clipped by the video's crop in the
   sampled frames? Does the caption/logo overlay ever fully obscure the
   product in a sampled frame? Flag only real visibility problems, not
   ordinary cinematic framing choices (close-ups, pans).

JSON SHAPE (no prose outside it):
{
  "categories": {
    "competitor_marks": { "score": 0, "pass": true, "findings": ["..."] },
    "product_fidelity": { "score": 0, "pass": true, "findings": ["..."] },
    "text_defects":     { "score": 0, "pass": true, "findings": ["..."] },
    "layout_safe_box":  { "score": 0, "pass": true, "findings": ["..."] }
  },
  "summary": "one-line overall"
}`;

  const content = [
    { type: 'text', text: prompt },
    { type: 'text', text: 'IMAGE 1 — ORIGINAL PRODUCT PHOTO:' },
    { type: 'image_url', image_url: { url: originalProductUrl } }
  ];
  frames.forEach((f, i) => {
    content.push({ type: 'text', text: `IMAGE ${i + 2} — VIDEO FRAME @ t=${Number(f.timestampSec).toFixed(1)}s:` });
    content.push({ type: 'image_url', image_url: { url: f.url } });
  });
  return content;
}

/**
 * One vision call over the seed product photo + N sampled video frames.
 * Billable LLM — must go through chatCompletion so trackLlmCall ledgers it
 * (same money discipline as judgeRender).
 *
 * deps.chatCompletion / deps.model injectable for the offline harness.
 */
async function judgeVideoRender({
  originalProductUrl,
  frames,
  brandName,
  brandId = null,
  productId = null,
  adId = null,
  campaignId = null
}, deps = {}) {
  const chat = deps.chatCompletion || chatCompletion;
  const model = deps.model || resolveQcModel();
  const userContent = buildVideoVisionUserContent({ originalProductUrl, frames, brandName });

  // ── MONEY: billable vision LLM call ──────────────────────────────
  const res = await chat(
    {
      stage: 'ad_video_vision_qc',
      service: 'adVisionQcService',
      purposeTag: 'post_render_video_qc',
      visionImages: frames.length + 1,
      brandId,
      productId,
      adId,
      campaignId
    },
    {
      model,
      messages: [{ role: 'user', content: userContent }],
      temperature: 0.0,
      // Same reasoning as judgeRender's max_tokens comment (2026-08-05 probe):
      // a thinking model needs headroom that covers REASONING tokens, not
      // just the verdict, and an unused ceiling costs nothing. Raised over
      // judgeRender's 5000 because this call reasons over MORE images (seed +
      // up to ~5 frames vs 2) — do not lower without re-probing on real video
      // QC calls.
      max_tokens: 6000,
      response_format: { type: 'json_object' }
    }
  );

  const text = res?.choices?.[0]?.message?.content;
  if (!text) {
    return parseVerdict('{"categories":{},"summary":"empty vision response"}');
  }
  return parseVerdict(text);
}

/**
 * MONEY-AWARE control flow for VIDEO post-render QC. Deliberately much
 * simpler than runPostRenderQc (static): ONE inspection, NEVER a
 * regeneration, and NEVER a caller-facing failure signal.
 *
 * WHY NO REGENERATION (unlike static's MAX_QC_REGENERATIONS=1):
 *   - A static regen costs ~$0.0717 and a corrective prompt can plausibly
 *     fix an invented mark on the NEXT gpt-image-2/edit call.
 *   - A video master costs ~$0.90 (12x) and the defect classes this
 *     function exists to catch (hallucinated colourway, garbled on-product
 *     branding) are generated by the video model INTO the clip over its
 *     full duration — there is no cheap "fix this one thing" corrective
 *     prompt equivalent, and a second $0.90 submit on the same seed is not
 *     a reliable fix. Regenerating here would be spending real money on a
 *     coin flip. See PR description "cost note" for the full framing.
 *
 * WHY `ok` IS ALWAYS TRUE (this function never signals "fail the ad"):
 *   - The master is ALREADY PAID FOR by the time this runs (post-upload).
 *     Discarding it (the static path's failure behaviour: throw, caller
 *     marks the ad 'failed') would waste the ~$0.90 spend AND still not
 *     un-bake the defect on a retry.
 *   - Deliberate owner-facing choice: FLAG, DON'T DISCARD. This function
 *     stamps a failed verdict (`visionQc.passed === false`) and the caller
 *     (brandScriptExecutor.uploadRenderAndStamp) ships the ad as a normal
 *     draft — status is NOT forced to 'failed' — so an operator sees the
 *     FAIL badge via the existing summarizeVisionQc surfacing (gallery list
 *     / detail modal / run poller, PR #236) and can decide not to send that
 *     specific ad to a platform, instead of the asset silently vanishing.
 *   - alertQcFailure below still fires at 'error' level so the failure is
 *     loud in Slack even though it is not fatal to the render.
 */
async function runVideoPostRenderQc({
  enabled,
  originalProductUrl,
  frames,
  brandName,
  brandId = null,
  productId = null,
  adId = null,
  campaignId = null,
  deliveredUrl = null,
  judgeFn = null
} = {}) {
  const qcEnabled = (typeof enabled === 'boolean') ? enabled : await resolveEnabled();

  // ── Flag off: nothing inspected, nothing claimed ──────────────────
  if (!qcEnabled) {
    return {
      ok: true,
      skipped: true,
      visionQc: buildPersistedVerdict({
        passed: false,
        skipped: true,
        disabled: true,
        reason: 'AD_VISION_QC_ENABLED=false',
        finalAttempt: null,
        attempts: []
      })
    };
  }

  if (!originalProductUrl) {
    return { ok: true, skipped: true, visionQc: buildSkippedVerdict('no original product URL') };
  }
  if (!Array.isArray(frames) || !frames.length) {
    return {
      ok: true,
      skipped: true,
      visionQc: buildSkippedVerdict('no frames could be sampled from the delivered video')
    };
  }

  const judge = judgeFn || ((args) => judgeVideoRender(args));

  // THROW vs GARBLED VERDICT — same distinction runPostRenderQc draws: a
  // throw means the model never looked (infrastructure), not evidence the
  // video is bad. Ship uninspected rather than stamp a false fail.
  let verdict;
  try {
    verdict = await judge({
      originalProductUrl, frames, brandName, brandId, productId, adId, campaignId
    });
  } catch (err) {
    const msg = (err && err.message) ? err.message : String(err || 'unknown');
    console.warn(
      `   ⚠️  adVisionQc(video): vision call threw — shipping paid master uninspected: ${msg}`
    );
    return {
      ok: true,
      skipped: true,
      uninspected: true,
      visionQc: buildSkippedVerdict(`vision call failed: ${msg}`)
    };
  }

  reportQcVerdict({ adId, attempt: 1, verdict, willRegenerate: false, terminal: true });

  const attempts = [{
    attempt: 1,
    pass: !!verdict.pass,
    categories: verdict.categories,
    findings: verdict.findings || [],
    summary: verdict.summary,
    renderUrl: deliveredUrl || null,
    discarded: false
  }];

  return {
    ok: true, // ALWAYS true — see docstring. Never signals "fail the ad".
    skipped: false,
    passed: !!verdict.pass,
    visionQc: buildPersistedVerdict({
      passed: !!verdict.pass,
      finalAttempt: 1,
      attempts
    })
  };
}

/**
 * Full per-attempt breakdown (all four category scores + findings + the
 * discarded/kept render URL for every attempt) — this IS "the verbose LLM
 * response": every category the model scored, not just the failing ones.
 * Shared by both the accept and reject alerts so an operator sees the same
 * shape either way. Slack's own size limit (buildMessage) does the final
 * clip; this only bounds a single call from producing a pathological detail
 * block (e.g. thousands of findings).
 *
 * Rendered as PLAIN TEXT, not JSON. The model already answers in plain
 * language ("invented a tree emblem on the midfoot panel") — the prompt asks
 * for per-category `findings` strings — and a raw JSON.stringify buried that
 * prose in braces and quotes. An operator triaging a failed ad in Slack wants
 * to read WHY it failed, not parse it. Every value the JSON form carried is
 * still here: per-category score, pass/fail, every finding, and each attempt's
 * kept/discarded render URL.
 */
function renderCategoryBlock(categories) {
  const lines = [];
  for (const key of CATEGORIES) {
    const c = (categories || {})[key];
    if (!c) continue;
    const mark = c.pass ? 'ok  ' : 'FAIL';
    lines.push(`  ${mark} ${key.padEnd(17)} ${String(c.score ?? '?').padStart(2)}/10`);
    // findings is normalised to an array by parseVerdict, but this also renders
    // verdicts read back from Ad.visionQc — a Mixed field, so an older or
    // hand-edited doc can carry a bare string or a number. Iterating that
    // directly threw ("number 42 is not iterable") and, because both alert
    // helpers wrap this in try/catch, the failure mode was a SILENTLY DROPPED
    // Slack message on exactly the ad someone needed to see.
    const raw = c.findings;
    const findings = Array.isArray(raw) ? raw : (raw == null || raw === '' ? [] : [raw]);
    for (const f of findings) lines.push(`         - ${String(f)}`);
  }
  return lines;
}

function buildQcSlackDetail(visionQc, { appUrl = null } = {}) {
  const attempts = visionQc?.attempts || [];
  const last = attempts[attempts.length - 1];
  const out = [];

  if (visionQc?.skipped) {
    out.push('VERDICT: SKIPPED (uninspected)');
    if (visionQc.reason) out.push(`reason: ${visionQc.reason}`);
  } else {
    out.push(visionQc?.passed ? 'VERDICT: PASS' : 'VERDICT: FAIL');
  }
  if (last?.summary) out.push(String(last.summary));
  out.push('');

  // Decisive attempt first — the scores that actually determined the outcome.
  if (last?.categories) {
    out.push(`final attempt ${last.attempt ?? '?'} of ${attempts.length}:`);
    out.push(...renderCategoryBlock(last.categories));
  }

  // Then the trail, so a regeneration's before/after is visible.
  if (attempts.length > 1) {
    out.push('');
    out.push('attempts:');
    for (const a of attempts) {
      out.push(
        `  ${a.attempt}  ${a.pass ? 'PASS' : 'FAIL'}  ` +
        `${a.discarded ? 'discarded' : 'kept     '}  ${a.renderUrl || '-'}`
      );
      if (!a.pass && a !== last) {
        for (const line of renderCategoryBlock(a.categories)) out.push(`  ${line}`);
      }
    }
  } else if (last?.renderUrl) {
    out.push('');
    // Cloudinary (or durable host) URL — Slack unfurls this inline.
    out.push(`preview: ${last.renderUrl}`);
  }

  // App deep link when the caller resolved one (FRONTEND_URL / FRONTEND_URLS).
  const deep = appUrl || visionQc?.appUrl || null;
  if (deep) {
    out.push(`app: ${deep}`);
  }

  return out.join('\n').slice(0, 2500);
}

/**
 * Title for a terminal QC failure. Reflects whether a billable regeneration
 * actually ran — recovery never regenerates, so a hard-coded "after one
 * regeneration" title would lie about ~$0.07 that never spent.
 *
 * regenerated: explicit override (recovery passes false).
 * Otherwise inferred from finalAttempt / attempts length > 1.
 *
 * mediaLabel: 'Static ad' (default, back-compat) or 'Video ad' — video never
 * regenerates (runVideoPostRenderQc), so its title collapses to a single
 * "no regeneration" form regardless of `regenerated`.
 */
function qcFailureTitle(visionQc, { regenerated = null, mediaLabel = 'Static ad' } = {}) {
  if (mediaLabel !== 'Static ad') {
    return `${mediaLabel} failed vision QC`;
  }
  const attempts = visionQc?.attempts || [];
  const finalAttempt = Number(visionQc?.finalAttempt) || attempts.length || 0;
  const didRegen = regenerated == null
    ? (finalAttempt > 1 || attempts.length > 1)
    : !!regenerated;
  return didRegen
    ? 'Static ad failed vision QC after one regeneration'
    : 'Static ad failed vision QC (no regeneration)';
}

/**
 * Compact, API-facing summary of a persisted Ad.visionQc verdict — the
 * shared subset for GET /api/ads (list), GET /api/ads/:id (detail), and the
 * run-level rollup on GET /api/ads/runs/:runId. Distinct from
 * buildQcSlackDetail (Slack's plain-text wall) and from the
 * generation-inspector's raw Ad.visionQc (every attempt, every discarded
 * render URL, raw imageGeneration payloads) — those stay screen-specific.
 * This is the "is this ad's creative trustworthy, and why" answer an
 * operator needs on a gallery card or detail modal WITHOUT a second trip to
 * the inspector.
 *
 * `inspected` is the one field every caller should gate on: a visionQc that
 * is `skipped` or `disabled` still returns a summary object (so a badge can
 * say "not inspected" instead of rendering nothing), but `passed` on those
 * is always false and must never be read as "this shipped clean."
 *
 * @param {object|null} visionQc — Ad.visionQc, exactly as persisted.
 * @param {object} [opts]
 * @param {boolean} [opts.categories=false] — include the final attempt's
 *   per-category {score, pass, findings} (findings capped at 3/category —
 *   enough to tell an operator WHY without shipping every attempt's full
 *   findings list, which is what makes the inspector's payload heavy) AND
 *   `failureDetail` (the exact Slack `detail` text, capped at 2500 chars,
 *   present only on a real failure — see alertQcFailure). Callers building
 *   a compact list/badge should omit this; the detail modal should pass true.
 * @returns {object|null} null only when visionQc itself is null/undefined
 *   (ad never reached the QC gate at all, e.g. pre-QC historical ads).
 */
function summarizeVisionQc(visionQc, { categories = false } = {}) {
  if (visionQc == null) return null;
  const attempts = Array.isArray(visionQc.attempts) ? visionQc.attempts : [];
  const last = attempts[attempts.length - 1] || null;
  const finalAttempt = Number(visionQc.finalAttempt) || attempts.length || 0;
  const out = {
    // Did a real vision-model verdict happen at all? False for both
    // `skipped` (flag on, QC failed to run — see buildSkippedVerdict) and
    // `disabled` (flag off, nobody expected it) — an operator scanning a
    // gallery needs "was this looked at", not just "did it pass".
    inspected:    !visionQc.skipped && !visionQc.disabled,
    passed:       !!visionQc.passed,
    skipped:      !!visionQc.skipped,
    disabled:     !!visionQc.disabled,
    reason:       visionQc.reason || null,
    finalAttempt: finalAttempt || null,
    // True when the single allowed regeneration actually ran (QC'd on
    // retry) — same inference qcFailureTitle uses for the Slack title.
    regenerated:  finalAttempt > 1 || attempts.length > 1,
    summary:      last?.summary || null
  };
  if (categories) {
    if (last?.categories) {
      out.categories = CATEGORIES.reduce((acc, key) => {
        const c = last.categories[key];
        if (!c) return acc;
        const findings = Array.isArray(c.findings) ? c.findings : (c.findings ? [c.findings] : []);
        acc[key] = {
          score:    c.score ?? null,
          pass:     !!c.pass,
          findings: findings.slice(0, 3).map((f) => String(f))
        };
        return acc;
      }, {});
    }
    // The EXACT text alertQcFailure sent to Slack for this verdict —
    // buildQcSlackDetail's output, stamped onto Ad.visionQc.failureDetail at
    // the moment the alert fired (see alertQcFailure's docstring + the three
    // call sites that capture its return value). NOT re-derived here: this
    // is a straight passthrough of already-persisted text so the detail
    // screen can never say something different from what Slack already
    // said. Absent on a passed/skipped/disabled verdict — those never stamp
    // this field in the first place.
    if (visionQc.failureDetail) {
      out.failureDetail = String(visionQc.failureDetail).slice(0, 2500);
    }
  }
  return out;
}

/**
 * Slack + log helper for terminal QC failure ("rejection"). Fire-and-forget.
 *
 * @param {boolean|null} [regenerated] — when known, overrides attempt-count
 *   inference for the alert title (recovery always passes false).
 * @returns {string|null} the EXACT text this call sent to Slack as `detail`
 *   (buildQcSlackDetail's output) — or null if the alert itself threw before
 *   that text was built. Owner requirement 2026-08-20: an ad's detail screen
 *   must show the same reason Slack got, not a second derivation. Callers
 *   that persist a QC failure onto Ad.visionQc should capture this return
 *   value and stamp it onto `visionQc.failureDetail` (see the three call
 *   sites: directImageRenderService.js, brandScriptExecutor.js,
 *   imageRecoveryService.js) — that is the ONLY place this prose is built;
 *   nothing else may re-format a verdict into words.
 */
function alertQcFailure({ adId, brandId, productId, visionQc, brandName, appUrl = null, regenerated = null, mediaLabel = 'Static ad' } = {}) {
  try {
    const alerts = require('./alertService');
    const last = (visionQc?.attempts || [])[(visionQc?.attempts || []).length - 1];
    const findings = (last?.findings || []).slice(0, 6).join(' | ')
      || (visionQc?.attempts || []).map((a) => a.summary).filter(Boolean).join(' → ')
      || 'no findings';
    const attempts = visionQc?.attempts || [];
    const finalAttempt = Number(visionQc?.finalAttempt) || attempts.length || 0;
    const didRegen = regenerated == null
      ? (finalAttempt > 1 || attempts.length > 1)
      : !!regenerated;
    const detail = buildQcSlackDetail(visionQc, { appUrl });
    alerts.notifyAsync({
      level: 'error',
      title: qcFailureTitle(visionQc, { regenerated, mediaLabel }),
      // Keyed per-ad, not a fixed literal: alertService's notify() dedupes
      // by this key within a 15-minute window (ALERT_DEDUPE_WINDOW_MIN) and
      // folds anything suppressed into a generic "+N more (suppressed)"
      // bump on the NEXT delivery — with no verbose detail carried over.
      // A shared key across every ad would mean only the first rejection
      // in any 15-minute window actually reaches Slack with its findings;
      // every other ad's failure that window is silently swallowed. Per-ad
      // still collapses a genuine double-fire of the SAME ad's alert.
      key: `vision-qc:failed-after-retry:${adId || 'unknown'}`,
      fields: {
        ad: String(adId || '-'),
        brand: brandName || String(brandId || '-'),
        product: String(productId || '-'),
        attempts: String(attempts.length || 0),
        regenerated: didRegen ? 'yes' : 'no',
        findings: findings.slice(0, 300)
      },
      detail
    });
    return detail;
  } catch (err) {
    console.warn(`   ⚠️  adVisionQc: alert failed: ${err.message}`);
    return null;
  }
}

/**
 * Slack + log helper for a QC "acceptance" (the render shipped — either
 * clean on attempt 1, or clean after the single allowed regeneration).
 * Fire-and-forget, same contract as alertQcFailure.
 *
 * RETAINED for harness / manual callers. The LIVE per-ad pass path no longer
 * routes through alertService (see noteQcPassToRunFeed) — at real scale
 * (~900 static surfaces per multi-product run) warn-level accept alerts would
 * exhaust ALERT_RATE_LIMIT_MAX and silently drop genuine error/fatal alerts.
 *
 * level:'warn', not 'info' — deliberately. alertService's default
 * ALERT_MIN_LEVEL is 'warn', so an 'info' alert here would silently never
 * be delivered under default config.
 */
function alertQcAccepted({ adId, brandId, productId, visionQc, brandName, appUrl = null, mediaLabel = 'Static ad' }) {
  try {
    const alerts = require('./alertService');
    const last = (visionQc?.attempts || [])[(visionQc?.attempts || []).length - 1];
    alerts.notifyAsync({
      level: 'warn',
      title: visionQc?.finalAttempt > 1
        ? `${mediaLabel} passed vision QC after one regeneration`
        : `${mediaLabel} passed vision QC`,
      // Per-ad key — see the comment on alertQcFailure's key above; the
      // same dedupe-collapse risk applies here and matters more, since
      // acceptance is the common case and will hit far higher volume.
      key: `vision-qc:accepted:${adId || 'unknown'}`,
      fields: {
        ad: String(adId || '-'),
        brand: brandName || String(brandId || '-'),
        product: String(productId || '-'),
        attempts: String(visionQc?.attempts?.length || 0),
        summary: String(last?.summary || 'pass').slice(0, 300)
      },
      detail: buildQcSlackDetail(visionQc, { appUrl })
    });
  } catch (err) {
    console.warn(`   ⚠️  adVisionQc: accept alert failed: ${err.message}`);
  }
}

/**
 * Slack + log helper when QC was supposed to run and did not.
 * level:'error' — shipping uninspected while the flag claims inspection is a
 * real defect, not routine. Fire-and-forget; never throws into the render path.
 *
 * Keyed PER AD — a fixed key would let alertService's 15-min dedupe swallow
 * every ad but the first (same trap as alertQcFailure).
 */
function alertQcSkipped({ adId, brandId, productId, brandName, reason, mediaLabel = 'Static ad' }) {
  try {
    const alerts = require('./alertService');
    alerts.notifyAsync({
      level: 'error',
      title: `${mediaLabel} shipped WITHOUT vision QC`,
      key: `vision-qc:skipped:${adId || 'unknown'}`,
      fields: {
        ad: String(adId || '-'),
        brand: brandName || String(brandId || '-'),
        product: String(productId || '-'),
        reason: String(reason || 'unknown').slice(0, 300)
      },
      detail: buildQcSlackDetail(buildSkippedVerdict(reason))
    });
  } catch (err) {
    console.warn(`   ⚠️  adVisionQc: skipped alert failed: ${err.message}`);
  }
}

/**
 * Per-ad QC pass notice → run feed thread (NOT the alert channel).
 * Fire-and-forget. Silence is correct when runFeed is unconfigured or
 * there is no runId — must NOT fall back to alertService (scale: hundreds
 * of products × 3 surfaces would trip ALERT_RATE_LIMIT_MAX and starve
 * real error/fatal alerts).
 *
 * `qcDetail` carries the SAME buildQcSlackDetail() block the fail/skip
 * alerts already send to the main channel (verdict, summary, full
 * per-category scores + findings via renderCategoryBlock, the attempt
 * trail — collapsed to a plain preview-URL line when there was only one
 * attempt, which is every video QC call and most static passes) — owner
 * request 2026-08-19: "I want to see the output even if it is approved so
 * I can see what it is looking for and what it observes." Deliberately NOT
 * routed through alertQcAccepted/alertService: that path is dead in
 * production for exactly this reason (see alertQcAccepted's docstring) —
 * at real scale (~900 static surfaces/run) a warn-level accept alert per ad
 * would exhaust ALERT_RATE_LIMIT_MAX and silently drop genuine error/fatal
 * alerts. The run-feed thread (runFeedService.noteEvent) is NOT subject to
 * that limiter — it has its own bounded ring buffer + batched Slack posts
 * (services/runFeedService.js SAFETY CONTRACT) — so this sidesteps the
 * rate-limit problem entirely while keeping the main channel reserved for
 * genuine failures. formatThreadLine (runFeedService.js) renders this as an
 * appended multi-line block after the existing one-line summary.
 */
function noteQcPassToRunFeed({
  campaignRunId,
  adId,
  template = null,
  aspectRatio = null,
  platformFormat = null,
  visionQc = null,
  previewUrl = null,
  appUrl = null
} = {}) {
  try {
    if (!campaignRunId) return;
    const runFeed = require('./runFeedService');
    const last = (visionQc?.attempts || [])[(visionQc?.attempts || []).length - 1];
    // Prefer Cloudinary (unfurls in Slack); fall back to app deep link.
    const url = previewUrl || last?.renderUrl || appUrl || null;
    runFeed.noteEvent(campaignRunId, 'vision QC pass', {
      adId: adId || null,
      template: template || null,
      aspectRatio: aspectRatio || null,
      platformFormat: platformFormat || null,
      // summary + attempt are rendered by formatThreadLine (not dead payload).
      summary: String(last?.summary || 'pass').slice(0, 200),
      attempt: visionQc?.finalAttempt || null,
      previewUrl: url,
      // Full category-level detail — see docstring above.
      qcDetail: buildQcSlackDetail(visionQc, { appUrl })
    });
  } catch (err) {
    console.warn(`   ⚠️  adVisionQc: run-feed pass note failed: ${err.message}`);
  }
}

/**
 * Per-ad QC fail notice → run feed thread (in addition to alertQcFailure).
 * Fire-and-forget. Carries the same full qcDetail block as the pass path
 * (see noteQcPassToRunFeed) so the thread is a complete per-ad audit trail
 * for both outcomes — the main-channel alert (alertQcFailure) already gets
 * this detail too, but the thread is read chronologically by whoever is
 * watching a run live, which is a different audience/moment than someone
 * triaging a Slack alert after the fact.
 */
function noteQcFailToRunFeed({
  campaignRunId,
  adId,
  template = null,
  aspectRatio = null,
  platformFormat = null,
  visionQc = null,
  previewUrl = null,
  appUrl = null
} = {}) {
  try {
    if (!campaignRunId) return;
    const runFeed = require('./runFeedService');
    const last = (visionQc?.attempts || [])[(visionQc?.attempts || []).length - 1];
    const url = previewUrl || last?.renderUrl || appUrl || null;
    runFeed.noteEvent(campaignRunId, 'vision QC fail', {
      adId: adId || null,
      template: template || null,
      aspectRatio: aspectRatio || null,
      platformFormat: platformFormat || null,
      // summary + attempt are rendered by formatThreadLine (not dead payload).
      summary: String(last?.summary || 'fail').slice(0, 200),
      attempt: visionQc?.finalAttempt || null,
      previewUrl: url,
      qcDetail: buildQcSlackDetail(visionQc, { appUrl })
    });
  } catch (err) {
    console.warn(`   ⚠️  adVisionQc: run-feed fail note failed: ${err.message}`);
  }
}

module.exports = {
  // Constants (harness pins these)
  MAX_QC_REGENERATIONS,
  CATEGORIES,
  PASS_FLOOR,
  QC_MODEL_ROLE,
  // Flag / model
  isEnabled,
  envEnabled,
  resolveEnabled,
  resolveQcModel,
  warnQcDisabledOnce,
  // Pure helpers
  buildVisionUserContent,
  parseVerdict,
  buildCorrectiveNote,
  buildPersistedVerdict,
  buildSkippedVerdict,
  bufferToDataUrl,
  emptyCategories,
  resolveFrontendOrigin,
  buildAppPreviewUrl,
  qcFailureTitle,
  summarizeVisionQc,
  reportQcVerdict,
  // Video pure helpers
  buildVideoVisionUserContent,
  // I/O
  judgeRender,
  runPostRenderQc,
  judgeVideoRender,
  runVideoPostRenderQc,
  alertQcFailure,
  alertQcAccepted,
  alertQcSkipped,
  noteQcPassToRunFeed,
  noteQcFailToRunFeed,
  buildQcSlackDetail,
  // Test hooks
  _resetSystemConfigFailLogForTests,
  _resetQcDisabledWarnForTests
};
