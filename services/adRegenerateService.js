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
const CampaignRun           = require('../models/CampaignRun');
const veoService            = require('./videoRouter');
const brandScriptExecutor   = require('./brandScriptExecutor');
const { uploadBufferToCloudinary } = require('./cloudinaryService');
const directImage           = require('./directImageRenderService');
// THE shared derive-only gate (money). Imported, never re-implemented —
// see its doc comment in campaignAdsGenerationService.
const { resolveDeriveFromMaster } = require('./campaignAdsGenerationService');
const { isUgcFirstSeedingEnabled } = require('./seededUniverseService');
const ugcVideoPipeline             = require('./ugcVideoPipeline');
// Ad-gen microservice handoff (routing fix, 2026-08-26). Same call-time-read
// helper the render loop's runRenderLoop gate uses (routes/ads.js:1856) and
// titlingResumeService uses — read at call time, not at boot, so a dashboard
// flip takes effect without a redeploy.
const { isAdgenRendererEnabled } = require('./adgenBridge');

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

// ── Catalog-first reseed on regenerate ────────────────────────────────
//
// THE PROBLEM. Regenerate used to REPLAY a stored reference stack and never
// re-derive it. Ads queued while DIRECTOR_UNIVERSE_TOP_N was 10 still hold 3+
// entries in Ad.mediaIds, so regenerating them today still sends 3+ references
// — forever, on every future regen.
//
// WHY THIS IS NOT A TRIM. Trimming Ad.mediaIds to its first element would be
// actively harmful. Those historical stacks were ordered by the shotType
// ranking (services/shotTypeRank.js), which sorts LIFESTYLE FIRST, over a pool
// that MERGES catalog media with product_match UGC. So mediaIds[0] on an old ad
// is frequently a UGC/lifestyle post; trimming to [0] would permanently lock a
// social image in as the seed — the exact outcome the owner is guarding
// against. So we RE-DERIVE from the catalog instead.
//
// THE DERIVATION mirrors the live "Feed-order hero" cascade at
// campaignAdsGenerationService.js:2085 (imageRole hero → earliest createdAt →
// nothing) and the owner rule documented for
// seededUniverseService.promoteFirstCatalogImage: "the first image that came
// from the catalog". It is REIMPLEMENTED LOCALLY rather than imported because
// campaignAdsGenerationService is mid-edit in a separate change and importing a
// symbol out of it would couple this behaviour to that file's in-flight state.
// buildSeededUniverse is deliberately NOT called: it is heavier, also mid-edit,
// and its ranked pool contains UGC by construction.
//
// STRUCTURALLY CATALOG-ONLY. Every query pins source:'catalog-product', and
// every candidate is re-checked by isCatalogMediaForProduct() before it can be
// selected. imageRole is never queried on its own — a UGC doc carrying
// metadata.imageRole:'hero' can therefore never be picked. Scope is BOTH the
// ad's own product (metadata.catalogProductId) AND the ad's brand
// (Media.brandId), so neither a cross-product nor a cross-tenant photo can
// leak into the ad.
//
// MONEY (CLAUDE.md §2). This changes WHICH image seeds the ad, never HOW MANY
// submits happen. renderDirectImage still performs exactly one gpt-image-2/edit
// submit per invocation, and reference COUNT does not move the price (flat
// model base_price, no images.length multiplier — atlasImageService.js:75-104).
//
// NOT PERSISTED. The derived stack is computed at regenerate time and passed
// into the render call only. Writing it back onto Ad.mediaIds would silently
// rewrite historical rows and make the kill switch useless for anything already
// regenerated once.
//
// KILL SWITCH: REGEN_RESEED_CATALOG_FIRST, DEFAULT ON. This changes how
// ALREADY-GENERATED ads look when regenerated, so it must be reversible without
// a code deploy.

const RESEED_SKIP = {
  FLAG_OFF:          'REGEN_RESEED_CATALOG_FIRST=false',
  VIDEO:             'video regenerate (static-only behaviour)',
  NOT_PRODUCT_IMAGE: 'variantKind is not product_image (UGC path is unoptimized — owner)',
  OPERATOR_REFS:     'operator referenceMediaIds present (explicit pick always wins)',
  NO_PRODUCT:        'ad has no productId',
  NO_CATALOG_MEDIA:  'no catalog-product Media for this product+brand'
};

// Kill switch. Follows the repo's boolean-flag idiom
// (atlasVideoService.isRepeatPrimaryReferenceEnabled) — unset/empty falls to the
// documented default, and only an explicit 0/false/no/off turns it off. Default
// here is ON because the owner asked for this behaviour.
function isRegenReseedCatalogFirstEnabled() {
  const raw = process.env.REGEN_RESEED_CATALOG_FIRST;
  if (raw == null || raw === '') return true;
  return !/^(0|false|no|off)$/i.test(String(raw).trim());
}

// PURE. The whole gate, in one place, so the offline harness can assert it
// without a DB. Returns { reseed, reason } — reason is the log-ready skip
// reason, null when reseeding.
//
// ALL FOUR conditions must hold. Any one false → behave exactly as before.
function reseedDecision({ ad, flagEnabled }) {
  if (!flagEnabled)                        return { reseed: false, reason: RESEED_SKIP.FLAG_OFF };
  // (a) STATIC only. runImage is the static worker (regenerateAd routes
  //     kind==='video' to runVideoFull), but the gate is restated here so the
  //     pure function is the single source of truth and the harness can prove
  //     a video ad is never reseeded.
  if ((ad?.kind || 'image') === 'video')   return { reseed: false, reason: RESEED_SKIP.VIDEO };
  // (b) HARD OWNER REQUIREMENT, verbatim: "UGC ads shouldn't be affected by
  //     this change, we haven't optimized that path yet." A variantKind:'ugc'
  //     ad is SUPPOSED to seed from a social image — re-deriving it to a
  //     catalog photo breaks it by design. NOT OPTIONAL.
  if (ad?.variantKind !== 'product_image') return { reseed: false, reason: RESEED_SKIP.NOT_PRODUCT_IMAGE };
  // (c) A non-empty referenceMediaIds is an explicit operator pick — owner:
  //     "unless the user overrides it".
  if (Array.isArray(ad?.referenceMediaIds) && ad.referenceMediaIds.length > 0) {
    return { reseed: false, reason: RESEED_SKIP.OPERATOR_REFS };
  }
  // (d) No product → nothing to derive from.
  if (!ad?.productId)                      return { reseed: false, reason: RESEED_SKIP.NO_PRODUCT };
  return { reseed: true, reason: null };
}

function shouldReseedFromCatalog({ ad, flagEnabled }) {
  return reseedDecision({ ad, flagEnabled }).reseed;
}

