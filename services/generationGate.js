'use strict';
//
// generationGate — may a new POST /api/ads/generate start while other runs for
// the same campaign are still in flight?
//
// ── WHAT CHANGED 2026-08-10, AND WHY IT IS SAFE ─────────────────────────────
//
// Until now this gate keyed on PRODUCT OVERLAP: a new run was refused when its
// productIds intersected any in-flight run's. Owner directive 2026-08-10:
// *"don't block ads that are concurrent based on the product alone, but based
// on the actual request. So block identical requests and note requests that are
// identical to previous requests but allow them if the user wants."*
//
// So the key is now the REQUEST FINGERPRINT — a hash over exactly the fields
// that determine what gets generated. Two runs over the same product with
// genuinely different requests now run in parallel; only a byte-identical
// request is refused, and even that is overridable on explicit confirmation.
//
// THIS IS NOT A LOOSENING OF THE MONEY GUARD. It is a re-aim of it, and the
// justification is in the digest functions, not in this file:
//
//   * VIDEO cannot double-bill across runs at all. Both video digests are
//     RUN-INDEPENDENT — computeV2IdentityDigest omits generationRunId when
//     kind==='video' (campaignAdsGenerationService.js:1715) and
//     computeDeterministicVideoDigest never includes it (:1731-1754). So two
//     concurrent runs that would mint the same video ad collide on the
//     (campaignId, identityDigest) unique index and the second inserts nothing.
//     The index is what protects video spend — this gate never was.
//
//   * STATIC duplicates are DELIBERATE, by the same owner. computeIdentityDigest
//     scopes on generationRunId precisely so a repeat Generate produces fresh
//     creative: *"there should be no limitation on creating new ads that may be
//     duplicates since generative ads always have new seeds"*
//     (campaignAdsGenerationService.js:266-269). A second static set is
//     therefore new creative that was asked for, not a double charge for one
//     asset.
//
// What is left for this gate to catch is the ACCIDENT: the double-click, where
// the user asked once and paid twice. An accident is by definition a repeat of
// the SAME request — you cannot double-click your way into a different preset,
// a different template or a different media pick. So fingerprint identity is a
// strictly more accurate detector of the thing worth blocking than product
// overlap ever was, and it is the reason the old "never key on format/preset"
// rule is retired rather than violated: that rule existed to stop a
// meta_all ⊃ meta_static pair from billing one creative twice, and by the
// owner's own digest instruction that pair is two intentional creatives.
//
// Overlap is not silently discarded either — it is reported as a NON-BLOCKING
// notice (see buildOverlapNotice) so the cost stays visible without the gate
// deciding for the operator.
//
// ── FAIL-OPEN, DELIBERATELY, AND ONLY HERE ─────────────────────────────────
//
// The old gate failed CLOSED: any run — or request — whose product scope could
// not be read blocked everything. That is what broke generation from the MEDIA
// LIBRARY. A media-library run legitimately carries productIds:[] (the seed is
// media, not a SKU), so it normalized to "scope unknown" and was refused
// whenever any sibling run was in flight, and while it was in flight it blocked
// every product run too.
//
// The new rule can only ever block on PROVABLE identity, and you cannot prove
// identity against an unknown. So an unreadable/absent fingerprint does not
// block. The exposure that buys is one owner-sanctioned duplicate static set;
// the exposure it removes is a whole entry point that could not generate.
// Rollout compat keeps the window narrow — see LEGACY_PRODUCT_SET_FALLBACK.

const crypto = require('crypto');

// A productId must look like an ObjectId hex string once stringified. ObjectId
// INSTANCES pass (they stringify to 24 hex), which is the shape the DB hands us;
// wrappers like { id: '…' } do not — they collapse to '[object Object]'.
const OBJECT_ID_HEX = /^[0-9a-fA-F]{24}$/;

/**
 * Normalize a productId list to comparable, deduped ObjectId-hex strings.
 * Shared by the gate's legacy-compat path and the CampaignRun stamp so the two
 * can never disagree about what "the same product" means.
 *
 * ALL-OR-NOTHING on purpose. A value we cannot read as a product id makes the
 * whole list untrustworthy, so we return [] — which the legacy path reads as
 * "scope unknown" and declines to compare. Dropping only the bad entries would
 * leave a PARTIAL scope that looks authoritative.
 *
 * NOTE: this is NOT what the fingerprint uses. The fingerprint needs a FAITHFUL
 * canonical form (see canonicalIdList) — collapsing a malformed list to []
 * there would make two DIFFERENT malformed requests hash identically and get
 * one of them refused as a duplicate.
 */
