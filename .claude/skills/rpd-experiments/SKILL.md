---
name: rpd-experiments
description: Run rapid product development (RPD) experiments — A/B video models and prompt variants against the real production prompt builder, outside the Ad pipeline, then publish a gallery with notes to Cloudflare Pages and log the learning. Use when the user wants to test video models against each other, try prompt changes (guidance, raw rewrites, canonical-directive edits, surgical patches), compare generation quality/cost/latency, build or publish an experiment gallery, or asks to "run an experiment", "test this prompt", "compare models", or "use the RPD harness". Every run collects cost + timing telemetry for forecasting.
---

# RPD experiments

The harness lives at `scripts/rpd/` (read its `README.md` for full detail). It runs entirely from
this checkout — **no deploy, no Mongo, no Ad rows, no CostLog**. Cells = `models × variants`.

Deep guides in this skill (read the one the task needs):
- `references/spec-authoring.md` — full spec schema, all four prompt levers with their exact
  production mappings, directive keys, titling copy rules, matrix patterns that work.
- `references/operations.md` — credentials per person, exact money semantics with measured
  price points, resume/finished semantics, the telemetry fields with reference numbers for
  time forecasting, the sharing checklist, and the agent-loop recipe.

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
node scripts/rpd/rpd.js note <runDir> <cellId|run> "observation"
node scripts/rpd/rpd.js publish <runDir> --project rs-rpd    # Cloudflare Pages URL
```

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
2. `publish` and copy the Pages URL.
3. Append one row to `scripts/rpd/LEARNINGS.md` (date, spec name, settled cost, URL, one-line
   takeaway) and commit it with your branch — that file is the shared experiment log.

Credentials: `ATLAS_API_KEY` (Render WEB dashboard or local `.env`) for live runs;
`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` for publish. Never print or commit either.
