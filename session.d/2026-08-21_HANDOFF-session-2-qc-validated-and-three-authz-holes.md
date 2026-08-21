# RS HANDOFF — 2026-08-21, session 2 (restart)

Successor to `session.d/2026-08-21_HANDOFF-account-switch.md`. **That file is still the
best cold-start orientation — read it first.** This file records only what CHANGED, what
is IN FLIGHT, and where the corrections to it are. Everything below was established by
measurement or by reading code, not inference, unless a line says otherwise.

Session ended on the owner's request to restart, mid-flight, with several agents running.
§4 is the part that will be lost if you skip it.

---

## 0. READ ORDER

1. `session.d/2026-08-21_HANDOFF-account-switch.md` — the master handoff. Still accurate
   except where §2 and §7 below correct it.
2. This file, especially **§4 (in-flight work)** and **§5 (live findings)**.
3. `CLAUDE.md` — the pipeline bible, unchanged.

---

## 1. WHERE THINGS STAND

| | |
|---|---|
| Backend trunk | `main` @ **`a709941f`** (was `5cfc0fd9`) |
| Frontend trunk | **`master`** @ `199339d`, unchanged. `main` is VESTIGIAL |
| Deploy | WEB `srv-d1vuktqli9vc73ft07ng` + WORKER `srv-d8128c1o3t8c73e8kb30`, both **live and green** |
| Verify suite | **184 scripts, ALL GREEN**, `npx eslint .` clean |
| Merged this session | **#288**, **#289** (both test-only) |
| Open PRs | #210, #212 (RPD harness — still deferred by the owner, leave alone) |

### #288 — stale vision-QC gate stub (the only red on `main`)
`verifyVideoQcFrameSampling` G2 failed on clean `origin/main` (1 FAILED / 37 passed). Cause
was a **stale stub, not a product defect**: G2 stubbed `adVisionQcService.isEnabled()`, but
all three hot-path callers moved to `await resolveEnabled()` on 2026-08-20. The real
`resolveEnabled` stayed in the path, hit a live `systemconfigs.findOne()` (10s Mongoose
buffer), fell through to `envEnabled()` = false, the gate short-circuited, and
`runVideoPostRenderQc` was never called. Fixed by stubbing `resolveEnabled` too. 38/38.

### #289 — three harnesses were not actually offline
**#288's claim that it eliminated the Mongo reach was overclaimed** — opening the gate just
moved it into an unstubbed `adStage()` → `Ad.updateOne`. A sweep found two more. All three
had headers falsely promising "No DB, no network":

| harness | real call | before | after |
|---|---|---|---|
| `verifyVideoQcFrameSampling.js` | `adStage()` → `Ad.updateOne` | 10.9s | ~0.2s |
| `verifyAdVisionQc.js` (E2) | `SystemConfig.findOne`, failure swallowed → **silent** 10s hold | 10.95s | ~0.2–1.0s |
| `verifyIngestShotClassify.js` | `Brand.findOneAndUpdate`, `Category.findOneAndUpdate`, materialize-drain | 31.3s | ~4–5s |

~48s/run removed. Check counts unchanged (38/38, 70/70, 204/204) — no assertion weakened.
Two non-obvious details are in the PR body and worth reading before touching those files
(E2 must NOT stub `findOne`'s return value; `categoryClassifier` destructures at load so the
MODEL method is what intercepts).

---

## 2. ⚠️ §10 OF THE PREVIOUS HANDOFF IS ANSWERED — AND ITS FEAR WAS WRONG

It asked whether vision QC is on in prod, warning that if not, #276/#277/#282 were "all
correct, all merged, and all doing nothing."

**QC is ON, and now VALIDATED END TO END.**

- `SystemConfig.adVisionQcEnabled = true`, set `2026-08-20T22:33:11Z` — **~3h before that
  handoff was written**, so its author never saw it. `resolveEnabled()` returns `true` in prod.
