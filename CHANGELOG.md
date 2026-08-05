# CHANGELOG — liquidretail_backend

Session-by-session history. **`session.md` is the live handoff and must stay trim** — anything
here is settled history and does not belong there. If you are looking for what is TRUE NOW,
read `session.md`; this file only answers "when did that change, and why".

Newest first.

## 2026-08-05

**Atlas Billing API reconciliation — the cost ledger was wrong in both directions and the total hid it.**

Measured live against production for 2026-07-01 → 08-05: video **$242.93** billed vs **$277.00**
ledgered (1.14x over), image **$72.44** vs **$33.48** (0.46x under), text **$69.62** vs **$70.68**
(1.02x). Grand total $384.99 vs $381.15 — **0.99x**. The category errors nearly cancelled, so the
top line looked healthy while per-day ratios ran **0.40x to 2.38x**. Every per-brand and per-ad cost
figure in the system was unreliable.

- **Atlas publishes `price` for video, and the estimate was 1.33x–5.33x high.** 6 of 6 recent
  settled predictions returned **$0.75**; the ledger only ever recorded $1.00 (141 rows) or $4.00
  (34 rows). `peekPrediction` now reads `price` back (same `{price, priceConfirmed}` contract as the
  image path — `priceConfirmed:false` means UNKNOWN, never "free"), `pollPrediction` reconciles on
  completion, and the charge-point row finally carries `providerRequestId`. Previously **all 175
  `atlas_video_render` rows had no prediction id**, so `reconcileCost` could not match one of them —
  6.3% coverage across all Atlas rows (212 of 3358). This is the follow-up `bootRecoveryService`
  explicitly deferred: *"VIDEO IS UNCHANGED ON PURPOSE … its own reviewed change."*
- The same window implies ~324 billable renders against 175 rows, so early-July video was never
  ledgered at all. An understatement partly cancelling an overstatement is how 0.99x hid both.
- **`reframe-outpaint` now records the real price.** `REFRAME_COST_USD` defaults to $0.08 (1k
  `-developer` tier) while `REFRAME_RESOLUTION` is 4k, which the readme prices at $0.16 — the
  constant's own comment warned to raise it together and it was not. 261 rows hold $19.56, plausibly
  ~$22 of the ~$39 image gap. Deliberately not hardcoded to 0.16; the stage reads the settled price
  and the reconciler will prove the default. Its prediction id is now captured too — there is no
  `Ad.veoPredictionId` equivalent for reframe, so the 261 existing rows can never be backfilled.
- **New:** `models/AtlasSpendDay.js` (integer micro-USD, idempotent upsert; note its
  `pre('validate')` does NOT run on bulkWrite, so writers must pass `key`),
  `services/atlasBillingClient.js`, `services/atlasSpendReconciler.js`. Registered on the worker
  hourly; balance is `backlogWatchdog` check 5.
- **Drift detection is per-category AND rolling.** A daily-only gate would never have caught the
  real bug: image ran 0.46x under for 35 straight days at ~$1.11/day, below any sane daily dollar
  floor on every one of them. Both gates require absolute **and** relative floors to trip.
- **Balance alerting is stateful on purpose.** The account **auto-refills $30 at a time** against
  ~$35/day burn, so `available` dips under $10 roughly daily as normal behaviour. A single-sample
  alert would be pure noise; it needs `ATLAS_BALANCE_LOW_STREAK` consecutive low reads ("refill
  stopped"), while `overdrawn > 0` / non-normal credit grant alerts on the first read. **No "days of
  runway" is published** — with auto-refill it is meaningless and it already caused one bad read.
- **Scope is load-bearing.** The account holds three keys; `Reach-Social Testing` and
  `ReachSocialLLMExpander` are unrelated projects, excluded from reconciliation via
  `ATLAS_BILLING_KEY_IDS`, but they drain the same prepaid pool (liquidretail = 53% of account
  spend), so balance/burn is account-wide. `scope=self` is unused — it only covers the
  authenticating key, so a second liquidretail key would read as ledger drift.
- **No HTTP route, deliberately.** Account-wide COGS behind the per-Advertiser `requireAuth` chain
  would be a cross-tenant leak. Inspection is `scripts/verifyAtlasBilling.js --live`.
- `CostLog` rows are **not** rewritten (owner decision): rewriting historical estimates in place
  would destroy the evidence of what went wrong. Atlas truth is stored alongside instead.
- Known gap, not addressed: **8406 of 10676 rows (79%) have no `costSource` field at all**, so
  `reconcileCost`'s `costSource:'estimated'` filter skips them. Alerts bucket provenance four ways
  (`actual`/`estimated`/`none`/*missing*) so that population is visible rather than silently absent.

## 2026-08-03

Prod moved `a80ae0b` → `f96e0a6` after 24 fixes had sat unpushed for a day, so every QC
observation before this date was made against a binary that was never deployed.

- **Zero-ads root cause fixed.** The Director's schema moved `media_picks` under `routing` (v3);
  the producer dual-read both shapes and logged `warnings=0` while **six** consumers still read
  the flat v2 location and discarded everything. Unified on `services/conceptProjection.js`.
  Verified live: `payloads=0` → `payloads=3`.
- **`/runs` double-charge closed.** It lacked the atomic `status:'queued'` claim `/generate` has;
  two clicks of "render next batch" billed Atlas twice for one ad.
- **Telegram → Slack**, delivery proven end-to-end by a real spend alert. The token had been
  sitting in a Render env GROUP with `serviceLinks: []`, reaching no process.
- **600-second status blind spot closed** on both render paths, piggybacked on existing poll
  ticks; verified live on video (`17s (1)` → `1m24s (5)`).
- **Untitled videos no longer reported as success** — and the fix caught a real failure on its
  first live run.
- **Grounded quotes printable again** (~82% of social proof) with attribution structurally
  stripped. `llm-web` is grounded Google Search, not fabrication; the defect was always the
  byline, including `vertexaisearch.cloud.google.com` printed as a customer 80 times.
- **Hero-image default** (`DIRECTOR_UNIVERSE_TOP_N` 10 → 1), per-product skip reasons,
  `GET /api/ads/formats`, 404 guard on unmatched ad paths, video quote gate, per-run Slack feed.
- **Docs corrected**, three false claims killed — including `CLAUDE.md` contradicting itself on
  video money in the section headed "violating these costs real cash".

## Earlier

- **2026-08-02** — Director reasoning quarantined; presets platform-grouped, Google frozen;
  `CLAUDE.md` §00 written; the video model corrected to **Omni, not Veo**; concurrency knobs to env.
- **2026-08-01** — measured 4 independent Omni submits for one campaign/product on the
  non-preset path.
- **2026-07-31** — static delivery geometry, fabricated proof and snippet inversion fixed;
  provenance found inert end to end; Render shell access set up.
- **2026-07-30** — static-ad diagnostics; the image-ref "photoreal polish" shadow stopped running.
- **2026-07-29** — Atlas facts verified: 720p and 1080p identically priced; Omni prompt cap
  20,000 chars; no image or video endpoint supports a system prompt.
- **2026-07-27** — video batch stalls diagnosed; Telegram alerting built (since replaced by
  Slack); reaper false-reap window closed.
- **2026-07-23** — pipeline cost/perf pass; `config/defaults.env` introduced.
- **2026-07-22** — generic sitemap + JSON-LD catalog scraper after the Living Spaces incident
  (livingspaces.com is not Shopify).
- **2026-07-21/22** — org repos stood up; SPA cutover to Netlify; Render backend live.
