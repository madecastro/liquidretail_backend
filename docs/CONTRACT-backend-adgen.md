# The backend ↔ adgen handoff contract

**Contract version: 1.0.0** (`HANDOFF_CONTRACT_VERSION`, declared in
`src/services/handoffContract.js`)

Verified against **`liquidretail_backend` `origin/main` @ `6042073c`** and
**`liquidretail_adgen` `origin/master` @ `c02c7ff`**, read on 2026-08-27.

> ⚠️ **Both trunks move fast — treat the SHAs above as this document's expiry
> date, not decoration.** While it was being written, backend `origin/main`
> advanced twice (`a1df77e9 → f8b3d6b1 → 6042073c`) and adgen `master` three
> times, and **two of those commits closed defects this document had just
> finished describing as live** (§4 and §5.1, both now marked CLOSED with the
> fixing commit). That is a good outcome and it is also the standing hazard of a
> document like this one: the failure mode is not being wrong on the day it is
> written, it is being *right* then and unmaintained after.
>
> Before trusting a claim here, check whether its file has moved:
> `git -C <repo> log --oneline <sha-above>..origin/main -- <path>`.
> `scripts/verifyVendorDrift.js` answers that question mechanically for every
> vendored file at once, which is a large part of why it exists.
>
> **A related trap, because this contract is spread across two repos and several
> in-flight branches: a fix's completeness can be a property of its BASE rather
> than of its diff.** Reviewing the diff alone will not show it, and a rebase
> onto an older base silently reopens the defect with no conflict and no signal.
> Verified live example at the time of writing: adgen #75 (`c02c7ff`) is an
> ancestor of adgen #81's head (`b1a603d3`), and #81's own change does not
> stand alone without it. When a claim here says a defect is CLOSED, it is
> closed *on the trunk named above* — not necessarily on a branch that predates
> the fixing commit.

---

## How to read this document

Every factual claim below carries a `file:line` citation to code that was
actually read while writing it. Citations are prefixed:

- `backend/…` → `liquidretail_backend` (services/, models/, routes/ at repo root)
- `adgen/…` → `liquidretail_adgen` (everything under `src/`, plus `config/` at root)

