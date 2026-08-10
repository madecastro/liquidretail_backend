// Apify cost model — the ONE place the money arithmetic for
// apify/instagram-scraper lives. Deliberately dependency-free (no axios,
// no mongoose) so `scripts/verifyApifyCommentCost.js` can require it in a
// checkout whose vendored node_modules is incomplete (CLAUDE.md §4).
//
// VERIFIED LIVE 2026-08-10 — GET https://api.apify.com/v2/acts/apify~instagram-scraper
// (public, no auth). Pricing entry startedAt 2026-02-20:
//
//   pricingModel: PAY_PER_EVENT
//   charge events: exactly ONE — `result` ("Each result written to the
//   dataset", isPrimaryEvent: true).
//   THERE IS NO PER-RUN CHARGE. Starting a run costs nothing; every
//   dataset row costs one `result` event.
//
// Cross-checked against a real settled run on this account the same day
// (GET /v2/actor-runs/{id}): chargedEventCounts {result: 10} and
// usageTotalUsd 0.023 — i.e. exactly 10 × $0.0023, no run fee. That is
// the measurement this whole model is calibrated against.
//
// ACCOUNT TIER — GET /v2/users/me with APIFY_TOKEN, 2026-08-10:
//   plan.id 'STARTER' ($29/mo), plan.tier 'BRONZE'.
// Hence the BRONZE rate below is the default. If the plan is ever
// downgraded to FREE the default UNDER-estimates by ~17%; re-check
// plan.tier before trusting a preview after any billing change.

'use strict';

// $/result by Apify plan tier, copied verbatim from the live actor's
// `eventTieredPricingUsd.result` block. Do NOT edit from memory — re-fetch.
const PER_RESULT_USD_BY_TIER = Object.freeze({
  FREE:     0.0027,
  BRONZE:   0.0023,
  SILVER:   0.0019,
  GOLD:     0.0015,
  PLATINUM: 0.0009,
  DIAMOND:  0.0005
});

// The tier this account is actually on (measured, see header).
const ACCOUNT_TIER = 'BRONZE';
const DEFAULT_PER_RESULT_USD = PER_RESULT_USD_BY_TIER[ACCOUNT_TIER];

// Fan-out ceiling for media.refreshCommentsFromApify. Lives here rather
// than in the executor so the capability registry's spend-guard estimator
// and the executor's preview cannot drift apart.
const MAX_POSTS_PER_RUN = 100;

// Same default and the same clamp as apifyPullService.IG_COMMENTS_LIMIT.
// Duplicated deliberately: importing apifyPullService would drag axios in
// and make this module un-requirable offline. Pinned by the harness.
const DEFAULT_COMMENT_LIMIT = 50;

// Round to the cent, half-UP. The 1e-9 nudge is load-bearing, not
// cosmetic: an exact half-cent is normally stored a hair BELOW itself in
// binary float, so a bare Math.round(n * 100) / 100 rounds it DOWN.
// 50 posts × 5 comments × $0.0023 is exactly $0.575, stored as
// 0.574999999999999956, and rounds to $0.57 — an approval gate quoting a
// cent less than the real charge. Measured: 13 such cases across the
// plausible (tier × limit × posts) grid. Round-half-up is the correct
// direction for a gate that must not under-state.
function usd(n) {
  if (!Number.isFinite(n)) return 0;
  const rounded = Math.round((n + 1e-9) * 100) / 100;
  // A real cost must never display as $0.00. spendGuard treats an estimate
  // of exactly 0 as "declared free" and skips the cap check entirely
  // (spendGuard.js — `if (est === 0) return { allowed: true }`), so a
  // sub-cent estimate rounding to zero would quietly bypass the gate.
  if (rounded === 0 && n > 0) return 0.01;
  return rounded;
}

// Four places — a per-post figure is fractions of a cent and rounding it
// to 2dp would print $0.12 for a $0.115 unit.
function usd4(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + 1e-11) * 1e4) / 1e4;
}

function positiveNumber(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// $/result actually in force. APIFY_PER_RESULT_USD wins so ops can react
// to a plan change without a deploy.
function resolvePerResultUsd(env = process.env) {
  return positiveNumber(env.APIFY_PER_RESULT_USD) ?? DEFAULT_PER_RESULT_USD;
}

// Comments requested per post — the number the OLD estimate ignored
// entirely, which is what made a limit change invisible in the preview.
function resolveCommentLimit(env = process.env) {
  const n = parseInt(env.APIFY_IG_COMMENTS_LIMIT, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_COMMENT_LIMIT;
}

// Back-compat: APIFY_COMMENTS_PER_UNIT_USD was a flat $/POST constant.
// Honoured when explicitly set so an operator who tuned it keeps their
// number — but it is limit-blind by construction, which the caller
// surfaces as estimateBasis 'per-post-override'.
function resolvePerPostOverrideUsd(env = process.env) {
  return positiveNumber(env.APIFY_COMMENTS_PER_UNIT_USD);
}

/**
 * Cost of a comment refresh fan-out.
 *
 *   posts × commentLimit × perResultUsd
 *
 * because the actor charges per dataset row and a comment IS a row. The
 * old formula was `posts × 0.02`, which is wrong twice over: it invented
 * a per-run fee that does not exist, and it never looked at how many
 * comments each run was asked for. At BRONZE with 100 posts × 50 comments
 * it showed $2.00 against a real ~$11.50.
 *
 * This is an UPPER bound: a post with fewer than `commentLimit` comments
 * bills fewer rows. Over-estimating is the correct direction for an
 * approval gate.
 */
function estimateCommentPullUsd({
  posts,
  commentLimit = DEFAULT_COMMENT_LIMIT,
  perResultUsd = DEFAULT_PER_RESULT_USD,
  perPostOverrideUsd = null
} = {}) {
  const p = Math.max(0, Number(posts) || 0);
  const limit = Math.max(1, Number(commentLimit) || DEFAULT_COMMENT_LIMIT);
  const rate = Number(perResultUsd) > 0 ? Number(perResultUsd) : DEFAULT_PER_RESULT_USD;
  const override = positiveNumber(perPostOverrideUsd);

  const perPostUsd = override != null ? override : limit * rate;
  return {
    posts:        p,
    commentLimit: limit,
    perResultUsd: rate,
    perUnitUsd:   usd4(perPostUsd),
    estimateUsd:  usd(p * perPostUsd),
    // 'per-result' — limit-aware, the real actor pricing model.
    // 'per-post-override' — operator pinned a flat $/post; NOT limit-aware.
    estimateBasis: override != null ? 'per-post-override' : 'per-result'
  };
}

module.exports = {
  PER_RESULT_USD_BY_TIER,
  ACCOUNT_TIER,
  DEFAULT_PER_RESULT_USD,
  DEFAULT_COMMENT_LIMIT,
  MAX_POSTS_PER_RUN,
  usd,
  usd4,
  resolvePerResultUsd,
  resolveCommentLimit,
  resolvePerPostOverrideUsd,
  estimateCommentPullUsd
};
