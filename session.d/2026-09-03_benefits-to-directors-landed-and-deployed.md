# 2026-09-03 — benefits-to-directors landed (backend #383 + adgen #109), both deployed

Both halves of the benefits-to-directors feature (Part A-D: product benefits
shipped to the titling director and the static Director, persisted title
specs always honoured, `TITLE_SPEC_IGNORE_PERSISTED` deleted, the stackFit
multi-slot height fix) are now merged and live.

- **Backend**: [PR #383](https://github.com/emami-rs-project/liquidretail_backend/pull/383),
  squash commit `47be257c46`. Two prior commits (`ef88a481`, `9eb4955b`) were
  already on the branch and CI was already green; this session added one more
  commit, `fix(titling): grid stackFit under-estimate, itemStyle wiring, stale
  citations` (`30fa281b`).
- **Adgen**: [PR #109](https://github.com/Emami-RS-Project/liquidretail_adgen/pull/109),
  squash commit `330530969c`. Two prior commits (`facf48d`, `15f39d8`) were
  already on the branch with CI red; this session added
  `fix(vendor-drift): reconcile all 10 files verifyVendorDrift flagged on CI`
  (`9d116f0`).

## What backend's new commit actually did

`9eb4955b`'s own commit message described a real code fix (stackFit's grid
branch capping wrapped lines at `maxLines`, a `-webkit-line-clamp` concept
`renderMultiValue` never applies to individual items — measured 1.92x
under-estimate; the `itemStyle:'bullet'` dot+gap width not being subtracted;
`itemStyle` wired into `Canonical.jsx`'s `estCtx` in both repos; a CLAUDE.md
money-invariants correction; 8 orphaned `config/defaults.env` keys removed)
— but the actual diff of that commit only contained the two `scripts/wip/`
file additions. The real code was still sitting **uncommitted** in the
worktree when this session started. This session verified it (239/239,
lint clean), committed it as a new commit (never amends published commits —
house rule), and pushed.

## The bootRecoveryService.js finding — inspected, not shipped

The uncommitted worktree also carried a 5-line addition to
`services/bootRecoveryService.js` — flagged for close inspection since that
file recovers stuck Atlas video-generation claims after a crash
(money-adjacent, "money-safe by construction" per `CLAUDE.md`). On
inspection it was **not a real code change**: a trailing comment appended
past `module.exports`, self-labeled `// REVERT-PROVE INJECTION (temporary,
removed after this demonstration)`, citing a fictitious
`services/nonexistentGuardModule.js` / `enforceNoDoubleTitling` that exists
nowhere else in the repo. Zero functional effect (dead comment, no code
executes differently), but it does not belong in a money-critical file's
history — a future reader could waste real time chasing a module that was
never built. Reverted with `git checkout -- services/bootRecoveryService.js`
before committing; not included in `30fa281b`.

This is almost certainly leftover test scaffolding from whoever built the
untracked `scripts/verifyDocCitations.js` found alongside it in this same
worktree (a 74KB, well-written, cross-repo-portable graduation of
`scripts/wip/docCitations.needsWork.js` — the WIP script `9eb4955b` itself
describes as "left as a starting point, not a gate"). That script currently
fails when run and was never mentioned in this session's brief, so it was
left **untracked, uncommitted, unreviewed** in the worktree — it needs its
own review pass before it should be wired into `npm test`'s
`scripts/verify*.{js,mjs}` glob (which it would be, automatically, the
moment it's committed, since nothing else registers verify scripts by name).
An identical copy sits in the adgen worktree too — same story there.

## Vendor-drift detail (adgen side, recorded here since it explains a real
gap the branch's own commits left)

Of the 10 vendored files adgen's `verifyVendorDrift` flagged (this branch
changed 7 of them: `Root.jsx`, `Canonical.jsx`, `stackFit.js`,
`titleSpecService.js`, `titleSpecValidator.js`, `brandScriptExecutor.js`,
`priceFormat.js`; 2 more — `adVisionQcService.js`, `veoPromptBuilder.js` —
were already-recorded pre-existing forks that needed re-attesting once
touched by the same reconcile pass; `reframeStrategyChooser.js` needed a
correction, see below), only 4 (`priceFormat.js`, `stackFit.js`,
`titleSpecService.js`, `titleSpecValidator.js`) had a fresh manifest entry
in the uncommitted `scripts/vendor-manifest.json` diff this session inherited.
The other 6 were reconciled fresh this session, each with a real per-file
decision (not a blanket re-hash) — see adgen's own `session.md` CURRENT STATE
for the full breakdown. One correction worth carrying here too:
`reframeStrategyChooser.js` was mislabeled `fork` ("ported wholesale, no
adgen-specific divergence") when in fact backend's `origin/main` has since
shipped `COMPOSITE_MASK_METHOD` (force-crop default, a live-evidence fix for
Nano Banana composite-outpaint hallucination on beyond-tolerance reframes,
dated 2026-09-03) that adgen's copy does not have. Relabeled `unported`,
owed to adgen — porting it is out of scope here and still open.

## Deploy

All 6 Render services (backend WEB `srv-d1vuktqli9vc73ft07ng` + WORKER
`srv-d8128c1o3t8c73e8kb30`; adgen `adgen-api`/`adgen-orchestrator`/
`adgen-renderer`/`adgen-titler`) auto-deployed via GitHub integration within
under a minute of each merge, confirmed `live` via `render deploys list` at
the correct squash-merge commit SHAs. Backend's `/api/health` returned
"API is running". No render.yaml exists in this repo (adgen has one with
`autoDeploy: true`); backend's auto-deploy is dashboard-configured GitHub
integration, consistent with the pattern the adgen #102 / backend #374
landing already established.

## Adgen's E1 (`verifyRegenerateInFlightGate`) — confirmed pre-existing,
unrelated

Independently reproduced red on a detached clone of adgen's `origin/master`
at `8242275` (pre-#109) — same message, same cause (a different, still
unmerged PR moves `services/adRegenerateService.js`'s manifest hash; this is
the adgen-side merge-order gate, not a defect in benefits-to-directors).
Confirmed again post-merge on a fresh clone of the true `origin/master`
(not the possibly-stale local main checkout) — still red, for the same
documented reason. Not something this PR could or should have fixed.
