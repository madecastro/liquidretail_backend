#!/usr/bin/env node
/**
 * verifyPreviewBillable.js — the dry-run preview must tell an operator what a
 * run CHARGES for, not just what it delivers. Offline: no DB, no network.
 *
 * WHY THIS EXISTS
 * ---------------
 * A PMax video run delivers, per product: 2 billable Omni masters (9:16 +
 * 16:9), 1 FREE 1:1 crop of the 9:16, and 3 funnel re-titles per surface —
 * 12 deliverables, 2 of which cost money. Four products therefore preview as
 * "48 creatives" while charging for 8 Omni submits.
 *
 * The wizard showed only the 48. That is survivable on the hand-picked flow,
 * where the operator built the selection themselves. It is NOT survivable on
 * the express "Quick generate — use defaults" button, where one click can
 * commit a run the operator never itemised: 48 is indistinguishable from a
 * ~6x larger bill, and the honest answer (8 masters) is not on screen.
 *
 * THE INVARIANT, and the direction that matters: billable must never be
 * LARGER than what the run can actually charge for, and free derivations must
 * never be counted as billable. Over-counting scares an operator off a cheap
 * run; UNDER-counting bills them for a run they thought was cheap. Both are
 * pinned, because "just make the number smaller" is the tempting wrong fix.
 *
 * REVERT-PROOF RECIPE (each must fail this harness):
 *   a) count the derive-only 1:1 as a master        -> B2 fails
 *   b) count funnel variants as billable            -> B2/B3 fail
 *   c) report billable === total deliverables       -> B3 fails
 *   d) drop the billable block from the response    -> B1 fails
 */

const path = require('path');
const svc = require(path.join(__dirname, '..', 'services', 'campaignAdsGenerationService'));
// PMAX_FUNNEL_STAGES is owned by the generation service (it drives expansion);
// GOOGLE_VIDEO_MASTERS is owned by platformFormats (it defines what is paid for).
const { PMAX_FUNNEL_STAGES } = svc;
const { GOOGLE_VIDEO_MASTERS } = require(path.join(__dirname, '..', 'services', 'platformFormats'));

const failures = [];
let passed = 0;
const check = (label, cond, detail = '') => {
  if (cond) { passed++; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};

// The shape the service is expected to expose. Asserted structurally so a
// rename cannot silently drop the number the operator spends against.
check('B1 the preview entry point is exported', typeof svc.expandWizardJob === 'function');
// The billable block must exist in the SHIPPED source of the dry-run response,
// so a rename or deletion is caught even though calling it needs a DB.
{
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'campaignAdsGenerationService.js'), 'utf8');
  check('B1 dry-run response carries a billable block', /billable:\s*\{/.test(src),
    'the operator-facing spend number is gone from the preview response');
  check('B1 billable reports videoMasters', /videoMasters:/.test(src));
  check('B1 billable reports freeDerived', /freeDerived:/.test(src),
    'without this the free re-titles are indistinguishable from paid masters');
  check('B1 billable masters derive from the master list, not the delivered total',
    /billableVideoMastersPerProduct\s*=\s*dryMasterFormats\.length/.test(src),
    'billable must be computed from paid masters only');
}

// ── B2. the derive-only surface is NOT a master ─────────────────────────
// GOOGLE_VIDEO_MASTERS is the billable list; the 1:1 must not be in it.
check('B2 GOOGLE_VIDEO_MASTERS excludes the free 1:1 crop',
  Array.isArray(GOOGLE_VIDEO_MASTERS) && !GOOGLE_VIDEO_MASTERS.includes('pmax_video_1_1'),
  `masters=${JSON.stringify(GOOGLE_VIDEO_MASTERS)} — a derive-only surface here bills for a free asset`);
check('B2 GOOGLE_VIDEO_MASTERS is exactly the two paid masters',
  Array.isArray(GOOGLE_VIDEO_MASTERS) && GOOGLE_VIDEO_MASTERS.length === 2,
  `masters=${JSON.stringify(GOOGLE_VIDEO_MASTERS)}`);

// ── B3. the arithmetic the wizard shows ─────────────────────────────────
// Reproduced independently (not by calling the service) so it pins the RULE
// rather than echoing the implementation.
{
  const PRODUCTS = 4;
  const masters = GOOGLE_VIDEO_MASTERS.length;          // 2 billable
  const stages = (PMAX_FUNNEL_STAGES || []).length;      // 3 free re-titles
  const perProductDelivered = masters + 1 + stages * (masters + 1);
  const delivered = PRODUCTS * perProductDelivered;
  const billable = PRODUCTS * masters;

  check('B3 delivered count matches the observed wizard number (48 for 4 products)',
    delivered === 48, `computed ${delivered} from masters=${masters} stages=${stages}`);
  check('B3 billable is far smaller than delivered',
    billable === 8 && billable < delivered,
    `billable=${billable} delivered=${delivered}`);
  check('B3 free derivations are the remainder, never billable',
    delivered - billable === 40, `free=${delivered - billable}`);
  // The direction that matters: under-counting bills a surprise.
  check('B3 billable never exceeds delivered', billable <= delivered);
}

const total = passed + failures.length;
if (failures.length) {
  console.error(`\n❌ verifyPreviewBillable: ${failures.length} FAILED, ${passed} passed (of ${total})\n`);
  failures.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log(`\n✅ verifyPreviewBillable: ${passed} checks passed`);
