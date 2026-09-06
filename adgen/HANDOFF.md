# Handoff — cloud session → local session

**Branch:** `claude/dazzling-darwin-bv5fni` (restarted from `master` — PR #118
and #130 are both already merged, so that history is in `master`).
**Commit:** `9cf2551`.
**Why a handoff:** this cloud session cannot reach MongoDB. All outbound
traffic goes through an HTTP/HTTPS-only proxy, and MongoDB's wire protocol is
raw TCP on 27017, so `mongoose.connect` fails no matter how Atlas Network
Access is configured. Confirmed twice. Anything needing the database — the
live A/B below included — has to run locally.

---

## ⚠️ FIRST TASK FOR THE NEXT SESSION: get on the right branch, then re-verify

**Do this before anything else, without being asked.** Nick's machine has more
installed than this cloud container did, so environment differences are
expected — **install whatever is missing rather than reporting it as an error.**

1. **Get on the right branch.** `git fetch && git status`. The work is on
   `claude/dazzling-darwin-bv5fni`. If the local checkout is on `master`, an
   old PR branch, or has a dirty tree, sort that out first (stash or commit
   anything real — do not discard work you did not create).
2. **Node ≥ 20** (`package.json` engines). Install via Homebrew if absent.
3. **`npm install`** — the committed `node_modules` is deliberately incomplete;
   a fresh clone WILL fail without this.
4. Install anything else that turns out to be missing. Nick has bypass
   permissions on and expects you to just fix it.

**Do not trust the verification claims in this file — re-run them:**

```
npm run lint
node scripts/verifyRpdHarness.js    # expect 67/67
npm test                            # expect 3 pre-existing failures, see below
node scripts/rpd/rpd.js prompt --core                                  # the REAL prompt
node scripts/rpd/rpd.js run scripts/rpd/specs/starter-single-video.json
node scripts/rpd/rpd.js run scripts/rpd/specs/example-prompt-ab.json
```

The last two are free dry runs. Expect: starter = 1 cell; example-ab = 3 cells,
**3 distinct prompts, no duplicate warning**. If a duplicate warning appears,
a prompt lever regressed again — that is exactly what the new guard is for.

**Known pre-existing failures in `npm test` (NOT caused by this work** —
confirmed by stashing the changes and re-running on clean `master`, where they
also fail): `verifyModelParity.js`, `verifyOperatorPromptPrecedence.js`,
`verifyVendorDrift.js`. The drift one is bookkeeping: backend moved on
`models/Brand.js`, `services/systemConfigService.js`,
`services/videoBenefitsDirector.js`. Worth reconciling separately.

---

## 1. WHAT SHIPPED (commit `9cf2551`)

### The money bug

A `--live` run of the shipped `specs/example-prompt-ab.json` would have spent
**$3.00 and produced only two distinct videos.** Proven by hashing each cell's
built prompt out of a dry run's `manifest.json`:

| variant | lever | prompt sha | verdict |
|---|---|---|---|
| `baseline` | none | `fa93c8f8` | control |
| `hook-first` | `guidance` | `691a9ff5` | works |
| `objective-rewrite` | `directives` | `fa93c8f8` | **identical to baseline — $1.00 wasted** |
| `no-crossfades` | `patch` | — | skipped (find-string absent from CORE) |

Root cause: the video prompt became **one frozen CORE paragraph** on
2026-09-03/04, so per-element `directives` overrides are inert. `SKILL.md`
warned about it, but `rpd.js prompt` still printed a paste-ready `directives`
snippet as *the* way to test a replacement — steering users straight into a
silent no-op that still bills.

### Fixes

- **`scripts/rpd/lib/runner.js`** — `cellFingerprint` / `findDuplicateCells` /
  `assertNoDuplicateCells`. The fingerprint is the whole submission identity
  (model + prompt + seed images + aspect/duration/resolution), **not just the
  prompt**, because a matrix over several products legitimately shares a
  prompt. Dry run warns for free; `--live` refuses.
  `--allow-duplicate-prompts` opts in for a deliberate variance test.
- **`runner.js`** — provider-aware credential check. `ATLAS_API_KEY` was
  required for *any* `--live` run, which refused a Gemini-only experiment even
  though **Gemini is the live production provider**.
- **`scripts/rpd/rpd.js`** — `prompt` no longer advertises `directives`;
  points at `guidance` / `raw` / `patch`.
- **`specs/example-prompt-ab.json`** — dead variant removed, patch repointed at
  text that exists in CORE, and `models[]` pinned to `gemini-omni-1.1-flash` so
  **baseline means production**.
- **`specs/starter-single-video.json`** (new) — exactly one video.
- **`SKILL.md`** — newbie mode (below).
- **`LOCAL_SETUP.md`** — corrected non-technical setup.

### Newbie mode (in `SKILL.md`)

Triggers when someone says they're not technical or is following a handoff.
Rules: self-repair the environment before answering anything; **one video
unless a comparison was explicitly asked for**; **baseline is production**;
**Atlas only on specific request** — and when requested, show
`rpd.js models` and help pick, including models not in production; always
dry-run and state the price; show seed images as numbered thumbnails and ask
for ordering; explain in plain English.

---

## 2. ⭐ PRIMARY DELIVERABLE — a zero-reading package for the colleague

**Nick's requirement, verbatim: "he shouldn't need to read anything."**
`LOCAL_SETUP.md` (shipped in this branch) is a *fallback*, not the deliverable.
Build the thing he runs.

**Target: he receives one file, double-clicks it, and ends up in a working
Claude Code session that is already in newbie mode.** No terminal literacy, no
branch reasoning, no copy-pasting a paragraph from a doc.

Suggested shape — a zip containing a macOS `START-HERE.command` (chmod +x, so
it runs on double-click) that:

1. Detects and installs what's missing — Homebrew, `gh`, Node ≥ 20. Do not
   report a missing dependency as an error; install it.
2. Runs `gh auth login` if not already authenticated (this is the one step
   that needs him, and it's browser-based — walk him through it in the
   script's own printed output, in plain language).
3. Clones `Emami-RS-Project/liquidretail_adgen` to `~/Projects` if absent;
   otherwise `git checkout master && git pull`.
4. `npm install`.
5. Writes `.env` from a `keys.txt` sitting beside the script — Nick drops the
   real values in before sending. **Quote the values**: `MONGODB_URI` contains
   an unquoted `&` today, which breaks shell sourcing (hit in this session).
6. Verifies it actually works before declaring success — run
   `node scripts/rpd/rpd.js models` and a dry run; if either fails, print
   what's wrong in plain English rather than a stack trace.
7. Copies the newbie first-message to the clipboard (`pbcopy`) and prints:
   *"Open Claude Code → Code tab → Local → select the liquidretail_adgen
   folder → paste (⌘V) → Enter."*

Then **test it end to end the way he will experience it** — ideally on a clean
user account or a fresh directory, not on a machine that already has
everything. The failure mode to hunt for is "works on Nick's machine".

If a `.command` file is awkward to deliver (Gatekeeper will warn on an
unsigned download — tell him to right-click → Open the first time), a
one-line `curl … | bash` from a gist is an acceptable alternative. Nick's
call; optimise for fewest actions.

## 2b. UNBLOCKING THE COLLEAGUE (the manual path, if the package isn't ready)

He ran `gh pr checkout 118` and the skill didn't load. Two causes: PR #118 is
**merged**, so that branch was stale (everything is on `master`); and he ran it
*inside* a running Claude Code session, which registers skills at start.

**He needs:** be on `master` (or this branch), quit and reopen Claude Code,
`npm install`, Node ≥ 20, and `GEMINI_VIDEO_API_KEY` (the one that matters —
production is Gemini) plus `ATLAS_API_KEY` only if testing Atlas models.
`MONGODB_URI` is optional and only enables `spec.seed.productId`.

`LOCAL_SETUP.md` in this repo has the full walkthrough and the first message
to paste.

⚠️ **Correction — I got MONGODB_URI wrong twice, in opposite directions.**
`references/operations.md` claimed *"not needed — the harness never touches
Mongo"*, I repeated it, and it is **false**: `lib/dbSeed.js:60` throws without
it and then connects to read `CatalogProduct` + `Media` + `Brand`. The doc row
is fixed on this branch. The truth is two seeding modes:

- `seed.url` — paste a Cloudinary URL. No Mongo. **Fixture** brand styling.
- `seed.productId` — needs `MONGODB_URI`. Gives the merchant-feed primary, the
  real reference stack, and the product's real brand identity for titling.

**`seed.productId` is the mode that matters** — a prompt A/B seeded from a
hand-picked URL isn't testing what production sends. So the colleague DOES want
`MONGODB_URI`, and Nick is already providing it.

---

## 3. NOT DONE — the live A/B Nick asked for

**Requested:** a live A/B using his prompt change *"Limit scene changes to no
more than 3 cuts"*, real money, show both videos.

**Blocked only by:** no seed image. Mongo is unreachable here so
`seed.productId` can't resolve, and there is no real product image URL in the
repo (all Cloudinary URLs in-tree are placeholders like `catalog-product/x/hero.jpg`).
Keys are present in `.env` (`GEMINI_VIDEO_API_KEY`, `ATLAS_API_KEY`,
`MONGODB_URI`) — Mongo just can't be reached from the cloud.

**To run it locally**, copy `specs/example-prompt-ab.json`, set the seed to a
real product, and replace the variants with:

```json
"variants": [
  { "id": "baseline" },
  { "id": "max-3-cuts",
    "guidance": "Limit scene changes to no more than 3 cuts." }
]
```

Seed either by `"seed": { "productId": "<CatalogProduct _id>" }` (works
locally — Mongo is reachable there) or a real Cloudinary URL. Then:

```
node scripts/rpd/rpd.js run <spec>                       # free, confirms 2 distinct prompts
node scripts/rpd/rpd.js run <spec> --live --max-usd 2.50 # ~$1.62 on gemini-omni-1.1-flash
node scripts/rpd/rpd.js gallery <runDir>                 # side-by-side
```

⚠️ Use `guidance`, not `directives` — and if the duplicate guard fires, the
lever didn't apply. Note `.env` has an **unquoted `&`** in `MONGODB_URI`, which
breaks shell `source`; load it with dotenv or quote the value.

---

## 3a. ADVERSE REVIEW OF THE HARNESS — top finding NOT yet fixed

An adversarial review ran over `scripts/rpd/`. It caught three bugs **in my own
new code**, which I then fixed (`variantLevers` was never assigned so the
duplicate diagnostic always said "(baseline)"; `rpd prompt --core` was
advertised but unimplemented; the new gate had no harness coverage). What
remains:

**🔴 HIGHEST VALUE, NOT DONE — re-running `run --live` re-bills the entire
matrix, and nothing detects it.** Every `run` mints a new timestamped dir and
submits everything again. My new duplicate gate is **intra-run only** — it
never looks at prior manifests under `--out`. The likely newcomer sequence is:
poll times out → cell sits `submitted` → user re-runs → **pays twice for every
cell**. `references/operations.md:77` warns in prose; nothing enforces it.
*Fix:* before a `--live` run, scan `<outRoot>/*/manifest.json` for a cell with
the same `cellFingerprint` that already holds a `predictionId`; refuse and
print `rpd resume <dir>`. This is the same idea as the gate that landed,
applied across runs — which is where the money actually leaks.

Other confirmed, unfixed:
- **`spec.resolution` is silently ignored on non-omni models.** Proven:
  `ATLAS_VIDEO_RESOLUTION=1080p` → Omni body `1080p`, Grok body `720p`. The
  shipped `example-model-shootout.json` therefore dry-runs as **1080p vs 720p
  at ~$5.00** while the gallery header claims `1080p` — a model comparison
  confounded by resolution and presented as clean.
- **Gallery spend total conflates billed-unsettled with never-submitted**
  (`gallery.js:580-596`), so the shared artifact can't distinguish $0 spent
  from $4 spent.
- **`rpd prompt` still prints legacy directive text under "CURRENT TEXT"**, and
  its meanings table now contradicts CORE (claims low camera motion is favoured;
  CORE explicitly permits push/pull/pan/orbit/cut). `prompt-elements.md` tells
  every session to quote that output verbatim.
- **`spec-authoring.md:68-69` still recommends `directives-C` and a "Directive
  pre-flight" recipe** — a 2-cell $2.00 run whose second cell is a byte-copy of
  the first. Contradicts line 43 of the same file.
- **`autoEval.js:53` hardcodes an 8-second sampling window** (`fps=${count}/8`)
  while `cell.durationSec` sits unused — on a 10s master the **final 4 seconds
  are never judged**.
- **`scripts/verifyCorePrompt.js` does not exist**, though two files cite it as
  the sha256 pin on the frozen CORE prompt. CORE is unpinned; an edit fails
  nothing, and every A/B's control arm is CORE.
- **`LEARNINGS.md:14` records a now-false finding** (the transitions/crossfade
  result) with no superseded marker — it will send a newcomer to write exactly
  the patch that hard-errors.

## 4. THE GENERATION-WASTE AUDIT (findings only — nothing fixed yet)

Nick's direction: *"fix any bug that is wasting generations right now"*, scoped
to adgen and the live Atlas/Gemini paths. Prices: video master **~$1.04**
(Gemini) / $0.90 (Atlas); static **$0.072**; reframe outpaint **$0.08**.

**Ranked, all confirmed by reading code:**

1. **`competitor_marks` false-positives fail whole paid masters.** The QC judge
   gets `brandName` but never the **product title**, so a product with its own
   name printed on it reads as a foreign mark ("Pura Vida" on a Pura Vida
   product; "VAPORTEK" on a Vaportek tag). **43.3% of all video QC failures
   over a measured 7-day window** (`adVisionQcService.js:111`). The master is
   billed, then stamped `failed` and never delivered — and on a Meta run it
   kills the 3 free derives with it. Fix: thread the product title in and add
   one clause to the prompt. `qcProductId` is already in scope at both call
   sites (`directImageRenderService.js:3128`, `brandScriptExecutor.js:1868`).
   **Nick already approved fixing this as part of the QC work.**
2. **Same signal burns the static regeneration** (`MAX_QC_REGENERATIONS=1`).
   $0.072 per false regen, $0.144 when both plates are then discarded.
3. **`title-only` regenerate is a lie on the agent surface.**
   `capabilityRegistry.js:1945`/`:1958` advertise *"retitle without re-billing
   the master"*; `resolveEffectiveRegenMode` returns `'full'` unconditionally
   (`adRegenerateService.js:671-673`, adgen `:838`), and
   `adRegenerate.js:77` **echoes the requested mode back as if honoured**.
   ~$1.04 per call. The free path already exists (`retitleConsumer`). Fix is
   two lines. *(The HTTP route is already honest — it reports `billedMode`.
   Only the agent capability lies.)*
4. **`videoModel` override is inert on Gemini.** Route validates Atlas
   `MODEL_CAPS` slugs; `resolveGeminiModel:157-161` silently discards anything
   not `gemini-*`. All 3 selectable slugs are Atlas, so **100% of dropdown
   picks are ignored** — you pay $1.04 for an A/B that structurally did not run.
5. **The billable reframe ladder is live on the BACKEND, not adgen** — because
   `enabled()` requires `VIDEO_PROVIDER==='atlas'` and only `adgen-renderer`
   was flipped to `gemini`. The live spender is the wizard prewarm
   (`videoRefPrewarmService`), which fires on product pick, is **not gated on
   the run being a video run**, and can reach **~$5.76 per wizard open /
   ~$11.52/h/brand**. Three cache bugs sit under it (stale-outpaint cache keyed
   without `shotType`; pad gate too narrow — excludes `flat_lay`/`detail`/
   `packaging`; pad-URL failure falls through to paid outpaint instead of the
   free crop — a one-line missing `return`). **Fix these in backend, that's
   where the money is.**
6. **Duplicate `productId` buys a second Director+Judge round** (~$0.105).
   One-line fix: dedupe in `resolveOwnedProductIds` (`routes/ads.js:425-435`).
7. **`parseVerdict` fails closed and consumes the static regeneration**, and
   `parseError` is **not persisted**, so the rate is unmeasurable. Two lines to
   persist it — do that before deciding whether to change the policy.

**Refuted (I was wrong, don't re-chase):** the logo flush-to-safe-box fix and
PR #307's surface-aware titling bands **were** both ported to adgen and are
live. `refinedProducts` selection is fixed in both.
`DIRECTOR_SIGNALS_VERSION` is split-brain (backend `3.5.0` vs adgen `3.4.0`)
but currently **inert** — bump adgen to `3.5.0` anyway to disarm it.

---

## 5. DEFERRED DESIGN (researched, not started)

Full detail in `/root/.claude/plans/eventual-chasing-frost.md` — **copy that
file out before archiving this session.** Headlines:

- **The video QC ship gate is inverted.** `TITLING_CATEGORIES =
  ['text_defects','layout_safe_box']` gates derives, commented as "the two
  categories the derive actually owns" — but the video prompt scopes *both*
  away from the overlay (`text_defects` is "product-intrinsic only -- NOT the
  ad's caption overlay"). So a derive can be failed for a master defect a
  retitle can never fix, and can ship with overlapping titling because nothing
  scores it.
- **"That separate system" doesn't exist.** `stackFit.planGroupFit` already
  returns `{scale, dropReviewsRowId, droppedRowIds}` — a free, deterministic
  overlay-defect signal — consumed inside Chrome and discarded.
- **Retitle is deterministic**, so an auto-remedy must change an *input*
  (`plateIntelService` runs at `temperature:0`; `stackFit` has already tried
  its whole ladder). The one input that varies is quote rotation. Any
  auto-remedy needs an idempotency fingerprint before it may spend a render.
- **Cost baseline:** a 21-ad kit is ~$0.90 generative + **~$1.47 vision
  overhead**. Biggest reducible items are `basePlateCropService.detectClipBoxes`
  (one vision call **per frame, serial** — 3–6/ad) and `title_plate_scan`
  (every titling render, cost never reconciled).

**Open question Nick never answered:** what the "GPT2 overlay based system" is
that he wants tested. Ask before assuming.

---

## 6. STATE

- Branch `claude/dazzling-darwin-bv5fni` @ `9cf2551`, pushed.
- PRs #118 and #130 merged. `master` is current.
- Nothing was spent in this session — every run was a dry run.
