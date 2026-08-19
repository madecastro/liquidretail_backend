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
| Requester | Head line ends `· by <who>` — who clicked Generate. See **Who ordered the run** below |

### Who ordered the run

The parent head line is `▸ <run> · <brand> [· <product>] · <N> ads · by <who>`, so a channel of
concurrent runs is attributable at a glance. The thread's `run start` line carries it too.
`<who>` resolves in this order:

1. `User.displayName` → 2. `User.email` → 3. the last 6 chars of the requester's ObjectId
   → 4. **the whole `· by …` atom is omitted.**

Source of truth is `CampaignRun.requestedBy` (`req.user.userId`, already stamped at mint time by
every route that creates a run — no schema change was needed for this). It reaches the feed two
ways, and both matter:

- **`runRenderLoop`** passes `requestedBy` on its first `runFeed.startRun` (free — already on the
  run doc, so the *first* parent post already names someone) and the resolved `requesterLabel` on
  the enriched second call. That label lookup shares one `Promise.all` await point with the
  existing Brand lookup, so it adds **no** serial round-trip ahead of the render pools.
- **`loadLiveSnapshot`** (detached interval) copies `requestedBy` off the run doc it already reads
  and resolves the label itself. This is what covers runs this process did not start: the
  queued-drain path, a second Render web instance, the worker.

The label lookup is **latched on attempt, not on success** — a `requestedBy` pointing at a deleted
user would otherwise re-query on every parent tick for the life of the run and never resolve. One
miss is enough; the head degrades to the short id.

Two rules when touching this:

- **Never `.populate('requestedBy')`.** It throws *"Schema hasn't been registered for model
  User"* in `routes/ads.js`, which never requires the `User` model — mongoose resolves refs
  lazily against whatever is registered in the process. Always a guarded `require` + `findById`.
- **`User` has `displayName`, not `name`.** There is no `name` and no `username` field. The
  render-activity board had been selecting `'email name'` with a `u?.name` fallback that could
  never fire; fixed 2026-08-18.

The thread's `run start` line gets the label **through `buildRunStartLine`**
(`services/slackRunVerbosity.js`), not appended at the call site —
`verifySlackRunVerbosity` G18 asserts that line has exactly one builder. It is appended last so
it survives both the at- and above-threshold branches, and omitted entirely when absent so the
byte-identical guarantee for existing callers still holds.

The requester is also a `by:` field on the four job-status alerts (below). The two
`Campaign run crashed …` alerts carry the raw **id**, not the label: they fire outside
`runRenderLoop`, and a failure path does not get a second DB read for a cosmetic field.

**Safety (paid-path contract, same family as `adStage` / `alertService`):**

1. Never awaited on a render path — fire-and-forget entry points.
2. Never throws — absolute try/catch on every export.
3. Bounded memory — fixed ring (`RUN_FEED_RING_SIZE`); DROP OLDEST + report `(N events dropped)`.
4. Never sleeps on 429 — logs `Retry-After`, drops that flush.
5. Inert when channel or token unset (one warn per process).
6. All Slack I/O on a detached `unref`'d interval.

Covered by `scripts/verifyRunFeed.js` (offline; revert-proves the never-escape assertion).
Section **I** covers the requester: the label on the head line, the short-id fallback, the
byte-identical head when nobody is known (guards against a dangling `·`), pickup from the run doc
for a run this process did not start, and a **throwing** `User` lookup leaving the feed working.
`_setDeps({ User })` is the injection seam. `verifySlackRunVerbosity` D4–D8 cover the builder,
including that a non-string or blank label never prints `by undefined`.

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
| `Stranded generation reclaimed — run …` / `N stranded generation(s) reclaimed` | warn | reaper, `worker.js` | **New** — dedicated per-run detail for the `preparing`-reap arm above: names the run id, campaign, age, and how many minted ads sit `queued` (drainable). See *Preparing-reap notice* below |
| `N ad(s) stuck rendering` | error | watchdog | Wedged past `ALERT_RENDERING_STALE_MIN`, deliberately **before** the 15-min reap so the evidence is intact |
| `N campaign run(s) not progressing` | error | watchdog | `running` past `ALERT_RUN_STALE_MIN` |
| `Detect queue backing up — N queued` | warn | watchdog | The worker's own queue is growing → worker wedged |
| `Spend $X in the last hour` | warn | watchdog | Trailing-hour `CostLog` total over `ALERT_HOURLY_SPEND_USD` |
| `Video generation failed` | error | `routes/ads.js` | Atlas prediction failed or timed out. `by:` = requester label, read off `job.requesterLabel` |
| `Campaign run finished with N failed ad(s)` | warn/error | `runRenderLoop` | Escalates to error when **every** ad failed. `by:` = requester label |
| `Campaign run crashed …` | error | `routes/ads.js` | The loop itself threw. `by:` = requester **id** (fires outside `runRenderLoop`) |
| `Claim anomaly — run … released` | **fatal** | `routes/ads.js` `/generate` | `claimAdsForRun`'s updateMany reported a write but the ownership re-read came back empty (should never fire). Ads released to `queued`, run marked `failed`. Sent to the fatal/alert channel, **never** the per-run status feed. See *Claim-anomaly alert* below |
| `Director LLM unreachable — static ad generation is producing ZERO ads` | **fatal** | `campaignAdsGenerationService` per-product catch | Every Director candidate failed at the TRANSPORT level. **Fires from the SECOND occurrence** (see *Occurrence thresholds*). Carries the code, the chain summary, and the emergency lever |
| `Director LLM output is UNUSABLE — static ad generation is producing ZERO ads` | **fatal** | same catch, `director:content-failure` key | The model ANSWERED (HTTP 200, tokens billed) and the response could not be used — prose instead of JSON, truncated, or zero usable concepts. Same zero-ads impact, **completely different remedy**, so it pages under its own key. Also 2nd-occurrence |
| `Director served by a FALLBACK model — the primary is unavailable` | warn | `aiCreativeDirectorService.directConceptsRound` | Ads ARE being produced, but by a fallback chain link. Fires on the first occurrence per serving model |

