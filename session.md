# session.md — liquidretail_backend

Handoff for the next session. **Rewritten 2026-08-03.** This file had grown to ~760
lines of chronological accretion; it is now organised by *what is true* rather than
*what happened when*. History is compressed at the bottom — anything not listed there
was judged superseded and dropped **deliberately**, not lost.

## 2026-08-03 — OWNER DECISIONS (landed). Read this before the next-session prompt below.

Five owner decisions from 2026-08-03. Items 1–4 shipped in `be5b83f` (on `main`); item 5
(Render secrets-only migration) is a live dashboard change + the doc pass that records it.
**Verify each item against the code — several reverse advice written earlier in this same file.**

1. **Static seed default = THE FIRST IMAGE THAT CAME FROM THE CATALOG.** Not the `imageRole`
   `'hero'` label. Owner: *"I actually just want to use the first image that comes from the
   catalog not the 'hero' image since that may also come from social media or UGC?"* The label
   itself is never stamped on UGC (only `catalogProductDetectService.js:60` writes it, from
   `CatalogProduct.imageUrl`) — but it can be **absent**, and the old predicate then fell through
   to the shotType ranking, whose pool merges catalog with `product_match` UGC, so the default
   could be a UGC post. Implemented as `preferFirstCatalogImage` + `promoteFirstCatalogImage`
   cascade: hero stamp → earliest-`createdAt` catalog entry → nothing. Mirrors the proven
   cascade at `campaignAdsGenerationService.js:2085`.

2. **VIDEO: the whole of PR #61's prompt work is ROLLED BACK.** All three parts — Scene 3
   return-to-primary, the crossfade/long-dissolve policy, AND `subjectContinuity`. Owner:
   *"This is creating additional hallucinations and the previous output was better."* Acceptance
   test is mechanical: the prompt built from `services/veoPromptBuilder.js` must be
   **byte-identical** to the prompt built from `134db56~1`. Only intentional differences are the
   `OMNI_DIRECTIVES`/`GROK_DIRECTIVES` module exports (harness plumbing) and comments.
   **The restored old prompt is self-contradictory on purpose** — `transitions` permits ~0.25s
   crossfades while `doNot` bans "dissolves". Owner-confirmed: that contradictory prompt is the
   version that produced better output. DO NOT "repair" it.

3. **VIDEO: primary-ref repeat is OFF by default.** Both the code default
   (`isRepeatPrimaryReferenceEnabled`) and `config/defaults.env`. Default stack = the first
   **three distinct** references, nothing appended. Capability kept reachable via
   `REPEAT_PRIMARY_REFERENCE=true` for a future A/B; `REPEAT_PRIMARY_TOTAL_CAP` (=4) applies
   **only** to that opt-in path. On the default (flag-off) branch the hard ceiling is
   `MAX_DISTINCT_REFERENCES=5` (`atlasVideoService.js:813`) — turning the repeat off had
   removed the only clamp. Full PR #61 camera-prompt rollback is also landed (all three
   pieces; B14 byte-identity pin) — see CLAUDE.md §00 and `docs/PIPELINES.md` §6.

4. **UGC ads must not be affected — "we haven't optimized that path yet" (owner).** Concretely:
   - brand-only runs (`isBrandOnly`) → promotion skipped, UGC can still win index 0. Unaffected.
   - operator-picked media (`restrictToMediaIds`) → promotion never applied. Unaffected.
   - product mode, no picks → seed is now always catalog, so the ad is `product_image` where it
     could previously have been `ugc`. **Deliberate** — this is the same UGC-as-default worry as
     item 1.
   - **static regenerate** (`REGEN_RESEED_CATALOG_FIRST`, default ON) gates on
     `variantKind === 'product_image'` and skips non-empty `referenceMediaIds`. Built in
     `be5b83f` — see below.

5. **Render env migration COMPLETE (2026-08-03).** Owner: *"The dashboard in render should
   only contain secrets, everything else should be editable outside of the dashboard."*
   WEB 64→23, WORKER 24→14. Every deleted key matched `config/defaults.env` identically
   (no-ops) **except `RENDER_CONCURRENCY`** (dashboard 4, file 8) — deleting the dashboard
   pin made **8 live**. `JIRA_PROJECT_KEY` retained (not a secret, not in the file). Canonical
   write-up: CLAUDE.md §4a; stays-in-Render list: `docs/PIPELINES.md` §9.
   ⚠️ **Precedence still matters forever:** `index.js:1-5` / `worker.js:18-20` load process
   env FIRST; dotenv never overrides. A dashboard var of the same name still shadows the
   file. Diagnostic: compare the dashboard list against
   `grep -oE '^[A-Z_][A-Z0-9_]*=' config/defaults.env`.

**BUILT — catalog-first reseed on static regenerate (`REGEN_RESEED_CATALOG_FIRST=true`).**
Was "NOT YET BUILT" earlier the same day; shipped in `be5b83f`. `adRegenerateService.js`
re-derives via imageRole hero → earliest-`createdAt` catalog entry → nothing (every query
pinned to `source:'catalog-product'` + ad product + ad brand). **NOT a trim** of
`mediaIds[0]` (historical stacks are lifestyle-first over catalog+UGC, so [0] is often UGC).
Gates: `variantKind==='product_image'` only; operator `referenceMediaIds` always wins;
catalog VIDEO never selected; missing `fileUrl` is an honest skip; **nothing persisted**
back onto the Ad so the kill switch stays effective. Pinned by
`scripts/verifyRegeneration.js` (R3/R3b/R3c).

**Reference count is COST-NEUTRAL** (measured, not assumed): flat price per submit, no
`images.length` multiplier (`atlasImageService.js:75-104`). What multiplies spend is the Meta
static SIZE fan-out (3 surfaces = 3 submits). So all of the above is quality, not spend.

**Grok CLI headless CAN read files** — `-p --always-approve --sandbox read-only` executes read
tools (verified on 0.2.117). §0.29996's claim that it never executes tool calls is WRONG; that
was `--permission-mode acceptEdits`. Writes from headless remain unproven — use subagents to edit.

---

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

## Next-session prompt

**START HERE — 2026-08-05 pickup.**

0. **NOTHING OUTSTANDING from the 2026-08-04 incident — it is shipped and verified.**
   PRs #65, #66, #67, #68 all merged; prod is `919f979`; end-to-end run confirmed
   `payloads=3` → `3 succeeded · 0 failed`. Two things to WATCH rather than do:
   - **429 backoff** on the first full-size (15-20 ad) static run, now that
     RENDER_CONCURRENCY is 24 and unmeasured above 8. Drop back if they appear.
   - **`Model Moderation Error`** reaching `Ad.renderError.message` on the video path —
     classifier and throw site are verified, the end-to-end surfacing is not (needs a real
     safety-blocked render; do not manufacture one).

   One loose end: the **CLAUDE.md** doc edit for §§C-E is **uncommitted**, because that file
   carries in-flight `feat/brand-font-coverage` work that must not be swept into these
   commits. `docs/PIPELINES.md` and `services/atlasModelMap.js` were landed via
   hunk-level staging (`git apply --cached` on a filtered patch) — reuse that technique.

Then the pre-existing queue. The 2026-08-04 session rewrote this block because three
of its four claims were wrong. Read §0 CORRECTIONS before anything else.

1. **LAND `fix/remotion-font-fatal-load`** (branch exists, working tree, NOT committed —
   commit was not authorised). It fixes the fatal video bug. 30/30 verify green including a
   new `scripts/verifyFontServing.js`. Two adversarial passes were run — read their findings
   in §0 before committing.

2. **THEN apply the post-render vision QC patch** — drafted, reviewed, NOT applied. It lives
   at **`.drafts/ad-vision-qc/`** (gitignored; `ad-vision-qc.patch` + `APPLY.sh` +
   `DESIGN-NOTES.md`). 1288 lines across 8 files, touches billable paths, so it needs its own
   focused pass with two adversarial reviews. **One change required before applying: the draft
   picks `google/gemini-2.5-flash`; use `google/gemini-2.5-pro` instead** — see §0.

3. **THEN the video canonical prompt.** This is now the biggest *creative* defect and it is
   NOT a titling problem — titling works. See §0.

**Do NOT start by merging PR #32.** That instruction was wrong; see §0.

---

## 0.0 STATIC PROMPT — product-fidelity hardening (2026-08-03, UNCOMMITTED)

Owner-directed. Targets **product drift** on the gpt-image-2 direct static path:
hallucinated logos, shifted colour, altered fit, "improved" construction.

**There is ONE prompt builder, not three.** The owner expected three; the three are the
three *intents* (`social_proof_led`, `product_first_lifestyle`, `objection_resolved`),
which all share `staticAdIntents.buildPrompt`. Hardening that one function covers all
three. `aiImageReferenceService.buildPrompt` and `aiLayoutStudioService.buildGenerationPrompt`
are also gpt-image prompts but are **not** on this path (shadow artifact, default
`AI_IMAGE_REFERENCE_ENABLED=false`; and layout exploration never delivered as an ad) — both
were deliberately left alone.

**Changed** (`services/staticAdIntents.js`, `+133`):
- `PRODUCT_FIDELITY` — replaces the one hedged sentence that was losing to the creative
  instructions below it. Source-of-truth, no category/brand-prior inference, preserve
  form / construction / surface / colour / on-item graphics / details / condition, a NEVER
  list, a hidden-geometry rule, an explicit WHAT MAY CHANGE list, and a closing check.
- Carve-outs in `absences` and both `textBlock` branches so the no-added-text rules cannot
  strip the product's **own** printed label. That conflict **predates** this work: those rules
  ban marks "on packaging or clothing within the scene" and on this catalog the product often
  IS the packaging or the clothing. Every carve-out is anchored to *"visible … in the reference
  photograph"*, never *"on the product"* — the loose phrasing lets a model invent a label it
  believes the product normally carries.
- `absences` also generalised off apparel ("garment" → "product").
- Stale comment fixed at `directImageRenderService.js:706-712` (it quoted the deleted sentence).

**Kill switch `STATIC_PROMPT_FIDELITY_HARDENING` (default true).** `false` restores a
**byte-identical** pre-hardening prompt — block *and* both carve-out sites revert together,
verified by diffing all six intent×surface prompts against a pre-change dump. Partial revert
would give an A/B whose control arm is not the arm that was measured. Precedent: PR #61
hardened the VIDEO prompt and the owner rolled all three parts back (CLAUDE.md §00).

**THE RISK, unmeasured and the reason the flag exists.** The prompt more than doubled,
**~3.5-4.1k → ~7.8-8.4k chars**, and the block sits **above** `SET EXACTLY THESE STRINGS` on
a path whose measured text fidelity is **139/140 strings across 20 renders**, and where
`quality:high` already measured WORSE than `medium` *by losing a string*. Mitigations applied:
the precedence sentence explicitly exempts the text contract and defers to the reserved-corner
rule, and the closing check covers copy as well as product. **First render sample after this
lands: check copy fidelity before anything else. If strings degrade, flip the flag.**

This does **not** fix the ~1-in-3 competitor-mark defect and must not be described as fixing
it — `adVisionQcService` (measure-and-reject) is still that fix. See CLAUDE.md §2 Known open.

**Verify:** `scripts/verifyStaticFidelityPrompt.js` — 419 checks, both arms, revert-proven on
three mutations (hardwire flag off / delete the text-exemption clause / loosen the reference
anchor); all three fail the harness. Full suite **46/46 green**.

### 0.0a PRICING CORRECTED — `base_price` is not the charge (2026-08-03, MEASURED)

Found by running live renders. **`price.actual.base_price` under-reports the real charge
by ~7.17x.** CLAUDE.md §2, `docs/ATLAS.md` and the `buildPriceMap` comment all said
`actual` "is what we pay"; all three are now fixed.

| model | catalog base | **measured charge** |
|---|---|---|
| `openai/gpt-image-2/edit` | $0.010 | **$0.07173** |
| `openai/gpt-image-2-developer/edit` | $0.005 | **$0.03586** |

Dead-consistent across every priced prediction. The multiplier is **not** in the catalog
and was measured only at `1024x1024` / `quality: medium` — do not hardcode it or carry it
to another model. `buildPriceMap` is a **floor-grade estimate** whose only job is to stop a
$0.00 row.

**Owner rule: always read the actual price back from Atlas after generation.** Authoritative
figure = `price` on the **settled** prediction (`GET /model/prediction/:id`). Atlas usually
publishes it *after* the image returns — measured **7 of 38** had it at completion — so
`scheduleCostReconcile` is the normal path, not a rare top-up. Its budget was widened
`[3s,10s,30s]` → `[3s,10s,30s,60s,120s,300s]`; at the old budget most rows kept a 7x-low
estimate forever, which is how a static ad appeared to cost $0.01.

### 0.0b STATIC EDIT MODEL → `-developer` variant (owner, 2026-08-03)

`PLATE_EDIT_MODEL` default and `AI_DIRECT_IMAGE_EDIT_MODEL` in `config/defaults.env` both
now point at `openai/gpt-image-2-developer/edit`. **Halves static spend** — a 3-surface
`meta_static` fanout goes ~$0.215 → ~$0.108 per product. Submit COUNT is unchanged.

Verified live before switching (never take a model id from memory): both ids resolve to the
same `POST /model/generateImage` and their request schemas are **field-for-field identical**
— same `required`, same 14-value `size` enum, same `quality` enum, neither exposes
`input_fidelity`, and they share one `readme`. Drop-in; `buildParams` unchanged. The
identical `size` enum is why `verifyStaticSafeBox` still passes — noted in that file.

⚠️ **NOT verified: output quality dev vs non-dev.** The A/B ran both arms on the developer
model, so it compares prompts, not models. Revert path is `AI_DIRECT_IMAGE_EDIT_MODEL=openai/gpt-image-2/edit`,
no code deploy.

⚠️ **OPEN — measured reliability gap. Decide before merging.** 38 submits per model, same day:

| model | ok | hard failures | $/successful render |
|---|---|---|---|
| `openai/gpt-image-2/edit` | 36/38 | **0** (2 poll timeouts, likely late completions) | $0.0757 |
| `openai/gpt-image-2-developer/edit` | 32/38 | **6 `prediction failed`** (15.8%), null outputs, no error | **$0.0426** |

The money case survives — developer is ~44% cheaper **per successful render** even after
paying for the failures. But a ~16% hard-failure rate is a product problem, not a cost one:
each is a charged submit with no asset, which reaches the operator as a failed ad and bills a
failure. **NOT a controlled comparison** (n=38 each, one session, and the two runs used
different prompt text), so this is a signal to re-measure, not a verdict.

### 0.0c RENDER SAMPLES — run 1 VOID, run 2 in flight

**Run 1 (40 renders, non-dev model, $2.87) is VOID for product fidelity.** The `PRODUCT:`
description said *"Triple-strap"* — a miscount, the seed has **two** straps — and it went
into **both** arms, so every render was told three while shown two. Both arms produced a mix
of 2 and 3. Do not cite run 1 for strap/product fidelity.

**What run 1 DID establish, and it is the important part:** no copy regression. All 38
renders in both arms produced the rating, quote, attribution and CTA — so doubling the
prompt above `SET EXACTLY THESE STRINGS` did not break text fidelity, which was the whole
risk of this change. The `UNIFORM·SHOE` insole label also survived in both arms, confirming
the carve-out works.

**Run 2** re-runs on the developer model with a description that is accurate AND deliberately
**silent on strap count**, so the reference image is the only source for that attribute —
which is precisely what `PRODUCT_FIDELITY` claims to enforce. Harness:
`<scratchpad>/render-samples2.js` (not repo code; it re-polls Atlas for real prices).

⚠️ **ANOTHER SESSION WAS EDITING THIS SAME WORKING TREE CONCURRENTLY.** Mid-task the tree held
uncommitted `services/ratingDisplay.js` (+431) + `scripts/verifyCoherentSocialProof.js`; those
landed as **`9b61b02`** ("Tier-coherent social proof") while this work was in progress, and
`remotion/compositions/Canonical.jsx` + `services/adRegenerateService.js` then appeared dirty
from that same session. **None of it is part of this work and none of it was touched.** The
fidelity changes were re-verified against the moved HEAD afterwards (46/46 suite, 419-check
harness, byte-identical revert all still hold). If two agents share this checkout again, expect
`git status` to include work that is not yours — check `git log` before assuming a dirty file is
your own.

