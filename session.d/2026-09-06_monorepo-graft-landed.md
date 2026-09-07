# 2026-09-06 — monorepo graft landed (Stages 0–4); Stage 5–6 still pending

Survivor is `liquidretail_backend` (trunk `main`). `liquidretail_adgen` was
grafted at `adgen/` with history intact. Design:
`docs/research/2026-09-06_monorepo-consolidation-design.md`. **Live-state
record that supersedes the plan where they disagree:**
`/Volumes/Sayulita/Projects/RS/render-deploy-snapshot-2026-09-06.md`
(Stage 4 and Stage 5 sections).

## What landed

| stage | what | status |
|---|---|---|
| 0 | dotenv `__dirname`, snapshot file, `autoDeploy: no` on all six, Blueprint Auto-Sync off | done (max-shutdown-delay is dashboard-only and still unset — see snapshot) |
| 1 | CI baseline | done on the merge branch |
| 2 | subtree graft + siblingBackend parent + mongoose major-8 assert + yaml pin + freeze-N 512 + eslint ignore `adgen/**` | done |
| 3 | PR #402 merged as merge commit `e639391238eceb977d0b25b1f581690e3e4bd419` (11:26:06Z). Not a squash. | done |
| 4 | All four adgen services repointed at `Emami-RS-Project/liquidretail_backend` @ `main`, Docker context `./adgen`, dockerfile `./adgen/Dockerfile`, then deployed one at a time (api → orchestrator → renderer → titler) at `inflight 0`. All `live` on `e6393912`. | **done ~11:49Z** |

Stage 4 detail (from the snapshot, not re-derived here): api canary
`GET /health` 200 `{"ok":true,"role":"api","mongo":"connected"}`;
orchestrator singleton lease handoff with no split-brain; renderer two new
workers `inflight 0/32` `handoff ON`; titler four new workers `inflight 0/16`
`handoff ON`. Render SIGTERMs old instances ~45–65s after `live` — that is
the deploy-swap drain, not a crash.

## What is pending

**Stage 5 — dashboard-only, not started.** Option A (PATCH the existing
Blueprint's repo) is impossible: Render Blueprints have an immutable `repo`
after create (PATCH 404 `not found: blueprint file`). Creation and
disconnect are also not in the public API. Owner sequence:

1. Blueprints → "ad gen microservice" (`exs-da4bg861egvs73bnggl0`) →
   Disconnect/Delete. Docs-verified safe for the four services.
2. (Optional) New Blueprint Instance → repo
   `Emami-RS-Project/liquidretail_backend`, branch `main`, Blueprint Path
   `adgen/render.yaml`, Auto-Sync OFF.
3. At the preview, every one of adgen-api / orchestrator / renderer /
   titler must read **UPDATE**. If any reads **CREATE**, abort (duplicate
   renderer = double-bill).
4. Stopping after step 1 is a valid steady state. Stage 6 does not depend
   on step 2–4.

The old Blueprint stays `paused` on the dead adgen repo meanwhile — a
latent hazard (one sync would rewrite all four back to the old repo with
`autoDeploy: true`) but inert while paused.

**Stage 6 — not started, and it splits in two.** Re-arm `autoDeploy` only
after Stage 5 is settled (or after accepting dashboard-managed as the
steady state). `max-shutdown-delay` is still unset; future renderer deploys
must stay gated on `inflight 0` until it is, or a mid-Atlas-hold worker gets
25s drain against a 15 min hold.

- **6a — the four adgen services** can be re-armed as soon as Stage 5 is
  decided: what is deployed IS `main` (`e6393912`), so re-arming changes
  nothing until the next merge.
- **6b — backend web + worker** have NEVER deployed from a tree that
  contains `adgen/`. Their live image predates the graft. Do one manual,
  gated deploy of each from `main` first (worker only when idle — no
  catalog job, no DetectRun in flight) and confirm boot + health, THEN
  re-arm. Re-arming first would make the next unrelated merge the first
  monorepo deploy of the backend, unattended.

**Unrelated but observed the same night:** the YOLO detection service
(`srv-d2251qbe5dus73999u6g`, not part of the graft) degrades to a gunicorn
WORKER TIMEOUT → SIGKILL loop under the nightly catalog resync's detect
batches (~27 req/min against ~3 req/min of capacity). Pre-existing, not
caused by the graft or the YOLO repo cutover — timeline and evidence in the
snapshot's YOLO section. Capacity / rate-limit fix is a product decision.

**Freeze still in effect:** `autoDeploy: no` on all six services.

**Rollback per adgen service:** PATCH `repo` back to
`https://github.com/Emami-RS-Project/liquidretail_adgen`, `branch: master`,
`dockerContext: .`, `dockerfilePath: ./Dockerfile`, then deploy. That
GitHub repo is intact/writable (`archived:false`). Or Render
rollback-to-previous-deploy (cached image). Never flip
`ADGEN_RENDERER_ENABLED=false` as merge rollback.

## Docs/hooks (this worktree)

Stage 7 of the design: root `.claude/` SessionEnd hook covers the grafted
tree (one git-repo-wide `auditStrandedWork.js`); `adgen/.claude/` is
inert; root + `adgen/CLAUDE.md` + this file record the new shape.
`adgen/session.md` is superseded by the root `session.md`.
