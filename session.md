# session.md — liquidretail_backend

## Next-session prompt

### PICK UP HERE (2026-08-02, late) — everything below is COMMITTED, nothing pushed

Branch `feat/render-activity-board`. **11 commits, zero pushed, zero deployed.**
Live prod still runs `a80ae0b`. All **19** `scripts/verify*.js` green.

| commit | what |
|---|---|
| `c4bbb12` | Phase 0 — ReferenceError that broke every fresh Director round |
| `53f6486` | Director reasoning quarantined from image prompts (110-check harness) |
| `919627a` `e3e1578` `d038053` | Presets: platform-grouped, Google frozen, coming_soon → 400 |
| `ccf4328` | **The video model is OMNI, not Veo** — corrected + 2 stale claims |
| `30b21d9` `a1dca08` | CLAUDE.md **§00** — the catalog pipeline, written down |
| `01e7d1c` | Three doors to the old renderer closed; **image regenerate fixed** |

**READ CLAUDE.md §00 FIRST.** It is the owner-stated architecture for catalog
product ads and supersedes anything older in this file.

#### THREE MISNOMERS — each cost a wrong conclusion this session
- **`veo*` is OMNI.** `BUILT_IN_DEFAULT_MODEL = google/gemini-omni-flash/image-to-video-developer`,
  `ATLAS_VIDEO_MODEL` blank. `renderRoute:'veo'`, `veoPredictionId`, `VEO_CONCURRENCY` — all Omni.
- **`renderRoute:'html_gen'` means STATIC**, not "HTML renderer". Every image ad gets it.
  `renderService.js:470` sends every `ai_*` static ad to `renderDirectImage` and returns.
- **`chrome` is the TITLING overlay**, burned in and correct. The Meta surface overlay
  (with Meta's per-surface CTA) is **PREVIEW ONLY** and must never be burned in.

#### IN FLIGHT WHEN THIS WAS WRITTEN
- **p7 concurrency consolidation — Grok RUNNING, will leave uncommitted edits.**
  Spec: `/private/tmp/.../scratchpad/p7.md`. One `services/concurrency.js`, every knob
  env-tunable, `RENDER_CONCURRENCY` 4→8, `VEO_CONCURRENCY` 1→4. **Verify before committing:**
  Grok's 1 RPS must survive per-model-slug, and raising concurrency must not push renders
  past `REAP_STALE_MIN` (reaper requeue = double bill).
- **p8 spec WRITTEN, not started:** `/private/tmp/.../scratchpad/p8-models-spec.md`.
  Grok is NOT a fallback (stays selectable); no automatic fallback anywhere
  (`allowFallback` default → false); model registry; OpenAI-direct + Gemini-direct as
  options; **Telegram deleted, Slack the only transport** (7 files carry Telegram today).

#### CONCURRENCY AUDIT — findings (Grok, verified)
- `VEO_CONCURRENCY=1`'s justification is **stale and mis-attributed**: commit `3a98cd4`
  wrote it for retired direct-Veo; `1492dca` for **Grok's real 1 RPS** (fallback model, not
  Omni). `atlasVideoService.js:265` admits Omni's RPS is **unpublished/unmeasured**.
  Cost: `backlogWatchdog.js:36` — a 20-video batch takes **20 minutes**.
- **Atlas advertises no rate-limit headers.** Empirical today: **8 concurrent
  gpt-image-2/edit, 85s, zero 429s.** Image submits are entirely **unpaced**
  (`atlasImageService.js:162`); `pacedModelSubmit` is video-only.
- **Titling is already order-free** — per-asset once `veoVideoUrl` exists, no sibling join.
  Remotion serialises *execution* (resource-bound), never input order. Nothing to fix.
- **REAL HOLE: nothing auto-drains `queued` Ads.** Only `/generate` and `/runs` drain;
  `worker.js:184-189`'s reaper only flips `rendering→queued`. Order 50 → 30 sit forever.

#### STEPWISE REFINEMENT A/B — done, anchoring wins
`gpt-image-2/edit` on Atlas is **STATELESS** (live schema: `images`, `prompt`, `size`,
`quality`, `output_format`, `moderation` only — no turn/conversation id). So stepwise
must re-supply the previous render. Flat **$0.01** per prediction regardless of input
count, so **anchoring is free**.
4 difficulties × pure vs anchored on a Gymshark duffle. At the hard rung (reposition),
**anchored held product fidelity** — front-on like the catalogue, both cream end panels,
crisper GYMSHARK arc — while **pure drifted** (three-quarter angle, one panel, reshaped).
Build **anchored** (previous render + product photo, product photo authoritative) with a
"start over from product photo" control.
**Bonus finding:** the duffle renders maroon and the product IS maroon — so the ad's quote
*"the perfect vibrant pink"* is a **fabricated claim**, not a render bug.

#### STATIC CREATIVE DEFECTS — found by QC, NONE fixed
Garment branding redrawn as gibberish (Gymshark shark-fin → "elf 7" on the sports bra);
composited logo at **1.12:1 contrast** (invisible); same SKU as two colourways; safe-box
breaches. These are the remaining blockers to "perfect" Meta static.

### Google frozen + preset split — COMMITTED (e3e1578, d038053). Frontend still to do

Backend-only Google freeze + preset split:
- `platformFormats.js` — pmax frozen, google presets empty, `formatCatalog()`
- campaign/ads refuse coming_soon with 400
All verify scripts green. Frontend: consume `formatCatalog()` for greyed Google.

### Proof + geometry blockers — COMMITTED (10c9479, 64bf6d6, 52e5a08). One decision still waiting

Three commits on `feat/render-activity-board`, **not yet pushed, no PR**:
`10c9479` geometry, `64bf6d6` fabricated proof, `52e5a08` snippet inversion.
(verify suite now 18 scripts.)

#### THE ONE DECISION WAITING FOR THE OWNER

`services/quoteProvenance.js` — `PRINTABLE_QUOTE_ORIGINS` currently EXCLUDES
`'llm-web'`. That is ~82% of all quotes in the database, so **most ads now ship
with no testimonial**. One-line flip in that file if the owner wants them back.

Measured 2026-07-31 against prod, and this is the context for the decision:
of 1073 catalog products carrying reviews, **883 are `gemini-search`** (3345
quotes, LLM web search) and **190 are unlabelled storefront imports** (748
quotes, per-quote `source:'store'`). **ZERO first-party review scrapes exist.**
So there is no "real" review capture to fall back on — the honest options are
(a) ship fewer testimonials, (b) accept LLM-extracted third-party quotes with
honest attribution, or (c) build first-party review scraping.

#### WHAT WAS ACTUALLY WRONG (all verified against prod, not inferred)

