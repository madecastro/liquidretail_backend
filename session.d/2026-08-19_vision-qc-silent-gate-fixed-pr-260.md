# Vision QC ran on 0/39 ads: gate confirmed intentional, "off" no longer reads as "clean" — PR #260

Branch `fix/vision-qc-silent-gate`, PR
[liquidretail_backend#260](https://github.com/Emami-RS-Project/liquidretail_backend/pull/260).
Frontend companion `Emami-RS-Project/liquidretail` `fix/vision-qc-not-inspected-fe`, PR
[liquidretail#62](https://github.com/Emami-RS-Project/liquidretail/pull/62). Both open,
not merged — owner reviews and merges.

## The report that started this

Owner: vision QC didn't catch a hallucinated jacket colour, and asked why. Measured prod
directly: run `run_1787174963435_ff67021e` (Marine Layer 2, 39/39 ads delivered — 21
video, 18 static) had `Ad.visionQc` on **zero** of its 39 ads.

## Root cause: a real, deliberate gate — not a deploy-timing gap, not a swallowed exception

Ruled out deploy timing first, concretely: the ads rendered 21:29–21:56 UTC on
2026-08-19. Render's deploy history for both `srv-d1vuktqli9vc73ft07ng` (web) and
`srv-d8128c1o3t8c73e8kb30` (worker) shows the live deploy for that entire window was
`c633e2c194`, created 20:17:44, superseded 21:37:17 — and `git merge-base
--is-ancestor 49e08692 c633e2c194` (49e08692 = PR #240's merge commit, the video-QC
wiring) returns true. The code had been live for over 3 hours before this run started.

Queried prod directly instead of guessing (read-only Render job, base64-eval'd script,
zero cost): `process.env` has **zero** keys matching `VISION`/`QC` —
`AD_VISION_QC_ENABLED` is unset — and `SystemConfig.findOne({key:'default'})` returns
**null**, no document exists at all. `resolveEnabled()`/`isEnabled()` therefore
correctly fall through to their documented default: `false`. This is a real, working
gate, confirmed **by design** — `scripts/verifyQcGateWiring.js`'s own docstring quotes
the owner from when this was built: *"I don't want to QC gate yet, but let's wire it up
so it's easy to flip on without a re-deploy if we want to test it."* Nobody has flipped
it since. **This PR takes no position on flipping it** — that's a cost/product call,
not a code fix, and flipping `SystemConfig.adVisionQcEnabled` is a one-line change via
the existing `setAdVisionQcEnabled()` whenever the owner wants it.

## The actual bug this PR fixes

All three live callers of `adVisionQc.isEnabled()` —
`directImageRenderService.renderDirectImage` (~line 2557),
`brandScriptExecutor.runVideoVisionQcForAd` (~line 1588),
`imageRecoveryService.maybeQcRecoveredPlate` (~line 325) — short-circuited on the gate
being off with a bare `return firstOutput` / `return null`, **before ever reaching**
`runPostRenderQc`'s / `runVideoPostRenderQc`'s own "Flag off" branch, which is the ONLY
code that builds the `{skipped:true, disabled:true, reason:'AD_VISION_QC_ENABLED=false'}`
verdict shape and logs anything (`🔍 adVisionQc: ad=- gate=OFF — skip vision...`). That
branch was consequently **dead code in production** — one caller's own doc comment even
said the null return was deliberately "mirroring directImageRenderService's
early-return-without-stamping," having copied the exact same gap into a second pipeline
without anyone noticing it was a gap. Net effect: `Ad.visionQc` stayed at its schema
default `null` on every ad, reading identically to "inspected and passed" to
`summarizeVisionQc`, the gallery pill, AND — the sharper problem — `GET /runs/:runId`'s
`shippedWithoutQc` rollup, which only ever queried `'visionQc.skipped': true` and
therefore counted these 39 ads as **0**, not 39. **A QC pass that silently no-ops looked
exactly like one that never ran, which looked exactly like one that ran clean** — three
different facts, one representation. This is the exact "vision QC never ran renders
identically to vision QC passed" framing the owner's report used.

## Fix

- All three early returns now stamp the disabled-verdict shape via the already-exported
  `adVisionQc.buildPersistedVerdict(...)`, and call a new shared
  `adVisionQc.warnQcDisabledOnce(label)` (hourly re-warn, not once-per-process-ever) so
  the gate being off is loud in logs, not silent. Verified zero behavior change beyond
  the stamped field: no downstream consumer branches on `visionQc === null` vs an
  object (all read `if (visionQc) …` or `visionQc.field || fallback`), and no extra
  billable call is introduced — the disabled branch never reaches `generate()` /
  `judgeRender` / a second video submit.
- `GET /runs/:runId`'s `shippedWithoutQc` query is now
  `$or: [{'visionQc.skipped': true}, {visionQc: null}]` — Mongo equality on `null`
  matches a missing field too, the ONLY way historical ads (shipped before this fix,
  which cannot be retroactively backfilled) are ever counted as "not inspected" at all.
- Added a third rollup count, `qcFailed` (a real, non-skipped, non-disabled verdict that
  came back `passed:false`) — the "inspected and flagged" state, alongside
  `shippedWithoutQc` ("not inspected") and a silent clean pass. Previously only
  "not inspected" existed as a rollup, and it undercounted to zero whenever the gate was
  off.
- Frontend companion updates the run banner to show all three states distinctly instead
  of one undifferentiated warning; extended its dev-only fixture harness
  (`visionqc-harness.html`) with 3 new cases proving the distinction, including the
  actual production incident (39/39 delivered, 39 not inspected) reproduced verbatim —
  screenshotted.

## Problem 3 (verbose Slack QC on pass), re-verified not re-built

The owner's mid-#240 ask — *"I want to see the [vision QC] output even if it is
approved so I can see what it is looking for and what it observes"* — is correctly
wired: `noteQcPassToRunFeed`/`noteQcFailToRunFeed` → `buildQcSlackDetail` →
`formatThreadLine`, pinned by `scripts/verifyAdVisionQc.js`'s existing P1–P5 (all still
green, re-ran to confirm). **It has never fired on a live ad** because the gate has
been off since it shipped — not a bug, just never exercised. Flagging this explicitly
so the first real Slack post from this path (whenever the gate is turned on) isn't
mistaken for new/broken behavior.

## Verification

- Extended `scripts/verifyAdVisionQcSurfacing.js`: C5/C6 (structural, source-scanned
  against the real `GET /runs/:runId` query text — anchored on the unique
  `'visionQc.disabled'` text and walked backward to ITS OWN `Ad.countDocuments({`, not
  the nearest one textually before it, after a first draft's non-greedy regex silently
  matched across the wrong query) and D2–D5 (behavioral: `runVideoVisionQcForAd` and
  `maybeQcRecoveredPlate` driven directly via `require.cache` stubbing of
  `adVisionQcService` — same convention as `verifyGenerateProductTenancy.js`'s
  `adReadinessService` stub; `directImageRenderService`'s early return is pinned
  structurally instead, since its "attempt 1" generation makes it too
  expensive/billable to drive end-to-end offline).
- All 8 new checks hand-revert-proven one at a time (reverted, watched the specific
  check go red, restored, watched it go green again) — not just "the suite is green":
  the three early returns, the `shippedWithoutQc` `$or`, and the warning's
  one-shot-per-interval guard.
- Full backend suite: `npm test` → **174/174 passed**. `npm run lint` clean.
- Frontend: `npx tsc --noEmit` clean, `npm run build` clean, live-verified via
  `npm run dev` + the fixture harness + screenshots (get_page_text cross-check too,
  since the Browser pane intermittently failed to composite on the first tab of a
  session — a fresh tab fixed it every time).
- Prod queried **read-only** via a Render one-off job (env vars, `SystemConfig`, the
  run's 39 `Ad.visionQc` docs, deploy-vs-run timestamp cross-check) — zero cost, no
  billable call made or triggered.

## Process note for the next session

This session was killed by an account spend limit mid-implementation once already.
The orchestrator rescued the six uncommitted backend files as a WIP checkpoint
(`5d0cc88b`, force-pushed) before the worktree could be cleaned up — verified the
claim independently (branch existed on origin, file list matched) rather than trusting
it blind, then rebased onto `main` (which had moved to `6575b0b2`/#246 meanwhile, plus
`b280ea71`/#256 and `9e82771f`/#255 by the time of the final push) and amended the
commit message once the work was actually reviewed and gate-verified. **Commit and
push early, even mid-implementation** — this is the second near-loss on this exact
class of mistake per the owner's standing note.

`npm test` (new parallel runner from #246, ~150s wall clock at concurrency=8) was used
for the full-suite gate. `test:affected` was deliberately NOT used — a known hole in
`scripts/runVerifySuite.js`'s basename filter (`length >= 4`) excludes 3-letter
basenames like `Ad.js`→`"Ad"` and would have under-run given `models/Ad.js`-adjacent
and `routes/ads.js` (`"ads"`) changes here.