### Director alerts — added 2026-08-18 after a 20-hour silent outage

Static ad generation was **100% dead for ~20h** and nothing paged. Two gaps,
both closed here:

1. **No alert on total failure.** The per-product catch in
   `campaignAdsGenerationService` only `console.error`'d. The run finished, the
   operator saw *0 static ads* and no error. The only pre-existing Director
   alert (`director:contract-warn`) fires for a payload that **parsed** — i.e.
   the one case where the Director was working.
2. **No alert on degradation.** A Director quietly served by a fallback model
   looked identical to a healthy one in every log and artifact.
3. **The COMMON failure was still silent after the first fix.** Five Director
   failures — empty content, truncated response, still-not-JSON after the
   corrective re-ask, zero usable concepts, and the V2 path's parse failure —
   threw plain `Error`s, so `isLlmError` was false, none paged, and each landed
   `code: null` in `CampaignRun.errors[]`. That is not an edge case: this repo
   measured **10 Director round failures to 1 success in 24h** from prose
   responses. They now classify (`LLM_CONTENT_*` / `LLM_CONTRACT_UNMET`) and
   page on the second occurrence like any other zero-ads outage.

**Why a content failure is fatal-channel too.** The remedies differ completely,
but the operator impact does not: zero static ads for every affected product. A
Director that answers and will not follow the contract is the same outage
wearing an HTTP 200. Separate keys keep the two from deduping each other away
and keep the wrong remedy off the page.

| | Total failure | Fallback served |
|---|---|---|
| Level / channel | `fatal` → `SLACK_ALERT_CHANNEL_FATAL` | `warn` → `SLACK_ALERT_CHANNEL` |
| Dedupe key | `director:transport-failure` / `director:content-failure` (**global**) | `director:fallback-served:<provider>/<model>` |
| Threshold | **2nd occurrence** within `ALERT_THRESHOLD_WINDOW_MIN` | none — first occurrence pages |
| Delivery | `notifyAsync`, never awaited, cannot throw | same |

**The failure key is global, not per-product, and that is deliberate.** A
gateway outage hits every product; keying per product would turn one fault into
fifty pages and get the channel muted. The consequence is that the
`brandId`/`productId`/`campaignId` fields name an **exemplar** — whichever
product tripped the threshold — while the `chain` line in `detail` is what
actually identifies the fault.

The message states, in plain words: the consequence (*static ad generation is
producing ZERO ads for these products; video is unaffected*), what the system
did (`action`), what a human should do (`operatorAction` for that code), and
the zero-deploy lever (`ATLAS_MODEL_DIRECTOR`).

**Why `warn` and not `info` for the fallback notice:** `ALERT_MIN_LEVEL`
defaults to `warn`, so an `info` notice would be muted in production — the same
silence in a new hat.

## Occurrence thresholds — "alert me if it happens more than once"

`notify({ …, minCount: 2 })` holds the first occurrence of a `key` and delivers
from the second, inside a rolling `ALERT_THRESHOLD_WINDOW_MIN` window.

This is **not a second dedupe mechanism** — it reuses the same `key` namespace
and folds held occurrences into the same `suppressed` tally, so the eventual
delivery carries `+N more (suppressed)` and the operator can see it was the
second of several rather than an isolated event. Two gates in series:

```
occurrence threshold  →  dedupe window  →  severity rate limit  →  Slack
   (minCount)            (15 min)           (20/min low, 60/min high)
```

Omitting `minCount` (or passing 1) is exactly today's behaviour, so every
pre-existing caller is unchanged.

**Window = 30 minutes**, and the trade is deliberate:

- *Shorter* and an outage producing one failure per small run never pairs two
  hits and never pages — the 20-hour silence, again.
- *Longer* and two unrelated blips days apart get welded into a "recurring"
  page, which is how a channel loses credibility.

