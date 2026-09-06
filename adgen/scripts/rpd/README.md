# RPD — Rapid Product Development harness

Location: `scripts/rpd/` in **liquidretail_adgen**. Node only — **no new dependencies**.

Audience: any engineer or agent with repo access and Render credentials (a local `.env`).

**Moved here from `liquidretail_backend` 2026-09-04.** It was originally built (and briefly
retired, PRs #210/#212) against backend's copy of `veoPromptBuilder.js` / `atlasVideoService.js`.
It now lives where the actually-live code lives: this repo owns rendering in production
(`ADGEN_RENDERER_ENABLED=true`), and — separately — the video prompt itself was rewritten here
on 2026-09-03 into a single frozen CORE paragraph that backend's copy never received. Testing
against backend's copy today would silently exercise a superseded prompt. See the box below.

---

## What it is

An **A/B harness** for catalog **video** models × **prompt variants**, run against the **real production prompt builder** (`buildVeoPrompt` / `veoPromptBuilder.js`) and against **either production video provider**.

It lives **outside the Ad pipeline**:

- No Mongo required (optional DB seed mode is later, not now).
- No `Ad` rows.
- No `CostLog`.
- No campaign / generate / claim path.

You pick one or more video models, a seed image, and a list of prompt levers. The runner builds **cells = models × variants**, optionally submits (billable), polls for free, downloads `master.mp4`, optionally titles with production Remotion, and writes a self-contained gallery you can publish to Netlify (or Cloudflare Pages).

**Two providers, one spec.** A `models[]` entry is either an Atlas slug (`google/…`, `xai/…` — routed through `services/atlasVideoService.js`) or any `gemini-*` id (routed through `services/geminiVideoService.js`, the direct Google Developer API — **the current live production path**, `videoRouter.js` `VIDEO_PROVIDER=gemini`). Mix both in one `models[]` array to compare them cell-for-cell in one gallery — see `references/prompt-elements.md` in the paired skill for why that comparison is now clean (both providers share the identical CORE prompt).

⚠️ **The video prompt is now ONE frozen ~1.16KB paragraph (`corePromptText`, owner-directed 2026-09-03), the same for every model and every destination.** The `directives` lever below (patching the legacy per-field `OMNI_DIRECTIVES` / `GROK_DIRECTIVES` / `HOOK_FIRST_DIRECTIVES` / `LIFESTYLE_DIRECTIVES` objects) still runs but is **provably inert on output** — those objects are computed and then never read into the prompt. `guidance`, `raw`, and `patch` are unaffected and are the levers that still matter. Full mechanism: `.claude/skills/rpd-experiments/references/prompt-mechanics.md`.

**No redeploy, ever.** The harness runs entirely from a local checkout (`node scripts/rpd/rpd.js …`) — nothing here touches Render. Prompt experiments are pure **spec JSON** changes (guidance / raw / surgical patches) with zero code edits; harness code changes are local edit-and-rerun.

---

## Quickstart

### Env

Process env first, then `config/defaults.env` (`dotenv` never overrides an already-set var) — same load order `rpd.js` itself uses at boot.

| Var | Required | Where |
|---|---|---|
| `GEMINI_VIDEO_API_KEY` (falls back to `GEMINI_API_KEY`) | **Yes for `--live` on a `gemini-*` model — the current live path** | Render dashboard (adgen services) or local `.env`. Resolved by `services/geminiVideoKey.js`, which logs only a 4-char fingerprint. **Never print or commit it.** |
| `ATLAS_API_KEY` | **Yes for `--live` on any Atlas model** (`google/…`, `xai/…`) | Render dashboard or local `.env`. **Never print or commit it.** |
| `NETLIFY_AUTH_TOKEN` | For `publish` (default host) | Personal Access Token from the account owning the **Flood QRF** team. The token selects the account — no `netlify switch`. Required on Render. |
| `RPD_NETLIFY_TEAM` | For `publish` | Team slug, `decastro-mark85` (Flood QRF). Needed to create the site in the right account. |
| `CLOUDFLARE_API_TOKEN` / `_ACCOUNT_ID` | Only for `--host cloudflare` | Pages-write token + account id. |
| Cloudinary | Optional | Seed **prep** (aspect crop) only works for Cloudinary URLs. Uploads stay **off** by default; Pages serves local files. |

```bash
# macOS worktrees: committed node_modules is incomplete (no native sharp, etc.).
# NODE_PATH alone will not fix it — Node resolves local node_modules first.
npm install

# Inspect models + floor-grade estimates (no spend)
node scripts/rpd/rpd.js models

# Dry-run a spec (default): build prompts, write manifest, NO Atlas submit
node scripts/rpd/rpd.js run path/to/spec.json --out rpd-runs

# Live: refuse without --max-usd. Estimates are a FLOOR, not the bill.
node scripts/rpd/rpd.js run path/to/spec.json --live --max-usd 5 --out rpd-runs
```

`--out` is the parent directory. Each run lands in `<out>/<spec.name>-<timestamp>/` with `manifest.json`, `index.html`, and `cells/<cellId>/`.

---

## Experiment spec

JSON file. Cells = `models` × `variants`. Per-variant overrides (`durationSec`, etc.) are allowed.

### Annotated example

```json
{
  "name": "omni-vs-grok-hook-first",
  "notes": "Why this experiment exists. Shown in the gallery header.",

  "seed": {
    "url": "https://res.cloudinary.com/.../shoe.jpg",
    "productTitle": "Wool Runner",
    "refs": ["https://.../alt1.jpg"],
    "brandHex": "#101418"
  },

  "aspectRatio": "9:16",
  "durationSec": 8,
  "resolution": "1080p",

  "models": [
    "google/gemini-omni-flash/image-to-video-developer",
    "xai/grok-imagine-video-v1.5/image-to-video"
  ],

  "variants": [
    { "id": "baseline" },

    {
      "id": "hook-first-guidance",
      "guidance": "Open on the strongest visual hook in the first 0.5s."
    },

    {
      "id": "raw-rewrite",
      "raw": "FULL replacement prompt. Canonical directives are NOT applied."
    },

    {
      "id": "obj-directive",
      "directives": { "objective": "New objective sentence." }
    },

    {
      "id": "surgical",
      "patch": [
        { "find": "Smooth crossfades only", "replace": "Hard cuts only" }
      ]
    }
  ],

  "titling": {
    "enabled": false,
    "preset": "canonical",
    "platformFormat": "meta_stories_9_16",
    "brandName": "RPD Test",
    "copy": {
      "headline": "Wool, not foam.",
      "ctaText": "Shop now"
    }
  }
}
```

### Fields

| Field | Meaning |
|---|---|
| `name` | Run id prefix + gallery title. |
| `seed.url` | Hero / primary still. Cloudinary URLs are cropped to `aspectRatio` via `cropImageUrlForAspect` + `brandHex`. **Non-Cloudinary URLs are passed through unchanged** — Atlas fetches the original pixels. |
| `seed.productTitle` | Fixture `product.title` for `buildVeoPrompt`. |
| `seed.refs` | Extra reference stills (same Cloudinary / pass-through rule). |
| `aspectRatio` | Prompt fixture + crop target. Omni native enum is `16:9` / `9:16`; other ratios follow production routing. |
| `durationSec` | Requested duration. Atlas **snaps to the model's enum at submit** (Omni: `4, 6, 8, 10`); Gemini models clamp to the documented 3-10s range instead (no enum). |
| `resolution` | e.g. `1080p`. Omni 720p and 1080p are the same list price. |
| `models` | Atlas model ids from production `MODEL_CAPS`, **or** any `gemini-*` id (e.g. `gemini-omni-1.1-flash`) — routed to the direct Gemini Developer API, the current live path. Mix both in one array. |
| `rngSeed` | **Atlas only.** Pins the `gemini-omni` paramShape's schema-confirmed `seed` field so a prompt A/B isn't confounded by the model's own randomness. Per-variant `variant.rngSeed` overrides it. No equivalent exists for direct Gemini. |
| `variants[].id` | Stable cell suffix. |
| `titling` | Optional Remotion pass after the master lands. Failure keeps the master. |
| `notes` | Human “why this run”. Distinct from `rpd note` observations. |

---

## CLI

```text
node scripts/rpd/rpd.js run <spec.json> [--live --max-usd N] [--out rpd-runs] [--upload]
node scripts/rpd/rpd.js resume <runDir>
node scripts/rpd/rpd.js eval <runDir> [--eval-max-usd 0.5]
node scripts/rpd/rpd.js stats [--out rpd-runs] [--csv]
node scripts/rpd/rpd.js gallery <runDir>
node scripts/rpd/rpd.js note <runDir> <cellId|run> "text"
node scripts/rpd/rpd.js publish <runDir> [--host netlify|cloudflare] [--site rs-rpd] [--team <slug>] [--cli] [--no-slack]
node scripts/rpd/rpd.js models
```

| Command | What it does | Spends? |
|---|---|---|
| `run` | Build prompts, write manifest, optionally submit + poll + download + title + gallery. **Default is dry-run** (no Atlas POST). | Only with `--live` |
| `resume <runDir>` | Re-poll existing receipts, download, reconcile settled price, rebuild gallery. **Structurally never submits** (resume path does not import `submitGeneration`). | No (polls are free) |
| `gallery <runDir>` | Rebuild `index.html` from `manifest.json`. | No |
| `note <runDir> <cellId\|run> "text"` | Append an observation on a cell or the whole run; persist on the manifest; rebuild gallery. | No |
| `publish <runDir>` | Deploy the gallery. **Netlify by default** (site `rs-rpd`, Flood QRF); `--host cloudflare` for Pages. Creates the site once if absent. Per-deploy URLs are immutable; `manifest.json` is never published. | No (hosting only) |
| `eval <runDir>` | Vision-grade settled cells into badged auto-notes. Own cap, `--eval-max-usd` (default $0.50). | Yes — vision LLM, ~$0.01–0.03/cell |
| `stats` | Aggregate every run manifest: settled cost + latency percentiles per model/duration/size. `--csv` for a spreadsheet. | No |
| `models` | Print `MODEL_CAPS` + `estimateRenderCostUsd` table. | No |

---

## Money model

**Dry-run is the default.** `--live` is the only billable door. This section covers both
providers — read the per-provider asides, they diverge in real ways.

1. **`--live` requires `--max-usd N`.** Missing the cap → refuse, no submit.
2. **Pre-flight:** `Σ estimate(cells) ≤ max-usd` across BOTH providers in the spec, else
   refuse **before** any POST. Atlas cells estimate via `estimateRenderCostUsd` (`MODEL_CAPS`
   formula); Gemini cells via `geminiVideoService.estimateCost` (measured tokens/sec × the
   published per-token rate — no formula, no catalog).
3. **Estimates are floor-grade on both, not the invoice, for different reasons.** Atlas's
   `MODEL_CAPS` Omni formula (`base 0.20 + 0.10/s` → **$1.20 @ 10s**) **overstates the
   developer variant by ~33%** — measured settled price for 10s 1080p Omni **developer** is
   **$0.90**. Gemini's estimate is closer (measured **~$1.04** for a 10s 1080p master) but is
   still only a floor until the real `usage` comes back. Neither number is spend until it is
   `costSource: "actual"`.
4. **Truth is the settled figure, read back per-provider.** Atlas: `price` on
   `GET /model/prediction/:id` (`parseAtlasSettledPrice`). Gemini: `usage.output_tokens_by_modality`
   on the interaction's own completion body (`computeCost`) — arrives WITH completion, not on a
   later poll like Atlas sometimes does. Manifest stores `costUsd` + `costSource: actual |
   estimated` either way; `estimated` means the real figure was **never published**, not that
   the formula/estimate is authoritative.
5. **Live submit is structurally different per provider — know which one a cell used.**
   - Atlas: `atlasVideoService.submitGeneration` — `pacedModelSubmit` spacing, a
     structured-429-only retry loop (up to 4 attempts), `maxRedirects: 0`.
   - Gemini: `geminiVideoService.submitGeneration` — **one POST, no retry.** Gemini's own rate
     cap surfaces on the FIRST POLL (`too_many_requests`), not on the submit response — an
     accepted `interaction_id` is the charge point, regardless of HTTP status. Porting Atlas's
     retry-on-429 semantics onto this provider would double-bill; the harness does not.
6. **Receipts before poll:** `manifest.json` is written with `status=submitting` **before**
   each POST. `predictionId` (the field name used for BOTH providers' receipt — an
   `interaction_id` on Gemini, a `prediction` id on Atlas) is flushed to disk **immediately**
   when submit returns. A crash after submit still has a spend receipt.
7. **`resume` never re-submits, on either provider.** It only re-polls receipts already on the
   manifest. Use it after a timeout, laptop sleep, or killed process.
8. Failures are recorded honestly (state, provider message, charged tri-state). A completed
   prediction/interaction with **0 outputs** is **failed**, not done.
9. **Grok Imagine 1.5 / Grok 1.0 / Veo 3.1 rates in `MODEL_CAPS` are UNVERIFIED** (the registry
   carries a figure, so the budget gate *can* sum it, but unlike Omni developer — whose formula
   measures ~33% HIGH vs settled — the error direction is unknown). Live cells on these models
   run with a loud `⚠️ UNVERIFIED RATE` warning; keep the first live run on such a model short
   and read the settled price back before scaling. A model with **no** pricing data at all is
   refused outright.
10. **No `seed` on Gemini.** Atlas's `gemini-omni` paramShape accepts a schema-confirmed
    `seed` integer (default -1 = random) that production never sets — `spec.rngSeed` /
    `variant.rngSeed` expose it so a prompt A/B can hold the model's randomness fixed. Direct
    Gemini has **no** equivalent parameter (verified against the real `buildRequestBody`, not
    inferred) — do not claim a Gemini comparison is seed-controlled.
11. **No shared concurrency lease with production, on either provider — worse for Gemini.**
    Atlas pacing is in-process only. Production's Gemini path additionally holds a global
    per-model lease (`services/geminiVideoLease.js`) before every submit; this harness does
    not acquire it (that would need a live Mongo connection, which the harness deliberately
    lacks). A large concurrent Gemini batch during active production traffic can contend for
    the same provider-side cap as real generations — keep Gemini batches small.

There is no `CostLog` and no Ad row. The manifest **is** the ledger for the run.

---

## Telemetry — cost AND time, per cell

Every cell records a `timings` object in the manifest (rendered as a "timings" panel in the gallery) so runs double as a **latency forecast dataset**:

| Field | What it measures |
|---|---|
| `promptBuildMs` | Prompt construction (harness-side). |
| `seedProbe[]` | One timed GET per prepared reference URL, **before** submit — for Cloudinary crop URLs the first fetch pays the on-the-fly transform, which is exactly the latency Atlas pays fetching the same URL on the production path. Records ms, bytes, and the CDN cache header so **cold derivation vs warm cache** is distinguishable. De-duped across cells sharing a seed (only the first probe is cold). |
| `submitMs` | POST round-trip, **including** `pacedModelSubmit` spacing and any structured-429 backoff. |
| `queueToTerminalMs` | Submit → terminal prediction (queue + generation), same number as the `latency` chip. |
| `atlasExecutionTime` / `atlasTimings` | Atlas's **own** provider-side telemetry from the settled prediction (e.g. `timings.inference`) — separates queue wait from model compute. |
| `downloadMs` / `downloadBytes` | Output fetch + file size. |
| `titlingMs` / `titling.*` | Wall-clock Remotion pass + `renderTitles`' internal stage timings. |

Comparing `queueToTerminalMs` minus `atlasTimings.inference` across models/durations tells you queue behaviour; `seedProbe` cold-vs-warm tells you what reference-prep adds to first-generation latency.

---

## Prompt levers

Every cell builds a fixture and calls the **same** production builder (or the production raw-cap path) — **the same builder for both providers**: `services/atlasVideoService.js` and `services/geminiVideoService.js` both call `buildVeoPrompt`. Baseline for a given fixture is **byte-identical** to `buildVeoPrompt(fixture)` in prod, and a Gemini cell and an Atlas cell at the same duration are byte-identical to each other.

⚠️ **Read this before recommending the `directives` lever.** As of 2026-09-03 (owner-directed), `buildVeoPrompt` pushes exactly one frozen paragraph — `corePromptText(durationSec)`, ~1.16KB, sha256-pinned — for every call, and never reads the legacy per-field directive objects into it. `directives` still patches those objects (and D5 in `verifyRpdHarness.js` still proves the restore is byte-identical) but the assembled prompt is now **provably unaffected**. Full mechanism, with the owner's own quotes and the measurement that drove it: `.claude/skills/rpd-experiments/references/prompt-mechanics.md`.

Fixture shape (per cell):

```js
{
  product: { title },
  aspectRatio,
  seedHasText,
  hasProductReference,
  caps: capsFor(model),   // Atlas cells; Gemini cells pass caps:null, matching production
  durationSec,
  platformFormat
}
```

| Spec field | Still changes output? | Production lever | What happens |
|---|---|---|---|
| *(omit — `baseline`)* | — | Default camera prompt | `buildVeoPrompt(fixture)` → CORE, interpolated only by duration. |
| `guidance` | **Yes** | Wizard / brand / regenerate operator-refinement cascade | `buildVeoPrompt({ ...fixture, operatorPrompt: guidance })` — a fenced block **prepended** ahead of CORE, with a `CONSTRAINT SUPREMACY` line appended last so it can steer within CORE's constraints but never override them. |
| `raw` | **Yes** | `Ad.videoPromptRaw` full-override lever | `enforceRawByteCap(raw, caps)`. **Full replace.** CORE is bypassed entirely (same "canonical directives bypassed" log as prod). |
| `patch` | **Yes — the tool for testing a CORE wording change** | Surgical edit of the **final** prompt string | `find` must occur **exactly once** or hard error. Use this to flip one phrase in CORE's own text without forking the whole builder. |
| `directives` | **No — provably inert** | A **code change** to the legacy `OMNI_DIRECTIVES` / `GROK_DIRECTIVES` / `HOOK_FIRST_DIRECTIVES` / `LIFESTYLE_DIRECTIVES` objects | Clone-patch the module singleton for that cell's build, restore in `finally`. Unknown key = **hard error**. After restore, `JSON.stringify` of the singleton matches before — but the OUTPUT prompt is byte-identical to baseline either way, because CORE never reads these objects. Kept for the singleton-restore guarantee, not as a working lever. |

Return value: `{ prompt, promptMeta: { lever, diff-vs-baseline } }`. The gallery highlights the diff — for `directives`, that diff will correctly show empty, which is the honest answer, not a bug.

CORE itself is owner-frozen pending a *measured* proposal — same precedent as the pre-CORE camera prompt (PR #61 hardened it and was rolled back in full when the owner said the previous output was better). A `patch`/`raw` experiment against CORE is legitimate; "cleaning it up" without a measured A/B is not.

---

## Titling

Optional. Off unless `titling.enabled: true`.

- Production Remotion path: `resolveSpecForBrand(fixtureBrand(preset), format)` + `buildBrandTokens` + `renderTitles`.
- Preset default: **`canonical`** (same family as production canonical title-style presets).
- Format is `classifyFormat`-compatible (including square), and **`platformFormat` is passed through** so Meta / PMax **safe zones** match production (Stories ≠ Reels).
- Copy comes from `spec.titling.copy` (headline, CTA, etc.).
- **Standalone:** no Ad, no `renderBrandScriptAndSave` campaign side effects.
- **Failure keeps the master** (mirrors prod: titled file missing, `master.mp4` retained, cell records the titling error). Untitled is not treated as success of titling, but it is not a lost Omni receipt.

Remotion is warmed on the **web** process in prod; locally you need a machine that can run the same Remotion render as `testRemotionTitles`.

---

## Gallery and publish

`gallery` writes a **self-contained** `index.html` at the run dir root. Video `src`s are **relative** (`cells/<id>/master.mp4`) so the folder is Pages-deployable as-is.

Must show:

- The **original seed image, large**, plus an **auto-brightened duplicate** (CSS `filter` only — not a second file).
- Matrix: **rows = variants**, **cols = models**.
- Each cell: `<video controls loop muted>`, chips (model, duration, resolution, settled `$` or est, latency, prediction id), collapsible prompt with **diff-vs-baseline**, notes.
- Run header: spec name, date, **Σ settled**, observations list.
- Dark theme.

`note` appends to the manifest and rebuilds the gallery.

### Publish

Galleries go to **Netlify** by default — site `rs-rpd` in the **Flood QRF** team,
which is on Pro, so site password protection (`secure_site`) is available there.

```bash
# token path (default; works locally AND on Render — the token selects the account)
export NETLIFY_AUTH_TOKEN=...            # PAT from the account owning Flood QRF
node scripts/rpd/rpd.js publish <runDir> --site rs-rpd --team decastro-mark85

# CLI path, for a machine with an interactive login instead of a token
node scripts/rpd/rpd.js publish <runDir> --cli --site rs-rpd --team decastro-mark85

# Cloudflare Pages is still supported
export CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=...
node scripts/rpd/rpd.js publish <runDir> --host cloudflare --project rs-rpd
```

**Two accounts?** `netlify switch --email <addr>` flips the machine-wide CLI
login, which makes "which account did that publish land in" depend on invisible
local state. Prefer the token path: `NETLIFY_AUTH_TOKEN` overrides the login
entirely, so it is deterministic locally and the only option on Render.

**Per-deploy URLs are immutable** — deploys are draft/non-prod on purpose, so a
LEARNINGS row still shows THAT run later. A production deploy would be overwritten
by the next publish, silently re-pointing every historical link at the newest
gallery.

**`manifest.json` is never published.** It is the run ledger (prompts, prediction
ids, settled costs) and the gallery does not reference it. All three publishers
deploy a staged copy with it removed — pinned by `verifyRpdHarness.js` section P,
after the CLI path was caught serving it 200 from a public URL.

**Access:** on Flood QRF (Pro) turn on Site configuration → Access & security →
**Password protection**. That is a real edge gate, unlike a client-side Identity
widget, which leaves the .mp4/.png URLs directly fetchable. On a Free team the
capability is absent and a published gallery is readable by anyone with the URL.

Under the hood:

```text
npx --yes wrangler pages deploy <runDir> --project-name <p> --branch main
```

On first 404 (project missing):

```text
npx wrangler pages project create <p> --production-branch main
```

Prints the Pages URL. **522 for ~2 minutes after deploy is expected propagation**, not a bad upload.

---

---

## Static (image) experiments

A spec may carry a `static` section, a video section (`models` + `variants`), or **both** — one
budget gate covers all cells.

```json
"static": {
  "surface": "meta_feed_1_1",
  "intent": "brand_led",
  "productDesc": "a black cotton crew-neck tee with a circular grey chest logo",
  "copy": { "headline": "Better than new.", "cta": "SHOP NOW" },
  "models": ["openai/gpt-image-2/edit", "openai/gpt-image-2-developer/edit"],
  "variants": [
    { "id": "baseline" },
    { "id": "tighter-fidelity", "blocks": { "PRODUCT_FIDELITY": "…replacement block…" } },
    { "id": "rewrite", "raw": "…full replacement prompt…" },
    { "id": "surgical", "patch": [{ "find": "…", "replace": "…" }] }
  ]
}
```

Baseline is production-identical `staticAdIntents.buildPrompt` output. Levers:

| lever | production equivalent |
|---|---|
| *(none)* | the canonical intent prompt |
| `raw` | `Ad.imagePromptRaw` — full replace (≤40000 chars) |
| `blocks` | a **code change to a canonical block** (`PRODUCT_FIDELITY`, `SCENE_PRESERVE`, `SCENE_PRESERVE_EDGE_EXTEND`) |
| `patch` | surgical find-once edit of the finished prompt |

**Why static uses `blocks` and video uses `directives`:** video's directive sets are objects, so
patching a property mutates the binding the builder reads. The static blocks are module-scope
`const` **strings** read lexically — assigning to the export changes nothing the builder sees, and
the cell would silently render the baseline while claiming otherwise. `blocks` therefore does an
exact whole-block substitution of the finished prompt, and **errors loudly** if the block is not
present (e.g. `STATIC_PROMPT_FIDELITY_HARDENING=false` routes to the legacy paragraph instead).

**Intent downgrades are surfaced, not hidden.** `resolveIntent` falls back when an intent's data
is missing — ask for `social_proof_led` with no rating and you get `product_first_lifestyle`. That
appears in the dry run, in `promptMeta.intentDowngraded`, and as a gallery badge, because an arm
labelled with the requested intent that rendered a different one is a broken comparison.

Static money notes: `allowFallback:false` is hardcoded (the default resubmits to direct OpenAI — a
second billable generation on a different model); prices come from a **measured** table
(`gpt-image-2/edit` $0.0718, `-developer/edit` $0.0359) because the catalog `base_price` measures
~7× low; an unlisted model is refused live. The `-developer` variant is cheaper but production
stays off it (~16% hard-fail rate) — fine for an experiment, just know the arms may differ in
reliability as well as quality.

## Seeding from the catalog (`seed.productId`)

Instead of pasting a URL, name a product:

```json
"seed": { "productId": "6a6624b95f5af85a46562ded" }
```

Requires `MONGODB_URI` (read-only). Resolves the merchant-feed primary image by the **live**
production rule (`CatalogProduct.imageMediaId` pointer → `metadata.feedIndex === 0`; videos and
empty URLs rejected), plus the next two catalog refs in feed order, the product title, and the
brand's `websiteBackground` as the crop pad hex. **The resolved values are stamped into the
manifest**, so `resume` / `gallery` / `publish` never touch the database. A product with no usable
still is a hard error — the harness never triggers a materialize/detect run.

**If `spec.titling` is also set**, the same lookup fetches the product's real Brand
(`logoUrl`/`primaryColor`/`secondaryColor`/`accentColor`/`fontFamily`/`tagline`/`titleStylePreset`)
and wires it into `spec.titling.brand`, plus the real product title into
`spec.titling.copy.headline` — so the burned-in chrome is the product's actual on-brand look,
not `titling.js`'s "Pelagic Test Fixture" stand-in. Either field, if the operator already set it
in the spec, is left alone. Proof-class copy (`quote`/`rating`/`reviewCount`/`reviewsText`) is
never touched by this — it stays absent unless supplied explicitly, same rule as always.

## Video-seeded (reference-to-video) cells

Add `seed.videoUrl` (Cloudinary `/video/upload/` preferred) and reference-to-video models stop
being skipped. The clip URL is built with the same production expression
(`so_2,du_N,c_fill,ar_*`, raw URL as fallback). A pre-submit `ffprobe` refuses a source longer
than the schema's documented 30s ceiling — production does not check this, and an r2v submit is a
flat $1.60. An unprobeable seed warns rather than refusing (matching production).

## Auto-eval

`rpd eval <runDir>` grades every settled cell and writes a badged auto-note:

- **Statics** reuse the production judge (`adVisionQcService.judgeRender`), so harness verdicts are
  directly comparable with production QC.
- **Video** extracts 4 frames (ffmpeg) and sends seed + frames through the same `ad-vision-qc`
  model role with a rubric covering seed fidelity, hallucinated parts, transition artifacts and
  text legibility.

Verdicts are **advisory**: badged "auto-eval — verify before trusting", never overwriting a human
note, never gating anything. Vision calls are billable and have their **own** cap
(`--eval-max-usd`, default $0.50) so eval can never consume generation budget; exhausting it stops
cleanly and reports how many cells were left.

## Nightly loop

`scripts/rpd/loop/nightly.sh` runs one bounded batch per night: dry-run → live under `--max-usd`
(default $2) → resume if any receipt is unsettled → eval → publish → Slack → append a LEARNINGS
row. **Idempotent per day** via a stamp file claimed *before* spending, because launchd re-fires
missed jobs on wake and "catch up" must never mean "generate twice".

`scripts/rpd/loop/nightly-spec.json` **is the queue**: add a variant by PR and tonight's run tests
it against the baseline. Remove variants once their learning is in LEARNINGS.md.

Credentials come from the environment or `~/.rpd-nightly.env` (chmod 600), never from the script.

## Gallery access (one-time human step)

`rs-rpd.pages.dev` deployments are readable by anyone holding the URL. To require an org email
login, enable Cloudflare Access — this needs one dashboard click that no API token can perform:

1. https://dash.cloudflare.com → **Zero Trust** → click **Enable Access** (one time, free tier
   covers 50 users).
2. **Access → Applications → Add self-hosted**, domain `rs-rpd.pages.dev` (include
   `*.rs-rpd.pages.dev` for per-deployment URLs).
3. Policy: *Allow* → *Emails ending in* `@reach-social.io` (add individual addresses as needed).

Until that is done, treat gallery URLs as shareable-but-unlisted and don't put anything in a
gallery you would not want forwarded.

## Agents running this in a loop

Safe by construction if you obey the CLI:

| Guard | Why |
|---|---|
| Budget cap **per `run --live`** | `--max-usd` is mandatory; pre-flight sum of estimates. |
| Receipts on disk before poll | Crash-safe; you never “lose” a prediction id. |
| `resume` never submits | Recover downloads / settled price without a second Omni POST. |
| Dry-run default | A loop that forgets `--live` spends nothing. |
| Missing/non-finite estimate → refuse | Cannot live-fire any model without a finite number the gate can sum. Unverified rates run with a loud warning — budget conservatively. |

Agent recipe:

1. `models` → confirm ids and estimates.
2. `run spec.json` (dry) → inspect prompts / gallery.
3. `run spec.json --live --max-usd N` → one bounded batch.
4. On timeout or interrupt: **`resume <runDir>`**, never a second `--live` for the same cells.
5. `note` observations; `publish` when a human should look.

Do not wrap `--live` in a retry-on-any-error loop. Retry is **`resume`**. A second `run --live` is a new billable matrix.

---

## FAQ / traps

**Non-Cloudinary seed URLs are not resized.**  
`cropImageUrlForAspect` only rewrites Cloudinary URLs. Anything else is passed through with a warning. Atlas pulls **the original file**. A 4:5 PNG on a 9:16 cell is not magically letterboxed here.

**Duration snaps to the model enum at submit.**  
You can write `durationSec: 7` in the spec; Omni will snap to `{4,6,8,10}`. Gallery chips should show what was **sent**, not only what you typed.

**Grok 1.5 pricing is UNVERIFIED in `MODEL_CAPS`.**  
The registry carries $0.50/s, so the gate sums ~$4.00 for an 8s cell and the cell **runs** — with a loud UNVERIFIED RATE warning, because the settled price could land either side of that figure. Keep first Grok runs short and read the settled price back. Only models with **no** pricing data are refused.

**macOS worktrees need `npm install`.**  
The tracked `node_modules` subset is incomplete (no native `sharp`, missing packages such as `https-proxy-agent` that axios needs). Local `node_modules` wins over `NODE_PATH`. macOS has **no** `timeout` binary — don’t wrap verify scripts in `timeout`.

**`--live` without `--max-usd` is a hard refuse.**  
Same for Σ estimates above the cap. Nothing is submitted.

**`resume` is the only recovery.**  
Never re-`run --live` to “finish” a run that already has `predictionId`s. That is a double submit.

**Settled price, not the estimate, is what you quote.**  
Omni developer 10s: formula ~$1.20, measured settled **$0.90**. If `costSource` is still `estimated`, Atlas never published `price`.

**When is a cell "finished" under `resume`?**
Same definition as `run`: the receipt polled to terminal-ok, `master.mp4` is on disk, and — when `spec.titling.enabled` — the titling pass ran (`resume` runs the same free titling pass over settled masters that `run --live` does, retrying cells whose earlier titling failed). A settled price may lag (`costSource: estimated` until Atlas publishes it); that never blocks `done`. A prediction that completed with zero outputs is `failed`, not finished. Titling failure keeps the master and records `titlingError` — untitled is visible, never silently counted as titled.

**Offline verify:** `node scripts/verifyRpdHarness.js`  
No network. Pins: live-without-cap refuse, over-budget refuse, resume source-scan (no `submitGeneration`), receipt-before-poll, baseline byte-identity, directive singleton restore, patch single-occurrence, `submitGeneration` export present. Revert-proven on ≥2 mutations.

**Config load.**  
`ATLAS_API_KEY` from the Render **WEB** dashboard (or local `.env`). `config/defaults.env` supplies non-secrets. A dashboard var of the same name always wins.

---

## Layout (this package)

```text
scripts/rpd/
  README.md            ← this file
  rpd.js               ← CLI
  lib/promptVariants.js ← levers vs production builder (both providers)
  lib/runner.js        ← expand / dry-run / live run (the only file that submits — either provider)
  lib/atlasPoll.js     ← free Atlas reads: poll, settled price, probes, downloads
  lib/geminiPoll.js    ← free Gemini reads: poll, settled cost, downloads (mirrors atlasPoll.js)
  lib/geminiImages.js  ← fetch + base64-encode reference images for Gemini's inline-image request shape
  lib/resume.js        ← finish interrupted runs, either provider; structurally cannot spend
  lib/manifest.js      ← atomic ledger writes + notes
  lib/titling.js       ← standalone Remotion pass (production presets)
  lib/gallery.js       ← self-contained index.html
  lib/publish.js       ← wrangler pages deploy
  specs/               ← example experiment specs
scripts/verifyRpdHarness.js
```

Run directories are `<out>/<timestamp>--<spec.name>/`.

Related production code (read, don't fork casually): `services/veoPromptBuilder.js` (shared by both providers — see the CORE box above), `services/atlasVideoService.js` (`submitGeneration`, `peekPrediction`, `estimateRenderCostUsd`, `MODEL_CAPS`), `services/geminiVideoService.js` (`submitGeneration`, `peekInteraction`, `estimateCost`, `computeCost`, `buildRequestBody` — **the current live provider**), Remotion titling used by `testRemotionTitles`.
