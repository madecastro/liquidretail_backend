#!/usr/bin/env node
'use strict';
/**
 * Verify that a billable image submit is ledgered AT THE CHARGE POINT, exactly once.
 * No DB, no network, no API key.
 *
 * THE INCIDENT (2026-08-05). A deploy SIGTERM killed nine gpt-image-2/edit
 * predictions mid-poll. Atlas confirms all nine COMPLETED and billed $0.5663.
 * CostLog held ZERO rows for them. Every recordFlatCost on the image path fired
 * INSIDE the poll loop or in chargedError, so a process death between submit and
 * outcome recorded nothing at all — and unledgered spend is unreconcilable,
 * because nothing knows to go looking for it.
 *
 * atlasVideoService already wrote its row at the charge point for exactly this
 * reason. Images never got the same treatment.
 *
 * THE TRAP THIS HARNESS EXISTS FOR. recordFlatCost INSERTS (persistCost ->
 * CostLog.create). Adding a charge-point row while leaving the outcome writes as
 * inserts would produce TWO rows per submit and DOUBLE-COUNT every image charge —
 * strictly worse than the gap it fixes. So the outcome must REFINE the row
 * (finalizeFlatCost), never add one.
 *
 * Run: node scripts/verifyChargePointLedger.js
 */

const fs = require('fs');
const path = require('path');
const costTracker = require('../services/costTracker');

const ROOT = path.join(__dirname, '..');
let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const imgSrc  = fs.readFileSync(path.join(ROOT, 'services/atlasImageService.js'), 'utf8');
const costSrc = fs.readFileSync(path.join(ROOT, 'services/costTracker.js'), 'utf8');

console.log('\nCHARGE-POINT LEDGER\n');

// ── A. The charge-point row exists and is an INSERT ──────────────────────
const submitIdx = imgSrc.indexOf('const id = submit.data.data.id;');
const loopIdx   = imgSrc.indexOf('while (Date.now() - t0 < generationTimeoutMs)');
const chargePoint = submitIdx > -1 && loopIdx > submitIdx ? imgSrc.slice(submitIdx, loopIdx) : '';

check('A1 there IS a cost write between the submit id and the poll loop',
  /recordFlatCost\(\{/.test(chargePoint));
check('A2 it is keyed to the prediction id, so the outcome can find and refine it',
  /providerRequestId:\s*id/.test(chargePoint));
check('A3 it is ledgered as `submitted` — a real CostLog.COST_STATUSES value, or '
    + 'persistCost coerces it to `error` and the row lies about what happened',
  /status:\s*'submitted'/.test(chargePoint)
  && require('../models/CostLog').COST_STATUSES.includes('submitted'));
check('A4 it is costSource:estimated — the settled price is not known yet, and per '
    + 'the owner rule an estimate is never presented as a confirmed charge',
  /costSource:\s*'estimated'/.test(chargePoint));
check('A5 it is fire-and-forget — telemetry must never fail a POST-payment render',
  /\}\)\.catch\?\.\(\(\) => \{\}\)/.test(chargePoint));

