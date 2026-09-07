#!/usr/bin/env node
/**
 * Offline harness for regeneration identity and preset routing.
 * No DB, no network, no API key.
 *
 * Two production failures on 2026-08-01, both silent:
 *
 *   R1  A second Generate on a campaign produced NOTHING. The static
 *       identityDigest did not include the run, so every candidate collided
 *       with the first run's ads on the per-campaign unique index. Owner rule:
 *       "there should be no limitation on creating new ads that may be
 *       duplicates since generative ads always have new seeds."
 *   R2  Static runs also queued Veo videos. `kinds` defaulted to 'both', and
 *       resolveKinds returned BOTH kinds when asked for one the surface did
 *       not support. The product has two separate presets.
 *
 * The money invariant these must not break (CLAUDE.md §2): a generation POST
 * is billable, so the digest still has to be STABLE WITHIN ONE RUN. Scoping to
 * the run id — not a random nonce — is what keeps a replayed handler, retried
 * batch or reaper requeue deduping exactly as before.
 *
 * Run: node scripts/verifyRegeneration.js
 */
const fs = require('fs');
const path = require('path');
const gen = require('../services/campaignAdsGenerationService');
const pf = require('../services/platformFormats');
const regen = require('../services/adRegenerateService');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const BASE = {
  campaignId: '6a6a52cdcb097b4db3f8084d',
  productId: '6a6a4d58054561c15f3ff8a2',
  mediaId: '6a6a4d58054561c15f3ff8ff',
  template: 'ai_promotional',
  aspectRatio: '1:1',
  variantKind: 'product_image',
  paletteSource: 'media',
  ctaText: 'Shop Now',
  ctaUrl: 'https://example.com',
  ctaUrlParams: '',
  rafflePrizeMediaId: null
};
const d = (over) => gen.computeIdentityDigest({ ...BASE, ...over });

// ── R1: a new run must produce new ads ──────────────────────────────────
const runA = 'run_1785617697150_4002661b';
const runB = 'run_1785617812345_9f3ca771';

check('R1 same run + same inputs -> SAME digest (idempotent within a run)',
  d({ kind: 'image', generationRunId: runA }) === d({ kind: 'image', generationRunId: runA }));

check('R1 different run -> DIFFERENT digest (regeneration is allowed)',
  d({ kind: 'image', generationRunId: runA }) !== d({ kind: 'image', generationRunId: runB }));

// The whole money argument: the run id is not a random nonce. Two calls inside
// one run — a replayed handler, a retried batch — must still collide.
const replay = [];
for (let i = 0; i < 5; i++) replay.push(d({ kind: 'image', generationRunId: runA }));
check('R1 five replays within one run all collide (no double-billing)',
  new Set(replay).size === 1, `got ${new Set(replay).size} distinct digests`);

// Backwards compatibility: a caller that passes nothing must hash EXACTLY as
// before, or every pre-existing ad's digest silently changes meaning.
check('R1 omitting the run id is byte-identical to passing undefined',
  d({ kind: 'image' }) === d({ kind: 'image', generationRunId: null }));
check('R1 omitting the run id differs from any run-scoped digest',
  d({ kind: 'image' }) !== d({ kind: 'image', generationRunId: runA }));

// ── R1b: video stays deterministic ──────────────────────────────────────
// Owner: "veo should only generate a video once for each product unless it is
// revised or another custom video is selected." The run id must NOT reach the
// video digest, or every Generate re-bills a Veo master.
check('R1b video digest ignores the run id (Veo once per product)',
  d({ kind: 'video', generationRunId: runA }) === d({ kind: 'video', generationRunId: runB }),
  'a new run would re-bill a Veo generation');
check('R1b image and video digests still differ from each other',
  d({ kind: 'image', generationRunId: runA }) !== d({ kind: 'video', generationRunId: runA }));

// Every other identity field must still separate ads within one run.
for (const [field, value] of [
  ['aspectRatio', '4:5'], ['template', 'ai_social_proof_led'], ['mediaId', 'ffffffffffffffffffffffff'],
  ['productId', 'ffffffffffffffffffffffff'], ['ctaText', 'Buy Now'], ['variantKind', 'lifestyle']
]) {
  check(`R1 ${field} still separates ads inside one run`,
    d({ kind: 'image', generationRunId: runA }) !== d({ kind: 'image', generationRunId: runA, [field]: value }));
}

