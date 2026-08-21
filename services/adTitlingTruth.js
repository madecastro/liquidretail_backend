'use strict';
//
// THE ONE PLACE THAT DECIDES WHETHER A VIDEO AD IS ACTUALLY TITLED.
//
// WHY THIS FILE EXISTS (2026-08-20 incident): every "is this ad delivered"
// call site in this repo — the run rollup (services/campaignRunGuards.js),
// the Slack "delivered" summary, the ads-detail/list JSON, the Meta push
// gate — inferred delivery from `Ad.renderUrl` being non-null (sometimes
// plus `status === 'draft'`). That is true the INSTANT a video master is
// paid for, which is BEFORE Remotion titling (headline/CTA/rating/quote/
// logo chrome) has even started (routes/ads.js stamps `renderUrl:
// veoVideoUrl` + `status:'draft'` at the same write that sets
// `titlingResumeState:'claimed'`, specifically so the paid asset is
// viewable immediately — see routes/ads.js's money-guard comment and
// services/titlingResumeService.js's header). A run of 39 ads was measured
// reporting 29/39 "delivered" by that heuristic while only 16 carried an
// actually-titled asset; the other 13 were the bare Omni master, shipped as
// if finished, indistinguishable from success by any field an operator
// could see.
//
// THE ACTUAL SIGNAL, and why nothing else already was one:
//   - `renderStage` is free text, "fire-and-forget" (models/Ad.js), and the
//     SAME 'done' string is stamped both for genuine compositing AND for an
//     intentional no-chrome/no-brand ship of the raw master. A missed write
//     (a killed process) also just leaves it stale — it is a breadcrumb,
//     never a delivery flag.
//   - `titlingResumeState` only tracks the RECOVERY debt (bootRecoveryService
//     / titlingResumeService). The NORMAL render path also sets it to
//     'claimed' before titling and clears it to null on any of: genuine
//     success, no-chrome, no-brand, OR titling failure — so a resting
//     `null` is ambiguous between "titled", "shipped bare on purpose", and
//     (pre-this-fix) "titling never finished and nobody will ever know".
//   - There is no `titledAt`/`chromeComposited` boolean anywhere on the
//     schema (confirmed absent — see scripts/backfillUntitledOrphans.js,
//     which exists only because this gap has no honest field to query).
//
// So the only two things that are ALWAYS true together are:
//   1. titling is genuinely settled (not mid-flight / not abandoned
//      mid-flight) — captured by `titlingResumeState` being cleared, and
//   2. either the delivered `renderUrl` DIFFERS from the raw `veoVideoUrl`
//      (proof something actually composited onto it), OR the ad's own
//      `renderStage` says in so many words that shipping the bare master
//      was the deliberate, final outcome (every intentional-ship call site
//      in this repo writes a renderStage starting with the exact prefix
//      "no titling (" — routes/ads.js's derive-only and main veo branches,
//      and titlingResumeService.js's brand-giveup branch. Grepped, not
//      guessed: all three use this prefix).
//
// A resting `titlingResumeState: null` + `renderUrl === veoVideoUrl` +
// anything ELSE (including a stale/frozen in-flight breadcrumb, or no
// renderStage at all) is exactly the untitled-orphan shape this module
// exists to stop counting as delivered.

// Every call site in this repo that intentionally ships the raw master
// (no brand to composite against, or no chrome configured) writes a
// renderStage starting with this exact prefix. Kept as a named export so a
// harness can assert new call sites stay consistent with it instead of
// inventing a fourth wording.
const INTENTIONAL_NO_TITLING_STAGE_RE = /^no titling \(/i;

/**
 * Has titling genuinely settled for this ad, one way or another?
 *
 * Pure function of the Ad doc's own fields — no DB access, no Date.now().
 * Returns false for anything still mid-flight (recovery pending/claimed) or
 * whose only evidence is an unmodified raw master with no explicit
 * "shipped on purpose" breadcrumb. Returns true for images unconditionally
 * (there is no titling step in the static pipeline).
 *
 * @param {object} ad - plain object or lean doc with at least
 *   { kind, status, renderUrl, veoVideoUrl, titlingResumeState, renderStage }
 */
function isVideoTitlingSettled(ad) {
  if (!ad) return false;
  if (ad.kind !== 'video') return true; // no titling concept for statics
  // Recovery debt still open — titling has not started, or a render was
  // claimed and is (or was) in flight. Either way, not settled.
  if (ad.titlingResumeState === 'pending' || ad.titlingResumeState === 'claimed') return false;
  if (!ad.renderUrl) return false; // nothing shipped at all yet
  // No raw master to compare against (shouldn't happen for a video ad that
  // reached renderUrl, but fail toward "settled" rather than crash a caller
  // on a shape this module doesn't recognise).
  if (!ad.veoVideoUrl) return true;
  // The delivered asset differs from the raw master — something composited.
  if (ad.renderUrl !== ad.veoVideoUrl) return true;
  // renderUrl === veoVideoUrl: only settled if this was a DECLARED,
  // intentional bare-master ship, not silence.
  return INTENTIONAL_NO_TITLING_STAGE_RE.test(ad.renderStage || '');
}

/**
 * Is this ad honestly a finished, deliverable creative — the thing an
 * advertiser could actually use? Combines the Ad's terminal status with
 * (for video) the titling-settled check above.
 *
 * `status` gate mirrors the existing `?rendered=true` / projectAd
 * convention: draft|live|archived are the shapes that hold a real asset.
 * 'failed' and anything non-terminal (queued/rendering) are never counted
 * as delivered here, regardless of what renderUrl happens to hold.
 */
function isAdHonestlyDelivered(ad) {
  if (!ad) return false;
  if (ad.status !== 'draft' && ad.status !== 'live' && ad.status !== 'archived') return false;
  return isVideoTitlingSettled(ad);
}

module.exports = {
  isVideoTitlingSettled,
  isAdHonestlyDelivered,
  INTENTIONAL_NO_TITLING_STAGE_RE
};
