# RS HANDOFF — 2026-08-21, account switch

**Paste this whole file to the first session on the new account.** It is written for a
cold reader with zero context. Everything below was established by measurement or by
reading code, not by inference, unless a line says otherwise.

The previous orchestrator (this file's author) ran ~14 hours as traffic cop over 4-8
concurrent sessions, merged 24 PRs, and ran out of tokens. **You take over
orchestration.** Nick is the owner/reviewer; he reports bugs, you triage them.

---

## 0. READ ORDER — 10 minutes, do not skip

1. `liquidretail_backend/CLAUDE.md` — the pipeline bible. §00 (the catalog pipeline),
   §2 (money invariants), §4 (repo traps). It is long and it is all load-bearing.
2. `liquidretail_backend/session.md` — running state.
3. `liquidretail_backend/session.d/*.md` — per-session handoff notes, several written
   in the final minutes of the last session (filenames dated `2026-08-20_*`).
4. This file.

---

## 1. WHERE THINGS STAND RIGHT NOW

| | |
|---|---|
| Backend trunk | `main` @ **`db85ac08`** (repo `liquidretail_backend`) |
| Frontend trunk | **`master`** @ **`199339d`** (repo `Emami-RS-Project/liquidretail`) — `main` is VESTIGIAL, ignore it |
| Backend deploy | Render WEB `srv-d1vuktqli9vc73ft07ng` (plan `pro_plus`), WORKER `srv-d8128c1o3t8c73e8kb30` (`pro`). Auto-deploys `main`. |
| Frontend deploy | Netlify, auto-deploys `master`, fast (~2 min) |
| Open PRs | **BE #210, #212 only** (RPD harness — *deferred by the owner, leave them alone*) |
| Everything else | merged and deployed |

### Merged in the final session (24 PRs)

**Backend:** #268 static grid downscale · #269 eslint `.mjs`/`.cjs` fix · #270 grid
preview URLs in `ad.list` · #271 mediaAssignmentService tenancy · #272 CampaignRun
terminal reconcile · #273 `funnelStage` + `productUrl` on ads-detail/list · #274
VEO 24 / Remotion 8 + derive-wait no longer abandons · #275 Meta video prompt revert
· #276 vision-QC gate live-flip race · #277 dense early-weighted frame pre-filter ·
#278 delivered-means-titled · #279/#280 SIGTERM counter reconcile · #281 session docs
· #282 QC-failed delivers as failed + reason · #283 concurrency docs refresh

**Frontend:** #64 grid tile downscale · #65 legacy-gallery do-not-develop banner ·
#66 retailer link + intent profile + media type on `AdDetailModal` · #67 status pill
shows real render stage · #68 Failed status + QC reason

---

## 2. STANDING OWNER DIRECTIVES — these are rules, not preferences

Each is quoted or closely paraphrased from Nick during the last session.

1. **"You are in charge of merges and deploys."** Sessions open PRs; **you** merge
   them. Never let a session self-merge — #246 was self-merged without review and
   shipped five confirmed defects into the test tooling.
2. **"I will keep giving you errors I find, I expect you to triage those, not drop
   everything."** A new bug report goes into the queue with a priority. Do not abandon
   in-flight work to chase it.
3. **"Delegate to Grok and then subagents."** See §6. Do not grind serially.
4. **Model discipline** — *"sonnet at ultracode unless you have a good reason."*
   **Pass `model` explicitly on every single `Agent` call and every `agent()` inside a
   Workflow.** Omitting it inherits the main-loop model; that is exactly how an earlier
   session burned 1.25M Opus tokens on work that was fundamentally file tracing.
5. **"Anytime Grok isn't working you need to let me know."** Do not silently fall back.
6. **Forward-only** — *"I am not interested in saving any past ads, we are only looking
   forward."* Scoped to **stranded ads**. It was explicitly NOT extended to live
   advertising claims (§4.1).
7. **Ignore the legacy gallery** — `frontend/app/src/pages/Ads/index.tsx`. *"We aren't
   using it."* It carries a do-not-develop banner (FE #65).
8. **Always run a session shepherd** (§7).
9. **"Any time an ad is shown I want all the info I requested showing"** — intent
   profile, media type, surface details. Retailer URL is not needed in the gallery but
   must be there once you click into the ad. Delivered in FE #66.
10. **Status pill must say exactly what's happening**, and finished ads say
    **"Ready for Review"**. Delivered in FE #67.

---

## 3. THE TRAPS THAT COST THE MOST TIME — read before touching anything

- **`/product-ads` is the primary surface, NOT `/ads`.** `AdThumbnail` and
  `AdDetailModal` live in `frontend/app/src/pages/ProductAds/index.tsx` and are imported
  by six surfaces (`UgcAds`, `CampaignDetail`, `Campaigns`, `agent/ResourceCard`,
  `GenerationInspectorModal`). **Three separate features were built correctly into
  `Ads/index.tsx` and were invisible to the owner**, each costing a round-trip. Fix it
  in `ProductAds` and six surfaces get it.
- **`draft` + non-empty `renderUrl` IS the delivered state.** Measuring on
  `status:'done'` returns zero and reads as total failure.
- **Projection allowlist.** `routes/catalog.js`'s `ads-detail` has an explicit
  `.project({...})`. A field not named there arrives `undefined` no matter what the
  document holds. **This bit the codebase four times in one night.**
- **`tsc --noEmit` and `npm run build` prove almost nothing.** `apiJson<T>`
  (`frontend/app/src/auth/apiFetch.ts:114-126`) is an unchecked cast after
  `JSON.parse`, so the API surface is untyped at runtime. **Verify in the browser.**
- **A regex over source text cannot see an unbound identifier**, and `node --check`
  can't either. A harness that asserts a call site uses a helper must also assert the
  file *imports* it. This shipped a broken money guard to production three times.
- **`scratchpad/render2/out/` holds VUORI clips**, not Marine Layer. Two agents and the
  orchestrator all analysed the wrong videos from there. Check the on-screen copy
  matches the brand you think you're looking at.
- **Never strip conflict markers mechanically from a `.js` file.** It silently
  destroyed a commit. Resolve by hand and `node --check`.
- **`node_modules` is tracked but incomplete.** A fresh worktree needs
  `npm install --no-save https-proxy-agent@5.0.1 jsonwebtoken` or several verify
  scripts false-fail on a missing module.
- **macOS has no `timeout` binary.** A loop wrapping each script in `timeout` reports
  every script as failed.
- **The shared checkout is permanently dirty** with other sessions' live edits. Branch
  off `origin/main` in a **worktree**; never `checkout`/`stash` in the shared tree.
  Before committing from it, always `git diff --numstat origin/main` — a dirty tree is
  usually a stale replay, and committing it reverts landed fixes.

---

## 4. OPEN DECISIONS — Nick's call, not yours

### 4.1 595 delivered ads carry unsubstantiated advertising claims ⚠️ highest stakes
Across 17 brands: "Best seller" ×368, "Top rated" ×415, plus "Sustainably made",
"B Corp Certified", "Carbon Neutral". **496 have `rating: null`** — no supporting data
at all. Root cause: `buildDerivationPrompt` listed them as valid examples with no
evidence condition. **PR #266 (merged) stops new ones**; the delivered set is untouched.
The "forward-only" rule was decided about *stranded ads*, not about live advertising
claims — **do not assume it transfers.** This is a legal-exposure question, not an
engineering one.

### 4.2 Switch the vision-QC model to `gemini-2.5-flash`
Currently `atlasModelMap` role `ad-vision-qc` → `google/gemini-2.5-pro`. Measured
head-to-head: **flash matches pro 10/10 at 3.6–4.2× lower cost.** Awaiting go-ahead.
**Cropping the images first is a dead end** — Gemini charges a flat 516 tokens per
image pair regardless of size, and output tokens are 80–95% of the bill.

### 4.3 Move Remotion out of the web process
Remotion renders headless Chrome + ffmpeg at 1080p **inside the web process**. Real
OOM kills recur every 20–45 min. Recovery *does* work (`bootRecoveryService` /
`titlingResumeService`, 5–20 min latency), so this is churn and latency, not permanent
loss. The structural fix is a separate service. Costed decision, not started.

### 4.4 Credential rotation — NOT DONE
An agent pulled `MONGODB_URI` and `JWT_SECRET` from prod to a local `.env` to verify
against real data, minted a JWT for Nick's account, then deleted the file.
**Neither secret has been rotated.** Disclosed by the agent itself.

### 4.5 `MAX_CREATIVES_PER_RUN`
Currently **1000** (PR #208) — note several older docs still say 20; they are stale.

---

## 5. KNOWN-OPEN ENGINEERING (diagnosed, not fixed)

- **Meta API version is pinned nowhere.** No layer sets `META_API_VERSION`, so 12 sites
  run the hardcoded `v19.0`, which **expired 2026-05-21**. Do not bump it blind.
- **Catalog null images are staleness.** No scheduled re-sync exists. Variant/sibling
  image fallbacks recover zero rows; `isPrimaryVariant:false` is an *effect* of the null
  image, not the cause.
- **The generic scraper has no time budget.** No deadline anywhere; `MAX_RUN_MS` stops
  only the heartbeat, so ~83-minute scans hide behind a dead-looking run, and
  **0-product runs still call `succeed()`**.
- **Scrape blocks differ by vendor.** The client detects Cloudflare only, so Akamai 403s
  (fanatics) get misreported as parse failures. ubeauty is CF, and headless is off in
  prod.
- **Apify bills per result, not per run.** The IG scraper is PAY_PER_EVENT per result;
  the repo's $0.02/post understates BRONZE by ~5.75×, the preview is limit-blind, and no
  sort input exists (newest-only; free caps at 15).
- **Video refs take feed order unfiltered.** A merchant's mis-filed colourway photo
  becomes "ABSOLUTE source of truth" for a billable video gen. `primarySubjectDesc`
  already holds the signal needed to catch it.
- **YOLO microservice instability** — `/detect` failures are latency against a 120s
  client timeout (p50 71s; tiles scale with image size), **not OOM**. Retries can
  double-bill an inline `gpt-4o-mini` call.
- **`AGENT_DISABLED` / RPD** — #210/#212 deferred by the owner.

---

## 6. TOOLING — exact recipes

### Grok (the delegation workhorse — try this BEFORE spawning any agent)
```
~/.grok/bin/grok -m grok-4.6 --effort <low|medium|high|xhigh> \
  --sandbox read-only --always-approve --cwd <repo> --prompt-file <file>
```
- **`--prompt-file` goes WITHOUT `-p`.** Always pass `-m grok-4.6` explicitly; the
  `[models] default` key in `~/.grok/config.toml` does NOT take effect.
- `xhigh` for money/security review only. `medium` for routine tracing.
- Headless Grok **can** read files (`-p --always-approve --sandbox read-only` runs read
  tools) — stop inlining diffs for review.
- **The write sandbox is classifier-blocked.** Have Grok draft hunks read-only and apply
  them yourself with Edit. The classifier is non-deterministic; reshape the prompt
  rather than retrying.
- Separate credit pool, capped monthly. On a **403 "used all available credits"**, do
  not retry — **tell Nick** and fall back to subagents. Check spend with
  `python3 ~/.grok-relay/usage-report.py`.
- **Always diff after a Grok write run.** Its self-report is not evidence.

### Test gate (backend)
```
cd <worktree> && npm install --no-save https-proxy-agent@5.0.1 jsonwebtoken
for s in scripts/verify*.js scripts/verify*.mjs; do node "$s" >/dev/null 2>&1 || echo "FAIL $s"; done
npx eslint .
```
~181 verify scripts. **`npm run lint` is not a style check** — it enables exactly one
rule, `no-undef`, because that is the one thing every source-text harness is blind to.

### Prod queries
`render ssh` cannot be scripted. Use one-off jobs:
```
render jobs create srv-d1vuktqli9vc73ft07ng --start-command "node -e \"eval(Buffer.from('<B64>','base64').toString())\"" --confirm
```
**Base64-encode the script** — raw shell quoting gets mangled and has burned several
jobs. `MONGODB_URI` is already in the job env. Logs: `render logs -r job-<id>`.
The Render API key lives in the CLI's `cli.yaml`, not the standalone key file (that one
returns Unauthorized); use the workspace id as `ownerId` for `/v1/logs`.

### Harness discipline
- **Revert-prove every harness.** Back the fix out and confirm the test goes red. A test
  that cannot fail is not a test.
- **Prove the test exercised the path.** Green only means the assertions that ran
  passed — confirm the branch was reached and the mutation applied.
- **Prove reverts behaviourally.** A source-text harness passes against a
  reimplementation that merely keeps the name. Call the code.
- Bound a source-scan slice at the next **syntactic boundary**, never a magic character
  count that drifts stale.

---

## 7. HOW TO RUN THE ROOM

**Spawn a session shepherd early and keep it running** (standing directive). Sonnet
subagent, not the main loop. Its job, cycling every ~20–30 min:
- List peer sessions. Stopped with no PR → message it to drive to a PR or state its
  blocker. Stopped with an open PR → check `mergeable`/`mergeStateStatus`, tell it to
  rebase if CONFLICTING. Running but idle >45 min → nudge.
- Archive sessions whose work has landed.
- **Hard limits:** it never merges a PR, never approves spend, never does the sessions'
  engineering work. It routes, unblocks, archives. Merging stays with you.

**Things that went wrong last session, so you don't repeat them:**
- **Poll your agents.** Completion notifications are unreliable. Finished work hides as
  uncommitted files in a dead agent's worktree. **Four separate near-losses** of
  finished-but-unpushed work in one night (369 lines, 603 lines, and two more).
- **Agents idle-stop** — "waiting for a notification" with no live children. One burned
  523k tokens across four stops. Poll them.
- **Check for active runs before every merge.** Merging six PRs during a live E2E
  caused process replacement mid-run.
- **A crashed session is a rescue; a *denied* one must be surfaced to Nick.** The
  shepherd once pushed a branch and opened a PR because another session's permission
  classifier denied its push. That is permission laundering — don't.
- **Verify peer claims independently.** A peer session's specific offset/count claim can
  come from stale state. Re-measure before complying.
- **GitHub PR head refs lag** — `refs/pull/N/head` can be 35s+ behind
  `refs/heads/<branch>` after a push. Fetch by branch name when reviewing a just-pushed
  PR.
- **Squash-merge + stacked branches:** rebasing onto a just-squash-merged sibling PR can
  leave a noisy no-op commit. Diff-check the replay before pushing.

---

## 8. WHAT THE LAST E2E ACTUALLY SHOWED

Honest verdict: **16 of 39 (41%) usable**, against 29/39 as originally reported.
13 videos shipped as raw untitled masters. Several of tonight's PRs (#277, #278, #282)
target exactly that gap. **A fresh end-to-end run is the first thing worth doing** now
that all 24 PRs are deployed — nothing since has been validated end to end.

Page-load was separately fixed and measured: **26.37 MB → 0.52 MB (98%)** across 11
real Pelagic statics. Root cause was that `videoPreviewUrl` existed but had no image
equivalent, and `previewVideoUrl` had **zero references** in `ProductAds`, so the
primary surface was pulling full 1080p masters.

---

## 9. FIRST THINGS TO DO ON THE NEW ACCOUNT

1. Read §0's four files.
2. Confirm the Render deploy of `db85ac08` went green.
3. Spawn the session shepherd (Sonnet).
4. **Run a fresh end-to-end** and grade it honestly — count delivered = `draft` +
   non-empty `renderUrl`, and check the videos are *titled*, not raw masters.
5. Put §4.1 (the 595 ads with unsubstantiated claims) in front of Nick. It's the only
   open item with outside-the-building exposure.

---

## 10. ⚠️ VERIFY THIS FIRST — is vision QC actually ON in production?

`scripts/verifyVideoQcFrameSampling.js` **G2 fails on plain `main`** (confirmed by
running it against a clean `origin/main` worktree, not inferred). Its diagnostic output
says:

```
adVisionQc: AD_VISION_QC_ENABLED is OFF (env unset and no SystemConfig.adVisionQcEnabled
override) — every delivered video ad is shipping WITHOUT vision inspection
```

Locally that only reflects a local env with no DB, so **it is not proof about
production** — but it raises the question that matters most:

**Nick's whole reason for tonight's QC work was "several videos have had badly
hallucinated product logos/distortion that made it to delivery." If the gate is off in
prod, then #276, #277 and #282 are all correct, all merged, and all doing nothing.**

**First action on the new account:** query prod for the real state, via a Render one-off
job (`MONGODB_URI` is already in the job env, base64-encode the script):
- `process.env.AD_VISION_QC_ENABLED` on WEB `srv-d1vuktqli9vc73ft07ng`
- `db.systemconfigs.findOne({})` → `adVisionQcEnabled`

Historical note from `session.d/2026-08-19_HANDOFF-blocked-on-atlas-storage.md`: the
gate *"has never run in production (no SystemConfig doc, no env keys)"* and enabling it
needs a SystemConfig **write**, which was blocked while Atlas was out of storage. **Atlas
storage has since been fixed** (a colleague resolved it; 512/512 MB → 14 MB), so the
write is no longer blocked. Nobody has confirmed the flip actually happened.

Cost if it is turned on: ~$0.05/ad, centrally cost-logged via
`atlasLlmService.chatCompletion` (no untracked spend). See §4.2 — switching the model to
`gemini-2.5-flash` cuts that 3.6–4.2× with measured 10/10 parity.

### Also red on `main`
`verifyVideoQcFrameSampling.js` G2 — *"runVideoPostRenderQc must have been called with a
frames array"*. Introduced by #277. The harness drives real control flow with mocked
deps, but the QC gate short-circuits when disabled, so the call never happens. It also
tries a real `systemconfigs.findOne()` and times out after 10s, so **this harness is not
actually offline** — that is a test defect worth fixing, and it is currently the only
red in a 183-script suite.

---

## 11. IN-FLIGHT SESSION STATE at handoff (2026-08-21 ~01:00Z)

All four peer sessions were told to checkpoint and all four reported. Their notes are in
`liquidretail_backend/session.d/2026-08-20_*.md` unless stated otherwise.

| Session | Work | State |
|---|---|---|
| rs-09 | concurrency docs refresh | **DONE** — PR #283 merged. Note pushed. |
| rs-97 | `seedsFromMedia` brand tenancy | **DONE** — PR #284 merged (`c5a378f1`). Note pushed. |
| subagent | QC-failed delivers as failed + reason | **DONE** — BE #282 + FE #68 merged, follow-up #285 merged. Note pushed. |
| rs-24 | `adList` grid preview URLs | ⚠️ **NEEDS WORK** — see below |
| rs-32 | titling claim staleness | ⚠️ **UNPUSHED, RESCUED** — see below |

### rs-24 — PR #270 merged into the WRONG BASE
`feat/adlist-grid-preview-urls` was merged into base `feat/image-grid-preview-url`, not
`main`. #268's branch was then squash-merged into `main`, **orphaning #270's commit** —
so that work is *not* on `main` despite showing as merged.

Gate was 179/180 in-worktree, new harness 11/11 with 10/10 mutations caught, eslint
clean. **Next action:** open a fresh PR against real `main`. `git merge-tree` confirms
exactly **one real conflict**, in `services/capabilityExecutors/adList.js` — PR #273
touched the same object literal. Hand-merge that one file; do not resolve mechanically.
Full repro steps in `session.d/2026-08-20_adlist-grid-preview-urls.md`.

### rs-32 — finished, tested, and deliberately NOT pushed
Branch `fix/titling-claim-staleness`, based on `origin/main` at `c27df039` (includes
#278/#279). **182/182 green, eslint clean on 6 touched files, 3 harnesses revert-proven
against 7 mutations (all caught).** Code-complete.

It has not been pushed because that session's own rule is *"never commit without the
user's explicit ask"*, and a peer message doesn't satisfy it. **That is the correct
call** — do not push it for them; that is permission laundering. **Nick needs to say go.**

**The fix:** titling-resume's stale-claim reclaim (already working, 15 min) had **no
attempt bound** — an ad could cycle claim → abandon → reclaim forever, invisible to
`backlogWatchdog`'s idle-based alert because each reclaim refreshes `updatedAt`. Adds a
declared `titlingResumeAttempts` counter, a bounded filter, an honest terminal verdict
(master kept, never re-billed), and a second watchdog arm keyed on attempt count.

✅ **IT IS NOW ON GITHUB.** It originally lived only in `/private/tmp/...`, which macOS
clears on reboot. It has been pushed, unmerged, to a clearly-labelled preservation
branch so it survives this machine:

```
git fetch origin && git checkout wip/titling-claim-staleness-PRESERVED
```

Branch `wip/titling-claim-staleness-PRESERVED` @ `dbafdd80`, based on `c27df039`.
1,569 insertions across 9 files, including
`session.d/2026-08-20_titling-claim-staleness.md` with the full write-up.

**It is UNREVIEWED and must not be merged as-is.** The gate numbers above are the
authoring session's own report and were **not** independently re-verified before the
preservation push. Re-run the suite yourself, then open a real PR — after Nick approves.

### Housekeeping: ~47 local branches have commits that exist on NO remote
Mostly spent/superseded experiments, but nobody has audited them. They are invisible to
`gh pr list` and will be lost with the machine. Worth one cheap Haiku sweep to classify
before any cleanup. **Do not bulk-delete them.**

Also: the shared checkout `/Volumes/Sayulita/Projects/RS/liquidretail_backend` currently
carries **77 dirty files** on `main`. Two independent sessions flagged this as stale
replay drift, not real unmerged work. **Verify with `git diff --numstat origin/main`
before committing anything from it** — committing that tree reverts landed fixes.


---

## 12. REACHABILITY — everything is in git, nothing is stranded on the old machine

The new account may be on different hardware, so every artifact below is reachable with
nothing but repo access. **No local path is load-bearing any more.**

| What | Where | 
|---|---|
| This handoff | `session.d/2026-08-21_HANDOFF-account-switch.md` on `main` |
| 92 session notes, incl. all of tonight's | `session.d/*.md` on `main` |
| rs-32's unpushed work | branch `wip/titling-claim-staleness-PRESERVED` |
| rs-24's write-up | `session.d/2026-08-20_adlist-grid-preview-urls.md` on `main` |
| The pipeline bible | `CLAUDE.md` on `main` |
| Everything else merged today | `main` @ `4d4461ed` or later |

Two repos: `Emami-RS-Project/liquidretail_backend` (trunk `main`) and
`Emami-RS-Project/liquidretail` (trunk **`master`**).

**Only these are machine-local, and none is required:** the `.rescue/` folder (now
redundant — its contents are on the preservation branch), the `/private/tmp/...`
worktrees (disposable), and ~47 stale local branches that exist on no remote (§11
housekeeping — unaudited, mostly spent experiments, but genuinely lost with the machine).

**Credentials the new machine needs:** GitHub (`gh auth`), the Render CLI, the Atlas
Cloud key, and `~/.grok/bin/grok` if Grok is to be used. None of those travel with the
Claude account — they are machine setup. If Grok is missing on the new box, say so
(standing directive) and fall back to subagents rather than stalling.