- Provenance was **inert end to end**. 718/718 layout artifacts had `origin`
  unstamped; 0/1073 products and 0/74 categories had a quote-level stamp.
  `quoteTier` was computed, logged, and thrown away. Every gate built on
  `origin` was decorative.
- Live bylines included `Verified buyer` (104), `Reddit (r/BuyItForLife)` (41),
  `Peloton Apparel` (145) and `vertexaisearch.cloud.google.com` (**80**) — sites
  and claims printed as the customer who said the words.
- `dimsFor()` returned `canvas` values (a 1000px HTML reference width) while the
  prompt promised `deliveryDims`; its `default` squared everything unnamed, so
  **pmax 16:9 shipped as a square**.
- Sharp ran `fit:'cover', position:'attention'` — a saliency crop — while the
  prompt told the model a specific CENTRED band would be cut away.
- The logo was composited 150px inside Stories' 250px reply-bar reserve.
- `isExtractive` was substring containment, so `'worth it'` extracted from
  `'Not worth it for the price'` passed and inverted the review.

#### STILL OPEN, IN PRIORITY ORDER

1. **B5 — Director headline is unvalidated** (retro blocker, NOT fixed).
   `copy_picks.headline` goes straight to the image prompt and can assert a
   price, a discount, a guarantee, a superlative or a clinical claim with
   nothing checking it. Grok drafted a validator; the reconcile agent rejected
   5 of its regex arms as too blunt (bare `\blifetime\b`, `\bforever\b`) —
   the owner's rule is that creative must not be lobotomised by a blunt gate.
   Full proposal: `/private/tmp/.../scratchpad/proposals.json` key
   `B5-director-headline`, and the narrowings are in `_PLAN.rejected`.
2. **Producer still ASKS for fabricated quotes.** `layoutInputService.js:1171-1182`
   still prompts for "NOTIONAL persona-authored reviews". They are dropped at
   pool assembly now, but it is paid tokens for output that is always discarded,
   and it is a loaded gun if someone re-wires `derivation.quotes`.
3. **HTML + video paths.** The provenance gate is producer-side so they inherit
   it, but Remotion brand scripts hold their own byline defaults — check for
   more manufactured attributions like the `metaCascadeConfig` one already fixed.
4. **Build A: video fan-out** — 1 generation = 3 sizes, race-free (queue 9:16
   master only; create 4:5/1:1 after `veoVideoUrl` lands), reuse `videoCropUrl`.
5. **Build B: safe-zone unification** — `platformFormats.safeArea` as the single
   source; `remotion/lib/safeZones.js` still keys per ASPECT CLASS, so Reels 204
   and Stories 250 collapse into one `vertical` entry.
6. **Build C: status screen UI + copy button** (backend done, on this branch).
7. `feat/render-activity-board` has never had a PR opened.

#### PROCESS NOTE THAT PAID OFF

Grok reviewed every diff before it landed and caught three things that would
have shipped: geometry validation placed AFTER the billable submit, an
allowlist forgeable via `source` (fixed by stamping `origin`, which
DERIVATION_SCHEMA cannot emit), and a `stampOrigin` else-arm that would have
laundered every legacy category row as printable. Grok also correctly refuted
one of my own claims (`dimsFor` mirrors `canvas`, it is not a rogue table).
Two Grok calls died after the preamble when the prompt carried a full diff —
Grok reads the working tree itself, so pass pointers, not diffs.


## VETTED 2026-07-31 — the parallel-HTML / double-spend diagnosis is STALE

A remote session concluded that a `direct_overlay` brand still runs an HTML-seeded, billable
image-ref shadow, and recommended flipping `AI_IMAGE_REFERENCE_ENABLED=false` +
`IMAGE_REF_DUMP_SEEDS=false`. **The mechanism it describes is real in the source, but it has not
run since 2026-07-30 22:45 UTC.** Measured on prod logs for all of 2026-07-31:

| marker | hits on 07-31 |
|---|---|
| `🖼 image-ref shadow` (billable shadow) | **0** — last ever 07-30 22:04 |
| `🌐 [render] HTML path` | **0** — last ever 07-30 22:45 |
| `🖼️ direct-image ready` | **7** (all `model=openai/gpt-image-2/edit`) |

Cause of the fix: `17c5e3e` widened the direct-image guard so **every** static `ai_*` render enters
`renderService.js:439` and returns at `:469` on success — before the eager `ensureCanvasAndHtml` at
`:492`. Since `getOrGenerate` is only reachable from `ensureCanvasAndHtml` (plus inspector routes
`routes/aiCanvasSpec.js:67`, `routes/layout.js:51,165`), the shadow sites at
`aiCanvasSpecService.js:1329` and `:1582` cannot fire on the ad-gen path. Confirmed independently
by a Grok repo-wide caller trace. `routedToHtml` (the only HTML entry) has **zero** log hits ever,
so no brand has been deliberately routed to HTML.

**Two corrections to that write-up, both load-bearing:**

1. **Editing `config/defaults.env` for these flags is a NO-OP in prod.** All 8 pipeline flags
   (`AI_IMAGE_REFERENCE_ENABLED`, `IMAGE_REF_DUMP_SEEDS`, `AI_IMAGE_REF_MODEL_ID`,
   `AI_IMAGE_REF_QUALITY`, `AI_HTML_LAYOUT_ENABLED`, `AI_LAYOUT_DIRECT_HTML`, `RENDER_USE_HTML`,
   `RENDER_USE_RESOLVED`) are set as **Render dashboard env vars** (verified via
   `GET /v1/services/{id}/env-vars`). `index.js:1-5` loads the real environment FIRST and
   `defaults.env` second, and dotenv never overrides an already-set var — the comment there says
   so. So the dashboard wins; change flags there, not in the file. Nothing is trapped behind an
   un-editable `.env`.
2. **The `refresh:true` bypass is not a live hole.** `aiImageReferenceService.js:79`
   (`if (!enabled() && !refresh)`) would skip the env gate, but no caller passes `refresh:true`
   to image-ref anywhere in the repo, and no HTTP route invokes `generateForArtifact` — routes only
   read existing artifacts.

**What the live `direct_overlay` path actually is** (matters, because expectations have drifted):
gpt-image-2 produces a **text-free plate**, then sharp/SVG composites headline/CTA/logo locally —
`directImageRenderService.js:435` (`sharp(plate).composite(layers)`), header comment at `:1-5`: the
image model "is deliberately never asked to render copy, prices, CTAs, or logos." That is exactly
the UI's "Direct image + exact overlay". A pipeline where gpt-image-2 renders the **whole** ad
including copy **does not exist** — `git log --all` has no commit removing the overlay compositing,
and `models/Brand.js:255` still enumerates only `['direct_overlay','html']`, matching the two
choices in the UI. So a 07-31 ad that looks flat/unpolished is the direct-overlay output behaving as
designed; the photoreal "polish" is precisely the shadow that stopped running. Adding an
all-to-gpt-image-2 path is **new work / a third enum value**, not a flag flip.