// ── R1c: the LIVE path. This is the one that mattered. ──────────────────
// AI_CONCEPT_DRIVEN=true in config/defaults.env and on Render, so static ads
// are built by runConceptDrivenExpansion and keyed by computeV2IdentityDigest.
// The first version of this harness only exercised the legacy V1 digest and so
// passed 22/22 while the live path was completely unfixed — an adversarial
// review caught it, not these tests. Do not delete these.
const V2 = {
  campaignId: '6a6a52cdcb097b4db3f8084d',
  productId: '6a6a4d58054561c15f3ff8a2',
  platformFormat: 'meta_feed_1_1',
  ctaText: 'Shop Now', ctaUrl: 'https://example.com', ctaUrlParams: ''
};
const v2 = (over) => gen.computeV2IdentityDigest({ ...V2, ...over });

// concept_id is a SHORT SLUG the Director is told to make "unique within this
// round" — so the same slug recurs across rounds by design. That reuse is what
// made a second Generate produce nothing.
const SLUG = 'cd_quote_lead';

check('R1c V2: same run + same concept slug -> SAME digest',
  v2({ conceptId: SLUG, kind: 'image', generationRunId: runA }) ===
  v2({ conceptId: SLUG, kind: 'image', generationRunId: runA }));

check('R1c V2: a REUSED concept slug in a NEW run -> DIFFERENT digest',
  v2({ conceptId: SLUG, kind: 'image', generationRunId: runA }) !==
  v2({ conceptId: SLUG, kind: 'image', generationRunId: runB }),
  'this is the exact production failure: the Director reuses slugs, so without run scope the second Generate collides and yields zero ads');

check('R1c V2: video ignores the run id (Veo once per product)',
  v2({ conceptId: SLUG, kind: 'video', generationRunId: runA }) ===
  v2({ conceptId: SLUG, kind: 'video', generationRunId: runB }));

check('R1c V2: omitting the run id is byte-identical to legacy',
  v2({ conceptId: SLUG, kind: 'image' }) === v2({ conceptId: SLUG, kind: 'image', generationRunId: null }));

// The three static sizes of ONE concept in ONE run must stay distinct, or the
// fan-out silently collapses to a single ad.
const fanout = ['meta_feed_1_1', 'meta_feed_4_5', 'meta_stories_9_16']
  .map((fmt) => v2({ conceptId: SLUG, kind: 'image', platformFormat: fmt, generationRunId: runA }));
check('R1c V2: the three static formats of one concept stay distinct in one run',
  new Set(fanout).size === 3, `got ${new Set(fanout).size} distinct digests`);

check('R1c V2: different concepts in one run stay distinct',
  v2({ conceptId: 'cd_a', kind: 'image', generationRunId: runA }) !==
  v2({ conceptId: 'cd_b', kind: 'image', generationRunId: runA }));

check('R1c V2: image and video of one concept stay distinct',
  v2({ conceptId: SLUG, kind: 'image', generationRunId: runA }) !==
  v2({ conceptId: SLUG, kind: 'video', generationRunId: runA }));

// ── R2: presets do not bleed into each other ────────────────────────────
const KINDS = [
  ['meta_feed_1_1', 'image', ['image']],
  ['meta_feed_1_1', 'video', ['video']],
  ['meta_feed_4_5', 'image', ['image']],
  ['meta_stories_9_16', 'image', ['image']],
  // pmax is frozen (coming_soon) — any request yields nothing (never generatable).
  ['pmax_16_9', 'image', []],
  ['pmax_16_9', 'both', []],
  // The inversion that billed a video to someone who picked static.
  ['meta_reels_9_16', 'image', []],
  ['meta_reels_9_16', 'video', ['video']],
  // Explicit 'both' is still honoured — it is a real caller (deterministic video expansion).
  ['meta_feed_1_1', 'both', ['image', 'video']]
];
for (const [fmt, requested, expected] of KINDS) {
  const got = pf.resolveKinds(fmt, requested);
  check(`R2 ${fmt} + ${requested} -> ${JSON.stringify(expected)}`,
    JSON.stringify(got) === JSON.stringify(expected), `got ${JSON.stringify(got)}`);
}
check('R2 a static request never yields a billable video kind',
  ['meta_feed_1_1', 'meta_feed_4_5', 'meta_stories_9_16', 'pmax_16_9', 'meta_reels_9_16']  // pmax included on purpose: frozen must still never yield video
    .every((f) => !pf.resolveKinds(f, 'image').includes('video')));

