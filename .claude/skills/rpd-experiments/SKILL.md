---
name: rpd-experiments
description: Run rapid product development (RPD) experiments — A/B video models and prompt variants against the real production prompt builder, outside the Ad pipeline, then publish a gallery with notes and log the learning. Use when the user wants to test video models against each other, try prompt changes (guidance, raw rewrites, canonical-directive edits, surgical patches), compare generation quality/cost/latency, build or publish an experiment gallery, or asks to "run an experiment", "test this prompt", "compare models", or "use the RPD harness". Every run collects cost + timing telemetry for forecasting.
---

# RPD experiments

The harness lives at `scripts/rpd/` (read its `README.md` for full detail). It runs entirely from
this checkout — **no deploy, no Mongo, no Ad rows, no CostLog**. Cells = `models × variants`.

**Two things changed 2026-09-03/04, read before touching the video side:** (1) the video
prompt is now one frozen CORE paragraph, the same for every model — the old per-field
`directives` lever no longer changes output (`references/prompt-elements.md` has the
detail, do not skip it). (2) the harness now runs cells against **either** Atlas
(`google/…`, `xai/…` slugs) **or the direct Gemini Developer API** (any `gemini-*` model
id, e.g. `gemini-omni-1.1-flash`) — the latter is the current live production path
(`videoRouter.js` `VIDEO_PROVIDER=gemini`). One spec's `models[]` can mix both.

