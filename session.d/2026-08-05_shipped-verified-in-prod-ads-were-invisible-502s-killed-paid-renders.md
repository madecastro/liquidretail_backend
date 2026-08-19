## 2026-08-05 — SHIPPED & VERIFIED IN PROD: ads were invisible; 502s killed paid renders

Owner: *"we are getting errors on image generation and I am not seeing any output"*, then
*"I cannot locate those ads in the product ads tab or anywhere else"*. **PR #86 (backend,
`aebde71`) + PR #35 (frontend, `3013bfb`) merged and deployed; both Render services live.**

**The ads existed the whole time.** Run `run_1785950174479_c96598eb` (Pelagic Gear, 12 ads) →
10 `status:'draft'` with real Cloudinary `renderUrl`s. `draft` IS the success terminal for a
static ad (`renderService.js` — "an ad never becomes draft until the production asset exists").

**ROOT CAUSE — `Ad.generatedAt` is a CREATION stamp and is never updated.** Not by
`persistStage` on a fresh render, not by `claimAdsForRun` on dedupe-reuse. Those 12 rows were
created **2026-07-30** and merely re-rendered 2026-08-05 17:17–17:21Z, so every surface that
ranked/badged "last activity" off `generatedAt` showed them as six days stale. `/product-ads`
badged *"Last Activity ~6 days ago"* and ranked the product #3-5 four minutes after it rendered.
`renderedAt` was correct all along and simply never read.

Fixed via `services/adRecencyService` (`AD_RECENCY_EXPR` / `resolveAdRecency`) at **four** call
sites: `catalog.js` `buildAdStatsByProduct` + `/:id/ads-detail`, `campaigns.js` `/ads-summary` +
**its own `/:id/ads-detail`** (a near-mirror an adversarial pass caught still on the old sort).
**VERIFIED AGAINST PROD AFTER DEPLOY:** the product moved from #3-5 badged `2026-07-30` to
**#1-3 badged `2026-08-05T17:21:22Z`** — the exact run-completion time. Full write-up:
`docs/PIPELINES.md` §10.

⚠️ **Two traps that will bite anyone touching this again.** (1) A compound
`.sort({renderedAt:-1, generatedAt:-1})` is NOT equivalent — BSON sorts `Date` above `null`
unconditionally, tiering every ever-rendered ad above every unrendered one regardless of
recency; a coalesced sort needs an aggregation. (2) Mongoose auto-casts `.find()` filters but
the driver's `$match` does **not** — `brandId`/`campaignId` need explicit `ObjectId` casts or
the `$match` silently returns nothing. ⚠️ **Unmeasured:** `$sort` on a computed field cannot use
the existing indexes; `allowDiskUse` is set, but this is NOT measured on the largest brand —
suspect it first if the ads list gets slow.

**Second, independent defect: a bare Cloudflare 502 on the FIRST poll killed 2 paid renders.**
Submit succeeded; `classify()` has no policy for a body-less CDN error page, so it fell to
`FALLBACK` (`retryable:false`) and threw. Polling is an idempotent GET — free, never a resubmit
— so `isPollTransportFailure()` now keeps polling when there is ZERO Atlas signal. **Gated on
`!policy.terminal`** because `classify()` resolves 401/402/403 from HTTP alone (`terminal:true`,
no body): without that gate a bare 402 behind a WAF page would poll the full timeout then ledger
as a *charged timeout* instead of failing instantly as a billing outage. `atlasVideoService`
already handled this; image only. Details: `docs/ATLAS.md`.

**Third: the image spend receipt did not exist for the cases it was built for.**
`spendReceipt.js` reads `Ad.imageGeneration.predictionId`, but that was only written by
`persistStage` — ON SUCCESS. So a timed-out/crashed image was unrecoverable **and**
requeue-eligible (a second billable submit for one image). Now stamped at the charge point, as
an aggregation `$mergeObjects` — a dotted `$set` would throw, because `imageGeneration` defaults
to `null` and Mongo cannot create a field inside a null element.

**OWNER RULE ENFORCED — a charge is CONFIRMED, never assumed.** `peekImagePrediction` /
`resumeImageForAd` (free, GET-only, structurally cannot submit) already fetched the settled
prediction's `price` and were discarding it; they now return it and `bootRecoveryService`
asserts a charge only when Atlas states one, reconciling to the real figure. `bootRecovery` also
no longer mishandles statics: `HAS_RECEIPT` matches both receipts but it selected only
`veoPredictionId` and called the video-only `resumeForAd`, so every stranded image ad was
tallied `unknown` and left in `rendering` forever.

⚠️ **KNOWN OPEN — the ledger understates.** `renderError.charged` is
`{type: Boolean, default:false}` and `renderService.js:1440` collapses a `null` (UNKNOWN)
`policy.charged` to `false`. **The 2 ads that failed on 2026-08-05 are on record as costing
nothing when the truth is we do not know whether Atlas billed them** — the one direction the
ledger can never be corrected in. Needs a schema change (tri-state or a companion
`chargeConfirmed`); the price read-back above is the mechanism that would populate it.

⚠️ **A static ad's Atlas output is NOT a deliverable ad** — unlike a video master it still needs
the delivery crop, logo composite and upload that live *after* the model returns
(`directImageRenderService`). Recovery therefore locates and alerts but deliberately does NOT
stamp `renderUrl`; doing so would ship an uncropped, unbranded image as a successful render.
Completing image recovery needs that post-model half extracted — **the remaining piece.**

