#!/usr/bin/env node
'use strict';
/**
 * Verify the ad-recency fix (2026-08-05).
 * No DB, no network, no API key.
 *
 * THE DEFECT THIS EXISTS TO CATCH: Ad.generatedAt (models/Ad.js) is stamped
 * ONCE at row creation and is NEVER updated on a fresh render (renderService.js
 * `persistStage`) or on dedupe-reuse (routes/ads.js `claimAdsForRun`). Three
 * places ranked/badged "recent activity" by generatedAt alone, so a row
 * created weeks ago and re-rendered today looked exactly as stale as before —
 * reproduced live 2026-08-05 (brand "Pelagic Gear": ads created 2026-07-30,
 * re-rendered 2026-08-05, ranked #3-5 and badged "~6 days ago" on the Product
 * Ads page). The fix reads recency from `renderedAt` (already correctly
 * stamped on every render) via services/adRecencyService, falling back to
 * generatedAt only when an ad was never rendered.
 *
 * Run: node scripts/verifyAdsRecency.js
 */

const fs = require('fs');
const path = require('path');
const { resolveAdRecency } = require('../services/adRecencyService');

const ROOT = path.join(__dirname, '..');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// ── Section 1 — source-text: every call site uses the shared helper ──────

const catalogSrc   = read('routes/catalog.js');
const campaignsSrc = read('routes/campaigns.js');
const adsSrc       = read('routes/ads.js');

