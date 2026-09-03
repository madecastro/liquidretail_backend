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
const Brand                 = require('../models/Brand');
const CampaignRun           = require('../models/CampaignRun');
const veoService            = require('./videoRouter');
const brandScriptExecutor   = require('./brandScriptExecutor');
const { uploadBufferToCloudinary } = require('./cloudinaryService');
const directImage           = require('./directImageRenderService');
// THE shared derive-only gate (money). Imported, never re-implemented —
// see its doc comment in campaignAdsGenerationService.
// isGooglePmaxVideoFormat is the SAME predicate computeDeterministicVideoDigest
// uses to decide whether videoDurationSec is a digest-identity field. The
// cascade join must not grow a third copy of that format-set.
const { resolveDeriveFromMaster, isGooglePmaxVideoFormat } = require('./campaignAdsGenerationService');
const { isUgcFirstSeedingEnabled } = require('./seededUniverseService');
const ugcVideoPipeline             = require('./ugcVideoPipeline');
// Receipt peek for the reclaim path ONLY (runClaimedRegeneration's receipt
// gate) — resumeForAd / reconcileVideoCostFromTerminal / resolveFailureCostReconcile.
// DELIBERATELY LAZY-REQUIRED, not top-level: see the require() inside
// runClaimedRegeneration below for the full reasoning (atlasVideoService pulls
// in models/Campaign.js, which broke scripts/verifyRegenerateInFlightGate.js's
// mongoose-stub interception window at module-load time — confirmed by
// bisection, not suspected). All three names are used ONLY inside
// runClaimedRegeneration; nothing else in this file touches them.
const { reconcileCost } = require('./costTracker');
// Titling handoff for a recovered master — same sentinel pair
// bootRecoveryService stamps, so the two writers cannot drift.
const {
  STATE_PENDING:  TITLING_STATE_PENDING,
  TITLING_PENDING,
  fallbackPosterUrl
} = require('./titlingResumeService');

const HISTORY_CAP   = 5;
const DAILY_CAP     = Math.max(1, parseInt(process.env.REGENERATE_DAILY_CAP, 10) || 10);
// Ceiling on regenerateConsumer arm-2 reclaims, enforced in
// runClaimedRegeneration BEFORE any provider call. Duplicated there with the
// same env parse (importing across would be a require cycle). Today's
// stuck-forever claim costs $0 extra; a lease that reclaimed forever would
// bill a fresh submit every lease interval. This ceiling is what keeps the
// lease strictly better than the status quo on money.
const MAX_RECLAIMS  = Math.max(1, parseInt(process.env.ADGEN_REGEN_MAX_RECLAIMS, 10) || 2);

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

// ── The in-flight-render gate (MONEY) ─────────────────────────────────
//
// Returns a refusal `{ arm, message }` when starting a regenerate on this ad
// would put a second billable provider submit against work the ad has already
// bought or is about to buy — otherwise null.
//
// This is the adgen side of the same rule liquidretail_backend enforces in its
// own copy of preflight() (PR #349). The two MUST agree: they are one money
// rule on two sides of a repo boundary, and the transition plan moves this
// path here. Arms and reasoning are deliberately kept in the same order as
// backend's so a reader can diff them.
//
// ── THE THREE REFUSED SHAPES ──
//
// 1. `status:'rendering'` — the first-time render's own claim. renderer.js has
//    claimed the row (or released it for resume) with a provider submit
//    possibly outstanding; a regenerate here submits a second one concurrently
//    against the same Ad document.
//
// 2. `status:'queued'` — and this one is a DETERMINISTIC double charge, not a
//    race. Because the regenerate path never writes `Ad.status` (see below),
//    the row STAYS `'queued'` after the regenerate has already paid for a
//    plate — so backend's `claimAdsForRun` ({status:'queued'} → 'rendering')
//    subsequently claims it and adgen's renderer renders it AGAIN. Two
//    submits, guaranteed, no interleaving required.
//
// 3. A paid video master still owed titling — every shape
//    titlingResumeService.buildResumeFilter sweeps: the explicit
//    `pending`/`claimed` stamp, AND its third (migration) arm, a `'draft'`
//    holding `veoVideoUrl` with `renderUrl` still null, which carries no stamp
//    at all. Those rows hold an Omni master that is PAID FOR and has never
//    been delivered; a regenerate throws it away and buys another, and races
//    the titling sweep for the same fields (both write renderUrl/status).
//    The arms are read off buildResumeFilter itself rather than restated, so a
//    fourth arm added there is honoured here automatically. The staleness
//    sub-condition on arm 2 is deliberately IGNORED for refusal purposes: a
//    `claimed` row is titling-in-flight whether or not the claim has gone
//    stale.
//
// Still regenerable, unchanged: a titled `'draft'`, `'live'`, `'failed'`,
// `'archived'`.
//
// ⚠️ I ORIGINALLY SCOPED ARM 3 OUT, and was wrong. The reasoning was that no
// billable provider submit is reachable from the titling path
// (scripts/verifyTitlingResumeNeverResubmits.js proves atlasVideoService is
// unreachable from titlingResumeService's transitive require graph), so a
// regenerate there could only be the operator's own intended fresh submit.
// That is true and it is not the whole exposure: it addresses the
// double-SUBMIT axis only, and misses that the row holds an already-paid,
// never-delivered master which the regenerate discards, plus the concurrent
// clobber of the same fields. Recorded because the narrow reading is the
// tempting one.
//
// WHY STATUS IS THE SIGNAL, AND WHY IT CANNOT SELF-TRIP. The regenerate path
// NEVER writes `Ad.status`: every `status:` write in this file targets a
// `regenerationHistory` entry, not the Ad. So this gate can never refuse a
// regenerate because of a regenerate. Every terminal render write moves the
// row to `'draft'`/`'failed'`, so a delivered, settled ad is never sitting at
// `'rendering'`.
//
// ⚠️ REJECTED — keying on the spend receipt, which looks like the more
// money-relevant signal and is not. No site in either repo ever CLEARS
// `veoPredictionId` or `imageGeneration.predictionId`; they are stamped at
// submit and kept as the record of the charge. So a receipt means "has ever
// spent", not "is spending now": a receipt-keyed guard refuses every
// successfully-rendered draft/live ad and every failed video ad, while still
// PERMITTING `'queued'` and receipt-free `'rendering'` — the two pre-submit
// shapes where the double bill is actually reachable. Backend measured the
// same alternative by execution at 6-of-10 wrong. Worse, models/Ad.js's
// `renderRequeued` comment records that the receipt is written only AFTER the
// billable POST returns ("a genuinely-billed ad is receipt-free for one HTTP
// round-trip"), so a receipt-keyed gate is OPEN in the window a double submit
// costs the most. Swept over realistic row shapes in
// scripts/verifyRegenerateInFlightGate.js group F.
//
// ⚠️ REJECTED — additionally requiring an empty `renderUrl` to mean "hasn't
// delivered yet". renderer.js's video-master persist (`$setMaster`) stamps
// `renderUrl` with the paid Omni master while leaving `status` at
// `'rendering'` for the titling pass, so "rendering AND renderUrl empty"
// would exempt a $1.20–$5.00 Omni master mid-titling — the single most
// expensive in-flight state in the system.
//
// ⚠️ REJECTED — a stale-claim escape hatch, even though rows genuinely do get
// stranded here (scripts/verifyTitlerClaimReclaim.js records three dead
// workers holding eight video ads, `claimedAt` 27 min to 14.7h stale, and
// regenerating such a row is a real operator need). renderer.js CAPS its own
// ad heartbeat at `AD_HEARTBEAT_MAX_MS` (~60.8 min, renderer.js:322-328) and
// then stops beating while KEEPING the claim, so a genuinely-live long render
// is indistinguishable from a dead one by the orphan thresholds. Those exist
// to PAGE A HUMAN; a paging heuristic must not double as authorization to
// spend, and the ads it would misjudge are the longest-running, i.e. the most
// expensive. Stranded rows are moved off these states by the sweeps that own
// them — bootRecoveryService for receipt-holding rows, backend's reaper for
// receipt-free ones, titlingResumeService for untitled masters. The residual
// cost is named honestly: while a row is stranded, this gate refuses
// regenerates on it until a sweep resolves it. The refusal messages say so
// rather than inviting a retry loop.
function inFlightRefusal(ad) {
  if (!ad) return null;

  if (ad.status === 'rendering') {
    return {
      arm:     'rendering',
      message: 'This ad is still completing its first render — regenerating now '
             + 'would bill a second provider submit for the same ad. Wait for '
             + 'the render to finish (or fail), then regenerate.'
    };
  }

  if (ad.status === 'queued') {
    return {
      arm:     'queued',
      message: 'This ad has not been rendered yet — it is queued. Regenerating '
             + 'now would pay for a plate and then be rendered again when the '
             + 'queue reaches it, billing twice. Let the first render complete, '
             + 'then regenerate.'
    };
  }

  // Arm 3 — read the shapes off titlingResumeService's own sweep filter so the
  // two cannot drift. Only the `status:'draft'` family is relevant; the
  // staleness bound on the `claimed` arm is intentionally not applied here.
  //
  // FAILS CLOSED IF THE FILTER OUTGROWS THE MATCHER. matchesTitlingResumeArm
  // throws rather than silently no-matching when buildResumeFilter gains a
  // shape it cannot interpret (a dotted path, a new operator). That throw must
  // not escape: this function is called from runClaimedRegeneration OUTSIDE its
  // try block, so an exception would reach regenerateConsumer's
  // "crashed outside performRegeneration" catch, which deliberately leaves the
  // row locked (`regenerating:true`, claimed) with no retry — money-safe but a
  // stuck row and a misleading log. Converting it to an ordinary REFUSAL keeps
  // the fail-closed money property AND releases the lock with an actionable
  // message. "Cannot evaluate the titling state" must never read as "not owed
  // titling", because that would re-buy a paid master.
  if (ad.status === 'draft') {
    let owed;
    try {
      owed = matchesTitlingResumeArm(ad);
    } catch (err) {
      console.error(
        `⚠️  inFlightRefusal: cannot evaluate titlingResumeService.buildResumeFilter `
        + `— refusing the regenerate rather than risking a re-buy. ${err.message}`
      );
      return {
        arm:     'titling-indeterminate',
        message: 'This ad\'s titling state could not be determined, so the '
               + 'regenerate was refused rather than risk discarding an '
               + 'already-paid video master. This is a bug in the in-flight '
               + 'gate, not a problem with the ad — it needs an engineer.'
      };
    }
    if (owed) {
      return {
        arm:     'titling-owed',
        message: 'This ad holds a paid video master that has not finished titling '
               + 'yet — regenerating now would discard an already-paid master and '
               + 'buy another, while the titling pass is still writing to this ad. '
               + 'Wait for titling to complete, then regenerate.'
      };
    }
  }

  return null;
}