// PURE. The single predicate that makes the cascade structurally incapable of
// returning non-catalog / cross-product / cross-tenant media. Nothing is
// selectable unless it passes this, regardless of which query produced it.
function isCatalogMediaForProduct(doc, { productId, brandId }) {
  if (!doc || !doc._id) return false;
  if (doc.source !== 'catalog-product') return false;
  // source==='catalog-product' is NOT "is an image". Catalog VIDEOS share that
  // source (shopifyPublicIngestService.js:513-546 writes fileType:'video' +
  // metadata.imageRole:'video' and does resolve catalogProductId), so without
  // this the tier-2 earliest-createdAt branch could seed a STATIC image
  // regenerate with an .mp4. Tier 1 is safe only incidentally, via the hero
  // stamp. Excluding an EXPLICIT video rather than demanding fileType==='image'
  // keeps legacy rows with an absent fileType eligible — the same reasoning as
  // seededUniverseService.promoteFirstCatalogImage, so the two cascades agree.
  if (doc.fileType === 'video') return false;
  if (doc.metadata?.imageRole === 'video') return false;
  // A derived id is only usable if it actually resolves to an image the renderer
  // can fetch. An empty/absent fileUrl means renderDirectImage would resolve zero
  // references and silently fall back to the ad's original seed while we had
  // already logged a successful reseed — see the SELECT comment below.
  if (typeof doc.fileUrl !== 'string' || !doc.fileUrl.trim()) return false;
  const docProduct = doc.metadata?.catalogProductId;
  if (docProduct == null || String(docProduct) !== String(productId)) return false;
  if (doc.brandId == null || String(doc.brandId) !== String(brandId)) return false;
  return true;
}

// PURE tier selection over an in-memory candidate list. Mirrors the tier order
// at campaignAdsGenerationService.js:2085.
//   TIER 1  metadata.imageRole === 'hero'
//   TIER 2  else earliest createdAt
//   TIER 3  else null → derive NOTHING
// Returns { mediaId, tier } | null.
function pickFirstCatalogMediaId(candidates, { productId, brandId }) {
  const eligible = (Array.isArray(candidates) ? candidates : [])
    .filter((doc) => isCatalogMediaForProduct(doc, { productId, brandId }));
  if (!eligible.length) return null;

  const hero = eligible.find((doc) => doc.metadata?.imageRole === 'hero');
  if (hero) return { mediaId: hero._id, tier: 'hero' };

  // Stable earliest-createdAt: ties keep input (feed) order. A missing
  // createdAt sorts last so a stamped doc always beats an unstamped one.
  const ts = (doc) => {
    const t = doc.createdAt ? new Date(doc.createdAt).getTime() : NaN;
    return Number.isFinite(t) ? t : Infinity;
  };
  let earliest = eligible[0];
  for (const doc of eligible.slice(1)) if (ts(doc) < ts(earliest)) earliest = doc;
  return { mediaId: earliest._id, tier: 'earliest-createdAt' };
}

// DB side. Two findOne queries, both pinning source + product + brand, then the
// pure guard above vets the result.
//
// NOT identical to the generation-time cascade, and the difference is deliberate:
// the deterministic-video cascade (campaignAdsGenerationService.js:2085) scopes by
// source + metadata.catalogProductId ONLY, relying on catalogProductId being
// globally unique. We additionally require brandId. Consequence, stated honestly
// rather than glossed: a legacy catalog Media row with a null or wrong brandId is
// selectable by the generation-time promotion (which gates on role, not brandId)
// but NOT here — this returns nothing and the regenerate keeps today's behaviour.
// That is failing CLOSED (no change to the ad) rather than risking a cross-tenant
// seed, which is the right direction for the trade, but it does mean the two paths
// can disagree on such a row. Do not "align" them by dropping brandId.
//
// metadata is a Mixed path, so mongoose does NOT cast a string id inside it;
// the ObjectId conversion is load-bearing, not cosmetic.
async function deriveFirstCatalogMediaId({ productId, brandId }) {
  if (!productId || !brandId) return null;
  let productOid, brandOid;
  try {
    productOid = new mongoose.Types.ObjectId(String(productId));
    brandOid   = new mongoose.Types.ObjectId(String(brandId));
  } catch { return null; }

  // fileType MUST be projected: the guard below rejects fileType==='video', and
  // an unprojected field is undefined, which would silently pass that check and
  // leave only the metadata.imageRole half of the video defence working.
  //
  // fileUrl MUST be projected for the same class of reason, and it is the more
  // dangerous omission. Without it the guard cannot tell a usable Media from a
  // deleted or half-materialised one, so we would log
  // "catalog reseed — stack 3 ref(s) → 1" and hand renderDirectImage an id that
  // resolves to nothing; it then finds zero reference candidates and falls back
  // to media.fileUrl — the ad's ORIGINAL seed, which on the historical rows this
  // feature exists to fix is frequently the UGC/lifestyle image. That is the
  // worst available outcome: a success log over a silent UGC seed, costing a real
  // billable submit. Requiring fileUrl turns it into an honest tier-3 skip.
  const SELECT = '_id source brandId fileType fileUrl metadata createdAt';
  // $ne:'video' also matches docs where fileType is absent or null, which is the
  // behaviour we want — legacy untyped rows stay eligible for tier 2 rather than
  // falling through to tier 3. The post-query guard re-checks it regardless.
  const scope  = {
    source: 'catalog-product',
    brandId: brandOid,
    'metadata.catalogProductId': productOid,
    fileType: { $ne: 'video' },
  };

  // TIER 1 — the hero stamp. Note imageRole is only ever an ADDITIONAL filter
  // on top of the catalog scope; it is never queried alone.
  const hero = await Media.findOne({ ...scope, 'metadata.imageRole': 'hero' }).select(SELECT).lean();
  if (isCatalogMediaForProduct(hero, { productId: productOid, brandId: brandOid })) {
    return { mediaId: hero._id, tier: 'hero' };
  }

  // TIER 2 — earliest catalog entry in feed order.
  const earliest = await Media.findOne(scope).sort({ createdAt: 1 }).select(SELECT).lean();
  if (isCatalogMediaForProduct(earliest, { productId: productOid, brandId: brandOid })) {
    return { mediaId: earliest._id, tier: 'earliest-createdAt' };
  }

  // TIER 3 — nothing. Caller leaves existing behaviour completely untouched.
  return null;
}

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

