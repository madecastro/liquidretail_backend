# Operational alerting → Slack

Push alerts for crashes, dropped work, stalled runs, and spend spikes.
Implemented in `services/alertService.js` (transport + dedupe + rate-limit spill),
`services/processAlerts.js` (crash / restart / shutdown),
`services/crashReporter.js` (single choke point: IncidentLog then Slack),
`models/IncidentLog.js` (durable system of record),
`services/renderDiagnostic.js` (one Ad failure-payload builder),
`services/backlogWatchdog.js` (periodic health sweep), and
`services/inFlight.js` (run-level **and** ad-level — what a shutdown is about to destroy).

Transport is **Slack via bot token** (`chat.postMessage`). Telegram is
removed; there is no live fallback. Verified live (prod `13cf679`):
worker boot log reads `🔔 alerts: Slack configured`
(`worker.js:137`). The crash-alerting hardening documented here is
**verified offline only** (48 `scripts/verify*.js` green) — it has not
been exercised in production yet. Claims about prod behaviour of the new
paths would be speculation.

## Why this exists — the failure it was built to expose

Ad rendering, **including every paid video generation**, does not run on a
durable queue. `POST /api/ads/generate` and `POST /api/ads/runs` flush a
`202 Accepted` and then run `runRenderLoop` in a `setImmediate` **inside the
web service process** (`routes/ads.js`). Video ads run at
`VEO_CONCURRENCY` concurrent Omni submits, so a large batch occupies that
process for a long time.

That process does not survive that long reliably:

- Every **deploy** replaces it.
- Render **autoscaling** replaces it too — the web service runs
  `min 1 / max 3` with CPU **and** memory triggers at 60%, so a busy render
  batch is itself a scale trigger.

When the instance goes away mid-batch the loop dies with it. Nothing throws,
nothing is logged as an error, and the UI simply stops advancing. The ads sit
in `status: 'rendering'` until worker.js's orphan reaper flips them back to
`'queued'` 15 minutes later — and **nothing drains `'queued'`
automatically**: `selectAdsForRun` is only reachable from those two HTTP
routes, so the work resumes only when a human presses *Generate more*.

Observed on 2026-07-27: a 20-ad video batch started 18:48:22, was killed by
the 18:51:44 deploy, and 15 of its ads were reclaimed by the reaper at
19:07:12 — where they stopped. The only trace was one line in the Render log.

A later deploy during a colleague's batch produced a Slack line that said
only `web shutting down with N ad(s) in flight` — counts, no ad ids, no
stage, no commit, no money-at-risk flag. Not diagnosable in isolation.
That is the failure the crash-reporter / IncidentLog / ad-level in-flight
work exists to close.

**The alerts below make each of those moments visible. They do not fix the
architecture** — see *Known gap* at the end.

## Setup

**Exactly one secret.** Everything else is committed config.

