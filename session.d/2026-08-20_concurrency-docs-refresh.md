# Concurrency docs refresh — PIPELINES.md / ALERTING.md (2026-08-20)

## Task
Docs-only follow-up flagged in passing while another session worked on PR #274 (the
`VEO_CONCURRENCY` 12→24 / `REMOTION_QUEUE_CONCURRENCY` 4→8 raise). `docs/PIPELINES.md`
and `docs/ALERTING.md` still stated older concurrency defaults across several tables
and prose blocks — historical values that predated #274's raise and an earlier
2026-08-04 `RENDER_CONCURRENCY` 8→24 raise. Task: bring every stale mention in those
two files in line with the current numbers in `config/defaults.env` /
`services/concurrency.js`, append rather than delete the historical narrative, and
re-evaluate (not blindly preserve) the "re-measure before raising" caution language
against what the later raises' own reasoning says.

## Established facts
- `config/defaults.env:664` — `VEO_CONCURRENCY=24` (current, live default).
- `config/defaults.env:708` — `REMOTION_QUEUE_CONCURRENCY=8` (current, live default).
- `config/defaults.env:635` — `RENDER_CONCURRENCY=24` (current, live default).
- `services/concurrency.js` SPEC agrees: `VEO_CONCURRENCY` default 24 / max 32
  (~line 35), `REMOTION_QUEUE_CONCURRENCY` default 8 / max 16 (~line 52),
  `RENDER_CONCURRENCY` default 24 / max 64 (~line 27).
- `scripts/verifyConcurrencyConfig.js:94` pins `VEO_CONCURRENCY` = 24;
  `:107-108` pins `REMOTION_QUEUE_CONCURRENCY` = 8; `:79` pins `RENDER_CONCURRENCY` = 24.
  These are the scripts the docs must never contradict — confirmed by running them.
- `routes/ads.js:1805-1806` is the current two-pool (`veo`/`image`) dispatch site.
  The docs previously cited `routes/ads.js:960-961`, which is stale/wrong in the
  current tree — fixed as part of this change.
- `docs/PIPELINES.md`'s §8 concurrency table (`## 8. Concurrency knobs`) never had
  rows for `VEO_TITLING_CONCURRENCY` or `REMOTION_QUEUE_CONCURRENCY` at all — its
  absence was actively teaching the wrong mental model (that `VEO_CONCURRENCY` still
  bounds titling, the exact misconception the 2026-08-05 submit/poll-vs-titling split
  fixed). Added both rows.
- `docs/ALERTING.md:550` and `:577` cite `VEO_CONCURRENCY (12)` and
  `REMOTION_QUEUE_CONCURRENCY (4)` inside **historical incident forensics** — the `12`
  makes the stranded-tail arithmetic `21 video rows − 12 in flight = 9` exact for that
  specific run. These are NOT current-value statements; verified the arithmetic only
  works with the historical number, so left the numbers as-is and annotated with the
  current default alongside them rather than overwriting (overwriting would falsify
  the incident record).
- Ran `bash bin/setup-worktree.sh` in a fresh worktree off `origin/main` (repairs the
  tracked-but-gitignored `node_modules` gaps documented in that script's own header /
  `CLAUDE.md` §4) → full verify suite: **182/182 passed**, including
  `verifyConcurrencyConfig.js` and `verifyTitlingPermit.js` (the two harnesses that pin
  these exact numbers) and `verifyCampaignRunHeartbeat.js` / `verifyLlmErrorCodes.js`
  (which assert on `docs/ALERTING.md` content and did not break).

## State
- Branch: `docs/concurrency-defaults-refresh` (pushed to `origin`).
- PR: **#283**, OPEN. Re-checked fresh after main advanced to `057ab15a`
  (`gh pr view 283`): `mergeStateStatus: CLEAN`, `mergeable: MERGEABLE`. No rebase
  needed.
- Gate: verify suite 182/182 pass (see above).
- Worktree: clean, nothing uncommitted, everything already pushed before this
  checkpoint note was written.
- Docs-only change — no code/behavior touched.

## Next action
Review and merge PR #283. Nothing further needed on this task — it is complete and
green, just waiting on human review/merge.

## Dead ends
- None substantive. One self-caught error worth recording so it isn't repeated: an
  earlier draft (from Grok, cross-checked before applying) linked a markdown anchor
  as `(#8-concurrency--rate-limits)`, which does not exist in the file — the real
  heading is `## 8. Concurrency knobs` → anchor `#8-concurrency-knobs`. Fixed before
  commit; grep for `(#8-concurrency--rate-limits)` in `docs/PIPELINES.md` to confirm
  it's gone (returns 0) if this ever needs re-checking.

## Blocked on
Nothing. Not waiting on any decision from Nick or another session for this task.

## Observation (not part of this task, flagging only)
The shared checkout at `/Volumes/Sayulita/Projects/RS/liquidretail_backend` (not the
worktree used for this PR) is a stale replay: `HEAD` is `870b6592`, well behind
`origin/main` (`057ab15a`), and carries uncommitted modifications to `routes/ads.js`
(diff vs `origin/main`: +125/−783 lines) and `session.md` (+5680/−229 lines) that were
already present before this session touched anything — not produced by this task.
Per the established pattern in this repo (a dirty tree behind a moving trunk usually
reverts landed fixes rather than representing real unmerged work), I did **not**
commit or touch those files. Whoever owns that checkout should `git diff --numstat
origin/main` those two files before deciding whether to commit, stash, or discard —
do not commit blindly under time pressure without that check.
