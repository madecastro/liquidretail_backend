// Ad regenerate-with-prompt — re-runs the render pipeline for a single
// existing Ad with an operator-supplied refinement prompt threaded into
// the relevant LLM(s).
//
// Two modes (chosen by routes/ads.js based on ad.kind):
//
//   image (2026-08-02 — Stage 1 catalog pipeline exclusive):
//     1. Re-run the LIVE static renderer (directImageRenderService /
//        gpt-image-2/edit) from the Ad's own fields — layoutInput, concept,
//        media, platformFormat. No aiCanvasArtifactId, no HTML Gen, no
//        Puppeteer. Exactly ONE billable image submit per invocation.
//     2. Upload the finished PNG to Cloudinary (overwrite publicId so
//        Ad.renderUrl stays stable across regens).
//     3. Stamp renderUrl + imageGeneration + intentResolution.
//
//   video (always "full" — LIGHT mode was retired with the HTML/Puppeteer
//   chrome pipeline; brand-script chrome is deterministic and cheap
//   enough that separating chrome-only from video-only isn't worth the
//   surface area. Chrome-only tweaks now happen at the template level
//   via the Brand page video card).
//     1. Storyboard regenerated with operatorPrompt threaded in.
//     2. New Grok video via videoRouter.generateForAd.
//     3. Brand-script canvas overlay via brandScriptExecutor.
//        renderBrandScriptAndSave — resolver picks the right script by
//        format; no chrome when brand has neither styleScript* nor
//        styleTheme.
//
// State updates throughout: Ad.regenerationStage tracks progress so the
// frontend's 5s poll can show stage labels ("Re-rolling video…",
// "Compositing…"). On completion, regenerating flips false, stage
// clears, history gets the appended entry.
//
// The `mode` param on the API route is now advisory only for video
// (always full); it's preserved for image ads (always full anyway) and
// backward-compat with the current frontend UI that may still send
// mode='light'.

const mongoose              = require('mongoose');
const Ad                    = require('../models/Ad');
const Media                 = require('../models/Media');
// THE shared derive-only gate (money). Imported, never re-implemented — see
// its doc comment in campaignAdsGenerationService.
const { resolveDeriveFromMaster } = require('./campaignAdsGenerationService');

const HISTORY_CAP   = 5;
const DAILY_CAP     = Math.max(1, parseInt(process.env.REGENERATE_DAILY_CAP, 10) || 10);

// ── Video prompt override lengths on regenerate ────────────────────────
// Same product-policy caps as the wizard body parser (routes/ads.js
// parsePhase3WizardFields: guidance ≤1000 chars, raw ≤4000 chars). Do NOT
// raise these to the Omni model promptByteCap (20000) — the wizard and
// regenerate screens must agree, and ATLAS.md documents the deliberate
// 4000-char API ceiling even though Omni can accept more. The model cap
// is still applied later by enforceRawByteCap inside generateForAd.
const VIDEO_PROMPT_GUIDANCE_MAX = 1000;
const VIDEO_PROMPT_RAW_MAX      = 4000;

// ── Image prompt override length on regenerate ─────────────────────────
// DELIBERATELY 10x the video ceiling, and it must not be "harmonised" down
// to 4000 for symmetry. The static prompt this replaces is ~7.8-8.4k chars
// after the PRODUCT_FIDELITY hardening (staticAdIntents.js), so a 4000 cap
// would truncate the very prompt the operator just loaded and make the
// feature useless. 40000 matches MAX_OVERRIDE_LEN on the existing
// promptOverride channel (routes/ads.js), so the two static full-replace
// entry points agree. There is no provider cap to respect: image models
// publish no prompt maximum (docs/ATLAS.md:211, CLAUDE.md §3), and
// atlasImageService passes the string through unaltered.
const IMAGE_PROMPT_RAW_MAX      = 40000;

// ── Pure regenerate request helpers (offline-harnessable) ──────────────
// These exist so scripts/verifyRegeneration.js can pin the request gate
// and the raw-replace / guidance-prepend contract without DB, network,
// or an API key. Production routes/ads.js and runVideoFull call the same
// functions — do not reimplement the rules at the call site.

