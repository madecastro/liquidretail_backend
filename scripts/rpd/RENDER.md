# Running the RPD harness on Render

**Short answer: yes.** Everything the nightly loop needs is already on the
`liquidretail_backend` Render services — verified live against the Render API on
2026-08-18. One credential and one new service are missing, and one property of
Render changes the design.

## What is already there

| credential | WEB `srv-d1vuktqli9vc73ft07ng` | WORKER `srv-d8128c1o3t8c73e8kb30` |
|---|---|---|
| `ATLAS_API_KEY` | ✅ | ✅ |
| `CLOUDINARY_API_KEY` / `_SECRET` | ✅ | ✅ |
| `SLACK_BOT_TOKEN` | ✅ | ✅ |
| `GEMINI_API_KEY` | ✅ | ✅ |
| `MONGODB_URI` | ✅ | ✅ |
| `CLOUDFLARE_API_TOKEN` | ❌ | ❌ |
| `NETLIFY_AUTH_TOKEN` | ❌ | ❌ |

`CLOUDINARY_CLOUD_NAME` is not a dashboard var and does not need to be — it is
committed in `config/defaults.env` as `reach-social-prod`.

**ffmpeg is not a blocker.** `rpd eval` extracts video frames and the r2v guard
uses `ffprobe`. Render's node image has no ffmpeg, but `@remotion/compositor-*`
**ships both binaries** — verified locally in
`node_modules/@remotion/compositor-darwin-arm64/{ffmpeg,ffprobe}`, and npm
installs `@remotion/compositor-linux-x64-gnu` on Render, which carries the same
pair. Nothing to apt-install. (Static-only nights need neither.)

## The one property that changes the design: the disk is ephemeral

`manifest.json` **is the spend ledger**. On a laptop the disk outlives the
process, so flushing a receipt to disk before polling is enough. On Render the
filesystem is discarded when the job exits or is evicted — so a crash mid-poll
would lose the receipt entirely, and **a receipt nobody holds is money that can
never be reconciled or recovered.** `rpd resume` cannot help: it reads the run
directory, which is gone.

`scripts/rpd/loop/render-nightly.sh` exists for exactly this and differs from
`nightly.sh` in four ways:

1. **Receipts leave the box immediately** — `RPD_RECEIPT_SLACK=1` posts every
   `predictionId` to Slack at the charge point, before the poll. Fire-and-forget
   and never awaited: a Slack outage must not sit on the critical path of a
   submit that has already been paid for.
2. **Artifacts *and* the ledger are mirrored** — `--upload` sends the media plus
   `manifest.json` (as Cloudinary `resourceType: 'raw'`) to
   `liquidretail/rpd/<runName>/`. The ledger uploads *after* the cells so it
   carries their `uploadedUrl`s.
3. **It fails closed.** Missing `ATLAS_API_KEY`, either Cloudinary secret,
   `SLACK_BOT_TOKEN` or `RPD_SLACK_CHANNEL` → refuse to run. Spending on a host
   that cannot keep the evidence is worse than not running.
4. **No per-day stamp file** (a fresh disk defeats it), so **the schedule is the
   only dedupe — keep it to one fire per day.**

Pinned by `verifyRpdHarness.js` section H, revert-proven on all three.

## Current state: LOCAL. Render is one command away.

The nightly loop runs on the owner's Mac via launchd
(`com.reachsocial.rpd-nightly`, 02:17 daily, `$2` cap) — verified firing the exact
scheduled command. Nothing is deployed to Render yet, deliberately.

⚠️ **The launchd job points at the WORKTREE** (`.worktrees/rpd-harness`), because
that is the only checkout containing the harness until PR #212 merges. **After the
merge, repoint it at the normal checkout** — otherwise removing the worktree breaks
the schedule. Until then it fails loudly rather than silently (`no such file or
directory` in `/tmp/reachsocial-rpd-nightly.err`), which is how the original
mis-pointing was caught.

### Deploying to Render, when you want it

```bash
# set the secrets in your shell, then:
./scripts/rpd/loop/render-create-cronjob.sh --dry   # show the payload, apply nothing
./scripts/rpd/loop/render-create-cronjob.sh         # create the service
```

It **refuses** unless `ATLAS_API_KEY`, both Cloudinary secrets, `SLACK_BOT_TOKEN`
and `RPD_SLACK_CHANNEL` are present, so the service can never exist in a state
where it spends money but cannot keep its receipts. Optional
`NETLIFY_AUTH_TOKEN` + `RPD_NETLIFY_TEAM` add gallery publishing. Secret values are
copied onto the service and redacted in `--dry` output.

No `render.yaml` on purpose: the existing WEB and WORKER services are
dashboard-managed, and introducing a Blueprint would pull them under file control
as a side effect of adding a cron job.

## What the service looks like

A **Render Cron Job**, separate from WEB and WORKER. Separate on purpose:
experiment spend and a harness bug stay away from the production render queue,
and only this service holds a Netlify token.

Dashboard → **New → Cron Job**:

- **Repo/branch:** `liquidretail_backend`, `main`
- **Build command:** `npm install`
- **Command:** `./scripts/rpd/loop/render-nightly.sh`
- **Schedule:** `17 2 * * *` (02:17 UTC — off the hour on purpose)
- **Env:** add `RPD_SLACK_CHANNEL`, and copy `ATLAS_API_KEY`,
  `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `SLACK_BOT_TOKEN` from WEB.
  Optional: `RPD_MAX_USD` (default 2), `RPD_EVAL_MAX_USD` (0.5),
  `MONGODB_URI` only if a spec uses `seed.productId`.
  **To publish galleries from Render:** `NETLIFY_AUTH_TOKEN` (a Personal Access
  Token from the account that owns **Flood QRF**) plus
  `RPD_NETLIFY_TEAM=decastro-mark85`. The token *is* the account selector, so no
  `netlify switch` and no interactive login — which is the only thing that works
  on a hosted runner. `RPD_PUBLISH_HOST` defaults to `netlify`; set it to
  `cloudflare` (with `CLOUDFLARE_API_TOKEN`) to go back to Pages.

Deliberately **not** committing a `render.yaml`: the existing services are
dashboard-managed, and introducing a Blueprint would put them under file control
as a side effect of adding a cron job. Create this one in the dashboard.

## What it costs

A Render cron job bills for its run minutes only. The Atlas spend is capped by
`RPD_MAX_USD` (default `$2`) exactly as locally — and note the measured curve
(`$0.15 + $0.075/s` for Omni developer) means `MODEL_CAPS` over-estimates by 33%,
so a `$2` cap really authorises ~$2.67 of generation.

## What still only works locally

- **`LEARNINGS.md` appends.** A cron job has no writable checkout and must not
  push to git. On Render the Slack summary is the record; a human promotes
  anything worth keeping into `LEARNINGS.md` by PR.
- **Remotion titling.** Proven possible (the WEB service warms Remotion), but it
  needs the browser install at build (`scripts/ensureRemotionBrowser.js`) and
  more memory than a static night. Leave `titling.enabled: false` in the
  candidates spec until you actually want titled output from Render.
- **The weekly model-intel scout** lives in `claude-org-brain` and commits its
  findings, so it wants a writable checkout — keep it on the Mac (launchd) or give
  it a deploy key before moving it.