`ALERT_THRESHOLD_WINDOW_MIN=0` **disables the threshold** (every occurrence
pages), matching `ALERT_DEDUPE_WINDOW_MIN=0`. It deliberately does *not* mean
"expire instantly" — that reading would make the knob a silent mute switch for
exactly the alerts someone bothered to set a threshold on.

## LLM error codes — what each one means and what to DO

Every LLM failure now carries a stable `code`, full diagnostic context, and an
`action` saying what the system actually did next. Owner directive 2026-08-18:
*"every failure to an LLM call should be reported with a easy to understand and
complete error code"* and *"and what steps were taken next"*.

Before this, `Atlas 400: {"code":400,"msg":"bad request"}` was all that reached
an operator — indistinguishable from a capacity outage, which is exactly what
the real fault turned out to be (**HTTP 429 after ~51 seconds**).

Defined once in **`services/llmError.js`** and imported everywhere; the
`operatorAction` text below lives in that file's `CODE_META` so this table
cannot drift from the code (pinned by `scripts/verifyLlmErrorCodes.js` F1).

`billable` answers *"did we pay for this?"* — `false` because failed LLM
requests are documented as never billed, `true` for HTTP 200 responses whose
tokens were generated, and `unknown` where we genuinely cannot tell.

| Code | Means | billable | What to DO |
|---|---|---|---|
| `LLM_RATE_LIMITED` | HTTP 429 — the provider is capacity-starved on this model | `false` | **Do not raise the timeout** — the 429 already burned ~50s. Let the chain advance to a non-Anthropic link, or set `ATLAS_MODEL_DIRECTOR` to a probed-healthy slug |
| `LLM_TIMEOUT` | We stopped waiting; no status ever arrived | `unknown` | Check Atlas usage / `request_id` before replaying — this is the ambiguous billing case. Prefer advancing over raising the timeout |
| `LLM_BAD_REQUEST` | HTTP 400/422 — the request itself was rejected | `false` | Read the provider message. Usual causes: sampling params on Claude 5, `json_schema` on Anthropic, an unaccepted field. Fix the body or the model map — retrying is futile |
| `LLM_AUTH_MISSING` | **No key was ever configured; nothing was sent** | `false` | Set that provider's key on **both** Render services, or drop the link. This is the code for the silent skip that hid the 2026-08-18 outage |
| `LLM_AUTH_REJECTED` | HTTP 401/403 — a key was sent and refused | `false` | Replace the key on both services. **Do not rotate** if the body mentions quota/balance — that is the next row and the key is fine |
| `LLM_QUOTA_EXHAUSTED` | HTTP 402, or a 403 whose body says quota/balance | `false` | Top up the wallet. Outranks a bare 403 so a credit outage is never mishandled as a permissions problem |
| `LLM_MODEL_UNROUTED` | HTTP 400 `router not found` — listed in the catalog, no router | `false` | Re-point the role (`atlasModelMap` / `ATLAS_MODEL_<ROLE>`) to a slug probed live. `openai/gpt-5-nano` is the canonical example |
| `LLM_UPSTREAM_ERROR` | Provider 5xx | `false` | Safe to retry — there is no image-style running task to probe. If it persists, advance rather than sitting on a down route |
| `LLM_NETWORK_ERROR` | Reset / refused / DNS / hang-up before any reply | `unknown` | May have been delivered and billed. Check `request_id` before replaying |
| `LLM_CONTENT_EMPTY` | HTTP 200, empty `message.content` — **tokens billed** | `true` | Usually hidden reasoning eating `max_tokens` (`finish_reason: length`). Raise `ATLAS_REASONING_RESERVE_TOKENS` or the caller budget |
| `LLM_CONTENT_TRUNCATED` | HTTP 200, content arrived and was **cut off mid-response** — tokens billed | `true` | `finish_reason: length` with real content. A re-ask **cannot** fix an exhausted budget — raise `DIRECTOR_ROUND_TOKENS` (Director) or the caller's `max_tokens`. Distinct from `LLM_CONTENT_EMPTY`: there nothing arrived, here it arrived and stopped |
| `LLM_CONTENT_UNPARSEABLE` | HTTP 200, body was not the required JSON — **tokens billed** | `true` | Use the salvage + one-shot corrective re-ask. **Never** advance a fallback chain on this |
| `LLM_CONTRACT_UNMET` | HTTP 200, valid JSON, but the payload failed the caller's contract — tokens billed | `true` | The "paid for it and threw it away" case (e.g. zero usable concepts). A **prompt or model-choice** problem, not a transport one — read the validator reasons in the log. Retrying the identical prompt on the same model usually reproduces it |
| `LLM_REFUSED` | HTTP 200, the model asked a question instead of answering | `true` | Re-ask once with the OUTPUT CONTRACT reminder; a thin brief will keep refusing and each attempt is paid |
| `LLM_UNCLASSIFIED` | Matched nothing | `unknown` | Capture status, errCode, `request_id` and the first 200 chars of the body, then **add a real code** — do not guess a retry |

