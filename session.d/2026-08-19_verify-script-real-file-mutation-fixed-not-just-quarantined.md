## 2026-08-19 — Verify scripts mutating real repo files fixed (temp-copy, not quarantine); PR #259

**Context for why this entry exists:** #246 (merged) added `runVerifySuite.js` and found that
`verifyVideoCostReconcile.js`, `verifyVideoTimeoutReconcile.js`, and `verifyQuoteRotation.js`
`fs.writeFileSync` a mutated copy of a REAL shared repo file in place (not a private tmp copy) to
revert-prove a static check, and quarantined all three in `UNSAFE_FOR_PARALLEL`. #259 (open,
`docs/parallel-work-honest-evidence`) reconciled the docs to describe that quarantine accurately.
An adversarial review of #259 found the quarantine itself was not a sufficient fix — this entry
records the actual fix, pushed onto the same `docs/parallel-work-honest-evidence` branch so #259
becomes code+docs together rather than two PRs silently disagreeing about the same defect.

### Why quarantine alone doesn't fix it

`UNSAFE_FOR_PARALLEL` only serializes the three scripts *within one `runVerifySuite.js`
invocation* — it does nothing for `node scripts/verifyVideoCostReconcile.js` run directly, a CI
job, or an agent abort. And `runVerifySuite.js`'s `runOne()` sends `SIGTERM` to a timed-out script,
then `SIGKILL` after a grace period. No `verify*` script installs a `SIGTERM` handler. Reproduced
directly on Node 22.23.1 and 26.5.1: **with no handler, `SIGTERM`/`SIGINT` terminate the process
without running any pending `finally` block.** So a timeout, a CI abort, or a Ctrl-C landing
between the mutating write and the restoring write leaves the real file mutated on disk — a
**reproducible mechanism**, not a report of a specific incident that has actually happened (none is
evidenced anywhere in this repo's history; don't cite one).

**Proved before fixing**: reconstructed the pre-fix `verifyVideoCostReconcile.js` from git history,
added an artificial delay between the mutating write and the restore (to make an external
`kill -TERM` land reliably inside the normally-microsecond window — the delay doesn't change what's
being demonstrated), ran it at the real script path, sent `SIGTERM` ~2s in: `git status` showed
`services/atlasVideoService.js` **modified on disk** afterward — the real, shared, tracked file
left holding the `H1` check's `await` mutation. Repeated the identical delay-and-kill treatment
against the fixed script: `services/atlasVideoService.js` stayed clean throughout; the only
residue was one orphaned file under the OS temp dir (harmless, outside the repo).

### The fix

All three scripts' `withTempMutation` helper now writes the mutated content to a private path
under `os.tmpdir()` (`${scriptName}-${basename}-${pid}-${Date.now()}`, cleaned up in `finally`) and
never touches the real file — same pattern `verifyRatingPairAtomic.js` / `verifySeedClass.js`
already used. `verifyVideoTimeoutReconcile.js`'s one caller that re-read the real path after the
mutating write (`E6`) now reads the returned temp path instead.

**Corrected file list** (the original audit undercounted `verifyQuoteRotation.js`'s targets — its
`H4`/`H8`/`H9` calls also mutate `services/quoteRotationService.js` and
`services/layoutInputService.js`, on top of the already-documented
`services/productReviewsScrapeService.js` and `models/CatalogProduct.js`). Full list now:
- `verifyVideoCostReconcile.js`, `verifyVideoTimeoutReconcile.js` → `services/atlasVideoService.js`
- `verifyQuoteRotation.js` → `services/productReviewsScrapeService.js`, `models/CatalogProduct.js`,
  `services/quoteRotationService.js`, `services/layoutInputService.js`

**Revert-proven against the real production code**, not just each script's own internal
mutate-and-restore self-test — confirms switching to a temp copy didn't downgrade any of these to
a no-op:
- Re-adding the `await` regression in the real `services/atlasVideoService.js` fails
  `verifyVideoCostReconcile.js`'s `E1` (39/40 → back to 40/40 after restore).
- Dropping `campaignRunId` from the real charge-point record fails
  `verifyVideoTimeoutReconcile.js`'s `E2` (25/27 → 27/27).
- Restoring the stale `|| 10` cap in the real `productReviewsScrapeService.js` fails `A1`/`A2`;
  deleting `recentQuoteKeys` from the real `CatalogProduct.js` schema fails `G1`; dropping the
  `secondary_quotes` slice from the real `layoutInputService.js` fails `A7` — all in
  `verifyQuoteRotation.js` (59/59 → transient failures → 59/59 after each restore).

### Quarantine reassessed, not blanket-lifted

`verifyVideoCostReconcile.js`, `verifyVideoTimeoutReconcile.js`, and `verifyQuoteRotation.js` were
removed from `UNSAFE_FOR_PARALLEL` — they no longer touch a shared file. Confirmed clean: 3 full
174-script runs at `--concurrency=16` (174/174 every time), plus 5 repeated runs of exactly the two
scripts that both mutate `services/atlasVideoService.js` run together explicitly (no serialization)
— all clean. `verifyCampaignRunHeartbeat.js` and `verifyConcurrencyConfig.js` **stay** quarantined —
their root cause is an unrelated real-timer margin (same shape as the `verifyDirectorFallbackChain.js`
C4 flake from #246), not file mutation, and this change did not touch their timing internals.

One unrelated, non-reproducing flake observed while stress-testing this: `verifyAgentRegistry.js`
failed once inside a heavily-loaded pool run (233s wall clock vs. the usual ~80-100s) and passed
clean both standalone (1579/1579) and on an immediate full-suite rerun. Not chased further or
quarantined — logged here only so it isn't mistaken for a new regression from this change if it
resurfaces.

### Gate

`npm run lint` clean. Full suite green: 174/174 at `--concurrency=8` and `--concurrency=16` (3
runs). `docs/PARALLEL_WORK.md` updated to match — the stale "every temp-writing script uses
`fs.mkdtempSync`" framing (already partly corrected by #259) is now fully reconciled with the
actual fix, corrected file list, and reduced `UNSAFE_FOR_PARALLEL` membership.

### What NOT to do

- **Do not cite a specific past incident of `services/atlasVideoService.js` actually being found
  corrupted on disk in production/CI.** No such incident is evidenced in `session.d/`, this doc, or
  git history. The corruption mechanism above is reproduced on demand; say "reproducible
  mechanism," never "known incident."
- **Do not unquarantine `verifyCampaignRunHeartbeat.js` or `verifyConcurrencyConfig.js`** without
  separately making their real-timer margins deterministic the way `verifyDirectorFallbackChain.js`'s
  C4 was fixed in #246 — their root cause is untouched by this change.
