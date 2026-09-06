'use strict';
//
// Pure Slack-message builders for CampaignRun lifecycle chatter — the
// run-completion per-kind summary, the preparing-reap hygiene notice, the
// /generate claim-anomaly alert, and the uncapped-batch run-start line.
//
// Extracted into its own module (no mongoose, no network, no require-time
// side effects) so scripts/verifySlackRunVerbosity.js can assert the REAL
// strings an operator sees without pulling in Mongo or routes/ads.js's
// 4000+ lines. Callers (routes/ads.js, worker.js, services/runFeedService.js)
// own all I/O and decide alert levels / channels; this module only formats.
//
// WORDING INVARIANT, pinned by the harness above: never say "lost" or
// "deleted" about claimed / stranded / unclaimed ads. Every bucket this
// module can describe — queued, rendering, failed, archived — is an ad that
// still exists. The drain path is always "Generate more" (or the 24h archive
// sweep parking it), never a re-creation of destroyed work.

const DEFAULT_UNCAP_THRESHOLD = 20;

function emptyOutcomeBucket() {
  return { delivered: 0, failed: 0, other: 0 };
}

function emptyKindCounts() {
  return {
    static: emptyOutcomeBucket(),
    videoMaster: emptyOutcomeBucket(),
    videoDerivative: emptyOutcomeBucket()
  };
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Classify one claimed Ad projection into a Slack-summary bucket.
 * Missing/malformed fields fall back to static/other; never throws.
 *
 * @param {{ status?: string, renderRoute?: string|null, deriveFromMaster?: string|null }} ad
 * @returns {{ kind: 'static'|'videoMaster'|'videoDerivative', outcome: 'delivered'|'failed'|'other' }}
 */
function classifyClaimedAd(ad) {
  const doc = isPlainObject(ad) ? ad : {};
  let kind = 'static';
  if (doc.renderRoute === 'veo') {
    kind = doc.deriveFromMaster ? 'videoDerivative' : 'videoMaster';
  }
  let outcome = 'other';
  if (doc.status === 'failed') outcome = 'failed';
  else if (doc.status === 'draft' || doc.status === 'live') outcome = 'delivered';
  return { kind, outcome };
}

/**
 * Tally claimed ads by kind x outcome. Skips non-object entries; never
 * throws. `other` catches any ad still queued/rendering/archived post-loop
 * so nothing is silently dropped from the count.
 *
 * @param {Array<{status?:string,renderRoute?:string|null,deriveFromMaster?:string|null}>|null|undefined} ads
 */
function summarizeClaimedAdKinds(ads) {
  const out = emptyKindCounts();
  if (!Array.isArray(ads) || ads.length === 0) return out;
  for (let i = 0; i < ads.length; i++) {
    const ad = ads[i];
    if (!isPlainObject(ad)) continue;
    const { kind, outcome } = classifyClaimedAd(ad);
    const bucket = out[kind];
    if (!bucket) continue;
    if (outcome === 'delivered') bucket.delivered += 1;
    else if (outcome === 'failed') bucket.failed += 1;
    else bucket.other += 1;
  }
  return out;
}

function kindTotal(bucket) {
  if (!bucket) return 0;
  return num(bucket.delivered) + num(bucket.failed) + num(bucket.other);
}

/**
 * One-line kind/outcome breakdown for a run-completion summary, e.g.
 * "12 static delivered / 1 failed, 3 video masters delivered (billable) /
 * 6 free derivatives / 1 failed". Returns null when every bucket is zero.
 *
 * @param {ReturnType<typeof summarizeClaimedAdKinds>} counts
 * @returns {string|null}
 */
function formatKindBreakdownLine(counts) {
  const c = isPlainObject(counts) ? counts : emptyKindCounts();
  const st = c.static || emptyOutcomeBucket();
  const vm = c.videoMaster || emptyOutcomeBucket();
  const vd = c.videoDerivative || emptyOutcomeBucket();

  const clauses = [];

  if (kindTotal(st) > 0) {
    let line = `${num(st.delivered)} static delivered`;
    if (num(st.failed) > 0) line += ` / ${num(st.failed)} failed`;
    if (num(st.other) > 0) line += ` / ${num(st.other)} other`;
    clauses.push(line);
  }

  if (kindTotal(vm) > 0 || kindTotal(vd) > 0) {
    const masterDelivered = num(vm.delivered);
    const masterWord = masterDelivered === 1 ? 'master' : 'masters';
    let line = `${masterDelivered} video ${masterWord} delivered (billable)`;
    const derivDelivered = num(vd.delivered);
    if (derivDelivered > 0) {
      const derivWord = derivDelivered === 1 ? 'derivative' : 'derivatives';
      line += ` / ${derivDelivered} free ${derivWord}`;
    }
    const failed = num(vm.failed) + num(vd.failed);
    if (failed > 0) line += ` / ${failed} failed`;
    const other = num(vm.other) + num(vd.other);
    if (other > 0) line += ` / ${other} other`;
    clauses.push(line);
  }

  if (clauses.length === 0) return null;
  return clauses.join(', ');
}

/**
 * Mint-vs-claim gap line. Null when nothing is unclaimed (minted === claimed).
 * The gap is queued and drainable, never "lost"/"deleted" — mintedTotal /
 * unclaimedAtStart are the fields already persisted on CampaignRun
 * (models/CampaignRun.js); this function only formats them.
 *
 * @param {{ mintedTotal?: number, claimedTotal?: number, unclaimedAtStart?: number }} opts
 * @returns {string|null}
 */
function formatMintedVsClaimedLine(opts) {
  const o = isPlainObject(opts) ? opts : {};
  const mintedTotal = num(o.mintedTotal);
  const claimedTotal = num(o.claimedTotal);
  const unclaimedAtStart = num(o.unclaimedAtStart);
  if (unclaimedAtStart <= 0) return null;
  return (
    `minted ${mintedTotal}, claimed ${claimedTotal} — ${unclaimedAtStart}` +
    ' queued (drainable via "Generate more")'
  );
}

/**
 * Spend line. Prefers CostLog-reconciled spend; falls back to an explicitly
 * "est." labelled estimate. Never presents an estimate as settled (CLAUDE.md
 * §2 — base_price / the estimate formula must never be quoted as spend).
 * This function only formats numbers the caller already computed — it does
 * not touch CostLog or any pricing formula itself.
 *
 * @param {{ reconciledUsd?: number, estimatedUsd?: number }} opts
 * @returns {string|null}
 */
function formatReconciledSpendLine(opts) {
  const o = isPlainObject(opts) ? opts : {};
  const reconciledUsd = num(o.reconciledUsd);
  const estimatedUsd = num(o.estimatedUsd);
  // MIXED IS THE NORMAL CASE, and reporting only the reconciled half
  // UNDER-REPORTS the run. Video publishes `price` at completion so those rows
  // reconcile immediately, while images usually settle later via
  // scheduleCostReconcile — so a run carrying both is the common shape, not an
  // edge case. Showing "reconciled spend $2.70" on a run that also holds $0.65
  // of not-yet-settled image spend reads as the run TOTAL and undercounts it.
  // Report BOTH with distinct labels so the estimate is never presented as
  // settled (CLAUDE.md §2), and mark the combined figure "~" so nobody quotes
  // it as reconciled truth.
  if (reconciledUsd > 0 && estimatedUsd > 0) {
    return `spend ~$${(reconciledUsd + estimatedUsd).toFixed(2)} ` +
      `(reconciled $${reconciledUsd.toFixed(2)} + est. $${estimatedUsd.toFixed(2)})`;
  }
  if (reconciledUsd > 0) {
    return `reconciled spend $${reconciledUsd.toFixed(2)}`;
  }
  if (estimatedUsd > 0) {
    return `est. spend $${estimatedUsd.toFixed(2)}`;
  }
  return null;
}

/**
 * Ordered, non-null completion-summary lines for a CampaignRun finish:
 * minted-vs-claimed gap, then the per-kind breakdown, then spend. Never
 * throws — any internal error degrades to [] so a reporting bug can never
 * take down the (already-fire-and-forget) run-feed close-out.
 *
 * @param {{
 *   mintedTotal?: number, claimedTotal?: number, unclaimedAtStart?: number,
 *   kindCounts?: ReturnType<typeof summarizeClaimedAdKinds>,
 *   reconciledUsd?: number, estimatedUsd?: number
 * }} opts
 * @returns {string[]}
 */
function buildRunCompletionSummaryLines(opts) {
  try {
    const o = isPlainObject(opts) ? opts : {};
    const lines = [];
    const minted = formatMintedVsClaimedLine({
      mintedTotal: o.mintedTotal,
      claimedTotal: o.claimedTotal,
      unclaimedAtStart: o.unclaimedAtStart
    });
    if (minted) lines.push(minted);
    const kinds = formatKindBreakdownLine(o.kindCounts);
    if (kinds) lines.push(kinds);
    const spend = formatReconciledSpendLine({
      reconciledUsd: o.reconciledUsd,
      estimatedUsd: o.estimatedUsd
    });
    if (spend) lines.push(spend);
    return lines;
  } catch (_err) {
    return [];
  }
}

/**
 * Run-feed start stage string. At/under threshold this is byte-identical to
 * the historical `run start — N ad(s)` — scripts/verifyRunFeed.js A10
 * regexes `/run start/` against it and other callers may rely on the exact
 * base form, so the unchanged case must stay unchanged. Above threshold
 * (MAX_CREATIVES_PER_RUN is effectively uncapped at 1000 — CLAUDE.md §2),
 * append a visible marker plus the static/video mix so a big batch is
 * distinguishable from routine traffic in the feed.
 *
 * `requesterLabel` (who clicked Generate, resolved by routes/ads.js) is
 * appended last as ` · by <who>` when supplied, so it survives both the
 * at-threshold and above-threshold branches. Omitted entirely when absent —
 * the byte-identical guarantee above still holds for every existing caller,
 * none of which passes it.
 *
 * @param {{ total?: number, staticCount?: number, veoCount?: number, threshold?: number,
 *           requesterLabel?: string|null }} opts
 * @returns {string}
 */
function buildRunStartLine(opts) {
  const o = isPlainObject(opts) ? opts : {};
  const total = num(o.total);
  const staticCount = num(o.staticCount);
  const veoCount = num(o.veoCount);
  const threshold = o.threshold == null ? DEFAULT_UNCAP_THRESHOLD : num(o.threshold);
  // Non-empty string only; a non-string (or '') must not print "· by undefined".
  const by = typeof o.requesterLabel === 'string' && o.requesterLabel.trim()
    ? ` · by ${o.requesterLabel.trim()}`
    : '';
  const base = `run start — ${total} ad(s)`;
  if (total <= threshold) return `${base}${by}`;
  let line = `${base} — uncapped batch`;
  if (staticCount > 0 || veoCount > 0) {
    const bits = [];
    if (staticCount > 0) bits.push(`${staticCount} static`);
    if (veoCount > 0) bits.push(`${veoCount} video`);
    line += ` (${bits.join(' + ')})`;
  }
  return `${line}${by}`;
}

/**
 * alertService payload for worker.js's preparing-reap hygiene sweep
 * (reapOrphans' 'preparing' arm — PR #209's PREPARE_STALE_MIN). Every run
 * named here holds NO claimed ads and NO stranded spend — expansion never
 * finished, so nothing was submitted. The minted ads (if any) are intact and
 * sitting `queued`. Truthful-wording rule from PR #204: never say the work
 * was lost or deleted.
 *
 * @param {{
 *   runs?: Array<{ runId?: string, campaignId?: string, ageMin?: number, drainableCount?: number }>,
 *   staleMin?: number
 * }} opts
 * @returns {{ title: string, fields: Object, detail: string }}
 */
function buildPreparingReapNotice(opts) {
  const o = isPlainObject(opts) ? opts : {};
  const runs = Array.isArray(o.runs) ? o.runs : [];
  const staleMin = num(o.staleMin);

  let drainableSum = 0;
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    if (!isPlainObject(r)) continue;
    drainableSum += num(r.drainableCount);
  }

  const title = runs.length === 1
    ? `Stranded generation reclaimed — run ${runs[0].runId}`
    : `${runs.length} stranded generation(s) reclaimed`;

  const fields = {
    'stale past': `${staleMin}m`,
    'ads intact & queued': drainableSum > 0 ? drainableSum : undefined
  };

  const detailLines = [];
  for (let i = 0; i < runs.length; i++) {
    const r = isPlainObject(runs[i]) ? runs[i] : {};
    const runId = r.runId == null ? '' : String(r.runId);
    const campaignId = r.campaignId == null || r.campaignId === '' ? '-' : String(r.campaignId);
    const ageMin = num(r.ageMin);
    const drainableCount = num(r.drainableCount);
    detailLines.push(
      `${runId} campaign=${campaignId} age=${ageMin}m — ${drainableCount} minted ad(s) queued, intact. ` +
      'Generate more on the Ads/Campaigns page renders them; the 24h archive sweep parks them otherwise.'
    );
  }

  return {
    title,
    fields,
    detail: detailLines.join('\n')
  };
}