// Does this regenerate body carry ANY legal intent? A completely empty
// body must 400. Mirrors the static `!prompt && !promptOverride` gate,
// extended so a video re-roll with only videoPromptRaw / videoPromptGuidance
// is legal (that was the gap: the API already allowed empty refinement
// when promptOverride was set for images, but video had no equivalent).
function regenerateHasIntent({
  prompt = null,
  promptOverride = null,
  videoPromptRaw = null,
  videoPromptGuidance = null,
  imagePromptRaw = null
} = {}) {
  if (typeof prompt === 'string' && prompt.trim()) return true;
  if (promptOverride && typeof promptOverride === 'object') return true;
  if (typeof videoPromptRaw === 'string' && videoPromptRaw.trim()) return true;
  if (typeof videoPromptGuidance === 'string' && videoPromptGuidance.trim()) return true;
  if (typeof imagePromptRaw === 'string' && imagePromptRaw.trim()) return true;
  return false;
}

// Validate + normalise the optional video prompt override fields on
// POST /api/ads/:id/regenerate. Same length ceilings as the wizard
// (VIDEO_PROMPT_GUIDANCE_MAX / VIDEO_PROMPT_RAW_MAX). Whitespace-only
// collapses to null so a blank Advanced textarea does not count as intent.
function parseRegenVideoPromptFields(body = {}) {
  const rawIn = body.videoPromptRaw;
  const gIn   = body.videoPromptGuidance;

  let videoPromptRaw = null;
  let videoPromptGuidance = null;

  if (rawIn != null && rawIn !== '') {
    if (typeof rawIn !== 'string') {
      return { ok: false, error: 'videoPromptRaw must be a string' };
    }
    if (rawIn.length > VIDEO_PROMPT_RAW_MAX) {
      return {
        ok: false,
        error: `videoPromptRaw must be a string ≤${VIDEO_PROMPT_RAW_MAX} characters`
      };
    }
    const t = rawIn.trim();
    if (t) videoPromptRaw = t;
  }

  if (gIn != null && gIn !== '') {
    if (typeof gIn !== 'string') {
      return { ok: false, error: 'videoPromptGuidance must be a string' };
    }
    if (gIn.length > VIDEO_PROMPT_GUIDANCE_MAX) {
      return {
        ok: false,
        error: `videoPromptGuidance must be a string ≤${VIDEO_PROMPT_GUIDANCE_MAX} characters`
      };
    }
    const t = gIn.trim();
    if (t) videoPromptGuidance = t;
  }

  return { ok: true, videoPromptRaw, videoPromptGuidance };
}

// Validate + normalise the optional IMAGE raw prompt on
// POST /api/ads/:id/regenerate. Same shape of contract as
// parseRegenVideoPromptFields — non-string rejected, over-cap rejected with
// the cap named, whitespace-only collapsed to null so a blank Advanced
// textarea is not mistaken for intent.
//
// Cap is IMAGE_PROMPT_RAW_MAX (40000), NOT the video 4000 — see the constant.
function parseRegenImagePromptField(body = {}) {
  const rawIn = body.imagePromptRaw;

  let imagePromptRaw = null;

  if (rawIn != null && rawIn !== '') {
    if (typeof rawIn !== 'string') {
      return { ok: false, error: 'imagePromptRaw must be a string' };
    }
    if (rawIn.length > IMAGE_PROMPT_RAW_MAX) {
      return {
        ok: false,
        error: `imagePromptRaw must be a string ≤${IMAGE_PROMPT_RAW_MAX} characters`
      };
    }
    const t = rawIn.trim();
    if (t) imagePromptRaw = t;
  }

  return { ok: true, imagePromptRaw };
}

