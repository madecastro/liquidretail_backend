# CLAUDE.md — liquidretail_backend

Express + Mongoose backend for Reach Social's ad-generation product. Deploys to
**Render** (`liquidretail-backend.onrender.com`). The SPA frontend is a separate repo
(`Emami-RS-Project/liquidretail`, trunk `master`) deployed to **Netlify**
(`staging.reach-social.io`). Trunk here is `main`.

**Read `session.md` for live state. Read `ARCHITECTURE_REVIEW.md` before touching
security, money, or the render queue** — it carries verified P0s with `path:line`.

Live prod (2026-08-11) = **`5d02debe`** (both services — WEB
`srv-d1vuktqli9vc73ft07ng`, WORKER `srv-d8128c1o3t8c73e8kb30`). Offline verify
suite = **184 scripts** (174 `.js` + 10 `.mjs`).
**Run it with `npm test`.** That is `node scripts/runVerifySuite.js` — a parallel
aggregate runner that globs `scripts/verify*.{js,mjs}` and takes
`--concurrency=` / `--timeout=` flags.

⚠️ **CORRECTED 2026-08-21. This block previously said "there is
no aggregate runner and no `npm test`" and told you to run
`for f in scripts/verify*.js; do node "$f" || echo "FAIL $f"; done`. Both were
false, and the second is worse than merely stale: that glob is `.js` ONLY, so it
SILENTLY SKIPS ALL TEN `.mjs` HARNESSES** — including
`verifyReelsSafeZone.mjs`, `verifyLandscapeYtSafeZone.mjs`,
`verifyStackSafeFloor.mjs`, `verifyReelsOverflowSafety.mjs`,
`verifyNoDoubleTitledBand.mjs` and `verifyPmaxTitleInk.mjs`, i.e. most of what
pins titling geometry and title ink. Sessions following this instruction have
been reporting "all green" against 174 of 184 for as long as the `.mjs`
harnesses have existed; PR #303's "174/174 pass" is one measured instance.
`runVerifySuite.js`'s own header already called this out — the docs just never
caught up. If you quote a suite count, say which glob produced it.

The `timeout` note that used to live here is also gone: `runVerifySuite.js`
implements its own per-script timeout (`--timeout=`, SIGTERM then SIGKILL), so
macOS lacking a `timeout` binary no longer matters when you use `npm test`.

**Worktree gotcha, still true and it bites the `.mjs` harnesses hardest.** The
committed `node_modules` subset is incomplete. For CJS scripts,
`NODE_PATH=<main checkout>/node_modules` is a workaround (native `sharp` is the
exception — `verifyLogoSilhouette.js` needs a real `npm install` in the
worktree, since Node resolves the local `node_modules` first). **For `.mjs` it
is not a workaround at all: ESM ignores `NODE_PATH`.** Measured 2026-08-21:
`verifyTitleBeatScale.mjs` imports the `remotion` package, fails
`ERR_MODULE_NOT_FOUND` in ANY worktree including a pristine detached
`origin/main`, and passes in the main checkout. So a lone `.mjs` failure in a
worktree is the default expectation, not a regression — confirm it against the
main checkout before believing it. Claims written against pre-deploy binaries
are suspect. **A red harness in a local checkout is not necessarily red
on `main`** — this tree carries other sessions' uncommitted work, so confirm
against a clean worktree off `origin/main` before believing a failure (or a pass).

### The five parallel-work checks — RUN THESE, they already exist

`docs/PARALLEL_WORK.md` §7 shipped tooling for the exact failure modes this
multi-session setup keeps hitting. **It has been on `main` since 2026-08-19 and
was measurably not being used**, because it was documented only in that file and
nothing pointed here. That is the whole reason this section exists.

| command | what it does | the failure it prevents |
|---|---|---|
| `npm test` | parallel aggregate runner over every `verify*.{js,mjs}`; **reports its own count** — do not hardcode one here, the number in this file has been stale three separate times | the `.js`-only shell loop silently skipping 10 `.mjs` harnesses |
| `npm run test:affected` | only harnesses touching changed files | a 3-5 min serial re-run per iteration |
| `npm run setup:worktree` | fixes a fresh worktree's incomplete `node_modules` | up to 93 false `MODULE_NOT_FOUND` "failures" before one real check runs |
| `npm run check:rebase` | verifies a rebase dropped nothing | two rebases silently dropped content with no safety net (the incident that motivated §7) |
| `npm run check:stale-work` | uncommitted work older than 2h | **measured 2026-08-21: 319 lines of feature work sat uncommitted for 13 DAYS** in a frontend worktree, found only by an unrelated sweep |
| `npm run check:orphaned-branches` | commits ahead, never pushed, no PR | 13 such branches existed, incl. two carrying a privilege-escalation fix |

**Prefer `check:orphaned-branches` over a hand-rolled audit.** Measured
2026-08-21: a manual pass produced four false negatives, while this script
correctly separates *never pushed* (at risk of permanent loss) from *pushed but
no PR* (safe on the remote) — a distinction the manual pass got wrong.

**Do not create a git worktree INSIDE this repo's directory.** 22 harnesses do
their own `fs.readdirSync` walk. Measured 2026-08-21: **4 are safe** because they
skip every dot-prefixed directory (`ensurePuppeteerChrome`, `runVerifySuite`,
`verifyConceptContract`, `verifyLlmErrorCodes`) — copy that pattern, not a
literal name list. The other **18 are exposed**: they enumerate a fixed set of
skip names that does not include `.worktrees/`, `.wt-*` or `.drafts/`, so a
nested worktree silently feeds another session's uncommitted code into
assertions here. It already turned
`verifyArchiveDigestRelease` (a MONEY harness) red with 7 false positives, and
the harnesses that *don't* go red are worse: they pass or fail depending on what
someone else has checked out. `.gitignore` does not protect them — these are raw
filesystem walks, not git-aware ones. Put worktrees as siblings of the repo
(`/Volumes/Sayulita/Projects/RS/.wt-<name>`), never under it.

**Read `docs/PARALLEL_WORK.md` before proposing a refactor of `routes/ads.js`,
`worker.js`, `campaignAdsGenerationService.js`, `aiCreativeDirectorService.js`,
or this file.** §1-5 are decomposition plans that are deliberately NOT executed —
six agents were mid-flight on those exact files. That deferral is a live
decision, not an oversight; §7 is the safe slice that shipped instead.

---

## 00. THE CATALOG PRODUCT-AD PIPELINE — owner-stated, 2026-08-02

**This is the whole architecture for catalog-based product ads. There are no
other generation pathways for them. Do not propose, restore, or "fall back to"
one.** Owner, verbatim: *"We are no longer using ANY other generation pathways
for video or static ads … we are not using any other generation pathways for
catalog based product ads."*

**VIDEO (Meta)** — one billable generation (9:16 master) plus **three FREE
derivatives** of it: feed 1:1, feed 4:5, and a Reels 9:16 retitle. Four Meta
video Ads per product, **one** Omni submit. The fan-out was documented as
"Phase 3 intent" from 2026-08-02 until 2026-08-11, when PMax's derive path
(`deriveFromMaster` → `renderDeriveOnlyVideoAd`) made it buildable — it is
platform-agnostic, so this is the original intent finally wired up, not a new
capability.
**VIDEO (Google PMax, Phase A)** — **two** billable Omni masters (9:16 + 16:9)
plus one free derive-only 1:1 crop of the 9:16 master — see §2 and
`docs/PIPELINES.md` §6. Do not apply the Meta one-master rule to `google_video`.
**On a MIXED Meta+PMax run the two 9:16 masters collapse to ONE** (owner
directive 2026-08-18) — see the shared-portrait bullet in §2. PMax standalone
is unchanged at two.

1. Resize the hero image to **9:16** with the **current** resizing system.
2. **Omni** image-to-video → the 9:16 **master**. `google/gemini-omni-flash/
   image-to-video-developer`. ONE billable submit per product on live **Meta**
   presets (`meta_video` / `meta_all` queue `videoFormats: [META_VIDEO_MASTER]`
   only). See §2 — everything named `veo*` is this Omni pipeline under a legacy
   name.
3. **Crop** for non-9:16 targets via `videoCropUrl` + `basePlateCropService`
   (face-anchored) at titling time — never a second Omni submit. **The Meta
   fan-out IS the queue path as of 2026-08-11:** `resolvePreset('meta_video')`
   still returns the master only (that is the BILLABLE list and must not
   change), and `expandWizardJob` then mints `META_VIDEO_DERIVATIVES`
   (`meta_feed_1_1`, `meta_feed_4_5`, `meta_reels_9_16`) each carrying
   `deriveFromMaster: 'meta_stories_9_16'`. ⚠️ **Four video Ads, ONE submit.**
   The old warning still stands in its real form: four ads is correct, four
   *submits* is the money bug. The `deriveFromMaster` field is the entire
   difference — dropping it turns three free crops into three ~$0.90 charges
   per product. Pinned by `scripts/verifyMixedPlatformVideo.js` H3.
4. **Title each surface appropriately** — burned into the delivered file, using
   that surface's own safe zone. ⚠️ **`remotion/lib/safeZones.js` IS THE ONLY
   AUTHORITY FOR TITLING. `platformFormats.safeArea` IS NOT — Remotion never
   reads it. CORRECTED 2026-08-18; this line previously cited "Reels (204) and
   Stories (250)", which are `safeArea` pixels and have nothing to do with
   where a title lands.** The live path is: `brandScriptExecutor` passes the
   row's `platformFormat` **string** → `remotionRenderService` puts it on
   `inputProps` → `Canonical.jsx` calls `resolveSafeZoneKey({format,
   platformFormat})` → `SAFE_ZONES[key]`. Those fractions were hand-measured
   and are **not computed from `safeArea` at runtime**; they have visibly
   drifted from it (Reels `safeArea` is 204/1778 = 11.5%/11.5%, its Remotion
   zone is 14%/35%). **So editing `safeArea` to fix a titling defect changes
   nothing, and editing it to match a zone is busywork** — fix the zone.
   Per-surface keys today: `meta_stories_9_16`→`stories`,
   `meta_reels_9_16`→`reels` (right 0.15 for the IG action rail, added
   2026-08-18 — Reels had been falling through to the shared `vertical` zone
   with no rail reserve), the PMax three→`verticalYt`/`landscapeYt`/`squareYt`.
   Pinned by `scripts/verifyReelsSafeZone.mjs`.
   ⚠️ **The narrower Reels box shipped a real defect the next day, closed
   2026-08-19 (measured on a delivered Vuori `meta_reels_9_16`, run
   run_1787136860887_654ed621): a burned-in customer quote lost its OPENING
   clause on Reels while the identical Stories render kept it whole.** Two
   causes, both fixed: (1) `slotContent.js`'s char-cap width model derived
   `usableWidthPx` from `maxWidthPct × canvasWidth` alone, blind to the
   surface's own safe-zone insets, so it stayed as generous for Reels'
   0.775W box as for Stories' 0.85W one — now bounded by the surface's real
   resolved width whenever it's narrower than the canvas format's shared
   default (inert for `vertical`/`stories`). (2) The bigger contributor:
   `stackContainerStyle`'s `lowerThird`/`bottom` anchors used bare
   `justifyContent:'flex-end'`, which on overflow pushes the WHOLE group
   toward the floor and lets the excess spill PAST THE TOP, where
   `overflow:hidden` clips it — the wrong end for a stack whose first item
   is the quote. Reels kept `bottom:0.35` (tight) while Stories moved to
   `bottom:0.14` (loose) in the very change that added this zone, so a
   keep-out-shifted group that used to just fit stopped fitting, on Reels
   only. Now `safe flex-end` (CSS Box Alignment L3) — falls back to
   start-alignment on overflow, so any content that must drop is dropped
   from the END, never the opening. Both pinned by
   `scripts/verifyReelsSafeZone.mjs` sections G (overflow direction) and H
   (width measure).
   ⚠️ **"Never the opening" was not "never clips through an element" —
   closed the same day.** The rating slot (stars + score + review count)
   still landed on the box/element boundary and got sliced mid-star.
   `remotion/lib/stackFit.js` (new) sizes the whole GROUP to its box before
   paint — shrink (bounded) → drop the reviews line → drop whole trailing
   rows, protecting the hero — so `overflow:hidden` is a backstop, not the
   mechanism. Not Reels-specific: `verticalYt`/`landscapeYt` share the same
   tight-box exposure and go through the identical code path. Pinned by
   `scripts/verifyReelsOverflowSafety.mjs`.
   **What `safeArea` IS for, so nobody deletes it as dead:** it is live on the
   **static image** path — `staticAdIntents.computeSurface` turns it into the
   geometry box in the billable gpt-image-2 prompt and into Sharp logomark
   placement. Material only on `meta_stories_9_16` static (250/250); every
   other live static surface declares 0/0. It also feeds prompt *text* to the
   Director (`aiCreativeDirectorService.buildFormatConstraints`) and the canvas
   HTML generator, and is published as `safeAreaPct` by `GET /api/ads/formats`
   and `platform.listFormats` (display/agent JSON, nothing reads it back).
   **`meta_reels_9_16` is `kinds:['video']` and is not in `META_STATIC_FANOUT`,
   so its 204 has no pixel-affecting consumer at all.** Third encoding, also
   not `safeArea`: `htmlValidationService.safeBandsForFormat` hardcodes 204 for
   Reels on the dead HTML-static validator.
   **Untitled is not success:** after the master lands the
   ad is stamped `status:'draft'` (reaper-safe money guard), then titling runs;
   if Remotion throws, status flips to **`failed`** with
   `master rendered; titling failed`, the run is charged a failure, and the
   **raw master is kept** (`routes/ads.js:1258-1343`). Leaving the ad
   `rendering` mid-titling is a double-bill hole (reaper requeues → second Omni).
5. **Preview** the result inside the matching **Meta surface overlay**
   (preview chrome only — known-open: placeholder "Lorem ipsum" copy).