function normalizeProductIdList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (raw == null) continue;                       // holes are ignorable
    const s = String(raw).trim();
    if (!s) continue;
    if (!OBJECT_ID_HEX.test(s)) return [];           // unreadable → unknown scope
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

// ── THE REQUEST FINGERPRINT ────────────────────────────────────────────────
//
// Covers exactly the fields POST /api/ads/generate reads that CHANGE WHAT GETS
// GENERATED. Both directions of that sentence are load-bearing:
//
//   * A generation-affecting field left OUT means two runs that produce
//     different creative hash the same, and the second is refused as a
//     duplicate — a false block.
//
//   * A field that the route IGNORES put IN means two runs that produce
//     IDENTICAL creative hash differently, and a real double-click sails
//     through — a false allow, which is the one that costs money.
//
// That second trap is live today: the wizard posts `expandVideoFormats`
// (Step4Generate.tsx) and routes/ads.js NEVER DESTRUCTURES IT. It is therefore
// deliberately absent below. Before adding any field here, confirm the handler
// actually reads it.
//
// TWO fields expandWizardJob receives are excluded on purpose:
//   * generationRunId — unique per run by definition, so hashing it would make
//     every request unique and the gate a no-op.
//   * requestedBy — omitted so the gate catches CROSS-USER duplicates. If two
//     teammates click Generate on the same campaign with the same settings, that
//     is the same spend twice; they get the same confirm the double-clicker does.
//
// Order-sensitivity is per-field and mirrors ad identity:
//   * productIds / templateIds — SORTED. Each expands independently, so pick
//     order cannot change the output set.
//   * mediaIds / seedMediaIds / seedPicks — ORDER PRESERVED. Reference order is
//     load-bearing ("a different pick order is a different ad" —
//     campaignAdsGenerationService.js:1728-1730), so re-ordering picks really is
//     a different request.

// Bump whenever the FIELD SET below changes. Adding a part to `parts` already
// changes every hash, so the version is not what breaks continuity — it is what
// makes the break legible instead of looking like a hash collision bug.
//
// v2 (2026-08-11) added staticFormats / videoFormats for the wizard's
// multi-select sizes. TWO one-time transients on the deploy that ships it, both
// accepted:
//   * an in-flight run minted under v1 no longer matches a v1-identical repeat,
//     so a double-click inside the ~REAP_STALE_MIN (15 min) window can bill
//     twice. Bounded by that window and by the (campaignId, identityDigest)
//     unique index, which protects VIDEO regardless of this gate.
//   * the "you already ran this" notice stops matching pre-deploy runs for
//     DUPLICATE_LOOKBACK_MIN (24h). Cosmetic — it is a notice, not a block.
const FINGERPRINT_VERSION = 'req:v2';

/** Faithful canonical id list: stringified, trimmed, blanks dropped, deduped. */
function canonicalIdList(list, { sort = false } = {}) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (raw == null) continue;
    const s = String(raw).trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return sort ? out.sort() : out;
}

/**
 * Canonical form for a field that may arrive as a SCALAR or as a list.
 *
 * `kinds` is the live case and it was a real bug: routes/ads.js destructures it
 * as a bare scalar ('image' | 'video' | 'both' | null) while resolvePreset works
 * in arrays. Running a scalar through canonicalIdList returns [] — so EVERY
 * value of kinds hashed to the same empty string, and a static-only run and a
 * video-only run over the same product fingerprinted IDENTICALLY. The second was
 * then refused as a duplicate: wildly different spend, one hash, a false block.
 * Fail-safe in direction (a confirm click, not a double charge) but it is the
 * exact "omitted field that does affect output" trap documented above, and it
 * would have hit the common case of generating statics and then video.
 */
function canonicalScalarOrList(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return canonicalIdList(value, { sort: true });
  const s = String(value).trim();
  return s ? [s] : [];
}