// Resolve what runVideoFull will pass into generateForAd / prepareStoryboard.
//
// PASS-THROUGH ONLY — never write these back onto the Ad row. The wizard
// PERSISTS videoPromptRaw / videoPromptGuidance on mint so a later Generate
// reuses them; regenerate is a one-shot A/B of the camera prompt. Leaving
// the next regenerate without overrides reverts to (a) any wizard-stamped
// fields still on the row, else (b) the canonical buildVeoPrompt path.
// Persisting here would lock every subsequent re-roll to this experiment.
//
// Priority for THIS call (matches atlasVideoService.generateForAd):
//   1. per-call videoPromptRaw  → stamp onto the in-memory ad clone so the
//      EXISTING raw branch runs (logs "canonical directives bypassed").
//      Refinement prompt + videoPromptGuidance are ignored while raw is
//      active — wizard parity (guidance disabled when raw is set).
//   2. refinement `prompt` OR per-call videoPromptGuidance → operatorPrompt
//      prepend via buildVeoPrompt (OPERATOR REFINEMENT header).
//   3. neither → generateForAd falls through to ad.videoPromptRaw (wizard
//      stamp) or the guidance cascade on the real Ad row.
//
// MONEY: this only chooses the prompt string. It does not change the number
// of billable Omni submits — still exactly one generateForAd → submitGeneration.
function resolveVideoRegenCall({
  prompt = null,
  videoPromptRaw = null,
  videoPromptGuidance = null,
  ad = null
} = {}) {
  const adForGen = ad && typeof ad === 'object' ? { ...ad } : {};
  const raw = (typeof videoPromptRaw === 'string' && videoPromptRaw.trim())
    ? videoPromptRaw.trim()
    : null;
  const guidance = (typeof videoPromptGuidance === 'string' && videoPromptGuidance.trim())
    ? videoPromptGuidance.trim()
    : null;
  const refinement = (typeof prompt === 'string' && prompt.trim())
    ? prompt.trim()
    : null;

  if (raw) {
    // Force the generateForAd raw branch: operatorPrompt must be empty so
    // it does not take priority over ad.videoPromptRaw (see atlasVideoService
    // priority comment: operatorPrompt → raw → guidance cascade).
    adForGen.videoPromptRaw = raw;
    return {
      operatorPrompt: null,
      adForGen,
      path: 'raw'
    };
  }

  // Prepend path. Refinement textarea wins over the advanced guidance field
  // when both are present — both are the same mechanism (operator direction
  // prepended at highest priority), so we pick one rather than concatenate.
  const operatorPrompt = refinement || guidance || null;
  return {
    operatorPrompt,
    adForGen,
    path: operatorPrompt ? 'prepend' : 'cascade'
  };
}

// ── Catalog-first reseed on regenerate — REMOVED 2026-09-07 (dormant render
// fallback deletion, see session.d/) ────────────────────────────────────
// This whole subtree (isRegenReseedCatalogFirstEnabled, reseedDecision,
// shouldReseedFromCatalog, isCatalogMediaForProduct, pickFirstCatalogMediaId,
// deriveFirstCatalogMediaId, the RESEED_SKIP reason table, and the
// REGEN_RESEED_CATALOG_FIRST env var in config/defaults.env) was reachable
// only from the now-deleted local-execution static worker (formerly
// `runImage`, called from the now-deleted `performRegeneration`) — it
// re-derived a catalog-first seed and passed it into that worker's
// renderDirectImage call, both gone. Backend's regenerateAd() now
// unconditionally defers to adgen (stamps Ad.regenerationRequest and
// returns); whatever seed-reselection adgen's own regenerate consumer does
// is adgen's concern, not backend's. No production code called any of these
// functions except that deleted worker — confirmed zero remaining call
// sites before removal.

// ── Ad-gen handoff for regenerate (routing fix, 2026-08-26) ────────────
//
// Owner directive, verbatim: "regenerate whether user triggered or
// triggered by the QC check should absolutely be running through adgen."
// (The QC-check half of that directive is already satisfied structurally —
// static vision-QC's one allowed re-render happens INSIDE the same
// render() call that produced the first attempt, so it already runs
// wherever rendering runs; video QC never regenerates at all, unchanged by
// this file — see adVisionQcService.js. This section is the standalone
// regenerate entry points: the HTTP route and the two agent capabilities,
// which both call regenerateAd() below, and did not go through adgen at
// all before this change.)
//
// PURE — no DB — so scripts/verifyRegeneration.js can pin both without a
// live Mongo connection.

