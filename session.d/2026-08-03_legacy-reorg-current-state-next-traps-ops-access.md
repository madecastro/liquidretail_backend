## 1. CURRENT STATE

**Live prod = `ab255f4`** on both services. Verify suite = **29 scripts, all green**.
Frontend `master` carries the Render Activity board + format catalog.

Before today prod ran `a80ae0b` while 24 fixes sat unpushed — **any observation
recorded before 2026-08-03 may describe a binary that was never deployed.**

| area | state |
|---|---|
| Zero-ads root cause | **FIXED + verified live** — `payloads=0` → `payloads=3`, 3 ads rendered |
| Director concept contract | 6 consumers unified on `services/conceptProjection.js` |
| Default image seed (COUNT) | `DIRECTOR_UNIVERSE_TOP_N` 10 → **1**; ceiling 10, multi-image wired. TOP_N=1 is the count only — it does NOT select which image |
| Default image seed (SELECTION) | **NEW 2026-08-03:** `seededUniverseService.promoteFirstCatalogImage` + opt-in `preferFirstCatalogImage`, passed from `runConceptDrivenExpansion` for image runs with no operator picks. Rule is **"the first image that came from the catalog"**, not the `imageRole:'hero'` label (owner amendment same day: the label could leave an unstamped catalog set falling through to the shotType ranking, where a UGC post won). 3-tier cascade, every tier gated on `role==='catalog'` so it can never resolve to UGC: `imageRole==='hero'` → earliest-`createdAt` catalog entry → no promotion. Mirrors the video rail's cascade at `campaignAdsGenerationService.js:2085`. Auto-assembly branch only — `restrictToMediaIds` (operator override) and brand-only mode untouched. `scripts/verifySeededUniverseHeroDefault.js` = **111 checks**, revert-proven; suite 42 scripts, 42 green (re-measured 2026-08-03) |
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

3. **VIDEO PATH CANNOT COMPLETE — Remotion titling fails on every run.**
   Tested end-to-end 2026-08-03 (`run_1785731053755_32f1569f`, Women's Breezer Point Warm
   Red, meta_reels_9_16). Omni generated AND uploaded the master successfully; **titling
   then failed**:

   ```
   Could not extract frame from compositor  Error: Request closed
     at @remotion/renderer/dist/offthread-video-server.js:99
   ```

   **The font errors in that log are a RED HERRING.** `font load failed for Inter … — using
   fallback stack` is explicitly non-fatal and it recovered; the compositor failure is the
   fatal one. Chasing the font 404 first would waste a session. (Cosmetic but confusing:
   boot logs `fontLoader: 16 downloaded → services/brandScripts/assets/fonts` while Remotion
   serves `/fonts/Inter.ttf` from its own asset server — a path mismatch.)

   Until fixed, the video path produces a PAID master and no titled deliverable.

   **PROVEN by the same run:**
   - Poll instrumentation on video: `17s (1)` → `1m24s (5)`, `stageAgeSec` cycling under the
     15s interval — the stage is genuinely rewritten each tick.
   - Titling honesty: `status:'failed'`, `stage:'master rendered; titling failed'`,
     `failed:1 / ok:0`. Before today: `draft`, counted **succeeded**, console.warn only — an
     untitled ad reported as a win.
   - Money guard: the paid Omni master was **KEPT** (`assetUrl` present), not discarded and
     not left to a reaper requeue + second submit.

   **Still unproven** (titling died before chrome rendered): the video quote gate admitting an
   anonymous testimonial into Remotion chrome.

