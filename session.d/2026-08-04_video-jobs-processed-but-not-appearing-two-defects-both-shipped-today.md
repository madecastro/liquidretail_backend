## 2026-08-04 (evening) — "video jobs processed but not appearing": TWO defects, both shipped today
## 2026-08-04 (evening) — "video jobs processed but not appearing": TWO defects, both shipped today

Owner: *"video jobs don't seem to be appearing but seem to have been processed?"* Both halves of
that read were correct. The video WAS generated and billed; it was invisible. Two independent
defects, both introduced by today's own PRs, both found from production logs + a free Atlas GET.

### A. `orphan persist failed: receiptFree is not defined` — a live ReferenceError (PR #71 regression)

`services/processAlerts.js:107` calls `receiptFree({...})` and **the file never imported it**.
`routes/ads.js:23` and `worker.js:59` both do; `processAlerts.js` was missed in `75dace7`.

Both writes sit inside ONE `Promise.all([...])`, so the ReferenceError throws while the array is
being *evaluated* — `CampaignRun.updateMany` is never even constructed. Consequence on every
shutdown that has ads in flight:
- receipt-FREE ads are **not** requeued (they wait out the 15-min reaper)
- the CampaignRun is **not** marked failed and gets **no** `errors[]` row

That second one is exactly the "silent stall" pattern `persistOrphans` was written to prevent —
see its own comment at `:24`. A run appears to hang forever with no diagnostic.

**Live since the PR #71 deploy at 18:03:31Z.** Proven by the log pattern, not inferred:
17:27:10 `orphan persist: requeued 4 ad(s), marked 1 run(s) failed` **succeeded** (pre-deploy);
20:56:40 `orphan persist failed: receiptFree is not defined`. Every SIGTERM in between logged
"0 ad(s) in flight", which returns early at `:73` and never reaches the bad line — which is why
it hid for three hours.

**Why the harness was green.** `scripts/verifyReceiptAwareRequeue.js` had
`guardsBothReceipts = block => /receiptFree\(/.test(block)` — a regex over source TEXT. It proves
the call is written, not that the identifier is bound. `node --check` cannot catch it either: a
ReferenceError is runtime, not syntax. Textbook CLAUDE.md §5 "a test that cannot fail is not a
test". Now every file that CALLS `receiptFree(` must also be shown to IMPORT it, with the file
list DERIVED by scanning (not hardcoded), so the next call site cannot be unguarded.

### B. A recovered paid master was invisible AND never titled

Full trace of ad `6a7250e4babb256d896c91ea`:

| time (Z) | event |
|---|---|
| 20:56:12 | Omni submit, prediction `6ef65a77…` — **billed** |
| 20:56:28 | poll #1 |
| 20:56:40 | web SIGTERM; orphan persist crashed (defect A); ad left `rendering` |
| 21:05:26 | worker `bootRecovery` polled the receipt FREE, got the finished video, stamped `draft` |

Confirmed independently against Atlas (`GET /model/prediction/:id`, free):
`status: completed`, `price: 0.75`, one output URL. **The resume machinery worked — the money was
saved, not re-spent.** That part of PRs #70–#72 is vindicated.

But `bootRecoveryService.js:110` wrote only `{ veoVideoUrl, status:'draft', updatedAt }`, while the
normal render path (`routes/ads.js:1437-1460`) also writes `renderUrl`, `posterUrl` and `kind`.
`projectAd` (`routes/ads.js:~2982`) serialises `renderUrl: ad.renderUrl` with **no `veoVideoUrl`
fallback** — so the row was returned by the list (`draft` is inside the `rendered=true` whitelist
at `:1903`) with a null asset. A card with nothing to show.

And it was **terminal**: every `renderBrandScriptAndSave` caller is inside a live render, a
regenerate, or a brand route. Nothing swept untitled drafts. The service's own comment said it
"stays draft until titling completes through the normal path" — but that path only runs for
`queued` ads, and a recovered ad is no longer queued.

**Blast radius: exactly ONE ad.** `bootRecoveryService` returns early at `:77` when nothing is
stranded, so silence means zero; across the whole day there is exactly one
`stranded in rendering` line (21:05:26). Do not go looking for a backlog.