// Builds the exact payload stamped onto Ad.regenerationRequest on the
// deferred path. One definition — the adgen consumer's runClaimedRegeneration
// reads this same shape back out, so drift between "what regenerateAd
// intended" and "what the consumer executes" is structurally impossible.
function buildRegenerationRequest({
  kind, prompt, mode, requestedBy, videoModel, promptOverride,
  videoPromptRaw, videoPromptGuidance, imagePromptRaw
}) {
  return {
    kind,
    prompt:              prompt || null,
    mode:                mode || 'full',
    requestedBy:         requestedBy || null,
    videoModel:          videoModel || null,
    promptOverride:      promptOverride || null,
    videoPromptRaw:      videoPromptRaw || null,
    videoPromptGuidance: videoPromptGuidance || null,
    imagePromptRaw:      imagePromptRaw || null
  };
}

// ── ⚠️ MONEY — THE IN-FLIGHT GUARD ───────────────────────────────────
//
// A FIRST-TIME RENDER IN FLIGHT MUST NEVER REGENERATE, AND THE
// `regenerating` LOCK DOES NOT COVER IT. Providers bill on SUBMIT. The
// initial render's lock is a DIFFERENT field: claimAdsForRun's atomic
// `{ status:'queued' }` → `'rendering'` write (routes/ads.js). This service
// never reads or writes Ad.status at all, so the two filters are disjoint
// and both match the same document — a Regenerate pressed during a first
// render submits a second real generation for one ad.
//
// TWO REPRESENTATIONS OF ONE RULE, deliberately adjacent so they cannot
// drift: `inFlightRefusal` is the read-side predicate preflight turns into
// a 409, and `notInFlight` is the write-side Mongo filter regenerateAd ANDs
// into its atomic lock. THE READ ALONE IS NOT ENOUGH — preflight is a
// `.lean()` read and every caller answers 202 then runs regenerateAd from
// setImmediate, so the row can change in between (titlingResumeService can
// claim a draft master inside that window). `regenerating` has always been
// enforced in BOTH places for exactly this reason; these follow that
// convention rather than inventing a read-only one.
//
// Each arm is load-bearing:
//   rendering — the initial render's claim itself; a concurrent 2nd submit.
//   queued    — never rendered, or requeued by the reaper. Because this
//               service does not write status, the row STAYS queued and
//               claimAdsForRun claims and renders it afterwards: a
//               deterministic second charge, not a race.
//   titling   — a PAID video master still owed titling. Ad.status is already
//               'draft' in that window, so a status-only guard misses it.
//               BOTH shapes titlingResumeService.buildResumeFilter sweeps
//               are covered: the explicit pending|claimed stamp, AND the
//               third arm (a draft holding veoVideoUrl with renderUrl still
//               null) which carries NO stamp at all — regenerating either
//               discards paid spend and races the resume's own write.
//
// draft / live / failed / archived stay regenerable — that is the feature
// working as intended. Do NOT re-key this on the spend receipt
// (veoPredictionId / imageGeneration.predictionId): nothing ever clears a
// receipt (it is stamped once at atlasVideoService.js's submit), so a
// receipt means "has ever spent", not "is spending now" — MEASURED, a
// receipt-keyed guard refuses every successfully-rendered draft/live ad and
// every failed video ad, while still ALLOWING the two pre-submit shapes
// where the double-bill is actually reachable.
//
// Do NOT add a staleness bypass here. A row stuck in-flight by a dead
// worker holds a PAID master, so bypassing on age re-buys it; recovery is
// owned elsewhere (worker.js's reaper requeues receipt-FREE rows,
// bootRecoveryService polls rows holding a receipt and never resubmits, and
// lease expiry for adgen-claimed claims is adgen's).

function inFlightRefusal(ad) {
  if (ad.status === 'rendering') {
    return 'This ad is still rendering its first version — regenerating now would '
      + 'submit a second billable generation for the same ad. Wait for that render '
      + 'to finish or fail. A render stranded by a dead worker is cleared by the '
      + 'render-recovery sweepers or by clearing the stale claim — never by '
      + 'regenerating, which would re-buy work that may already be paid for.';
  }
  if (ad.status === 'queued') {
    return 'This ad has not been rendered yet (it is still queued). Render it '
      + 'instead — regenerating does not change the ad\'s status, so the queued row '
      + 'would still be claimed and rendered afterwards, billing twice.';
  }
  if (ad.titlingResumeState === 'pending' || ad.titlingResumeState === 'claimed'
      || (ad.status === 'draft' && ad.veoVideoUrl && !ad.renderUrl)) {
    return 'This ad has a paid video master that is still being titled — '
      + 'regenerating now would discard that spend and race the titling resume. '
      + 'Wait for titling to finish, then regenerate.';
  }
  return null;
}