// True when `ad` matches any arm of titlingResumeService.buildResumeFilter's
// `$or` (evaluated against the `status:'draft'` family only — the caller has
// already established that). Derived from that filter object rather than
// restating its arms, so a new arm there is covered here without an edit.
// Only the two shapes that filter actually uses are interpreted — an equality
// on a scalar, and `{$ne: null}` / `null` presence tests — and an arm using
// anything else throws loudly rather than being silently treated as no-match,
// which is how a hand-rolled matcher quietly stops gating (this repo hardened
// four other matchers for exactly that reason in PR #80).
function matchesTitlingResumeArm(ad) {
  const { buildResumeFilter } = require('./titlingResumeService');
  const arms = buildResumeFilter(new Date()).$or || [];
  return arms.some(arm =>
    Object.entries(arm).every(([field, cond]) => {
      if (field.includes('.')) {
        throw new Error(
          `inFlightRefusal: titlingResumeService.buildResumeFilter arm uses a dotted `
          + `path (${field}) this matcher does not resolve — update it rather than `
          + `letting the titling gate silently stop matching.`
        );
      }
      const val = ad[field];
      if (cond === null) return val === null || val === undefined;
      if (cond && typeof cond === 'object') {
        if ('$ne' in cond && Object.keys(cond).length === 1) {
          return cond.$ne === null ? (val !== null && val !== undefined) : val !== cond.$ne;
        }
        // `updatedAt: {$lt: cutoff}` — the staleness bound, deliberately not
        // applied to a refusal (see arm 3's note). Treat as satisfied.
        if ('$lt' in cond && Object.keys(cond).length === 1) return true;
        throw new Error(
          `inFlightRefusal: unsupported operator in buildResumeFilter arm `
          + `(${field}: ${JSON.stringify(cond)}) — update this matcher.`
        );
      }
      return val === cond;
    })
  );
}

// Fields inFlightRefusal actually reads. Shared so the execute-time select
// and the late re-check cannot drop a field independently — a select that
// omits one silently turns the gate into a no-op, which is worse than no gate.
// `updatedAt` is deliberately absent: matchesTitlingResumeArm treats the
// sweep's `$lt` staleness bound as satisfied without reading it.
const IN_FLIGHT_SELECT = 'status titlingResumeState veoVideoUrl renderUrl';

class InFlightRefusalError extends Error {
  constructor(refusal) {
    super(refusal.message);
    this.name = 'InFlightRefusalError';
    this.arm = refusal.arm;
  }
}

// MONEY — the last in-flight re-check before a billable submit.
//
// A NEW find, deliberately not a reuse of runImage's `ad` / runVideoFull's
// `ad1`. Those are un-narrowed full .lean() documents and WOULD carry these
// fields, but they are loaded before the UGC / catalog-reseed /
// prepareStoryboard awaits — reusing them would leave exactly the window this
// exists to close.
//
// THROWS rather than returning. Both call sites sit inside their caller's
// try, so a plain return would fall through to markComplete({status:'done'})
// and report a refused regenerate as a success.
async function assertNotInFlightBeforeSubmit(adId) {
  const snap = await Ad.findById(adId).select(IN_FLIGHT_SELECT).lean();
  if (!snap) throw new Error(`Ad ${adId} not found`);
  const refusal = inFlightRefusal(snap);
  if (refusal) throw new InFlightRefusalError(refusal);
}

// One ad-row unwind, shared by the execute-time gate and the late throw, so
// the two cannot drift. Exactly ONE markComplete: a second call would no-op
// against the already-stamped history slot and read as a bug later.
// progressRun is null at the execute-time gate (startRun has not run yet) and
// non-null after it, where the OperationRun must be failed or it sits in
// 'running' until the stale-run sweeper gets to it.
async function unwindInFlightRefusal(adId, startedAt, refusal, progressRun = null) {
  console.log(
    `🔀 regenerate-consumer[ad=${adId}]: refused at execute time — first-time render in flight (${refusal.arm})`
  );
  await markComplete(adId, {
    status: 'failed',
    durationMs: Date.now() - startedAt,
    error: refusal.message
  });
  if (progressRun && typeof progressRun.fail === 'function') {
    await progressRun.fail(refusal instanceof Error ? refusal : new Error(refusal.message));
  }
}

// ── Public API ────────────────────────────────────────────────────────