- **SystemConfig is the ONLY lever that can turn QC on.** WEB (24 vars), WORKER (15), and env
  group `evg-d21udjm3jp1c738b17lg` (10) contain **zero** QC/VISION keys, and
  `config/defaults.env:1308` commits `AD_VISION_QC_ENABLED=false`. dotenv loads that file
  AFTER the environment without overriding. Editing `defaults.env` alone cannot enable QC.
- **The pre-#276 cache race is confirmed in real delivery data.** Of 39 ads created after the
  flip but before #276 deployed (`69142a44`, live 00:23Z), **31 delivered stamped
  `visionQc.disabled:true, reason:'AD_VISION_QC_ENABLED=false'` while the DB flag was
  genuinely `true`** — with siblings in the same millisecond splitting both ways. #276 fixed a
  real, measured defect.
- **VALIDATED**: a real generation at `02:39:26Z` produced **3/3 real verdicts**
  (`disabled:false, skipped:false, passed:true, attempts:1`), zero disabled/skipped stamps.
  CostLog: 3 × `ad_vision_qc`, provider `atlas`, model `google/gemini-2.5-pro`, **$0.0172–0.0175
  each**, status ok.

**Cost corrections:** QC is **~$0.017/ad**, not the ~$0.05 the previous handoff estimated.
Total validation spend $0.34.

**STILL UNVALIDATED: the VIDEO QC path.** Only statics were proven. See §4.5.

---

## 3. OWNER DECISIONS MADE THIS SESSION

1. **E2E validation approved** at a small budget; then escalated to *"I am not pinching
   pennies I want everything tested, all UI elements, everything."* Treat full coverage as
   the standing goal.
2. **§4.2 flash switch: DO NOT DO IT.** He approved it, then I found `atlasModelMap.js:198-205`
   records a prior session trying flash and reverting because **flash broke the JSON shape**
   (`competitor_marks` as a bare boolean, `findings` hoisted). Grok verified by *running*
   `parseVerdict` (`adVisionQcService.js:380-418`): both shapes fail closed, there is no
   salvage layer, and `response_format:json_object` cannot help (nested types unconstrained).
   **There is NO primary record anywhere in the repo of the "10/10" bake-off.** §4.2's claim
   almost certainly graded detection, which was never the disputed axis.
   → Owner then chose: **harden the parser first, then reconsider flash.**
3. **Privesc fix: queued behind the E2E**, not dropped. Now unblocked.
4. **`isSuperAdmin` should bypass membership** — but this was decided on MY WRONG PREMISE.
   It already does. See §7.1.
5. **Admin settings + user management + QC gate split**: build it, Grok-led, design-with-
   questions-first. Design doc delivered; 11 questions **still unanswered** (§6).

---

## 4. ⚠️ IN FLIGHT — PUSHED PRESERVATION BRANCHES, ALL UNREVIEWED

Every background agent died at the restart. Their work was **uncommitted working-tree state**;
I committed and pushed it as WIP so it survives. **All three are UNREVIEWED, INCOMPLETE, and
must NOT be merged as-is.** Re-run the suite yourself.

| branch | SHA | what it is |
|---|---|---|
| `fix/members-invitations-caller-role-guard` | **`2a256808`** | privesc fix: new `middleware/requireMembershipRole.js` + `scripts/verifyMembersAuthz.js`, edits to `routes/members.js` + `routes/invitations.js` |
| `feat/admin-settings-qc-gates` | **`6f5f6632`** | QC gate split (static/video) in progress + the 1168-line design doc `session.d/2026-08-21_admin-settings-and-qc-gate-split-DESIGN.md` |
| `fix/qc-verdict-parser-tolerance` | **`ef07b6b0`** | `parseVerdict` shape tolerance + harness |

`middleware/requireMembershipRole.js` @ `2a256808` exports:
`module.exports = requireMembershipRole` (factory) plus `.ROLE_RANK`, `.roleRank`,
`.canActOnRole(callerRole,targetRole)`, `.canGrantRole(callerRole,requestedRole)`.
**Import these — do not re-derive rank logic a third time.**

