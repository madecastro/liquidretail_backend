# 2026-08-24 — persist remotion child stderr/stdout tails on Ad.renderError

Tonight's run `run_1787579089058_b7efb329` left 4 of 12 video ads failed with only
`remotion child exited code=1 signal=none`. The child's real error was on
`err.stderrTail` (supervisor `makeChildError`) and then silently dropped:
`renderError` is a strict mongoose subdocument and `stderrTail`/`stdoutTail`
were not declared. Same trap the schema comment already documents for
`predictionId`.

## Write path (adgen is the live renderer; backend is model-parity + titling persist)

1. `src/services/remotionChildSupervisor.js:164` `makeChildError` sets
   `err.stderrTail` (last 40 lines) and `err.stdoutTail` (last 10).
   Serialized-error close path (`:310`) now copies stdoutTail too.
2. Throw travels `renderTitles` → `brandScriptExecutor` → `renderer.js`
   `processAd` catch.
3. **The hole:** `renderer.js` processAd `$set` copied `message`/`stage`/`code`/`at`
   and never the tails. `titlingResumeService` terminal persist and the OOM
   stamp had the same hole.
4. Schema then dropped the keys even if they had been copied.

Backend has no remotion child supervisor (in-process Remotion). The schema
declaration still has to land here: both services write the same production
database, and `verifyModelParity` is subset (adgen ⊆ backend) at top-level —
nested fields are the same silent-drop class. Titling persist in
`routes/ads.js` and `titlingResumeService` now copy-if-present so a later
port of the child supervisor does not re-open the hole.

## Size cap

Supervisor line-slices, but a single line can be a dumped prompt. Persist-side
clip in `services/renderErrorFields.js`: **8 KiB stderr keep-start / 2 KiB
stdout keep-end**. Direction is not symmetric: the child writes `err.stack`
first (throw, then frames), so clipping stderr from the end would drop
`Error: …` on an over-budget stack; stdout's last line is the JSON report.
NULs stripped — Mongo BSON rejects them, and these tails ride the same `$set`
as `status:'failed'`. ~0.06% of Mongo's 16 MB document limit. No schema
`maxlength` — mongoose validates rather than clips, and `updateOne` `$set`
does not run validators by default.

## Undeclared-key audit (written onto Ad.renderError vs schema)

Declared after this change: `message, stage, at, predictionId, charged,
chargeState, atlasCode, code, stderrTail, stdoutTail`.

Written: those, minus nothing new undeclared.

Reported, not fixed:
- `renderService.failed()` puts `chargeState` / `retryable` / `visionQc` on
  `result.error`. `routes/ads.js` copies `chargeState` onto Ad.renderError
  only later (imageRecoveryService). The ads.js failure persist still omits
  `chargeState` even though it is declared. Pre-existing; not this bug.
- Remotion error extras `kind` / `oomKilled` / `timedOut` / `childCode` /
  `childSignal` stay on the Error object and are not persisted. Intentional.

## Proof

`scripts/verifyRenderErrorTails.js` — Ad-doc assignment + toObject/JSON
round-trip; in-process revert (stripped schema drops the same payload);
`makeChildError` → persist shape → schema set (adgen); write-site pins.