// Validate: not exported, not regenerating, not mid-first-render / queued /
// owed-titling, under daily cap. Throws an Error with .status (400/409/429) so
// the route can return clean codes.
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
  // ⚠️ MONEY — the ad's own first-time render (or its queued place in line, or
  // its unfinished titling) must not be raced by a regenerate. See
  // inFlightRefusal for the three shapes and for the three narrower signals
  // that were rejected.
  //
  // ⚠️ REACH — THIS FUNCTION IS NOT ON THE LIVE PATH IN THIS REPO. Its only
  // caller is services/capabilityExecutors/adRegenerate.js, reachable only
  // from services/capabilityRegistry.js, which nothing in src/ requires
  // (scripts/verifyRequireGraph.js reports it unreferenced, and
  // scripts/vendor-manifest.json records the executor as "only required from
  // unused capabilityRegistry"). A real Regenerate press is gated by
  // liquidretail_backend's copy of this function, which returns the
  // user-facing 409 (backend PR #349). This arm is here for PARITY with that
  // copy — it does not itself close a user-facing hole. The gate that actually
  // fires in this repo is the execute-time one in runClaimedRegeneration
  // below, on the deferred consumer path.
  const inFlight = inFlightRefusal(ad);
  if (inFlight) {
    const e = new Error(inFlight.message);
    e.status = 409; throw e;
  }
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
  // Video always regens fully (new Grok video + brand-script chrome).
  // The `mode` argument is preserved for backward-compat with existing
  // frontend clients that may still send 'light' — we normalize it here.
  const effMode   = 'full';
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

  // Atomic lock + append in-flight history entry. Filter requires
  // regenerating ≠ true so two concurrent workers cannot both win the
  // race past preflight; the loser sees modifiedCount === 0 and exits
  // without spending provider quota or touching progress.
  const lockResult = await Ad.updateOne(
    { _id: adId, regenerating: { $ne: true } },
    {
      $set: {
        regenerating:      true,
        regenerationStage: 'pending',
        updatedAt:         new Date()
      },
      $push: {
        regenerationHistory: { $each: [historyEntry], $slice: -HISTORY_CAP }
      }
    }
  );
  if (lockResult.modifiedCount === 0) {
    console.log(`🔁 regenerate[ad=${adId}]: already in flight — skipped`);
    return;
  }

  // Unified progress row (ActivityDock). Cancel is honored between
  // stages (veo → composite / image-gen) — the in-flight provider call
  // finishes, then the regenerate stops and the ad keeps its previous
  // render.
  const { startRun, CancelledError } = require('./progressService');
  const brandDoc = await require('../models/Brand').findById(ad.brandId).select('advertiserId').lean().catch(() => null);
  const progressRun = await startRun({
    kind: 'ad-regenerate', advertiserId: brandDoc?.advertiserId, brandId: ad.brandId,
    label: kind === 'video' ? 'Video ad regenerate' : 'Ad regenerate'
  });

  try {
    let videoOutcome = null;
    if (kind === 'video') {
      videoOutcome = await runVideoFull(adId, prompt, progressRun, videoModel, {
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
    // Cascade AFTER markComplete so it sits outside the regenerate claim
    // window (regenerateClaimedAt is never heartbeat'd; CLAIM_STALE_MIN
    // is 45 min). A reclaim mid-cascade would rewrite the master's
    // Cloudinary-mirrored veoVideoUrl with Atlas's expiring outputs[0]
    // URL — not a second Omni bill (receipt gate), but a real delivery
    // corruption. Sibling recascade is non-fatal and swallows its own
    // errors, including an operator-cancel checkpoint.
    if (videoOutcome && videoOutcome.shouldCascade) {
      await cascadeRegenerateToDerivatives(adId, { progressRun });
    }
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
    // A late in-flight refusal is not a crash. Route it through the SAME
    // unwind the execute-time gate uses so the ad row settles identically,
    // and so it cannot fall through into a second markComplete below.
    if (err instanceof InFlightRefusalError) {
      await unwindInFlightRefusal(adId, startedAt, err, progressRun);
      return;
    }
    console.error(`❌ regenerate[ad=${adId}]: failed after ${Math.round(durationMs / 1000)}s — ${err.message}`);
    await markComplete(adId, { status: 'failed', durationMs, error: err.message || String(err) });
    await progressRun.fail(err);
  }
}

// Ad-gen regenerate consumer entry point (routing fix, 2026-08-26). Backend's
// regenerateAd(), when ADGEN_RENDERER_ENABLED is true, no longer executes a
// regenerate itself — it wins the SAME `regenerating` atomic lock (unchanged
// semantics) and additionally stamps the full call as Ad.regenerationRequest,
// then returns. services/regenerateConsumer.js polls for exactly that shape
// (regenerating:true, regenerationRequest non-null, unclaimed) and atomically
// claims ONE row via its own findOneAndUpdate (regenerateClaimedByWorker) —
// see that file for the claim query. By the time THIS function is called the
// row is already locked AND claimed, so — unlike regenerateAd() above — it
// does NOT re-acquire the `regenerating` lock; it just does the work and
// calls markComplete on the way out.
//
// Deliberately NOT sharing an extracted helper with regenerateAd() above:
// scripts/verifyVideoResumeFromReceipt.js C2 statically extracts
// regenerateAd's own function body and asserts it reaches runVideoFull (and,
// transitively, generateForAd({allowResume:false})) directly — an extra
// indirection through a shared helper would defeat that check's call-graph
// walk without weakening the actual invariant, which is not a trade worth
// making for a few dozen duplicated lines. So this function calls
// runVideoFull / runImage / markComplete directly too — same dispatch shape
// as regenerateAd, same allowResume:false carve-out (inherited from
// runVideoFull, unchanged), independently locatable if the two ever drift.
async function runClaimedRegeneration(ad, req = {}) {
  const adId      = String(ad._id);
  const kind      = req.kind || ad.kind || 'image';
  const prompt    = req.prompt || '';
  const startedAt = Date.now();

  // ── MONEY — re-check the two gates that can go stale while queued ──────
  // preflight() already ran in the backend before the 202, but that used to
  // be milliseconds before execution (setImmediate); on the deferred path
  // it can now be minutes (this consumer polls every ~2s AND a video
  // regenerate ahead of this one in the queue can occupy the worker for
  // several minutes — see the file's own header on why there is no
  // concurrency here). Two of preflight's four gates can genuinely change
  // in that window and must be re-checked before spending money:
  //   - metaSyncStatus can flip to 'synced' if the operator exports to Meta
  //     while this request was queued — regenerating would silently
  //     overwrite the now-canonical exported asset.
  //   - derive-only status doesn't change on an existing ad, but is
  //     cheap to re-check and the shared gate is the single source of
  //     truth for "this ad has no generation of its own" — re-deriving it
  //     here rather than trusting a queued decision costs nothing.
  // already-regenerating and the daily cap do NOT need re-checking: the
  // lock is still held (that's how we got claimed) and the cap was already
  // consumed at lock time. Fails CLOSED — markComplete('failed'), no
  // provider call — same shape as the original preflight 409s, just
  // surfaced through regenerationHistory instead of an HTTP response
  // (nobody is holding an open connection to return a 409 to).
  //
  // ── AND the in-flight-render gate, which is a THIRD kind of staleness ──
  // Unlike the cap and the `regenerating` lock, the ad's RENDER state can
  // genuinely change while this request sits queued — and it is the one gate
  // whose failure costs a duplicate provider submit rather than a stale
  // decision. It is also the only gate on this path that fires at all: backend
  // refuses these shapes at the 202 (PR #349), but minutes can pass between
  // that check and this execution, during which the row can be reaper-requeued
  // to 'queued', re-claimed to 'rendering', or land in titling. This is the
  // LIVE adgen-side gate; preflight()'s copy above is parity-only.
  //
  // ⚠️ THIS IS NOT ENFORCED ON regenerateConsumer's CLAIM FILTER, deliberately.
  // Making claimOne skip in-flight rows would leave the request stamped
  // `regenerating:true` and unclaimed forever — a stuck row with no operator
  // feedback, which is worse than a refusal. A queue consumer's correct shape
  // is to claim, then refuse at execute time via markComplete so the lock is
  // released and the reason lands in regenerationHistory. Backend's copy ANDs
  // the rule into its atomic lock instead, because there a caller is still
  // holding a connection that can receive the 409.
  //
  // ⚠️ `status` IS LOAD-BEARING IN THIS SELECT. Mongoose returns only projected
  // paths, so dropping any field inFlightRefusal reads turns this gate into a
  // silent no-op that still prints green. Pinned by group B of
  // scripts/verifyRegenerateInFlightGate.js, which captures the select string
  // at runtime and honours the projection.
  //
  // veoPredictionId also rides along on this EXISTING query (no extra round
  // trip) so the receipt gate below judges FRESH database state. Reading it
  // off the in-memory claimed doc instead would widen the still-alive-worker
  // race: a reclaimed row whose original worker submitted after the
  // reclaim's findOneAndUpdate would still look receipt-free here.
  const staleCheck = await Ad.findById(adId)
    .select(`metaSyncStatus platformFormat deriveFromMaster veoPredictionId ${IN_FLIGHT_SELECT}`)
    .lean();
  if (staleCheck?.metaSyncStatus === 'synced') {
    console.log(`🔀 regenerate-consumer[ad=${adId}]: refused at execute time — exported to Meta while queued`);
    await markComplete(adId, {
      status: 'failed', durationMs: Date.now() - startedAt,
      error: 'Ad was exported to Meta while this regenerate was queued — regeneration refused (the synced version is canonical).'
    });
    return;
  }
  const derivedFrom = staleCheck ? resolveDeriveFromMaster(staleCheck) : null;
  if (derivedFrom) {
    console.log(`🔀 regenerate-consumer[ad=${adId}]: refused at execute time — derive-only (${derivedFrom})`);
    await markComplete(adId, {
      status: 'failed', durationMs: Date.now() - startedAt,
      error: `This ad is derived from the already-paid ${derivedFrom} master (it has no generation of its own) — regenerate that master instead.`
    });
    return;
  }
  // ⚠️ MONEY — THE LIVE IN-FLIGHT-RENDER GATE. This is the one that actually
  // fires in this repo (preflight()'s copy is parity-only — see its note).
  // Placed after the two permanent refusals so those keep owning the message
  // when both apply, and BEFORE progressService/startRun so a refusal costs
  // nothing and leaves no orphan run.
  const inFlight = inFlightRefusal(staleCheck);
  if (inFlight) {
    await unwindInFlightRefusal(adId, startedAt, inFlight);
    return;
  }

  const reclaimCount = Number(req.reclaimCount || 0);

  // ⚠️ MONEY — DEFENCE IN DEPTH against claimOne arm 2's baseline predicate
  // drifting away from this gate. Arm 2's filter already refuses to lease a row
  // with no baseline; if that predicate is ever weakened, a reclaimed row would
  // arrive here unjudgeable and fall through to a fresh billable submit. Fail
  // closed instead, loudly.
  if (reclaimCount > 0 && !req.priorVeoPredictionSetAt) {
    const error =
      'Regenerate was reclaimed after a lease expiry but carries no receipt baseline, ' +
      'so it cannot be proven safe to resubmit — refusing. Needs manual review.';
    console.error(`❌ regenerate-consumer[ad=${adId}]: ${error}`);
    await markComplete(adId, { status: 'failed', durationMs: Date.now() - startedAt, error });
    try {
      require('./alertService').notifyAsync({
        level: 'error',
        title: 'Regenerate reclaimed with no receipt baseline — not resubmitting',
        key:   `regenerate-no-baseline:${adId}`,
        fields: { adId, kind, reclaimCount }
      });
    } catch (alertErr) {
      console.warn(`🔁 regenerate[ad=${adId}]: no-baseline alert failed — ${alertErr.message}`);
    }
    return;
  }

  // ── MONEY — RECEIPT GATE (reclaim-only; never a generateForAd resume) ──
  // A regenerate always runs on an ad that already holds a previously-completed
  // video, so Ad.veoPredictionId is essentially ALWAYS populated before a
  // regenerate begins — it holds the OLD prediction. "A receipt exists" cannot
  // mean "this attempt paid for something": resuming on that basis would poll
  // the OLD completed prediction, return the OLD video, and report success
  // while handing the operator back the exact video they wanted replaced. That
  // is why runVideoFull's allowResume:false literal is frozen (commit 2f99218 /
  // PR #40, pinned by scripts/verifyVideoResumeFromReceipt.js C2) and why this
  // gate does NOT widen it — the check lives here, on the reclaim path, which
  // is the only place a stale-but-genuine receipt can exist.
  //
  // claimOne arm 1 snapshotted veoPredictionId at the FIRST claim, before that
  // attempt could touch it. A NEW id — unequal to that baseline, and only when
  // the baseline was actually captured — is the ONLY positive proof that the
  // abandoned attempt minted its own Atlas receipt. Anything else falls through
  // to today's dispatch, byte-for-byte unchanged (crash-before-submit, every
  // static regenerate, every row with no baseline).
  const currentPredictionId = staleCheck?.veoPredictionId ?? null;
  const hasFreshReceipt = kind === 'video'
    && !!req.priorVeoPredictionSetAt
    && !!currentPredictionId
    && String(currentPredictionId) !== String(req.priorVeoPredictionId || '');

  if (hasFreshReceipt) {
    // Lazy-required, DELIBERATELY not top-level (see the module-header
    // comment near the other requires). atlasVideoService.js top-level
    // `require('../models/Campaign')` — pulling that into this file's own
    // top-level require graph broke scripts/verifyRegenerateInFlightGate.js's
    // mongoose-stub interception window at module-load time
    // (`TypeError: Cannot read properties of undefined (reading 'Types')`,
    // bisected to this exact require). Every other lazy require in this file
    // (./alertService, ./progressService, ../models/Brand) follows the same
    // pattern for the same reason: keep this file's own top-level require
    // graph narrow so a sibling harness's stub window isn't forced open by a
    // dependency this path only needs when hasFreshReceipt is actually true.
    const {
      resumeForAd,
      reconcileVideoCostFromTerminal,
      resolveFailureCostReconcile
    } = require('./atlasVideoService');
    // resumeForAd → peekPrediction: one free GET, structurally incapable of
    // submitting. Pass the FRESH receipt, not the claimed doc's stale copy.
    let peek;
    try {
      peek = await resumeForAd({ ad: { veoPredictionId: currentPredictionId } });
    } catch (peekErr) {
      console.warn(
        `🔁 regenerate[ad=${adId}]: resumeForAd threw on receipt ${currentPredictionId} — ${peekErr.message} ` +
        '(failing closed: not submitting, not completing; the next lease expiry re-peeks)'
      );
      return;
    }

    if (peek.state === 'done' && peek.videoUrl) {
      // ⚠️ MONEY — WE OWN A PAID MASTER. The invariant this branch exists to
      // hold is "never submit again", and that is satisfied by returning here.
      //
      // WHAT THIS DELIBERATELY DOES NOT DO, after adversarial review (both
      // passes flagged it): it does not overwrite renderUrl / posterUrl and does
      // not hand off to titling. peek.videoUrl is Atlas's raw outputs[0] URL.
      // The normal path never persists that — generateForAd downloads it and
      // mirrors it to Cloudinary before it ever reaches the Ad doc, and
      // resumeForAd is documented as NOT doing that. So writing it to renderUrl
      // would replace a stable Cloudinary asset with a provider URL that
      // expires, on an ad that already has a perfectly good render. It would
      // also ship untitled: titlingResumeService.buildResumeFilter requires
      // status:'draft', and regenerate never writes Ad.status, so a live ad
      // would never auto-title and would silently lose its chrome and its QC.
      //
      // veoVideoUrl IS stamped, because that is the provenance trail for the
      // prediction we paid for, and it is what makes the recovery actionable.
      // Collecting the asset properly (download + Cloudinary mirror + titling)
      // is a real follow-up, not something to improvise on a money path.
      console.log(
        `🔁 regenerate[ad=${adId}]: receipt ${peek.predictionId} is DONE — recording the paid master, ` +
        'NOT resubmitting and NOT overwriting the existing render (needs collection)'
      );
      try {
        await Ad.updateOne(
          { _id: adId, regenerateClaimedByWorker: ad.regenerateClaimedByWorker || null },
          { $set: { veoVideoUrl: peek.videoUrl, updatedAt: new Date() } }
        );
      } catch (stampErr) {
        console.warn(
          `🔁 regenerate[ad=${adId}]: could not record the recovered master — ${stampErr.message}`
        );
      }
      reconcileVideoCostFromTerminal(peek.predictionId, { price: peek.price ?? null });
      // The alert IS the handoff. Deliberately not markComplete'd: completing
      // would null regenerationRequest (the baseline with it) and the claim,
      // making the paid master unrecoverable by any later pass. Leaving the row
      // claimed means the lease re-peeks it, and the reclaim ceiling eventually
      // terminals it with this same alert already on the record.
      try {
        require('./alertService').notifyAsync({
          level: 'warn',
          title: 'Regenerate recovered a PAID video master — needs collection',
          key:   `regenerate-master-needs-collection:${adId}:${peek.predictionId}`,
          fields: {
            adId, kind, predictionId: peek.predictionId,
            atlasVideoUrl: peek.videoUrl,
            price: peek.price ?? null,
            reclaimCount,
            note: 'not resubmitted; renderUrl left intact because the Atlas URL is unmirrored and expires'
          }
        });
      } catch (alertErr) {
        console.warn(`🔁 regenerate[ad=${adId}]: needs-collection alert failed — ${alertErr.message}`);
      }
      return;
    }

    if (peek.state === 'processing') {
      // Paid and STILL RENDERING. Do not submit, and deliberately do NOT
      // markComplete — that clears regenerationRequest (the baseline with it)
      // and would abandon a live paid render. Leave the row; the next lease
      // expiry re-peeks, bounded by MAX_RECLAIMS.
      console.log(
        `🔁 regenerate[ad=${adId}]: receipt ${peek.predictionId} is still PROCESSING — ` +
        `not submitting, not completing; next lease expiry re-peeks (reclaimCount=${reclaimCount})`
      );
      return;
    }

    // peekPrediction spreads confirmedCharge(data), which returns
    // { charged, priceUsd } — NOT { chargeConfirmed, chargePriceUsd }. Reading
    // the wrong names here silently disables this branch (undefined === false
    // is false), which would terminal-fail every genuinely retryable render.
    if (peek.state === 'failed' && peek.charged === false) {
      // Atlas's own settled record confirms NO price: genuinely unbilled, so a
      // fresh submit is safe. Correct the ledger first, then fall through to
      // today's dispatch — which still submits via runVideoFull's frozen
      // allowResume:false.
      console.log(
        `🔀 regenerate[ad=${adId}]: receipt ${peek.predictionId} FAILED UNBILLED ` +
        `(charged=false, policy=${peek.policy || 'n/a'}) — falling through to a fresh submit`
      );
      const reconcile = resolveFailureCostReconcile({
        chargeConfirmed: peek.charged, chargePriceUsd: peek.priceUsd
      });
      if (reconcile) {
        reconcileCost({
          providerRequestId: peek.predictionId,
          costUsd:           reconcile.costUsd,
          costSource:        reconcile.costUsd === 0 ? 'none' : 'actual'
        }).catch((e) => console.warn(`🔁 regenerate[ad=${adId}]: cost reconcile failed — ${e.message}`));
      }
      // fall through to the normal dispatch below
    } else if (peek.state === 'failed') {
      // charged === true, or null/undefined (including the completedNoOutput
      // shape, which spreads no charge fields at all). UNKNOWN IS TREATED AS
      // CHARGED — this repo's standing rule: a non-charge may only be asserted
      // from a confirmed price. No submit.
      const chargeState = String(peek.charged);
      const error =
        `The previous regenerate attempt's Atlas prediction ${peek.predictionId} failed with ` +
        `charged=${chargeState}${peek.policy ? ` (policy ${peek.policy})` : ''}` +
        `${peek.message ? ` — ${peek.message}` : ''}. Not resubmitting.`;
      console.error(`❌ regenerate[ad=${adId}]: ${error}`);
      const reconcile = resolveFailureCostReconcile({
        chargeConfirmed: peek.charged, chargePriceUsd: peek.priceUsd
      });
      if (reconcile) {
        reconcileCost({
          providerRequestId: peek.predictionId,
          costUsd:           reconcile.costUsd,
          costSource:        reconcile.costUsd === 0 ? 'none' : 'actual'
        }).catch(() => {});
      }
      await markComplete(adId, { status: 'failed', durationMs: Date.now() - startedAt, error });
      try {
        require('./alertService').notifyAsync({
          level: 'error',
          title: 'Regenerate: paid prediction failed — not resubmitting',
          key:   `regenerate-receipt-failed:${adId}:${peek.predictionId}`,
          fields: {
            adId, kind, predictionId: peek.predictionId, charged: chargeState,
            policy: peek.policy || null, message: peek.message || null, reclaimCount
          }
        });
      } catch (alertErr) {
        console.warn(`🔁 regenerate[ad=${adId}]: receipt-failed alert failed — ${alertErr.message}`);
      }
      return;
    } else {
      // 'unknown' (a transport error told us nothing) or an unclassifiable
      // shape. FAIL CLOSED: no submit, no markComplete. The next bounded
      // reclaim re-peeks.
      console.warn(
        `🔁 regenerate[ad=${adId}]: receipt peek state=${peek.state || 'n/a'}` +
        `${peek.message ? ` (${peek.message})` : ''} — failing closed: not submitting, ` +
        `not completing; next lease expiry re-peeks (reclaimCount=${reclaimCount})`
      );
      return;
    }
  }

  // ── MONEY — BOUNDED RECLAIM CEILING (gates the SUBMIT, not the COLLECT) ─
  // Reached on exactly the two routes that go on to spend money: a reclaim with
  // no proven-fresh receipt, and a reclaim whose receipt Atlas confirmed was
  // never billed. A lease that reclaimed forever would bill a fresh submit every
  // ADGEN_REGEN_CLAIM_STALE_MIN indefinitely, so this ceiling is what keeps
  // lease expiry strictly better than the status quo on money, and turns a
  // crash-looping row into a bounded, loud, terminal one.
  //
  // DELIBERATELY AFTER THE RECEIPT PEEK. An earlier draft checked this at
  // function entry, which adversarial review caught as a real defect: a row
  // holding a PAID prediction whose peek kept returning 'processing' or
  // 'unknown' (Atlas 5xx, a timeout, a missing API key) would be terminal-failed
  // on the Nth reclaim without ever being peeked again — discarding a paid
  // master and wiping the baseline, when the entire purpose of those branches is
  // to keep the row claimable until a later peek can collect it. The ceiling
  // must bound RESUBMITS, never COLLECTS.
  //
  // Enforced here rather than in claimOne arm 2's filter so an exhausted row
  // settles into an honest terminal state instead of silently dropping out of
  // the claimable population — filter-side silence is the defect this whole
  // change exists to remove.
  if (reclaimCount > MAX_RECLAIMS) {
    const error =
      `Regenerate abandoned after ${reclaimCount} reclaim attempts ` +
      `(ceiling ${MAX_RECLAIMS}) — refusing to submit again. Needs manual review.`;
    console.error(`❌ regenerate-consumer[ad=${adId}]: ${error}`);
    await markComplete(adId, { status: 'failed', durationMs: Date.now() - startedAt, error });
    try {
      require('./alertService').notifyAsync({
        level: 'error',
        title: 'Regenerate reclaim ceiling exceeded — not resubmitting',
        key:   `regenerate-reclaim-ceiling:${adId}`,
        fields: { adId, kind, reclaimCount, maxReclaims: MAX_RECLAIMS, worker: ad.regenerateClaimedByWorker || null }
      });
    } catch (alertErr) {
      console.warn(`🔁 regenerate[ad=${adId}]: reclaim-ceiling alert failed — ${alertErr.message}`);
    }
    return;
  }

  const { startRun, CancelledError } = require('./progressService');
  const brandDoc = ad.brandId
    ? await require('../models/Brand').findById(ad.brandId).select('advertiserId').lean().catch(() => null)
    : null;
  const progressRun = await startRun({
    kind: 'ad-regenerate', advertiserId: brandDoc?.advertiserId, brandId: ad.brandId,
    label: kind === 'video' ? 'Video ad regenerate' : 'Ad regenerate'
  });

  try {
    let videoOutcome = null;
    if (kind === 'video') {
      videoOutcome = await runVideoFull(adId, prompt, progressRun, req.videoModel || null, {
        videoPromptRaw:      req.videoPromptRaw || null,
        videoPromptGuidance: req.videoPromptGuidance || null
      });
    } else {
      const imagePromptRaw = req.imagePromptRaw || null;
      const promptOverride = req.promptOverride || null;
      if (imagePromptRaw && prompt.trim()) {
        console.log(
          `🔁 regenerate[ad=${adId}]: refinement IGNORED — imagePromptRaw replaces the whole prompt`
        );
      }
      await runImage(adId, prompt, progressRun, imagePromptRaw || promptOverride);
    }

    const durationMs = Date.now() - startedAt;
    await markComplete(adId, { status: 'done', durationMs });
    // Cascade AFTER markComplete — see regenerateAd's matching call.
    // regenerateClaimedAt is never heartbeat'd; holding the claim across
    // N sequential Remotion sibling composites can trip a reclaim that
    // overwrites the master's Cloudinary-mirrored veoVideoUrl with an
    // expiring Atlas outputs[0] URL.
    if (videoOutcome && videoOutcome.shouldCascade) {
      await cascadeRegenerateToDerivatives(adId, { progressRun });
    }
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
    // A late in-flight refusal is not a crash. Route it through the SAME
    // unwind the execute-time gate uses so the ad row settles identically,
    // and so it cannot fall through into a second markComplete below.
    if (err instanceof InFlightRefusalError) {
      await unwindInFlightRefusal(adId, startedAt, err, progressRun);
      return;
    }
    // ⚠️ MONEY — AN UNSETTLED POLL TIMEOUT IS NOT A CONFIRMED FAILURE, AND
    // MUST NOT GO THROUGH markComplete. Set by atlasVideoService's
    // resolveTimeoutOutcome (atlasVideoService.js:4409-4422) when
    // generateForAd's poll hits MAX_POLL_MS (atlasVideoService.js:559) while
    // Atlas's own final free peek still says 'processing'/'unknown' — Atlas
    // may genuinely still be rendering a master this attempt already paid
    // for (veoPredictionId is stamped at the charge point before polling, so
    // a receipt can exist even though the throw carries no video).
    //
    // markComplete (used by every other branch here) does ONE $set that
    // clears regenerating, regenerationRequest — THE RECLAIM BASELINE
    // (priorVeoPredictionId / priorVeoPredictionSetAt) LIVES INSIDE THAT
    // FIELD — and both claim markers, all at once. Calling it here would
    // terminal-fail the row before the 45-minute lease this PR adds could
    // ever engage on exactly the case it exists for: the row would look
    // permanently failed, indistinguishable from a real failure, with no
    // baseline left for a later reclaim to judge a resubmit against.
    //
    // THE FIX: do nothing to the Ad document at all. In particular, do NOT
    // null out regenerateClaimedByWorker/regenerateClaimedAt either — that
    // would route the row through claimOne's ARM 1 (fresh claim) on the very
    // next regenerate-consumer tick, and arm 1 UNCONDITIONALLY RE-SNAPSHOTS
    // the baseline onto whatever veoPredictionId is on the ad right now
    // (regenerateConsumer.js claimOne, the post-`fresh` baseline write) —
    // which, on this exact error, is the id THIS timed-out attempt just
    // stamped. That would silently overwrite the true "what existed before
    // this regenerate began" baseline with the very receipt the reclaim path
    // is supposed to be judging, collapsing hasFreshReceipt to false on the
    // next pass and reopening a blind resubmit. (Traced and confirmed before
    // writing this: this is precisely the shape of the double-billing
    // incident this PR exists to close.)
    //
    // Leaving every claim field untouched is what makes the row eligible for
    // ARM 2 (reclaim-after-lease-expiry) instead of arm 1 once
    // regenerateClaimedAt ages past CLAIM_STALE_MIN — arm 2 deliberately
    // never restamps the baseline (regenerateConsumer.js claimOne, "arm 2
    // does NOT restamp"), so runClaimedRegeneration's receipt gate sees the
    // ORIGINAL pre-regenerate veoPredictionId as `priorVeoPredictionId` and
    // can correctly detect a fresh receipt via resumeForAd (a free GET that
    // structurally cannot submit) before anything considers a resubmit. This
    // is the SAME posture regenerateConsumer.js's drainOnShutdown already
    // takes on SIGTERM ("This does NOT release the claim ... the lease
    // reclaims it ... and the receipt check then decides whether a resubmit
    // is legal") — this branch is the equivalent for an in-process timeout
    // rather than a process death.
    if (err && err.leaseExhausted) {
      // Cap miss BEFORE submit. Nothing billed, no new receipt. Do NOT
      // markComplete('failed') — that is never picked up again. Leave the
      // regenerate claim in place so claimOne's ARM 2 (reclaim after
      // CLAIM_STALE_MIN) retries, bounded by MAX_RECLAIMS. Releasing here
      // would send the row through ARM 1 on the next ~2s poll, which is a
      // tight retry loop (generateForAd already slept its internal
      // backoff, but ARM 1 also restamps the receipt baseline for no
      // reason). Parking on the existing 45-min lease is the same family
      // as the unsettled poll-timeout branch below. renderer.js, which
      // has no 45-min regenerate claim, terminal-fails after the same
      // internal budget — a persisted counter there collided with
      // strandedRunSweeper.
      console.warn(
        `🔁 regenerate[ad=${adId}]: gemini lease exhausted after ${Math.round(durationMs / 1000)}s ` +
        '— NOT terminal-failing: leaving the regenerate claim so the 45-minute lease can retry. ' +
        'Nothing was submitted.'
      );
      try {
        require('./alertService').notifyAsync({
          level: 'warn',
          title: 'Regenerate waiting on Gemini concurrency cap',
          key:   `regenerate-lease-wait:${adId}`,
          fields: {
            adId, kind,
            note: 'claim left in place; lease reclaim retries; nothing billed'
          }
        });
      } catch (alertErr) {
        console.warn(`🔁 regenerate[ad=${adId}]: lease-exhausted alert failed — ${alertErr.message}`);
      }
      return;
    }
    if (err && err.unsettledAtTimeout) {
      console.warn(
        `🔁 regenerate[ad=${adId}]: unsettled at Atlas poll timeout after ${Math.round(durationMs / 1000)}s ` +
        `(receipt ${err.predictionId || 'unknown'}) — Atlas may still be rendering. NOT terminal-failing: ` +
        'leaving the claim and the reclaim baseline untouched so the 45-minute lease can reclaim this row and ' +
        're-peek the receipt via resumeForAd before anything resubmits.'
      );
      // ⚠️ MONEY — BACKFILL THE RECEIPT IF THE CHARGE POINT DID NOT.
      // atlasVideoService's veoPredictionId $set at the charge point is
      // deliberately best-effort (wrapped in its own non-fatal try/catch —
      // "a telemetry or bookkeeping failure must never fail a generation
      // post-payment"). So a genuinely-billed prediction can exist ONLY on
      // this thrown error (err.predictionId) if that write failed. Without
      // this backfill, Ad.veoPredictionId would still read the PRE-regenerate
      // baseline id 45 minutes from now when arm 2 reclaims: `hasFreshReceipt`
      // compares the ad's CURRENT veoPredictionId against the baseline, they
      // would look IDENTICAL (nothing changed the current one), the receipt
      // gate would be skipped entirely, and the reclaim would fall straight
      // through to a brand-new billable generateForAd — while this attempt's
      // prediction may still be actively rendering (or already delivered) at
      // Atlas. Found by adversarial review (Grok xhigh) — this is the same
      // class of gap renderer.js's settleUnsettledVideoTimeout already closes
      // on the mint-time hold branch, adapted here: that code gates on
      // `veoPredictionId: {$in:[null,'']}` because a fresh mint starts empty;
      // a regenerate's veoPredictionId is essentially ALWAYS already populated
      // (it holds the old master), so gating on "empty" would never fire here.
      // Instead this ALWAYS (re)stamps THIS attempt's own predictionId — safe
      // even if it overwrites a still-present older id, because that older id
      // already went through its own receipt-check pass to get here (nothing
      // reaches a SECOND submit without the first one having been peeked and
      // reconciled as unbilled). The write touches ONLY veoPredictionId — never
      // regenerationRequest (the baseline) and never the claim fields — so it
      // cannot trip the arm-1-restamp trap the rest of this branch exists to
      // avoid. Claim-scoped (regenerateClaimedByWorker) so a row a DIFFERENT
      // worker has already reclaimed in the meantime is left untouched rather
      // than clobbered. Best-effort: a failure here must not turn an already
      // money-safe park into an exception.
      if (err.predictionId && ad.regenerateClaimedByWorker) {
        try {
          await Ad.updateOne(
            { _id: adId, regenerateClaimedByWorker: ad.regenerateClaimedByWorker },
            { $set: { veoPredictionId: err.predictionId } }
          );
        } catch (backfillErr) {
          console.warn(
            `🔁 regenerate[ad=${adId}]: could not backfill veoPredictionId=${err.predictionId} — ` +
            `${backfillErr.message}; the next reclaim's receipt gate may not see this attempt's own submit`
          );
        }
      }
      try {
        require('./alertService').notifyAsync({
          level: 'warn',
          title: 'Regenerate unsettled at poll timeout — awaiting lease reclaim',
          key:   `regenerate-unsettled:${adId}`,
          fields: {
            adId, kind, predictionId: err.predictionId || null,
            note: 'claim + baseline intentionally left in place; the lease reclaims and re-peeks before any resubmit'
          }
        });
      } catch (alertErr) {
        console.warn(`🔁 regenerate[ad=${adId}]: unsettled-timeout alert failed — ${alertErr.message}`);
      }
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
async function loadBrand(adId) {
  const ad = await Ad.findById(adId).select('mediaId').lean();
  const media = ad?.mediaId ? await Media.findById(ad.mediaId).select('brandId').lean() : null;
  // brandReviews is load-bearing for the proof beat — see the same note in
  // routes/ads.js. Without it buildMetaForAd's brandPair is null and every
  // regenerated ad loses its stars AND its review count, even for brands that
  // clear the >4.5 gate. Pinned by scripts/verifyProofBeat.js P1.
  return media?.brandId
    ? await Brand.findById(media.brandId)
        .select('name styleScript styleScriptVertical styleScriptLandscape styleTheme tagline logoUrl websiteUrl primaryColor secondaryColor accentColor fontFamily fontSource curatedFields tailwindTheme websiteFontUsage customFonts videoSettings titleStyleSpec titleStylePreset brandReviews').lean()
    : null;
}

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
    //
    // allowResume: false — EXPLICIT, not the default. A regenerate is an
    // operator-requested NEW video on the SAME Ad doc, and this path never
    // clears the previous veoPredictionId (adForGen still carries it). If
    // generateForAd's resume-from-receipt gate ran here with its default
    // (true), it would silently serve the OLD master back instead of
    // submitting the new one the operator asked for and paid for — the
    // regenerate would appear to do nothing. See atlasVideoService.js's
    // shouldResumeAttempt doc comment for the full reasoning.
    // MONEY — last gate before the billable Omni submit. Everything between
    // runClaimedRegeneration's execute-time check and here (UGC, storyboard
    // prep, a possible layout rebuild) is a yield the reaper / claimAdsForRun
    // / titlingResumeService can win.
    await assertNotInFlightBeforeSubmit(adId);
    veoResult = await veoService.generateForAd({
      ad: adForGen,
      operatorPrompt,
      storyboard,
      modelOverride: videoModel,
      allowResume: false
    });
    if (veoResult.skipped) {
      // A Gemini cap-miss is NOT a failure. generateForAd returns
      // {skipped:true, retryable:true, code:'GEMINI_LEASE_EXHAUSTED'} when
      // lease.acquire() is null after bounded internal backoff — nothing
      // was billed. Throwing a plain Error here used to fall through to
      // markComplete(status:'failed'), which is never re-claimed. Throw a
      // tagged error so runClaimedRegeneration's catch can park the row
      // the same way it parks an unsettled poll timeout.
      if (veoResult.retryable || veoResult.code === 'GEMINI_LEASE_EXHAUSTED') {
        const err = new Error(veoResult.reason || 'gemini video: no slot available');
        err.leaseExhausted = true;
        err.code = veoResult.code || 'GEMINI_LEASE_EXHAUSTED';
        throw err;
      }
      throw new Error(`Veo skipped: ${veoResult.reason}`);
    }
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

  // Stage 3 — brand-script canvas overlay. Resolver picks the right
  // script by format; returns skipped when no chrome is configured
  // (raw Grok video stays as renderUrl in that case). Failure is
  // non-fatal for the same reason.
  if (progressRun) { await progressRun.checkpoint(); progressRun.stage('compositing'); }
  await setStage(adId, 'composite');
  const brand = await loadBrand(adId);
  // Snapshot visionQc BEFORE this pass's QC writers run. qcAndStampVideoAd's
  // own catch (brandScriptExecutor) swallows a failure and returns null
  // WITHOUT writing visionQc — a blind re-read would then treat the PREVIOUS
  // render's verdict as this regenerate's. Fail-closed: no fresh write from
  // this pass means not-promotable and not-cascadable.
  const qcBefore = JSON.stringify(ad1?.visionQc || null);
  // ⚠️ retitleMode is NOT passed here. An earlier draft of this PR set
  // `retitleMode = (priorStatus !== 'failed')` to stop uploadRenderAndStamp
  // from silently un-publishing an already-'live' ad (a REAL, confirmed,
  // still-live production bug). That expansion introduced three worse
  // defects: it stripped QC-failure quarantine on draft/live regenerates,
  // it skipped stampTitlingFailureAndThrow so a Remotion OOM/timeout left
  // an untitled raw master with no resume arm, and it only covered one of
  // this function's three QC-writing branches. Reverted to pre-PR behaviour
  // (preserveAdStatus:false default). The un-publish-on-live-regenerate bug
  // remains OPEN — it needs its own dedicated fix that threads a correctly
  // scoped preserveAdStatus through ALL three branches, with tests, not a
  // retitleMode reuse. recascadeDerivativeSibling still passes
  // retitleMode:true: that path is a background re-sync of already-shipped
  // siblings, which is the original retitleMode contract.
  if (brand) {
    const adFinal = await Ad.findById(adId).lean();
    try {
      await brandScriptExecutor.renderBrandScriptAndSave({ ad: adFinal, brand });
    } catch (scriptErr) {
      console.warn(`🔁 regenerate[ad=${adId}]: brand-script failed (non-fatal) — ${scriptErr.message}`);
      // Chrome/titling threw before ever reaching uploadRenderAndStamp, so
      // vision QC never ran on this render either — and because this catch
      // is deliberately non-fatal (the raw master, already stamped as
      // renderUrl above, is a perfectly good fallback), the ad keeps
      // looking "delivered" with a brand new render nobody inspected. QC
      // the raw plate now so an operator can tell "titling failed but this
      // was checked" from "titling failed and nobody looked".
      await brandScriptExecutor.qcAndStampVideoAd({ ad: adFinal, deliveredUrl: veoResult.videoUrl, brandName: brand?.name || null });
    }
  } else {
    // NO BRAND RESOLVED — this never reaches renderBrandScriptAndSave, so it
    // never reaches vision QC either (uploadRenderAndStamp and the
    // no-chrome branch both live inside renderBrandScriptAndSave's call
    // graph). The raw regenerated master ships as renderUrl regardless
    // (stamped above); without this it would ship with NO Ad.visionQc at
    // all — same gap as the two no-brand branches in routes/ads.js.
    // qcAndStampVideoAd never forces 'draft' on success (only ever stamps
    // status on a REAL QC failure — buildVideoQcFailureFields), so there is
    // no un-publish hazard on this branch.
    const adFinal = await Ad.findById(adId).lean();
    await brandScriptExecutor.qcAndStampVideoAd({ ad: adFinal, deliveredUrl: veoResult.videoUrl });
  }

  // ── Fix — status promotion on a genuinely successful regenerate ────────
  // Read back the visionQc THIS regenerate just persisted. Reuse
  // buildVideoQcFailureFields's own predicate (the exact function that
  // decides "real QC failure" for the shared terminal write) instead of
  // re-deriving it. Fail-closed on a missing/unchanged verdict: see
  // qcBefore above. Cascade is NOT invoked here — the caller runs it
  // after markComplete so it cannot trip the 45-min regenerate reclaim.
  const settledAd = await Ad.findById(adId).select('status visionQc').lean();
  const qcAfter = JSON.stringify(settledAd?.visionQc || null);
  const qcFresh = qcAfter !== qcBefore && settledAd?.visionQc != null;
  const qcJustFailed = !!brandScriptExecutor.buildVideoQcFailureFields(settledAd?.visionQc).status;
  if (qcFresh && !qcJustFailed) await promoteFailedToDraft(adId);
  return { shouldCascade: qcFresh && !qcJustFailed };
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
// false) stamp — but that stamp is UNCONDITIONAL (any prior status ->
// 'draft'), which is unsafe on a 'live' ad (silently un-publishes it).
// An earlier draft of this PR tried to paper over that with a
// conditional retitleMode on runVideoFull; that was reverted (see the
// comment at runVideoFull's brand branch). The un-publish-on-live-
// regenerate bug is REAL and still live in production — a follow-up,
// not this helper's job. This helper restores the INTENT (promote a
// genuinely-successful regenerate off 'failed') without that hazard: it
// only ever writes 'failed' -> 'draft', gated in the query itself,
// never a blanket stamp. Backend's 2026-08-28 titling removal (commit
// abf7e0c2) happened to also remove backend's ONLY call into the
// unconditional stamp from its copy of this file — collateral, not the
// intent.
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
// zero-Atlas/Omni derivative siblings ───────────────────────────────────
//
// ⚠️ MONEY — ZERO Atlas/Omni spend in this function or anything it calls,
// STRUCTURALLY: neither this function nor recascadeDerivativeSibling below
// requires or calls veoService / atlasVideoService. A derivative ad's whole
// reason to exist is that it never pays for its own plate (resolveDeriveFrom
// Master / routes/ads.js's renderDeriveOnlyVideoAd, the mint-time reference
// for this exact copy) — after a master regenerates, its siblings are
// re-composited from the NEW master plate the same way, never re-submitted.
// Not "free" unqualified: each sibling still costs a face-detection LLM
// call (basePlate is $unset to force recomputation), a vision-QC judge
// call, a Remotion slot (~1.97 GiB), and a Cloudinary upload. Sibling
// count is capped (MAX_CASCADE_SIBLINGS) so a mixed Meta+PMax family
// cannot fan those out unboundedly.
//
// findDerivativesOfMaster inverts findSiblingMasterAd's filter shape
// (routes/ads.js): every derivative row stamps deriveFromMaster to the
// master's OWN platformFormat (campaignAdsGenerationService.
// planDeterministicVideoAds — including same-format funnel-stage retitles,
// which derive from their own unstaged master format), and a true master
// row always carries deriveFromMaster:null, so this can never match the
// master's own document.
//
// IDENTITY FAMILY, not just campaign+product+format. The unique
// `(campaignId, identityDigest)` index does NOT mean one Ad per
// (campaign, product, platformFormat, funnelStage, kind).
// computeDeterministicVideoDigest ALSO hashes refKey (referenceMediaIds
// or mediaId), ctaText, ctaUrl, ctaUrlParams, videoPromptGuidance and
// videoPromptRaw, PLUS videoDurationSec for Google PMax video formats
// only. A second Generate on the same campaign+product with a
// different seed media, CTA, prompt, or (PMax) duration mints a SECOND
// master (M2) with its own live derive family (D2) — both families'
// derives stamp the identical deriveFromMaster (mint sites
// campaignAdsGenerationService planDeterministicVideoAds). Joining only
// on campaignId+productId+deriveFromMaster would CAS-write M1's plate
// onto D2. We join on the rest of that video identity (mediaId /
// referenceMediaIds, plus the CTA and prompt fields the digest uses,
// plus videoDurationSec when isGooglePmaxVideoFormat(master.platformFormat)).
// Meta duration is NOT joined — it can legitimately vary within a family,
// and joining it would under-match the same way campaignRunIds scoping did.
// funnelStage is NOT joined — siblings of one master have different
// stages by design.
//
// NOT scoped by campaignRunIds — tried in an earlier version of this fix
// and DELIBERATELY REMOVED after a second adversarial review pass (Grok,
// 2026-09-02) proved it wrong in the harmful direction. Masters are NOT
// $addToSet'd onto every run that logically depends on them the way
// queued rows are (routes/ads.js's claimAdsForRun only $addToSet's
// status:'queued' rows) — so a genuinely-current funnel-variant or
// new-format sibling minted in a LATER run than the master's own
// campaignRunIds snapshot would silently fail the
// {$in: masterAd.campaignRunIds} filter and never get recascaded. That
// is Fix 2 failing on an ordinary "Generate more / add funnel stages"
// flow. Do NOT restore campaignRunIds scoping; the identity-field join
// above is what stops a cross-family recascade.
//
// EXCLUDES (SIBLING_MID_FLIGHT_EXCLUSION, shared verbatim with the CAS
// write below): any sibling mid-flight elsewhere right now (regenerating,
// claimedByWorker, retitleClaimedByWorker, titlingNeeded — the last is the
// mint-time renderer->titler handoff marker, a DIFFERENT "claim released,
// work still owed" shape than claimedByWorker:null covers); any sibling
// still inside its OWN first-render/derive-wait lifecycle
// (status:'rendering'/'queued' — a requeued derive-only wait releases its
// claim but keeps status:'rendering', so claimedByWorker:null alone would
// still match it); and 'archived' — a retired ad's content is deliberately
// not refreshed by a background cascade the operator did not act on for
// that specific row. THIS IS A READ-TIME FILTER ONLY — the actual per-
// sibling write in recascadeDerivativeSibling re-asserts every one of these
// conditions as a CAS on the update itself, because a sibling can transition
// into any of these states in the window between this find() and that
// write (adversarial review, 2026-09-02).
//
// ⚠️ KNOWN RESIDUALS, NOT FIXED HERE:
// (1) The CAS above protects only the PROVENANCE write.
// recascadeDerivativeSibling does not hold any lease across the Remotion
// compositing window that follows — a manual retitle or a mint-time claim
// landing on this SAME sibling in that window is not blocked, and the
// eventual delivery write (uploadRenderAndStamp, filtered on {_id} alone,
// a shared function this file does not own) can still race it,
// last-write-wins. Not a money bug (zero Atlas/Omni; the derive-only
// regenerate refusal at preflight() already rules out a second Atlas
// submit either way) — the worst case is one of two valid composites
// winning over the other on a background re-sync the operator did not
// directly trigger. Closing it properly needs this cascade to acquire the
// SAME claim namespaces retitleConsumer / renderer / titler check
// (claimedByWorker AND retitleClaimedByWorker) for the whole compositing
// window, plus its own stale-claim reclaim sweep if this process crashes
// mid-hold — a real feature, deliberately out of scope for this PR rather
// than rushed.
// (2) A crash (or Remotion throw) mid-cascade leaves a silent
// provenance/delivery mismatch: the sibling's veoVideoUrl already points
// at the new master but renderUrl is still the old composite. There is
// no recovery arm that re-titles from that shape. Known-inconsistent
// transient state; a later master regenerate or a manual retitle repairs
// it. Documented rather than given a new sweeper in this PR.
const SIBLING_MID_FLIGHT_EXCLUSION = {
  regenerating:            { $ne: true },
  claimedByWorker:          null,
  retitleClaimedByWorker:   null,
  titlingNeeded:            { $ne: true },
  status:                   { $nin: ['rendering', 'queued', 'archived'] }
};

// Cap on how many siblings one master regenerate will recascade. Mixed
// Meta+PMax is ~14 derives of a Stories master; 24 leaves headroom without
// letting an unusual campaign unbounded-fan-out face-detection + QC +
// Remotion + Cloudinary (zero Atlas/Omni, not free). Env may raise; floor 1.
const MAX_CASCADE_SIBLINGS = Math.max(
  1,
  parseInt(process.env.ADGEN_REGEN_CASCADE_SIBLING_CAP, 10) || 24
);

// Treat null / undefined / '' as the same empty bucket so a lean() master
// (schema defaults NOT applied) still matches siblings minted with ''.
// NEVER put a JS `undefined` into a Mongo filter: mongoose keeps it through
// cast(), and the BSON serializer then DROPS the key, which is how an
// undefined platformFormat used to match every video ad in the
// campaign+product (including other paid masters).
function videoIdentityEmptyEq(value) {
  if (value == null || value === '') return { $in: [null, ''] };
  return value;
}

// Pure filter builder — exported so the harness can BSON-roundtrip the
// actual object we would send, not a stub's JS-equality idea of it.
// Returns null (caller must not query) when the master lacks the fields
// that give the query its selectivity.
function buildDerivativeFindFilter(masterAd) {
  if (!masterAd) return null;
  if (!masterAd.platformFormat) return null;
  if (!masterAd.campaignId) return null;
  if (masterAd.productId == null || masterAd.productId === '') return null;

  const refs = Array.isArray(masterAd.referenceMediaIds) && masterAd.referenceMediaIds.length
    ? masterAd.referenceMediaIds
    : null;
  if (!refs && (masterAd.mediaId == null || masterAd.mediaId === '')) return null;

  const filter = {
    campaignId:         masterAd.campaignId,
    productId:           masterAd.productId,
    deriveFromMaster:    masterAd.platformFormat,
    kind:                'video',
    _id:                 { $ne: masterAd._id },
    ctaText:             videoIdentityEmptyEq(masterAd.ctaText),
    ctaUrl:              videoIdentityEmptyEq(masterAd.ctaUrl),
    ctaUrlParams:        videoIdentityEmptyEq(masterAd.ctaUrlParams),
    videoPromptGuidance: videoIdentityEmptyEq(masterAd.videoPromptGuidance),
    videoPromptRaw:      videoIdentityEmptyEq(masterAd.videoPromptRaw),
    ...SIBLING_MID_FLIGHT_EXCLUSION
  };
  // Duration is digest-identity for Google PMax video formats only
  // (computeDeterministicVideoDigest :2911-2915). Meta families may
  // legitimately carry different durations; do not join there.
  if (isGooglePmaxVideoFormat(masterAd.platformFormat)) {
    filter.videoDurationSec = videoIdentityEmptyEq(masterAd.videoDurationSec);
  }
  if (refs) {
    filter.referenceMediaIds = refs;
  } else {
    filter.mediaId = masterAd.mediaId;
    // Same identity as the digest's "empty refs → hash mediaId" arm: a
    // sibling with a non-empty reference stack is a different family even
    // if mediaId (picks[0]) happens to match.
    filter.$or = [
      { referenceMediaIds: { $exists: false } },
      { referenceMediaIds: null },
      { referenceMediaIds: { $size: 0 } }
    ];
  }
  return filter;
}

async function findDerivativesOfMaster(masterAd) {
  const filter = buildDerivativeFindFilter(masterAd);
  if (!filter) return [];
  return Ad.find(filter).lean();
}

// The exact exclusion clauses findDerivativesOfMaster reads with, reused
// verbatim (via SIBLING_MID_FLIGHT_EXCLUSION) as the CAS filter on the
// sibling's own update below — ONE definition, so the read-time skip and
// the write-time claim can never drift apart (the same "one shared
// predicate" discipline resolveDeriveFromMaster and
// inFlightRefusal/notInFlight already use in this file).
function siblingStillEligible(sibling) {
  return { _id: sibling._id, ...SIBLING_MID_FLIGHT_EXCLUSION };
}

// Re-composite ONE derivative sibling from its master's freshly-regenerated
// plate. Mirrors routes/ads.js's renderDeriveOnlyVideoAd (the mint-time
// reference for this exact zero-Atlas/Omni copy) but for an ad that already exists and
// already shipped once, so this does not touch renderAttempts /
// deriveWaitAttempts (mint-time waiter bookkeeping) and does not wait for
// the master — the master is settled by construction (this runs from inside
// the master's OWN post-regenerate success path).
//
// ⚠️ renderUrl / posterUrl are NEVER written here except atomically together
// with a genuinely new, correctly-composited asset (adversarial review,
// 2026-09-02 — TWO independent Grok passes flagged the earlier version's
// preliminary renderUrl:masterAd.veoVideoUrl stamp as shipping the RAW,
// uncropped, untitled 9:16 master into a LIVE 1:1/4:5/Reels ad's renderUrl
// for the whole compositing window — and leaving it there permanently if
// Remotion then throws. veoVideoUrl/veoAspectRatio/etc are PROVENANCE
// fields (what this ad derives from) and are safe to update immediately;
// renderUrl/posterUrl are DELIVERY fields (what actually plays) and must
// only ever move forward together with a real composite:
//   - brand resolves + Remotion succeeds: uploadRenderAndStamp (inside
//     renderBrandScriptAndSave) writes renderUrl+posterUrl+visionQc in ONE
//     $set, same atomicity the master's own terminal stamp relies on —
//     unchanged by this fix.
//   - no brand configured, OR chrome/Remotion throws: there is no way to
//     produce a correctly-cropped, aspect-correct asset for this sibling's
//     surface (basePlateCropService's crop only runs INSIDE the Remotion
//     path) — so this sibling's renderUrl/posterUrl are left EXACTLY as
//     they were. Its provenance now points at the new master; its DELIVERED
//     video is untouched until a real composite can succeed for it (a later
//     master regenerate once a brand/chrome is configured, or a manual
//     retitle). qcAndStampVideoAd is deliberately NOT called on this
//     fallback: it has no preserveAdStatus concept, so calling it here
//     would let a background cascade the operator did not act on flip an
//     untouched, still-perfectly-good sibling to status:'failed' purely
//     because THIS pass had nothing to composite (also flagged by both
//     review passes) — and it would inspect masterAd.veoVideoUrl, content
//     that was never actually served to this sibling.
async function recascadeDerivativeSibling(sibling, masterAd) {
  const siblingId = String(sibling._id);
  try {
    // ⚠️ MONEY/INTEGRITY — CAS, not a plain findById+updateOne. The read in
    // findDerivativesOfMaster and this write are two separate round trips;
    // a sibling can be claimed by the mint-time renderer, the titler, or a
    // manual retitle in between. Re-asserting the SAME exclusion filter here
    // (siblingStillEligible) makes the write itself atomic against that
    // race: either it wins outright (modifiedCount 1, nobody else touched
    // this row in the interim) or it no-ops and this pass skips the sibling
    // cleanly (adversarial review, 2026-09-02 — the read-only exclusion
    // filter alone left a TOCTOU window where this cascade could overwrite
    // a row another process was mid-render/mid-retitle on).
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
        // so basePlateCropService recomputes fresh against the NEW plate
        // instead of applying a crop rect computed against different
        // footage. Same ~$0.02 face-detection cost renderDeriveOnlyVideoAd
        // already accepts as the price of a zero-Atlas/Omni derivative.
        $unset: { basePlate: 1 }
      }
    );
    if ((claim.modifiedCount ?? claim.n ?? 0) === 0) {
      console.log(`🔁 regenerate-cascade[master=${masterAd._id}]: sibling=${siblingId} claimed/changed by another process — skipped this pass`);
      return;
    }
    const brand = await loadBrand(siblingId);
    const adFinal = await Ad.findById(sibling._id).lean();
    if (brand) {
      try {
        // retitleMode:true — original contract (already-shipped sibling,
        // commonly 'live'). Without it uploadRenderAndStamp would force
        // status:'draft' and un-publish. This is NOT the reverted
        // runVideoFull retitleMode expansion: a background cascade must
        // never flip a sibling's status except through the explicit,
        // filter-scoped promoteFailedToDraft below. Known residual: a
        // QC-rejected recascade of a live sibling stays 'live' with the
        // new composite as renderUrl (preserveAdStatus deletes the
        // status:'failed' stamp). Same class of bug as a manual retitle
        // QC fail, accepted here rather than un-publishing the sibling.
        await brandScriptExecutor.renderBrandScriptAndSave({ ad: adFinal, brand, retitleMode: true });
        const settledSibling = await Ad.findById(sibling._id).select('status visionQc').lean();
        const qcJustFailed = !!brandScriptExecutor.buildVideoQcFailureFields(settledSibling?.visionQc).status;
        if (!qcJustFailed) await promoteFailedToDraft(siblingId);
        console.log(`🔁 regenerate-cascade[master=${masterAd._id}]: sibling=${siblingId} re-composited from the new master plate`);
      } catch (scriptErr) {
        // No safe composite this pass (see this function's own header) —
        // provenance updated above, delivered renderUrl/posterUrl/status
        // deliberately left untouched.
        console.warn(`🔁 regenerate-cascade[master=${masterAd._id} sibling=${siblingId}]: brand-script failed (non-fatal, renderUrl left untouched) — ${scriptErr.message}`);
      }
    } else {
      console.log(`🔁 regenerate-cascade[master=${masterAd._id}]: sibling=${siblingId} has no brand/chrome configured — provenance updated, renderUrl left untouched`);
    }
  } catch (err) {
    console.warn(`🔁 regenerate-cascade[master=${masterAd._id}]: sibling=${siblingId} failed (non-fatal, master regenerate unaffected) — ${err.message}`);
  }
}

async function cascadeRegenerateToDerivatives(adId, opts = {}) {
  try {
    const masterAd = await Ad.findById(adId).lean();
    if (!masterAd) return;
    // Defense in depth — runVideoFull only ever runs on a true master (the
    // derive-only gate in preflight() / runClaimedRegeneration already
    // refuses a regenerate on a derivative before this function could ever
    // be reached), but this guard is one cheap in-memory check and this
    // function must NEVER cascade FROM a derivative.
    if (masterAd.kind !== 'video' || resolveDeriveFromMaster(masterAd)) return;
    if (!masterAd.veoVideoUrl) return;
    // Same selectivity guard as findDerivativesOfMaster: platformFormat
    // supplies the query's deriveFromMaster clause. A lean() read of a
    // document missing that field would otherwise drop the key on the
    // Mongo wire and match every video ad in the campaign+product,
    // including other paid masters.
    if (!masterAd.platformFormat || !masterAd.campaignId || masterAd.productId == null) return;
    // Defense in depth #2 (adversarial review, 2026-09-02) — the caller
    // already gates this whole function call on !qcJustFailed for the
    // common case, but re-derive it here too so a future/standalone caller
    // of this exported function cannot fan out a rejected plate to every
    // sibling by skipping that gate.
    const qcJustFailed = !!brandScriptExecutor.buildVideoQcFailureFields(masterAd.visionQc).status;
    if (qcJustFailed) return;
    const siblings = await findDerivativesOfMaster(masterAd);
    if (siblings.length > MAX_CASCADE_SIBLINGS) {
      console.warn(
        `🔁 regenerate-cascade[master=${adId}]: ${siblings.length} eligible siblings, ` +
        `capping at ${MAX_CASCADE_SIBLINGS} (ADGEN_REGEN_CASCADE_SIBLING_CAP). ` +
        `Zero Atlas/Omni spend; each sibling still costs a face-detection LLM call, ` +
        `a vision-QC judge call, a Remotion slot, and a Cloudinary upload.`
      );
    }
    const chosen = siblings.slice(0, MAX_CASCADE_SIBLINGS);
    for (const sibling of chosen) {
      // Honor operator cancel per sibling. A throw here is swallowed by
      // this function's own catch — the master is already markComplete'd
      // 'done' by the caller, so we must NOT let CancelledError reach
      // regenerateAd's outer catch (that would markComplete 'failed' over
      // a real success). Remaining siblings are skipped this pass.
      if (opts.progressRun) {
        try {
          await opts.progressRun.checkpoint();
        } catch (cpErr) {
          console.warn(
            `🔁 regenerate-cascade[master=${adId}]: checkpoint/cancel — ` +
            `stopping remaining siblings (master already settled) — ${cpErr.message}`
          );
          return;
        }
      }
      await recascadeDerivativeSibling(sibling, masterAd);
    }
  } catch (err) {
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
    rawPromptOverride:     promptOverride || null,
    // MONEY — deliberately explicit, mirroring runVideoFull's own
    // allowResume:false for generateForAd. A regenerate is an operator (or
    // QC-driven) request for a genuinely NEW image, not a recovery of a
    // crashed prior attempt — it must never resume the ad's existing
    // imageGeneration.predictionId, which may still belong to a DIFFERENT,
    // currently in-flight mint-time render of the same Ad. (That concurrency
    // is now itself refused up front — see inFlightRefusal — but this stays
    // explicit: the two are independent guards, and allowResume:false is
    // correct here on its own merits even with the gate in place.) Both
    // already default to this same safe shape
    // inside renderDirectImage; stated here anyway so the invariant is
    // grep-able at the one call site that must never flip it, same as the
    // video path's convention.
    existingPredictionId: null,
    allowResume:          false
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

  // MONEY — last gate before the billable image submit. Deliberately OUTSIDE
  // the try below: a refusal is not a charged failure and must not be
  // classified as one.
  await assertNotInFlightBeforeSubmit(adId);

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
        // Clear the adgen claim markers too (regenerationRequest is stamped
        // by the BACKEND, never by this file — see runClaimedRegeneration's
        // header — but clearing it here, alongside the claim fields, is what
        // lets a future regenerate on this ad start clean instead of racing
        // this row's now-stale claim).
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
  // The in-flight-render gate, exported so scripts/verifyRegenerateInFlightGate.js
  // executes the REAL rule rather than a reimplementation that keeps the name.
  inFlightRefusal,
  InFlightRefusalError,
  // Exported so the offline harness can assert the direct-image path
  // (no aiCanvasArtifactId precondition) without invoking providers.
  runImage,
  // Symmetric with runImage: lets the harness drive the REAL video worker up
  // to generateForAd without going through runClaimedRegeneration's early gate.
  runVideoFull,
  // Pure arg assembly — verifyLifestylePreserve asserts variantKind is threaded.
  buildDirectImageArgsFromAd,
  DAILY_CAP,
  MAX_RECLAIMS,
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
  // Ad-gen handoff (routing fix, 2026-08-26) — services/regenerateConsumer.js
  // is the only real caller of runClaimedRegeneration.
  runClaimedRegeneration,
  // Status-promotion + derivative-cascade fix (see each function's own doc
  // comment). Exported for verify harnesses to exercise the real functions
  // against a stubbed Ad model rather than a reimplementation.
  promoteFailedToDraft,
  findDerivativesOfMaster,
  buildDerivativeFindFilter,
  recascadeDerivativeSibling,
  cascadeRegenerateToDerivatives,
  MAX_CASCADE_SIBLINGS
};