**Anything this document could not establish from code is in
[§9 Not verified](#9-not-verified), stated as unknown rather than guessed.**
A contract document that describes what someone assumed becomes the reference
future work trusts, so an admitted gap is strictly better than a confident
guess. If you extend this document, keep that rule.

> ### A trap this document was itself caught by
> The shared `liquidretail_backend` checkout at
> `/Volumes/Sayulita/Projects/RS/liquidretail_backend` is routinely parked
> **behind** `origin/main` and carries other sessions' uncommitted edits. An
> early pass of this analysis read that tree and concluded the three
> `regenerate*` contract fields did not exist in backend at all. They do —
> the checkout was at `f31b1caf`, before `a1df77e9` (PR #345) landed.
>
> **Verify cross-repo claims against `origin/main`, not against whatever the
> sibling working tree happens to be sitting at.** Both
> `scripts/lib/vendorDrift.js` and `scripts/verifySharedInvariants.js` read
> backend through `git show origin/main:<path>` for exactly this reason.

---

## 1. The shape of the handoff

There is **no synchronous call between the two services in either
direction.** Confirmed by searching both trees: adgen's entire public HTTP
surface is `GET /health` (`adgen/src/routes/api.js`), and no backend code
constructs a URL for adgen.

The handoff is a **Mongo document state**, and it works like a job queue with
no queue:

1. Backend mints an `Ad` and atomically moves it `queued → rendering`
   (`backend/routes/ads.js:1423-1429`). It does **not** set
   `claimedByWorker`, so the row lands in the claimable shape
   `{status:'rendering', claimedByWorker:null}`.
2. Backend's `runRenderLoop` checks the ownership flag and **returns**
   (`backend/routes/ads.js:1861-1870`).
3. An adgen renderer polls, wins the row with a single atomic
   `findOneAndUpdate`, renders it, and writes the terminal state back
   (`adgen/src/services/renderer.js:687-696`).

This is genuinely good design for restart-resilience: there is no
synchronous call to fail, no retry policy to get wrong, and a dead worker
loses a lease rather than a request. The cost is that the interface is an
**implicit document shape that neither service declares** — which is what
`src/services/handoffContract.js` now fixes, and what this document
describes.

### The claim is the mutual-exclusion primitive

`claimedByWorker` carries more meaning than "which worker owns this":

| `claimedByWorker` | Meaning |
|---|---|
| `null` + `status:'rendering'` | Claimable by adgen **or** being rendered in-process by backend. **These two states are indistinguishable in the document.** See §6.1 — this is the sharpest edge in the contract. |
| set | An adgen worker owns it. Backend's reaper explicitly skips these rows (`backend/worker.js:399-405`). |

---

## 2. The ownership flag: `ADGEN_RENDERER_ENABLED`

### The predicate

Byte-identical in both repos:

```js
String(process.env.ADGEN_RENDERER_ENABLED || '').toLowerCase() === 'true'
```

- `backend/services/adgenBridge.js:13-15`
- `adgen/src/config.js:64-65`
- `adgen/src/services/adgenBridge.js:13-14` — **a third, dead copy.** Nothing
  in adgen requires it; the vendor manifest records it as `unused` ("backend→adgen
  handshake copy; adgen is the callee, not the caller"). Flagged because a
  future edit to one of the two live copies will not reach it.

Properties, asserted by **execution** over a fixture table in
`scripts/verifyHandoffContract.js` rather than by reading the source. (Those
fixtures cover `isOwnershipFlagOn` in the shared contract module — they do
**not** pin the three production readers above, which each re-implement the
same expression. A loosened reader would not fail that check.)

- Case-insensitive: `'TRUE'`, `'True'` → on.
- **Only** the exact string `true`. `'yes'`, `'1'`, `'on'`, `''`, unset,
  malformed → **off**.
- **Read at call time, never cached at boot**, at every site — the code
  genuinely re-reads `process.env` on every call, and that much is verified.
  Whether a Render dashboard edit mutates a *running* process's environment is
  **not** verified here (§9.2). Several code comments assert it takes effect
  "without a redeploy"; this document does not confirm that half.

### Fail-safe direction

Off is the safe default, and the reasoning is asymmetric — it is worth
understanding rather than memorising. Backend renders **unconditionally**
whenever the flag is not `'true'`. So:

- adgen misreading the flag as **off** → it stands down, and backend already
  handles the work. Harmless.
- adgen misreading it as **on** → it races backend for the same rows.
  Billable.

`adgen/src/services/renderer.js:660-668` states this explicitly, and
`adgen/src/services/renderer.js:669` returns `null` from `claimOne()` on the
off branch as defence in depth, even though `poll()` already checked
(`adgen/src/services/renderer.js:1872`).

### Where it is configured

| Source | Value |
|---|---|
| `backend/config/defaults.env:1166` | `ADGEN_RENDERER_ENABLED=false` |
| `adgen/config/defaults.env:1348` | `ADGEN_RENDERER_ENABLED=false` |
| `backend/render.yaml` | **file does not exist** |
| `adgen/render.yaml` | flag **not declared** |
| SystemConfig (either repo) | **no override path exists** — checked `models/SystemConfig.js` and `services/systemConfigService.js` in both trees. Unlike the vision-QC flags, this one is env-only. |

**So `config/defaults.env` ships `false` in both repos while production runs
`true` via a Render dashboard override — both branches are live code.** The
`true` branch is the entire handoff; the `false` branch is backend's
in-process renderer, which is still present and still works.

`dotenv` is called **without** `override: true` (`adgen/src/config.js:12-13`),
so a dashboard/process env value always wins over `defaults.env`. The
committed `false` is a floor, not the effective value.

> The production value being `true` is **asserted by `backend/README.md`, not
> by anything in either repo's committed config.** This document did not read
> the Render dashboard. See §9.

### What each read site switches

**Backend** — three production readers:

| Site | Flag on | Flag off |
|---|---|---|
| `backend/routes/ads.js:1861-1870` (`runRenderLoop`) | Flip `CampaignRun` `preparing→running`, log, **return**. Adgen claims. | Render in-process. `claimedByWorker` stays `null` throughout. |
| `backend/services/adRegenerateService.js:625` (`regenerateAd`, via `shouldDeferToAdgen()` at `:476`) | Win the `regenerating` lock, stamp `regenerationRequest`, **return**. | Win the same lock, **null** the three regenerate fields, execute locally. |
| `backend/services/titlingResumeService.js:141` (`resumeUntitledMasters`) | Return immediately, no query. | Title recovered masters in the web process. |

**Adgen** — every production read site, all call-time. (Deliberately not
prefaced with a count: this repo's own `runVerifySuite.js` header documents
three separate stale hardcoded counts that a later PR made false. Get the
current list with
`grep -rn 'isAdgenRendererEnabled' src/`.)

- `renderer.js:669` (`claimOne` — the gate that matters), `:1872` (`poll`),
  `:1977` (boot-recovery tick), `:2022` (titling-resume tick),
  `:2051`/`:2082` (log lines only)
- `titler.js:146` (`claimOne`), `:733` (reclaim sweep)
- `regenerateConsumer.js:101` (`claimOne`), `:143` (`tick`), `:249` (`start`)

Two deliberate non-readers, both correct:
`releaseClaim` and `shutdown` do **not** consult the flag — an in-flight
claim is drained and released regardless of a mid-run flip (pinned by
`adgen/scripts/verifyAdgenClaimRespectsRendererFlag.js`). `processAd` does
not re-read it either: once a row is claimed, the work finishes.

---

## 3. Protocol A — the mint-time render claim

### Fields

| Field | Type / default | Writer | Notes |
|---|---|---|---|
| `status` | enum, `'queued'` | **both** | `['queued','rendering','draft','live','archived','failed']` (`adgen/src/models/Ad.js:178`) |
| `renderRoute` | `'html_gen'`\|`'veo'`\|`null` | backend | Set at mint (`adgen/src/models/Ad.js:168-173`) |
| `claimedByWorker` | `String`, `null`, indexed | **adgen only** | `adgen/src/models/Ad.js:52`, `backend/models/Ad.js:52` |
| `claimedAt` | `Date`, `null`, indexed | **adgen only** | `adgen/src/models/Ad.js:53` |
| `updatedAt` | `Date` | **both** | `timestamps:false` in both schemas (`adgen/src/models/Ad.js:738`, `backend/models/Ad.js:739`) — **maintained by hand** |

### The claim query (the atomicity guarantee)

Verbatim from `adgen/src/services/renderer.js:687-696`:

```js
return Ad.findOneAndUpdate(
  {
    status:          'rendering',
    claimedByWorker: null,
    renderRoute:     { $in: ['html_gen', 'veo'] },
    ...(isTitlerEnabled() ? { titlingNeeded: { $ne: true } } : {}),
  },
  { $set: { claimedByWorker: WORKER_ID, claimedAt: new Date() } },
  { new: true, sort: { createdAt: 1 } }
);
```

`claimedByWorker: null` is the whole lock — one `findOneAndUpdate`, so
exactly one worker's `$set` lands. FIFO by `createdAt`.

Two details that are load-bearing and easy to get wrong:

- `renderRoute: {$in:[…]}` means a row with `renderRoute: null` is **never
  claimable**. Backend must set it at mint or the ad sits forever.
- `titlingNeeded: {$ne: true}` — not `: false` — so rows predating the field
  stay claimable. Without this term the renderer re-claims rows it just
  handed to the titler, which is a livelock
  (`adgen/src/services/renderer.js:681-686`).

### Write ownership, checked rather than assumed

**`claimedByWorker` and `claimedAt` are written by adgen and never by
backend.** Verified by grepping every occurrence in
`backend/services/`, `backend/routes/`, `backend/worker.js`,
`backend/index.js`: the only non-comment hit is a **filter**,
`claimedByWorker: null`, at `backend/worker.js:403`.

This is the field the whole partition rests on, so it is the one worth
re-checking after any backend change to the render or reaper paths.

### Transitions

| From → To | Service | Site | Meaning |
|---|---|---|---|
| *(insert)* → `queued` | backend | `campaignAdsGenerationService` mint | Ad exists, not yet in a run. |
| `queued` → `rendering` | backend | `routes/ads.js:1423-1429` | A run owns it. `claimedByWorker` still `null`. **This is the handoff.** |
| `rendering`, `claimedByWorker:null` → claimed | adgen | `renderer.js:687-696` | Worker lease taken. |
| `rendering` → `draft` | adgen (flag on) / backend (flag off) | renderer success stamp | Success. Claim cleared in the **same** `$set`. |
| `rendering` → `failed` | adgen / backend | `renderer.js` `processAd` catch | Terminal failure. Claim cleared. |
| `rendering` → `rendering`, claim released | adgen | timeout / derive-requeue | Left claimable so resume-from-receipt can re-enter. **No status change.** |
| `rendering` → `queued` | backend reaper | `worker.js:399` | Receipt-free, **unclaimed**, `updatedAt` stale > `REAP_STALE_MIN` (default **15**, `backend/services/staleness.js:66`). |
| `rendering` + receipt + stale → `draft`/`failed` | **both** boot recoveries | `bootRecoveryService.js` | Free GET of an already-paid prediction. `RESUME_STALE_MIN` default **5** (`backend/services/bootRecoveryService.js:65`). |
| `rendering` → `queued` | backend SIGTERM | `processAlerts.js:124-130` | Receipt-free rows of in-flight runs. **No `claimedByWorker` term** — see §6.3. |
| `rendering` → `queued` | backend crash/CAS paths | `routes/ads.js:1333`, `:1359`, `:1674`, `:1699` | Same shape, same missing term. |
| `queued` → `archived` | backend sweeper | `worker.js:287` (`queuedArchiveSweeper`) | Stale mint leftovers, **live today**. |
| `rendering` → `archived` | backend Stop | `routes/ads.js` (undispatched tail) | Operator Stop, pre-dispatch rows only. |
| `archived` → `draft`/`live` | backend restore | `PATCH`, `ad.restore` | Un-archive. |
| `draft`/`live`/`archived` | backend HTTP only | `PATCH /api/ads/:id` | Operator lifecycle. Adgen exposes no such route. |

**Adgen's *renderer* writes only `draft`, `failed`, and `rendering`** —
pinned by `adgen/scripts/verifyRendererAdStatusEnum.js`, whose scope is
`renderer.js` specifically, not the whole repo. Two precise caveats, because
the broader claim "adgen never writes `archived`" would be wrong:

- `adgen/src/services/queuedArchiveSweeper.js` is **vendored and would write
  `status:'archived'`**, but nothing in `src/` requires it and no adgen role
  starts it. The vendor manifest records it `unused` ("backend archive
  sweeper; not wired into adgen entrypoint"), and
  `verifyVendorDrift.js`'s dead-module check is what keeps that true. If it
  is ever wired, this table needs a new row.
- `status: 'live'` appears many times in `adgen/src/services/platformFormats.js`
  — that is a **different field** (a platform-surface status), not `Ad.status`.
  Do not grep for `status: 'live'` and conclude adgen publishes ads.

`live` is an operator action, reachable only through backend's
`PATCH /api/ads/:id` (which accepts only `draft|live|archived`).

**`archived` is NOT operator-only.** Backend's `queuedArchiveSweeper` is started
from `backend/worker.js:287` and auto-archives stale `queued` leftovers; every
archive write funnels through `backend/services/adArchiveDigest.js:503`. Restore
then moves `archived → draft|live`. Full set of `archived` writers: operator
PATCH, that live backend sweeper, and Stop.

### Why `updatedAt` is a contract field

`timestamps: false` in both schemas, so Mongoose never touches `updatedAt` —
**every writer sets it by hand.** Both the backend reaper and both boot
recoveries use it as their staleness signal. Without a heartbeat it only
moves when an ad settles, so a long video-titling gap is indistinguishable
from a dead worker. That is why adgen heartbeats it while holding a claim.

---

## 4. Protocol B — the regenerate deferral

Landed as backend PR #345 (`a1df77e9`) and adgen PR #72. Backend's
`POST /api/ads/:id/regenerate` and both agent capabilities funnel into
`adRegenerateService.regenerateAd()`.

### Fields

| Field | Type / default | Writer | Notes |
|---|---|---|---|
| `regenerating` | `Boolean`, `false`, indexed | **both** | `adgen/src/models/Ad.js:210`, `backend/models/Ad.js:210`. Shared by both paths — **not** the deferral bit. |
| `regenerationRequest` | `Mixed`, `null` | **backend only** | `adgen/src/models/Ad.js:252`, `backend/models/Ad.js:265`. **This** is the deferral bit. |
| `regenerateClaimedByWorker` | `String`, `null`, indexed | adgen | `adgen/src/models/Ad.js:261`, `backend/models/Ad.js:273` |
| `regenerateClaimedAt` | `Date`, `null` | adgen | `adgen/src/models/Ad.js:262`, `backend/models/Ad.js:274` |

### Backend's lock write

The flag is read **once, synchronously, before any `await`**
(`backend/services/adRegenerateService.js:625`, calling `shouldDeferToAdgen()`
at `:476`). The decision is therefore **frozen for that request** — a later
env flip cannot change who owns it.

One atomic lock, filter `{_id: adId, regenerating: {$ne: true}}`
(`backend/services/adRegenerateService.js:662-663`), with two different
`$set` payloads:

**Deferred** (`:634-643`):
```js
{ regenerating: true, regenerationStage: 'pending', updatedAt: <Date>,
  regenerationRequest: buildRegenerationRequest({ … }) }
```
then **return** — no local execution.

**Local** (`:634-637` + `:658-660`):
```js
{ regenerating: true, regenerationStage: 'pending', updatedAt: <Date>,
  regenerationRequest: null,
  regenerateClaimedByWorker: null,
  regenerateClaimedAt: null }
```
then execute in-process.

`buildRegenerationRequest` (`:484-498`) has exactly nine keys: `kind`,
`prompt`, `mode`, `requestedBy`, `videoModel`, `promptOverride`,
`videoPromptRaw`, `videoPromptGuidance`, `imagePromptRaw`.

**Why the local path nulls the fields rather than leaving them alone**
(`:645-657`): a stale `regenerationRequest` object left over from a crashed
deferred attempt, sitting next to `regenerateClaimedByWorker: null`, is
*claimable*. Without this null-out, a new local regenerate winning the lock
would leave adgen free to claim the stale payload in the same instant —
a double submit with different arguments.

### Adgen's claim query, and the `$ne` / `$type` distinction

Verbatim from `adgen/src/services/regenerateConsumer.js:100-110`:

```js
return Ad.findOneAndUpdate(
  {
    regenerating:              true,
    regenerationRequest:       { $type: 'object' },
    regenerateClaimedByWorker: null
  },
  { $set: { regenerateClaimedByWorker: WORKER_ID, regenerateClaimedAt: new Date() } },
  { new: true, sort: { updatedAt: 1 } }
);
```

**`$type: 'object'`, deliberately not `$ne: null`.** MongoDB's `$ne` is
documented to match documents that **do not contain the field at all** —
which is the shape of every pre-migration ad and every locally-executed
regenerate. An earlier version using `{$ne: null}` therefore collapsed to
matching *any* `regenerating: true` row, including ones backend was
executing in-process. That was a real double-submit bug; the regression is
pinned by `adgen/scripts/verifyRegenerateConsumerClaim.js` (cases A3/B7).

### ⚠️ The three claims are NOT mutually exclusive

An earlier draft of this document said this claim is "on a filter **disjoint**
from the mint-time claim and from the titler's, so the three can never contend
for one document." **That was wrong, and correcting it is the most important
change in this document.**

The three claims use **different lease fields**, so they do not serialize
against each other at all:

| Claim | Lease field | Filter |
|---|---|---|
| Renderer | `claimedByWorker` | `{status:'rendering', claimedByWorker:null, renderRoute:{$in:[…]}}` |
| Titler | `claimedByWorker` | `{status:{$in:['rendering','draft']}, veoVideoUrl:{$ne:null}, titlingNeeded:true, claimedByWorker:null}` |
| Regenerate | `regenerateClaimedByWorker` | `{regenerating:true, regenerationRequest:{$type:'object'}, regenerateClaimedByWorker:null}` |

Renderer and titler *are* mutually exclusive — they share `claimedByWorker`,
and the `titlingNeeded` term partitions them. **Regenerate is exclusive with
neither**, because it holds a different field. As of backend `a1df77e9`,
regenerate preflight refused only four things — derive-only (`:536`),
meta-synced (`:540`), already-regenerating (`:544`) and the daily cap (`:552`) —
and refused **neither** `status:'rendering'` **nor** `titlingNeeded`.

> #### ✅ CLOSED by backend #349 (`6042073c`), 2026-08-26 — but read why
>
> This was a live money defect when first written up here, and #349
> independently reached the same conclusion in its own words: *"the two filters
> are disjoint and both match the same document — a Regenerate pressed during a
> first render submits a second real generation for one ad."*
>
> **The lease fields are still different** — that part of the analysis above
> stands and always will. What changed is that contention is now *refused*
> rather than merely unlikely, in **both** places, which is the part worth
> copying if you ever add a fourth claimant:
> - `inFlightRefusal(ad)` (`backend/services/adRegenerateService.js:550`) — the
>   read-side predicate preflight turns into a 409 (`:635`);
> - `notInFlight(filter)` (`:583`) — the write-side Mongo filter ANDed into the
>   atomic lock: `notInFlight({_id: adId, regenerating: {$ne: true}})` (`:758`).
>
> Both were needed. Preflight is a `.lean()` read, and every caller answers 202
> then runs `regenerateAd` from `setImmediate`, so the row can change in
> between — `titlingResumeService` can claim a draft master inside that window.
>
> Three arms are refused: `rendering`, `queued`, and *titling*. The titling arm
> is the subtle one and matches §6.4 — a paid video master still owed titling
> already has `status:'draft'`, so a status-only guard would miss it.
>
> **Do not read this as "the claims are disjoint after all."** They are not. A
> future change to regenerate preflight or to that lock filter can reopen this,
> and nothing about the lease fields will warn you.

> #### ⚠️ A documentation divergence on this exact operator — fixed by this change set
>
> **This is the one thing that required editing the backend repo**, so it is
> worth stating precisely, including the fact that the citations below are
> *historical*.
>
> On `backend/origin/main` @ `a1df77e9` — i.e. **before** this change set —
> `models/Ad.js` documented the adgen claim filter with the **old, buggy**
> operator in two places:
> - `git show a1df77e9:models/Ad.js`, line **244** — "a poller keying its claim query on `regenerationRequest: {$ne: null}`"
> - line **253** — `findOneAndUpdate({regenerating:true, regenerationRequest:{$ne:null}, …})`
>
> Meanwhile `adgen/src/models/Ad.js:245-257` documented `$type:'object'`,
> matching the live consumer. The two halves of one contract disagreed, on the
> operator whose misuse had already caused a double-claim.
>
> **Nothing was broken at runtime.** Backend's executable code never *queries*
> this field — all three non-comment occurrences are writes
> (`adRegenerateService.js:640` object, `:658` null, `:1163` null), verified by
> exhaustive grep. The divergence was documentation-only.
>
> It still mattered, because backend's schema comment is exactly where the next
> person implementing or reviewing a poller against this field would look, and
> it taught them the operator that caused the bug. **The backend PR in this
> change set rewrites both comments** to `$type:'object'` with the money
> reasoning inline.
>
> Because that edit inserts lines, the field declarations below it moved:
> `regenerationRequest` `:249 → :265`, `regenerateClaimedByWorker` `:256 → :273`,
> `regenerateClaimedAt` `:257 → :274`, `timestamps:false` `:722 → :739`. The
> tables in this document cite the **post-change** line numbers, so they are
> correct once both PRs land.

### Lease release, and what a crash leaves behind

**There is deliberately no retry or release sweep for a regenerate claim.**
`regenerateClaimedByWorker` stays set until an operator clears it by hand
(`adgen/src/services/regenerateConsumer.js:41-54`).

This is intentional, and the reasoning is a money argument worth preserving:
**adgen's** `adRegenerateService.runVideoFull` passes `allowResume: false`
explicitly (`adgen/src/services/adRegenerateService.js:879`) — an operator
regenerate always wants a *fresh* video, never a resumed one — so a naive
retry would be a **second billable Omni submit**.

⚠️ **This is an adgen-only property; do not attribute it to backend.** Backend's
own `runVideoFull` calls
`veoService.generateForAd({ad, operatorPrompt, storyboard, modelOverride})`
(`backend/services/adRegenerateService.js:867-872`) with **no `allowResume`
argument**, and it defaults to `true`. So on the flag-**off** local path a
backend regenerate of a row still holding a `veoPredictionId` will **resume**
rather than submit fresh. That is a real behavioural difference between the two
halves of this contract, on a money path. It also matches the
pre-existing backend-only behaviour exactly: a backend crash mid-`regenerateAd`
today also leaves `regenerating: true` forever with no retry. Adding a retry
here would be a regression unless the retry is itself resume-aware.

On shutdown, adgen waits up to the same drain budget as mint-time work and
then fires a **loud alert naming the ad** rather than releasing the claim
(`adgen/src/services/regenerateConsumer.js:169-183`).

`markComplete` clears `regenerating` and all three regenerate fields, on
whichever side executed (`backend/services/adRegenerateService.js:1163`;
adgen's vendored copy does the same).

---

## 5. Protocol C — recovery and reaping (shared writers, by design)

These are the paths where **both** services write the same fields on
purpose. They are the least obvious part of the contract.

| Sweeper | Started at | Gated on the flag? | Mutates | Thresholds |
|---|---|---|---|---|
| Backend reaper | `backend/worker.js` | **No.** Skips rows with `claimedByWorker` set. | receipt-free `rendering` → `queued` (`worker.js:399`) | `REAP_STALE_MIN` 15 |
| Backend boot recovery | `backend/worker.js:222-224` | **No — ungated.** | `rendering` + receipt + stale → `draft`/`failed` | `RESUME_STALE_MIN` 5 |
| Adgen boot recovery | `adgen/src/services/renderer.js:1977` | **Yes** — stands down when off | same | same |
| Backend titling resume | `backend/index.js:404-417` — interval **ungated**; gate is inside the function at `titlingResumeService.js:141` | effectively yes | titles recovered masters; CAS on `titlingResumeState` | interval 5 min |
| Adgen titling resume | `adgen/src/services/renderer.js:2022` | **Yes** | same | same |
| Adgen regenerate consumer | `adgen/src/services/renderer.js` | **Yes** | regenerate claim | poll 2s |

Two consequences that follow from the table and are not obvious:

> #### ✅ §5.1 PARTLY CLOSED by backend #346 (`f8b3d6b1`) — scope matters
>
> #346 added **both** a claim-awareness term and an `isAdgenRendererEnabled()`
> stand-down to backend's boot sweep — but **scoped to VIDEO recovery only**.
> Static-image recovery (`recoverImageAd`) stays unconditional and claim-blind,
> deliberately: a recovered image is one atomic peek-then-write with no hand-off
> to a second process, so two peekers racing it is the harmless case.
>
> adgen's own copy was fixed separately and **differently** by adgen #75
> (`c02c7ff`) — on adgen's side the dangerous row has *no claim at all*, so
> claim-awareness alone would not have caught it. The vendor manifest now
> records this path as a deliberate `fork` for exactly that reason; neither side
> should take the other's patch verbatim.
>
> **New consequence, from #346's own comment — a real trade, not a pure win.**
> adgen's per-ad heartbeat deliberately stops refreshing `updatedAt` past
> `AD_HEARTBEAT_MAX_MS` *while keeping the claim held*, on the reasoning that
> backend recovery should be able to take a genuinely-stuck row from there. With
> #346's gate on, backend now **declines** that handoff for as long as the flag
> reads true. Failover for a claim stuck past the cap therefore depends entirely
> on adgen's own sweep; if that sweep is not running, nothing recovers the row.
>
> The paragraph below describes the pre-#346 mechanism, which still applies to
> the **static-image** path and to the flag-off case.

**5.1 Backend boot recovery can write a terminal status under adgen's live
claim.** Its filter is `{status:'rendering', updatedAt: {$lt: cutoff},
…HAS_RECEIPT}` (`backend/services/bootRecoveryService.js:138`) — there is
**no `claimedByWorker` term**, and the sweep is not gated on the flag. Its
own writes are individually guarded by `status:'rendering'` in the filter,
so they are safe against a *concurrent settle*, but nothing stops them
firing while an adgen worker still holds the lease.

**The adgen render heartbeat is the main thing preventing this.** It exists
specifically to keep `updatedAt` moving so backend recovery does not judge a
live titling job to be dead. If the heartbeat lapses — its own duration cap, or
a missed-beat streak — backend will collect the receipt under adgen's still-set
claim. Treat the heartbeat as a contract obligation, not an optimisation.

⚠️ **But the heartbeat is not a complete answer, because there is a window where
nothing is holding the claim at all.** The renderer→titler handoff *clears*
`claimedByWorker` while leaving `status:'rendering'` and the receipt in place
(that is deliberate — it is how the titler becomes eligible to claim). The
heartbeat is owner-scoped (`{_id, claimedByWorker: WORKER_ID, …}`), so in that
gap it matches nothing and no-ops. Backend's recovery has no `claimedByWorker`
term, so during the handoff window it can collect a paid master that adgen is
about to title. Narrow, but not covered by the heartbeat argument.

**5.2 Backend can take an unclaimed row back even with the flag on.** The
reaper requeues `rendering` → `queued` after 15 minutes when
`claimedByWorker` is `null`. If adgen is slow to claim — not deployed, not
scaled up, sleeping on a misread flag — backend reclaims the work. It cannot
steal an *already-claimed* row, because `claimedByWorker: null` is in the
filter. `backend/config/defaults.env:1166`'s own comment notes this: flipping
the flag on with no adgen deployed strands ads until the 15-minute reaper.

---

## 6. Sharp edges

### 6.1 `false → true` mid-flight can double-render (and double-bill)

The one genuine correctness hazard found while writing this document.

Backend renders in-process with `claimedByWorker` left `null` for the whole
render (`backend/models/Ad.js:48-51`). Adgen's claim filter is
`{status:'rendering', claimedByWorker:null, …}`. **Those are the same
shape.**

So if the flag flips `false → true` while a backend `runRenderLoop` is
already past its gate at `backend/routes/ads.js:1861`, that loop keeps
rendering rows adgen is now free to claim. Atlas bills on submit.

Bounded by: the window is one in-flight backend render loop, and new
`runRenderLoop` calls take the handoff path. Not observed in production —
this is a by-construction finding, not an incident. **Mitigation for now:
flip this flag when no run is in flight.** A real fix would mean backend
marking its own in-process ownership, which is a behavioural change and out
of scope here.

### 6.2 A stamped-but-unclaimed regenerate is orphaned by a `true → false` flip

Backend has already returned; adgen's consumer stands down on the next tick.
The row keeps `regenerating: true` and its payload **forever** — there is no
regenerate reaper (§4), and boot recovery does not look at `regenerating`
rows because regenerate never sets `Ad.status`. Not a double-submit; a
permanent stall needing operator action.

### 6.3 A fragile ordering keeps SIGTERM off handed-off rows

Backend's SIGTERM handler requeues in-flight rows with
`receiptFree({campaignRunIds: {$in: s.runIds}, status:'rendering'})`
(`backend/services/processAlerts.js:124-129`) — **no `claimedByWorker`
term.** On its face that can requeue adgen-claimed work.

It does not, because `runRenderLoop` **returns at `:1869`, before
`inFlight.track(...)` at `:1888`** — so a handed-off run is never registered
as in-flight and never appears in `s.runIds`.

That safety property is an accident of statement order in one function. Moving
`inFlight.track` above the handoff return would silently make backend requeue
rows adgen owns. Worth a comment at the call site.

**And it only covers SIGTERM.** Do not generalise it to "backend never requeues
adgen-owned rows" — several other backend requeue paths have no
`claimedByWorker` term either:

| Site | `backend/routes/ads.js` |
|---|---|
| CAS-loss release | `:1333-1335` |
| `/generate` crash handler | `:1359-1361` |
| `/runs` crash handlers | `:1674-1676`, `:1699-1701` |

`runRenderLoop` performs several `await`s *above* the handoff return (route
partition, brand/user lookup, `runFeed.startRun`). A throw in that prologue, or
a lost `preparing→running` CAS, can requeue rows adgen has already claimed.

Worse, the requeue pipeline (`backend/services/adArchiveDigest.js`) **does not
clear `claimedByWorker`** — verified: the identifier does not appear in that
file. So such a row can land `status:'queued'` **with the lease still set**,
which makes it invisible to adgen's `claimOne` (it requires
`claimedByWorker:null`) *and* to backend's reaper (same term). A permanently
stuck row with no owner.

### 6.4 One lease field, two protocols

`claimedByWorker`/`claimedAt` are also the **titler's** lease
(`adgen/src/services/titler.js:146-162`). The partition is not only
`titlingNeeded`: the titler additionally requires `status ∈ {rendering, draft}`
and `veoVideoUrl ≠ null`, and it can claim a **`draft`** row, which the renderer
never does.

`ADGEN_TITLER_ENABLED` is committed `"false"` (`adgen/render.yaml:107-108`,
`adgen/config/defaults.env:1360`). **That is the same class of evidence this
document refuses to treat as production truth for `ADGEN_RENDERER_ENABLED`
(§9.1)**, so "currently dark" is not claimed here either — the committed value
is false and the live dashboard value was not read. It is a live coupling
surface on the same lease field the moment that flag is on.

---

## 7. Enforcement

Three harnesses, all in `npm test` (`scripts/runVerifySuite.js` globs
`scripts/verify*.js`), so all three run in CI.

| Harness | Answers | Needs the backend checkout? |
|---|---|---|
| `verifyHandoffContract.js` | Does the contract declaration still match this repo's live `models/Ad.js`, and was the version bumped when the field list changed? | Checks A-D: no. **Check E (cross-repo byte-identity) does** — it INFO-skips without the sibling, so CI never runs it. |
| `verifyVendorDrift.js` | Has anyone *looked* at each vendored file since either side moved on it? Is any owed port overdue? | Partly — see below |
| `verifySharedInvariants.js` | Do named semantic invariants hold in **every** copy, across both repos? | Partly |

### What a green CI does and does not mean

`.github/workflows/ci.yml` checks out **this repo only** and sets no
`ADGEN_BACKEND_PATH`, so `scripts/lib/siblingBackend.js` resolves to `null`
on every pull request.

Before manifest v2 that meant every cross-repo check in
`verifyVendorDrift.js` skipped with an INFO and the harness exited 0. **The
manifest had teeth on a developer's laptop and was a structural no-op on the
one surface that gates a merge.** That is how the `veoPromptBuilder.js` fix
landed in adgen with no CI signal.

Manifest v2 adds two checks that need **only this repo**, and therefore work
in CI:

- **`adgenHash`** — adgen's own bytes per vendored file. If they change
  without a reconcile, CI fails and the author must state whether backend
  needs the same edit.
- **`unported`** — a first-class status carrying `portTo` (which repo owes
  the port) and `owedSince`, failing once past `ADGEN_UNPORTED_GRACE_DAYS`
  (default 14). Re-reconciling **carries `owedSince` forward** so the window
  cannot be extended by rerunning the command.

**Read a green CI as "adgen's own copies are unchanged since someone
attested them, and no obligation is overdue" — not as "the two repos
agree."** The full cross-repo comparison runs when a human runs `npm test`
with both repos checked out side by side. Wiring the backend into CI needs a
PAT for a private repo; that is a separate change.

### Changing the contract

1. Edit `CONTRACT_FIELDS` in `src/services/handoffContract.js`.
2. `node scripts/verifyHandoffContract.js --print-digest` → paste into `CONTRACT_DIGEST`.
3. Bump `HANDOFF_CONTRACT_VERSION` (MAJOR = field removed/retyped or a writer changed).
4. Update this document — the harness checks it names the current version.
5. **Apply 1-4 to the other repo in the same session.** The module is
   vendored at the same relative path, so `verifyVendorDrift.js` fails on it
   until you do.

The digest covers `field`, `type`, `writer`, `enum` only. `note` and `role`
are excluded on purpose: if a wording fix forced a version bump, the version
would stop meaning anything and people would stop bumping it.

**Known limits of the shape check, stated so nobody over-trusts it.**
`assertContractShape` verifies that each contract field is *declared* and that
its Mongoose `instance` matches the declared type. It does **not** compare the
live schema's `enum`, defaults, or indexes against the contract. So editing
`models/Ad.js`'s `status` enum without touching `CONTRACT_FIELDS` stays green —
the digest pins the *declaration*, not the schema. Widening a contract enum is
therefore a change a human still has to notice.

---

## 8. Known divergence between the two repos

### `veoPromptBuilder.js` — an unported fix (tracked, now with a clock)

adgen removed a catalog-title interpolation from the Omni camera prompt on
2026-08-26 after Atlas Omni rendered the catalog title `Vaportek` as a
fabricated on-garment brand lockup over the real PELAGIC mark; vision-QC
terminal-rejected the $0.90 master. **The backend copy is still the pre-fix
blob.**

The vendor manifest recorded this as `status: fork` with the obligation in
prose — "a human must apply the same edit in `liquidretail_backend`". True,
unactioned, and permanently green, because a `fork` is a valid end state. It
is now `status: unported`, `portTo: backend`, with a start date and a
14-day grace window.

### `veoStoryboardService.js` — the same bug in both repos, byte-identical

The identical construct survives at `:68` in **both** repos:

```js
lines.push(`Product: ${product?.title || '(untitled product)'}`);
```

**No hash-based drift check can ever flag this.** The two copies agree, so
the manifest correctly calls the file `synced` — byte-equality actively
certifies the bug. This is precisely why
`scripts/verifySharedInvariants.js` exists: it checks a named invariant
across every copy, so a fix is provably a fix everywhere rather than a fix
in whichever copy someone had open.

> #### Correcting a widely-repeated claim about why this is dormant
>
> This bug is commonly described as "dormant behind
> `VEO_USE_GPT_STORYBOARD`". **That is wrong, and the real answer matters.**
>
> `config/defaults.env:395` ships `VEO_USE_GPT_STORYBOARD=true` in **both**
> repos, and no `render.yaml`, `Dockerfile`, `src/config.js`, or SystemConfig
> overrides it. `enabled()` returns **true**. If the module were reached, the
> bug would fire.
>
> What actually makes it unreachable is the **provider router**:
> - `adgen/src/services/videoRouter.js:29` — `activeProvider()` defaults to `'atlas'`, and `VIDEO_PROVIDER=atlas` is committed at `config/defaults.env:394`.
> - On the atlas path, `prepareStoryboard` returns `{storyboard: null}` — "Storyboard retired on the Atlas path" (`adgen/src/services/atlasVideoService.js:4344`).
> - `generateStoryboard` has exactly **one** production caller, `adgen/src/services/aiVideoReferenceService.js:320`, reached only from `videoRouter`'s non-atlas `else` branch.
>
> **Set `VIDEO_PROVIDER=vertex` and this line composes a paid Vertex Veo
> prompt.** The module's own header comment ("Off by default",
> `veoStoryboardService.js:10`) describes a gate that is not the real one.
>
> Both copies are recorded in `scripts/shared-invariants.json` with this
> reasoning, so the next person does not have to re-derive it.

### Pre-existing drift, not introduced here

Running `verifyVendorDrift.js` locally with a backend checkout reports two
failures that are **present on unmodified `origin/master`** (confirmed by
running the pre-change harness against the same trees):

- `services/atlasModelMap.js` — backend moved since the recorded look.
- `services/campaignAdsGenerationService.js` — backend moved, and adgen also differs from a `synced` record.
- `services/shotTypeRank.js` — recorded `synced`, adgen now differs.

They are untouched here deliberately. Resolving them means reading a backend
diff and deciding whether to port, which is a judgement call per file, not
a documentation change. They do not affect CI (the backend-side checks skip
there).

---

## 9. Not verified

Stated as unknown rather than guessed.

1. **Live Render dashboard values.** `ADGEN_RENDERER_ENABLED`,
   `VIDEO_PROVIDER`, `VEO_USE_GPT_STORYBOARD`, `ADGEN_TITLER_ENABLED`. This
   document read only committed files; **no dashboard or Render API was
   queried.** Provenance of the production claims, stated so nobody mistakes an
   assertion for a measurement:

   | Claim | Rests on | Strength |
   |---|---|---|
   | `ADGEN_RENDERER_ENABLED=true` in prod | `backend/README.md`, and adgen `CLAUDE.md` ("Production sets the dashboard override to `true`") | Prose in two repos. Not code, not a dashboard read. |
   | `ADGEN_TITLER_ENABLED=true` in prod | the commit message of adgen #75 (`c02c7ff`), which states it as a production fact while fixing a live defect | An owner-authored commit message. Stronger than a peer report, still an assertion. **Note this directly contradicts the committed `"false"` in `render.yaml:107-108` and `defaults.env:1360`** — the committed value is a floor, not the effective value. |
   | `VIDEO_PROVIDER=atlas` in prod | committed `defaults.env:394` **and** the code default at `videoRouter.js:29` | Strongest of the four — two independent code-visible sources. Still overridable. |

   **Every "both paths are live" statement in this document rests on the first
   row, which is prose.** If that is wrong, the flag-off branch is dead code and
   several hazards described here cannot occur.
2. **Whether a Render env edit changes a running process's `process.env`
   without a restart.** Several code comments claim a dashboard flip takes
   effect "without a redeploy". The *code* genuinely re-reads `process.env`
   at call time — that much is verified — but whether Render mutates a live
   process's environment was not tested.
3. **§6.1's double-render window has not been observed in production.** It
   follows from the claim filter and backend's null `claimedByWorker`; no log
   or delivery record was examined to confirm it has occurred.
4. ~~**`generationOrder`**~~ — **CLOSED by grep, not left hedged.** An earlier
   draft called this unresolved; it is not. Every write in
   `backend/services/` and `backend/routes/` sets it to `null`
   (`campaignAdsGenerationService.js:3647` and `:4056`, both at mint). **No
   writer anywhere sets a non-null value**, so the schema comment at
   `backend/models/Ad.js:153-154` ("populated when the renderer claims it") is
   stale prose describing behaviour that does not exist. Correctly excluded from
   `CONTRACT_FIELDS` — it is not part of the handoff.
5. **Collections beyond `ads` are enumerated but not fully traced.** Both
   services write `campaignruns`, `costlogs`, `layoutinputartifacts`, and
   `quotesnippetcaches`. Only the `ads` handoff is documented to the standard
   of this document; the others are named so the next reader knows they are
   coupling surfaces, not because their protocols were verified.