### THE MONEY TRAP IN THE OBVIOUS FIX — read before touching this

Owner chose "re-queue it for titling". **`status:'queued'` would have cost ~$0.75 per ad.**
`routes/ads.js:1342` declares `veoVideoUrl` FRESH every render and the path **never reads
`ad.veoVideoUrl`**, so `if (!veoVideoUrl)` at `:1367` is TRUE for a recovered ad — it would fall
straight into `veoGenerateForAd` and submit to Omni a SECOND time. The resume had to be
titling-only. `scripts/verifyTitlingResume.js` T6 asserts neither service contains
`status: 'queued'` anywhere, and T10 asserts the sweeper cannot even require `atlasVideoService`.

### The split, and why it is a split

**Remotion is warmed only in `index.js` (web); `worker.js` has ZERO remotion references.** So the
worker can recover the asset but physically cannot title it. Hence: worker recovers + marks, web
sweeps + titles.

- `bootRecoveryService` (worker) now also writes `renderUrl` / `posterUrl` / `kind:'video'` — the
  paid asset is viewable IMMEDIATELY, before titling — plus `titlingResumeState: 'pending'`.
- NEW `services/titlingResumeService.js` (web, on an interval from `index.js`) claims each
  pending ad with a state-guarded `updateOne` **before** rendering (lease-free, same pattern as
  bootRecovery — autoscaling runs several web instances), then calls `renderBrandScriptAndSave`.

### STATE LIVES ON A DECLARED FIELD — the first design was wrong, and adversarial review caught it

The first version parked the sentinel in **`Ad.renderStage`**, reasoning that reusing an existing
field dodges the Mongoose-strict trap (a write to an **undeclared** path is silently dropped — this
repo already lost `renderError.predictionId` that way). **That reasoning was inverted and the design
was dead on arrival.** `renderStage` is **OWNED by `services/adStage.js`**, which `$set`s it
unconditionally (`adStage.js:82-85`) and is called all through titling
(`brandScriptExecutor.js:1200`, `:1306`, `:1332` — `face-safe crop`, `titling 9:16`,
`uploading titled video`). So the sentinel was **clobbered within seconds** of the render starting,
and an ad whose render then crashed could never be re-swept — precisely the leak the module exists
to close. Note `adStage`'s throttle is **per-phase**, not a heartbeat (`adStage.js:67`), so only
~3 writes land across a render and `updatedAt` is NOT a reliable liveness signal either.

Fixed by declaring **`Ad.titlingResumeState`** (`models/Ad.js`, `enum:['pending','claimed',null]`).
The silent-drop trap is about *undeclared* paths; **declaring** the field removes it, and **G3**
asserts the declaration exists (statically AND via `Ad.schema.path()`), so the field can never be
used without being declared. `renderStage` is still written alongside as a human-readable
breadcrumb, but **nothing queries it** — **G1/G2** forbid keying any query or claim filter on it,
so neither half of this mistake can come back.

**A corollary worth knowing, and it is NOT introduced here:** the same mid-titling crash leaves the
identical orphan on the **normal** render path today. `routes/ads.js:1437-1460` stamps `draft` +
`renderUrl` *before* titling at `:1477`, and no sweeper catches a `draft` — they all key on
`status:'rendering'`. Pre-existing, still open. The resume path is now strictly *better* protected
than the normal path.

**Retry is bounded on purpose, and only a RENDER failure is terminal.** The failure branch mirrors
`routes/ads.js:1490-1504` (`status:'failed'`, `'master rendered; titling failed'`) and clears the
state, so a permanently failing ad is retried once then stops rather than looping a CPU-heavy
Remotion render forever. But everything *before* the render is DB reads (claim / `findById` /
Media / Brand), and this sweeper runs ~90s after boot and on an interval — i.e. exactly while a
deploy churns Mongo connections. A blip there must not write off a paid, recoverable ad, so a
**pre-render throw releases the claim instead of condemning** (`renderAttempted` flag, pinned by
**T18**). The paid master stays on `renderUrl` and is never deleted in any branch.

