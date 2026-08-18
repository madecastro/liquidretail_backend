# Operational alerting → Slack

Push alerts for crashes, dropped work, stalled runs, and spend spikes.
Implemented in `services/alertService.js` (transport + dedupe),
`services/processAlerts.js` (crash / restart / shutdown),
`services/backlogWatchdog.js` (periodic health sweep), and
`services/inFlight.js` (what a shutdown is about to destroy).

Transport is **Slack via bot token** (`chat.postMessage`). Telegram is
removed; there is no live fallback. Verified live (prod `13cf679`):
worker boot log reads `🔔 alerts: Slack configured`
(`worker.js:120`).

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

**The alerts below make each of those moments visible. They do not fix the
architecture** — see *Known gap* at the end.

## Setup

**Exactly one secret.** Everything else is committed config.

| Var | Where it lives | How to get it |
|---|---|---|
| `SLACK_BOT_TOKEN` | **Render env only** — never committed. **The only secret.** | [api.slack.com/apps](https://api.slack.com/apps) → Create app → **OAuth & Permissions** → Bot Token Scopes: `chat:write` (and `chat:write.public` if you post to channels the bot is not in) → Install to workspace → copy the **Bot User OAuth Token** (`xoxb-…`) |
| `SLACK_ALERT_CHANNEL` | `config/defaults.env` (committed) | Channel id (`C…`) or `#name`. Invite the bot (`/invite @YourBot`) unless you granted `chat:write.public`. Read by `CHANNEL()` (`alertService.js:41`) |
| `SLACK_ALERT_CHANNEL_FATAL` | `config/defaults.env` (committed) | Optional. Separate channel for `fatal` only; falls back to `SLACK_ALERT_CHANNEL` (`CHANNEL_FOR`, `alertService.js:43-48`) |
| `SLACK_ALERT_CHANNEL_STATUS` | `config/defaults.env` (committed) | Per-run live feed (`services/runFeedService.js`). One parent message per `CampaignRun` (`chat.update` on a throttle) + threaded chronological event log (batched). Inert without `SLACK_BOT_TOKEN`. See **Per-run feed** below. |

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
console line on the first attempt, then quiet — `alertService.js:310-316`).
`isConfigured()` is true only when token **and** `SLACK_ALERT_CHANNEL` are
present and `ALERTS_ENABLED` is not `false` (`alertService.js:378`). The
channel ships in `defaults.env`, so the operator action is the token alone.
The worker logs configured-vs-not at boot with the correct Slack wording
(`worker.js:120`) — the older claim that this line still said "Telegram"
was **false** after the cutover retitle.

### Critical API trap — `ok:false` on HTTP 200

Slack's Web API returns **HTTP 200** with a JSON body
`{ "ok": false, "error": "channel_not_found" }` (or `invalid_auth`,
`not_in_channel`, `is_archived`, …) for logical failures. Checking only
`response.ok` reports success while **nothing was delivered**.

`sendSlack()` always parses the JSON body and requires `ok === true`
(`alertService.js:220-241`). An `ok:false` result is a **failed send**: the
dedupe slot is released and any held suppressed tally is restored, so a bad
channel or token does not silence a key for the whole dedupe window
(`notify` at `alertService.js:347-354`). Covered by
`scripts/verifySlackAlert.js` (revert-proven).

### Rate limits

HTTP **429** with a `Retry-After` header (seconds) is honoured by
**logging** the value and **dropping that delivery** — the alert path
never sleeps on a render thread waiting for Slack (`alertService.js:211-218`).
Same failed-send semantics (slot released, tally kept).

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

## What fires

| Alert | Level | Source | Meaning |
|---|---|---|---|
| `<role> started` | info | `processAlerts` | Process booted. **Muted at the default `ALERT_MIN_LEVEL=warn`** — set `info` to watch instance churn live |
| `<role> crashed — uncaughtException` | fatal | `processAlerts` | Stack + what was in flight |
| `<role> crashed — unhandledRejection` | fatal | `processAlerts` | Same. On Node 20 this is fatal by default, and before this work there were **no** handlers at all |
| `<role> shutting down with N ad(s) in flight` | error | `processAlerts` | SIGTERM during a batch — those N ads are about to be orphaned. The single most useful alert here |
| `Dropped work reclaimed — N ad(s), M run(s)` | error | reaper, `worker.js` | Work was dropped and reset. **Those ads now sit in `queued` until someone re-runs the campaign** |
| `N ad(s) stuck rendering` | error | watchdog | Wedged past `ALERT_RENDERING_STALE_MIN`, deliberately **before** the 15-min reap so the evidence is intact |
| `N campaign run(s) not progressing` | error | watchdog | `running` past `ALERT_RUN_STALE_MIN` |
| `Detect queue backing up — N queued` | warn | watchdog | The worker's own queue is growing → worker wedged |
| `Spend $X in the last hour` | warn | watchdog | Trailing-hour `CostLog` total over `ALERT_HOURLY_SPEND_USD` |
| `Video generation failed` | error | `routes/ads.js` | Atlas prediction failed or timed out |
| `Campaign run finished with N failed ad(s)` | warn/error | `runRenderLoop` | Escalates to error when **every** ad failed |
| `Campaign run crashed …` | error | `routes/ads.js` | The loop itself threw |