| Var | Where it lives | How to get it |
|---|---|---|
| `SLACK_BOT_TOKEN` | **Render env only** — never committed. **The only secret.** | [api.slack.com/apps](https://api.slack.com/apps) → Create app → **OAuth & Permissions** → Bot Token Scopes: `chat:write` (and `chat:write.public` if you post to channels the bot is not in) → Install to workspace → copy the **Bot User OAuth Token** (`xoxb-…`) |
| `SLACK_ALERT_CHANNEL` | `config/defaults.env` (committed) | Channel id (`C…`) or `#name`. Invite the bot (`/invite @YourBot`) unless you granted `chat:write.public`. Read by `CHANNEL()` (`alertService.js:41`) |
| `SLACK_ALERT_CHANNEL_FATAL` | `config/defaults.env` (committed) | Optional. Separate channel for `fatal` only; falls back to `SLACK_ALERT_CHANNEL` (`CHANNEL_FOR`, `alertService.js:43-48`) |
| `SLACK_ALERT_CHANNEL_STATUS` | `config/defaults.env` (committed) | Per-run live feed (`services/runFeedService.js`). Inert without `SLACK_BOT_TOKEN`. See **Per-run feed** below. |

**Why the channels are committed and the token is not.** A channel id or
`#name` discloses nothing and is useless without the token, so it belongs
with every other non-secret public id in `config/defaults.env` — which
makes "where do alerts go" a reviewable diff instead of an untracked
dashboard edit that no one can archaeology later. Real env is still loaded
FIRST and dotenv never overrides an already-set var, so a single service
can still be pointed at a different channel from the Render dashboard
without a deploy.

Set the **token** on **both** services (`liquidretail-backend` web *and*
the background worker) — they alert about different things, and the worker
is where the stalled-render sweep and the orphan reaper live, so a token on
the web service alone leaves the most important alerts silent.

Until `SLACK_BOT_TOKEN` is set, alerting stays **silently disabled** (one
console line on the first attempt, then quiet — `alertService.js` `notify`
unconfigured branch). `isConfigured()` is true only when token **and**
`SLACK_ALERT_CHANNEL` are present and `ALERTS_ENABLED` is not `false`
(`alertService.js:503`). The channel ships in `defaults.env`, so the
operator action is the token alone. The worker logs configured-vs-not at
boot with the correct Slack wording (`worker.js:137`) — the older claim
that this line still said "Telegram" was **false** after the cutover
retitle.

### Critical API trap — `ok:false` on HTTP 200

Slack's Web API returns **HTTP 200** with a JSON body
`{ "ok": false, "error": "channel_not_found" }` (or `invalid_auth`,
`not_in_channel`, `is_archived`, …) for logical failures. Checking only
`response.ok` reports success while **nothing was delivered**.

`sendSlack()` always parses the JSON body and requires `ok === true`
(`alertService.js:299-320`). An `ok:false` result is a **failed send**: the
dedupe slot is released and any held suppressed tally is restored, so a bad
channel or token does not silence a key for the whole dedupe window.
Covered by `scripts/verifySlackAlert.js` (revert-proven).

### Rate limits

HTTP **429** with a `Retry-After` header (seconds) is honoured by
**logging** the value and **dropping that delivery** — the alert path
never sleeps on a render thread waiting for Slack. Same failed-send
semantics (slot released, tally kept).

Separately, `ALERT_RATE_LIMIT_MAX` is an **outbound ceiling per process
per minute** (independent of Slack's own limits). See *No folding for
crash alerts* and the tuning table.

## Per-run feed (`SLACK_ALERT_CHANNEL_STATUS`)

Implemented in `services/runFeedService.js`. Hooked at the single choke point
`services/adStage.js` (every stage write) plus `runRenderLoop` start/finish in
`routes/ads.js`. **Not** an alert — a live operator feed of every generation,
titling run, upload, etc.

| Shape | Behaviour |
|---|---|
| Parent message | One per `CampaignRun`. `chat.update`d on `RUN_FEED_PARENT_THROTTLE_MS` (default 10s) with status counts, in-flight stages, elapsed |
| Thread | Full chronological event log, flushed every `RUN_FEED_THREAD_FLUSH_MS` (default 2s), batched |
| Poll ticks | **Excluded** from the thread (`… — polling 20s (7)`). Parent "now:" still shows them |
| Multi-instance | Parent `ts` claimed atomically on `CampaignRun.slackFeed` — only the winner creates the parent |

**Safety (paid-path contract, same family as `adStage` / `alertService`):**

1. Never awaited on a render path — fire-and-forget entry points.
2. Never throws — absolute try/catch on every export.
3. Bounded memory — fixed ring (`RUN_FEED_RING_SIZE`); DROP OLDEST + report `(N events dropped)`.
4. Never sleeps on 429 — logs `Retry-After`, drops that flush.
5. Inert when channel or token unset (one warn per process).
6. All Slack I/O on a detached `unref`'d interval.

Covered by `scripts/verifyRunFeed.js` (offline; revert-proves the never-escape assertion).

| Var | Default | Notes |
|---|---|---|
| `RUN_FEED_ENABLED` | `true` | `false` mutes without unsetting the channel |
| `RUN_FEED_PARENT_THROTTLE_MS` | `10000` | Min ms between parent `chat.update`s |
| `RUN_FEED_THREAD_FLUSH_MS` | `2000` | Detached drain interval |
| `RUN_FEED_RING_SIZE` | `200` | Per-run event buffer capacity |

## `services/crashReporter.js` — the single choke point

Every crash-shaped failure that should leave a durable trail goes through
`crashReporter.report` (awaited only inside the process-exit flush window)
or `crashReporter.reportSync` (fire-and-forget everywhere else — mirrors
`alertService.notifyAsync`).

**Inherits the house contract** from `alertService` (`alertService.js`
header): never throws, never blocks the caller, safe un-awaited from a
render loop / catch / signal handler. A missing token, network failure,
Mongo down, or malformed argument degrades to one `console.warn`. That
matters more than usual: `processAlerts` installs an `unhandledRejection`
handler (`processAlerts.js`), so a rejecting alert path would kill the
process it exists to watch.

### THE ORDERING RULE (load-bearing — do not reorder)

```
1. Generate incidentId (12 hex chars)
2. Normalise err → message + stack (defensive; vendor errors can have non-string .message)
3. Derive diagnostic (explicit, else renderDiagnostic.diagnosticForAd(ad))
4. Derive money tags (predictionId / charged / costUsd)
5. Write IncidentLog row   ← ALWAYS first, NEVER conditional on Slack
6. alerts.notify({ key: 'crash:' + incidentId, … })
7. Patch slackDelivered / slackError onto the row (best-effort)
```

**Why this order exists.** Crash alerts deliberately do **not** fold (see
below). That means `ALERT_RATE_LIMIT_MAX` is the **only silent drop
point** for them. The IncidentLog row must already exist when that limit
fires — otherwise a burst that hits the ceiling loses both the Slack
message *and* the queryable trail. The DB is the system of record; Slack
is notification.

If Mongo is not connected (`readyState !== 1`) the write is skipped, not
failed, and Slack still goes out with
`incident log: skipped (mongo not connected)`. Persist is bounded by
`CRASH_PERSIST_TIMEOUT_MS` (code default **2000**; not in `defaults.env`)
via a race that always clears its timer (a bare `Promise.race` with a
leaked `setTimeout` would keep the event loop alive inside the exit flush
window).

Slack `fields` always carry (when known): `incident`, `kind`, `commit`,
`ad`, `run`, `stage`, `prediction`, `charged`. Identity fields are
inserted **first** because `MAX_FIELDS` (20) silently drops overflow —
appending `incident` last meant the richest alerts lost the only join key
to the DB row.

## `models/IncidentLog.js` — durable system of record

Append-only collection `incidentlogs`. Nothing updates a row after create
except the `slackDelivered` / `slackError` patch. That is deliberate:
**"the alert never arrived" is itself queryable.**

| Group | Fields | Why |
|---|---|---|
| Identity | `incidentId` (unique, 12 hex), `at`, `kind`, `level` | Join Slack ↔ DB; TTL clock on `at` |
| Origin | `role`, `instanceId`, `commit`, `envLabel`, `uptimeSec`, `signal` | Which process, which deploy, how long it had been up |
| Payload | `title`, `message`, `stack`, `diagnostic` | What failed; diagnostic is the renderDiagnostic block **verbatim** |
| Correlation | `adId`, `runId`, `campaignId`, `productId`, `brandId`, `mediaId`, `stage` | Find every incident for one ad/run without grepping Slack |
| Money | `predictionId`, `charged`, `costUsd` | An ad killed after a billable Atlas submit but before `veoPredictionId` is durable is **unrecoverable spend** — these three make that visible |
| In-flight snapshot | `inFlight.{runCount,adsRemaining,runIds,adIds,submittedAdIds}` | Crash/shutdown kinds only |
| Delivery | `slackDelivered` (default false), `slackError` | Rate limit, missing token, or Slack `{ok:false}` all leave `slackDelivered: false` |

**Required fields are only** `incidentId`, `at`, `kind`, `title` (plus
`level`). A boot crash, expansion failure, or worker-loop crash with no Ad
and no Run must still persist.

**TTL:** index on `at` with `expireAfterSeconds` from
`INCIDENT_LOG_TTL_DAYS` (code default **90** days, clamp ≥1; **not** in
`config/defaults.env` — read at module load so a process boot pins the
window). Mongo's TTL monitor is approximate (~60s).

**`KINDS`** (exact strings on `IncidentLog.KINDS` / re-exported from
`crashReporter.KINDS` — do not rename without updating every call site):

```
uncaughtException, unhandledRejection, shutdown,
dispatch-crash, render-crash, render-stage-failed, direct-image-unavailable,
video-generation-failed, video-titling-failed,
static-render-failed, ad-not-found,
regenerate-failed, expansion-product-failed,
worker-loop-crash, reaper-failed,
cost-row-dropped, vision-qc-failed, director-contract-warn, proof-judge-unavailable,
alert-rate-limit-spill
```

The first block through `reaper-failed` are the kinds crashReporter call
sites actually write today. `cost-row-dropped` / `vision-qc-failed` /
`director-contract-warn` / `proof-judge-unavailable` remain reserved
names; those failures still alert via `alerts.notifyAsync` with **folded**
keys (see *What fires*), not yet through IncidentLog. `alert-rate-limit-spill`
is the rate-limit summary key shape in `alertService` (see below).

## No folding for crash alerts

`alertService` still dedupes by `key` for operational alerts
(`ALERT_DEDUPE_WINDOW_MIN`, default 15 min — repeats fold into
`+N more since …`). Crash reports deliberately **do not** weaken that
machinery.

Instead, crashReporter always passes:

```js
key: 'crash:' + incidentId   // unique per incident
```

Dedupe is bypassed **structurally**: two crashes never share a key, so
nothing folds. Other alerts keep their stable keys and their folding
behaviour unchanged. Do **not** special-case "crash" inside
`alertService`'s dedupe logic to achieve this.

### …but one message per CRASH, not per LAYER (`CRASH_AD_WINDOW_MS`)

"No folding" is about distinct failures, and a single failing ad is **one**
failure even though it surfaces at up to three layers:
`renderService`'s per-stage catch → the route's `result.status === 'failed'`
branch → the route's outer catch. With unique keys there is nothing to
collapse them, so a 20-ad vendor blip would have posted **40–60** messages
and buried the signal it exists to raise.

So crashReporter keeps a small in-memory map of `adId → last reported`
(bounded at 500, oldest evicted) and, inside `CRASH_AD_WINDOW_MS`
(default **60000**, code-only):

- **every** report still writes its `IncidentLog` row — nothing goes
  undocumented, which is the other half of the requirement;
- only the **first** report for that ad sends to Slack;
- later rows carry `duplicateOf: '<first incidentId>'` and a
  `slackError` of `suppressed (ad already reported Ns ago as …)`, so
  "why was I not paged for this row" is itself answerable.

Reports with **no `adId`** — process crashes, worker-loop crashes,
expansion failures — are **never** suppressed; they are already distinct
events. Different ads are never suppressed against each other, so
no-folding across ads is preserved.

Useful queries:

| Question | Query |
|---|---|
| Failures a human was actually paged about | `{ duplicateOf: null }` |
| Every layer of one ad's failure | `{ adId: '<id>' }` sorted by `at` |
| Crashes that never reached Slack | `{ slackDelivered: false }` |

`CRASH_AD_WINDOW_MS=0` disables suppression entirely (one message per
layer again).

### Rate-limit spill (the only silent drop left for crashes)

With no folding, `ALERT_RATE_LIMIT_MAX` is the only silent drop point for
crash traffic. Default raised **20 → 60** in **both** places (kept in
sync):

| Source | Value |
|---|---|
| `config/defaults.env` | `ALERT_RATE_LIMIT_MAX=60` |
| code fallback `alertService.js` `RATE_LIMIT_MAX` | `\|\| '60'` |

When the per-minute ceiling is hit, drops are counted. On window rollover
(and via a detached timer so a quiet process still reports), **one** warn
alert fires:

> `N crash alert(s) suppressed by the rate limit`

with a field pointing operators at `IncidentLog` (`kind` / `at` query).
That spill message uses `_bypassRateLimit: true` so it can never be the
message that gets dropped by the counter it exists to report. The
IncidentLog rows for the suppressed incidents already exist (ordering
rule).

## Shutdown / crash process path

`services/processAlerts.js` installs boot, `uncaughtException`,
`unhandledRejection`, `SIGTERM`, and `SIGINT` handlers.

**Sequence inside the flush window** (default
`ALERT_EXIT_FLUSH_MS` **4000**, was 2500 — code default only, **not** in
`defaults.env`; floor 250ms / hard cap 10s unchanged):

1. `persistOrphans` — find rendering ads for this process's runIds, requeue
   them, stamp the runs failed, **return the requeued ad ids** —
   bounded to `PERSIST_SHARE` (**45%**) of the window
2. `crashReporter.report` — IncidentLog then Slack, with those ids in the
   fields — gets the **remaining 55%**, reserved

Persist + IncidentLog + Slack are now **sequential**, not parallel. The
old `Promise.all` meant `persistOrphans` could never get its result into
the alert — that reordering is the fix that lets requeued ad ids reach
Slack.

**Why the window is split rather than shared.** Sequencing them also made
them compete for one budget: with slow Mongo or many orphans, a `find` plus
two `updateMany`s can burn the whole window, and then the durable row and
the Slack message — the entire point of this module — are the first things
cut. Under the old parallel version Slack had the full window to itself, so
an unsplit budget would have been a straight regression. Each phase now has
its own bounded slice.

**Requeue counts are `modifiedCount`, not the find-list length.** The
requeue write re-asserts `status: 'rendering'` (see *Money* below), so an ad
that finished in the race window is deliberately skipped. When the two
disagree the id list is labelled **`requeue candidates`** instead of
`requeued ads`, and `requeued` remains the authoritative count — an alert
must not claim we requeued work we did not touch.

### Money — the requeue write keeps its predicate

`persistOrphans` and `worker.js`'s reaper both changed from a single
`updateMany(predicate)` to `find(predicate)` → `updateMany(byIds)` so the
ids can be reported. **Both re-assert the original predicate on the write**
(`status: 'rendering'`, plus `updatedAt < cutoff` in the reaper). Narrowing
to `_id` alone would open a race the single `updateMany` never had: an ad
that legitimately finished between the find and the update would be flipped
back to `queued` and re-rendered later — on the video path a second billable
Omni submit (~$1) for work that already succeeded.

### What the shutdown alert names

When work is in flight the title stays
`<role> shutting down with N ad(s) in flight` (error); clean shutdown is
info-level (muted at default `ALERT_MIN_LEVEL=warn`). Fields / detail now
include:

- **Per-ad lines** from `inFlight.snapshot().adLines`:
  `adId stage=… age=Ns[ SUBMITTED/charged]`
- **Charged-submit count** — `charged in flight: N ad(s) — unrecoverable spend`
  when any ad had a billable Atlas POST already returned
  (`inFlight.markSubmitted` — see *Charge points* below)
- **Requeued ad ids** (from persistOrphans)
- **commit** (first 8 of `RENDER_GIT_COMMIT`, attached by crashReporter)
- **uptime**
- **`likely cause: deploy or autoscale scale-in`** on SIGTERM

**SIGTERM cannot distinguish a deploy from an autoscale scale-in.** The
process receives the same signal either way. The alert states both rather
than guessing one — guessing "deploy" taught operators to ignore
scale-in kills.

### Exit semantics are untouchable

Attaching a listener suppresses Node's default disposition, so each
handler re-establishes death: crashes `exit(1)` from a `finally`
(unconditional). SIGTERM/SIGINT arm a **1s hard `process.exit(128+signo)`
timer**, then remove the listener and **re-raise** the signal so
puppeteer/remotion cleanup still runs — re-raise alone is not enough
because puppeteer's own handler closes Chrome without exiting
(`processAlerts.js` signal `finally` block). A harness pins this.

## `services/inFlight.js` — run-level and ad-level

Still **in-memory only**, process-local, readable from a signal handler
with **zero DB reads** — those two properties are deliberate and
comment-documented.

| API | Layer | Purpose |
|---|---|---|
| `track` / `progress` / `untrack` | run | How many ads a CampaignRun still owes (unchanged) |
| `trackAd` / `adStage` / `markSubmitted` / `untrackAd` | ad | Which ads, live stage, whether a billable submit already returned |
| `snapshot()` | both | Adds `adIds`, `submittedAdIds`, `adLines`, `oldestAdAgeMs` |

`services/adStage.js` mirrors stage text into `inFlight.adStage` so the
shutdown path sees the same live stage the activity board does.
Ad map hard-capped at 500 (same reasoning as
`alertService.MAX_TRACKED_KEYS`); oldest-first eviction.

### Charge points — where `markSubmitted` is called, and why there

`markSubmitted` is money-critical: it is what lets the shutdown alert
separate "lost work that cost nothing" from "lost work we already paid
for". It is called from **both** billable submit paths — video alone would
have understated spend in the commoner case, since `meta_static` is three
billable submits per product:

| Path | Site | Placement rationale |
|---|---|---|
| Video | `atlasVideoService.js`, immediately **before** the `Ad.updateOne` that stamps `veoPredictionId` | The money is already spent. If that write fails the id is never persisted — the "orphan would be unreconcilable" case its own catch warns about — so marking first means a SIGTERM in that window still reports a **charged** loss |
| Static | `atlasImageService.js`, right after `const id = submit.data.data.id`, before the poll loop | The submit returned an id, so the task is billable from there; the refusal branch above throws `charged: false` precisely because nothing was created |

`markSubmitted` **self-registers** an ad that was never `trackAd`'d rather
than no-op'ing. Money telemetry must not depend on a caller having
remembered to track first — the regenerate path bills ~$1 per video and
never enters the render pool, so a no-op there would have reported a charged
loss as free. `adRegenerateService` additionally `trackAd`s on entry and
`untrackAd`s in a `finally` (covering the cancelled-operator early return),
so those entries do not linger and inflate a later shutdown alert.

## What fires

### Process lifecycle (via `crashReporter`)

| Alert / kind | Level | Source | Meaning |
|---|---|---|---|
| `<role> started` | info | `processAlerts` | Process booted. **Muted at default `ALERT_MIN_LEVEL=warn`**. Still carries commit; crash/shutdown also carry commit now |
| `uncaughtException` — `<role> crashed — uncaughtException` | fatal | `processAlerts` → `crashReporter` | Stack + per-ad in-flight + charged count + commit + uptime |
| `unhandledRejection` — same shape | fatal | `processAlerts` → `crashReporter` | Same. On Node 20 this is fatal by default; before processAlerts there were **no** handlers at all |
| `shutdown` — `<role> shutting down with N ad(s) in flight` | error (or info if clean) | `processAlerts` → `crashReporter` | SIGTERM/SIGINT. Names ads, stages, charged submits, requeued ids, commit, uptime. States deploy **or** autoscale scale-in |

### Render / generation failures (via `crashReporter.reportSync`)

| kind | Level | Source | Meaning |
|---|---|---|---|
| `dispatch-crash` | error | `routes/ads.js` pool dispatch `.catch` | `renderOne` rejected outside its own try/catch |
| `ad-not-found` | error | `routes/ads.js` `renderOneInner` | Claimed ad id missing from Mongo |
| `video-generation-failed` | error | `routes/ads.js` veo path | Atlas prediction failed/timed out — diagnostic + predictionId/charged, not title-only |
| `video-titling-failed` | error | `routes/ads.js` after master | Master kept (paid); titling failed — raw master is **not** counted success when chrome was configured |
| `static-render-failed` | error | `routes/ads.js` static path | `renderCreative` returned failed; money tags on `renderError` |
| `render-crash` | error | `routes/ads.js` outer catch | Unexpected throw mid-render; carries predictionId/charged from err / err.cause |
| `render-stage-failed` | error | `services/renderService.js` | derive / render / upload / persist stage failed |
| `direct-image-unavailable` | error | `services/renderService.js` | Direct-image path unavailable and not routed to HTML |
| `regenerate-failed` | error | `services/adRegenerateService.js` | Operator regenerate path threw |
| `expansion-product-failed` | error | `services/campaignAdsGenerationService.js` | Concept-driven expansion failed for one product |
| `worker-loop-crash` | error | `worker.js` | A detect-queue worker loop rejected |
| `reaper-failed` | warn | `worker.js` | Initial or periodic `reapOrphans` threw |

### Operational (via `alertService` directly — still folded by key)

| Alert | Level | Source | Meaning |
|---|---|---|---|
| `Dropped work reclaimed — N ad(s), M run(s)` | error | reaper, `worker.js` | Work was dropped and reset. Detail/fields now name **ad ids and run ids** (counts alone were not enough). Those ads sit in `queued` until someone re-runs the campaign |
| `N ad(s) stuck rendering` | error | watchdog | Wedged past `ALERT_RENDERING_STALE_MIN`, deliberately **before** the 15-min reap so the evidence is intact |
| `N campaign run(s) not progressing` | error | watchdog | `running` past `ALERT_RUN_STALE_MIN` |
| `Detect queue backing up — N queued` | warn | watchdog | The worker's own queue is growing → worker wedged |
| `Spend $X in the last hour` | warn | watchdog | Trailing-hour `CostLog` total over `ALERT_HOURLY_SPEND_USD` |
| `Campaign run finished with N failed ad(s)` | warn/error | `runRenderLoop` | Escalates to error when **every** ad failed |
| `Campaign run crashed …` | error | `routes/ads.js` | The loop itself threw during prep/render or queued drain |
| `Cost row dropped — CostLog schema drift` | error | `costTracker` | ValidationError on CostLog insert (folded key `costlog-validation`) |
| `Director payload did not satisfy the round contract` | warn | `aiCreativeDirectorService` | Proceeding with concepts despite contract warnings (folded key `director:contract-warn`) |
| `Static ad failed vision QC after one regeneration` | error | `adVisionQcService` | Terminal QC failure (folded key `vision-qc:failed-after-retry`) |
| `Social-proof judge unavailable` | error/fatal | `quoteSnippetService` | Cannot screen comments; no ad may render social proof until this clears |
| `N crash alert(s) suppressed by the rate limit` | warn | `alertService` spill | Rate-limit window rolled over with drops; points at IncidentLog |

### Deliberately not alerted — intended outcomes, not crashes

Adding these would be pure noise and would train people to ignore the
channel. Same reasoning as the existing note that a nonzero count of
`queued` Ads is not a fault (`expandWizardJob` routinely queues more than
one run drains):

| Outcome | Where | Why silent |
|---|---|---|
| Operator **cancel** | `routes/ads.js` cancel path | Human stopped the run; unclaimed tail is **archived** (not re-queued) so Stop does not re-bill on the next Generate |
| Video **skip** when provider is off / unconfigured | `routes/ads.js` `veoResult.skipped` | Terminal + reason on the Ad; next Generate would re-bill a provider that is still off — operator must fix config and regen deliberately |
| Static **skipped** (e.g. template validation) | `routes/ads.js` `result.status === 'skipped'` | Terminal failed + reason; board/reaper see a finished asset, not an in-flight one |
| **`no-chrome` titling skip** | `routes/ads.js` after master | Raw master **is** the deliverable when no brand chrome is configured — counted success, not a failure |

**Also deliberately not alerted:** a nonzero count of `queued` Ads as
inventory (carried as *context* on the alerts above, not its own page).

## Failure payload — lockstep with render-activity

`GET /api/ads/render-activity` and every crash path that has an Ad share
**one builder**: `services/renderDiagnostic.js`.

| Export | Role |
|---|---|
| `buildAdRow(ad, { run, userById })` | Row object (asset id, status/stage, kind/format/aspect, pipeline/model, predictionId, timings, run/product/media, error, asset URL, …) |
| `buildAdDiagnostic(row)` | The pre-formatted multi-line `diagnostic` string |
| `diagnosticForAd(ad, opts)` | Convenience: `buildAdDiagnostic(buildAdRow(ad, opts))` |

The route imports `buildAdRow` / `buildAdDiagnostic` (`routes/ads.js`) —
there is **no** longer an inline copy. Output is pinned
byte-identical by `scripts/verifyRenderDiagnostic.js` (frozen
pre-extraction golden). `buildAdRow` tolerates a lean/partial Ad (crash
paths often hold only an id + a few fields); every field access is
null-safe.

**Stale claim corrected:** older docs said this block lived at
`routes/ads.js:1944-1958` (and `alertService.js`'s header once pointed at
`~1662-1676`). Both line numbers were wrong even before the extraction;
the builder is now the exported module. The "one builder, one envelope"
claim is **true in code** — it previously could not be, because the
builder was inline in the route and not exported for alerts to reuse.

`alertService` does **not** own a second schema. Callers pass:

- `fields` — short key→value lines under the title (free-form, capped at
  `MAX_FIELDS` = 20)
- `detail` — free text dropped into a fenced code block

When a caller already has the activity-board `diagnostic` string, pass it
as `detail`; `buildMessage()` uses it **verbatim** (only size-clipped via
`safeEsc`, never re-parsed). crashReporter builds that string via
`renderDiagnostic` when given an `ad`.

## Tuning

Non-secret, overridable per-service. Values in `config/defaults.env` are
the committed defaults; code fallbacks apply when the var is unset.
**Precedence:** process env (Render dashboard / local `.env`) wins —
dotenv never overrides an already-set var.

| Var | Default | Where | Notes |
|---|---|---|---|
| `ALERTS_ENABLED` | `true` | defaults.env + code | `false` mutes without unsetting the token |
| `ALERT_MIN_LEVEL` | `warn` | defaults.env + code | `info` \| `warn` \| `error` \| `fatal` |
| `ALERT_DEDUPE_WINDOW_MIN` | `15` | defaults.env + code | Per-key; repeats folded into next delivery. Crash keys never share, so this does not fold crashes |
| `ALERT_RATE_LIMIT_MAX` | **`60`** (was 20) | defaults.env **and** code fallback both `60` | Hard ceiling per minute; spill alert on rollover |
| `ALERT_WATCHDOG_INTERVAL_MIN` | `5` | defaults.env | Health-sweep cadence |
| `ALERT_RENDERING_STALE_MIN` | `12` | defaults.env | **Keep below `REAP_STALE_MIN` (15)** |
| `ALERT_RUN_STALE_MIN` | `45` | defaults.env | A 20-ad video batch legitimately runs a long time |
| `ALERT_DETECT_BACKLOG_COUNT` / `_MIN` | `25` / `20` | defaults.env | Both must trip |
| `ALERT_HOURLY_SPEND_USD` | `25` | defaults.env | See spend note below |
| `ALERT_EXIT_FLUSH_MS` | **`4000`** (was 2500) | **code only** (not in defaults.env) | Bounded window for sequential persist + IncidentLog + Slack before exit; floor 250 / cap 10000 |
| `ALERT_SEND_TIMEOUT_MS` | `8000` | code only | Abort a hung Slack POST |
| `CRASH_PERSIST_TIMEOUT_MS` | `2000` | code only | Bound IncidentLog create so a hung Mongo cannot stall Slack / exit |
| `INCIDENT_LOG_TTL_DAYS` | `90` | code only | TTL on `IncidentLog.at`; clamp ≥1 day |
| `CRASH_AD_WINDOW_MS` | `60000` | code only | One Slack message per ad per window; rows still written for every layer (`duplicateOf` set). `0` disables |

### Spend note

Video dominates cost. The live default model is Omni
(`google/gemini-omni-flash/image-to-video-developer`), which natively
supports **16:9 and 9:16 only**. **An older claim that 4:5 (and 1:1)
force-route to Grok Imagine was false** — and is still wrong in some
header comments (`backlogWatchdog.js:12-15`, `defaults.env:233-235`).
What the code actually does (`atlasVideoService.js:508-522`,
`:579-597`):

- Portrait (including **4:5**) → Omni at **9:16**, then face-anchored crop
  (`basePlateCropService` / compositor) to the platform canvas.
- Landscape → Omni at **16:9**, same crop path.
- Square (**1:1**) → Omni at **9:16** unless `SQUARE_VIA_OMNI_CROP=false`.
- `ASPECT_FALLBACK_MODEL` (Grok Imagine 1.5) is only the **square opt-out**
  and explicitly selected non-Omni models — not the 4:5 path.

Grok's ledger rate in `MODEL_CAPS` is still `$0.50/s` and flagged
**UNVERIFIED** (`atlasVideoService.js:324-328`) — a conservative upper
bound when that model *is* used (~$4.00 for an 8s clip vs ~$1.00-class
Omni). The alert threshold reads the ledger, so treat the dollar figure
as "what we recorded", not "what we were charged".

## Guarantees

- **Never throws.** Every export on `alertService` and `crashReporter` is
  safe to call un-awaited from a catch block, a `.finally()`, or a signal
  handler. A missing token, a network failure, an HTTP error, or Slack
  `{ok:false}` degrades to one `console.warn`. This matters more than
  usual: with an `unhandledRejection` handler installed, an alerting path
  that rejected would kill the process it exists to watch.
- **IncidentLog before Slack.** The ordering rule on crashReporter —
  durable row first, notification second, never conditional. Rate-limit
  spill and unconfigured deploys still leave a queryable trail when Mongo
  was up.
- **No folding for crashes; folding preserved for everything else.**
  Structural (`key: 'crash:' + incidentId`), not a special case inside
  dedupe.
- **Exit semantics are restored deliberately.** See *Exit semantics are
  untouchable* above.
- **Bounded memory.** Dedupe keys embed error-message fragments, so their
  cardinality is unbounded; `pruneDedupeState` evicts past-window entries
  and caps the maps at 500. `inFlight` ad map same cap.
- **The token never reaches a log or an IncidentLog row.** It appears
  only in the `Authorization` header. `redact()` scrubs the configured
  token plus any `xoxb-`/`xoxp-` (etc.) shape before printing **and**
  before crashReporter persists title/message/stack/diagnostic.
- **Slack-safe payloads.** `&`, `<`, `>` are entity-encoded for mrkdwn
  *before* clipping, so the size budget is real, and only the text *inside*
  a fenced code block is ever truncated — a blind clip of the assembled
  message would cut through ` ``` ` fences and emit a broken payload.
- **Inert when unconfigured.** Missing token or channel → `notify()`
  returns false, does not throw, does not call Slack, and warns at most
  once per process. Channel ships in `defaults.env`, so the practical
  gate is the token.

## Offline verify

```bash
node scripts/verifySlackAlert.js
node scripts/verifyCrashReporter.js
node scripts/verifyProcessAlerts.js
node scripts/verifyRenderDiagnostic.js
```

| Script | Pins |
|---|---|
| `verifySlackAlert.js` | Unconfigured silence, `ok:false` on 200 as failed send (dedupe + tally), 429 non-blocking, dedupe fold, rate limit + spill, dual-shape wrappers, `xoxb-` redaction, balanced fences |
| `verifyCrashReporter.js` | Ordering rule (IncidentLog before Slack), unique `crash:` keys, money-tag derivation, persist timeout bound, never-throws / reportSync |
| `verifyProcessAlerts.js` | Sequential persist-then-report, shutdown payload richness (ads / charged / likely cause), exit semantics (finally exit, 1s hard timer, re-raise) |
| `verifyRenderDiagnostic.js` | Byte-identity of `buildAdRow` / `buildAdDiagnostic` vs the frozen pre-extraction builder; lean-Ad null-safety |

All four are **offline** (no DB, no network, no API key). The broader
suite is 48 `scripts/verify*.js` scripts; re-run with
`for f in scripts/verify*.js; do node "$f" || echo "FAIL $f"; done`.
**None of the crash-alerting paths above have been proven in production
yet** — offline green only.

## Known gap this does not close

Alerting tells you work was dropped; it does not resume it. The underlying
fix is to make ad rendering a **durable worker-drained queue** instead of an
in-process loop on an autoscaling web service — i.e. let `worker.js` claim
`Ad{status:'queued'}` the way it already claims `DetectRun`, so an instance
replacement costs one ad instead of a whole batch. That is a real change to
a money-spending path (claim/lease semantics, no double-submit of a billable
POST) and is deliberately not bundled here.

Interim mitigations, cheapest first:

1. **Run video batches smaller.** `MAX_CREATIVES_PER_RUN=20` at concurrent
   Omni still leaves a long exposure window on the web process. Lower it
   and each loss is smaller.
2. **Pin the web service to one instance** (autoscaling `max: 1`) so
   scale-in stops being a cause. Deploys still are.
3. Deploy when nothing is rendering — now observable, because SIGTERM alerts
   name the ads, stages, charged submits, and commit — not just a count.
