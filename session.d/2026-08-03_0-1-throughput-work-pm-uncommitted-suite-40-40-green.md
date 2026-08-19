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