// The single decision: does THIS regenerate execute locally, or get
// deferred to adgen's regenerate consumer? regenerateAd() calls this exact
// function and never re-reads process.env inline, matching the call-time
// (not boot-time) read convention every other adgen-handoff gate in this
// repo uses (runRenderLoop, titlingResumeService — see adgenBridge.js).
function shouldDeferToAdgen() {
  return isAdgenRendererEnabled();
}

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
  // same one-shot A/B rule as the video fields above). Routed into the
  // existing promptOverride slot on runImage: resolveImagePromptOverride
  // already accepts a bare string, so no new render-path argument.
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
    // model receives (see resolveImagePromptOverride); history only flags.
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

  // ── Ad-gen handoff (routing fix, 2026-08-26) ──────────────────────────
  // Read ONCE, synchronously, before the lock write below — this is the
  // single decision point for "who executes this regenerate", and it must
  // be resolved before any `await` so a flag flip mid-call cannot straddle
  // the two paths. See models/Ad.js (regenerationRequest doc comment) for
  // the full money argument: regenerationRequest is non-null ONLY on this
  // branch, which is what lets the adgen consumer's claim query never
  // collide with a row this process is about to execute in-process below.
  const deferToAdgen = shouldDeferToAdgen();

  // Atomic lock + append in-flight history entry. Filter requires
  // regenerating ≠ true so two concurrent workers cannot both win the
  // race past preflight; the loser sees modifiedCount === 0 and exits
  // without spending provider quota or touching progress. On the adgen
  // path this SAME lock also stamps the full call as regenerationRequest —
  // one write, so there is never a window where regenerating:true is set
  // without the payload a claimer would need to actually do the work.
  const lockSet = {
    regenerating:      true,
    regenerationStage: 'pending',
    updatedAt:         new Date()
  };
  if (deferToAdgen) {
    lockSet.regenerationRequest = buildRegenerationRequest({
      kind, prompt, mode: effMode, requestedBy, videoModel, promptOverride,
      videoPromptRaw, videoPromptGuidance, imagePromptRaw
    });
  } else {
    // MONEY — unconditionally null out the adgen handoff markers on the
    // LOCAL path, even though markComplete already clears them at the end
    // of every regenerate (both paths). Defense in depth against a stale
    // leftover: if a prior deferred attempt got stuck (adgen crashed after
    // claiming, or an operator manually reset `regenerating:false` to
    // unstick a row without also clearing these three fields), a NEW local
    // regenerate winning this SAME atomic lock write is what makes
    // regenerationRequest null again — in the SAME write that flips
    // regenerating:true, not a separate one. Without this, an adgen
    // consumer polling with a stale regenerateClaimedByWorker:null could
    // claim the stale regenerationRequest object the instant this lock is
    // won and run performRegeneration in parallel with THIS call, on
    // different (stale vs current) call args — a genuine double submit.
    lockSet.regenerationRequest       = null;
    lockSet.regenerateClaimedByWorker = null;
    lockSet.regenerateClaimedAt       = null;
  }
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

  if (deferToAdgen) {
    console.log(
      `🔀 regenerate[ad=${adId}]: kind=${kind} — deferred to adgen renderer service ` +
      `(ADGEN_RENDERER_ENABLED=true); adgen's regenerate consumer will claim and run it`
    );
    return;
  }

  await performRegeneration({
    adId, kind, prompt, mode: effMode, requestedBy, videoModel, promptOverride,
    videoPromptRaw, videoPromptGuidance, imagePromptRaw, startedAt
  });
}

// The actual work: dispatch to the video or image worker, then markComplete.
// Extracted out of regenerateAd so BOTH the local-execution path above
// (ADGEN_RENDERER_ENABLED false — this file) and, in the adgen copy of this
// file, the adgen regenerate-consumer's claimed-work entry point
// (runClaimedRegeneration) share one implementation. Not called with a
// lock still to acquire — the caller is responsible for having already won
// the `regenerating` lock (regenerateAd here; the consumer's atomic claim
// on adgen's side).
async function performRegeneration({
  adId, kind, prompt, mode, requestedBy, videoModel, promptOverride,
  videoPromptRaw, videoPromptGuidance, imagePromptRaw, startedAt
}) {
  // Unified progress row (ActivityDock). Cancel is honored between
  // stages (veo → composite / image-gen) — the in-flight provider call
  // finishes, then the regenerate stops and the ad keeps its previous
  // render.
  const { startRun, CancelledError } = require('./progressService');
  const adForBrand = await Ad.findById(adId).select('brandId').lean();
  const brandDoc = adForBrand?.brandId
    ? await require('../models/Brand').findById(adForBrand.brandId).select('advertiserId').lean().catch(() => null)
    : null;
  const progressRun = await startRun({
    kind: 'ad-regenerate', advertiserId: brandDoc?.advertiserId, brandId: adForBrand?.brandId,
    label: kind === 'video' ? 'Video ad regenerate' : 'Ad regenerate'
  });

  try {
    if (kind === 'video') {
      await runVideoFull(adId, prompt, progressRun, videoModel, {
        videoPromptRaw,
        videoPromptGuidance
      });
    } else {
      // imagePromptRaw and promptOverride are mutually exclusive at the route
      // (both land in this one slot, and silently picking a winner would hide
      // which text the operator's money paid for). The `||` is therefore a
      // selection between two never-simultaneous values, not a precedence rule.
      //
      // A refinement sent ALONGSIDE a full replacement is dropped inside
      // renderDirectImage (the override wins) — same rule as the video raw
      // path, so the two screens agree. Say so out loud: historyEntry.prompt
      // still stores the refinement text, so a silent drop would leave an
      // audit trail implying both were used on a charged submit.
      if (imagePromptRaw && String(prompt || '').trim()) {
        console.log(
          `🔁 regenerate[ad=${adId}]: refinement IGNORED — imagePromptRaw replaces the whole prompt`
        );
      }
      await runImage(adId, prompt, progressRun, imagePromptRaw || promptOverride);
    }

    const durationMs = Date.now() - startedAt;
    await markComplete(adId, { status: 'done', durationMs });
    // progress-row failures must not re-enter the outer catch (which
    // would markComplete status:'failed' over a real success).
    try {
      await progressRun.succeed({ durationMs });
    } catch (progErr) {
      console.warn(`🔁 regenerate[ad=${adId}]: progressRun.succeed failed (non-fatal) — ${progErr.message}`);
    }
    console.log(`🔁 regenerate[ad=${adId}]: done in ${Math.round(durationMs / 1000)}s`);
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    if (err instanceof CancelledError) {
      console.log(`🔁 regenerate[ad=${adId}]: cancelled by operator after ${Math.round(durationMs / 1000)}s`);
      await markComplete(adId, { status: 'failed', durationMs, error: 'cancelled by operator' });
      return;
    }
    console.error(`❌ regenerate[ad=${adId}]: failed after ${Math.round(durationMs / 1000)}s — ${err.message}`);
    await markComplete(adId, { status: 'failed', durationMs, error: err.message || String(err) });
    await progressRun.fail(err);
  }
}

// ── Per-mode workers ──────────────────────────────────────────────────

// Load brand — one Media + one Brand lookup — with all fields the
// brand-script executor's format-aware resolver needs.
// loadBrand() REMOVED 2026-08-28 — it existed solely to resolve the brand
// doc for the (now-removed) titling call in runVideoFull below. It had
// exactly one caller.