4. **TITLING IS BROKEN IN THREE SEPARATE WAYS — all found 2026-08-03, all silent.**

   **(a) FATAL: Remotion cannot extract frames.**
   `Could not extract frame from compositor / Request closed`
   (`@remotion/renderer/dist/offthread-video-server.js:99`). Every video run yields a paid
   master and NO titled deliverable. Fix this first — nothing else about video is observable
   until it completes.

   **(b) EVERY TITLE RENDERS IN THE WRONG TYPEFACE — a one-word directory mismatch.**
   ```
   services/fontLoader.js:31           .../brandScripts/assets/fonts      ← boot downloads 16 fonts HERE
   services/fontResolverService.js:26  .../brandScripts/assets/webfonts   ← Remotion serves /fonts/* FROM HERE
   ```
   `fonts` vs `webfonts`. The asset server maps `/fonts/<file>` → `FONT_CACHE_DIR`
   (`remotionRenderService.js:149-150`) which is the **webfonts** dir — empty. Result: 404 +
   CORS, and `FontLoader.jsx:39-41` **catches it and continues with a fallback stack**. Inter
   never loads.

   The boot line `🔤 fontLoader: 16 downloaded, 0 cached, 0 failed` is reassuring and
   meaningless — it fills a directory the live renderer never reads. I initially dismissed
   this as a red herring; it IS a red herring for the crash, but it is a real permanent
   typography defect on its own.

   **(c) SAFE ZONES DO NOT RECONCILE — two sources of truth, ~2.7x apart.**
   ```
   platformFormats.js:75   meta_reels_9_16    safeArea top 204 / bottom 204   (px, real surfaces)
   platformFormats.js:101  meta_stories_9_16  safeArea top 250 / bottom 250
   remotion/lib/safeZones.js:10   vertical: { top: 0.14, bottom: 0.35 }  ← ONE entry for BOTH
   ```
   Reels and Stories collapse into one `vertical` key, so Stories' 250px reserve renders against
   Reels' geometry. And the numbers disagree outright: `bottom: 0.35` on 1080x1920 is **672px**
   vs a declared 204/250px reserve. Remotion uses Meta community-consensus FRACTIONS;
   `platformFormats` declares PIXEL reserves from the actual surfaces, and nothing reconciles
   them. The 0.35 is deliberately conservative (its comment cites Meta's bottom-40% legal-text
   rule), so titles probably do not breach — they are likely floating far higher than necessary
   and wasting the frame. `platformFormats.safeArea`, the value derived from real surfaces, is
   not what the renderer uses. This is session.md's old "Build B: safe-zone unification" and it
   is live, not theoretical.