### Two predicates, deliberately separate: retry vs advance

`shouldRetrySameLink(err)` and `ADVANCES_CHAIN.has(code)` answer different
questions and **must not be collapsed into one**:

| | asks | wrong answer costs |
|---|---|---|
| `shouldRetrySameLink` | re-send the **same** model? | wasted round trips against a model that will answer identically |
| `ADVANCES_CHAIN` | try the **next** candidate? | a healthy provider never reached, or a paid call bought twice |

They genuinely diverge. A listed-but-unrouted 400 **advances** (another
candidate may route) but must **not** be re-sent — three identical 400s and two
backoffs teach nothing, and `openai/gpt-5-nano` is a real slug in this catalog
that does exactly that. `ECONNREFUSED` / `ENOTFOUND` / `EPIPE` likewise advance
(a different host might answer) but will not fix themselves in 3s, so they skip
the in-link retry; `ECONNRESET` / `EAI_AGAIN` are transient and do retry.

`shouldRetrySameLink` reproduces the **pre-chain** predicate term for term, so
the eleven single-link roles behave exactly as they did before the Director
chain existed. Pinned behaviourally by `verifyDirectorFallbackChain` C5/C6.

### The `action` — what the system did next

Never the intent, always the outcome, stamped by the control flow *after* it
ran (`stampLlmAction`). A code with no action leaves the reader unable to tell
"we recovered" from "your ads are gone".

| Action | Means |
|---|---|
| `RETRIED_SAME_MODEL` | Re-sent the same slug (attempt N of M) |
| `ADVANCED_TO_NEXT_LINK` | Moved to the next chain candidate — the link is named |
| `FELL_BACK_TO_DIRECT_PROVIDER` | Left Atlas for the vendor's own API — provider+model named |
| `CORRECTIVE_REASK` | Issued the one-shot bad-JSON re-ask (shares the attempt budget) |
| `SKIPPED_NO_KEY` | Skipped without attempting — no key for that link |
| `EXHAUSTED_CHAIN` | Every candidate failed. **Transport-level** give-up |
| `CORRECTIVE_REASK` | Issued the one-shot bad-JSON re-ask (shares the attempt budget) |
| `GAVE_UP_PRODUCT` | This SKU mints no ads (video is unaffected) |
| `GAVE_UP_RUN` | The whole run is done |

The **final** error additionally carries a one-line chain summary so a single
Slack message tells the whole story:

```
tried anthropic/claude-sonnet-5 (429, 51.0s) → direct:claude-sonnet-5 (auth_missing, 0.0s)
  → anthropic/claude-opus-5 (429, 50.0s) → openai/gpt-5.6-terra (ok, 1.0s)
```

### Where the codes surface

1. **Render logs** — one dense greppable line per failure:
   `[LLM_RATE_LIMITED] role=director provider=atlas model=anthropic/claude-sonnet-5 status=429 after=51.0s attempt=1/1 link=1/3 request_id=… — is rate-limiting this model; advanced to anthropic/claude-opus-5`
2. **Slack** — the alerts above carry `code`, `action`, `request_id`,
   `billable` and the chain, not a truncated `err.message`.
3. **`CampaignRun.errors[]` and `CampaignRun.perProduct[]`** — `code`, `action`
   and `chain` are **declared on the strict schema** (`models/CampaignRun.js`).
   They had to be: an undeclared path is silently dropped, which is how
   `renderError.predictionId` was lost once already.
4. **The thrown object** — `err.code` / `err.llmCode`, `err.action`,
   `err.retryable`, `err.billable`, `err.chain`, `err.chainSummary`, so callers
   branch on a constant instead of regexing message text.

⚠️ **`err.code` is the TAXONOMY code, which overwrites the node/axios transport
code.** The original is preserved as **`err.transportCode`** (`ECONNABORTED`,
`ENOTFOUND`, …) — not decoration: `shouldRetrySameLink` needs `ECONNRESET`
(transient, retry) versus `ECONNREFUSED` (host is wrong or down, do not) to
reproduce the pre-chain retry set exactly, and an operator reading a log needs
to know which syscall failed. Use `err.llmCode` when you must be certain you
are reading the taxonomy and not a transport code.

**Backwards compatibility deliberately preserved** (grep before changing a
message string): `err.status` is still set alongside `err.httpStatus` because
`judgeService.js:322-334` branches on it, and the provider's own text still
appears in `err.message` because that same retry matches
`/Timeout while downloading/i` against it.

**Deliberately not alerted:** a nonzero count of `queued` Ads.
`expandWizardJob` routinely queues more creatives than
`MAX_CREATIVES_PER_RUN` (1000, effectively uncapped) drains in one run, so that count is normal
inventory, not a fault. It is carried as *context* on the alerts above.

### Run-completion per-kind summary (per-run status feed, not a separate alert)