---

## 0. CORRECTIONS — 2026-08-04. Read before trusting anything below.

Four claims in this file were wrong. Each was verified against live code, the installed
packages, or a real production render.

**(a) "MERGE PR #32 FIRST — video spend is UNRECORDED" — STALE. Already fixed, better.**
`models/CostLog.js:34` now has `COST_STATUSES = ['ok','error','timeout','rejected',
'rejected-billing','failed','charged-no-output','submitted']` — all three values PR #32 wanted,
plus two more. And `services/costTracker.js:148-160` now *normalises* an unknown status to
`'error'` with a loud `❌` log instead of dropping the row, so the whole class of bug is closed
structurally. Landed via PR #43 / `68a0ee0`, not PR #32. PR #32 is 3 commits stale and
`CONFLICTING`. **Its one still-valuable piece is the unlanded GEN-1 security guard** (an
`engine !== 'remotion'` 400 on `POST /api/brand/:id/preview-script`, closing an
authenticated-tenant RCE via three doors). Land that on its own; do not merge the branch.

**(b) "The font errors are a RED HERRING … chasing the font 404 first would waste a session"
— EXACTLY BACKWARDS. The font 404 IS the root cause of the fatal video failure.**
Chain, every link verified:
1. `library-match` Inter resolves to `localPath = FONTS_DIR/Inter.ttf`
   (`fontResolverService.js:279`, `fontLoader.js:31`).
2. `fontsToUrls` (`remotionRenderService.js:291`) rewrites to `/fonts/<basename>`, and
   `assetPathFor` (`:149-150`) maps `/fonts/*` ONLY to `FONT_CACHE_DIR` (= `assets/webfonts`).
   File is in `fonts/`, lookup in `webfonts/` → **404**.
3. The 404 branch set **no CORS header** (only the success path did, `:176`), so the browser
   reported a CORS failure and `FontFace.load()` rejected with `A network error occurred`.
4. **`node_modules/@remotion/fonts/dist/cjs/load-font.js` ends `catch (err) { cancelRender(err) }`.**
   `loadFont` cancels the render ITSELF. Confirmed in the installed package, v4.0.495.
5. `FontLoader.jsx`'s `.catch(...)` logging *"using fallback stack"* is a **FALSE SAFETY NET** —
   it runs after `cancelRender` and cannot un-cancel. The file's header comment claiming "a
   render must never fail because a webfont 404'd" was a lie in the code.
`Could not extract frame from compositor / Request closed` is downstream collateral from the
aborted page, not the fault. **Control proof:** 2026-08-01 renders succeeded because that
brand's fonts all resolved via Google, so the files really were in `webfonts/`. The bug is
deterministic for `library-match` — which is where the curated Inter/Lora defaults live.
Also note the fix is NOT a directory rename: google + custom fonts legitimately live in
`webfonts/`, so renaming would break the two branches that work.

**(c) "Safe zones do not reconcile … titles are floating far higher than necessary" —
REAL BUT MISDIAGNOSED. Fixing `safeZones.js` alone would change NOTHING.**
Measured every one of the 192 frames of a real Stories render (1080x1920):
- topmost text y=279 = **0.1453** of H (safe top 0.14) — sits exactly on the boundary
- lowest text  y=744 = **0.3875** of H, against an allowed limit of **0.65**
- left x=84 = 0.0778 (safe 0.075); right x=965 = 0.8935 (limit 0.925)
**Zero safe-zone breaches anywhere in the video.** Text never descends past 0.3875 while
permitted to 0.65, so `bottom: 0.35` is NOT the binding constraint — **504px / 26.2% of frame
height is unused because the layout is top/upperThird-anchored** (`remotion/lib/safeZones.js`
`ANCHOR_TOP`). The lever is anchor selection, not the safe-zone constant.
The Reels/Stories collapse is still a real latent bug, and the numbers still disagree — but
note **neither source is right for both surfaces**: remotion's 0.35 bottom is plausibly correct
for *Reels* (tall caption/action rail) and far too conservative for *Stories*, while
`platformFormats`' 250px is plausibly right for *Stories* and its 204px looks too small for
*Reels*. **Confirm against Meta's published spec before locking any number in** — do not derive
the fractions from `platformFormats`, that would push Reels titles under the caption rail.

**(d) "Video path not QC'd on [competitor marks]" — now QC'd, and it HAS the defect.**
See §0.1.

### 0.1 What a real render actually looks like (2026-08-04)

**Static** — pulled the three live `2026-08-03` renders and viewed them. **1 of 3 carries the
competitor mark**, matching the reported rate. The defect ad is `ai_editorial`
(`1_1-ai_editorial-69977681-7447a677.png`): a **Timberland tree emblem on the midfoot of an
Allbirds shoe**. I pulled the ORIGINAL product photo
(`Media.fileUrl`, media `6a4e7ea956509c2169977681`) — it is **completely clean, no mark on the
panel**. The emblem is a pure hallucination with no source.
**Likely mechanism, worth testing: the product is "Men's Tree Runner NZ".** A literal *tree*
emblem on a product named *Tree Runner* looks like product-name semantics leaking into the
artwork, not a random competitor logo. That suggests a targeted prompt/negative lever in
addition to measure-and-reject.
The other two renders are genuinely good — clean type hierarchy, correct `allbirds` wordmark
and debossed midsole mark.

**Video** — the 2026-08-01 titled Story (`brand_script/product-1785618231946-9-ia67yyu7.mp4`,
Gymshark Muscle Tee, 8s @ 24fps) is the only titled output that exists. **Titling itself is
fine**: serif headline "Meet your new favorite Muscle Tee", then a working quote gate
rendering *"The athletic fit is perfect."* — ALEX R. The creative failure is the **last 29% of
the clip**:
- text absent frames **137–191 = 5.71s→7.96s (2.29s)** — no title, no CTA, no end card
- the model is **fully back-turned** — featureless black shirt back, Gymshark chest logo gone
- **white Nike sneakers with clearly visible swooshes**, sharp and stable across every frame
So the ad's final impression is a competitor's logo. Confirmed with output-seeking (`-i` before
`-ss`) across three stable frames; this is not a decode artifact.

**ROOT CAUSE — it is the REFERENCE STACK, not the prompt and not hallucination.**
`Ad.veoReferenceImages` for ad `6a6e5e6a57a1c6217fd33e8a` holds exactly three images:
| pos | content |
|---|---|
| REF0 (seed) | model **front-facing**, **black** sneakers |
| REF1 | model **fully back-turned**, wearing **white Nike sneakers, swoosh visible** |
| REF2 | three-quarter view, black socks |
The back-turned ending and the Nikes are **REF1, faithfully reproduced**. Omni did what the
prompt told it — *"the first image is the primary scene, the rest are additional views of the
same product"* (`veoPromptBuilder.js:337-340`) — treated the stack as a sequence and dissolved
through the views. That also explains the ~5.0s cross-dissolve (front → back), which is
therefore normal behaviour, NOT a generation artifact. Two earlier reads in this session were
wrong and are corrected here: the ghosting is a legitimate shot transition, and the Nikes are
not the model inventing a competitor mark.
**OWNER INPUT 2026-08-04 — read before "fixing" this.** A back view is **not** a bad reference;
the owner considers it useful for fidelity. And: *"we found with too many images it was
hallucinating"* — so **do NOT raise the reference count** to compensate. Corroborating evidence:
the static Timberland ad sent **exactly ONE** reference and still invented the emblem, so ref
COUNT is not the driver; ref quality/role is. `DEFAULT_REFERENCE_IMAGE_COUNT = 3`,
`MAX = 7` (`atlasVideoService.js:762-763`) — keep 3.

**Selection is purely positional today.** `buildReferenceImages` (`atlasVideoService.js:1791-1807`)
= seed at position 0, then catalog mirrors in `hero-first / createdAt asc`, truncated. Owner,
verbatim: *"we are taking the first three images by default."* Whatever lands 2nd/3rd by
createdAt becomes a reference — for a typical PDP set that is LEFT/BACK.

**PREVALENCE — this is NOT an edge case.** 423 video ads; 130 carry reference stacks across 86
products and 10 brands; refcount distribution `{1:35, 2:10, 3:85}` — **65% carry three refs**.
Confirmed on a second brand/category: Allbirds "Men's Wool Cruiser" ref R2 is literally named
`..._PDP_BACK_....png`. Also spotted: "Fujimurasaki Matcha" uses an
`encrypted-tbn0.gstatic.com/shopping?q=tbn:` **Google Shopping thumbnail** as a reference for a
$1.00 video generation — a separate reference-quality bug.

**THE MISSING PIECE: there is no view/angle field on Media.** The detect pipeline already
populates `subjects`, `text`, `background`, `primarySubjectDesc/Label`, `technicalInsights`,
`adSuitability`, `classification`, `refinedProducts` — but nothing records front vs back vs
detail. That is exactly why selection is positional: it has nothing else to sort on.

**RECOMMENDED DIRECTION (discussed with owner, not yet built):**
1. **Minimal, free, testable first:** the stack is consumed as a SEQUENCE, so the fix is not
   reordering but making the CLOSING BEAT return to the primary view. `buildVeoPrompt` Scene 3
   says *"zoom out to reveal the full product"* without saying WHICH view. Prompt-only change.
2. **Classify view ONCE at ingest**, not per generation — stamp Media with
   `view: front|back|detail|lifestyle|packaging` (~$0.0016/image with flash, one time). Ordering
   then becomes free and deterministic forever; a per-generation Director call re-pays that cost
   and is non-reproducible.
3. **Share that ingest call with the brand-safety screen** (§0.2 known limit / task): one look at
   each ingested image returns view angle + competitor marks + text presence.
4. Leave the **Director** to sequence a script from already-labelled views, which matches the
   owner's stated intent that an enabled Director should drive the camera prompt — rather than
   doing perception work per run.

**Secondary, still worth doing — the canonical prompt has real gaps** (`veoPromptBuilder.js`
`OMNI_DIRECTIVES:156-193`):
- It locks the CAMERA and the PRODUCT but never the PERSON. `cameraStyle` says "The product
  stays completely static"; `physicalAccuracy:186-188` preserves "face, hair, skin tone, and
  identity" — **identity, but not pose or orientation**. For apparel the product is worn by a
  person the prompt does not govern.
- **Self-contradiction:** `transitions:172` allows *"Smooth crossfades only, ~0.25s"* while
  `doNot:190-192` bans *"morphing, or dissolves."* A crossfade IS a dissolve. The measured one
  also ran ~0.4s+, longer than the stated 0.25s.

### 0.2 Vision QC — there was none, at all

Verified: `aiJudgeService` runs BEFORE render and scores Director *concepts*
(`campaignAdsGenerationService.js:2293`); `judgeService.judgeDetections({imageUrl,...})` has
**zero call sites** (dead code); `directImageRenderService.js:711` states validation runs
*"BEFORE the billable submit, deliberately"*; and nothing reads the final `renderUrl`.
**That is why the Timberland emblem ships — nothing ever looks at the output**, and it is why
"the fix is measure-and-reject" was never actionable: the measure half did not exist.

**Model, probed LIVE against the real defect** (not chosen from a spec sheet). Both candidates
route and both caught the emblem:
| model | verdict | cost/check | contract |
|---|---|---|---|
| `google/gemini-2.5-pro` | "competitor's logo (Timberland) … debossed into the heel counter … absent from the original" | ~$0.011 | **exact requested JSON shape** |
| `google/gemini-2.5-flash` | also caught it, localised it slightly better | ~$0.0016 | **BROKE the shape** — returned `competitor_marks: false` as a bare bool, hoisted `findings` |
**Use `gemini-2.5-pro`.** The $0.0094 delta is noise against the $0.01–0.17 generation it
protects, and a malformed verdict either ships a bad ad or burns a needless regeneration.
Register it as a **new `vision-qc` role** — do NOT repoint `'gpt-4.1'`, which
`atlasModelMap.js` warns is shared by 11 services.
Owner-approved behaviour: **auto-regenerate exactly ONCE**, then `status:'failed'` + Slack;
**keep the discarded render** (already paid for); **surface findings in the generation details**
(follow `imageGeneration`/`intentResolution`: `models/Ad.js:337,347` → `renderService.js:1157`
→ `routes/ads.js:1888-1889,1944-1953`). All four checks: competitor marks, product fidelity vs
original, text defects, layout/safe-box.

**KNOWN LIMIT OF THIS QC — it cannot catch the video Nike case.** The check compares render
against the ORIGINAL, so it only catches marks the model INVENTED. The Timberland emblem
qualifies (original was clean → caught). The Nike sneakers do NOT: they are genuinely present
in REF1, a real Gymshark catalog photo sitting in our own Media library, so render-vs-original
correctly passes them. **Competitor branding that enters through source imagery needs a
separate brand-safety screen at media ingest / reference-selection time.** Two different
defects that look identical in the finished ad; do not expect one control to cover both.

### 0.25 PROVEN LIVE — the font fix works ($0 validation, 2026-08-04)

Deployed `45b7419` to both services, then re-ran ONLY Remotion titling against the already-paid
master of the ad that failed on 08-03 (`6a7017ee51cea04158ad8b47`, Allbirds, meta_reels_9_16).
Zero new spend. Log:

```
fonts=heading:Inter(library-match) body:Inter(library-match) quote:Lora(google)
render 25% -> 50% -> 75% -> 100%
TITLING_OK 76.2s
AFTER url=.../brand_script/product-1785735868132-1-uajivuga.mp4
```

That is the exact `library-match` case that used to die at ~3s. **No compositor error, no
"A network error occurred", and critically NO `font load failed for Inter` warning** — which is
the positive proof Inter actually LOADED rather than soft-failing to a fallback. Deployment
sanity check on the box: `assets/fonts` = 17 files, `assets/webfonts` = **0** (it only fills
on-demand per brand), which is exactly why every library-match request 404'd before.

**Non-fatal, worth tracking:** a `ProtocolError: Page.bringToFront: Target closed` fires after
75% during teardown, yet the render still reaches 100% and succeeds. Benign shutdown race.

### 0.26 CREATIVE DEFECTS in the newly titled output (viewed frame by frame)

1. **The endcard prints the raw catalog SKU title, truncated:**
   `"Women's Breezer Point - Warm Red (Dark..."` — colorway parenthetical and all, clipped
   mid-word (cap applied at `remotion/compositions/Canonical.jsx:98` `.slice(0, cap)`).
   Note `CLAUDE.md` says the product name is *"dropped entirely by owner instruction"* for
   STATIC, yet the video endcard leads with it.
2. **The closing beat is the heel/back view AGAIN** — arc was side -> three-quarter -> top-down
   -> heel -> heel. Reference-stack ordering reproduced on a SECOND product and category
   (footwear vs apparel). Confirms §0.1.
3. Headline sits on a heavy grey translucent scrim; reads unpolished next to the static ads.

### 0.27 FONT FALLBACK IS NEARLY A CONSTANT (owner flagged; confirmed)

Owner: *"those fonts are the same ones that always get used"* / *"there should be much better
fallback choices."* Correct, and worse than it looks:
- `fontResolverService.js:269` — `substitution?.family || (fallbackFor(requested)==='serif' ? 'Lora' : 'Inter')`.
  A **binary** default.
- `LIBRARY_SUBSTITUTIONS` (`:253-262`) only fires when the **requested font NAME** matches a known
  foundry name (helvetica/futura/bodoni/...). Brands with proprietary typefaces — Allbirds
  **"Self Modern"** — match nothing and always land on Inter. That is the common case for premium DTC.
- `fontLoader.js:46-61` downloads **16** faces; only **8** are reachable via substitution.
  **Unreachable by ANY fallback path:** Cormorant, Antonio, Bebas Neue, IBM Plex Sans, Poppins,
  Nunito, Quicksand.
Fix: classify once per BRAND (site/logo/theme signals) -> pick best of the 16 -> cache on the
Brand doc. Same "classify once, reuse forever" pattern as view-angle.

### 0.28 OWNER ASK — gpt-image-2 for titling. Transparency is NOT available; do this instead.

Checked the LIVE schema (`openai-gpt-image-2-edit.json`): `output_format` is
`enum ['jpeg','png']` and there is **no `background: transparent` param** (OpenAI's native API
has one; Atlas does not expose it). PNG alone does not give alpha, so a per-frame composited
transparent title layer is NOT reliably achievable.