### MEASURED 2026-08-05 — the real image duration distribution (n=784 CostLog rows)

Settles "is the timeout long enough". `AI_DIRECT_IMAGE_TIMEOUT_MS=600000` drives the ad path
(`PLATE_TIMEOUT_MS`); the bare `180_000` in `atlasImageService` applies only to callers that
pass no `timeoutMs`.

| model | n(ok) | p50 | p90 | p95 | p99 | max |
|---|---|---|---|---|---|---|
| `gpt-image-2/edit` (live ad path) | 210 | 72.2s | 138.4s | 202.3s | **367.2s** | **474.7s** |
| `gpt-image-1.5/edit` (the 180s inheritors) | 191 | 52.0s | 64.1s | 70.1s | 82.3s | 82.6s |
| `gemini-omni-flash` (video) | 83 | 117.3s | 166.6s | 171.6s | 246.9s | 246.9s |

16/784 successful renders exceeded 180s, 3 exceeded 300s, **0 exceeded 600s**. So 600s holds but
with only **1.26× margin over the observed max**, on a model with a 5× spread — consider 900s.
**180s is fine** for the inheritors: they run `gpt-image-1.5/edit` (max 82.6s), not the
heavy-tailed model. A timed-out image ledgers as **`charged-no-output`**, not `'timeout'`.
Telemetry gap: `nano-banana-2/edit-developer` has 260 `ok` rows with **no usable `durationMs`**,
so the outpaint path is unmeasurable. `gpt-image-2/edit` also shows ~10% non-ok (15 `rejected`,
6 `failed`, 2 `error` of 233).

### Corrections to claims made earlier in this session

- **`RENDER_CONCURRENCY` is 24, not 8**, and `MAX_CREATIVES_PER_RUN=20`, so
  `verifyConcurrencyConfig.js` asserts the gate is **non-binding for a full run**. There is no
  queue behind a slow render, so a long timeout cannot delay a batch, and decoupling the image
  poll would NOT be the throughput win it first appeared to be.
- **The 308s wall clock of that run was not image poll-wait** — 3 of the 12 ads were videos
  (Omni p50 117s at `VEO_CONCURRENCY=4`). It says nothing about image latency.

### SHIPPED: veo lane split (PR #87 + #88, live on `3ea9522`)

`VEO_CONCURRENCY=4` is **SELF-IMPOSED**, not provider-imposed — `concurrency.js` says Omni RPS is
unpublished and **"No Omni 429 was ever recorded"**, and Grok's real 1 RPS is protected
independently by per-slug `pacedModelSubmit` + the `GROK_MAX_RPS` floor *regardless of this
value*. **But Atlas is not the constraint:** the `veo` lane (`routes/ads.js:1312`) submits the
master **and then** runs `renderBrandScriptAndSave` → Remotion `renderMedia` (headless Chrome +
ffmpeg) in the **web** process. So 4 means up to 4 simultaneous Chrome+ffmpeg renders at 1080p
(2.25× the pixels of 720p, never measured; one measured titling = 76.2s). Raising it fails as
CPU/RAM exhaustion → Render autoscale at 60% → process replacement → stranded paid Omni masters
(~$1.00 each), NOT as 429s.

**Owner chose: two semaphores in the lane** — a high-cap slot for the idle Atlas submit+poll,
released before acquiring a low-cap slot for Remotion titling. Contained: no new state, no
change to status transitions, the reaper, or what operators see. (Rejected for now: routing the
normal path through `titlingResumeService`'s `titlingResumeState` sweeper — bigger unlock but
makes the normal path depend on crash-recovery machinery and adds sweep latency.)

**Landed as `services/semaphore.js` + `VEO_TITLING_CONCURRENCY`. Live boot log confirms
`VEO_CONCURRENCY=12 VEO_TITLING_CONCURRENCY=4`.** Titling stays at 4 on purpose — identical to
the old combined value, so the split cannot raise memory pressure on its first outing. The
permit is MODULE-level (a per-run pool would let two runs each open 4 renders) and uses
`withPermit`, which releases in a `finally` — titling CAN throw, and a release outside the
finally would shrink the pool on every failure until nothing could ever title again.

⚠️ **#87 SHIPPED A NO-OP AND #88 FIXED IT — read this before changing any knob.** #87 raised the
`VEO_CONCURRENCY` **SPEC default** 4→12 and production stayed at 4, because `config/defaults.env`
is dotenv-loaded into `process.env` and `resolveKnob` reads `process.env` FIRST. **The file
shadows the code default.** Changing a SPEC default alone is invisible in prod. Always change
`config/defaults.env` — and `scripts/verifyTitlingPermit.js` B6/B7/B8 now fail if the two
disagree. (No `VEO_*` var exists in either Render dashboard, so the file is authoritative.)

**WHAT TO WATCH on the first full-size video run: memory/RSS on the WEB service, not 429s.**
`VEO_TITLING_CONCURRENCY` is env-only and reversible with no deploy. Two harness bugs found by
revert-proving are worth remembering: a fixed-char-window source check kept matching code that
had been moved OUT of the permit, and a deadlock test HUNG rather than failed (an unsettled
promise with an empty event loop makes node exit silently with status 0, so the harness
"passed" while the semaphore was wedged). Timeout-race any concurrency assertion.

---

