#!/usr/bin/env node
/**
 * Offline harness for the unscoped-review-count fix (and the surviving
 * video-snippet-cap pin). No DB, no network, no API key.
 *
 * WHAT THIS EXISTS TO CATCH (observed on delivered Vuori creative):
 *
 *  remotion/lib/slotContent.js fabricated an UNSCOPED count:
 *    meta?.reviewsText || (meta?.reviewCount ? `${reviewCount} reviews` : '')
 *  A bare "15545 reviews" beside one product asserts a catalog-wide total as
 *  that SKU's own volume — the exact misattribution BRAND_SCOPE_LABEL exists
 *  to prevent, and which ratingDisplay's docstring claims is impossible
 *  ("There is no such hole now"). The hole was in the renderer.
 *
 * REMOVED (dormant render fallback deletion): groups S1–S14
 * (`selectStaticQuoteText` / `resolveStaticQuoteCap` on
 * `services/directImageRenderService.js`) and the rotation R1–R7 that
 * imported those wrappers. Those functions were deleted with
 * `renderDirectImage`; adgen owns static rendering unconditionally now.
 * Canonical rotation lives in `quoteRotationService.js` and is pinned by
 * `scripts/verifyQuoteRotation.js`. Surviving coverage here is the VIDEO
 * snippet cap (quoteSnippetService, still 50 for the 3s overlay) and the
 * remotion/ratingDisplay unscoped-count pins.
 *
 * REVERT-PROVEN — each mutation confirmed to FAIL, then restored:
 *   - restore the unscoped `${reviewCount} reviews`     -> R1/R2
 *
 * Run: node scripts/verifyQuoteSurfaceLength.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC_SLOT = path.join(__dirname, '..', 'remotion', 'lib', 'slotContent.js');
const SRC_SNIP = path.join(__dirname, '..', 'services', 'quoteSnippetService.js');

let pass = 0, fail = 0;
const check = (label, fn) => {
  try { fn(); pass++; }
  catch (e) { fail++; console.log(`   • ${label} — ${String(e.message).split('\n')[0].slice(0, 220)}`); }
};

const slotSrc = fs.readFileSync(SRC_SLOT, 'utf8');
const snipSrc = fs.readFileSync(SRC_SNIP, 'utf8');

console.log('V. The video snippet cap is untouched');

check('V1 quoteSnippetService still caps at 50 for the 3s overlay', () => {
  assert.ok(/const MAX_CHARS = 50;/.test(snipSrc),
    'the video overlay cap must stay 50 — this change is static-only');
  assert.ok(/3-second video overlay/.test(snipSrc), 'the video rationale should remain documented');
});

console.log('R. No unscoped review count can reach a frame');

check('R1 the unscoped fabrication is gone from slotContent', () => {
  assert.ok(!/\$\{meta\.reviewCount\}\s*reviews/.test(slotSrc),
    'slotContent still fabricates a bare "<n> reviews" with no tier qualifier');
  assert.ok(!/meta\?\.reviewCount\s*\?\s*`/.test(slotSrc),
    'the reviewCount-based fallback template is still present');
});
check('R2 reviewsText is taken only from the scoped upstream value', () => {
  assert.ok(/const reviewsText = meta\?\.reviewsText \|\| '';/.test(slotSrc),
    'reviewsText must come solely from ratingDisplay, which attaches the qualifier');
});
check('R3 the slot still shows on rating-only (GymShark-style suppression intact)', () => {
  // rating present + no reviewsText must NOT hide the slot; the guard is
  // "neither rating nor reviewsText". Structural check on the surviving guard.
  assert.ok(/if \(!hasRating && !reviewsText\) return null;/.test(slotSrc),
    'the both-absent guard must remain — removing it would blank legitimate rating-only lockups');
});
check('R5 the SIBLING fabricator in ReviewCountSlot is closed too', () => {
  // Adversarial review: closing the rating composite in slotContent.js left
  // ReviewCountSlot formatting a BARE NUMBER into "15,545 reviews" — unscoped,
  // and it dropped the word "brand" that made the upstream string honest. R1
  // only greps slotContent.js, so it never saw this. Reachable via an
  // operator/LLM titleStyleSpec enabling the reviewCount slot; no shipped
  // preset does today, which is why it was latent rather than live.
  const rs = fs.readFileSync(path.join(__dirname, '..', 'remotion', 'components', 'slotRenderers.jsx'), 'utf8');
  const i = rs.indexOf('export const ReviewCountSlot');
  assert.ok(i !== -1, 'ReviewCountSlot not found');
  const region = rs.slice(i, i + 2400);
  assert.ok(!/\$\{asNum\.toLocaleString\('en-US'\)\}\s*review/.test(region),
    'ReviewCountSlot still fabricates an unscoped "<n> reviews" from a raw number');
  assert.ok(/isPrewrapped/.test(region),
    'a prewrapped scoped string must still pass through untouched');
});
check('R4 scoped strings still flow (ratingDisplay is the only author)', () => {
  const rd = fs.readFileSync(path.join(__dirname, '..', 'services', 'ratingDisplay.js'), 'utf8');
  assert.ok(/BRAND_SCOPE_LABEL = 'brand reviews'/.test(rd), 'brand scope label changed');
  assert.ok(/function formatBrandReviewsText/.test(rd), 'brand reviewsText formatter missing');
});

const total = pass + fail;
if (fail === 0) {
  console.log(`\n✅ verifyQuoteSurfaceLength: ${pass}/${total} checks passed\n`);
  process.exit(0);
}
console.log(`\n❌ verifyQuoteSurfaceLength: ${fail} FAILED, ${pass} passed\n`);
process.exit(1);
