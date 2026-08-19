## Next-session prompt

**NEWEST — 2026-08-11: the wizard format picker is MULTI-SELECT. SHIPPED,
MERGED AND DEPLOYED to both services and to staging. Verified live.**

Three owner-reported UI fixes. Backend PR #124 (`b8eab009`, live on web
`srv-d1vuktqli9vc73ft07ng` + worker `srv-d8128c1o3t8c73e8kb30`); frontend
`liquidretail` PR #41 (`1e9e404`, bundle `index-DXIQ6hIA.js` on
staging.reach-social.io). **Backend was merged and confirmed live BEFORE the
frontend** — mandatory ordering, because `resolvePreset` throws on an unknown
preset and the wizard now posts `preset:'explicit'`.

1. **`resolvePreset` gained `explicit`** — resolves exactly the surfaces named in
   `staticFormats[]`/`videoFormats[]`. Static bills PER SURFACE (intended — the
   image model typesets copy into the pixels, so a size is never a crop).
   **Video is clamped PER PLATFORM, not to a global count:** at most ONE Meta
   master, at most the TWO real PMax masters, and NEVER the derive-only
   `pmax_video_1_1`. A global "clamp to one" would UNDER-generate PMax; honouring
   every tick would OVER-bill Meta. `resolveExplicitFormats` owns the rule and is
   exported so the route shares it.
2. **The duplicate gate now hashes the RESOLVED set, not the request body.** This
   was the money-critical finding of an adversarial review. Bodies that resolve
   identically (a video-only key dropped from `staticFormats`, a duplicate tick,
   two tick orders, junk lists on a named preset, `kinds` under a preset that
   ignores it) used to fingerprint DIFFERENTLY, so a real double-click did not
   register and the second click billed a second full set of statics. Static is
   the unprotected half — its `identityDigest` is scoped to `generationRunId`, so
   no unique index catches it. Route normalises through the same
   `resolveExplicitFormats` the expansion uses and zeroes the fields `explicit`
   ignores (verified: `requestedKinds`/`expandStaticFormats` are read nowhere but
   the `resolvePreset` call). **`FINGERPRINT_VERSION` v1 → v2.**
3. **`explicit` resolving to nothing is a 400 `NO_GENERATABLE_FORMAT`** instead of
   a 202 that expands to zero and settles as terminal `done`.

Verified live against staging (free `/preview`, plus a `/generate` that 400s
before minting): multi-select body → **200**; empty selection → **400
NO_GENERATABLE_FORMAT**; ticked `google_demandgen_1_1` → **400
PLATFORM_FORMAT_COMING_SOON**. In the browser: two sizes stay lit together, both
"All static formats (6 sizes)" and "All video formats (3 masters)" light up
simultaneously, "PMax Video Square" shows **Included free** and stays unlit, and
"+ New campaign" opens the Quick Campaign Builder. **Generate was never clicked —
no billable run was made.**

Harnesses: `verifyPresets` **585** (was 470), `verifyGenerationGate` **224** (was
194); suite **85, 0 failing**; 11 revert-proven mutations.

⚠️ **OPEN, and it is a real money bug someone else owns —
`resolvePreset('single','pmax_video_1_1',{kinds:'video'})` returns the
DERIVE-ONLY key as a billable videoFormat.** Confirmed against an UNMODIFIED
`origin/main`, so it came in with PMax Phase A, not with this change. Phase A made
that key **live** and the picker offers every live surface, so selecting "PMax
Video Square" bills a real Omni submit for what is meant to be a free crop of the
9:16. `verifyPresets` pins it as `KNOWN PRE-EXISTING` and excludes `single` from
the new per-platform sweep (search `SINGLE_DERIVE_ONLY_BUG`) — **delete that
exclusion and that check in the same commit that fixes it.** The `explicit` path
never emits it and the frontend never offers it, both asserted. Decide whether a
named derive-only surface should resolve to its platform's master or be refused
like `coming_soon`; the latter is more honest but needs a frontend change.

⚠️ **One product judgement to confirm with the owner:** "All static formats" /
"All video formats" cover **all live surfaces on BOTH platforms**, which is the
literal reading now that PMax is live — so All static is **6** image generations
per concept (3 Meta + 3 PMax), not 3. The badge says `6 sizes` and the spend line
says so before the click, but it may want scoping to Meta.

---