### 4.5 The video test case is NOT a precondition failure — it is an unimplemented stub
`suites/generation.js` `g2-one-video-master` is deliberately not implemented; its comment says
*"the static case must earn trust first."* It now has. A complete drafted implementation is in
`/private/tmp/.../scratchpad/out-grok8.md` — **`/private/tmp` is cleared on reboot, so
re-derive it if lost.** Verified-correct properties of that draft worth reproducing:
- **`ctx.optIn` is NOT a usable gate** — `run.js:432` copies `journey.optIn` onto ctx
  unconditionally, so gating on it would make the case ALWAYS spend. Use a separate flip;
  `UI_SMOKE_VIDEO=1` needs no plumbing. **No `--opt-in` CLI flag exists** (`parseArgs` errors
  on unknown flags), so that plumbing is still missing.
- Quote the FREE `/api/ads/preview` first (returns `billable:{images,videoMasters,freeDerived}`)
  and refuse to submit unless `videoMasters === 1` and `images === 0`.
- **`guard.release()` DOES exist** (`harness/budget.js:337`, requires a reason naming
  structured proof). The stub's "there is no release" comment is **stale**.
- `video_master_submit: 1.20` in the price table over-reserves vs the measured $0.90 settled —
  safe direction, leave it.
- Assert exactly ONE distinct `veoPredictionId` (the money tripwire: dropping
  `deriveFromMaster` turns 3 free crops into 3 × ~$0.90).
- Titled-vs-raw: `inspector.video.finalUrl !== rawVideoUrl`; equality is the untitled-orphan
  signature. Also require `renderStage:'done'` — `draft`+`renderUrl` alone matches a
  mid-titling master.
- **Known surfacing gap:** `generation-inspector` attaches `visionQc` only on the IMAGE block,
  and render-activity serialises a SLIM verdict without categories. So a video ad's full
  verdict may not be on the wire at all. Distinguish "QC didn't run" from "QC ran but isn't
  exposed" with a DB query before calling it a QC failure.

A local backup of the untouched stub file is at
`/private/tmp/.../scratchpad/generation.js.backup` (also disposable).

### 4.6 SHA CORRECTION — two agents kept working after the first preserve
The table above carries the **second** snapshot. Two agents produced more harness work
AFTER the initial preservation commit, so there are two commits per branch:

| branch | first preserve | **use this** |
|---|---|---|
| `feat/admin-settings-qc-gates` | `fa84cd8b` | **`6f5f6632`** (+ `verifyAdVisionQcSurfacing.js`, `verifyVideoQcFrameSampling.js`) |
| `fix/members-invitations-caller-role-guard` | `fee1f7c7` | **`2a256808`** (+ `scripts/verifyMembersAuthz.js`) |
| `fix/qc-verdict-parser-tolerance` | `ef07b6b0` | `ef07b6b0` (unchanged — nothing new) |

A peer session was told `fee1f7c7`; if it branched off that, it is missing the authz
harness in `2a256808`. Tell it to rebase. All three branches are confirmed identical
local vs `origin`.

---

## 5. LIVE FINDINGS NOT YET FIXED

### 5.1 THREE authz holes, and they compound — fix them together
1. **`routes/members.js` / `routes/invitations.js` have no caller-role check.** Mounted behind
   `requireAuth` only, which proves membership, not role. `PATCH /:userId` validates the
   *requested* role then does `target.role = role` (`:87`); only guard is last-owner (`:73`).
   **Any `viewer` can PATCH themselves to `owner`**, then revoke the real owner. Independently
   verified.
2. **The agent path bypasses any HTTP fix entirely.** `services/capabilityExecutors/`
   `teamMemberPatch.js`, `teamMemberDelete.js`, `teamInviteCreate.js`, `teamInviteDelete.js`
   are reachable via `POST /api/agent/chat` (mounted requireAuth-only, `index.js:207`) with
   zero caller-role checks. A viewer can hand-craft `tool_calls` and self-promote. **Reported
   by a peer session; treat the members.js fix as INCOMPLETE without this.** Do not merge one
   and call privesc fixed.
