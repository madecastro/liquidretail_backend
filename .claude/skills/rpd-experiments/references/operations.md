# RPD operations: money, recovery, telemetry, sharing

## Credentials (per person — nothing is shared in the repo)

| var | needed for | where a colleague gets it |
|---|---|---|
| `ATLAS_API_KEY` | `run --live` | Render dashboard → WEB `srv-d1vuktqli9vc73ft07ng` env (secret), or their own local `.env`. Never print or commit |
| `CLOUDFLARE_API_TOKEN` (+ `CLOUDFLARE_ACCOUNT_ID`) | `publish` | Cloudflare account with Pages write; the team project is `rs-rpd` |
| `MONGODB_URI` | not needed | the harness never touches Mongo |

`config/defaults.env` is dotenv-loaded automatically (process env wins). Fresh
checkout/worktree: run `npm install` first (the committed `node_modules` is incomplete).

## Money model — exact semantics

1. Dry-run is the default and spends nothing; it produces the full prompts, exact request
   bodies, and floor-grade estimates in `manifest.json`.
2. `--live` requires `--max-usd N`. Pre-flight: Σ estimates of all submittable cells ≤ cap,
   else the WHOLE run refuses (no silent trimming). Non-finite/missing estimate = the cell
   is refused. UNVERIFIED rates (Grok 1.5/1.0, Veo 3.1) run with a loud warning — keep first
   runs short.
3. Estimates are floors, not bills. Measured: Omni developer settles ~25% under formula at 4s
   ($0.45 vs $0.60) and ~33% under at 10s ($0.90 vs $1.20). **Report only settled prices**
   (`costSource: "actual"` in the manifest); `"estimated"` means Atlas never published one.
4. The only billable call is `atlasVideoService.submitGeneration` — production pacing,
   structured-429-only retry, `maxRedirects: 0`. The harness never adds retries.
5. `predictionId` receipts hit `manifest.json` (atomic tmp+rename) immediately after each
   submit returns, before any poll. A persistence failure aborts loudly with the receipt
   printed — it is never reclassified as a failed submit.
6. Known residual (same as production): an HTTP timeout AFTER Atlas accepted the POST leaves
   no id anywhere; that charge is unrecoverable at this layer. Cell shows
   `charged: null` = unknown = assume charged.

## Recovery — `resume`, never a second `--live`

`rpd resume <runDir>` is free and structurally cannot spend (the module imports only
poll/manifest code — pinned). It re-polls receipts, downloads outputs, reconciles settled
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