/** Canonical (productId, mediaId) pair list. Order preserved, pairs deduped. */
function canonicalPairList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    const key = `${String(p.productId ?? '').trim()}|${String(p.mediaId ?? '').trim()}`;
    if (key === '|' || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * Stable hash of one generation request. Pure — no DB, no clock, no randomness,
 * so the same request always fingerprints the same across processes and deploys.
 *
 * @param {object} request the fields read off req.body by POST /api/ads/generate
 * @returns {string} sha256 hex
 */
function computeRequestFingerprint(request = {}) {
  const r = request || {};
  const cta = r.cta || {};
  const parts = [
    FINGERPRINT_VERSION,
    String(r.campaignId ?? ''),
    // ── what to generate from
    canonicalIdList(r.productIds, { sort: true }).join(','),
    canonicalIdList(r.mediaIds).join(','),
    canonicalIdList(r.templateIds, { sort: true }).join(','),
    // ── which surfaces / how many billable submits
    String(r.preset ?? ''),
    String(r.platformFormat ?? ''),
    // Scalar-or-array — see canonicalScalarOrList. The route sends a scalar.
    canonicalScalarOrList(r.kinds).join(','),
    r.expandStaticFormats ? '1' : '0',
    // Operator multi-select surfaces (preset 'explicit'). SORTED: these name a
    // SET of surfaces, and each expands independently, so tick order cannot
    // change the output — the same reasoning as productIds / templateIds. They
    // ARE read by the handler (forwarded into resolvePreset), so leaving them
    // out would collapse a 1-size and a 3-size request — a 1x and a 3x image
    // bill — onto one hash and refuse the second as a duplicate.
    canonicalIdList(r.staticFormats, { sort: true }).join(','),
    canonicalIdList(r.videoFormats, { sort: true }).join(','),
    // ── the media pool the expansion draws from
    r.includeCategoryMatched ? '1' : '0',
    r.includeBrandMatched ? '1' : '0',
    canonicalPairList(r.excludePairings).join(';'),
    // ── copy / destination (all three are inside the ad identity digests)
    String(cta.text ?? ''),
    String(cta.url ?? ''),
    String(r.urlParams ?? ''),
    // ── video knobs
    r.videoDurationSec == null || r.videoDurationSec === '' ? '' : String(Number(r.videoDurationSec)),
    r.directorVariants ? '1' : '0',
    canonicalPairList(r.seedPicks).join(';'),
    canonicalIdList(r.seedMediaIds).join(','),
    String(r.videoPromptGuidance ?? ''),
    String(r.videoPromptRaw ?? '')
    // ── `refresh` is DELIBERATELY ABSENT, and this is not an oversight.
    //
    // routes/ads.js destructures it (`refresh = false`) but never forwards it to
    // expandWizardJob on EITHER path — /preview or /generate. It is a dead field:
    // the wizard's own comment records it as a smoke-test workaround resolved by
    // #111. So it cannot change what gets generated, and hashing it would mean two
    // requests that produce identical creative hash differently — letting a real
    // double-click through as "not a duplicate". Same class as expandVideoFormats
    // above.
    //
    // IF ANYONE RE-WIRES `refresh` so it reaches the expansion, add it here in the
    // same commit — at that point omitting it flips to the opposite bug (a false
    // block on two genuinely different requests).
    //
    // Note it is also NOT the duplicate override: that is confirmDuplicate, kept
    // separate on purpose so an unrelated cache flag can never be the thing that
    // unlocks a second billable set.
  ];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

/**
 * Fingerprint for a CampaignRun that is NOT a generation request.
 *
 * POST /api/ads/runs claims already-queued ads and renders them. It mints no
 * ads and bills no expansion, so it can never be "the same request" as a
 * /generate and must never block one. Leaving it unstamped would not achieve
 * that: the rollout-compat path below would then compare it by PRODUCT SET, and
 * a render claim covering the same SKUs would refuse a legitimate generate —
 * permanently, since this endpoint would keep minting unstamped rows forever.
 *
 * Namespaced and unique per run, so it matches nothing but itself.
 */
function renderClaimFingerprint(runId) {
  return `claim:${String(runId || '')}`;
}

// ── ROLLOUT COMPAT ─────────────────────────────────────────────────────────
//
// Runs minted before this change carry no requestFingerprint. They are in
// flight for at most REAP_STALE_MIN (15min) after the deploy, but a
// double-click inside that window would otherwise be unprotected. So for a
// fingerprint-less active run we fall back to comparing PRODUCT SETS — and
// require them to be IDENTICAL, not merely overlapping.
//
// Identical-only is what keeps this from resurrecting the bug being fixed:
// overlap-blocking is exactly what the owner asked to remove, and an empty
// product set (the media-library shape) never compares equal to anything here
// because normalizeProductIdList collapses it to [] and we refuse to compare
// empties. So a media-library run is never blocked by this path either.
const LEGACY_PRODUCT_SET_FALLBACK = true;

function sameProductSet(a, b) {
  const na = normalizeProductIdList(a);
  const nb = normalizeProductIdList(b);
  if (!na.length || !nb.length) return false;   // unknown scope → cannot prove identity
  if (na.length !== nb.length) return false;
  const sa = [...na].sort();
  const sb = [...nb].sort();
  return sa.every((id, i) => id === sb[i]);
}

/** Is this active run the same REQUEST as ours? */
function isSameRequest(run, fingerprint, requestedProductIds) {
  if (!run) return false;
  if (run.requestFingerprint && fingerprint) {
    return String(run.requestFingerprint) === String(fingerprint);
  }
  // No fingerprint on the run → pre-change row. Compare product sets instead.
  if (!LEGACY_PRODUCT_SET_FALLBACK) return false;
  return sameProductSet(run.requestedProductIds, requestedProductIds);
}

/**
 * Product overlap against in-flight runs — REPORTING ONLY, never blocking.
 *
 * Kept because the guard it replaces cared about a real thing: two runs that
 * touch the same product will both bill for that product. The owner wants that
 * allowed; they still deserve to be told. Returned in the 202 so the UI can
 * inform without interrupting.
 */
function buildOverlapNotice({ activeRuns = [], requestedProductIds = [] } = {}) {
  const requested = normalizeProductIdList(requestedProductIds);
  if (!requested.length) return null;
  const requestedSet = new Set(requested);
  const overlapping = new Set();
  // Name the EARLIEST overlapping run, using the same total order the blocking
  // path uses. Picking whichever run happened to come back first would name an
  // arbitrary one — Mongo returns natural order here, no sort is applied — so
  // the same situation could surface a different run id on each attempt. The
  // notice is informational and never affects billing, but it puts a runId in
  // front of the operator and "go look at that run" has to mean something
  // stable.
  let conflict = null;
  for (const run of (Array.isArray(activeRuns) ? activeRuns : []).filter(Boolean)) {
    const hits = normalizeProductIdList(run.requestedProductIds).filter(id => requestedSet.has(id));
    if (hits.length) {
      hits.forEach(id => overlapping.add(id));
      if (!conflict || compareRunOrder(run, conflict) < 0) conflict = run;
    }
  }
  if (!overlapping.size) return null;
  const conflictRunId = conflict?.runId || null;
  return {
    code: 'concurrent-run-shares-products',
    runId: conflictRunId,
    productIds: [...overlapping],
    message:
      `Another generation is already running for ${overlapping.size} of the selected ` +
      'product(s). This is a different request, so both will run and both will be billed.'
  };
}

/**
 * @param {{
 *   activeRuns?: Array<{ runId?: string, requestFingerprint?: string, requestedProductIds?: any[], createdAt?: any }>,
 *   priorRun?: { runId?: string, requestFingerprint?: string, createdAt?: any, status?: string }|null,
 *   fingerprint?: string,
 *   requestedProductIds?: any[],
 *   acknowledgedRunId?: string|null
 * }} args
 * @returns {{
 *   blocked: boolean,
 *   reason?: 'duplicate-in-flight'|'duplicate-of-previous',
 *   conflictRunId?: string|null,
 *   confirmable?: boolean,
 *   acknowledgeRunId?: string|null,
 *   notice?: object|null
 * }}
 */
function generationGateDecision({
  activeRuns = [],
  priorRun = null,
  fingerprint = '',
  requestedProductIds = [],
  acknowledgedRunId = null
} = {}) {
  const runs = (Array.isArray(activeRuns) ? activeRuns : []).filter(Boolean);
  const ack = acknowledgedRunId ? String(acknowledgedRunId) : null;

  // ── 1. IDENTICAL REQUEST ALREADY IN FLIGHT → the double-click. ───────────
  //
  // Every identical in-flight run must be one the user has already been shown
  // and confirmed past. That containment rule is what stops the override from
  // becoming the hole it protects against: confirming once acknowledges run R1,
  // so a stray second click on "Generate anyway" finds the run R1's
  // confirmation just minted, does NOT match the stale acknowledgement, and is
  // refused with a fresh one. A bare boolean confirm would have re-opened the
  // exact double-click this gate exists to stop.
  const identicalInFlight = runs.filter(r => isSameRequest(r, fingerprint, requestedProductIds));
  const unacknowledged = identicalInFlight.filter(r => !ack || String(r.runId || '') !== ack);
  if (unacknowledged.length) {
    const conflict = unacknowledged.slice().sort(compareRunOrder)[0];
    return {
      blocked: true,
      reason: 'duplicate-in-flight',
      conflictRunId: conflict.runId || null,
      confirmable: true,
      acknowledgeRunId: conflict.runId || null,
      notice: null
    };
  }

  // ── 2. IDENTICAL TO A RUN THAT ALREADY FINISHED → note it, allow on ack. ──
  //
  // Owner: *"note requests that are identical to previous requests but allow
  // them if the user wants."* So this is not a hard refusal — it is a refusal
  // the client can convert into a run by echoing acknowledgedRunId. Skipped
  // entirely once the user has acknowledged it.
  if (priorRun && isSameRequest(priorRun, fingerprint, requestedProductIds)) {
    const priorId = String(priorRun.runId || '');
    if (!ack || ack !== priorId) {
      return {
        blocked: true,
        reason: 'duplicate-of-previous',
        conflictRunId: priorRun.runId || null,
        confirmable: true,
        acknowledgeRunId: priorRun.runId || null,
        notice: null
      };
    }
  }

  // ── 3. Allowed. Product overlap rides along as information, not a verdict. ─
  return {
    blocked: false,
    notice: buildOverlapNotice({ activeRuns: runs, requestedProductIds })
  };
}

// ── MINT-THEN-VERIFY ─────────────────────────────────────────────────
//
// generationGateDecision alone has a read-then-write race, and it is the exact
// shape the gate exists to stop: two clicks land on two instances, BOTH read
// activeRuns before EITHER has inserted its CampaignRun, both see nothing in
// flight, both proceed, both expand, both bill. Milliseconds wide, pre-existing,
// and a double-click is precisely how you hit it.
//
// So after minting its own run, each request re-reads and asks "did an earlier
// run already make this exact request?". Both racers now see each other (each
// verifies AFTER its own acknowledged insert), and the winner is decided by a
// total order both compute identically — createdAt, then runId as tie-break —
// so exactly one aborts. The loser aborts BEFORE the expansion starts, so a
// false abort costs nothing but a 409.
//
// Now keyed on the FINGERPRINT, matching the pre-check: two racing requests
// that differ in any generation-affecting field are both legitimate and both
// proceed.

/** Total order over runs: createdAt, then runId. Returns <0 when a precedes b. */
function compareRunOrder(a, b) {
  const ta = a && a.createdAt ? new Date(a.createdAt).getTime() : 0;
  const tb = b && b.createdAt ? new Date(b.createdAt).getTime() : 0;
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
  return String((a && a.runId) || '').localeCompare(String((b && b.runId) || ''));
}

/**
 * After minting `selfRun`, is there an EARLIER in-flight run making the SAME
 * request? Returns the run that supersedes us, or null when we hold the
 * earliest claim on this request.
 *
 * `acknowledgedRunId` is honoured here too: a user who explicitly confirmed a
 * duplicate of run R1 must not then be superseded BY R1 — that would refuse the
 * very run they just asked for. Any OTHER identical earlier run still wins,
 * so the double-confirm race stays closed.
 *
 * @returns {{ runId?: string, createdAt?: any }|null}
 */
function pickSupersedingRun({
  selfRun,
  activeRuns = [],
  fingerprint = '',
  requestedProductIds = [],
  acknowledgedRunId = null
} = {}) {
  if (!selfRun) return null;
  const runs = (Array.isArray(activeRuns) ? activeRuns : []).filter(Boolean);
  if (!runs.length) return null;

  const selfId = String(selfRun.runId || '');
  const ack = acknowledgedRunId ? String(acknowledgedRunId) : null;

  let winner = null;
  for (const run of runs) {
    const runId = String(run.runId || '');
    if (runId === selfId) continue;                         // ourselves
    if (ack && runId === ack) continue;                     // explicitly confirmed past
    if (compareRunOrder(run, selfRun) >= 0) continue;        // later than us — it aborts, not us
    if (!isSameRequest(run, fingerprint, requestedProductIds)) continue;
    // Keep the EARLIEST superseding run so the 409 names the real owner.
    if (!winner || compareRunOrder(run, winner) < 0) {
      winner = { runId: run.runId, createdAt: run.createdAt };
    }
  }
  return winner;
}

module.exports = {
  generationGateDecision,
  normalizeProductIdList,
  computeRequestFingerprint,
  renderClaimFingerprint,
  buildOverlapNotice,
  isSameRequest,
  sameProductSet,
  pickSupersedingRun,
  compareRunOrder,
  FINGERPRINT_VERSION
};