// ── B. [MONEY] The outcome REFINES, never re-inserts ─────────────────────
// Every write carrying a providerRequestId after the charge point must be a
// finalize. If any is still recordFlatCost, that submit gets two rows.
const afterCharge = imgSrc.slice(loopIdx > -1 ? loopIdx : 0);
const strayInserts = (afterCharge.match(/recordFlatCost\(\{[\s\S]{0,120}?providerRequestId/g) || []).length;
check('B1 [DOUBLE-COUNT] no recordFlatCost after the charge point carries a '
    + 'providerRequestId — those must be finalizeFlatCost or the charge is counted twice',
  strayInserts === 0, `found ${strayInserts}`);
check('B2 the outcome branches do use finalizeFlatCost',
  (afterCharge.match(/finalizeFlatCost\(\{/g) || []).length >= 3);
check('B3 the submit-REFUSAL write stays an insert — nothing was created, so there '
    + 'is no charge-point row to refine (and no prediction id to key on)',
  (() => {
    const refusal = imgSrc.slice(0, submitIdx);
    return /recordFlatCost\(\{/.test(refusal) && !/finalizeFlatCost\(/.test(refusal);
  })());

// ── C. finalizeFlatCost's own contract ───────────────────────────────────
check('C1 it is exported', typeof costTracker.finalizeFlatCost === 'function');
check('C2 [TRAP] a missing providerRequestId falls back to an INSERT rather than '
    + 'updating on a null key — upserting on null would collapse every id-less '
    + 'LLM row into one shared record',
  /if \(!id\) return recordFlatCost\(meta\);/.test(costSrc));
check('C3 it updates in place, not upsert:true — the fallback is explicit so a '
    + 'missing row is visible rather than silently conjured mid-update',
  /upsert:\s*false/.test(costSrc));
// C4 REWRITTEN after the first live recovery dry run. It used to assert an
// unconditional fallback insert. That was wrong: CostLog requires `stage`, and
// persistCost DROPS a row that fails validation — so a caller passing only
// { providerRequestId, costUsd } got a SILENT no-op on exactly the rows that
// predate the charge-point ledger and most need recording. The fallback now
// refuses loudly instead of attempting a write that is certain to be discarded.
check('C4 the fallback insert fires for a COMPLETE record, and REFUSES LOUDLY for '
    + 'an incomplete one rather than attempting a write CostLog will silently drop',
  /if \(!meta\.stage\)/.test(costSrc)
  && /NOT ledgered/.test(costSrc)
  && /await recordFlatCost\(meta\);/.test(costSrc));
check('C5 an unknown status is coerced against COST_STATUSES before the write, '
    + 'matching persistCost — otherwise validation drops the whole row',
  /COST_STATUSES\.includes\(raw\)/.test(costSrc.slice(costSrc.indexOf('async function finalizeFlatCost'))));

// ── D. Behavioral: the fallback path, with CostLog stubbed ───────────────
(async () => {
  const CostLog = require('../models/CostLog');
  const origUpdate = CostLog.updateOne;
  const origCreate = CostLog.create;
  try {
    let updates = 0, creates = 0, lastFilter = null;
    CostLog.updateOne = async (filter) => { updates++; lastFilter = filter; return { matchedCount: 1 }; };
    CostLog.create    = async () => { creates++; return {}; };

    await costTracker.finalizeFlatCost({ providerRequestId: 'pred_x', costUsd: 0.07, status: 'ok' });
    check('D1 with an id and an existing row: ONE update, ZERO inserts',
      updates === 1 && creates === 0, `updates=${updates} creates=${creates}`);
    check('D2 the update is keyed on providerRequestId',
      lastFilter && lastFilter.providerRequestId === 'pred_x');

    updates = 0; creates = 0;
    CostLog.updateOne = async () => { updates++; return { matchedCount: 0 }; };
    await costTracker.finalizeFlatCost({
      providerRequestId: 'pred_y', stage: 'direct_image', provider: 'atlas',
      model: 'openai/gpt-image-2/edit', costUsd: 0.07, status: 'ok'
    });
    check('D3 with an id, NO existing row, and a COMPLETE record: falls back to an '
        + 'insert so the spend is not lost',
      updates === 1 && creates === 1, `updates=${updates} creates=${creates}`);

    updates = 0; creates = 0;
    await costTracker.finalizeFlatCost({ providerRequestId: 'pred_z', costUsd: 0.07, status: 'ok' });
    check('D3b [SILENT-DROP] an INCOMPLETE record attempts NO insert — CostLog would '
        + 'reject it on the required `stage` and persistCost would discard it without '
        + 'the caller ever knowing',
      updates === 1 && creates === 0, `updates=${updates} creates=${creates}`);

    updates = 0; creates = 0;
    await costTracker.finalizeFlatCost({ costUsd: 0.01, status: 'ok', provider: 'atlas', model: 'm' });
    check('D4 with NO id: inserts, and never issues an update on a null key',
      updates === 0 && creates === 1, `updates=${updates} creates=${creates}`);
  } finally {
    CostLog.updateOne = origUpdate;
    CostLog.create = origCreate;
  }

  // ── Revert-proof (manual, per CLAUDE.md §5) ────────────────────────────
  // 1. Delete the charge-point write -> A1..A5 fail.
  // 2. Turn any outcome finalizeFlatCost back into recordFlatCost -> B1 fails
  //    (this is the double-count regression, and it is the reason B1 scans by
  //    pattern rather than naming the three call sites).
  // 3. Drop the `if (!id)` guard in finalizeFlatCost -> C2 fails, and D4 shows the
  //    update firing on a null key.
  // 4. Change status:'submitted' to a value not in COST_STATUSES -> A3 fails.
  // Each verified by hand before shipping this harness.

  if (failures.length) {
    console.error(`❌ verifyChargePointLedger: ${failures.length} FAILED, ${pass} passed\n`);
    failures.forEach((f) => console.error(`   • ${f}`));
    process.exit(1);
  }
  console.log(`✅ verifyChargePointLedger: ${pass} checks passed`);
})();