`runRenderLoop`'s final `runFeed.finishRun(...)` call now carries a
`summaryLines` array (`slackVerbosity.buildRunCompletionSummaryLines`,
`services/slackRunVerbosity.js`) rendered into the run's parent Slack
message, after the `finished — N✓/M✗/K⊘ · elapsed` line and before the
grouped failure reasons. Up to three lines, each printed only when there is
something to say:

1. **Minted vs. claimed**, only when they differ: `minted 40, claimed 25 —
   15 queued (drainable via "Generate more")`. Reuses `CampaignRun.mintedTotal`
   / `unclaimedAtStart` — already persisted at claim time — never recomputed.
2. **Per-kind breakdown**: `12 static delivered / 1 failed, 3 video masters
   delivered (billable) / 6 free derivatives / 1 failed`. Kind is derived from
   the claimed ads' `renderRoute` (`'veo'` vs other) + `deriveFromMaster`
   (billable master vs free derivative); outcome from final `Ad.status`
   (`'failed'` vs `'draft'`/`'live'`).
3. **Spend**, only when cheaply available: `reconciled spend $1.80` from
   `CostLog` rows for this run's claimed `adId`s with `costSource:'actual'`.
   If only `costSource:'estimated'` rows exist, the line says `est. spend
   $X.XX` explicitly — **never** presented as settled, and `base_price` /
   the estimate formula are never quoted as spend (CLAUDE.md §2).

### Preparing-reap notice (`worker.js` reapOrphans, `level: warn`)

The `preparing`-reap sweep (`PREPARE_STALE_MIN`, 30m) used to only feed a
count into the generic `Dropped work reclaimed` alert above. It now also
fires a dedicated notice, one per reap tick, naming **every** run it just
stamped `failed`: run id, campaign id, age (minutes since mint), and how
many of that run's minted ads sit `status:'queued'` — i.e. **drainable**.
Wording is deliberately never "lost" or "deleted" (PR #204 truthful-wording
rule): a `preparing` run holds no claimed ads by construction (expansion
never reached the claim step), so its minted ads — if any — are intact and
queued. The detail line always states the drain path verbatim: *"Generate
more on the Ads/Campaigns page renders them; the 24h archive sweep parks
them otherwise."* Built by `slackVerbosity.buildPreparingReapNotice`.

### Claim-anomaly alert (`routes/ads.js` `/generate`, `level: fatal`)

`claimAdsForRun`'s anomaly branch (`updateMany` reports `modifiedCount > 0`
but the ownership re-read returns nothing — should never fire under primary
reads + acknowledged writes) used to only `console.error`. `/generate`'s
background task now also sends a Slack alert — `slackVerbosity.
buildClaimAnomalyAlert` — naming the run, campaign, how many ads were
selected for claim, the write's `modifiedCount`, and that the ads were
released back to `queued`. Sent at `level: 'fatal'` via `alertService`
(the fatal/alert channel, falling back to `SLACK_ALERT_CHANNEL` if
`SLACK_ALERT_CHANNEL_FATAL` is unset) — **not** the per-run status feed,
because this is the rare "should never happen" case, not routine progress.
`/runs`' anomaly branch (pre-existing, unchanged here) still only logs;
extending it is a candidate follow-up, not bundled in this change.

### Uncap context line (per-run status feed)

`MAX_CREATIVES_PER_RUN` moved from 20 to 1000 (effectively uncapped,
2026-08-18). Below the old cap of 20, the run-feed's `run start — N ad(s)`
thread line is byte-identical to before. Above it, `slackVerbosity.
buildRunStartLine` appends an `— uncapped batch` marker plus the static/video
mix, e.g. `run start — 39 ad(s) — uncapped batch (24 static + 15 video)`, so
a big uncapped batch is visible in the thread rather than looking like
routine traffic.

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
| `ALERT_THRESHOLD_WINDOW_MIN` | `30` | Rolling window for `minCount` (the "more than once" gate). `0` **disables** the threshold, it does not mute. Code default; not in `defaults.env` |
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
| `REAP_STALE_MIN` | `15` | `updatedAt` (**silence**) | **Claimed** work — `Ad` in `rendering`, `CampaignRun` in `running`. Both heartbeat *for real* since 2026-08-18 (see below), so 15m of silence really is a dead holder. Also bounds the concurrency gate's `running` arm, which uses the same field and bound as the reaper so that "gate-visible" and "the reaper would spare it" are one statement. |
| `PREPARE_STALE_MIN` | `30` | `createdAt`/`startedAt` (**mint age**) | The **preparing** lifecycle — mint → the `preparing`→`running` flip. Mint age is the only available clock because a preparing run makes no writes to its own row. Raised from 15 on 2026-08-18: the healthy runtime (Director + Judge) is **~18-20 min**, so 15 was failing expansions that were merely finishing. Non-secret, so it lives in `config/defaults.env`. |

The clock column is load-bearing. Keying the gate's `running` arm on mint age
instead of silence was a confirmed double-bill P0 (a run that flipped at t=18
was invisible to the gate the moment it started submitting billable work, so a
duplicate was admitted silently).

