# Vision QC IS on in production — and the only red harness was a stale gate stub

2026-08-21. Answers §10 of `session.d/2026-08-21_HANDOFF-account-switch.md`, which asked
whether vision QC is actually enabled in prod and warned that if it is not, PRs #276,
#277 and #282 are "all correct, all merged, and all doing nothing."

**They are not doing nothing. The gate is ON.** But nothing has rendered since the
corrected gate deployed, so it is also completely unvalidated in production.

## 1. Measured production state

Two read-only Render one-off jobs against WEB `srv-d1vuktqli9vc73ft07ng`
(`MONGODB_URI` already in the job env; script base64-encoded per the handoff recipe).

| fact | value |
|---|---|
| `SystemConfig.adVisionQcEnabled` | **`true`**, `updatedAt 2026-08-20T22:33:11.410Z` |
| `adVisionQcService.resolveEnabled()` in prod | **`true`** |
| `process.env.AD_VISION_QC_ENABLED` before dotenv | **UNSET** |
| same, after `config/defaults.env` loads | `false` |
| QC/VISION env keys on WEB (24 vars) / WORKER (15) / env group `evg-d21udjm3jp1c738b17lg` (10) | **zero, all three** |

The flag was flipped ~3 hours BEFORE the handoff was written, so its author never saw it.
`session.d/2026-08-19_HANDOFF-blocked-on-atlas-storage.md`'s claim that the gate "has
never run in production (no SystemConfig doc, no env keys)" is now superseded.

**`SystemConfig` is the only lever that can turn QC ON.** Since dotenv loads
`defaults.env` after the environment and never overrides, and no dashboard/group var
exists, env resolves to the committed `false`. Editing `defaults.env` alone cannot enable
QC; the write has to go to SystemConfig.

## 2. The pre-#276 cache race is confirmed in real delivery data

Not a theory any more. Of the **39 ads created after the flip**, all on pre-#276 code:

- **31 delivered stamped `visionQc.disabled:true, reason:'AD_VISION_QC_ENABLED=false'`
  while the DB flag was genuinely `true`.**
- **5 got real QC** (4 `passed:true`; 4 more `passed:false`, 3 of which are `status:'failed'`).
- Siblings **in the same batch, same millisecond** (22:57:06.93x) split both ways.

That is exactly the 5s-TTL `peekAdVisionQcEnabled` miss documented in
`adVisionQcService.isEnabled`'s own doc comment ("Measured live: 11 of 18 delivered
statics stamped `visionQc.disabled:true` with the flag on"). So #276 fixed a real,
measured production defect.

Timeline: flip **22:33:11Z** → mixed batch **22:56–22:57Z** → #276 (`69142a44`) live
**00:23:09Z Aug 21** → current deploy `5cfc0fd9` live **01:22:46Z**.

## 3. ⚠️ The corrected gate has never run a render

`ads created since #276 deployed = 0`. `ads created since the current deploy = 0`. The
newest ad in the database is `2026-08-20T22:57:06.938Z` — i.e. every QC observation we
have was produced by the buggy pre-#276 path.

**A fresh end-to-end run is therefore the first thing worth doing**, and it is the only
way to validate #276/#277/#282 at all. `active_run_count` was 0 at the time of writing,
so nothing was in flight.

## 4. The only red in the suite: a stale gate stub in G2

`scripts/verifyVideoQcFrameSampling.js` check **G2** failed on clean `origin/main`
(reproduced: **1 FAILED, 37 passed**). Root cause was a stub that had gone stale, not a
product defect:

G2 stubbed `adVisionQc.isEnabled = () => true`. But on 2026-08-20 all three hot-path
callers (`directImageRenderService` ~:2591, `brandScriptExecutor.runVideoVisionQcForAd`
~:1680, `imageRecoveryService` ~:348) migrated to `await adVisionQc.resolveEnabled()`.
The real `resolveEnabled` therefore stayed in the path and caused **both** symptoms:

1. it attempted a live `systemconfigs.findOne()` — so this harness **was not offline**
   and paid a 10s Mongoose buffering timeout on every run; then
2. it fell through to `envEnabled()` = `false`, so the gate short-circuited and
   `runVideoPostRenderQc` was never called — `capturedFrames` stayed `null`.

**Fix:** stub `resolveEnabled` too (saved/restored in the same `finally`); `isEnabled`
stays stubbed so the check does not depend on which gate the caller reads.

**Verified, in the right order:**
- before the fix: 1 FAILED / 37 passed; after: **38/38**, and the
  `SystemConfig read failed` + `AD_VISION_QC_ENABLED is OFF` warnings are both gone
  (proving the Mongo reach is eliminated, not merely tolerated).
- **revert-proven behaviourally, not by reading assertions**: mutating the real
  production wiring at `brandScriptExecutor.js:1750` back to the old bare quartile call
  (`buildFrameUrls(deliveredUrl, durationSec)`) gives **2 FAILED / 36 passed** — G1
  (source-text) and G2 (behavioural) both catch it. Restoring gives 38/38. So opening the
  gate did **not** make G2 vacuous.

## 5. Follow-ups

- The E2E in §3 is the highest-value action and needs an owner spend decision.
- §4.2 (switch role `ad-vision-qc` from `google/gemini-2.5-pro` to `gemini-2.5-flash`,
  measured 10/10 parity at 3.6–4.2× lower cost) stopped being theoretical the moment the
  gate went on — it is now live spend at ~$0.05/ad.
- A suite-wide sweep for the same stale-stub class (a harness stubbing one gate function
  of a pair while its sibling stays live) is in progress; G2 is unlikely to be the only one.
