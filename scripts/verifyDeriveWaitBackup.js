#!/usr/bin/env node
'use strict';
/**
 * verifyDeriveWaitBackup — ABSENCE pin for the deleted in-process derive-master
 * wait timeout.
 *
 * WHY THIS FILE USED TO EXIST. routes/ads.js `renderDeriveOnlyVideoAd` waited
 * in-render for a sibling master's plate (`DERIVE_MASTER_WAIT_MS`, 12 min).
 * On timeout it called `handleDeriveMasterBackup` / `notifyDeriveWaitBackup`
 * (requeue + Slack "backup" notice) instead of stamping the ad `failed`.
 *
 * Those two functions, and the wait loop that called them, were deleted with
 * the in-process render loop (owner directive: we are not going back to that
 * infrastructure). Adgen's renderer owns derive rendering now and waits for
 * the master in its own process. Backend no longer waits in-process for a
 * master, so there is nothing here to behaviourally pin.
 *
 * This file is therefore an ABSENCE pin: those two functions must not come
 * back in routes/ads.js. A passing file with a handful of source checks is
 * the correct shape — do not restore the 17 behavioural tests of dead code.
 *
 * MONEY invariant that still lives (do not delete the underlying gate):
 * "A derive-only ad must never reach a billable Omni submit" is still
 * enforced by `resolveDeriveFromMaster` (campaignAdsGenerationService.js)
 * at mint/preflight time — pinned by verifyPmaxVideoExpansion D-group,
 * verifyMetaVideoDerive C-group, verifyPmaxFunnelVariants D-group, etc.
 * Adgen's renderer owns actual derive rendering.
 *
 *   node scripts/verifyDeriveWaitBackup.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const adsSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ads.js'), 'utf8');
const adsRoute = require('../routes/ads');

let pass = 0;
function check(label, fn) {
  fn();
  pass++;
  console.log(`  ✓ ${label}`);
}

console.log('\nDERIVE-WAIT BACKUP (ABSENCE — in-process wait is gone)\n');

check('A1 [ABSENCE] routes/ads.js no longer defines handleDeriveMasterBackup', () => {
  assert.ok(
    !/async function handleDeriveMasterBackup\s*\(/.test(adsSrc)
      && !/function handleDeriveMasterBackup\s*\(/.test(adsSrc),
    'handleDeriveMasterBackup came back — the in-process derive wait was deleted with the render loop'
  );
});

check('A2 [ABSENCE] routes/ads.js no longer defines notifyDeriveWaitBackup', () => {
  assert.ok(
    !/async function notifyDeriveWaitBackup\s*\(/.test(adsSrc)
      && !/function notifyDeriveWaitBackup\s*\(/.test(adsSrc),
    'notifyDeriveWaitBackup came back — Slack-on-timeout lived next to the deleted wait loop'
  );
});

check('A3 [ABSENCE] routes/ads.js no longer exports either backup helper', () => {
  assert.strictEqual(typeof adsRoute.handleDeriveMasterBackup, 'undefined');
  assert.strictEqual(typeof adsRoute.notifyDeriveWaitBackup, 'undefined');
});

check('A4 [ABSENCE] renderDeriveOnlyVideoAd is gone (the wait loop lived inside it)', () => {
  assert.ok(
    !/async function renderDeriveOnlyVideoAd\s*\(/.test(adsSrc),
    'renderDeriveOnlyVideoAd came back — adgen owns derive rendering now'
  );
});

check('A5 routes/ads.js still re-exports resolveDeriveFromMaster (the remaining backend money gate)', () => {
  // The wait/backup path is gone; the mint/preflight gate is not. A derive
  // row must still be classified as free before it can ever be claimed.
  assert.strictEqual(typeof adsRoute.resolveDeriveFromMaster, 'function');
});

console.log(`\n✅ verifyDeriveWaitBackup: ${pass} checks passed`);
