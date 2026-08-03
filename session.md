# session.md — liquidretail_backend

Handoff for the next session. **Rewritten 2026-08-03.** This file had grown to ~760
lines of chronological accretion; it is now organised by *what is true* rather than
*what happened when*. History is compressed at the bottom — anything not listed there
was judged superseded and dropped **deliberately**, not lost.

## Next-session prompt

_(empty — no pending owner prompt)_

---

## 1. CURRENT STATE

**Live prod = `ab255f4`** on both services. Verify suite = **29 scripts, all green**.
Frontend `master` carries the Render Activity board + format catalog.

Before today prod ran `a80ae0b` while 24 fixes sat unpushed — **any observation
recorded before 2026-08-03 may describe a binary that was never deployed.**

| area | state |
|---|---|
| Zero-ads root cause | **FIXED + verified live** — `payloads=0` → `payloads=3`, 3 ads rendered |
| Director concept contract | 6 consumers unified on `services/conceptProjection.js` |
| Hero-image default | `DIRECTOR_UNIVERSE_TOP_N` 10 → **1**; ceiling 10, multi-image wired |
| Per-product reasons | on `CampaignRun`, returned by `GET /api/ads/runs/:runId` |
| Stage instrumentation | both paths, piggybacked on existing polls |
| Untitled video | no longer counted as success |
| `/runs` atomic claim | double-charge closed, 67 checks |
| Slack alerting | **live and PROVEN** — a real spend alert was delivered end-to-end |
| Slack per-run feed | built (`services/runFeedService.js`), **not yet observed on a live run** |
| Grounded quotes | printable anonymously; attribution structurally stripped |

---

## 2. NEXT, in priority order

Owner-set: **production quality first, money hardening after output is proven.**

1. **1-in-3 static ads carry a competitor-shaped brand mark.** Verified visually
   2026-08-03: a tree emblem reading as Timberland on an Allbirds shoe. Prompts already
   demand fidelity (`staticAdIntents.js:261-264,423`), so the fix is **measure-and-reject
   (OCR/vision), not prompt tuning**. Check whether `gpt-image-2/edit` supports
   `input_fidelity` against the LIVE schema — the param exists in
   `atlasImageService.js:433,463` for other models.

2. **BUILD ANCHORED STEPWISE REFINEMENT — decided, proven, never built.**
   *Restored 2026-08-03 after being wrongly dropped in a handoff cleanup: it sat under a
   dated heading and was misread as history. It is a completed experiment with a decided
   outcome and an unbuilt instruction.*

   `gpt-image-2/edit` on Atlas is **stateless** (live schema: `images`, `prompt`, `size`,
   `quality`, `output_format`, `moderation` — no turn/conversation id), so stepwise MUST
   re-supply the previous render. Flat **$0.01 per prediction regardless of input count —
   anchoring is free.**

   A/B across 4 difficulty rungs, pure vs anchored, on a Gymshark duffle. At the hard rung
   (reposition) **anchored held product fidelity** — front-on like the catalogue, both cream
   end panels, crisper GYMSHARK arc — while **pure drifted** (three-quarter angle, one
   panel, reshaped).

   Build **anchored** = previous render + product photo, **product photo authoritative**,
   plus a "start over from product photo" control.

   **Now higher priority than when written:** item 1 is the model redrawing on-product brand
   marks wrongly. Anchoring keeps the real product photo authoritative at every step, so it
   is plausibly a large part of that fix — and it is already proven and free.

   Bonus finding from the same test, still unaddressed: the duffle rendered maroon and the
   product IS maroon, so the ad's quote *"the perfect vibrant pink"* was a **fabricated
   claim**, not a render bug.

3. **The video path is STILL NOT TESTED.** Two attempts on 2026-08-03 did not exercise Omni:
   the second was deduped by `identityDigest` ("all 1 creative(s) already queued") before any
   billable submit. Five changes are live and unproven on video — poll-tick instrumentation,
   the untitled-video honesty fix, the intermediate `draft` money guard, the video quote gate,
   and `veoStoryboardService` finally receiving a non-blank archetype/hook. **Use a product
   with no existing Reels ad, or a fresh campaign, or dedupe will swallow it again.**

4. **`perProduct` over-reports.** It says `"Queued 1 creative(s)"` with `payloads: 1` while the
   run-level message correctly says *"all 1 already queued"* — it counts payloads BUILT, not
   ads INSERTED. Two contradictory statements in one response. Introduced 2026-08-03.

