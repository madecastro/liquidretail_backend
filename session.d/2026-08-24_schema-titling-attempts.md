# 2026-08-24 — declare Ad.titlingAttempts so a backend save() cannot erase adgen's counter

adgen's `fix/video-titling-recoverable` branch added `titlingAttempts` to its
copy of the Ad model: a Number defaulting to 0 that
`brandScriptExecutor.stampTitlingFailureAndThrow` `$inc`s on every titling
failure, shared with `titlingResumeService`, so `TITLING_ATTEMPTS_MAX`
(default 3) bounds retries across the original renderer attempt and every
resume. Both services write the SAME production MongoDB.

This repo's `models/Ad.js` did not declare the path. Mongoose strict mode
silently discards undeclared writes — no error, no warning — so any backend
`save()` on such an ad would reset the counter and reopen unbounded retries
on a master that has already been paid for. This file already records that
failure class (renderError.predictionId, the renderStage sentinel,
titlingNeeded / PR #332).

## Drift, measured not assumed

`ADGEN_BACKEND_PATH=<this worktree> node scripts/verifyModelParity.js` from
adgen's `.wt-video-titling-recovery` (the branch that added the field; no
`node_modules`; `NODE_PATH` unset):

- RED: `1 of 33 model(s) FAILED` — Ad.js lacks `titlingAttempts`. No other
  drifted fields.
- After declaring `{ type: Number, default: 0 }` next to `titlingNeeded`:
  GREEN `33/33 model(s) passed`.

This repo does not read or write the field. The declaration exists so a
backend `save()` cannot erase adgen's value.

## Pin

`scripts/verifyTitlingResume.js` G3 already pins `titlingResumeState` for
this exact silent-drop reason. Added G3c (source declaration, Number) and
G3d (runtime path + default 0). Mutation-proved: delete the declaration →
G3c/G3d red (27/29) and parity red (1/33); restore → 29/29 and 33/33.