### The `CampaignRun` liveness heartbeat — and the run it was written for

**The gap this closes, and it was measured, not theorised.** Until 2026-08-18
`CampaignRun` had **no periodic heartbeat of its own**: the 60s beat in
`routes/ads.js` refreshes the `Ad` row, not the run, so a run's `updatedAt`
moved **only when an ad in the wave settled** (the per-ad
`$inc { succeeded | failed | skipped }`, refreshed by `timestamps: true`). The
reaper's `updatedAt < now - REAP_STALE_MIN` predicate therefore did not mean
*"this run is alive"* — it meant *"an ad settled recently"*, and those are
different statements the moment a run's tail is long and serialised.

**MEASURED INCIDENT — `run_1787105727540_e8c94542`, 2026-08-18.** One product,
Meta + PMax "Everything", 39 claimed ads.

| time | what happened |
|---|---|
| 02:15:27Z | `startedAt` |
| ~02:21 | all **18 statics** settled; every remaining row is video |
| 02:21-02:36 | video titling runs. **Zero writes to the `CampaignRun` row** |
| 02:36:29Z | `reapOrphans()` matches `{ status:'running', updatedAt: { $lt: … } }` and stamps the run **`failed`** — final doc `succeeded 18 · failed 0 · skipped 0 · total 39 · errors: []`. Nothing threw. It was still rendering. |
| same tick | the **Ad** sweep flips **9** of the run's rows from `rendering` back to `queued` on the identical silence |

Those 9 rows — the 4:5 derive and the staged Meta funnel variants — were
stranded permanently. The operator paid for the masters and silently received
**30 of 39** creatives.

They are the run's claimed-but-**undispatched** tail. That is inference rather
than direct observation, and it is stated as such because it decides the
recovery verdict: the count matches `21 video rows − VEO_CONCURRENCY (12) in
flight = 9` exactly, and the only other path that parks a video row in `queued`
— `renderDeriveOnlyVideoAd`'s polite wait-requeue — `$inc`s `skipped`, which the
run's `skipped: 0` rules out.

**Nothing recovers them automatically, and an operator has to be told.**
`services/strandedRunSweeper.js` re-drives `queued` ads whose owning run went
`failed`, but only those carrying a `renderStage` breadcrumb
(`renderStage: { $nin: [null, ''] }`) — the test that separates *"a deploy
killed this"* from *"an operator has not pressed go yet"*. A claimed-but-never-
dispatched ad has no stage (only `adStage()` writes one, and it is called from
`renderOne`, which never ran for these), and the reaper's requeue marker is
`REQUEUE_MARK = { wasRendering: true }` — it does not add a breadcrumb. So these
9 **do not qualify**, and the attempt bounds (`renderAttempts`,
`deriveWaitAttempts`) never come into it. The remedy is **Generate more**
(`POST /api/ads/runs`), or `queuedArchiveSweeper` parks them after
`QUEUED_ARCHIVE_AFTER_H` (24). Widening the sweeper to reach them is a
money-adjacent change: the breadcrumb requirement is what stops it draining ads
nobody claimed.

**Why this got likelier the same week:** video went to 10s on both platforms and
Meta+PMax now share ONE 9:16 master, so 15 of 21 video rows queue behind a
single plate and titling serialises behind `REMOTION_QUEUE_CONCURRENCY` (4).
Long silent stretches between ad settlements are the **normal** shape of a mixed
run now, not an edge case.

**The fix — `services/campaignRunHeartbeat.js`.** A ~60s ticker started in
`runRenderLoop` that writes `$set: { updatedAt, lastHeartbeatAt }` to
`{ _id, status: 'running' }` and **nothing else** — never `total` (the claim
count and progress denominator), never the outcome counters. It also beats the
run's still-`rendering` ads with the same filter/update the loop already used on
every completion, which is what saves the undispatched tail.

Three properties are load-bearing, all pinned by
`scripts/verifyCampaignRunHeartbeat.js` (36 checks, offline):

- **It is gated on real work.** `isWorking` reads the render loop's own pool
  `inflight` counters. An unconditional beat would defeat the reaper outright
  and resurrect the wedged-run-lives-forever class it exists to kill. A loop
  with nothing in flight emits no beat, and the timer dies with the process, so
  a replaced instance cannot beat at all. When the beat stops, the window runs
  normally from the last beat.
- **It has a total lifetime cap** — `RUN_HEARTBEAT_MAX_MS`, **4h**, matching
  `progressService.MAX_RUN_MS` because `runRenderLoop` opens that same run's
  `ad-batch` `OperationRun` and the two heartbeats must not disagree about when
  a run stops being credible. `inflight` is decremented in `renderOne`'s
  `.finally`, so a `renderOne` that **never settles** would otherwise report
  work forever and make the run immortal — worse than the pre-heartbeat
  behaviour, since the Ad arm would also hold the claimed `rendering` set out of
  the Ad reaper's reach. Past the cap the beat stops and recovery behaves as it
  did before this file existed. (Caught in adversarial review, not by the first
  design.)