**Deliberately not alerted:** a nonzero count of `queued` Ads.
`expandWizardJob` routinely queues more creatives than
`MAX_CREATIVES_PER_RUN` (1000, effectively uncapped) drains in one run, so that count is normal
inventory, not a fault. It is carried as *context* on the alerts above.

## Failure payload — lockstep with render-activity

`GET /api/ads/render-activity` builds a pre-formatted `diagnostic` block
(`routes/ads.js:1944-1958`) with the fields an operator needs without
SSH: asset id, status/stage, kind/format/aspect, pipeline/model,
predictionId, timings, run/product/media, error, asset URL. Per-ad
`stage` / `stageAgeSec` come from `Ad.renderStage` / `renderStageAt`
written by fire-and-forget `services/adStage.js` (see `docs/PROGRESS.md`).

`alertService` does **not** own a second schema. Callers pass:

- `fields` — short key→value lines under the title (free-form, capped)
- `detail` — free text dropped into a fenced code block

When a caller already has the activity-board `diagnostic` string, pass it
as `detail`; `buildMessage()` uses it **verbatim** (only size-clipped via
`safeEsc`, never re-parsed). That is how the two stay from drifting: one
builder (render-activity), one envelope (alertService).

## Tuning

Non-secret, all in `config/defaults.env`, all overridable per-service:

| Var | Default | Notes |
|---|---|---|
| `ALERTS_ENABLED` | `true` | `false` mutes without unsetting the token |
| `ALERT_MIN_LEVEL` | `warn` | `info` \| `warn` \| `error` \| `fatal` |
| `ALERT_DEDUPE_WINDOW_MIN` | `15` | Per-key; repeats are counted and folded into the next delivery (`+7 more since 18:51Z`) |
| `ALERT_RATE_LIMIT_MAX` | `20` | Hard ceiling per minute, independent of dedupe |
| `ALERT_WATCHDOG_INTERVAL_MIN` | `5` | Health-sweep cadence |
| `ALERT_RENDERING_STALE_MIN` | `12` | **Keep below `REAP_STALE_MIN` (15)** |
| `ALERT_RUN_STALE_MIN` | `45` | AGE noise filter only — a 20-ad video batch legitimately runs a long time. Also the effective trigger for the filter's `preparing` arm (see note) |
| `ALERT_RUN_SILENCE_MIN` | `12` | SILENCE trigger. **Keep strictly below `REAP_STALE_MIN` (15)** — at/above 15 the reaper empties the set |
| `ALERT_DETECT_BACKLOG_COUNT` / `_MIN` | `25` / `20` | Both must trip |
| `ALERT_HOURLY_SPEND_USD` | `25` | See spend note below |
| `ALERT_EXIT_FLUSH_MS` | `2500` | Bounded window to deliver one message before exit (code default; not in `defaults.env`) |
| `ALERT_SEND_TIMEOUT_MS` | `8000` | Abort a hung Slack POST (code default; not in `defaults.env`) |

### The two reaper windows, and what they mean for these thresholds

There are **two** staleness windows, not one, and only the first is the one
these alert thresholds are tuned against:

| Window | Default | Clock | Governs |
|---|---|---|---|
| `REAP_STALE_MIN` | `15` | `updatedAt` (**silence**) | **Claimed** work — `Ad` in `rendering`, `CampaignRun` in `running`. Both heartbeat, so 15m of silence really is a dead holder. Also bounds the concurrency gate's `running` arm, which uses the same field and bound as the reaper so that "gate-visible" and "the reaper would spare it" are one statement. |
| `PREPARE_STALE_MIN` | `30` | `createdAt`/`startedAt` (**mint age**) | The **preparing** lifecycle — mint → the `preparing`→`running` flip. Mint age is the only available clock because a preparing run makes no writes to its own row. Raised from 15 on 2026-08-18: the healthy runtime (Director + Judge) is **~18-20 min**, so 15 was failing expansions that were merely finishing. Non-secret, so it lives in `config/defaults.env`. |