**Still-open money bug (dormant, not fixed):** `aiImageReferenceService.js:55-58`
`estimateCostUsd(size)` returns $0.042/$0.063 — medium-tier **gpt-image-1** prices — while prod runs
`AI_IMAGE_REF_QUALITY=high` on **gpt-image-2**. The file's own comment at `:38` puts high at $0.167
per 1024². So every `AiFullRenderArtifact.costEstimateUsd` under-reports by roughly 4×. Harmless
while the shadow is off; wrong the instant anyone re-enables it. Per CLAUDE.md the real number must
come from the Atlas catalog (`price.actual.base_price`), not this hardcoded table.

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

## Current state (2026-07-31, later) — social proof judged by inference

Backend `main` @ **PR #40**. Merged since the block below: #36 #37 #38 (render
timeout + recovery), **#39** (proof judge), **#40** (platform surfaces).

### #39 — comments are judged by inference at ingest, not by keyword
`hasPositiveSignal` was a regex lexicon: a comment counted as praise if a
positive word appeared in it. It accepted *"Not great, would not buy again"*
because "great" is in it; adding a complaint blocklist then rejected
*"Hasn't faded at all after a year, love it"* because "faded" is — which is
**risk reversal**, the single most persuasive thing a customer can write and the
form the snippet prompt is explicitly told to prefer. An allowlist and a
blocklist cannot both be right about a negation.

The decision is now one batched inference call, made **once at ingest** and
persisted to `Comment.proofJudgment`; the same call returns the ad-ready
shortened line, so a comment is judged and shortened exactly once (~$0.00002
per set, `review-text` role). **Five consumers read that one verdict** — four
previously each decided for themselves with three different answers, and the
Director had no screen at all: it got the most-liked comments verbatim,
truncated to 180 chars, so a complaint could seed the concept an entire ad was
built around. Every consumer now over-fetches and lets the judge narrow, rather
than taking top-N by likes and screening after (on a popular post the top
comments are noise while real praise sits below the cut). **No lexical
fallback** — Atlas, then the direct provider, then alert and throw; one shared
policy turns that into zero comments, never a raw one, because an unavailable
*comment* judge must not kill an ad holding 4.5★ review quotes.
Full rationale + failure table: **`docs/PROOF_JUDGE.md`**.

Reviews are deliberately NOT run through it — they carry the reviewer's own
stars (4.5 gate) and their text already passes through `extractSnippet`.

Also in #39, from a PR #34 compatibility audit: the **product quote tier was
structurally empty on every hydrated match** (hydration writes `productReviews`
top-level; the read site looked only at `identification.details`), so #34's
whole scraped-review engine never reached an ad and nothing failed — the ad just
quoted a category review instead. Plus: two disagreeing star floors collapsed to
one (`QUOTE_MIN_RATING` 4.5), ratings normalized before every comparison (a
90/100 added **+85** to a single-digit text score and won outright), the dead
`quote-snippet`→`gpt-5-nano` role deleted, and snippet cost no longer attributed
to a null product.

### #40 — every declared platform surface is first-class
`platformFormats.js` lists five surfaces; three places kept hand-written
subsets. `AiCanvasArtifact`'s enum had 2 of 5, so **Stories / Feed 4:5 / PMax
could not persist a canvas spec at all** (ValidationError).
`buildFormatConstraintsBlock` was `if (reels) else {feed 1:1}`, so **Stories was
told it was square with no safe zones** when it reserves 250px top and bottom
for the creator chip and reply input. `ARCHETYPE_WEIGHTING` had no Stories
entry. All three now table-driven; `scripts/verifyPlatformSurfaces.js` (51
checks) asserts the table IS the contract.

### Open, for the owner
- **Per-surface canonical templates** (owner authoring later). Instruction-level
  plumbing is ready. Still keyed by ASPECT RATIO not surface: canvas template
  variants, and Remotion titling (Stories and Reels share the `vertical`
  geometry class). Needed only if templates must differ at the geometry level.
- **`isReels` contract call.** It picks the video-storyboard output shape for
  `meta_reels_9_16` only. Stories accepts image AND video, so Stories video gets
  the static shape. Generalizing renames the Director's output schemas.
