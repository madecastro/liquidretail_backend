# Research

Design and investigation docs that informed real decisions but aren't architecture reference
(that's `CLAUDE.md`) or a handoff log (that's `session.md` / `session.d/`). Each file is a
point-in-time artifact — cite the date, re-verify anything load-bearing against current code before
acting on it.

## 2026-09-06 — video titling: image cards vs frame-native typography

The `ADGEN_DIRECTOR_TITLE_CARDS` gpt-image-2 title-card path (branch `fix/director-title-cards`,
never merged, pushed as an archive only) was investigated and superseded by a decision to place
type natively in the video frame. Read in this order:

1. **`2026-09-06_titling-ground-inventory.md`** — start here. What the stack can actually do today:
   the real `treatment` schema, which repo (`liquidretail_adgen`, not `_backend`) owns the live
   render path, and five premises an earlier design pass got wrong (cite this section before
   trusting anything else written before it).
2. **`2026-09-06_detection-vision-census.md`** — what detection/vision infrastructure exists, what's
   computed and discarded, and why "just reproject the catalog boxes" doesn't work (the video plate
   is a generated image, not the catalog still — no coordinate mapping between them exists).
3. **`2026-09-06_titling-placement-design-grok.md`** and **`2026-09-06_titling-placement-decision-panel.md`**
   — two independent design passes (Grok xhigh; an Anthropic 22-agent panel) on where to place type
   relative to the subject. They **disagree** on mechanism (reserve-space-at-generation vs.
   find-the-gutter-after) — read both, the disagreement is informative, and Step 1 (a hand-authored
   SVG kill-test) was built specifically to settle it empirically rather than pick one on paper.
   Camera-beat claims in the Grok doc were later found to not apply to the current CORE video
   prompt — discount those specific claims, not the rest of the doc.

Landed so far: `persist/subject-boxes` (adgen PR #135) — the per-frame subject box `detectClipBoxes`
already computes and was discarding, now persisted for a later placement step to consume. No
placement behavior changed.

## 2026-09-06 — LLM cost, inference, and Slack

**`2026-09-06_llm-cost-inference-slack-spec.md`** — every LLM call site in the generation pipeline
with a recommended model and real (not estimated) cost per call, a design for an inference layer
that reads performance results and reasons about next steps (with an explicit, deliberately narrow
answer to how much spend authority it gets), and a Slack design separating internal ops alerts from
brand-facing comms. Corrects two numbers stated earlier in conversation before this doc existed:
director title cards measured ~$0.07/card (not $0.04), and Loop 2 fires cost ~$1.80 (two masters,
not one at ~$0.90).

## 2026-09-06 — repo consolidation

**`2026-09-06_monorepo-consolidation-design.md`** — full design + adversarial review for merging
`liquidretail_backend`, `liquidretail_adgen`, `liquidretail` (SPA), and `claude-org-brain` into one
repo, preserving history. Explicitly excludes `rs-ai-backend` (owner directive — dead, reference
only). **Superseded input, not the doc itself:** written before the scope supplement below; the
disposition table there should be read alongside it.

**`2026-09-06_monorepo-scope-supplement.md`** — the four org repos the design above didn't know about
(`yolo-microservice-prod`, `Ad-Specs`, `rs-ai-frontend`, plus confirming `rs-ai-backend` stays
excluded). Settles with live evidence that production's YOLO/Grounding-DINO detection service
actually autodeploys from a **personal GitHub account** (`madecastro/yolo_microservice`), not the
org's stale mirror — a real bus-factor/access risk, flagged for a transfer-then-repoint fix
independent of the main consolidation.
