# Operational alerting → Telegram

Push alerts for crashes, dropped work, stalled runs, and spend spikes.
Implemented in `services/alertService.js` (transport + dedupe),
`services/processAlerts.js` (crash / restart / shutdown),
`services/backlogWatchdog.js` (periodic health sweep), and
`services/inFlight.js` (what a shutdown is about to destroy).

## Why this exists — the failure it was built to expose

Ad rendering, **including every paid video generation**, does not run on a
durable queue. `POST /api/ads/generate` and `POST /api/ads/runs` flush a
`202 Accepted` and then run `runRenderLoop` in a `setImmediate` **inside the
web service process** (`routes/ads.js`). Video ads run at
`VEO_CONCURRENCY=1`, roughly a minute per ad, so a 20-ad batch occupies that
process for 25–35 minutes.

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

Two secrets, set in **Render env only** (never committed; `.env.example`
lists the names, `config/defaults.env` holds only non-secret tuning):

| Var | How to get it |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Message [@BotFather](https://t.me/BotFather) → `/newbot` → it replies with the token |
| `TELEGRAM_CHAT_ID` | Send the new bot any message, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` and read `result[0].message.chat.id`. For a group: add the bot to the group, post once, same call — **group ids are negative** |

Set both on **both** services (`liquidretail_backend` web *and* worker) —
they alert about different things. Until both are present alerting stays
silently disabled; the worker logs which state it is in at boot:

```
🔔 alerts: Telegram configured; watchdog every 5m
```

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
`MAX_CREATIVES_PER_RUN` (20) drains in one run, so that count is normal
inventory, not a fault. It is carried as *context* on the alerts above.

## Tuning

Non-secret, all in `config/defaults.env`, all overridable per-service:

| Var | Default | Notes |
|---|---|---|
| `ALERTS_ENABLED` | `true` | `false` mutes without unsetting the secrets |
| `ALERT_MIN_LEVEL` | `warn` | `info` \| `warn` \| `error` \| `fatal` |
| `ALERT_DEDUPE_WINDOW_MIN` | `15` | Per-key; repeats are counted and folded into the next delivery (`+7 more since 18:51Z`) |
| `ALERT_RATE_LIMIT_MAX` | `20` | Hard ceiling per minute, independent of dedupe |
| `ALERT_WATCHDOG_INTERVAL_MIN` | `5` | Health-sweep cadence |
| `ALERT_RENDERING_STALE_MIN` | `12` | **Keep below `REAP_STALE_MIN` (15)** |
| `ALERT_RUN_STALE_MIN` | `45` | A 20-ad video batch legitimately runs 25–35 min |
| `ALERT_DETECT_BACKLOG_COUNT` / `_MIN` | `25` / `20` | Both must trip |
| `ALERT_HOURLY_SPEND_USD` | `25` | See spend note below |
| `ALERT_EXIT_FLUSH_MS` | `2500` | Bounded window to deliver one message before exit |

### Spend note

Video dominates cost, and one routing decision dominates video: the Omni
default (`google/gemini-omni-flash/image-to-video-developer`) supports
**16:9 and 9:16 only**. A 4:5 Feed canvas therefore falls back to
`xai/grok-imagine-video-v1.5/image-to-video`, which the ledger rates at
`$0.50/s` — about **$4.00 for an 8s clip vs ~$1.00** on the default, and it
also remaps 4:5 → 3:4. A 20-ad Feed batch is ~$80 of estimated spend.

That `$0.50/s` figure is flagged **UNVERIFIED** in `MODEL_CAPS`
(`services/atlasVideoService.js`) — carried as a conservative upper bound
until a real invoice confirms it. The alert threshold is set against the
ledger, so treat the dollar figure as "what we recorded", not "what we were
charged".

## Guarantees

- **Never throws.** Every export is safe to call un-awaited from a catch
  block, a `.finally()`, or a signal handler. A missing token, a network
  failure, or a Telegram 4xx degrades to one `console.warn`. This matters
  more than usual now: with an `unhandledRejection` handler installed, an
  alerting path that rejected would kill the process it exists to watch.
- **Exit semantics are unchanged.** Attaching a listener suppresses Node's
  default disposition, so each handler restores it: crashes `exit(1)` from a
  `finally` (unconditional, even if the handler itself throws), and
  SIGTERM/SIGINT **re-raise** after removing the listener rather than calling
  `process.exit()` — which preserves the 128+signo status *and* still runs
  any cleanup handler puppeteer/remotion registered for that signal.
- **Bounded memory.** Dedupe keys embed error-message fragments, so their
  cardinality is unbounded; `pruneDedupeState` evicts past-window entries and
  caps the maps at 500.
- **The token never reaches a log.** It appears only in the request URL. A
  malformed-URL `TypeError` quotes that URL, so everything printed goes
  through `redact()` first.
- **Telegram-safe payloads.** Escaping is applied *before* clipping, so the
  4096 limit is a real character budget, and only the text *inside* a tag is
  ever truncated — a blind clip of the assembled message would cut through
  `<pre>…</pre>` and Telegram would reject the whole alert.

## Known gap this does not close

Alerting tells you work was dropped; it does not resume it. The underlying
fix is to make ad rendering a **durable worker-drained queue** instead of an
in-process loop on an autoscaling web service — i.e. let `worker.js` claim
`Ad{status:'queued'}` the way it already claims `DetectRun`, so an instance
replacement costs one ad instead of a whole batch. That is a real change to
a money-spending path (claim/lease semantics, no double-submit of a billable
POST) and is deliberately not bundled here.

Interim mitigations, cheapest first:

1. **Run video batches smaller.** `MAX_CREATIVES_PER_RUN=20` at ~1 min/ad is
   a 25–35 minute exposure window. Lower it and each loss is smaller.
2. **Pin the web service to one instance** (autoscaling `max: 1`) so
   scale-in stops being a cause. Deploys still are.
3. Deploy when nothing is rendering — now observable, because SIGTERM alerts
   name the count.