5. **Meta preview chrome shows "Lorem ipsum dolor sit amet"** as the link description.

6. **Post-render safe-box measurement.** Geometry is computed and stated correctly; nothing
   verifies the model complied.

7. **Logo contrast/scrim.** Lower than previously recorded — it did NOT reproduce at full
   resolution on 2026-08-03 (an earlier call off a low-res thumbnail was wrong). Still worth a
   scrim (`directImageRenderService.js:758-781` has no plate sampling); not a blocker.

8. **Deferred by owner until output is proven:** `queued` ads never auto-drain;
   `veoPredictionId` is a spend receipt never resumed, so process death + re-drain double-bills.

---

## 3. TRAPS — verified, do not re-derive

- **`mongoose.isValidObjectId('video-models') === true`.** Any 12-byte string casts, so the
  `router.param` guard cannot protect a 12-char route name — **route ORDER** protects named
  routes. Keep them above `/:id`.
- **Director fields nest under `routing` (v3).** Never read `concept.media_picks` directly; use
  `conceptField()`/`conceptMediaPicks()`. `verifyConceptContract.js` scans `services/` and
  `routes/` and fails if you don't.
- **The "Liquid Retail" Render env GROUP has `serviceLinks: []`** — nothing in it reaches any
  process. That is why Slack was silent with a valid token sitting in it. **Do not link the
  group**: it also carries `MONGODB_URI` and Cloudinary secrets that could shadow service-level
  values. `SLACK_BOT_TOKEN` is set service-level on both services.
- **Slack returns HTTP 200 with `{ok:false}`** on logical failure.
- **`SLACK_ALERT_CHANNEL_STATUS` now drives the per-run feed** (`services/runFeedService.js`).
  `onStage` is a SYNCHRONOUS buffer with a detached flush and must stay that way — it sits
  where Atlas is already billed.
- **`node_modules` is partially tracked and missing `https-proxy-agent`** — a fresh checkout
  fails MODULE_NOT_FOUND before any test runs.
- **`RENDER_CONCURRENCY` is 4 at boot but 8 in `defaults.env`** — a dashboard var shadows it.
- **Spend figures are calibrated against two errors in opposite directions:** video cost was
  overstated ~4x in `defaults.env`/`backlogWatchdog.js` (now corrected), while
  `atlasImageService.js:414` notes the image catalog estimate **understates by ~6x**. Re-tune
  `ALERT_HOURLY_SPEND_USD` against measured CostLog before trusting it.
- **I pointed a new `quote-snippet` role at `openai/gpt-5-nano` after confirming it was LISTED in the Atlas catalog. It is **listed but NOT routable** — HTTP 400 "router not found" — so every snippet call would have silently degraded to mechanical truncation. PR #34's benchmark caught it and moved the role to `google/gemini-2.5-flash-lite`. Verify a model ROUTES, not just that it exists.**

---

## Ops access — live Render shell + logs (set up 2026-07-31)

You can now get a shell **inside the running production service** and read its logs
without the dashboard. Use this instead of guessing at prod state.

**Services** (workspace `Reach-Social`, region oregon, both on branch `main`):

| alias | service | id | plan |
|---|---|---|---|
| `backend` | `liquidretail-backend` web | `srv-d1vuktqli9vc73ft07ng` | pro_plus |
| `worker` | `liquidretail-backend-yjmx` background worker | `srv-d8128c1o3t8c73e8kb30` | pro |

**Shell — `~/bin/render-ssh <alias> '<cmd>'`** (on PATH):

```bash
render-ssh backend 'echo $RENDER_GIT_COMMIT; ls -la uploads | head'
render-ssh worker  'ps aux | head'
render-ssh backend                       # no cmd -> interactive shell
```

App root is `/opt/render/project/src`, node v22.23.2, user `render`.

**Why the wrapper exists — do not "simplify" it away.** Render's SSH gateway is
**interactive-only**: it accepts publickey auth and then closes the channel on an
`exec` request, so plain `ssh <srv>@ssh.oregon.render.com 'cmd'` always dies with
`Connection closed by remote host` — and `-tt` alone does **not** fix it. The wrapper
allocates a real PTY via `script(1)`, feeds the command over stdin, fences output with
markers to strip prompt/echo noise, and propagates the remote exit code. `render ssh`
(the CLI) is interactive-only too, by its own `--help`.

