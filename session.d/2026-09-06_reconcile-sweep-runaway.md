# 2026-09-06 — Post-sync reconcile stacked overlapping YOLO chains

Worktree `/Volumes/Sayulita/Projects/RS/.wt-fix-reconcile-sweep`, branch
`fix/reconcile-sweep-runaway` off `main` @ `e6393912`. Design:
`fix-reconcile-DESIGN.md` (approved). Worker-only Render deploy; start
command stays `node worker.js` at repo root.

## What broke

The worker's 30-minute post-sync reconcile tick had no re-entrancy guard
(`worker.js` `postSyncReconcileTick`). A tick whose `sweepIncompleteBrands`
was still awaiting a hours-long YOLO phase did not stop the next interval
from firing. Each tick selected the same brand because signal (a) treated
**any** `catalog-post-sync` row with `status:'failed'` as a retry with no
time bound and no live-chain skip (`catalogPostSyncOrchestrator.js` former
find at `:204-218`). Each re-fire started a new `processQueue` at
`CATALOG_YOLO_CONCURRENCY=6`, so N overlapping chains → 6N concurrent
`/detect-batch` calls. `detectYoloForOne` never threw, so a 0% outage was
ground to completion; transients did not stamp `yoloDetectedAt`, so the
gap never closed. `detectBatch` scaled axios timeout with `ceil(n/2)`
(8 images = 480s) and retried in-flight timeouts while gunicorn still
held the first request.

No revision skew on the cap: `CATALOG_YOLO_MAX_PER_RUN=0` (uncapped) is
intentional (#393). The runaway was overlapping chains, not one uncapped
chain.

## Mechanism (`path:line` on this branch)

- Tick re-entrancy: `worker.js` `postSyncReconcileTick` / `yoloBackfillTick`
  now wrap `createTickGuard` (`services/housekeepingTickGuard.js`).
- Same-process overlap: `runPostSyncChain` holds `inFlightBrands` Set
  (`services/catalogPostSyncOrchestrator.js`).
- Cross-process liveness: sweep consults `heartbeatAt` via
  `progressService.STALE_HEARTBEAT_MS` (imported, not a third parser) and
  latest-run-per-brand, not unbounded `{status:'failed'}`.
- Process-wide catalog HTTP bound: `yoloLoadLimiter.acquire()` in
  `processQueue` and `yoloBackfillTick` (NOT inside `yoloService` — live
  DetectRun / UGC stays uncapped).
- Circuit: 5 consecutive whole-batch transients (timeout/reset/5xx) open
  30 minutes; parent fails with `reason:'yolo-circuit-open'`; Brand
  backoff 30m doubling to 8h (`catalogYoloBackoffUntil` declared).
- Batch client: timeout capped at `YOLO_TIMEOUT_MS` (120s); no retry on
  in-flight `client-timeout` / `conn-reset` / `conn-timeout`.
- Gap predicate: `needsYoloDetection` and `onlyGaps` also require
  `yoloDetectedAt: null`, matching `yoloBackfillTick`, so legit-empty
  (`refinedProducts:[]` + stamp) is not re-queued.

## What changed

Helpers, orchestrator sweep, detection limiter+breaker, yoloService
retry/timeout, worker wiring, Brand schema + `config/defaults.env` knobs
(code default = file default), Slack alerts on circuit-open and brand
abort (`yolo:circuit-open` / `yolo:circuit-open:brand:<id>`),
`docs/ALERTING.md` rows, `scripts/verifyReconcileSweepBounded.js` (A1–I2,
revert-proved), group E extension on `verifyPostSyncOrchestrator.js`.
`parseMaxPerRun` / `CATALOG_YOLO_MAX_PER_RUN=0` untouched.

## How it was verified

- `node --check` on every touched file.
- `npm run lint` (eslint `.`, `no-undef`) clean.
- `scripts/verifyReconcileSweepBounded.js` 28/28. Revert-proof matrix
  executed: 22 mutations, each failed the named check, restore green.
- `verifyLlmErrorCodes.js` 35/35 (ALERTING.md table shape).
- `verifyCatalogRunCapUncapped.js` 41/41 (uncapped default held).
- `verifyPostSyncOrchestrator.js` 29/29 (new env keys in group E).
- Full `npm test` after the new harness.

## Still open

- Per-kind `MAX_RUN_MS` override on `startRun` (4h parent zombie after
  `closeTimers`; same-process registry covers it; do not change
  `progressService` globally).
- Gunicorn 300s / edge 100s / 3×4=12 slot cluster: UNVERIFIED in this
  repo (cited from the incident brief + existing comment). Limiter sized
  6 against the reported 12; do not raise 6 in this PR.
- `scheduledSyncService` 60s interval still has no tick guard (out of
  scope; chains are covered by the in-process registry).
- First deploy has no stored Brand backoff, so it tries immediately
  (owner Q2). Later deploys honor leftover `catalogYoloBackoffUntil`.
