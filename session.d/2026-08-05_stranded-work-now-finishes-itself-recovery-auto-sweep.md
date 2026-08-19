## 2026-08-05 (later) — STRANDED WORK NOW FINISHES ITSELF. Recovery + auto-sweep.

Owner, twice: *"they should all be finished automatically after a restart"*, then
*"I am still seeing all the ads in a queued state"*. Both true, and the cause was mine: **six
deploys between 19:31 and 19:55 killed their runs.** `runRenderLoop` lives in the web process,
which Render replaces on every deploy.

**PRs #92 (recovery), #96 (sweeper), #97 (claim-adapter fix). All merged, live on `d81aa7b`.**

### THE FACT THAT REFRAMES EVERYTHING: Atlas keeps a prediction 30 DAYS

Owner: *"it stores generations for 30 days so they should NEVER be lost."* Correct, and proven —
nine predictions killed mid-poll were **all still COMPLETED at Atlas hours later**, $0.5663
already billed, and **9/9 recovered into finished plates for $0**. I had called them
unrecoverable; that was wrong. The prediction ids were in the Render logs
(`atlasImage: submitted <id>`) the whole time.

**So a paid generation can only be lost by losing its pointer.** That is the whole invariant:
at the charge point, write BOTH the receipt (#86) and the ledger row (#91), and nothing is ever
unrecoverable or unaccounted.

### `finishPlate` — the extraction that unblocked everything

A static ad's Atlas output is **NOT a deliverable ad**: it still owes the delivery crop, the
logomark and the upload. That is why recovery could previously only *locate* an image, and why
`bootRecoveryService` can finish a VIDEO master directly but not a static.
`directImageRenderService.finishPlate` is now callable standalone. **PURE CODE MOTION** — diffed
103 lines in / 103 out, only `rawFrame` and `logoUrl` became parameters.
⚠️ **ONE IMPLEMENTATION, TWO CALLERS.** The render path and recovery both call it. Never copy
it: two copies of the delivery crop drift, and the failure is SILENT — a mis-cropped ad still
looks plausible while cutting through typeset copy.

### `services/imageRecoveryService` — peek → fetch → finishPlate → upload → persist

Two money invariants, harness-asserted: it **never submits** (only `peekImagePrediction`, a free
GET) and it **never stamps the raw Atlas URL onto `renderUrl`** (that would ship an uncropped,
unbranded image AS a successful render). Geometry comes from `computeSurface`, the live
derivation, so a recovered ad crops identically to a fresh one.

### `services/strandedRunSweeper` — RECOVER FIRST, REQUEUE SECOND

`processAlerts` requeues receipt-free `rendering` ads to `queued` on every SIGTERM and marks the
run failed; **nothing drained `queued`** (`bootRecoveryService` only handles `rendering` +
receipt). Now a web-process sweep does, every 10 min.

⚠️ **THE ORDER IS THE DESIGN.** A receipt-holding ad is already paid for — recovering costs $0,
requeuing buys it again. ⚠️ **AUTO-REQUEUE IS ONLY SAFE BECAUSE OF #86.** "Receipt-free" means
"unbilled" only where a receipt is written at the charge point; this morning an image could be
billed AND receipt-free. **Do not port this pattern to a path without a charge-point receipt.**

⚠️ **SCOPE — `queued` is ALSO the resting state of a freshly generated ad awaiting an operator
claim.** Sweeping those spends money nobody asked for. Qualifying needs ALL of: `queued`, a
`renderStage` breadcrumb (work BEGAN), a `failed` run, `STRANDED_SWEEP_MAX_AGE_H`(24),
`renderAttempts` < `STRANDED_SWEEP_MAX_ATTEMPTS`(3). Two kill switches —
`STRANDED_SWEEP_ENABLED` and `STRANDED_SWEEP_REQUEUE` — so auto-spend pauses without disabling
the half that saves money.

**VERIFIED LIVE:** `16 ad(s) stranded → 0 recovered ($0) · 16 requeued`, all 16 rendered, **0
still stranded**. Earlier the same day the 9 paid ones recovered 9/9 for $0 and, thanks to the
recency fix, landed at the TOP of the ads list.

### Three bugs my own harnesses missed, all caught by revert-proving or live runs

1. **Near double-count.** `recordFlatCost` INSERTS. Adding a charge-point row while leaving the
   outcome writes as inserts = two rows per submit. Fixed with `finalizeFlatCost` (update in
   place). I had written a comment asserting an upsert that did not exist.
2. **Silent ledger drop.** `finalizeFlatCost`'s fallback insert needs a COMPLETE record —
   CostLog requires `stage` and `persistCost` DROPS an invalid row. Recovery's partial meta was
   discarding the very spend it had just confirmed. It now refuses loudly.
3. **`claimAdsForRun` takes a MODEL ADAPTER, not an array.** The first live sweep threw
   `ads.updateMany is not a function`. Failed safely (before any submit) but stranded the ads
   another cycle. **The harness matched the call TEXTUALLY and passed while it was wrong** — a
   check that confirms a function is called but not that it is called CORRECTLY is barely a
   check.

### Still open

- **The ledger cannot say "unknown".** `renderError.charged` is `{Boolean, default:false}` and
  `renderService.js:1440` collapses a null (UNKNOWN) `policy.charged` to `false`. Needs a schema
  change. See `docs/ATLAS.md`.
- **The 9 recovered ads' template labels may be swapped within a surface** — nothing links a
  prediction to a template, so matching was by surface only. Same product, same surface, right
  creative; only the `ai_brand_led`/`ai_editorial` tag could be off.
- Backfill of the 9 ledger rows ($0.5663) — ids and confirmed prices are in this session's log.
- 600s image timeout has only 1.26x margin over the observed max (474.7s); consider 900s.

---

