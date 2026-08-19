## 2026-08-04 — PRODUCTION INCIDENT: concept-driven STATIC ads were ~90% dead

Owner reported "the platform seems to be crashing while doing generations". **Nothing was
crashing** — no OOM, no restarts, every Render deploy healthy. Two independent defects.

### A. Director round returned prose, not JSON (STATIC path only) — FIX APPLIED, NOT COMMITTED

**Introduced by `12b6aa8` (2026-07-31, PR #43) "…move the director to Claude".** That commit
moved `DIRECTOR_ROUND_MODEL` from `'gpt-4.1'` to `'director'`
(`anthropic/claude-sonnet-5-ccmax`) and, because **Atlas 400s on strict `json_schema` for
Anthropic**, downgraded `response_format` from `json_schema` → `json_object`. The commit
documents the 400 honestly. What it could not know: **`json_object` is accepted but NOT
ENFORCED for Anthropic on Atlas.** Probed live 2026-08-04, two arms (flag on / flag off) —
**both returned prose**. Enforcement went from a hard schema guarantee to nothing, and the
round system prompt never independently demanded JSON, so compliance was luck.

Measured: **first failure 2026-07-31 17:10Z, ~5h after the commit landed**; 9 failures that
day, 10 on 2026-08-04 (none 08-01→08-03 — that path simply wasn't exercised, NOT evidence it
worked). Early failures were markdown documents (`"## Concept"`, `"# 3 Creati"`); by 08-04 they
had shifted to conversational refusals (`"I don't have…"`, `"A couple o…"`). Each failure =
a product with **zero ads** and a wasted paid Director call.

**SCOPE — STATIC ONLY. Video was never affected.** `deterministicVideo` →
`expandDeterministicVideo` never touches the Director
(`campaignAdsGenerationService.js:593-597`); `conceptVideo` needs `productIds.length === 0` or
`directorVariants === true` (defaults false, `:394`). Proven in prod logs: at 15:49:27
`expandDeterministicVideo … payloads=1` succeeded while `conceptDriven` failed at 15:50:14.

**STATUS: SHIPPED AND VERIFIED IN PRODUCTION.** PR #65, merged. Live on `919f979`.
Do not re-diagnose this — see "the fix that actually mattered" below, because #65 alone
did NOT restore ad generation.

**Fix** in `services/aiCreativeDirectorService.js`:
`safeParseDirectorJSON` + `balancedSpanFrom` (string-aware, scans EVERY candidate span, tracks
both quote chars for the JSON5 fallback); a one-shot corrective re-ask **sharing** the existing
`attempt` budget so worst case stays **two** paid Director calls; and an `OUTPUT CONTRACT`
block naming the observed refusal openings. Pinned by `scripts/verifyDirectorJsonSalvage.js`
(**37 checks**, revert-proven on four mutations). Full suite **49/49**.

**An adversarial pass refuted the first draft** — first-`{` extraction is defeated by prose
that merely contains braces (`"I considered {option A}…"` → whole salvage throws). Hence the
scan-every-span rewrite. Two other draft defects were caught before apply: `JSON5` was used but
never imported (ReferenceError exactly when salvage was needed), and an array insert after a
non-comma-terminated element (module-level syntax error).

### B. WORKER had no `ATLAS_API_KEY` — FIXED LIVE

Worker had **14** env vars, no Atlas key, and logged `ATLAS_API_KEY not configured` continuously
— every worker LLM call silently falling back to direct OpenAI/Gemini. `docs/PIPELINES.md:921`
recorded it as WEB-only, so nothing flagged it; that was a **config gap, not a design choice**.
Copied web's exact value onto WORKER (14 → 15), redeployed `dep-d9p13vfavr4c73admgv0`, zero
fallback lines since the 16:24Z boot. Only env group ("Liquid Retail") has **0 vars**, so
nothing was supplying it from a group.

⚠️ **Billable consequence, currently dormant — watch it.** The key flips
`geminiImageService.viaAtlasOrDirect` (`:12`) onto Atlas `nano-banana-2/edit` for DetectRun
extended crops: **up to 4 billable image edits per NON-catalog DetectRun**, and DetectRuns
DO auto-drain via the worker loop. Catalog runs are exempt (`detect.js:628`
`skipExtendedCrops: true`). Measured 08-04: **115 detect runs in 24h, all catalog, zero
extended-crop activity.** It is a provider SHIFT (those crops already billed Gemini direct),
not new spend from zero. If IG post sync starts producing non-catalog DetectRuns, this becomes
real money and a quality change — gate Atlas image on the worker if that is not wanted.

### C. THE FIX THAT ACTUALLY MATTERED — the route was a coding-agent endpoint (PR #67)

**`anthropic/claude-sonnet-5-ccmax` is NOT a plain completion route.** Probed live: it
returned a tool call named **`Grep`** — a tool we never defined — so it ships its own
coding-agent toolset, and it ignores `tool_choice` as well as `response_format`. That is
the mechanism behind the markdown documents (`"## Concept"`) and the conversational
preambles. A coding agent was being asked to behave like a JSON API.

4 trials each, identical prompt, same thin brief:
| route | usable | missing `name` | unparseable |
|---|---|---|---|
| `claude-sonnet-5-ccmax` | 1/4 | 2/4 | 1/4 |
| `claude-sonnet-5` (plain) | **4/4** | 0 | 0 |

The `name`-missing arm matches the `concepts[0].name is missing` warnings prod logged, and
the absent `routing.media_picks` is what produced `concepts=3 payloads=0`. Same model
family the 2026-07-31 bake-off picked — this dropped the **agent wrapper**, not the model.
It also closed a silent mismatch: the `direct` fallback arm was ALREADY plain
`claude-sonnet-5`, so the two arms of one role ran different endpoints.

**⚠️ Atlas publishes NOTHING to distinguish the two.** No `description`, identical tags
(`LLM/HOT/CODE`), both `readme` links point at `claude-opus-4-20250514.md` (a different
model), and both `schema` URLs **404**. So CLAUDE.md §2's "verify the model id live" rule
would NOT have caught this — only calling the endpoint and inspecting the reply does.
**Never pick an Atlas model suffix on inference. `-ccmax` / `-coding` are distinct agent
products, and `max` does not mean "better".**

**VERIFIED END TO END** after #65 + #66 + #67, same product, same wizard settings:
`concepts=3 payloads=3 conceptSkips=0 dirWarnings=0` → 3 ads queued → 3 billable
`gpt-image-2/edit` submits → `3 succeeded · 0 skipped · 0 failed`, real creative on the
ads page. Before: `concepts=3 payloads=0 conceptSkips=3`, 42 contract warnings, 2 Director
calls. After: 0 warnings, **1** Director call — cheaper as well as working.

### D. Moderation blocks were retried and mislabelled (PR #68)

`atlasErrorPolicy.moderationBlocked` was already correct (`give-up`) but its matcher looked
for `safety system|safety filter`. **Atlas actually says "blocked by safety REVIEW"**, so
the real message classified as `predictionFailed` / `action:'retry'` — we were RETRYING
safety blocks, which can never succeed. Added `review|check|guidelines`; kept the list
ENUMERATED (not `safety\s+\w+`) because a false positive marks a *retryable* failure
terminal and discards a render that would have succeeded.

**`classify()` had exactly ONE consumer — `atlasImageService`.** `atlasVideoService`'s poll
loop threw a bare `atlasVideo: prediction failed:` and never consulted the policy, which is
why this surfaced on a video. It now classifies first and leads with the new
`label: 'Model Moderation Error'` (null for every unnamed class, so those keep provider
wording). **NOT yet observed end to end** — needs a real safety-blocked render to confirm
the label reaches `Ad.renderError.message`.

### E. RENDER_CONCURRENCY 8 → 24 (PR #68)

Owner: *"the renders should all go out to atlas at the same time."* `MAX_CREATIVES_PER_RUN`
is 20, so 24 makes the gate non-binding for a full run. Confirmed live in the boot log
(`RENDER_CONCURRENCY=24[self]`, 17:08:30Z).
- **Images were NEVER drip-fed.** `pacedModelSubmit` / `ATLAS_SUBMIT_SPACING_MS=1200` lives
  in `atlasVideoService` and gates **VIDEO only**. The 8 was purely an in-flight cap.
- **Spend unchanged** — submit COUNT is fixed by the ad count; only the rate moves.
- **UNMEASURED above 8.** 2026-08-02 measured 8 concurrent `gpt-image-2/edit` clean with
  zero 429s; 24 is 3× that against an unpublished per-(team,model) RPS ceiling. Not a money
  bug (`isDefinite429` replays only on structured proof of pre-work rejection), but **watch
  the first full-size run for 429 backoff** and drop back if they appear.

### Also seen, NOT fixed (separate issues)
- `RENDER_AUTH_TOKEN` on web is **EXPIRED** (`exp=2026-05-07`), and `FRONTEND_URL` points at
  `liquidretail.netlify.app` — the **stale** pre-transfer Netlify site.
- One billable Omni submit lost to `blocked by safety review` (ad `6a7207ce80833259b2005cfe`).

---