// The write-side twin. Composes `$and` rather than spread-merging, for the
// same reason services/spendReceipt.js's receiptFree does: a spread would
// silently drop an existing `$and` on the caller's filter.
const NOT_IN_FLIGHT_AND = Object.freeze([
  { status:             { $nin: ['rendering', 'queued'] } },
  { titlingResumeState: { $nin: ['pending', 'claimed'] } },
  // The untagged resume shape. Absent/null veoVideoUrl, or a renderUrl
  // already present, both fall outside this $nor and stay regenerable.
  { $nor: [{ status: 'draft', veoVideoUrl: { $nin: [null, ''] }, renderUrl: { $in: [null, ''] } }] }
]);

function notInFlight(filter = {}) {
  const existing = Array.isArray(filter.$and) ? filter.$and : [];
  return { ...filter, $and: [...existing, ...NOT_IN_FLIGHT_AND] };
}

// ── Public API ────────────────────────────────────────────────────────

// Validate: not exported, not regenerating, under daily cap. Throws an
// Error with .status (400/409/429) so the route can return clean codes.
async function preflight(adId, brandId) {
  const ad = await Ad.findOne({ _id: adId, brandId }).lean();
  if (!ad) { const e = new Error('Ad not found');                         e.status = 404; throw e; }
  // ⚠️ MONEY — DERIVE-ONLY ADS MUST NEVER REGENERATE.
  // A derive-only surface (Google PMax 1:1) holds a CROP of its sibling
  // 9:16 master's already-paid plate; it has no generation of its own.
  // runVideoFull() calls veoService.generateForAd unconditionally, so
  // without this gate a Regenerate press bills a brand-new Omni video
  // ($1.20 at the pinned 10s, up to $5.00 if the square routes to the
  // per-second aspect-fallback model) — up to DAILY_CAP presses per ad,
  // on the one surface the product sells as free derivation. Refuse here,
  // in preflight, so it fails before the 202 and before any provider call
  // is scheduled. The right way to refresh this ad is to regenerate its
  // MASTER and let the derive re-run. Uses the SHARED gate so this cannot
  // drift from the render loop's copy.
  //
  // ⚠️ THE MESSAGE MUST NAME THE ACTUAL MASTER, and that is why it is
  // interpolated rather than hard-coded. It used to say "its 9:16 master",
  // which read as "the PMax 9:16 ad" — but on a shared-portrait run
  // (UNIFIED_VIDEO_9_16_MASTER, campaignAdsGenerationService) the PMax 9:16
  // is ITSELF a derive and the real master is the Meta Stories ad. An
  // operator sent to the wrong row regenerates a free surface, gets this
  // same 409, and eventually regenerates something that DOES bill — a third
  // Omni charge caused purely by the copy.
  const derivedFrom = resolveDeriveFromMaster(ad);
  if (derivedFrom) {
    const e = new Error(
      `This ad is derived from the already-paid ${derivedFrom} master `
      + '(it has no generation of its own) — regenerate that master instead '
      + 'and this surface will re-derive from it.'
    );
    e.status = 409; throw e;
  }
  if (ad.metaSyncStatus === 'synced') {
    const e = new Error('Ad has been exported to Meta — regeneration disabled (the synced version is canonical).');
    e.status = 409; throw e;
  }
  if (ad.regenerating) {
    const e = new Error('A regeneration is already in progress for this ad.');
    e.status = 409; throw e;
  }
  // ⚠️ MONEY — the in-flight guard. One rule, two representations; see the
  // block above inFlightRefusal for why the write side exists too.
  const inFlight = inFlightRefusal(ad);
  if (inFlight) { const e = new Error(inFlight); e.status = 409; throw e; }
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const recent = (ad.regenerationHistory || []).filter(h =>
    h.at && new Date(h.at).getTime() > since
  );
  if (recent.length >= DAILY_CAP) {
    const e = new Error(`Daily regenerate cap reached (${DAILY_CAP} per ad per 24h). Try again later.`);
    e.status = 429; throw e;
  }
  return ad;
}