// Video regen — always full. Regenerates the storyboard + Grok base
// video, then applies brand-script chrome (or no chrome, per resolver).
//
// videoOpts.videoPromptRaw / videoOpts.videoPromptGuidance are per-call
// only (see resolveVideoRegenCall). They ride into generateForAd via an
// in-memory ad clone + operatorPrompt so the EXISTING atlasVideoService
// branches fire:
//   raw     → ad.videoPromptRaw path (logs "canonical directives bypassed")
//   prepend → operatorPrompt → buildVeoPrompt OPERATOR REFINEMENT header
// MONEY: still exactly one generateForAd → one billable Omni submit.
async function runVideoFull(adId, prompt, progressRun = null, videoModel = null, videoOpts = {}) {
  // Stage 1 — context prep (model + aspect resolution, layoutInput
  // warm). storyboard is null on the Atlas path — the Ken Burns prompt
  // directs motion; the operator's refinement / raw override is threaded
  // into the video prompt itself in Stage 2. videoModel (the regenerate
  // dropdown's per-run override) goes to BOTH stages so they resolve
  // the same model.
  if (progressRun) { await progressRun.checkpoint(); progressRun.stage('generating video'); }
  await setStage(adId, 'veo');
  const ad1 = await Ad.findById(adId).lean();
  const { operatorPrompt, adForGen, path } = resolveVideoRegenCall({
    prompt,
    videoPromptRaw:      videoOpts.videoPromptRaw || null,
    videoPromptGuidance: videoOpts.videoPromptGuidance || null,
    ad: ad1
  });
  if (path === 'raw') {
    console.log(`🔁 regenerate[ad=${adId}]: videoPromptRaw active — canonical directives will be bypassed`);
  }

  // UGC-ads Phase 5 — same passthrough gate as the mint-time render path.
  // Regenerate is the money-critical case: a UGC video ad that ships to
  // production and is regenerated once looks like TWO Omni submits (~$6)
  // without this branch. The wizard's regenerate button is one click away
  // from Ad.mediaId already being a UGC video, so this is not theoretical.
  //
  // A passthrough success writes veoVideoUrl directly and skips the
  // veoService calls entirely; skip writes a terminal failed state so
  // the regen UI shows the reason instead of a hung "Re-rolling video…".
  const ugcSourceMedia = ad1?.mediaId
    ? await Media.findById(ad1.mediaId).select('_id fileType fileUrl source matchedProducts matchedCategories brandingAssignment promotionalAssignment').lean()
    : null;
  const ugcPass = ugcSourceMedia
    ? await ugcVideoPipeline.preparePassthroughMaster({
        media:       ugcSourceMedia,
        aspectRatio: ad1?.aspectRatio || '9:16',
        durationSec: 8
      })
    : { passthrough: false, reason: 'no source Media' };

  let veoResult;
  if (ugcPass.passthrough) {
    console.log(
      `🔁 regenerate[ad=${adId}]: ugc-video passthrough → skip Omni ` +
      `(mirrored=${ugcPass.mirrored}, aspect=${ugcPass.aspectRatio})`
    );
    veoResult = {
      videoUrl:        ugcPass.videoUrl,
      aspectRatio:     ugcPass.aspectRatio,
      prompt:          null,
      storyboard:      null,
      model:           null,
      referenceImages: []
    };
  } else if (ugcPass.skip) {
    // Skip is terminal for this regenerate — do NOT fall through to Omni
    // (would be a silent double-charge on a mirror failure). Throw so the
    // outer regenerate handler flips status to failed with the message,
    // matching how a `veoResult.skipped` throw is handled at :700 below.
    throw new Error(`Ugc video passthrough skipped: ${ugcPass.reason}`);
  } else {
    // Passthrough declined (flag off, not eligible, etc.) — proceed with
    // the existing Omni submit path.
    const { storyboard } = await veoService.prepareStoryboard({
      ad: adForGen,
      operatorPrompt,
      modelOverride: videoModel
    });

    if (storyboard) {
      await Ad.updateOne({ _id: adId }, { $set: { veoStoryboard: storyboard, updatedAt: new Date() } });
    }

    // Stage 2 — new base video (model per override → settings → default).
    // ONE billable submit inside generateForAd; prompt overrides do not
    // add or remove submits.
    veoResult = await veoService.generateForAd({
      ad: adForGen,
      operatorPrompt,
      storyboard,
      modelOverride: videoModel
    });
    if (veoResult.skipped) throw new Error(`Veo skipped: ${veoResult.reason}`);
    veoResult.storyboard = veoResult.storyboard || storyboard || null;
  }

  // Stamp the raw render before chrome so a chrome failure still
  // leaves a viewable fallback (the bare Grok video, or the raw UGC
  // segment on the passthrough path).
  await Ad.updateOne({ _id: adId }, {
    $set: {
      veoVideoUrl:    veoResult.videoUrl,
      veoAspectRatio: veoResult.aspectRatio || null,
      veoPrompt:      veoResult.prompt || null,
      veoStoryboard:  veoResult.storyboard || null,
      veoModel:       veoResult.model || null,
      veoReferenceImages: veoResult.referenceImages || [],
      renderUrl:      veoResult.videoUrl,
      renderedAt:     new Date(),
      updatedAt:      new Date()
    }
  });

  // Stage 3 — TITLING REMOVED 2026-08-28 (owner directive: "remove and
  // disable the backend titling function, we are not going to go back to
  // it"). This stage used to call brandScriptExecutor.renderBrandScriptAndSave
  // when a brand resolved (Remotion chrome) and qcAndStampVideoAd only on
  // the no-brand fallback (or on a chrome failure). adgen now titles every
  // master exclusively — backend no longer attempts Remotion compositing
  // in-process at all, brand or no brand, so this stage is unconditional.
  // This whole function is already unreachable in production
  // (regenerateAd returns before calling performRegeneration whenever
  // shouldDeferToAdgen() is true), but if it is ever reached the raw
  // regenerated master ships untitled — exactly the pre-existing "no brand
  // resolved" behavior below, now the only behavior. Vision QC still runs
  // so the ad is never delivered with zero visibility.
  if (progressRun) { await progressRun.checkpoint(); progressRun.stage('compositing'); }
  await setStage(adId, 'composite');
  const adFinal = await Ad.findById(adId).lean();
  // Use the RETURN value, not a re-read of Ad.visionQc. qcAndStampVideoAd's
  // own catch swallows a QC infra failure and writes nothing — a re-read
  // would then treat the PREVIOUS render's verdict as this pass's (and
  // could promote/cascade a plate nobody inspected this time). No fresh
  // verdict ⇒ not-promotable, not-cascadable.
  const thisPassQc = await brandScriptExecutor.qcAndStampVideoAd({ ad: adFinal, deliveredUrl: veoResult.videoUrl });

  // ── Fix — status promotion on a genuinely successful regenerate ────────
  // qcAndStampVideoAd never forces 'draft' on success — it only ever stamps
  // status on a REAL QC failure (buildVideoQcFailureFields) — so there is no
  // un-publish hazard on this (now titling-free) path the way there is on
  // adgen's copy of this file, which still calls uploadRenderAndStamp via
  // renderBrandScriptAndSave. Reuse buildVideoQcFailureFields's own predicate
  // (the exact function that decides "real QC failure" for the shared
  // terminal write) rather than re-deriving it. See promoteFailedToDraft's
  // doc comment for why the promotion itself is filter-scoped rather than a
  // blanket stamp.
  const qcJustFailed = !!brandScriptExecutor.buildVideoQcFailureFields(thisPassQc).status;
  if (thisPassQc && !qcJustFailed) await promoteFailedToDraft(adId);

  // Fix 2 — cascade this successful master regenerate to its same-identity
  // derivative siblings. This path is currently unreachable in production
  // (see this function's own header — regenerateAd returns before
  // performRegeneration whenever shouldDeferToAdgen() is true); kept for
  // parity with adgen's copy and for correctness if ADGEN_RENDERER_ENABLED
  // is ever rolled back. MUST NOT run when THIS regenerate produced no
  // fresh QC verdict, or when that verdict is a real fail — a rejected (or
  // uninspected) plate has no business fanning out to every sibling.
  // Never allowed to fail the master's own regenerate result. See
  // cascadeRegenerateToDerivatives's own doc comment for the money invariant.
  if (thisPassQc && !qcJustFailed) await cascadeRegenerateToDerivatives(adId, { progressRun });
}

