'use strict';
//
// generationGate — may a new POST /api/ads/generate start while other runs for
// the same campaign are still in flight?
//
// WHY A GATE EXISTS AT ALL. Every /generate expansion mints its OWN ads:
// identityDigest is scoped to the run via generationRunId, so a repeat Generate
// produces fresh creative instead of colliding with the previous run's ads
// (owner-requested, deliberate). The side effect is that a double-clicked
// button expands TWICE and bills TWICE for one intent. The atomic
// status:'queued' claim in routes/ads.js does NOT cover this: each run claims
// the ads it just created, so there is no race to lose. This gate is the only
// thing standing between a stray double-click and a second full set of
// billable generations.
//
// WHY IT IS NOT "one run per campaign" ANY MORE. That rule also blocked a
// second batch of DIFFERENT products — a legitimate parallel run the team
// actually wants. Two runs whose product sets are DISJOINT cannot mint the same
// ad, because ad identity includes productId, so they cannot double-bill one
// creative. Overlapping product sets can, so they stay blocked.
//
// Deliberately keyed on productIds ONLY — never on format/preset. Presets fan
// out (meta_all includes the static surfaces meta_static produces), so two runs
// on the same product with different presets CAN expand the same
// (product, template, aspect) combination into two differently-digested ads:
// one creative, two charges. Ignoring format is what makes this safe.
//
// FAIL-CLOSED. Any run — or request — whose product scope we cannot read
// blocks. A media-only or pre-deploy legacy run could be targeting anything,
// and assuming "probably disjoint" is assuming with the owner's money.

// A productId must look like an ObjectId hex string once stringified. ObjectId
// INSTANCES pass (they stringify to 24 hex), which is the shape the DB hands us;
// wrappers like { id: '…' } do not — they collapse to '[object Object]'.
const OBJECT_ID_HEX = /^[0-9a-fA-F]{24}$/;

/**
 * Normalize a productId list to comparable, deduped ObjectId-hex strings.
 * Shared by the gate and the CampaignRun stamp so the two can never disagree
 * about what "the same product" means.
 *
 * ALL-OR-NOTHING on purpose. A value we cannot read as a product id makes the
 * whole list untrustworthy, so we return [] — which every caller reads as
 * "scope unknown" and fails closed. Dropping only the bad entries would leave a
 * PARTIAL scope that looks authoritative: a client posting [{id:P}] would stamp
 * '[object Object]', read as disjoint from a sibling run's real [P], and both
 * would expand and bill P. Silently narrowing scope is how a guard turns into a
 * charge.
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

/**
 * @param {{
 *   activeRuns?: Array<{ runId?: string, requestedProductIds?: any[] }>,
 *   requestedProductIds?: any[]
 * }} args
 * @returns {{ blocked: boolean, reason?: string, conflictRunId?: string|null, overlap?: string[] }}
 *   reason: 'product-overlap' | 'scope-unknown-request' | 'scope-unknown-active-run'
 */
function generationGateDecision({ activeRuns = [], requestedProductIds = [] } = {}) {
  const runs = (Array.isArray(activeRuns) ? activeRuns : []).filter(Boolean);
  if (!runs.length) return { blocked: false };

  const requested = normalizeProductIdList(requestedProductIds);
  // Unknown scope on OUR side (media-only run, or an empty list): we cannot
  // prove disjointness from anything, so behave exactly like the old gate.
  if (!requested.length) {
    return {
      blocked: true,
      reason: 'scope-unknown-request',
      conflictRunId: runs[0].runId || null,
      overlap: []
    };
  }

  const requestedSet = new Set(requested);
  for (const run of runs) {
    const runIds = normalizeProductIdList(run.requestedProductIds);
    // Unknown scope on the ACTIVE run's side — runs minted before this field
    // existed, or non-product runs. Fail closed.
    if (!runIds.length) {
      return {
        blocked: true,
        reason: 'scope-unknown-active-run',
        conflictRunId: run.runId || null,
        overlap: []
      };
    }
    const overlap = runIds.filter((id) => requestedSet.has(id));
    if (overlap.length) {
      return {
        blocked: true,
        reason: 'product-overlap',
        conflictRunId: run.runId || null,
        overlap
      };
    }
  }

  // Every in-flight run targets other products — safe to run in parallel.
  return { blocked: false };
}

// ── MINT-THEN-VERIFY ─────────────────────────────────────────────────
//
// generationGateDecision alone has a read-then-write race, and it is the exact
// shape the gate exists to stop: two clicks land on two instances, BOTH read
// activeRuns before EITHER has inserted its CampaignRun, both see nothing in
// flight, both proceed, both expand, both bill. Milliseconds wide, pre-existing,
// and a double-click is precisely how you hit it.
//
// So after minting its own run, each request re-reads and asks "did anyone
// earlier already claim these products?". Both racers now see each other (each
// verifies AFTER its own acknowledged insert), and the winner is decided by a
// total order both compute identically — createdAt, then runId as tie-break —
// so exactly one aborts. The loser aborts BEFORE the expansion starts, so a
// false abort costs nothing but a 409.
//
// Fail-closed again: an active run whose scope we cannot read counts as
// overlapping, so a legacy unstamped run still wins over us if it is earlier.

/** Total order over runs: createdAt, then runId. Returns <0 when a precedes b. */
function compareRunOrder(a, b) {
  const ta = a && a.createdAt ? new Date(a.createdAt).getTime() : 0;
  const tb = b && b.createdAt ? new Date(b.createdAt).getTime() : 0;
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
  return String((a && a.runId) || '').localeCompare(String((b && b.runId) || ''));
}

/**
 * After minting `selfRun`, is there an EARLIER in-flight run that overlaps it?
 * @returns {{ runId?: string, createdAt?: any, overlap: string[] }|null} the run
 *   that supersedes us, or null when we hold the earliest claim on these products.
 */
function pickSupersedingRun({ selfRun, activeRuns = [], requestedProductIds = [] } = {}) {
  if (!selfRun) return null;
  const runs = (Array.isArray(activeRuns) ? activeRuns : []).filter(Boolean);
  if (!runs.length) return null;

  const requested = normalizeProductIdList(requestedProductIds);
  const requestedSet = new Set(requested);
  const selfId = String(selfRun.runId || '');

  let winner = null;
  for (const run of runs) {
    if (String(run.runId || '') === selfId) continue;      // ourselves
    if (compareRunOrder(run, selfRun) >= 0) continue;       // later than us — it aborts, not us
    const runIds = normalizeProductIdList(run.requestedProductIds);
    // Unknown scope on either side → assume it collides (fail-closed).
    const overlap = (!runIds.length || !requested.length)
      ? []
      : runIds.filter((id) => requestedSet.has(id));
    const collides = !runIds.length || !requested.length || overlap.length > 0;
    if (!collides) continue;
    // Keep the EARLIEST superseding run so the 409 names the real owner.
    if (!winner || compareRunOrder(run, winner) < 0) {
      winner = { runId: run.runId, createdAt: run.createdAt, overlap };
    }
  }
  return winner;
}

module.exports = {
  generationGateDecision,
  normalizeProductIdList,
  pickSupersedingRun,
  compareRunOrder
};
