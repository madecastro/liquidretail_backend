# RPD operations: money, recovery, telemetry, sharing

## Credentials (per person — nothing is shared in the repo)

| var | needed for | where a colleague gets it |
|---|---|---|
| `ATLAS_API_KEY` | `run --live` on any Atlas model (`google/…`, `xai/…`) | Render dashboard → WEB `srv-d1vuktqli9vc73ft07ng` env (secret), or their own local `.env`. Never print or commit |
| `GEMINI_VIDEO_API_KEY` (falls back to `GEMINI_API_KEY`) | `run --live` on any `gemini-*` model — **the current live path** | Render dashboard (adgen services) or local `.env`. `services/geminiVideoKey.js` resolves it and logs only a 4-char fingerprint — never the key. Never print or commit |
| `CLOUDFLARE_API_TOKEN` (+ `CLOUDFLARE_ACCOUNT_ID`) | `publish` | Cloudflare account with Pages write; the team project is `rs-rpd` |
| `MONGODB_URI` | **DB seed mode** — `spec.seed.productId`. Required for it; `lib/dbSeed.js:60` throws `MONGODB_URI is required for DB seed mode` without it, then connects and reads `CatalogProduct` + `Media` + `Brand`. Not needed when you paste a `spec.seed.url` by hand. | Same place as the other secrets; staging, never prod |

⚠️ **This row previously read "not needed — the harness never touches Mongo."
That was false and it cost a colleague real time.** The harness has TWO seeding
modes and only the first is Mongo-free:

| mode | Mongo | what you get |
|---|---|---|
| `seed.url` | no | one hand-sourced image; **fixture** brand styling in titling |
| `seed.productId` | **yes** | merchant-feed primary + the real reference stack (`sortCatalogMediasForReferenceStack`) + the product's REAL brand identity (logo, colours, font, preset) so a titled test looks like the real ad |

`seed.productId` is the mode worth using — a prompt A/B seeded from a
hand-picked URL is not testing what production actually sends.

`config/defaults.env` is dotenv-loaded automatically (process env wins). Fresh
checkout/worktree: run `npm install` first (the committed `node_modules` is incomplete).

## Money model — exact semantics

1. Dry-run is the default and spends nothing; it produces the full prompts, exact request
   bodies (Gemini cells show a redacted body — image bytes are fetched + encoded at submit
   time only, never during a dry run), and floor-grade estimates in `manifest.json`.
2. `--live` requires `--max-usd N`. Pre-flight: Σ estimates of all submittable cells ≤ cap,
   else the WHOLE run refuses (no silent trimming). Non-finite/missing estimate = the cell
   is refused. UNVERIFIED rates (Grok 1.5/1.0, Veo 3.1) run with a loud warning — keep first
   runs short.
3. Estimates are floors, not bills, **on both providers, for different reasons**. Atlas:
   measured Omni developer settles ~25% under formula at 4s ($0.45 vs $0.60) and ~33% under
   at 10s ($0.90 vs $1.20). Direct Gemini: no formula at all — `estimateCost` derives a
   floor from `VIDEO_TOKENS_PER_SEC` (measured, not published) and the real settled figure
   comes back as `usage.output_tokens_by_modality` on the SAME poll that reports completion
   (not a later reconcile, unlike Atlas). **Report only settled figures**
   (`costSource: "actual"` in the manifest); `"estimated"` means neither provider ever
   published a real one for that cell.
4. **Two structurally different billable calls, one per provider — know which one a cell
   used before reasoning about its money safety.**
   - Atlas: `atlasVideoService.submitGeneration` — production pacing (`pacedModelSubmit`),
     a structured-429-only retry loop (up to 4 attempts), `maxRedirects: 0`.
   - Direct Gemini: `geminiVideoService.submitGeneration` — **exactly one POST, no retry at
     all**. Gemini's own rate-limit surfaces on the FIRST POLL (`too_many_requests`), not on
     the submit response — the submit almost always returns 200 + an `interaction_id`
     regardless of whether the request will actually be honoured. **The charge point is an
     accepted id, not an HTTP status.** Porting Atlas's retry semantics onto this provider
     would double-bill; the harness does not.
   The harness never adds a retry loop of its own on top of either.
5. `predictionId` receipts (the field name is shared across both providers, so the rest of
   the harness — manifest, gallery, `resume`, `stats` — never needs to branch on which one a
   cell used) hit `manifest.json` (atomic tmp+rename) immediately after each submit returns,
   before any poll. A persistence failure aborts loudly with the receipt printed — it is
   never reclassified as a failed submit.