// ── Fix 1 shared helper — status promotion on a genuinely successful
// regenerate ────────────────────────────────────────────────────────────
// Promote a previously-'failed' ad back to 'draft' after ITS OWN regenerate
// (or, from the cascade below, its master's regenerate) just persisted a
// real new render. Scoped in the FILTER, not by branching on a status value
// read earlier in the call, so a status that changed between read and write
// (another process, an operator) is respected — this can never touch
// 'draft' / 'live' / 'archived'.
//
// History: this exact intent existed before 2026-08-28 via
// brandScriptExecutor.uploadRenderAndStamp's default (preserveAdStatus:
// false) stamp, reached from THIS file's runVideoFull whenever a brand
// resolved. That stamp is UNCONDITIONAL (any prior status -> 'draft'),
// which is unsafe on a 'live' ad (silently un-publishes it). adgen's copy
// of this file still calls that stamp from runVideoFull; an earlier
// revision of THIS PR tried to gate it with a conditional retitleMode and
// that attempt was reverted — retitleMode suppresses the QC-fail
// quarantine AND skips stampTitlingFailureAndThrow (see the follow-up
// note on adgen's runVideoFull). The 2026-08-28 titling removal here
// (commit abf7e0c2, owner directive "remove and disable the backend
// titling function, we are not going to go back to it") deleted this
// file's ONLY call into that stamp as a side effect of an unrelated,
// titling-only directive — the status side-effect loss was collateral,
// not the intent. This helper restores the INTENT (promote a
// genuinely-successful regenerate off 'failed') without the hazard: it
// only ever writes 'failed' -> 'draft', gated in the query itself, never
// a blanket stamp. On this (titling-free) path there is no un-publish
// of a live ad, because qcAndStampVideoAd never forces 'draft' on
// success. adgen's live-unpublish on regenerate remains a known
// production bug, unfixed by this PR.
async function promoteFailedToDraft(adId) {
  try {
    await Ad.updateOne(
      { _id: adId, status: 'failed' },
      { $set: { status: 'draft', updatedAt: new Date() } }
    );
  } catch (err) {
    console.warn(`🔁 regenerate[ad=${adId}]: status promotion failed (non-fatal) — ${err.message}`);
  }
}

// ── Fix 2 — cascade a master's successful video regenerate to its
// same-identity derivative siblings ─────────────────────────────────────
//
// ⚠️ MONEY — ZERO Atlas/Omni submits in this function or anything it calls,
// STRUCTURALLY: neither this function nor recascadeDerivativeSibling below
// requires or calls veoService / atlasVideoService. A derivative ad's whole
// reason to exist is that it never pays for its own plate (resolveDeriveFrom
// Master / routes/ads.js's renderDeriveOnlyVideoAd, the mint-time reference
// for this exact zero-Omni-spend copy) — after a master regenerates, its
// siblings are re-composited from the NEW master plate the same way, never
// re-submitted. "Zero Atlas/Omni spend" is NOT "free": each sibling still
// costs a face-detect LLM call, a vision-QC judge call, a Remotion slot
// and a Cloudinary upload, which is why the sibling count is capped
// (MAX_REGEN_CASCADE_SIBLINGS).
//
// findDerivativesOfMaster inverts findSiblingMasterAd's filter shape
// (routes/ads.js): every derivative row stamps deriveFromMaster to the
// master's OWN platformFormat (campaignAdsGenerationService.
// planDeterministicVideoAds — including same-format funnel-stage retitles,
// which derive from their own unstaged master format), and a true master
// row always carries deriveFromMaster:null, so this can never match the
// master's own document.
//
// NOT scoped by campaignRunIds — tried in an earlier version of this fix
// and DELIBERATELY REMOVED after a second adversarial review pass (Grok,
// 2026-09-02) proved it wrong in the harmful direction. masters are NOT
// $addToSet'd onto every run that logically depends on them the way
// queued rows are (routes/ads.js's claimAdsForRun only $addToSet's
// status:'queued' rows) — so a genuinely-current funnel-variant or
// new-format sibling minted in a LATER run than the master's own
// campaignRunIds snapshot would silently fail the {$in:
// masterAd.campaignRunIds} filter and never get recascaded. That is
// Fix 2 failing on an ordinary "Generate more / add funnel stages"
// flow.
//
// ⚠️ THE UNIQUE (campaignId, identityDigest) INDEX DOES NOT MAKE
// campaignId+productId+deriveFromMaster a complete family key.
// computeDeterministicVideoDigest ALSO hashes refKey (referenceMediaIds
// if non-empty, else mediaId), ctaText, ctaUrl, ctaUrlParams,
// videoPromptGuidance and videoPromptRaw. A second Generate on the same
// campaign+product with a different seed or a different CTA mints a
// SECOND stories master with its own live derive family — both families
// stamp the identical deriveFromMaster string. Joining only on
// campaignId+productId+deriveFromMaster+kind would CAS-write M1's plate
// onto D2. The filter therefore also joins the rest of that video
// identity (mediaId / referenceMediaIds + CTA + prompt fields).
// platformFormat / funnelStage / duration differ WITHIN a family and
// must not be joined on.
//
// An undefined masterAd.platformFormat is a hard refuse: mongoose keeps
// `deriveFromMaster: undefined` through cast() and the BSON serializer
// DROPS the key, so the query would degenerate to campaignId+productId+
// kind:'video' and match every eligible video ad in that product —
// including other paid masters. Same refuse for missing campaignId /
// productId, and for a master with no mediaId and no reference stack.
//
// EXCLUDES (SIBLING_MID_FLIGHT_EXCLUSION, shared verbatim with the CAS
// write below): any sibling mid-flight elsewhere right now (regenerating,
// claimedByWorker, retitleClaimedByWorker — declared on this repo's
// models/Ad.js for schema parity even though the retitle CONSUMER itself is
// adgen-only, see adgen's copy of this function — titlingNeeded, the
// mint-time renderer->titler handoff marker); any sibling still inside its
// OWN first-render/derive-wait lifecycle (status:'rendering'/'queued'); and
// 'archived' — a retired ad is not silently refreshed by a background
// cascade the operator did not act on for that specific row. THIS IS A
// READ-TIME FILTER ONLY — the write in recascadeDerivativeSibling
// re-asserts every one of these conditions as a CAS on the update itself
// (adversarial review, 2026-09-02 — this repo shares ONE Mongo collection
// with adgen, and this file's own regenerate execution path is dormant
// today only because of a feature flag on the WEB process; a concurrent
// adgen render/titler/retitle claim on the same row is a real race the
// moment this path is ever revived). Unlike adgen's copy, this repo's
// recascadeDerivativeSibling makes exactly ONE write (provenance only — see
// that function's own header on why it cannot composite at all), so there
// is no separate later "delivery write" for a concurrent claim to race —
// the CAS here is the whole operation, not a lease-shaped residual.
const SIBLING_MID_FLIGHT_EXCLUSION = {
  regenerating:            { $ne: true },
  claimedByWorker:          null,
  retitleClaimedByWorker:   null,
  titlingNeeded:            { $ne: true },
  status:                   { $nin: ['rendering', 'queued', 'archived'] }
};

// Mixed Meta+PMax funnel fan-out is ~20 same-family derives of one portrait
// plate (11 Meta + 9 PMax-portrait). 24 leaves headroom. The cascade is
// zero Atlas/Omni spend but each sibling still costs face-detect + vision-QC
// + Remotion + Cloudinary, so the count is not unbounded.
const MAX_REGEN_CASCADE_SIBLINGS = Math.max(
  1,
  parseInt(process.env.REGEN_CASCADE_MAX_SIBLINGS, 10) || 24
);

function digestStringValue(value) {
  return value == null ? '' : String(value);
}

