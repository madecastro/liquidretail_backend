## 2026-08-11 — THE DIRECTOR PATH WAS DOWN. PRs #137, #139 MERGED + DEPLOYED

Two *unrelated* failures were arriving in the same Slack alerts and reading as one problem.
Separating them was most of the work; only one was a regression.

### 1. `ReferenceError: preferUgcMediaId is not defined` — a live outage, ours (PR #137)

UGC-ads Phase 3 (`c83be8e9`) added a bare read of `preferUgcMediaId` to the
`buildSeededUniverse` options literal in `runConceptDrivenExpansion`, but never added it to
that function's parameter list and never forwarded it from `expandWizardJob`. The read sits
in an **unconditional** object literal evaluated before any UGC branching, so it threw on
**every** concept-driven expansion — every product, every run, **not just UGC ones**.

**11 crashes, 16:03:56Z → 18:20Z, each producing zero ads.** It logs as
`conceptDriven[...]: failed (preferUgcMediaId is not defined)` — the catch logs
`err.message` only, so **grepping production logs for "ReferenceError" finds nothing**.
Search the identifier, not the error class.

Verified after deploy: 11 → **0**, and the same product that was crashing
(`6a7ad331935d0a8e81903a1a`) now returns `concepts=3 payloads=3 newlyQueued=3`.

### 2. Atlas `generation_failed` at 23.5% — NOT ours, provider-side (PR #139)

`git log` settles it: **no commit landed on `main` in the 24h before the first failure**
(2026-08-10T15:56:10Z); UGC Phase 1 landed ~5h *after* it. 8 failures / 34 submits, 100%
`gemini-omni-flash` at 9:16, plus 3 moderation blocks (correctly never retried).

PR #113's retry gate worked — fired 3 of 3 — but **rescued 0 of 3**, because
`predictionFailed.backoffMs` was `() => 1000` **and was dead code**: the retry site
hardcoded its own `1000 * attempt`. Every retry resubmitted an identical payload to the same
model one second later. Now `maxAttempts: 3` with a 15s → 45s curve, read from the policy.

**Still a mitigation, not a cure.** If the rescue rate stays at zero, the next lever is a
cross-model fallback to `ASPECT_FALLBACK_MODEL` — deliberately not done, since it changes
cost and the visual character of delivered ads. **Check the rescue rate before building
anything else here.**

### `npm run lint` now exists, and it is not a style check

The repo had no ESLint. ~98 harnesses assert over **source text**, which cannot see an
unbound identifier, and `node --check` cannot either — a `ReferenceError` is a runtime
error. `verifyUgcFirstSeeding.js` passed green against the live crash.

One rule is enabled: **`no-undef`**. Turning it on immediately found **two more live
ReferenceErrors** nobody had noticed:

| File | Bug | Live for |
|---|---|---|
| `layoutInputService.js` | `usableProofCommentsOrNone` called at 2 sites, never imported | 12 days |
| `shopifyPublicIngestService.js` | `ajax?.title` read ~90 lines after `let ajax` left scope | 3 weeks |

Optional chaining does **not** protect an undeclared binding. Run `npm run lint` before you
push; it is in the CLAUDE.md pre-push list.

### Traps worth keeping
- **macOS has no `timeout` binary.** A suite loop wrapping each script in `timeout` reports
  all 101 as failed. Cost a full debug cycle.
- **A fresh worktree needs `npm install`** — the committed `node_modules` subset has no
  native `sharp`, so `verifyLogoSilhouette.js` fails there. `NODE_PATH` alone will not fix
  it; Node resolves the local `node_modules` first.
- **`backoffFor(n)` is 0-based and the two call sites disagree.** `atlasImageService` counts
  from 0; `atlasVideoService` counts from 1 and must pass `attempt - 1`.
- **`predictionFailed` is a SHARED policy** — retuning it for video retunes static images
  too. Both gates are intact but they ask *different questions*: video asks "did we pay?"
  (`confirmedCharge`), images ask "was a billable task ever created?" (`mayResubmit`).

---