6. Known residual (same shape on both providers): a transport failure AFTER the provider
   accepted the POST leaves an ambiguous charge state. Cell shows `charged: null` = unknown
   = assume charged, UNLESS the provider's own error classification says otherwise (Gemini's
   errors carry a precise `billed: 'yes'|'no'|'possible'` the harness reads directly).
7. **Repeatability differs by provider.** Atlas's `gemini-omni` paramShape has a
   schema-confirmed `seed` field (default -1 = random) that production never sets — the
   harness exposes it as `spec.rngSeed` / `variant.rngSeed` so a prompt A/B can hold the
   model's own randomness fixed. **Direct Gemini has no seed parameter at all** — verified by
   reading `services/geminiVideoService.js`'s own `buildRequestBody`, not inferred. On that
   provider, "repeatable" means holding every OTHER input (prompt, exact reference bytes,
   duration/aspect/resolution) fixed and accepting the model's own run-to-run variance —
   never claim a Gemini comparison is seed-controlled.
8. **Concurrency is not coordinated with production, on either provider, and this matters
   more for Gemini.** Atlas's `pacedModelSubmit` is in-process pacing only. Direct Gemini's
   production path additionally holds a global per-(provider,model) lease
   (`services/geminiVideoLease.js`, cap shared with the live renderer) before every submit —
   the harness does **not** acquire this lease (it would require a live Mongo connection,
   which the harness deliberately has none of). A large concurrent Gemini batch run from this
   harness during active production traffic could contend for the same provider-side rate
   cap as real generations. Keep Gemini batches small/sequential, especially during business
   hours.

## Recovery — `resume`, never a second `--live`

`rpd resume <runDir>` is free and structurally cannot spend (the module imports only
poll/manifest code, for BOTH providers — pinned). It re-polls receipts, downloads outputs, reconciles settled
prices, runs the titling pass, rebuilds the gallery. A cell is **finished** when: receipt →
terminal-ok → `master.mp4` on disk → titling pass (if enabled). Settled price may lag without
blocking `done`. A completed prediction with zero outputs is `failed`, not finished.
Re-running `run --live` on the same spec is a NEW billable matrix — only do that when you
mean to generate again.

## Telemetry — what to read for forecasting

Per cell in `manifest.json` (`timings`) and the gallery's timings panel:

| field | meaning | measured reference point (2026-08-18, Omni dev 4s 1080p) |
|---|---|---|
| `promptBuildMs` | fixture → prompt | ~1ms |
| `seedProbe[]` | timed GET per prepared reference URL BEFORE submit — for Cloudinary crops the first fetch pays the on-the-fly transform, the same latency Atlas pays in production. `cache` header distinguishes cold vs warm; probes are de-duped across cells | cold 1044ms, 62KB |
| `submitMs` | POST round-trip incl. `pacedModelSubmit` spacing + any structured-429 backoff | 76ms first, 1182ms second (1123ms pacing) |
| `queueToTerminalMs` | submit → terminal prediction | 91s / 122s |
| `atlasExecutionTime` / `atlasTimings` | Atlas's own provider-side numbers | **published as 0 on Omni dev — unusable; rely on queueToTerminalMs** |
| `downloadMs` / `downloadBytes` | output fetch | ~120ms, 5.9–7.7MB |
| `titlingMs` / `titling.*` | Remotion wall clock + stage timings | first run pays the bundle; warm ~1–2min for 2 cells |

## Sharing learnings (do all three)

1. `rpd note <runDir> <cellId|run> "…"` — observations render in the gallery. LOOK at the
   output before writing them: extract frames (`ffmpeg -i cells/<id>/master.mp4 -vf
   "select='eq(n,0)+eq(n,45)+eq(n,90)',scale=270:-1,tile=3x1" -frames:v 1 strip.png`) and
   only claim what frames can show (motion smoothness needs the video, say so).
2. `rpd publish <runDir> --project rs-rpd` → per-deployment URL (`<hash>.rs-rpd.pages.dev`)
   is permanent; a fresh project 522s for ~2 minutes (propagation, not failure).
3. Append a row to `scripts/rpd/LEARNINGS.md` (date, spec, settled spend, deployment URL,
   one-line takeaway) and commit it on your branch. That file is the team's experiment index.

## Agent-loop recipe (bounded autonomy)

```
models → dry-run → inspect prompts/estimates → run --live --max-usd <user-set cap>
→ (interrupted? resume, never re-run) → frames → note → publish → LEARNINGS.md row
```

Never wrap `--live` in retry-on-error. Never invent a budget: the human sets `--max-usd`.
Keep `node scripts/verifyRpdHarness.js` green (30 checks) if you change the harness itself.