**2026-08-11 post-Phase-B addendum on branch
`feat/pmax-surfaces-phase-a2`.** Phase A (surfaces/money shape) + Phase B
(creative prompts / Yt zones / Director funnel) are documented; this block is
the handoff **after** adversarial review + video cost reconcile. Full write-up:
`docs/PIPELINES.md` §5 *Static PMax prompt overlay* + *Measured PMax unit
costs* + §6 *YouTube safe zones* / *PMax video directives* / *Director funnel*
/ *Phase B adversarial corrections* / *Video cost reconciliation*; money in
`CLAUDE.md` §2; traps (shared funnel presets, `ROUTING_NESTED_FIELDS`, blank
`PMAX_PROOF_*`, precedence sentence, `classifyFormat`) in §4.

### Production status carried forward from `main` (do not lose this)

0aa. **NEWEST — 2026-08-10: the `/generate` gate is now REQUEST-FINGERPRINT keyed, and IG
   re-scan/rebind is unblocked. MERGED AND LIVE IN PRODUCTION — but NOT exercised against a
   real run, which is the top priority below.**
   - Backend PR **#116** (gate + IG) and PR **#115** (the catalog-executor `.select()` fix that
     had `verifyBrandFieldNames` red on `main`) both merged. Live commit **`5d02debe`** on WEB
     `srv-d1vuktqli9vc73ft07ng` and WORKER `srv-d8128c1o3t8c73e8kb30`, both `live`, builds
     finished 05:02Z. Boot logs clean — the only error-shaped lines are two
     `SIGTERM … 0 ad(s) in flight`, i.e. the graceful handoffs as each deploy replaced the last.
   - Frontend PR **#40** merged; Netlify live on `c110d5c`. Verified by asset hash:
     `staging.reach-social.io` serves `index-DBoabGBs.js`, identical to a local build of merged
     `master`.
   - Suite on **merged `main`: 75 harnesses, 0 failing** (the first fully-green state this
     session; `verifyFontFallback` had been red only in a dirty local checkout, and
     `verifyBrandFieldNames` was fixed by #115).
   - ⚠️ **Deployed ≠ verified.** No real campaign has run through the new gate. The three cases
     in item 1 below are still the first thing to do.
   Owner asks, verbatim: *"make sure the user is able to generate an ad from the media library or
   the product image library, don't block ads that are concurrent based on the product alone, but
   based on the actual request. So block identical requests and note requests that are identical to
   previous requests but allow them if the user wants."* and *"also while we are doing this, let's
   allow the user to re-scan and change the instagram ID also"*.

---

### What shipped — offline suite **85/85 green** (merged with main)

**Phase B (unchanged substance):** static `PLATFORM_NOTES` + intent-aware CTA;
`PMAX_DIRECTIVES` (hook-first, centre-safe, aspect-aware Frame); Director
funnel span + social-proof hierarchy + `DIRECTOR_SIGNALS_VERSION` 3.3.0;
YouTube safe zones wired; `verifyPmaxPromptOverlay.js` (314 checks). Meta
byte-identity held. Phase A money shape still true (3 static + 2 masters + 1
free derive 1:1).

**Post-Phase-B addendum (record — do not re-do):**

1. **Video cost reconciliation** (`atlasVideoService.js`) — owner "read settled
   price" rule was **images-only**; every video ledger row stayed the formula
   estimate forever (~33% over-report on developer 10s: $1.20 formula vs
   **$0.90** settled — over-REPORTING, not overspending). Now:
   `pollPrediction` → `{url,price}`; fire-and-forget
   `reconcileVideoCostFromTerminal` (immediate when terminal carries price —
   normal for video); `scheduleVideoCostReconcile` fallback (same backoff as
   images); `parseAtlasSettledPrice` rejects non-positive. Estimate /
   `MODEL_CAPS` deliberately unchanged. **NEW**
   `scripts/verifyVideoCostReconcile.js`. A remaining `costSource:'estimated'`
   video row means price never published, not "trust the formula."

2. **Adversarial corrections to Phase B:**
   - (a) Funnel presets 10s re-time **REVERTED** — they are generic
     (`titleStylePreset` / `retitleDriver`), not PMax-scoped; re-timing dropped
     `specTimeScale` 1.0→0.8 on every brand's 8s renders. Stay at **8s**.
     PMax 10s pacing = separate presets + per-run selection.
   - (b) `PLATFORM_NOTES` no longer puts the *product* inside the safe box
     (contradicted `geometryBlock()` photograph exemption).
   - (c) PMax Scene 1 aspect-aware (was hard-coded horizontal pan on 9:16).
   - (d) `PMAX_PROOF_*` blank env no longer parses as 0.
   - (e) `funnel_stage` registered in `ROUTING_NESTED_FIELDS` + **R0b** pins
     load-bearing names stay registered.
   - (f) 1.91:1 density (`maxTextElements:3`) drops supporting copy before CTA
     on `brand_led` — documented, not changed.

### Measured costs (Phase B live Atlas submits — prompt-only, no DB/Ad rows)

| item | settled price |
|---|---|
| static 1:1 @1024×1024 | **$0.071728** |
| static 1.91:1 @2048×1152 | **$0.061440** |
| static 4:5 @1088×1360 | **$0.066660** |
| video 10s 16:9 @1080p Omni **developer** | **$0.90** |

- 3-size static fan-out ≈ **$0.199**/concept. Two masters = **$1.80**. Full
  kit ≈ **$2.40** standalone / ≈ **$1.50** marginal beside Meta. Do not quote
  $1.20 for developer. Delivered video: 1920×1080, 10.000s, 240 frames.
- Live A/B (unbranded seed, n=1): static overlay ON strips burned CTA + keeps
  copy safe; OFF shows SHOP NOW near top. Video: PMax profile stayed legible
  mid-clip; canonical zoomed to unidentifiable lace close-up. Harness lesson:
  fixtures must pass `rating` as the **string** from `formatDisplayRating()`,
  not an object (`[object Object] ★`).

### What is NOT done

- **Per-run funnel preset SELECTION** — render path accepts `presetOverride`
  (TIER 0) but no live caller supplies one; no Ad/run field carries funnel
  stage; `buildMetaForAd` hardcodes `presetOverride: null` and **must** get
  the same value as the render path or the social-proof quote gate desyncs.
  Only brand-level `titleStylePreset` works today. **If/when building PMax 10s
  pacing, ship separate preset files here — do not re-time the shared 8s ones.**
- **No full end-to-end PMax kit through the app** — only prompt-only live
  submits. No Ad rows, no wizard run, no delivery.
- **No delivery path:** Google Ads upload does not exist (integration is
  read/sync only); PMax video must be YouTube-hosted. v1 is an **export bundle**.
- **Text assets deliberately OUT OF SCOPE** (owner): clients already run PMax
  and their existing headlines/descriptions serve; we supply the visual layer.
  Copy burned INTO the creative stays ours.

### Next actions (in order)

1. **First live app run** — ONE product, brand with populated `summary`,
   `google_all`. Expect 3 statics + 2 masters + 1 derived 1:1. Budget ≈
   **$2.40** (read settled `price` / reconciled CostLog, never catalog
   `base_price` or the video formula). Verify: 1:1 never Omni (`veoModel`
   starts `derive-from:`); both masters titled with **Yt** zones; statics show
   PLATFORM CONTEXT notes + CTA only on conversion intent; video CostLog rows
   flip to `costSource:'actual'` at ~$0.90; no Meta digest re-mint if a Meta
   campaign regenerates on the same deploy.
2. **Per-run funnel preset selection** — stamp funnel stage on Ad (or run),
   pass the **same** `presetOverride` into render *and* `buildMetaForAd`. Pair
   with **separate** 10s PMax presets if 10s pacing is required.
3. Delivery / YouTube host / export-bundle productisation — only after (1)
   looks right creatively.
4. Do **not** "harmonise" shared DR "≥4.5 from ≥50" with PMax hierarchy
   thresholds — that changes Meta. Do **not** re-time shared funnel presets.

### Prior open work (still open — do not lose)

The items below predate Phase B. Detail lives in the history sections of this
file and in `CLAUDE.md`; this is the short index only.

- **`/generate` request-fingerprint gate + IG re-scan** — pushed as
  `feat/generate-gate-fingerprint-ig-rescan`, NOT merged/deployed/exercised.
  Exercise live (media-library while a product run is in flight; double-click
  confirm; double "Generate anyway"). Manual IG sync route has **no** daily
  detect cap — owner decision still open. Read `CLAUDE.md` §2.
- **`ai_brand_led` no-copy fix** — PR #75 / branch `fix/brand-led-static-copy`,
  not merged, never rendered live. Kill switch `STATIC_BRAND_LED_COPY=false`.
- **Remotion font fatal load** — branch `fix/remotion-font-fatal-load`, not
  committed. 30/30 verify green. See history §0.
- **Post-render vision QC** — drafted at `.drafts/ad-vision-qc/` (gitignored).
  Use `google/gemini-2.5-pro`, not the draft's flash pick.
- **Video canonical prompt tuning** (Meta path) — biggest remaining *creative*
  defect; archetype-driven video still deferred. PMax profile is separate and
  must not be back-ported into Meta without an explicit A/B.
- **Manual IG re-scan daily ceiling** — open owner decision (`verifyIgRescanGuards`
  5f asserts the cap's absence).

**Do NOT start by merging PR #32.** That instruction was wrong; see §0.

---