// Pure. Returns the Mongo filter, or null when the master is missing a
// field the filter needs for selectivity (caller MUST NOT query). Exported
// so the harness can assert the undefined-platformFormat refuse against the
// REAL filter object — miniMongoStub treats `undefined` as a matchable
// value, but BSON drops the key, which is the over-match this exists to
// close.
function buildDerivativesOfMasterFilter(masterAd) {
  if (!masterAd) return null;
  if (!masterAd.platformFormat || !masterAd.campaignId || !masterAd.productId) return null;
  const refs = Array.isArray(masterAd.referenceMediaIds) ? masterAd.referenceMediaIds : [];
  if (masterAd.mediaId == null && refs.length === 0) return null;
  const filter = {
    campaignId:          masterAd.campaignId,
    productId:           masterAd.productId,
    deriveFromMaster:    masterAd.platformFormat,
    kind:                'video',
    _id:                 { $ne: masterAd._id },
    ...SIBLING_MID_FLIGHT_EXCLUSION,
    referenceMediaIds:   refs,
    ctaText:             digestStringValue(masterAd.ctaText),
    ctaUrl:              digestStringValue(masterAd.ctaUrl),
    ctaUrlParams:        digestStringValue(masterAd.ctaUrlParams),
    videoPromptGuidance: masterAd.videoPromptGuidance || null,
    videoPromptRaw:      masterAd.videoPromptRaw || null
  };
  if (masterAd.mediaId != null) filter.mediaId = masterAd.mediaId;
  return filter;
}

async function findDerivativesOfMaster(masterAd) {
  const filter = buildDerivativesOfMasterFilter(masterAd);
  if (!filter) return [];
  return Ad.find(filter).lean();
}

// The exact exclusion clauses findDerivativesOfMaster reads with, reused
// verbatim (via SIBLING_MID_FLIGHT_EXCLUSION) as the CAS filter on the
// sibling's own update below — ONE definition, so the read-time skip and
// the write-time claim can never drift apart.
function siblingStillEligible(sibling) {
  return { _id: sibling._id, ...SIBLING_MID_FLIGHT_EXCLUSION };
}

// Re-composite ONE derivative sibling from its master's freshly-regenerated
// plate. Mirrors routes/ads.js's renderDeriveOnlyVideoAd (the mint-time
// reference for this exact free-copy) but for an ad that already exists and
// already shipped once, so this does not touch renderAttempts /
// deriveWaitAttempts (mint-time waiter bookkeeping) and does not wait for
// the master — the master is settled by construction (this runs from inside
// the master's OWN post-regenerate success path).
//
// ⚠️ THIS REPO CANNOT PRODUCE A GENUINE COMPOSITE FOR A SIBLING AT ALL, and
// that is the whole reason this function is deliberately minimal (adversarial
// review, 2026-09-02 — TWO independent Grok passes on the FIRST version of
// this diff, run against both repos, converged on the same defect here).
// Cropping a raw 9:16 master down to a 1:1/4:5/Reels surface only happens
// INSIDE brandScriptExecutor.renderWithRemotionAndSave's Remotion pipeline
// (basePlateCropService), and this file no longer calls
// renderBrandScriptAndSave at all since the 2026-08-28 titling removal
// (commit abf7e0c2) — adgen owns titling exclusively now. So there is no
// safe way for THIS repo to write a correctly-cropped, aspect-correct
// renderUrl for a sibling; the earlier version of this function wrote
// `renderUrl: masterAd.veoVideoUrl` anyway — the RAW, uncropped 9:16 master
// — directly into an already-LIVE, already-correctly-titled sibling's
// renderUrl, and left a now-stale posterUrl behind it. On rollback that
// would have silently stripped every live derivative's titling: Meta push
// refuses an untitled asset and delivery counts drop it, and this repo has
// no titling function left to repair it.
//
// So: PROVENANCE fields only (veoVideoUrl/veoAspectRatio/veoModel/etc, plus
// clearing the now-stale basePlate cache) are updated here. renderUrl,
// posterUrl, visionQc, and status are left EXACTLY as they were — the
// sibling keeps whatever adgen most recently, correctly, titled for it.
// qcAndStampVideoAd is deliberately NOT called: it has no preserveAdStatus
// concept, so calling it here would let a background cascade flip an
// untouched, still-perfectly-good sibling to status:'failed' purely because
// this repo had nothing to composite, and it would inspect
// masterAd.veoVideoUrl — content never actually served to this sibling.
// promoteFailedToDraft is likewise NOT called: nothing was actually fixed
// for this sibling, so promoting it off 'failed' would be dishonest.
//
// If this path is ever revived (ADGEN_RENDERER_ENABLED rolled back), a real
// fix needs this repo to regain a crop/composite capability for derivatives
// FIRST — a pre-existing gap this PR does not attempt to close, since
// backend's whole derive-only pipeline (mint-time AND regenerate-cascade)
// has been in this state since the titling removal, independent of this PR.
//
// KNOWN TRANSIENT: a crash mid-cascade leaves sibling veoVideoUrl pointing
// at the new master while renderUrl is still the old titled composite.
// This repo never writes renderUrl here, so that mismatch is the designed
// (provenance-only) state, not a new hole. Adgen's compositing copy has
// the same provenance/delivery split on a Remotion throw; there is no
// recovery arm that re-titles from that shape.
async function recascadeDerivativeSibling(sibling, masterAd) {
  const siblingId = String(sibling._id);
  try {
    // ⚠️ CAS, not a plain findById+updateOne — see findDerivativesOfMaster's
    // own comment on why the read-time filter alone is not enough on a
    // collection adgen can claim concurrently.
    const claim = await Ad.updateOne(
      siblingStillEligible(sibling),
      {
        $set: {
          veoVideoUrl:        masterAd.veoVideoUrl,
          veoAspectRatio:     masterAd.veoAspectRatio || null,
          // Audit: no model ran for this ad — same marker
          // renderDeriveOnlyVideoAd stamps at mint time, so cost
          // reconcilers / inspectors never attribute an Omni charge here.
          veoModel:           `derive-from:${masterAd.platformFormat}`,
          veoPrompt:          null,
          veoStoryboard:      null,
          veoReferenceImages: [],
          updatedAt:          new Date()
        },
        // The sibling's cached face-detection (Ad.basePlate) is keyed to its
        // OLD veoVideoUrl — now stale (a different video's pixels). Clear it
        // so any future crop/detection (adgen's own titling, or a future
        // revival of this repo's own pipeline) recomputes fresh against the
        // NEW plate instead of applying a crop rect computed against
        // different footage.
        $unset: { basePlate: 1 }
      }
    );
    if ((claim.modifiedCount ?? claim.n ?? 0) === 0) {
      console.log(`🔁 regenerate-cascade[master=${masterAd._id}]: sibling=${siblingId} claimed/changed by another process — skipped this pass`);
      return;
    }
    console.log(`🔁 regenerate-cascade[master=${masterAd._id}]: sibling=${siblingId} provenance updated to the new master plate — renderUrl left untouched (this repo cannot composite a sibling; see this function's own header)`);
  } catch (err) {
    console.warn(`🔁 regenerate-cascade[master=${masterAd._id}]: sibling=${siblingId} failed (non-fatal, master regenerate unaffected) — ${err.message}`);
  }
}

