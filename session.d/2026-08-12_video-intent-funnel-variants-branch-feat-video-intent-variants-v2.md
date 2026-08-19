## 2026-08-12 — video INTENT (funnel) variants (branch `feat/video-intent-variants-v2`)

Measured defect on run_1786555875841_2ddf9739: owner wanted 3 intent
variations per surface; Meta video shipped 1 (no variants), PMax shipped
4 (unstaged + 3 stages). Root cause: `funnelStage` was a Google-only
digest part, so Meta variants collided with the master on
`(campaignId, identityDigest)` and `insertMany` swallowed them.

This branch (not on `main` yet):
- Digest still `det-video:v1`. `funnelStage` appends when — and only when
  — non-null, on every format. A null-stage master hashes exactly as it
  did on main (harness reconstructs the pre-change function and asserts
  byte-identity for Meta Stories + both PMax masters).
- Awareness is the unstaged row. Variants are consideration + conversion
  only. PMax = 9/product (2 billable). Meta = 12/product (1 billable).
- Meta+stage fail-closes to the Stories plate. A dropped
  `deriveFromMaster` cannot re-open Omni.
- One planner (`planDeterministicVideoAds`) is what expandWizardJob
  iterates and what the dry-run counts. Flag-off
  (`PMAX_FUNNEL_VARIANTS=false`) restores the pre-variant mint.
- Harness: `scripts/verifyVideoIntentVariants.js` (39 checks,
  revert-proven against four mutations).

**Still open, not this branch:** static concepts still land
`funnelStage: null` (3 concepts, unlabelled). Director
`routing.funnel_stage` is PMax-schema-only; stamping it onto static ads
is a separate labelling change and does not need a digest edit
(static identity already includes `generationRunId` + `conceptId`).