3. **Revoking a super-admin is a no-op.** `requireAuth.js:113-121` runs
   `expandSuperAdminMemberships` before the `NO_ADVERTISER` gate and synthesises
   `role:'owner'` on EVERY advertiser, **not persisted** (so no audit trail). All 3 prod users
   are `isSuperAdmin:true`, so `/team`'s Revoke button currently does nothing to anyone.

**Severity, stated honestly:** all 3 current users are already owner AND super-admin, so there
is no lower-privileged account to escalate *from* today. This goes live the moment the first
editor/viewer is invited — which the planned Users tab makes easy. **The guard must land
before or with any invite feature.**

Related but NOT live: `requireAuth.js:87-111` self-heal. A peer claimed revoke undoes itself;
**refuted** — the revoked row keeps its slot in the partial unique index on
`(advertiserId,userId)` (which filters on `userId:{$type:'objectId'}`, not status), so `create`
throws 11000, the soft-fail catch swallows it, and the request correctly 403s. Latent only if
`User.advertiserId` points at a *different* advertiser with no row.

### 5.2 Four UI defects from ui-smoke, with a VALID session (not artifacts)
Run: `133/143`, 10 fail, 4 skip. Root-cause workflow was still running at restart — findings
were NOT confirmed, so re-verify each.
1. **MONEY: format picker quotes 2 video generations, test expects 3.** CLAUDE.md: the shared
   9:16 master needs FIVE conjuncts and the load-bearing one (`VIDEO_HOOK_FIRST_PROMPT`) ships
   **`false`** since the 2026-08-20 revert → a mixed Meta+PMax run bills **3 masters/$2.70**
   today. If the UI assumes the saving unconditionally it **under-quotes by ~$0.90/product**.
   Determine whether the UI is wrong or the test is stale — that is the deliverable.
2. Wizard **"Next: Generate" stays disabled** after selecting a tile (j3/j4). Harness logged
   the tile as `ACTIVE BRAND`, which smells like a test selector defect — but if real, it
   blocks the whole operator path. Answer "can a human complete the wizard today?"
3. `/campaigns` + `/product-ads` assert while still showing `Loading…` / `Loading brands…`.
   Missing wait, or genuinely slow at 837 products.
4. **Gallery reports empty despite 3 ads delivered minutes earlier** (j6 skip). Highest-
   owner-value: check whether the DEFAULT status filter on `/product-ads` includes
   `status:'draft'` — which IS the delivered state. This codebase has a long history of ads
   being invisible while the pipeline reports success.

### 5.3 A paid video can ship uninspected regardless of any gate
If video **titling** throws, `routes/ads.js:2570-2598` and `:3008-3045` stamp `status:'failed'`
**without ever calling QC**, keeping the paid master. Separate from the gate; not covered by
#276/#277/#282.

---

## 6. PENDING: 11 admin-design questions
`.wt-admin-settings/session.d/2026-08-21_admin-settings-and-qc-gate-split-DESIGN.md` §7 (also
on branch `feat/admin-settings-qc-gates` @ `6f5f6632`). Highest-stakes: **Q2** catalog scope
(curated ~20-40 keys vs all 208 `defaults.env` keys), **Q3** promote-UI blast radius (grants
owner on EVERY workspace, plus an env-allowlist-sticky tradeoff), **Q6** whether to fix the
§5.3 titling-QC hole in the same change. The design confirms the 4-level role model and full
invite lifecycle **already exist** — the job is exposing/enforcing them, not inventing them.

---

## 7. CORRECTIONS + TRAPS THIS SESSION HIT

### 7.1 I was WRONG that a super-admin is locked out
I told the owner his account was locked out of the app and got approval for a production write
on that basis. **`requireAuth` already bypasses** (§5.1 item 3). What actually could not
resolve an advertiser was the offline **test-token minter** (`scripts/mintTestToken.js`), which
does its own membership lookup and does not implement the expansion — a harness gap.
**I wrote one AdvertiserMembership row**: `nick@reach-social.io` → advertiser
`6a8751266fc5354bf05add95` ("Sales Demos"), role `owner`, status `active`, id
`6a87b9e61e93370875c1f20d`. It is harmless and true, but it was **not necessary**; remove it
if the owner prefers. His "isSuperAdmin should bypass" answer was given on my bad premise.