async function cascadeRegenerateToDerivatives(adId, opts = {}) {
  try {
    const progressRun = opts && opts.progressRun;
    const masterAd = await Ad.findById(adId).lean();
    if (!masterAd) return;
    // Defense in depth — runVideoFull only ever runs on a true master (the
    // derive-only gate in preflight() already refuses a regenerate on a
    // derivative before this function could ever be reached), but this
    // guard is one cheap in-memory check and this function must NEVER
    // cascade FROM a derivative.
    if (masterAd.kind !== 'video' || resolveDeriveFromMaster(masterAd)) return;
    if (!masterAd.veoVideoUrl) return;
    // Defense in depth #2 (adversarial review, 2026-09-02) — the caller
    // already gates this whole function call on a fresh !qcJustFailed for
    // the common case, but re-derive it here too so a future/standalone
    // caller of this exported function cannot fan out a rejected plate to
    // every sibling by skipping that gate.
    const qcJustFailed = !!brandScriptExecutor.buildVideoQcFailureFields(masterAd.visionQc).status;
    if (qcJustFailed) return;
    const siblings = await findDerivativesOfMaster(masterAd);
    const capped = siblings.slice(0, MAX_REGEN_CASCADE_SIBLINGS);
    if (siblings.length > MAX_REGEN_CASCADE_SIBLINGS) {
      console.warn(
        `🔁 regenerate-cascade[master=${adId}]: capping at ${MAX_REGEN_CASCADE_SIBLINGS} of ` +
        `${siblings.length} siblings (zero Atlas/Omni spend; each sibling still costs ` +
        `face-detect + vision-QC + Remotion + Cloudinary)`
      );
    }
    for (const sibling of capped) {
      if (progressRun && typeof progressRun.checkpoint === 'function') {
        await progressRun.checkpoint();
      }
      await recascadeDerivativeSibling(sibling, masterAd);
    }
  } catch (err) {
    if (err && (err.name === 'CancelledError' || err.code === 'CANCELLED')) throw err;
    console.warn(`🔁 regenerate-cascade[master=${adId}]: cascade failed (non-fatal) — ${err.message}`);
  }
}

/**
 * Pure: build the renderDirectImage arg object from an Ad row + regen options.
 * Exported so scripts/verifyLifestylePreserve.js can assert variantKind (and
 * every other preserve-gate field) reaches the prompt builder without DB.
 * Dropping variantKind here re-opens BLOCKER 3 — UGC preserve dead on regen.
 */
function buildDirectImageArgsFromAd(ad, {
  adId = null,
  referenceMediaIds = [],
  referenceSource = 'operator',
  prompt = null,
  promptOverride = null
} = {}) {
  return {
    layoutInputArtifactId: ad.layoutInputArtifactId || null,
    aspectRatio:           ad.aspectRatio,
    mediaId:               ad.mediaId,
    productId:             ad.productId || null,
    brandId:               ad.brandId || null,
    adId:                  adId || (ad._id != null ? String(ad._id) : null),
    // Prefer last run id on the ad for run-feed QC notices (regen has no
    // live CampaignRun parameter).
    campaignRunId:         Array.isArray(ad.campaignRunIds) && ad.campaignRunIds.length
      ? ad.campaignRunIds[ad.campaignRunIds.length - 1]
      : null,
    campaignId:            ad.campaignId || null,
    adConceptArtifactId:   ad.conceptArtifactId || null,
    adConceptId:           ad.conceptId || null,
    template:              ad.template,
    platformFormat:        ad.platformFormat || 'meta_feed_1_1',
    referenceMediaIds,
    referenceSource,
    // Lifestyle/UGC scene-preserve — must match first-render path.
    variantKind:           ad.variantKind || null,
    // Refinement note (Product Ads modal) OR verbatim override
    // (Generation Details). Override wins inside renderDirectImage.
    operatorPrompt:        prompt || null,
    rawPromptOverride:     promptOverride || null
  };
}