5. **THE VIDEO PROMPT IS DELIBERATELY CAMERA-ONLY — and the Director is OFF for video.**
   *Corrected 2026-08-03 after I got this wrong.* I initially reported that the video prompt
   uses "3 of the Director's 13 routing fields" and should be passed `art_direction`. **That
   is wrong for the live path.** The owner confirmed the Director is disabled for video and a
   canonical prompt is used, and the code agrees:

   - `meta_video` goes through `expandDeterministicVideo` — deterministic, no concept expansion.
   - `atlasVideoService.js:2593` — *"Camera-only prompt — the canonical brand-script overlay
     composites all on-screen text downstream from ad.copy + LayoutInputArtifact."*
   - `buildVeoPrompt` takes `{brand, product, media, layoutInput, sourceMedia, aspectRatio,
     seedHasText, hasProductReference, storyboard, caps, durationSec}` — **no Director concept.**

   So `veoStoryboardService`'s `conceptField` reads only matter where a storyboard is built
   from a concept; they are not the deterministic path's prompt source.

   **The real levers**, three-tier priority at `atlasVideoService.js:2595-2620`:
   | tier | source | behaviour |
   |---|---|---|
   | 1 | `operatorPrompt` (regenerate) | prepended to canonical |
   | 2 | `ad.videoPromptRaw` | FULL replacement — warns "canonical directives bypassed" |
   | 3 | guidance cascade (`videoPromptGuidance`) | prepended to canonical |

   Both are already plumbed through `expandDeterministicVideo` (`:1823-1824`) and exposed in
   the wizard as "Video prompt guidance" and "Advanced — raw prompt". **Prefer guidance
   (tier 3)** — raw replacement discards the canonical camera mechanics.

   So the prompt is generic BY DESIGN (text is composited downstream by titling), not because
   fields are missing.

   **OWNER DIRECTION 2026-08-03 — TWO PARTS, do not conflate them:**

   *When the toggle is OFF (the default, and today's focus):* tune the CANONICAL prompt.
   Verbatim: *"we may choose to use more archetypes and create them in the future, but right
   now we want to get it right with the canonical prompt."*

   *When `directorVariants` is ON:* verbatim — *"I think when it is on it should drive
   everything considering the images it is provided."* So the intended behaviour is that an
   enabled Director drives the CAMERA PROMPT too, not just concept selection. **This reverses
   `docs/PIPELINES.md:452` / PR #11** ("Director does not drive video titling or the camera
   prompt"), which documents the CURRENT code, not the target. Do not delete that line — it is
   accurate today; mark it as superseded-by-intent when the toggle-on path is built.

      **Original wording:** *"we may choose to use more archetypes and create them in
   the future, but right now we want to get it right with the canonical prompt."* So the work
   is TUNING THE CANONICAL PROMPT, not re-enabling the Director for video and not plumbing
   concept fields into it. Treat archetype-driven video as explicitly deferred, not missing.

   Practical consequence: iterate via `videoPromptGuidance` (tier 3, prepend — keeps the
   canonical camera mechanics) and by editing the canonical directives in `buildVeoPrompt`
   itself. Reach for `videoPromptRaw` only to A/B a wholesale alternative, since it bypasses
   the canonical directives entirely and warns when it does.

   **You cannot evaluate any of this until item 3 is fixed** — every run currently yields a
   paid master with no titled output, so prompt changes are unobservable. If per-concept video variation is wanted again, that is a decision to
   re-enable the Director for video, not a field-plumbing fix.

4. **`perProduct` over-reports.** It says `"Queued 1 creative(s)"` with `payloads: 1` while the
   run-level message correctly says *"all 1 already queued"* — it counts payloads BUILT, not
   ads INSERTED. Two contradictory statements in one response. Introduced 2026-08-03.

6. **VIDEO COST IS NEVER RECONCILED — the expensive path runs on a guess.**
   Images ARE reconciled: `scheduleCostReconcile` (`atlasImageService.js:134-157`) polls
   `GET /model/prediction/{id}` at 3s/10s/30s, reads `res.data.data.price` — the ACTUAL
   Atlas price — and flips the CostLog row from `costSource:'estimated'` to `'actual'`,
   logging "never published" if it gives up. **`reconcileCost(` has exactly ONE call site
   in the repo** and it is the image one. `atlasVideoService` calls `recordFlatCost` at
   `:1571` and `:2671` with a pre-computed estimate and never revisits it.

   So the ledger holds ACTUALS for images (~$0.01-0.17) and ESTIMATES for video (~$1.00
   a clip). The path where being wrong costs real money is the un-reconciled one.

   The fix is small: the video path already persists `veoPredictionId` at the charge point
   (`atlasVideoService.js:2666`), which is exactly the handle `scheduleCostReconcile` needs.
   Same three-line pattern, pointed at the video prediction endpoint.

7. **ALLOW EXPLICIT VIDEO REGENERATION — owner-approved 2026-08-03, reversing an earlier
   owner call.** `computeV2IdentityDigest` (`campaignAdsGenerationService.js:1685-1704`)
   scopes the digest to `generationRunId` for STATIC but deliberately EXCLUDES video, citing
   the owner: *"veo should only generate a video once for each product unless it is revised"*
   — so a repeat Generate cannot re-bill an Omni master.

   The owner has now reversed this: *"if there is an existing ad it shouldn't stop anyone
   from running one again"*, with the reason being that **video prompt iteration is the
   current workflow** — re-running the same product with a different prompt is normal, not
   accidental.

   Approved design: scope the video digest to the run **only when regeneration is explicit**.
   A plain repeat Generate still dedupes (accidental double-click protection intact); an
   operator who explicitly asks for another video gets one, and the spend is deliberate.
   Do NOT simply delete the video carve-out — that reopens the $1.00-per-misclick hole the
   original owner instruction was protecting against.

8. **`input_fidelity` DOES NOT EXIST on `gpt-image-2/edit`** — checked against the LIVE Atlas
   schema 2026-08-03. Accepted params are exactly: `enable_base64_output`, `enable_sync_mode`,
   `images`, `moderation`, `output_format`, `prompt`, `quality`, `size`. Do not go looking for
   it again. This leaves only THREE levers for product fidelity: more/better product
   references (anchoring, item 2), the prompt (already correct and not working), and
   post-render measure-and-reject.

9. **Meta preview chrome shows "Lorem ipsum dolor sit amet"** as the link description.

10. **Post-render safe-box measurement.** Geometry is computed and stated correctly; nothing
   verifies the model complied.

11. **Logo contrast/scrim.** Lower than previously recorded — it did NOT reproduce at full
   resolution on 2026-08-03 (an earlier call off a low-res thumbnail was wrong). Still worth a
   scrim (`directImageRenderService.js:758-781` has no plate sampling); not a blocker.

12. **Deferred by owner until output is proven:** `queued` ads never auto-drain;
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
- **`RENDER_CONCURRENCY` was 4 at boot while `defaults.env` said 8** — a dashboard var
  shadowed it. **RESOLVED 2026-08-03:** dashboard pin deleted as part of the secrets-only
  migration; file's **8 is now live**. Doubling was a cleanup consequence, not a separate
  tune. See CLAUDE.md §4a.
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

