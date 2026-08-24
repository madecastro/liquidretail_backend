# session.md — liquidretail_adgen

Handoff for the next session. Architecture lives in `CLAUDE.md`. This file is
**state only** — replace CURRENT STATE when it goes stale; do not append.

---

## NEXT-SESSION PROMPT

_(placeholder — nothing standing right now. The owner writes here; whoever acts on
it clears it back to this placeholder.)_

---

## CURRENT STATE

*(Written 2026-08-24. Worktree `/Volumes/Sayulita/Projects/RS/.wt-colourport`,
branch `port/colour-quote-to-adgen` off `origin/master` @ `fdd81d3`.)*

- **What this is.** Port of backend #324 (colour-language testimonial drop)
  into adgen. The fifth such port tonight; this is the vendor-drift
  detector's first real job. Measured defect: two statics for
  "Women's Roma Retro Sneaker | White - Wine" printed a green-accent
  review over a burgundy shoe.
- **Port, not a copy.** `quoteColourway.js` copied wholesale (no requires).
  `layoutInputService` / `quoteRotationService` / `aiCreativeDirectorService`
  were byte-identical to backend pre-#324, so the post-#324 files were
  copied. `quoteProvenance` comment-only (kept adgen's dropped CLAUDE.md
  §4 cross-ref). `brandScriptExecutor` and `directImageRenderService`
  hunk-ported around adgen's Remotion-OOM / usableAttribution divergence.
  `directImageRenderService` was not on the owner's verbatim 5-file list
  but is the static paint-time gate for the measured defect and the
  harness drives `buildIntentData` for real — hunk re-anchored, fork kept.
- **Harness.** `scripts/verifyQuoteColourway.js` ported with
  `../services/*` → `../src/services/*` and
  `path.join(ROOT, 'services')` → `path.join(ROOT, 'src', 'services')`
  including the D2 `require.resolve`. **99/99**, same as backend; no
  harness-count delta.
- **Manifest.** Reconciled the ported files (4 synced, 3 still-forks
  with UNPORTED #324 stripped). Also looked at backend #326 (stderr
  tails) which moved origin/main after the detector seed:
  `adStage.js` now byte-identical → synced; `Ad.js` / `renderErrorFields.js`
  re-attested as comment-only forks; `titlingResumeService.js` still
  unused (file not touched). Remaining UNPORTED in the manifest is
  backend #323 (font ingest) — out of scope.
- **Proof.** Require-graph 513/513 → 518/518 (5 new `./quoteColourway`
  edges). Vendor-drift 11/11 green. Fixture matrix on the real
  `usableColourwayQuote`: raw and display titles both `{white,wine}`;
  green / green-accented DROP; mint condition, silver lining, green
  light, white lie KEEP; wine accent / white sole / comfort KEEP.
- **Pushed.** PR against master. Do not merge.

---

## KNOWN-OPEN

- **`verifyRunFinalizesOnSettle_KNOWN_OPEN.js`** — still labelled expected-fail;
  `maybeFinalizeRun` is wired on this branch. Group A only replays the `$inc`.
- **`verifyArchiveDigestRelease.js` E3/E14** — self-diagnosed broken ported scans.
- **`verifyRendererSlackAlerts.js`** — red on master before this port
  (A1–A4, `ECONNREFUSED` on `alertOrphanedClaimsOnBoot`). Not introduced here.
- **`verifyModelParity.js`** — red in some worktrees because sibling
  `liquidretail_backend/models/*` no longer call `mongoose.model(...)` in a
  shape the harness can extract. Also fails while a `node_modules` symlink
  is present (remove it before commit). Green in this worktree with
  `NODE_PATH` pointed at backend `node_modules`.
- **Orchestrator is not Phase 2.**
- **`titlingResumeService` / `bootRecoveryService` unwired** from adgen boot.
  Isolation leaves resume state; it does not start the sweeper.

---

## Adding an entry

Replace CURRENT STATE / KNOWN-OPEN in place. Do not grow a dated log in
this file.
