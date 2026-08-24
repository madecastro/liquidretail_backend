// services/catalogImageQuality.js
//
// PURE classifier for "can this URL actually seed an ad generation, or is
// it a known-broken/low-quality thumbnail that only LOOKS like an image?"
//
// WHY THIS EXISTS (incident 2026-08-18, live QA on staging):
// `services/productDetailsService.js` enriches a CatalogProduct with SerpAPI
// commerce data (price/sellers/rating) and, when the row has no hero image
// at all, gap-fills `CatalogProduct.imageUrl` from whatever thumbnail the
// SerpAPI `google_shopping` result (or a Google Lens match via
// `productReasoner.js`) carried. That thumbnail is served from Google's
// `encrypted-tbn{0,1,2}.gstatic.com/shopping?q=tbn:…` CDN — a tiny, often
// non-loading proxy image (measured live: `naturalWidth`/`naturalHeight` = 0,
// `complete: false` in the browser). Once written to `imageUrl`,
// `catalogProductDetectService.materializeImage` mirrors it to Cloudinary and
// stamps `imageMediaId`, which is exactly the signal the Generate Ads picker
// (and the render pipeline's default-seed resolution — CLAUDE.md §"the
// default seed is now the merchant feed's primary image") reads to decide a
// product is generation-ready. Result: a fully-enabled, unlabeled picker
// card whose "photo" never loads, silently seeding a billable generation
// from garbage. Verified live on Vuori Clothing (14/14 gstatic-imageUrl rows
// are 100% `source:'detect-identified'`) and GymShark (7/7, same pattern).
//
// This module is the single place that decides "is this URL usable as a
// generation seed" so the write-guard (productDetailsService), the
// materialize-guard (catalogProductDetectService), and the picker's honesty
// flag (routes/catalog.js) can't drift out of sync with each other.
//
// Deliberately conservative: only classifies image URLS we have LIVE
// evidence are broken (Google's Shopping/Lens thumbnail CDN). Does not
// attempt to detect every possible low-quality host — extend
// UNUSABLE_IMAGE_HOST_RES if another one is confirmed the same way.

'use strict';

// Google's Shopping-thumbnail delivery CDN. Numbered subdomains
// (encrypted-tbn0/1/2…) are all the same service; match the whole family.
const GSTATIC_THUMBNAIL_HOST_RE = /(^|\.)gstatic\.com$/i;

// Belt-and-suspenders path check — SerpAPI google_shopping / google_lens
// thumbnails observed live all carry this path shape. Host check above is
// the primary signal; this catches the same host reached via a redirect/
// mirror whose hostname check might miss (defensive, not load-bearing).
const GSTATIC_SHOPPING_PATH_RE = /\/shopping\?q=tbn:/i;

/**
 * True when `url` is a known-broken "thumbnail-only" host that must never be
 * treated as a usable generation seed, independent of whether the row has
 * any other image. Non-string / empty input is NOT "unusable" here — that
 * is a separate concept (missing), handled by unusableSeedImageReason.
 */
function isUnusableThumbnailUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  if (GSTATIC_SHOPPING_PATH_RE.test(url)) return true;
  try {
    const parsed = new URL(url);
    return GSTATIC_THUMBNAIL_HOST_RE.test(parsed.hostname || '');
  } catch {
    // Unparseable string that still matched the path regex above would
    // already have returned true; anything else is not our concern here.
    return false;
  }
}

/**
 * The write-guard used by productDetailsService's gap-fill. Mirrors the
 * EXISTING gap-fill semantics (never overwrite a truthy imageUrl) and adds
 * exactly one new rule: don't fill the gap with a known-unusable thumbnail
 * either — leave the row honestly empty instead of dishonestly "ready".
 *
 * Pure, no I/O — callable directly by an offline harness against the exact
 * decision productDetailsService makes, not a re-implementation of it.
 */
function shouldFillImageUrl(existingImageUrl, candidateUrl) {
  if (existingImageUrl) return false;                    // never overwrite — unchanged behavior
  if (typeof candidateUrl !== 'string' || !candidateUrl) return false;
  if (isUnusableThumbnailUrl(candidateUrl)) return false; // THE FIX
  return true;
}

/**
 * Reason a CatalogProduct's current imageUrl cannot seed a generation, or
 * null when it's fine. Two disjoint reasons:
 *   'missing'         — null / '' / whitespace-only. Nothing was ever synced.
 *   'thumbnail-only'   — a real-looking URL that resolves to a known-broken
 *                        thumbnail host (gstatic Shopping/Lens).
 * Used both for the backfill script's scan and the picker's honesty flag —
 * same function, so "what got flagged" and "what got fixed" can never drift.
 */
function unusableSeedImageReason(url) {
  if (url == null || String(url).trim() === '') return 'missing';
  if (isUnusableThumbnailUrl(url)) return 'thumbnail-only';
  return null;
}

/**
 * Fields to merge onto a catalog list/detail API row so the frontend picker
 * can render an honest, non-selectable card instead of silently accepting a
 * dead image. `seedIssue` is null when the row is fine.
 *
 * `seedUnusable` / `seedIssue` are UNCHANGED by the second argument — they
 * remain a pure function of the URL only (see the module comment: a
 * pending-detect row with a real image must never be conflated with a
 * permanently-unusable one). `imageMediaId` is accepted here only to
 * compute the two ADDITIONAL fields below, so a caller upgrading to pass it
 * cannot silently change the meaning of the two existing ones.
 *
 * 2026-08-19 — extends the SAME vocabulary (not a parallel one) to answer
 * the question `seedUnusable` was never meant to answer: "is this card
 * actually ready to render an ad from RIGHT NOW". A row can have a perfectly
 * good `imageUrl` (`seedUnusable: false`) and still have no `imageMediaId`
 * yet — nothing at ingest time materializes it (CATALOG_DETECT_PRECOMPUTE
 * deferral, see catalogProductDetectService.js), and on a freshly-ingested
 * brand that is the OVERWHELMING majority of rows, not a rare timing gap.
 * `pickerBlockReason` names that third state `'materializing'` alongside the
 * two `seedIssue` already had, so the frontend can render "still preparing"
 * distinctly from "broken forever" instead of either silently allowing it
 * (old behavior — the picker never actually gated on imageMediaId, it just
 * quietly did nothing useful) or lumping it in with a dead seed.
 */
function catalogSeedFields(imageUrl, imageMediaId) {
  const seedIssue = unusableSeedImageReason(imageUrl);
  const seedUnusable = !!seedIssue;
  const pickerBlockReason = seedIssue || (imageMediaId ? null : 'materializing');
  return {
    seedUnusable,
    seedIssue,
    // True only once a real Media doc backs the row — the picker's honest
    // "generation ready" bit. False for both 'materializing' and any
    // seedUnusable reason.
    pickerReady: !seedUnusable && !!imageMediaId,
    pickerBlockReason
  };
}

module.exports = {
  isUnusableThumbnailUrl,
  shouldFillImageUrl,
  unusableSeedImageReason,
  catalogSeedFields,
  // exported for the offline harness / revert-proof
  GSTATIC_THUMBNAIL_HOST_RE,
  GSTATIC_SHOPPING_PATH_RE
};