// IMAGE regeneration via the live direct_image renderer.
//
// Re-derives everything renderDirectImage needs from the Ad row itself:
// layoutInputArtifactId, aspectRatio, mediaId, productId, template,
// conceptArtifactId/conceptId, platformFormat, referenceMediaIds /
// mediaIds. Does NOT require aiCanvasArtifactId (the previous
// precondition that made regenerate fail for every ad the current
// pipeline produces — directImageRenderService never stamps it).
//
// MONEY: renderDirectImage performs exactly one editImage submit.
// There is no retry-on-failure here. If the provider already charged
// (err.charged), the failure is recorded and the caller does not
// re-submit — same convention as renderService's direct-image path.
async function runImage(adId, prompt, progressRun = null, promptOverride = null) {
  if (progressRun) { await progressRun.checkpoint(); progressRun.stage('generating image'); }
  await setStage(adId, 'image-gen');
  const ad = await Ad.findById(adId).lean();
  if (!ad) throw new Error(`Ad ${adId} not found`);

  // Reference stack: same precedence as renderService (operator stack
  // wins; else Director concept mediaIds; else seed media alone inside
  // renderDirectImage).
  const hasOperatorRefs = Array.isArray(ad.referenceMediaIds) && ad.referenceMediaIds.length > 0;
  let referenceMediaIds = hasOperatorRefs
    ? ad.referenceMediaIds
    : (Array.isArray(ad.mediaIds) ? ad.mediaIds : []);
  let referenceSource = hasOperatorRefs ? 'operator' : 'director';

  // UGC-ADS PHASE 3 RESEED. Runs BEFORE the catalog-first reseed because a
  // UGC seed is a stronger operator signal than the catalog-first fallback —
  // if the ad was generated from an operator-picked UGC (persisted on the
  // CampaignRun that produced it), keep that UGC at ref 1 across every regen.
  //
  // Gate order matches the seededUniverseService cascade: the operator-picked
  // path wins over the catalog-first rule (§ preferFirstCatalogImage in
  // seededUniverseService.js — "explicit pick IS the override of the owner
  // rule"). The kill switch UGC_FIRST_SEEDING=false disables this entirely so
  // regen falls back to the catalog reseed byte-for-byte.
  //
  // Structural safety: variantKind gate mirrors reseedDecision — a UGC seed
  // only makes sense for product_image ads (the pipeline the wizard emits).
  // Nothing is written back to Ad.mediaIds; the derived seed rides through
  // the render call only, so a future kill-switch flip actually reverts.
  let ugcReseeded = false;
  if (
    !hasOperatorRefs
    && isUgcFirstSeedingEnabled()
    && (ad?.variantKind === 'product_image')
    && Array.isArray(ad.campaignRunIds) && ad.campaignRunIds.length
  ) {
    // Latest run wins — an ad regenerated after being pulled into a NEW run
    // should honour the newer run's UGC context, not the original mint.
    const latestRunId = ad.campaignRunIds[ad.campaignRunIds.length - 1];
    const run = await CampaignRun.findOne({ runId: latestRunId })
      .select('seedUgcIds')
      .lean();
    const ugcId = run?.seedUgcIds?.length ? String(run.seedUgcIds[0]) : null;
    if (ugcId) {
      // Confirm the UGC still exists + belongs to this brand before seeding —
      // a stale run whose UGC was hard-deleted must not crash the render.
      const stillThere = await Media.exists({ _id: ugcId, brandId: ad.brandId });
      if (stillThere) {
        console.log(
          `🔁 regenerate[ad=${adId}]: UGC reseed — stack ${referenceMediaIds.length} ref(s) → ` +
          `1 (ugc-first ${ugcId} from run ${latestRunId})`
        );
        referenceMediaIds = [ugcId];
        referenceSource   = 'ugc-first';
        ugcReseeded = true;
      } else {
        console.log(
          `🔁 regenerate[ad=${adId}]: UGC reseed skipped — seed ${ugcId} no longer exists on brand ${ad.brandId}`
        );
      }
    }
  }

  // CATALOG-FIRST RESEED. Replaces the replayed Director stack with the ad's
  // first catalog image (see the block header above). Nothing is written back to
  // the Ad — the derived stack goes into this render call only. Still exactly
  // one billable submit either way.
  //
  // SKIPPED when UGC-first already reseeded — see the block above for why the
  // operator-picked UGC outranks catalog-first on regen (same rationale as
  // seededUniverseService's cascade ordering at generate time).
  const reseed = ugcReseeded
    ? { reseed: false, reason: 'ugc-first reseed already applied' }
    : reseedDecision({ ad, flagEnabled: isRegenReseedCatalogFirstEnabled() });
  if (!reseed.reseed) {
    console.log(`🔁 regenerate[ad=${adId}]: catalog reseed skipped — ${reseed.reason}`);
  } else {
    const derived = await deriveFirstCatalogMediaId({ productId: ad.productId, brandId: ad.brandId });
    if (!derived) {
      console.log(`🔁 regenerate[ad=${adId}]: catalog reseed skipped — ${RESEED_SKIP.NO_CATALOG_MEDIA}`);
    } else {
      console.log(
        `🔁 regenerate[ad=${adId}]: catalog reseed — stack ${referenceMediaIds.length} ref(s) → ` +
        `1 (${derived.tier} ${derived.mediaId})`
      );
      referenceMediaIds = [derived.mediaId];
      // 'catalog-first', NOT 'catalog-hero': tier 2 resolves by earliest
      // createdAt, so the chosen image often carries no hero stamp at all, and
      // the owner explicitly moved off "hero" as the naming for this rule
      // (2026-08-03) precisely because it implied a label that may be absent.
      referenceSource   = 'catalog-first';
    }
  }

  let output;
  try {
    // Pure arg assembly is exported for the offline harness — if variantKind
    // is dropped here the UGC half of STATIC_LIFESTYLE_PRESERVE is dead on
    // every paid regen (BLOCKER 3).
    output = await directImage.renderDirectImage(
      buildDirectImageArgsFromAd(ad, {
        adId,
        referenceMediaIds,
        referenceSource,
        prompt,
        promptOverride
      })
    );
  } catch (err) {
    // Carry charged/predictionId so a charged failure is visible in
    // logs and progress, and so no outer layer invents a second submit.
    if (err.charged) {
      console.error(
        `💸 regenerate[ad=${adId}]: image submit was charged` +
        (err.predictionId ? ` (prediction ${err.predictionId})` : '') +
        ` before failing — not retrying`
      );
    }
    throw err;
  }

  if (output?.skipped) {
    throw new Error(`direct-image regenerate skipped: ${output.reason || 'unknown'}`);
  }
  if (!output?.buffer) {
    throw new Error('direct-image regenerate returned no image buffer');
  }

  // Upload — overwrite existing publicId when present so the Ad's
  // renderUrl stays stable across regens (same contract as the old path).
  const publicId = ad.cloudinaryPublicId || undefined;
  const uploaded = await uploadBufferToCloudinary(output.buffer, {
    folder:       'liquidretail/ad_renders',
    publicId,
    resourceType: 'image',
    overwrite:    true
  });

  await Ad.updateOne(
    { _id: adId },
    {
      $set: {
        renderUrl:          uploaded.secure_url,
        cloudinaryPublicId: uploaded.public_id,
        width:              output.width  || uploaded.width  || null,
        height:             output.height || uploaded.height || null,
        bytes:              output.bytes  || uploaded.bytes  || null,
        imageGeneration:    output.imageGeneration  || null,
        intentResolution:   output.intentResolution || null,
        visionQc:           output.visionQc || null,
        renderedAt:         new Date(),
        updatedAt:          new Date()
      }
    }
  );

  // Fix — status promotion on a genuinely successful regenerate. The image
  // path has no QC-driven status write to race (unlike the video path
  // above) — renderDirectImage either returns a real buffer (this point) or
  // throws (caught by the caller, which markComplete's 'failed' instead of
  // reaching here) — so this can run unconditionally. See
  // promoteFailedToDraft's own doc comment for why the write itself is
  // filter-scoped rather than a blanket stamp.
  await promoteFailedToDraft(adId);
}

// ── State helpers ──────────────────────────────────────────────────────

async function setStage(adId, stage) {
  await Ad.updateOne(
    { _id: adId },
    { $set: { regenerationStage: stage, updatedAt: new Date() } }
  );
}

async function markComplete(adId, { status, durationMs, error }) {
  // Atomic update of the pending history entry via arrayFilters.
  // With the atomic lock in regenerateAd at most one pending entry
  // exists, so matching e.status:'pending' is safe and avoids the
  // prior read-modify-write that could stomp a concurrent push.
  await Ad.updateOne(
    { _id: adId },
    {
      $set: {
        regenerating:                          false,
        regenerationStage:                     null,
        // Clear the adgen handoff markers too — harmless no-op on the local
        // path (they were never set), and required on the deferred path so
        // a future regenerate on this ad isn't blocked by a stale claim.
        regenerationRequest:                   null,
        regenerateClaimedByWorker:              null,
        regenerateClaimedAt:                   null,
        'regenerationHistory.$[e].status':     status,
        'regenerationHistory.$[e].durationMs': durationMs,
        'regenerationHistory.$[e].error':      error || null,
        updatedAt:                             new Date()
      }
    },
    { arrayFilters: [{ 'e.status': 'pending' }] }
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
  // Exported so the offline harness can assert the direct-image path
  // (no aiCanvasArtifactId precondition) without invoking providers.
  runImage,
  // Pure arg assembly — verifyLifestylePreserve asserts variantKind is threaded.
  buildDirectImageArgsFromAd,
  DAILY_CAP,
  // Catalog-first reseed. The decision and the tier selection are pure so
  // scripts/verifyRegeneration.js can assert them with no DB, network or key.
  RESEED_SKIP,
  isRegenReseedCatalogFirstEnabled,
  reseedDecision,
  shouldReseedFromCatalog,
  isCatalogMediaForProduct,
  pickFirstCatalogMediaId,
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
  // Ad-gen handoff (R6 in scripts/verifyRegeneration.js) — pure decision +
  // payload-shape helpers, plus the extracted work function so the adgen
  // copy of this file's regenerate-consumer entry point (and any offline
  // harness) can drive the same dispatch regenerateAd uses internally.
  shouldDeferToAdgen,
  buildRegenerationRequest,
  performRegeneration,
  // Status-promotion + derivative-cascade fix (see each function's own doc
  // comment). Exported for verify harnesses to exercise the real functions
  // against a stubbed Ad model rather than a reimplementation.
  promoteFailedToDraft,
  findDerivativesOfMaster,
  recascadeDerivativeSibling,
  cascadeRegenerateToDerivatives,
  buildDerivativesOfMasterFilter,
  MAX_REGEN_CASCADE_SIBLINGS,
  // Exported so the cascade harness can drive the REAL runVideoFull tail
  // (promote + cascade gates) against stubbed providers.
  runVideoFull
};