/**
 * alertService payload for claimAdsForRun's rare anomaly branch
 * (updateMany reported a write but the ownership re-read came back empty —
 * released back to queued, run marked failed). The caller sends this at
 * level:'fatal' via alertService (the fatal/alert channel, NEVER the
 * per-run status feed) — this function only builds the payload shape.
 *
 * @param {{ runId?: *, campaignId?: *, selectedCount?: *, modifiedCount?: * }} opts
 * @returns {{ title: string, fields: Object }}
 */
function buildClaimAnomalyAlert(opts) {
  const o = isPlainObject(opts) ? opts : {};
  return {
    title: `Claim anomaly — run ${o.runId} released`,
    fields: {
      run: o.runId,
      campaign: o.campaignId,
      selected: o.selectedCount,
      'write modifiedCount': o.modifiedCount,
      outcome: 'ads released to queued; run marked failed'
    }
  };
}

module.exports = {
  DEFAULT_UNCAP_THRESHOLD,
  classifyClaimedAd,
  summarizeClaimedAdKinds,
  formatKindBreakdownLine,
  formatMintedVsClaimedLine,
  formatReconciledSpendLine,
  buildRunCompletionSummaryLines,
  buildRunStartLine,
  buildPreparingReapNotice,
  buildClaimAnomalyAlert
};