**Video prompt (owner 2026-08-03):** Live path is the **canonical camera-only
prompt** via `buildVeoPrompt` — not Director concepts. Comment + priority at
`atlasVideoService.js:2593-2620`: on-screen text is **not** in the Omni prompt;
Remotion brand-script titling composites it from `ad.copy` + LayoutInputArtifact.
Generic-looking camera prose is **by design**, not a missing field. Do **not**
plumb `art_direction` / `creative_style` / `archetype` into the camera prompt.
**Levers:** `videoPromptGuidance` (prepend), `videoPromptRaw` (full replace;
logs *"canonical directives bypassed"*), and the canonical directives inside
`buildVeoPrompt`. `buildVeoPrompt` receives **no** Director concept — args are
`{brand, product, media, layoutInput, sourceMedia, aspectRatio, seedHasText,
hasProductReference, storyboard, caps, durationSec, platformFormat}`. Director
is **off for video by default** (`directorVariants` opt-in; wizard "AI DIRECTOR
VARIANTS — Off"). Even when on, Director does **not** drive the camera prompt or
video titling (`docs/PIPELINES.md` §6). `meta_video` / `meta_all` use
`expandDeterministicVideo` — one Ad per product, no concept expansion.
**Current objective: tune the canonical prompt.** Archetype-driven video is
**deferred, not missing.**

⚠️ **SUPERSEDED 2026-08-18, then REVERTED 2026-08-20 — which prompt Meta (and
now PMax) gets.** The block above describes the camera-only architecture
correctly and, as of 2026-08-20, describes the LIVE default again: "the
canonical camera-only prompt" (`gemini-omni` / `OMNI_DIRECTIVES`) is once more
what BOTH Meta and PMax destinations receive by default. Between 2026-08-18
and 2026-08-20, Meta selected the **`hook_first`** profile instead (the same
one PMax used) — that standardization still exists as a fully-tested opt-in
(flip the kill switch back to `true`), it is just no longer the shipped
default. See the standardization note at the end of the PR #61 block below.
The `gemini-omni` text itself is unchanged and still frozen throughout.

**FULL PR #61 camera-prompt ROLLBACK (owner 2026-08-03, commit `be5b83f`):**
Commit `134db56` added three camera-prompt changes in
`services/veoPromptBuilder.js`; **all three are reverted**. Owner, verbatim:
*"This is creating additional hallucinations and the previous output was
better."* The three reverted pieces: (1) Scene 3 "RETURN TO THE PRIMARY VIEW"
+ two PRODUCT FIDELITY sentences claiming the FINAL reference repeats the
primary view; (2) the `subjectContinuity` directive (both `OMNI_DIRECTIVES`
and `GROK_DIRECTIVES`, plus its `lines.push` in `buildVeoPrompt`); (3) the
crossfade-vs-long-dissolve policy rewording. **Mechanical acceptance test:**
the `OMNI_DIRECTIVES` / `GROK_DIRECTIVES` prompt strings are byte-identical to
`git show 134db56~1:services/veoPromptBuilder.js` — **zero prompt-string
hunks.** Pinned by `scripts/verifyPostPilotBatch.js` (B1–B17); **B14** rebuilds
the prompt from the `134db56~1` source out of git and asserts byte-identity on
the destination-less path, **B15** asserts the same for every Meta destination
with the hook-first kill switch **off**. **CRITICAL — the restored text is
deliberately self-contradictory:** `transitions` permits "Smooth crossfades
only, ~0.25s" while `doNot` bare-bans "dissolves", and a crossfade **is** a
short dissolve. Owner-confirmed: that contradictory prompt is the version that
produced better output. **Anyone "fixing" the contradiction is reintroducing
the regression.** Do not soften, split, or reword either string to resolve it.

**OWNER-DIRECTED STANDARDIZATION ON TOP OF THAT ROLLBACK (owner 2026-08-18,
REVERTED BY OWNER 2026-08-20 — read the box below first).**
Verbatim: *"I want to use the PMax prompt for Meta also, and standardize on
that but maintain a single minting for 9x16 across both formats. Continue to
mint a 16x9."* This deliberately broke the byte-identity pin **on the live
Meta path only**. Read the split below before touching anything here — the
whole point of this paragraph is that a future session can tell what was
directed from what would be drift.

⚠️ **REVERTED, 2026-08-20 — read this before the table.** Owner, verbatim:
*"we want to revert the change i made to the prompt being used for Meta
videos. I want to go back to the prompt I was using before we standardized on
the pmax prompt but stretch it to 10s. Also, I want to use this same prompt
for PMax for now also."* Mechanism: **the switch itself is unchanged** — the
revert is a one-line-per-name flip of the SHIPPED DEFAULT, not new code.
`config/defaults.env` now ships `VIDEO_HOOK_FIRST_PROMPT=false` and
`PMAX_VIDEO_DIRECTIVES=false` (was `true`/`true`); the code's own fallback
(`isHookFirstVideoPromptEnabled()`'s `return true` when both names are unset)
is deliberately untouched, so the switch can still be flipped back to `true`
with no code change if this is revisited again. On a fresh boot (no Render
dashboard override of either name) **both Meta and PMax now default to the
frozen `gemini-omni`/`OMNI_DIRECTIVES` camera prompt** — the same text the OFF
arm always produced (B15 below), now the shipped state for PMax too. The
"stretch to 10s" half of the ask needed **no prompt-text change at all**: the
Timeline/Scene/Output sentences in `buildVeoPrompt` interpolate `durationSec`
(`t1 = dur/3`, `t2 = dur*0.64`) rather than hardcoding seconds, and Meta/PMax
were already both flooring to `durationSec=10` before this change (the
duration bullet in §2, unrelated axis) — so the frozen prompt already reads
"Timeline (10.0s): Scene 1 (0.0–3.33s) … Scene 3 (6.40–10.0s)" once it is
selected. Verified live (no generation): `promptProfileFor` returns
`gemini-omni` for both `meta_stories_9_16` and `pmax_video_9_16` after loading
the real `config/defaults.env`, and their built prompts are byte-identical to
each other and to the `134db56~1` baseline at `durationSec=10`.
**One real cost consequence, not a bug:** the mixed-run shared-9:16-master
saving below (§2, "MIXED Meta+PMax") requires this switch ON as its 4th
conjunct — with it OFF by default, a mixed Meta+PMax run fails that conjunct
closed and bills **3 masters / $2.70 again**, not 2 / $1.80. Pinned (both
arms) by `verifySharedPortraitMaster` F1/F6/C1 — nothing there changed; only
which arm is the boot default did. Flip either switch name back to `true` to
restore the 2026-08-18 hook-first standardization (both platforms, and the
$1.80 shared-master saving) with no code change.

| | Status |
|---|---|
| `OMNI_DIRECTIVES` / `GROK_DIRECTIVES` **text** | **STILL FROZEN**, still `134db56~1`. Never reword. B1–B13 absence pins unchanged. |
| Meta prompt with the switch **OFF** | **STILL byte-identical** to `134db56~1`. This is where the rollback guarantee now lives — B15. **This is now the shipped default for BOTH platforms (2026-08-20).** |
| Destination-less prompt (scaffold, `aiVideoReferenceService`), either arm | **STILL byte-identical** — B14. |
| Which profile a **Meta or PMax destination** selects with the switch **ON** (opt-in, not default) | `hook_first` (B16/B17) — the 2026-08-18 standardization, still fully supported and tested, just no longer the boot default. |

Mechanism: the profile formerly called `pmax` is renamed **`hook_first`**
(`PMAX_DIRECTIVES` → `HOOK_FIRST_DIRECTIVES`; both old names still exported as
aliases, `'pmax'` still accepted as a profile value). `promptProfileFor` now
returns it for **any** Meta *or* PMax video destination. The exact delta a Meta
9:16 ad receives is five edits — HOOK-FIRST sentence appended to `objective`;
Scene 1's "slow horizontal pan left→right, ~10–15%" replaced by the HOOK
push-in; "Maintain center framing." → "Maintain centre-safe framing."; a
centre-safe sentence inserted into `cameraStyle`; a `Frame (9:16 vertical):`
line Meta never emitted before. **B16 reconstructs that exact delta from the
`134db56~1` baseline and demands byte equality**, so any reword of either half
fails loudly with a diff. **B17** pins that Meta 9:16 and PMax 9:16 emit one
identical prompt — that equality is what lets one 9:16 plate serve both.

**Kill switch — `VIDEO_HOOK_FIRST_PROMPT`, legacy alias `PMAX_VIDEO_DIRECTIVES`.
EITHER name reading `false` disables**, and that fail-safe OR is deliberate,
not sloppiness: `config/defaults.env` is loaded by dotenv **without
override**, so a "new name wins" precedence rule would silently shadow a Render
dashboard override of the legacy name the moment the new name got a value in
that file. **Two different defaults — do not conflate them.** The CODE's own
fallback (`isHookFirstVideoPromptEnabled()`, both names unset) is still `true`
— unchanged, and pinned by `verifyPmaxPromptOverlay` V2b "both names unset ⇒
ON by default". The FILE default in `config/defaults.env` is `false`/`false`
as of the 2026-08-20 revert above — pinned by the same file's V2c, which reads
the real committed file text (same pattern as `verifyPostPilotBatch` C14 for
`REPEAT_PRIMARY_REFERENCE`). On a real boot, dotenv loads the file, so the
FILE default is what runs absent a Render dashboard override. Flipping either
name to `true` restores **both** platforms to `hook_first` — Meta to the
2026-08-18 standardization, PMax likewise. Flipping to `false` (the current
shipped state) restores **both** platforms to the frozen pre-#61 text
byte-for-byte. Other services must gate on the exported
**`isHookFirstVideoPromptEnabled()`**, never on an inline `process.env` read
(the two-name OR is not reproducible by `process.env.X !== 'false'`), and never
on the two profiles merely *matching* — with the switch off they also match, on
the frozen Ken Burns pan that PMax Phase B rejected.

One text edit was required for platform-neutrality and is called out here
because it changes bytes the model sees: the lifestyle branch's two destination
labels read `HOOK-FIRST (PMax destination)` / `Centre-safe composition (PMax
destination)`; naming PMax became false on a Meta ad, so both now say
`(video destination)`. Directive content is otherwise untouched.

**Primary-reference repeat is default OFF** (same day / same reason): both the
code default (`isRepeatPrimaryReferenceEnabled`, `atlasVideoService.js:829`)
and `config/defaults.env` `REPEAT_PRIMARY_REFERENCE=false`. Default stack =
the first **3 DISTINCT** refs with nothing appended. Turning the repeat off
removed the only clamp on that branch (`REPEAT_PRIMARY_TOTAL_CAP=4` applies
**only** to the opt-in flag-on path), which would have let
`videoSettings.referenceImageCount=7` ship seven refs against the owner's
"too many images hallucinated" finding — so **`MAX_DISTINCT_REFERENCES=5`**
(`atlasVideoService.js:813`) is the new hard ceiling on the default branch.
`REPEAT_PRIMARY_TOTAL_CAP=4` still applies only when the flag is explicitly on.

**STATIC** — direct to **gpt-image-2/edit**, one call returns the finished ad
(`directImageRenderService`). No HTML, no Puppeteer, no SVG overlay compositing.
Each Meta static size is its own billable image gen (`meta_static` = 3 —
`platformFormats.js:576-583`). **`ai_brand_led`** (when `STATIC_BRAND_LED_COPY`
is on, default true) resolves to its own `brand_led` intent
(`staticAdIntents.js:533-562`) with a BRAND LINE + SUBHEAD + TRUST MARK + CTA
contract and a copy cascade in `buildIntentData` (Director →
`layoutInput.copy` → `brand.tagline` for headline; Director →
`layoutInput.copy.subheadline` for subhead; case-insensitive dedupe). Flag-off
restores a **byte-identical** pre-change prompt (`TEMPLATE_INTENT` entry + both
cascades + SUBHEAD role revert together). `ai_ugc_led` / `ai_editorial` still
fall to `product_first_lifestyle` (unmapped). Full write-up:
`docs/PIPELINES.md` §5 *Brand-led intent + copy cascade*.

**WHICH TEMPLATE an ad becomes is the DIRECTOR's choice, not the operator's —
and the wizard no longer offers a template picker at all.** The frontend hardcodes
all five `ai_*` ids into every request (`GenerateAds/index.tsx`
`DEFAULT_TEMPLATE_IDS`; the Settings step was dropped 2026-06-12, `52cf33c`), and
under `AI_CONCEPT_DRIVEN=true` the *actual* template comes from the Director's
`routing.creative_style` via
`CREATIVE_STYLE_TO_TEMPLATE[style] || 'ai_brand_led'`
(`campaignAdsGenerationService.js`) — so an unrecognised or absent style silently
becomes **`ai_brand_led`**. That default, plus a round prompt whose entire
creative_style guidance was one bare enum line, is why production measured
**`ai_brand_led` 200+ renders vs `ai_social_proof_led` 18** over
2026-07-30..08-06. The string `social_proof_led` appeared exactly **once** in
`aiCreativeDirectorService.js` (the enum) and in **zero** prompt guidance.
Fixed 2026-08-10: `buildPromptRound` now carries per-style selection criteria
(with `brand_led` explicitly named the *default of last resort*),
`creative_style` is a listed concept-diversity axis, and when proof data exists
a **reserved slot** requires ≥1 of the 3 concepts to be `social_proof_led`.
**The reserved slot fires only on a RATING being reachable, not on any proof** —
`INTENTS.social_proof_led.eligible` is rating-only, so reserving a slot on the
strength of a quote or comment alone would mint `ai_social_proof_led` on products
that then fall back at render, *amplifying* the collapse this fixes (adversarial
finding; pinned by A5b). That condition is a strict subset of "the HONESTY RULE
does not fire" — **the two must never both be active**, or the prompt demands a
proof concept while forbidding proof (the self-contradictory-prompt class that
forced the §00 PR #61 rollback). The `proof_options` term is gated on the **same
flag** as the honesty rule's `proof_options` clause, so a stale or injected
summary cannot desynchronise them (pinned by A6b).
`DIRECTOR_PROOF_MENU_ENABLED` is now **true** (`config/defaults.env`), which is
what lets a product-scoped run ground a proof concept on scope-labelled brand
numbers; flipping it back off restores the pre-change prompt byte-for-byte,
**including** the original honesty-rule string. Paired with
**`DIRECTOR_SIGNALS_VERSION` 3.1.0 → 3.2.0**. ⚠️ **Scope of that bump, stated
correctly because an earlier version of this note got it wrong:** the LIVE path
`directConceptsRound` has **no** `signalsVersion` cache gate and re-assembles
every round, so the menu takes effect with or without the bump. The only gate is
at `aiCreativeDirectorService.js:262` in the **shadow** `directConcepts` path —
so the bump buys shadow correctness and costs one paid re-derive per shadow cache
key, and is **not** what makes the flip work. Pinned by
`scripts/verifySocialProofRestoration.js` groups A/B.

### The overlay is PREVIEW ONLY — and it is not the titling

Two different things, repeatedly confused, so state both:

- **Titling / "chrome"** in `brandScriptExecutor` → `remotionRenderService` **is
  burned into the video**. Correct and intended.
- **The Meta surface overlay** — the simulated IG/FB furniture *including Meta's
  current CTA treatment for that surface* — is **PREVIEW ONLY and MUST NOT be
  burned in**. Owner: *"the meta overlays should include the current meta
  treatment for CTA as those are not burned in the video."* An advertiser
  uploads a clean asset; Meta draws its own UI.

### SCOPE — what constrains deletion, and what does not

Exclusivity covers **catalog-based product ads** (`Ad.variantKind ===
'product_image'`). Owner: *"existing alternate pathways will exist for social
media images that get repurposed for ads."* `'ugc'` is that repurposed social
image — **and it is also moving to the new pipeline** (owner, same day).

Three things that do **NOT** constrain deletion, all owner-confirmed:

- **Already-generated ads.** *"I am not worried about ads that have been
  previously generated, they are already there."* They hold finished
  `renderUrl`s. Old renderer code is only needed to RE-render them, which is not
  a requirement. (Older snapshot: ~777 ugc / ~466 product_image on `html_gen` —
  not re-counted 2026-08-03; counts are not a reason to keep dead code.)
- **Brand pipeline flags.** *"All brands should be on the new pipeline now"* —
  earlier snapshot: 33 brands `null`, 1 `direct_overlay`, **zero** on `'html'`
  (not re-queried 2026-08-03). Code path is still load-bearing:
  `resolveStaticPipeline` maps everything except literal `'html'` to
  `DIRECT_IMAGE`.
- **`renderRoute: 'html_gen'`.** ANOTHER MISNOMER, same family as `veo*`.
  `renderRouteForKind()` returns `'html_gen'` for every image ad regardless of
  brand or variant — it means "static", not "the HTML renderer". The real
  renderer is chosen inside `renderService`: every `ai_*` static ad enters
  `renderDirectImage` (`renderService.js:485-487`) and returns on success.
  Production proves it — rows can be `html_gen` + pipeline `direct_image`.

**So the HTML renderer is unreachable for new generation.** It survives only for
non-`ai_*` legacy templates, which §1 already documents as routing to the dead
`renderViaSpec`.

Still must stay: `headlessScrapeService`, `brandLogoIngestService` and
`reviewHeadlessCapture` use Puppeteer for **scraping / ingest / review capture**,
not generation.

---

## 0. THE ONE RULE THAT WOULD HAVE SAVED THE MOST TIME

**Code being present does not mean the path is live.** This repo retires paths by
kill-switch and comment-block, leaving the old code — and often its documentation —
in place. A single session burned hours getting the video pipeline wrong three times
by reading call sites instead of selectors.

Before planning work against any path, **find the selector and read what it actually
returns**:

| Question | Where the answer really is |
|---|---|
| Which titling engine runs? | `brandScriptExecutor.js:913-922` — returns `'remotion'` **unconditionally**; the cascade below it is inside `/* … */` |
| Which render path runs? | `renderService.js:485-520` (`ai_*` static → `renderDirectImage`, return) vs `:895` `renderViaSpec` fallthrough |
| Which video overlay runs? | `routes/ads.js:1156` `if (ad.renderRoute === 'veo')` → master + `renderBrandScriptAndSave`, then **returns**. Never reaches `renderCreative` |
| Which models can a user pick? | `selectable: true` in `MODEL_CAPS`, filtered at `routes/ads.js:1979` |
| Concept field (v2 flat vs v3 `routing`)? | **Only** `services/conceptProjection.js` — `conceptField()` / `conceptMediaPicks()` |
| Is a feature on? | grep `config/defaults.env` — it is `dotenv`-loaded at boot by `index.js:5` and `worker.js:20` |

Cheap habit: `grep -n "function resolve<Thing>" -A 20` and read the **first**
`return`. If there is a `/*` below it, the docs may describe the comment.

---

## 1. Dead or disabled paths — do not plan work against these

Verified 2026-07-29; line anchors re-checked 2026-08-03. Each looks live; none is.

- **Canvas titling engine.** `resolveTitlingEngine` is hard-wired to remotion, so
  `TITLING_ENGINE` and `Brand.videoSettings.titlingEngine` are **not read by the render
  path** — and worse than inert: they are still validated, still persisted, still
  returned by brand routes, and **badged in the UI**. A brand set to `'canvas'`
  displays "engine: canvas" while rendering with remotion. All of
  `services/brandScripts/*.script.js`, `brandScriptRunner.child.js`, and the
  canvas `sharp.resize(fit:'cover')` paths are dead. See `docs/TITLING.md` §0.
  **The former exception is now CLOSED (2026-08-03).**
  `POST /api/brand/:id/preview-script` used to reach the `vm.compileFunction` escape
  via **three** doors, not one: `body.script` (forces `'canvas'`), the
  `body.engine:'canvas'` hatch (which short-circuits *before* `resolveTitlingEngine`
  is consulted), and a `styleScript*` persisted earlier through the unvalidated
  `PATCH /api/brand/:id` allow-list and then previewed with `{engine:'canvas'}` and no
  `body.script` at all. An `engine !== 'remotion'` → 400 guard immediately after the
  engine resolution (`routes/brand.js`, search `SECURITY (GEN-1)`) closes all three
  and stays closed if `resolveTitlingEngine` is ever un-hardwired. **No HTTP route
  reaches `runChild` now**; `scripts/testBrandScript.js` still does by design, which
  is why `brandScriptRunner.child.js` cannot simply be deleted. Pinned by
  `scripts/verifyPreviewScriptGuard.js` (8 checks; removing the guard fails 3).
  Note the original prescribed fix — delete the `bodyScript` branch — was
  **insufficient**, leaving a two-request exploit; and `parsingContext` would not have
  helped either, because the injected params are parent-realm objects
  (`helpers.clamp.constructor("return process")()` escapes a fresh context).
  See `ARCHITECTURE_REVIEW.md` GEN-1.
- **`renderViaSpec` + the whole `frontend/client/` tree.** `renderViaSpec`
  (`renderService.js:895`) fetches `${FRONTEND_URL}/ads.html`, but the frontend's
  `netlify.toml` publishes only `frontend/app/dist` and its `/*` fallback
  swallows everything else. Probed live: `/ads.html`, `/templatePreview.js`,
  `/tp-zones.css` all return the **655-byte Vite shell**, byte-identical to `/`.
  So that path loads a React shell, waits for `window.__tpRenderReady`, and times
  out at `RENDER_TIMEOUT` (60s). Blast radius: the **7 legacy templates** in
  `schemas/rsSocialProof.templates.catalog.json` (`creator_endorsement`,
  `product_overlay`, `results_proof`, `review_collage`, `testimonial_overlay`,
  `testimonial_spotlight`, `ugc_split_screen`) are all `status: active`, and none
  starts with `ai_`, so they miss the direct-image block and fall through to
  `renderViaSpec`. By inspection they cannot render. **Not** verified by
  actually rendering one, and **not** checked against the DB for whether any existing
  ad still references them. `ai_*` templates are fine on the direct-image path but
  lose their HTML fallback.
- **Cloudinary video compositing.** `composeVideoOutput` /
  `videoCompositeService` are **not** on the live video path (see the table in §0).
  Reachable only via a static ad with a video source, or `aiOverlayPolishService`,
  which is gated on `AI_OVERLAY_POLISH_ENABLED` = **`false`**
  (`config/defaults.env:59`).
- **`smartCropBbox`.** `renderService.js` (~1321+) still builds a bbox for
  `buildVideoCompositeUrl`, which documents it as "kept for compat; UNUSED in v2
  chain" and discards it. No caller reads the returned value either. `sourceDims`
  from related crop work **is** live.
- **`slotFitCloudinaryUrl`** (`frontend/client/templatePreview.js`) is a
  deliberate no-op. The comment above its call site still claims it chains
  `c_fill,g_auto`. It does not.
- **`pickHeroSourceRatio`** (`layoutInputService.js`) reads
  `registry.CANVAS.templates[template]` — **legacy templates only**. Returns null for
  every `ai_*` template. The live crop insertion point is `buildCloudinaryCropUrl`
  and its winner-selection sites.
- **Telegram.** Gone. Operational alerts are **Slack only**
  (`services/alertService.js`). See §4.

**Puppeteer is static-image-only / scrape-only.** Live HTML path + dead spec path
in `renderService`, image regen, HTML→PNG seed, and `headlessScrapeService`.
Video never launches a browser.

---

## 2. Money invariants — violating these costs real cash

- **Generation POSTs are billable. Submit once.** A replay is only safe on positive,
  *structured* proof the request was rejected before work began — that is
  `isDefinite429` (`atlasVideoService.js`), not `isRateLimit`. `isRateLimit` casts
  wide on purpose and is for **polling**, where retries are free. The decision is one
  pure function, `submitRetryDecision()`, covered by
  `scripts/verifySubmitGuard.js` (31 offline checks, no DB/network/key).
- **`maxRedirects: 0` on every billable POST.** Axios defaults to **21** and re-sends
  the body on 307/308 — a silent double charge inside one call, invisible to retry
  logic.
  **CLOSED 2026-08-19 — the shared LLM chat transport was the one exception.**
  `services/atlasLlmService.js`'s `post()` — the ONE function serving both the
  Atlas primary and the direct-provider fallback twin inside `chatCompletion`,
  which **25 services** call (Director, Judge, copy/layout derivation, and
  most of the money-facing LLM pipeline) — had no `maxRedirects: 0` until this
  date. Found during adversarial review (two independent reviewers) of a
  cost-ledger PR that routed a new caller through this exact function;
  confirmed pre-existing and not a regression (the direct call it replaced
  lacked it too). Live-probed the same day with unauthenticated requests: none
  of the three endpoints this transport calls (`api.atlascloud.ai`,
  `generativelanguage.googleapis.com`, `api.openai.com`) actually redirect —
  each returns its rejection status directly, zero hops — so the exposure was
  real but not firing in practice. Fixed; pinned by
  `scripts/verifyLlmErrorCodes.js` D5, revert-proven against three mutations
  (the flag missing, and a bare-`axios.post` bypass at either call site — the
  first draft of this check was fooled by its OWN explanatory comment
  containing the string it searched for, and by a bypass regex that matched
  inside `axios.post(...)` as a substring; both are why the check strips
  comments and uses a negative lookbehind on `.`).
- **Never trust a model id or a price from memory.** `GET
  https://api.atlascloud.ai/api/v1/models` (no auth) is the catalog; each entry
  carries `schema` and `readme` **URLs** — fetch those, they are the operative
  contract. The price field is **`price.actual.base_price`** (a string; `origin` is
  list). Verified live: **0 of 444** entries have a `pricing` key, **444 of 444** have
  `price`. 123 have no `base_price` at all — those are per-token LLM entries, which
  must be treated as "not applicable", never as free.
  Covered by `scripts/verifyImagePricing.js` (9 offline checks, revert-proven).
- **`base_price` IS NOT THE CHARGE — never quote it as a cost. CORRECTED
  2026-08-03; this file previously said `actual` "is what we pay", and that was
  wrong by 7x.** MEASURED over 40 live edits: `openai/gpt-image-2/edit` publishes
  base_price **0.01** and charged **$0.07173** every single time; the
  `openai/gpt-image-2-developer/edit` variant publishes **0.005** and charged
  **$0.03586**. So the 50% discount is real, but a multiplier (~7.17x here) applies
  on top of both, it is not derivable from the catalog, and it must not be
  extrapolated to another model or another size/quality. A 3-surface `meta_static`
  fanout is therefore **~$0.11 per product on the developer model**, not ~$0.015.
  **Owner rule: always read the actual price back from Atlas after generation.** The
  authoritative figure is `price` on the **settled prediction**
  (`GET /model/prediction/:id`). **Images:** `scheduleCostReconcile`
  (`atlasImageService`) upgrades the row and clears `costSource:'estimated'`.
  Atlas usually publishes `price` *after* the image returns — measured **7 of 38**
  predictions had it at completion — so the scheduled re-poll is the normal path
  for images; its retry budget was widened the same day for exactly that reason.
  **Video (post-Phase-B):** the same rule is now implemented in
  `atlasVideoService` — `reconcileVideoCostFromTerminal` (fire-and-forget after the
  master lands) + `scheduleVideoCostReconcile` fallback. **Before this, every video
  row stayed the `estimateRenderCostUsd` formula forever** (~33% over-report on the
  developer model at 10s: formula $1.20 vs measured settled **$0.90** — over-
  REPORTING, not overspending). Video **does** publish `price` at completion
  (measured), so the immediate path is the normal one and the re-poll is the
  exception. `MODEL_CAPS` / the estimate function are deliberately unchanged (pre-
  settlement floor). Pinned by `scripts/verifyVideoCostReconcile.js`.
  **Consequence:** a video row still on `costSource:'estimated'` means the price
  was **never published**, not that the formula is authoritative. Do not quote
  `base + per-second` as spend for the developer model. `buildPriceMap` yields a
  floor-grade estimate whose only job is to stop a $0.00 row. Any budget, margin
  or per-ad cost claim must come from **reconciled** rows.
  **A POLL TIMEOUT is a THIRD case, separate from both of the above, closed
  2026-08-19 (incident run_1787119100250_eef4d871 — two Omni masters timed out
  at 600s, both still unsettled at Atlas 14-25+ min later).** Before this fix,
  a timeout threw a bare unclassified Error and `routes/ads.js` always wrote
  `status:'failed'` — which severed the ad's already-stamped spend receipt
  (`Ad.veoPredictionId`) from `bootRecoveryService`'s recovery, so a prediction
  that later completed or settled was written off instead of recovered/
  reconciled, and the CostLog row stayed at the submit-time estimate forever.
  Fixed: `pollPrediction` does one final free peek at the deadline before
  giving up (`resolveTimeoutOutcome`); on a genuinely still-unsettled peek the
  ad's `status` is left at `'rendering'` (not `'failed'`) so
  `bootRecoveryService.resumeInFlightAds` — already run periodically from
  `worker.js`'s `recoverTick`, not boot-only — keeps polling until Atlas
  settles, then reconciles via the SAME confirmed-price read the image path
  uses (`resolveRecoveredVideoFailureCharge`, tri-state: confirmed-unbilled →
  zero the estimate; confirmed-billed with a real price → correct to it;
  unknown → leave untouched). `MAX_POLL_MS` itself is UNCHANGED (600000) —
  fresh Omni-only completion data (n=28, Aug 14-19) measures p99=215s/max=215s,
  so 600s already carries ~2.8x headroom; the incident's two predictions were
  still unresolved well past any plausible cap, so a bigger number would not
  have helped and would have held a render slot open longer. Pinned by
  `scripts/verifyVideoTimeoutReconcile.js`. Full write-up: `session.md`
  2026-08-19.
- **Ledger spend at the charge point, not the success point.** A billable submit that
  then fails still costs money. `atlasImageService.chargedError` records it and sets
  `err.charged`, which is the flag telling a caller that a direct-provider fallback
  means paying twice for one asset.
- **Never print or commit `ATLAS_API_KEY`.**
- Same-model submits are paced by `pacedModelSubmit` (`ATLAS_SUBMIT_SPACING_MS`,
  default 1200ms). It is **in-memory**, so it is not a global limiter across web
  instances; `VEO_CONCURRENCY` is per-process too (`routes/ads.js:147`).
- **Static: each aspect / surface is its own billable image generation.**
  `resolvePreset('meta_static')` / `META_STATIC_FANOUT` = three Meta sizes =
  three image submits (`platformFormats.js:405`, `:576-583`). Cannot crop one
  static plate cheaply — text is burned in-model (`:400-403`).
- **Video (Meta): ONE Omni 9:16 master per product — and TWELVE Ads
  (4 surfaces × 3 intent stages).**
  `resolvePreset('meta_video'|'meta_all')` returns
  `videoFormats: [META_VIDEO_MASTER]` only (`platformFormats.js`) — that is the
  billable list and must stay length 1. `expandWizardJob` then mints three FREE
  derivative Ads (`META_VIDEO_DERIVATIVES`: feed 1:1, feed 4:5, Reels retitle)
  plus consideration/conversion retitles of every surface (the unstaged row
  IS awareness — masters never carry `funnelStage`). Every free row carries
  `deriveFromMaster: 'meta_stories_9_16'` so they route through
  `renderDeriveOnlyVideoAd` and never reach Omni. Gated on the 9:16 master
  actually being in the run — a 1:1 or 4:5 window fits inside a portrait frame,
  so those crops are honest, but deriving them from a squarer master would be
  cropping up. An operator hand-picking a single non-9:16 Meta surface in
  Advanced still gets exactly one Ad at its own aspect, unchanged. **The older
  claim in this file — that `identityDigest` made 1:1 + 4:5 + 9:16 = three
  separate video submits — was true for non-preset multi-aspect video queues
  (measured in prod 2026-08-01) and is a money bug if reintroduced; it is not
  the `meta_video` path.** Flag-off (`PMAX_FUNNEL_VARIANTS=false`) restores
  the pre-variant mint of 4 (1 master + 3 derivatives).
  **Meta video is now floored at 10s on EVERY run** (owner directive
  2026-08-18) — the wizard's posted `8` no longer wins; see the duration
  bullet below. **On a mixed Meta+PMax run this same master also serves
  PMax's portrait surfaces** — see the shared-portrait bullet below.
- **Video (MIXED Meta+PMax): ONE shared 9:16 master, not two, WHEN the
  hook-first switch is ON. TWO billable Omni masters per product then, not
  three — $1.80, was $2.70 (owner directive 2026-08-18).** ⚠️ **CONDITIONAL,
  and the condition is not cosmetic** — the share only happens when all five
  conjuncts below hold, and the load-bearing one is that the hook-first camera
  standardization is ON. With it off a mixed run still bills **3 / $2.70**, by
  design. **As of the 2026-08-20 owner revert (§00), OFF is the shipped
  `config/defaults.env` default** — so a mixed run bills **3 / $2.70 today**,
  not 2 / $1.80, absent an explicit re-enable of `VIDEO_HOOK_FIRST_PROMPT` /
  `PMAX_VIDEO_DIRECTIVES`. Do not quote $1.80 as the unconditional
  present-tense cost without checking
  `isHookFirstVideoPromptEnabled()`. A mixed run measured 21 video Ads / 3 distinct
  `veoPredictionId`s. Two of those three were the same portrait plate at
  byte-identical `deliveryDims` (`meta_stories_9_16` and `pmax_video_9_16`
  are both 1080×1920; they differ only in their **safe ZONE**, which is a
  TITLING input resolved per row from the row's own `platformFormat` through
  `remotion/lib/safeZones.js`, so one plate serves both surfaces while each
  keeps its own burned-in treatment. ⚠️ **Not `platformFormats.safeArea`** —
  this line used to say that and it was wrong; Remotion never reads that
  field. See §00 step 4.) Now
  `pmax_video_9_16` keeps its own Ad row and its own `platformFormat` but is
  minted as a FREE derive of the Meta plate. **Delivered count is unchanged
  at 21.** The 16:9 master stays billable — nothing can derive a landscape
  frame from a portrait plate without cropping up.
  - **The decision is `resolvePortraitMasterFormat(masterFormats)`
    (`campaignAdsGenerationService.js`), computed ONCE inside
    `planDeterministicVideoAds` and STAMPED onto every affected row as
    `deriveFromMaster`.** The render loop and the regenerate preflight read
    that stamp back through `resolveDeriveFromMaster`; neither re-derives the
    condition, so planner and renderer cannot disagree. **The renderer must
    never ask "is there a Meta sibling on this campaign?"** — a previous
    Meta-only run would let a later PMax-only 9:16 adopt that old plate and
    skip its Omni submit. Only the mint knows the run.
  - **FAILS CLOSED ON FIVE CONJUNCTS**, all required: the
    `UNIFIED_VIDEO_9_16_MASTER` kill switch; the Meta master minted IN THIS
    RUN; the PMax portrait master requested IN THIS RUN; the hook-first camera
    standardization being ON; and the Meta 10s floor being active. **On a
    PMax-only run
    `pmax_video_9_16` stays BILLABLE** — a derive whose master never exists
    fails honestly and the run would ship NO 9:16 video at all, which is
    worse than paying $0.90. When in doubt, bill.
  - ⚠️ **DO NOT add a `platformFormat === 'pmax_video_9_16'` branch to
    `resolveDeriveFromMaster`.** It looks like the `pmax_video_1_1` pattern
    and is not: the square was never a legitimate billable master, the 9:16
    is. Format-only there produces ZERO 9:16 video on every PMax-only run.
    An unmarked `pmax_video_9_16` must stay billable.
  - **THE WHOLE PMAX PORTRAIT FAMILY IS RETARGETED, not just the 9:16 row.**
    `findSiblingMasterAd` matches TRUE masters only (no `deriveFromMaster`,
    no `funnelStage`), so once the 9:16 is a derive, `pmax_video_1_1` and the
    staged 9:16 retitles must point at the shared plate too — otherwise they
    are derivatives of a derivative and fail "no sibling master ad" on every
    mixed run. Harnesses exercising only a PMax-ONLY plan stay green through
    that entire failure, which is why the MIXED plan is pinned explicitly.
  - ⚠️ **DURATION IS A SOUNDNESS REQUIREMENT, NOT A DETAIL. Google rejects
    PMax video under 10s**, so a shared Meta-format plate must clear 10s or
    the "free" PMax 9:16 is a paid-for asset Google will not accept — and
    **nothing offline can see that**, because no harness talks to Google
    ingest. This is handled by the UNIVERSAL Meta 10s floor (above), not by a
    mixed-run special case: one rule, nothing to keep in sync. **The two are
    coupled and the coupling is enforced, not documented:**
    `META_VIDEO_DURATION_SEC=0` reverts the Meta floor with no deploy, and
    `resolvePortraitMasterFormat` treats that as a refusal to share — PMax
    goes back to minting its own portrait master rather than riding an 8s
    plate. Fail-closed, like every other conjunct.
  - **Correlated failure is the accepted cost.** One plate means one point of
    failure: if the shared master fails, 15 of the 21 rows fail with it (was
    6 under three masters). That is inherent in "a single minting for 9x16"
    and is owner-directed, not an oversight.
  - ⚠️ **CONJUNCT 4 IS THE CAMERA SWITCH, NOT "DO THE TWO PROFILES MATCH".**
    This was got wrong once and the wrong version is seductive. MEASURED
    against the merged prompt lane: with the standardization OFF both
    destinations fall through to the SAME `gemini-omni` profile, so a profile
    -equality test is **TRUE IN BOTH SWITCH STATES** — a dead conjunct that
    gates nothing, and the state it admits is the worst one (a shared plate
    shot with Meta's pan, delivered to YouTube Shorts, while the operator
    believes they rolled the camera back). The gate therefore calls
    **`veoPromptBuilder.isHookFirstVideoPromptEnabled()`** — imported, never
    re-implemented, because that switch reads TWO env names
    (`VIDEO_HOOK_FIRST_PROMPT` + legacy `PMAX_VIDEO_DIRECTIVES`) with a
    deliberate fail-safe OR. Profile equality is retained only as a SECOND,
    belt-and-braces conjunct. Pinned by `verifySharedPortraitMaster` F6.
  - Flag off (`UNIFIED_VIDEO_9_16_MASTER=false`) restores the three-master
    mint byte-for-byte, same 21 ads. Pinned by
    `scripts/verifySharedPortraitMaster.js` (86 checks, revert-proven on
    twelve mutations — including the equality-only gate above, and two
    checks that were themselves found VACUOUS by revert-proof because they
    never reached the conjunct they claimed to test).
- **Video (Google PMax, Phase A 2026-08-10): TWO billable Omni masters per
  product — 9:16 + 16:9 — not one, and not three. Delivered: NINE Ads
  (3 surfaces × 3 intent stages), not 12.** (Standalone `google_video` /
  `google_all`; on a mixed Meta+PMax run see the shared-portrait bullet
  above — still two billable, but the portrait one is Meta's.)
  `resolvePreset('google_video'|'google_all')` returns
  `videoFormats: GOOGLE_VIDEO_MASTERS` only (`['pmax_video_9_16','pmax_video_16_9']`);
  do **not** return the full `GOOGLE_VIDEO_FANOUT`. `pmax_video_1_1` is
  **derive-only**: face-safe crop of the settled 9:16 master's already-paid
  plate + its own Remotion titling — **never** an Omni submit. The unstaged
  master IS awareness; consideration + conversion are free retitles. Do
  **not** also mint a staged `funnelStage:'awareness'` row — that is the
  measured 4-per-surface pile (unstaged + three stages). Full write-up:
  `docs/PIPELINES.md` §6 *Google Performance Max video*.
- **`pmax_video_1_1` must never reach a billable submit.** Gate is
  `resolveDeriveFromMaster(ad)` in `services/campaignAdsGenerationService.js` —
  **one definition, imported** by `routes/ads.js` (render) and
  `adRegenerateService.js` (regenerate preflight → 409). Fail-closed on
  `platformFormat === 'pmax_video_1_1'` so a dropped `deriveFromMaster` field
  cannot re-open spend. Master failed/absent → honest failure, never Omni
  fallback. Wait in-render for the plate (`DERIVE_MASTER_WAIT_MS` /
  `DERIVE_MASTER_POLL_MS`); do not requeue (stranded `queued` never auto-drains
  and a second Generate short-circuits as "Nothing to render"). Pinned by
  `scripts/verifyPmaxVideoExpansion.js` (81 checks, was 54 — the count had
  already drifted from earlier sessions' F1-F6c additions before this fix).
- **Duration on the video identity digest is Google-only.
  `funnelStage` is not.**
  `computeDeterministicVideoDigest` keeps prefix `det-video:v1` and appends
  `videoDurationSec` **only** for Google PMax video formats (zero history). An
  earlier draft appended duration unconditionally and bumped `v1`→`v2` —
  MEASURED that changed every pre-existing Meta video digest; because the
  digest deliberately omits `generationRunId`, the `(campaignId, identityDigest)`
  unique index is the only guard against a repeat Generate re-billing Omni, so
  the next Generate on any existing campaign would have paid ~$1.00–1.20 per
  product again. Pre-existing Meta digests stay byte-identical. **Meta 8s→10s
  duration identity is a deliberate one-time re-mint that must be costed and
  flagged, never folded in silently.**
  **CORRECTED 2026-08-18 — "Meta 8s→10s is a one-time re-mint" was about the
  DIGEST, not the VALUE, and the distinction is the whole point.** Making Meta
  duration part of the Meta *identity* would re-key the corpus and re-open the
  re-bill; that is still forbidden. **Changing the duration VALUE costs
  nothing and re-mints nothing**, because the Meta digest omits duration
  entirely (verified: `digest(meta, 8) === digest(meta, 10) === digest(meta,
  null)`, pinned by `verifySharedPortraitMaster` G3). Meta video is now
  floored at **10s universally** (owner directive 2026-08-18: *"make meta
  videos 10 sec also, we already discussed this"*) in
  `resolveVideoDurationForFormat` — previously the 10s Meta default applied
  only when duration was UNSET, and the wizard's Video Length control has no
  "auto" and posts `8` on every run, so the documented "Meta is 10s" was false
  on every UI run. **The real consequence is the OPPOSITE of a re-bill, and it
  is an operator-expectation item, not a spend item:** on a campaign that
  already holds a Meta video ad, the new 10s row hashes identically to the
  stored 8s row, `insertMany` swallows it, and the operator keeps their 8s ad
  and gets no 10s version — silently. New campaigns/products mint at 10s
  immediately. **Existing Meta video ads stay 8s until deliberately
  regenerated.** Do NOT "fix" that swallow by adding duration to the Meta
  digest — that is precisely the re-key this bullet forbids. Cost: 10s
  measures **$0.90** settled; 8s is not separately measured (the `MODEL_CAPS`
  formula ratio implies roughly $0.75, which is a **floor-grade estimate, not
  settled spend**), so a Meta master gets on the order of $0.15 dearer. Also
  open: the wizard still labels its default *"8s (standard)"* — a frontend
  follow-up, not changed here.
  `funnelStage` is the other digest part, and the guard is **null-only, not
  format-scoped**: append the stage when — and only when — it is non-null.
  Every stored master has `funnelStage:null`, so a null-stage hash is
  byte-identical to the pre-variant digest (pinned by
  `scripts/verifyVideoIntentVariants.js` M1/M2 against an inline
  reconstruction of the pre-change function). Scoping the part to Google
  is what made Meta's three intent variants collide with the master on
  the unique index — `insertMany` swallowed them and the operator got one
  untitled Stories ad (measured run_1786555875841_2ddf9739). Do NOT bump
  the prefix. Do NOT push an empty placeholder.
- **Static (Google): `google_static` = 3 billable image submits**
  (`GOOGLE_STATIC_FANOUT` — landscape 1.91:1, square, portrait 4:5). Demand Gen
  + Shorts keys stay `coming_soon` (identical `deliveryDims` to live PMax —
  generating both would double-spend).
- **MEASURED settled prices (Phase B 2026-08-10/11, prompt-only Atlas submits
  — no DB/Ad rows). These supersede planning estimates:**
  | item | settled `price` |
  |---|---|
  | static 1:1 @1024×1024 `gpt-image-2/edit` | **$0.071728** |
  | static 1.91:1 @2048×1152 | **$0.061440** |
  | static 4:5 @1088×1360 | **$0.066660** |
  | video 10s 16:9 @1080p Omni **developer** | **$0.90** |
  3-size PMax static fan-out ≈ **$0.199**/concept (was ~$0.22). Two masters =
  **$1.80**. Full kit (3 concepts × 3 statics + 2 masters) ≈ **$2.40**
  standalone / ≈ **$1.50** marginal beside a Meta run that already paid for
  9:16. Earlier ≈**$2.6** planning figure is **wrong**.
- **Omni developer 10s is $0.90, not $1.20.** The `MODEL_CAPS` formula
  (`base 0.20 + 0.10/s` → $1.20 @ 10s) **overstates the developer variant by
  ~33%**. Production default is
  `google/gemini-omni-flash/image-to-video-developer`
  (`BUILT_IN_DEFAULT_MODEL`). Do not quote $1.20 for it.
- **Image `size` enum is the `1024x1024` form** (underscore style). A
  `1024*1024` submit is rejected 400 "invalid size". `2048x1152` **is** an
  enum member (Phase A `GEN_SIZES` needed no probe). Omni i2v
  `aspect_ratio` enum exactly `['16:9','9:16']`; `duration` enum
  `[4,6,8,10]`. Delivered 16:9: **1920×1080, 10.000s, 240 frames**.
- **`POST /api/ads/runs` must claim atomically** — same money shape as
  `/generate`. Use `claimAdsForRun()` only (`routes/ads.js:1172`):
  `status:'queued'` filter, ownership re-read (`campaignRunIds` + `rendering`),
  `modifiedCount` cross-check, and post-claim requeue on throw in the `/runs`
  handler (`routes/ads.js:1286`, catch block `:1438-1457`). Covered by
  `scripts/verifyRunsClaim.js` (75 checks, was 67). Do not inline a second claim path —
  **it already is one, closed 2026-08-18.** `/generate`'s inline claim (former
  `routes/ads.js:978-1016`) had no anomaly branch: when `updateMany` reported
  `modifiedCount > 0` but the ownership re-read came back empty (concurrent
  interference), `/runs` releases and fails honestly, but `/generate` folded
  that shape into the ordinary "claimed by a concurrent run" outcome with no
  release — the ads sat `status:'rendering'` until the 15-min reaper.
  `/generate` now calls the same `claimAdsForRun()` /runs and the
  stranded-sweep requeue use, so the anomaly release is shared, not
  duplicated. Extended `scripts/verifyRunsClaim.js` pins the wiring.
- **The `/generate` gate is keyed on the REQUEST FINGERPRINT, not on products
  (owner directive 2026-08-10). It is the ONLY double-click protection for
  STATIC, and the atomic claim does NOT back it up.** Each static expansion mints
  its OWN ads (`identityDigest` scoped via `generationRunId`), so two runs on the
  same product never race for a row — they each claim what they just created and
  both bill. Owner: *"don't block ads that are concurrent based on the product
  alone, but based on the actual request. So block identical requests and note
  requests that are identical to previous requests but allow them if the user
  wants."* History: one-run-per-campaign → product-overlap (2026-08-03) →
  fingerprint (2026-08-10). Rules that are load-bearing, not stylistic:
  - **(a) The key is `computeRequestFingerprint`** — a hash over exactly the body
    fields that change what gets generated. **A field the handler does not read
    must stay OUT**: the wizard posts `expandVideoFormats` and `routes/ads.js`
    never destructures it, so including it would make two runs that produce
    identical creative hash differently and let a real double-click through. The
    inverse (omitting a field that DOES affect output) causes a false block. Order
    matters per field: `productIds`/`templateIds` sorted, `mediaIds`/`seedPicks`/
    `seedMediaIds` order-preserved (a different pick order is a different ad).
  - **(b) Why dropping product-overlap is not a money regression.** VIDEO cannot
    double-bill across runs at all — `computeV2IdentityDigest` omits
    `generationRunId` when `kind==='video'` (`:1715`) and
    `computeDeterministicVideoDigest` never includes it (`:1731`), so a duplicate
    video ad collides on the `(campaignId, identityDigest)` unique index and the
    second inserts nothing. **The index protects video, not this gate.** And
    duplicate STATIC sets are owner-sanctioned creative (`:266-269`), so the
    retired "never key on format/preset" rule was guarding a `meta_all` ⊃
    `meta_static` pair that the owner's own digest instruction calls two
    intentional creatives. What is left to catch is the ACCIDENT, and an accident
    is always a repeat of the *same* request.
  - **(c) FAIL-OPEN, and only here.** The old gate failed closed on an unreadable
    product scope, which is what **broke generation from the MEDIA LIBRARY** —
    those runs legitimately carry `productIds: []`, so they read as "scope
    unknown" and were refused whenever any sibling run was in flight (and while
    in flight they blocked every product run too). Blocking now requires
    *provable* identity, and you cannot prove identity against an unknown. So
    `CampaignRun.requestFingerprint` **must** be stamped at mint time by every
    creator: losing that write silently DISABLES double-click protection rather
    than over-blocking. `/api/ads/runs` stamps `renderClaimFingerprint(runId)` —
    namespaced and unique — because a render claim mints no ads and must never be
    mistaken for the same request as a `/generate`.
  - **(d) The override is single-use by construction.** An identical request is
    refused with `confirmable:true` + `acknowledgeRunId`; the client re-POSTs with
    `confirmDuplicate:true` + `acknowledgedRunId`. Every identical in-flight run
    must be the acknowledged one, so a stray second "Generate anyway" collides
    with the run the first click just minted and is refused with a fresh id. **A
    bare boolean confirm would have re-opened the exact double-click the gate
    exists to stop.**
  - **(e) mint-then-verify** after `CampaignRun.create` still closes the
    read-then-write race where two clicks both read an idle campaign; both racers
    compute the same winner via (`createdAt`, `runId`) and the loser aborts before
    expanding, so a false abort costs a 409 and nothing else. Now keyed on the
    fingerprint too, and it is what keeps two simultaneous confirms from both
    billing.
  - **(f) `kinds` arrives as a bare SCALAR** (`'image'|'video'|'both'|null`), not
    an array. Canonicalising it with an array-only helper collapsed every value to
    `''`, so a static-only run and a video-only run over the same product hashed
    **identically** and the second was refused as a duplicate — a false block on
    the most likely real sequence ("generate the statics, then the video"). Fixed
    by `canonicalScalarOrList`; both shapes are pinned, and scalar `'video'` must
    equal array `['video']`.
  - Product overlap is still computed but is **reporting only** — a non-blocking
    `notice` on the 202 (`concurrent-run-shares-products`) so the operator sees
    that both runs will bill. It names the **earliest** overlapping run by the same
    (`createdAt`, `runId`) order the blocking path uses — the `activeRuns` query
    applies no sort, so picking by list position would surface a different runId on
    each attempt for the same situation. Pinned by `scripts/verifyGenerationGate.js`
    (**194 checks**, revert-proven against ten mutations including the stale-confirm
    money hole, the `kinds` collapse, and re-blocking media-only requests).
- **A forced Instagram RE-SCAN is billable, and the manual route is UNCAPPED.**
  `POST /instagram/sync-posts` with `force:true` re-enters already-ingested posts
  and re-queues detect on media that already had a run — each one a paid
  vision/LLM run. ⚠️ **An earlier version of this bullet claimed "the daily detect
  cap still applies". That was WRONG** — `dailyDetectRunCap` reaches `syncPosts`
  from **`scheduledSyncService` only** (plus a separate read in
  `instagramWebhookService`); the manual route passes `{limit, force,
  credentialId}`, so `runsRemaining` is null, `enqueueRun` is unconditionally
  true, and `capSkipped` can never fire there. **The only bound on one call is
  `limit` (25 default, 50 max); repeated clicks are bounded by nothing
  server-side.** This is equally true of the pre-existing "Sync Now" and is not
  something the re-scan introduced — but the re-scan is the expensive one, so
  whether to wire a cap into this route is an **open decision**, not a solved
  problem. Guards actually in force, all pinned by
  `scripts/verifyIgRescanGuards.js` (**23 checks**, five revert-proven): the
  `if (!enqueueRun) return` return must stay **above** the `forceDetect` bypass in
  `ingestPost` so force can never outrank a cap *where one is supplied* (the
  scheduled job today, this route if it is ever wired up); `forceDetect` is
  `force && !!existing` so the bypass cannot widen to new posts; the route parses
  `force === true` **strictly**, because a truthy check would let the string
  `"false"` trigger a paid re-analysis of 50 posts; `reIngested` is counted
  separately from `ingested` so a re-scan is never reported as having found new
  content; and **5f asserts the absence of the cap**, so wiring one in fails the
  harness and forces this bullet to be updated in the same commit.
- **The reframe claim is evicted on shutdown, and its poll budget / lease floor
  are INDEPENDENT constants (2026-08-27).** This repo had no
  `_activeReframeClaims` registry and no shutdown sweep (adgen did), so every
  process death — 12+ web deploys in a day — left reframe billing claims in Mongo
  with no live holder (two live orphans measured); peers then cropped or waited out
  the lease. Now swept in `processAlerts.js` on **both** the SIGTERM and crash
  paths, inside the bounded `flush()`. Separately: `reframeReferenceForAspect`
  called `pollPrediction(id)` with no options and so inherited the VIDEO ceiling by
  omission — now an explicit `REFRAME_POLL_MS` (300s; measured reframe max is
  232s, n=60). **Do NOT re-derive `REFRAME_CLAIM_TTL_FLOOR_MS` from any poll
  ceiling** — that arithmetic link is the defect: it drifted this repo (20 min) from
  adgen (25 min) over one shared `Media` claim, and its "+10 min" was already spent
  (602.5s of bounded non-poll work → **−2.5s** real margin). Poll budget is a
  latency choice; the floor is a money guard. Pinned by
  `scripts/verifyReframeHoldBounded.js` (28 checks, revert-proven on 7 mutations).
  Full write-up: `session.d/2026-08-27_reframe-hold-bounded.md`.
- **Never leave a paid Omni master in `status:'rendering'`.** Stamp `draft`
  with `veoVideoUrl` before titling (`routes/ads.js:1258-1294`). Titling failure
  → `failed` + keep master; success/no-chrome → finished. Counting an untitled
  master as success is forbidden.
- **"veo" IS A LEGACY NAME — the video model is Omni.** Corrected 2026-08-02.
  `BUILT_IN_DEFAULT_MODEL` is `google/gemini-omni-flash/image-to-video-developer`
  (`atlasVideoService.js:232`) and `ATLAS_VIDEO_MODEL` is **blank** in
  `config/defaults.env`, so that default is what runs. Veo 3.1 is in `MODEL_CAPS`
  but is not selectable. Everything spelled veo — `renderRoute:'veo'`,
  `veoPredictionId`, `veoVideoUrl`, `VEO_CONCURRENCY`, `AI_VEO_FEED`,
  `veoPromptBuilder`, `buildVeoPrompt` — is an Omni pipeline wearing an old name.
  Do not infer the model from any of those identifiers.
- **Every Meta video aspect already renders at Omni 9:16.** Omni's
  `supportedAspectRatios` is exactly `['16:9','9:16']`, and
  `omniFamilyNativeFor()` (`atlasVideoService.js:508`) ends
  `return r < 1 ? '9:16' : '16:9'` — so 4:5 routes to 9:16, and 1:1 also routes
  to 9:16 unless `SQUARE_VIA_OMNI_CROP=false`. The compositor then crops
  face-anchored via `basePlateCropService` + `faceSafeCrop`. The previous claim
  here — that 1:1 and 4:5 "force-route to Grok" — was **false**;
  `ASPECT_FALLBACK_MODEL` (Grok Imagine) is now only the square opt-out and
  explicitly-selected non-Omni models.

### Known open (do not claim fixed)

- **A pre-existing BILLABLE `pmax_video_9_16` swallows the new free derive.**
  Exactly the same mechanism as the Meta-crop bullet below and the same
  refusal to "fix" it: `computeDeterministicVideoDigest` includes
  `platformFormat` but not `deriveFromMaster`, so on a campaign that already
  holds an independently-paid `pmax_video_9_16` with the same (product, refs,
  CTA, prompts, duration), the shared-portrait derive hashes identically,
  `insertMany` swallows the duplicate-key error, and the operator simply
  keeps the older independent 9:16. **Not a spend regression** — nothing new
  bills; the free extra is absent. **Do NOT close it by adding
  `deriveFromMaster` or a run id to the digest:** the PMax formats now have
  history, and the `(campaignId, identityDigest)` unique index is the ONLY
  guard against a repeat Generate re-billing Omni. Note the duration part
  makes this narrower than the Meta case — a legacy 8s row does not collide
  with a 10s derive.
- **The free Meta crops can be silently swallowed on a campaign that already
  has an ad of that format.** `computeDeterministicVideoDigest` includes
  `platformFormat` but NOT `deriveFromMaster`, so a derivative minted for
  `meta_feed_1_1` hashes identically to a **pre-existing billable**
  `meta_feed_1_1` video ad with the same (campaign, product, refs, CTA,
  prompts). `insertMany` swallows the duplicate-key error and the crop is
  simply not created — the operator keeps the older independent ad instead.
  Unlike the PMax keys, these three Meta formats have **history**: any earlier
  Advanced single-surface pick, and the measured 2026-08-01 multi-aspect Meta
  bug, minted them as real billable rows.
  **This is not a spend regression** — nothing new bills; the free extra is
  just absent. **Do NOT "fix" it by adding `deriveFromMaster` or a run id to
  the Meta digest:** that re-keys every pre-existing Meta video ad, and because
  the digest deliberately omits `generationRunId` the `(campaignId,
  identityDigest)` unique index is the ONLY guard against a repeat Generate
  re-billing Omni — the same trap §2 records for the 8s→10s duration change.
  A re-mint of the Meta video corpus is a costed, flagged decision, never a
  side effect. Related pre-existing hazard, unchanged by this work: a stranded
  `queued` historical row of one of those formats is still claimable by
  `selectAdsForRun` (product-scoped, not new-ad-scoped) and would bill on that
  claim.
  **AMENDED 2026-08-18 — one arm of this is now CLOSED, the main one is
  not.** The collision described above is against a **live** row and still
  swallows the crop; nothing there changed. What *did* change is the
  **archived** arm, which used to be permanent: once a never-billed crop was
  archived (by Stop or the 24h sweeper) its digest stayed occupied forever, so
  the identity could never be minted again by any future Generate. Archiving
  now releases the digest of a receipt-free / `renderUrl`-empty row (see the
  archive bullet above), so that arm self-heals. **This is still NOT licence
  to add `deriveFromMaster` or a run id to the Meta video digest** — that
  re-keys every pre-existing Meta video ad and re-opens the Omni re-bill, and
  the fix above deliberately does nothing to digest computation.

- ~~**PMax YouTube safe zones are DECLARED but NOT WIRED**~~ — **CLOSED Phase B
  (2026-08-11).** Zones resolve per `platformFormat`
  (`pmax_video_9_16`→`verticalYt`, `pmax_video_16_9`→`landscapeYt`,
  `pmax_video_1_1`→`squareYt`) and are threaded to the composition.
  `classifyFormat` still returns only the four **canvas** formats (see §4 trap)
  — zone selection is a separate concern. **Funnel preset 10s re-time was
  REVERTED** (shared generic presets; silently re-timed every brand's 8s
  renders — see §4 trap). Presets remain at **8s** extent. **Still open:**
  per-run funnel preset *selection* — `presetOverride` exists on the render
  path but no live caller supplies one; `buildMetaForAd` hardcodes `null`.
  PMax 10s pacing needs **separate** preset files selected with that path.
  See `docs/PIPELINES.md` §6.
- **No full end-to-end PMax kit has run through the app.** Offline suite
  **78/78** plus prompt-only live Atlas submits (measured unit costs above).
  First live app recipe: ONE product, brand with populated `summary`,
  `google_all` → 3 statics + 2 video masters + 1 derived 1:1 ≈ **$2.40**
  (3 concepts × statics + 2 masters; was planned ~$2.6). See `session.md`.
- **~1-in-3 static ads** render a competitor-shaped brand mark on the product
  (e.g. tree emblem reading as Timberland on an Allbirds shoe). Prompts already
  ask for fidelity — fix is measure-and-reject, not prompt tuning. **Video path
  is now QC'd too (2026-08-19)** — `adVisionQcService.runVideoPostRenderQc`,
  wired at the single choke point every video ad's `renderUrl` gets stamped
  through (`brandScriptExecutor.uploadRenderAndStamp` /
  `runVideoVisionQcForAd`). Samples 3 frames (quartile) from the delivered
  clip via the previously-unused `videoFrameService.buildFrameUrls` and
  compares them + the seed product photo in one vision call, same 4
  categories/model/PASS_FLOOR as static. Live-verified against the actual
  Bone Denim jacket rendered as light-blue denim with a garbled woven brand
  label (run `run_1787136860887_654ed621`) — caught both defects
  (`product_fidelity=0`, `competitor_marks=2`) — and against a known-good
  Allbirds video as a negative control (passed, 10/10/7/10). **Never
  regenerates and never fails the ad** (the master is already paid ~$0.90 and
  the defect is baked into the clip) — it flags via the same `Ad.visionQc` /
  `summarizeVisionQc` surfacing statics use, plus the full per-category detail
  now also posts to the run-feed Slack thread on PASS (not just FAIL — owner
  request 2026-08-19). See `session.d/2026-08-19_video-vision-qc.md`.
  **STILL OPEN after the 2026-08-03 prompt hardening — that
  hardening is owner-directed work on top of this note, NOT a fix for it, and it
  has no measured effect on this defect yet.** The static prompt now opens with a
  long `PRODUCT_FIDELITY` block (`staticAdIntents.js`) covering source-of-truth,
  category/brand-prior, form, construction, surface, colour, on-item graphics,
  details and condition — plus carve-outs in `absences` / `textBlock` so the
  no-added-text rules cannot erase the product's OWN printed label (they read
  literally as "strip marks from clothing/packaging in the scene", and on this
  catalog the product often IS the clothing or the packaging). **`adVisionQcService`
  remains the actual fix.** Reversible without a deploy via
  `STATIC_PROMPT_FIDELITY_HARDENING=false`, which restores a **byte-identical**
  pre-hardening prompt — block *and* both carve-out sites revert together, so the
  A/B control arm really is the arm that was measured. **The cost is real and
  unmeasured:** the prompt more than doubled (~3.5-4.1k → ~7.8-8.4k chars) and the
  block sits above `SET EXACTLY THESE STRINGS` on a path whose measured text
  fidelity is 139/140 strings across 20 renders, and where `quality:high` already
  measured WORSE than `medium` by losing a string. If the next render sample shows
  copy defects, suspect this before anything else and flip the flag. Precedent for
  that outcome: PR #61 hardened the VIDEO prompt and was rolled back in full
  (§00). Pinned by `scripts/verifyStaticFidelityPrompt.js` (419 checks, both arms,
  revert-proven on three mutations).
- **THE DIRECTOR NOW HAS A CROSS-PROVIDER FALLBACK CHAIN. Read this before
  touching `MAP.director` (2026-08-18, owner-directed after a ~20h total
  static outage).**
  **Measured live from the production service**, same `ATLAS_API_KEY`,
  sequential single calls, no concurrency:
  | slug | result |
  |---|---|
  | `anthropic/claude-sonnet-5` (the Director) | **HTTP 429 after ~51 SECONDS** |
  | `anthropic/claude-opus-5` | **429 after ~50s** |
  | `anthropic/claude-sonnet-4.5-20250929` | 429 after ~50s |
  | `anthropic/claude-sonnet-4.6` | 200, but **52s** |
  | `anthropic/claude-sonnet-5-ccmax` | 200 in 1.7s |
  | `openai/gpt-5.6-terra` | **200 in 1.0s** |
  | `google/gemini-2.5-pro` / `-flash` | 200 in 1.7s / 0.7s |
  Atlas is **capacity-starved on several DIRECT Anthropic routes**. It is NOT
  our payload (every shape 429'd, including one carrying an invalid
  temperature that should have 400'd first), NOT the model id (sonnet-5 is
  live in the catalog), NOT credit (other providers answer instantly on the
  same key), and NOT the temperature-400 — `rejectsSamplingParams` already
  covers that and still must.
  **WHY THE EXISTING FALLBACK DID NOT SAVE US, which is the real lesson:**
  `MAP.director.direct.provider` was `'anthropic'`, and `DIRECT_KEYS`
  (`atlasLlmService`) only knows `openai` (`OPENAI_API_KEY`) and `google`
  (`GEMINI_API_KEY`). **No Render service carries `ANTHROPIC_API_KEY`** (WEB
  24 vars, WORKER 15 — checked). So the Director's configured fallback was
  *structurally incapable of firing*, silently, while `layoutInputService`
  survived the same Atlas errors purely because ITS fallback is google. **A
  same-provider fallback is not a fallback when the provider is what is
  down.** A keyless direct twin is now a recorded `LLM_AUTH_MISSING` skip
  rather than silence.
  **The chain** (`MAP.director.chain`, owner order: *"fallback to Opus, then
  go to GPT5.6Terra"*): `anthropic/claude-sonnet-5` →
  `anthropic/claude-opus-5` → `openai/gpt-5.6-terra`. Opus is 429 today too
  and **stays in on purpose** — the chain exists so a starved link is skipped
  in ~50s, not so down models get deleted from the design.
  **Mechanism, and the constraint that shaped it:** `chain` is an OPT-IN field
  on a MAP entry, and `resolveChain(role)` returns exactly one link —
  `resolveModel(role)` — for every role that lacks it. The transport's loop
  over a one-element list *is* the pre-chain code, so "every other role is
  unchanged" is structural, not a claim. Pinned by
  `scripts/verifyDirectorFallbackChain.js` A2/C5.
  **Fail-fast numbers, justified against the measurements above:** non-final
  links get ONE Atlas attempt at `CHAIN_LINK_TIMEOUT_MS` (**75s**) — above the
  ~51s 429 so a starved link still resolves as a *definite, unbilled*
  rejection rather than an ambiguous timeout, and above the 52s slowest
  measured success so a slow-but-healthy primary is not abandoned. The final
  link keeps the full 120s. `CHAIN_BUDGET_MS` (210s) gates *starting* a
  request, never truncates one in flight. `CHAIN_MAX_ATTEMPTS` (**4**) bounds
  total upstream requests per call — for the Director exactly 3 Atlas links +
  1 OpenAI direct twin. **Worst case per Director round is 8 upstream
  requests** (the round's own corrective re-ask can invoke the transport
  twice).
  **What advances the chain: transport failures ONLY** — 429, 5xx, timeout,
  connection error, and the listed-but-unrouted 400 (`ADVANCES_CHAIN` in
  `services/llmError.js`). A 400/401/402/403 does **not** advance: it fails
  identically on the next candidate and would just buy the same answer at
  another model's price. **A 200 whose CONTENT is bad JSON must NEVER advance**
  — that is the one-shot corrective re-ask below, and advancing would multiply
  PAID calls for a prompt-compliance problem.
  ⚠️ **MONEY — a timeout is the ambiguous one and we advance anyway.** A 429 is
  a rejection before work began, so advancing costs nothing. A timeout does
  not prove the upstream stopped, so it may have billed tokens we never saw;
  advancing can pay twice for one round. Accepted **here only**, because this
  is a TEXT/LLM call billed per token (~$0.105 a round) against the certainty
  of ZERO ads, and it is bounded by `CHAIN_MAX_ATTEMPTS`. **This reasoning does
  not transfer.** The image/video submit rule above is unchanged: a billable
  POST is replayed only on structured proof of pre-work rejection
  (`isDefinite429` / `submitRetryDecision`). Nothing in the LLM chain touches it.
  **`ATLAS_MODEL_DIRECTOR` remains the zero-deploy emergency lever, and it WINS
  TOTALLY** — it collapses the chain to the one slug named, dropping the
  fallbacks. An operator reaching for it during an outage is naming what should
  run right now; silently appending two more paid candidates would make the
  lever unpredictable exactly when predictability is the point. Cost of that
  choice: an override pointed at a starved model reinstates the outage until it
  is changed again.
  **Known accepted fallback defect:** `gpt-5.6-terra` was the bake-off's
  ELIMINATED incumbent, specifically for putting the product name in copy
  against an explicit directive — which `validateDirectorPayload`'s
  `forbiddenStrings` scan catches. Expect more contract warnings and more
  corrective re-asks while it serves. Degraded output beats zero ads; the
  `director:fallback-served` Slack notice exists so nobody mistakes it for
  normal.
  **Sampling is deliberately asymmetric across the chain.** The Director asks
  for `DIRECTOR_ROUND_TEMP=0.45` (chosen for consistency). The two Claude 5
  links CANNOT honour it — Atlas bare-400s `temperature`/`top_p`/`top_k` on
  that family, so `rejectsSamplingParams` strips them and those links run at
  the model default. The OpenAI link DOES honour 0.45. **The fallback therefore
  runs more deterministically than the primary.** Stated here rather than
  discovered later.
- **Director round JSON is not enforced by the gateway (SEPARATE from the
  competitor-mark defect above).** The `director` role maps to
  `anthropic/claude-sonnet-5` — **the plain route, not `-ccmax`**; the
  `-ccmax` claim that used to sit here (with a stale `:98` line anchor) was
  superseded on 2026-08-04, see the ROUTE CHANGED note in
  `services/atlasModelMap.js`. Atlas
  **silently ignores** `response_format:{type:'json_object'}` for that model —
  probed live 2026-08-04, two arms (flag on / flag off), **both** returned
  conversational prose. Distinct from the already-documented fact that
  `json_schema` HTTP 400s for Anthropic; "use `json_object`" is now known to be
  **insufficient**. Measured from Render logs over 24h: **10 Director round
  failures, 1 success** — failures open with prose ("I don't have enough
  information…", "Before I generate…", "No AVOID block…", "Two inputs…",
  "A couple of things…"); each failure = a product with **zero ads** (paid
  Director call wasted). The round system prompt never independently demanded
  JSON, so compliance was luck; thin-signal SKUs reliably tipped the model into
  clarifying questions. The handler was asymmetric: schema-validation miss
  re-asked once, JSON parse failure threw with no salvage and no retry. **Code
  fix is applied in the working tree and offline-verified, but UNCOMMITTED and
  NOT deployed — do not claim production is fixed.** Fix: (a)
  `safeParseDirectorJSON` + `extractFirstBalancedObject` (string-aware
  balanced-brace salvage; mirrors `judgeService.safeParseJSON` but not greedy);
  (b) one-shot corrective re-ask that **shares** the existing `attempt` budget
  (worst case stays two paid Director calls per product/round); (c) `OUTPUT
  CONTRACT` block in the round system prompt naming the observed refusal
  openings and stating THIN DATA IS NOT A STOP. Pinned by
  `scripts/verifyDirectorJsonSalvage.js` (32 checks; revert-proven against three
  mutations: salvage removed → 28/32; unconditional throw → 30/32; OUTPUT
  CONTRACT deleted → 31/32).
  **Starved brief — FIXED (do not re-diagnose).** Separately from the JSON
  gateway issue, the Director input summary used to read fields that do not
  exist on the schemas: `brand.description` / `brand.logo` (neither on
  `brandSchema` — `models/Brand.js:31`; `description` is `demographicSchema`'s
  field at `:24`; real fields are `summary` `:47` and `logoUrl` `:48`) and
  `product.shortBenefits` (not on `CatalogProduct`, always `[]`). The round
  prompt told the model to pull from `brand_signal.tagline / description /
  brand_reviews_summary` and to null any ungrounded copy role — so copy came
  back empty while `dirWarnings=0` (the warning only fired when **all four**
  copy fields were null). Fixed: `brand_signal.description` ← `brand.summary`,
  `has_logo` ← `!!brand.logoUrl`, dead `shortBenefits` read dropped
  (`aiCreativeDirectorService.js:307-329`); warning on `copy.headline` alone
  null (`:1979-1983`); **`DIRECTOR_SIGNALS_VERSION` bumped `3.0.0 → 3.1.0`**
  (`:73`) so cached `CreativeDirectionArtifact` rows re-derive. Without the
  bump the brief fix is a no-op on every product that already has an artifact
  (cache-hit test is `cached.signalsVersion === DIRECTOR_SIGNALS_VERSION` at
  `:149` — same "looks right, silently does nothing" class as §0). Pinned by
  `scripts/verifyDirectorPrompt.js` (40 checks, section E).
- **Static `ai_brand_led` with zero cascade headline can still print a customer
  quote (known open — not "broken").** `INTENTS.brand_led` declares
  `rendersQuote:false` (owner: rating trust mark only, no quote —
  `staticAdIntents.js:544`). But with no headline from Director /
  `layoutInput.copy` / `brand.tagline`, `eligible` fails and `resolveIntent`
  walks `FALLBACK_ORDER` (`:565` / `:572-578`); if a rating exists the ad lands
  on `social_proof_led`, which **can** emit a customer quote. Documented
  deliberately rather than closed: the descent hierarchy is owner-specified,
  and a hollow brand-led ad is what `core:['BRAND LINE']` exists to prevent.
  Reachable only when all three headline tiers are absent. As of the
  rating-furniture fix that descent now demands a star-glyph widget rather
  than a paraphrased rating headline — still a quote-on-a-brand-led-template
  surprise, not a claim-without-proof one. Full write-up:
  `docs/PIPELINES.md` §5 *Brand-led intent + copy cascade*.
- **Static geometry — two defects FIXED 2026-08-03; read the diagnostic before
  re-opening.** (A) `staticAdIntents.computeSurface` combined the post-generation
  crop band with the 6% edge margin via `Math.max`, so on every *cropped* surface
  the margin collapsed to zero and the safe box handed to the image model *was*
  the crop line. Proof needing no model compliance: the composited logomark
  shipped **flush to the delivered frame edge** on Stories and 4:5 — inspectable
  in any ad delivered before the fix. (B) `GEN_SIZES` was stale (three sizes;
  the live schema enum has 14), so 9:16 generated at `1024x1536` and lost 80px per
  side. All **Meta** live static surfaces generate at exact delivery aspect —
  zero crop. **Phase A amendment (2026-08-10):** `GEN_SIZES` gained schema-enum
  `2048x1152` — frozen `pmax_16_9` now zero-crops (was 1536x1024 / 15.6% crop);
  live `pmax_landscape_1_91_1` crops ~6.9% from that plate (no exact 1.91:1 enum
  twin). Live PMax statics use **10%** edge margin via `SURFACE_EDGE_MARGIN_PCT`;
  Meta + frozen `pmax_16_9` stay 6%. Pinned by `scripts/verifyStaticSafeBox.js`.
  **DIAGNOSTIC, and it matters:** `meta_feed_1_1` was immune to *both* defects
  (zero crop, full 61px margin) and it is the **default** surface
  (`directImageRenderService.js:508,516`). So truncated copy on a **square** ad is
  *not* this bug class — it is the model disregarding the percentage box. Use the
  surface signature to split geometry from model non-compliance before re-opening
  size work.
  **Non-enum sizes need a live probe, not the schema prose.** The schema's
  "arbitrary resolutions divisible by 16" clause is spliced from OpenAI's docs and
  carries an unpublished pixel/edge-limit caveat. `1088x1360` (4:5) is in use only
  because it was probed; the risk being guarded is silent coercion to the
  `1024x1024` default, which would square a 4:5 surface and then crop it.
  `2048x1152` needed no probe — it is an enum member.
- **Static logo vs QC box — FLUSH-TO-BOX is a layout_safe_box fail (2026-08-24).** The mark is Sharp-composited (`finishPlate` → `logoPlacementFor`), not model-placed. Placement used to align the mark's right/bottom TO the QC-declared `safeBoxInDeliveredPx` (0px remaining on those edges on every live surface). Vision QC is handed those same numbers and treats on-the-line as a breach — 14 of 21 QC failures tonight, two-thirds of all static fails, at double cost (regen then still fail). The square `logoResizeBox` (#321) did not create a negative margin the 0.35-tall box lacked; it made stacked lockups ~2.8× taller so more ink sat on the line. Inset is 2% of the short edge (floor 8px); the square box is unchanged. Pinned by `scripts/verifyLogoSafeBox.js`. Full write-up: `session.d/2026-08-24_logo-safe-box-flush.md`. **Port to adgen** — adgen owns the live render path; this worktree does not.
- **PR #307's surface-aware titling bands NEVER FIRED on any render — fixed
  2026-08-24, do not re-diagnose the `layout_safe_box` QC failures as unfixed.**
  `bandsFor(safeZoneKey)` shipped correct and inert: both `brandScriptExecutor.js`
  `renderTitles({...})` call sites had `platformFormat` in scope and never
  computed a `safeZoneKey` from it, so `bandsFor` always got `undefined` and fell
  back to the pre-fix `BANDS` literal on every real render — the video-QC
  investigation's root cause was still live after #307 merged. Fixed by
  `resolveSafeZoneKeyCjs` (CJS mirror of `remotion/lib/safeZones.js`
  `resolveSafeZoneKey`, next to `SURFACE_INSETS` in `plateIntelService.js`),
  called once in `brandScriptExecutor.js` and forwarded to both call sites.
  New harness groups H/I/J in `scripts/verifyKeepOutBandGeometry.mjs` are what
  would have caught this — the original A-G groups test `bandsFor`/`bandRect`
  directly with hand-picked keys and stayed green the whole time the real call
  site supplied nothing. Full write-up:
  `session.d/2026-08-24_wire-safezonekey-titling.md`. **Same gap exists in
  adgen** (PR #54 ported #307's plumbing faithfully, inheriting it) — see that
  repo's own fix.
- **`queued` leftovers no longer sit forever.** Same-day drain is still an
  explicit `/runs` ("Generate more") claim. After `QUEUED_ARCHIVE_AFTER_H`
  (default 24) a leftover whose minting run is terminal moves to
  `status:'archived'` so a later Generate cannot claim and bill it.
  Receipt-holding / `renderUrl` / `renderAttempts > 0` rows are refused.
  **`renderAttempts` must mean actual render attempts, not polling** — a FREE
  derive-only video ad (`deriveFromMaster` set) that waits in-render for its
  master and requeues on expiry used to `$inc renderAttempts` on that requeue
  (`routes/ads.js` `renderDeriveOnlyVideoAd`), which made a wait-only ad that
  never submitted or billed anything look identical to one that had actually
  attempted and failed — permanently `renderAttempts > 0` and therefore
  permanently invisible to this sweeper. Fixed 2026-08-18: the wait/requeue
  loop and its `MAX_DERIVE_WAIT_ATTEMPTS` bound now count on a dedicated
  `deriveWaitAttempts` field (`models/Ad.js`); `renderAttempts` stays 0 for an
  ad that only ever waited. The sweeper's `renderAttempts:0` guard itself is
  unchanged — the fix is upstream, not a loosened guard.
  `CampaignRun.total` stays the claim count (progress denominator);
  `mintedTotal` / `unclaimedAtStart` / `notice.code='minted-ads-unclaimed'`
  are how the operator sees the gap. Sweep itself pinned by
  `scripts/verifyNoStrandedQueued.js` (52 checks, incl. C4b: a derive-wait ad
  with `deriveWaitAttempts > 0` / `renderAttempts:0` is still swept). The
  `deriveWaitAttempts` field + wait-loop wiring is pinned by
  `scripts/verifyPmaxVideoExpansion.js` (81 checks, group G).
  **Corollary (resource, not money — adversarial review, same day):**
  `services/strandedRunSweeper.js`'s `findStranded` re-drives ads a SIGTERM
  stranded in `'queued'` with a `renderStage` breadcrumb whose minting run
  went `'failed'`, bounded by `renderAttempts < STRANDED_SWEEP_MAX_ATTEMPTS`
  (3) — a wait-only derive ad used to age out of THAT filter too, accidentally,
  once the old `renderAttempts` inflation hit 3. Moving the counter to
  `deriveWaitAttempts` removed that accidental cap: each `requeueStrandedAds`
  re-pick mints a fresh `CampaignRun` without ever clearing the ORIGINAL
  failed run out of `campaignRunIds`, so the sweep would keep re-selecting the
  same ad every pass — up to `MAX_DERIVE_WAIT_ATTEMPTS` (30) submit-free wait
  cycles instead of the intended ~3, each holding a `VEO_CONCURRENCY` slot for
  up to `DERIVE_MASTER_WAIT_MS` (12 min). Fixed in the same change:
  `findStranded`'s ad filter (now the pure, exported `buildStrandedAdFilter`)
  also requires `deriveWaitAttempts < STRANDED_SWEEP_MAX_ATTEMPTS`. Pinned by
  `scripts/verifyStrandedSweep.js` group G (behavioural, against the real
  exported filter — not a stub).
  **ARCHIVING NOW RELEASES THE IDENTITY DIGEST, and that is a money
  invariant in its own right (2026-08-18).** `adSchema.index({campaignId,
  identityDigest},{unique:true})` is **not** partial — `partialFilterExpression`
  cannot express `status != 'archived'` — so an archived row used to squat its
  identity slot forever. Because the video digest deliberately omits
  `generationRunId` (that omission is THE guard against a repeat Generate
  re-billing a paid Omni master, above), a never-billed archived video identity
  could **never be re-minted**: `insertMany` hit 11000, swallowed it, and the
  ad was simply absent. Now every archive site goes through **one** helper,
  `services/adArchiveDigest.js` — imported, never re-implemented (same rule as
  `resolveDeriveFromMaster` / `receiptFree`, §4). It is an aggregation-pipeline
  `updateMany` so the tombstone is derived per row: `identityDigest` moves to
  the declared `Ad.preArchiveIdentityDigest` and is replaced by
  `archived:<_id>`, unique by construction. **The release is gated PER
  DOCUMENT on receipt-free + `renderUrl` empty.** That is the whole safety
  argument: the index exists to stop a **PAID** identity being re-bought, and a
  never-billed identity *should* be re-mintable. An archive of a delivered or
  receipt-holding ad (operator PATCH, `ad.archive`, `ad.bulkArchive`) still
  happens but **keeps its digest**, so paid identities stay protected. Restore
  (`PATCH` → draft/live, `ad.restore`, `purgeQueuedAds --restore`) hands the
  digest back; if a repeat Generate already took the freed slot the 11000
  surfaces as a **409** and the ad stays archived — never swallowed, because a
  restored `queued` row carrying a tombstone would be a fake identity on a
  claimable (billable) row.
  **THE BILLED-BUT-UNSTAMPED WINDOW IS THE HARD PART.** "Receipt-free" means
  "we hold no receipt", NOT "never billed" — providers charge at SUBMIT and the
  receipt is written after the POST returns, so a genuinely-billed ad is
  receipt-free for one HTTP round-trip (`spendReceipt.js` documents the same
  window for requeue). `renderAttempts` cannot close it: it is `$inc`'d when a
  render **ends**, not when it starts.
  ⚠️ **An earlier revision of this bullet claimed that window "is only reachable
  while `status:'rendering'`". THAT WAS FALSE and it was the load-bearing claim
  under the whole design** (caught in adversarial review, same day). Every
  `rendering`→`queued` **requeue** site moves exactly such a row out of
  `rendering` with no receipt wait: `worker.js`'s 15-minute reaper,
  `processAlerts`' SIGTERM orphan persist, `/generate`'s and `/runs`' crash
  handlers, `claimAdsForRun`'s CLAIM ANOMALY release, and `/generate`'s CAS-lost
  release — which **deliberately NULLs `renderStage`**. Post-requeue the row is
  `queued` + receipt-free + `renderAttempts:0` and looks pristine.
  So the guard is a **durable marker, `Ad.wasRendering`** (declared; written by
  each requeue site's own *awaited* write, never cleared). `renderStage` is
  **best-effort only** and must never be relied on alone —
  `services/adStage.js` is fire-and-forget *by contract* ("a stage can be
  missed under load"), so the breadcrumb can simply be absent. A never-claimed
  mint leftover never enters `rendering`, so the marker stays false and the
  fix's whole purpose survives. Separately, a row archived while **still**
  `rendering` also keeps its digest; the single exception is Stop's
  undispatched tail (`allowRenderingRelease: true`), whose ids come from
  `p.queue.slice(p.next)` — ads the loop provably never handed to a renderer.
  A second opt-in fails the harness — and Stop's tail is also the one archive
  that must NOT record the marker, because it is provably pre-dispatch.
  **ARCHIVING A `rendering` ROW RECORDS THE MARKER (added 2026-08-18, third
  pass).** Archiving erases the fact that a row was `rendering`, and
  `ad.restore` sends a `renderUrl`-less archived row back to **`queued`** —
  claimable and billable. So `rendering (billed, receipt not yet written) →
  archived (digest correctly kept) → restore → queued with no marker → sweeper
  archives → RELEASED` reopened the hole one step removed. The archive stage now
  stamps `wasRendering` when the INPUT row is `rendering`. Precise, not blanket:
  a `queued` mint leftover is never marked, so the digest release this all
  exists for is untouched.
  **WHICH REQUEUE SITES STAMP, AND WHY — the `REQUEUE_SITES` ledger in
  `services/adArchiveDigest.js` is the single source of truth; do not re-derive
  it.** Every requeue site spreads exactly one of two exported markers, so a
  verdict is never implied by omission (an omitted marker is indistinguishable
  from a forgotten one): `REQUEUE_MARK` = "a billable submit MAY sit behind
  this"; `PRE_DISPATCH` = "control flow PROVES none can". Four sites are
  exempt, each with a structural proof pinned by a harness check that fails the
  moment that site gains a reachable submit path — the CAS-lost release
  (`return`s before `await runRenderLoop`, E15a), `claimAdsForRun`'s anomaly
  release (that function contains no submit call at all, E15b), `/runs`' outer
  catch (`setImmediate(runRenderLoop)` is the LAST statement of the try, so no
  `await` follows and the catch cannot run after the loop began, E15c), and the
  derive wait-requeue (submit-free by contract, E15d). **Exempt only on proof;
  stamp whenever it is a judgement call** — over-marking squats an identity,
  under-marking re-buys a master, and that asymmetry governs. Exemptions are not
  free: marking a provably submit-free row makes the 24h sweeper keep its digest,
  silently undoing the release for exactly the never-billed rows it was written
  for. **Cross-pass safety** rests on induction: a row billed in an earlier pass
  can only reach a later claim by having been requeued out of `rendering` first,
  and every such path is in the ledger, so the marker is already set.
  **Accepted residuals, stated rather than papered over:** (i) rows requeued
  *before* this deploy carry no marker and fall back to `renderStage` alone — a
  historical sliver that shrinks to zero for new rows; (ii) **no backfill**:
  rows archived before this change still squat their digests. A second
  `PATCH → archived` heals one; a backfill script is future work.
  **THREE MORE CLAUSES ON THE GATE, each closing a hole adversarial review
  found — none is decoration.** (a) `wasRendering` false **and**
  `renderAttempts` 0 **and** `renderStage` empty: "receipt-free" cannot see a
  render that was BILLED and then *crashed* before the receipt was persisted,
  and a requeue site sends that row to `queued` so it reaches every archive
  site looking pristine. `renderAttempts` alone does not catch it (`$inc`'d
  when a render **ends**), and `renderStage` alone is best-effort telemetry —
  `wasRendering` is the durable one, written by each requeue site's own awaited
  write. Mint leftovers and claimed-but-undispatched rows carry none of the
  three, so the target population is unaffected.
  (b) `imageGeneration` must be null/absent **or an object**
  (`$type`): it is `Mixed`, and on a string or array parent
  `$imageGeneration.predictionId` resolves to *missing*, so a bare emptiness
  test would read a real static receipt as "no receipt" and free a paid
  identity. Deliberately stricter than `spendReceipt.js`'s query-side clause —
  this expression can only fail closed. (c) **A tombstone may never sit on a
  non-archived row.** The digest restore is a `$cond`, so an unconditional
  `status` flip beside it let a tombstoned row with an empty
  `preArchiveIdentityDigest` reach `queued` carrying `archived:<_id>` as its
  live identity — claimable and billable under a placeholder while the real
  identity stayed free to re-mint. The status flip now rides the *same*
  condition, and every restore surface reports the refusal
  (`restoreTookEffect`) instead of counting `modifiedCount` and claiming
  success. Pinned by `scripts/verifyArchiveDigestRelease.js` (70 checks,
  revert-proven on 25 mutations).
- **A LIVE RUN USED TO BE REAPED FOR BEING QUIET — `CampaignRun` now
  heartbeats (fixed 2026-08-18). Do NOT "simplify" the beat, and do NOT raise
  `REAP_STALE_MIN` to paper over a recurrence.** `CampaignRun.updatedAt` moved
  ONLY when an ad SETTLED (the per-ad `$inc {succeeded|failed|skipped}`,
  refreshed by `timestamps:true`), so the reaper's
  `{ status:'running', updatedAt: { $lt: now - REAP_STALE_MIN } }` predicate
  meant "an ad settled recently", not "this run is alive".
  **MEASURED: `run_1787105727540_e8c94542`** — one product, Meta + PMax
  "Everything", 39 claimed. `startedAt` 02:15:27Z; 18 statics settled by ~02:21;
  video titling then ran with **zero** writes to the run row; at **02:36:29Z**
  the reaper stamped it `failed` with `succeeded 18 · failed 0 · skipped 0 ·
  total 39 · errors: []` — nothing threw, it was still rendering. In the same
  tick the **Ad** sweep flipped the run's claimed-but-**undispatched** tail
  back to `queued` on the identical silence — **9** rows (the 4:5 derive +
  staged Meta funnel variants), stranded permanently. The operator paid for the
  masters and got **30 of 39** creatives. *(That those 9 are the undispatched
  tail is inference from two facts, not a direct observation: the count matches
  `21 video rows − VEO_CONCURRENCY 12 in flight = 9` exactly, and the only
  other path that parks a video row in `queued` — `renderDeriveOnlyVideoAd`'s
  polite wait-requeue — `$inc`s `skipped`, which the run's `skipped: 0` rules
  out. It matters because it decides the recovery verdict below.)* Newly likely because video is 10s on both platforms and Meta+PMax
  share ONE 9:16 master, so 15 of 21 video rows queue behind one plate and
  titling serialises behind `REMOTION_QUEUE_CONCURRENCY` (4) — long silent
  stretches are now the NORMAL shape of a mixed run.
  **`services/campaignRunHeartbeat.js`** is the fix: a ~60s ticker started in
  `runRenderLoop`, writing `$set: { updatedAt, lastHeartbeatAt }` to
  `{ _id, status:'running' }` and **nothing else** — never `total` (the claim
  count and the progress denominator), never the outcome counters. It also
  beats the run's still-`rendering` ads with the SAME shared builders the
  loop's per-completion write uses, which is what saves the undispatched tail
  and closes a real double-bill (an ad reaped to `queued` while still sitting
  in the live in-memory pool is claimable by a concurrent `selectAdsForRun`,
  and `renderOneInner` has no status guard, so both runs would submit it).
  **Four things are load-bearing:** (a) the beat is **gated on real in-flight
  work** (`pools.some(p => p.inflight > 0)`) — an unconditional tick would
  defeat the reaper and resurrect the wedged-run-lives-forever class it exists
  to kill, and the timer dies with the process so a replaced instance cannot
  beat at all; (b) **`RUN_HEARTBEAT_MAX_MS` (4h) caps the total beat lifetime**,
  because `inflight` is decremented in `renderOne`'s `.finally` and a
  `renderOne` that NEVER settles would otherwise report work forever and make
  the run immortal — strictly worse than pre-heartbeat, since the Ad arm would
  also hold the claimed `rendering` set out of the Ad reaper's reach. 4h is
  `progressService.MAX_RUN_MS`, the cap already on the SAME run's `ad-batch`
  `OperationRun`; two heartbeats for one run must not disagree. **This was
  missing from the first design and adversarial review caught it — do not
  remove it.** (c) `runHeartbeat.stop()` sits in **both** the `catch` and the
  `finally` around the pool drain (idempotent), plus `unref()`; the `catch` is
  dead today (the drain's promises are individually `.catch`'d so `Promise.all`
  cannot reject) and is kept as an edit guard, which the comment says outright.
  (d) the interval is derived from the **ONE** shared parser
  (`services/staleness.reapStaleMin`, PR #207 — do not add a third), capped at
  60s and divided so ≥5 beats fit inside the window: 15 consecutive missed
  writes at the documented default. ⚠️ The 5s spin-guard floor and that divisor
  **conflict below a ~25s window** (`REAP_STALE_MIN < ~0.42`) — documented and
  pinned as a boundary, not claimed away; the hard-60s Ad beat is already
  hopeless at such a setting. `REAP_STALE_MIN` stays **15** — it is the
  claimed-doc window and raising it delays orphan requeue for every Ad and
  every running run.
  The running-reap predicate moved out of `worker.js` into the exported
  `buildStaleRunningFilter` (`services/campaignRunGuards.js`) so the harness
  evaluates the REAL filter. `CampaignRun.lastHeartbeatAt` is **declared** —
  strict schema, an undeclared path is dropped in silence. **Read it correctly:**
  a beat writes it and `updatedAt` at the SAME instant, so on a beating run they
  are always ~equal and only a *settlement* moves `updatedAt` alone. Fresh
  `lastHeartbeatAt` = the loop is alive with work in flight; stale/null while
  `running` = nothing in flight or the process is gone. Whether work is
  **settling** is `succeeded+failed+skipped` vs `total`, never a date gap. (The
  first draft asserted the inverse in four files; adversarial review caught it.)
  Pinned by `scripts/verifyCampaignRunHeartbeat.js` (40 checks, offline,
  revert-proven on 14 mutations). **Known honest consequence, not re-tuned:**
  `ALERT_RUN_SILENCE_MIN` (12m on `updatedAt`) can no longer fire for a run
  whose pool is busy — same shape `ALERT_RENDERING_STALE_MIN` has had since the
  Ad beat shipped. See `docs/ALERTING.md`.
  **CLOSED 2026-08-19 — the undispatched tail is no longer permanently
  invisible to `services/strandedRunSweeper.js`.** This bullet used to say the
  9 already-stranded rows do NOT qualify for that sweeper because its
  `renderStage` breadcrumb requirement (`{ $nin: [null, ''] }`) — the one
  signal separating "a deploy killed this" from "an operator has not pressed
  go yet" — is exactly what a claimed-but-never-dispatched ad lacks, since
  `adStage()` only writes from inside a render attempt, never at claim time.
  Measured across 14 real runs: 46 of 307 claimed ads (15%) sat exactly like
  that. **The sweeper's filter is UNCHANGED and must stay that way** — the fix
  is upstream, at the four REQUEUE_MARK sites (`worker.js` reaper,
  `processAlerts.js` SIGTERM, both `/generate`/`/runs` crash catches in
  `routes/ads.js`), which now call `buildRequeuePipeline`
  (`services/adArchiveDigest.js`) instead of a bare `...REQUEUE_MARK` spread —
  it stamps the same `wasRendering: true` marker PLUS an honest renderStage
  breadcrumb whenever the row does not already have one, so the sweeper picks
  it up on its own next tick with zero code changes to the sweeper itself. An
  ad that already began rendering keeps its real, more specific stage — the
  breadcrumb is `$cond`-guarded on "no stage yet", never a blind overwrite.
  Pinned by `scripts/verifyArchiveDigestRelease.js` E16/E16a (behavioral +
  per-site structural proof) and the widened `scripts/verifyReceiptAwareRequeue.js`
  W/P/X1 scan (which needed teaching to recognize the new call shape — see that
  file's `adRequeueBlock` header). Full incident narrative, the 9 real rows
  measured in `run_1787136860887_654ed621`, and what remains open:
  `session.d/2026-08-19_undispatched-tail-fix-stranded-ads-close-the-loop.md`.
- **Stop parks the stopping RUN's own tail — not the campaign's
  (fixed 2026-08-18).** `routes/ads.js` ran
  `Ad.updateMany({ campaignId: run.campaignId, status:'queued' }, …archive…)`
  and the comment above it asserted campaign-wide was intentional. It was a
  bug (owner-ruled): a campaign is not a run, other runs mint rows that sit
  `queued` awaiting their own claim, and `expandWizardJob` deliberately mints
  more than a run claims so "Generate more" can drain the rest — Stopping run A
  destroyed run B's pending work and every mint leftover on the campaign. Both
  Stop writes are now built by pure exported filters
  (`buildStopBacklogArchiveFilter` / `buildStopUndispatchedArchiveFilter` in
  `services/adArchiveDigest.js`, so a harness evaluates the REAL query).
  **Ownership is `campaignRunIds`** — the minting run is stamped there at
  insert by `mintedCampaignRunIds(generationRunId)` and the claim `$addToSet`s
  the claiming run. There is **no persisted `generationRunId` field on Ad**;
  it is a digest input and the source of `campaignRunIds[0]`, nothing more —
  do not write a filter against it. Missing `runId` **fails closed**
  (`{campaignRunIds: undefined}` is stripped by the driver, leaving
  `{status:'queued'}` = every queued ad in the database). Both writes also
  re-assert `receiptFree()` + `renderUrl` empty; a receipt-holding row is
  deliberately left in `rendering` so `bootRecoveryService` can still collect
  the master we paid for.
- ~~**`veoPredictionId` is a spend receipt that is never resumed**~~ — **CLOSED
  2026-08-04** (PRs #70-#72 + the titling resume). The receipt is now polled for
  free and the paid master collected: `services/bootRecoveryService.js` sweeps
  ads stranded in `rendering` that hold a receipt, and every requeue site is
  receipt-aware via `services/spendReceipt.js`. Do not re-open this as a bug.
  **What replaced it, and it is a DIFFERENT invariant — see §2 below:** a
  recovered master must be TITLED, and must never be requeued to get there.
- **A RECOVERED MASTER MUST NEVER BE REQUEUED — `status:'queued'` costs ~$0.75.**
  This reads as the obvious way to "finish" a recovered ad and it is a
  double-charge. `routes/ads.js:1342` declares `veoVideoUrl` **fresh** every
  render and the path **never reads `ad.veoVideoUrl`**, so `if (!veoVideoUrl)`
  (`:1367`) is TRUE for an ad that already holds a paid master — it falls
  straight into `veoGenerateForAd` and submits to Omni a second time. Titling is
  therefore resumed **titling-only** by `services/titlingResumeService.js`
  (claim → `renderBrandScriptAndSave`), never by re-entering the render queue.
  Pinned by `scripts/verifyTitlingResume.js` **T6** (neither service may contain
  `status: 'queued'`) and **T10** (the sweeper may not even require
  `atlasVideoService`, so it is structurally incapable of spending).
- **Titling resume is WEB-ONLY and that is not arbitrary.** Remotion is warmed in
  `index.js`; `worker.js` has **zero** remotion references. So the worker
  recovers the asset (`bootRecoveryService`) and the web process titles it
  (`titlingResumeService`, on an interval with a re-entrancy guard).
- **Titling resume stands down when adgen owns rendering.** Same helper as the
  render-loop handoff (`adgenBridge.isAdgenRendererEnabled`, call-time). Missing
  or malformed ⇒ this repo still sweeps (adgen only claims on `'true'`; dual-none
  would strand a paid master). Gate is inside `resumeUntitledMasters`, not the
  interval, so an in-flight pass finishes and a dashboard flip needs no redeploy.
  Pinned by `scripts/verifyTitlingResumeAdgenGate.js`.
- **The resume state lives on `Ad.titlingResumeState` — NEVER on `renderStage`,
  and this was got wrong once.** The first design parked the sentinel in
  `renderStage`, reasoning that reusing an existing field dodges the
  Mongoose-strict trap where a write to an **undeclared** path is silently
  dropped (this repo already lost `renderError.predictionId` that way).
  Adversarial review killed it: **`renderStage` is OWNED by
  `services/adStage.js`**, which `$set`s it unconditionally (`adStage.js:82-85`)
  and is called throughout titling (`brandScriptExecutor.js:1200`, `:1306`,
  `:1332`). The sentinel was therefore clobbered seconds into the render, so an
  ad whose render crashed could never be re-swept — the exact leak the resume
  exists to close. The trap is about *undeclared* paths; **declaring** the field
  (`models/Ad.js`, `enum:['pending','claimed',null]`) removes it. `renderStage`
  is still written alongside as a human breadcrumb, but nothing queries it.
  `scripts/verifyTitlingResume.js` **G1/G2** forbid keying any query or claim
  filter on `renderStage`, and **G3** asserts the schema declaration exists — so
  neither half of that mistake can come back.
  **Corollary worth knowing:** the same mid-titling crash leaves the identical
  orphan on the NORMAL render path today (`routes/ads.js:1437-1460` stamps
  `draft` + `renderUrl` *before* titling at `:1477`), and no sweeper catches that
  either, because they all key on `status:'rendering'`. Pre-existing, still open,
  not introduced here.
- Meta preview chrome can show placeholder **"Lorem ipsum dolor sit amet"**.

---

## 3. Verified external facts (2026-07-29)

Full detail in `docs/ATLAS.md` §7 and `docs/CLOUDINARY-VIDEO.md`. Headlines:

- **720p and 1080p are the same list price** on Omni. Atlas readme, verbatim: *"720p
  and 1080p are identically priced."* Formula `(4k ? $1 : $0.2) + duration × $0.1`.
  Hence `ATLAS_VIDEO_RESOLUTION=1080p` — no price increase, and it matches every
  `deliveryDims` in `platformFormats.js` (all 1080-wide). 4k is the only tier that
  costs more. **Not** free in render time: Remotion/ffmpeg handle 2.25× the pixels per
  frame, and that has not been measured.
- **Prompt caps.** Omni i2v/r2v: **20,000 characters** (README param table + schema
  description agree). Grok Imagine: **no limit found** in the Atlas README, the Atlas
  schema, or xAI's own docs — our 4096 is product policy, not a published cap. Veo
  3.1: Atlas silent; Google documents **1,024 tokens**, so our 4096-*byte* cap is
  unit-mismatched (moot, Veo is not selectable). Image models: no published max.
- **No image or video generation endpoint supports a system prompt.** All seven
  schemas fetched take a single flat `prompt` (+ `negative_prompt` on Veo only).
  System/user pairs exist **only** at the LLM layer.
- **Cloudinary video: no face gravity.** `g_face` → *"Gravity face not supported for
  video"*. `g_xy_center` → *"not supported for video"*. `fl_relative` on a base asset →
  *"resize marked as relative but not performed on a layer"* (layers only). `g_auto`
  works but is **async**: first request per asset returns **423 `Video tracking-crop is
  pending`**; later variants on that asset resolved in ≤5s. Explicit `c_crop` in pixels
  is synchronous and exact. All probed on **one account, one asset** — see
  `docs/CLOUDINARY-VIDEO.md` for what is measured vs inferred, which matters here.

---

## 4. Repo traps

- **`node_modules` is gitignored but thousands of files are tracked** (added before
  the ignore rule). The vendored tree is **incomplete**: `https-proxy-agent` is
  absent, and requiring any service that pulls in axios can throw
  `MODULE_NOT_FOUND` (observed via `scripts/verifySubmitGuard.js` →
  `atlasVideoService` → axios). Restore with
  `npm install --no-save https-proxy-agent@5.0.1`, then
  `git checkout -- node_modules/.package-lock.json` so the tracked file is not
  committed. Stage explicit paths, never `git add -A`.
- **`resolveDeriveFromMaster` is defined ONCE and imported — never re-implemented
  per caller.** Lives in `services/campaignAdsGenerationService.js`; both
  `routes/ads.js` (render loop, before any Omni submit) and
  `services/adRegenerateService.js` (preflight → 409) import it. A per-caller
  copy is **exactly** how the regenerate hole opened in Phase A: regenerate
  called `veoService.generateForAd` unconditionally on a PMax 1:1 and billed a
  full Omni generation on the free surface. Fail-closed on
  `platformFormat === 'pmax_video_1_1'` so a dropped `deriveFromMaster` field
  cannot re-open spend. Pinned by `scripts/verifyPmaxVideoExpansion.js` (gate
  defined once; zero billable submit calls inside `renderDeriveOnlyVideoAd`).
- **`config/defaults.env` is committed** and `dotenv`-loaded at boot. It is the real
  source of non-secret defaults — `.env.example` is documentation only and several
  vars there are blank while `defaults.env` sets them. **Secrets stay in the
  Render dashboard only** (migration COMPLETE 2026-08-03 — see §4a). Precedence:
  process env wins; a dashboard var of the same name **always shadows** the file.
- **`absences` `rendersSubhead` polarity.** The condition at
  `staticAdIntents.js:412` is `rendersSubhead && (!d.subhead || lost('SUBHEAD'))`.
  It **MUST** lead with `rendersSubhead` — only `brand_led` declares that flag,
  so every other intent stays `undefined`/falsy and its prompt is unchanged.
  Flipping to `!rendersSubhead || …` silently adds an absence line to **every**
  existing prompt and breaks the flag-off byte-identity baseline. Pinned by
  `verifyStaticIntents.js` E6 (additive-safety: no non-`brand_led` prompt
  contains "subhead"). Same trap class as §0.
- **`DIRECTOR_SIGNALS_VERSION` bump is load-bearing on any brief fix.** Cache-hit
  test is `cached.signalsVersion === DIRECTOR_SIGNALS_VERSION`
  (`aiCreativeDirectorService.js:149`). A code fix that feeds better brand /
  product signal **without** bumping the version leaves every product that
  already has a `CreativeDirectionArtifact` serving concepts built from the old
  brief — the fix looks deployed and is a no-op. Current value **`3.3.0`**
  (Phase B PMax funnel + proof hierarchy). Prior bumps: `3.0.0→3.1.0`
  starved-brief (`summary` / `logoUrl`); `3.1.0→3.2.0` social-proof menu.
  Any future signal-shape change needs the same bump.
- **PMax Director hierarchy PRECEDENCE SENTENCE — do not delete or "harmonise".**
  The shared DR block still says "≥4.5 from ≥50" (Meta-tuned, deliberately
  untouched). The PMax-only social-proof hierarchy block uses env-interpolated
  thresholds (`PMAX_PROOF_STRONG_RATING=4.5`, `PMAX_PROOF_MIN_REVIEW_COUNT=100`)
  and states explicitly that **it wins for this destination on any disagreement
  including thresholds**. Deleting that sentence, or editing the shared DR text
  to match, either re-opens dual-threshold confusion or **changes the Meta
  prompt**. Measured: Meta round prompt is byte-identical. See
  `docs/PIPELINES.md` §6 *Director: funnel spread*.
- **`classifyFormat` must keep returning canvas formats only**
  (`vertical|square|landscape|feed`). That string is also the **composition id**
  and the **`titleStyleSpec` cascade key**. Returning a YouTube zone name from
  it would break the render and silently change every spec lookup. Zone
  selection is a separate platformFormat-aware path (Phase B wired).
- **Do not re-time a SHARED funnel preset for PMax.** `canonical-awareness` /
  `consideration` / `conversion` are generic (`brand.titleStylePreset` Tier 2 +
  `retitleDriver --preset=`). Phase B re-authored them for 10s plates; because
  `specTimeScale` only compresses, every existing **8s** render using those
  presets dropped 1.0 → **0.8** with no crash and no failing test. **Reverted
  to 8s extent.** PMax 10s pacing must be **separate preset files** selected
  with per-run `presetOverride` (still open). See `docs/PIPELINES.md` §6.
- **`ROUTING_NESTED_FIELDS` registration is the scanner's coverage list, not a
  free-form enum.** `verifyConceptContract.js` only flags flat reads of
  *registered* names. Phase B added `routing.funnel_stage` without registering
  it → the new field silently lacked the guardrail that exists because reading
  these flat once produced zero ads. Registered + **R0b** pins load-bearing
  names (`media_picks`, `creative_style`, `output_shape`, `funnel_stage`) stay
  on the list — removing a name previously failed nothing (shorter iterate).
- **`PMAX_PROOF_*` blank env is 0, not NaN.** `Number('') === 0`. A cleared
  Render dashboard value would inject "strong rating ≥ 0" into the Director
  hierarchy and invert it. Parser falls back on blank/whitespace/negative.
- **`brand.logo` IS CORRECT on a `layoutInput.brand` object and WRONG on a Mongoose
  Brand doc. Check which object you are holding before "fixing" either.** The two
  are different shapes with overlapping names, which is how the Director bug hid.
  `layoutInputService.js:2227` builds `layoutInput.brand.logo` **from**
  `brand.logoUrl`, so `brand.logo` is a real field on that projection — and
  `aiCanvasInputBuilder.js:133/329/330` read it legitimately, because `:37` is
  `const brand = layoutInput.brand || {}`. `ALLOWED_SLOTS`
  (`aiCanvasSpecService.js:115`) and the prompt text at `:555`/`:749` are
  slot-binding **contract paths** and context-object **key names**, not property
  reads — renaming any of them breaks the binding contract. A Mongoose Brand doc
  has only `logoUrl` / `summary`. Both directions are pinned by
  `scripts/verifyBrandFieldNames.js` (17 checks): Group B forbids
  `brandDoc.description` / `brandDoc.logo`, and **Group D asserts the layoutInput
  usages still exist**, so an over-eager cleanup fails the harness. Group B is
  deliberately scoped to the variable name `brandDoc` — a bare `brand` is
  ambiguous repo-wide, and a check that cannot tell the two apart would have to
  allowlist half the services.
- **`.select()` of a field that does not exist is SILENT.** Mongoose neither throws
  nor warns; the path is simply absent on the result, so the read downstream is
  `undefined` forever. `aiCanvasInputBuilder` did
  `.select('description tagline brandReviews tone')` on Brand — `description` is
  not a brandSchema field, so the rich-context `description` key handed to the
  canvas Generator was permanently empty. Same defect as the Director's
  `brand?.description`, one layer earlier. Group A of
  `verifyBrandFieldNames.js` parses the real top-level `brandSchema` keys out of
  `models/Brand.js` (58 today) and asserts every `Brand.find*().select(…)` path in
  `services/` + `routes/` is one of them — it is the general form of this trap, so
  prefer extending it over adding a one-off string check.
  **SECOND LIVE INSTANCE, caught by Group A and fixed 2026-08-10 — the harness
  paid for itself.** `catalogSyncFromShopifyPublic` and
  `catalogSyncFromGenericSitemap` both did `.select('… shopifyUrl')`. **There is
  no top-level `shopifyUrl` on brandSchema** — it exists only as
  `apifyDemo.shopifyUrl`, and it is a *separate field from `websiteUrl`* exactly
  because a brand's catalog can live on a different host from its marketing site.
  Two compounding faults: the projection named a nonexistent path AND never
  selected `apifyDemo`, and that projected doc is handed straight to
  `syncBrandShopifyDirect` / `syncBrandGenericCatalog` — whose own
  `resolveStoreOrigin(brand)` (`brand?.apifyDemo?.shopifyUrl || …`) then fell
  through to `websiteUrl`. **So the bad projection propagated past the executor
  into the real scrape: the wrong host was pulled, silently.** Both executors also
  re-implemented the cascade locally as `brand.shopifyUrl || brand.websiteUrl`
  (two tiers, missing the one that matters); they now call the shared
  `resolveStoreOrigin`, so a preview cannot advertise one store and scrape
  another. A brand with a catalog URL but no `websiteUrl` was also falsely
  refused. **Lesson generalised: when an executor projects a doc it then PASSES
  DOWN, the projection must satisfy the callee's field reads, not just its own** —
  and prefer the shared resolver over a re-implemented cascade. The stale header
  claiming "Requires Brand.shopifyUrl" is why this looked right to three readers.
- **THIRD instance of the same family, fixed 2026-08-18 — `resolveStoreOrigin` reads
  `apifyDemo.shopifyUrl`, but nothing ever wrote it BACK onto `websiteUrl`.**
  `syncBrandShopifyDirect` / `syncBrandGenericCatalog` / legacy `syncBrandShopify`
  all successfully scrape a catalog using `apifyDemo.shopifyUrl` and never touch
  `Brand.websiteUrl` — the field `brandEnrichmentService`, `brandLogoIngestService`
  and `brandFontIngestService` all gate on. Confirmed victims (all demo brands, all
  had `apifyDemo.shopifyUrl` set the whole time): Marine Layer (2446 products),
  Marine Layer 2 (2295), GymShark (207), Peloton, PB5Star, Soludos 2, Fanatics,
  Fellow Products, livingspaces, Ubeauty — 10 total, fully backfilled + re-enriched
  2026-08-18. Fixed by `services/brandWebsiteBackfill.js` — a shared
  `backfillBrandWebsiteUrl()` called from all three ingest writers once
  `products.length > 0` (never merely because a config field holds a string).
  **Its `safeWebsiteOrigin()` denylist matters as much as the write itself:**
  GymShark's own `CatalogProduct.productUrl` rows are minted against
  `gymsharkusa.myshopify.com` (the headless-store EFFECTIVE BACKEND
  `shopifyPublicIngestService` substitutes for the custom domain — see
  `access.origin` in that file), so a naive "take the origin of any known URL"
  rule would have back-filled `websiteUrl` with the wrong host and pointed every
  future logo/font/GPT scrape at Shopify's backend instead of `www.gymshark.com`.
  The fix reads `origin` **before** that override. Also newly closed: enrichment
  used to be a genuinely SILENT no-op on missing `websiteUrl` — `enrichBrandFromUrl`'s
  `{ok:false, reason:'no websiteUrl'}` was discarded by every fire-and-forget
  caller, so nothing was ever recorded anywhere. Now persisted on the Brand doc
  (`enrichmentSkipReason` / `enrichmentSkippedAt`), cleared the moment enrichment
  actually proceeds. **`safeWebsiteOrigin()` also blocks SSRF targets, added
  2026-08-19 in review** — the CDN denylist stops the wrong-host case, but a
  candidate can come from SCRAPED `productUrl` data and is then fetched
  verbatim by three services, so it also rejects private/loopback/link-local
  IPs (127/8, 10/8, 172.16/12, 192.168/16, 169.254/16 — where cloud metadata
  lives — plus IPv6 equivalents and IPv4-mapped forms) and non-http(s)
  schemes. Full writeup + revert-proof: `session.md` 2026-08-18/19,
  `scripts/verifyBrandWebsiteBackfill.js` (37 checks).
- **Gate a provider tier on the PRIMARY key, never the fallback.** `wantGpt`
  (`brandEnrichmentService.js`) gated on `OPENAI_API_KEY` while the call itself goes
  through `atlasLlmService.chatCompletion`, whose primary is Atlas and whose direct
  providers are only a fallback. After the move to Atlas, a deployment holding just
  Atlas credentials **silently skipped the whole GPT enrichment tier** — and that
  tier's `ENRICHMENT_SCHEMA` owns tagline, summary, tone, hashtags, tags,
  demographics, colours and fontSuggestion. `summary` has **no other automated
  writer**, and `brand_signal.description` in the Director brief reads exactly that
  field, so the starved brief had a starved *source*. Now
  `(atlasLlmConfigured() || !!process.env.OPENAI_API_KEY)`. **Not the same as
  `wantBrandReviews`:** `geminiSearchProvider` calls Google's grounded-search
  endpoint directly with `GEMINI_API_KEY` and is deliberately *not* behind
  `atlasLlmService` for its GROUNDED calls — Atlas genuinely cannot proxy
  grounded retrieval, now PROVEN rather than asserted, see the dated bullet
  below — so gating that tier on its own key is correct. Before "fixing" a
  key gate, read which client the tier actually calls.
- **THE LAST DIRECT-GEMINI PATH, SWEPT AND PARTIALLY REWIRED (2026-08-19).**
  A 24h CostLog slice showed one direct-`GEMINI_API_KEY` path left:
  `provider=gemini, model=gemini-2.5-flash, stage=brand_reviews`. It turned
  out to be TWO calls sharing a stage name — pass 1 (grounded Google Search
  retrieval) and pass 2 (plain narrative→JSON structuring, never grounded) —
  and the fix treats them differently, on purpose.
  **Grounding is PROVEN unavailable on Atlas, not merely asserted.** Four
  live, single-shot probes against `POST
  https://api.atlascloud.ai/v1/chat/completions`,
  `model: 'google/gemini-2.5-flash'`: (1) plain call, no tools → 200,
  answers "I cannot determine today's date without a live tool" — confirms
  no grounding by default, even though Atlas demonstrably calls the real
  Gemini backend (`usage.billing_usage.gemini_usage_metadata.source ===
  'gemini_chat'`); (2) Gemini's own native `tools: [{ google_search: {} }]`
  → **HTTP 400** `{"code":400,"msg":"bad request"}`; (3) OpenAI's newer
  built-in `tools: [{ type: 'web_search' }]` → also **HTTP 400**; (4)
  top-level `web_search: true` (mirroring the convention Atlas documents for
  `bytedance/seedance-2.0` VIDEO, in case an LLM model shared it) → 200 but
  **SILENTLY IGNORED** (`toolUsePromptTokenCount: 0`, identical
  no-real-time-access answer). The model catalog lists no customer-reachable
  surface beyond `openai.chat.completions` for this model either — the
  `gemini.generate` protocol tag it also carries is not a documented or
  reachable endpoint (three guessed URLs for it all 404'd live). Full
  evidence lives in the **ATLAS GROUNDING PROBE** comment in
  `services/providers/geminiSearchProvider.js`, above `MODEL`/`ENDPOINT`.
  **So pass 1 (and `match()`, and `lookupBrandCategoryUrl` before it was
  deleted, and `categoryReviewsService` / `productDetailsService.
  fetchReviewSummary`, still open) correctly stay on the direct key — do
  not "fix" this without a FRESH live probe, Atlas's catalog changes.**
  **Pass 2 has no such restriction and is now Atlas-routed** —
  `atlasLlmService.chatCompletion`, role `gemini-2.5-flash` → Atlas
  `google/gemini-2.5-flash` (same model as pass 1, deliberately — see the
  model-choice comment on `structureReviewNarrative`; pricing is identical
  either way, verified live against `GET /api/v1/models`, so there is no
  cost argument for a cheaper/different model here). **Measured live, one
  real call (Allbirds brand reviews):** pass 1 stayed
  `provider:'gemini'`, `$0.037357`; pass 2 flipped to `provider:'atlas',
  model:'google/gemini-2.5-flash'`, `$0.009403`. **Honest sizing, from a
  real 7-day CostLog query, so this is not oversold:** pass 2 is only
  **4.5%** of direct-gemini spend in that window ($0.0548 of $1.2072 over
  7 days, 28 of 59 calls) — the fix is real and correctly scoped, but it is
  an architecture/observability win (one fewer direct-key dependency, and
  `match()` — below — closing a real blind spot), not a meaningful dollar
  saving; pass 1's grounding requirement is the overwhelming majority of
  the spend and cannot move.
  **`geminiSearchProvider.match()` (every UGC/IG detect with a key) was
  billing Google and writing ZERO CostLog rows — now ledgered** (routed
  through the same `trackedGenerate` helper as brand/product reviews pass
  1, stage `gemini_product_match`), staying on the direct key because it
  is also genuinely grounded. Measured live: one real call, `$0.038263`,
  now visible where before it was invisible spend.
  **`lookupBrandCategoryUrl` DELETED, not rewired** — confirmed dead (its
  only caller, `productMatchService.tryLookupBrandCategoryUrl`, itself had
  zero call sites anywhere in the codebase); category breadcrumbs go
  through `productCategory.enrichProductCategory` instead.
  **THAT REMAINING GAP IS CLOSED (2026-08-19, second pass).**
  `categoryReviewsService` and `productDetailsService.fetchReviewSummary`
  were the last two direct, unledgered `generativelanguage` POSTs. Both are
  genuinely grounded, so — like `match()` — the fix was "wrap in a ledgered
  transport", NOT "move to Atlas". `trackedGenerate` is now **exported** and
  is the ONE transport behind all four grounded stages
  (`brand_reviews`, `product_reviews`, `category_reviews`,
  `product_review_summary`, plus `gemini_product_match`); both files also
  dropped their own copies of the REST URL and of
  `GEMINI_SEARCH_MODEL || 'gemini-2.5-flash'`, so a row's `model` and the
  same call's error-log `model` can no longer disagree.
  `categoryReviewsService`'s pass 2 (never grounded) moved to Atlas as a
  SIBLING of `structureReviewNarrative`, not a call into it: that one asks
  for a `ratings[]` array and nulls the scalar `rating` when it fills it,
  while this path reads only `parsed.rating` — reusing it would have nulled
  the star rating on every category. **Measured live, one real call each:**
  `category_reviews` `grounded_search` **$0.037387** + `json_structure`
  (atlas) **$0.004218**, `product_review_summary` **$0.037883** — $0.079488
  across three rows that previously wrote nothing, grounding 92-94% of each
  grounded row **measured against the $0.035/request surcharge default that
  was current at the time.** ⚠️ **That default is GONE as of the SAME DAY**
  (a separate, deliberate session change — see
  `GROUNDED_SEARCH_COST_PER_REQUEST_USD` in `services/costTracker.js`):
  Google's 1,500/day free grounded-prompt allowance comfortably covers
  measured volume, so the ledgered default is now **$0**, not $0.035. The
  measurement above is an honest historical record of real API calls under
  the code as it existed then — do not read it as today's price. What this
  PR actually guarantees, unaffected by that change, is that
  `groundedRequests` is correctly declared on every grounded row (feeding
  both the dollar figure, whatever it currently is, AND the free-allowance
  alert). Pinned by `scripts/verifyGroundedGeminiLedger.js` (25 checks,
  revert-proven MECHANICALLY against 30 mutations across three rounds — the
  matrices are what found two holes in the harness itself: a source regex
  satisfied by the COMMENT documenting the field it was checking, and a
  top-level throw that killed the run with zero named failures — plus, on
  the rebase that surfaced the surcharge-default change above, a rewrite of
  F0 to read the live rate instead of a hardcoded copy and of F4 to assert
  the surcharge is additive and correctly gated rather than that it
  dominates, which stopped being true the moment the default changed).
  ⚠️ **Two harnesses bound on things this moved and were updated, not
  loosened:** `verifyQuoteRetrievalDirective` bounded the category pass-1
  prompt region on `let searchRes` (now `let searchData`, because the
  ledgered transport resolves the response BODY), and
  `verifyLlmErrorCodes` A1's LLM-poster INVENTORY legitimately lost both
  files — they no longer post at all. That check warns that a
  disappearance usually means the scanner broke; here it did not, so a new
  **A1b** keeps their coded-failure coverage alive explicitly and fails if
  either one regains a socket.
  ⚠️ **Atlas-routing pass 2 does NOT take the direct Google key off that
  path** — `atlasLlmService` keeps Gemini's OpenAI-compatible surface as
  the direct twin for this role, and that attempt is itself ledgered
  (`provider:'google-openai'`). Pinned by the harness's F3.
  **SECOND ADVERSARIAL PASS, same day, same branch (Grok re-authed
  mid-session; 4 parallel Grok reviews + 2 Anthropic subagents, every claim
  hand-verified before acting).** Real, fixed: `reviewCount` was typed
  `integer` in BOTH the category and provider strict schemas while every
  reader is `typeof === 'number'` — under strict decode a float would have
  rejected the WHOLE object (quotes and rating included), worse than the
  schemaless path it replaced; now `'number'` in both. The pass-2 fallback
  mislabeled its provider `'atlas'` even when the throw came from the
  `google-openai` direct twin; now `'unknown'`. **`brandId` was available and
  dropped at ALL THREE production `fetchProductDetails` call sites**
  (`CatalogProduct.brandId` is real and required, just never threaded) —
  now threaded through all three plus both function signatures, guarded by
  a rewritten, argument-COUNT-based `E9` (name-based checks are fooled by
  what a caller names its variable). The harness's own `F7` asserted
  `fetchAndCache` threads `brandId` via a source regex that **matches
  `brandId: null`** — same `receiptFree`-class lesson, new instance; `F7`
  now drives the real `fetchAndCache` (exported for this) with
  Category/Brand stubbed. A genuinely live regex-literal lexer bug —
  `productDetailsService.js:56`'s `replace(/^['"]|['"]$/g, '')` desyncs a
  naive quote-tracker for the REST of the file — found by testing my own
  fix, not by a reviewer; `stripComments`/`fnBody` now share one
  regex-literal-aware tokenizer. Two dummy-satisfiable source `tools:`
  regexes removed from E5/E8 (satisfiable by a dead literal while the real
  call drops the field); `G1`/`F7`/`F8` now own "still asks for grounding"
  **behaviourally**, off the request as sent through the real production
  entry points. `fnBody`'s brace-matcher was truncatable by a template
  literal containing a bare `}` line (Sonnet-subagent-demonstrated); now
  walks params-then-body over the shared tokenizer. Real, correctly
  DECLINED and flagged instead: `atlasLlmService.post()` (the shared
  Atlas + direct-twin transport, **27 files** deep — Director, Judge, Copy,
  Layout, …) has no `maxRedirects: 0`, confirmed pre-existing, too large a
  blast radius for a two-file ledger PR — spawned as its own follow-up.
  Harness now 25 checks, revert-proven by THREE mutation matrices (30
  mutations total — a third round after rebasing onto current `main`
  surfaced the surcharge-default change noted above, which needed the
  harness's own `GROUNDING_PER_CALL`/`F4` fixed the same way). **Re-verified
  live a second time** after the `reviewCount` schema change (integer→number)
  — a real Atlas structuring call correctly returned `rating:null,
  reviewCount:null` (a legitimate "not found" this run, not a decode
  rejection) and every row still validated against the real CostLog schema.
  Full 174-script suite green (up from 169 as `main` grew), lint clean, on the
  branch as rebased. Full narrative in `session.d/2026-08-19_gemini-grounded-
  cost-ledger-second-pass.md` (`session.md` itself was restructured the same
  day into per-entry `session.d/` files — see that file's own header).
  Everything else that reads `GEMINI_API_KEY` (`geminiIdentifyService`,
  `visualCatalogMatchService`, `plateIntelService`, `overlayZoneService`,
  `quoteSnippetService`, `layoutInputService`, `metaAdsFontService`) was
  **already Atlas-primary**, with the direct key wired only as
  `atlasLlmService`'s own fallback-of-last-resort — nothing to fix there.
  `aiVideoReferenceService` (direct Veo) is gated dead by
  `VIDEO_PROVIDER=atlas`. `aiImageReferenceService` was already confirmed
  dead by a prior session. Pinned by
  `scripts/verifyGeminiSearchAtlasRouting.js` (9 checks, revert-proven on
  four mutations) and the updated `scripts/verifyGeminiSearchCost.js`
  section D (behavioural, real function calls against a stubbed transport
  that branches on URL).
- **A REGEX OVER SOURCE TEXT CANNOT SEE AN UNBOUND IDENTIFIER — and `node --check`
  cannot either.** This shipped a broken money guard to production with a green
  harness on 2026-08-04. `services/processAlerts.js` called `receiptFree({...})`
  and never imported it; `routes/ads.js:23` and `worker.js:59` both did.
  `verifyReceiptAwareRequeue.js` "checked" the site with
  `/receiptFree\(/.test(block)` — which proves the call is *written*, not that it
  *resolves*. A `ReferenceError` is runtime, not syntax, so `node --check` passed
  too. Because both writes sat in one `Promise.all([...])`, the throw happened
  while the array was being **evaluated**, so `CampaignRun.updateMany` never even
  ran: every SIGTERM with ads in flight silently requeued nothing AND left the run
  unmarked — the exact "silent stall" that function exists to prevent. It hid for
  three hours because `persistOrphans` returns early when nothing is in flight.
  **Rule: when a harness asserts a call site uses a helper, it must also assert
  that file IMPORTS the helper** — and derive the file list by SCANNING, never a
  hardcoded list, or the next call site is unguarded again. Now `I0-I5`, and the
  scan is **recursive** (36 files under `services/providers`,
  `services/capabilityExecutors`, `services/reviewAdapters`, … were previously
  invisible to `X1` as well).
- **A merge conflict marker SURVIVES in `.env` — the parser ignores what it cannot
  understand.** `config/defaults.env` on `main` carried literal `<<<<<<<` /
  `=======` / `>>>>>>>` at lines 498/535/566 and was deployed. It did **not** break
  config: dotenv skips any line that is not `KEY=VALUE`, so all 114 keys parsed and
  both arms' vars were effective (measured, not assumed). But nothing catches it —
  not `node --check`, and **not the §4a diagnostic**
  (`grep -oE '^[A-Z_][A-Z0-9_]*='`), because markers do not match that pattern.
  Resolved 2026-08-04 by keeping **both** arms, since both were already live and
  dropping either would have been a silent behaviour change; proven a no-op at
  117 → 117 keys with identical values. **Add a marker scan to any config audit,
  and never assume a dirty merge would have failed loudly.**
- **Docs have described commented-out code.** `TITLING.md` documented the disabled
  canvas cascade as live. When you find such a case, fix the doc in the same commit.
- **Director concept contract (v3 nested under `routing`).** Schema v3 moved
  strategy fields (`media_picks`, `creative_style`, `output_shape`,
  `funnel_stage`, …) under `concept.routing`. Reading `concept.media_picks` flat
  silently zeros ads while the producer's dual-read validator logs `warnings=0`.
  **Every consumer must use `services/conceptProjection.js` —
  `conceptField()` / `conceptMediaPicks()`.** `scripts/verifyConceptContract.js`
  exhaustively scans `services/` + `routes/` and fails if any file reads a
  `ROUTING_NESTED_FIELDS` name off a concept without the helper. Zero-ads root
  cause fixed 2026-08-03 (live: `concepts=3 payloads=3` where it was
  `payloads=0`). New fields must be **registered** in that list or the scanner
  is blind to them (Phase B `funnel_stage` lesson; **R0b** pins the load-bearing
  set).
- **`mongoose.isValidObjectId` accepts any 12-byte string.**
  Verified: `mongoose.isValidObjectId('video-models') === true` (12 chars);
  `'formats'` is false (7). So `router.param('id'|'adId', …)` 404 guards
  (`routes/ads.js:2105-2112`) **cannot** protect a 12-character named route.
  **Route registration order** is what keeps `/formats`, `/video-models`,
  `/veo-prompt-scaffold`, etc. from falling through to `/:id`. Unknown
  non-ObjectId paths 404; unregistered 12-char names still cast and hit `/:id`.
- **EVERY LLM FAILURE CARRIES A CODE AND AN ACTION — `services/llmError.js`,
  imported, never re-implemented.** Owner directive 2026-08-18: *"every failure
  to an LLM call should be reported with a easy to understand and complete
  error code"* + *"and what steps were taken next"*. Before this, `Atlas 400:
  {"code":400,"msg":"bad request"}` was all an operator got — it cannot
  distinguish a param bug from a capacity outage from a missing key, and the
  real fault was a fourth thing again (429 after ~51s). **Fifteen**
  `LLM_*` codes, each with `retryable`, a **derived** `billable`
  (`false` / `true` / `'unknown'` — a 429 bills nothing, a timeout is
  genuinely unknown, an HTTP-200 content failure DID bill), and an
  `operatorAction` saying what a human should do. The `action` is what the
  system ACTUALLY did next (`EXHAUSTED_CHAIN`, `ADVANCED_TO_NEXT_LINK`,
  `SKIPPED_NO_KEY`, `GAVE_UP_PRODUCT`, …), stamped by the control flow AFTER
  it ran via `stampLlmAction` — never hardcoded beside a call site where a
  later edit makes it a lie. Full code→meaning→what-to-DO table in
  `docs/ALERTING.md`.
  **Surfaces in four places**: the Render log line, Slack, `CampaignRun.errors[]`
  / `.perProduct[]`, and the thrown object. The Mongo ones needed **schema
  declarations** (`models/CampaignRun.js`) — a strict schema drops an
  undeclared path in silence, the same trap that lost
  `renderError.predictionId`.
  ⚠️ **Two backwards-compat details that look removable and are not:**
  `makeLlmError` sets **`err.status`** alongside `err.httpStatus` because
  `judgeService.js:322-334` branches on `err?.status === 400` to retry a
  Cloudinary CDN race, and it keeps the **provider's own text inside
  `err.message`** because that same retry matches
  `/Timeout while downloading/i` against it. Dropping either turns a working
  retry into dead code with every test still green. `costTracker.js:120`
  likewise reads `/timeout/i` off `err.message` to pick the CostLog status —
  `[LLM_TIMEOUT]` satisfies it, a 429's message deliberately does not.
  **Scope boundary, enforced by `verifyLlmErrorCodes.js` A5:** this taxonomy is
  for TEXT/chat/embedding endpoints ONLY. `atlasErrorPolicy.js` still owns
  image/video, where "advancing is free" is FALSE and a replay needs structured
  proof of pre-work rejection. Do not import one into the other.
  **`err.code` IS THE TAXONOMY CODE AND IT OVERWRITES THE AXIOS ONE.** The
  original survives as **`err.transportCode`** — load-bearing, not a courtesy:
  `shouldRetrySameLink` needs `ECONNRESET` (transient → retry) apart from
  `ECONNREFUSED` (host wrong/down → do not) to reproduce the pre-chain retry
  set. `err.llmCode` is the unambiguous alias when you must be sure which you
  are reading.
- **RETRY-THIS-LINK AND ADVANCE-TO-NEXT-LINK ARE TWO PREDICATES. Do not collapse
  them (2026-08-18, second pass — this was a shipped regression).** The first
  chain implementation used `ADVANCES_CHAIN` for both, which changed behaviour
  for the ELEVEN single-link roles (layoutInput, judge, enrichment, vision, …):
  a listed-but-unrouted 400 went from **one** Atlas POST (pre-chain broke on
  `err.routerMissing`) to **three plus two backoffs**, and `ECONNREFUSED` /
  `ENOTFOUND` / `EPIPE` — absent from the old four-code `retryableError` set —
  started burning `MAX_ATTEMPTS` on failures that do not fix themselves in 3s.
  Neither is a money bug (LLM failures are unbilled) but both are latency on
  every mis-pointed `ATLAS_MODEL_*` and every dead slug, and this repo HAS a
  dead slug (`openai/gpt-5-nano`, listed, "router not found").
  `shouldRetrySameLink(err)` in `services/llmError.js` now reproduces the
  pre-chain predicate **term for term** — including the no-`err.code` case,
  which is why it consults `transportCode` rather than being a pure code set.
  `ADVANCES_CHAIN` keeps its own, wider job: a different candidate may route or
  may live on a different host. Pinned BEHAVIOURALLY, per failure class, with
  exact pre-change attempt counts, by `verifyDirectorFallbackChain.js` C5/C6/C7
  — the original C5 scripted 429 only, which is precisely why both deltas were
  invisible to a green suite.
- **THE ZERO-ADS DIRECTOR FAILURES ARE CODED — do not let a new one throw a bare
  `Error` (2026-08-18, second pass).** Five failures end in zero static ads for
  a product: empty content, truncated response (`finish_reason === 'length'`),
  still-not-JSON after the corrective re-ask, zero usable concepts, and the V2
  path's parse failure. All five threw plain `Error`s, so `isLlmError` was false
  in the per-product dispatcher — **none paged and every one recorded
  `errorCode: null`** on `CampaignRun.errors[]`. That is the COMMON case, not an
  edge: this file records 10 Director round failures to 1 success in 24h from
  prose responses. They now classify as `LLM_CONTENT_EMPTY` /
  `LLM_CONTENT_TRUNCATED` / `LLM_CONTENT_UNPARSEABLE` / `LLM_CONTRACT_UNMET` and
  page on the 2nd occurrence under their own key `director:content-failure`.
  **Fatal, same as the transport half** — the operator impact is identical
  (zero ads); a Director that answers and will not follow the contract is the
  same outage wearing an HTTP 200. **Separate key** because the remedies share
  nothing (Atlas capacity / keys / the model lever vs the prompt, the token
  budget, or the serving model), and one key would dedupe a content failure away
  behind an unrelated transport page.
  **Mechanism — `adoptLlmFailure(new Error(pinnedMessage), coded)`, not
  `throw makeLlmError(...)`.** Two reasons, both load-bearing: the messages
  reach the operator verbatim through `CampaignRun.errors[].message`, and
  `verifyDirectorJsonSalvage` M1/M1b pin the parse-failure throw site as the
  money bound that keeps the corrective re-ask on ONE shared budget (worst case
  two paid Director calls). Classify where the failure is DETECTED — only that
  branch knows empty from truncated from unusable — and adopt on the way out.
  ⚠️ **These must still never advance the fallback chain** (`CONTENT_CODES ∩
  `ADVANCES_CHAIN` = ∅, pinned): a different model does not fix prompt
  compliance, and advancing multiplies PAID calls. Pinned by
  `verifyLlmErrorCodes.js` group G.
- **Slack, not Telegram. `res.ok` is not delivery.** `SLACK_BOT_TOKEN` is the
  only secret (Render env on **both** services). Channels are committed in
  `config/defaults.env` (non-secret): `SLACK_ALERT_CHANNEL`,
  `SLACK_ALERT_CHANNEL_FATAL`, and `SLACK_ALERT_CHANNEL_STATUS` (per-run live
  feed — `services/runFeedService.js`; parent `chat.update` + threaded event
  log; fire-and-forget, never on a render path). Slack returns HTTP 200 with
  `{ok:false,error:…}` on logical failure; checking only `res.ok` reports
  success while nothing delivered (`alertService.js:220-222`). Worker boot:
  `🔔 alerts: Slack configured`.
- **Run-feed `by:` regression, FIXED 2026-08-24.** PR #328 hoisted the *bare*
  `runFeed.startRun` call above the adgen-handoff `return` but left the
  displayName-resolving enrichment below it — dead code on the handoff path
  (100% of prod runs), so the parent posted once to a short id and never
  refreshed. Fixed by hoisting the resolution itself, consolidated to one
  call. Same change adds `CampaignRun.automation` so a `scripts/
  mintTestToken.js` (ui-smoke) run renders `by: <session> (Claude session)`
  instead of the real human identity it authenticates as. Full mechanism:
  `docs/ALERTING.md` "Who ordered the run" / "Automated runs"; pinned by
  `scripts/verifyRunFeedStartsUnderHandoff.js` +
  `scripts/verifyAutomatedRunRequesterLabel.js`.
- **`DIRECTOR_UNIVERSE_TOP_N` default is 1** (`config/defaults.env:35`,
  `campaignAdsGenerationService.js:195`). Ceiling stays 10
  (`seededUniverseService` `DEFAULT_TOP_N`); multi-image remains wired;
  operator multi-select widens via `Math.max(mediaIds.length, TOP_N)`
  (`campaignAdsGenerationService.js:2343-2345`). Side effects of universe 1:
  judge `media_utilization` is N/A (`aiJudgeService.js:423-430`); output-shape
  menu narrows to `static_single` only
  (`aiCreativeDirectorService.js:feedOutputShapesForUniverse` `:1050-1055`) so
  the model cannot emit a collage declaring one tile.
- **SUPERSEDED 2026-08-05 — THE DEFAULT SEED IS NOW THE MERCHANT FEED'S
  PRIMARY IMAGE, resolved `CatalogProduct.imageMediaId` → `metadata.feedIndex
  === 0` → (static only) best shotType rank.** Owner directive: *"the primary
  image as defined by the merchant feed is the main image ... The Hero stamp
  is not relevant when selecting images for video or static catalog
  generations."* `feedIndex` is stamped at ingest (0 = `product.imageUrl`,
  1..N = `additionalImages` in feed order). Video reference refs 1/2 are now
  `feedIndex` 1/2 (`atlasVideoService.sortCatalogMediasForReferenceStack`,
  which composes UNDER the existing `VIDEO_DEFAULT_REFERENCE_SHOT_TYPES`
  preference — feed order is the base, that dial is an opt-in reorder over
  it), and the video subject-dominance guard is gone on that path. Kill
  switch `CATALOG_FEED_ORDER_SEEDING` (default true) reverts all of it.
  **The pointer is checked BEFORE the stamp on purpose:** nothing clears
  `feedIndex` when a merchant replaces their primary image, so a stamp-first
  cascade would seed a billable render from a retired photo. Scope is the two
  live default paths only — `adRegenerateService` and `seedsFromProduct` are
  unchanged. Pinned by `scripts/verifyCatalogFeedOrderSeeding.js`; full
  write-up in `session.md` (2026-08-05). **The paragraph below is the
  SUPERSEDED 2026-08-03/08-04 rule, kept because the kill-switch-off path
  still runs exactly it.**
- **`TOP_N=1` IS NOT THE DEFAULT-IMAGE-SEED RULE — `preferFirstCatalogImage`
  is, and the rule is "the FIRST IMAGE THAT CAME FROM THE CATALOG", not the
  `imageRole:'hero'` label.** This file, `config/defaults.env`,
  `docs/PIPELINES.md` and two code comments all called TOP_N=1 the "Hero-image
  default" for a day. It never was. `buildSeededUniverse`'s auto-assembly
  branch merges catalog media **and** `product_match` UGC into ONE pool and
  ranks it by `classification.shotType` first (`seededUniverseService.js:96` →
  `shotTypeRank.js:15-23`: lifestyle → on_model → flat_lay → product_only →
  detail → packaging → unknown); `metadata.imageRole === 'hero'` is only a
  **within-tier tiebreak**, key #2 of 4. So TOP_N=1 trims a shotType-ranked pool
  to one entry and that entry was routinely a lifestyle catalog **ALT** or a
  **UGC post**. Owner, verbatim 2026-08-03: *"I actually just want to use the
  first image that comes from the catalog not the 'hero' image since that may
  also come from social media or UGC?"* Implemented by the opt-in
  `opts.preferFirstCatalogImage` → `promoteFirstCatalogImage`
  (`seededUniverseService.js:178`, applied `:504`) — a pure, non-mutating
  **CASCADE** applied to the ranked wrappers before `projectEntry()` and before
  the top-N trim. **Every tier is gated on `role === 'catalog'`, so it can never
  resolve to UGC:** (1) first `role==='catalog'` + `imageRole==='hero'` entry —
  that stamp is written only by `catalogProductDetectService:60` off
  `CatalogProduct.imageUrl`, i.e. the feed's first image (`:80`/`:513` write
  `'alt'`; the only other writer is `shopifyPublicIngestService.js:526`, which
  writes `'video'`); (2) else the **earliest-`createdAt` `role==='catalog'`
  entry** — this tier is the fix: the stamp can be **absent** (materialisation
  failed, legacy row), and a tier-1-only rule then fell through to the shotType
  ranking over that merged pool, which is exactly how a UGC post became the
  default; (3) else no promotion. Tier-2 ties use a strict `<` so the earlier
  entry in ranked order keeps index 0, and a missing/unparseable `createdAt`
  maps to `Infinity` (sorts last, never wins "earliest"). Deliberately mirrors
  the video rail's cascade at `campaignAdsGenerationService.js:2085`. Passed
  only for image runs with no operator picks
  (`campaignAdsGenerationService.js:2388`). Deliberately **not** applied in the
  `restrictToMediaIds` branch (operator picks ARE the override) or in brand-only
  mode (every SKU's catalog media is pooled, so "the catalog's first image" is
  undefined). `scripts/verifySeededUniverseHeroDefault.js` (111 checks) pins all
  of it, including that the promotion is **not** folded into the shared
  `rankMergedPool` — that would silently re-order operator picks. Details:
  `docs/PIPELINES.md` §5 *Seed selection — image vs video*.
- **Static regenerate RE-DERIVES the catalog-first seed
  (`REGEN_RESEED_CATALOG_FIRST`, default ON).** Ship in `be5b83f`.
  `services/adRegenerateService.js` used to **replay** the stored
  `Ad.mediaIds` stack forever, so ads queued under `TOP_N=10` still sent 3+
  refs on every regen. **NOT a trim:** historical stacks were shotType-ranked
  LIFESTYLE-FIRST over a catalog+UGC merged pool, so `mediaIds[0]` is often a
  UGC post and trimming would lock a social image in. Instead it re-derives
  via the same cascade as generation-time catalog-first: imageRole hero →
  earliest-`createdAt` catalog entry → nothing. **Every query is pinned to
  `source:'catalog-product'` + the ad's own product AND brand**
  (`deriveFirstCatalogMediaId`, `adRegenerateService.js:215-261`); a catalog
  **VIDEO** can never win (`fileType === 'video'` and
  `metadata.imageRole === 'video'` are both rejected —
  `isCatalogMediaForProduct` `:150-172`). An unusable/missing `fileUrl` is an
  **honest skip** (tier 3 / `NO_CATALOG_MEDIA`), not a silent fallback to the
  ad's original seed (that path would re-lock the UGC seed while logging
  success). **Gates:** `variantKind === 'product_image'` only (owner: *"UGC
  ads shouldn't be affected by this change, we haven't optimized that path
  yet"*); skipped when `Ad.referenceMediaIds` is non-empty (operator pick
  always wins); video regenerates never reseed. **Nothing is persisted back
  onto the Ad** — the derived stack is render-call-only, so the kill switch
  (`REGEN_RESEED_CATALOG_FIRST=false`) stays effective on the next regen.
  Pinned by `scripts/verifyRegeneration.js` (R3 / R3b / R3c).
- **A LABELLED brand rating MAY now sit beside a product/comment-tier quote on
  STATIC — owner override of tier-coherence invariant #4, 2026-08-07. Do NOT
  "restore the invariant".** `resolveCoherentSocialProof`
  (`services/ratingDisplay.js`) used to hard-null brand numbers whenever a
  product/comment-tier quote was on frame, because a brand-wide count beside one
  SKU's testimonial reads as that SKU's volume. **Measured cost of that rule:
  7 of 18 `ai_social_proof_led` renders (2026-07-30..08-06) fell back to
  `objection_resolved`** — the comment-tier quote nulled otherwise-usable brand
  stars, and `INTENTS.social_proof_led`'s `core` **is** the rating, so the ad
  lost the very thing it exists to show. Owner, verbatim: *"I don't want brand
  level stars to block a comment tier quote. We can have both and clearly
  demarcate brand level stars … The positive comment is different and better
  social proof than brand level stars"* / *"include the comment and then use
  brand level stars and include a 'Brand Reviews' next to the stars."*
  **How it is contained — all three matter:** (1) the behaviour is an **opt-in
  parameter** `allowLabeledBrandNumbers`, **default `false`**, so every other
  caller — *including the whole video path via
  `brandScriptExecutor.buildMetaForAd`* — is unchanged **by construction, not by
  assertion**; only `directImageRenderService.buildIntentData` passes `true`.
  (2) The exception sits **after** both product attempts, so a product-tier
  number always wins and the exception can only ever ADD proof where there was
  none, never displace product numbers with brand ones. (3) It returns
  `source:'brand'` — **stars only** — which makes `packCoherentProof` derive
  `reviewsText` via `formatBrandReviewsText`, always carrying
  `BRAND_SCOPE_LABEL` (`"brand reviews"`), and `INTENTS.social_proof_led`
  prefers that scoped string over any re-derived unscoped one.
  **THREE CONSTRAINTS THAT LOOK OPTIONAL AND ARE NOT** — each closes a hole two
  independent adversarial passes found in the first draft, all three
  revert-proven: (a) the gate is **`=== true`**, not truthiness — a caller
  forwarding a raw env string opted in on the literal `"false"`; (b) a
  normalized brand **count is REQUIRED**, because `reviewsText` is derived from
  the count, so a stars-only brand pair (rating, `reviewCount: null`) produced
  `reviewsText: null` and `staticAdIntents` then rendered a **bare `4.7 ★`**
  beside a product/comment testimonial with no qualifier — no count means no
  label vehicle, so it refuses; (c) **`allowBrandCountWithoutStars` stays
  false** — a brand count with `rating: null` still fails
  `social_proof_led.eligible`, so it would print a brand volume claim beside a
  product testimonial *and* still collapse the intent. The fail-closed
  `renderedQuoteText` guard is untouched. **Known accepted residual:** a product
  pair with a sub-floor rating but a non-zero count returns `product-count` and
  short-circuits the exception, so that shape still falls back — fixing it would
  mean brand numbers displacing a product-tier number, a second override nobody
  has approved. Pinned (including that residual) by
  `scripts/verifySocialProofRestoration.js` groups C/D — **35 checks,
  revert-proven on 13 mutations**. Kill switch
  **`STATIC_BRAND_STARS_WITH_QUOTE=false`** (committed in `config/defaults.env`)
  reverts with no deploy. Precedent for why this note exists at all: §00's
  PR #61 rollback, where a later session "fixed" a deliberate decision.
- **Static `ai_social_proof_led` must render RATING FURNITURE, not a paraphrase
  headline (2026-08-24).** Three delivered ads (Soludos 4:5 + Stories, Pelagic
  PMax landscape) printed a rating CLAIM with no stars / numeral / count —
  including the unsubstantiated "Rated 5 Stars By Everyone Who's Tried Them".
  Cause: the rating-present absence BANNED the star row ("ONLY rating mark
  permitted"), so gpt-image-2 satisfied the RATING string as a sentence.
  Flag-on (`STATIC_RATING_FURNITURE`, default true) demands a star-glyph
  widget after SET EXACTLY THESE STRINGS and rejects universal-endorsement
  copy in `validateDirectorPayload`. Flag-off restores the previous static
  *and* Director prompts byte-for-byte. Scope label (`brand reviews` /
  "brand-wide") stays on the number, not as a headline adjective. Pinned by
  `scripts/verifyRatingFurniture.js`. Full write-up:
  `session.d/2026-08-24_social-proof-rating-furniture.md`.
- **Customer quotes: `llm-web` is PRINTABLE; attribution is stripped.**
  Prior denylist / "llm-web never prints" claims were **false**.
  `services/providers/geminiSearchProvider.js:977,1097,1218` use
  `tools:[{google_search:{}}]`; `:995,1121,1242` read
  `groundingMetadata.groundingChunks` — real grounded retrieval, not LLM
  authorship. `verbatim:false` on that origin is a **source-class stamp** ("not
  a first-party scrape"), not a paraphrase confession; it still hard-rejects for
  first-party origins only (`quoteProvenance.js:106-118`; stamp at
  `geminiSearchProvider.js:33`). Callers
  **must** use the return value of `toPrintableCustomerQuote()` (deletes bylines
  + `source` + `verified` — `:120-147`). `synthesized` and `unknown` remain
  rejected. Video titling reuses the same gate in
  `brandScriptExecutor.gateLayoutInputQuotes` / `buildMetaForAd` (`:609-680`) so
  a cached `LayoutInputArtifact` cannot burn a fabricated claim into Remotion
  chrome.
- **Quote colourway is fail-closed, sibling of provenance.** A quote that
  names a colour prints only when that colour's family is in the product
  TITLE's parsed colourway (`services/quoteColourway.js`
  `usableColourwayQuote`). Measured 2026-08-24: Soludos
  "…Sneaker | White - Wine" printed a green-accent testimonial over a
  burgundy shoe; QC failed, regen failed, ~$0.14 burned per occurrence.
  No structured colour field exists on CatalogProduct (and we do not add
  one here). Colour-free quotes and colourway-matching quotes are a
  no-op; unparseable colourway + colour language drops the quote
  **on product-attached ads only** (brand / media-library ads are a
  no-op even when a noun-scope title is present). Three follow-up
  holes closed on the same PR: display-normalized titles keep the
  full multi-colour colourway (not last-dash-only); hyphenated
  adjectives (`green-accented`) are colour language; ordinary-word
  collocates (`mint condition`, `golden opportunity`, …) are
  MUST-KEEP. Composed with `toPrintableCustomerQuote`, never inside
  it. Pinned by `scripts/verifyQuoteColourway.js`. Write-up:
  `session.d/2026-08-24_quote-colourway-mismatch.md` and
  `session.d/2026-08-24_quote-colourway-pr324-holes.md`.
- **Stage telemetry is fire-and-forget.** `services/adStage.js` — **never
  await** (`adStage` sits where Atlas is already billed). Both static and video
  piggyback existing poll ticks (`ATLAS_IMAGE_POLL_MS` 3s,
  `ATLAS_POLL_INTERVAL_MS` 15s) with elapsed + poll count; floor
  `AD_STAGE_MIN_MS` (default 3000, env-only — not in `defaults.env`). No new
  timers. Closed a ~600s blind spot.
- **`perProduct` on `CampaignRun`.** Persisted and returned by
  `GET /api/ads/runs/:runId` (`routes/ads.js:1602`). Reason
  `concepts_no_usable_media` distinguishes "Director returned nothing" from
  "returned concepts but none usable" (`perProductReasons.js:32`). Run-level
  empty messages use real reasons, not a generic imagery blame.
- **`GET /api/ads/formats`** returns `formatCatalog()` verbatim — display-only,
  brand-agnostic, no `brandId` (`routes/ads.js:1998-2000`). Must stay
  registered above `/:id`.

---

## 4a. Render dashboard vs `config/defaults.env` (migration COMPLETE 2026-08-03)

Owner rule, verbatim: *"The dashboard in render should only contain secrets,
everything else should be editable outside of the dashboard."*

**PRECEDENCE — the trap that caused the half-done rollout.**
`index.js:1-5` and `worker.js:18-20` load the process environment **first**
(Render dashboard / local `.env`) and `config/defaults.env` **second**.
`dotenv` **never overrides an already-set var**. A dashboard var always wins;
a value in `defaults.env` is the **effective** value only when no dashboard
var of that name exists. **Diagnostic for a silent config lie:** a var set in
**both** places with **different** values. Next-session check: compare the
live dashboard key list against
`grep -oE '^[A-Z_][A-Z0-9_]*=' config/defaults.env` — any intersection whose
values disagree is lying about what prod runs.

**Migration status: FINISHED 2026-08-03** (was half-done; the file header used
to say "until the migrated vars are removed from the Render dashboard, they
shadow these defaults"). Verified live in the Render dashboard:

| Service | id | Before → after |
|---|---|---|
| WEB | `srv-d1vuktqli9vc73ft07ng` | 64 env vars → **23** (41 deleted) |
| WORKER | `srv-d8128c1o3t8c73e8kb30` | 24 env vars → **14** (10 deleted) |

Every deleted key existed in `config/defaults.env` with an **identical**
value, so the deletions were runtime no-ops — **except one** (below).

**Delete rule (load-bearing):** only delete a dashboard var that exists in
`config/defaults.env` with an **identical** value. A dashboard-only var must
be **migrated into the file first**, never just deleted — or the value is
lost with nothing to fall back on. That is why **`JIRA_PROJECT_KEY` was
RETAINED** even though it is not a secret: it does not exist in
`config/defaults.env`.

**What stays on the dashboard:** secrets only, plus `JIRA_PROJECT_KEY`.

**The per-key list is DELIBERATELY NOT REPEATED HERE.**
`docs/PIPELINES.md` §9 *"Stays in Render env"* is **canonical** — it carries the
full table with per-service (WEB / WORKER) columns and what each key is for.
Two copies of a 37-key list will drift, and a stale list here is worse than no
list: someone would trust it while deleting a dashboard var. This section owns
the *rules* (precedence, the delete rule, the counts, the one non-no-op); §9
owns the *inventory*. Keep it that way.

Note the audience split, which is why this is written in both places at all:
`CLAUDE.md` is read by Claude sessions, but env vars are edited by humans and by
other agents (Grok edits this repo directly and reads `docs/PIPELINES.md`, not
this file). The rule has to be findable from either direction — the inventory
only needs to exist once.

**The one non-no-op: `RENDER_CONCURRENCY`.** The dashboard pinned **4** while
the file said **8**. Earlier docs ("defaults raised 2026-08-02: RENDER 4→8")
described the **file** change only — production stayed at 4 for a day because
the dashboard shadowed it. Owner chose to delete the dashboard copy on
2026-08-03, so the file's **8 is now live** on the web service. Render
concurrency **doubled 4→8 on 2026-08-03 as a consequence of this cleanup**,
not as a separate tuning decision. Re-measure before going higher
(`services/concurrency.js`).

---

## 5. Conventions

- Commit message trailer: `Co-Authored-By: Claude <noreply@anthropic.com>`.
- Commit/push **only when asked**. Feature branches only; never push to `main`
  without explicit permission.
- Before pushing non-trivial changes: run **`npm run lint`**, `node --check` the
  touched files, and run the relevant `scripts/verify*.{js,mjs}` harness
  (**174 `.js` scripts / 184 including the 10 `.mjs`** — recounted 2026-08-21;
  run them with `npm test`, NOT the `verify*.js` shell loop, which skips every
  `.mjs`. Was "143 / 152 including the 9" as of the CampaignRun
  heartbeat, 2026-08-18 — the "101" the header still carries is stale by ~42,
  and the "138" this line carried counted only part of the tree). Add a
  harness for money/security-critical logic, and **revert-prove it** — back
  the fix out and confirm the test fails. A test that cannot fail is not a
  test.
- **`npm run lint` is not optional, and it is not a style check.** It enables exactly
  one rule, `no-undef`, because that is the one thing every harness here is blind to:
  they assert over source text, and a regex cannot see an unbound identifier —
  neither can `node --check`, since a `ReferenceError` is a runtime error. This has
  now shipped to production three times (`receiptFree`, `preferUgcMediaId`,
  `usableProofCommentsOrNone`). If you add a rule, add it deliberately and say why.
- **A `no-undef` gap can hide per file-extension, not just per file (#252 +
  same-day follow-up).** `**/*.js` doesn't match `.mjs`/`.cjs` — a file matched
  by no block still gets walked and reports `0 problems, exit 0`, which is
  indistinguishable from clean. #252 added an `.mjs` block but reused
  `nodeGlobals` verbatim, so `require`/`module`/`exports`/`__dirname`/
  `__filename` — genuinely unbound in ESM — passed silently inside it; the
  follow-up split a trimmed `esmGlobals` and folded `.cjs` into the CommonJS
  block. New extension → new block, and prove it with the injection recipe
  above, not just a green `eslint .`. See `eslint.config.js` comments.
- Adversarial review on non-trivial diffs: have a second model try to *refute* the
  change (bugs, bypasses, money holes) before committing. It caught two real regex
  bugs in the submit guard that review-by-reading missed.
- **`session.md` gets a new file, never a new paragraph (restructured 2026-08-19,
  read this before touching either file).** Every dated entry used to append
  directly to `session.md`, which put every open PR's diff on the same shared
  lines — one merge to `main` was enough to flip every other open PR from
  MERGEABLE to CONFLICTING, on the doc, never the code. `session.md` grew to
  6,962 lines / 475 KB this way, most of it dead weight on every session's
  required first read. **The fix:** a session's write-up goes in its own file,
  `session.d/YYYY-MM-DD_<slug>.md` — never as a new section inside `session.md`
  itself. Two sessions creating two different files cannot conflict; there is no
  shared line to fight over. `session.md` itself is now short on purpose: the
  owner's NEXT-SESSION PROMPT, a small replaced-not-appended CURRENT STATE, and
  pointers to `session.d/` (the full chronological log) and `CHANGELOG.md` (older,
  hand-curated history). Read `session.md` §"Adding an entry" before your first
  write — do not edit the body of `session.md` to record what you did.
- **This file (`CLAUDE.md`) has the same append-tax on a smaller scale — 20 of the
  last 36 merges to `main` touched it, almost always by inserting a new bullet
  into an existing numbered section, which is exactly where two unrelated PRs
  collide.** It was **not** split into multiple files: two harnesses
  (`scripts/verifyCampaignRunHeartbeat.js` G4, and `docs/ALERTING.md`'s own
  reader in the same file) assert on this file's content **by this exact path**,
  and `CLAUDE.md` is a cross-referenced instruction manual read for correctness —
  a merge strategy that can silently keep two disagreeing versions of the same
  fact (see the union-merge note below) is the wrong trade here even more than
  for a log. Instead: **keep new bullets short.** State the rule and the
  money/correctness consequence in 1-5 lines with a citation
  (`session.d/<file>.md` or `docs/PIPELINES.md §N`) for the full incident
  write-up — do not paste the forensic narrative inline here. Several existing
  bullets already do this (search "Full write-up:"); that is the pattern to
  copy, not the multi-paragraph incident blocks next to it. This does not
  eliminate CLAUDE.md merge conflicts (two edits to the *same* bullet still
  collide, correctly), but it shrinks each PR's footprint in this file, which is
  most of what makes two unrelated PRs collide here in the first place.
- **Do not add a `.gitattributes` `merge=union` driver to `CLAUDE.md` or
  `docs/ALERTING.md`, and think twice before adding one to any table-bearing
  doc.** It was considered and rejected for both files, 2026-08-19. Union merge
  auto-resolves two independent line *additions* at the same anchor — fine for a
  bullet list — but it also auto-resolves two *edits to the same row* of a table
  by silently keeping both, with no conflict and no human ever told. Both files
  carry exactly that shape: `docs/ALERTING.md`'s "Gap table" and its LLM-error-code
  table (the latter is parsed by `scripts/verifyLlmErrorCodes.js` F1/F2, which
  finds the FIRST row matching a code — a silently duplicated, disagreeing row
  would have the harness read the stale one and report green), and this file's
  several status tables (§00, §2, §4a). A **new** row/bullet from two unrelated
  PRs merges cleanly today without any driver, as long as they don't anchor on
  the identical last line; it is only the same-row-edited-twice case a driver
  would paper over, and that case needs a human, not a silent union.
- `docs/PIPELINES.md` is organised by pipeline (§1-10), not chronology, so two
  unrelated PRs usually land in different sections and merge cleanly already;
  the same "cite, don't paste the forensic narrative" convention applies to it,
  but it was not restructured.