// THE single source of truth for which regenerate mode will ACTUALLY run and
// be billed. Defined once and imported — regenerateAd below and the route's
// 202 body both call this, so the response can never advertise a mode the
// worker does not run (same one-definition rule as resolveDeriveFromMaster,
// CLAUDE.md §4).
//
// It always returns 'full', and the arguments are accepted and deliberately
// IGNORED. Video LIGHT (chrome-only, no provider submit) was deleted in
// a23801e7 together with the HTML/Puppeteer chrome pipeline it depended on;
// nothing has re-implemented it, and the deleted runVideoLight only honoured
// an operator prompt via chromeService — now dead code (CLAUDE.md §1). Image
// ads were always full. So every regenerate re-runs the paid generation:
// one Omni submit for video, one gpt-image-2/edit for static.
//
// MONEY/HONESTY: this must never return the caller's requestedMode. Older
// clients still send 'light' (the route defaults an absent mode to it), and
// echoing that back is exactly the billing misrepresentation fixed on
// 2026-08-26 — the operator was told "only the chrome regenerates" while
// runVideoFull billed a ~$0.90 video master. Pinned by
// scripts/verifyRegenerateModeHonesty.js.
// eslint-disable-next-line no-unused-vars
function resolveEffectiveRegenMode({ requestedMode, kind } = {}) {
  return 'full';
}