**Priority for this release: seed selection → prompt → video model — in that
order.** That's the loop worth iterating fast on and where effort should go.
Titling is real and wired (see "Delivering results" below) and still worth
asking about once, but it is explicitly **not** a priority to perfect right
now — don't spend refinement effort chasing titling quality/regressions
(`references/titling-regression.md` documents real gaps, but they're future
work, not this release's job).

Deep guides in this skill:
- **`references/prompt-elements.md`** — every prompt lever, what it CONTROLS, and whether to
  recommend changing it. **READ THIS BEFORE DISCUSSING ANY PROMPT CHANGE.**
- **`references/prompt-mechanics.md`** — how the prompt is ASSEMBLED: profile selection, the
  exact line order, where operator text comes from, the byte-cap sacrifice order, and which
  inputs change the wording without any prompt edit. Read it before answering "why did it say
  that?" or "what would actually change?"
- `references/spec-authoring.md` — full spec schema, every lever's production mapping,
  titling copy rules, matrix patterns that work.
- `references/operations.md` — credentials, exact money semantics with measured price points,
  resume/finished semantics, telemetry fields for forecasting, the sharing checklist.
- `references/titling-regression.md` — what actually counts as a titling regression (seven
  classes, most citing a real incident in this repo's history) and how to check for one by hand
  today. Not automated — read this before someone asks "did titling get worse?" or wants to wire
  up a regression job.

## Brainstorming a prompt change (the most common request)

The audience is often semi-technical: *"what if we used Grok instead of Omni?"*,
*"what if we changed this part of the prompt?"*. They rely on you to know what the parts
are. So:

1. **Ground on the live text FIRST — never describe a prompt element from memory.**
   ```bash
   node scripts/rpd/rpd.js prompt                    # video: elements + what each does + current text
   node scripts/rpd/rpd.js prompt --kind static      # static blocks
   node scripts/rpd/rpd.js prompt --key transitions  # one in full + a paste-ready variant
   node scripts/rpd/rpd.js models                    # models, caps, floor estimates
   ```
   These strings change, and one pair is **deliberately self-contradictory** in a way that
   reads like a bug (see the traps in `prompt-elements.md`). Quote what it actually says.
2. **Name which lever the idea maps to**, and say when it maps to none — "put the headline in
   the video" is the titling path, not the camera prompt.
3. **Say when a prompt change is the wrong tool.** Fidelity complaints usually are not fixed
   by stronger wording; prompt levers move motion, pacing, look and scene.
4. **One variable per arm**, baseline included, and pick a product whose logo/label IS the test.
5. **Dry-run — it is free** and prints the exact prompt per cell, so they see what will be sent
   before any money moves.
6. **Ask for the dollar cap.** Never invent one.
7. Note observations, publish, add a LEARNINGS row. Say plainly when n=1 proves little.

## Fulfilling a "make me a finished video" request (non-technical operators)

Not every request is a prompt experiment. Someone may just want a real, finished,
on-brand video ad for a real product — "make me a square video for [product]",
with no interest in specs, models, or JSON. Do the spec-authoring yourself; don't
hand them syntax. Concretely:

1. **Resolve the product** to a real `CatalogProduct` (ask for or look up its
   Mongo `_id`, or search by name/description if you have DB access — a name
   alone may match more than one product; ask which if so). Build the spec with
   `seed: {"productId": "<id>"}` — this pulls the real Cloudinary catalog photo
   + reference images by the same rule production uses, no manual URLs needed.
2. **Ask about seed image ordering — every time, never assume.** Once the
   candidate images are in hand (from `seed.productId`, or from any other
   source — a manually-found set works the same way), ask whether the
   operator wants the system-derived order (feed order — matches what
   production would use) or wants to pick/reorder themselves. If they want to
   choose: download the candidates and show them as **numbered thumbnails in
   one message** (`SendUserFile`, each captioned with its number) — never make
   them read or edit raw URLs to do this. Take their answer as a plain
   sequence ("3, 1, 2") and build `spec.seed.url` (their #1) + `spec.seed.refs`
   (the rest, in the order given) from it before writing the spec — see
   `prepareImageUrls()` in `runner.js`, which sends `[seed.url, ...seed.refs]`
   to the model in exactly that array order, no re-ranking.
3. **Map their size wording to a `platformFormat` / aspect ratio** (see
   `references/spec-authoring.md`) — "square"/"feed" → 1:1, "story"/"reels"/
   "vertical" → 9:16, "landscape"/"YouTube" → 16:9. Ask if it's ambiguous.
4. **Titling: ask if they didn't say.** `titling.enabled: true` with
   `seed.productId` set now pulls the product's REAL brand (logo, colors, font,
   tagline, and its own `titleStylePreset`) into the burned-in chrome instead of
   the fixture "Pelagic Test Fixture" look — `dbSeed.js` fetches it, `runner.js`
   wires it into `spec.titling.brand`, `titling.js` uses it as-is. The real
   product title also defaults into the headline. Proof-class fields (quote,
   rating, review count) still never default — supply them explicitly if the
   operator gives you real ones, never invent them. So: if they didn't say
   whether they want the video titled, **ask** — "with the on-screen title and
   logo burned in, or just the raw generated video?" — rather than guessing
   either way.
5. **Default to the live production setup** — no `guidance`/`raw`/`patch`/
   `directives` overrides, the default model (current live path is direct
   Gemini) — unless they asked for a variant. "Reproduce production" means the
   baseline spec, not an experimental arm.
6. **Dry-run first regardless**, show the estimate, get the dollar cap, then go
   live. Same safety contract as any other run — this workflow doesn't skip it.
7. **Hand back the titled file** (or the raw master if they said no titling),
   per "Delivering results" below.

Still offer to refine the prompt if they want something changed after seeing a
result — that's the "Brainstorming a prompt change" workflow above, applied to
this same real product instead of a synthetic A/B.

## The safety contract (do not improvise around it)

- **Dry-run is the default.** `--live` is the only billable door and **requires `--max-usd N`**.
  Never invent a cap: the USER sets the budget. If they asked for a live run without naming one,
  ask for the dollar cap first.
- **Never re-run `--live` to "finish" a run.** Recovery is always
  `node scripts/rpd/rpd.js resume <runDir>` — free, re-polls receipts, downloads, reconciles
  settled prices, and runs the titling pass. A second `run --live` is a new billable matrix.
- Estimates are floor-grade; the **settled Atlas price** in the manifest (`costSource: actual`)
  is the only number to report as spend. UNVERIFIED-rate models (Grok 1.5/1.0, Veo 3.1) run
  with a loud warning — keep first runs on them short.
- Offline gate: `node scripts/verifyRpdHarness.js` must stay green if you touch the harness.

## Standard workflow

```bash
node scripts/rpd/rpd.js models                     # slugs, caps, floor estimates
node scripts/rpd/rpd.js run spec.json              # FREE: prompts, bodies, estimates, gallery
node scripts/rpd/rpd.js run spec.json --live --max-usd <N>   # billable, hard-capped
node scripts/rpd/rpd.js resume <runDir>            # finish interrupted runs (free)
node scripts/rpd/rpd.js eval <runDir>              # vision-grade cells (own cap: --eval-max-usd)
node scripts/rpd/rpd.js stats                      # cost + latency across all runs (--csv)
node scripts/rpd/rpd.js note <runDir> <cellId|run> "observation"
node scripts/rpd/rpd.js prompt                     # what can I change + current text (free)
node scripts/rpd/rpd.js publish <runDir>           # Netlify gallery URL + Slack
```

**Both media types.** A spec can carry a video section (`models` + `variants`), a `static` section
(image ads — cheap, ~$0.04-0.07/cell, so iterate here first), or both under one budget gate.
Static levers are `raw` / `blocks` / `patch` (see `references/spec-authoring.md`); `blocks` replaces
a whole canonical prompt block, which is how you measure a proposed change to
`staticAdIntents` before anyone commits it.

**Seed from the catalog** with `seed": {"productId": "..."}` (needs `MONGODB_URI`, read-only) —
resolves the merchant-feed primary + 2 refs by the live production rule and stamps them into the
manifest. **If `spec.titling` is also set**, the same lookup wires the product's real Brand
(logo/colors/font/tagline/titleStylePreset) into `spec.titling.brand` and its real title into
`spec.titling.copy.headline` — unless the operator already set those themselves, which always
wins. Titling then renders with that real look instead of the fixture brand. Proof-class copy
(quote/rating/reviewCount) is never touched by this — still absent unless explicitly supplied.
**Reference-to-video** models run when `seed.videoUrl` is set.

**Queue an experiment for tonight** by adding a variant to
`scripts/rpd/loop/nightly-spec.json` via PR — the nightly loop ($2 cap) tests it, grades it,
publishes it, and appends a LEARNINGS row.

Specs: start from `scripts/rpd/specs/*.json`. Seed images should be Cloudinary URLs (they get
the production 720-short-edge `c_fill,g_auto` crop; anything else is sent unresized). Prompt
levers per variant — `guidance` (operator-refinement prepend, still live), `raw` (full
replace, still live), `patch` (find-once surgery on CORE's own text — the tool for testing a
CORE wording change), `directives` (patches the legacy per-field objects; **provably inert on
output now** — see `references/prompt-elements.md` before recommending it).

## Delivering results ("completed output with the correct chrome")

- `titling.enabled: true` in the spec burns the production Remotion chrome (canonical presets,
  correct per-surface safe zones via `platformFormat` — Stories ≠ Reels) onto every settled
  master; `titled.mp4` sits next to `master.mp4` and the gallery prefers it. Titling is free and
  failure-tolerant: the master is never lost.
- **If the operator didn't say whether they want titling, ask before running** — don't default
  either way. "Just the raw video" and "the finished ad with the title/logo burned in" are both
  common asks and look nothing alike.
- When the user asks for the finished creative, hand them the **titled** file (send it directly
  and/or the published gallery URL), not the raw master — untitled is not a finished ad.
- Watch what you ship: extract frames (`ffmpeg -vf select=...`) and LOOK at them before writing
  observations. Frame-level claims only — do not judge motion smoothness from stills without
  saying so.

## Sharing learnings (the whole point)

After every meaningful run:
1. `note` your observations onto cells and the run (they render in the gallery).
2. `publish` and copy the gallery URL (Netlify, site `rs-rpd` in the Flood QRF team).
3. Append one row to `scripts/rpd/LEARNINGS.md` (date, spec name, settled cost, URL, one-line
   takeaway) and commit it with your branch — that file is the shared experiment log.

Credentials: `ATLAS_API_KEY` for Atlas live runs, `GEMINI_VIDEO_API_KEY` (falls back to
`GEMINI_API_KEY`) for direct-Gemini live runs — the current live path — both from the Render
dashboard or local `.env`. `NETLIFY_AUTH_TOKEN` + `RPD_NETLIFY_TEAM` for publish (a token, not
`netlify switch` — the token selects the account and is the only thing that works on a hosted
runner). Never print or commit any of these. `manifest.json` is never published — it is the
run ledger.