The clock column is load-bearing. Keying the gate's `running` arm on mint age
instead of silence was a confirmed double-bill P0 (a run that flipped at t=18
was invisible to the gate the moment it started submitting billable work, so a
duplicate was admitted silently). Note the consequence for alerting: because
`CampaignRun` has **no periodic heartbeat of its own** — the 60s beat in
`routes/ads.js` refreshes the `Ad` row, not the run — a run's `updatedAt` only
moves when an ad in the wave settles. A wave where every concurrent render
stalls near `AI_DIRECT_IMAGE_TIMEOUT_MS` (900s, ≈ `REAP_STALE_MIN`) can
therefore look silent while alive. That is a pre-existing reaper liveness gap,
not something the window change introduced.

`ALERT_RENDERING_STALE_MIN` and `ALERT_RUN_SILENCE_MIN` must stay strictly below
**`REAP_STALE_MIN`** — unchanged by the preparing bump, which touched neither
`Ad` reaping nor `running`-run reaping.

**No alert arm keys on preparing age**, so nothing here was re-tuned.
`buildStalledRunFilter` (`services/backlogWatchdog.js`) does *include*
`status:'preparing'` in its `$in`, but its triggers are `ALERT_RUN_STALE_MIN`
(45, on `startedAt`) and `ALERT_RUN_SILENCE_MIN` (12, on `updatedAt`) — and for a
preparing row `updatedAt === startedAt`, so the binding constraint is the **45m
age**. That sits above the preparing reaper at either 15 or 30, meaning the
worker stamps such a row `failed` before the alert's age test can ever pass.
**Known open, pre-existing, and deliberately not changed here:** that arm is
therefore close to a structurally empty set, the same failure mode the
`ALERT_RUN_SILENCE_MIN < REAP_STALE_MIN` rule exists to prevent. It was already
true at 15 and is no more true at 30, and `ALERT_RUN_STALE_MIN`'s own comment
records it as tuned against video batch duration — not against a reaper window —
so retuning it is a separate, deliberate decision with its own measurement.

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

- **Never throws.** Every export is safe to call un-awaited from a catch
  block, a `.finally()`, or a signal handler. A missing token, a network
  failure, an HTTP error, or Slack `{ok:false}` degrades to one
  `console.warn`. This matters more than usual: with an
  `unhandledRejection` handler installed, an alerting path that rejected
  would kill the process it exists to watch.
- **Exit semantics are restored deliberately.** Attaching a listener
  suppresses Node's default disposition, so each handler re-establishes
  death: crashes `exit(1)` from a `finally` (unconditional, even if the
  handler itself throws). SIGTERM/SIGINT arm a **1s hard `process.exit(128+signo)`
  timer**, then remove the listener and **re-raise** the signal so
  puppeteer/remotion cleanup still runs — re-raise alone is not enough
  because puppeteer's own handler closes Chrome without exiting
  (`processAlerts.js:205-224`).
- **Bounded memory.** Dedupe keys embed error-message fragments, so their
  cardinality is unbounded; `pruneDedupeState` evicts past-window entries and
  caps the maps at 500.
- **The token never reaches a log.** It appears only in the `Authorization`
  header. `redact()` scrubs the configured token plus any `xoxb-`/`xoxp-`
  (etc.) shape before printing.
- **Slack-safe payloads.** `&`, `<`, `>` are entity-encoded for mrkdwn
  *before* clipping, so the size budget is real, and only the text *inside*
  a fenced code block is ever truncated — a blind clip of the assembled
  message would cut through ` ``` ` fences and emit a broken payload.
- **Inert when unconfigured.** Missing token or channel → `notify()`
  returns false, does not throw, does not call Slack, and warns at most
  once per process (`alertService.js:307-316`). Channel ships in
  `defaults.env`, so the practical gate is the token.

## Offline verify

```bash
node scripts/verifySlackAlert.js
```

Covers: unconfigured silence, `ok:false` on 200 as failed send (dedupe +
tally), 429 non-blocking, dedupe fold, rate limit, `xoxb-` redaction,
balanced fences at the size limit.

## Known gap this does not close

Alerting tells you work was dropped; it does not resume it. The underlying
fix is to make ad rendering a **durable worker-drained queue** instead of an
in-process loop on an autoscaling web service — i.e. let `worker.js` claim
`Ad{status:'queued'}` the way it already claims `DetectRun`, so an instance
replacement costs one ad instead of a whole batch. That is a real change to
a money-spending path (claim/lease semantics, no double-submit of a billable
POST) and is deliberately not bundled here.

Interim mitigations, cheapest first:

1. **Watch request size, not a run cap.** `MAX_CREATIVES_PER_RUN` is 1000
   (effectively removed, owner 2026-08-18), so batch size is governed by the
   request itself; `ALERT_HOURLY_SPEND_USD=25` is the operator's tripwire for
   oversized runs. Concurrent Omni still leaves a long exposure window on the
   web process — request smaller batches and each loss is smaller.
2. **Pin the web service to one instance** (autoscaling `max: 1`) so
   scale-in stops being a cause. Deploys still are.
3. Deploy when nothing is rendering — now observable, because SIGTERM alerts
   name the count.