// ── R3/R3b/R3c: catalog-first reseed on STATIC regenerate — REMOVED
// 2026-09-07 (dormant render fallback deletion, see session.d/) ──────────
// Regenerate used to REPLAY the stored Ad.mediaIds stack forever, so this
// feature re-derived a catalog-first seed (imageRole=hero → earliest
// catalog entry → nothing) and passed it into the local-execution static
// worker's render call. That whole subtree — isRegenReseedCatalogFirstEnabled,
// reseedDecision, shouldReseedFromCatalog, isCatalogMediaForProduct,
// pickFirstCatalogMediaId, deriveFirstCatalogMediaId, RESEED_SKIP, and the
// REGEN_RESEED_CATALOG_FIRST env var — is deleted from
// services/adRegenerateService.js / config/defaults.env: it was reachable
// only from the deleted local-execution worker (formerly `runImage`, called
// from the deleted `performRegeneration`). regenerateAd() now unconditionally
// defers every regenerate to adgen; whatever seed-reselection adgen's own
// consumer does on re-render is adgen's concern, not this repo's.

// ── R4: video regenerate camera-prompt overrides ────────────────────────
// The gap this pins (owner 2026-08-03): runVideoFull took NO prompt override,
// so a video re-roll could not replace the canonical camera prompt. The UI
// also required a non-empty refinement textarea even though the API already
// allowed empty prompt + promptOverride for images — every video re-roll
// therefore carried an OPERATOR REFINEMENT line. R4 pins:
//   - empty regenerate still 400s (no intent)
//   - videoPromptRaw alone is enough intent
//   - videoPromptRaw REPLACES via the existing enforceRawByteCap path
//   - videoPromptGuidance / refinement PREPEND via buildVeoPrompt
//   - length caps match the wizard (1000 / 4000)
// Offline: pure helpers + the real veoPromptBuilder exports. No DB/network/key.
// MONEY: these helpers only choose the prompt string — they do not touch
// submit counts (still one Omni submit per runVideoFull).

const {
  buildVeoPrompt,
  enforceRawByteCap
} = require('../services/veoPromptBuilder');

const OMNI_CAPS = { promptByteCap: 20000, paramShape: 'gemini-omni', family: 'gemini-omni' };

// Minimal product/media fixtures — buildVeoPrompt only needs product title
// and seedHasText; brand/media/layoutInput are signature-stable optionals.
const PROMPT_FIXTURE = {
  brand: { name: 'Acme' },
  product: { title: 'Test Bottle 500ml' },
  media: { text: [] },
  layoutInput: null,
  sourceMedia: null,
  aspectRatio: '9:16',
  seedHasText: false,
  hasProductReference: true,
  storyboard: null,
  caps: OMNI_CAPS,
  durationSec: 8
};

// Mirror generateForAd's three prompt branches (atlasVideoService.js) using
// the SAME exported builder functions production uses. Do not reimplement
// the replace/prepend semantics — call buildVeoPrompt / enforceRawByteCap.
function buildLikeGenerateForAd({ ad, operatorPrompt }) {
  const opTrim = typeof operatorPrompt === 'string' ? operatorPrompt.trim() : null;
  if (opTrim) {
    return buildVeoPrompt({ ...PROMPT_FIXTURE, operatorPrompt: opTrim });
  }
  if (typeof ad?.videoPromptRaw === 'string' && ad.videoPromptRaw.trim()) {
    return enforceRawByteCap(ad.videoPromptRaw, OMNI_CAPS);
  }
  const guidance = (typeof ad?.videoPromptGuidance === 'string' && ad.videoPromptGuidance.trim())
    ? ad.videoPromptGuidance.trim()
    : null;
  return buildVeoPrompt({ ...PROMPT_FIXTURE, operatorPrompt: guidance });
}