**Better architecture, no transparency needed:** don't overlay — have `gpt-image-2/edit` render a
COMPLETE designed frame (exactly what the static pipeline already does, and its typography is
visibly better than Remotion's), and have Remotion **cut to it**. Highest-value slice is an
**AI-designed ENDCARD** for the final ~1.5-2s:
- `size: '1152x2048'` is in the enum and is **exactly 9:16** -> clean downscale to 1080x1920
- $0.01 flat, one call per video
- fixes BOTH §0.26(1) the truncated raw-SKU endcard AND §0.26(2) the ad ending on a shoe heel
- text-accuracy risk (image models misspell) is exactly what the §0.2 vision QC catches

### 0.29 HOW MUCH PRODUCT INFO DO WE HAVE? (measured, answers the owner's question)

Coverage over 500 Media docs — the detect pipeline is thorough:
`classification` 100%, `adSuitability` 100%, `subjects` 95%, `primarySubjectDesc` 95%,
`primarySubjectLabel` 95%, `background` 95%, `technicalInsights` 94%, `text` 71%,
`refinedProducts` 45%.

So we are NOT missing perception generally — we are missing exactly ONE dimension: view/angle.
That makes the reference-ordering fix much smaller than it first looked.

**And the signal is already half-captured.** 42% of `primarySubjectDesc` values contain angle
vocabulary, e.g. *"Black short-sleeve crew neck t-shirt, **plain back**, ..."*. But it is NOT
reliably regex-extractable: another sample reads *"standing in **front** of a classic black
muscle car"*, where "front" is the car's position, not the camera angle.

**CHEAPEST FIX — add a `view` field to the EXISTING detect call's output schema.** That call
already looks at every image and writes the description; asking it for
`view: front|back|side|three_quarter|detail|lifestyle|packaging` costs **zero additional API
calls** and needs no new vision pass. Prefer this over a separate per-image classification pass
(my earlier suggestion — superseded, it was more expensive for the same result). Only existing
media would need a backfill.

### 0.295 ENDCARD PROBE — VALIDATED, $0.01 (2026-08-04)

Ran one live `gpt-image-2/edit` call on the Allbirds Breezer Point to test the §0.28 endcard
idea before building anything. **It works.**

- `size:"1152x2048"` accepted -> returned exactly 1152x2048 = **0.5625 = perfect 9:16**
  (note `buildParams`' comment at `atlasImageService.js:440` lists only 3 sizes — STALE, the
  live schema has 14)
- 115s, $0.01, one submit
- Output: elegant editorial serif headline, clean price line, pill CTA, generous negative space,
  bottom-right corner left EMPTY for logo compositing as instructed, all spelling correct
- **No invented logo on the product** — the explicit "Do NOT add, invent, or redraw ANY logo,
  emblem, badge or wordmark; it carries none" instruction HELD. Worth reusing verbatim in the
  static path, given the Timberland defect.
- Qualitatively far better than the current Remotion CSS card, and the raw-SKU-title problem
  disappears because copy is authored, not concatenated.

**Measured product-fidelity drift** (mean saturated-red pixel, source vs render):
`#a03849` -> `#b15760` — ~11% lighter, ~13% LESS saturated, shifted pink. NOTE: an earlier
eyeball read in-session called it "deeper burgundy" and that was WRONG in direction; the
measurement is the record. Part of the shift is legitimately the warm scene lighting that was
requested, so this is a judgement call rather than an unambiguous bug — but it is exactly what
the §0.2 vision QC "product fidelity vs original" check is for, and it is measurable this way.

**Two prompt fixes for the next iteration:** "125 dollars" rendered literally (written that way
to dodge glyph mangling — test "$125"); and the product sat mid-frame leaving dead space
instead of the requested lower-centre.

### 0.296 TITLING "REGRESSION" — DIAGNOSED. A stale stored brand spec shadows canonical.

Owner, on seeing the re-titled Allbirds render: *"We had really great titles going and now I am
seeing scrim again"*, *"this is not the canonical titling we were using last"*, *"this font is
incorrect"*. All three are correct. Mechanism, verified:

**There is NO LLM in the live titling path.** `services/titleSpecService.js` has zero
`chatCompletion` references. `resolveSpec` (`:121-162`) is purely deterministic:
 1. stored override docs — **ad > product > category > brand** (`:123-138`)
 2. pinned named preset `brand.titleStylePreset` (`:141-152`)
 3. canonical floor `remotion/presets/canonical.json` (`:155-161`)
Title Studio (`aiLayoutStudioService.js:219`) DOES call an LLM, but it **persists** a
`titleStyleSpec`; the renderer just replays that stored document.

**The render logged `spec=brand`.** Per `:130-135` that tier only returns when
`brand.titleStyleSpec[format]` exists AND validates. So Allbirds carries a persisted `vertical`
spec that wins over everything below it.

**Canonical is clean — proving the render was not canonical.** `remotion/presets/canonical.json`
`byFormat.vertical` has `scrim: "none"` for every slot. The render HAS a heavy scrim, so it
categorically did not use canonical. The `0e885c5` / `da1f2b4` "no-scrim cinema standard" is
being bypassed for any brand holding a stored spec.

**Where the good titles came from:** `remotion/presets/` holds CURATED per-brand presets —
`soludos-mediterranean-editorial`, `soludos-summer-postcard`, `pelagic-bluewater-editorial`,
`pelagic-offshore-bold`, `babyboo-editorial-monochrome`, `babyboo-main-character`. Allbirds has
NO preset, so it never reaches tier 2 or 3.

**THE STRUCTURAL BUG:** a persisted brand spec permanently shadows the canonical standard.
Improving canonical reaches only brands with no stored override. Any brand frozen with an old
spec keeps that look forever, silently. Needs a version/freshness stamp on stored specs so a
stale one falls through, or an explicit "prefer canonical unless curated" rule.

**Owner direction:** *"even the canonical titling is okay but use the right fonts and right
positioning."* So the target is: reach CANONICAL (not the stale stored spec), with correct brand
fonts (see §0.27 — Allbirds gets Inter because "Self Modern" matches no substitution) and better
positioning. NOTE canonical's only anchor is `upperThird`, which is exactly the top-heavy layout
measured in §0(c) — 26% of frame height unused. Positioning is a CANONICAL-level fix.

### 0.297 THE SWEEP EXERCISE (2026-08-04, owner-directed, plan-approved)

Owner authorized unlimited $0 re-renders; objective: re-title EVERY 9:16/4:5/1:1 master
(367 of 374; 238 reels / 28 stories / 64 4:5 / 37 1:1), score on six axes (positioning,
color, legibility, on-brand, conversion, animations), report recommendations.
Plan: ~/.claude-work/plans/shimmying-orbiting-panda.md. Fable is CREATIVE DIRECTOR for
templates (owner-directed); Grok drafts; scoring agents are persona-primed.

**THE BIG ONE — canonical was the OLD template.** Owner: "we had a new titling template you
are using the old one." Verified: the three curated presets share a 9-slot/3-phase
architecture (hook -> proof with rating stars+count -> close with productName/deliveryLine/
CTA at lowerThird) that canonical.json never received. Now REBUILT (PR #60, merged a29be17):
canonical + three funnel variants (awareness/consideration/conversion, mirroring the static
intents — owner wants funnel-position ads like static) + two experimental prototypes
(proto-kinetic-center, proto-bottom-editorial) for the scoring pilot.
- CTA visible:true everywhere (owner decision; was false even in the presets).
- There is NO separate endcard in the Remotion path (canvas-era only) — the close phase IS
  the endcard. The card seen at 7.8s in the 08-04 re-title came from the stale brand spec.
- Fable direction pass: canonical/conversion/protos cut text phases ON the camera cuts
  (2.7/5.1 = buildVeoPrompt scene marks dur/3, 0.64*dur); CTA rides the reveal (+60% screen
  time). Awareness/consideration keep divergent pacing AS their A/B hypothesis.
  **Owner caveat (correct): camera beats drift per video** — requested marks are a prior.
  Sweep adds mechanical scene-cut detection (local ffmpeg, $0) as a per-video metric;
  if drift is material, fast-follow = per-render beat-snap via plate intelligence
  (timing.js already time-warps specs; precedent exists).
- resolveSpec tier 0: presetOverride argument (never persisted) for funnel A/B;
  driver --preset flag. titlingSnapshot records 'override:<name>'.
- productName cleaned for display (parenthetical stripped; productNameFull preserved);
  word-safe truncation. NOTE: my earlier claim that Canonical.jsx:98 .slice(0,cap) was the
  truncation site was WRONG (that is a maxItems cap); the clip was CSS line-clamp on the raw
  SKU. Fixed at the meta source.
- scripts/retitleDriver.js: serial $0 sweep driver, money-invariant verified line-by-line
  (renderBrandScriptAndSave only; side cost ~$0.02/cropped-format ad for face-detect vision
  on cache miss, ledgered; worst case ~$2 across the 101 cropped ads).

**Sweep state:** deploy of a29be17 in progress. NEXT: owner-gate render (ONE Allbirds
vertical on new canonical — owner must approve frames before sweep), then format smokes,
then pilot: 12 ads x 6 templates = 72 renders ($0), persona-primed scoring
(Brand.demographics/tone/tagline — pulled to scratchpad sweep/brand-personas.txt; GymShark/
Peloton/Soludos2/Fellow have EMPTY profiles -> category-generic fallback + recommend brand
enrichment), then full 367 sweep + report. Pilot manifest: scratchpad sweep/pilot-manifest.txt.
NOTE: no brand has titleStylePreset set, so the whole sweep renders pure canonical-family —
clean single-variable test.

**Adversarial reviews on the diff found and fixed pre-commit:** failed re-ingest clobbering a
good font mirror; no magic-byte check on downloads (HTML-as-200 became a "usable" face); human
needsLicense holds wiped by re-ingest; commercial faces starving the ingest cap. Documented
footgun (not yet fixed): Title Studio still authors/previews persisted specs that renders now
ignore — preview != ship; needs a UI warning.

### 0.298 CANONICAL TITLING TEST — iteration log (2026-08-04 overnight; TEAM TESTS TOMORROW)

**Owner deadline: canonical titles working by morning; the whole team tests static + video
production.** Iterations, each frame-verified, all $0 re-titles of the same 12 pilot ads:

- **v1 (PR #60):** 9-slot canonical worked (fonts, CTA, cleaned names, close on the reveal) but
  proof phase ran empty when quote+rating were withheld, and white ink shipped on light plates.
- **Ink root cause (PR #61):** the plate scan only ran for placement='content' — canonical
  renders had plateHints=null so the contrast flip could NEVER fire. Scan now always on (render
  + preview), kill switch intact. ALSO in #61: atomic brand-rating fallback
  (`resolveAtomicRatingPair`, Brand.brandReviews same-snapshot pair, honest attribution, >4.5
  gate, mixing bug pinned); camera-prompt subject-lock + Scene-3 return-to-primary + crossfade
  policy; REPEAT_PRIMARY_REFERENCE (default true, cap 4 refs).
- **v2 sheets (canon2):** ink flip fired (AllBirds dark Playfair on light wall ✓), stars+counts
  live (Pelagic 5.0/5, Vuori 4.6/5 + 15,545 ✓), CTAs everywhere ✓. NEW defects: rating rows on
  FACES (keep-out computed but never applied); ink flip inconsistent (Vuori white-on-light);
  Vuori brandPill rendered a broken gradient box; "- Warm Red" / "| ..." suffixes; deliveryLine
  faint.
- **Iteration 2 (PR #62):** keep-out APPLIED (group shifts to first clear band, stable, logged
  `keepOut:`); ink vote inputs fixed (band rects tightened to the real text strips — old top
  band spanned 26% incl. faces; median luma; 5 sample times; logged `inkVote:`); deeper name
  cleaning (parenthetical -> pipe -> dash-colorway w/ short-name guard); deliveryLine w600
  primary ink. brandPill hidden by default everywhere (owner: Meta draws its own page identity;
  doubly validated — Vuori's pill rendered broken).

**Owner directions recorded:** multi-color type allowed when brand-tokened (per-group ink =
NEXT iteration, deliberately not tonight); owner waits for the canon3 contact sheet; funnel
variant A/B + 6-template pilot PARKED until canonical is approved (variants + protos exist and
validate; sweep infra ready).

**$1 REGENERATE (end-to-end pipeline test) — all green + one discovery:**
- Ledger PROVEN live: `atlas_video_render | $1 | submitted` — the widened-enum fix recording
  real video spend. Crop-vision rows ledgered (~$0.004).
- Money guard observed live: renderUrl briefly = raw master (draft stamp) then titled.
- Owner's prompt idea WORKED: "end on the FIRST reference image's view" -> front-on close, CTA
  riding it. The structural repeat-primary version is deployed but has NEVER run a live
  generation (regen predated #61) — MUST validate with one $1 regen before the team generates,
  else flip REPEAT_PRIMARY_REFERENCE=false.
- **NEW DEFECT CLASS: Omni mangles on-product wordmarks on zoom shots** — tongue label rendered
  "wfoirds" in the 3.5s detail shot. Video-side proof of the vision-QC case (§0.2).

**Ops learnings tonight (cost real time):** `nohup &` dies with the render-ssh PTY — use
`setsid nohup ... < /dev/null &`. The BACKEND web service is MULTI-INSTANCE — a file written in
one render-ssh session may not exist in the next; write+launch in ONE session, monitor via DB.
The worker is single-instance and safe for long drivers. /tmp scripts can't require app
modules (documented trap; bit again — run from /opt/render/project/src).

### 0.299 TEAM-DAY READINESS — VALIDATED 2026-08-04 ~02:30 (read this first tomorrow)

**Prod = `bb024b8` on both services. Suite 34/34. Canonical titling: WORKING, frame-verified
in all four sizes** (final contact sheets delivered to owner ~02:05; canon3 = iteration-2
build: keep-out off faces, consistent ink, cleaned names, legible deliveryLine, CTA everywhere,
no brand pill).

**Production validations run tonight (total ~$2.05):**
- STATIC regenerate: 74s, healthy, logo composited, >4.5 star gate live (weak rating correctly
  suppressed), NO invented emblem this sample. $0.01 ledgered `ok`.
- VIDEO regenerate, DEFAULT PATH (empty prompt — exactly what the team clicks): **full pipeline
  97s** (Omni was fast: submit 09:06:47Z -> master +52s -> titled +41s), $1 ledgered
  `submitted`, **REPEAT-PRIMARY CONFIRMED LIVE** (1 distinct ref -> [primary, primary]), and
  the close RETURNS TO THE FRONT-FACING PRIMARY VIEW with CTA + allbirds.com attribution.
  NOTE a correction: an earlier in-session read that empty-prompt regens dedupe to $0 was
  WRONG — the explicit regenerate route always regens fully (adRegenerateService: "video
  always regens fully", effMode='full'). Every explicit video regenerate costs ~$1. The
  accidental-double-click protection lives on the GENERATE path digest, not regenerate.
- Earlier prompt-lever regen ($1): ending fixed via operator prompt; found Omni mangles
  on-product wordmarks on zoom shots ("wfoirds") — vision-QC case, video-side proof.

**KNOWN LIMITATION for tomorrow:** proof phase renders empty when a brand has neither a
gate-passing quote nor a >4.5 rating pair (product or brandReviews). AllBirds sheet row shows
it. Not a crash — just a quiet middle beat. Brand enrichment for GymShark/Peloton/Soludos2/
Fellow would populate personas + brandReviews.

**Grok CLI: re-authed by owner 2026-08-04 morning, probe verified (0.2.117).** (It had signed
out overnight mid-session — auth sessions can expire; on `Not signed in`, fall back to
subagents and tell the owner, don't retry.)

**Efficiency audit** (owner-requested): two subagent audits over render + generation paths
were in flight at handoff-write; findings land in this file / the conversation when done.
Seeds already measured: webpack bundle rebuilt per driver invocation (4-10s), Chrome 91.9MB
per fresh instance, plate scan now per-render (cacheable on Ad like basePlate crops),
storyboard-LLM-on-regen possibly wasted on canonical path, fixed 15s Omni poll, video costs
never reconciled to actuals (veoPredictionId is persisted; image reconcile pattern exists).

**PARKED, awaiting owner:** funnel-variant A/B (presets exist + validate), 6-template pilot,
full 367 sweep + persona scoring, AI endcard arm ($0.01/video), per-group brand-tokened ink
(owner allowed multi-color), Title Studio preview!=ship warning.

### 0.2995 EFFICIENCY AUDIT (owner-requested, 2026-08-04 night) — verified findings, NOT yet implemented

Two subagent audits (Grok signed out), every load-bearing citation spot-checked by hand.
Post-team-day work; nothing deployed. THREE of the audit's seed premises (mine) were WRONG and
are corrected here so nobody re-chases them:

- **Webpack bundle is ALREADY cached** — module-scope memo (`remotionRenderService.js:45-62`)
  + @remotion/bundler filesystem cache (enableCaching default). The 4-10s observed was
  warm-cache. The sweep driver is one process -> bundle paid ONCE per sweep. No fix needed;
  just never chunk the sweep into many separate invocations.
- **Plate scan is LOCAL ffmpeg**, not Cloudinary network (`plateIntelService.js:63-79,174-221`
  runs against the already-downloaded platePath). The Cloudinary so_<sec> stills belong to the
  face-crop detector, which is ALREADY cached per (veoVideoUrl, format) via `Ad.basePlate`
  (`basePlateCropService.js:298-311`).
- **Storyboard LLM on regen is DEAD CODE on the Atlas path** — `prepareStoryboard` returns
  `storyboard:null` (`atlasVideoService.js:2527-2533`); `buildVeoPrompt` marks the param
  unconsumed. $0 today. (`VEO_USE_GPT_STORYBOARD=true` in defaults.env is a no-op — hygiene.)

**Real wins, ranked (effort S unless noted):**
1. **Video cost reconcile to actuals** (accuracy, M): `reconcileCost` has one call site
   (images). Video charge point already persists `veoPredictionId`; NOTE the terminal poll
   already hits `GET /model/prediction/{id}` — the settled `price` may ride the completion
   response for ZERO extra requests (verify live; images' comment warns price can lag).
2. **`Ad.plateHints` cache** keyed by (plateUrl, FORMAT — not just veoVideoUrl; cropped plates
   differ per format), mirroring `Ad.basePlate`: skips 5x ffmpeg+sharp per repeat re-title.
   ~0.5-2s/render on preset-sweep reruns.
3. **Regenerate flow Mongo diet:** `prepareStoryboard` call in `adRegenerateService.js:195` is
   pure overhead (outputs discarded, cache-warm no-op on re-renders) — 6-10 round-trips;
   `loadBrand` (`:174-181`) re-derives brand via Ad->Media->Brand when `ad.brandId` is on the
   doc; 4x Brand loads and 4x Ad loads per regenerate, 2 of each avoidable.
4. **Upload double-buffer** (`brandScriptExecutor.js:1012` readFile -> `cloudinaryService.js:46`
   streamifier): stream disk->network directly. Tens-to-100s of ms.
5. **Chrome pre-warm may be silently failing:** postinstall runs `npx remotion browser ensure
   || true` (`package.json:11`) yet a fresh instance downloaded 91.9MB at first render. The
   `|| true` swallows failures and vendored remotion pkg has `bin:null` — CHECK RENDER BUILD
   LOGS for that step's real output. Same class as the f89e30b Puppeteer saga.
6. Cosmetic/doc: stale `resolveBrowserExecutable` comment (`remotionRenderService.js:91-94`
   points at the pre-f89e30b puppeteer cache path); `docs/TITLING.md:215-232` still documents
   content-mode-only 3-sample scan — violates the fix-docs-in-same-commit rule; fix with the
   plateHints work.
7. Omni polling: fixed 15s+jitter is fine for wall-clock (completion detection lag <=18s);
   the lever is fewer polls for rate-limit headroom, and no sync/webhook field exists in any
   of the 5 param shapes — upstream capability UNVERIFIED.

### 0.2999 UI END-TO-END TEST + ITERATIONS 3/4 (2026-08-04, owner driving)

**UI test (owner's Chrome, staging): TEAM PATH PASSES end to end.** Wizard -> dispatch ->
2 Omni masters ($1 each, ledgered `submitted`) -> square face-crop titling -> playable in Meta
preview -> run `done` -> **Slack per-run feed POSTED (first live observation —
CampaignRun.slackFeed {ts, channel})**. Video dedupe protected the third product (Warm Red
already owns video ads — not re-billed). 8s is the wizard default. UI findings logged as
tasks: Render Activity board never fetches its data (#13); format chips only register on the
active card + video cards mislabeled AI_BRAND_LED (#14); preview-chrome "Lorem ipsum"
confirmed live (known-open).

**Iteration 3 (PR #63, deployed):** sizeScale bumps (~x1.2 family-wide, fit arithmetic
verified); `visibleWhenEmpty:"<slotKey>"` spec property (cycle-proof) + proof-phase fallback
headline when the quote is gated empty; animated rating lockup — stars pop L->R on staggered
springs with TRUE partial-star fill (clipPath; stars were full-only before), count rolls 0->N
ease-out with tabular-nums; settle 1.48s; all useCurrentFrame-deterministic. Suite 35/35
(verifyRatingMotion 26).

**canon4 (14 ads = pilot 12 + the 2 UI-run ads) frame review — CORRECTIONS:**
- An initial "proof beat regressed, quote+stars gone" read was WRONG twice: (a) the quote gate
  withholds on EVERY pilot ad (unstamped provenance) — the fallback claim rendering is the
  DESIGNED behaviour, canon3 never had quotes either; (b) the sheet's 3.2s proof frame caught
  the stars MID-ANIMATION at near-zero scale — at 4.6s the Pelagic lockup is exactly as
  directed (brand-navy claim + large gold ★★★★★ 5.0/5). Sheet proof frame moved to 4.6s.
- Pelagic's blue type = its own brand on-light token (inkVote flipped on-light) — the
  "multi-color if on-brand" direction emerging naturally.
- **REAL defect 1: keep-out NEVER fires** — zero `keepOut:` log lines; the basic plate scan
  never sets band `avoid` flags (luma-only). Text still lands on faces.
- **REAL defect 2: ink tie rule** — `light=3 dark=3 -> brand-default` put white type on a
  near-white wall (AllBirds proof beat).

**Iteration 4 (in flight):** wire the EXISTING cached face detection (detectClipBoxes,
~$0.02/master once, ledgered) into plateHints `avoid` bands behind TITLE_FACE_KEEPOUT
(default true), incl. explicit pixel->fraction coordinate conversion; ink tie breaks toward
global median plate luma (>0.55 -> on-light), logged. Then canon5 re-render + artifact
refresh (same URL).

### 0.29995 CANON5 — iteration 4 VERIFIED IN FRAME; artifact refreshed (same URL)

14/14 re-titled on `b97991d`. Live log evidence: `keepOut: top->center (face band)` x2 fired;
`inkVote: light=3 dark=3 tie -> globalLum 0.81 -> on-light` — both iteration-4 mechanisms
working. Frame review: Pelagic proof lockup fully OFF the face (brand-navy claim + large gold
5.0/5); Vuori shows the complete lockup incl. "15445 reviews · vuoriclothing.com"; AllBirds
proof headline rides the red toe in white Playfair — correct per-plate ink (verified at full
res; three separate low-res sheet misreads this session — ALWAYS zoom the native frame before
judging ink/animation; sheet proof frame is 4.6s post-settle for this reason).
Approval-grid artifact refreshed in place:
https://claude.ai/code/artifact/535b2728-b623-4898-9841-518e89b03798 (iteration 4 status).
AWAITING OWNER: approve -> full 367 sweep + persona scoring; or flag -> next $0 iteration.

### 0.29996 TEAM-DAY LIVE REPORTS — THREE REPORTS, ONE ROOT-CAUSE FAMILY (2026-08-04)

*Rewritten after measurement. An earlier version of this block claimed brand stars were read
from the wrong document and treated the schemaVersion hole as the whole story. Both were wrong;
corrected below. Full plan: `~/.claude-work/plans/graceful-forging-gem.md`.*

Owner, mid-testing: (1) *"not seeing the canonical title being used on videos"*; (2) *"we are not
seeing customer comments … there should be at least brand slugs … we opened up the llm gating
removing attribution, but I am not seeing that"*; (3) *"what happened to the star reviews and
review counts? We were going to brand level stars and counts but now I am not seeing any."*

**These are ONE root cause.** The titling IS canonical — prod web+worker both on `b97991d`
(`render-ssh` `RENDER_GIT_COMMIT`), no `TITLE_SPEC_*` env override, and every `🎨 brandScript`
line since 10:26 logs `spec=canonical` (the lone `spec=brand` was 04:26, pre-fix; the SAME ad
re-titled at 17:15 logs `spec=canonical`). What is missing is the **proof phase** — canonical's
quote + reviewer + rating lockup, the distinctive part of the template. With the quote withheld
AND the rating withheld, `headline` takes over via `visibleWhenEmpty:"quote"` and the beat
degrades to a repeated headline. So report 1 is a *symptom* of reports 2 and 3.

| # | finding | evidence |
|---|---|---|
| A | `buildMetaForAd` loads the artifact by **`mediaId` only** — no `productId`, no `schemaVersion` | `brandScriptExecutor.js:713` |
| B | **722 of 738** layout artifacts are pre-`4.1` → unstamped quotes the gate must withhold | prod count |
| C | Video path rebuilds **only when the artifact is empty**, so stale-but-populated is never refreshed | `atlasVideoService.js` `lpEmpty` ~:2497/:2590 |
| D | Brand-tier quotes **withheld from product ads** by design | `layoutInputService.js:2023-2028`; live `🔒 quote scope` |
| E | Brand stars cannot clear `>4.5`: **only 4 of 34 brands qualify** | prod query |

Live proof of B/C: `quote withheld (tier=unstamped origin=unstamped)` fired at 17:10 and 17:15
today. **STATIC is unaffected** — `renderService.js:332` calls `buildLayoutInput`
unconditionally and its cache treats a `schemaVersion` mismatch as a MISS → rebuild → stamped
`llm-web` quotes flow (live: `winner=product "The shoes are very comfortable"`). The hole is
video-only.

**On E, the numbers that matter.** Brands with a brand rating = 16/34; clearing the owner's
`>4.5` rule = **4** (Pohnpei 4.7, Camelbackflowers 4.9, Ubeauty 4.8, Vuori 4.58→4.6). The two
brands under test today both fail: **GymShark 3.3** (with 41,000 reviews and 6 brand quotes) and
**AllBirds has no `brandReviews` at all**. Nothing regressed — `resolveAtomicRatingPair` (PR #61)
is correct and live; the DATA cannot clear the gate the owner asked for.

**TWO HYPOTHESES TESTED AND KILLED — do not re-chase:**
- *Brand stars read from the wrong doc:* **FALSE.** `ProductMatchArtifact.brandReviews` is `null`
  for every ad checked; `Brand.brandReviews` is the correct source. AllBirds simply has no data.
- *The `llm-web` attribution opening regressed:* **FALSE.** `quoteProvenance.js` is correct and
  live; `llm-web` prints as anonymous text with bylines structurally deleted. What blocks these
  ads is B/C (stale artifacts) and D (brand tier withheld), not the provenance rule.

**Owner decisions this session:** stars → when the brand rating fails `>4.5`, print the **review
count paired with a positive brand-level quote**, no stars (*"let's try using the number of
reviews with a positive review that we have plucked out at the brand level"*); brand-tier quotes
→ allowed as **last-resort fallback** on product ads, anonymous; enrichment → backfill
`brandReviews` for all brands missing it; **NO sweep** (*"just make a fix and redeploy so we can
keep testing"*).

**INTEGRATION GAP found while building (important).** `buildMetaForAd` only READS artifacts —
`buildLayoutInput` is what rebuilds. So a `schemaVersion` filter makes a stale artifact resolve to
"none" → degrade to `ad.copy` → still no quote on a $0 re-title; only NEW generations rebuild.
Worse for the brand-tier fallback: `primary_quote` is baked in at **assembly** time, so existing
v4.1 artifacts assembled before the change hold no brand quote (GymShark `6a70cf95` is v4.1 with
`q=NONE`). Re-titling alone therefore cannot validate the brand-quote path — the artifact must be
rebuilt first. Deliberately NOT fixed by adding an LLM call to the render path (`retitleDriver`
must stay ~$0).

**Grok CLI headless: NO for edits, YES for review — with the diff INLINED.**
`grok -p …` prints narration and exits WITHOUT executing tool calls: no file edits, exit 0,
silently. `--max-turns 60` and `--permission-mode acceptEdits` do not change it;
`bypassPermissions` is blocked by Claude Code's classifier. So use **subagents** for anything
that edits files.
**But review works and EARNED ITS KEEP.** An earlier version of this note claimed review was
useless too — that was wrong, written before the long pass returned. With the full diff pasted
into the prompt (no file access needed), one high-effort pass found **two real HIGH defects that
37 green harnesses and my own line-by-line read both missed** (§0.29998). The other pass, given a
"look for interaction bugs" steer, returned narration only. Lesson: inline the diff, ask for
refutation, allow it several minutes, and do not judge the run from a truncated interim file.

### 0.29997 IMPLEMENTATION — code COMPLETE + verified, DEPLOY HELD BY OWNER (2026-08-04)

Landed in the working tree, NOT committed (owner held it — see the shared-tree note below).
`config/defaults.env` gains `QUOTE_BRAND_TIER_FALLBACK=true`.

| change | file |
|---|---|
| Artifact lookup scoped by `productId`; fresh schema PREFERRED, stale DEMOTED not dropped | `services/brandScriptExecutor.js` |
| `allowBrandCountWithoutStars` — third outcome: count prints, stars withheld, `source:'brand-count'` | `services/ratingDisplay.js` |
| Brand tier demoted to last-resort on product ads (flagged, default on); brand-ad order UNCHANGED | `services/layoutInputService.js` |
| Stale artifacts rebuilt on the video path (one `refreshStaleLayoutInput` helper, both call sites) | `services/atlasVideoService.js` |
| Rating slot non-empty on count alone; `rating:null` distinguishes "no stars" from "zero stars" | `remotion/lib/slotContent.js` |
| Star row + score skipped entirely when `rating == null`; count animation starts at slot enter | `remotion/components/slotRenderers.jsx` |
| New revert-proven harness (22 checks) | `scripts/verifyProofBeat.js` |
| New dry-run-default enrichment driver, NOT yet run | `scripts/backfillBrandReviews.js` |

**Verify: 37/37 scripts green.** `verifyProofBeat` revert-proven 5 ways (break the count-only
branch → 4 fail; delete `tier` in the byline strip → 3 fail; restore the old rating-only bail →
S1 fails; remove the star-row guard → S3 fails; unconditional `countStartSec` → S4 fails).
**One pin was initially too weak and passed while the guard was deleted** — a bare
`/rating != null ?/` matched the `countStartSec` line ~80 lines away. Now requires the guard
within 400 chars of `<StarRow>`. That is the whole argument for revert-proving.

**A REGRESSION THE FAN-OUT ALMOST SHIPPED — corrected by hand.** The subagent filtered the
artifact query on `schemaVersion`, which drops a stale artifact ENTIRELY. But **ten** meta fields
take `layoutInput` as their FIRST cascade source — including `rating` and `reviewCount` themselves,
plus `deliveryLine`, `badgeText`, `badges`, `benefits`, `productDescription`, `likes`. With 722/738
artifacts stale that would have thinned the close phase and DELETED the very stars this work
restores. Freshness is now a preference with a fallback; the unstamped quote is still withheld by
`gateLayoutInputQuotes`, which is all the filter ever bought.

**Adversarially verified BY EXECUTION** (Grok review unusable, see above) across the real
production shapes. Every row traced pair → Remotion slot:
| input | renders |
|---|---|
| stale AllBirds: product 4.4, no brand data | slot EMPTY → headline fallback |
| GymShark: brand 3.3 / 41,000, brand-tier quote | **no stars, "41000 reviews · gymshark.com"** |
| brand count, no brand rating | no stars, count prints |
| brand 4.7, no count | 4.7 stars, no count line |
| 0–100 scale (87) | no stars, count only — 87 never becomes a star value |
| `reviewCount: 0` | slot EMPTY — never "0 reviews" |
| product count 41,000 + brand rating fails, no brand count | slot EMPTY — **cross-tier leak blocked** |
No forbidden star value reaches the screen on any path, and nothing crashes (`rating.toFixed(1)`
was a latent throw on null before the guard).

**Two latent items, deliberately NOT fixed (no live consumer):**
1. Brand quotes now also enter `secondary_quotes` on product ads. That pool bypasses the
   last-resort ordering. Read ONLY by `aiCanvas*` / HTML services, which §1 documents as dead for
   new generation; the Remotion path binds `primary_quote` only. If a canvas path is ever revived
   it needs its own scoping decision.
2. A rating stored as a STRING ("4.7") that would legitimately clear the gate now renders
   count-only, because `formatDisplayRating` requires `typeof === 'number'`. Pre-existing and
   harmless (never prints a WRONG value), but it silently forfeits real stars.

**COST — re-titling is no longer unconditionally $0.** `buildLayoutInput` runs an LLM derivation
on a cache miss, so rebuilding a stale artifact costs one derivation per ad. Scoped to the stale
population (722/738); schema-current rows still cache-hit at $0. A full sweep would therefore be
billable — a second reason the owner's "no sweep" call is right.

**SHARED WORKING TREE — why nothing is committed.** A concurrent session is editing this same
tree: `routes/ads.js` (new `POST /api/ads/video-ref-prewarm`), new
`services/videoRefPrewarmService.js`, and `services/costTracker.js` (re-prices
`gemini-2.5-flash` 3x input / 6x output as Flash-LITE numbers, and adds a $0.035/call
grounded-search surcharge). `services/atlasVideoService.js` is MIXED — the proof-beat helper and
their prewarm/reframe hunks share the file. Owner chose HOLD: land that session first, then commit
and deploy this on top. **Do not commit the tree as-is** without deciding on those three files.

**Money-invariant gap found in passing:** the Gemini brand-reviews tier
(`geminiSearchProvider.lookupBrandReviews`) calls `axios.post` against the raw Gemini endpoint with
**no costTracker/CostLog involvement at all** — unlike the GPT tier, which is ledgered. So brand
enrichment spend is invisible in month-to-date totals. The concurrent session's `costTracker.js`
grounded-search surcharge may be addressing exactly this; reconcile rather than double-ledger.

### 0.29998 ADVERSARIAL REVIEW FOUND TWO REAL HIGH BUGS — both fixed, both revert-proven

The two-pass rule paid for itself again. Neither defect was caught by 37 green harnesses, by the
9-shape execution trace, or by my own line-by-line read. Suite now **39/39**, `verifyProofBeat`
at **26 checks**.

**HIGH 1 — the count-up animation printed FABRICATED totals.** `parseReviewsLeadingNumber`
(`remotion/lib/ratingMotion.js:93`) used `/^(\d{1,3}(?:,\d{3})*|\d+)/`. Alternation is ORDERED, so
on an uncommaed run of digits branch one won: **"41000" matched only "410"** (`\d{1,3}` greedy,
then zero comma groups) → `target:410`, `suffix:"00 reviews · gymshark.com"`. The count rolled
0→410 with a stray "00" beside it, so mid-animation frames read **"18800 reviews"**, "30800", … —
numbers no source ever produced — for ~0.9s of paid video. Only the SETTLED frame looked right,
which is exactly why every post-settle contact sheet passed it. `reviewsText` is built uncommaed
by `ratingDisplay.js`, so any count ≥1000 was affected ("8343" → 834 + "3 reviews").
Reproduced before fixing. Fix: `/^(\d+(?:,\d{3})*)/` — `\d+` first, comma groups optional.
Verified: 41000/8343/15,545/128/1/1,234,567 all parse whole; mid-roll now "18,860 reviews",
settled "41,000 reviews · gymshark.com". **This was PRE-EXISTING** (Vuori's 15445 shipped through
it) but the count-only path makes an uncommaed count the primary proof, so it became load-bearing.

**HIGH 2 — the brand count could ride a quote that was not the brand's.** The gate read
`primary_quote.tier === 'brand'`, but the quote that RENDERS is `cascaded.quote`, and that cascade
puts **`ad.copy.quote` FIRST**, layoutInput's primary_quote second (`metaCascadeConfig.js:49-52`).
So an ad carrying an operator-edited or stale `ad.copy.quote` rendered THAT line while tier still
said 'brand' — hanging a catalog-wide review count off a product-specific claim that never passed
the provenance gate. Fix: require the brand quote to be the one that actually prints
(`renderedQuote === brandQuoteText`).

**Three further findings ASSESSED, deliberately not code-changed:**
- *Product stars + a brand-tier last-resort quote on one ad.* Rating/count atomicity still holds
  (both product-tier). What remains is the cross-product quote risk the owner **explicitly
  accepted** when approving the fallback. Documented, not "fixed" — fixing it would gut the
  feature that was asked for.
- *Brand stars beside a product-tier quote.* Real but **pre-existing**: the brand-rating branch is
  untouched by this work. Out of scope; worth its own pass.
- *`slotContent` does not re-apply the >4.5 rule.* Defence-in-depth gap, pre-existing — the
  renderer trusts `meta.rating`, and `buildMetaForAd` is the only writer. Adding a second
  enforcement point risks the two diverging; left as the single-source design.

**METHOD NOTE worth keeping:** two of my own source-pin checks initially passed while the code
under them was broken — the star-row guard pin matched an identical expression 80 lines away, and
the regex pin matched the old pattern quoted in its own explanatory comment. Source pins must
strip comments and assert PROXIMITY. Both were caught only by revert-proofing.

### 0.3001 OWNER TEAM-TEST ROUND 2 — three complaints, all real, all fixed (2026-08-03 22:0x)

Owner, on delivered ads: *"these titles are not the canonical titling we have discussed, I am
seeing the shipping car show back up, there is a dark pill, I am not seeing star ratings or
reviews, I am unclear why we reverted to this again?"* Prod now `8febbf2`, suite **42/42**,
`verifyProofBeat` **31**.

**"why we reverted" — WE DID NOT. The template is intact.** `git log b97991d..HEAD` over
`canonical.json` + `slotRenderers.jsx` + `Canonical.jsx` + `slotContent.js` returns exactly ONE
commit, `0319c68`, which is the merge that landed this session's own work. Every recent render
logs `spec=canonical placement=canonical`, and the four newest ads' `titlingSnapshot.spec.source`
is `canonical`. What the owner saw was three separate defects on top of an unchanged template.

**(1) NO STARS / NO REVIEW COUNT — a PROJECTION, not the rating logic. THE BIG ONE.**
`routes/ads.js:1315` (generation — what the wizard runs) and
`adRegenerateService.loadBrand:393` both `.select()` an explicit brand field list, and **neither
listed `brandReviews`**. So `buildMetaForAd` saw `brand.brandReviews === undefined` → `brandPair`
null → `resolveAtomicRatingPair` returned `source=none`, and **every generated ad shipped with no
stars and no count** — including **Vuori at 4.58 / 15,545**, which clears the >4.5 gate outright.
Why it hid: a projection omission is indistinguishable from a brand with no review data;
`resolveAtomicRatingPair` was correct all along so unit coverage passed; and — the part that
matters — **the canon5 sheets the owner approved were rendered by `scripts/retitleDriver.js`,
which loads the FULL brand doc.** Stars appeared there and were NEVER achievable through the
generation path. That is the whole "we had it and lost it" feeling, and it was never a regression.
Proven live after deploy: `PROJECTED brandReviews={r:4.58,c:15545}` → `ratingPair: source=brand
rating=4.6 count=15545` → frame shows gold ★★★★½ 4.6/5 + "15,545 reviews · vuoriclothing.com".
Pinned by `verifyProofBeat` P1 (revert-proven).

**(2) "SHIPPING CAR" — a truck icon stapled to copy that never mentioned delivery.**
The `deliveryLine` slot is labelled "Delivery / offer line" but its cascade binds
`layoutInput.input.product.badges[1]` — the SECOND BADGE. Text is routinely "Premium Cotton",
"Best Seller", "New Arrival", and the old condition (`endcardMode !== 'brand'`, i.e. every product
ad) drew a truck next to all of them. Icon is now content-gated (`DELIVERY_CLAIM`), so it appears
only for an actual delivery/shipping line and returns automatically if one is ever bound.
**The cascade mismatch is left alone deliberately** — the line reads fine as badge text; rebinding
it changes what copy appears and is an owner call.

**(3) "DARK PILL" — brand-token pill read as scrim.** `BadgeSlot` filled a `Pill` from
`badgeBg`/`badgeText`, so the same slot shipped CHARCOAL on Vuori and cream on GymShark, and on a
light plate the dark box was exactly the scrim the no-scrim standard exists to remove. Owner chose
*"Plain text, no pill"*. Badge now renders small-caps in `textPrimary`, so the contrast flip drives
it and it is consistent across brands. `Pill` stays for CTA/promo, which should read as buttons.

**(4) LOGO — owner: *"keep the static but I noticed the allbirds logo is put on a block of white,
the logo should just be rendered in black or white depending on the color of the background."***
Static compositing stays ON (the model is still forbidden from drawing a logo). The asset was
composited verbatim, so a logo on an OPAQUE white canvas painted a white rectangle. Now re-inked
as a single-colour silhouette chosen from the mean luminance behind it (`monochromeInkFor`,
>0.5 → black else white); coverage from alpha when present, else luminance in whichever polarity
the asset's own border implies, so white-on-black assets don't invert into a block. Failure falls
back to the original asset. **NOT yet visually verified — needs one static render (~$0.01).**
Video titling was never the source: `brandPill` and `brandLogo` are both off in canonical.

### 0.3005 TYPE EXPERIMENT — OWNER-DIRECTED WORKSTREAM (2026-08-04). READ THIS BEFORE CONTINUING.

**Owner verdict on the 17-ad sample** (artifact 3f801888-f0d0-4d28-af66-1ee62078d894): good EXCEPT
Pelagic (font style regressed — my styleTheme alias moved it Oswald→Montserrat) and BabyBoo
(before better). Verbatim directives: *"let's just stick to black or white type only when on a
dark subject with a dark background, either with a drop shadow. The red lettering and white
lettering you are choosing is tacky and doesn't look professional"* — measured cause: `textOnLight`
fell back to brand PRIMARY (`titleSpecService.js` — Pelagic `#4d92b6` blue, BabyBoo `#ba3357`
red). And: *"look at the GPT2 static ads, those look perfect with regards to font usage, color,
placement"* — note the static path does NOT prescribe type; it hands typography to gpt-image-2
("typeface and weight, the scale and colour of every text element", `staticAdIntents.js:747`).
There is NO downloadable type rulebook in the repo; the constraint must be encoded.

**THE EXPERIMENT (owner-approved, including LLM spend and $0.01 image calls for brands lacking
statics): three arms over the SAME 30 masters, variety of colour/composition/size, then compare.**
- **Baseline** = current pre-fix renders. CAPTURE BEFORE URLS FIRST — re-titling overwrites them.
- **Arm A: disciplined deterministic** = current engine + black/white-only ink + font-order revert.
  STATE: ink fix EDITED (uncommitted) in `titleSpecService.js` — `textOnLight` default `#16181D`,
  no primary fallback; explicit curated `textOnLight` still wins (none in prod). REMAINING: font
  order — a Google-resolvable scanned family (Pelagic "Oswald") must outrank the generic
  `styleTheme.sansFontFamily` alias ("Montserrat"); `ownFace` (usable custom file, AllBirds "Self
  Modern") stays top; update `verifyProofBeat` F2 ordering pins to match; suite; commit; deploy.
- **Arm B: GPT-derived type template** = per-brand: collect 2-3 of the brand's OWN approved
  gpt-image-2 static `renderUrl`s (for brands with none, generate ONE $0.01 static via the live
  pipeline first — owner approved); send to a vision LLM with a STRICT JSON schema → type template
  (ink discipline, casing, weight, tracking, alignment, size feel, NO scrim); map onto a
  canonical-shaped preset JSON; write to `remotion/presets/` AT RUNTIME on the worker pod
  (writable but EPHEMERAL — write + retitle in the SAME pod session); drive via the EXISTING
  tier-0 `presetOverride` / driver `--preset` flag (never persisted).
  MODEL: verify live before use (CLAUDE.md rule) — `google/gemini-2.5-pro` was probed for vision
  QC (§0.2, exact-JSON-shape compliant; flash BROKE the shape). LLM calls are billable: ledger
  them, no auto-retry, `maxRedirects: 0`.
  **Grok adversarial review of the extractor BEFORE any billable call** (standing rule; it found
  real defects in every diff this session).
- **"Test the entire proposed workstream"** (owner, verbatim): after both arms work individually,
  one end-to-end run — selection → baseline capture → arm A sweep → frames → arm B template
  extraction → arm B sweep → frames → 3-column artifact (30 rows: baseline / disciplined /
  template, annotated with each brand's ink+font inputs) — as a single scripted pipeline, not
  hand-stitched steps, so it can be re-run.

**Selection (30):** variety via stored metrics — `adSuitability.metrics.primarySubjectAreaFraction`
(composition), overlay-zone band `lum` (colour/lightness), ≥8 brands, all four Meta formats
(+pmax only with a live brand — three legacy pmax ads failed `brand not found — skip`, correctly).

**BRAND INPUT TABLE (queried live, saves a round-trip):**
| brand | scanned | theme.sans | primary | customFonts |
|---|---|---|---|---|
| Pelagic Gear | Oswald | Montserrat | #4d92b6 | none |
| BabyBooFashion | Playfair Display | — | #ba3357 | none |
| AllBirds | Self Modern | DM Sans | #ECE9E2 | Geograph×8, Self Modern, Akkurat Mono |
| Vuori Clothing | Aktiv Grotesk | — | #333333 | none |
(`textOnLight` explicitly set: NONE. GymShark 3.3/41000, Vuori 4.58/15545, Pelagic 3.2/22,
BabyBoo 4.3/17645, Camelback 4.9, Peloton no data.)

**OPS (relearned the hard way, all this session):** render-ssh <900 chars/cmd, rate-limits under
sleepless loops — back off 60s, ONE call; worker `/tmp` wiped on every pod rotation and a DEPLOY
ROTATES THE POD (never launch a driver right after deploying); driver stdout goes to its own file,
NOT `render logs`; verify JSON edits by PARSING; Haiku is fine for mechanical fan-out but verify
its counts (miscounted twice); the presets round-trip at `indent=2`.

**Tasks #13-#16 track the four workstreams. Owner is compacting the conversation after this
commit — continue from THIS section.**

### 0.3004 TITLE PLACEMENT — the bug was TIMING, not geometry. Tested, awaiting rollout call.

Prod `53e26a4`. Suite 46/46, `verifyProofBeat` 53. **Tested on the three ads the owner
flagged; NOT yet rolled out to the library — that is an owner decision.**

**ROOT CAUSE, and it is not what either of us assumed.** `applyFaceKeepOut` assigns each
detected face box to the NEAREST plate sample. There are typically 3 face samples against 5
plate samples, so some samples carry no face flag at all. `resolveGroupAnchor` makes ONE
decision for the WHOLE clip but read a SINGLE sample — so whether it saw the face was luck.
Proven by running the real path against the real cached data:
```
Vuori   square:   avoid top=TRUE mid=true bot=false
Pelagic vertical: avoid top=TRUE
```
The flags were CORRECT in both. Pelagic's group happened to read a flagged sample and moved off
the face; Vuori's read an unflagged one and walked onto it. Two of my own hypotheses were wrong
first (missing face detection — it was present; then a coordinate-conversion error — the numbers
check out at 0.84 overlap). Do not re-chase either.
**My texture ranking made it worse rather than causing it:** a smooth face is LOW variance, so
once a face flag was missed, skin became the most attractive band in the frame.

**FIX:** `bandStateFor` returns the UNION of `avoid` and the MAX of `busy` across every sample.
A face occupying a band at any point disqualifies it for text on screen across that clip, and
worst-case texture is what legibility depends on. `isLight` deliberately stays nearest-sample —
ink has its own weighted vote (`plateIsLightGlobal`) and widening it would double-count.
Strictly more conservative: it can only ADD avoid flags, and when every band is flagged the
authored anchor is kept, i.e. pre-change behaviour.

**LIVE EVIDENCE — the log reason flipped, which is the tell:**
```
keepOut: top->lowerThird        (face band; authored busy 0.516 -> 0.655)
keepOut: upperThird->lowerThird (face band; authored busy 0.970 -> 0.467)
keepOut: lowerThird->upperThird (busier band; authored busy 0.875 -> 0.497)
```
Same ads previously reported `busier band` (no face seen). Note line 1 moved to a BUSIER band
because the authored one held a face — correct priority: faces disqualify, texture only breaks
ties among clear bands. Frames confirm: Pelagic 9:16 well clear, Vuori 1:1 down off the
eyes/nose, GymShark 4:5 still clear of the wordmark.

**Pinned by K4** (the rule: whichever sample the group lands on, a band a face occupies at t=2
is never chosen; with no face anywhere, texture still wins) **and K5** (the wiring: aggregation
must iterate every sample AND be what is returned). K5 revert-proven — K4 uses mirrored logic so
it does not catch a wiring revert, which is why both exist.

**ALSO SHIPPED THIS ROUND** (all owner-approved, all with revert-proven pins):
- **No burned-in CTA on Meta surfaces** (`a2e8e79`). Meta draws its own button; ours duplicated it
  and was the element most prone to contrast collisions. `landscape` (pmax/YouTube) keeps its CTA.
  `verifyTitleSpecResolution`'s G4/G6/H1 correctly FAILED this and were updated to pin the new
  contract both ways rather than deleted.
- **Pill ink from the fill** — `ctaText` defaulted to white regardless of the fill, so a
  cream-accent brand shipped white-on-cream. Adversarial review then broke my first fix with
  arithmetic: a `lum > 0.55` threshold picks WHITE on mid-tones (#5B8C5A → 1.93:1 when dark gives
  9.3:1). Now computes the WCAG ratio both ways and takes the winner.
- **Font plumbing guard** — `var(--font-sans)` and anything containing a parenthesis is no longer
  treated as a typeface. My own harness caught that `"var(--brand-font, serif)"` comma-splits to
  `serif)`, which is NOT in the generic list and would have returned a font named `serif)`.
- **The brand's own face wins when we hold the file.** Data settled this: of 34 brands ZERO set
  `headingFontFamily` (that tier was always dead) and FOUR set `sansFontFamily`, all four
  disagreeing with their scraped face (AllBirds theme "DM Sans" vs real "Self Modern"). Naively
  enabling the alias would have replaced real typefaces with generic Google ones. The scraped
  family now outranks the theme ONLY when `matchCustomFont` finds a USABLE ingested file, so
  licence holds still apply. Verified: AllBirds → Self Modern, licence-held → DM Sans, Pelagic
  (no file) → Montserrat.
- **Product-tier counts name the product** (capped 28 chars, word-safe) and the render log now
  reports `quoteTier` and flags the cross-tier case.
- **Seed guard** skips a first catalog image whose `primarySubjectAreaFraction` > 0.6, preserving
  feed order. Two of my own bugs fixed after review: `limit(24)` was a silent wrong-seed generator,
  and a missing `fileType` filter could land on a catalog VIDEO and switch Omni's seed track.

**PROCESS TRAPS HIT THIS ROUND, all worth remembering:**
- A regex JSON edit inserted a DUPLICATE `"visible"` key (non-greedy terminator stopped inside the
  nested `position` object). JSON keeps the last occurrence, so files still parsed as `true` while
  the script reported success. **Verify by parsing, never by trusting the edit log.** The presets
  round-trip exactly at `indent=2`, so structural edits are clean.
- `render-ssh` rate-limits hard; an `until` loop with no sleep hammers it into refusing everything.
  Back off, then make ONE call. `/tmp` on the worker is wiped by every pod rotation, and a deploy
  rotates the pod — so a detached driver launched right after a deploy dies with it. Monitor via
  the DB, not the log file.
- The driver's stdout goes to its own file, NOT the Render log stream — `render logs` will never
  show `keepOut:` lines from a `retitleDriver` run.

**AWAITING OWNER:** roll the placement fix across the library (a $0 re-title sweep, 382 ads, dry
run green) or leave it applying to new renders only.

### 0.3003 SEED = FEED ORDER, and the legibility fix was a POLARITY bug (prod `caec844`)

**VIDEO SEED — the 'hero' stamp is gone.** Owner: *"the default video behaviour should be the
first three images, not the 'hero' image, especially since we don't know how that is determined."*
Removed the `metadata.imageRole:'hero'` tier from `expandDeterministicVideo` — BOTH the default
seed and the non-catalog-picks product anchor — via one helper,
`firstCatalogMediaForProduct()`. The stamp was never a dependable "first image": it is written by
`catalogProductDetectService` off `CatalogProduct.imageUrl`, so it required that materialisation to
have run, and when absent the cascade fell through to earliest-`createdAt` anyway — the SAME
product could seed differently depending on ingest state. Now one rule: earliest `createdAt`.
**No change was needed for "the first three"**: `atlasVideoService` already loads `catalogMedias`
with `.sort({createdAt: 1})` and no hero ranking, and `DEFAULT_REFERENCE_IMAGE_COUNT = 3` with
`REPEAT_PRIMARY_REFERENCE=false`, so seed + mirrors ARE the first three in feed order.
Money unchanged — one Omni submit per product. Kill switch `VIDEO_SEED_FEED_ORDER` (default on)
restores the old cascade without a deploy. Pinned by `verifyProofBeat` V1.

**ANSWERING THE OWNER'S QUESTION — automatic, not a prompt.** Seed selection is fully automatic
and there is no operator prompt today. The override that exists is operator picks
(`referenceMediaIds` → `orderedReferenceMedia`, position 0 = primary seed), which bypasses the
default assembly entirely. Nothing warns an operator when the automatic pick is poor for video.

**LEGIBILITY WAS A POLARITY BUG, not a missing shadow.** Every entry in `TEXT_SHADOWS` is BLACK,
which silently assumed white type on dark footage. The plate-intel contrast flip makes the ink
DARK on light plates, so a black shadow behind dark type separated *nothing* — which is exactly
why the Vuori title vanished into a face while `inkVote` was behaving correctly. Added
`TEXT_SHADOWS_ON_LIGHT` + `textShadowFor(name, inkHex)`: polarity follows the ink's luminance
(dark ink → light halo, light ink → the original dark shadow, unparseable → previous behaviour).
Wired through EVERY `textShadow` site, including the rating row and reviews line — the two worst
affected. No boxes, no scrim. Verified in frame: headline, `4.6/5` and `15,545 reviews` all legible
over the beard where the headline had been invisible. Pinned by S2-1/S2-2 (S2-2 bans any
`textShadow: TEXT_SHADOWS[...]` so a new slot cannot reintroduce the dark-only assumption).

**TWO THINGS MEASURED AND DELIBERATELY NOT BUILT:**
1. **The camera-prompt constraint the owner asked for.** Not implemented — it could not have fixed
   the observed ads (§0.3002 numbers), and camera directives are the one lever already rolled back
   for causing hallucinations (`be5b83f`). Raised with the owner rather than shipped.
2. **An automatic "prefer a wider seed" picker.** There is NO signal for it.
   `OverlayZoneArtifact.zones.restrictions` looked perfect — it has a `'face'` classification with
   `rectPct` geometry and "any visible face gets ≥0.9" — and 95% of catalog media have the artifact
   (3446/3624). But **0 of 120 sampled carry a `face` restriction at all**, so face coverage is not
   derivable from existing data. `classification.shotType` cannot substitute: it has no
   shot-distance axis, so "on_model full body" and "on_model face close-up" are the same value and
   both rank 1–2. Getting this signal needs either a new field on the existing detect call (free,
   but that is INGEST — a colleague's area, owner-scoped-out) or a vision call per candidate seed
   (~$0.02, cached) at generation time.

**HARNESS LESSON, worth repeating:** V1's first version PASSED with the regression restored — it
scanned only from `expandDeterministicVideo` onward and could not see the helper declared above it.
Caught solely by revert-proofing. Source-anchored checks must assert on the structure that actually
decides the behaviour, not on a region that merely contains its call site.

### 0.3002 TEXT-ON-FACE — the camera prompt is NOT the cause. Measured.

Owner picked "constrain the camera prompt" for the close-up legibility problem, but the numbers
say that would not have fixed it, so it was NOT implemented pending a decision.

Measured on the Vuori square ad (`6a710c82…`): `basePlate` = source **1080x1920**, crop rect
`{cx:0, cy:67, cw:1080, ch:1080, anchorY:'face-safe'}`, face envelope `top 0.035 → bottom 0.558`.
That is a face **1,004px tall — 52% of the master's height**. A 1080px square crop therefore
**cannot** contain that face and still leave a clear title band; there is no cy that works. And
`anchorY:'face-safe'` exists to keep the face IN frame, which is the opposite of what titling
wants. Same shape on GymShark (`cy:39`, envelope to 0.35 — less extreme, still tight).
So the chain is: the MASTER is a tight portrait → the square/4:5 face-anchored crop preserves the
face → titles have nowhere clear to go. A zoom cap in `buildVeoPrompt` changes the last ~10% and
cannot undo a seed that is already a portrait.
**Also relevant, and a reason for caution:** `be5b83f` rolled back ALL of PR#61's camera-prompt
changes because the owner found they *"creat[ed] additional hallucinations and the previous output
was better."* Adding camera directives is the one lever with a proven history of backfiring here.
Real levers, in order of effect: (a) VIDEO SEED framing — prefer a wider on-model/full-product
shot over a tight portrait for ads that will be cropped square; (b) legibility treatment (soft
shadow, no box) which works on EXISTING masters at $0; (c) crop bias for less-extreme masters;
(d) camera zoom cap — marginal, and needs its own live A/B given (be5b83f).

### 0.3000 VALIDATED IN PIXELS — the proof beat works end to end (2026-08-03 19:04)

Live Chrome test on staging found a BLOCKER that no harness could, then confirmed the whole
chain in a real frame. Prod = `56569a2` both services. Suite **40/40**, `verifyProofBeat` **28**.

**THE BLOCKER: `ctx.brand` was null for GymShark, so the brand-tier fallback could never fire.**
`loadContext` resolves the brand by NAME, and the name on a Media/CatalogProduct is scraped page
text. GymShark's catalog media carries `metadata.brand = "Gymshark | Be a visionary."` — name plus
site tagline — which `normalizeBrandName` turns into `"gymshark be a visionary"`, and that can
never match the real doc's `"gymshark"`. `findBrandByName` returned null, so EVERY brand-sourced
field silently vanished: `brandReviews` (empty brand quote pool → the new fallback was
structurally unable to fire), `styleTheme`, logo, tagline. `media.brandId` pointed at the correct
Brand doc the whole time (`6a6a4d58…` → "GymShark", 6 quotes, 3.3/41000).
Fix (`f2f26bf`): use the FK **only when the name lookup already returned null**, so every
resolution that works today is byte-identical, and log when it rescues one. Pinned by B1/B2 in
`verifyProofBeat` (B2 fails if the normalizer ever learns to strip taglines, i.e. if the FK stops
being what rescues this brand). **Deliberately did NOT touch the scraped name — that is ingestion,
owned by a colleague** (owner instruction, same session: *"don't make any changes to ingestion …
let's focus on the selection, curation, and integration into the ads"*).

**The full live chain, GymShark ad `6a70cf95…` (square), $0 re-title over the paid master:**
```
🔗 brand name lookup failed for "Gymshark | Be a visionary." — resolved via brandId FK to "GymShark"
🔓 6 brand-tier quote(s) demoted to last-resort on a product ad
🔓 brand-tier quote WON as last-resort fallback on product ad
📐 quote pool product=3 category=0 brand=6 comment=0 → winner=brand "clothes look and feel great…"
ratingPair: source=brand-count rating=none count=41000
🎨 brandScript: engine=remotion format=square spec=canonical
```
Note `product=3` yet brand won: all three product quotes failed `pickStrongestQuote`'s score
floor, so the last-resort ladder behaved exactly as designed.

**THE FRAME** (Cloudinary still, `so_4.6` post-settle, 1080x1080):
badge "TOP RATED COMFORT" · headline "Gymshark Campus Crest Sweatshirt" ·
**"41,000 reviews · GymShark"** · *"clothes look and feel great and reasonably priced"* ·
"Best Seller" · SHOP NOW. Type sits below the chin (face keep-out fired), dark ink on the light
plate (inkVote on-light).
- **NO STARS** — 3.3 suppressed per the owner rule, while the volume still lands. Report 3 fixed.
- **The quote prints with NO byline** — anonymous llm-web text, provenance gate holding. Report 2
  fixed.
- **"41,000" is COMMA-FORMATTED** — direct proof the `parseReviewsLeadingNumber` fix works. Before
  it, this exact string rolled 0→410 with a stray "00" beside it.
Still: `…/video/upload/so_4.6/v1785783858/liquidretail/brand_script/product-1785783857757-1-8zltbuf2.jpg`

**Also confirmed live on the OTHER path** (AllBirds `6a7017ee…`, via the UI's "Re-render title"
button — a $0 titling-only action worth knowing about, no Omni submit):
`📐 buildMetaForAd: layoutInput STALE (schemaVersion=4.0 want=4.1) — serving non-quote fields;
quote withheld by the provenance gate` + `ratingPair: source=none`. That is the stale-artifact
correction working as intended: non-quote fields still served, only the unstamped quote withheld.
A pre-4.1 artifact legitimately shows no proof beat until it is re-derived.

### 0.29999 SHIPPED — live on prod, both services (2026-08-03 18:39)

**The concurrent session committed MY work along with theirs**: `0319c68` ("Parallel generations
+ wizard reference prewarm; land session's titling work") → merged `9fda078`. Both Render
services report `Live 9fda078e…`, finished 18:39. Every fix verified present in HEAD after their
merge (nothing mangled), and the **full suite is 40/40 on the merged tree**.
So the shared-tree problem resolved itself — no cherry-picking was needed.

**NOT YET EXERCISED IN PROD.** Checked the logs after deploy: zero `ratingPair:` lines, and the
newest `quote scope` lines still carry the OLD "withheld" wording from 16:46. Nothing has
rendered since 18:38. Confidence rests on 40/40 harnesses + the 26-check proof-beat harness +
the 9-shape execution trace — not on a live frame yet.
**It will engage on its own with the team's next video generation**: the generation path now
refreshes a stale artifact automatically (`refreshStaleLayoutInput`), so a fresh 4.1 artifact
with the brand-tier quote is built before titling. No manual step needed for NEW videos.
Watch for `ratingPair: source=brand-count` and `🔓 quote scope — brand-tier quote WON`.

**BACKFILL: STOOD DOWN, and it was the right call twice over.**
1. Owner 2026-08-03: *"don't make any changes to ingestion my colleague is working on that,
   let's focus on the selection, curation, and integration into the ads."* The backfill drives
   `brandEnrichmentService` = ingestion. Out of scope now.
2. The dry run proved it would be **waste anyway**: all 17 candidate brands already carry
   `brand-reviews` in `enrichmentSources`, so `wantBrandReviews` is false for every one — it
   would fetch **zero** brand ratings while still firing billable `gpt`/`scraped`/`brandfetch`/
   logo/font tiers, on a list that is mostly junk (`Apple`, `Test`, `Test 2`, `Egami`, two
   duplicate `Hot Crispy Oil` docs). Re-fetching brand reviews would require clearing
   `brand-reviews` from `enrichmentSources` — deliberately NOT done unilaterally.
   `scripts/backfillBrandReviews.js` is committed and dry-run-safe for whenever it IS wanted.

**CORRECTION — AllBirds DOES have brand review data.** Earlier in this session I reported "AllBirds
has no brand rating at all" and it is in the plan file that way. Queried fresh post-deploy:
**AllBirds `3.8 / 2,667 reviews / 6 quotes`** (`enrichmentSources`: brandfetch, tailwind, scraped,
gpt, brand-reviews) and **GymShark `3.3 / 41,000 / 6 quotes`**. Both FAIL the >4.5 star gate and
both have a real count plus brand quotes — so both are now ideal live cases for the count-only
proof beat, and neither needs any enrichment. My earlier "no data" read was wrong; this is the
record.

**Remaining (optional) validation:** $0 re-title of AllBirds `6a70c584f33c6cfd76d43e54` or
GymShark `6a70cf95f33c6cfd76d46b6b` (both hold paid masters) to see the beat without waiting for a
generation. Requires a `buildLayoutInput({…, refresh:true})` first, because `primary_quote` is
baked in at ASSEMBLY time and both artifacts predate the brand-tier fallback. Reuse the existing
artifact's own `template`/`aspectRatio` for the refresh so the right cache entry is overwritten.
**Blocked purely on ops:** `render-ssh` rate-limits after ~10 rapid sessions and was exhausted by
script staging. `resolveTitleTemplate` is NOT exported from atlasVideoService — read the template
off the artifact doc instead. And a driver in `/tmp` cannot resolve app modules by relative path:
require via absolute `/opt/render/project/src/...` (`process.chdir` does NOT fix module
resolution — that trap cost two runs).

### 0.3 Landed this session (branch `fix/remotion-font-fatal-load`, NOT committed)

| change | files |
|---|---|
| FontLoader loads via raw `FontFace`; a font failure warns and continues, never `cancelRender` | `remotion/components/FontLoader.jsx` |
| Dual asset routes `/fonts` (google+custom) + `/libfonts` (library-match) via `fontRouteForLocalPath()`; traversal guard applied to every base | `services/remotionRenderService.js` |
| CORS headers on 404/416/500 so a miss is a clean error | `services/remotionRenderService.js` |
| Owner rule "we only use stars over 4.5" → `RATING_STAR_MIN = 4.5`, strict `>` | `services/directImageRenderService.js:357-359,414-423` |
| New harness, revert-proven | `scripts/verifyFontServing.js` |
| P3 fixtures updated for the 4.5 floor (deliberate contract change, documented) | `scripts/verifyQuoteProvenance.js` |

**Verify suite is now 30 scripts, 30/30 green** (`verifyQuoteProvenance` 161 checks,
`verifyFontServing` 23).

**Two adversarial passes were run on this diff and BOTH independently found the same HIGH bug**
— proof the two-pass rule earns its cost. Fixed before any commit:
- **The star gate tested the RAW value but the ad displayed the ROUNDED one.** `4.51/4.54/4.55`
  passed `> 4.5` and then printed **`"4.5"`** — the exact string the owner rule forbids, and it
  also kept `social_proof_led` eligible. Now ONE shared helper `services/ratingDisplay.js`
  (`formatDisplayRating`) gates on the DISPLAYED value. Verified: 3.2/4.4/4.5/4.51/4.55/87 →
  withheld; 4.6→"4.6", 4.66→"4.7", 5→"5".
- **The rule was static-only; video chrome rendered any `rating > 0`**
  (`remotion/compositions/Canonical.jsx:78`). Prod holds a real catalog rating of **3.2**, so
  that was live exposure, not theory. Now gated at the single meta source
  (`brandScriptExecutor.js:747-748`) using the same shared helper. Both cascade sources
  (`layoutInput.input.social_proof.rating_value`, `catalogProduct.rating`) confirmed to store
  JS numbers in prod, so the strict `typeof === 'number'` check is safe.
- **`FontLoader` created its delay handle in `useState`,** so an effect re-run loaded fonts
  against an already-continued handle and silently lost the wait. Handle is now created INSIDE
  the effect, with all three exit paths releasing it (settle / batch-catch / cleanup).
  **Reviewed by hand — a leaked handle hangs a render forever.**

**Still open from adversarial pass 1** (tracked, not done): soft-fail font loading converts a
hard crash into a SILENT off-brand ship, so font-resolution failures should be recorded on the
Ad and surfaced in the inspector; `fontRouteForLocalPath` should prefer the existing
`source:'library-match'` field over path matching; and `verifyFontServing`'s T* traversal checks
overclaim (`path.normalize` runs before the head split, so `..` returns null via unknown-head
even with the guard deleted).
The star gate makes `social_proof_led` ineligible below 4.5; the existing
`FALLBACK_ORDER` (`staticAdIntents.js:347`) handles it — `product_first_lifestyle` is always
eligible. `badges:['top rated']` deliberately left at `>= 4.5`: different concept, and
`buildIntentData` does not pass `proof_badges` to intent text anyway.

### 0.29997 COST LEDGER — the grounded-search path was invisible (2026-08-03)

`geminiSearchProvider.lookupBrandReviews` / `lookupProductReviews` hit the RAW
`generativelanguage` REST endpoint with axios, so they bypassed `atlasLlmService` and
ledgered **nothing** — while the sibling GPT-4.1 tier in the same `brandEnrichmentService`
appeared on every spend report. Each function is **two** billable POSTs (grounded
`google_search` pass, then a JSON-structuring pass), on every brand/product enrichment run.
Now ledgered via a single `trackedGenerate()` helper → `costTracker.trackLlmCall`,
`stage:'brand_reviews'|'product_reviews'`, `purposeTag:'grounded_search'|'json_structure'`,
with brandId/productId threaded from all four call sites.

**Three things a plain wrap would have gotten wrong — all verified live, not assumed:**

- **Grounding is billed PER REQUEST, not per token, and it dominates.** $35/1,000 grounded
  prompts = $0.035, against ~$0.004 of tokens. Token-only math understates this path **~10x**.
  New `costTracker.GROUNDED_SEARCH_COST_PER_REQUEST_USD` + `CostLog.groundedRequests`.
  **Per-PROMPT billing is a 2.5-era rule** — Google bills Gemini 3 per executed *query*, so a
  model bump changes the unit.
- **`MODEL_RATES['gemini-2.5-flash']` was wrong: 0.10/0.40 are Flash-LITE numbers.** Live is
  **0.30/2.50/0.03**. Every direct-flash row understated input 3x, output 6x. The Atlas sibling
  `google/gemini-2.5-flash` already carried the right values, which is what gave it away.
  ⚠️ **Expect a step change in flash spend reports — it is the fix, not a regression.**
- **`extractUsage` counted `candidatesTokenCount` only.** Gemini reports `thoughtsTokenCount`
  separately but bills it at the OUTPUT rate, and 2.5 thinks by default (pass 1 sets no
  thinkingBudget). `toolUsePromptTokenCount` also added — ~1% of a row, and Google does *not*
  explicitly document it as billable, so the comment says so honestly.

`scripts/verifyGeminiSearchCost.js` — 20 checks, offline (axios + `CostLog.create` stubbed),
**revert-proven against 6 separate mutations**. Suite now **39/39 green**.

**Adversarial pass (Grok, high effort) — two findings accepted, both now pinned in code:**
its `toolUsePromptTokenCount` challenge was fair (unproven → comment made honest), and the
error path ledgers **$0 even for a grounded call that may have been billed**. That is
*pre-existing* `trackLlmCall` behaviour for every consumer; fixing it means distinguishing
"never left the box" from "server answered / we timed out" — shared error semantics, out of
scope. **Deliberately pinned in harness check C7 so it stays a decision, not an accident.**

**Two policy calls left to the owner** (both one-liners): the free **1,500 grounded
prompts/day** allowance means $0.035 *overstates* until it is exhausted —
`GEMINI_GROUNDING_COST_USD=0` ledgers the free tier honestly; and
**`MODEL_RATES['gemini-2.5-pro']` output is ALSO stale** (5.00 vs live 10.00, caching 0.31 vs
0.125), understating `layoutInputService` 2x — left untouched on purpose, flagged in-code.

**Still unledgered, same class:** `geminiSearchProvider.match` (every detect run!),
`.lookupBrandCategoryUrl`, `categoryReviewsService`, `productDetailsService` — all POST the
same raw endpoint with no tracking and no `maxRedirects:0`.

⚠️ **These edits sit in the `fix/remotion-font-fatal-load` working tree**, on top of that
branch's own uncommitted work. Nothing was committed. Six files + one new script; the cost
change is separable from the font fix if you want it on its own branch.

---

## 0.1 THROUGHPUT WORK — 2026-08-03 PM (uncommitted, suite 40/40 green)

Owner question that started it: *"why are these generation runs taking so long?"* — asked
while looking at the **activity log**, not at wall-clock. Two distinct answers came out of
it, and both are now addressed in the working tree.

### Where the time actually goes (MEASURED, run `…b9f4a5d1`, 1 video + 3 statics, 1:1)

Cost-ledger + `renderStage` waterfall, 12m38s end to end, run finished `succeeded=4`:

| window | stage |
|---|---|
| 0:00–1:42 | copy LLM calls, ad expansion (ads created 1:42) |
| 1:42–3:48 | quote grounding + layoutInput derivation |
| **3:48–9:07** | **reference reframe — 5m19s, 42% of the run.** 3 outpaints submitted in parallel by our code but the ledger shows them completing ~2m15s APART — the `-developer` tier serializes per account |
| 9:07–11:52 | Omni $1 master, 2m45s (normal, irreducible) |
| 11:52–12:38 | download, face-safe crop, Remotion titling, upload — **46s total** |

Statics all finished by minute 5, fully overlapped. Earlier same-day runs measured 293s /
304s per video and 88–133s per static — those were **cache-warm** on reframes. Cold vs warm
reframe IS the 5-vs-13-minute spread; nothing was ever stuck.

Prod reframe-method distribution (226 Media, 242 entries): 9:16 → **137 outpaint / 70
product-only pad / 1 exact**; 1:1 → 8/1/2; 3:4 → 9/14/0. So ~66% of 9:16 refs go generative.

### Owner constraints stated during this work — do not violate

- **"I don't want to change the cropping logic for video, its working well now."** The
  reframe ladder and every crop path are UNTOUCHED. Do not "optimise" them.
- **"No generative unless a video is requested — I don't want to run the entire catalog
  through it."** Prewarm-at-catalog-ingest was proposed, then **KILLED**. Generative work
  stays scoped to products someone is actively making a video from.
- Only the generative outpaint rung is billable / developer-tier; exact-fit and
  product-only-pad are Cloudinary URL rewrites, $0, milliseconds.

### (a) Wizard-triggered reference prewarm — NEW

Starts the SAME reframes when the operator begins configuring a video, so the paid run
finds a warm cache. `services/videoRefPrewarmService.js` (reuses `buildReferenceImages`,
so all cache/claim/billing guards apply unchanged), `POST /api/ads/video-ref-prewarm`
(`routes/ads.js`, above `/:id`, 202-then-background, `requireAuth`),
frontend `Step2Picker.tsx` 1.5s-debounced fire-and-forget.
`scripts/verifyVideoRefPrewarm.js` — 39 checks, 3 revert-proven.

Verified by hand, not assumed: every Meta video aspect resolves to 9:16 via
`omniFamilyNativeFor`, so the prewarm warms the SAME cache key the run reads; and the only
billable path reachable from the service is the reframe ladder (`categoryChainService` is
DB-only, `resolveModelAndAspect`/`resolveReferenceImageCount` are pure).

Adversarial pass found and we fixed: **unbounded spend** (authenticated but unthrottled;
~$2.88/request, no rate limit → `VIDEO_REF_PREWARM_BRAND_HOURLY_CAP=24` rolling per-brand
ceiling, claimed immediately before the billable call so DB reads never consume it) and a
**dead-holder stall** (a Generate racing a prewarm killed mid-deploy burned ~6 min then
cropped anyway → `waitForReframeUrl` now exits early when the claim entry is gone or its
lease aged out). Also clamped `REFRAME_CLAIM_WAIT_ATTEMPTS` so its sleep span can never
outlive `REFRAME_CLAIM_TTL_MS` (past the lease a third process may steal and bill).

KNOWN LIMITS (documented in the service header, not bugs): warms the feed-order-hero stack
only, so a run with explicit operator `seedPicks` may still cold-reframe its lifestyle
primary; no-op for products with only `CatalogProduct.imageUrl` and no catalog Media
(materialising means billable detect vision).

### (b) Concurrent generations — the activity-log complaint

Owner: *"the system is preventing me from starting a new generation when any ad from the
campaign is currently being generated"* → *"i want to make things as parallel as possible."*
The gate was ONE run per campaign for any `preparing|running` row younger than
`REAP_STALE_MIN`. Now product-set aware — see CLAUDE.md §2 for the load-bearing rules
(`services/generationGate.js`, `scripts/verifyGenerationGate.js` 65 checks, 4
revert-proven). Disjoint product sets run in parallel; overlap still blocks; `/runs` now
declares its scope from the ads it claimed so a drain no longer blocks Generates.

**Premise worth keeping straight:** the atomic `status:'queued'` claim does NOT protect
against a double-click — each run mints its own ads under a run-scoped digest, so there is
no row to race for. The gate is the only protection, which is why mint-then-verify was
added for the read-then-write window.

**Not yet raised: `VEO_CONCURRENCY` (4) / `RENDER_CONCURRENCY` (8).** Concurrent runs now
multiply in-flight submits on their own (pools are per-process, `pacedModelSubmit` spacing
is per-process and in-memory). `services/concurrency.js` says re-measure before going
higher; do that with real 429 observation rather than raising blind.

Adversarial pass on the gate raised 11 findings. Fixed in-tree: **ObjectId-shape validation**
(a client posting `[{id:P}]` stamped `'[object Object]'`, read as disjoint from a real `[P]`
→ both expand and bill; `normalizeProductIdList` is now all-or-nothing, an unreadable entry
voids the list so it fails closed), **the wedged-`preparing` money path** (a run past the
stale window stops holding its products; it now re-reads its own status and aborts before
`expandWizardJob`, so waking up late costs nothing), **zombie loser** (the superseded run's
status write no longer swallows errors — on failure the row is deleted rather than left
locking its own products), **`/runs` scope**, and a **compound index** for the gate query
(it runs twice per generation). Deferred with reasoning as tasks #17 (global in-flight caps
— the real cost of parallel runs), #18 (reap stale `preparing`), #19 (legacy
`seedsFromMedia` can mint ads outside the stamped scope).

Explicitly NOT a double-bill, verified: a rejected/429'd submit is not charged, and
`/runs`'s atomic claim still means one owner per ad row.

### Live verification on prod `9fda078` (Chrome, 2026-08-03 ~18:50)

Both features tested against the deployed build; total Atlas spend for the whole
verification was **$0**.

- **Prewarm, end-to-end through the UI:** one click on a COLD product tile (Men's Runner
  NZ Remix, 5 medias, 0 warm) → one `POST /api/ads/video-ref-prewarm → 202` from the
  Step2Picker effect → the 3 stack medias (hero + 2 alts) came back cached
  `pad-product-only` with URLs. All product_only shots, so $0 — no CostLog rows. An
  already-warm product correctly did nothing.
- **Gate, both directions, $0.** Staged a synthetic `preparing` CampaignRun scoped to one
  product rather than paying for a real run. Same product → **409** `reason:
  product-overlap`, naming the conflicting run and the overlapping id. Disjoint product →
  **202, run minted while the other was in flight** — the exact thing the team was blocked
  on. The allowed run stamped `requestedProductIds` correctly and ended
  `done total=0` ("no usable imagery") with **0 ads and 0 cost rows**, because the disjoint
  id was deliberately a valid-but-nonexistent ObjectId. Synthetic row deleted after.

**UNEXPLAINED, benign, worth knowing:** an earlier wizard-triggered prewarm (18:44, during
the deploy rollout) returned 202 but never warmed its cold product, while a direct call to
the same service on the same instance warmed it in 2.7s. Most likely the fire-and-forget
background work died with an instance being replaced mid-rollout — unconfirmed, since we
have no log access from here. Self-healing either way: an unwarmed product just reframes
on demand during the run, exactly as before the feature existed.

**Diagnostic note for next session:** running app scripts over `render-ssh` on the WORKER
gives a shell WITHOUT `ATLAS_API_KEY`, so `atlasVideoService.enabled()` is false and the
reframe ladder silently returns deterministic crops with no persist — a direct-call test
there looks like "warmed N refs" while caching nothing. Source the running process env
first: `set -a && . <(tr "\0" "\n" < /proc/1/environ | grep -E "^(ATLAS_API_KEY|MONGODB_URI|CLOUDINARY|VIDEO_PROVIDER|REFRAME)") && set +a`.
Beware: bash job-control can echo a sourced `MONGODB_URI` in a "Done" line — it did here,
so that credential is in the 2026-08-03 transcript and is worth rotating.

---

### 0.31 STATIC IMAGE GEOMETRY — two defects, both fixed, suite 42/42 (2026-08-03)

Owner report: *"images are getting cropped after generation … truncated CTAs and
cropped words."* Correct, and it was **two independent defects**. The owner's other
question — does the path fire a separate `gpt-image-2` call per size — is **yes**,
that part was always working (`META_STATIC_FANOUT` = 3 billable submits).

**Defect A — the edge margin was discarded on every cropped surface.**
`computeSurface` did `Math.max(cropBand, marginPx)`, treating the post-generation
crop band and our 6% margin as ALTERNATIVES rather than additive. marginPx was
61.44px and the crop band was always larger (128px on 4:5, 80px on 9:16), so the
margin collapsed to **zero** and the safe box handed to the model *was* the crop
line. The live path emitted, verbatim: *"The top and bottom 128px of what you
generate WILL BE CUT AWAY and never seen. EVERY element … must sit inside the box
from 6% to 94% of width and 8.3% to 91.7% of height"* — and 8.3% of 1536 is
127.5px.
**The proof needs no billable call and no model compliance:** the logomark is
composited by *us* from that same box. Measured pre-fix, delivered insets were
`4:5 top/bottom = -1/-1` and `Stories left/right = 0/0`, so the brand's logomark
shipped **flush to the delivered frame edge, 0px gap, for any logo size**. Same
defect class the `logoPlacementFor` docstring already claims to have fixed,
reached by different arithmetic. Inspectable in every 4:5 / Stories ad delivered
before today.
A coupled twin, also fixed: `pct()`'s `toFixed(1)` rounded half-up, and since
`right = 100 - left` the pair always rounded the *same* way, outward into the
destroyed band. Correct guard is **ceil low edge, floor high edge** (an earlier
draft of this note had it backwards).

**Defect B — the size table was stale.** `GEN_SIZES` held three sizes under the
comment *"The only sizes the edit endpoint accepts. Verified live, not assumed."*
False for this model: the live schema enum has **14**. Added `1152x2048` (enum
member, exactly 9:16) and `1088x1360` (exactly 4:5). **All four live static
surfaces now generate at their exact delivery aspect — zero crop**, and 9:16 went
from a 1.25× upscale to a 0.9375× downscale, so typeset glyphs got sharper too.
Frozen `pmax_16_9` still crops 80px (its exact-16:9 enum member `2048x1152` was
deliberately NOT added — unrequested cost change on a path nobody generates to).

**`1088x1360` is NOT an enum member — it was PROBED, owner-approved.** One submit,
~$0.01: asked `1088x1360`, returned exactly `1088x1360`, aspect 0.800000,
prediction `65d1931505bc4620bcf0d7efcdd7aff9`. Necessary because the schema's
"arbitrary resolutions divisible by 16" clause is spliced from OpenAI's own docs
and carries an unpublished *"must also satisfy the model's current pixel and edge
limits"*. The risk was never a 400 — it was a **silent coercion to the
`1024x1024` default**, which would hand a square frame to a 4:5 surface and then
centre-crop it. `verifyStaticSafeBox.js` S4 now requires any non-enum size to cite
its probe. **NOTE: this probe was run outside the app, so it is NOT in `CostLog`** —
reconcile ~$0.01 manually.

**COST RATIOS — an earlier in-session claim of mine was WRONG.** I compared only
the `(2e6 + W×H)/4e6` term and dropped `round(base × short/long)`, which moves the
other way. Corrected, asymptotic and base-independent: 9:16 → `1152x2048` is
**~1.03×** (not the "+50%" a pixel count suggests), and exact-4:5 is **~1.11×**,
i.e. *more* expensive, not cheaper as I first said. Absolute dollars are not
derivable — Atlas never publishes `base`. Reported spend does not move: the ledger
books the flat catalog `$0.01`, already noted as ~6× understated on this model.

**THE DIAGNOSTIC THAT MATTERS FOR THE NEXT REPORT.** `meta_feed_1_1` was immune to
both defects — zero crop, full 61px margin, logo gaps 65/65 — and it is the
**default** surface (`directImageRenderService.js:508,516`). So truncated copy on a
**square** ad is *not* this bug class; it is the model disregarding the percentage
box. Split on surface signature before re-opening size work.

**Harness: `scripts/verifyStaticSafeBox.js`, 329 checks, revert-proven SIX ways.**
Worth recording why it needed a second pass: the first version passed 170/170
while Defect A was backed out. The inward rounding *masks* the margin collapse —
with the margin swallowed, `ceil` nudges the box 1px inside the crop line and an
`inset > 0` assertion is satisfied by that 1px. Threshold tests cannot pin this.
S2b therefore recomputes the whole box from first principles and requires a match
within a tenth of a percent; that single block catches the `Math.max` revert, the
margin-basis revert, the half-up rounding revert *and* the missing float-dust
epsilon. `verifyStaticGeometry.js` (49 checks) passed throughout both defects
because its G4 pre-clamps with `Math.max(0, sb.top)` — it launders away exactly
the condition that was broken.

**Also found, not fixed (no owner ask):** `adRegenerateService.js:277` passes
`ad.platformFormat` with **no live-format gate**, so the 45 Ads frozen on
`pmax_16_9` still regenerate through the full path. Defect A's fix is
surface-agnostic and reaches them. And an OCR / text-bbox capability **already
exists** (`adSuitabilityService.js:46,162`, `Media.text[]`) but is aimed at
*ingested source media*, not the rendered ad — which makes the long-discussed
measure-and-reject control much cheaper than §0.2 assumed.

**COMMITTED as `c9942bb`** on branch `fix/catalog-first-seed-and-video-prompt-rollback`,
on top of the concurrent session's `be5b83f`. Suite 42/42 green at both commits.
**NOT pushed, NOT merged to `main`** — deploy is still the owner's call.

Code in `c9942bb`: `services/staticAdIntents.js`, `services/atlasImageService.js`
(stale 3-size comment), `services/directImageRenderService.js` (renderIssue on a
generation-size mismatch), `scripts/verifyStaticSafeBox.js` (new, 334 checks).
**The DOCS for this work are in `be5b83f`, not `c9942bb`** — the concurrent session
committed the shared tree while `docs/PIPELINES.md` §5, `CLAUDE.md` §2 Known-open
and this §0.31 were already edited in it. Nothing was lost, but do not go looking
for the doc changes in the code commit.

Also: this branch now carries BOTH sessions' work. `be5b83f`'s
`verifySeededUniverseHeroDefault.js` was briefly red mid-session (110/111,
`S8 role === 'catalog'`) and is now 119/119 — that was their work in flight, not a
regression from this change.

---

### 0.32 UNAPPLIED-WORK SWEEP + FIVE LANDED FIXES (2026-08-03, later session)

Owner asked what was sitting unapplied, then said ship it. All pushed and on
`origin/main`. Suite 46/46 throughout.

| commit | what |
|---|---|
| `2bab8be` | Post-render vision QC applied from `.drafts/ad-vision-qc/` — **SHIPPING DARK** |
| `6b224f9` | **SECURITY** GEN-1: authenticated-tenant RCE on `preview-script` closed |
| `f52d79a` | `backfillBrandReviews` — stale money warning corrected, real blocker recorded |
| `45155af` | Remotion headless-shell pre-warm at build time; dead browser candidate removed |
| `b38965c` | Video uploads stream from disk; three stale plate-scan claims fixed |
| `9b61b02` | Tier-coherent social proof chokepoint (**not wired yet** — see below) |

**VISION QC IS OFF.** `AD_VISION_QC_ENABLED=false`. Enabling it is a spend decision
(a billable vision call + a possible second image submit). Two corrections to the
draft: the model role is `google/gemini-2.5-pro`, NOT the flash the draft picked
(flash was probed live and BROKE the JSON shape); and the draft's claim that
`judgeDetections` has zero call sites is false — it has two, both on ingested source
media, so the substance holds but its cited evidence did not.

**GEN-1 closed three doors, not one.** `body.script`, the `body.engine:'canvas'`
hatch that short-circuits before `resolveTitlingEngine`, and a `styleScript*`
persisted through the unvalidated PATCH allow-list. The fix originally prescribed in
`ARCHITECTURE_REVIEW` (delete the `bodyScript` branch) was INSUFFICIENT — it left a
two-request exploit. `parsingContext` would not have helped either; the injected
params are parent-realm objects. Nothing live lost a feature: `StyleOverridesCard.tsx`
is commented out of the frontend at both import and usage.

**CHROME: two findings were one bug, and the "cosmetic" one was not cosmetic.** The
`resolveBrowserExecutable` glob looked in `.cache/puppeteer`, which **does not exist
on the box** (f89e30b moved the cache into `node_modules` because Render loses
`.cache/` between build and serve). So it never matched, every fresh instance fell
through to `ensureBrowser()`, and the shell was being downloaded ~92MB deep into a
user-visible render. The pre-warm meant to prevent that ran `npx remotion browser
ensure`, which also could never work — vendored `remotion` has no `bin` and
`@remotion/cli` is not installed. **NOT verified: the build-log effect. Check the next
deploy's log for the pre-warm line and confirm a fresh instance no longer downloads.**

**BACKFILL IS A NO-OP TODAY — do not run it expecting reviews.** All 17 brands missing
a rating already carry `brand-reviews` in `enrichmentSources`, and `GEMINI_API_KEY` IS
present, so `wantBrandReviews` is false for every one. `--apply` would fire the other
pending tiers (gpt, brandfetch, scrape — billable) and write ZERO reviews. 10 of the 17
are test/duplicate records. Owner declined the targeted run: *"we are working on the
reviews data."*

### 0.33 TIER-COHERENT SOCIAL PROOF — policy landed, WIRING IS THE NEXT JOB

Owner rule, verbatim: *"I don't care if the catalog wide review count is used as long
as it is paired with a brand level quote, if it is a product specific quote it should
rely on product specific ratings. As for the brand review path, they should be the same
across both."*

Three violations were found and all three are real:
1. `layoutInputService.js:2382-2393` lets `Brand.brandReviews` enter
   `social_proof.rating_value`/`review_count` via two independent fallbacks, so brand
   numbers reach `resolveAtomicRatingPair` through its PRODUCT slots and come back
   `source:'product'` with no brand attribution.
2. `resolveAtomicRatingPair`'s brand-star fallback never consults quote tier at all —
   so whenever product fails `>4.5` and brand passes, a **product quote prints beside
   brand stars**. More common than the count case.
3. **Static has no brand tier.** `directImageRenderService` reads only
   `proof.rating_value`/`review_count`, never `Brand.brandReviews`, and
   `staticAdIntents` can only print a count INSIDE a rating string. For the ~30 of 34
   brands failing `>4.5`, static ships no stars AND no count while video prints
   "41000 reviews · gymshark.com". Also `social_proof_led.eligible` requires
   `d.rating`, so count-without-stars cannot even enter the static proof intent.

**`resolveCoherentSocialProof()` (`ratingDisplay.js`) is the agreed chokepoint** and is
committed. It returns the tier decision AS DATA; each renderer formats its own strings
(static legitimately differs: in-model typesetting, no animation, a density budget, and
image models mangle long strings — so parity is on POLICY, not presentation).

Owner policy decisions 2026-08-03: `product|comment` → product numbers;
**`category|brand` → brand numbers** (category on the brand side is the owner's call);
product stars at `>4.5` OR (`count > 5000` AND `>4.19`); brand stars `>4.5` only, no
volume exception; stars refused + coherent count → `product-count`/`brand-count`;
either count REQUIRES a coherent quote on frame; no quote → rating-only stars fine.

**ROUNDING — do not "fix" this.** Both gates compare the DISPLAYED one-decimal value,
matching the existing convention. So the `>4.19` floor has an effective RAW cutoff of
**4.15** (4.15 displays "4.2"), and the owner's "4.19 exactly must refuse" case is not
expressible under round-first. It is deliberately NOT asserted; a test written that way
fights the rounding rule, not the policy.

**NOTHING CALLS THE CHOKEPOINT YET.** Wiring = `buildMetaForAd`, `buildIntentData`, the
static intents, and the `layoutInputService` source fix. Deferred only because a
concurrent session had all of those files open. The change is additive — optional
star-floor args default to today's behaviour — so `verifyProofBeat` R1/R2/R3 and
`verifyQuoteProvenance` P3 stay green and need no rewrite. Wiring MUST pass
`renderedQuoteText`; the chokepoint withholds all numbers without it, by design.

Harness `scripts/verifyCoherentSocialProof.js`, 48 checks, revert-proven 8 ways. Two
notes that make it trustworthy rather than decorative: the tier invariant is guarded
TWICE (withhold inputs, then whitelist `pair.source`) and the layers MASK each other,
so neither is behaviourally observable — group G pins both in source with
branch-bounded regions. And G's first version used a fixed byte window that overran
into the brand branch and tripped on its legitimate whitelist.

### 0.34 STILL OPEN from the sweep (verified, not started)

- **#17 global in-flight caps — STILL NECESSARY.** `RENDER_CONCURRENCY`/`VEO_CONCURRENCY`
  are per-process and frozen at module load; `runRenderLoop` builds a fresh pool per
  call. Since the gate now admits disjoint-product concurrent runs, real submit
  concurrency scales with parallel runs, unbounded.
- **#18 reap stale `preparing` — STILL NECESSARY.** `reapOrphans` covers
  `DetectRun.processing`, `Ad.rendering`, `CampaignRun.running`. No `preparing` clause
  anywhere; `backlogWatchdog` only watches `running`.
- **#19 `seedsFromMedia` out-of-scope minting — MOOT.** Verified on BOTH services:
  web has `AI_CONCEPT_DRIVEN=true` set explicitly, worker is unset in the dashboard and
  inherits `defaults.env:18` `=true`. Legacy cartesian is unreachable.
- **Efficiency #1 video cost reconcile** — the only money-ledger item; needs a live
  probe (does the terminal Omni poll already carry `data.price`?) plus a revert-proven
  harness. **#2 `Ad.plateHints` cache** and **#3 regenerate Mongo diet** — both blocked
  only on concurrent edits to `remotionRenderService.js` / `adRegenerateService.js`.
  **#7 Omni polling** — no upstream lever; none of the 5 param shapes has a webhook field.
- **Count-up settles after the slot fades** on short plates, so the last frame shows a
  fabricated total (~40,519 for a 41,000 target at 24fps). Absolute-second constants in
  `ratingMotion.js` ignore `timing.js`'s time-scaling; `verifyRatingMotion` E1 cannot
  see it because it checks the settle budget without comparing it to the scaled
  `exitAtSec`. Video-only.
- `feat/gemini-search-cost-ledger` and the root `.bundle` are **stale duplicates** —
  their content is already on `main` under different hashes. Safe to delete. Judge by
  content, not ancestry: two "orphaned" branches this session turned out to be landed.

### 0.35 MODEL ROUTING — hard rule now in global CLAUDE.md

Owner, twice: *"I don't want four opus models looking through code, that should go to
grok or haiku"* / *"you should be using grok first"*. Two Workflows in this session
omitted `model` on `agent()`, which silently inherits the main-loop model — 732K and
**1.25M Opus tokens** on what was file tracing. Direct `Agent` calls were correctly
Sonnet; the Workflows were the leak.

Rule (now in `~/.claude-work/CLAUDE.md`, binding on every session): **Grok first**,
then Haiku, then Sonnet; Opus only for the orchestrator's correctness gate and
adversarial verification of money/security logic. **`model` is not optional on
`agent()` inside a Workflow.** Grok reads AND writes files headless — `--sandbox
read-only` for audits, `--sandbox workspace` for edits (`workspace-write` is NOT a
valid profile; it refuses to start). `--prompt-file` without `-p`. Grok drafted the
chokepoint here and I caught two real defects in it, so the gate still earns its place.

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

## 5. KNOWN-OPEN, not started

- Video multi-surface fan-out (§00 Phase 3) — intent only.
- `RENDER_AUTH_TOKEN` logs `EXPIRED` at every boot (dead `renderViaSpec` path).
- `npm error could not determine executable to run` during postinstall — non-fatal.
- Dead HTML/canvas paths read `author_name` with no re-gate (`aiCanvasSpecService`,
  `layoutResolverService`, `aiCanvasInputBuilder`) — commented, NOT fixed.
- Reels 204 vs Stories 250 safe zones collapse into one `vertical` entry in
  `remotion/lib/safeZones.js`.

---

## 6. HISTORY

Moved to **`CHANGELOG.md`**. Settled history does not belong in the live handoff — this file
regrew to ~760 lines once by appending a narrative per session, and answering "is this still
true?" then meant reading two weeks of it. Add new entries there, not here.
