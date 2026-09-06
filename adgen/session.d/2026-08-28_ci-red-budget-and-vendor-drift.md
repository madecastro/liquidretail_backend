# 2026-08-28 — trunk CI-red fix: Remotion concurrency budget + vendor-drift reconciliation

PR #94 (`fix/trunk-ci-red-budget-and-vendor-drift`). Worked from a sibling worktree
(`.wt-trunk-ci-green`, off `origin/master` @ `64220bd`, which already includes the
now-merged PR #76), never nested, per this repo's own `CLAUDE.md` rules. Bare — no
`npm ci`, no `NODE_PATH` set manually — with the sibling `liquidretail_backend` checkout
present alongside it.

**Baseline, measured fresh on pristine `origin/master`:** `79/82`, two real failures
(`verifyRemotionMemoryBudget.js`, `verifyVendorDrift.js`) plus the one pre-existing
red-by-design `verifyRunFinalizesOnSettle_KNOWN_OPEN.js`. **After this PR: `81/82`, exit
0**, only that same red-by-design harness.

## Issue 1 — `REMOTION_QUEUE_CONCURRENCY` 3→2 revert, not a harness widen

`a108753` bumped the file default 2→3 "staging tolerance," reasoning entirely from the
2026-08-24 measurement (1.97 GiB/slot, RAM-only). **Did not bump `verifyRemotionMemoryBudget.js`
check A1 to match** — that check exists specifically to stop an unmeasured re-raise from
landing silently (this exact knob has now been raised and reverted five times, each
documented as a dated section in `config/defaults.env`'s own comments).

Re-derived with fresh measurement this session (concurrency=2, the renderer, which also
runs the poll/claim loop + Atlas HTTP + static submits in-process — `ADGEN_TITLER_ENABLED`
is false in production today, so this constant currently governs the renderer's in-process
titling, not an isolated titler instance):

- **RAM**: peak RSS 4.69 GiB of 8 (58.6%) — hotter than the ladder's own 2×1.97=3.94 GiB
  (49%) prediction. Per-slot measured directly at 1.7–2.3 GiB (noisy, not a constant).
  Either extrapolation to 3 slots lands at 86–88%, not the claimed 74%/"~2 GiB headroom" —
  2–4 points from this file's own 90% "OOM territory" line, with the observed variance
  alone (top of the 1.7–2.3 range) eating the rest.
- **CPU** — never budgeted once across six prior revisions of this ladder, all RAM-only:
  already 2.54 of 4 cores (63.5%) at concurrency=2. Linear extrapolation to 3 slots
  projects ~95% CPU — CPU exhaustion, not RSS, is the more likely failure mode at 3, and it
  would starve the SAME process's heartbeat/boot-recovery/claim-poll loops this repo's
  money-safety mechanisms depend on running promptly.

**Reverted to 2** (new dated section appended to `config/defaults.env`, matching the
file's own established practice) rather than re-deriving a new safe N for 3 — that needs a
real RAM+CPU measurement at the candidate value, on whichever process will actually run it
(renderer today; the titler once `ADGEN_TITLER_ENABLED` flips), not an extrapolation from
2-slot data. Verified `verifyRemotionMemoryBudget.js` 18/18 in a disposable CI-faithful
clone (`npm ci`, no sibling backend, matching `.github/workflows/ci.yml`) — the bare
worktree's own standalone run of this one script showed unrelated C1–C7 failures from a
missing `axios` (no `node_modules` in a bare tree); those do NOT appear in
`node scripts/runVerifySuite.js`, which sets `NODE_PATH` at the sibling backend for exactly
this reason (`scripts/runVerifySuite.js`'s `childEnv()`) — that is the correct, documented
way to run this suite, not the standalone-script invocation.

## Issue 2 — `verifyVendorDrift.js`: 5 failing checks, 11 distinct files

Reconciled individually — `git log -S` + a fresh diff against backend's `origin/main` per
file, not a bulk sweep. Trunk had moved since the task was scoped (originally 8 files; 11
by the time I ran it: `models/Ad.js` and `services/atlasModelMap.js` and
`services/singletonLease.js` were additional).

**Deliberate forks / adgen-only, re-attested (no live gap):**
- `services/singletonLease.js` — untracked in the manifest. PR #79's distributed lease,
  explicitly "NOT a port" of backend's per its own header. Required from
  `orchestrator.js:34` — not dead.
- `services/handoffContract.js` — untracked + flagged dead by the reachability check
  (only walks `src/`). Actually consumed by `scripts/verifyHandoffContract.js` (test
  tooling), byte-identical to backend's copy.
- `services/shotTypeRank.js` — recorded synced, now diverges. Adgen added
  `APPAREL_SHOT_TYPE_RANK` (apparel-safety mitigation, e24b182) — backend never renders
  images in production (`liquidretail_backend`'s own session.md), so has nothing to
  mitigate. (Side note, not a reconcile question: the reference-side half of this
  mitigation is defined but its one call site still passes the default `apparelSafe:false`
  — only the prompt-side half is wired. Flagging for whoever owns that feature.)
- `services/atlasModelMap.js` — backend disabled the `'director'` role's Anthropic direct
  twin (missing `ANTHROPIC_API_KEY` on its Render services). Not ported: adgen's
  `'director'` role is unreachable today (`aiCreativeDirectorService.js` is vendored but
  `orchestrator.js` is still Phase 0). Flagged for whoever wires Phase B expansion to check
  adgen's own `ANTHROPIC_API_KEY` provisioning first.
- `models/Ad.js` — backend (#347) caught up its OWN stale comment
  (`$ne:null`→`$type:'object'`) to match what adgen's copy already documented correctly.
  Nothing to port.
- `services/veoPromptBuilder.js` — **downgraded `unported`→`fork`** per owner directive
  (2026-08-28, stated twice this session): backend's prompt-building code is no longer
  maintained as first-class, and prompt-safety fixes made here are not ported there going
  forward. This supersedes the prior "port to backend" entry for the operator-refinement
  fix (#77) — backend's unsafe wording stays as-is, deliberately, not an oversight.

**Real owed-port debts, confirmed and left `unported` (`owedSince` carried forward, not
reset):**
- `services/campaignAdsGenerationService.js` — backend fixed the shared-portrait-master
  sharing gate (owner decision 2026-08-26: share the plate regardless of the hook-first
  switch). Adgen's copy still gates on the old switch, which is OFF by default — would
  double-bill a ~$0.90 portrait master if this code ever runs. **Currently dead code in
  adgen** (only reachable from expansion/mint, which `orchestrator.js` explicitly does not
  run — "Phase 0" — confirmed `resolveDeriveFromMaster`, the one function from this file
  that IS live via `renderer.js:141`, is byte-identical between the two repos). Zero live
  impact today; must land before any Phase B expansion work wires this in.
- `services/brandScriptExecutor.js` — backend still structurally lacks the resumable
  titling-failure mechanism (`stampTitlingFailureAndThrow`, `TITLING_ATTEMPTS_MAX`, #81).
  Checked both worktrees that might be removing backend's in-process titling execution
  entirely (`.wt-remove-backend-titling`, branch `remove-backend-titling-fn`; a second,
  `.wt-remove-dead-code-be` / `chore/remove-dead-code-cleanup`, appeared mid-session) —
  **neither has any commits yet**, so this is not moot. Whoever picks either up next: if
  the removal lands first, re-reconcile this entry to "moot" rather than porting into code
  about to be deleted.
- `services/adRegenerateService.js` — re-verified against the now-MERGED PR #76 (confirmed
  via `gh pr list`: MERGED 2026-08-28T17:23Z, squash `64220bd`; the
  `.wt-regen-lease-merge` worktree has stale pre-squash leftovers, not authoritative).
  Confirmed the dispatcher (backend) / consumer (adgen) split is correct architecture, not
  drift — Grok cross-checked this independently and converged on the same read. **Real gap
  found**: backend's `runVideoFull`/`runImage` are missing the
  `assertNotInFlightBeforeSubmit()` execute-time re-check PR #90 added — confirmed absent
  by grep, zero occurrences. Ruled OUT as a gap: adgen's explicit `allowResume:false` has
  no backend counterpart to port, because backend's own `atlasVideoService.generateForAd`
  has no `allowResume` parameter at all (verified directly, `services/atlasVideoService.js:3908`
  on origin/main) — the whole resume-from-receipt mechanism is adgen-side.
- `services/spendReceipt.js` — **fixed a wrong status label**: recorded `unused` ("only
  reached from unused spendGuard"); verified FALSE by grep — it's live-wired into
  `renderer.js` (`resolveUnsettledTimeoutAction:1944,1959`, `receiptFree:2744,2746`) and
  `bootRecoveryService.js` (`HAS_RECEIPT:96,194`). Reconciled to `fork`: adgen's
  hold/terminal/release decision and backend's read-side HTTP helper
  (`adSpendReceipts`/`receiptId`, for `routes/ads.js`/`routes/catalog.js`) are each
  correctly one-sided — adgen has no HTTP API to serve, backend's own unsettled-timeout
  handling is structurally different (never releases the claim) so may not share the exact
  race PR #82 fixed, though a full audit of backend's own claim semantics is a separate,
  unstarted follow-up.
- `services/atlasVideoService.js` — **the reframe-claim-eviction + poll-budget piece this
  entry tracked (backend #355 / adgen #89) is confirmed NOW SYNCED**, verified by direct
  diff of the specific mechanism (`_activeReframeClaims`/`releaseAllActiveReframeClaims`,
  `REFRAME_POLL_MS`/`REFRAME_CLAIM_TTL_FLOOR_MS` — byte-identical function bodies on both
  sides). **Unrelated, still-owed**: the #82 video-timeout-livelock fix's `MAX_POLL_MS`
  raise (600000→900000) is confirmed still not ported (backend `services/atlasVideoService.js:345`
  on origin/main is still 600000). The file remains ~720 lines longer in adgen than
  backend with 28 remaining diff hunks — this pass verified ONLY the named mechanism, not
  the full remaining divergence; do not read `unported` here as fully characterized.

## Not done here (flagged, not built) — per the money-critical-port constraint

- `assertNotInFlightBeforeSubmit()` port to backend's `adRegenerateService.js`.
- `brandScriptExecutor.js` titling-resumability port to backend (also contingent on the
  in-flight-but-not-started titling-removal work above).
- `atlasVideoService.js`'s #82 `MAX_POLL_MS` debt — not re-derived or ported.

Money-critical manifest entries touched: `spendReceipt.js`, `adRegenerateService.js`,
`atlasVideoService.js`, `brandScriptExecutor.js`, `veoPromptBuilder.js`. All bookkeeping
(status/reason/hash), no functional code changed in any vendored service file.

## Addendum — backend moved again mid-session (PR #360 landed while this PR was open)

While the above was in progress, `liquidretail_backend`'s `origin/main` advanced twice more
(`b557b492` #358, then `abf7e0c2` **#360, "remove(titling): delete backend's in-process
titling function (MONEY)"** — the exact titling-removal task this PR's `brandScriptExecutor.js`
entry was watching for) — landed via a fresh PR, not through either worktree checked earlier.
Re-verified rather than assumed:

- **`brandScriptExecutor.js` itself is UNCHANGED by #360** (confirmed: not in its changed-files
  list) — its own commit message explicitly keeps it alive as a shared helper for backend's
  three manual retitle HTTP endpoints (`routes/brand.js`). **Port question is NOT moot** —
  updated the manifest reason accordingly (narrower blast radius now: manual-trigger-only,
  not the automatic render loop, but the underlying gap is unchanged).
- **`adRegenerateService.js`** — #360 additionally removed `runVideoFull`'s titling call
  (`loadBrand()` deleted, Stage 3 now unconditional `qcAndStampVideoAd`), confirmed dead code
  per the commit's own comment (already unreachable — `shouldDeferToAdgen()` always returns
  before this in production). Re-confirmed `assertNotInFlightBeforeSubmit`/`allowResume` are
  still absent — the real finding is unaffected.
- Six more files drifted purely from backend's continued churn during this session
  (`adTitlingTruth.js`, `campaignRunGuards.js`, `platformFormats.js`,
  `bootRecoveryService.js`, `concurrency.js`, `atlasImageService.js`) — all re-diffed fresh;
  all comment-only or mechanical (inlining constants from the deleted
  `titlingResumeService.js`, dropping a dead `companions` field, removing a
  now-orphaned `VEO_TITLING_CONCURRENCY` entry). No functional gaps found; existing
  fork/unported classifications and `owedSince` clocks preserved.
- **Four manifest entries went genuinely stale** (backend DELETED the files outright:
  `services/titlingResumeService.js`, `services/semaphore.js`, plus the already-unused
  `nerService.js`/`whisperService.js` from #358) — removed from
  `scripts/vendor-manifest.json` directly (no `--reconcile` path exists for a
  backend-side deletion; `verifyVendorDrift.js`'s own "stale" check has no CLI remedy,
  by design — see its header). **Adgen's own copies of these files are completely
  untouched** — in particular `src/services/titlingResumeService.js` is adgen's own, very
  much LIVE, wired titling-recoverability mechanism (`resumeUntitledMasters()`, called from
  `renderer.js`) — its manifest entry becoming stale reflects backend no longer having a
  counterpart to diff against, not anything about adgen's copy. That stale entry's `reason`
  text was itself outdated pre-removal too ("only required from unwired
  bootRecoveryService" — untrue since the 2026-08-25 wiring); moot now that the entry is
  gone, but worth knowing the manifest had a second, unrelated staleness bug sitting in it.

`node scripts/runVerifySuite.js` reconfirmed green (81/82, exit 0) after each round of
re-verification. If it's red again by the time you read this, trunk has moved yet again —
this file is a snapshot of one moment, not a standing guarantee.