// Entry point. Spawned via setImmediate from the route handler — the
// route responds 202 with { regenerating: true } and the worker runs
// in the background. The frontend polls /api/catalog/:id/ads-detail
// every 5s watching Ad.regenerating.
async function regenerateAd({
  ad,
  prompt,
  mode,
  requestedBy,
  videoModel = null,
  promptOverride = null,
  // Per-call video camera-prompt overrides (PASS-THROUGH — not persisted).
  // See resolveVideoRegenCall for priority + next-regenerate behaviour.
  videoPromptRaw = null,
  videoPromptGuidance = null,
  // Per-call IMAGE prompt full replacement (PASS-THROUGH — not persisted,
  // same one-shot A/B rule as the video fields above). Threaded through into
  // Ad.regenerationRequest for adgen's own regenerate consumer to apply —
  // backend no longer maps this into a render-path prompt itself (that
  // mapping, formerly local runImage/resolveImagePromptOverride, was deleted
  // along with the rest of the dormant in-process render fallback).
  imagePromptRaw = null
}) {
  const adId      = String(ad._id);
  const kind      = ad.kind || 'image';
  // Video always regens fully (new Grok video + brand-script chrome). The
  // `mode` argument is preserved for backward-compat with existing frontend
  // clients that may still send 'light'; the shared gate normalizes it, and
  // the route reports THAT value in its 202 rather than the request's.
  const effMode   = resolveEffectiveRegenMode({ requestedMode: mode, kind });
  const startedAt = Date.now();
  const historyEntry = {
    prompt:        String(prompt || '').slice(0, 1000),
    mode:          effMode,
    requestedBy:   requestedBy || null,
    videoModel:    videoModel || null,
    // true when this run used a verbatim prompt-text override (operator
    // edited the exact prompt in the Generation Details modal) rather
    // than the refinement-note path. The full text is what the image
    // model receives (adgen-side now); history only flags.
    // Also true for video when videoPromptRaw is supplied (full camera-
    // prompt replace via the existing generateForAd raw branch), and for
    // static when imagePromptRaw is supplied (full image-prompt replace).
    rawPromptEdit: !!(promptOverride || videoPromptRaw || imagePromptRaw),
    at:            new Date(startedAt),
    status:        'pending'
  };

  console.log(
    `🔁 regenerate[ad=${adId}]: kind=${kind} mode=${effMode}` +
    (videoModel ? ` videoModel=${videoModel}` : '') +
    (videoPromptRaw ? ' videoPromptRaw=true' : '') +
    (videoPromptGuidance && !videoPromptRaw ? ' videoPromptGuidance=true' : '') +
    (imagePromptRaw ? ' imagePromptRaw=true' : '') +
    // Flags only — never the override text. imagePromptRaw runs ~8k chars and
    // the refinement may legitimately be empty when raw carries the intent.
    (promptOverride
      ? ' rawPromptEdit=true'
      : imagePromptRaw
        ? ''
        : ` prompt="${historyEntry.prompt.slice(0, 60)}${historyEntry.prompt.length > 60 ? '…' : ''}"`)
  );

  // ── Ad-gen handoff — unconditional. Backend never executes a regenerate
  // in-process any more; every regenerate is stamped as a claimable request
  // for adgen's regenerate consumer. See models/Ad.js (regenerationRequest
  // doc comment) for the full money argument: regenerationRequest is what
  // lets the adgen consumer's claim query find this row.
  //
  // Atomic lock + append in-flight history entry. Filter requires
  // regenerating ≠ true so two concurrent workers cannot both win the
  // race past preflight; the loser sees modifiedCount === 0 and exits
  // without spending provider quota or touching progress. This SAME lock
  // also stamps the full call as regenerationRequest — one write, so there
  // is never a window where regenerating:true is set without the payload
  // a claimer would need to actually do the work.
  const lockSet = {
    regenerating:      true,
    regenerationStage: 'pending',
    updatedAt:         new Date(),
    regenerationRequest: buildRegenerationRequest({
      kind, prompt, mode: effMode, requestedBy, videoModel, promptOverride,
      videoPromptRaw, videoPromptGuidance, imagePromptRaw
    })
  };
  // ⚠️ MONEY — the lock re-asserts the in-flight guard, not just
  // `regenerating`. preflight's 409 is a `.lean()` READ and the callers 202
  // then run this from setImmediate, so the row can enter an in-flight state
  // inside that window; this filter is what makes the refusal atomic.
  const lockResult = await Ad.updateOne(
    notInFlight({ _id: adId, regenerating: { $ne: true } }),
    {
      $set: lockSet,
      $push: {
        regenerationHistory: { $each: [historyEntry], $slice: -HISTORY_CAP }
      }
    }
  );
  if (lockResult.modifiedCount === 0) {
    console.log(`🔁 regenerate[ad=${adId}]: already in flight — skipped`);
    return;
  }

  console.log(
    `🔀 regenerate[ad=${adId}]: kind=${kind} — deferred to adgen renderer service; ` +
    `adgen's regenerate consumer will claim and run it`
  );
}

module.exports = {
  preflight,
  regenerateAd,
  // ⚠️ MONEY — the in-flight guard's two halves, exported so
  // scripts/verifyRegeneratePreflightInflight.js can prove BOTH behaviourally
  // (a read-side-only guard is the hole the atomic lock exists to close).
  inFlightRefusal,
  notInFlight,
  NOT_IN_FLIGHT_AND,
  // THE shared billed-mode gate. Imported by routes/ads.js so the 202 reports
  // the mode that will actually run and be billed — never the caller's.
  // Always 'full': video LIGHT was deleted in a23801e7.
  resolveEffectiveRegenMode,
  DAILY_CAP,
  // Video regenerate prompt overrides — pure helpers for the offline harness
  // (R4 in scripts/verifyRegeneration.js) and the route gate.
  VIDEO_PROMPT_GUIDANCE_MAX,
  VIDEO_PROMPT_RAW_MAX,
  regenerateHasIntent,
  parseRegenVideoPromptFields,
  resolveVideoRegenCall,
  // Static regenerate raw prompt — pure helper + cap for the offline harness
  // (R5 in scripts/verifyRegeneration.js) and the route gate.
  IMAGE_PROMPT_RAW_MAX,
  parseRegenImagePromptField,
  // Ad-gen handoff (R6 in scripts/verifyRegeneration.js) — pure
  // payload-shape helper. regenerateAd always defers to adgen's
  // regenerate-consumer entry point now; this is the one thing still
  // shared with it.
  buildRegenerationRequest
};
