# 2026-09-03 — Committed config matches production (adgen half)

Worktree `/Volumes/Sayulita/Projects/RS/.wt-adgen-benefits`, branch
`feat/benefits-to-directors`. **Not committed.** Overlay-zone skip is
backend-only (catalog ingest). This repo's change is config truth.

## What changed

- `config/defaults.env` `ADGEN_RENDERER_ENABLED=false` → `true` (adgen owns
  rendering in production; matches live dashboard).
- `config/defaults.env` `ADGEN_TITLER_ENABLED=false` **kept** — local / api
  / orchestrator fallback so a renderer without `render.yaml` still titles
  in-process.
- `render.yaml` renderer: now declares `ADGEN_RENDERER_ENABLED=true` and
  `ADGEN_TITLER_ENABLED=true` (dashboard had both true on this service;
  without the titler flag the renderer would title in-process after
  dashboard deletion).
- `render.yaml` titler: `ADGEN_TITLER_ENABLED` `"false"` → `"true"`; also
  declares `ADGEN_RENDERER_ENABLED=true`.

`verifyTitlerHandoff` G4 updated to pin `"true"` (was `"false"`). A4 still
pins `defaults.env=false`.