### 7.2 Do NOT redirect a fan-out Grok run's stdout to one file
A `--effort high` Grok call that spawns its own subagents **interleaves their stdout**,
corrupting the report (headings spliced mid-sentence). ~2400 lines were unusable. Either tell
Grok explicitly **"do not spawn subagents, produce ONE final report"**, or run several narrower
calls each with its own output file. Grok's write sandbox is still classifier-blocked.

### 7.3 The classifier blocks pulling secrets from the Render API
Fetching `JWT_SECRET`/`MONGODB_URI` via `curl` to mint a token by hand is **denied** (it looks
like credential exfiltration, correctly). Do not work around it — the harness already solves
this internally (`harness/secret.js`, in-memory only). Drive verification through the harness,
or add a suite case, rather than hand-minting.

### 7.4 Useful prod facts, measured
- Only **ONE brand has products**: **Pelagic Gear** `6a875170b31cf7b2214a46e3`, 837 products
  (826 with images), advertiser `6a8751266fc5354bf05add95` ("Sales Demos").
- **3 users, 2 advertisers, 4 memberships.** All 3 users `role:'owner'` + `isSuperAdmin:true`.
  `User.advertiserId` is null for 2 of 3 and looks vestigial beside the membership join —
  confirm nothing still reads it, two sources of truth for "which advertiser" is a bug waiting.
- ui-smoke needs BOTH `--email` and a resolvable advertiser; `--brand` alone errors with
  "requires a resolved advertiser". `run.js` accepts `--brand`, the minter wants `--brand-id`,
  and `run.js` has **no** `--advertiser-id` passthrough.
- Video QC sampling density, measured: free early-weighted probe caps at **12** frames (6 of
  them ≤2s; at 10s: `0.1,0.5,0.9,1.2,1.6,2,3.1,4.5,5.8,7.2,8.5,9.9`); the PAID call gets the
  quartile baseline + `MAX_EXTRA_FRAMES=2` = **3–5 frames**. **At 4s duration the baseline is
  ONE frame**, so paid QC could see as little as 1 — reachable (Omni enum includes 4), though
  Meta/PMax are floored at 10s today.

---

## 8. NEXT ACTIONS, in order

1. **Review + land the three authz fixes TOGETHER** (§5.1). `fee1f7c7` + the peer's
   capability-executor branch. Neither alone closes the hole. Re-run the suite; revert-prove
   behaviourally; `npx eslint .` is not optional (`no-undef` is the one thing a source-text
   harness cannot see, and that gap shipped a broken money guard three times).
2. **Confirm or refute the four UI defects** (§5.2), starting with the format-picker money
   question and the gallery-visibility one.
3. **Implement `g2-one-video-master`** (§4.5) and validate the VIDEO QC path — the one thing
   the owner originally cared about (hallucinated logos reaching delivery) is still unproven.
4. **Put the 11 design questions to the owner** (§6).
5. Review + land the parser hardening (`ef07b6b0`), then revisit flash — but only after the
   parser tolerates shape variation, and only with a fresh live probe. There is no primary
   evidence for the "10/10" claim.
6. §4.1 of the previous handoff (595 delivered ads with unsubstantiated claims) is **still
   open and still the only item with outside-the-building exposure.** New engineering facts
   found this session: enforcement is at RENDER time
   (`claimSubstantiationService.classify()` → `brandScriptExecutor.js:1415-1439`), **the claims
   are burned into delivered pixels** (`renderUrl`; `posterUrl` is a titled frame) so there is
   **no cheap DB remediation** — it is re-render or withdraw; `unclassified` claims pass
   through **ungated** ("Trusted by anglers", "Family-owned since 2003"); Director/operator
   `headline` is **entirely ungated** and static typesets it verbatim; and the PR #138 harness
   denylist includes `world's best` / `fastest-selling` which the live classifier does not catch.
