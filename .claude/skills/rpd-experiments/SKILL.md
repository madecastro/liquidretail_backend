---
name: rpd-experiments
description: Run rapid product development (RPD) experiments — A/B video models and prompt variants against the real production prompt builder, outside the Ad pipeline, then publish a gallery with notes and log the learning. Use when the user wants to test video models against each other, try prompt changes (guidance, raw rewrites, canonical-directive edits, surgical patches), compare generation quality/cost/latency, build or publish an experiment gallery, or asks to "run an experiment", "test this prompt", "compare models", or "use the RPD harness". Every run collects cost + timing telemetry for forecasting.
---

# RPD experiments

The harness lives at `scripts/rpd/` (read its `README.md` for full detail). It runs entirely from
this checkout — **no deploy, no Mongo, no Ad rows, no CostLog**. Cells = `models × variants`.

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
manifest. **Reference-to-video** models run when `seed.videoUrl` is set.

**Queue an experiment for tonight** by adding a variant to
`scripts/rpd/loop/nightly-spec.json` via PR — the nightly loop ($2 cap) tests it, grades it,
publishes it, and appends a LEARNINGS row.

Specs: start from `scripts/rpd/specs/*.json`. Seed images should be Cloudinary URLs (they get
the production 720-short-edge `c_fill,g_auto` crop; anything else is sent unresized). Prompt
levers per variant — `guidance` (prepend), `raw` (full replace), `directives`
(canonical-directive edit, measured before anyone deploys it), `patch` (find-once surgery).

## Delivering results ("completed output with the correct chrome")

- `titling.enabled: true` in the spec burns the production Remotion chrome (canonical presets,
  correct per-surface safe zones via `platformFormat` — Stories ≠ Reels) onto every settled
  master; `titled.mp4` sits next to `master.mp4` and the gallery prefers it. Titling is free and
  failure-tolerant: the master is never lost.
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

Credentials: `ATLAS_API_KEY` (Render WEB dashboard or local `.env`) for live runs;
`NETLIFY_AUTH_TOKEN` + `RPD_NETLIFY_TEAM` for publish (a token, not `netlify switch` — the token
selects the account and is the only thing that works on a hosted runner). Never print or commit
either. `manifest.json` is never published — it is the run ledger.
