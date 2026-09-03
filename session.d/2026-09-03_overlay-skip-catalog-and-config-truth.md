# 2026-09-03 — Skip catalog overlay zones + committed config matches production

Worktree `/Volumes/Sayulita/Projects/RS/.wt-benefits-directors`, branch
`feat/benefits-to-directors`. Companion adgen worktree
`/Volumes/Sayulita/Projects/RS/.wt-adgen-benefits`. **Not committed.**

## Task 1 — catalog overlay zones

Owner: "stop computing overlay zones for all catalog media except UGC".

Gate is at the catalog call site (`catalogOverlayChainCtx` →
`skipOverlayZones`), not a `media.source` sniff. UGC `runImagePipeline` is
untouched.

**When skipped: no `OverlayZoneArtifact` is created.** Missing is honest
for the detect UI ("not analysed"). `zones:{}` would look like analysis ran
and found nothing. Downstream reads are already optional-chained;
`applyMediaLibraryDerivations` treats a null overlayDoc as no grids.

Flag `OVERLAY_ZONES_SKIP_CATALOG` default true. Parser
`String(env ?? 'true').toLowerCase().trim() !== 'false'` — only the string
`false` re-enables. Flag-off restores today's unconditional create.

DINO eligibility is moot for catalog: `dinoEligible` requires
`refinedProducts.length > 0`, and catalog studio shots often yield zero
YOLO detections. Only UGC keeps zones.

PMax split-density in `atlasVideoService` left alone (verified dead).

Pinned by `scripts/verifyOverlayZonesSkipCatalog.js` (behavioural, stubs
on the real chain).

## Task 2 — committed config was lying about production

Live dashboard (read this session): backend WEB and both adgen workers have
`ADGEN_RENDERER_ENABLED=true`. Adgen renderer + titler have
`ADGEN_TITLER_ENABLED=true`.

- Backend `config/defaults.env`: `ADGEN_RENDERER_ENABLED=false` → `true`.
  No-op today (dashboard already true; dotenv does not override). Parser
  fail-safe when unset is still OFF (`=== 'true'` only) —
  `verifyRegeneration` R6a pins that separately from the file default.
- Adgen `config/defaults.env`: same `ADGEN_RENDERER_ENABLED=true`.
- Adgen `render.yaml`: titler `ADGEN_TITLER_ENABLED` `"false"` → `"true"`;
  renderer now declares `ADGEN_TITLER_ENABLED=true` and both services
  declare `ADGEN_RENDERER_ENABLED=true`. `defaults.env`
  `ADGEN_TITLER_ENABLED=false` stays as the local / api / orchestrator
  fallback.

`verifyTitlerHandoff` G4 was pinning render.yaml `"false"` — updated
deliberately to pin `"true"` on titler + renderer, not weakened. A4 still
pins `defaults.env=false` (the fallback).