`~/.ssh/config` also has `render-backend` / `render-worker` aliases, but those are for
**interactive** shells only, same reason.

**Command length limit — bit me, now guarded.** The remote PTY is in canonical mode with a ~1KB
input line buffer. A longer single line is silently truncated, leaving the remote shell blocked on
an unterminated quote: the session hangs to timeout with **zero output**, which looks exactly like
a network fault. Cost real time inlining a base64'd diagnostic script. The wrapper now refuses
commands over 900 chars with a clear message. To run a real script on the instance, have the remote
fetch it rather than inlining it. Also note `node` resolves `require()` from the **script's**
directory, not cwd — a script in `/tmp` cannot see the app's `node_modules` (from
`/opt/render/project/src`, `require('mongoose')` takes 193ms and works fine).

**Auth.** Dedicated key `~/.ssh/render_ed25519`
(`SHA256:I+6baPoiIguPGND0d01/ZoN4VtQLW8fnbPkSnZ0HH6A`), registered on the Render
account as **"claude-code-diagnostics (The-Box)"**. Deliberately separate from the
`nicknsheth-beep` GitHub key so it can be revoked on its own — Account settings → SSH
Public Keys. The public API has **no** ssh-keys endpoint (404); key registration is
dashboard-only.

**Logs — works non-interactively, no SSH needed:**

```bash
render logs --resources srv-d1vuktqli9vc73ft07ng --limit 50 --output text --confirm
```

Add `--text <substr>`, `--level error`, or `--tail` to narrow. `render psql` is
available if a Render Postgres is ever added (workspace currently has 4 services, no
managed DB). CLI tokens expire **7 days** after creation — on auth failure run
`render login`.

### Keys and ids

- Render API key: `~/Documents/API Keys/Claude_Reach_Social_Key.txt` (`rnd_`). Env group
  `evg-d21udjm3jp1c738b17lg`, owner `tea-d1ved76mcj7s73fad3og`.
- The Render **API** is faster than the SSH wrapper for deploys, env vars and logs:
  `GET /v1/services/{id}/deploys`, `/env-vars`,
  `GET /v1/logs?ownerId=…&resource=…&startTime=…&endTime=…`. Logs are ~95% HTTP access lines —
  filter out `clientIP=` to see application output.
- **Never run two write-capable agents against this repo at once.** A concurrent Grok job
  silently overwrote a `session.md` rewrite between the edit and the commit on 2026-08-03.

---

## 5. KNOWN-OPEN, not started

- Video multi-surface fan-out (§00 Phase 3) — intent only.
- `RENDER_AUTH_TOKEN` logs `EXPIRED` at every boot (dead `renderViaSpec` path).
- `npm error could not determine executable to run` during postinstall — non-fatal.
- Dead HTML/canvas paths read `author_name` with no re-gate (`aiCanvasSpecService`,
  `layoutResolverService`, `aiCanvasInputBuilder`) — commented, NOT fixed.
- Reels 204 vs Stories 250 safe zones collapse into one `vertical` entry in
  `remotion/lib/safeZones.js`.

---

## 6. ARCHIVE — one line per prior session

- **2026-08-02** — Director reasoning quarantined; presets platform-grouped, Google frozen;
  CLAUDE.md §00 written; video model corrected to **Omni, not Veo**; concurrency knobs to env.
- **2026-08-01** — measured 4 independent Omni submits for one campaign/product on the
  non-preset path.
- **2026-07-31** — static geometry, fabricated proof and snippet inversion fixed; provenance
  found inert end-to-end; Render shell access set up.
- **2026-07-30** — static-ad diagnostics; the image-ref "photoreal polish" shadow stopped.
- **2026-07-29** — Atlas facts verified: 720p and 1080p identically priced; Omni prompt cap
  20k chars; no image/video endpoint supports a system prompt.
- **2026-07-27** — video batch stalls diagnosed; Telegram alerting built (now Slack); reaper
  false-reap window closed.
- **2026-07-23** — pipeline cost/perf pass; `config/defaults.env` introduced.
- **2026-07-22** — generic sitemap + JSON-LD catalog scraper after the Living Spaces incident.
- **2026-07-21/22** — org repos stood up; SPA cutover to Netlify; Render backend live.
