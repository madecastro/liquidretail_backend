# Vision QC read as "off" on most real renders despite being genuinely ON — PR #276

Branch `fix/vision-qc-cache-race`, PR
[liquidretail_backend#276](https://github.com/Emami-RS-Project/liquidretail_backend/pull/276).
Open, not merged — owner reviews and merges (do not self-merge).

## The report that started this

Owner turned `SystemConfig.adVisionQcEnabled` on and confirmed the write by read-back —
it never reverted. A real run still measured **11 of 18** delivered statics stamped
`visionQc.disabled:true` with the flag genuinely on, and all **14** delivered videos had
**no** `visionQc` field at all.

## Root cause #1: the sync gate races its own cache refresh

`adVisionQcService.isEnabled()` fires `systemConfigService.refreshAdVisionQcEnabledCache()`
— fire-and-forget — and then immediately peeks the cache, in the same synchronous tick.
That refresh can never have landed by the time the peek runs. Pre-fix,
`peekAdVisionQcEnabled()` treated "past its 5s TTL" the same as "never loaded" and
returned `undefined`, so the caller fell through to `envEnabled()`. Real renders are
spaced further apart than 5s, so in production this was not an edge case — it was the
NORMAL shape of every call, which is exactly the measured 11/18.

Reproduced offline (see PR body / `scripts/verifyQcGateWiring.js` section K, no real
sleeps — `Date.now()` is mocked forward instead):
```
RESOLVE_ENABLED_ASYNC              true    (awaits the DB read — this path was ALWAYS correct)
IS_ENABLED_SYNC_CALL_1              true    (cache still warm)
IS_ENABLED_SYNC_CALL_2 (+8s gap)   false   (>5s TTL elapsed -> falls back to env, WRONG)
IS_ENABLED_SYNC_CALL_3 (+200ms)     true    (call 2's refresh had landed by now)
```

## Fix #1: stop using the racy sync path on the hot path at all

All three production callers — `directImageRenderService` (`finishPlate`),
`brandScriptExecutor.runVideoVisionQcForAd`, `imageRecoveryService.maybeQcRecoveredPlate`
— are already `async` functions that already `await` a billable vision call a few lines
later. There was never a reason for them to take the synchronous, cache-racy path; they
now `await adVisionQc.resolveEnabled()`, the pre-existing async resolver, which was never
racy (it either serves a fresh cache or awaits a real Mongo read — no in-between "peek
before the refresh lands" state exists on that path).

**Defense in depth, not just relocating the bug**: `systemConfigService.peekAdVisionQcEnabled()`
itself no longer treats "past its TTL" as "unknown". A value loaded at least once in this
process is now served (possibly a few seconds stale) while `refreshAdVisionQcEnabledCache()`
catches up in the background, instead of silently collapsing to the env default. A
genuinely cold cache (nothing ever loaded — process boot) is unchanged and still falls
through to env, matching the pre-existing "unconfigured -> off" contract; that case is
real absence of data, not staleness. `isEnabled()` itself is kept (still exported, still
tested — `verifyQcGateWiring.js` I1/I2) as a documented legacy sync fallback, now safe
against this specific class of bug if anything ever needs to call it directly again.

**Fail-safe direction, decided deliberately and documented in the code**: serve the
last-known real value across staleness rather than falling back to env. QC exists to
catch a documented ~1-in-3 competitor-logo / product-fidelity defect rate (`CLAUDE.md`
§"Known open"), and an operator who just flipped the switch on is trusting it to take
effect; a stale-cache-driven silent OFF defeats that. The occasional extra ~$0.05/ad QC
cost the other direction risks (continuing to run a check a few seconds after a
hypothetical flip-off) is bounded and small by comparison.

## Root cause #2 (separate defect, also reported): video ships with no visionQc AT ALL

PR #260 (2026-08-19) made the three callers build a real `{skipped:true, disabled:true}`
stub instead of a bare `return null`/`return firstOutput` when the gate is off — but
that only helps a caller that actually REACHES `runVideoVisionQcForAd`. Traced (Grok CLI
fan-out across the call graph, corroborated by manual source reading) several real paths
that ship a video ad fully delivered (`status:'draft'`, real `renderUrl`) WITHOUT ever
calling `renderBrandScriptAndSave` — and therefore without ever reaching vision QC at
all, disabled-stub or otherwise:

- `routes/ads.js` master veo mint (~line 2946) and derive-only mint (~line 2546): both
  gate titling on `if (brandDoc)` — a source Media whose `brandId` doesn't resolve to a
  live Brand skips titling AND QC entirely, ships `draft` anyway (the file itself already
  documented this as intentional-success for titling; QC was just never added to the same
  branch).
- `services/adRegenerateService.js`'s video regenerate path: identical no-brand skip, PLUS
  a second gap — a `renderBrandScriptAndSave` throw (chrome/titling failure) is caught and
  treated non-fatally, but the ad's `renderUrl` was already re-stamped to the new raw
  regenerated master before the try, so a titling failure there also shipped a brand new,
  completely uninspected render with the OLD verdict (or nothing) still on `Ad.visionQc`.
- `services/titlingResumeService.js`'s give-up-on-brand branch (`BRAND_GIVEUP_MIN`): ships
  the untitled master as `draft` and explicitly says it "mirrors routes/ads.js no-brand
  behaviour" — including, pre-fix, mirroring the missing QC call.

Also fixed a THIRD, narrower gap in the one function all of the above eventually call:
`runVideoVisionQcForAd`'s own outer `catch` used to `return null` on an internal infra
error (a throw building the frame URLs, a Brand/CatalogProduct lookup, the vision call
itself), leaving `Ad.visionQc` untouched — indistinguishable from "not yet processed" or,
worse, from "clean". It now builds a real
`{skipped:true, reason:'vision QC (video) infra error: ...'}` stub via the same
`buildSkippedVerdict` PR #260 introduced for the disabled case, instead of shipping
silently unstamped.

## Fix #2

Added one shared helper, `brandScriptExecutor.qcAndStampVideoAd({ ad, deliveredUrl,
brandName })` — calls `runVideoVisionQcForAd` and `$set`s the result onto `Ad.visionQc`,
matching the pattern the file's own pre-existing "no chrome configured" branch already
used inline. Defined once, exported, imported at all five call sites (the file's own
no-chrome branch was refactored to use it too) — same "one definition, imported"
convention this repo already uses for `resolveDeriveFromMaster` / `receiptFree` /
`adArchiveDigest` (`CLAUDE.md` §4), because a duplicated copy at each site is exactly how
this class of gap opens (copy the QC call, forget the `if (videoVisionQc)` write; copy the
write, forget the `brandName` fallback).

Also fixed two now-stale doc comments in `brandScriptExecutor.js` that said the infra-error
catch and the disabled gate both "return null" — neither does anymore, and one of them was
already wrong before this PR (the disabled gate stopped returning null in PR #240).

## Verification

- New behavioural section K in `scripts/verifyQcGateWiring.js` (5 checks) pins the exact
  TTL-elapsed timing case using a mocked `Date.now()` — no real sleeps. **Revert-proven**:
  temporarily restored the old TTL-gated `peekAdVisionQcEnabled()`, confirmed K1/K2/K3 go
  red with the exact wrong (pre-fix) values, restored the fix, confirmed all green again.
- `scripts/verifyAdVisionQcSurfacing.js`: fixed its `withStubbedAdVisionQc` helper (only
  stubbed `isEnabled`, not `resolveEnabled` — would have hung on a real unstubbed Mongo
  call) and D4 (source-text anchor moved off the now-gone literal
  `if (!adVisionQc.isEnabled())`); added D6, a structural regression guard asserting none
  of the three real callers calls the sync gate anymore.
- `scripts/verifyImageRecovery.js`: same stub gap in its G1/G2 idempotency test (was
  timing out for 10s on a real Mongo call before falling back) — now stubs
  `resolveEnabled` alongside `isEnabled`.
- Full suite: `npm test` → **181/181** passed. `npm run lint` → clean (zero output).
- Read-only against prod throughout — no billable generation triggered anywhere in this
  session. `SystemConfig.adVisionQcEnabled` was not touched; it is exactly as the owner
  left it (`true`).

## What this does NOT do

- Does not touch `SystemConfig.adVisionQcEnabled`'s value.
- Does not widen the "no brand resolved -> ship untitled" behavior itself (that predates
  this PR and is out of scope) — only adds the missing QC visibility call to the branches
  that already take that path.
- Does not address the "Stage 2.5 pre-titling stamp" window (a video briefly reads as
  "delivered without QC" while still queued for Remotion) — that is expected async-titling
  timing, not a defect; it resolves itself within the titling queue's own bounded wait.