**An unresolvable brand ships the master rather than failing.** Releasing straight back to
`pending` forever was a silent infinite retry, so it is bounded by `BRAND_GIVEUP_MIN`. Past that
window the outcome **mirrors `routes/ads.js:1469`/`:1512`**, which treats a null brand as
*intentional success* — no brand means no chrome to composite, so the raw master IS the
deliverable. Marking it `failed` would write off a good paid ad for a condition the normal path
ships happily, and would make one ad's outcome depend on which code path titled it (**T17b**).

Kill switches / knobs, all reversible without a deploy: `TITLING_RESUME_ENABLED=false`,
`TITLING_RESUME_INTERVAL_MIN=5`, `TITLING_RESUME_MAX=5`, `TITLING_RESUME_STALE_MIN=15`,
`TITLING_RESUME_BRAND_GIVEUP_MIN=60`.

### A STALE CLAIM IS RECLAIMABLE — and the claim filter is a THREE-armed ternary on purpose

Same failure mode as above (crash mid-render), which is why the state had to move off
`renderStage` before this could work at all. The query has three arms:

| arm | matches | why |
|---|---|---|
| pending | `titlingResumeState:'pending'` | recovery marked it, titling not started |
| stale claim | `'claimed'` + `updatedAt < staleCutoff` | a render was killed mid-flight — reclaim, don't leak |
| **migration** | `veoVideoUrl != null` **and** `renderUrl: null` | ads already stranded by the code in production |

**Do not "simplify" the claim filter into one query.** It must reproduce the condition that
selected the ad, because that is what makes the claim exclusive with no lease:
- *pending* — the first writer flips the state, so a later writer's `'pending'` misses.
- *stale claim* — the state is ALREADY `'claimed'`, so **the state cannot arbitrate**;
  `updatedAt: { $lt: staleCutoff }` is the only thing stopping two instances both winning and
  double-rendering. The first writer bumps `updatedAt` and every later staleness bound misses.
  Pinned by **T14**; **T8** asserts all three arms are guarded.
- *migration* — `renderUrl: null` is the arbiter; the claim sets `renderUrl`, so later filters miss.

`TITLING_RESUME_STALE_MIN` is **15 minutes, deliberately generous**: `adStage`'s throttle is
per-phase, not a heartbeat, so a legitimately slow render does not keep bumping `updatedAt`.
Under-setting it is the harmful direction (two passes titling one ad — wasted CPU, but **no spend**;
Remotion is local and the later write wins).

### THE MIGRATION ARM IS WHY THE OWNER'S ACTUAL AD GETS FIXED

Without it this whole change would have been useless for the ad that prompted it. The code
**currently in production** wrote `veoVideoUrl` + `status:'draft'` and nothing else, so ad
`6a7250e4babb256d896c91ea` carries **no `titlingResumeState` and no `renderUrl`** — arms 1 and 2
would never see it, and it would have stayed broken after the deploy. `renderUrl: null` alongside a
non-null `veoVideoUrl` is the unambiguous signature of that bug, it is **self-limiting** (once
handled the ad has a `renderUrl` and can never re-match), and the claim **backfills**
`renderUrl`/`posterUrl`/`kind` — because titling alone would not make it visible, since `projectAd`
reads `renderUrl` with no `veoVideoUrl` fallback. Not gated on `kind`, because the old write never
set it. Pinned by **T16/T16b**.

### One log red herring, worth knowing before reading video logs

`pollPrediction` is shared by `reframeReferenceForAspect` (`atlasVideoService.js:1760`) and the
video submit (`:3112`), and the `🎬 atlasVideo: polling …` line carries NO `[ad=]` prefix. So the
reference **prewarm** outpaints look identical to video generations in the log. Of the ~12
predictions completing between 22:05-22:07Z, ALL were prewarm; there was exactly **one** real
video submit after 18:00Z. Filter on `submitting...` (which does carry `[ad=]`) to count real
video spend, and note prewarm completes in 33-68s vs ~100-411s for a master.

### Still to watch / deliberately NOT fixed