- **It stops on every exit path** — `runHeartbeat.stop()` in **both** the
  `catch` and the `finally` around the pool drain (`stop()` is idempotent), and
  the interval is `unref()`'d. The `catch` arm is dead today — the drain's
  promises are individually `.catch`'d so `Promise.all` cannot reject — and is
  kept as an edit guard, which the source says plainly rather than implying it
  is load-bearing.
- **The interval is derived from the ONE shared parser** (`services/staleness.js`
  `reapStaleMin()`), capped at 60s (the `Ad` beat's cadence) and divided so at
  least 5 beats fit inside the reaper window. At the documented 15 that is
  **15 consecutive missed writes** before a false reap. `REAP_STALE_MIN` was
  **not** raised — raising it would delay orphan requeue for every `Ad` and
  every running run. ⚠️ The 5s spin-guard floor and that divisor **conflict
  below a ~25s window** (`REAP_STALE_MIN < ~0.42`), where the margin degrades;
  that is stated in the source and pinned as an explicit boundary rather than
  claimed away. It is not the binding failure at such a setting — the
  pre-existing hard-60s `Ad` beat is already hopeless there.

**`CampaignRun.lastHeartbeatAt`** is a declared schema field. Read it like this
— and note the first draft of this paragraph had it **backwards**: a beat writes
`updatedAt` and `lastHeartbeatAt` at the same instant, so on a beating run they
are always ~equal, and only a *settlement* moves `updatedAt` alone.

| observation | meaning |
|---|---|
| `lastHeartbeatAt` fresh | the render loop is alive **and has work in flight** (the beat is gated on that) |
| `lastHeartbeatAt` stale/null while `status:'running'` | nothing is in flight, or the process is gone — the reaper is right to act |
| is work **settling**? | compare `succeeded + failed + skipped` against `total`. **Not** a date gap |

That first row is the whole point, and it is exactly what `updatedAt` alone
could not say on 2026-08-18.

⚠️ **Honest consequence for the alert thresholds below.** A run with in-flight
work now refreshes `updatedAt` every ~60s, so `ALERT_RUN_SILENCE_MIN` (12m on
`updatedAt`, via `buildStalledRunFilter`) can no longer fire for a run whose
pool is busy — it now catches only a run that is silent *because nothing is
rendering*. That is a narrower set than the name suggests. It is the same shape
`ALERT_RENDERING_STALE_MIN` has had since the `Ad` beat shipped (a dispatched ad
is beaten every 60s by `renderOne`, so that arm only ever catches ads whose
holder is gone). Neither is re-tuned here — flagged rather than papered over,
because a silence alarm behind a heartbeat is a thing a reader must know about
before trusting it. What still alerts on a genuinely wedged run is
`ALERT_RUN_STALE_MIN` (45m on `startedAt`).

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
node scripts/verifySlackRunVerbosity.js
```

`verifySlackAlert.js` covers: unconfigured silence, `ok:false` on 200 as
failed send (dedupe + tally), 429 non-blocking, dedupe fold, rate limit,
`xoxb-` redaction, balanced fences at the size limit.

`verifySlackRunVerbosity.js` covers the four enhancements above (all pure —
no DB, no network): per-kind counts for the completion summary (revert-proven
against a delivered/failed field swap), minted-vs-claimed + reconciled/est.
spend formatting, the uncap context line's byte-identical-below-threshold
guarantee, and wording truthfulness on the preparing-reap notice (revert-proven
against a "lost"/"deleted" mutation). A structural section (`G`) asserts the
real call sites in `routes/ads.js` / `worker.js` / `services/runFeedService.js`:
the claim-anomaly alert is `alerts.notifyAsync` at `level:'fatal'` and never
`runFeed.*` (revert-proven), and none of the new notify/runFeed calls in the
render-loop or reap regions are `await`ed (revert-proven, comment-stripped
before scanning).

## In-app run status vs Slack (2026-08-19) — gap table + the architecture decision

Owner framing, verbatim: *"Slack seems to know exactly what is going on, why aren't
we using that as a source of information?"* This section is the inventory that
prompted, and the fix that followed.

### The decision: reuse Slack's own functions from the HTTP route, not a second copy

Two credible designs existed. **Rejected: bolt Slack's strings onto the UI** — copy
`buildParentText`'s "now:" line or `summariseFailures`'s grouping logic into
`routes/ads.js`. That is exactly how the app and Slack would drift again the next
time either one is edited — two implementations of "what does this failure mean"
that look similar and slowly diverge, the same class of bug this whole pass exists
to fix. **Chosen: `GET /api/ads/runs/:runId` calls the SAME exported functions**
Slack's live feed already calls — `services/adStage.js summarizeInFlightStages`
(the grouping half of what `buildParentText`'s "now:" line computes) and
`services/runFeedService.js summariseFailures` (literally the function
`finishRun`'s Slack summary calls). One computation, two renderers (Slack text,
React JSON). A future change to either grouping rule is felt on both surfaces by
construction, not by remembering to update two places.

`runFeedService`'s own per-process `now:` computation (mixing a fresh Mongo read
with in-memory `lastStageByAd` for ads whose `renderStage` write hasn't landed yet)
was deliberately **not** touched — that in-memory merge exists for the live feed's
own real-time feel and has nothing analogous on an HTTP poller, which just reads
Mongo fresh each request. The shared piece is the taxonomy
(`services/adStage.js stageBase`) and the grouping/failure functions, not the
transport-specific plumbing around them.

### Gap table (Slack signal → in-app today)

| Slack signal | Persisted? | Was it in `GET /runs/:runId`? | Now? |
|---|---|---|---|
| Live "now: X ×N, Y ×M" stage aggregate (`runFeedService.buildParentText`) | Yes — `Ad.renderStage` | **No** — only aggregate succeeded/failed/skipped counts, zero stage detail | **Yes** — `stages` field, `services/adStage.js summarizeInFlightStages` |
| Grouped failure headline (`runFeedService.summariseFailures`, e.g. "2✗ Model Moderation Error") | Yes — `Ad.renderError.message` | Only the raw per-ad `errors[]` list (no grouping/dedup) | **Yes** — `failureSummary` field, same function Slack calls |
| Run liveness (`services/campaignRunHeartbeat.js`) | Yes — `CampaignRun.lastHeartbeatAt` | Not returned at all | **Yes** — `lastHeartbeatAt` + `updatedAt`, used for the frontend's "no update in Xm" caution |
| "Run reaped as stale" reason | N/A — this was the gap | Reaper stamped `status:'failed'` with an **empty** `errors[]` — zero explanation | **Fixed** — `buildStaleRunningReapUpdate` pushes a real `errors[]` entry naming the stale window |
| "Queued-drain run crashed" reason | N/A — this was the gap | Same empty-`errors[]` gap, different code path (`POST /api/ads/runs`) | **Fixed** — mirrors the prep/render crash handler's `$push` |
| Per-ad vision-QC category scores + findings (`adVisionQcService.js` alert fields) | Yes — full `Ad.visionQc` | Only via `GET /api/ads/:id/generation-inspector`; render-activity/ads-list get the pass/fail summary only | **Still gap** — not wired into the run poller or gallery cards; the inspector remains the only full view |
| Director "payload didn't satisfy the round contract" warning | **No** — console + Slack only, never written to `CampaignRun` | No | **Still gap** — a run with this warning looks clean on the poller |
| Watchdog "N campaign run(s) not progressing" (age+silence on `preparing`/`running`) | Derived from `CampaignRun` fields, not a new one | No per-run "this has been silent Nm" flag | **Partially addressed** — `lastHeartbeatAt`/`updatedAt` let the frontend flag silence on `'running'`; a `'preparing'` run genuinely has no liveness signal by design (`expandWizardJob` makes zero writes to the row until the flip — see `services/campaignRunGuards.js`), so a stuck-preparing run is still only visible via Slack's watchdog until it ages out via `PREPARE_STALE_MIN` |
| `alertService` dedupe tally ("+N more since HH:MM") for a repeated failure | In-process map only | No | **Still gap** — a burst of identical failures reads as isolated events on the poller |

Full trace behind this table (every Slack call site, file:line, and what it does or
does not persist) was produced by a Grok CLI read-only pass over this repo and
independently spot-checked against the live source before anything above was acted
on — several of its findings turned out to describe a stale checkout of this repo
(pre-`services/campaignRunHeartbeat.js`); the table above reflects the current,
verified state, not that raw pass.

### What shipped alongside this table

- `services/adStage.js`: `groupStageCounts` (pure) + `summarizeInFlightStages`
  (the Mongo-touching wrapper) — grouped, sorted, capped stage buckets for a run's
  in-flight `Ad.renderStage` rows.
- `routes/ads.js` `GET /runs/:runId`: now also returns `stages`, `failureSummary`,
  `lastHeartbeatAt`, `updatedAt`.
- `services/campaignRunGuards.js` `buildStaleRunningReapUpdate` +
  `worker.js reapOrphans()`: the running-reaper's write now `$push`es a real
  `errors[]` entry instead of a bare status flip.
- `routes/ads.js` queued-drain crash handler (`POST /api/ads/runs`): same fix,
  mirroring the existing prep/render crash handler a few hundred lines above it.
- Frontend (`liquidretail` PR, companion to this one): `RunProgress` now shows the
  stage aggregate and grouped failure reasons, always-explicit succeeded/skipped/
  failed/still-rendering counts (never a bare "N of M"), and a truthful
  heartbeat-driven "no update in Xm" caution that never replaces the live progress
  underneath it — replacing a client-side poll timeout that used to stop polling
  entirely and freeze the display mid-run.

Pinned by `scripts/verifyRunStatusTruthfulness.js` (14 checks, revert-proven on 4
mutations).

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