- **A real generation has NOT been re-run since the 600s timeout fix** (#37).
  Last real batch: 3/3 failed at the old 60s bound. Still the top verification.
- **`preparing`-phase status detail** — `GET /api/ads/runs/:runId` publishes no
  stage, so the UI can only show a bare spinner.
- **Reclaim pass** for abandoned-but-paid Atlas renders (unblocked by #38).
- `scoreQuote`'s `NEGATIVE_SENTIMENT` still hard-rejects a 5★ risk-reversal
  review quote. Same class of bug as #39, on the review ranking path.

Harnesses, all green: `verifyPlatformSurfaces` 51, `verifyQuoteGate` 47,
`verifySubmitGuard` 31, `verifyImagePricing` 9, `testAdRunSelection` 12,
`verifyTitlingFormats` 49.

---

## Earlier state (2026-07-31) — static-ad correctness pass, VERIFIED LIVE

Backend `main` @ PR #34. Frontend `master` @ PR #19. Everything below is
merged, deployed, and **confirmed in a real generated ad** (not just code
review). Five PRs this session: #28 #29 #30 #31 #35, plus frontend #18.

### What was wrong, and what proved it
An operator reported a Campus Crest T-Shirt ad carrying "Strength, in pink." /
"Training Straight Leg Leggings". Reading the LIVE generation inspector — not
the code — settled it: the campaign's creative brief said *"Goal: Introduce the
Gymshark Training Straight Leg Leggings in Strength Pink"*, and the Director
copied that product name verbatim into a t-shirt ad. It is visible in the
rendered pixels.

THREE independent cross-product vectors were found and fixed. Only the third
explains the reported copy:
1. `buildSeededUniverse` restrictToMediaIds mode filtered by brandId only, so
   every product's Director round got the SAME operator-picked media (#30).
2. `selectAdsForRun` had no product filter, so a run backfilled from the
   campaign's oldest queued ads for OTHER products (#31, recovered from
   `30125a1` which had sat unmerged on a branch since 28 Jul).
3. **The campaign brief names one product and was fed to every product's
   Director round under "concepts must serve it" (#35).** A prompt rule cannot
   win against contradictory context — the context had to change.

### Also fixed and verified
- Inspector reported the LAYOUT LLM's inputs where operators read the image
  model's. Now captures the real request at submit time (`Ad.imageGeneration`)
  and renders it. Reconstruction deleted, not relabelled.
- Direct path submitted TWO reference images; now ONE (the selected media),
  extras opt-in via `referenceMediaIds`.
- `deliveryLine`/`promoText` shared cascade sources → the offer painted twice,
  and `deliveryLine` draws with a TRUCK icon so "$28" read as shipping terms.
- Removed three fabrications: `'Ships free'`, `'53 reviews'`, `likes: 572`, and
  the brand-level rating/reviewCount fallback that credited one $28 tee with
  the brand's 41,000 reviews.
- Quote is shortened ONCE (`quoteSnippetService`), rendered verbatim; ≥4.5★
  gate; positive-sentiment + complete-thought; comments run the same path.
- Direct-overlay failures now fail LOUD per condition (credentials=fatal,
  missing layout=generic layout, no concept=error) instead of silently
  switching to the HTML pipeline. No ad can ship without a concept.

### Verified output (post-fix generation, same leggings-naming brief)
`SENT TO THE IMAGE MODEL: 1 image · openai/gpt-image-2/edit · seed-media`;
headline "MEET THE NEW ESSENTIAL"; quote 43 chars complete; deliveryLine
"Top Rated" != promoText "Just $22"; likes/reviewsText/rating all absent.

### MISTAKE TO NOT REPEAT
I pointed a new `quote-snippet` role at `openai/gpt-5-nano` after confirming it
was LISTED in the Atlas catalog. It is **listed but NOT routable** — HTTP 400
"router not found" — so every snippet call would have silently degraded to
mechanical truncation. PR #34's benchmark caught it and moved the role to
`google/gemini-2.5-flash-lite`. Verify a model ROUTES, not just that it exists.

## Open queue (owner-directed 2026-07-31, in his priority order)
1. **Generate Ads wizard does not scope to the clicked product** — clicking
   Generate Ads on a product row opens the wizard with a STALE selection (the
   URL carries only campaignId). One click from billing the wrong product.
   FIX FIRST.
2. **Status messages must be accurate and data-rich.** A run that queues
   nothing shows "Preparing creatives…" forever with no error or timeout.
   Owner wants the whole run watched end-to-end and every status audited.
3. **Stories and Feed must be separate templates.** `isReels` matches only
   `meta_reels_9_16`, so `meta_stories_9_16` falls into the Feed output-shape
   branch and gets NO archetype weighting. Owner: every surface deserving
   unique template treatment gets its own template.
4. Category-tier quotes + brand comments are acceptable to the owner ONLY when
   accurate and when no product-specific positive quote exists.

## Current state (2026-07-30) — static-ad diagnostics, PR #28 OPEN

Branch **`fix/truthful-image-gen-details`** → [PR #28](https://github.com/Emami-RS-Project/liquidretail_backend/pull/28)
(base `main`), frontend counterpart [liquidretail#18](https://github.com/Emami-RS-Project/liquidretail/pull/18)
(branch of the same name, base `master`). **Both open, NOT merged.** No live
render has exercised any of this yet — everything below is verified by code
reading, unit assertions, and three Grok adversarial passes, not by a
production ad.

Driven by an operator diagnostic session on two GymShark static ads. Five
separate defects, all confirmed in code:

1. **The inspector described a different request than the one that ran.** Its
   static branch showed `AiCanvasArtifact.promptImages` — the *layout LLM's*
   vision list — under a heading operators read as the image model's inputs.
   Meanwhile `directImageRenderService` submitted **two** images to gpt-image-2
   (`product.imageUrl` AND `media.fileUrl`) and persisted nothing about it. The
   reported "hallucinated back view" was neither hallucinated nor a model
   fault: it was a second reference we added and never displayed. Fixed by
   capturing the request where it becomes the POST body
   (`atlasImageService.buildSubmissionRecord`) onto `Ad.imageGeneration`, and
   by deleting the video path's *reconstructed* reference stack, which rebuilt
   a guess from the product's CURRENT catalog images. **Not backfilled** — old
   ads say so, and the warnings deliberately do not name a cause (an HTML
   render makes no image-model call at all).
2. **Two reference images by default → now one** (the selected media; product
   hero only when there is no media). Extra refs are opt-in via
   `referenceMediaIds`. Also closes a duplicate spend: merchant original vs
   Cloudinary mirror of the same photo defeats URL dedup and is billed twice.
3. **The offer painted twice.** `deliveryLine` and `promoText` shared their two
   top cascade sources, so "Only $28" rendered as both — and `deliveryLine`
   draws with a **truck icon**, so the offer read as shipping terms. Removing
   offer_text from it exposed a hardcoded literal `'Ships free'` underneath,
   asserting free shipping for every brand on the platform. Both gone.
4. **Testimonials.** `quoteSnippetService` already produced a ≤50-char
   word-safe extract and stored it as `primary_quote.snippet` — it was simply
   not in the static bind allow-list, so every layout took the full review and
   clipped it mid-word. Snippet is now bindable, always populated (it was only
   written when it *differed* from the text, i.e. absent for short quotes), and
   rendered **verbatim** — the first attempt told the HTML generator to re-cap
   at 60 chars, which is a second shortener on top of the first and exactly
   what strands a quote mid-thought. Per owner: shorten once, correctly.
   Added: ≥4.5★ gate (`QUOTE_MIN_RATING`) — the per-review star rating was
   being **discarded at ingest**, so selection judged wording alone; positive
   sentiment + complete-thought rules; at most ONE testimonial per ad
   (`secondary_quotes` was reachable). Comments now run the *identical*
   pipeline in both emitters — one had a raw `.slice(0, 200)` (mid-word, no
   sentiment gate at all).
5. **Cross-product contamination** — a Campus Crest T-Shirt ad rendered
   "straight leg leggings" copy. Right `productId`, right images, wrong
   language. Two brand-scoped paths reached a product-scoped ad: the layout
   quote cascade fell product → category → **brand** (brand reviews are
   catalog-wide), and — the real one — `aiCreativeDirectorService.assembleSignals`
   fell `productReviewQuotes[0] || brandReviewQuotes[0]`, handing the Director a
   brand review as `primary_quote` while COPY PICKS instructs it to ground copy
   on that field. Both gated on product scope. The numeric twin is fixed too:
   the meta cascade reached around `layoutInput.social_proof`'s existing
   `brand_match` gate straight to `Brand.brandReviews`, which is how a $28 tee
   advertised **41,000 reviews** and the brand's 3.3 rating; and `reviewsText`
   fell back to a literal `'53 reviews'`.

**Model cost:** the snippet role rode `gpt-4o-mini`, which the Atlas map points
at `gpt-5.6-luna` — **$1.00/$6.00 per 1M** for a substring search over a
≤400-char review. New `quote-snippet` role → `openai/gpt-5-nano` at
$0.05/$0.40 (verified against the live catalog 2026-07-30). Extraction was
also gated on `OPENAI_API_KEY` alone while Atlas is the primary route, so an
Atlas-only deployment silently fell back to mechanical truncation for every
quote.

**Grok adversarial review earned its keep three times** and each pass caught a
real defect *I had introduced*: an inspector warning that asserted "this ad
predates capture" (false for HTML-pipeline ads — the same untruthfulness the
commit existed to remove); allow-listing `.snippet` while it was only
sometimes written; and `isProductScoped` reading
`identification.details.catalogProductId`, which `productMatchHydration` never
writes — the guard would have been false on real product ads and leaked the
quotes it exists to withhold.

### Open follow-ups from this session
- **Not verified against a live render.** Generate one static ad per pipeline
  and confirm via Generation Details that `imageGeneration` shows one image
  with its role, and that no testimonial exceeds 60 chars or repeats.
- **`QUOTE_REQUIRE_RATING` is `false`.** Per-review stars were never stored
  before this change, so every already-synced product has unrated quotes and
  requiring a star outright would strip testimonials catalog-wide. Flip to
  `true` once products have been re-synced.
- **Category-tier quotes and brand comments are still cross-product** sources
  on a product ad (Grok finding #3 on the last pass) — same class as the brand
  tier, not yet gated.
- **Legacy `buildPrompt` (V1 Director, `:560`) lacks the ONE PRODUCT ONLY
  line.** It emits strategy only, not `copy_picks`, so it is low risk — add it
  if V1 can still run.
- `aiImageReferenceService` (photoreal / image-ref shadow path) still does not
  record its image-model request; only `directImageRenderService` does.

## Prior state (2026-07-29)

Branch **`claude/architecture-review-grok-elfqxc`** at `c79e606`, pushed. Trunk is
`main`.

**Start by reading the new root `CLAUDE.md`.** It was written this session precisely
so the discoveries below are not re-made. Its §0 and §1 (how to tell what is live,
and the dead-path register) are the load-bearing parts.

### Shipped today (`c79e606`)

Billable-submit hardening in `services/atlasVideoService.js`:
- `pacedModelSubmit` — per-model submit spacing (`ATLAS_SUBMIT_SPACING_MS`, 1200ms),
  ported from the expander. In-memory, so NOT global across web instances.
- `isDefinite429` — replay requires a *structured* 429; loose "rate limit" prose no
  longer buys a second billable POST. `isRateLimit` stays as-is for polling.
- `submitRetryDecision()` extracted so the replay choice is one pure function.
- `maxRedirects: 0` on **both** billable POSTs — axios defaults to 21 and re-sends the
  body on 307/308, a silent double charge inside one call.
- Two regex bugs, both found by adversarial review + the new tests, both revert-proven:
  missing digit boundary (`code: 42901` matched → replay) and JSON-quoted keys never
  matching (`"code":429`).
- `scripts/verifySubmitGuard.js` — 31 offline checks, no DB/network/key.

`config/defaults.env`: **`ATLAS_VIDEO_RESOLUTION=1080p`** — free (Atlas prices 720p and
1080p identically) and matches every `deliveryDims` in `platformFormats.js`.

Docs: new root `CLAUDE.md`, new `docs/CLOUDINARY-VIDEO.md`, new `docs/ATLAS.md` §7,
plus **corrections to `docs/TITLING.md` and `docs/PIPELINES.md`, which documented the
commented-out canvas cascade as if it were live** — that stale doc is what caused the
wrong turns this session.

### Discovered this session — the expensive ones

1. **Canvas titling is kill-switched.** `resolveTitlingEngine` returns remotion
   unconditionally (`brandScriptExecutor.js:806`). Remotion is the only engine.
   Video framing therefore lives in `remotion/components/BasePlate.jsx:18,28`, not in
   `brandScriptExecutor`'s sharp resizes or the `brandScripts/*.script.js` files.
2. **`/ads.html` is not published.** On `staging.reach-social.io` it returns the
   655-byte Vite shell, byte-identical to `/`. So `renderViaSpec` cannot work, and the
   7 `status: active` legacy templates in the catalog cannot render at all.
   **Owner decision: retire it** (task #10) — the DB is expected to be wiped before
   production, so re-rendering old ads the old way is not wanted.
3. **Cloudinary video has no face gravity** (`g_face`, `g_xy_center` both 400) and
   `fl_relative` does not apply to base assets. `g_auto` works but is async per asset
   (423 → 200). Explicit `c_crop` with a `c_scale` prefix is the viable approach.
4. **Each aspect ratio is a separate billable generation** — 1:1 + 4:5 + 9:16 = three
   submits, and 1:1/4:5 force-route to Grok because Omni is 16:9/9:16 only. Generate
   once at 9:16 and crop down is the obvious saving, and is what the face-safe crop
   port would make safe.
5. **No media endpoint supports a system prompt.** The inspector's
   "Layout prompt (system/user)" is the LLM spec-generator's call, not the image
   model's.
6. **`node_modules` is gitignored but 4930 files are tracked, and the tree is
   incomplete** — `https-proxy-agent` is missing, so `require('axios')` throws. See
   `CLAUDE.md` §4 for the restore recipe that does not dirty the commit.

### Open, in priority order

Full plan lives outside the repo (this session's plan file). Short form:
1. Retire the legacy render path — task #10, owner-approved.
2. Per-model prompt caps: `routes/ads.js:69` rejects `videoPromptRaw > 4000` chars
   regardless of model, so an Omni prompt legal at 20,000 is refused at ~4,300.
   Measured: on Grok, ~400 chars of guidance silently drops `PHYSICAL ACCURACY`.
3. Port the expander's face-safe crop geometry. Live insertion point is
   `buildCloudinaryCropUrl` + its winner sites — **not** `pickHeroSourceRatio`, which
   is legacy-only and returns null for every `ai_*` template.
4. Raw system+user prompt view/edit for static ads (read path already exists,
   read-only, in `GenerationInspectorModal.tsx:217-219`).
5. Not started, and gates multi-user: rendering runs in the web process via
   `setImmediate`, one Chromium per static render with no cap, per-process
   concurrency gates, nothing drains `Ad{status:'queued'}`. See
   `ARCHITECTURE_REVIEW.md` "The render-queue architecture problem".

## Prior state (2026-07-27)

### Shipped today
`main` is at **`074babb`** with four merged PRs — #15 reframe port +
product-only pad + claim lease, #16 explicit seed count + stale re-derive,
#17 related media can seed a video (with product anchor), #18 inspector
records the images the model *actually* received. Frontend `master` at
`742bd0e` (#11). Both Render services live on `074babb`.

### Diagnosed: why video batches stall (2026-07-27)
Ad rendering — **including paid video generation** — runs in-process on the
**web** service as a fire-and-forget `setImmediate` after the 202
(`routes/ads.js runRenderLoop`), at `VEO_CONCURRENCY=1` ≈ 1 min/ad, so a
20-ad batch holds that process 25–35 min. The process does not live that
long: deploys replace it, **and Render autoscaling replaces it too**
(web service is `min 1 / max 3`, CPU *and* memory triggers at 60% — a render
batch is itself a scale trigger). Instance replacement kills the loop
silently. Ads sit in `rendering` → the worker's reaper flips them to
`queued` after 15 min → **nothing drains `queued`** (`selectAdsForRun` is
only reachable from `POST /api/ads/generate` and `POST /api/ads/runs`), so
work stops until a human presses *Generate more*.

Evidence: 20-ad batch started 18:48:22, killed by the 18:51:44 deploy,
15 ads reclaimed at 19:07:12 and stranded. Also found: an autoscale-driven
instance boot at 19:00:41 with no deploy behind it, and `RENDER_AUTH_TOKEN`
expired since 2026-05-07 (per-request token normally wins, so not currently
breaking renders — worth clearing anyway).

### In progress: Telegram alerting (branch `feat/telegram-alerts`)
New `services/alertService.js` (transport + dedupe + rate limit),
`processAlerts.js` (crash/SIGTERM — the codebase previously had **zero**
`uncaughtException`/`unhandledRejection` handlers), `backlogWatchdog.js`
(wedged renders, stalled runs, detect backlog, trailing-hour spend),
`inFlight.js` (what a shutdown is about to orphan). Wired into `index.js`,
`worker.js` (reaper alert + watchdog timer), `routes/ads.js` (run crash, run
failed, video failed). Docs: **`docs/ALERTING.md`**.

Secrets `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` must be set **in Render
env on both services** — names only in `.env.example`; `ALERT_*` tuning in
`config/defaults.env`. Alerting stays silently disabled until both are set.

Verified: 20 + 14 unit assertions on alertService (dedupe, escape,
tag-balance under hostile input, token redaction, map pruning, never-throws)
and 8 child-process assertions on exit semantics (SIGTERM re-raises to
Node's default disposition; crashes still `exit(1)`).

### Fixed in the same branch: reaper false-reap / double-spend window
Pre-existing: ads are bulk-claimed with ONE `updatedAt` stamp before the
loop, and the reaper flips `rendering→queued` at 15 min stale — so the tail
ads of any healthy >15-min serialized video batch were reclaimed MID-RUN
(renderOne renders by id with no status check), where a concurrent
"Generate more" could select the same ad into a second run → two billable
video POSTs for one ad. Same flaw run-level: CampaignRun was reaped on
`startedAt`, failing any healthy run older than 15 min. Fix: per-completion
heartbeat on the run's still-`rendering` ads (`routes/ads.js`), and the run
reap filter moved to `updatedAt` (auto-refreshed by every `$inc` —
`_setTimestampsOnUpdate` hook verified registered). Also removed the
reaper's `campaignRunId: null` write — singular field absent from the Ad
schema, silently stripped by `strict:true` since day one.

Grok adversarial pass earned its keep again: caught a real SIGTERM hang in
MY first version (re-raise assumes ours is the last listener; puppeteer
registers a non-exiting SIGTERM handler on every launch — reproduced, fixed
with a hard 1s exit timer behind the re-raise, exit code 143) and a
sync-throw risk in the veo catch that would have wedged the failure
bookkeeping.

### Known gap, NOT closed
Alerts report dropped work; they don't resume it. The real fix is a durable
worker-drained ad queue (let `worker.js` claim `Ad{status:'queued'}` the way
it claims `DetectRun`) so an instance replacement costs one ad, not a batch.
Deliberately unbundled — it changes claim/lease semantics on a billable POST.
Interim: smaller `MAX_CREATIVES_PER_RUN`, or pin the web service to
`max: 1` instance so scale-in stops being a cause.

### Cost note worth acting on
`google/gemini-omni-flash/image-to-video-developer` supports **16:9 / 9:16
only**, so every **4:5 Feed** video falls back to
`xai/grok-imagine-video-v1.5/image-to-video` (ledger `$0.50/s` ≈ **$4.00** per
8s clip vs ~$1.00) *and* gets remapped 4:5 → 3:4, which then fails titling
layout (`Template ai_brand_led does not support aspect ratio 3:4`). The
$0.50/s rate is flagged UNVERIFIED in `MODEL_CAPS` — a real invoice should
confirm it.

## Prior state (2026-07-23)
**Docs:** `docs/PIPELINES.md` §6 (+ intro date + quick map) updated for
deterministic-first video (backend PRs #11/#12/#13, frontend #10) —
verified against `campaignAdsGenerationService` / `atlasVideoService` /
cascades / wizard API. Doc edit uncommitted unless committed with this session.

**Prior:** Deterministic-video **Phases 1+2+3** implemented (code). Design:
`~/.claude-work/plans/compiled-inventing-babbage.md`.

**Phase 3 (this session):** `Ad.referenceMediaIds` (ordered operator stack);
`expandDeterministicVideo` + namespaced `computeDeterministicVideoDigest`
(`det-video:v1`); routing restructure (deterministic first, director
opt-in via `directorVariants`, brand campaigns stay director);
`mergeExpansionResults`; ordered render via `buildReferenceImages({orderedReferenceMedia})`;
`GET /api/ads/veo-prompt-scaffold`; `/preview`+`/generate` accept
`directorVariants`, `seedMediaIds`, `videoPromptGuidance`, `videoPromptRaw`.
Static image path / aiCanvas / gpt-image untouched.

Touched (Phase 3): `models/Ad.js`, `services/campaignAdsGenerationService.js`,
`services/atlasVideoService.js`, `routes/ads.js`. All pass `node --check`.

## Prior state (2026-07-22)
**Shipped.** The titling-engine batch described below is committed, pushed,
reviewed, and merged into `main` — no longer pending or uncommitted.

- [PR #2](https://github.com/Emami-RS-Project/liquidretail_backend/pull/2) — the feature batch itself, merged (`3a991f1`).
- [PR #3](https://github.com/Emami-RS-Project/liquidretail_backend/pull/3) — a same-day follow-up fix from an independent adversarial re-review (see below), merged (`49a3c0f`).

### What shipped (frontend/app)
1. **Remotion is the default titling engine** (`brandScriptExecutor.resolveTitlingEngine` fallthrough; custom-script brands still force canvas; brand/env overrides unchanged). Owner confirmed Remotion license is fine (<3 employees → free tier).
2. **`titlePlacementMode: 'canonical' | 'content'`** — default canonical = fully static spec anchors (skips `analyzePlate`, `plateHints:null`, no nudge/no ink flip); content = plate scan + nudge + ink flip. Precedence: request > `Brand.videoSettings.titlePlacementMode` > canonical; `TITLE_PLATE_SCAN=off` is the global kill switch. Threaded through renderTitles/renderPreview/title-still/preview-script.
3. **No-scrim validator defaults** — `titleSpecValidator` treatment fallbacks now `scrim:'none'`, `shadow:'layered'`.
4. **Per-ad copy override** — `PATCH /api/ads/:id` accepts `{status? , copy?}` (headline/cta_text/quote/productName/productPrice, dotted $set paths).
5. **Batch re-title** — `POST /api/brand/:id/retitle-videos` (dryRun sync; live async 202+jobId, poll `GET .../:jobId`, tenant-scoped, 5-min reap). Re-renders titles over retained `veoVideoUrl` base videos.
6. **Transparent-image fix** — `Brand.websiteBackground` (captured in enrichment via static-HTML heuristic, never theme-color), `utils/websiteBackground.js` helper, `b_rgb:<hex>` flatten BEFORE `c_fill` in the two image-seed transforms (`aiVideoReferenceService.deriveAspectCroppedImageUrl`, `atlasVideoService.cropImageUrlForAspect`); white default when uncaptured.
7. **Vertical safe zone tightened** — `remotion/lib/safeZones.js` top 0.121→0.14, bottom 0.16→0.35 (Meta Reels clear zones). Frontend island mirror updated in lockstep (see frontend repo).
8. Docs updated: `docs/TITLING.md` (engine default, placement mode, retitle contract, safe zones), `docs/ai-creative-pipeline.md` (transparency section + follow-up surfaces).

### Fixed in the follow-up (PR #3)
A fresh independent Grok adversarial pass (run before merging, on the staged diff — separate from whatever review happened when this was originally drafted) found `routes/ads.js`'s `projectAd()` preferring `ad.copy.cta_text` over the raw `ad.ctaText`. `metaAdsPushService.js` reads `ad.ctaText` directly from the Mongoose doc (bypassing this projection), so the live Meta push was never affected — but the API response could show operators the wrong field. Reverted to the raw field in `ads.js` only; `routes/catalog.js`/`routes/campaigns.js` keep the copy-preferring behavior since `ProductAds/index.tsx`'s edit box genuinely depends on it (traced and confirmed before deciding not to touch those two).

## Known follow-ups
- **Propagation**: after deploy, run batch re-title per brand (`dryRun:true` first) to apply new defaults to existing videos. Videos already exported to ad platforms need re-export.
- **Backend PR #6 (2026-07-22, shipped, paired with frontend PR #6)**: `services/genericCatalogIngestService.js`'s save-phase progress note changed from a raw review count to `saved X/Y products · Z% with reviews` (Z = reviewsCaptured/idx); catalog save stage renamed `'upserting catalog products'` → `'saving products to catalog'`. `GET /api/sales-demos/brands` (`routes/salesDemos.js`) now returns `reviewedProductCount` per brand, consumed by the frontend Sales Demos brand card's "review coverage %" badge. Docs updated: `docs/PROGRESS.md` (demo-sync table row + new "Sales Demos — brand list review coverage" section).
- **Backfill**: existing brands have no `websiteBackground` until re-enriched (transforms default to white meanwhile).
- **Not-yet-covered transparency surfaces** (listed in ai-creative-pipeline.md): HTML template `panel_bg`/body for static image ads; Remotion plate fallback `#3D3D3D`; legacy `videoCompositeService` `b_black` chain; `layoutInputService` crop URLs.
- Multi-instance caveat: retitle/preview job stores are in-memory (single-instance).
- Canvas engine still scrim-based + brand-font-poor by design — only reachable via custom scripts or explicit engine override now.
- **Not yet verified** (raised by the adversarial pass, plausible but unconfirmed): `plateIntelService.analyzePlate`'s `BANDS` were retuned for vertical's new safe zone, but the function takes no `format` param — could misapply vertical geometry if `titlePlacementMode:'content'` is ever used on a feed-format ad. Narrow blast radius (content mode is opt-in; default is canonical). Worth a look before anyone flips a brand to content mode on feed placements.
- **`postinstall`'s `npx remotion browser ensure` has never once succeeded** — found 2026-07-31 via live prod logs. Every build logs `npm error could not determine executable to run` (~10×/day across deploys, seen at 05:37, 06:43, 12:01, 17:32 …). Cause: the `remotion` CLI binary ships in **`@remotion/cli`**, which is **not a dependency** — 13 `@remotion/*` packages are installed at 4.0.495, `@remotion/cli` is absent, so `node_modules/.bin/remotion` does not exist. The `|| true` in `postinstall` swallows it and the build still reports "Build successful 🎉".
  **Currently harmless, but latent.** Verified on the live instance that a working browser *is* present anyway: `node_modules/.remotion/chrome-headless-shell/linux64/.../chrome-headless-shell`, 219MB, executable, reports **Chromium 149.0.7790.0**. It arrives via the tracked-`node_modules` tree / build cache (mtime matches build time), **not** via the ensure step. So Remotion renders fine today — the risk is that the repair step is a no-op: if that binary is ever missing from the cache or the tracked tree, nothing self-heals it. This is the same failure shape as the Puppeteer-cache bug already recorded in the workspace `session.md`.
  Fix is either add `@remotion/cli` as a devDependency, or drop the dead `npx remotion browser ensure` and rely on `@remotion/renderer`'s own `ensureBrowser()`. **Do not** just delete the `|| true` — that would turn a silent no-op into a hard build failure.
- **Atlas/LLM cost-ledger gap — dev prototype harnesses silently drop `CostLog` rows (found 2026-08-01, NOT fixed).** `prototypes-2026-07-31/gpt2test/*` (~20 one-off scripts — `run.js`, `bakeoff/*`, `nametest.js`, `reliability.js`, `soludos/run.js`, etc.) `require()` the REAL `services/atlasImageService.js` / `atlasLlmService.js` straight out of this repo (not copies), so every generation they run is a real billable Atlas call — but none of these scripts ever open a Mongoose/Mongo connection. `costTracker.persistCost`'s `CostLog.create(...)` therefore almost certainly hits Mongoose's connection-buffering timeout (default ~10s) and fails silently (the generic `catch` branch, `console.warn` only — not the loud schema-drift/`ValidationError` path), so every dollar these harnesses spend (session.md already documents ~$1.28 + ~$0.80 + ~$0.48 across three named A/B runs alone, plus ~15 other scripts) is invisible to the ledger, and each Atlas call in them likely eats an extra ~10s hang on the buffer timeout. Reasoned from the code, not confirmed by running anything (that would spend real money). Not a defect in the harnesses themselves — they're intentionally throwaway and were never meant to hit prod Mongo. Fix, if wanted, is narrow: either (a) have these scripts open a short-lived Mongoose connection before calling the real services so genuine dev spend gets ledgered, or (b) give `costTracker` a no-DB/local mode (stdout or a local JSON file) so ad-hoc dev spend is visible without touching prod data. Owner call: test harness itself is fine as-is; this is a note to fix the ledgering gap, not the harness.
- **Atlas/LLM cost-ledger audit (2026-08-01) — 17 confirmed LIVE gaps found (real spend, zero `CostLog` row), 8 partial.** Full 69-call-site audit run as an 8-group Workflow (Grok find + independent adversarial verify per group, 0 errors) plus manual spot-checks; report not committed to the repo, ask the session that ran it if the file is still needed. Priority order to fix:
  1. **`services/providers/geminiSearchProvider.js`** — all 4 exported functions (`match` 100-108, `lookupBrandCategoryUrl` 187-195 [dead, no live caller], `lookupBrandReviews` 250-258+296-337, `lookupProductReviews` 395-403+439-481) fire raw `axios.post` to Gemini's grounded-search endpoint with zero `costTracker` reference in the file. `match()`/`lookupProductReviews()`/`lookupBrandReviews()` are LIVE — `match()` fires on essentially every DetectRun via `pipelines/detect.js` → `runProductMatchChain`; `lookupProductReviews()` also fires synchronously from an operator button, `routes/integrations.js:824` `POST /api/integrations/instagram/catalog/:productId/refresh-reviews`. Highest call-volume gap found. Also unlogged via the same pattern: `services/productDetailsService.js` (`serp()` SerpAPI Google Shopping/Immersive calls — not LLM but same invisibility — plus a real `fetchReviewSummary()` Gemini call, fires on every catalog sync) and `services/categoryReviewsService.js fetchCategoryReviews()` (Tier-2.5 of `productMatchService.enrichOneMatchInPlace`).
  2. **`services/atlasImageService.js directOpenAiImages()`** (475-490) — the direct-OpenAI fallback (`images.generate`/`images.edit`) used by `generateImage()`/`editImage()` whenever the Atlas leg fails, has ZERO `recordFlatCost`/`trackLlmCall` call — directly contradicts the file's own comment at 534-539 claiming "OpenAI via its own recordFlatCost path" (no such path exists). Reachable from all 6 production consumers, most importantly **`services/directImageRenderService.js`** — its own header calls it *"THE production static-ad render path"* — so an Atlas outage during static-ad gen means invisible OpenAI spend on the core feature. Also inherited by `services/personaAvatarService.js` (live, `POST /api/brand/:id/personas/:index/avatar`) and `services/openaiService.js`'s DALL-E marketing-image step (`fallbackModel:'dall-e-3'` explicitly configured).
  3. **`services/atlasTextService.js`** — a second Claude-via-Atlas transport, completely separate from `atlasLlmService.js`, zero `costTracker` reference anywhere. 3 live call sites in `routes/brand.js` (~1558 `runModifyTitleSpec` title-spec chat edits, up to 2 retries; ~1852 canvas-theme JSON gen; ~2157 canvas-script gen/modification, `maxTokens:12000` — the largest single unlogged call found).
  4. **`services/aiVideoReferenceService.js`** — the direct-Google Veo 3.1 "vertex" fallback video path (`submitVeoJob`), zero `costTracker` reference in the 415-line file. Dormant only because `config/defaults.env` sets `VIDEO_PROVIDER=atlas` (default); `services/videoRouter.js` is the only gate and adds no warning on the unlogged branch. Would silently leak spend (video is the most expensive per-call surface, ~$1-2.40/render) the moment anyone flips `VIDEO_PROVIDER=vertex` during an Atlas outage.
  5. **`services/geminiImageService.js polishImage()`** — rows ARE written (both callers, `aiVideoPosterService`/`aiOverlayPolishService`, wrap it in `trackLlmCall`), but `costTracker.MODEL_RATES` has no entry for `'gemini-2.5-flash-image'` (only `'gemini-2.5-flash'`, no `-image` suffix) — every call logs **$0**. Also double-counts: when the Atlas leg succeeds, `atlasImageService.editImage()` already records the real price internally, so a successful call writes two rows (one real, one duplicate $0).
  Lower-priority partials (rows written, coverage/accuracy incomplete): `atlasImageService.submitAndPoll()` and `atlasVideoService.js`'s video-submit + reframe-submit charge points have no try/catch around the raw axios call, so a network-level exception (not an HTTP error) after a successful, already-billed submit skips the ledger row entirely; `atlasVideoService.js` never stamps `providerRequestId` on video rows, so `reconcileCost()` can never upgrade an estimated video cost to actual (permanently affects the still-`UNVERIFIED` `xai/grok-imagine-video-v1.5` pricing flagged since 2026-07-21). Confirmed dead code, no action needed: `services/whisperService.js transcribeAudio()` (caller never invoked), `services/openaiImageService.js` (mask inpainting — zero callers anywhere, `docs/ATLAS.md` §3 still lists it as live, doc is stale), `services/aiImageReferenceService.js` (shadow wiring deliberately removed 2026-07-31). 44 of 69 call sites audited are correctly ledgered.

## Session log
- 2026-07-22: All of the above implemented (Grok CLI drafted; Fable reviewed line-by-line + one hand-edit: guardrail defaults to Reels bands when chrome=None; adversarial Grok pass run pre-commit). Owner decisions: corrections now / calibrate later; guardrail toggle yes; tighten vertical safe zone now.
- 2026-07-22 (adversarial round): fixed — draft-wipe race (prop-sync now gated by previous-prop-equality ref; regen poller freshens headline/ctaText from response), stale-response guards via live openAdIdRef in all save/re-render handlers, exported-ad gating added to legacy Ads page, re-render no longer requires a prior copy save (standalone re-title after placement changes), inputs disabled during regen, image-ad copy note, honest no-URL toast. Known bounded race: a poller tick landing mid-save can briefly clobber onMutated state; next tick self-corrects. Backend now shallow-merges videoSettings, so multi-card PATCH spreads are safe.
- 2026-07-22 (ship): committed, pushed, PR'd (#2), independently re-reviewed (fresh Grok adversarial pass on the actual staged diff — separate from the drafting-time review above), one real issue confirmed and fixed same-day (ctaText/overlay-text conflation, PR #3). Both merged into `main`, commits Verified server-side.
- 2026-07-22 (sales demos, PR #6): review-coverage % progress note + stage rename in `genericCatalogIngestService.js`, `reviewedProductCount` added to `GET /api/sales-demos/brands` (paired with frontend PR #6's brand-card badge). Merged. Docs updated (`docs/PROGRESS.md`).
