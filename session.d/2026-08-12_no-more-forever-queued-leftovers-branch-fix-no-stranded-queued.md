## 2026-08-12 — no more forever-queued leftovers (branch `fix/no-stranded-queued`)

345 prod ads sat `queued` with no receipt / no renderUrl / renderAttempts:0
because `expandWizardJob` mints everything and `selectAdsForRun` claims only
`MAX_CREATIVES_PER_RUN`. A later Generate on the same product could claim and
bill those rows.

This branch (not on `main` yet):
- `CampaignRun.total` stays the **claim** count (progress-bar denominator).
  `mintedTotal` / `unclaimedAtStart` / `notice.code='minted-ads-unclaimed'`
  are the honest gap. The HTTP 202 cannot know the overflow (expand is
  post-202); GET `/api/ads/runs/:runId` is where it lands, same as
  `perProduct`.
- Ads are stamped with the minting `campaignRunIds` at insert.
- `services/queuedArchiveSweeper.js` (WORKER) moves leftovers to
  `status:'archived'` after `QUEUED_ARCHIVE_AFTER_H=24` once every owning
  run is terminal. Receipt / renderUrl / renderAttempts>0 are refused.
- Harness: `scripts/verifyNoStrandedQueued.js` (revert-proven).

