## 2026-08-19 — Cost-ledger audit: reconcile CostLog to ACTUAL BILLED spend, not local estimates

Branch `fix/cost-ledger-billing`, worktree `.worktrees/cost-ledger-billing`, based on
`main` (`75f70209`, PR #228 included). Money-critical audit of the entire cost-ledger
system against Atlas. **148/148 verify scripts + `npm run lint` clean.** Full findings
and mechanism write-up now live in `docs/ATLAS.md` §4 (the canonical location) —
read that before touching this area again; only the headline is repeated here.

**Corrected the coordinator's own initial brief mid-session:** Atlas DOES have a
billing API — the base path is `/public/v1/` (not `/v1/` or `/api/v1/`), three
endpoints (`balance`, `model-costs`, `model-usage`), with a documented refund policy
("failed tasks are never billed, including timeouts"). This is now the basis for the
new daily cross-check tool, below.

**Fixed:**
- `MODEL_RATES` was missing the PLAIN (non-`-ccmax`) Claude slugs the live Director
  fallback chain actually calls (`anthropic/claude-sonnet-5`, `anthropic/claude-opus-5`,
  `anthropic/claude-sonnet-4.5-20250929`) — a successful Director round was ledgering
  $0.0050 (surcharge only). Added, live-verified against the Atlas model catalog.
- `costSource` gained a FOURTH value, `'unknown'` (`models/CostLog.js`
  `COST_SOURCES`) — an unmapped model now always stamps `'unknown'` instead of
  sometimes masquerading as a small `'estimated'` figure, and pages Slack once per
  model instead of only a console line. `costForRun()` reports `unknownUsd`
  separately.
- **Video FAILED-case phantom spend — a SECOND path, not just the one PR #225 fixed.**
  `atlasVideoService.generateForAd`'s non-retryable failure branch threw with no cost
  correction, and `routes/ads.js` marks the Ad `'failed'` synchronously (never sits in
  `'rendering'` for `bootRecoveryService` to catch). New `resolveFailureCostReconcile()`
  closes it; `bootRecoveryService.resolveRecoveredVideoFailureCharge` now delegates to
  the same function instead of carrying a second copy of the same tri-state rule.
- `atlasVideoService`'s `reframe-outpaint` stage never stamped `providerRequestId` on
  its charge-point row even though the id was available — an un-reconcilable flat
  estimate forever, discarding a settled price `pollPrediction` had already read.
  Wired to the same `scheduleVideoCostReconcile` path the video master uses.
- Two stale Atlas-gateway rates corrected (live-verified): `google/gemini-2.5-flash`
  cachedInput 0.075→0.03, `google/gemini-2.5-pro` cachedInput 0.31→0.125. (The BARE,
  direct-provider `gemini-2.5-pro` key is deliberately left untouched — see its own
  2026-08-03 note, a different call path.)

**New scripts:**
- `scripts/backfillCostReconcile.js` — idempotent, dry-run by default (`--apply` to
  write), walks every historical `costSource:'estimated'` row with a
  `providerRequestId` and re-settles it from Atlas's own prediction record. First dry
  run: 30 rows total history, 24 correctable, delta **-$13.16** (claimed $20.36,
  settled $7.20) — confirms the two known incident rows
  (`59e2b1b9…`/`c584d847…`, `run_1787119100250_eef4d871`) settle to $0 as expected.
  **NOT YET APPLIED — the auto-mode classifier blocked the `--apply` write (a live
  DB mutation) and I did not attempt to bypass it.** Dry-run output is reproducible
  (`MONGODB_URI=… ATLAS_API_KEY=… node scripts/backfillCostReconcile.js`); owner
  should run `--apply` directly or explicitly authorize it.
- `scripts/reconcileAtlasDailyCosts.js` — read-only daily cross-check against
  `/public/v1/model-costs` (the aggregate-level reconciliation LLM rows can get,
  since they have no per-request price field anywhere in Atlas's API — confirmed by
  reading the actual chat-completions response handling, not assumed). First run
  surfaced a real, actionable drift: 2026-08-17 claimed +40% vs Atlas's billed total,
  almost entirely `google/gemini-2.5-flash` — likely the flat grounding-search
  surcharge over-firing against Google's free allowance. Flagged as a follow-up
  (spawned task), not chased down this pass.

**Validation fixture** (`run_1787119100250_eef4d871`, brand Vuori): could not query by
`campaignRunId` (null on every row from before the 2026-08-19 threading — expected,
documented). Reconstructed via `productId` + a time window: 48 rows, $3.9810 claimed
— within $0.005 of the brief's $3.9863. Zeroing the two phantom video charges brings
it to **$1.581**, matching the brief's "~$1.59" target almost exactly.

**Not fixed, flagged instead (real gaps, out of scope for a reconciliation pass):**
`atlasTextService.generate` (3 `routes/brand.js` title-spec call sites) and a few raw
`generateContent`/grounded-search calls bypass the ledger entirely — no CostLog row
at all, not even an estimate. Adding a brand-new charge point is a bigger change than
"reconcile an existing one"; see the audit report / spawned follow-up tasks.

**Coordination:** `.worktrees/cost-run-attribution` has uncommitted, unrelated
`campaignRunId`-threading changes touching `atlasVideoService.js` (different
functions/regions — `refreshStaleLayoutInput`/`prepareStoryboard` signatures only,
confirmed no overlap by reading its diff before editing). No other worktree had
uncommitted changes to `costTracker.js`/`CostLog.js`/`atlasVideoService.js` as of
this session. Re-checked immediately before this commit.