check(
  '1.1 catalog.js requires adRecencyService',
  /require\(['"]\.\.\/services\/adRecencyService['"]\)/.test(catalogSrc)
);
check(
  '1.2 campaigns.js requires adRecencyService',
  /require\(['"]\.\.\/services\/adRecencyService['"]\)/.test(campaignsSrc)
);
check(
  '1.3 ads.js requires adRecencyService',
  /require\(['"]\.\.\/services\/adRecencyService['"]\)/.test(adsSrc)
);

check(
  "1.4 catalog.js buildAdStatsByProduct's lastGeneratedAt uses AD_RECENCY_EXPR",
  /lastGeneratedAt:\s*\{\s*\$max:\s*AD_RECENCY_EXPR\s*\}/.test(catalogSrc)
);
check(
  "1.5 campaigns.js ads-summary's lastGeneratedAt uses AD_RECENCY_EXPR",
  /lastGeneratedAt:\s*\{\s*\$max:\s*AD_RECENCY_EXPR\s*\}/.test(campaignsSrc)
);
check(
  '1.6 catalog.js ads-detail sorts by a recency expression, not bare generatedAt',
  /\$addFields:\s*\{\s*_recencyAt:\s*AD_RECENCY_EXPR\s*\}/.test(catalogSrc)
    && /\$sort:\s*\{\s*_recencyAt:\s*-1\s*\}/.test(catalogSrc)
);
check(
  '1.7 ads.js GET / sorts by a recency expression, not bare generatedAt',
  /\$addFields:\s*\{\s*_recencyAt:\s*AD_RECENCY_EXPR\s*\}/.test(adsSrc)
    && /\$sort:\s*\{\s*_recencyAt:\s*-1\s*\}/.test(adsSrc)
);
check(
  '1.8 ads.js GET / accepts a campaignRunId filter (DB-level scope, not just client-side)',
  /filter\.campaignRunIds\s*=\s*String\(req\.query\.campaignRunId\)/.test(adsSrc)
);

// Found by adversarial review 2026-08-05: campaigns.js has its OWN
// /:id/ads-detail, a near-mirror of catalog.js's, which was still sorting by
// bare generatedAt — the same defect on a second surface. Fixing only the
// named sites leaves a twin bug, so this asserts NO remaining
// .sort({generatedAt:-1}) exists in either route file at all (the general
// form, rather than one more named-site check that the next mirror escapes).
// Strip line comments before scanning — these route files legitimately DISCUSS
// the old `.sort({generatedAt:-1})` pattern in the comments explaining why it
// was replaced, and matching those would make the check unfailable-for-the-
// wrong-reason (it would report a regression that isn't there, and a real
// regression would be indistinguishable from prose).
function stripLineComments(src) {
  return src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
}
const BARE_GENERATED_SORT = /\.sort\(\{\s*generatedAt:\s*-1\s*\}\)/;
check(
  '1.11 catalog.js has no remaining .sort({generatedAt:-1}) ad query (code, not comments)',
  !BARE_GENERATED_SORT.test(stripLineComments(catalogSrc))
);
check(
  '1.12 campaigns.js has no remaining .sort({generatedAt:-1}) ad query, code only ' +
  '(its /:id/ads-detail mirrors catalog.js and had the identical bug)',
  !BARE_GENERATED_SORT.test(stripLineComments(campaignsSrc))
);
check(
  '1.13 campaigns.js /:id/ads-detail uses the recency sort expression',
  /\$addFields:\s*\{\s*_recencyAt:\s*AD_RECENCY_EXPR\s*\}/.test(campaignsSrc)
    && /\$sort:\s*\{\s*_recencyAt:\s*-1\s*\}/.test(campaignsSrc)
);

// Revert-provable negative: the literal pre-fix accumulator must not remain
// anywhere in the three files (whitespace-tolerant).
const REGRESSION_PATTERN = /\{\s*\$max:\s*['"]\$generatedAt['"]\s*\}/;
check(
  '1.9 catalog.js no longer contains the bare {$max:"$generatedAt"} accumulator',
  !REGRESSION_PATTERN.test(catalogSrc)
);
check(
  '1.10 campaigns.js no longer contains the bare {$max:"$generatedAt"} accumulator',
  !REGRESSION_PATTERN.test(campaignsSrc)
);

// ── Section 2 — behavioral: the real adRecencyService module ─────────────

const DAY = 24 * 60 * 60 * 1000;
const NOW    = new Date('2026-08-05T17:21:22.000Z');
const T_6D   = new Date(NOW.getTime() - 6 * DAY);
const T_30D  = new Date(NOW.getTime() - 30 * DAY);
const T_1H   = new Date(NOW.getTime() - 1 * 60 * 60 * 1000);

check(
  '2.1 dedupe-reused-and-rerendered row resolves to renderedAt, not stale generatedAt (the exact reproduced case)',
  (() => {
    const r = resolveAdRecency({ generatedAt: T_6D, renderedAt: NOW });
    return !!r && new Date(r).getTime() === NOW.getTime();
  })()
);

check(
  '2.2 a genuinely stale, never-rerendered row keeps its real old timestamp (does not flatten every ad to "now")',
  resolveAdRecency({ generatedAt: T_30D, renderedAt: null }).getTime() === T_30D.getTime()
);

check(
  '2.3 a queued/never-rendered row falls back to generatedAt without throwing or producing Invalid Date',
  (() => {
    const r = resolveAdRecency({ generatedAt: T_1H, renderedAt: null, status: 'queued' });
    return r && !Number.isNaN(new Date(r).getTime()) && new Date(r).getTime() === T_1H.getTime();
  })()
);

check(
  '2.4 null-safety — resolveAdRecency(null) does not throw and returns null',
  resolveAdRecency(null) === null
);

check(
  '2.5 null-safety — resolveAdRecency({}) does not throw and returns null',
  resolveAdRecency({}) === null
);

check(
  '2.6 multi-ad-per-product $group shape — Math.max over resolveAdRecency matches the real production case ' +
  '(4 ads/product, only one re-rendered) and picks "now", not the stale timestamps',
  (() => {
    const productAds = [
      { generatedAt: T_6D,  renderedAt: NOW },   // re-rendered today
      { generatedAt: T_6D,  renderedAt: null },  // never touched since creation
      { generatedAt: T_30D, renderedAt: null },
      { generatedAt: T_6D,  renderedAt: null }
    ];
    const maxTs = Math.max(...productAds.map(a => new Date(resolveAdRecency(a)).getTime()));
    return maxTs === NOW.getTime();
  })()
);

// ── Section 3 — sort-comparator non-regression ────────────────────────────
// The bug was entirely in what value feeds the sort, not the sort/ranking
// logic itself. Confirm both consuming comparators are unchanged — a value-
// only fix should not need to touch ranking code.

check(
  '3.1 catalog.js productsOut.sort() comparator is unchanged (recency desc, then coverage asc)',
  /productsOut\.sort\(\(a, b\) => \{\s*const ta = a\.lastActivityAt/.test(catalogSrc)
);
check(
  '3.2 campaigns.js out.sort() comparator is unchanged (recency desc, then coverage asc)',
  /out\.sort\(\(a, b\) => \{\s*const ta = a\.lastActivityAt/.test(campaignsSrc)
);

// ── Revert-proof note (manual, per CLAUDE.md §5) ──────────────────────────
// Two independent mutations, each verified by hand to flip a distinct subset:
//   1. Revert adRecencyService's AD_RECENCY_EXPR/resolveAdRecency back to
//      generatedAt-only -> 2.1 and 2.6 fail (both would report the stale
//      timestamp instead of "now"). The 1.x source-text checks do NOT catch
//      this mutation on their own — they only assert the route files
//      reference the shared helper, not what that helper computes, which is
//      exactly why the Section 2 behavioral cases exist against the module.
//   2. Revert a route file's accumulator back to the literal
//      `{ $max: '$generatedAt' }` (e.g. catalog.js) -> the matching 1.x
//      source-text checks for that file fail (both the positive
//      AD_RECENCY_EXPR-usage check and the negative regression-pattern
//      check), independent of whether adRecencyService itself is correct.

console.log('\nADS RECENCY FIX\n');
if (failures.length) {
  console.error(`❌ verifyAdsRecency: ${failures.length} FAILED, ${pass} passed\n`);
  failures.forEach((f) => console.error(`   • ${f}`));
  process.exit(1);
}
console.log(`✅ verifyAdsRecency: ${pass} checks passed`);
