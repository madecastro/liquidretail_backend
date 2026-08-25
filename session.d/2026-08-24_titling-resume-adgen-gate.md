# Titling-resume sweep stands down when adgen owns rendering (2026-08-24)

## The race

`liquidretail_backend` and `liquidretail_adgen` render against the same MongoDB.
`ADGEN_RENDERER_ENABLED` is the cutover switch. adgen already honours it: its
renderer `poll()` returns before `claimOne()` unless
`isAdgenRendererEnabled()` is true (`liquidretail_adgen/src/services/renderer.js`).

This repo's titling-resume sweeper (`services/titlingResumeService.js`,
started from `index.js` on a delayed then repeating interval) did not. When
adgen is the designated renderer, the backend web process still swept for
video ads whose titling never completed and re-ran Remotion against the same
rows.

That is more than untidy. adgen has a bounded titling retry; this sweeper has
none. If this process wins the claim, a deterministically-failing ad is
retried forever, in a process not sized for the memory-heavy titling work.

## The change

`resumeUntitledMasters` consults `adgenBridge.isAdgenRendererEnabled()` at
the top of the function, after the existing `TITLING_RESUME_ENABLED` kill
switch and before `Ad.find`. The helper re-reads `process.env` on every
call, so a Render-dashboard flip takes effect without a redeploy.

The interval in `index.js` is deliberately left running. Gating
`setInterval` itself would freeze the decision at boot. An in-flight pass
that has already passed the check is allowed to finish; only a new pass is
skipped.

## Fail-safe direction

**This repo keeps sweeping unless the helper is true.**

adgen only claims when the flag lowercases to the string `'true'` (same
helper). Missing, `'false'` (the committed `config/defaults.env` default),
or malformed values make the helper false, so adgen will not claim. Standing
this sweeper down on those values would leave **neither** service picking up
paid untitled masters.

The unsafe direction is the seductive one: `if (process.env.ADGEN_RENDERER_ENABLED)`
is truthy for the committed default `'false'` and would disable this sweep
on every boot that loads `defaults.env` while adgen is also sleeping.

Pinned by `scripts/verifyTitlingResumeAdgenGate.js` (structural A1–A5 +
behavioural B1–B5 / C1). Mutation-proven: dropping the
`if (isAdgenRendererEnabled()) return out;` line turns B1 red.

No database writes, no generations, no spend.
