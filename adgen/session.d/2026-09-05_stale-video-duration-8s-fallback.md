# 2026-09-05 — stale 8s video-duration fallbacks after the 10s standardization

Worktree: `/Volumes/Sayulita/Projects/RS/.wt-fix-stale-video-duration-adgen`
Branch: `fix/stale-video-duration` (off `origin/master`, not pushed).
Paired backend worktree: `/Volumes/Sayulita/Projects/RS/.wt-fix-stale-video-duration-backend`.

Same defect and same wiring as the backend sibling. Adgen is the live renderer (`ADGEN_RENDERER_ENABLED=true`). `src/services/videoDurationPolicy.js` is byte-identical to backend's copy.

Require-graph (verifyRequireGraph + require edges): `renderer.js` requires `atlasVideoService` / `brandScriptExecutor` / `campaignAdsGenerationService`; titler and regenerate require the same cluster; `videoDurationPolicy` is required from those files and is not in the vendored-but-dead list.

`directorTitleCardService.js` is not on `origin/master` (untracked on the dirty main checkout) — not in this change.

## Verify

`node scripts/runVerifySuite.js` → duration/money harnesses green (`verifyVideoDurationPolicy`, `verifyPmaxVideoExpansion`, `verifySharedPortraitMaster`, `verifyVideoCostReconcile`, `verifyRendererVideoMoneyInvariants`, `verifyRequireGraph`). Full suite: `verifyModelParity` 33/33 on a bare worktree. `verifyVendorDrift` still carries the pre-existing ambient origin/main drift bucket; files this change touches were re-attested.