- **NOTHING HAS RUN IN PRODUCTION YET.** The sweeper has never fired. Everything here is
  offline-verified only (26 + 20 checks, 15 revert-proven mutations, 54-script suite green except
  the pre-existing `verifyFontFallback.js`, which also fails at clean `origin/main`). On first
  deploy, confirm ad `6a7250e4babb256d896c91ea` (the migration-arm case) transitions to
  `renderStage:'done'` with a titled `renderUrl` that **DIFFERS** from `veoVideoUrl` — that
  inequality is the only real proof titling actually composited rather than shipping the raw master.
- **Ads can be pushed to Meta before titling completes.** `metaAdsPushService` has no server-side
  gate on titled-vs-raw, and this change makes recovered masters visible (hence pushable) sooner.
  Raised by adversarial review, **NOT fixed** — it needs an owner decision on whether an untitled
  master should be pushable at all, and it is a pre-existing hole rather than something introduced
  here.
- **`CampaignRun` counters are never reconciled for recovered+titled ads.** `persistOrphans` stamps
  the run `failed` on SIGTERM; neither `bootRecoveryService` nor `titlingResumeService` touches
  `succeeded`/`failed`/`status`, and `GET /api/ads/runs/:runId` returns them verbatim. So a run can
  read `failed` while its ad is a finished, titled, delivered creative. Pre-existing; this change
  makes the divergence more visible. Not fixed.
- **No watchdog arm for the new non-terminal states.** `backlogWatchdog:69` only queries
  `status:'rendering'`, so an ad parked in `pending`/`claimed` never alerts regardless of duration —
  recovery depends entirely on the sweeper being alive and `TITLING_RESUME_ENABLED !== 'false'`.
  Cheap to add; deliberately out of scope here.
- `bootRecoveryService`'s query uses `HAS_RECEIPT`, an `$or` covering **static** receipts too, so a
  static ad holding `imageGeneration.predictionId` is considered every pass and peeked as
  `state:'no-receipt'` (`atlasVideoService.js:2452`) → counted `unknown` forever. Benign noise, not
  a money bug, NOT fixed. The recovered branch stays video-only by construction because it
  requires `r.videoUrl`.
- **`spendReceipt.js` prose corrected, and the gap is real.** It claimed receipt-free ads "were
  never billed — the process died before or during submit". The *"during submit"* half was wrong:
  the receipt is written AFTER the submit POST returns, so an ad whose submit is in flight at
  SIGTERM **is billed and still receipt-free**, matches `RECEIPT_FREE`, and gets requeued. The
  window is one HTTP round-trip and irreducible without a pre-submit intent record; it is not a
  silent double-charge because `queued` ads never auto-drain, so a human must re-drain first.

### ALSO FOUND, and it reached production: unresolved merge conflict in `config/defaults.env`

`origin/main` (= what is deployed) carried literal git conflict markers at lines
**498 / 535 / 566** of `config/defaults.env` — a file that is `dotenv`-loaded at boot on
both services. Committed by a merge of `fix/brand-led-static-copy` that was never resolved.

**It was NOT breaking config, and that is measured rather than reasoned:** parsing main's
file with dotenv yields **114 keys**, and the two arms hold disjoint, non-overlapping vars —
HEAD had `AGENT_*` (7 vars incl. `AGENT_DAILY_CAP_USD=10`), the other arm had
`STATIC_PROMPT_FIDELITY_HARDENING=true` / `STATIC_BRAND_LED_COPY=true`. dotenv silently
skips any line that is not `KEY=VALUE`, so all three markers were inert and every value
resolved correctly. Repo-wide scan: **only this one file**, no `.js` file affected — which
is why prod boots at all.

**Resolved here by keeping BOTH arms**, because both sets of vars were already effective in
production; dropping either would have been a silent behaviour change dressed up as a
cleanup. Proven a no-op: key count is **117 → 117** across the fix in this branch, with every
value byte-identical.

Two lessons worth keeping:
- A `.env` file is the one place a conflict marker can survive review AND runtime, because
  the parser ignores what it cannot understand. `node --check` cannot see it either.
- The §4a diagnostic (`grep -oE '^[A-Z_][A-Z0-9_]*=' config/defaults.env`) would NOT have
  flagged it — markers do not match that pattern. Add a marker scan to any config audit.


---