// ── R4a: operator-intent LABEL (no longer a gate) ───────────────────────
// CHANGED 2026-08-26 — this group used to read "must 400". It no longer does,
// and the flip is the owner's directive, not drift: "I should be able to
// regenerate with no operator refinement." `regenerateHasIntent` is retained
// UNCHANGED as a pure predicate, but routes/ads.js now uses its result to
// LABEL the request (202 `operatorRefinement`, and the inspector's
// operatorInputs block) instead of rejecting it. So these two checks still
// assert the same predicate values — what changed is what the route does with
// them, which R4a2 below now pins directly.
check('R4a neither prompt nor any override reports NO operator intent',
  regen.regenerateHasIntent({}) === false);
check('R4a empty strings report NO operator intent',
  regen.regenerateHasIntent({
    prompt: '   ',
    videoPromptRaw: '',
    videoPromptGuidance: '  '
  }) === false);
check('R4a refinement prompt alone has intent',
  regen.regenerateHasIntent({ prompt: 'slow push-in' }) === true);
check('R4a videoPromptRaw alone has intent (no refinement needed)',
  regen.regenerateHasIntent({ videoPromptRaw: 'FULL RAW CAMERA PROMPT' }) === true);
check('R4a videoPromptGuidance alone has intent',
  regen.regenerateHasIntent({ videoPromptGuidance: 'soft morning light' }) === true);
check('R4a promptOverride alone has intent (image path, unchanged)',
  regen.regenerateHasIntent({ promptOverride: { system: 's', user: 'u' } }) === true);

