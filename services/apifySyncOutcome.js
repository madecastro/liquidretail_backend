// services/apifySyncOutcome.js
//
// Pure terminal-status decision for a demo / apify multi-source sync.
// Separated from apifyIngestService so the truth table is harnessable
// offline and so GENERIC_CATALOG_FAIL_ON_ZERO=false can restore the
// prior "always succeed unless aborted" branch byte-identically.
//
// Fail ONLY when every attempted source came back decisively zero. A
// brand that got IG posts but an empty catalog still succeeds (the
// catalog sub-object already carries ok:false + reason for the UI). A
// catalog-only brand that got nothing fails. Nothing-attempted is a
// config gap, not a run failure.

'use strict';

/**
 * computeSyncOutcome({ shopifyAttempted, shopifyZero, igAttempted, igZero, aborted })
 * → { status: 'succeeded'|'failed'|'cancelled', reason: string|null }
 *
 * Callers own the zero predicates (null vs 0 vs undefined differ per
 * source shape). Recommended:
 *   shopifyZero = !out.shopify || out.shopify.ok === false || (out.shopify.added ?? 0) === 0
 *   igZero      = !out.ig      || out.ig.ok === false      || (out.ig.ingested ?? 0) === 0
 */
function computeSyncOutcome({
  shopifyAttempted = false,
  shopifyZero = true,
  igAttempted = false,
  igZero = true,
  aborted = false
} = {}) {
  if (aborted) {
    return { status: 'cancelled', reason: null };
  }

  const shop = !!shopifyAttempted;
  const ig = !!igAttempted;

  // No sources configured → config gap, not a run failure.
  if (!shop && !ig) {
    return {
      status: 'succeeded',
      reason: 'no sources configured — nothing to sync'
    };
  }

  // Fail only when EVERY attempted source is decisively zero.
  const shopDead = shop && !!shopifyZero;
  const igDead = ig && !!igZero;

  if (shop && ig) {
    if (shopDead && igDead) {
      return {
        status: 'failed',
        reason: 'catalog and Instagram both ingested nothing'
      };
    }
    // At least one source produced data — overall success. The empty
    // side still carries ok:false + reason on its sub-object.
    return { status: 'succeeded', reason: null };
  }

  if (shop && shopDead) {
    return { status: 'failed', reason: 'catalog ingested nothing' };
  }
  if (ig && igDead) {
    return { status: 'failed', reason: 'Instagram ingested nothing' };
  }

  return { status: 'succeeded', reason: null };
}

module.exports = { computeSyncOutcome };
