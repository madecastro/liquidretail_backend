## 2026-08-12 — stale-run alert + terminal done guard (branch `fix/stale-run-and-done-guard`)

Uncommitted on this branch (off origin/main). Two correctness pins:

1. Render-loop `CampaignRun` `done` write is now status-guarded via
   `buildTerminalDoneFilter` (`services/campaignRunGuards.js`): allow-list
   `['preparing','running']`. A reaper-`failed` run can no longer flip back
   to `done`. CampaignRun enum has no `cancelled` (that name is
   OperationRun / progressService); operator-stop still lands this
   collection on `done`.
2. Watchdog arm 2 is AGE ∧ SILENCE. `startedAt` (`ALERT_RUN_STALE_MIN=45`)
   is a noise filter; `updatedAt` (`ALERT_RUN_SILENCE_MIN=12`) is the
   trigger and must stay strictly below `REAP_STALE_MIN` (15) or the
   reaper empties the set. The rejected `updatedAt`-only-at-45m design
   was not implemented.

Harness: `scripts/verifyRunAlertsAndDoneGuard.js` (33 checks, revert-proven
against four mutations). Not committed.