// ── R4a2: the ROUTE must accept a refinement-free regenerate ─────────────
// Owner directive 2026-08-26: "I should be able to regenerate with no operator
// refinement." R4a above only proves the PREDICATE reports false for an empty
// body — which it did before this change too, while the route 400'd on that
// same result. So R4a cannot see the regression this group exists to stop, and
// a reinstated gate would leave R4a fully green. Pinned here on the real route
// source: it is an Express handler whose rejection is a `res.status(400)`, not
// something callable offline without a request/response pair.
//
// Every pattern below is chosen to match CODE ONLY, so the block is not
// comment-stripped: the explanatory comment at the call site discusses this
// history in prose (slash-separated field names), and none of these regexes can
// match prose. That is deliberate — a naive comment/quote stripper desyncs on
// regex literals, and this repo has already been bitten by a check satisfied by
// the very comment documenting the thing it was checking.
{
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../routes/ads.js'), 'utf8');
  const startIdx = src.indexOf("router.post('/:id/regenerate'");
  if (startIdx < 0) throw new Error('regenerate route not found in routes/ads.js');
  // Bound at the NEXT route registration — a syntactic boundary, not a char
  // count, so the window cannot silently drift stale as the handler grows.
  const endIdx = src.indexOf('router.', startIdx + 'router.post('.length);
  if (endIdx < 0) throw new Error('could not bound the regenerate handler (no following router. registration)');
  const handler = src.slice(startIdx, endIdx);

  // Positive control: prove the window really contains the handler body, so a
  // bad slice reports as a failure rather than as four vacuous passes.
  check('R4a2 window actually contains the regenerate handler (preflight call)',
    /regen\.preflight\s*\(/.test(handler));

  check('R4a2 route does NOT reject a refinement-free regenerate (no negated intent guard)',
    !/if\s*\(\s*!\s*regen\.regenerateHasIntent\s*\(/.test(handler));
  check('R4a2 the old "is required" 400 body is gone',
    !/or imagePromptRaw is required/.test(handler));
  check('R4a2 regenerateHasIntent is still CALLED (kept as a label, not deleted)',
    /regen\.regenerateHasIntent\s*\(/.test(handler));
  check('R4a2 the 202 echoes the operator-refinement label',
    /operatorRefinement:\s*hasOperatorIntent/.test(handler));
  // The over-length guard is a DIFFERENT rule and must survive: 1000 chars is
  // wizard parity, and dropping it would let an unbounded note through.
  check('R4a2 the prompt length cap 400 is retained',
    /prompt is too long/.test(handler));
}

// ── R4b: length caps (wizard parity: guidance ≤1000, raw ≤4000) ─────────
check('R4b VIDEO_PROMPT_GUIDANCE_MAX is 1000 (wizard parsePhase3WizardFields)',
  regen.VIDEO_PROMPT_GUIDANCE_MAX === 1000);
check('R4b VIDEO_PROMPT_RAW_MAX is 4000 (wizard parsePhase3WizardFields)',
  regen.VIDEO_PROMPT_RAW_MAX === 4000);

const overGuidance = 'g'.repeat(1001);
const atGuidance   = 'g'.repeat(1000);
const overRaw      = 'r'.repeat(4001);
const atRaw        = 'r'.repeat(4000);

{
  const badG = regen.parseRegenVideoPromptFields({ videoPromptGuidance: overGuidance });
  check('R4b guidance over 1000 is rejected',
    badG.ok === false && /1000/.test(badG.error || ''),
    badG.error);
  const okG = regen.parseRegenVideoPromptFields({ videoPromptGuidance: atGuidance });
  check('R4b guidance at 1000 is accepted',
    okG.ok === true && okG.videoPromptGuidance === atGuidance);

  const badR = regen.parseRegenVideoPromptFields({ videoPromptRaw: overRaw });
  check('R4b raw over 4000 is rejected',
    badR.ok === false && /4000/.test(badR.error || ''),
    badR.error);
  const okR = regen.parseRegenVideoPromptFields({ videoPromptRaw: atRaw });
  check('R4b raw at 4000 is accepted',
    okR.ok === true && okR.videoPromptRaw === atRaw);

  // Whitespace-only must collapse to null so a blank Advanced textarea
  // does not count as intent and does not stamp an empty raw onto the clone.
  const blank = regen.parseRegenVideoPromptFields({
    videoPromptRaw: '   ',
    videoPromptGuidance: '\n\t'
  });
  check('R4b whitespace-only raw/guidance collapse to null',
    blank.ok === true && blank.videoPromptRaw === null && blank.videoPromptGuidance === null);
}

// ── R4c: resolve path — raw replaces, guidance/refinement prepend ───────
{
  const baseAd = {
    _id: 'ad1',
    kind: 'video',
    videoPromptRaw: null,
    videoPromptGuidance: null
  };

  // Raw alone → path raw, operatorPrompt null, ad clone carries the raw.
  const rawOnly = regen.resolveVideoRegenCall({
    prompt: null,
    videoPromptRaw: 'CUSTOM RAW CAMERA PROMPT FOR A/B',
    videoPromptGuidance: null,
    ad: baseAd
  });
  check('R4c videoPromptRaw alone resolves path=raw',
    rawOnly.path === 'raw');
  check('R4c raw path sets operatorPrompt null (force generateForAd raw branch)',
    rawOnly.operatorPrompt === null);
  check('R4c raw path stamps videoPromptRaw onto the in-memory ad clone',
    rawOnly.adForGen.videoPromptRaw === 'CUSTOM RAW CAMERA PROMPT FOR A/B');
  // Built prompt must be the raw text (byte-capped), NOT the canonical builder
  // and NOT the OPERATOR REFINEMENT header.
  const builtRaw = buildLikeGenerateForAd({
    ad: rawOnly.adForGen,
    operatorPrompt: rawOnly.operatorPrompt
  });
  check('R4c raw path built prompt equals enforceRawByteCap of the override',
    builtRaw === enforceRawByteCap('CUSTOM RAW CAMERA PROMPT FOR A/B', OMNI_CAPS));
  check('R4c raw path built prompt does NOT carry OPERATOR REFINEMENT header',
    !builtRaw.includes('OPERATOR REFINEMENT'));
  check('R4c raw path does NOT include the canonical product title line',
    // Canonical buildVeoPrompt always mentions the product title; a pure raw
    // override of unrelated text must not reintroduce it.
    !builtRaw.includes('Test Bottle 500ml'),
    'raw must fully replace the canonical prompt');

  // Guidance alone → prepend path; real builder emits OPERATOR REFINEMENT.
  const gOnly = regen.resolveVideoRegenCall({
    prompt: null,
    videoPromptRaw: null,
    videoPromptGuidance: 'soft morning light, hand-held bottle',
    ad: baseAd
  });
  check('R4c videoPromptGuidance alone resolves path=prepend',
    gOnly.path === 'prepend');
  check('R4c guidance becomes operatorPrompt',
    gOnly.operatorPrompt === 'soft morning light, hand-held bottle');
  const builtG = buildLikeGenerateForAd({
    ad: gOnly.adForGen,
    operatorPrompt: gOnly.operatorPrompt
  });
  check('R4c guidance path built prompt starts with OPERATOR REFINEMENT',
    builtG.startsWith('OPERATOR REFINEMENT (HIGHEST PRIORITY'));
  check('R4c guidance path includes the operator text',
    builtG.includes('soft morning light, hand-held bottle'));
  check('R4c guidance path still includes product-fidelity (canonical kept)',
    /product|fidelity|Do NOT/i.test(builtG),
    'prepend must keep the canonical safeguards; only raw drops them');

  // Refinement prompt alone (the existing regenerate textarea) → prepend.
  const refOnly = regen.resolveVideoRegenCall({
    prompt: 'slow dolly in on the label',
    videoPromptRaw: null,
    videoPromptGuidance: null,
    ad: baseAd
  });
  check('R4c refinement prompt alone resolves path=prepend',
    refOnly.path === 'prepend' && refOnly.operatorPrompt === 'slow dolly in on the label');

  // When raw is set, refinement + guidance are ignored (wizard parity).
  const rawWins = regen.resolveVideoRegenCall({
    prompt: 'this refinement must be ignored',
    videoPromptRaw: 'RAW WINS',
    videoPromptGuidance: 'this guidance must be ignored',
    ad: baseAd
  });
  check('R4c raw wins over refinement + guidance (wizard parity)',
    rawWins.path === 'raw' &&
    rawWins.operatorPrompt === null &&
    rawWins.adForGen.videoPromptRaw === 'RAW WINS');

  // Refinement wins over guidance when both are present (same mechanism).
  const refWins = regen.resolveVideoRegenCall({
    prompt: 'refinement wins',
    videoPromptRaw: null,
    videoPromptGuidance: 'guidance loses',
    ad: baseAd
  });
  check('R4c refinement prompt wins over videoPromptGuidance when both set',
    refWins.operatorPrompt === 'refinement wins');

  // Nothing supplied → cascade (generateForAd falls through to ad fields).
  const cascade = regen.resolveVideoRegenCall({
    prompt: null,
    videoPromptRaw: null,
    videoPromptGuidance: null,
    ad: { ...baseAd, videoPromptRaw: 'wizard-stamped raw' }
  });
  check('R4c no per-call override resolves path=cascade',
    cascade.path === 'cascade' && cascade.operatorPrompt === null);
  // Pass-through: the clone still carries the wizard stamp so generateForAd
  // can use it — but we never WRITE a per-call override back to the DB.
  check('R4c cascade preserves ad.videoPromptRaw on the clone (wizard stamp)',
    cascade.adForGen.videoPromptRaw === 'wizard-stamped raw');

  // PASS-THROUGH: resolve must not mutate the original ad object.
  const frozen = { ...baseAd, videoPromptRaw: null };
  regen.resolveVideoRegenCall({
    prompt: null,
    videoPromptRaw: 'must not land on original',
    videoPromptGuidance: null,
    ad: frozen
  });
  check('R4c resolve does not mutate the original ad (pass-through only)',
    frozen.videoPromptRaw === null);
}

// ── R5: static regenerate raw IMAGE prompt (imagePromptRaw) ─────────────
// The gap this pins: static regenerate offered ONLY a ≤1000-char refinement
// note appended to the auto-composed prompt. The full-replace channel existed
// in the renderer (rawPromptOverride, which already accepted a bare string)
// but was unreachable from the regenerate API — the route's only door was
// promptOverride {system,user}, which 400s unless BOTH halves are non-empty.
// R5 pins (the REQUEST-side validation, still all in this repo):
//   - the cap is 40000, NOT the video 4000 (the prompt it replaces is ~8k)
//   - imagePromptRaw alone is enough intent
//   - whitespace-only collapses to null (a blank textarea is not intent)
// Offline: pure helpers from adRegenerateService.js.
//
// REMOVED (dormant render fallback deletion, 2026-09-07): R5c (verbatim
// delivery to the image model — directImageRenderService.resolveImagePromptOverride)
// and R5d (the vision-QC retry's corrective-note composition —
// directImageRenderService.composeCorrectiveOverride) tested the RENDER-TIME
// mapping of this request into an actual model prompt. That mapping lived
// exclusively inside `renderDirectImage`, which no longer exists — adgen's
// own regenerate consumer claims `Ad.regenerationRequest` and does this
// mapping (and the same MONEY-critical no-identical-resubmit rule) on its
// side now. Nothing in this repo maps imagePromptRaw into a model prompt any
// more, so there is nothing left here for R5c/R5d to call.
{
  // ── R5a: cap ──────────────────────────────────────────────────────────
  // Deliberately asserted as a VALUE, not just ">= video". Harmonising this
  // down to 4000 for symmetry would truncate every loaded prompt.
  check('R5a IMAGE_PROMPT_RAW_MAX is 40000 (static prompt is ~8k — 4000 would truncate)',
    regen.IMAGE_PROMPT_RAW_MAX === 40000);
  check('R5a image cap is well above the video cap (different prompt sizes)',
    regen.IMAGE_PROMPT_RAW_MAX > regen.VIDEO_PROMPT_RAW_MAX);

  const overCap = 'x'.repeat(regen.IMAGE_PROMPT_RAW_MAX + 1);
  const atCap   = 'y'.repeat(regen.IMAGE_PROMPT_RAW_MAX);
  const badI = regen.parseRegenImagePromptField({ imagePromptRaw: overCap });
  check('R5a imagePromptRaw over the cap is rejected',
    badI.ok === false && /40000/.test(badI.error || ''));
  const okI = regen.parseRegenImagePromptField({ imagePromptRaw: atCap });
  check('R5a imagePromptRaw exactly at the cap is accepted',
    okI.ok === true && okI.imagePromptRaw === atCap);
  // A canonical-length static prompt must sail through — this is the case the
  // feature exists for, and the one a 4000 cap would have broken.
  const realistic = 'P'.repeat(8400);
  const okReal = regen.parseRegenImagePromptField({ imagePromptRaw: realistic });
  check('R5a a realistic ~8.4k static prompt is accepted',
    okReal.ok === true && okReal.imagePromptRaw === realistic);
  check('R5a non-string imagePromptRaw is rejected',
    regen.parseRegenImagePromptField({ imagePromptRaw: { user: 'x' } }).ok === false);
  const blankI = regen.parseRegenImagePromptField({ imagePromptRaw: '   ' });
  check('R5a whitespace-only imagePromptRaw collapses to null (not intent)',
    blankI.ok === true && blankI.imagePromptRaw === null);
  check('R5a absent imagePromptRaw is null, not an error',
    (() => { const r = regen.parseRegenImagePromptField({}); return r.ok === true && r.imagePromptRaw === null; })());

  // ── R5b: intent gate ──────────────────────────────────────────────────
  check('R5b imagePromptRaw alone has intent (no refinement needed)',
    regen.regenerateHasIntent({ imagePromptRaw: 'FULL RAW IMAGE PROMPT' }) === true);
  check('R5b whitespace-only imagePromptRaw has NO intent',
    regen.regenerateHasIntent({ imagePromptRaw: '   ' }) === false);

  // R5c/R5d removed — see the header note above this block.
}

// ── R6: ad-gen handoff (made UNCONDITIONAL as part of removing the dormant
// in-process render/titling fallback — see session.d/) ───────────────────
// Owner directive: "regenerate ... should absolutely be running through
// adgen. We are not going back to that infrastructure." Backend never
// executes a regenerate in-process any more — every regenerate stamps
// Ad.regenerationRequest and returns; adgen's regenerate consumer claims
// and runs it. R6 pins the pure payload-shape helper regenerateAd() calls
// internally (no DB — the atomic lock write itself is exercised by
// production, not this harness).
{
  // ── R6a: the flag-based decision (shouldDeferToAdgen /
  // ADGEN_RENDERER_ENABLED / services/adgenBridge.js) is GONE — the handoff
  // is unconditional now. Pin the absence, and pin that regenerateAd's own
  // source no longer branches on it.
  check('R6a shouldDeferToAdgen no longer exists (the flag-based decision was deleted)',
    typeof regen.shouldDeferToAdgen === 'undefined');
  {
    const src = fs.readFileSync(path.join(__dirname, '../services/adRegenerateService.js'), 'utf8');
    check('R6a adRegenerateService.js no longer references the deleted ADGEN_RENDERER_ENABLED flag',
      !/ADGEN_RENDERER_ENABLED|isAdgenRendererEnabled|shouldDeferToAdgen/.test(src));
    const fnIdx = src.indexOf('async function regenerateAd(');
    if (fnIdx < 0) throw new Error('regenerateAd not found in source');
    const fnEndIdx = src.indexOf('\nmodule.exports', fnIdx);
    const fnBody = src.slice(fnIdx, fnEndIdx > fnIdx ? fnEndIdx : fnIdx + 4000);
    check('R6a regenerateAd unconditionally builds regenerationRequest via buildRegenerationRequest (no if/else defer decision)',
      /regenerationRequest:\s*buildRegenerationRequest\(/.test(fnBody));
    check('R6a regenerateAd never calls performRegeneration (the deleted local-execution work function)',
      !/performRegeneration\(/.test(fnBody));
  }
  check('R6a config/defaults.env no longer ships ADGEN_RENDERER_ENABLED (the switch is gone, not just defaulted true)',
    !/^ADGEN_RENDERER_ENABLED=/m.test(fs.readFileSync(path.join(__dirname, '..', 'config', 'defaults.env'), 'utf8')));

  // ── R6b: regenerationRequest payload shape — one definition, both sides
  // trust it (regenerateAd stamps it; the adgen consumer's
  // runClaimedRegeneration reads it back) ────────────────────────────────
  const fullReq = regen.buildRegenerationRequest({
    kind: 'video', prompt: 'make it punchier', mode: 'full', requestedBy: 'user_1',
    videoModel: 'atlas-omni', promptOverride: null,
    videoPromptRaw: 'RAW CAMERA PROMPT', videoPromptGuidance: null, imagePromptRaw: null
  });
  check('R6b payload carries kind',
    fullReq.kind === 'video');
  check('R6b payload carries every pass-through field the local path uses',
    fullReq.prompt === 'make it punchier'
    && fullReq.mode === 'full'
    && fullReq.requestedBy === 'user_1'
    && fullReq.videoModel === 'atlas-omni'
    && fullReq.videoPromptRaw === 'RAW CAMERA PROMPT');
  check('R6b absent optional fields normalise to null, not undefined (Mongoose Mixed needs a concrete value)',
    (() => {
      const bare = regen.buildRegenerationRequest({ kind: 'image', mode: 'full' });
      return bare.prompt === null && bare.requestedBy === null && bare.videoModel === null
        && bare.promptOverride === null && bare.videoPromptRaw === null
        && bare.videoPromptGuidance === null && bare.imagePromptRaw === null;
    })());
  check('R6b promptOverride round-trips as an object (image-kind {system,user} shape)',
    (() => {
      const withOverride = regen.buildRegenerationRequest({
        kind: 'image', mode: 'full', promptOverride: { system: 'S', user: 'U' }
      });
      return withOverride.promptOverride && withOverride.promptOverride.system === 'S'
        && withOverride.promptOverride.user === 'U';
    })());
  check('R6b mode defaults to full when omitted (matches regenerateAd\'s effMode)',
    regen.buildRegenerationRequest({ kind: 'image' }).mode === 'full');

  // ── R6c/R6d REMOVED — both tested the local-execution path, which is
  // deleted along with the flag. performRegeneration (R6c: "exported for
  // this repo's own local-execution path to reuse") no longer exists —
  // there is no local-execution path left to reuse it. R6d pinned that the
  // LOCAL-EXECUTION (else) branch of regenerateAd's atomic lock write
  // explicitly nulled regenerateClaimedByWorker/regenerateClaimedAt as
  // defense in depth against a local run racing a stuck adgen claim — that
  // race requires a local run to exist, and it no longer can. See R6a above
  // for what replaced both: proof the flag/branch/local-execution function
  // are all actually gone, not just untested.
  check('R6c/R6d performRegeneration no longer exists (the local-execution work function was deleted)',
    typeof regen.performRegeneration === 'undefined');
}

if (failures.length) {
  console.error(`\n❌ regeneration: ${failures.length} FAILED, ${pass} passed\n`);
  failures.forEach((f) => console.error(`   • ${f}`));
  process.exit(1);
}
console.log(`✅ regeneration: ${pass} checks passed`);
